/**
 * turbine-orm, Schema SQL Generator
 *
 * Converts a SchemaDef (from defineSchema) into executable DDL statements.
 * Also provides diff and push commands for syncing schema to a live database.
 */

import pg from 'pg';
import { DESTRUCTIVE_KIND_LABEL, type DestructiveStatement, scanDestructiveSql } from './cli/destructive.js';
import { type Dialect, postgresDialect } from './dialect.js';
import { UnsupportedFeatureError, ValidationError } from './errors.js';
import { pgConfActionToReferential, stripCheckWrapper } from './introspect.js';
import { camelToSnake, type ReferentialAction } from './schema.js';
import {
  type ColumnConfig,
  type ColumnIndexDef,
  isDocFieldIndexDef,
  type SchemaDef,
  type TableDef,
} from './schema-builder.js';

export interface SchemaSqlOptions {
  /** SQL dialect used for DDL generation. Defaults to PostgreSQL. */
  dialect?: Dialect;
  /**
   * How to handle the pgvector extension when the schema contains a `vector`
   * column. `'auto'` (default) prepends `CREATE EXTENSION IF NOT EXISTS vector;`
   * - appropriate for `push`. `'manual'` emits a leading comment only, so the
   * generated `.sql` migration doesn't silently require superuser privileges.
   */
  extensions?: 'auto' | 'manual';
}

/** Map a {@link ReferentialAction} to its SQL keyword form. */
export function referentialActionToSql(action: ReferentialAction): string {
  switch (action) {
    case 'cascade':
      return 'CASCADE';
    case 'restrict':
      return 'RESTRICT';
    case 'set null':
      return 'SET NULL';
    case 'set default':
      return 'SET DEFAULT';
    case 'no action':
      return 'NO ACTION';
  }
}

/** Single-quote-escape an enum label for a `CREATE TYPE ... AS ENUM` literal. */
function quoteEnumLabel(label: string): string {
  return `'${label.replace(/'/g, "''")}'`;
}

/**
 * Whether a resolved column type is an auto-increment pseudo-type (SERIAL /
 * BIGSERIAL). These carry an implicit sequence default and NOT NULL, and their
 * underlying integer width (int4 vs int8) is never auto-migrated by diff, a
 * width change on a live PK is destructive and must be done by hand.
 */
function isSerialType(type: string): boolean {
  return type === 'SERIAL' || type === 'BIGSERIAL';
}

/** Whether any column in the schema is a pgvector column. */
function schemaHasVectorColumn(schema: SchemaDef): boolean {
  for (const table of Object.values(schema.tables)) {
    for (const col of Object.values(table.columns)) {
      if (col.vectorDimensions != null) return true;
    }
  }
  return false;
}

/** Build a `CREATE TYPE "<name>" AS ENUM ('a', 'b')` statement. */
function generateCreateEnumType(enumName: string, labels: readonly string[], dialect: Dialect): string {
  const values = labels.map(quoteEnumLabel).join(', ');
  return `CREATE TYPE ${dialect.quoteIdentifier(enumName)} AS ENUM (${values});`;
}

/**
 * Resolve the DDL type token for a column: an enum type name, a `vector(n)`
 * literal, or the dialect's scalar type, with a trailing `[]` for arrays.
 *
 * `vectorDimensions` is the one number interpolated into the type token, so it
 * is validated here as a positive integer within pgvector's limit rather than
 * being trusted to be numeric.
 */
function resolveDdlType(config: ColumnConfig, dialect: Dialect, columnName: string): string {
  let base: string;
  if (config.enumName) {
    base = dialect.quoteIdentifier(config.enumName);
  } else if (config.vectorDimensions != null) {
    const dims = config.vectorDimensions;
    // pgvector caps a `vector` column at 16000 dimensions.
    if (typeof dims !== 'number' || !Number.isInteger(dims) || dims < 1 || dims > 16000) {
      throw new ValidationError(
        `[turbine] Column "${columnName}": vector dimensions must be an integer between 1 and 16000, got ${String(dims)}.`,
      );
    }
    base = `vector(${dims})`;
  } else {
    base = dialect.buildColumnType({ type: config.type, maxLength: config.maxLength });
  }
  return config.isArray ? `${base}[]` : base;
}

// ---------------------------------------------------------------------------
// SQL Generation, SchemaDef → CREATE TABLE statements
// ---------------------------------------------------------------------------

/**
 * Convert a SchemaDef into an ordered array of SQL DDL statements.
 *
 * Returns CREATE TABLE statements (in dependency order based on references)
 * followed by CREATE INDEX statements for foreign key columns.
 */
export function schemaToSQL(schema: SchemaDef, options?: SchemaSqlOptions): string[] {
  const dialect = options?.dialect ?? postgresDialect;
  const extensions = options?.extensions ?? 'auto';
  const statements: string[] = [];

  // Topologically sort tables by their foreign key references
  const sorted = topologicalSort(schema);
  const resolveRef = makeRefResolver(schema);

  // pgvector extension line, only when a vector column exists. Postgres-only:
  // a dialect that can't do pgvector must not silently emit broken DDL.
  if (schemaHasVectorColumn(schema)) {
    if (!dialect.supportsVector) {
      throw new UnsupportedFeatureError('vector columns', dialect.name, 'pgvector is a PostgreSQL-only feature.');
    }
    statements.push(
      extensions === 'manual'
        ? '-- Requires the pgvector extension: run `CREATE EXTENSION IF NOT EXISTS vector;` before applying.'
        : 'CREATE EXTENSION IF NOT EXISTS vector;',
    );
  }

  // CREATE TYPE for every schema-level enum, before the tables that use them.
  for (const [enumName, labels] of Object.entries(schema.enums ?? {})) {
    statements.push(generateCreateEnumType(enumName, labels, dialect));
  }

  // Generate CREATE TABLE statements
  for (const tableName of sorted) {
    const table = schema.tables[tableName]!;
    statements.push(generateCreateTable(table, resolveRef, dialect));
  }

  // Generate CREATE INDEX for foreign key columns
  for (const tableName of sorted) {
    const table = schema.tables[tableName]!;
    const indexes = generateForeignKeyIndexes(table, dialect);
    statements.push(...indexes);
  }

  // Generate CREATE INDEX / CREATE UNIQUE INDEX for user-declared indexes.
  for (const tableName of sorted) {
    const table = schema.tables[tableName]!;
    statements.push(...generateDeclaredIndexes(table, dialect));
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
      // Circular reference, just add it
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
function generateCreateTable(
  table: TableDef,
  resolveRef?: (raw: string) => string,
  dialect: Dialect = postgresDialect,
): string {
  const tableName = table.name;
  const columnDefs: string[] = [];
  const compositePk = table.primaryKey && table.primaryKey.length > 0 ? table.primaryKey : null;

  for (const [fieldName, config] of Object.entries(table.columns)) {
    columnDefs.push(generateColumnDef(fieldName, config, resolveRef, dialect));
  }

  // Append a table-level PRIMARY KEY constraint when a composite PK is set.
  if (compositePk) {
    const cols = compositePk.map((c) => dialect.quoteIdentifier(camelToSnake(c)));
    columnDefs.push(dialect.buildPrimaryKeyConstraint(cols));
  }

  // Table-level CHECK constraints (named → CONSTRAINT "name" CHECK (...)).
  // The constraint NAME is quoted; the EXPRESSION is raw SQL emitted verbatim
  // by design (see the CheckSpec.expression contract) and must never be built
  // from untrusted input.
  for (const chk of table.checks ?? []) {
    columnDefs.push(
      chk.name
        ? `CONSTRAINT ${dialect.quoteIdentifier(chk.name)} CHECK (${chk.expression})`
        : `CHECK (${chk.expression})`,
    );
  }

  return dialect.buildCreateTableStatement({
    table: dialect.quoteIdentifier(tableName),
    definitions: columnDefs,
  });
}

/**
 * Generate a single column definition line (e.g. "id BIGSERIAL PRIMARY KEY").
 */
function generateColumnDef(
  fieldName: string,
  config: ColumnConfig,
  resolveRef?: (raw: string) => string,
  dialect: Dialect = postgresDialect,
): string {
  const snakeName = camelToSnake(fieldName);

  // NOT NULL, serial types are implicitly NOT NULL, but explicit is fine.
  // A column is NOT NULL if:
  //   1. Explicitly marked .notNull(), OR
  //   2. Is a serial (BIGSERIAL implies NOT NULL), OR
  //   3. Has a primary key (PKs are NOT NULL)
  // A column is left nullable if .nullable() was called.
  const isSerial = isSerialType(config.type);
  const implicitNotNull = isSerial || config.isPrimaryKey;
  const notNull = config.isNotNull && !implicitNotNull;

  // DEFAULT
  let defaultValue: string | undefined;
  if (config.defaultValue != null) {
    defaultValue = normalizeDefault(config.defaultValue);
  }

  // REFERENCES, resolve the raw table name through the optional resolver so
  // both camelCase accessor names and snake_case DDL names work.
  let references: { table: string; column: string } | undefined;
  if (config.referencesTarget) {
    const refParts = config.referencesTarget.split('.');
    if (refParts.length === 2) {
      const rawTable = refParts[0]!;
      const refTable = resolveRef ? resolveRef(rawTable) : rawTable;
      references = {
        table: dialect.quoteIdentifier(refTable),
        column: dialect.quoteIdentifier(refParts[1]!),
      };
    }
  }

  // Resolve the DDL type (enum name / vector(n) / scalar, plus [] for arrays).
  // Passed as a fully-formed `type` token with no maxLength so the dialect
  // doesn't re-apply VARCHAR(n) on top of it.
  const ddlType = resolveDdlType(config, dialect, snakeName);

  let def = dialect.buildColumnDefinition({
    name: dialect.quoteIdentifier(snakeName),
    type: ddlType,
    maxLength: null,
    primaryKey: config.isPrimaryKey,
    unique: config.isUnique,
    notNull,
    defaultValue,
    references,
  });

  // Referential actions follow the REFERENCES clause (which buildColumnDefinition
  // emits last). Postgres omits ON DELETE/UPDATE for the default NO ACTION.
  if (references) {
    if (config.onDelete) def += ` ON DELETE ${referentialActionToSql(config.onDelete)}`;
    if (config.onUpdate) def += ` ON UPDATE ${referentialActionToSql(config.onUpdate)}`;
  }

  // Column-level CHECK constraint. The expression is RAW SQL authored in the
  // schema and is emitted verbatim by design (a DDL builder cannot parse or
  // parameterize a boolean expression); never build it from untrusted input.
  if (config.check) {
    def += ` CHECK (${config.check})`;
  }

  return def;
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
function generateForeignKeyIndexes(table: TableDef, dialect: Dialect = postgresDialect): string[] {
  const indexes: string[] = [];
  // A declared index whose deterministic name matches the auto FK-index name
  // takes precedence (it may be UNIQUE); emitting both would fail at apply time
  // with "relation already exists".
  const declared = declaredPlainIndexNames(table);

  for (const [fieldName, config] of Object.entries(table.columns)) {
    if (config.referencesTarget) {
      const snakeName = camelToSnake(fieldName);
      const indexName = `idx_${table.name}_${snakeName}`;
      if (declared.has(indexName)) continue;
      indexes.push(
        dialect.buildCreateIndexStatement({
          name: dialect.quoteIdentifier(indexName),
          table: dialect.quoteIdentifier(table.name),
          columns: [dialect.quoteIdentifier(snakeName)],
        }),
      );
    }
  }

  return indexes;
}

/**
 * The deterministic SQL index name for a declared plain (column-list) index:
 * the user-supplied `name`, else `idx_<table>_<col1>_<col2>...`, mirroring the
 * FK-index convention in {@link generateForeignKeyIndexes}.
 */
function declaredIndexName(tableName: string, idx: ColumnIndexDef): string {
  if (idx.name) return idx.name;
  const cols = idx.columns.map(camelToSnake);
  return `idx_${tableName}_${cols.join('_')}`;
}

/**
 * Compare a declared plain index against a pg_indexes `indexdef` string.
 * Returns a human-readable description of the first mismatch (uniqueness or
 * column list), or null when the definitions agree. Expression/partial indexes
 * in the DB never structurally match a plain column list, which is the
 * intended outcome: the operator gets a warning rather than a silent skip.
 */
export function describeIndexDefMismatch(idx: ColumnIndexDef, indexdef: string): string | null {
  const dbUnique = /^\s*CREATE\s+UNIQUE\s+INDEX\b/i.test(indexdef);
  const wantUnique = idx.unique === true;
  if (dbUnique !== wantUnique) {
    return wantUnique
      ? 'declared UNIQUE, existing index is not unique'
      : 'existing index is UNIQUE, declaration is not';
  }
  // pg_indexes.indexdef always reads `CREATE [UNIQUE] INDEX name ON tbl
  // USING method (col, ...) [WHERE ...]`; anchor on the USING clause so a
  // partial index's WHERE parentheses are never mistaken for the column list.
  const parenMatch = indexdef.match(/USING\s+\w+\s*\(([^)]*)\)/i) ?? indexdef.match(/\(([^)]*)\)/);
  const dbCols = parenMatch
    ? parenMatch[1]!.split(',').map((c) =>
        c
          .trim()
          .replace(/\s+(ASC|DESC|NULLS\s+(FIRST|LAST))\b/gi, '')
          .replace(/^"(.*)"$/, '$1')
          .trim(),
      )
    : [];
  const wantCols = idx.columns.map(camelToSnake);
  if (dbCols.length !== wantCols.length || dbCols.some((c, i) => c !== wantCols[i])) {
    return `declared columns (${wantCols.join(', ')}) differ from existing (${dbCols.join(', ') || 'unparsed'})`;
  }
  if (/\bWHERE\b/i.test(indexdef)) return 'existing index is partial (has a WHERE clause)';
  return null;
}

/**
 * Pure decision for the "index exists in the DB but is not declared" warning
 * pass. Extracted so the scope rule is unit-testable without a live database.
 *
 * The pass runs only when the table opts into index management by DEFINING an
 * `indexes` array (`indexesDefined: true`), even when that array is empty or
 * all-doc-field: deleting the last declared index must NOT silence the pass.
 * Tables with no `indexes` key stay silent (the user is not managing indexes
 * there). Recognized names (declared, unique-constraint / FK-column, `*_pkey`)
 * are never flagged; everything else in the DB yields one warning.
 */
export function undeclaredIndexWarnings(opts: {
  tableName: string;
  indexesDefined: boolean;
  dbIndexNames: Iterable<string>;
  declaredNames: ReadonlySet<string>;
  recognizedNames: ReadonlySet<string>;
}): string[] {
  if (!opts.indexesDefined) return [];
  const out: string[] = [];
  for (const dbIdxName of opts.dbIndexNames) {
    if (opts.declaredNames.has(dbIdxName) || opts.recognizedNames.has(dbIdxName) || dbIdxName.endsWith('_pkey')) {
      continue;
    }
    out.push(
      `index "${dbIdxName}" on "${opts.tableName}" exists in the database but is not declared in the schema. ` +
        `Turbine does not drop indexes automatically; drop it in a manual migration if it is no longer needed.`,
    );
  }
  return out;
}

/** The deterministic SQL names of every declared plain index on a table. */
function declaredPlainIndexNames(table: TableDef): Set<string> {
  const names = new Set<string>();
  for (const idx of table.indexes ?? []) {
    if (isDocFieldIndexDef(idx) || idx.columns.length === 0) continue;
    names.add(declaredIndexName(table.name, idx));
  }
  return names;
}

/**
 * Build the `CREATE [UNIQUE] INDEX` statement for a declared plain index.
 * `buildCreateIndexStatement` has no `unique` hook, so unique indexes are
 * emitted directly here (still fully identifier-quoted via the dialect).
 */
function buildDeclaredIndexStatement(tableName: string, idx: ColumnIndexDef, dialect: Dialect): string | null {
  const cols = idx.columns.map(camelToSnake);
  if (cols.length === 0) return null;
  const name = declaredIndexName(tableName, idx);
  const quotedCols = cols.map((c) => dialect.quoteIdentifier(c)).join(', ');
  const unique = idx.unique ? 'UNIQUE ' : '';
  return `CREATE ${unique}INDEX ${dialect.quoteIdentifier(name)} ON ${dialect.quoteIdentifier(tableName)}(${quotedCols});`;
}

/**
 * Generate `CREATE INDEX` / `CREATE UNIQUE INDEX` for a table's user-declared
 * plain-column indexes. PowDB doc-field expression indexes ({@link DocFieldIndexDef})
 * are skipped here (those stay PowDB-only, emitted by `powqlSchemaDDL`) and have
 * no SQL equivalent.
 */
function generateDeclaredIndexes(table: TableDef, dialect: Dialect = postgresDialect): string[] {
  const out: string[] = [];
  for (const idx of table.indexes ?? []) {
    if (isDocFieldIndexDef(idx)) continue; // PowDB-only, no SQL emission
    const stmt = buildDeclaredIndexStatement(table.name, idx, dialect);
    if (stmt) out.push(stmt);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Schema Diff, compare SchemaDef against a live database
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
  /** Tables that exist in schema but not in DB, need CREATE TABLE */
  create: TableDef[];
  /** Tables that exist in both but differ, need ALTER TABLE */
  alter: AlterDef[];
  /** Table names that exist in DB but not in schema, would need DROP TABLE */
  drop: string[];
  /** SQL statements to execute the diff (UP direction) */
  statements: string[];
  /** SQL statements to reverse the diff (DOWN direction, for migrations) */
  reverseStatements: string[];
  /**
   * Human-readable warnings for changes the diff detected but refuses to apply
   * automatically because they are destructive or otherwise unsafe (enum value
   * removal/reorder, etc.). Never executed, surfaced for the operator.
   */
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Pure diff helpers (no DB), unit-testable decision logic reused by schemaDiff
// ---------------------------------------------------------------------------

/** A FK's current referential actions as read from the DB. */
export interface DbForeignKey {
  constraintName: string;
  column: string;
  targetTable: string;
  targetColumn: string;
  onDelete: ReferentialAction;
  onUpdate: ReferentialAction;
}

/**
 * Build the `ADD CONSTRAINT ... FOREIGN KEY` statement for a FK with the given
 * referential actions. Default (`no action`) clauses are omitted, matching how
 * Postgres normalizes them, so re-diffing is stable.
 */
export function buildAddForeignKeyStatement(
  table: string,
  constraintName: string,
  column: string,
  targetTable: string,
  targetColumn: string,
  onDelete: ReferentialAction,
  onUpdate: ReferentialAction,
  dialect: Dialect = postgresDialect,
): string {
  const q = (s: string) => dialect.quoteIdentifier(s);
  let sql = `ALTER TABLE ${q(table)} ADD CONSTRAINT ${q(constraintName)} FOREIGN KEY (${q(column)}) REFERENCES ${q(targetTable)}(${q(targetColumn)})`;
  if (onDelete !== 'no action') sql += ` ON DELETE ${referentialActionToSql(onDelete)}`;
  if (onUpdate !== 'no action') sql += ` ON UPDATE ${referentialActionToSql(onUpdate)}`;
  return `${sql};`;
}

/**
 * Decide whether a FK's referential actions changed. When they differ, returns
 * the DROP + ADD CONSTRAINT statements (and their reverse), Postgres has no
 * `ALTER CONSTRAINT` for referential actions, so drop-and-recreate is the only
 * path. Returns null when the actions already match.
 */
export function diffReferentialAction(
  table: string,
  db: DbForeignKey,
  schemaOnDelete: ReferentialAction,
  schemaOnUpdate: ReferentialAction,
  dialect: Dialect = postgresDialect,
): { statements: string[]; reverseStatements: string[] } | null {
  if (db.onDelete === schemaOnDelete && db.onUpdate === schemaOnUpdate) return null;
  const q = (s: string) => dialect.quoteIdentifier(s);
  const drop = `ALTER TABLE ${q(table)} DROP CONSTRAINT ${q(db.constraintName)};`;
  const add = buildAddForeignKeyStatement(
    table,
    db.constraintName,
    db.column,
    db.targetTable,
    db.targetColumn,
    schemaOnDelete,
    schemaOnUpdate,
    dialect,
  );
  const reverseAdd = buildAddForeignKeyStatement(
    table,
    db.constraintName,
    db.column,
    db.targetTable,
    db.targetColumn,
    db.onDelete,
    db.onUpdate,
    dialect,
  );
  return { statements: [drop, add], reverseStatements: [drop, reverseAdd] };
}

/**
 * Compute append-only enum value changes. Returns `ALTER TYPE ... ADD VALUE`
 * statements for labels present in the schema but not the DB (in order), plus a
 * destructive warning for any DB label the schema dropped or any reorder -
 * Postgres cannot remove or reorder enum values without recreating the type.
 */
export function diffEnumValues(
  enumName: string,
  schemaLabels: readonly string[],
  dbLabels: readonly string[],
  dialect: Dialect = postgresDialect,
): { statements: string[]; warnings: string[] } {
  const statements: string[] = [];
  const warnings: string[] = [];
  const dbSet = new Set(dbLabels);
  for (const label of schemaLabels) {
    if (!dbSet.has(label)) {
      statements.push(`ALTER TYPE ${dialect.quoteIdentifier(enumName)} ADD VALUE ${quoteEnumLabel(label)};`);
    }
  }
  const schemaSet = new Set(schemaLabels);
  const removed = dbLabels.filter((l) => !schemaSet.has(l));
  if (removed.length > 0) {
    warnings.push(
      `Enum "${enumName}": labels [${removed.join(', ')}] exist in the database but not the schema. ` +
        `Postgres cannot remove enum values in place, recreate the type manually if intended.`,
    );
  }
  return { statements, warnings };
}

/** A check constraint as declared or read from the DB. */
export interface CheckSpec {
  /** Constraint name. Always emitted through `dialect.quoteIdentifier`. */
  name: string;
  /**
   * RAW SQL boolean expression (e.g. `price >= 0`), emitted VERBATIM into the
   * `CHECK (...)` clause.
   *
   * This is a deliberate escape hatch: a CHECK body is an arbitrary SQL
   * expression, so it cannot be quoted, parameterized, or validated by the DDL
   * builder without reimplementing the server's expression parser. The contract
   * is therefore on the caller: the expression MUST come from the project's own
   * schema definition (a `defineSchema` literal or an introspected constraint),
   * and must NEVER be built from user input, request data, or any other
   * untrusted source. Anything interpolated into it runs with the privileges of
   * the migration.
   */
  expression: string;
}

/**
 * Diff a table's CHECK constraints (matched by name). Adds constraints missing
 * from the DB, drops DB constraints absent from the schema, and drop+adds when a
 * same-named constraint's expression changed. Expression comparison is a naive
 * whitespace-insensitive match, semantically-equal-but-different-spelled
 * expressions may re-emit (documented; harmless drop+add).
 */
export function diffCheckConstraints(
  table: string,
  schemaChecks: readonly CheckSpec[],
  dbChecks: readonly CheckSpec[],
  dialect: Dialect = postgresDialect,
): { statements: string[]; reverseStatements: string[] } {
  const q = (s: string) => dialect.quoteIdentifier(s);
  const statements: string[] = [];
  const reverseStatements: string[] = [];
  const dbByName = new Map(dbChecks.map((c) => [c.name, c]));
  const schemaByName = new Map(schemaChecks.map((c) => [c.name, c]));
  const norm = (e: string) => e.replace(/\s+/g, ' ').trim();
  // `c.expression` is raw SQL emitted verbatim by design (see CheckSpec):
  // schema-authored only, never untrusted input.
  const addStmt = (c: CheckSpec) => `ALTER TABLE ${q(table)} ADD CONSTRAINT ${q(c.name)} CHECK (${c.expression});`;
  const dropStmt = (name: string) => `ALTER TABLE ${q(table)} DROP CONSTRAINT ${q(name)};`;

  for (const sc of schemaChecks) {
    const existing = dbByName.get(sc.name);
    if (!existing) {
      statements.push(addStmt(sc));
      reverseStatements.push(dropStmt(sc.name));
    } else if (norm(existing.expression) !== norm(sc.expression)) {
      // Expression changed → drop + add.
      statements.push(dropStmt(sc.name), addStmt(sc));
      reverseStatements.push(dropStmt(sc.name), addStmt(existing));
    }
  }
  for (const dc of dbChecks) {
    if (!schemaByName.has(dc.name)) {
      statements.push(dropStmt(dc.name));
      reverseStatements.push(addStmt(dc));
    }
  }
  return { statements, reverseStatements };
}

/** Options for {@link schemaDiff} and {@link schemaPush}. */
export interface SchemaDiffOptions {
  /**
   * Postgres NAMESPACE the diff reads (default `public`).
   *
   * Every catalog read here used to hardcode `'public'` while `generate`,
   * `pull`, `doctor`, and `studio` all honored the configured schema. Against a
   * table in a non-public schema the diff therefore saw nothing and emitted
   * `CREATE TABLE "users"` (a duplicate in public); worse, when a legacy copy of
   * the table still sat in `public` (the usual state after moving to a dedicated
   * schema) it read THAT one and emitted ALTER / DROP COLUMN against the wrong
   * table. Defaults to `public`, so a project with no schema configured emits
   * byte-identical SQL.
   */
  schema?: string;
}

/**
 * Compare a SchemaDef against a live Postgres database and return the diff.
 *
 * Connects to the database, inspects `options.schema` (default `public`), and
 * computes what DDL is needed to make the database match the schema definition.
 */
export async function schemaDiff(
  schema: SchemaDef,
  connectionString: string,
  options: SchemaDiffOptions = {},
): Promise<DiffResult> {
  const dialect = postgresDialect;
  // The Postgres namespace every catalog read below is scoped to. Named
  // `pgSchema` because `schema` is already the SchemaDef in this function.
  const pgSchema = options.schema ?? 'public';
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    // Get existing tables in the target schema
    const tableResult = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = $1`,
      [pgSchema],
    );
    const existingTables = new Set(tableResult.rows.map((r) => r.tablename));

    // Get existing columns for all tables. `numeric_precision` / `numeric_scale`
    // ride along with `character_maximum_length` so a length- or precision-only
    // change is visible (see typeDifference); comparing `udt_name` alone
    // reported "already in sync" for VARCHAR(255) against a declared
    // varchar(10), and the widening direction of that produced runtime
    // "value too long" errors the diff had said were impossible.
    const columnResult = await client.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: string;
      column_default: string | null;
      character_maximum_length: number | null;
      numeric_precision: number | null;
      numeric_scale: number | null;
    }>(
      `SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default,
              character_maximum_length, numeric_precision, numeric_scale
       FROM information_schema.columns
       WHERE table_schema = $1
       ORDER BY table_name, ordinal_position`,
      [pgSchema],
    );

    // The type EXACTLY as Postgres writes it, for the modifiers
    // information_schema structurally cannot report: an array's element length
    // (`character varying(255)[]`, where character_maximum_length is NULL) and a
    // pgvector dimension count (`vector(3)`, which has no column at all). Both
    // were invisible to the diff, so both reported "already in sync" for a
    // schema that differed. It doubles as the reverse-ALTER spelling of any type
    // this generator has no keyword for. Restricted to ordinary and partitioned
    // tables to match the pg_tables read above.
    const formattedResult = await client.query<{
      table_name: string;
      column_name: string;
      formatted_type: string;
    }>(
      `SELECT cl.relname AS table_name, a.attname AS column_name,
              format_type(a.atttypid, a.atttypmod) AS formatted_type
       FROM pg_attribute a
       JOIN pg_class cl ON cl.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = cl.relnamespace
       WHERE n.nspname = $1 AND cl.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped`,
      [pgSchema],
    );
    const formattedTypes = new Map<string, string>();
    for (const row of formattedResult.rows) {
      formattedTypes.set(`${row.table_name}.${row.column_name}`, row.formatted_type);
    }

    const dbColumns: Record<string, Record<string, DbColumn>> = {};
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
        numericPrecision: row.numeric_precision,
        numericScale: row.numeric_scale,
        formattedType: formattedTypes.get(`${row.table_name}.${row.column_name}`) ?? null,
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
       WHERE tc.table_schema = $1
         AND tc.constraint_type = 'UNIQUE'
         AND tc.constraint_name IN (
           SELECT constraint_name
           FROM information_schema.key_column_usage
           WHERE table_schema = $1
           GROUP BY constraint_name
           HAVING COUNT(*) = 1
         )`,
      [pgSchema],
    );

    // Map: table → column → constraint_name for single-col uniques
    const dbUniques: Record<string, Record<string, string>> = {};
    for (const row of uniqueResult.rows) {
      if (!dbUniques[row.table_name]) dbUniques[row.table_name] = {};
      dbUniques[row.table_name]![row.column_name] = row.constraint_name;
    }

    // Existing enums (typname → ordered labels) for CREATE TYPE / ADD VALUE diff.
    const enumResult = await client.query<{ typname: string; enumlabel: string }>(
      `SELECT t.typname, e.enumlabel
       FROM pg_type t
       JOIN pg_enum e ON t.oid = e.enumtypid
       JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = $1
       ORDER BY t.typname, e.enumsortorder`,
      [pgSchema],
    );
    const dbEnums: Record<string, string[]> = {};
    for (const row of enumResult.rows) {
      if (!dbEnums[row.typname]) dbEnums[row.typname] = [];
      dbEnums[row.typname]!.push(row.enumlabel);
    }

    // Existing single-column FK referential actions, keyed by table → column.
    const fkResult = await client.query<{
      table_name: string;
      constraint_name: string;
      column: string;
      target_table: string;
      target_column: string;
      confdeltype: string;
      confupdtype: string;
    }>(
      `SELECT rel.relname AS table_name, con.conname AS constraint_name,
              att.attname AS column, tgt.relname AS target_table,
              tatt.attname AS target_column, con.confdeltype, con.confupdtype
       FROM pg_constraint con
       JOIN pg_catalog.pg_namespace n ON n.oid = con.connamespace
       JOIN pg_catalog.pg_class rel ON rel.oid = con.conrelid
       JOIN pg_catalog.pg_class tgt ON tgt.oid = con.confrelid
       JOIN pg_catalog.pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
       JOIN pg_catalog.pg_attribute tatt ON tatt.attrelid = con.confrelid AND tatt.attnum = con.confkey[1]
       WHERE con.contype = 'f' AND n.nspname = $1
         AND array_length(con.conkey, 1) = 1`,
      [pgSchema],
    );
    const dbForeignKeys: Record<string, Record<string, DbForeignKey>> = {};
    for (const row of fkResult.rows) {
      if (!dbForeignKeys[row.table_name]) dbForeignKeys[row.table_name] = {};
      dbForeignKeys[row.table_name]![row.column] = {
        constraintName: row.constraint_name,
        column: row.column,
        targetTable: row.target_table,
        targetColumn: row.target_column,
        onDelete: pgConfActionToReferential(row.confdeltype),
        onUpdate: pgConfActionToReferential(row.confupdtype),
      };
    }

    // Existing CHECK constraints (contype='c'), keyed by table.
    const checkResult = await client.query<{ table_name: string; conname: string; definition: string }>(
      `SELECT rel.relname AS table_name, con.conname, pg_get_constraintdef(con.oid) AS definition
       FROM pg_constraint con
       JOIN pg_catalog.pg_class rel ON rel.oid = con.conrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = con.connamespace
       WHERE con.contype = 'c' AND n.nspname = $1`,
      [pgSchema],
    );
    const dbChecks: Record<string, CheckSpec[]> = {};
    for (const row of checkResult.rows) {
      if (!dbChecks[row.table_name]) dbChecks[row.table_name] = [];
      dbChecks[row.table_name]!.push({ name: row.conname, expression: stripCheckWrapper(row.definition) });
    }

    // Existing index NAMES per table (for the declared-index diff). Covers PK,
    // unique-constraint, FK, and user indexes alike; the diff only ADDs declared
    // indexes whose name is missing and never auto-drops any (see below).
    const indexResult = await client.query<{ tablename: string; indexname: string; indexdef: string }>(
      `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = $1`,
      [pgSchema],
    );
    const dbIndexes: Record<string, Map<string, string>> = {};
    for (const row of indexResult.rows) {
      if (!dbIndexes[row.tablename]) dbIndexes[row.tablename] = new Map();
      dbIndexes[row.tablename]!.set(row.indexname, row.indexdef);
    }

    // Build a set of DDL-facing snake_case table names that the schema defines.
    const schemaDdlNames = new Set<string>();
    for (const def of Object.values(schema.tables)) schemaDdlNames.add(def.name);
    const result: DiffResult = { create: [], alter: [], drop: [], statements: [], reverseStatements: [], warnings: [] };
    const resolveRef = makeRefResolver(schema);

    // --- Enums: CREATE TYPE for new enums (before tables), ADD VALUE for grown
    //     ones, and a warning for any destructive removal/reorder. New CREATE
    //     TYPEs go first so tables that reference them create cleanly. ---
    for (const [enumName, labels] of Object.entries(schema.enums ?? {})) {
      const existing = dbEnums[enumName];
      if (!existing) {
        result.statements.push(generateCreateEnumType(enumName, labels, dialect));
        result.reverseStatements.unshift(`DROP TYPE IF EXISTS ${dialect.quoteIdentifier(enumName)};`);
      } else {
        const { statements, warnings } = diffEnumValues(enumName, labels, existing, dialect);
        result.statements.push(...statements);
        result.warnings!.push(...warnings);
        // ADD VALUE cannot be reversed (Postgres can't drop enum values).
      }
    }

    // Tables to create (in schema but not in DB)
    const sorted = topologicalSort(schema);
    for (const tableKey of sorted) {
      const tableDef = schema.tables[tableKey]!;
      const ddlName = tableDef.name;
      if (!existingTables.has(ddlName)) {
        result.create.push(tableDef);
        result.statements.push(generateCreateTable(tableDef, resolveRef, dialect));
        const fkIndexes = generateForeignKeyIndexes(tableDef, dialect);
        result.statements.push(...fkIndexes);
        // User-declared indexes on a brand-new table (reversed by the DROP TABLE).
        result.statements.push(...generateDeclaredIndexes(tableDef, dialect));
        // Reverse: DROP TABLE (with indexes, they drop automatically)
        result.reverseStatements.unshift(`DROP TABLE IF EXISTS ${dialect.quoteIdentifier(ddlName)} CASCADE;`);
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
          // Column exists in schema but not in DB, ADD COLUMN
          const colDef = generateColumnDef(fieldName, config, resolveRef, dialect);
          const sql = `ALTER TABLE ${dialect.quoteIdentifier(tableName)} ADD COLUMN ${colDef};`;
          const reverseSql = `ALTER TABLE ${dialect.quoteIdentifier(tableName)} DROP COLUMN ${dialect.quoteIdentifier(snakeName)};`;
          alterDef.columns.push({ column: snakeName, action: 'add', sql, reverseSql });
          result.statements.push(sql);
          result.reverseStatements.unshift(reverseSql);
          continue;
        }

        // Check type mismatch. Serial/bigserial columns are exempt: their
        // underlying int4/int8 width must never be auto-altered on a live table
        // (a downcast on a PK loses data / breaks the sequence). This also
        // preserves back-compat for DBs whose `serial` columns were created as
        // BIGSERIAL (int8) before 0.24.0, `push` won't try to shrink them.
        // planTypeChange owns the whole decision: whether the types differ at
        // all (including length / precision modifiers), whether the conversion
        // needs an explicit USING, and what the conversion costs.
        const typePlan = planTypeChange(config, dbCol, snakeName);
        if (typePlan.kind === 'warn') {
          result.warnings!.push(`column "${tableName}"."${snakeName}": ${typePlan.reason}`);
        } else if (typePlan.kind === 'alter') {
          // resolveDdlType handles enum names, vector(n), arrays, and VARCHAR(n) -
          // config.type alone would emit the internal ENUM/VECTOR sentinels here.
          const sqlType = resolveDdlType(config, dialect, snakeName);
          const oldSqlType = udtToSqlType(dbCol);
          const col = dialect.quoteIdentifier(snakeName);
          // `USING` only where the conversion needs one. Within a type family
          // Postgres has an assignment cast, and letting IT decide is the whole
          // point: an explicit `::VARCHAR(10)` truncates a 27-character value,
          // while the plain ALTER raises "value too long" and the migration
          // stops. See planTypeChange.
          //
          // Where a USING IS needed (the conversion crosses type families and
          // has no assignment cast), the cast targets the UNBOUNDED base type
          // rather than the declared one, because an explicit cast amputates
          // wherever it lands. Dropping the USING was only half the fix: every
          // cross-family conversion INTO a bounded string still carried
          // `USING col::VARCHAR(n)` and still truncated, silently and on every
          // engine-side value shape (jsonb, integer, uuid, an enum label, bytea,
          // a timestamp). Casting to the unbounded base keeps the conversion
          // Postgres cannot do implicitly while leaving the LENGTH check to the
          // assignment into the column, which raises "value too long" and stops.
          const using = typePlan.needsUsing ? ` USING ${col}::${unboundedCastType(sqlType)}` : '';
          const reverseUsing = typePlan.needsUsing ? ` USING ${col}::${unboundedCastType(oldSqlType)}` : '';
          const sql = `ALTER TABLE ${dialect.quoteIdentifier(tableName)} ALTER COLUMN ${col} TYPE ${sqlType}${using};`;
          const reverseSql = `ALTER TABLE ${dialect.quoteIdentifier(tableName)} ALTER COLUMN ${col} TYPE ${oldSqlType}${reverseUsing};`;
          alterDef.columns.push({ column: snakeName, action: 'alter_type', sql, reverseSql });
          result.statements.push(sql);
          result.reverseStatements.unshift(reverseSql);
          // The destructive gate sees the statement and refuses by default; its
          // label is necessarily generic ("cast may truncate or fail"). This
          // warning names what THIS conversion does to THESE rows.
          if (typePlan.loss) {
            result.warnings!.push(
              `column "${tableName}"."${snakeName}" changes type from ${oldSqlType} to ${sqlType}: ${typePlan.loss}`,
            );
          }
        }

        // Check NOT NULL mismatch
        const shouldBeNotNull = config.isNotNull || config.isPrimaryKey || isSerialType(config.type);
        const isCurrentlyNullable = dbCol.isNullable;
        if (shouldBeNotNull && isCurrentlyNullable && !config.isNullable) {
          const sql = `ALTER TABLE ${dialect.quoteIdentifier(tableName)} ALTER COLUMN ${dialect.quoteIdentifier(snakeName)} SET NOT NULL;`;
          const reverseSql = `ALTER TABLE ${dialect.quoteIdentifier(tableName)} ALTER COLUMN ${dialect.quoteIdentifier(snakeName)} DROP NOT NULL;`;
          alterDef.columns.push({ column: snakeName, action: 'set_not_null', sql, reverseSql });
          result.statements.push(sql);
          result.reverseStatements.unshift(reverseSql);
        } else if (!shouldBeNotNull && !isCurrentlyNullable && config.isNullable) {
          const sql = `ALTER TABLE ${dialect.quoteIdentifier(tableName)} ALTER COLUMN ${dialect.quoteIdentifier(snakeName)} DROP NOT NULL;`;
          const reverseSql = `ALTER TABLE ${dialect.quoteIdentifier(tableName)} ALTER COLUMN ${dialect.quoteIdentifier(snakeName)} SET NOT NULL;`;
          alterDef.columns.push({ column: snakeName, action: 'drop_not_null', sql, reverseSql });
          result.statements.push(sql);
          result.reverseStatements.unshift(reverseSql);
        }

        // Check DEFAULT value mismatch
        const isSerial = isSerialType(config.type);
        if (!isSerial) {
          const schemaDefault = config.defaultValue ? normalizeDefault(config.defaultValue) : null;
          const dbDefault = dbCol.columnDefault;

          if (schemaDefault && !dbDefault) {
            // Schema has default, DB doesn't
            const sql = `ALTER TABLE ${dialect.quoteIdentifier(tableName)} ALTER COLUMN ${dialect.quoteIdentifier(snakeName)} SET DEFAULT ${schemaDefault};`;
            const reverseSql = `ALTER TABLE ${dialect.quoteIdentifier(tableName)} ALTER COLUMN ${dialect.quoteIdentifier(snakeName)} DROP DEFAULT;`;
            alterDef.columns.push({ column: snakeName, action: 'set_default', sql, reverseSql });
            result.statements.push(sql);
            result.reverseStatements.unshift(reverseSql);
          } else if (!schemaDefault && dbDefault && !isSequenceDefault(dbDefault)) {
            // DB has a non-sequence default, schema doesn't
            const sql = `ALTER TABLE ${dialect.quoteIdentifier(tableName)} ALTER COLUMN ${dialect.quoteIdentifier(snakeName)} DROP DEFAULT;`;
            const reverseSql = `ALTER TABLE ${dialect.quoteIdentifier(tableName)} ALTER COLUMN ${dialect.quoteIdentifier(snakeName)} SET DEFAULT ${dbDefault};`;
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
            const sql = `ALTER TABLE ${dialect.quoteIdentifier(tableName)} ALTER COLUMN ${dialect.quoteIdentifier(snakeName)} SET DEFAULT ${schemaDefault};`;
            const reverseSql = `ALTER TABLE ${dialect.quoteIdentifier(tableName)} ALTER COLUMN ${dialect.quoteIdentifier(snakeName)} SET DEFAULT ${dbDefault};`;
            alterDef.columns.push({ column: snakeName, action: 'set_default', sql, reverseSql });
            result.statements.push(sql);
            result.reverseStatements.unshift(reverseSql);
          }
        }

        // Check UNIQUE constraint mismatch (skip PKs, they're implicitly unique)
        if (!config.isPrimaryKey) {
          const hasDbUnique = snakeName in tableUniques;
          const wantsUnique = config.isUnique === true;

          if (wantsUnique && !hasDbUnique) {
            const constraintName = `${tableName}_${snakeName}_key`;
            const sql = `ALTER TABLE ${dialect.quoteIdentifier(tableName)} ADD CONSTRAINT ${dialect.quoteIdentifier(constraintName)} UNIQUE (${dialect.quoteIdentifier(snakeName)});`;
            const reverseSql = `ALTER TABLE ${dialect.quoteIdentifier(tableName)} DROP CONSTRAINT ${dialect.quoteIdentifier(constraintName)};`;
            alterDef.columns.push({ column: snakeName, action: 'add_unique', sql, reverseSql });
            result.statements.push(sql);
            result.reverseStatements.unshift(reverseSql);
          } else if (!wantsUnique && hasDbUnique) {
            const constraintName = tableUniques[snakeName]!;
            const sql = `ALTER TABLE ${dialect.quoteIdentifier(tableName)} DROP CONSTRAINT ${dialect.quoteIdentifier(constraintName)};`;
            const reverseSql = `ALTER TABLE ${dialect.quoteIdentifier(tableName)} ADD CONSTRAINT ${dialect.quoteIdentifier(constraintName)} UNIQUE (${dialect.quoteIdentifier(snakeName)});`;
            alterDef.columns.push({ column: snakeName, action: 'drop_unique', sql, reverseSql });
            result.statements.push(sql);
            result.reverseStatements.unshift(reverseSql);
          }
        }
      }

      // Check for columns in DB that are not in schema.
      // The DROP COLUMN statement stays IN `result.statements` so the destructive
      // gate (findDestructivePushStatements / scanDestructiveSql, and the migrate
      // up gate) can see it and refuse by default. Safety is enforced by that
      // gate, not by hiding the statement: withholding it here previously made
      // `push` report "already in sync" for a destructive-only diff and print a
      // false "Altered" for a mixed one, since the 0.36 guard never received it.
      // No reverse is emitted (a dropped column and its data cannot be recreated
      // automatically), so diff-generated migrations fall back to the documented
      // irreversible-DOWN placeholder for this change.
      for (const dbColName of Object.keys(dbCols)) {
        const hasField = Object.entries(tableDef.columns).some(([fieldName]) => camelToSnake(fieldName) === dbColName);
        if (!hasField) {
          const sql = `ALTER TABLE ${dialect.quoteIdentifier(tableName)} DROP COLUMN ${dialect.quoteIdentifier(dbColName)};`;
          const reverseSql = `-- Cannot auto-reverse DROP COLUMN for "${dbColName}"; add it back manually`;
          alterDef.columns.push({ column: dbColName, action: 'drop', sql, reverseSql });
          result.statements.push(sql);
        }
      }

      if (alterDef.columns.length > 0) {
        result.alter.push(alterDef);
      }

      // --- Referential action changes on existing single-column FKs ---
      // Postgres has no ALTER CONSTRAINT for actions → DROP + ADD CONSTRAINT.
      const tableFks = dbForeignKeys[tableName] ?? {};
      for (const [fieldName, config] of Object.entries(tableDef.columns)) {
        if (!config.referencesTarget) continue;
        const snakeName = camelToSnake(fieldName);
        const dbFk = tableFks[snakeName];
        if (!dbFk) continue; // FK not present in DB yet (or composite), skip
        const change = diffReferentialAction(
          tableName,
          dbFk,
          config.onDelete ?? 'no action',
          config.onUpdate ?? 'no action',
          dialect,
        );
        if (change) {
          result.statements.push(...change.statements);
          for (const rev of change.reverseStatements.slice().reverse()) result.reverseStatements.unshift(rev);
        }
      }

      // --- Named table-level CHECK constraints ---
      // Presence-only diffing: ADD checks whose NAME is missing from the DB.
      // We do NOT auto-drop DB checks absent from the schema (column-level /
      // inline checks carry auto-generated names the code-first schema never
      // sees), and we do NOT drop+add on expression mismatch: pg_get_constraintdef
      // canonicalizes expressions (casts, ANY(ARRAY[...]) rewrites), so authored
      // text almost never string-matches the stored form, comparing would emit a
      // spurious full-table-revalidating drop+add on every diff. An apparent
      // mismatch surfaces as a warning instead; rename the constraint to
      // intentionally replace its expression. Unnamed schema checks are skipped
      // (no stable identity to diff on).
      const namedSchemaChecks: CheckSpec[] = (tableDef.checks ?? [])
        .filter((c): c is { name: string; expression: string } => typeof c.name === 'string' && c.name.length > 0)
        .map((c) => ({ name: c.name, expression: c.expression }));
      const tableDbChecks = dbChecks[tableName] ?? [];
      const dbCheckByName = new Map(tableDbChecks.map((c) => [c.name, c]));
      const normExpr = (e: string) => e.replace(/\s+/g, ' ').trim();
      for (const sc of namedSchemaChecks) {
        const existing = dbCheckByName.get(sc.name);
        // The constraint name is quoted; `sc.expression` is raw SQL emitted
        // verbatim by design (see CheckSpec) and must be schema-authored.
        const addSql = `ALTER TABLE ${dialect.quoteIdentifier(tableName)} ADD CONSTRAINT ${dialect.quoteIdentifier(sc.name)} CHECK (${sc.expression});`;
        const dropSql = `ALTER TABLE ${dialect.quoteIdentifier(tableName)} DROP CONSTRAINT ${dialect.quoteIdentifier(sc.name)};`;
        if (!existing) {
          result.statements.push(addSql);
          result.reverseStatements.unshift(dropSql);
        } else if (normExpr(existing.expression) !== normExpr(sc.expression)) {
          result.warnings!.push(
            `check constraint "${sc.name}" on "${tableName}": stored expression differs from the schema text ` +
              `(Postgres canonicalizes CHECK expressions, so this is usually cosmetic). ` +
              `To intentionally replace it, rename the constraint or drop/re-add it in a manual migration.`,
          );
        }
      }

      // --- User-declared indexes (TableDef.indexes) ---
      // ADD any declared plain index whose NAME is missing from the DB (reverse:
      // DROP INDEX). Doc-field indexes are PowDB-only and skipped. We never
      // auto-drop DB indexes not in the schema, matching the column-drop posture.
      // When the table declares at least one index (the user is actively managing
      // indexes here), unrecognized extra DB indexes are surfaced as warnings so
      // the operator can drop them by hand if intended. Recognized = PK, unique
      // constraint, or FK-column index names, which the schema never declares.
      // Run the whole index-management pass whenever the table DEFINES an
      // `indexes` array (even empty or all-doc-field): a table with an `indexes`
      // key is one the user is actively managing, so undeclared DB indexes stay
      // worth surfacing. Deleting the last declared index must NOT silence the
      // warning pass. Tables with no `indexes` key stay silent (not managed).
      const declaredPlain = (tableDef.indexes ?? []).filter((i): i is ColumnIndexDef => !isDocFieldIndexDef(i));
      if (tableDef.indexes !== undefined) {
        const dbIdx = dbIndexes[tableName] ?? new Map<string, string>();
        const dbIdxNames = new Set(dbIdx.keys());
        const declaredNames = new Set<string>();
        for (const idx of declaredPlain) {
          if (idx.columns.length === 0) continue;
          const name = declaredIndexName(tableName, idx);
          declaredNames.add(name);
          const existingDef = dbIdx.get(name);
          if (existingDef === undefined) {
            const stmt = buildDeclaredIndexStatement(tableName, idx, dialect);
            if (!stmt) continue;
            result.statements.push(stmt);
            result.reverseStatements.unshift(`DROP INDEX IF EXISTS ${dialect.quoteIdentifier(name)};`);
          } else {
            // Name matches an existing index: verify the definition agrees.
            // Matching is by name, so a definition drift (a declared UNIQUE
            // index colliding with the plain auto FK index, or a changed
            // column list) would otherwise be silently skipped, leaving the
            // declared guarantee unenforced. Warn, never drop.
            const mismatch = describeIndexDefMismatch(idx, existingDef);
            if (mismatch) {
              result.warnings!.push(
                `index "${name}" on "${tableName}": the declared definition does not match the existing ` +
                  `database index (${mismatch}). Turbine matches indexes by name and never drops them ` +
                  `automatically; drop and recreate it in a manual migration to apply the declared definition.`,
              );
            }
          }
        }
        // Recognized (never-declared) index names: unique-constraint + FK-column.
        const recognized = new Set<string>(Object.values(dbUniques[tableName] ?? {}));
        for (const [fieldName, config] of Object.entries(tableDef.columns)) {
          if (config.referencesTarget) recognized.add(`idx_${tableName}_${camelToSnake(fieldName)}`);
        }
        for (const w of undeclaredIndexWarnings({
          tableName,
          indexesDefined: tableDef.indexes !== undefined,
          dbIndexNames: dbIdxNames,
          declaredNames,
          recognizedNames: recognized,
        })) {
          result.warnings!.push(w);
        }
      }
    }

    return result;
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Column type comparison
// ---------------------------------------------------------------------------

/** One database column as the diff reads it out of information_schema. */
interface DbColumn {
  dataType: string;
  udtName: string;
  isNullable: boolean;
  columnDefault: string | null;
  maxLength: number | null;
  numericPrecision: number | null;
  numericScale: number | null;
  formattedType: string | null;
}

/** The type-relevant subset of {@link DbColumn}, so {@link planTypeChange} stays testable. */
export interface DbColumnType {
  udtName: string;
  maxLength: number | null;
  numericPrecision: number | null;
  numericScale: number | null;
  /**
   * `format_type(atttypid, atttypmod)` from pg_catalog: the type exactly as
   * Postgres would write it, e.g. `character varying(255)[]`, `vector(3)`,
   * `numeric(10,2)`, `app."Probe"`. Read alongside information_schema because
   * information_schema cannot express an array element's length modifier or a
   * pgvector dimension count, and because it is the only spelling of an
   * unmapped type that is guaranteed to be valid, correctly quoted and
   * correctly schema-qualified DDL. Null only when a caller builds the value by
   * hand (the live diff always populates it).
   */
  formattedType: string | null;
}

/**
 * What the diff should do about one column's type.
 *
 * `alter` carries `needsUsing` (see {@link planTypeChange}) and, when the
 * conversion can lose or reject data, a `loss` sentence naming the SPECIFIC
 * loss. `warn` is for a difference the code-first schema cannot express, where
 * emitting DDL would destroy an intentional database-side constraint.
 */
export type TypeChangePlan =
  | { kind: 'none' }
  | { kind: 'alter'; needsUsing: boolean; loss?: string }
  | { kind: 'warn'; reason: string };

/**
 * Rough type families. Within a family Postgres has an ASSIGNMENT cast between
 * every pair the schema builder can produce, which is what lets the diff emit a
 * plain `ALTER ... TYPE` with no `USING` (see {@link planTypeChange}). That
 * sentence is the family's whole contract, and two things used to break it:
 *
 *   - ARRAYS returned null, so every array-to-array change was treated as a
 *     cross-family conversion and got an explicit `USING col::VARCHAR(5)[]`,
 *     which truncates each element exactly as the scalar form does. Postgres
 *     has the same assignment casts between array types as between their
 *     elements (verified pair by pair for every type the schema builder can
 *     produce), so an array's family is its ELEMENT's family with `[]`
 *     appended. The suffix matters: `text` and `varchar(5)[]` must NOT come out
 *     the same family, because there is no automatic cast between a scalar and
 *     an array and the plain ALTER would be unrunnable.
 *   - `time` / `timetz` were listed as `temporal` alongside date and the
 *     timestamps, and the contract simply is not true there: pg_cast has NO
 *     entry between `time` and `date`, `timestamp` or `timestamptz` in EITHER
 *     direction, so `ALTER COLUMN c TYPE DATE` on a `time` column fails with
 *     "cannot be cast automatically". They are their own family, which makes a
 *     time-to-date change cross-family: still not something Turbine can apply,
 *     but now it says so in the loss warning instead of asserting a cast that
 *     does not exist. (`{date, timestamp, timestamptz}` and `{time, timetz}`
 *     are each internally complete.)
 */
function udtFamily(udt: string): string | null {
  if (udt.startsWith('_')) {
    const element = udtFamily(udt.slice(1));
    return element === null ? null : `${element}[]`;
  }
  switch (udt) {
    case 'text':
    case 'varchar':
    case 'bpchar':
    case 'char':
      return 'string';
    case 'int2':
    case 'int4':
    case 'int8':
    case 'numeric':
    case 'float4':
    case 'float8':
      return 'numeric';
    case 'date':
    case 'timestamp':
    case 'timestamptz':
      return 'temporal';
    case 'time':
    case 'timetz':
      return 'time-of-day';
    case 'json':
    case 'jsonb':
      return 'json';
    case 'bool':
      return 'boolean';
    default:
      return null; // uuid, bytea, enums, vector: no intra-family conversions
  }
}

/** Drop the array marker from a family name, so the per-family rules apply to both. */
function elementFamily(family: string | null): string | null {
  if (family === null) return null;
  return family.endsWith('[]') ? family.slice(0, -2) : family;
}

/** Drop Postgres's array prefix from a udt name (`_int4` → `int4`). */
function elementUdt(udt: string): string {
  return udt.startsWith('_') ? udt.slice(1) : udt;
}

/** Render a udt name the way a reader writes it (`_varchar` → `varchar[]`). */
function describeUdt(udt: string): string {
  return udt.startsWith('_') ? `${udt.slice(1)}[]` : udt;
}

/**
 * The type a `USING` cast should name so the cast itself cannot lose data.
 *
 * Only `VARCHAR(n)` (and its array form) carries a bound that an explicit cast
 * silently enforces by TRUNCATING; `TEXT` is the same type family with no bound,
 * so `col::TEXT` converts exactly as `col::VARCHAR(n)` would and then the
 * assignment into the declared column applies the length check properly. Every
 * other type this generator emits either has no length modifier or refuses the
 * conversion outright (pgvector's dimension count), so it is returned unchanged.
 */
function unboundedCastType(sqlType: string): string {
  const bounded = /^VARCHAR\(\d+\)(\[\])?$/i.exec(sqlType);
  return bounded ? `TEXT${bounded[1] ?? ''}` : sqlType;
}

/** Rank within the integer/real widening order, for the narrowing checks. */
const NUMERIC_RANK: Record<string, number> = { int2: 1, int4: 2, int8: 3, float4: 4, float8: 5, numeric: 6 };
/**
 * Rank within the temporal detail order (a lower rank carries less
 * information). Covers the `temporal` family only: `time` / `timetz` are a
 * separate family with no cast to or from these, so ranking them against a
 * date would compare two values that never meet.
 */
const TEMPORAL_RANK: Record<string, number> = { date: 1, timestamp: 3, timestamptz: 4 };

/**
 * The single numeric modifier in a `format_type` rendering, or null when the
 * type carries none. `character varying(255)[]` → 255, `vector(3)` → 3,
 * `numeric(10,2)` → 10, `text` → null.
 *
 * This exists because information_schema cannot express these: it reports
 * `character_maximum_length` NULL for an ARRAY of varchar (the length belongs to
 * the element type) and has no column at all for a pgvector dimension count. A
 * diff reading it alone therefore saw `varchar(255)[]` and a declared
 * `varchar(5)[]` as identical, and `vector(3)` and a declared 1536 dimensions as
 * identical, and reported "already in sync" for both.
 */
function typeModifier(formattedType: string | null | undefined): number | null {
  if (!formattedType) return null;
  const match = /\((\d+)(?:\s*,\s*\d+)?\)/.exec(formattedType);
  return match ? Number(match[1]) : null;
}

/**
 * The length bound on a string column, from whichever source carries it:
 * information_schema for a scalar varchar, the `format_type` modifier for an
 * array of varchar. Null means unbounded (`text`, a bare `VARCHAR`), which for
 * the loss checks reads as "could be longer than any target bound".
 */
function stringLengthOf(col: DbColumnType): number | null {
  return col.maxLength ?? typeModifier(col.formattedType);
}

/**
 * A sentence naming what this specific conversion does to existing rows, or
 * undefined when nothing is lost. Deliberately says whether Postgres REFUSES
 * the row or silently changes it: those are very different operational events,
 * and the generic "cast may truncate or fail" told the reader neither.
 */
function describeTypeLoss(from: DbColumnType, toUdt: string, toMaxLength: number | null, column: string): string {
  const q = `"${column}"`;
  const fromFamily = udtFamily(from.udtName);
  const toFamily = udtFamily(toUdt);
  // Within one family the rules are the same for a scalar and for an array of
  // it; only the noun changes, since an array's bound applies per element.
  const sameFamily = fromFamily !== null && fromFamily === toFamily;
  const family = elementFamily(toFamily);
  const fromUdt = elementUdt(from.udtName);
  const toElementUdt = elementUdt(toUdt);
  const isArray = toFamily?.endsWith('[]') ?? false;
  const subject = isArray ? `array elements in ${q}` : `values in ${q}`;

  // A bounded string TARGET enforces its bound on every value, whatever the
  // source type was, because the conversion renders the value as text first.
  // Only the same-family case can prove the bound is already satisfied.
  if (family === 'string' && toMaxLength != null) {
    const fromLen = sameFamily ? stringLengthOf(from) : null;
    if (fromLen === null || fromLen > toMaxLength) {
      const rendered = sameFamily ? '' : 'whose text form is ';
      return `${subject} ${rendered}longer than ${toMaxLength} characters make this statement FAIL (Postgres refuses the conversion; it does not truncate). Shorten or migrate those rows first.`;
    }
  }
  if (family === 'numeric' && sameFamily) {
    const fromRank = NUMERIC_RANK[fromUdt] ?? 0;
    const toRank = NUMERIC_RANK[toElementUdt] ?? 0;
    const toIsInteger = toElementUdt === 'int2' || toElementUdt === 'int4' || toElementUdt === 'int8';
    const fromIsInteger = fromUdt === 'int2' || fromUdt === 'int4' || fromUdt === 'int8';
    if (toIsInteger && !fromIsInteger) {
      return `fractional ${subject} are ROUNDED to whole numbers (silently, row by row).`;
    }
    if (toIsInteger && fromIsInteger && toRank < fromRank) {
      return `${subject} outside the ${toElementUdt} range make this statement FAIL ("integer out of range").`;
    }
    if (toRank < fromRank) {
      return `${subject} lose precision (silently rounded to what ${toElementUdt} can represent).`;
    }
  }
  if (family === 'temporal' && sameFamily) {
    const fromRank = TEMPORAL_RANK[fromUdt] ?? 0;
    const toRank = TEMPORAL_RANK[toElementUdt] ?? 0;
    if (toElementUdt === 'date' && fromRank > 1) return `the time-of-day component of ${q} is DROPPED (silently).`;
    if (toRank < fromRank) return `${q} loses its time-zone offset (converted to the session time zone).`;
  }
  if (elementFamily(fromFamily) === 'time-of-day' && family === 'temporal') {
    // Not "fails for some rows": pg_cast has no entry between `time`/`timetz`
    // and `date`/`timestamp`/`timestamptz` in either direction, implicit,
    // assignment or explicit, so the statement cannot run at all, on an empty
    // table included. Saying "must be a valid date literal" would send the
    // reader off to clean data that was never the problem.
    return `Postgres has NO cast from ${describeUdt(from.udtName)} to ${describeUdt(toUdt)}, in either direction, so this statement ALWAYS FAILS (a time of day carries no date to convert). Add the new column and backfill it in a manual migration instead.`;
  }
  if (!sameFamily) {
    return `every existing value in ${q} must be a valid ${describeUdt(toUdt)} literal or this statement FAILS.`;
  }
  return '';
}

/**
 * Decide what the diff should emit for one column's type.
 *
 * Two things this deliberately does that the previous `udtName !== expectedUdt`
 * check did not:
 *
 *   1. It compares LENGTH and NUMERIC PRECISION, not just the UDT name. A
 *      declared `varchar(10)` against a database `VARCHAR(255)` produced no
 *      statement and no warning, so `push` printed "Database is already in
 *      sync" for a schema that genuinely differed. The widening direction is
 *      the operationally painful one: the schema says 255, the column is 10,
 *      push says in sync, and writes fail at runtime with "value too long".
 *   2. It reports `needsUsing` FALSE for a same-family conversion. The old
 *      statement always appended `USING col::type`, and an EXPLICIT cast to
 *      `varchar(n)` TRUNCATES where the plain assignment cast raises "value too
 *      long". Postgres refuses that migration on its own; the generated `USING`
 *      converted the refusal into silent data amputation. Same shape for
 *      `numeric -> integer` and `timestamptz -> date`. `USING` is emitted only
 *      where the conversion genuinely needs it (text to uuid, text to an enum,
 *      anything crossing a type family), where no assignment cast exists.
 *
 * Numeric PRECISION drift gets a warning rather than a statement: `defineSchema`
 * has no way to declare `numeric(10, 2)`, so every such column would otherwise
 * get a table-rewriting `ALTER ... TYPE NUMERIC` on every push, discarding a
 * constraint the schema never had the vocabulary to ask for.
 */
export function planTypeChange(config: ColumnConfig, dbCol: DbColumnType, column: string): TypeChangePlan {
  const expectedUdt = schemaTypeToUdt(config);
  if (expectedUdt === null) {
    return {
      kind: 'warn',
      reason: `schema type "${config.type}" has no known Postgres type mapping, so its type is not diffed.`,
    };
  }
  if (isSerialType(config.type)) return { kind: 'none' };

  if (dbCol.udtName !== expectedUdt) {
    const loss = describeTypeLoss(dbCol, expectedUdt, config.maxLength, column);
    const sameFamily = udtFamily(dbCol.udtName) !== null && udtFamily(dbCol.udtName) === udtFamily(expectedUdt);
    return { kind: 'alter', needsUsing: !sameFamily, ...(loss ? { loss } : {}) };
  }

  // Same UDT: the remaining differences are the type MODIFIERS. Some are in
  // information_schema, some only in the catalog's format_type rendering.
  if (expectedUdt === 'varchar') {
    // `maxLength: null` on a varchar column is a real declaration (unbounded
    // VARCHAR), not an omission: schemaToSQL emits a bare `VARCHAR` for it.
    const want = config.maxLength ?? null;
    if (want !== dbCol.maxLength) {
      const loss = describeTypeLoss(dbCol, expectedUdt, want, column);
      return { kind: 'alter', needsUsing: false, ...(loss ? { loss } : {}) };
    }
    return { kind: 'none' };
  }

  if (expectedUdt === '_varchar') {
    // The same length comparison for `varchar(n)[]`. It needs a different
    // source because information_schema reports character_maximum_length NULL
    // for an array (the modifier belongs to the element type), so comparing it
    // saw `varchar(255)[]` and a declared `varchar(5)[]` as identical and
    // reported "already in sync" for a schema that genuinely differed, with no
    // statement and no warning. The plain ALTER carries the change on this path
    // too: Postgres has the same assignment cast between the array types as
    // between their elements, and enforces the bound per element.
    const want = config.maxLength ?? null;
    if (want !== typeModifier(dbCol.formattedType)) {
      const loss = describeTypeLoss(dbCol, expectedUdt, want, column);
      return { kind: 'alter', needsUsing: false, ...(loss ? { loss } : {}) };
    }
    return { kind: 'none' };
  }

  if (expectedUdt === 'vector') {
    // pgvector's dimension count is a type modifier, invisible to
    // information_schema, so a `vector(3)` column against a declared 1536
    // dimensions produced no statement and no warning; the app then failed on
    // its first write with "expected 3 dimensions, not 1536". Same shape as the
    // varchar(255)-against-varchar(10) bug above. A dimension change cannot be
    // applied to populated rows at all (pgvector rejects it with or without an
    // explicit cast), which is what the loss sentence has to say.
    const want = config.vectorDimensions ?? null;
    const have = typeModifier(dbCol.formattedType);
    if (want !== have) {
      const loss =
        want == null
          ? `existing vectors in "${column}" keep their dimension count; an unbounded vector column cannot be produced from a bounded one while rows exist, so this statement FAILS.`
          : `every existing vector in "${column}" must already have exactly ${want} dimensions or this statement FAILS (pgvector refuses the conversion; it does not pad or truncate).`;
      return { kind: 'alter', needsUsing: false, loss };
    }
    return { kind: 'none' };
  }

  if (expectedUdt === 'numeric' && dbCol.numericPrecision !== null) {
    // Guarded on `numeric` alone: information_schema reports a precision for
    // every integer and float type too (int4 -> 32), which is not a modifier
    // anyone declared.
    const stored =
      dbCol.numericScale === null
        ? `numeric(${dbCol.numericPrecision})`
        : `numeric(${dbCol.numericPrecision}, ${dbCol.numericScale})`;
    return {
      kind: 'warn',
      reason: `the database column is ${stored} but the schema declares a bare NUMERIC. defineSchema cannot express numeric precision/scale, so Turbine leaves the column alone rather than rewriting away a constraint it cannot represent. Change it in a manual migration if that is intended.`,
    };
  }

  return { kind: 'none' };
}

/**
 * Map a schema column type to its expected PostgreSQL UDT name.
 */
function schemaTypeToUdt(config: ColumnConfig): string | null {
  // Enum columns: udt is the enum type name. Vector columns: udt is `vector`.
  if (config.enumName) return config.enumName;
  if (config.vectorDimensions != null) return 'vector';

  const map: Record<string, string> = {
    SERIAL: 'int4',
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
  const base = map[config.type] ?? null;
  // Postgres names an array type `_<element>` (e.g. `_text` for text[]).
  if (base && config.isArray) return `_${base}`;
  return base;
}

/**
 * Reverse map: a database column's type → the SQL type token that restores it
 * (used for the reverse ALTER TYPE, and to name the old type in a warning).
 *
 * Two rules, and the second one is why this takes the whole column:
 *
 *   1. A type this generator itself emits gets its own uppercase spelling back,
 *      so a reverse statement reads like the forward one. `numeric` now carries
 *      its precision and scale: a `numeric(10, 2)` column changed to INTEGER
 *      reversed to a bare `NUMERIC`, quietly discarding the constraint the DOWN
 *      was supposed to restore.
 *   2. ANYTHING ELSE is not a keyword and must not be treated as one. The old
 *      fallback was `udtName.toUpperCase()`, which produces an unquoted
 *      identifier: correct only by accident for an all-lowercase name, and
 *      wrong for every enum, domain or extension type with a capital in it
 *      (`"Probe"` became `PROBE`, which Postgres folds back to `probe` and then
 *      fails with `type "probe" does not exist`). The catalog's own
 *      `format_type` rendering is the answer: already quoted where quoting is
 *      needed, already schema-qualified when the type is not in the search_path,
 *      and already carrying its modifiers (`vector(3)`, `citext`,
 *      `character varying(255)[]`). Quoting the bare udt name is the fallback
 *      for a hand-built column with no catalog rendering.
 */
function udtToSqlType(dbCol: DbColumnType): string {
  const map: Record<string, string> = {
    int8: 'BIGINT',
    int4: 'INTEGER',
    int2: 'SMALLINT',
    text: 'TEXT',
    varchar: dbCol.maxLength ? `VARCHAR(${dbCol.maxLength})` : 'VARCHAR',
    bool: 'BOOLEAN',
    timestamptz: 'TIMESTAMPTZ',
    date: 'DATE',
    jsonb: 'JSONB',
    uuid: 'UUID',
    float4: 'REAL',
    float8: 'DOUBLE PRECISION',
    numeric: numericSqlType(dbCol),
    bytea: 'BYTEA',
  };
  const mapped = map[dbCol.udtName];
  if (mapped) return mapped;
  return dbCol.formattedType ?? postgresDialect.quoteIdentifier(dbCol.udtName);
}

/** `NUMERIC`, `NUMERIC(10)` or `NUMERIC(10, 2)`, whichever the column actually is. */
function numericSqlType(dbCol: DbColumnType): string {
  if (dbCol.numericPrecision == null) return 'NUMERIC';
  if (dbCol.numericScale == null) return `NUMERIC(${dbCol.numericPrecision})`;
  return `NUMERIC(${dbCol.numericPrecision}, ${dbCol.numericScale})`;
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
// Schema Push, execute the diff against a live database
// ---------------------------------------------------------------------------

/**
 * Scan a set of diff statements for data-destroying operations, using the same
 * conservative scanner (`scanDestructiveSql`) that gates `migrate up`/`down`.
 * Push mostly emits additive DDL, but a type change surfaces as a lossy
 * `ALTER COLUMN ... TYPE` cast, exactly the kind of silent data loss `push`
 * must never apply without an explicit opt-in.
 */
export function findDestructivePushStatements(statements: readonly string[]): DestructiveStatement[] {
  const hits: DestructiveStatement[] = [];
  for (const stmt of statements) hits.push(...scanDestructiveSql(stmt));
  return hits;
}

/**
 * Quote a schema name for use INSIDE a `search_path` GUC value. The value is
 * bound as a parameter to set_config, but Postgres parses its contents as an
 * identifier list, so a name needing quotes (mixed case, a dot, a space) has to
 * carry them itself. Doubling `"` follows the same rule as quoteIdent.
 */
function quoteSearchPathIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Pin the transaction's `search_path` so the unqualified identifiers in the
 * generated DDL resolve in the SAME namespace the diff read, and refuse a
 * target schema that does not exist.
 *
 * Three separate failures live here, which is why it is one function:
 *
 *   1. The pin used to be applied only for a non-public target, on the reasoning
 *      that the default path is already public. It is not: `search_path` is a
 *      role/database/connection-string setting, so a role with
 *      `search_path = app, public` and NO configured schema had the diff reading
 *      `public` (unconditional, it binds the name as a parameter) while the DDL
 *      landed in `app`. The push reports success, and the second push fails with
 *      `relation "..." already exists` forever after, because the diff still
 *      cannot see the table it created. Skipping the pin for `public` protected
 *      the byte-identity of the SQL TEXT, which is not the thing that has to
 *      stay identical; the EFFECT is, and the effect of pinning `"public"` on a
 *      connection that already resolved to public is nil.
 *   2. Postgres does not validate schema names in `search_path`: setting it to a
 *      namespace that does not exist succeeds, and name resolution simply skips
 *      the missing entry. So a typo in `schema` silently redirected every
 *      CREATE into whatever came next in the path (public), reported success,
 *      and wedged the second push exactly as (1) does. `to_regnamespace`
 *      returns NULL for a missing namespace, which is the check.
 *   3. Pinning `"<target>", public` REPLACED the caller's path rather than
 *      extending it, so an extension installed in its own schema stopped
 *      resolving. On the common managed-Postgres layout (`"$user", public,
 *      extensions`) a `vector` / `citext` / `hstore` / `postgis` column, an
 *      extension opclass in a CREATE INDEX, or a CHECK calling an extension
 *      function all failed with `type "..." does not exist` under a pin that the
 *      same DDL did not need without it. The caller's entries are appended
 *      verbatim (they are already valid GUC syntax, and `SHOW` renders them with
 *      whatever quoting they need), so the only change to resolution is that the
 *      target schema is consulted FIRST, which is the whole point: an
 *      unqualified CREATE uses the first entry.
 *
 * `set_config(..., true)` is transaction-local, so none of this can leak onto a
 * pooled backend, and the value is BOUND rather than interpolated.
 */
async function pinSearchPath(client: pg.Client, pgSchema: string): Promise<void> {
  const present = await client.query<{ present: boolean }>(`SELECT to_regnamespace($1) IS NOT NULL AS present`, [
    pgSchema,
  ]);
  if (!present.rows[0]?.present) {
    throw new ValidationError(
      `[turbine] Schema "${pgSchema}" does not exist in this database. ` +
        `Postgres accepts a missing namespace in search_path without complaint, so pushing anyway would ` +
        `create every table in whichever schema resolves next (usually public) and report success. ` +
        `Create the schema first (CREATE SCHEMA "${pgSchema}") or correct the configured schema name.`,
    );
  }

  // Read the path the connection would otherwise use, so the pin EXTENDS it
  // instead of discarding it. An empty value is possible (`SHOW` renders it as
  // an empty identifier) and would leave a trailing comma, so it is dropped.
  const shown = await client.query<{ search_path: string }>('SHOW search_path');
  const inherited = (shown.rows[0]?.search_path ?? '').trim();
  const target = quoteSearchPathIdent(pgSchema);
  const value = inherited ? `${target}, ${inherited}` : target;
  await client.query(`SELECT set_config('search_path', $1, true)`, [value]);
}

/** Format the destructive-push refusal message (mirrors the migrate gate copy). */
function formatDestructivePushError(hits: readonly DestructiveStatement[]): string {
  const lines = ['[turbine] Refusing to apply schema changes containing DESTRUCTIVE statements:', ''];
  for (const h of hits) {
    lines.push(`  - [${h.kind}] ${h.target}: ${DESTRUCTIVE_KIND_LABEL[h.kind]}`);
  }
  lines.push('');
  lines.push('Review the statements above. To proceed: run `npx turbine push` interactively');
  lines.push('and confirm, pass --allow-destructive, or set allowDestructive: true programmatically.');
  return lines.join('\n');
}

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
 * Thrown by {@link schemaPush} when the diff contains data-destroying statements
 * and `allowDestructive` was not set. A typed subclass of {@link ValidationError}
 * (same `TURBINE_E003` code, no new taxonomy entry) so callers can branch on
 * `instanceof DestructivePushRefusal` instead of sniffing the message text. The
 * offending statements are carried on `.destructive` for programmatic display.
 */
export class DestructivePushRefusal extends ValidationError {
  /** The destructive statements the push refused to apply. */
  readonly destructive: DestructiveStatement[];

  constructor(destructive: DestructiveStatement[]) {
    super(formatDestructivePushError(destructive));
    this.name = 'DestructivePushRefusal';
    this.destructive = destructive;
  }
}

/**
 * Push a schema definition to a live database.
 *
 * Computes the diff, then executes the resulting DDL statements in a
 * single transaction. It will NOT drop tables or columns.
 *
 * Data-loss gate: if the diff contains a destructive statement (e.g. a lossy
 * `ALTER COLUMN ... TYPE` cast), `schemaPush` throws a
 * {@link DestructivePushRefusal} (a {@link ValidationError} subclass carrying
 * the offending statements on `.destructive`) listing the statements UNLESS
 * `allowDestructive: true` is passed. The CLI (`turbine push`) catches this and
 * prompts for the same typed confirmation as `migrate up`; programmatic callers
 * must opt in explicitly.
 *
 * `options.schema` (default `public`) scopes BOTH halves: the diff reads that
 * namespace, and the generated DDL (which names tables unqualified) is executed
 * with a transaction-local `search_path` pinned so the target schema resolves
 * FIRST. Without the second half a diff that correctly found nothing in `app`
 * would still emit `CREATE TABLE "users"` into whatever the connection's
 * search_path happens to resolve to. The pin is unconditional (`public` is a
 * target like any other, since a role's own search_path may not lead there),
 * refuses a schema that does not exist, and APPENDS the connection's existing
 * path so types living elsewhere still resolve. See {@link pinSearchPath}.
 */
export async function schemaPush(
  schema: SchemaDef,
  connectionString: string,
  options: {
    dryRun?: boolean;
    allowDestructive?: boolean;
    precomputedDiff?: DiffResult;
    schema?: string;
  } = {},
): Promise<PushResult> {
  const pgSchema = options.schema ?? 'public';
  // Accept a precomputed diff so a caller (the CLI) can diff ONCE, show the
  // plan, confirm, and apply the EXACT statements it displayed. Without this,
  // schemaPush would re-diff on the post-confirmation retry, so a concurrent
  // schema change between confirm and apply could alter the applied set (TOCTOU).
  const diff = options.precomputedDiff ?? (await schemaDiff(schema, connectionString, { schema: pgSchema }));

  const result: PushResult = {
    statementsExecuted: 0,
    statements: diff.statements,
    tablesCreated: diff.create.map((t) => t.name),
    tablesAltered: diff.alter.map((a) => a.table),
  };

  if (options.dryRun || diff.statements.length === 0) {
    return result;
  }

  // Destructive-statement gate: refuse silent data loss unless opted in.
  if (!options.allowDestructive) {
    const destructive = findDestructivePushStatements(diff.statements);
    if (destructive.length > 0) {
      throw new DestructivePushRefusal(destructive);
    }
  }

  // Execute all statements in a transaction
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    await client.query('BEGIN');
    // Unconditional: the diff's read side is unconditional too, and the two
    // halves disagreeing about which namespace they mean is what wedges a
    // project permanently. See pinSearchPath for all three failure modes.
    await pinSearchPath(client, pgSchema);
    for (const sql of diff.statements) {
      await client.query(sql);
      result.statementsExecuted++;
    }
    await client.query('COMMIT');
  } catch (err) {
    // The ROLLBACK is best-effort, and its own failure must never REPLACE the
    // error being unwound. The common way to get here is a connection that has
    // already died: the DDL fails, the ROLLBACK then fails too, and an
    // unguarded `await` throws the connection error out of this catch block, so
    // the caller is shown a dead socket instead of the constraint violation or
    // syntax error that actually caused the push to fail. There is also nothing
    // to do about a failed ROLLBACK: a broken connection is discarded below and
    // the server rolls the transaction back on its own.
    try {
      await client.query('ROLLBACK');
    } catch {
      // swallowed on purpose, see above
    }
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
export function schemaToSQLString(schema: SchemaDef, options?: SchemaSqlOptions): string {
  const statements = schemaToSQL(schema, options);
  return `${statements.join('\n\n')}\n`;
}
