/**
 * Shared test helpers for build-only (no DB) tests.
 *
 * Provides mock schema builders so each test file only defines
 * the table layout it cares about.
 */

import { QueryInterface } from '../query.js';
import type { ColumnMetadata, RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';

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
): QueryInterface<T> {
  // biome-ignore lint/suspicious/noExplicitAny: mock pool not needed for build-only tests
  return new QueryInterface<T>(null as any, tableName, schema);
}
