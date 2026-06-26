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

/**
 * How a dialect surfaces the row(s) produced by an INSERT/UPDATE/DELETE/upsert.
 *
 *  - `'returning'` — a trailing `RETURNING *` clause returns the affected rows
 *    in the same statement (PostgreSQL, SQLite ≥ 3.35). The executor reads them
 *    directly from the statement result.
 *  - `'output'` — the statement itself emits the rows in a non-RETURNING shape
 *    (SQL Server `OUTPUT INSERTED.*`). Executed exactly like `'returning'`: the
 *    rows come back on the statement result.
 *  - `'reselect'` — the engine cannot return rows from a write (MySQL). The
 *    executor runs the write, then issues a follow-up `SELECT` (by primary
 *    key / unique / where predicate) to fetch the affected row(s). The build
 *    method supplies the {@link DeferredQuery} `reselect` plan that owns the
 *    statement ordering (write-then-select for create/update/upsert;
 *    select-then-write for delete, whose row is gone after the statement runs).
 */
export type ResultStrategy = 'returning' | 'output' | 'reselect';

/**
 * Minimal connection surface needed to drive a server-side stream (cursor /
 * driver iterator). `pg.PoolClient` and `PgCompatPoolClient` both satisfy it.
 * Declared locally so {@link Dialect.openStream} stays free of an import cycle
 * back into `client.ts`.
 */
export interface StreamableConnection {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface Dialect {
  /** Dialect identifier. */
  readonly name: DialectName;

  /**
   * How write statements surface their affected rows. PostgreSQL uses
   * `'returning'`; the executor branches on this so non-RETURNING engines
   * (MySQL `'reselect'`, SQL Server `'output'`) can still return rows.
   */
  readonly resultStrategy: ResultStrategy;

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

  /**
   * Whether the array-aggregate (`buildJsonArrayAgg`) can take an inline
   * `ORDER BY` argument. PostgreSQL's `json_agg(... ORDER BY ...)` can, so this
   * is `true`. Engines whose array aggregate has no ORDER BY argument
   * (MySQL `JSON_ARRAYAGG`, SQLite `json_group_array`) set this `false` to force
   * the inner-subquery rewrite for every ordered to-many relation.
   */
  readonly aggSupportsInlineOrderBy: boolean;

  /**
   * Wrap a correlated nested-relation subquery (and its empty/null fallback) for
   * embedding as a JSON value in a parent `json_build_object`. PostgreSQL emits
   * `COALESCE((subquery), fallback)`. SQLite must additionally `json(...)`-wrap
   * the subquery (its `json_group_array` double-encodes nested objects);
   * SQL Server uses `ISNULL((... FOR JSON PATH), '[]')`.
   */
  wrapJsonSubresult(subquery: string, fallback: string): string;

  /** Whether INSERT/UPDATE/DELETE support RETURNING rows. */
  readonly supportsReturning: boolean;

  /** Whether this dialect/engine supports pgvector distance ops (KNN / distance WHERE). */
  readonly supportsVector: boolean;

  /** Whether this dialect/engine supports LISTEN/NOTIFY realtime pub/sub. */
  readonly supportsListenNotify: boolean;

  /** Whether this dialect/engine supports row-level-security session GUCs (set_config). */
  readonly supportsRLS: boolean;

  /** Whether this dialect/engine supports advisory-lock-style migration locking. */
  readonly supportsAdvisoryLock: boolean;

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

  /**
   * Cast an aggregate result expression to an integer or float SQL type.
   * PostgreSQL uses the postfix casts `expr::int` / `expr::float`; portable
   * engines (e.g. SQLite, which has no `::` cast operator) emit
   * `CAST(expr AS INTEGER/REAL)`. Optional: when a dialect omits it, the query
   * builder falls back to the PostgreSQL postfix cast, so dialects that predate
   * this hook keep emitting byte-identical SQL.
   */
  castAggregate?(expr: string, target: 'int' | 'float'): string;

  /**
   * Build a membership (`IN` / `NOT IN`) predicate from a column/expression and
   * a single bound parameter reference. PostgreSQL binds the whole list as one
   * array param (`expr = ANY($n)` / `expr != ALL($n)`), so the placeholder count
   * stays independent of the list length and the SQL cache remains valid.
   * Engines without array parameters (SQLite) override this together with
   * {@link inClauseParam} to use a length-independent single-placeholder form
   * (e.g. `expr IN (SELECT value FROM json_each(?))`). Optional: the query
   * builder falls back to the PostgreSQL `ANY`/`ALL` form when absent.
   */
  buildInClause?(expr: string, paramRef: string, negated: boolean): string;

  /**
   * The single bound value for an `IN` list (paired with {@link buildInClause}).
   * PostgreSQL passes the array through unchanged; SQLite serializes it to a
   * JSON string consumed by `json_each`. Optional: defaults to the array itself.
   */
  inClauseParam?(values: unknown[]): unknown;

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

  // ---- Transaction control (keywords vary across engines) -----------------

  /** `BEGIN`, optionally with a SQL-ready isolation-level suffix. */
  beginStatement(isolationLevel?: string): string;

  /** Commit the current transaction. */
  commitStatement(): string;

  /** Roll back the current transaction. */
  rollbackStatement(): string;

  /** Establish a savepoint with the given (SQL-ready) name. */
  savepointStatement(name: string): string;

  /** Release the named savepoint. */
  releaseSavepointStatement(name: string): string;

  /** Roll back to the named savepoint. */
  rollbackToSavepointStatement(name: string): string;

  /**
   * Build a transaction-local session-config (GUC) assignment for RLS /
   * multi-tenant context. Both name and value are bound parameters.
   */
  buildSetSessionConfig(name: string, value: string): BuiltStatement;

  // ---- Streaming ----------------------------------------------------------

  /**
   * Drive a server-side stream of result rows on a single connection, yielding
   * row batches of up to `batchSize`. PostgreSQL uses a `DECLARE CURSOR` /
   * `FETCH` / `CLOSE` loop inside a transaction; other engines use their
   * driver's native streaming iterator.
   */
  openStream(
    connection: StreamableConnection,
    sql: string,
    params: unknown[],
    batchSize: number,
  ): AsyncGenerator<Record<string, unknown>[], void, undefined>;

  // ---- Introspection ------------------------------------------------------

  /**
   * Schema introspector for this engine. `introspect()` routes through it so
   * engines can override the catalog SQL. PostgreSQL wraps the
   * information_schema / pg_catalog reader in `introspect.ts`.
   */
  readonly introspector?: DialectIntrospector;
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

/**
 * @deprecated Migration locking is owned by the {@link DatabaseAdapter} seam
 * (`src/adapters/index.ts` — `acquireLock`/`releaseLock`/`statementTimeout`),
 * which is the single canonical locking seam. This interface was never
 * implemented or wired and is retained only for type back-compat; new engines
 * MUST provide a `DatabaseAdapter` instead. Will be removed in a future major.
 */
export interface DialectMigrator {
  acquireLock(lockId: number): Promise<boolean>;
  releaseLock(lockId: number): Promise<void>;
}

/** PostgreSQL implementation of the dialect contract. */
export const postgresDialect: Dialect = {
  name: 'postgresql',
  resultStrategy: 'returning',
  supportsReturning: true,
  supportsILike: true,
  jsonPathSupport: 'native',
  emptyJsonArrayLiteral: "'[]'::json",
  nullJsonLiteral: 'NULL',
  aggSupportsInlineOrderBy: true,
  supportsVector: true,
  supportsListenNotify: true,
  supportsRLS: true,
  supportsAdvisoryLock: true,

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

  wrapJsonSubresult(subquery: string, fallback: string): string {
    return `COALESCE((${subquery}), ${fallback})`;
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

  castAggregate(expr: string, target: 'int' | 'float'): string {
    return `${expr}::${target}`;
  },

  buildInClause(expr: string, paramRef: string, negated: boolean): string {
    return negated ? `${expr} != ALL(${paramRef})` : `${expr} = ANY(${paramRef})`;
  },

  inClauseParam(values: unknown[]): unknown {
    return values;
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

  beginStatement(isolationLevel?: string): string {
    return isolationLevel ? `BEGIN ISOLATION LEVEL ${isolationLevel}` : 'BEGIN';
  },

  commitStatement(): string {
    return 'COMMIT';
  },

  rollbackStatement(): string {
    return 'ROLLBACK';
  },

  savepointStatement(name: string): string {
    return `SAVEPOINT ${name}`;
  },

  releaseSavepointStatement(name: string): string {
    return `RELEASE SAVEPOINT ${name}`;
  },

  rollbackToSavepointStatement(name: string): string {
    return `ROLLBACK TO SAVEPOINT ${name}`;
  },

  buildSetSessionConfig(name: string, value: string): BuiltStatement {
    // set_config(name, value, is_local=true) — the parameterizable,
    // transaction-local equivalent of `SET LOCAL` (which rejects bind params).
    return {
      sql: `SELECT set_config(${this.paramPlaceholder(1)}, ${this.paramPlaceholder(2)}, true)`,
      params: [name, value],
    };
  },

  async *openStream(
    connection: StreamableConnection,
    sql: string,
    params: unknown[],
    batchSize: number,
  ): AsyncGenerator<Record<string, unknown>[], void, undefined> {
    // Cursors require a single connection inside a transaction. Identical SQL
    // sequence to the historical inline implementation: BEGIN → DECLARE … NO
    // SCROLL CURSOR FOR → FETCH n (loop) → CLOSE → COMMIT; ROLLBACK on error.
    const cursorName = `turbine_cursor_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const quotedCursor = this.quoteIdentifier(cursorName);
    await connection.query(this.beginStatement());
    try {
      await connection.query(`DECLARE ${quotedCursor} NO SCROLL CURSOR FOR ${sql}`, params);
      while (true) {
        const batch = await connection.query(`FETCH ${batchSize} FROM ${quotedCursor}`);
        if (batch.rows.length === 0) break;
        yield batch.rows;
        if (batch.rows.length < batchSize) break;
      }
      await connection.query(`CLOSE ${quotedCursor}`);
      await connection.query(this.commitStatement());
    } catch (err) {
      try {
        await connection.query(this.rollbackStatement());
      } catch {
        // Connection may already be broken — ignore rollback error.
      }
      throw err;
    }
  },

  // Postgres introspection wraps the information_schema / pg_catalog reader in
  // introspect.ts. A dynamic import keeps the static graph acyclic (introspect.ts
  // imports postgresDialect) and calls the raw catalog reader (never the router).
  introspector: {
    async introspect(options) {
      const { introspectPostgresCatalog } = await import('./introspect.js');
      return introspectPostgresCatalog(options);
    },
  },
};
