/**
 * Per-query `timeout` is enforced on the server (live PostgreSQL).
 *
 * A timed-out statement is cancelled with a protocol cancel request, the call
 * waits for the cancel to land, and only then hands the connection back. So a
 * timed-out write does not commit later, a retry does not apply it twice, and
 * timed-out reads do not keep their pool slots.
 *
 * Creates and drops its own tables:
 *   DATABASE_URL=postgres://... npx tsx --test src/test/builder-timeouts-cancel.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { ReadOnlyError, TimeoutError } from '../errors.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable, skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const { it, before, after } = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

const APP = 'bt_timeouts_app';
const SCHEMA: SchemaMetadata = {
  enums: {},
  tables: {
    bt_counter: mockTable('bt_counter', [
      { name: 'id', field: 'id', pgType: 'int4' },
      { name: 'n', field: 'n', pgType: 'int4' },
    ]),
    bt_other: mockTable('bt_other', [{ name: 'id', field: 'id', pgType: 'int4' }]),
    bt_slow: mockTable('bt_slow', [
      { name: 'id', field: 'id', pgType: 'int4' },
      { name: 'z', field: 'z', pgType: 'text' },
    ]),
  },
};

let admin: pg.Client;

function client(poolSize = 4): TurbineClient {
  const url = new URL(DATABASE_URL ?? '');
  url.searchParams.set('application_name', APP);
  return new TurbineClient({ connectionString: url.toString(), poolSize, warnOnUnlimited: false }, SCHEMA);
}

/** A second session holding a lock until `release()`. */
async function holdLock(sql: string): Promise<{ release(): Promise<void> }> {
  const blocker = new pg.Client({ connectionString: DATABASE_URL });
  await blocker.connect();
  await blocker.query('BEGIN');
  await blocker.query(sql);
  return {
    async release() {
      await blocker.query('COMMIT');
      await blocker.end();
    },
  };
}

/** Our app's backends still running a statement (not idle). */
async function busyBackends(): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND state <> 'idle'",
    [APP],
  );
  return rows[0]?.n ?? 0;
}

async function counter(): Promise<number> {
  const { rows } = await admin.query<{ n: number }>('SELECT n FROM bt_counter WHERE id = 1');
  return rows[0]?.n ?? -1;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('per-query timeout cancels the statement on the server', () => {
  before(async () => {
    admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query('DROP VIEW IF EXISTS bt_slow');
    await admin.query('DROP TABLE IF EXISTS bt_counter, bt_other');
    await admin.query('CREATE TABLE bt_counter (id int PRIMARY KEY, n int NOT NULL)');
    await admin.query('CREATE TABLE bt_other (id int PRIMARY KEY)');
    await admin.query('INSERT INTO bt_other VALUES (1), (2), (3)');
    await admin.query("CREATE VIEW bt_slow AS SELECT 1 AS id, pg_sleep(5)::text || 'x' AS z");
  });

  after(async () => {
    await admin?.query('DROP VIEW IF EXISTS bt_slow');
    await admin?.query('DROP TABLE IF EXISTS bt_counter, bt_other');
    await admin?.end();
  });

  it('a write blocked on a row lock is cancelled, never commits, and a retry applies it once', async () => {
    await admin.query('DELETE FROM bt_counter');
    await admin.query('INSERT INTO bt_counter VALUES (1, 0)');
    const db = client();
    const lock = await holdLock('SELECT * FROM bt_counter WHERE id = 1 FOR UPDATE');
    try {
      const err = await db
        .table('bt_counter')
        .update({ where: { id: 1 }, data: { n: { increment: 1 } }, timeout: 200 })
        .then(
          () => null,
          (e: unknown) => e,
        );
      assert.ok(err instanceof TimeoutError, `expected TimeoutError, got ${String(err)}`);
      assert.equal(err.outcome, 'not-executed');
      assert.match(err.message, /cancelled on the server/);
      assert.equal(await busyBackends(), 0, 'the UPDATE is still running on the server');
    } finally {
      await lock.release();
    }
    await pause(100);
    assert.equal(await counter(), 0, 'the timed-out UPDATE committed after the lock cleared');
    await db.table('bt_counter').update({ where: { id: 1 }, data: { n: { increment: 1 } }, timeout: 2000 });
    assert.equal(await counter(), 1, 'the retry was applied a number of times other than once');
    await db.disconnect();
  });

  it('a read running pg_sleep is cancelled near its deadline', async () => {
    const db = client();
    const started = performance.now();
    const err = await db
      .table('bt_slow')
      .findMany({ timeout: 150 })
      .then(
        () => null,
        (e: unknown) => e,
      );
    const elapsed = performance.now() - started;
    assert.ok(err instanceof TimeoutError, `expected TimeoutError, got ${String(err)}`);
    assert.equal(err.outcome, 'not-executed');
    assert.ok(elapsed < 1500, `took ${elapsed.toFixed(0)}ms: the cancel did not stop pg_sleep(5)`);
    assert.equal(await busyBackends(), 0, 'pg_sleep is still running on the server');
    await db.disconnect();
  });

  it('timed-out reads give their pool slots back, so an unrelated query still runs', async () => {
    const db = client(3);
    const lock = await holdLock('LOCK TABLE bt_counter IN ACCESS EXCLUSIVE MODE');
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () => db.table('bt_counter').findMany({ timeout: 150 })),
      );
      for (const r of results) {
        assert.equal(r.status, 'rejected');
        assert.ok((r as PromiseRejectedResult).reason instanceof TimeoutError);
      }
      assert.equal(await busyBackends(), 0, 'timed-out reads are still waiting on the lock');
      const started = performance.now();
      assert.equal(await db.table('bt_other').count(), 3);
      assert.ok(performance.now() - started < 1000, 'the unrelated count waited for a pool slot');
    } finally {
      await lock.release();
    }
    await db.disconnect();
  });

  it('a deadline that passes while waiting for a connection sends nothing', async () => {
    await admin.query('DELETE FROM bt_counter');
    await admin.query('INSERT INTO bt_counter VALUES (1, 0)');
    const db = client(1);
    let release: () => void = () => {};
    const holding = db.$transaction(async () => {
      await new Promise<void>((r) => {
        release = r;
      });
    });
    await pause(50);
    const err = await db
      .table('bt_counter')
      .update({ where: { id: 1 }, data: { n: { increment: 1 } }, timeout: 100 })
      .then(
        () => null,
        (e: unknown) => e,
      );
    release();
    await holding;
    assert.ok(err instanceof TimeoutError, `expected TimeoutError, got ${String(err)}`);
    assert.equal(err.outcome, 'not-executed');
    assert.match(err.message, /before it reached the server/);
    await pause(100);
    assert.equal(await counter(), 0);
    assert.equal(await db.table('bt_other').count(), 3, 'the late checkout was not handed back');
    await db.disconnect();
  });

  it('a statement that finishes inside its timeout is untouched', async () => {
    const db = client();
    const rows = await db.table('bt_other').findMany({ timeout: 2000, orderBy: { id: 'asc' } });
    assert.deepEqual(
      rows.map((r) => (r as { id: number }).id),
      [1, 2, 3],
    );
    await db.disconnect();
  });

  it('inside a transaction the statement cannot be cancelled, and the error says the outcome is unknown', async () => {
    await admin.query('DELETE FROM bt_counter');
    await admin.query('INSERT INTO bt_counter VALUES (1, 0)');
    const db = client();
    const lock = await holdLock('SELECT * FROM bt_counter WHERE id = 1 FOR UPDATE');
    let err: unknown;
    const tx = db
      .$transaction(async (t) => {
        await t.table('bt_counter').update({ where: { id: 1 }, data: { n: { increment: 1 } }, timeout: 150 });
      })
      .catch((e: unknown) => {
        err = e;
      });
    await pause(400);
    await lock.release();
    await tx;
    assert.ok(err instanceof TimeoutError, `expected TimeoutError, got ${String(err)}`);
    assert.equal(err.outcome, 'unknown');
    assert.match(err.message, /may still complete/);
    await db.disconnect();
  });
  it('a write inside a read-only transaction is a ReadOnlyError naming the transaction', async () => {
    const db = client();
    try {
      const err = await db
        .$transaction(async (tx) => tx.table('bt_other').create({ data: { id: 99 } }), { readOnly: true })
        .then(
          () => null,
          (e: unknown) => e,
        );
      assert.ok(err instanceof ReadOnlyError, `expected ReadOnlyError, got ${String(err)}`);
      assert.equal(err.reason, 'transaction');
      assert.match(err.message, /read-only transaction/);
      const { rows } = await admin.query('SELECT count(*)::int AS n FROM bt_other WHERE id = 99');
      assert.equal(rows[0].n, 0);
    } finally {
      await db.disconnect();
    }
  });
});
