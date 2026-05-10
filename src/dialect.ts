/**
 * turbine-orm — SQL dialect contract
 *
 * Phase-1 seam for future database packages. The current package remains
 * PostgreSQL-native by default, but query generation now depends on this
 * contract for the SQL primitives that vary across MySQL and SQLite.
 */

import type { SchemaMetadata } from './schema.js';

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

  /** Type mapping hook for code generation. */
  typeToTypeScript(dialectType: string, nullable: boolean): string;

  /** Optional array-cast hook for bulk insert implementations. */
  arrayType?(baseType: string): string;
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
      throw new Error('PostgreSQL bulk insert requires one array type per column');
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

  typeToTypeScript(_dialectType: string, _nullable: boolean): string {
    // Existing PostgreSQL type mapping remains in schema.ts/generate.ts for now.
    // This hook is the package boundary MySQL/SQLite implementations will fill.
    return 'unknown';
  },
};
