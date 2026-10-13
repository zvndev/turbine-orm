/**
 * turbine-orm: the abandoned-stream idle timeout on a real PostgreSQL cursor
 * (`streamIdleTimeoutMs` / per-call `idleTimeoutMs`, and the server-side
 * `idle_in_transaction_session_timeout` limit a stream's own transaction
 * carries).
 *
 *   1. An abandoned stream on a one-connection pool is closed by Turbine: the
 *      next query on the same client gets the connection, and no backend of
 *      this client is left `idle in transaction`.
 *   2. With the event loop blocked past the timeout plus the 10 s grace (the
 *      process cannot run timers, as when a serverless instance is frozen), the
 *      SERVER ends the stream's transaction: the next pull is a ConnectionError
 *      (E004) naming idle_in_transaction_session_timeout, the backend is gone,
 *      and the pool recovers. This one test blocks for about 12 s.
 *   3. The server-side statement keeps a stricter limit already in force.
 *
 * Every limit here is transaction-local; nothing issues a session-level SET.
 *
 *   DATABASE_URL=postgres://... npx tsx --test src/test/fleet-stream-idle.integration.test.ts
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { ConnectionError, TimeoutError } from '../errors.js';
import { STREAM_IDLE_BACKSTOP_GRACE_MS, streamBackstopStatement } from '../query/stream-idle.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable, skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const { it, before, after } = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

// biome-ignore lint/suspicious/noExplicitAny: the suites drive untyped accessors
type Any = any;

const TABLE = 'fleet_stream_idle_items';
const SCHEMA: SchemaMetadata = {
  enums: {},
  tables: { [TABLE]: mockTable(TABLE, [{ name: 'id', field: 'id', pgType: 'int4' }]) },
};

let admin: pg.Client;

/** A client on its own one-connection pool, tagged so its backends can be found. */
function oneConnectionClient(appName: string, extra: Record<string, unknown> = {}): TurbineClient {
  const url = new URL(DATABASE_URL!);
  url.searchParams.set('application_name', appName);
  return new TurbineClient(
    {
      connectionString: url.toString(),
      poolSize: 1,
      connectionTimeoutMs: 2000,
      warnOnUnlimited: false,
      logger: {},
      ...extra,
    },
    SCHEMA,
  );
}

async function backends(appName: string): Promise<{ pid: number; state: string }[]> {
  const { rows } = await admin.query(
    'SELECT pid, state FROM pg_stat_activity WHERE application_name = $1 AND pid <> pg_backend_pid()',
    [appName],
  );
  return rows as { pid: number; state: string }[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('stream idle timeout (live PostgreSQL)', () => {
  before(async () => {
    admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await admin.query(`CREATE TABLE ${TABLE} (id int4 PRIMARY KEY)`);
    await admin.query(`INSERT INTO ${TABLE} SELECT g FROM generate_series(1, 20) g`);
  });

  after(async () => {
    await admin?.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await admin?.end();
  });

  it('an abandoned stream releases the only connection and leaves no idle transaction', async () => {
    const appName = `fsi_${randomUUID().slice(0, 8)}`;
    const db = oneConnectionClient(appName);
    let it: AsyncIterator<Any> | undefined;
    try {
      const items = (db as Any).table(TABLE);
      it = items.findManyStream({ orderBy: { id: 'asc' }, batchSize: 5, idleTimeoutMs: 200 })[Symbol.asyncIterator]();
      assert.equal((await it!.next()).value.id, 1);
      assert.deepEqual(
        (await backends(appName)).map((b) => b.state),
        ['idle in transaction'],
        'precondition: the stream holds the one connection inside its transaction',
      );

      await sleep(500);

      // The pool has ONE connection: this only succeeds if the stream gave it back.
      assert.equal(await items.count(), 20);
      assert.deepEqual(
        (await backends(appName)).filter((b) => b.state === 'idle in transaction'),
        [],
        'no backend of this client is left idle in transaction',
      );
      await assert.rejects(() => it!.next(), TimeoutError);
    } finally {
      // A no-op after expiry. If the guard is broken it closes the stream, so
      // the failure is reported instead of disconnect() waiting forever on the
      // connection the stream still holds.
      await it?.return?.(undefined).catch(() => undefined);
      await db.disconnect();
    }
  });

  it('a live consumer on a real cursor drains every row', async () => {
    const db = oneConnectionClient(`fsi_${randomUUID().slice(0, 8)}`);
    try {
      const seen: number[] = [];
      for await (const batch of (db as Any)
        .table(TABLE)
        .findManyStreamBatches({ orderBy: { id: 'asc' }, batchSize: 4, idleTimeoutMs: 120 })) {
        for (const row of batch) seen.push(row.id);
        await sleep(60);
      }
      assert.deepEqual(
        seen,
        Array.from({ length: 20 }, (_, i) => i + 1),
      );
    } finally {
      await db.disconnect();
    }
  });

  it('a frozen process: the server ends the transaction, the next pull is E004, the pool recovers', async () => {
    const appName = `fsi_${randomUUID().slice(0, 8)}`;
    const db = oneConnectionClient(appName);
    let it: AsyncIterator<Any> | undefined;
    try {
      const items = (db as Any).table(TABLE);
      // batchSize 1, so the next pull must FETCH rather than read a buffered row.
      it = items.findManyStream({ orderBy: { id: 'asc' }, batchSize: 1, idleTimeoutMs: 200 })[Symbol.asyncIterator]();
      assert.equal((await it!.next()).value.id, 1);
      const [held] = await backends(appName);
      assert.equal(held?.state, 'idle in transaction');

      // Block the event loop: no timer of this process can run, exactly as when
      // it is frozen. The server limit is the only thing that can act.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200 + STREAM_IDLE_BACKSTOP_GRACE_MS + 1500);

      // Pull FIRST, before anything else gives the loop a turn: the FETCH then
      // meets the server's FATAL 25P03 on the wire rather than a client that
      // already read the close, which is the ordering that once surfaced as a
      // raw, unmapped driver error.
      await assert.rejects(
        () => it!.next(),
        (err: unknown) =>
          err instanceof ConnectionError &&
          err.code === 'TURBINE_E004' &&
          /idle_in_transaction_session_timeout/.test(err.message),
      );
      const { rows } = await admin.query('SELECT state FROM pg_stat_activity WHERE pid = $1', [held!.pid]);
      assert.deepEqual(rows, [], `the server ended backend ${held!.pid}; it is ${JSON.stringify(rows)}`);
      assert.equal(await items.count(), 20, 'the pool replaced the dead connection');
    } finally {
      await it?.return?.(undefined).catch(() => undefined);
      await db.disconnect();
    }
  });

  it('the server-side statement sets timeout + 10 s, and keeps a stricter limit already in force', async () => {
    const client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    const read = async () =>
      (
        (await client.query("SELECT current_setting('idle_in_transaction_session_timeout') AS v")).rows[0] as {
          v: string;
        }
      ).v;
    try {
      const sessionDefault = await read();
      await client.query('BEGIN');
      await client.query(streamBackstopStatement(300_000));
      assert.equal(await read(), '310s');
      await client.query('ROLLBACK');
      assert.equal(await read(), sessionDefault, 'transaction-local: gone after the transaction ends');

      await client.query('BEGIN');
      await client.query("SELECT set_config('idle_in_transaction_session_timeout', '5000', true)");
      await client.query(streamBackstopStatement(300_000));
      assert.equal(await read(), '5s', 'a stricter limit is kept');
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  });
});
