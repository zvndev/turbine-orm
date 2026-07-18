/**
 * turbine-orm: shared WHERE-key walk suite (C2)
 *
 * `fingerprintWhere`, `buildWhereClause`, and `collectWhereParams` now consume
 * ONE canonical walk (`where-compile.ts`), so key enumeration and combinator
 * structure cannot drift out of lockstep. This suite adversarially exercises
 * that invariant with permuted key insertion order, OR/AND/NOT nesting, JSON /
 * array / vector filters, relation filters, undefined-valued keys, and mixed
 * orderBy shapes.
 *
 * The load-bearing property is: whenever two WHERE clauses share a fingerprint,
 * they MUST compile to byte-identical SQL and their params, collected via the
 * warm-cache HIT path, must equal the params a fresh build produces, and each
 * column's `$N` placeholder must bind that column's own value. This is verified
 * by DOUBLE-COMPILE comparison: warm the cache with clause A, HIT it with a
 * fingerprint-equal clause B, and compare the HIT's (sql, params) against a
 * cache-disabled fresh build of B.
 *
 * The whole suite also runs under the always-on dev cross-check, so any latent
 * drift would additionally throw E003 here.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { QueryInterface } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      users: mockTable(
        'users',
        [
          { name: 'id', field: 'id' },
          { name: 'age', field: 'age', pgType: 'int4' },
          { name: 'score', field: 'score', pgType: 'int4' },
          { name: 'name', field: 'name', pgType: 'text' },
          { name: 'tenant_id', field: 'tenantId', pgType: 'int4' },
          { name: 'tags', field: 'tags', pgType: '_text' },
          { name: 'meta', field: 'meta', pgType: 'jsonb' },
          { name: 'embedding', field: 'embedding', pgType: 'vector' },
        ],
        {
          posts: {
            type: 'hasMany',
            name: 'posts',
            from: 'users',
            to: 'posts',
            foreignKey: 'author_id',
            referenceKey: 'id',
          },
        },
      ),
      posts: mockTable('posts', [
        { name: 'id', field: 'id' },
        { name: 'author_id', field: 'authorId' },
        { name: 'published', field: 'published', pgType: 'bool' },
        { name: 'views', field: 'views', pgType: 'int4' },
      ]),
    },
  };
}

type Where = Record<string, unknown>;
type Args = Record<string, unknown>;

/** Fresh (cache-disabled) compile: the byte-stability oracle for one clause. */
function fresh(args: Args): { sql: string; params: unknown[] } {
  const q = makeQuery('users', schema(), { sqlCache: false });
  const d = q.buildFindMany(args as never);
  return { sql: d.sql, params: d.params };
}

/**
 * Warm the cache with `warm`, then HIT it with `hit` (which must be
 * fingerprint-equal to `warm`). Returns the HIT's compiled (sql, params): the
 * SQL comes from the cache entry warmed by `warm`, the params from the
 * cache-hit collect path over `hit`. Runs under the live dev cross-check.
 */
function warmThenHit(warm: Args, hit: Args): { sql: string; params: unknown[] } {
  const q = makeQuery('users', schema());
  q.buildFindMany(warm as never);
  const d = q.buildFindMany(hit as never);
  return { sql: d.sql, params: d.params };
}

function fp(where: Where): string {
  return makeQuery('users', schema()).fingerprintWhere(where as never);
}

/**
 * The core property: `warm` and `hit` share a fingerprint ⇒ the warm-cache HIT
 * on `hit` yields byte-identical SQL and the exact params a fresh build of
 * `hit` produces. `hit` is expected to be a permutation / different-values
 * variant of `warm`.
 */
function assertCacheStable(warm: Where, hit: Where): { sql: string; params: unknown[] } {
  assert.equal(fp(warm), fp(hit), 'warm and hit must share a fingerprint for this property to apply');
  const hot = warmThenHit({ where: warm }, { where: hit });
  const cold = fresh({ where: hit });
  assert.equal(hot.sql, cold.sql, 'cache-hit SQL must equal a fresh build of the hit clause');
  assert.deepEqual(hot.params, cold.params, 'cache-hit params must equal a fresh build of the hit clause');
  return hot;
}

/** Index (1-based) of the param a `"col" = $N` placeholder binds, or -1. */
function eqParamIndex(sql: string, col: string): number {
  const m = sql.match(new RegExp(`"${col}" = \\$(\\d+)`));
  return m ? Number(m[1]) : -1;
}

describe('key-walk: permuted insertion order binds each column its own value', () => {
  it('two-key where, keys swapped, still binds correctly', () => {
    const hot = assertCacheStable({ age: 1, score: 2 }, { score: 20, age: 10 });
    const ageIdx = eqParamIndex(hot.sql, 'age');
    const scoreIdx = eqParamIndex(hot.sql, 'score');
    assert.equal(hot.params[ageIdx - 1], 10);
    assert.equal(hot.params[scoreIdx - 1], 20);
  });

  it('three-key where across many permutations all bind correctly', () => {
    const base = { age: 5, score: 6, tenantId: 7 };
    const perms = [
      { tenantId: 70, age: 50, score: 60 },
      { score: 60, tenantId: 70, age: 50 },
      { age: 50, tenantId: 70, score: 60 },
    ];
    for (const hit of perms) {
      const hot = assertCacheStable(base, hit);
      assert.equal(hot.params[eqParamIndex(hot.sql, 'age') - 1], 50);
      assert.equal(hot.params[eqParamIndex(hot.sql, 'score') - 1], 60);
      assert.equal(hot.params[eqParamIndex(hot.sql, 'tenant_id') - 1], 70);
    }
  });

  it('undefined-valued keys do not change the fingerprint or the compile', () => {
    assert.equal(fp({ age: 1, name: undefined }), fp({ age: 1 }));
    assertCacheStable({ age: 1, name: undefined }, { age: 99 });
  });
});

describe('key-walk: OR / AND / NOT nesting stays in lockstep', () => {
  it('nested OR with permuted inner keys', () => {
    assertCacheStable({ OR: [{ age: 1, score: 2 }, { name: 'a' }] }, { OR: [{ score: 20, age: 10 }, { name: 'zed' }] });
  });

  it('AND of permuted branches', () => {
    assertCacheStable(
      { AND: [{ age: 1 }, { score: 2, tenantId: 3 }] },
      { AND: [{ age: 10 }, { tenantId: 30, score: 20 }] },
    );
  });

  it('deep NOT( OR( AND ) ) nesting with permuted keys inside a branch', () => {
    // Array element order is positional (never sorted); permute the KEYS inside
    // the multi-key AND branch instead so the fingerprint stays equal.
    assertCacheStable(
      { NOT: { OR: [{ AND: [{ age: 1, score: 2 }] }, { name: 'x' }] } },
      { NOT: { OR: [{ AND: [{ score: 20, age: 10 }] }, { name: 'y' }] } },
    );
  });

  it('empty OR / AND arrays are skipped identically', () => {
    assert.equal(fp({ OR: [], age: 1 }), fp({ age: 1 }));
    assert.equal(fp({ AND: [], age: 1 }), fp({ age: 1 }));
    assertCacheStable({ OR: [], age: 1 }, { AND: [], age: 2 });
  });
});

describe('key-walk: operator, json, array, vector, text-search shapes', () => {
  it('operator objects with permuted sibling keys', () => {
    assertCacheStable({ age: { gt: 1, lt: 100 }, score: { gte: 0 } }, { score: { gte: 5 }, age: { lt: 200, gt: 10 } });
  });

  it('json filter on a jsonb column, permuted with a scalar', () => {
    assertCacheStable(
      { meta: { path: ['role'], equals: 'admin' }, age: 1 },
      { age: 10, meta: { path: ['role'], equals: 'editor' } },
    );
  });

  it('array filter on an array column', () => {
    assertCacheStable({ tags: { has: 'x' }, age: 1 }, { age: 9, tags: { has: 'y' } });
  });

  it('vector distance filter binds its query vector', () => {
    assertCacheStable(
      { embedding: { distance: { to: [1, 2, 3], metric: 'cosine', lt: 0.5 } } },
      { embedding: { distance: { to: [9, 8, 7], metric: 'cosine', lt: 0.9 } } },
    );
  });

  it('a bare equals/contains keeps its operator meaning on a non-json column', () => {
    // `name` is text, so `{ contains }` is a LIKE operator, not a JSON filter;
    // the fingerprint tokenizes it as an operator and the compile matches.
    assertCacheStable({ name: { contains: 'ab' } }, { name: { contains: 'cd' } });
  });
});

describe('key-walk: relation filters (some / none / every / is)', () => {
  it('some-filter with permuted inner where', () => {
    assertCacheStable(
      { posts: { some: { published: true, views: { gt: 1 } } }, age: 1 },
      { age: 10, posts: { some: { views: { gt: 100 }, published: false } } },
    );
  });

  it('none-filter and a scalar', () => {
    assertCacheStable({ posts: { none: { published: true } } }, { posts: { none: { published: false } } });
  });

  it('every-filter with a non-trivial sub-where', () => {
    assertCacheStable({ posts: { every: { views: { gte: 5 } } } }, { posts: { every: { views: { gte: 50 } } } });
  });
});

describe('key-walk: mixed orderBy shapes compile stably under the cache', () => {
  it('orderBy direction variants share a fingerprint and compile identically', () => {
    // Same shape (single column, desc), different where values.
    const warm = { where: { age: 1 }, orderBy: { score: 'desc' } };
    const hit = { where: { age: 9 }, orderBy: { score: 'desc' } };
    const q = makeQuery('users', schema());
    q.buildFindMany(warm as never);
    const hot = q.buildFindMany(hit as never);
    const cold = fresh(hit);
    assert.equal(hot.sql, cold.sql);
    assert.deepEqual(hot.params, cold.params);
  });

  it('orderBy spec object vs bare direction produce distinct compiles', () => {
    const a = fresh({ where: { age: 1 }, orderBy: { score: 'asc' } });
    const b = fresh({ where: { age: 1 }, orderBy: { score: { sort: 'asc', nulls: 'last' } } });
    assert.notEqual(a.sql, b.sql, 'nulls-last spec must not share SQL with a bare direction');
  });
});

describe('key-walk: distinct shapes do NOT collide on one fingerprint', () => {
  it('operator vs equality differ', () => {
    assert.notEqual(fp({ age: 1 }), fp({ age: { gt: 1 } }));
  });
  it('null vs value differ', () => {
    assert.notEqual(fp({ name: null }), fp({ name: 'x' }));
  });
  it('OR vs AND differ', () => {
    assert.notEqual(fp({ OR: [{ age: 1 }] }), fp({ AND: [{ age: 1 }] }));
  });
  it('different json range value KINDS differ (numeric cast vs text)', () => {
    assert.notEqual(fp({ meta: { path: ['n'], gt: 5 } }), fp({ meta: { path: ['n'], gt: 'five' } }));
  });
  it('relation some vs none differ', () => {
    assert.notEqual(fp({ posts: { some: { published: true } } }), fp({ posts: { none: { published: true } } }));
  });
  it('a column-ref operand vs a literal differ', () => {
    const q = makeQuery('users', schema()) as unknown as QueryInterface<Record<string, unknown>>;
    const ref = q.fingerprintWhere({ age: { equals: { col: 'score' } } } as never);
    const lit = q.fingerprintWhere({ age: { equals: 5 } } as never);
    assert.notEqual(ref, lit);
  });
});
