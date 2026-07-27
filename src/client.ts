/**
 * turbine-orm, TurbineClient
 *
 * The main entry point for the Turbine TypeScript SDK.
 * Manages connection pooling and provides typed table accessors.
 *
 * Schema-driven: call `table<T>(name)` to get a QueryInterface for any
 * table in the introspected schema. Generated clients extend this with
 * typed properties (e.g. `db.users`, `db.posts`).
 *
 * @example
 * ```ts
 * // With generated client (recommended):
 * import { turbine } from './generated/turbine';
 * const db = turbine({ connectionString: process.env.DATABASE_URL });
 * const user = await db.users.findUnique({ where: { id: 1 } });
 *
 * // With base client (dynamic):
 * import { TurbineClient } from 'turbine-orm';
 * const db = new TurbineClient({ connectionString: '...' }, schema);
 * const users = db.table<User>('users');
 * ```
 */

import pg from 'pg';
import { type Dialect, postgresDialect } from './dialect.js';
import {
  type ErrorMessageMode,
  setErrorMessageMode,
  TimeoutError,
  UnsupportedFeatureError,
  ValidationError,
  wrapPgError,
} from './errors.js';
import { type ObserveConfig, ObserveEngine, type ObserveHandle } from './observe.js';
import { executePipeline, type PipelineOptions, type PipelineResults, pipelineSupported } from './pipeline.js';
import {
  type DeferredQuery,
  type GlobalFilters,
  type QueryEvent,
  type QueryEventListener,
  QueryInterface,
  type QueryInterfaceOptions,
  type RelationLoadStrategy,
  type TemporalInfinityReading,
} from './query/index.js';
import {
  closestName,
  markTurbineParser,
  quoteIdent,
  registerUtcTemporalParsers,
  warnParserOverwrite,
} from './query/utils.js';
import { shouldWarnOnce, WARN_NS } from './query/warn-registry.js';
import {
  type ActiveSubscription,
  createSubscription,
  type NotificationHandler,
  type Subscription,
  validateChannel,
} from './realtime.js';
import type { SchemaMetadata } from './schema.js';
import { buildTypedSql, TypedSqlQuery } from './typed-sql.js';

// ---------------------------------------------------------------------------
// Retry utility
// ---------------------------------------------------------------------------

export interface RetryOptions {
  maxAttempts?: number;
  baseDelay?: number;
  maxDelay?: number;
  onRetry?: (error: unknown, attempt: number) => void;
}

export async function withRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const baseDelay = options?.baseDelay ?? 50;
  const maxDelay = options?.maxDelay ?? 5000;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isRetryable =
        err &&
        typeof err === 'object' &&
        'isRetryable' in err &&
        (err as { isRetryable: unknown }).isRetryable === true;
      if (!isRetryable || attempt === maxAttempts - 1) throw err;
      options?.onRetry?.(err, attempt + 1);
      const delay = Math.min(baseDelay * 2 ** attempt + Math.random() * baseDelay, maxDelay);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Minimal pg-compatible query result.
 * `pg.Pool`, `@neondatabase/serverless` Pool, `@vercel/postgres` Pool and
 * any driver speaking the node-postgres API all satisfy this shape.
 */
export interface PgCompatQueryResult<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number | null;
  fields?: Array<{ name: string; dataTypeID: number }>;
}

/**
 * Minimal pg-compatible client used by TurbineClient for transactions.
 * `pg.PoolClient` satisfies this; so do Neon and Vercel's equivalents.
 */
export interface PgCompatPoolClient {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<PgCompatQueryResult<R>>;
  release(err?: Error | boolean): void;
  /**
   * Optional driver capability: `true` when `query()` may be called again on
   * this connection while earlier calls are still in flight, with replies
   * delivered to callers in FIFO submission order. Drivers that set this let
   * the batch `$transaction([...])` overload dispatch every statement in one
   * write burst (~1 network round trip plus server time) instead of awaiting
   * each reply before sending the next (N round trips). Leave unset for
   * drivers (node-postgres included) whose batch path must stay strictly
   * sequential.
   */
  readonly supportsPipelining?: boolean;
  /**
   * Optional engine seam: scope a transaction's user callback to its own
   * async subtree. When present, `TurbineClient.transaction` / `$transaction`
   * invoke the callback as `wrapTransactionCallback(() => fn(tx))` instead of
   * `fn(tx)` directly. Single-writer engines (PowDB) implement it with
   * `AsyncLocalStorage.run()` to plant their re-entrancy marker so that it
   * exists ONLY inside the callback's async subtree: a transaction opened
   * from inside the callback is detected as re-entrant (typed E017), while
   * the CALLER's context stays unmarked, so same-tick sibling transactions
   * queue FIFO instead of being falsely flagged. Absent on pg and every other
   * engine, in which case the callback runs unwrapped (zero behavior change).
   */
  wrapTransactionCallback?<R>(fn: () => Promise<R>): Promise<R>;
}

/**
 * Minimal pg-compatible pool. Pass any driver that satisfies this interface
 * via `TurbineConfig.pool`, lets Turbine run on Neon HTTP, Vercel Postgres,
 * Cloudflare Hyperdrive, or any other serverless Postgres driver.
 *
 * @example
 * ```ts
 * import { Pool } from '@neondatabase/serverless';
 * import { TurbineClient } from 'turbine-orm';
 *
 * const neonPool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const db = new TurbineClient({ pool: neonPool }, schema);
 * ```
 */
export interface PgCompatPool {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<PgCompatQueryResult<R>>;
  connect(): Promise<PgCompatPoolClient>;
  end(): Promise<void>;
  /** Optional, pools that expose stats (pg.Pool does; Neon HTTP does not) */
  readonly totalCount?: number;
  readonly idleCount?: number;
  readonly waitingCount?: number;
  /** Optional, pg.Pool supports 'error' event; HTTP drivers typically do not */
  on?(event: 'error', listener: (err: Error) => void): this;
}

/**
 * Driver-neutral seam. Bundles a pg-compatible connection pool with the SQL
 * {@link Dialect} that owns every piece of SQL text varying across engines -
 * parameter placeholders, transaction-control keywords (BEGIN/COMMIT/ROLLBACK/
 * SAVEPOINT/isolation/set_config), streaming, and capability flags.
 *
 * This is the structural boundary that keeps hard-coded Postgres SQL out of
 * `client.ts`: the pool provides connect/query/transaction/close, the dialect
 * provides every literal keyword and the placeholder syntax. A future MySQL /
 * SQLite engine ships a `{ pool, dialect }` pair instead of a raw `pg.Pool`,
 * exactly as `turbineHttp` ships a serverless pool today.
 */
export interface TurbineDriver {
  /** The underlying pg-compatible connection pool (connect/query/transaction/close). */
  readonly pool: PgCompatPool;
  /** SQL dialect: placeholders, transaction keywords, session-config, capability flags. */
  readonly dialect: Dialect;
}

/**
 * The values PostgreSQL's `plan_cache_mode` accepts. See
 * {@link TurbineConfig.planCacheMode}.
 */
export type PlanCacheMode = 'auto' | 'force_custom_plan' | 'force_generic_plan';

/**
 * The accepted `plan_cache_mode` values, as a runtime set.
 *
 * A GUC name/value pair cannot be a bind parameter (`SET plan_cache_mode = $1`
 * is a syntax error), so the emitted statement necessarily contains a literal.
 * This CLOSED SET is therefore the entire safety boundary: the statement is
 * built from the matched MEMBER of this set, never from the caller's string,
 * so no input a caller can supply reaches the SQL text even if it compares
 * equal under some looser rule. Anything not in the set is refused at
 * construction. Module-private and frozen, so the set itself is not a mutation
 * target either.
 */
const PLAN_CACHE_MODES: readonly PlanCacheMode[] = Object.freeze([
  'auto',
  'force_custom_plan',
  'force_generic_plan',
] as const);

export interface TurbineConfig {
  /**
   * An external pg-compatible pool. Use this to plug in serverless drivers
   * like `@neondatabase/serverless`, `@vercel/postgres`, or any other pg-API
   * compatible pool. When provided, all connection-string fields are ignored
   * and Turbine will NOT create its own pg.Pool.
   */
  pool?: PgCompatPool;
  /** Postgres connection string (e.g. postgres://user:pass@host:5432/db) */
  connectionString?: string;
  /** Host (used if connectionString is not set) */
  host?: string;
  /** Port (default: 5432) */
  port?: number;
  /** Database name */
  database?: string;
  /** Username */
  user?: string;
  /** Password */
  password?: string;
  /** SSL/TLS options for the connection (required for most cloud providers) */
  ssl?: boolean | { rejectUnauthorized?: boolean; ca?: string; key?: string; cert?: string };
  /** Maximum number of connections in the pool (default: 10) */
  poolSize?: number;
  /** Idle timeout in ms before a connection is closed (default: 30000) */
  idleTimeoutMs?: number;
  /** Connection timeout in ms (default: 5000) */
  connectionTimeoutMs?: number;
  /** pg-style alias for {@link poolSize}; the explicit field wins when both are set. */
  max?: number;
  /** pg-style alias for {@link idleTimeoutMs}; the explicit field wins when both are set. */
  idleTimeoutMillis?: number;
  /** pg-style alias for {@link connectionTimeoutMs}; the explicit field wins when both are set. */
  connectionTimeoutMillis?: number;
  /** Enable query logging to console (default: false) */
  logging?: boolean;
  /** Default LIMIT applied to findMany() when no limit is specified (opt-in, default: undefined) */
  defaultLimit?: number;
  /**
   * Log a warning when findMany() is called without a limit (default: false).
   * Pass a per-table map (`{ users: false }`) to override the default for
   * specific tables; per-call `warnOnUnlimited` on findMany args wins over both.
   */
  warnOnUnlimited?: boolean | Record<string, boolean>;
  /**
   * Interpret Postgres `timestamp` (without time zone) values as UTC, both
   * at the driver level (type parsers for OIDs 1114 `timestamp`, 1082 `date`,
   * and their array forms 1115 / 1182, registered only when Turbine owns the
   * pool) and when coercing nested-relation JSON dates. A `date` column is
   * zone-less too, so it reads back as UTC midnight rather than the process's
   * local midnight. This is the
   * Prisma/Rails/Django convention and makes results independent of the
   * server's local time zone. Default: `true`. Set `false` for the legacy
   * local-time interpretation, which also turns off the matching WRITE-side
   * rewrite (a bound `Date` on a zone-less `date` / `timestamp` column is then
   * serialized by the driver in the process's zone).
   *
   * PER PROCESS, NOT PER CLIENT, AND RETROACTIVE. The read half is a pg type
   * parser, and `pg.types.setTypeParser` installs one parser per OID for the
   * whole process. There is ONE parser table and it is consulted per row at
   * decode time, so registration also changes POOLS THAT ALREADY EXIST AND ARE
   * ALREADY QUERYING: the same `pg.Pool` running the same query returns
   * different values before and after a Turbine client is constructed
   * somewhere else in the process. With lazy route imports that ordering is
   * not stable between requests, so a reporting job on its own pool can return
   * different days depending on what has been imported yet. When the OID was
   * still on the driver's default that is the intended trade; when something
   * else had already customized it, Turbine says so once (dev-only, see
   * `warnParserOverwrite`). The first client settles it for every later one, so
   * constructing a second client with the OPPOSITE value throws a
   * `ValidationError` rather than handing back a client whose writes and reads
   * disagree. Give every
   * client in the process the same value, or isolate the odd one in its own
   * process. A client on an EXTERNAL pool never REGISTERS a parser (it inherits
   * whatever configuration the caller's driver has, so a process containing
   * only external-pool clients is untouched), but it does take part in the
   * agreement check: registration is process-global, so once a Turbine-owned
   * client has installed the parsers an external-pool client reads through them
   * too, and a disagreeing one would write local `date` literals while reading
   * UTC.
   */
  utcTimestamps?: boolean;
  /**
   * How a Postgres temporal `infinity` / `-infinity` is handed back:
   * `'preserve'` (the default, the JS numbers `Infinity` / `-Infinity`) or
   * `'null'`. See {@link TemporalInfinityReading} for the full trade.
   *
   * There is no JS `Date` for either value, so both readings are wrong in some
   * way and the option is which way. `'preserve'` is LOSSLESS: binding the
   * number back stores `infinity` again, so a read-modify-write
   * (`update({ data: { ...row } })`) round-trips. Its cost is a number on a
   * `Date`-typed field, so `row.validUntil.toISOString()` throws a TypeError on
   * exactly those rows, and `JSON.stringify` still renders the value `null`.
   * `'null'` matches what `JSON.stringify` already produced and keeps the
   * field's declared `Date | null` type honest, at the cost of DATA LOSS: a
   * stored `infinity` and a stored NULL become indistinguishable, so that same
   * read-modify-write writes SQL NULL and destroys the value with no error.
   * The default is the reading that cannot lose a value.
   *
   * Unlike 0.54, which returned the number on some read strategies and an
   * Invalid Date on others, BOTH readings here are identical on every
   * strategy, every write projection, `groupBy` keys and `_min` / `_max`.
   *
   * Leaving the option unset selects `'preserve'` AND enables a one-time
   * warning (per process, per field, not silenced by `NODE_ENV=production`) the
   * first time a stored infinity is actually read, describing that reading and
   * both escapes. Naming either reading explicitly silences it.
   */
  temporalInfinity?: TemporalInfinityReading;
  /**
   * Pin `plan_cache_mode` on every connection this client opens, fixing how the
   * PostgreSQL backend chooses between a custom plan (re-planned per parameter
   * set) and a generic plan (planned once, blind to the values).
   *
   * Why it exists: Turbine sends NAMED prepared statements by default on a pool
   * it owns, and PostgreSQL MAY promote a named statement to a generic plan
   * after five executions (see the ceiling note below: it promotes only when
   * the generic plan's estimated cost is not worse than the average custom
   * cost). A generic plan is planned for the AVERAGE parameter, so a
   * predicate whose selectivity varies wildly per value (the canonical case is a
   * `tenant_id` / `user_id` equality on a shared table, where one value matches
   * a handful of rows and another matches most of them) is planned blind to the
   * value it will actually get, and it never reverts. `'force_custom_plan'`
   * removes that, at the cost of re-planning each execution.
   *
   * Scope. It applies to the statements Turbine itself promotes, which is any
   * of them: `count()`, `findMany` and `findFirst` alike. CORRECTION TO THE
   * 0.54.0 TEXT, which claimed `findMany` / `findFirst` were "much less
   * exposed" because they bind `LIMIT $n`: that was false. PostgreSQL does not
   * deny the planner a limit fraction for a bound limit, it SUBSTITUTES a
   * default of 10% of the child node's own row estimate (clamped at one row),
   * which is simply a different wrong number. An unknown `OFFSET` triggers the
   * same substitution on its own even when the limit is a constant, and a
   * paginated Turbine read binds both.
   *
   * Two things the sentence above this one glosses over. The sixth execution
   * is a CEILING, not a trigger: `auto` promotes only when the generic plan's
   * ESTIMATED cost is not worse than the average custom cost, so plenty of
   * statements are never promoted at all (`pg_prepared_statements.generic_plans`
   * is how you tell). And the shape that gets promoted unprompted is the one
   * with NO limit: measured on a skewed join predicate, the unlimited statement
   * promoted under the default `auto` and ran a nested loop at 430x the buffers
   * of the custom plan, while the same predicate under `LIMIT $n` was never
   * promoted across eight executions, because its substituted row count made
   * the generic plan look MORE expensive. A limited `findMany` gives the
   * planner two unknowns instead of one, which is not the same thing as more
   * damage.
   *
   * `implicitPkOrdering` is OFF by default in core, so a default `findMany`
   * emits no `ORDER BY` at all; switching it on adds an ordering a generic plan
   * can walk the whole table in.
   *
   * Treat the option as a targeted remedy for a plan that is measurably worse
   * after its fifth execution, not a general speed-up, and measure with
   * `plan_cache_mode = force_generic_plan` versus `force_custom_plan` rather
   * than reasoning about which query shapes "should" be safe.
   *
   * Default `undefined`: Turbine issues NOTHING and the backend keeps its own
   * default (`auto`), byte-identical to not setting the option.
   *
   * SESSION-LEVEL, NOT PER QUERY. It is applied as a connection parameter
   * (`options=-c plan_cache_mode=...`) when the pool opens a connection, so it
   * is in force for that connection's very first statement and persists for its
   * whole life: every pooled checkout, `$transaction`, stream and pipeline on
   * that connection inherits it, and it is NOT reset between checkouts. A
   * caller's own `SET` / `SET LOCAL` still overrides it for that session or
   * transaction, exactly as it would over any other session default.
   *
   * POSTGRES-ONLY. Engines whose dialect does not report
   * `supportsPlanCacheMode` throw {@link UnsupportedFeatureError} (E017) at
   * construction. The capability flag can only speak for the DIALECT, though,
   * and `plan_cache_mode` is PostgreSQL 12+: a Postgres wire-compatible engine
   * driven through the default `postgresDialect` (CockroachDB, YugabyteDB, an
   * older server) has no such setting, and rejects the connection parameter
   * itself with `unrecognized configuration parameter` at the first checkout
   * rather than with E017. Leave the option unset on those.
   *
   * EXTERNAL POOLS ARE NOT TOUCHED. When the caller supplies `pool`, they own
   * connection lifecycle, and Turbine has no hook that runs on their
   * connections without also mutating a pool it does not own. Same rule as the
   * type parsers above. The option is then a no-op on that pool, with a
   * dev-mode warning; a serverless/HTTP driver should set the GUC in its own
   * connection setup. Turbine-OWNED string `replicas` are still Turbine's own
   * connections and do get it, even next to an external primary, so setting it
   * in that shape splits the policy between reads and writes.
   *
   * BEHIND A CONNECTION POOLER, the GUC travels as a connection-time `options`
   * startup parameter, which a pooler may refuse to pass through (PgBouncer's
   * `ignore_startup_parameters`). Set it on the role or server there
   * (`ALTER ROLE ... SET plan_cache_mode = ...`) instead.
   */
  planCacheMode?: PlanCacheMode;
  /**
   * Refuse a nested `connect` / `connectOrCreate` that would re-parent a
   * to-many child already owned by a different parent. Off by default,
   * because it changes the outcome of writes that currently succeed.
   *
   * Worth turning on for any multi-tenant application: without it, a handler
   * that forwards a client-supplied id into a nested connect lets a caller
   * take another tenant's row. See
   * {@link import('./nested-write.js').NestedWriteContext.scopedConnect}.
   */
  scopedConnect?: boolean;
  /**
   * Default strategy for resolving `with`-clause relations, applied to every
   * `findMany`/`findUnique`/`findFirst` unless overridden per query.
   *
   *   - `'join'`: one SQL statement using correlated
   *     `json_agg(json_build_object(...))` subqueries. On PowDB, `'join'` opts
   *     into native server-side joins where eligible instead.
   *   - `'batched'`: run the base query, then one flat follow-up query per
   *     relation (`WHERE fk = ANY($1)`), stitching children client-side. Wins
   *     when child FK columns are unindexed or result sets are large.
   *   - `'auto'` (the SQL-engine default since 0.41): per relation, use `'join'`
   *     unless the introspected metadata PROVES the probe columns are unindexed,
   *     in which case that relation falls back to the batched loader. Needs
   *     DB-backed index metadata (a generated / introspected client); a
   *     code-first `defineSchema`-only client behaves exactly like `'join'`.
   *     Output shape is identical to `'join'`. See {@link RelationLoadStrategy}.
   *
   * Precedence: per-query `relationLoadStrategy` arg > this config > the engine
   * default. On SQL engines the default is `'auto'`; on PowDB the default is the
   * batched loaders (an ineligible relation falls back to them silently even
   * under `'join'`; `'auto'` resolves to PowDB's own default).
   */
  relationLoadStrategy?: RelationLoadStrategy;
  /**
   * When `true`, every to-many `with` relation with no explicit `orderBy` is
   * loaded ordered by the target table's primary key ascending, so unordered
   * child arrays come back deterministically (json_agg / the batched loaders
   * otherwise leave that order engine-dependent, and `'auto'` fallback can change
   * it). An explicit per-relation `orderBy` always wins; a per-query
   * `stableRelationOrder` overrides this. Default `false` (SQL is byte-identical
   * when off). SQL engines only. See {@link RelationLoadStrategy}.
   */
  stableRelationOrder?: boolean;
  /**
   * When `true`, a `findMany` that paginates (`limit` / `take` / `offset`) but
   * declares no `orderBy` is ordered by the table's primary key ascending
   * (every column of a composite PK, in declaration order). An unordered
   * `LIMIT` is non-deterministic: the same query can return different rows once
   * the heap changes underneath it, so a row may appear on two pages or on
   * none. An explicit `orderBy` always wins, PK-less tables are left alone, and
   * `distinct` / `cursor` shapes are skipped.
   *
   * Default `false` in core, because switching it on would add an `ORDER BY` to
   * SQL that existing applications already emit, changing both the rows a page
   * returns and the plan the engine picks: a silent behavior change that waits
   * for a major. `turbine-orm/prisma-compat` defaults it ON instead, since
   * reproducing Prisma's semantics is that layer's contract. With it off the
   * emitted SQL is byte-identical to before, and a dev-mode warning points at
   * the affected queries.
   */
  implicitPkOrdering?: boolean;
  /**
   * Parent-row ceiling for the `relationLoadStrategy: 'auto'` to-one rule: a
   * to-one relation stays in the single-statement join when the query's `limit`
   * bounds the parent set at or under this many rows, and loads batched when the
   * query is unbounded or bounded above it. Defaults to 1000 (see
   * `AUTO_TO_ONE_JOIN_MAX_ROWS`). Only consulted under `'auto'`.
   */
  autoToOneJoinMaxRows?: number;
  /**
   * Round-trip time to the database, in milliseconds, used to DERIVE the
   * `relationLoadStrategy: 'auto'` to-one threshold instead of guessing a row
   * count. Prefer this over `autoToOneJoinMaxRows`: the break-even between the
   * single-statement join and the batched follow-up is
   * `roundTripMs / AUTO_JOIN_PENALTY_MS_PER_ROW`, and measurement shows the
   * per-row penalty is a constant of the plan while the break-even moves ~17x
   * between a loopback link and a 2.7ms one. Set it to what `ping` says (a
   * Unix socket is ~0.05, same-region managed Postgres ~0.5-2, cross-region
   * ~30-60). Defaults to `AUTO_ASSUMED_ROUND_TRIP_MS` (0.7ms, same-region),
   * which reproduces the historical 1000-row threshold exactly. Overridden by
   * an explicit `autoToOneJoinMaxRows`; only consulted under `'auto'`.
   */
  autoRoundTripMs?: number;
  /**
   * How nested-relation subqueries encode each row's JSON.
   *
   *   - `'object'` (default), `json_agg(json_build_object('key', v, …))`. Every
   *     key name is repeated in every nested object of every row.
   *   - `'positional'`, `json_agg(json_build_array(v, …))`. Turbine knows the
   *     column order at build time, so it emits a key-less array and maps
   *     positions back to keys client-side. Same information, a fraction of the
   *     bytes on wide/deeply-nested `with` trees. Parsed output is byte-identical
   *     to `'object'`.
   *
   * Postgres-only in v1: setting `'positional'` on a non-Postgres engine throws
   * `UnsupportedFeatureError` (E017) when a `with` clause is present. Default:
   * `'object'` (today's behavior, byte-unchanged).
   */
  jsonEncoding?: 'object' | 'positional';
  /**
   * Controls how `NotFoundError` (and other where-aware errors) format their
   * messages.
   *
   *   - `'safe'`    (default): the message includes only the keys of the where
   *     clause (e.g. `where: { id, email }`). Values are redacted to avoid
   *     leaking PII into error logs (Sentry, Datadog, etc.).
   *   - `'verbose'`: the message includes the full JSON-serialized where
   *     clause (e.g. `where: {"id":1,"email":"alice@x.com"}`).
   *
   * The full `where` object is always available as `err.where` for
   * programmatic access regardless of mode.
   */
  errorMessages?: ErrorMessageMode;
  /**
   * Whether `$on('query')` listeners receive the real bound parameter values.
   *
   * Off by default: every entry of `event.params` is replaced with
   * `'[REDACTED]'` before any listener sees it, so query logs cannot carry
   * user data into a log sink.
   *
   * This is an alias with a discoverable name, NOT a second switch. The
   * redaction has always been governed by {@link errorMessages}, which nobody
   * looks under when they want to see query params. Resolution order, single
   * source of truth: when `logQueryParams` is set it decides; otherwise
   * `errorMessages: 'verbose'` reveals params exactly as it did before. So
   * `logQueryParams: true` with `errorMessages: 'safe'` shows params in query
   * events while keeping error MESSAGES redacted, which is the combination
   * that was previously unreachable.
   */
  logQueryParams?: boolean;
  /**
   * Enable prepared statements. Queries are submitted with `{ name, text, values }`
   * to the pg driver, which caches the parse+plan on the server per connection.
   *
   * Default: `true` for Turbine-owned pools, `false` for external pools (serverless
   * drivers may not support named statements).
   *
   * Override with `TURBINE_DISABLE_PREPARED=1` env var.
   */
  preparedStatements?: boolean;
  /**
   * Enable the SQL template cache. Repeated queries with the same shape reuse
   * cached SQL text instead of rebuilding from scratch.
   *
   * Default: `true`. Set to `false` as a nuclear kill switch.
   */
  sqlCache?: boolean;
  /**
   * Maximum number of distinct SQL templates each per-table LRU cache retains.
   *
   * Default: `1000`. Values are parameterized (`$1, $2, …`) and never fragment
   * the cache, so this bounds distinct query SHAPES. Raise it for apps with a
   * very large surface of query shapes to lift the hit rate at the cost of
   * memory; lower it to cap memory. `0` disables caching entirely (identical to
   * `sqlCache: false`); a negative value is ignored (treated as the default).
   */
  sqlCacheSize?: number;
  /** SQL dialect implementation. Defaults to PostgreSQL. Internal Phase-1 seam for dialect packages. */
  dialect?: Dialect;
  /**
   * Read replicas. When set, read-only operations issued outside a transaction
   * (`findMany`, `findFirst`, `findUnique`, `*OrThrow`, `count`, `aggregate`,
   * `groupBy`, `findManyStream`) are round-robin load-balanced across these
   * pools; the primary handles them along with every write. ALL writes,
   * `$transaction` bodies, `pipeline`, `raw`/`sql`, `$listen`/`$notify`, and
   * observability flushes always use the primary.
   *
   *   - `string` entries are connection strings, Turbine constructs an owned
   *     `pg.Pool` for each (same pool-tuning knobs as the primary, and the same
   *     one-time, constructor-gated type-parser registration). `disconnect()`
   *     closes them.
   *   - `PgCompatPool` entries are external pools (Neon, Vercel, a shared
   *     `pg.Pool`), Turbine registers no type parsers on them and never ends
   *     them; the caller owns their lifecycle.
   *
   * Use `client.$primary()` to get a view of the client that pins every
   * operation (reads included) to the primary, e.g. to read your own write
   * without replication lag. Omitting `replicas` (or passing `[]`) leaves the
   * default single-pool path completely unchanged.
   */
  replicas?: readonly (string | PgCompatPool)[];
  /**
   * Automatic WHERE filters applied to every query, keyed by table accessor
   * (`db[name]`). Each value is AND-merged into the compiled WHERE of every
   * read and mutation on that table, and into every relation subquery that
   * targets it, implementing soft-delete and multi-tenancy without repeating
   * the predicate at each call site.
   *
   *   - A `WhereClause` value is a static filter (e.g. `{ deletedAt: null }`).
   *   - A `() => WhereClause` value is evaluated at query-build time, so a
   *     closure over per-request state (the current tenant id) yields a
   *     request-scoped filter.
   *
   * `create`/`createMany` are never filtered. A per-query
   * `skipGlobalFilters: true | string[]` opts out. The empty-`where` guard on
   * `update`/`delete` still checks the USER-supplied `where`, so a global
   * filter never turns an unguarded mass mutation into an allowed one.
   *
   * @example
   * ```ts
   * const db = turbine({ url, schema, globalFilters: {
   *   posts: { deletedAt: null },              // soft-delete
   *   orders: () => ({ tenantId: currentTenant() }), // per-request tenancy
   * }});
   * ```
   */
  globalFilters?: GlobalFilters;
}

// ---------------------------------------------------------------------------
// Unknown-config-key diagnostics
// ---------------------------------------------------------------------------

/**
 * Every `TurbineConfig` key, as runtime data. TypeScript erases the interface,
 * so the key set has to exist as a value; `Record<keyof TurbineConfig, true>`
 * makes the compiler own it in BOTH directions: a field added to the interface
 * fails typecheck until it is listed here, and a key listed here that is not a
 * field fails as an excess property. So this can never drift into warning about
 * a real option.
 */
const TURBINE_CONFIG_KEYS: Record<keyof TurbineConfig, true> = {
  pool: true,
  connectionString: true,
  host: true,
  port: true,
  database: true,
  user: true,
  password: true,
  ssl: true,
  poolSize: true,
  idleTimeoutMs: true,
  connectionTimeoutMs: true,
  max: true,
  idleTimeoutMillis: true,
  connectionTimeoutMillis: true,
  logging: true,
  defaultLimit: true,
  warnOnUnlimited: true,
  utcTimestamps: true,
  temporalInfinity: true,
  planCacheMode: true,
  scopedConnect: true,
  relationLoadStrategy: true,
  stableRelationOrder: true,
  implicitPkOrdering: true,
  autoToOneJoinMaxRows: true,
  autoRoundTripMs: true,
  jsonEncoding: true,
  errorMessages: true,
  logQueryParams: true,
  preparedStatements: true,
  sqlCache: true,
  sqlCacheSize: true,
  dialect: true,
  replicas: true,
  globalFilters: true,
};

/**
 * {@link TURBINE_CONFIG_KEYS} as a lookup. A `Set` rather than an `in` test on
 * the record, so an inherited `Object.prototype` name (`toString`, `constructor`)
 * is treated as the unknown key it is.
 */
const CONFIG_KEY_SET: ReadonlySet<string> = new Set(Object.keys(TURBINE_CONFIG_KEYS));

/**
 * Keys that are legitimately present on a config object but are not public
 * `TurbineConfig` fields:
 *
 *   - `queryInterfaceFactory`: the non-SQL-backend seam. `turbinePowDB` sets it
 *     through a cast so `table()` builds a `PowqlInterface`; it is `@internal`,
 *     deliberately absent from the public interface, and must not warn.
 *   - `schema`: `turbine.config.*` files carry a Postgres schema NAME for the
 *     CLI, and that same object is routinely spread into the client factory.
 *     The client ignores it (its schema metadata is the second argument), and
 *     shouting about a documented CLI field would be pure noise.
 *   - `url`: the connection-string spelling used by the CLI config and by the
 *     engine factories' first argument. Same story as `schema`.
 */
const NON_CONFIG_KEYS: ReadonlySet<string> = new Set(['queryInterfaceFactory', 'schema', 'url']);

/** camelCase name → its lowercased words (`logQueryParams` → log, query, params). */
function camelWords(name: string): string[] {
  return name
    .split(/(?=[A-Z])/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

/**
 * The real config key `key` most likely meant, or null when nothing is close.
 *
 * {@link closestName} (the same helper the unknown-COLUMN message uses) decides
 * first, so both diagnostics rank near-misses identically. It is bounded by edit
 * distance, which covers typos but not the miss this warning exists for: a
 * guessed name that omits a whole word. `logParams` is five edits from
 * `logQueryParams`, past the bound, yet it names the same words in the same
 * order, so a second pass accepts a candidate whose camelCase words CONTAIN the
 * guess's words in order, preferring the one that adds fewest words.
 */
function suggestConfigKey(key: string): string | null {
  const direct = closestName(key, CONFIG_KEY_SET);
  if (direct) return direct;
  const wanted = camelWords(key);
  if (wanted.length < 2) return null;
  let best: string | null = null;
  let bestExtra = Number.POSITIVE_INFINITY;
  for (const candidate of CONFIG_KEY_SET) {
    const words = camelWords(candidate);
    if (words.length <= wanted.length) continue;
    let i = 0;
    for (const w of words) if (w === wanted[i]) i++;
    if (i !== wanted.length) continue;
    const extra = words.length - wanted.length;
    if (extra < bestExtra) {
      bestExtra = extra;
      best = candidate;
    }
  }
  return best;
}

/**
 * Dev-mode notice for a key on the config object that is not part of the config
 * surface.
 *
 * An unknown key is silently ignored (JavaScript objects have no schema), which
 * makes a typo or a wrong guess indistinguishable from a broken feature: a
 * caller who wants query parameters in `$on('query')` events and reaches for a
 * plausible-sounding `logParams` sees nothing happen and concludes the feature
 * does not work, rather than that the option is spelled `logQueryParams`.
 *
 * Deliberately a warning, never an error. An app compiled against a NEWER
 * turbine that passes a key this version has not heard of must keep running,
 * and the whole check is wrapped so that a hostile / exotic config object
 * (a Proxy whose `ownKeys` throws) cannot take down the constructor either.
 * Dev-only (`NODE_ENV !== 'production'`) and once per key per process, like the
 * other advisory diagnostics.
 */
function warnUnknownConfigKeys(config: TurbineConfig): void {
  if (process.env.NODE_ENV === 'production') return;
  try {
    for (const key of Object.keys(config)) {
      if (CONFIG_KEY_SET.has(key) || NON_CONFIG_KEYS.has(key)) continue;
      if (!shouldWarnOnce(WARN_NS.unknownConfigKey, key)) continue;
      const suggestion = suggestConfigKey(key);
      console.warn(
        `[turbine] Unknown option "${key}" in the config passed to TurbineClient, it is ignored.` +
          (suggestion ? ` Did you mean "${suggestion}"?` : ''),
      );
    }
  } catch {
    // Key enumeration is the only thing that can fail here, and a diagnostic
    // must never be the reason a client fails to construct.
  }
}

// ---------------------------------------------------------------------------
// Middleware types
// ---------------------------------------------------------------------------

/** Parameters passed to middleware functions */
export interface MiddlewareParams {
  /** The table/model being queried (e.g. 'users') */
  model: string;
  /** The operation being performed (e.g. 'findUnique', 'create', 'update') */
  action: string;
  /** The arguments passed to the query method */
  args: Record<string, unknown>;
}

/** The next function in the middleware chain */
export type MiddlewareNext = (params: MiddlewareParams) => Promise<unknown>;

/** A middleware function that intercepts queries */
export type Middleware = (params: MiddlewareParams, next: MiddlewareNext) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Transaction types
// ---------------------------------------------------------------------------

export interface TransactionOptions {
  /** Timeout in ms, transaction will be rolled back if exceeded */
  timeout?: number;
  /** Isolation level for the transaction */
  isolationLevel?: 'ReadUncommitted' | 'ReadCommitted' | 'RepeatableRead' | 'Serializable';
  /**
   * Transaction-local session GUCs to set after BEGIN. The canonical use case
   * is multi-tenant Postgres row-level security (RLS): your policies filter on
   * `current_setting('app.current_tenant')`, and you set that value here so
   * every query inside the transaction sees it.
   *
   * Each entry is applied via `SELECT set_config($1, $2, true)`, `is_local=true`
   * scopes the value to this transaction, so it auto-resets on COMMIT/ROLLBACK
   * and never leaks onto the pooled connection. Both the name and value are
   * bound parameters (never interpolated); the GUC name is additionally
   * validated against a strict identifier regex.
   *
   * @example
   * ```ts
   * await db.$transaction(
   *   async (tx) => {
   *     // every query here sees current_setting('app.current_tenant') = '42'
   *     return tx.invoices.findMany();
   *   },
   *   { sessionContext: { 'app.current_tenant': '42', 'app.current_user': userId } },
   * );
   * ```
   */
  sessionContext?: Record<string, string | number | boolean>;
}

/** Maps isolation level names to SQL */
const ISOLATION_LEVELS: Record<string, string> = {
  ReadUncommitted: 'READ UNCOMMITTED',
  ReadCommitted: 'READ COMMITTED',
  RepeatableRead: 'REPEATABLE READ',
  Serializable: 'SERIALIZABLE',
};

/**
 * Strict GUC (session variable) name: an optionally namespaced identifier such
 * as `app.current_tenant` or `search_path`. Even though the name is passed as a
 * bound parameter to `set_config`, a malformed name is a programmer error worth
 * rejecting loudly before it reaches the database.
 */
const GUC_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/**
 * The read-only `QueryInterface` operations that a read-replica setup may route
 * to a replica pool. Every other method (all writes, plus internals) stays on
 * the primary. Kept as a Set so the routing proxy's `get` trap is O(1).
 */
const READ_OPERATIONS: ReadonlySet<string> = new Set([
  'findMany',
  'findFirst',
  'findUnique',
  'findFirstOrThrow',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'findManyStream',
]);

/**
 * Internal marker on the config object that tells the `TurbineClient`
 * constructor to build a lightweight "primary-only" view sharing an existing
 * client's primary pool, dialect, query options, and middleware, instead of
 * creating a fresh pool. Produced solely by `$primary()`; never public.
 */
const PRIMARY_VIEW = Symbol('turbine.primaryView');

interface PrimaryViewSeed {
  parent: TurbineClient;
}

// ---------------------------------------------------------------------------
// TransactionClient, provides typed table accessors within a transaction
// ---------------------------------------------------------------------------

/**
 * A transaction-scoped client that provides the same table accessor API as TurbineClient.
 * All queries run on a dedicated connection within a BEGIN/COMMIT block.
 * Supports nested transactions via SAVEPOINTs.
 */
export class TransactionClient {
  private readonly tableCache = new Map<string, QueryInterface<object>>();
  private savepointCounter = 0;
  /** Active SQL dialect, owns savepoint keywords and raw-SQL placeholders. */
  private readonly dialect: Dialect;

  constructor(
    private readonly client: pg.PoolClient,
    readonly schema: SchemaMetadata,
    private readonly middlewares: Middleware[],
    private readonly queryOptions?: QueryInterfaceOptions,
    /**
     * The parent pool this transaction runs on. Only its `readonly` and
     * `capabilities` are read (both PowDB-only flags), so the transaction-scoped
     * proxy pool built by {@link createTxPool} carries them through: without this
     * a read-only client's `$transaction` writes bypass the E018 guard, and an
     * older-engine client falls back to ALL_POWDB_CAPABILITIES inside the tx
     * (emitting join PowQL a pre-0.13 engine rejects). Undefined / absent flags
     * for a plain pg pool leave the proxy unchanged.
     */
    private readonly sourcePool?: { readonly readonly?: boolean; readonly capabilities?: unknown },
  ) {
    this.dialect = queryOptions?.dialect ?? postgresDialect;
    // Auto-create typed table accessors for all tables in the schema
    for (const tableName of Object.keys(schema.tables)) {
      const camelName = tableName.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      if (!(camelName in this)) {
        Object.defineProperty(this, camelName, {
          get: () => this.table(tableName),
          enumerable: true,
        });
      }
    }
  }

  /**
   * Get a QueryInterface for a table within this transaction.
   * Uses the dedicated transaction connection instead of the pool.
   */
  table<T extends object = Record<string, unknown>>(name: string): QueryInterface<T> {
    let qi = this.tableCache.get(name);
    if (!qi) {
      // Create a QueryInterface that uses the transaction client as its "pool"
      // We use a proxy pool that routes queries through the transaction client
      const txPool = this.createTxPool();
      const txOpts = { ...this.queryOptions, _txScoped: true };
      qi = txOpts.queryInterfaceFactory
        ? txOpts.queryInterfaceFactory(txPool, name, this.schema, this.middlewares, txOpts)
        : new QueryInterface<object>(txPool, name, this.schema, this.middlewares, txOpts);
      this.tableCache.set(name, qi);
    }
    return qi as QueryInterface<T>;
  }

  /**
   * Execute a nested transaction via SAVEPOINT.
   * If the inner function throws, only the savepoint is rolled back.
   */
  async $transaction<R>(fn: (tx: TransactionClient) => Promise<R>): Promise<R> {
    const savepointName = `sp_${++this.savepointCounter}`;
    await this.client.query(this.dialect.savepointStatement(savepointName));
    try {
      const result = await fn(this);
      await this.client.query(this.dialect.releaseSavepointStatement(savepointName));
      return result;
    } catch (err) {
      await this.client.query(this.dialect.rollbackToSavepointStatement(savepointName));
      throw err;
    }
  }

  /**
   * Execute a raw SQL query within this transaction.
   */
  async raw<T extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]> {
    let sql = '';
    strings.forEach((str, i) => {
      sql += str;
      if (i < values.length) {
        sql += this.dialect.paramPlaceholder(i + 1);
      }
    });
    try {
      const result = await this.client.query(sql, values);
      return result.rows as T[];
    } catch (err) {
      throw wrapPgError(err);
    }
  }

  /**
   * @internal The `turbine-orm/prisma-compat` adapter's transaction seam. NOT
   * application API: use {@link raw}, whose tagged template makes concatenating
   * a value into the SQL text impossible. This method takes the SQL text as a
   * plain string, so the escaping discipline moves to the caller, which is
   * exactly the property the typed-SQL escape hatch exists to remove. It is
   * documented and kept structurally stable only because the compat adapter
   * detects it by shape (`typeof tx.rawQuery === 'function'`) and refuses to
   * run compat raw SQL on a pool connection when it is missing.
   *
   * Execute an already-parameterized statement on THIS transaction's own
   * connection, returning the driver's `{ rows, rowCount }` pair. It differs
   * from {@link raw} in two ways the adapter needs: it takes a prebuilt
   * `(text, params)` pair rather than a tagged template (the placeholder
   * numbering is the caller's, so nested `Prisma.sql` fragments can be
   * flattened first), and it surfaces `rowCount` so an `$executeRaw`-style call
   * can report affected rows.
   *
   * The statement runs on the transaction's dedicated connection, so it is
   * inside the same BEGIN/COMMIT (and any active SAVEPOINT) as every other
   * statement in the callback. Driver errors are translated by `wrapPgError`,
   * exactly as pool-scoped and table-scoped queries are. Like {@link raw}, it
   * emits no `$on('query')` event and runs no middleware.
   */
  async rawQuery<T extends object = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: T[]; rowCount: number | null }> {
    try {
      const result = await this.client.query(text, params as unknown[]);
      return { rows: result.rows as T[], rowCount: result.rowCount };
    } catch (err) {
      throw wrapPgError(err);
    }
  }

  /**
   * Create a pool-like wrapper around the transaction client.
   * This allows QueryInterface to work with the transaction connection
   * without knowing it's in a transaction.
   *
   * pg driver errors thrown by queries are translated into typed Turbine
   * errors via wrapPgError so transaction-scoped queries surface the same
   * typed errors as pool-scoped queries.
   */
  private createTxPool(): pg.Pool {
    const client = this.client;
    // Return a minimal pool-compatible object that routes queries
    // through the transaction client
    const txPool: Record<string, unknown> = {
      query: async (textOrConfig: string | { name?: string; text: string; values?: unknown[] }, values?: unknown[]) => {
        try {
          if (typeof textOrConfig === 'string') {
            return await client.query(textOrConfig, values);
          }
          // Object form for prepared statements: { name, text, values }
          // pg.PoolClient.query accepts QueryConfig but the overloads make TS
          // unhappy with the union, so we cast through unknown.
          return await (client as unknown as { query(config: unknown): Promise<pg.QueryResult> }).query(textOrConfig);
        } catch (err) {
          throw wrapPgError(err);
        }
      },
      connect: () => Promise.resolve(client),
    };
    // Carry the parent pool's PowDB-only flags through so a transaction-scoped
    // PowqlInterface reads the same read-only guard and capabilities it would
    // outside the transaction (a plain pg pool has neither, so nothing changes).
    if (this.sourcePool?.readonly !== undefined) txPool.readonly = this.sourcePool.readonly;
    if (this.sourcePool?.capabilities !== undefined) txPool.capabilities = this.sourcePool.capabilities;
    return txPool as unknown as pg.Pool;
  }
}

// ---------------------------------------------------------------------------
// TurbineClient
// ---------------------------------------------------------------------------

export class TurbineClient {
  /** The underlying pg.Pool, exposed for escape hatches */
  readonly pool: pg.Pool;

  /** The schema metadata this client was built from */
  readonly schema: SchemaMetadata;

  private static int8ParserRegistered = false;
  /**
   * The `utcTimestamps` value the FIRST TurbineClient in this process settled
   * on, or `undefined` while none has been constructed yet.
   *
   * `pg.types.setTypeParser` is process-global by nature: there is one parser
   * per OID for the whole pg module, so the READ side of `utcTimestamps` cannot
   * be per client the way the WRITE side is. Recording the settled value (not
   * just "registered yes/no") is what lets the constructor detect a second
   * client asking for the opposite and refuse it, instead of handing back a
   * client whose reads and writes disagree. Every client records it, including
   * one on an external pool, which registers nothing but still READS through
   * whatever an owned client in the same process installed. See
   * {@link assertUtcTimestampsAgree}.
   */
  private static utcTimestampParserMode: boolean | undefined;
  /**
   * Whether the zone-less temporal read parsers (OIDs 1114, 1082, 1115, 1182)
   * have actually been installed. Separate from
   * {@link utcTimestampParserMode}, which every client settles: only an OWNED
   * pool registers, so a client on an external pool must not make a later
   * owned client skip registration.
   */
  private static utcTimestampParsersRegistered = false;
  private readonly logging: boolean;
  /** Active SQL dialect, owns transaction keywords, set_config, raw-SQL placeholders, capability flags. */
  private readonly dialect: Dialect;
  /** Validated `plan_cache_mode` to pin on every owned connection, or undefined to issue nothing. */
  private readonly planCacheMode: PlanCacheMode | undefined;
  private readonly tableCache = new Map<string, QueryInterface<object>>();
  private readonly middlewares: Middleware[] = [];
  private readonly queryListeners = new Set<QueryEventListener>();
  private queryOptions: QueryInterfaceOptions;
  private readonly errorMessagesSafe: boolean;
  /** Whether `$on('query')` events carry real params (see `logQueryParams`). */
  private readonly queryParamsVisible: boolean;
  /** True when Turbine created the pool and is responsible for tearing it down */
  private readonly ownsPool: boolean = true;
  /** Active LISTEN subscriptions, torn down on disconnect() so it never hangs */
  private readonly activeSubscriptions = new Set<ActiveSubscription>();

  /**
   * Read-replica pools in round-robin order. Empty when no replicas are
   * configured, in which case `table()` takes the original single-pool path.
   */
  private readonly replicaPools: PgCompatPool[];
  /**
   * The subset of {@link replicaPools} that Turbine created from connection
   * strings and must close on `disconnect()`. External replica pools are not
   * listed here (caller owns their lifecycle).
   */
  private readonly ownedReplicaPools: PgCompatPool[];
  /** Rotating index for round-robin replica selection (advances per read op). */
  private replicaCursor = 0;
  /** Per-replica `table → QueryInterface` caches, indexed like {@link replicaPools}. */
  private readonly replicaTableCaches: Array<Map<string, QueryInterface<object>>>;
  /** Cache of per-table routing proxies (only used when replicas are present). */
  private readonly routingProxyCache = new Map<string, QueryInterface<object>>();
  /** Lazily-built, cached primary-only view returned by {@link $primary}. */
  private primaryView?: TurbineClient;

  constructor(config: TurbineConfig = {}, schema: SchemaMetadata) {
    // Primary-only view: $primary() constructs this to share the parent's
    // primary pool + derived state instead of creating a fresh pool. It owns
    // no pool and no replicas, so every operation (reads included) runs on the
    // primary and disconnect() is a no-op on the shared pool.
    const seed = (config as Record<PropertyKey, unknown>)[PRIMARY_VIEW] as PrimaryViewSeed | undefined;
    if (seed) {
      const parent = seed.parent;
      this.schema = schema;
      this.logging = parent.logging;
      this.dialect = parent.dialect;
      this.errorMessagesSafe = parent.errorMessagesSafe;
      this.queryParamsVisible = parent.queryParamsVisible;
      this.queryOptions = parent.queryOptions;
      this.middlewares = parent.middlewares; // shared reference: $use on parent flows through
      this.pool = parent.pool;
      this.ownsPool = false;
      this.replicaPools = [];
      this.ownedReplicaPools = [];
      this.replicaTableCaches = [];
      for (const tableName of Object.keys(schema.tables)) {
        const camelName = tableName.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
        if (!(camelName in this)) {
          Object.defineProperty(this, camelName, {
            get: () => this.table(tableName),
            enumerable: true,
          });
        }
      }
      return;
    }
    // Constructing without schema metadata previously crashed deep in the
    // constructor with an opaque "Cannot read properties of undefined
    // (reading 'tables')". Fail fast with an actionable message instead.
    if (!schema || typeof schema !== 'object' || !schema.tables) {
      // A `defineSchema()` result is the most common wrong shape here: it is a
      // SchemaDef (`{ tables: { users: { columns: { id: ... } } } }`-ish builder
      // output), not runtime SchemaMetadata, so name the conversion rather than
      // just the requirement.
      const looksLikeSchemaDef =
        schema !== null && typeof schema === 'object' && Object.hasOwn(schema as object, 'name') === false;
      throw new ValidationError(
        '[turbine] TurbineClient requires schema metadata as its second argument. ' +
          'Run `npx turbine generate` and use the generated client (`turbine()` from your output dir), ' +
          'or pass the generated `schemaMetadata` object: new TurbineClient(config, schemaMetadata).' +
          (looksLikeSchemaDef
            ? ' If you have a `defineSchema()` result, convert it first with `schemaDefToMetadata(def)`.'
            : ''),
      );
    }
    // A wrong-SHAPED schema (a `defineSchema()` result, whose tables carry no
    // `columns` array) used to survive this check and die later as
    // `TypeError: this.tableMeta.columns is not iterable`, several frames from
    // the cause. Validate one table's shape here, where the fix is obvious.
    for (const [name, meta] of Object.entries(schema.tables)) {
      if (!meta || typeof meta !== 'object' || !Array.isArray((meta as { columns?: unknown }).columns)) {
        throw new ValidationError(
          `[turbine] Table "${name}" in the schema passed to TurbineClient has no \`columns\` array, so this is ` +
            'not runtime SchemaMetadata. A `defineSchema()` result is a SchemaDef: convert it with ' +
            '`schemaDefToMetadata(def)`, or use the metadata emitted by `npx turbine generate`.',
        );
      }
      break;
    }
    // Name any key on the config object that is not part of the config surface
    // (dev only, once per key, never throws). See warnUnknownConfigKeys.
    warnUnknownConfigKeys(config);
    // ALL config validation runs before ANY process-global side effect below.
    // A constructor that throws must leave the process exactly as it found it:
    // settling the process-global parser mode and then rejecting the config
    // would poison the next, valid, TurbineClient with a phantom conflict.
    const dialect = config.dialect ?? postgresDialect;
    const planCacheMode = TurbineClient.resolvePlanCacheMode(config.planCacheMode, dialect);
    /**
     * Parse int8 (bigint, OID 20) as JavaScript number instead of string.
     * Safe for values up to Number.MAX_SAFE_INTEGER (9,007,199,254,740,991).
     *
     * NOTE: For values exceeding Number.MAX_SAFE_INTEGER, the parser falls back
     * to returning the raw string to avoid precision loss. The generated TypeScript
     * type maps int8/bigint to `number`, which is correct for the vast majority of
     * use cases (IDs, counts, timestamps). If you store values > 2^53 - 1 in a
     * bigint column, the runtime return type will be `string` for those rows.
     *
     * NOTE: We intentionally do NOT register a parser for numeric (OID 1700).
     * Postgres numeric is arbitrary-precision, so the default pg driver behavior
     * of returning a string is correct and matches the generated TypeScript type
     * (numeric → string). Users who want number can cast explicitly in SQL.
     */
    // Only register the int8 parser when the PRIMARY pool is Turbine-owned.
    // External pools (Neon HTTP, Vercel Postgres) may ship their own pg-types
    // fork and rely on their own parser configuration, registration is
    // process-global, so flipping it because a string replica exists alongside
    // an external primary would silently change the external primary's parsing
    // too. String replicas configured next to an external primary therefore
    // inherit the caller's parser configuration (documented). Registration is
    // constructor-gated by the static flags, so it happens at most once.
    const ownsAnyPool = !config.pool;
    if (ownsAnyPool && !TurbineClient.int8ParserRegistered) {
      warnParserOverwrite(20, 'int8');
      pg.types.setTypeParser(
        20,
        markTurbineParser((val: string) => {
          const n = Number(val);
          return Number.isSafeInteger(n) ? n : val;
        }),
      );
      TurbineClient.int8ParserRegistered = true;
    }
    // Parse the zone-less temporal types (`timestamp` OID 1114, `date` OID
    // 1082, and their array forms 1115 / 1182) as UTC instead of local time. The
    // pg driver's default hands back a Date built in the process's local zone,
    // so the same row yields a different instant per deployment region. The
    // ORM convention (Prisma, Rails, Django), and the only interpretation
    // that round-trips what Postgres stores, is UTC. Same ownership rule as
    // the int8 parser: never mutate parser state on external pools.
    //
    // Read registration is process-global and one-shot; the WRITE side of the
    // same flag is per client (query/writes.ts). Two clients disagreeing about
    // it therefore cannot both be served, so the disagreement is refused here
    // rather than resolved silently into a client that does not round-trip.
    //
    // The AGREEMENT check runs for EVERY client, owned pool or not. Only an
    // owned pool ever REGISTERS the parsers, but once any client has registered
    // them every client in the process reads through them, including one on an
    // external pool: it would then read UTC while its own per-client write half
    // still rendered local literals, which on a `date` column walks the stored
    // calendar day backwards one day per read-modify-write cycle.
    const wantUtcTimestamps = config.utcTimestamps !== false;
    TurbineClient.assertUtcTimestampsAgree(wantUtcTimestamps);
    if (ownsAnyPool && wantUtcTimestamps && !TurbineClient.utcTimestampParsersRegistered) {
      registerUtcTemporalParsers();
      TurbineClient.utcTimestampParsersRegistered = true;
    }
    TurbineClient.utcTimestampParserMode = wantUtcTimestamps;

    this.logging = config.logging ?? false;
    this.dialect = dialect;
    this.planCacheMode = planCacheMode;
    this.schema = schema;
    // Respect env var kill switch
    const envDisablePrepared = typeof process !== 'undefined' && process.env?.TURBINE_DISABLE_PREPARED === '1';

    this.errorMessagesSafe = (config.errorMessages ?? 'safe') === 'safe';
    // Query-event param visibility. One derived boolean, so the two config
    // spellings can never disagree: `logQueryParams` wins when set, otherwise
    // `errorMessages` keeps deciding exactly as it always has.
    this.queryParamsVisible = config.logQueryParams ?? !this.errorMessagesSafe;

    this.queryOptions = {
      defaultLimit: config.defaultLimit,
      warnOnUnlimited: config.warnOnUnlimited,
      utcTimestamps: config.utcTimestamps,
      temporalInfinity: TurbineClient.resolveTemporalInfinity(config.temporalInfinity),
      scopedConnect: config.scopedConnect,
      relationLoadStrategy: config.relationLoadStrategy,
      stableRelationOrder: config.stableRelationOrder,
      implicitPkOrdering: config.implicitPkOrdering,
      autoToOneJoinMaxRows: config.autoToOneJoinMaxRows,
      autoRoundTripMs: config.autoRoundTripMs,
      jsonEncoding: config.jsonEncoding,
      globalFilters: config.globalFilters,
      preparedStatements: envDisablePrepared ? false : (config.preparedStatements ?? !config.pool),
      sqlCache: config.sqlCache ?? true,
      sqlCacheSize: config.sqlCacheSize,
      dialect: config.dialect,
      // Non-SQL backends (PowDB) inject a factory that builds their own query
      // interface (PowqlInterface) instead of the SQL QueryInterface. SQL engines
      // never set this, so `table()` keeps constructing `new QueryInterface`.
      queryInterfaceFactory: (config as { queryInterfaceFactory?: QueryInterfaceOptions['queryInterfaceFactory'] })
        .queryInterfaceFactory,
      _onQuery: (event: QueryEvent) => {
        if (this.queryListeners.size === 0) return;
        const emitted = this.queryParamsVisible ? event : { ...event, params: event.params.map(() => '[REDACTED]') };
        for (const listener of this.queryListeners) {
          try {
            listener(emitted);
          } catch (e) {
            if (this.logging) console.error('[turbine] Query listener error:', e);
          }
        }
      },
    };

    // Apply NotFoundError message redaction mode (default: safe, values are
    // stripped from messages to avoid leaking PII into error logs).
    if (config.errorMessages) {
      setErrorMessageMode(config.errorMessages);
    }

    if (config.pool) {
      // External pool, use directly. Turbine doesn't manage its lifecycle.
      this.pool = config.pool as unknown as pg.Pool;
      this.ownsPool = false;
      if (this.logging) {
        console.log(`[turbine] Using external pool, ${Object.keys(schema.tables).length} tables`);
      }
    } else {
      const poolConfig: pg.PoolConfig = {
        max: config.poolSize ?? config.max ?? 10,
        idleTimeoutMillis: config.idleTimeoutMs ?? config.idleTimeoutMillis ?? 30_000,
        connectionTimeoutMillis: config.connectionTimeoutMs ?? config.connectionTimeoutMillis ?? 5_000,
      };

      // Did the caller supply ANY explicit connection target? If not, and a
      // DATABASE_URL is present in the environment, fall back to it so
      // `turbine()` with no arguments just works (the convention Prisma/Drizzle
      // use, and what the generated factory JSDoc + `turbine init` promise).
      // We only read the already-populated env var; the library never parses
      // .env files (that is the CLI's job). An explicit host/port/db/user/pass
      // still takes precedence, so this never overrides a deliberate config.
      const hasExplicitConnection =
        config.connectionString != null ||
        config.host != null ||
        config.port != null ||
        config.database != null ||
        config.user != null ||
        config.password != null;

      if (config.connectionString) {
        poolConfig.connectionString = config.connectionString;
      } else if (!hasExplicitConnection && process.env.DATABASE_URL) {
        poolConfig.connectionString = process.env.DATABASE_URL;
      } else {
        poolConfig.host = config.host ?? 'localhost';
        poolConfig.port = config.port ?? 5432;
        poolConfig.database = config.database ?? 'postgres';
        poolConfig.user = config.user ?? 'postgres';
        poolConfig.password = config.password;
      }

      if (config.ssl !== undefined) {
        poolConfig.ssl = config.ssl;
      }

      this.pool = new pg.Pool(TurbineClient.withPlanCacheMode(poolConfig, this.planCacheMode));
      this.ownsPool = true;

      this.pool.on('error', (err) => {
        console.error('[turbine] Unexpected pool error:', err.message);
      });

      if (this.logging) {
        console.log(
          `[turbine] Pool created, max ${poolConfig.max} connections, ${Object.keys(schema.tables).length} tables`,
        );
      }
    }

    // Build read-replica pools (if any). String entries become owned pg.Pools
    // sharing the primary's tuning knobs; PgCompatPool entries are external and
    // used as-is. Replica selection is round-robin in this array order.
    this.replicaPools = [];
    this.ownedReplicaPools = [];
    for (const replica of config.replicas ?? []) {
      if (typeof replica === 'string') {
        const replicaPool = new pg.Pool(
          TurbineClient.withPlanCacheMode(
            {
              connectionString: replica,
              max: config.poolSize ?? config.max ?? 10,
              idleTimeoutMillis: config.idleTimeoutMs ?? config.idleTimeoutMillis ?? 30_000,
              connectionTimeoutMillis: config.connectionTimeoutMs ?? config.connectionTimeoutMillis ?? 5_000,
              ...(config.ssl !== undefined ? { ssl: config.ssl } : {}),
            },
            this.planCacheMode,
          ),
        );
        replicaPool.on('error', (err) => {
          console.error('[turbine] Unexpected replica pool error:', err.message);
        });
        this.replicaPools.push(replicaPool as unknown as PgCompatPool);
        this.ownedReplicaPools.push(replicaPool as unknown as PgCompatPool);
      } else {
        this.replicaPools.push(replica);
      }
    }
    // `planCacheMode` reaches a pool only where Turbine opens the connections.
    // Warned here rather than in the external-pool branch above because the
    // owned string replicas are built after it: with an external primary and
    // owned replicas the option is applied to the replicas and dropped on the
    // primary, and a warning that said it was "ignored" would be false.
    // Deliberate no-op rather than a throw: the option is a performance knob,
    // and an app that moves from an owned pool to a serverless driver should
    // not stop booting over it. Same ownership rule as the type parsers, which
    // also skip external pools silently.
    if (this.planCacheMode !== undefined && !this.ownsPool && process.env.NODE_ENV !== 'production') {
      if (shouldWarnOnce(WARN_NS.planCacheModeIgnored, this.planCacheMode)) {
        const replicaNote =
          this.ownedReplicaPools.length > 0
            ? ` It IS applied to the ${this.ownedReplicaPools.length} Turbine-owned read replica pool(s) on this ` +
              'client, so reads and writes would run under different plan-cache policies until the primary is set too.'
            : '';
        console.warn(
          `[turbine] planCacheMode: '${this.planCacheMode}' was not applied to the primary: this client was given an ` +
            'external `pool`, whose connection lifecycle the caller owns, so Turbine never opens its connections. Set ' +
            `\`plan_cache_mode\` in the driver's own connection setup (or run \`SET plan_cache_mode = ${this.planCacheMode}\` ` +
            `on checkout) instead.${replicaNote}`,
        );
      }
    }
    this.replicaTableCaches = this.replicaPools.map(() => new Map<string, QueryInterface<object>>());
    if (this.logging && this.replicaPools.length > 0) {
      console.log(
        `[turbine] ${this.replicaPools.length} read replica(s) configured (${this.ownedReplicaPools.length} owned)`,
      );
    }

    // Auto-create typed table accessors for all tables in the schema
    for (const tableName of Object.keys(schema.tables)) {
      const camelName = tableName.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      if (!(camelName in this)) {
        Object.defineProperty(this, camelName, {
          get: () => this.table(tableName),
          enumerable: true,
        });
      }
    }

    // Auto-start observability from env var
    const observeUrl = typeof process !== 'undefined' ? process.env?.TURBINE_OBSERVE_URL : undefined;
    if (observeUrl) {
      this.$observe({ connectionString: observeUrl }).catch(() => {});
    }
  }

  /**
   * Validate a caller-supplied `planCacheMode` and refuse it on an engine that
   * has no plan cache to pin.
   *
   * Two refusals, both at construction rather than at first query, so a
   * misconfigured client never opens a connection:
   *
   *   - a value outside {@link PLAN_CACHE_MODES} throws `ValidationError`
   *     (E003). This is the security boundary as well as the usability one: a
   *     GUC value cannot be a bind parameter in either place it can be set (a
   *     `SET` statement or the connection `options` string), so the returned
   *     value is a MEMBER OF THE FROZEN LIST, never the caller's string, and
   *     there is no path by which caller text reaches the connection or the SQL.
   *   - a dialect that does not report `supportsPlanCacheMode` throws
   *     `UnsupportedFeatureError` (E017), in the same style as the other
   *     capability refusals.
   */
  /**
   * Validate the `temporalInfinity` reading. A closed two-value enum, checked
   * at construction so a typo (`'preserved'`, `'raw'`) fails loudly rather than
   * silently falling back to the default reading the caller was trying to
   * change.
   */
  private static resolveTemporalInfinity(
    value: TemporalInfinityReading | undefined,
  ): TemporalInfinityReading | undefined {
    if (value === undefined) return undefined;
    if (value !== 'null' && value !== 'preserve') {
      throw new ValidationError(
        `Invalid temporalInfinity: ${JSON.stringify(value)}. Expected 'preserve' (default: read a Postgres ` +
          'temporal `infinity` as the JS number `Infinity` / `-Infinity`, which round-trips through a write ' +
          "but breaks the declared `Date` type) or 'null' (read it as null, which serializes cleanly but " +
          'makes it indistinguishable from a stored NULL, so a read-modify-write destroys the value).',
      );
    }
    return value;
  }

  private static resolvePlanCacheMode(mode: unknown, dialect: Dialect): PlanCacheMode | undefined {
    if (mode === undefined || mode === null) return undefined;
    const matched = PLAN_CACHE_MODES.find((m) => m === mode);
    if (matched === undefined) {
      throw new ValidationError(
        `[turbine] Invalid planCacheMode: ${JSON.stringify(mode)}. Expected one of ${PLAN_CACHE_MODES.map(
          (m) => `'${m}'`,
        ).join(', ')}.`,
      );
    }
    if (dialect.supportsPlanCacheMode !== true) {
      throw new UnsupportedFeatureError(
        `The planCacheMode option (plan_cache_mode = ${matched})`,
        dialect.name,
        '`plan_cache_mode` is a PostgreSQL plan-cache setting with no equivalent on this engine. Remove the option, ' +
          'or set it only on the PostgreSQL client.',
      );
    }
    return matched;
  }

  /**
   * Pin `plan_cache_mode` on every connection an OWNED pool opens, by putting
   * it in the pool's **connection parameters** rather than issuing a `SET`.
   *
   * PostgreSQL's `options` startup parameter (`-c plan_cache_mode=...`) is
   * applied by the backend as it starts the session, so the setting is in force
   * for the connection's very first statement and for its whole life: every
   * pooled checkout, `$transaction`, stream and pipeline on it inherits it.
   * There is no per-checkout reset, and none is wanted, that IS the intent.
   *
   * Why not `pool.on('connect', c => c.query('SET ...'))`, the obvious
   * alternative: pg hands the fresh client to the waiting caller in the same
   * tick it emits `connect`, so the caller's first query is issued while the
   * `SET` is still the active query. That path works today only through pg's
   * deprecated same-client query queueing (it logs a DeprecationWarning per new
   * connection and is slated for removal in pg 9), and it costs an extra round
   * trip on every connection. The startup parameter costs nothing and cannot
   * race.
   *
   * Nothing the caller already set is discarded, in either of the two places
   * pg reads `options` from. pg's `ConnectionParameters` lets a value parsed
   * out of a `connectionString` OVERRIDE the explicit `options` field, so when
   * the URL already carries `?options=...` the GUC is appended THERE; and the
   * explicit field itself falls back to `process.env.PGOPTIONS` only while it
   * is unset, so setting it blind would silently drop a deployment's
   * `PGOPTIONS` (its `search_path` or `statement_timeout`, not merely a slower
   * plan). Both are read first and the GUC is appended to whichever applies.
   *
   * One deployment caveat: an `options` startup parameter is a connection-time
   * parameter, and a connection pooler in front of Postgres may reject
   * parameters it is not configured to pass through (PgBouncer's
   * `ignore_startup_parameters`). A `SET` on checkout would survive that, at
   * the cost of the race and the round trip above. Callers behind such a pooler
   * should set the GUC on the server or role instead
   * (`ALTER ROLE ... SET plan_cache_mode = ...`).
   */
  private static withPlanCacheMode(poolConfig: pg.PoolConfig, mode: PlanCacheMode | undefined): pg.PoolConfig {
    if (mode === undefined) return poolConfig;
    // `mode` is a member of PLAN_CACHE_MODES, never caller text (see
    // resolvePlanCacheMode), which is what makes this literal safe: a GUC value
    // cannot be a bind parameter.
    const setting = `-c plan_cache_mode=${mode}`;
    const merged = poolConfig.connectionString
      ? TurbineClient.mergeConnectionStringOptions(poolConfig.connectionString, setting)
      : null;
    if (merged) return { ...poolConfig, connectionString: merged };
    // pg reads `config.options` when truthy and `process.env.PGOPTIONS`
    // otherwise, so an unmerged setting would replace the caller's PGOPTIONS
    // rather than add to it.
    const existing = poolConfig.options || (typeof process !== 'undefined' ? process.env?.PGOPTIONS : undefined);
    return { ...poolConfig, options: existing ? `${existing} ${setting}` : setting };
  }

  /**
   * `connectionString` with `setting` appended to its existing `options` query
   * parameter, or `null` when it carries no `options` (in which case the caller
   * should use the `options` pool field, which is not overridden).
   *
   * Only the query string is rewritten, never the userinfo or host, so a
   * percent-encoded password cannot be mangled by a round trip through `URL`.
   * The split is on the first `?`, which is also where pg's own parser puts the
   * query-string boundary: a connection string with an unencoded `?` inside the
   * password is not parseable by pg either, so there is no shape this handles
   * differently from the driver.
   */
  private static mergeConnectionStringOptions(connectionString: string, setting: string): string | null {
    const q = connectionString.indexOf('?');
    if (q === -1) return null;
    const params = new URLSearchParams(connectionString.slice(q + 1));
    const existing = params.get('options');
    if (existing === null) return null;
    params.set('options', `${existing} ${setting}`);
    return connectionString.slice(0, q + 1) + params.toString();
  }

  /**
   * Refuse a `utcTimestamps` value that contradicts the one an earlier client
   * in this process settled the zone-less temporal read parsers (OIDs 1114,
   * 1082, 1115, 1182) on.
   *
   * The flag has two halves. The WRITE half is per client: a bound `Date` on a
   * zone-less `date` / `timestamp` column is rewritten to a UTC literal unless
   * the owning client opted out (`coerceWriteValue` in query/writes.ts). The
   * READ half is the pg type parsers for OIDs 1114 / 1082 / 1115 / 1182, and
   * `pg.types.setTypeParser` installs ONE parser per OID for the whole process,
   * shared by every pool, every raw query, and any other library using the same
   * pg module. There is no per-pool parser hook to bind it to, and moving the
   * coercion into `parseRow` instead would leave every non-ORM read (raw SQL,
   * `client.sql`, a caller's own `pool.query`) on the driver's value while
   * changing the default path's output type, so the read half stays
   * process-wide.
   *
   * That makes the mixed shape unserveable rather than merely awkward: the
   * second client would write local calendar fields and read them back as UTC
   * (or the reverse), so its own round trip is off by the process offset.
   * A client that silently does not round-trip is the worst of the three
   * outcomes, so construction fails with the two ways out.
   *
   * EVERY client takes part, not only the ones on a Turbine-owned pool. Only an
   * owned pool REGISTERS the parsers, but registration is process-global, so a
   * client on an external pool (Neon, Vercel Postgres, Hyperdrive) constructed
   * alongside an owned one reads through them too. It is exactly the pairing
   * that produced a silent read/write disagreement: an external-pool client
   * with `utcTimestamps: false` writing local `date` literals while reading UTC
   * ones, which walks the stored calendar day back a day per read-modify-write
   * cycle. An external-pool client ALONE in a process is unaffected: it settles
   * the value, registers nothing, and keeps the caller's parser configuration.
   */
  private static assertUtcTimestampsAgree(want: boolean): void {
    const settled = TurbineClient.utcTimestampParserMode;
    if (settled === undefined || settled === want) return;
    throw new ValidationError(
      `[turbine] utcTimestamps: ${want} conflicts with utcTimestamps: ${settled}, which an earlier TurbineClient ` +
        'in this process already applied. The zone-less temporal READ parsers (pg OIDs 1114, 1082, 1115, 1182) are ' +
        'process-global, so they cannot ' +
        'differ per client, while the WRITE side is per client. Serving both values would give this client a ' +
        `${want ? 'UTC write' : 'local write'} and a ${settled ? 'UTC read' : 'local read'}, so every zone-less ` +
        '`timestamp` it writes would read back shifted by the process offset. Give every TurbineClient in this ' +
        'process the same `utcTimestamps` value, or run the odd one out in its own process.',
    );
  }

  /**
   * @internal Test-only: forget the process-global `utcTimestamps` decision so
   * one process can exercise both mismatch directions. It does NOT restore the
   * pg parser (parser registration is not reversible), so reads stay on
   * whichever parser was installed first.
   */
  static resetUtcTimestampsForTests(): void {
    TurbineClient.utcTimestampParserMode = undefined;
  }

  // -------------------------------------------------------------------------
  // Middleware, intercept all queries
  // -------------------------------------------------------------------------

  /**
   * Register a middleware function that runs around every query.
   *
   * Middleware can inspect and log query parameters, measure timing, and
   * transform the result returned by `next()`. Note: query SQL is generated
   * BEFORE middleware runs, `params.args` is a read-only snapshot, and
   * mutating it does NOT change the executed SQL. Cross-cutting filters
   * (e.g. soft deletes) belong in the query itself: pass an explicit
   * `where: { deletedAt: null }` or wrap the table accessor in a small helper.
   *
   * @example
   * ```ts
   * // Query timing middleware
   * db.$use(async (params, next) => {
   *   const before = Date.now();
   *   const result = await next(params);
   *   console.log(`${params.model}.${params.action} took ${Date.now() - before}ms`);
   *   return result;
   * });
   *
   * // Result transformation middleware, redact a field on the way out
   * db.$use(async (params, next) => {
   *   const result = await next(params);
   *   if (params.model === 'users' && Array.isArray(result)) {
   *     for (const row of result as { email?: string }[]) row.email = '[redacted]';
   *   }
   *   return result;
   * });
   * ```
   */
  $use(middleware: Middleware): void {
    this.middlewares.push(middleware);
    // Clear table caches so new QueryInterfaces pick up the middleware. Covers
    // the primary cache plus, when replicas are configured, the routing proxies
    // and per-replica caches. The primary-view (if built) shares the middleware
    // array by reference, so its QueryInterfaces observe the new middleware too.
    this.tableCache.clear();
    this.routingProxyCache.clear();
    for (const cache of this.replicaTableCaches) cache.clear();
  }

  // -------------------------------------------------------------------------
  // Event emitter, subscribe to query lifecycle events
  // -------------------------------------------------------------------------

  $on(_event: 'query', listener: QueryEventListener): void {
    this.queryListeners.add(listener);
  }

  $off(_event: 'query', listener: QueryEventListener): void {
    this.queryListeners.delete(listener);
  }

  // -------------------------------------------------------------------------
  // Observability, automatic metrics collection
  // -------------------------------------------------------------------------

  private observeEngine?: ObserveEngine;

  async $observe(config: ObserveConfig): Promise<ObserveHandle> {
    if (this.observeEngine) {
      await this.observeEngine.stop();
      this.$off('query', this.observeEngine.getListener());
    }
    const engine = new ObserveEngine(config);
    this.observeEngine = engine;
    await engine.init();
    this.$on('query', engine.getListener());
    return {
      stop: async () => {
        this.$off('query', engine.getListener());
        await engine.stop();
        if (this.observeEngine === engine) this.observeEngine = undefined;
      },
    };
  }

  // -------------------------------------------------------------------------
  // Table accessor, creates QueryInterface for any table
  // -------------------------------------------------------------------------

  /**
   * Get a QueryInterface for a table.
   * Results are cached, calling `table('users')` twice returns the same instance.
   *
   * When read replicas are configured, this returns a thin routing proxy: the
   * read-only operations in {@link READ_OPERATIONS} are dispatched to a
   * round-robin replica-bound QueryInterface (so an entire read, base rows and
   * any batched sub-queries, runs against a single consistent replica), while
   * writes and every other member fall through to the primary-bound instance.
   * With no replicas the original single-pool instance is returned directly.
   */
  table<T extends object = Record<string, unknown>>(name: string): QueryInterface<T> {
    if (this.replicaPools.length === 0) {
      return this.primaryTableQI(name) as QueryInterface<T>;
    }
    let proxy = this.routingProxyCache.get(name);
    if (!proxy) {
      proxy = this.createRoutingAccessor(name);
      this.routingProxyCache.set(name, proxy);
    }
    return proxy as QueryInterface<T>;
  }

  /** Get (and cache) the primary-pool-bound QueryInterface for a table. */
  private primaryTableQI(name: string): QueryInterface<object> {
    let qi = this.tableCache.get(name);
    if (!qi) {
      qi = this.buildTableQI(this.pool, name);
      this.tableCache.set(name, qi);
    }
    return qi;
  }

  /**
   * Advance the round-robin cursor and return the QueryInterface bound to the
   * selected replica pool for `name` (cached per replica).
   */
  private nextReplicaTableQI(name: string): QueryInterface<object> {
    const index = this.replicaCursor % this.replicaPools.length;
    // Reset before overflow so the cursor never grows unbounded.
    this.replicaCursor = this.replicaCursor + 1 >= Number.MAX_SAFE_INTEGER ? 0 : this.replicaCursor + 1;
    // index is always in-bounds (`% length`); the pools/cache entries exist.
    const cache = this.replicaTableCaches[index] as Map<string, QueryInterface<object>>;
    const pool = this.replicaPools[index] as PgCompatPool;
    let qi = cache.get(name);
    if (!qi) {
      qi = this.buildTableQI(pool, name);
      cache.set(name, qi);
    }
    return qi;
  }

  /** Construct a QueryInterface bound to `pool` (honoring any injected factory). */
  private buildTableQI(pool: PgCompatPool, name: string): QueryInterface<object> {
    const asPgPool = pool as unknown as pg.Pool;
    return this.queryOptions?.queryInterfaceFactory
      ? this.queryOptions.queryInterfaceFactory(asPgPool, name, this.schema, this.middlewares, this.queryOptions)
      : new QueryInterface<object>(asPgPool, name, this.schema, this.middlewares, this.queryOptions);
  }

  /**
   * Build the read/write routing proxy for a table. The proxy targets the
   * primary QueryInterface (so writes, `build*`, and every non-read member work
   * unchanged); read operations are intercepted and dispatched to a replica.
   */
  private createRoutingAccessor(name: string): QueryInterface<object> {
    const primaryQI = this.primaryTableQI(name);
    const client = this;
    return new Proxy(primaryQI, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && READ_OPERATIONS.has(prop)) {
          // Pick the replica at CALL time so round-robin advances per operation.
          return (...args: unknown[]) => {
            const replicaQI = client.nextReplicaTableQI(name) as unknown as Record<
              string,
              ((...a: unknown[]) => unknown) | undefined
            >;
            const method = replicaQI[prop];
            if (typeof method !== 'function') {
              return Reflect.get(target, prop, receiver);
            }
            return method.apply(replicaQI, args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as QueryInterface<object>;
  }

  /**
   * Return a view of this client that pins EVERY operation, reads included -
   * to the primary pool, bypassing replica routing. Use it to read your own
   * write without replication lag, or for any read that must see the latest
   * committed data.
   *
   * The view shares the primary pool, schema, dialect, query options, and
   * middleware; it owns nothing, so its `disconnect()` is a no-op. When no
   * replicas are configured this simply returns the client itself (already
   * primary-only). The view is cached, repeated calls return the same instance.
   *
   * @example
   * ```ts
   * await db.users.create({ data: { email: 'a@b.com' } });
   * // Read-after-write: guaranteed to see the row just inserted.
   * const user = await db.$primary().users.findFirst({ where: { email: 'a@b.com' } });
   * ```
   */
  $primary(): TurbineClient {
    if (this.replicaPools.length === 0) return this;
    if (!this.primaryView) {
      this.primaryView = new TurbineClient(
        { [PRIMARY_VIEW]: { parent: this } } as unknown as TurbineConfig,
        this.schema,
      );
    }
    return this.primaryView;
  }

  // -------------------------------------------------------------------------
  // Pipeline, batch multiple queries into one round-trip
  // -------------------------------------------------------------------------

  /**
   * Execute multiple queries in a single database round-trip.
   *
   * Two call styles:
   *   - `db.pipeline(q1, q2, q3)`, rest params (backward-compatible)
   *   - `db.pipeline([q1, q2, q3], { transactional: false })`, array + options
   *
   * On pg.Pool-backed connections with TCP, this uses the real Postgres
   * extended-query pipeline protocol (one TCP flush, one round-trip).
   * On HTTP-based drivers it falls back to sequential execution.
   */
  async pipeline<T extends readonly DeferredQuery<unknown>[]>(
    ...args: T | [T, PipelineOptions?]
  ): Promise<PipelineResults<T>> {
    let queries: T;
    let options: PipelineOptions | undefined;

    // Detect which overload was used
    if (
      args.length > 0 &&
      Array.isArray(args[0]) &&
      (args[0] as unknown[]).every(
        (item) => item && typeof item === 'object' && 'sql' in (item as Record<string, unknown>),
      )
    ) {
      // Array form: pipeline([q1, q2], opts?)
      queries = args[0] as unknown as T;
      options = args[1] as PipelineOptions | undefined;
    } else {
      // Rest-param form: pipeline(q1, q2, q3)
      queries = args as unknown as T;
    }

    if (this.logging) {
      console.log(`[turbine] Pipeline: ${queries.length} queries, ${queries.map((q) => q.tag).join(', ')}`);
    }
    return executePipeline(this.pool, queries, options);
  }

  /**
   * Check whether the underlying pool supports the real pipeline protocol.
   * Returns `true` for standard pg.Pool TCP connections, `false` for HTTP
   * drivers (Neon HTTP, Vercel Postgres, etc.) and mock pools.
   */
  async pipelineSupported(): Promise<boolean> {
    return pipelineSupported(this.pool);
  }

  // -------------------------------------------------------------------------
  // Raw SQL, tagged template literal escape hatch
  // -------------------------------------------------------------------------

  /**
   * Execute a raw SQL query with parameter interpolation via tagged templates.
   *
   * @example
   * ```ts
   * const result = await db.raw<{ day: Date; count: number }>`
   *   SELECT DATE_TRUNC('day', created_at) as day, COUNT(*)::int as count
   *   FROM posts WHERE org_id = ${orgId}
   *   GROUP BY day ORDER BY day
   * `;
   * ```
   */
  async raw<T extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]> {
    let sql = '';
    strings.forEach((str, i) => {
      sql += str;
      if (i < values.length) {
        sql += this.dialect.paramPlaceholder(i + 1);
      }
    });

    if (this.logging) {
      console.log(`[turbine] Raw SQL: ${sql.trim().substring(0, 120)}...`);
    }

    try {
      const result = await this.pool.query(sql, values);
      return result.rows as T[];
    } catch (err) {
      throw wrapPgError(err);
    }
  }

  /**
   * Execute a **typed** raw SQL query, Turbine's answer to Prisma's TypedSQL.
   *
   * Like {@link raw}, every interpolated `${value}` becomes a `$N` parameter
   * (never string-concatenated), so it is injection-safe by construction. The
   * difference is the caller-supplied row type and the chainable result: the
   * returned {@link TypedSqlQuery} can be `await`ed directly for `T[]`, or
   * refined with `.one()` (→ `T | null`) or `.scalar<V>()` (→ `V | null`).
   *
   * Rows are returned as-is, no snake→camel mapping (matching `raw()`). Alias
   * columns in SQL if you want camelCase keys.
   *
   * @example
   * ```ts
   * // rows
   * const rows = await db.sql<{ id: number; name: string }>`
   *   SELECT id, name FROM users WHERE org_id = ${orgId}
   * `;
   *
   * // single row or null
   * const user = await db.sql<{ id: number; name: string }>`
   *   SELECT id, name FROM users WHERE id = ${userId}
   * `.one();
   *
   * // scalar
   * const total = await db.sql<{ count: number }>`
   *   SELECT COUNT(*)::int AS count FROM users
   * `.scalar();
   * ```
   */
  sql<T extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): TypedSqlQuery<T> {
    const { sql, params } = buildTypedSql(strings, values, this.dialect);
    return new TypedSqlQuery<T>(this.pool, sql, params, this.logging);
  }

  // -------------------------------------------------------------------------
  // Transaction support (raw, legacy)
  // -------------------------------------------------------------------------

  /**
   * Execute a function within a database transaction (raw pg.PoolClient).
   * For the typed API, use `$transaction()` instead.
   *
   * @example
   * ```ts
   * await db.transaction(async (client) => {
   *   await client.query('INSERT INTO users (name) VALUES ($1)', ['Alice']);
   * });
   * ```
   */
  async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    /**
     * Only true once BEGIN has actually succeeded. If BEGIN itself throws
     * (e.g. a single-writer engine's transaction gate times out or rejects a
     * re-entrant begin), issuing a "best-effort" ROLLBACK would be a stray
     * statement from a context that never opened a transaction, on a driver
     * with one shared engine handle (PowDB embedded) it would roll back a
     * DIFFERENT caller's open transaction.
     */
    let began = false;
    try {
      await client.query(this.dialect.beginStatement());
      began = true;
      // Engine seam: single-writer engines scope their transaction re-entrancy
      // marker to the callback's async subtree (see
      // PgCompatPoolClient.wrapTransactionCallback). Absent everywhere else.
      const wrap = (client as unknown as PgCompatPoolClient).wrapTransactionCallback;
      // `.call` erases the generic, so the callback's Promise<T> is re-asserted.
      const result = wrap ? ((await wrap.call(client, () => fn(client))) as T) : await fn(client);
      await client.query(this.dialect.commitStatement());
      return result;
    } catch (err) {
      if (began) {
        try {
          await client.query(this.dialect.rollbackStatement());
        } catch {
          // Best-effort rollback, the connection may have died mid-query.
        }
      }
      throw err;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // $transaction, Prisma-style typed transaction API
  // -------------------------------------------------------------------------

  /**
   * Execute a function within a database transaction with full typed table accessors.
   *
   * The `tx` object provides the same table accessor API as the main client.
   * Supports nested transactions via SAVEPOINTs, timeouts, and isolation levels.
   *
   * @example
   * ```ts
   * await db.$transaction(async (tx) => {
   *   const user = await tx.users.create({ data: { email: 'a@b.com' } });
   *   await tx.posts.create({ data: { userId: user.id, title: 'Hello' } });
   * });
   *
   * // With options:
   * await db.$transaction(async (tx) => {
   *   // ...
   * }, { timeout: 5000, isolationLevel: 'Serializable' });
   * ```
   */
  $transaction<R>(fn: (tx: TransactionClient) => Promise<R>, options?: TransactionOptions): Promise<R>;
  /**
   * Batch form, run a tuple of {@link DeferredQuery} objects (produced by the
   * `build*()` methods, e.g. `db.users.buildFindMany(...)`) atomically inside a
   * single `BEGIN…COMMIT` on one connection. Returns a positionally-typed tuple
   * of each query's transformed result; any failure rolls the whole batch back.
   *
   * Unlike {@link pipeline}, this never uses the extended-query pipeline
   * protocol. Statements run on the single transaction connection: strictly
   * sequentially by default (safe on every driver, including HTTP/serverless
   * pools), or, when the checked-out connection advertises
   * {@link PgCompatPoolClient.supportsPipelining}, dispatched in one write
   * burst with replies collected in order, saving a network round trip per
   * statement. Either way the failure contract is identical: the first
   * (lowest-index) failure aborts the batch and rolls everything back.
   *
   * @example
   * ```ts
   * const [user, count] = await db.$transaction([
   *   db.users.buildFindUnique({ where: { id: 1 } }),
   *   db.posts.buildCount({ where: { userId: 1 } }),
   * ]);
   * ```
   */
  $transaction<T extends readonly DeferredQuery<unknown>[]>(queries: readonly [...T]): Promise<PipelineResults<T>>;
  async $transaction(
    fnOrQueries: ((tx: TransactionClient) => Promise<unknown>) | readonly DeferredQuery<unknown>[],
    options?: TransactionOptions,
  ): Promise<unknown> {
    // Batch overload: an array of DeferredQuery objects runs atomically inside
    // one BEGIN…COMMIT, reusing the raw transaction machinery below.
    if (Array.isArray(fnOrQueries)) {
      return this.transactionBatch(fnOrQueries);
    }
    const fn = fnOrQueries as (tx: TransactionClient) => Promise<unknown>;
    const client = await this.pool.connect();
    const timeout = options?.timeout;

    /**
     * Track whether the connection has already been released so the finally
     * block doesn't double-release. When a timeout fires we destroy the
     * connection eagerly to abort the in-flight backend query.
     */
    let released = false;
    const releaseOnce = (err?: Error | boolean): void => {
      if (released) return;
      released = true;
      try {
        client.release(err);
      } catch {
        // pg may throw if the client is already released, swallow.
      }
    };

    let timedOut = false;
    /**
     * Only true once BEGIN has actually succeeded. If BEGIN itself throws -
     * e.g. a single-writer engine's transaction gate times out in its FIFO
     * queue or rejects a re-entrant begin (PowDB, E002/E017), this context
     * never opened a transaction, so the catch below must NOT issue its
     * best-effort ROLLBACK: on a driver with one shared engine handle that
     * stray ROLLBACK would tear down a DIFFERENT caller's open transaction.
     */
    let began = false;

    try {
      // BEGIN with optional isolation level, the dialect owns the keyword and
      // BEGIN+isolation composition (Postgres appends ` ISOLATION LEVEL …`).
      const isolationSql = options?.isolationLevel ? ISOLATION_LEVELS[options.isolationLevel] : undefined;
      await client.query(this.dialect.beginStatement(isolationSql));
      began = true;

      // Apply transaction-local session context (RLS / multi-tenant GUCs).
      // Order matters: BEGIN -> isolation level (above) -> set_config loop ->
      // user fn. Any error here propagates to the catch below and rolls back
      // like any other transaction failure. We use set_config(name, value,
      // is_local=true), the parameterizable, transaction-scoped equivalent of
      // SET LOCAL, so both name and value are BOUND params, never interpolated.
      if (options?.sessionContext) {
        if (!this.dialect.supportsRLS) {
          throw new UnsupportedFeatureError(
            'sessionContext (RLS session GUCs)',
            this.dialect.name,
            'set_config-based row-level-security context requires PostgreSQL.',
          );
        }
        for (const [name, value] of Object.entries(options.sessionContext)) {
          if (!GUC_NAME_REGEX.test(name)) {
            throw new ValidationError(
              `[turbine] Invalid session-context GUC name "${name}", must match ` +
                '/^[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*)?$/ (optionally namespaced, e.g. "app.current_tenant")',
            );
          }
          const cfg = this.dialect.buildSetSessionConfig(name, String(value));
          await client.query(cfg.sql, cfg.params);
        }
      }

      // Create the transaction client with typed table accessors. Pass the
      // parent pool so its read-only guard + PowDB capabilities flow into the
      // transaction-scoped proxy pool (see TransactionClient.createTxPool).
      const tx = new TransactionClient(
        client,
        this.schema,
        this.middlewares,
        this.queryOptions,
        this.pool as unknown as { readonly?: boolean; capabilities?: unknown },
      );

      // Dynamically attach table accessors to tx
      for (const tableName of Object.keys(this.schema.tables)) {
        const camelName = tableName.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
        if (!(camelName in tx)) {
          Object.defineProperty(tx, camelName, {
            get: () => tx.table(tableName),
            enumerable: true,
          });
        }
      }

      let result: unknown;

      // Engine seam: when the checked-out connection exposes
      // wrapTransactionCallback (single-writer engines such as PowDB), run the user
      // callback through it so the engine can scope its re-entrancy marker to
      // the callback's async subtree. All other drivers: plain fn(tx).
      const wrap = (client as unknown as PgCompatPoolClient).wrapTransactionCallback;
      const runCallback = (): Promise<unknown> => (wrap ? wrap.call(client, () => fn(tx)) : fn(tx));

      if (timeout) {
        // Race between the function and a timeout. If the timeout fires we
        // need to actually abort the in-flight query, otherwise the backend
        // keeps running until pg's own timeout, holding a pool slot the whole
        // time. The simplest reliable cancellation is to destroy the
        // connection: passing a truthy argument to client.release() tells the
        // pg pool to discard the client (its socket is closed, which causes
        // Postgres to abort the active query and roll back the transaction).
        // The pool will spin up a fresh connection on the next checkout.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            // Destroy the connection to abort the in-flight backend query.
            // We do this BEFORE rejecting so the socket is gone by the time
            // the caller's catch block runs.
            releaseOnce(new Error('[turbine] Transaction timeout, connection destroyed'));
            reject(new TimeoutError(timeout, 'Transaction'));
          }, timeout);
        });
        try {
          result = await Promise.race([runCallback(), timeoutPromise]);
        } finally {
          clearTimeout(timer);
        }
      } else {
        result = await runCallback();
      }

      await client.query(this.dialect.commitStatement());

      if (this.logging) {
        console.log('[turbine] Transaction committed');
      }

      return result;
    } catch (err) {
      // If the timeout fired we already destroyed the connection, issuing a
      // ROLLBACK on a released client would throw "Client has already been
      // released". Skip the rollback in that case (the backend rolled back
      // when its socket was closed). Likewise skip it when BEGIN never
      // succeeded (`began` false), there is no transaction to roll back and
      // the stray statement could hit another caller's transaction on a
      // shared-handle engine.
      if (began && !timedOut && !released) {
        try {
          await client.query(this.dialect.rollbackStatement());
        } catch {
          // Best-effort rollback, the connection may have died mid-query.
        }
      }
      if (this.logging) {
        console.log('[turbine] Transaction rolled back');
      }
      throw err;
    } finally {
      releaseOnce();
    }
  }

  /**
   * Execute a batch of {@link DeferredQuery} objects atomically inside one
   * transaction. Backs the `$transaction([...])` array overload. Reuses the raw
   * {@link transaction} machinery (BEGIN/COMMIT/ROLLBACK + connection release);
   * each result is passed through its query's `transform`.
   *
   * Execution strategy on the single transaction connection:
   *   - **Sequential (default).** Await each statement's reply before sending
   *     the next. Safe on every driver; on a networked driver a batch of N
   *     costs N round trips.
   *   - **Pipelined.** When the checked-out connection advertises
   *     {@link PgCompatPoolClient.supportsPipelining} (its `query()` accepts
   *     concurrent calls and completes them in FIFO submission order), all
   *     statements are dispatched in one write burst and the replies are
   *     collected in order, ~1 round trip plus server time. Only taken when
   *     the dialect's writes surface rows directly (`resultStrategy` !==
   *     'reselect'): a reselect plan is itself a sequential write+read pair.
   *
   * The two paths share one failure contract: the first (lowest-index) failed
   * statement's error is thrown (wrapped via {@link wrapPgError}) and the
   * surrounding transaction rolls back, so no statement's effect survives. The
   * pipelined path drains every in-flight reply (`Promise.allSettled`) before
   * rethrowing, which keeps the connection's request/reply pairing intact and
   * means ROLLBACK is only issued once no statement is still in flight.
   */
  private async transactionBatch<T extends readonly DeferredQuery<unknown>[]>(queries: T): Promise<PipelineResults<T>> {
    if (queries.length === 0) {
      return [] as unknown as PipelineResults<T>;
    }
    return this.transaction(async (client) => {
      const pipelined =
        (client as unknown as PgCompatPoolClient).supportsPipelining === true &&
        this.dialect.resultStrategy !== 'reselect';

      if (pipelined) {
        // Dispatch every statement before awaiting any reply. The driver's
        // FIFO guarantee makes settled[i] the reply to queries[i].
        const settled = await Promise.allSettled(queries.map((dq) => client.query(dq.sql, dq.params)));
        const results: unknown[] = [];
        for (let i = 0; i < settled.length; i++) {
          const outcome = settled[i]!;
          if (outcome.status === 'rejected') {
            throw wrapPgError(outcome.reason);
          }
          results.push(queries[i]!.transform(outcome.value));
        }
        return results as PipelineResults<T>;
      }

      const results: unknown[] = [];
      for (const dq of queries) {
        let raw: pg.QueryResult;
        try {
          // Non-RETURNING engines (resultStrategy 'reselect', e.g. MySQL)
          // attach a reselect plan that runs the write plus a follow-up SELECT;
          // running dq.sql alone would transform a row-less write result.
          raw =
            this.dialect.resultStrategy === 'reselect' && dq.reselect
              ? await dq.reselect((sql, params) => client.query(sql, params))
              : await client.query(dq.sql, dq.params);
        } catch (err) {
          throw wrapPgError(err);
        }
        results.push(dq.transform(raw));
      }
      return results as PipelineResults<T>;
    });
  }

  /**
   * Convenience wrapper around `$transaction` for the multi-tenant / RLS case:
   * runs `fn` inside a transaction with the given session GUCs applied via
   * `set_config(..., is_local=true)`. Equivalent to
   * `$transaction(fn, { sessionContext: context })`.
   *
   * @example
   * ```ts
   * const invoices = await db.$withSession(
   *   { 'app.current_tenant': tenantId },
   *   (tx) => tx.invoices.findMany(),
   * );
   * ```
   */
  async $withSession<R>(
    context: Record<string, string | number | boolean>,
    fn: (tx: TransactionClient) => Promise<R>,
  ): Promise<R> {
    return this.$transaction(fn, { sessionContext: context });
  }

  // -------------------------------------------------------------------------
  // LISTEN / NOTIFY, Postgres realtime pub/sub
  // -------------------------------------------------------------------------

  /**
   * Subscribe to a Postgres NOTIFY channel. The handler fires with each
   * notification's payload string (the empty string when a payload-less
   * NOTIFY is sent) for as long as the subscription is active.
   *
   * Each `$listen` checks out its OWN dedicated long-lived connection from the
   * pool and runs `LISTEN "channel"` on it; `subscription.unsubscribe()`
   * UNLISTENs, detaches the handler, and releases that connection. Active
   * subscriptions are tracked and force-released on `disconnect()` so shutdown
   * never hangs.
   *
   * The channel name CANNOT be a bound parameter (`LISTEN $1` is a syntax
   * error), so it is validated against a strict identifier regex AND quoted via
   * `quoteIdent` before interpolation, it is the only identifier this method
   * places into SQL text.
   *
   * **Serverless caveat:** LISTEN needs a persistent connection that can push
   * async notifications. Stateless HTTP drivers (Neon HTTP, Vercel Postgres)
   * cannot do this, `$listen` throws a `ConnectionError` rather than hang.
   * `$notify` works on every driver.
   *
   * @example
   * ```ts
   * const sub = await db.$listen('order_created', (payload) => {
   *   const order = JSON.parse(payload);
   *   console.log('new order', order.id);
   * });
   * // ...later
   * await sub.unsubscribe();
   * ```
   */
  async $listen(channel: string, handler: NotificationHandler): Promise<Subscription> {
    if (!this.dialect.supportsListenNotify) {
      throw new UnsupportedFeatureError(
        '$listen (LISTEN/NOTIFY realtime)',
        this.dialect.name,
        'Realtime pub/sub requires PostgreSQL.',
      );
    }
    validateChannel(channel);
    const quoted = quoteIdent(channel);

    if (this.logging) {
      console.log(`[turbine] LISTEN ${quoted}`);
    }

    const sub = await createSubscription(this.pool as unknown as PgCompatPool, channel, quoted, handler, (closed) => {
      this.activeSubscriptions.delete(closed);
    });
    this.activeSubscriptions.add(sub);
    return sub;
  }

  /**
   * Send a Postgres NOTIFY on `channel` with an optional payload string.
   *
   * Issued as `SELECT pg_notify($1, $2)`, both the channel and payload are
   * BOUND parameters (no quoting/injection concern). The channel is still
   * validated against the identifier regex for parity with `$listen` and to
   * catch typos loudly. Works on every driver, including serverless HTTP pools.
   *
   * @example
   * ```ts
   * await db.$notify('order_created', JSON.stringify({ id: 7 }));
   * ```
   */
  async $notify(channel: string, payload?: string): Promise<void> {
    if (!this.dialect.supportsListenNotify) {
      throw new UnsupportedFeatureError(
        '$notify (LISTEN/NOTIFY realtime)',
        this.dialect.name,
        'Realtime pub/sub requires PostgreSQL.',
      );
    }
    validateChannel(channel);
    if (this.logging) {
      console.log(`[turbine] NOTIFY ${channel}`);
    }
    try {
      await this.pool.query('SELECT pg_notify($1, $2)', [channel, payload ?? '']);
    } catch (err) {
      throw wrapPgError(err);
    }
  }

  // -------------------------------------------------------------------------
  // Retry, automatic retry for retryable errors (deadlock, serialization)
  // -------------------------------------------------------------------------

  /**
   * Execute an async function with automatic retry on retryable errors.
   *
   * Only errors with `isRetryable === true` (DeadlockError, SerializationFailureError)
   * are retried. Uses exponential backoff with jitter.
   *
   * @example
   * ```ts
   * const result = await db.$retry(() =>
   *   db.$transaction(async (tx) => {
   *     // ... serializable transaction logic
   *   }, { isolationLevel: 'Serializable' })
   * );
   * ```
   */
  async $retry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
    return withRetry(fn, options);
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  /**
   * Test the database connection.
   * Throws if the connection fails.
   */
  async connect(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT 1');
      if (this.logging) {
        console.log('[turbine] Connection verified');
      }
    } finally {
      client.release();
    }
  }

  /**
   * Gracefully shut down the connection pool.
   *
   * If Turbine was given an external pool via `TurbineConfig.pool`, this
   * method is a no-op, the caller is responsible for the pool's lifecycle.
   */
  async disconnect(): Promise<void> {
    // Tear down any live LISTEN subscriptions first. Each holds a dedicated
    // pooled connection checked out; if we ended the pool (or returned for an
    // external pool) without releasing them, pool.end() would wait forever for
    // those connections to return. _forceRelease() detaches the handler and
    // releases the client WITHOUT issuing UNLISTEN (pointless if we're ending
    // the pool / the connection is going away anyway). This runs for both
    // owned and external pools so subscriptions never leak.
    if (this.activeSubscriptions.size > 0) {
      // _forceRelease mutates activeSubscriptions via the onClosed callback,
      // so iterate a snapshot.
      for (const sub of [...this.activeSubscriptions]) {
        sub._forceRelease();
      }
      this.activeSubscriptions.clear();
    }

    // Close owned (string-configured) replica pools regardless of whether the
    // primary is owned, external replica pools are left untouched (caller owns
    // their lifecycle), same contract as an external primary.
    for (const replicaPool of this.ownedReplicaPools) {
      try {
        await replicaPool.end();
      } catch (err) {
        if (this.logging) {
          console.error('[turbine] Error closing replica pool:', (err as Error).message);
        }
      }
    }

    if (!this.ownsPool) {
      if (this.logging) {
        console.log('[turbine] disconnect() skipped, external primary pool is not owned by Turbine');
      }
      return;
    }
    await this.pool.end();
    if (this.logging) {
      console.log('[turbine] Pool disconnected');
    }
  }

  /** Alias for disconnect() */
  async end(): Promise<void> {
    return this.disconnect();
  }

  /**
   * Pool statistics for monitoring. Returns zeros for pools that don't
   * expose connection counts (e.g., stateless HTTP drivers like Neon).
   */
  get stats() {
    return {
      totalCount: this.pool.totalCount ?? 0,
      idleCount: this.pool.idleCount ?? 0,
      waitingCount: this.pool.waitingCount ?? 0,
    };
  }
}
