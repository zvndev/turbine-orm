/**
 * turbine-orm — Schema SQL Generator
 *
 * Converts a SchemaDef (from defineSchema) into executable DDL statements.
 * Also provides diff and push commands for syncing schema to a live database.
 */

import pg from 'pg';
import { quoteIdent } from './query.js';
import { camelToSnake } from './schema.js';
import type { ColumnConfig, SchemaDef, TableDef } from './schema-builder.js';

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
  const resolveRef = makeRefResolver(schema);

  // Generate CREATE TABLE statements
  for (const tableName of sorted) {
    const table = schema.tables[tableName]!;
    statements.push(generateCreateTable(table, resolveRef));
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
 * Build a function that resolves a raw `references: 'foo.id'` target name
 * to the snake_case DDL table name. Accepts both the JS-facing camelCase
 * accessor name and the snake_case DDL name; passes through unknown names
 * unchanged so existing call sites continue to work.
 */
function makeRefResolver(schema: SchemaDef): (rawName: string) => string {
  const lookup = buildTableLookup(schema);
  return (rawName: string): string => {
    const key = lookup[rawName];
    if (key) {
      const def = schema.tables[key];
      if (def?.name) return def.name;
    }
    return rawName;
  };
}

/**
 * Build a lookup index from both DDL names (snake_case) and JS accessor
 * names (camelCase) to table keys, so `references: 'post_tags.id'` and
 * `references: 'postTags.id'` both resolve to the same TableDef.
 */
function buildTableLookup(schema: SchemaDef): Record<string, string> {
  const lookup: Record<string, string> = {};
  for (const [key, def] of Object.entries(schema.tables)) {
    lookup[key] = key;
    if (def.name && def.name !== key) lookup[def.name] = key;
    if (def.accessor && def.accessor !== key) lookup[def.accessor] = key;
  }
  return lookup;
}

/**
 * Topologically sort tables so that referenced tables come before referencing ones.
 * Returns the table keys (the same keys used in `schema.tables`). The keys are
 * the JS-facing accessor names; consumers should still call `table.name` to get
 * the snake_case DDL name when emitting SQL.
 *
 * Falls back to input order for tables with no dependency ordering.
 */
function topologicalSort(schema: SchemaDef): string[] {
  const tableNames = Object.keys(schema.tables);
  const lookup = buildTableLookup(schema);
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
          const refRaw = col.referencesTarget.split('.')[0]!;
          const refKey = lookup[refRaw];
          if (refKey && refKey !== name) {
            visit(refKey);
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
 *
 * If `table.primaryKey` is set (composite primary key), emits a table-level
 * `PRIMARY KEY ("col1", "col2", ...)` constraint instead of column-level
 * `PRIMARY KEY` clauses on each member column. The composite PK column
 * names are camelCase JS field names; they are converted to snake_case
 * here.
 *
 * `resolveRef` (when supplied) maps raw `references: 'foo.id'` table names
 * to their snake_case DDL form, so users can write either camelCase JS
 * accessor names or snake_case DDL names.
 */
function generateCreateTable(table: TableDef, resolveRef?: (raw: string) => string): string {
  const tableName = table.name;
  const columnDefs: string[] = [];
  const compositePk = table.primaryKey && table.primaryKey.length > 0 ? table.primaryKey : null;

  for (const [fieldName, config] of Object.entries(table.columns)) {
    columnDefs.push(generateColumnDef(fieldName, config, resolveRef));
  }

  // Append a table-level PRIMARY KEY constraint when a composite PK is set.
  if (compositePk) {
    const cols = compositePk.map((c) => quoteIdent(camelToSnake(c))).join(', ');
    columnDefs.push(`PRIMARY KEY (${cols})`);
  }

  const body = columnDefs.map((d) => `    ${d}`).join(',\n');
  return `CREATE TABLE ${quoteIdent(tableName)} (\n${body}\n);`;
}

/**
 * Generate a single column definition line (e.g. "id BIGSERIAL PRIMARY KEY").
 */
function generateColumnDef(fieldName: string, config: ColumnConfig, resolveRef?: (raw: string) => string): string {
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

  // REFERENCES — resolve the raw table name through the optional resolver so
  // both camelCase accessor names and snake_case DDL names work.
  if (config.referencesTarget) {
    const refParts = config.referencesTarget.split('.');
    if (refParts.length === 2) {
      const rawTable = refParts[0]!;
      const refTable = resolveRef ? resolveRef(rawTable) : rawTable;
      parts.push(`REFERENCES ${quoteIdent(refTable)}(${quoteIdent(refParts[1]!)})`);
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
  const allowedFunctions = ['NOW()', 'CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME', 'GEN_RANDOM_UUID()'];
  if (allowedFunctions.includes(upper)) {
    return upper;
  }

  // Numeric literals (integer or decimal, optionally negative)
  if (/^-?\d+(\.\d+)?$/.test(val.trim())) {
    return val.trim();
  }

  // Simple single-quoted string literals (no semicolons, no SQL statement keywords)
  if (/^'[^']*'$/.test(val.trim())) {
    const inner = val.trim().slice(1, -1);
    if (/[;]/.test(inner) || /\b(DROP|ALTER|CREATE|INSERT|UPDATE|DELETE|GRANT|REVOKE|TRUNCATE)\b/i.test(inner)) {
      throw new Error(`Suspicious default value: ${val}. String literals must not contain SQL statements.`);
    }
    return val.trim();
  }

  throw new Error(`Unsupported default value: ${val}. Use a SQL function, numeric, string literal, or NULL.`);
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
      indexes.push(`CREATE INDEX ${quoteIdent(indexName)} ON ${quoteIdent(table.name)}(${quoteIdent(snakeName)});`);
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
  action:
    | 'add'
    | 'drop'
    | 'alter_type'
    | 'set_not_null'
    | 'drop_not_null'
    | 'set_default'
    | 'drop_default'
    | 'add_unique'
    | 'drop_unique';
  /** SQL fragment for the alteration */
  sql: string;
  /** SQL to reverse this change (for DOWN migrations) */
  reverseSql: string;
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
  /** SQL statements to execute the diff (UP direction) */
  statements: string[];
  /** SQL statements to reverse the diff (DOWN direction, for migrations) */
  reverseStatements: string[];
}

/**
 * Compare a SchemaDef against a live Postgres database and return the diff.
 *
 * Connects to the database, inspects the public schema, and computes what
 * DDL is needed to make the database match the schema definition.
 */
export async function schemaDiff(schema: SchemaDef, connectionString: string): Promise<DiffResult> {
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    // Get existing tables in the public schema
    const tableResult = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
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
       ORDER BY table_name, ordinal_position`,
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

    // Get single-column UNIQUE constraints (excluding PKs)
    const uniqueResult = await client.query<{
      table_name: string;
      constraint_name: string;
      column_name: string;
    }>(
      `SELECT tc.table_name, tc.constraint_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
       WHERE tc.table_schema = 'public'
         AND tc.constraint_type = 'UNIQUE'
         AND tc.constraint_name IN (
           SELECT constraint_name
           FROM information_schema.key_column_usage
           WHERE table_schema = 'public'
           GROUP BY constraint_name
           HAVING COUNT(*) = 1
         )`,
    );

    // Map: table → column → constraint_name for single-col uniques
    const dbUniques: Record<string, Record<string, string>> = {};
    for (const row of uniqueResult.rows) {
      if (!dbUniques[row.table_name]) dbUniques[row.table_name] = {};
      dbUniques[row.table_name]![row.column_name] = row.constraint_name;
    }

    // Build a set of DDL-facing snake_case table names that the schema defines.
    const schemaDdlNames = new Set<string>();
    for (const def of Object.values(schema.tables)) schemaDdlNames.add(def.name);
    const result: DiffResult = { create: [], alter: [], drop: [], statements: [], reverseStatements: [] };
    const resolveRef = makeRefResolver(schema);

    // Tables to create (in schema but not in DB)
    const sorted = topologicalSort(schema);
    for (const tableKey of sorted) {
      const tableDef = schema.tables[tableKey]!;
      const ddlName = tableDef.name;
      if (!existingTables.has(ddlName)) {
        result.create.push(tableDef);
        result.statements.push(generateCreateTable(tableDef, resolveRef));
        const fkIndexes = generateForeignKeyIndexes(tableDef);
        result.statements.push(...fkIndexes);
        // Reverse: DROP TABLE (with indexes — they drop automatically)
        result.reverseStatements.unshift(`DROP TABLE IF EXISTS ${quoteIdent(ddlName)} CASCADE;`);
      }
    }

    // Tables to drop (in DB but not in schema)
    for (const existingTable of existingTables) {
      if (!schemaDdlNames.has(existingTable)) {
        result.drop.push(existingTable);
        // We don't auto-generate DROP statements for safety
      }
    }

    // Tables to alter (exist in both)
    for (const tableKey of sorted) {
      const tableDef = schema.tables[tableKey]!;
      const tableName = tableDef.name;
      if (!existingTables.has(tableName)) continue;

      const dbCols = dbColumns[tableName] ?? {};
      const tableUniques = dbUniques[tableName] ?? {};
      const alterDef: AlterDef = { table: tableName, columns: [] };

      for (const [fieldName, config] of Object.entries(tableDef.columns)) {
        const snakeName = camelToSnake(fieldName);
        const dbCol = dbCols[snakeName];

        if (!dbCol) {
          // Column exists in schema but not in DB — ADD COLUMN
          const colDef = generateColumnDef(fieldName, config, resolveRef);
          const sql = `ALTER TABLE ${quoteIdent(tableName)} ADD COLUMN ${colDef};`;
          const reverseSql = `ALTER TABLE ${quoteIdent(tableName)} DROP COLUMN ${quoteIdent(snakeName)};`;
          alterDef.columns.push({ column: snakeName, action: 'add', sql, reverseSql });
          result.statements.push(sql);
          result.reverseStatements.unshift(reverseSql);
          continue;
        }

        // Check type mismatch
        const expectedUdt = schemaTypeToUdt(config);
        if (expectedUdt && dbCol.udtName !== expectedUdt) {
          const sqlType = config.type === 'VARCHAR' && config.maxLength ? `VARCHAR(${config.maxLength})` : config.type;
          const oldSqlType = udtToSqlType(dbCol.udtName, dbCol.maxLength);
          const sql = `ALTER TABLE ${quoteIdent(tableName)} ALTER COLUMN ${quoteIdent(snakeName)} TYPE ${sqlType} USING ${quoteIdent(snakeName)}::${sqlType};`;
          const reverseSql = `ALTER TABLE ${quoteIdent(tableName)} ALTER COLUMN ${quoteIdent(snakeName)} TYPE ${oldSqlType} USING ${quoteIdent(snakeName)}::${oldSqlType};`;
          alterDef.columns.push({ column: snakeName, action: 'alter_type', sql, reverseSql });
          result.statements.push(sql);
          result.reverseStatements.unshift(reverseSql);
        }

        // Check NOT NULL mismatch
        const shouldBeNotNull = config.isNotNull || config.isPrimaryKey || config.type === 'BIGSERIAL';
        const isCurrentlyNullable = dbCol.isNullable;
        if (shouldBeNotNull && isCurrentlyNullable && !config.isNullable) {
          const sql = `ALTER TABLE ${quoteIdent(tableName)} ALTER COLUMN ${quoteIdent(snakeName)} SET NOT NULL;`;
          const reverseSql = `ALTER TABLE ${quoteIdent(tableName)} ALTER COLUMN ${quoteIdent(snakeName)} DROP NOT NULL;`;
          alterDef.columns.push({ column: snakeName, action: 'set_not_null', sql, reverseSql });
          result.statements.push(sql);
          result.reverseStatements.unshift(reverseSql);
        } else if (!shouldBeNotNull && !isCurrentlyNullable && config.isNullable) {
          const sql = `ALTER TABLE ${quoteIdent(tableName)} ALTER COLUMN ${quoteIdent(snakeName)} DROP NOT NULL;`;
          const reverseSql = `ALTER TABLE ${quoteIdent(tableName)} ALTER COLUMN ${quoteIdent(snakeName)} SET NOT NULL;`;
          alterDef.columns.push({ column: snakeName, action: 'drop_not_null', sql, reverseSql });
          result.statements.push(sql);
          result.reverseStatements.unshift(reverseSql);
        }

        // Check DEFAULT value mismatch
        const isSerial = config.type === 'BIGSERIAL';
        if (!isSerial) {
          const schemaDefault = config.defaultValue ? normalizeDefault(config.defaultValue) : null;
          const dbDefault = dbCol.columnDefault;

          if (schemaDefault && !dbDefault) {
            // Schema has default, DB doesn't
            const sql = `ALTER TABLE ${quoteIdent(tableName)} ALTER COLUMN ${quoteIdent(snakeName)} SET DEFAULT ${schemaDefault};`;
            const reverseSql = `ALTER TABLE ${quoteIdent(tableName)} ALTER COLUMN ${quoteIdent(snakeName)} DROP DEFAULT;`;
            alterDef.columns.push({ column: snakeName, action: 'set_default', sql, reverseSql });
            result.statements.push(sql);
            result.reverseStatements.unshift(reverseSql);
          } else if (!schemaDefault && dbDefault && !isSequenceDefault(dbDefault)) {
            // DB has a non-sequence default, schema doesn't
            const sql = `ALTER TABLE ${quoteIdent(tableName)} ALTER COLUMN ${quoteIdent(snakeName)} DROP DEFAULT;`;
            const reverseSql = `ALTER TABLE ${quoteIdent(tableName)} ALTER COLUMN ${quoteIdent(snakeName)} SET DEFAULT ${dbDefault};`;
            alterDef.columns.push({ column: snakeName, action: 'drop_default', sql, reverseSql });
            result.statements.push(sql);
            result.reverseStatements.unshift(reverseSql);
          } else if (
            schemaDefault &&
            dbDefault &&
            !isSequenceDefault(dbDefault) &&
            !defaultsMatch(schemaDefault, dbDefault)
          ) {
            // Both have defaults but they differ
            const sql = `ALTER TABLE ${quoteIdent(tableName)} ALTER COLUMN ${quoteIdent(snakeName)} SET DEFAULT ${schemaDefault};`;
            const reverseSql = `ALTER TABLE ${quoteIdent(tableName)} ALTER COLUMN ${quoteIdent(snakeName)} SET DEFAULT ${dbDefault};`;
            alterDef.columns.push({ column: snakeName, action: 'set_default', sql, reverseSql });
            result.statements.push(sql);
            result.reverseStatements.unshift(reverseSql);
          }
        }

        // Check UNIQUE constraint mismatch (skip PKs — they're implicitly unique)
        if (!config.isPrimaryKey) {
          const hasDbUnique = snakeName in tableUniques;
          const wantsUnique = config.isUnique === true;

          if (wantsUnique && !hasDbUnique) {
            const constraintName = `${tableName}_${snakeName}_key`;
            const sql = `ALTER TABLE ${quoteIdent(tableName)} ADD CONSTRAINT ${quoteIdent(constraintName)} UNIQUE (${quoteIdent(snakeName)});`;
            const reverseSql = `ALTER TABLE ${quoteIdent(tableName)} DROP CONSTRAINT ${quoteIdent(constraintName)};`;
            alterDef.columns.push({ column: snakeName, action: 'add_unique', sql, reverseSql });
            result.statements.push(sql);
            result.reverseStatements.unshift(reverseSql);
          } else if (!wantsUnique && hasDbUnique) {
            const constraintName = tableUniques[snakeName]!;
            const sql = `ALTER TABLE ${quoteIdent(tableName)} DROP CONSTRAINT ${quoteIdent(constraintName)};`;
            const reverseSql = `ALTER TABLE ${quoteIdent(tableName)} ADD CONSTRAINT ${quoteIdent(constraintName)} UNIQUE (${quoteIdent(snakeName)});`;
            alterDef.columns.push({ column: snakeName, action: 'drop_unique', sql, reverseSql });
            result.statements.push(sql);
            result.reverseStatements.unshift(reverseSql);
          }
        }
      }

      // Check for columns in DB that are not in schema
      for (const dbColName of Object.keys(dbCols)) {
        const hasField = Object.entries(tableDef.columns).some(([fieldName]) => camelToSnake(fieldName) === dbColName);
        if (!hasField) {
          const sql = `ALTER TABLE ${quoteIdent(tableName)} DROP COLUMN ${quoteIdent(dbColName)};`;
          const reverseSql = `-- Cannot auto-reverse DROP COLUMN for "${dbColName}" — add it back manually`;
          alterDef.columns.push({ column: dbColName, action: 'drop', sql, reverseSql });
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

/**
 * Reverse map: PostgreSQL UDT name → SQL type (for generating reverse ALTER TYPE).
 */
function udtToSqlType(udtName: string, maxLength: number | null): string {
  const map: Record<string, string> = {
    int8: 'BIGINT',
    int4: 'INTEGER',
    int2: 'SMALLINT',
    text: 'TEXT',
    varchar: maxLength ? `VARCHAR(${maxLength})` : 'VARCHAR',
    bool: 'BOOLEAN',
    timestamptz: 'TIMESTAMPTZ',
    date: 'DATE',
    jsonb: 'JSONB',
    uuid: 'UUID',
    float4: 'REAL',
    float8: 'DOUBLE PRECISION',
    numeric: 'NUMERIC',
    bytea: 'BYTEA',
  };
  return map[udtName] ?? udtName.toUpperCase();
}

/**
 * Normalize a database default value for comparison.
 * Strips PostgreSQL type casts (e.g. 'free'::text → 'free') and wrapping parens.
 */
function normalizeDbDefault(dbDefault: string): string {
  let val = dbDefault;
  // Strip type casts: 'free'::text → 'free', 0::integer → 0
  val = val.replace(/::[\w\s"]+(\[\])?$/g, '').trim();
  // Unwrap parens added by PostgreSQL: ('free') → 'free'
  while (val.startsWith('(') && val.endsWith(')')) {
    val = val.slice(1, -1).trim();
  }
  return val;
}

/** Check if a DB default is a sequence default (auto-generated for serial columns). */
function isSequenceDefault(dbDefault: string): boolean {
  return dbDefault.includes('nextval(');
}

/**
 * Compare a schema default against a database default, accounting for
 * PostgreSQL's normalization of default values.
 */
function defaultsMatch(schemaDefault: string, dbDefault: string): boolean {
  const a = schemaDefault.toLowerCase().trim();
  const b = normalizeDbDefault(dbDefault).toLowerCase().trim();
  return a === b;
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
  options: { dryRun?: boolean } = {},
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
  return `${statements.join('\n\n')}\n`;
}
