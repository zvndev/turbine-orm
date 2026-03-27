/**
 * turbine-orm — Schema introspection
 *
 * Connects to a live Postgres database, reads information_schema + pg_catalog,
 * and produces a SchemaMetadata object describing every table, column, relation,
 * and index in the target schema.
 *
 * This is the foundation of `npx turbine generate`.
 */

import pg from 'pg';
import {
  type SchemaMetadata,
  type TableMetadata,
  type ColumnMetadata,
  type RelationDef,
  type IndexMetadata,
  pgTypeToTs,
  isDateType,
  pgArrayType,
  snakeToCamel,
  singularize,
} from './schema.js';

// ---------------------------------------------------------------------------
// SQL queries (all parameterized, no interpolation)
// ---------------------------------------------------------------------------

const SQL_TABLES = `
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema = $1
    AND table_type = 'BASE TABLE'
  ORDER BY table_name
`;

const SQL_COLUMNS = `
  SELECT
    table_name,
    column_name,
    udt_name,
    data_type,
    is_nullable,
    column_default,
    ordinal_position,
    character_maximum_length
  FROM information_schema.columns
  WHERE table_schema = $1
  ORDER BY table_name, ordinal_position
`;

const SQL_PRIMARY_KEYS = `
  SELECT
    tc.table_name,
    kcu.column_name,
    kcu.ordinal_position
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
    AND tc.table_schema = kcu.table_schema
  WHERE tc.constraint_type = 'PRIMARY KEY'
    AND tc.table_schema = $1
  ORDER BY tc.table_name, kcu.ordinal_position
`;

const SQL_FOREIGN_KEYS = `
  SELECT
    tc.table_name AS source_table,
    kcu.column_name AS source_column,
    ccu.table_name AS target_table,
    ccu.column_name AS target_column,
    tc.constraint_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
    AND tc.table_schema = kcu.table_schema
  JOIN information_schema.constraint_column_usage ccu
    ON tc.constraint_name = ccu.constraint_name
    AND tc.table_schema = ccu.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_schema = $1
`;

const SQL_UNIQUE_CONSTRAINTS = `
  SELECT
    tc.table_name,
    kcu.column_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
    AND tc.table_schema = kcu.table_schema
  WHERE tc.constraint_type = 'UNIQUE'
    AND tc.table_schema = $1
`;

const SQL_INDEXES = `
  SELECT tablename, indexname, indexdef
  FROM pg_indexes
  WHERE schemaname = $1
`;

const SQL_ENUMS = `
  SELECT t.typname, e.enumlabel
  FROM pg_type t
  JOIN pg_enum e ON t.oid = e.enumtypid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = $1
  ORDER BY t.typname, e.enumsortorder
`;

// ---------------------------------------------------------------------------
// Introspection options
// ---------------------------------------------------------------------------

export interface IntrospectOptions {
  /** Postgres connection string */
  connectionString: string;
  /** Schema to introspect (default: 'public') */
  schema?: string;
  /** Tables to include (default: all). Glob-like patterns not supported yet. */
  include?: string[];
  /** Tables to exclude (default: none). Applied after include. */
  exclude?: string[];
}

// ---------------------------------------------------------------------------
// Main introspection function
// ---------------------------------------------------------------------------

export async function introspect(options: IntrospectOptions): Promise<SchemaMetadata> {
  const schema = options.schema ?? 'public';
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: 1,
    connectionTimeoutMillis: 10_000,
  });

  try {
    // Run all information_schema queries in parallel
    const [
      tablesResult,
      columnsResult,
      pkResult,
      fkResult,
      uniqueResult,
      indexResult,
      enumResult,
    ] = await Promise.all([
      pool.query(SQL_TABLES, [schema]),
      pool.query(SQL_COLUMNS, [schema]),
      pool.query(SQL_PRIMARY_KEYS, [schema]),
      pool.query(SQL_FOREIGN_KEYS, [schema]),
      pool.query(SQL_UNIQUE_CONSTRAINTS, [schema]),
      pool.query(SQL_INDEXES, [schema]),
      pool.query(SQL_ENUMS, [schema]),
    ]);

    // Filter tables by include/exclude
    let tableNames: string[] = tablesResult.rows.map((r: { table_name: string }) => r.table_name);
    if (options.include?.length) {
      const includeSet = new Set(options.include);
      tableNames = tableNames.filter((t) => includeSet.has(t));
    }
    if (options.exclude?.length) {
      const excludeSet = new Set(options.exclude);
      tableNames = tableNames.filter((t) => !excludeSet.has(t));
    }

    const tableSet = new Set(tableNames);

    // ----- Group columns by table -----
    const columnsByTable = new Map<string, ColumnMetadata[]>();
    for (const row of columnsResult.rows) {
      const tableName: string = row.table_name;
      if (!tableSet.has(tableName)) continue;

      const isNullable = row.is_nullable === 'YES';
      const isArray = row.data_type === 'ARRAY';
      const baseType: string = isArray ? row.udt_name.slice(1) : row.udt_name;

      const col: ColumnMetadata = {
        name: row.column_name,
        field: snakeToCamel(row.column_name),
        pgType: row.udt_name,
        tsType: pgTypeToTs(isArray ? row.udt_name : baseType, isNullable),
        nullable: isNullable,
        hasDefault: row.column_default !== null,
        isArray,
        pgArrayType: pgArrayType(baseType),
        maxLength: row.character_maximum_length ?? undefined,
      };

      if (!columnsByTable.has(tableName)) columnsByTable.set(tableName, []);
      columnsByTable.get(tableName)!.push(col);
    }

    // ----- Group primary keys by table -----
    const pkByTable = new Map<string, string[]>();
    for (const row of pkResult.rows) {
      if (!tableSet.has(row.table_name)) continue;
      if (!pkByTable.has(row.table_name)) pkByTable.set(row.table_name, []);
      pkByTable.get(row.table_name)!.push(row.column_name);
    }

    // ----- Group unique constraints by table -----
    const uniqueByTable = new Map<string, string[][]>();
    for (const row of uniqueResult.rows) {
      if (!tableSet.has(row.table_name)) continue;
      if (!uniqueByTable.has(row.table_name)) uniqueByTable.set(row.table_name, []);
      // Each unique constraint may be multi-column; for simplicity, treat as single-col here
      uniqueByTable.get(row.table_name)!.push([row.column_name]);
    }

    // ----- Group indexes by table -----
    const indexesByTable = new Map<string, IndexMetadata[]>();
    for (const row of indexResult.rows) {
      if (!tableSet.has(row.tablename)) continue;
      if (!indexesByTable.has(row.tablename)) indexesByTable.set(row.tablename, []);

      const isUnique = (row.indexdef as string).includes('UNIQUE');
      // Extract column names from indexdef (e.g. "CREATE INDEX idx ON tbl USING btree (col1, col2)")
      const colMatch = (row.indexdef as string).match(/\((.+)\)/);
      const columns = colMatch
        ? colMatch[1]!.split(',').map((c) => c.trim().replace(/ (ASC|DESC)/i, ''))
        : [];

      indexesByTable.get(row.tablename)!.push({
        name: row.indexname,
        columns,
        unique: isUnique,
        definition: row.indexdef,
      });
    }

    // ----- Collect enums -----
    const enums: Record<string, string[]> = {};
    for (const row of enumResult.rows) {
      if (!enums[row.typname]) enums[row.typname] = [];
      enums[row.typname]!.push(row.enumlabel);
    }

    // ----- Build foreign key map -----
    interface FKEntry {
      sourceTable: string;
      sourceColumn: string;
      targetTable: string;
      targetColumn: string;
    }
    const foreignKeys: FKEntry[] = [];
    for (const row of fkResult.rows) {
      if (!tableSet.has(row.source_table) || !tableSet.has(row.target_table)) continue;
      foreignKeys.push({
        sourceTable: row.source_table,
        sourceColumn: row.source_column,
        targetTable: row.target_table,
        targetColumn: row.target_column,
      });
    }

    // ----- Build relations from foreign keys -----
    // Count FKs per (source, target) pair for disambiguation
    const fkCounts = new Map<string, number>();
    for (const fk of foreignKeys) {
      const key = `${fk.sourceTable}→${fk.targetTable}`;
      fkCounts.set(key, (fkCounts.get(key) ?? 0) + 1);
    }

    const relationsByTable = new Map<string, Record<string, RelationDef>>();

    for (const fk of foreignKeys) {
      const pairKey = `${fk.sourceTable}→${fk.targetTable}`;
      const needsDisambiguation = (fkCounts.get(pairKey) ?? 0) > 1;

      // --- belongsTo on the source (child) table ---
      // e.g. posts.user_id → users.id creates posts.user (belongsTo)
      const belongsToName = needsDisambiguation
        ? snakeToCamel(fk.sourceColumn.replace(/_id$/, ''))
        : singularize(snakeToCamel(fk.targetTable));

      if (!relationsByTable.has(fk.sourceTable)) relationsByTable.set(fk.sourceTable, {});
      relationsByTable.get(fk.sourceTable)![belongsToName] = {
        type: 'belongsTo',
        name: belongsToName,
        from: fk.sourceTable,
        to: fk.targetTable,
        foreignKey: fk.sourceColumn,
        referenceKey: fk.targetColumn,
      };

      // --- hasMany on the target (parent) table ---
      // e.g. posts.user_id → users.id creates users.posts (hasMany)
      const hasManyName = needsDisambiguation
        ? snakeToCamel(`${fk.sourceTable}_by_${fk.sourceColumn.replace(/_id$/, '')}`)
        : snakeToCamel(fk.sourceTable);

      if (!relationsByTable.has(fk.targetTable)) relationsByTable.set(fk.targetTable, {});
      relationsByTable.get(fk.targetTable)![hasManyName] = {
        type: 'hasMany',
        name: hasManyName,
        from: fk.targetTable,
        to: fk.sourceTable,
        foreignKey: fk.sourceColumn,
        referenceKey: fk.targetColumn,
      };
    }

    // ----- Assemble TableMetadata for each table -----
    const tables: Record<string, TableMetadata> = {};

    for (const tableName of tableNames) {
      const columns = columnsByTable.get(tableName) ?? [];
      const columnMap: Record<string, string> = {};
      const reverseColumnMap: Record<string, string> = {};
      const dateColumns = new Set<string>();
      const pgTypes: Record<string, string> = {};
      const allColumns: string[] = [];

      for (const col of columns) {
        columnMap[col.field] = col.name;
        reverseColumnMap[col.name] = col.field;
        allColumns.push(col.name);
        pgTypes[col.name] = col.pgType;

        const baseType = col.isArray ? col.pgType.slice(1) : col.pgType;
        if (isDateType(baseType)) {
          dateColumns.add(col.name);
        }
      }

      tables[tableName] = {
        name: tableName,
        columns,
        columnMap,
        reverseColumnMap,
        dateColumns,
        pgTypes,
        allColumns,
        primaryKey: pkByTable.get(tableName) ?? [],
        uniqueColumns: uniqueByTable.get(tableName) ?? [],
        relations: relationsByTable.get(tableName) ?? {},
        indexes: indexesByTable.get(tableName) ?? [],
      };
    }

    return { tables, enums };
  } finally {
    await pool.end();
  }
}
