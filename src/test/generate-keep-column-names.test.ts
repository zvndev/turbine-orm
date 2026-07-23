/**
 * turbine-orm: keepColumnNames / withDbFieldNames (F4)
 *
 * The opt-in flag rewrites generated column FIELD names to the raw DB column
 * names (snake_case) via a pure generate-time transform with ZERO runtime code
 * changes. These tests prove:
 *   - withDbFieldNames yields identity maps + field===name, preserving
 *     pii/dateColumns/relations/pgTypes;
 *   - generated types + metadata carry snake field names + identity maps, with
 *     exotic (dash) column names quoted;
 *   - the flag-off path is byte-identical (camelCase keys stay UNQUOTED);
 *   - the generated client works at runtime under identity metadata: where /
 *     select / orderBy accept snake names, `with` json_build_object uses snake
 *     keys, and the SQL-cache cross-check passes (fingerprint integrity).
 *
 * Run: npx tsx --test src/test/generate-keep-column-names.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateMetadata, generateTypes } from '../generate.js';
import { type ColumnMetadata, type SchemaMetadata, type TableMetadata, withDbFieldNames } from '../schema.js';
import { makeQuery } from './helpers.js';

function col(name: string, field: string, extra: Partial<ColumnMetadata> = {}): ColumnMetadata {
  return {
    name,
    field,
    pgType: 'text',
    tsType: 'string',
    nullable: false,
    hasDefault: false,
    isArray: false,
    pgArrayType: 'text[]',
    ...extra,
  };
}

function schema(): SchemaMetadata {
  const usersCols = [
    col('id', 'id', { pgType: 'int8', tsType: 'number', hasDefault: true }),
    col('full_name', 'fullName'),
    col('email', 'email', { pii: true }),
    col('created_at', 'createdAt', { pgType: 'timestamptz', tsType: 'Date' }),
  ];
  const postsCols = [
    col('id', 'id', { pgType: 'int8', tsType: 'number', hasDefault: true }),
    col('user_id', 'userId', { pgType: 'int8', tsType: 'number' }),
    col('title', 'title'),
  ];
  const users: TableMetadata = {
    name: 'users',
    columns: usersCols,
    columnMap: Object.fromEntries(usersCols.map((c) => [c.field, c.name])),
    reverseColumnMap: Object.fromEntries(usersCols.map((c) => [c.name, c.field])),
    dateColumns: new Set(['created_at']),
    pgTypes: Object.fromEntries(usersCols.map((c) => [c.name, c.pgType])),
    allColumns: usersCols.map((c) => c.name),
    primaryKey: ['id'],
    uniqueColumns: [['id']],
    relations: {
      posts: { type: 'hasMany', name: 'posts', from: 'users', to: 'posts', foreignKey: 'user_id', referenceKey: 'id' },
    },
    indexes: [],
  };
  const posts: TableMetadata = {
    name: 'posts',
    columns: postsCols,
    columnMap: Object.fromEntries(postsCols.map((c) => [c.field, c.name])),
    reverseColumnMap: Object.fromEntries(postsCols.map((c) => [c.name, c.field])),
    dateColumns: new Set(),
    pgTypes: Object.fromEntries(postsCols.map((c) => [c.name, c.pgType])),
    allColumns: postsCols.map((c) => c.name),
    primaryKey: ['id'],
    uniqueColumns: [['id']],
    relations: {},
    indexes: [],
  };
  return { tables: { users, posts }, enums: {} };
}

describe('withDbFieldNames', () => {
  it('makes field === name and columnMap/reverseColumnMap identity', () => {
    const t = withDbFieldNames(schema()).tables.users!;
    for (const c of t.columns) assert.equal(c.field, c.name);
    assert.deepEqual(t.columnMap, { id: 'id', full_name: 'full_name', email: 'email', created_at: 'created_at' });
    assert.deepEqual(t.reverseColumnMap, {
      id: 'id',
      full_name: 'full_name',
      email: 'email',
      created_at: 'created_at',
    });
  });

  it('preserves pii, dateColumns, relations, pgTypes, primaryKey', () => {
    const s = withDbFieldNames(schema());
    const users = s.tables.users!;
    assert.equal(users.columns.find((c) => c.name === 'email')?.pii, true);
    assert.deepEqual([...users.dateColumns], ['created_at']);
    assert.equal(users.relations.posts?.type, 'hasMany');
    assert.equal(users.relations.posts?.foreignKey, 'user_id');
    assert.deepEqual(users.primaryKey, ['id']);
    assert.equal(users.pgTypes.created_at, 'timestamptz');
  });

  it('does not mutate the input schema', () => {
    const s = schema();
    withDbFieldNames(s);
    assert.equal(s.tables.users!.columns.find((c) => c.name === 'full_name')?.field, 'fullName');
  });
});

describe('generated output under keepColumnNames', () => {
  it('emits snake field names in the entity interface, quoting exotic names', () => {
    const types = generateTypes(withDbFieldNames(schema()));
    assert.match(types, /\n {2}user_id: number;/);
    assert.match(types, /full_name: string;/); // valid identifier → unquoted
    // camelCase baseline still emits camelCase when the flag is off.
    assert.match(generateTypes(schema()), /\n {2}userId: number;/);
  });

  it('emits identity columnMap in metadata under the flag', () => {
    const meta = generateMetadata(withDbFieldNames(schema()));
    assert.match(meta, /columnMap: \{[\s\S]*?user_id: 'user_id',/);
  });

  it('quotes a dash-containing column name in both types and metadata', () => {
    const s = schema();
    // Introduce an exotic column name to exercise quoteIfNeeded under identity.
    s.tables.users!.columns.push(col('full-name-x', 'fullNameX'));
    const t = withDbFieldNames(s);
    const types = generateTypes(t);
    const meta = generateMetadata(t);
    assert.match(types, /'full-name-x'/);
    assert.match(meta, /'full-name-x': 'full-name-x',/);
  });
});

describe('byte-identity of the flag-off path', () => {
  it('leaves camelCase keys UNQUOTED in metadata (no churn from quoteIfNeeded)', () => {
    const meta = generateMetadata(schema());
    assert.match(meta, /\n {8}userId: 'user_id',/); // unquoted camelCase key
    assert.doesNotMatch(meta, /'userId':/);
  });

  it('generateMetadata is stable across repeated runs', () => {
    assert.equal(generateMetadata(schema()), generateMetadata(schema()));
  });
});

describe('runtime under identity metadata', () => {
  it('accepts snake column names in where/select/orderBy', () => {
    const s = withDbFieldNames(schema());
    const q = makeQuery('users', s);
    const { sql, params } = q.buildFindMany({
      where: { full_name: 'Ada' },
      select: { id: true, full_name: true },
      orderBy: { created_at: 'desc' },
    } as never);
    assert.match(sql, /"full_name"/);
    assert.match(sql, /"created_at"/);
    assert.deepEqual(params, ['Ada']);
  });

  it('with-subquery json_build_object keys use snake names', () => {
    const s = withDbFieldNames(schema());
    const q = makeQuery('users', s);
    const { sql } = q.buildFindMany({ with: { posts: true } } as never);
    assert.match(sql, /'user_id'/);
    assert.match(sql, /'title'/);
    assert.doesNotMatch(sql, /'userId'/);
  });

  it('excludes PII columns from the default projection', () => {
    const s = withDbFieldNames(schema());
    const q = makeQuery('users', s);
    const { sql } = q.buildFindMany({} as never);
    // email is pii → absent from default select.
    assert.doesNotMatch(sql, /"email"/);
  });

  it('cache cross-check passes on a repeated identical query (fingerprint integrity)', () => {
    const s = withDbFieldNames(schema());
    const q = makeQuery('users', s);
    const args = { where: { full_name: 'Ada', id: 1 } } as never;
    const first = q.buildFindMany(args);
    // A second identical call is a cache HIT; under NODE_ENV!=production the
    // dev cross-check rebuilds + compares, throwing E003 on drift.
    const second = q.buildFindMany(args);
    assert.equal(first.sql, second.sql);
  });
});
