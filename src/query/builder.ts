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
import type { Dialect, ReturningSelection } from '../dialect.js';
import { postgresDialect } from '../dialect.js';
import {
  CircularRelationError,
  NotFoundError,
  OptimisticLockError,
  RelationError,
  TimeoutError,
  UnsupportedFeatureError,
  ValidationError,
  wrapPgError,
} from '../errors.js';
import { missingIndexForRelation } from '../index-advisor.js';
import {
  executeNestedCreate,
  executeNestedUpdate,
  hasRelationFields,
  type NestedWriteContext,
} from '../nested-write.js';
import type { RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';
import { camelToSnake, normalizeKeyColumns, snakeToCamel } from '../schema.js';
import * as aggMod from './aggregates.js';
import {
  type BatchedChildReader,
  includeKeysForBatching,
  loadRelationsBatched,
  neededParentKeyFields,
  type RelationLoadContext,
  rejectNestedPickOrder,
  resolveCountRelations,
  stripFields,
} from './batched-loader.js';
import {
  isJsonPathOrderBy,
  isOrderBySpec,
  isRelationPickOrderBy,
  isVectorOrderBy,
  isWhereOperator,
  normalizeOrderBy,
  sortedEntries,
  UPDATE_OPERATOR_KEYS,
} from './filters.js';
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
  OrderBySpec,
  OrderDirection,
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
  WithCount,
  WithOptions,
} from './types.js';
import { LRUCache, parseDbDate, type SqlCacheEntry, sqlToPreparedName } from './utils.js';
import type { BuilderCtx } from './where.js';
import * as whereMod from './where.js';
import type { WhereHost } from './where-compile.js';

/** Relations already warned about missing FK indexes (once per process, dev only). */
const unindexedRelationWarned = new Set<string>();

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

/**
 * Decode descriptor for `jsonEncoding: 'positional'`. Built during SQL
 * generation (see {@link QueryInterface.buildRelationShape}) and consumed by the
 * transform to map key-less positional arrays back to keyed objects.
 *
 * - `keys` — camelCase field names in emitted array position, INCLUDING nested
 *   relation slots (a nested relation occupies one more position after the
 *   scalar columns, in `sortedEntries(with)` order).
 * - `nested` — sub-shape for each key in `keys` that is itself a relation slot.
 * - `cardinality` — `'one'` (belongsTo/hasOne, a single positional array or
 *   null) vs `'many'` (an array of positional arrays).
 */
interface RelationShape {
  keys: string[];
  nested: Record<string, RelationShape>;
  cardinality: 'many' | 'one';
}

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

  /**
   * Build a `SELECT * ... WHERE <predicate>` that re-fetches the row(s) matched
   * by a write's `where` clause. Used by the `'reselect'` result strategy to
   * return rows from non-RETURNING engines. Reuses the same parameterized WHERE
   * builder as reads, so no user value is interpolated.
   */
  private buildReselectByWhere(whereObj: Record<string, unknown>): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    const clause = this.buildWhereClause(whereObj, params);
    const where = clause ? ` WHERE ${clause}` : '';
    return { sql: `SELECT ${this.writeReselectSelection()} FROM ${this.q(this.table)}${where}`, params };
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

  buildCreate(args: CreateArgs<T>): DeferredQuery<T> {
    this.assertWritable('create');
    this.assertNoGeneratedColumns(args.data as Record<string, unknown>, 'create');
    const entries = Object.entries(args.data as Record<string, unknown>).filter(([, v]) => v !== undefined);
    const columns = entries.map(([k]) => this.toSqlColumn(k));
    const params = entries.map(([, v]) => v);
    // Enum columns get an explicit `::"EnumName"` cast (see enumTypeForColumn).
    const placeholders = entries.map(([k], i) => `${this.p(i + 1)}${this.enumCastSuffix(this.toColumn(k))}`);

    const sql = this.dialect.buildInsertStatement({
      table: this.q(this.table),
      columns,
      valuePlaceholders: placeholders,
      returning: this.writeReturningColumns(),
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
        return this.parseWriteRow(row) as T;
      },
      tag: `${this.table}.create`,
      // Non-RETURNING engines: INSERT, then re-fetch the new row by primary key
      // (provided value, else the driver's generated insert id).
      reselect: this.makeCreateReselect(sql, params, args.data as Record<string, unknown>),
    };
  }

  /**
   * Build the `'reselect'` plan for {@link buildCreate}: run the INSERT, then
   * `SELECT * WHERE pk = ?`. Returns `undefined` (skipped) unless the active
   * dialect's result strategy is `'reselect'`, so the PostgreSQL/RETURNING path
   * pays nothing. Not yet wired to a real non-RETURNING engine.
   */
  private makeCreateReselect(
    insertSql: string,
    insertParams: unknown[],
    data: Record<string, unknown>,
  ): DeferredQuery<T>['reselect'] {
    if (this.dialect.resultStrategy !== 'reselect') return undefined;
    return async (exec) => {
      const writeResult = await exec(insertSql, insertParams);
      const insertId = this.mutationInsertId(writeResult);
      const conds: string[] = [];
      const selParams: unknown[] = [];
      let idx = 1;
      for (const pk of this.tableMeta.primaryKey) {
        const field = this.tableMeta.reverseColumnMap[pk] ?? snakeToCamel(pk);
        selParams.push(data[field] ?? data[pk] ?? insertId);
        conds.push(`${this.q(pk)} = ${this.p(idx++)}`);
      }
      const where = conds.length > 0 ? ` WHERE ${conds.join(' AND ')}` : '';
      return exec(`SELECT ${this.writeReselectSelection()} FROM ${this.q(this.table)}${where}`, selParams);
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

    this.assertWritable('createMany');
    for (const row of args.data) {
      this.assertNoGeneratedColumns(row as Record<string, unknown>, 'createMany');
    }

    const keys = Object.keys(args.data[0]!).filter((k) => (args.data[0] as Record<string, unknown>)[k] !== undefined);
    const columns = keys.map((k) => this.toColumn(k));

    const rowValues = args.data.map((row) => {
      const record = row as Record<string, unknown>;
      return keys.map((key) => record[key]);
    });

    // Use actual Postgres types for array casts in the default PostgreSQL dialect.
    // Enum columns cast to `"EnumName"[]` — the generic text[] fallback would
    // type the UNNEST output as text, which Postgres refuses to coerce to the
    // enum ("column X is of type Y but expression is of type text").
    const typeCasts = columns.map((col) => {
      const enumType = this.enumTypeForColumn(col);
      return enumType ? `${this.q(enumType)}[]` : this.getColumnArrayType(col);
    });
    const quotedColumns = columns.map((c) => this.q(c));

    const built = this.dialect.buildBulkInsertStatement({
      table: qt,
      columns: quotedColumns,
      rowValues,
      columnArrayTypes: typeCasts,
      skipDuplicates: args.skipDuplicates,
      returning: this.writeReturningColumns(),
    });

    return {
      sql: built.sql,
      params: built.params,
      transform: (result) => result.rows.map((row) => this.parseWriteRow(row) as T),
      tag: `${this.table}.createMany`,
    };
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

  buildUpdate(args: UpdateArgs<T>): DeferredQuery<T> {
    this.assertWritable('update');
    this.currentSkip = args.skipGlobalFilters;
    const dataObj = args.data as Record<string, unknown>;
    this.assertNoGeneratedColumns(dataObj, 'update');
    const userWhere = args.where as Record<string, unknown>;
    const lock = args.optimisticLock;
    // The empty-`where` guard checks the USER predicate only — a global filter
    // must never turn an unguarded mass update into an allowed one.
    const userHasPredicate = !this.userPredicateIsEmpty(userWhere) || !!lock;
    this.assertMutationHasPredicate('update', userHasPredicate ? ' WHERE x' : '', args.allowFullTableScan);
    // The SQL is built from the global-filter-merged where (soft-delete keeps an
    // update from touching already-deleted rows).
    const whereObj = (this.mergeGlobalFilter(userWhere) ?? {}) as Record<string, unknown>;
    const setFp = this.fingerprintSet(dataObj);
    const whereFp = this.fingerprintWhere(whereObj);
    const ck = lock ? null : `u:${setFp}|${whereFp}${this.globalFilterCacheSegment()}`;

    const params: unknown[] = [];

    const buildSql = (freshParams: unknown[]): string => {
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

      // Engines that inject their returning shape MID-statement (SQL Server
      // `OUTPUT INSERTED.*` between SET and WHERE) override buildUpdateStatement;
      // absent → the trailing-clause PG/SQLite/MySQL form (byte-identical).
      // `returning` excludes PII columns on tagged tables (else '*').
      const returning = this.writeReturningColumns();
      return this.dialect.buildUpdateStatement
        ? this.dialect.buildUpdateStatement({ table: this.q(this.table), setClauses, whereSql, returning })
        : `UPDATE ${this.q(this.table)} SET ${setClauses.join(', ')}${whereSql}${this.dialect.buildReturningClause(returning)}`;
    };

    let sql: string;
    let preparedName: string | undefined;
    let cacheEntry: SqlCacheEntry | undefined;

    if (ck) {
      cacheEntry = this.acquireSql(ck, buildSql);
      sql = cacheEntry.sql;
      preparedName = cacheEntry.name;
    } else {
      // optimisticLock path: value-variant version check → uncacheable, no cross-check.
      sql = buildSql([]);
    }

    // Collect params: SET first, then WHERE, then version check (same order as fresh build)
    this.collectSetParams(dataObj, params);
    this.collectWhereParams(whereObj, params);
    if (lock) {
      params.push(lock.expected);
    }
    if (ck && cacheEntry) {
      this.crossCheckCache('update', ck, cacheEntry, buildSql, params);
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
        return this.parseWriteRow(row) as T;
      },
      tag: `${this.table}.update`,
      preparedName,
      // Non-RETURNING engines: UPDATE, then re-fetch the row by the same where.
      reselect:
        this.dialect.resultStrategy === 'reselect'
          ? async (exec) => {
              const writeResult = await exec(sql, params, preparedName);
              // Optimistic-lock conflict: the version-checked UPDATE matched no
              // row. The re-fetch below uses `where` WITHOUT the version
              // predicate, so it would return the stale row and silently mask
              // the conflict — detect it from affected-rows here instead, to
              // match the OptimisticLockError thrown on RETURNING/OUTPUT engines.
              if (lock && (writeResult.rowCount ?? 0) === 0) {
                throw new OptimisticLockError({
                  table: this.table,
                  versionField: lock.field,
                  expectedVersion: lock.expected,
                });
              }
              const sel = this.buildReselectByWhere(whereObj);
              return exec(sel.sql, sel.params);
            }
          : undefined,
    };
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

  buildDelete(args: DeleteArgs<T>): DeferredQuery<T> {
    this.assertWritable('delete');
    this.currentSkip = args.skipGlobalFilters;
    // Guard the USER predicate (a global filter must not satisfy the guard).
    this.assertMutationHasPredicate(
      'delete',
      this.userPredicateIsEmpty(args.where as Record<string, unknown>) ? '' : ' WHERE x',
      args.allowFullTableScan,
    );
    const whereObj = (this.mergeGlobalFilter(args.where as Record<string, unknown>) ?? {}) as Record<string, unknown>;
    const whereFp = this.fingerprintWhere(whereObj);
    const ck = `d:${whereFp}${this.globalFilterCacheSegment()}`;

    const params: unknown[] = [];

    const buildSql = (freshParams: unknown[]): string => {
      const clause = this.buildWhereClause(whereObj, freshParams);
      const whereSql = clause ? ` WHERE ${clause}` : '';
      // SQL Server injects `OUTPUT DELETED.*` between `DELETE FROM <t>` and WHERE;
      // absent override → the trailing-clause PG/SQLite/MySQL form (byte-identical).
      // `returning` excludes PII columns on tagged tables (else '*').
      const returning = this.writeReturningColumns();
      return this.dialect.buildDeleteStatement
        ? this.dialect.buildDeleteStatement({ table: this.q(this.table), whereSql, returning })
        : `DELETE FROM ${this.q(this.table)}${whereSql}${this.dialect.buildReturningClause(returning)}`;
    };
    const entry = this.acquireSql(ck, buildSql);

    this.collectWhereParams(whereObj, params);
    this.crossCheckCache('delete', ck, entry, buildSql, params);

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
        return this.parseWriteRow(row) as T;
      },
      tag: `${this.table}.delete`,
      preparedName: entry.name,
      // Non-RETURNING engines: the row is gone after DELETE, so pre-SELECT it
      // by the same where, then run the DELETE, returning the captured row.
      reselect:
        this.dialect.resultStrategy === 'reselect'
          ? async (exec) => {
              const sel = this.buildReselectByWhere(whereObj);
              const pre = await exec(sel.sql, sel.params);
              await exec(entry.sql, params, entry.name);
              return pre;
            }
          : undefined,
    };
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

  buildUpsert(args: UpsertArgs<T>): DeferredQuery<T> {
    this.assertWritable('upsert');
    this.assertNoGeneratedColumns(args.create as Record<string, unknown>, 'upsert');
    this.assertNoGeneratedColumns(args.update as Record<string, unknown>, 'upsert');
    this.currentSkip = args.skipGlobalFilters;
    // Build the INSERT part from create data
    const createEntries = Object.entries(args.create as Record<string, unknown>).filter(([, v]) => v !== undefined);
    const columns = createEntries.map(([k]) => this.toSqlColumn(k));
    const createParams = createEntries.map(([, v]) => v);
    // Enum columns get an explicit `::"EnumName"` cast (see enumTypeForColumn).
    const placeholders = createEntries.map(([k], i) => `${this.p(i + 1)}${this.enumCastSuffix(this.toColumn(k))}`);

    // The conflict target comes from `where` keys — must be unique/PK columns
    const conflictKeys = Object.keys(args.where as Record<string, unknown>).filter(
      (k) => (args.where as Record<string, unknown>)[k] !== undefined,
    );
    const conflictColumns = conflictKeys.map((k) => this.toSqlColumn(k));

    // Build the UPDATE SET part
    const updateEntries = Object.entries(args.update as Record<string, unknown>).filter(([, v]) => v !== undefined);
    let paramIdx = createParams.length + 1;
    const setClauses = updateEntries.map(([k]) => {
      const clause = `${this.toSqlColumn(k)} = ${this.p(paramIdx)}${this.enumCastSuffix(this.toColumn(k))}`;
      paramIdx++;
      return clause;
    });
    const updateParams = updateEntries.map(([, v]) => v);

    const params = [...createParams, ...updateParams];

    // Global filter → restrict the conflict-UPDATE (soft-delete / tenancy) so an
    // upsert never resurrects a soft-deleted row or writes across tenants. Only
    // on engines whose upsert can carry a predicate (Postgres); the gf params
    // continue the placeholder numbering after create+update params.
    let updateWhere: string | undefined;
    if (this.dialect.supportsUpsertUpdateWhere) {
      const gf = this.resolveGlobalFilter(this.table);
      if (gf) updateWhere = this.buildWhereClause(gf, params) ?? undefined;
    }

    const sql = this.dialect.buildUpsertStatement({
      table: this.q(this.table),
      insertColumns: columns,
      valuePlaceholders: placeholders,
      conflictColumns,
      updateSetClauses: setClauses,
      updateWhere,
      returning: this.writeReturningColumns(),
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
        return this.parseWriteRow(row) as T;
      },
      tag: `${this.table}.upsert`,
      // Non-RETURNING engines: run the upsert, then re-fetch by the where keys.
      reselect:
        this.dialect.resultStrategy === 'reselect'
          ? async (exec) => {
              await exec(sql, params);
              const sel = this.buildReselectByWhere(
                (this.mergeGlobalFilter(args.where as Record<string, unknown>) ?? {}) as Record<string, unknown>,
              );
              return exec(sel.sql, sel.params);
            }
          : undefined,
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
    this.assertWritable('updateMany');
    this.currentSkip = args.skipGlobalFilters;
    const dataObj = args.data as Record<string, unknown>;
    this.assertNoGeneratedColumns(dataObj, 'updateMany');
    this.assertMutationHasPredicate(
      'updateMany',
      this.userPredicateIsEmpty(args.where as Record<string, unknown>) ? '' : ' WHERE x',
      args.allowFullTableScan,
    );
    const whereObj = (this.mergeGlobalFilter(args.where as Record<string, unknown>) ?? {}) as Record<string, unknown>;
    const setFp = this.fingerprintSet(dataObj);
    const whereFp = this.fingerprintWhere(whereObj);
    const ck = `um:${setFp}|${whereFp}${this.globalFilterCacheSegment()}`;

    const params: unknown[] = [];

    const buildSql = (freshParams: unknown[]): string => {
      const setEntries = Object.entries(dataObj).filter(([, v]) => v !== undefined);
      const setClauses = setEntries.map(([k, v]) => this.buildSetClause(k, v, freshParams));
      const whereClause = this.buildWhereClause(whereObj, freshParams);
      const whereSql = whereClause ? ` WHERE ${whereClause}` : '';
      return `UPDATE ${this.q(this.table)} SET ${setClauses.join(', ')}${whereSql}`;
    };
    const entry = this.acquireSql(ck, buildSql);

    this.collectSetParams(dataObj, params);
    this.collectWhereParams(whereObj, params);
    this.crossCheckCache('updateMany', ck, entry, buildSql, params);

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
    this.assertWritable('deleteMany');
    this.currentSkip = args.skipGlobalFilters;
    this.assertMutationHasPredicate(
      'deleteMany',
      this.userPredicateIsEmpty(args.where as Record<string, unknown>) ? '' : ' WHERE x',
      args.allowFullTableScan,
    );
    const whereObj = (this.mergeGlobalFilter(args.where as Record<string, unknown>) ?? {}) as Record<string, unknown>;
    const whereFp = this.fingerprintWhere(whereObj);
    const ck = `dm:${whereFp}${this.globalFilterCacheSegment()}`;

    const params: unknown[] = [];

    const buildSql = (freshParams: unknown[]): string => {
      const clause = this.buildWhereClause(whereObj, freshParams);
      const whereSql = clause ? ` WHERE ${clause}` : '';
      return `DELETE FROM ${this.q(this.table)}${whereSql}`;
    };
    const entry = this.acquireSql(ck, buildSql);

    this.collectWhereParams(whereObj, params);
    this.crossCheckCache('deleteMany', ck, entry, buildSql, params);

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

  /**
   * Resolve select/omit options into a list of snake_case column names.
   * Returns null if neither is provided (meaning all columns).
   */
  private resolveColumns(
    select?: Record<string, boolean>,
    omit?: Record<string, boolean>,
    includePii?: boolean,
  ): string[] | null {
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
      // Only include columns where value is true. An explicit `select` naming a
      // PII column IS the opt-in: it comes back regardless of `includePii`.
      return Object.entries(select)
        .filter(([, v]) => v)
        .map(([k]) => this.toColumn(k));
    }
    // Default / omit-only projection: PII-tagged columns are excluded unless the
    // caller passed `includePii: true`. An empty set (untagged schema) keeps the
    // `null`/`*` fast path so the emitted SQL is byte-identical to before.
    const piiCols = includePii ? undefined : this.piiColumns(this.tableMeta);
    const hasPii = piiCols !== undefined && piiCols.size > 0;
    if (omit) {
      if (Array.isArray(omit)) {
        throw new ValidationError(
          `[turbine] "omit" must be an object mapping field names to true ` +
            `(e.g. { createdAt: true }), not an array.`,
        );
      }
      // Include all columns except those where value is true (and PII columns).
      const omitCols = new Set(
        Object.entries(omit)
          .filter(([, v]) => v)
          .map(([k]) => this.toColumn(k)),
      );
      return this.tableMeta.allColumns.filter((col) => !omitCols.has(col) && !(hasPii && piiCols!.has(col)));
    }
    if (hasPii) {
      return this.tableMeta.allColumns.filter((col) => !piiCols!.has(col));
    }
    return null;
  }

  /**
   * The snake_case names of a table's PII-tagged (`defineSchema` `pii: true`)
   * columns. PII columns are excluded from default projections (findMany /
   * findUnique / relation subqueries / batched loads) unless the query opts in
   * via `includePii` or names the column explicitly in `select`. Returns an
   * empty set for any table with no PII column, so untagged schemas keep their
   * byte-identical SQL.
   */
  private piiColumns(meta: TableMetadata): Set<string> {
    const out = new Set<string>();
    for (const col of meta.columns) {
      if (col.pii) out.add(col.name);
    }
    return out;
  }

  /**
   * The camelCase field names of a table's PII-tagged columns: the read-side
   * counterpart of {@link piiColumns} applied to already-parsed entities.
   * Used to strip PII from a write's RETURNING/reselect row (writes accept no
   * `includePii`/`select`, so their returned row always applies the default
   * exclusion; you may still write PII fields freely).
   */
  private piiFields(meta: TableMetadata): string[] {
    const out: string[] = [];
    for (const col of meta.columns) {
      if (col.pii) out.push(col.field);
    }
    return out;
  }

  /**
   * The `RETURNING` / `OUTPUT` selection for a write on this table. A table with
   * no PII column returns `'*'` (every column — byte-identical SQL to before);
   * a table WITH PII columns returns an explicit quoted list of every non-PII
   * column so the PII values never leave the database on a write. A PII-tagged
   * PRIMARY KEY column is kept in the projection regardless (the returned row
   * must stay addressable): tag sensitive data, not keys — a PII PK is
   * documented out of scope for stripping. Writes accept no `select`/`includePii`
   * (unlike reads), so this is the whole write-return policy at the SQL level;
   * {@link parseWriteRow} remains as a defense-in-depth strip (a no-op once the
   * SQL already excludes the columns). Derived purely from static per-table
   * schema metadata, so the write SQL cache needs no extra key segment.
   */
  private writeReturningColumns(): ReturningSelection {
    const piiCols = this.piiColumns(this.tableMeta);
    if (piiCols.size === 0) return '*';
    const pk = new Set(this.tableMeta.primaryKey);
    return this.tableMeta.allColumns.filter((col) => !piiCols.has(col) || pk.has(col)).map((col) => this.q(col));
  }

  /**
   * String form of {@link writeReturningColumns} for a `SELECT` list (the
   * `'reselect'` result strategy re-fetches via a SELECT, not RETURNING).
   * `'*'` when there is no PII column; otherwise the comma-joined quoted list.
   */
  private writeReselectSelection(): string {
    const cols = this.writeReturningColumns();
    return cols === '*' ? '*' : cols.join(', ');
  }

  /**
   * Parse a write's returned row (create/update/upsert/delete), then strip the
   * table's PII fields: the write-side read policy. On PII-tagged tables the
   * statement's RETURNING/OUTPUT already omits these columns (see
   * {@link writeReturningColumns}), so this strip is defense-in-depth and a
   * no-op. Untagged tables incur only one `for` over a zero-length field list,
   * so behavior is unchanged.
   */
  private parseWriteRow(row: Record<string, unknown>): Record<string, unknown> {
    const parsed = this.parseRow(row, this.table);
    for (const field of this.piiFields(this.tableMeta)) {
      delete parsed[field];
    }
    return parsed;
  }

  /**
   * Reject any write against a view (H4). Views are introspected with
   * `isView: true` and are read-only in every engine; a write raises a
   * {@link ValidationError} (E003) rather than emitting SQL Postgres would
   * reject (or, worse, silently applying to an updatable view).
   */
  private assertWritable(operation: string): void {
    if (this.tableMeta.isView) {
      throw new ValidationError(
        `[turbine] Cannot ${operation} "${this.table}": it is a view (read-only). ` +
          'Views support reads (findMany/findFirst/…) but not writes.',
      );
    }
  }

  /**
   * Reject a write whose `data` names a `GENERATED ALWAYS AS (...) STORED`
   * column (H3). Postgres computes these from other columns and errors if you
   * try to write them; we fail early with a clear {@link ValidationError} (E003)
   * instead of surfacing a cryptic driver error. Undefined values are ignored
   * (they're stripped from the statement anyway).
   */
  private assertNoGeneratedColumns(data: Record<string, unknown>, operation: string): void {
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      const col = this.tableMeta.columns.find((c) => c.field === key || c.name === key || c.name === camelToSnake(key));
      if (col?.isGeneratedStored) {
        throw new ValidationError(
          `[turbine] Cannot ${operation} "${this.table}": column "${key}" is a GENERATED ALWAYS AS (…) STORED ` +
            'column whose value the database computes — remove it from your data.',
        );
      }
    }
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
    // Enum columns get an explicit `::"EnumName"` cast on their value bind
    // (see enumTypeForColumn); `''` everywhere else. Value-invariant, so the
    // SQL cache and collectSetParams are unaffected.
    const cast = this.enumCastSuffix(this.toColumn(key));

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
          return `${col} = ${this.p(params.length)}${cast}`;
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
    return `${col} = ${this.p(params.length)}${cast}`;
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

  private buildWhere(where: WhereClause<T>): { sql: string; params: unknown[] } {
    return whereMod.buildWhere(this.ctx, where);
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

  private targetGlobalFilterAlias(targetTable: string, alias: string, params: unknown[]): string {
    return whereMod.targetGlobalFilterAlias(this.ctx, targetTable, alias, params);
  }

  private collectTargetGlobalFilterAlias(targetTable: string, params: unknown[]): void {
    whereMod.collectTargetGlobalFilterAlias(this.ctx, targetTable, params);
  }

  private globalFilterCacheSegment(): string {
    return whereMod.globalFilterCacheSegment(this.ctx);
  }

  private userPredicateIsEmpty(userWhere: Record<string, unknown>): boolean {
    return whereMod.userPredicateIsEmpty(this.ctx, userWhere);
  }

  private assertMutationHasPredicate(
    operation: 'update' | 'updateMany' | 'delete' | 'deleteMany',
    whereSql: string,
    allowFullTableScan: boolean | undefined,
  ): void {
    whereMod.assertMutationHasPredicate(this.ctx, operation, whereSql, allowFullTableScan);
  }

  private buildWhereClause(where: Record<string, unknown>, params: unknown[]): string | null {
    return whereMod.buildWhereClause(this.ctx, where, params);
  }

  private pgTypeForColumn(meta: TableMetadata, column: string): string {
    return whereMod.pgTypeForColumn(this.ctx, meta, column);
  }

  private enumTypeForColumn(column: string): string | null {
    return whereMod.enumTypeForColumn(this.ctx, column);
  }

  private enumCastSuffix(column: string): string {
    return whereMod.enumCastSuffix(this.ctx, column);
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

  private collectAliasWhereParams(
    targetTable: string,
    targetMeta: TableMetadata,
    where: Record<string, unknown>,
    params: unknown[],
  ): void {
    whereMod.collectAliasWhereParams(this.ctx, targetTable, targetMeta, where, params);
  }

  private fingerprintAliasWhere(where: Record<string, unknown>, targetTable?: string): string {
    return whereMod.fingerprintAliasWhere(this.ctx, where, targetTable);
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

  private castJsonNumeric(extract: string): string {
    return whereMod.castJsonNumeric(this.ctx, extract);
  }

  private getColumnArrayType(column: string): string {
    return whereMod.getColumnArrayType(this.ctx, column);
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
      // Reserved `_count` key — fingerprint by the selected relation set so
      // `_count: true` and `_count: { posts: true }` never share a cache entry.
      if (relName === '_count') {
        const c = spec as unknown as WithCount;
        parts.push(
          c === true
            ? '_count(*)'
            : `_count(${Object.entries(c)
                .filter(([, v]) => v)
                .map(([k]) => k)
                .sort()
                .join(',')})`,
        );
        continue;
      }
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

      // where shape (value-invariant, operator-shape-aware: `{title: 'x'}` and
      // `{title: {contains: 'x'}}` emit different SQL so they must not share
      // a fingerprint)
      if (opts.where) {
        subParts.push(
          `w=${this.fingerprintAliasWhere(opts.where as Record<string, unknown>, meta.relations[relName]?.to)}`,
        );
      }

      // orderBy shape (OrderBySpec nulls placement changes the SQL, so fingerprint it)
      if (opts.orderBy) {
        const targetRels = this.schema.tables[relDef.to]?.relations;
        const oEntries = Object.entries(opts.orderBy).map(
          ([k, d]) => `${k}:${this.orderByEntryFingerprint(d, targetRels?.[k]?.to)}`,
        );
        subParts.push(`o=${oEntries.join(',')}`);
      }

      // limit presence, but on inline-pagination engines (MySQL) the literal
      // value is baked into the subquery SQL, so fingerprint the value there or
      // `{limit:3}` and `{limit:5}` would share one cached statement.
      if (opts.limit !== undefined) {
        subParts.push(this.dialect.inlineLimitOffset ? `l=${opts.limit}` : 'l=1');
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

    for (const [relName, relSpec] of sortedEntries(withClause)) {
      const relDef = meta.relations[relName];
      if (!relDef) continue;
      this.collectRelationSubqueryParams(relDef, relSpec, params, table ?? this.table);
    }

    // `_count` global-filter params — mirror buildSelectWithRelations, which
    // appends the count subqueries (and any target-filter params) AFTER every
    // relation subquery, in resolveCountRelations order.
    const countSpec = (withClause as { _count?: WithCount })._count;
    if (countSpec !== undefined) {
      for (const rel of resolveCountRelations(meta, countSpec)) {
        this.collectRelationCountParams(rel, params);
      }
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

    // A dialect that owns the whole subquery (buildRelationSubquery override,
    // SQL Server FOR JSON) compiles orderBy through its OWN paging clause -
    // plain directions only, no order params: so the native order-param
    // mirrors below must stay off for it (its documented contract remains
    // where → limit → nested).
    const nativeOrderPath = !this.dialect.buildRelationSubquery;

    // manyToMany param order mirrors buildManyToManySubquery:
    //   orderBy params → where params → limit param → nested-with params
    //   (always, both paths).
    if (relDef.type === 'manyToMany') {
      const m2mOrderEntries = spec.orderBy ? Object.entries(spec.orderBy).filter(([, dir]) => dir !== undefined) : [];
      if (nativeOrderPath && m2mOrderEntries.length > 0) {
        this.collectRelationOrderParams(targetTable, targetMeta, m2mOrderEntries, params);
      }
      if (spec.where) {
        this.collectAliasWhereParams(targetTable, targetMeta, spec.where as Record<string, unknown>, params);
      }
      this.collectTargetGlobalFilterAlias(targetTable, params);
      if (spec.limit !== undefined && !this.dialect.inlineLimitOffset) {
        params.push(Number(spec.limit));
      }
      if (spec.with) {
        for (const [nestedRelName, nestedSpec] of sortedEntries(spec.with)) {
          const nestedRelDef = targetMeta.relations[nestedRelName];
          if (!nestedRelDef) continue;
          this.collectRelationSubqueryParams(nestedRelDef, nestedSpec, params, 'alias', depth + 1);
        }
      }
      return;
    }

    // Mirrors buildRelationSubquery's willWrap: `orderBy: {}` is treated as absent.
    const relOrderEntries = spec.orderBy ? Object.entries(spec.orderBy).filter(([, dir]) => dir !== undefined) : [];
    const hasOrder = relOrderEntries.length > 0;
    const willWrap = relDef.type === 'hasMany' && (spec.limit !== undefined || hasOrder);

    // Non-wrapped path: nested relations BEFORE where/limit
    if (!willWrap && spec.with) {
      for (const [nestedRelName, nestedSpec] of sortedEntries(spec.with)) {
        const nestedRelDef = targetMeta.relations[nestedRelName];
        if (!nestedRelDef) continue;
        this.collectRelationSubqueryParams(nestedRelDef, nestedSpec, params, 'alias', depth + 1);
      }
    }

    // orderBy params (JSON paths / relation-order global filters): mirrors
    // buildRelationSubquery, which builds its ORDER BY terms BEFORE compiling
    // spec.where (both wrapped and non-wrapped paths).
    if (nativeOrderPath && hasOrder) {
      this.collectRelationOrderParams(targetTable, targetMeta, relOrderEntries, params);
    }

    // where params — mirrors buildAliasWhere push order
    if (spec.where) {
      this.collectAliasWhereParams(targetTable, targetMeta, spec.where as Record<string, unknown>, params);
    }

    // Global filter on the target — mirrors targetGlobalFilterAlias in
    // buildRelationSubquery (pushed after spec.where, before limit).
    this.collectTargetGlobalFilterAlias(targetTable, params);

    // limit param — only hasMany parameterizes its limit (mirrors
    // buildRelationSubquery). belongsTo/hasOne ignore limit (always LIMIT 1), so
    // pushing one here would orphan a param and desync the collect path.
    // `limit: 0` pushes (LIMIT 0 is honored), so check !== undefined.
    if (relDef.type === 'hasMany' && spec.limit !== undefined && !this.dialect.inlineLimitOffset) {
      params.push(Number(spec.limit));
    }

    // Wrapped path: nested relations AFTER where/limit (inside inner subquery)
    if (willWrap && spec.with) {
      for (const [nestedRelName, nestedSpec] of sortedEntries(spec.with)) {
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
  /**
   * Value-shape fingerprint for a single orderBy entry, so two queries whose
   * ORDER BY differs only in nulls placement, vector metric, or relation-count
   * vs relation-column never collide on one cached SQL string. Captures the
   * SQL-shaping bits (direction, nulls, metric, relation keys) — never values.
   */
  private orderByEntryFingerprint(d: unknown, targetTable?: string): string {
    // Vector KNN ordering changes the emitted operator by metric and adds a
    // `::vector` param, so metric + direction must be part of the cache key.
    if (isVectorOrderBy(d)) {
      return `vec(${d.distance.metric},${d.distance.direction ?? 'asc'})`;
    }
    // JSON-path ordering: direction, cast kind, and nulls placement change the
    // SQL text; the path itself is a bound param and stays OUT of the key.
    if (isJsonPathOrderBy(d)) {
      return `jp(${d.direction ?? 'asc'},${d.type === 'numeric' ? 'num' : 'text'},${d.nulls ?? ''})`;
    }
    // Pick-row relation ordering: the by-shape (column vs JSON path vs cast),
    // direction, nulls, pick.orderBy shape, and pick.where SHAPE are all SQL
    // text; the JSON paths and pick.where values are bound params and stay OUT
    // of the key. `targetTable` (the relation's target, resolved by the
    // caller) lets the pick.where fingerprint distinguish relation-filter
    // shapes inside it: two pick.wheres that differ only in shape must never
    // share one cached SQL string.
    if (isRelationPickOrderBy(d)) {
      const by =
        typeof d.by === 'string'
          ? `col=${JSON.stringify(d.by)}`
          : `jp(${JSON.stringify(d.by?.field)},${d.by?.type === 'numeric' ? 'num' : 'text'})`;
      const pickOrder = Object.entries(d.pick?.orderBy ?? {})
        .map(([k, v]) => `${k}:${this.orderByEntryFingerprint(v)}`)
        .join(',');
      const pickWhere = d.pick?.where
        ? `;pw=${this.fingerprintAliasWhere(d.pick.where as Record<string, unknown>, targetTable)}`
        : '';
      // Plan discriminator: the lateral plan emits DIFFERENT SQL (a FROM-clause
      // join + a qualified order term) so a warm cache must never serve one
      // plan's SQL for the other. Emitted ONLY for `'lateral'`: absent means
      // the default subquery plan, keeping every pre-existing cache key
      // byte-identical (no cold-cache churn on upgrade).
      const planTag = d.plan === 'lateral' ? ';plan=lat' : '';
      return `pick(${by},${d.direction ?? 'asc'},${d.nulls ?? ''};po=${pickOrder}${pickWhere}${planTag})`;
    }
    if (isOrderBySpec(d)) return `spec(${d.sort},${d.nulls ?? ''})`;
    if (d && typeof d === 'object') {
      // Relation ordering (`{ _count: 'desc' }` or `{ name: 'asc' }`).
      // INSERTION order, never sorted: the compile side (buildRelationOrderBy)
      // emits one ORDER BY term per entry in Object.entries order, so entry
      // order is SQL-shaping precedence. A sorted fingerprint made
      // `{ name: 'asc', email: 'desc' }` and the swapped literal share one
      // cached SQL string — silently mis-ordered results on a warm cache.
      return `rel(${Object.entries(d as Record<string, unknown>)
        .map(([k, v]) => `${k}=${this.orderByEntryFingerprint(v)}`)
        .join(',')})`;
    }
    return String(d);
  }

  private buildOrderBy(orderBy: OrderByClause, params?: unknown[], lateralSink?: string[]): string {
    // Dev-only: validate that orderBy fields exist in the table schema. Relation
    // orderBy keys (object values that are neither a vector nor an OrderBySpec)
    // are validated in the relation branch below, so skip them here.
    if (process.env.NODE_ENV !== 'production') {
      for (const [key, value] of Object.entries(orderBy)) {
        if (this.isRelationOrderByValue(value) && this.tableMeta.relations[key]) continue;
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
    let relOrdCounter = 0;
    return Object.entries(orderBy)
      .map(([key, value]) => {
        // Vector KNN ordering: { distance: { to, metric, direction? } }
        if (isVectorOrderBy(value)) {
          if (meta && !(key in meta.columnMap)) {
            throw new ValidationError(
              `[turbine] Unknown field "${key}" in orderBy on table "${this.table}". ` +
                `Known fields: ${Object.keys(meta.columnMap).join(', ') || '(none)'}.`,
            );
          }
          if (!params) {
            throw new ValidationError(
              `[turbine] Vector distance ordering on "${key}" is only supported in a top-level findMany orderBy.`,
            );
          }
          const rawColumn = this.toColumn(key);
          const operator = this.vectorOperator(key, rawColumn, value.distance.metric);
          const placeholder = this.pushVectorParam(key, rawColumn, value.distance.to, params);
          const safeDir = value.distance.direction?.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
          return `${this.q(rawColumn)} ${operator} ${placeholder} ${safeDir}`;
        }

        // JSON-path ordering: { path: [...], direction?, type?, nulls? } on a
        // json/jsonb column of THIS table. Path is bound as one text[] param.
        if (isJsonPathOrderBy(value)) {
          return this.buildJsonPathOrderEntry(this.table, this.tableMeta, key, value, '', params);
        }

        // Relation ordering: an object value that is not a vector or OrderBySpec,
        // keyed by a relation name (`{ posts: { _count: 'desc' } }` / `{ author:
        // { name: 'asc' } }`).
        if (this.isRelationOrderByValue(value)) {
          return this.buildRelationOrderBy(
            key,
            value as Record<string, unknown>,
            `ord${relOrdCounter++}`,
            params,
            undefined,
            lateralSink,
          );
        }

        // Scalar column ordering — a plain direction or an OrderBySpec (nulls).
        if (meta && !(key in meta.columnMap)) {
          throw new ValidationError(
            `[turbine] Unknown field "${key}" in orderBy on table "${this.table}". ` +
              `Known fields: ${Object.keys(meta.columnMap).join(', ') || '(none)'}.`,
          );
        }
        const { dir, nulls } = normalizeOrderBy(value as OrderDirection | OrderBySpec);
        return `${this.toSqlColumn(key)} ${dir}${this.nullsSuffix(nulls)}`;
      })
      .join(', ');
  }

  /**
   * True when an orderBy value is a relation-ordering object: a plain object
   * that is neither a vector KNN ordering nor an {@link OrderBySpec}. Its key
   * in the orderBy clause is a relation name.
   */
  private isRelationOrderByValue(value: unknown): boolean {
    return (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      !isVectorOrderBy(value) &&
      !isJsonPathOrderBy(value) &&
      !isOrderBySpec(value)
    );
  }

  /**
   * Render the ` NULLS FIRST` / ` NULLS LAST` suffix for a column ordering.
   * Only PostgreSQL and SQLite support the `NULLS FIRST/LAST` grammar — on any
   * other engine a caller asking for explicit nulls placement gets a clear
   * {@link UnsupportedFeatureError} (E017) instead of broken SQL.
   */
  private nullsSuffix(nulls: 'first' | 'last' | undefined): string {
    if (!nulls) return '';
    if (this.dialect.name !== 'postgresql' && this.dialect.name !== 'sqlite') {
      throw new UnsupportedFeatureError(
        'NULLS FIRST/LAST ordering',
        this.dialect.name,
        'Explicit nulls placement in orderBy is only available on PostgreSQL and SQLite.',
      );
    }
    return nulls === 'first' ? ' NULLS FIRST' : ' NULLS LAST';
  }

  /**
   * Resolve an orderBy key to its snake_case column via the table's columnMap
   * (camelToSnake fallback), throwing the SAME unknown-field E003 the top-level
   * where path uses. Shared by top-level JSON-path ordering and every nested
   * relation orderBy path so nested orderBy accepts exactly what top-level
   * accepts (the 0.30.x bug: nested orderBy skipped the columnMap and rejected
   * camelCase-named DB columns like "sortOrder").
   */
  private resolveOrderByColumn(table: string, meta: TableMetadata, key: string): string {
    const col = meta.columnMap[key] ?? camelToSnake(key);
    if (!meta.allColumns.includes(col)) {
      throw new ValidationError(
        `[turbine] Unknown field "${key}" in orderBy on table "${table}". ` +
          `Known fields: ${Object.keys(meta.columnMap).join(', ') || '(none)'}.`,
      );
    }
    return col;
  }

  /**
   * Validate a {@link JsonPathOrderBy} entry: column must exist AND be
   * json/jsonb, path must be a non-empty array of keys/indexes: and return
   * the resolved column. Shared by the SQL-build path
   * ({@link buildJsonPathOrderEntry}) and the cache-hit param-collect mirrors
   * so both always throw identically.
   */
  private validateJsonPathOrderBy(table: string, meta: TableMetadata, field: string, spec: JsonPathOrderBy): string {
    const col = this.resolveOrderByColumn(table, meta, field);
    if (
      spec.path.length === 0 ||
      spec.path.some((el) => typeof el !== 'string' && !(typeof el === 'number' && Number.isFinite(el)))
    ) {
      throw new ValidationError(
        `[turbine] JSON-path orderBy on "${field}" (table "${table}") requires a non-empty \`path\` array ` +
          `of keys/indexes (e.g. { path: ['weight'], direction: 'asc' }).`,
      );
    }
    const colType = this.pgTypeForColumn(meta, col);
    if (!this.isJsonColumnType(colType)) {
      throw new ValidationError(
        `[turbine] JSON-path orderBy on "${field}": column "${col}" on table "${table}" is not a JSON column ` +
          `(actual type: ${colType}).`,
      );
    }
    return col;
  }

  /**
   * Compile one {@link JsonPathOrderBy} entry:
   * `("col" #>> $n::text[])::numeric ASC`: the numeric cast only with
   * `type: 'numeric'` (default is text comparison), the extraction routed
   * through the dialect's JSON hook exactly like the JSON where-filters, the
   * path bound as ONE text[] param (mirrored by the order-param collectors).
   * `prefix` scopes the column (`''` top-level, `t0.` inside a relation
   * subquery).
   */
  private buildJsonPathOrderEntry(
    table: string,
    meta: TableMetadata,
    field: string,
    spec: JsonPathOrderBy,
    prefix: string,
    params?: unknown[],
  ): string {
    const col = this.validateJsonPathOrderBy(table, meta, field, spec);
    if (!params) {
      throw new ValidationError(`[turbine] JSON-path ordering on "${field}" is not supported in this orderBy context.`);
    }
    params.push(this.jsonPathParam(spec.path));
    const extract = this.dialect.buildJsonPathExtract(`${prefix}${this.q(col)}`, this.p(params.length));
    const lhs = spec.type === 'numeric' ? this.castJsonNumeric(extract) : extract;
    const dir = spec.direction?.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    // Rows whose document lacks the path extract to NULL. Without a nulls
    // clause, Postgres DESC defaults to NULLS FIRST, which both diverges from
    // pick-row ordering (NULLS LAST both directions since 0.33) and from
    // engines whose path ordering is nulls-last in both directions. Default to
    // NULLS LAST in BOTH directions unless the caller set `nulls` explicitly;
    // the grammar gate matches nullsSuffix.
    const nullsSql = spec.nulls
      ? this.nullsSuffix(spec.nulls)
      : this.dialect.name === 'postgresql' || this.dialect.name === 'sqlite'
        ? ' NULLS LAST'
        : '';
    return `${lhs} ${dir}${nullsSql}`;
  }

  /**
   * Compile a relation ordering term. For a to-many relation the only allowed
   * key is `_count`, which becomes a correlated `COUNT(*)` subquery. For a
   * to-one relation each entry names a target column and becomes a correlated
   * scalar subquery (supporting {@link OrderBySpec} nulls placement).
   *
   * Validation: relation must exist (E005); to-many only allows `_count`, and
   * to-one only allows real target columns (E003).
   *
   * `ctx` generalizes the term beyond the root table: inside a relation
   * subquery's orderBy the relations live on the TARGET table's metadata and
   * the correlation parent is the relation's alias, not `this.table`.
   */
  private buildRelationOrderBy(
    relName: string,
    value: Record<string, unknown>,
    alias: string,
    params?: unknown[],
    ctx?: { meta: TableMetadata; table: string; parentRef: string },
    lateralSink?: string[],
  ): string {
    const ownerMeta = ctx?.meta ?? this.tableMeta;
    const ownerTable = ctx?.table ?? this.table;
    const parentRef = ctx?.parentRef ?? this.table;
    const relDef = ownerMeta.relations[relName];
    if (!relDef) {
      throw new RelationError(
        `[turbine] Unknown relation "${relName}" in orderBy on table "${ownerTable}". ` +
          `Available: ${Object.keys(ownerMeta.relations).join(', ')}`,
      );
    }

    // Pick-row ordering (`{ pick, by }`): order by a value from ONE related
    // row: a correlated scalar subquery with its own ORDER BY … LIMIT 1.
    // Top-level findMany only (`ctx` present means we are inside a relation
    // subquery's orderBy) and hasMany only: validatePickOrderBy throws the
    // scope errors, shared with the cache-hit collect mirror.
    if (isRelationPickOrderBy(value)) {
      this.validatePickOrderBy(relName, relDef, value, ctx !== undefined);
      return this.buildRelationPickOrderBy(relName, relDef, value, alias, parentRef, params, lateralSink);
    }

    // To-many: only `_count` is meaningful → correlated COUNT(*) subquery.
    if (relDef.type === 'hasMany' || relDef.type === 'manyToMany') {
      const keys = Object.keys(value);
      if (keys.length !== 1 || keys[0] !== '_count') {
        throw new ValidationError(
          `[turbine] orderBy on to-many relation "${relName}" only supports "_count" ` +
            `or a pick-row ordering ({ pick, by }) (got: ${keys.join(', ') || '(empty)'}).`,
        );
      }
      const { dir } = normalizeOrderBy(value._count as OrderDirection);
      return `${this.buildRelationCountExpr(relDef, parentRef, alias, params)} ${dir}`;
    }

    // To-one: each entry orders by a correlated scalar subquery on a target column.
    const targetMeta = this.schema.tables[relDef.to];
    if (!targetMeta) throw new RelationError(`[turbine] Unknown relation target "${relDef.to}"`);
    const qTarget = this.q(relDef.to);
    const qParent = this.q(parentRef);
    // belongsTo: alias.referenceKey = parent.foreignKey; hasOne: reversed.
    const correlation =
      relDef.type === 'belongsTo'
        ? this.dialect.buildCorrelation(alias, relDef.referenceKey, qParent, relDef.foreignKey)
        : this.dialect.buildCorrelation(alias, relDef.foreignKey, qParent, relDef.referenceKey);

    const entries = Object.entries(value);
    if (entries.length === 0) {
      throw new ValidationError(`[turbine] orderBy on to-one relation "${relName}" needs at least one target column.`);
    }
    return entries
      .map(([col, dirValue]) => {
        // columnMap-first resolution (camelToSnake fallback): mirrors the
        // scalar orderBy path so camelCase-named DB columns resolve here too.
        const snakeCol = targetMeta.columnMap[col] ?? camelToSnake(col);
        if (!targetMeta.allColumns.includes(snakeCol)) {
          throw new ValidationError(
            `[turbine] Unknown column "${col}" in orderBy on relation "${relName}" (table "${relDef.to}").`,
          );
        }
        const { dir, nulls } = normalizeOrderBy(dirValue as OrderDirection | OrderBySpec);
        // Target's global filter applies here too — otherwise ordering keys off
        // a soft-deleted / other-tenant related row's value (matches the with
        // subquery semantics for belongsTo/hasOne).
        let where = correlation;
        if (params) {
          const gf = this.targetGlobalFilterAlias(relDef.to, alias, params);
          if (gf) where += ` AND ${gf}`;
        }
        return `(SELECT ${alias}.${this.q(snakeCol)} FROM ${qTarget} ${alias} WHERE ${where}${this.limitOneClause()}) ${dir}${this.nullsSuffix(nulls)}`;
      })
      .join(', ');
  }

  /**
   * Validate a {@link RelationPickOrderBy} entry's scope and shape. Shared by
   * the SQL-build path ({@link buildRelationPickOrderBy}) and the cache-hit
   * param-collect mirror ({@link collectRelationPickOrderParams}) so both
   * always throw identically:
   *
   *  - `nested` (inside a relation subquery's orderBy or a pick.orderBy):
   *    top-level findMany only in this release (E003),
   *  - manyToMany: not supported (E003 naming the limitation),
   *  - to-one: order by the target column directly instead (E003),
   *  - `pick.orderBy` is REQUIRED (deterministic row choice),
   *  - `by` must be a target column name or a `{ field, path }` JSON-path spec.
   */
  private pickOrderNestedError(relName: string): ValidationError {
    return new ValidationError(
      `[turbine] Pick-row ordering on relation "${relName}" is only supported in a top-level ` +
        'findMany orderBy: nested `with` orderBy does not support it.',
    );
  }

  private validatePickOrderBy(relName: string, relDef: RelationDef, spec: RelationPickOrderBy, nested: boolean): void {
    if (nested) {
      throw this.pickOrderNestedError(relName);
    }
    if (relDef.type === 'manyToMany') {
      throw new ValidationError(
        `[turbine] Pick-row ordering is not supported on manyToMany relation "${relName}": ` +
          'hasMany relations only.',
      );
    }
    if (relDef.type !== 'hasMany') {
      throw new ValidationError(
        `[turbine] Pick-row ordering is only for to-many (hasMany) relations; "${relName}" is ${relDef.type}. ` +
          `Order by the target column directly instead ({ ${relName}: { <column>: 'asc' } }).`,
      );
    }
    const pickOrder = spec.pick?.orderBy;
    if (
      typeof spec.pick !== 'object' ||
      spec.pick === null ||
      typeof pickOrder !== 'object' ||
      pickOrder === null ||
      Object.keys(pickOrder).length === 0
    ) {
      throw new ValidationError(
        `[turbine] Pick-row ordering on relation "${relName}" requires \`pick.orderBy\` to choose ONE ` +
          "related row deterministically (e.g. pick: { orderBy: { createdAt: 'desc' } }).",
      );
    }
    const by = spec.by;
    const validJsonBy = typeof by === 'object' && by !== null && typeof by.field === 'string' && Array.isArray(by.path);
    if (typeof by !== 'string' && !validJsonBy) {
      throw new ValidationError(
        `[turbine] Pick-row ordering on relation "${relName}" requires \`by\`: a target column name ` +
          "or a JSON-path spec ({ field: 'data', path: ['title'] }).",
      );
    }
    // Physical plan gate. A typo like `plan: 'latreal'` must never silently run
    // the subquery plan (a silent plan change wearing a validation gap). Shared
    // by build and cache-hit collect so a warmed cache throws identically.
    if (spec.plan !== undefined && spec.plan !== 'subquery' && spec.plan !== 'lateral') {
      throw new ValidationError(
        `[turbine] Pick-row ordering on relation "${relName}" has an invalid \`plan\`: ` +
          `${JSON.stringify(spec.plan)}. Use 'subquery' (default) or 'lateral'.`,
      );
    }
    if (spec.plan === 'lateral') {
      if (!this.dialect.supportsLateralJoin) {
        throw new UnsupportedFeatureError(
          "pick-row ordering with plan: 'lateral'",
          this.dialect.name,
          "LATERAL joins are only available on PostgreSQL. Omit `plan` (or use 'subquery').",
        );
      }
      // The lateral exposes one reserved output column, `__turbine_pick`. A
      // parent column with that exact name would make the unqualified WHERE
      // reference ambiguous once the join is in scope; refuse it explicitly.
      if (this.tableMeta.allColumns.includes('__turbine_pick')) {
        throw new ValidationError(
          `[turbine] Pick-row ordering with plan: 'lateral' cannot be used: table "${this.tableMeta.name}" ` +
            'has a column named "__turbine_pick", which the lateral join output reserves.',
        );
      }
    }
  }

  /**
   * Compile a {@link RelationPickOrderBy} term: a correlated scalar subquery
   * that picks ONE related row (`ORDER BY <pick.orderBy> LIMIT 1`, optionally
   * filtered by `pick.where` and the target's global filter) and surfaces one
   * value from it (a plain target column or a JSON-path extraction) as the
   * parent ORDER BY key:
   *
   * ```sql
   * (SELECT ord0."data" #>> $1::text[] FROM "versions" ord0
   *   WHERE ord0."instance_id" = "instances"."id" AND ord0."is_current" = $2
   *   ORDER BY ord0."created_at" DESC LIMIT 1) ASC NULLS LAST
   * ```
   *
   * Param-push order (mirrored EXACTLY by
   * {@link collectRelationPickOrderParams}): `by` JSON path (if any) →
   * target global filter → `pick.where` → `pick.orderBy` JSON paths.
   */
  private buildRelationPickOrderBy(
    relName: string,
    relDef: RelationDef,
    spec: RelationPickOrderBy,
    alias: string,
    parentRef: string,
    params?: unknown[],
    lateralSink?: string[],
  ): string {
    if (!params) {
      throw new ValidationError(
        `[turbine] Pick-row ordering on relation "${relName}" is only supported in a top-level findMany orderBy.`,
      );
    }
    const targetMeta = this.schema.tables[relDef.to];
    if (!targetMeta) throw new RelationError(`[turbine] Unknown relation target "${relDef.to}"`);

    const dir = spec.direction?.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const limitOne = this.buildPagination('1', undefined, true);
    // Parents with ZERO surviving related rows have no row to pick: the
    // correlated subquery yields NULL, and the LEFT JOIN LATERAL null-extends
    // its single row identically. Without a nulls clause, Postgres DESC
    // defaults to NULLS FIRST (every childless parent tops a "highest first"
    // sort). Default to NULLS LAST in BOTH directions (deterministic across
    // engines: SQLite's NULL-is-smallest default diverges from Postgres) unless
    // the caller set `nulls` explicitly; the grammar gate matches nullsSuffix.
    const nullsSql = spec.nulls
      ? this.nullsSuffix(spec.nulls)
      : this.dialect.name === 'postgresql' || this.dialect.name === 'sqlite'
        ? ' NULLS LAST'
        : '';

    // Lateral plan: splice a `LEFT JOIN LATERAL (... LIMIT 1) ON true` into the
    // FROM clause (via the sink) and order by its single reserved output column.
    // Param push order is IDENTICAL to the subquery plan (compilePickPieces is
    // shared), so the cache-hit collect mirror needs no changes. Scope +
    // capability were already enforced by validatePickOrderBy (shared with the
    // collect path); the missing-sink guard catches a non-findMany build
    // context and hard-fails rather than silently emitting a subquery.
    if (spec.plan === 'lateral') {
      if (!lateralSink) {
        throw new ValidationError(
          `[turbine] Pick-row ordering with plan: 'lateral' on relation "${relName}" is only supported ` +
            'in a top-level findMany orderBy.',
        );
      }
      const childAlias = `${alias}i`;
      const { byExpr, where, orderClause } = this.compilePickPieces(
        relDef,
        targetMeta,
        spec,
        childAlias,
        parentRef,
        params,
      );
      lateralSink.push(
        ` LEFT JOIN LATERAL (SELECT ${byExpr} AS ${this.q('__turbine_pick')} FROM ${this.q(relDef.to)} ${childAlias}` +
          ` WHERE ${where}${orderClause}${limitOne}) ${alias} ON true`,
      );
      return `${alias}.${this.q('__turbine_pick')} ${dir}${nullsSql}`;
    }

    // Subquery plan (default): a correlated scalar subquery in ORDER BY.
    const { byExpr, where, orderClause } = this.compilePickPieces(relDef, targetMeta, spec, alias, parentRef, params);
    return `(SELECT ${byExpr} FROM ${this.q(relDef.to)} ${alias} WHERE ${where}${orderClause}${limitOne}) ${dir}${nullsSql}`;
  }

  /**
   * Compile the shared inner pieces of a pick-row ordering against `childAlias`
   * (the table alias the related row is read from): the `by` value expression,
   * the correlation + target global filter + `pick.where` predicate, and the
   * `pick.orderBy` clause. Factored out of {@link buildRelationPickOrderBy} so
   * the subquery and lateral plans build IDENTICAL pieces in the SAME param
   * push order (`by` JSON path → target global filter → `pick.where` →
   * `pick.orderBy` JSON paths), which is why the collect mirror
   * ({@link collectRelationPickOrderParams}) is plan-agnostic.
   */
  private compilePickPieces(
    relDef: RelationDef,
    targetMeta: TableMetadata,
    spec: RelationPickOrderBy,
    childAlias: string,
    parentRef: string,
    params: unknown[],
  ): { byExpr: string; where: string; orderClause: string } {
    // The value surfaced from the picked row (SELECT list: its param binds first).
    let byExpr: string;
    if (typeof spec.by === 'string') {
      const col = this.resolveOrderByColumn(relDef.to, targetMeta, spec.by);
      byExpr = `${childAlias}.${this.q(col)}`;
    } else {
      const col = this.validateJsonPathOrderBy(relDef.to, targetMeta, spec.by.field, {
        path: spec.by.path,
      } as JsonPathOrderBy);
      params.push(this.jsonPathParam(spec.by.path));
      const extract = this.dialect.buildJsonPathExtract(`${childAlias}.${this.q(col)}`, this.p(params.length));
      byExpr = spec.by.type === 'numeric' ? this.castJsonNumeric(extract) : extract;
    }

    // Correlation to the parent row, then the target's global filter (a
    // soft-deleted / other-tenant row must never be picked: matches the
    // `with` subquery and to-one relation-orderBy semantics), then pick.where.
    let where = this.dialect.buildCorrelation(childAlias, relDef.foreignKey, this.q(parentRef), relDef.referenceKey);
    const gf = this.targetGlobalFilterAlias(relDef.to, childAlias, params);
    if (gf) where += ` AND ${gf}`;
    if (spec.pick.where) {
      const pickWhere = this.buildAliasWhere(relDef.to, targetMeta, childAlias, spec.pick.where, params);
      if (pickWhere) where += ` AND ${pickWhere}`;
    }

    // pick.orderBy: same surface as a relation `with` orderBy on the target
    // (plain columns, OrderBySpec nulls, JSON-path specs); a nested pick in
    // here routes back through buildRelationOrderBy with ctx set and throws
    // the top-level-only E003.
    const orderClause = this.buildRelationOrderClause(
      relDef.to,
      targetMeta,
      childAlias,
      Object.entries(spec.pick.orderBy),
      params,
    );
    return { byExpr, where, orderClause };
  }

  /**
   * Param-collect mirror of {@link buildRelationPickOrderBy}: re-runs the same
   * validation (a warmed cache can never skip it), then pushes in the same
   * order: `by` JSON path → target global filter → `pick.where` →
   * `pick.orderBy` JSON paths.
   */
  private collectRelationPickOrderParams(
    relName: string,
    relDef: RelationDef,
    spec: RelationPickOrderBy,
    params: unknown[],
  ): void {
    this.validatePickOrderBy(relName, relDef, spec, false);
    const targetMeta = this.schema.tables[relDef.to];
    if (!targetMeta) throw new RelationError(`[turbine] Unknown relation target "${relDef.to}"`);
    if (typeof spec.by === 'string') {
      this.resolveOrderByColumn(relDef.to, targetMeta, spec.by);
    } else {
      this.validateJsonPathOrderBy(relDef.to, targetMeta, spec.by.field, { path: spec.by.path } as JsonPathOrderBy);
      params.push(this.jsonPathParam(spec.by.path));
    }
    this.collectTargetGlobalFilterAlias(relDef.to, params);
    if (spec.pick.where) {
      this.collectAliasWhereParams(relDef.to, targetMeta, spec.pick.where, params);
    }
    this.collectRelationOrderParams(relDef.to, targetMeta, Object.entries(spec.pick.orderBy), params);
  }

  /**
   * Compile the ORDER BY terms of a relation `with` clause against the
   * relation's table alias. One unified path for every relation shape
   * (hasMany / manyToMany / belongsTo / hasOne) supporting exactly what the
   * top-level orderBy accepts at this level:
   *
   *  - scalar columns via columnMap resolution (camelToSnake fallback) with
   *    {@link OrderBySpec} nulls placement,
   *  - {@link JsonPathOrderBy} entries (path bound as one text[] param),
   *  - relation ordering on the TARGET's relations (`_count` for to-many, a
   *    target column for to-one), correlated to the relation alias,
   *  - vector KNN ordering stays top-level-only (E003, same as before).
   *
   * Param pushes (JSON paths, relation-order global filters) MUST be mirrored,
   * in the same order, by {@link collectRelationOrderParams}.
   */
  private buildRelationOrderClause(
    targetTable: string,
    targetMeta: TableMetadata,
    alias: string,
    orderEntries: [string, unknown][],
    params: unknown[],
  ): string {
    let relOrdCounter = 0;
    const orders = orderEntries
      .map(([key, dirValue]) => {
        if (isVectorOrderBy(dirValue)) {
          throw new ValidationError(
            `[turbine] Vector distance ordering on "${key}" is only supported in a top-level findMany orderBy.`,
          );
        }
        if (isJsonPathOrderBy(dirValue)) {
          return this.buildJsonPathOrderEntry(targetTable, targetMeta, key, dirValue, `${alias}.`, params);
        }
        if (this.isRelationOrderByValue(dirValue)) {
          return this.buildRelationOrderBy(
            key,
            dirValue as Record<string, unknown>,
            `${alias}ord${relOrdCounter++}`,
            params,
            { meta: targetMeta, table: targetTable, parentRef: alias },
          );
        }
        const col = this.resolveOrderByColumn(targetTable, targetMeta, key);
        const { dir, nulls } = normalizeOrderBy(dirValue as OrderDirection | OrderBySpec);
        return `${alias}.${this.q(col)} ${dir}${this.nullsSuffix(nulls)}`;
      })
      .join(', ');
    return ` ORDER BY ${orders}`;
  }

  /**
   * Param-collect mirror of {@link buildRelationOrderClause}: JSON-path
   * entries push their path (one text[] param each); relation-order entries
   * mirror {@link collectOrderByParams}' relation branch (count / to-one
   * global-filter params); scalar entries push nothing but re-run the same
   * column validation so a warmed cache can never skip it.
   */
  private collectRelationOrderParams(
    targetTable: string,
    targetMeta: TableMetadata,
    orderEntries: [string, unknown][],
    params: unknown[],
  ): void {
    for (const [key, dirValue] of orderEntries) {
      if (isVectorOrderBy(dirValue)) {
        throw new ValidationError(
          `[turbine] Vector distance ordering on "${key}" is only supported in a top-level findMany orderBy.`,
        );
      }
      if (isJsonPathOrderBy(dirValue)) {
        this.validateJsonPathOrderBy(targetTable, targetMeta, key, dirValue);
        params.push(this.jsonPathParam(dirValue.path));
        continue;
      }
      if (this.isRelationOrderByValue(dirValue)) {
        // Pick-row ordering is top-level-only: the build path throws the same
        // E003 (buildRelationOrderBy with ctx set), so the mirror must too.
        if (isRelationPickOrderBy(dirValue)) {
          throw this.pickOrderNestedError(key);
        }
        const relDef = targetMeta.relations[key];
        if (relDef && (relDef.type === 'hasMany' || relDef.type === 'manyToMany')) {
          this.collectRelationCountParams(relDef, params);
        } else if (relDef) {
          for (const _col of Object.keys(dirValue as Record<string, unknown>)) {
            this.collectTargetGlobalFilterAlias(relDef.to, params);
          }
        }
        continue;
      }
      this.resolveOrderByColumn(targetTable, targetMeta, key);
    }
  }

  /**
   * Build a correlated `(SELECT COUNT(*) …)` scalar subquery for a to-many
   * relation, correlated to `parentRef`. hasMany counts child rows via the FK;
   * manyToMany counts junction rows via the source key. Shared by the `_count`
   * `with` key and to-many relation orderBy.
   *
   * When `params` is supplied and the target has a global filter, it is
   * AND-merged so the count only sees surviving rows (a soft-deleted child is
   * not counted): hasMany filters the counted rows directly; manyToMany adds an
   * `EXISTS` on the target through the junction (the junction rows themselves
   * carry no filter). Params are mirrored by {@link collectRelationCountParams}.
   */
  private buildRelationCountExpr(relDef: RelationDef, parentRef: string, alias: string, params?: unknown[]): string {
    const qParent = this.q(parentRef);
    const count = this.castAgg('COUNT(*)', 'int');
    if (relDef.type === 'manyToMany') {
      if (!relDef.through) {
        throw new ValidationError(
          `[turbine] manyToMany relation "${relDef.name}" is missing its \`through\` junction.`,
        );
      }
      const qJ = this.q(relDef.through.table);
      const jalias = `${alias}j`;
      const sourceKeys = normalizeKeyColumns(relDef.through.sourceKey);
      const refKeys = normalizeKeyColumns(relDef.referenceKey);
      let where = sourceKeys
        .map((jc, i) => `${jalias}.${this.q(jc)} = ${qParent}.${this.q(refKeys[i]!)}`)
        .join(' AND ');
      if (params) {
        const targetExists = this.manyToManyTargetGlobalFilterExists(relDef, alias, jalias, params);
        if (targetExists) where += ` AND ${targetExists}`;
      }
      return `(SELECT ${count} FROM ${qJ} ${jalias} WHERE ${where})`;
    }
    // hasMany: child FK correlates to the parent reference key.
    const qTarget = this.q(relDef.to);
    let where = this.dialect.buildCorrelation(alias, relDef.foreignKey, qParent, relDef.referenceKey);
    if (params) {
      const gf = this.targetGlobalFilterAlias(relDef.to, alias, params);
      if (gf) where += ` AND ${gf}`;
    }
    return `(SELECT ${count} FROM ${qTarget} ${alias} WHERE ${where})`;
  }

  /**
   * `EXISTS (SELECT 1 FROM <target> <talias> WHERE <join> AND <gf>)` restricting
   * a manyToMany `_count` to targets that survive their global filter. `''` when
   * the target has no filter. Pushes gf params; mirror:
   * {@link collectManyToManyTargetGlobalFilter}.
   */
  private manyToManyTargetGlobalFilterExists(
    relDef: RelationDef,
    alias: string,
    jalias: string,
    params: unknown[],
  ): string {
    const gf = this.resolveGlobalFilter(relDef.to);
    if (!gf || !relDef.through) return '';
    const tMeta = this.schema.tables[relDef.to];
    if (!tMeta || tMeta.primaryKey.length === 0) return '';
    const talias = `${alias}t`;
    const targetKeys = normalizeKeyColumns(relDef.through.targetKey);
    const pk = tMeta.primaryKey;
    if (targetKeys.length !== pk.length) return '';
    const join = targetKeys.map((jc, i) => `${talias}.${this.q(pk[i]!)} = ${jalias}.${this.q(jc)}`).join(' AND ');
    const gfClause = this.buildAliasWhere(relDef.to, tMeta, talias, gf, params);
    const gfAnd = gfClause ? ` AND ${gfClause}` : '';
    return `EXISTS (SELECT 1 FROM ${this.q(relDef.to)} ${talias} WHERE ${join}${gfAnd})`;
  }

  /** Param-collect mirror of {@link manyToManyTargetGlobalFilterExists}. */
  private collectManyToManyTargetGlobalFilter(relDef: RelationDef, params: unknown[]): void {
    const gf = this.resolveGlobalFilter(relDef.to);
    if (!gf || !relDef.through) return;
    const tMeta = this.schema.tables[relDef.to];
    if (!tMeta || tMeta.primaryKey.length === 0) return;
    const targetKeys = normalizeKeyColumns(relDef.through.targetKey);
    if (targetKeys.length !== tMeta.primaryKey.length) return;
    this.collectAliasWhereParams(relDef.to, tMeta, gf, params);
  }

  /**
   * Param-collect mirror of {@link buildRelationCountExpr}'s global-filter
   * params (hasMany direct filter, or manyToMany EXISTS-on-target). Only pushes
   * when a filter applies — no-op otherwise.
   */
  private collectRelationCountParams(relDef: RelationDef, params: unknown[]): void {
    if (relDef.type === 'manyToMany') {
      this.collectManyToManyTargetGlobalFilter(relDef, params);
    } else {
      this.collectTargetGlobalFilterAlias(relDef.to, params);
    }
  }

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

  /** Parse a row that may contain JSON nested relation columns */
  private parseNestedRow(row: Record<string, unknown>, table: string): Record<string, unknown> {
    const parsed = this.parseRow(row, table);
    const meta = this.schema.tables[table];
    if (!meta) return parsed;

    // Assemble reserved `_count__<rel>` scalar columns into a `_count` object.
    // parseRow copies these unknown columns through under their raw key.
    let countObj: Record<string, number> | undefined;
    for (const key of Object.keys(parsed)) {
      if (key.startsWith('_count__')) {
        if (countObj === undefined) countObj = {};
        countObj[key.slice('_count__'.length)] = Number(parsed[key]);
        delete parsed[key];
      }
    }
    if (countObj) parsed._count = countObj;

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
   * Resolve the emitted column list for a relation, honoring `select` / `omit`.
   * Shared by {@link buildRelationSubquery} (json order) and
   * {@link buildRelationShape} (decode key order) so they can never diverge.
   */
  private resolveTargetColumns(spec: true | WithOptions, targetMeta: TableMetadata, includePii?: boolean): string[] {
    if (spec !== true && spec.select) {
      // Explicit `select` names the columns: a PII column named here IS the
      // opt-in and comes back regardless of the query's `includePii`.
      const selectedFields = Object.entries(spec.select)
        .filter(([, v]) => v)
        .map(([k]) => targetMeta.columnMap[k] ?? camelToSnake(k));
      return selectedFields.filter((col) => targetMeta.allColumns.includes(col));
    }
    // Default / omit-only relation projection: PII columns are excluded unless
    // the query opted in via `includePii`.
    const piiCols = includePii ? undefined : this.piiColumns(targetMeta);
    const hasPii = piiCols !== undefined && piiCols.size > 0;
    if (spec !== true && spec.omit) {
      const omittedFields = new Set(
        Object.entries(spec.omit)
          .filter(([, v]) => v)
          .map(([k]) => targetMeta.columnMap[k] ?? camelToSnake(k)),
      );
      return targetMeta.allColumns.filter((col) => !omittedFields.has(col) && !(hasPii && piiCols!.has(col)));
    }
    if (hasPii) {
      return targetMeta.allColumns.filter((col) => !piiCols!.has(col));
    }
    return targetMeta.allColumns;
  }

  /**
   * Render a single relation row's JSON: a keyed object (`'object'`) or a
   * positional array (`'positional'`). The array drops the keys but keeps the
   * exact expression order, so {@link RelationShape.keys} maps positions back.
   */
  private buildJsonRow(jsonPairs: [key: string, expr: string][]): string {
    if (this.jsonEncoding === 'positional') {
      // buildJsonArray is defined on postgresDialect; positional is gated to PG
      // in buildSelectWithRelations, so the `?? buildJsonObject` never fires.
      return (
        this.dialect.buildJsonArray?.(jsonPairs.map(([, expr]) => expr)) ?? this.dialect.buildJsonObject(jsonPairs)
      );
    }
    return this.dialect.buildJsonObject(jsonPairs);
  }

  /**
   * Build the top-level relation shapes for a `with` clause, mirroring
   * {@link buildSelectWithRelations}: same relation iteration order, same
   * per-relation column resolution, same nested recursion.
   */
  private buildRelationShapes(
    table: string,
    withClause: WithClause,
    includePii?: boolean,
  ): Record<string, RelationShape> {
    const meta = this.schema.tables[table];
    if (!meta) return {};
    const shapes: Record<string, RelationShape> = {};
    for (const [relName, relSpec] of sortedEntries(withClause)) {
      const relDef = meta.relations[relName];
      if (!relDef) continue; // buildSelectWithRelations already threw for this
      shapes[relName] = this.buildRelationShape(relDef, relSpec, meta, includePii);
    }
    return shapes;
  }

  /**
   * Recursively describe one relation's positional layout: the camelCase key
   * order (scalar columns first, then nested relation slots in the same order
   * {@link buildRelationSubquery} appends them), the nested sub-shapes, and the
   * cardinality (single object for belongsTo/hasOne, array for the rest).
   */
  private buildRelationShape(
    relDef: RelationDef,
    spec: true | WithOptions,
    parentMeta: TableMetadata,
    includePii?: boolean,
  ): RelationShape {
    void parentMeta;
    const targetMeta = this.schema.tables[relDef.to];
    if (!targetMeta) return { keys: [], nested: {}, cardinality: 'many' };
    const targetColumns = this.resolveTargetColumns(spec, targetMeta, includePii);
    const keys = targetColumns.map((col) => targetMeta.reverseColumnMap[col] ?? snakeToCamel(col));
    const nested: Record<string, RelationShape> = {};
    if (spec !== true && spec.with) {
      for (const [nestedRelName, nestedSpec] of sortedEntries(spec.with)) {
        const nestedRelDef = targetMeta.relations[nestedRelName];
        if (!nestedRelDef) continue;
        keys.push(nestedRelName);
        nested[nestedRelName] = this.buildRelationShape(nestedRelDef, nestedSpec, targetMeta, includePii);
      }
    }
    const cardinality: 'many' | 'one' = relDef.type === 'belongsTo' || relDef.type === 'hasOne' ? 'one' : 'many';
    return { keys, nested, cardinality };
  }

  /**
   * Build the row parser for a `with` clause. In object mode this is just
   * {@link parseNestedRow}. In positional mode it decodes each relation's
   * positional arrays into the object form first (shapes built once, not per
   * row), then delegates to parseNestedRow for date/snake-camel coercion.
   */
  private makeNestedParser(
    withClause: WithClause,
    includePii?: boolean,
  ): (row: Record<string, unknown>) => Record<string, unknown> {
    if (this.jsonEncoding !== 'positional') {
      return (row) => this.parseNestedRow(row, this.table);
    }
    const shapes = this.buildRelationShapes(this.table, withClause, includePii);
    return (row) => this.parseNestedRow(this.decodePositionalRelations(row, shapes), this.table);
  }

  /**
   * Return a shallow copy of a top-level row with each relation column decoded
   * from its positional array(s) into the object representation. Only relation
   * columns are positional — base scalar columns stay object-keyed — so the
   * result is exactly what the object encoding would have handed parseNestedRow.
   */
  private decodePositionalRelations(
    row: Record<string, unknown>,
    shapes: Record<string, RelationShape>,
  ): Record<string, unknown> {
    const cloned: Record<string, unknown> = { ...row };
    for (const [relName, shape] of Object.entries(shapes)) {
      if (relName in cloned) cloned[relName] = this.decodePositionalValue(cloned[relName], shape);
    }
    return cloned;
  }

  /**
   * Decode one relation's positional JSON value. `json_agg` returns the value as
   * a JSON string at the top level (JSON.parse once); nested relation slots are
   * already-parsed arrays. A `'many'` value is an array of positional arrays; a
   * `'one'` value is a single positional array or null.
   */
  private decodePositionalValue(raw: unknown, shape: RelationShape): unknown {
    let val = raw;
    if (typeof val === 'string') {
      try {
        val = JSON.parse(val);
      } catch {
        return raw; // parseNestedRow's warn path handles unparseable JSON
      }
    }
    if (val === null || val === undefined) {
      return shape.cardinality === 'many' ? [] : null;
    }
    if (shape.cardinality === 'many') {
      if (!Array.isArray(val)) return val;
      return val.map((inner) => this.decodePositionalObject(inner, shape));
    }
    return this.decodePositionalObject(val, shape);
  }

  /** Map one positional array back to a keyed object using the shape's key order. */
  private decodePositionalObject(arr: unknown, shape: RelationShape): unknown {
    if (!Array.isArray(arr)) return arr;
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < shape.keys.length; i++) {
      const key = shape.keys[i]!;
      const nestedShape = shape.nested[key];
      obj[key] = nestedShape ? this.decodePositionalValue(arr[i], nestedShape) : arr[i];
    }
    return obj;
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
    includePii?: boolean,
  ): string {
    const meta = this.schema.tables[table];
    if (!meta) throw new ValidationError(`[turbine] Unknown table "${table}"`);

    // Positional JSON encoding is Postgres-only in v1. Gate here — the single
    // entry point for every `with` clause — so no engine ever emits the
    // json_build_array shape its dialect can't produce (and mssql's FOR JSON
    // override path is never reached with positional active).
    if (this.jsonEncoding === 'positional' && this.dialect.name !== 'postgresql') {
      throw new UnsupportedFeatureError(
        "jsonEncoding: 'positional'",
        this.dialect.name,
        'Positional relation encoding is only available on PostgreSQL in this version.',
      );
    }

    const cols = columnsList ?? meta.allColumns;
    const qtbl = this.q(table);
    const baseCols = cols.map((col) => `${qtbl}.${this.q(col)}`).join(', ');

    const relationSelects: string[] = [];
    const aliasCounter = { n: 0 };

    for (const [relName, relSpec] of sortedEntries(withClause)) {
      // `_count` is a reserved key handled after the relation subqueries.
      if (relName === '_count') continue;
      const relDef = meta.relations[relName];
      if (!relDef) {
        throw new RelationError(
          `[turbine] Unknown relation "${relName}" on table "${table}". ` +
            `Available: ${Object.keys(meta.relations).join(', ')}`,
        );
      }

      // The main table is not aliased, so pass table name as parentRef
      const subquery = this.buildRelationSubquery(
        relDef,
        relSpec,
        params,
        table,
        aliasCounter,
        depth,
        path,
        includePii,
      );
      relationSelects.push(`(${subquery}) AS ${this.q(relName)}`);
    }

    // Reserved `_count` key → one correlated COUNT(*) scalar subquery per
    // selected to-many relation, aliased `_count__<rel>`. Appended after the
    // relation subqueries; the only params they can push come from a global
    // filter on the counted target (mirrored at the tail of collectWithParams).
    // Read via a cast so WithClause keeps its narrow `true | WithOptions` type.
    const countSpec = (withClause as { _count?: WithCount })._count;
    if (countSpec !== undefined) {
      for (const rel of resolveCountRelations(meta, countSpec)) {
        const expr = this.buildRelationCountExpr(rel, table, `t${aliasCounter.n++}`, params);
        relationSelects.push(`${expr} AS ${this.q(`_count__${rel.name}`)}`);
      }
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
    includePii?: boolean,
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

    // Dev-only: correlated relation loading probes the child table once per parent
    // row, so a missing FK index multiplies into per-parent full-table scans (a
    // batched-loader ORM pays the same missing index only once, which is why
    // schemas migrated from one often lack these). Name the exact index to create
    // instead of letting the slowness look like an ORM problem.
    if (process.env.NODE_ENV !== 'production') {
      const warnKey = `${relDef.from}.${relDef.name}`;
      if (!unindexedRelationWarned.has(warnKey)) {
        const miss = missingIndexForRelation(this.schema, relDef);
        if (miss) {
          unindexedRelationWarned.add(warnKey);
          console.warn(
            `[turbine] Relation "${relDef.name}" on "${relDef.from}" probes ` +
              `"${miss.table}"(${miss.columns.join(', ')}) which has no covering index — ` +
              `each parent row scans the full table. Fix: ${miss.createSql}; ` +
              'or run `npx turbine doctor` for a full report.',
          );
        }
      }
    }

    // Generate a unique alias: t0, t1, t2, ...
    const alias = `t${aliasCounter.n++}`;

    // Resolve which columns to include based on select/omit (and the query-level
    // `includePii` opt-in). Shared with the positional-shape builder so the
    // emitted json_build_array column order and the decode-side key order can
    // never drift apart.
    const targetColumns = this.resolveTargetColumns(spec, targetMeta, includePii);

    // Engine override seam (additive): a dialect whose JSON-aggregation shape does
    // not map onto buildJsonObject/buildJsonArrayAgg (SQL Server FOR JSON PATH) owns
    // the WHOLE subquery. Absent for PG/MySQL/SQLite → the native path below runs
    // unchanged (byte-identical output, all their tests stay green). The override
    // pushes params per the documented RelationSubqueryContext ordering contract,
    // which mirrors collectRelationSubqueryParams so the SQL cache / pipeline stay
    // in sync.
    if (this.dialect.buildRelationSubquery) {
      return this.dialect.buildRelationSubquery({
        relDef,
        spec,
        params,
        parentRef,
        alias,
        targetTable,
        targetMeta,
        targetColumns,
        depth: currentDepth,
        path: currentPath,
        quote: (name) => this.q(name),
        buildWhere: (whereAlias) =>
          (spec !== true && spec.where
            ? this.buildAliasWhere(targetTable, targetMeta, whereAlias, spec.where as Record<string, unknown>, params)
            : '') ?? '',
        recurse: (nRelDef, nSpec, nParent, nDepth, nPath) =>
          this.buildRelationSubquery(nRelDef, nSpec, params, nParent, aliasCounter, nDepth, nPath, includePii),
      });
    }

    // Build JSON object pairs for resolved columns
    const jsonPairs: [key: string, expr: string][] = targetColumns.map((col) => [
      targetMeta.reverseColumnMap[col] ?? snakeToCamel(col),
      `${alias}.${this.q(col)}`,
    ]);

    // Determine if this hasMany will take the wrapped subquery path (LIMIT or ORDER BY).
    // When wrapping, nested relations are built in the wrapped path referencing innerAlias,
    // so we must NOT build them here (they would push orphaned params).
    // An orderBy with no defined entries (`orderBy: {}`) is treated as absent —
    // it must neither trigger the wrap (dropping nested relations) nor render a
    // dangling `ORDER BY `. `limit: 0` is meaningful (LIMIT 0) and DOES wrap.
    const relOrderEntries =
      spec !== true && spec.orderBy ? Object.entries(spec.orderBy).filter(([, dir]) => dir !== undefined) : [];
    const willWrap =
      relDef.type === 'hasMany' && spec !== true && (spec.limit !== undefined || relOrderEntries.length > 0);

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
        includePii,
      );
    }

    // Nested relations — only in the non-wrapped path (wrapped path builds them separately)
    if (!willWrap && spec !== true && spec.with) {
      for (const [nestedRelName, nestedSpec] of sortedEntries(spec.with)) {
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
          includePii,
        );
        // Use '[]'::json for hasMany (empty array), NULL for belongsTo/hasOne (no object)
        const fallback =
          nestedRelDef.type === 'hasMany' ? this.dialect.emptyJsonArrayLiteral : this.dialect.nullJsonLiteral;
        jsonPairs.push([nestedRelName, this.dialect.wrapJsonSubresult(nestedSubquery, fallback)]);
      }
    }

    const jsonObj = this.buildJsonRow(jsonPairs);

    // Quote parent ref — can be a table name or auto-generated alias
    const qParent = this.q(parentRef);
    const qTarget = this.q(targetTable);

    // Build ORDER BY for json_agg: unified with the top-level orderBy surface
    // (columnMap resolution, OrderBySpec nulls, JSON-path, relation ordering).
    // Param pushes here land BEFORE the spec.where params, mirrored by
    // collectRelationSubqueryParams.
    let orderClause = '';
    if (relOrderEntries.length > 0) {
      orderClause = this.buildRelationOrderClause(targetTable, targetMeta, alias, relOrderEntries, params);
    }

    // Build WHERE — correlate to parent via parentRef (alias or table name).
    // For hasMany/hasOne: TARGET has the FK (RelationDef.foreignKey is always
    // the child-side column), so alias.fk = parentRef.pk. hasOne is just
    // hasMany with a unique FK — treating it like belongsTo here silently
    // correlated the wrong columns (caught dogfooding: uuid = varchar).
    // For belongsTo: SOURCE has the FK, so alias.pk = parentRef.fk (reversed).
    // Supports composite foreign keys (string[]) via buildCorrelation.
    let whereClause: string;
    if (relDef.type === 'belongsTo') {
      whereClause = this.dialect.buildCorrelation(alias, relDef.referenceKey, qParent, relDef.foreignKey);
    } else {
      whereClause = this.dialect.buildCorrelation(alias, relDef.foreignKey, qParent, relDef.referenceKey);
    }

    // Additional filters — full scalar where surface (equality, null, operator
    // objects, OR/AND/NOT), properly parameterized against this alias.
    if (spec !== true && spec.where) {
      const extra = this.buildAliasWhere(targetTable, targetMeta, alias, spec.where as Record<string, unknown>, params);
      if (extra) whereClause += ` AND ${extra}`;
    }

    // Global filter on the target table (soft-delete / tenancy) — AND-merged so
    // a `with` never surfaces filtered-out child rows. Pushed AFTER spec.where,
    // mirrored by collectRelationSubqueryParams.
    const gfExtra = this.targetGlobalFilterAlias(targetTable, alias, params);
    if (gfExtra) whereClause += ` AND ${gfExtra}`;

    // LIMIT — only meaningful for hasMany. A belongsTo / hasOne subquery returns
    // a single row (literal `LIMIT 1` below), so a `spec.limit` here must NOT push
    // a parameter: doing so orphans an untyped `$N` that the SQL never references,
    // which Postgres rejects with "could not determine data type of parameter $N"
    // (and shifts every later placeholder by one). To-one relations ignore limit.
    // `limit: 0` is honored (LIMIT 0 → empty array), so check !== undefined.
    let limitClause = '';
    if (relDef.type === 'hasMany' && spec !== true && spec.limit !== undefined) {
      limitClause = ` LIMIT ${this.paginationRef(spec.limit, params)}`;
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
          for (const [nestedRelName, nestedSpec] of sortedEntries(spec.with)) {
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
              includePii,
            );
            const fallback =
              nestedRelDef.type === 'hasMany' ? this.dialect.emptyJsonArrayLiteral : this.dialect.nullJsonLiteral;
            innerJsonPairs.push([nestedRelName, this.dialect.wrapJsonSubresult(nestedSub, fallback)]);
          }
        }
        const innerJsonObj = this.buildJsonRow(innerJsonPairs);
        return `SELECT ${this.dialect.buildJsonArrayAgg(innerJsonObj)} FROM (${innerSql}) ${innerAlias}`;
      }
      // Inline ORDER BY only when the dialect's array-agg supports it (PG). For
      // hasMany this path is reached only when there is no orderClause, so the
      // argument is `undefined` either way — keeping PG output byte-identical.
      const inlineOrder = this.dialect.aggSupportsInlineOrderBy ? orderClause.trim() || undefined : undefined;
      return `SELECT ${this.dialect.buildJsonArrayAgg(jsonObj, inlineOrder)} FROM ${qTarget} ${alias} WHERE ${whereClause}`;
    }

    // belongsTo / hasOne: return single object. An orderBy picks WHICH row
    // the LIMIT 1 keeps (deterministic hasOne over a non-unique FK): matching
    // the batched strategy, which orders its flat follow-up and takes bucket[0].
    return `SELECT ${jsonObj} FROM ${qTarget} ${alias} WHERE ${whereClause}${orderClause} LIMIT 1`;
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
    includePii?: boolean,
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

    // ORDER BY on the target rows: unified with the top-level orderBy surface
    // (columnMap resolution, OrderBySpec nulls, JSON-path, relation ordering).
    // `orderBy: {}` (no defined entries) is treated as absent: it must not
    // render a dangling `ORDER BY `. Param pushes here land BEFORE the
    // spec.where params, mirrored by collectRelationSubqueryParams' m2m branch.
    const relOrderEntries =
      spec !== true && spec.orderBy ? Object.entries(spec.orderBy).filter(([, dir]) => dir !== undefined) : [];
    let orderClause = '';
    if (relOrderEntries.length > 0) {
      orderClause = this.buildRelationOrderClause(targetTable, targetMeta, talias, relOrderEntries, params);
    }

    // Additional WHERE filters on the target — full scalar where surface,
    // properly parameterized against the target alias.
    if (spec !== true && spec.where) {
      const extra = this.buildAliasWhere(
        targetTable,
        targetMeta,
        talias,
        spec.where as Record<string, unknown>,
        params,
      );
      if (extra) whereClause += ` AND ${extra}`;
    }

    // Global filter on the target table (mirrors collectRelationSubqueryParams'
    // m2m branch: after spec.where, before limit).
    const gfExtra = this.targetGlobalFilterAlias(targetTable, talias, params);
    if (gfExtra) whereClause += ` AND ${gfExtra}`;

    // LIMIT — `limit: 0` is honored (LIMIT 0 → empty array)
    let limitClause = '';
    if (spec !== true && spec.limit !== undefined) {
      limitClause = ` LIMIT ${this.paginationRef(spec.limit, params)}`;
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
        for (const [nestedRelName, nestedSpec] of sortedEntries(spec.with)) {
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
            includePii,
          );
          const fallback =
            nestedRelDef.type === 'belongsTo' || nestedRelDef.type === 'hasOne'
              ? this.dialect.nullJsonLiteral
              : this.dialect.emptyJsonArrayLiteral;
          innerJsonPairs.push([nestedRelName, this.dialect.wrapJsonSubresult(nestedSub, fallback)]);
        }
      }
      const innerJsonObj = this.buildJsonRow(innerJsonPairs);
      return `SELECT ${this.dialect.buildJsonArrayAgg(innerJsonObj)} FROM (${innerSql}) ${innerAlias}`;
    }

    // Simple path: build the json object pairs directly off the target alias,
    // including any nested relations (correlated to the target alias).
    const jsonPairs: [key: string, expr: string][] = targetColumns.map((col) => [
      targetMeta.reverseColumnMap[col] ?? snakeToCamel(col),
      `${talias}.${this.q(col)}`,
    ]);
    if (spec !== true && spec.with) {
      for (const [nestedRelName, nestedSpec] of sortedEntries(spec.with)) {
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
          includePii,
        );
        const fallback =
          nestedRelDef.type === 'belongsTo' || nestedRelDef.type === 'hasOne'
            ? this.dialect.nullJsonLiteral
            : this.dialect.emptyJsonArrayLiteral;
        jsonPairs.push([nestedRelName, this.dialect.wrapJsonSubresult(nestedSub, fallback)]);
      }
    }
    const jsonObj = this.buildJsonRow(jsonPairs);
    return `SELECT ${this.dialect.buildJsonArrayAgg(jsonObj)} ${fromJoin} WHERE ${whereClause}`;
  }

  /**
   * Get the Postgres type for a column (e.g. 'jsonb', 'text', '_int4').
   * Used to detect JSONB/array columns for specialized operators.
   * Uses pre-computed Map for O(1) lookup instead of linear scan.
   */
}
