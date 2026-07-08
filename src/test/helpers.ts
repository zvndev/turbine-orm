/**
 * Shared test helpers for build-only (no DB) tests.
 *
 * Provides mock schema builders so each test file only defines
 * the table layout it cares about.
 */

import { after, before, it } from 'node:test';
import { QueryInterface, type QueryInterfaceOptions } from '../query/index.js';
import type { ColumnMetadata, RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';

/** Test runners returned by {@link skipGate}. */
export interface GatedRunners {
  it: typeof it;
  before: typeof before;
  after: typeof after;
}

/**
 * Gate an integration suite on an environment precondition (usually DATABASE_URL).
 *
 * When `skip` is false this returns the real node:test runners, so behavior is
 * byte-for-byte identical to importing them directly. When `skip` is true it
 * returns an `it` that registers every test with `{ skip: reason }` — the
 * reporter counts them as skipped instead of silently omitting them — and
 * no-op `before`/`after` hooks so suite setup never touches the database.
 */
export function skipGate(skip: boolean, reason: string): GatedRunners {
  if (!skip) return { it, before, after };
  const noop = () => {};
  // biome-ignore lint/suspicious/noExplicitAny: forwards node:test's overloaded `it` signature
  const skippedIt = ((name: any, options?: any, fn?: any) =>
    typeof options === 'function' || options === undefined
      ? it(name, { skip: reason }, options)
      : it(name, { ...options, skip: reason }, fn)) as typeof it;
  return { it: skippedIt, before: noop as typeof before, after: noop as typeof after };
}

/** Build a minimal ColumnMetadata for testing */
export function mockColumn(name: string, field: string, pgType = 'int8'): ColumnMetadata {
  return {
    name,
    field,
    pgType,
    tsType: 'number',
    nullable: false,
    hasDefault: name === 'id',
    isArray: false,
    pgArrayType: 'bigint[]',
  };
}

/** Build a minimal TableMetadata for testing */
export function mockTable(
  tableName: string,
  columns: { name: string; field: string; pgType?: string }[],
  relations: Record<string, RelationDef> = {},
): TableMetadata {
  const cols = columns.map((c) => mockColumn(c.name, c.field, c.pgType ?? 'int8'));
  const columnMap: Record<string, string> = {};
  const reverseColumnMap: Record<string, string> = {};
  const allColumns: string[] = [];

  for (const col of cols) {
    columnMap[col.field] = col.name;
    reverseColumnMap[col.name] = col.field;
    allColumns.push(col.name);
  }

  return {
    name: tableName,
    columns: cols,
    columnMap,
    reverseColumnMap,
    dateColumns: new Set(),
    dialectTypes: Object.fromEntries(cols.map((c) => [c.name, c.dialectType ?? c.pgType])),
    pgTypes: Object.fromEntries(cols.map((c) => [c.name, c.pgType])),
    allColumns,
    primaryKey: ['id'],
    uniqueColumns: [['id']],
    relations,
    indexes: [],
  };
}

/** Create a QueryInterface without a real pool (for build-only SQL tests) */
export function makeQuery<T extends object = Record<string, unknown>>(
  tableName: string,
  schema: SchemaMetadata,
  options?: QueryInterfaceOptions,
): QueryInterface<T> {
  // biome-ignore lint/suspicious/noExplicitAny: mock pool not needed for build-only tests
  return new QueryInterface<T>(null as any, tableName, schema, undefined, options);
}
