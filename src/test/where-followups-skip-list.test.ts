/**
 * `skipGlobalFilters: [UNSAFE, ...names]` names tables the way `globalFilters`
 * keys do: by table name (`blog_posts`) or by client accessor (`blogPosts`).
 *
 *   - An accessor entry skips that table's filter, at the top level, in a
 *     relation `with` and in a relation filter.
 *   - An entry that names no table is refused (E003) with the closest name,
 *     on a cold build and on a warm cache entry alike, whether or not any
 *     global filter is configured: a misspelled entry would skip nothing.
 *
 * Build-only (no database). PowDB runs the same resolver; its half is in
 * powdb-parity-differential.test.ts.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import { type QueryInterfaceOptions, UNSAFE } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      users: mockTable('users', [{ name: 'id', field: 'id' }], {
        blogPosts: {
          name: 'blogPosts',
          type: 'hasMany',
          from: 'users',
          to: 'blog_posts',
          foreignKey: 'user_id',
          referenceKey: 'id',
        },
      }),
      blog_posts: mockTable('blog_posts', [
        { name: 'id', field: 'id' },
        { name: 'user_id', field: 'userId' },
        { name: 'deleted_at', field: 'deletedAt', pgType: 'timestamptz' },
      ]),
    },
  };
}

const softDelete = { globalFilters: { blog_posts: { deletedAt: null } } } as QueryInterfaceOptions;

describe('skipGlobalFilters names a table by table name or accessor', () => {
  it('the filter applies without a skip (premise)', () => {
    const { sql } = makeQuery('blog_posts', schema(), softDelete).buildFindMany({});
    assert.match(sql, /"deleted_at" IS NULL/);
  });

  for (const name of ['blog_posts', 'blogPosts']) {
    it(`"${name}" skips the filter on the table itself`, () => {
      const { sql } = makeQuery('blog_posts', schema(), softDelete).buildFindMany({
        skipGlobalFilters: [UNSAFE, name],
      } as never);
      assert.doesNotMatch(sql, /"deleted_at" IS NULL/);
    });

    it(`"${name}" skips the filter in a relation with and a relation filter`, () => {
      const q = makeQuery('users', schema(), softDelete);
      const kept = q.buildFindMany({ with: { blogPosts: true }, where: { blogPosts: { some: {} } } } as never);
      assert.equal(kept.sql.match(/"deleted_at" IS NULL/g)?.length, 2, 'premise: both relation paths carry it');
      const skipped = q.buildFindMany({
        with: { blogPosts: true },
        where: { blogPosts: { some: {} } },
        skipGlobalFilters: [UNSAFE, name],
      } as never);
      assert.doesNotMatch(skipped.sql, /"deleted_at" IS NULL/);
    });
  }
});

describe('a skipGlobalFilters entry that names no table is refused', () => {
  const refused = (fn: () => unknown) =>
    assert.throws(fn, (err: unknown) => {
      assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
      assert.match(err.message, /skipGlobalFilters names "blogPost", which is not a table/);
      assert.match(err.message, /Did you mean "blogPosts"\?/);
      return true;
    });

  it('on a cold build', () => {
    const q = makeQuery('blog_posts', schema(), softDelete);
    refused(() => q.buildFindMany({ skipGlobalFilters: [UNSAFE, 'blogPost'] } as never));
  });

  it('on a warm cache entry', () => {
    const q = makeQuery('blog_posts', schema(), softDelete);
    q.buildFindMany({ where: { id: 1 } } as never);
    q.buildFindMany({ where: { id: 2 } } as never);
    assert.equal(q.cacheStats().hits, 1, 'premise: the shape is cached');
    refused(() => q.buildFindMany({ where: { id: 3 }, skipGlobalFilters: [UNSAFE, 'blogPost'] } as never));
  });

  it('on a table with no filter of its own, and on a client with no global filters', () => {
    refused(() =>
      makeQuery('users', schema(), softDelete).buildFindMany({ skipGlobalFilters: [UNSAFE, 'blogPost'] } as never),
    );
    refused(() => makeQuery('users', schema()).buildFindMany({ skipGlobalFilters: [UNSAFE, 'blogPost'] } as never));
  });

  it('on writes, count and aggregates', () => {
    const q = makeQuery('blog_posts', schema(), softDelete);
    const skip = { skipGlobalFilters: [UNSAFE, 'blogPost'] };
    refused(() => q.buildCount(skip as never));
    refused(() => q.buildUpdateMany({ where: { id: 1 }, data: { userId: 2 }, ...skip } as never));
    refused(() => q.buildDeleteMany({ where: { id: 1 }, ...skip } as never));
    refused(() => q.buildAggregate({ _count: true, ...skip } as never));
  });
});
