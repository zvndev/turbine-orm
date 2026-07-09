/**
 * turbine-orm — WS-H / H4: views as read-only entities
 *
 * With `includeViews`, views and materialized views are introspected as
 * `TableMetadata` with `isView: true`. Codegen emits entity types + accessors;
 * a no-PK view is excluded from the `findUnique`-family accessor types. Every
 * write builder throws `ValidationError` (E003) "cannot write to a view". Pure —
 * no DB.
 *
 * Run: npx tsx --test src/test/views-generated.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import { generateIndex, generateMetadata, generateTypes } from '../generate.js';
import type { ColumnMetadata, SchemaMetadata, TableMetadata } from '../schema.js';
import { makeQuery } from './helpers.js';

function col(name: string, pgType = 'int8', tsType = 'number'): ColumnMetadata {
  return {
    name,
    field: name,
    pgType,
    tsType,
    nullable: false,
    hasDefault: false,
    isArray: false,
    pgArrayType: 'bigint[]',
  };
}

// A base table (has PK) + a view (no PK, isView).
const users: TableMetadata = {
  name: 'users',
  columns: [col('id'), col('name', 'text', 'string')],
  columnMap: { id: 'id', name: 'name' },
  reverseColumnMap: { id: 'id', name: 'name' },
  dateColumns: new Set(),
  pgTypes: { id: 'int8', name: 'text' },
  allColumns: ['id', 'name'],
  primaryKey: ['id'],
  uniqueColumns: [['id']],
  relations: {},
  indexes: [],
};

const activeUsers: TableMetadata = {
  name: 'active_users',
  columns: [col('id'), col('name', 'text', 'string')],
  columnMap: { id: 'id', name: 'name' },
  reverseColumnMap: { id: 'id', name: 'name' },
  dateColumns: new Set(),
  pgTypes: { id: 'int8', name: 'text' },
  allColumns: ['id', 'name'],
  primaryKey: [], // views have no primary key
  uniqueColumns: [],
  relations: {},
  indexes: [],
  isView: true,
};

const SCHEMA: SchemaMetadata = { tables: { users, active_users: activeUsers }, enums: {} };

describe('H4 — codegen for views', () => {
  it('emits an entity type for the view', () => {
    const types = generateTypes(SCHEMA);
    assert.match(types, /export interface ActiveUser \{/);
  });

  it('serializes isView: true into metadata for the view only', () => {
    const meta = generateMetadata(SCHEMA);
    const usersBlock = meta.slice(meta.indexOf('users: {'), meta.indexOf('active_users: {'));
    const viewBlock = meta.slice(meta.indexOf('active_users: {'));
    assert.doesNotMatch(usersBlock, /isView:/);
    assert.match(viewBlock, /isView: true/);
  });

  it('excludes the findUnique-family from a no-PK view accessor', () => {
    const index = generateIndex(SCHEMA);
    // The view accessor omits findUnique/findUniqueOrThrow.
    assert.match(index, /readonly activeUsers: Omit<QueryInterface<ActiveUser>, 'findUnique' \| 'findUniqueOrThrow'>;/);
    // The base table accessor is a plain QueryInterface.
    assert.match(index, /readonly users: QueryInterface<User>;/);
  });
});

describe('H4 — write builders reject views (E003)', () => {
  const view = makeQuery('active_users', SCHEMA);

  const isViewError = (err: unknown) =>
    err instanceof ValidationError && err.code === 'TURBINE_E003' && /view/i.test(err.message);

  it('create throws', () => {
    assert.throws(() => view.buildCreate({ data: { name: 'x' } as never }), isViewError);
  });
  it('createMany throws', () => {
    assert.throws(() => view.buildCreateMany({ data: [{ name: 'x' }] as never }), isViewError);
  });
  it('update throws', () => {
    assert.throws(() => view.buildUpdate({ where: { id: 1 } as never, data: { name: 'x' } as never }), isViewError);
  });
  it('updateMany throws', () => {
    assert.throws(() => view.buildUpdateMany({ where: { id: 1 } as never, data: { name: 'x' } as never }), isViewError);
  });
  it('delete throws', () => {
    assert.throws(() => view.buildDelete({ where: { id: 1 } as never }), isViewError);
  });
  it('deleteMany throws', () => {
    assert.throws(() => view.buildDeleteMany({ where: { id: 1 } as never }), isViewError);
  });
  it('upsert throws', () => {
    assert.throws(
      () =>
        view.buildUpsert({ where: { id: 1 } as never, create: { name: 'x' } as never, update: { name: 'y' } as never }),
      isViewError,
    );
  });

  it('reads are allowed on a view', () => {
    assert.doesNotThrow(() => view.buildFindMany({}));
  });
});
