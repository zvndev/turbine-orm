/**
 * turbine-orm: SQL-cache fingerprint correctness for inline pagination + distinct
 *
 * Two classes of cache bug are covered here:
 *
 *  1. Inline LIMIT/OFFSET (dialect.inlineLimitOffset, MySQL). On these engines
 *     the literal pagination value is baked into the SQL text (not a bound
 *     param), so the fingerprint MUST include the value. Otherwise a `limit: 10`
 *     query and a `limit: 20` query share one cached statement and the second
 *     silently returns 10 rows. Parameterized engines (Postgres) keep sharing one
 *     cache entry across differing limits because the value lives in params.
 *
 *  2. `distinct` fingerprinted in sorted order while the SQL emits `DISTINCT ON`
 *     in USER order: a permuted distinct array rebuilds different SQL under one
 *     fingerprint, tripping the dev-mode cross-check with a false-positive E003.
 *
 * All assertions run with the dev-mode SQL-cache cross-check LIVE (default env),
 * so a clean run is itself proof the fingerprint/build/collect paths stay in
 * lockstep for these shapes.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mysqlDialect } from '../mysql.js';
import type { RelationDef, SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      users: mockTable(
        'users',
        [
          { name: 'id', field: 'id', pgType: 'int8' },
          { name: 'name', field: 'name', pgType: 'text' },
          { name: 'age', field: 'age', pgType: 'int4' },
          { name: 'score', field: 'score', pgType: 'int4' },
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
      ),
      posts: mockTable('posts', [
        { name: 'id', field: 'id', pgType: 'int8' },
        { name: 'user_id', field: 'userId', pgType: 'int8' },
        { name: 'title', field: 'title', pgType: 'text' },
      ]),
    },
  };
}

function limitLiteral(sql: string): number {
  const m = sql.match(/ LIMIT (\d+)/);
  assert.ok(m, `expected an inline LIMIT literal in: ${sql}`);
  return Number(m[1]);
}

describe('inline-pagination cache (MySQL): top-level limit', () => {
  it('warmed limit 10 then limit 20 build distinct SQL with the correct LIMIT each', () => {
    const q = makeQuery('users', schema(), { dialect: mysqlDialect });

    const first = q.buildFindMany({ limit: 10 } as never);
    const second = q.buildFindMany({ limit: 20 } as never); // cache HIT would be wrong here

    assert.equal(limitLiteral(first.sql), 10);
    assert.equal(limitLiteral(second.sql), 20);
    assert.notEqual(first.sql, second.sql);
    // Re-hitting the first shape returns LIMIT 10 again (not the last-built 20).
    const third = q.buildFindMany({ limit: 10 } as never);
    assert.equal(limitLiteral(third.sql), 10);
  });
});

describe('inline-pagination cache (MySQL): top-level offset', () => {
  it('warmed offset 5 then offset 15 build distinct SQL with the correct OFFSET each', () => {
    const q = makeQuery('users', schema(), { dialect: mysqlDialect });

    const first = q.buildFindMany({ limit: 10, offset: 5 } as never);
    const second = q.buildFindMany({ limit: 10, offset: 15 } as never);

    assert.match(first.sql, / OFFSET 5\b/);
    assert.match(second.sql, / OFFSET 15\b/);
    assert.notEqual(first.sql, second.sql);
  });
});

describe('inline-pagination cache (MySQL): relation-level limit', () => {
  it('with:{posts:{limit:3}} then {limit:5} build distinct SQL with the correct inner LIMIT each', () => {
    const q = makeQuery('users', schema(), { dialect: mysqlDialect });

    const first = q.buildFindMany({ with: { posts: { limit: 3 } } } as never);
    const second = q.buildFindMany({ with: { posts: { limit: 5 } } } as never);

    assert.equal(limitLiteral(first.sql), 3);
    assert.equal(limitLiteral(second.sql), 5);
    assert.notEqual(first.sql, second.sql);
  });
});

describe('parameterized-pagination cache (Postgres): one entry across limits', () => {
  it('limit 10 then limit 20 share one cached SQL string; only the param differs', () => {
    const q = makeQuery('users', schema()); // default Postgres dialect

    const first = q.buildFindMany({ limit: 10 } as never);
    const second = q.buildFindMany({ limit: 20 } as never);

    // Value lives in the params, so the SQL text is byte-identical (shared cache).
    assert.equal(first.sql, second.sql);
    assert.ok(first.params.includes(10));
    assert.ok(second.params.includes(20));
  });
});

describe('distinct fingerprint uses user order (no cross-check false positive)', () => {
  it('permuted distinct arrays build their own SQL and never trip the cross-check', () => {
    const q = makeQuery('users', schema());

    // Warm with one order, then hit with the columns permuted. The SQL emits
    // DISTINCT ON in user order, so these must NOT share a fingerprint, and the
    // live cross-check must not throw.
    const first = q.buildFindMany({ distinct: ['age', 'score'] } as never);
    let second!: ReturnType<typeof q.buildFindMany>;
    assert.doesNotThrow(() => {
      second = q.buildFindMany({ distinct: ['score', 'age'] } as never);
    });

    assert.match(first.sql, /DISTINCT ON \("age", "score"\)/);
    assert.match(second.sql, /DISTINCT ON \("score", "age"\)/);
    assert.notEqual(first.sql, second.sql);

    // The original order still rebuilds correctly (own cache entry intact).
    const again = q.buildFindMany({ distinct: ['age', 'score'] } as never);
    assert.equal(again.sql, first.sql);
  });
});
