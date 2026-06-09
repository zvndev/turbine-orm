/**
 * turbine-orm — Query builder
 *
 * Each table accessor (db.users, db.posts, etc.) returns a QueryInterface<T>
 * that builds parameterized SQL and executes it through the connection pool.
 *
 * Nested relations use json_build_object + json_agg subqueries for single-query
 * resolution — a PostgreSQL-native approach that eliminates N+1 query patterns.
 *
 * Schema-driven: all column names, types, and relations come from introspected
 * metadata — nothing is hardcoded.
 */

import type pg from 'pg';
import type { Dialect } from '../dialect.js';
import { postgresDialect } from '../dialect.js';
import {
  CircularRelationError,
  NotFoundError,
  OptimisticLockError,
  RelationError,
  TimeoutError,
  ValidationError,
  wrapPgError,
} from '../errors.js';
import {
  executeNestedCreate,
  executeNestedUpdate,
  hasRelationFields,
  type NestedWriteContext,
} from '../nested-write.js';
import type { RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';
import { camelToSnake, normalizeKeyColumns, snakeToCamel } from '../schema.js';
import type {
  AggregateArgs,
  AggregateResult,
  ArrayFilter,
  CountArgs,
  CreateArgs,
  CreateManyArgs,
  DeleteArgs,
  DeleteManyArgs,
  FindManyArgs,
  FindManyStreamArgs,
  FindUniqueArgs,
  GroupByArgs,
  HavingClause,
  HavingFilter,
  HavingNumericOperator,
  JsonFilter,
  OrderByClause,
  OrderDirection,
  QueryResult,
  TextSearchFilter,
  TypedWithClause,
  UpdateArgs,
  UpdateManyArgs,
  UpsertArgs,
  VectorFilter,
  VectorOrderBy,
  WhereClause,
  WhereOperator,
  WithClause,
  WithOptions,
} from './types.js';
import { escapeLike, LRUCache, OPERATOR_KEYS, type SqlCacheEntry, sqlToPreparedName } from './utils.js';

// ---------------------------------------------------------------------------
// Internal detection helpers — used by QueryInterface
// ---------------------------------------------------------------------------

/** Check if a value is a where operator object (has at least one known operator key) */
function isWhereOperator(value: unknown): value is WhereOperator {
  if (
    value === null ||
    value === undefined ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value instanceof Date
  ) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((k) => OPERATOR_KEYS.has(k));
}

/** Known atomic-update operator keys — used to detect operator objects vs plain JSON values */
const UPDATE_OPERATOR_KEYS = new Set<string>(['set', 'increment', 'decrement', 'multiply', 'divide']);

/** Known JSONB operator keys */
const JSONB_OPERATOR_KEYS = new Set<string>(['path', 'equals', 'contains', 'hasKey']);

/**
 * JSONB operator keys that are *unique* to {@link JsonFilter} — they cannot
 * appear in any other where-filter shape, so the presence of one of these is
 * an unambiguous signal that the user meant a JSON filter. Used by the
 * strict-validation path so that `{ contains: 'foo' }` (which is also a valid
 * `WhereOperator` for LIKE) is not misclassified.
 */
const JSONB_UNIQUE_KEYS = new Set<string>(['path', 'equals', 'hasKey']);

/** Check if a value is a JSONB filter object */
function isJsonFilter(value: unknown): value is JsonFilter {
  if (
    value === null ||
    value === undefined ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value instanceof Date
  ) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length > 0 && keys.some((k) => JSONB_OPERATOR_KEYS.has(k));
}

/**
 * Returns the first JSON-unique key found in `value`, or `null` if none.
 * Used to drive the strict-validation error message.
 */
function findJsonUniqueKey(value: object): string | null {
  for (const k of Object.keys(value)) {
    if (JSONB_UNIQUE_KEYS.has(k)) return k;
  }
  return null;
}

/** Known Array operator keys */
const ARRAY_OPERATOR_KEYS = new Set<string>(['has', 'hasEvery', 'hasSome', 'isEmpty']);

/**
 * Array operator keys that are *unique* to {@link ArrayFilter}. None of the
 * array operators currently overlap with `WhereOperator` or `JsonFilter`, so
 * this set equals {@link ARRAY_OPERATOR_KEYS}; it is kept as a separate
 * constant so a future overlap (e.g. a `contains` for arrays) is easy to
 * carve out.
 */
const ARRAY_UNIQUE_KEYS = new Set<string>(['has', 'hasEvery', 'hasSome', 'isEmpty']);

/** Check if a value is an Array filter object */
function isArrayFilter(value: unknown): value is ArrayFilter {
  if (
    value === null ||
    value === undefined ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value instanceof Date
  ) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length > 0 && keys.some((k) => ARRAY_OPERATOR_KEYS.has(k));
}

/**
 * Returns the first array-unique key found in `value`, or `null` if none.
 * Used to drive the strict-validation error message.
 */
function findArrayUniqueKey(value: object): string | null {
  for (const k of Object.keys(value)) {
    if (ARRAY_UNIQUE_KEYS.has(k)) return k;
  }
  return null;
}

/** Known text search operator keys */
const TEXT_SEARCH_KEYS = new Set<string>(['search', 'config']);

/** Check if a value is a TextSearchFilter object */
function isTextSearchFilter(value: unknown): value is TextSearchFilter {
  if (
    value === null ||
    value === undefined ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value instanceof Date
  ) {
    return false;
  }
  const keys = Object.keys(value);
  // Must have 'search' key and only known text search keys
  return keys.includes('search') && keys.every((k) => TEXT_SEARCH_KEYS.has(k));
}

/**
 * Validate a text search config name. Only alphanumeric characters and
 * underscores are allowed to prevent SQL injection via the config parameter.
 */
function validateTextSearchConfig(config: string): boolean {
  return /^[a-zA-Z0-9_]+$/.test(config);
}

/**
 * pgvector distance metric → operator allow-list. This is the ONLY mapping
 * from a user-supplied metric token to a SQL operator; any token not present
 * here is rejected, so a user value can never become an arbitrary operator.
 *
 *  - `l2`     → `<->` (Euclidean / L2 distance)
 *  - `cosine` → `<=>` (cosine distance)
 *  - `ip`     → `<#>` (negative inner product)
 */
const VECTOR_METRIC_OPERATORS: Record<string, string> = {
  l2: '<->',
  cosine: '<=>',
  ip: '<#>',
};

/** Comparison keys allowed on a {@link VectorDistanceFilter}. */
const VECTOR_DISTANCE_COMPARATORS: Record<string, string> = {
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
};

/** Check if a value is a vector distance WHERE filter: `{ distance: { to, metric } }` */
function isVectorFilter(value: unknown): value is VectorFilter {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof Date) {
    return false;
  }
  const dist = (value as { distance?: unknown }).distance;
  return (
    typeof dist === 'object' &&
    dist !== null &&
    !Array.isArray(dist) &&
    'to' in (dist as object) &&
    'metric' in (dist as object)
  );
}

/** Check if an orderBy value is a vector KNN ordering: `{ distance: { to, metric } }` */
function isVectorOrderBy(value: unknown): value is VectorOrderBy {
  return isVectorFilter(value);
}

// ---------------------------------------------------------------------------
// Deferred query descriptor (for pipeline batching)
// ---------------------------------------------------------------------------

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
  /** @internal Set by TransactionClient — signals that this QI runs inside an active transaction. */
  _txScoped?: boolean;
  /** @internal Callback from TurbineClient for query event emission. */
  _onQuery?: (event: QueryEvent) => void;
}

// biome-ignore lint/complexity/noBannedTypes: {} means "no relations known" — intentional for untyped table access
export class QueryInterface<T extends object, R extends object = {}> {
  private readonly tableMeta: TableMetadata;
  /** SQL template cache: cacheKey → SqlCacheEntry (sql + prepared statement name) */
  private readonly sqlTemplateCache = new LRUCache<string, SqlCacheEntry>(1000);
  private readonly middlewares: MiddlewareFn[];
  private readonly defaultLimit?: number;
  private readonly warnOnUnlimited: boolean;
  private readonly preparedStatementsEnabled: boolean;
  private readonly sqlCacheEnabled: boolean;
  private readonly dialect: Dialect;
  /**
   * Tracks tables that have already triggered an unlimited-query warning so
   * the user is not spammed once per row. Per-instance state — each
   * QueryInterface is bound to a single table, so this set will only ever
   * contain at most one entry, but using a Set keeps the API consistent with
   * the audit's "Set<string>" guidance and leaves room for future
   * cross-table sharing.
   */
  private readonly warnedTables = new Set<string>();

  /** Cache hit/miss counters for diagnostics */
  private cacheHits = 0;
  private cacheMisses = 0;

  /** Pre-computed column type lookups (avoids linear scans per query) */
  private readonly columnPgTypeMap: Map<string, string>;
  private readonly columnArrayTypeMap: Map<string, string>;

  /** Tracks tables that have already triggered a deep-with warning (one-time) */
  private readonly deepWithWarned = new Set<string>();

  /**
   * Per-table memo of date columns keyed by their camelCase FIELD name.
   * `meta.dateColumns` is keyed by raw snake_case column name, which matches
   * top-level rows from pg. Nested relation rows arrive from json_build_object
   * with camelCase keys, so they need this camelCase-keyed set to be coerced
   * to Date as well (otherwise nested dates leak through as strings).
   */
  private readonly camelDateFieldCache = new Map<string, Set<string>>();

  /** True when this QI runs inside an active transaction (set via _txScoped option). */
  private readonly txScoped: boolean;

  /** Original options reference — forwarded to child QIs in nested writes. */
  private readonly options?: QueryInterfaceOptions;

  /** Set by executeWithMiddleware so queryWithTimeout can include it in events. */
  private currentAction = 'raw';

  constructor(
    private readonly pool: pg.Pool,
    private readonly table: string,
    private readonly schema: SchemaMetadata,
    middlewares?: MiddlewareFn[],
    options?: QueryInterfaceOptions,
  ) {
    const meta = schema.tables[table];
    if (!meta) {
      throw new ValidationError(
        `[turbine] Unknown table "${table}". Available: ${Object.keys(schema.tables).join(', ')}`,
      );
    }
    this.tableMeta = meta;
    this.middlewares = middlewares ?? [];
    this.defaultLimit = options?.defaultLimit;
    // Default to ON: surfacing accidental full-table scans is more valuable
    // than the (small) risk of noisy logs. Callers explicitly opt out with
    // `warnOnUnlimited: false`.
    this.warnOnUnlimited = options?.warnOnUnlimited !== false;
    this.preparedStatementsEnabled = options?.preparedStatements ?? true;
    this.sqlCacheEnabled = options?.sqlCache !== false;
    this.dialect = options?.dialect ?? postgresDialect;
    this.txScoped = options?._txScoped ?? false;
    this.options = options;

    // Pre-compute column type lookup maps (TASK-26)
    this.columnPgTypeMap = new Map();
    this.columnArrayTypeMap = new Map();
    for (const col of this.tableMeta.columns) {
      this.columnPgTypeMap.set(col.name, col.dialectType ?? col.pgType);
      this.columnArrayTypeMap.set(col.name, col.arrayType ?? col.pgArrayType);
    }
  }

  /** Quote an identifier through the active SQL dialect. */
  private q(name: string): string {
    return this.dialect.quoteIdentifier(name);
  }

  /** Return the active dialect's placeholder for a 1-indexed parameter position. */
  private p(index: number): string {
    return this.dialect.paramPlaceholder(index);
  }

  /**
   * Return cache hit/miss statistics for this QueryInterface instance.
   * Useful for monitoring and benchmarking.
   */
  cacheStats(): { hits: number; misses: number; hitRate: number; size: number } {
    const total = this.cacheHits + this.cacheMisses;
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      hitRate: total > 0 ? this.cacheHits / total : 0,
      size: this.sqlTemplateCache.size,
    };
  }

  /**
   * Look up or build a SQL template in the cache.
   * On miss, calls `build()` to generate the SQL, stores the entry, and returns it.
   * On hit, increments counters and returns the cached entry.
   *
   * When `sqlCache` is disabled, always calls `build()` without caching.
   */
  private acquireSql(cacheKey: string, build: () => string): SqlCacheEntry {
    if (!this.sqlCacheEnabled) {
      const sql = build();
      this.cacheMisses++;
      return { sql, name: sqlToPreparedName(sql) };
    }

    const cached = this.sqlTemplateCache.get(cacheKey);
    if (cached) {
      this.cacheHits++;
      return cached;
    }

    const sql = build();
    const entry: SqlCacheEntry = { sql, name: sqlToPreparedName(sql) };
    this.sqlTemplateCache.set(cacheKey, entry);
    this.cacheMisses++;
    return entry;
  }

  /**
   * Reset the per-instance unlimited-query warning dedupe set.
   * Exposed for tests so a single test process can verify the warning fires
   * exactly once per table without bleeding state between assertions.
   */
  resetUnlimitedWarnings(): void {
    this.warnedTables.clear();
  }

  private emitQueryEvent(
    sql: string,
    params: unknown[],
    duration: number,
    action: string,
    rows: number,
    error?: Error,
  ): void {
    const onQuery = this.options?._onQuery;
    if (!onQuery) return;
    try {
      onQuery({ sql, params, duration, model: this.table, action, rows, timestamp: new Date(), error });
    } catch {
      // Listener errors must never crash a query
    }
  }

  /**
   * Execute a pool.query with an optional timeout.
   * If timeout is set, races the query against a timer and rejects on expiry.
   * pg driver errors are translated to typed Turbine errors via wrapPgError.
   */
  private async queryWithTimeout(
    sql: string,
    params: unknown[],
    timeout?: number,
    preparedName?: string,
  ): Promise<pg.QueryResult> {
    const start = performance.now();
    const action = this.currentAction;
    // Build the query argument — use object form with `name` for prepared
    // statements, or the plain (text, values) form otherwise.
    const usePrepared = preparedName && this.preparedStatementsEnabled;
    const exec = usePrepared
      ? this.pool.query({ name: preparedName, text: sql, values: params } as pg.QueryConfig)
      : this.pool.query(sql, params);

    if (!timeout) {
      try {
        const result = await exec;
        this.emitQueryEvent(sql, params, performance.now() - start, action, result.rowCount ?? 0);
        return result;
      } catch (err) {
        const wrapped = wrapPgError(err);
        this.emitQueryEvent(
          sql,
          params,
          performance.now() - start,
          action,
          0,
          wrapped instanceof Error ? wrapped : undefined,
        );
        throw wrapped;
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(timeout)), timeout);
    });
    try {
      const result = await Promise.race([exec, timeoutPromise]);
      this.emitQueryEvent(sql, params, performance.now() - start, action, result.rowCount ?? 0);
      return result;
    } catch (err) {
      const wrapped = wrapPgError(err);
      this.emitQueryEvent(
        sql,
        params,
        performance.now() - start,
        action,
        0,
        wrapped instanceof Error ? wrapped : undefined,
      );
      throw wrapped;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Execute a query through the middleware chain.
   * If no middlewares are registered, executes directly.
   *
   * Middleware can inspect and log query parameters, modify results after execution,
   * and measure timing. Note: query SQL is generated before middleware runs, so
   * modifying params.args in middleware will NOT affect the executed SQL.
   * To intercept queries before SQL generation, use the raw() method instead.
   */
  private async executeWithMiddleware<R>(
    action: string,
    args: Record<string, unknown>,
    executor: () => Promise<R>,
  ): Promise<R> {
    this.currentAction = action;
    if (this.middlewares.length === 0) {
      return executor();
    }

    const params = { model: this.table, action, args: { ...args } };

    // Build middleware chain
    let index = 0;
    const next = async (p: { model: string; action: string; args: Record<string, unknown> }): Promise<unknown> => {
      if (index < this.middlewares.length) {
        const mw = this.middlewares[index++]!;
        return mw(p, next);
      }
      // End of chain — execute the actual query
      return executor();
    };

    return next(params) as Promise<R>;
  }

  // -------------------------------------------------------------------------
  // findUnique
  // -------------------------------------------------------------------------

  async findUnique<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause" — matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args: FindUniqueArgs<T, R, W, S, O>): Promise<QueryResult<T, R, W, S, O> | null> {
    return this.executeWithMiddleware('findUnique', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildFindUnique(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args.timeout, deferred.preparedName);
      return deferred.transform(result);
    }) as Promise<QueryResult<T, R, W, S, O> | null>;
  }

  // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause" — matches TypedWithClause default
  buildFindUnique<W extends TypedWithClause<R> = {}>(
    args: FindUniqueArgs<T, R, W, Record<string, boolean> | undefined, Record<string, boolean> | undefined>,
  ): DeferredQuery<T | null> {
    const columnsList = this.resolveColumns(args.select, args.omit);
    const whereObj = args.where as Record<string, unknown>;
    const colKey = columnsList ? columnsList.join(',') : '*';
    const whereFingerprint = this.fingerprintWhere(whereObj);
    const withFp = args.with ? this.withFingerprint(args.with as WithClause) : '';
    const ck = `fu:${whereFingerprint}|c=${colKey}|w=${withFp}`;

    const params: unknown[] = [];

    // Check if all where values are simple (plain equality, no operators/null/OR)
    const whereKeys = Object.keys(whereObj).filter((k) => whereObj[k] !== undefined);
    const isSimpleWhere =
      !whereObj.OR &&
      !whereObj.AND &&
      !whereObj.NOT &&
      whereKeys.every((k) => {
        const v = whereObj[k];
        return v !== null && !isWhereOperator(v) && !this.tableMeta.relations[k];
      });

    // Simple path: plain equality, no operators/null/OR
    if (!args.with && isSimpleWhere) {
      const entry = this.acquireSql(ck, () => {
        const qt = this.q(this.table);
        const tempParams: unknown[] = whereKeys.map((k) => whereObj[k]);
        const whereClauses = whereKeys.map((k, i) => `${this.toSqlColumn(k)} = ${this.p(i + 1)}`);
        const whereSql = whereClauses.length > 0 ? ` WHERE ${whereClauses.join(' AND ')}` : '';
        const selectExpr = columnsList ? columnsList.map((c) => `${qt}.${this.q(c)}`).join(', ') : `${qt}.*`;
        void tempParams; // params are positional, SQL is value-invariant
        return `SELECT ${selectExpr} FROM ${qt}${whereSql} LIMIT 1`;
      });

      // Collect params (same order as build)
      for (const k of whereKeys) {
        params.push(whereObj[k]);
      }

      return {
        sql: entry.sql,
        params,
        transform: (result) => {
          const row = result.rows[0];
          return row ? (this.parseRow(row, this.table) as T) : null;
        },
        tag: `${this.table}.findUnique`,
        preparedName: entry.name,
      };
    }

    // General path (with operators, null, OR, with clause)
    if (!args.with) {
      const entry = this.acquireSql(ck, () => {
        const freshParams: unknown[] = [];
        const clause = this.buildWhereClause(whereObj, freshParams);
        const whereSql = clause ? ` WHERE ${clause}` : '';
        const qt = this.q(this.table);
        const selectExpr = columnsList ? columnsList.map((c) => `${qt}.${this.q(c)}`).join(', ') : `${qt}.*`;
        return `SELECT ${selectExpr} FROM ${qt}${whereSql} LIMIT 1`;
      });

      // Collect params
      this.collectWhereParams(whereObj, params);

      return {
        sql: entry.sql,
        params,
        transform: (result) => {
          const row = result.rows[0];
          return row ? (this.parseRow(row, this.table) as T) : null;
        },
        tag: `${this.table}.findUnique`,
        preparedName: entry.name,
      };
    }

    // Nested queries with `with` clause.
    // The param order in the original code is:
    //   1. buildWhere pushes where params
    //   2. buildSelectWithRelations pushes relation params to same array
    // We must preserve this exact order.
    const entry = this.acquireSql(ck, () => {
      const freshParams: unknown[] = [];
      const clause = this.buildWhereClause(whereObj, freshParams);
      const whereSql = clause ? ` WHERE ${clause}` : '';
      const selectClause = this.buildSelectWithRelations(this.table, args.with as WithClause, freshParams, columnsList);
      return `SELECT ${selectClause} FROM ${this.q(this.table)}${whereSql} LIMIT 1`;
    });

    // Collect params in exact build order: where first, then with-clause relations
    this.collectWhereParams(whereObj, params);
    this.collectWithParams(args.with as WithClause, params);

    return {
      sql: entry.sql,
      params,
      transform: (result) => {
        const row = result.rows[0];
        return row ? (this.parseNestedRow(row, this.table) as T) : null;
      },
      tag: `${this.table}.findUnique`,
      preparedName: entry.name,
    };
  }

  // -------------------------------------------------------------------------
  // findMany
  // -------------------------------------------------------------------------

  async findMany<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause" — matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args?: FindManyArgs<T, R, W, S, O>): Promise<QueryResult<T, R, W, S, O>[]> {
    this.maybeWarnUnlimited(args);

    // Dev-only: warn on deeply nested with clauses
    if (process.env.NODE_ENV !== 'production') {
      if (args?.with) {
        const depth = this.measureWithDepth(args.with as WithClause);
        if (depth > 5 && !this.deepWithWarned.has(this.table)) {
          this.deepWithWarned.add(this.table);
          console.warn(
            `[turbine] Deep with clause (depth ${depth}) on "${this.tableMeta.name}" — ` +
              'consider splitting into separate queries for better performance.',
          );
        }
      }
    }

    return this.executeWithMiddleware('findMany', (args ?? {}) as Record<string, unknown>, async () => {
      const deferred = this.buildFindMany(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args?.timeout, deferred.preparedName);
      return deferred.transform(result);
    }) as Promise<QueryResult<T, R, W, S, O>[]>;
  }

  /**
   * Emit a one-time `console.warn` when {@link findMany} is called without an
   * explicit `limit`/`take` and `warnOnUnlimited` has not been disabled.
   *
   * Deduped per QueryInterface instance via {@link warnedTables} so a busy
   * loop calling `db.users.findMany()` thousands of times only logs once.
   * Suppressed when `defaultLimit` is configured (the caller has already
   * opted in to a bounded query) and when the user passed an explicit
   * `limit`, `take`, or `cursor`.
   */
  private maybeWarnUnlimited(args?: { limit?: number; take?: number; cursor?: unknown }): void {
    if (!this.warnOnUnlimited) return;
    if (this.defaultLimit !== undefined) return;
    const hasExplicitLimit = args?.limit !== undefined || args?.take !== undefined || args?.cursor !== undefined;
    if (hasExplicitLimit) return;
    if (this.warnedTables.has(this.table)) return;
    this.warnedTables.add(this.table);
    console.warn(
      `[turbine] warning: findMany on "${this.table}" has no limit — this will fetch every row. ` +
        'Pass `limit` or set `warnOnUnlimited: false` in config to silence.',
    );
  }

  /**
   * Recursively measure the maximum depth of a `with` clause tree.
   * Used by the dev-only deep-with warning guard.
   */
  private measureWithDepth(withClause: WithClause): number {
    let maxDepth = 1;
    for (const spec of Object.values(withClause)) {
      if (spec && typeof spec === 'object' && 'with' in spec && spec.with) {
        const nested = this.measureWithDepth(spec.with as WithClause);
        maxDepth = Math.max(maxDepth, 1 + nested);
      }
    }
    return maxDepth;
  }

  // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause" — matches TypedWithClause default
  buildFindMany<W extends TypedWithClause<R> = {}>(
    args?: FindManyArgs<T, R, W, Record<string, boolean> | undefined, Record<string, boolean> | undefined>,
  ): DeferredQuery<T[]> {
    const columnsList = this.resolveColumns(args?.select, args?.omit);
    const colKey = columnsList ? columnsList.join(',') : '*';
    const whereObj = (args?.where ?? {}) as Record<string, unknown>;

    // Build fingerprint for cache lookup
    const whereFp = args?.where ? this.fingerprintWhere(whereObj) : '';
    const withFp = args?.with ? this.withFingerprint(args.with as WithClause) : '';
    const orderFp = args?.orderBy
      ? Object.entries(args.orderBy)
          .map(([k, d]) => {
            // Vector KNN ordering changes the emitted SQL operator by metric and
            // adds a `::vector` param, so the metric + direction must be part of
            // the cache key — otherwise two KNN queries differing only in metric
            // would collide on a single cached SQL string.
            if (isVectorOrderBy(d)) {
              return `${k}:vec(${d.distance.metric},${d.distance.direction ?? 'asc'})`;
            }
            return `${k}:${d}`;
          })
          .join(',')
      : '';
    const cursorFp = args?.cursor
      ? Object.keys(args.cursor as Record<string, unknown>)
          .filter((k) => (args.cursor as Record<string, unknown>)[k] !== undefined)
          .sort()
          .join(',')
      : '';
    const distinctFp = args?.distinct ? args.distinct.slice().sort().join(',') : '';
    const effectiveLimit = args?.take ?? args?.limit ?? this.defaultLimit;
    const limitFp = effectiveLimit !== undefined ? '1' : '0';
    const offsetFp = args?.offset !== undefined ? '1' : '0';

    const ck = `fm:${whereFp}|c=${colKey}|o=${orderFp}|l=${limitFp}|off=${offsetFp}|cur=${cursorFp}|d=${distinctFp}|w=${withFp}`;

    const params: unknown[] = [];

    const entry = this.acquireSql(ck, () => {
      // Fresh build — generates SQL and populates freshParams
      const freshParams: unknown[] = [];
      const { sql: freshWhereSql } = args?.where
        ? (() => {
            const clause = this.buildWhereClause(whereObj, freshParams);
            return { sql: clause ? ` WHERE ${clause}` : '' };
          })()
        : { sql: '' };

      const qt = this.q(this.table);

      let distinctPrefix = '';
      if (args?.distinct && args.distinct.length > 0) {
        const distinctCols = args.distinct.map((k) => this.toSqlColumn(k as string));
        distinctPrefix = `DISTINCT ON (${distinctCols.join(', ')}) `;
      }

      let selectClause: string;
      if (args?.with) {
        selectClause = this.buildSelectWithRelations(this.table, args.with as WithClause, freshParams, columnsList);
      } else if (columnsList) {
        selectClause = columnsList.map((c) => `${qt}.${this.q(c)}`).join(', ');
      } else {
        selectClause = `${qt}.*`;
      }

      let sql = `SELECT ${distinctPrefix}${selectClause} FROM ${qt}${freshWhereSql}`;

      if (args?.cursor) {
        const cursorEntries = Object.entries(args.cursor as Record<string, unknown>).filter(([, v]) => v !== undefined);
        if (cursorEntries.length > 0) {
          const cursorConditions = cursorEntries.map(([k, v]) => {
            const col = this.toSqlColumn(k);
            const dir = args.orderBy?.[k] ?? 'asc';
            const op = dir === 'desc' ? '<' : '>';
            freshParams.push(v);
            return `${qt}.${col} ${op} ${this.p(freshParams.length)}`;
          });
          if (freshWhereSql) {
            sql += ` AND ${cursorConditions.join(' AND ')}`;
          } else {
            sql += ` WHERE ${cursorConditions.join(' AND ')}`;
          }
        }
      }

      if (args?.orderBy) {
        // Pass freshParams so vector KNN ordering binds its `$n::vector` query
        // vector at the correct position (after cursor params, before LIMIT).
        sql += ` ORDER BY ${this.buildOrderBy(args.orderBy, freshParams)}`;
      }

      if (effectiveLimit !== undefined) {
        freshParams.push(Number(effectiveLimit));
        sql += ` LIMIT ${this.p(freshParams.length)}`;
      }
      if (args?.offset !== undefined) {
        freshParams.push(Number(args.offset));
        sql += ` OFFSET ${this.p(freshParams.length)}`;
      }

      return sql;
    });

    // Collect params in exact build order:
    // 1. WHERE params
    if (args?.where) {
      this.collectWhereParams(whereObj, params);
    }
    // 2. WITH relation params
    if (args?.with) {
      this.collectWithParams(args.with as WithClause, params);
    }
    // 3. Cursor params
    if (args?.cursor) {
      const cursorEntries = Object.entries(args.cursor as Record<string, unknown>).filter(([, v]) => v !== undefined);
      for (const [, v] of cursorEntries) {
        params.push(v);
      }
    }
    // 4. ORDER BY params (vector KNN ordering binds a `$n::vector` query vector).
    //    Mirrors buildOrderBy's push order — between cursor and LIMIT.
    if (args?.orderBy) {
      this.collectOrderByParams(args.orderBy, params);
    }
    // 5. LIMIT param
    if (effectiveLimit !== undefined) {
      params.push(Number(effectiveLimit));
    }
    // 6. OFFSET param
    if (args?.offset !== undefined) {
      params.push(Number(args.offset));
    }

    return {
      sql: entry.sql,
      params,
      transform: (result) =>
        result.rows.map((row) =>
          args?.with ? (this.parseNestedRow(row, this.table) as T) : (this.parseRow(row, this.table) as T),
        ),
      tag: `${this.table}.findMany`,
      preparedName: entry.name,
    };
  }

  // -------------------------------------------------------------------------
  // findManyStream — async iterable using PostgreSQL cursors
  // -------------------------------------------------------------------------

  /**
   * Stream rows from a findMany query using PostgreSQL cursors.
   * Returns an AsyncIterable that yields individual rows, fetching in batches internally.
   *
   * **Speculative fast-path:** Before opening a cursor, issues a single
   * `SELECT ... LIMIT batchSize+1`. If the result fits within `batchSize`,
   * all rows are yielded immediately with zero cursor overhead (no BEGIN /
   * DECLARE / CLOSE / COMMIT). Only when the result overflows does the
   * method fall back to the full cursor path.
   *
   * **Cursor path:** Uses DECLARE CURSOR within a dedicated transaction on a
   * single pooled connection. The cursor is automatically closed and the
   * connection released when iteration completes or is terminated early
   * (e.g. `break` from `for await`).
   *
   * **Snapshot semantics note:** The speculative fast-path runs outside a
   * transaction. If the result overflows and the cursor path is opened, the
   * cursor runs in its own transaction — spanning two separate snapshots.
   * For strict single-snapshot semantics, wrap the call in `$transaction`.
   *
   * @example
   * ```ts
   * for await (const user of db.users.findManyStream({ where: { orgId: 1 }, batchSize: 500 })) {
   *   process.stdout.write(`${user.email}\n`);
   * }
   * ```
   */
  async *findManyStream<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause" — matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args?: FindManyStreamArgs<T, R, W, S, O>): AsyncGenerator<QueryResult<T, R, W, S, O>, void, undefined> {
    const batchSize = Math.max(1, Math.floor(Number(args?.batchSize ?? 1000)));
    const hasRelations = !!args?.with;

    // --- Speculative first fetch: try to satisfy the entire drain in one RTT ---
    const speculativeDeferred = this.buildFindMany({
      ...args,
      limit: batchSize + 1,
    } as FindManyArgs<
      T,
      R,
      TypedWithClause<R>,
      Record<string, boolean> | undefined,
      Record<string, boolean> | undefined
    >);

    this.currentAction = 'findManyStream';
    const speculativeResult = await this.queryWithTimeout(
      speculativeDeferred.sql,
      speculativeDeferred.params,
      args?.timeout,
    );

    if (speculativeResult.rows.length <= batchSize) {
      // Small drain — yield all rows and return, no cursor needed
      for (const row of speculativeResult.rows) {
        yield (hasRelations ? this.parseNestedRow(row, this.table) : this.parseRow(row, this.table)) as QueryResult<
          T,
          R,
          W,
          S,
          O
        >;
      }
      return;
    }

    // --- Overflow: fall back to cursor path from scratch ---
    const deferred = this.buildFindMany(args);

    // Acquire a dedicated connection — cursors require a single connection in a transaction
    const client = await this.pool.connect();
    const cursorName = `turbine_cursor_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const quotedCursor = this.q(cursorName);

    try {
      await client.query('BEGIN');
      await client.query(`DECLARE ${quotedCursor} NO SCROLL CURSOR FOR ${deferred.sql}`, deferred.params);

      while (true) {
        const batch = await client.query(`FETCH ${batchSize} FROM ${quotedCursor}`);
        if (batch.rows.length === 0) break;

        for (const row of batch.rows) {
          yield (hasRelations ? this.parseNestedRow(row, this.table) : this.parseRow(row, this.table)) as QueryResult<
            T,
            R,
            W,
            S,
            O
          >;
        }

        if (batch.rows.length < batchSize) break;
      }

      await client.query(`CLOSE ${quotedCursor}`);
      await client.query('COMMIT');
    } catch (err) {
      // Rollback on error (also closes cursor implicitly)
      try {
        await client.query('ROLLBACK');
      } catch {
        // Connection may already be broken — ignore rollback error
      }
      // Wrap pg constraint errors so streaming surfaces typed errors like the rest of the API
      throw wrapPgError(err);
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // findFirst — like findMany but returns a single row or null
  // -------------------------------------------------------------------------

  async findFirst<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause" — matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args?: FindManyArgs<T, R, W, S, O>): Promise<QueryResult<T, R, W, S, O> | null> {
    return this.executeWithMiddleware('findFirst', (args ?? {}) as Record<string, unknown>, async () => {
      const deferred = this.buildFindFirst(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args?.timeout, deferred.preparedName);
      return deferred.transform(result);
    }) as Promise<QueryResult<T, R, W, S, O> | null>;
  }

  // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause" — matches TypedWithClause default
  buildFindFirst<W extends TypedWithClause<R> = {}>(
    args?: FindManyArgs<T, R, W, Record<string, boolean> | undefined, Record<string, boolean> | undefined>,
  ): DeferredQuery<T | null> {
    // Reuse findMany's SQL builder but force LIMIT 1
    const findManyArgs = { ...args, limit: 1 } as FindManyArgs<
      T,
      R,
      W,
      Record<string, boolean> | undefined,
      Record<string, boolean> | undefined
    >;
    const deferred = this.buildFindMany(findManyArgs);

    return {
      sql: deferred.sql,
      params: deferred.params,
      transform: (result) => {
        const rows = deferred.transform(result);
        return rows.length > 0 ? rows[0]! : null;
      },
      tag: `${this.table}.findFirst`,
    };
  }

  // -------------------------------------------------------------------------
  // findFirstOrThrow — like findFirst but throws if no record found
  // -------------------------------------------------------------------------

  async findFirstOrThrow<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause" — matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args?: FindManyArgs<T, R, W, S, O>): Promise<QueryResult<T, R, W, S, O>> {
    return this.executeWithMiddleware('findFirstOrThrow', (args ?? {}) as Record<string, unknown>, async () => {
      const deferred = this.buildFindFirstOrThrow(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args?.timeout, deferred.preparedName);
      return deferred.transform(result);
    }) as Promise<QueryResult<T, R, W, S, O>>;
  }

  // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause" — matches TypedWithClause default
  buildFindFirstOrThrow<W extends TypedWithClause<R> = {}>(
    args?: FindManyArgs<T, R, W, Record<string, boolean> | undefined, Record<string, boolean> | undefined>,
  ): DeferredQuery<T> {
    const inner = this.buildFindFirst(args);

    return {
      sql: inner.sql,
      params: inner.params,
      transform: (result) => {
        const row = inner.transform(result);
        if (row === null) {
          throw new NotFoundError({
            table: this.table,
            where: args?.where,
            operation: 'findFirstOrThrow',
          });
        }
        return row;
      },
      tag: `${this.table}.findFirstOrThrow`,
    };
  }

  // -------------------------------------------------------------------------
  // findUniqueOrThrow — like findUnique but throws if no record found
  // -------------------------------------------------------------------------

  async findUniqueOrThrow<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause" — matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args: FindUniqueArgs<T, R, W, S, O>): Promise<QueryResult<T, R, W, S, O>> {
    return this.executeWithMiddleware('findUniqueOrThrow', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildFindUniqueOrThrow(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args.timeout, deferred.preparedName);
      return deferred.transform(result);
    }) as Promise<QueryResult<T, R, W, S, O>>;
  }

  // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause" — matches TypedWithClause default
  buildFindUniqueOrThrow<W extends TypedWithClause<R> = {}>(
    args: FindUniqueArgs<T, R, W, Record<string, boolean> | undefined, Record<string, boolean> | undefined>,
  ): DeferredQuery<T> {
    const inner = this.buildFindUnique(args);

    return {
      sql: inner.sql,
      params: inner.params,
      transform: (result) => {
        const row = inner.transform(result);
        if (row === null) {
          throw new NotFoundError({
            table: this.table,
            where: args.where,
            operation: 'findUniqueOrThrow',
          });
        }
        return row;
      },
      tag: `${this.table}.findUniqueOrThrow`,
    };
  }

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  async create(args: CreateArgs<T>): Promise<T> {
    return this.executeWithMiddleware('create', args as unknown as Record<string, unknown>, async () => {
      if (hasRelationFields(args.data as Record<string, unknown>, this.tableMeta)) {
        return this.nestedCreate(args);
      }
      const deferred = this.buildCreate(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args.timeout, deferred.preparedName);
      return deferred.transform(result);
    });
  }

  buildCreate(args: CreateArgs<T>): DeferredQuery<T> {
    const entries = Object.entries(args.data as Record<string, unknown>).filter(([, v]) => v !== undefined);
    const columns = entries.map(([k]) => this.toSqlColumn(k));
    const params = entries.map(([, v]) => v);
    const placeholders = entries.map((_, i) => `${this.p(i + 1)}`);

    const sql = this.dialect.buildInsertStatement({
      table: this.q(this.table),
      columns,
      valuePlaceholders: placeholders,
      returning: '*',
    });

    return {
      sql,
      params,
      transform: (result) => {
        const row = result.rows[0];
        if (!row) {
          throw new NotFoundError({
            table: this.table,
            operation: 'create',
            message: `[turbine] create on "${this.table}" returned no row from RETURNING * — this should never happen.`,
          });
        }
        return this.parseRow(row, this.table) as T;
      },
      tag: `${this.table}.create`,
    };
  }

  // -------------------------------------------------------------------------
  // createMany — uses UNNEST for performance
  // -------------------------------------------------------------------------

  async createMany(args: CreateManyArgs<T>): Promise<T[]> {
    return this.executeWithMiddleware('createMany', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildCreateMany(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args.timeout, deferred.preparedName);
      return deferred.transform(result);
    });
  }

  buildCreateMany(args: CreateManyArgs<T>): DeferredQuery<T[]> {
    const qt = this.q(this.table);
    if (args.data.length === 0) {
      return {
        sql: `SELECT * FROM ${qt} WHERE false`,
        params: [],
        transform: () => [],
        tag: `${this.table}.createMany`,
      };
    }

    const keys = Object.keys(args.data[0]!).filter((k) => (args.data[0] as Record<string, unknown>)[k] !== undefined);
    const columns = keys.map((k) => this.toColumn(k));

    const rowValues = args.data.map((row) => {
      const record = row as Record<string, unknown>;
      return keys.map((key) => record[key]);
    });

    // Use actual Postgres types for array casts in the default PostgreSQL dialect.
    const typeCasts = columns.map((col) => this.getColumnArrayType(col));
    const quotedColumns = columns.map((c) => this.q(c));

    const built = this.dialect.buildBulkInsertStatement({
      table: qt,
      columns: quotedColumns,
      rowValues,
      columnArrayTypes: typeCasts,
      skipDuplicates: args.skipDuplicates,
      returning: '*',
    });

    return {
      sql: built.sql,
      params: built.params,
      transform: (result) => result.rows.map((row) => this.parseRow(row, this.table) as T),
      tag: `${this.table}.createMany`,
    };
  }

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------

  async update(args: UpdateArgs<T>): Promise<T> {
    return this.executeWithMiddleware('update', args as unknown as Record<string, unknown>, async () => {
      if (hasRelationFields(args.data as Record<string, unknown>, this.tableMeta)) {
        return this.nestedUpdate(args);
      }
      const deferred = this.buildUpdate(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args.timeout, deferred.preparedName);
      return deferred.transform(result);
    });
  }

  buildUpdate(args: UpdateArgs<T>): DeferredQuery<T> {
    const dataObj = args.data as Record<string, unknown>;
    const whereObj = args.where as Record<string, unknown>;
    const lock = args.optimisticLock;
    const setFp = this.fingerprintSet(dataObj);
    const whereFp = this.fingerprintWhere(whereObj);
    const ck = lock ? null : `u:${setFp}|${whereFp}`;

    const params: unknown[] = [];

    const buildSql = () => {
      const freshParams: unknown[] = [];
      const setEntries = Object.entries(dataObj).filter(([, v]) => v !== undefined);
      const setClauses = setEntries.map(([k, v]) => this.buildSetClause(k, v, freshParams));

      if (lock) {
        const versionCol = this.toSqlColumn(lock.field);
        setClauses.push(`${versionCol} = ${versionCol} + 1`);
      }

      const whereClause = this.buildWhereClause(whereObj, freshParams);
      let whereSql = whereClause ? ` WHERE ${whereClause}` : '';

      if (lock) {
        const versionCol = this.toSqlColumn(lock.field);
        freshParams.push(lock.expected);
        const versionCheck = `${versionCol} = ${this.p(freshParams.length)}`;
        whereSql = whereSql ? `${whereSql} AND ${versionCheck}` : ` WHERE ${versionCheck}`;
      }

      this.assertMutationHasPredicate('update', whereSql, args.allowFullTableScan);
      return `UPDATE ${this.q(this.table)} SET ${setClauses.join(', ')}${whereSql}${this.dialect.buildReturningClause('*')}`;
    };

    let sql: string;
    let preparedName: string | undefined;

    if (ck) {
      const entry = this.acquireSql(ck, buildSql);
      sql = entry.sql;
      preparedName = entry.name;
      if (whereFp === '') {
        this.assertMutationHasPredicate('update', '', args.allowFullTableScan);
      }
    } else {
      sql = buildSql();
    }

    // Collect params: SET first, then WHERE, then version check (same order as fresh build)
    this.collectSetParams(dataObj, params);
    this.collectWhereParams(whereObj, params);
    if (lock) {
      params.push(lock.expected);
    }

    return {
      sql,
      params,
      transform: (result) => {
        const row = result.rows[0];
        if (!row) {
          if (lock) {
            throw new OptimisticLockError({
              table: this.table,
              versionField: lock.field,
              expectedVersion: lock.expected,
            });
          }
          throw new NotFoundError({
            table: this.table,
            where: args.where,
            operation: 'update',
          });
        }
        return this.parseRow(row, this.table) as T;
      },
      tag: `${this.table}.update`,
      preparedName,
    };
  }

  // -------------------------------------------------------------------------
  // Nested write helpers (shared by create + update)
  // -------------------------------------------------------------------------

  private async nestedCreate(args: CreateArgs<T>): Promise<T> {
    const data = args.data as Record<string, unknown>;

    if (this.txScoped) {
      const ctx = this.buildNestedCtx();
      return executeNestedCreate(ctx, this.table, data) as Promise<T>;
    }

    return this.runInImplicitTx(async (ctx) => {
      const result = await executeNestedCreate(ctx, this.table, data);
      return result as T;
    });
  }

  private async nestedUpdate(args: UpdateArgs<T>): Promise<T> {
    const data = args.data as Record<string, unknown>;
    const where = args.where as Record<string, unknown>;

    if (this.txScoped) {
      const ctx = this.buildNestedCtx();
      return executeNestedUpdate(ctx, this.table, where, data) as Promise<T>;
    }

    return this.runInImplicitTx(async (ctx) => {
      const result = await executeNestedUpdate(ctx, this.table, where, data);
      return result as T;
    });
  }

  private async runInImplicitTx<R>(fn: (ctx: NestedWriteContext) => Promise<R>): Promise<R> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { TransactionClient } = await import('../client.js');
      // biome-ignore lint/suspicious/noExplicitAny: MiddlewareFn and Middleware are structurally identical
      const tx = new TransactionClient(client as any, this.schema, this.middlewares as any, this.options);
      // biome-ignore lint/suspicious/noExplicitAny: TransactionClient satisfies NestedWriteContext['tx'] at runtime
      const ctx: NestedWriteContext = { schema: this.schema, tx: tx as any };
      const result = await fn(ctx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Best-effort rollback — connection may have died.
      }
      throw err;
    } finally {
      client.release();
    }
  }

  private buildNestedCtx(): NestedWriteContext {
    const pool = this.pool;
    const schema = this.schema;
    const middlewares = this.middlewares;
    const opts: QueryInterfaceOptions = { ...this.options, _txScoped: true };
    return {
      schema,
      tx: this.makeTxProxy(pool, schema, middlewares, opts),
    };
  }

  // biome-ignore lint/suspicious/noExplicitAny: bridges MiddlewareFn[] ↔ Middleware[] and QI ↔ NestedWriteContext type gap
  private makeTxProxy(pool: any, schema: SchemaMetadata, middlewares: any, opts: QueryInterfaceOptions): any {
    return {
      table: <U extends object>(name: string) => new QueryInterface<U>(pool, name, schema, middlewares, opts),
    };
  }

  // -------------------------------------------------------------------------
  // delete
  // -------------------------------------------------------------------------

  async delete(args: DeleteArgs<T>): Promise<T> {
    return this.executeWithMiddleware('delete', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildDelete(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args.timeout, deferred.preparedName);
      return deferred.transform(result);
    });
  }

  buildDelete(args: DeleteArgs<T>): DeferredQuery<T> {
    const whereObj = args.where as Record<string, unknown>;
    const whereFp = this.fingerprintWhere(whereObj);
    const ck = `d:${whereFp}`;

    const params: unknown[] = [];

    // We need to check the mutation predicate. Build the whereSql to test it.
    // On cache hit we still need to validate (the shape may be empty).
    const entry = this.acquireSql(ck, () => {
      const freshParams: unknown[] = [];
      const clause = this.buildWhereClause(whereObj, freshParams);
      const whereSql = clause ? ` WHERE ${clause}` : '';
      this.assertMutationHasPredicate('delete', whereSql, args.allowFullTableScan);
      return `DELETE FROM ${this.q(this.table)}${whereSql}${this.dialect.buildReturningClause('*')}`;
    });

    // On cache hit, still validate the predicate
    if (whereFp === '') {
      this.assertMutationHasPredicate('delete', '', args.allowFullTableScan);
    }

    this.collectWhereParams(whereObj, params);

    return {
      sql: entry.sql,
      params,
      transform: (result) => {
        const row = result.rows[0];
        if (!row) {
          throw new NotFoundError({
            table: this.table,
            where: args.where,
            operation: 'delete',
          });
        }
        return this.parseRow(row, this.table) as T;
      },
      tag: `${this.table}.delete`,
      preparedName: entry.name,
    };
  }

  // -------------------------------------------------------------------------
  // upsert — INSERT ... ON CONFLICT ... DO UPDATE
  // -------------------------------------------------------------------------

  async upsert(args: UpsertArgs<T>): Promise<T> {
    return this.executeWithMiddleware('upsert', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildUpsert(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args.timeout, deferred.preparedName);
      return deferred.transform(result);
    });
  }

  buildUpsert(args: UpsertArgs<T>): DeferredQuery<T> {
    // Build the INSERT part from create data
    const createEntries = Object.entries(args.create as Record<string, unknown>).filter(([, v]) => v !== undefined);
    const columns = createEntries.map(([k]) => this.toSqlColumn(k));
    const createParams = createEntries.map(([, v]) => v);
    const placeholders = createEntries.map((_, i) => `${this.p(i + 1)}`);

    // The conflict target comes from `where` keys — must be unique/PK columns
    const conflictKeys = Object.keys(args.where as Record<string, unknown>).filter(
      (k) => (args.where as Record<string, unknown>)[k] !== undefined,
    );
    const conflictColumns = conflictKeys.map((k) => this.toSqlColumn(k));

    // Build the UPDATE SET part
    const updateEntries = Object.entries(args.update as Record<string, unknown>).filter(([, v]) => v !== undefined);
    let paramIdx = createParams.length + 1;
    const setClauses = updateEntries.map(([k]) => {
      const clause = `${this.toSqlColumn(k)} = ${this.p(paramIdx)}`;
      paramIdx++;
      return clause;
    });
    const updateParams = updateEntries.map(([, v]) => v);

    const params = [...createParams, ...updateParams];

    const sql = this.dialect.buildUpsertStatement({
      table: this.q(this.table),
      insertColumns: columns,
      valuePlaceholders: placeholders,
      conflictColumns,
      updateSetClauses: setClauses,
      returning: '*',
    });

    return {
      sql,
      params,
      transform: (result) => {
        const row = result.rows[0];
        if (!row) {
          throw new NotFoundError({
            table: this.table,
            where: args.where,
            operation: 'upsert',
            message: `[turbine] upsert on "${this.table}" returned no row from RETURNING * — this should never happen.`,
          });
        }
        return this.parseRow(row, this.table) as T;
      },
      tag: `${this.table}.upsert`,
    };
  }

  // -------------------------------------------------------------------------
  // updateMany — UPDATE ... WHERE ... returning count
  // -------------------------------------------------------------------------

  async updateMany(args: UpdateManyArgs<T>): Promise<{ count: number }> {
    return this.executeWithMiddleware('updateMany', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildUpdateMany(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args.timeout, deferred.preparedName);
      return deferred.transform(result);
    });
  }

  buildUpdateMany(args: UpdateManyArgs<T>): DeferredQuery<{ count: number }> {
    const dataObj = args.data as Record<string, unknown>;
    const whereObj = args.where as Record<string, unknown>;
    const setFp = this.fingerprintSet(dataObj);
    const whereFp = this.fingerprintWhere(whereObj);
    const ck = `um:${setFp}|${whereFp}`;

    const params: unknown[] = [];

    const entry = this.acquireSql(ck, () => {
      const freshParams: unknown[] = [];
      const setEntries = Object.entries(dataObj).filter(([, v]) => v !== undefined);
      const setClauses = setEntries.map(([k, v]) => this.buildSetClause(k, v, freshParams));
      const whereClause = this.buildWhereClause(whereObj, freshParams);
      const whereSql = whereClause ? ` WHERE ${whereClause}` : '';
      this.assertMutationHasPredicate('updateMany', whereSql, args.allowFullTableScan);
      return `UPDATE ${this.q(this.table)} SET ${setClauses.join(', ')}${whereSql}`;
    });

    if (whereFp === '') {
      this.assertMutationHasPredicate('updateMany', '', args.allowFullTableScan);
    }

    this.collectSetParams(dataObj, params);
    this.collectWhereParams(whereObj, params);

    return {
      sql: entry.sql,
      params,
      transform: (result) => ({ count: result.rowCount ?? 0 }),
      tag: `${this.table}.updateMany`,
      preparedName: entry.name,
    };
  }

  // -------------------------------------------------------------------------
  // deleteMany — DELETE ... WHERE ... returning count
  // -------------------------------------------------------------------------

  async deleteMany(args: DeleteManyArgs<T>): Promise<{ count: number }> {
    return this.executeWithMiddleware('deleteMany', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildDeleteMany(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args.timeout, deferred.preparedName);
      return deferred.transform(result);
    });
  }

  buildDeleteMany(args: DeleteManyArgs<T>): DeferredQuery<{ count: number }> {
    const whereObj = args.where as Record<string, unknown>;
    const whereFp = this.fingerprintWhere(whereObj);
    const ck = `dm:${whereFp}`;

    const params: unknown[] = [];

    const entry = this.acquireSql(ck, () => {
      const freshParams: unknown[] = [];
      const clause = this.buildWhereClause(whereObj, freshParams);
      const whereSql = clause ? ` WHERE ${clause}` : '';
      this.assertMutationHasPredicate('deleteMany', whereSql, args.allowFullTableScan);
      return `DELETE FROM ${this.q(this.table)}${whereSql}`;
    });

    if (whereFp === '') {
      this.assertMutationHasPredicate('deleteMany', '', args.allowFullTableScan);
    }

    this.collectWhereParams(whereObj, params);

    return {
      sql: entry.sql,
      params,
      transform: (result) => ({ count: result.rowCount ?? 0 }),
      tag: `${this.table}.deleteMany`,
      preparedName: entry.name,
    };
  }

  // -------------------------------------------------------------------------
  // count
  // -------------------------------------------------------------------------

  async count(args?: CountArgs<T>): Promise<number> {
    return this.executeWithMiddleware('count', (args ?? {}) as Record<string, unknown>, async () => {
      const deferred = this.buildCount(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args?.timeout, deferred.preparedName);
      return deferred.transform(result);
    });
  }

  buildCount(args?: CountArgs<T>): DeferredQuery<number> {
    const whereObj = (args?.where ?? {}) as Record<string, unknown>;
    const whereFp = args?.where ? this.fingerprintWhere(whereObj) : '';
    const ck = `cnt:${whereFp}`;

    const params: unknown[] = [];

    const entry = this.acquireSql(ck, () => {
      const freshParams: unknown[] = [];
      const clause = args?.where ? this.buildWhereClause(whereObj, freshParams) : null;
      const whereSql = clause ? ` WHERE ${clause}` : '';
      return `SELECT COUNT(*)::int AS count FROM ${this.q(this.table)}${whereSql}`;
    });

    if (args?.where) {
      this.collectWhereParams(whereObj, params);
    }

    return {
      sql: entry.sql,
      params,
      transform: (result) => (result.rows[0] as { count: number }).count,
      tag: `${this.table}.count`,
      preparedName: entry.name,
    };
  }

  // -------------------------------------------------------------------------
  // groupBy (with aggregate functions)
  // -------------------------------------------------------------------------

  async groupBy(args: GroupByArgs<T>): Promise<Record<string, unknown>[]> {
    return this.executeWithMiddleware('groupBy', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildGroupBy(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args.timeout, deferred.preparedName);
      return deferred.transform(result);
    });
  }

  buildGroupBy(args: GroupByArgs<T>): DeferredQuery<Record<string, unknown>[]> {
    const meta = this.schema.tables[this.table];
    if (meta) {
      for (const key of args.by) {
        if (!((key as string) in meta.columnMap)) {
          throw new ValidationError(`Unknown column "${key as string}" in groupBy for table "${this.table}"`);
        }
      }
    }
    const groupColsRaw = args.by.map((k) => this.toColumn(k as string));
    const groupCols = groupColsRaw.map((c) => this.q(c));
    const { sql: whereSql, params } = args.where ? this.buildWhere(args.where) : { sql: '', params: [] as unknown[] };

    // Build SELECT expressions: group-by columns + aggregate functions
    const selectExprs = [...groupCols];

    // _count
    if (args._count === true || args._count === undefined) {
      // default: always include count
      selectExprs.push('COUNT(*)::int AS _count');
    }

    // _sum
    if (args._sum) {
      for (const [field, enabled] of Object.entries(args._sum)) {
        if (enabled) {
          const col = this.toColumn(field);
          selectExprs.push(`SUM(${this.q(col)}) AS ${this.q(`_sum_${col}`)}`);
        }
      }
    }

    // _avg
    if (args._avg) {
      for (const [field, enabled] of Object.entries(args._avg)) {
        if (enabled) {
          const col = this.toColumn(field);
          selectExprs.push(`AVG(${this.q(col)})::float AS ${this.q(`_avg_${col}`)}`);
        }
      }
    }

    // _min
    if (args._min) {
      for (const [field, enabled] of Object.entries(args._min)) {
        if (enabled) {
          const col = this.toColumn(field);
          selectExprs.push(`MIN(${this.q(col)}) AS ${this.q(`_min_${col}`)}`);
        }
      }
    }

    // _max
    if (args._max) {
      for (const [field, enabled] of Object.entries(args._max)) {
        if (enabled) {
          const col = this.toColumn(field);
          selectExprs.push(`MAX(${this.q(col)}) AS ${this.q(`_max_${col}`)}`);
        }
      }
    }

    let sql = `SELECT ${selectExprs.join(', ')} FROM ${this.q(this.table)}${whereSql} GROUP BY ${groupCols.join(', ')}`;

    // HAVING — filter whole groups by their aggregate values.
    // Appends to the same `params` array, so placeholders continue from the
    // WHERE clause's parameter positions (this.p(params.length) below).
    if (args.having) {
      const havingClauses = this.buildHavingClauses(args.having, params);
      if (havingClauses.length > 0) {
        sql += ` HAVING ${havingClauses.join(' AND ')}`;
      }
    }

    // ORDER BY
    if (args.orderBy) {
      sql += ` ORDER BY ${this.buildOrderBy(args.orderBy)}`;
    }

    return {
      sql,
      params,
      transform: (result) =>
        result.rows.map((row) => {
          const parsed = this.parseRow(row, this.table);
          // Restructure aggregate results into nested objects (Prisma-style)
          const restructured: Record<string, unknown> = {};

          // Copy group-by fields
          for (const field of args.by) {
            restructured[field] = parsed[field];
          }

          // _count
          if ('_count' in row) {
            restructured._count = row._count;
          } else if ('count' in row) {
            restructured._count = row.count;
          }

          // Collect aggregates into nested objects
          const sumObj: Record<string, unknown> = {};
          const avgObj: Record<string, unknown> = {};
          const minObj: Record<string, unknown> = {};
          const maxObj: Record<string, unknown> = {};
          let hasSums = false,
            hasAvgs = false,
            hasMins = false,
            hasMaxs = false;

          for (const [rawKey, rawValue] of Object.entries(row)) {
            if (rawKey.startsWith('_sum_')) {
              const col = rawKey.slice(5);
              const field = this.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
              sumObj[field] = rawValue !== null ? Number(rawValue) : null;
              hasSums = true;
            } else if (rawKey.startsWith('_avg_')) {
              const col = rawKey.slice(5);
              const field = this.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
              avgObj[field] = rawValue !== null ? Number(rawValue) : null;
              hasAvgs = true;
            } else if (rawKey.startsWith('_min_')) {
              const col = rawKey.slice(5);
              const field = this.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
              minObj[field] = rawValue;
              hasMins = true;
            } else if (rawKey.startsWith('_max_')) {
              const col = rawKey.slice(5);
              const field = this.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
              maxObj[field] = rawValue;
              hasMaxs = true;
            }
          }

          if (hasSums) restructured._sum = sumObj;
          if (hasAvgs) restructured._avg = avgObj;
          if (hasMins) restructured._min = minObj;
          if (hasMaxs) restructured._max = maxObj;

          return restructured;
        }),
      tag: `${this.table}.groupBy`,
    };
  }

  /**
   * Build the SQL fragments for a {@link HavingClause}.
   *
   * Each aggregate expression (`COUNT(*)`, `SUM("col")`, etc.) is constructed
   * from a **schema-validated, quoted** column identifier — `this.toColumn()`
   * throws {@link ValidationError} for unknown fields and `this.q()` quotes via
   * the dialect, so no unvalidated identifier ever reaches the SQL string. Every
   * comparison value is pushed onto the shared `params` array and referenced by
   * a `$N` placeholder via {@link buildHavingNumericClauses} — there is no string
   * interpolation of user values.
   */
  private buildHavingClauses(having: HavingClause<T>, params: unknown[]): string[] {
    const clauses: string[] = [];

    // Maps the per-field aggregate key to its SQL function name. The set of
    // allowed keys is fixed here — any other key on a field's filter object is
    // rejected by ValidationError below (never interpolated).
    const aggFnByKey: Record<string, string> = {
      _sum: 'SUM',
      _avg: 'AVG',
      _min: 'MIN',
      _max: 'MAX',
      _count: 'COUNT',
    };

    for (const [key, value] of Object.entries(having)) {
      if (value === undefined) continue;

      // Top-level `_count` (no field) → COUNT(*) for the whole group.
      if (key === '_count') {
        clauses.push(...this.buildHavingNumericClauses('COUNT(*)', value as HavingFilter, params));
        continue;
      }

      // Otherwise `key` is a field name mapping to a per-aggregate filter object.
      if (typeof value !== 'object' || value === null) {
        throw new ValidationError(
          `[turbine] Invalid having filter for field "${key}" on table "${this.table}": ` +
            `expected an aggregate object like { _sum: { gt: 100 } }.`,
        );
      }

      // toColumn validates the field against schema metadata (throws
      // ValidationError on unknown columns) and q() quotes the identifier — no
      // unvalidated identifier ever reaches the SQL string.
      const quotedCol = this.q(this.toColumn(key));

      for (const [aggKey, filter] of Object.entries(value as Record<string, HavingFilter>)) {
        if (filter === undefined) continue;
        const fn = aggFnByKey[aggKey];
        if (!fn) {
          throw new ValidationError(
            `[turbine] Unknown aggregate "${aggKey}" in having for field "${key}" on table "${this.table}". ` +
              `Supported: ${Object.keys(aggFnByKey).join(', ')}.`,
          );
        }
        const expr = `${fn}(${quotedCol})`;
        clauses.push(...this.buildHavingNumericClauses(expr, filter, params));
      }
    }

    return clauses;
  }

  /**
   * Convert a single having filter into one or more parameterized SQL
   * comparisons against the given aggregate expression. A bare number is
   * shorthand for equality. Unknown operator keys throw {@link ValidationError}.
   */
  private buildHavingNumericClauses(expr: string, filter: HavingFilter, params: unknown[]): string[] {
    // Bare number → equality.
    if (typeof filter === 'number') {
      params.push(filter);
      return [`${expr} = ${this.p(params.length)}`];
    }

    if (typeof filter !== 'object' || filter === null) {
      throw new ValidationError(
        `[turbine] Invalid having filter on "${expr}" for table "${this.table}": expected a number or operator object.`,
      );
    }

    const op = filter as HavingNumericOperator;
    const allowedKeys = new Set(['equals', 'not', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn']);
    for (const k of Object.keys(op)) {
      if (!allowedKeys.has(k)) {
        throw new ValidationError(
          `[turbine] Unknown having operator "${k}" on "${expr}" for table "${this.table}". ` +
            `Supported: ${[...allowedKeys].join(', ')}.`,
        );
      }
    }

    const clauses: string[] = [];
    if (op.equals !== undefined) {
      params.push(op.equals);
      clauses.push(`${expr} = ${this.p(params.length)}`);
    }
    if (op.not !== undefined) {
      params.push(op.not);
      clauses.push(`${expr} != ${this.p(params.length)}`);
    }
    if (op.gt !== undefined) {
      params.push(op.gt);
      clauses.push(`${expr} > ${this.p(params.length)}`);
    }
    if (op.gte !== undefined) {
      params.push(op.gte);
      clauses.push(`${expr} >= ${this.p(params.length)}`);
    }
    if (op.lt !== undefined) {
      params.push(op.lt);
      clauses.push(`${expr} < ${this.p(params.length)}`);
    }
    if (op.lte !== undefined) {
      params.push(op.lte);
      clauses.push(`${expr} <= ${this.p(params.length)}`);
    }
    if (op.in !== undefined) {
      params.push(op.in);
      clauses.push(`${expr} = ANY(${this.p(params.length)})`);
    }
    if (op.notIn !== undefined) {
      params.push(op.notIn);
      clauses.push(`${expr} != ALL(${this.p(params.length)})`);
    }
    return clauses;
  }

  // -------------------------------------------------------------------------
  // aggregate — standalone aggregation without groupBy
  // -------------------------------------------------------------------------

  async aggregate(args: AggregateArgs<T>): Promise<AggregateResult<T>> {
    return this.executeWithMiddleware('aggregate', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildAggregate(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args.timeout, deferred.preparedName);
      return deferred.transform(result);
    });
  }

  buildAggregate(args: AggregateArgs<T>): DeferredQuery<AggregateResult<T>> {
    const { sql: whereSql, params } = args.where ? this.buildWhere(args.where) : { sql: '', params: [] as unknown[] };

    const meta = this.schema.tables[this.table];
    if (meta) {
      for (const group of [args._sum, args._avg, args._min, args._max]) {
        if (group && typeof group === 'object') {
          for (const key of Object.keys(group)) {
            if (!(key in meta.columnMap)) {
              throw new ValidationError(`Unknown column "${key}" in aggregate for table "${this.table}"`);
            }
          }
        }
      }
      if (args._count && typeof args._count === 'object') {
        for (const key of Object.keys(args._count)) {
          if (!(key in meta.columnMap)) {
            throw new ValidationError(`Unknown column "${key}" in aggregate for table "${this.table}"`);
          }
        }
      }
    }

    const selectExprs: string[] = [];

    // _count
    if (args._count === true) {
      selectExprs.push('COUNT(*)::int AS _count');
    } else if (args._count && typeof args._count === 'object') {
      for (const [field, enabled] of Object.entries(args._count)) {
        if (enabled) {
          const col = this.toColumn(field);
          selectExprs.push(`COUNT(${this.q(col)})::int AS ${this.q(`_count_${col}`)}`);
        }
      }
    }

    // _sum
    if (args._sum) {
      for (const [field, enabled] of Object.entries(args._sum)) {
        if (enabled) {
          const col = this.toColumn(field);
          selectExprs.push(`SUM(${this.q(col)}) AS ${this.q(`_sum_${col}`)}`);
        }
      }
    }

    // _avg
    if (args._avg) {
      for (const [field, enabled] of Object.entries(args._avg)) {
        if (enabled) {
          const col = this.toColumn(field);
          selectExprs.push(`AVG(${this.q(col)})::float AS ${this.q(`_avg_${col}`)}`);
        }
      }
    }

    // _min
    if (args._min) {
      for (const [field, enabled] of Object.entries(args._min)) {
        if (enabled) {
          const col = this.toColumn(field);
          selectExprs.push(`MIN(${this.q(col)}) AS ${this.q(`_min_${col}`)}`);
        }
      }
    }

    // _max
    if (args._max) {
      for (const [field, enabled] of Object.entries(args._max)) {
        if (enabled) {
          const col = this.toColumn(field);
          selectExprs.push(`MAX(${this.q(col)}) AS ${this.q(`_max_${col}`)}`);
        }
      }
    }

    if (selectExprs.length === 0) {
      selectExprs.push('COUNT(*)::int AS _count');
    }

    const sql = `SELECT ${selectExprs.join(', ')} FROM ${this.q(this.table)}${whereSql}`;

    return {
      sql,
      params,
      transform: (result) => {
        const row = result.rows[0] as Record<string, unknown>;
        const aggResult: AggregateResult<T> = {};

        // _count
        if (row._count !== undefined) {
          aggResult._count = row._count as number;
        } else {
          // Check for per-column counts
          const countObj: Record<string, number> = {};
          let hasCountFields = false;
          for (const [key, val] of Object.entries(row)) {
            if (key.startsWith('_count_')) {
              const col = key.slice(7);
              const field = this.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
              countObj[field] = val as number;
              hasCountFields = true;
            }
          }
          if (hasCountFields) aggResult._count = countObj;
        }

        // Build nested aggregate objects
        const sumObj: Record<string, number | null> = {};
        const avgObj: Record<string, number | null> = {};
        const minObj: Record<string, unknown> = {};
        const maxObj: Record<string, unknown> = {};
        let hasSums = false,
          hasAvgs = false,
          hasMins = false,
          hasMaxs = false;

        for (const [key, val] of Object.entries(row)) {
          if (key.startsWith('_sum_')) {
            const col = key.slice(5);
            const field = this.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
            sumObj[field] = val !== null ? Number(val) : null;
            hasSums = true;
          } else if (key.startsWith('_avg_')) {
            const col = key.slice(5);
            const field = this.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
            avgObj[field] = val !== null ? Number(val) : null;
            hasAvgs = true;
          } else if (key.startsWith('_min_')) {
            const col = key.slice(5);
            const field = this.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
            minObj[field] = val;
            hasMins = true;
          } else if (key.startsWith('_max_')) {
            const col = key.slice(5);
            const field = this.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
            maxObj[field] = val;
            hasMaxs = true;
          }
        }

        if (hasSums) aggResult._sum = sumObj as Partial<Record<keyof T & string, number | null>>;
        if (hasAvgs) aggResult._avg = avgObj as Partial<Record<keyof T & string, number | null>>;
        if (hasMins) aggResult._min = minObj as Partial<Record<keyof T & string, unknown>>;
        if (hasMaxs) aggResult._max = maxObj as Partial<Record<keyof T & string, unknown>>;

        return aggResult;
      },
      tag: `${this.table}.aggregate`,
    };
  }

  // =========================================================================
  // Internal helpers
  // =========================================================================

  /**
   * Resolve select/omit options into a list of snake_case column names.
   * Returns null if neither is provided (meaning all columns).
   */
  private resolveColumns(select?: Record<string, boolean>, omit?: Record<string, boolean>): string[] | null {
    if (select) {
      // An array here means a caller wrote `select: ['id', 'name']` (Drizzle/SQL
      // style) instead of the object shape. Object.entries() would iterate the
      // numeric indices and throw a cryptic `Unknown field "0"` — catch it early
      // with an actionable message.
      if (Array.isArray(select)) {
        throw new ValidationError(
          `[turbine] "select" must be an object mapping field names to true ` +
            `(e.g. { id: true, name: true }), not an array.`,
        );
      }
      // Only include columns where value is true
      return Object.entries(select)
        .filter(([, v]) => v)
        .map(([k]) => this.toColumn(k));
    }
    if (omit) {
      if (Array.isArray(omit)) {
        throw new ValidationError(
          `[turbine] "omit" must be an object mapping field names to true ` +
            `(e.g. { createdAt: true }), not an array.`,
        );
      }
      // Include all columns except those where value is true
      const omitCols = new Set(
        Object.entries(omit)
          .filter(([, v]) => v)
          .map(([k]) => this.toColumn(k)),
      );
      return this.tableMeta.allColumns.filter((col) => !omitCols.has(col));
    }
    return null;
  }

  /** Convert camelCase field name to snake_case column name (unquoted, for non-SQL uses) */
  private toColumn(field: string): string {
    const mapped = this.tableMeta.columnMap[field];
    if (mapped) return mapped;
    // Fall back to camelToSnake ONLY if that snake_cased name also exists as a
    // real column on the table. This preserves the convenience of writing
    // `userId` when the schema exposes `user_id` under an unusual field name,
    // but rejects arbitrary strings — closing the defense-in-depth gap for
    // SQL injection and catching typos like `where: { emial: 'x' }` with a
    // clear error instead of a cryptic Postgres "column does not exist".
    const snake = camelToSnake(field);
    if (this.tableMeta.reverseColumnMap?.[snake]) {
      return snake;
    }
    if (this.tableMeta.allColumns?.includes(snake)) {
      return snake;
    }
    throw new ValidationError(
      `[turbine] Unknown field "${field}" on table "${this.table}". ` +
        `Known fields: ${Object.keys(this.tableMeta.columnMap).join(', ') || '(none)'}.`,
    );
  }

  /** Convert camelCase field name to a double-quoted SQL identifier */
  private toSqlColumn(field: string): string {
    return this.q(this.toColumn(field));
  }

  /**
   * Build a single SET clause entry for update/updateMany.
   *
   * Supports plain values and atomic operator objects ({ set, increment,
   * decrement, multiply, divide }). An operator object is detected ONLY when
   * it has EXACTLY one key that is one of the 5 operator keys — this avoids
   * misinterpreting JSON column values like `{ set: 'x' }` as operators
   * (real operator objects always have exactly one key, and a plain JSON
   * payload that happens to have a single `set` key is extremely unusual).
   * Multi-key objects are always treated as plain (JSON) values.
   *
   * Returns the SQL fragment (e.g., `"view_count" = "view_count" + $3`) and
   * pushes any required params onto the shared params array so that WHERE
   * clause numbering continues correctly afterward.
   */
  private buildSetClause(key: string, value: unknown, params: unknown[]): string {
    const col = this.toSqlColumn(key);

    // Detect atomic-operator object: plain object (not null, not array, not
    // Date, not Buffer) with EXACTLY one key matching an operator name.
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !(value instanceof Date) &&
      !Buffer.isBuffer(value)
    ) {
      const v = value as Record<string, unknown>;
      const keys = Object.keys(v);
      if (keys.length === 1 && UPDATE_OPERATOR_KEYS.has(keys[0]!)) {
        const op = keys[0]!;
        const opValue = v[op];

        if (op === 'set') {
          params.push(opValue);
          return `${col} = ${this.p(params.length)}`;
        }

        // Arithmetic operators: must be finite numbers
        if (typeof opValue !== 'number' || !Number.isFinite(opValue)) {
          throw new ValidationError(
            `[turbine] update operator "${op}" on "${this.table}.${key}" requires a finite number, got ${typeof opValue}`,
          );
        }

        if (op === 'increment') {
          params.push(opValue);
          return `${col} = ${col} + ${this.p(params.length)}`;
        }
        if (op === 'decrement') {
          params.push(opValue);
          return `${col} = ${col} - ${this.p(params.length)}`;
        }
        if (op === 'multiply') {
          params.push(opValue);
          return `${col} = ${col} * ${this.p(params.length)}`;
        }
        if (op === 'divide') {
          params.push(opValue);
          return `${col} = ${col} / ${this.p(params.length)}`;
        }
      }
      // Fall through: multi-key objects or non-operator single-key objects
      // are treated as plain values (e.g., JSONB column payloads).
    }

    // Plain value (including null, Date, Buffer, arrays, JSON objects)
    params.push(value);
    return `${col} = ${this.p(params.length)}`;
  }

  // =========================================================================
  // Fingerprinting — value-invariant shape keys for SQL cache lookup
  // =========================================================================

  /**
   * Produce a value-invariant fingerprint of a where clause.
   * Same keys + same operator shapes + same combinator structure => same string.
   * Different values (e.g. id=1 vs id=999) => identical fingerprint.
   *
   * @internal Exposed as package-private for testing via class access.
   */
  fingerprintWhere(where: Record<string, unknown>): string {
    const keys = Object.keys(where)
      .filter((k) => where[k] !== undefined)
      .sort();
    if (keys.length === 0) return '';

    const parts: string[] = [];
    for (const key of keys) {
      const value = where[key];
      if (value === undefined) continue;

      if (key === 'OR') {
        const orArr = value as Record<string, unknown>[];
        if (!Array.isArray(orArr) || orArr.length === 0) continue;
        const orParts = orArr.map((cond) => this.fingerprintWhere(cond));
        parts.push(`OR[${orParts.join(',')}]`);
        continue;
      }
      if (key === 'AND') {
        const andArr = value as Record<string, unknown>[];
        if (!Array.isArray(andArr) || andArr.length === 0) continue;
        const andParts = andArr.map((cond) => this.fingerprintWhere(cond));
        parts.push(`AND[${andParts.join(',')}]`);
        continue;
      }
      if (key === 'NOT') {
        const notCond = value as Record<string, unknown>;
        parts.push(`NOT(${this.fingerprintWhere(notCond)})`);
        continue;
      }

      // Relation filters: { posts: { some: { published: true } } }
      const relDef = this.tableMeta.relations[key];
      if (relDef && typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const filterObj = value as Record<string, unknown>;
        if (
          'some' in filterObj ||
          'every' in filterObj ||
          'none' in filterObj ||
          'is' in filterObj ||
          'isNot' in filterObj
        ) {
          const relParts: string[] = [];
          if (filterObj.some !== undefined)
            relParts.push(`some(${this.fingerprintRelFilter(relDef.to, filterObj.some as Record<string, unknown>)})`);
          if (filterObj.every !== undefined)
            relParts.push(`every(${this.fingerprintRelFilter(relDef.to, filterObj.every as Record<string, unknown>)})`);
          if (filterObj.none !== undefined)
            relParts.push(`none(${this.fingerprintRelFilter(relDef.to, filterObj.none as Record<string, unknown>)})`);
          if (filterObj.is !== undefined)
            relParts.push(`is(${this.fingerprintRelFilter(relDef.to, filterObj.is as Record<string, unknown>)})`);
          if (filterObj.isNot !== undefined)
            relParts.push(`isNot(${this.fingerprintRelFilter(relDef.to, filterObj.isNot as Record<string, unknown>)})`);
          parts.push(`${key}:{${relParts.join(',')}}`);
          continue;
        }
      }

      // null → distinct from value
      if (value === null) {
        parts.push(`${key}:null`);
        continue;
      }

      // Operator objects
      if (isWhereOperator(value)) {
        const opKeys = Object.keys(value as object)
          .filter((k) => k !== 'mode')
          .sort();
        const mode = (value as WhereOperator).mode;
        const modeStr = mode === 'insensitive' ? ':i' : '';
        parts.push(`${key}:op(${opKeys.join(',')}${modeStr})`);
        continue;
      }

      // Vector distance filter — metric (operator) and present comparators
      // change the SQL shape, so both go in the fingerprint.
      if (typeof value === 'object' && !Array.isArray(value) && isVectorFilter(value)) {
        const dist = (value as VectorFilter).distance;
        const cmps = Object.keys(VECTOR_DISTANCE_COMPARATORS)
          .filter((c) => (dist as unknown as Record<string, unknown>)[c] !== undefined)
          .sort()
          .join('|');
        parts.push(`${key}:vec(${dist.metric},${cmps})`);
        continue;
      }

      // JSON filter
      if (typeof value === 'object' && !Array.isArray(value) && isJsonFilter(value as JsonFilter)) {
        const jKeys = Object.keys(value as object).sort();
        parts.push(`${key}:json(${jKeys.join(',')})`);
        continue;
      }

      // Array filter
      if (typeof value === 'object' && !Array.isArray(value) && isArrayFilter(value as ArrayFilter)) {
        parts.push(`${key}:arr(${this.fingerprintArrayFilter(value as ArrayFilter)})`);
        continue;
      }

      // Text search filter
      if (typeof value === 'object' && !Array.isArray(value) && isTextSearchFilter(value as TextSearchFilter)) {
        const cfg = (value as TextSearchFilter).config ?? 'english';
        parts.push(`${key}:fts(${cfg})`);
        continue;
      }

      // Plain equality
      parts.push(`${key}:eq`);
    }

    return parts.join('&');
  }

  /**
   * Produce a value-invariant fingerprint for array filters while preserving
   * parameterless boolean operators that change SQL shape.
   */
  private fingerprintArrayFilter(filter: ArrayFilter): string {
    const keys = Object.keys(filter).sort();
    const suffix = filter.isEmpty === undefined ? '' : `:empty=${filter.isEmpty ? 'true' : 'false'}`;
    return `${keys.join(',')}${suffix}`;
  }

  /**
   * Fingerprint a relation filter sub-where for some/every/none.
   */
  private fingerprintRelFilter(_targetTable: string, subWhere: Record<string, unknown>): string {
    const keys = Object.keys(subWhere)
      .filter((k) => subWhere[k] !== undefined)
      .sort();
    if (keys.length === 0) return '';
    const parts: string[] = [];
    for (const key of keys) {
      const value = subWhere[key];
      if (value === undefined) continue;
      if (value === null) {
        parts.push(`${key}:null`);
      } else if (isWhereOperator(value)) {
        const opKeys = Object.keys(value as object)
          .filter((k) => k !== 'mode')
          .sort();
        const mode = (value as WhereOperator).mode;
        const modeStr = mode === 'insensitive' ? ':i' : '';
        parts.push(`${key}:op(${opKeys.join(',')}${modeStr})`);
      } else {
        parts.push(`${key}:eq`);
      }
    }
    return parts.join('&');
  }

  /**
   * Walk a where clause and push ONLY values into `params`, in the EXACT same
   * order that `buildWhereClause` pushes them. Used on cache hit to fill params
   * without rebuilding SQL.
   *
   * @internal Exposed as package-private for testing.
   */
  collectWhereParams(where: Record<string, unknown>, params: unknown[]): void {
    const keys = Object.keys(where);

    for (const key of keys) {
      const value = where[key];
      if (value === undefined) continue;

      if (key === 'OR') {
        const orConditions = value as Record<string, unknown>[];
        if (!Array.isArray(orConditions) || orConditions.length === 0) continue;
        for (const orCond of orConditions) {
          this.collectWhereParams(orCond, params);
        }
        continue;
      }

      if (key === 'AND') {
        const andConditions = value as Record<string, unknown>[];
        if (!Array.isArray(andConditions) || andConditions.length === 0) continue;
        for (const andCond of andConditions) {
          this.collectWhereParams(andCond, params);
        }
        continue;
      }

      if (key === 'NOT') {
        const notCond = value as Record<string, unknown>;
        this.collectWhereParams(notCond, params);
        continue;
      }

      // Relation filters
      const relationDef = this.tableMeta.relations[key];
      if (relationDef && typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const filterObj = value as Record<string, unknown>;
        if (
          'some' in filterObj ||
          'every' in filterObj ||
          'none' in filterObj ||
          'is' in filterObj ||
          'isNot' in filterObj
        ) {
          if (filterObj.some !== undefined)
            this.collectRelFilterParams(relationDef.to, filterObj.some as Record<string, unknown>, params);
          if (filterObj.none !== undefined)
            this.collectRelFilterParams(relationDef.to, filterObj.none as Record<string, unknown>, params);
          if (filterObj.every !== undefined)
            this.collectRelFilterParams(relationDef.to, filterObj.every as Record<string, unknown>, params);
          if (filterObj.is !== undefined)
            this.collectRelFilterParams(relationDef.to, filterObj.is as Record<string, unknown>, params);
          if (filterObj.isNot !== undefined)
            this.collectRelFilterParams(relationDef.to, filterObj.isNot as Record<string, unknown>, params);
          continue;
        }
      }

      // null → no param pushed (IS NULL is parameterless)
      if (value === null) continue;

      const rawColumn = this.toColumn(key);

      // Vector distance filter — mirrors buildVectorFilterClauses push order.
      if (typeof value === 'object' && !Array.isArray(value) && isVectorFilter(value)) {
        // Validate the same way the build path does so the collect path never
        // diverges (it would throw before any param was pushed).
        this.vectorOperator(key, rawColumn, value.distance.metric);
        this.collectVectorFilterParams(key, rawColumn, value, params);
        continue;
      }

      // JSONB filter
      if (typeof value === 'object' && !Array.isArray(value) && isJsonFilter(value)) {
        const colType = this.getColumnPgType(rawColumn);
        if (colType === 'json' || colType === 'jsonb') {
          this.collectJsonFilterParams(value, params);
          continue;
        }
      }

      // Array filter
      if (typeof value === 'object' && !Array.isArray(value) && isArrayFilter(value)) {
        const colType = this.getColumnPgType(rawColumn);
        if (colType.startsWith('_')) {
          this.collectArrayFilterParams(value, params);
          continue;
        }
      }

      // Text search filter
      if (typeof value === 'object' && !Array.isArray(value) && isTextSearchFilter(value)) {
        params.push(value.search);
        continue;
      }

      // Operator objects
      if (isWhereOperator(value)) {
        this.collectOperatorParams(value, params);
        continue;
      }

      // Plain equality
      params.push(value);
    }
  }

  /** Collect params from a relation filter sub-where. Mirrors buildSubWhereForRelation. */
  private collectRelFilterParams(targetTable: string, subWhere: Record<string, unknown>, params: unknown[]): void {
    const meta = this.schema.tables[targetTable];
    if (!meta) return;

    for (const [_field, value] of Object.entries(subWhere)) {
      if (value === undefined) continue;
      if (value === null) continue;
      if (isWhereOperator(value)) {
        this.collectOperatorParams(value, params);
        continue;
      }
      params.push(value);
    }
  }

  /** Collect params from operator clauses. Mirrors buildOperatorClauses. */
  private collectOperatorParams(op: WhereOperator, params: unknown[]): void {
    if (op.gt !== undefined) params.push(op.gt);
    if (op.gte !== undefined) params.push(op.gte);
    if (op.lt !== undefined) params.push(op.lt);
    if (op.lte !== undefined) params.push(op.lte);
    if (op.not !== undefined && op.not !== null) params.push(op.not);
    if (op.in !== undefined) params.push(op.in);
    if (op.notIn !== undefined) params.push(op.notIn);
    if (op.contains !== undefined) params.push(`%${escapeLike(op.contains)}%`);
    if (op.startsWith !== undefined) params.push(`${escapeLike(op.startsWith)}%`);
    if (op.endsWith !== undefined) params.push(`%${escapeLike(op.endsWith)}`);
  }

  /** Collect params from JSON filter. Mirrors buildJsonFilterClauses. */
  private collectJsonFilterParams(filter: JsonFilter, params: unknown[]): void {
    if (filter.path !== undefined && filter.equals !== undefined) {
      params.push(filter.path);
      params.push(String(filter.equals));
    } else if (filter.equals !== undefined) {
      params.push(JSON.stringify(filter.equals));
    }
    if (filter.contains !== undefined) {
      params.push(JSON.stringify(filter.contains));
    }
    if (filter.hasKey !== undefined) {
      params.push(filter.hasKey);
    }
  }

  /** Collect params from array filter. Mirrors buildArrayFilterClauses. */
  private collectArrayFilterParams(filter: ArrayFilter, params: unknown[]): void {
    if (filter.has !== undefined) params.push(filter.has);
    if (filter.hasEvery !== undefined) params.push(filter.hasEvery);
    if (filter.hasSome !== undefined) params.push(filter.hasSome);
    // isEmpty has no params (IS NULL / IS NOT NULL)
  }

  /**
   * Collect params for an orderBy clause. Only vector KNN ordering pushes a
   * param (the `$n::vector` query vector); plain direction ordering is
   * parameterless. Mirrors buildOrderBy's push order exactly so the cached-SQL
   * param re-collection stays in lockstep.
   */
  private collectOrderByParams(orderBy: OrderByClause, params: unknown[]): void {
    for (const [key, dir] of Object.entries(orderBy)) {
      if (isVectorOrderBy(dir)) {
        const rawColumn = this.toColumn(key);
        // Re-run the same validation as buildOrderBy so the collect path can
        // never push a param that the build path rejected (or vice versa).
        this.vectorOperator(key, rawColumn, dir.distance.metric);
        this.pushVectorParam(key, rawColumn, dir.distance.to, params);
      }
    }
  }

  /**
   * Collect params for a vector distance WHERE filter. Mirrors
   * {@link buildVectorFilterClauses}: the `$n::vector` query vector first, then
   * the comparison threshold(s).
   */
  private collectVectorFilterParams(field: string, rawColumn: string, filter: VectorFilter, params: unknown[]): void {
    const dist = filter.distance;
    this.pushVectorParam(field, rawColumn, dist.to, params);
    for (const cmp of Object.keys(VECTOR_DISTANCE_COMPARATORS)) {
      const threshold = (dist as unknown as Record<string, unknown>)[cmp];
      if (threshold !== undefined) params.push(threshold);
    }
  }

  /**
   * Produce a fingerprint for a `with` clause tree. Recursion mirrors
   * buildSelectWithRelations / buildRelationSubquery.
   *
   * @internal Exposed as package-private for testing.
   */
  withFingerprint(withClause: WithClause | undefined, table?: string, depth = 0): string {
    if (!withClause) return '';
    const meta = this.schema.tables[table ?? this.table];
    if (!meta) return '';

    const relNames = Object.keys(withClause).sort();
    const parts: string[] = [];

    for (const relName of relNames) {
      const spec = withClause[relName];
      if (!spec) continue;
      const relDef = meta.relations[relName];
      if (!relDef) {
        parts.push(`unknown:${relName}`);
        continue;
      }

      if (spec === true) {
        parts.push(relName);
        continue;
      }

      const opts = spec as WithOptions;
      const subParts: string[] = [];

      // select/omit shape
      if (opts.select) {
        const selKeys = Object.entries(opts.select)
          .filter(([, v]) => v)
          .map(([k]) => k)
          .sort();
        subParts.push(`sl=${selKeys.join(',')}`);
      }
      if (opts.omit) {
        const omKeys = Object.entries(opts.omit)
          .filter(([, v]) => v)
          .map(([k]) => k)
          .sort();
        subParts.push(`om=${omKeys.join(',')}`);
      }

      // where shape (value-invariant)
      if (opts.where) {
        // Use a target-table QI if possible, or a simplified fingerprint
        const wKeys = Object.keys(opts.where)
          .filter((k) => opts.where![k] !== undefined)
          .sort();
        subParts.push(`w=${wKeys.join(',')}`);
      }

      // orderBy shape
      if (opts.orderBy) {
        const oEntries = Object.entries(opts.orderBy).map(([k, d]) => `${k}:${d}`);
        subParts.push(`o=${oEntries.join(',')}`);
      }

      // limit presence
      if (opts.limit !== undefined) {
        subParts.push('l=1');
      }

      // nested with (recurse)
      if (opts.with) {
        const nested = this.withFingerprint(opts.with as WithClause, relDef.to, depth + 1);
        if (nested) subParts.push(`W=(${nested})`);
      }

      parts.push(subParts.length > 0 ? `${relName}/{${subParts.join('/')}}` : relName);
    }

    return parts.join('|');
  }

  /**
   * Collect params from a `with` clause tree. Mirrors buildSelectWithRelations +
   * buildRelationSubquery param-push order.
   */
  private collectWithParams(withClause: WithClause, params: unknown[], table?: string): void {
    const meta = this.schema.tables[table ?? this.table];
    if (!meta) return;

    for (const [relName, relSpec] of Object.entries(withClause)) {
      const relDef = meta.relations[relName];
      if (!relDef) continue;
      this.collectRelationSubqueryParams(relDef, relSpec, params, table ?? this.table);
    }
  }

  /**
   * Collect params from a single relation subquery. Mirrors buildRelationSubquery.
   */
  private collectRelationSubqueryParams(
    relDef: RelationDef,
    spec: true | WithOptions,
    params: unknown[],
    _parentRef: string,
    depth = 0,
  ): void {
    if (spec === true) return; // No params for default include
    const targetTable = relDef.to;
    const targetMeta = this.schema.tables[targetTable];
    if (!targetMeta) return;

    // manyToMany param order mirrors buildManyToManySubquery:
    //   where params → limit param → nested-with params (always, both paths).
    if (relDef.type === 'manyToMany') {
      if (spec.where) {
        for (const [, v] of Object.entries(spec.where)) {
          params.push(v);
        }
      }
      if (spec.limit) {
        params.push(Number(spec.limit));
      }
      if (spec.with) {
        for (const [nestedRelName, nestedSpec] of Object.entries(spec.with)) {
          const nestedRelDef = targetMeta.relations[nestedRelName];
          if (!nestedRelDef) continue;
          this.collectRelationSubqueryParams(nestedRelDef, nestedSpec, params, 'alias', depth + 1);
        }
      }
      return;
    }

    const willWrap = relDef.type === 'hasMany' && (spec.limit !== undefined || spec.orderBy !== undefined);

    // Non-wrapped path: nested relations BEFORE where/limit
    if (!willWrap && spec.with) {
      for (const [nestedRelName, nestedSpec] of Object.entries(spec.with)) {
        const nestedRelDef = targetMeta.relations[nestedRelName];
        if (!nestedRelDef) continue;
        this.collectRelationSubqueryParams(nestedRelDef, nestedSpec, params, 'alias', depth + 1);
      }
    }

    // where params
    if (spec.where) {
      for (const [, v] of Object.entries(spec.where)) {
        params.push(v);
      }
    }

    // limit param
    if (spec.limit) {
      params.push(Number(spec.limit));
    }

    // Wrapped path: nested relations AFTER where/limit (inside inner subquery)
    if (willWrap && spec.with) {
      for (const [nestedRelName, nestedSpec] of Object.entries(spec.with)) {
        const nestedRelDef = targetMeta.relations[nestedRelName];
        if (!nestedRelDef) continue;
        this.collectRelationSubqueryParams(nestedRelDef, nestedSpec, params, 'innerAlias', depth + 1);
      }
    }
  }

  /**
   * Fingerprint SET clauses for update/updateMany.
   * Captures key names + operator types (set/increment/etc) but not values.
   */
  private fingerprintSet(data: Record<string, unknown>): string {
    const entries = Object.entries(data).filter(([, v]) => v !== undefined);
    const parts: string[] = [];
    for (const [k, v] of entries) {
      if (
        v !== null &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        !(v instanceof Date) &&
        !(typeof Buffer !== 'undefined' && Buffer.isBuffer(v))
      ) {
        const keys = Object.keys(v as Record<string, unknown>);
        if (keys.length === 1 && UPDATE_OPERATOR_KEYS.has(keys[0]!)) {
          parts.push(`${k}:${keys[0]}`);
          continue;
        }
      }
      parts.push(`${k}:eq`);
    }
    return parts.join(',');
  }

  /**
   * Collect SET params for update/updateMany. Mirrors buildSetClause param order.
   */
  private collectSetParams(data: Record<string, unknown>, params: unknown[]): void {
    const entries = Object.entries(data).filter(([, v]) => v !== undefined);
    for (const [, v] of entries) {
      if (
        v !== null &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        !(v instanceof Date) &&
        !(typeof Buffer !== 'undefined' && Buffer.isBuffer(v))
      ) {
        const obj = v as Record<string, unknown>;
        const keys = Object.keys(obj);
        if (keys.length === 1 && UPDATE_OPERATOR_KEYS.has(keys[0]!)) {
          params.push(obj[keys[0]!]);
          continue;
        }
      }
      params.push(v);
    }
  }

  /** Build WHERE clause from a where object (supports operators, NULL, OR) */
  private buildWhere(where: WhereClause<T>): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    const clause = this.buildWhereClause(where as Record<string, unknown>, params);
    if (!clause) return { sql: '', params: [] };
    return { sql: ` WHERE ${clause}`, params };
  }

  /**
   * Refuse mutations with an empty predicate unless explicitly opted in.
   *
   * An empty `where` (e.g. `{}` or `{ id: undefined }`) resolves to a
   * mutation with no filter — a common footgun when a caller's filter
   * value accidentally resolves to `undefined`. This guard throws
   * `ValidationError` in that case unless `allowFullTableScan: true`.
   */
  private assertMutationHasPredicate(
    operation: 'update' | 'updateMany' | 'delete' | 'deleteMany',
    whereSql: string,
    allowFullTableScan: boolean | undefined,
  ): void {
    if (whereSql.length > 0) return;
    if (allowFullTableScan === true) return;
    throw new ValidationError(
      `[turbine] ${operation} on "${this.table}" refused: the \`where\` clause is empty. ` +
        `Pass \`allowFullTableScan: true\` to opt in, or check that your filter values are defined.`,
    );
  }

  /**
   * Build the inner WHERE expression (without the WHERE keyword).
   * Returns null if no conditions exist.
   * Supports: equality, operators, NULL, OR, AND, NOT, relation filters (some/every/none).
   */
  private buildWhereClause(where: Record<string, unknown>, params: unknown[]): string | null {
    const keys = Object.keys(where);
    if (keys.length === 0) return null;

    const andClauses: string[] = [];

    for (const key of keys) {
      const value = where[key];
      if (value === undefined) continue;

      // Handle OR special key
      if (key === 'OR') {
        const orConditions = value as Record<string, unknown>[];
        if (!Array.isArray(orConditions) || orConditions.length === 0) continue;
        const orClauses: string[] = [];
        for (const orCond of orConditions) {
          const sub = this.buildWhereClause(orCond, params);
          if (sub) orClauses.push(sub);
        }
        if (orClauses.length > 0) {
          andClauses.push(`(${orClauses.join(' OR ')})`);
        }
        continue;
      }

      // Handle AND special key
      if (key === 'AND') {
        const andConditions = value as Record<string, unknown>[];
        if (!Array.isArray(andConditions) || andConditions.length === 0) continue;
        for (const andCond of andConditions) {
          const sub = this.buildWhereClause(andCond, params);
          if (sub) andClauses.push(sub);
        }
        continue;
      }

      // Handle NOT special key
      if (key === 'NOT') {
        const notCond = value as Record<string, unknown>;
        const sub = this.buildWhereClause(notCond, params);
        if (sub) andClauses.push(`NOT (${sub})`);
        continue;
      }

      // Handle relation filters: { posts: { some: { published: true } } }
      const relationDef = this.tableMeta.relations[key];
      if (relationDef && typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const filterObj = value as Record<string, unknown>;
        // Check if this is a relation filter (has some/every/none keys)
        if (
          'some' in filterObj ||
          'every' in filterObj ||
          'none' in filterObj ||
          'is' in filterObj ||
          'isNot' in filterObj
        ) {
          const relClause = this.buildRelationFilter(key, relationDef, filterObj, params);
          if (relClause) andClauses.push(relClause);
          continue;
        }
      }

      const rawColumn = this.toColumn(key);
      const column = this.q(rawColumn);

      // Handle null → IS NULL
      if (value === null) {
        andClauses.push(`${column} IS NULL`);
        continue;
      }

      // Handle vector distance filter (pgvector): `{ distance: { to, metric, lt } }`
      if (typeof value === 'object' && !Array.isArray(value) && isVectorFilter(value)) {
        const vecClauses = this.buildVectorFilterClauses(key, rawColumn, value, params);
        andClauses.push(...vecClauses);
        continue;
      }

      // Handle JSONB filter operators (for json/jsonb columns)
      if (typeof value === 'object' && !Array.isArray(value) && isJsonFilter(value)) {
        const colType = this.getColumnPgType(rawColumn);
        if (colType === 'json' || colType === 'jsonb') {
          const jsonClauses = this.buildJsonFilterClauses(column, value, params);
          andClauses.push(...jsonClauses);
          continue;
        }
        // Strict validation: a JSON-only operator on a non-JSON column was almost
        // certainly a typo or schema mismatch. Silently falling through to plain
        // equality (the previous behaviour) wasted hours of debugging time. Only
        // throw when the operator is unambiguously JSON-specific — `contains` is
        // shared with WhereOperator's LIKE so it must continue to fall through.
        const jsonKey = findJsonUniqueKey(value);
        if (jsonKey) {
          throw new ValidationError(
            `[turbine] Column "${rawColumn}" on table "${this.table}" is not a JSON column ` +
              `(actual type: ${colType}); cannot apply JSON operator '${jsonKey}'.`,
          );
        }
      }

      // Handle Array filter operators (for array columns)
      if (typeof value === 'object' && !Array.isArray(value) && isArrayFilter(value)) {
        const colType = this.getColumnPgType(rawColumn);
        if (colType.startsWith('_')) {
          const arrayClauses = this.buildArrayFilterClauses(column, value, params, colType);
          andClauses.push(...arrayClauses);
          continue;
        }
        // Strict validation: array operators (`has`, `hasEvery`, ...) on a
        // non-array column always indicate a mistake. None of these keys
        // overlap with other filter shapes so we can throw unconditionally.
        const arrayKey = findArrayUniqueKey(value);
        if (arrayKey) {
          throw new ValidationError(
            `[turbine] Column "${rawColumn}" on table "${this.table}" is not an array column ` +
              `(actual type: ${colType}); cannot apply array operator '${arrayKey}'.`,
          );
        }
      }

      // Handle full-text search filter
      if (typeof value === 'object' && !Array.isArray(value) && isTextSearchFilter(value)) {
        const tsClause = this.buildTextSearchClause(column, value, params);
        andClauses.push(tsClause);
        continue;
      }

      // Handle operator objects
      if (isWhereOperator(value)) {
        const opClauses = this.buildOperatorClauses(column, value, params);
        andClauses.push(...opClauses);
        continue;
      }

      // Strict validation: a plain (non-array, non-Date) object on a non-JSON
      // column matched no known filter shape — almost always a misspelled
      // operator (`startWith` for `startsWith`) or a stray nested object.
      // Silently treating it as `col = $1` returns wrong rows with no error, so
      // throw with the offending keys and the supported operator list. JSON/JSONB
      // columns legitimately accept object values for equality, so they fall
      // through unchanged.
      if (typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
        const colType = this.getColumnPgType(rawColumn);
        if (colType !== 'json' && colType !== 'jsonb') {
          const badKeys = Object.keys(value as Record<string, unknown>);
          throw new ValidationError(
            badKeys.length === 0
              ? `[turbine] Empty filter object on "${rawColumn}" for table "${this.table}". ` +
                  `Provide a value or an operator like { gt: 1 }.`
              : `[turbine] Unknown operator${badKeys.length > 1 ? 's' : ''} ` +
                  `${badKeys.map((k) => `"${k}"`).join(', ')} on "${rawColumn}" for table "${this.table}". ` +
                  `Supported operators: ${[...OPERATOR_KEYS].join(', ')}.`,
          );
        }
      }

      // Plain equality
      params.push(value);
      andClauses.push(`${column} = ${this.p(params.length)}`);
    }

    if (andClauses.length === 0) return null;
    return andClauses.join(' AND ');
  }

  /**
   * Build relation filter SQL: WHERE EXISTS / NOT EXISTS subquery
   * Supports: some (EXISTS), every (NOT EXISTS ... NOT), none (NOT EXISTS)
   */
  private buildRelationFilter(
    _relName: string,
    relDef: RelationDef,
    filterObj: Record<string, unknown>,
    params: unknown[],
  ): string | null {
    const targetTable = relDef.to;
    const targetMeta = this.schema.tables[targetTable];
    if (!targetMeta) return null;

    const qt = this.q(targetTable);
    const qSelf = this.q(this.table);
    const clauses: string[] = [];

    // Correlation: link child table to parent table (supports composite FKs)
    let correlation: string;
    if (relDef.type === 'hasMany' || relDef.type === 'hasOne') {
      // parent.pk = child.fk
      correlation = this.dialect.buildCorrelation(qt, relDef.foreignKey, qSelf, relDef.referenceKey);
    } else {
      // belongsTo: parent.fk = child.pk
      correlation = this.dialect.buildCorrelation(qt, relDef.referenceKey, qSelf, relDef.foreignKey);
    }

    // "some": EXISTS (SELECT 1 FROM target WHERE correlation AND filter)
    if (filterObj.some !== undefined) {
      const subWhere = filterObj.some as Record<string, unknown>;
      const filterClause = this.buildSubWhereForRelation(targetTable, subWhere, params);
      const fullWhere = filterClause ? `${correlation} AND ${filterClause}` : correlation;
      clauses.push(`EXISTS (SELECT 1 FROM ${qt} WHERE ${fullWhere})`);
    }

    // "none": NOT EXISTS (SELECT 1 FROM target WHERE correlation AND filter)
    if (filterObj.none !== undefined) {
      const subWhere = filterObj.none as Record<string, unknown>;
      const filterClause = this.buildSubWhereForRelation(targetTable, subWhere, params);
      const fullWhere = filterClause ? `${correlation} AND ${filterClause}` : correlation;
      clauses.push(`NOT EXISTS (SELECT 1 FROM ${qt} WHERE ${fullWhere})`);
    }

    // "every": NOT EXISTS (SELECT 1 FROM target WHERE correlation AND NOT (filter))
    if (filterObj.every !== undefined) {
      const subWhere = filterObj.every as Record<string, unknown>;
      const filterClause = this.buildSubWhereForRelation(targetTable, subWhere, params);
      if (filterClause) {
        clauses.push(`NOT EXISTS (SELECT 1 FROM ${qt} WHERE ${correlation} AND NOT (${filterClause}))`);
      } else {
        // "every" with empty filter = true (all match trivially)
      }
    }

    // "is": EXISTS — for to-one relations (same SQL as "some")
    if (filterObj.is !== undefined) {
      const subWhere = filterObj.is as Record<string, unknown>;
      const filterClause = this.buildSubWhereForRelation(targetTable, subWhere, params);
      const fullWhere = filterClause ? `${correlation} AND ${filterClause}` : correlation;
      clauses.push(`EXISTS (SELECT 1 FROM ${qt} WHERE ${fullWhere})`);
    }

    // "isNot": NOT EXISTS — for to-one relations (same SQL as "none")
    if (filterObj.isNot !== undefined) {
      const subWhere = filterObj.isNot as Record<string, unknown>;
      const filterClause = this.buildSubWhereForRelation(targetTable, subWhere, params);
      const fullWhere = filterClause ? `${correlation} AND ${filterClause}` : correlation;
      clauses.push(`NOT EXISTS (SELECT 1 FROM ${qt} WHERE ${fullWhere})`);
    }

    return clauses.length > 0 ? clauses.join(' AND ') : null;
  }

  /**
   * Build WHERE clause conditions for a relation filter subquery.
   * Uses the target table's column mapping to resolve field names.
   */
  private buildSubWhereForRelation(
    targetTable: string,
    subWhere: Record<string, unknown>,
    params: unknown[],
  ): string | null {
    const meta = this.schema.tables[targetTable];
    if (!meta) return null;

    const qt = this.q(targetTable);
    const conditions: string[] = [];

    for (const [field, value] of Object.entries(subWhere)) {
      if (value === undefined) continue;

      const col = meta.columnMap[field] ?? camelToSnake(field);
      if (!meta.allColumns.includes(col)) {
        throw new ValidationError(
          `[turbine] Unknown field "${field}" in relation filter for table "${targetTable}". ` +
            `Known fields: ${Object.keys(meta.columnMap).join(', ') || '(none)'}.`,
        );
      }
      const qCol = `${qt}.${this.q(col)}`;

      if (value === null) {
        conditions.push(`${qCol} IS NULL`);
        continue;
      }

      if (isWhereOperator(value)) {
        const opClauses = this.buildOperatorClauses(qCol, value, params);
        conditions.push(...opClauses);
        continue;
      }

      params.push(value);
      conditions.push(`${qCol} = ${this.p(params.length)}`);
    }

    return conditions.length > 0 ? conditions.join(' AND ') : null;
  }

  /**
   * Build SQL clauses for a single operator object on a column.
   * Each operator key becomes its own clause, all ANDed together.
   */
  private buildOperatorClauses(column: string, op: WhereOperator, params: unknown[]): string[] {
    const clauses: string[] = [];

    if (op.gt !== undefined) {
      params.push(op.gt);
      clauses.push(`${column} > ${this.p(params.length)}`);
    }
    if (op.gte !== undefined) {
      params.push(op.gte);
      clauses.push(`${column} >= ${this.p(params.length)}`);
    }
    if (op.lt !== undefined) {
      params.push(op.lt);
      clauses.push(`${column} < ${this.p(params.length)}`);
    }
    if (op.lte !== undefined) {
      params.push(op.lte);
      clauses.push(`${column} <= ${this.p(params.length)}`);
    }
    if (op.not !== undefined) {
      if (op.not === null) {
        clauses.push(`${column} IS NOT NULL`);
      } else {
        params.push(op.not);
        clauses.push(`${column} != ${this.p(params.length)}`);
      }
    }
    if (op.in !== undefined) {
      params.push(op.in);
      clauses.push(`${column} = ANY(${this.p(params.length)})`);
    }
    if (op.notIn !== undefined) {
      params.push(op.notIn);
      clauses.push(`${column} != ALL(${this.p(params.length)})`);
    }
    const buildLikeClause = (paramRef: string) =>
      op.mode === 'insensitive' ? this.dialect.buildInsensitiveLike(column, paramRef) : `${column} LIKE ${paramRef}`;

    if (op.contains !== undefined) {
      params.push(`%${escapeLike(op.contains)}%`);
      clauses.push(`${buildLikeClause(this.p(params.length))} ESCAPE '\\'`);
    }
    if (op.startsWith !== undefined) {
      params.push(`${escapeLike(op.startsWith)}%`);
      clauses.push(`${buildLikeClause(this.p(params.length))} ESCAPE '\\'`);
    }
    if (op.endsWith !== undefined) {
      params.push(`%${escapeLike(op.endsWith)}`);
      clauses.push(`${buildLikeClause(this.p(params.length))} ESCAPE '\\'`);
    }

    return clauses;
  }

  /**
   * Build ORDER BY clause from an object.
   *
   * Each value is either a plain direction (`'asc'`/`'desc'`) or — for pgvector
   * columns — a `{ distance: { to, metric, direction? } }` KNN ordering object.
   * Vector ordering binds the query vector as a `$n::vector` param, so a `params`
   * array MUST be supplied when a vector ordering may be present (top-level
   * findMany path). When `params` is omitted (groupBy / relation path) a vector
   * ordering throws — KNN ordering is only supported at the top level.
   */
  private buildOrderBy(orderBy: OrderByClause, params?: unknown[]): string {
    // Dev-only: validate that orderBy fields exist in the table schema
    if (process.env.NODE_ENV !== 'production') {
      for (const key of Object.keys(orderBy)) {
        const snakeKey = camelToSnake(key);
        if (!this.tableMeta.columns.some((c) => c.name === snakeKey) && !(key in this.tableMeta.columnMap)) {
          console.warn(
            `[turbine] Unknown orderBy field "${key}" for table "${this.tableMeta.name}". ` +
              'This will cause a runtime error.',
          );
        }
      }
    }

    const meta = this.schema.tables[this.table];
    return Object.entries(orderBy)
      .map(([key, dir]) => {
        if (meta && !(key in meta.columnMap)) {
          throw new ValidationError(
            `[turbine] Unknown field "${key}" in orderBy on table "${this.table}". ` +
              `Known fields: ${Object.keys(meta.columnMap).join(', ') || '(none)'}.`,
          );
        }

        // Vector KNN ordering: { distance: { to, metric, direction? } }
        if (isVectorOrderBy(dir)) {
          if (!params) {
            throw new ValidationError(
              `[turbine] Vector distance ordering on "${key}" is only supported in a top-level findMany orderBy.`,
            );
          }
          const rawColumn = this.toColumn(key);
          const operator = this.vectorOperator(key, rawColumn, dir.distance.metric);
          const placeholder = this.pushVectorParam(key, rawColumn, dir.distance.to, params);
          const safeDir = dir.distance.direction?.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
          return `${this.q(rawColumn)} ${operator} ${placeholder} ${safeDir}`;
        }

        const safeDir = (dir as OrderDirection).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
        return `${this.toSqlColumn(key)} ${safeDir}`;
      })
      .join(', ');
  }

  // -------------------------------------------------------------------------
  // pgvector helpers (similarity search)
  // -------------------------------------------------------------------------

  /**
   * Resolve a {@link VectorMetric} to its pgvector distance operator from a
   * fixed allow-list, validating the target column is actually a `vector`
   * column. Throws {@link ValidationError} for an unknown metric or a
   * non-vector column — a user-supplied string can never become a SQL operator.
   */
  private vectorOperator(field: string, rawColumn: string, metric: string): string {
    const colType = this.getColumnPgType(rawColumn);
    if (colType !== 'vector') {
      throw new ValidationError(
        `[turbine] Column "${field}" on table "${this.table}" is not a vector column ` +
          `(actual type: ${colType}); cannot apply a vector distance operation.`,
      );
    }
    const op = VECTOR_METRIC_OPERATORS[metric];
    if (!op) {
      throw new ValidationError(
        `[turbine] Unknown vector metric "${metric}" for column "${field}". ` +
          `Valid metrics: ${Object.keys(VECTOR_METRIC_OPERATORS).join(', ')}.`,
      );
    }
    return op;
  }

  /**
   * Validate and bind a query vector as a single `$n::vector` parameter.
   * Every element must be a finite number (no NaN / Infinity / strings) so a
   * malformed array can never produce a broken `::vector` literal, and the array
   * is NEVER string-interpolated into the SQL text. Returns the `$n::vector`
   * placeholder string.
   */
  private pushVectorParam(field: string, _rawColumn: string, to: unknown, params: unknown[]): string {
    if (!Array.isArray(to) || to.length === 0) {
      throw new ValidationError(
        `[turbine] Vector distance on "${field}" requires a non-empty array of numbers for "to".`,
      );
    }
    for (const el of to) {
      if (typeof el !== 'number' || !Number.isFinite(el)) {
        throw new ValidationError(
          `[turbine] Vector "to" for column "${field}" must contain only finite numbers; ` +
            `got ${JSON.stringify(el)}.`,
        );
      }
    }
    // Bind as a pgvector text literal '[1,2,3]'. Elements are already validated
    // as finite numbers, so the joined string is safe; it is still passed as a
    // bound param (never interpolated) and cast with ::vector.
    params.push(`[${(to as number[]).join(',')}]`);
    return `${this.p(params.length)}::vector`;
  }

  /** Parse a flat row: convert snake_case to camelCase + Date coercion */
  /**
   * Returns the set of camelCase field names for a table's date columns,
   * derived once from `meta.dateColumns` (snake_case) via reverseColumnMap and
   * memoized per table. Used so nested relation rows (camelCase keys) coerce
   * dates the same way top-level rows do.
   */
  private getCamelDateFields(table: string, meta: TableMetadata): Set<string> {
    let camel = this.camelDateFieldCache.get(table);
    if (!camel) {
      camel = new Set<string>();
      for (const col of meta.dateColumns) {
        camel.add(meta.reverseColumnMap[col] ?? col);
      }
      this.camelDateFieldCache.set(table, camel);
    }
    return camel;
  }

  private parseRow(row: Record<string, unknown>, table: string): Record<string, unknown> {
    const parsed: Record<string, unknown> = {};
    const meta = this.schema.tables[table];

    if (meta) {
      // Fast path: use pre-computed maps (avoids regex per column per row)
      const reverseMap = meta.reverseColumnMap;
      const dateCols = meta.dateColumns;
      // camelCase-keyed date fields, so nested json_build_object rows (whose
      // keys are already camelCase) get the same Date coercion as top-level rows.
      const camelDateFields = this.getCamelDateFields(table, meta);

      const keys = Object.keys(row);
      for (let i = 0; i < keys.length; i++) {
        const col = keys[i]!;
        const value = row[col];
        const field = reverseMap[col] ?? col; // fall back to raw col name, not regex
        // Top-level rows are snake_case (dateCols); nested rows are camelCase (camelDateFields).
        if ((dateCols.has(col) || camelDateFields.has(field)) && value !== null && !(value instanceof Date)) {
          parsed[field] = new Date(value as string);
        } else {
          parsed[field] = value;
        }
      }
    } else {
      // Fallback: no metadata, use regex conversion
      for (const [col, value] of Object.entries(row)) {
        parsed[snakeToCamel(col)] = value;
      }
    }
    return parsed;
  }

  /** Parse a row that may contain JSON nested relation columns */
  private parseNestedRow(row: Record<string, unknown>, table: string): Record<string, unknown> {
    const parsed = this.parseRow(row, table);
    const meta = this.schema.tables[table];
    if (!meta) return parsed;

    for (const [relName, relDef] of Object.entries(meta.relations)) {
      const rawValue = row[relName];
      if (rawValue === undefined) continue;

      // --- Short-circuit: skip JSON.parse for common empty/null cases ---
      // hasMany returns '[]' (from COALESCE(..., '[]'::json)); belongsTo/hasOne returns null
      if (rawValue === null || rawValue === 'null') {
        parsed[relName] = null;
        continue;
      }
      if (rawValue === '[]') {
        parsed[relName] = [];
        continue;
      }
      if (Array.isArray(rawValue) && rawValue.length === 0) {
        parsed[relName] = [];
        continue;
      }

      // --- Non-empty values: full parse path ---
      if (typeof rawValue === 'string') {
        try {
          const jsonVal = JSON.parse(rawValue);
          // After parsing, recurse via parseNestedRow so each item gets date
          // coercion AND its own sub-relations parsed at arbitrary depth.
          if (Array.isArray(jsonVal)) {
            parsed[relName] = jsonVal.map((item: unknown) =>
              typeof item === 'object' && item !== null
                ? this.parseNestedRow(item as Record<string, unknown>, relDef.to)
                : item,
            );
          } else if (typeof jsonVal === 'object' && jsonVal !== null) {
            parsed[relName] = this.parseNestedRow(jsonVal as Record<string, unknown>, relDef.to);
          } else {
            parsed[relName] = jsonVal;
          }
        } catch {
          console.warn(
            `[turbine] Warning: Failed to parse JSON for relation "${relName}" on table "${this.table}". Using raw value.`,
          );
          parsed[relName] = rawValue;
        }
      } else if (Array.isArray(rawValue)) {
        parsed[relName] = rawValue.map((item) =>
          typeof item === 'object' && item !== null
            ? this.parseNestedRow(item as Record<string, unknown>, relDef.to)
            : item,
        );
      } else if (typeof rawValue === 'object' && rawValue !== null) {
        parsed[relName] = this.parseNestedRow(rawValue as Record<string, unknown>, relDef.to);
      } else {
        parsed[relName] = rawValue;
      }
    }

    return parsed;
  }

  /**
   * Build a SELECT clause that includes both base columns and nested relation subqueries.
   *
   * For each relation specified in the `with` clause, this method generates a correlated
   * subquery using PostgreSQL's `json_agg(json_build_object(...))` pattern. The result
   * is a single SQL SELECT clause that resolves the full object tree in one query --
   * no N+1 problem.
   *
   * **How it works:**
   * 1. Resolves the base columns for the root table (all columns, or a subset via `columnsList`).
   * 2. Iterates over each key in the `with` clause, looking up the relation definition.
   * 3. For each relation, delegates to {@link buildRelationSubquery} to generate a
   *    correlated subquery that returns JSON (array for hasMany, object for belongsTo/hasOne).
   * 4. Each subquery is aliased as the relation name in the final SELECT.
   *
   * **aliasCounter:** A shared `{ n: number }` object is passed through all nesting levels.
   * Each call to `buildRelationSubquery` increments it to produce unique table aliases
   * (`t0`, `t1`, `t2`, ...) across arbitrarily deep relation trees, preventing alias
   * collisions in the generated SQL.
   *
   * **Example output:**
   * ```sql
   * "users"."id", "users"."name", "users"."email",
   * (SELECT COALESCE(json_agg(json_build_object('id', t0."id", 'title', t0."title")), '[]'::json)
   *   FROM "posts" t0 WHERE t0."user_id" = "users"."id") AS "posts"
   * ```
   *
   * @param table - The root table name (e.g. `"users"`).
   * @param withClause - An object mapping relation names to their include specs
   *                     (`true` for default inclusion, or `WithOptions` for select/omit/where/orderBy/limit).
   * @param params - Shared parameter array for parameterized values (`$1`, `$2`, ...).
   *                 Nested where/limit values are pushed here to prevent SQL injection.
   * @param columnsList - Optional subset of columns to include in the SELECT. When `null`
   *                      or omitted, all columns from the table's schema metadata are used.
   * @param depth - Current nesting depth, passed through to {@link buildRelationSubquery}
   *                for circular-relation detection. Defaults to `0` at the top level.
   * @param path - Breadcrumb trail of relation names traversed so far, used in error
   *               messages when circular or too-deep nesting is detected.
   * @returns A complete SELECT clause string (without the `SELECT` keyword) containing
   *          base columns and relation subqueries.
   */
  private buildSelectWithRelations(
    table: string,
    withClause: WithClause,
    params: unknown[],
    columnsList?: string[] | null,
    depth?: number,
    path?: string[],
  ): string {
    const meta = this.schema.tables[table];
    if (!meta) throw new ValidationError(`[turbine] Unknown table "${table}"`);

    const cols = columnsList ?? meta.allColumns;
    const qtbl = this.q(table);
    const baseCols = cols.map((col) => `${qtbl}.${this.q(col)}`).join(', ');

    const relationSelects: string[] = [];
    const aliasCounter = { n: 0 };

    for (const [relName, relSpec] of Object.entries(withClause)) {
      const relDef = meta.relations[relName];
      if (!relDef) {
        throw new RelationError(
          `[turbine] Unknown relation "${relName}" on table "${table}". ` +
            `Available: ${Object.keys(meta.relations).join(', ')}`,
        );
      }

      // The main table is not aliased, so pass table name as parentRef
      const subquery = this.buildRelationSubquery(relDef, relSpec, params, table, aliasCounter, depth, path);
      relationSelects.push(`(${subquery}) AS ${this.q(relName)}`);
    }

    return [baseCols, ...relationSelects].join(', ');
  }

  /**
   * Generate a correlated subquery that returns JSON for a single relation.
   *
   * This is the core of Turbine's single-query nested relation strategy. For a given
   * relation (e.g. `posts` on a `users` query), it produces a self-contained SQL subquery
   * that PostgreSQL evaluates per parent row, returning either a JSON array (hasMany) or
   * a single JSON object (belongsTo / hasOne).
   *
   * ### Algorithm overview
   *
   * 1. **Alias generation:** Allocates a unique alias (`t0`, `t1`, ...) from the shared
   *    `aliasCounter` so that deeply nested subqueries never collide.
   *
   * 2. **Column resolution:** Honors `select` / `omit` options to control which columns
   *    appear in the output JSON.
   *
   * 3. **`json_build_object`:** Builds a JSON object for each row by mapping camelCase
   *    field names to their column values:
   *    ```sql
   *    json_build_object('id', t0."id", 'title', t0."title", 'createdAt', t0."created_at")
   *    ```
   *
   * 4. **`json_agg` wrapping (hasMany):** For one-to-many relations, wraps the
   *    `json_build_object` call in `json_agg(...)` to aggregate all matching child rows
   *    into a JSON array. Uses `COALESCE(..., '[]'::json)` so the result is never NULL.
   *    For belongsTo / hasOne, no aggregation is used -- just the single JSON object
   *    with `LIMIT 1`.
   *
   * 5. **Correlation (WHERE clause):** Links the subquery to the parent row:
   *    - **hasMany:** `alias.foreignKey = parentRef.referenceKey`
   *      (e.g. `t0."user_id" = "users"."id"` -- child FK points to parent PK)
   *    - **belongsTo / hasOne:** `alias.referenceKey = parentRef.foreignKey`
   *      (e.g. `t0."id" = "posts"."author_id"` -- parent FK points to child PK)
   *
   * 6. **Recursion:** If the spec includes a nested `with` clause, this method calls
   *    itself recursively for each nested relation, passing the current alias as
   *    `parentRef`. The nested subquery appears as an additional key in the
   *    `json_build_object` call, wrapped in `COALESCE(..., '[]'::json)`.
   *    Depth is incremented and capped at 10 to guard against circular relations.
   *
   * 7. **LIMIT / ORDER BY wrapping:** For hasMany relations with `limit` or `orderBy`,
   *    the query is restructured into a two-level form:
   *    ```sql
   *    SELECT COALESCE(json_agg(json_build_object(...)), '[]'::json)
   *    FROM (
   *      SELECT t0.* FROM "posts" t0
   *      WHERE t0."user_id" = "users"."id"
   *      ORDER BY t0."created_at" DESC
   *      LIMIT $1
   *    ) t0i
   *    ```
   *    This ensures LIMIT and ORDER BY apply to the raw rows *before* `json_agg`
   *    aggregation. Without the inner subquery, LIMIT would be meaningless because
   *    `json_agg` produces a single aggregated row.
   *
   * 8. **Parameter threading:** All user-supplied values (where filters, limit) are
   *    pushed to the shared `params` array with `$N` placeholders. No string
   *    interpolation of user data ever occurs -- all identifiers go through
   *    `this.q()` and all values are parameterized.
   *
   * ### Example output (hasMany with nested relation)
   * ```sql
   * SELECT COALESCE(json_agg(json_build_object(
   *   'id', t0."id",
   *   'title', t0."title",
   *   'comments', COALESCE((
   *     SELECT COALESCE(json_agg(json_build_object('id', t1."id", 'body', t1."body")), '[]'::json)
   *     FROM "comments" t1 WHERE t1."post_id" = t0."id"
   *   ), '[]'::json)
   * )), '[]'::json) FROM "posts" t0 WHERE t0."user_id" = "users"."id"
   * ```
   *
   * @param relDef - The relation definition from schema metadata (contains `to`, `type`,
   *                 `foreignKey`, `referenceKey`).
   * @param spec - Either `true` (include with defaults) or a `WithOptions` object that
   *               can specify `select`, `omit`, `where`, `orderBy`, `limit`, and nested `with`.
   * @param params - Shared parameter array. User-supplied values are pushed here and
   *                 referenced as `$1`, `$2`, etc. in the generated SQL.
   * @param parentRef - The alias (e.g. `"t0"`) or table name (e.g. `"users"`) of the
   *                    parent query. Used to build the correlated WHERE clause that ties
   *                    child rows to their parent row.
   * @param aliasCounter - Shared mutable counter (`{ n: number }`) for generating unique
   *                       table aliases (`t0`, `t1`, `t2`, ...) across all nesting levels.
   *                       Each call increments `n` by 1.
   * @param depth - Current nesting depth (starts at `0`). Incremented on each recursive
   *                call. If it reaches 10, a {@link CircularRelationError} is thrown.
   * @param path - Breadcrumb trail of relation/table names traversed so far
   *               (e.g. `["users", "posts", "comments"]`). Used in the error message
   *               when circular or too-deep nesting is detected.
   * @returns A complete SQL subquery string (without surrounding parentheses) that
   *          evaluates to a JSON array (hasMany) or a JSON object (belongsTo/hasOne).
   */
  private buildRelationSubquery(
    relDef: RelationDef,
    spec: true | WithOptions,
    params: unknown[],
    parentRef: string,
    aliasCounter: { n: number },
    depth?: number,
    path?: string[],
  ): string {
    const currentDepth = depth ?? 0;
    const currentPath = path ?? [this.table];

    const targetTable = relDef.to;

    // Hard depth cap — the `with` clause is a finite JSON structure so users can't
    // create true infinite recursion, but extremely deep nesting (10+ levels) produces
    // unmanageably large SQL. Back-references (e.g. posts → user → posts) are allowed
    // since they are legitimate queries (Prisma supports the same pattern).
    if (currentDepth >= 10) {
      throw new CircularRelationError([...currentPath, targetTable]);
    }
    const targetMeta = this.schema.tables[targetTable];
    if (!targetMeta) throw new RelationError(`[turbine] Unknown relation target "${targetTable}"`);

    // Generate a unique alias: t0, t1, t2, ...
    const alias = `t${aliasCounter.n++}`;

    // Resolve which columns to include based on select/omit
    let targetColumns = targetMeta.allColumns;
    if (spec !== true && spec.select) {
      const selectedFields = Object.entries(spec.select)
        .filter(([, v]) => v)
        .map(([k]) => targetMeta.columnMap[k] ?? camelToSnake(k));
      targetColumns = selectedFields.filter((col) => targetMeta.allColumns.includes(col));
    } else if (spec !== true && spec.omit) {
      const omittedFields = new Set(
        Object.entries(spec.omit)
          .filter(([, v]) => v)
          .map(([k]) => targetMeta.columnMap[k] ?? camelToSnake(k)),
      );
      targetColumns = targetMeta.allColumns.filter((col) => !omittedFields.has(col));
    }

    // Build JSON object pairs for resolved columns
    const jsonPairs: [key: string, expr: string][] = targetColumns.map((col) => [
      targetMeta.reverseColumnMap[col] ?? snakeToCamel(col),
      `${alias}.${this.q(col)}`,
    ]);

    // Determine if this hasMany will take the wrapped subquery path (LIMIT or ORDER BY).
    // When wrapping, nested relations are built in the wrapped path referencing innerAlias,
    // so we must NOT build them here (they would push orphaned params).
    const willWrap =
      relDef.type === 'hasMany' && spec !== true && (spec.limit !== undefined || spec.orderBy !== undefined);

    // manyToMany takes a dedicated JOIN-through-junction path. Nested relations,
    // where, orderBy, and select/omit are handled there (the target alias is the
    // row source, exactly like hasMany), so short-circuit before the hasMany logic.
    if (relDef.type === 'manyToMany') {
      return this.buildManyToManySubquery(
        relDef,
        spec,
        params,
        parentRef,
        aliasCounter,
        currentDepth,
        currentPath,
        alias,
        targetMeta,
        targetColumns,
      );
    }

    // Nested relations — only in the non-wrapped path (wrapped path builds them separately)
    if (!willWrap && spec !== true && spec.with) {
      for (const [nestedRelName, nestedSpec] of Object.entries(spec.with)) {
        const nestedRelDef = targetMeta.relations[nestedRelName];
        if (!nestedRelDef) {
          throw new RelationError(
            `[turbine] Unknown relation "${nestedRelName}" on table "${targetTable}". ` +
              `Available: ${Object.keys(targetMeta.relations).join(', ')}`,
          );
        }
        // Recursively build nested subquery, passing THIS alias as the parent reference
        const nestedSubquery = this.buildRelationSubquery(
          nestedRelDef,
          nestedSpec,
          params,
          alias,
          aliasCounter,
          currentDepth + 1,
          [...currentPath, relDef.name],
        );
        // Use '[]'::json for hasMany (empty array), NULL for belongsTo/hasOne (no object)
        const fallback =
          nestedRelDef.type === 'hasMany' ? this.dialect.emptyJsonArrayLiteral : this.dialect.nullJsonLiteral;
        jsonPairs.push([nestedRelName, `COALESCE((${nestedSubquery}), ${fallback})`]);
      }
    }

    const jsonObj = this.dialect.buildJsonObject(jsonPairs);

    // Quote parent ref — can be a table name or auto-generated alias
    const qParent = this.q(parentRef);
    const qTarget = this.q(targetTable);

    // Build ORDER BY for json_agg
    let orderClause = '';
    if (spec !== true && spec.orderBy) {
      const orders = Object.entries(spec.orderBy)
        .map(([k, dir]) => {
          const col = camelToSnake(k);
          if (!targetMeta.allColumns.includes(col)) {
            throw new ValidationError(`[turbine] Unknown column "${k}" in orderBy for table "${targetTable}"`);
          }
          const safeDir = dir.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
          return `${alias}.${this.q(col)} ${safeDir}`;
        })
        .join(', ');
      orderClause = ` ORDER BY ${orders}`;
    }

    // Build WHERE — correlate to parent via parentRef (alias or table name).
    // For hasMany: target has FK, so alias.fk = parentRef.pk
    // For belongsTo: source has FK, so alias.pk = parentRef.fk (reversed)
    // Supports composite foreign keys (string[]) via buildCorrelation.
    let whereClause: string;
    if (relDef.type === 'belongsTo' || relDef.type === 'hasOne') {
      whereClause = this.dialect.buildCorrelation(alias, relDef.referenceKey, qParent, relDef.foreignKey);
    } else {
      whereClause = this.dialect.buildCorrelation(alias, relDef.foreignKey, qParent, relDef.referenceKey);
    }

    // Additional filters — properly parameterized
    if (spec !== true && spec.where) {
      for (const [k, v] of Object.entries(spec.where)) {
        const col = camelToSnake(k);
        if (!targetMeta.allColumns.includes(col)) {
          throw new ValidationError(`[turbine] Unknown column "${k}" in where for table "${targetTable}"`);
        }
        params.push(v);
        whereClause += ` AND ${alias}.${this.q(col)} = ${this.p(params.length)}`;
      }
    }

    // LIMIT
    let limitClause = '';
    if (spec !== true && spec.limit) {
      params.push(Number(spec.limit));
      limitClause = ` LIMIT ${this.p(params.length)}`;
    }

    if (relDef.type === 'hasMany') {
      // When LIMIT or ORDER BY is used, wrap in a subquery so LIMIT applies to rows
      // BEFORE json_agg aggregation (otherwise LIMIT on aggregated result is meaningless)
      if (limitClause || orderClause) {
        const innerAlias = `${alias}i`;
        // Rewrite: SELECT json_agg(json_build_object(...)) FROM (SELECT * FROM table WHERE ... ORDER BY ... LIMIT N) AS alias
        // Inner SELECT always needs all columns for WHERE/ORDER to work; json_build_object filters later
        const innerSql = `SELECT ${targetMeta.allColumns.map((c) => `${alias}.${this.q(c)}`).join(', ')} FROM ${qTarget} ${alias} WHERE ${whereClause}${orderClause}${limitClause}`;
        // For the json_build_object, reference the inner alias — only include resolved columns
        const innerJsonPairs: [key: string, expr: string][] = targetColumns.map((col) => [
          targetMeta.reverseColumnMap[col] ?? snakeToCamel(col),
          `${innerAlias}.${this.q(col)}`,
        ]);
        // Build nested relation subqueries referencing innerAlias
        if (spec !== true && spec.with) {
          for (const [nestedRelName, nestedSpec] of Object.entries(spec.with)) {
            const nestedRelDef = targetMeta.relations[nestedRelName];
            if (!nestedRelDef) {
              throw new RelationError(
                `[turbine] Unknown relation "${nestedRelName}" on table "${targetTable}". ` +
                  `Available: ${Object.keys(targetMeta.relations).join(', ')}`,
              );
            }
            const nestedSub = this.buildRelationSubquery(
              nestedRelDef,
              nestedSpec,
              params,
              innerAlias,
              aliasCounter,
              currentDepth + 1,
              [...currentPath, relDef.name],
            );
            const fallback =
              nestedRelDef.type === 'hasMany' ? this.dialect.emptyJsonArrayLiteral : this.dialect.nullJsonLiteral;
            innerJsonPairs.push([nestedRelName, `COALESCE((${nestedSub}), ${fallback})`]);
          }
        }
        const innerJsonObj = this.dialect.buildJsonObject(innerJsonPairs);
        return `SELECT ${this.dialect.buildJsonArrayAgg(innerJsonObj)} FROM (${innerSql}) ${innerAlias}`;
      }
      return `SELECT ${this.dialect.buildJsonArrayAgg(jsonObj, orderClause.trim() || undefined)} FROM ${qTarget} ${alias} WHERE ${whereClause}`;
    }

    // belongsTo / hasOne — return single object
    return `SELECT ${jsonObj} FROM ${qTarget} ${alias} WHERE ${whereClause} LIMIT 1`;
  }

  /**
   * Build the json_agg subquery for a `manyToMany` relation, JOINing the target
   * table through a junction (join) table.
   *
   * Shape (no LIMIT/ORDER):
   * ```sql
   * SELECT COALESCE(json_agg(json_build_object(...)), '[]'::json)
   * FROM <target> <talias>
   * JOIN <junction> <jalias> ON <jalias>.<targetKey> = <talias>.<targetPK>
   * WHERE <jalias>.<sourceKey> = <parentRef>.<referenceKey>
   * ```
   *
   * With LIMIT/ORDER, the rows are wrapped in an inner subquery so the LIMIT
   * applies BEFORE aggregation (identical strategy to hasMany).
   *
   * Cardinality is always 'many' → empty-array fallback, never NULL.
   *
   * IMPORTANT: every `params.push` here MUST be mirrored, in the same order, in
   * {@link collectRelationSubqueryParams} or pipeline batching will desync.
   */
  private buildManyToManySubquery(
    relDef: RelationDef,
    spec: true | WithOptions,
    params: unknown[],
    parentRef: string,
    aliasCounter: { n: number },
    currentDepth: number,
    currentPath: string[],
    talias: string,
    targetMeta: TableMetadata,
    targetColumns: string[],
  ): string {
    if (!relDef.through) {
      throw new ValidationError(
        `[turbine] manyToMany relation "${relDef.name}" is missing a \`through\` junction descriptor.`,
      );
    }

    const targetTable = relDef.to;
    const qTarget = this.q(targetTable);
    const qJunction = this.q(relDef.through.table);
    const qParent = this.q(parentRef);
    const jalias = `${talias}j`; // junction alias, distinct from the target alias

    // JOIN: junction.targetKey = target.<targetPK>. Composite keys pair positionally.
    const targetKeys = normalizeKeyColumns(relDef.through.targetKey);
    // The target PK is the column(s) the junction's targetKey references. An empty
    // introspected PK means we cannot know what to JOIN on — fail loudly rather than
    // silently guessing `id` and generating a wrong JOIN.
    if (targetMeta.primaryKey.length === 0) {
      throw new ValidationError(
        `[turbine] manyToMany relation "${relDef.name}" targets table "${targetTable}" which has no primary key; ` +
          `cannot determine the join column. Define a primary key or use an explicit through descriptor.`,
      );
    }
    const targetPk = targetMeta.primaryKey;
    if (targetKeys.length !== targetPk.length) {
      throw new ValidationError(
        `[turbine] manyToMany relation "${relDef.name}": through.targetKey has ${targetKeys.length} column(s) ` +
          `but target "${targetTable}" primary key has ${targetPk.length}. Composite keys must pair positionally.`,
      );
    }
    const joinOn = targetKeys
      .map((jcol, i) => `${jalias}.${this.q(jcol)} = ${talias}.${this.q(targetPk[i]!)}`)
      .join(' AND ');

    // Correlation: junction.sourceKey = parent.<referenceKey>.
    const sourceKeys = normalizeKeyColumns(relDef.through.sourceKey);
    const refKeys = normalizeKeyColumns(relDef.referenceKey);
    if (sourceKeys.length !== refKeys.length) {
      throw new ValidationError(
        `[turbine] manyToMany relation "${relDef.name}": through.sourceKey has ${sourceKeys.length} column(s) ` +
          `but referenceKey has ${refKeys.length}. Composite keys must pair positionally.`,
      );
    }
    let whereClause = sourceKeys
      .map((jcol, i) => `${jalias}.${this.q(jcol)} = ${qParent}.${this.q(refKeys[i]!)}`)
      .join(' AND ');

    // ORDER BY on the target rows
    let orderClause = '';
    if (spec !== true && spec.orderBy) {
      const orders = Object.entries(spec.orderBy)
        .map(([k, dir]) => {
          const col = camelToSnake(k);
          if (!targetMeta.allColumns.includes(col)) {
            throw new ValidationError(`[turbine] Unknown column "${k}" in orderBy for table "${targetTable}"`);
          }
          const safeDir = dir.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
          return `${talias}.${this.q(col)} ${safeDir}`;
        })
        .join(', ');
      orderClause = ` ORDER BY ${orders}`;
    }

    // Additional WHERE filters on the target — properly parameterized.
    if (spec !== true && spec.where) {
      for (const [k, v] of Object.entries(spec.where)) {
        const col = camelToSnake(k);
        if (!targetMeta.allColumns.includes(col)) {
          throw new ValidationError(`[turbine] Unknown column "${k}" in where for table "${targetTable}"`);
        }
        params.push(v);
        whereClause += ` AND ${talias}.${this.q(col)} = ${this.p(params.length)}`;
      }
    }

    // LIMIT
    let limitClause = '';
    if (spec !== true && spec.limit) {
      params.push(Number(spec.limit));
      limitClause = ` LIMIT ${this.p(params.length)}`;
    }

    const fromJoin = `FROM ${qTarget} ${talias} JOIN ${qJunction} ${jalias} ON ${joinOn}`;

    // When LIMIT or ORDER BY is present, wrap the joined rows in an inner subquery
    // so the LIMIT applies to rows BEFORE aggregation (same approach as hasMany).
    if (limitClause || orderClause) {
      const innerAlias = `${talias}i`;
      const innerSql =
        `SELECT ${targetMeta.allColumns.map((c) => `${talias}.${this.q(c)}`).join(', ')} ` +
        `${fromJoin} WHERE ${whereClause}${orderClause}${limitClause}`;
      const innerJsonPairs: [key: string, expr: string][] = targetColumns.map((col) => [
        targetMeta.reverseColumnMap[col] ?? snakeToCamel(col),
        `${innerAlias}.${this.q(col)}`,
      ]);
      // Nested relations reference the inner alias.
      if (spec !== true && spec.with) {
        for (const [nestedRelName, nestedSpec] of Object.entries(spec.with)) {
          const nestedRelDef = targetMeta.relations[nestedRelName];
          if (!nestedRelDef) {
            throw new RelationError(
              `[turbine] Unknown relation "${nestedRelName}" on table "${targetTable}". ` +
                `Available: ${Object.keys(targetMeta.relations).join(', ')}`,
            );
          }
          const nestedSub = this.buildRelationSubquery(
            nestedRelDef,
            nestedSpec,
            params,
            innerAlias,
            aliasCounter,
            currentDepth + 1,
            [...currentPath, relDef.name],
          );
          const fallback =
            nestedRelDef.type === 'belongsTo' || nestedRelDef.type === 'hasOne'
              ? this.dialect.nullJsonLiteral
              : this.dialect.emptyJsonArrayLiteral;
          innerJsonPairs.push([nestedRelName, `COALESCE((${nestedSub}), ${fallback})`]);
        }
      }
      const innerJsonObj = this.dialect.buildJsonObject(innerJsonPairs);
      return `SELECT ${this.dialect.buildJsonArrayAgg(innerJsonObj)} FROM (${innerSql}) ${innerAlias}`;
    }

    // Simple path: build the json object pairs directly off the target alias,
    // including any nested relations (correlated to the target alias).
    const jsonPairs: [key: string, expr: string][] = targetColumns.map((col) => [
      targetMeta.reverseColumnMap[col] ?? snakeToCamel(col),
      `${talias}.${this.q(col)}`,
    ]);
    if (spec !== true && spec.with) {
      for (const [nestedRelName, nestedSpec] of Object.entries(spec.with)) {
        const nestedRelDef = targetMeta.relations[nestedRelName];
        if (!nestedRelDef) {
          throw new RelationError(
            `[turbine] Unknown relation "${nestedRelName}" on table "${targetTable}". ` +
              `Available: ${Object.keys(targetMeta.relations).join(', ')}`,
          );
        }
        const nestedSub = this.buildRelationSubquery(
          nestedRelDef,
          nestedSpec,
          params,
          talias,
          aliasCounter,
          currentDepth + 1,
          [...currentPath, relDef.name],
        );
        const fallback =
          nestedRelDef.type === 'belongsTo' || nestedRelDef.type === 'hasOne'
            ? this.dialect.nullJsonLiteral
            : this.dialect.emptyJsonArrayLiteral;
        jsonPairs.push([nestedRelName, `COALESCE((${nestedSub}), ${fallback})`]);
      }
    }
    const jsonObj = this.dialect.buildJsonObject(jsonPairs);
    return `SELECT ${this.dialect.buildJsonArrayAgg(jsonObj)} ${fromJoin} WHERE ${whereClause}`;
  }

  /**
   * Get the Postgres type for a column (e.g. 'jsonb', 'text', '_int4').
   * Used to detect JSONB/array columns for specialized operators.
   * Uses pre-computed Map for O(1) lookup instead of linear scan.
   */
  private getColumnPgType(column: string): string {
    return this.columnPgTypeMap.get(column) ?? 'text';
  }

  /**
   * Get the Postgres base element type for an array column.
   * E.g. '_text' → 'text', '_int4' → 'integer'
   */
  private getArrayElementType(pgType: string): string {
    const baseType = pgType.startsWith('_') ? pgType.slice(1) : pgType;
    const typeMap: Record<string, string> = {
      int2: 'smallint',
      int4: 'integer',
      int8: 'bigint',
      float4: 'real',
      float8: 'double precision',
      bool: 'boolean',
      text: 'text',
      varchar: 'text',
      uuid: 'uuid',
      timestamptz: 'timestamptz',
      timestamp: 'timestamp',
      jsonb: 'jsonb',
      json: 'json',
    };
    return typeMap[baseType] ?? 'text';
  }

  /**
   * Build SQL clauses for JSONB filter operators on a column.
   * Supports: path, equals, contains, hasKey.
   */
  private buildJsonFilterClauses(column: string, filter: JsonFilter, params: unknown[]): string[] {
    const clauses: string[] = [];

    if (filter.path !== undefined && filter.equals !== undefined) {
      // Path access + equals: column #>> $N::text[] = $M
      params.push(filter.path);
      const pathParam = params.length;
      params.push(String(filter.equals));
      clauses.push(`${this.dialect.buildJsonPathExtract(column, this.p(pathParam))} = ${this.p(params.length)}`);
    } else if (filter.equals !== undefined) {
      // Containment equality: column @> $N::jsonb
      params.push(JSON.stringify(filter.equals));
      clauses.push(this.dialect.buildJsonContains(column, this.p(params.length)));
    }

    if (filter.contains !== undefined) {
      // Containment: column @> $N::jsonb
      params.push(JSON.stringify(filter.contains));
      clauses.push(this.dialect.buildJsonContains(column, this.p(params.length)));
    }

    if (filter.hasKey !== undefined) {
      // Key existence: column ? $N
      params.push(filter.hasKey);
      clauses.push(`${column} ? ${this.p(params.length)}`);
    }

    return clauses;
  }

  /**
   * Build SQL clauses for Array filter operators on a column.
   * Supports: has, hasEvery, hasSome, isEmpty.
   */
  private buildArrayFilterClauses(column: string, filter: ArrayFilter, params: unknown[], pgType: string): string[] {
    const clauses: string[] = [];
    const elementType = this.getArrayElementType(pgType);

    if (filter.has !== undefined) {
      // value = ANY(column)
      params.push(filter.has);
      clauses.push(`${this.p(params.length)} = ANY(${column})`);
    }

    if (filter.hasEvery !== undefined) {
      // column @> ARRAY[...]::type[]
      params.push(filter.hasEvery);
      clauses.push(`${column} @> ${this.p(params.length)}::${elementType}[]`);
    }

    if (filter.hasSome !== undefined) {
      // column && ARRAY[...]::type[]
      params.push(filter.hasSome);
      clauses.push(`${column} && ${this.p(params.length)}::${elementType}[]`);
    }

    if (filter.isEmpty === true) {
      // Treat NULL and empty arrays as empty for Prisma-compatible ergonomics.
      clauses.push(`COALESCE(cardinality(${column}), 0) = 0`);
    } else if (filter.isEmpty === false) {
      // Require at least one element; excludes both NULL and ARRAY[] values.
      clauses.push(`cardinality(${column}) > 0`);
    }

    return clauses;
  }

  /**
   * Build SQL clauses for a pgvector distance WHERE filter:
   *
   *   `"embedding" <-> $1::vector < $2`
   *
   * The query vector is bound as a `$n::vector` param (never interpolated), the
   * metric maps to an operator via a fixed allow-list, and each comparison
   * threshold (`lt`/`lte`/`gt`/`gte`) is its own bound param. Emits one clause
   * per supplied comparator (all ANDed). Param push order matches
   * {@link collectVectorFilterParams}.
   */
  private buildVectorFilterClauses(
    field: string,
    rawColumn: string,
    filter: VectorFilter,
    params: unknown[],
  ): string[] {
    const dist = filter.distance;
    const operator = this.vectorOperator(field, rawColumn, dist.metric);
    const placeholder = this.pushVectorParam(field, rawColumn, dist.to, params);
    const distanceExpr = `${this.q(rawColumn)} ${operator} ${placeholder}`;

    const clauses: string[] = [];
    for (const [cmp, sqlOp] of Object.entries(VECTOR_DISTANCE_COMPARATORS)) {
      const threshold = (dist as unknown as Record<string, unknown>)[cmp];
      if (threshold === undefined) continue;
      if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
        throw new ValidationError(
          `[turbine] Vector distance threshold "${cmp}" on "${field}" must be a finite number; ` +
            `got ${JSON.stringify(threshold)}.`,
        );
      }
      params.push(threshold);
      clauses.push(`${distanceExpr} ${sqlOp} ${this.p(params.length)}`);
    }

    if (clauses.length === 0) {
      throw new ValidationError(
        `[turbine] Vector distance filter on "${field}" requires at least one comparison (lt / lte / gt / gte).`,
      );
    }
    return clauses;
  }

  /**
   * Build SQL clause for full-text search using to_tsvector @@ to_tsquery.
   * The config name is validated to prevent injection (only alphanumeric + underscore).
   */
  private buildTextSearchClause(column: string, filter: TextSearchFilter, params: unknown[]): string {
    const config = filter.config ?? 'english';
    if (!validateTextSearchConfig(config)) {
      throw new ValidationError(
        `[turbine] Invalid text search config "${config}": only alphanumeric characters and underscores are allowed.`,
      );
    }
    params.push(filter.search);
    return `to_tsvector('${config}', ${column}) @@ to_tsquery('${config}', ${this.p(params.length)})`;
  }

  /**
   * Get the Postgres array type for a column (used by UNNEST in createMany).
   * Uses pre-computed Map for O(1) lookup instead of linear scan.
   */
  private getColumnArrayType(column: string): string {
    const arrayType = this.columnArrayTypeMap.get(column);
    if (arrayType) return arrayType;

    // Fallback heuristic for unknown columns, routed through the active dialect
    // so non-Postgres packages can supply their own bulk-insert cast shape.
    if (column === 'id' || column.endsWith('_id')) return this.dialect.arrayType?.('int8') ?? 'text[]';
    if (column.endsWith('_at')) return this.dialect.arrayType?.('timestamptz') ?? 'text[]';
    return this.dialect.arrayType?.('text') ?? 'text[]';
  }
}
