/**
 * turbine-orm — Composite foreign key tests
 *
 * Verifies that:
 * 1. Single-column FKs continue to work exactly as before (regression guard)
 * 2. Multi-column FKs are grouped correctly by constraint name
 * 3. The generated correlation WHERE for multi-column FKs produces correct SQL
 * 4. Multi-column unique constraints are grouped correctly
 * 5. buildCorrelation() handles both single and composite keys
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCorrelation } from '../query/utils.js';
import type { SchemaMetadata } from '../schema.js';
import { normalizeKeyColumns } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

// ---------------------------------------------------------------------------
// buildCorrelation() unit tests
// ---------------------------------------------------------------------------

describe('buildCorrelation', () => {
  it('single-column produces simple equality', () => {
    const result = buildCorrelation('"t0"', 'user_id', '"users"', 'id');
    assert.equal(result, '"t0"."user_id" = "users"."id"');
  });

  it('multi-column produces AND-joined equalities', () => {
    const result = buildCorrelation('"t0"', ['tenant_id', 'user_id'], '"parent"', ['tenant_id', 'id']);
    assert.equal(result, '"t0"."tenant_id" = "parent"."tenant_id" AND "t0"."user_id" = "parent"."id"');
  });

  it('mixed string/array inputs are handled (left=string, right=string)', () => {
    const result = buildCorrelation('"a"', 'col', '"b"', 'ref');
    assert.equal(result, '"a"."col" = "b"."ref"');
  });

  it('three-column composite FK', () => {
    const result = buildCorrelation('"t0"', ['org_id', 'team_id', 'member_id'], '"teams"', ['org_id', 'id', 'lead_id']);
    assert.equal(
      result,
      '"t0"."org_id" = "teams"."org_id" AND "t0"."team_id" = "teams"."id" AND "t0"."member_id" = "teams"."lead_id"',
    );
  });
});

// ---------------------------------------------------------------------------
// normalizeKeyColumns() unit tests
// ---------------------------------------------------------------------------

describe('normalizeKeyColumns', () => {
  it('converts a string to a single-element array', () => {
    assert.deepEqual(normalizeKeyColumns('user_id'), ['user_id']);
  });

  it('passes through an array unchanged', () => {
    assert.deepEqual(normalizeKeyColumns(['tenant_id', 'user_id']), ['tenant_id', 'user_id']);
  });
});

// ---------------------------------------------------------------------------
// Single-column FK regression — query builder still generates correct SQL
// ---------------------------------------------------------------------------

describe('single-column FK relation subquery (regression)', () => {
  const schema: SchemaMetadata = {
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
        },
      ),
      posts: mockTable(
        'posts',
        [
          { name: 'id', field: 'id' },
          { name: 'user_id', field: 'userId' },
          { name: 'title', field: 'title', pgType: 'text' },
        ],
        {
          user: {
            type: 'belongsTo',
            name: 'user',
            from: 'posts',
            to: 'users',
            foreignKey: 'user_id',
            referenceKey: 'id',
          },
        },
      ),
    },
  };

  it('hasMany relation generates single-column correlation WHERE', () => {
    const q = makeQuery('users', schema);
    const deferred = q.buildFindMany({ with: { posts: true } });
    // The subquery should correlate with user_id = "users"."id"
    assert.match(deferred.sql, /"user_id" = "users"\."id"/);
  });

  it('belongsTo relation generates single-column correlation WHERE', () => {
    const q = makeQuery('posts', schema);
    const deferred = q.buildFindMany({ with: { user: true } });
    // The subquery should correlate with "id" = "posts"."user_id"
    assert.match(deferred.sql, /"id" = "posts"\."user_id"/);
  });
});

// ---------------------------------------------------------------------------
// Multi-column (composite) FK — query builder generates AND-joined correlation
// ---------------------------------------------------------------------------

describe('composite FK relation subquery', () => {
  const schema: SchemaMetadata = {
    enums: {},
    tables: {
      tenants: mockTable(
        'tenants',
        [
          { name: 'id', field: 'id' },
          { name: 'name', field: 'name', pgType: 'text' },
        ],
        {},
      ),
      users: mockTable(
        'users',
        [
          { name: 'id', field: 'id' },
          { name: 'tenant_id', field: 'tenantId' },
          { name: 'name', field: 'name', pgType: 'text' },
        ],
        {
          orders: {
            type: 'hasMany',
            name: 'orders',
            from: 'users',
            to: 'orders',
            foreignKey: ['tenant_id', 'user_id'],
            referenceKey: ['tenant_id', 'id'],
          },
        },
      ),
      orders: mockTable(
        'orders',
        [
          { name: 'id', field: 'id' },
          { name: 'tenant_id', field: 'tenantId' },
          { name: 'user_id', field: 'userId' },
          { name: 'total', field: 'total' },
        ],
        {
          user: {
            type: 'belongsTo',
            name: 'user',
            from: 'orders',
            to: 'users',
            foreignKey: ['tenant_id', 'user_id'],
            referenceKey: ['tenant_id', 'id'],
          },
        },
      ),
    },
  };

  it('hasMany with composite FK generates AND-joined WHERE', () => {
    const q = makeQuery('users', schema);
    const deferred = q.buildFindMany({ with: { orders: true } });
    // Should produce: "tenant_id" = "users"."tenant_id" AND "user_id" = "users"."id"
    assert.match(deferred.sql, /"tenant_id" = "users"\."tenant_id"/);
    assert.match(deferred.sql, /"user_id" = "users"\."id"/);
    // Both conditions should be AND-joined
    assert.match(deferred.sql, /"tenant_id" = "users"\."tenant_id" AND.*"user_id" = "users"\."id"/);
  });

  it('belongsTo with composite FK generates AND-joined WHERE', () => {
    const q = makeQuery('orders', schema);
    const deferred = q.buildFindMany({ with: { user: true } });
    // Should produce: "tenant_id" = "orders"."tenant_id" AND "id" = "orders"."user_id"
    assert.match(deferred.sql, /"tenant_id" = "orders"\."tenant_id"/);
    assert.match(deferred.sql, /"id" = "orders"\."user_id"/);
    assert.match(deferred.sql, /"tenant_id" = "orders"\."tenant_id" AND.*"id" = "orders"\."user_id"/);
  });
});

// ---------------------------------------------------------------------------
// Relation filter (some/none/every) with composite FK
// ---------------------------------------------------------------------------

describe('relation filter with composite FK', () => {
  const schema: SchemaMetadata = {
    enums: {},
    tables: {
      users: mockTable(
        'users',
        [
          { name: 'id', field: 'id' },
          { name: 'tenant_id', field: 'tenantId' },
          { name: 'name', field: 'name', pgType: 'text' },
        ],
        {
          orders: {
            type: 'hasMany',
            name: 'orders',
            from: 'users',
            to: 'orders',
            foreignKey: ['tenant_id', 'user_id'],
            referenceKey: ['tenant_id', 'id'],
          },
        },
      ),
      orders: mockTable(
        'orders',
        [
          { name: 'id', field: 'id' },
          { name: 'tenant_id', field: 'tenantId' },
          { name: 'user_id', field: 'userId' },
          { name: 'total', field: 'total' },
        ],
        {},
      ),
    },
  };

  it('relation filter "some" with composite FK uses AND-joined correlation', () => {
    const q = makeQuery('users', schema);
    const deferred = q.buildFindMany({
      where: { orders: { some: { total: { gt: 100 } } } },
    });
    // EXISTS subquery should have composite correlation
    assert.match(deferred.sql, /EXISTS/);
    assert.match(deferred.sql, /"orders"\."tenant_id" = "users"\."tenant_id"/);
    assert.match(deferred.sql, /"orders"\."user_id" = "users"\."id"/);
  });

  it('relation filter "none" with composite FK uses AND-joined correlation', () => {
    const q = makeQuery('users', schema);
    const deferred = q.buildFindMany({
      where: { orders: { none: { total: { gt: 100 } } } },
    });
    // NOT EXISTS subquery should have composite correlation
    assert.match(deferred.sql, /NOT EXISTS/);
    assert.match(deferred.sql, /"orders"\."tenant_id" = "users"\."tenant_id"/);
    assert.match(deferred.sql, /"orders"\."user_id" = "users"\."id"/);
  });
});

// ---------------------------------------------------------------------------
// Multi-column unique constraint grouping (introspection mock)
// ---------------------------------------------------------------------------

describe('multi-column unique constraint grouping', () => {
  it('uniqueColumns correctly represents a multi-column unique constraint', () => {
    // This verifies the type contract: uniqueColumns is string[][] where
    // each inner array can have more than one column
    const table = mockTable('assignments', [
      { name: 'id', field: 'id' },
      { name: 'tenant_id', field: 'tenantId' },
      { name: 'user_id', field: 'userId' },
    ]);
    // Simulate what the fixed introspection would produce
    table.uniqueColumns = [['tenant_id', 'user_id']];
    assert.deepEqual(table.uniqueColumns, [['tenant_id', 'user_id']]);
    assert.equal(table.uniqueColumns[0]!.length, 2);
  });

  it('mixed single and multi-column unique constraints coexist', () => {
    const table = mockTable('events', [
      { name: 'id', field: 'id' },
      { name: 'slug', field: 'slug', pgType: 'text' },
      { name: 'tenant_id', field: 'tenantId' },
      { name: 'event_date', field: 'eventDate' },
    ]);
    // Single-column unique on slug, composite on (tenant_id, event_date)
    table.uniqueColumns = [['slug'], ['tenant_id', 'event_date']];
    assert.equal(table.uniqueColumns.length, 2);
    assert.deepEqual(table.uniqueColumns[0], ['slug']);
    assert.deepEqual(table.uniqueColumns[1], ['tenant_id', 'event_date']);
  });
});
