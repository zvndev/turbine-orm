/**
 * turbine-orm - QueryInterface.explain() (SQL engines)
 *
 * Two lanes:
 *  1. **Build-only + capturing-driver** (this lane, `test:unit`, NO DB): prove
 *     `explain()` prepends the dialect's explain syntax to the compiled findMany
 *     SQL, passes the same params through, throws E017 on engines with no
 *     in-band explain (SQL Server), never poisons the SQL template cache, and
 *     flattens each plan row to one line. A tiny capturing pool records the SQL
 *     the method WOULD run so no server is needed.
 *  2. **Real integration** (gated on `DATABASE_URL`): `explain({ limit: 1 })`
 *     against a seeded Postgres returns non-empty plan lines.
 *
 * Run the integration lane against a Postgres seeded by src/test/fixtures/seed.sql:
 *   DATABASE_URL=postgres://... npx tsx --test src/test/explain.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TurbineClient } from '../client.js';
import { UnsupportedFeatureError } from '../errors.js';
import { introspect } from '../introspect.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import { QueryInterface, type QueryInterfaceOptions } from '../query/index.js';
import type { RelationDef, SchemaMetadata } from '../schema.js';
import { sqliteDialect } from '../sqlite.js';
import { makeQuery, mockTable, skipGate } from './helpers.js';

// ===========================================================================
// Tier 1 - build-only, capturing driver (no DB)
// ===========================================================================

const usersTable = mockTable(
  'users',
  [
    { name: 'id', field: 'id', pgType: 'bigint' },
    { name: 'name', field: 'name', pgType: 'text' },
    { name: 'role', field: 'role', pgType: 'text' },
  ],
  {
    posts: {
      name: 'posts',
      type: 'hasMany',
      from: 'users',
      to: 'posts',
      foreignKey: 'user_id',
      referenceKey: 'id',
    } as RelationDef,
  },
);
const postsTable = mockTable('posts', [
  { name: 'id', field: 'id', pgType: 'bigint' },
  { name: 'user_id', field: 'userId', pgType: 'bigint' },
  { name: 'title', field: 'title', pgType: 'text' },
]);
const schema: SchemaMetadata = { tables: { users: usersTable, posts: postsTable }, enums: {} };

/** A minimal pg-compatible pool that records every query and returns canned rows. */
function capturingPool(rows: Record<string, unknown>[] = []) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pool = {
    // biome-ignore lint/suspicious/noExplicitAny: mirrors pg.Pool's two call shapes.
    query(config: any, params?: unknown[]) {
      const sql = typeof config === 'string' ? config : config.text;
      const values = typeof config === 'string' ? (params ?? []) : (config.values ?? []);
      calls.push({ sql, params: values });
      return Promise.resolve({ rows, rowCount: rows.length });
    },
  };
  return { pool, calls };
}

/** Build a QueryInterface over the capturing pool for `users`. */
function qi(rows: Record<string, unknown>[] = [], options?: QueryInterfaceOptions) {
  const { pool, calls } = capturingPool(rows);
  const query = new QueryInterface<Record<string, unknown>>(
    // biome-ignore lint/suspicious/noExplicitAny: capturing pool is not a real pg.Pool.
    pool as any,
    'users',
    schema,
    [],
    { warnOnUnlimited: false, ...options },
  );
  return { query, calls };
}

describe('explain() - SQL prefix + param pass-through', () => {
  it('Postgres: prepends "EXPLAIN " to the compiled findMany SQL with identical params', async () => {
    const args = { where: { id: 1, role: 'admin' }, orderBy: { name: 'asc' as const }, limit: 5 };
    // Baseline: the exact SQL + params buildFindMany produces for the same args.
    const built = makeQuery('users', schema).buildFindMany(args);

    const { query, calls } = qi();
    const lines = await query.explain(args);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.sql, `EXPLAIN ${built.sql}`);
    assert.deepEqual(calls[0]!.params, built.params);
    assert.deepEqual(lines, []); // no rows returned by the capturing pool
  });

  it('SQLite: prepends "EXPLAIN QUERY PLAN "', async () => {
    const args = { where: { id: 1 }, limit: 1 };
    const built = makeQuery('users', schema, { dialect: sqliteDialect }).buildFindMany(args);
    const { query, calls } = qi([], { dialect: sqliteDialect });
    await query.explain(args);
    assert.equal(calls[0]!.sql, `EXPLAIN QUERY PLAN ${built.sql}`);
    assert.deepEqual(calls[0]!.params, built.params);
  });

  it('MySQL: prepends "EXPLAIN " (plain, works on the whole 8.0.x floor)', async () => {
    const args = { where: { role: 'admin' }, limit: 3 };
    const built = makeQuery('users', schema, { dialect: mysqlDialect }).buildFindMany(args);
    const { query, calls } = qi([], { dialect: mysqlDialect });
    await query.explain(args);
    assert.equal(calls[0]!.sql, `EXPLAIN ${built.sql}`);
    assert.deepEqual(calls[0]!.params, built.params);
  });

  it('SQL Server: throws E017 (no in-band explain, SHOWPLAN is a session toggle)', async () => {
    // Null pool is fine: the guard throws before any execution.
    const query = makeQuery('users', schema, { dialect: mssqlDialect });
    await assert.rejects(
      () => query.explain({ where: { id: 1 } }),
      (err: unknown) => {
        assert.ok(err instanceof UnsupportedFeatureError, 'must be UnsupportedFeatureError');
        assert.equal(err.code, 'TURBINE_E017');
        assert.equal(err.dialect, 'mssql');
        return true;
      },
    );
  });
});

describe('explain() - does not poison the SQL template cache', () => {
  it('a findMany after explain runs the plain SELECT, not the EXPLAIN-prefixed SQL', async () => {
    const args = { where: { id: 1 }, limit: 1 };
    const plain = makeQuery('users', schema).buildFindMany(args).sql;

    // One QueryInterface, cache enabled (default), capturing pool.
    const { pool, calls } = capturingPool();
    const query = new QueryInterface<Record<string, unknown>>(
      // biome-ignore lint/suspicious/noExplicitAny: capturing pool is not a real pg.Pool.
      pool as any,
      'users',
      schema,
      [],
      { warnOnUnlimited: false },
    );

    await query.explain(args);
    await query.findMany(args);

    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.sql, `EXPLAIN ${plain}`, 'explain runs the prefixed SQL');
    assert.equal(calls[1]!.sql, plain, 'findMany runs the plain SELECT (cache not poisoned)');
    assert.doesNotMatch(calls[1]!.sql, /^EXPLAIN/);
  });
});

describe('explain() - row flattening', () => {
  it('joins each row column values with a single space, stringifying non-strings', async () => {
    const rows = [
      // Postgres shape: one text column.
      { 'QUERY PLAN': 'Seq Scan on users  (cost=0.00..1.10 rows=8)' },
      // SQLite EXPLAIN QUERY PLAN shape: four columns, numeric leading cells.
      { id: 4, parent: 0, notused: 0, detail: 'SEARCH users USING INTEGER PRIMARY KEY' },
      // Mixed non-string cells (number / boolean / null) exercise stringification.
      { a: 1, b: true, c: null, d: 'x' },
    ];
    const { query } = qi(rows);
    const lines = await query.explain({ limit: 1 });
    assert.deepEqual(lines, [
      'Seq Scan on users  (cost=0.00..1.10 rows=8)',
      '4 0 0 SEARCH users USING INTEGER PRIMARY KEY',
      '1 true null x',
    ]);
  });
});

// ===========================================================================
// Tier 2 - real Postgres integration (gated on DATABASE_URL)
// ===========================================================================

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping explain() integration tests: DATABASE_URL not set');
}

const gated = skipGate(SKIP, 'DATABASE_URL not set');

describe('explain() - Postgres integration', () => {
  let db: TurbineClient;

  gated.before(async () => {
    const introspected = await introspect({ connectionString: DATABASE_URL! });
    db = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 3, warnOnUnlimited: false }, introspected);
    await db.connect();
  });

  gated.after(async () => {
    await db.disconnect();
  });

  gated.it('returns non-empty plan lines for a seeded table', async () => {
    const lines = await db.table('users').explain({ limit: 1 });
    assert.ok(Array.isArray(lines), 'explain returns an array');
    assert.ok(lines.length > 0, 'plan has at least one line');
    // Be liberal: the plan text is engine-owned, only assert non-empty content.
    assert.ok(
      lines.every((line) => typeof line === 'string' && line.trim().length > 0),
      'every plan line is a non-empty string',
    );
  });
});
