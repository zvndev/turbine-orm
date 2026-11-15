import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { type LiveQueryOptions, liveQuery } from '../live-query.js';
import { quoteIdent } from '../query/utils.js';
import { mockTable, skipGate } from './helpers.js';

const { it } = skipGate(!process.env.DATABASE_URL, 'DATABASE_URL not set');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

interface Row {
  id: number;
  tenantId: number;
  title: string;
  secret: string;
}

async function fixture(t: TestContext) {
  const suffix = randomBytes(6).toString('hex');
  const table = `live_query_${suffix}`;
  const channel = `live_query_${suffix}`;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  const writer = await pool.connect();
  const handles: { dispose(): Promise<void> }[] = [];
  t.after(async () => {
    const failures: unknown[] = [];
    for (const handle of handles) {
      try {
        await handle.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await writer.query('ROLLBACK');
      await writer.query(`DROP TABLE IF EXISTS ${quoteIdent(table)}`);
    } finally {
      writer.release();
      await pool.end();
    }
    if (failures.length) throw new AggregateError(failures, 'Live query fixture cleanup failed');
  });
  await writer.query(
    `CREATE TABLE ${quoteIdent(table)} (id integer PRIMARY KEY, tenant_id integer NOT NULL, title text NOT NULL, secret text NOT NULL)`,
  );
  let tenant = 1;
  const schema = {
    enums: {},
    tables: {
      [table]: mockTable(table, [
        { name: 'id', field: 'id', pgType: 'int4' },
        { name: 'tenant_id', field: 'tenantId', pgType: 'int4' },
        { name: 'title', field: 'title', pgType: 'text' },
        { name: 'secret', field: 'secret', pgType: 'text', pii: true },
      ]),
    },
  };
  const db = new TurbineClient(
    { pool, globalFilters: { [table]: () => ({ tenantId: tenant }) }, diagnostics: { advice: false } },
    schema,
  );
  t.after(() => db.disconnect());
  const read = () => db.table<Row>(table).findMany({ select: { id: true, title: true }, orderBy: { id: 'asc' } });
  const subscribe: LiveQueryOptions<unknown>['subscribe'] = (invalidate, { onReconnect }) =>
    db.$listen(channel, invalidate, { onReconnect });
  return {
    pool,
    writer,
    db,
    schema,
    table,
    channel,
    read,
    subscribe,
    track<T extends { dispose(): Promise<void> }>(handle: T): T {
      handles.push(handle);
      return handle;
    },
    setTenant(value: number) {
      tenant = value;
    },
    insert: (id: number, scope = 1) =>
      writer.query(`INSERT INTO ${quoteIdent(table)} VALUES ($1, $2, $3, $4)`, [id, scope, `row-${id}`, 'private']),
    notify: () => writer.query('SELECT pg_notify($1, $2)', [channel, 'invalidate']),
  };
}

describe('live query native PostgreSQL', () => {
  it('refetches only commit-delivered notifications and preserves exact effects and order', {
    timeout: 15000,
  }, async (t) => {
    const f = await fixture(t);
    let calls = 0;
    const received: string[] = [];
    const live = f.track(
      liveQuery({
        query: () => {
          calls++;
          return f.read();
        },
        subscribe: (invalidate, { onReconnect }) =>
          f.db.$listen(
            f.channel,
            (payload) => {
              received.push(payload);
              invalidate();
            },
            { onReconnect },
          ),
      }),
    );
    assert.deepEqual((await live.next()).value, []);
    await f.writer.query('BEGIN');
    await f.insert(9);
    await f.notify();
    await f.writer.query('SELECT pg_sleep(0.05)');
    assert.deepEqual(received, []);
    assert.equal(calls, 1);
    await f.writer.query('ROLLBACK');
    assert.deepEqual(await f.read(), []);
    await f.writer.query('BEGIN');
    await f.insert(2);
    await f.insert(1);
    await f.notify();
    await f.writer.query('SELECT pg_sleep(0.05)');
    assert.deepEqual(received, []);
    const next = live.next();
    await f.writer.query('COMMIT');
    assert.deepEqual((await next).value, [
      { id: 1, title: 'row-1' },
      { id: 2, title: 'row-2' },
    ]);
    assert.deepEqual(received, ['invalidate']);
    assert.equal(calls, 2);
    await live.dispose();
    assert.equal((await f.pool.query('SELECT 42 AS answer')).rows[0].answer, 42);
    assert.equal(f.pool.totalCount, f.pool.idleCount + 1, 'only caller writer remains checked out');
  });

  it('does not deliver a snapshot invalidated while its read is in flight', { timeout: 15000 }, async (t) => {
    const f = await fixture(t);
    const readFinished = deferred<void>();
    const releaseRead = deferred<void>();
    const notified = deferred<void>();
    let calls = 0;
    const live = f.track(
      liveQuery({
        query: async () => {
          const rows = await f.read();
          if (++calls === 1) {
            readFinished.resolve();
            await releaseRead.promise;
          }
          return rows;
        },
        subscribe: (invalidate, { onReconnect }) =>
          f.db.$listen(
            f.channel,
            () => {
              invalidate();
              notified.resolve();
            },
            { onReconnect },
          ),
      }),
    );
    const next = live.next();
    await readFinished.promise;
    await f.insert(1);
    await f.notify();
    await notified.promise;
    releaseRead.resolve();
    assert.deepEqual((await next).value, [{ id: 1, title: 'row-1' }]);
    assert.equal(calls, 2);
  });

  it('reuses caller middleware, dynamic global filters, projection and PII rules on every read', {
    timeout: 15000,
  }, async (t) => {
    const f = await fixture(t);
    await f.insert(2, 1);
    await f.insert(1, 1);
    await f.insert(3, 2);
    let middlewareCalls = 0;
    f.db.$use(async (params, next) => {
      assert.equal(params.action, 'findMany');
      middlewareCalls++;
      const rows = (await next(params)) as { title: string }[];
      return rows.map((row) => ({ ...row, title: row.title.toUpperCase() }));
    });
    const live = f.track(liveQuery({ subscribe: f.subscribe, query: f.read }));
    assert.deepEqual((await live.next()).value, [
      { id: 1, title: 'ROW-1' },
      { id: 2, title: 'ROW-2' },
    ]);
    f.setTenant(2);
    const next = live.next();
    await f.notify();
    assert.deepEqual((await next).value, [{ id: 3, title: 'ROW-3' }]);
    assert.equal(middlewareCalls, 2);
    const plain = await f.db.table<Row>(f.table).findMany({ orderBy: { id: 'asc' } });
    assert.deepEqual(plain, [{ id: 3, tenantId: 2, title: 'ROW-3' }]);
    await assert.rejects(f.db.table<Row>(f.table).findMany({ select: { secret: true } }), /PII/);
  });

  it('rereads committed changes missed during native listener loss and reconnect', { timeout: 15000 }, async (t) => {
    const f = await fixture(t);
    const lost = deferred<void>();
    const reconnectAllowed = deferred<void>();
    const reconnectRequested = deferred<void>();
    let connections = 0;
    let reconnected = 0;
    // Gate acquisition, while every returned connection and LISTEN is native pg.
    const listenerPool = {
      query: f.pool.query.bind(f.pool),
      async connect() {
        if (++connections > 1) {
          reconnectRequested.resolve();
          await reconnectAllowed.promise;
        }
        return f.pool.connect();
      },
      end: async () => {},
    };
    const listenerDb = new TurbineClient({ pool: listenerPool }, f.schema);
    t.after(async () => {
      reconnectAllowed.resolve();
      await listenerDb.disconnect();
    });
    const live = f.track(
      liveQuery({
        query: f.read,
        subscribe: (invalidate, { onReconnect }) =>
          listenerDb.$listen(f.channel, invalidate, {
            reconnect: { initialDelayMs: 5, maxDelayMs: 5 },
            onError: () => lost.resolve(),
            onReconnect: () => {
              reconnected++;
              onReconnect();
            },
          }),
      }),
    );
    assert.deepEqual((await live.next()).value, []);
    const listeners = (
      await f.writer.query('SELECT pid FROM pg_stat_activity WHERE query = $1 AND pid <> pg_backend_pid()', [
        `LISTEN ${quoteIdent(f.channel)}`,
      ])
    ).rows;
    assert.equal(listeners.length, 1);
    const listenerPid = Number(listeners[0].pid);
    assert.equal(
      (await f.writer.query('SELECT pg_terminate_backend($1) AS terminated', [listenerPid])).rows[0].terminated,
      true,
    );
    await lost.promise;
    await reconnectRequested.promise;
    await f.insert(4);
    await f.notify();
    const absent = (
      await f.writer.query('SELECT pid FROM pg_stat_activity WHERE query = $1', [`LISTEN ${quoteIdent(f.channel)}`])
    ).rows;
    assert.deepEqual(absent, [], 'no native listener existed when change committed');
    const next = live.next();
    reconnectAllowed.resolve();
    assert.deepEqual((await next).value, [{ id: 4, title: 'row-4' }]);
    assert.equal(reconnected, 1);
    await live.dispose();
    await listenerDb.disconnect();
    assert.equal((await f.pool.query('SELECT 1 AS ok')).rows[0].ok, 1, 'caller pool remains usable');
    assert.equal(f.pool.totalCount, f.pool.idleCount + 1);
  });

  it('cancels native listening without a late rerun and preserves the caller pool', { timeout: 15000 }, async (t) => {
    const f = await fixture(t);
    const controller = new AbortController();
    let calls = 0;
    const live = f.track(
      liveQuery({
        signal: controller.signal,
        subscribe: f.subscribe,
        query: () => {
          calls++;
          return f.read();
        },
      }),
    );
    assert.deepEqual((await live.next()).value, []);
    const next = live.next();
    controller.abort();
    await live.closed;
    assert.deepEqual(await next, { done: true, value: undefined });
    await f.insert(8);
    await f.notify();
    await delay(25);
    assert.equal(calls, 1);
    assert.deepEqual(await f.read(), [{ id: 8, title: 'row-8' }]);
    assert.equal(f.pool.totalCount, f.pool.idleCount + 1);
  });
  it('unsubscribes on a native policy failure and never bypasses PII projection', { timeout: 15000 }, async (t) => {
    const f = await fixture(t);
    let reads = 0;
    const live = liveQuery({
      subscribe: f.subscribe,
      query: () => {
        reads++;
        return f.db.table<Row>(f.table).findMany({ select: { secret: true } });
      },
    });
    t.after(async () => {
      await live.dispose().catch(() => {});
    });
    await assert.rejects(live.next(), /PII/);
    await assert.rejects(live.closed, /PII/);
    assert.equal(f.pool.totalCount, f.pool.idleCount + 1);
    await f.notify();
    await delay(25);
    assert.equal(reads, 1);
    assert.equal((await f.pool.query('SELECT 11 AS ok')).rows[0].ok, 11);
  });
});
