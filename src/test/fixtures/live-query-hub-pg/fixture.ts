import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { TurbineClient } from '../../../client.js';
import type { LiveQuery } from '../../../live-query.js';
import type { NotificationHub } from '../../../notification-hub.js';
import type { PgCompatPoolClient } from '../../../pg-types.js';
import { mockTable } from '../../helpers.js';

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

export async function until(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 500; i++) {
    if (await predicate()) return;
    await delay(5);
  }
  assert.ok(await predicate(), 'native composed workflow did not settle');
}

interface Row {
  id: number;
  tenantId: number;
  title: string;
  secret: string;
}

interface Application {
  hub: NotificationHub;
  watch<T>(query: (signal: AbortSignal) => T | PromiseLike<T>, signal?: AbortSignal): LiveQuery<Awaited<T>>;
  close(): Promise<void>;
}

export async function fixture(t: TestContext) {
  // A variable URL keeps the root test typecheck scoped to src/. The example itself
  // is strictly compiled in both installed ESM/CJS consumers by native-run.mjs.
  const moduleUrl = new URL('../../../../examples/notification-live-query/application.ts', import.meta.url).href;
  const { createApplication } = (await import(moduleUrl)) as {
    createApplication(options: {
      pool: { connect(): Promise<PgCompatPoolClient>; end(): Promise<void> };
      endpoint: 'direct';
      channel: string;
      onDiagnostic(error: Error): void;
    }): Application;
  };
  const name = `lqh_${randomBytes(6).toString('hex')}`;
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 1500,
    query_timeout: 2500,
    statement_timeout: 2000,
  });
  const diagnostics: Error[] = [];
  const connections: { pid: number; sql: string[]; released: boolean }[] = [];
  const reconnectRequested = deferred(),
    reconnectAllowed = deferred();
  let gateReconnect = false;
  let checkoutGate: { requested: ReturnType<typeof deferred>; allowed: ReturnType<typeof deferred> } | undefined;
  let ends = 0;
  const order: string[] = [];
  const transport = {
    async connect(): Promise<PgCompatPoolClient> {
      if (checkoutGate) {
        const gate = checkoutGate;
        checkoutGate = undefined;
        gate.requested.resolve();
        await gate.allowed.promise;
      }
      if (connections.length && gateReconnect) {
        reconnectRequested.resolve();
        await reconnectAllowed.promise;
      }
      const client = await pool.connect();
      const record = {
        pid: (client as unknown as { processID: number }).processID,
        sql: [] as string[],
        released: false,
      };
      connections.push(record);
      return {
        query: async (text: string) => {
          record.sql.push(text);
          return client.query(text);
        },
        on: client.on.bind(client),
        removeListener: client.removeListener.bind(client),
        release(error?: Error | boolean) {
          record.released = true;
          client.release(error);
          order.push('listener-release');
        },
      } as PgCompatPoolClient;
    },
    async end() {
      ends++;
      await pool.end();
    },
  };
  const app = createApplication({
    pool: transport,
    endpoint: 'direct',
    channel: name,
    onDiagnostic: (error) => {
      diagnostics.push(error);
    },
  });
  const schema = {
    enums: {},
    tables: {
      [name]: mockTable(name, [
        { name: 'id', field: 'id', pgType: 'int4' },
        { name: 'tenant_id', field: 'tenantId', pgType: 'int4' },
        { name: 'title', field: 'title', pgType: 'text' },
        { name: 'secret', field: 'secret', pgType: 'text', pii: true },
      ]),
    },
  };
  let tenant = 1;
  const db = new TurbineClient(
    { pool, diagnostics: { advice: false }, globalFilters: { [name]: () => ({ tenantId: tenant }) } },
    schema,
  );
  let writer: pg.PoolClient | undefined;
  let created = false;
  const drains: (() => void)[] = [];
  t.after(async () => {
    for (const release of drains) release();
    reconnectAllowed.resolve();
    const errors: unknown[] = [];
    try {
      await app.close();
      order.push('application-closed');
    } catch (error) {
      errors.push(error);
    }
    try {
      assert.equal(app.hub.stats.closed, true);
      assert.equal(app.hub.stats.subscriptions, 0);
      assert.ok(connections.every((record) => record.released));
      assert.equal(ends, 0, 'hub cannot end caller pool');
      await db.disconnect();
      if (writer) {
        await writer.query('ROLLBACK');
        if (created) await writer.query(`DROP TABLE "${name}"`);
      }
    } catch (error) {
      errors.push(error);
    } finally {
      writer?.release();
      await transport.end();
      order.push('pool-ended');
      assert.equal(ends, 1);
      assert.equal(pool.totalCount, 0);
      assert.ok(order.indexOf('application-closed') < order.indexOf('pool-ended'));
    }
    if (errors.length) throw new AggregateError(errors, 'Composed fixture cleanup failed');
  });
  writer = await pool.connect();
  await writer.query(
    `CREATE TABLE "${name}" (id integer PRIMARY KEY, tenant_id integer NOT NULL, title text NOT NULL, secret text NOT NULL)`,
  );
  created = true;

  const read = () =>
    db.table<Row>(name).findMany({ select: { id: true, title: true }, orderBy: { id: 'asc' }, limit: 100 });
  const notify = (payload = 'invalidate') => writer!.query('SELECT pg_notify($1, $2)', [name, payload]);
  return {
    app,
    pool,
    writer,
    db,
    name,
    read,
    notify,
    connections,
    diagnostics,
    order,
    drains,
    insert: (id: number, scope = 1) =>
      writer!.query(`INSERT INTO "${name}" VALUES ($1, $2, $3, 'private')`, [id, scope, `row-${id}`]),
    setTenant(value: number) {
      tenant = value;
    },
    pauseNextCheckout() {
      const gate = { requested: deferred(), allowed: deferred() };
      checkoutGate = gate;
      drains.push(gate.allowed.resolve);
      return { requested: gate.requested.promise, allow: gate.allowed.resolve };
    },
    gateReconnect() {
      gateReconnect = true;
      return { requested: reconnectRequested.promise, allow: reconnectAllowed.resolve };
    },
    async listeners() {
      return (await writer!.query('SELECT pid FROM pg_stat_activity WHERE query = $1', [`LISTEN "${name}"`])).rows;
    },
    async barrier() {
      // Separate synchronous consumer is a driver-delivery barrier, not a timing assertion.
      const delivered = deferred();
      const subscription = await app.hub.subscribe(name, () => delivered.resolve());
      await notify(`barrier-${randomBytes(4).toString('hex')}`);
      await delivered.promise;
      await subscription.unsubscribe();
    },
  };
}
