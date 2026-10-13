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

import { acquireConnection, type Checkout, openCheckout } from '../checkout.js';
import { settleEventLoop } from '../connection-guard.js';
import { type ResolvedDiagnostics, resolveDiagnostics } from '../diagnostics.js';
import type { Dialect, StreamableConnection } from '../dialect.js';
import { assertDialectCapabilities, postgresDialect } from '../dialect.js';
import {
  explainConnectionLoss,
  INVARIANT_REPORT_HINT,
  InvariantError,
  isStaleConnectionError,
  NotFoundError,
  TimeoutError,
  UnsupportedFeatureError,
  ValidationError,
  wrapPgError,
} from '../errors.js';
import { missingIndexForRelation, schemaHasIndexInfo } from '../index-advisor.js';
import { consoleLogger, logTo, type TurbineLogger } from '../logger.js';
import {
  executeNestedCreate,
  executeNestedUpdate,
  extractRelationFields,
  hasRelationFields,
  type NestedWriteContext,
} from '../nested-write.js';
import type { PgCompatPool, PgCompatQueryConfig, PgCompatQueryResult } from '../pg-types.js';
import type { RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';
import { normalizeKeyColumns, snakeToCamel } from '../schema.js';
import { transactionClientFor } from '../transaction-client-slot.js';
import { type TransactionState, transactionStateOf, withSavepoint } from '../transaction-state.js';
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
import {
  assertMutationWhereIdentifiesOneRow,
  assertWhereIdentifiesOneRow,
  expandCompoundUniqueWhere,
  uniqueKeyNames,
  whereIdentifiesOneRow,
} from './compound-unique.js';
import { resolveExcludedFromCreate } from './expr.js';
import {
  cursorFieldValue,
  dedupeColumnList,
  dedupeOrderEntries,
  isEmptyOrderBy,
  isJsonPathOrderBy,
  isRelationPickOrderBy,
  isVectorOrderBy,
  normalizeOrderBy,
  operandColumnKind,
  orderByEntries,
  sortedEntries,
} from './filters.js';
import {
  assertCursorNotEmptied,
  assertCursorWritten,
  assertWhereNotEmptiedByPruning,
  hasCursor,
  isCursorInclusive,
  pruneUndefinedArgs,
} from './normalize-args.js';
import { warnUnknownQueryOptions } from './option-surface.js';
import { applyStableRelationOrderTo, normalizeWithClause, normalizeWithPagination } from './relation-names.js';
import * as relationsMod from './relations.js';
import {
  lockOnStreamMessage,
  lockOutsideTransactionMessage,
  lockWithDistinctMessage,
  type ResolvedRowLock,
  resolveRowLock,
} from './row-lock.js';
import { resolveSqlComment, type SqlCommenter } from './sql-comment.js';
import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  newStreamIdleState,
  resolveStreamIdleTimeout,
  StreamIdleGuard,
  type StreamIdleState,
  streamBackstopStatement,
  streamIdleExpiredError,
  watchStreamConnection,
} from './stream-idle.js';
import type {
  AggregateArgs,
  AggregateResultOf,
  CountArgs,
  CreateArgs,
  CreateManyArgs,
  DefaultInputTypes,
  DeleteArgs,
  DeleteManyArgs,
  FieldResult,
  FindManyArgs,
  FindManyStreamArgs,
  FindUniqueArgs,
  GlobalFilters,
  GroupByArgs,
  GroupByResult,
  JsonEncoding,
  JsonPathOrderBy,
  OrderByClause,
  OrderBySpec,
  OrderDirection,
  QueryResult,
  RelationLoadStrategy,
  RelationPickOrderBy,
  ResolvedSkipGlobalFilters,
  SkipGlobalFilters,
  TableInputTypes,
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
  assertMiddlewareArgsKept,
  availableClause,
  boundedPreparedName,
  canCancelBackend,
  isNodePostgresPool,
  isTemporalInfinity,
  LRUCache,
  normalizePagination,
  ownLookup,
  parseDbDate,
  readJsonFloat,
  readJsonFloatArray,
  readOnlyMiddlewareParams,
  readTextArray,
  resolveColumnName,
  resolveRelation,
  resolveRelationDef,
  type SqlCacheEntry,
  sendCancelRequest,
  sqlToPreparedName,
  unknownFieldMessage,
  warnRedundantSortTerm,
} from './utils.js';
import { resetWarnOnce, shouldWarnOnce, WARN_NS } from './warn-registry.js';
import type { BuilderCtx } from './where.js';
import * as whereMod from './where.js';
import type { WhereHost } from './where-compile.js';
import * as writesMod from './writes.js';

/**
 * SQL-cache lockstep cross-check.
 *
 * The SQL template cache requires three code paths to enumerate where-clause
 * keys identically: `fingerprintWhere` (builds the cache key),
 * `buildWhereClause` (builds SQL + `$N` params on a MISS), and
 * `collectWhereParams` (re-collects params on a HIT without rebuilding). Since
 * 0.36 all three consume ONE shared where-key walk (see `where-compile.ts`), so
 * enumeration drift is structurally eliminated; these checks remain as a
 * tripwire in case a future leaf builder or its collect mirror falls out of
 * step. Every failure is an {@link InvariantError} (E020), thrown before the
 * statement is sent.
 *
 * Two checks always run, whatever the diagnostics mode, because each costs one
 * array compare and the alternative is executing parameters known to be wrong:
 * - On a MISS, the params the build closure pushed are compared with the params
 *   the collect path produced (`sql-cache-lockstep`). The miss already paid
 *   for both walks, and a shape run once per instance is otherwise never
 *   compared at all.
 * - On a HIT, the collected param count must equal the count the entry was
 *   built with (`sql-cache-param-count`). Otherwise the server would reject
 *   the statement with a bind error that reads like a connection problem.
 *
 * The full rebuild-and-compare on a HIT follows the client's
 * `diagnostics.cacheCheck`, resolved once at construction (see diagnostics.ts;
 * the legacy `TURBINE_DISABLE_CACHE_CHECK` / `TURBINE_CACHE_CHECK_SAMPLE`
 * variables are read there and nowhere else):
 * - `'every-hit'` (the development default): every hit is compared, and a
 *   mismatch throws.
 * - `{ sample }`: that fraction of hits is compared (per-hit `Math.random()`;
 *   a sample of 1 compares every hit). A mismatch is logged at `error` once
 *   per distinct fingerprint, then throws.
 * - `'off'` (the production default): never rebuilt on a hit.
 */

/**
 * Warn-once namespace for the sampled cross-check's mismatch log, so a hot
 * mismatch logs exactly once per table and shape instead of flooding the log.
 * `'every-hit'` does not log (it throws immediately), so only the sampled path
 * records here. Keyed on the TABLE as well as the fingerprint: the fingerprint
 * alone carries no table, so a mismatch on one table used to silence the same
 * shape's mismatch on every other table. The shared registry also bounds the
 * set (`WARN_ONCE_CAP`) and is what `resetWarnOnce` clears.
 */
const CACHE_MISMATCH_WARN_NS = 'cacheMismatch';

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

/** One column of a cursor page's effective order, while it is being planned. */
interface CursorTerm {
  column: string;
  /** The key written into the rewritten orderBy (the caller's own, or the field name). */
  key: string;
  desc: boolean;
  nulls: 'first' | 'last' | undefined;
  nullable: boolean;
  /** Whether the NULL placement was written out by the planner. */
  pin?: boolean;
}

/** One column of a planned cursor seek. */
interface CursorKeysetTerm {
  column: string;
  desc: boolean;
  nullsFirst: boolean;
  nullable: boolean;
}

/** A planned `cursor` page (see `planCursor`). */
interface CursorPlan {
  mode: 'values' | 'row';
  terms: CursorKeysetTerm[];
  /** `values` mode: the coerced cursor value per term, `null` for SQL NULL. */
  values: unknown[];
  /** `row` mode: the cursor's own fields, which name one row. */
  lookup: { column: string; value: unknown }[];
  inclusive: boolean;
  fingerprint: string;
}

/** The `'auto'` per-relation partition of one `with` clause. */
interface AutoSplit {
  joinWith: WithClause;
  batchedWith: WithClause;
  engaged: AutoEngaged[];
}

/**
 * How many distinct `parseRow` column shapes one QueryInterface remembers.
 * Deliberately far smaller than the 1,000-entry SQL template cache: a shape is
 * a `select` / `omit` projection rather than a where-clause fingerprint, so the
 * realistic population is single digits per table, and the cost of a miss is
 * one rebuild rather than a re-parse on the server.
 */
const ROW_PLAN_CACHE_SIZE = 128;

/**
 * The largest `findManyStream` batch size for which the speculative first fetch
 * is still worth attempting. Equal to the default batch size, so the default
 * and everything below it behaves exactly as it always has. See the comment at
 * the speculation itself for why the bound is on `batchSize` rather than on the
 * probe's own limit.
 */
const STREAM_SPECULATION_MAX_BATCH = 1000;

/**
 * A `parseRow` decode plan: for one table and one exact column list, the
 * destination field name and whether temporal decoding applies, per column, in
 * the row's own key order. Parallel arrays rather than an array of records so
 * the hot loop reads three indexed slots and dereferences nothing.
 */
interface RowDecodePlan {
  readonly cols: readonly string[];
  readonly fields: readonly string[];
  readonly kinds: readonly number[];
}

/** Per-cell decode work in a {@link RowDecodePlan}. */
const CELL_PLAIN = 0;
const CELL_TEMPORAL = 1;
const CELL_FLOAT = 2;
const CELL_FLOAT_ARRAY = 3;
const CELL_TEXT_ARRAY = 4;
/** The dialect's own decode for a type whose storage differs (see `Dialect.decodeColumnValue`). */
const CELL_DIALECT = 5;

const FLOAT_TYPES = new Set(['float4', 'float8', 'real', 'double precision']);
const FLOAT_ARRAY_TYPES = new Set(['_float4', '_float8', 'float4[]', 'float8[]', 'real[]', 'double precision[]']);

/**
 * The decode a column of `pgType` needs beyond the driver's, other than
 * temporal: a float can arrive from JSON as "NaN" / "Infinity", and an enum
 * array, which the driver has no parser for, as array text.
 */
function cellKindOf(pgType: string, enums: Readonly<Record<string, unknown>> | undefined): number {
  if (FLOAT_TYPES.has(pgType)) return CELL_FLOAT;
  if (FLOAT_ARRAY_TYPES.has(pgType)) return CELL_FLOAT_ARRAY;
  const element = pgType.startsWith('_') ? pgType.slice(1) : pgType.endsWith('[]') ? pgType.slice(0, -2) : undefined;
  return element !== undefined && enums !== undefined && Object.hasOwn(enums, element) ? CELL_TEXT_ARRAY : CELL_PLAIN;
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
// Moved to ./filters.ts in 0.74.0 so PowqlInterface consumes the SAME
// predicate rather than a second copy of it. See applyStableRelationOrderTo.

/**
 * Marks `findMany` args built for a `findFirst`: one row, not a page, so
 * {@link QueryInterface.completePageOrder} leaves its order as written. A
 * symbol, so it survives the spreads at the args seam and no JSON body can
 * set it. Set through {@link firstRowOnly} only.
 */
const FIRST_ROW_ONLY: unique symbol = Symbol('turbine.firstRowOnly');

/**
 * The {@link FIRST_ROW_ONLY} mark for a read the caller bounded with neither
 * `limit` nor `offset`. An `offset` makes the row depend on which tied rows it
 * skipped, so `findFirst({ orderBy, offset })` is a page of one and gets the
 * page tiebreaker like any other page.
 */
function firstRowOnly(args: { limit?: unknown; offset?: unknown } | undefined): { [FIRST_ROW_ONLY]?: true } {
  return args?.limit === undefined && args?.offset === undefined ? { [FIRST_ROW_ONLY]: true } : {};
}

/** The largest delay `setTimeout` honours; Node fires anything larger after 1 ms. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** The accepted `relationLoadStrategy` values. */
const RELATION_LOAD_STRATEGIES: readonly RelationLoadStrategy[] = Object.freeze([
  'join',
  'batched',
  'auto',
  'flatten',
] as const);

/** A per-query `timeout`: milliseconds up to {@link MAX_TIMEOUT_MS}, or 0 for none (the same rule as `$transaction`). */
function isValidTimeout(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_TIMEOUT_MS;
}

/** A short, value-safe rendering of a rejected option value. */
function describeOptionValue(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}...` : value);
  return value === null ? 'null' : `a value of type ${typeof value}`;
}

function relationLoadStrategyMessage(value: unknown): string {
  return (
    `\`relationLoadStrategy\` must be one of ${RELATION_LOAD_STRATEGIES.map((v) => `'${v}'`).join(', ')} ` +
    `(received ${describeOptionValue(value)}).`
  );
}

/** A value the findUnique simple path may bind as it is: a primitive, Date or Buffer. */
function isFastPathScalar(value: unknown): boolean {
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'bigint':
    case 'boolean':
      return true;
    case 'object':
      return value instanceof Date || (value !== null && ArrayBuffer.isView(value));
    default:
      return false;
  }
}

/** Resolves a race when a deadline passes first. */
const TIMED_OUT: unique symbol = Symbol('timedOut');

/**
 * How long a statement that outlived its `timeout` gets, after the cancel
 * request is sent, to answer before its connection is destroyed instead of
 * reused. A cancel normally lands within a round trip or two.
 */
const CANCEL_GRACE_MS = 2000;

/** How a statement in flight ended. */
type Settled = { result: PgCompatQueryResult } | { error: unknown };

/**
 * One statement as it goes out: `sql` is the commentless text (what events
 * report and the template cache holds), `text` what is sent, which carries the
 * `sqlComment` when there is one, and `name` the prepared-statement name it is
 * sent under (see {@link QueryInterface.outgoing}).
 */
interface Outgoing {
  readonly sql: string;
  readonly text: string;
  readonly name: string | undefined;
  readonly comment: string | undefined;
}

/** Whether `err` is PostgreSQL's query_canceled (57014), as the driver raised it or as Turbine wrapped it. */
function isQueryCanceled(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } | null } | null;
  return e?.code === '57014' || e?.cause?.code === '57014';
}

/** The {@link DeferredQuery.rowLock} marker for a locking read, or nothing. */
function rowLockMarker(rowLock: ResolvedRowLock | undefined): { rowLock?: true } {
  return rowLock ? { rowLock: true } : {};
}

/** The two accepted {@link JsonEncoding} values, frozen so the check is total. */
const JSON_ENCODINGS: readonly JsonEncoding[] = Object.freeze(['object', 'positional'] as const);

/**
 * The relation JSON encoding a client on `dialect` gets when it names none.
 *
 * `'positional'` (`json_build_array`) where the engine has it (PostgreSQL),
 * `'object'` (`json_build_object`) everywhere else. The positional form drops
 * the repeated key names from every relation row: measured on a 50-parent /
 * ~10-child read against local PostgreSQL 17, server time 0.685 ms → 0.350 ms
 * and 152 KB → 100 KB on the wire, returning byte-identical parsed rows.
 *
 * Read from `capabilities.positionalJson`, never from whether the dialect has
 * `buildJsonArray`: that hook is on `postgresDialect` and every engine inherits
 * it by spreading, so a presence test would hand every engine the positional
 * default. `buildSelectWithRelations` (relations.ts) refuses `'positional'` on
 * the SAME flag, so the default can never select an encoding the builder then
 * refuses: one authority, not two.
 *
 * A wire-compatible engine that reaches this on `postgresDialect` itself
 * (CockroachDB, YugabyteDB, AlloyDB, Timescale, all of which are ADAPTERS over
 * the Postgres dialect rather than dialects of their own) gets `'positional'`,
 * which is correct: they speak `json_build_array`.
 */
function defaultJsonEncoding(dialect: Dialect): JsonEncoding {
  return dialect.capabilities.positionalJson ? 'positional' : 'object';
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

export class QueryInterface<
  T extends object,
  // biome-ignore lint/complexity/noBannedTypes: {} means "no relations known", intentional for untyped table access
  R extends object = {},
  M extends TableInputTypes = DefaultInputTypes<T, R>,
> {
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
  /**
   * The params the build closure pushed on the most recent MISS, held until
   * {@link crossCheckCache} compares them with the collected params and clears
   * them. `undefined` after a hit. Same single-flag reasoning as
   * {@link lastCacheHit}.
   */
  private lastMissParams: unknown[] | undefined;
  /**
   * Set while a build closure runs when the statement's WHERE (or HAVING)
   * carries a caller-written `AND`/`OR` combinator array, i.e. when its SQL text
   * is a function of an arity the caller chose. Read (and reset) by
   * {@link acquireSql}, which brackets the single `build()` call, so the flag
   * has no lifetime outside that synchronous window and cannot leak between
   * queries. See {@link BuilderCtx.markVariableArity} for the unbounded
   * server-side prepared-statement growth this exists to stop.
   */
  private variableArityShape = false;
  private readonly middlewares: MiddlewareFn[];
  /** The client's resolved `diagnostics` (see diagnostics.ts), fixed for this instance's life. */
  private readonly diagnostics: ResolvedDiagnostics;
  /** `streamIdleTimeoutMs`: how long a cursor stream may wait for its consumer. `0` disables. */
  private readonly streamIdleTimeoutMs: number;
  /** `sqlComment`, resolved; `undefined` when statements carry no comment (one falsy check per send). */
  private readonly sqlCommenter: SqlCommenter | undefined;
  /** Where this instance's log lines go: the client's `logger`, else the console logger. */
  private readonly logger: TurbineLogger;
  /**
   * {@link logger} when `diagnostics.advice` is on, else `undefined`. Every
   * per-query advice site starts with `const log = this.advice; if (!log)
   * return;`, so with advice off a site costs one property read and builds no
   * message.
   */
  private readonly advice: TurbineLogger | undefined;
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
  /**
   * The CLIENT-level nested-relation JSON encoding: what a query that names no
   * `jsonEncoding` of its own gets. `'positional'` on PostgreSQL, `'object'`
   * everywhere else (see {@link defaultJsonEncoding}).
   *
   * Read through {@link QueryInterface.currentJsonEncoding}, never directly, so
   * a per-query override cannot be missed by one reader.
   */
  private readonly jsonEncoding: JsonEncoding;
  /**
   * The encoding the query BEING BUILT resolved to, i.e. its own
   * `jsonEncoding` or {@link QueryInterface.jsonEncoding}.
   *
   * Reassigned per `build*` call and exposed on the {@link BuilderCtx} as a live
   * getter, exactly like {@link QueryInterface.currentSkip} and for the same
   * reason: relations.ts reads the encoding from four places deep inside the
   * SELECT walk, and threading it through every one of them as a parameter
   * would be four chances to forget it.
   *
   * Safe because a build is SYNCHRONOUS from the assignment to the last read:
   * `buildFindMany` / `buildFindUnique` return a fully-formed DeferredQuery
   * whose parser closure already captured the shapes, so nothing reads this
   * field after the build returns and no two builds can interleave on it.
   */
  private currentJsonEncoding: JsonEncoding;
  /**
   * `parseRow` decode plans, keyed by table plus the exact column list. Bounded
   * like the SQL template cache and for the same reason: the shapes come from
   * `select` / `omit`, which is usually a handful of literals in the caller's
   * source but can be assembled per request from user input, so the key space
   * is not provably finite. Eviction only ever costs a rebuild.
   */
  private readonly rowPlanCache = new LRUCache<string, RowDecodePlan>(ROW_PLAN_CACHE_SIZE);
  /**
   * The most recent plan per table, which is the entry `parseRow` actually
   * probes. One result set is one shape, so this hits for every row after the
   * first without hashing a cache key per row.
   */
  private readonly rowPlanLast = new Map<string, RowDecodePlan>();
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

  /** Per-table memo of {@link cellKindOf}, keyed by column name and field name. */
  private readonly cellKindCache = new Map<string, Map<string, number>>();
  /** The dialect decode of each {@link CELL_DIALECT} column, by table, then by column and field name. */
  private readonly dialectDecodeCache = new Map<string, Map<string, (value: unknown) => unknown>>();

  /**
   * Per-table memo of `Object.entries(meta.relations)`, consumed by the nested
   * row parser (see `getRelationEntries` in relations.ts). Same rationale and
   * same lifetime as {@link camelDateFieldCache}: the metadata is immutable, and
   * the parser reads it once per row.
   */
  private readonly relationEntryCache = new Map<string, [string, RelationDef][]>();

  /** Per-table memo of batched-loader child readers (see {@link batchedChild}). */
  private readonly batchedChildCache = new Map<string, BatchedChildReader>();
  /** The (option-invariant) options every batched child is built with. */
  private batchedChildOptions?: QueryInterfaceOptions;

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
    private readonly pool: PgCompatPool,
    private readonly table: string,
    private readonly schema: SchemaMetadata,
    middlewares?: MiddlewareFn[],
    options?: QueryInterfaceOptions,
  ) {
    const meta = schema.tables[table];
    if (!meta) {
      throw new ValidationError(
        `Unknown table "${table}". ${availableClause(Object.keys(schema.tables), 'The schema has no tables.')}`,
      );
    }
    this.tableMeta = meta;
    this.middlewares = middlewares ?? [];
    // Resolved by the client once; a QueryInterface built directly (tests,
    // tooling) resolves here, at construction, never per call.
    this.diagnostics = resolveDiagnostics(options?.diagnostics);
    this.logger = options?.logger ?? consoleLogger;
    this.advice = this.diagnostics.advice ? this.logger : undefined;
    this.defaultLimit = options?.defaultLimit;
    this.streamIdleTimeoutMs =
      resolveStreamIdleTimeout(options?.streamIdleTimeoutMs, 'streamIdleTimeoutMs') ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
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
    assertDialectCapabilities(this.dialect);
    this.sqlCommenter =
      options?._sqlCommenter ??
      resolveSqlComment(options?.sqlComment, this.logger, {
        dialect: this.dialect.name,
        preparesEveryStatement: this.dialect.capabilities.preparesEveryStatement,
        buildsSql: true,
      });
    if (
      options?.relationLoadStrategy !== undefined &&
      !RELATION_LOAD_STRATEGIES.includes(options.relationLoadStrategy as never)
    ) {
      throw new ValidationError(relationLoadStrategyMessage(options.relationLoadStrategy));
    }
    this.relationLoadStrategy = options?.relationLoadStrategy ?? 'auto';
    this.stableRelationOrder = options?.stableRelationOrder === true;
    this.implicitPkOrdering = options?.implicitPkOrdering === true;
    const autoToOne = options?.autoToOneJoinMaxRows;
    this.autoToOneJoinMaxRowsOption =
      autoToOne !== undefined && Number.isFinite(autoToOne) && autoToOne >= 0 ? Math.floor(autoToOne) : undefined;
    const rtt = options?.autoRoundTripMs;
    this.autoRoundTripMs = rtt !== undefined && Number.isFinite(rtt) && rtt > 0 ? rtt : undefined;
    this.jsonEncoding = options?.jsonEncoding ?? defaultJsonEncoding(this.dialect);
    this.currentJsonEncoding = this.jsonEncoding;
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
      diagnostics: this.diagnostics,
      logger: this.logger,
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
      markVariableArity: () => {
        this.variableArityShape = true;
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
      // LIVE getter, not a copied value: `jsonEncoding` is now a per-query
      // option, so the module-facing view must see the encoding of the query
      // being built rather than the one the client was constructed with. Same
      // shape and same reason as `currentSkip` above.
      get jsonEncoding(): JsonEncoding {
        return self.currentJsonEncoding;
      },
      camelDateFieldCache: this.camelDateFieldCache,
      relationEntryCache: this.relationEntryCache,
      limitOneClause: () => this.limitOneClause(),
      buildPagination: (limitPh, offsetPh, hasOrderBy) => this.buildPagination(limitPh, offsetPh, hasOrderBy),
      paginationRef: (value: unknown, params: unknown[], arg: string) => this.paginationRef(value, params, arg),
      paginationValue: (value: unknown, arg: string) => this.paginationValue(value, arg),
    };
  }

  /**
   * Advice (`diagnostics.advice`), once per table: the columns whose database type is absent from
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
   * PostgreSQL only: the zone-less `timestamp` rewrite is Postgres-gated (see
   * `utcDateTimeRewrite` in where.ts), so on the other engines a missing type
   * costs only the `date` rewrite. Silent when `diagnostics.advice` is off
   * (the production default) like the other advice, and deduped through the
   * shared registry, so a hot table logs one line for the process.
   *
   * Cannot throw on odd metadata: it walks `tableMeta.columns`, the array the
   * constructor loop above has already iterated (and that client.ts validates
   * as an array), never `dateColumns`, which is a `Set` in every first-party
   * metadata path but arrives as a plain object from JSON-round-tripped
   * metadata. An advisory diagnostic that crashes a shape production would serve
   * is worse than the bug it reports.
   */
  private warnUntypedColumns(): void {
    const log = this.advice;
    if (!log) return;
    if (!this.dialect.capabilities.utcTimestampRewrite) return;
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
    logTo(
      log,
      'warn',
      `table "${this.table}": no database type in metadata for column(s) ${named}${rest} (neither the ` +
        "column entry's `dialectType`/`pgType` nor the table-level `dialectTypes`/`pgTypes` map). Turbine cannot " +
        'tell which of them are zone-less, so it skips the UTC bind rewrite and a `Date` goes to the driver ' +
        "as-is: right for `timestamptz`, but a zone-less `date`/`timestamp` then stores the PROCESS's local " +
        'calendar fields rather than UTC (silently, since the read path shifts back by the same offset), and a ' +
        '`time`/`timetz` column rejects the value outright (`22007 invalid input syntax for type time`). ' +
        'Columns whose type IS resolved, every `timestamptz` among them, are unaffected. Fix: regenerate with ' +
        '`npx turbine generate`, or set the column types in `defineSchema`.',
      { code: 'untyped-columns', table: this.table, columns: untyped },
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
      throw new ValidationError(`${arg} on "${this.table}" must be a non-negative integer, received: ${String(value)}`);
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
   * Resolve one query's relation JSON encoding and PIN it for the build, so
   * every reader inside relations.ts sees the same answer.
   *
   * Called at the TOP of each entry point that can emit or decode relation JSON
   * (`buildFindMany`, `buildFindUnique`, `makeStreamRowParser`), before the
   * cache key is assembled and before the flatten plan is consulted, because
   * both of those depend on the answer.
   *
   * An unrecognized value THROWS (E003) rather than falling back. A per-query
   * option that is silently ignored when misspelled is the exact failure this
   * package has been bitten by before (see query/option-surface.ts), and here it
   * would be invisible: the wrong encoding still returns correct rows, just
   * without the saving the caller asked for, or with the flatten plan they were
   * trying to re-enable still refused. Thrown before the SQL cache is consulted
   * so a warm template can never serve a call the cold path would refuse.
   */
  private resolveJsonEncoding(argEncoding: JsonEncoding | undefined): JsonEncoding {
    if (argEncoding === undefined) {
      this.currentJsonEncoding = this.jsonEncoding;
      return this.currentJsonEncoding;
    }
    if (!JSON_ENCODINGS.includes(argEncoding)) {
      throw new ValidationError(
        `Invalid \`jsonEncoding\` on "${this.table}": ${JSON.stringify(argEncoding)}. ` +
          `Expected ${JSON_ENCODINGS.map((e) => `'${e}'`).join(' or ')}.`,
      );
    }
    this.currentJsonEncoding = argEncoding;
    return argEncoding;
  }

  /**
   * `args` with every `with` relation key replaced by the relation's DECLARED
   * spelling, so a snake_case relation name resolves the way a snake_case
   * column name already does.
   *
   * Returns `args` by reference when nothing needed rewriting, which is every
   * query that already spells its relations the declared way. Runs before the
   * stable-order pass and before `withFingerprint`, so the whole pipeline, and
   * the SQL cache key with it, sees one spelling. The rule and the reason it is
   * applied ONCE here rather than at each of the six `with` walkers are in
   * query/relation-names.ts.
   */
  private withDeclaredRelationNames<A extends object | undefined>(args: A): A {
    const withClause = (args as { with?: unknown } | undefined)?.with;
    if (!withClause) return args;
    const normalized = normalizeWithClause(this.schema, this.table, withClause as WithClause);
    return normalized === withClause ? args : ({ ...args, with: normalized } as A);
  }

  /**
   * `args` with `take` / `skip` folded into `limit` / `offset` at every `with`
   * level (see `normalizeWithPagination` in query/relation-names.ts). Runs after
   * the relation-name pass, so it resolves the declared spelling.
   */
  private withRelationPagination<A extends object | undefined>(args: A): A {
    const withClause = (args as { with?: unknown } | undefined)?.with;
    if (!withClause) return args;
    const normalized = normalizeWithPagination(this.schema, this.table, withClause as WithClause);
    return normalized === withClause ? args : ({ ...args, with: normalized } as A);
  }

  /**
   * Caller args in canonical form: `undefined` pruned (query/normalize-args.ts),
   * declared relation spellings, and the Prisma pagination aliases folded into
   * `limit` / `offset`, with `take` / `skip` folded inside every `with` level too.
   *
   * Called at the seam of EVERY public operation and its `build*` twin, so the
   * guards, the fingerprint, the build and the collect all read one shape. Each
   * step returns its input by reference when there was nothing to change, so a
   * second call on already-normalized args is free and the common path
   * allocates nothing.
   *
   * `refuseEmptiedWhere` names the single-row read (`findFirst`,
   * `findFirstOrThrow`) that refuses a `where` whose every key was `undefined`.
   */
  private normalizeArgs<A extends object | undefined>(args: A, refuseEmptiedWhere?: string): A {
    const pruned = pruneUndefinedArgs(this.schema, this.table, args);
    if (pruned !== args) {
      if (refuseEmptiedWhere) assertWhereNotEmptiedByPruning(this.table, refuseEmptiedWhere, args, pruned);
      assertCursorNotEmptied(this.table, args, pruned);
    }
    if (pruned) this.assertQueryOptions(pruned);
    return normalizePagination(this.withRelationPagination(this.withDeclaredRelationNames(pruned)));
  }

  /**
   * Validate the per-query options whose bad values used to be ignored or
   * misread: `timeout` (Node clamps a non-positive, non-finite or oversized
   * delay to 1 ms) and `relationLoadStrategy`.
   */
  private assertQueryOptions(args: object): void {
    const { timeout, relationLoadStrategy } = args as { timeout?: unknown; relationLoadStrategy?: unknown };
    if (timeout !== undefined && !isValidTimeout(timeout)) {
      throw new ValidationError(
        `\`timeout\` on ${this.table} must be a positive number of milliseconds up to ${MAX_TIMEOUT_MS}, or 0 for ` +
          `no timeout (received ${describeOptionValue(timeout)}). Leave it out for no timeout.`,
      );
    }
    if (relationLoadStrategy !== undefined && !RELATION_LOAD_STRATEGIES.includes(relationLoadStrategy as never)) {
      throw new ValidationError(relationLoadStrategyMessage(relationLoadStrategy));
    }
  }

  /**
   * Refuse a `findUnique` whose `where` names no unique key. The rule and the
   * message live in query/compound-unique.ts, beside the definition of what
   * counts as unique and shared with the PowDB engine.
   */
  private assertFindUniqueKey(where: Record<string, unknown> | undefined): void {
    assertWhereIdentifiesOneRow(this.tableMeta, this.table, where);
  }

  /**
   * Refuse a locking read that is not inside a transaction, at the execute
   * entry of each find method and before any strategy runs. The `build*`
   * methods accept `lock` (the SQL is right wherever it runs); executing it
   * in autocommit releases the lock before the caller sees the rows.
   *
   * The value is validated first, so an engine with no row locks answers
   * E017 rather than asking for a transaction it would also refuse.
   * "Inside a transaction" is `_txScoped`: the accessors a TransactionClient
   * hands out, at any nesting depth.
   */
  private assertLockInTransaction(args: { lock?: unknown } | undefined, operation: string): void {
    if (args?.lock === undefined) return;
    resolveRowLock(args.lock, this.dialect, this.table);
    if (!this.txScoped) throw new ValidationError(lockOutsideTransactionMessage(this.table, operation));
  }

  /** Refuse `lock` on a streaming read (a cursor is not a locking read). */
  private assertNoStreamLock(args: object | undefined, operation: string): void {
    if ((args as { lock?: unknown } | undefined)?.lock !== undefined) {
      throw new ValidationError(lockOnStreamMessage(this.table, operation));
    }
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
    // The transform itself lives in ./relation-names.ts as of 0.74.0, so PowDB
    // runs the SAME rule instead of a second copy that accepted the option and
    // did nothing.
    return applyStableRelationOrderTo(this.schema, withClause, table, depth);
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

  /** Memo for {@link totalOrderKeys}; table metadata is immutable. */
  private totalOrderKeysMemo: string[][] | undefined;

  /**
   * The unique keys whose columns are all NOT NULL, primary key first: the
   * column sets that make an order total (no two rows can tie on them).
   */
  private totalOrderKeys(): string[][] {
    if (this.totalOrderKeysMemo) return this.totalOrderKeysMemo;
    const meta = this.tableMeta;
    const nullable = (column: string): boolean =>
      !meta.primaryKey.includes(column) && meta.columns.find((c) => c.name === column)?.nullable === true;
    this.totalOrderKeysMemo = uniqueKeyNames(meta).filter((cols) => cols.every((c) => !nullable(c)));
    return this.totalOrderKeysMemo;
  }

  /**
   * THE tiebreaker rule, shared by cursor pages ({@link planCursor}) and the
   * pages before them ({@link completePageOrder}), so every page of one walk
   * is cut from the same total order: the columns to append to an order over
   * `ordered` so that no two rows tie. `[]` when the order already contains a
   * unique NOT NULL key; the first such key's missing columns otherwise;
   * `undefined` when the table has none.
   */
  private tiebreakColumns(ordered: ReadonlySet<string>): string[] | undefined {
    const keys = this.totalOrderKeys();
    if (keys.some((cols) => cols.every((c) => ordered.has(c)))) return [];
    return keys[0]?.filter((c) => !ordered.has(c));
  }

  /**
   * A paginated `findMany` (`limit` / `offset`) whose `orderBy` can tie gets
   * the tiebreaker appended, in the last term's direction, so a page boundary
   * cannot fall between tied rows in a different order on each page (skipping
   * or repeating one), and the first page of a cursor walk uses the order its
   * cursor pages use. Returns `args` itself when the order is already total,
   * the query is not paginated, or it pages by `cursor` or `distinct`, which
   * order themselves. A `findFirst` with no `offset` is one row, not a page,
   * and is left alone.
   *
   * An order containing a vector distance gets no tiebreaker: a KNN index
   * serves only `ORDER BY <distance> LIMIT k`, a compound order turns that
   * into a scan and sort of the whole table, and two equal distances are
   * rare. A `cursor` still refuses such an order (see {@link planCursor}).
   */
  private completePageOrder<
    A extends { orderBy?: unknown; limit?: unknown; offset?: unknown; cursor?: unknown; distinct?: unknown[] },
  >(args: A): A {
    if (args.orderBy === undefined || (args.limit === undefined && args.offset === undefined)) return args;
    if (hasCursor(args.cursor) || (args.distinct && args.distinct.length > 0)) return args;
    if ((args as { [FIRST_ROW_ONLY]?: true })[FIRST_ROW_ONLY]) return args;
    const entries = orderByEntries(args.orderBy).filter(([, d]) => d !== undefined);
    if (entries.some(([, d]) => isVectorOrderBy(d))) return args;
    const ordered = new Set<string>();
    let lastDesc = false;
    for (const [key, dir] of entries) {
      lastDesc = false;
      if (isVectorOrderBy(dir) || isJsonPathOrderBy(dir) || this.isRelationOrderByValue(dir)) continue;
      const column = resolveColumnName(this.tableMeta, key);
      if (column === undefined) continue;
      ordered.add(column);
      lastDesc = normalizeOrderBy(dir as OrderDirection | OrderBySpec).dir === 'DESC';
    }
    const missing = this.tiebreakColumns(ordered);
    if (!missing || missing.length === 0) return args;
    const dir: OrderDirection = lastDesc ? 'desc' : 'asc';
    const field = (column: string): string => this.tableMeta.reverseColumnMap[column] ?? column;
    return {
      ...args,
      orderBy: [...entries.map(([k, v]) => ({ [k]: v })), ...missing.map((c) => ({ [field(c)]: dir }))],
    };
  }

  /**
   * Plan a `cursor` page: THE single authority the cache key, the SQL build and
   * the cache-hit param collect all read, so the three cannot disagree.
   *
   * The page is ordered by the EFFECTIVE order: the caller's `orderBy` plus a
   * tiebreaker (the primary key, else a unique key on NOT NULL columns) when
   * the orderBy does not already end in one, in the last term's direction. A
   * cursor query is always ordered, because a seek over rows the engine may
   * return in any order skips and repeats rows. `args.orderBy` is rewritten to
   * that order (by reference when nothing changes).
   *
   * Two ways to place the page, picked from what the cursor carries:
   *  - VALUES: the cursor has a value for every column of the effective order,
   *    so the seek compares against them directly (`col > $1`, expanded to a
   *    keyset across several columns). Extra cursor fields are ignored.
   *  - ROW: otherwise the cursor must identify one row by a unique key (the
   *    findUnique rule), and the seek reads that row's ordered values in
   *    scalar subqueries, guarded by `EXISTS` so a deleted cursor row gives an
   *    empty page rather than a wrong one.
   * Anything else is refused (E003) naming the missing fields.
   *
   * NULL sort keys are placed where the engine sorts them (PostgreSQL: last
   * ascending, first descending; SQLite / MySQL / SQL Server: NULL is smallest)
   * or where an explicit `nulls` puts them, and each row is visited exactly
   * once. On PostgreSQL a nullable ordered column has its placement written
   * out, so a Postgres-compatible engine with a different default reads the
   * same order the seek assumes.
   */
  private planCursor<A extends { cursor?: unknown; orderBy?: unknown }>(
    args: A,
  ): { args: A; plan: CursorPlan | undefined } {
    const raw = args.cursor;
    if (!hasCursor(raw)) return { args, plan: undefined };
    const meta = this.tableMeta;
    const field = (column: string): string => meta.reverseColumnMap[column] ?? column;
    const nullableColumn = (column: string): boolean =>
      !meta.primaryKey.includes(column) && meta.columns.find((c) => c.name === column)?.nullable === true;

    // The cursor's own values, by resolved column (either spelling, or a
    // compound-unique selector, is accepted). Each is a row's value, checked
    // by the rule every engine shares (cursorFieldValue).
    const flat = expandCompoundUniqueWhere(meta, raw as Record<string, unknown>);
    const cursorValues = new Map<string, unknown>();
    for (const [key, written] of sortedEntries(flat)) {
      if (written === undefined) continue;
      const column = this.toColumn(key);
      const value = cursorFieldValue(key, written, {
        column,
        table: this.table,
        kind: operandColumnKind(this.getColumnPgType(column)),
        nullable: nullableColumn(column),
      });
      cursorValues.set(column, value);
    }
    if (cursorValues.size === 0) return { args, plan: undefined };

    // The caller's order, plain columns only: a relation, JSON-path or vector
    // ordering has no value a seek can compare against.
    const terms: CursorTerm[] = [];
    const orderEntries = orderByEntries(args.orderBy).filter(([, d]) => d !== undefined);
    for (const [key, dir] of orderEntries) {
      if (isVectorOrderBy(dir) || isJsonPathOrderBy(dir) || this.isRelationOrderByValue(dir)) {
        throw new ValidationError(
          `findMany on "${this.table}" refused: \`cursor\` cannot page past the orderBy entry "${key}", which ` +
            'orders by a relation, a JSON path or a vector distance rather than a column. Order the cursor ' +
            'query by columns only, or page it with `offset`.',
        );
      }
      const column = this.toColumn(key);
      if (terms.some((t) => t.column === column)) continue;
      const { dir: d, nulls } = normalizeOrderBy(dir as OrderDirection | OrderBySpec);
      terms.push({ column, key, desc: d === 'DESC', nulls, nullable: nullableColumn(column) });
    }

    // Tiebreaker, the same one a first page gets (see tiebreakColumns).
    const tiebreak = this.tiebreakColumns(new Set(terms.map((t) => t.column)));
    if (!tiebreak) {
      throw new ValidationError(
        `findMany on "${this.table}" refused: a \`cursor\` page needs an order with no ties, and "${this.table}" ` +
          'has no primary key or unique key on NOT NULL columns to break them. Add a primary key, or page ' +
          'this table with `offset`.',
      );
    }
    const desc = terms.length > 0 ? terms[terms.length - 1]!.desc : false;
    for (const column of tiebreak) {
      terms.push({ column, key: field(column), desc, nulls: undefined, nullable: false });
    }
    const appended = tiebreak.length > 0;

    // Where NULLs sort, per term. Where the engine sorts them high (PostgreSQL)
    // a nullable column's placement is written out, so a Postgres-compatible
    // engine with a different default reads the order the seek assumes.
    const { nullsSortHigh, nullsOrderingClause } = this.dialect.capabilities;
    const pinNulls = nullsSortHigh && nullsOrderingClause;
    let pinned = false;
    for (const t of terms) {
      if (t.nulls === undefined && t.nullable && pinNulls) {
        t.nulls = t.desc ? 'first' : 'last';
        t.pin = true;
        pinned = true;
      }
    }
    const nullsFirst = (t: CursorTerm): boolean =>
      t.nulls !== undefined ? t.nulls === 'first' : nullsSortHigh ? t.desc : !t.desc;

    let nextArgs = args;
    if (appended || pinned) {
      const orderBy = terms.map((t) => {
        const dir = t.desc ? 'desc' : 'asc';
        const original = orderEntries.find(([k]) => k === t.key)?.[1];
        return { [t.key]: t.pin ? { sort: dir, nulls: t.nulls } : (original ?? dir) };
      });
      nextArgs = { ...args, orderBy };
    }

    const inclusive = isCursorInclusive(args);
    const coerce = (column: string, value: unknown): unknown =>
      whereMod.coerceWhereOperand(this.ctx, meta, column, value);
    const keysetTerms: CursorKeysetTerm[] = terms.map((t) => ({
      column: t.column,
      desc: t.desc,
      nullsFirst: nullsFirst(t),
      nullable: t.nullable,
    }));

    // An inclusive cursor (prisma-compat) names a ROW, as Prisma's does, so it
    // always reads that row: a deleted cursor row gives an empty page, never a
    // page placed where the row used to be.
    const namesRow = inclusive && whereIdentifiesOneRow(meta, flat);
    if (!namesRow && terms.every((t) => cursorValues.has(t.column))) {
      const values = terms.map((t) => {
        const v = cursorValues.get(t.column);
        return v === null ? null : coerce(t.column, v);
      });
      const fp =
        `v:${keysetTerms.map((t, i) => `${t.column}:${t.desc ? 'd' : 'a'}${t.nullable ? (t.nullsFirst ? 'f' : 'l') : ''}${values[i] === null ? '0' : ''}`).join(',')}` +
        (inclusive ? ':i' : '');
      return {
        args: nextArgs,
        plan: { mode: 'values', terms: keysetTerms, values, lookup: [], inclusive, fingerprint: fp },
      };
    }

    if (!whereIdentifiesOneRow(meta, flat)) {
      const missing = terms.filter((t) => !cursorValues.has(t.column)).map((t) => `"${field(t.column)}"`);
      const order = terms.map((t) => `${field(t.column)} ${t.desc ? 'desc' : 'asc'}`).join(', ');
      const keys = uniqueKeyNames(meta).map((cols) =>
        cols.length === 1 ? `{ ${field(cols[0]!)} }` : `{ ${cols.map(field).join(', ')} }`,
      );
      throw new ValidationError(
        `findMany on "${this.table}" refused: the \`cursor\` has no value for ${missing.join(', ')}, which the ` +
          `page order (${order}) needs, and it does not name one row by a unique key. Give the cursor a value ` +
          `for every ordered field, or name the cursor row by ${keys.length > 0 ? keys.join(' or ') : 'a unique key'}.`,
      );
    }
    const lookup = [...cursorValues].map(([column, v]) => ({ column, value: v === null ? null : coerce(column, v) }));
    const fp =
      `r:${keysetTerms.map((t) => `${t.column}:${t.desc ? 'd' : 'a'}${t.nullable ? (t.nullsFirst ? 'f' : 'l') : ''}`).join(',')}` +
      `|k=${lookup.map((l) => `${l.column}${l.value === null ? '0' : ''}`).join(',')}` +
      (inclusive ? ':i' : '');
    return {
      args: nextArgs,
      plan: { mode: 'row', terms: keysetTerms, values: [], lookup, inclusive, fingerprint: fp },
    };
  }

  /**
   * Render a {@link CursorPlan}'s seek predicate, pushing its params. Run by
   * the build AND by the cache-hit collect (which discards the SQL), so the two
   * cannot bind different params.
   *
   * Each value is bound once and referenced by every branch that needs it. One
   * non-null column is the plain `col > $1`; several expand to
   * `(c1 > $1 OR (c1 = $1 AND c2 > $2) OR ...)`, with `<` for a descending
   * column (a row-value comparison cannot mix directions, and SQL Server has
   * none). A nullable column gets NULL-aware equality and "after" terms.
   */
  private renderCursorPredicate(plan: CursorPlan, params: unknown[]): string {
    const qt = this.q(this.table);
    const col = (t: CursorKeysetTerm) => `${qt}.${this.q(t.column)}`;
    let ref: (i: number) => string | null;
    let guard = '';
    if (plan.mode === 'values') {
      const refs = plan.values.map((v) => {
        if (v === null) return null;
        params.push(v);
        return this.p(params.length);
      });
      ref = (i) => refs[i] ?? null;
    } else {
      const alias = 'cursor_row';
      const conds = plan.lookup.map((l) => {
        if (l.value === null) return `${alias}.${this.q(l.column)} IS NULL`;
        params.push(l.value);
        return `${alias}.${this.q(l.column)} = ${this.p(params.length)}`;
      });
      const gf = whereMod.targetGlobalFilterAlias(this.ctx, this.table, alias, params);
      if (gf) conds.push(gf);
      const from = `FROM ${qt} ${alias} WHERE ${conds.join(' AND ')}`;
      ref = (i) => `(SELECT ${alias}.${this.q(plan.terms[i]!.column)} ${from})`;
      guard = `EXISTS (SELECT 1 ${from})`;
    }

    // Value mode knows each value; row mode knows only whether the column can
    // hold NULL, so its comparisons stay NULL-aware for nullable columns.
    const rowMode = plan.mode === 'row';
    const eq = (i: number): string => {
      const t = plan.terms[i]!;
      const r = ref(i);
      if (r === null) return `${col(t)} IS NULL`;
      if (rowMode && t.nullable) return `(${col(t)} = ${r} OR (${col(t)} IS NULL AND ${r} IS NULL))`;
      return `${col(t)} = ${r}`;
    };
    const after = (i: number, orEqual: boolean): string | null => {
      const t = plan.terms[i]!;
      const r = ref(i);
      const op = `${t.desc ? '<' : '>'}${orEqual ? '=' : ''}`;
      if (r === null) return t.nullsFirst ? `${col(t)} IS NOT NULL` : null;
      if (!t.nullable) return `${col(t)} ${op} ${r}`;
      if (rowMode) {
        return t.nullsFirst
          ? `((${r} IS NULL AND ${col(t)} IS NOT NULL) OR ${col(t)} ${op} ${r})`
          : `(${r} IS NOT NULL AND (${col(t)} ${op} ${r} OR ${col(t)} IS NULL))`;
      }
      return t.nullsFirst ? `${col(t)} ${op} ${r}` : `(${col(t)} ${op} ${r} OR ${col(t)} IS NULL)`;
    };

    const n = plan.terms.length;
    const last = n - 1;
    // An inclusive page folds "equal on every column" into the last branch when
    // that column is NOT NULL and its value known non-null (`>=`); otherwise it
    // is its own branch.
    const foldEqual = plan.inclusive && !plan.terms[last]!.nullable && ref(last) !== null;
    const branches: string[] = [];
    for (let i = 0; i < n; i++) {
      const a = after(i, foldEqual && i === last);
      if (a === null) continue;
      if (i === 0) branches.push(a);
      else branches.push(`(${[...plan.terms.slice(0, i).map((_, j) => eq(j)), a].join(' AND ')})`);
    }
    if (plan.inclusive && !foldEqual) {
      branches.push(n === 1 ? eq(0) : `(${plan.terms.map((_, j) => eq(j)).join(' AND ')})`);
    }
    const keyset =
      branches.length === 0 ? '1 = 0' : branches.length === 1 ? branches[0]! : `(${branches.join(' OR ')})`;
    return guard ? `(${guard} AND ${keyset})` : keyset;
  }

  /**
   * Whether a findMany paginates (`limit` / `take` / `offset`) but declares no
   * ordering, which makes the returned page NON-DETERMINISTIC: Postgres is
   * free to return different rows for the same unordered `LIMIT` once the heap
   * changes underneath it, so a row can appear on two pages or on none.
   *
   * A `cursor` page never counts: it is always ordered by its effective order
   * (see {@link planCursor}). An empty orderBy (`[]`, or an object whose every
   * value is `undefined`) counts as absent, because it emits no ordering.
   *
   * `distinct` is still excluded: that path re-orders in an outer wrapper around
   * a `DISTINCT ON` whose ordering picks the representative row, so an implicit
   * key would change which rows come back, not just their order.
   */
  private isUnorderedPage(args?: {
    limit?: number;
    offset?: number;
    cursor?: unknown;
    orderBy?: unknown;
    distinct?: unknown;
  }): boolean {
    if (!args) return false;
    if (args.distinct !== undefined) return false;
    if (hasCursor(args.cursor)) return false;
    if (!isEmptyOrderBy(args.orderBy)) return false;
    return args.limit !== undefined || args.offset !== undefined;
  }

  /**
   * Opt-in (`implicitPkOrdering`) primary-key ascending ordering for a paginating
   * findMany that declares no `orderBy`, making its pages deterministic.
   *
   * OFF by default in CORE, deliberately: turning it on would add an `ORDER BY`
   * to SQL that existing applications already emit, changing both the rows a
   * given page returns and the plan the engine picks. The
   * `turbine-orm/prisma-compat` layer defaults it ON instead, because reproducing
   * Prisma's semantics is that layer's whole contract.
   *
   * An explicit `orderBy` always wins, a PK-less table is left alone (nothing
   * stable to order by), and a composite PK orders on every column in
   * declaration order. A `cursor` page is ordered by its own plan, not here, and
   * `distinct` shapes are skipped (see {@link isUnorderedPage}). With the flag
   * off this returns `undefined` before touching anything.
   */
  private implicitPkOrderBy(args?: {
    limit?: number;
    offset?: number;
    cursor?: unknown;
    orderBy?: unknown;
    distinct?: unknown;
  }): WithOrderByObject | WithOrderByObject[] | undefined {
    if (!this.implicitPkOrdering) return undefined;
    if (!this.isUnorderedPage(args)) return undefined;
    return this.pkOrderBy();
  }

  /**
   * Advice (`diagnostics.advice`), once per query shape: an unordered paginating findMany returns a
   * non-deterministic page (see {@link isUnorderedPage}), and on real data it is
   * also usually the slower plan (an unordered `LIMIT` can discard tens of
   * thousands of heap rows that an index scan on the key would have skipped).
   *
   * Gated exactly like the other advice (silent when `diagnostics.advice` is
   * off) and consistent with `warnOnUnlimited`: a per-call
   * `warnOnUnlimited: false` silences it, `true` forces it past a config-level
   * opt-out, and a config/per-table `warnOnUnlimited: false` silences it. Deduped
   * process-wide through the shared warn registry, so it can never spam.
   *
   * Suppressed only when `implicitPkOrdering` will ACTUALLY order this query.
   * The flag being on is not enough: a PK-less table gets no injected
   * ordering, and that is precisely the shape that still needs saying out loud.
   */
  private maybeWarnUnorderedPage(args?: {
    limit?: number;
    offset?: number;
    cursor?: unknown;
    orderBy?: unknown;
    distinct?: unknown;
    warnOnUnlimited?: boolean;
  }): void {
    const log = this.advice;
    if (!log) return;
    if (this.implicitPkOrdering && this.implicitPkOrderBy(args) !== undefined) return;
    const perCall = args?.warnOnUnlimited;
    if (perCall === false) return;
    if (perCall === undefined && !this.warnOnUnlimited) return;
    if (!this.isUnorderedPage(args)) return;
    const shape = [args?.limit !== undefined ? 'limit' : '', args?.offset !== undefined ? 'offset' : '']
      .filter(Boolean)
      .join('+');
    if (!shouldWarnOnce(WARN_NS.unorderedPage, `${this.table}|${shape}`)) return;
    const pk = (this.tableMeta.primaryKey ?? []).map((c) => this.tableMeta.reverseColumnMap[c] ?? c);
    const asOrderBy = pk.length === 1 ? `{ ${pk[0]}: 'asc' }` : `[${pk.map((f) => `{ ${f}: 'asc' }`).join(', ')}]`;
    const suggestion = pk.length > 0 ? `Add \`orderBy: ${asOrderBy}\`` : 'Add an `orderBy` on a unique column';
    logTo(
      log,
      'warn',
      `findMany on "${this.table}" paginates (${shape}) with no orderBy: the page is NOT ` +
        'deterministic (the same query can return different rows as the table changes, so a row may appear ' +
        `on two pages or on none). ${suggestion}, or set \`implicitPkOrdering: true\` in the client config ` +
        'to order paginated queries by the primary key automatically.',
      { code: 'unordered-page', table: this.table, operation: 'findMany', paging: shape },
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
  private autoParentSetLarge(args?: { limit?: number }): boolean {
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
  private autoParentBound(args?: { limit?: number }): number | undefined {
    return args?.limit ?? this.defaultLimit;
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
      const rel = resolveRelationDef(this.tableMeta.relations, key);
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
   * Advice, once per relation: `'auto'` engaged the batched fallback.
   *
   * Both lines follow the same four parts: the CONDITION that tripped the rule,
   * the MECHANISM (which plan shape was replaced by which, and what that costs),
   * the fix, and the escape hatch. Naming only the condition is what lets a
   * reader build a wrong model of the mechanism and read a correct optimization
   * as a bug, so the mechanism sentence is not optional.
   */
  private emitAutoNotes(engaged: AutoEngaged[]): void {
    const log = this.advice;
    if (!log) return;
    for (const e of engaged) {
      if (!shouldWarnOnce(WARN_NS.autoStrategy, `${this.table}.${e.relation}`)) continue;
      if (e.reason === 'to-one-cardinality') {
        logTo(
          log,
          'warn',
          `auto strategy: to-one relation "${e.relation}" on "${this.table}" loads batched ` +
            `(the query is unbounded or its limit exceeds ${this.autoToOneThreshold()} rows). On the join plan ` +
            'a to-one relation is a correlated subquery the engine re-evaluates once per parent row, a per-row ' +
            'cost that stands even on a unique index; batched replaces it with ONE follow-up statement ' +
            '(`key = ANY(...)` for the whole page), so it trades that per-row cost for a single extra round ' +
            'trip. Bound the query with a smaller `limit`, tune `autoToOneJoinMaxRows` (the break-even is ' +
            "round-trip time / per-row cost), or set `relationLoadStrategy: 'join'` to force the " +
            'single-statement plan.',
          { code: 'auto-strategy', table: this.table, relation: e.relation, reason: e.reason },
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
      logTo(
        log,
        'warn',
        `auto strategy: relation "${e.relation}" on "${this.table}" loads batched (${probe}).${why} ` +
          "Create the covering index (or set `relationLoadStrategy: 'join'` to force the single-statement " +
          'plan); run `npx turbine doctor` for the exact CREATE INDEX SQL.',
        { code: 'auto-strategy', table: this.table, relation: e.relation, reason: e.reason },
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
      this.tableMeta,
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
      const result = await this.readWithTimeout(
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
    return {
      parentMeta: this.tableMeta,
      schema: this.schema,
      makeChild: (table: string): BatchedChildReader => this.batchedChild(table),
      // The per-query `forceCustomPlan` opt-in covers the relation follow-ups
      // too: a batched load re-issues the SAME tenant-shaped predicate one
      // level down, so leaving those named would keep exactly the plan-cache
      // exposure the caller asked to be rid of.
      exec: (sql, params, preparedName) =>
        this.readWithTimeout(sql, params, timeout, this.preparedNameFor({ forceCustomPlan }, preparedName)),
      quote: (name) => this.q(name),
      buildInClause: (expr, paramRef, negated) => this.inClause(expr, paramRef, negated),
      inClauseParam: (values) => this.inParam(values),
      paramPlaceholder: (index) => this.p(index),
      // Bound each relation follow-up per correlation key when the engine can
      // express it; absent leaves the loader on its client-side slice. Bound as
      // a closure rather than passing `this.dialect` so the loader keeps
      // needing nothing else from the dialect.
      //
      // The capability is NOT redundant with the hook's presence: every engine
      // dialect is built by SPREADING `postgresDialect`, so the hook is
      // INHERITED by sqlite / mysql / mssql, whose "absent" fallback would then
      // never be taken. The wrapper is not portable as written either (T-SQL
      // rejects an ORDER BY inside a derived table without TOP/OFFSET, and the
      // compiled child query carries one), so the pushdown stays with the
      // dialect that owns the implementation until another engine ships its own
      // and asserts it.
      buildPartitionLimit:
        this.dialect.capabilities.partitionLimitPushdown && this.dialect.buildPartitionLimit
          ? (input) => this.dialect.buildPartitionLimit!(input)
          : undefined,
      skipGlobalFilters: skip,
      // Query-level opt-in threaded onto every follow-up child `buildFindMany`,
      // so a batched load excludes/includes PII exactly as the join strategy.
      includePii,
      // `ref` is the follow-up query's FROM-item AS THE SQL REFERS TO IT: the
      // quoted child table for a hasMany `_count`, the bare junction alias `t`
      // for the m2m one. Compiled through the rendered-reference scope, which
      // uses it verbatim for the column qualifier and for a nested relation
      // filter's correlation parent alike. It went through the BARE-alias scope
      // before, which quotes what it is given, so a `globalFilters` entry that
      // was itself a relation filter emitted `"""posts"""` into the EXISTS
      // body and the count failed 42P01. Reproduced live; the plain batched
      // relation fetch was never affected, because that one goes through the
      // child's own buildFindMany and merges the filter unqualified.
      tableGlobalFilter: (table, ref, precedingParams) => {
        const gf = this.resolveGlobalFilter(table, resolvedSkip);
        if (!gf) return null;
        const meta = this.schema.tables[table];
        if (!meta) return null;
        // Seed the param array with `precedingParams` placeholders so the
        // builder numbers the gf params after the already-bound ones.
        const seeded: unknown[] = new Array(precedingParams).fill(undefined);
        const clause = whereMod.buildRenderedRefWhere(this.ctx, table, meta, ref, gf, seeded);
        if (!clause) return null;
        return { clause, params: seeded.slice(precedingParams) };
      },
    };
  }

  /**
   * The child {@link QueryInterface} the batched loader uses for `table`,
   * memoized per table for the lifetime of this accessor.
   *
   * It used to be constructed fresh for every relation of every query, which
   * threw away that child's SQL template cache each time: a relation follow-up
   * therefore MISSED the cache on every single request and rebuilt its SQL,
   * which is the one thing the template cache exists to avoid, and it allocated
   * a whole QueryInterface (column type maps, camel-date memo, the ctx literal)
   * per relation per query. `childOptions` was likewise a fresh spread per
   * query although it is a pure function of this instance's options.
   *
   * Safe to share across queries: a QueryInterface holds no per-query state
   * beyond the transient build fields, which live and die inside one
   * synchronous `build*` call, and every child is bound to THIS instance's pool
   * (so it still joins an active transaction) with `defaultLimit` cleared and
   * unlimited-warnings silenced, because a relation load must fetch every
   * matching child. Per-query values (`skipGlobalFilters`, `includePii`,
   * `timeout`, `forceCustomPlan`) are passed as ARGUMENTS by the loader, never
   * baked into the child, which is what makes the memo sound.
   */
  private batchedChild(table: string): BatchedChildReader {
    let child = this.batchedChildCache.get(table);
    if (!child) {
      this.batchedChildOptions ??= { ...this.options, defaultLimit: undefined, warnOnUnlimited: false };
      child = new QueryInterface<object>(
        this.pool,
        table,
        this.schema,
        [],
        this.batchedChildOptions,
      ) as unknown as BatchedChildReader;
      this.batchedChildCache.set(table, child);
    }
    return child;
  }

  /**
   * Run a findMany with the batched strategy: execute the base query WITHOUT
   * relation subqueries (all other clauses intact), then load each relation via
   * one flat follow-up query and stitch client-side. Parent stitch keys the
   * caller's `select`/`omit` excluded are added for the base query and stripped
   * from the returned rows, so the shape matches the join strategy exactly.
   */
  private async runFindManyBatched(args: FindManyArgs<T>): Promise<T[]> {
    // Declared relation spellings first, exactly as the join path does in
    // buildFindMany: the loader reads `args.with` itself, so without this the
    // two strategies would disagree about which relation names are valid.
    args = this.normalizeArgs(args);
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
    const result = await this.readWithTimeout(
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
      this.tableMeta,
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
   * `build` receives a fresh `$N` param scratch array. The executed params
   * always come from each call site's dedicated collect path; on a miss the
   * scratch params are kept in {@link lastMissParams} so `crossCheckCache` can
   * compare the two. On a HIT, `build` is skipped here and re-run by
   * {@link crossCheckCache} only when `diagnostics.cacheCheck` asks for it.
   *
   * Sets {@link lastCacheHit} so the caller's `crossCheckCache` knows which
   * comparison applies.
   */
  private acquireSql(cacheKey: string, build: (params: unknown[]) => string): SqlCacheEntry {
    if (!this.sqlCacheEnabled) {
      this.lastCacheHit = false;
      return this.buildCacheEntry(build);
    }

    const cached = this.sqlTemplateCache.get(cacheKey);
    if (cached) {
      this.cacheHits++;
      this.lastCacheHit = true;
      this.lastMissParams = undefined;
      return cached;
    }

    this.lastCacheHit = false;
    const entry = this.buildCacheEntry(build);
    this.sqlTemplateCache.set(cacheKey, entry);
    return entry;
  }

  /**
   * Run one build closure and pair its SQL with the prepared-statement name it
   * should execute under.
   *
   * The `variableArityShape` flag is reset immediately BEFORE the build and read
   * immediately AFTER it, so this method is the flag's entire lifetime: the
   * build walk (`buildWhereClause` / `buildScopedWhere` / the HAVING combinator)
   * is the only thing that can set it, nothing can observe a stale value, and a
   * throw out of `build()` leaves nothing behind to affect the next query.
   *
   * An EMPTY name is how "send this unnamed" travels: `queryWithTimeout` tests
   * the name for truthiness, so `''` takes the plain `(text, values)` form the
   * driver never registers a named statement for. Doing it HERE rather than at
   * the execute seam is what makes it survive the cache: the entry is created
   * once, on the miss, and a later HIT reuses the same (empty) name, so a
   * variable-arity shape can never acquire a name from a warmed template.
   *
   * See {@link BuilderCtx.markVariableArity} for what makes a shape
   * variable-arity and the measured reason it must not be named.
   */
  private buildCacheEntry(build: (params: unknown[]) => string): SqlCacheEntry {
    this.variableArityShape = false;
    this.lastMissParams = undefined;
    const built: unknown[] = [];
    const sql = build(built);
    const variableArity = this.variableArityShape;
    this.variableArityShape = false;
    this.cacheMisses++;
    this.lastMissParams = built;
    // With `sqlComment` putting a comment on every statement, the template's own
    // name is never sent (the execute seam sends a `c_` name derived from it),
    // so it is not claimed from the budget: only names that reach the wire do.
    const name = variableArity
      ? ''
      : this.sqlCommenter?.alwaysComments
        ? sqlToPreparedName(sql)
        : boundedPreparedName(sql);
    return { sql, name, paramCount: built.length };
  }

  /**
   * The SQL-cache lockstep checks (see the comment above `CACHE_MISMATCH_WARN_NS`).
   *
   * On a MISS: the collected params must equal the params the build pushed.
   * On a HIT: the collected param count must equal the entry's, always; then,
   * when `diagnostics.cacheCheck` selects this hit, the SQL and params are
   * rebuilt fresh through the same closure and compared:
   *   (a) the cached SQL string byte-for-byte against the fresh SQL, and
   *   (b) the collected params against the fresh build-path params (length
   *       and element-wise strict deep-equal).
   *
   * A mismatch means the fingerprint / build / collect paths have drifted out
   * of lockstep (the exact class of bug that has silently corrupted results
   * before), so it throws an {@link InvariantError} (E020) naming the
   * fingerprint, the operation, and both SQL strings (truncated), never a
   * parameter value.
   *
   * @param op human label of the calling build method (for the error message).
   * @param cacheKey the cache fingerprint.
   * @param entry the SQL entry that will be executed.
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
    if (!this.lastCacheHit) {
      const built = this.lastMissParams;
      this.lastMissParams = undefined;
      if (built === undefined || cacheParamsEqual(collectedParams, built)) return;
      throw this.lockstepError(
        op,
        cacheKey,
        [
          `built params and collected params diverge on a cache miss (collected ${collectedParams.length}, built ${built.length})`,
        ],
        false,
      );
    }
    if (entry.paramCount !== undefined && collectedParams.length !== entry.paramCount) {
      throw new InvariantError(
        'sql-cache-param-count',
        `SQL cache param count mismatch on ${op} (fingerprint "${cacheKey}"): the cached statement has ` +
          `${entry.paramCount} placeholders but the cache hit collected ${collectedParams.length} params, so ` +
          'the statement was not sent.',
      );
    }
    const check = this.diagnostics.cacheCheck;
    if (check === 'off') return;
    const sampled = typeof check === 'object';
    // The sampling decision, and only it, is per hit.
    if (sampled && check.sample < 1 && Math.random() >= check.sample) return;

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
    throw this.lockstepError(op, cacheKey, details, sampled);
  }

  /**
   * The `sql-cache-lockstep` {@link InvariantError}. When `log` is set (the
   * sampled hit path) the failure is also logged once per table and shape, so
   * it is durably recorded in the server log before the throw unwinds the
   * query; the other paths throw straight away.
   */
  private lockstepError(op: string, cacheKey: string, details: string[], log: boolean): InvariantError {
    const err = new InvariantError(
      'sql-cache-lockstep',
      `SQL cache lockstep violation on ${op} (fingerprint "${cacheKey}"). The fingerprint, SQL-build, and ` +
        `param-collect paths must enumerate where-clause keys identically. ${INVARIANT_REPORT_HINT}\n` +
        details.join('\n'),
    );
    if (log && shouldWarnOnce(CACHE_MISMATCH_WARN_NS, `${this.table}|${cacheKey}`)) {
      logTo(this.logger, 'error', err.message, { code: 'cache-mismatch', table: this.table, operation: op });
    }
    return err;
  }

  /**
   * Reset the unlimited-query warning dedupe, which is process-wide (see
   * {@link maybeWarnUnlimited}). Exposed for tests so a single test process can
   * verify the warning fires once per table without bleeding state between
   * assertions.
   */
  resetUnlimitedWarnings(): void {
    resetWarnOnce(WARN_NS.unlimitedFindMany);
  }

  private emitQueryEvent(
    out: Outgoing,
    params: unknown[],
    duration: number,
    action: string,
    rows: number,
    error?: Error,
    retried?: boolean,
  ): void {
    const onQuery = this.options?._onQuery;
    if (!onQuery) return;
    try {
      onQuery({
        sql: out.sql,
        params,
        duration,
        model: this.table,
        action,
        rows,
        timestamp: new Date(),
        error,
        strategy: this.currentStrategyTag,
        ...(retried ? { retried: true as const } : {}),
        ...(out.comment === undefined ? {} : { comment: out.comment }),
      });
    } catch {
      // Listener errors must never crash a query
    }
  }

  /**
   * The statement `sql` as it goes out under `preparedName`: with the
   * `sqlComment` appended, and under the name that comment calls for (see
   * query/sql-comment.ts). This is the one place a comment is added, at the
   * execute seam and after the SQL-template cache, so the cache, its keys and
   * its lockstep checks only ever see commentless text. Without `sqlComment`
   * it is the statement unchanged.
   */
  private outgoing(sql: string, preparedName: string | undefined, action: string): Outgoing {
    const commenter = this.sqlCommenter;
    const c = commenter?.commentFor(this.table, action);
    if (commenter === undefined || c === undefined) return { sql, text: sql, name: preparedName, comment: undefined };
    return { sql, text: `${sql} ${c.comment}`, name: commenter.preparedName(preparedName, c), comment: c.comment };
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
        'forceCustomPlan: true cannot be honoured on a client configured with ' +
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
   * {@link queryWithTimeout} for a statement that only READS, which makes it
   * safe to send twice. Outside a transaction, a read that fails because the
   * connection it went out on had already been closed by the server
   * ({@link isStaleConnectionError}) is sent once more, after one event-loop
   * turn, on whatever connection the pool hands out next.
   *
   * Reads only, and the distinction is the whole design. For a write, "the
   * connection died" does not say whether the statement committed first: a
   * connection can drop after the server commits and before the reply
   * arrives, so resending an INSERT can insert it twice. A read has no such
   * outcome. Nor inside a transaction, where the connection that died WAS the
   * transaction and a retry on another one would run outside it.
   *
   * The loop turn is what makes a second attempt worth making: pg-pool evicts
   * an idle connection whose close it has read, so after one poll phase every
   * other connection that died alongside this one is gone from the idle list
   * rather than lent out to the retry.
   *
   * Every read call site uses this and every write uses `queryWithTimeout`
   * directly; `src/test/stale-connection-retry.test.ts` pins which is which.
   */
  private readWithTimeout(
    sql: string,
    params: unknown[],
    timeout?: number,
    preparedName?: string,
  ): Promise<PgCompatQueryResult> {
    return this.queryWithTimeout(sql, params, timeout, preparedName, true);
  }

  /**
   * Execute a pool.query with an optional timeout.
   *
   * On a node-postgres pool outside a transaction the timeout is enforced on
   * the SERVER ({@link queryCancellable}). Anywhere else (a transaction's
   * connection, an engine shim, an HTTP pool) it races the query against a
   * timer: the call rejects on time but the statement keeps running, so the
   * error's `outcome` is `'unknown'`.
   *
   * pg driver errors are translated to typed Turbine errors via wrapPgError.
   * `retryIfStale` is {@link readWithTimeout}'s; nothing else sets it.
   */
  private async queryWithTimeout(
    sql: string,
    params: unknown[],
    requestedTimeout?: number,
    preparedName?: string,
    retryIfStale = false,
    pool: PgCompatPool = this.pool,
  ): Promise<PgCompatQueryResult> {
    const action = this.currentAction;
    const out = this.outgoing(sql, preparedName, action);
    // 0 is no timeout, as it is for `$transaction`'s option and the server's statement_timeout.
    const timeout = requestedTimeout === 0 ? undefined : requestedTimeout;
    if (timeout !== undefined && pool === this.pool && this.cancelsOnTimeout()) {
      return this.queryCancellable(out, params, timeout, retryIfStale, action);
    }
    if (timeout !== undefined && pool === this.pool && this.txScoped && this.dialect.capabilities.backendCancel) {
      const state = transactionStateOf(this.pool);
      if (state !== undefined && canCancelBackend(state.client)) {
        return this.queryCancellableInTransaction(out, params, timeout, state, action);
      }
    }
    let start = performance.now();
    // Build the query argument, use object form with `name` for prepared
    // statements, or the plain (text, values) form otherwise.
    //
    // The object form is not part of the PgCompatPool contract (the engine
    // pool shims only speak `(text, values)`), so it is reached through a
    // cast. Guarded at runtime by `preparedStatementsEnabled`, which only the
    // drivers that accept it turn on.
    const usePrepared = out.name && this.preparedStatementsEnabled;
    const send = (): Promise<PgCompatQueryResult> =>
      usePrepared
        ? (pool as unknown as { query(config: PgCompatQueryConfig): Promise<PgCompatQueryResult> }).query({
            name: out.name,
            text: out.text,
            values: params,
          })
        : pool.query(out.text, params);
    let exec = send();
    // Set when the caller's timeout has already answered, so a first attempt
    // that fails AFTER that does not send a retry nobody is waiting for.
    let abandoned = false;
    if (retryIfStale && !this.txScoped && pool === this.pool) {
      exec = exec.catch(async (err: unknown) => {
        if (abandoned || !isStaleConnectionError(err)) throw err;
        // The failed attempt is reported as its own event, marked `retried`,
        // so a listener counting errors sees it and one alerting on failed
        // CALLS can skip it. The final event below times the retry alone.
        const wrapped = wrapPgError(err);
        this.emitQueryEvent(
          out,
          params,
          performance.now() - start,
          action,
          0,
          wrapped instanceof Error ? wrapped : undefined,
          true,
        );
        await settleEventLoop();
        if (abandoned) throw err;
        start = performance.now();
        return send();
      });
    }

    if (!timeout) {
      try {
        const result = await exec;
        this.emitQueryEvent(out, params, performance.now() - start, action, result.rowCount ?? 0);
        return result;
      } catch (err) {
        const wrapped = wrapPgError(err);
        this.emitQueryEvent(
          out,
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
      timer = setTimeout(() => {
        abandoned = true;
        reject(
          new TimeoutError(timeout, 'Query', {
            outcome: 'unknown',
            message:
              `Query timed out after ${timeout}ms. It could not be cancelled on the server and may still ` +
              'complete, so a write may have been applied: check before retrying it.',
          }),
        );
      }, timeout);
    });
    try {
      const result = await Promise.race([exec, timeoutPromise]);
      this.emitQueryEvent(out, params, performance.now() - start, action, result.rowCount ?? 0);
      return result;
    } catch (err) {
      const wrapped = wrapPgError(err);
      this.emitQueryEvent(
        out,
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
   * Whether a timed statement can be stopped on the server: an engine with a
   * protocol cancel (PostgreSQL) on a node-postgres pool, outside a transaction
   * (inside one, the connection belongs to the transaction and is not this
   * method's to cancel or destroy).
   */
  private cancelsOnTimeout(): boolean {
    return !this.txScoped && this.dialect.capabilities.backendCancel && isNodePostgresPool(this.pool);
  }

  /**
   * {@link queryWithTimeout} with a timeout the server enforces. The statement
   * runs on a connection checked out for it, so when the deadline passes the
   * backend running it is known and gets a protocol cancel request.
   *
   * The call then waits, at most {@link CANCEL_GRACE_MS}, for the statement to
   * answer, and the answer decides the result:
   *   - cancelled (57014): TimeoutError, `outcome: 'not-executed'`;
   *   - finished first: the result, returned late, because reporting a write
   *     that committed as a timeout invites a retry that applies it twice;
   *   - failed: that error;
   *   - no answer: TimeoutError, `outcome: 'unknown'`, and the connection is
   *     destroyed rather than handed to the next caller still busy.
   * A deadline that passes while still waiting for a connection sends nothing
   * (`'not-executed'`). Either way the connection goes back to the pool only
   * once its backend is idle, so timed-out statements cannot hold the pool.
   */
  private async queryCancellable(
    out: Outgoing,
    params: unknown[],
    timeout: number,
    retryIfStale: boolean,
    action: string,
  ): Promise<PgCompatQueryResult> {
    let start = performance.now();
    const config =
      out.name && this.preparedStatementsEnabled ? { name: out.name, text: out.text, values: params } : null;
    const report = (err: unknown, retried?: boolean): unknown => {
      const wrapped = err instanceof TimeoutError ? err : wrapPgError(err);
      const error = wrapped instanceof Error ? wrapped : undefined;
      this.emitQueryEvent(out, params, performance.now() - start, action, 0, error, retried);
      return wrapped;
    };
    let expired = false;
    let expire: (value: typeof TIMED_OUT) => void = () => {};
    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
      expire = resolve;
    });
    const timer = setTimeout(() => {
      expired = true;
      expire(TIMED_OUT);
    }, timeout);
    const neverSent = (): TimeoutError =>
      new TimeoutError(timeout, 'Query', {
        outcome: 'not-executed',
        message: `Query timed out after ${timeout}ms before it reached the server. It made no change.`,
      });
    try {
      for (let attempt = 0; ; attempt++) {
        const checkingOut = acquireConnection(this.pool);
        let held: Checkout | typeof TIMED_OUT;
        try {
          held = await Promise.race([checkingOut, deadline]);
        } catch (err) {
          throw report(err);
        }
        if (held === TIMED_OUT) {
          checkingOut.then(
            (late) => late.checkout.release(),
            () => {},
          );
          throw report(neverSent());
        }
        const { client, checkout } = held;
        const running: Promise<Settled> = (
          config
            ? (client as unknown as { query(c: PgCompatQueryConfig): Promise<PgCompatQueryResult> }).query(config)
            : client.query(out.text, params)
        ).then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
        const first = await Promise.race([running, deadline]);
        const settled = first === TIMED_OUT ? await this.cancelTimedOut(held, running, timeout) : first;
        if ('result' in settled) {
          if (first !== TIMED_OUT) checkout.release();
          this.emitQueryEvent(out, params, performance.now() - start, action, settled.result.rowCount ?? 0);
          return settled.result;
        }
        if ('timeout' in settled) throw report(settled.timeout);
        const err = settled.error;
        if (first === TIMED_OUT) throw report(err);
        checkout.release(err instanceof Error ? err : true);
        if (!(retryIfStale && attempt === 0 && isStaleConnectionError(err))) throw report(err);
        report(err, true);
        await settleEventLoop();
        if (expired) throw report(neverSent());
        start = performance.now();
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A timed statement inside a transaction, cancelled on the server when the
   * deadline passes, on the transaction's own connection.
   *
   * A cancelled statement made no change, but PostgreSQL aborts the
   * transaction it ran in, so the timeout ends the transaction too: it is
   * marked to roll back ({@link TransactionState.abort}), which also covers a
   * cancel that arrived after the statement finished. The error is
   * `outcome: 'not-executed'` either way, because nothing it did can commit.
   * A statement that finishes before the deadline is returned as usual.
   */
  private async queryCancellableInTransaction(
    out: Outgoing,
    params: unknown[],
    timeout: number,
    state: TransactionState,
    action: string,
  ): Promise<PgCompatQueryResult> {
    const start = performance.now();
    const running: Promise<Settled> = (
      out.name && this.preparedStatementsEnabled
        ? (this.pool as unknown as { query(c: PgCompatQueryConfig): Promise<PgCompatQueryResult> }).query({
            name: out.name,
            text: out.text,
            values: params,
          })
        : this.pool.query(out.text, params)
    ).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeout);
    });
    let settled: Settled | { timeout: TimeoutError };
    try {
      const first = await Promise.race([running, deadline]);
      settled = first === TIMED_OUT ? await this.cancelInTransaction(state, running, timeout) : first;
    } finally {
      clearTimeout(timer);
    }
    if ('result' in settled) {
      this.emitQueryEvent(out, params, performance.now() - start, action, settled.result.rowCount ?? 0);
      return settled.result;
    }
    const err = 'timeout' in settled ? settled.timeout : wrapPgError(settled.error);
    this.emitQueryEvent(out, params, performance.now() - start, action, 0, err instanceof Error ? err : undefined);
    throw err;
  }

  /** Cancel a timed-out statement in a transaction and end the transaction. See {@link queryCancellableInTransaction}. */
  private async cancelInTransaction(
    state: TransactionState,
    running: Promise<Settled>,
    timeout: number,
  ): Promise<Settled | { timeout: TimeoutError }> {
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const graceOver = new Promise<typeof TIMED_OUT>((resolve) => {
      graceTimer = setTimeout(() => resolve(TIMED_OUT), CANCEL_GRACE_MS);
    });
    try {
      await Promise.race([sendCancelRequest(state.client, CANCEL_GRACE_MS), graceOver]);
      const answer = await Promise.race([running, graceOver]);
      if (answer !== TIMED_OUT && 'result' in answer) return answer;
      const cancelled = answer !== TIMED_OUT && isQueryCanceled(answer.error);
      if (answer !== TIMED_OUT && !cancelled) return answer;
      const error = new TimeoutError(timeout, 'Query', {
        outcome: 'not-executed',
        ...(cancelled ? { cause: answer.error } : {}),
        message:
          (cancelled
            ? `Query timed out after ${timeout}ms and was cancelled on the server, so it made no change. `
            : `Query timed out after ${timeout}ms, and the server did not confirm its cancellation within ` +
              `${CANCEL_GRACE_MS}ms. `) +
          'The transaction it ran in is over: it rolls back instead of committing, and no statement in it is ' +
          'kept. Let this error leave the transaction callback and retry the whole transaction, or run a ' +
          'statement that may time out in a nested `tx.$transaction(...)`, which rolls back only that block.',
      });
      state.abort(error);
      return { timeout: error };
    } finally {
      clearTimeout(graceTimer);
    }
  }

  /**
   * Cancel a statement that outlived its timeout, wait for it to answer, and
   * release its connection accordingly. See {@link queryCancellable}.
   */
  private async cancelTimedOut(
    held: Checkout,
    running: Promise<Settled>,
    timeout: number,
  ): Promise<Settled | { timeout: TimeoutError }> {
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const graceOver = new Promise<typeof TIMED_OUT>((resolve) => {
      graceTimer = setTimeout(() => resolve(TIMED_OUT), CANCEL_GRACE_MS);
    });
    try {
      const delivered = await Promise.race([sendCancelRequest(held.client, CANCEL_GRACE_MS), graceOver]);
      const answer = await Promise.race([running, graceOver]);
      if (answer === TIMED_OUT) {
        held.checkout.release(new Error('the statement did not stop after a cancel request'));
        return {
          timeout: new TimeoutError(timeout, 'Query', {
            outcome: 'unknown',
            message:
              `Query timed out after ${timeout}ms and the server did not confirm its cancellation within ` +
              `${CANCEL_GRACE_MS}ms, so it may still complete and a write may have been applied: check before ` +
              'retrying it. The connection was closed.',
          }),
        };
      }
      // A cancel that was sent but not confirmed could still land on the NEXT
      // statement this connection runs, so such a connection is not reused.
      const reusable = delivered === true;
      if ('result' in answer) {
        held.checkout.release(reusable ? undefined : true);
        return answer;
      }
      const err = answer.error;
      if (reusable && (err as { code?: unknown } | null)?.code === '57014') {
        held.checkout.release();
        return {
          timeout: new TimeoutError(timeout, 'Query', {
            outcome: 'not-executed',
            cause: err,
            message: `Query timed out after ${timeout}ms and was cancelled on the server. It made no change.`,
          }),
        };
      }
      held.checkout.release(err instanceof Error ? err : true);
      return answer;
    } finally {
      clearTimeout(graceTimer);
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
    const reselect = deferred.reselect;
    if (this.dialect.resultStrategy === 'reselect' && reselect) {
      // One transaction, so the row returned is the row this call wrote, and
      // the transform runs before COMMIT so a refusal it raises writes nothing.
      return this.inOneTransaction(
        async (exec) => deferred.transform(await reselect(exec)),
        timeout,
        `A ${this.dialect.name} write`,
        'Pass a pool that can check out a connection.',
      );
    }
    const result = await this.queryWithTimeout(deferred.sql, deferred.params, timeout, deferred.preparedName);
    return deferred.transform(result);
  }

  /**
   * The executor for a write's statements, sharing one deadline: each one gets
   * what is left of `timeout`, so a chunked `createMany` or a lock, write and
   * re-read cannot run for N times the timeout. A statement due past the
   * deadline is not sent. `onClient` routes them to a held connection.
   */
  private deadlineExec(timeout: number | undefined, onClient?: PgCompatPool): ReselectExecutor {
    const deadline = timeout ? performance.now() + timeout : undefined;
    return async (sql, params, preparedName) => {
      let left = timeout;
      if (deadline !== undefined) {
        left = Math.ceil(deadline - performance.now());
        if (left <= 0) {
          throw new TimeoutError(timeout as number, 'Query', {
            outcome: 'not-executed',
            message:
              `Query timed out after ${timeout}ms: the write's statements share one deadline, and it passed ` +
              'before the next one was sent. Its earlier statements are rolled back, so it makes no change.',
          });
        }
      }
      return onClient
        ? this.queryWithTimeout(sql, params, left, preparedName, false, onClient)
        : this.queryWithTimeout(sql, params, left, preparedName);
    };
  }

  /**
   * Run a write that takes several statements as one transaction on one
   * connection: the caller's transaction when there is one, else one opened
   * here. A statement that times out is cancelled where the engine allows it,
   * and its connection is closed rather than rolled back (a ROLLBACK would wait
   * behind it); the transaction never commits, so the write made no change.
   * `timeout` is one deadline for every statement (see {@link deadlineExec}).
   */
  private async inOneTransaction<V>(
    work: (exec: ReselectExecutor) => Promise<V>,
    timeout: number | undefined,
    operation: string,
    alternative: string,
  ): Promise<V> {
    if (this.txScoped) {
      // In the caller's transaction, a savepoint keeps the write whole: a later
      // statement that fails and is caught cannot leave the earlier ones behind.
      return withSavepoint(this.pool, () => work(this.deadlineExec(timeout)));
    }
    if (typeof (this.pool as { connect?: unknown }).connect !== 'function') {
      throw new UnsupportedFeatureError(
        `${operation} on a pool without connect()`,
        this.dialect.name,
        `${operation} runs several statements in one transaction, which needs a connection of its own, and ` +
          `this pool cannot check one out (a stateless HTTP driver). ${alternative}`,
      );
    }
    const { client, checkout } = await openCheckout(this.pool, (c) => c.query(this.dialect.beginStatement()));
    const onClient = {
      query: (text: string | PgCompatQueryConfig, values?: unknown[]) =>
        typeof text === 'string'
          ? client.query(text, values)
          : (client as unknown as { query(c: PgCompatQueryConfig): Promise<PgCompatQueryResult> }).query(text),
    } as unknown as PgCompatPool;
    try {
      const value = await work(this.deadlineExec(timeout, onClient));
      await client.query(this.dialect.commitStatement());
      checkout.release();
      return value;
    } catch (err) {
      if (err instanceof TimeoutError) {
        if (await sendCancelRequest(client, CANCEL_GRACE_MS)) {
          checkout.release(err);
        } else {
          // No cancel reached the server (or the engine has none), so the
          // statement may still be running. The ROLLBACK queues behind it on
          // this connection, and the connection goes back to the pool only
          // after it: never with the transaction still open.
          client.query(this.dialect.rollbackStatement()).then(
            () => checkout.release(),
            (e: unknown) => checkout.release(e instanceof Error ? e : true),
          );
        }
        throw new TimeoutError(err.timeoutMs, 'Query', {
          outcome: 'not-executed',
          cause: err,
          message:
            `Query timed out after ${err.timeoutMs}ms. Its transaction is rolled back rather than committed, ` +
            'so it makes no change.',
        });
      }
      try {
        await client.query(this.dialect.rollbackStatement());
      } catch {
        // Best effort: the connection may be gone.
      }
      checkout.release();
      throw explainConnectionLoss(wrapPgError(err), checkout.lostWith);
    }
  }

  // ---------------------------------------------------------------------------
  // Write compilation (extracted to writes.ts).
  // ---------------------------------------------------------------------------

  buildCreate<
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args: CreateArgs<T, R, S, O, M['create']>): DeferredQuery<FieldResult<T, S, O>> {
    args = this.normalizeArgs(args);
    return writesMod.buildCreate(
      this.ctx,
      args as CreateArgs<T>,
      this.resolveWriteProjection(args),
    ) as unknown as DeferredQuery<FieldResult<T, S, O>>;
  }

  /**
   * A single-row write's `select` / `omit`, resolved through the SAME
   * `resolveProjection` reads use (see WriteProjection in writes.ts), or
   * `undefined` for the default return shape. Resolved here rather than in
   * writes.ts because relations.ts imports writes.ts.
   */
  private resolveWriteProjection(args: {
    select?: Record<string, boolean>;
    omit?: Record<string, boolean>;
  }): writesMod.WriteProjection | undefined {
    if (args.select === undefined && args.omit === undefined) return undefined;
    const columns = relationsMod.resolveProjection(this.ctx, this.table, this.tableMeta, args.select, args.omit, false);
    if (!columns || columns.length === 0) {
      // Only an `omit` naming every column gets here (an empty `select` is
      // refused inside resolveProjection): a write must return SOMETHING, and
      // an empty RETURNING list is a syntax error on every engine.
      throw new ValidationError(
        `\`omit\` on a write to "${this.table}" leaves no column to return. Name the fields to keep with \`select\` instead.`,
      );
    }
    return { columns };
  }

  buildCreateMany<
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args: CreateManyArgs<T, M['createMany'], S, O>): DeferredQuery<FieldResult<T, S, O>[]> {
    args = this.normalizeArgs(args);
    return writesMod.buildCreateMany(
      this.ctx,
      args as unknown as CreateManyArgs<T>,
      'refuse',
      this.resolveWriteProjection(args),
    ) as unknown as DeferredQuery<FieldResult<T, S, O>[]>;
  }

  buildUpdate<
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args: UpdateArgs<T, R, S, O, M['update']>): DeferredQuery<FieldResult<T, S, O>> {
    args = this.normalizeArgs(args);
    return writesMod.buildUpdate(
      this.ctx,
      args as UpdateArgs<T>,
      this.resolveWriteProjection(args),
    ) as unknown as DeferredQuery<FieldResult<T, S, O>>;
  }

  buildDelete<
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args: DeleteArgs<T, R, S, O>): DeferredQuery<FieldResult<T, S, O>> {
    args = this.normalizeArgs(args);
    return writesMod.buildDelete(
      this.ctx,
      args as DeleteArgs<T>,
      this.resolveWriteProjection(args),
    ) as unknown as DeferredQuery<FieldResult<T, S, O>>;
  }

  buildUpsert<
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(
    args: UpsertArgs<T, R, S, O, M['whereUnique'], M['createMany'], M['updateMany']>,
  ): DeferredQuery<FieldResult<T, S, O>> {
    args = this.normalizeArgs(args);
    return writesMod.buildUpsert(
      this.ctx,
      args as UpsertArgs<T>,
      this.resolveWriteProjection(args),
    ) as unknown as DeferredQuery<FieldResult<T, S, O>>;
  }

  buildUpdateMany(args: UpdateManyArgs<T, R, M['updateMany']>): DeferredQuery<{ count: number }> {
    return writesMod.buildUpdateMany(this.ctx, this.normalizeArgs(args));
  }

  buildDeleteMany(args: DeleteManyArgs<T, R>): DeferredQuery<{ count: number }> {
    return writesMod.buildDeleteMany(this.ctx, this.normalizeArgs(args));
  }

  /**
   * Best-effort extraction of an auto-generated primary key from a write
   * result for `'reselect'` engines (e.g. mysql2's `insertId`). Returns
   * `undefined` when the driver exposes no such field.
   */
  private mutationInsertId(result: PgCompatQueryResult): unknown {
    const r = result as unknown as { insertId?: unknown; lastID?: unknown };
    return r.insertId ?? r.lastID;
  }

  /**
   * Execute a query through the middleware chain.
   * If no middlewares are registered, executes directly.
   *
   * Middleware can inspect and log query parameters, measure timing, and
   * transform the result returned by `next()`. `params.args` is a plain copy
   * (see `readOnlyMiddlewareParams`): the query is compiled from the caller's
   * args, so `next()` throws a TypeError when the copy was changed. Cross-cutting
   * filters (e.g. soft deletes) belong in the query itself, or in `globalFilters`.
   */
  private async executeWithMiddleware<R>(
    action: string,
    args: Record<string, unknown>,
    executor: () => Promise<R>,
  ): Promise<R> {
    this.currentAction = action;
    // Every public operation passes through here with its own name and the
    // caller's args, which makes this the one place the unknown-key diagnostic
    // can be complete. Putting it in each method instead would mean fifteen
    // sites and a new one every time an operation is added, which is precisely
    // how the surface it checks came to need checking.
    warnUnknownQueryOptions(this.table, action, args, this.advice ?? null);
    if (this.middlewares.length === 0) {
      return executor();
    }

    // A copy: the query is compiled from `args`, not from what middleware
    // sees, so `next()` throws on a changed copy rather than doing nothing.
    const params = readOnlyMiddlewareParams(this.table, action, args);

    // Build middleware chain
    let index = 0;
    const next = async (p: { model: string; action: string; args: Record<string, unknown> }): Promise<unknown> => {
      assertMiddlewareArgsKept(params, p);
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
  >(args: FindUniqueArgs<T, R, W, S, O, M['whereUnique']>): Promise<QueryResult<T, R, W, S, O> | null> {
    // BEFORE the strategy branch, not only inside the builders, so the
    // join-vs-batched decision and its dev warning see the same declared name
    // every other stage does. `planAuto` splits `with` on the caller's keys and
    // `runAutoSplit` carries them onward; each downstream consumer normalizes
    // too, so this is not load-bearing for correctness (measured: removing it
    // changes the warning text from the declared name back to the caller's and
    // nothing else). It is here so the invariant holds at the seam rather than
    // depending on every consumer to re-establish it.
    args = this.normalizeArgs(args);
    this.assertLockInTransaction(args, 'findUnique');
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
      const result = await this.readWithTimeout(
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
    // Declared relation spellings first, see runFindManyBatched.
    args = this.normalizeArgs(args);
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
      this.tableMeta,
      args.select as Record<string, boolean> | undefined,
      args.omit as Record<string, boolean> | undefined,
      needed,
      defaultProjectionFields(this.tableMeta, resolveUnsafeFlag(args.includePii, 'includePii')),
    );
    const baseArgs = { ...args, with: undefined, select: proj.select, omit: proj.omit } as unknown as FindUniqueArgs<T>;
    const deferred = this.buildFindUnique(baseArgs as Parameters<QueryInterface<T, R>['buildFindUnique']>[0]);
    const result = await this.readWithTimeout(
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

  buildFindUnique<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args: FindUniqueArgs<T, R, W, S, O, M['whereUnique']>): DeferredQuery<QueryResult<T, R, W, S, O> | null> {
    // Canonical args FIRST: the empty-where guard and the unique-key rule below
    // must read the pruned `where`, never one still carrying `undefined` keys.
    args = this.normalizeArgs(args);
    this.currentSkip = resolveSkipGlobalFilters(args.skipGlobalFilters);
    // Pinned before the cache key, which carries it (see buildFindMany).
    const jsonEncoding = this.resolveJsonEncoding(args.jsonEncoding);
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
    // `findFirst` takes no such guard: "the first row matching an optional
    // filter" is its contract, and `where: {}` or no `where` asks for any row.
    // It refuses only a `where` that was emptied by `undefined` values (see
    // normalizeArgs), which never meant "any row".
    if (whereMod.userPredicateIsEmpty(this.ctx, (args.where ?? {}) as Record<string, unknown>)) {
      throw new ValidationError(
        `findUnique on "${this.table}" refused: the \`where\` clause has no predicate, ` +
          'so this would return an arbitrary row rather than a specific one. ' +
          'A key whose value is `undefined` does not count, check that the value you are looking up is defined. ' +
          'If you meant "any row matching an optional filter", use `findFirst`.',
      );
    }
    // ...and a where that HAS a predicate but does not name a unique key is the
    // same hazard one step along (0.73.0). `findUnique({ where: { status:
    // 'active' } })` used to emit `WHERE status = $1 LIMIT 1` with no ORDER BY:
    // one row out of many, chosen by the engine, different between two calls
    // with the same argument and between two plans for the same call. The
    // caller who wrote `findUnique` asked for the row, not a row, and the
    // `null` branch they wrote reads as "no such row" when it means "none
    // matched this filter".
    //
    // Checked against the USER's where for the same reason as the guard above:
    // a global filter is not an identity, and letting one satisfy this would
    // hand back an arbitrary row from inside the tenant.
    this.assertFindUniqueKey(args.where as Record<string, unknown>);
    // The locking clause, read by the cache key and all three SQL paths below.
    const rowLock = resolveRowLock(args.lock, this.dialect, this.table);
    const lockSql = rowLock?.sql ?? '';
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
    // `|je=`: same rule and same hazard as in buildFindMany. findUnique is never
    // flatten-planned, so this is the only plan-shape segment it needs.
    const encodingFp = `|je=${jsonEncoding === 'positional' ? 'p' : 'o'}`;
    // Empty without a lock, so every unlocked key is unchanged.
    const lockFp = rowLock ? `|lk=${rowLock.fp}` : '';
    const ck = `fu:${whereFingerprint}|c=${colKey}|w=${withFp}|pii=${includePii ? 1 : 0}${encodingFp}${lockFp}${this.globalFilterCacheSegment()}`;

    const params: unknown[] = [];

    // Check if all where values are simple (plain equality, no operators/null/OR).
    // Keys are sorted to match fingerprintWhere, insertion order here would let
    // permuted where literals share a cache entry with misaligned params.
    const whereKeys = Object.keys(whereObj)
      .filter((k) => whereObj[k] !== undefined)
      .sort();
    // Only a scalar the general path would accept as it is (a primitive, Date
    // or Buffer) on a non-JSON column takes the simple path, so no operand
    // reaches SQL without the general path's validation. Resolved, not looked
    // up: a relation filter spelled the snake_case way must not read as a
    // plain equality.
    const isSimpleWhere =
      !whereObj.OR &&
      !whereObj.AND &&
      !whereObj.NOT &&
      whereKeys.every((k) => {
        if (!isFastPathScalar(whereObj[k]) || resolveRelationDef(this.tableMeta.relations, k)) return false;
        const column = resolveColumnName(this.tableMeta, k);
        return column !== undefined && !this.isJsonColumnType(this.getColumnPgType(column));
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
        return `SELECT ${selectExpr} FROM ${qt}${whereSql}${this.limitOneClause()}${lockSql}`;
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
        ...rowLockMarker(rowLock),
      };
    }

    // General path (with operators, null, OR, with clause)
    if (!args.with) {
      const buildSql = (freshParams: unknown[]): string => {
        const clause = this.buildWhereClause(whereObj, freshParams);
        const whereSql = clause ? ` WHERE ${clause}` : '';
        const qt = this.q(this.table);
        const selectExpr = columnsList ? columnsList.map((c) => `${qt}.${this.q(c)}`).join(', ') : `${qt}.*`;
        return `SELECT ${selectExpr} FROM ${qt}${whereSql}${this.limitOneClause()}${lockSql}`;
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
        ...rowLockMarker(rowLock),
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
      return `SELECT ${selectClause} FROM ${this.q(this.table)}${whereSql}${this.limitOneClause()}${lockSql}`;
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
      ...rowLockMarker(rowLock),
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
    // BEFORE the strategy branch, not only inside the builders, so the
    // join-vs-batched decision and its dev warning see the same declared name
    // every other stage does. `planAuto` splits `with` on the caller's keys and
    // `runAutoSplit` carries them onward; each downstream consumer normalizes
    // too, so this is not load-bearing for correctness (measured: removing it
    // changes the warning text from the declared name back to the caller's and
    // nothing else). It is here so the invariant holds at the seam rather than
    // depending on every consumer to re-establish it.
    args = this.normalizeArgs(args);
    this.assertLockInTransaction(args, 'findMany');
    this.maybeWarnUnlimited(args);
    this.maybeWarnUnorderedPage(args);

    // Advice: warn on deeply nested with clauses.
    const advice = this.advice;
    if (advice && args?.with) {
      const depth = this.measureWithDepth(args.with as WithClause);
      if (depth > 5 && shouldWarnOnce(WARN_NS.deepWith, this.table)) {
        logTo(
          advice,
          'warn',
          `Deep with clause (depth ${depth}) on "${this.tableMeta.name}": every level is a ` +
            'correlated subquery the engine re-evaluates once per row of the level above, so the work ' +
            'multiplies down the tree and the whole subtree is built as JSON inside each parent row. Split ' +
            "into separate queries, or use `relationLoadStrategy: 'batched'` (one flat statement per " +
            'relation, no per-parent re-evaluation). Advice: silent when `diagnostics.advice` is off, as it ' +
            'is by default in production.',
          { code: 'deep-with', table: this.table, operation: 'findMany', depth },
        );
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
      const result = await this.readWithTimeout(
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
   * Emit a one-time warning when {@link findMany} is called without an
   * explicit `limit`/`take` and `warnOnUnlimited` has not been disabled.
   *
   * Said once per table per process (`WARN_NS.unlimitedFindMany`), so a busy
   * loop calling `db.users.findMany()` thousands of times logs once, and so
   * does the same call inside every `$transaction`, which builds its own
   * query interfaces.
   * Suppressed when `defaultLimit` is configured (the caller has already
   * opted in to a bounded query) and when the user passed an explicit
   * `limit`, `take`, or `cursor`. A per-call `warnOnUnlimited` overrides the
   * config-level setting in either direction (`false` silences a call that
   * intentionally reads the full set; `true` forces the warning even when
   * disabled in config).
   */
  private maybeWarnUnlimited(args?: { limit?: number; cursor?: unknown; warnOnUnlimited?: boolean }): void {
    const perCall = args?.warnOnUnlimited;
    if (perCall === false) return;
    if (perCall === undefined && !this.warnOnUnlimited) return;
    if (this.defaultLimit !== undefined) return;
    const hasExplicitLimit = args?.limit !== undefined || hasCursor(args?.cursor);
    if (hasExplicitLimit) return;
    if (this.whereMatchesAtMostOneRow((args as { where?: unknown } | undefined)?.where)) return;
    if (!shouldWarnOnce(WARN_NS.unlimitedFindMany, this.table)) return;
    logTo(
      this.logger,
      'warn',
      `warning: findMany on "${this.table}" has no limit: the statement is emitted with no row limit, ` +
        'so the engine returns every matching row and the driver materializes all of them as objects before ' +
        'this call resolves (the cost grows with the table, not with the rows you use). Pass `limit`/`take`, ' +
        'or set `defaultLimit` in the client config; silence with `warnOnUnlimited: false` (per call, per ' +
        'table, or in config).',
      { code: 'unlimited-find-many', table: this.table, operation: 'findMany' },
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
      // The one key-resolution rule: a bare `columnMap` read knows only the
      // FIELD spelling, so `where: { user_id: 1 }` on a unique column did not
      // count as pinning it and drew a spurious unlimited-read warning the
      // camelCase spelling of the same query did not.
      const column = resolveColumnName(this.tableMeta, field);
      if (column === undefined) return false;
      pinned.add(column);
    }
    if (pinned.size === 0) return false;

    const covers = (columns: string[] | undefined): boolean =>
      !!columns && columns.length > 0 && columns.every((c) => pinned.has(c));
    return covers(this.tableMeta.primaryKey) || (this.tableMeta.uniqueColumns ?? []).some(covers);
  }

  /**
   * Recursively measure the maximum depth of a `with` clause tree.
   * Used by the deep-with advice.
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

  buildFindMany<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args?: FindManyArgs<T, R, W, S, O>): DeferredQuery<QueryResult<T, R, W, S, O>[]> {
    this.currentSkip = resolveSkipGlobalFilters(args?.skipGlobalFilters);
    // Pinned before the flatten plan and the cache key, both of which read it.
    const jsonEncoding = this.resolveJsonEncoding(args?.jsonEncoding);
    // Relation names to their declared spelling FIRST, before the stable-order
    // pass and the fingerprint below and before any of the six `with` walkers,
    // so none of them needs to know a relation has two accepted spellings and
    // both spellings share one cache entry. See query/relation-names.ts.
    args = this.normalizeArgs(args);
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
    // Drop `orderBy` terms that sort by an expression an earlier term already
    // sorted by, and `distinct` columns named twice. HERE, before the
    // fingerprint, for the reason every other normalization in this method is
    // here: the fingerprint, the SQL build and the param collect must all see
    // ONE list, or the cache key and the statement it caches describe different
    // queries. Rewritten into the array form, which flattens through
    // `orderByEntries` to the identical entry list the object form does, so a
    // caller who wrote no duplicate is untouched down to the cache key (the
    // helpers return null unless something was actually dropped).
    if (args?.orderBy !== undefined) {
      const deduped = dedupeOrderEntries(this.tableMeta, orderByEntries(args.orderBy), this.table);
      if (deduped) {
        warnRedundantSortTerm(this.advice, this.table, 'orderBy', deduped.dropped);
        args = {
          ...args,
          orderBy: deduped.entries.map(([k, v]) => ({ [k]: v })) as NonNullable<typeof args>['orderBy'],
        };
      }
    }
    if (args?.distinct && args.distinct.length > 0) {
      const deduped = dedupeColumnList(this.tableMeta, args.distinct as string[]);
      if (deduped) {
        warnRedundantSortTerm(this.advice, this.table, 'distinct', deduped.dropped);
        args = { ...args, distinct: deduped.columns as NonNullable<typeof args>['distinct'] };
      }
    }
    // Deterministic pagination (opt-in): fill a PK-asc orderBy into a paginating
    // query that declares none, BEFORE fingerprinting so the ordered and
    // unordered shapes get distinct cache entries. No-op unless
    // `implicitPkOrdering` is enabled (see implicitPkOrderBy).
    const implicitOrder = this.implicitPkOrderBy(args);
    if (implicitOrder) args = { ...args, orderBy: implicitOrder as NonNullable<typeof args>['orderBy'] };
    // A `cursor` that names no row (`null`, `{}`) is refused before either
    // reader below asks whether there is one.
    assertCursorWritten(this.table, 'findMany', args?.cursor);
    // A page whose order can tie gets the cursor tiebreaker (completePageOrder),
    // before fingerprinting, so the cache key carries it.
    if (args) args = this.completePageOrder(args as NonNullable<typeof args>);
    // A cursor page is planned (and its orderBy completed to the effective
    // order) BEFORE fingerprinting, so the key, the SQL and the param collect
    // all read one plan. See planCursor.
    let cursorPlan: CursorPlan | undefined;
    if (hasCursor(args?.cursor)) ({ args, plan: cursorPlan } = this.planCursor(args as NonNullable<typeof args>));
    // `distinct` compiles to `SELECT DISTINCT ON (...)`, which is PostgreSQL
    // syntax and nothing else's. Every other engine parsed it as far as the
    // word `ON` and answered with a RAW driver error carrying no TURBINE_ code
    // (SQLite: `near "ON": syntax error`; MySQL: ER_PARSE_ERROR), i.e. the one
    // shape the typed-error surface exists to prevent. Refused with the same
    // E017, on the same `distinctOn` capability, as the OTHER spelling of this
    // feature, `groupBy({ distinctOn })` in aggregates.ts.
    //
    // Before the cache, like the two guards below, so a warmed template cannot
    // serve the query the cold path refuses.
    if (args?.distinct && args.distinct.length > 0 && !this.dialect.capabilities.distinctOn) {
      throw new UnsupportedFeatureError(
        'DISTINCT ON (findMany distinct)',
        this.dialect.name,
        'findMany({ distinct }) requires PostgreSQL: SELECT DISTINCT ON is not portable. Group in ' +
          'application code, or use groupBy({ by }) for one row per combination.',
      );
    }
    // The locking clause, validated and rendered once: the cache key and the
    // SQL both read this value. PostgreSQL refuses a lock on a DISTINCT query
    // (0A000), so that pair is refused here, before the cache.
    const rowLock = resolveRowLock(args?.lock, this.dialect, this.table);
    if (rowLock && args?.distinct && args.distinct.length > 0) {
      throw new ValidationError(lockWithDistinctMessage(this.table));
    }
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
            '`distinct` cannot be combined with relation orderBy (pick-row, `_count`, or ' +
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
          // Keyed by the DECLARED relation name (falling back to the key
          // itself for a column), so the two spellings of one orderBy share a
          // cache entry instead of minting two templates for one query.
          .map(([k, d]) => {
            const rel = resolveRelation(this.tableMeta.relations, k);
            return `${rel?.name ?? k}:${this.orderByEntryFingerprint(d, rel?.def.to)}`;
          })
          .join(',')
      : '';
    // Mode, keyset order, directions, NULL placement and which values are
    // NULL all change the predicate's SQL text (see planCursor).
    const cursorFp = cursorPlan?.fingerprint ?? '';
    // distinct must fingerprint in USER order: the SQL emits `DISTINCT ON` in
    // the caller's column order, so a permuted array rebuilds different SQL and
    // must not collapse onto the same cache entry (would trip the cross-check).
    const distinctFp = args?.distinct ? args.distinct.join(',') : '';
    const effectiveLimit = args?.limit ?? this.defaultLimit;
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
    // `jsonEncoding` decides whether every relation subquery emits
    // `json_build_object` or `json_build_array`, and the parser built alongside
    // the statement decodes exactly one of those two. It is invisible to
    // `withFp` (which fingerprints the `with` SHAPE, not its rendering), so it
    // needs its own segment for the same reason `pii=` and `fl=` do, and the
    // consequence of getting it wrong is worse than either: a positional
    // template served to an object-planned call hands `parseNestedRow` bare
    // arrays where it expects keyed objects, which is silent data corruption
    // rather than an error. Emitted for BOTH values rather than only the
    // non-default one, so the key never depends on what the client default
    // happens to be.
    const encodingFp = `|je=${jsonEncoding === 'positional' ? 'p' : 'o'}`;

    // Empty without a lock, so every unlocked key is unchanged.
    const lockFp = rowLock ? `|lk=${rowLock.fp}` : '';

    const ck = `fm:${whereFp}|c=${colKey}|o=${orderFp}|l=${limitFp}|off=${offsetFp}|cur=${cursorFp}|d=${distinctFp}|w=${withFp}|pii=${includePii ? 1 : 0}${flattenFp}${encodingFp}${lockFp}${this.globalFilterCacheSegment()}`;

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
        // A MULTI-column `distinct` gives up its server-side prepared-statement
        // name, for the same reason a caller-written `OR` array does and by the
        // same mechanism (see markVariableArity). The channel here is ORDER, not
        // arity: the column list is written into the SQL text one term at a
        // time, so the reachable statement set is the ORDERED subsets of the
        // table's columns. Measured on PostgreSQL 16, a seven-column table:
        // 5,040 `distinct` permutations left 5,040 further permanent statements
        // and took CachedPlanSource from 39.4 MB to 59.1 MB on ONE connection.
        //
        // UNNAMED rather than canonicalized, which is what `select` and the
        // write `data` list do, and the asymmetry is the point. This list is
        // re-emitted as the leading terms of the inner ORDER BY a few lines
        // below, and with no `orderBy` at all PostgreSQL's choice of
        // representative row per group is explicitly unpredictable, so
        // reordering it could hand a caller a different row. Withholding the
        // name changes no SQL text and therefore cannot. The cost is one extra
        // server-side parse per execution on an already-rare query shape.
        //
        // `length > 1` because a single column has exactly one ordering and so
        // no permutation space: the common `distinct: ['tenantId']` keeps its
        // name. Repeats are already dropped upstream (dedupeColumnList), so the
        // list here is distinct columns and nothing else.
        if (args.distinct.length > 1) this.ctx.markVariableArity();
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
      if (cursorPlan) {
        const predicate = this.renderCursorPredicate(cursorPlan, freshParams);
        tail += freshWhereSql ? ` AND ${predicate}` : ` WHERE ${predicate}`;
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
          throw new ValidationError('`distinct` cannot be combined with vector distance ordering.');
        }
        const userOrder = this.buildOrderBy(args.orderBy, freshParams);
        // The outer level re-orders by the user's columns, which must therefore
        // exist in the derived table. A NARROWED projection (`select`, `omit`,
        // or the PII rule, which narrows with no user projection at all) left
        // them out, so the statement failed with 42703. Every order column the
        // projection omits is projected into the INNER query under its own
        // name, and the outer SELECT then lists the projected columns
        // explicitly instead of `*`, so the extra column orders the result and
        // never reaches a row (a PII column never even crosses the wire). The
        // full projection (`columnsList === null`, `"t".*`) and a projection
        // that already covers the order keeps the `SELECT *` wrapper byte for
        // byte. The user's order is rendered ONCE (params pushed once, as the
        // collect path mirrors) and its text reused at both levels.
        let innerSelect = selectClause;
        let outerSelect = '*';
        if (columnsList) {
          const projected = new Set(columnsList);
          const extras: string[] = [];
          for (const [key] of orderByEntries(args.orderBy)) {
            // Relation and vector ordering are refused above, so every key
            // names a column of this table (a JSON-path entry's key is its
            // column); buildOrderBy has already validated it.
            const col = this.toColumn(key);
            if (!projected.has(col) && !extras.includes(col)) extras.push(col);
          }
          if (extras.length > 0) {
            innerSelect = `${selectClause}, ${extras.map((c) => `${qt}.${this.q(c)}`).join(', ')}`;
            outerSelect = this.distinctOuterSelectList(columnsList, args.with as WithClause | undefined).join(', ');
          }
        }
        const inner = `SELECT ${distinctPrefix}${innerSelect} FROM ${qt}${tail} ORDER BY ${distinctCols
          .map((c) => `${c} ASC`)
          .join(', ')}, ${userOrder}`;
        sql = `SELECT ${outerSelect} FROM (${inner}) AS ${this.q(`${this.table}_distinct`)} ORDER BY ${userOrder}`;
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
      // The locking clause follows pagination and binds nothing.
      if (rowLock) sql += rowLock.sql;

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
    // 3. Cursor params: the build's own renderer, SQL discarded.
    if (cursorPlan) this.renderCursorPredicate(cursorPlan, params);
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
      ...rowLockMarker(rowLock),
    };
  }

  // -------------------------------------------------------------------------
  // findManyStream / findManyStreamBatches, async iterables using PostgreSQL cursors
  // -------------------------------------------------------------------------

  /**
   * Build the one row parser a whole drain uses.
   *
   * Shared by {@link findManyStream} and {@link findManyStreamBatches} so the
   * two can never disagree about a row's SHAPE while agreeing about its
   * contents: the flatten plan, the positional/object relation decode and the
   * PII projection are all decided here, once, before a statement is issued.
   *
   * The plan is a pure function of the schema, the `with` shape and
   * `includePii`, never of `limit`, so the batch-size override the speculative
   * fetch applies cannot change it and the parser always matches the emitted
   * SQL. Reading the raw `includePii` sentinel with `=== true` here would have
   * quietly planned a no-PII parser over a with-PII statement, which is why it
   * goes through `resolveUnsafeFlag` on every path, `with` clause or not.
   */
  private makeStreamRowParser<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args?: FindManyStreamArgs<T, R, W, S, O>): (row: Record<string, unknown>) => Record<string, unknown> {
    const streamPii = resolveUnsafeFlag(args?.includePii, 'includePii');
    // THIS CALL IS ORDER-CRITICAL, and it is why the resolution is a method
    // rather than an expression inlined into the two build sites. The parser is
    // built HERE, before `streamRaw` reaches `buildFindMany` and pins the
    // encoding itself, so without this the parser would be planned against the
    // CLIENT default while the statement was built against the query's
    // override: positional SQL decoded as objects, or the reverse. Both build
    // from the same `args`, so both resolve to the same value; the invalid-value
    // throw also lands here first, before a connection is taken.
    this.resolveJsonEncoding(args?.jsonEncoding);
    if (!args?.with) {
      const table = this.table;
      return (row) => this.parseRow(row, table);
    }
    const streamFlattenPlan = this.planFlatten(args, streamPii);
    return this.makeNestedParser(args.with as WithClause, streamPii, streamFlattenPlan);
  }

  /**
   * Everything a stream does to the DATABASE, and nothing it does to a row.
   *
   * {@link findManyStream} and {@link findManyStreamBatches} are the same drain
   * handed out at two granularities, so the statement they issue, when the
   * cursor opens, and how the connection is released all live here once. Only
   * the yielding differs, which is the entire point of having both.
   *
   * Parsing deliberately stays in the callers: they parse at different
   * granularities, and the per-row method must keep parsing LAZILY, one row at
   * a time, exactly as it always has. Hoisting the parse in here would make a
   * consumer that breaks after the first row pay for the rest of its batch.
   *
   * `action` is the tag query events carry. It is a parameter rather than a
   * constant so each public method reports its own name instead of the name of
   * whichever one happens to be implemented over the other.
   *
   * An EMPTY batch is never yielded: the dialect's cursor loop breaks on a
   * zero-row FETCH, and the speculative path below yields nothing at all when
   * the result set is empty. Callers may therefore treat a yielded batch as
   * non-empty.
   */
  private async *streamRaw<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(
    args: FindManyStreamArgs<T, R, W, S, O> | undefined,
    action: string,
    idle: StreamIdleState,
    unit: string,
  ): AsyncGenerator<Record<string, unknown>[], void, undefined> {
    // Canonical args BEFORE the speculative build below, which spreads `args`
    // and sets its own `limit`: a surviving `take` would reach that spread
    // beside it and be read as a second value for one bound.
    args = this.normalizeArgs(args);
    const batchSize = Math.max(1, Math.floor(Number(args?.batchSize ?? 1000)));
    // Validated on every path, so a bad value is refused whether or not this
    // stream turns out to need a cursor.
    const idleTimeoutMs = resolveStreamIdleTimeout(args?.idleTimeoutMs, 'idleTimeoutMs') ?? this.streamIdleTimeoutMs;

    this.currentAction = action;
    // The two streaming methods do NOT go through `executeWithMiddleware`, so
    // the unknown-key diagnostic has to be hung here as well or a stream would
    // be the one read that silently drops an `include`. Both public methods
    // reach this, and each passes its own name.
    warnUnknownQueryOptions(this.table, action, args, this.advice ?? null);
    // Streaming is ALREADY immune to the generic-plan cliff: the speculative
    // fetch has never passed a prepared name, and the cursor path runs through
    // DECLARE, so neither statement enters the plan cache. `preparedNameFor` is
    // still called, with no name, so that `forceCustomPlan: true` is VALIDATED on
    // an engine that cannot honour it here either, rather than being quietly
    // satisfied by an accident of this code path. It is called OUTSIDE the
    // speculation branch below: it used to be the speculative fetch's own
    // argument, which would have made that validation conditional on a batch
    // size the moment the speculation became conditional.
    const streamPreparedName = this.preparedNameFor(args, undefined);

    // --- Speculative first fetch: try to satisfy the entire drain in one RTT ---
    //
    // A drain that fits in one batch needs no cursor, and skipping it saves the
    // four extra round trips BEGIN / DECLARE / CLOSE / COMMIT cost. That is the
    // whole point of this fetch, and it is a good trade while the statement is
    // cheap to throw away.
    //
    // On OVERFLOW it is thrown away: these rows were read outside the cursor's
    // transaction, so yielding them and then continuing from the cursor would
    // splice two snapshots together, and resuming past them would need an
    // ORDER BY the caller never asked for. Both are unsound, so the cursor
    // re-reads from row one and this fetch cost `batchSize + 1` rows for
    // nothing.
    //
    // That waste is proportional to `batchSize`, which is the one number the
    // caller raises when they expect MORE rows, so the optimization used to get
    // most expensive exactly where it was least likely to pay off: raising
    // `batchSize` for throughput made every large drain slower, and the stream
    // was the only thing here that got slower as `batchSize` went up. So the
    // speculation is now bounded BY `batchSize` rather than scaled by it. At or
    // below the default it is unchanged; above it, a caller asking for large
    // batches has told us not to expect a one-batch result, and we go straight
    // to the cursor and waste nothing. The cost of being wrong about that is
    // four round trips on a drain that would have fit, never any transferred
    // rows.
    if (batchSize <= STREAM_SPECULATION_MAX_BATCH) {
      // The caller's bound (or the client's `defaultLimit`, exactly as findMany
      // applies it) caps the speculative fetch. When the bound fits in a batch
      // the speculative fetch IS the whole answer; otherwise `rows <= batchSize`
      // still means fewer rows exist than either bound, and an overflow goes to
      // the cursor, whose statement carries the caller's own LIMIT.
      const callerLimit = args?.limit ?? this.defaultLimit;
      const bound = callerLimit === undefined ? undefined : this.paginationValue(callerLimit, 'limit');
      const speculativeDeferred = this.buildFindMany({
        ...args,
        limit: bound !== undefined && bound <= batchSize ? bound : batchSize + 1,
        // Only the caller's own bound makes this a page (completePageOrder).
        ...firstRowOnly(args),
      } as FindManyArgs<
        T,
        R,
        TypedWithClause<R>,
        Record<string, boolean> | undefined,
        Record<string, boolean> | undefined
      >);

      const speculativeResult = await this.readWithTimeout(
        speculativeDeferred.sql,
        speculativeDeferred.params,
        args?.timeout,
        streamPreparedName,
      );

      if (speculativeResult.rows.length <= batchSize) {
        // Small drain, hand over the whole result and return, no cursor needed.
        if (speculativeResult.rows.length > 0) yield speculativeResult.rows;
        return;
      }
    }

    // --- Overflow, or speculation declined: cursor path from scratch ---
    const deferred = this.buildFindMany(args as unknown as FindManyArgs<T, R, W, S, O>);

    // Acquire a dedicated connection: cursors require a single connection in a
    // transaction. The dialect owns the streaming SQL (Postgres: BEGIN → DECLARE
    // … NO SCROLL CURSOR FOR → FETCH n → CLOSE → COMMIT, ROLLBACK on error); we
    // just yield the row batches it produces.
    //
    // Inside a caller-owned transaction there is nothing to check out: the
    // transaction-scoped pool pins every query to the transaction's own
    // connection, so `pool.query` already IS that connection. The stream rides
    // on it, is never released here, and the dialect is told to emit no
    // transaction control of its own (`ambientTransaction`).
    const held = this.txScoped ? null : await this.acquireConnection();
    const client = held?.client ?? null;
    const base: StreamableConnection = client ?? {
      query: async (text: string, values?: unknown[]) =>
        (await this.pool.query(text, values)) as { rows: Record<string, unknown>[] },
    };
    // The idle guard watches only a stream that holds a connection of its own
    // between pulls. Inside a caller's transaction the connection is theirs and
    // their transaction's timeout bounds it. On PostgreSQL the stream's BEGIN
    // also carries the server-side limit (see streamBackstopStatement), and the
    // guard keeps a live consumer's transaction from looking idle to it.
    const watched = held !== null && idleTimeoutMs > 0;
    const backstop = watched && this.dialect.capabilities.idleTransactionTimeout;
    let guard: StreamIdleGuard | undefined;
    const conn = watched
      ? watchStreamConnection(
          base,
          () => guard,
          backstop
            ? { begin: this.dialect.beginStatement(), statement: streamBackstopStatement(idleTimeoutMs) }
            : undefined,
        )
      : base;
    // The cursor's statement carries the `sqlComment` like any other (the
    // speculative fetch above got it at the execute seam). Never named: a
    // cursor is declared by text.
    const streamSql = this.outgoing(deferred.sql, undefined, action).text;
    const stream = this.dialect.openStream(conn, streamSql, deferred.params, batchSize, {
      ambientTransaction: this.txScoped,
    });
    if (watched) {
      guard = new StreamIdleGuard(
        idle,
        idleTimeoutMs,
        () => streamIdleExpiredError(action, this.table, idleTimeoutMs, unit),
        () => this.expireIdleStream(stream, held, action, idleTimeoutMs, idle, unit),
        backstop ? () => base.query('SELECT 1') : undefined,
      );
    }
    try {
      // Driven by hand rather than `yield*`, so an expired stream's cleanup can
      // run from the timer while this generator is suspended.
      while (true) {
        const step = await stream.next();
        if (step.done) break;
        yield step.value;
        if (idle.expired) throw idle.expired;
      }
    } catch (err) {
      if (err === idle.expired) throw err;
      // Wrap pg constraint errors so streaming surfaces typed errors like the rest of the API
      throw explainConnectionLoss(wrapPgError(err), held?.checkout.lostWith);
    } finally {
      guard?.stop();
      if (guard?.expiry) {
        // The timer already closed the stream and released the connection;
        // wait for that so the connection is never handed back mid-cleanup.
        await guard.expiry;
      } else {
        try {
          // An early exit (`break`) closes the cursor here; after a full drain
          // or an error the dialect's generator has finished and this is a no-op.
          await stream.return(undefined);
        } catch (err) {
          // Only an early exit can reach this throw: after an error or a full
          // drain the dialect's generator has finished and return() resolves.
          // A failed CLOSE / COMMIT on an early exit must reach the caller, as
          // it did when this loop was a `yield*`.
          // biome-ignore lint/correctness/noUnsafeFinally: it replaces only an early-exit return, see above
          throw explainConnectionLoss(wrapPgError(err), held?.checkout.lostWith);
        } finally {
          held?.checkout.release();
        }
      }
    }
  }

  /**
   * Close a stream whose consumer asked for nothing within its idle timeout:
   * run the dialect's own cleanup (PostgreSQL: CLOSE, COMMIT), release the
   * connection (with the cleanup's error, if any, so the pool discards it), and
   * log `stream-idle-timeout`. The log line matters: an abandoned consumer
   * never pulls again, so it never sees the E002 waiting for it.
   */
  private async expireIdleStream(
    stream: AsyncGenerator<Record<string, unknown>[], void, undefined>,
    held: Checkout,
    action: string,
    timeoutMs: number,
    idle: StreamIdleState,
    unit: string,
  ): Promise<void> {
    let failure: unknown;
    try {
      await stream.return(undefined);
    } catch (err) {
      failure = err;
    } finally {
      held.checkout.release(failure === undefined ? undefined : failure instanceof Error ? failure : true);
    }
    logTo(
      this.logger,
      'warn',
      `${action} on "${this.table}" had no ${unit} requested for ${timeoutMs} ms, so Turbine closed its cursor ` +
        `and released its connection (${idle.rows} ${idle.rows === 1 ? 'row' : 'rows'} handed out before that). ` +
        'An iterator that is kept and never finished, or a response stream torn down without calling return(), ' +
        'leaves a stream like this. The next request on it throws TimeoutError (E002).',
      { code: 'stream-idle-timeout', table: this.table, operation: action, timeoutMs, rows: idle.rows },
    );
  }

  /**
   * Stream rows from a findMany query using PostgreSQL cursors, one BATCH of
   * rows at a time.
   *
   * The same drain {@link findManyStream} performs, the same statements, the
   * same cursor, the same rows in the same order, handed out as arrays instead
   * of one row at a time. That is worth having because the per-row form costs
   * one promise resolution and one microtask turn PER ROW: measured over 50,000
   * rows on a local PostgreSQL, per-row yielding costs ~7 ms (~140 ns/row) that
   * batch yielding does not, which is roughly half of the streaming overhead
   * over a hand-written cursor loop. Nothing else about the two paths differs,
   * so the entire saving is the yielding.
   *
   * Prefer this whenever the consumer can work on an array; keep
   * {@link findManyStream} when a row at a time is what the code actually wants,
   * since flattening a batch by hand costs exactly what it saves.
   *
   * A yielded batch is never empty, and its length is NOT a contract: it is at
   * most `batchSize`, the final batch is usually shorter, and a result set that
   * fits within one batch arrives as a single array from the speculative fetch
   * with no cursor involved. Do not use batch boundaries to infer anything
   * about the data.
   *
   * Every other streaming behaviour is shared and documented on
   * {@link findManyStream}: the speculative fast path, the cursor path and its
   * cleanup, the snapshot semantics, and early `break`.
   *
   * @example
   * ```ts
   * for await (const batch of db.users.findManyStreamBatches({ where: { orgId: 1 }, batchSize: 500 })) {
   *   await sink.writeAll(batch);
   * }
   * ```
   */
  async *findManyStreamBatches<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args?: FindManyStreamArgs<T, R, W, S, O>): AsyncGenerator<QueryResult<T, R, W, S, O>[], void, undefined> {
    args = this.normalizeArgs(args);
    this.assertNoStreamLock(args, 'findManyStreamBatches');
    const parse = this.makeStreamRowParser<W, S, O>(args);
    const idle = newStreamIdleState();
    for await (const batch of this.streamRaw<W, S, O>(args, 'findManyStreamBatches', idle, 'batch')) {
      const parsed = new Array<QueryResult<T, R, W, S, O>>(batch.length);
      for (let i = 0; i < batch.length; i++) {
        parsed[i] = parse(batch[i]!) as QueryResult<T, R, W, S, O>;
      }
      idle.rows += parsed.length;
      // `suspended` and `pulls` are the idle guard's whole view of the
      // consumer: two writes per yield, no timer work.
      idle.suspended = true;
      yield parsed;
      idle.suspended = false;
      idle.pulls++;
      if (idle.expired) throw idle.expired;
    }
  }

  /**
   * Stream rows from a findMany query using PostgreSQL cursors.
   * Returns an AsyncIterable that yields individual rows, fetching in batches internally.
   *
   * See {@link findManyStreamBatches} for the same drain yielded a batch at a
   * time, which is measurably cheaper when the consumer can take an array.
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
    args = this.normalizeArgs(args);
    this.assertNoStreamLock(args, 'findManyStream');
    const parse = this.makeStreamRowParser<W, S, O>(args);
    // Parsed one row at a time, INSIDE the yield loop rather than a batch ahead
    // of it, so a consumer that breaks early still pays only for the rows it
    // took. That laziness is the reason this loop is not written over
    // `findManyStreamBatches`.
    const idle = newStreamIdleState();
    for await (const batch of this.streamRaw<W, S, O>(args, 'findManyStream', idle, 'row')) {
      for (let i = 0; i < batch.length; i++) {
        const row = parse(batch[i]!) as QueryResult<T, R, W, S, O>;
        idle.rows++;
        // See findManyStreamBatches: the idle guard's view of the consumer.
        idle.suspended = true;
        yield row;
        idle.suspended = false;
        idle.pulls++;
        if (idle.expired) throw idle.expired;
      }
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
    // BEFORE the strategy branch, so the batched and auto paths below read the
    // same canonical args the builders do, and so an all-undefined `where` is
    // refused before anything runs (see normalizeArgs).
    args = this.normalizeArgs(args, 'findFirst');
    this.assertLockInTransaction(args, 'findFirst');
    return this.executeWithMiddleware('findFirst', (args ?? {}) as Record<string, unknown>, async () => {
      if (args?.with) {
        const strategy = this.resolveLoadStrategy(args.relationLoadStrategy);
        // findFirst is findMany + LIMIT 1: batch the single base row, then load.
        if (strategy === 'batched') {
          const rows = await this.runFindManyBatched({
            ...args,
            limit: 1,
            ...firstRowOnly(args),
          } as unknown as FindManyArgs<T>);
          return (rows[0] ?? null) as QueryResult<T, R, W, S, O> | null;
        }
        if (strategy === 'auto') {
          // findFirst is findMany + LIMIT 1: a one-row parent set.
          const split = this.planAuto(args.with as WithClause, args.stableRelationOrder, false, 1);
          if (split) {
            const rows = (await this.runAutoSplit(
              { ...args, limit: 1, ...firstRowOnly(args) } as unknown as FindManyArgs<T>,
              split,
              false,
            )) as Record<string, unknown>[];
            return (rows[0] ?? null) as QueryResult<T, R, W, S, O> | null;
          }
        }
      }
      const deferred = this.buildFindFirst(args);
      const result = await this.readWithTimeout(
        deferred.sql,
        deferred.params,
        args?.timeout,
        this.preparedNameFor(args, deferred.preparedName),
      );
      return deferred.transform(result);
    }) as Promise<QueryResult<T, R, W, S, O> | null>;
  }

  buildFindFirst<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args?: FindManyArgs<T, R, W, S, O>): DeferredQuery<QueryResult<T, R, W, S, O> | null> {
    return this.buildFindFirstAs<W, S, O>(args, 'findFirst');
  }

  /**
   * findFirst / findFirstOrThrow over findMany's builder with `LIMIT 1`.
   * `operation` names the method in the refusal of an all-undefined `where`.
   */
  private buildFindFirstAs<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(
    args: FindManyArgs<T, R, W, S, O> | undefined,
    operation: string,
  ): DeferredQuery<QueryResult<T, R, W, S, O> | null> {
    args = this.normalizeArgs(args, operation);
    // Reuse findMany's SQL builder but force LIMIT 1
    const findManyArgs = { ...args, limit: 1, ...firstRowOnly(args) } as FindManyArgs<T, R, W, S, O>;
    const deferred = this.buildFindMany<W, S, O>(findManyArgs);

    return {
      sql: deferred.sql,
      params: deferred.params,
      transform: (result) => {
        const rows = deferred.transform(result);
        return rows.length > 0 ? rows[0]! : null;
      },
      tag: `${this.table}.findFirst`,
      ...(deferred.rowLock ? { rowLock: true as const } : {}),
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
    args = this.normalizeArgs(args, 'findFirstOrThrow');
    this.assertLockInTransaction(args, 'findFirstOrThrow');
    return this.executeWithMiddleware('findFirstOrThrow', (args ?? {}) as Record<string, unknown>, async () => {
      const deferred = this.buildFindFirstOrThrow(args);
      const result = await this.readWithTimeout(
        deferred.sql,
        deferred.params,
        args?.timeout,
        this.preparedNameFor(args, deferred.preparedName),
      );
      return deferred.transform(result);
    }) as Promise<QueryResult<T, R, W, S, O>>;
  }

  buildFindFirstOrThrow<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args?: FindManyArgs<T, R, W, S, O>): DeferredQuery<QueryResult<T, R, W, S, O>> {
    args = this.normalizeArgs(args, 'findFirstOrThrow');
    const inner = this.buildFindFirstAs<W, S, O>(args, 'findFirstOrThrow');

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
      ...(inner.rowLock ? { rowLock: true as const } : {}),
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
  >(args: FindUniqueArgs<T, R, W, S, O, M['whereUnique']>): Promise<QueryResult<T, R, W, S, O>> {
    args = this.normalizeArgs(args);
    this.assertLockInTransaction(args, 'findUniqueOrThrow');
    return this.executeWithMiddleware('findUniqueOrThrow', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildFindUniqueOrThrow(args);
      const result = await this.readWithTimeout(
        deferred.sql,
        deferred.params,
        args.timeout,
        this.preparedNameFor(args, deferred.preparedName),
      );
      return deferred.transform(result);
    }) as Promise<QueryResult<T, R, W, S, O>>;
  }

  buildFindUniqueOrThrow<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args: FindUniqueArgs<T, R, W, S, O, M['whereUnique']>): DeferredQuery<QueryResult<T, R, W, S, O>> {
    args = this.normalizeArgs(args);
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
      ...(inner.rowLock ? { rowLock: true as const } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  async create<
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args: CreateArgs<T, R, S, O, M['create']>): Promise<FieldResult<T, S, O>> {
    args = this.normalizeArgs(args);
    return this.executeWithMiddleware('create', args as unknown as Record<string, unknown>, async () => {
      if (hasRelationFields(args.data as Record<string, unknown>, this.tableMeta)) {
        return this.nestedCreate(args) as Promise<FieldResult<T, S, O>>;
      }
      const deferred = this.buildCreate(args);
      return this.executeMutation(deferred, args.timeout);
    });
  }

  // -------------------------------------------------------------------------
  // createMany, uses UNNEST for performance
  // -------------------------------------------------------------------------

  async createMany<
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args: CreateManyArgs<T, M['createMany'], S, O>): Promise<FieldResult<T, S, O>[]> {
    args = this.normalizeArgs(args);
    return this.executeWithMiddleware('createMany', args as unknown as Record<string, unknown>, async () => {
      const projection = this.resolveWriteProjection(args);
      const base = args as unknown as CreateManyArgs<T>;
      // One statement when the rows fit the engine's per-statement limits,
      // else chunks that do, all in one transaction so the rows land together
      // or not at all. (`buildCreateMany`, one statement for a pipeline,
      // refuses instead.)
      const { chunks, rowsPerChunk } = writesMod.planCreateMany(this.ctx, base, projection);
      const run = async (): Promise<FieldResult<T, S, O>[]> => {
        // An engine that applies two rows whose onConflict keys are equal only
        // under the column's collation (SQLite's NOCASE) as an insert and an
        // update of one row, in one statement, is caught by the transform (the
        // row comes back twice), so the statement runs in a transaction that
        // refusal rolls back. A reselect write already runs in one.
        const appliesRepeatedKeys =
          base.onConflict !== undefined &&
          this.dialect.capabilities.bulkUpsertAppliesRepeatedKeys &&
          this.dialect.resultStrategy !== 'reselect';
        if (chunks.length === 1 && !appliesRepeatedKeys) {
          return this.executeMutation(chunks[0]!, args.timeout) as Promise<FieldResult<T, S, O>[]>;
        }
        const reselects = this.dialect.resultStrategy === 'reselect';
        return this.inOneTransaction(
          async (exec) => {
            const rows: FieldResult<T, S, O>[] = [];
            for (const chunk of chunks) {
              const result =
                reselects && chunk.reselect
                  ? await chunk.reselect(exec)
                  : await exec(chunk.sql, chunk.params, chunk.preparedName);
              rows.push(...(chunk.transform(result) as unknown as FieldResult<T, S, O>[]));
            }
            return rows;
          },
          args.timeout,
          `createMany of ${base.data.length} rows`,
          `Insert at most ${rowsPerChunk} rows per call, which fits one statement, or pass a pool that can check ` +
            'out a connection.',
        );
      };
      if (base.onConflict === undefined) return run();
      try {
        return await run();
      } catch (err) {
        throw writesMod.explainConflictKeyCollision(this.ctx, base, err);
      }
    });
  }

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------

  async update<
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args: UpdateArgs<T, R, S, O, M['update']>): Promise<FieldResult<T, S, O>> {
    args = this.normalizeArgs(args);
    return this.executeWithMiddleware('update', args as unknown as Record<string, unknown>, async () => {
      if (hasRelationFields(args.data as Record<string, unknown>, this.tableMeta)) {
        return this.nestedUpdate(args) as Promise<FieldResult<T, S, O>>;
      }
      const deferred = this.buildUpdate(args);
      return this.executeMutation(deferred, args.timeout);
    });
  }

  // -------------------------------------------------------------------------
  // Nested write helpers (shared by create + update)
  // -------------------------------------------------------------------------

  private async nestedCreate(
    args: CreateArgs<T, R, Record<string, boolean> | undefined, Record<string, boolean> | undefined>,
  ): Promise<T> {
    const data = args.data as Record<string, unknown>;
    // Validated up front, before any row is written, and then applied by the
    // nested engine's final read-back, which already speaks select/omit.
    this.resolveWriteProjection(args);
    const shape = { select: args.select, omit: args.omit };

    if (this.txScoped) {
      const ctx = this.buildNestedCtx();
      return executeNestedCreate(ctx, this.table, data, 0, [], shape) as Promise<T>;
    }

    return this.runInImplicitTx(async (ctx) => {
      const result = await executeNestedCreate(ctx, this.table, data, 0, [], shape);
      return result as T;
    });
  }

  private async nestedUpdate(
    args: UpdateArgs<T, R, Record<string, boolean> | undefined, Record<string, boolean> | undefined>,
  ): Promise<T> {
    const data = args.data as Record<string, unknown>;
    const where = args.where as Record<string, unknown>;
    this.resolveWriteProjection(args);
    const shape = { select: args.select, omit: args.omit };

    if (this.txScoped) {
      const ctx = this.buildNestedCtx();
      return executeNestedUpdate(ctx, this.table, where, data, 0, [], shape) as Promise<T>;
    }

    return this.runInImplicitTx(async (ctx) => {
      const result = await executeNestedUpdate(ctx, this.table, where, data, 0, [], shape);
      return result as T;
    });
  }

  /**
   * Check out a guarded pooled connection, as a typed error when that fails.
   * Shared with client.ts through checkout.ts (see there for why each part
   * matters); the cursor stream holds it, and a nested write opens its
   * implicit transaction on one through `openCheckout`.
   */
  private acquireConnection(): Promise<Checkout> {
    return acquireConnection(this.pool);
  }

  private async runInImplicitTx<R>(fn: (ctx: NestedWriteContext) => Promise<R>): Promise<R> {
    // client.ts registers TransactionClient when it is evaluated (it cannot be
    // imported from here, see transaction-client-slot.ts). Read before the
    // checkout, so a program that never loaded client.ts gets a typed error
    // without a connection having been touched.
    const TransactionClient = transactionClientFor(`A nested write or lookup-first upsert on "${this.table}"`);
    // BEGIN runs inside openCheckout, which sends it once more on a fresh
    // connection when the first one turns out to be dead and releases the
    // connection itself when BEGIN fails for good. The catch below therefore
    // only sees a transaction that began, and never emits a stray ROLLBACK on
    // a connection that opened none.
    const { client, checkout } = await openCheckout(this.pool, (c) => c.query(this.dialect.beginStatement()));
    try {
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
      try {
        await client.query(this.dialect.rollbackStatement());
      } catch {
        // Best-effort rollback: connection may have died.
      }
      throw explainConnectionLoss(err, checkout.lostWith);
    } finally {
      checkout.release();
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

  async delete<
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args: DeleteArgs<T, R, S, O>): Promise<FieldResult<T, S, O>> {
    args = this.normalizeArgs(args);
    return this.executeWithMiddleware('delete', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildDelete(args);
      return this.executeMutation(deferred, args.timeout);
    });
  }

  // -------------------------------------------------------------------------
  // upsert, INSERT ... ON CONFLICT ... DO UPDATE
  // -------------------------------------------------------------------------

  async upsert<
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args: UpsertArgs<T, R, S, O, M['whereUnique'], M['createMany'], M['updateMany']>): Promise<FieldResult<T, S, O>> {
    args = this.normalizeArgs(args);
    return this.executeWithMiddleware('upsert', args as unknown as Record<string, unknown>, async () => {
      // First: the nested-write branch below decides before upsertLookupReason
      // would have refused it.
      writesMod.assertNoOptimisticLock(this.ctx, args, 'upsert');
      if (this.upsertNeedsLookup(args)) {
        return this.upsertLookupFirst(args) as Promise<FieldResult<T, S, O>>;
      }
      const deferred = this.buildUpsert(args);
      return this.executeMutation(deferred, args.timeout);
    });
  }

  /**
   * @internal Whether `upsert()` looks the row up rather than running one
   * statement, which is also exactly when `buildUpsert` refuses these args.
   * prisma-compat reads it to decide whether an array `$transaction` can batch
   * an upsert or has to run the array inside a transaction.
   */
  upsertNeedsLookup(
    args: UpsertArgs<T, R, Record<string, boolean> | undefined, Record<string, boolean> | undefined>,
  ): boolean {
    args = this.normalizeArgs(args);
    return (
      hasRelationFields((args.create ?? {}) as Record<string, unknown>, this.tableMeta) ||
      hasRelationFields((args.update ?? {}) as Record<string, unknown>, this.tableMeta) ||
      writesMod.upsertLookupReason(this.ctx, args as UpsertArgs<T>) !== null
    );
  }

  /**
   * `upsert` as Prisma defines it: find the row `where` names, update it if it
   * exists, else insert `create`, in one transaction (the caller's, when there
   * is one). Taken whenever the single conflict statement would mean something
   * else (`upsertLookupReason`: `where` not pinned to `create`'s values, an
   * empty `update`, a global filter the engine's statement cannot carry) and
   * whenever `create` or `update` holds nested relation writes, which only the
   * nested-write engine can run.
   *
   * Validation is DATA-INDEPENDENT, as it is for the batched relation loader:
   * both halves are compiled before the lookup runs, so an unknown field in
   * `update` is refused whether or not the row exists, and a call is never
   * valid on one row and invalid on the next. Only the scalar part of each half
   * is compiled here; nested relation writes are validated by the engine that
   * runs them.
   *
   * Not atomic against a concurrent insert of the same key, exactly as Prisma's
   * own lookup is not: two callers can both miss, and the second insert then
   * fails on the unique constraint (E008) when `create` carries the key. It
   * never writes two rows over one key the database enforces.
   */
  private async upsertLookupFirst(
    args: UpsertArgs<T, R, Record<string, boolean> | undefined, Record<string, boolean> | undefined>,
  ): Promise<T> {
    const where = (args.where ?? {}) as Record<string, unknown>;
    const create = (args.create ?? {}) as Record<string, unknown>;
    // `expr.excluded(field)` in `update` reads the incoming row, which here is
    // `create`: resolved to create's value before the update compiles, as the
    // single-statement path does.
    const update = (resolveExcludedFromCreate(this.ctx, (args.update ?? {}) as Record<string, unknown>, create) ??
      {}) as Record<string, unknown>;
    assertMutationWhereIdentifiesOneRow(
      this.tableMeta,
      this.table,
      expandCompoundUniqueWhere(this.tableMeta, where),
      'upsert',
    );
    this.resolveWriteProjection(args);
    // An undefined option is an absent one on every call below.
    const skip = { skipGlobalFilters: args.skipGlobalFilters };
    const shape = { select: args.select, omit: args.omit, timeout: args.timeout };
    const scalarCreate = extractRelationFields(create, this.tableMeta).scalars;
    const scalarUpdate = extractRelationFields(update, this.tableMeta).scalars;
    const updateIsEmpty = Object.values(update).every((v) => v === undefined);
    if (Object.keys(scalarCreate).length > 0) this.buildCreate({ data: scalarCreate } as CreateArgs<T, R>);
    if (Object.values(scalarUpdate).some((v) => v !== undefined)) {
      this.buildUpdate({ where, data: scalarUpdate, ...skip } as UpdateArgs<T, R>);
    }

    const run = async (table: QueryInterface<T>): Promise<T> => {
      const found = await table.findUnique({ where, ...shape, ...skip } as FindUniqueArgs<T>);
      if (found) {
        // Prisma reads an empty `update` as "leave it as it is": the row found
        // IS the answer, projected as the write would have projected it.
        if (updateIsEmpty) return found as T;
        return (await table.update({ where, data: update, ...shape, ...skip } as UpdateArgs<T, R>)) as T;
      }
      return (await table.create({ data: create as Partial<T>, ...shape } as CreateArgs<T, R>)) as T;
    };
    if (this.txScoped) {
      return run(this.buildNestedCtx().tx.table<T>(this.table) as unknown as QueryInterface<T>);
    }
    return this.runInImplicitTx((ctx) => run(ctx.tx.table<T>(this.table) as unknown as QueryInterface<T>));
  }

  // -------------------------------------------------------------------------
  // updateMany, UPDATE ... WHERE ... returning count
  // -------------------------------------------------------------------------

  async updateMany(args: UpdateManyArgs<T, R, M['updateMany']>): Promise<{ count: number }> {
    args = this.normalizeArgs(args);
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
    args = this.normalizeArgs(args);
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
    args = this.normalizeArgs(args);
    return this.executeWithMiddleware('count', (args ?? {}) as Record<string, unknown>, async () => {
      const deferred = this.buildCount(args);
      const result = await this.readWithTimeout(
        deferred.sql,
        deferred.params,
        args?.timeout,
        this.preparedNameFor(args, deferred.preparedName),
      );
      return deferred.transform(result);
    });
  }

  buildCount(args?: CountArgs<T, R>): DeferredQuery<number> {
    args = this.normalizeArgs(args);
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
    args = this.normalizeArgs(args);
    return this.executeWithMiddleware('groupBy', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildGroupBy(args);
      const result = await this.readWithTimeout(
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

  buildGroupBy<A extends GroupByArgs<T, R>>(args: A): DeferredQuery<GroupByResult<T, A>[]> {
    return aggMod.buildGroupBy(this.ctx, this.normalizeArgs(args)) as unknown as DeferredQuery<GroupByResult<T, A>[]>;
  }

  buildAggregate<A extends AggregateArgs<T, R>>(args: A): DeferredQuery<AggregateResultOf<T, A>> {
    return aggMod.buildAggregate(this.ctx, this.normalizeArgs(args)) as unknown as DeferredQuery<
      AggregateResultOf<T, A>
    >;
  }

  // -------------------------------------------------------------------------
  // aggregate, standalone aggregation without groupBy
  // -------------------------------------------------------------------------

  async aggregate<A extends AggregateArgs<T, R>>(args: A): Promise<AggregateResultOf<T, A>> {
    args = this.normalizeArgs(args);
    return this.executeWithMiddleware('aggregate', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildAggregate(args);
      const result = await this.readWithTimeout(
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
   *     so the two are not composed in this version). NOTE that this is the
   *     PostgreSQL DEFAULT, so on Postgres `'flatten'` engages only when the
   *     caller ALSO passes `jsonEncoding: 'object'`. The fallback is silent and
   *     byte-identical, and `warnFlattenBlocked` names the encoding and the
   *     escape hatch in dev;
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
      this.currentJsonEncoding === 'positional'
        ? "`jsonEncoding: 'positional'` is active (the PostgreSQL default), and a flattened relation emits no " +
          "JSON to encode. Pass `jsonEncoding: 'object'` alongside the strategy to get the flatten plan"
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

  /** Advice, once per reason: `'flatten'` was refused for the whole query. */
  private warnFlattenBlocked(reason: string): void {
    const log = this.advice;
    if (!log) return;
    if (!shouldWarnOnce(WARN_NS.flattenFallback, `${this.table}|query|${reason}`)) return;
    logTo(
      log,
      'warn',
      `relationLoadStrategy: 'flatten' did not engage on "${this.table}": ${reason}. ` +
        'Every relation loads via the correlated subquery instead (same rows, same values, different plan).',
      { code: 'flatten-blocked', table: this.table, reason },
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

  /**
   * The explicit outer SELECT list of the `distinct` + `orderBy` wrapper, used
   * only when the inner derived table had to carry ORDER BY columns the
   * projection leaves out (see the distinct branch of {@link buildFindMany}):
   * the projected base columns, then one column per `with` relation, then one
   * per counted relation. These are the aliases `buildSelectWithRelations`
   * (relations.ts) gives the same columns, `AS "<relName>"` per entry in sorted
   * order and `AS "_count__<rel>"` per counted relation, over the SAME
   * `resolveCountRelations` it uses, so the two lists name the same columns.
   * `flatten` never reaches here (the strategy is gated off under `distinct`),
   * so no prefixed scalar aliases exist to enumerate. A drift between the two
   * would fail LOUDLY, as a 42703 on the outer list, never as a silently wrong
   * row, and the live distinct test pins the `with` + `_count` shape.
   */
  private distinctOuterSelectList(columnsList: string[], withClause: WithClause | undefined): string[] {
    const list = columnsList.map((c) => this.q(c));
    if (!withClause) return list;
    for (const [relName] of sortedEntries(withClause as Record<string, unknown>)) {
      if (relName === '_count') continue;
      list.push(this.q(relName));
    }
    const countSpec = (withClause as { _count?: WithCount })._count;
    if (countSpec !== undefined) {
      for (const rel of resolveCountRelations(this.tableMeta, countSpec)) list.push(this.q(`_count__${rel.name}`));
    }
    return list;
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
      // pick.where / pick.orderBy paths). To-one relation orderBy is mirrored
      // by running its build (see collectToOneRelationOrderParams).
      if (this.isRelationOrderByValue(dir)) {
        // Mirrors the build path's resolution, so a cache HIT binds params for
        // the same relation the cached SQL was built from.
        const resolvedRel = resolveRelation(this.tableMeta.relations, key);
        const relDef = resolvedRel?.def;
        if (relDef && isRelationPickOrderBy(dir)) {
          this.collectRelationPickOrderParams(resolvedRel.name, relDef, dir, params);
        } else if (relDef && (relDef.type === 'hasMany' || relDef.type === 'manyToMany')) {
          this.collectRelationCountParams(relDef, params);
        } else if (relDef) {
          relationsMod.collectToOneRelationOrderParams(this.ctx, key, dir as Record<string, unknown>, params);
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
   * NOT ADVICE: it fires whatever `diagnostics` says, deliberately. Production
   * is exactly where a destructive write commits and where the row cannot be
   * recovered afterwards, so a warning that goes quiet in production mode is
   * silent in the only place it matters. The cost is
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
    logTo(
      this.logger,
      'warn',
      `${table}.${field} holds the Postgres value \`infinity\` (or \`-infinity\`). JavaScript has ` +
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
      { code: 'temporal-infinity', table, field },
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

  /**
   * The decode work for ONE cell of a date-bearing column, extracted so the
   * planned and unplanned row paths cannot drift apart. `null` and an
   * already-parsed `Date` are returned untouched, which is the same guard the
   * pre-plan code spelled inline.
   */
  private decodeTemporalCell(value: unknown, table: string, field: string): unknown {
    if (value === null || value instanceof Date) return value;
    if (isTemporalInfinity(value)) {
      // Postgres `infinity` / `-infinity`. No JS Date means either, so both
      // readings cost something and the default is the one that is not lossy.
      // `'preserve'` hands back the JS number, which breaks the declared `Date`
      // type at runtime (`.toISOString()` throws) and still serializes as null
      // because JSON has no infinity literal, but binds straight back, so a
      // read-modify-write stores `infinity` again. `'null'` reads nicer and
      // DESTROYS the value on that same write, because a stored infinity and a
      // stored NULL become indistinguishable. Whichever is configured, it is
      // the SAME on every read strategy: the driver hands back the number,
      // `json_build_object` hands back the string "infinity", and both land
      // here (see `isTemporalInfinity`).
      //
      // The warning fires once per column when the option was left unset, on a
      // row that actually held an infinity, and describes the reading in force
      // rather than gating on which one it is.
      this.warnTemporalInfinity(table, field);
      return this.readTemporalInfinity(value);
    }
    if (Array.isArray(value)) {
      // `dateColumns` includes array-of-date columns (`date[]`, `timestamp[]`,
      // `timestamptz[]`), for which the driver already hands back a `Date[]`.
      // Coercing the array itself ran `new Date(String(theArray))` and replaced
      // the whole column with one Invalid Date. Its ELEMENTS get the same
      // infinity mapping as a scalar (same declared element type, same JSON
      // rendering); everything else is passed through by identity.
      return this.mapArrayTemporalInfinity(value, table, field);
    }
    // Any other number on a date column is left alone rather than run through
    // `parseDbDate(String(n))`, which would produce an Invalid Date.
    if (typeof value === 'number') return value;
    // Offset-less strings (Postgres `timestamp`, json_agg output) are pinned to
    // UTC so results don't depend on the server's time zone.
    return this.utcTimestamps ? parseDbDate(String(value)) : new Date(value as string);
  }

  /** The non-temporal decode kinds of `table`'s columns, by column and by field name. */
  private getCellKinds(table: string, meta: TableMetadata): Map<string, number> {
    let kinds = this.cellKindCache.get(table);
    if (!kinds) {
      kinds = new Map();
      for (const column of meta.columns) {
        // Metadata may carry the type on the column or only in the table map.
        const pgType = column.pgType ?? meta.pgTypes?.[column.name];
        if (typeof pgType !== 'string') continue;
        let kind = cellKindOf(pgType, this.schema.enums);
        const decode = kind === CELL_PLAIN ? this.dialect.decodeColumnValue?.(pgType) : undefined;
        if (decode !== undefined) {
          kind = CELL_DIALECT;
          let decoders = this.dialectDecodeCache.get(table);
          if (!decoders) {
            decoders = new Map();
            this.dialectDecodeCache.set(table, decoders);
          }
          decoders.set(column.name, decode);
          decoders.set(column.field, decode);
        }
        if (kind === CELL_PLAIN) continue;
        kinds.set(column.name, kind);
        kinds.set(column.field, kind);
      }
      this.cellKindCache.set(table, kinds);
    }
    return kinds;
  }

  /** One cell's decode, for every kind but {@link CELL_PLAIN}. */
  private decodeCell(kind: number, value: unknown, table: string, field: string): unknown {
    switch (kind) {
      case CELL_TEMPORAL:
        return this.decodeTemporalCell(value, table, field);
      case CELL_FLOAT:
        return readJsonFloat(value);
      case CELL_FLOAT_ARRAY:
        return readJsonFloatArray(value);
      case CELL_TEXT_ARRAY:
        return readTextArray(value);
      case CELL_DIALECT:
        return this.decodeDialectCell(value, table, field);
      default:
        return value;
    }
  }

  /**
   * A {@link CELL_DIALECT} cell: the dialect's decode for the column's declared
   * type, recorded by {@link getCellKinds} when it classified the column.
   */
  private decodeDialectCell(value: unknown, table: string, field: string): unknown {
    if (value === null || value === undefined) return value;
    const decode = this.dialectDecodeCache.get(table)?.get(field);
    return decode ? decode(value) : value;
  }

  /**
   * Build the decode plan for one exact column list, and remember it as this
   * table's most recent shape so the next row of the same result set hits the
   * fast path in {@link parseRow}.
   *
   * The shape key's delimiter is NUL because it is the one byte a Postgres
   * identifier cannot contain, even quoted, so no table or column name can
   * forge a collision. It MUST be written as the six-character escape, never
   * as a literal NUL byte: a raw NUL makes byte-oriented tools classify this
   * file as binary, and `grep` then reports ZERO matches for a term that is
   * present rather than saying it declined to look. This is the largest file
   * in the repo, and that silent empty result has already sent more than one
   * search down the wrong path.
   */
  private buildRowDecodePlan(table: string, meta: TableMetadata, keys: string[]): RowDecodePlan {
    const shapeKey = `${table}\u0000${keys.join('\u0000')}`;
    let plan = this.rowPlanCache.get(shapeKey);
    if (plan === undefined) {
      const reverseMap = meta.reverseColumnMap;
      const dateCols = meta.dateColumns;
      // camelCase-keyed date fields, so nested json_build_object rows (whose
      // keys are already camelCase) get the same Date coercion as top-level rows.
      const camelDateFields = this.getCamelDateFields(table, meta);
      const cellKinds = this.getCellKinds(table, meta);
      const cols = keys.slice();
      const fields: string[] = [];
      const kinds: number[] = [];
      for (const col of cols) {
        const field = reverseMap[col] ?? col; // fall back to raw col name, not regex
        fields.push(field);
        // Top-level rows are snake_case (dateCols); nested rows are camelCase.
        kinds.push(
          dateCols.has(col) || camelDateFields.has(field)
            ? CELL_TEMPORAL
            : (cellKinds.get(col) ?? cellKinds.get(field) ?? CELL_PLAIN),
        );
      }
      plan = { cols, fields, kinds };
      this.rowPlanCache.set(shapeKey, plan);
    }
    this.rowPlanLast.set(table, plan);
    return plan;
  }

  /**
   * Whether a cached plan describes exactly this row's column list, in order.
   * A pointer compare per column: both sides are the driver's own interned
   * column-name strings, so this is far cheaper than the reverse-map lookup and
   * two Set probes per column that it replaces, and unlike a length check or a
   * fingerprint it CANNOT accept a different projection that happens to look
   * similar. That matters more than the speed: a positional plan applied to the
   * wrong column list would silently write each value under a neighbouring
   * field's name, which is the one failure mode worth paying a full comparison
   * to make impossible.
   */
  private static rowPlanMatches(plan: RowDecodePlan, keys: string[]): boolean {
    const cols = plan.cols;
    if (cols.length !== keys.length) return false;
    for (let i = 0; i < keys.length; i++) {
      if (cols[i] !== keys[i]) return false;
    }
    return true;
  }

  private parseRow(row: Record<string, unknown>, table: string): Record<string, unknown> {
    const parsed: Record<string, unknown> = {};
    const meta = this.schema.tables[table];

    if (meta) {
      // Every row of one result set has the same columns in the same order (a
      // SQL result set has fixed field descriptors, and a nested row decoded
      // from `json_build_object` has a fixed key list), so the per-column
      // name resolution and date-column membership tests are the same answer
      // recomputed for every row. Resolve them ONCE per column shape and keep
      // the plan; the shape is verified against each row rather than assumed,
      // so a caller that does hand this function heterogeneous rows gets a
      // rebuilt plan instead of a mis-mapped one.
      const keys = Object.keys(row);
      const last = this.rowPlanLast.get(table);
      const plan =
        last !== undefined && QueryInterface.rowPlanMatches(last, keys)
          ? last
          : this.buildRowDecodePlan(table, meta, keys);

      const { cols, fields, kinds } = plan;
      for (let i = 0; i < cols.length; i++) {
        const field = fields[i]!;
        const value = row[cols[i]!];
        const kind = kinds[i]!;
        // A float from the driver is already a number; only JSON's strings need reading.
        parsed[field] =
          kind === CELL_PLAIN || (kind === CELL_FLOAT && typeof value !== 'string')
            ? value
            : this.decodeCell(kind, value, table, field);
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
