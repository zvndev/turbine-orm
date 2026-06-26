/**
 * turbine-orm/mysql — MySQL 8 engine (driver-injected, optional peer)
 *
 * Binds Turbine to MySQL 8 via the `mysql2` driver. `mysql2` is **not** a root
 * dependency — it is an **optional peer**: `npm i turbine-orm` pulls nothing
 * extra, and only consumers who `import 'turbine-orm/mysql'` install `mysql2`
 * themselves. The factory loads it through a dynamic `import('mysql2/promise')`
 * so importing this module never crashes when `mysql2` is absent for a consumer
 * who does not use it. Turbine's root runtime dependency stays exactly `pg`.
 *
 * ## The two hard MySQL realities this engine solves
 *
 *  1. **No `RETURNING`.** `INSERT`/`UPDATE`/`DELETE` cannot return the affected
 *     rows. `mysqlDialect.resultStrategy = 'reselect'`: the executor runs the
 *     write, then issues a follow-up `SELECT` by primary key (using mysql2's
 *     `insertId` for auto-increment PKs) / by the `where` predicate, so
 *     `create`/`update`/`upsert`/`delete` still return real rows. This is the
 *     first shipped engine to exercise the Phase-0 `reselect` path.
 *  2. **Positional `?` is broken for this builder.** Turbine pushes params in
 *     1-indexed generation order but EMITS them in a different SQL-text position
 *     (e.g. a `with`-relation `LIMIT` lands in the SELECT list, ahead of the
 *     outer `WHERE`). Postgres reconciles this via numbered `$N`; positional `?`
 *     silently mis-binds. So `mysqlDialect` uses **mysql2 named placeholders**
 *     (`:p1`, `:p2`, …) and the driver shim binds via a `{ p1, p2, … }` object —
 *     exactly mirroring `$N` semantics regardless of text order. (See
 *     `turbine-orm/sqlite` for the same fix.)
 *
 * ## Capabilities & limits (vs PostgreSQL)
 *
 * - **Single query nested relations preserved** via MySQL 8 `JSON_OBJECT` /
 *   `JSON_ARRAYAGG` with `COALESCE(…, JSON_ARRAY())`. `JSON_ARRAYAGG` has no
 *   inline `ORDER BY` argument, so every ordered to-many relation is forced
 *   through the inner-subquery rewrite (`aggSupportsInlineOrderBy = false`).
 *   Nested subresults are `CAST(… AS JSON)`-wrapped so MySQL embeds them as real
 *   nested JSON instead of double-encoding a scalar subquery result as a string.
 * - **`createMany` returns an empty array** (count-not-rows). MySQL has no
 *   `RETURNING` and the bulk-insert `insertId` is only the first generated id, so
 *   re-selecting N rows reliably is unsafe. The rows ARE inserted; re-query if you
 *   need them back. (Plan §4 documented divergence.)
 * - **Unsupported (throw `UnsupportedFeatureError`):** pgvector distance ops,
 *   LISTEN/NOTIFY (`$listen`/`$notify`), RLS `sessionContext` (no GUCs).
 * - **Advisory-lock migration locking** is available in principle via
 *   `GET_LOCK`/`RELEASE_LOCK` (`supportsAdvisoryLock = true`); the migrate CLI is
 *   still PostgreSQL-only, so this flag documents intent for a future adapter.
 * - **Case-insensitive matching** uses `LOWER(col) LIKE LOWER(ref)` — note this
 *   can defeat indexes unless a functional/generated index exists.
 * - **bignum:** mysql2 is configured `supportBigNumbers:true, bigNumberStrings:false`
 *   — the same safe-int policy Turbine uses for Postgres `int8` (number when it
 *   fits, decimal string otherwise). `DECIMAL` comes back as a string; `TINYINT(1)`
 *   binds booleans as 1/0. No global parser state is mutated.
 * - **Version:** MySQL **8.0+** required (5.7 lacks `JSON_ARRAYAGG`); MariaDB is
 *   unsupported. The factory probes `SELECT VERSION()` and fails fast otherwise.
 *
 * ## Example
 *
 * ```ts
 * import { turbineMysql } from 'turbine-orm/mysql';
 * import { SCHEMA } from './generated/turbine/metadata.js';
 *
 * const db = await turbineMysql('mysql://user:pass@localhost:3306/app', SCHEMA);
 * const users = await db.users.findMany({ with: { posts: true }, limit: 10 });
 * await db.disconnect();
 * ```
 */

import { type PgCompatPool, type PgCompatPoolClient, TurbineClient, type TurbineConfig } from './client.js';
import {
  type BuiltStatement,
  type BulkInsertStatementInput,
  type ColumnDefinitionInput,
  type ColumnTypeInput,
  type CreateIndexStatementInput,
  type CreateTableStatementInput,
  type Dialect,
  type DialectIntrospector,
  type InsertStatementInput,
  type IntrospectOptions,
  postgresDialect,
  type StreamableConnection,
  type UpsertStatementInput,
} from './dialect.js';
import { ConnectionError, UnsupportedFeatureError } from './errors.js';
import {
  type ColumnMetadata,
  type IndexMetadata,
  isDateType,
  type RelationDef,
  type SchemaMetadata,
  singularize,
  snakeToCamel,
  type TableMetadata,
} from './schema.js';

// ---------------------------------------------------------------------------
// Minimal structural typing for the mysql2 surface we touch
// ---------------------------------------------------------------------------
//
// Typed structurally (not via `import type` from mysql2) so this module stays
// compilable and the shim logic stays decoupled from mysql2's complex generic
// result types. The real mysql2 pool is loaded via a dynamic import in the
// factory and cast to these shapes.

/** A value mysql2 accepts as a bound parameter. */
type MysqlParam = null | number | bigint | string | boolean | Date | Uint8Array;

/** mysql2's `[result, fields]` tuple. `result` is rows (SELECT) or a header (write). */
type Mysql2Result = [unknown, unknown];

interface Mysql2Queryable {
  query(sql: string, values?: unknown): Promise<Mysql2Result>;
  execute(sql: string, values?: unknown): Promise<Mysql2Result>;
}

interface Mysql2Connection extends Mysql2Queryable {
  release(): void;
}

interface Mysql2Pool extends Mysql2Queryable {
  getConnection(): Promise<Mysql2Connection>;
  end(): Promise<void>;
  // biome-ignore lint/suspicious/noExplicitAny: mysql2 pool exposes a Node EventEmitter `on`
  on?(event: string, listener: (...args: any[]) => void): unknown;
}

/** Shape of a mysql2 write result header (`ResultSetHeader`). */
interface Mysql2Header {
  affectedRows?: number;
  insertId?: number;
}

// ---------------------------------------------------------------------------
// Value coercion (params in)
// ---------------------------------------------------------------------------

/**
 * Coerce an arbitrary JS value into something mysql2 can bind. Booleans →
 * 1/0 (MySQL has no boolean type; `TINYINT(1)` stores 1/0), `undefined`/`null`
 * → NULL, `Date`/`Uint8Array` pass through (mysql2 formats them), and any
 * remaining object/array → JSON text (matches how Turbine already pre-serializes
 * JSON filter / `IN`-list params).
 */
function toMysqlParam(value: unknown): MysqlParam {
  if (value === undefined || value === null) return null;
  switch (typeof value) {
    case 'boolean':
      return value ? 1 : 0;
    case 'number':
    case 'bigint':
    case 'string':
      return value;
  }
  if (value instanceof Date) return value;
  if (value instanceof Uint8Array) return value; // also covers Buffer
  return JSON.stringify(value);
}

/**
 * Bind the positional `params[]` (in 1-indexed generation order) to the named
 * `:p1`, `:p2`, … placeholders the dialect emits. Mapping by NAME makes binding
 * independent of where each placeholder lands in the SQL text — the same
 * guarantee Postgres' numbered `$N` gives. Returns `undefined` for parameter-less
 * statements (BEGIN/COMMIT/DDL) so they bind nothing.
 */
function toNamedBinding(values: unknown[]): Record<string, MysqlParam> | undefined {
  if (values.length === 0) return undefined;
  const named: Record<string, MysqlParam> = {};
  for (let i = 0; i < values.length; i++) {
    named[`p${i + 1}`] = toMysqlParam(values[i]);
  }
  return named;
}

// ---------------------------------------------------------------------------
// Result shaping + error translation
// ---------------------------------------------------------------------------

/** Shape a mysql2 `[result]` into a `pg.QueryResult`-like object. */
function shapeResult(result: unknown): {
  rows: Record<string, unknown>[];
  rowCount: number;
  insertId?: number;
  lastID?: number;
} {
  if (Array.isArray(result)) {
    return { rows: result as Record<string, unknown>[], rowCount: result.length };
  }
  // Write statement → ResultSetHeader (no rows). Expose insertId/lastID for the
  // `reselect` strategy to re-fetch the auto-increment row.
  const header = (result ?? {}) as Mysql2Header;
  const insertId = header.insertId;
  return { rows: [], rowCount: header.affectedRows ?? 0, insertId, lastID: insertId };
}

/**
 * Augment a mysql2 driver error with the Postgres-shaped `.code` (SQLSTATE) and
 * detail fields that `wrapPgError` understands, so MySQL constraint failures
 * surface as the same typed Turbine errors as Postgres (E008/E009/E010/E011) and
 * deadlock / lock-wait-timeout become retryable (E012/E013). The original mysql2
 * error (with its real message) is preserved as the wrapped error's `.cause`
 * downstream. Returns the value unchanged when it is not a recognizable mysql2
 * error. We only annotate here — `wrapPgError` (invoked downstream in the query
 * executor / transaction proxy) does the actual translation.
 */
function augmentMysqlError(err: unknown): unknown {
  if (!err || typeof err !== 'object') return err;
  const e = err as { errno?: number; sqlMessage?: string; message?: string };
  if (typeof e.errno !== 'number') return err;

  const target = e as Record<string, unknown>;
  const msg = e.sqlMessage ?? e.message ?? '';

  switch (e.errno) {
    // ER_DUP_ENTRY → unique violation
    case 1062: {
      // "Duplicate entry 'x' for key 'users.email'"
      const m = /for key '([^']+)'/i.exec(msg);
      target.code = '23505';
      if (m?.[1]) {
        const key = m[1];
        const parts = key.split('.');
        target.constraint = parts.length > 1 ? parts[parts.length - 1] : key;
      }
      return err;
    }
    // ER_ROW_IS_REFERENCED_2 / ER_NO_REFERENCED_ROW_2 → foreign key violation
    case 1451:
    case 1452:
      target.code = '23503';
      return err;
    // ER_BAD_NULL_ERROR / ER_NO_DEFAULT_FOR_FIELD → not-null violation
    case 1048:
    case 1364: {
      const m = /Column '([^']+)'/i.exec(msg);
      target.code = '23502';
      if (m?.[1]) target.column = m[1];
      return err;
    }
    // ER_CHECK_CONSTRAINT_VIOLATED (8.0.16+) / ER_CONSTRAINT_FAILED → check violation
    case 3819:
    case 3813:
      target.code = '23514';
      return err;
    // ER_LOCK_DEADLOCK → deadlock (retryable, maps to pg 40P01)
    case 1213:
      target.code = '40P01';
      return err;
    // ER_LOCK_WAIT_TIMEOUT → treat as a serialization failure (retryable, pg 40001)
    case 1205:
      target.code = '40001';
      return err;
    default:
      return err;
  }
}

// ---------------------------------------------------------------------------
// Driver shim — wrap a mysql2 pool as a PgCompatPool
// ---------------------------------------------------------------------------

/** pg-style query argument: a SQL string or a `{ text, values }` config object. */
type QueryArg = string | { name?: string; text: string; values?: unknown[] };

function normalizeQueryArgs(arg: QueryArg, values?: unknown[]): { text: string; params: unknown[] } {
  if (typeof arg === 'string') return { text: arg, params: values ?? [] };
  return { text: arg.text, params: arg.values ?? values ?? [] };
}

/**
 * Run one statement against a mysql2 queryable (pool or connection). Parameterized
 * statements use `.execute()` (mysql2 server-side prepared statements, cached per
 * connection); parameter-less statements (transaction control, DDL) use `.query()`,
 * since not every such statement can be prepared. Named placeholders are bound via
 * the `{ p1, p2, … }` object built from the positional params.
 */
async function execOne(
  runner: Mysql2Queryable,
  sql: string,
  params: unknown[],
): Promise<ReturnType<typeof shapeResult>> {
  const binding = toNamedBinding(params);
  try {
    const [result] = binding ? await runner.execute(sql, binding) : await runner.query(sql);
    return shapeResult(result);
  } catch (err) {
    throw augmentMysqlError(err);
  }
}

/**
 * Run a statement on a dedicated transaction connection. MySQL cannot take an
 * inline isolation level on `START TRANSACTION`, so {@link mysqlDialect.beginStatement}
 * emits `SET TRANSACTION ISOLATION LEVEL <level>; START TRANSACTION`. mysql2 runs
 * one statement per call (multi-statements stay OFF by design), so split exactly
 * that dialect-generated compound and run the parts in order. Gated on the precise
 * transaction-control prefix — the query builder never emits `SET TRANSACTION
 * ISOLATION LEVEL`, so no builder/user SQL is ever split.
 */
async function runOnConnection(
  conn: Mysql2Connection,
  sql: string,
  params: unknown[],
): Promise<ReturnType<typeof shapeResult>> {
  if (params.length === 0 && /^SET TRANSACTION ISOLATION LEVEL /i.test(sql) && sql.includes('; ')) {
    let last = shapeResult([]);
    for (const part of sql.split('; ')) {
      const trimmed = part.trim();
      if (trimmed) last = await execOne(conn, trimmed, []);
    }
    return last;
  }
  return execOne(conn, sql, params);
}

/**
 * A {@link PgCompatPool} backed by a `mysql2` pool. Non-transaction queries run
 * on the pool directly (any connection); `connect()` checks out a dedicated
 * connection so a transaction's `START TRANSACTION` / `COMMIT` / `ROLLBACK` /
 * `SAVEPOINT` nesting all run on the same physical connection.
 */
export class MysqlPool implements PgCompatPool {
  /** The underlying mysql2 pool — exposed as an escape hatch (seed / DDL / advanced ops). */
  readonly pool: Mysql2Pool;
  private closed = false;

  constructor(pool: Mysql2Pool) {
    this.pool = pool;
  }

  // biome-ignore lint/suspicious/noExplicitAny: pg-compat query is generic over the row shape; execOne returns plain objects.
  async query(text: QueryArg, values?: unknown[]): Promise<any> {
    const { text: sql, params } = normalizeQueryArgs(text, values);
    return execOne(this.pool, sql, params);
  }

  async connect(): Promise<PgCompatPoolClient> {
    const conn = await this.pool.getConnection();
    return {
      // biome-ignore lint/suspicious/noExplicitAny: see query() above.
      query: async (text: QueryArg, values?: unknown[]): Promise<any> => {
        const { text: sql, params } = normalizeQueryArgs(text, values);
        return runOnConnection(conn, sql, params);
      },
      release: () => conn.release(),
    };
  }

  async end(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }
}

// ---------------------------------------------------------------------------
// Type mapping (MySQL data type → TypeScript)
// ---------------------------------------------------------------------------

/**
 * Map a MySQL column type to a TypeScript type. `dialectType` is the
 * `information_schema.COLUMNS.DATA_TYPE` (e.g. `bigint`, `varchar`, `datetime`);
 * `columnType` is the full `COLUMN_TYPE` (e.g. `tinyint(1)`, `enum('a','b')`)
 * used to detect `TINYINT(1)` booleans.
 */
export function mysqlTypeToTs(dialectType: string, nullable: boolean, columnType?: string): string {
  const t = dialectType.toLowerCase();
  const full = (columnType ?? '').toLowerCase();
  let base: string;
  if (t === 'tinyint' && full === 'tinyint(1)') base = 'boolean';
  else if (/^(tinyint|smallint|mediumint|int|integer|bigint)$/.test(t)) base = 'number';
  else if (/^(decimal|numeric)$/.test(t)) base = 'string';
  else if (/^(float|double|real)$/.test(t)) base = 'number';
  else if (/^(datetime|timestamp|date)$/.test(t)) base = 'Date';
  else if (t === 'json') base = 'unknown';
  else if (/(blob|binary|varbinary)/.test(t)) base = 'Uint8Array';
  else if (/(char|text|enum|set|time|year|bit)/.test(t)) base = 'string';
  else base = 'unknown';
  return nullable ? `${base} | null` : base;
}

/** Is a MySQL declared type a date/time type (so values coerce back to `Date`)? */
function isMysqlDateType(dialectType: string): boolean {
  const t = dialectType.toLowerCase();
  return isDateType(t) || /^(datetime|timestamp|date)$/.test(t);
}

/** Map a schema-builder (Postgres-flavored) column type to MySQL DDL. */
function mysqlColumnType(type: string, maxLength?: number | null): string {
  const t = type.toUpperCase();
  if (/BIGSERIAL/.test(t)) return 'BIGINT AUTO_INCREMENT';
  if (/SERIAL/.test(t)) return 'INT AUTO_INCREMENT';
  if (/BIGINT|INT8/.test(t)) return 'BIGINT';
  if (/SMALLINT|INT2/.test(t)) return 'SMALLINT';
  if (/INTEGER|INT4|\bINT\b/.test(t)) return 'INT';
  if (/BOOL/.test(t)) return 'TINYINT(1)';
  if (/DOUBLE|FLOAT8/.test(t)) return 'DOUBLE';
  if (/REAL|FLOAT4|FLOAT/.test(t)) return 'FLOAT';
  if (/NUMERIC|DECIMAL|MONEY/.test(t)) return 'DECIMAL(65,30)';
  if (/JSONB|JSON/.test(t)) return 'JSON';
  if (/UUID/.test(t)) return 'CHAR(36)';
  if (/TIMESTAMPTZ|TIMESTAMP|DATETIME/.test(t)) return 'DATETIME';
  if (/\bDATE\b/.test(t)) return 'DATE';
  if (/\bTIME\b/.test(t)) return 'TIME';
  if (/BYTEA|BLOB/.test(t)) return 'BLOB';
  if (/VARCHAR/.test(t)) return maxLength != null ? `VARCHAR(${maxLength})` : 'VARCHAR(255)';
  if (/CHAR/.test(t)) return maxLength != null ? `CHAR(${maxLength})` : 'CHAR(255)';
  if (/TEXT|CLOB/.test(t)) return 'TEXT';
  if (/ENUM/.test(t)) return 'TEXT';
  return type;
}

// ---------------------------------------------------------------------------
// mysqlDialect — the full Dialect contract for MySQL 8
// ---------------------------------------------------------------------------

/**
 * MySQL 8 implementation of the {@link Dialect} contract. Backtick identifier
 * quoting, named `:pN` placeholders (NOT positional `?` — see the module
 * docstring), `JSON_OBJECT` / `JSON_ARRAYAGG` for the single-query nested
 * relation engine (`CAST(… AS JSON)`-wrapped nested subresults), no `RETURNING`
 * (`resultStrategy = 'reselect'`), `INSERT … ON DUPLICATE KEY UPDATE` upserts,
 * and the Postgres-only capabilities disabled (vector / LISTEN-NOTIFY / RLS).
 */
export const mysqlDialect: Dialect = {
  ...postgresDialect,
  name: 'mysql',
  // No RETURNING → run the write, then re-SELECT by PK/where (Phase-0 reselect).
  resultStrategy: 'reselect',
  supportsReturning: false,
  supportsILike: false,
  supportsVector: false,
  supportsListenNotify: false,
  supportsRLS: false,
  // GET_LOCK / RELEASE_LOCK exist (used by a future migrate adapter).
  supportsAdvisoryLock: true,
  // JSON_ARRAYAGG has no inline ORDER BY argument → force the inner-subquery
  // rewrite for every ordered to-many relation.
  aggSupportsInlineOrderBy: false,
  // mysql2's binary (prepared) protocol sends JS numbers as DOUBLE, which MySQL's
  // LIMIT/OFFSET reject ("Incorrect arguments to mysqld_stmt_execute"). Render
  // pagination as inline integer literals (Turbine-validated, injection-safe).
  inlineLimitOffset: true,
  jsonPathSupport: 'function',
  emptyJsonArrayLiteral: 'JSON_ARRAY()',
  nullJsonLiteral: 'NULL',

  // Named placeholders (`:p1`, `:p2`, …) — NOT positional `?`. Turbine pushes
  // params in 1-indexed generation order but may EMIT them in a different SQL
  // text position; positional `?` mis-binds. mysql2 named parameters bind by
  // name, so `:pN` ↔ `params[N-1]` mirrors Postgres' `$N` regardless of text
  // order. The driver shim binds via a `{ p1, p2, … }` object.
  paramPlaceholder(index: number): string {
    return `:p${index}`;
  },

  quoteIdentifier(name: string): string {
    return `\`${name.replace(/`/g, '``')}\``;
  },

  buildJsonObject(pairs: [key: string, expr: string][]): string {
    const args = pairs.map(([key, expr]) => `'${this.escapeStringLiteral(key)}', ${expr}`);
    return `JSON_OBJECT(${args.join(', ')})`;
  },

  // JSON_ARRAYAGG over an empty group returns NULL → COALESCE to JSON_ARRAY().
  // The orderBy argument is ignored (MySQL's JSON_ARRAYAGG has no ORDER BY arg);
  // aggSupportsInlineOrderBy=false guarantees the builder never passes one.
  buildJsonArrayAgg(jsonObjectExpr: string): string {
    return `COALESCE(JSON_ARRAYAGG(${jsonObjectExpr}), JSON_ARRAY())`;
  },

  /**
   * Wrap a nested correlated subquery for embedding inside a parent `JSON_OBJECT`.
   * MySQL double-encodes a scalar subquery result as a JSON *string* unless it is
   * explicitly typed JSON, so `CAST((subquery) AS JSON)` forces the nested value
   * to be embedded as real JSON (objects/arrays), not a quoted string — the same
   * intent as SQLite's `json(...)` wrap. The fallback (`JSON_ARRAY()` / `NULL`) is
   * already JSON-typed.
   */
  wrapJsonSubresult(subquery: string, fallback: string): string {
    return `COALESCE(CAST((${subquery}) AS JSON), ${fallback})`;
  },

  // MySQL aggregate casts: COUNT → SIGNED (BIGINT, comes back as a JS number when
  // safe), AVG/float → DECIMAL (string, the aggregate transform Number()-coerces).
  castAggregate(expr: string, target: 'int' | 'float'): string {
    return `CAST(${expr} AS ${target === 'int' ? 'SIGNED' : 'DECIMAL(65,30)'})`;
  },

  // No array params in MySQL. JSON_TABLE expands a single JSON-array param into a
  // row set, keeping ONE placeholder (so the SQL cache stays valid regardless of
  // list length) and handling the empty-list case (zero rows). MySQL coerces the
  // non-JSON `expr` to JSON for the comparison, so this works for numbers AND
  // strings. JSON_TABLE requires MySQL 8.0+.
  buildInClause(expr: string, paramRef: string, negated: boolean): string {
    const inner = `SELECT \`v\` FROM JSON_TABLE(${paramRef}, '$[*]' COLUMNS (\`v\` JSON PATH '$')) AS \`jt\``;
    return `${expr} ${negated ? 'NOT IN' : 'IN'} (${inner})`;
  },

  inClauseParam(values: unknown[]): unknown {
    return JSON.stringify(values ?? []);
  },

  // No RETURNING — resultStrategy 'reselect' re-fetches the row.
  buildReturningClause(): string {
    return '';
  },

  buildInsertStatement(input: InsertStatementInput): string {
    return `INSERT INTO ${input.table} (${input.columns.join(', ')}) VALUES (${input.valuePlaceholders.join(', ')})`;
  },

  buildBulkInsertStatement(input: BulkInsertStatementInput): BuiltStatement {
    // No UNNEST in MySQL — emit multi-row VALUES with flattened, named
    // placeholders (`:p1`, `:p2`, …) matching the flat param order.
    let n = 0;
    const placeholders = input.rowValues
      .map((row) => `(${row.map(() => this.paramPlaceholder(++n)).join(', ')})`)
      .join(', ');
    // skipDuplicates → no-op ON DUPLICATE KEY UPDATE (keeps the existing row).
    const firstCol = input.columns[0] ?? '`id`';
    const conflict = input.skipDuplicates ? ` ON DUPLICATE KEY UPDATE ${firstCol} = ${firstCol}` : '';
    return {
      sql: `INSERT INTO ${input.table} (${input.columns.join(', ')}) VALUES ${placeholders}${conflict}`,
      params: input.rowValues.flat(),
    };
  },

  buildUpsertStatement(input: UpsertStatementInput): string {
    // MySQL ignores the explicit conflict target — ON DUPLICATE KEY UPDATE keys
    // off the table's PK/unique indexes. The `where`-derived conflictColumns
    // (input.conflictColumns) must therefore correspond to a real unique/PK index
    // for the upsert to target the intended row (plan §4 / R9).
    return (
      `INSERT INTO ${input.table} (${input.insertColumns.join(', ')}) VALUES (${input.valuePlaceholders.join(', ')})` +
      ` ON DUPLICATE KEY UPDATE ${input.updateSetClauses.join(', ')}`
    );
  },

  buildInsensitiveLike(column: string, paramRef: string): string {
    // Deterministic case-insensitive match. NOTE: LOWER(col) can defeat an index
    // unless a functional/generated index exists.
    return `LOWER(${column}) LIKE LOWER(${paramRef})`;
  },

  buildJsonContains(column: string, paramRef: string): string {
    return `JSON_CONTAINS(${column}, ${paramRef})`;
  },

  buildJsonPathExtract(column: string, pathParamRef: string): string {
    return `JSON_UNQUOTE(JSON_EXTRACT(${column}, ${pathParamRef}))`;
  },

  // ---- Type mapping -------------------------------------------------------

  typeToTypeScript(dialectType: string, nullable: boolean): string {
    return mysqlTypeToTs(dialectType, nullable);
  },

  // MySQL has no true array columns; bulk insert uses multi-row VALUES, so no
  // array cast is ever needed. Disables the UNNEST path.
  arrayType: undefined,

  // ---- DDL ----------------------------------------------------------------

  buildColumnType(input: ColumnTypeInput): string {
    return mysqlColumnType(input.type, input.maxLength);
  },

  buildColumnDefinition(input: ColumnDefinitionInput): string {
    const isSerial = /serial/i.test(input.type);
    const parts: string[] = [input.name, this.buildColumnType(input)];
    // AUTO_INCREMENT columns must be a key; emit PRIMARY KEY inline for a serial PK.
    if (input.primaryKey) parts.push('PRIMARY KEY');
    else if (input.unique) parts.push('UNIQUE');
    if (input.notNull && !isSerial && !input.primaryKey) parts.push('NOT NULL');
    if (input.defaultValue != null) parts.push(`DEFAULT ${input.defaultValue}`);
    if (input.references) parts.push(`REFERENCES ${input.references.table}(${input.references.column})`);
    return parts.join(' ');
  },

  buildCreateIndexStatement(input: CreateIndexStatementInput): string {
    return `CREATE INDEX ${input.name} ON ${input.table}(${input.columns.join(', ')});`;
  },

  buildCreateTableStatement(input: CreateTableStatementInput): string {
    const body = input.definitions.map((d) => `    ${d}`).join(',\n');
    return `CREATE TABLE ${input.table} (\n${body}\n);`;
  },

  // ---- Migration tracking -------------------------------------------------
  // SelectApplied / UpdateChecksum / DeleteApplied inherit from postgresDialect:
  // they call `this.paramPlaceholder(n)` (→ `:pN`) and standard SQL, all valid
  // MySQL. The tracking-table DDL and the upsert INSERT need MySQL forms.

  buildMigrationTrackingTable(table: string): string {
    return `
  CREATE TABLE IF NOT EXISTS ${table} (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    checksum VARCHAR(255) NOT NULL,
    applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`;
  },

  buildMigrationInsertApplied(table: string): string {
    return `INSERT INTO ${table} (name, checksum) VALUES (${this.paramPlaceholder(1)}, ${this.paramPlaceholder(2)}) ON DUPLICATE KEY UPDATE name = name`;
  },

  // ---- Transaction control ------------------------------------------------

  beginStatement(isolationLevel?: string): string {
    // MySQL cannot take an inline isolation level on START TRANSACTION. The
    // driver shim (runOnConnection) splits this exact compound and runs the
    // parts in order on the same connection.
    return isolationLevel
      ? `SET TRANSACTION ISOLATION LEVEL ${isolationLevel}; START TRANSACTION`
      : 'START TRANSACTION';
  },

  buildSetSessionConfig(): BuiltStatement {
    // Never reached: supportsRLS=false makes $transaction throw before calling
    // this. Guarded here too so a misuse fails loudly rather than emitting GUC SQL.
    throw new UnsupportedFeatureError(
      'sessionContext (RLS session GUCs)',
      'mysql',
      'MySQL has no transaction-local GUCs / set_config equivalent.',
    );
  },

  // ---- Streaming ----------------------------------------------------------

  /**
   * The {@link StreamableConnection} seam only exposes `query()`, not mysql2's
   * native `.stream()`, so the "stream" fetches once and yields the rows in
   * `batchSize` chunks. True server-side streaming would require direct mysql2
   * access (documented limitation).
   */
  async *openStream(
    connection: StreamableConnection,
    sql: string,
    params: unknown[],
    batchSize: number,
  ): AsyncGenerator<Record<string, unknown>[], void, undefined> {
    const result = await connection.query(sql, params);
    for (let i = 0; i < result.rows.length; i += batchSize) {
      yield result.rows.slice(i, i + batchSize);
    }
  },

  // ---- Introspection ------------------------------------------------------

  introspector: {
    async introspect(options) {
      return introspectMysql(options);
    },
  } satisfies DialectIntrospector,
};

// ---------------------------------------------------------------------------
// Introspection — information_schema-driven SchemaMetadata
// ---------------------------------------------------------------------------

/** Async executor that returns plain row objects for a parameterized query. */
export type MysqlRowExecutor = (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

interface InfoColumn {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  DATA_TYPE: string;
  COLUMN_TYPE: string;
  IS_NULLABLE: string;
  COLUMN_KEY: string;
  COLUMN_DEFAULT: string | null;
  EXTRA: string;
  CHARACTER_MAXIMUM_LENGTH: number | string | null;
}
interface InfoKey {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  ORDINAL_POSITION: number | string;
}
interface InfoFk extends InfoKey {
  REFERENCED_TABLE_NAME: string;
  REFERENCED_COLUMN_NAME: string;
  CONSTRAINT_NAME: string;
}
interface InfoIndex {
  TABLE_NAME: string;
  INDEX_NAME: string;
  NON_UNIQUE: number | string;
  COLUMN_NAME: string;
  SEQ_IN_INDEX: number | string;
}

const num = (v: number | string | null | undefined): number => (typeof v === 'string' ? Number(v) : (v ?? 0));

interface FKEntry {
  sourceTable: string;
  sourceColumns: string[];
  targetTable: string;
  targetColumns: string[];
  constraintName: string;
}

/**
 * Derive belongsTo + hasMany relations (and conservatively-detected manyToMany
 * junctions) from a flat foreign-key list. Mirrors the PostgreSQL / SQLite
 * introspectors so the produced {@link SchemaMetadata} has an identical relation
 * shape across engines.
 */
function buildRelationsFromForeignKeys(
  tableNames: string[],
  foreignKeys: FKEntry[],
  pkByTable: Map<string, string[]>,
  columnsByTable: Map<string, ColumnMetadata[]>,
): Map<string, Record<string, RelationDef>> {
  const tableSet = new Set(tableNames);
  const fkCounts = new Map<string, number>();
  for (const fk of foreignKeys) {
    const key = `${fk.sourceTable}->${fk.targetTable}`;
    fkCounts.set(key, (fkCounts.get(key) ?? 0) + 1);
  }
  const relationsByTable = new Map<string, Record<string, RelationDef>>();
  for (const fk of foreignKeys) {
    if (!tableSet.has(fk.targetTable)) continue;
    const needsDisambiguation = (fkCounts.get(`${fk.sourceTable}->${fk.targetTable}`) ?? 0) > 1;
    const foreignKey = fk.sourceColumns.length === 1 ? fk.sourceColumns[0]! : fk.sourceColumns;
    const referenceKey = fk.targetColumns.length === 1 ? fk.targetColumns[0]! : fk.targetColumns;

    const belongsToName =
      needsDisambiguation && fk.sourceColumns.length === 1
        ? snakeToCamel(fk.sourceColumns[0]!.replace(/_id$/, ''))
        : singularize(snakeToCamel(fk.targetTable));
    if (!relationsByTable.has(fk.sourceTable)) relationsByTable.set(fk.sourceTable, {});
    relationsByTable.get(fk.sourceTable)![belongsToName] = {
      type: 'belongsTo',
      name: belongsToName,
      from: fk.sourceTable,
      to: fk.targetTable,
      foreignKey,
      referenceKey,
    };

    const hasManyName =
      needsDisambiguation && fk.sourceColumns.length === 1
        ? snakeToCamel(`${fk.sourceTable}_by_${fk.sourceColumns[0]!.replace(/_id$/, '')}`)
        : snakeToCamel(fk.sourceTable);
    if (!relationsByTable.has(fk.targetTable)) relationsByTable.set(fk.targetTable, {});
    relationsByTable.get(fk.targetTable)![hasManyName] = {
      type: 'hasMany',
      name: hasManyName,
      from: fk.targetTable,
      to: fk.sourceTable,
      foreignKey,
      referenceKey,
    };
  }

  // Conservative many-to-many auto-detection (additive): a table J is a pure
  // junction iff PK is exactly two columns, exactly two single-column FKs whose
  // source columns ARE the PK, two distinct target tables, and no payload columns.
  for (const tableName of tableNames) {
    const pk = pkByTable.get(tableName) ?? [];
    if (pk.length !== 2) continue;
    const tableFks = foreignKeys.filter((fk) => fk.sourceTable === tableName);
    if (tableFks.length !== 2) continue;
    if (tableFks.some((fk) => fk.sourceColumns.length !== 1)) continue;
    const fkCols = tableFks.map((fk) => fk.sourceColumns[0]!);
    const pkSet = new Set(pk);
    if (!fkCols.every((c) => pkSet.has(c))) continue;
    if (new Set(fkCols).size !== 2) continue;
    const [fkA, fkB] = tableFks as [FKEntry, FKEntry];
    if (fkA.targetTable === fkB.targetTable) continue;
    const jCols = (columnsByTable.get(tableName) ?? []).map((c) => c.name);
    if (jCols.length !== 2) continue;

    const addM2M = (self: FKEntry, other: FKEntry) => {
      const sourceTbl = self.targetTable;
      const targetTbl = other.targetTable;
      const relName = snakeToCamel(targetTbl);
      if (!relationsByTable.has(sourceTbl)) relationsByTable.set(sourceTbl, {});
      const existing = relationsByTable.get(sourceTbl)!;
      if (existing[relName]) return;
      existing[relName] = {
        type: 'manyToMany',
        name: relName,
        from: sourceTbl,
        to: targetTbl,
        referenceKey: self.targetColumns.length === 1 ? self.targetColumns[0]! : self.targetColumns,
        foreignKey: self.targetColumns.length === 1 ? self.targetColumns[0]! : self.targetColumns,
        through: {
          table: tableName,
          sourceKey: self.sourceColumns[0]!,
          targetKey: other.sourceColumns[0]!,
        },
      };
    };
    addM2M(fkA, fkB);
    addM2M(fkB, fkA);
  }

  return relationsByTable;
}

/**
 * Introspect a MySQL database into the same {@link SchemaMetadata} shape the
 * Postgres catalog introspector produces, using a caller-supplied query
 * executor (so tests can dogfood an already-open mysql2 pool/connection).
 *
 * @param exec    Runs a parameterized (`:p1`, `:p2`, …) query and returns rows.
 * @param schema  The MySQL database (schema) name to introspect.
 * @param options Optional include / exclude table-name filters.
 */
export async function introspectMysqlWith(
  exec: MysqlRowExecutor,
  schema: string,
  options: { include?: string[]; exclude?: string[] } = {},
): Promise<SchemaMetadata> {
  // ----- Tables -----
  let tableNames = (
    await exec(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = :p1 AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
      [schema],
    )
  ).map((r) => String(r.TABLE_NAME));
  if (options.include?.length) {
    const inc = new Set(options.include);
    tableNames = tableNames.filter((t) => inc.has(t));
  }
  if (options.exclude?.length) {
    const exc = new Set(options.exclude);
    tableNames = tableNames.filter((t) => !exc.has(t));
  }
  const tableSet = new Set(tableNames);

  // ----- Columns -----
  const columnRows = (await exec(
    `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY,
            COLUMN_DEFAULT, EXTRA, CHARACTER_MAXIMUM_LENGTH
     FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = :p1 ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [schema],
  )) as unknown as InfoColumn[];

  const columnsByTable = new Map<string, ColumnMetadata[]>();
  const enums: Record<string, string[]> = {};
  for (const c of columnRows) {
    if (!tableSet.has(c.TABLE_NAME)) continue;
    const nullable = c.IS_NULLABLE === 'YES' && c.COLUMN_KEY !== 'PRI';
    const dataType = c.DATA_TYPE.toLowerCase();
    // Inline ENUM parsing from COLUMN_TYPE: enum('a','b','c')
    if (dataType === 'enum') {
      const m = /^enum\((.*)\)$/i.exec(c.COLUMN_TYPE);
      if (m?.[1]) {
        enums[`${c.TABLE_NAME}.${c.COLUMN_NAME}`] = m[1].split(',').map((s) =>
          s
            .trim()
            .replace(/^'(.*)'$/, '$1')
            .replace(/''/g, "'"),
        );
      }
    }
    const maxLen = c.CHARACTER_MAXIMUM_LENGTH != null ? num(c.CHARACTER_MAXIMUM_LENGTH) : undefined;
    const col: ColumnMetadata = {
      name: c.COLUMN_NAME,
      field: snakeToCamel(c.COLUMN_NAME),
      dialectType: dataType,
      pgType: dataType,
      tsType: mysqlTypeToTs(dataType, nullable, c.COLUMN_TYPE),
      nullable,
      hasDefault: c.COLUMN_DEFAULT !== null || /auto_increment/i.test(c.EXTRA),
      isArray: false,
      arrayType: undefined,
      pgArrayType: 'text[]',
    };
    if (maxLen !== undefined) col.maxLength = maxLen;
    if (!columnsByTable.has(c.TABLE_NAME)) columnsByTable.set(c.TABLE_NAME, []);
    columnsByTable.get(c.TABLE_NAME)!.push(col);
  }

  // ----- Primary keys (ordered) -----
  const pkRows = (await exec(
    `SELECT TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = :p1 AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [schema],
  )) as unknown as InfoKey[];
  const pkByTable = new Map<string, string[]>();
  for (const r of pkRows) {
    if (!tableSet.has(r.TABLE_NAME)) continue;
    if (!pkByTable.has(r.TABLE_NAME)) pkByTable.set(r.TABLE_NAME, []);
    pkByTable.get(r.TABLE_NAME)!.push(r.COLUMN_NAME);
  }

  // ----- Foreign keys (grouped by constraint for composite FKs) -----
  const fkRows = (await exec(
    `SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, CONSTRAINT_NAME, ORDINAL_POSITION
     FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = :p1 AND REFERENCED_TABLE_NAME IS NOT NULL
     ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`,
    [schema],
  )) as unknown as InfoFk[];
  const fkByConstraint = new Map<string, FKEntry>();
  for (const r of fkRows) {
    if (!tableSet.has(r.TABLE_NAME)) continue;
    const key = `${r.TABLE_NAME}.${r.CONSTRAINT_NAME}`;
    let entry = fkByConstraint.get(key);
    if (!entry) {
      entry = {
        sourceTable: r.TABLE_NAME,
        sourceColumns: [],
        targetTable: r.REFERENCED_TABLE_NAME,
        targetColumns: [],
        constraintName: r.CONSTRAINT_NAME,
      };
      fkByConstraint.set(key, entry);
    }
    entry.sourceColumns.push(r.COLUMN_NAME);
    entry.targetColumns.push(r.REFERENCED_COLUMN_NAME);
  }
  const foreignKeys = [...fkByConstraint.values()].filter((fk) => tableSet.has(fk.targetTable));

  // ----- Indexes + unique constraints -----
  const idxRows = (await exec(
    `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = :p1 ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    [schema],
  )) as unknown as InfoIndex[];
  const indexGroups = new Map<string, { table: string; name: string; unique: boolean; columns: string[] }>();
  for (const r of idxRows) {
    if (!tableSet.has(r.TABLE_NAME)) continue;
    const key = `${r.TABLE_NAME}.${r.INDEX_NAME}`;
    let g = indexGroups.get(key);
    if (!g) {
      g = { table: r.TABLE_NAME, name: r.INDEX_NAME, unique: num(r.NON_UNIQUE) === 0, columns: [] };
      indexGroups.set(key, g);
    }
    g.columns.push(r.COLUMN_NAME);
  }
  const indexesByTable = new Map<string, IndexMetadata[]>();
  const uniqueByTable = new Map<string, string[][]>();
  for (const g of indexGroups.values()) {
    if (g.name === 'PRIMARY') continue; // PK is tracked separately
    if (!indexesByTable.has(g.table)) indexesByTable.set(g.table, []);
    indexesByTable.get(g.table)!.push({
      name: g.name,
      columns: g.columns,
      unique: g.unique,
      definition: `${g.unique ? 'UNIQUE ' : ''}INDEX ${g.name} ON ${g.table}(${g.columns.join(', ')})`,
    });
    if (g.unique && g.columns.length > 0) {
      if (!uniqueByTable.has(g.table)) uniqueByTable.set(g.table, []);
      uniqueByTable.get(g.table)!.push(g.columns);
    }
  }

  // ----- Relations -----
  const relationsByTable = buildRelationsFromForeignKeys(tableNames, foreignKeys, pkByTable, columnsByTable);

  // ----- Assemble TableMetadata -----
  const tables: Record<string, TableMetadata> = {};
  for (const tableName of tableNames) {
    const columns = columnsByTable.get(tableName) ?? [];
    const columnMap: Record<string, string> = {};
    const reverseColumnMap: Record<string, string> = {};
    const dateColumns = new Set<string>();
    const dialectTypes: Record<string, string> = {};
    const pgTypes: Record<string, string> = {};
    const allColumns: string[] = [];

    for (const col of columns) {
      columnMap[col.field] = col.name;
      reverseColumnMap[col.name] = col.field;
      allColumns.push(col.name);
      dialectTypes[col.name] = col.dialectType ?? col.pgType;
      pgTypes[col.name] = col.pgType;
      if (isMysqlDateType(col.dialectType ?? col.pgType)) dateColumns.add(col.name);
    }

    tables[tableName] = {
      name: tableName,
      columns,
      columnMap,
      reverseColumnMap,
      dateColumns,
      dialectTypes,
      pgTypes,
      allColumns,
      primaryKey: pkByTable.get(tableName) ?? [],
      uniqueColumns: uniqueByTable.get(tableName) ?? [],
      relations: relationsByTable.get(tableName) ?? {},
      indexes: indexesByTable.get(tableName) ?? [],
    };
  }

  return { tables, enums } satisfies SchemaMetadata;
}

/**
 * Open a short-lived mysql2 connection from `options.connectionString`,
 * introspect the database (schema = `options.schema` or the connection's current
 * database), and close it. Wraps {@link introspectMysqlWith} for the
 * {@link DialectIntrospector} seam used by `introspect()` / `npx turbine generate`.
 */
export async function introspectMysql(options: IntrospectOptions): Promise<SchemaMetadata> {
  const createPool = await loadCreatePool();
  const config = parseMysqlConfig(options.connectionString);
  const pool = createPool({ ...config, ...MYSQL_DRIVER_FLAGS }) as Mysql2Pool;
  try {
    const exec: MysqlRowExecutor = async (sql, params) => (await execOne(pool, sql, params)).rows;
    let schemaName = options.schema ?? config.database;
    if (!schemaName) {
      const rows = await exec('SELECT DATABASE() AS db', []);
      schemaName = (rows[0]?.db as string) ?? '';
    }
    if (!schemaName) {
      throw new ConnectionError(
        '[turbine] Could not determine the MySQL database to introspect — pass a database in the connection string or a `schema` option.',
      );
    }
    return introspectMysqlWith(exec, schemaName, { include: options.include, exclude: options.exclude });
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// mysql2 loading + config
// ---------------------------------------------------------------------------

/** mysql2 connection flags Turbine pins for correct behavior. */
const MYSQL_DRIVER_FLAGS = {
  // Named placeholders (`:pN`) — see paramPlaceholder + toNamedBinding.
  namedPlaceholders: true,
  // Safe-int policy matching Postgres int8: number when it fits, decimal string
  // otherwise. DECIMAL always comes back as a string. No global state mutated.
  supportBigNumbers: true,
  bigNumberStrings: false,
  // DATETIME/TIMESTAMP → JS Date interpreted as UTC (matches Postgres).
  dateStrings: false,
  timezone: 'Z',
  // Force JSON columns to raw strings so the nested-relation parser
  // (parseNestedRow) always takes its well-tested JSON.parse path, instead of
  // mysql2's auto-parsed objects or a Buffer. Top-level JSON columns therefore
  // come back as strings (consistent with the SQLite engine; parse them yourself).
  // biome-ignore lint/suspicious/noExplicitAny: mysql2 typeCast field shape (has .type and .string()).
  typeCast: (field: any, next: () => unknown): unknown => (field.type === 'JSON' ? field.string() : next()),
} as const;

interface MysqlConnectionConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
}

/** Parse a `mysql://user:pass@host:port/db` connection string into mysql2 config. */
function parseMysqlConfig(connectionString: string): MysqlConnectionConfig {
  try {
    const u = new URL(connectionString);
    const config: MysqlConnectionConfig = {
      host: u.hostname || 'localhost',
      port: u.port ? Number(u.port) : 3306,
    };
    if (u.username) config.user = decodeURIComponent(u.username);
    if (u.password) config.password = decodeURIComponent(u.password);
    const db = u.pathname.replace(/^\//, '');
    if (db) config.database = decodeURIComponent(db);
    return config;
  } catch {
    throw new ConnectionError(`[turbine] Invalid MySQL connection string: "${connectionString}"`);
  }
}

/** A mysql2 `createPool`-like function. */
// biome-ignore lint/suspicious/noExplicitAny: mysql2 pool options are loosely typed at this seam.
type CreatePool = (config: any) => Mysql2Pool;

/**
 * Dynamically load `mysql2/promise`'s `createPool`. Kept out of the module's
 * static import graph so `import 'turbine-orm/mysql'` never throws when `mysql2`
 * is absent for a consumer that does not use the factory.
 */
async function loadCreatePool(): Promise<CreatePool> {
  let mod: { createPool?: CreatePool; default?: { createPool?: CreatePool } };
  try {
    mod = (await import('mysql2/promise')) as typeof mod;
  } catch (err) {
    throw new ConnectionError(
      "[turbine] turbine-orm/mysql requires the optional peer dependency 'mysql2'. Install it: npm i mysql2. " +
        `(${(err as Error).message})`,
    );
  }
  const createPool = mod.createPool ?? mod.default?.createPool;
  if (typeof createPool !== 'function') {
    throw new ConnectionError("[turbine] Loaded 'mysql2/promise' but it has no createPool export.");
  }
  return createPool;
}

/**
 * Fail fast on unsupported servers: MySQL 8.0+ is required (5.7 lacks
 * JSON_ARRAYAGG) and MariaDB is unsupported (its JSON_ARRAYAGG semantics differ).
 */
function assertSupportedVersion(version: string): void {
  if (/mariadb/i.test(version)) {
    throw new ConnectionError(
      `[turbine] MariaDB is not supported by turbine-orm/mysql (got "${version}"). Use MySQL 8.0+.`,
    );
  }
  const m = /^(\d+)\.(\d+)/.exec(version);
  const major = m ? Number(m[1]) : 0;
  if (major < 8) {
    throw new ConnectionError(
      `[turbine] turbine-orm/mysql requires MySQL 8.0+ (5.7 lacks JSON_ARRAYAGG); got "${version}".`,
    );
  }
}

// ---------------------------------------------------------------------------
// turbineMysql — the public factory
// ---------------------------------------------------------------------------

/** Options for {@link turbineMysql}. Mirrors the relevant {@link TurbineConfig} fields. */
export interface TurbineMysqlOptions extends Pick<TurbineConfig, 'logging' | 'defaultLimit' | 'warnOnUnlimited'> {
  /** Maximum number of pooled connections (when Turbine builds the pool). Default: 10. */
  connectionLimit?: number;
}

function isMysql2Pool(x: unknown): x is Mysql2Pool {
  return (
    !!x &&
    typeof (x as Mysql2Pool).getConnection === 'function' &&
    typeof (x as Mysql2Pool).query === 'function' &&
    typeof (x as Mysql2Pool).end === 'function'
  );
}

/**
 * Create a {@link TurbineClient} bound to MySQL 8 via `mysql2`.
 *
 * Pass one of:
 *  - a connection string (`'mysql://user:pass@host:3306/db'`),
 *  - a mysql2 connection config object (`{ host, user, password, database }`), or
 *  - an existing mysql2 pool / {@link MysqlPool} (injection — you own its lifecycle,
 *    `disconnect()` is a no-op, advanced config like SSL lives here).
 *
 * When Turbine builds the pool (string/config), it pins the correct mysql2 flags
 * (named placeholders, bignum, UTC dates, JSON-as-string), probes `SELECT VERSION()`
 * to reject MySQL < 8.0 / MariaDB, and `disconnect()` closes the pool it created.
 *
 * @example
 * ```ts
 * import { turbineMysql } from 'turbine-orm/mysql';
 * const db = await turbineMysql('mysql://root:root@localhost:3306/app', SCHEMA);
 * ```
 */
export async function turbineMysql(
  target: string | MysqlConnectionConfig | Mysql2Pool | MysqlPool,
  schema: SchemaMetadata,
  options: TurbineMysqlOptions = {},
): Promise<TurbineClient> {
  let pool: MysqlPool;
  let owns = false;

  if (target instanceof MysqlPool) {
    pool = target;
  } else if (isMysql2Pool(target)) {
    pool = new MysqlPool(target);
  } else {
    const createPool = await loadCreatePool();
    const baseConfig = typeof target === 'string' ? parseMysqlConfig(target) : (target as MysqlConnectionConfig);
    const mysql2Pool = createPool({
      ...baseConfig,
      connectionLimit: options.connectionLimit ?? 10,
      ...MYSQL_DRIVER_FLAGS,
    });
    // Every NEW physical connection: disable backslash string escaping so the
    // builder's `LIKE … ESCAPE '\'` clause (a single literal backslash) is valid
    // MySQL — by default MySQL would parse `'\'` as an escaped quote (syntax
    // error). This also makes string-literal semantics match Postgres. Turbine
    // parameterizes every value, so no behavior depends on backslash escaping.
    //
    // NOTE: even on a `mysql2/promise` pool, the 'connection' event yields the
    // *raw* (callback-style) connection — its `.query()` returns a non-thenable
    // `Query`, so `.catch()`/`await` on it throws "result of query that is not a
    // promise". Use the callback form here (fire-and-forget): if the SET fails we
    // fall back to MySQL's default escaping, harmless since every value is a param.
    mysql2Pool.on?.('connection', (rawConn: { query: (sql: string, cb: () => void) => void }) => {
      rawConn.query("SET SESSION sql_mode = CONCAT(@@sql_mode, ',NO_BACKSLASH_ESCAPES')", () => {});
    });
    pool = new MysqlPool(mysql2Pool);
    owns = true;
  }

  // Probe the server version (fail fast on MySQL < 8.0 / MariaDB).
  const versionRows = (await pool.query('SELECT VERSION() AS v')).rows as { v?: string }[];
  assertSupportedVersion(String(versionRows[0]?.v ?? ''));

  const client = new TurbineClient(
    {
      pool,
      dialect: mysqlDialect,
      preparedStatements: false,
      logging: options.logging,
      defaultLimit: options.defaultLimit,
      warnOnUnlimited: options.warnOnUnlimited,
    },
    schema,
  );

  if (owns) {
    // Turbine built this pool, so disconnect()/end() must close it. External
    // pools (injection) stay the caller's responsibility (disconnect() no-op),
    // consistent with turbineHttp / turbineSqlite.
    const baseDisconnect = client.disconnect.bind(client);
    const close = async (): Promise<void> => {
      await baseDisconnect();
      await pool.end();
    };
    const patch = client as unknown as { disconnect: () => Promise<void>; end: () => Promise<void> };
    patch.disconnect = close;
    patch.end = close;
  }

  return client;
}
