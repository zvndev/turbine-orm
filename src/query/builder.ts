/**
 * turbine-orm, Query builder
 *
 * Each table accessor (db.users, db.posts, etc.) returns a QueryInterface<T>
 * that builds parameterized SQL and executes it through the connection pool.
 *
 * Nested relations use json_build_object + json_agg subqueries for single-query
 * resolution, a PostgreSQL-native approach that eliminates N+1 query patterns.
 *
 * Schema-driven: all column names, types, and relations come from introspected
 * metadata, nothing is hardcoded.
 */

import type pg from 'pg';
import type { Dialect, StreamableConnection } from '../dialect.js';
import { postgresDialect } from '../dialect.js';
import { NotFoundError, TimeoutError, UnsupportedFeatureError, ValidationError, wrapPgError } from '../errors.js';
import { missingIndexForRelation, schemaHasIndexInfo } from '../index-advisor.js';
import {
  executeNestedCreate,
  executeNestedUpdate,
  hasRelationFields,
  type NestedWriteContext,
} from '../nested-write.js';
import type { RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';
import { normalizeKeyColumns, snakeToCamel } from '../schema.js';
import * as aggMod from './aggregates.js';
import {
  assertProjectionShape,
  type BatchedChildReader,
  defaultProjectionFields,
  includeKeysForBatching,
  loadRelationsBatched,
  neededParentKeyFields,
  type RelationLoadContext,
  rejectNestedPickOrder,
  resolveCountRelations,
  stripFields,
} from './batched-loader.js';
import { expandCompoundUniqueWhere } from './compound-unique.js';
import {
  isJsonPathOrderBy,
  isOrderBySpec,
  isRelationPickOrderBy,
  isVectorOrderBy,
  isWhereOperator,
  orderByEntries,
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
  GroupByResult,
  JsonPathOrderBy,
  OrderByClause,
  QueryResult,
  RelationLoadStrategy,
  RelationPickOrderBy,
  ResolvedSkipGlobalFilters,
  SkipGlobalFilters,
  TypedWithClause,
  UpdateArgs,
  UpdateManyArgs,
  UpsertArgs,
  WithClause,
  WithCount,
  WithOptions,
  WithOrderByObject,
} from './types.js';
import { resolveSkipGlobalFilters, resolveUnsafeFlag, UNSAFE, type Unsafe } from './types.js';
import {
  isTemporalInfinity,
  LRUCache,
  ownLookup,
  parseDbDate,
  resolveColumnName,
  type SqlCacheEntry,
  sqlToPreparedName,
  unknownFieldMessage,
} from './utils.js';
import { shouldWarnOnce, WARN_NS } from './warn-registry.js';
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
 * Marginal cost of keeping a to-one relation on the JOIN plan, per parent row.
 *
 * A to-one relation compiled into the join plan is a CORRELATED subquery: the
 * engine re-evaluates it once per parent row, so the join plan costs roughly
 * `AUTO_JOIN_PENALTY_MS_PER_ROW * parentRows` more CPU than one flat follow-up
 * query, no matter how well indexed the correlation column is. The batched plan
 * pays that back as a second statement, i.e. one extra round trip.
 *
 * Break-even is therefore, to a first approximation:
 *
 *     parentRows = roundTripMs / AUTO_JOIN_PENALTY_MS_PER_ROW
 *
 * Measured (PostgreSQL 17, hasOne over a UNIQUE FK, 10K-row parent table,
 * median of 15 reps per point) at two very different link speeds:
 *
 *   link                RTT      penalty/row   break-even   observed crossover
 *   ─────────────────── ──────── ───────────── ──────────── ──────────────────
 *   loopback TCP        0.118ms  0.000711ms    ~166-236     between 200 and 400
 *   +1ms/direction      2.683ms  0.000717ms    ~3744-3993   between 3000 and 5000
 *
 * The two things that matters most in that table: the per-row penalty is
 * essentially IDENTICAL across the two links (it is a property of the plan, not
 * the wire), while the break-even moved by 17x. So the break-even is a function
 * of the deployment's round-trip time and NOTHING ELSE that is knowable at plan
 * time. That is why this is expressed as a per-row cost and a round-trip time
 * rather than as a hard-coded row count: a row count tuned on a Unix socket is
 * off by ~20x for a cross-region deployment, and vice versa. Concretely, the
 * previously shipped flat `1000` was simultaneously too HIGH on loopback
 * (up to 1.44x slower than the better plan just under the cliff) and too LOW
 * over a 2.7ms link (1.26x slower just above it).
 */
export const AUTO_JOIN_PENALTY_MS_PER_ROW = 0.0007;

/**
 * Round-trip time assumed before this process has observed a real one, chosen
 * as a typical same-region managed-Postgres latency (app and database in one
 * region over TCP). It is stated as a LATENCY rather than a row count so the
 * assumption is visible and re-derivable: at
 * {@link AUTO_JOIN_PENALTY_MS_PER_ROW} it yields exactly the 1000-row default
 * this heuristic has always shipped, so an unmeasured process behaves exactly
 * as before.
 */
export const AUTO_ASSUMED_ROUND_TRIP_MS = 0.7;

/**
 * Default parent-row ceiling under which `'auto'` keeps a to-one relation on
 * the single-statement join plan: {@link AUTO_ASSUMED_ROUND_TRIP_MS} divided by
 * {@link AUTO_JOIN_PENALTY_MS_PER_ROW}. Used until the process has measured its
 * own round-trip time, and whenever measurement is unavailable.
 */
export const AUTO_TO_ONE_JOIN_MAX_ROWS = Math.round(AUTO_ASSUMED_ROUND_TRIP_MS / AUTO_JOIN_PENALTY_MS_PER_ROW);

/**
 * Clamps on the MEASURED threshold (an explicit `autoToOneJoinMaxRows` is an
 * instruction, not an estimate, and bypasses both).
 *
 * The lower clamp matters: on a very fast link the formula can drop the
 * threshold to a few dozen rows, and the sweep shows the join plan winning by
 * up to 1.83x on a handful of parent rows, where the second statement's fixed
 * cost dwarfs everything. Holding the floor at 100 rows keeps those small
 * queries on the join plan; the cost of doing so, in the band where batched has
 * just started to win, is under 1.2x. The upper clamp is a sanity bound for a
 * pathological latency reading (a 70ms measurement would otherwise ask for
 * 100K rows).
 */
export const AUTO_TO_ONE_JOIN_ROWS_MIN = 100;
export const AUTO_TO_ONE_JOIN_ROWS_MAX = 100_000;

/**
 * WHY THIS IS A CONFIGURED LATENCY AND NOT A MEASURED ONE.
 *
 * The obvious next step from the formula above is to have the client measure
 * its own round-trip time and derive the threshold at runtime. That was built
 * and benchmarked, and it is NOT what ships, for a reason worth recording so it
 * is not re-litigated blind:
 *
 * Every query's wall time is `roundTrip + serverWork`, and nothing in a
 * duration distinguishes the two. An all-time MINIMUM reads a lucky packet
 * (1.489ms on a link whose real per-statement cost was 2.862ms) and lands the
 * threshold at half the true break-even. A MEDIAN over recent durations is
 * accurate when the workload is cheap queries, but the workload being planned
 * for here is precisely the expensive one: in the verification sweep the ring
 * filled with 10-17ms relation queries, the estimate inflated, and `'auto'`
 * held an 8,000-row query on the join plan, 1.30x slower than the better plan,
 * WORSE than the fixed constant it replaced. Capping the median against a
 * multiple of the floor mitigates it but turns the whole thing into a pair of
 * magic numbers tuned against two synthetic links, which is the same mistake as
 * a socket-tuned row count wearing a different hat.
 *
 * Round-trip time is a deployment fact, not a runtime discovery: it is fixed by
 * where the app runs relative to the database, the operator knows it (or gets
 * it from one `ping`), and it does not change between queries. So it is
 * configuration. That also keeps plan selection deterministic, which matters
 * for a library whose documented guarantee is that the strategy changes the
 * plan and never the result.
 */

/**
 * The smallest plan-time parent-row bound at which `'auto'` moves a relation
 * `_count` on a PROVEN-UNINDEXED probe to the grouped follow-up. Deliberately
 * 2, i.e. "everything except a parent set provably bounded at one row".
 *
 * `_count` does NOT share the to-one break-even formula above, because its two
 * plans do not differ by a small per-row penalty. Writing S for one scan of the
 * child table and RTT for a round trip:
 *
 *     inline(N)  = N x S        (a correlated COUNT(*) per parent row; see
 *                                buildRelationCountExpr in relations.ts, the
 *                                inline form is NOT a grouped scan)
 *     batched(N) = S + RTT      (one `COUNT(*) ... GROUP BY fk` follow-up)
 *
 * so the crossover sits at `N = 1 + RTT/S` and, decisively, the two regrets are
 * not comparable in kind:
 *
 *   - choosing batched when inline would have won costs at most RTT, once, and
 *     ONLY at N = 1 (at N = 1 the difference is exactly RTT, and it shrinks to
 *     zero immediately after);
 *   - choosing inline when batched would have won costs (N - 1) x S, which is
 *     unbounded in the parent count.
 *
 * Measured on an UNINDEXED FK (PostgreSQL 16, 200K-row child table, 10K-row
 * parent table, median of 11 interleaved reps per point, loopback;
 * benchmarks/bench-count-strategy.ts):
 *
 *   parents      1      2      3      5     20     100     1000    10000
 *   inline    4.3ms  8.3ms 12.3ms 20.1ms 79.2ms 417.5ms   3.06s   31.06s
 *   batched   5.2ms  4.8ms  4.8ms  5.2ms  6.1ms  11.5ms   9.9ms   28.4ms
 *   winner   inline batched batched batched batched batched batched batched
 *   ratio     1.22x  1.73x  2.54x  3.84x 13.05x  36.42x 310.92x 1093.35x
 *
 * Inline wins exactly one cell, by 0.9ms, then loses the next by 1.73x and the
 * last by 1093x. A skewed child distribution (half the rows on ten parents)
 * moves nothing: same crossover at 2, same 1179x at 10,000. So the useful
 * threshold is not a tunable row count, it is the one row where inline provably
 * cannot lose. There is deliberately no config knob: the entire regret this rule
 * can produce is one round trip, which is less than any knob would be worth, and
 * `relationLoadStrategy: 'join'` already forces the single-statement plan.
 *
 * This applies ONLY to a probe the introspected index metadata PROVES unindexed.
 * An INDEXED `_count` stays inline at every size measured (inline wins 1.30x to
 * 2.06x from 1 to 10,000 parents, because the per-parent subquery collapses to
 * an index-only scan costing ~0.001ms), and the partition below never demotes
 * it.
 */
export const AUTO_COUNT_BATCH_MIN_PARENT_ROWS = 2;

/** One relation that `'auto'` moved off the join plan, with the reason (dev note). */
interface AutoEngaged {
  relation: string;
  /**
   * `'unindexed'`: a probe in the subtree has no covering index.
   * `'to-one-cardinality'`: a to-one relation on a potentially large parent set.
   */
  reason: 'unindexed' | 'to-one-cardinality';
  miss?: { table: string; columns: string[]; createSql: string };
}

/** The `'auto'` per-relation partition of one `with` clause. */
interface AutoSplit {
  joinWith: WithClause;
  batchedWith: WithClause;
  engaged: AutoEngaged[];
}

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

/**
 * Return `args` with any Prisma compound-unique selector in `args.where`
 * expanded to its column conjunction (see {@link expandCompoundUniqueWhere}).
 * Returns the same `args` reference when nothing expands, so untouched queries
 * are byte-identical. Generic so it serves every unique-`where` arg shape.
 */
function maybeExpandCompoundUnique<A extends { where?: unknown }>(meta: TableMetadata, args: A): A {
  const where = args.where as Record<string, unknown> | undefined;
  if (!where) return args;
  const expanded = expandCompoundUniqueWhere(meta, where);
  return expanded === where ? args : { ...args, where: expanded };
}

/**
 * Bridge the nested-write engine's table handles onto the privilege sentinel.
 *
 * `nested-write.ts` clears a `set` relation by calling
 * `updateMany({ where, data, allowFullTableScan: true })`: an INTERNAL,
 * fully-derived predicate (the parent's own FK match, guarded there against a
 * null reference key), not caller input, and the flag is what lets that
 * unconditional-looking statement through the empty-`where` guard. Since
 * `allowFullTableScan` now only accepts {@link UNSAFE}, that literal `true`
 * would throw and every nested `set` would fail.
 *
 * Rather than hand the nested-write engine the sentinel (which would put the
 * privilege value on a second, less obvious import path), the translation
 * happens HERE, at the single seam where core hands it a table accessor. The
 * rewrite is deliberately narrow: `updateMany` only, and only when the value is
 * exactly `true`, so nothing else about the call is touched and no other
 * operation gains an escape hatch.
 *
 * @internal Exported for its unit test; not part of the public surface.
 */
export function unlockNestedWriteTx<X extends { table(name: string): Record<string, unknown> }>(tx: X): X {
  const wrapped = {
    table(name: string): Record<string, unknown> {
      const handle = tx.table(name);
      // A Proxy rather than a copied object: the handle is a class instance
      // whose methods live on the prototype, so a spread would produce an
      // object with no methods, and re-listing them by hand would silently
      // drop any method added later.
      return new Proxy(handle, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (typeof value !== 'function') return value;
          const method = value as (args: Record<string, unknown>) => unknown;
          if (prop !== 'updateMany') return method.bind(target);
          return (args: Record<string, unknown>) =>
            method.call(target, args?.allowFullTableScan === true ? { ...args, allowFullTableScan: UNSAFE } : args);
        },
      });
    },
  };
  return wrapped as unknown as X;
}

/**
 * Whether a relation `with`-clause `orderBy` carries no actual ordering: an
 * empty array, or an object with no non-`undefined` own keys. Used by
 * {@link QueryInterface.applyStableRelationOrder} so an explicit (non-empty)
 * orderBy is never overwritten while an empty `{}` / `[]` still gets the
 * synthesized PK order.
 */
function isEmptyOrderBy(orderBy: unknown): boolean {
  if (Array.isArray(orderBy)) return orderBy.length === 0;
  if (orderBy && typeof orderBy === 'object') {
    return Object.values(orderBy as Record<string, unknown>).every((v) => v === undefined);
  }
  return orderBy === undefined || orderBy === null;
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
  TemporalInfinityReading,
} from './deferred.js';

import type {
  DeferredQuery,
  MiddlewareFn,
  QueryInterfaceOptions,
  ReselectExecutor,
  TemporalInfinityReading,
} from './deferred.js';

// biome-ignore lint/complexity/noBannedTypes: {} means "no relations known", intentional for untyped table access
export class QueryInterface<T extends object, R extends object = {}> {
  private readonly tableMeta: TableMetadata;
  /**
   * SQL template cache: cacheKey → SqlCacheEntry (sql + prepared statement name).
   * Capacity is set once in the constructor from `options.sqlCacheSize`
   * (default 1000). See {@link QueryInterfaceOptions.sqlCacheSize}.
   */
  private readonly sqlTemplateCache: LRUCache<string, SqlCacheEntry>;
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
  private readonly scopedConnect: boolean;
  private readonly utcTimestamps: boolean;
  /**
   * How a Postgres temporal `infinity` / `-infinity` is handed back:
   * `'preserve'` (default) or `'null'`. See {@link TemporalInfinityReading}
   * for the trade, and {@link parseRow} for where it is applied.
   */
  private readonly temporalInfinity: TemporalInfinityReading;
  /** Whether `temporalInfinity` was left unset, i.e. the warning still applies. */
  private readonly warnTemporalInfinityUnset: boolean;
  private readonly preparedStatementsEnabled: boolean;
  /**
   * Whether the SQL template cache is active. Set once in the constructor.
   * Mutable (not `readonly`) only so {@link withSqlCacheDisabled} can flip it
   * off around a single synchronous compile (see {@link explain}).
   */
  private sqlCacheEnabled: boolean;
  private readonly dialect: Dialect;
  /**
   * Client-level default relation-loading strategy. When nothing is configured
   * this is `'auto'` (the implicit default): per-relation, keep the single-
   * statement join unless the introspected metadata proves a probe is unindexed,
   * in which case that relation falls back to the batched loader. An explicit
   * `'join'`/`'batched'` (client or query level) always wins.
   */
  private readonly relationLoadStrategy: RelationLoadStrategy;
  /** Client-level default for {@link applyStableRelationOrder} (off unless configured). */
  private readonly stableRelationOrder: boolean;
  /**
   * Client-level opt-in: apply an implicit primary-key ascending `ORDER BY` to a
   * `findMany` that paginates (`limit`/`take`/`offset`) but declares no
   * `orderBy`. OFF by default in core, see {@link applyImplicitPkOrdering}.
   */
  private readonly implicitPkOrdering: boolean;
  /**
   * Explicitly configured parent-row ceiling for the `'auto'` to-one rule, or
   * `undefined` to derive it from the observed round-trip time. See
   * {@link autoToOneThreshold}.
   */
  private readonly autoToOneJoinMaxRowsOption: number | undefined;
  /**
   * Deployment round-trip time in milliseconds, from which the to-one threshold
   * is derived. See {@link autoToOneThreshold}.
   */
  private readonly autoRoundTripMs: number | undefined;
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
   * the user is not spammed once per row. Per-instance state, each
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
   * (ColumnMetadata.pgTypeSchema is recorded only in that case), such columns
   * must never receive this schema's `::"enum"` cast (see enumTypeForColumn).
   */
  private readonly crossSchemaTypeColumns: Set<string>;

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

  /** Original options reference, forwarded to child QIs in nested writes. */
  private readonly options?: QueryInterfaceOptions;

  /** Set by executeWithMiddleware so queryWithTimeout can include it in events. */
  private currentAction = 'raw';

  /**
   * Tags the query events of an in-flight `relationLoadStrategy: 'auto'` query
   * that engaged the batched fallback (`'auto-batched'`), so observability sees
   * which queries the auto default re-planned. Same transient-instance-state
   * caveat as {@link currentAction}: set for the whole auto-split operation and
   * cleared afterward; a concurrent unrelated query on the same accessor during
   * that window could read it (a best-effort diagnostic tag, not load-bearing).
   */
  private currentStrategyTag: 'auto-batched' | undefined;

  /**
   * The active query's `skipGlobalFilters` opt-out, set at the top of each
   * `build*` method and read deep in the (synchronous) SQL-build + param-collect
   * tree, so relation subqueries, relation filters, `_count`, and relation
   * `orderBy` all see it without threading it through dozens of signatures.
   * Only load-bearing when {@link globalFilters} is configured; build+collect are
   * synchronous per call, so this transient is never observed across an await.
   *
   * Holds the RESOLVED form ({@link ResolvedSkipGlobalFilters}), never the raw
   * arg: every assignment goes through `resolveSkipGlobalFilters`, which is
   * where a non-sentinel value (`true`, `['users']`, anything a JSON body can
   * carry) is refused. Keeping the raw value here would push that decision out
   * to each reader, and one reader forgetting it is the whole bug class.
   */
  private currentSkip: ResolvedSkipGlobalFilters | undefined;

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
    // Per-table maps accept BOTH key forms, the snake_case table name
    // (`user_profiles`) and the camelCase accessor (`userProfiles`), since
    // users naturally key by the accessor they type everywhere else. The
    // snake_case entry wins when both are present.
    const warnOpt = options?.warnOnUnlimited;
    this.warnOnUnlimited =
      typeof warnOpt === 'object' && warnOpt !== null
        ? (warnOpt[table] ?? warnOpt[snakeToCamel(table)]) !== false
        : warnOpt !== false;
    this.scopedConnect = options?.scopedConnect === true;
    this.utcTimestamps = options?.utcTimestamps !== false;
    // Unset resolves to `'preserve'`. `'null'` destroys data: it makes a stored
    // infinity indistinguishable from a stored NULL, so the ordinary
    // read-modify-write (`update({ data: { ...row } })`) stores SQL NULL over a
    // nullable temporal column and the infinity is gone with no error, measured
    // on a live server. A lossy default is the wrong price for a nicer
    // `JSON.stringify`, so the lossless reading is the default and `'null'`
    // stays available as an explicit opt-in.
    this.temporalInfinity = options?.temporalInfinity === 'null' ? 'null' : 'preserve';
    // The warning exists to surface an UNACKNOWLEDGED trade. Naming either
    // reading in the config is the acknowledgement, so it stops.
    this.warnTemporalInfinityUnset = options?.temporalInfinity === undefined;
    this.preparedStatementsEnabled = options?.preparedStatements ?? true;
    // SQL template cache capacity. `sqlCacheSize: 0` disables caching entirely
    // (mirrors `sqlCache: false`); any positive integer sets the LRU bound;
    // undefined keeps the historical 1000-entry default. A negative value is
    // treated as the default rather than throwing.
    const sqlCacheSize = options?.sqlCacheSize;
    this.sqlCacheEnabled = options?.sqlCache !== false && sqlCacheSize !== 0;
    this.sqlTemplateCache = new LRUCache<string, SqlCacheEntry>(
      sqlCacheSize !== undefined && sqlCacheSize > 0 ? Math.floor(sqlCacheSize) : 1000,
    );
    this.dialect = options?.dialect ?? postgresDialect;
    this.relationLoadStrategy = options?.relationLoadStrategy ?? 'auto';
    this.stableRelationOrder = options?.stableRelationOrder === true;
    this.implicitPkOrdering = options?.implicitPkOrdering === true;
    const autoToOne = options?.autoToOneJoinMaxRows;
    this.autoToOneJoinMaxRowsOption =
      autoToOne !== undefined && Number.isFinite(autoToOne) && autoToOne >= 0 ? Math.floor(autoToOne) : undefined;
    const rtt = options?.autoRoundTripMs;
    this.autoRoundTripMs = rtt !== undefined && Number.isFinite(rtt) && rtt > 0 ? rtt : undefined;
    this.jsonEncoding = options?.jsonEncoding ?? 'object';
    // Only retain the map when it has at least one entry, so `globalFilters`
    // stays `undefined` (and every merge path a no-op) for the common case.
    this.globalFilters =
      options?.globalFilters && Object.keys(options.globalFilters).length > 0 ? options.globalFilters : undefined;
    this.txScoped = options?._txScoped ?? false;
    this.options = options;

    // Pre-compute column type lookup maps (TASK-26)
    //
    // Metadata can carry a column's database type in EITHER of two places: on
    // the column entry (`dialectType` / `pgType`, what introspection and
    // `turbine generate` emit) or in the table-level `dialectTypes` / `pgTypes`
    // maps. Reading only the column entry is not a harmless miss for metadata
    // that populates just the table-level maps: an unresolved type makes
    // `coerceWriteValue` return a bound `Date` by identity, so a zone-less
    // `date` / `timestamp` column stores the PROCESS's local calendar fields
    // (and, because the read path pins UTC, a turbine-only round trip hides
    // it). Consult both, column entry first. This costs one extra own-property
    // lookup per column ONCE per QueryInterface, nothing per query.
    this.columnPgTypeMap = new Map();
    this.columnArrayTypeMap = new Map();
    this.crossSchemaTypeColumns = new Set();
    const tableDialectTypes = this.tableMeta.dialectTypes;
    const tablePgTypes = this.tableMeta.pgTypes;
    for (const col of this.tableMeta.columns) {
      const dbType =
        col.dialectType ??
        col.pgType ??
        (tableDialectTypes && ownLookup(tableDialectTypes, col.name)) ??
        (tablePgTypes && ownLookup(tablePgTypes, col.name));
      if (dbType !== undefined) this.columnPgTypeMap.set(col.name, dbType);
      // The array map has the same shape of gap, but TableMetadata carries NO
      // table-level array-type map (only `dialectTypes` / `pgTypes`), so there
      // is nothing to fall back to. Deriving one from the resolved base type
      // would invent an UNNEST cast the metadata never declared, so the column
      // entry stays the only source.
      const arrayType = col.arrayType ?? col.pgArrayType;
      if (arrayType !== undefined) this.columnArrayTypeMap.set(col.name, arrayType);
      if (col.pgTypeSchema !== undefined) this.crossSchemaTypeColumns.add(col.name);
    }
    this.warnUntypedColumns();

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
      // The `utcTimestamps: false` opt-out has to reach the write/where web:
      // omitting it here left `qi.utcTimestamps` undefined for the whole
      // module, where `!== false` reads as opted IN, so the write side ignored
      // the flag and rewrote binds the caller had opted out of.
      //
      // This half of the flag is PER CLIENT. The read half is not: it is the
      // pg type parsers for OIDs 1114 / 1082 / 1115 / 1182, which
      // `pg.types.setTypeParser` installs once
      // per process. Two clients in one process therefore cannot hold
      // different values, and TurbineClient refuses the second one rather than
      // building a client whose writes and reads disagree (see
      // `assertUtcTimestampsAgree` in client.ts).
      utcTimestamps: this.utcTimestamps,
      // Reaches aggregates.ts, where `_min` / `_max` are assembled from the raw
      // row and so need the same infinity reading as `parseRow`.
      temporalInfinity: this.temporalInfinity,
      crossSchemaTypeColumns: this.crossSchemaTypeColumns,
      get currentSkip(): ResolvedSkipGlobalFilters | undefined {
        return self.currentSkip;
      },
      set currentSkip(v: ResolvedSkipGlobalFilters | undefined) {
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
      paginationRef: (value: unknown, params: unknown[], arg: string) => this.paginationRef(value, params, arg),
      paginationValue: (value: unknown, arg: string) => this.paginationValue(value, arg),
    };
  }

  /**
   * Dev-only, once per table: the columns whose database type is absent from
   * BOTH the column entry and the table-level type maps, the residual case
   * after the two-source resolution above.
   *
   * The set is deliberately every untyped column, not the `dateColumns`
   * members. An unresolved type is precisely the state in which Turbine cannot
   * say WHICH kind of column it is, so restricting the scan to `dateColumns`
   * got it wrong in both directions: that set carries `timestamptz` (whose
   * bind was never affected, since binding the `Date` is the correct thing to
   * do for it) and omits `time` / `timetz` entirely (deliberately, see
   * `timeOfDayKind` in schema.ts), which is the one kind that fails LOUDLY
   * rather than silently. The message therefore names the columns and states
   * what each kind does, rather than asserting a kind it cannot know.
   *
   * What is actually at stake per kind, all of it `coerceWriteValue` returning
   * the bound `Date` by identity for want of a type:
   *   - zone-less `date` / `timestamp`: the driver serializes with the
   *     PROCESS's offset, so the column stores local calendar fields. Nothing
   *     surfaces at runtime, and a turbine-only round trip reads the same value
   *     back (the read path shifts by the same offset), so only an outside
   *     reader sees the drift.
   *   - `time` / `timetz`: the driver serializes a full ISO timestamp, which
   *     Postgres rejects with `22007 invalid input syntax for type time`.
   *   - `timestamptz` and every non-temporal type: unaffected.
   *
   * PostgreSQL only: the UTC bind rewrite is Postgres-gated (see
   * `utcDateTimeWrites` in writes.ts), so on the other engines a missing type
   * changes nothing about how a `Date` is bound. Suppressed under
   * `NODE_ENV=production` like the other dev diagnostics and deduped through
   * the shared registry, so a hot table logs one line for the process.
   *
   * Cannot throw on odd metadata: it walks `tableMeta.columns`, the array the
   * constructor loop above has already iterated (and that client.ts validates
   * as an array), never `dateColumns`, which is a `Set` in every first-party
   * metadata path but arrives as a plain object from JSON-round-tripped
   * metadata. A dev-only diagnostic that crashes a shape production would serve
   * is worse than the bug it reports.
   */
  private warnUntypedColumns(): void {
    if (process.env.NODE_ENV === 'production') return;
    if (this.dialect.name !== 'postgresql') return;
    const untyped: string[] = [];
    for (const col of this.tableMeta.columns) {
      if (this.columnPgTypeMap.get(col.name) === undefined) untyped.push(col.name);
    }
    if (untyped.length === 0) return;
    if (!shouldWarnOnce(WARN_NS.untypedDateColumn, this.table)) return;
    // Bound the line on a wide table: the fix is per table, not per column, so
    // the first few names are enough to recognize the metadata that produced it.
    const MAX_NAMED = 12;
    const named = untyped.slice(0, MAX_NAMED).join(', ');
    const rest = untyped.length > MAX_NAMED ? ` (+${untyped.length - MAX_NAMED} more)` : '';
    console.warn(
      `[turbine] table "${this.table}": no database type in metadata for column(s) ${named}${rest} (neither the ` +
        "column entry's `dialectType`/`pgType` nor the table-level `dialectTypes`/`pgTypes` map). Turbine cannot " +
        'tell which of them are zone-less, so it skips the UTC bind rewrite and a `Date` goes to the driver ' +
        "as-is: right for `timestamptz`, but a zone-less `date`/`timestamp` then stores the PROCESS's local " +
        'calendar fields rather than UTC (silently, since the read path shifts back by the same offset), and a ' +
        '`time`/`timetz` column rejects the value outright (`22007 invalid input syntax for type time`). ' +
        'Columns whose type IS resolved, every `timestamptz` among them, are unaffected. Fix: regenerate with ' +
        '`npx turbine generate`, or set the column types in `defineSchema`.',
    );
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
   * Param-push order (limit before offset) is owned by the caller and unchanged -
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
   * Coerce a LIMIT/OFFSET argument and validate it as a non-negative safe
   * integer. Numeric strings (`'5'`) coerce; everything else (`NaN`, a
   * non-numeric string, a negative, a fractional or out-of-safe-range number)
   * throws {@link ValidationError} (E003) naming the argument and the table.
   *
   * This runs on EVERY pagination path, parameterized as well as inlined: a
   * bound `NaN` serializes as SQL NULL, and Postgres reads `LIMIT NULL` as
   * "no limit", so an unvalidated value silently turns a paginated query into
   * a full-table read (and a bad OFFSET silently disappears).
   */
  private paginationValue(value: unknown, arg: string): number {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new ValidationError(
        `[turbine] ${arg} on "${this.table}" must be a non-negative integer, received: ${String(value)}`,
      );
    }
    return n;
  }

  /**
   * Validate a LIMIT/OFFSET value as a non-negative integer and return it as an
   * inline SQL literal. Used only on `dialect.inlineLimitOffset` engines (MySQL).
   * The input is always a Turbine-controlled pagination value, never a raw user
   * string, and this guard guarantees the output is `String` of a validated
   * integer, so inlining cannot inject SQL.
   */
  private limitOffsetLiteral(value: unknown, arg: string): string {
    return String(this.paginationValue(value, arg));
  }

  /**
   * Resolve a LIMIT/OFFSET value to either an inline literal (no param pushed, on
   * `dialect.inlineLimitOffset` engines) or a bound placeholder (the value is
   * pushed to `params`). Build and collect paths both gate on the same flag so
   * the param order stays mirrored; PG/SQLite/SQL Server keep parameterizing and
   * stay byte-identical.
   */
  private paginationRef(value: unknown, params: unknown[], arg: string): string {
    if (this.dialect.inlineLimitOffset) {
      return this.limitOffsetLiteral(value, arg);
    }
    params.push(this.paginationValue(value, arg));
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
   * arg wins, then the client-level default, then `'auto'`. Only meaningful when
   * a `with` clause is present; the callers gate on that.
   */
  private resolveLoadStrategy(argStrategy: RelationLoadStrategy | undefined): RelationLoadStrategy {
    return argStrategy ?? this.relationLoadStrategy;
  }

  /**
   * The effective {@link QueryInterfaceOptions.stableRelationOrder} for a query:
   * the per-query arg wins, then the client-level default (off).
   */
  private resolveStableOrder(argFlag: boolean | undefined): boolean {
    return argFlag ?? this.stableRelationOrder;
  }

  /**
   * Fill a PK-ascending `orderBy` into every to-many `with` relation that has no
   * explicit one, recursing into nested `with`. Returns a CLONED clause (user
   * args are never mutated); when nothing needs filling it returns the input
   * object unchanged, so the byte-identical fast path stays free. Only called
   * when {@link resolveStableOrder} is true; runs BEFORE `withFingerprint`, so
   * the two orderings get distinct SQL-cache entries automatically. To-one
   * relations are single rows (no array to order) and PK-less targets have
   * nothing stable to order by, so both are left untouched.
   */
  private applyStableRelationOrder(withClause: WithClause, table: string, depth = 0): WithClause {
    if (depth >= 10) return withClause; // parity with the build depth cap
    const meta = this.schema.tables[table];
    if (!meta) return withClause;
    let out: WithClause | undefined;
    for (const [relName, spec] of Object.entries(withClause)) {
      if (relName === '_count' || !spec) continue; // `_count` is a count, not a row load
      const rel = ownLookup(meta.relations, relName);
      if (!rel) continue; // unknown relation, let the build path surface E005
      const options: WithOptions = spec === true ? {} : (spec as WithOptions);

      // Recurse first so a nested change alone still clones this level.
      const nestedWith = options.with as WithClause | undefined;
      const newNested = nestedWith ? this.applyStableRelationOrder(nestedWith, rel.to, depth + 1) : undefined;
      const nestedChanged = newNested !== undefined && newNested !== nestedWith;

      const isToMany = rel.type === 'hasMany' || rel.type === 'manyToMany';
      const hasOrder = options.orderBy !== undefined && !isEmptyOrderBy(options.orderBy);
      let synthOrder: WithOrderByObject | WithOrderByObject[] | undefined;
      if (isToMany && !hasOrder) {
        const targetMeta = this.schema.tables[rel.to];
        const pk = targetMeta?.primaryKey ?? [];
        if (targetMeta && pk.length > 0) {
          const pkFields = pk.map((c) => targetMeta.reverseColumnMap[c] ?? c);
          synthOrder =
            pkFields.length === 1 ? { [pkFields[0]!]: 'asc' } : pkFields.map((f) => ({ [f]: 'asc' as const }));
        }
      }

      if (!synthOrder && !nestedChanged) continue; // nothing to change, keep the ref
      out ??= { ...withClause };
      const clonedSpec: WithOptions = { ...options };
      if (synthOrder) clonedSpec.orderBy = synthOrder;
      if (nestedChanged) clonedSpec.with = newNested as WithOptions['with'];
      out[relName] = clonedSpec;
    }
    return out ?? withClause;
  }

  // -------------------------------------------------------------------------
  // Deterministic pagination (unordered LIMIT/OFFSET)
  // -------------------------------------------------------------------------

  /**
   * The primary key of this table as an ascending `orderBy`, in DECLARATION
   * order (a composite PK orders on every column), or `undefined` for a PK-less
   * table. Field names are the camelCase accessor names, so the emitted SQL goes
   * through the normal column mapping.
   */
  private pkOrderBy(): WithOrderByObject | WithOrderByObject[] | undefined {
    const pk = this.tableMeta.primaryKey ?? [];
    if (pk.length === 0) return undefined;
    const fields = pk.map((c) => this.tableMeta.reverseColumnMap[c] ?? c);
    return fields.length === 1 ? { [fields[0]!]: 'asc' } : fields.map((f) => ({ [f]: 'asc' as const }));
  }

  /**
   * The field names a `cursor` actually seeks on (its own keys with a defined
   * value), in the canonical sorted order the cursor conditions are built in.
   * Empty for a missing cursor or one whose every value is `undefined` (which
   * emits no seek condition at all, so it does not paginate).
   */
  private cursorFields(cursor: unknown): string[] {
    if (!cursor || typeof cursor !== 'object') return [];
    return Object.entries(cursor as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k)
      .sort();
  }

  /**
   * The ascending ordering implied by a `cursor`, or `undefined` when the shape
   * is too ambiguous to order safely.
   *
   * A cursor seek emits `col > $n` per field (`<` when the orderBy says desc),
   * so the ONLY ordering coherent with it is on the cursor's own field: ordering
   * a seek on column X by column Y walks the table in an order the seek does not
   * follow, which skips and repeats rows just as badly as no order at all. That
   * is why this orders on the cursor field rather than blindly on the primary
   * key when the two differ.
   *
   * Returns `undefined` (warn, inject nothing) for two shapes:
   *  - a MULTI-field cursor. `a > $1 AND b > $2` is a conjunction, not a proper
   *    composite keyset seek (`(a, b) > ($1, $2)`), so no single ORDER BY makes
   *    it correct. Injecting `(a asc, b asc)` would dress a broken seek up as a
   *    sound one.
   *  - a field that does not resolve to a real column. Column validation belongs
   *    to the normal build path, which raises a precise error; synthesizing an
   *    ORDER BY on it here would only change which error the caller sees.
   */
  private cursorOrderBy(cursor: unknown): WithOrderByObject | undefined {
    const fields = this.cursorFields(cursor);
    if (fields.length !== 1) return undefined;
    const field = fields[0]!;
    try {
      this.toColumn(field);
    } catch {
      return undefined;
    }
    return { [field]: 'asc' };
  }

  /**
   * Whether a findMany paginates (`limit` / `take` / `offset` / `cursor`) but
   * declares no ordering, which makes the returned page NON-DETERMINISTIC:
   * Postgres is free to return different rows for the same unordered `LIMIT`
   * once the heap changes underneath it, so a row can appear on two pages or on
   * none.
   *
   * `cursor` counts, and is the worst case rather than an exception: a keyset
   * seek with no ORDER BY is exactly this bug (`WHERE id > $1 LIMIT $2` walks
   * the heap in whatever order the plan happens to produce). An empty orderBy
   * (`[]`, or an object whose every value is `undefined`) counts as absent,
   * because it emits no ordering.
   *
   * `distinct` is still excluded: that path re-orders in an outer wrapper around
   * a `DISTINCT ON` whose ordering picks the representative row, so an implicit
   * key would change which rows come back, not just their order.
   */
  private isUnorderedPage(args?: {
    limit?: number;
    take?: number;
    offset?: number;
    cursor?: unknown;
    orderBy?: unknown;
    distinct?: unknown;
  }): boolean {
    if (!args) return false;
    if (args.distinct !== undefined) return false;
    if (!isEmptyOrderBy(args.orderBy)) return false;
    if (args.limit !== undefined || args.take !== undefined || args.offset !== undefined) return true;
    return this.cursorFields(args.cursor).length > 0;
  }

  /**
   * Opt-in (`implicitPkOrdering`) primary-key ascending ordering for a paginating
   * findMany that declares no `orderBy`, making its pages deterministic.
   *
   * OFF by default in CORE, deliberately: turning it on would add an `ORDER BY`
   * to SQL that existing applications already emit, changing both the rows a
   * given page returns and the plan the engine picks. That is a breaking change
   * in everything but the type signature, so it waits for a major. The
   * `turbine-orm/prisma-compat` layer defaults it ON instead, because reproducing
   * Prisma's semantics is that layer's whole contract.
   *
   * An explicit `orderBy` always wins, a PK-less table is left alone (nothing
   * stable to order by), and a composite PK orders on every column in
   * declaration order. A `cursor` query orders on the CURSOR's field instead
   * (see {@link cursorOrderBy}), and is left alone when that shape is ambiguous.
   * `distinct` shapes are skipped (see {@link isUnorderedPage}). With the flag
   * off this returns `undefined` before touching anything, so the emitted SQL is
   * byte-identical to before.
   */
  private implicitPkOrderBy(args?: {
    limit?: number;
    take?: number;
    offset?: number;
    cursor?: unknown;
    orderBy?: unknown;
    distinct?: unknown;
  }): WithOrderByObject | WithOrderByObject[] | undefined {
    if (!this.implicitPkOrdering) return undefined;
    if (!this.isUnorderedPage(args)) return undefined;
    if (this.cursorFields(args?.cursor).length > 0) return this.cursorOrderBy(args?.cursor);
    return this.pkOrderBy();
  }

  /**
   * Dev-only, once per query shape: an unordered paginating findMany returns a
   * non-deterministic page (see {@link isUnorderedPage}), and on real data it is
   * also usually the slower plan (an unordered `LIMIT` can discard tens of
   * thousands of heap rows that an index scan on the key would have skipped).
   *
   * Gated exactly like the other dev diagnostics (silent under
   * `NODE_ENV=production`) and consistent with `warnOnUnlimited`: a per-call
   * `warnOnUnlimited: false` silences it, `true` forces it past a config-level
   * opt-out, and a config/per-table `warnOnUnlimited: false` silences it. Deduped
   * process-wide through the shared warn registry, so it can never spam.
   *
   * Suppressed only when `implicitPkOrdering` will ACTUALLY order this query.
   * The flag being on is not enough: a PK-less table and an ambiguous
   * multi-field cursor both get no injected ordering, and those are precisely
   * the shapes that still need saying out loud.
   */
  private maybeWarnUnorderedPage(args?: {
    limit?: number;
    take?: number;
    offset?: number;
    cursor?: unknown;
    orderBy?: unknown;
    distinct?: unknown;
    warnOnUnlimited?: boolean;
  }): void {
    if (process.env.NODE_ENV === 'production') return;
    if (this.implicitPkOrdering && this.implicitPkOrderBy(args) !== undefined) return;
    const perCall = args?.warnOnUnlimited;
    if (perCall === false) return;
    if (perCall === undefined && !this.warnOnUnlimited) return;
    if (!this.isUnorderedPage(args)) return;
    const cursorFields = this.cursorFields(args?.cursor);
    const shape = [
      cursorFields.length > 0 ? 'cursor' : '',
      args?.limit !== undefined ? 'limit' : '',
      args?.take !== undefined ? 'take' : '',
      args?.offset !== undefined ? 'offset' : '',
    ]
      .filter(Boolean)
      .join('+');
    if (!shouldWarnOnce(WARN_NS.unorderedPage, `${this.table}|${shape}`)) return;
    const asOrderBy = (fields: string[]) =>
      fields.length === 1 ? `{ ${fields[0]}: 'asc' }` : `[${fields.map((f) => `{ ${f}: 'asc' }`).join(', ')}]`;
    const pk = (this.tableMeta.primaryKey ?? []).map((c) => this.tableMeta.reverseColumnMap[c] ?? c);
    // A cursor seeks on its own field, so that is the ordering to recommend:
    // the primary key would be the wrong advice whenever the two differ.
    const orderFields = cursorFields.length > 0 ? cursorFields : pk;
    const suggestion =
      orderFields.length > 0 ? `Add \`orderBy: ${asOrderBy(orderFields)}\`` : 'Add an `orderBy` on a unique column';
    const seek =
      cursorFields.length > 0
        ? 'a `cursor` seek with no orderBy compares against rows the engine is free to return in any order, so ' +
          'paging with it skips and repeats rows: '
        : '';
    console.warn(
      `[turbine] findMany on "${this.table}" paginates (${shape}) with no orderBy: ${seek}the page is NOT ` +
        'deterministic (the same query can return different rows as the table changes, so a row may appear ' +
        `on two pages or on none). ${suggestion}, or set \`implicitPkOrdering: true\` in the client config ` +
        'to order paginated queries automatically (by the cursor field, or by the primary key).',
    );
  }

  // -------------------------------------------------------------------------
  // relationLoadStrategy: 'auto', per-relation batched fallback when the
  // introspected metadata proves a probe is unindexed (finding 13).
  // -------------------------------------------------------------------------

  /**
   * Whether a relation can be served by the batched loader, i.e. all its
   * correlation keys are single-column (the loader throws E017 on composite
   * keys). Composite-key relations therefore always stay on the join plan under
   * `'auto'` (and keep the existing unindexed-probe dev warning).
   */
  private relationBatchEligible(rel: RelationDef): boolean {
    if (rel.type === 'manyToMany') {
      const through = rel.through;
      if (!through) return false;
      const pkLen = this.schema.tables[rel.to]?.primaryKey.length ?? 0;
      return (
        normalizeKeyColumns(through.sourceKey).length === 1 &&
        normalizeKeyColumns(through.targetKey).length === 1 &&
        normalizeKeyColumns(rel.referenceKey).length === 1 &&
        pkLen === 1
      );
    }
    return normalizeKeyColumns(rel.foreignKey).length === 1 && normalizeKeyColumns(rel.referenceKey).length === 1;
  }

  /**
   * The verdict for one relation SUBTREE under `'auto'`: is any probe in the
   * subtree unindexed, is EVERY relation in the subtree batched-eligible, and
   * the first unindexed probe found (for the dev note). Subtree-atomic: a whole
   * top-level relation falls back only when its entire subtree is eligible,
   * mirroring the batched loader recursing the same tree.
   */
  private autoSubtreeVerdict(
    rel: RelationDef,
    spec: true | WithOptions,
    depth: number,
  ): { unindexed: boolean; eligible: boolean; miss?: { table: string; columns: string[]; createSql: string } } {
    let eligible = this.relationBatchEligible(rel);
    const ownMiss = missingIndexForRelation(this.schema, rel);
    let unindexed = ownMiss !== null;
    let miss = ownMiss ?? undefined;

    const options: WithOptions = spec === true ? {} : spec;
    const nested = options.with as WithClause | undefined;
    if (nested && depth < 10) {
      const targetMeta = this.schema.tables[rel.to];
      for (const [childName, childSpec] of Object.entries(nested)) {
        if (!childSpec) continue;
        if (childName === '_count') {
          const cv = this.autoCountVerdict(childSpec as unknown as WithCount, targetMeta);
          eligible = eligible && cv.eligible;
          unindexed = unindexed || cv.unindexed;
          if (!miss && cv.miss) miss = cv.miss;
          continue;
        }
        const childRel = ownLookup(targetMeta?.relations ?? {}, childName);
        if (!childRel) continue; // unknown nested relation, let the build path surface it
        const v = this.autoSubtreeVerdict(childRel, childSpec, depth + 1);
        eligible = eligible && v.eligible;
        unindexed = unindexed || v.unindexed;
        if (!miss && v.miss) miss = v.miss;
      }
    }
    return { unindexed, eligible, miss };
  }

  /** The `_count` verdict under `'auto'`: any counted probe unindexed + all single-key. */
  private autoCountVerdict(
    countSpec: WithCount,
    parentMeta: TableMetadata | undefined,
  ): { unindexed: boolean; eligible: boolean; miss?: { table: string; columns: string[]; createSql: string } } {
    if (!parentMeta) return { unindexed: false, eligible: true };
    let rels: RelationDef[];
    try {
      rels = resolveCountRelations(parentMeta, countSpec);
    } catch {
      return { unindexed: false, eligible: true }; // let the join/loader path surface the error
    }
    let unindexed = false;
    let eligible = true;
    let miss: { table: string; columns: string[]; createSql: string } | undefined;
    for (const rel of rels) {
      if (!this.relationBatchEligible(rel)) eligible = false;
      const m = missingIndexForRelation(this.schema, rel);
      if (m) {
        unindexed = true;
        miss ??= m;
      }
    }
    return { unindexed, eligible, miss };
  }

  /**
   * Whether a query's parent set is potentially large at plan time, which is the
   * only cardinality signal available before the base query runs. A `findMany`
   * with no `limit`/`take` (or one above {@link autoToOneJoinMaxRows}) can return
   * an arbitrary number of parent rows; a small `limit` bounds it. `findUnique` /
   * `findFirst` pass `false` explicitly (their parent set is one row).
   */
  private autoParentSetLarge(args?: { limit?: number; take?: number }): boolean {
    const bound = this.autoParentBound(args);
    return bound === undefined || bound > this.autoToOneThreshold();
  }

  /**
   * The plan-time UPPER BOUND on the parent-row count, or `undefined` when the
   * query is unbounded. This is the raw number behind
   * {@link autoParentSetLarge}; the `_count` rule needs the number itself
   * because its threshold ({@link AUTO_COUNT_BATCH_MIN_PARENT_ROWS}) is two
   * rows rather than the to-one break-even. `findUnique` / `findFirst` pass `1`
   * directly: their parent set is one row as a matter of the statement's shape,
   * not an estimate.
   */
  private autoParentBound(args?: { limit?: number; take?: number }): number | undefined {
    return args?.take ?? args?.limit ?? this.defaultLimit;
  }

  /**
   * The parent-row count at which `'auto'` stops preferring the single-statement
   * join for a to-one relation.
   *
   * Resolution order:
   *   1. an explicit `autoToOneJoinMaxRows`, an instruction, used verbatim
   *      (no clamping: the caller has measured their own workload);
   *   2. the configured `autoRoundTripMs` divided by
   *      {@link AUTO_JOIN_PENALTY_MS_PER_ROW}, clamped to
   *      [{@link AUTO_TO_ONE_JOIN_ROWS_MIN}, {@link AUTO_TO_ONE_JOIN_ROWS_MAX}];
   *   3. {@link AUTO_TO_ONE_JOIN_MAX_ROWS}, which is that same division applied
   *      to {@link AUTO_ASSUMED_ROUND_TRIP_MS}.
   *
   * Deriving it rather than hard-coding a row count is the whole point: the
   * sweep in {@link AUTO_JOIN_PENALTY_MS_PER_ROW} shows the break-even moving
   * 17x between a loopback link and a 2.7ms one while the per-row penalty stays
   * put, so any single constant is wrong for someone by more than the margin it
   * is trying to save. Placing the switch AT the break-even is also what removes
   * the old cliff: two plans that cost the same at the boundary make the regret
   * there ~1.0x, rising only as the true row count moves away from it, where
   * the previous fixed 1000 put its WORST case (1.44x measured) immediately
   * below its own switch point.
   *
   * Cheap enough to recompute per call (a division and two comparisons over
   * readonly fields), so there is no cached copy to invalidate.
   */
  private autoToOneThreshold(): number {
    if (this.autoToOneJoinMaxRowsOption !== undefined) return this.autoToOneJoinMaxRowsOption;
    if (this.autoRoundTripMs === undefined) return AUTO_TO_ONE_JOIN_MAX_ROWS;
    const rows = Math.round(this.autoRoundTripMs / AUTO_JOIN_PENALTY_MS_PER_ROW);
    return Math.min(AUTO_TO_ONE_JOIN_ROWS_MAX, Math.max(AUTO_TO_ONE_JOIN_ROWS_MIN, rows));
  }

  /**
   * Partition a top-level `with` clause under `'auto'`. A relation routes to
   * `batchedWith` when it is fully batched-eligible AND either
   *
   *   1. its subtree has a PROVEN unindexed probe (index metadata only), or
   *   2. it is TO-ONE and the parent set is potentially large
   *      ({@link AUTO_TO_ONE_JOIN_MAX_ROWS}), since a correlated to-one subquery
   *      is re-evaluated per parent row no matter how well indexed it is.
   *
   * Everything else (indexed to-many, composite-key, unknown) stays in `joinWith`
   * (byte-identical join). The reserved `_count` key falls back on rule 1 only,
   * and on its OWN size rule: an inline `_count` is one correlated `COUNT(*)`
   * per parent row over an unindexed child table, so the grouped follow-up wins
   * from {@link AUTO_COUNT_BATCH_MIN_PARENT_ROWS} parent rows upward and inline
   * is preferred only when the parent set is provably bounded below that. Also
   * returns the engaged relations for the dev note.
   */
  private partitionWithForAuto(
    withClause: WithClause,
    parentSetLarge: boolean,
    parentBound: number | undefined,
  ): AutoSplit {
    const hasIndexInfo = schemaHasIndexInfo(this.schema);
    const joinWith: WithClause = {};
    const batchedWith: WithClause = {};
    const engaged: AutoEngaged[] = [];
    for (const [key, spec] of Object.entries(withClause)) {
      if (!spec) continue;
      if (key === '_count') {
        const cv = this.autoCountVerdict(spec as unknown as WithCount, this.tableMeta);
        const countWorthBatching = parentBound === undefined || parentBound >= AUTO_COUNT_BATCH_MIN_PARENT_ROWS;
        if (hasIndexInfo && countWorthBatching && cv.unindexed && cv.eligible) {
          batchedWith[key] = spec;
          engaged.push({ relation: '_count', reason: 'unindexed', miss: cv.miss });
        } else {
          joinWith[key] = spec;
        }
        continue;
      }
      const rel = ownLookup(this.tableMeta.relations, key);
      if (!rel) {
        joinWith[key] = spec; // unknown relation, let the join path surface E005
        continue;
      }
      const v = this.autoSubtreeVerdict(rel, spec, 0);
      const unindexedFallback = hasIndexInfo && v.unindexed;
      const toOne = rel.type === 'belongsTo' || rel.type === 'hasOne';
      const cardinalityFallback = toOne && parentSetLarge;
      if (v.eligible && (unindexedFallback || cardinalityFallback)) {
        batchedWith[key] = spec;
        engaged.push({
          relation: key,
          reason: unindexedFallback ? 'unindexed' : 'to-one-cardinality',
          miss: unindexedFallback ? v.miss : undefined,
        });
      } else {
        joinWith[key] = spec;
      }
    }
    return { joinWith, batchedWith, engaged };
  }

  /**
   * Plan the `'auto'` split for a query's `with` clause: normalize stable order,
   * partition, and return the split ONLY when at least one relation falls back
   * to batched. Returns `null` (→ run the plain join path, byte-identical, same
   * cache keys) when nothing qualifies.
   */
  private planAuto(
    withArg: WithClause,
    stableFlag: boolean | undefined,
    parentSetLarge: boolean,
    parentBound: number | undefined,
  ): AutoSplit | null {
    // Without DB-backed index info (code-first / defineSchema-only) no probe can
    // be PROVEN unindexed; the to-one cardinality rule does not depend on index
    // metadata, so it still applies.
    if (!schemaHasIndexInfo(this.schema) && !parentSetLarge) return null;
    const withClause = this.resolveStableOrder(stableFlag)
      ? this.applyStableRelationOrder(withArg, this.table)
      : withArg;
    const split = this.partitionWithForAuto(withClause, parentSetLarge, parentBound);
    if (Object.keys(split.batchedWith).length === 0) return null;
    return split;
  }

  /**
   * Dev-only once-per-relation note that `'auto'` engaged the batched fallback.
   *
   * Both lines follow the same four parts: the CONDITION that tripped the rule,
   * the MECHANISM (which plan shape was replaced by which, and what that costs),
   * the fix, and the escape hatch. Naming only the condition is what lets a
   * reader build a wrong model of the mechanism and read a correct optimization
   * as a bug, so the mechanism sentence is not optional.
   */
  private emitAutoNotes(engaged: AutoEngaged[]): void {
    if (process.env.NODE_ENV === 'production') return;
    for (const e of engaged) {
      if (!shouldWarnOnce(WARN_NS.autoStrategy, `${this.table}.${e.relation}`)) continue;
      if (e.reason === 'to-one-cardinality') {
        console.warn(
          `[turbine] auto strategy: to-one relation "${e.relation}" on "${this.table}" loads batched ` +
            `(the query is unbounded or its limit exceeds ${this.autoToOneThreshold()} rows). On the join plan ` +
            'a to-one relation is a correlated subquery the engine re-evaluates once per parent row, a per-row ' +
            'cost that stands even on a unique index; batched replaces it with ONE follow-up statement ' +
            '(`key = ANY(...)` for the whole page), so it trades that per-row cost for a single extra round ' +
            'trip. Bound the query with a smaller `limit`, tune `autoToOneJoinMaxRows` (the break-even is ' +
            "round-trip time / per-row cost), or set `relationLoadStrategy: 'join'` to force the " +
            'single-statement plan.',
        );
        continue;
      }
      const probe = e.miss
        ? `probe "${e.miss.table}"(${e.miss.columns.join(', ')}) has no covering index`
        : 'a probe in its subtree has no covering index';
      const child = e.miss?.table ?? 'the child table';
      // Say which shape was replaced, not just the condition. The `_count` case
      // is the one people read as a needless demotion, because the follow-up
      // statement is a grouped COUNT and the inline form looks like it would be
      // one too. It is not.
      const why =
        e.relation === '_count'
          ? ' The inline form is one correlated COUNT(*) re-evaluated per parent row, so on an unindexed ' +
            `probe it is one full scan of "${child}" per parent row; the follow-up is one grouped scan for ` +
            'the whole page.'
          : ' On the join plan that relation is a correlated subquery re-evaluated once per parent row, so an ' +
            `unindexed probe is one full scan of "${child}" per parent row; the batched follow-up scans it ` +
            'once for the whole page.';
      console.warn(
        `[turbine] auto strategy: relation "${e.relation}" on "${this.table}" loads batched (${probe}).${why} ` +
          "Create the covering index (or set `relationLoadStrategy: 'join'` to force the single-statement " +
          'plan); run `npx turbine doctor` for the exact CREATE INDEX SQL.',
      );
    }
  }

  /**
   * Execute a findMany/findUnique `'auto'` split: run the base query with the
   * residual `joinWith` (plus any parent stitch keys the batched subset needs),
   * then load `batchedWith` via the batched loader and stitch. `single` returns
   * the first entity (findUnique) instead of the array. Output is identical in
   * shape to the pure join plan.
   */
  private async runAutoSplit(
    args: FindManyArgs<T> | FindUniqueArgs<T>,
    split: AutoSplit,
    single: boolean,
  ): Promise<Record<string, unknown>[] | Record<string, unknown> | null> {
    this.emitAutoNotes(split.engaged);
    const { joinWith, batchedWith } = split;
    // Scope-rule parity with the batched strategy: reject nested pick ordering
    // on the batched subset up front.
    rejectNestedPickOrder(batchedWith);
    const skip = args.skipGlobalFilters;
    // Resolve the sentinel HERE, not just in buildFindMany below: this method
    // decides the base projection before it ever builds SQL, so a literal
    // `true` would otherwise shape the projection (truthily) and only be
    // refused one step later.
    const includePii = resolveUnsafeFlag(args.includePii, 'includePii');
    const needed = neededParentKeyFields(this.tableMeta, batchedWith);
    assertProjectionShape(
      this.table,
      args.select as Record<string, boolean> | undefined,
      args.omit as Record<string, boolean> | undefined,
    );
    const proj = includeKeysForBatching(
      args.select as Record<string, boolean> | undefined,
      args.omit as Record<string, boolean> | undefined,
      needed,
      defaultProjectionFields(this.tableMeta, includePii),
    );
    const hasJoin = Object.keys(joinWith).length > 0;
    // Force the residual `with` onto the join plan so the base query never
    // re-enters this auto planning.
    const baseArgs = {
      ...args,
      with: hasJoin ? joinWith : undefined,
      select: proj.select,
      omit: proj.omit,
      relationLoadStrategy: 'join' as RelationLoadStrategy,
    };

    this.currentStrategyTag = 'auto-batched';
    try {
      const deferred = single
        ? this.buildFindUnique(baseArgs as Parameters<QueryInterface<T, R>['buildFindUnique']>[0])
        : this.buildFindMany(baseArgs as Parameters<QueryInterface<T, R>['buildFindMany']>[0]);
      const result = await this.queryWithTimeout(
        deferred.sql,
        deferred.params,
        args.timeout,
        this.preparedNameFor(args, deferred.preparedName),
      );
      const rows = deferred.transform(result) as Record<string, unknown>[] | Record<string, unknown> | null;
      const entities = single ? (rows ? [rows as Record<string, unknown>] : []) : (rows as Record<string, unknown>[]);
      // Unconditionally, even for zero rows: with no parents the loader is a
      // pure validation walk over the `with` tree (compile-only child builds),
      // which is what keeps accept/reject identical to the join plan when the
      // base query matches nothing.
      await loadRelationsBatched(
        this.batchedContext(args.timeout, skip, args.includePii, args.forceCustomPlan === true),
        entities,
        batchedWith,
        args.timeout,
      );
      stripFields(entities, proj.strip);
      return single ? (entities[0] ?? null) : entities;
    } finally {
      this.currentStrategyTag = undefined;
    }
  }

  /**
   * Build the {@link RelationLoadContext} the batched loader needs, closing over
   * this interface's pool/dialect/executor. Child readers are constructed on the
   * SAME pool (so they join an active transaction) with `defaultLimit` cleared
   * and unlimited-warnings silenced, a relation load must fetch every matching
   * child, and the per-relation `limit` is applied client-side by the loader.
   */
  private batchedContext(
    timeout: number | undefined,
    skip: SkipGlobalFilters | undefined,
    // BOTH privilege values stay in their RAW (sentinel) form here, and that is
    // load-bearing rather than laziness: the batched loader re-enters
    // `buildFindMany` one level down with these exact values on the child args,
    // where they are resolved (and refused) again. Handing it a plain `true`
    // would make every relation follow-up throw. The caller has already
    // resolved them once for its own projection decisions, so an invalid value
    // never reaches this point.
    includePii: Unsafe | undefined,
    forceCustomPlan = false,
  ): RelationLoadContext {
    // The loader's own global-filter callback below needs the RESOLVED form.
    const resolvedSkip = resolveSkipGlobalFilters(skip);
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
      // The per-query `forceCustomPlan` opt-in covers the relation follow-ups
      // too: a batched load re-issues the SAME tenant-shaped predicate one
      // level down, so leaving those named would keep exactly the plan-cache
      // exposure the caller asked to be rid of.
      exec: (sql, params, preparedName) =>
        this.queryWithTimeout(sql, params, timeout, this.preparedNameFor({ forceCustomPlan }, preparedName)),
      quote: (name) => this.q(name),
      buildInClause: (expr, paramRef, negated) => this.inClause(expr, paramRef, negated),
      inClauseParam: (values) => this.inParam(values),
      paramPlaceholder: (index) => this.p(index),
      skipGlobalFilters: skip,
      // Query-level opt-in threaded onto every follow-up child `buildFindMany`,
      // so a batched load excludes/includes PII exactly as the join strategy.
      includePii,
      tableGlobalFilter: (table, alias, precedingParams) => {
        const gf = this.resolveGlobalFilter(table, resolvedSkip);
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
    // Stable relation order (opt-in): the batched loader forwards each relation's
    // orderBy into its follow-up query, so filling the synthesized PK order here
    // makes the batched output deterministic exactly like the join path.
    const withClause = this.resolveStableOrder(args.stableRelationOrder)
      ? this.applyStableRelationOrder(args.with as WithClause, this.table)
      : (args.with as WithClause);
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
    const result = await this.queryWithTimeout(
      deferred.sql,
      deferred.params,
      args.timeout,
      this.preparedNameFor(args, deferred.preparedName),
    );
    const entities = deferred.transform(result) as Record<string, unknown>[];
    // Unconditionally, even for zero rows: see the 'auto' path above, the
    // loader doubles as the compile-time validation walk of the `with` tree.
    await loadRelationsBatched(
      this.batchedContext(args.timeout, skip, args.includePii, args.forceCustomPlan === true),
      entities,
      withClause,
      args.timeout,
    );
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
    assertProjectionShape(
      this.table,
      args.select as Record<string, boolean> | undefined,
      args.omit as Record<string, boolean> | undefined,
    );
    const proj = includeKeysForBatching(
      args.select as Record<string, boolean> | undefined,
      args.omit as Record<string, boolean> | undefined,
      needed,
      defaultProjectionFields(this.tableMeta, resolveUnsafeFlag(args.includePii, 'includePii')),
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
      onQuery({
        sql,
        params,
        duration,
        model: this.table,
        action,
        rows,
        timestamp: new Date(),
        error,
        strategy: this.currentStrategyTag,
      });
    } catch {
      // Listener errors must never crash a query
    }
  }

  /**
   * Resolve the prepared-statement name a read should execute under, honouring
   * the per-query {@link FindManyArgs.forceCustomPlan} opt-in.
   *
   * `forceCustomPlan: true` returns `undefined`, which sends the statement
   * UNNAMED. The mechanism is NOT "PostgreSQL treats an unnamed statement as a
   * one-shot plan that never enters the plan cache": the backend builds and
   * saves a `CachedPlanSource` for the unnamed statement too. It works because
   * node-postgres only skips Parse for a statement it has already parsed BY
   * NAME (`Query.hasBeenParsed` is `this.name && connection.parsedStatements[this.name]`),
   * so an unnamed statement is re-Parsed on every execution, each Parse
   * replaces the unnamed cached plan source with a fresh one whose custom-plan
   * counter is zero, and the five-execution threshold that precedes promotion
   * is never reached. Every execution is therefore planned with the real
   * parameter values.
   *
   * No GUC is set, no `SET LOCAL` is emitted, no transaction is opened, and no
   * extra round trip is added, which is exactly why the opt-in can be per query
   * while the client-level `planCacheMode` (a connection parameter) cannot be.
   *
   * The refusal is deliberately here, at the one seam every read execution
   * passes through, rather than in each build method: the flag changes NOTHING
   * about the SQL text, so a build-time check would have had to be repeated in
   * every builder and could still be bypassed by a hand-executed
   * `DeferredQuery`.
   *
   * Engines whose dialect does not report {@link Dialect.supportsPlanCacheMode}
   * throw {@link UnsupportedFeatureError} (E017): the flag names a PostgreSQL
   * plan-cache guarantee, and an engine with no such cache cannot make it.
   * The same flag left unset (or `false`) is accepted everywhere.
   *
   * THE ONE COMBINATION THAT IS REFUSED RATHER THAN HONOURED. A client-level
   * `planCacheMode: 'force_generic_plan'` DEFEATS this option, and that was
   * MEASURED rather than reasoned about: on PostgreSQL 16.14, five executions
   * of one unnamed statement read 19,107 buffers with that setting in force and
   * 55 buffers with the same connection set back to `auto`, against 19,107 for
   * the named statement. So the setting governs the unnamed statement too, and
   * withholding the name buys nothing against it. Accepting the flag there
   * would report a guarantee the very next execution breaks, so the
   * contradiction throws {@link ValidationError} (E003) naming both settings.
   * Turbine can only see the setting IT applied: a `plan_cache_mode` installed
   * by the caller's own `SET`, by `ALTER ROLE`, or by a pooler is invisible
   * here and is not refused.
   */
  private preparedNameFor(
    args: { forceCustomPlan?: boolean } | undefined,
    name: string | undefined,
  ): string | undefined {
    if (args?.forceCustomPlan !== true) return name;
    if (this.dialect.supportsPlanCacheMode !== true) {
      throw new UnsupportedFeatureError(
        'The forceCustomPlan query option',
        this.dialect.name,
        'Forcing a per-query custom plan means keeping the statement out of the PostgreSQL plan cache, and this ' +
          'engine has no such cache to keep it out of. Remove the option, or set it only on PostgreSQL queries.',
      );
    }
    if (this.options?.planCacheMode === 'force_generic_plan') {
      throw new ValidationError(
        '[turbine] forceCustomPlan: true cannot be honoured on a client configured with ' +
          "planCacheMode: 'force_generic_plan'. That setting is a connection parameter and it governs UNNAMED " +
          'statements as well as named ones, so the mechanism this option uses (withholding the ' +
          'prepared-statement name, so the driver re-parses the statement on every execution and it is planned ' +
          'with its real values) is ' +
          'overridden by it and the query would be planned generically anyway. Leave the client on the default ' +
          '(`planCacheMode` unset, or `auto`) and force the custom plan per query: that is the combination that ' +
          'expresses "custom here, auto there".',
      );
    }
    return undefined;
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
    // Build the query argument, use object form with `name` for prepared
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
   *     single `queryWithTimeout` + `transform(result)` path, the PostgreSQL
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
   * BEFORE middleware runs, `params.args` is a read-only snapshot, and
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
      // End of chain, execute the actual query
      return executor();
    };

    return next(params) as Promise<R>;
  }

  // -------------------------------------------------------------------------
  // findUnique
  // -------------------------------------------------------------------------

  async findUnique<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args: FindUniqueArgs<T, R, W, S, O>): Promise<QueryResult<T, R, W, S, O> | null> {
    return this.executeWithMiddleware('findUnique', args as unknown as Record<string, unknown>, async () => {
      if (args.with) {
        const strategy = this.resolveLoadStrategy(args.relationLoadStrategy);
        if (strategy === 'batched') return this.runFindUniqueBatched(args as unknown as FindUniqueArgs<T>);
        if (strategy === 'auto') {
          // findUnique's parent set is a single row: the join plan's correlated
          // subqueries run once, so the cardinality rule never applies here, and
          // an inline `_count` is one scan against the batched plan's one scan
          // plus a round trip.
          const split = this.planAuto(args.with as WithClause, args.stableRelationOrder, false, 1);
          if (split) return this.runAutoSplit(args as unknown as FindUniqueArgs<T>, split, true);
        }
      }
      const deferred = this.buildFindUnique(args);
      const result = await this.queryWithTimeout(
        deferred.sql,
        deferred.params,
        args.timeout,
        this.preparedNameFor(args, deferred.preparedName),
      );
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
    // Stable relation order (opt-in), see runFindManyBatched.
    const withClause = this.resolveStableOrder(args.stableRelationOrder)
      ? this.applyStableRelationOrder(args.with as WithClause, this.table)
      : (args.with as WithClause);
    // Same scope-rule parity as runFindManyBatched: reject before querying.
    rejectNestedPickOrder(withClause);
    const needed = neededParentKeyFields(this.tableMeta, withClause);
    assertProjectionShape(
      this.table,
      args.select as Record<string, boolean> | undefined,
      args.omit as Record<string, boolean> | undefined,
    );
    const proj = includeKeysForBatching(
      args.select as Record<string, boolean> | undefined,
      args.omit as Record<string, boolean> | undefined,
      needed,
      defaultProjectionFields(this.tableMeta, resolveUnsafeFlag(args.includePii, 'includePii')),
    );
    const baseArgs = { ...args, with: undefined, select: proj.select, omit: proj.omit } as unknown as FindUniqueArgs<T>;
    const deferred = this.buildFindUnique(baseArgs as Parameters<QueryInterface<T, R>['buildFindUnique']>[0]);
    const result = await this.queryWithTimeout(
      deferred.sql,
      deferred.params,
      args.timeout,
      this.preparedNameFor(args, deferred.preparedName),
    );
    const entity = deferred.transform(result) as Record<string, unknown> | null;
    // A miss still walks the `with` tree (compile-only child builds), so the
    // same args throw or pass identically whether or not the row exists,
    // matching the join plan which validates the whole statement up front.
    await loadRelationsBatched(
      this.batchedContext(args.timeout, args.skipGlobalFilters, args.includePii, args.forceCustomPlan === true),
      entity ? [entity] : [],
      withClause,
      args.timeout,
    );
    if (!entity) return null;
    stripFields([entity], proj.strip);
    return entity as T;
  }

  // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
  buildFindUnique<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args: FindUniqueArgs<T, R, W, S, O>): DeferredQuery<QueryResult<T, R, W, S, O> | null> {
    this.currentSkip = resolveSkipGlobalFilters(args.skipGlobalFilters);
    // Prisma compound-unique selector expansion (before global-filter merge and
    // fingerprinting, so the cache only ever sees the canonical expanded where).
    args = maybeExpandCompoundUnique(this.tableMeta, args);
    // A findUnique whose `where` carries NO predicate must not run.
    //
    // `{ id: undefined }` is what `{ id: req.params.id }` becomes on a request
    // that omitted the parameter, or on a typo'd one. Undefined keys are dropped
    // downstream, so that used to emit `SELECT … FROM t LIMIT 1`: no predicate,
    // and the caller gets an ARBITRARY row where it asked for a specific one and
    // would have handled `null`. On an authorization check keyed by id that is a
    // silent cross-record read, and `findUniqueOrThrow` made it worse by
    // promising to throw when nothing matched and then returning a stranger's
    // row instead.
    //
    // Checked against the USER's where, before the global-filter merge, and
    // deliberately so: a tenant filter is not a unique selector, and letting it
    // satisfy this would still hand back an arbitrary row from inside the tenant.
    //
    // `findFirst` is intentionally NOT guarded. "The first row matching an
    // optional filter" is its whole contract and Prisma's `findFirst` behaves
    // the same way; ask for one row by identity with `findUnique`.
    if (whereMod.userPredicateIsEmpty(this.ctx, (args.where ?? {}) as Record<string, unknown>)) {
      throw new ValidationError(
        `[turbine] findUnique on "${this.table}" refused: the \`where\` clause has no predicate, ` +
          'so this would return an arbitrary row rather than a specific one. ' +
          'A key whose value is `undefined` does not count, check that the value you are looking up is defined. ' +
          'If you meant "any row matching an optional filter", use `findFirst`.',
      );
    }
    // Stable relation order (opt-in): fill PK-asc orderBy into unordered to-many
    // relations before fingerprinting (see buildFindMany).
    if (args.with && this.resolveStableOrder(args.stableRelationOrder)) {
      const normalized = this.applyStableRelationOrder(args.with as WithClause, this.table);
      if (normalized !== args.with) args = { ...args, with: normalized as typeof args.with };
    }
    // Resolved once, see buildFindMany.
    const includePii = resolveUnsafeFlag(args.includePii, 'includePii');
    // findUnique is never flatten-planned: it reads ONE parent row, so the
    // correlated subquery already runs exactly once and a join buys nothing.
    // Say so, because the caller did ask for a strategy that is not running.
    if (args.with && this.resolveLoadStrategy(args.relationLoadStrategy) === 'flatten') {
      this.warnFlattenBlocked('findUnique reads a single parent row, where the correlated subquery already runs once');
    }
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
    // Keys are sorted to match fingerprintWhere, insertion order here would let
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
        return v !== null && !isWhereOperator(v) && !ownLookup(this.tableMeta.relations, k);
      });

    // Simple path: plain equality, no operators/null/OR.
    //
    // This path pushes its own params instead of going through
    // `buildWhereClause`, so every VALUE transform the general walker applies
    // has to be mirrored here or the two paths disagree on the same predicate.
    // `coerceWhereOperand` is the one that matters: without it a `Date` keyed on
    // a zone-less `date`/`timestamp`/`time` column binds raw, and a row that
    // `findFirst` matches, `findUnique` silently misses. It is a value-only
    // transform, so the emitted SQL and the cache key are untouched.
    if (!args.with && isSimpleWhere) {
      const coerce = (k: string, v: unknown): unknown =>
        whereMod.coerceWhereOperand(this.ctx, this.tableMeta, this.toColumn(k), v);
      const buildSql = (freshParams: unknown[]): string => {
        const qt = this.q(this.table);
        const whereClauses = whereKeys.map((k, i) => {
          freshParams.push(coerce(k, whereObj[k]));
          return `${this.toSqlColumn(k)} = ${this.p(i + 1)}`;
        });
        const whereSql = whereClauses.length > 0 ? ` WHERE ${whereClauses.join(' AND ')}` : '';
        const selectExpr = columnsList ? columnsList.map((c) => `${qt}.${this.q(c)}`).join(', ') : `${qt}.*`;
        return `SELECT ${selectExpr} FROM ${qt}${whereSql}${this.limitOneClause()}`;
      };
      const entry = this.acquireSql(ck, buildSql);

      // Collect params (same order and same coercion as build)
      for (const k of whereKeys) {
        params.push(coerce(k, whereObj[k]));
      }
      this.crossCheckCache('findUnique', ck, entry, buildSql, params);

      return {
        sql: entry.sql,
        params,
        transform: (result) => {
          const row = result.rows[0];
          return row ? (this.parseRow(row, this.table) as unknown as QueryResult<T, R, W, S, O>) : null;
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
          return row ? (this.parseRow(row, this.table) as unknown as QueryResult<T, R, W, S, O>) : null;
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

    const parseWith = this.makeNestedParser(args.with as WithClause, includePii);

    return {
      sql: entry.sql,
      params,
      transform: (result) => {
        const row = result.rows[0];
        return row ? (parseWith(row) as unknown as QueryResult<T, R, W, S, O>) : null;
      },
      tag: `${this.table}.findUnique`,
      preparedName: entry.name,
    };
  }

  // -------------------------------------------------------------------------
  // findMany
  // -------------------------------------------------------------------------

  async findMany<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args?: FindManyArgs<T, R, W, S, O>): Promise<QueryResult<T, R, W, S, O>[]> {
    this.maybeWarnUnlimited(args);
    this.maybeWarnUnorderedPage(args);

    // Dev-only: warn on deeply nested with clauses
    if (process.env.NODE_ENV !== 'production') {
      if (args?.with) {
        const depth = this.measureWithDepth(args.with as WithClause);
        if (depth > 5 && shouldWarnOnce(WARN_NS.deepWith, this.table)) {
          console.warn(
            `[turbine] Deep with clause (depth ${depth}) on "${this.tableMeta.name}": every level is a ` +
              'correlated subquery the engine re-evaluates once per row of the level above, so the work ' +
              'multiplies down the tree and the whole subtree is built as JSON inside each parent row. Split ' +
              "into separate queries, or use `relationLoadStrategy: 'batched'` (one flat statement per " +
              'relation, no per-parent re-evaluation). Dev-only: silent under `NODE_ENV=production`.',
          );
        }
      }
    }

    return this.executeWithMiddleware('findMany', (args ?? {}) as Record<string, unknown>, async () => {
      if (args?.with) {
        const strategy = this.resolveLoadStrategy(args.relationLoadStrategy);
        if (strategy === 'batched') return this.runFindManyBatched(args as unknown as FindManyArgs<T>);
        if (strategy === 'auto') {
          const split = this.planAuto(
            args.with as WithClause,
            args.stableRelationOrder,
            this.autoParentSetLarge(args),
            this.autoParentBound(args),
          );
          if (split) return this.runAutoSplit(args as unknown as FindManyArgs<T>, split, false) as Promise<T[]>;
        }
      }
      const deferred = this.buildFindMany(args as unknown as FindManyArgs<T, R, W, S, O>);
      const result = await this.queryWithTimeout(
        deferred.sql,
        deferred.params,
        args?.timeout,
        this.preparedNameFor(args, deferred.preparedName),
      );
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
    if (this.whereMatchesAtMostOneRow((args as { where?: unknown } | undefined)?.where)) return;
    if (this.warnedTables.has(this.table)) return;
    this.warnedTables.add(this.table);
    console.warn(
      `[turbine] warning: findMany on "${this.table}" has no limit: the statement is emitted with no row limit, ` +
        'so the engine returns every matching row and the driver materializes all of them as objects before ' +
        'this call resolves (the cost grows with the table, not with the rows you use). Pass `limit`/`take`, ' +
        'or set `defaultLimit` in the client config; silence with `warnOnUnlimited: false` (per call, per ' +
        'table, or in config).',
    );
  }

  /**
   * Whether `where` can match at most one row, because it pins every column of
   * the primary key or of some unique column set to a literal value.
   *
   * The unlimited-read warning is about accidentally fetching a whole table,
   * so firing it on `findMany({ where: { id: 1 } })` is noise: that query is
   * bounded by a uniqueness constraint just as firmly as by a `limit`, and a
   * warning that cries wolf on correct code trains people to disable it.
   *
   * Deliberately conservative. Only DIRECT equality on a literal counts: an
   * operator object (`{ id: { in: [...] } }`, `{ id: { gt: 1 } }`) can match
   * many rows, and any `OR` / `NOT` / relation filter can widen the result, so
   * anything that is not a plain scalar equality leaves the warning in place.
   * A compound-unique SELECTOR (`{ orgId_userId: {...} }`) is expanded first,
   * so both spellings are recognized.
   */
  private whereMatchesAtMostOneRow(where: unknown): boolean {
    if (where === null || typeof where !== 'object' || Array.isArray(where)) return false;
    const expanded = expandCompoundUniqueWhere(this.tableMeta, where as Record<string, unknown>);

    const pinned = new Set<string>();
    for (const [field, value] of Object.entries(expanded)) {
      if (value === undefined) continue;
      // A plain scalar (or a Date) is an equality. `null` is NOT: `col IS NULL`
      // is not a uniqueness match, since SQL uniqueness permits many nulls.
      const isScalarEquality =
        value !== null && (typeof value !== 'object' || value instanceof Date) && typeof value !== 'function';
      if (!isScalarEquality) return false;
      const column = ownLookup(this.tableMeta.columnMap, field);
      if (!column) return false;
      pinned.add(column);
    }
    if (pinned.size === 0) return false;

    const covers = (columns: string[] | undefined): boolean =>
      !!columns && columns.length > 0 && columns.every((c) => pinned.has(c));
    return covers(this.tableMeta.primaryKey) || (this.tableMeta.uniqueColumns ?? []).some(covers);
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

  // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
  buildFindMany<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args?: FindManyArgs<T, R, W, S, O>): DeferredQuery<QueryResult<T, R, W, S, O>[]> {
    this.currentSkip = resolveSkipGlobalFilters(args?.skipGlobalFilters);
    // Stable relation order (opt-in): fill PK-asc orderBy into unordered to-many
    // relations BEFORE fingerprinting, so the two orderings get distinct cache
    // entries and every downstream path (SQL build, collect, parser) inherits it.
    if (args?.with && this.resolveStableOrder(args.stableRelationOrder)) {
      const normalized = this.applyStableRelationOrder(args.with as WithClause, this.table);
      if (normalized !== args.with) args = { ...args, with: normalized as typeof args.with };
    }
    // An empty orderBy carries no ordering, so treat it as ABSENT rather than
    // emitting a bare `ORDER BY` with nothing after it (a syntax error at the
    // following LIMIT). This matters most for the documented escape hatch from
    // implicit ordering, "pass an explicit orderBy": callers who assemble that
    // array conditionally end up passing `[]`. Normalized here, before the
    // implicit-ordering and fingerprinting steps, so every downstream path sees
    // one shape.
    if (args?.orderBy !== undefined && isEmptyOrderBy(args.orderBy)) {
      args = { ...args, orderBy: undefined };
    }
    // Deterministic pagination (opt-in): fill a PK-asc orderBy into a paginating
    // query that declares none, BEFORE fingerprinting so the ordered and
    // unordered shapes get distinct cache entries. No-op unless
    // `implicitPkOrdering` is enabled (see implicitPkOrderBy).
    const implicitOrder = this.implicitPkOrderBy(args);
    if (implicitOrder) args = { ...args, orderBy: implicitOrder as NonNullable<typeof args>['orderBy'] };
    // `distinct` + relation orderBy is refused up front (E003): the distinct
    // path re-orders in an outer wrapper (`... AS "<table>_distinct" ORDER BY
    // <userOrder>`) where a correlated relation subquery (pick-row, `_count`,
    // to-one relation ordering) would reference the parent table name out of
    // scope, a guaranteed "missing FROM-clause entry" crash on Postgres.
    // Checked BEFORE the SQL cache so build and warm-cache paths throw
    // identically (same rule as the vector guard inside the distinct branch).
    if (args?.distinct && args.distinct.length > 0 && args.orderBy) {
      for (const [, d] of orderByEntries(args.orderBy)) {
        if (this.isRelationOrderByValue(d)) {
          throw new ValidationError(
            '[turbine] `distinct` cannot be combined with relation orderBy (pick-row, `_count`, or ' +
              'to-one relation ordering): the outer re-order cannot reference the parent table.',
          );
        }
      }
    }
    // Resolve the PII opt-in ONCE, before any projection decision. The value is
    // the UNSAFE sentinel or nothing: a literal `true` (what a spread request
    // body carries) throws here rather than unlocking the projection.
    const includePii = resolveUnsafeFlag(args?.includePii, 'includePii');
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
    // Flatten via orderByEntries so the object form (`{ a, b }`) and the
    // Prisma-style array form (`[{ a }, { b }]`) fingerprint from the SAME
    // ordered entry list the build/collect paths consume. An array's element
    // order is authoritative and preserved here, so a permuted array is a
    // distinct key (correct, it emits a different ORDER BY).
    const orderFp = args?.orderBy
      ? orderByEntries(args.orderBy)
          .map(([k, d]) => `${k}:${this.orderByEntryFingerprint(d, ownLookup(this.tableMeta.relations, k)?.to)}`)
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
    // `relationLoadStrategy: 'flatten'` compiles eligible to-one relations to
    // LEFT JOINs instead of correlated subqueries, a completely different
    // statement for the same `with` shape, which `withFp` (strategy-blind)
    // does not distinguish. So the plan gets its own cache-key segment, exactly
    // like `pii=`: a join-planned template must never serve a flatten-planned
    // call. Absent (the default), the segment is empty and every existing cache
    // key is byte-identical to before.
    const flattenPlan = this.planFlatten(args, includePii);
    const flattenFp = flattenPlan ? `|fl=${flattenPlan.signature}` : '';

    const ck = `fm:${whereFp}|c=${colKey}|o=${orderFp}|l=${limitFp}|off=${offsetFp}|cur=${cursorFp}|d=${distinctFp}|w=${withFp}|pii=${includePii ? 1 : 0}${flattenFp}${this.globalFilterCacheSegment()}`;

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

      // Join-sink for `relationLoadStrategy: 'flatten'`. Filled while the SELECT
      // list is built (so the flattened relations' ON-clause params interleave
      // with the `with` params in one traversal, which the collect path
      // mirrors) and spliced into the FROM clause at assembly. Stays empty for
      // every other plan → byte-identical SQL.
      const relationJoins: string[] = [];

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
          flattenPlan ? { plan: flattenPlan, joinSink: relationJoins } : undefined,
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
        // Sorted (canonical) order, MUST match cursorFp and the cache-hit collect below.
        const cursorEntries = sortedEntries(args.cursor as Record<string, unknown>).filter(([, v]) => v !== undefined);
        if (cursorEntries.length > 0) {
          // Resolve the seek direction per cursor field from the flattened
          // orderBy entries (last wins, matching object-key semantics), so both
          // the object and array orderBy forms drive the cursor comparison.
          const orderDirByKey = new Map(orderByEntries(args.orderBy));
          const cursorConditions = cursorEntries.map(([k, v]) => {
            const col = this.toSqlColumn(k);
            // orderBy values can be the { sort, nulls } spec form: normalize
            // before comparing, or a desc spec would seek the ascending side.
            const dir = orderDirByKey.get(k);
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
        if (orderByEntries(args.orderBy).some(([, d]) => isVectorOrderBy(d))) {
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
        sql = `SELECT ${distinctPrefix}${selectClause} FROM ${qt}${relationJoins.join('')}${lateralJoins.join('')}${tail}${orderBySql}`;
      }

      // Pagination, push params in the same order the collect path mirrors
      // (limit before offset); the SQL TEXT shape is dialect-owned via
      // buildPagination (PG: ` LIMIT $n`/` OFFSET $n`; SQL Server: OFFSET/FETCH).
      let limitPh: string | undefined;
      let offsetPh: string | undefined;
      if (effectiveLimit !== undefined) {
        limitPh = this.paginationRef(effectiveLimit, freshParams, 'limit');
      }
      if (args?.offset !== undefined) {
        offsetPh = this.paginationRef(args.offset, freshParams, 'skip/offset');
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
      this.collectWithParams(args.with as WithClause, params, undefined, flattenPlan);
    }
    // 3. Cursor params, sorted (canonical) order, matching cursorFp and the build path.
    if (args?.cursor) {
      const cursorEntries = sortedEntries(args.cursor as Record<string, unknown>).filter(([, v]) => v !== undefined);
      for (const [, v] of cursorEntries) {
        params.push(v);
      }
    }
    // 4. ORDER BY params (vector KNN ordering binds a `$n::vector` query vector).
    //    Mirrors buildOrderBy's push order, between cursor and LIMIT.
    if (args?.orderBy) {
      this.collectOrderByParams(args.orderBy, params);
    }
    // 5. LIMIT param, skipped when the dialect inlines pagination (build path
    //    mirrors via paginationRef → no placeholder, no param).
    if (effectiveLimit !== undefined && !this.dialect.inlineLimitOffset) {
      // Validate here too: on a cache HIT the build path never runs, and a
      // warmed template would otherwise bind an unvalidated NaN (= SQL NULL,
      // i.e. no limit at all).
      params.push(this.paginationValue(effectiveLimit, 'limit'));
    }
    // 6. OFFSET param, same inline gate as LIMIT above.
    if (args?.offset !== undefined && !this.dialect.inlineLimitOffset) {
      params.push(this.paginationValue(args.offset, 'skip/offset'));
    }
    this.crossCheckCache('findMany', ck, entry, buildSql, params);

    // Build the row parser once (positional shapes are computed here, not per row).
    const parseWith = args?.with ? this.makeNestedParser(args.with as WithClause, includePii, flattenPlan) : null;

    return {
      sql: entry.sql,
      params,
      transform: (result) =>
        result.rows.map(
          (row) =>
            (parseWith ? parseWith(row) : this.parseRow(row, this.table)) as unknown as QueryResult<T, R, W, S, O>,
        ),
      tag: `${this.table}.findMany`,
      preparedName: entry.name,
    };
  }

  // -------------------------------------------------------------------------
  // findManyStream, async iterable using PostgreSQL cursors
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
   * single pooled connection. The cursor is CLOSEd (in the dialect's `finally`)
   * and the connection released both when iteration completes normally and when
   * it ends early (`break` from `for await`). An error mid-stream skips the
   * CLOSE and rolls back instead, which drops the cursor with the transaction.
   *
   * **Snapshot semantics note:** Outside a transaction the speculative
   * fast-path runs unwrapped, and an overflow opens the cursor in its own
   * transaction, so the two fetches span two separate snapshots. Wrapping the
   * call in `$transaction` gives strict single-snapshot semantics: both the
   * speculative fetch and the cursor then run on the caller's connection
   * inside the caller's transaction (the cursor path issues no BEGIN/COMMIT of
   * its own and releases nothing, so the caller's transaction is intact when
   * iteration finishes).
   *
   * @example
   * ```ts
   * for await (const user of db.users.findManyStream({ where: { orgId: 1 }, batchSize: 500 })) {
   *   process.stdout.write(`${user.email}\n`);
   * }
   * ```
   */
  async *findManyStream<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args?: FindManyStreamArgs<T, R, W, S, O>): AsyncGenerator<QueryResult<T, R, W, S, O>, void, undefined> {
    const batchSize = Math.max(1, Math.floor(Number(args?.batchSize ?? 1000)));
    const hasRelations = !!args?.with;
    // Build the positional-aware relation parser once for the whole stream.
    // Same flatten plan buildFindMany compiles below. The plan is a pure
    // function of the schema, the `with` shape and `includePii`, never of
    // `limit`, so the batch-size override the speculative fetch applies cannot
    // change it, and the stream's parser matches the emitted SQL.
    // Resolved once for the whole stream: the flatten plan and the row parser
    // MUST agree with the SQL buildFindMany emits below, and reading the raw
    // sentinel with `=== true` here would have quietly planned a no-PII parser
    // over a with-PII statement.
    const streamPii = resolveUnsafeFlag(args?.includePii, 'includePii');
    const streamFlattenPlan = hasRelations ? this.planFlatten(args, streamPii) : null;
    const parseWith = hasRelations
      ? this.makeNestedParser(args!.with as WithClause, streamPii, streamFlattenPlan)
      : null;

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
    // Streaming is ALREADY immune to the generic-plan cliff: the speculative
    // fetch has never passed a prepared name, and the cursor path runs through
    // DECLARE, so neither statement enters the plan cache. `preparedNameFor` is
    // still called with no name so that `forceCustomPlan: true` is VALIDATED on
    // an engine that cannot honour it here either, rather than being quietly
    // satisfied by an accident of this code path.
    const speculativeResult = await this.queryWithTimeout(
      speculativeDeferred.sql,
      speculativeDeferred.params,
      args?.timeout,
      this.preparedNameFor(args, undefined),
    );

    if (speculativeResult.rows.length <= batchSize) {
      // Small drain, yield all rows and return, no cursor needed
      for (const row of speculativeResult.rows) {
        yield (parseWith ? parseWith(row) : this.parseRow(row, this.table)) as QueryResult<T, R, W, S, O>;
      }
      return;
    }

    // --- Overflow: fall back to cursor path from scratch ---
    const deferred = this.buildFindMany(args as unknown as FindManyArgs<T, R, W, S, O>);

    // Acquire a dedicated connection: cursors require a single connection in a
    // transaction. The dialect owns the streaming SQL (Postgres: BEGIN → DECLARE
    // … NO SCROLL CURSOR FOR → FETCH n → CLOSE → COMMIT, ROLLBACK on error); we
    // just parse + yield the row batches it produces.
    //
    // Inside a caller-owned transaction there is nothing to check out: the
    // transaction-scoped pool pins every query to the transaction's own
    // connection, so `pool.query` already IS that connection. The stream rides
    // on it, is never released here, and the dialect is told to emit no
    // transaction control of its own (`ambientTransaction`).
    const client = this.txScoped ? null : await this.acquireConnection();
    const conn: StreamableConnection = client ?? {
      query: async (text: string, values?: unknown[]) =>
        (await this.pool.query(text, values)) as { rows: Record<string, unknown>[] },
    };
    try {
      for await (const batch of this.dialect.openStream(conn, deferred.sql, deferred.params, batchSize, {
        ambientTransaction: this.txScoped,
      })) {
        for (const row of batch) {
          yield (parseWith ? parseWith(row) : this.parseRow(row, this.table)) as QueryResult<T, R, W, S, O>;
        }
      }
    } catch (err) {
      // Wrap pg constraint errors so streaming surfaces typed errors like the rest of the API
      throw wrapPgError(err);
    } finally {
      client?.release();
    }
  }

  // -------------------------------------------------------------------------
  // findFirst, like findMany but returns a single row or null
  // -------------------------------------------------------------------------

  async findFirst<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args?: FindManyArgs<T, R, W, S, O>): Promise<QueryResult<T, R, W, S, O> | null> {
    return this.executeWithMiddleware('findFirst', (args ?? {}) as Record<string, unknown>, async () => {
      if (args?.with) {
        const strategy = this.resolveLoadStrategy(args.relationLoadStrategy);
        // findFirst is findMany + LIMIT 1: batch the single base row, then load.
        if (strategy === 'batched') {
          const rows = await this.runFindManyBatched({ ...args, limit: 1 } as unknown as FindManyArgs<T>);
          return (rows[0] ?? null) as QueryResult<T, R, W, S, O> | null;
        }
        if (strategy === 'auto') {
          // findFirst is findMany + LIMIT 1: a one-row parent set.
          const split = this.planAuto(args.with as WithClause, args.stableRelationOrder, false, 1);
          if (split) {
            const rows = (await this.runAutoSplit(
              { ...args, limit: 1 } as unknown as FindManyArgs<T>,
              split,
              false,
            )) as Record<string, unknown>[];
            return (rows[0] ?? null) as QueryResult<T, R, W, S, O> | null;
          }
        }
      }
      const deferred = this.buildFindFirst(args);
      const result = await this.queryWithTimeout(
        deferred.sql,
        deferred.params,
        args?.timeout,
        this.preparedNameFor(args, deferred.preparedName),
      );
      return deferred.transform(result);
    }) as Promise<QueryResult<T, R, W, S, O> | null>;
  }

  // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
  buildFindFirst<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args?: FindManyArgs<T, R, W, S, O>): DeferredQuery<QueryResult<T, R, W, S, O> | null> {
    // Reuse findMany's SQL builder but force LIMIT 1
    const findManyArgs = { ...args, limit: 1 } as FindManyArgs<T, R, W, S, O>;
    const deferred = this.buildFindMany<W, S, O>(findManyArgs);

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
  // findFirstOrThrow, like findFirst but throws if no record found
  // -------------------------------------------------------------------------

  async findFirstOrThrow<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args?: FindManyArgs<T, R, W, S, O>): Promise<QueryResult<T, R, W, S, O>> {
    return this.executeWithMiddleware('findFirstOrThrow', (args ?? {}) as Record<string, unknown>, async () => {
      const deferred = this.buildFindFirstOrThrow(args);
      const result = await this.queryWithTimeout(
        deferred.sql,
        deferred.params,
        args?.timeout,
        this.preparedNameFor(args, deferred.preparedName),
      );
      return deferred.transform(result);
    }) as Promise<QueryResult<T, R, W, S, O>>;
  }

  // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
  buildFindFirstOrThrow<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args?: FindManyArgs<T, R, W, S, O>): DeferredQuery<QueryResult<T, R, W, S, O>> {
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
  // findUniqueOrThrow, like findUnique but throws if no record found
  // -------------------------------------------------------------------------

  async findUniqueOrThrow<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args: FindUniqueArgs<T, R, W, S, O>): Promise<QueryResult<T, R, W, S, O>> {
    return this.executeWithMiddleware('findUniqueOrThrow', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildFindUniqueOrThrow(args);
      const result = await this.queryWithTimeout(
        deferred.sql,
        deferred.params,
        args.timeout,
        this.preparedNameFor(args, deferred.preparedName),
      );
      return deferred.transform(result);
    }) as Promise<QueryResult<T, R, W, S, O>>;
  }

  // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
  buildFindUniqueOrThrow<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args: FindUniqueArgs<T, R, W, S, O>): DeferredQuery<QueryResult<T, R, W, S, O>> {
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
  // createMany, uses UNNEST for performance
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

  /**
   * Check out a pooled connection, translating a driver failure into a typed
   * Turbine error.
   *
   * `pool.connect()` is where the first-run failures land: wrong password
   * (SQLSTATE 28P01), no such database (3D000), nothing listening
   * (ECONNREFUSED), an unverifiable TLS certificate. Unwrapped, every one of
   * those surfaces from an ordinary `db.users.create({ data: { ...nested } })`
   * as a raw pg `DatabaseError` whose `.code` is a SQLSTATE, on the same
   * property Turbine puts `TURBINE_E0NN` in.
   *
   * client.ts has its own copy for `$transaction` / `connect()`; this one
   * exists because `query/` must not import client.ts (circular dependency).
   * The query paths need no equivalent: `pool.query()` opens the connection
   * itself and rejects with the connect error, which the query boundary
   * already wraps.
   */
  private async acquireConnection(): Promise<pg.PoolClient> {
    try {
      return await this.pool.connect();
    } catch (err) {
      throw wrapPgError(err);
    }
  }

  private async runInImplicitTx<R>(fn: (ctx: NestedWriteContext) => Promise<R>): Promise<R> {
    const client = await this.acquireConnection();
    let began = false;
    try {
      await client.query(this.dialect.beginStatement());
      began = true;
      const { TransactionClient } = await import('../client.js');
      const tx = new TransactionClient(
        // biome-ignore lint/suspicious/noExplicitAny: MiddlewareFn and Middleware are structurally identical
        client as any,
        this.schema,
        // biome-ignore lint/suspicious/noExplicitAny: MiddlewareFn and Middleware are structurally identical
        this.middlewares as any,
        this.options,
        // Pass the source pool so its read-only guard + capabilities carry into
        // the transaction-scoped proxy pool (see createTxPool). Without it a
        // read-only client's nested writes bypass the E018 guard and an
        // older-engine client falls back to the full capability set inside the
        // implicit transaction.
        this.pool as unknown as { readonly?: boolean; capabilities?: unknown },
      );
      const ctx: NestedWriteContext = {
        schema: this.schema,
        // biome-ignore lint/suspicious/noExplicitAny: TransactionClient satisfies NestedWriteContext['tx'] at runtime
        tx: unlockNestedWriteTx(tx as any),
        scopedConnect: this.scopedConnect,
      };
      const result = await fn(ctx);
      await client.query(this.dialect.commitStatement());
      return result;
    } catch (err) {
      // Only roll back a transaction we actually opened: a failed BEGIN must
      // not emit a stray ROLLBACK on a connection that never began one.
      if (began) {
        try {
          await client.query(this.dialect.rollbackStatement());
        } catch {
          // Best-effort rollback: connection may have died.
        }
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
      tx: unlockNestedWriteTx(this.makeTxProxy(pool, schema, middlewares, opts)),
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

  async delete(args: DeleteArgs<T, R>): Promise<T> {
    return this.executeWithMiddleware('delete', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildDelete(args);
      return this.executeMutation(deferred, args.timeout);
    });
  }

  // -------------------------------------------------------------------------
  // upsert, INSERT ... ON CONFLICT ... DO UPDATE
  // -------------------------------------------------------------------------

  async upsert(args: UpsertArgs<T, R>): Promise<T> {
    return this.executeWithMiddleware('upsert', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildUpsert(args);
      return this.executeMutation(deferred, args.timeout);
    });
  }

  // -------------------------------------------------------------------------
  // updateMany, UPDATE ... WHERE ... returning count
  // -------------------------------------------------------------------------

  async updateMany(args: UpdateManyArgs<T, R>): Promise<{ count: number }> {
    return this.executeWithMiddleware('updateMany', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildUpdateMany(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args.timeout, deferred.preparedName);
      return deferred.transform(result);
    });
  }

  // -------------------------------------------------------------------------
  // deleteMany, DELETE ... WHERE ... returning count
  // -------------------------------------------------------------------------

  async deleteMany(args: DeleteManyArgs<T, R>): Promise<{ count: number }> {
    return this.executeWithMiddleware('deleteMany', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildDeleteMany(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args.timeout, deferred.preparedName);
      return deferred.transform(result);
    });
  }

  // -------------------------------------------------------------------------
  // count
  // -------------------------------------------------------------------------

  async count(args?: CountArgs<T, R>): Promise<number> {
    return this.executeWithMiddleware('count', (args ?? {}) as Record<string, unknown>, async () => {
      const deferred = this.buildCount(args);
      const result = await this.queryWithTimeout(
        deferred.sql,
        deferred.params,
        args?.timeout,
        this.preparedNameFor(args, deferred.preparedName),
      );
      return deferred.transform(result);
    });
  }

  buildCount(args?: CountArgs<T>): DeferredQuery<number> {
    this.currentSkip = resolveSkipGlobalFilters(args?.skipGlobalFilters);
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

  /**
   * Group rows and compute per-group aggregates (Prisma-style). The result row
   * type is INFERRED from the args: each `by` field carries its entity field
   * type, `_count` is always a number, and each requested `_sum` / `_avg` /
   * `_min` / `_max` block maps its fields to properly typed values (see
   * {@link GroupByResult}). Grouping by a JSON-path key yields a runtime alias
   * that cannot be typed, so those columns are not projected onto the row type.
   */
  async groupBy<A extends GroupByArgs<T, R>>(args: A): Promise<GroupByResult<T, A>[]> {
    return this.executeWithMiddleware('groupBy', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildGroupBy(args);
      const result = await this.queryWithTimeout(
        deferred.sql,
        deferred.params,
        args.timeout,
        this.preparedNameFor(args, deferred.preparedName),
      );
      return deferred.transform(result) as GroupByResult<T, A>[];
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
  // aggregate, standalone aggregation without groupBy
  // -------------------------------------------------------------------------

  async aggregate(args: AggregateArgs<T, R>): Promise<AggregateResult<T>> {
    return this.executeWithMiddleware('aggregate', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildAggregate(args);
      const result = await this.queryWithTimeout(
        deferred.sql,
        deferred.params,
        args.timeout,
        this.preparedNameFor(args, deferred.preparedName),
      );
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

  private collectWithParams(
    withClause: WithClause,
    params: unknown[],
    table?: string,
    flattenPlan?: relationsMod.FlattenPlan | null,
  ): void {
    relationsMod.collectWithParams(this.ctx, withClause, params, table, flattenPlan);
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
    flattenPlan?: relationsMod.FlattenPlan | null,
  ): (row: Record<string, unknown>) => Record<string, unknown> {
    return relationsMod.makeNestedParser(this.ctx, withClause, includePii, flattenPlan);
  }

  private buildSelectWithRelations(
    table: string,
    withClause: WithClause,
    params: unknown[],
    columnsList?: string[] | null,
    depth?: number,
    path?: string[],
    includePii?: boolean,
    flatten?: { plan: relationsMod.FlattenPlan; joinSink: string[] },
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
      flatten,
    );
  }

  /**
   * Compile the `relationLoadStrategy: 'flatten'` plan for a findMany-shaped
   * query, or `null` to emit exactly the SQL (and cache key) the default
   * strategy emits.
   *
   * `'flatten'` compiles an eligible to-one relation to a `LEFT JOIN` with a
   * prefixed scalar projection instead of a correlated `json_build_object`
   * subquery. The correlated form is re-evaluated once per parent row, so its
   * cost scales with the parent set no matter how well the FK is indexed; the
   * join does not, and unlike `'batched'` it stays a single round trip.
   *
   * It is an EXPLICIT opt-in: `'auto'` is unchanged and never selects it.
   *
   * Query-shape gates (any of these routes the WHOLE query back to the default
   * strategy, silently and byte-identically):
   *   - the resolved strategy is not `'flatten'`;
   *   - `jsonEncoding: 'positional'` (a flattened relation emits no JSON at all,
   *     so the two encodings are not composed in this version);
   *   - the dialect owns relation-subquery generation
   *     (`dialect.buildRelationSubquery`, i.e. SQL Server's `FOR JSON PATH`);
   *   - `distinct` (the `DISTINCT ON` rewrite re-orders in an outer wrapper, and
   *     the extra projected columns have not been proven safe there).
   *
   * `limit` / `offset` / `cursor` / `orderBy` need no gate: every flattened join
   * is over a PROVABLY UNIQUE target key, so it matches at most one row per
   * parent and cannot change the parent row count that pagination applies to.
   *
   * Per-relation eligibility lives in `planFlattenWith` / `planFlattenNode`.
   * Only the findMany family is planned (`findMany`, `findFirst`,
   * `findManyStream`, and pipelined `buildFindMany`); `findUnique` reads a single
   * parent row, where the correlated subquery runs exactly once, so it stays on
   * the default path.
   */
  private planFlatten(
    args: { with?: unknown; relationLoadStrategy?: RelationLoadStrategy; distinct?: readonly string[] } | undefined,
    includePii: boolean,
  ): relationsMod.FlattenPlan | null {
    const withClause = args?.with as WithClause | undefined;
    if (!withClause) return null;
    if (this.resolveLoadStrategy(args?.relationLoadStrategy) !== 'flatten') return null;
    // Query-level refusals: the whole plan is off, so name the reason once for
    // the query rather than once per relation (relations.ts warns per relation
    // for the eligibility rules it owns).
    const queryLevelBlock =
      this.jsonEncoding === 'positional'
        ? "`jsonEncoding: 'positional'` is active, and a flattened relation emits no JSON to encode"
        : this.dialect.buildRelationSubquery
          ? `the ${this.dialect.name} dialect generates relation subqueries itself`
          : args?.distinct && args.distinct.length > 0
            ? 'the query uses `distinct`'
            : undefined;
    if (queryLevelBlock) {
      this.warnFlattenBlocked(queryLevelBlock);
      return null;
    }
    return relationsMod.planFlattenWith(this.ctx, this.table, withClause, includePii);
  }

  /** Dev-only once-only note that `'flatten'` was refused for the whole query. */
  private warnFlattenBlocked(reason: string): void {
    if (process.env.NODE_ENV === 'production') return;
    if (!shouldWarnOnce(WARN_NS.flattenFallback, `${this.table}|query|${reason}`)) return;
    console.warn(
      `[turbine] relationLoadStrategy: 'flatten' did not engage on "${this.table}": ${reason}. ` +
        'Every relation loads via the correlated subquery instead (same rows, same values, different plan).',
    );
  }

  /**
   * Convert a field name to its snake_case column name (unquoted, for non-SQL
   * uses), throwing E003 when the key names no column.
   *
   * The resolution rule itself lives in {@link resolveColumnName} (query/utils.ts)
   * so the value-side passes that must NOT throw, write coercion above all, can
   * share it instead of re-deriving it. Accepting `camelToSnake(field)` only
   * when it is a real column preserves the convenience of writing `userId` when
   * the schema exposes `user_id` under an unusual field name (and of writing the
   * column name outright), while rejecting arbitrary strings, closing the
   * defense-in-depth gap for SQL injection and catching typos like
   * `where: { emial: 'x' }` with a clear error instead of a cryptic Postgres
   * "column does not exist".
   */
  private toColumn(field: string): string {
    const column = resolveColumnName(this.tableMeta, field);
    if (column) return column;
    throw new ValidationError(unknownFieldMessage(this.table, field, this.tableMeta));
  }

  /** Convert camelCase field name to a double-quoted SQL identifier */
  private toSqlColumn(field: string): string {
    return this.q(this.toColumn(field));
  }

  // =========================================================================
  // Fingerprinting, value-invariant shape keys for SQL cache lookup
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
    skip: ResolvedSkipGlobalFilters | undefined = this.currentSkip,
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
    for (const [key, dir] of orderByEntries(orderBy)) {
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
        const relDef = ownLookup(this.tableMeta.relations, key);
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
  // Global filters (soft-delete / multi-tenancy, WS-G)
  //
  // A configured global filter for a table is AND-merged into the compiled WHERE
  // of every query on that table (via {@link mergeGlobalFilter}, so the merge is
  // captured in the where fingerprint/collect for free) and into every relation
  // subquery targeting it (rendered at build time against the subquery's alias/
  // table by the `*GlobalFilterAlias`/`*GlobalFilterExists` helpers, with the
  // shape folded into the SQL-cache key via {@link globalFilterCacheSegment}).
  // Function filters are evaluated per resolve, at query-build time, enabling
  // per-request tenancy via a closure. They must return a STABLE shape (same
  // keys/operators); only values may vary between calls.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Scoped (non-top-level) WHERE compilation, relation EXISTS sub-wheres and
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
   * Each value is either a plain direction (`'asc'`/`'desc'`) or, for pgvector
   * columns, a `{ distance: { to, metric, direction? } }` KNN ordering object.
   * Vector ordering binds the query vector as a `$n::vector` param, so a `params`
   * array MUST be supplied when a vector ordering may be present (top-level
   * findMany path). When `params` is omitted (groupBy / relation path) a vector
   * ordering throws, KNN ordering is only supported at the top level.
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

  /**
   * Say ONCE per `table.field` that a stored temporal `infinity` was actually
   * read, and describe the reading the caller is getting. JavaScript has no
   * `Date` for either infinity, so BOTH readings cost something and a caller
   * whose rows carry the value needs to know which cost they are paying.
   *
   * Under the default `'preserve'` the value comes back as the JS number
   * `Infinity` / `-Infinity` on a field the generated types declare as `Date`,
   * so `.toISOString()` / `.getTime()` throw a TypeError on exactly those rows
   * and `JSON.stringify` still renders them `null` (JSON has no infinity
   * literal). That is the price of the reading being LOSSLESS: the number binds
   * straight back, so a read-modify-write stores `infinity` again. The
   * alternative, `'null'`, is silently destructive, which is why it is not the
   * default and why the warning names it as a deliberate choice rather than a
   * recommendation.
   *
   * ONLY WHEN THE OPTION WAS LEFT UNSET. Naming a reading in the config, either
   * one, is the acknowledgement, and the warning exists to surface an
   * unacknowledged trade rather than to nag.
   *
   * NOT DEV-ONLY, unlike every other warning in this codebase, and deliberately
   * so. Production is exactly where a destructive write commits and where the
   * row cannot be recovered afterwards, so a warning that goes quiet under
   * `NODE_ENV=production` is silent in the only place it matters. The cost is
   * bounded to the point of irrelevance: once per process per field, and only
   * on a row that actually held an infinity.
   *
   * KEYED ON THE FIELD, not the row key: top-level rows arrive snake_case and
   * nested `json_build_object` rows arrive camelCase, so keying on the raw key
   * warned twice for one column.
   */
  private warnTemporalInfinity(table: string, field: string): void {
    if (!this.warnTemporalInfinityUnset) return;
    if (!shouldWarnOnce(WARN_NS.temporalInfinity, `${table}.${field}`)) return;
    console.warn(
      `[turbine] ${table}.${field} holds the Postgres value \`infinity\` (or \`-infinity\`). JavaScript has ` +
        'no Date for it, so it reads as the JS number `Infinity` / `-Infinity` on a field the generated ' +
        'types declare as `Date`: `.toISOString()` and `.getTime()` throw a TypeError on these rows, and ' +
        '`JSON.stringify` still renders them null because JSON has no infinity literal. The number is the ' +
        'lossless reading, though: it binds straight back, so writing a row you just read stores `infinity` ' +
        'again. Two more things this column can no longer do: `where: { col: null }` still means IS NULL and ' +
        "does NOT match these rows (filter them with `{ col: 'infinity' }`), and `groupBy` / `distinct` " +
        "cannot tell infinity, -infinity and NULL apart. Set `temporalInfinity: 'preserve'` to confirm this " +
        "reading and silence the warning, or `'null'` to read null instead, accepting that a stored " +
        'infinity then looks exactly like a stored NULL and a read-modify-write over a nullable column ' +
        'stores SQL NULL, destroying the value with no error.',
    );
  }

  /**
   * Apply the configured reading to the infinity elements of a temporal ARRAY
   * value, returning the original array by identity when there are none (the
   * overwhelmingly common case, so no per-row allocation on ordinary data).
   */
  private mapArrayTemporalInfinity(value: unknown[], table: string, field: string): unknown[] {
    let hit = false;
    for (let i = 0; i < value.length; i++) {
      if (isTemporalInfinity(value[i])) {
        hit = true;
        break;
      }
    }
    if (!hit) return value;
    this.warnTemporalInfinity(table, field);
    return value.map((el) => (isTemporalInfinity(el) ? this.readTemporalInfinity(el) : el));
  }

  /**
   * The configured reading of one infinity value: the JS number (`'preserve'`,
   * the default) or `null`. Under `'preserve'` the JSON-wire STRING form
   * (`"infinity"`, what the join and positional strategies see) is normalized
   * to the number too, so the reading is identical on every strategy; 0.54
   * shipped the number on some paths and an Invalid Date on others, which is
   * the bug that made a single reading necessary in the first place.
   */
  private readTemporalInfinity(value: unknown): unknown {
    if (this.temporalInfinity === 'null') return null;
    if (typeof value === 'number') return value;
    return value === '-infinity' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
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
          if (isTemporalInfinity(value)) {
            // Postgres `infinity` / `-infinity`. No JS Date means either, so
            // both readings cost something and the default is the one that is
            // not lossy. `'preserve'` hands back the JS number, which breaks
            // the declared `Date` type at runtime (`.toISOString()` throws) and
            // still serializes as null because JSON has no infinity literal,
            // but binds straight back, so a read-modify-write stores `infinity`
            // again. `'null'` reads nicer and DESTROYS the value on that same
            // write, because a stored infinity and a stored NULL become
            // indistinguishable. Whichever is configured, it is the SAME on
            // every read strategy: the driver hands back the number,
            // `json_build_object` hands back the string "infinity", and both
            // land here (see `isTemporalInfinity`).
            //
            // The warning below fires once per column when the option was left
            // unset, on a row that actually held an infinity, and describes the
            // reading in force rather than gating on which one it is.
            this.warnTemporalInfinity(table, field);
            parsed[field] = this.readTemporalInfinity(value);
          } else if (Array.isArray(value)) {
            // `dateColumns` includes array-of-date columns (`date[]`,
            // `timestamp[]`, `timestamptz[]`), for which the driver already
            // hands back a `Date[]`. Coercing the array itself ran
            // `new Date(String(theArray))` and replaced the whole column with
            // one Invalid Date. Its ELEMENTS get the same infinity mapping as a
            // scalar (same declared element type, same JSON rendering);
            // everything else is passed through by identity.
            parsed[field] = this.mapArrayTemporalInfinity(value, table, field);
          } else if (typeof value === 'number') {
            // Any other number on a date column is left alone rather than run
            // through `parseDbDate(String(n))`, which would produce an Invalid
            // Date.
            parsed[field] = value;
          } else {
            // Offset-less strings (Postgres `timestamp`, json_agg output) are
            // pinned to UTC so results don't depend on the server's time zone.
            parsed[field] = this.utcTimestamps ? parseDbDate(String(value)) : new Date(value as string);
          }
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
  // produced, then hands it to parseNestedRow, so parsed output is byte-
  // identical to the object path (same dates, same snake→camel, same recursion).
  // -------------------------------------------------------------------------

  /**
   * Get the Postgres type for a column (e.g. 'jsonb', 'text', '_int4').
   * Used to detect JSONB/array columns for specialized operators.
   * Uses pre-computed Map for O(1) lookup instead of linear scan.
   */
}
