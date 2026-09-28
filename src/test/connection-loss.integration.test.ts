/**
 * turbine-orm, surviving a dropped connection (live)
 *
 * Kills real backends with `pg_terminate_backend` while Turbine holds them, the
 * same event a database restart, failover or serverless compute suspend
 * produces. Before the connection guard (src/connection-guard.ts) every case
 * below EXITED THE PROCESS through an unheard `'error'` event, which under the
 * test runner fails this whole file rather than one test: a regression cannot
 * pass quietly.
 *
 * Each case asserts three things: the pending call REJECTS (typed, E004), the
 * process keeps running, and the pool still serves the next query.
 *
 * Creates and drops its own table; needs only a reachable Postgres:
 *   DATABASE_URL=postgres://... npx tsx --test src/test/connection-loss.integration.test.ts
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { ConnectionError } from '../errors.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable, skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

const TABLE = 'conn_loss_items';
const SCHEMA: SchemaMetadata = {
  enums: {},
  tables: {
    [TABLE]: mockTable(TABLE, [
      { name: 'id', field: 'id', pgType: 'int4' },
      { name: 'label', field: 'label', pgType: 'text' },
    ]),
  },
};

/** The killer: a separate connection that is never the one being terminated. */
let admin: pg.Client;

function urlWithAppName(appName: string): string {
  const url = new URL(DATABASE_URL as string);
  url.searchParams.set('application_name', appName);
  return url.toString();
}

/** A client whose every connection is tagged, so the test can kill exactly them. */
function taggedClient(): { db: TurbineClient; appName: string } {
  const appName = `turbine_conn_loss_${randomUUID().slice(0, 8)}`;
  return { db: new TurbineClient({ connectionString: urlWithAppName(appName), poolSize: 3 }, SCHEMA), appName };
}

async function waitForBackend(appName: string, filter: 'active' | 'any'): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const { rows } = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE application_name = $1 AND ($2 = 'any' OR (state = 'active' AND query LIKE '%pg_sleep%'))`,
      [appName, filter],
    );
    if ((rows[0]?.n ?? 0) > 0) return;
    if (Date.now() > deadline) assert.fail(`no ${filter} backend for ${appName} appeared`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function terminate(appName: string): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(
    'SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity WHERE application_name = $1',
    [appName],
  );
  return rows[0]?.n ?? 0;
}

async function assertStillServes(db: TurbineClient): Promise<void> {
  const rows = await db.raw<{ n: number }>`SELECT 1 AS n`;
  assert.equal(rows[0]?.n, 1, 'the pool must still hand out a working connection');
}

function assertLost(err: unknown): true {
  assert.ok(err instanceof ConnectionError, `expected a ConnectionError, got ${String(err)}`);
  assert.equal(err.code, 'TURBINE_E004');
  return true;
}

describe('connection loss while Turbine holds a connection (live)', () => {
  before(async () => {
    admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await admin.query(`CREATE TABLE ${TABLE} (id int PRIMARY KEY, label text NOT NULL)`);
    await admin.query(`INSERT INTO ${TABLE} SELECT g, 'row ' || g FROM generate_series(1, 200) g`);
  });

  after(async () => {
    await admin?.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await admin?.end();
  });

  it('$transaction: a query in flight rejects with the server’s reason', async () => {
    const { db, appName } = taggedClient();
    try {
      const pending = db.$transaction(async (tx) => {
        await tx.raw`SELECT pg_sleep(10)`;
      });
      await waitForBackend(appName, 'active');
      assert.equal(await terminate(appName), 1);
      await assert.rejects(pending, (err) => assertLost(err) && /administrator command/.test(String(err)));
      await assertStillServes(db);
    } finally {
      await db.disconnect();
    }
  });

  it('$transaction: a loss between queries reports the original cause, not "not queryable"', async () => {
    const { db, appName } = taggedClient();
    try {
      let resume: () => void = () => {};
      const gate = new Promise<void>((r) => {
        resume = r;
      });
      const pending = db.$transaction(async (tx) => {
        await tx.raw`SELECT 1`;
        await gate;
        await tx.raw`SELECT 2`;
      });
      await waitForBackend(appName, 'any');
      assert.equal(await terminate(appName), 1);
      await new Promise((r) => setTimeout(r, 100));
      resume();
      await assert.rejects(pending, (err) => {
        assertLost(err);
        assert.doesNotMatch(String(err), /not queryable/);
        assert.equal((err as ConnectionError).sqlstate, '57P01');
        return true;
      });
      await assertStillServes(db);
    } finally {
      await db.disconnect();
    }
  });

  it('transaction(): the raw-client form survives too', async () => {
    const { db, appName } = taggedClient();
    try {
      const pending = db.transaction(async (client) => {
        await client.query('SELECT pg_sleep(10)');
      });
      await waitForBackend(appName, 'active');
      assert.equal(await terminate(appName), 1);
      // The callback holds the RAW driver client, so what it awaited rejects
      // with the driver's own error; transaction() passes that through as it
      // always has. The contract under test is that the call rejects at all.
      await assert.rejects(pending, (err) => (err as { code?: string }).code === '57P01');
      await assertStillServes(db);
    } finally {
      await db.disconnect();
    }
  });

  it('findManyStream: a cursor that loses its connection mid-drain rejects', async () => {
    const { db, appName } = taggedClient();
    try {
      const table = db.table<{ id: number; label: string }>(TABLE);
      const stream = table.findManyStream({ orderBy: { id: 'asc' }, batchSize: 10 });
      const seen: number[] = [];
      await assert.rejects(async () => {
        for await (const row of stream) {
          seen.push(row.id);
          if (seen.length === 15) {
            // Past the speculative first batch, so the cursor connection is held.
            assert.equal(await terminate(appName), 1);
            await new Promise((r) => setTimeout(r, 100));
          }
        }
      }, assertLost);
      assert.ok(seen.length >= 15 && seen.length < 200, `stream should stop early, saw ${seen.length} rows`);
      await assertStillServes(db);
    } finally {
      await db.disconnect();
    }
  });

  it('db.pool.connect() in application code: an idle checkout that dies does not exit', async () => {
    const { db, appName } = taggedClient();
    try {
      const client = await db.pool.connect();
      try {
        assert.equal(await terminate(appName), 1);
        await new Promise((r) => setTimeout(r, 100));
        await assert.rejects(client.query('SELECT 1'));
      } finally {
        client.release(true);
      }
      await assertStillServes(db);
    } finally {
      await db.disconnect();
    }
  });

  it('$listen: reconnects, re-LISTENs and delivers again', async () => {
    const { db, appName } = taggedClient();
    const channel = `conn_loss_${randomUUID().slice(0, 8)}`;
    try {
      const got: string[] = [];
      const errors: Error[] = [];
      let reconnects = 0;
      const sub = await db.$listen(channel, (payload) => got.push(payload), {
        reconnect: { initialDelayMs: 20 },
        onError: (err) => errors.push(err),
        onReconnect: () => reconnects++,
      });
      await admin.query(`SELECT pg_notify($1, 'before')`, [channel]);
      await waitFor(() => got.includes('before'), 'the first notification');

      assert.equal(await terminate(appName), 1);
      await waitFor(() => reconnects === 1, 'the reconnect');
      assert.ok(errors.length >= 1 && errors[0] instanceof ConnectionError, 'the loss is reported, typed');

      await admin.query(`SELECT pg_notify($1, 'after')`, [channel]);
      await waitFor(() => got.includes('after'), 'a notification on the new connection');
      assert.deepEqual(got, ['before', 'after']);
      await sub.unsubscribe();
    } finally {
      await db.disconnect();
    }
  });
});

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
