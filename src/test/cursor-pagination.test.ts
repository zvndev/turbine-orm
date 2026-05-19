/**
 * turbine-orm — Cursor-based pagination tests
 *
 * Verifies the cursor implementation in query/builder.ts buildFindMany():
 *   1. cursor + asc order -> WHERE "id" > $N
 *   2. cursor + desc order -> WHERE "id" < $N
 *   3. cursor + existing where -> both conditions combined
 *   4. cursor with multiple fields
 *   5. take maps to LIMIT
 *   6. cursor without orderBy defaults to asc (> operator)
 *   7. Param ordering: where params, cursor params, limit params
 *
 * Build-only tests (no DB) — uses makeQuery() from helpers.
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

  // 4. cursor with multiple fields
  it('cursor with multiple fields generates multiple conditions', () => {
    const q = makeQuery('posts', buildSchema());
    const deferred = q.buildFindMany({
      cursor: { id: 10, createdAt: '2026-01-01' },
      orderBy: { id: 'asc', createdAt: 'desc' },
    });
    assert.match(deferred.sql, /"posts"\."id" > \$1/);
    assert.match(deferred.sql, /"posts"\."created_at" < \$2/);
    assert.deepEqual(deferred.params, [10, '2026-01-01']);
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
