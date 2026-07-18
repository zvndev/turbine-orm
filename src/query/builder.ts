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
import { NotFoundError, TimeoutError, UnsupportedFeatureError, ValidationError, wrapPgError } from '../errors.js';
import {
  executeNestedCreate,
  executeNestedUpdate,
  hasRelationFields,
  type NestedWriteContext,
} from '../nested-write.js';
import type { RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';
import { camelToSnake, snakeToCamel } from '../schema.js';
import * as aggMod from './aggregates.js';
import {
  type BatchedChildReader,
  includeKeysForBatching,
  loadRelationsBatched,
  neededParentKeyFields,
  type RelationLoadContext,
  rejectNestedPickOrder,
  stripFields,
} from './batched-loader.js';
import {
  isJsonPathOrderBy,
  isOrderBySpec,
  isRelationPickOrderBy,
  isVectorOrderBy,
  isWhereOperator,
  sortedEntries,
} from './filters.js';
import * as relationsMod from './relations.js';
import type {
  AggregateArgs,
  AggregateResult,
  CountArgs,
  CreateArgs,
  CreateManyArgs,
  DeleteArgs,
  DeleteManyArgs,
  FindManyArgs,
  FindManyStreamArgs,
  FindUniqueArgs,
  GlobalFilters,
  GroupByArgs,
  JsonPathOrderBy,
  OrderByClause,
  QueryResult,
  RelationLoadStrategy,
  RelationPickOrderBy,
  SkipGlobalFilters,
  TypedWithClause,
  UpdateArgs,
  UpdateManyArgs,
  UpsertArgs,
  WhereClause,
  WithClause,
} from './types.js';
import { LRUCache, parseDbDate, type SqlCacheEntry, sqlToPreparedName } from './utils.js';
import type { BuilderCtx } from './where.js';
import * as whereMod from './where.js';
import type { WhereHost } from './where-compile.js';
import * as writesMod from './writes.js';

/**
 * SQL-cache lockstep cross-check gate.
 *
 * The SQL template cache requires three code paths to enumerate where-clause
 * keys identically: `fingerprintWhere` (builds the cache key),
 * `buildWhereClause` (builds SQL + `$N` params on a MISS), and
 * `collectWhereParams` (re-collects params on a HIT without rebuilding). Since
 * 0.36 all three consume ONE shared where-key walk (see `where-compile.ts`), so
 * enumeration drift is structurally eliminated; this check remains as a
 * tripwire in case a future leaf builder or its collect mirror falls out of
 * step. It rebuilds the SQL + params fresh on a cache HIT and compares them
 * against what the cache-hit path produced.
 *
 * Modes (decided per HIT; env read inline, not captured once, so tests and
 * perf-sensitive traffic can toggle per process):
 * - `'dev'`: `NODE_ENV !== 'production'` and `TURBINE_DISABLE_CACHE_CHECK !== '1'`
 *   (always checks; the historical default, the whole unit suite runs under it).
 * - `'off'`: dev with `TURBINE_DISABLE_CACHE_CHECK=1`, OR production with no
 *   sampling configured (the hot path is untouched).
 * - `'sampled'`: production with `TURBINE_CACHE_CHECK_SAMPLE` set to a float in
 *   `(0,1]`, re-verify that fraction of cache hits (per-hit `Math.random()`;
 *   `>= 1` checks every hit). A mismatch logs once per distinct fingerprint AND
 *   throws, same as dev. `0`, unset, or an unparseable value means never check.
 */
function cacheCrossCheckMode(): 'dev' | 'sampled' | 'off' {
  if (process.env.NODE_ENV !== 'production') {
    return process.env.TURBINE_DISABLE_CACHE_CHECK === '1' ? 'off' : 'dev';
  }
  const raw = process.env.TURBINE_CACHE_CHECK_SAMPLE;
  if (raw === undefined) return 'off';
  const rate = Number.parseFloat(raw);
  if (!Number.isFinite(rate) || rate <= 0) return 'off';
  if (rate >= 1) return 'sampled';
  return Math.random() < rate ? 'sampled' : 'off';
}

/**
 * Distinct cache-mismatch fingerprints already logged by the sampled production
 * cross-check, so a hot mismatch logs `console.error` exactly once per shape
 * instead of flooding the log. Dev mode does not log (it throws immediately),
 * so this set is only ever touched on the `'sampled'` path.
 */
const loggedCacheMismatchFingerprints = new Set<string>();

/**
 * Strict structural equality for a single SQL parameter value. Handles the
 * value shapes Turbine binds: primitives (incl. `NaN` and `bigint`), `null`/
 * `undefined`, `Date` (by time), `Buffer`/typed arrays (by bytes), arrays
 * (`in` lists, pgvector arrays), and plain objects (JSON filter payloads).
 */
function cacheParamValueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true; // identical ref or equal primitive (covers matching null/undefined)
  if (a === null || b === null || a === undefined || b === undefined) return false;
  const ta = typeof a;
  if (ta !== typeof b) return false;
  if (ta !== 'object') {
    // Primitives that failed `===`: only NaN is legitimately "equal" to itself.
    return typeof a === 'number' && Number.isNaN(a) && Number.isNaN(b as number);
  }
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  const aView = ArrayBuffer.isView(a);
  const bView = ArrayBuffer.isView(b);
  if (aView || bView) {
    if (!aView || !bView) return false;
    const ua = a as Uint8Array;
    const ub = b as Uint8Array;
    if (ua.byteLength !== ub.byteLength) return false;
    const va = new Uint8Array(ua.buffer, ua.byteOffset, ua.byteLength);
    const vb = new Uint8Array(ub.buffer, ub.byteOffset, ub.byteLength);
    for (let i = 0; i < va.length; i++) {
      if (va[i] !== vb[i]) return false;
    }
    return true;
  }
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr || bArr) {
    if (!aArr || !bArr) return false;
    const arrA = a as unknown[];
    const arrB = b as unknown[];
    if (arrA.length !== arrB.length) return false;
    for (let i = 0; i < arrA.length; i++) {
      if (!cacheParamValueEqual(arrA[i], arrB[i])) return false;
    }
    return true;
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!Object.hasOwn(objB, k)) return false;
    if (!cacheParamValueEqual(objA[k], objB[k])) return false;
  }
  return true;
}

/** Element-wise strict equality of two SQL parameter arrays. */
function cacheParamsEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!cacheParamValueEqual(a[i], b[i])) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Deferred query + option types (see deferred.ts)
// ---------------------------------------------------------------------------

export type {
  DeferredQuery,
  MiddlewareFn,
  QueryEvent,
  QueryEventListener,
  QueryInterfaceOptions,
  ReselectExecutor,
} from './deferred.js';

import type { DeferredQuery, MiddlewareFn, QueryInterfaceOptions, ReselectExecutor } from './deferred.js';

// biome-ignore lint/complexity/noBannedTypes: {} means "no relations known" — intentional for untyped table access
export class QueryInterface<T extends object, R extends object = {}> {
  private readonly tableMeta: TableMetadata;
  /** SQL template cache: cacheKey → SqlCacheEntry (sql + prepared statement name) */
  private readonly sqlTemplateCache = new LRUCache<string, SqlCacheEntry>(1000);
  /**
   * Whether the most recent {@link acquireSql} call was a cache HIT. Read by
   * {@link crossCheckCache} to decide whether to run the dev-mode lockstep
   * cross-check. Safe as a single mutable flag: each `build*()` method calls
   * `acquireSql` then `crossCheckCache` synchronously with no intervening
   * `await` and no re-entrant `acquireSql` (relation subqueries are built
   * inline, not through the top-level cache).
   */
  private lastCacheHit = false;
  private readonly middlewares: MiddlewareFn[];
  private readonly defaultLimit?: number;
  private readonly warnOnUnlimited: boolean;
  private readonly utcTimestamps: boolean;
  private readonly preparedStatementsEnabled: boolean;
  /**
   * Whether the SQL template cache is active. Set once in the constructor.
   * Mutable (not `readonly`) only so {@link withSqlCacheDisabled} can flip it
   * off around a single synchronous compile (see {@link explain}).
   */
  private sqlCacheEnabled: boolean;
  private readonly dialect: Dialect;
  /** Client-level default relation-loading strategy ('join' unless configured). */
  private readonly relationLoadStrategy: RelationLoadStrategy;
  /** Nested-relation JSON encoding: 'object' (default) or 'positional'. */
  private readonly jsonEncoding: 'object' | 'positional';
  /**
   * Client-level automatic WHERE filters keyed by table accessor (soft-delete /
   * multi-tenancy). AND-merged into every query on the keyed table and every
   * relation subquery targeting it. Undefined when none are configured, in
   * which case every path is byte-identical to the pre-0.28 behavior.
   */
  private readonly globalFilters?: GlobalFilters;
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
  /**
   * Columns whose type lives in a DIFFERENT schema than the introspected one
   * (ColumnMetadata.pgTypeSchema is recorded only in that case) — such columns
   * must never receive this schema's `::"enum"` cast (see enumTypeForColumn).
   */
  private readonly crossSchemaTypeColumns: Set<string>;

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

  /**
   * The active query's `skipGlobalFilters` opt-out, set at the top of each
   * `build*` method and read deep in the (synchronous) SQL-build + param-collect
   * tree — so relation subqueries, relation filters, `_count`, and relation
   * `orderBy` all see it without threading it through dozens of signatures.
   * Only load-bearing when {@link globalFilters} is configured; build+collect are
   * synchronous per call, so this transient is never observed across an await.
   */
  private currentSkip: SkipGlobalFilters | undefined;

  /**
   * The bound view of this instance passed to the shared WHERE walk
   * (`where-compile.ts`). Built once in the constructor so `fingerprintWhere` /
   * `buildWhereClause` / `collectWhereParams` all drive ONE enumeration + ONE
   * scalar classifier without widening the class's public surface or allocating
   * per call. See {@link WhereHost}.
   */
  private readonly whereHost: WhereHost;

  /**
   * Per-target-table {@link WhereHost} memo for scoped sub-wheres (relation
   * `EXISTS` filters + relation `with`-clause `where`s). Keyed by table name;
   * the host depends only on the target table's metadata, so it is shared across
   * every alias/qualifier for that table. Lazily filled by {@link scopedWhereHost}.
   */
  private readonly scopedHostCache = new Map<string, WhereHost>();

  /**
   * The privacy-preserving view of this instance handed to the extracted WHERE
   * module (`where.ts`). Built once in the constructor (mirroring the
   * `whereHost` precedent) so the free functions there reach exactly the
   * class-resident primitives they need without widening the public surface.
   */
  private readonly ctx: BuilderCtx;

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
    // than the (small) risk of noisy logs. Callers opt out globally with
    // `warnOnUnlimited: false`, per table with `warnOnUnlimited: { users:
    // false }` (unlisted tables keep the default), or per call via
    // `findMany({ warnOnUnlimited: false })`.
    // Per-table maps accept BOTH key forms — the snake_case table name
    // (`user_profiles`) and the camelCase accessor (`userProfiles`) — since
    // users naturally key by the accessor they type everywhere else. The
    // snake_case entry wins when both are present.
    const warnOpt = options?.warnOnUnlimited;
    this.warnOnUnlimited =
      typeof warnOpt === 'object' && warnOpt !== null
        ? (warnOpt[table] ?? warnOpt[snakeToCamel(table)]) !== false
        : warnOpt !== false;
    this.utcTimestamps = options?.utcTimestamps !== false;
    this.preparedStatementsEnabled = options?.preparedStatements ?? true;
    this.sqlCacheEnabled = options?.sqlCache !== false;
    this.dialect = options?.dialect ?? postgresDialect;
    this.relationLoadStrategy = options?.relationLoadStrategy ?? 'join';
    this.jsonEncoding = options?.jsonEncoding ?? 'object';
    // Only retain the map when it has at least one entry, so `globalFilters`
    // stays `undefined` (and every merge path a no-op) for the common case.
    this.globalFilters =
      options?.globalFilters && Object.keys(options.globalFilters).length > 0 ? options.globalFilters : undefined;
    this.txScoped = options?._txScoped ?? false;
    this.options = options;

    // Pre-compute column type lookup maps (TASK-26)
    this.columnPgTypeMap = new Map();
    this.columnArrayTypeMap = new Map();
    this.crossSchemaTypeColumns = new Set();
    for (const col of this.tableMeta.columns) {
      this.columnPgTypeMap.set(col.name, col.dialectType ?? col.pgType);
      this.columnArrayTypeMap.set(col.name, col.arrayType ?? col.pgArrayType);
      if (col.pgTypeSchema !== undefined) this.crossSchemaTypeColumns.add(col.name);
    }

    // Bind the shared WHERE-walk view once. `tableMeta` is immutable after this
    // point; the method wrappers forward to the (private) instance methods so
    // the walk needs no public accessors on the class.
    this.whereHost = {
      tableMeta: this.tableMeta,
      normalizeRelationFilter: (relDef, filterObj) => this.normalizeRelationFilter(relDef, filterObj),
      getColumnPgType: (column) => this.getColumnPgType(column),
      isJsonColumnType: (colType) => this.isJsonColumnType(colType),
    };

    // Bind the privacy-preserving view handed to the extracted WHERE module.
    // Data fields are immutable after this point; `currentSkip` is reassigned
    // per `build*` call, so it is exposed as a LIVE getter (not a copied value).
    const self = this;
    this.ctx = {
      dialect: this.dialect,
      table: this.table,
      schema: this.schema,
      tableMeta: this.tableMeta,
      whereHost: this.whereHost,
      globalFilters: this.globalFilters,
      scopedHostCache: this.scopedHostCache,
      columnPgTypeMap: this.columnPgTypeMap,
      columnArrayTypeMap: this.columnArrayTypeMap,
      crossSchemaTypeColumns: this.crossSchemaTypeColumns,
      get currentSkip(): SkipGlobalFilters | undefined {
        return self.currentSkip;
      },
      set currentSkip(v: SkipGlobalFilters | undefined) {
        self.currentSkip = v;
      },
      q: (name) => this.q(name),
      p: (index) => this.p(index),
      inParam: (values) => this.inParam(values),
      inClause: (expr, paramRef, negated) => this.inClause(expr, paramRef, negated),
      toColumn: (field) => this.toColumn(field),
      castAgg: (expr, target) => this.castAgg(expr, target),
      parseRow: (row, table) => this.parseRow(row, table),
      nullsSuffix: (nulls) => this.nullsSuffix(nulls),
      isRelationOrderByValue: (value) => this.isRelationOrderByValue(value),
      resolveOrderByColumn: (table, meta, key) => this.resolveOrderByColumn(table, meta, key),
      buildJsonPathOrderEntry: (table, meta, field, spec, prefix, params) =>
        this.buildJsonPathOrderEntry(table, meta, field, spec, prefix, params),
      toSqlColumn: (field) => this.toSqlColumn(field),
      mutationInsertId: (result) => this.mutationInsertId(result),
      acquireSql: (cacheKey, build) => this.acquireSql(cacheKey, build),
      crossCheckCache: (op, cacheKey, entry, build, collectedParams) =>
        this.crossCheckCache(op, cacheKey, entry, build, collectedParams),
      jsonEncoding: this.jsonEncoding,
      camelDateFieldCache: this.camelDateFieldCache,
      limitOneClause: () => this.limitOneClause(),
      buildPagination: (limitPh, offsetPh, hasOrderBy) => this.buildPagination(limitPh, offsetPh, hasOrderBy),
      paginationRef: (value, params) => this.paginationRef(value, params),
    };
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
   * Cast an aggregate expression to an integer/float result type through the
   * active dialect. PostgreSQL keeps the historical postfix cast (`expr::int` /
   * `expr::float`); SQLite (no `::` operator) maps to `CAST(expr AS INTEGER/REAL)`.
   * Falls back to the Postgres postfix cast for dialects without the hook.
   */
  private castAgg(expr: string, target: 'int' | 'float'): string {
    return this.dialect.castAggregate?.(expr, target) ?? `${expr}::${target}`;
  }

  /**
   * Build the trailing pagination clause for an OUTER SELECT. PostgreSQL/MySQL/
   * SQLite use ` LIMIT <ph>` and/or ` OFFSET <ph>`. SQL Server has no `LIMIT`, so
   * its dialect implements {@link Dialect.buildLimitOffset} to emit
   * `[ORDER BY (SELECT NULL)] OFFSET <off> ROWS [FETCH NEXT <lim> ROWS ONLY]`.
   * Param-push order (limit before offset) is owned by the caller and unchanged —
   * this only varies the SQL text, so PG output stays byte-identical.
   */
  private buildPagination(limitPh: string | undefined, offsetPh: string | undefined, hasOrderBy: boolean): string {
    if (this.dialect.buildLimitOffset) {
      return this.dialect.buildLimitOffset({ limitPlaceholder: limitPh, offsetPlaceholder: offsetPh, hasOrderBy });
    }
    let s = '';
    if (limitPh !== undefined) s += ` LIMIT ${limitPh}`;
    if (offsetPh !== undefined) s += ` OFFSET ${offsetPh}`;
    return s;
  }

  /**
   * The single-row limit appended to findUnique / findFirst-style lookups. ` LIMIT 1`
   * for PG/MySQL/SQLite; SQL Server routes through {@link Dialect.buildLimitOffset}
   * (literal `1`, no params) → ` ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT 1
   * ROWS ONLY`. No params are pushed, so the collect path is unaffected.
   */
  private limitOneClause(): string {
    if (this.dialect.buildLimitOffset) {
      return this.dialect.buildLimitOffset({ limitPlaceholder: '1', offsetPlaceholder: undefined, hasOrderBy: false });
    }
    return ' LIMIT 1';
  }

  /**
   * Validate a LIMIT/OFFSET value as a non-negative integer and return it as an
   * inline SQL literal. Used only on `dialect.inlineLimitOffset` engines (MySQL).
   * The input is always a Turbine-controlled pagination value, never a raw user
   * string — and this guard guarantees the output is `String` of a validated
   * integer, so inlining cannot inject SQL.
   */
  private limitOffsetLiteral(value: unknown): string {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) {
      throw new ValidationError(`LIMIT/OFFSET must be a non-negative integer, received: ${String(value)}`);
    }
    return String(n);
  }

  /**
   * Resolve a LIMIT/OFFSET value to either an inline literal (no param pushed, on
   * `dialect.inlineLimitOffset` engines) or a bound placeholder (the value is
   * pushed to `params`). Build and collect paths both gate on the same flag so
   * the param order stays mirrored; PG/SQLite/SQL Server keep parameterizing and
   * stay byte-identical.
   */
  private paginationRef(value: unknown, params: unknown[]): string {
    if (this.dialect.inlineLimitOffset) {
      return this.limitOffsetLiteral(value);
    }
    params.push(Number(value));
    return this.p(params.length);
  }

  /**
   * Build an `IN` / `NOT IN` predicate through the active dialect. PostgreSQL
   * keeps the array-param form (`expr = ANY($n)` / `expr != ALL($n)`); other
   * engines (SQLite) use a length-independent single-placeholder form. Paired
   * with {@link inParam}, which supplies the single bound value.
   */
  private inClause(expr: string, paramRef: string, negated: boolean): string {
    if (this.dialect.buildInClause) return this.dialect.buildInClause(expr, paramRef, negated);
    return negated ? `${expr} != ALL(${paramRef})` : `${expr} = ANY(${paramRef})`;
  }

  /** The single bound parameter for an `IN` list (PG: the array; SQLite: a JSON string). */
  private inParam(values: unknown): unknown {
    return this.dialect.inClauseParam ? this.dialect.inClauseParam(values as unknown[]) : values;
  }

  // -------------------------------------------------------------------------
  // Batched relation loading (relationLoadStrategy: 'batched')
  // -------------------------------------------------------------------------

  /**
   * Resolve the effective relation-loading strategy for a query: the per-query
   * arg wins, then the client-level default, then `'join'`. Only meaningful when
   * a `with` clause is present; the callers gate on that.
   */
  private resolveLoadStrategy(argStrategy: RelationLoadStrategy | undefined): RelationLoadStrategy {
    return argStrategy ?? this.relationLoadStrategy;
  }

  /**
   * Build the {@link RelationLoadContext} the batched loader needs, closing over
   * this interface's pool/dialect/executor. Child readers are constructed on the
   * SAME pool (so they join an active transaction) with `defaultLimit` cleared
   * and unlimited-warnings silenced — a relation load must fetch every matching
   * child, and the per-relation `limit` is applied client-side by the loader.
   */
  private batchedContext(
    timeout: number | undefined,
    skip: SkipGlobalFilters | undefined,
    includePii: boolean,
  ): RelationLoadContext {
    const childOptions: QueryInterfaceOptions = {
      ...this.options,
      defaultLimit: undefined,
      warnOnUnlimited: false,
    };
    return {
      parentMeta: this.tableMeta,
      schema: this.schema,
      makeChild: (table: string): BatchedChildReader =>
        new QueryInterface<object>(this.pool, table, this.schema, [], childOptions) as unknown as BatchedChildReader,
      exec: (sql, params, preparedName) => this.queryWithTimeout(sql, params, timeout, preparedName),
      quote: (name) => this.q(name),
      buildInClause: (expr, paramRef, negated) => this.inClause(expr, paramRef, negated),
      inClauseParam: (values) => this.inParam(values),
      paramPlaceholder: (index) => this.p(index),
      skipGlobalFilters: skip,
      // Query-level opt-in threaded onto every follow-up child `buildFindMany`,
      // so a batched load excludes/includes PII exactly as the join strategy.
      includePii,
      tableGlobalFilter: (table, alias, precedingParams) => {
        const gf = this.resolveGlobalFilter(table, skip);
        if (!gf) return null;
        const meta = this.schema.tables[table];
        if (!meta) return null;
        // Seed the param array with `precedingParams` placeholders so
        // buildAliasWhere numbers the gf params after the already-bound ones.
        const seeded: unknown[] = new Array(precedingParams).fill(undefined);
        const clause = this.buildAliasWhere(table, meta, alias, gf, seeded);
        if (!clause) return null;
        return { clause, params: seeded.slice(precedingParams) };
      },
    };
  }

  /**
   * Run a findMany with the batched strategy: execute the base query WITHOUT
   * relation subqueries (all other clauses intact), then load each relation via
   * one flat follow-up query and stitch client-side. Parent stitch keys the
   * caller's `select`/`omit` excluded are added for the base query and stripped
   * from the returned rows, so the shape matches the join strategy exactly.
   */
  private async runFindManyBatched(args: FindManyArgs<T>): Promise<T[]> {
    const withClause = args.with as WithClause;
    // Scope-rule parity with the join strategy (which throws at SQL build):
    // reject nested pick-row ordering BEFORE the base query so acceptance
    // never depends on how many rows come back.
    rejectNestedPickOrder(withClause);
    // Capture the opt-out from the ARGS before any await: this.currentSkip is
    // instance state on a cached accessor, so a concurrent build during the
    // base-query await would overwrite it (tenant query loading relations with
    // another query's skipGlobalFilters).
    const skip = args.skipGlobalFilters;
    const { baseArgs, strip } = this.prepareBatchedBase(args, withClause);
    // baseArgs.with is always undefined here; the cast just bridges the R generic.
    const deferred = this.buildFindMany(baseArgs as Parameters<QueryInterface<T, R>['buildFindMany']>[0]);
    const result = await this.queryWithTimeout(deferred.sql, deferred.params, args.timeout, deferred.preparedName);
    const entities = deferred.transform(result) as Record<string, unknown>[];
    if (entities.length > 0) {
      await loadRelationsBatched(
        this.batchedContext(args.timeout, skip, args.includePii === true),
        entities,
        withClause,
        args.timeout,
      );
    }
    stripFields(entities, strip);
    return entities as T[];
  }

  /**
   * Build the base findMany args for a batched run: drop `with`, and ensure every
   * parent correlation key needed for stitching is projected (returning the list
   * of keys that must be stripped from the output afterwards).
   */
  private prepareBatchedBase(
    args: FindManyArgs<T>,
    withClause: WithClause,
  ): { baseArgs: FindManyArgs<T>; strip: string[] } {
    const needed = neededParentKeyFields(this.tableMeta, withClause);
    const proj = includeKeysForBatching(
      args.select as Record<string, boolean> | undefined,
      args.omit as Record<string, boolean> | undefined,
      needed,
    );
    const baseArgs = {
      ...args,
      with: undefined,
      select: proj.select,
      omit: proj.omit,
    } as unknown as FindManyArgs<T>;
    return { baseArgs, strip: proj.strip };
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
   *
   * `build` receives a fresh `$N` param scratch array. On a miss those params
   * are discarded (the returned params come from each call site's dedicated
   * collect path); the array exists so the build path can number placeholders
   * via `params.length` exactly as it does today. On a HIT, `build` is skipped
   * here but re-run by {@link crossCheckCache} (dev only) with a fresh array to
   * verify the collect path stayed in lockstep with the build path.
   *
   * Sets {@link lastCacheHit} so the caller's `crossCheckCache` knows whether a
   * cross-check is warranted.
   */
  private acquireSql(cacheKey: string, build: (params: unknown[]) => string): SqlCacheEntry {
    if (!this.sqlCacheEnabled) {
      this.lastCacheHit = false;
      const sql = build([]);
      this.cacheMisses++;
      return { sql, name: sqlToPreparedName(sql) };
    }

    const cached = this.sqlTemplateCache.get(cacheKey);
    if (cached) {
      this.cacheHits++;
      this.lastCacheHit = true;
      return cached;
    }

    this.lastCacheHit = false;
    const sql = build([]);
    const entry: SqlCacheEntry = { sql, name: sqlToPreparedName(sql) };
    this.sqlTemplateCache.set(cacheKey, entry);
    this.cacheMisses++;
    return entry;
  }

  /**
   * Dev-mode SQL-cache lockstep cross-check (see {@link cacheCrossCheckEnabled}).
   *
   * Runs only when the most recent {@link acquireSql} was a cache HIT and the
   * check is enabled. Rebuilds the SQL + `$N` params fresh via the same `build`
   * closure the caller passed to `acquireSql`, then compares:
   *   (a) the cached SQL string byte-for-byte against the fresh SQL, and
   *   (b) the params the cache-hit collect path produced against the fresh
   *       build-path params (length and element-wise strict deep-equal).
   *
   * A mismatch means the fingerprint / build / collect paths have drifted out
   * of lockstep (the exact class of bug that has silently corrupted results
   * before), so it throws a {@link ValidationError} (E003) naming the
   * fingerprint, the operation, and both SQL strings (truncated). Failing loud
   * in dev/test is the point. Production never reaches the comparison.
   *
   * @param op human label of the calling build method (for the error message).
   * @param cacheKey the cache fingerprint that HIT.
   * @param entry the cached SQL entry that will be executed.
   * @param build the same closure passed to `acquireSql`; re-run here to
   *   capture the fresh build-path SQL + params.
   * @param collectedParams the params the caller's collect path produced.
   */
  private crossCheckCache(
    op: string,
    cacheKey: string,
    entry: SqlCacheEntry,
    build: (params: unknown[]) => string,
    collectedParams: unknown[],
  ): void {
    if (!this.lastCacheHit) return;
    const mode = cacheCrossCheckMode();
    if (mode === 'off') return;

    const freshParams: unknown[] = [];
    const freshSql = build(freshParams);
    const sqlOk = freshSql === entry.sql;
    const paramsOk = cacheParamsEqual(collectedParams, freshParams);
    if (sqlOk && paramsOk) return;

    const truncate = (s: string): string => (s.length > 300 ? `${s.slice(0, 300)}… (${s.length} chars total)` : s);
    const details: string[] = [];
    if (!sqlOk) {
      details.push(
        `cached SQL and freshly-built SQL diverge:\n  cached = <${truncate(entry.sql)}>\n  fresh  = <${truncate(freshSql)}>`,
      );
    }
    if (!paramsOk) {
      details.push(
        `cache-hit params and freshly-built params diverge (collected ${collectedParams.length}, built ${freshParams.length})`,
      );
    }
    const message =
      `[turbine] SQL cache lockstep violation on ${op} (fingerprint "${cacheKey}"). ` +
      `This is a Turbine internal invariant violation, please report it at ` +
      `https://github.com/zvndev/turbine-orm/issues. The fingerprint, SQL-build, and ` +
      `param-collect paths must enumerate where-clause keys identically.\n${details.join('\n')}`;
    // Sampled production path: log once per distinct fingerprint so the failure
    // is durably recorded in the server log before the throw unwinds the query.
    // (Dev mode throws straight away; its behavior is unchanged.)
    if (mode === 'sampled' && !loggedCacheMismatchFingerprints.has(cacheKey)) {
      loggedCacheMismatchFingerprints.add(cacheKey);
      console.error(message);
    }
    throw new ValidationError(message);
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
   * Execute a write `DeferredQuery` (create/update/delete/upsert) according to
   * the active dialect's {@link Dialect.resultStrategy}, then apply its
   * transform.
   *
   *   - `'returning'` / `'output'`: the statement returns its own affected rows
   *     (`RETURNING *` / `OUTPUT INSERTED.*`). Byte-identical to the historical
   *     single `queryWithTimeout` + `transform(result)` path — the PostgreSQL
   *     route is unchanged.
   *   - `'reselect'`: the engine cannot return rows from a write, so the build
   *     method attached a {@link DeferredQuery.reselect} plan that runs the
   *     write and a follow-up SELECT; the SELECT's rows feed the transform.
   */
  private async executeMutation<V>(deferred: DeferredQuery<V>, timeout?: number): Promise<V> {
    if (this.dialect.resultStrategy === 'reselect' && deferred.reselect) {
      const exec: ReselectExecutor = (sql, params, preparedName) =>
        this.queryWithTimeout(sql, params, timeout, preparedName);
      const result = await deferred.reselect(exec);
      return deferred.transform(result);
    }
    const result = await this.queryWithTimeout(deferred.sql, deferred.params, timeout, deferred.preparedName);
    return deferred.transform(result);
  }

  // ---------------------------------------------------------------------------
  // Write compilation (extracted to writes.ts).
  // ---------------------------------------------------------------------------

  buildCreate(args: CreateArgs<T>): DeferredQuery<T> {
    return writesMod.buildCreate(this.ctx, args);
  }

  buildCreateMany(args: CreateManyArgs<T>): DeferredQuery<T[]> {
    return writesMod.buildCreateMany(this.ctx, args);
  }

  buildUpdate(args: UpdateArgs<T>): DeferredQuery<T> {
    return writesMod.buildUpdate(this.ctx, args);
  }

  buildDelete(args: DeleteArgs<T>): DeferredQuery<T> {
    return writesMod.buildDelete(this.ctx, args);
  }

  buildUpsert(args: UpsertArgs<T>): DeferredQuery<T> {
    return writesMod.buildUpsert(this.ctx, args);
  }

  buildUpdateMany(args: UpdateManyArgs<T>): DeferredQuery<{ count: number }> {
    return writesMod.buildUpdateMany(this.ctx, args);
  }

  buildDeleteMany(args: DeleteManyArgs<T>): DeferredQuery<{ count: number }> {
    return writesMod.buildDeleteMany(this.ctx, args);
  }

  /**
   * Best-effort extraction of an auto-generated primary key from a write
   * result for `'reselect'` engines (e.g. mysql2's `insertId`). Returns
   * `undefined` when the driver exposes no such field.
   */
  private mutationInsertId(result: pg.QueryResult): unknown {
    const r = result as unknown as { insertId?: unknown; lastID?: unknown };
    return r.insertId ?? r.lastID;
  }

  /**
   * Execute a query through the middleware chain.
   * If no middlewares are registered, executes directly.
   *
   * Middleware can inspect and log query parameters, measure timing, and
   * transform the result returned by `next()`. Note: query SQL is generated
   * BEFORE middleware runs — `params.args` is a read-only snapshot, and
   * mutating it does NOT change the executed SQL. Cross-cutting filters
   * (e.g. soft deletes) belong in the query itself: pass an explicit
   * `where: { deletedAt: null }` or wrap the table accessor in a small helper.
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
      if (args.with && this.resolveLoadStrategy(args.relationLoadStrategy) === 'batched') {
        return this.runFindUniqueBatched(args as unknown as FindUniqueArgs<T>);
      }
      const deferred = this.buildFindUnique(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args.timeout, deferred.preparedName);
      return deferred.transform(result);
    }) as Promise<QueryResult<T, R, W, S, O> | null>;
  }

  /**
   * Batched-strategy findUnique: fetch the single base row without relation
   * subqueries (adding any parent stitch keys the projection excluded), then load
   * its relations via one follow-up query each and stitch. Mirrors the join
   * strategy's shape for the one row.
   */
  private async runFindUniqueBatched(args: FindUniqueArgs<T>): Promise<T | null> {
    const withClause = args.with as WithClause;
    // Same scope-rule parity as runFindManyBatched: reject before querying.
    rejectNestedPickOrder(withClause);
    const needed = neededParentKeyFields(this.tableMeta, withClause);
    const proj = includeKeysForBatching(
      args.select as Record<string, boolean> | undefined,
      args.omit as Record<string, boolean> | undefined,
      needed,
    );
    const baseArgs = { ...args, with: undefined, select: proj.select, omit: proj.omit } as unknown as FindUniqueArgs<T>;
    const deferred = this.buildFindUnique(baseArgs as Parameters<QueryInterface<T, R>['buildFindUnique']>[0]);
    const result = await this.queryWithTimeout(deferred.sql, deferred.params, args.timeout, deferred.preparedName);
    const entity = deferred.transform(result) as Record<string, unknown> | null;
    if (!entity) return null;
    await loadRelationsBatched(
      this.batchedContext(args.timeout, args.skipGlobalFilters, args.includePii === true),
      [entity],
      withClause,
      args.timeout,
    );
    stripFields([entity], proj.strip);
    return entity as T;
  }

  // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause" — matches TypedWithClause default
  buildFindUnique<W extends TypedWithClause<R> = {}>(
    args: FindUniqueArgs<T, R, W, Record<string, boolean> | undefined, Record<string, boolean> | undefined>,
  ): DeferredQuery<T | null> {
    this.currentSkip = args.skipGlobalFilters;
    const includePii = args.includePii === true;
    const columnsList = this.resolveColumns(args.select, args.omit, includePii);
    // A global filter turns the where into `{ AND: [...] }`, which the
    // `isSimpleWhere` test below rejects → the general (buildWhereClause) path
    // handles the merge and its params uniformly.
    const whereObj = (this.mergeGlobalFilter(args.where as Record<string, unknown>) ?? {}) as Record<string, unknown>;
    const colKey = columnsList ? columnsList.join(',') : '*';
    const whereFingerprint = this.fingerprintWhere(whereObj);
    const withFp = args.with ? this.withFingerprint(args.with as WithClause) : '';
    // See buildFindMany: `includePii` is its own cache-key segment so a no-PII
    // statement can never serve an `includePii` call (relation projections that
    // `withFp` does not capture also flip on it).
    const ck = `fu:${whereFingerprint}|c=${colKey}|w=${withFp}|pii=${includePii ? 1 : 0}${this.globalFilterCacheSegment()}`;

    const params: unknown[] = [];

    // Check if all where values are simple (plain equality, no operators/null/OR).
    // Keys are sorted to match fingerprintWhere — insertion order here would let
    // permuted where literals share a cache entry with misaligned params.
    const whereKeys = Object.keys(whereObj)
      .filter((k) => whereObj[k] !== undefined)
      .sort();
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
      const buildSql = (freshParams: unknown[]): string => {
        const qt = this.q(this.table);
        const whereClauses = whereKeys.map((k, i) => {
          freshParams.push(whereObj[k]);
          return `${this.toSqlColumn(k)} = ${this.p(i + 1)}`;
        });
        const whereSql = whereClauses.length > 0 ? ` WHERE ${whereClauses.join(' AND ')}` : '';
        const selectExpr = columnsList ? columnsList.map((c) => `${qt}.${this.q(c)}`).join(', ') : `${qt}.*`;
        return `SELECT ${selectExpr} FROM ${qt}${whereSql}${this.limitOneClause()}`;
      };
      const entry = this.acquireSql(ck, buildSql);

      // Collect params (same order as build)
      for (const k of whereKeys) {
        params.push(whereObj[k]);
      }
      this.crossCheckCache('findUnique', ck, entry, buildSql, params);

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
      const buildSql = (freshParams: unknown[]): string => {
        const clause = this.buildWhereClause(whereObj, freshParams);
        const whereSql = clause ? ` WHERE ${clause}` : '';
        const qt = this.q(this.table);
        const selectExpr = columnsList ? columnsList.map((c) => `${qt}.${this.q(c)}`).join(', ') : `${qt}.*`;
        return `SELECT ${selectExpr} FROM ${qt}${whereSql}${this.limitOneClause()}`;
      };
      const entry = this.acquireSql(ck, buildSql);

      // Collect params
      this.collectWhereParams(whereObj, params);
      this.crossCheckCache('findUnique', ck, entry, buildSql, params);

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
    const buildSql = (freshParams: unknown[]): string => {
      const clause = this.buildWhereClause(whereObj, freshParams);
      const whereSql = clause ? ` WHERE ${clause}` : '';
      const selectClause = this.buildSelectWithRelations(
        this.table,
        args.with as WithClause,
        freshParams,
        columnsList,
        undefined,
        undefined,
        includePii,
      );
      return `SELECT ${selectClause} FROM ${this.q(this.table)}${whereSql}${this.limitOneClause()}`;
    };
    const entry = this.acquireSql(ck, buildSql);

    // Collect params in exact build order: where first, then with-clause relations
    this.collectWhereParams(whereObj, params);
    this.collectWithParams(args.with as WithClause, params);
    this.crossCheckCache('findUnique', ck, entry, buildSql, params);

    const parseWith = this.makeNestedParser(args.with as WithClause, args.includePii === true);

    return {
      sql: entry.sql,
      params,
      transform: (result) => {
        const row = result.rows[0];
        return row ? (parseWith(row) as T) : null;
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
      if (args?.with && this.resolveLoadStrategy(args.relationLoadStrategy) === 'batched') {
        return this.runFindManyBatched(args as unknown as FindManyArgs<T>);
      }
      const deferred = this.buildFindMany(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args?.timeout, deferred.preparedName);
      return deferred.transform(result);
    }) as Promise<QueryResult<T, R, W, S, O>[]>;
  }

  /**
   * Return the engine's query plan for a {@link findMany}-shaped query as plain
   * text lines: a diagnostic surface for inspecting how the database will run a
   * query (index usage, join strategy, scan type).
   *
   * The compiled SELECT is prefixed with the dialect's explain syntax
   * (Postgres `EXPLAIN`, SQLite `EXPLAIN QUERY PLAN`, MySQL `EXPLAIN
   * FORMAT=TREE`) and run as a read. The findMany args are compiled with the
   * SQL template cache disabled, so an explain never reads or writes the shared
   * cache. Middleware is NOT applied: the returned rows are plan text, not
   * entity rows. Each result row is flattened to one line by joining its column
   * values with a single space (Postgres returns one `QUERY PLAN` text column,
   * SQLite's `EXPLAIN QUERY PLAN` returns four, MySQL's tree format one).
   *
   * Only `findMany` shapes are supported (where / orderBy / with / limit /
   * pagination). Engines whose plan cannot be requested in-band from a compiled
   * query (SQL Server, whose SHOWPLAN is a session toggle) throw
   * {@link UnsupportedFeatureError} (E017).
   *
   * The plan text itself is engine-owned and NOT covered by semver: its content
   * and formatting can change with the underlying database version.
   */
  async explain(args?: FindManyArgs<T, R>): Promise<string[]> {
    const explainSyntax = this.dialect.explainQuery;
    if (!explainSyntax) {
      throw new UnsupportedFeatureError(
        'explain()',
        this.dialect.name,
        'This engine cannot explain a compiled query in-band.',
      );
    }
    // Compile the findMany SQL with the cache disabled: the prefixed EXPLAIN
    // statement is a one-off diagnostic and must never read or write the shared
    // query-template cache.
    const deferred = this.withSqlCacheDisabled(() =>
      this.buildFindMany(args as Parameters<QueryInterface<T, R>['buildFindMany']>[0]),
    );
    const sql = `${explainSyntax.prefix} ${deferred.sql}`;
    this.currentAction = 'explain';
    // No preparedName: keep the diagnostic statement out of the prepared path.
    const result = await this.queryWithTimeout(sql, deferred.params, args?.timeout);
    return result.rows.map((row) =>
      Object.values(row)
        .map((value) => (typeof value === 'string' ? value : String(value)))
        .join(' '),
    );
  }

  /**
   * Run `fn` with the SQL template cache forced off, restoring the prior state
   * afterward. Used by {@link explain}, whose one-off prefixed statement must
   * neither read nor write the shared cache. `fn` is synchronous, so no query
   * interleaves between the toggle and its restore.
   */
  private withSqlCacheDisabled<V>(fn: () => V): V {
    const prev = this.sqlCacheEnabled;
    this.sqlCacheEnabled = false;
    try {
      return fn();
    } finally {
      this.sqlCacheEnabled = prev;
    }
  }

  /**
   * Emit a one-time `console.warn` when {@link findMany} is called without an
   * explicit `limit`/`take` and `warnOnUnlimited` has not been disabled.
   *
   * Deduped per QueryInterface instance via {@link warnedTables} so a busy
   * loop calling `db.users.findMany()` thousands of times only logs once.
   * Suppressed when `defaultLimit` is configured (the caller has already
   * opted in to a bounded query) and when the user passed an explicit
   * `limit`, `take`, or `cursor`. A per-call `warnOnUnlimited` overrides the
   * config-level setting in either direction (`false` silences a call that
   * intentionally reads the full set; `true` forces the warning even when
   * disabled in config).
   */
  private maybeWarnUnlimited(args?: {
    limit?: number;
    take?: number;
    cursor?: unknown;
    warnOnUnlimited?: boolean;
  }): void {
    const perCall = args?.warnOnUnlimited;
    if (perCall === false) return;
    if (perCall === undefined && !this.warnOnUnlimited) return;
    if (this.defaultLimit !== undefined) return;
    const hasExplicitLimit = args?.limit !== undefined || args?.take !== undefined || args?.cursor !== undefined;
    if (hasExplicitLimit) return;
    if (this.warnedTables.has(this.table)) return;
    this.warnedTables.add(this.table);
    console.warn(
      `[turbine] warning: findMany on "${this.table}" has no limit: this will fetch every row. ` +
        'Pass `limit`, or silence with `warnOnUnlimited: false` (per call, per table, or in config).',
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
    this.currentSkip = args?.skipGlobalFilters;
    // `distinct` + relation orderBy is refused up front (E003): the distinct
    // path re-orders in an outer wrapper (`... AS "<table>_distinct" ORDER BY
    // <userOrder>`) where a correlated relation subquery (pick-row, `_count`,
    // to-one relation ordering) would reference the parent table name out of
    // scope — a guaranteed "missing FROM-clause entry" crash on Postgres.
    // Checked BEFORE the SQL cache so build and warm-cache paths throw
    // identically (same rule as the vector guard inside the distinct branch).
    if (args?.distinct && args.distinct.length > 0 && args.orderBy) {
      for (const d of Object.values(args.orderBy)) {
        if (this.isRelationOrderByValue(d)) {
          throw new ValidationError(
            '[turbine] `distinct` cannot be combined with relation orderBy (pick-row, `_count`, or ' +
              'to-one relation ordering): the outer re-order cannot reference the parent table.',
          );
        }
      }
    }
    const includePii = args?.includePii === true;
    const columnsList = this.resolveColumns(args?.select, args?.omit, includePii);
    const colKey = columnsList ? columnsList.join(',') : '*';
    // AND-merge this table's global filter into the user where; `hasWhere` gates
    // the build/collect just like `args?.where` did (a merged filter can make
    // an otherwise-absent where present).
    const effWhere = this.mergeGlobalFilter(args?.where as Record<string, unknown> | undefined);
    const hasWhere = effWhere !== undefined;
    const whereObj = (effWhere ?? {}) as Record<string, unknown>;

    // Build fingerprint for cache lookup
    const whereFp = hasWhere ? this.fingerprintWhere(whereObj) : '';
    const withFp = args?.with ? this.withFingerprint(args.with as WithClause) : '';
    const orderFp = args?.orderBy
      ? Object.entries(args.orderBy)
          .map(([k, d]) => `${k}:${this.orderByEntryFingerprint(d, this.tableMeta.relations[k]?.to)}`)
          .join(',')
      : '';
    const cursorFp = args?.cursor
      ? Object.keys(args.cursor as Record<string, unknown>)
          .filter((k) => (args.cursor as Record<string, unknown>)[k] !== undefined)
          .sort()
          .join(',')
      : '';
    // distinct must fingerprint in USER order: the SQL emits `DISTINCT ON` in
    // the caller's column order, so a permuted array rebuilds different SQL and
    // must not collapse onto the same cache entry (would trip the cross-check).
    const distinctFp = args?.distinct ? args.distinct.join(',') : '';
    const effectiveLimit = args?.take ?? args?.limit ?? this.defaultLimit;
    // On engines that inline the literal LIMIT/OFFSET into the SQL text
    // (dialect.inlineLimitOffset, MySQL), the value is part of the SQL, not the
    // params, so it MUST be part of the fingerprint or two different limits share
    // one cached statement (silent wrong row counts). Parameterized engines
    // (PG/SQLite/SQL Server, whose buildLimitOffset uses placeholders) keep the
    // presence-only fingerprint so the cache is not needlessly fragmented.
    const inlinePagination = this.dialect.inlineLimitOffset === true;
    const limitFp = effectiveLimit !== undefined ? (inlinePagination ? `v${effectiveLimit}` : '1') : '0';
    const offsetFp = args?.offset !== undefined ? (inlinePagination ? `v${args.offset}` : '1') : '0';

    // `includePii` flips the projected column set at the top level (reflected in
    // `colKey`) AND inside every relation subquery / batched follow-up (which
    // `withFp` does NOT capture; it is projection-invariant). So it MUST be its
    // own cache-key segment: a cached no-PII statement must never serve an
    // `includePii` call, nor vice versa.
    const ck = `fm:${whereFp}|c=${colKey}|o=${orderFp}|l=${limitFp}|off=${offsetFp}|cur=${cursorFp}|d=${distinctFp}|w=${withFp}|pii=${includePii ? 1 : 0}${this.globalFilterCacheSegment()}`;

    const params: unknown[] = [];

    const buildSql = (freshParams: unknown[]): string => {
      // Fresh build: generates SQL and populates freshParams
      const { sql: freshWhereSql } = hasWhere
        ? (() => {
            const clause = this.buildWhereClause(whereObj, freshParams);
            return { sql: clause ? ` WHERE ${clause}` : '' };
          })()
        : { sql: '' };

      const qt = this.q(this.table);

      let distinctPrefix = '';
      let distinctCols: string[] = [];
      if (args?.distinct && args.distinct.length > 0) {
        distinctCols = args.distinct.map((k) => this.toSqlColumn(k as string));
        distinctPrefix = `DISTINCT ON (${distinctCols.join(', ')}) `;
      }

      let selectClause: string;
      if (args?.with) {
        selectClause = this.buildSelectWithRelations(
          this.table,
          args.with as WithClause,
          freshParams,
          columnsList,
          undefined,
          undefined,
          includePii,
        );
      } else if (columnsList) {
        selectClause = columnsList.map((c) => `${qt}.${this.q(c)}`).join(', ');
      } else {
        selectClause = `${qt}.*`;
      }

      // Piece-then-assemble. The join-sink between FROM and WHERE carries any
      // `plan: 'lateral'` pick joins; it is populated during the ORDER BY build
      // below and spliced in at final assembly. Empty for every other query
      // shape → the assembled SQL is byte-identical to the incremental-append
      // form for the default plan (asserted by the byte-equality snapshot test).
      const lateralJoins: string[] = [];

      // WHERE + cursor conditions accumulate into `tail`, pushing params in
      // where → cursor order (the collect path mirrors this exactly).
      let tail = freshWhereSql;
      if (args?.cursor) {
        // Sorted (canonical) order — MUST match cursorFp and the cache-hit collect below.
        const cursorEntries = sortedEntries(args.cursor as Record<string, unknown>).filter(([, v]) => v !== undefined);
        if (cursorEntries.length > 0) {
          const cursorConditions = cursorEntries.map(([k, v]) => {
            const col = this.toSqlColumn(k);
            // orderBy values can be the { sort, nulls } spec form: normalize
            // before comparing, or a desc spec would seek the ascending side.
            const dir = args.orderBy?.[k];
            const desc = isOrderBySpec(dir) ? dir.sort === 'desc' : dir === 'desc';
            const op = desc ? '<' : '>';
            freshParams.push(v);
            return `${qt}.${col} ${op} ${this.p(freshParams.length)}`;
          });
          tail += freshWhereSql ? ` AND ${cursorConditions.join(' AND ')}` : ` WHERE ${cursorConditions.join(' AND ')}`;
        }
      }

      // ORDER BY is built AFTER the cursor pushes (param order
      // where → with → cursor → orderBy → limit → offset) and BEFORE final
      // assembly (so the lateral sink is filled before the FROM clause is
      // written). distinct + relation orderBy is refused up front, so a lateral
      // pick can never reach the distinct branch (lateralJoins stays empty).
      let sql: string;
      if (args?.orderBy && distinctPrefix) {
        // Postgres requires DISTINCT ON expressions to lead the ORDER BY. Prisma
        // semantics ("first row per combination, result in the user's order")
        // need two levels: inner DISTINCT ON ordered by the distinct columns then
        // the user's order (picks the right representative row), outer re-ordered
        // by the user's order alone.
        if (Object.values(args.orderBy).some((d) => isVectorOrderBy(d))) {
          throw new ValidationError('[turbine] `distinct` cannot be combined with vector distance ordering.');
        }
        const userOrder = this.buildOrderBy(args.orderBy, freshParams);
        const inner = `SELECT ${distinctPrefix}${selectClause} FROM ${qt}${tail} ORDER BY ${distinctCols
          .map((c) => `${c} ASC`)
          .join(', ')}, ${userOrder}`;
        sql = `SELECT * FROM (${inner}) AS ${this.q(`${this.table}_distinct`)} ORDER BY ${userOrder}`;
      } else {
        // Pass freshParams so vector KNN ordering binds its `$n::vector` query
        // vector at the correct position (after cursor params, before LIMIT), and
        // lateralJoins so a lateral pick splices its join into the FROM clause.
        const orderBySql = args?.orderBy
          ? ` ORDER BY ${this.buildOrderBy(args.orderBy, freshParams, lateralJoins)}`
          : '';
        sql = `SELECT ${distinctPrefix}${selectClause} FROM ${qt}${lateralJoins.join('')}${tail}${orderBySql}`;
      }

      // Pagination — push params in the same order the collect path mirrors
      // (limit before offset); the SQL TEXT shape is dialect-owned via
      // buildPagination (PG: ` LIMIT $n`/` OFFSET $n`; SQL Server: OFFSET/FETCH).
      let limitPh: string | undefined;
      let offsetPh: string | undefined;
      if (effectiveLimit !== undefined) {
        limitPh = this.paginationRef(effectiveLimit, freshParams);
      }
      if (args?.offset !== undefined) {
        offsetPh = this.paginationRef(args.offset, freshParams);
      }
      sql += this.buildPagination(limitPh, offsetPh, !!args?.orderBy);

      return sql;
    };
    const entry = this.acquireSql(ck, buildSql);

    // Collect params in exact build order:
    // 1. WHERE params (includes the AND-merged global filter, if any)
    if (hasWhere) {
      this.collectWhereParams(whereObj, params);
    }
    // 2. WITH relation params
    if (args?.with) {
      this.collectWithParams(args.with as WithClause, params);
    }
    // 3. Cursor params — sorted (canonical) order, matching cursorFp and the build path.
    if (args?.cursor) {
      const cursorEntries = sortedEntries(args.cursor as Record<string, unknown>).filter(([, v]) => v !== undefined);
      for (const [, v] of cursorEntries) {
        params.push(v);
      }
    }
    // 4. ORDER BY params (vector KNN ordering binds a `$n::vector` query vector).
    //    Mirrors buildOrderBy's push order — between cursor and LIMIT.
    if (args?.orderBy) {
      this.collectOrderByParams(args.orderBy, params);
    }
    // 5. LIMIT param — skipped when the dialect inlines pagination (build path
    //    mirrors via paginationRef → no placeholder, no param).
    if (effectiveLimit !== undefined && !this.dialect.inlineLimitOffset) {
      params.push(Number(effectiveLimit));
    }
    // 6. OFFSET param — same inline gate as LIMIT above.
    if (args?.offset !== undefined && !this.dialect.inlineLimitOffset) {
      params.push(Number(args.offset));
    }
    this.crossCheckCache('findMany', ck, entry, buildSql, params);

    // Build the row parser once (positional shapes are computed here, not per row).
    const parseWith = args?.with ? this.makeNestedParser(args.with as WithClause, includePii) : null;

    return {
      sql: entry.sql,
      params,
      transform: (result) =>
        result.rows.map((row) => (parseWith ? (parseWith(row) as T) : (this.parseRow(row, this.table) as T))),
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
    // Build the positional-aware relation parser once for the whole stream.
    const parseWith = hasRelations ? this.makeNestedParser(args!.with as WithClause, args?.includePii === true) : null;

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
        yield (parseWith ? parseWith(row) : this.parseRow(row, this.table)) as QueryResult<T, R, W, S, O>;
      }
      return;
    }

    // --- Overflow: fall back to cursor path from scratch ---
    const deferred = this.buildFindMany(args);

    // Acquire a dedicated connection — cursors require a single connection in a
    // transaction. The dialect owns the streaming SQL (Postgres: BEGIN → DECLARE
    // … NO SCROLL CURSOR FOR → FETCH n → CLOSE → COMMIT, ROLLBACK on error); we
    // just parse + yield the row batches it produces.
    const client = await this.pool.connect();
    try {
      for await (const batch of this.dialect.openStream(client, deferred.sql, deferred.params, batchSize)) {
        for (const row of batch) {
          yield (parseWith ? parseWith(row) : this.parseRow(row, this.table)) as QueryResult<T, R, W, S, O>;
        }
      }
    } catch (err) {
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
      if (args?.with && this.resolveLoadStrategy(args.relationLoadStrategy) === 'batched') {
        // findFirst is findMany + LIMIT 1: batch the single base row, then load.
        const rows = await this.runFindManyBatched({ ...args, limit: 1 } as unknown as FindManyArgs<T>);
        return (rows[0] ?? null) as QueryResult<T, R, W, S, O> | null;
      }
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

  async create(args: CreateArgs<T, R>): Promise<T> {
    return this.executeWithMiddleware('create', args as unknown as Record<string, unknown>, async () => {
      if (hasRelationFields(args.data as Record<string, unknown>, this.tableMeta)) {
        return this.nestedCreate(args);
      }
      const deferred = this.buildCreate(args);
      return this.executeMutation(deferred, args.timeout);
    });
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

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------

  async update(args: UpdateArgs<T, R>): Promise<T> {
    return this.executeWithMiddleware('update', args as unknown as Record<string, unknown>, async () => {
      if (hasRelationFields(args.data as Record<string, unknown>, this.tableMeta)) {
        return this.nestedUpdate(args);
      }
      const deferred = this.buildUpdate(args);
      return this.executeMutation(deferred, args.timeout);
    });
  }

  // -------------------------------------------------------------------------
  // Nested write helpers (shared by create + update)
  // -------------------------------------------------------------------------

  private async nestedCreate(args: CreateArgs<T, R>): Promise<T> {
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

  private async nestedUpdate(args: UpdateArgs<T, R>): Promise<T> {
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
      await client.query(this.dialect.beginStatement());
      const { TransactionClient } = await import('../client.js');
      // biome-ignore lint/suspicious/noExplicitAny: MiddlewareFn and Middleware are structurally identical
      const tx = new TransactionClient(client as any, this.schema, this.middlewares as any, this.options);
      // biome-ignore lint/suspicious/noExplicitAny: TransactionClient satisfies NestedWriteContext['tx'] at runtime
      const ctx: NestedWriteContext = { schema: this.schema, tx: tx as any };
      const result = await fn(ctx);
      await client.query(this.dialect.commitStatement());
      return result;
    } catch (err) {
      try {
        await client.query(this.dialect.rollbackStatement());
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
      return this.executeMutation(deferred, args.timeout);
    });
  }

  // -------------------------------------------------------------------------
  // upsert — INSERT ... ON CONFLICT ... DO UPDATE
  // -------------------------------------------------------------------------

  async upsert(args: UpsertArgs<T>): Promise<T> {
    return this.executeWithMiddleware('upsert', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildUpsert(args);
      return this.executeMutation(deferred, args.timeout);
    });
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
    this.currentSkip = args?.skipGlobalFilters;
    const effWhere = this.mergeGlobalFilter(args?.where as Record<string, unknown> | undefined);
    const hasWhere = effWhere !== undefined;
    const whereObj = (effWhere ?? {}) as Record<string, unknown>;
    const whereFp = hasWhere ? this.fingerprintWhere(whereObj) : '';
    const ck = `cnt:${whereFp}${this.globalFilterCacheSegment()}`;

    const params: unknown[] = [];

    const buildSql = (freshParams: unknown[]): string => {
      const clause = hasWhere ? this.buildWhereClause(whereObj, freshParams) : null;
      const whereSql = clause ? ` WHERE ${clause}` : '';
      return `SELECT ${this.castAgg('COUNT(*)', 'int')} AS count FROM ${this.q(this.table)}${whereSql}`;
    };
    const entry = this.acquireSql(ck, buildSql);

    if (hasWhere) {
      this.collectWhereParams(whereObj, params);
    }
    this.crossCheckCache('count', ck, entry, buildSql, params);

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

  // ---------------------------------------------------------------------------
  // Aggregate / groupBy compilation (extracted to aggregates.ts).
  // ---------------------------------------------------------------------------

  buildGroupBy(args: GroupByArgs<T>): DeferredQuery<Record<string, unknown>[]> {
    return aggMod.buildGroupBy(this.ctx, args);
  }

  buildAggregate(args: AggregateArgs<T>): DeferredQuery<AggregateResult<T>> {
    return aggMod.buildAggregate(this.ctx, args);
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

  // =========================================================================
  // Internal helpers
  // =========================================================================

  // ---------------------------------------------------------------------------
  // Relation + orderBy compilation (extracted to relations.ts).
  // ---------------------------------------------------------------------------

  private resolveColumns(
    select?: Record<string, boolean>,
    omit?: Record<string, boolean>,
    includePii?: boolean,
  ): string[] | null {
    return relationsMod.resolveColumns(this.ctx, select, omit, includePii);
  }

  withFingerprint(withClause: WithClause | undefined, table?: string, depth = 0): string {
    return relationsMod.withFingerprint(this.ctx, withClause, table, depth);
  }

  private collectWithParams(withClause: WithClause, params: unknown[], table?: string): void {
    relationsMod.collectWithParams(this.ctx, withClause, params, table);
  }

  private orderByEntryFingerprint(d: unknown, targetTable?: string): string {
    return relationsMod.orderByEntryFingerprint(this.ctx, d, targetTable);
  }

  private buildOrderBy(orderBy: OrderByClause, params?: unknown[], lateralSink?: string[]): string {
    return relationsMod.buildOrderBy(this.ctx, orderBy, params, lateralSink);
  }

  private isRelationOrderByValue(value: unknown): boolean {
    return relationsMod.isRelationOrderByValue(this.ctx, value);
  }

  private nullsSuffix(nulls: 'first' | 'last' | undefined): string {
    return relationsMod.nullsSuffix(this.ctx, nulls);
  }

  private resolveOrderByColumn(table: string, meta: TableMetadata, key: string): string {
    return relationsMod.resolveOrderByColumn(this.ctx, table, meta, key);
  }

  private validateJsonPathOrderBy(table: string, meta: TableMetadata, field: string, spec: JsonPathOrderBy): string {
    return relationsMod.validateJsonPathOrderBy(this.ctx, table, meta, field, spec);
  }

  private buildJsonPathOrderEntry(
    table: string,
    meta: TableMetadata,
    field: string,
    spec: JsonPathOrderBy,
    prefix: string,
    params?: unknown[],
  ): string {
    return relationsMod.buildJsonPathOrderEntry(this.ctx, table, meta, field, spec, prefix, params);
  }

  private collectRelationPickOrderParams(
    relName: string,
    relDef: RelationDef,
    spec: RelationPickOrderBy,
    params: unknown[],
  ): void {
    relationsMod.collectRelationPickOrderParams(this.ctx, relName, relDef, spec, params);
  }

  private collectRelationCountParams(relDef: RelationDef, params: unknown[]): void {
    relationsMod.collectRelationCountParams(this.ctx, relDef, params);
  }

  private getCamelDateFields(table: string, meta: TableMetadata): Set<string> {
    return relationsMod.getCamelDateFields(this.ctx, table, meta);
  }

  private makeNestedParser(
    withClause: WithClause,
    includePii?: boolean,
  ): (row: Record<string, unknown>) => Record<string, unknown> {
    return relationsMod.makeNestedParser(this.ctx, withClause, includePii);
  }

  private buildSelectWithRelations(
    table: string,
    withClause: WithClause,
    params: unknown[],
    columnsList?: string[] | null,
    depth?: number,
    path?: string[],
    includePii?: boolean,
  ): string {
    return relationsMod.buildSelectWithRelations(
      this.ctx,
      table,
      withClause,
      params,
      columnsList,
      depth,
      path,
      includePii,
    );
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

  // =========================================================================
  // Fingerprinting — value-invariant shape keys for SQL cache lookup
  // =========================================================================

  // ---------------------------------------------------------------------------
  // WHERE-clause compilation (extracted to where.ts).
  //
  // These thin delegators forward to the free functions in where.ts, passing
  // this.ctx (the BuilderCtx view built in the constructor). Methods called
  // only from within where.ts itself were moved out entirely; only the
  // cross-module + public + @internal entry points keep a delegator here.
  // ---------------------------------------------------------------------------

  fingerprintWhere(where: Record<string, unknown>): string {
    return whereMod.fingerprintWhere(this.ctx, where);
  }

  collectWhereParams(where: Record<string, unknown>, params: unknown[]): void {
    whereMod.collectWhereParams(this.ctx, where, params);
  }

  private resolveGlobalFilter(
    table: string,
    skip: SkipGlobalFilters | undefined = this.currentSkip,
  ): Record<string, unknown> | null {
    return whereMod.resolveGlobalFilter(this.ctx, table, skip);
  }

  private mergeGlobalFilter(userWhere: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    return whereMod.mergeGlobalFilter(this.ctx, userWhere);
  }

  private collectTargetGlobalFilterAlias(targetTable: string, params: unknown[]): void {
    whereMod.collectTargetGlobalFilterAlias(this.ctx, targetTable, params);
  }

  private globalFilterCacheSegment(): string {
    return whereMod.globalFilterCacheSegment(this.ctx);
  }

  private buildWhereClause(where: Record<string, unknown>, params: unknown[]): string | null {
    return whereMod.buildWhereClause(this.ctx, where, params);
  }

  private buildAliasWhere(
    targetTable: string,
    targetMeta: TableMetadata,
    alias: string,
    where: Record<string, unknown>,
    params: unknown[],
  ): string | null {
    return whereMod.buildAliasWhere(this.ctx, targetTable, targetMeta, alias, where, params);
  }

  private vectorOperator(field: string, rawColumn: string, metric: string): string {
    return whereMod.vectorOperator(this.ctx, field, rawColumn, metric);
  }

  private pushVectorParam(field: string, _rawColumn: string, to: unknown, params: unknown[]): string {
    return whereMod.pushVectorParam(this.ctx, field, _rawColumn, to, params);
  }

  private normalizeRelationFilter(relDef: RelationDef, filterObj: Record<string, unknown>): Record<string, unknown> {
    return whereMod.normalizeRelationFilter(this.ctx, relDef, filterObj);
  }

  private isJsonColumnType(colType: string): boolean {
    return whereMod.isJsonColumnType(this.ctx, colType);
  }

  private getColumnPgType(column: string): string {
    return whereMod.getColumnPgType(this.ctx, column);
  }

  private jsonPathParam(path: readonly (string | number)[], nativeForm?: unknown): unknown {
    return whereMod.jsonPathParam(this.ctx, path, nativeForm);
  }

  /**
   * Collect params for an orderBy clause. Vector KNN ordering pushes the
   * `$n::vector` query vector and JSON-path ordering pushes its text[] path;
   * plain direction ordering is parameterless. Mirrors buildOrderBy's push
   * order exactly so the cached-SQL param re-collection stays in lockstep.
   */
  private collectOrderByParams(orderBy: OrderByClause, params: unknown[]): void {
    for (const [key, dir] of Object.entries(orderBy)) {
      if (isVectorOrderBy(dir)) {
        const rawColumn = this.toColumn(key);
        // Re-run the same validation as buildOrderBy so the collect path can
        // never push a param that the build path rejected (or vice versa).
        this.vectorOperator(key, rawColumn, dir.distance.metric);
        this.pushVectorParam(key, rawColumn, dir.distance.to, params);
        continue;
      }
      // JSON-path ordering: mirrors buildJsonPathOrderEntry: same validation,
      // then the path bound as one text[] param.
      if (isJsonPathOrderBy(dir)) {
        this.validateJsonPathOrderBy(this.table, this.tableMeta, key, dir);
        params.push(this.jsonPathParam(dir.path));
        continue;
      }
      // To-many relation orderBy (`{ posts: { _count } }`) uses the same count
      // subquery as `_count`: mirror its global-filter params. Pick-row
      // ordering mirrors its full param chain (by-path / global filter /
      // pick.where / pick.orderBy paths). To-one relation orderBy carries the
      // target's global filter once per ordered column.
      if (this.isRelationOrderByValue(dir)) {
        const relDef = this.tableMeta.relations[key];
        if (relDef && isRelationPickOrderBy(dir)) {
          this.collectRelationPickOrderParams(key, relDef, dir, params);
        } else if (relDef && (relDef.type === 'hasMany' || relDef.type === 'manyToMany')) {
          this.collectRelationCountParams(relDef, params);
        } else if (relDef) {
          for (const _col of Object.keys(dir as Record<string, unknown>)) {
            this.collectTargetGlobalFilterAlias(relDef.to, params);
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Global filters (soft-delete / multi-tenancy — WS-G)
  //
  // A configured global filter for a table is AND-merged into the compiled WHERE
  // of every query on that table (via {@link mergeGlobalFilter}, so the merge is
  // captured in the where fingerprint/collect for free) and into every relation
  // subquery targeting it (rendered at build time against the subquery's alias/
  // table by the `*GlobalFilterAlias`/`*GlobalFilterExists` helpers, with the
  // shape folded into the SQL-cache key via {@link globalFilterCacheSegment}).
  // Function filters are evaluated per resolve — at query-build time — enabling
  // per-request tenancy via a closure. They must return a STABLE shape (same
  // keys/operators); only values may vary between calls.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Scoped (non-top-level) WHERE compilation — relation EXISTS sub-wheres and
  // relation `with`-clause `where`s. All three consumers below drive the SAME
  // canonical `walkWhere` the top level uses (bound to the SCOPE's target
  // table), so their key order + combinator structure + relation detection can
  // never drift from each other or from the top-level trio. Only the per-event
  // rendering (column qualifier, correlation parent, unknown-column wording)
  // differs, and that is carried by the `WhereScope`.
  // -------------------------------------------------------------------------

  /**
   * The {@link WhereHost} for a scoped sub-where over `meta`'s table. Memoized
   * per table (see {@link scopedHostCache}); the host depends only on the target
   * metadata, not on the caller's alias/qualifier.
   */

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

  // -------------------------------------------------------------------------
  // pgvector helpers (similarity search)
  // -------------------------------------------------------------------------

  /** Parse a flat row: convert snake_case to camelCase + Date coercion */
  /**
   * Returns the set of camelCase field names for a table's date columns,
   * derived once from `meta.dateColumns` (snake_case) via reverseColumnMap and
   * memoized per table. Used so nested relation rows (camelCase keys) coerce
   * dates the same way top-level rows do.
   */

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
          // Offset-less strings (Postgres `timestamp`, json_agg output) are
          // pinned to UTC so results don't depend on the server's time zone.
          parsed[field] = this.utcTimestamps ? parseDbDate(String(value)) : new Date(value as string);
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

  // -------------------------------------------------------------------------
  // Positional JSON encoding (jsonEncoding: 'positional')
  //
  // When active, relation subqueries emit `json_agg(json_build_array(v1, v2, …))`
  // instead of `json_build_object('k1', v1, …)`, dropping every repeated key
  // name. The builder knows the exact column order, so it records a recursive
  // RelationShape during SQL generation; the transform decodes each positional
  // array back into the object representation the object-encoding would have
  // produced, then hands it to parseNestedRow — so parsed output is byte-
  // identical to the object path (same dates, same snake→camel, same recursion).
  // -------------------------------------------------------------------------

  /**
   * Get the Postgres type for a column (e.g. 'jsonb', 'text', '_int4').
   * Used to detect JSONB/array columns for specialized operators.
   * Uses pre-computed Map for O(1) lookup instead of linear scan.
   */
}
