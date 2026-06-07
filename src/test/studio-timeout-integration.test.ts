/**
 * Regression test for the Studio statement-timeout SQL.
 *
 * Studio (and the adapters) previously issued `SET LOCAL statement_timeout = $1`,
 * which Postgres rejects — `SET` does not accept bind parameters, so every
 * Studio query 500'd with `syntax error at or near "$1"` on plain Postgres.
 * The unit tests mocked the pool and never sent the SQL to a real server, so
 * the bug shipped green. This test runs the ACTUAL timeout SQL against a real
 * connection so the regression cannot return unnoticed.
 *
 * Run: DATABASE_URL=... npx tsx --test src/test/studio-timeout-integration.test.ts
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

const testFn = SKIP ? describe.skip : describe;

testFn('studio statement-timeout SQL executes on real Postgres', () => {
  it('the default (postgres) timeout SQL runs inside a transaction without a syntax error', async () => {
    const client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      const { sql, params } = postgresql.statementTimeout!(30);
      await client.query('BEGIN READ ONLY');
      // This is the exact call studio.ts makes before each query. With the old
      // `SET LOCAL statement_timeout = $1` form this throws 42601.
      await assert.doesNotReject(() => client.query(sql, params));
      const shown = await client.query('SHOW statement_timeout');
      assert.equal(shown.rows[0].statement_timeout, '30s', 'timeout should be applied for the transaction');
      // A normal query still works after the timeout is set.
      const r = await client.query('SELECT 1 AS ok');
      assert.equal(r.rows[0].ok, 1);
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  });

  it('the yugabytedb adapter timeout SQL is also accepted by Postgres', async () => {
    const client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      const { sql, params } = yugabytedb.statementTimeout!(15);
      await client.query('BEGIN');
      await assert.doesNotReject(() => client.query(sql, params));
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  });

  it('uses set_config(), never the unparameterizable `SET LOCAL ... = $1` form', () => {
    for (const adapter of [postgresql, yugabytedb, cockroachdb]) {
      const { sql } = adapter.statementTimeout!(30);
      assert.ok(sql.startsWith('SELECT set_config('), `${adapter.name} should use set_config(): got ${sql}`);
      assert.ok(!/SET\s+LOCAL/i.test(sql), `${adapter.name} must not use SET LOCAL with a bind param`);
    }
  });
});
