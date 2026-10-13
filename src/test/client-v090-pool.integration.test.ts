/**
 * turbine-orm: the pool a client opens, against a live PostgreSQL.
 *
 *   - `statementTimeoutMs` is in force from a connection's first statement,
 *     and the server cancels a statement that runs past it;
 *   - `maxLifetimeSeconds` retires a connection after its lifetime, and `0`
 *     keeps it;
 *   - `disconnect({ timeoutMs })` stops waiting for a held connection at the
 *     deadline and cancels its statement on the server;
 *   - `$ping()` measures a round trip;
 *   - `$on('poolError')` reports an idle connection the server closed, and
 *     `$on('connectionLost')` one closed while a transaction held it.
 *
 * Connections are closed with `pg_terminate_backend` from a separate client,
 * which is what a server restart or an administrator does to them.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/client-v090-pool.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { type ConnectionLostEvent, type PoolErrorEvent, TurbineClient } from '../client.js';
import { ConnectionError } from '../errors.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const { it, before, after } = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

const schema: SchemaMetadata = { tables: {}, enums: {} };

async function waitFor(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('client pool (live Postgres)', () => {
  let admin: pg.Client;
  const clients: TurbineClient[] = [];
  const open = (config: Record<string, unknown> = {}): TurbineClient => {
    const db = new TurbineClient({ connectionString: DATABASE_URL, ...config }, schema);
    clients.push(db);
    return db;
  };
  /** Backends of this database whose current query contains `marker`. */
  const backendsRunning = async (marker: string): Promise<number[]> => {
    const r = await admin.query(
      `SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'active' AND query LIKE $1`,
      [`%${marker}%`],
    );
    return r.rows.map((row: { pid: number }) => row.pid);
  };
  const pidOf = async (db: TurbineClient): Promise<number> =>
    (await db.rawUnsafe<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]!.pid;

  before(async () => {
    admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
  });
  after(async () => {
    for (const db of clients) await db.disconnect({ timeoutMs: 1000 }).catch(() => {});
    await admin?.end();
  });

  it('statementTimeoutMs: set before the first statement, and the server cancels past it', async () => {
    const db = open({ statementTimeoutMs: 150 });
    const shown = await db.rawUnsafe<{ statement_timeout: string }>('SHOW statement_timeout');
    assert.equal(shown[0]?.statement_timeout, '150ms');
    const started = Date.now();
    await assert.rejects(db.rawUnsafe('SELECT pg_sleep(5)'), (err: unknown) => {
      const e = err as { code?: string; cause?: { code?: string } };
      assert.equal(e.cause?.code ?? e.code, '57014', String(err));
      return true;
    });
    assert.ok(Date.now() - started < 2000, 'the statement ran past its timeout');
    // A transaction-local override still works on top of it.
    const inTx = await db.$transaction(async (tx) => {
      await tx.rawUnsafe("SELECT set_config('statement_timeout', '2s', true)");
      return (await tx.rawUnsafe<{ statement_timeout: string }>('SHOW statement_timeout'))[0]?.statement_timeout;
    });
    assert.equal(inTx, '2s');
  });

  it('maxLifetimeSeconds: a connection is replaced after its lifetime, and 0 keeps it', async () => {
    const short = open({ poolSize: 1, maxLifetimeSeconds: 1 });
    const kept = open({ poolSize: 1, maxLifetimeSeconds: 0 });
    const shortFirst = await pidOf(short);
    const keptFirst = await pidOf(kept);
    await new Promise((r) => setTimeout(r, 1400));
    assert.notEqual(await pidOf(short), shortFirst, 'the connection outlived maxLifetimeSeconds');
    assert.equal(await pidOf(kept), keptFirst, 'maxLifetimeSeconds: 0 retired a connection');
  });

  it('disconnect({ timeoutMs }): a held connection is cancelled on the server at the deadline', async () => {
    const db = open({ poolSize: 2 });
    const marker = 'c90_disconnect_marker';
    const held = db.transaction(async (client) => {
      await client.query(`SELECT pg_sleep(30) /* ${marker} */`);
    });
    held.catch(() => {});
    await waitFor(async () => (await backendsRunning(marker)).length === 1, 'the held statement to start');
    const started = Date.now();
    const result = await db.disconnect({ timeoutMs: 200 });
    const elapsed = Date.now() - started;
    assert.deepEqual(result, { timedOut: true, forcedConnections: 1 });
    assert.ok(elapsed < 2000, `disconnect took ${elapsed}ms`);
    await assert.rejects(held);
    await waitFor(async () => (await backendsRunning(marker)).length === 0, 'the server to stop the statement', 1000);
  });

  it('disconnect({ timeoutMs }) with nothing checked out ends normally', async () => {
    const db = open();
    await db.$ping();
    assert.deepEqual(await db.disconnect({ timeoutMs: 1000 }), { timedOut: false, forcedConnections: 0 });
  });

  it('$ping measures a round trip and says when the database is unreachable', async () => {
    const db = open();
    const ms = await db.$ping();
    assert.ok(typeof ms === 'number' && ms >= 0 && ms < 5000, String(ms));
    await assert.rejects(open({ connectionString: 'postgresql://x@127.0.0.1:1/none' }).$ping(), ConnectionError);
  });

  it("$on('poolError') reports an idle connection the server closed", async () => {
    const db = open({ poolSize: 1 });
    const events: PoolErrorEvent[] = [];
    const lost: ConnectionLostEvent[] = [];
    db.$on('poolError', (event) => events.push(event));
    db.$on('connectionLost', (event) => lost.push(event));
    const pid = await pidOf(db);
    await admin.query('SELECT pg_terminate_backend($1)', [pid]);
    await waitFor(() => events.length === 1, 'a poolError event');
    assert.equal(events[0]?.pool, 'primary');
    assert.equal(lost.length, 0, 'an idle connection was reported as lost while in use');
    assert.match(events[0]!.error.message, /terminat/i);
    // The pool replaced the connection.
    assert.notEqual(await pidOf(db), pid);
  });

  it("$on('connectionLost') reports a connection closed while a transaction held it, once", async () => {
    const db = open({ poolSize: 1 });
    const lost: ConnectionLostEvent[] = [];
    const idle: PoolErrorEvent[] = [];
    db.$on('connectionLost', (event) => lost.push(event));
    db.$on('poolError', (event) => idle.push(event));
    const marker = 'c90_lost_marker';
    const held = db.$transaction(async (tx) => {
      await tx.rawUnsafe(`SELECT pg_sleep(30) /* ${marker} */`);
    });
    held.catch(() => {});
    await waitFor(async () => (await backendsRunning(marker)).length === 1, 'the held statement to start');
    const [pid] = await backendsRunning(marker);
    await admin.query('SELECT pg_terminate_backend($1)', [pid]);
    await assert.rejects(held, ConnectionError);
    await waitFor(() => lost.length >= 1, 'a connectionLost event');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(lost.length, 1, 'reported more than once');
    assert.equal(lost[0]?.pool, 'primary');
    assert.equal(idle.length, 0, 'a checked-out loss was reported as an idle one');
    assert.equal((await db.rawUnsafe<{ one: number }>('SELECT 1 AS one'))[0]?.one, 1);
  });
});
