/**
 * turbine-orm — `is` and `isNot` relation filter tests
 *
 * Build-only tests (no DB) that verify the `is` and `isNot` relation filters
 * generate correct EXISTS / NOT EXISTS SQL, matching Prisma's semantics for
 * to-one relations (belongsTo / hasOne).
 *
 * Run: npx tsx --test src/test/is-isNot-filter.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

function buildSchema(): SchemaMetadata {
  const tables: Record<string, TableMetadata> = {};

  tables.users = mockTable(
    'users',
    [
      { name: 'id', field: 'id' },
      { name: 'name', field: 'name', pgType: 'text' },
      { name: 'email', field: 'email', pgType: 'text' },
      { name: 'verified', field: 'verified', pgType: 'bool' },
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
  );

  tables.posts = mockTable(
    'posts',
    [
      { name: 'id', field: 'id' },
      { name: 'title', field: 'title', pgType: 'text' },
      { name: 'status', field: 'status', pgType: 'text' },
      { name: 'published', field: 'published', pgType: 'bool' },
      { name: 'user_id', field: 'userId', pgType: 'int8' },
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
  );

  tables.profiles = mockTable(
    'profiles',
    [
      { name: 'id', field: 'id' },
      { name: 'bio', field: 'bio', pgType: 'text' },
      { name: 'user_id', field: 'userId', pgType: 'int8' },
    ],
    {},
  );

  return { tables, enums: {} };
}

describe('is / isNot relation filters', () => {
  it('is filter generates EXISTS on belongsTo', () => {
    const q = makeQuery('posts', buildSchema());
    const deferred = q.buildFindMany({
      where: { author: { is: { name: 'Alice' } } } as never,
    });
    assert.match(deferred.sql, /EXISTS \(SELECT 1 FROM "users" WHERE/);
    assert.ok(!deferred.sql.includes('NOT EXISTS'), 'should not be NOT EXISTS');
    assert.deepStrictEqual(deferred.params, ['Alice']);
  });

  it('isNot filter generates NOT EXISTS on belongsTo', () => {
    const q = makeQuery('posts', buildSchema());
    const deferred = q.buildFindMany({
      where: { author: { isNot: { name: 'Alice' } } } as never,
    });
    assert.match(deferred.sql, /NOT EXISTS \(SELECT 1 FROM "users" WHERE/);
    assert.deepStrictEqual(deferred.params, ['Alice']);
  });

  it('is with multiple fields generates AND conditions in subquery', () => {
    const q = makeQuery('posts', buildSchema());
    const deferred = q.buildFindMany({
      where: { author: { is: { name: 'Alice', email: 'alice@test.com' } } } as never,
    });
    assert.match(deferred.sql, /EXISTS \(SELECT 1 FROM "users" WHERE/);
    assert.match(deferred.sql, /"name" = \$/);
    assert.match(deferred.sql, /"email" = \$/);
    assert.ok(deferred.params.includes('Alice'));
    assert.ok(deferred.params.includes('alice@test.com'));
  });

  it('is on hasOne relation works', () => {
    const q = makeQuery('users', buildSchema());
    const deferred = q.buildFindMany({
      where: { profile: { is: { bio: 'hello' } } } as never,
    });
    assert.match(deferred.sql, /EXISTS \(SELECT 1 FROM "profiles" WHERE/);
    assert.ok(!deferred.sql.includes('NOT EXISTS'), 'should not be NOT EXISTS');
    assert.deepStrictEqual(deferred.params, ['hello']);
  });

  it('is combined with other where conditions', () => {
    const q = makeQuery('posts', buildSchema());
    const deferred = q.buildFindMany({
      where: { status: 'active', author: { is: { verified: true } } } as never,
    });
    // Where keys bind in canonical (sorted) order: "author" sorts before "status".
    assert.match(deferred.sql, /"status" = \$2/);
    assert.match(deferred.sql, /EXISTS \(SELECT 1 FROM "users" WHERE/);
    assert.deepStrictEqual(deferred.params, [true, 'active']);
  });

  it('isNot combined with some on different relations', () => {
    const q = makeQuery('users', buildSchema());
    const deferred = q.buildFindMany({
      where: {
        posts: { some: { published: true } },
        profile: { isNot: { bio: 'empty' } },
      } as never,
    });
    assert.match(deferred.sql, /EXISTS \(SELECT 1 FROM "posts" WHERE/);
    assert.match(deferred.sql, /NOT EXISTS \(SELECT 1 FROM "profiles" WHERE/);
    assert.ok(deferred.params.includes(true));
    assert.ok(deferred.params.includes('empty'));
  });
});
