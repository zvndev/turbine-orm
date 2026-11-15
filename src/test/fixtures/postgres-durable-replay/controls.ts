import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import type { LiveQuery } from '../../../live-query.js';
import type { NotificationHub } from '../../../notification-hub.js';

// Keep the repository test typecheck rooted in src/. The actual example and its
// declaration consumers are independently compiled strictly in the installed harness.
export interface OrderCommand {
  eventId: string;
  orderId: string;
  title: string | null;
  quantity: string;
  amount: string;
  occurredAt: string;
  body: Buffer;
}
export interface OrderEvent extends OrderCommand {
  tenant: string;
  position: string;
}
type Deliver = (event: OrderEvent, signal: AbortSignal) => void | PromiseLike<void>;
interface Application {
  readonly outstandingCallbacks: number;
  hub: NotificationHub;
  channel: string;
  initialize(): Promise<void>;
  append(tenant: string, command: OrderCommand, signal?: AbortSignal): Promise<OrderEvent>;
  consumeBatch(tenant: string, consumer: string, deliver: Deliver, signal?: AbortSignal): Promise<number>;
  watchProgress(tenant: string, consumer: string, deliver: Deliver, signal?: AbortSignal): LiveQuery<number>;
  close(): Promise<void>;
}

export function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

export async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 5000;
  while (!(await check())) {
    assert.ok(Date.now() < end, 'Bounded state barrier expired');
    await delay(10);
  }
}

export const command = (id: number): OrderCommand => ({
  eventId: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
  orderId: `10000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
  title: id % 2 ? 'snow ☃ / café / __proto__' : null,
  quantity: '9007199254740993',
  amount: '12345678901234567890.123456789012',
  occurredAt: '2026-11-07T12:34:56.123456Z',
  body: Buffer.from([0, 255, 128, id % 256]),
});

export async function applicationFactory() {
  const moduleUrl = pathToFileURL(
    process.env.REPLAY_APPLICATION_MODULE ?? resolve('examples/postgres-durable-replay/application.ts'),
  ).href;
  const { createOrderApplication } = (await import(moduleUrl)) as {
    createOrderApplication(options: {
      pool: pg.Pool;
      schema: string;
      endpoint: 'direct';
      onDiagnostic(error: Error): void;
      batchSize?: number;
      callbackMs?: number;
      reconcileMs?: number;
    }): Application;
  };
  return createOrderApplication;
}

export async function fixture(
  t: TestContext,
  extra: { batchSize?: number; callbackMs?: number; reconcileMs?: number } = {},
) {
  const createOrderApplication = await applicationFactory();
  const schema = `durable_${randomBytes(6).toString('hex')}`;
  const raw = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 8,
    connectionTimeoutMillis: 1500,
    query_timeout: 3000,
    statement_timeout: 2500,
  });
  const diagnostics: Error[] = [];
  raw.on('error', (error) => diagnostics.push(error));
  let nextCommit: { before?: () => Promise<void>; after?: () => Promise<void> } | undefined;
  let checkoutGate: ReturnType<typeof gate> | undefined;
  let blockCheckout = false;
  const pool = new Proxy(raw, {
    get(target, property) {
      if (property === 'connect')
        return async () => {
          if (blockCheckout) await checkoutGate!.promise;
          const client = await target.connect();
          return new Proxy(client, {
            get(connection, key) {
              if (key === 'query')
                return async (text: string, values?: unknown[]) => {
                  if (text === 'COMMIT' && nextCommit) {
                    const hook = nextCommit;
                    nextCommit = undefined;
                    await hook.before?.();
                    const result = await connection.query(text, values);
                    await hook.after?.();
                    return result;
                  }
                  return connection.query(text, values);
                };
              const value = Reflect.get(connection, key);
              return typeof value === 'function' ? value.bind(connection) : value;
            },
          });
        };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const options = {
    pool,
    schema,
    endpoint: 'direct' as const,
    onDiagnostic: (error: Error) => diagnostics.push(error),
    ...extra,
  };
  const apps = [createOrderApplication(options)];
  const release: (() => void)[] = [];
  t.after(async () => {
    checkoutGate?.resolve();
    for (const fn of release) fn();
    const failures: unknown[] = [];
    for (const app of apps) {
      try {
        await app.close();
        await until(() => app.outstandingCallbacks === 0);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      assert.equal(raw.ending, false, 'Application cannot end the caller pool');
      assert.equal((await raw.query('SELECT 42 AS answer')).rows[0]!.answer, 42);
      await raw.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await raw.end();
    }
    assert.equal(raw.totalCount, 0);
    if (failures.length) throw new AggregateError(failures, 'Fixture app cleanup');
  });
  await apps[0]!.initialize();
  return {
    app: apps[0]!,
    raw,
    schema,
    diagnostics,
    release,
    reopen(direct = false) {
      const app = createOrderApplication({ ...options, pool: direct ? raw : pool });
      apps.push(app);
      return app;
    },
    nextCommit(hook: NonNullable<typeof nextCommit>) {
      nextCommit = hook;
    },
    gateCheckout() {
      blockCheckout = true;
      checkoutGate = gate();
      return () => {
        blockCheckout = false;
        checkoutGate!.resolve();
      };
    },
    async checkpoint(tenant: string, consumer: string) {
      return (
        (
          await raw.query(`SELECT last_position::text FROM "${schema}".checkpoints WHERE tenant=$1 AND consumer=$2`, [
            tenant,
            consumer,
          ])
        ).rows[0]?.last_position ?? '0'
      );
    },
    async oracle(tenant: string): Promise<OrderEvent[]> {
      // Independent raw-driver effect oracle. No expected value is read from application state.
      return (
        await raw.query(
          `SELECT tenant,position::text,event_id AS "eventId",order_id AS "orderId",
        title,quantity::text,amount::text,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt",body
        FROM "${schema}".outbox WHERE tenant=$1 ORDER BY position`,
          [tenant],
        )
      ).rows;
    },
    async waiting() {
      return (
        (
          await raw.query(
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1",
            [`%"${schema}"%`],
          )
        ).rows[0]!.count > 0
      );
    },
  };
}
