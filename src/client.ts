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
 * import { turbine } from './generated/turbine/index.js';
 * const db = turbine({ connectionString: process.env.DATABASE_URL });
 * const user = await db.users.findUnique({ where: { id: 1 } });
 *
 * // With base client (dynamic):
 * import { TurbineClient } from 'turbine-orm';
 * const db = new TurbineClient({ connectionString: '...' }, schema);
 * const users = db.table<User>('users');
 * ```
 */

import pg from '#pg';
import { openCheckout, typeCheckoutTimeouts } from './checkout.js';
import {
  absorbCheckedOutErrors,
  type CheckoutWatch,
  settleLongIdleCheckouts,
  watchCheckouts,
} from './connection-guard.js';
import {
  type ConnectionTarget,
  detectPoolerTarget,
  fillTargetFromEnvironment,
  parseConnectionTarget,
  statementTimeoutSetting,
  withStartupSetting,
} from './connection-url.js';
import { type DiagnosticsConfig, type ResolvedDiagnostics, resolveDiagnostics } from './diagnostics.js';
import { assertDialectCapabilities, type Dialect, postgresDialect } from './dialect.js';
import {
  ConnectionError,
  type ErrorMessageMode,
  errorMessageModesDiverged,
  explainConnectionLoss,
  PipelineError,
  registerClientErrorMessageMode,
  runWithErrorMessageMode,
  setErrorMessageMode,
  TimeoutError,
  UnsupportedFeatureError,
  ValidationError,
  wrapPgError,
} from './errors.js';
import { normalizeGlobalFilters, tableAccessorName } from './global-filters-config.js';
import { CLIENT_LOG_CONTEXT, type ClientLogContext, logTo, resolveLogger, type TurbineLogger } from './logger.js';
import { hasRelationFields } from './nested-write.js';
import { type ObserveConfig, ObserveEngine, type ObserveHandle } from './observe.js';
import type { PgCompatPool, PgCompatPoolClient, PgCompatQueryResult } from './pg-types.js';
import { executePipeline, type PipelineOptions, type PipelineResults, pipelineSupported } from './pipeline.js';
import { txQueryOptions } from './query/builder.js';
import {
  type DeferredQuery,
  type GlobalFilters,
  type JsonEncoding,
  type QueryEvent,
  type QueryEventListener,
  QueryInterface,
  type QueryInterfaceOptions,
  type RelationLoadStrategy,
  type TemporalInfinityReading,
} from './query/index.js';
import { assertNoLockInAutocommitPipeline } from './query/row-lock.js';
import { commentDeferred, resolveSqlComment, type SqlCommenter, type SqlCommentOptions } from './query/sql-comment.js';
import { resolveStreamIdleTimeout } from './query/stream-idle.js';
import { asQueryInterface, TABLE_METHODS } from './query/table-client.js';
import {
  ownLookup,
  quoteIdent,
  registerUtcTemporalParsers,
  sendCancelRequest,
  suggestKey,
  warnParserOverwrite,
} from './query/utils.js';
import { shouldWarnOnce, WARN_NS } from './query/warn-registry.js';
import { queryChannelActive, settleQueryTrace, startQueryTrace } from './query-channel.js';
import {
  currentQueryTag,
  deferredIdentity,
  emitStatementEvent,
  rawIdentity,
  resultRowCount,
  runReportedStatement,
  runWithQueryTag,
} from './query-events.js';
import {
  type ActiveSubscription,
  createSubscription,
  type ListenOptions,
  type NotificationHandler,
  type Subscription,
  validateChannel,
} from './realtime.js';
import type { SchemaMetadata, TableMetadata } from './schema.js';
import { parseInt8, rawClientOf, typedQueryPool } from './supplied-pool-types.js';
import { registerTransactionClient } from './transaction-client-slot.js';
import {
  commitTransaction,
  rolledBackError,
  TRANSACTION_STATE,
  type TransactionScope,
  TransactionState,
  unawaitedWorkError,
} from './transaction-state.js';
import { buildTypedSql, TypedSqlQuery, utcDateParams } from './typed-sql.js';

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
 * The pg-compatible driver contract. Declared in `pg-types.ts` (a leaf module
 * with no imports) rather than here, so `query/` can name the same interfaces
 * without an import edge back to the client, and so no `@types/pg` name
 * reaches the published declarations. Re-exported so every existing
 * `from './client.js'` import path keeps working.
 */
export type {
  PgCompatPool,
  PgCompatPoolClient,
  PgCompatQueryConfig,
  PgCompatQueryResult,
} from './pg-types.js';

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
   *
   * Turbine's own queries on it read `bigint` as a number and, under
   * {@link utcTimestamps}, zone-less temporals as UTC, by attaching parsers to
   * each query (node-postgres' query-level `types`). Your own queries on the
   * pool, and the pg module's parser table, are left alone. A driver that does
   * not read a query's `types` keeps its own readings, as does every driver on
   * the `edge-light` / `browser` builds, where Turbine has no parsers to attach.
   */
  pool?: PgCompatPool | undefined;
  /** Postgres connection string (e.g. postgres://user:pass@host:5432/db) */
  connectionString?: string | undefined;
  /** Host (used if connectionString is not set) */
  host?: string | undefined;
  /** Port (default: 5432) */
  port?: number | undefined;
  /** Database name */
  database?: string | undefined;
  /** Username */
  user?: string | undefined;
  /** Password */
  password?: string | undefined;
  /** SSL/TLS options for the connection (required for most cloud providers) */
  ssl?:
    | boolean
    | {
        rejectUnauthorized?: boolean | undefined;
        ca?: string | undefined;
        key?: string | undefined;
        cert?: string | undefined;
      }
    | undefined;
  /** Maximum number of connections in the pool (default: 10) */
  poolSize?: number | undefined;
  /** Idle timeout in ms before a connection is closed (default: 30000) */
  idleTimeoutMs?: number | undefined;
  /** Connection timeout in ms (default: 5000) */
  connectionTimeoutMs?: number | undefined;
  /** pg-style alias for {@link poolSize}; the explicit field wins when both are set. */
  max?: number | undefined;
  /** pg-style alias for {@link idleTimeoutMs}; the explicit field wins when both are set. */
  idleTimeoutMillis?: number | undefined;
  /** pg-style alias for {@link connectionTimeoutMs}; the explicit field wins when both are set. */
  connectionTimeoutMillis?: number | undefined;
  /**
   * Emit Turbine's lifecycle lines (pool created, raw SQL preview, transaction
   * committed, ...) at the logger's `debug` level, plus the errors a throwing
   * `$on` listener raises. Default: false. With the default logger the lines
   * go to `console`. Bound parameter values are never logged.
   */
  logging?: boolean | undefined;
  /**
   * Where Turbine's log lines go. Each line is a message plus a structured
   * entry whose `code` is stable (`'pool-error'`, `'unknown-config-key'`); the
   * message text is not. Every method is optional and a missing one drops that
   * level, so `{}` silences Turbine entirely. Default: `console`, each line
   * prefixed `[turbine]`.
   *
   * The arguments are `(message, entry)`, like `console` and winston. For pino
   * or bunyan, which take `(object, message)`, adapt:
   * `{ warn: (msg, e) => log.warn(e, msg), error: (msg, e) => log.error(e, msg) }`.
   *
   * No line carries a bound parameter value, whatever `logQueryParams` says.
   * Once-per-process warnings are deduplicated process-wide, so a warning one
   * client already emitted does not reach a second client's logger.
   */
  logger?: TurbineLogger | undefined;
  /**
   * What Turbine checks and says about itself: per-query advice (unknown
   * options, unordered pages, missing FK indexes, ...) and the SQL-cache
   * self-check. `'development'` turns both on; `'production'` turns both off.
   * An object overrides either part: `{ mode: 'production', cacheCheck: {
   * sample: 0.001 } }`.
   *
   * Default: `'production'` when `NODE_ENV` is `'production'` when the client is
   * constructed (or when there is no `process`, as on an edge runtime), else
   * `'development'`. Read once, at construction. Set it explicitly on a worker
   * or serverless function that does not set `NODE_ENV`.
   *
   * Construction warnings (a misspelled config key, an option an external pool
   * ignores, prepared statements behind a pooler) do not depend on it: they
   * describe production hazards, fire once per process, and are always on.
   */
  diagnostics?: DiagnosticsConfig | undefined;
  /** Default LIMIT applied to findMany() when no limit is specified (opt-in, default: undefined) */
  defaultLimit?: number | undefined;
  /**
   * Log a warning when findMany() is called without a limit (default: false).
   * Pass a per-table map (`{ users: false }`) to override the default for
   * specific tables; per-call `warnOnUnlimited` on findMany args wins over both.
   */
  warnOnUnlimited?: boolean | Record<string, boolean> | undefined;
  /**
   * Interpret Postgres `timestamp` (without time zone) values as UTC, both
   * at the driver level (type parsers for OIDs 1114 `timestamp`, 1082 `date`,
   * and their array forms 1115 / 1182) and when coercing nested-relation JSON
   * dates. The parsers are registered on the pg module when Turbine owns the
   * pool; on a pool you supply they are attached to each of Turbine's own
   * queries instead, and your own queries on that pool keep your parsers. A
   * bound `Date` in `raw` / `rawUnsafe` / `sql` is sent as its UTC fields under
   * this setting, so it reads back unchanged from a zone-less column. A `date` column is
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
   * process. A client on an EXTERNAL pool never REGISTERS a parser (a process
   * containing only external-pool clients keeps the pg module untouched), but
   * it does take part in the agreement check: with `false` it reads through the
   * pg module's table, which a Turbine-owned client may have set to UTC, and
   * would then write local `date` literals while reading UTC.
   */
  utcTimestamps?: boolean | undefined;
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
   * warning (per process, per field, not silenced by `diagnostics: 'production'`) the
   * first time a stored infinity is actually read, describing that reading and
   * both escapes. Naming either reading explicitly silences it.
   */
  temporalInfinity?: TemporalInfinityReading | undefined;
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
   * SESSION-LEVEL. THE PER-QUERY LEVER IS A DIFFERENT, NARROWER ONE. This
   * option is a connection parameter and cannot be unset for a single query, so
   * a client-wide value cannot express "custom here, `auto` there". The read
   * option `forceCustomPlan: true` covers that case, and only that case: it
   * withholds the prepared-statement NAME for one query, and because the driver
   * re-parses an unnamed statement on every execution, the counter that
   * promotion depends on is reset before it is ever reached. That
   * mechanism can only ever mean custom, so there is deliberately no per-query
   * `force_generic_plan`; that direction stays here, at the connection. The two
   * do NOT compose in the other order either: `'force_generic_plan'` set here
   * governs unnamed statements as well as named ones (measured), so a
   * per-query `forceCustomPlan: true` cannot escape it and is REFUSED with
   * `ValidationError` (E003) instead of silently doing nothing. Leave this
   * option unset (or `'auto'`) if any query needs the per-query lever.
   *
   * IT IS APPLIED as a connection parameter
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
  planCacheMode?: PlanCacheMode | undefined;
  /**
   * A server-side ceiling, in milliseconds, on every statement this client's
   * connections run: PostgreSQL's `statement_timeout`. A statement that runs
   * longer is cancelled by the server, which rolls back its effect and frees the
   * connection, and it rejects with `TimeoutError` (E002, `outcome:
   * 'not-executed'`). It bounds what a per-query `timeout` cannot reach: a
   * forgotten query, a stream's `FETCH`, a statement inside `$transaction`.
   *
   * Applied as the `options=-c statement_timeout=...` connection parameter on
   * pools Turbine opens (the primary and string `replicas`), so it is in force
   * from each connection's first statement and nothing is ever `SET` on a
   * session. `0` sends `statement_timeout=0`, which disables a timeout the
   * server or role would otherwise apply. Unset (the default) sends nothing.
   *
   * Must be a non-negative integer (E003). PostgreSQL only (E017 elsewhere). An
   * external `pool` is not touched: the option is then a no-op with a one-time
   * dev warning, and the driver's own connection setup should set the GUC. A
   * connection pooler may refuse startup parameters (PgBouncer's
   * `ignore_startup_parameters`); set it on the role there instead
   * (`ALTER ROLE app SET statement_timeout = '30s'`).
   */
  statementTimeoutMs?: number | undefined;
  /**
   * Close a pooled connection once it is this many seconds old, when it is
   * next idle, and open a fresh one on demand. Default `1800` (30 minutes) on
   * pools Turbine opens; `0` keeps connections for as long as they are in use.
   *
   * Recycling bounds what a long-lived server session accumulates: the
   * prepared statements and their cached plans, catalog caches, and memory a
   * backend keeps after a large query. It also moves connections onto a new
   * server after a DNS failover or a replica scale-out. A connection that is
   * checked out is never closed under its holder; it is retired when it comes
   * back. Must be a non-negative integer (E003). Ignored, with a one-time dev
   * warning, on an external `pool`.
   */
  maxLifetimeSeconds?: number | undefined;
  /**
   * Close a cursor stream (`findManyStream`, `findManyStreamBatches`) and
   * release its connection once its consumer has asked for nothing for this
   * many milliseconds. Default `300000` (five minutes); `0` disables. A stream
   * call's own `idleTimeoutMs` overrides it.
   *
   * A consumer that stops pulling without calling `return()` (an iterator that
   * is stored and forgotten, a response stream torn down without propagating)
   * would otherwise hold a pooled connection forever and, on PostgreSQL, an
   * open transaction whose snapshot holds back vacuum for the whole database.
   * On expiry Turbine closes the cursor, releases the connection, and logs
   * `stream-idle-timeout`; the next pull, if one comes, throws `TimeoutError`
   * (E002). Only streams that hold a connection between pulls are watched.
   *
   * On PostgreSQL the stream's own transaction also gets a server-side limit,
   * `idle_in_transaction_session_timeout` at this value plus 10 seconds
   * (transaction-local, never a session `SET`; a stricter setting already in
   * force is kept), so a process that stops running timers (frozen between
   * serverless invocations) cannot hold the transaction open either. Must be a
   * whole number of milliseconds (E003).
   */
  streamIdleTimeoutMs?: number | undefined;
  /**
   * Append sqlcommenter-style key/values to every statement this client builds,
   * so `pg_stat_activity`, the server log, `auto_explain` and database APM
   * tools can attribute a statement to a service, model, feature or trace:
   *
   * ```sql
   * SELECT ... /*action='findMany',application='billing',model='users',tag='checkout'*\/
   * ```
   *
   * `static` adds constant pairs, `model: true` the table and operation,
   * `tag: true` the label of the innermost `db.$tag(label, fn)`, and `dynamic`
   * per-statement pairs computed in the caller's async context (a W3C
   * `traceparent`). Keys are lower-case `[a-z][a-z0-9_]*`; values are
   * URL-encoded (so none can end or nest the comment) and at most 256
   * characters. A malformed `static` key or value is E003 here; a bad
   * `dynamic` one is left out with a `sql-comment-dropped` warning, never
   * thrown.
   *
   * Model statements get it: reads, writes, streams, pipelines and
   * `$transaction` batches. Raw SQL, transaction control and `set_config`
   * calls do not. It is added after the SQL-template cache, so caching is
   * unchanged, and `$on('query')` events keep `sql` commentless and carry the
   * comment as `comment`.
   *
   * Prepared statements: a statement whose comment is static, model or tag is
   * still prepared, under a name of its own (counted against the same budget
   * as every other name). One carrying any `dynamic` value is sent unnamed,
   * so it is parsed and planned on every execution (tens of microseconds per
   * statement on a local PostgreSQL, more for nested reads): return dynamic
   * values only when they are worth that, for example only for sampled traces.
   *
   * Refused (E017) on PowDB, which runs no SQL, and `dynamic` on MySQL, whose
   * engine keeps a server-side prepared statement per distinct text and would
   * exhaust the server's `max_prepared_stmt_count`.
   */
  sqlComment?: SqlCommentOptions | undefined;
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
  scopedConnect?: boolean | undefined;
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
  relationLoadStrategy?: RelationLoadStrategy | undefined;
  /**
   * When `true`, every to-many `with` relation with no explicit `orderBy` is
   * loaded ordered by the target table's primary key ascending, so unordered
   * child arrays come back deterministically (json_agg / the batched loaders
   * otherwise leave that order engine-dependent, and `'auto'` fallback can change
   * it). An explicit per-relation `orderBy` always wins; a per-query
   * `stableRelationOrder` overrides this. Default `false` (SQL is byte-identical
   * when off). SQL engines only. See {@link RelationLoadStrategy}.
   */
  stableRelationOrder?: boolean | undefined;
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
  implicitPkOrdering?: boolean | undefined;
  /**
   * Parent-row ceiling for the `relationLoadStrategy: 'auto'` to-one rule: a
   * to-one relation stays in the single-statement join when the query's `limit`
   * bounds the parent set at or under this many rows, and loads batched when the
   * query is unbounded or bounded above it. Defaults to 1000 (see
   * `AUTO_TO_ONE_JOIN_MAX_ROWS`). Only consulted under `'auto'`.
   */
  autoToOneJoinMaxRows?: number | undefined;
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
  autoRoundTripMs?: number | undefined;
  /**
   * How nested-relation subqueries encode each row's JSON.
   *
   *   - `'object'`, `json_agg(json_build_object('key', v, …))`. Every key name
   *     is repeated in every nested object of every row.
   *   - `'positional'`, `json_agg(json_build_array(v, …))`. Turbine knows the
   *     column order at build time, so it emits a key-less array and maps
   *     positions back to keys client-side. Same information, a fraction of the
   *     bytes on wide/deeply-nested `with` trees. Parsed output is
   *     byte-identical to `'object'`.
   *
   * DEFAULTS BY ENGINE: `'positional'` on PostgreSQL, `'object'` on SQLite,
   * MySQL, SQL Server and PowDB. Positional is PostgreSQL-only, and setting it
   * on another engine throws `UnsupportedFeatureError` (E017) as soon as a
   * `with` clause is present, so the default cannot be one value everywhere.
   *
   * Why positional is the PostgreSQL default. `json_build_object` makes the
   * SERVER build the key names for every relation row, which is the whole
   * nested-read cost: measured on a 50-parent / ~10-child-per-parent read
   * against local PostgreSQL 17, server time 0.685 ms → 0.350 ms and 152 KB →
   * 100 KB on the wire, for rows that compare byte-identical.
   *
   * Reasons to set `'object'` (per query via `findMany({ jsonEncoding })`, or
   * here for a whole client): a readable statement in a query log, and
   * `relationLoadStrategy: 'flatten'`, which is refused while positional is
   * active because a flattened relation emits no JSON to encode.
   */
  jsonEncoding?: JsonEncoding | undefined;
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
  errorMessages?: ErrorMessageMode | undefined;
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
  logQueryParams?: boolean | undefined;
  /**
   * Enable prepared statements. Queries are submitted with `{ name, text, values }`
   * to the pg driver, which caches the parse+plan on the server per connection.
   *
   * Default: `true` for Turbine-owned pools, `false` for external pools (serverless
   * drivers may not support named statements) and for a connection string that
   * names a connection pooler (a `pooler` / `pgbouncer` host, or port 6432 or
   * 6543). A transaction-mode pooler runs each transaction on any server
   * connection, so a statement named on one is missing (or already present) on
   * the next, unless the pooler tracks prepared statements (PgBouncer 1.21+
   * with `max_prepared_statements` above 0). Set `true` on such a pooler only
   * when it does. Turbine warns once (`prepared-statements-on-pooler`) when you
   * set `true` and the connection settings name a pooler: Turbine's own, or
   * the `options` of a `pg.Pool` you pass as `pool` (since 0.90.2).
   *
   * Override with `TURBINE_DISABLE_PREPARED=1` env var.
   *
   * **A named statement is never deallocated**, so each pooled connection
   * retains every distinct SQL text it has parsed. That is safe while the set of
   * texts is fixed by your code, and it stops being fixed when a request decides
   * the shape. Turbine sends a `where`/`having` carrying a caller-written
   * `AND`/`OR` ARRAY unnamed for exactly this reason (see `markVariableArity`).
   * The case it CANNOT detect is a caller-chosen `select` / `omit` / `with`
   * subset: those change the projection and therefore the text, and nothing in
   * the shape distinguishes a hand-written projection from one built out of
   * `req.query.fields`. If you build projections from user input, map them
   * through a fixed allowlist or set this to `false`. Documented for readers at
   * https://turbineorm.dev/queries#client-escape-hatches
   */
  preparedStatements?: boolean | undefined;
  /**
   * Enable the SQL template cache. Repeated queries with the same shape reuse
   * cached SQL text instead of rebuilding from scratch.
   *
   * Default: `true`. Set to `false` as a nuclear kill switch.
   */
  sqlCache?: boolean | undefined;
  /**
   * Maximum number of distinct SQL templates each per-table LRU cache retains.
   *
   * Default: `1000`. Values are parameterized (`$1, $2, …`) and never fragment
   * the cache, so this bounds distinct query SHAPES. Raise it for apps with a
   * very large surface of query shapes to lift the hit rate at the cost of
   * memory; lower it to cap memory. `0` disables caching entirely (identical to
   * `sqlCache: false`); a negative value is ignored (treated as the default).
   */
  sqlCacheSize?: number | undefined;
  /** SQL dialect implementation. Defaults to PostgreSQL. Internal Phase-1 seam for dialect packages. */
  dialect?: Dialect | undefined;
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
  replicas?: readonly (string | PgCompatPool)[] | undefined;
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
  globalFilters?: GlobalFilters | undefined;
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
  logger: true,
  diagnostics: true,
  defaultLimit: true,
  warnOnUnlimited: true,
  utcTimestamps: true,
  temporalInfinity: true,
  planCacheMode: true,
  statementTimeoutMs: true,
  maxLifetimeSeconds: true,
  streamIdleTimeoutMs: true,
  sqlComment: true,
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

/**
 * The real config key `key` most likely meant, or null when nothing is close.
 *
 * {@link suggestKey} is shared with the prisma-compat query-option warner, so
 * both diagnostics rank near-misses identically.
 */
function suggestConfigKey(key: string): string | null {
  return suggestKey(key, CONFIG_KEY_SET);
}

/**
 * Notice for a key on the config object that is not part of the config surface.
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
 * Always on, whatever `diagnostics` says: an ignored option is ignored in
 * production too, and the line fires once per key per process.
 */
function warnUnknownConfigKeys(config: TurbineConfig, logger: TurbineLogger): void {
  try {
    for (const key of Object.keys(config)) {
      if (CONFIG_KEY_SET.has(key) || NON_CONFIG_KEYS.has(key)) continue;
      if (!shouldWarnOnce(WARN_NS.unknownConfigKey, key)) continue;
      const suggestion = suggestConfigKey(key);
      logTo(
        logger,
        'warn',
        `Unknown option "${key}" in the config passed to TurbineClient, it is ignored.` +
          (suggestion ? ` Did you mean "${suggestion}"?` : ''),
        { code: 'unknown-config-key', key, ...(suggestion ? { suggestion } : {}) },
      );
    }
  } catch {
    // Key enumeration is the only thing that can fail here, and a diagnostic
    // must never be the reason a client fails to construct.
  }
}

/**
 * Two bases that differ ONLY in host, used to detect whether the host pg ends
 * up with came from the connection string or from pg's own placeholder base.
 *
 * pg-connection-string resolves a connection string as `new URL(str,
 * 'postgres://base')`. A string with no scheme is therefore a RELATIVE url, and
 * silently inherits the literal host `base`, which is where
 * `getaddrinfo ENOTFOUND base` comes from. Parsing against two different bases
 * and comparing the resulting hostnames identifies that case exactly, and
 * cannot be fooled by a string that genuinely names a host called `base`.
 */
const CONNECTION_STRING_PROBE_BASES = ['postgres://turbine-probe-a', 'postgres://turbine-probe-b'] as const;

/** What pg will do with a connection string, from pg's own parsing rules. */
type ConnectionStringVerdict =
  | { kind: 'usable' }
  /** Relative URL: pg would connect to its internal placeholder host. */
  | { kind: 'phantom-host' }
  /** Not a URL at all under either attempt: pg's own parse throws. */
  | { kind: 'unparseable' };

/**
 * Classify a connection string by replaying the parse pg itself performs.
 *
 * This is a deliberate mirror of `pg-connection-string`'s `parse()`, in the
 * same order, because that function IS the oracle: anything it resolves to a
 * real host/socket is a string pg will connect with, and a validator that
 * refuses one of those breaks a working deployment. In particular all of these
 * are usable and must pass:
 *   - `/var/run/postgresql app` and `/cloudsql/proj:region:instance`, the
 *     leading-slash unix-socket form (peer auth, Cloud SQL),
 *   - `socket:/var/run/postgresql?db=app`, the explicit socket scheme,
 *   - `postgresql:///db`, `postgres:/db`, `postgres://`, all empty-host forms
 *     that fall back to pg's localhost default,
 *   - `postgres://user:pw@/db` (the `@/` dummy-host retry) and
 *     `?host=/var/run/postgresql` (host as a query parameter),
 *   - anything else that parses as an absolute URL, `localhost:5432` included.
 *
 * Only two shapes are not usable: a string with no scheme (pg substitutes its
 * placeholder host) and a string neither parse attempt can turn into a URL (pg
 * throws `Invalid URL` from its own constructor).
 */
function classifyConnectionString(value: string): ConnectionStringVerdict {
  // Leading slash: pg short-circuits to `{ host: <path>, database: <word 2> }`
  // before any URL parsing. Unix-domain socket directory or Cloud SQL path.
  if (value.charAt(0) === '/') return { kind: 'usable' };

  // pg percent-encodes before parsing, so a string with spaces (or a stray
  // half-written escape) reaches the URL constructor already encoded.
  const encoded = / |%[^a-f0-9]|%[a-f0-9][^a-f0-9]/i.test(value)
    ? encodeURI(value).replace(/%25(\d\d)/g, '%$1')
    : value;

  const parseAgainst = (base: string): { url: URL; dummyHost: boolean } | null => {
    try {
      return { url: new URL(encoded, base), dummyHost: false };
    } catch {
      // pg's own second attempt: `postgres://user:pw@/db` is not a valid URL,
      // so it retries with a placeholder authority and treats the host as empty.
      try {
        return { url: new URL(encoded.replace('@/', '@___DUMMY___/'), base), dummyHost: true };
      } catch {
        return null;
      }
    }
  };

  const a = parseAgainst(CONNECTION_STRING_PROBE_BASES[0]);
  const b = parseAgainst(CONNECTION_STRING_PROBE_BASES[1]);
  if (!a || !b) return { kind: 'unparseable' };

  // `socket:` is handled by its own branch in pg's parse: the pathname is the
  // socket directory and the base never contributes.
  if (a.url.protocol === 'socket:') return { kind: 'usable' };
  // The dummy-host retry only happens for an absolute URL, so the host is
  // empty by construction and pg falls back to its localhost default.
  if (a.dummyHost) return { kind: 'usable' };
  // A `host=` query parameter wins over the URL authority in pg's parse.
  if (a.url.searchParams.get('host')) return { kind: 'usable' };

  return a.url.hostname === b.url.hostname ? { kind: 'usable' } : { kind: 'phantom-host' };
}

/**
 * Reject a connection string pg cannot connect with, at construction, naming
 * the string as the problem.
 *
 * Without this, a typo'd or truncated string is handed to pg, which resolves it
 * as a URL relative to its own `postgres://base`, so the string silently
 * becomes a request for a host named `base`. The failure surfaces one query
 * later as `[TURBINE_E004] Database connection error: getaddrinfo ENOTFOUND
 * base`, and sends the reader looking for a DNS problem with a host they never
 * configured.
 *
 * The oracle is pg itself (see {@link classifyConnectionString}), not a scheme
 * pattern. An earlier scheme-matching version of this check refused
 * `/var/run/postgresql app` and `/cloudsql/project:region:instance`, which are
 * documented, working unix-socket connection strings, i.e. it broke peer-auth
 * and Cloud SQL deployments at `new TurbineClient(...)`.
 *
 * The empty string never reaches here: the call sites skip a falsy value, which
 * is exactly what the pool-building branch does with it, so
 * `connectionString: process.env.DATABASE_URL ?? ''` keeps constructing.
 */
function assertUsableConnectionString(value: string, source: string): void {
  // Whitespace-only is not empty: it is truthy, so pg WOULD take it, encode it
  // to `%20%20%20`, and resolve it against its placeholder host. Naming it as
  // empty is more useful than reporting the phantom host.
  if (value.trim().length === 0) {
    throw new ConnectionError(
      `The ${source} is empty. Expected a Postgres connection string such as ` +
        '"postgresql://user:password@host:5432/database".',
    );
  }

  const verdict = classifyConnectionString(value);
  if (verdict.kind === 'usable') return;

  // Never echo the value: it may carry a password, and it is malformed, so no
  // redaction written against the URL grammar can be trusted on it.
  const tail =
    '(Check for a missing "//", a stray quote copied out of a .env file, or a shell-truncated value.) ' +
    'The value is not included here because it may contain a password.';
  if (verdict.kind === 'unparseable') {
    throw new ConnectionError(
      `The ${source} cannot be parsed as a connection string, pg rejects it with "Invalid URL" ` +
        '(most often a non-numeric port). Expected something like ' +
        `"postgresql://user:password@host:5432/database". ${tail}`,
    );
  }
  // libpq keyword/value strings land here, and deserve their own sentence:
  // node-postgres does NOT implement that form, it feeds the whole string to
  // the URL parser, so `host=localhost dbname=app` becomes a request for the
  // host `base` with the database `host=localhost dbname=app`.
  const keywordForm = /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(value.trimStart())
    ? 'It looks like a libpq "host=… dbname=…" keyword/value string, which node-postgres does not support. '
    : '';
  throw new ConnectionError(
    `The ${source} names no host: it has no "postgres://" or "postgresql://" scheme, so pg would ` +
      `resolve it as a relative URL and try to connect to its internal placeholder host. ${keywordForm}` +
      `Expected something like "postgresql://user:password@host:5432/database". ${tail}`,
  );
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
   * Names must be namespaced custom settings (`app.current_tenant`, with a
   * dot). A name without a dot is one of PostgreSQL's own settings (`role`,
   * `search_path`, `statement_timeout`, `session_authorization`), which can
   * change who the transaction runs as or lift its limits, so it is refused
   * (E003) unless listed in {@link allowBuiltinSettings}. An application that
   * maps request data into the context then cannot be steered into setting one.
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
  /**
   * PostgreSQL's own settings that {@link sessionContext} may set, by name
   * (`['statement_timeout']`). Every other name in `sessionContext` must be a
   * namespaced custom setting. List only what the code itself chooses to set,
   * never a name taken from a request.
   */
  allowBuiltinSettings?: readonly string[];
  /**
   * Run the transaction READ ONLY (`BEGIN READ ONLY` on PostgreSQL, `START
   * TRANSACTION READ ONLY` on MySQL): any write inside it is refused by the
   * server. Use it for multi-statement reads that must see one consistent
   * snapshot (with `isolationLevel: 'RepeatableRead'`) and must not write.
   * Other engines have no read-only transaction and throw
   * `UnsupportedFeatureError` (E017).
   */
  readOnly?: boolean;
}

/** Which of a client's pools a pool event came from. */
export interface PoolEventOrigin {
  /** `'primary'`, or `'replica'` for one of the string `replicas`. */
  pool: 'primary' | 'replica';
  /** Index into `replicas` when `pool` is `'replica'`. */
  replica?: number;
}

/** A pool lifecycle event: the connection's error, and the pool it belonged to. */
export interface PoolEvent extends PoolEventOrigin {
  /** The driver's error: a server restart, an administrator's terminate, a network drop. */
  error: Error;
}

/**
 * `$on('poolError')`: an IDLE connection in a pool this client opened failed,
 * and the pool discarded it. No query was affected. Without a listener the
 * error is logged at `error` level (code `'pool-error'`), through `logger`.
 */
export type PoolErrorEvent = PoolEvent;

/**
 * `$on('connectionLost')`: a connection failed while CHECKED OUT, so the query,
 * stream or transaction using it rejected (with `ConnectionError`, E004).
 * Emitted once per connection, for pools this client opened.
 */
export type ConnectionLostEvent = PoolEvent;

/** The listener sets behind `$on('poolError')` and `$on('connectionLost')`. */
interface PoolListeners {
  poolError: Set<(event: PoolErrorEvent) => void>;
  connectionLost: Set<(event: ConnectionLostEvent) => void>;
}

export interface DisconnectOptions {
  /**
   * Stop waiting for checked-out connections after this many milliseconds.
   * Statements still running then are cancelled on the server and their
   * connections closed, so a transaction among them rolls back. Without it,
   * `disconnect()` waits for every connection to be returned.
   */
  timeoutMs?: number | undefined;
}

export interface DisconnectResult {
  /** True when connections were still checked out at the deadline and were closed. */
  timedOut: boolean;
  /** How many checked-out connections were cancelled and closed at the deadline. */
  forcedConnections: number;
}

/**
 * Maps isolation level names to SQL. Null-prototype and read through
 * {@link resolveIsolationLevel}, never indexed directly: an inherited key
 * (`constructor`, `toString`) would otherwise resolve to a function and be
 * interpolated verbatim into `BEGIN ISOLATION LEVEL …`.
 */
const ISOLATION_LEVELS: Record<string, string> = Object.assign(Object.create(null), {
  ReadUncommitted: 'READ UNCOMMITTED',
  ReadCommitted: 'READ COMMITTED',
  RepeatableRead: 'REPEATABLE READ',
  Serializable: 'SERIALIZABLE',
});

/**
 * Run a transaction-control statement (BEGIN / COMMIT / ROLLBACK) with the same
 * error translation every other query boundary gets.
 *
 * These four statements were the only ones issued raw, and COMMIT is the one
 * that matters: Postgres reports DEFERRABLE constraint violations and a good
 * share of SERIALIZABLE conflicts at COMMIT rather than at the statement that
 * caused them. Unwrapped, those surfaced as a raw `DatabaseError` carrying a
 * SQLSTATE in `.code`, which is the SAME property Turbine puts `TURBINE_E0NN`
 * in, so `err.code === 'TURBINE_E008'` silently missed them and a `switch` on
 * `.code` received a value from a foreign namespace. Worse for the retry case:
 * `SerializationFailureError.isRetryable` exists so callers can build retry
 * loops, and a loop keyed on it would never fire for the commit-time conflicts
 * that are the main reason to run SERIALIZABLE at all.
 */
async function runTxControl(client: PgCompatPoolClient, sql: string, params?: unknown[]): Promise<void> {
  try {
    await client.query(sql, params);
  } catch (err) {
    throw wrapPgError(err);
  }
}

/**
 * Refuse anything in a batch that is not a deferred query, before any of it
 * runs.
 *
 * The array forms take the descriptors `build*()` returns. Prisma's array form
 * takes promises instead, so code ported from it passes `db.users.create(...)`,
 * whose query has ALREADY started on its own connection, outside any
 * transaction, by the time the array exists. That cannot be undone here, so
 * the error says so and names the builder to use instead. The promise's own
 * rejection is observed, so this refusal is the error the caller sees rather
 * than an unhandled rejection from a query nobody awaits.
 */
function assertDeferredQueries(queries: readonly unknown[], api: string, unit: 'transaction' | 'pipeline'): void {
  queries.forEach((q, i) => {
    if (
      q !== null &&
      (typeof q === 'object' || typeof q === 'function') &&
      typeof (q as PromiseLike<unknown>).then === 'function'
    ) {
      Promise.resolve(q).catch(() => {});
      throw new ValidationError(
        `${api}: item ${i} is a Promise. Its query started running on its own the moment it was created, ` +
          `outside this ${unit}, and may already have committed. Pass the deferred form instead, built with ` +
          '`build*()`: `db.users.buildCreate(...)` rather than `db.users.create(...)` (likewise `buildUpdate`, ' +
          '`buildDelete`, `buildUpsert`, `buildFindMany`).' +
          (unit === 'transaction' ? ' Or use the callback form, `$transaction(async (tx) => { ... })`.' : ''),
      );
    }
    const dq = q as Partial<DeferredQuery<unknown>> | null;
    if (!dq || typeof dq !== 'object' || typeof dq.sql !== 'string' || typeof dq.transform !== 'function') {
      throw new ValidationError(
        `${api}: item ${i} is not a deferred query. Build each item with a \`build*()\` method, ` +
          'for example `db.users.buildCreate({ data })` or `db.posts.buildCount({ where })`.',
      );
    }
  });
}

/** The PG* variables pg reads for a connection target when its config leaves the field unset. */
const PG_ENV_TARGETS = ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER'] as const;

/** A non-empty environment variable, or undefined (also where `process` does not exist). */
function pgEnv(name: string): string | undefined {
  return (typeof process !== 'undefined' ? process.env?.[name] : undefined) || undefined;
}

/**
 * Whether an owned pool's config names a database at all: a connection
 * string, any host setting, DATABASE_URL (unless an explicit, empty
 * `connectionString` suppresses it, as the pool branch does), or a PG*
 * variable pg will read.
 */
function hasDatabaseTarget(config: TurbineConfig): boolean {
  if (config.connectionString) return true;
  if (
    config.host != null ||
    config.port != null ||
    config.database != null ||
    config.user != null ||
    config.password != null
  ) {
    return true;
  }
  if (config.connectionString == null && pgEnv('DATABASE_URL')) return true;
  return PG_ENV_TARGETS.some((name) => pgEnv(name) !== undefined);
}

/**
 * The pool of a client that was given no database: every query and checkout
 * rejects with a {@link ConnectionError} naming the fix, and `disconnect()`
 * succeeds. Building SQL never touches the pool, so it still works.
 */
function unconfiguredPool(emptyConnectionString: boolean): PgCompatPool {
  const fail = (): Promise<never> =>
    Promise.reject(
      new ConnectionError(
        'No database configured: ' +
          (emptyConnectionString
            ? "`connectionString` is an empty string, which names no database (often `process.env.DATABASE_URL ?? ''` " +
              'evaluated before DATABASE_URL was loaded). '
            : 'this client was given no `connectionString`, `pool` or host settings, and the DATABASE_URL environment ' +
              'variable is not set. ') +
          'turbine-orm does not read `.env` files: load yours before the app starts (`node --env-file=.env app.js`, ' +
          'or `process.loadEnvFile()` on Node 20.12 and later), or pass `connectionString` explicitly.',
      ),
    );
  return { query: fail, connect: fail, end: async () => {}, on: () => {} } as unknown as PgCompatPool;
}

/**
 * Resolve a requested isolation level, REFUSING anything not in the map.
 *
 * A miss rendered as a plain `BEGIN` would be the worst outcome for this
 * option: `isolationLevel: 'serializable'` (wrong case) would ask for
 * SERIALIZABLE and silently get READ COMMITTED. The TypeScript union does not
 * prevent it for a JavaScript caller, a value read from config, or any `as`.
 */
function resolveIsolationLevel(level: string | undefined): string | undefined {
  if (level === undefined) return undefined;
  const sql = ownLookup(ISOLATION_LEVELS, level);
  if (sql === undefined) {
    throw new ValidationError(
      `$transaction: unknown isolationLevel ${describeValue(level)}. ` +
        `Expected one of: ${Object.keys(ISOLATION_LEVELS).join(', ')} (case-sensitive).`,
    );
  }
  return sql;
}

/**
 * Strict GUC (session variable) name: an optionally namespaced identifier such
 * as `app.current_tenant` or `search_path`. Even though the name is passed as a
 * bound parameter to `set_config`, a malformed name is a programmer error worth
 * rejecting loudly before it reaches the database.
 */
const GUC_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/**
 * How long a transaction being abandoned (timed out, failed, or returned with
 * work still running) gives its in-flight statement to answer a cancel
 * request, and its ROLLBACK to answer, before the connection is destroyed
 * instead of reused.
 */
const TX_ABORT_GRACE_MS = 2000;

/** Default {@link TurbineConfig.maxLifetimeSeconds} on pools Turbine opens. */
const DEFAULT_MAX_LIFETIME_SECONDS = 1800;

/**
 * A value as an error message should quote it. `JSON.stringify` writes `NaN` and
 * `Infinity` as `null`, throws on a bigint, and returns `undefined` for a symbol
 * or a function, so a message built from it can name a value the caller never
 * passed.
 */
function describeValue(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'bigint':
      return `${value}n`;
    case 'symbol':
      return value.toString();
    case 'function':
      return 'a function';
    case 'object':
      return value === null ? 'null' : Array.isArray(value) ? 'an array' : 'an object';
    default:
      return String(value);
  }
}

/**
 * `allowBuiltinSettings` as a lower-cased set (PostgreSQL folds setting names).
 * Each entry must be a plain un-dotted setting name; anything else is E003.
 */
function resolveBuiltinSettingsAllowlist(value: unknown): ReadonlySet<string> {
  if (value === undefined) return new Set();
  if (!Array.isArray(value)) {
    throw new ValidationError(
      `$transaction: allowBuiltinSettings must be an array of setting names, received ${typeof value}.`,
    );
  }
  const names = new Set<string>();
  for (const name of value) {
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new ValidationError(
        `$transaction: allowBuiltinSettings entry ${describeValue(name)} is not a PostgreSQL setting name ` +
          '(a plain identifier such as "statement_timeout"). Namespaced custom settings need no entry.',
      );
    }
    names.add(name.toLowerCase());
  }
  return names;
}

/**
 * SQLSTATEs with which the server refuses a `set_config`, and what each means
 * for the caller. A function of the setting where the cause depends on it: the
 * same SQLSTATE says "no such role" for `role` and "unreadable duration" for
 * `statement_timeout`.
 */
const SESSION_SETTING_REFUSALS: Readonly<Record<string, (setting: string) => string>> = Object.assign(
  Object.create(null),
  {
    '22023': (setting: string) =>
      setting === 'role' || setting === 'session_authorization'
        ? 'the value is not valid for this setting (the role must exist)'
        : 'the value is not valid for this setting',
    '42704': () => 'the server has no setting by that name',
    '42501': () => 'the database role is not allowed to change it',
    '55P02': () => 'it cannot be changed after the connection has started',
  },
);

/**
 * Apply one `sessionContext` entry. A refusal by the server names the setting
 * that caused it rather than reading as a column or type error; the server's
 * own message (which may contain the value) stays on `cause`.
 */
async function applySessionSetting(
  client: PgCompatPoolClient,
  setting: { name: string; sql: string; params: unknown[] },
): Promise<void> {
  try {
    await client.query(setting.sql, setting.params);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    const describe = typeof code === 'string' ? SESSION_SETTING_REFUSALS[code] : undefined;
    if (describe === undefined) throw wrapPgError(err);
    throw new ValidationError(
      `sessionContext["${setting.name}"] was refused by the server: ${describe(setting.name.toLowerCase())} (SQLSTATE ${code}). ` +
        'The transaction was rolled back before your callback ran.',
      { cause: err },
    );
  }
}

/** A non-negative safe integer config value, or `undefined` when unset. Anything else is E003. */
function resolveNonNegativeInteger(value: unknown, name: string, unit: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError(
      `Invalid ${name}: ${typeof value === 'string' ? JSON.stringify(value) : String(value)}. Expected a ` +
        `non-negative whole number of ${unit}.`,
    );
  }
  return value;
}

/**
 * The statement that opens a transaction, read-only when asked. PostgreSQL and
 * MySQL both accept `READ ONLY` after their own BEGIN form (`BEGIN [ISOLATION
 * LEVEL x] READ ONLY`, `[SET TRANSACTION ISOLATION LEVEL x; ]START TRANSACTION
 * READ ONLY`); the other engines have no read-only transaction.
 */
function beginStatementFor(dialect: Dialect, isolationSql: string | undefined, readOnly: boolean): string {
  const begin = dialect.beginStatement(isolationSql);
  if (!readOnly) return begin;
  if (dialect.capabilities.readOnlyTransactions) return `${begin} READ ONLY`;
  throw new UnsupportedFeatureError(
    '$transaction({ readOnly: true })',
    dialect.name,
    'This engine has no read-only transaction mode. Drop the option, or enforce read-only access with a ' +
      'database role that has no write privileges.',
  );
}

/** `readOnly` as a boolean; anything but a boolean or `undefined` is E003. */
function resolveReadOnly(value: unknown): boolean {
  if (value === undefined || value === false) return false;
  if (value === true) return true;
  throw new ValidationError(`$transaction: readOnly must be true or false, received ${describeValue(value)}.`);
}

/** Whether `pending` settles (either way) within `ms`. */
async function settlesWithin(pending: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([
      pending.then(
        () => true,
        () => true,
      ),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stop a transaction that will not commit, on the server and now: cancel the
 * statement it is running (the protocol's CancelRequest, which also reaches the
 * right backend through a pooler), wait for it to answer, then ROLLBACK, which
 * releases every lock the transaction holds.
 *
 * Closing the socket alone does not do that. PostgreSQL notices a closed
 * client only when it next writes to it, so a backend waiting on a lock keeps
 * the transaction, and every lock it already took, until that lock clears.
 *
 * Resolves `true` when the connection is rolled back and reusable, `false` when
 * it is not (the cancel could not be sent, the statement or the ROLLBACK did not
 * answer within {@link TX_ABORT_GRACE_MS}, or the ROLLBACK failed); the caller
 * then destroys it. Call after `state.end()`, so nothing new is sent meanwhile.
 */
async function rollbackOnServer(
  client: PgCompatPoolClient,
  state: TransactionState,
  dialect: Dialect,
): Promise<boolean> {
  if (state.running) {
    if (!(await sendCancelRequest(client, TX_ABORT_GRACE_MS))) return false;
    if (!(await state.whenIdle(TX_ABORT_GRACE_MS))) return false;
  }
  let failed = false;
  const rollback = client.query(dialect.rollbackStatement()).catch(() => {
    failed = true;
  });
  return (await settlesWithin(rollback, TX_ABORT_GRACE_MS)) && !failed;
}

/** `rawUnsafe` takes statement text; a tagged-template call or a non-string is E003. */
function assertSqlText(text: unknown, api: string): asserts text is string {
  if (typeof text === 'string' && text.trim() !== '') return;
  throw new ValidationError(
    Array.isArray(text)
      ? `${api} takes the statement as a string, not as a tagged template. Use raw\`...\` or sql\`...\` for a ` +
          'template, whose values are bound for you.'
      : `${api} takes the statement text as a non-empty string, received ${text === null ? 'null' : typeof text}.`,
  );
}

/**
 * The connection `transaction(fn)` and `tx.$connection()` hand out: the
 * checked-out client, with every statement routed through the transaction's
 * state, so one issued after the transaction settled is refused rather than
 * run on a connection that is back in the pool, and transaction-control SQL
 * (`COMMIT`, `BEGIN`, ...) is refused rather than ending the transaction behind
 * the state that tracks it.
 *
 * What would take the connection away is refused too: `release` (the
 * transaction returns it itself), `end` and `connect`, and the driver's
 * `connection` (the wire-level object, whose writes bypass every check here) is
 * hidden. Everything else is the driver client's own.
 */
function closableRawClient(
  client: PgCompatPoolClient,
  state: TransactionState,
  scope: TransactionScope = state.rootScope,
  api: 'transaction()' | '$connection()' = 'transaction()',
): PgCompatPoolClient {
  // The refusals name the API the caller used: a `tx.$connection()` caller
  // never called `transaction()`.
  const who = api === 'transaction()' ? 'transaction(): the callback' : '$connection(): the $transaction callback';
  const target = client as unknown as Record<PropertyKey, unknown>;
  const send = target.query as (...args: unknown[]) => unknown;
  const query = (...args: unknown[]): unknown => {
    const first = args[0] as { submit?: unknown; text?: unknown } | string | null;
    const text = typeof first === 'string' ? first : first?.text;
    // Callback form and submittables (cursors, COPY streams) answer through
    // their own channel, not a promise: checked, then passed straight through.
    if (
      typeof args[args.length - 1] === 'function' ||
      typeof (first as { submit?: unknown } | null)?.submit === 'function'
    ) {
      state.assertOpen();
      state.screenRaw(text);
      return send.apply(client, args);
    }
    return state.runRaw(text, () => send.apply(client, args) as Promise<unknown>, scope);
  };
  const release = (): never => {
    throw new ValidationError(
      `${who} must not release its client; the transaction releases it after COMMIT or ROLLBACK.`,
    );
  };
  const refuse = (verb: string): (() => never) => {
    return () => {
      throw new ValidationError(
        `${who} must not ${verb} its client; the transaction owns the connection and ` +
          'returns it to the pool after COMMIT or ROLLBACK.',
      );
    };
  };
  const refused = new Map<PropertyKey, () => never>([
    ['end', refuse('end')],
    ['connect', refuse('connect')],
  ]);
  const bound = new Map<PropertyKey, unknown>();
  return new Proxy(target, {
    has(t, prop) {
      return prop === 'connection' ? false : Reflect.has(t, prop);
    },
    get(t, prop) {
      if (prop === 'query') return query;
      if (prop === 'release') return release;
      if (prop === 'connection') return undefined;
      const refusal = refused.get(prop);
      if (refusal !== undefined) return refusal;
      const value = Reflect.get(t, prop, t);
      if (typeof value !== 'function') return value;
      let fn = bound.get(prop);
      if (fn === undefined) {
        fn = (value as (...a: unknown[]) => unknown).bind(t);
        bound.set(prop, fn);
      }
      return fn;
    },
  }) as unknown as PgCompatPoolClient;
}

/**
 * Operations that may be served by a read replica: the `read` entries of
 * {@link TABLE_METHODS}. Every other method (writes, `build*`, internals) stays
 * on the primary. A Set so the routing proxy's `get` trap is O(1).
 *
 * Derived, not listed, because a hand-kept list drifts SILENTLY: a read method
 * missing here keeps working on the primary, so no test fails. A new public
 * QueryInterface method cannot compile until it is classified in TABLE_METHODS.
 * `src/test/read-operations-drift.test.ts` is the run-time check.
 *
 * Exported for that test only.
 */
export const READ_OPERATIONS: ReadonlySet<string> = new Set(
  Object.entries(TABLE_METHODS)
    .filter(([, kind]) => kind === 'read')
    .map(([name]) => name),
);

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
 *
 * Closed when its transaction settles (commit, rollback, timeout, error): every
 * later call through it throws `ValidationError` (E003) instead of running on a
 * connection that is back in the pool and may belong to another request.
 */
export class TransactionClient {
  private readonly tableCache = new Map<string, QueryInterface<object>>();
  /** Active SQL dialect, owns savepoint keywords and raw-SQL placeholders. */
  private readonly dialect: Dialect;
  /** Open/closed state, first failure and savepoint blocks, shared by everything this client hands out. */
  private readonly state: TransactionState;
  /**
   * Where in the transaction this handle sits: the transaction itself, or the
   * nested block whose callback received it. Statements carry it, so one issued
   * through an outer handle from inside a block can be told from one issued
   * through the block's own.
   */
  private readonly scope: TransactionScope;
  /** What {@link $connection} hands out, built on first use. */
  private connectionHandle?: PgCompatPoolClient;

  constructor(
    private readonly client: PgCompatPoolClient,
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
    /**
     * The state of the transaction this client belongs to. `$transaction`
     * passes the one it opened, which also turns on per-write savepoints for
     * multi-statement writes. Omitted for Turbine's own implicit transactions.
     */
    state?: TransactionState,
    /** The nested block this handle belongs to; omitted for the transaction's own handle. */
    scope?: TransactionScope,
  ) {
    this.dialect = queryOptions?.dialect ?? postgresDialect;
    this.state = state ?? new TransactionState(client, this.dialect);
    this.scope = scope ?? this.state.rootScope;
    // Auto-create typed table accessors for all tables in the schema
    for (const tableName of Object.keys(schema.tables)) {
      const camelName = tableAccessorName(tableName);
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
      const txOpts = txQueryOptions(this.queryOptions);
      qi = txOpts.queryInterfaceFactory
        ? asQueryInterface(txOpts.queryInterfaceFactory(txPool, name, this.schema, this.middlewares, txOpts))
        : new QueryInterface<object>(txPool, name, this.schema, this.middlewares, txOpts);
      if (this.state.savepointWrites) savepointMultiStatementWrites(qi, this.schema.tables[name], this.state);
      this.tableCache.set(name, qi);
    }
    return qi as unknown as QueryInterface<T>;
  }

  /**
   * The driver connection this transaction runs on, for code that needs one:
   * another library's query function, a COPY stream, a driver feature Turbine
   * does not wrap. Statements sent on it run inside this transaction.
   *
   * - It closes with the transaction: a statement sent after COMMIT or
   *   ROLLBACK is refused with `ValidationError` (E003) instead of running on a
   *   connection that is back in the pool.
   * - `release()` is refused. The transaction returns the connection.
   * - COMMIT, ROLLBACK, BEGIN, SAVEPOINT, RELEASE and SET TRANSACTION are
   *   refused with `ValidationError` (E003): the transaction ends itself, and
   *   Turbine would then commit or roll back a transaction that is no longer
   *   open. Use `tx.$transaction` for a savepoint.
   * - `end()` and `connect()` are refused like `release()`, and the driver's
   *   `connection` object is not reachable through it.
   * - Its queries use the driver's own parsers. On a pool you supplied, that is
   *   your parser configuration, not Turbine's int8 and UTC readings.
   *
   * Typed as the driver-neutral client. For the pg-only surface, cast:
   * `tx.$connection() as unknown as PoolClient`.
   *
   * Throws `UnsupportedFeatureError` (E017) where no driver connection backs
   * the transaction: PowDB, and a stateless HTTP driver.
   */
  $connection(): PgCompatPoolClient {
    this.state.assertOpen();
    if (this.connectionHandle) return this.connectionHandle;
    const raw = rawClientOf(this.client);
    const driver = this.dialect.capabilities.connectionDriver;
    if (driver === 'none') {
      throw new UnsupportedFeatureError(
        'tx.$connection()',
        this.dialect.name,
        'A PowDB transaction has no driver connection to hand out. Run PowQL inside it with `tx.rawUnsafe(text, ...values)`.',
      );
    }
    if (driver === 'pg-compatible' && typeof (raw as { on?: unknown }).on !== 'function') {
      throw new UnsupportedFeatureError(
        'tx.$connection()',
        this.dialect.name,
        'The pool returned a client with no event support, as a stateless HTTP driver does, so there is no ' +
          'connection to hand out. Use `tx.raw` / `tx.rawUnsafe`, or a TCP pool.',
      );
    }
    this.connectionHandle = closableRawClient(raw, this.state, this.scope, '$connection()');
    return this.connectionHandle;
  }

  /**
   * Execute a nested transaction via SAVEPOINT.
   *
   * If the inner function throws, only the savepoint is rolled back. Blocks
   * started side by side (`Promise.all`) run one after another, because
   * savepoints are a stack on the connection and a rollback in one would
   * otherwise undo a sibling that already reported success.
   *
   * The callback receives a `tx` of its own, bound to the block. Use it for the
   * work inside the block: a statement through the OUTER `tx` from inside the
   * block would run in the block's savepoint and be undone with it, so it is
   * refused with `ValidationError` (E003).
   */
  async $transaction<R>(fn: (tx: TransactionClient) => Promise<R>): Promise<R> {
    return this.state.withBlock((scope) => fn(this.inScope(scope)), this.scope);
  }

  /** A handle on the same transaction bound to nested block `scope`. */
  private inScope(scope: TransactionScope): TransactionClient {
    return new TransactionClient(
      this.client,
      this.schema,
      this.middlewares,
      this.queryOptions,
      this.sourcePool,
      this.state,
      scope,
    );
  }

  /**
   * Execute a raw SQL query within this transaction, as a tagged template:
   * every `${value}` is sent as a bound parameter.
   */
  async raw<T extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]> {
    const { sql, params } = buildTypedSql(strings, values, this.dialect, 'raw');
    return this.runRaw<T>(sql, params, 'raw');
  }

  /**
   * Execute SQL text built at runtime within this transaction. See
   * {@link TurbineClient.rawUnsafe}: nothing in `text` is escaped, so it must
   * never contain untrusted input. Values go in `values`, referenced as `$1`,
   * `$2`, ... (the engine's own placeholders on other engines).
   */
  async rawUnsafe<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    ...values: unknown[]
  ): Promise<T[]> {
    assertSqlText(text, 'rawUnsafe');
    return this.runRaw<T>(text, values, 'rawUnsafe');
  }

  /**
   * Typed raw SQL on this transaction's connection, like
   * {@link TurbineClient.sql}: await it for `T[]`, or call `.one()` /
   * `.scalar()`. Refused, like every other `tx` call, once the transaction has
   * settled.
   */
  sql<T extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): TypedSqlQuery<T> {
    this.state.assertOpen();
    const { sql, params: bound } = buildTypedSql(strings, values, this.dialect);
    const params = this.rawParams(bound, 'sql');
    const state = this.state;
    const client = this.client;
    const scope = this.scope;
    const pool = {
      query: (text: string, vals?: unknown[]) => state.runRaw(text, () => client.query(text, vals), scope),
    } as unknown as PgCompatPool;
    return new TypedSqlQuery<T>(pool, sql, params, false, undefined, this.queryOptions?._onQuery);
  }

  private async runRaw<T>(sql: string, values: unknown[], action: string): Promise<T[]> {
    const params = this.rawParams(values, action);
    const result = await this.state.runRaw(
      sql,
      () =>
        runReportedStatement(
          this.queryOptions?._onQuery,
          rawIdentity(action),
          sql,
          params,
          () => this.client.query(sql, params),
          wrapPgError,
        ),
      this.scope,
    );
    return result.rows as T[];
  }

  /** Bound Dates as UTC text on a PostgreSQL client reading temporal types as UTC. */
  private rawParams(params: unknown[], api: string): unknown[] {
    return this.dialect.capabilities.utcTimestampRewrite && this.queryOptions?.utcTimestamps !== false
      ? utcDateParams(params, api)
      : params;
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
   * runs no middleware, and it emits one `$on('query')` event with model
   * `'$raw'` and `action` set to the optional `action` label (the adapter
   * passes `'$queryRaw'` / `'$executeRaw'` ...; default `'rawQuery'`).
   */
  async rawQuery<T extends object = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
    action = 'rawQuery',
  ): Promise<{ rows: T[]; rowCount: number | null }> {
    const bound = this.rawParams(params as unknown[], action);
    const result = await this.state.runRaw(
      text,
      () =>
        runReportedStatement(
          this.queryOptions?._onQuery,
          rawIdentity(action),
          text,
          bound,
          () => this.client.query(text, bound),
          wrapPgError,
        ),
      this.scope,
    );
    return { rows: result.rows as T[], rowCount: result.rowCount };
  }

  /**
   * Create a pool-like wrapper around the transaction client.
   * This allows QueryInterface to work with the transaction connection
   * without knowing it's in a transaction.
   *
   * pg driver errors thrown by queries are translated into typed Turbine
   * errors via wrapPgError so transaction-scoped queries surface the same
   * typed errors as pool-scoped queries. Every statement passes through the
   * transaction state, which refuses it once the transaction has settled.
   */
  private createTxPool(): PgCompatPool {
    const client = this.client;
    const state = this.state;
    const scope = this.scope;
    const query = (textOrConfig: string | { name?: string; text: string; values?: unknown[] }, values?: unknown[]) =>
      state.run(async () => {
        try {
          if (typeof textOrConfig === 'string') {
            return await client.query(textOrConfig, values);
          }
          // Object form for prepared statements: { name, text, values }
          // A driver client accepts it, but the two-argument `query` in the
          // PgCompatPoolClient contract does not describe it, so we cast.
          return await (client as unknown as { query(config: unknown): Promise<PgCompatQueryResult> }).query(
            textOrConfig,
          );
        } catch (err) {
          throw wrapPgError(err);
        }
      }, scope);
    // Return a minimal pool-compatible object that routes queries
    // through the transaction client
    const txPool: Record<PropertyKey, unknown> = {
      query,
      // The transaction's connection is not this pool's to lend: a "checkout"
      // runs on it through the same guarded `query`, and releasing it is a
      // no-op, so nothing reached through the pool can hand the connection back
      // to the real pool while the transaction still holds it.
      connect: async () => {
        state.assertOpen();
        return { query, release: () => {} };
      },
      [TRANSACTION_STATE]: state,
    };
    // Carry the parent pool's PowDB-only flags through so a transaction-scoped
    // PowqlInterface reads the same read-only guard and capabilities it would
    // outside the transaction (a plain pg pool has neither, so nothing changes).
    if (this.sourcePool?.readonly !== undefined) txPool.readonly = this.sourcePool.readonly;
    if (this.sourcePool?.capabilities !== undefined) txPool.capabilities = this.sourcePool.capabilities;
    return txPool as unknown as PgCompatPool;
  }
}

// query/builder.ts opens an implicit transaction with this class but sits
// below this module in the import graph, so the class is handed over here,
// once, when this module is evaluated (see transaction-client-slot.ts).
registerTransactionClient(TransactionClient);

/**
 * Give each multi-statement write on a transaction-scoped accessor its own
 * savepoint: `create` / `update` carrying nested relation writes, and an
 * `upsert` that looks the row up first.
 *
 * Joining the caller's transaction statement by statement, a failure raised
 * part way through (a nested `connect` that finds nothing, a validation error
 * found mid-walk) would leave the statements before it in place, and a caller
 * that caught the error and went on would commit half of the write. In its own
 * savepoint the write is all or nothing, and the caller's transaction
 * continues either way.
 *
 * Installed as own methods on the accessor this transaction created and owns,
 * so a single-statement write pays one property lookup and a shape check.
 */
function savepointMultiStatementWrites(
  qi: QueryInterface<object>,
  meta: TableMetadata | undefined,
  state: TransactionState,
): void {
  if (!meta) return;
  const target = qi as unknown as Record<string, (args: Record<string, unknown> | undefined) => Promise<unknown>>;
  const nestedData = (args: Record<string, unknown> | undefined): boolean => {
    const data = args?.data;
    return data !== null && typeof data === 'object' && hasRelationFields(data as Record<string, unknown>, meta);
  };
  const lookupUpsert = (args: Record<string, unknown> | undefined): boolean => {
    const needsLookup = (qi as unknown as { upsertNeedsLookup?: (a: unknown) => boolean }).upsertNeedsLookup;
    return typeof needsLookup === 'function' && args !== undefined && needsLookup.call(qi, args);
  };
  const wrap = (
    method: 'create' | 'update' | 'upsert',
    multiStatement: (args: Record<string, unknown> | undefined) => boolean,
  ) => {
    const original = target[method];
    if (typeof original !== 'function') return;
    Object.defineProperty(qi, method, {
      value: (args: Record<string, unknown> | undefined) =>
        multiStatement(args) ? state.withSavepoint(() => original.call(qi, args)) : original.call(qi, args),
      configurable: true,
      writable: true,
    });
  };
  wrap('create', nestedData);
  wrap('update', nestedData);
  wrap('upsert', lookupUpsert);
}

// ---------------------------------------------------------------------------
// TurbineClient
// ---------------------------------------------------------------------------

export class TurbineClient {
  /**
   * The underlying connection pool, exposed for escape hatches.
   *
   * Typed as the driver-neutral {@link PgCompatPool} rather than `pg.Pool`,
   * because it is only a `pg.Pool` when Turbine opened it: supply
   * {@link TurbineConfig.pool} and this is whatever driver you passed (Neon,
   * Vercel Postgres, Hyperdrive), and on the non-Postgres engines it is that
   * engine's pool shim. `query` / `connect` / `end` are the members every
   * driver has. For the pg-only surface (cursors, `copyFrom`/`copyTo`, pool
   * events), import `Pool` from the pg package and cast:
   * `db.pool as unknown as Pool`.
   */
  readonly pool: PgCompatPool;
  /**
   * The pool Turbine's own statements go through: {@link pool}, or for a
   * caller-supplied PostgreSQL pool a view of it whose queries carry Turbine's
   * int8 and temporal parsers (see supplied-pool-types.ts). `pool` stays the
   * caller's object, and queries the caller runs on it keep their parsers.
   */
  private readonly queryPool: PgCompatPool;

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
  /** Where this client's log lines go (the `logger` option, else console). */
  private readonly logger: TurbineLogger;
  /** The `diagnostics` option, resolved once at construction. */
  private readonly diagnostics: ResolvedDiagnostics;
  /** Active SQL dialect, owns transaction keywords, set_config, raw-SQL placeholders, capability flags. */
  private readonly dialect: Dialect;
  /** Validated `plan_cache_mode` to pin on every owned connection, or undefined to issue nothing. */
  private readonly planCacheMode: PlanCacheMode | undefined;
  private readonly tableCache = new Map<string, QueryInterface<object>>();
  private readonly middlewares: Middleware[] = [];
  private readonly queryListeners = new Set<QueryEventListener>();
  private queryOptions: QueryInterfaceOptions;
  /** The resolved `sqlComment` every accessor shares, for the batch paths that bypass them. */
  private get sqlCommenter(): SqlCommenter | undefined {
    return this.queryOptions._sqlCommenter;
  }
  private readonly errorMessagesSafe: boolean;
  /**
   * THIS client's error-message mode. Not the process default: see
   * {@link registerClientErrorMessageMode}. Used to scope every operation
   * issued through this client, but only once two clients in the process have
   * asked for different modes.
   */
  private readonly errorMessageMode: ErrorMessageMode;
  /** Per-table mode-scoping accessors, built lazily (see {@link table}). */
  private readonly errorScopedTableCache = new Map<string, QueryInterface<object>>();
  /** Whether `$on('query')` events carry real params (see `logQueryParams`). */
  private readonly queryParamsVisible: boolean;
  /** True when Turbine created the pool and is responsible for tearing it down */
  private readonly ownsPool: boolean = true;
  /** Active LISTEN subscriptions, torn down on disconnect() so it never hangs */
  private readonly activeSubscriptions = new Set<ActiveSubscription>();
  /** `$on('poolError')` / `$on('connectionLost')` listeners. */
  private readonly poolListeners: PoolListeners = { poolError: new Set(), connectionLost: new Set() };
  /** What each pool Turbine opened has checked out, for `disconnect({ timeoutMs })`. */
  private readonly checkoutWatches: CheckoutWatch[] = [];

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
      this.logger = parent.logger;
      this.diagnostics = parent.diagnostics;
      this.dialect = parent.dialect;
      this.errorMessagesSafe = parent.errorMessagesSafe;
      this.errorMessageMode = parent.errorMessageMode;
      this.queryParamsVisible = parent.queryParamsVisible;
      this.queryOptions = parent.queryOptions;
      this.middlewares = parent.middlewares; // shared reference: $use on parent flows through
      this.poolListeners = parent.poolListeners;
      this.pool = parent.pool;
      this.queryPool = parent.queryPool;
      this.ownsPool = false;
      this.replicaPools = [];
      this.ownedReplicaPools = [];
      this.replicaTableCaches = [];
      for (const tableName of Object.keys(schema.tables)) {
        const camelName = tableAccessorName(tableName);
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
        'TurbineClient requires schema metadata as its second argument. ' +
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
          `Table "${name}" in the schema passed to TurbineClient has no \`columns\` array, so this is ` +
            'not runtime SchemaMetadata. A `defineSchema()` result is a SchemaDef: convert it with ' +
            '`schemaDefToMetadata(def)`, or use the metadata emitted by `npx turbine generate`.',
        );
      }
      break;
    }
    // The logger and the diagnostics mode are validated first, so every line
    // below, the construction warnings included, reaches the caller's logger.
    // NODE_ENV is read here and nowhere on a query path.
    const logger = resolveLogger(config.logger);
    const diagnostics = resolveDiagnostics(config.diagnostics);
    // Name any key on the config object that is not part of the config surface
    // (once per key, never throws). See warnUnknownConfigKeys.
    warnUnknownConfigKeys(config, logger);
    // ALL config validation runs before ANY process-global side effect below.
    // A constructor that throws must leave the process exactly as it found it:
    // settling the process-global parser mode and then rejecting the config
    // would poison the next, valid, TurbineClient with a phantom conflict.
    const dialect = config.dialect ?? postgresDialect;
    assertDialectCapabilities(dialect);
    const planCacheMode = TurbineClient.resolvePlanCacheMode(config.planCacheMode, dialect);
    const statementTimeoutMs = TurbineClient.resolveStatementTimeout(config.statementTimeoutMs, dialect);
    const maxLifetimeSeconds = resolveNonNegativeInteger(config.maxLifetimeSeconds, 'maxLifetimeSeconds', 'seconds');
    const streamIdleTimeoutMs = resolveStreamIdleTimeout(config.streamIdleTimeoutMs, 'streamIdleTimeoutMs');
    // A backend that injects its own query interface (PowDB) builds no SQL,
    // so there is nothing for a comment to ride on: refused, not ignored.
    const sqlComment = resolveSqlComment(config.sqlComment, logger, {
      dialect: dialect.name,
      preparesEveryStatement: dialect.capabilities.preparesEveryStatement,
      buildsSql: (config as { queryInterfaceFactory?: unknown }).queryInterfaceFactory === undefined,
    });
    // Keyed by table name, with every key checked against the schema: a
    // filter under a name that matches no table would never be applied.
    // A non-SQL backend (PowDB) injects its own query interface and checks
    // its own filters; every SQL engine compiles each static filter here once,
    // with this client's dialect, so a value the compiler refuses fails now.
    const factory = (config as { queryInterfaceFactory?: unknown }).queryInterfaceFactory;
    const globalFilters = normalizeGlobalFilters(
      config.globalFilters,
      schema,
      factory === undefined ? { QueryInterface, dialect, utcTimestamps: config.utcTimestamps } : undefined,
    );
    // Refuse a connection string that cannot address a database, before it
    // reaches pg's permissive parser and comes back one query later as a DNS
    // error about a fragment of itself. Only the strings this client will
    // actually USE are checked: with an external pool the connection target is
    // the caller's, and an explicit host/port/user config makes DATABASE_URL
    // irrelevant (the same precedence the pool-building branch below applies).
    // The truthiness checks here mirror the pool-building branch below EXACTLY.
    // An empty `connectionString` is ignored there (pg ignores it too), so
    // `connectionString: process.env.DATABASE_URL ?? ''` must keep constructing,
    // and it still suppresses the DATABASE_URL fallback because
    // `hasExplicitConnection` tests `!= null`, not truthiness.
    if (!config.pool) {
      if (config.connectionString) {
        assertUsableConnectionString(config.connectionString, 'connectionString');
      } else if (
        config.connectionString == null &&
        config.host == null &&
        config.port == null &&
        config.database == null &&
        config.user == null &&
        config.password == null &&
        process.env.DATABASE_URL
      ) {
        assertUsableConnectionString(process.env.DATABASE_URL, 'DATABASE_URL environment variable');
      }
    }
    for (const [i, replica] of (config.replicas ?? []).entries()) {
      // Only string replicas are ours to open; a PgCompatPool entry is already
      // connected by its owner. An empty string is skipped for the same reason
      // as above: pg ignores a falsy connectionString and uses its defaults.
      if (typeof replica === 'string' && replica) {
        assertUsableConnectionString(replica, `replicas[${i}] connection string`);
      }
    }
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
    // too. With an external primary, Turbine's own queries carry the parsers
    // per query instead, on the primary and on every replica (see typedPool).
    // Registration is constructor-gated by the static flags, so it happens at
    // most once.
    const ownsAnyPool = !config.pool;
    if (ownsAnyPool && !TurbineClient.int8ParserRegistered) {
      warnParserOverwrite(20, 'int8', logger);
      pg.types.setTypeParser(20, parseInt8);
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
      registerUtcTemporalParsers(logger);
      TurbineClient.utcTimestampParsersRegistered = true;
    }
    TurbineClient.utcTimestampParserMode = wantUtcTimestamps;

    this.logging = config.logging ?? false;
    this.logger = logger;
    this.diagnostics = diagnostics;
    this.dialect = dialect;
    this.planCacheMode = planCacheMode;
    this.schema = schema;
    // Respect env var kill switch
    const envDisablePrepared = typeof process !== 'undefined' && process.env?.TURBINE_DISABLE_PREPARED === '1';
    const pooler = config.pool ? undefined : TurbineClient.poolerEndpoint(config);
    // A supplied pool defaults to unnamed statements, so its endpoint is read
    // only to warn when they are turned on behind a pooler.
    if (config.preparedStatements === true) {
      const endpoint = config.pool ? TurbineClient.suppliedPoolEndpoint(config.pool) : pooler;
      if (endpoint !== undefined) TurbineClient.warnPreparedOnPooler(endpoint, logger);
    }

    this.errorMessageMode = config.errorMessages ?? 'safe';
    this.errorMessagesSafe = this.errorMessageMode === 'safe';
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
      globalFilters,
      preparedStatements: envDisablePrepared ? false : (config.preparedStatements ?? (!config.pool && !pooler)),
      // Forwarded so a per-query `forceCustomPlan` can refuse the combination
      // this client's own connections would silently defeat, see the
      // `planCacheMode` note on QueryInterfaceOptions.
      planCacheMode,
      sqlCache: config.sqlCache ?? true,
      sqlCacheSize: config.sqlCacheSize,
      streamIdleTimeoutMs,
      _sqlCommenter: sqlComment,
      dialect: config.dialect,
      diagnostics,
      logger,
      // Non-SQL backends (PowDB) inject a factory that builds their own query
      // interface (PowqlInterface) instead of the SQL QueryInterface. SQL engines
      // never set this, so `table()` keeps constructing `new QueryInterface`.
      queryInterfaceFactory: (config as { queryInterfaceFactory?: QueryInterfaceOptions['queryInterfaceFactory'] })
        .queryInterfaceFactory,
      _onQuery: (event: QueryEvent) => {
        if (this.queryListeners.size === 0) return;
        // The $tag() scope is read here, at the one seam every emitter shares,
        // so a tag reaches model, raw, pipeline and batch events alike.
        const tag = event.tag ?? currentQueryTag();
        const tagged = tag === undefined || event.tag !== undefined ? event : { ...event, tag };
        const emitted = this.queryParamsVisible ? tagged : { ...tagged, params: tagged.params.map(() => '[REDACTED]') };
        for (const listener of this.queryListeners) {
          try {
            listener(emitted);
          } catch (e) {
            if (this.logging)
              logTo(this.logger, 'error', 'Query listener error:', { code: 'query-listener-error', error: e });
          }
        }
      },
    };

    // Apply NotFoundError message redaction mode (default: safe, values are
    // stripped from messages to avoid leaking PII into error logs).
    //
    // The process-wide default keeps being set here, unchanged, so a directly
    // constructed error and any single-client process behave exactly as before.
    // What is new is the REGISTRATION: a second client asking for a different
    // mode makes both of them scope their own operations, instead of the last
    // constructor silently deciding for everyone (see
    // registerClientErrorMessageMode). Registration uses the client's effective
    // mode, defaulted, because two clients only agree if their EFFECTIVE modes
    // agree, and an omitted `errorMessages` is an effective 'safe'.
    registerClientErrorMessageMode(this.errorMessageMode);
    if (config.errorMessages) {
      setErrorMessageMode(config.errorMessages);
    }

    if (config.pool) {
      // External pool, use directly. Turbine doesn't manage its lifecycle.
      this.pool = config.pool;
      // Turbine registers no parsers for a pool it did not open, so its own
      // queries on this one carry them instead.
      this.queryPool = this.typedPool(config.pool);
      this.ownsPool = false;
      if (this.logging) {
        const tables = Object.keys(schema.tables).length;
        logTo(this.logger, 'debug', `Using external pool, ${tables} tables`, { code: 'external-pool', tables });
      }
    } else if (!hasDatabaseTarget(config)) {
      // Nothing names a database: no pool, connection string, host settings,
      // DATABASE_URL or PG* variable. The first query fails with the fix,
      // which beats connecting to a guessed localhost. Failing here instead
      // would break every build step that imports the client without a database.
      this.pool = unconfiguredPool(config.connectionString === '');
      this.queryPool = this.pool;
      this.ownsPool = true;
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
        // A default filled in here would override the PG* variable pg reads
        // for the same field, so a field the environment sets is left to pg.
        poolConfig.host = config.host ?? (pgEnv('PGHOST') ? undefined : 'localhost');
        poolConfig.port = config.port ?? (pgEnv('PGPORT') ? undefined : 5432);
        poolConfig.database = config.database ?? (pgEnv('PGDATABASE') ? undefined : 'postgres');
        poolConfig.user = config.user ?? (pgEnv('PGUSER') ? undefined : 'postgres');
        poolConfig.password = config.password;
      }

      if (config.ssl !== undefined) {
        poolConfig.ssl = config.ssl;
      }

      // Held as a `pg.Pool` for the length of this block: `PgCompatPool.on` is
      // optional (HTTP drivers have no pool events), and here we know we own a
      // real pg pool that has one. Same shape as the replica loop below.
      const ownPool = new pg.Pool(
        TurbineClient.ownedPoolConfig(poolConfig, planCacheMode, statementTimeoutMs, maxLifetimeSeconds),
      );
      this.watchOwnedPool(ownPool, { pool: 'primary' });
      // After a freeze (a serverless function between invocations), wait one
      // loop turn before reusing a long-idle connection, so the pool has read
      // any close the server sent meanwhile. See connection-guard.ts.
      settleLongIdleCheckouts(ownPool);
      // An exhausted pool rejects a checkout with an untyped pg-pool error;
      // make it a ConnectionError on every path, `pool.query` included.
      typeCheckoutTimeouts(ownPool);
      this.pool = ownPool;
      this.queryPool = ownPool;
      this.ownsPool = true;

      if (this.logging) {
        const tables = Object.keys(schema.tables).length;
        logTo(this.logger, 'debug', `Pool created, max ${poolConfig.max} connections, ${tables} tables`, {
          code: 'pool-created',
          max: poolConfig.max,
          tables,
        });
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
          TurbineClient.ownedPoolConfig(
            {
              connectionString: replica,
              max: config.poolSize ?? config.max ?? 10,
              idleTimeoutMillis: config.idleTimeoutMs ?? config.idleTimeoutMillis ?? 30_000,
              connectionTimeoutMillis: config.connectionTimeoutMs ?? config.connectionTimeoutMillis ?? 5_000,
              ...(config.ssl !== undefined ? { ssl: config.ssl } : {}),
            },
            planCacheMode,
            statementTimeoutMs,
            maxLifetimeSeconds,
          ),
        );
        this.watchOwnedPool(replicaPool, { pool: 'replica', replica: this.replicaPools.length });
        settleLongIdleCheckouts(replicaPool);
        typeCheckoutTimeouts(replicaPool);
        // Next to a supplied primary no parsers were registered, so this
        // replica's reads carry them like the primary's do.
        this.replicaPools.push(this.ownsPool ? replicaPool : this.typedPool(replicaPool));
        this.ownedReplicaPools.push(replicaPool);
      } else {
        this.replicaPools.push(this.typedPool(replica));
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
    // also skip external pools silently. Always on, like every construction
    // warning: the option is just as ignored in production.
    if (this.planCacheMode !== undefined && !this.ownsPool) {
      if (shouldWarnOnce(WARN_NS.planCacheModeIgnored, this.planCacheMode)) {
        const replicaNote =
          this.ownedReplicaPools.length > 0
            ? ` It IS applied to the ${this.ownedReplicaPools.length} Turbine-owned read replica pool(s) on this ` +
              'client, so reads and writes would run under different plan-cache policies until the primary is set too.'
            : '';
        logTo(
          this.logger,
          'warn',
          `planCacheMode: '${this.planCacheMode}' was not applied to the primary: this client was given an ` +
            'external `pool`, whose connection lifecycle the caller owns, so Turbine never opens its connections. Set ' +
            `\`plan_cache_mode\` in the driver's own connection setup (or run \`SET plan_cache_mode = ${this.planCacheMode}\` ` +
            `on checkout) instead.${replicaNote}`,
          { code: 'plan-cache-mode-ignored', option: 'planCacheMode', ownedReplicas: this.ownedReplicaPools.length },
        );
      }
    }
    this.warnExternalPoolOptions(statementTimeoutMs, maxLifetimeSeconds);
    this.replicaTableCaches = this.replicaPools.map(() => new Map<string, QueryInterface<object>>());
    if (this.logging && this.replicaPools.length > 0) {
      const replicas = this.replicaPools.length;
      const owned = this.ownedReplicaPools.length;
      logTo(this.logger, 'debug', `${replicas} read replica(s) configured (${owned} owned)`, {
        code: 'replicas-configured',
        replicas,
        owned,
      });
    }

    // Auto-create typed table accessors for all tables in the schema
    for (const tableName of Object.keys(schema.tables)) {
      const camelName = tableAccessorName(tableName);
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
        `Invalid planCacheMode: ${JSON.stringify(mode)}. Expected one of ${PLAN_CACHE_MODES.map((m) => `'${m}'`).join(
          ', ',
        )}.`,
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
   * The pg pool config for a pool Turbine opens: the `maxLifetimeSeconds`
   * recycling default, plus `plan_cache_mode` and `statement_timeout` pinned
   * on every connection through the pool's **connection parameters** rather
   * than a `SET`.
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
  private static ownedPoolConfig(
    poolConfig: pg.PoolConfig,
    planCacheMode: PlanCacheMode | undefined,
    statementTimeoutMs: number | undefined,
    maxLifetimeSeconds: number | undefined,
  ): pg.PoolConfig {
    let config: pg.PoolConfig = {
      ...poolConfig,
      maxLifetimeSeconds: maxLifetimeSeconds ?? DEFAULT_MAX_LIFETIME_SECONDS,
    };
    // `planCacheMode` is a member of PLAN_CACHE_MODES and `statementTimeoutMs`
    // a narrowed integer, never caller text, which is what makes these
    // literals safe: a GUC value cannot be a bind parameter.
    if (planCacheMode !== undefined) config = withStartupSetting(config, `-c plan_cache_mode=${planCacheMode}`);
    const timeout = statementTimeoutMs === undefined ? null : statementTimeoutSetting(statementTimeoutMs);
    if (timeout !== null) config = withStartupSetting(config, timeout);
    return config;
  }

  /**
   * Validate `statementTimeoutMs`: a non-negative integer (E003), on
   * PostgreSQL only (E017), since it is applied as a PostgreSQL connection
   * parameter.
   */
  private static resolveStatementTimeout(value: unknown, dialect: Dialect): number | undefined {
    const ms = resolveNonNegativeInteger(value, 'statementTimeoutMs', 'milliseconds');
    if (ms !== undefined && !dialect.capabilities.connectionParameters) {
      throw new UnsupportedFeatureError(
        `The statementTimeoutMs option (statement_timeout = ${ms})`,
        dialect.name,
        '`statement_timeout` is applied as a PostgreSQL connection parameter. Remove the option on this engine, ' +
          'and bound slow statements with the per-query `timeout` instead.',
      );
    }
    return ms;
  }

  /**
   * The first connection target this client opens that names a connection
   * pooler (see `detectPooler`), as `host:port`, or `undefined`. Covers the
   * connection string, the DATABASE_URL fallback, host/port settings, and
   * string replicas, each read the way node-postgres reads it: a host or port
   * the target leaves unset is `PGHOST` / `PGPORT`.
   */
  private static poolerEndpoint(config: TurbineConfig): string | undefined {
    const explicit =
      config.connectionString != null ||
      config.host != null ||
      config.port != null ||
      config.database != null ||
      config.user != null ||
      config.password != null;
    const targets: ConnectionTarget[] = [];
    if (config.connectionString) targets.push(parseConnectionTarget(config.connectionString));
    else if (!explicit && process.env.DATABASE_URL) targets.push(parseConnectionTarget(process.env.DATABASE_URL));
    else {
      targets.push({
        host: config.host ? config.host.toLowerCase() : null,
        port: typeof config.port === 'number' ? config.port : null,
      });
    }
    for (const replica of config.replicas ?? []) {
      if (typeof replica === 'string' && replica) targets.push(parseConnectionTarget(replica));
    }
    return TurbineClient.firstPooledTarget(targets);
  }

  /**
   * The pooler a pool the CALLER supplied connects to, read from the settings
   * node-postgres keeps on the pool (`pool.options`, which `pg.Pool` and the
   * drivers built on it expose), the way {@link poolerEndpoint} reads Turbine's
   * own: the connection string wins over `host` / `port`, and an unset host or
   * port is `PGHOST` / `PGPORT`. `undefined` for a pool that exposes no
   * settings (another driver) or names no pooler.
   */
  private static suppliedPoolEndpoint(pool: PgCompatPool): string | undefined {
    // A diagnostic: a pool whose settings cannot be read is simply not checked,
    // and nothing here may fail the constructor.
    let target: ConnectionTarget;
    try {
      const options: unknown = (pool as { options?: unknown }).options;
      if (options === null || typeof options !== 'object') return undefined;
      const { connectionString, host, port } = options as {
        connectionString?: unknown;
        host?: unknown;
        port?: unknown;
      };
      if (typeof connectionString === 'string' && connectionString) {
        target = parseConnectionTarget(connectionString);
      } else {
        const portNumber = typeof port === 'string' ? Number.parseInt(port, 10) : port;
        target = {
          host: typeof host === 'string' && host ? host.toLowerCase() : null,
          port: typeof portNumber === 'number' && Number.isInteger(portNumber) ? portNumber : null,
        };
      }
    } catch {
      return undefined;
    }
    return TurbineClient.firstPooledTarget([target]);
  }

  /** The first of `targets` that names a pooler, as `host:port`, after filling unset parts from the environment. */
  private static firstPooledTarget(targets: readonly ConnectionTarget[]): string | undefined {
    const environment = { host: pgEnv('PGHOST'), port: pgEnv('PGPORT') };
    for (const target of targets) {
      const found = detectPoolerTarget(fillTargetFromEnvironment(target, environment));
      if (found.pooled) return `${found.host ?? 'localhost'}:${found.port ?? 5432}`;
    }
    return undefined;
  }

  /** Always on: named statements behind a transaction pooler fail in production first. */
  private static warnPreparedOnPooler(endpoint: string, logger: TurbineLogger): void {
    if (!shouldWarnOnce(WARN_NS.preparedStatementsOnPooler, endpoint)) return;
    logTo(
      logger,
      'warn',
      `preparedStatements: true on ${endpoint}, which looks like a connection pooler. In transaction ` +
        'mode a pooler runs each transaction on any server connection, so a statement named on one fails on ' +
        'the next ("prepared statement ... does not exist" or "already exists") unless the pooler tracks ' +
        'prepared statements: PgBouncer 1.21+ with max_prepared_statements above 0. If yours does not, leave ' +
        'preparedStatements unset; Turbine then sends unnamed statements to a pooler.',
      { code: 'prepared-statements-on-pooler', endpoint },
    );
  }

  /**
   * `pool` as Turbine's own statements should reach it: with Turbine's int8
   * and temporal parsers on every query, for a PostgreSQL pool built on
   * node-postgres. Any other pool is returned unchanged.
   */
  private typedPool(pool: PgCompatPool): PgCompatPool {
    if (this.dialect.capabilities.connectionDriver !== 'pg-compatible') return pool;
    return typedQueryPool(pool, this.queryOptions.utcTimestamps !== false) ?? pool;
  }

  /**
   * Listen to a pool this client opened: its idle-connection errors become
   * `poolError` events, a checked-out connection's loss a `connectionLost`
   * event, and its checkouts are tracked for `disconnect({ timeoutMs })`.
   * Also the connection guards every owned pool gets (connection-guard.ts):
   * no unheard `'error'`, a settle after a freeze, typed checkout timeouts.
   */
  private watchOwnedPool(pool: pg.Pool, origin: PoolEventOrigin): void {
    pool.on('error', (err) => this.emitPoolEvent('poolError', { error: err, ...origin }));
    absorbCheckedOutErrors(pool);
    this.checkoutWatches.push(
      watchCheckouts(pool, (err) => this.emitPoolEvent('connectionLost', { error: err, ...origin })),
    );
  }

  /**
   * Hand a pool event to its listeners. A `poolError` with no listener is
   * logged at `error`, always; a listener that throws is ignored, like a query
   * listener.
   */
  private emitPoolEvent(kind: keyof PoolListeners, event: PoolEvent): void {
    const listeners = this.poolListeners[kind];
    if (listeners.size === 0) {
      if (kind === 'poolError') {
        logTo(this.logger, 'error', `Unexpected ${event.pool} pool error: ${event.error.message}`, {
          code: 'pool-error',
          pool: event.pool,
          ...(event.replica !== undefined ? { replica: event.replica } : {}),
          error: event.error,
        });
      }
      return;
    }
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (e) {
        if (this.logging) {
          logTo(this.logger, 'error', `${kind} listener error:`, {
            code: 'pool-listener-error',
            listener: kind,
            error: e,
          });
        }
      }
    }
  }

  /**
   * `statementTimeoutMs` and an explicit `maxLifetimeSeconds` reach only the
   * pools Turbine opens. On an external primary they do nothing, which a
   * warning says once, naming where the setting belongs instead. Always on: an
   * ignored timeout means no timeout in production.
   */
  private warnExternalPoolOptions(
    statementTimeoutMs: number | undefined,
    maxLifetimeSeconds: number | undefined,
  ): void {
    if (this.ownsPool) return;
    const ownedReplicas = this.ownedReplicaPools.length;
    if (statementTimeoutMs !== undefined && shouldWarnOnce(WARN_NS.connectionOptionIgnored, 'statementTimeoutMs')) {
      logTo(
        this.logger,
        'warn',
        `statementTimeoutMs: ${statementTimeoutMs} was not applied to the primary: this client was given an ` +
          "external `pool`, whose connections Turbine never opens. Set `statement_timeout` in the driver's own " +
          "connection setup, or on the role (`ALTER ROLE app SET statement_timeout = '30s'`)." +
          (ownedReplicas > 0 ? ' It IS applied to the Turbine-owned read replica pools.' : ''),
        { code: 'connection-option-ignored', option: 'statementTimeoutMs', ownedReplicas },
      );
    }
    if (maxLifetimeSeconds !== undefined && shouldWarnOnce(WARN_NS.connectionOptionIgnored, 'maxLifetimeSeconds')) {
      logTo(
        this.logger,
        'warn',
        `maxLifetimeSeconds: ${maxLifetimeSeconds} was not applied to the primary: this client was given ` +
          "an external `pool`, whose connection lifecycle the caller owns. Set it on that pool's own options." +
          (ownedReplicas > 0 ? ' It IS applied to the Turbine-owned read replica pools.' : ''),
        { code: 'connection-option-ignored', option: 'maxLifetimeSeconds', ownedReplicas },
      );
    }
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
      `utcTimestamps: ${want} conflicts with utcTimestamps: ${settled}, which an earlier TurbineClient ` +
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
    // The errorMessages accessors too: each proxy holds its target by closure,
    // so a stale one keeps handing back the pre-$use QueryInterface. Every
    // cache `table()` reads through has to be listed here, and this one is the
    // OUTERMOST, so leaving it out silently defeats all three above.
    this.errorScopedTableCache.clear();
  }

  // -------------------------------------------------------------------------
  // Event emitter, subscribe to query lifecycle events
  // -------------------------------------------------------------------------

  /**
   * Subscribe to client events:
   *   - `'query'`: one {@link QueryEvent} per statement.
   *   - `'poolError'`: an idle pooled connection failed ({@link PoolErrorEvent}).
   *   - `'connectionLost'`: a checked-out connection failed ({@link ConnectionLostEvent}).
   *
   * Pool events come from the pools this client opened; an external `pool`
   * emits its own. Any other event name throws `ValidationError` (E003).
   */
  $on(event: 'query', listener: QueryEventListener): void;
  $on(event: 'poolError', listener: (event: PoolErrorEvent) => void): void;
  $on(event: 'connectionLost', listener: (event: ConnectionLostEvent) => void): void;
  $on(event: string, listener: (event: never) => void): void {
    this.listenersFor(event, '$on').add(listener as never);
  }

  $off(event: 'query', listener: QueryEventListener): void;
  $off(event: 'poolError', listener: (event: PoolErrorEvent) => void): void;
  $off(event: 'connectionLost', listener: (event: ConnectionLostEvent) => void): void;
  $off(event: string, listener: (event: never) => void): void {
    this.listenersFor(event, '$off').delete(listener as never);
  }

  private listenersFor(event: string, api: string): Set<never> {
    if (event === 'query') return this.queryListeners as Set<never>;
    if (event === 'poolError' || event === 'connectionLost') return this.poolListeners[event] as Set<never>;
    throw new ValidationError(
      `${api}: unknown event ${JSON.stringify(event)}. Expected 'query', 'poolError' or 'connectionLost'.`,
    );
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
    const base = this.replicaPools.length === 0 ? this.primaryTableQI(name) : this.routingAccessor(name);
    // The errorMessages accessor is built ALWAYS, not only once two clients have
    // diverged. It used to be conditional here, and the condition was wrong in
    // the one direction that leaks: divergence is a property of the PROCESS over
    // time, while a table accessor is handed out once and kept. An application
    // that does `const users = db.users` at module load, then constructs a
    // second client with `errorMessages: 'verbose'` later (an analytics client,
    // a per-suite test harness), held a bare unscoped reference forever, so the
    // safe client's `findUniqueOrThrow` misses started rendering row values.
    // Building the proxy unconditionally is what makes the mode a property of
    // the client rather than of the construction order.
    //
    // The divergence check did not disappear, it moved INSIDE the wrapper, so it
    // is asked when the operation runs rather than when the accessor is minted.
    // While every client agrees the wrapper still establishes no scope and the
    // query path still pays nothing but one proxy trap.
    let scoped = this.errorScopedTableCache.get(name);
    if (!scoped) {
      scoped = this.createErrorModeAccessor(base);
      this.errorScopedTableCache.set(name, scoped);
    }
    return scoped as unknown as QueryInterface<T>;
  }

  /** Get (and cache) the replica-routing accessor for a table. */
  private routingAccessor(name: string): QueryInterface<object> {
    let proxy = this.routingProxyCache.get(name);
    if (!proxy) {
      proxy = this.createRoutingAccessor(name);
      this.routingProxyCache.set(name, proxy);
    }
    return proxy;
  }

  /**
   * Wrap a table accessor so every operation called through it runs with THIS
   * client's `errorMessages` mode in force, whatever another client set as the
   * process default.
   *
   * A proxy rather than a wrapper object: the QueryInterface mutates its own
   * instance state during a query, so methods must run with the real instance
   * as `this` (the same reason {@link createRoutingAccessor} is built this
   * way). Method wrappers are memoized per property so a hot loop allocates one
   * closure per operation NAME, not per call.
   *
   * The divergence test lives in the wrapper body, evaluated when the operation
   * is CALLED. That placement is the point: an accessor minted before a second
   * client diverges still scopes correctly once it does, and while no client has
   * diverged the module default is already this client's mode, so the wrapper
   * calls straight through and no AsyncLocalStorage scope is established at all.
   */
  private createErrorModeAccessor(target: QueryInterface<object>): QueryInterface<object> {
    const mode = this.errorMessageMode;
    // Keyed by name AND the function found under it, so a method replaced
    // after first use (a spy, a mock, an APM patch) is the one that runs.
    const wrapped = new Map<string, { fn: unknown; wrapper: unknown }>();
    return new Proxy(target, {
      get(t, prop, receiver) {
        const value = Reflect.get(t, prop, receiver);
        if (typeof value !== 'function' || typeof prop !== 'string') return value;
        const hit = wrapped.get(prop);
        if (hit !== undefined && hit.fn === value) return hit.wrapper;
        const wrapper = (...args: unknown[]) => {
          const call = () => (value as (...a: unknown[]) => unknown).apply(t, args);
          return errorMessageModesDiverged() ? runWithErrorMessageMode(mode, call) : call();
        };
        wrapped.set(prop, { fn: value, wrapper });
        return wrapper;
      },
    }) as QueryInterface<object>;
  }

  /**
   * Run `fn` with this client's `errorMessages` mode in force, or directly when
   * no other client in the process has diverged from it (the common case, which
   * costs nothing). Used by the entry points that do not go through
   * {@link table}: transactions, raw SQL, `pipeline`, and the typed-SQL builder.
   *
   * The typed-SQL builder is the one that cannot be covered by wrapping the
   * call, because it is lazy: `sql` hands this function to `TypedSqlQuery` so
   * the scope reaches the EXECUTION rather than the template. This docstring
   * listed it as covered before 0.66 and it was not, which is the reason the
   * mechanism is spelled out here instead of just named.
   */
  private withErrorMode<R>(fn: () => R): R {
    return errorMessageModesDiverged() ? runWithErrorMessageMode(this.errorMessageMode, fn) : fn();
  }

  /** Get (and cache) the primary-pool-bound QueryInterface for a table. */
  private primaryTableQI(name: string): QueryInterface<object> {
    let qi = this.tableCache.get(name);
    if (!qi) {
      qi = this.buildTableQI(this.queryPool, name);
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
    return this.queryOptions?.queryInterfaceFactory
      ? asQueryInterface(
          this.queryOptions.queryInterfaceFactory(pool, name, this.schema, this.middlewares, this.queryOptions),
        )
      : new QueryInterface<object>(pool, name, this.schema, this.middlewares, this.queryOptions);
  }

  /**
   * Build the read/write routing proxy for a table. The proxy targets the
   * primary QueryInterface (so writes, `build*`, and every non-read member work
   * unchanged); read operations are intercepted and dispatched to a replica.
   */
  private createRoutingAccessor(name: string): QueryInterface<object> {
    const primaryQI = this.primaryTableQI(name);
    const client = this;
    // One routing function per operation, so the accessor above can tell a
    // replaced method from this one by identity.
    const routed = new Map<string, (...args: unknown[]) => unknown>();
    return new Proxy(primaryQI, {
      get(target, prop, receiver) {
        // A read replaced on the accessor (a spy, a mock) is an own property of
        // the primary instance, and runs as installed rather than routed past.
        if (typeof prop !== 'string' || !READ_OPERATIONS.has(prop) || Object.hasOwn(target, prop)) {
          return Reflect.get(target, prop, receiver);
        }
        let route = routed.get(prop);
        if (route === undefined) {
          // Pick the replica at CALL time so round-robin advances per operation.
          route = (...args: unknown[]) => {
            const replicaQI = client.nextReplicaTableQI(name) as unknown as Record<
              string,
              ((...a: unknown[]) => unknown) | undefined
            >;
            const method = replicaQI[prop];
            if (typeof method !== 'function') {
              return (Reflect.get(target, prop, receiver) as (...a: unknown[]) => unknown).apply(target, args);
            }
            return method.apply(replicaQI, args);
          };
          routed.set(prop, route);
        }
        return route;
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
   * Typed as `this` so a generated subclass keeps its declared table accessors
   * through the call (`db.$primary().users`, the form in the example below).
   * With the base class as the return type the accessors were gone and the only
   * typed route was `db.$primary().table('users')`. The view is a base-class
   * instance built from the same schema, so at runtime it carries every table
   * accessor the subclass `declare`s; the cast states exactly that.
   *
   * @example
   * ```ts
   * await db.users.create({ data: { email: 'a@b.com' } });
   * // Read-after-write: guaranteed to see the row just inserted.
   * const user = await db.$primary().users.findFirst({ where: { email: 'a@b.com' } });
   * ```
   */
  $primary(): this {
    if (this.replicaPools.length === 0) return this;
    if (!this.primaryView) {
      this.primaryView = new TurbineClient(
        { [PRIMARY_VIEW]: { parent: this } } as unknown as TurbineConfig,
        this.schema,
      );
    }
    return this.primaryView as this;
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
  pipeline<T extends readonly DeferredQuery<unknown>[]>(...queries: T): Promise<PipelineResults<T>>;
  pipeline<T extends readonly DeferredQuery<unknown>[]>(
    queries: readonly [...T],
    options?: PipelineOptions,
  ): Promise<PipelineResults<T>>;
  async pipeline<T extends readonly DeferredQuery<unknown>[]>(
    ...args: T | [T, PipelineOptions?]
  ): Promise<PipelineResults<T>> {
    let queries: T;
    let options: PipelineOptions | undefined;

    // Detect which overload was used. A deferred query is never an array, so
    // an array first argument is the array form whatever it contains; its
    // items are checked below like the rest form's.
    if (args.length > 0 && Array.isArray(args[0])) {
      // Array form: pipeline([q1, q2], opts?)
      queries = args[0] as unknown as T;
      options = args[1] as PipelineOptions | undefined;
    } else {
      // Rest-param form: pipeline(q1, q2, q3)
      queries = args as unknown as T;
    }
    assertDeferredQueries(queries, 'pipeline', 'pipeline');
    // A locking read outside a transaction would release its locks before
    // the caller saw the rows; a transactional pipeline keeps them for the batch.
    if (options?.transactional === false) assertNoLockInAutocommitPipeline(queries);

    if (this.logging) {
      const tags = queries.map((q) => q.tag);
      logTo(this.logger, 'debug', `Pipeline: ${queries.length} queries, ${tags.join(', ')}`, {
        code: 'pipeline',
        queries: queries.length,
        tags,
      });
    }
    // Scoped like every other entry point. A pipeline builds NotFoundErrors (a
    // `buildFindUniqueOrThrow` slot) and wraps driver errors into
    // `PipelineError.results[i]`, and none of that went through a mode scope
    // before, so a safe client's miss inside a pipeline rendered the caller's
    // where VALUES as soon as any verbose client existed in the process. The
    // scope is established around the await, so every continuation of the batch
    // resolves this client's mode.
    // Each statement carries the `sqlComment` its query interface would have
    // given it, computed here in the caller's async context.
    const comments = this.statementComments(queries);
    const sent = comments ? (queries.map((q, i) => commentDeferred(q, comments[i])) as unknown as T) : queries;
    const sink = this.queryListeners.size > 0 ? this.queryOptions._onQuery : undefined;
    if (!sink && !queryChannelActive()) return this.withErrorMode(() => executePipeline(this.queryPool, sent, options));
    return this.withErrorMode(() => this.reportedPipeline(sink, queries, options, sent, comments));
  }

  /**
   * The `sqlComment` of each deferred query, named by its own model and action
   * (a pipeline can mix tables), or `undefined` when this client adds none.
   */
  private statementComments(queries: readonly DeferredQuery<unknown>[]): (string | undefined)[] | undefined {
    const commenter = this.sqlCommenter;
    if (commenter === undefined) return undefined;
    return queries.map((q) => {
      const { model, action } = deferredIdentity(q.tag);
      return commenter.commentFor(model, action)?.comment;
    });
  }

  /**
   * {@link pipeline} with one `$on('query')` event per statement. Only taken
   * when a listener is registered, so an unobserved pipeline runs exactly as
   * before. Each statement's `transform` is wrapped to capture the driver's
   * row count on the way through (the pipeline returns transformed values, not
   * driver results). The statements share one round trip, so the batch's wall
   * time is split evenly across them and each event carries
   * `batch: 'pipeline'`.
   */
  private async reportedPipeline<T extends readonly DeferredQuery<unknown>[]>(
    sink: ((event: QueryEvent) => void) | undefined,
    queries: T,
    options: PipelineOptions | undefined,
    sent: T,
    comments: (string | undefined)[] | undefined,
  ): Promise<PipelineResults<T>> {
    const rowCounts: (number | undefined)[] = new Array(queries.length).fill(undefined);
    const observed = sent.map((q, i) => ({
      ...q,
      transform: (raw: PgCompatQueryResult) => {
        rowCounts[i] = resultRowCount(raw);
        return q.transform(raw);
      },
    })) as unknown as T;
    const traces = queries.map((q) => {
      const { model, action } = deferredIdentity(q.tag);
      return startQueryTrace(model, action, q.sql, q.params.length, 'pipeline');
    });
    const start = performance.now();
    let failure: unknown;
    try {
      return await executePipeline(this.queryPool, observed, options);
    } catch (err) {
      failure = err;
      throw err;
    } finally {
      const duration = (performance.now() - start) / queries.length;
      // PipelineError names the failing slot; any other failure (connect,
      // BEGIN) is charged to the first statement that produced no result.
      const failedIndex =
        failure === undefined
          ? -1
          : failure instanceof PipelineError && failure.failedIndex !== undefined
            ? failure.failedIndex
            : rowCounts.indexOf(undefined);
      queries.forEach((q, i) => {
        const failed = i === failedIndex;
        const error =
          failure === undefined ? undefined : failure instanceof Error ? failure : new Error(String(failure));
        // A traced slot is always settled, so every channel start has its end: one that never ran
        // (or rolled back unseen) settles with the batch's error.
        settleQueryTrace(
          traces[i],
          rowCounts[i] ?? 0,
          duration,
          failed || rowCounts[i] === undefined ? error : undefined,
        );
        // A slot that never ran (or rolled back unseen) is not reported.
        if (failed || rowCounts[i] !== undefined) {
          emitStatementEvent(sink, {
            sql: q.sql,
            params: q.params,
            duration,
            ...deferredIdentity(q.tag),
            rows: rowCounts[i] ?? 0,
            batch: 'pipeline',
            ...(comments?.[i] === undefined ? {} : { comment: comments[i] }),
            ...(failed ? { error } : {}),
          });
        }
      });
    }
  }

  /**
   * Check whether the underlying pool supports the real pipeline protocol.
   * Returns `true` for standard pg.Pool TCP connections, `false` for HTTP
   * drivers (Neon HTTP, Vercel Postgres, etc.) and mock pools.
   */
  async pipelineSupported(): Promise<boolean> {
    return pipelineSupported(this.queryPool);
  }

  // -------------------------------------------------------------------------
  // Raw SQL, tagged template literal escape hatch
  // -------------------------------------------------------------------------

  /**
   * Execute a raw SQL query with parameter interpolation via tagged templates.
   * Every `${value}` is sent as a bound parameter. Only a real tagged-template
   * call is accepted: an array passed in its place throws `ValidationError`
   * (E003), since its text would reach the SQL unescaped. For statement text
   * built at runtime, see {@link rawUnsafe}.
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
    const { sql, params } = buildTypedSql(strings, values, this.dialect, 'raw');
    return this.runRaw<T>(sql, params, 'raw');
  }

  /**
   * Execute SQL text built at runtime: DDL read from a file, a statement in
   * another engine's own language (PowQL), a migration step. Values go in
   * `values` and are referenced from the text with the engine's placeholders
   * (`$1`, `$2`, ... on PostgreSQL), so they are still bound.
   *
   * NOTHING IN `text` IS ESCAPED. It is the one raw entry point where
   * concatenating input into the statement is possible, which is why it is
   * separate from {@link raw} and named for it: never build `text` from
   * request data. Prefer {@link raw} or {@link sql} wherever the statement is
   * known when the code is written.
   *
   * @example
   * ```ts
   * for (const statement of ddlStatements) await db.rawUnsafe(statement);
   * await db.rawUnsafe('SELECT * FROM users WHERE id = $1', userId);
   * ```
   */
  async rawUnsafe<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    ...values: unknown[]
  ): Promise<T[]> {
    assertSqlText(text, 'rawUnsafe');
    return this.runRaw<T>(text, values, 'rawUnsafe');
  }

  private async runRaw<T>(sql: string, values: unknown[], action: string): Promise<T[]> {
    const params = this.rawParams(values, action);
    if (this.logging) {
      logTo(this.logger, 'debug', `Raw SQL: ${sql.trim().substring(0, 120)}...`, {
        code: 'raw-sql',
        operation: action,
      });
    }
    const result = await runReportedStatement(
      this.queryOptions._onQuery,
      rawIdentity(action),
      sql,
      params,
      () => this.queryPool.query(sql, params),
      (err) => this.withErrorMode(() => wrapPgError(err)),
    );
    return result.rows as T[];
  }

  /**
   * @internal The `turbine-orm/prisma-compat` adapter's pool-level raw seam,
   * the twin of {@link TransactionClient.rawQuery}. NOT application API: use
   * {@link raw} or {@link sql}, whose tagged templates make concatenating a
   * value into the SQL text impossible. It exists so the adapter's
   * `$queryRaw` / `$executeRaw` statements emit a `$on('query')` event (model
   * `'$raw'`, `action` the adapter's label) instead of running unobserved on
   * the pool. Errors are translated by `wrapPgError`, like {@link raw}.
   */
  async rawQuery<T extends object = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
    action = 'rawQuery',
  ): Promise<{ rows: T[]; rowCount: number | null }> {
    const bound = this.rawParams(params as unknown[], action);
    const result = await runReportedStatement(
      this.queryOptions._onQuery,
      rawIdentity(action),
      text,
      bound,
      () => this.queryPool.query(text, bound),
      (err) => this.withErrorMode(() => wrapPgError(err)),
    );
    return { rows: result.rows as T[], rowCount: result.rowCount };
  }

  /**
   * Bound Dates as UTC text, on a PostgreSQL client reading zone-less temporal
   * types as UTC (see {@link utcDateParams}). Typed builder writes convert per
   * column instead and never come through here.
   */
  private rawParams(params: unknown[], api: string): unknown[] {
    return this.dialect.capabilities.utcTimestampRewrite && this.queryOptions.utcTimestamps !== false
      ? utcDateParams(params, api)
      : params;
  }

  /**
   * Run `fn` with `tag` attached to every `$on('query')` event it causes, so a
   * listener can attribute queries to the feature or code path that issued
   * them. The scope follows async context: queries in awaited helpers,
   * transactions, pipelines and raw SQL inside `fn` are all tagged. An inner
   * `$tag` replaces an outer one for its own duration. The tag is event
   * metadata only and never reaches SQL.
   *
   * Throws {@link ValidationError} (E003) for an empty tag or one longer than
   * {@link MAX_QUERY_TAG_LENGTH} (128) characters.
   *
   * @example
   * ```ts
   * const order = await db.$tag('checkout', async () => {
   *   const cart = await db.carts.findUnique({ where: { id } });
   *   return db.orders.create({ data: { cartId: cart.id } });
   * });
   * ```
   */
  $tag<R>(tag: string, fn: () => R): R {
    return runWithQueryTag(tag, fn);
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
    const { sql, params: bound } = buildTypedSql(strings, values, this.dialect);
    const params = this.rawParams(bound, 'sql');
    // The scope has to be handed to the BUILDER, not wrapped around this call.
    // `TypedSqlQuery` is lazy (it runs on `await` / `.one()` / `.scalar()`), so
    // a scope opened here would close before any row was fetched. The
    // `withErrorMode` docstring already claimed to cover the typed-SQL builder
    // and did not, which left two raw-SQL entry points disagreeing about the
    // same statement, since the adjacent `raw` tag WAS scoped.
    return new TypedSqlQuery<T>(
      this.queryPool,
      sql,
      params,
      this.logging,
      <R>(fn: () => R): R => this.withErrorMode(fn),
      this.queryOptions._onQuery,
      this.logger,
    );
  }

  // -------------------------------------------------------------------------
  // Transaction support (raw, legacy)
  // -------------------------------------------------------------------------

  /**
   * Execute a function within a database transaction on the raw driver
   * connection. For the typed API, use `$transaction()` instead.
   *
   * The client is typed as {@link PgCompatPoolClient}, the driver-neutral
   * contract: `query(text, values)`, which is all any supported driver
   * guarantees. For the pg-only surface (cursors, COPY streams, the
   * `QueryConfig` object form), import `PoolClient` from the pg package and
   * cast: `client as unknown as PoolClient`.
   *
   * Like `$transaction`'s `tx`, the client is closed when the transaction
   * settles: a query sent through it afterwards throws `ValidationError`
   * (E003). The callback must not `release()` it, and must await every query
   * it starts: one still running when the callback returns rolls the
   * transaction back with E003.
   *
   * @example
   * ```ts
   * await db.transaction(async (client) => {
   *   await client.query('INSERT INTO users (name) VALUES ($1)', ['Alice']);
   * });
   * ```
   */
  async transaction<T>(fn: (client: PgCompatPoolClient) => Promise<T>): Promise<T> {
    // BEGIN runs inside openCheckout, which sends it once more on a fresh
    // connection when the first one turns out to be dead. A BEGIN that fails
    // for good throws from there with the connection already released, so the
    // catch below only ever sees a transaction that began: its ROLLBACK can
    // never be a stray statement from a context that opened none, which on a
    // driver with one shared engine handle (PowDB embedded) would roll back a
    // DIFFERENT caller's open transaction.
    const { client, checkout } = await openCheckout(this.pool, (c) => runTxControl(c, this.dialect.beginStatement()));
    const state = new TransactionState(client, this.dialect, { api: 'transaction' });
    const guarded = closableRawClient(client, state);
    try {
      // Engine seam: single-writer engines scope their transaction re-entrancy
      // marker to the callback's async subtree (see
      // PgCompatPoolClient.wrapTransactionCallback). Absent everywhere else.
      const wrap = (client as unknown as PgCompatPoolClient).wrapTransactionCallback;
      // `.call` erases the generic, so the callback's Promise<T> is re-asserted.
      const result = wrap ? ((await wrap.call(client, () => fn(guarded))) as T) : await fn(guarded);
      const unawaited = state.busy;
      state.end('has ended');
      if (unawaited) throw unawaitedWorkError('transaction');
      // A COMMIT answered with ROLLBACK (a statement failed and the callback
      // caught it) rejects, with the first failed statement as the cause.
      await commitTransaction(client, this.dialect.commitStatement(), state.firstFailure, 'transaction');
      state.end('committed');
      checkout.release();
      return result;
    } catch (err) {
      state.end('was rolled back');
      const clean = await rollbackOnServer(client, state, this.dialect);
      checkout.release(
        clean ? undefined : new Error('[turbine] transaction connection discarded: rollback not confirmed'),
      );
      throw explainConnectionLoss(err, checkout.lostWith);
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
  $transaction<T extends readonly DeferredQuery<unknown>[]>(
    queries: readonly [...T],
    options?: TransactionOptions,
  ): Promise<PipelineResults<T>>;
  async $transaction(
    fnOrQueries: ((tx: TransactionClient) => Promise<unknown>) | readonly DeferredQuery<unknown>[],
    options?: TransactionOptions,
  ): Promise<unknown> {
    // Scope the WHOLE call, so the transaction-scoped QueryInterfaces built
    // inside TransactionClient.table() inherit this client's mode without
    // needing their own accessor.
    return this.withErrorMode(() => this.runTransaction(fnOrQueries, options));
  }

  private async runTransaction(
    fnOrQueries: ((tx: TransactionClient) => Promise<unknown>) | readonly DeferredQuery<unknown>[],
    options?: TransactionOptions,
  ): Promise<unknown> {
    // Batch overload: an array of DeferredQuery objects runs atomically inside
    // one BEGIN…COMMIT, through the same lifecycle (and options) as a callback.
    if (Array.isArray(fnOrQueries)) {
      assertDeferredQueries(fnOrQueries, '$transaction([...])', 'transaction');
      if (fnOrQueries.length === 0) {
        this.resolveTransactionOptions(options);
        return [];
      }
      return this.runInTransaction(options, (client, state) => this.runBatch(client, state, fnOrQueries));
    }
    if (typeof fnOrQueries !== 'function') {
      throw new ValidationError(
        '$transaction expects a callback, `async (tx) => { ... }`, or an array of deferred queries built with ' +
          `\`build*()\`, but received ${fnOrQueries === null ? 'null' : typeof fnOrQueries}.`,
      );
    }
    const fn = fnOrQueries as (tx: TransactionClient) => Promise<unknown>;
    // Pass the parent pool so its read-only guard + PowDB capabilities flow
    // into the transaction-scoped proxy pool (see TransactionClient.createTxPool).
    const sourcePool = this.pool as unknown as { readonly?: boolean; capabilities?: unknown };
    return this.runInTransaction(options, (client, state) =>
      fn(new TransactionClient(client, this.schema, this.middlewares, this.queryOptions, sourcePool, state)),
    );
  }

  /**
   * Validate every transaction option and build the statements they need,
   * BEFORE a pool slot is taken: a bad argument is the caller's bug and should
   * not cost a connection to discover.
   */
  private resolveTransactionOptions(options: TransactionOptions | undefined): {
    begin: string;
    sessionConfig: Array<{ name: string; sql: string; params: unknown[] }>;
    timeout: number | undefined;
  } {
    const isolationSql = resolveIsolationLevel(options?.isolationLevel);
    const begin = beginStatementFor(this.dialect, isolationSql, resolveReadOnly(options?.readOnly));
    const sessionConfig = this.resolveSessionContext(options?.sessionContext, options?.allowBuiltinSettings);
    const timeout = options?.timeout;
    if (timeout !== undefined && timeout !== 0 && !(typeof timeout === 'number' && timeout > 0 && timeout < 2 ** 31)) {
      throw new ValidationError(
        `$transaction: timeout must be a positive number of milliseconds (or 0 for none), received ${describeValue(timeout)}.`,
      );
    }
    return { begin, sessionConfig, timeout: timeout || undefined };
  }

  /**
   * The one transaction lifecycle both `$transaction` forms share, so an option
   * one form honours is honoured by the other: BEGIN (isolation level, read
   * only) -> `sessionContext` GUCs -> body, raced against `timeout` -> COMMIT,
   * and ROLLBACK on any failure.
   *
   * The transaction state is ended as soon as the body settles, BEFORE the
   * COMMIT, so a `tx` that leaked out of the callback can never slip a
   * statement in ahead of the COMMIT or onto the connection after it. Work the
   * body started and did not await is caught there too: the transaction rolls
   * back rather than committing whatever part of it had run.
   *
   * A transaction that will not commit (timed out, failed, unawaited work) is
   * stopped on the server before its connection is released: the running
   * statement is cancelled and ROLLBACK sent, so its locks are freed now (see
   * {@link rollbackOnServer}). A connection that cannot be confirmed clean is
   * destroyed instead of reused.
   */
  private async runInTransaction<R>(
    options: TransactionOptions | undefined,
    body: (client: PgCompatPoolClient, state: TransactionState) => Promise<R>,
  ): Promise<R> {
    const { begin, sessionConfig, timeout } = this.resolveTransactionOptions(options);
    // openCheckout sends BEGIN once more on a fresh connection when the first
    // one turns out to be dead, and releases the connection itself when BEGIN
    // fails for good. So everything below runs in a transaction that began.
    const { client, checkout } = await openCheckout(this.queryPool, (c) => runTxControl(c, begin));
    const state = new TransactionState(client, this.dialect, { userTransaction: true });
    let timedOut = false;

    try {
      // Transaction-local session context (RLS / multi-tenant GUCs), applied
      // after BEGIN and before the body via set_config(name, value,
      // is_local=true), so both name and value are BOUND params.
      for (const cfg of sessionConfig) await applySessionSetting(client, cfg);

      // Engine seam: when the checked-out connection exposes
      // wrapTransactionCallback (single-writer engines such as PowDB), run the
      // body through it so the engine can scope its re-entrancy marker to the
      // body's async subtree. All other drivers: plain body().
      const wrap = (client as unknown as PgCompatPoolClient).wrapTransactionCallback;
      const runBody = (): Promise<R> =>
        state.enter(() => (wrap ? (wrap.call(client, () => body(client, state)) as Promise<R>) : body(client, state)));

      let result: R;
      if (timeout) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            state.end('timed out');
            reject(
              new TimeoutError(timeout, 'Transaction', {
                message:
                  `Transaction timed out after ${timeout}ms and was rolled back, so none of its writes were ` +
                  'saved. A statement it was running was cancelled on the server.',
                outcome: 'not-executed',
              }),
            );
          }, timeout);
        });
        try {
          result = await Promise.race([runBody(), timeoutPromise]);
        } finally {
          clearTimeout(timer);
        }
      } else {
        result = await runBody();
      }

      const unawaited = state.busy;
      state.end('has ended');
      if (unawaited) throw unawaitedWorkError('$transaction');
      // A statement inside was cut short by its timeout, and the callback
      // caught the error: whether it ran is not known, so nothing commits.
      if (state.abortedWith !== undefined) throw rolledBackError(state.abortedWith, 'transaction');
      await commitTransaction(client, this.dialect.commitStatement(), state.firstFailure);
      state.end('committed');
      checkout.release();

      if (this.logging) {
        logTo(this.logger, 'debug', 'Transaction committed', {
          code: 'transaction-committed',
          operation: '$transaction',
        });
      }

      return result;
    } catch (err) {
      // A timed-out transaction keeps its 'timed out' wording for any late
      // statement the callback still tries to send.
      if (!timedOut) state.end('was rolled back');
      const clean = await rollbackOnServer(client, state, this.dialect);
      checkout.release(
        clean ? undefined : new Error('[turbine] transaction connection discarded: rollback not confirmed'),
      );
      if (this.logging) {
        logTo(this.logger, 'debug', 'Transaction rolled back', {
          code: 'transaction-rolled-back',
          operation: '$transaction',
        });
      }
      throw explainConnectionLoss(err, checkout.lostWith);
    }
  }

  /**
   * Validate `sessionContext` and build its `set_config` statements, before
   * any connection is taken.
   *
   * A name must be a namespaced custom setting (`app.tenant_id`) unless it is
   * listed in `allowBuiltinSettings`: an un-dotted name is one of PostgreSQL's
   * own settings (`role`, `search_path`, `statement_timeout`), and a context
   * built from request data must not be able to reach one. A value that is not
   * a string, number or boolean is refused, so a missing tenant id cannot reach
   * a row-level security policy as the text `'undefined'`.
   */
  private resolveSessionContext(
    context: TransactionOptions['sessionContext'],
    allowBuiltinSettings?: readonly string[],
  ): Array<{ name: string; sql: string; params: unknown[] }> {
    const allowed = resolveBuiltinSettingsAllowlist(allowBuiltinSettings);
    if (!context) return [];
    if (!this.dialect.supportsRLS) {
      throw new UnsupportedFeatureError(
        'sessionContext (RLS session GUCs)',
        this.dialect.name,
        'set_config-based row-level-security context requires PostgreSQL.',
      );
    }
    const statements: Array<{ name: string; sql: string; params: unknown[] }> = [];
    for (const [name, value] of Object.entries(context)) {
      if (!GUC_NAME_REGEX.test(name)) {
        throw new ValidationError(
          `Invalid session-context GUC name "${name}", must match ` +
            '/^[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*)?$/ (optionally namespaced, e.g. "app.current_tenant")',
        );
      }
      if (!name.includes('.') && !allowed.has(name.toLowerCase())) {
        throw new ValidationError(
          `sessionContext["${name}"] names a PostgreSQL setting, not a custom one. A session context may set ` +
            'namespaced custom settings only (`app.tenant_id`, with a dot), because a built-in setting such as ' +
            '`role`, `search_path` or `statement_timeout` changes who the transaction runs as or what limits it ' +
            `has. Rename it into a namespace, or, if your code sets it on purpose, pass \`allowBuiltinSettings: ['${name}']\`.`,
        );
      }
      const kind = typeof value;
      if (kind !== 'string' && kind !== 'number' && kind !== 'boolean') {
        throw new ValidationError(
          `sessionContext["${name}"] is ${value === null ? 'null' : kind}. A session setting is text, and ` +
            `${value === undefined ? 'a missing value' : 'this value'} would reach your row-level security ` +
            `policies as the string "${String(value)}". Pass a string, number or boolean, and check the value ` +
            'your request context supplies.',
        );
      }
      statements.push({ name, ...this.dialect.buildSetSessionConfig(name, String(value)) });
    }
    return statements;
  }

  /**
   * Run a batch of {@link DeferredQuery} objects on a transaction's connection.
   * Backs the `$transaction([...])` array overload; the transaction itself
   * (BEGIN/COMMIT/ROLLBACK, options, release) is {@link runInTransaction}'s.
   * Each result is passed through its query's `transform`.
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
  private async runBatch<T extends readonly DeferredQuery<unknown>[]>(
    client: PgCompatPoolClient,
    state: TransactionState,
    queries: T,
  ): Promise<PipelineResults<T>> {
    // One `$on('query')` event per statement, `batch: 'transaction'`, only
    // when someone is listening; each statement is timed on its own. Every
    // statement goes through the transaction state, so a timeout can tell
    // what is still on the wire and stop it.
    const sink = this.queryListeners.size > 0 ? this.queryOptions._onQuery : undefined;
    // Each statement is sent with its `sqlComment`; its event reports the
    // commentless text and the comment beside it, as a model call's does.
    const comments = this.statementComments(queries);
    const reported = (i: number, run: (dq: DeferredQuery<unknown>) => Promise<PgCompatQueryResult>) => {
      const dq = queries[i]!;
      const comment = comments?.[i];
      return state.run(() =>
        runReportedStatement(
          sink,
          { ...deferredIdentity(dq.tag), batch: 'transaction', ...(comment === undefined ? {} : { comment }) },
          dq.sql,
          dq.params,
          () => run(commentDeferred(dq, comment)),
          wrapPgError,
        ),
      );
    };
    const pipelined =
      (client as unknown as PgCompatPoolClient).supportsPipelining === true &&
      this.dialect.resultStrategy !== 'reselect';

    if (pipelined) {
      // Dispatch every statement before awaiting any reply. The driver's
      // FIFO guarantee makes settled[i] the reply to queries[i]. Each
      // statement is timed from its dispatch to its own reply.
      const settled = await Promise.allSettled(
        queries.map((_, i) => reported(i, (dq) => client.query(dq.sql, dq.params))),
      );
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
    for (let i = 0; i < queries.length; i++) {
      // Non-RETURNING engines (resultStrategy 'reselect', e.g. MySQL) attach a
      // reselect plan that runs the write plus a follow-up SELECT; running
      // dq.sql alone would transform a row-less write result.
      const raw = await reported(i, (dq) =>
        this.dialect.resultStrategy === 'reselect' && dq.reselect
          ? dq.reselect((sql, params) => client.query(sql, params))
          : client.query(dq.sql, dq.params),
      );
      results.push(queries[i]!.transform(raw));
    }
    return results as PipelineResults<T>;
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
   * **Connection loss:** if the subscription's connection dies (a restart,
   * failover, compute suspend, `pg_terminate_backend`), it reconnects with
   * exponential backoff and re-issues `LISTEN`; `options.reconnect: false`
   * ends it instead. Postgres does not hold notifications for a disconnected
   * listener, so anything sent during the gap is lost: use
   * `options.onReconnect` to resynchronise. `options.onError` receives the loss
   * and each failed attempt (default: one log line each through `logger`, at
   * `warn` while it reconnects and `error` once it stops).
   *
   * @example
   * ```ts
   * const sub = await db.$listen('order_created', (payload) => {
   *   const order = JSON.parse(payload);
   *   console.log('new order', order.id);
   * }, {
   *   onReconnect: () => refreshOrdersFromDatabase(),
   * });
   * // ...later
   * await sub.unsubscribe();
   * ```
   */
  async $listen(channel: string, handler: NotificationHandler, options?: ListenOptions): Promise<Subscription> {
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
      logTo(this.logger, 'debug', `LISTEN ${quoted}`, { code: 'listen', channel });
    }

    const sub = await createSubscription(
      this.pool,
      channel,
      quoted,
      handler,
      (closed) => {
        this.activeSubscriptions.delete(closed);
      },
      options,
      this.logger,
    );
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
      logTo(this.logger, 'debug', `NOTIFY ${channel}`, { code: 'notify', channel });
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
    await this.roundTrip();
    if (this.logging) {
      logTo(this.logger, 'debug', 'Connection verified', { code: 'connection-verified' });
    }
  }

  /**
   * Run one cheap round trip (`SELECT 1`) on the primary and resolve with its
   * latency in milliseconds, for health checks and for setting
   * `autoRoundTripMs`. The time measures the statement on a checked-out
   * connection, not the wait for one: an exhausted pool rejects with
   * `ConnectionError` (E004) after `connectionTimeoutMs` instead. Rejects with
   * the typed connection error when the database cannot be reached.
   */
  async $ping(): Promise<number> {
    return this.roundTrip();
  }

  /**
   * `SELECT 1` on a checked-out primary connection, timed. A connection the
   * server closed while idle says nothing about whether the database is
   * reachable, so it runs on a fresh one when the first turns out to be dead
   * (see openCheckout).
   */
  private async roundTrip(): Promise<number> {
    let latency = 0;
    const { checkout } = await openCheckout(this.pool, async (client) => {
      const start = performance.now();
      try {
        await client.query('SELECT 1');
      } catch (err) {
        throw wrapPgError(err);
      }
      latency = performance.now() - start;
    });
    checkout.release();
    return latency;
  }

  /**
   * Gracefully shut down the connection pool.
   *
   * Waits for every checked-out connection to be returned, then closes them
   * all. With `timeoutMs`, it stops waiting at the deadline: each connection
   * still in use has its running statement cancelled on the server and is
   * closed (a transaction on it rolls back), and the result says how many
   * were. Resolves within about `timeoutMs` plus two seconds of grace.
   *
   * If Turbine was given an external pool via `TurbineConfig.pool`, the
   * primary is left open, the caller is responsible for its lifecycle;
   * Turbine-owned replica pools are still closed.
   */
  disconnect(): Promise<void>;
  disconnect(options: DisconnectOptions): Promise<DisconnectResult>;
  async disconnect(options?: DisconnectOptions): Promise<unknown> {
    const timeoutMs = resolveNonNegativeInteger(options?.timeoutMs, 'disconnect timeoutMs', 'milliseconds');
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

    // Owned (string-configured) replica pools are closed whether or not the
    // primary is owned; external replica pools are the caller's, like an
    // external primary.
    const endReplicas = Promise.all(
      this.ownedReplicaPools.map((replicaPool) =>
        replicaPool.end().catch((err: unknown) => {
          if (this.logging) {
            logTo(this.logger, 'error', `Error closing replica pool: ${(err as Error).message}`, {
              code: 'replica-close-error',
              error: err,
            });
          }
        }),
      ),
    );
    if (!this.ownsPool && this.logging) {
      logTo(this.logger, 'debug', 'disconnect() skipped, external primary pool is not owned by Turbine', {
        code: 'disconnect-skipped',
      });
    }
    const ending = Promise.all([endReplicas, this.ownsPool ? this.pool.end() : undefined]);

    if (timeoutMs === undefined || (await settlesWithin(ending, timeoutMs))) {
      await ending;
      if (this.logging && this.ownsPool) {
        logTo(this.logger, 'debug', 'Pool disconnected', { code: 'pool-disconnected', timedOut: false });
      }
      return options === undefined ? undefined : { timedOut: false, forcedConnections: 0 };
    }
    const forcedConnections = await this.forceCloseCheckedOut();
    // Closed connections reach the pool as their holders' queries fail; give
    // that one grace period, then return either way rather than hang on a
    // holder that never releases.
    await settlesWithin(ending, TX_ABORT_GRACE_MS);
    if (this.logging) {
      logTo(
        this.logger,
        'debug',
        `Pool disconnected after ${timeoutMs}ms, ${forcedConnections} connection(s) closed in use`,
        { code: 'pool-disconnected', timedOut: true, timeoutMs, forcedConnections },
      );
    }
    return { timedOut: true, forcedConnections };
  }

  /**
   * Cancel the running statement of every connection still checked out of a
   * pool this client opened, then close the connection. Cancelling first is
   * what stops the work on the server: a closed socket alone is noticed only
   * when the backend next writes to it. Returns how many were closed.
   */
  private async forceCloseCheckedOut(): Promise<number> {
    const clients = this.checkoutWatches.flatMap((watch) => [...watch.checkedOut]);
    await Promise.all(
      clients.map(async (client) => {
        await sendCancelRequest(client, TX_ABORT_GRACE_MS);
        const c = client as { end?: () => Promise<void>; connection?: { stream?: { destroy?(): void } } };
        const closing = Promise.resolve()
          .then(() => c.end?.())
          .catch(() => {});
        // A backend that does not answer the terminate message within the
        // grace period has its socket destroyed instead.
        if (!(await settlesWithin(closing, TX_ABORT_GRACE_MS))) c.connection?.stream?.destroy?.();
      }),
    );
    return clients.length;
  }

  /** Alias for disconnect() */
  end(): Promise<void>;
  end(options: DisconnectOptions): Promise<DisconnectResult>;
  async end(options?: DisconnectOptions): Promise<unknown> {
    return options === undefined ? this.disconnect() : this.disconnect(options);
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

// What prisma-compat (and anything else that wraps a client) logs through: the
// client's logger and resolved diagnostics, under a `Symbol.for` key so a CJS
// and an ESM copy agree. Defined outside the class body so it stays off the
// published declaration of `TurbineClient`.
Object.defineProperty(TurbineClient.prototype, CLIENT_LOG_CONTEXT, {
  get(this: TurbineClient): ClientLogContext {
    const self = this as unknown as ClientLogContext;
    return { logger: self.logger, diagnostics: self.diagnostics };
  },
  enumerable: false,
  configurable: false,
});
