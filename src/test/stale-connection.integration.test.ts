/**
 * turbine-orm, dead idle connections after a freeze (live)
 *
 * The failure only exists while the event loop is NOT running: awake, pg-pool
 * reads each close as it arrives and evicts the connection, and nothing fails.
 * So these tests freeze the loop for real. A worker thread (its own event loop)
 * terminates every idle backend of the client under test while the main
 * thread is parked in `Atomics.wait`, exactly as a serverless function sits
 * frozen while its database restarts. When the main thread resumes, every idle
 * connection in the pool is dead and nothing has read that yet.
 *
 * Deterministic by construction: the terminate uses pg_terminate_backend's
 * wait form (PostgreSQL 14+), so the backends are gone before the worker
 * signals, and the main loop cannot poll in between.
 *
 * Measured before the fix: five concurrent reads, five failures (57P01).
 *
 * Creates and drops its own table; needs only a reachable Postgres:
 *   DATABASE_URL=postgres://... npx tsx --test src/test/stale-connection.integration.test.ts
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe } from 'node:test';
import { Worker } from 'node:worker_threads';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { LONG_IDLE_SETTLE_MS } from '../connection-guard.js';
import { ConnectionError } from '../errors.js';
import type { QueryEvent } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable, skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const { it, before, after } = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

const TABLE = 'stale_conn_items';
const SCHEMA: SchemaMetadata = {
  enums: {},
  tables: {
    [TABLE]: mockTable(
      TABLE,
      [
        { name: 'id', field: 'id', pgType: 'int4' },
        { name: 'label', field: 'label', pgType: 'text' },
      ],
      {
        notes: {
          type: 'hasMany',
          name: 'notes',
          from: TABLE,
          to: 'stale_conn_notes',
          foreignKey: 'item_id',
          referenceKey: 'id',
        },
      },
    ),
    stale_conn_notes: mockTable('stale_conn_notes', [
      { name: 'id', field: 'id', pgType: 'int4' },
      { name: 'item_id', field: 'itemId', pgType: 'int4' },
      { name: 'body', field: 'body', pgType: 'text' },
    ]),
  },
};
const POOL = 5;

type Item = { id: number; label: string };

let admin: pg.Client;

/**
 * A worker holding its own connection, which terminates every backend tagged
 * `appName` when told to and then wakes the (blocked) main thread.
 */
class Terminator {
  private readonly flag = new Int32Array(new SharedArrayBuffer(4));
  private readonly worker: Worker;
  private readonly ready: Promise<void>;

  constructor() {
    this.worker = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      const pg = require('pg');
      const flag = workerData.flag;
      const c = new pg.Client({ connectionString: workerData.url });
      c.connect().then(() => parentPort.postMessage('ready'));
      parentPort.on('message', async (appName) => {
        try {
          const r = await c.query(
            'SELECT count(pg_terminate_backend(pid, 5000))::int AS n FROM pg_stat_activity WHERE application_name = $1',
            [appName],
          );
          Atomics.store(flag, 0, 1 + r.rows[0].n);
        } catch (err) {
          Atomics.store(flag, 0, -1);
        }
        Atomics.notify(flag, 0);
      });
      `,
      { eval: true, workerData: { url: DATABASE_URL, flag: this.flag } },
    );
    this.ready = new Promise((resolve) => this.worker.once('message', () => resolve()));
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  /**
   * Terminate every backend tagged `appName` WITHOUT this thread's event loop
   * running, then keep it frozen `holdMs` longer. Returns how many were killed.
   */
  killWhileFrozen(appName: string, holdMs: number): number {
    Atomics.store(this.flag, 0, 0);
    this.worker.postMessage(appName);
    const outcome = Atomics.wait(this.flag, 0, 0, 10_000);
    assert.notEqual(outcome, 'timed-out', 'the terminator never answered');
    const killed = Atomics.load(this.flag, 0) - 1;
    assert.ok(killed >= 0, 'the terminate query failed');
    const until = Date.now() + holdMs;
    while (Date.now() < until) {
      // still frozen
    }
    return killed;
  }

  stop(): Promise<number> {
    return this.worker.terminate();
  }
}

let terminator: Terminator;

/** A client whose every connection is tagged, with `POOL` idle connections open and a query-event log. */
async function warmClient(): Promise<{ db: TurbineClient; appName: string; events: QueryEvent[] }> {
  const appName = `turbine_stale_${randomUUID().slice(0, 8)}`;
  const url = new URL(DATABASE_URL as string);
  url.searchParams.set('application_name', appName);
  const db = new TurbineClient({ connectionString: url.toString(), poolSize: POOL, warnOnUnlimited: false }, SCHEMA);
  const events: QueryEvent[] = [];
  db.$on('query', (e) => events.push(e));
  // Hold POOL connections at once so the pool opens that many, then let them all go idle.
  await Promise.all(Array.from({ length: POOL }, () => db.raw`SELECT pg_sleep(0.05)`));
  events.length = 0;
  return { db, appName, events };
}

/** Freeze long enough for every close to have arrived, but well inside the settle threshold. */
const SHORT_FREEZE_MS = 100;

async function rowCount(): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${TABLE}`);
  return rows[0]?.n ?? 0;
}

describe('dead idle connections after a freeze', () => {
  before(async () => {
    admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP TABLE IF EXISTS stale_conn_notes, ${TABLE}`);
    await admin.query(`CREATE TABLE ${TABLE} (id serial PRIMARY KEY, label text NOT NULL)`);
    await admin.query(
      `CREATE TABLE stale_conn_notes (id serial PRIMARY KEY, item_id int NOT NULL REFERENCES ${TABLE}(id), body text NOT NULL)`,
    );
    terminator = new Terminator();
    await terminator.whenReady();
  });

  after(async () => {
    await terminator?.stop();
    await admin?.query(`DROP TABLE IF EXISTS stale_conn_notes, ${TABLE}`);
    await admin?.end();
  });

  it('a freeze past the settle threshold: concurrent reads AND writes all land, with nothing to retry', async () => {
    const { db, appName, events } = await warmClient();
    try {
      // Counted BEFORE the freeze: any await after it lets the loop read the
      // closes, which is exactly what the test must not do for the code.
      const before = await rowCount();
      assert.equal(terminator.killWhileFrozen(appName, LONG_IDLE_SETTLE_MS + 200), POOL);
      const results = await Promise.allSettled([
        ...Array.from({ length: POOL }, (_, i) => db.table<Item>(TABLE).create({ data: { label: `w${i}` } })),
        ...Array.from({ length: POOL }, () => db.table<Item>(TABLE).findMany({ limit: 1 })),
      ]);
      assert.deepEqual(
        results.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason)),
        [],
      );
      assert.equal(await rowCount(), before + POOL, 'every write applied exactly once');
      assert.equal(
        events.filter((e) => e.retried).length,
        0,
        'the checkout waited for the closes to be read, so no statement went out on a dead connection',
      );
    } finally {
      await db.disconnect();
    }
  });

  it('a short freeze: concurrent reads are answered, by retrying the ones that hit a dead connection', async () => {
    const { db, appName, events } = await warmClient();
    try {
      assert.equal(terminator.killWhileFrozen(appName, SHORT_FREEZE_MS), POOL);
      const results = await Promise.allSettled([
        db.table<Item>(TABLE).findMany({ limit: 1 }),
        db.table<Item>(TABLE).count(),
        db.table<Item>(TABLE).findFirst({ where: { label: 'x' } }),
        db.table<Item>(TABLE).aggregate({ _count: true }),
        db.table<Item>(TABLE).groupBy({ by: ['label'], _count: true }),
      ]);
      assert.deepEqual(
        results.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason)),
        [],
      );
      const retried = events.filter((e) => e.retried);
      assert.equal(retried.length, POOL, 'each read went out once on a dead connection and once more');
      for (const e of retried) assert.equal(e.error?.name, 'ConnectionError');
    } finally {
      await db.disconnect();
    }
  });

  it('a short freeze: $transaction, a nested write and connect() open on a fresh connection', async () => {
    const { db, appName } = await warmClient();
    try {
      const before = await rowCount();
      assert.equal(terminator.killWhileFrozen(appName, SHORT_FREEZE_MS), POOL);
      const results = await Promise.allSettled([
        db.$transaction(async (tx) => tx.table<Item>(TABLE).create({ data: { label: 'tx1' } })),
        db.$transaction(async (tx) => tx.table<Item>(TABLE).create({ data: { label: 'tx2' } })),
        db.$transaction([db.table<Item>(TABLE).buildCreate({ data: { label: 'batch' } })]),
        db.table<Item>(TABLE).create({
          data: { label: 'nested', notes: { create: [{ body: 'n' }] } } as never,
        }),
        db.connect(),
      ]);
      assert.deepEqual(
        results.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason)),
        [],
      );
      assert.equal(await rowCount(), before + 4, 'each transaction applied exactly once');
    } finally {
      await db.disconnect();
    }
  });

  it('a short freeze: a plain write on a dead connection fails typed and is NOT sent again', async () => {
    // The deliberate limit. "The connection died" does not say whether the
    // INSERT committed first, so resending could insert it twice. Inside the
    // settle threshold the caller gets E004 and decides.
    const { db, appName, events } = await warmClient();
    try {
      const before = await rowCount();
      assert.equal(terminator.killWhileFrozen(appName, SHORT_FREEZE_MS), POOL);
      const results = await Promise.allSettled(
        Array.from({ length: POOL }, (_, i) => db.table<Item>(TABLE).create({ data: { label: `once${i}` } })),
      );
      const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      assert.equal(failed.length, POOL, 'every write went out on a dead connection');
      for (const f of failed) assert.ok(f.reason instanceof ConnectionError, String(f.reason));
      assert.equal(events.filter((e) => e.retried).length, 0);
      assert.equal(await rowCount(), before);
      // And the pool has recovered for the next caller.
      await db.table<Item>(TABLE).create({ data: { label: 'after' } });
    } finally {
      await db.disconnect();
    }
  });
});
