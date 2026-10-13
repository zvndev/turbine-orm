/**
 * A blog schema as SchemaMetadata (organizations, users, posts, comments,
 * profiles), with relations derived by the real introspection naming path.
 * Shared by the types-* tests that generate and compile a client.
 */

import { buildRelationsFromForeignKeys, type ForeignKeyEntry } from '../introspect.js';
import type { ColumnMetadata, SchemaMetadata, TableMetadata } from '../schema.js';

function col(name: string, pgType: string, tsType: string, opts?: Partial<ColumnMetadata>): ColumnMetadata {
  return {
    name,
    field: name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
    pgType,
    tsType,
    nullable: false,
    hasDefault: false,
    isArray: false,
    pgArrayType: `${pgType}[]`,
    ...opts,
  };
}

function table(
  name: string,
  columns: ColumnMetadata[],
  primaryKey: string[],
  uniqueColumns: string[][] = [],
): TableMetadata {
  const columnMap: Record<string, string> = {};
  const reverseColumnMap: Record<string, string> = {};
  const pgTypes: Record<string, string> = {};
  for (const c of columns) {
    columnMap[c.field] = c.name;
    reverseColumnMap[c.name] = c.field;
    pgTypes[c.name] = c.pgType;
  }
  return {
    name,
    columns,
    columnMap,
    reverseColumnMap,
    dateColumns: new Set(columns.filter((c) => c.tsType.startsWith('Date')).map((c) => c.name)),
    pgTypes,
    allColumns: columns.map((c) => c.name),
    primaryKey,
    uniqueColumns,
    indexes: [],
    relations: {},
  };
}

const id = col('id', 'int8', 'number', { hasDefault: true, isGenerated: true });

/** Build a fresh copy (generators may be handed it more than once). */
export function blogSchema(): SchemaMetadata {
  const organizations = table(
    'organizations',
    [
      id,
      col('name', 'text', 'string'),
      col('slug', 'text', 'string'),
      col('plan', 'text', 'string', { hasDefault: true }),
      col('metadata', 'jsonb', 'unknown | null', { nullable: true }),
    ],
    ['id'],
    [['slug']],
  );
  const users = table(
    'users',
    [
      id,
      col('org_id', 'int8', 'number'),
      col('email', 'text', 'string'),
      col('name', 'text', 'string'),
      col('avatar_url', 'text', 'string | null', { nullable: true }),
      col('manager_id', 'int8', 'number | null', { nullable: true }),
      col('created_at', 'timestamptz', 'Date', { hasDefault: true }),
    ],
    ['id'],
    [['email']],
  );
  const posts = table(
    'posts',
    [
      id,
      col('user_id', 'int8', 'number'),
      col('org_id', 'int8', 'number'),
      col('title', 'text', 'string'),
      col('content', 'text', 'string'),
      col('view_count', 'int4', 'number', { hasDefault: true }),
    ],
    ['id'],
  );
  const comments = table(
    'comments',
    [id, col('post_id', 'int8', 'number'), col('user_id', 'int8', 'number'), col('body', 'text', 'string')],
    ['id'],
  );
  const profiles = table(
    'profiles',
    [id, col('user_id', 'int8', 'number'), col('bio', 'text', 'string | null', { nullable: true })],
    ['id'],
    [['user_id']],
  );
  const tables = [organizations, users, posts, comments, profiles];
  const fk = (sourceTable: string, column: string, targetTable: string): ForeignKeyEntry => ({
    sourceTable,
    sourceColumns: [column],
    targetTable,
    targetColumns: ['id'],
    constraintName: `${sourceTable}_${column}_fkey`,
  });
  const derived = buildRelationsFromForeignKeys(
    [
      fk('users', 'org_id', 'organizations'),
      fk('users', 'manager_id', 'users'),
      fk('posts', 'user_id', 'users'),
      fk('posts', 'org_id', 'organizations'),
      fk('comments', 'post_id', 'posts'),
      fk('comments', 'user_id', 'users'),
      fk('profiles', 'user_id', 'users'),
    ],
    new Map(tables.map((t) => [t.name, new Set(t.columns.map((c) => c.field))])),
  );
  for (const t of tables) t.relations = derived.get(t.name) ?? {};
  return { enums: {}, tables: Object.fromEntries(tables.map((t) => [t.name, t])) };
}
