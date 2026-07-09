/**
 * turbine-orm — NULLS FIRST / NULLS LAST ordering (WS-A / A1)
 *
 * Build-only SQL assertions (no DB) for the `OrderBySpec` (`{ sort, nulls }`)
 * form of orderBy values. Covers every place an OrderByClause is compiled:
 * top-level findMany (also the stream path, which shares buildFindMany's ORDER
 * BY), groupBy, and the inner subquery of a `with` relation. Plain
 * `'asc' | 'desc'` directions must stay byte-identical to the pre-A1 output.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
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

describe('orderBy NULLS FIRST / LAST', () => {
  it('emits DESC NULLS LAST for { sort, nulls }', () => {
    const q = makeQuery('users', schema());
    const { sql, params } = q.buildFindMany({ orderBy: { lastLoginAt: { sort: 'desc', nulls: 'last' } } } as never);
    assert.match(sql, /ORDER BY "last_login_at" DESC NULLS LAST/);
    assert.deepEqual(params, [], 'nulls placement adds no bound params');
  });

  it('emits ASC NULLS FIRST', () => {
    const q = makeQuery('users', schema());
    const { sql } = q.buildFindMany({ orderBy: { lastLoginAt: { sort: 'asc', nulls: 'first' } } } as never);
    assert.match(sql, /ORDER BY "last_login_at" ASC NULLS FIRST/);
  });

  it('leaves a plain direction unchanged (no NULLS clause)', () => {
    const q = makeQuery('users', schema());
    const { sql } = q.buildFindMany({ orderBy: { name: 'desc' } } as never);
    assert.match(sql, /ORDER BY "name" DESC/);
    assert.doesNotMatch(sql, /NULLS/);
  });

  it('spec without nulls is just the direction', () => {
    const q = makeQuery('users', schema());
    const { sql } = q.buildFindMany({ orderBy: { name: { sort: 'asc' } } } as never);
    assert.match(sql, /ORDER BY "name" ASC/);
    assert.doesNotMatch(sql, /NULLS/);
  });

  it('mixes plain and spec entries in order', () => {
    const q = makeQuery('users', schema());
    const { sql } = q.buildFindMany({
      orderBy: { name: 'asc', lastLoginAt: { sort: 'desc', nulls: 'last' } },
    } as never);
    assert.match(sql, /ORDER BY "name" ASC, "last_login_at" DESC NULLS LAST/);
  });

  it('still validates unknown fields (E003) with a spec value', () => {
    const q = makeQuery('users', schema());
    assert.throws(
      () => q.buildFindMany({ orderBy: { bogus: { sort: 'asc', nulls: 'last' } } } as never),
      ValidationError,
    );
  });

  it('applies nulls placement inside a groupBy orderBy', () => {
    const q = makeQuery('users', schema());
    const { sql } = q.buildGroupBy({
      by: ['name'],
      orderBy: { name: { sort: 'desc', nulls: 'last' } },
    } as never);
    assert.match(sql, /ORDER BY "name" DESC NULLS LAST/);
  });

  it('applies nulls placement inside a with-relation inner subquery', () => {
    const q = makeQuery('users', schema());
    const { sql } = q.buildFindMany({
      with: { posts: { orderBy: { createdAt: { sort: 'desc', nulls: 'last' } } } },
    } as never);
    // hasMany with orderBy wraps in an inner subquery; the ORDER BY there carries NULLS.
    assert.match(sql, /ORDER BY t\d+\."created_at" DESC NULLS LAST/);
  });
});
