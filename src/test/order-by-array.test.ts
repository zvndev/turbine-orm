/**
 * turbine-orm: Prisma-style ARRAY orderBy + groupBy limit/offset
 *
 * Build-only SQL assertions (no DB). Covers the array form of orderBy
 * (`[{ a: 'asc' }, { b: 'desc' }]`) at every surface that accepts an orderBy
 * (top-level findMany, a `with` relation subquery, and groupBy), the fact that
 * array element order is authoritative (independent of object key iteration
 * order), that array orderBy stays in lockstep across the SQL-cache
 * fingerprint / build / collect paths, and the new groupBy `limit`/`offset`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
          { name: 'name', field: 'name', pgType: 'text' },
          { name: 'last_login_at', field: 'lastLoginAt', pgType: 'timestamptz' },
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
      ),
      posts: mockTable('posts', [
        { name: 'id', field: 'id' },
        { name: 'user_id', field: 'userId' },
        { name: 'title', field: 'title', pgType: 'text' },
        { name: 'created_at', field: 'createdAt', pgType: 'timestamptz' },
      ]),
    },
  };
}

describe('array orderBy: top-level findMany', () => {
  it('compiles a multi-key array in array order', () => {
    const q = makeQuery('users', schema());
    const { sql } = q.buildFindMany({ orderBy: [{ name: 'asc' }, { lastLoginAt: 'desc' }] } as never);
    assert.match(sql, /ORDER BY "name" ASC, "last_login_at" DESC/);
  });

  it('array element order is authoritative (swapping order swaps the SQL)', () => {
    const q = makeQuery('users', schema());
    const { sql } = q.buildFindMany({ orderBy: [{ lastLoginAt: 'desc' }, { name: 'asc' }] } as never);
    assert.match(sql, /ORDER BY "last_login_at" DESC, "name" ASC/);
  });

  it('a single-key array equals the single-object form byte-for-byte', () => {
    const q = makeQuery('users', schema());
    const arr = q.buildFindMany({ orderBy: [{ name: 'desc' }] } as never);
    const obj = q.buildFindMany({ orderBy: { name: 'desc' } } as never);
    assert.equal(arr.sql, obj.sql);
  });

  it('array elements may carry the { sort, nulls } spec form', () => {
    const q = makeQuery('users', schema());
    const { sql } = q.buildFindMany({
      orderBy: [{ name: 'asc' }, { lastLoginAt: { sort: 'desc', nulls: 'last' } }],
    } as never);
    assert.match(sql, /ORDER BY "name" ASC, "last_login_at" DESC NULLS LAST/);
  });

  it('a multi-key element inside the array expands left-to-right', () => {
    const q = makeQuery('users', schema());
    const { sql } = q.buildFindMany({ orderBy: [{ name: 'asc', lastLoginAt: 'desc' }] } as never);
    assert.match(sql, /ORDER BY "name" ASC, "last_login_at" DESC/);
  });
});

describe('array orderBy: cursor seek direction', () => {
  it('resolves the seek direction per field from the array form', () => {
    const q = makeQuery('users', schema());
    const { sql, params } = q.buildFindMany({
      cursor: { id: 100 },
      orderBy: [{ id: 'desc' }],
    } as never);
    assert.match(sql, /"users"\."id" < \$1/);
    assert.match(sql, /ORDER BY "id" DESC/);
    assert.deepEqual(params, [100]);
  });
});

describe('array orderBy: relation with subquery', () => {
  it('compiles an array orderBy inside a hasMany inner subquery', () => {
    const q = makeQuery('users', schema());
    const { sql } = q.buildFindMany({
      with: { posts: { orderBy: [{ title: 'asc' }, { createdAt: 'desc' }] } },
    } as never);
    assert.match(sql, /ORDER BY t\d+\."title" ASC, t\d+\."created_at" DESC/);
  });
});

describe('array orderBy: groupBy', () => {
  it('orders the result groups by an array orderBy', () => {
    const q = makeQuery('users', schema());
    const { sql } = q.buildGroupBy({
      by: ['name'],
      _count: true,
      orderBy: [{ _count: 'desc' }, { name: 'asc' }],
    } as never);
    assert.match(sql, /ORDER BY COUNT\(\*\) DESC, "name" ASC/);
  });
});

describe('array orderBy: SQL cache lockstep', () => {
  it('identical array inputs hit the cache (fingerprint/build/collect stay in lockstep)', () => {
    const q = makeQuery('users', schema());
    const args = { where: { name: 'x' }, orderBy: [{ name: 'asc' }, { lastLoginAt: 'desc' }] } as never;
    // First build is a miss; the second is a HIT. The dev-mode cross-check runs
    // on the hit and throws if the array's build and collect paths desynced,
    // so a clean second call with equal params proves lockstep.
    const first = q.buildFindMany(args);
    const second = q.buildFindMany(args);
    assert.equal(first.sql, second.sql);
    assert.deepEqual(first.params, second.params);
    const stats = q.cacheStats();
    assert.equal(stats.hits, 1, 'second identical array build should be a cache hit');
  });

  it('a permuted array is a DISTINCT cache key (array order participates in the fingerprint)', () => {
    const q = makeQuery('users', schema());
    q.buildFindMany({ orderBy: [{ name: 'asc' }, { lastLoginAt: 'desc' }] } as never);
    q.buildFindMany({ orderBy: [{ lastLoginAt: 'desc' }, { name: 'asc' }] } as never);
    const stats = q.cacheStats();
    assert.equal(stats.hits, 0, 'a permuted array must not collapse onto the same cache entry');
    assert.equal(stats.misses, 2);
  });
});

describe('groupBy limit / offset', () => {
  it('appends LIMIT and OFFSET after ORDER BY, params last', () => {
    const q = makeQuery('users', schema());
    const { sql, params } = q.buildGroupBy({
      by: ['name'],
      _count: true,
      orderBy: { _count: 'desc' },
      limit: 5,
      offset: 2,
    } as never);
    assert.match(sql, /ORDER BY COUNT\(\*\) DESC LIMIT \$1 OFFSET \$2/);
    assert.deepEqual(params, [5, 2]);
  });

  it('supports limit alone', () => {
    const q = makeQuery('users', schema());
    const { sql, params } = q.buildGroupBy({ by: ['name'], limit: 3 } as never);
    assert.match(sql, /LIMIT \$1/);
    assert.doesNotMatch(sql, /OFFSET/);
    assert.deepEqual(params, [3]);
  });

  it('supports offset alone', () => {
    const q = makeQuery('users', schema());
    const { sql, params } = q.buildGroupBy({ by: ['name'], offset: 4 } as never);
    assert.match(sql, /OFFSET \$1/);
    assert.doesNotMatch(sql, /LIMIT/);
    assert.deepEqual(params, [4]);
  });

  it('limit/offset params follow WHERE + ORDER-BY-json params', () => {
    const q = makeQuery('users', schema());
    const { sql, params } = q.buildGroupBy({
      by: ['name'],
      where: { name: 'a' },
      _count: true,
      orderBy: { _count: 'desc' },
      limit: 10,
    } as never);
    // WHERE binds $1, LIMIT binds $2 (appended last).
    assert.match(sql, /LIMIT \$2/);
    assert.deepEqual(params, ['a', 10]);
  });

  it('no limit/offset emits neither clause (byte-identical to before)', () => {
    const q = makeQuery('users', schema());
    const { sql } = q.buildGroupBy({ by: ['name'], _count: true } as never);
    assert.doesNotMatch(sql, /LIMIT|OFFSET/);
  });
});
