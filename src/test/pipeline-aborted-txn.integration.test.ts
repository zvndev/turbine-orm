/**
 * turbine-orm: a failing transactional pipeline must not poison its connection.
 *
 * The real pipeline path sends `BEGIN` + every query + `COMMIT` + ONE `Sync`.
 * When a query errors, PostgreSQL discards everything up to that `Sync`, so the
 * `COMMIT` never runs and the backend is left `idle in transaction (aborted)`.
 * Releasing that connection as-is handed the next borrower a backend that
 * answers every statement with `25P02 current transaction is aborted`: one
 * ordinary query failed per poisoning, a `$transaction` landing on it failed
 * with no write, and a `{ transactional: false }` pipeline failed every slot
 * AND released it still aborted, indefinitely.
 *
 * The fix sends `ROLLBACK` on the same connection before resolving, and only
 * if the backend still reports an open transaction afterwards is the client
 * released with an error so the pool discards it. `poolSize: 1` makes every
 * follow-up call land on the very connection the failure ran on, and a
 * separate observer connection reads `pg_stat_activity` so the assertion is
 * about the backend, not about what the ORM believes.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/pipeline-aborted-txn.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { UniqueConstraintError } from '../errors.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping pipeline aborted-transaction integration tests: DATABASE_URL not set');
}

const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

/** Tag this suite's pooled backend so the observer can find it in pg_stat_activity. */
const APP_NAME = 'qa78_pipe_aborted';

function taggedUrl(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}application_name=${APP_NAME}`;
}

const DDL = `
DROP TABLE IF EXISTS qa78_pipe CASCADE;
CREATE TABLE qa78_pipe (id INTEGER PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0);
INSERT INTO qa78_pipe (id, n) VALUES (1, 10), (2, 20);
`;

describe('pipeline: a failing transactional batch leaves a usable connection', () => {
  let observer: pg.Client;
  let db: TurbineClient;
  let schema: SchemaMetadata;

  /** Backends of THIS suite's pool that sit in a transaction, aborted or not. */
  const inTransaction = async (): Promise<number> => {
    const r = await observer.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE application_name = $1 AND state LIKE 'idle in transaction%'`,
      [APP_NAME],
    );
    return r.rows[0].n;
  };

  const rowCount = async (): Promise<number> =>
    Number((await observer.query('SELECT count(*)::int AS n FROM qa78_pipe')).rows[0].n);

  const backendPid = async (): Promise<number> => {
    const rows = await db.raw<{ pid: number }>([
      'SELECT pg_backend_pid()::int AS pid',
    ] as unknown as TemplateStringsArray);
    return rows[0]!.pid;
  };

  /** ok, FAILING (duplicate PK), ok: the shape that used to poison the connection. */
  const failingBatch = () =>
    db.pipeline([
      db.table('qa78_pipe').buildCreate({ data: { id: 3, n: 30 } }),
      db.table('qa78_pipe').buildCreate({ data: { id: 1, n: 99 } }),
      db.table('qa78_pipe').buildCount(),
    ]);

  before(async () => {
    observer = new pg.Client({ connectionString: DATABASE_URL });
    await observer.connect();
    await observer.query(DDL);
    schema = await introspect({ connectionString: DATABASE_URL as string });
    db = new TurbineClient(
      { connectionString: taggedUrl(DATABASE_URL as string), poolSize: 1, warnOnUnlimited: false },
      schema,
    );
  });

  after(async () => {
    await db?.disconnect();
    await observer?.query('DROP TABLE IF EXISTS qa78_pipe CASCADE');
    await observer?.end();
  });

  it('the batch rejects with the typed error and the earlier create is rolled back', async () => {
    await assert.rejects(failingBatch(), (err: unknown) => {
      assert.ok(err instanceof UniqueConstraintError, `expected UniqueConstraintError, got ${String(err)}`);
      return true;
    });
    assert.equal(await rowCount(), 2, 'the create that preceded the failure is not durable');
  });

  it('after the failure, an ordinary query on the same pool succeeds', async () => {
    await assert.rejects(failingBatch());
    assert.equal(await db.table('qa78_pipe').count(), 2);
  });

  it('after the failure, the backend is NOT idle in transaction (it was rolled back, not abandoned)', async () => {
    await assert.rejects(failingBatch());
    assert.equal(await inTransaction(), 0);
  });

  it('the connection is rolled back and KEPT, not discarded: the same backend serves the next call', async () => {
    const before = await backendPid();
    await assert.rejects(failingBatch());
    assert.equal(await backendPid(), before, 'poolSize 1: a discard would have shown a new pid');
  });

  it('after the failure, a $transaction on the same connection commits its write', async () => {
    await assert.rejects(failingBatch());
    await db.$transaction(async (tx) => {
      await tx.table('qa78_pipe').create({ data: { id: 4, n: 40 } });
    });
    assert.equal(await rowCount(), 3);
    await observer.query('DELETE FROM qa78_pipe WHERE id = 4');
  });

  it('after the failure, a { transactional: false } pipeline on the same connection succeeds', async () => {
    await assert.rejects(failingBatch());
    const results = await db.pipeline(
      [db.table('qa78_pipe').buildCount(), db.table('qa78_pipe').buildFindMany({ orderBy: { id: 'asc' } })],
      { transactional: false },
    );
    assert.equal(results[0], 2);
    assert.equal((results[1] as Record<string, unknown>[]).length, 2);
    assert.equal(await inTransaction(), 0);
  });

  it('a failure in the LAST slot (the COMMIT is the next message) is rolled back the same way', async () => {
    await assert.rejects(
      db.pipeline([db.table('qa78_pipe').buildCount(), db.table('qa78_pipe').buildCreate({ data: { id: 2, n: 0 } })]),
    );
    assert.equal(await db.table('qa78_pipe').count(), 2);
    assert.equal(await inTransaction(), 0);
  });

  it('a successful transactional batch still commits (the rollback path is only taken on error)', async () => {
    const results = await db.pipeline([
      db.table('qa78_pipe').buildCreate({ data: { id: 5, n: 50 } }),
      db.table('qa78_pipe').buildCount(),
    ]);
    assert.equal((results[0] as Record<string, unknown>).id, 5);
    assert.equal(results[1], 3);
    assert.equal(await rowCount(), 3);
    assert.equal(await inTransaction(), 0);
    await observer.query('DELETE FROM qa78_pipe WHERE id = 5');
  });
});
