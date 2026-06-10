/**
 * turbine-orm — where-key-order cache regression suite
 *
 * The SQL template cache keys queries by a value-invariant FINGERPRINT that
 * sorts object keys (`fingerprintWhere`, `fingerprintAliasWhere`,
 * `fingerprintRelFilter`, `withFingerprint`, the findMany `cursorFp`). The
 * SQL-BUILD and cache-hit param-COLLECT paths must therefore enumerate keys
 * in the same sorted (canonical) order. Before this fix they iterated object
 * INSERTION order, so two where clauses with the same fields in different
 * key order shared one cache entry but pushed params in different orders:
 *
 *   findMany({ where: { age: 1, score: 2 } })   // warms cache: "age" = $1 AND "score" = $2
 *   findMany({ where: { score: 20, age: 10 } }) // cache hit:   params [20, 10]  ← age binds 20!
 *
 * Silent wrong rows — cross-tenant-leak class when the permuted fields are
 * same-typed columns like tenantId/userId. Array members (OR/AND) remain
 * positional; only object-key enumeration is canonicalized.
 *
 * Every test here builds the same logical query twice on ONE QueryInterface
 * (same SQL cache) with permuted key order, then asserts that each column's
 * placeholder binds the value supplied for that column on the SECOND call.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

/** Every $N referenced in the SQL must have a params entry and vice versa. */
function assertParamsAligned(sql: string, params: unknown[]): void {
  const referenced = new Set<number>();
  for (const m of sql.matchAll(/\$(\d+)/g)) {
    referenced.add(Number(m[1]));
  }
  const max = referenced.size ? Math.max(...referenced) : 0;
  assert.equal(max, params.length, `SQL references up to $${max} but got ${params.length} params: ${sql}`);
  for (let i = 1; i <= params.length; i++) {
    assert.ok(referenced.has(i), `param $${i} is never referenced in SQL — orphaned param: ${sql}`);
  }
}

/**
 * Resolve which value a column's comparison actually binds: find the first
 * `$N` after the given SQL pattern and return `params[N - 1]`.
 */
function boundValue(sql: string, params: unknown[], pattern: RegExp): unknown {
  const m = sql.match(pattern);
  assert.ok(m?.[1], `pattern ${pattern} not found in SQL: ${sql}`);
  return params[Number(m[1]) - 1];
}

function buildSchema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      users: mockTable(
        'users',
        [
          { name: 'id', field: 'id' },
          { name: 'age', field: 'age', pgType: 'int4' },
          { name: 'score', field: 'score', pgType: 'int4' },
          { name: 'tenant_id', field: 'tenantId' },
          { name: 'name', field: 'name', pgType: 'text' },
          { name: 'created_at', field: 'createdAt', pgType: 'timestamptz' },
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
          profile: {
            type: 'hasOne',
            name: 'profile',
            from: 'users',
            to: 'profiles',
            foreignKey: 'user_id',
            referenceKey: 'id',
          },
        },
      ),
      posts: mockTable(
        'posts',
        [
          { name: 'id', field: 'id' },
          { name: 'user_id', field: 'userId' },
          { name: 'title', field: 'title', pgType: 'text' },
          { name: 'view_count', field: 'viewCount', pgType: 'int4' },
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
        },
      ),
      profiles: mockTable('profiles', [
        { name: 'id', field: 'id' },
        { name: 'user_id', field: 'userId' },
        { name: 'bio', field: 'bio', pgType: 'text' },
      ]),
    },
  };
}

describe('where-key-order: cache fingerprint vs build/collect canonical order', () => {
  it('top-level where: permuted key order on a warmed cache binds each column its own value', () => {
    const q = makeQuery('users', buildSchema());

    // Warm the cache with one insertion order…
    const first = q.buildFindMany({ where: { age: 1, score: 2 } } as never);
    assertParamsAligned(first.sql, first.params);

    // …then issue the same shape with the keys swapped.
    const second = q.buildFindMany({ where: { score: 20, age: 10 } } as never);
    assert.equal(second.sql, first.sql, 'same shape must hit the same cache entry');
    assertParamsAligned(second.sql, second.params);

    assert.equal(boundValue(second.sql, second.params, /"age" = \$(\d+)/), 10, 'age must bind 10');
    assert.equal(boundValue(second.sql, second.params, /"score" = \$(\d+)/), 20, 'score must bind 20');
  });

  it('top-level where: tenantId/id permutation (the cross-tenant-leak class)', () => {
    const q = makeQuery('users', buildSchema());

    q.buildFindMany({ where: { tenantId: 7, id: 99 } } as never);
    const second = q.buildFindMany({ where: { id: 1, tenantId: 42 } } as never);
    assertParamsAligned(second.sql, second.params);

    assert.equal(boundValue(second.sql, second.params, /"tenant_id" = \$(\d+)/), 42);
    assert.equal(boundValue(second.sql, second.params, /"id" = \$(\d+)/), 1);
  });

  it('operator objects mixed with equality: permuted key order stays aligned', () => {
    const q = makeQuery('users', buildSchema());

    q.buildFindMany({ where: { age: { gt: 1 }, score: 2, name: { contains: 'a' } } } as never);
    const second = q.buildFindMany({
      where: { name: { contains: 'zed' }, score: 200, age: { gt: 100 } },
    } as never);
    assertParamsAligned(second.sql, second.params);

    assert.equal(boundValue(second.sql, second.params, /"age" > \$(\d+)/), 100);
    assert.equal(boundValue(second.sql, second.params, /"score" = \$(\d+)/), 200);
    assert.equal(boundValue(second.sql, second.params, /"name" LIKE \$(\d+)/), '%zed%');
  });

  it('OR/AND/NOT: combinator keys are canonicalized but array members stay positional', () => {
    const q = makeQuery('users', buildSchema());

    q.buildFindMany({
      where: { OR: [{ age: 1 }, { score: 2 }], NOT: { name: 'x' }, tenantId: 3 },
    } as never);
    const second = q.buildFindMany({
      where: { tenantId: 30, NOT: { name: 'spam' }, OR: [{ age: 10 }, { score: 20 }] },
    } as never);
    assertParamsAligned(second.sql, second.params);

    assert.equal(boundValue(second.sql, second.params, /NOT \("name" = \$(\d+)\)/), 'spam');
    assert.equal(boundValue(second.sql, second.params, /"tenant_id" = \$(\d+)/), 30);
    // OR array order is positional: first member is age, second is score.
    assert.equal(boundValue(second.sql, second.params, /"age" = \$(\d+)/), 10);
    assert.equal(boundValue(second.sql, second.params, /"score" = \$(\d+)/), 20);
  });

  it('relation filter (some/none sub-where): permuted sub-where keys stay aligned', () => {
    const q = makeQuery('users', buildSchema());

    q.buildFindMany({
      where: { posts: { some: { title: 'a', viewCount: 1 } }, age: 2 },
    } as never);
    const second = q.buildFindMany({
      where: { age: 20, posts: { some: { viewCount: 10, title: 'hot' } } },
    } as never);
    assertParamsAligned(second.sql, second.params);

    assert.equal(boundValue(second.sql, second.params, /"posts"\."title" = \$(\d+)/), 'hot');
    assert.equal(boundValue(second.sql, second.params, /"posts"\."view_count" = \$(\d+)/), 10);
    assert.equal(boundValue(second.sql, second.params, /"age" = \$(\d+)/), 20);
  });

  it('alias where (`with` options): permuted nested where keys stay aligned', () => {
    const q = makeQuery('users', buildSchema());

    q.buildFindMany({
      with: { posts: { where: { title: 'a', viewCount: { gt: 1 } } } },
    } as never);
    const second = q.buildFindMany({
      with: { posts: { where: { viewCount: { gt: 100 }, title: 'swapped' } } },
    } as never);
    assertParamsAligned(second.sql, second.params);

    assert.equal(boundValue(second.sql, second.params, /t0\."title" = \$(\d+)/), 'swapped');
    assert.equal(boundValue(second.sql, second.params, /t0\."view_count" > \$(\d+)/), 100);
  });

  it('alias where: OR/NOT combinators inside a relation where stay aligned when permuted', () => {
    const q = makeQuery('users', buildSchema());

    q.buildFindMany({
      with: {
        posts: {
          where: { NOT: { title: 'x' }, OR: [{ title: 'a' }, { viewCount: { gt: 1 } }] },
        },
      },
    } as never);
    const second = q.buildFindMany({
      with: {
        posts: {
          where: { OR: [{ title: 'b' }, { viewCount: { gt: 9 } }], NOT: { title: 'nope' } },
        },
      },
    } as never);
    assertParamsAligned(second.sql, second.params);

    assert.equal(boundValue(second.sql, second.params, /NOT \(t0\."title" = \$(\d+)\)/), 'nope');
    assert.equal(boundValue(second.sql, second.params, /\(\(t0\."title" = \$(\d+)\) OR/), 'b');
    assert.equal(boundValue(second.sql, second.params, /t0\."view_count" > \$(\d+)/), 9);
  });

  it('with clause: permuted relation-name order keeps each subquery bound to its own params', () => {
    const q = makeQuery('users', buildSchema());

    q.buildFindMany({
      with: {
        profile: { where: { bio: 'first' } },
        posts: { where: { title: 'warm' }, limit: 1 },
      },
    } as never);
    const second = q.buildFindMany({
      with: {
        posts: { where: { title: 'swapped-title' }, limit: 5 },
        profile: { where: { bio: 'swapped-bio' } },
      },
    } as never);
    assertParamsAligned(second.sql, second.params);

    // Relation aliases are allocated in canonical (sorted) relation order:
    // posts → t0(+t0i), profile → t1 — independent of insertion order.
    assert.equal(second.sql.indexOf('"posts"') < second.sql.indexOf('"profiles"'), true);
    const titleBind = boundValue(second.sql, second.params, /\."title" = \$(\d+)/);
    const bioBind = boundValue(second.sql, second.params, /\."bio" = \$(\d+)/);
    const limitBind = boundValue(second.sql, second.params, /LIMIT \$(\d+)/);
    assert.equal(titleBind, 'swapped-title');
    assert.equal(bioBind, 'swapped-bio');
    assert.equal(limitBind, 5);
  });

  it('nested with: deep relation where keys are canonicalized at every level', () => {
    const q = makeQuery('users', buildSchema());

    q.buildFindMany({
      where: { age: 1 },
      with: { posts: { with: { author: true }, where: { viewCount: { gt: 2 }, title: 't' } } },
    } as never);
    const second = q.buildFindMany({
      where: { age: 11 },
      with: { posts: { where: { title: 'deep', viewCount: { gt: 22 } }, with: { author: true } } },
    } as never);
    assertParamsAligned(second.sql, second.params);

    assert.equal(boundValue(second.sql, second.params, /"age" = \$(\d+)/), 11);
    assert.equal(boundValue(second.sql, second.params, /\."title" = \$(\d+)/), 'deep');
    assert.equal(boundValue(second.sql, second.params, /\."view_count" > \$(\d+)/), 22);
  });

  it('cursor: permuted cursor keys on a warmed cache bind each column its own value', () => {
    const q = makeQuery('posts', buildSchema());

    q.buildFindMany({
      cursor: { id: 1, viewCount: 2 },
      orderBy: { id: 'asc', viewCount: 'desc' },
    } as never);
    const second = q.buildFindMany({
      cursor: { viewCount: 20, id: 10 },
      orderBy: { id: 'asc', viewCount: 'desc' },
    } as never);
    assertParamsAligned(second.sql, second.params);

    assert.equal(boundValue(second.sql, second.params, /"posts"\."id" > \$(\d+)/), 10);
    assert.equal(boundValue(second.sql, second.params, /"posts"\."view_count" < \$(\d+)/), 20);
  });

  it('update/delete/count reuse the same canonical where order', () => {
    const q = makeQuery('users', buildSchema());

    // updateMany
    q.buildUpdateMany({ where: { age: 1, score: 2 }, data: { name: 'x' } } as never);
    const upd = q.buildUpdateMany({ where: { score: 20, age: 10 }, data: { name: 'y' } } as never);
    assertParamsAligned(upd.sql, upd.params);
    assert.equal(boundValue(upd.sql, upd.params, /"age" = \$(\d+)/), 10);
    assert.equal(boundValue(upd.sql, upd.params, /"score" = \$(\d+)/), 20);

    // deleteMany
    q.buildDeleteMany({ where: { age: 3, tenantId: 4 } } as never);
    const del = q.buildDeleteMany({ where: { tenantId: 40, age: 30 } } as never);
    assertParamsAligned(del.sql, del.params);
    assert.equal(boundValue(del.sql, del.params, /"age" = \$(\d+)/), 30);
    assert.equal(boundValue(del.sql, del.params, /"tenant_id" = \$(\d+)/), 40);

    // count
    q.buildCount({ where: { age: 5, score: 6 } } as never);
    const cnt = q.buildCount({ where: { score: 60, age: 50 } } as never);
    assertParamsAligned(cnt.sql, cnt.params);
    assert.equal(boundValue(cnt.sql, cnt.params, /"age" = \$(\d+)/), 50);
    assert.equal(boundValue(cnt.sql, cnt.params, /"score" = \$(\d+)/), 60);
  });

  it('findUnique simple path: permuted composite-key order binds each column its own value', () => {
    const q = makeQuery('users', buildSchema());

    // Warm the simple (plain-equality) path…
    const first = q.buildFindUnique({ where: { tenantId: 1, name: 'a@x.com' } } as never);
    assertParamsAligned(first.sql, first.params);

    // …then hit it with the keys swapped.
    const second = q.buildFindUnique({ where: { name: 'b@y.com', tenantId: 2 } } as never);
    assert.equal(second.sql, first.sql, 'same shape must hit the same cache entry');
    assertParamsAligned(second.sql, second.params);

    assert.equal(boundValue(second.sql, second.params, /"tenant_id" = \$(\d+)/), 2, 'tenant_id must bind 2');
    assert.equal(boundValue(second.sql, second.params, /"name" = \$(\d+)/), 'b@y.com', 'name must bind b@y.com');
  });

  it('findUnique general path (operator present): permuted key order stays aligned', () => {
    const q = makeQuery('users', buildSchema());

    q.buildFindUnique({ where: { tenantId: 7, age: { gt: 1 } } } as never);
    const second = q.buildFindUnique({ where: { age: { gt: 100 }, tenantId: 42 } } as never);
    assertParamsAligned(second.sql, second.params);

    assert.equal(boundValue(second.sql, second.params, /"tenant_id" = \$(\d+)/), 42);
    assert.equal(boundValue(second.sql, second.params, /"age" > \$(\d+)/), 100);
  });

  it('SQL generation is deterministic regardless of literal key order (no cache involved)', () => {
    // Two fresh QueryInterfaces (separate caches) must emit identical SQL for
    // permuted literals — canonical order, not first-writer-wins.
    const a = makeQuery('users', buildSchema());
    const b = makeQuery('users', buildSchema());

    const fromA = a.buildFindMany({ where: { score: 2, age: 1, name: 'n' } } as never);
    const fromB = b.buildFindMany({ where: { name: 'n', age: 1, score: 2 } } as never);
    assert.equal(fromA.sql, fromB.sql);
    assert.deepEqual(fromA.params, fromB.params);
  });
});
