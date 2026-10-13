/**
 * turbine-orm: `globalFilters` is checked against the schema at construction.
 *
 * A global filter is a tenancy or soft-delete boundary, so one that silently
 * applies to nothing returns exactly the rows it was meant to hide. The client
 * accessor spelling of a multi-word table (`blogPosts` for `blog_posts`, the
 * spelling the config docs show) applies, and a key naming no table, or a
 * static filter naming no column, is refused with E003 and the closest valid
 * name. Every engine factory builds a TurbineClient, so the check covers them
 * too (SQLite exercised here, when `node:sqlite` exists).
 *
 * Build-only: no database.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { type PgCompatPool, TurbineClient } from '../client.js';
import { ValidationError } from '../errors.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable, skipGate } from './helpers.js';

const hasNodeSqlite = (() => {
  try {
    createRequire(process.cwd())('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();
const sqlite = skipGate(!hasNodeSqlite, 'turbine-orm/sqlite requires node:sqlite (Node >= 22.5)');

function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      blog_posts: mockTable(
        'blog_posts',
        [
          { name: 'id', field: 'id' },
          { name: 'tenant_id', field: 'tenantId', pgType: 'text' },
          { name: 'deleted_at', field: 'deletedAt', pgType: 'timestamptz' },
          { name: 'author_id', field: 'authorId' },
        ],
        {
          author: {
            type: 'belongsTo',
            name: 'author',
            from: 'blog_posts',
            to: 'users',
            foreignKey: 'author_id',
            referenceKey: 'id',
          },
        },
      ),
      users: mockTable('users', [
        { name: 'id', field: 'id' },
        { name: 'tenant_id', field: 'tenantId', pgType: 'text' },
      ]),
    },
  };
}

/** An external pool that is never queried: these tests only build SQL. */
const pool = {
  query: async () => {
    throw new Error('not queried');
  },
  connect: async () => {
    throw new Error('not queried');
  },
  end: async () => {},
} as unknown as PgCompatPool;

function client(globalFilters: unknown): TurbineClient {
  return new TurbineClient({ pool, globalFilters: globalFilters as never }, schema());
}

function refused(pattern: RegExp) {
  return (err: unknown): boolean => {
    assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
    assert.equal(err.code, 'TURBINE_E003');
    assert.match(err.message, pattern, err.message);
    return true;
  };
}

describe('globalFilters: keys are checked against the schema at construction', () => {
  it('the client accessor spelling of a multi-word table applies the filter', () => {
    const db = client({ blogPosts: { deletedAt: null } });
    const { sql } = db.table('blog_posts').buildFindMany();
    assert.match(sql, /"deleted_at" IS NULL/, sql);
  });

  it('the table-name spelling still applies, and an unfiltered table is unaffected', () => {
    const db = client({ blog_posts: () => ({ tenantId: 't1' }) });
    assert.match(db.table('blog_posts').buildFindMany().sql, /"tenant_id" = \$1/);
    assert.doesNotMatch(db.table('users').buildFindMany().sql, /tenant_id"? =/);
  });

  it('a key naming no table is refused with the closest table', () => {
    assert.throws(() => client({ blogPost: { deletedAt: null } }), refused(/"blogPost" names no table.*"blogPosts"/s));
    assert.throws(() => client({ orders: { deletedAt: null } }), refused(/"orders" names no table/));
  });

  it('two keys for one table are refused', () => {
    assert.throws(
      () => client({ blog_posts: { deletedAt: null }, blogPosts: { tenantId: 't' } }),
      refused(/"blog_posts" and "blogPosts" both name table "blog_posts"/),
    );
  });

  it('a static filter naming no column or relation is refused with the closest field', () => {
    assert.throws(
      () => client({ users: { tenantID: 't1' } }),
      refused(/"tenantID" is not a column or relation of "users". Did you mean "tenantId"/),
    );
    assert.throws(
      () => client({ blogPosts: { OR: [{ deletedAt: null }, { deletdAt: null }] } }),
      refused(/"OR\[1\]\.deletdAt" is not a column/),
    );
  });

  it('columns by either spelling, relations, and combinators are accepted', () => {
    assert.doesNotThrow(() =>
      client({
        blogPosts: { tenant_id: 't', author: { tenantId: 't' }, AND: [{ deletedAt: null }], NOT: { authorId: 3 } },
      }),
    );
  });

  it('a value that is not a where object or a function is refused; null means no filter', () => {
    assert.throws(() => client({ users: undefined }), refused(/must be a where object or a function.*undefined/s));
    assert.throws(() => client({ users: 'tenant_id = 1' }), refused(/received string/));
    assert.throws(() => client({ users: [{ tenantId: 't' }] }), refused(/received an array/));
    assert.throws(() => client([{ users: {} }]), refused(/must be an object keyed by table/));
    assert.doesNotThrow(() => client({ users: null }));
  });

  sqlite.it('engine factories get the same check', async () => {
    const { turbineSqlite } = await import('../sqlite.js');
    assert.throws(
      () => turbineSqlite(':memory:', schema(), { globalFilters: { blogPost: { deletedAt: null } } }),
      refused(/"blogPost" names no table/),
    );
  });
});
