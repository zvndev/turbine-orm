/**
 * turbine-orm, to-one relation orderBy binds the same params on a cache hit as
 * on the build.
 *
 * Ordering by a to-one relation's column emits a correlated subquery that
 * carries the target table's global filter. A chained ordering
 * (`{ author: { org: { name } } }`) also carries the hop table's filter, in hop
 * order. The cache-hit param collector used to push one head-table filter per
 * column, so as soon as a hop table had a filter the warm statement bound too
 * few params (and the cold one in production, since params always come from
 * the collector), in the wrong order.
 *
 * Checked in production mode (no dev cross-check to mask it), cold and warm,
 * top level and inside a `with`.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: build-only tests drive untyped args
type Any = any;

function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      posts: mockTable(
        'posts',
        [
          { name: 'id', field: 'id' },
          { name: 'user_id', field: 'userId' },
          { name: 'tenant_id', field: 'tenantId', pgType: 'text' },
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
      users: mockTable(
        'users',
        [
          { name: 'id', field: 'id' },
          { name: 'org_id', field: 'orgId' },
          { name: 'name', field: 'name', pgType: 'text' },
          { name: 'tenant_id', field: 'tenantId', pgType: 'text' },
        ],
        {
          org: { type: 'belongsTo', name: 'org', from: 'users', to: 'orgs', foreignKey: 'org_id', referenceKey: 'id' },
          blogPosts: {
            type: 'hasMany',
            name: 'blogPosts',
            from: 'users',
            to: 'posts',
            foreignKey: 'user_id',
            referenceKey: 'id',
          },
        },
      ),
      orgs: mockTable(
        'orgs',
        [
          { name: 'id', field: 'id' },
          { name: 'name', field: 'name', pgType: 'text' },
          { name: 'tenant_id', field: 'tenantId', pgType: 'text' },
        ],
        {
          members: {
            type: 'hasMany',
            name: 'members',
            from: 'orgs',
            to: 'users',
            foreignKey: 'org_id',
            referenceKey: 'id',
          },
        },
      ),
    },
  };
}

/** Distinct values per table, so a param in the wrong slot is visible. */
const GLOBAL_FILTERS = {
  posts: { tenantId: 'posts-tenant' },
  users: { tenantId: 'users-tenant' },
  orgs: { tenantId: 'orgs-tenant' },
};

function highestPlaceholder(sql: string): number {
  return Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
}

/** The value bound to each `"tenant_id" = $n`, in statement text order. */
function boundTenants(sql: string, params: unknown[]): string[] {
  return [...sql.matchAll(/"tenant_id" = \$(\d+)/g)].map((m) => String(params[Number(m[1]) - 1]));
}

let prevEnv: string | undefined;
beforeEach(() => {
  prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
});
afterEach(() => {
  if (prevEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = prevEnv;
});

describe('to-one relation orderBy: cold and warm bind the params the SQL references', () => {
  const cases: [string, Record<string, unknown>, string[]][] = [
    ['one column', { author: { name: 'asc' } }, ['posts-tenant', 'users-tenant']],
    ['two columns', { author: { name: 'asc', id: 'desc' } }, ['posts-tenant', 'users-tenant', 'users-tenant']],
    // In statement text order: the posts WHERE, then the ordering subquery,
    // whose hop JOIN (orgs) is written before its head WHERE (users).
    ['chained through a hop', { author: { org: { name: 'asc' } } }, ['posts-tenant', 'orgs-tenant', 'users-tenant']],
    [
      'chained plus a head column',
      { author: { org: { name: 'asc' }, name: 'desc' } },
      ['posts-tenant', 'orgs-tenant', 'users-tenant', 'users-tenant'],
    ],
  ];
  for (const [label, orderBy, expected] of cases) {
    it(`top level, ${label}`, () => {
      const q = makeQuery('posts', schema(), { globalFilters: GLOBAL_FILTERS } as Any);
      const cold = q.buildFindMany({ orderBy } as Any);
      const warm = q.buildFindMany({ orderBy } as Any);
      assert.equal(warm.sql, cold.sql);
      for (const [which, built] of [
        ['cold', cold],
        ['warm', warm],
      ] as const) {
        assert.equal(built.params.length, highestPlaceholder(built.sql), `${which}: one param per placeholder`);
        assert.deepEqual(boundTenants(built.sql, built.params), expected, `${which}: each filter gets its own value`);
      }
    });
  }

  it('inside a `with`, a chained ordering on the relation rows', () => {
    const q = makeQuery('users', schema(), { globalFilters: GLOBAL_FILTERS } as Any);
    const args = { with: { blogPosts: { orderBy: { author: { org: { name: 'asc' } } } } } };
    const cold = q.buildFindMany(args as Any);
    const warm = q.buildFindMany(args as Any);
    assert.equal(warm.sql, cold.sql);
    for (const built of [cold, warm]) {
      assert.equal(built.params.length, highestPlaceholder(built.sql));
      assert.deepEqual(
        new Set(boundTenants(built.sql, built.params)),
        new Set(Object.values(GLOBAL_FILTERS).map((f) => f.tenantId)),
      );
    }
    assert.deepEqual(warm.params, cold.params);
  });

  it('inside a `with`, a relation ordering written in its snake_case spelling', () => {
    const q = makeQuery('orgs', schema(), { globalFilters: GLOBAL_FILTERS } as Any);
    // `blog_posts` resolves to the declared `blogPosts` relation.
    const args = { with: { members: { orderBy: { blog_posts: { _count: 'desc' } } } } };
    const cold = q.buildFindMany(args as Any);
    const warm = q.buildFindMany(args as Any);
    assert.equal(warm.sql, cold.sql);
    assert.match(cold.sql, /COUNT/);
    for (const built of [cold, warm]) {
      assert.equal(built.params.length, highestPlaceholder(built.sql));
      assert.deepEqual(
        new Set(boundTenants(built.sql, built.params)),
        new Set(Object.values(GLOBAL_FILTERS).map((f) => f.tenantId)),
      );
    }
    assert.deepEqual(warm.params, cold.params);
  });
});
