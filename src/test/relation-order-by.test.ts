/**
 * turbine-orm — relation orderBy (WS-A / A3)
 *
 * Build-only SQL assertions for ordering a findMany by a related count
 * (`{ posts: { _count: 'desc' } }`, to-many → correlated COUNT(*) subquery) or a
 * to-one target column (`{ author: { name: 'asc' } }` → correlated scalar
 * subquery, OrderBySpec nulls supported). All relation-ordering subqueries push
 * NO bound params.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RelationError, ValidationError } from '../errors.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

function assertNoParams(sql: string, params: unknown[]): void {
  assert.deepEqual(params, [], `relation ordering must add no params: ${sql}`);
}

function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      users: mockTable(
        'users',
        [
          { name: 'id', field: 'id' },
          { name: 'name', field: 'name', pgType: 'text' },
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
          orgs: {
            type: 'manyToMany',
            name: 'orgs',
            from: 'users',
            to: 'orgs',
            foreignKey: 'id',
            referenceKey: 'id',
            through: { table: 'user_orgs', sourceKey: 'user_id', targetKey: 'org_id' },
          },
        },
      ),
      posts: mockTable(
        'posts',
        [
          { name: 'id', field: 'id' },
          { name: 'author_id', field: 'authorId' },
          { name: 'title', field: 'title', pgType: 'text' },
        ],
        {
          author: {
            type: 'belongsTo',
            name: 'author',
            from: 'posts',
            to: 'users',
            foreignKey: 'author_id',
            referenceKey: 'id',
          },
        },
      ),
      profiles: mockTable('profiles', [
        { name: 'id', field: 'id' },
        { name: 'user_id', field: 'userId' },
        { name: 'bio', field: 'bio', pgType: 'text' },
      ]),
      orgs: mockTable('orgs', [
        { name: 'id', field: 'id' },
        { name: 'name', field: 'name', pgType: 'text' },
      ]),
      user_orgs: mockTable('user_orgs', [
        { name: 'user_id', field: 'userId' },
        { name: 'org_id', field: 'orgId' },
      ]),
    },
  };
}

describe('relation orderBy — to-many _count', () => {
  it('hasMany _count → correlated COUNT(*) subquery', () => {
    const q = makeQuery('users', schema());
    const { sql, params } = q.buildFindMany({ orderBy: { posts: { _count: 'desc' } } } as never);
    assert.match(
      sql,
      /ORDER BY \(SELECT COUNT\(\*\)::int FROM "posts" ord\d+ WHERE ord\d+\."user_id" = "users"\."id"\) DESC/,
    );
    assertNoParams(sql, params);
  });

  it('m2m _count → COUNT(*) over the junction', () => {
    const q = makeQuery('users', schema());
    const { sql } = q.buildFindMany({ orderBy: { orgs: { _count: 'asc' } } } as never);
    assert.match(
      sql,
      /ORDER BY \(SELECT COUNT\(\*\)::int FROM "user_orgs" ord\d+j WHERE ord\d+j\."user_id" = "users"\."id"\) ASC/,
    );
  });

  it('rejects a non-_count key on a to-many relation (E003)', () => {
    const q = makeQuery('users', schema());
    assert.throws(() => q.buildFindMany({ orderBy: { posts: { title: 'asc' } } } as never), ValidationError);
  });
});

describe('relation orderBy — to-one column', () => {
  it('belongsTo column → correlated scalar subquery', () => {
    const q = makeQuery('posts', schema());
    const { sql, params } = q.buildFindMany({ orderBy: { author: { name: 'asc' } } } as never);
    assert.match(
      sql,
      /ORDER BY \(SELECT ord\d+\."name" FROM "users" ord\d+ WHERE ord\d+\."id" = "posts"\."author_id" LIMIT 1\) ASC/,
    );
    assertNoParams(sql, params);
  });

  it('supports OrderBySpec nulls on the to-one column', () => {
    const q = makeQuery('posts', schema());
    const { sql } = q.buildFindMany({ orderBy: { author: { name: { sort: 'desc', nulls: 'last' } } } } as never);
    assert.match(sql, /LIMIT 1\) DESC NULLS LAST/);
  });

  it('rejects an unknown target column (E003)', () => {
    const q = makeQuery('posts', schema());
    assert.throws(() => q.buildFindMany({ orderBy: { author: { bogus: 'asc' } } } as never), ValidationError);
  });
});

describe('relation orderBy — validation & mixing', () => {
  it('throws RelationError (E005) for an unknown relation', () => {
    const q = makeQuery('users', schema());
    assert.throws(() => q.buildFindMany({ orderBy: { bogus: { _count: 'desc' } } } as never), RelationError);
  });

  it('mixes a scalar column and a relation ordering', () => {
    const q = makeQuery('users', schema());
    const { sql, params } = q.buildFindMany({ orderBy: { name: 'asc', posts: { _count: 'desc' } } } as never);
    assert.match(sql, /ORDER BY "name" ASC, \(SELECT COUNT\(\*\)::int FROM "posts"/);
    assertNoParams(sql, params);
  });
});
