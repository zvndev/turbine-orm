/**
 * turbine-orm: nested-relation orderBy columnMap resolution (Capa item 2)
 *
 * Regression: `findFirst({ with: { fields: { orderBy: { sortOrder: 'asc' } } } })`
 * threw [TURBINE_E003] Unknown column "sortOrder" whenever the DB column was
 * named in camelCase (columnMap `sortOrder → "sortOrder"`), because the
 * with-subquery orderBy path used a bare camelToSnake and skipped the TARGET
 * table's columnMap. The same orderBy worked top-level.
 *
 * Nested orderBy now resolves exactly like top-level: columnMap lookup first,
 * camelToSnake fallback, same unknown-field E003 message shape, OrderBySpec
 * nulls handling, and relation (`_count` / to-one column) ordering. The
 * batched relation-load strategy compiles its per-relation orderBy through the
 * top-level buildOrderBy (batched-loader passes `options.orderBy` into the
 * child's buildFindMany), so both strategies accept the same input.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import { mssqlDialect } from '../mssql.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

/**
 * The Capa shape: DB columns named in camelCase (introspected columnMap maps
 * the field to the identical camelCase column), plus a classic snake_case
 * column to prove the fallback still works.
 */
function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      content_types: mockTable(
        'content_types',
        [
          { name: 'id', field: 'id' },
          { name: 'name', field: 'name', pgType: 'text' },
          { name: 'author_id', field: 'authorId' },
        ],
        {
          fields: {
            type: 'hasMany',
            name: 'fields',
            from: 'content_types',
            to: 'fields',
            foreignKey: 'content_type_id',
            referenceKey: 'id',
          },
          author: {
            type: 'belongsTo',
            name: 'author',
            from: 'content_types',
            to: 'users',
            foreignKey: 'author_id',
            referenceKey: 'id',
          },
          settings: {
            type: 'hasOne',
            name: 'settings',
            from: 'content_types',
            to: 'settings',
            foreignKey: 'content_type_id',
            referenceKey: 'id',
          },
          tags: {
            type: 'manyToMany',
            name: 'tags',
            from: 'content_types',
            to: 'tags',
            foreignKey: 'id',
            referenceKey: 'id',
            through: { table: 'content_type_tags', sourceKey: 'content_type_id', targetKey: 'tag_id' },
          },
        },
      ),
      fields: mockTable(
        'fields',
        [
          { name: 'id', field: 'id' },
          { name: 'content_type_id', field: 'contentTypeId' },
          // camelCase-named DB column: the Capa repro shape
          { name: 'sortOrder', field: 'sortOrder' },
          { name: 'created_at', field: 'createdAt', pgType: 'timestamptz' },
        ],
        {
          options: {
            type: 'hasMany',
            name: 'options',
            from: 'fields',
            to: 'options',
            foreignKey: 'field_id',
            referenceKey: 'id',
          },
        },
      ),
      options: mockTable('options', [
        { name: 'id', field: 'id' },
        { name: 'field_id', field: 'fieldId' },
        { name: 'displayOrder', field: 'displayOrder' },
      ]),
      users: mockTable('users', [
        { name: 'id', field: 'id' },
        { name: 'displayName', field: 'displayName', pgType: 'text' },
      ]),
      settings: mockTable('settings', [
        { name: 'id', field: 'id' },
        { name: 'content_type_id', field: 'contentTypeId' },
        { name: 'themeName', field: 'themeName', pgType: 'text' },
      ]),
      tags: mockTable('tags', [
        { name: 'id', field: 'id' },
        { name: 'tagLabel', field: 'tagLabel', pgType: 'text' },
      ]),
      content_type_tags: mockTable('content_type_tags', [
        { name: 'content_type_id', field: 'contentTypeId' },
        { name: 'tag_id', field: 'tagId' },
      ]),
    },
  };
}

describe('nested orderBy: camelCase columnMap resolution (Capa repro)', () => {
  it('hasMany orderBy on a camelCase-named DB column compiles (the exact Capa shape)', () => {
    const q = makeQuery('content_types', schema());
    const { sql, params } = q.buildFindMany({ with: { fields: { orderBy: { sortOrder: 'asc' } } }, limit: 1 } as never);
    assert.ok(sql.includes('ORDER BY t0."sortOrder" ASC'), sql);
    assert.deepEqual(params, [1]);
  });

  it('hasMany orderBy + limit (inner-subquery wrap) resolves via columnMap', () => {
    const q = makeQuery('content_types', schema());
    const { sql, params } = q.buildFindMany({
      with: { fields: { orderBy: { sortOrder: 'desc' }, limit: 3 } },
    } as never);
    assert.ok(sql.includes('ORDER BY t0."sortOrder" DESC LIMIT $1'), sql);
    assert.deepEqual(params, [3]);
  });

  it('camelToSnake fallback still resolves classic snake_case columns', () => {
    const q = makeQuery('content_types', schema());
    const { sql } = q.buildFindMany({ with: { fields: { orderBy: { createdAt: 'asc' } } } } as never);
    assert.ok(sql.includes('ORDER BY t0."created_at" ASC'), sql);
  });

  it('belongsTo orderBy on a camelCase column compiles and picks the LIMIT 1 row', () => {
    const q = makeQuery('content_types', schema());
    const { sql, params } = q.buildFindMany({
      with: { author: { orderBy: { displayName: 'desc' } } },
    } as never);
    assert.ok(sql.includes('ORDER BY t0."displayName" DESC LIMIT 1'), sql);
    assert.deepEqual(params, []);
  });

  it('hasOne orderBy on a camelCase column compiles', () => {
    const q = makeQuery('content_types', schema());
    const { sql } = q.buildFindMany({ with: { settings: { orderBy: { themeName: 'asc' } } } } as never);
    assert.ok(sql.includes('ORDER BY t0."themeName" ASC LIMIT 1'), sql);
  });

  it('manyToMany orderBy on a camelCase column compiles', () => {
    const q = makeQuery('content_types', schema());
    const { sql, params } = q.buildFindMany({ with: { tags: { orderBy: { tagLabel: 'asc' } } } } as never);
    assert.ok(sql.includes('ORDER BY t0."tagLabel" ASC'), sql);
    assert.deepEqual(params, []);
  });

  it('two levels deep: nested with orderBy resolves at each level', () => {
    const q = makeQuery('content_types', schema());
    const { sql } = q.buildFindMany({
      with: {
        fields: {
          orderBy: { sortOrder: 'asc' },
          with: { options: { orderBy: { displayOrder: 'desc' } } },
        },
      },
    } as never);
    assert.ok(sql.includes('ORDER BY t0."sortOrder" ASC'), sql);
    assert.ok(sql.includes('."displayOrder" DESC'), sql);
  });

  it('OrderBySpec nulls placement works in nested orderBy', () => {
    const q = makeQuery('content_types', schema());
    const { sql } = q.buildFindMany({
      with: { fields: { orderBy: { sortOrder: { sort: 'desc', nulls: 'last' } } } },
    } as never);
    assert.ok(sql.includes('ORDER BY t0."sortOrder" DESC NULLS LAST'), sql);
  });

  it('unknown nested orderBy field throws the top-level E003 shape (known-fields list)', () => {
    const q = makeQuery('content_types', schema());
    assert.throws(
      () => q.buildFindMany({ with: { fields: { orderBy: { bogus: 'asc' } } } } as never),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /Unknown field "bogus" in orderBy on table "fields"/);
        assert.match(err.message, /Known fields:.*sortOrder/);
        return true;
      },
    );
  });

  it('nested relation ordering: to-many _count of the target table', () => {
    const q = makeQuery('content_types', schema());
    const { sql, params } = q.buildFindMany({
      with: { fields: { orderBy: { options: { _count: 'desc' } } } },
    } as never);
    assert.ok(sql.includes('SELECT COUNT(*)'), sql);
    // Correlated to the relation alias (t0), not the root table.
    assert.ok(/COUNT\(\*\)[^)]*FROM "options" t0ord0 WHERE t0ord0\."field_id" = "t0"\."id"/.test(sql), sql);
    assert.deepEqual(params, []);
  });

  it('cache double-run identity: second run collects the same SQL and params', () => {
    const q = makeQuery('content_types', schema());
    const args = {
      where: { name: 'blog' },
      with: {
        fields: {
          orderBy: { sortOrder: { sort: 'asc', nulls: 'first' } },
          limit: 5,
          with: { options: { orderBy: { displayOrder: 'asc' } } },
        },
      },
    } as never;
    const first = q.buildFindMany(args);
    const second = q.buildFindMany(args);
    assert.equal(second.sql, first.sql);
    assert.deepEqual(second.params, first.params);
    assert.deepEqual(first.params, ['blog', 5]);
  });

  it('nested vector ordering is still rejected as top-level-only', () => {
    const q = makeQuery('content_types', schema());
    assert.throws(
      () =>
        q.buildFindMany({
          with: { fields: { orderBy: { sortOrder: { distance: { to: [1], metric: 'l2' } } } } },
        } as never),
      /only supported in a top-level findMany orderBy/,
    );
  });
});

describe('nested orderBy: SQL Server FOR JSON override', () => {
  it('resolves camelCase-named DB columns via columnMap too', () => {
    const q = makeQuery('content_types', schema(), { dialect: mssqlDialect });
    const { sql, params } = q.buildFindMany({
      with: { fields: { orderBy: { sortOrder: 'asc' }, limit: 2 } },
    } as never);
    assert.ok(sql.includes('[sortOrder] ASC'), sql);
    assert.deepEqual(params, [2]);
  });

  it('honours { sort } specs instead of coercing them to ASC', () => {
    const q = makeQuery('content_types', schema(), { dialect: mssqlDialect });
    const { sql } = q.buildFindMany({
      with: { fields: { orderBy: { sortOrder: { sort: 'desc' } } } },
    } as never);
    assert.ok(sql.includes('[sortOrder] DESC'), sql);
  });

  it('rejects param-bearing orderBy objects (JSON-path) with a clear error', () => {
    const q = makeQuery('content_types', schema(), { dialect: mssqlDialect });
    assert.throws(
      () => q.buildFindMany({ with: { fields: { orderBy: { sortOrder: { path: ['x'] } } } } } as never),
      /only plain directions and \{ sort \} specs are supported/,
    );
  });

  it('unknown nested orderBy field throws the same E003 shape as the native path', () => {
    const q = makeQuery('content_types', schema(), { dialect: mssqlDialect });
    assert.throws(
      () => q.buildFindMany({ with: { fields: { orderBy: { bogus: 'asc' } } } } as never),
      /Unknown field "bogus" in orderBy on table "fields"/,
    );
  });
});
