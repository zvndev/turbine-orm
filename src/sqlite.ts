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
import { sqliteToOneForeignKey } from './catalog-metadata.js';
import {
  type DisconnectOptions,
  type DisconnectResult,
  type PgCompatPool,
  type PgCompatPoolClient,
  TurbineClient,
} from './client.js';
import {
  createPortableSqliteDialect,
  parseJsonCell,
  sqliteTypeToTs,
  sqliteValueDecode,
  toSqliteParam,
} from './d1/sqlite-dialect.js';
import type { Dialect, DialectIntrospector, IntrospectOptions } from './dialect.js';
import type { EngineClientConfig } from './engine-config.js';
import { ConnectionError, SerializationFailureError, UnsupportedFeatureError, ValidationError } from './errors.js';
import {
  applyTableFilters,
  assertDistinctColumnFields,
  type IntrospectOptions as CatalogIntrospectOptions,
  deriveEngineRelations,
  nullRecord,
  printableCatalogName,
} from './introspect.js';
import { withoutTrailingComment } from './query/sql-comment.js';
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

export { sqliteTypeToTs } from './d1/sqlite-dialect.js';

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
  // Compatible native bindings can return Buffer for BLOBs. Keep the builtin's
  // Uint8Array contract without exposing a driver-specific prototype.
  if (value instanceof Uint8Array && Buffer.isBuffer(value)) return Uint8Array.from(value);
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
/**
 * `table NUL column -> decode` for every schema column whose stored form is not
 * its declared JS type: a boolean (stored 1/0) or a json/jsonb column (stored as
 * JSON text). `null` when the schema has none.
 */
type DeclaredDecoders = {
  byOrigin: ReadonlyMap<string, ColumnDecode>;
  knownTablesForJsonViews: ReadonlySet<string> | null;
} | null;

type ResultColumnDescription = {
  name?: unknown;
  type?: unknown;
  table?: unknown;
  column?: unknown;
  database?: unknown;
};

/** Only the most recent result shape; every execution must validate it again. */
interface DecoderMemo {
  columns?: ResultColumnDescription[];
  decoders: Map<string, ColumnDecode> | null;
}

function declaredDecoders(schema: SchemaMetadata | undefined): DeclaredDecoders {
  if (!schema) return null;
  let out: Map<string, ColumnDecode> | null = null;
  let hasJsonView = false;
  for (const [table, meta] of Object.entries(schema.tables)) {
    for (const column of meta.columns) {
      const type = column.pgType ?? meta.pgTypes?.[column.name];
      const decode = typeof type === 'string' ? sqliteValueDecode(type) : undefined;
      if (decode === undefined) continue;
      if (out === null) out = new Map();
      out.set(`${table}\u0000${column.name}`, decode);
      if (decode === 'json' && meta.isView === true) hasJsonView = true;
    }
  }
  return out === null
    ? null
    : { byOrigin: out, knownTablesForJsonViews: hasJsonView ? new Set(Object.keys(schema.tables)) : null };
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
    if (key === '__proto__') Object.defineProperty(out, key, { writable: true, enumerable: true, configurable: true });
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
 * Pin a native iterator's projection after its first step (which can reprepare
 * after DDL). Resolve keys/decoders once, rather than enumerate and Map.get for
 * every cell. Array-capable drivers also avoid allocating a keyed native row.
 * The first row stays in object mode so missing/failed descriptions can always
 * fall back to the driver's actual keys without guessing a projection.
 */
function streamRowNormalizer(
  stmt: ReturnType<DatabaseSync['prepare']>,
  first: Record<string, unknown>,
  decoders: ReadonlyMap<string, ColumnDecode> | null,
  switchArrays = true,
): (row: Record<string, unknown>) => Record<string, unknown> {
  let keys = Object.keys(first);
  let arrays = false;
  if (switchArrays && typeof stmt.setReturnArrays === 'function' && typeof stmt.columns === 'function') {
    let described: ResultColumnDescription[] | undefined;
    try {
      described = stmt.columns();
    } catch {
      // Compatible drivers can omit descriptions. Object rows remain sound.
    }
    // Duplicate output names collapse in object mode. Keep that path rather
    // than infer which positional cell the compatible driver retained.
    if (
      described?.length === keys.length &&
      described.every((c) => typeof c.name === 'string' && Object.hasOwn(first, c.name)) &&
      new Set(described.map((c) => c.name)).size === keys.length
    ) {
      keys = described.map((c) => c.name as string);
      stmt.setReturnArrays(true);
      arrays = true;
    }
  }
  return resultRowNormalizer(keys, decoders, arrays ? keys.map((_, i) => i) : undefined);
}

/** A projection pinned to one fully stepped result or one active iterator. */
function resultRowNormalizer(
  keys: string[],
  decoders: ReadonlyMap<string, ColumnDecode> | null,
  indices?: number[],
): (raw: Record<string, unknown>) => Record<string, unknown> {
  const decode = keys.map((key) => decoders?.get(key));
  return (r) => {
    const row: Record<string, unknown> = {};
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      const value = normalizeValue((indices ? (r as unknown as SqliteParam[])[indices[i]!] : r[key]) as SqliteParam);
      const columnDecode = decode[i];
      if (key === '__proto__')
        Object.defineProperty(row, key, { writable: true, enumerable: true, configurable: true });
      row[key] =
        columnDecode === undefined
          ? value
          : columnDecode === 'json'
            ? parseJsonCell(value)
            : value === 1 || value === 0
              ? value === 1
              : value;
    }
    return row;
  };
}

/** Native all() rows share a projection; this plan lives only for this result. */
function normalizeResultRows(
  raw: ReturnType<ReturnType<DatabaseSync['prepare']>['all']>,
  decoders: ReadonlyMap<string, ColumnDecode> | null,
  columns?: ResultColumnDescription[],
  projectionOrder?: boolean,
): Record<string, unknown>[] {
  // Repeated names retain the last cell in the first name's insertion order.
  const positions = columns ? new Map(columns.map((c, i) => [c.name as string, i])) : undefined;
  // Builtin arrays retain projection order; compatible object producers visit
  // integer keys first. Preserve each producer's raw assignment/setter order.
  const keys = projectionOrder
    ? [...positions!.keys()]
    : Object.keys(positions ? Object.fromEntries(positions) : raw[0]!);
  return raw.map(resultRowNormalizer(keys, decoders, positions ? keys.map((key) => positions.get(key)!) : undefined));
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
 *  - A selected JSON view can expose native main-database JSON origins whose
 *    base tables were filtered out. Known schema origins keep their declared
 *    meaning; no-schema/table-only pools and expressions retain their behavior.
 *
 * Node gained `columns()` in 22.16 / 23.11 while this engine's floor is 22.5, so
 * it is feature-detected: on the narrow band without it, these columns keep
 * reading back as stored rather than the engine refusing to run.
 */
function resultColumnDecoders(
  stmt: ReturnType<DatabaseSync['prepare']>,
  declared: DeclaredDecoders,
  memo: DecoderMemo,
  columns?: ResultColumnDescription[],
): Map<string, ColumnDecode> | null {
  let described = columns;
  if (described === undefined) {
    const columnsFn = (stmt as { columns?: () => ResultColumnDescription[] }).columns;
    if (typeof columnsFn !== 'function') return null;
    try {
      described = columnsFn.call(stmt);
    } catch {
      // A statement the driver cannot describe (some PRAGMA forms) is not worth
      // failing a query over; skip the decoding for it.
      return null;
    }
  }
  const previous = memo.columns;
  if (previous?.length === described.length) {
    let same = true;
    for (let i = 0; i < described.length; i++) {
      const a = previous[i]!;
      const b = described[i]!;
      if (
        a.name !== b.name ||
        a.type !== b.type ||
        a.table !== b.table ||
        a.column !== b.column ||
        a.database !== b.database
      ) {
        same = false;
        break;
      }
    }
    if (same) return memo.decoders;
  }
  let out: Map<string, ColumnDecode> | null = null;
  for (const c of described) {
    if (typeof c.name !== 'string') continue;
    let decode: ColumnDecode | undefined;
    const nativeDecode = typeof c.type === 'string' ? sqliteValueDecode(c.type) : undefined;
    if (nativeDecode === 'boolean') decode = 'boolean';
    else if (declared !== null && typeof c.table === 'string' && typeof c.column === 'string') {
      decode = declared.byOrigin.get(`${c.table}\u0000${c.column}`);
      if (
        decode === undefined &&
        nativeDecode === 'json' &&
        declared.knownTablesForJsonViews !== null &&
        c.database === 'main' &&
        !declared.knownTablesForJsonViews.has(c.table)
      )
        decode = 'json';
    }
    // Object rows retain the last cell for a repeated output name. Its type
    // must also replace an earlier boolean/JSON origin, including expressions.
    if (decode === undefined) {
      out?.delete(c.name);
      continue;
    }
    if (out === null) out = new Map();
    out.set(c.name, decode);
  }
  // Snapshot the fields: a compatible driver can reuse/mutate its own array.
  // SQL text and schema-version equality never stand in for fresh metadata.
  memo.columns = described.map(({ name, type, table, column, database }) => ({ name, type, table, column, database }));
  memo.decoders = out;
  return out;
}

type BuiltinStatement = import('node:sqlite').StatementSync;

/**
 * The builtin methods a wildcard read goes through, or `null` when every read
 * uses the statement's own all(). `undefined` until the first wildcard read.
 */
let wildcardRead: { all: BuiltinStatement['all']; iterate: BuiltinStatement['iterate'] } | null | undefined;

/**
 * Some builtin all() implementations (Node 22.16 and 24.10, for example) fix
 * the result width before the first step. When SQLite reprepares a star there,
 * because DDL ran since prepare or another connection changed the schema, a
 * grown table loses its new cells and a repeated name keeps an earlier cell.
 * Ask this runtime once: all() is trusted only if it returns the reprepared
 * projection. Without iterate() (Node before 22.13) there is no complete
 * route, so all() stays, as documented. A replaced prototype all() keeps its
 * own contract.
 */
function probeWildcardRead(): typeof wildcardRead {
  let sqlite: typeof import('node:sqlite');
  try {
    sqlite = createRequire(process.cwd())('node:sqlite') as typeof import('node:sqlite');
  } catch {
    return null;
  }
  const { all, iterate } = sqlite.StatementSync.prototype;
  if (typeof iterate !== 'function' || !Function.prototype.toString.call(all).includes('[native code]')) return null;
  let probe: DatabaseSync | undefined;
  try {
    probe = new sqlite.DatabaseSync(':memory:');
    probe.exec('CREATE TABLE t(a); INSERT INTO t VALUES(1)');
    const stmt = probe.prepare('SELECT *, 2 AS b FROM t');
    probe.exec('ALTER TABLE t ADD COLUMN b DEFAULT 3');
    // The executed projection is a, b, b: one row, the last b wins.
    const [row, ...rest] = Reflect.apply(all, stmt, []) as Record<string, unknown>[];
    if (row && rest.length === 0 && Object.keys(row).length === 2 && row.a === 1 && row.b === 2) return null;
  } catch {
    // An all() that cannot answer the probe is not trusted with a wildcard.
  } finally {
    probe?.close();
  }
  return { all, iterate };
}

let wildcardReuse: boolean | undefined;

/**
 * Whether a statement containing `*` may be kept for reuse: trial the reader a
 * wildcard read will use on a statement executed once and then reprepared by
 * DDL that grows and then shrinks its table. Asked once per process.
 */
function wildcardReuseSafe(): boolean {
  if (wildcardReuse !== undefined) return wildcardReuse;
  let sqlite: typeof import('node:sqlite');
  try {
    sqlite = createRequire(process.cwd())('node:sqlite') as typeof import('node:sqlite');
  } catch {
    wildcardReuse = false;
    return wildcardReuse;
  }
  if (typeof sqlite.StatementSync.prototype.iterate !== 'function') {
    wildcardReuse = false;
    return wildcardReuse;
  }
  if (wildcardRead === undefined) wildcardRead = probeWildcardRead();
  const reader = wildcardRead ? wildcardRead.iterate : sqlite.StatementSync.prototype.all;
  let probe: DatabaseSync | undefined;
  try {
    probe = new sqlite.DatabaseSync(':memory:');
    probe.exec('CREATE TABLE t(a); INSERT INTO t VALUES(1)');
    const stmt = probe.prepare('SELECT * FROM t');
    [...(Reflect.apply(reader, stmt, []) as Iterable<unknown>)];
    probe.exec('ALTER TABLE t ADD COLUMN b DEFAULT 3');
    const grown = [...(Reflect.apply(reader, stmt, []) as Iterable<Record<string, unknown>>)];
    probe.exec('ALTER TABLE t DROP COLUMN b');
    const shrunk = [...(Reflect.apply(reader, stmt, []) as Iterable<Record<string, unknown>>)];
    wildcardReuse =
      grown.length === 1 &&
      Object.keys(grown[0]!).length === 2 &&
      grown[0]!.b === 3 &&
      shrunk.length === 1 &&
      Object.keys(shrunk[0]!).length === 1 &&
      shrunk[0]!.a === 1;
  } catch {
    wildcardReuse = false;
  } finally {
    probe?.close();
  }
  return wildcardReuse;
}

/**
 * Read a stepped result. On a runtime whose probe trusts all(), this is all()
 * after one null test. Elsewhere builtin statements containing `*` are read by
 * native iteration, which reads the width after each step. Wrapped/compatible
 * all() methods keep control of their own row contract.
 */
function readResultRows(
  stmt: ReturnType<DatabaseSync['prepare']>,
  sql: string,
  binding: Record<string, SqliteParam> | undefined,
  positionalParams?: SqliteParam[],
): ReturnType<ReturnType<DatabaseSync['prepare']>['all']> {
  if (wildcardRead !== null && sql.includes('*')) {
    wildcardRead ??= probeWildcardRead();
    if (wildcardRead && stmt.all === wildcardRead.all) {
      const iterator = Reflect.apply(
        wildcardRead.iterate,
        stmt,
        positionalParams ?? (binding ? [binding] : []),
      ) as ReturnType<BuiltinStatement['iterate']>;
      try {
        return [...iterator];
      } finally {
        iterator.return?.();
      }
    }
  }
  return positionalParams ? stmt.all(...positionalParams) : binding ? stmt.all(binding) : stmt.all();
}

/**
 * Which array readers return the executed projection on this runtime, or
 * `null` when neither can be trusted (or there is no builtin). `undefined`
 * until the first wildcard array candidate.
 *
 * Both readers are trialled, because which one runs is not this probe's
 * choice: {@link readResultRows} iterates a wildcard when the OBJECT probe
 * distrusts all(), whatever the array all() trial said. Measured, not
 * assumed: Node 26.12 passes both trials and its object probe trusts all();
 * Node 24.10 fails both all() trials (the width is fixed at prepare in BOTH
 * row modes) and passes iteration, which is the route its object probe
 * selects anyway. A runtime whose array all() passed while its object all()
 * failed would iterate arrays, so {@link wildcardArraysEligible} requires
 * the trial for the reader that will actually run, never the other one.
 */
let wildcardArrayRead: { all: boolean; iterate: boolean } | null | undefined;

function probeWildcardArrayRead(): typeof wildcardArrayRead {
  let sqlite: typeof import('node:sqlite');
  try {
    sqlite = createRequire(process.cwd())('node:sqlite') as typeof import('node:sqlite');
  } catch {
    return null;
  }
  const { all, iterate, setReturnArrays } = sqlite.StatementSync.prototype;
  if (
    typeof setReturnArrays !== 'function' ||
    !Function.prototype.toString.call(setReturnArrays).includes('[native code]')
  )
    return null;
  // One trial per reader: prepare, grow the table, then read as arrays. The
  // executed projection is a, b with the new column's default in b.
  const trial = (read: (stmt: BuiltinStatement) => unknown[]): boolean => {
    let probe: DatabaseSync | undefined;
    try {
      probe = new sqlite.DatabaseSync(':memory:');
      probe.exec('CREATE TABLE t(a); INSERT INTO t VALUES(1)');
      const stmt = probe.prepare('SELECT * FROM t') as BuiltinStatement;
      probe.exec('ALTER TABLE t ADD COLUMN b DEFAULT 3');
      Reflect.apply(setReturnArrays, stmt, [true]);
      const [row, ...rest] = read(stmt) as unknown[][];
      return rest.length === 0 && Array.isArray(row) && row.length === 2 && row[0] === 1 && row[1] === 3;
    } catch {
      return false;
    } finally {
      probe?.close();
    }
  };
  const allOk = trial((stmt) => Reflect.apply(all, stmt, []) as unknown[]);
  const iterateOk =
    typeof iterate === 'function' && trial((stmt) => [...(Reflect.apply(iterate, stmt, []) as Iterable<unknown>)]);
  return allOk || iterateOk ? { all: allOk, iterate: iterateOk } : null;
}

/**
 * May a wildcard statement read array rows on this runtime? The probe answer
 * is per-process, like {@link wildcardRead}. The object probe decides the
 * reader ({@link readResultRows} iterates exactly when it distrusts all()),
 * so eligibility is the ARRAY trial for that same reader: iteration when
 * {@link wildcardRead} holds the builtin methods, all() when it is `null`.
 */
function wildcardArraysEligible(sql: string): boolean {
  if (wildcardArrayRead === undefined) wildcardArrayRead = probeWildcardArrayRead();
  if (!wildcardArrayRead) return false;
  if (wildcardRead === undefined && sql.includes('*')) wildcardRead = probeWildcardRead();
  return wildcardRead ? wildcardArrayRead.iterate : wildcardArrayRead.all;
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
function toNamedBinding(values: unknown[], qualified = false): Record<string, SqliteParam> | undefined {
  if (values.length === 0) return undefined;
  const named: Record<string, SqliteParam> = {};
  for (let i = 0; i < values.length; i++) {
    named[qualified ? `:p${i + 1}` : `p${i + 1}`] = toSqliteParam(values[i]);
  }
  return named;
}

/** The refusal for a placeholder the shim cannot bind (see rewritePositionalPlaceholders). */
function refusePlaceholder(message: string): never {
  throw new ValidationError(message);
}

/**
 * `sql` with each quoted run replaced by `x` and each comment by a space, in one
 * scan from the left. A `[` with no `]` after it stays as written. Past the last
 * `]` no `[` can close, so an unclosed one is known without scanning to the end
 * again from each `[`, which made a run of them quadratic.
 */
function maskQuotedRunsAndComments(sql: string): string {
  const token = /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|\[/g;
  const lastClose = sql.lastIndexOf(']');
  let masked = '';
  let end = 0;
  for (let match = token.exec(sql); match; match = token.exec(sql)) {
    if (match[0] === '[') {
      if (match.index > lastClose) continue;
      token.lastIndex = sql.indexOf(']', match.index) + 1;
    }
    masked += sql.slice(end, match.index) + (/^(?:--|\/\*)/.test(match[0]) ? ' ' : 'x');
    end = token.lastIndex;
  }
  return masked + sql.slice(end);
}

/** Let SQLite parse triggers/quoted SQL, then refuse any unconsumed statement before stepping. */
function prepareSingleStatement(db: DatabaseSync, sql: string): ReturnType<DatabaseSync['prepare']> {
  const refuse = () => {
    throw new ValidationError('SQLite query accepts one statement; execute additional statements separately.');
  };
  if (sql.includes('\0')) refuse();
  // Some PRAGMAs take effect during prepare. Screen their separators first;
  // quoted runs remain code markers, while SQLite comments disappear.
  if (sql.includes(';')) {
    const code = maskQuotedRunsAndComments(sql).replace(/^[;\s]+/, '');
    // Refuse code after a separator. Everything from the first `;` to the next
    // code character is a separator, so the first `;` decides it.
    const separator = code.indexOf(';');
    if (
      /^(?:EXPLAIN\s+(?:QUERY\s+PLAN\s+)?)?PRAGMA\b/i.test(code) &&
      separator >= 0 &&
      /[^;\s]/.test(code.slice(separator + 1))
    )
      refuse();
  }
  const stmt = db.prepare(sql);
  // Node 22.5 exposed this as a method; later runtimes use a getter.
  const source = stmt.sourceSQL as string | (() => string);
  const parsed = typeof source === 'function' ? source.call(stmt) : source;
  if (
    !sql.startsWith(parsed) ||
    sql.slice(parsed.length).replace(/--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|[;\t\n\r\f ]/g, '')
  ) {
    refuse();
  }
  return stmt;
}

// Only a factory-opened, never exposed handle has no caller-installed prepare
// callbacks (notably an authorizer whose policy can change between calls).
const unexposedNativeDatabases = new WeakSet<DatabaseSync>();

interface SqliteQueryPlan {
  valueCount: number;
  sql: string;
  returnsRows: boolean;
  bytes: number;
}

/** Pool-owned SQL-only admission memo. No statements, bindings or result metadata. */
interface SqliteQueryPlans {
  entries: Map<string, SqliteQueryPlan>;
  bytes: number;
}

function sqliteQueryPlan(text: string, valueCount: number, memo: SqliteQueryPlans): SqliteQueryPlan {
  // Avoid hashing oversized text on every execution, even when it cannot fit.
  const cacheable = text.length <= 32768;
  const previous = cacheable ? memo.entries.get(text) : undefined;
  // Parameter count is part of the identity: rewriting validates $n bounds,
  // and zero parameters deliberately bypass rewriting altogether.
  if (previous?.valueCount === valueCount) return previous;
  const sql = rewritePositionalPlaceholders(text, 'sqlite', valueCount, (i) => `:p${i}`, refusePlaceholder);
  // Conservative UTF-16 payload accounting, including both strings even when
  // rewriting returns the input. The cap is not a JavaScript/native heap bound.
  const bytes = (text.length + sql.length) * 2;
  const plan = { valueCount, sql, returnsRows: statementReturnsRows(sql), bytes };
  if (previous) {
    memo.entries.delete(text);
    memo.bytes -= previous.bytes;
  }
  // Keep the first shapes that fit. Churning SQL cannot evict hot entries or
  // impose per-miss eviction/accounting work once the memo is full.
  if (cacheable && memo.entries.size < 128 && memo.bytes + bytes <= 131072) {
    memo.entries.set(text, plan);
    memo.bytes += bytes;
  }
  return plan;
}

type NativeResultMethods = Pick<ReturnType<DatabaseSync['prepare']>, 'all' | 'columns' | 'setReturnArrays'>;
let nativeResultMethods: NativeResultMethods | null | undefined;
const bindingArrayStatements = new WeakMap<DatabaseSync, WeakMap<object, NativeResultMethods>>();

/** Array results require builtin descriptions; compatible/wrapped methods keep object rows. */
function nativeArrayResults(
  db: DatabaseSync,
  stmt: ReturnType<DatabaseSync['prepare']>,
): NativeResultMethods | undefined {
  const binding = bindingArrayStatements.get(db)?.get(stmt);
  if (binding) {
    return stmt.all === binding.all &&
      stmt.columns === binding.columns &&
      stmt.setReturnArrays === binding.setReturnArrays
      ? binding
      : undefined;
  }
  if (nativeResultMethods === undefined) {
    try {
      const { StatementSync } = createRequire(process.cwd())('node:sqlite') as typeof import('node:sqlite');
      const p = StatementSync.prototype;
      const methods = { all: p.all, columns: p.columns, setReturnArrays: p.setReturnArrays };
      nativeResultMethods = Object.values(methods).every(
        (fn) => typeof fn === 'function' && Function.prototype.toString.call(fn).includes('[native code]'),
      )
        ? methods
        : null;
    } catch {
      nativeResultMethods = null;
    }
  }
  if (
    nativeResultMethods &&
    stmt.all === nativeResultMethods.all &&
    stmt.columns === nativeResultMethods.columns &&
    stmt.setReturnArrays === nativeResultMethods.setReturnArrays
  )
    return nativeResultMethods;
  return undefined;
}

/**
 * Generated bulk INSERTs can bind fully qualified names with bare-name lookup
 * disabled. Key by the exact params array, SQL and arity; copies/edited SQL
 * keep ordinary binding. No values or native statements are retained.
 *
 * On a genuine native handle the same generated statement can go further and
 * bind POSITIONALLY: SQLite's parser registers each distinct named parameter
 * by searching the ones already seen, so preparing `:p1 … :p6000` is
 * quadratic (a 1,000-row insert prepares in ~35 ms named against ~0.9 ms with
 * `?` placeholders, on either driver), and the object binding repeats a name
 * lookup per value. The positional text is derived here, below every observer:
 * statement events, `buildCreateMany` output and wrapped handles keep seeing
 * the generated `:pN` SQL and its named binding exactly as before.
 *
 * `qualifiedNames` records which named binding the recording dialect used
 * before positional binding existed: the node:sqlite dialect bound bulk
 * inserts with fully qualified `:pN` keys, the better-sqlite3 dialect did
 * not record at all and so bound plain `{ p1 }` keys. A handle that cannot
 * bind positionally must receive the same binding it always did, so the
 * style travels with the recorded statement, not with the handle.
 *
 * `positional` starts `undefined` (not yet derived) and is filled lazily by
 * {@link bulkPositionalBinding} on the first eligible execution, `null` when
 * the SQL may not be rewritten. Deriving eagerly at build time taxed every
 * handle for a spelling only eligible ones use, including the throwaway
 * sizing builds `createMany` makes per call.
 */
interface BulkInsertBinding {
  sql: string;
  count: number;
  qualifiedNames: boolean;
  positional?: string | null;
}
const bulkInsertBindings = new WeakMap<unknown[], BulkInsertBinding>();

/**
 * The `?` spelling of a generated bulk INSERT, or `undefined` unless the SQL
 * holds exactly `:p1 … :p<count>` in order and nothing else that looks like
 * one. The strict sequence check is what makes a textual rewrite sound: a
 * quoted identifier containing `:p7` would break the run or the count and the
 * statement keeps named binding.
 */
function positionalBulkSql(sql: string, count: number): string | undefined {
  if (count === 0) return undefined;
  let seen = 0;
  let inOrder = true;
  const out = sql.replace(/:p(\d+)/g, (_token, digits: string) => {
    seen += 1;
    if (Number(digits) !== seen) inOrder = false;
    return '?';
  });
  return inOrder && seen === count ? out : undefined;
}

/**
 * @internal Record a generated bulk INSERT for the binding shortcuts above. Called by
 * the SQLite dialects at statement-build time with the exact params array the
 * statement will execute with.
 */
export function recordSqliteBulkInsert(params: unknown[], sql: string, qualifiedNames = true): void {
  bulkInsertBindings.set(params, { sql, count: params.length, qualifiedNames });
}

let nativePrepareFn: DatabaseSync['prepare'] | null | undefined;

/**
 * May this handle receive the positional spelling? Only when nothing can
 * observe the difference: a genuine `node:sqlite` handle whose `prepare` is
 * still the native prototype method (a wrapped or proxied handle, or a
 * compatible driver object, keeps the generated SQL and named binding it has
 * always seen), or the better-sqlite3 adapter over a handle this package
 * opened itself (registered for array results in {@link bindingArrayStatements}).
 */
function bulkPositionalEligible(db: DatabaseSync): boolean {
  if (bindingArrayStatements.has(db)) return true;
  if (nativePrepareFn === undefined) {
    try {
      const { DatabaseSync } = createRequire(process.cwd())('node:sqlite') as typeof import('node:sqlite');
      const fn = DatabaseSync.prototype.prepare;
      nativePrepareFn =
        typeof fn === 'function' && Function.prototype.toString.call(fn).includes('[native code]') ? fn : null;
    } catch {
      nativePrepareFn = null;
    }
  }
  return nativePrepareFn !== null && db.prepare === nativePrepareFn;
}

/**
 * The positional spelling and spread values for a generated bulk insert on
 * an eligible handle, or `undefined` to keep named binding. Kept out of
 * {@link runStatement} so the path every statement takes stays as it was;
 * only a recorded bulk insert calls this. The derived text is memoized on
 * the WeakMap entry, so a statement executed more than once (a deferred
 * query run twice) derives once.
 */
function bulkPositionalBinding(
  db: DatabaseSync,
  bulk: BulkInsertBinding,
  values: unknown[],
): { sql: string; params: SqliteParam[] } | undefined {
  if (!bulkPositionalEligible(db)) return undefined;
  bulk.positional ??= positionalBulkSql(bulk.sql, bulk.count) ?? null;
  if (bulk.positional === null) return undefined;
  // Read each slot by index, never `map`: a sparse params array binds NULL in
  // its holes (toSqliteParam(undefined)) without shifting later values, the
  // same contract the named loop in toNamedBinding keeps.
  const params = new Array<SqliteParam>(values.length);
  for (let i = 0; i < values.length; i++) params[i] = toSqliteParam(values[i]);
  return { sql: bulk.positional, params };
}

/** Account the actual native bindings, never the caller's pre-conversion objects. */
function retainStatementBindings(binding: Record<string, SqliteParam> | undefined): boolean {
  let bytes = 0;
  for (const name in binding) {
    const value = binding[name];
    if (value instanceof Uint8Array) return false;
    bytes += typeof value === 'string' ? value.length * 2 : 8;
    if (bytes > 8192) return false;
  }
  return true;
}

function runStatement(
  db: DatabaseSync,
  text: string,
  values: unknown[],
  declared: DeclaredDecoders,
  memo: DecoderMemo,
  plans: SqliteQueryPlans,
  statements: WeakMap<SqliteQueryPlan, ReturnType<DatabaseSync['prepare']>> | undefined,
) {
  const generated = bulkInsertBindings.get(values);
  const bulk = generated?.sql === text && generated.count === values.length ? generated : undefined;
  const positional = bulk ? bulkPositionalBinding(db, bulk, values) : undefined;
  const binding = positional ? undefined : toNamedBinding(values, bulk?.qualifiedNames ?? false);
  // `$n` is the spelling `rawUnsafe` documents for every engine; SQLite would
  // read `$1` as a parameter NAMED "1", which the `{ p1, ... }` binding lacks.
  const plan = sqliteQueryPlan(text, values.length, plans);
  const { sql, returnsRows } = plan;
  // Only genuine native preparation is unobservable to a caller's wrapper.
  // Keep the admitted SQL's bounded slot, never a SQL-to-type cache: SQLite
  // can reprepare this statement on step, and metadata is still read after it.
  let reusable =
    statements !== undefined &&
    !bulk &&
    /^\s*(?:SELECT|INSERT|UPDATE|DELETE|REPLACE|BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql) &&
    bulkPositionalEligible(db) &&
    !bindingArrayStatements.has(db);
  let stmt: ReturnType<DatabaseSync['prepare']>;
  try {
    stmt = (reusable && statements!.get(plan)) || prepareSingleStatement(db, positional?.sql ?? sql);
    // A recursive call must never check out a statement that is being stepped.
    statements?.delete(plan);
  } catch (err) {
    throw augmentSqliteError(err);
  }
  // Some runtimes fix a wildcard's width before stepping, even in iterate()
  // (Node 22.13 to 22.15). A statement kept across DDL there would keep its old
  // columns, so a star is retained only where the reader it will use follows a
  // reprepare; elsewhere it is prepared fresh, as before.
  if (reusable && sql.includes('*') && !wildcardReuseSafe()) reusable = false;
  stmt.setReadBigInts(true);
  // node:sqlite builds a bare-name map on every execution when enabled. The
  // generated statement binds exact :pN names, so that extra lookup is unused.
  if (bulk?.qualifiedNames && !positional) stmt.setAllowBareNamedParameters?.(false);
  try {
    if (returnsRows) {
      // With no wildcard, SELECT's result width is fixed by its expressions.
      // A wildcard SELECT joins the array path when this runtime's array
      // read returns the executed projection (probeWildcardArrayRead); the
      // keys still come from columns() after stepping, never a pre-step
      // shape. A LIMIT 1 read stays on object rows: its one row cannot
      // repay the columns() call and decode-plan setup.
      const arrays =
        bindingArrayStatements.get(db)?.has(stmt) ||
        (/^\s*SELECT\b/i.test(sql) &&
          (!sql.includes('*') || (!/\bLIMIT\s+1\b/.test(sql) && wildcardArraysEligible(sql))))
          ? nativeArrayResults(db, stmt)
          : undefined;
      if (arrays) arrays.setReturnArrays.call(stmt, true);
      const raw = readResultRows(stmt, positional?.sql ?? sql, binding, positional?.params);
      // SQL text cannot identify column types across DDL, rollback or namespace
      // changes. Describe this execution after stepping, when SQLite may have
      // automatically reprepared it. A matching description can reuse decoding.
      // Pin the builtin method before stepping: SQL functions can run JS while
      // all() executes. Neither types nor keys may come from a pre-step shape.
      const columns = arrays && raw.length > 0 ? arrays.columns.call(stmt) : undefined;
      const decoders = raw.length === 0 ? null : resultColumnDecoders(stmt, declared, memo, columns);
      const rows =
        raw.length > 0 && (arrays || raw.length > 1)
          ? normalizeResultRows(raw, decoders, columns, arrays && arrays === nativeResultMethods)
          : raw.map((r) =>
              normalizeRow(r as Record<string, null | number | bigint | string | Uint8Array>, decoders ?? undefined),
            );
      // Preparation is a fixed cost. Large results keep fresh statements:
      // retaining them does not repay the native reader's result-sized work.
      if (reusable && raw.length <= 128 && retainStatementBindings(binding)) statements!.set(plan, stmt);
      return { rows, rowCount: rows.length };
    }
    const info = positional ? stmt.run(...positional.params) : binding ? stmt.run(binding) : stmt.run();
    const changes = typeof info.changes === 'bigint' ? Number(info.changes) : info.changes;
    const lastID = typeof info.lastInsertRowid === 'bigint' ? Number(info.lastInsertRowid) : info.lastInsertRowid;
    if (reusable && retainStatementBindings(binding)) statements!.set(plan, stmt);
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
/** A transaction boundary invalidates a suspended native iterator before executing. */
const TX_BOUNDARY_HEAD = /^\s*(?:begin|savepoint|release|commit|end|rollback)\b/i;

interface ActiveSqliteIterator {
  readonly owner: object;
  close(): void;
}

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

/** The error when a transaction or iterator holds the handle past `busyTimeoutMs`. */
function handleBusyError(timeoutMs: number): SerializationFailureError {
  return new SerializationFailureError({
    message:
      `SQLite database is busy: a transaction or stream on this client held it for longer than busyTimeoutMs (${timeoutMs} ms). ` +
      'Retry the operation (withRetry does), keep transactions short, close streams with return(), or raise busyTimeoutMs.',
  });
}

/** Options for {@link SqlitePool}. */
export interface SqlitePoolOptions {
  /**
   * How long, in ms, a statement waits for a transaction or iterator another caller has
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
 * uncommitted rows. A native iterator also owns the handle until it is closed;
 * a connectivity check holds it only while its statement runs.
 */
export class SqlitePool implements PgCompatPool {
  /** The underlying native handle, retained as a readonly field in declarations. */
  declare readonly db: DatabaseSync;
  private readonly nativeDb: DatabaseSync;
  private closed = false;
  private readonly decoderMemo: DecoderMemo = { decoders: null };
  private readonly queryPlans: SqliteQueryPlans = { entries: new Map(), bytes: 0 };
  private statements: WeakMap<SqliteQueryPlan, ReturnType<DatabaseSync['prepare']>> | undefined;
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
  /** Only transactions opened through this pool may be rolled back on release. */
  private transactionOwner: object | null = null;
  private activeIterator: ActiveSqliteIterator | undefined;

  constructor(db: DatabaseSync, options: SqlitePoolOptions = {}) {
    this.nativeDb = db;
    // Capture the owner so readonly proxies can expose the handle without
    // forwarding private reads or writes through their public interface.
    Object.defineProperty(this, 'db', {
      get: () => {
        this.statements = undefined;
        return db;
      },
      enumerable: true,
      configurable: true,
    });
    if (unexposedNativeDatabases.delete(db)) this.statements = new WeakMap();
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
        return this.runAs(owner, sql, params, () => released);
      },
      streamBatches: (text, values, batchSize) => this.iterateAs(owner, text, values, batchSize, () => released),
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
    try {
      this.activeIterator?.close();
    } finally {
      this.closed = true;
      this.decoderMemo.columns = undefined;
      this.decoderMemo.decoders = null;
      this.statements = undefined;
      this.queryPlans.entries.clear();
      this.queryPlans.bytes = 0;
      this.nativeDb.close();
    }
  }

  /** Is the handle inside a transaction right now? */
  private inTransaction(): boolean {
    const reported = (this.nativeDb as { isTransaction?: unknown }).isTransaction;
    return typeof reported === 'boolean' ? reported : this.trackedTransaction;
  }

  /** Run one statement for `owner`, waiting first if another caller's transaction holds the handle. */
  private async runAs(owner: object, sql: string, params: unknown[], released?: () => boolean) {
    if (this.closed) throw new ConnectionError('This SQLite client has been disconnected.');
    if (this.inTransaction() && this.transactionOwner === null && this.owner !== owner) {
      throw new UnsupportedFeatureError(
        'A pooled statement inside an externally opened transaction',
        'sqlite',
        'The supplied DatabaseSync has a caller-owned transaction. Use that handle for statements until ' +
          'the caller commits or rolls back; the pool cannot assign unrelated statements to that transaction safely.',
      );
    }
    if (this.owner !== owner) {
      if (this.owner !== null || this.waiters.length > 0) {
        if (this.calledFromOwnersCallback()) throw statementInsideTransactionError();
        await this.waitForHandle(owner);
      } else {
        this.owner = owner;
      }
    }
    try {
      if (this.closed || released?.()) throw new ConnectionError('This SQLite connection was closed or released.');
      if (this.activeIterator?.owner === owner) {
        if (TX_BOUNDARY_HEAD.test(sql)) this.activeIterator.close();
        else
          throw new ValidationError(
            'Close the active SQLite stream with return() before issuing another statement on its connection.',
          );
      }
      const wasInTransaction = this.inTransaction();
      const result = runStatement(
        this.nativeDb,
        sql,
        params,
        this.declared,
        this.decoderMemo,
        this.queryPlans,
        this.statements,
      );
      if (TX_OPEN_HEAD.test(sql)) this.trackedTransaction = true;
      else if (TX_CLOSE_HEAD.test(sql)) this.trackedTransaction = false;
      if (!wasInTransaction && this.inTransaction()) this.transactionOwner = owner;
      else if (!this.inTransaction()) this.transactionOwner = null;
      return result;
    } finally {
      // A statement that leaves no transaction open hands the handle on.
      if (this.owner === owner && !this.inTransaction() && !this.activeIterator) this.handOff();
    }
  }

  /**
   * Step on this checkout's handle, never `.all()`. Stepping is synchronous:
   * timers/cancellation run between pulls, not during sqlite3_step(). A batch
   * bounds row count only; one BLOB/JSON row, nested relation or SQLite sort
   * can still be arbitrarily large. No nested results are truncated.
   */
  private async *iterateAs(
    owner: object,
    text: string,
    values: unknown[],
    batchSize: number,
    released: () => boolean,
  ): AsyncGenerator<Record<string, unknown>[], void, undefined> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1)
      throw new ValidationError('SQLite stream batchSize must be a positive safe integer.');
    if (this.closed || released()) throw new ConnectionError('This SQLite connection was closed or released.');
    // The SQL-head fallback tracks only statements sent through this pool. It
    // cannot distinguish an external transaction on a supplied handle, so it
    // cannot safely support the native iterator's ownership contract.
    if (typeof this.nativeDb.isTransaction !== 'boolean')
      throw new UnsupportedFeatureError(
        'Native incremental streaming',
        'sqlite',
        'DatabaseSync.isTransaction is required (Node 22.x >= 22.16, or Node >= 24). Upgrade Node for native streaming.',
      );
    if (this.inTransaction() && this.transactionOwner === null && this.owner !== null && this.owner !== owner) {
      throw new UnsupportedFeatureError(
        'Concurrent streams inside an externally opened transaction',
        'sqlite',
        'Close the active stream before opening another stream on the supplied DatabaseSync.',
      );
    }
    if (this.owner !== owner) {
      if (this.owner !== null || this.waiters.length > 0) {
        if (this.calledFromOwnersCallback()) throw statementInsideTransactionError();
        await this.waitForHandle(owner);
      } else this.owner = owner;
    }
    let active: ActiveSqliteIterator | undefined;
    let failed = false;
    try {
      if (this.closed || released()) throw new ConnectionError('This SQLite connection was closed or released.');
      if (this.activeIterator)
        throw new ValidationError(
          'Close the active SQLite stream with return() before opening another stream on its connection.',
        );
      const binding = toNamedBinding(values);
      const { sql } = sqliteQueryPlan(text, values.length, this.queryPlans);
      const stmt = prepareSingleStatement(this.nativeDb, sql);
      stmt.setReadBigInts(true);
      if (typeof stmt.iterate !== 'function')
        throw new UnsupportedFeatureError(
          'Native incremental streaming',
          'sqlite',
          'The SQLite driver must provide StatementSync.iterate().',
        );
      let normalize: ((row: Record<string, unknown>) => Record<string, unknown>) | undefined;
      const iterator = binding ? stmt.iterate(binding) : stmt.iterate();
      if (typeof iterator.return !== 'function')
        throw new UnsupportedFeatureError(
          'Native incremental streaming',
          'sqlite',
          'The SQLite iterator must provide return() so a suspended statement can be closed.',
        );
      let closed = false;
      active = {
        owner,
        close: () => {
          if (closed) return;
          closed = true;
          try {
            iterator.return!();
          } finally {
            if (this.activeIterator === active) this.activeIterator = undefined;
          }
        },
      };
      this.activeIterator = active;
      while (true) {
        if (closed)
          throw new ValidationError('This SQLite stream was closed when its transaction or connection ended.');
        const batch: Record<string, unknown>[] = [];
        let done = false;
        for (let i = 0; i < batchSize; i++) {
          const step = iterator.next();
          if (step.done) {
            done = true;
            break;
          }
          // The first step can reprepare after external DDL. Validate its fresh
          // description, then pin the decoder map for this iterator's snapshot.
          if (normalize === undefined) {
            const decoders = resultColumnDecoders(stmt, this.declared, this.decoderMemo);
            batch.push(normalizeRow(step.value, decoders ?? undefined));
            normalize = streamRowNormalizer(stmt, step.value, decoders, !bindingArrayStatements.has(this.nativeDb));
          } else batch.push(normalize(step.value));
        }
        if (done) active.close();
        if (batch.length > 0) yield batch;
        if (done) return;
      }
    } catch (err) {
      failed = true;
      throw augmentSqliteError(err);
    } finally {
      try {
        active?.close();
      } catch (err) {
        // A step failure remains the primary error if cleanup also failed.
        // biome-ignore lint/correctness/noUnsafeFinally: only replaces a successful return, never a step failure.
        if (!failed) throw augmentSqliteError(err);
      } finally {
        if (this.owner === owner && !this.activeIterator && this.transactionOwner !== owner) this.handOff();
      }
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
    try {
      if (this.activeIterator?.owner === owner) this.activeIterator.close();
    } finally {
      if (this.transactionOwner === owner && this.inTransaction() && !this.closed) {
        try {
          this.nativeDb.exec('ROLLBACK');
        } catch {
          // Nothing left to roll back.
        }
        this.trackedTransaction = false;
        this.transactionOwner = null;
      }
      this.handOff();
    }
  }
}

// ---------------------------------------------------------------------------
// Type mapping (SQLite declared type → TypeScript)
// ---------------------------------------------------------------------------

/**
 * Map a SQLite declared column type (type affinity) to a TypeScript type.
 * SQLite is dynamically typed; use the declared `PRAGMA table_info` type.
 */
/** Is a SQLite declared type a date/time type (so values coerce back to `Date`)? */
function isSqliteDateType(declaredType: string): boolean {
  const t = declaredType.toLowerCase();
  return isDateType(t) || /(timestamp|datetime|date)/.test(t);
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
  ...createPortableSqliteDialect({
    declaredTypes: driverReportsDeclaredTypes,
    decodeBlob: (value) => Uint8Array.from(Buffer.from(value, 'hex')),
    recordBulkInsert: recordSqliteBulkInsert,
  }),
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
  hidden: number;
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
  name: string | null;
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
  options: Pick<
    CatalogIntrospectOptions,
    'include' | 'exclude' | 'includeViews' | 'logger' | 'legacyToManyUniques'
  > = {},
) {
  // ----- Tables (skip SQLite internal + the migration tracking table) -----
  const catalogTables = pragma<{ name: string; sql: string | null }>(
    db,
    options.includeViews === true
      ? "SELECT name, sql FROM main.sqlite_master WHERE type IN ('table', 'view') AND substr(name, 1, 7) <> 'sqlite_' ORDER BY name"
      : "SELECT name, sql FROM main.sqlite_master WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_' ORDER BY name",
  );
  const candidateTables = catalogTables.map((t) => t.name);
  const tableDefinitions = new Map(catalogTables.map((t) => [t.name, t.sql ?? '']));
  let tableFlags: Map<string, { name: string; type: string; wr: number; strict: number }>;
  // Keep option access before the existing table-list read. Native shadow
  // classification adds per-call defaults; explicit include still restores them.
  const tableNames = applyTableFilters(candidateTables, options, (defaults) => {
    tableFlags = new Map(
      pragma<{ name: string; type: string; wr: number; strict: number }>(db, 'PRAGMA main.table_list').map((t) => {
        if (t.type === 'shadow') defaults.add(t.name);
        return [t.name, t];
      }),
    );
  });
  const tableSet = new Set(tableNames);

  const columnsByTable = new Map<string, ColumnMetadata[]>();
  const pkByTable = new Map<string, string[]>();
  const uniqueByTable = new Map<string, string[][]>();
  const relationUniqueByTable = new Map<string, string[][]>();
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
    // table_xinfo also exposes computed columns (hidden = 2/3). Virtual-table
    // hidden inputs (1) are not ordinary projected/writable columns.
    const cols = pragma<PragmaColumn>(db, `PRAGMA main.table_xinfo(${q(tableName)})`).filter((c) => c.hidden !== 1);
    const idxList = pragma<PragmaIndex>(db, `PRAGMA main.index_list(${q(tableName)})`);
    const flags = tableFlags!.get(tableName);
    const primaryColumns = cols.filter((c) => c.pk > 0);
    // Only a sole INTEGER PK on a rowid table aliases the rowid. A separate
    // PK index distinguishes the historical inline PRIMARY KEY DESC exception
    // without parsing DDL; INT/BIGINT and WITHOUT ROWID keys never qualify.
    const rowidKey =
      flags?.wr === 0 && primaryColumns.length === 1 && !idxList.some((idx) => idx.origin === 'pk')
        ? primaryColumns.find((c) => c.type.toUpperCase() === 'INTEGER')?.name
        : undefined;
    const colMeta: ColumnMetadata[] = [];
    const pkCols: { name: string; order: number }[] = [];
    for (const c of cols) {
      const declared = c.type || '';
      const generated = c.hidden === 2 || c.hidden === 3;
      const nullable =
        c.notnull === 0 && c.name !== rowidKey && !(c.pk > 0 && (flags?.wr === 1 || flags?.strict === 1));
      const tsType = sqliteTypeToTs(declared, nullable);
      colMeta.push({
        name: c.name,
        field: snakeToCamel(c.name),
        dialectType: declared,
        pgType: declared,
        tsType,
        ...(tsType === `Uint8Array${nullable ? ' | null' : ''}` ? { inferredBinaryType: 'Uint8Array' as const } : {}),
        nullable,
        hasDefault: c.dflt_value !== null || c.name === rowidKey || generated,
        ...(c.name === rowidKey ? { isGenerated: true } : {}),
        // This existing flag means computed/non-writable to the generator and
        // write guards, which is true for both SQLite VIRTUAL and STORED values.
        ...(generated ? { isGeneratedStored: true } : {}),
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
    const fks = pragma<PragmaForeignKey>(db, `PRAGMA main.foreign_key_list(${q(tableName)})`);
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
        const targetPk = pragma<PragmaColumn>(db, `PRAGMA main.table_xinfo(${q(entry.targetTable)})`)
          .filter((c) => c.pk > 0)
          .sort((a, b) => a.pk - b.pk)
          .map((c) => c.name);
        entry.targetColumns = targetPk.length > 0 ? targetPk : ['id'];
      }
      if (tableSet.has(entry.targetTable)) foreignKeys.push(entry);
    }

    // ----- Indexes + unique constraints -----
    const idxMeta: IndexMetadata[] = [];
    const uniques: string[][] = [];
    // An index's collation can differ from the relation comparison's column
    // collation: UNIQUE BINARY can admit both 'a' and 'A' under NOCASE joins.
    // Column collations are absent from table_xinfo. Conservatively keep the
    // to-many shape if the table/index DDL mentions COLLATE (even in a comment
    // or identifier), rather than promise a to-one on incomplete facts.
    const tableHasCollation = /\bCOLLATE\b/i.test(tableDefinitions.get(tableName) ?? '');
    const relationUniques = tableHasCollation ? [] : [pkByTable.get(tableName) ?? []];
    for (const idx of idxList) {
      const keys = pragma<PragmaIndexColumn>(db, `PRAGMA main.index_info(${q(idx.name)})`).sort(
        (a, b) => a.seqno - b.seqno,
      );
      const plain = keys.length > 0 && keys.every((c) => c.cid >= 0 && c.name !== null);
      // Expression keys have no column name. Never let their null catalog
      // placeholders reach metadata/codegen or treat the remaining names as a
      // unique set. Keep the real DDL for partial/expression index consumers.
      // `columns` must describe a complete plain key: shared consumers also
      // derive compound selectors from it without parsing the definition.
      const idxCols = plain ? keys.map((c) => c.name!) : [];
      const catalog = db
        .prepare("SELECT sql FROM main.sqlite_master WHERE type = 'index' AND name = ?")
        .get(idx.name) as { sql: string | null } | undefined;
      idxMeta.push({
        name: idx.name,
        columns: idxCols,
        unique: idx.unique === 1,
        definition:
          catalog?.sql ??
          `${idx.unique === 1 ? 'UNIQUE ' : ''}INDEX ${q(idx.name)} ON ${q(tableName)}(${idxCols.map(q).join(', ')})`,
        ...(idx.partial === 1 ? { partial: true } : {}),
      });
      if (idx.unique === 1 && idx.partial === 0 && plain) {
        uniques.push(idxCols);
        if (!tableHasCollation && !/\bCOLLATE\b/i.test(catalog?.sql ?? '')) relationUniques.push(idxCols);
      }
    }
    indexesByTable.set(tableName, idxMeta);
    uniqueByTable.set(tableName, uniques);
    relationUniqueByTable.set(tableName, relationUniques);
  }

  // ----- Build relations from foreign keys (belongsTo + hasMany + m2m) -----
  // Delegated to the SHARED introspection pipeline (introspect.ts) so SQLite
  // derives IDENTICAL relation names to the Postgres introspector for the
  // same logical schema, legacy-first naming, per-column disambiguation,
  // collision resolution against scalar column fields, and the conservative
  // pure-junction manyToMany auto-detection included.
  // One field per column, as the PostgreSQL introspector requires.
  for (const [tableName, cols] of columnsByTable) assertDistinctColumnFields(tableName, cols);
  // A to-one is decided per foreign key BEFORE naming, so it is named as
  // PostgreSQL names it (`users.profile`); the shared test is the libSQL and D1
  // one, so every SQLite introspector gives the same answer.
  const relationsByTable = deriveEngineRelations(
    tableNames,
    foreignKeys,
    pkByTable,
    columnsByTable,
    options.logger,
    options.legacyToManyUniques
      ? undefined
      : sqliteToOneForeignKey(columnsByTable, relationUniqueByTable, tableDefinitions, tableFlags!),
  );

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
      ...(tableFlags!.get(tableName)?.type === 'view' ? { isView: true } : {}),
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
export async function introspectSqlite(
  options: IntrospectOptions & Pick<CatalogIntrospectOptions, 'legacyToManyUniques' | 'includeViews'>,
): Promise<SchemaMetadata> {
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
    return introspectSqliteDatabase(db, {
      include: options.include,
      exclude: options.exclude,
      logger: options.logger,
      legacyToManyUniques: options.legacyToManyUniques,
      includeViews: options.includeViews,
    });
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
  unexposedNativeDatabases.add(db);
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
  return createSqliteBindingClient(db, schema, options, owns, sqliteDialect);
}

/** @internal Shared native SQLite lifecycle; bindings retain their own open and decode policy. */
export function createSqliteBindingClient(
  db: DatabaseSync,
  schema: SchemaMetadata,
  options: TurbineSqliteOptions,
  owns: boolean,
  dialect: Dialect,
  arrayStatements?: WeakMap<object, NativeResultMethods>,
): TurbineClient {
  let pool: SqlitePool;
  let client: TurbineClient;
  try {
    if (arrayStatements) bindingArrayStatements.set(db, arrayStatements);
    pool = new SqlitePool(db, { busyTimeoutMs: options.busyTimeoutMs, schema });
    // Everything that is not a SQLite pragma is client config and rides through
    // untouched, so a new TurbineConfig option works here the day it lands. The
    // engine-owned keys come last, so no caller can unbind the dialect.
    const { wal: _wal, busyTimeoutMs: _busyTimeoutMs, foreignKeys: _foreignKeys, ...clientConfig } = options;
    client = new TurbineClient(
      {
        ...clientConfig,
        pool,
        dialect,
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
