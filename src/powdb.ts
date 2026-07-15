/**
 * turbine-orm/powdb — Turbine's PowDB / PowQL backend.
 *
 * PowDB is a single-node embedded database with its own query language, **PowQL**
 * (not SQL), reached over `@zvndev/powdb-client`'s binary TCP protocol. PowDB is a
 * different shape than the SQL engines, so this module does NOT route through the
 * SQL `Dialect` / `QueryInterface`: it ships a parallel {@link PowqlInterface} that
 * generates PowQL, plugged into `TurbineClient` via the `queryInterfaceFactory`
 * seam. The four SQL engines are untouched.
 *
 * PowDB realities shape the design (all verified firsthand against a live
 * `powdb-server` / the embedded addon, see `docs/internal/strategy/powdb-parity-matrix.md`):
 *   - **`RETURNING` (since 0.7.0)** — `create/createMany/update/delete` append the
 *     trailing `returning` keyword (`RETURNING *`, all columns) and read the
 *     affected rows back in one round-trip. `upsert` is the lone exception (its
 *     statement rejects `returning`) and reselects by primary key.
 *   - **No generated IDs** — the app must supply every value → Turbine generates a
 *     client-side UUID for the primary key when it has a default.
 *   - **`uuid`/`datetime`/`bytes` columns can't hold client-supplied values** (no
 *     literal, no working cast on the wire) → Turbine maps everything onto the four
 *     writable types (`str`/`int`/`float`/`bool`); `Date` → `int` epoch micros;
 *     `string` PKs hold UUID strings.
 *   - **No JSON aggregation / link navigation** — single-query nested `with` is
 *     impossible → it degrades to batched N+1 loaders (Phase B).
 *   - **Single global write lock; no savepoints/isolation** — nested
 *     transactions / isolation / vector / LISTEN-NOTIFY / RLS throw.
 *     Independent concurrent `db.$transaction` calls do NOT throw: they queue
 *     FIFO on a pool-level gate and run one at a time (see {@link PowdbTxGate}).
 *     Only a *re-entrant* transaction — a `db.$transaction` opened from inside
 *     an active transaction callback's async context, which queueing would
 *     deadlock — fails fast with E017.
 *   - **The wire protocol pipelines** — `@zvndev/powdb-client` writes each
 *     request frame immediately and matches replies FIFO, so multiple queries
 *     may be in flight on one connection. {@link PowdbPool}'s checked-out
 *     clients advertise `supportsPipelining`, which lets the batch
 *     `$transaction([...])` overload dispatch all statements in one write
 *     burst (~1 round trip) instead of one round trip per statement.
 *
 * `@zvndev/powdb-client` is an **optional peer dependency** loaded by dynamic
 * import; `npm i turbine-orm` still pulls only `pg`.
 *
 * @example
 * ```ts
 * import { turbinePowDB } from 'turbine-orm/powdb';
 * import { SCHEMA } from './generated/turbine/metadata.js';
 *
 * const db = await turbinePowDB({ host: '127.0.0.1', port: 5433 }, SCHEMA);
 * const user = await db.table('users').create({ data: { name: 'Ada' } }); // UUID id auto-generated
 * const found = await db.table('users').findMany({ where: { name: 'Ada' }, limit: 10 });
 * await db.disconnect();
 * ```
 *
 * @module
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type PgCompatPool,
  type PgCompatPoolClient,
  type PgCompatQueryResult,
  TurbineClient,
  type TurbineConfig,
} from './client.js';
import { type Dialect, postgresDialect } from './dialect.js';
import {
  ConnectionError,
  NotNullViolationError,
  TimeoutError,
  UniqueConstraintError,
  UnsupportedFeatureError,
  ValidationError,
} from './errors.js';
import importOptionalPeer from './optional-peer-import.cjs';
import type { QueryInterface, QueryInterfaceOptions } from './query/index.js';
import type { ColumnMetadata, SchemaMetadata, TableMetadata } from './schema.js';

/**
 * Capability descriptor for PowDB. PowQL generation is owned by
 * {@link PowqlInterface} (not the SQL `Dialect`), so this dialect exists only to
 * drive `TurbineClient`'s capability gating and transaction keywords:
 *   - `supports*` flags are all `false` for the Postgres-only features, so
 *     `$listen`/`$notify`, RLS `sessionContext`/`$withSession`, and pgvector
 *     throw a clear {@link UnsupportedFeatureError} (E017) at the client surface
 *     instead of emitting SQL that PowDB cannot parse.
 *   - `begin`/`commit`/`rollback` are lowercase PowQL keywords (verified on the
 *     wire) so a single-level `$transaction` works.
 *   - PowDB has a single global write lock and supports neither savepoints nor
 *     nested/concurrent transactions. The `savepoint*` keywords therefore throw
 *     {@link UnsupportedFeatureError} (E017): a nested `tx.$transaction` emits a
 *     savepoint synchronously (before any DB call) and so fails fast with a
 *     clear typed error instead of leaking PowDB's cryptic `Parse(... 'sp_1')`.
 *     The pool-level transaction gate (see {@link PowdbTxGate}) handles the
 *     other shapes: a fresh top-level `db.$transaction` opened inside an
 *     already-open one throws E017 before it can deadlock on the write lock,
 *     while INDEPENDENT concurrent `db.$transaction` calls queue FIFO and run
 *     one at a time instead of failing.
 * Isolation levels remain Phase B.
 */
export const powdbDialect: Dialect = {
  ...postgresDialect,
  name: 'powdb',
  // `resultStrategy` is decorative for PowDB — PowqlInterface owns its own write
  // path and never reads it. Set to 'returning' for honesty: writes use PowDB
  // 0.7.0's trailing `returning` keyword (upsert excepted — see PowqlInterface).
  resultStrategy: 'returning',
  supportsReturning: true,
  supportsVector: false,
  supportsListenNotify: false,
  supportsRLS: false,
  supportsAdvisoryLock: false,
  supportsILike: false,
  // PowQL has no LATERAL construct; PowqlInterface refuses pick ordering
  // earlier, this override keeps the flag truthful if a future path consults it.
  supportsLateralJoin: false,
  beginStatement: () => 'begin',
  commitStatement: () => 'commit',
  rollbackStatement: () => 'rollback',
  // PowDB has no savepoints — a nested `tx.$transaction` would emit one and PowDB
  // rejects it with a cryptic parse error. Throw a clear typed error instead.
  // These run synchronously in TransactionClient.$transaction before any query,
  // so the nested call fails fast with no partial DB state.
  savepointStatement: throwNoNestedTransaction,
  releaseSavepointStatement: throwNoNestedTransaction,
  rollbackToSavepointStatement: throwNoNestedTransaction,
};

/** Reject any savepoint (nested-transaction) operation — PowDB is single-writer. */
function throwNoNestedTransaction(): never {
  throw new UnsupportedFeatureError(
    'nested transactions',
    'powdb',
    'PowDB is single-writer — it has one global write lock and no savepoints. ' +
      'Complete the open transaction before starting another; do not nest `$transaction` calls.',
  );
}

// ---------------------------------------------------------------------------
// PowDB client surface (the subset we bind — see @zvndev/powdb-client)
// ---------------------------------------------------------------------------

/** A single value PowDB accepts as a positional `$N` parameter. */
type PowdbParam = string | number | bigint | boolean | null;

/**
 * Marker wrapper for a value bound to a `float` column. The networked driver
 * unwraps it to the plain number (the wire param is unchanged), but the
 * *embedded* literal encoder reads it to emit a float-form PowQL literal (`42`
 * → `42.0`) so an integer-valued float column stays unambiguously a float.
 * Constructed in {@link PowqlInterface.param}.
 */
export class PowdbFloatParam {
  constructor(readonly value: number) {}
}

/** The four shapes a PowQL result takes over the wire. */
type PowdbResult =
  | { kind: 'rows'; columns: string[]; rows: string[][] }
  | { kind: 'scalar'; value: string }
  | { kind: 'ok'; affected: bigint }
  | { kind: 'message'; message: string };

interface PowdbClient {
  readonly serverVersion: string;
  query(query: string, params?: PowdbParam[], opts?: { signal?: AbortSignal }): Promise<PowdbResult>;
  close(): Promise<void>;
}

interface PowdbClientPool {
  acquire(): Promise<PowdbClient>;
  release(c: PowdbClient): void;
  destroy(c: PowdbClient): void;
  withClient<T>(fn: (c: PowdbClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

interface PowdbModule {
  Client: { connect(opts: PowdbConnOptions): Promise<PowdbClient> };
  Pool: new (opts: PowdbConnOptions & { max?: number }) => PowdbClientPool;
  isPowDBError?(err: unknown): err is { code: string; message: string };
}

/** Connection options for {@link turbinePowDB} — host/port, not a connection string. */
export interface PowdbConnOptions {
  host: string;
  port: number;
  dbName?: string;
  user?: string;
  password?: string | null;
  connectTimeoutMs?: number;
  tls?: boolean;
}

/** Minimum PowDB server version the networked transport requires. */
export const MIN_POWDB_VERSION = '0.7.0';

/**
 * Parse a `powdb://[user[:pass]@]host[:port][/db]` connection string into
 * {@link PowdbConnOptions} (consistency with `turbineMysql`/`turbineMssql`,
 * which accept a URL). Defaults: host `127.0.0.1`, port `5433`.
 */
export function parsePowdbUrl(connectionString: string): PowdbConnOptions {
  let u: URL;
  try {
    u = new URL(connectionString);
  } catch {
    throw new ConnectionError(`[turbine] Invalid PowDB connection string: "${connectionString}"`);
  }
  if (u.protocol !== 'powdb:') {
    throw new ConnectionError(
      `[turbine] PowDB connection string must use the powdb:// scheme (got "${u.protocol}//…").`,
    );
  }
  const opts: PowdbConnOptions = {
    host: u.hostname || '127.0.0.1',
    port: u.port ? Number(u.port) : 5433,
  };
  if (u.username) opts.user = decodeURIComponent(u.username);
  if (u.password) opts.password = decodeURIComponent(u.password);
  const db = u.pathname.replace(/^\//, '');
  if (db) opts.dbName = decodeURIComponent(db);
  return opts;
}

/**
 * Fail fast if a networked PowDB server is older than {@link MIN_POWDB_VERSION}.
 * Turbine's write path relies on the trailing `returning` keyword and the
 * int→float coercion fix, both of which landed in 0.7.0. Embedded exposes no
 * version method, so this is networked-only (the embedded peer is pinned ^0.7.0
 * at install time). A non-semver / empty version string is tolerated (we cannot
 * prove it is too old).
 */
export function assertSupportedPowdbVersion(version: string | undefined): void {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? '').trim());
  if (!m) return; // unknown / non-semver — don't block
  const [major, minor] = [Number(m[1]), Number(m[2])];
  // 0.7.0 is the floor; >= 0.7 (or any 1.x+) passes.
  if (major > 0 || (major === 0 && minor >= 7)) return;
  throw new ConnectionError(
    `[turbine] turbine-orm/powdb requires PowDB >= ${MIN_POWDB_VERSION}; the server reports "${version}". ` +
      'Upgrade the PowDB server (0.7.0 added the `returning` keyword and the int->float coercion fix Turbine relies on).',
  );
}

// ---------------------------------------------------------------------------
// Type mapping — Turbine schema type → PowQL DDL type, and value coercion
// ---------------------------------------------------------------------------

/** PowQL column types Turbine is willing to emit (the four writable scalars). */
export type PowqlType = 'str' | 'int' | 'float' | 'bool';

/**
 * Map a Turbine column to the PowQL DDL type used in `defineSchema` →
 * `type T { … }`. Turbine never emits PowDB's `uuid`/`datetime`/`bytes` types,
 * which cannot hold client-supplied values on the wire (no literal, no cast):
 *   - `Date` → `int` (epoch micros)   - `boolean` → `bool`
 *   - integral `number`/`bigint` → `int`   - fractional `number` → `float`
 *   - everything else (incl. UUID/PK strings) → `str`
 * Array / JSON / bytes columns throw — they have no PowDB equivalent.
 */
export function powqlColumnType(col: ColumnMetadata): PowqlType {
  if (col.isArray) {
    throw new ValidationError(
      `[turbine] Column "${col.name}" is an array — PowDB has no array type. Arrays are unsupported on the PowDB backend.`,
    );
  }
  const ts = col.tsType.replace(/\s*\|\s*null$/i, '').trim();
  if (ts === 'Date') return 'int'; // epoch micros
  if (ts === 'boolean') return 'bool';
  if (ts === 'number') return isFloatColumn(col) ? 'float' : 'int';
  if (ts === 'bigint') return 'int';
  if (ts === 'string') return 'str';
  if (ts === 'Buffer' || ts === 'Uint8Array') {
    throw new ValidationError(
      `[turbine] Column "${col.name}" is binary — PowDB cannot store client-supplied bytes on the wire. Use a string (e.g. base64) instead.`,
    );
  }
  if (/Record<|object|unknown|\[\]|\{/.test(ts)) {
    throw new ValidationError(
      `[turbine] Column "${col.name}" (${col.tsType}) maps to JSON/object, which PowDB has no type for. Flatten it or store a JSON string.`,
    );
  }
  return 'str';
}

/** Heuristic: does this numeric column hold fractional values (→ PowQL `float`)? */
function isFloatColumn(col: ColumnMetadata): boolean {
  const t = (col.dialectType ?? col.pgType ?? '').toLowerCase();
  return /float|double|real|numeric|decimal|money/.test(t);
}

/** Is a column stored as `int` epoch micros but surfaced as a JS `Date`? */
function isDateColumn(col: ColumnMetadata): boolean {
  return col.tsType.replace(/\s*\|\s*null$/i, '').trim() === 'Date';
}

/**
 * Generate PowQL DDL (`type T { … }`) for every table in a schema. Used to
 * provision a PowDB database from a code-first `defineSchema`/`SchemaMetadata`
 * (PowDB has no migration runner yet). The primary key column is declared
 * `required unique`; non-nullable columns are `required`. A server-generated
 * column ({@link ColumnMetadata.isGenerated}) that maps to PowQL `int` gets the
 * `auto` modifier, so PowDB assigns a monotonic id on insert and Turbine stops
 * synthesizing a client-side value for it.
 */
/**
 * PowQL reserved words — the v0.10 lexer keyword table from POWQL.md's
 * "Reserved Words and Quoting" section, including the v0.10 additions
 * `schema` and `describe`. Keyword matching is case-sensitive in the lexer,
 * so only the exact lowercase form collides.
 */
export const POWQL_KEYWORDS: ReadonlySet<string> = new Set([
  'abs',
  'add',
  'alter',
  'and',
  'as',
  'asc',
  'auto',
  'avg',
  'begin',
  'between',
  'case',
  'cast',
  'ceil',
  'column',
  'commit',
  'concat',
  'conflict',
  'count',
  'cross',
  'date_add',
  'date_diff',
  'default',
  'delete',
  'dense_rank',
  'desc',
  'describe',
  'distinct',
  'drop',
  'else',
  'end',
  'exists',
  'explain',
  'extract',
  'false',
  'filter',
  'floor',
  'group',
  'having',
  'in',
  'index',
  'inner',
  'insert',
  'is',
  'join',
  'left',
  'length',
  'let',
  'like',
  'limit',
  'link',
  'lower',
  'match',
  'materialize',
  'materialized',
  'max',
  'min',
  'multi',
  'not',
  'now',
  'null',
  'offset',
  'on',
  'or',
  'order',
  'outer',
  'over',
  'partition',
  'pow',
  'rank',
  'refresh',
  'required',
  'returning',
  'right',
  'rollback',
  'round',
  'row_number',
  'schema',
  'select',
  'sqrt',
  'substring',
  'sum',
  'then',
  'transaction',
  'trim',
  'true',
  'type',
  'union',
  'unique',
  'update',
  'upper',
  'upsert',
  'view',
  'when',
]);

const POWQL_BARE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Backtick-quote an identifier when PowQL would otherwise lex it as a keyword
 * (or when it contains characters outside the bare-identifier grammar).
 * Applied only in bare-identifier positions — DDL type/field names, index DDL,
 * and `insert`/`update`/`upsert` assignment targets. Dotted references
 * (`.col` in filters/projections/ordering) bypass keyword lookup on every
 * engine version and deliberately stay bare for ≤0.9 compatibility. Backticks
 * parse on PowDB ≥ 0.10; on older engines these names were already parse
 * errors when emitted bare, so quoting is strictly an improvement.
 */
export function quotePowqlIdent(name: string): string {
  if (name.includes('`')) {
    // The lexer has no backtick escape inside a quoted identifier.
    throw new ValidationError(`[turbine] Identifier "${name}" contains a backtick, which PowQL cannot represent.`);
  }
  return POWQL_KEYWORDS.has(name) || !POWQL_BARE_IDENT.test(name) ? `\`${name}\`` : name;
}

export function powqlSchemaDDL(schema: SchemaMetadata): string[] {
  const stmts: string[] = [];
  for (const meta of Object.values(schema.tables)) {
    const pkSet = new Set(meta.primaryKey);
    // PowDB's `unique` is single-column only — there is no composite-unique
    // constraint (`add unique` takes one `.column`). So the per-field `unique`
    // modifier is emitted only for a single-column PK; a composite PK (e.g. a
    // m2m junction's `(source_id, target_id)`) marks its columns `required` but
    // cannot enforce the tuple's uniqueness at the engine level.
    const pkIsSingle = meta.primaryKey.length === 1;
    const fields = meta.columns.map((col) => {
      const mods: string[] = [];
      if (!col.nullable || pkSet.has(col.name)) mods.push('required');
      if (pkSet.has(col.name) && pkIsSingle) mods.push('unique');
      // `auto` = server-generated monotonic int. PowDB requires it be `int` and
      // rejects it alongside a `default`; non-int generated columns fall back to
      // a plain typed column (Turbine assigns the value client-side instead).
      if (col.isGenerated && powqlColumnType(col) === 'int') mods.push('auto');
      return `  ${mods.join(' ')}${mods.length ? ' ' : ''}${quotePowqlIdent(col.name)}: ${powqlColumnType(col)}`;
    });
    stmts.push(`type ${quotePowqlIdent(meta.name)} {\n${fields.join(',\n')}\n}`);
    // Secondary unique constraints (beyond the PK) become unique indexes.
    for (const uniq of meta.uniqueColumns) {
      if (uniq.length === 1 && !pkSet.has(uniq[0]!)) {
        stmts.push(`alter ${quotePowqlIdent(meta.name)} add unique .${quotePowqlIdent(uniq[0]!)}`);
      }
    }
  }
  return stmts;
}

/** Coerce a JS value into a PowDB positional param (the write side). */
function toPowdbParam(value: unknown, col?: ColumnMetadata): PowdbParam {
  if (value instanceof PowdbFloatParam) return value.value; // wire-side: a float column takes the plain number
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return BigInt(value.getTime()) * 1000n; // ms → micros (int column)
  if (col && isDateColumn(col) && typeof value === 'number') return BigInt(value) * 1000n;
  if (
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'string'
  ) {
    return value;
  }
  // Objects/arrays have no PowDB representation.
  throw new ValidationError(`[turbine] Value of type ${typeof value} cannot be bound as a PowDB parameter.`);
}

/**
 * Coerce a single PowDB wire string into the JS value its column type implies.
 * Every PowDB value arrives as a string; NULL arrives as the bareword `"null"`.
 * Metadata resolves the `"null"` ambiguity for nullable non-string columns.
 */
export function coerceValue(raw: string, col: ColumnMetadata): unknown {
  const ts = col.tsType.replace(/\s*\|\s*null$/i, '').trim();
  // NULL bareword: unambiguous for non-string columns; for `str` we cannot tell a
  // literal "null" from SQL NULL, so a nullable str of value "null" reads as null.
  if (raw === 'null' && (ts !== 'string' || col.nullable)) return null;
  if (ts === 'Date') {
    const micros = Number(raw);
    return Number.isFinite(micros) ? new Date(micros / 1000) : null;
  }
  if (ts === 'boolean') return raw === 'true';
  if (ts === 'number') {
    const n = Number(raw);
    // int8 policy: keep precision-losing big integers as strings.
    return Number.isSafeInteger(n) || !Number.isInteger(n) ? n : raw;
  }
  if (ts === 'bigint') return BigInt(raw);
  return raw; // string / uuid-as-string
}

/**
 * Map one raw PowDB row (snake-cased columns → raw wire strings, as produced by
 * {@link PowdbPool}) into a typed entity (camelCase fields, coerced values).
 * Only the columns present in `raw` are emitted, so partial `select` projections
 * round-trip unchanged.
 */
export function rowToEntity(raw: Record<string, unknown>, meta: TableMetadata): Record<string, unknown> {
  const byName = new Map(meta.columns.map((c) => [c.name, c]));
  const out: Record<string, unknown> = {};
  for (const snake of Object.keys(raw)) {
    const col = byName.get(snake);
    const field = meta.reverseColumnMap[snake] ?? snake;
    const value = raw[snake];
    out[field] = col && typeof value === 'string' ? coerceValue(value, col) : value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------------

/**
 * Translate a PowDB error into a typed Turbine error. Handles BOTH transports,
 * whose error shapes differ:
 *   - **networked** (`@zvndev/powdb-client`) tags errors with a *semantic*
 *     `.code` (`connect_failed`, `timeout`, `query_failed`, …);
 *   - **embedded** (`@zvndev/powdb-embedded` napi addon) tags EVERY error
 *     `code:'GenericFailure'`, so the class can only be recovered from the
 *     message text (`Execution("column 'email' is required …")`,
 *     `Execution("type mismatch …")`, `Parse(…)`, `StorageError(…)`).
 *
 * So we always run the unique-constraint and message-shape checks first (they
 * fire for both transports), then fall through to the networked `.code` switch.
 */
export function wrapPowdbError(err: unknown): Error {
  if (!err || typeof err !== 'object') return new ConnectionError(`[turbine] PowDB error: ${String(err)}`);
  const e = err as { code?: string; message?: string };
  const msg = e.message ?? 'unknown PowDB error';

  // Unique-constraint — message-based on both transports.
  if (/unique constraint violation/i.test(msg)) {
    const m = /on\s+\S+\.(\w+)/i.exec(msg);
    return new UniqueConstraintError({ constraint: m?.[1], cause: err as Error });
  }
  // NOT NULL — "column 'x' is required but no value was provided". Map on BOTH
  // transports (the networked path used to collapse this into E003).
  if (/required|not[- ]?null|no value/i.test(msg)) {
    const m = /column ['"]?(\w+)['"]?/i.exec(msg);
    return new NotNullViolationError({ column: m?.[1], cause: err as Error });
  }
  // Driver pool lifecycle errors (acquire after close, acquire timeout) carry
  // no .code — classify by message so both transports surface E004.
  if (/pool closed|pool acquire timeout/i.test(msg)) {
    return new ConnectionError(`[turbine] PowDB connection unavailable: ${msg}`);
  }
  // Server-side transaction-gate wait bound (PowDB ≥ 0.10, default 5s): another
  // connection held the single global write lock past the server's
  // --tx-wait-timeout-ms. Retryable timeout, not a query defect.
  if (/transaction gate timeout/i.test(msg)) {
    return new TimeoutError(0, 'PowDB transaction gate');
  }
  // Type mismatch / parse / execution / storage / unexpected → validation
  // (E003). On the embedded transport these are the only signal we get
  // (code is always 'GenericFailure'); on the networked path they are a
  // safety net before the .code switch.
  if (/type mismatch|\bParse\b|\bExecution\b|StorageError|unexpected|row too large/i.test(msg)) {
    return new ValidationError(`[turbine] PowDB query rejected: ${msg}`);
  }

  switch (e.code) {
    case 'connect_failed':
    case 'closed':
      return new ConnectionError(`[turbine] PowDB connection failed: ${msg}`);
    case 'timeout':
    case 'aborted':
      return new TimeoutError(0, 'PowDB query');
    case 'query_failed':
    case 'type_coercion_failed':
    case 'protocol_error':
    case 'size_exceeded':
      return new ValidationError(`[turbine] PowDB query rejected: ${msg}`);
    default:
      return err instanceof Error ? err : new ConnectionError(`[turbine] PowDB error: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Driver shim — wrap @zvndev/powdb-client as a PgCompatPool
// ---------------------------------------------------------------------------

type QueryArg = string | { name?: string; text: string; values?: unknown[] };

function normalizeQueryArgs(arg: QueryArg, values?: unknown[]): { text: string; params: unknown[] } {
  if (typeof arg === 'string') return { text: arg, params: values ?? [] };
  return { text: arg.text, params: arg.values ?? values ?? [] };
}

/**
 * Classify a transaction-control statement so the single-writer guard can track
 * whether a transaction is open. Matches the lowercase keywords
 * {@link powdbDialect} emits (`begin`/`commit`/`rollback`) plus the common SQL
 * spellings, case-insensitively. Returns `null` for ordinary queries.
 */
function txControl(powql: string): 'begin' | 'commit' | 'rollback' | null {
  const head = powql.trim().toLowerCase();
  if (head === 'begin' || head === 'begin transaction' || head === 'start transaction') return 'begin';
  if (head === 'commit' || head === 'commit transaction' || head === 'end') return 'commit';
  if (head === 'rollback' || head === 'rollback transaction') return 'rollback';
  return null;
}

/**
 * The error a pool throws when a `begin` arrives from INSIDE an already-open
 * transaction's async context (a re-entrant `db.$transaction`). PowDB has ONE
 * global write lock and no savepoints: queueing a re-entrant transaction would
 * deadlock (the outer callback awaits the inner transaction, which waits on
 * the write lock the outer transaction holds), and on the networked transport
 * it would block a fresh pooled connection on the lock forever. This guard
 * converts that hang into a fast, typed error. Independent concurrent
 * transactions do NOT hit this — they queue FIFO on {@link PowdbTxGate}.
 */
function reentrantTransactionError(): UnsupportedFeatureError {
  return new UnsupportedFeatureError(
    're-entrant transactions',
    'powdb',
    'PowDB is single-writer — a transaction opened from inside an active transaction callback would deadlock ' +
      'on the write lock the open transaction holds. Use the `tx` client the callback receives, or start the ' +
      'second transaction after the first completes. (Independent concurrent transactions queue automatically.)',
  );
}

// ---------------------------------------------------------------------------
// Single-writer transaction gate — FIFO queueing + re-entrancy detection
// ---------------------------------------------------------------------------

/**
 * Default cap (ms) on how long a `begin` may wait in the FIFO queue for
 * PowDB's single global write lock before failing with a typed
 * {@link TimeoutError} (E002). Prevents silent starvation behind a wedged
 * transaction. Override via `transactionQueueTimeoutMs`
 * ({@link TurbinePowdbOptions} / {@link PowdbPoolOptions}); `0` or `Infinity`
 * waits without limit.
 */
export const DEFAULT_TX_QUEUE_TIMEOUT_MS = 30_000;

/**
 * Upper bound on the best-effort `rollback` a release-with-open-hold fires
 * before handing the gate to the next queued transaction. Keeps a dead socket
 * from wedging the FIFO queue while still letting the engine drop its global
 * write lock cleanly in the normal case.
 */
const RELEASE_ROLLBACK_TIMEOUT_MS = 2_000;

/**
 * Marker stored in the async context of a transaction CALLBACK's subtree.
 * It is planted by the pool's `wrapTransactionCallback` via
 * `powdbTxStorage.run(hold.ctx, fn)` around the user callback, never written
 * into the caller's context. Lets the gate tell a RE-ENTRANT `begin` (issued
 * from inside an active transaction callback, which would deadlock and must
 * throw) from an INDEPENDENT concurrent one (unmarked context, safe to queue).
 */
interface PowdbTxContext {
  /** The gate (one per pool) whose transaction this context belongs to. */
  readonly gate: PowdbTxGate;
  /** Flips once the transaction commits / rolls back / is torn down — a later `begin` in the same context is then fine. */
  done: boolean;
  /**
   * The marker that was already in scope when this transaction began — i.e.
   * the enclosing transaction, possibly on a DIFFERENT pool. AsyncLocalStorage
   * holds ONE value per store, so without this link a cross-pool nesting
   * (dbA tx → dbB tx → dbA begin) would let dbB's marker shadow dbA's and the
   * inner dbA begin would queue behind dbA's own open transaction (deadlock)
   * instead of throwing re-entrant E017. The re-entrancy check walks this
   * chain to find ANY live ancestor on the same gate.
   */
  readonly parent: PowdbTxContext | undefined;
}

const powdbTxStorage = new AsyncLocalStorage<PowdbTxContext>();

/** A held slot on the single-writer gate. `finish()` is idempotent. */
interface PowdbTxHold {
  /**
   * The re-entrancy marker for this transaction. The pool's
   * `wrapTransactionCallback` runs the user callback inside
   * `powdbTxStorage.run(ctx, fn)`: the SAME object `finish()` flips `done`
   * on, so a begin issued from a context that outlives the callback (e.g. a
   * fire-and-forget launched inside it) sees the completed state and queues
   * as an independent transaction.
   */
  readonly ctx: PowdbTxContext;
  /** Mark the transaction finished and hand the gate to the next queued `begin`. */
  finish(): void;
}

/**
 * FIFO gate serializing transactions across a whole pool. PowDB holds one
 * global write lock, so at most one transaction may be open per database:
 * without this gate a second `begin` on the networked transport checks out a
 * fresh connection and blocks forever on the lock the open transaction holds
 * (and the embedded engine rejects it with a raw parse error).
 *
 * `acquire()` is called (synchronously, see below) for every `begin`:
 *   - a **re-entrant** `begin` — issued from inside an active transaction's
 *     async context, detected via {@link powdbTxStorage} — throws E017
 *     immediately. Queueing it can never succeed: the open transaction cannot
 *     commit while its callback awaits the queued one.
 *   - an **independent** `begin` waits its FIFO turn, bounded by the queue
 *     timeout, then returns a {@link PowdbTxHold} the caller finishes on
 *     commit / rollback / connection release.
 *
 * Context propagation: `acquire()` only READS the async context (the
 * chain-walking check in its prologue); it never writes it. The marker is
 * planted by the pool's `wrapTransactionCallback` (`TurbineClient` invokes
 * the user callback as `powdbTxStorage.run(hold.ctx, fn)`), so it exists
 * exclusively inside the transaction CALLBACK's async subtree. Everything
 * launched from inside the callback (table ops on the `tx` client, a
 * fire-and-forget `db.$transaction`, nested-write implicit transactions)
 * inherits it; the CALLER's context stays unmarked. This is load-bearing: the
 * pre-0.31 implementation used `enterWith()` in acquire's prologue, which
 * mutates the caller's shared context. On a cold client the FIRST same-tick
 * burst of `db.$transaction` calls saw call #1's live marker from every
 * sibling and falsely threw re-entrant E017 (9/10 rejected in production;
 * one warm-up transaction masked it because its pruned `done` marker changed
 * the propagation shape). With `run()` the sibling contexts are unmarked by
 * construction, so they queue FIFO as intended. Markers form a chain
 * ({@link PowdbTxContext.parent}) so transactions nested across DIFFERENT
 * pools cannot shadow an outer marker on this gate; the re-entrancy check
 * walks every live ancestor.
 *
 * **Residual limitation:** a transaction begun OUTSIDE a `$transaction`
 * callback plants no marker (a manual raw `begin` span, or a worker loop
 * whose continuations captured their context before the transaction opened).
 * A deadlocking re-entrant begin from such a context cannot be told apart
 * from a legitimate independent concurrent transaction: it queues FIFO and,
 * because the open transaction is awaiting it, times out after
 * `transactionQueueTimeoutMs` with a typed {@link TimeoutError} rather than
 * throwing E017 instantly. The 30s default is the backstop for exactly this
 * case: do not set `transactionQueueTimeoutMs: 0` (wait forever) in code
 * paths that may start transactions from unmarked contexts.
 */
class PowdbTxGate {
  /** Tail of the FIFO queue — resolves once every earlier transaction has finished. */
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly queueTimeoutMs: number) {}

  /**
   * Take a place in the transaction queue. The prologue walks the caller's
   * marker chain (planted around transaction callbacks by the pool's
   * `wrapTransactionCallback`) and throws re-entrant E017 when any live
   * ancestor holds THIS gate. It never marks the caller's context itself;
   * the returned hold carries the fresh marker (`hold.ctx`) for
   * `wrapTransactionCallback` to scope around the user callback.
   */
  async acquire(): Promise<PowdbTxHold> {
    // Walk the WHOLE marker chain, not just the innermost marker: with two
    // pools, dbA-tx → dbB-tx → dbA-begin leaves dbB's marker innermost, but
    // the dbA ancestor is still open — queueing the inner dbA begin behind it
    // would deadlock. Any live ancestor on this gate ⇒ re-entrant E017.
    // Prune completed heads first (`done` never flips back) so sequential
    // transactions issued from one long-lived context do not chain — and leak
    // — unboundedly; what remains is bounded by real nesting depth.
    let parent = powdbTxStorage.getStore();
    while (parent?.done) parent = parent.parent;
    for (let c: PowdbTxContext | undefined = parent; c !== undefined; c = c.parent) {
      if (c.gate === this && !c.done) {
        throw reentrantTransactionError();
      }
    }
    const ctx: PowdbTxContext = { gate: this, done: false, parent };

    let handOff!: () => void;
    const finished = new Promise<void>((resolve) => {
      handOff = resolve;
    });
    const ahead = this.tail;
    this.tail = ahead.then(() => finished);

    const hold: PowdbTxHold = {
      ctx,
      finish: () => {
        if (ctx.done) return;
        ctx.done = true;
        handOff();
      },
    };

    // --- FIFO wait (optionally bounded) ---
    const timeoutMs = this.queueTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      await ahead;
      return hold;
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Give up the queue slot: finishing resolves our `finished` link, so
        // once every transaction ahead completes, later waiters skip straight
        // past us instead of stalling behind a slot nobody will release.
        hold.finish();
        reject(new TimeoutError(timeoutMs, 'PowDB transaction (queued behind the single-writer lock)'));
      }, timeoutMs);
      void ahead.then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });
    return hold;
  }
}

/** Tuning options shared by {@link PowdbPool} and {@link PowdbEmbeddedPool}. */
export interface PowdbPoolOptions {
  /**
   * Max time (ms) a concurrent transaction's `begin` may wait in the FIFO
   * queue for the single-writer lock before failing with a
   * {@link TimeoutError}. Default {@link DEFAULT_TX_QUEUE_TIMEOUT_MS};
   * `0` / `Infinity` = wait without limit. Note this is a separate surface
   * from `$transaction`'s `timeout` option, which only covers the callback
   * *after* the transaction has begun.
   */
  transactionQueueTimeoutMs?: number;
}

/** Adapt a PowDB result into the pg-compat `{ rows, rowCount, fields }` shape. */
function adaptResult(r: PowdbResult): PgCompatQueryResult {
  switch (r.kind) {
    case 'rows': {
      const rows = r.rows.map((row) => {
        const o: Record<string, unknown> = {};
        r.columns.forEach((c, i) => {
          o[c] = row[i];
        });
        return o;
      });
      return { rows, rowCount: rows.length, fields: r.columns.map((name) => ({ name, dataTypeID: 0 })) };
    }
    case 'ok':
      return { rows: [], rowCount: Number(r.affected), fields: [] };
    case 'scalar':
      return { rows: [{ value: r.value }], rowCount: 1, fields: [{ name: 'value', dataTypeID: 0 }] };
    default:
      return { rows: [], rowCount: 0, fields: [] };
  }
}

/**
 * A {@link PgCompatPool} backed by a `@zvndev/powdb-client` `Pool`. The query
 * `text` is **PowQL**, not SQL — {@link PowqlInterface} generates it. Rows come
 * back as raw strings here; per-column JS coercion happens in `PowqlInterface`
 * (it owns the schema metadata).
 */
export class PowdbPool implements PgCompatPool {
  private closed = false;
  /**
   * Pool-level single-writer gate. PowDB holds one global write lock, so at
   * most one transaction may be open across the whole pool. Concurrent
   * `begin`s queue FIFO on the gate (instead of checking out a second
   * connection and blocking on the lock forever — the networked hang);
   * re-entrant `begin`s throw E017 (see {@link PowdbTxGate}).
   */
  private readonly txGate: PowdbTxGate;
  /** Hold taken by a `begin` issued via `query()` directly (no checked-out client). */
  private poolHold: PowdbTxHold | null = null;
  /**
   * Clients currently checked out via {@link connect}. The driver pool's
   * `close()` only closes IDLE clients (checked-out ones are documented as the
   * caller's responsibility), so {@link end} destroys these explicitly;
   * otherwise a `disconnect()` racing an unreleased connection would leave a
   * live socket holding the process open until the server's idle timeout.
   */
  private readonly checkedOut = new Set<PowdbClient>();

  constructor(
    readonly pool: PowdbClientPool,
    private readonly toParam: (v: unknown, i: number) => PowdbParam = (v) => toPowdbParam(v),
    options: PowdbPoolOptions = {},
  ) {
    this.txGate = new PowdbTxGate(options.transactionQueueTimeoutMs ?? DEFAULT_TX_QUEUE_TIMEOUT_MS);
  }

  // biome-ignore lint/suspicious/noExplicitAny: pg-compat query is generic over the row shape.
  async query(text: QueryArg, values?: unknown[]): Promise<any> {
    this.assertOpen();
    const { text: powql, params } = normalizeQueryArgs(text, values);
    const ctl = txControl(powql);
    if (ctl === 'begin') {
      // Gate BEFORE touching the engine: a begin from inside an active
      // transaction callback throws re-entrant E017 fast; an independent
      // concurrent one waits its FIFO turn.
      this.poolHold = await this.txGate.acquire();
    }
    if ((ctl === 'commit' || ctl === 'rollback') && this.poolHold === null) {
      // No gate hold → our `begin` never ran (gate timeout / re-entrant
      // E017 / no begin at all). Never forward a stray commit/rollback to
      // the engine — PowDB is single-writer, so it could only ever end a
      // DIFFERENT caller's open transaction. Empty success instead.
      return { rows: [], rowCount: 0, fields: [] };
    }
    try {
      const result = await this.pool.withClient((c) => c.query(powql, params.map(this.toParam)));
      return adaptResult(result);
    } catch (err) {
      if (ctl === 'begin') {
        this.poolHold?.finish();
        this.poolHold = null;
      }
      throw wrapPowdbError(err);
    } finally {
      if (ctl === 'commit' || ctl === 'rollback') {
        this.poolHold?.finish();
        this.poolHold = null;
      }
    }
  }

  /**
   * Typed guard mirroring {@link PowdbEmbeddedPool}: after `end()` the driver
   * pool throws a raw `Error('pool closed')` that {@link wrapPowdbError}
   * cannot classify — surface the same ConnectionError on both transports.
   */
  private assertOpen(): void {
    if (this.closed) {
      throw new ConnectionError('[turbine] The PowDB pool is closed — disconnect() was already called on this client.');
    }
  }

  async connect(): Promise<PgCompatPoolClient> {
    this.assertOpen();
    let client: PowdbClient;
    try {
      client = await this.pool.acquire();
    } catch (err) {
      throw wrapPowdbError(err);
    }
    this.checkedOut.add(client);
    let broken = false;
    /** The gate hold of the transaction begun through THIS connection (if any). */
    let hold: PowdbTxHold | null = null;
    return {
      // The networked client's query() supports concurrent in-flight calls on
      // one connection: every request frame is written to the socket
      // immediately and replies are matched to callers in FIFO order. That
      // lets the batch `$transaction([...])` path dispatch all statements in
      // one write burst instead of paying a round trip per statement. Safe
      // for the batch's rollback contract because a failed statement leaves
      // the engine's transaction open (no aborted state, no auto-rollback) —
      // later pipelined statements execute inside the same still-open
      // transaction and the final `rollback` discards every effect. (The
      // batch path awaits `begin` before dispatching the burst, so the gate
      // wait below never reorders statements around it.)
      supportsPipelining: true,
      // biome-ignore lint/suspicious/noExplicitAny: see query() above.
      query: async (text: QueryArg, values?: unknown[]): Promise<any> => {
        const { text: powql, params } = normalizeQueryArgs(text, values);
        const ctl = txControl(powql);
        if (ctl === 'begin') {
          // Gate BEFORE hitting the engine: a begin from inside an active
          // transaction callback throws re-entrant E017 fast instead of
          // blocking on the global write lock the open tx holds; an
          // independent concurrent begin queues FIFO.
          hold = await this.txGate.acquire();
        }
        if ((ctl === 'commit' || ctl === 'rollback') && hold === null) {
          // This connection never acquired the gate — its `begin` never ran
          // (gate timeout / re-entrant E017). A stray commit/rollback must
          // never reach the single-writer engine, where it could only end a
          // DIFFERENT caller's open transaction. Empty success instead.
          return { rows: [], rowCount: 0, fields: [] };
        }
        try {
          return adaptResult(await client.query(powql, params.map(this.toParam)));
        } catch (err) {
          broken = true;
          if (ctl === 'begin') {
            hold?.finish();
            hold = null;
          }
          throw wrapPowdbError(err);
        } finally {
          if (ctl === 'commit' || ctl === 'rollback') {
            hold?.finish();
            hold = null;
          }
        }
      },
      // Single-writer re-entrancy scoping: TurbineClient runs the user's
      // transaction callback through this, so the gate's marker lives ONLY
      // in the callback's async subtree (everything inside it, tx table ops
      // and fire-and-forget db.$transaction alike, inherits it; the caller's
      // context stays unmarked). `hold.ctx` is the same object `finish()` flips, so
      // done-pruning keeps working for contexts that outlive the callback.
      wrapTransactionCallback: <R>(fn: () => Promise<R>): Promise<R> => {
        const ctx = hold?.ctx;
        return ctx ? powdbTxStorage.run(ctx, fn) : fn();
      },
      release: (err?: Error | boolean) => {
        // Releasing this connection ends its transaction scope. pg semantics:
        // a truthy `err` means "destroy, don't re-idle" — client.ts's
        // $transaction timeout path relies on that to keep an abandoned
        // callback's connection out of the pool. Additionally, an OPEN hold
        // here means the tx begun on this connection never saw commit/rollback
        // (timeout teardown or caller bug): fire a best-effort bounded
        // `rollback` FIRST so the engine drops its global write lock and the
        // server-side transaction ends (destroying the socket alone leaves it
        // open until the server's idle timeout), THEN hand the gate to the
        // next queued transaction. If the rollback fails or times out the
        // connection is treated as broken and destroyed. Never throws — a
        // teardown error must not mask the transaction's real outcome.
        const openHold = hold;
        hold = null;
        this.checkedOut.delete(client);
        const teardown = async (): Promise<void> => {
          let rolledBack = false;
          if (openHold) {
            try {
              await Promise.race([
                client.query('rollback', []).then(() => {
                  rolledBack = true;
                }),
                new Promise<void>((resolve) => {
                  const t = setTimeout(resolve, RELEASE_ROLLBACK_TIMEOUT_MS);
                  t.unref?.();
                }),
              ]);
            } catch {
              /* best-effort */
            }
            openHold.finish();
          }
          const mustDestroy = broken || Boolean(err) || (openHold !== null && !rolledBack);
          try {
            await (mustDestroy ? this.pool.destroy(client) : this.pool.release(client));
          } catch {
            /* the pool may already be closed */
          }
        };
        void teardown();
      },
    };
  }

  async end(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // close() rejects pending waiters and closes every IDLE client…
    await this.pool.close();
    // …but NOT checked-out ones (documented in @zvndev/powdb-client: "callers
    // that still hold one when close() is called are responsible for closing
    // it themselves"). Destroy any stragglers so end() never leaves a live
    // socket keeping the process alive until the server's idle timeout.
    for (const client of this.checkedOut) {
      this.pool.destroy(client);
    }
    this.checkedOut.clear();
  }
}

// ---------------------------------------------------------------------------
// Embedded driver — wrap @zvndev/powdb-embedded as a PgCompatPool
// ---------------------------------------------------------------------------

/** The embedded addon's result shape (matches {@link PowdbResult} but with optional fields). */
interface EmbeddedQueryResult {
  kind: string;
  columns?: string[];
  rows?: string[][];
  value?: string;
  affected?: bigint;
  message?: string;
}

/** A single in-process embedded database handle (`@zvndev/powdb-embedded`). */
interface EmbeddedDatabase {
  query(powql: string): EmbeddedQueryResult;
  querySql(sql: string): EmbeddedQueryResult;
  queryReadonly(powql: string): EmbeddedQueryResult;
  isPoisoned(): boolean;
  /** WAL durability selector — `@zvndev/powdb-embedded` ≥ 0.7.1. */
  setSyncMode?(mode: string): void;
}

interface EmbeddedModule {
  Database: {
    open(dir: string): EmbeddedDatabase;
    /** Open with a per-query memory budget — `@zvndev/powdb-embedded` ≥ 0.7.1. */
    openWithMemoryLimit?(dir: string, limitBytes: number): EmbeddedDatabase;
  };
}

/** Normalize the embedded addon's loosely-typed result into a {@link PowdbResult}. */
function normalizeEmbeddedResult(r: EmbeddedQueryResult): PowdbResult {
  switch (r.kind) {
    case 'rows':
      return { kind: 'rows', columns: r.columns ?? [], rows: r.rows ?? [] };
    case 'scalar':
      return { kind: 'scalar', value: r.value ?? 'null' };
    case 'ok':
      return { kind: 'ok', affected: r.affected ?? 0n };
    default:
      return { kind: 'message', message: r.message ?? '' };
  }
}

/**
 * Encode a JS value as a **PowQL literal** for the embedded driver, which takes
 * no params array — `$N` placeholders must be materialized into the query text.
 *
 * This is the single place Turbine builds PowQL text from a value, so it is the
 * security-critical surface. String encoding matches PowDB's lexer
 * (`crates/query/src/lexer.rs`) exactly: a string literal is `"…"`, and inside
 * it the lexer recognizes only the escapes `\"`, `\\`, `\n`, `\t` (any other
 * `\x` drops the backslash and keeps `x`; every non-`\`/non-`"` char — raw
 * newlines, CR, unicode — is taken literally). So we escape `\` → `\\` and
 * `"` → `\"` (the only breakout vectors), render `\n`/`\t` as their recognized
 * escapes, and leave everything else raw. Verified against the real engine:
 * quotes, backslashes, `$N`, `"); drop … --`, raw CR, and emoji all round-trip
 * as data and cannot break out of the literal or inject a second statement.
 */
export function encodePowqlLiteral(value: unknown): string {
  if (value instanceof PowdbFloatParam) {
    const n = value.value;
    if (!Number.isFinite(n)) throw new ValidationError(`[turbine] Non-finite float cannot be encoded for PowDB.`);
    // Force a float-form literal so an integer-valued float column stays a float.
    return Number.isInteger(n) ? `${n}.0` : String(n);
  }
  if (value === undefined || value === null) return 'null';
  if (value instanceof Date) return `${BigInt(value.getTime()) * 1000n}`; // epoch micros (int column)
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ValidationError(`[turbine] Non-finite number cannot be encoded for PowDB.`);
    // `String(n)` renders an integer as an int literal (`42`) and a fractional
    // number as a float literal (`4.2`) — PowQL distinguishes them by the dot.
    return String(value);
  }
  if (typeof value === 'string') return encodePowqlString(value);
  throw new ValidationError(`[turbine] Value of type ${typeof value} cannot be encoded as a PowDB literal.`);
}

/** Escape a string into a PowQL `"…"` literal, matching the engine lexer's escape rules. */
function encodePowqlString(s: string): string {
  let out = '"';
  for (const ch of s) {
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else out += ch; // raw — the lexer takes any other char literally (incl. CR, unicode)
  }
  return `${out}"`;
}

/**
 * Substitute every `$N` placeholder in a generator-produced PowQL template with
 * the encoded literal of `params[N-1]`. Safe because the template is produced by
 * {@link PowqlInterface} and contains **no** user string literals — the only
 * `$<digits>` tokens are genuine positional placeholders, so a single scan
 * cannot accidentally rewrite a `$N` that is itself part of a value (values are
 * params, never inlined into the template by the generator).
 */
export function materializePowql(powql: string, params: unknown[]): string {
  return powql.replace(/\$(\d+)/g, (_m, n: string) => {
    const idx = Number(n) - 1;
    if (idx < 0 || idx >= params.length) {
      throw new ValidationError(`[turbine] PowQL placeholder $${n} has no bound parameter (have ${params.length}).`);
    }
    return encodePowqlLiteral(params[idx]);
  });
}

/**
 * A {@link PgCompatPool} backed by an in-process `@zvndev/powdb-embedded`
 * `Database`. The embedded addon takes **no params array** — its `query(powql)`
 * accepts only a string — so this pool materializes each positional `$N` into a
 * PowQL literal via {@link materializePowql} before handing the text to the
 * engine. One handle, single connection: transaction keywords (`begin`/`commit`/
 * `rollback`) are issued serially as ordinary queries.
 */
export class PowdbEmbeddedPool implements PgCompatPool {
  private closed = false;
  /**
   * Single-writer gate. The embedded engine is one handle with one global
   * write lock — only one transaction may be open at a time. A re-entrant
   * `begin` (a fresh top-level `db.$transaction` opened inside an open one's
   * callback) would otherwise hit PowDB's raw "already in a transaction"
   * parse error; the gate surfaces a typed E017 instead, while INDEPENDENT
   * concurrent transactions queue FIFO and run one at a time. (Nested
   * `tx.$transaction` is caught earlier still, by the savepoint override in
   * {@link powdbDialect}.)
   */
  private readonly txGate: PowdbTxGate;
  /** Hold taken by a `begin` issued via `query()` directly (no checked-out client). */
  private readonly poolHoldRef: { hold: PowdbTxHold | null } = { hold: null };

  constructor(
    private readonly db: EmbeddedDatabase,
    options: PowdbPoolOptions = {},
  ) {
    this.txGate = new PowdbTxGate(options.transactionQueueTimeoutMs ?? DEFAULT_TX_QUEUE_TIMEOUT_MS);
  }

  /** Materialize `$N` params and hand the PowQL to the in-process engine. */
  private exec(powql: string, params: unknown[]): PgCompatQueryResult {
    const materialized = materializePowql(powql, params);
    return adaptResult(normalizeEmbeddedResult(this.db.query(materialized)));
  }

  /**
   * Run one statement, gating transaction control. `holdRef` scopes the gate
   * hold to whoever issued the `begin` (the pool itself or one checked-out
   * client), so finishing a transaction can never release a slot a different
   * transaction is holding.
   */
  private async run(
    powql: string,
    params: unknown[],
    holdRef: { hold: PowdbTxHold | null },
  ): Promise<PgCompatQueryResult> {
    if (this.closed) {
      throw new ConnectionError(
        '[turbine] The PowDB embedded pool is closed: disconnect() was already called on this client.',
      );
    }
    const ctl = txControl(powql);
    if (ctl === 'begin') {
      // Gate BEFORE hitting the engine: a begin from inside an active
      // transaction callback throws re-entrant E017 fast; independent
      // concurrent ones wait their FIFO turn.
      holdRef.hold = await this.txGate.acquire();
    }
    if ((ctl === 'commit' || ctl === 'rollback') && holdRef.hold === null) {
      // This context never acquired the gate — its `begin` never ran (the
      // gate timed out / threw re-entrant E017, or no begin was issued at
      // all). The engine is ONE shared handle: forwarding this stray
      // commit/rollback would hit whatever transaction ANOTHER caller has
      // open on it (live-reproduced: a best-effort ROLLBACK after a failed
      // begin silently discarded a concurrent transaction's writes). Swallow
      // it as an empty success instead — there is nothing of ours to end.
      return { rows: [], rowCount: 0, fields: [] };
    }
    try {
      return this.exec(powql, params);
    } catch (err) {
      if (ctl === 'begin') {
        holdRef.hold?.finish();
        holdRef.hold = null;
      }
      throw wrapPowdbError(err);
    } finally {
      if (ctl === 'commit' || ctl === 'rollback') {
        holdRef.hold?.finish();
        holdRef.hold = null;
      }
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: pg-compat query is generic over the row shape.
  async query(text: QueryArg, values?: unknown[]): Promise<any> {
    const { text: powql, params } = normalizeQueryArgs(text, values);
    return this.run(powql, params, this.poolHoldRef);
  }

  async connect(): Promise<PgCompatPoolClient> {
    // Single in-process handle — the "client" shares the one Database; tx
    // keywords run serially on it. Each checked-out client scopes its own
    // gate hold so release() only ever finishes ITS transaction.
    const holdRef: { hold: PowdbTxHold | null } = { hold: null };
    return {
      // biome-ignore lint/suspicious/noExplicitAny: see query() above.
      query: async (text: QueryArg, values?: unknown[]): Promise<any> => {
        const { text: powql, params } = normalizeQueryArgs(text, values);
        return this.run(powql, params, holdRef);
      },
      // Scope the gate's re-entrancy marker to the user callback's async
      // subtree (see PowdbPool.connect(), identical contract).
      wrapTransactionCallback: <R>(fn: () => Promise<R>): Promise<R> => {
        const ctx = holdRef.hold?.ctx;
        return ctx ? powdbTxStorage.run(ctx, fn) : fn();
      },
      release: () => {
        // End-of-scope safety net (see PowdbPool.connect()): a tx torn down
        // without an explicit commit/rollback must not wedge the queue — and
        // on the ONE shared embedded handle its open engine transaction must
        // actually be rolled back before the gate moves on, or the next
        // transaction's work interleaves into it. run() owns the
        // finish/null-out in its commit/rollback finally; the .finally here
        // is the fallback when run() itself rejects.
        const h = holdRef.hold;
        if (!h) return;
        void this.run('rollback', [], holdRef)
          .catch(() => {
            /* best-effort */
          })
          .finally(() => {
            h.finish();
            holdRef.hold = null;
          });
      },
    };
  }

  async end(): Promise<void> {
    if (this.closed) return;
    // The addon exposes no explicit close — drop the reference and let GC /
    // the engine's checkpoint flush. Marking the pool closed makes later
    // queries fail with a typed ConnectionError instead of silently running
    // against a handle the caller believes is gone. Caveat: durability is
    // checkpoint-bound, so hold the process open long enough for the final
    // WAL flush in short scripts.
    this.closed = true;
  }
}

// ---------------------------------------------------------------------------
// PowqlInterface — the PowQL query generator (Phase A: flat CRUD via returning)
// ---------------------------------------------------------------------------

export { PowqlInterface } from './powql.js';

// ---------------------------------------------------------------------------
// turbinePowDB — the public factory
// ---------------------------------------------------------------------------

/** Options for {@link turbinePowDB}. */
export interface TurbinePowdbOptions extends Pick<TurbineConfig, 'logging' | 'defaultLimit' | 'warnOnUnlimited'> {
  /** Max pooled connections (default 10). Networked transport only. */
  connectionLimit?: number;
  /**
   * Max time (ms) a concurrent `$transaction` waits in the FIFO queue for
   * PowDB's single global write lock before failing with a typed
   * `TimeoutError` (default {@link DEFAULT_TX_QUEUE_TIMEOUT_MS} = 30 000;
   * `0` / `Infinity` = wait without limit). Independent concurrent
   * transactions queue and run one at a time; only a re-entrant
   * `db.$transaction` (opened inside an active transaction callback) throws
   * E017 — queueing that shape would deadlock.
   */
  transactionQueueTimeoutMs?: number;
  /**
   * Driver-module injection for the networked target forms (URL / host+port):
   * bypasses the dynamic `import('@zvndev/powdb-client')` and uses this object
   * as the driver module instead. Intended for tests (a fake pool that counts
   * connections) and advanced embedding; everyday callers never set it.
   */
  powdbClientModule?: PowdbModule;
}

/**
 * Selects the **embedded** transport — an in-process `@zvndev/powdb-embedded`
 * database at the given data directory (no server, no socket). The value is the
 * data dir path. Preview: Full-durability checkpoint-bound; built binaries ship
 * for macOS (arm64/x64) and Unix-glibc only (Intel-mac/musl/Windows fall back to
 * a from-source `npm run build`).
 *
 * @example
 * ```ts
 * const db = await turbinePowDB({ embedded: '/var/data/app.powdb' }, SCHEMA);
 * // Faster writes (fsync off the commit path, bounded-loss) — requires addon >= 0.7.1:
 * const fast = await turbinePowDB({ embedded: '/var/data/app.powdb', syncMode: 'normal' }, SCHEMA);
 * ```
 */
export interface TurbinePowdbEmbeddedTarget {
  embedded: string;
  /**
   * WAL durability for the embedded engine (requires `@zvndev/powdb-embedded` ≥ 0.7.1):
   * `'full'` (default — fsync per commit), `'normal'` (fsync off the commit path,
   * ~15–40× faster writes, bounded loss on OS crash/power loss), `'off'` (bench-only).
   */
  syncMode?: 'full' | 'normal' | 'off';
  /** Per-query memory budget in bytes (requires `@zvndev/powdb-embedded` ≥ 0.7.1). */
  memoryLimit?: number;
}

/**
 * Dynamically load `@zvndev/powdb-client`. Kept out of the static import graph so
 * `import 'turbine-orm/powdb'` never throws when the optional peer is absent.
 */
async function loadPowdb(): Promise<PowdbModule> {
  try {
    // Via the .cts helper so the CJS build keeps a path to a REAL dynamic
    // import() — @zvndev/powdb-client ≥ 0.9 is ESM-only, and the CommonJS
    // pass transpiles a plain `import()` here into an unusable `require()`.
    return (await importOptionalPeer('@zvndev/powdb-client')) as unknown as PowdbModule;
  } catch (err) {
    throw new ConnectionError(
      "[turbine] turbine-orm/powdb requires the optional peer dependency '@zvndev/powdb-client'. Install it: npm i @zvndev/powdb-client — " +
        'or construct the PowDB pool yourself and inject it: turbinePowDB(pool, schema). ' +
        `(${(err as Error).message})`,
    );
  }
}

/**
 * Dynamically load `@zvndev/powdb-embedded` (the in-process napi addon). Kept out
 * of the static import graph — `import 'turbine-orm/powdb'` never pulls it. A
 * missing package or an unsupported platform (Intel-mac/musl/Windows ship no
 * prebuilt binary) throws a clear {@link ConnectionError} pointing at the
 * from-source `npm run build` fallback.
 */
async function loadPowdbEmbedded(): Promise<EmbeddedModule> {
  let mod: EmbeddedModule;
  try {
    // Via the .cts helper — keeps a real dynamic import() available to the
    // CJS build in case a future addon version ships ESM-only (see loadPowdb).
    mod = (await importOptionalPeer('@zvndev/powdb-embedded')) as unknown as EmbeddedModule;
  } catch (err) {
    throw new ConnectionError(
      "[turbine] turbine-orm/powdb embedded mode requires the optional peer '@zvndev/powdb-embedded'. " +
        'Install it: npm i @zvndev/powdb-embedded. If install succeeded but loading failed, your platform has no ' +
        'prebuilt binary (prebuilts ship for macOS arm64/x64 and Linux glibc x64/arm64; Intel-mac/musl/Windows ' +
        'build from source) — build it with `npm run build` in the addon, then retry. You can also construct the ' +
        'pool yourself and inject it: turbinePowDB(pool, schema). ' +
        `(${(err as Error).message})`,
    );
  }
  if (!mod || typeof mod.Database?.open !== 'function') {
    throw new ConnectionError(
      "[turbine] '@zvndev/powdb-embedded' loaded but did not export Database.open — the installed version is " +
        'likely incompatible (turbine-orm/powdb embedded requires @zvndev/powdb-embedded ^0.7.0).',
    );
  }
  return mod;
}

/** Open an embedded database handle, wrapping engine open failures (corrupt dir, etc.). */
async function openEmbeddedPool(
  target: TurbinePowdbEmbeddedTarget,
  poolOptions: PowdbPoolOptions = {},
): Promise<PowdbEmbeddedPool> {
  const mod = await loadPowdbEmbedded();
  const { embedded: dir, syncMode, memoryLimit } = target;
  let db: EmbeddedDatabase;
  try {
    if (memoryLimit !== undefined) {
      if (typeof mod.Database.openWithMemoryLimit !== 'function') {
        throw new ConnectionError('[turbine] embedded `memoryLimit` requires @zvndev/powdb-embedded ≥ 0.7.1.');
      }
      db = mod.Database.openWithMemoryLimit(dir, memoryLimit);
    } else {
      db = mod.Database.open(dir);
    }
  } catch (err) {
    if (err instanceof ConnectionError) throw err;
    throw new ConnectionError(`[turbine] PowDB embedded could not open data dir "${dir}": ${(err as Error).message}`);
  }
  if (syncMode !== undefined) {
    if (typeof db.setSyncMode !== 'function') {
      throw new ConnectionError(
        '[turbine] embedded `syncMode` requires @zvndev/powdb-embedded ≥ 0.7.1 (the installed addon has no setSyncMode).',
      );
    }
    db.setSyncMode(syncMode);
  }
  return new PowdbEmbeddedPool(db, poolOptions);
}

/**
 * Bind Turbine to PowDB. `target` is one of:
 *   - a `powdb://[user[:pass]@]host[:port][/db]` connection string → a
 *     **networked** `@zvndev/powdb-client` pool (consistency with
 *     `turbineMysql`/`turbineMssql`);
 *   - a host/port options object → a **networked** `@zvndev/powdb-client` pool;
 *   - an `{ embedded: <data-dir> }` object → an in-process
 *     `@zvndev/powdb-embedded` database (no server);
 *   - an already-constructed `@zvndev/powdb-client` `Pool` or {@link PowdbPool}
 *     (injection — you own its lifecycle and `disconnect()` is a no-op).
 *
 * On the networked transport the server version is probed and a clear
 * {@link ConnectionError} is thrown if it is older than {@link MIN_POWDB_VERSION}
 * (the `returning` keyword / int->float coercion fix Turbine relies on).
 *
 * Resolves to a `TurbineClient` whose `table()` accessors generate **PowQL** via
 * {@link PowqlInterface}. The SQL `Dialect` is not involved.
 */
export async function turbinePowDB(
  target: string | PowdbConnOptions | PowdbClientPool | PowdbPool | TurbinePowdbEmbeddedTarget,
  schema: SchemaMetadata,
  options: TurbinePowdbOptions = {},
): Promise<TurbineClient> {
  let pool: PgCompatPool;
  let owns = false;
  const poolOptions: PowdbPoolOptions = { transactionQueueTimeoutMs: options.transactionQueueTimeoutMs };

  if (typeof target === 'string') {
    const mod = options.powdbClientModule ?? (await loadPowdb());
    const clientPool = new mod.Pool({ ...parsePowdbUrl(target), max: options.connectionLimit ?? 10 });
    await assertNetworkedVersion(clientPool);
    pool = new PowdbPool(clientPool, undefined, poolOptions);
    owns = true;
  } else if (target instanceof PowdbPool) {
    // An injected PowdbPool carries its own PowdbPoolOptions.
    pool = target;
  } else if (isEmbeddedTarget(target)) {
    pool = await openEmbeddedPool(target, poolOptions);
    owns = true;
  } else if (isPowdbClientPool(target)) {
    pool = new PowdbPool(target, undefined, poolOptions);
  } else {
    const mod = options.powdbClientModule ?? (await loadPowdb());
    const clientPool = new mod.Pool({ ...(target as PowdbConnOptions), max: options.connectionLimit ?? 10 });
    await assertNetworkedVersion(clientPool);
    pool = new PowdbPool(clientPool, undefined, poolOptions);
    owns = true;
  }

  // The PowQL generator is loaded here to keep client.ts free of any PowDB import.
  const { PowqlInterface } = await import('./powql.js');
  const queryInterfaceFactory: NonNullable<QueryInterfaceOptions['queryInterfaceFactory']> = (
    p,
    table,
    sch,
    middlewares,
    opts,
  ) =>
    new PowqlInterface(p as unknown as PowdbPool, table, sch, middlewares, opts) as unknown as QueryInterface<object>;

  const client = new TurbineClient(
    {
      pool,
      preparedStatements: false,
      dialect: powdbDialect,
      logging: options.logging,
      defaultLimit: options.defaultLimit,
      warnOnUnlimited: options.warnOnUnlimited,
      queryInterfaceFactory,
    } as TurbineConfig & { queryInterfaceFactory: typeof queryInterfaceFactory },
    schema,
  );

  if (owns) {
    // Turbine built this pool / embedded handle, so disconnect()/end() must
    // close it. client.ts sees TurbineConfig.pool as EXTERNAL (ownsPool =
    // false) and skips pool.end(); before this patch an owned networked
    // client leaked its live socket(s) on disconnect(), holding the process
    // open until powdb-server's idle timeout (~300s) closed them. Consistent
    // with turbineMssql's owned-pool patch.
    const baseDisconnect = client.disconnect.bind(client);
    const close = async (): Promise<void> => {
      await baseDisconnect();
      await pool.end();
    };
    const patch = client as unknown as { disconnect: () => Promise<void>; end: () => Promise<void> };
    patch.disconnect = close;
    patch.end = close;
  } else {
    // Injected pool — the caller owns its lifecycle.
    (client as { disconnect: () => Promise<void> }).disconnect = async () => {};
  }
  return client;
}

/**
 * Probe a networked pool's `serverVersion` (declared on {@link PowdbClient}) and
 * fail fast if the server is older than {@link MIN_POWDB_VERSION}. Best-effort:
 * a driver that does not surface a version is left untouched (we cannot prove it
 * too old). Errors from the probe itself surface as the normal connect failure.
 */
async function assertNetworkedVersion(clientPool: PowdbClientPool): Promise<void> {
  await clientPool.withClient(async (c) => {
    assertSupportedPowdbVersion(c.serverVersion);
  });
}

function isPowdbClientPool(x: unknown): x is PowdbClientPool {
  return (
    !!x &&
    typeof x === 'object' &&
    typeof (x as PowdbClientPool).acquire === 'function' &&
    typeof (x as PowdbClientPool).withClient === 'function'
  );
}

function isEmbeddedTarget(x: unknown): x is TurbinePowdbEmbeddedTarget {
  return !!x && typeof x === 'object' && typeof (x as TurbinePowdbEmbeddedTarget).embedded === 'string';
}
