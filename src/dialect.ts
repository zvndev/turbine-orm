/**
 * turbine-orm — SQL dialect contract
 *
 * Phase-1 seam for future database packages. The current package remains
 * PostgreSQL-native by default, but query generation now depends on this
 * contract for the SQL primitives that vary across MySQL and SQLite.
 */

import { ValidationError } from './errors.js';
import { pgArrayType, pgTypeToTs, type SchemaMetadata } from './schema.js';

export type DialectName = 'postgresql' | 'mysql' | 'sqlite' | (string & {});

export interface InsertStatementInput {
  /** SQL-ready quoted table name. */
  table: string;
  /** SQL-ready quoted insert columns. */
  columns: string[];
  /** SQL-ready parameter placeholders/expressions for VALUES. */
  valuePlaceholders: string[];
  /** Optional SQL-ready RETURNING selection. */
  returning?: string;
}

export interface BulkInsertStatementInput {
  /** SQL-ready quoted table name. */
  table: string;
  /** SQL-ready quoted insert columns. */
  columns: string[];
  /** Row-major values, one inner array per inserted row. */
  rowValues: unknown[][];
  /** Optional SQL-ready array casts for dialects that batch by column arrays (PostgreSQL UNNEST). */
  columnArrayTypes?: string[];
  /** Skip duplicate rows when supported by the dialect. */
  skipDuplicates?: boolean;
  /** Optional SQL-ready RETURNING selection. */
  returning?: string;
}

export interface BuiltStatement {
  sql: string;
  params: unknown[];
}

export interface UpsertStatementInput {
  /** SQL-ready quoted table name. */
  table: string;
  /** SQL-ready quoted insert columns. */
  insertColumns: string[];
  /** SQL-ready parameter placeholders/expressions for VALUES. */
  valuePlaceholders: string[];
  /** SQL-ready quoted conflict/unique columns. */
  conflictColumns: string[];
  /** SQL-ready update SET clauses. */
  updateSetClauses: string[];
  /** Optional SQL-ready RETURNING selection. */
  returning?: string;
}

export interface ColumnTypeInput {
  /** Schema-builder column type name (PostgreSQL-native in the root package). */
  type: string;
  /** Optional VARCHAR length. */
  maxLength?: number | null;
}

export interface ColumnDefinitionInput extends ColumnTypeInput {
  /** SQL-ready quoted column name. */
  name: string;
  /** Whether this column is a single-column primary key. */
  primaryKey?: boolean;
  /** Whether this column is unique. Ignored when primaryKey is true. */
  unique?: boolean;
  /** Whether this column is NOT NULL. */
  notNull?: boolean;
  /** SQL-ready default expression. */
  defaultValue?: string;
  /** SQL-ready REFERENCES clause without the leading REFERENCES keyword. */
  references?: { table: string; column: string };
}

export interface CreateTableStatementInput {
  /** SQL-ready quoted table name. */
  table: string;
  /** SQL-ready column and table constraints. */
  definitions: string[];
}

export interface CreateIndexStatementInput {
  /** SQL-ready quoted index name. */
  name: string;
  /** SQL-ready quoted table name. */
  table: string;
  /** SQL-ready quoted index columns. */
  columns: string[];
}

export interface Dialect {
  /** Dialect identifier. */
  readonly name: DialectName;

  /** Parameter placeholder for the Nth value, using a 1-indexed public count. */
  paramPlaceholder(index: number): string;

  /** Quote a SQL identifier (table, column, cursor, alias). */
  quoteIdentifier(name: string): string;

  /** Escape a string literal body for SQL single-quoted strings. */
  escapeStringLiteral(value: string): string;

  /** Empty JSON array literal used as a fallback for to-many relations. */
  readonly emptyJsonArrayLiteral: string;

  /** JSON null literal/fallback for to-one relations. */
  readonly nullJsonLiteral: string;

  /** Build a JSON object expression from output keys and SQL expressions. */
  buildJsonObject(pairs: [key: string, expr: string][]): string;

  /** Build a JSON array aggregation expression with a dialect-specific empty-array fallback. */
  buildJsonArrayAgg(jsonObjectExpr: string, orderBy?: string): string;

  /** Whether INSERT/UPDATE/DELETE support RETURNING rows. */
  readonly supportsReturning: boolean;

  /** Build a dialect-specific RETURNING clause. Return an empty string when unsupported. */
  buildReturningClause(selection?: string): string;

  /** Build a single-row INSERT statement. Inputs are SQL-ready quoted fragments. */
  buildInsertStatement(input: InsertStatementInput): string;

  /** Build a multi-row bulk INSERT statement and its dialect-shaped params. */
  buildBulkInsertStatement(input: BulkInsertStatementInput): BuiltStatement;

  /** Build an upsert statement. Inputs are SQL-ready quoted fragments. */
  buildUpsertStatement(input: UpsertStatementInput): string;

  /** Whether native ILIKE is supported. */
  readonly supportsILike: boolean;

  /** Build a case-insensitive LIKE equivalent. */
  buildInsensitiveLike(column: string, paramRef: string): string;

  /** JSON operator support level for this dialect. */
  readonly jsonPathSupport: 'native' | 'function' | 'limited';

  /** Build a JSON containment check. */
  buildJsonContains(column: string, paramRef: string): string;

  /** Build a JSON path text extraction expression. */
  buildJsonPathExtract(column: string, pathParamRef: string): string;

  /** Build a correlation clause across single or composite keys. */
  buildCorrelation(
    leftRef: string,
    leftColumns: string | string[],
    rightRef: string,
    rightColumns: string | string[],
  ): string;

  /** Optional type mapping hook for code generation/introspection. */
  typeToTypeScript?(dialectType: string, nullable: boolean): string;

  /** Optional array-cast hook for bulk insert implementations. */
  arrayType?(baseType: string): string;

  /** Map a schema-builder column type to dialect DDL. */
  buildColumnType(input: ColumnTypeInput): string;

  /** Build a column definition line for CREATE/ALTER TABLE. */
  buildColumnDefinition(input: ColumnDefinitionInput): string;

  /** Build a table-level PRIMARY KEY constraint. */
  buildPrimaryKeyConstraint(columns: string[]): string;

  /** Build a CREATE TABLE statement from SQL-ready definitions. */
  buildCreateTableStatement(input: CreateTableStatementInput): string;

  /** Build a CREATE INDEX statement. */
  buildCreateIndexStatement(input: CreateIndexStatementInput): string;

  /** Build the migration tracking table DDL. */
  buildMigrationTrackingTable(table: string): string;

  /** Build the query that reads applied migrations. */
  buildMigrationSelectApplied(table: string): string;

  /** Build the query that updates an applied migration checksum. */
  buildMigrationUpdateChecksum(table: string): string;

  /** Build the query that records an applied migration. */
  buildMigrationInsertApplied(table: string): string;

  /** Build the query that deletes a rolled-back migration record. */
  buildMigrationDeleteApplied(table: string): string;
}

export interface DialectIntrospector {
  introspect(options: IntrospectOptions): Promise<SchemaMetadata>;
}

export interface IntrospectOptions {
  connectionString: string;
  schema?: string;
  include?: string[];
  exclude?: string[];
}

export interface DialectMigrator {
  acquireLock(lockId: number): Promise<boolean>;
  releaseLock(lockId: number): Promise<void>;
}

/** PostgreSQL implementation of the dialect contract. */
export const postgresDialect: Dialect = {
  name: 'postgresql',
  supportsReturning: true,
  supportsILike: true,
  jsonPathSupport: 'native',
  emptyJsonArrayLiteral: "'[]'::json",
  nullJsonLiteral: 'NULL',

  paramPlaceholder(index: number): string {
    return `$${index}`;
  },

  quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  },

  escapeStringLiteral(value: string): string {
    return value.replace(/'/g, "''");
  },

  buildJsonObject(pairs: [key: string, expr: string][]): string {
    const args = pairs.map(([key, expr]) => `'${this.escapeStringLiteral(key)}', ${expr}`);
    return `json_build_object(${args.join(', ')})`;
  },

  buildJsonArrayAgg(jsonObjectExpr: string, orderBy?: string): string {
    const suffix = orderBy ? ` ${orderBy}` : '';
    return `COALESCE(json_agg(${jsonObjectExpr}${suffix}), ${this.emptyJsonArrayLiteral})`;
  },

  buildReturningClause(selection = '*'): string {
    return ` RETURNING ${selection}`;
  },

  buildInsertStatement(input: InsertStatementInput): string {
    return `INSERT INTO ${input.table} (${input.columns.join(', ')}) VALUES (${input.valuePlaceholders.join(', ')})${this.buildReturningClause(input.returning)}`;
  },

  buildBulkInsertStatement(input: BulkInsertStatementInput): BuiltStatement {
    if (!input.columnArrayTypes || input.columnArrayTypes.length !== input.columns.length) {
      throw new ValidationError('PostgreSQL bulk insert requires one array type per column');
    }

    const columnArrays = input.columns.map((_, columnIndex) => input.rowValues.map((row) => row[columnIndex]));
    const unnestArgs = input.columns.map((_, i) => `${this.paramPlaceholder(i + 1)}::${input.columnArrayTypes![i]}`);
    let sql = `INSERT INTO ${input.table} (${input.columns.join(', ')}) SELECT * FROM UNNEST(${unnestArgs.join(', ')})`;
    if (input.skipDuplicates) sql += ' ON CONFLICT DO NOTHING';
    return { sql: `${sql}${this.buildReturningClause(input.returning)}`, params: columnArrays };
  },

  buildUpsertStatement(input: UpsertStatementInput): string {
    return (
      `INSERT INTO ${input.table} (${input.insertColumns.join(', ')}) VALUES (${input.valuePlaceholders.join(', ')})` +
      ` ON CONFLICT (${input.conflictColumns.join(', ')}) DO UPDATE SET ${input.updateSetClauses.join(', ')}` +
      this.buildReturningClause(input.returning)
    );
  },

  buildInsensitiveLike(column: string, paramRef: string): string {
    return `${column} ILIKE ${paramRef}`;
  },

  buildJsonContains(column: string, paramRef: string): string {
    return `${column} @> ${paramRef}::jsonb`;
  },

  buildJsonPathExtract(column: string, pathParamRef: string): string {
    return `${column} #>> ${pathParamRef}::text[]`;
  },

  buildCorrelation(leftRef, leftColumns, rightRef, rightColumns): string {
    const leftCols = Array.isArray(leftColumns) ? leftColumns : [leftColumns];
    const rightCols = Array.isArray(rightColumns) ? rightColumns : [rightColumns];

    return leftCols
      .map((col, i) => `${leftRef}.${this.quoteIdentifier(col)} = ${rightRef}.${this.quoteIdentifier(rightCols[i]!)}`)
      .join(' AND ');
  },

  typeToTypeScript(dialectType: string, nullable: boolean): string {
    return pgTypeToTs(dialectType, nullable);
  },

  arrayType(baseType: string): string {
    return pgArrayType(baseType);
  },

  buildColumnType(input: ColumnTypeInput): string {
    if (input.type === 'VARCHAR' && input.maxLength != null) {
      return `VARCHAR(${input.maxLength})`;
    }
    return input.type;
  },

  buildColumnDefinition(input: ColumnDefinitionInput): string {
    const parts = [input.name, this.buildColumnType(input)];
    if (input.primaryKey) parts.push('PRIMARY KEY');
    if (input.unique && !input.primaryKey) parts.push('UNIQUE');
    if (input.notNull) parts.push('NOT NULL');
    if (input.defaultValue != null) parts.push(`DEFAULT ${input.defaultValue}`);
    if (input.references) parts.push(`REFERENCES ${input.references.table}(${input.references.column})`);
    return parts.join(' ');
  },

  buildPrimaryKeyConstraint(columns: string[]): string {
    return `PRIMARY KEY (${columns.join(', ')})`;
  },

  buildCreateTableStatement(input: CreateTableStatementInput): string {
    const body = input.definitions.map((d) => `    ${d}`).join(',\n');
    return `CREATE TABLE ${input.table} (\n${body}\n);`;
  },

  buildCreateIndexStatement(input: CreateIndexStatementInput): string {
    return `CREATE INDEX ${input.name} ON ${input.table}(${input.columns.join(', ')});`;
  },

  buildMigrationTrackingTable(table: string): string {
    return `
  CREATE TABLE IF NOT EXISTS ${table} (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;
  },

  buildMigrationSelectApplied(table: string): string {
    return `SELECT id, name, applied_at, checksum FROM ${table} ORDER BY id ASC`;
  },

  buildMigrationUpdateChecksum(table: string): string {
    return `UPDATE ${table} SET checksum = ${this.paramPlaceholder(1)} WHERE name = ${this.paramPlaceholder(2)}`;
  },

  buildMigrationInsertApplied(table: string): string {
    return `INSERT INTO ${table} (name, checksum) VALUES (${this.paramPlaceholder(1)}, ${this.paramPlaceholder(2)}) ON CONFLICT (name) DO NOTHING`;
  },

  buildMigrationDeleteApplied(table: string): string {
    return `DELETE FROM ${table} WHERE name = ${this.paramPlaceholder(1)}`;
  },
};
