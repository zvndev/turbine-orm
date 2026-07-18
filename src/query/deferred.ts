/**
 * turbine-orm — Deferred query + QueryInterface option types
 *
 * Split from builder.ts so the class file focuses on SQL assembly / execution.
 */

import type pg from 'pg';
import type { Dialect } from '../dialect.js';
import type { SchemaMetadata } from '../schema.js';
// Forward-declared to avoid a runtime cycle with builder.ts. Type-only.
import type { QueryInterface } from './builder.js';
import type { GlobalFilters, RelationLoadStrategy } from './types.js';

/**
 * Runs a SQL statement and resolves its raw result. Passed to a
 * {@link DeferredQuery.reselect} plan so it can run the write and the follow-up
 * SELECT through the same timeout/instrumentation path as the primary query.
 */
export type ReselectExecutor = (sql: string, params: unknown[], preparedName?: string) => Promise<pg.QueryResult>;

export interface DeferredQuery<T> {
  /** SQL text with $1, $2 placeholders */
  sql: string;
  /** Bound parameter values */
  params: unknown[];
  /** How to transform the raw pg.QueryResult into the final value */
  transform: (result: pg.QueryResult) => T;
  /** Tag for debugging / logging */
  tag: string;
  /** Prepared statement name (t_<16hex>). Set when SQL cache is enabled. */
  preparedName?: string;
  /**
   * Execution plan for dialects whose {@link Dialect.resultStrategy} is
   * `'reselect'` (no RETURNING — e.g. MySQL). Owns the statement ordering: it
   * runs the write and the follow-up row-fetching SELECT(s) via `exec`, and
   * resolves the result whose rows {@link DeferredQuery.transform} consumes.
   * Absent for `'returning'`/`'output'` dialects (the statement returns its own
   * rows), so the PostgreSQL path never allocates or consults it.
   */
  reselect?: (exec: ReselectExecutor) => Promise<pg.QueryResult>;
}

// ---------------------------------------------------------------------------
// QueryInterface — the object returned by db.users, db.posts, etc.
// ---------------------------------------------------------------------------

/** Middleware function type — imported from client to avoid circular deps */
export type MiddlewareFn = (
  params: { model: string; action: string; args: Record<string, unknown> },
  next: (params: { model: string; action: string; args: Record<string, unknown> }) => Promise<unknown>,
) => Promise<unknown>;

/** Emitted after every query execution (success or failure). */
export interface QueryEvent {
  sql: string;
  params: unknown[];
  duration: number;
  model: string;
  action: string;
  rows: number;
  timestamp: Date;
  error?: Error;
}

export type QueryEventListener = (event: QueryEvent) => void;

/** Options passed from TurbineClient to QueryInterface */
export interface QueryInterfaceOptions {
  /** Default LIMIT applied to findMany() when no limit is specified */
  defaultLimit?: number;
  /**
   * Log a one-time warning when {@link QueryInterface.findMany} is called
   * without a `limit`. Defaults to `true` so that accidental unbounded
   * queries are surfaced loudly during development. Pass `false` to silence
   * the warning entirely (e.g. for CLI tooling that intentionally streams
   * full tables), or a per-table map (`{ userProfiles: false }`) to silence
   * only the tables that intentionally read full sets — unlisted tables keep
   * the default. Map keys accept BOTH the camelCase accessor name
   * (`userProfiles`) and the snake_case table name (`user_profiles`); the
   * snake_case entry wins if both are present. Individual calls can also
   * override via `findMany({ warnOnUnlimited: false })`.
   */
  warnOnUnlimited?: boolean | Record<string, boolean>;
  /**
   * Enable prepared statements. When true, queries are submitted with a
   * `{ name, text, values }` object to the pg driver, which caches the
   * parse+plan on the server per connection.
   *
   * Default: `true` for Turbine-owned pools, `false` for external pools
   * (serverless drivers may not support named statements).
   */
  preparedStatements?: boolean;
  /**
   * Enable the SQL template cache. When true, repeated queries with the
   * same shape (same keys, operators, relations, different values) reuse
   * cached SQL text instead of rebuilding from scratch.
   *
   * Default: `true`. Set to `false` as a nuclear kill switch.
   *
   * Dev-mode safety net: when `NODE_ENV !== 'production'`, every cache HIT is
   * cross-checked by rebuilding the SQL + params fresh and comparing them
   * against the cache-hit result, catching any drift between the fingerprint,
   * SQL-build, and param-collect paths (which has silently corrupted results
   * before). A mismatch throws a `ValidationError` (E003). This runs only
   * outside production, so it never touches the production hot path. Set the
   * env var `TURBINE_DISABLE_CACHE_CHECK=1` to opt out when dev traffic is
   * perf-sensitive.
   *
   * Production sampling: the check is off in production by default. Set
   * `TURBINE_CACHE_CHECK_SAMPLE` to a float in `(0,1]` to re-verify that
   * fraction of cache hits under real load (e.g. `0.001` for one in a
   * thousand). A sampled mismatch logs `console.error` once per distinct
   * fingerprint AND throws the same `ValidationError` (E003). `0`, unset, or an
   * unparseable value keeps the check fully off.
   */
  sqlCache?: boolean;
  /** SQL dialect implementation. Defaults to PostgreSQL. */
  dialect?: Dialect;
  /**
   * Interpret offset-less timestamp strings (Postgres `timestamp` without
   * time zone, and the JSON emitted by nested-relation subqueries) as UTC.
   * This is the Prisma/Rails/Django convention and makes results independent
   * of the server's local time zone. Default: `true`. Set `false` to restore
   * the pre-0.26 behavior (JS local-time interpretation).
   */
  utcTimestamps?: boolean;
  /**
   * Client-level default relation-loading strategy for `with` clauses; a
   * per-query `relationLoadStrategy` arg overrides it. On SQL engines the default
   * is `'join'` (one single-statement `json_agg` query). On PowDB the default is
   * the batched loaders, and `'join'` opts INTO native server-side joins where
   * eligible (ineligible relations fall back to the loaders per-relation and
   * silently; see the PowDB docs).
   */
  relationLoadStrategy?: RelationLoadStrategy;
  /**
   * How nested-relation subqueries encode each row's JSON: `'object'` (default,
   * `json_build_object`) or `'positional'` (`json_build_array`, key-less — see
   * {@link Dialect.buildJsonArray}). Positional is Postgres-only in v1; a
   * `with` clause on any other dialect throws `UnsupportedFeatureError` (E017).
   */
  jsonEncoding?: 'object' | 'positional';
  /**
   * Automatic WHERE filters keyed by table accessor, AND-merged into every
   * query on that table and every relation subquery targeting it (soft-delete /
   * multi-tenancy). Function values are evaluated at query-build time. See
   * {@link GlobalFilters}.
   */
  globalFilters?: GlobalFilters;
  /** @internal Set by TransactionClient — signals that this QI runs inside an active transaction. */
  _txScoped?: boolean;
  /** @internal Callback from TurbineClient for query event emission. */
  _onQuery?: (event: QueryEvent) => void;
  /**
   * @internal Factory that builds the per-table query interface. Defaults to
   * `new QueryInterface` (the SQL path). Non-SQL backends (PowDB) supply a
   * factory returning a structurally-compatible interface that generates their
   * own query language instead of SQL. The SQL dialects never set this, so their
   * `table()` behavior is byte-identical.
   */
  queryInterfaceFactory?: (
    pool: pg.Pool,
    table: string,
    schema: SchemaMetadata,
    middlewares: MiddlewareFn[],
    options: QueryInterfaceOptions,
  ) => QueryInterface<object>;
}
