/**
 * @batadata/turbine — Schema SQL Generator
 *
 * Converts a SchemaDef (from defineSchema) into executable DDL statements.
 * Also provides diff and push commands for syncing schema to a live database.
 */

import pg from 'pg';
import { camelToSnake } from './schema.js';
import { quoteIdent } from './query.js';
import type { SchemaDef, TableDef, ColumnConfig } from './schema-builder.js';

// ---------------------------------------------------------------------------
// SQL Generation — SchemaDef → CREATE TABLE statements
// ---------------------------------------------------------------------------

/**
 * Convert a SchemaDef into an ordered array of SQL DDL statements.
 *
 * Returns CREATE TABLE statements (in dependency order based on references)
 * followed by CREATE INDEX statements for foreign key columns.
 */
export function schemaToSQL(schema: SchemaDef): string[] {
  const statements: string[] = [];

  // Topologically sort tables by their foreign key references
  const sorted = topologicalSort(schema);

  // Generate CREATE TABLE statements
  for (const tableName of sorted) {
    const table = schema.tables[tableName]!;
    statements.push(generateCreateTable(table));
  }

  // Generate CREATE INDEX for foreign key columns
  for (const tableName of sorted) {
    const table = schema.tables[tableName]!;
    const indexes = generateForeignKeyIndexes(table);
    statements.push(...indexes);
  }

  return statements;
}

/**
 * Topologically sort tables so that referenced tables come before referencing ones.
 * Falls back to input order for tables with no dependency ordering.
 */
function topologicalSort(schema: SchemaDef): string[] {
  const tableNames = Object.keys(schema.tables);
  const resolved = new Set<string>();
  const result: string[] = [];
  const visiting = new Set<string>();

  function visit(name: string): void {
    if (resolved.has(name)) return;
    if (visiting.has(name)) {
      // Circular reference — just add it
      return;
    }
    visiting.add(name);

    const table = schema.tables[name];
    if (table) {
      // Visit all tables this table references
      for (const col of Object.values(table.columns)) {
        if (col.referencesTarget) {
          const refTable = col.referencesTarget.split('.')[0]!;
          if (refTable !== name && schema.tables[refTable]) {
            visit(refTable);
          }
        }
      }
    }

    visiting.delete(name);
    resolved.add(name);
    result.push(name);
  }

  for (const name of tableNames) {
    visit(name);
  }

  return result;
}

/**
 * Generate a CREATE TABLE statement for a single table definition.
 */
function generateCreateTable(table: TableDef): string {
  const tableName = table.name;
  const columnDefs: string[] = [];

  for (const [fieldName, config] of Object.entries(table.columns)) {
    columnDefs.push(generateColumnDef(fieldName, config));
  }

  const body = columnDefs.map((d) => `    ${d}`).join(',\n');
  return `CREATE TABLE ${quoteIdent(tableName)} (\n${body}\n);`;
}

/**
 * Generate a single column definition line (e.g. "id BIGSERIAL PRIMARY KEY").
 */
function generateColumnDef(fieldName: string, config: ColumnConfig): string {
  const snakeName = camelToSnake(fieldName);
  const parts: string[] = [quoteIdent(snakeName)];

  // Type
  if (config.type === 'VARCHAR' && config.maxLength != null) {
    parts.push(`VARCHAR(${config.maxLength})`);
  } else {
    parts.push(config.type);
  }

  // PRIMARY KEY
  if (config.isPrimaryKey) {
    parts.push('PRIMARY KEY');
  }

  // UNIQUE (only if not primary key — PK is implicitly unique)
  if (config.isUnique && !config.isPrimaryKey) {
    parts.push('UNIQUE');
  }

  // NOT NULL — serial types are implicitly NOT NULL, but explicit is fine.
  // A column is NOT NULL if:
  //   1. Explicitly marked .notNull(), OR
  //   2. Is a serial (BIGSERIAL implies NOT NULL), OR
  //   3. Has a primary key (PKs are NOT NULL)
  // A column is left nullable if .nullable() was called.
  const isSerial = config.type === 'BIGSERIAL';
  const implicitNotNull = isSerial || config.isPrimaryKey;
  if (config.isNotNull && !implicitNotNull) {
    parts.push('NOT NULL');
  }

  // DEFAULT
  if (config.defaultValue != null) {
    const sqlDefault = normalizeDefault(config.defaultValue);
    parts.push(`DEFAULT ${sqlDefault}`);
  }

  // REFERENCES
  if (config.referencesTarget) {
    const refParts = config.referencesTarget.split('.');
    if (refParts.length === 2) {
      parts.push(`REFERENCES ${quoteIdent(refParts[0]!)}(${quoteIdent(refParts[1]!)})`);
    }
  }

  return parts.join(' ');
}

/**
 * Normalize a default value from the user's schema definition to valid SQL.
 *
 * Examples:
 *   'now()'  → NOW()
 *   "'free'" → 'free'
 *   'false'  → false
 *   '0'      → 0
 */
function normalizeDefault(val: string): string {
  const upper = val.toUpperCase().trim();

  // Known SQL constants
  if (['TRUE', 'FALSE', 'NULL'].includes(upper)) {
    return upper;
  }

  // Known SQL function calls: NOW(), CURRENT_TIMESTAMP, CURRENT_DATE, CURRENT_TIME, GEN_RANDOM_UUID()
  const allowedFunctions = [
    'NOW()', 'CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME', 'GEN_RANDOM_UUID()',
  ];
  if (allowedFunctions.includes(upper)) {
    return upper;
  }

  // Numeric literals (integer or decimal, optionally negative)
  if (/^-?\d+(\.\d+)?$/.test(val.trim())) {
    return val.trim();
  }

  // Simple single-quoted string literals (no nested quotes)
  if (/^'[^']*'$/.test(val.trim())) {
    return val.trim();
  }

  throw new Error(
    `Unsupported default value: ${val}. Use a SQL function, numeric, string literal, or NULL.`,
  );
}

/**
 * Generate CREATE INDEX statements for foreign key columns.
 * Only generates indexes for columns that have a REFERENCES clause.
 */
function generateForeignKeyIndexes(table: TableDef): string[] {
  const indexes: string[] = [];

  for (const [fieldName, config] of Object.entries(table.columns)) {
    if (config.referencesTarget) {
      const snakeName = camelToSnake(fieldName);
      const indexName = `idx_${table.name}_${snakeName}`;
      indexes.push(
        `CREATE INDEX ${quoteIdent(indexName)} ON ${quoteIdent(table.name)}(${quoteIdent(snakeName)});`
      );
    }
  }

  return indexes;
}

// ---------------------------------------------------------------------------
// Schema Diff — compare SchemaDef against a live database
// ---------------------------------------------------------------------------

export interface AlterColumnDef {
  /** Column name in snake_case */
  column: string;
  /** What changed */
  action: 'add' | 'drop' | 'alter_type' | 'set_not_null' | 'drop_not_null' | 'set_default' | 'drop_default';
  /** SQL fragment for the alteration */
  sql: string;
}

export interface AlterDef {
  /** Table name */
  table: string;
  /** Column-level alterations */
  columns: AlterColumnDef[];
}

export interface DiffResult {
  /** Tables that exist in schema but not in DB — need CREATE TABLE */
  create: TableDef[];
  /** Tables that exist in both but differ — need ALTER TABLE */
  alter: AlterDef[];
  /** Table names that exist in DB but not in schema — would need DROP TABLE */
  drop: string[];
  /** SQL statements to execute the diff */
  statements: string[];
}

/**
 * Compare a SchemaDef against a live Postgres database and return the diff.
 *
 * Connects to the database, inspects the public schema, and computes what
 * DDL is needed to make the database match the schema definition.
 */
export async function schemaDiff(
  schema: SchemaDef,
  connectionString: string
): Promise<DiffResult> {
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    // Get existing tables in the public schema
    const tableResult = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
    );
    const existingTables = new Set(tableResult.rows.map((r) => r.tablename));

    // Get existing columns for all tables
    const columnResult = await client.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: string;
      column_default: string | null;
      character_maximum_length: number | null;
    }>(
      `SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default, character_maximum_length
       FROM information_schema.columns
       WHERE table_schema = 'public'
       ORDER BY table_name, ordinal_position`
    );

    const dbColumns: Record<
      string,
      Record<
        string,
        {
          dataType: string;
          udtName: string;
          isNullable: boolean;
          columnDefault: string | null;
          maxLength: number | null;
        }
      >
    > = {};
    for (const row of columnResult.rows) {
      if (!dbColumns[row.table_name]) {
        dbColumns[row.table_name] = {};
      }
      dbColumns[row.table_name]![row.column_name] = {
        dataType: row.data_type,
        udtName: row.udt_name,
        isNullable: row.is_nullable === 'YES',
        columnDefault: row.column_default,
        maxLength: row.character_maximum_length,
      };
    }

    const schemaTableNames = new Set(Object.keys(schema.tables));
    const result: DiffResult = { create: [], alter: [], drop: [], statements: [] };

    // Tables to create (in schema but not in DB)
    const sorted = topologicalSort(schema);
    for (const tableName of sorted) {
      if (!existingTables.has(tableName)) {
        const tableDef = schema.tables[tableName]!;
        result.create.push(tableDef);
        result.statements.push(generateCreateTable(tableDef));
        // Also add FK indexes
        result.statements.push(...generateForeignKeyIndexes(tableDef));
      }
    }

    // Tables to drop (in DB but not in schema)
    for (const existingTable of existingTables) {
      if (!schemaTableNames.has(existingTable)) {
        result.drop.push(existingTable);
        // We don't auto-generate DROP statements for safety
      }
    }

    // Tables to alter (exist in both)
    for (const tableName of sorted) {
      if (!existingTables.has(tableName)) continue;

      const tableDef = schema.tables[tableName]!;
      const dbCols = dbColumns[tableName] ?? {};
      const alterDef: AlterDef = { table: tableName, columns: [] };

      for (const [fieldName, config] of Object.entries(tableDef.columns)) {
        const snakeName = camelToSnake(fieldName);
        const dbCol = dbCols[snakeName];

        if (!dbCol) {
          // Column exists in schema but not in DB — ADD COLUMN
          const colDef = generateColumnDef(fieldName, config);
          const sql = `ALTER TABLE ${quoteIdent(tableName)} ADD COLUMN ${colDef};`;
          alterDef.columns.push({ column: snakeName, action: 'add', sql });
          result.statements.push(sql);
          continue;
        }

        // Check type mismatch
        const expectedUdt = schemaTypeToUdt(config);
        if (expectedUdt && dbCol.udtName !== expectedUdt) {
          const sqlType = config.type === 'VARCHAR' && config.maxLength
            ? `VARCHAR(${config.maxLength})`
            : config.type;
          const sql = `ALTER TABLE ${quoteIdent(tableName)} ALTER COLUMN ${quoteIdent(snakeName)} TYPE ${sqlType};`;
          alterDef.columns.push({ column: snakeName, action: 'alter_type', sql });
          result.statements.push(sql);
        }

        // Check NOT NULL mismatch
        const shouldBeNotNull =
          config.isNotNull || config.isPrimaryKey || config.type === 'BIGSERIAL';
        const isCurrentlyNullable = dbCol.isNullable;
        if (shouldBeNotNull && isCurrentlyNullable && !config.isNullable) {
          const sql = `ALTER TABLE ${quoteIdent(tableName)} ALTER COLUMN ${quoteIdent(snakeName)} SET NOT NULL;`;
          alterDef.columns.push({ column: snakeName, action: 'set_not_null', sql });
          result.statements.push(sql);
        } else if (!shouldBeNotNull && !isCurrentlyNullable && config.isNullable) {
          const sql = `ALTER TABLE ${quoteIdent(tableName)} ALTER COLUMN ${quoteIdent(snakeName)} DROP NOT NULL;`;
          alterDef.columns.push({ column: snakeName, action: 'drop_not_null', sql });
          result.statements.push(sql);
        }
      }

      // Check for columns in DB that are not in schema
      for (const dbColName of Object.keys(dbCols)) {
        const hasField = Object.entries(tableDef.columns).some(
          ([fieldName]) => camelToSnake(fieldName) === dbColName
        );
        if (!hasField) {
          const sql = `ALTER TABLE ${quoteIdent(tableName)} DROP COLUMN ${quoteIdent(dbColName)};`;
          alterDef.columns.push({ column: dbColName, action: 'drop', sql });
          // Don't auto-add drops to statements for safety — user must opt in
        }
      }

      if (alterDef.columns.length > 0) {
        result.alter.push(alterDef);
      }
    }

    return result;
  } finally {
    await client.end();
  }
}

/**
 * Map a schema column type to its expected PostgreSQL UDT name.
 */
function schemaTypeToUdt(config: ColumnConfig): string | null {
  const map: Record<string, string> = {
    BIGSERIAL: 'int8',
    BIGINT: 'int8',
    INTEGER: 'int4',
    SMALLINT: 'int2',
    TEXT: 'text',
    VARCHAR: 'varchar',
    BOOLEAN: 'bool',
    TIMESTAMPTZ: 'timestamptz',
    DATE: 'date',
    JSONB: 'jsonb',
    UUID: 'uuid',
    REAL: 'float4',
    'DOUBLE PRECISION': 'float8',
    NUMERIC: 'numeric',
    BYTEA: 'bytea',
  };
  return map[config.type] ?? null;
}

// ---------------------------------------------------------------------------
// Schema Push — execute the diff against a live database
// ---------------------------------------------------------------------------

export interface PushResult {
  /** Number of statements executed */
  statementsExecuted: number;
  /** The SQL statements that were run */
  statements: string[];
  /** Tables created */
  tablesCreated: string[];
  /** Tables altered */
  tablesAltered: string[];
}

/**
 * Push a schema definition to a live database.
 *
 * Computes the diff, then executes the resulting DDL statements in a
 * single transaction. This is a destructive operation for ADD/ALTER —
 * it will NOT drop tables or columns unless explicitly configured.
 */
export async function schemaPush(
  schema: SchemaDef,
  connectionString: string,
  options: { dryRun?: boolean } = {}
): Promise<PushResult> {
  const diff = await schemaDiff(schema, connectionString);

  const result: PushResult = {
    statementsExecuted: 0,
    statements: diff.statements,
    tablesCreated: diff.create.map((t) => t.name),
    tablesAltered: diff.alter.map((a) => a.table),
  };

  if (options.dryRun || diff.statements.length === 0) {
    return result;
  }

  // Execute all statements in a transaction
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    await client.query('BEGIN');
    for (const sql of diff.statements) {
      await client.query(sql);
      result.statementsExecuted++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }

  return result;
}

// ---------------------------------------------------------------------------
// Utility: format schema as SQL string (convenience for debugging/printing)
// ---------------------------------------------------------------------------

/**
 * Generate the full DDL as a single formatted string.
 * Useful for printing or saving to a .sql file.
 */
export function schemaToSQLString(schema: SchemaDef): string {
  const statements = schemaToSQL(schema);
  return statements.join('\n\n') + '\n';
}
