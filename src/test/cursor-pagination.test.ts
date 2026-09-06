/**
 * turbine-orm, Cursor-based pagination tests
 *
 * Verifies the cursor implementation in query/builder.ts buildFindMany():
 *   1. cursor + asc order -> WHERE "id" > $N
 *   2. cursor + desc order -> WHERE "id" < $N
 *   3. cursor + existing where -> both conditions combined
 *   4. cursor with multiple fields -> expanded keyset predicate in orderBy order
 *   5. take maps to LIMIT
 *   6. cursor without orderBy defaults to asc (> operator)
 *   7. Param ordering: where params, cursor params, limit params
 *
 * Build-only tests (no DB), uses makeQuery() from helpers.
 *
 * Run: npx tsx --test src/test/cursor-pagination.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

function buildSchema(): SchemaMetadata {
  const tables: Record<string, TableMetadata> = {};
  tables.posts = mockTable('posts', [
    { name: 'id', field: 'id' },
    { name: 'title', field: 'title', pgType: 'text' },
    { name: 'created_at', field: 'createdAt', pgType: 'timestamptz' },
    { name: 'author_id', field: 'authorId', pgType: 'int8' },
  ]);
  return { tables, enums: {} };
}

describe('cursor pagination: SQL build (no DB)', () => {
  // 1. cursor + asc order -> WHERE "id" > $N
  it('cursor + asc order produces WHERE "id" > $N', () => {
    const q = makeQuery('posts', buildSchema());
    const deferred = q.buildFindMany({
      cursor: { id: 10 },
      orderBy: { id: 'asc' },
    });
    assert.match(deferred.sql, /WHERE "posts"\."id" > \$1/);
    assert.deepEqual(deferred.params, [10]);
  });

  // 2. cursor + desc order -> WHERE "id" < $N
  it('cursor + desc order produces WHERE "id" < $N', () => {
    const q = makeQuery('posts', buildSchema());
    const deferred = q.buildFindMany({
      cursor: { id: 50 },
      orderBy: { id: 'desc' },
    });
    assert.match(deferred.sql, /WHERE "posts"\."id" < \$1/);
    assert.deepEqual(deferred.params, [50]);
  });

  // 3. cursor + existing where -> both conditions combined
  it('cursor + existing where combines both conditions with AND', () => {
    const q = makeQuery('posts', buildSchema());
    const deferred = q.buildFindMany({
      where: { authorId: 5 },
      cursor: { id: 20 },
      orderBy: { id: 'asc' },
    });
    assert.match(deferred.sql, /WHERE/);
    assert.match(deferred.sql, /AND/);
    assert.match(deferred.sql, /"author_id" = \$1/);
    assert.match(deferred.sql, /"posts"\."id" > \$2/);
    assert.deepEqual(deferred.params, [5, 20]);
  });

  // 4. cursor with multiple fields is a KEYSET seek, not a conjunction.
  //    `a > $1 AND b > $2` skipped every row whose first key EQUALS the
  //    cursor's; the expanded keyset walks the same total order the ORDER BY
  //    declares. Field precedence follows the orderBy, each value binds once.
  it('cursor with multiple fields compiles the expanded keyset predicate in orderBy order', () => {
    const q = makeQuery('posts', buildSchema());
    const deferred = q.buildFindMany({
      cursor: { id: 10, createdAt: '2026-01-01' },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    assert.match(
      deferred.sql,
      /WHERE \("posts"\."created_at" < \$1 OR \("posts"\."created_at" = \$1 AND "posts"\."id" > \$2\)\)/,
    );
    assert.doesNotMatch(deferred.sql, /"created_at" < \$1 AND "posts"\."id"/, 'the conjunction form is gone');
    // Params follow the keyset (orderBy) order, not the alphabetical key order.
    assert.deepEqual(deferred.params, ['2026-01-01', 10]);
  });

  it('keyset precedence follows the orderBy even when it disagrees with the alphabetical key order', () => {
    const q = makeQuery('posts', buildSchema());
    const deferred = q.buildFindMany({
      cursor: { id: 239, authorId: 1 },
      orderBy: [{ id: 'asc' }, { authorId: 'asc' }],
    });
    assert.match(
      deferred.sql,
      /WHERE \("posts"\."id" > \$1 OR \("posts"\."id" = \$1 AND "posts"\."author_id" > \$2\)\)/,
    );
    assert.deepEqual(deferred.params, [239, 1]);
  });

  it('three cursor fields expand to three OR branches with a growing equality prefix', () => {
    const q = makeQuery('posts', buildSchema());
    const deferred = q.buildFindMany({
      cursor: { authorId: 1, createdAt: '2026-01-01', id: 5 },
      orderBy: [{ authorId: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }],
    });
    assert.match(
      deferred.sql,
      /WHERE \("posts"\."author_id" > \$1 OR \("posts"\."author_id" = \$1 AND "posts"\."created_at" < \$2\) OR \("posts"\."author_id" = \$1 AND "posts"\."created_at" = \$2 AND "posts"\."id" > \$3\)\)/,
    );
    assert.deepEqual(deferred.params, [1, '2026-01-01', 5]);
  });

  it('a multi-field keyset composes with an existing where inside its own parentheses', () => {
    const q = makeQuery('posts', buildSchema());
    const deferred = q.buildFindMany({
      where: { title: 'x' },
      cursor: { id: 10, authorId: 2 },
      orderBy: [{ authorId: 'asc' }, { id: 'asc' }],
    });
    assert.match(
      deferred.sql,
      /WHERE "title" = \$1 AND \("posts"\."author_id" > \$2 OR \("posts"\."author_id" = \$2 AND "posts"\."id" > \$3\)\)/,
    );
    assert.deepEqual(deferred.params, ['x', 2, 10]);
  });

  it('asc and desc cursors never share one cached template (direction is in the cache key)', () => {
    const q = makeQuery('posts', buildSchema());
    const asc = q.buildFindMany({ cursor: { id: 1, authorId: 1 }, orderBy: [{ authorId: 'asc' }, { id: 'asc' }] });
    const desc = q.buildFindMany({ cursor: { id: 1, authorId: 1 }, orderBy: [{ authorId: 'desc' }, { id: 'asc' }] });
    assert.notEqual(asc.sql, desc.sql);
    assert.match(asc.sql, /"author_id" > \$1/);
    assert.match(desc.sql, /"author_id" < \$1/);
  });

  it('a warm cache hit binds the same params in the same keyset order as the fresh build', () => {
    const q = makeQuery('posts', buildSchema());
    const orderBy: Record<string, 'asc' | 'desc'>[] = [{ authorId: 'desc' }, { id: 'asc' }];
    const first = q.buildFindMany({ cursor: { id: 7, authorId: 3 }, orderBy });
    const second = q.buildFindMany({ cursor: { id: 8, authorId: 4 }, orderBy });
    assert.equal(first.sql, second.sql, 'same shape, same template');
    assert.deepEqual(first.params, [3, 7]);
    assert.deepEqual(second.params, [4, 8]);
  });

  // 5. take maps to LIMIT
  it('take maps to LIMIT', () => {
    const q = makeQuery('posts', buildSchema());
    const deferred = q.buildFindMany({
      cursor: { id: 10 },
      orderBy: { id: 'asc' },
      take: 25,
    });
    assert.match(deferred.sql, /LIMIT \$2/);
    assert.deepEqual(deferred.params, [10, 25]);
  });

  // 6. cursor without orderBy defaults to asc (> operator)
  it('cursor without orderBy defaults to asc (> operator)', () => {
    const q = makeQuery('posts', buildSchema());
    const deferred = q.buildFindMany({
      cursor: { id: 30 },
    });
    assert.match(deferred.sql, /"posts"\."id" > \$1/);
    assert.deepEqual(deferred.params, [30]);
  });

  // 7. Param ordering: where params, cursor params, limit params
  it('param ordering: where, cursor, limit', () => {
    const q = makeQuery('posts', buildSchema());
    const deferred = q.buildFindMany({
      where: { authorId: 7 },
      cursor: { id: 100 },
      orderBy: { id: 'asc' },
      take: 10,
    });
    assert.deepEqual(deferred.params, [7, 100, 10]);
    assert.match(deferred.sql, /"author_id" = \$1/);
    assert.match(deferred.sql, /"posts"\."id" > \$2/);
    assert.match(deferred.sql, /LIMIT \$3/);
  });
});
