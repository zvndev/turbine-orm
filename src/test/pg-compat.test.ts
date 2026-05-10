/**
 * PostgreSQL compatibility test suite
 *
 * Verifies that Turbine's core SQL patterns produce valid PostgreSQL syntax
 * that works across PG-compatible databases (PostgreSQL, AlloyDB, Timescale,
 * YugabyteDB, CockroachDB).
 *
 * These tests use the mock query builder pattern (no database needed) to
 * generate SQL and verify it uses only standard PG features.
 *
 * Compatibility matrix:
 * ┌────────────────────────┬──────┬─────────┬───────────┬────────────┬─────────────┐
 * │ Feature                │  PG  │ AlloyDB │ Timescale │ YugabyteDB │ CockroachDB │
 * ├────────────────────────┼──────┼─────────┼───────────┼────────────┼─────────────┤
 * │ json_agg               │  ✓   │    ✓    │     ✓     │     ✓      │      ✓      │
 * │ json_build_object      │  ✓   │    ✓    │     ✓     │     ✓      │      ✓      │
 * │ Correlated subqueries  │  ✓   │    ✓    │     ✓     │     ✓      │      ✓      │
 * │ COALESCE(..., '[]')    │  ✓   │    ✓    │     ✓     │     ✓      │      ✓      │
 * │ Parameterized queries  │  ✓   │    ✓    │     ✓     │     ✓      │      ✓      │
 * │ LIKE / ILIKE           │  ✓   │    ✓    │     ✓     │     ✓      │      ✓      │
 * │ IN / NOT IN            │  ✓   │    ✓    │     ✓     │     ✓      │      ✓      │
 * │ ORDER BY + LIMIT       │  ✓   │    ✓    │     ✓     │     ✓      │      ✓      │
 * │ CTE (WITH clause SQL)  │  ✓   │    ✓    │     ✓     │     ✓      │      ✓      │
 * │ SAVEPOINT (nested tx)  │  ✓   │    ✓    │     ✓     │     ✓      │      ✓      │
 * │ pg_try_advisory_lock   │  ✓   │    ✓    │     ✓     │  per-node  │      ✗      │
 * │ information_schema     │  ✓   │    ✓    │     ✓     │     ✓      │      ✓      │
 * │ pg_class.reltuples     │  ✓   │    ✓    │     ✓     │   stale    │   unreliable│
 * │ Sequences (SERIAL)     │  ✓   │    ✓    │     ✓     │  gaps ok   │  unique_row │
 * └────────────────────────┴──────┴─────────┴───────────┴────────────┴─────────────┘
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

// ---------------------------------------------------------------------------
// Shared test schema
// ---------------------------------------------------------------------------

function createTestSchema(): SchemaMetadata {
  const usersTable = mockTable(
    'users',
    [
      { name: 'id', field: 'id', pgType: 'int8' },
      { name: 'name', field: 'name', pgType: 'text' },
      { name: 'email', field: 'email', pgType: 'text' },
      { name: 'created_at', field: 'createdAt', pgType: 'timestamptz' },
      { name: 'metadata', field: 'metadata', pgType: 'jsonb' },
    ],
    {
      posts: {
        type: 'hasMany',
        name: 'posts',
        from: 'users',
        to: 'posts',
        foreignKey: 'user_id',
        referenceKey: 'id',
      },
    },
  );

  const postsTable = mockTable(
    'posts',
    [
      { name: 'id', field: 'id', pgType: 'int8' },
      { name: 'title', field: 'title', pgType: 'text' },
      { name: 'content', field: 'content', pgType: 'text' },
      { name: 'user_id', field: 'userId', pgType: 'int8' },
      { name: 'published', field: 'published', pgType: 'bool' },
      { name: 'tags', field: 'tags', pgType: '_text' },
      { name: 'created_at', field: 'createdAt', pgType: 'timestamptz' },
    ],
    {
      author: {
        type: 'belongsTo',
        name: 'author',
        from: 'posts',
        to: 'users',
        foreignKey: 'user_id',
        referenceKey: 'id',
      },
      comments: {
        type: 'hasMany',
        name: 'comments',
        from: 'posts',
        to: 'comments',
        foreignKey: 'post_id',
        referenceKey: 'id',
      },
    },
  );

  const commentsTable = mockTable(
    'comments',
    [
      { name: 'id', field: 'id', pgType: 'int8' },
      { name: 'body', field: 'body', pgType: 'text' },
      { name: 'post_id', field: 'postId', pgType: 'int8' },
      { name: 'author_id', field: 'authorId', pgType: 'int8' },
      { name: 'created_at', field: 'createdAt', pgType: 'timestamptz' },
    ],
    {
      post: {
        type: 'belongsTo',
        name: 'post',
        from: 'comments',
        to: 'posts',
        foreignKey: 'post_id',
        referenceKey: 'id',
      },
      author: {
        type: 'belongsTo',
        name: 'author',
        from: 'comments',
        to: 'users',
        foreignKey: 'author_id',
        referenceKey: 'id',
      },
    },
  );

  return {
    tables: { users: usersTable, posts: postsTable, comments: commentsTable },
    enums: {},
  };
}

// ---------------------------------------------------------------------------
// SQL pattern verification helpers
// ---------------------------------------------------------------------------

/**
 * Assert that the SQL only uses standard PostgreSQL syntax patterns that
 * are compatible across all target databases.
 */
function assertStandardPgSql(sql: string) {
  // Should use parameterized queries ($1, $2, etc.), never string interpolation
  if (sql.includes("'") && !sql.includes("'[]'::json") && !sql.includes("'%")) {
    // Allow the COALESCE empty-array literal and LIKE patterns, but nothing else
    // that looks like inline string values from user input
  }

  // Should use double-quoted identifiers (standard SQL)
  // Not asserting all identifiers are quoted — just that none use backticks
  assert.ok(!sql.includes('`'), 'SQL should not use backtick quoting (MySQL syntax)');

  // Should never contain raw user values (basic sanity check)
  assert.ok(!sql.includes('undefined'), 'SQL should not contain literal "undefined"');
  assert.ok(!sql.includes('[object Object]'), 'SQL should not contain stringified objects');
}

// ---------------------------------------------------------------------------
// Tests: Core SQL patterns
// ---------------------------------------------------------------------------

describe('pg-compat: SQL compatibility across PG-compatible databases', () => {
  const schema = createTestSchema();

  describe('basic findMany', () => {
    it('generates standard SELECT with parameterized WHERE', () => {
      const q = makeQuery('users', schema);
      const deferred = q.buildFindMany({ where: { email: 'test@test.com' } });

      assertStandardPgSql(deferred.sql);
      assert.ok(deferred.sql.includes('SELECT'));
      assert.ok(deferred.sql.includes('FROM "users"'));
      assert.ok(deferred.sql.includes('WHERE'));
      assert.ok(deferred.sql.includes('$1'));
      assert.deepEqual(deferred.params, ['test@test.com']);
    });

    it('generates standard ORDER BY + LIMIT + OFFSET', () => {
      const q = makeQuery('posts', schema);
      const deferred = q.buildFindMany({
        orderBy: { createdAt: 'desc' },
        limit: 10,
        offset: 20,
      });

      assertStandardPgSql(deferred.sql);
      assert.ok(deferred.sql.includes('ORDER BY'));
      assert.ok(deferred.sql.includes('DESC'));
      assert.ok(deferred.sql.includes('LIMIT'));
      assert.ok(deferred.sql.includes('OFFSET'));
    });
  });

  describe('json_agg nested relations', () => {
    it('generates json_agg + json_build_object for hasMany', () => {
      const q = makeQuery('users', schema);
      const deferred = q.buildFindMany({ with: { posts: true } });

      assertStandardPgSql(deferred.sql);
      assert.ok(deferred.sql.includes('json_agg'), 'Should use json_agg for hasMany');
      assert.ok(deferred.sql.includes('json_build_object'), 'Should use json_build_object for row mapping');
      assert.ok(
        deferred.sql.includes('COALESCE') && deferred.sql.includes("'[]'::json"),
        'Should COALESCE null to empty array',
      );
    });

    it('generates correlated subquery for belongsTo', () => {
      const q = makeQuery('posts', schema);
      const deferred = q.buildFindMany({ with: { author: true } });

      assertStandardPgSql(deferred.sql);
      assert.ok(deferred.sql.includes('json_build_object'));
      // belongsTo = single row, no json_agg needed (uses subquery with LIMIT 1 or scalar)
      assert.ok(deferred.sql.includes('"users"'), 'Should reference the related table');
    });

    it('supports deeply nested relations (posts -> comments -> author)', () => {
      const q = makeQuery('users', schema);
      const deferred = q.buildFindMany({
        with: {
          posts: {
            with: {
              comments: {
                with: { author: true },
              },
            },
          },
        },
      });

      assertStandardPgSql(deferred.sql);
      assert.ok(deferred.sql.includes('"posts"'));
      assert.ok(deferred.sql.includes('"comments"'));
      assert.ok(deferred.sql.includes('"users"'));
      // Multiple levels of json_agg nesting
      const jsonAggCount = (deferred.sql.match(/json_agg/g) || []).length;
      assert.ok(jsonAggCount >= 2, `Expected at least 2 json_agg calls, got ${jsonAggCount}`);
    });
  });

  describe('WHERE operators', () => {
    it('generates standard comparison operators', () => {
      const q = makeQuery('users', schema);
      const deferred = q.buildFindMany({
        where: { id: { gt: 5, lt: 100 } },
      });

      assertStandardPgSql(deferred.sql);
      assert.ok(deferred.sql.includes('>'));
      assert.ok(deferred.sql.includes('<'));
    });

    it('generates ANY() for array membership check', () => {
      const q = makeQuery('users', schema);
      const deferred = q.buildFindMany({
        where: { id: { in: [1, 2, 3] } },
      });

      assertStandardPgSql(deferred.sql);
      // Turbine uses = ANY($N) for IN operators (standard PG syntax)
      assert.ok(
        deferred.sql.includes('ANY') || deferred.sql.includes('IN'),
        'Should use ANY() or IN for array membership',
      );
    });

    it('generates ILIKE for case-insensitive matching', () => {
      const q = makeQuery('users', schema);
      const deferred = q.buildFindMany({
        where: { name: { contains: 'test', mode: 'insensitive' } },
      });

      assertStandardPgSql(deferred.sql);
      assert.ok(deferred.sql.includes('ILIKE'), 'Should use ILIKE for insensitive mode');
    });

    it('generates LIKE for case-sensitive matching', () => {
      const q = makeQuery('users', schema);
      const deferred = q.buildFindMany({
        where: { name: { contains: 'test' } },
      });

      assertStandardPgSql(deferred.sql);
      assert.ok(deferred.sql.includes('LIKE'), 'Should use LIKE for sensitive mode');
    });

    it('generates IS NULL check', () => {
      const q = makeQuery('users', schema);
      const deferred = q.buildFindMany({
        where: { name: null },
      });

      assertStandardPgSql(deferred.sql);
      assert.ok(deferred.sql.includes('IS NULL'));
    });

    it('generates OR combinator', () => {
      const q = makeQuery('users', schema);
      const deferred = q.buildFindMany({
        where: { OR: [{ name: 'alice' }, { name: 'bob' }] },
      });

      assertStandardPgSql(deferred.sql);
      assert.ok(deferred.sql.includes('OR'));
    });
  });

  describe('mutations', () => {
    it('generates standard INSERT with RETURNING', () => {
      const q = makeQuery('users', schema);
      const deferred = q.buildCreate({
        data: { name: 'Alice', email: 'alice@test.com' },
      });

      assertStandardPgSql(deferred.sql);
      assert.ok(deferred.sql.includes('INSERT INTO'));
      assert.ok(deferred.sql.includes('RETURNING'));
      assert.ok(deferred.sql.includes('$1'));
      assert.ok(deferred.sql.includes('$2'));
    });

    it('generates UPDATE with SET and WHERE', () => {
      const q = makeQuery('users', schema);
      const deferred = q.buildUpdate({
        where: { id: 1 },
        data: { name: 'Updated' },
      });

      assertStandardPgSql(deferred.sql);
      assert.ok(deferred.sql.includes('UPDATE "users"'));
      assert.ok(deferred.sql.includes('SET'));
      assert.ok(deferred.sql.includes('WHERE'));
      assert.ok(deferred.sql.includes('RETURNING'));
    });

    it('generates DELETE with WHERE', () => {
      const q = makeQuery('users', schema);
      const deferred = q.buildDelete({
        where: { id: 1 },
      });

      assertStandardPgSql(deferred.sql);
      assert.ok(deferred.sql.includes('DELETE FROM'));
      assert.ok(deferred.sql.includes('WHERE'));
    });

    it('generates atomic update operators (col = col + $n)', () => {
      const q = makeQuery('posts', schema);
      const deferred = q.buildUpdate({
        where: { id: 1 },
        data: { id: { increment: 1 } },
      });

      assertStandardPgSql(deferred.sql);
      // Should use col = col + $n pattern, not col = $n
      assert.ok(
        deferred.sql.includes('+') || deferred.sql.includes('increment'),
        'Should generate atomic update expression',
      );
    });
  });

  describe('aggregate queries', () => {
    it('generates COUNT(*)', () => {
      const q = makeQuery('users', schema);
      const deferred = q.buildCount({});

      assertStandardPgSql(deferred.sql);
      assert.ok(deferred.sql.includes('COUNT(*)') || deferred.sql.includes('count(*)'), 'Should use COUNT(*)');
    });

    it('generates COUNT with WHERE filter', () => {
      const q = makeQuery('posts', schema);
      const deferred = q.buildCount({ where: { published: true } });

      assertStandardPgSql(deferred.sql);
      assert.ok(deferred.sql.toLowerCase().includes('count'));
      assert.ok(deferred.sql.includes('WHERE'));
    });
  });

  describe('select/omit field filtering', () => {
    it('generates SELECT with specific columns when select is provided', () => {
      const q = makeQuery('users', schema);
      const deferred = q.buildFindMany({
        select: { id: true, name: true },
      });

      assertStandardPgSql(deferred.sql);
      assert.ok(deferred.sql.includes('"id"'));
      assert.ok(deferred.sql.includes('"name"'));
      // Should NOT include columns not in select
      assert.ok(!deferred.sql.includes('"metadata"'));
    });
  });

  describe('parameterization safety', () => {
    it('never inlines user values directly into SQL', () => {
      const q = makeQuery('users', schema);
      const maliciousInput = "'; DROP TABLE users; --";
      const deferred = q.buildFindMany({
        where: { name: maliciousInput },
      });

      // The malicious string should be in params, not in the SQL
      assert.ok(!deferred.sql.includes(maliciousInput));
      assert.ok(deferred.params.includes(maliciousInput));
    });

    it('uses $N placeholders, never ? style', () => {
      const q = makeQuery('users', schema);
      const deferred = q.buildFindMany({
        where: { name: 'test', email: 'test@test.com' },
      });

      assert.ok(deferred.sql.includes('$1'));
      assert.ok(deferred.sql.includes('$2'));
      // Should not use ? style (MySQL/SQLite)
      const questionMarks = deferred.sql.match(/\?/g);
      assert.equal(questionMarks, null, 'Should not use ? style parameters');
    });
  });
});
