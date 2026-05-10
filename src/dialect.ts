/**
 * turbine-orm — SQL dialect contract
 *
 * Phase-1 seam for future database packages. The current package remains
 * PostgreSQL-native by default, but query generation now depends on this
 * contract for the SQL primitives that vary across MySQL and SQLite.
 */

import type { SchemaMetadata } from './schema.js';

export type DialectName = 'postgresql' | 'mysql' | 'sqlite' | (string & {});

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
