/**
 * turbine-orm: a static `globalFilters` entry whose combinator the query
 * compiler cannot read is refused when the client is constructed.
 *
 * A global filter is a tenancy or soft-delete boundary. `OR: { orgId }` (an
 * object where an array belongs) used to compile to no condition, so the
 * filter matched every row while looking configured. The construction check
 * now applies the compiler's own combinator-shape rule.
 *
 * Run: npx tsx --test src/test/client-v090-global-filters.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type PgCompatPool, TurbineClient } from '../client.js';
import { ValidationError } from '../errors.js';
import type { GlobalFilters } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { mockColumn, mockTable } from './helpers.js';

const schema: SchemaMetadata = {
  tables: {
    blog_posts: mockTable('blog_posts', [
      mockColumn('id', 'id', 'int4'),
      mockColumn('org_id', 'orgId', 'int4'),
      mockColumn('deleted_at', 'deletedAt', 'timestamptz'),
    ]),
  },
  enums: {},
};

const pool = {
  query: async () => ({ rows: [], rowCount: 0 }),
  connect: async () => {
    throw new Error('not used');
  },
  end: async () => {},
  on: () => {},
} as unknown as PgCompatPool;

const construct = (globalFilters: unknown) =>
  new TurbineClient({ pool, globalFilters: globalFilters as GlobalFilters }, schema);

function refused(at: string, pattern: RegExp) {
  return (err: unknown): boolean => {
    assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
    assert.match(
      err.message,
      new RegExp(`globalFilters\\["blogPosts"\\]: "${at.replace(/[[\]]/g, '\\$&')}" is refused`),
    );
    assert.match(err.message, pattern, err.message);
    assert.equal(err.message.match(/TURBINE_E003/g)?.length, 1, 'the code tag appears once');
    return true;
  };
}

describe('globalFilters: combinator shapes', () => {
  it('refuses OR written as an object, naming the fix', () => {
    assert.throws(
      () => construct({ blogPosts: { OR: { orgId: 1 } } }),
      refused('OR', /takes an array of where objects[\s\S]*Wrap the object in an array/),
    );
  });

  it('refuses a combinator holding a scalar or null, at any depth', () => {
    assert.throws(() => construct({ blogPosts: { AND: 'orgId = 1' } }), refused('AND', /received/));
    assert.throws(() => construct({ blogPosts: { NOT: null } }), refused('NOT', /received/));
    assert.throws(
      () => construct({ blogPosts: { AND: [{ OR: [{ orgId: 1 }, 7] }] } }),
      refused('AND[0].OR', /element 1 is/),
    );
  });

  it('accepts the shapes the compiler reads, and still checks the names inside them', () => {
    construct({ blogPosts: { OR: [{ orgId: 1 }, { deletedAt: null }] } });
    construct({ blogPosts: { AND: { orgId: 1 }, NOT: [{ deletedAt: { not: null } }] } });
    assert.throws(
      () => construct({ blogPosts: { OR: [{ orgID: 1 }] } }),
      /"OR\[0\]\.orgID" is not a column or relation/,
    );
  });

  it('leaves a function filter to the per-query check', () => {
    construct({ blogPosts: () => ({ OR: { orgId: 1 } }) });
  });
});

describe('globalFilters: entry shapes', () => {
  it('refuses a class instance where a plain where object belongs, naming its class', () => {
    class TenantWhere {
      orgId = 1;
    }
    assert.throws(
      () => construct({ blogPosts: new TenantWhere() }),
      (err: unknown) =>
        err instanceof ValidationError &&
        /globalFilters\["blogPosts"\] must be a where object.*an instance of TenantWhere, not a plain object/s.test(
          err.message,
        ),
    );
    assert.throws(
      () => construct(new Map([['blogPosts', { orgId: 1 }]])),
      (err: unknown) =>
        err instanceof ValidationError &&
        /globalFilters must be an object keyed by table.*an instance of Map/s.test(err.message),
    );
  });

  it('accepts a null-prototype filter object', () => {
    const filter = Object.assign(Object.create(null) as Record<string, unknown>, { orgId: 1 });
    construct({ blogPosts: filter });
  });
});
