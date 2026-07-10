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
   * full tables).
   */
  warnOnUnlimited?: boolean;
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
   * same shape (same keys, operators, relations — different values) reuse
   * cached SQL text instead of rebuilding from scratch.
   *
   * Default: `true`. Set to `false` as a nuclear kill switch.
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
   * Client-level default relation-loading strategy for `with` clauses. Per-query
   * `relationLoadStrategy` args override this; both default to `'join'`.
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
