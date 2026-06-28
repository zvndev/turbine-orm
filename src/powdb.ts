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
 * `powdb-server` / the embedded addon, see `docs/strategy/powdb-parity-matrix.md`):
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
 *   - **Single global write lock; no savepoints/isolation/pipelining** — nested
 *     transactions / isolation / vector / LISTEN-NOTIFY / RLS throw.
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

import {
  type PgCompatPool,
  type PgCompatPoolClient,
  type PgCompatQueryResult,
  TurbineClient,
  type TurbineConfig,
} from './client.js';
import { type Dialect, postgresDialect } from './dialect.js';
import { ConnectionError, TimeoutError, UniqueConstraintError, ValidationError } from './errors.js';
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
 * Nested transactions (savepoints) and isolation levels remain Phase B.
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
  beginStatement: () => 'begin',
  commitStatement: () => 'commit',
  rollbackStatement: () => 'rollback',
};

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
 * `required unique`; non-nullable columns are `required`.
 */
export function powqlSchemaDDL(schema: SchemaMetadata): string[] {
  const stmts: string[] = [];
  for (const meta of Object.values(schema.tables)) {
    const pkSet = new Set(meta.primaryKey);
    const fields = meta.columns.map((col) => {
      const mods: string[] = [];
      if (!col.nullable || pkSet.has(col.name)) mods.push('required');
      if (pkSet.has(col.name)) mods.push('unique');
      return `  ${mods.join(' ')}${mods.length ? ' ' : ''}${col.name}: ${powqlColumnType(col)}`;
    });
    stmts.push(`type ${meta.name} {\n${fields.join(',\n')}\n}`);
    // Secondary unique constraints (beyond the PK) become unique indexes.
    for (const uniq of meta.uniqueColumns) {
      if (uniq.length === 1 && !pkSet.has(uniq[0]!)) {
        stmts.push(`alter ${meta.name} add unique .${uniq[0]}`);
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

/** Translate a `@zvndev/powdb-client` error into a typed Turbine error. */
export function wrapPowdbError(err: unknown): Error {
  if (!err || typeof err !== 'object') return new ConnectionError(`[turbine] PowDB error: ${String(err)}`);
  const e = err as { code?: string; message?: string };
  const msg = e.message ?? 'unknown PowDB error';
  if (/unique constraint violation/i.test(msg)) {
    const m = /on\s+\S+\.(\w+)/i.exec(msg);
    return new UniqueConstraintError({ constraint: m?.[1], cause: err as Error });
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

  constructor(
    readonly pool: PowdbClientPool,
    private readonly toParam: (v: unknown, i: number) => PowdbParam = (v) => toPowdbParam(v),
  ) {}

  // biome-ignore lint/suspicious/noExplicitAny: pg-compat query is generic over the row shape.
  async query(text: QueryArg, values?: unknown[]): Promise<any> {
    const { text: powql, params } = normalizeQueryArgs(text, values);
    try {
      const result = await this.pool.withClient((c) => c.query(powql, params.map(this.toParam)));
      return adaptResult(result);
    } catch (err) {
      throw wrapPowdbError(err);
    }
  }

  async connect(): Promise<PgCompatPoolClient> {
    const client = await this.pool.acquire();
    let broken = false;
    return {
      // biome-ignore lint/suspicious/noExplicitAny: see query() above.
      query: async (text: QueryArg, values?: unknown[]): Promise<any> => {
        const { text: powql, params } = normalizeQueryArgs(text, values);
        try {
          return adaptResult(await client.query(powql, params.map(this.toParam)));
        } catch (err) {
          broken = true;
          throw wrapPowdbError(err);
        }
      },
      release: () => (broken ? this.pool.destroy(client) : this.pool.release(client)),
    };
  }

  async end(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.close();
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
}

interface EmbeddedModule {
  Database: { open(dir: string): EmbeddedDatabase };
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

  constructor(private readonly db: EmbeddedDatabase) {}

  private run(powql: string, params: unknown[]): PgCompatQueryResult {
    try {
      const materialized = materializePowql(powql, params);
      return adaptResult(normalizeEmbeddedResult(this.db.query(materialized)));
    } catch (err) {
      throw wrapPowdbError(err);
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: pg-compat query is generic over the row shape.
  async query(text: QueryArg, values?: unknown[]): Promise<any> {
    const { text: powql, params } = normalizeQueryArgs(text, values);
    return this.run(powql, params);
  }

  async connect(): Promise<PgCompatPoolClient> {
    // Single in-process handle — the "client" shares the one Database; tx
    // keywords run serially on it.
    return {
      // biome-ignore lint/suspicious/noExplicitAny: see query() above.
      query: async (text: QueryArg, values?: unknown[]): Promise<any> => {
        const { text: powql, params } = normalizeQueryArgs(text, values);
        return this.run(powql, params);
      },
      release: () => {},
    };
  }

  async end(): Promise<void> {
    if (this.closed) return;
    // The addon exposes no explicit close — drop the reference and let GC /
    // the engine's checkpoint flush. Caveat: durability is checkpoint-bound, so
    // hold the process open long enough for the final WAL flush in short scripts.
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
 * ```
 */
export interface TurbinePowdbEmbeddedTarget {
  embedded: string;
}

/**
 * Dynamically load `@zvndev/powdb-client`. Kept out of the static import graph so
 * `import 'turbine-orm/powdb'` never throws when the optional peer is absent.
 */
async function loadPowdb(): Promise<PowdbModule> {
  try {
    return (await import('@zvndev/powdb-client')) as unknown as PowdbModule;
  } catch (err) {
    throw new ConnectionError(
      "[turbine] turbine-orm/powdb requires the optional peer dependency '@zvndev/powdb-client'. Install it: npm i @zvndev/powdb-client. " +
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
  try {
    const mod = (await import('@zvndev/powdb-embedded')) as unknown as EmbeddedModule;
    if (!mod || typeof mod.Database?.open !== 'function') {
      throw new Error('module did not export Database.open');
    }
    return mod;
  } catch (err) {
    throw new ConnectionError(
      "[turbine] turbine-orm/powdb embedded mode requires the optional peer '@zvndev/powdb-embedded'. " +
        'Install it: npm i @zvndev/powdb-embedded. If install succeeded but loading failed, your platform has no ' +
        'prebuilt binary (prebuilts ship for macOS arm64/x64 and Linux glibc x64/arm64; Intel-mac/musl/Windows ' +
        'build from source) — build it with `npm run build` in the addon, then retry. ' +
        `(${(err as Error).message})`,
    );
  }
}

/** Open an embedded database handle, wrapping engine open failures (corrupt dir, etc.). */
async function openEmbeddedPool(dir: string): Promise<PowdbEmbeddedPool> {
  const mod = await loadPowdbEmbedded();
  let db: EmbeddedDatabase;
  try {
    db = mod.Database.open(dir);
  } catch (err) {
    throw new ConnectionError(`[turbine] PowDB embedded could not open data dir "${dir}": ${(err as Error).message}`);
  }
  return new PowdbEmbeddedPool(db);
}

/**
 * Bind Turbine to PowDB. `target` is one of:
 *   - a host/port options object → a **networked** `@zvndev/powdb-client` pool;
 *   - an `{ embedded: <data-dir> }` object → an in-process
 *     `@zvndev/powdb-embedded` database (no server);
 *   - an already-constructed `@zvndev/powdb-client` `Pool` or {@link PowdbPool}
 *     (injection — you own its lifecycle and `disconnect()` is a no-op).
 *
 * Resolves to a `TurbineClient` whose `table()` accessors generate **PowQL** via
 * {@link PowqlInterface}. The SQL `Dialect` is not involved.
 */
export async function turbinePowDB(
  target: PowdbConnOptions | PowdbClientPool | PowdbPool | TurbinePowdbEmbeddedTarget,
  schema: SchemaMetadata,
  options: TurbinePowdbOptions = {},
): Promise<TurbineClient> {
  let pool: PgCompatPool;
  let owns = false;

  if (target instanceof PowdbPool) {
    pool = target;
  } else if (isEmbeddedTarget(target)) {
    pool = await openEmbeddedPool(target.embedded);
    owns = true;
  } else if (isPowdbClientPool(target)) {
    pool = new PowdbPool(target);
  } else {
    const mod = await loadPowdb();
    pool = new PowdbPool(new mod.Pool({ ...(target as PowdbConnOptions), max: options.connectionLimit ?? 10 }));
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

  if (!owns) {
    // Injected pool — the caller owns its lifecycle.
    (client as { disconnect: () => Promise<void> }).disconnect = async () => {};
  }
  return client;
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
