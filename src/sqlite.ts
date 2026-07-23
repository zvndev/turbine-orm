/**
 * turbine-orm/sqlite — zero-dependency SQLite engine
 *
 * Binds Turbine to SQLite via Node's built-in `node:sqlite` driver
 * (`DatabaseSync`), so SQLite is a **zero new dependency** engine: the root
 * package's runtime dependency stays exactly `pg`. This is the in-process
 * test / edge / "try it in 10 seconds" engine — `:memory:` databases run
 * entirely in-process with no service container.
 *
 * ## Driver
 *
 * - **Primary:** `node:sqlite` `DatabaseSync` (Node ≥ 22.5, experimental). Emits
 *   an `ExperimentalWarning` — harmless. No native build, no extra dependency.
 * - **Fallback:** `better-sqlite3` for Node < 22.5. Not bundled and not required;
 *   wrap a `better-sqlite3` handle in the same `PgCompatPool` shape if needed.
 *
 * ## Capabilities & limits (vs PostgreSQL)
 *
 * - `RETURNING` + `ON CONFLICT … DO UPDATE` (SQLite ≥ 3.35) → create / upsert /
 *   update / delete return real rows in a single statement (`resultStrategy =
 *   'returning'`, same as Postgres).
 * - **Single-writer:** one connection / one write transaction at a time;
 *   concurrent writers get `SQLITE_BUSY` (treated as retryable). `journal_mode =
 *   WAL` is enabled for file databases to allow concurrent readers.
 * - **Unsupported (throw `UnsupportedFeatureError`):** pgvector distance ops,
 *   LISTEN/NOTIFY (`$listen` / `$notify`), RLS `sessionContext`. Advisory-lock
 *   migration locking is unavailable — SQLite is single-writer, so migrations
 *   serialize naturally.
 * - **Type affinity caveats:** SQLite has no native `BOOLEAN` (0/1 integers) or
 *   `DATE` (TEXT/INTEGER). Booleans bind as 1/0; `Date` values bind as ISO-8601
 *   text; columns declared `TIMESTAMP`/`DATETIME`/`DATE` are coerced back to
 *   `Date`. Integers wider than `Number.MAX_SAFE_INTEGER` come back as strings
 *   (the same safe-int policy Turbine uses for Postgres `int8`).
 * - **Case-insensitive matching** uses `COLLATE NOCASE`, which is **ASCII-only**
 *   (no Unicode case folding).
 *
 * ## Example — `:memory:` database
 *
 * ```ts
 * import { turbineSqlite } from 'turbine-orm/sqlite';
 * import { SCHEMA } from './generated/turbine/metadata.js';
 *
 * const db = turbineSqlite(':memory:', SCHEMA);
 * const users = await db.users.findMany({ with: { posts: true }, limit: 10 });
 * await db.disconnect();
 * ```
 */

import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { type PgCompatPool, type PgCompatPoolClient, TurbineClient, type TurbineConfig } from './client.js';
import {
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
  type ReturningSelection,
  type StreamableConnection,
  type UpsertStatementInput,
} from './dialect.js';
import { ConnectionError } from './errors.js';
import { applyTableFilters, deriveEngineRelations } from './introspect.js';
import {
  type ColumnMetadata,
  type IndexMetadata,
  isDateType,
  type SchemaMetadata,
  snakeToCamel,
  type TableMetadata,
} from './schema.js';

// ---------------------------------------------------------------------------
// Driver constructor — lazily loaded
// ---------------------------------------------------------------------------

/** The shape of `node:sqlite`'s `DatabaseSync` constructor. */
type DatabaseSyncCtor = new (path: string, options?: unknown) => DatabaseSync;

let cachedDatabaseSync: DatabaseSyncCtor | undefined;

/**
 * Lazily load `node:sqlite`'s `DatabaseSync` constructor.
 *
 * `node:sqlite` is a built-in only on Node >= 22.5, so importing it at module
 * top-level would make `import 'turbine-orm/sqlite'` — and any module that
 * merely re-exports `sqliteDialect` (e.g. the dialect test suite) — throw
 * `ERR_UNKNOWN_BUILTIN_MODULE` on Node 20. Deferring the require to the moment a
 * connection is actually opened keeps the dialect (pure SQL generation) usable
 * everywhere and scopes the Node-version requirement to `turbineSqlite()`.
 *
 * `createRequire` is anchored on `process.cwd()` so this works identically in
 * the ESM and CJS builds (no `import.meta` / `__filename`, which differ between
 * them); built-in module resolution ignores the anchor entirely.
 */
function loadDatabaseSync(): DatabaseSyncCtor {
  if (cachedDatabaseSync) return cachedDatabaseSync;
  let ctor: DatabaseSyncCtor | undefined;
  try {
    const req = createRequire(process.cwd());
    ctor = (req('node:sqlite') as { DatabaseSync?: DatabaseSyncCtor }).DatabaseSync;
  } catch (err) {
    throw new ConnectionError(
      "[turbine] turbine-orm/sqlite requires Node's built-in 'node:sqlite' module (Node >= 22.5). " +
        `Upgrade Node to >= 22.5, or pass an already-open better-sqlite3-compatible handle. (${(err as Error).message})`,
    );
  }
  if (typeof ctor !== 'function') {
    throw new ConnectionError(
      "[turbine] 'node:sqlite' loaded but did not export a DatabaseSync constructor — this Node build may lack SQLite support.",
    );
  }
  cachedDatabaseSync = ctor;
  return cachedDatabaseSync;
}

// ---------------------------------------------------------------------------
// Value coercion (params in, rows out)
// ---------------------------------------------------------------------------

/** Values `node:sqlite` accepts as a bound parameter. */
type SqliteParam = null | number | bigint | string | Uint8Array;

/**
 * Coerce an arbitrary JS value into something `node:sqlite` can bind.
 *
 * `node:sqlite` throws on `boolean`, `undefined`, `Date`, and plain objects, so
 * we normalize: booleans → 1/0, `undefined`/`null` → NULL, `Date` → ISO text,
 * `Uint8Array`/`Buffer` → BLOB, and any remaining object/array → JSON text
 * (matches how Turbine already pre-serializes JSON filter params).
 */
function toSqliteParam(value: unknown): SqliteParam {
  if (value === undefined || value === null) return null;
  switch (typeof value) {
    case 'boolean':
      return value ? 1 : 0;
    case 'number':
    case 'bigint':
    case 'string':
      return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return value; // also covers Buffer
  return JSON.stringify(value);
}

/**
 * Normalize a single column value read from SQLite. With `setReadBigInts(true)`
 * every integer column comes back as a `bigint`; apply the same safe-integer
 * policy Turbine uses for Postgres `int8` — number when it fits in a JS safe
 * integer, otherwise the decimal string to avoid precision loss. Never mutates
 * any global parser state (the policy lives entirely in this shim).
 */
function normalizeValue(value: null | number | bigint | string | Uint8Array): unknown {
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  return value;
}

/** Convert a `node:sqlite` null-prototype row into a normalized plain object. */
function normalizeRow(row: Record<string, null | number | bigint | string | Uint8Array>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    out[key] = normalizeValue(row[key] as null | number | bigint | string | Uint8Array);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Statement classification + error translation
// ---------------------------------------------------------------------------

/** Statements whose first keyword yields a result set. */
const ROW_RETURNING_HEAD = /^\s*(?:select|with|pragma|explain|values)\b/i;

/**
 * Decide whether a statement produces rows (use `.all()`) or only a change
 * count (use `.run()` to capture `changes` for updateMany/deleteMany).
 * A `RETURNING` clause turns any write into a row-producing statement.
 */
function statementReturnsRows(sql: string): boolean {
  return ROW_RETURNING_HEAD.test(sql) || /\breturning\b/i.test(sql);
}

/**
 * Augment a `node:sqlite` error with the Postgres-shaped fields that
 * `wrapPgError` understands, so SQLite constraint failures surface as the same
 * typed Turbine errors as Postgres (E008/E009/E010/E011) and `SQLITE_BUSY`
 * becomes a retryable error. The original error (with its real SQLite message)
 * is preserved as the `cause`. Returns the value unchanged when it is not a
 * recognizable SQLite error.
 *
 * `wrapPgError` is invoked downstream (in the query executor and the
 * transaction proxy), so we only annotate here — we never throw a `new`
 * Turbine error from the driver itself.
 */
function augmentSqliteError(err: unknown): unknown {
  if (!err || typeof err !== 'object') return err;
  const e = err as { errcode?: number; message?: string; code?: string };
  if (typeof e.errcode !== 'number') return err;

  const target = e as Record<string, unknown>;
  const message = e.message ?? '';
  // Primary SQLite result code = errcode & 0xff; the rest are extended codes.
  const primary = e.errcode & 0xff;

  switch (e.errcode) {
    // SQLITE_CONSTRAINT_UNIQUE (2067) / SQLITE_CONSTRAINT_PRIMARYKEY (1555)
    case 2067:
    case 1555: {
      // "UNIQUE constraint failed: tbl.col[, tbl.col2]"
      const m = /constraint failed:\s*(.+)$/i.exec(message);
      const pairs = m ? m[1]!.split(',').map((s) => s.trim()) : [];
      const cols = pairs.map((p) => p.split('.').pop() ?? p);
      target.code = '23505';
      target.table = pairs[0]?.split('.')[0];
      target.detail = `Key (${cols.join(', ')})=() already exists.`;
      return err;
    }
    // SQLITE_CONSTRAINT_FOREIGNKEY (787)
    case 787:
      target.code = '23503';
      return err;
    // SQLITE_CONSTRAINT_NOTNULL (1299)
    case 1299: {
      const m = /constraint failed:\s*([^.\s]+)\.(\S+)/i.exec(message);
      target.code = '23502';
      if (m) {
        target.table = m[1];
        target.column = m[2];
      }
      return err;
    }
    // SQLITE_CONSTRAINT_CHECK (275)
    case 275:
      target.code = '23514';
      return err;
    default:
      // SQLITE_BUSY (5) / SQLITE_LOCKED (6) / SQLITE_BUSY_SNAPSHOT (261) etc.
      if (primary === 5 || primary === 6) {
        // Map to serialization_failure so withRetry()/$retry() retry it.
        target.code = '40001';
      }
      return err;
  }
}

// ---------------------------------------------------------------------------
// Driver shim — wrap a node:sqlite DatabaseSync as a PgCompatPool
// ---------------------------------------------------------------------------

/** pg-style query argument: a SQL string or a `{ text, values }` config object. */
type QueryArg = string | { name?: string; text: string; values?: unknown[] };

function normalizeQueryArgs(arg: QueryArg, values?: unknown[]): { text: string; params: unknown[] } {
  if (typeof arg === 'string') return { text: arg, params: values ?? [] };
  return { text: arg.text, params: arg.values ?? values ?? [] };
}

/**
 * Execute one statement against a `DatabaseSync` handle and shape the result
 * like a `pg.QueryResult` (`{ rows, rowCount }`). Row-returning statements use
 * `.all()`; pure writes use `.run()` so `changes` populates `rowCount` (which
 * `updateMany` / `deleteMany` read). `lastID` mirrors mysql2's insert-id for
 * parity with the `reselect` strategy (unused by SQLite's `returning` path).
 */
/**
 * Bind the positional `params[]` (in 1-indexed generation order) to the named
 * `:p1`, `:p2`, … placeholders the dialect emits. Mapping by NAME makes binding
 * independent of where each placeholder lands in the SQL text — the same
 * guarantee Postgres' numbered `$N` gives. Returns `undefined` when there are no
 * params so parameter-less statements (BEGIN/COMMIT/DDL) bind nothing.
 */
function toNamedBinding(values: unknown[]): Record<string, SqliteParam> | undefined {
  if (values.length === 0) return undefined;
  const named: Record<string, SqliteParam> = {};
  for (let i = 0; i < values.length; i++) {
    named[`p${i + 1}`] = toSqliteParam(values[i]);
  }
  return named;
}

function runStatement(db: DatabaseSync, sql: string, values: unknown[]) {
  const binding = toNamedBinding(values);
  let stmt: ReturnType<DatabaseSync['prepare']>;
  try {
    stmt = db.prepare(sql);
  } catch (err) {
    throw augmentSqliteError(err);
  }
  stmt.setReadBigInts(true);
  try {
    if (statementReturnsRows(sql)) {
      const rows = (binding ? stmt.all(binding) : stmt.all()).map(normalizeRow);
      return { rows, rowCount: rows.length };
    }
    const info = binding ? stmt.run(binding) : stmt.run();
    const changes = typeof info.changes === 'bigint' ? Number(info.changes) : info.changes;
    const lastID = typeof info.lastInsertRowid === 'bigint' ? Number(info.lastInsertRowid) : info.lastInsertRowid;
    return { rows: [] as Record<string, unknown>[], rowCount: changes, lastID, insertId: lastID };
  } catch (err) {
    throw augmentSqliteError(err);
  }
}

/**
 * A `PgCompatPool` backed by a single `node:sqlite` `DatabaseSync` connection.
 * SQLite is single-connection by nature (a `:memory:` database is per-handle),
 * so `connect()` hands back a client over the **same** handle — transactions
 * (`BEGIN`/`COMMIT`/`ROLLBACK`, `SAVEPOINT` nesting) just run on it. Queries are
 * serialized; this is the documented single-writer model.
 */
export class SqlitePool implements PgCompatPool {
  /** The underlying `node:sqlite` handle — exposed as an escape hatch (seed/DDL). */
  readonly db: DatabaseSync;
  private closed = false;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  // biome-ignore lint/suspicious/noExplicitAny: pg-compat query is generic over the row shape; runStatement returns plain objects.
  async query(text: QueryArg, values?: unknown[]): Promise<any> {
    const { text: sql, params } = normalizeQueryArgs(text, values);
    return runStatement(this.db, sql, params);
  }

  async connect(): Promise<PgCompatPoolClient> {
    const db = this.db;
    return {
      // biome-ignore lint/suspicious/noExplicitAny: see query() above.
      query: async (text: QueryArg, values?: unknown[]): Promise<any> => {
        const { text: sql, params } = normalizeQueryArgs(text, values);
        return runStatement(db, sql, params);
      },
      release: () => {
        // Single shared connection — nothing to return to a pool.
      },
    };
  }

  async end(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Type mapping (SQLite declared type → TypeScript)
// ---------------------------------------------------------------------------

/**
 * Map a SQLite declared column type (type affinity) to a TypeScript type.
 * SQLite is dynamically typed; we read the declared `PRAGMA table_info` type.
 */
export function sqliteTypeToTs(declaredType: string, nullable: boolean): string {
  const t = declaredType.toLowerCase();
  let base: string;
  if (/int/.test(t)) base = 'number';
  else if (/(real|floa|doub)/.test(t)) base = 'number';
  else if (/bool/.test(t)) base = 'boolean';
  else if (/(timestamp|datetime|date)/.test(t)) base = 'Date';
  else if (/(char|clob|text)/.test(t)) base = 'string';
  else if (/blob/.test(t)) base = 'Uint8Array';
  else if (/(numeric|decimal)/.test(t)) base = 'string';
  else if (t === '')
    base = 'unknown'; // no declared affinity (BLOB affinity)
  else base = 'unknown';
  return nullable ? `${base} | null` : base;
}

/** Is a SQLite declared type a date/time type (so values coerce back to `Date`)? */
function isSqliteDateType(declaredType: string): boolean {
  const t = declaredType.toLowerCase();
  return isDateType(t) || /(timestamp|datetime|date)/.test(t);
}

/** Map a schema-builder (Postgres-flavored) column type to a SQLite affinity. */
function sqliteColumnAffinity(type: string): string {
  const t = type.toUpperCase();
  if (/SERIAL|INT/.test(t)) return 'INTEGER';
  if (/REAL|FLOAT|DOUBLE/.test(t)) return 'REAL';
  if (/NUMERIC|DECIMAL|MONEY/.test(t)) return 'NUMERIC';
  if (/BLOB|BYTEA/.test(t)) return 'BLOB';
  if (/BOOL/.test(t)) return 'INTEGER';
  // TEXT, VARCHAR, CHAR, UUID, JSON(B), TIMESTAMP(TZ), DATE, TIME, ENUM, …
  return 'TEXT';
}

// ---------------------------------------------------------------------------
// sqliteDialect — the full Dialect contract for SQLite
// ---------------------------------------------------------------------------

/**
 * SQLite implementation of the {@link Dialect} contract. Standardizes on `"…"`
 * identifier quoting and positional `?` placeholders, uses `json_object` /
 * `json_group_array` for the single-query nested-relation engine (with the
 * critical `json(...)` subresult wrap so nested objects are real JSON, not
 * SQLite's strings-of-strings double-encoding), keeps `RETURNING` + `ON CONFLICT`
 * (SQLite ≥ 3.35), and disables the Postgres-only capabilities (vector,
 * LISTEN/NOTIFY, RLS, advisory locks).
 */
export const sqliteDialect: Dialect = {
  ...postgresDialect,
  name: 'sqlite',
  resultStrategy: 'returning', // SQLite ≥ 3.35 has RETURNING
  supportsReturning: true,
  supportsILike: false,
  supportsVector: false,
  supportsListenNotify: false,
  supportsRLS: false,
  supportsAdvisoryLock: false,
  // No FROM-clause LATERAL: the opt-in lateral pick plan is Postgres-only.
  supportsLateralJoin: false,
  // SQLite explains a compiled query with `EXPLAIN QUERY PLAN` (four columns:
  // id, parent, notused, detail), overriding the inherited Postgres `EXPLAIN`.
  explainQuery: { prefix: 'EXPLAIN QUERY PLAN' },
  // json_group_array / json_object have no inline ORDER BY argument, so every
  // ordered to-many relation is forced through the inner-subquery rewrite.
  aggSupportsInlineOrderBy: false,
  jsonPathSupport: 'function',
  emptyJsonArrayLiteral: "json('[]')",
  nullJsonLiteral: 'NULL',

  // Named placeholders (`:p1`, `:p2`, …) — NOT positional `?`. Turbine pushes
  // params in 1-indexed generation order but may EMIT them in a different SQL
  // text position (e.g. a `with`-relation LIMIT lands in the SELECT list, ahead
  // of the outer WHERE). Postgres reconciles this via numbered `$N`; positional
  // `?` cannot. SQLite named parameters bind by name, so `:pN` ↔ `params[N-1]`
  // exactly mirrors Postgres' `$N` semantics regardless of text order. The
  // driver binds via a `{ p1, p2, … }` object built from the positional array.
  paramPlaceholder(index: number): string {
    return `:p${index}`;
  },

  quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  },

  buildJsonObject(pairs: [key: string, expr: string][]): string {
    const args = pairs.map(([key, expr]) => `'${this.escapeStringLiteral(key)}', ${expr}`);
    return `json_object(${args.join(', ')})`;
  },

  buildJsonArrayAgg(jsonObjectExpr: string, orderBy?: string): string {
    // json() wraps each aggregated object so SQLite stores real JSON, not an
    // escaped string; COALESCE handles the empty-group NULL.
    const suffix = orderBy ? ` ${orderBy}` : '';
    return `COALESCE(json_group_array(json(${jsonObjectExpr}))${suffix}, json('[]'))`;
  },

  /**
   * SQLite's `json_group_array` double-encodes nested objects unless each nested
   * subresult is `json(...)`-wrapped. This is the whole point of the hook: it
   * keeps `users[0].posts[0].author.name` a real parsed tree instead of a string
   * containing a string containing JSON.
   */
  wrapJsonSubresult(subquery: string, fallback: string): string {
    return `COALESCE(json((${subquery})), ${fallback})`;
  },

  castAggregate(expr: string, target: 'int' | 'float'): string {
    return `CAST(${expr} AS ${target === 'int' ? 'INTEGER' : 'REAL'})`;
  },

  // No `= ANY(array)` in SQLite. `json_each` expands a single JSON-array param
  // into a row set, keeping ONE placeholder (so the SQL cache stays valid
  // regardless of list length) and handling the empty-list case correctly.
  buildInClause(expr: string, paramRef: string, negated: boolean): string {
    return `${expr} ${negated ? 'NOT IN' : 'IN'} (SELECT value FROM json_each(${paramRef}))`;
  },

  inClauseParam(values: unknown[]): unknown {
    return JSON.stringify(values ?? []);
  },

  buildReturningClause(selection: ReturningSelection = '*'): string {
    return ` RETURNING ${selection === '*' ? '*' : selection.join(', ')}`;
  },

  buildInsertStatement(input: InsertStatementInput): string {
    return (
      `INSERT INTO ${input.table} (${input.columns.join(', ')}) ` +
      `VALUES (${input.valuePlaceholders.join(', ')})${this.buildReturningClause(input.returning)}`
    );
  },

  buildBulkInsertStatement(input: BulkInsertStatementInput) {
    // No UNNEST in SQLite — emit multi-row VALUES with flattened, named
    // placeholders (`:p1`, `:p2`, …) matching the flat param order.
    let n = 0;
    const placeholders = input.rowValues
      .map((row) => `(${row.map(() => this.paramPlaceholder(++n)).join(', ')})`)
      .join(', ');
    const conflict = input.skipDuplicates ? ' ON CONFLICT DO NOTHING' : '';
    return {
      sql:
        `INSERT INTO ${input.table} (${input.columns.join(', ')}) VALUES ${placeholders}` +
        `${conflict}${this.buildReturningClause(input.returning)}`,
      params: input.rowValues.flat(),
    };
  },

  buildUpsertStatement(input: UpsertStatementInput): string {
    return (
      `INSERT INTO ${input.table} (${input.insertColumns.join(', ')}) VALUES (${input.valuePlaceholders.join(', ')})` +
      ` ON CONFLICT (${input.conflictColumns.join(', ')}) DO UPDATE SET ${input.updateSetClauses.join(', ')}` +
      this.buildReturningClause(input.returning)
    );
  },

  buildInsensitiveLike(column: string, paramRef: string): string {
    // COLLATE NOCASE is ASCII-only (no Unicode case folding) — documented limit.
    return `${column} LIKE ${paramRef} COLLATE NOCASE`;
  },

  buildJsonContains(column: string, paramRef: string): string {
    // Emulated containment: true when any top-level JSON value equals the param.
    // Limited vs Postgres `@>` (no deep/object containment) — jsonPathSupport='function'.
    return `EXISTS (SELECT 1 FROM json_each(${column}) WHERE json_each.value = ${paramRef})`;
  },

  buildJsonPathExtract(column: string, pathParamRef: string): string {
    return `json_extract(${column}, ${pathParamRef})`;
  },

  // ---- Type mapping -------------------------------------------------------

  typeToTypeScript(dialectType: string, nullable: boolean): string {
    return sqliteTypeToTs(dialectType, nullable);
  },

  // SQLite has no true array columns; bulk insert uses multi-row VALUES, so no
  // array cast is ever needed. Returning undefined disables the UNNEST path.
  arrayType: undefined,

  // ---- DDL ----------------------------------------------------------------

  buildColumnType(input: ColumnTypeInput): string {
    return sqliteColumnAffinity(input.type);
  },

  buildColumnDefinition(input: ColumnDefinitionInput): string {
    const isSerial = /serial/i.test(input.type);
    const parts: string[] = [input.name];
    if (input.primaryKey && isSerial) {
      // The canonical SQLite auto-increment PK (implicitly NOT NULL).
      parts.push('INTEGER PRIMARY KEY AUTOINCREMENT');
    } else {
      parts.push(this.buildColumnType(input));
      if (input.primaryKey) parts.push('PRIMARY KEY');
      if (input.unique && !input.primaryKey) parts.push('UNIQUE');
      if (input.notNull) parts.push('NOT NULL');
    }
    if (input.defaultValue != null) parts.push(`DEFAULT ${input.defaultValue}`);
    if (input.references) parts.push(`REFERENCES ${input.references.table}(${input.references.column})`);
    return parts.join(' ');
  },

  buildCreateIndexStatement(input: CreateIndexStatementInput): string {
    return `CREATE INDEX IF NOT EXISTS ${input.name} ON ${input.table}(${input.columns.join(', ')});`;
  },

  buildCreateTableStatement(input: CreateTableStatementInput): string {
    const body = input.definitions.map((d) => `    ${d}`).join(',\n');
    return `CREATE TABLE ${input.table} (\n${body}\n);`;
  },

  // ---- Migration tracking -------------------------------------------------
  // buildMigrationSelectApplied / UpdateChecksum / InsertApplied / DeleteApplied
  // are inherited from postgresDialect: they call `this.paramPlaceholder(n)`
  // (→ `?`) and `ON CONFLICT (name) DO NOTHING`, both valid SQLite. Only the
  // tracking-table DDL (SERIAL / TIMESTAMPTZ) needs a SQLite-specific override.

  buildMigrationTrackingTable(table: string): string {
    return `
  CREATE TABLE IF NOT EXISTS ${table} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;
  },

  // ---- Streaming ----------------------------------------------------------

  /**
   * SQLite is in-process: the whole result set already lives in memory, so the
   * "stream" simply fetches once via the pooled connection and yields the rows
   * in `batchSize` chunks. No server-side cursor (and none needed).
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
      return introspectSqlite(options);
    },
  } satisfies DialectIntrospector,
};

// ---------------------------------------------------------------------------
// Introspection — PRAGMA-driven SchemaMetadata
// ---------------------------------------------------------------------------

interface PragmaColumn {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}
interface PragmaForeignKey {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
}
interface PragmaIndex {
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
}
interface PragmaIndexColumn {
  seqno: number;
  cid: number;
  name: string;
}

function pragma<T>(db: DatabaseSync, sql: string): T[] {
  // PRAGMA / SELECT against sqlite_master — read-only, identifiers are SQLite
  // catalog names (never user input here), values normalized for safe ints.
  return db.prepare(sql).all().map(normalizeRow) as T[];
}

/**
 * Read a live SQLite database (an open `DatabaseSync` handle) into the same
 * {@link SchemaMetadata} shape the Postgres catalog introspector produces.
 * Exposed directly so callers (and tests) can introspect an in-process
 * `:memory:` database without round-tripping through a file path.
 */
export function introspectSqliteDatabase(db: DatabaseSync, options: { include?: string[]; exclude?: string[] } = {}) {
  // ----- Tables (skip SQLite internal + the migration tracking table) -----
  const candidateTables = pragma<{ name: string }>(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).map((r) => r.name);
  // include / exclude + default bookkeeping-table exclusions (F12), shared with
  // every other introspector via applyTableFilters.
  const tableNames = applyTableFilters(candidateTables, options);
  const tableSet = new Set(tableNames);

  const columnsByTable = new Map<string, ColumnMetadata[]>();
  const pkByTable = new Map<string, string[]>();
  const uniqueByTable = new Map<string, string[][]>();
  const indexesByTable = new Map<string, IndexMetadata[]>();

  interface FKEntry {
    sourceTable: string;
    sourceColumns: string[];
    targetTable: string;
    targetColumns: string[];
    constraintName: string;
  }
  const foreignKeys: FKEntry[] = [];

  for (const tableName of tableNames) {
    const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

    // ----- Columns + primary key -----
    const cols = pragma<PragmaColumn>(db, `PRAGMA table_info(${q(tableName)})`);
    const colMeta: ColumnMetadata[] = [];
    const pkCols: { name: string; order: number }[] = [];
    for (const c of cols) {
      const declared = c.type || '';
      colMeta.push({
        name: c.name,
        field: snakeToCamel(c.name),
        dialectType: declared,
        pgType: declared,
        tsType: sqliteTypeToTs(declared, c.notnull === 0 && c.pk === 0),
        nullable: c.notnull === 0 && c.pk === 0,
        hasDefault: c.dflt_value !== null || c.pk === 1,
        isArray: false,
        arrayType: undefined,
        pgArrayType: 'text[]',
      });
      if (c.pk > 0) pkCols.push({ name: c.name, order: c.pk });
    }
    columnsByTable.set(tableName, colMeta);
    pkByTable.set(
      tableName,
      pkCols.sort((a, b) => a.order - b.order).map((p) => p.name),
    );

    // ----- Foreign keys -----
    const fks = pragma<PragmaForeignKey>(db, `PRAGMA foreign_key_list(${q(tableName)})`);
    // Group by FK id (composite FKs share an id), ordered by seq.
    const fkById = new Map<number, FKEntry>();
    for (const fk of fks.sort((a, b) => a.id - b.id || a.seq - b.seq)) {
      let entry = fkById.get(fk.id);
      if (!entry) {
        entry = {
          sourceTable: tableName,
          sourceColumns: [],
          targetTable: fk.table,
          targetColumns: [],
          constraintName: `fk_${tableName}_${fk.id}`,
        };
        fkById.set(fk.id, entry);
      }
      entry.sourceColumns.push(fk.from);
      // `to` is null when the FK references the target's PK implicitly.
      if (fk.to) entry.targetColumns.push(fk.to);
    }
    for (const entry of fkById.values()) {
      if (entry.targetColumns.length === 0) {
        // Implicit reference → the target table's primary key.
        const targetPk = pragma<PragmaColumn>(db, `PRAGMA table_info(${q(entry.targetTable)})`)
          .filter((c) => c.pk > 0)
          .sort((a, b) => a.pk - b.pk)
          .map((c) => c.name);
        entry.targetColumns = targetPk.length > 0 ? targetPk : ['id'];
      }
      if (tableSet.has(entry.targetTable)) foreignKeys.push(entry);
    }

    // ----- Indexes + unique constraints -----
    const idxList = pragma<PragmaIndex>(db, `PRAGMA index_list(${q(tableName)})`);
    const idxMeta: IndexMetadata[] = [];
    const uniques: string[][] = [];
    for (const idx of idxList) {
      const idxCols = pragma<PragmaIndexColumn>(db, `PRAGMA index_info(${q(idx.name)})`)
        .sort((a, b) => a.seqno - b.seqno)
        .map((c) => c.name);
      idxMeta.push({
        name: idx.name,
        columns: idxCols,
        unique: idx.unique === 1,
        definition: `${idx.unique === 1 ? 'UNIQUE ' : ''}INDEX ${idx.name} ON ${tableName}(${idxCols.join(', ')})`,
      });
      if (idx.unique === 1 && idxCols.length > 0) uniques.push(idxCols);
    }
    indexesByTable.set(tableName, idxMeta);
    uniqueByTable.set(tableName, uniques);
  }

  // ----- Build relations from foreign keys (belongsTo + hasMany + m2m) -----
  // Delegated to the SHARED introspection pipeline (introspect.ts) so SQLite
  // derives IDENTICAL relation names to the Postgres introspector for the
  // same logical schema — legacy-first naming, per-column disambiguation,
  // collision resolution against scalar column fields, and the conservative
  // pure-junction manyToMany auto-detection included.
  const relationsByTable = deriveEngineRelations(tableNames, foreignKeys, pkByTable, columnsByTable);

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
      if (isSqliteDateType(col.dialectType ?? col.pgType)) dateColumns.add(col.name);
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

  return { tables, enums: {} } satisfies SchemaMetadata;
}

/**
 * Open the SQLite database named by `options.connectionString` (a file path or
 * `':memory:'`), introspect it, and close it. Wraps
 * {@link introspectSqliteDatabase} for the {@link DialectIntrospector} seam used
 * by `introspect()` / `npx turbine generate`.
 *
 * Note: introspecting `':memory:'` opens a *fresh, empty* database (memory DBs
 * are per-handle), so codegen should target a real file.
 */
export async function introspectSqlite(options: IntrospectOptions): Promise<SchemaMetadata> {
  const DatabaseSync = loadDatabaseSync();
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(options.connectionString);
  } catch (err) {
    throw new ConnectionError(
      `[turbine] Failed to open SQLite database "${options.connectionString}": ${(err as Error).message}`,
    );
  }
  try {
    return introspectSqliteDatabase(db, { include: options.include, exclude: options.exclude });
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// turbineSqlite — the public factory
// ---------------------------------------------------------------------------

/** Options for {@link turbineSqlite}. Mirrors the relevant {@link TurbineConfig} fields. */
export interface TurbineSqliteOptions extends Pick<TurbineConfig, 'logging' | 'defaultLimit' | 'warnOnUnlimited'> {
  /**
   * Enable WAL journal mode for file databases (better read concurrency).
   * Ignored for `':memory:'`. Default: `true`.
   */
  wal?: boolean;
  /** `PRAGMA busy_timeout` in ms — how long a writer waits on `SQLITE_BUSY`. Default: 5000. */
  busyTimeoutMs?: number;
  /** Enable `PRAGMA foreign_keys` enforcement. Default: `true`. */
  foreignKeys?: boolean;
}

function openSqliteDatabase(target: string, options: TurbineSqliteOptions): DatabaseSync {
  const DatabaseSync = loadDatabaseSync();
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(target);
  } catch (err) {
    throw new ConnectionError(`[turbine] Failed to open SQLite database "${target}": ${(err as Error).message}`);
  }
  db.exec(`PRAGMA busy_timeout = ${Number(options.busyTimeoutMs ?? 5000)}`);
  if (options.foreignKeys !== false) db.exec('PRAGMA foreign_keys = ON');
  if (target !== ':memory:' && options.wal !== false) {
    try {
      db.exec('PRAGMA journal_mode = WAL');
    } catch {
      // Some filesystems (network mounts) reject WAL — fall back silently.
    }
  }
  return db;
}

/**
 * Create a {@link TurbineClient} bound to SQLite via `node:sqlite`.
 *
 * Pass a file path, `':memory:'`, or an already-open `DatabaseSync` handle (so
 * you can seed / introspect it first and reuse the same connection). The
 * returned client uses {@link sqliteDialect} and disables prepared-statement
 * names (SQLite caches plans internally).
 *
 * @param target  A SQLite file path, `':memory:'`, or an open `DatabaseSync`.
 * @param schema  Introspected or hand-written {@link SchemaMetadata}.
 * @param options Optional pragmas + logging / defaultLimit / warnOnUnlimited.
 *
 * @example
 * ```ts
 * import { turbineSqlite } from 'turbine-orm/sqlite';
 * const db = turbineSqlite(':memory:', SCHEMA);
 * ```
 */
export function turbineSqlite(
  target: string | DatabaseSync,
  schema: SchemaMetadata,
  options: TurbineSqliteOptions = {},
): TurbineClient {
  const db = typeof target === 'string' ? openSqliteDatabase(target, options) : target;
  const pool = new SqlitePool(db);
  return new TurbineClient(
    {
      pool,
      dialect: sqliteDialect,
      preparedStatements: false,
      logging: options.logging,
      defaultLimit: options.defaultLimit,
      warnOnUnlimited: options.warnOnUnlimited,
    },
    schema,
  );
}
