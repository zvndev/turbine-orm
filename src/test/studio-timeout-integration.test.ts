/**
 * Regression test for the Studio / adapter statement-timeout SQL, run against a
 * REAL database engine.
 *
 * Studio (and the adapters) previously issued `SET LOCAL statement_timeout = $1`,
 * which Postgres rejects — `SET` does not accept bind parameters, so every
 * Studio query 500'd with `syntax error at or near "$1"` on plain Postgres.
 * The unit tests mocked the pool and never sent the SQL to a real server, so
 * the bug shipped green. This test runs the ACTUAL adapter timeout SQL against a
 * live connection so the regression cannot return unnoticed.
 *
 * Engine-aware: set TURBINE_TEST_ENGINE to `postgres` (default), `cockroachdb`,
 * or `yugabytedb`. CI points each real-engine job at the matching adapter so the
 * engine-SPECIFIC timeout SQL (e.g. CockroachDB's `transaction_timeout`) is
 * actually executed against that engine — not just asserted as a string.
 *
 * Run: DATABASE_URL=... TURBINE_TEST_ENGINE=cockroachdb npx tsx --test src/test/studio-timeout-integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pg from 'pg';
import { cockroachdb } from '../adapters/cockroachdb.js';
import { postgresql } from '../adapters/index.js';
import { yugabytedb } from '../adapters/yugabytedb.js';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping studio-timeout integration test: DATABASE_URL not set');
}

// Pick the adapter whose engine-specific timeout SQL we should exercise.
const ENGINE = (process.env.TURBINE_TEST_ENGINE ?? 'postgres').toLowerCase();
const ADAPTER_BY_ENGINE = {
  postgres: postgresql,
  postgresql: postgresql,
  cockroachdb: cockroachdb,
  cockroach: cockroachdb,
  yugabytedb: yugabytedb,
  yugabyte: yugabytedb,
} as const;
const adapter = ADAPTER_BY_ENGINE[ENGINE as keyof typeof ADAPTER_BY_ENGINE] ?? postgresql;

const testFn = SKIP ? describe.skip : describe;

testFn(`statement-timeout SQL executes on a real engine (${ENGINE})`, () => {
  it(`the ${adapter.name} adapter timeout SQL runs in a transaction without a syntax error`, async () => {
    const client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      const { sql, params } = adapter.statementTimeout!(30);
      // Plain BEGIN (not `BEGIN READ ONLY`, which CockroachDB rejects as a
      // single statement) — we are validating the timeout SQL, not read-only.
      await client.query('BEGIN');
      // With the old `SET ... = $1` form this throws a bind-param syntax error
      // on every engine. set_config() is the parameterizable, txn-local form.
      await assert.doesNotReject(() => client.query(sql, params));
      // A normal query still works after the timeout is set.
      const r = await client.query('SELECT 1 AS ok');
      assert.equal(Number(r.rows[0].ok), 1);
      await client.query('COMMIT');
    } finally {
      await client.end();
    }
  });

  // The exact `'30s'` GUC rendering is Postgres-specific; CockroachDB/Yugabyte
  // normalize timeout GUCs differently, so only assert the literal on Postgres.
  if (adapter === postgresql) {
    it('applies the timeout for the transaction (postgres renders it as 30s)', async () => {
      const client = new pg.Client({ connectionString: DATABASE_URL });
      await client.connect();
      try {
        const { sql, params } = postgresql.statementTimeout!(30);
        await client.query('BEGIN');
        await client.query(sql, params);
        const shown = await client.query('SHOW statement_timeout');
        assert.equal(shown.rows[0].statement_timeout, '30s');
        await client.query('ROLLBACK');
      } finally {
        await client.end();
      }
    });
  }

  it('every adapter uses set_config(), never the unparameterizable `SET LOCAL ... = $1` form', () => {
    for (const a of [postgresql, yugabytedb, cockroachdb]) {
      const { sql } = a.statementTimeout!(30);
      assert.ok(sql.startsWith('SELECT set_config('), `${a.name} should use set_config(): got ${sql}`);
      assert.ok(!/SET\s+LOCAL/i.test(sql), `${a.name} must not use SET LOCAL with a bind param`);
    }
  });
});
