/**
 * turbine-orm/sqlite, zero-dependency SQLite engine
 *
 * Binds Turbine to SQLite via Node's built-in `node:sqlite` driver
 * (`DatabaseSync`), so SQLite is a **zero new dependency** engine: the root
 * package's runtime dependency stays exactly `pg`. This is the in-process
 * test / edge / "try it in 10 seconds" engine, `:memory:` databases run
 * entirely in-process with no service container.
 *
 * ## Driver
 *
 * - **Primary:** `node:sqlite` `DatabaseSync` (Node ≥ 22.5, experimental). Emits
 *   an `ExperimentalWarning`, harmless. No native build, no extra dependency.
 * - **Fallback:** `better-sqlite3` for Node < 22.5. Not bundled and not required;
 *   wrap a `better-sqlite3` handle in the same `PgCompatPool` shape if needed.
 *
 * ## Capabilities & limits (vs PostgreSQL)
 *
 * - `RETURNING` + `ON CONFLICT … DO UPDATE` (SQLite ≥ 3.35) → create / upsert /
 *   update / delete return real rows in a single statement (`resultStrategy =
 *   'returning'`, same as Postgres).
 * - **Single-writer:** one connection / one transaction at a time. On one
 *   client, statements from other callers wait (FIFO, up to `busyTimeoutMs`)
 *   while a transaction is open instead of running inside it; another
 *   process's writer gets `SQLITE_BUSY`. Both surface as the retryable
 *   `SerializationFailureError`. `journal_mode = WAL` is enabled for file
 *   databases to allow concurrent readers across connections.
 * - **Unsupported (throw `UnsupportedFeatureError`):** pgvector distance ops,
 *   LISTEN/NOTIFY (`$listen` / `$notify`), RLS `sessionContext`. Advisory-lock
 *   migration locking is unavailable, SQLite is single-writer, so migrations
 *   serialize naturally.
 * - **Type affinity caveats:** SQLite has no native `BOOLEAN` (0/1 integers),
 *   `JSON` (text) or `DATE` (TEXT/INTEGER). Booleans bind as 1/0; `Date` values
 *   bind as ISO-8601 text; an integral JS number binds as INTEGER. A column the
 *   schema declares boolean or json/jsonb reads back as a boolean or a parsed
 *   value on every path; date/time columns are coerced back to `Date`.
 *   Integers wider than `Number.MAX_SAFE_INTEGER` come back as strings (the
 *   same safe-int policy Turbine uses for Postgres `int8`). `numeric` has no
 *   exact storage: it reads back as a JS number.
 * - **Case-insensitive matching** uses `COLLATE NOCASE`, which is **ASCII-only**
 *   (no Unicode case folding).
 *
 * ## Example, `:memory:` database, from a generated schema
 *
 * ```ts
 * import { turbineSqlite } from 'turbine-orm/sqlite';
 * import { SCHEMA } from './generated/turbine/metadata.js';
 *
 * const db = turbineSqlite(':memory:', SCHEMA);
 * const users = await db.users.findMany({ with: { posts: true }, limit: 10 });
 * await db.disconnect();
 * ```
 *
 * ## Example, SQLite with no Postgres anywhere
 *
 * The snippet above needs `turbine generate`, which reads a live **Postgres**
 * catalog, so it is the wrong starting point if SQLite is your only database.
 * Describe the schema in code instead: `schemaToSQL` emits the DDL and
 * `schemaDefToMetadata` derives the runtime metadata (relations included, from
 * the same `references:`), both pure functions with no database involved.
 *
 * ```ts
 * import { defineSchema, schemaDefToMetadata, schemaToSQL } from 'turbine-orm';
 * import { sqliteDialect, turbineSqlite } from 'turbine-orm/sqlite';
 *
 * const schema = defineSchema({
 *   users: { id: { type: 'serial', primaryKey: true }, email: { type: 'text', notNull: true } },
 *   posts: {
 *     id: { type: 'serial', primaryKey: true },
 *     userId: { type: 'integer', notNull: true, references: 'users.id' },
 *     title: { type: 'text', notNull: true },
 *   },
 * });
 *
 * const db = turbineSqlite(':memory:', schemaDefToMetadata(schema));
 * for (const stmt of schemaToSQL(schema, { dialect: sqliteDialect })) {
 *   await db.rawUnsafe(stmt);
 * }
 *
 * // `db.table(...)`, not `db.users`: the typed property accessors are emitted
 * // by `turbine generate`, and this path skips it.
 * const users = await db.table('users').findMany({ with: { posts: true }, orderBy: { id: 'asc' } });
 * await db.disconnect();
 * ```
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import {
  type DisconnectOptions,
  type DisconnectResult,
  type PgCompatPool,
  type PgCompatPoolClient,
  TurbineClient,
} from './client.js';
import {
  type BuiltStatement,
  type BulkInsertStatementInput,
  type BulkUpsertStatementInput,
  type ColumnDefinitionInput,
  type ColumnTypeInput,
  type CreateIndexStatementInput,
  type CreateTableStatementInput,
  type DefaultValuesInsertStatementInput,
  type Dialect,
  type DialectIntrospector,
  type InsertStatementInput,
  type IntrospectOptions,
  type JsonWireRule,
  type LimitOffsetInput,
  onConflictAction,
  postgresDialect,
  type ReturningSelection,
  type StreamableConnection,
  type UpsertStatementInput,
} from './dialect.js';
import type { EngineClientConfig } from './engine-config.js';
import { ConnectionError, SerializationFailureError, UnsupportedFeatureError, ValidationError } from './errors.js';
import {
  applyTableFilters,
  assertDistinctColumnFields,
  deriveEngineRelations,
  nullRecord,
  printableCatalogName,
} from './introspect.js';
import { withoutTrailingComment } from './query/sql-comment.js';
import { LRUCache } from './query/utils.js';
import {
  type ColumnMetadata,
  type IndexMetadata,
  isDateType,
  type RelationDef,
  type SchemaMetadata,
  snakeToCamel,
  type TableMetadata,
} from './schema.js';
import { rewritePositionalPlaceholders } from './sql-placeholders.js';

// ---------------------------------------------------------------------------
// Driver constructor, lazily loaded
// ---------------------------------------------------------------------------

/** The shape of `node:sqlite`'s `DatabaseSync` constructor. */
type DatabaseSyncCtor = new (path: string, options?: unknown) => DatabaseSync;

let cachedDatabaseSync: DatabaseSyncCtor | undefined;

/**
 * Lazily load `node:sqlite`'s `DatabaseSync` constructor.
 *
 * `node:sqlite` is a built-in only on Node >= 22.5, so importing it at module
 * top-level would make `import 'turbine-orm/sqlite'`, and any module that
 * merely re-exports `sqliteDialect` (e.g. the dialect test suite), throw
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
      "turbine-orm/sqlite requires Node's built-in 'node:sqlite' module (Node >= 22.5). " +
        `Upgrade Node to >= 22.5, or pass an already-open better-sqlite3-compatible handle. (${(err as Error).message})`,
    );
  }
  if (typeof ctor !== 'function') {
    throw new ConnectionError(
      "'node:sqlite' loaded but did not export a DatabaseSync constructor, this Node build may lack SQLite support.",
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
 * we normalize: booleans → 1/0, a safe integer → INTEGER (see below),
 * `undefined`/`null` → NULL, `Date` → ISO text,
 * `Uint8Array`/`Buffer` → BLOB, and any remaining object/array → JSON text
 * (matches how Turbine already pre-serializes JSON filter params).
 */
function toSqliteParam(value: unknown): SqliteParam {
  if (value === undefined || value === null) return null;
  switch (typeof value) {
    case 'boolean':
      return value ? 1 : 0;
    case 'number':
      // `node:sqlite` binds every JS number as REAL, so `views / 2` divided as
      // floats (75 / 2 = 37.5, stored in an INTEGER column) and an integral
      // number written to a TEXT column was stored as '3.0'. Binding a safe
      // integer as an INTEGER gives the arithmetic and text PostgreSQL gives.
      // -0 stays REAL: as an integer it would lose its sign.
      return Number.isSafeInteger(value) && !Object.is(value, -0) ? BigInt(value) : value;
    case 'bigint':
    case 'string':
      return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return value; // also covers Buffer
  return JSON.stringify(value);
}

/**
 * The JSON text an `in` / `notIn` list binds as, element by element in the
 * form {@link toSqliteParam} would bind it, so a list element compares exactly
 * as the same value given to `equals` does. A bigint is written as a JSON
 * integer (exact to 64 bits; `JSON.stringify` refuses one), an infinity as the
 * overflowing literal SQLite's JSON parser reads as one, and a binary value as
 * `{"b": "<hex>"}`, which {@link sqliteDialect.buildInClause} turns back into a
 * BLOB. Any other object binds as its JSON text, as it would on its own.
 */
function sqliteInListJson(values: readonly unknown[]): string {
  const parts = values.map((value): string => {
    if (value === undefined || value === null) return 'null';
    switch (typeof value) {
      case 'boolean':
        return value ? '1' : '0';
      case 'number':
        if (Number.isFinite(value)) return JSON.stringify(value);
        if (Number.isNaN(value)) return 'null';
        return value > 0 ? '9e999' : '-9e999';
      case 'bigint':
        return value.toString();
      case 'string':
        return JSON.stringify(value);
    }
    if (value instanceof Uint8Array) {
      let hex = '';
      for (const byte of value) hex += byte.toString(16).padStart(2, '0');
      return `{"b":"${hex}"}`;
    }
    const bound = toSqliteParam(value);
    return JSON.stringify(bound);
  });
  return `[${parts.join(',')}]`;
}

/**
 * Normalize a single column value read from SQLite. With `setReadBigInts(true)`
 * every integer column comes back as a `bigint`; apply the same safe-integer
 * policy Turbine uses for Postgres `int8`, number when it fits in a JS safe
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

/** A result column's decode beyond the safe-integer policy (see {@link resultColumnDecoders}). */
type ColumnDecode = 'boolean' | 'json';

/**
 * The decode a column of `type` needs on SQLite, or `undefined`. `type` is a
 * declared SQLite type or a schema type (`bool`, `jsonb`). The ONE answer both
 * read paths use: the driver shim for direct reads and {@link sqliteDialect}'s
 * `jsonWireRule` for `with` rows, so the two cannot disagree about a column.
 */
function sqliteValueDecode(type: string): ColumnDecode | undefined {
  const t = type.toUpperCase();
  if (t.includes('BOOL')) return 'boolean';
  if (t === 'JSON' || t === 'JSONB') return 'json';
  return undefined;
}

/**
 * `table NUL column -> decode` for every schema column whose stored form is not
 * its declared JS type: a boolean (stored 1/0) or a json/jsonb column (stored as
 * JSON text). `null` when the schema has none.
 */
type DeclaredDecoders = ReadonlyMap<string, ColumnDecode> | null;

function declaredDecoders(schema: SchemaMetadata | undefined): DeclaredDecoders {
  if (!schema) return null;
  let out: Map<string, ColumnDecode> | null = null;
  for (const [table, meta] of Object.entries(schema.tables)) {
    for (const column of meta.columns) {
      const type = column.pgType ?? meta.pgTypes?.[column.name];
      const decode = typeof type === 'string' ? sqliteValueDecode(type) : undefined;
      if (decode === undefined) continue;
      if (out === null) out = new Map();
      out.set(`${table}\u0000${column.name}`, decode);
    }
  }
  return out;
}

/**
 * A decimal integer or float as SQLite prints it (`printf('%!.17g')` / `CAST(... AS TEXT)`).
 *
 * Linear by construction: the fraction's digits can only follow a literal `.`,
 * so a run of digits has exactly one way to match. The earlier `\d+\.?\d*`
 * could split a dot-less run between its two quantifiers in every possible
 * place, which made a long non-numeric cell take seconds to reject (quadratic:
 * 40,000 digits and an `x` took 0.8 s, a million take 1.5 ms now).
 */
const SQLITE_NUMBER_TEXT = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

/**
 * The text SQLite's INTEGER, REAL and NUMERIC affinities convert to a number,
 * measured against SQLite 3.51: an optional sign, a decimal integer or float,
 * an optional exponent, and ASCII whitespace around it. Anything else
 * (`'abc'`, `''`, `'Infinity'`, `'0x10'`, `'1_000'`) is stored as TEXT in the
 * numeric column. Linear for the same reason as {@link SQLITE_NUMBER_TEXT}.
 */
const SQLITE_NUMERIC_LITERAL = /^[ \t\n\v\f\r]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?[ \t\n\v\f\r]*$/i;

/**
 * Declared column types whose SQLite affinity is numeric (INTEGER, REAL or
 * NUMERIC), boolean included (stored 1/0). Matched whole, not by SQLite's own
 * "contains INT" rule: the type a schema records for a column can be an enum's
 * name (`point_kind`), which that rule reads as INTEGER while the column is
 * TEXT. A type this misses is written as SQLite always wrote it, so a miss
 * costs a refusal, never a wrong one.
 */
const SQLITE_NUMERIC_COLUMN_TYPE =
  /^(?:(?:tiny|small|medium|big)?int(?:eger)?|int[248]|(?:small|big)?serial|unsigned big int|real|float[48]?|double(?: precision)?|numeric|decimal|money|bool(?:ean)?)(?:\(\s*\d+\s*(?:,\s*\d+\s*)?\))?$/i;

/**
 * Decode a REAL / NUMERIC cell carried as text through a `with` join back to
 * the value a direct read returns: an integer by the safe-integer policy, a
 * double as the number its 17 digits name, `Inf` / `-Inf` as infinities.
 */
function decodeRealText(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (/^-?\d+$/.test(value)) {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value;
  }
  if (value === 'Inf') return Number.POSITIVE_INFINITY;
  if (value === '-Inf') return Number.NEGATIVE_INFINITY;
  return SQLITE_NUMBER_TEXT.test(value) ? Number(value) : value;
}

/** Read a JSON column's stored text as its value; text that is not JSON is returned as stored. */
function parseJsonCell(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Convert a `node:sqlite` null-prototype row into a normalized plain object.
 *
 * `decoders`, when present, names the result columns whose ORIGIN column is a
 * boolean or a JSON column (see {@link resultColumnDecoders}): 1/0 becomes
 * `true`/`false`, JSON text becomes its value. Anything else in such a column,
 * and every column not listed, passes through untouched.
 */
function normalizeRow(
  row: Record<string, null | number | bigint | string | Uint8Array>,
  decoders?: ReadonlyMap<string, ColumnDecode>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    const value = normalizeValue(row[key] as null | number | bigint | string | Uint8Array);
    const decode = decoders?.get(key);
    out[key] =
      decode === undefined
        ? value
        : decode === 'json'
          ? parseJsonCell(value)
          : value === 1 || value === 0
            ? value === 1
            : value;
  }
  return out;
}

/**
 * The result columns of a prepared statement that need decoding, or `null`
 * when there are none (the overwhelmingly common case).
 *
 * WHY THIS EXISTS. SQLite has no boolean or JSON storage class: a boolean is
 * stored as 1/0 and a JSON document as text. Turbine still generates
 * `ok: boolean` and a JSON value for those columns, and PostgreSQL returns
 * exactly that, so a value the ORM itself wrote as `true` or `{ a: 1 }` came
 * back as `1` or `'{"a":1}'`.
 *
 * Two sources name such a column, both read from the driver's per-column
 * description, because only the driver knows which TABLE a result column came
 * from. `StatementSync.columns()` reports the declared type
 * (`sqlite3_column_decltype`) and the origin table and column, all of which are
 * null for an expression, so a computed column is never decoded by accident.
 *  - A declared type naming a boolean (`BOOLEAN`), as before.
 *  - The client's schema: an origin column declared boolean or json/jsonb there.
 *    Turbine's own DDL stores those as INTEGER and TEXT, so the declared type
 *    alone missed every table Turbine created.
 *
 * Node gained `columns()` in 22.16 / 23.11 while this engine's floor is 22.5, so
 * it is feature-detected: on the narrow band without it, these columns keep
 * reading back as stored rather than the engine refusing to run.
 */
function resultColumnDecoders(
  stmt: ReturnType<DatabaseSync['prepare']>,
  declared: DeclaredDecoders,
): Map<string, ColumnDecode> | null {
  const columnsFn = (
    stmt as { columns?: () => { name?: unknown; type?: unknown; table?: unknown; column?: unknown }[] }
  ).columns;
  if (typeof columnsFn !== 'function') return null;
  let described: { name?: unknown; type?: unknown; table?: unknown; column?: unknown }[];
  try {
    described = columnsFn.call(stmt);
  } catch {
    // A statement the driver cannot describe (some PRAGMA forms) is not worth
    // failing a query over; skip the decoding for it.
    return null;
  }
  let out: Map<string, ColumnDecode> | null = null;
  for (const c of described) {
    if (typeof c.name !== 'string') continue;
    let decode: ColumnDecode | undefined;
    if (typeof c.type === 'string' && sqliteValueDecode(c.type) === 'boolean') decode = 'boolean';
    else if (declared !== null && typeof c.table === 'string' && typeof c.column === 'string') {
      decode = declared.get(`${c.table}\u0000${c.column}`);
    }
    if (decode === undefined) continue;
    if (out === null) out = new Map();
    out.set(c.name, decode);
  }
  return out;
}

/**
 * The `node:sqlite` namespace, looked up once, or `null` when this Node build
 * has no such builtin. Deliberately separate from {@link loadDatabaseSync},
 * which THROWS: this is a capability question asked from the pure dialect,
 * which must stay importable on Node 20.
 */
let cachedSqliteNamespace: { StatementSync?: { prototype?: { columns?: unknown } } } | null | undefined;

/**
 * Can the driver report a result column's DECLARED type?
 *
 * This is the same capability {@link resultColumnDecoders} feature-detects, and
 * the two have to be asked the SAME question or they split: that helper is what
 * turns 1/0 into `true`/`false` on every direct read, and the boolean
 * `jsonWireRule` is what does it on the join path. On the Node band with
 * `node:sqlite` but without `StatementSync.columns()` (>= 22.5, < 22.16 / 23.11)
 * the helper returns `null` and every direct read keeps 1/0, so a join that
 * still converted would produce exactly the strategy-dependent type flip the
 * rule exists to prevent, on the one runtime where nothing else can catch it.
 *
 * The prototype property is re-read on each call rather than memoized as a
 * boolean, so the answer cannot outlive the capability.
 */
function driverReportsDeclaredTypes(): boolean {
  if (cachedSqliteNamespace === undefined) {
    try {
      cachedSqliteNamespace = createRequire(process.cwd())('node:sqlite') as typeof cachedSqliteNamespace;
    } catch {
      cachedSqliteNamespace = null;
    }
  }
  return typeof cachedSqliteNamespace?.StatementSync?.prototype?.columns === 'function';
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
  // A `sqlComment` (query/sql-comment.ts) sits after the statement and its
  // values are data, so the RETURNING test reads the statement without it: a
  // value such as `orders-returning` must not turn a write into a row read
  // and its change count into 0.
  const code = withoutTrailingComment(sql);
  return ROW_RETURNING_HEAD.test(code) || /\breturning\b/i.test(code);
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
 * transaction proxy), so annotation is the preferred half of the job: every
 * failure whose meaning Postgres already has a SQLSTATE for is expressed as
 * that SQLSTATE and typed by the one classifier.
 *
 * ONE family cannot be handled that way, and it was the family a new user hits
 * first. `SQLITE_ERROR` (primary code 1, "SQL logic error") covers
 * `no such table: users`, `no such column: emial`, and a plain syntax error;
 * Postgres reports the same three as 42P01 / 42703 / 42601, and `wrapPgError`
 * classifies none of them, on either engine. So on SQLite they reached the
 * caller as a bare `Error` with `code: 'ERR_SQLITE_ERROR'`: no `TURBINE_E0NN`,
 * no `.docsUrl`, not a `TurbineError` at all, in a library whose typed-error
 * table is a headline feature. {@link sqliteLogicError} builds the
 * `ValidationError` for them here, the way `wrapPowdbError` builds its errors
 * for a driver with no SQLSTATEs to annotate.
 *
 * Everything else stays annotation, so the two engines cannot drift: fixing a
 * constraint classification in `wrapPgError` fixes it for SQLite in the same
 * commit.
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
      // SQLITE_BUSY (5) / SQLITE_LOCKED (6) and their extended codes
      // (SQLITE_BUSY_SNAPSHOT 517, SQLITE_LOCKED_SHAREDCACHE 262, ...). Built as
      // the typed retryable error HERE rather than annotated, because the raw
      // paths (`db.transaction(client => ...)`, `db.pool.query`) never pass
      // through `wrapPgError` and would otherwise hand back the driver error.
      if (primary === 5 || primary === 6) return sqliteBusyError(e.errcode, message, err);
      // SQLITE_ERROR (1): the statement itself is wrong. See the note above.
      if (primary === 1) return sqliteLogicError(message, err);
      return err;
  }
}

/**
 * A `SQLITE_BUSY` / `SQLITE_LOCKED` failure as the retryable typed error, so
 * `withRetry` / `$retry` and `err.isRetryable` handle it on every path.
 * `busy_timeout` does not apply to a deferred transaction that read first and
 * then tried to write (SQLITE_BUSY_SNAPSHOT): only retrying the WHOLE
 * transaction can succeed, which is what the hint says.
 */
function sqliteBusyError(errcode: number, message: string, cause: unknown): SerializationFailureError {
  const kind = (errcode & 0xff) === 5 ? 'SQLITE_BUSY' : 'SQLITE_LOCKED';
  return new SerializationFailureError({
    message:
      `SQLite database is busy (${kind}, code ${errcode}): ${message}. Another connection holds the lock it needs. ` +
      'Retry the whole transaction (withRetry does), or raise busyTimeoutMs.',
    cause,
  });
}

/**
 * The `ValidationError` for a `SQLITE_ERROR`, with a hint for the two spellings
 * that account for nearly all of them.
 *
 * The driver's own text IS the diagnosis (`no such table: users` names the
 * table), so it is kept verbatim rather than replaced.
 *
 * The original error IS attached as `cause`, and safe mode is not a reason not
 * to: `TurbineError` runs every cause it is given through `redactCauseForMode`,
 * so attaching one goes THROUGH the redaction rather than around it. It also
 * discloses nothing new here, because the driver's message is already quoted
 * verbatim into the message above it. What it buys is the stack: without it a
 * `no such table` surfaces with Turbine's frames and none of the driver's.
 */
function sqliteLogicError(message: string, cause?: unknown): ValidationError {
  const missingTable = /^no such table:\s*(\S+)/i.exec(message);
  if (missingTable) {
    return new ValidationError(
      `SQLite has no table "${printableCatalogName(missingTable[1]!)}": ${printableCatalogName(message)}. ` +
        'Create it first (run your migrations, or execute the CREATE TABLE statements for this schema); ' +
        'an in-memory database starts empty on every connection.',
      { cause },
    );
  }
  const missingColumn = /^no such column:\s*(\S+)/i.exec(message);
  if (missingColumn) {
    return new ValidationError(
      `SQLite has no column "${printableCatalogName(missingColumn[1]!)}": ${printableCatalogName(message)}. ` +
        'Check the spelling against the table as it exists in this database, ' +
        'and re-run `turbine generate` if the schema has changed.',
      { cause },
    );
  }
  return new ValidationError(`SQLite rejected the statement: ${printableCatalogName(message)}`, { cause });
}

// ---------------------------------------------------------------------------
// Driver shim, wrap a node:sqlite DatabaseSync as a PgCompatPool
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
 * independent of where each placeholder lands in the SQL text, the same
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

/** The refusal for a placeholder the shim cannot bind (see rewritePositionalPlaceholders). */
function refusePlaceholder(message: string): never {
  throw new ValidationError(message);
}

function runStatement(
  db: DatabaseSync,
  text: string,
  values: unknown[],
  decoderCache?: LRUCache<string, Map<string, ColumnDecode> | null>,
  declared: DeclaredDecoders = null,
) {
  const binding = toNamedBinding(values);
  // `$n` is the spelling `rawUnsafe` documents for every engine; SQLite would
  // read `$1` as a parameter NAMED "1", which the `{ p1, ... }` binding lacks.
  const sql = rewritePositionalPlaceholders(text, 'sqlite', values.length, (i) => `:p${i}`, refusePlaceholder);
  let stmt: ReturnType<DatabaseSync['prepare']>;
  try {
    stmt = db.prepare(sql);
  } catch (err) {
    throw augmentSqliteError(err);
  }
  stmt.setReadBigInts(true);
  try {
    if (statementReturnsRows(sql)) {
      // Describe each distinct statement ONCE. `null` (nothing to decode) is a
      // cached answer too, so the ordinary query pays a single Map hit per call
      // and nothing per row.
      let decoders = decoderCache?.get(sql);
      if (decoders === undefined) {
        decoders = resultColumnDecoders(stmt, declared);
        decoderCache?.set(sql, decoders);
      }
      const rows = (binding ? stmt.all(binding) : stmt.all()).map((r) =>
        normalizeRow(r as Record<string, null | number | bigint | string | Uint8Array>, decoders ?? undefined),
      );
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

/** Default wait, in ms, for a transaction another caller holds open on the handle. */
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/**
 * Marker planted around a `$transaction` callback (see `wrapTransactionCallback`
 * below), so a statement issued through the CLIENT from inside that callback is
 * recognized instead of queueing behind the transaction it is part of.
 */
interface SqliteTxMarker {
  readonly pool: SqlitePool;
  readonly owner: object;
  /** The marker that was in scope when this one was planted (another pool's transaction, say). */
  readonly parent: SqliteTxMarker | undefined;
}

const sqliteTxStorage = new AsyncLocalStorage<SqliteTxMarker>();

/** A caller waiting for the handle; `owner` is installed the moment it is granted. */
interface HandleWaiter {
  readonly owner: object;
  readonly grant: () => void;
  settled: boolean;
}

/** Statement heads that leave the handle inside a transaction when they succeed. */
const TX_OPEN_HEAD = /^\s*(?:begin|savepoint)\b/i;
/** Statement heads that end the transaction (not `ROLLBACK TO`, which keeps it open). */
const TX_CLOSE_HEAD = /^\s*(?:commit|end|rollback(?!\s+(?:transaction\s+)?to\b))\b/i;

/**
 * The one statement the pool can never run: something on the handle while the
 * transaction that owns it is waiting for that very statement.
 */
function statementInsideTransactionError(): UnsupportedFeatureError {
  return new UnsupportedFeatureError(
    'A statement on the client while its own transaction is open',
    'sqlite',
    'This call was made through the client, not the `tx` client, from inside an open $transaction callback. ' +
      'SQLite has one connection here, so the call would either join that transaction (and be rolled back with ' +
      'it) or wait for it forever. Use the `tx` client the callback receives, or make the call after the ' +
      'transaction completes.',
  );
}

/** The error a caller gets when an open transaction holds the handle past `busyTimeoutMs`. */
function handleBusyError(timeoutMs: number): SerializationFailureError {
  return new SerializationFailureError({
    message:
      `SQLite database is busy: a transaction on this client held it for longer than busyTimeoutMs (${timeoutMs} ms). ` +
      'Retry the operation (withRetry does), keep transactions short, or raise busyTimeoutMs.',
  });
}

/** Options for {@link SqlitePool}. */
export interface SqlitePoolOptions {
  /**
   * How long, in ms, a statement waits for a transaction another caller has
   * open on this handle before failing with a retryable
   * `SerializationFailureError`. Default: 5000, the same bound as
   * `PRAGMA busy_timeout`.
   */
  busyTimeoutMs?: number;
  /**
   * The client's schema. A column it declares boolean or json/jsonb is read
   * back as a boolean or a parsed value, whatever its SQLite declared type.
   * `turbineSqlite` passes the schema it was given.
   */
  schema?: SchemaMetadata;
}

/**
 * A `PgCompatPool` backed by a single `node:sqlite` `DatabaseSync` connection.
 * SQLite is single-connection by nature (a `:memory:` database is per-handle),
 * so `connect()` hands back a client over the **same** handle.
 *
 * One handle carries one transaction, so the pool decides who may use it. A
 * caller whose statement opens a transaction OWNS the handle until that
 * transaction ends; every other caller's statements, plain queries included,
 * wait their turn in FIFO order (bounded by `busyTimeoutMs`) instead of running
 * inside it. Without that, a write issued outside an open transaction joined
 * it, reported success, and was rolled back with it, and reads saw its
 * uncommitted rows. A checkout that does not open a transaction (a stream, a
 * connectivity check) holds nothing, so other callers keep running beside it.
 */
export class SqlitePool implements PgCompatPool {
  /** The underlying `node:sqlite` handle, exposed as an escape hatch (seed/DDL). */
  readonly db: DatabaseSync;
  private closed = false;
  /**
   * `sql -> result columns to decode` (or `null` for none). Bounded like
   * the query builder's SQL-template cache, since a caller can generate
   * unbounded distinct statements (raw SQL, an IN-list that inlines).
   */
  private readonly decoderCache = new LRUCache<string, Map<string, ColumnDecode> | null>(1000);
  /** Schema columns whose stored form is not their declared JS type (see {@link declaredDecoders}). */
  private readonly declared: DeclaredDecoders;
  private readonly busyTimeoutMs: number;
  /** Who may run statements on the handle right now; `null` when nobody holds it. */
  private owner: object | null = null;
  private readonly waiters: HandleWaiter[] = [];
  /** The owner for statements sent through `pool.query()` rather than a checkout. */
  private readonly poolOwner = {};
  /** Transaction state when the driver cannot report it (`isTransaction` arrived in Node 22.16). */
  private trackedTransaction = false;

  constructor(db: DatabaseSync, options: SqlitePoolOptions = {}) {
    this.db = db;
    const t = Number(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS);
    this.busyTimeoutMs = Number.isFinite(t) && t >= 0 ? t : DEFAULT_BUSY_TIMEOUT_MS;
    this.declared = declaredDecoders(options.schema);
  }

  // biome-ignore lint/suspicious/noExplicitAny: pg-compat query is generic over the row shape; runStatement returns plain objects.
  async query(text: QueryArg, values?: unknown[]): Promise<any> {
    const { text: sql, params } = normalizeQueryArgs(text, values);
    return this.runAs(this.poolOwner, sql, params);
  }

  async connect(): Promise<PgCompatPoolClient> {
    if (this.closed) throw new ConnectionError('This SQLite client has been disconnected.');
    const owner = {};
    let released = false;
    return {
      // biome-ignore lint/suspicious/noExplicitAny: see query() above.
      query: async (text: QueryArg, values?: unknown[]): Promise<any> => {
        if (released) {
          throw new ConnectionError(
            'This SQLite connection was released (its transaction ended or timed out); ' +
              'run the statement through the client or a new transaction.',
          );
        }
        const { text: sql, params } = normalizeQueryArgs(text, values);
        return this.runAs(owner, sql, params);
      },
      wrapTransactionCallback: <R>(fn: () => Promise<R>): Promise<R> =>
        sqliteTxStorage.run({ pool: this, owner, parent: sqliteTxStorage.getStore() }, fn),
      release: () => {
        if (released) return;
        released = true;
        this.releaseOwner(owner);
      },
    };
  }

  async end(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /** Is the handle inside a transaction right now? */
  private inTransaction(): boolean {
    const reported = (this.db as { isTransaction?: unknown }).isTransaction;
    return typeof reported === 'boolean' ? reported : this.trackedTransaction;
  }

  /** Run one statement for `owner`, waiting first if another caller's transaction holds the handle. */
  private async runAs(owner: object, sql: string, params: unknown[]) {
    if (this.closed) throw new ConnectionError('This SQLite client has been disconnected.');
    if (this.owner !== owner) {
      if (this.owner !== null || this.waiters.length > 0) {
        if (this.calledFromOwnersCallback()) throw statementInsideTransactionError();
        await this.waitForHandle(owner);
      } else {
        this.owner = owner;
      }
    }
    try {
      const result = runStatement(this.db, sql, params, this.decoderCache, this.declared);
      if (TX_OPEN_HEAD.test(sql)) this.trackedTransaction = true;
      else if (TX_CLOSE_HEAD.test(sql)) this.trackedTransaction = false;
      return result;
    } finally {
      // A statement that leaves no transaction open hands the handle on.
      if (this.owner === owner && !this.inTransaction()) this.handOff();
    }
  }

  /** True when the current async context is the callback of the transaction that owns the handle. */
  private calledFromOwnersCallback(): boolean {
    for (let m = sqliteTxStorage.getStore(); m; m = m.parent) {
      if (m.pool === this && m.owner === this.owner) return true;
    }
    return false;
  }

  private waitForHandle(owner: object): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter: HandleWaiter = {
        owner,
        settled: false,
        grant: () => {
          if (timer) clearTimeout(timer);
          resolve();
        },
      };
      this.waiters.push(waiter);
      timer = setTimeout(() => {
        if (waiter.settled) return;
        waiter.settled = true;
        const at = this.waiters.indexOf(waiter);
        if (at >= 0) this.waiters.splice(at, 1);
        reject(handleBusyError(this.busyTimeoutMs));
      }, this.busyTimeoutMs);
    });
  }

  /** Give the handle to the next waiter, which runs its statement as soon as it resumes. */
  private handOff(): void {
    this.owner = null;
    while (this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      if (next.settled) continue;
      next.settled = true;
      this.owner = next.owner;
      next.grant();
      return;
    }
  }

  /**
   * A checkout ended. If it still holds an open transaction (a timed-out or
   * abandoned callback), roll it back first, so the next caller does not
   * start inside it.
   */
  private releaseOwner(owner: object): void {
    if (this.owner !== owner) return;
    if (this.inTransaction() && !this.closed) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Nothing left to roll back.
      }
      this.trackedTransaction = false;
    }
    this.handOff();
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
// sqliteDialect, the full Dialect contract for SQLite
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
  supportsJsonContains: false,
  // FTS5 is a virtual-table feature with its own MATCH syntax, not the
  // `to_tsvector @@ to_tsquery` shape Turbine's `search` filter emits.
  supportsFullTextSearch: false,
  // No array column type (a JSON column is not an array column).
  supportsArrayColumns: false,
  supportsListenNotify: false,
  supportsRLS: false,
  supportsAdvisoryLock: false,
  // No FROM-clause LATERAL: the opt-in lateral pick plan is Postgres-only.
  supportsLateralJoin: false,
  supportsPlanCacheMode: false,
  // No row locks: a write transaction locks the whole database.
  rowLockModes: [],
  // percentile_cont / percentile_disc exist only in builds compiled with
  // SQLITE_ENABLE_PERCENTILE, which node:sqlite cannot be assumed to have.
  supportsPercentileAggregates: false,
  // INSERT ... ON CONFLICT (cols) DO UPDATE ... RETURNING (3.24 + 3.35).
  supportsBulkUpsert: true,
  // SQLite explains a compiled query with `EXPLAIN QUERY PLAN` (four columns:
  // id, parent, notused, detail), overriding the inherited Postgres `EXPLAIN`.
  explainQuery: { prefix: 'EXPLAIN QUERY PLAN' },
  // json_group_array / json_object have no inline ORDER BY argument, so every
  // ordered to-many relation is forced through the inner-subquery rewrite.
  aggSupportsInlineOrderBy: false,
  jsonPathSupport: 'function',
  emptyJsonArrayLiteral: "json('[]')",
  nullJsonLiteral: 'NULL',

  // Named placeholders (`:p1`, `:p2`, …), NOT positional `?`. Turbine pushes
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

  jsonWireRule(columnType: string): JsonWireRule | undefined {
    // SQLite's storage classes, as introspection records them.
    const t = columnType.toUpperCase();

    // INTEGER is 64-bit, and `json_object` renders it as a JSON number, which
    // is an IEEE double: 9007199254740993 came back through a `with` join as
    // …992 while a top-level read and the batched loader both returned the
    // exact decimal string. Carry the text and re-apply the SAME safe-integer
    // policy `normalizeValue` applies to the driver's bigint, so all three
    // paths agree for both small and large values.
    if (t.includes('INT')) {
      return {
        sql: (ref) => `CAST(${ref} AS TEXT)`,
        decode: (value) => {
          if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return value;
          const asNumber = Number(value);
          return Number.isSafeInteger(asNumber) ? asNumber : value;
        },
      };
    }

    // A declared-boolean column is 1/0 in storage, and the driver shim turns
    // that back into true/false on every direct read (see
    // resultColumnDecoders). `json_object` sees the raw integer and has no
    // decltype to consult, so the join strategy alone would have kept handing
    // back 1/0 while the top-level read, the batched loader and the flatten
    // plan returned booleans, which is the same strategy-dependent type flip
    // the bigint rule above exists to prevent. No cast is needed, only the
    // decode: the JSON number IS the stored value, it just has to be read the
    // same way.
    //
    // Gated on the SAME capability the direct-read half feature-detects (see
    // driverReportsDeclaredTypes). Without it the shim cannot name a boolean
    // result column, so 1/0 is the answer everywhere; converting here alone
    // would put the flip back, pointing the other way.
    const decode = sqliteValueDecode(columnType);
    if (decode === 'boolean' && driverReportsDeclaredTypes()) {
      return {
        // Carried as TEXT because that is how the decode half is reached at
        // all: the parser only runs `decode` on a string cell, so a rule that
        // left the JSON number alone would never fire. The CASE narrows the
        // carrier to EXACTLY the two values that mean true/false, so anything
        // else a declared-boolean column happens to hold (SQLite does not
        // enforce the type) stays in its own JSON form and reads back as the
        // driver would have returned it, rather than being stringified.
        sql: (ref) => `CASE WHEN ${ref} IN (0, 1) THEN CAST(${ref} AS TEXT) ELSE ${ref} END`,
        decode: (value) => (value === '1' ? true : value === '0' ? false : value),
      };
    }

    // A json/jsonb column is JSON text in storage, which the shim parses on
    // every direct read (see resultColumnDecoders). `json_object` embeds the
    // same text as a JSON string, so the decode is the same parse. No cast: the
    // column reference already yields the text. Gated like the boolean rule,
    // since the direct-read half needs the same driver capability.
    if (decode === 'json' && driverReportsDeclaredTypes()) {
      return { sql: (ref) => ref, decode: parseJsonCell };
    }

    // `json_object` renders a REAL with 15 significant digits on the SQLite
    // that Node 22 and 24 bundle (3.47 to 3.51; 3.53 renders 17), so 0.1 + 0.2
    // came back 0.3 through a join and a NUMERIC past 15 digits was rounded
    // again on top of its REAL storage, while the top-level read and the
    // batched loader return the stored double. `printf('%!.17g')` prints every
    // double with enough digits to rebuild it, on every version; an INTEGER in
    // the same column is carried as its text and decoded by the safe-integer
    // policy above; text and NULL pass through as stored.
    if (/REAL|FLOA|DOUB|NUMERIC|DECIMAL|MONEY/.test(t)) {
      return {
        sql: (ref) =>
          `CASE typeof(${ref}) WHEN 'real' THEN printf('%!.17g', ${ref}) ` +
          `WHEN 'integer' THEN CAST(${ref} AS TEXT) ELSE ${ref} END`,
        decode: decodeRealText,
      };
    }

    // A BLOB cannot go into JSON at all: SQLite raises "JSON cannot hold BLOB
    // values" and the whole query fails with a raw SQL logic error, where the
    // batched loader returns the row fine. Carry hex and rebuild the bytes.
    if (t.includes('BLOB')) {
      return {
        sql: (ref) => `hex(${ref})`,
        decode: (value) => (typeof value === 'string' ? Uint8Array.from(Buffer.from(value, 'hex')) : value),
      };
    }

    return undefined;
  },

  castAggregate(expr: string, target: 'int' | 'float'): string {
    return `CAST(${expr} AS ${target === 'int' ? 'INTEGER' : 'REAL'})`;
  },

  // SQLite's grammar only allows OFFSET after LIMIT, so `offset` without
  // `limit` (valid on Postgres, which the default path is written for) is a
  // syntax error here. A negative LIMIT is SQLite's documented "no upper
  // bound", so that shape becomes `LIMIT -1 OFFSET n`. The other shapes emit
  // byte-identically to the default path.
  buildLimitOffset(input: LimitOffsetInput): string {
    const { limitPlaceholder, offsetPlaceholder } = input;
    if (limitPlaceholder === undefined && offsetPlaceholder === undefined) return '';
    if (limitPlaceholder === undefined) return ` LIMIT -1 OFFSET ${offsetPlaceholder}`;
    let s = ` LIMIT ${limitPlaceholder}`;
    if (offsetPlaceholder !== undefined) s += ` OFFSET ${offsetPlaceholder}`;
    return s;
  },

  // No `= ANY(array)` in SQLite. `json_each` expands a single JSON-array param
  // into a row set, keeping ONE placeholder (so the SQL cache stays valid
  // regardless of list length) and handling the empty-list case correctly.
  // `x IN (SELECT ...)` compares like `x = ?`: the column's affinity and
  // collation apply to each element, as they do to a bound operand. JSON has no
  // bytes, so a binary element travels as `{"b": "<hex>"}` and is decoded back
  // to a BLOB here (see sqliteInListJson).
  buildInClause(expr: string, paramRef: string, negated: boolean): string {
    return (
      `${expr} ${negated ? 'NOT IN' : 'IN'} ` +
      `(SELECT CASE WHEN type = 'object' THEN unhex(json_extract(value, '$.b')) ELSE value END ` +
      `FROM json_each(${paramRef}))`
    );
  },

  inClauseParam(values: unknown[]): unknown {
    return sqliteInListJson(Array.isArray(values) ? values : []);
  },

  /**
   * A string written to a numeric or boolean column. SQLite's type affinity
   * keeps text it cannot convert as TEXT in that column, where PostgreSQL
   * refuses it at the server: `'abc'` in an INTEGER column, or `'true'` in a
   * boolean one (stored 1/0), which `{ flag: true }` then never matches. A
   * string that is a number (`'12.5'`, `'9007199254740993'`, `' 7 '`) is
   * accepted and converted by SQLite, as before.
   */
  checkTextWrite(table: string, column: string, columnType: string, value: string): string | undefined {
    if (!SQLITE_NUMERIC_COLUMN_TYPE.test(columnType.trim())) return undefined;
    if (SQLITE_NUMERIC_LITERAL.test(value)) return undefined;
    const boolean = /BOOL/i.test(columnType);
    return (
      `The string written to "${column}" on "${table}", a column of type ${columnType}, is not a number, so SQLite ` +
      `would store it as text in that column; PostgreSQL refuses it. ` +
      (boolean ? 'Write true or false.' : 'Write a number, or a string holding one, such as "12.5".')
    );
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
    // No UNNEST in SQLite, emit multi-row VALUES with flattened, named
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

  buildBulkUpsertStatement(input: BulkUpsertStatementInput): BuiltStatement {
    // VALUES, not `INSERT ... SELECT`: after a SELECT, SQLite cannot tell a
    // trailing `ON CONFLICT` from the SELECT's own clauses. The rest is the
    // PostgreSQL grammar (3.24 upsert, 3.35 RETURNING), `excluded` included.
    let n = 0;
    const tuples = input.rowValues.map((row) => `(${row.map(() => this.paramPlaceholder(++n)).join(', ')})`).join(', ');
    const params = input.rowValues.flat();
    return {
      sql:
        `INSERT INTO ${input.table} (${input.columns.join(', ')}) VALUES ${tuples} ` +
        `ON CONFLICT (${input.conflictColumns.join(', ')}) ` +
        onConflictAction(input, params, { target: input.table, incoming: 'excluded' }) +
        this.buildReturningClause(input.returning),
      params,
    };
  },

  buildDefaultValuesInsertStatement(input: DefaultValuesInsertStatementInput): string {
    // SQLite's `DEFAULT VALUES` inserts exactly one row and the engine accepts
    // neither `VALUES (DEFAULT, …)` nor MySQL's empty `VALUES ()` tuple, so
    // there is no multi-row all-defaults statement to emit.
    if (input.rowCount !== 1) {
      throw new UnsupportedFeatureError(
        `createMany with ${input.rowCount} empty data rows`,
        'sqlite',
        'SQLite INSERT … DEFAULT VALUES inserts a single row and has no multi-row form; ' +
          'issue one create({ data: {} }) per row.',
      );
    }
    const conflict = input.skipDuplicates ? ' ON CONFLICT DO NOTHING' : '';
    return `INSERT INTO ${input.table} DEFAULT VALUES${conflict}${this.buildReturningClause(input.returning)}`;
  },

  buildUpsertStatement(input: UpsertStatementInput): string {
    return (
      `INSERT INTO ${input.table} (${input.insertColumns.join(', ')}) VALUES (${input.valuePlaceholders.join(', ')})` +
      ` ON CONFLICT (${input.conflictColumns.join(', ')}) DO UPDATE SET ${input.updateSetClauses.join(', ')}` +
      // SQLite's upsert takes the same trailing conflict-UPDATE predicate as
      // Postgres, so `supportsUpsertUpdateWhere` (inherited true) is honest and
      // global filters restrict the UPDATE branch here too.
      (input.updateWhere ? ` WHERE ${input.updateWhere}` : '') +
      this.buildReturningClause(input.returning)
    );
  },

  // A SQLite transaction is always SERIALIZABLE, which satisfies every level
  // `$transaction({ isolationLevel })` can ask for, and the inherited
  // `BEGIN ISOLATION LEVEL ...` is a syntax error here.
  beginStatement(): string {
    return 'BEGIN';
  },

  buildInsensitiveLike(column: string, paramRef: string): string {
    // COLLATE NOCASE is ASCII-only (no Unicode case folding), documented limit.
    return `${column} LIKE ${paramRef} COLLATE NOCASE`;
  },

  // UNREACHABLE while `supportsJsonContains` is false, and kept deliberately:
  // it is the emulation this dialect would use if the encoding mismatch were
  // repaired, and deleting it would delete the record of what was tried. The
  // param is bound as JSON text (`'"gold"'`) while `json_each.value` yields the
  // decoded SQL value (`gold`), so this predicate never holds for ANY operand.
  // See `supportsJsonContains` in dialect.ts for the measurements and the shape
  // a faithful version needs (`json_each.type` alongside the value).
  buildJsonContains(column: string, paramRef: string): string {
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

  /** SQLite has no enum type: a TEXT column, and a CHECK that admits only the labels (compared exactly, BINARY collation). */
  buildEnumColumn(column: string, labels: readonly string[]): { type: string; check: string } {
    const literals = labels.map((label) => `'${label.replace(/'/g, "''")}'`);
    return { type: 'TEXT', check: `${column} IN (${literals.join(', ')})` };
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
// Introspection, PRAGMA-driven SchemaMetadata
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
  // PRAGMA / SELECT against sqlite_master, read-only, identifiers are SQLite
  // catalog names (never user input here), values normalized for safe ints.
  // No boolean-key set: PRAGMA output columns are catalog metadata (`notnull`,
  // `pk`, `unique`), which are 0/1 integers the introspector reads AS integers.
  return db
    .prepare(sql)
    .all()
    .map((r) => normalizeRow(r as Record<string, null | number | bigint | string | Uint8Array>)) as T[];
}

/**
 * Read a live SQLite database (an open `DatabaseSync` handle) into the same
 * {@link SchemaMetadata} shape the Postgres catalog introspector produces.
 * Exposed directly so callers (and tests) can introspect an in-process
 * `:memory:` database without round-tripping through a file path.
 */
export function introspectSqliteDatabase(
  db: DatabaseSync,
  options: Pick<IntrospectOptions, 'include' | 'exclude' | 'logger'> = {},
) {
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
  // same logical schema, legacy-first naming, per-column disambiguation,
  // collision resolution against scalar column fields, and the conservative
  // pure-junction manyToMany auto-detection included.
  // One field per column, as the PostgreSQL introspector requires.
  for (const [tableName, cols] of columnsByTable) assertDistinctColumnFields(tableName, cols);
  const relationsByTable = deriveEngineRelations(tableNames, foreignKeys, pkByTable, columnsByTable, options.logger);

  // ----- Assemble TableMetadata -----
  const tables: Record<string, TableMetadata> = nullRecord<TableMetadata>();
  for (const tableName of tableNames) {
    const columns = columnsByTable.get(tableName) ?? [];
    const columnMap: Record<string, string> = nullRecord<string>();
    const reverseColumnMap: Record<string, string> = nullRecord<string>();
    const dateColumns = new Set<string>();
    const dialectTypes: Record<string, string> = nullRecord<string>();
    const pgTypes: Record<string, string> = nullRecord<string>();
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
      relations: relationsByTable.get(tableName) ?? nullRecord<RelationDef>(),
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
      `Failed to open SQLite database "${options.connectionString}": ${(err as Error).message}`,
    );
  }
  try {
    return introspectSqliteDatabase(db, { include: options.include, exclude: options.exclude, logger: options.logger });
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// turbineSqlite, the public factory
// ---------------------------------------------------------------------------

/**
 * Options for {@link turbineSqlite}: every client-level {@link TurbineConfig}
 * field the engine can honour (see {@link EngineClientConfig}) plus the SQLite
 * pragmas below.
 */
export interface TurbineSqliteOptions extends EngineClientConfig {
  /**
   * Enable WAL journal mode for file databases (better read concurrency).
   * Ignored for `':memory:'`. Default: `true`.
   */
  wal?: boolean;
  /**
   * How long, in ms, a statement waits for the database: `PRAGMA busy_timeout`
   * for another process's lock, and the wait behind a transaction another
   * caller has open on this client. Default: 5000.
   */
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
    throw new ConnectionError(`Failed to open SQLite database "${target}": ${(err as Error).message}`);
  }
  try {
    db.exec(`PRAGMA busy_timeout = ${Number(options.busyTimeoutMs ?? 5000)}`);
    if (options.foreignKeys !== false) db.exec('PRAGMA foreign_keys = ON');
  } catch (err) {
    // Opened here and about to be unreachable: close it rather than leave the
    // file handle to the garbage collector.
    db.close();
    throw err;
  }
  if (target !== ':memory:' && options.wal !== false) {
    try {
      db.exec('PRAGMA journal_mode = WAL');
    } catch {
      // Some filesystems (network mounts) reject WAL, fall back silently.
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
 * @param options Optional SQLite pragmas plus any client-level
 *                {@link TurbineConfig} field (see {@link EngineClientConfig}).
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
  const owns = typeof target === 'string';
  const db = owns ? openSqliteDatabase(target, options) : target;
  let pool: SqlitePool;
  let client: TurbineClient;
  try {
    pool = new SqlitePool(db, { busyTimeoutMs: options.busyTimeoutMs, schema });
    // Everything that is not a SQLite pragma is client config and rides through
    // untouched, so a new TurbineConfig option works here the day it lands. The
    // engine-owned keys come last, so no caller can unbind the dialect.
    const { wal: _wal, busyTimeoutMs: _busyTimeoutMs, foreignKeys: _foreignKeys, ...clientConfig } = options;
    client = new TurbineClient(
      {
        ...clientConfig,
        pool,
        dialect: sqliteDialect,
        preparedStatements: false,
      },
      schema,
    );
  } catch (err) {
    // A failed factory hands the caller nothing to close, so a handle it
    // OPENED is closed here (the client constructor refuses a bad config, a
    // static global filter naming no table or column for one). A handle the
    // caller passed in is the caller's and stays open.
    if (owns) db.close();
    throw err;
  }

  if (owns) {
    // Turbine opened this handle, so disconnect()/end() must close it, as the
    // other engine factories close a pool they built: the client sees
    // `TurbineConfig.pool` as external and would otherwise leave it open, still
    // answering queries after disconnect(). A handle the caller passed in stays
    // the caller's (disconnect() is a no-op for it).
    const baseDisconnect = client.disconnect.bind(client);
    const close = async (options?: DisconnectOptions): Promise<DisconnectResult | undefined> => {
      const result = options === undefined ? await baseDisconnect() : await baseDisconnect(options);
      await pool.end();
      return result ?? undefined;
    };
    const patch = client as unknown as { disconnect: typeof close; end: typeof close };
    patch.disconnect = close;
    patch.end = close;
  }
  return client;
}
