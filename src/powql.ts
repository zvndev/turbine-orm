/**
 * PowqlInterface, Turbine's PowQL query generator (the PowDB analogue of
 * {@link QueryInterface}). It exposes the same public method surface as the SQL
 * `QueryInterface` (`findMany`, `create`, `update`, …) but emits **PowQL**, a
 * pipeline language, not SQL, executed through {@link PowdbPool}.
 *
 * It is a *parallel* implementation rather than a `Dialect` of the SQL builder:
 * PowQL's grammar (`T filter <e> order <k> { .col }`) shares no surface with
 * `SELECT … FROM … WHERE`, so the SQL `Dialect` seam cannot express it. Keeping
 * it separate also means the four SQL engines are untouched.
 *
 * Behavioural deltas from the SQL path, all driven by PowDB's wire reality (see
 * `docs/internal/strategy/powdb-parity-matrix.md`, every row verified against a live
 * server):
 *   - `create`/`createMany`/`update`/`delete` use PowDB 0.7.0's trailing
 *     `returning` keyword (`RETURNING *`, all columns) to surface affected rows
 *     in one round-trip. `upsert` is the lone exception, its statement does not
 *     accept `returning`, so it reselects the row by PK (a composite-PK upsert
 *     reselects-or-writes inside one flat transaction).
 *   - The PK is server-assigned when the column is `isGenerated` (PowDB's `auto`
 *     int, read back via `returning`); otherwise a defaulted **string** PK is
 *     generated client-side (UUID).
 *   - `with` (nested relations) uses **batched N+1 loaders**, D round-trips for
 *     depth D, not one query, including manyToMany (junction → targets).
 *   - **Relation filters** (`some`/`none`/`every`, all cardinalities incl. m2m)
 *     are resolved client-side to a literal `in (…)` list, never an IN-subquery:
 *     PowDB's executor caches a subquery's result by plan shape and would return
 *     a stale prior result for a later subquery of the same shape.
 *   - **Nested writes** (relation ops in `create`/`update` data) run through the
 *     shared nested-write engine as one flat top-level transaction (PowDB is
 *     single-writer, no savepoints).
 *   - pgvector / JSON / array filters and cursor streaming throw
 *     {@link UnsupportedFeatureError} (E017), they have no PowDB equivalent.
 *
 * @module
 */

import { randomUUID } from 'node:crypto';
import { guardCheckout } from './connection-guard.js';
import { resolveDiagnostics } from './diagnostics.js';
import {
  InvariantError,
  NotFoundError,
  OptimisticLockError,
  ReadOnlyError,
  RelationError,
  TimeoutError,
  UnsupportedFeatureError,
  ValidationError,
} from './errors.js';
import { consoleLogger, logTo, type TurbineLogger } from './logger.js';
import {
  executeNestedCreate,
  executeNestedUpdate,
  extractRelationFields,
  hasRelationFields,
  type NestedWriteContext,
} from './nested-write.js';
import type { PowdbPool } from './powdb.js';
import {
  ALL_POWDB_CAPABILITIES,
  atLeastVersion,
  baseTsType,
  coerceNativeValue,
  coerceValue,
  isDateColumn,
  isJsonColumn,
  isPowdbDatetimeColumn,
  isPowdbDecimalTextColumn,
  isStaleFramePowdbError,
  type PowdbCapabilities,
  type PowdbEnums,
  PowdbFloatParam,
  PowdbJsonParam,
  parsePowdbSemver,
  powdbEnumLabels,
  powqlColumnType,
  quotePowqlDotted,
  quotePowqlIdent,
  requireCapability,
  rowToEntity,
} from './powdb-shared.js';
import { assertAggregatePiiOptIn, assertGroupByKeys } from './query/aggregates.js';
import { markStitchOnly, resolveCountRelations, stitchOnlyFields } from './query/batched-loader.js';
import { unlockNestedWriteTx } from './query/builder.js';
import { isColumnRef } from './query/column-ref.js';
import {
  assertMutationWhereIdentifiesOneRow,
  assertWhereIdentifiesOneRow,
  expandCompoundUniqueWhere,
  uniqueKeyNames,
  upsertWhereMatchesCreate,
  whereIdentifiesOneRow,
} from './query/compound-unique.js';
import { exprNotAllowedMessage, isSqlExpr } from './query/expr.js';
import {
  ARRAY_OPERATOR_KEYS,
  assertOperatorOperands,
  cursorFieldValue,
  dedupeColumnList,
  isJsonFilter,
  isJsonPathOrderBy,
  isOrderBySpec,
  isRelationPickOrderBy,
  isUnmatchedPlainObject,
  isVectorOrderBy,
  normalizeOrderBy,
  operandColumnKind,
  orderByEntries,
  UPDATE_OPERATOR_KEYS,
} from './query/filters.js';
import type { MiddlewareFn, QueryEvent, QueryInterfaceOptions } from './query/index.js';
import { isJsonValue } from './query/json-value.js';
import {
  assertCursorNotEmptied,
  assertCursorWritten,
  assertWhereNotEmptiedByPruning,
  hasCursor,
  pruneUndefinedArgs,
} from './query/normalize-args.js';
import { warnUnknownQueryOptions } from './query/option-surface.js';
import { applyStableRelationOrderTo, normalizeWithClause, normalizeWithPagination } from './query/relation-names.js';
import { piiSelectRefusedMessage } from './query/relations.js';
import type { TableClient } from './query/table-client.js';
import type {
  AggregateArgs,
  AggregateResult,
  AggregateResultOf,
  CountArgs,
  CreateArgs,
  CreateManyArgs,
  DeleteArgs,
  DeleteManyArgs,
  FieldResult,
  FindManyArgs,
  FindUniqueArgs,
  GroupByArgs,
  GroupByOrderBy,
  GroupByResult,
  JsonFilter,
  JsonPathAggregateTarget,
  JsonPathGroupKey,
  JsonPathOrderBy,
  OptionalInput,
  OrderByClause,
  OrderBySpec,
  QueryResult,
  TypedWithClause,
  UpdateArgs,
  UpdateManyArgs,
  UpsertArgs,
  WhereClause,
  WithClause,
  WithCount,
} from './query/types.js';
// The privilege sentinel and its resolver: `includePii` / `allowFullTableScan`
// are unlocked ONLY by the UNSAFE symbol, on this engine exactly as on the SQL
// engines, so a spread request body cannot turn either on here either.
import { assertDirectionToken, resolveSkipGlobalFilters, resolveUnsafeFlag, UNSAFE } from './query/types.js';
import {
  assertMiddlewareArgsKept,
  availableClause,
  normalizePagination,
  ownLookup,
  readOnlyMiddlewareParams,
  relationInProjectionMessage,
  resolveColumnName,
  resolveRelationDef,
  selectNamesNothingMessage,
  selectOmitExclusiveMessage,
} from './query/utils.js';
import { shouldWarnOnce, WARN_NS } from './query/warn-registry.js';
import {
  assertJsonFilterKeys,
  emptyMutationWhereMessage,
  jsonStringEntries,
  normalizeRelationFilter,
  resolveGlobalFilterFrom,
} from './query/where.js';
import {
  type CombinatorKey,
  combinatorBranches,
  foldWhereFor,
  relationCardinalityProblem,
  relationFilterValueProblem,
  type WhereFoldOptions,
} from './query/where-compile.js';
import { assertNoBulkWritePaging, assertNoOptimisticLock } from './query/writes.js';
import {
  type ColumnMetadata,
  normalizeKeyColumns,
  type RelationDef,
  type SchemaMetadata,
  snakeToCamel,
  type TableMetadata,
} from './schema.js';
import { transactionClientFor } from './transaction-client-slot.js';

/**
 * Max parent keys per relation-loader `in (…)` query. A `with` over a large
 * parent set is split into batches of this size so a single query never exceeds
 * PowDB's per-statement param / row limits; the batches' children are merged
 * before grouping. Mirrors the chunking the parity matrix documents.
 */
const MAX_RELATION_KEYS = 1000;

/** A predicate that holds for every row (an empty `notIn`, an `OR` with an empty branch). */
const ALWAYS_TRUE = '(1 = 1)';

/**
 * Max values one `in` / `notIn` on a PowDB-native `datetime` column may carry.
 *
 * Such a list is never sent as a list: it is expanded into an equality chain
 * (see {@link PowqlInterface.buildDatetimeInList}), and PowQL spends one level
 * of its 64-level nesting budget per chain term. Measured on the 0.20.0 addon:
 * 63 terms parse at the top level, 61 one level deep, whatever else the
 * predicate contains. 32 leaves room for the surrounding filter, and is also the
 * key-chunk size the relation loaders use for a datetime correlation column, so
 * a loader can never build a chain the engine will reject.
 */
export const MAX_POWQL_DATETIME_TERMS = 32;

/**
 * Read-shaped actions whose statement may be transparently replayed once on a
 * stale wire frame when `retryStaleReads` is enabled (see
 * {@link PowqlInterface.execOnce}). Writes are deliberately absent: replaying a
 * mutation after an ambiguous reply can double-execute, matching the client's
 * own native-path policy.
 */
const POWQL_READ_ACTIONS: ReadonlySet<string> = new Set([
  'findMany',
  'findUnique',
  'findFirst',
  'count',
  'aggregate',
  'groupBy',
  'explain',
]);

/**
 * Mutating actions the {@link PowqlInterface} readonly guard refuses locally
 * (before the wire) on a read-only pool. A transaction-control `begin` is
 * guarded separately in {@link PowqlInterface.runInImplicitTx}. Kept keyed on
 * the per-call action string (never `this`-state) so a concurrent read can
 * never be mistaken for one of these.
 */
const POWQL_WRITE_ACTIONS: ReadonlySet<string> = new Set([
  'create',
  'createMany',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'upsert',
]);

/**
 * Top-level query context threaded from {@link PowqlInterface.findMany} into
 * {@link PowqlInterface.loadRelations} so the F2 native-join path can re-emit
 * the parent predicate (alias-qualified) and gate eligibility on the parent's
 * paging / configured strategy. Present only for a top-level `with`.
 */
interface PowqlParentContext<T> {
  args: FindManyArgs<T>;
  resolvedWhere: WhereClause<T> | undefined;
}

/**
 * One planned nested-projection relation (PowDB >= 0.18 shaped results): the
 * compile-side inputs for its `name: Target as tN filter … { … }` block plus
 * everything the post-execution attach pass needs to shape the JSON children
 * back into typed entities. Built by {@link PowqlInterface.planNestedRelation}
 * (which returns `null` for any ineligible shape, a silent loader fallback,
 * never an error) and consumed by {@link PowqlInterface.buildNestedBlock} /
 * {@link PowqlInterface.attachNestedRows}.
 */
interface NestedRelationPlan {
  relName: string;
  rel: RelationDef;
  options: FindManyArgs<object> & { with?: Record<string, unknown> };
  /** A fresh interface over the relation target (compile + coercion metadata). */
  targetQi: PowqlInterface<object>;
  /** to-one (belongsTo / hasOne): emit `limit 1` and unwrap `[0] ?? null`. */
  single: boolean;
  /** Projected child columns (snake names, select/omit/PII already applied). */
  cols: string[];
  /**
   * PK columns in {@link cols} only because the projection forced them in for
   * internal use; stripped back off each shaped child so a nested `select` /
   * `omit` returns the same keys the loaders and the SQL engines return.
   */
  forcedPk: string[];
  /** Sub-plans for the relation's own `with` (every level proved eligible). */
  children: NestedRelationPlan[];
}

/**
 * One row of the `schema links` catalog listing (PowDB >= 0.19.1): a declared
 * entity link owned by `owner`, traversable as `owner.name`, correlating
 * `owner.localKey = target.targetKey`. `cardinality` is `"to-one"` / `"to-many"`,
 * derived by the engine from whether `targetKey` is unique on `target`.
 */
interface LinkSnapshotRow {
  owner: string;
  name: string;
  target: string;
  localKey: string;
  targetKey: string;
  cardinality: string;
}

/**
 * Per-pool cache of the `schema links` snapshot (fetched at most once per pool):
 * scalar link-path query generation verifies a declared link matches the
 * relation before compiling to it. Keyed on the pool object identity so every
 * table interface over the same connection shares one snapshot; a WeakMap lets a
 * discarded pool's snapshot be collected. A fetch failure caches `[]` (a missing
 * listing means "no verifiable links", a silent fallback to loaders, never an
 * error).
 */
const LINK_SNAPSHOT_CACHE = new WeakMap<object, Promise<LinkSnapshotRow[]>>();

/**
 * One planned scalar to-one link-path relation (PowDB >= 0.19.1): a belongsTo
 * `with` whose child columns include a bigint/bytes value that a JSON nested
 * block cannot carry, compiled to alias-qualified scalar link paths
 * (`t0.<linkName>.<col>`) on the parent statement instead of a per-relation
 * loader. Each projected child column rides its own native typed cell (that is
 * the whole point, a scalar hop returns a native cell, so bigint/bytes survive),
 * reconstructed into the child entity by {@link PowqlInterface.attachLinkRows}.
 */
interface LinkPathPlan {
  /** The `with`-clause key: the field the reconstructed child is attached under. */
  relName: string;
  /** The DECLARED link name on the owner (the path spelling `t0.<linkName>.<col>`). */
  linkName: string;
  /** A fresh interface over the link target (coercion metadata for the child). */
  targetQi: PowqlInterface<object>;
  /** Projected child columns (snake names; select/omit/PII applied) plus the PK. */
  cols: string[];
  /** Target PK column (snake): its Empty-at-hop marks an absent to-one → null. */
  pkCol: string;
  /** Whether the user actually projected the PK (else it is stripped after presence). */
  pkProjected: boolean;
  /** Synthetic result-key prefix (`l1_…`) keeping the flat hop fields collision-free. */
  keyPrefix: string;
}

/** Operator keys recognised inside a `WhereOperator` object. */
const OPERATOR_KEYS = new Set([
  'equals',
  'gt',
  'gte',
  'lt',
  'lte',
  'not',
  'in',
  'notIn',
  'contains',
  'startsWith',
  'endsWith',
  'mode',
]);

/**
 * Aggregate keys accepted inside a per-field `having` filter, mapped to the
 * PowQL function each one emits. The set is FIXED: any other key is rejected by
 * {@link PowqlInterface.buildHaving} rather than interpolated into the query
 * text (the SQL builder holds the same contract, see `aggFnByKey` in
 * query/aggregates.ts). A Map is used deliberately so an inherited object key
 * (`constructor`, `toString`, `__proto__`) can never resolve to a function name.
 */
const POWQL_HAVING_AGG_FNS = new Map<string, string>([
  ['_sum', 'sum'],
  ['_avg', 'avg'],
  ['_min', 'min'],
  ['_max', 'max'],
  ['_count', 'count'],
]);

/**
 * Max distinct keys one client-side relation filter may resolve to.
 *
 * A relation filter becomes a literal `in (…)` list on the local key, and the
 * engine evaluates that list per row, so the cost grows with rows times keys
 * (measured on the 0.20 addon over 100k rows: about 0.3 s per 1,000 keys).
 * Past this bound the filter is refused with a typed error naming the bound,
 * instead of building a statement whose cost has no ceiling.
 */
export const MAX_RELATION_FILTER_KEYS = 10_000;

/** The relation-filter keys the SQL engines accept, in their compile order. */
const RELATION_FILTER_KEYS = ['some', 'none', 'every', 'is', 'isNot'] as const;
type RelationFilterKey = (typeof RELATION_FILTER_KEYS)[number];

/**
 * True for a branded column reference (`col('x')`). PowQL has no column-to-column
 * operand form in a filter, so a reference is refused rather than bound as data.
 * The brand is read by its registry key so this needs no import of the module
 * that creates it.
 */
function isColumnReference(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Symbol.for('turbine-orm.columnRef') in value;
}

/** A value a non-JSON column can be compared against. */
function isScalarOperand(value: unknown): boolean {
  const t = typeof value;
  return (
    t === 'string' ||
    t === 'number' ||
    t === 'bigint' ||
    t === 'boolean' ||
    value instanceof Date ||
    value instanceof Uint8Array
  );
}

/** The largest delay `setTimeout` honours; Node fires anything larger after 1 ms. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** The PowQL operator each arithmetic update operator compiles to. */
const POWQL_ARITHMETIC: Readonly<Record<string, string>> = {
  increment: '+',
  decrement: '-',
  multiply: '*',
  divide: '/',
};

/** The accepted `relationLoadStrategy` values, the SQL engines' set. */
const RELATION_LOAD_STRATEGIES: readonly string[] = Object.freeze(['join', 'batched', 'auto', 'flatten']);

/** A short, value-safe rendering of a rejected option value. */
function describeOptionValue(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}...` : value);
  return value === null ? 'null' : `a value of type ${typeof value}`;
}

/** `{ equals: v }` and nothing else. */

/** `AND` / `OR` / `NOT`, the keys {@link combinatorBranches} reads. */
function isCombinatorKey(key: string): key is CombinatorKey {
  return key === 'AND' || key === 'OR' || key === 'NOT';
}

/** Short, data-free description of an operand for an error message. */
function describeOperand(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  return typeof value;
}

/** Filters that have no PowDB representation and must throw E017. */
function rejectUnsupportedFilter(value: Record<string, unknown>, field: string): void {
  if ('distance' in value || 'metric' in value) {
    throw new UnsupportedFeatureError('pgvector distance filters', 'PowDB', `field "${field}"`);
  }
  if ('path' in value || 'hasKey' in value) {
    throw new UnsupportedFeatureError('JSON path/key filters', 'PowDB', `field "${field}"`);
  }
  // Enumerated from the SHARED {@link ARRAY_OPERATOR_KEYS} rather than
  // re-listed here, because the hand-written copy had already drifted from it:
  // `has` was missing, so `{ tags: { has: 'x' } }` was not recognised as an
  // array filter at all, fell through to the bare-object equality branch, and
  // bound the whole `{ has: 'x' }` OBJECT as a scalar parameter. A silent wrong
  // answer where its three siblings raise E017. Two lists is how that happened;
  // reading the one the SQL side reads is what stops it happening again.
  for (const key of ARRAY_OPERATOR_KEYS) {
    if (key in value) {
      throw new UnsupportedFeatureError('array filters', 'PowDB', `field "${field}"`);
    }
  }
  if ('search' in value) {
    throw new UnsupportedFeatureError('full-text search filters', 'PowDB', `field "${field}"`);
  }
}

/** The relations type argument of an untyped accessor: none known. */
// biome-ignore lint/complexity/noBannedTypes: {} means "no relations known", matching QueryInterface's default
type NoRelations = {};

/**
 * The PowQL query interface. Constructed by `turbinePowDB` via the
 * `queryInterfaceFactory` seam. `implements TableClient` makes a method the SQL
 * accessor has and this class lacks, or one whose signature differs, a build
 * error. Where a method's result is narrowed by `select` / `omit` / `with`, a
 * public overload signature carries the SQL accessor's typing and the
 * implementation below it is typed on the plain row; both return the same
 * projected, relation-loaded rows at run time.
 */
export class PowqlInterface<T extends object = Record<string, unknown>> implements TableClient<T> {
  private readonly meta: TableMetadata;
  private readonly defaultLimit?: number;
  private readonly warnOnUnlimited: boolean;
  private readonly onQuery?: (event: QueryEvent) => void;
  /** Where this interface's log lines go: the client's logger, else the console. */
  private readonly logger: TurbineLogger;
  /** The logger for advice lines, or `undefined` when `diagnostics` turns advice off. */
  private readonly advice: TurbineLogger | undefined;

  constructor(
    private readonly pool: PowdbPool,
    private readonly table: string,
    private readonly schema: SchemaMetadata,
    private readonly middlewares: MiddlewareFn[] = [],
    private readonly options: QueryInterfaceOptions = {},
  ) {
    const meta = schema.tables[table];
    if (!meta) {
      throw new ValidationError(
        `Unknown table "${table}". ${availableClause(Object.keys(schema.tables), 'The schema has no tables.')}`,
      );
    }
    this.meta = meta;
    this.defaultLimit = options.defaultLimit;
    // Same per-table resolution as QueryInterface: an object map accepts BOTH
    // the snake_case table name and the camelCase accessor as keys (snake_case
    // wins on conflict); unlisted tables keep the default (warn on).
    const warnOpt = options.warnOnUnlimited;
    this.warnOnUnlimited =
      typeof warnOpt === 'object' && warnOpt !== null
        ? (warnOpt[table] ?? warnOpt[snakeToCamel(table)]) !== false
        : warnOpt !== false;
    this.onQuery = options._onQuery;
    // Resolved by the client once and passed in; an interface built directly
    // resolves here, at construction, as QueryInterface does.
    this.logger = options.logger ?? consoleLogger;
    this.advice = resolveDiagnostics(options.diagnostics).advice ? this.logger : undefined;
  }

  // -------------------------------------------------------------------------
  // Column / value helpers
  // -------------------------------------------------------------------------

  /**
   * Resolve a camelCase field name (or raw snake) to its column metadata.
   *
   * THE single key→column decision on this engine: every PowQL surface
   * reaches a column through here, which is why PowDB never grew the
   * per-argument asymmetry the SQL builders did. It resolves through the
   * shared {@link resolveColumnName} so both engines answer alike; the direct
   * name/field match stays as a fallback, since a PowDB schema may carry names
   * outside the snake_case↔camelCase round trip and narrowing that would be a
   * silent break rather than a fix.
   */
  private column(field: string) {
    const resolved = resolveColumnName(this.meta, field);
    const snake = resolved ?? ownLookup(this.meta.columnMap, field) ?? field;
    const col = this.meta.columns.find((c) => c.name === snake || c.field === field);
    if (!col) {
      throw new ValidationError(
        `Unknown column "${field}" on table "${this.table}". Known: ${this.meta.columns
          .map((c) => c.field)
          .join(', ')}`,
      );
    }
    return col;
  }

  /**
   * {@link lookupGroupKey} for the `${aggKey}:${field}` composite the aggregate
   * ordering registry is keyed by: only the FIELD half needs canonicalizing.
   */
  private aggOrderExpr(registry: Map<string, string>, aggKey: string, field: string): string | undefined {
    try {
      return registry.get(`${aggKey}:${this.column(field).field}`);
    } catch {
      return undefined; // not a column: the caller's own E003 is the right error
    }
  }

  /**
   * Read a caller-supplied groupBy result key out of a registry keyed by the
   * canonical FIELD name.
   *
   * `by`, `orderBy` and `having` are three arguments of one call, each free to
   * spell a column either way, so `by`'s choice must not decide what the others
   * may name. Try the key as written (which is what carries a JSON group-key
   * ALIAS, not a column), then its canonical field. Mirrors `lookupGroupKey` in
   * query/aggregates.ts.
   */
  private lookupGroupKey<V>(registry: Map<string, V>, key: string): V | undefined {
    const direct = registry.get(key);
    if (direct !== undefined) return direct;
    let field: string;
    try {
      field = this.column(key).field;
    } catch {
      return undefined; // not a column: the caller's own E003 below is the right error
    }
    return registry.get(field);
  }

  /**
   * PowQL column reference for a field: a dotted field reference
   * (`.snake_name`), or `alias.snake_name` when an `alias` is supplied (the F2
   * join path).
   */
  private ref(field: string, alias?: string): string {
    return this.colRefName(this.column(field).name, alias);
  }

  /**
   * Render a raw column name as a PowQL reference, qualified with `alias` when
   * given.
   *
   * BOTH branches quote now; they just use different rules, because the two
   * positions have different grammars. A QUALIFIED `p.col` does not bypass
   * keyword lookup, so it needs the full {@link quotePowqlIdent}. An
   * UNQUALIFIED `.col` does bypass it, so it uses {@link quotePowqlDotted},
   * which quotes only a name outside the bare-identifier grammar and leaves
   * keywords bare, preserving the ≤0.9 compatibility decision documented on
   * `quotePowqlIdent` while still keeping a column NAME from carrying syntax
   * into the statement. This branch used to interpolate the name RAW, the one
   * identifier site in the engine with no boundary at all.
   *
   * Output is byte-identical for every name the grammar accepts bare, keywords
   * included, so no existing schema sees a different statement.
   */
  private colRefName(name: string, alias?: string): string {
    return alias ? `${alias}.${quotePowqlIdent(name)}` : `.${quotePowqlDotted(name)}`;
  }

  /**
   * Push a value into the param array and return its `$N` placeholder. When the
   * value targets a `float` column it is wrapped in {@link PowdbFloatParam} so
   * the *embedded* literal encoder emits a float-form literal even for an
   * integer value (PowQL's `42` is an int literal, `42.0` a float). The
   * networked driver unwraps the marker back to the plain number in
   * {@link toPowdbParam}, so the wire param is unchanged.
   */
  private param(value: unknown, params: unknown[], col?: ColumnMetadata): string {
    let tagged: unknown = value;
    const labels = col ? this.enumLabels(col) : undefined;
    if (labels && value !== null && value !== undefined) {
      // An enum column takes one of its labels, in a write and in a filter
      // alike, as PostgreSQL does (22P02 there).
      this.assertEnumLabel(col!, labels, value);
    } else if (isJsonValue(value)) {
      // `jsonValue(v)`: serialized with JSON.stringify, as on the SQL engines.
      tagged = new PowdbJsonParam(value.value, col?.name);
    } else if (col && typeof value === 'string' && isDateColumn(col)) {
      // Date text against a Date column: the epoch micros the column stores,
      // as PostgreSQL reads the same text against a date / timestamp.
      tagged = isoTextMicros(value, col, this.table);
    } else if (
      col &&
      isDateColumn(col) &&
      (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean')
    ) {
      // The column holds epoch MICROseconds, so a number bound as-is names a
      // different instant (a millisecond count lands in 1970) and matches
      // nothing. PostgreSQL refuses a number against a date / timestamp too.
      throw new ValidationError(
        `Invalid value for the Date column "${col.name}" on "${this.table}": expected a Date or ISO 8601 text, ` +
          `got ${describeOperand(value)}. Pass \`new Date(ms)\` for a millisecond timestamp.`,
      );
    } else if (col && typeof value === 'string' && this.isIntegerCol(col)) {
      // Integer text against an integer column, as PostgreSQL reads it; an int8
      // value past 2^53 keeps every digit as a bigint.
      tagged = integerTextValue(value, col, this.table);
    } else if (col && typeof value === 'number' && this.isFloatCol(col)) {
      // Float column: force a float-form literal even for an integer value.
      tagged = new PowdbFloatParam(value);
    } else if (
      col &&
      value !== null &&
      typeof value === 'object' &&
      !(value instanceof Date) &&
      isJsonColumn(col, this.schema.enums)
    ) {
      // json document column: a JS object/array is serialized to canonical JSON
      // text and stored as a json document (a JS string passes through raw, same
      // contract as pg jsonb; `null` stays `null`).
      tagged = new PowdbJsonParam(value, col.name);
    }
    params.push(tagged);
    return `$${params.length}`;
  }

  /**
   * Render a value for a write *assignment* (`col := …`). Every value, float
   * columns included, is sent as a positional `$N` param. PowDB ≥ 0.7.0 fixed
   * the int→float UPDATE coercion bug (`score := $n` with an integer param now
   * reads back the integer value, not the raw i64 bits), so the float-literal
   * inlining workaround Turbine carried for ≤ 0.6.2 is gone. Marks the column as
   * float-typed for the *embedded* literal encoder (which materializes params
   * into PowQL text) so an integer-valued float still encodes as a float literal
   * and coercion stays unambiguous. Non-finite floats are still rejected.
   */
  private writeRef(value: unknown, col: ColumnMetadata, params: unknown[]): string {
    // A value position (create data, `{ set }`): the SQL engines' rule and message.
    if (isSqlExpr(value) || isColumnRef(value)) {
      throw new ValidationError(exprNotAllowedMessage(this.table, col.field, value));
    }
    if (typeof value === 'number' && !Number.isFinite(value) && this.isFloatCol(col)) {
      throw new ValidationError(`Non-finite value for float column "${col.name}" on "${this.table}".`);
    }
    return this.param(value, params, col);
  }

  /**
   * A PowQL `int` column declared as an integer type (not a Date, which is
   * stored as int micros, and not a column whose declared type is something
   * else).
   */
  private isIntegerCol(col: ColumnMetadata): boolean {
    if (isDateColumn(col)) return false;
    const declared = (col.dialectType ?? col.pgType ?? '').toLowerCase();
    if (declared !== '' && !/int|serial/.test(declared)) return false;
    try {
      return powqlColumnType(col, this.schema.enums) === 'int';
    } catch {
      return false;
    }
  }

  private isFloatCol(col: ColumnMetadata): boolean {
    try {
      return powqlColumnType(col, this.schema.enums) === 'float';
    } catch {
      return false;
    }
  }

  /**
   * The bound pool's {@link PowdbCapabilities}. Falls back to the trusted-caller
   * default (all feature gates on, `nativeRaw` off) when a directly-constructed
   * pool did not carry them, matching {@link PowdbPool}'s own constructor
   * default so a hand-built test pool never crashes the version gates.
   */
  private get capabilities(): PowdbCapabilities {
    return this.pool.capabilities ?? ALL_POWDB_CAPABILITIES;
  }

  /**
   * The `limit` a query actually emits: the explicit `limit`, then the
   * client-level `defaultLimit`. Prisma's `take` alias is already folded into
   * `limit` by `normalizeArgs`, so there is one spelling by the time this runs.
   * Shared by {@link buildFind} and the {@link findMany} zero short-circuit so
   * the two can never disagree about which limit is in force.
   */
  private effectiveLimit(args: FindManyArgs<T>): number | undefined {
    return args.limit ?? this.defaultLimit;
  }

  /**
   * Options for the child-side interfaces the relation loaders and the
   * relation-filter resolvers build: the client's, with `defaultLimit` cleared
   * and the unlimited warning off. `defaultLimit` bounds the caller's PAGE; on
   * an internal fetch that serves that page (a relation's children, a filter's
   * key set) it would cap the whole page's children, or the key set, at the
   * page size: a silent wrong answer by another route than the one
   * {@link pageOf} closes. The SQL batched loader clears it the same way
   * (`batchedChildOptions` in query/builder.ts).
   */
  private childOptions?: QueryInterfaceOptions;
  private loaderChildOptions(): QueryInterfaceOptions {
    this.childOptions ??= { ...this.options, defaultLimit: undefined, warnOnUnlimited: false };
    return this.childOptions;
  }

  /**
   * ONE parent's window of its stitched children: the relation's `offset` and
   * `limit` applied to that parent's own list.
   *
   * A relation `limit` means "at most N on EACH parent". The loaders used to
   * spread it onto the flat child fetch (`post filter .author_id in (...)
   * limit 5`), which caps the TOTAL across every parent in the chunk, so ten
   * parents shared five posts and most got none, with no error. It shipped
   * for the loaders' whole life because the one test of the shape compared
   * the join path against the loader path and both were wrong the same way;
   * the cross-engine benchmark found it, where the wrong answer was the fast
   * one. Every loader now fetches its children unbounded, WITH the relation
   * `orderBy` (which decides which rows the window keeps), and applies this
   * at stitch time: the rule the SQL engines' batched loader has always used.
   */
  private static pageOf<R>(rows: R[], limit: number | undefined, offset: number | undefined): R[] {
    if (limit === undefined && !offset) return rows;
    const start = offset ?? 0;
    return rows.slice(start, limit === undefined ? undefined : start + limit);
  }

  /**
   * Reject a negative `limit` / `offset` before it reaches the engine. PowDB
   * casts both with `as usize` at execution, so below engine 0.20 a negative
   * limit wrapped to `usize::MAX` and silently returned EVERY row, the opposite
   * of what the caller asked for; 0.20 refuses it. Validating client-side makes
   * the refusal identical on every engine version and names the argument.
   *
   * `limit: 0` is legal and means "no rows" (SQL `LIMIT 0`). It is not emitted:
   * callers short-circuit it, because PowDB's projection fast path returned ONE
   * row for `limit 0` below 0.20.
   */
  /**
   * Refuse the per-query `forceCustomPlan` read option.
   *
   * `FindManyArgs.forceCustomPlan` documents an `UnsupportedFeatureError` on any
   * engine with no PostgreSQL plan cache, and PowDB is one: it is not a
   * `Dialect` at all, so it never reaches the SQL builder's own refusal at
   * `preparedNameFor`. Without this the flag would be silently ignored here,
   * which is precisely the "reports a guarantee that was never made" failure the
   * option's refusal exists to prevent.
   */
  /**
   * `args` with every `with` relation key replaced by the relation's DECLARED
   * spelling, so PowDB accepts a snake_case relation name exactly as the SQL
   * engines do. Returns `args` by reference when nothing needed rewriting.
   *
   * PowqlInterface is a parallel implementation rather than a subclass, so
   * nothing makes this happen here automatically: a rule adopted only on the
   * SQL side becomes an engine that disagrees about which queries are valid,
   * which is the divergence class the projection resolver already cost.
   */
  private withDeclaredRelationNames<A extends { with?: unknown }>(args: A): A {
    if (!args?.with) return args;
    const normalized = normalizeWithClause(this.schema, this.table, args.with as WithClause);
    return normalized === args.with ? args : ({ ...args, with: normalized } as A);
  }

  /**
   * Fill in the deterministic per-relation ordering `stableRelationOrder` asks
   * for, through the shared transform the SQL engines use.
   *
   * PowDB accepted this option and did nothing with it before 0.74.0, so
   * relation rows came back in whatever order the engine produced, from the one
   * option whose entire purpose is that they do not. Same resolution as
   * QueryInterface: a per-query flag wins, else the client-level default.
   */
  /** `take` / `skip` inside every `with` level folded into `limit` / `offset` (shared rule). */
  private withRelationPagination<A extends { with?: unknown }>(args: A): A {
    if (!args?.with) return args;
    const normalized = normalizeWithPagination(this.schema, this.table, args.with as WithClause);
    return normalized === args.with ? args : ({ ...args, with: normalized } as A);
  }

  private withStableRelationOrder<A extends { with?: unknown; stableRelationOrder?: boolean }>(args: A): A {
    if (!args?.with) return args;
    const on = args.stableRelationOrder ?? this.options.stableRelationOrder === true;
    if (!on) return args;
    const ordered = applyStableRelationOrderTo(this.schema, args.with as WithClause, this.table);
    return ordered === args.with ? args : ({ ...args, with: ordered } as A);
  }

  /**
   * Caller args in canonical form: `undefined` pruned (query/normalize-args.ts),
   * declared relation spellings, stable relation order, and `take` / `skip`
   * folded into `limit` / `offset` at the top level and inside `with`. Same composition as
   * `QueryInterface.normalizeArgs`, run at the top of every public operation,
   * so the two engines agree about what each argument means.
   *
   * `refuseEmptiedWhere` names the single-row read (`findFirst`,
   * `findFirstOrThrow`) that refuses a `where` whose every key was `undefined`.
   */
  private normalizeArgs<A extends object>(args: A, refuseEmptiedWhere?: string): A {
    const pruned = pruneUndefinedArgs(this.schema, this.table, args);
    if (pruned !== args) {
      if (refuseEmptiedWhere) assertWhereNotEmptiedByPruning(this.table, refuseEmptiedWhere, args, pruned);
      assertCursorNotEmptied(this.table, args, pruned);
    }
    this.assertQueryOptions(pruned);
    const shaped = pruned as A & { with?: unknown; stableRelationOrder?: boolean };
    return normalizePagination(
      this.withStableRelationOrder(this.withRelationPagination(this.withDeclaredRelationNames(shaped))),
    );
  }

  /**
   * The per-query `timeout` and `relationLoadStrategy`, checked with the SQL
   * engines' rule and message: a timeout is a positive number of ms up to
   * {@link MAX_TIMEOUT_MS} (or 0 for none), a strategy one of the SQL engines' values.
   */
  private assertQueryOptions(args: object): void {
    const { timeout, relationLoadStrategy } = args as { timeout?: unknown; relationLoadStrategy?: unknown };
    if (
      timeout !== undefined &&
      !(typeof timeout === 'number' && Number.isFinite(timeout) && timeout >= 0 && timeout <= MAX_TIMEOUT_MS)
    ) {
      throw new ValidationError(
        `\`timeout\` on ${this.table} must be a positive number of milliseconds up to ${MAX_TIMEOUT_MS}, or 0 for ` +
          `no timeout (received ${describeOptionValue(timeout)}). Leave it out for no timeout.`,
      );
    }
    if (relationLoadStrategy !== undefined && !RELATION_LOAD_STRATEGIES.includes(relationLoadStrategy as string)) {
      throw new ValidationError(
        `\`relationLoadStrategy\` must be one of ${RELATION_LOAD_STRATEGIES.map((v) => `'${v}'`).join(', ')} ` +
          `(received ${describeOptionValue(relationLoadStrategy)}).`,
      );
    }
  }

  /**
   * Whether `cursor` carries a value, after the SQL engines' cursor checks: a
   * cursor that names no row (`null`, `{}`) is E003, and each value is a row's
   * value under the shared rule (`cursorFieldValue`). Unknown fields are E003.
   */
  private cursorCarriesValues(cursor: unknown): boolean {
    assertCursorWritten(this.table, 'findMany', cursor);
    if (!hasCursor(cursor)) return false;
    const flat = expandCompoundUniqueWhere(this.meta, cursor as Record<string, unknown>);
    for (const [key, written] of Object.entries(flat)) {
      if (written === undefined) continue;
      const col = this.column(key);
      cursorFieldValue(key, written, {
        column: col.name,
        table: this.table,
        kind: operandColumnKind(this.meta.pgTypes[col.name]),
        nullable: col.nullable && !this.meta.primaryKey.includes(col.name),
      });
    }
    return true;
  }

  /**
   * The SQL engines' cursor placement rule (query/builder.ts `planCursor`),
   * so a cursor they refuse is the same E003 here and only a cursor they would
   * serve reaches PowDB's E017. The page order is `orderBy` plus the
   * tiebreaker; the cursor must carry a value for every column of it, or name
   * one row by a unique key (the shared findUnique rule).
   */
  private assertCursorPlaceable(cursor: Record<string, unknown>, orderBy: unknown): void {
    const meta = this.meta;
    const field = (column: string): string => meta.reverseColumnMap[column] ?? column;
    const flat = expandCompoundUniqueWhere(meta, cursor);
    const valued = new Set<string>();
    for (const [key, value] of Object.entries(flat)) {
      if (value !== undefined) valued.add(this.column(key).name);
    }
    const terms: { column: string; desc: boolean }[] = [];
    for (const [key, dir] of orderByEntries(orderBy).filter(([, d]) => d !== undefined)) {
      if (isVectorOrderBy(dir) || isJsonPathOrderBy(dir) || (typeof dir !== 'string' && !isOrderBySpec(dir))) {
        throw new ValidationError(
          `findMany on "${this.table}" refused: \`cursor\` cannot page past the orderBy entry "${key}", which ` +
            'orders by a relation, a JSON path or a vector distance rather than a column. Order the cursor ' +
            'query by columns only, or page it with `offset`.',
        );
      }
      const column = this.column(key).name;
      if (terms.some((t) => t.column === column)) continue;
      terms.push({ column, desc: normalizeOrderBy(dir as Parameters<typeof normalizeOrderBy>[0]).dir === 'DESC' });
    }
    const nullable = (column: string): boolean =>
      !meta.primaryKey.includes(column) && meta.columns.find((c) => c.name === column)?.nullable === true;
    const keys = uniqueKeyNames(meta).filter((cols) => cols.every((c) => !nullable(c)));
    const ordered = new Set(terms.map((t) => t.column));
    const tiebreak = keys.some((cols) => cols.every((c) => ordered.has(c)))
      ? []
      : keys[0]?.filter((c) => !ordered.has(c));
    if (!tiebreak) {
      throw new ValidationError(
        `findMany on "${this.table}" refused: a \`cursor\` page needs an order with no ties, and "${this.table}" ` +
          'has no primary key or unique key on NOT NULL columns to break them. Add a primary key, or page ' +
          'this table with `offset`.',
      );
    }
    const desc = terms.length > 0 ? terms[terms.length - 1]!.desc : false;
    for (const column of tiebreak) terms.push({ column, desc });
    if (terms.every((t) => valued.has(t.column)) || whereIdentifiesOneRow(meta, flat)) return;
    const missing = terms.filter((t) => !valued.has(t.column)).map((t) => `"${field(t.column)}"`);
    const order = terms.map((t) => `${field(t.column)} ${t.desc ? 'desc' : 'asc'}`).join(', ');
    const named = uniqueKeyNames(meta).map((cols) =>
      cols.length === 1 ? `{ ${field(cols[0]!)} }` : `{ ${cols.map(field).join(', ')} }`,
    );
    throw new ValidationError(
      `findMany on "${this.table}" refused: the \`cursor\` has no value for ${missing.join(', ')}, which the ` +
        `page order (${order}) needs, and it does not name one row by a unique key. Give the cursor a value ` +
        `for every ordered field, or name the cursor row by ${named.length > 0 ? named.join(' or ') : 'a unique key'}.`,
    );
  }

  /**
   * A paginated `findMany` (`limit` / `offset`) whose `orderBy` can tie gets
   * a tiebreaker appended in the last term's direction (the primary key, else
   * the first unique key on NOT NULL columns), as on the SQL engines, so a page
   * boundary cannot fall between tied rows in a different order on each page.
   * Returns `args` itself when the order is already total or nothing pages.
   */
  private completePageOrder(args: FindManyArgs<T>): FindManyArgs<T> {
    if (args.orderBy === undefined || (args.limit === undefined && args.offset === undefined)) return args;
    if (args.distinct && args.distinct.length > 0) return args;
    const meta = this.meta;
    const entries = orderByEntries(args.orderBy).filter(([, d]) => d !== undefined);
    const ordered = new Set<string>();
    let lastDesc = false;
    for (const [key, dir] of entries) {
      lastDesc = false;
      // A JSON-path, vector or relation ordering is not a column of this table.
      if (typeof dir !== 'string' && !isOrderBySpec(dir)) continue;
      const column = resolveColumnName(meta, key);
      if (column === undefined) continue;
      ordered.add(column);
      lastDesc = normalizeOrderBy(dir as Parameters<typeof normalizeOrderBy>[0]).dir === 'DESC';
    }
    const nullable = (column: string): boolean =>
      !meta.primaryKey.includes(column) && meta.columns.find((c) => c.name === column)?.nullable === true;
    const keys = uniqueKeyNames(meta).filter((cols) => cols.every((c) => !nullable(c)));
    if (keys.length === 0 || keys.some((cols) => cols.every((c) => ordered.has(c)))) return args;
    const missing = keys[0]!.filter((c) => !ordered.has(c));
    const dir = lastDesc ? 'desc' : 'asc';
    return {
      ...args,
      orderBy: [
        ...entries.map(([k, v]) => ({ [k]: v })),
        ...missing.map((c) => ({ [meta.reverseColumnMap[c] ?? c]: dir })),
      ],
    } as FindManyArgs<T>;
  }

  /**
   * `jsonEncoding` selects between PostgreSQL's `json_build_object` and
   * `json_build_array` row encodings for relation subqueries. PowQL emits no
   * JSON row encoding at all, so there is nothing for the option to select and
   * it was simply dropped: the caller asked for a wire format and got silence.
   * Refused for the same reason `forceCustomPlan` is.
   */
  private assertNoJsonEncoding(args: { jsonEncoding?: string } | undefined): void {
    if (args?.jsonEncoding === undefined) return;
    throw new UnsupportedFeatureError(
      'jsonEncoding',
      'PowDB',
      'PowQL emits no JSON row encoding for relations, so there is nothing to select; omit the option',
    );
  }

  /** `optimisticLock` is an `update` option; the shared refusal and message from query/writes.ts. */
  private assertNoOptimisticLock(args: object, operation: 'upsert' | 'updateMany' | 'delete' | 'deleteMany'): void {
    // The shared check reads only the table name from its builder context.
    assertNoOptimisticLock({ table: this.table } as Parameters<typeof assertNoOptimisticLock>[0], args, operation);
  }

  private assertNoForceCustomPlan(args: { forceCustomPlan?: boolean } | undefined): void {
    if (args?.forceCustomPlan !== true) return;
    throw new UnsupportedFeatureError(
      'The forceCustomPlan query option',
      'powdb',
      'Forcing a per-query custom plan means keeping the statement out of the PostgreSQL plan cache, and PowDB ' +
        'has no such cache to keep it out of. Remove the option, or set it only on PostgreSQL queries.',
    );
  }

  /** `lock` (a row-locking read): PowDB has no row locks. */
  private assertNoRowLock(args: { lock?: unknown } | undefined): void {
    if (args?.lock === undefined) return;
    throw new UnsupportedFeatureError(
      'The lock read option',
      'powdb',
      'PowDB has no row locks: a transaction holds the single writer gate. Remove `lock`; inside ' +
        '$transaction on PowDB, writes are already serialized.',
    );
  }

  /** `_percentile`: PowQL has no percentile aggregate. */
  private assertNoPercentile(args: { _percentile?: unknown }): void {
    const spec = args._percentile;
    // An empty block asks for nothing, as on the SQL engines.
    if (spec === undefined) return;
    if (typeof spec === 'object' && spec !== null && !Object.values(spec).some((v) => v != null)) return;
    throw new UnsupportedFeatureError(
      '_percentile',
      'powdb',
      'Percentile aggregates need PostgreSQL; PowQL has count, sum, avg, min and max only.',
    );
  }

  /** See query/compound-unique.ts: one rule and one message across engines. */
  private assertIdentifiesOneRow(where: Record<string, unknown> | undefined): void {
    assertWhereIdentifiesOneRow(this.meta, this.table, where);
  }

  /**
   * The single-row WRITE rule (`update` / `delete` return one row, so their
   * `where` must identify one; `upsert`'s `where` names the row it conflicts
   * on), shared with the SQL engines through query/compound-unique.ts so the
   * two cannot disagree about which writes are valid. Skipped under the
   * explicit full-table opt-in, which already means "every row". For `update` /
   * `delete` it runs AFTER `assertCompiledWhere`, so an empty selector keeps
   * the empty-where message and this only refuses a non-empty one that names no
   * key; `upsert` takes no `allowFullTableScan` and has no empty-where guard to
   * run first, so this is its only where check and it covers `{}` as well.
   */
  private assertMutationIdentifiesOneRow(
    where: WhereClause<T> | undefined,
    allowFullTableScan: boolean | undefined,
    operation: 'update' | 'delete' | 'upsert',
  ): void {
    if (allowFullTableScan) return;
    assertMutationWhereIdentifiesOneRow(this.meta, this.table, where as Record<string, unknown> | undefined, operation);
  }

  /** A caller `where` with a Prisma compound-unique selector expanded to its member columns. */
  private expandedWhere(where: WhereClause<T> | undefined): WhereClause<T> | undefined {
    if (!where) return where;
    return expandCompoundUniqueWhere(this.meta, where as Record<string, unknown>) as WhereClause<T>;
  }

  private assertPagination(limit: number | undefined, offset: number | undefined, context: string): void {
    for (const [name, value] of [
      ['limit', limit],
      ['offset', offset],
    ] as const) {
      if (value !== undefined && value !== null && value < 0) {
        throw new ValidationError(`${context} on "${this.table}": \`${name}\` must not be negative (got ${value}).`);
      }
    }
  }

  /** A predicate that is always false, the empty-`in` / contradiction sentinel. */
  private alwaysFalse(): string {
    const pk = this.meta.primaryKey[0] ?? this.meta.columns[0]?.name;
    const ref = pk === undefined ? '.__turbine_missing_pk' : this.colRefName(pk);
    return `(${ref} is null and ${ref} is not null)`;
  }

  // -------------------------------------------------------------------------
  // WHERE builder
  // -------------------------------------------------------------------------

  /**
   * Compile a {@link WhereClause} into a PowQL filter expression, pushing every
   * value as a positional `$N` param. Returns `''` when there are no conditions.
   *
   * When `alias` is supplied (the F2 native-join path) every field reference is
   * qualified with it (`.col` → `alias.col`, JSON path bases too); params bind
   * exactly as in the unqualified path. The caller only ever passes an alias for
   * an already-RESOLVED where (relation filters pre-resolved to literal in-lists
   * by {@link resolveRelationFilters}): the relation-key branch below still
   * throws, so an unresolved relation filter can never leak into a join.
   *
   * `NOT` here is PowQL's two-valued complement. A caller's where reaches this
   * only through {@link sqlTrueWhere} (inside {@link resolveRelationFilters},
   * and in {@link applyGlobalFilter}), which leaves `NOT` only where the two
   * readings agree.
   */
  private buildWhere(where: WhereClause<T> | undefined, params: unknown[], alias?: string): string {
    if (!where) return '';
    const parts: string[] = [];
    for (const [key, value] of Object.entries(where)) {
      if (value === undefined) continue;
      if (key === 'AND' || key === 'OR' || key === 'NOT') {
        const branches = combinatorBranches(key, value, this.table);
        if (branches === null) continue;
        if (key === 'OR' && branches.length === 0) {
          parts.push(this.alwaysFalse());
          continue;
        }
        const built = branches.map((w) => this.buildWhere(w as WhereClause<T>, params, alias));
        // A branch with no condition is TRUE, so the whole `OR` is: a constant
        // condition rather than none, so a `NOT` around it matches no row.
        if (key === 'OR' && built.some((c) => !c)) {
          parts.push(ALWAYS_TRUE);
          continue;
        }
        const sub = built.filter(Boolean);
        if (!sub.length) continue;
        if (key === 'OR') parts.push(`(${sub.join(' or ')})`);
        else if (key === 'AND') parts.push(`(${sub.join(' and ')})`);
        else parts.push(...sub.map((c) => `not (${c})`));
      } else if (Object.hasOwn(this.meta.relations, key)) {
        // Relation filters are pre-resolved to scalar in/notIn by
        // resolveRelationFilters() before buildWhere runs, reaching here means
        // a caller skipped that step (an internal bug, not user error).
        throw new InvariantError(
          'powql-relation-filter-unresolved',
          `relation filter "${key}" reached buildWhere unresolved: resolveRelationFilters() must run first.`,
        );
      } else {
        // A JsonFilter (or a bare `{ path }`) can compile to zero clauses; skip
        // empty results so buildWhere never emits a dangling ` and `.
        const cond = this.buildFieldCondition(key, value, params, alias);
        if (cond) parts.push(cond);
      }
    }
    return parts.join(' and ');
  }

  /**
   * Gate a predicate on a PowDB-native `datetime` column. Turbine binds a JS
   * `Date` as an integer count of microseconds, and PowDB writes a timestamp
   * literal as a plain integer, so every such predicate is a `DateTime` vs `Int`
   * comparison. Below engine 0.20 that pairing was unhandled and fell back to
   * comparing TYPE TAGS, so `>` matched every non-null row, `=` and `<` matched
   * none, and the answer additionally changed with the column's access path
   * (indexed vs scanned). 0.20 compares microseconds and every binary operator
   * (`=`, `!=`, `<`, `<=`, `>`, `>=`) is correct.
   *
   * ONE gate covers the whole family, whatever spelling the caller used. `in` /
   * `not in` are included because their still-broken LIST form is never emitted:
   * {@link buildInList} expands a datetime list into the equality chain the
   * engine does answer correctly, which is the same binary comparison this flag
   * governs. So on >= 0.20 every path is served (direct predicates, relation
   * filters, the batched loaders, nested projections, native joins, and the
   * findUnique / update / delete / upsert by-key paths), and below 0.20 every
   * path that compares against a literal is refused with one message, which
   * names the read paths that do not.
   *
   * `is null` / `is not null` are never gated: they compare no literal and are
   * correct on every version. Ordering, grouping and `min`/`max` are likewise
   * unaffected (they compare datetimes against each other, never against an int),
   * as are nested-projection and join correlations, which are column-to-column.
   *
   * Only PowDB's native `datetime` type is affected. Turbine's own DDL emits
   * `int` epoch micros for a `Date` column, so a Turbine-provisioned database
   * never reaches this: the exposed shape is a table created outside Turbine and
   * read through `introspectPowdbDatabase`, or hand-written metadata.
   */
  private assertDatetimePredicateSupported(col: ColumnMetadata): void {
    if (!isPowdbDatetimeColumn(col)) return;
    requireCapability(
      this.capabilities,
      'datetimeCompare',
      `comparisons on the PowDB datetime column "${col.name}"`,
      'Reading that column is unaffected, and so are ordering, grouping and `is null` checks; only comparing it ' +
        'against a bound timestamp needs the fix. A nested `with` (the default nested-projection / join paths) ' +
        'correlates column to column, so it loads the relation without any such comparison.',
    );
  }

  /**
   * Refuse a value comparison on a `numeric` / `decimal` column. PowDB stores
   * those as `str` (it has no decimal type, and `float` would lose digits), so
   * every comparison, ordering and aggregate the engine could run on them is a
   * TEXT comparison: `'7.50' > '7.5'`, `'10' < '9'`, and `'7.5' = '7.50'` is
   * false; arithmetic on a `str` yields NULL. Null checks, reads and plain
   * writes are unaffected.
   */
  private assertDecimalComparable(col: ColumnMetadata, what: string): void {
    if (!isPowdbDecimalTextColumn(col, this.schema.enums)) return;
    throw new UnsupportedFeatureError(
      `${what} on the numeric column "${col.name}" of "${this.table}"`,
      'PowDB',
      'PowDB stores numeric/decimal values as text, so the engine would compare, order and aggregate them as ' +
        "strings ('10' < '9', '7.5' != '7.50') and arithmetic on them yields NULL. Reading, writing and `null` " +
        'checks work. To compare, aggregate or do arithmetic, store the value as an integer of minor units ' +
        '(cents) or as a float, or do it in application code.',
    );
  }

  /** The labels of `col`'s enum type, or `undefined` when it is not an enum column. */
  private enumLabels(col: ColumnMetadata): readonly string[] | undefined {
    return powdbEnumLabels(col, this.schema.enums);
  }

  /**
   * E003 unless `value` is one of the enum column's labels. PostgreSQL refuses
   * any other value (22P02, which Turbine reports as E003) whether it is
   * written or compared, and the label set is exact: case and spelling count.
   * The value itself is not echoed, only its kind.
   */
  private assertEnumLabel(col: ColumnMetadata, labels: readonly string[], value: unknown): void {
    if (typeof value === 'string' && labels.includes(value)) return;
    const shown = labels.slice(0, 10).map((l) => JSON.stringify(l));
    if (labels.length > shown.length) shown.push(`and ${labels.length - shown.length} more`);
    throw new ValidationError(
      `Invalid value for the enum column "${col.name}" on "${this.table}": expected one of its labels ` +
        `(${shown.join(', ')}), got ${typeof value === 'string' ? 'a string that is not one of them' : describeOperand(value)}.`,
    );
  }

  /**
   * Refuse an ORDERING of an enum column (orderBy, `_min` / `_max`). PostgreSQL
   * orders an enum by the position of its labels in the type's declaration;
   * PowDB stores the label text and would order it alphabetically, a different
   * answer with no error. Range filters (`gt` / `gte` / `lt` / `lte`) do not come
   * here: they compile to the exact set of labels on that side of the operand.
   */
  private assertEnumOrderable(col: ColumnMetadata, what: string): void {
    if (!this.enumLabels(col)) return;
    throw new UnsupportedFeatureError(
      `${what} on the enum column "${col.name}" of "${this.table}"`,
      'PowDB',
      'PostgreSQL orders an enum by the order its labels are declared in, and PowDB stores the label text, so ' +
        'it would order the labels alphabetically. Equality, `in` / `notIn`, `gt` / `gte` / `lt` / `lte` and ' +
        'groupBy keys work. Order by the label position in application code.',
    );
  }

  /**
   * An aggregate over an enum column: `_min` / `_max` order it (see
   * {@link assertEnumOrderable}); `_sum` / `_avg` have no meaning on a label,
   * which PostgreSQL refuses as E003 (42883, no such function).
   */
  private assertEnumAggregate(col: ColumnMetadata, fn: string): void {
    if (!this.enumLabels(col)) return;
    if (fn === '_min' || fn === '_max') {
      this.assertEnumOrderable(col, `\`${fn}\``);
      return;
    }
    throw new ValidationError(
      `\`${fn}\` on the enum column "${col.name}" of "${this.table}": an enum label is not a number. ` +
        'Use `_count`, or `_min` / `_max` on another engine.',
    );
  }

  /** The E003 for an operand that is not a comparable value for its column. */
  private operandError(field: string, opName: string, value: unknown, expected: string): ValidationError {
    const position = opName === '=' ? `"${field}"` : `\`${opName}\` on "${field}"`;
    return new ValidationError(
      `Invalid operand for ${position} on "${this.table}": expected ${expected}, got ${describeOperand(value)}. ` +
        'A column is compared against a string, number, bigint, boolean or Date; pass an operator object ' +
        '(`{ gt: 5 }`, `{ in: [1, 2] }`) to choose the comparison.',
    );
  }

  /** Build a single `field: value | operator` condition. */
  private buildFieldCondition(field: string, value: unknown, params: unknown[], alias?: string): string {
    const colMeta = this.column(field);
    const ref = this.ref(field, alias);
    if (value === null) return `${ref} is null`;
    if (isColumnReference(value)) {
      throw new UnsupportedFeatureError(
        'Column references in a filter',
        'PowDB',
        `field "${field}": PowQL has no column-to-column operand in a filter. Compare in application code.`,
      );
    }
    if (isScalarOperand(value)) {
      this.assertDecimalComparable(colMeta, 'Equality');
      this.assertDatetimePredicateSupported(colMeta);
      return `${ref} = ${this.filterOperand(value, params, colMeta)}`;
    }
    const op = value as Record<string, unknown>;
    // JSON path / key filters on a json document column compile to PowQL `->`
    // path filters (≥ 0.12). `isJsonFilter` matches `path`/`equals`/`contains`/
    // `hasKey`; on a NON-json column those fall through to the scalar operator
    // path below (e.g. `equals` stays a plain equality), exactly like SQL.
    if (isJsonColumn(colMeta, this.schema.enums) && isJsonFilter(value)) {
      requireCapability(this.capabilities, 'jsonDocs', 'JSON path filters');
      return this.buildJsonPathCondition(colMeta, value, params, alias);
    }
    if (!Array.isArray(op)) rejectUnsupportedFilter(op, field);
    if (Array.isArray(op) || !Object.keys(op).some((k) => OPERATOR_KEYS.has(k))) {
      // A json document column compares a whole document by value. Any other
      // column has no object or array value, so binding one as data compared
      // against nothing meaningful; it is refused, as on the SQL engines.
      if (!isJsonColumn(colMeta, this.schema.enums))
        throw this.operandError(field, '=', value, 'a scalar or an operator object');
      throw jsonDocumentEqualityUnsupported(colMeta);
    }
    // The SQL engines' operand rules and messages, so the engines agree on
    // which operator objects are valid; one naming no comparison
    // (`{ mode: 'insensitive' }`) is refused instead of compiling to nothing.
    // JSON columns included, as on the SQL engines: skipping them let a
    // mode-only filter fall through to the constant-false fallback below, which
    // `NOT` turned into every non-null row (a deleteMany wrote all of them).
    // The same call refuses a JSON `not` object made only of filter operators.
    assertOperatorOperands(op, {
      column: colMeta.name,
      table: this.table,
      kind: operandColumnKind(this.meta.pgTypes[colMeta.name]),
    });
    const insensitive = op.mode === 'insensitive';
    const lhs = insensitive ? `lower(${ref})` : ref;
    const labels = this.enumLabels(colMeta);
    const conds: string[] = [];
    for (const [opName, opVal] of Object.entries(op)) {
      if (opVal === undefined || opName === 'mode') continue;
      if (labels) {
        const range = this.enumRangeCondition(colMeta, labels, ref, opName, opVal, insensitive, params);
        if (range !== undefined) {
          conds.push(range);
          continue;
        }
      }
      if (opName === 'not' && opVal !== null && !isScalarOperand(opVal) && !isColumnReference(opVal)) {
        // `not` takes an operator object, as on the SQL engines: the rows where
        // the inner condition is FALSE (a NULL column is neither, so it is
        // excluded, which PowQL's two-valued `not` alone would not do).
        if (Array.isArray(opVal) || Object.keys(opVal as object).length === 0) {
          throw this.operandError(field, 'not', opVal, 'a scalar, null, or a non-empty operator object');
        }
        const inner = { ...(op.mode !== undefined ? { mode: op.mode } : {}), ...(opVal as object) };
        const negated = this.buildWhere(this.sqlFalseWhere({ [field]: inner } as WhereClause<T>), params, alias);
        conds.push(negated || this.alwaysFalse());
        continue;
      }
      if (opName === 'in' || opName === 'notIn') {
        if (!Array.isArray(opVal) || opVal.some((v) => v !== null && !isScalarOperand(v))) {
          throw this.operandError(field, opName, opVal, 'an array of scalars');
        }
      } else if (opVal !== null && !isScalarOperand(opVal)) {
        throw this.operandError(field, opName, opVal, 'a scalar');
      }
      // Every operator below compares the column against a bound literal, which
      // is the shape a PowDB `datetime` column can only answer from engine 0.20
      // (see assertDatetimePredicateSupported; `in`/`notIn` reach the engine as
      // an equality chain, so they are the same comparison). The two exceptions
      // compare nothing and stay allowed on every version: a null operand
      // (`equals`/`not: null` → `is [not] null`) and an empty `in`/`notIn` list
      // (a compile-time constant, never sent).
      const comparesNothing =
        (opVal === null && (opName === 'equals' || opName === 'not')) ||
        ((opName === 'in' || opName === 'notIn') && Array.isArray(opVal) && opVal.length === 0);
      if (!comparesNothing) {
        this.assertDecimalComparable(colMeta, `\`${opName}\``);
        this.assertDatetimePredicateSupported(colMeta);
      }
      switch (opName) {
        case 'equals':
          conds.push(opVal === null ? `${ref} is null` : `${lhs} = ${this.bind(opVal, params, insensitive, colMeta)}`);
          break;
        case 'not':
          // Spell as `lhs != $N` (not `not (lhs = $N)`) so a missing-value row is
          // EXCLUDED, matching SQL null semantics on PowDB >= 0.18.2. Behavior-neutral
          // on older engines (pre-0.18.2 `!=` MATCHED missing rows exactly like the
          // old `not (...)` spelling), so no capability gate is needed.
          conds.push(
            opVal === null ? `${ref} is not null` : `${lhs} != ${this.bind(opVal, params, insensitive, colMeta)}`,
          );
          break;
        case 'gt':
          conds.push(`${lhs} > ${this.bind(opVal, params, insensitive, colMeta)}`);
          break;
        case 'gte':
          conds.push(`${lhs} >= ${this.bind(opVal, params, insensitive, colMeta)}`);
          break;
        case 'lt':
          conds.push(`${lhs} < ${this.bind(opVal, params, insensitive, colMeta)}`);
          break;
        case 'lte':
          conds.push(`${lhs} <= ${this.bind(opVal, params, insensitive, colMeta)}`);
          break;
        case 'in':
          conds.push(this.buildInList(lhs, opVal as unknown[], params, insensitive, false, colMeta));
          break;
        case 'notIn':
          conds.push(this.buildInList(lhs, opVal as unknown[], params, insensitive, true, colMeta));
          break;
        case 'contains':
        case 'startsWith':
        case 'endsWith':
          conds.push(this.buildStringMatch(opName, ref, String(opVal), params, insensitive, `"${field}"`));
          break;
        default:
          throw new ValidationError(`Unsupported operator "${opName}" on PowDB.`);
      }
    }
    // assertOperatorOperands refuses an operator object that names no
    // comparison, and every comparison above pushes a condition or throws, so
    // an empty list is a generator bug. It must not become a constant: under
    // `NOT` a constant false is every row, and a mutation would write them.
    if (!conds.length) {
      throw new InvariantError('powql-filter-empty', `the filter on "${field}" compiled to no condition.`);
    }
    return conds.length > 1 ? `(${conds.join(' and ')})` : conds[0]!;
  }

  /**
   * PowQL JSON path expression `.col->$a->$b…`, binding EVERY path segment as a
   * positional param (a string segment as a `str` token, an integer index as an
   * `int` token). `->` binds tighter than every operator, so no parens are
   * needed around the path in a comparison. Segments are bound (never inlined)
   * to keep {@link materializePowql}'s `$N`-scan invariant intact: a segment
   * that literally contained `$1` would otherwise be rewritten. Shared by the
   * F1 where-filter path and the F2 orderBy / groupBy path emitters.
   *
   * A digit-only STRING segment (`'0'`) binds as an `int` array index, matching
   * the SQL engines: `JsonFilter.path` is typed `string[]`, so an array index
   * can only be expressed as a digit string, and the SQL builder converts it the
   * same way (`/^\d+$/ → [n]`, query/builder.ts). Without this, PowDB's typed
   * `->` treats `'0'` as a string KEY and silently matches nothing on an array
   * (a wrong result, not an error). Same object-key-`'0'` caveat SQL accepts: a
   * json object whose key is literally `"0"` is addressed as an array index.
   */
  private jsonPathExpr(col: ColumnMetadata, path: (string | number)[], params: unknown[], alias?: string): string {
    let expr = this.colRefName(col.name, alias);
    for (const seg of path) {
      const bound = typeof seg === 'string' && /^\d+$/.test(seg) ? Number(seg) : seg;
      expr += `->${this.param(bound, params)}`;
    }
    return expr;
  }

  /**
   * Compile a {@link JsonFilter} on a json document column into a PowQL filter
   * (≥ 0.12). Operators PowQL cannot express EXACTLY throw a per-operator E017
   * (never a wrong result): containment (`contains`, and `equals` without a
   * `path`) has no PowQL operator. The mapped shapes:
   *   - `{ path, equals: v }`  → `P = $n` (typed: string→str, bool→bool,
   *      integral number→int, fractional→float; NOT stringified)
   *   - `{ path, equals: null }` → `P is null` (matches JSON null AND a missing
   *      key, a deliberate divergence from the PG driver, documented on
   *      {@link JsonFilter})
   *   - `{ path, gt|gte|lt|lte: v }` → `P > $n` … (range ops require `path`; the
   *      engine coerces int/float numerically)
   *   - `{ hasKey: k }` → `json_type(.col->$n) is not null` (top-level key test,
   *      ignoring `path`, mirroring PG `col ? key`; includes keys holding JSON
   *      null)
   * A bare `{ path }` with no operators compiles to zero clauses (byte-parity
   * with SQL), so a mutation whose only `where` is a bare `{ path }` is refused
   * by the empty-where guard.
   */
  private buildJsonPathCondition(col: ColumnMetadata, filter: JsonFilter, params: unknown[], alias?: string): string {
    // Same strict-key check as the SQL path. Without it an unrecognized
    // operator compiled to zero conditions and the predicate silently
    // disappeared, returning every row (see assertJsonFilterKeys).
    assertJsonFilterKeys(filter, col.name);
    const conds: string[] = [];
    // Bind the path segments at most once and reuse the expression string across
    // equals + range comparisons (they share the same `path`).
    let pathExpr: string | null = null;
    const pathP = (): string => {
      pathExpr ??= this.jsonPathExpr(col, filter.path!, params, alias);
      return pathExpr;
    };

    if (filter.contains !== undefined) {
      throw new UnsupportedFeatureError(
        'JSON containment filters (contains)',
        'PowDB',
        `column "${col.name}": PowQL has no JSON containment operator`,
      );
    }
    if (filter.equals !== undefined) {
      if (filter.path === undefined || filter.path.length === 0) throw jsonDocumentEqualityUnsupported(col);
      conds.push(filter.equals === null ? `${pathP()} is null` : `${pathP()} = ${this.param(filter.equals, params)}`);
    }
    if (filter.hasKey !== undefined) {
      // Top-level key existence, independent of `path` (mirrors PG `col ? key`).
      conds.push(`json_type(${this.colRefName(col.name, alias)}->${this.param(filter.hasKey, params)}) is not null`);
    }
    // Range comparisons on the extracted path, in the fixed gt/gte/lt/lte order.
    // Same validation as SQL `jsonRangeEntries`: `path` required, value a finite
    // number or a string.
    for (const [op, powOp] of [
      ['gt', '>'],
      ['gte', '>='],
      ['lt', '<'],
      ['lte', '<='],
    ] as const) {
      const v = (filter as Record<string, unknown>)[op];
      if (v === undefined) continue;
      if (filter.path === undefined) {
        throw new ValidationError(
          `JSON range operator '${op}' on ${col.name} requires a \`path\` ` +
            `(e.g. { path: ['meta', 'score'], ${op}: ${JSON.stringify(v)} }).`,
        );
      }
      if (typeof v !== 'number' && typeof v !== 'string') {
        throw new ValidationError(
          `JSON range operator '${op}' on ${col.name} requires a number or string, got ${JSON.stringify(v)}.`,
        );
      }
      if (typeof v === 'number' && !Number.isFinite(v)) {
        throw new ValidationError(`JSON range operator '${op}' on ${col.name} requires a finite number.`);
      }
      conds.push(`${pathP()} ${powOp} ${this.param(v, params)}`);
    }

    // Substring comparisons against the text at `path`, in the same fixed
    // order as the SQL path, through the same literal matcher as a column.
    const stringOps: Record<string, 'contains' | 'startsWith' | 'endsWith'> = {
      stringContains: 'contains',
      stringStartsWith: 'startsWith',
      stringEndsWith: 'endsWith',
    };
    for (const { op, value } of jsonStringEntries(filter, col.name)) {
      const insensitive = filter.mode === 'insensitive';
      const kind = stringOps[op];
      if (!kind)
        throw new InvariantError('powql-json-operator', `unknown JSON string operator "${op}" on "${col.name}".`);
      conds.push(this.buildStringMatch(kind, pathP(), value, params, insensitive, `the JSON path on "${col.name}"`));
    }

    // Every reachable shape now emits a condition or throws: assertJsonFilterKeys
    // rejects a filter that compares nothing, so an empty list here would be a
    // generator bug rather than a user error, and must not silently widen the
    // query the way it used to.
    if (!conds.length) {
      throw new InvariantError('powql-json-filter-empty', `JSON filter on "${col.name}" compiled to no condition.`);
    }
    return conds.length > 1 ? `(${conds.join(' and ')})` : conds[0]!;
  }

  /** Bind a value, lowercasing for case-insensitive comparisons. */
  private bind(value: unknown, params: unknown[], insensitive: boolean, col?: ColumnMetadata): string {
    const ph = this.filterOperand(value, params, col);
    return insensitive ? `lower(${ph})` : ph;
  }

  /**
   * A bound filter operand. An integral number compared with a float column is
   * cast to float in the statement: the typed wire carries an integral number as
   * an int, and the engine compares int with float by type tag inside `not`,
   * `or` and `in` (on 0.20 `not (.rating = 4)` matches the 4.0 row and
   * `.rating in (4, 5)` matches nothing).
   */
  private filterOperand(value: unknown, params: unknown[], col?: ColumnMetadata): string {
    const ph = this.param(value, params, col);
    return col && typeof value === 'number' && Number.isInteger(value) && this.isFloatCol(col) ? `(${ph} + 0.0)` : ph;
  }

  /**
   * `contains` / `startsWith` / `endsWith` against `expr` (a column or a JSON
   * path), matching `value` literally.
   *
   * PowQL's `like` has NO escape character: `%` and `_` in the pattern are
   * always wildcards and `\` is an ordinary character. So a prefix or suffix
   * test never goes through `like`: it compares the leading or trailing
   * `length($v)` characters with `substring`, which is exact for every value
   * on every engine version (and sidesteps the pre-0.27 matcher, which missed
   * text containing a literal `%`). `contains` has no such form, since PowQL
   * has no position function, so a value carrying `%` or `_` is refused rather
   * than sent as a pattern that means something else.
   */
  private buildStringMatch(
    op: 'contains' | 'startsWith' | 'endsWith',
    expr: string,
    value: string,
    params: unknown[],
    insensitive: boolean,
    target: string,
  ): string {
    const fold = (e: string): string => (insensitive ? `lower(${e})` : e);
    if (op === 'contains') {
      if (/[%_]/.test(value)) {
        throw new UnsupportedFeatureError(
          '`contains` with a value containing `%` or `_`',
          'PowDB',
          `${target} on "${this.table}": PowQL's \`like\` has no escape character, so those characters would act ` +
            'as wildcards and match other rows. `startsWith` and `endsWith` match such values exactly; for a ' +
            'substring, filter in application code.',
        );
      }
      return `${fold(expr)} like ${fold(this.param(`%${value}%`, params))}`;
    }
    const ph = this.param(value, params);
    const start = op === 'startsWith' ? '1' : `length(${expr}) - length(${ph}) + 1`;
    return `(length(${expr}) >= length(${ph}) and ${fold(`substring(${expr}, ${start}, length(${ph}))`)} = ${fold(ph)})`;
  }

  /**
   * `lhs [not] in ($1, $2, …)`, empty list collapses to a constant.
   *
   * A PowDB-native `datetime` column takes the expanded form instead (see
   * {@link buildDatetimeInList}): its `in` list is still broken upstream at 0.20.
   */
  /**
   * The enum-specific shapes of one operator on an enum column, or `undefined`
   * for an operator compiled the ordinary way (equality, `in` / `notIn`, `not`,
   * whose labels {@link param} checks).
   *
   * `gt` / `gte` / `lt` / `lte` compile to `in` over the labels on that side of
   * the operand in DECLARATION order, which is what PostgreSQL compares; the
   * text comparison PowDB would run is alphabetical, a different answer. A null
   * operand is refused before this (assertOperatorOperands, as on the SQL
   * engines) and again by {@link assertEnumLabel}: compiled to a constant false,
   * `NOT` would turn it into every row. Case-insensitive matching and
   * `contains` / `startsWith` / `endsWith` are E003: PostgreSQL has no `lower`
   * or `LIKE` on an enum (42883).
   */
  private enumRangeCondition(
    col: ColumnMetadata,
    labels: readonly string[],
    ref: string,
    opName: string,
    opVal: unknown,
    insensitive: boolean,
    params: unknown[],
  ): string | undefined {
    if (insensitive || opName === 'contains' || opName === 'startsWith' || opName === 'endsWith') {
      throw new ValidationError(
        `${insensitive ? "`mode: 'insensitive'`" : `\`${opName}\``} on the enum column "${col.name}" of ` +
          `"${this.table}": an enum compares whole labels exactly. Use \`equals\`, \`in\` or \`notIn\` with its labels.`,
      );
    }
    if (opName !== 'gt' && opName !== 'gte' && opName !== 'lt' && opName !== 'lte') return undefined;
    this.assertEnumLabel(col, labels, opVal);
    const at = labels.indexOf(opVal as string);
    const side = labels.filter((_, i) =>
      opName === 'gt' ? i > at : opName === 'gte' ? i >= at : opName === 'lt' ? i < at : i <= at,
    );
    return this.buildInList(ref, side, params, false, false, col);
  }

  private buildInList(
    lhs: string,
    values: unknown[],
    params: unknown[],
    insensitive: boolean,
    negate: boolean,
    col?: ColumnMetadata,
  ): string {
    if (!Array.isArray(values) || values.length === 0) {
      // `in []` matches nothing; `not in []` matches everything (SQL parity requires a
      // missing-value row to match `notIn []`, so NO presence guard is appended here).
      return negate ? ALWAYS_TRUE : this.alwaysFalse();
    }
    if (col && isPowdbDatetimeColumn(col)) return this.buildDatetimeInList(lhs, values, params, negate, col);
    const items = values.map((v) => this.bind(v, params, insensitive, col)).join(', ');
    if (negate) {
      // PowQL `not in` matches missing-value rows, so append `and lhs is not null`
      // for SQL null-semantics parity (non-empty list only, per the empty-list note above).
      return `(${lhs} not in (${items}) and ${lhs} is not null)`;
    }
    return `${lhs} in (${items})`;
  }

  /**
   * `in` / `not in` on a PowDB-native `datetime` column, expanded into the
   * equality chain the engine answers correctly:
   *
   *   `in`     → `(.ts = $1 or .ts = $2 …)`
   *   `notIn`  → `(.ts != $1 and .ts != $2 … and .ts is not null)`
   *
   * PowQL's LIST form compares a datetime column against integer timestamp
   * literals by TYPE TAG as of engine 0.20 (the 0.20 timestamp fix covered the
   * binary operators only): measured on the 0.20.0 addon, `filter .ts in
   * (<micros>, …)` matches nothing and `not in` matches everything, while the
   * identical lists against an `int` control column answer correctly. The
   * expanded chain uses the operators 0.20 DID fix, so it answers correctly and
   * matches the int control exactly.
   *
   * This is what keeps the relation family coherent: relation filters and the
   * batched loaders both compile to a key `in` list, so without the rewrite the
   * same relation was refused through one strategy and served through another
   * (nested projections and joins correlate column to column and never emit a
   * list at all).
   *
   * The cost is the chain's width. PowQL bounds the SHAPE of the predicate tree,
   * and a flat `or` / `and` chain spends one level per term against the same
   * 64-level budget as nested parens (measured on 0.20: 63 terms at the top
   * level, 61 one level deep), so the expansion is capped at
   * {@link MAX_POWQL_DATETIME_TERMS} with headroom for whatever predicate it
   * sits inside. The loaders chunk their key lists to that cap, so only a
   * caller-written list (or a relation filter matching very many distinct
   * timestamps) can exceed it, and that raises a typed E017 saying so rather
   * than an engine parse failure.
   */
  private buildDatetimeInList(
    lhs: string,
    values: unknown[],
    params: unknown[],
    negate: boolean,
    col: ColumnMetadata,
  ): string {
    if (values.length > MAX_POWQL_DATETIME_TERMS) {
      throw new UnsupportedFeatureError(
        `\`${negate ? 'notIn' : 'in'}\` with ${values.length} values on the PowDB datetime column "${col.name}"`,
        'PowDB',
        `PowQL's \`in\` list still compares a datetime column against integer timestamp literals by type tag as of ` +
          `engine 0.20, so Turbine expands it into an equality chain, which PowQL's nesting budget caps at ` +
          `${MAX_POWQL_DATETIME_TERMS} terms. Narrow the list (a \`gte\`/\`lte\` range over the same timestamps is ` +
          'one comparison), split the call and merge the results, or store the column as a PowQL `int` of epoch ' +
          "microseconds, which is what Turbine's own DDL emits for a `Date` column. A relation filter reaches this " +
          'when the inner predicate matches more than that many distinct key timestamps.',
      );
    }
    const terms = values.map((v) => `${lhs} ${negate ? '!=' : '='} ${this.param(v, params, col)}`);
    // `!=` already excludes a missing-value row, but the trailing presence guard
    // keeps the emitted predicate identical in meaning to the plain `not in`
    // branch above (and to SQL null semantics) on every engine version.
    if (negate) terms.push(`${lhs} is not null`);
    return `(${terms.join(negate ? ' and ' : ' or ')})`;
  }

  /**
   * A literal `ref in (…)` clause for the hand-built key lists the relation
   * loaders emit (they bypass {@link buildWhere}). Routes a PowDB-native
   * `datetime` key column through the same equality-chain expansion the
   * where-builder uses, so a datetime junction / correlation key behaves
   * identically however the statement was assembled.
   */
  private inClause(ref: string, values: unknown[], params: unknown[], col?: ColumnMetadata): string {
    if (col && isPowdbDatetimeColumn(col)) {
      this.assertDatetimePredicateSupported(col);
      return this.buildDatetimeInList(ref, values, params, false, col);
    }
    return `${ref} in (${values.map((v) => this.param(v, params, col)).join(', ')})`;
  }

  /**
   * Key-chunk size for a relation loader. A PowDB-native `datetime` correlation
   * column's `in` list is expanded into an equality chain, which PowQL's nesting
   * budget bounds, so those keys chunk at {@link MAX_POWQL_DATETIME_TERMS}
   * (more, smaller round-trips) instead of {@link MAX_RELATION_KEYS}.
   */
  private keyChunkSize(meta: TableMetadata | undefined, colName: string): number {
    const col = meta?.columns.find((c) => c.name === colName);
    return col && isPowdbDatetimeColumn(col) ? MAX_POWQL_DATETIME_TERMS : MAX_RELATION_KEYS;
  }

  /**
   * Pre-resolve every relation filter in a where clause into a plain scalar
   * condition on the **local key**, by running the inner predicate as its own
   * query and materializing the matching keys as a literal list. The compiled
   * where is then relation-free and `buildWhere` emits only `in (<literal list>)`.
   *
   * Why not an IN-subquery (`.k in (Target filter <e> { .fk })`)? PowDB's
   * executor caches a subquery's result by **plan shape, ignoring the literal**,
   * so a second subquery of the same shape with a different value returns the
   * first one's stale rows (reproduced live on the embedded engine; the
   * single-statement literal `in (list)` form is always correct). Resolving
   * client-side trades extra round-trips for correctness, and recurses: nested
   * relation filters in the inner predicate resolve when the target query runs.
   *
   * `skip` is the query's `skipGlobalFilters`, forwarded to every target query
   * so the target's global filter bounds the related rows exactly as the SQL
   * engines' EXISTS does, and an opt-out reaches the targets as it does there.
   */
  private async resolveRelationFilters(
    where: WhereClause<T> | undefined,
    timeout?: number,
    skip?: unknown,
  ): Promise<WhereClause<T> | undefined> {
    if (!where) return where;
    return this.resolveRelationFiltersIn(this.sqlTrueWhere(where), timeout, skip);
  }

  /**
   * {@link resolveRelationFilters} over a where already in {@link sqlTrueWhere}'s
   * form (`AND` / `OR` arrays, `NOT` objects).
   */
  private async resolveRelationFiltersIn(
    where: WhereClause<T> | undefined,
    timeout?: number,
    skip?: unknown,
  ): Promise<WhereClause<T> | undefined> {
    if (!where) return where;
    const scalar: Record<string, unknown> = {};
    const relConds: Record<string, unknown>[] = [];
    for (const [key, value] of Object.entries(where)) {
      if (value === undefined) continue;
      if (key === 'AND' || key === 'OR') {
        scalar[key] = await Promise.all(
          (value as WhereClause<T>[]).map((w) => this.resolveRelationFiltersIn(w, timeout, skip)),
        );
        continue;
      }
      if (key === 'NOT') {
        scalar[key] = await this.resolveRelationFiltersIn(value as WhereClause<T>, timeout, skip);
        continue;
      }
      const rel = resolveRelationDef(this.meta.relations, key);
      if (!rel) {
        scalar[key] = value;
        continue;
      }
      const cond = await this.resolveRelationCondition(rel, key, value, timeout, skip);
      if (cond) relConds.push(cond);
    }
    if (!relConds.length) return scalar as WhereClause<T>;
    const hasScalar = Object.keys(scalar).length > 0;
    return { AND: [...(hasScalar ? [scalar] : []), ...relConds] } as WhereClause<T>;
  }

  /**
   * Resolve one relation filter to a relation-free condition on the local key,
   * with the SQL engines' meaning for every branch:
   *
   *   some / is      EXISTS a related row matching the inner where
   *   none / isNot   NOT EXISTS such a row (true for a NULL local key)
   *   every          NOT EXISTS a related row for which the inner where is FALSE
   *   is: null       NOT EXISTS any related row
   *   isNot: null    EXISTS a related row
   *
   * A bare object on a to-one relation is an implicit `is` (the shared
   * {@link normalizeRelationFilter} rule). Branches combine with AND. A shape
   * that names no branch, or names something else, is refused: compiling it to
   * nothing would match every row, and a mutation carrying it would write them.
   * Returns `null` when every branch key is `undefined` (an absent filter).
   */
  private async resolveRelationCondition(
    rel: RelationDef,
    key: string,
    value: unknown,
    timeout?: number,
    skip?: unknown,
  ): Promise<Record<string, unknown> | null> {
    const shapeError = (detail: string): ValidationError =>
      new ValidationError(
        `Invalid relation filter "${key}" on "${this.table}": ${detail}. ` +
          (rel.type === 'belongsTo' || rel.type === 'hasOne'
            ? `A to-one relation takes \`{ is: {...} }\`, \`{ isNot: {...} }\`, a bare where object, or \`is: null\`.`
            : 'A to-many relation takes `{ some: {...} }`, `{ none: {...} }` or `{ every: {...} }`.'),
      );
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw shapeError(`expected an object, got ${describeOperand(value)}`);
    }
    // The shared rule; its first parameter is unused, so it needs no SQL builder context.
    const filter = normalizeRelationFilter(undefined as never, rel, value as Record<string, unknown>);
    const keys = Object.keys(filter);
    if (keys.length === 0) throw shapeError('the filter object is empty');
    const unknown = keys.filter((k) => !(RELATION_FILTER_KEYS as readonly string[]).includes(k));
    if (unknown.length) throw shapeError(`unrecognized key ${unknown.map((k) => `"${k}"`).join(', ')}`);
    if (keys.every((k) => filter[k] === undefined)) return null;

    // The shared value rule: `some` / `none` / `every` take a where object,
    // `is` / `isNot` a where object or null. Checked for every branch before
    // any of them runs a query.
    for (const branch of RELATION_FILTER_KEYS) {
      const problem = relationFilterValueProblem(branch, filter[branch]);
      if (problem !== null) throw shapeError(problem);
    }
    // The shared cardinality rule: `is` / `isNot` on a to-many relation.
    const cardinality = relationCardinalityProblem(rel, filter);
    if (cardinality !== null) throw shapeError(cardinality);
    const conds: Record<string, unknown>[] = [];
    for (const branch of RELATION_FILTER_KEYS) {
      const inner = filter[branch];
      if (inner === undefined) continue;
      const where = inner as Record<string, unknown> | null;
      switch (branch as RelationFilterKey) {
        case 'some':
          conds.push(await this.relationMatch(rel, where as Record<string, unknown>, true, timeout, skip));
          break;
        case 'none':
          conds.push(await this.relationMatch(rel, where as Record<string, unknown>, false, timeout, skip));
          break;
        case 'every': {
          // `every` over a where that compiles to no condition (`{}`, `AND: []`)
          // holds for every parent, as in SQL. Otherwise the parent fails when
          // one related row makes the predicate FALSE; a row that leaves it
          // unknown (a NULL column) does not count against it.
          const targetQi = this.relationTargetQi(rel);
          if (targetQi.compilesToNothing(where)) break;
          const violates = targetQi.sqlFalseWhere(where as WhereClause<object>) as Record<string, unknown>;
          conds.push(await this.relationMatch(rel, violates, false, timeout, skip));
          break;
        }
        case 'is':
          conds.push(await this.relationMatch(rel, where ?? {}, where !== null, timeout, skip));
          break;
        case 'isNot':
          conds.push(await this.relationMatch(rel, where ?? {}, where === null, timeout, skip));
          break;
      }
    }
    if (conds.length === 0) return {};
    return conds.length === 1 ? conds[0]! : { AND: conds };
  }

  /** A fresh interface over a relation's target table, for an internal fetch. */
  private relationTargetQi(rel: RelationDef): PowqlInterface<object> {
    if (!this.schema.tables[rel.to]) {
      throw new ValidationError(`Relation "${rel.name}" targets unknown table "${rel.to}".`);
    }
    return new PowqlInterface<object>(this.pool, rel.to, this.schema, [], this.loaderChildOptions());
  }

  /**
   * `EXISTS` (or `NOT EXISTS`, when `exists` is false) a related row matching
   * `inner`, as a condition on this table's local key.
   *
   * The NOT EXISTS form keeps a NULL local key: such a row has no related row,
   * so it qualifies. PowQL's `not in` alone would drop it.
   */
  private async relationMatch(
    rel: RelationDef,
    inner: Record<string, unknown>,
    exists: boolean,
    timeout?: number,
    skip?: unknown,
  ): Promise<Record<string, unknown>> {
    const { localField, keys } =
      rel.type === 'manyToMany'
        ? await this.manyToManySourceKeys(rel, inner, timeout, skip)
        : await this.directRelationKeys(rel, inner, timeout, skip);
    if (exists) return { [localField]: { in: keys } };
    const localCol = this.column(localField);
    if (!localCol.nullable) return { [localField]: { notIn: keys } };
    return { OR: [{ [localField]: null }, { [localField]: { notIn: keys } }] };
  }

  /**
   * hasMany / hasOne / belongsTo: the local field, and the distinct correlation
   * keys of the target rows matching `inner` (inside the target's global filter).
   * hasMany/hasOne: local = our referenceKey, collected = the child's foreignKey.
   * belongsTo:      local = our foreignKey,   collected = the target's referenceKey.
   */
  private async directRelationKeys(
    rel: RelationDef,
    inner: Record<string, unknown>,
    timeout?: number,
    skip?: unknown,
  ): Promise<{ localField: string; keys: unknown[] }> {
    const fk = normalizeKeyColumns(rel.foreignKey);
    const rk = normalizeKeyColumns(rel.referenceKey);
    if (fk.length > 1 || rk.length > 1) {
      throw new UnsupportedFeatureError(
        'composite-key relation filters',
        'PowDB',
        `relation "${rel.name}" uses a composite key, PowQL has no tuple-\`in\` to express it`,
      );
    }
    const targetQi = this.relationTargetQi(rel);
    const localCol = rel.type === 'belongsTo' ? fk[0]! : rk[0]!;
    const childCol = rel.type === 'belongsTo' ? rk[0]! : fk[0]!;
    const localField = this.meta.reverseColumnMap[localCol] ?? localCol;
    const childField = targetQi.meta.reverseColumnMap[childCol] ?? childCol;
    const keys = await targetQi.collectRelationKeys(inner, childField, rel.name, timeout, skip);
    return { localField, keys };
  }

  /**
   * The distinct non-null values of `field` over this table's rows matching
   * `where` (inside this table's global filter, honouring `skip`), refused
   * past {@link MAX_RELATION_FILTER_KEYS}.
   */
  private async collectRelationKeys(
    where: Record<string, unknown> | undefined,
    field: string,
    relName: string,
    timeout?: number,
    skip?: unknown,
  ): Promise<unknown[]> {
    const rows = await this.findMany({
      where: where as WhereClause<T> | undefined,
      select: { [field]: true },
      timeout,
      ...(skip !== undefined ? { skipGlobalFilters: skip } : {}),
    } as unknown as FindManyArgs<T>);
    return this.distinctKeys(
      rows.map((r) => (r as Record<string, unknown>)[field]),
      relName,
    );
  }

  /** Dedupe correlation keys by value (a Date or bigint by its value, not identity) and enforce the cap. */
  private distinctKeys(values: Iterable<unknown>, relName: string): unknown[] {
    const byKey = new Map<string, unknown>();
    for (const v of values) {
      const k = this.joinKey(v);
      if (k !== null && !byKey.has(k)) byKey.set(k, v);
    }
    if (byKey.size > MAX_RELATION_FILTER_KEYS) {
      throw new UnsupportedFeatureError(
        `A relation filter on "${relName}" matching ${byKey.size} distinct keys`,
        'PowDB',
        `PowDB resolves a relation filter into a literal list of keys, which the engine checks row by row, so ` +
          `the cost grows with rows times keys; Turbine refuses lists over ${MAX_RELATION_FILTER_KEYS}. Narrow the ` +
          'inner predicate, or query from the related side instead (filter the related table and load the parent ' +
          'with `with`).',
      );
    }
    return [...byKey.values()];
  }

  /** manyToMany: the source key field, and the source keys linked (through the junction) to targets matching `inner`. */
  private async manyToManySourceKeys(
    rel: RelationDef,
    inner: Record<string, unknown>,
    timeout?: number,
    skip?: unknown,
  ): Promise<{ localField: string; keys: unknown[] }> {
    const through = rel.through;
    if (!through) throw new ValidationError(`manyToMany relation "${rel.name}" is missing its junction (\`through\`).`);
    const sourceJ = normalizeKeyColumns(through.sourceKey);
    const targetJ = normalizeKeyColumns(through.targetKey);
    const sourceRef = normalizeKeyColumns(rel.referenceKey);
    const targetQi = this.relationTargetQi(rel);
    const targetMeta = targetQi.meta;
    if (sourceJ.length > 1 || targetJ.length > 1 || sourceRef.length > 1 || targetMeta.primaryKey.length > 1) {
      throw new UnsupportedFeatureError(
        'composite-key manyToMany filters',
        'PowDB',
        `relation "${rel.name}", PowQL has no tuple-\`in\` for composite junction/target keys`,
      );
    }
    const sourceJCol = sourceJ[0]!;
    const targetJCol = targetJ[0]!;
    const sourceRefCol = sourceRef[0]!;
    const targetPkCol = targetMeta.primaryKey[0]!;
    const localField = this.meta.reverseColumnMap[sourceRefCol] ?? sourceRefCol;
    const sourceRefColMeta = this.meta.columns.find((c) => c.name === sourceRefCol);
    const targetPkField = targetMeta.reverseColumnMap[targetPkCol] ?? targetPkCol;
    const targetPks = await targetQi.collectRelationKeys(inner, targetPkField, rel.name, timeout, skip);
    if (!targetPks.length) return { localField, keys: [] };
    // Junction source keys linking any of the targets (literal in-lists, never a subquery).
    const junctionMeta = this.schema.tables[through.table];
    const targetJColMeta = junctionMeta?.columns.find((c) => c.name === targetJCol);
    const junctionChunk = this.keyChunkSize(junctionMeta, targetJCol);
    const sources: unknown[] = [];
    for (let i = 0; i < targetPks.length; i += junctionChunk) {
      const chunk = targetPks.slice(i, i + junctionChunk);
      const params: unknown[] = [];
      const keyClause = this.inClause(this.colRefName(targetJCol), chunk, params, targetJColMeta);
      const { rows } = await this.exec(
        `${quotePowqlIdent(through.table)} filter ${keyClause} { ${this.colRefName(sourceJCol)} }`,
        params,
        timeout,
        'findMany',
      );
      for (const r of rows) {
        const v = r[sourceJCol];
        if (v != null) sources.push(sourceRefColMeta ? coerceScalar(String(v), sourceRefColMeta.tsType) : v);
      }
    }
    return { localField, keys: this.distinctKeys(sources, rel.name) };
  }

  /**
   * Rows where `where` is TRUE under SQL three-valued logic. PowQL's own
   * evaluation already excludes a NULL from every comparison, so this differs
   * from `where` only under `NOT`, where PowQL takes the plain complement and
   * SQL keeps a NULL comparison unknown.
   *
   * Combinators are read by the shared {@link combinatorBranches} rule, so a
   * shape the SQL engines refuse is refused here (E003), and the output uses
   * one spelling: `AND` / `OR` arrays and `NOT` objects. `OR: []` stays as
   * written and compiles to no row.
   */
  private sqlTrueWhere(where: WhereClause<T>): WhereClause<T> {
    const parts: Record<string, unknown>[] = [];
    for (const [key, value] of Object.entries(where)) {
      if (value === undefined) continue;
      if (isCombinatorKey(key)) {
        const branches = combinatorBranches(key, value, this.table);
        if (branches === null) continue;
        if (key === 'NOT') {
          for (const branch of branches) {
            // A branch that compiles to no condition is skipped, as on the SQL engines.
            if (!this.compilesToNothing(branch)) {
              parts.push(this.sqlFalseWhere(branch as WhereClause<T>) as Record<string, unknown>);
            }
          }
        } else if (key === 'OR' || branches.length > 0) {
          parts.push({ [key]: branches.map((w) => this.sqlTrueWhere(w as WhereClause<T>)) });
        }
      } else {
        parts.push({ [key]: value });
      }
    }
    if (parts.length === 0) return {} as WhereClause<T>;
    return (parts.length === 1 ? parts[0] : { AND: parts }) as WhereClause<T>;
  }

  /**
   * Rows where `where` is FALSE under SQL three-valued logic, the complement
   * PowQL's two-valued `not` cannot express: a comparison against a NULL
   * column is unknown, which is neither TRUE nor FALSE, so the row belongs to
   * neither set. Relation filters (EXISTS) are two-valued and negate plainly.
   *
   * A sub-where that compiles to no condition is TRUE, so it is FALSE for no
   * row and contributes nothing; `OR: []` is FALSE for every row.
   */
  private sqlFalseWhere(where: WhereClause<T>): WhereClause<T> {
    const parts: Record<string, unknown>[] = [];
    for (const [key, value] of Object.entries(where)) {
      if (value === undefined) continue;
      if (isCombinatorKey(key)) {
        const branches = combinatorBranches(key, value, this.table);
        if (branches === null) continue;
        if (key === 'OR' && branches.length === 0) {
          parts.push(this.trueWhere() as Record<string, unknown>);
          continue;
        }
        const live = branches.filter((w) => !this.compilesToNothing(w));
        // An `OR` with a branch that has no condition is TRUE: FALSE for no row.
        if (live.length === 0 || (key === 'OR' && live.length < branches.length)) continue;
        if (key === 'AND') parts.push({ OR: live.map((w) => this.sqlFalseWhere(w as WhereClause<T>)) });
        else if (key === 'OR') parts.push({ AND: live.map((w) => this.sqlFalseWhere(w as WhereClause<T>)) });
        else for (const w of live) parts.push(this.sqlTrueWhere(w as WhereClause<T>) as Record<string, unknown>);
      } else if (resolveRelationDef(this.meta.relations, key)) {
        parts.push({ NOT: { [key]: value } });
      } else {
        // A column leaf is FALSE when the column is non-null and the leaf does
        // not hold; on a NULL column only an explicit `not: null` (or an empty
        // `in`) makes it FALSE, every other comparison is unknown there.
        const op = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
        const falseAtNull = op !== undefined && (op.not === null || (Array.isArray(op.in) && op.in.length === 0));
        const branch = { AND: [{ [key]: { not: null } }, { NOT: { [key]: value } }] };
        parts.push(falseAtNull ? { OR: [branch, { [key]: null }] } : branch);
      }
    }
    // A where with no condition is TRUE for every row, so FALSE for none.
    if (parts.length === 0) return this.falseWhere();
    return (parts.length === 1 ? parts[0] : { OR: parts }) as WhereClause<T>;
  }

  /**
   * Whether a where compiles to no condition, as {@link buildWhere} and the
   * SQL where walk both read it: only absent keys, and `AND` / `NOT` whose
   * branches all compile to nothing (`AND: []`, `NOT: [{}]`). Any `OR` is a
   * condition: `OR: []` matches no row, and an `OR` with a branch that has no
   * condition is constant TRUE (`OR: [{}]`), which `NOT` negates. So is any
   * column or relation key.
   */
  private compilesToNothing(where: unknown): boolean {
    if (where === null || typeof where !== 'object' || Array.isArray(where)) return false;
    for (const [key, value] of Object.entries(where)) {
      if (value === undefined) continue;
      if (!isCombinatorKey(key)) return false;
      const branches = combinatorBranches(key, value, this.table);
      if (branches === null) continue;
      if (key === 'OR') return false;
      if (!branches.every((w) => this.compilesToNothing(w))) return false;
    }
    return true;
  }

  /** A where clause that matches every row (the primary key is null or not null). */
  private trueWhere(): WhereClause<T> {
    const pk = this.meta.primaryKey[0] ?? this.meta.columns[0]?.name ?? 'id';
    const field = this.meta.reverseColumnMap[pk] ?? pk;
    return { OR: [{ [field]: null }, { [field]: { not: null } }] } as WhereClause<T>;
  }

  /** A where clause that matches no row (an empty `in` on the primary key). */
  private falseWhere(): WhereClause<T> {
    const pk = this.meta.primaryKey[0] ?? this.meta.columns[0]?.name ?? 'id';
    return { [this.meta.reverseColumnMap[pk] ?? pk]: { in: [] } } as WhereClause<T>;
  }

  // -------------------------------------------------------------------------
  // Projection / order
  // -------------------------------------------------------------------------

  /**
   * Resolve the set of columns to project, honouring `select` / `omit` and the
   * query-level `includePii` opt-in. PII-tagged (`defineSchema` `pii: true`)
   * columns are EXCLUDED from a default (or omit-only) projection unless
   * `includePii: UNSAFE` is passed, and a `select` naming one without it is
   * refused (E003), as on the SQL engines. Untagged tables project exactly as
   * before.
   */
  /**
   * Resolve one projection field name, or throw. PowQL already refused an
   * unresolvable name here (via {@link column}), unlike the SQL engines' join
   * path, which filtered it out silently until 0.64. What this adds is the
   * RELATION case: naming a relation inside `select` is a Prisma habit rather
   * than a typo, and the generic "unknown column" text sends the reader looking
   * for a misspelling that is not there. Same message as the SQL engines.
   */
  private projectionColumn(field: string, clause: 'select' | 'omit'): string {
    if (resolveRelationDef(this.meta.relations, field)) {
      throw new ValidationError(relationInProjectionMessage(this.table, field, clause));
    }
    return this.column(field).name;
  }

  /**
   * The projected column list, plus the PK columns that are in it ONLY because
   * this method put them there.
   *
   * PowDB needs the PK in the FETCH even when the caller excluded it: `upsert`
   * reselects by PK, the m2m loader keys its target map on it (`targetByPk`),
   * and the join path correlates through it. That force-add is right and stays.
   * What was missing is the other half, taking it back off the ENTITY, so
   * `select: { name: true }` returned `{ id, name }` and `omit: { id: true }`
   * returned the column the caller asked to hide. The SQL engines return
   * neither, so this was a cross-engine divergence on a documented-as-shared
   * surface, and it was UNIFORM within PowDB: all five paths leaked (top-level
   * find, batched loader, native join, nested projection, link path). The link
   * path was the only one that even tried, and its strip could never fire: it
   * decided "did the caller ask for the PK" by testing the column list AFTER
   * the force-add, which by construction always contains it. So there was one
   * strip in the code, dead since it shipped, and no query anywhere got the
   * projection it asked for.
   *
   * `forcedPk` is what the strip needs, and it is deliberately NARROW: only the
   * `select` / `omit` force-adds are listed. A PII-tagged PK kept through the
   * DEFAULT projection is NOT, because that one is a deliberate, documented
   * decision the SQL engines make identically (a row that cannot address itself
   * is worse than a key that leaks its own value).
   */
  private projectionPlan(
    select?: Record<string, boolean>,
    omit?: Record<string, boolean>,
    includePii?: boolean,
  ): { cols: string[]; forcedPk: string[] } {
    // Same two shape refusals as `resolveProjection` on the SQL engines, with
    // the shared messages, and for a live reason here: this path used to
    // APPLY select-minus-omit while the SQL engines ignored the `omit` half,
    // so one query meant different columns depending on the backend. And a
    // zero-key/all-false select used to fall through to the DEFAULT
    // projection here while the SQL engines emitted broken or empty rows;
    // both shapes are ambiguous and now refused identically on every engine.
    // Presence-decided, exactly like resolveProjection (see its comment for
    // the strategy-flip this prevents).
    if (select) {
      if (!Object.values(select).some(Boolean)) {
        throw new ValidationError(selectNamesNothingMessage(this.table));
      }
      if (omit && Object.values(omit).some(Boolean)) {
        throw new ValidationError(selectOmitExclusiveMessage(this.table));
      }
    }
    const pk = new Set(this.meta.primaryKey);
    let cols = this.meta.columns.map((c) => c.name);
    const forcedPk: string[] = [];
    const hasSelect = select && Object.keys(select).length;
    if (hasSelect) {
      // A PII column named in `select` is refused unless the read passes
      // `includePii: UNSAFE`, as on the SQL engines. A key the loader added
      // itself (a PII-tagged correlation column) carries the stitch-only mark.
      if (!includePii) {
        const pii = this.piiColumnNames();
        if (pii.size) {
          const stitchOnly = stitchOnlyFields(select);
          for (const [key, on] of Object.entries(select)) {
            if (!on || stitchOnly?.has(key)) continue;
            const column = this.projectionColumn(key, 'select');
            if (pii.has(column) && !pk.has(column)) {
              throw new ValidationError(
                piiSelectRefusedMessage(this.table, this.meta.reverseColumnMap[column] ?? column),
              );
            }
          }
        }
      }
      const picked = new Set(
        Object.entries(select)
          .filter(([, v]) => v)
          .map(([k]) => this.projectionColumn(k, 'select')),
      );
      // Always keep the PK so reselect / relation stitching has a key to work
      // with; record the ones the caller did NOT name so they can be taken back
      // off the entity once the stitching is done.
      for (const key of pk) {
        if (!picked.has(key)) forcedPk.push(key);
        picked.add(key);
      }
      cols = cols.filter((c) => picked.has(c));
    } else if (!includePii) {
      // Default / omit-only projection: drop PII columns (kept above only when a
      // caller names them in `select`), EXCEPT a PK column. This used to drop a
      // tagged PK, on the reasoning that keys should not be tagged in the first
      // place. That is good advice and a bad guarantee: the row it returns
      // cannot address itself, so writing it back builds a partial predicate
      // and mutates every row sharing the rest of the key. Same rule and same
      // reason as `piiColumns` on the SQL engines.
      const pii = this.piiColumnNames();
      if (pii.size) cols = cols.filter((c) => !pii.has(c) || pk.has(c));
    }
    if (omit && Object.keys(omit).length) {
      const dropped = new Set(
        Object.entries(omit)
          .filter(([, v]) => v)
          .map(([k]) => this.projectionColumn(k, 'omit')),
      );
      // The PK survives `omit` too. This filter ran unconditionally and after
      // the `select` branch's force-add, so `omit: { id: true }` undid the very
      // guarantee that force-add exists to provide: the m2m loader keys its
      // target map on the PK (`targetByPk`), so every target collapsed onto the
      // single bucket "undefined", no parent matched, and the relation came
      // back `[]` for every row with no error.
      for (const key of dropped) {
        if (pk.has(key) && !forcedPk.includes(key)) forcedPk.push(key);
      }
      cols = cols.filter((c) => !dropped.has(c) || pk.has(c));
    }
    return { cols, forcedPk };
  }

  /**
   * Take the internally-forced PK columns back off the entities, so what the
   * caller receives matches the `select` / `omit` they wrote. Called only after
   * every consumer of the key (relation stitching, reselect) has finished with
   * it. A no-op, and free, when nothing was forced.
   */
  /**
   * The columns of this table that the post-fetch relation loaders read off
   * each parent row for `withClause`: a belongsTo's foreign key, a hasMany /
   * hasOne / manyToMany's reference key, and the same for every relation a
   * `_count` names. An unknown name contributes nothing; the loader raises its
   * E005.
   */
  private loaderParentKeyColumns(withClause: Record<string, unknown>): string[] {
    const out = new Set<string>();
    const add = (rel: RelationDef): void => {
      const cols = rel.type === 'belongsTo' ? rel.foreignKey : rel.referenceKey;
      for (const c of normalizeKeyColumns(cols)) out.add(c);
    };
    for (const [relName, opt] of Object.entries(withClause)) {
      if (!opt) continue;
      if (relName === '_count') {
        for (const rel of resolveCountRelations(this.meta, opt as WithCount)) add(rel);
        continue;
      }
      const rel = ownLookup(this.meta.relations, relName);
      if (rel) add(rel);
    }
    return [...out];
  }

  private stripForcedPk(entities: object[], forcedPk: string[]): void {
    if (forcedPk.length === 0 || entities.length === 0) return;
    const fields = forcedPk.map((c) => this.meta.reverseColumnMap[c] ?? c);
    for (const entity of entities) {
      for (const field of fields) delete (entity as Record<string, unknown>)[field];
    }
  }

  /**
   * The snake_case names of this table's PII-tagged columns. Empty for a table
   * with no `pii: true` column, so untagged tables keep their prior projection.
   */
  private piiColumnNames(): Set<string> {
    const out = new Set<string>();
    for (const col of this.meta.columns) {
      if (col.pii) out.add(col.name);
    }
    return out;
  }

  /**
   * The camelCase field names of this table's PII-tagged columns: the read
   * policy applied to a write's returned row (create/update/upsert/delete accept
   * no `includePii`/`select`, so their result always drops PII; you may still
   * write PII fields freely).
   *
   * SPEC LIMITATION (PowQL): the driver contract
   * (`docs/integrations/powql-for-drivers.md`) exposes `returning` only as a
   * bare keyword that hands back every column; it accepts NO column list, so
   * (unlike the SQL engines, which emit an explicit non-PII `RETURNING`/`OUTPUT`
   * projection) the create/update/delete `returning` paths cannot exclude PII at
   * the query-language level and must strip it here after the fact. This is the
   * client-side strip of last resort, not defense-in-depth, for those paths; we
   * do NOT reverse-engineer an undocumented projection form. The upsert path is
   * different: it has no `returning` and reselects by PK through the read
   * projection ({@link projectionPlan}), which already omits PII, so PII never
   * crosses the wire there. If a future spec revision lets `returning` take a
   * projection, switch the write paths to emit the non-PII list and this strip
   * becomes a no-op like {@link parseWriteRow} on the SQL engines.
   */
  private stripWritePii(entity: T | null): T | null {
    if (!entity) return entity;
    // Same PRIMARY-KEY exemption as the SQL engines' `piiColumns` / `piiFields`
    // (query/writes.ts), and for the same measured reason: the returned row has
    // to stay ADDRESSABLE. Without it a PII-tagged key column came back deleted,
    // so the caller's follow-up `update`/`delete` built its where from a partial
    // key, the empty-where guard did not fire (the other member was present),
    // and the write hit every row sharing the remaining member. The policy is
    // "tag sensitive data, not keys": a PII PK is documented out of scope for
    // stripping. This docstring already cross-referenced the SQL rule; only the
    // exemption itself was missing.
    const pk = new Set(this.meta.primaryKey);
    for (const col of this.meta.columns) {
      if (col.pii && !pk.has(col.name)) delete (entity as Record<string, unknown>)[col.field];
    }
    return entity;
  }

  /**
   * A single-row write's `select` / `omit`, resolved by {@link projectionPlan}
   * so the rules and messages are the read path's, and the SQL engines' (an
   * unknown name is E003, `select` must name something, the pair is refused).
   * `undefined` for the default return shape. Resolved BEFORE the write is sent,
   * so a bad projection writes nothing.
   *
   * The narrowing itself happens on the returned row ({@link shapeWriteRow}):
   * PowQL's `returning` takes no column list (see {@link stripWritePii}), so
   * unlike the SQL engines the unselected columns still cross the wire here.
   * The RESULT is identical across engines; the byte saving is SQL-only.
   */
  private writeReturnPlan(args: {
    select?: Record<string, boolean>;
    omit?: Record<string, boolean>;
  }): { cols: string[]; forcedPk: string[] } | undefined {
    if (args.select === undefined && args.omit === undefined) return undefined;
    return this.projectionPlan(args.select, args.omit, false);
  }

  /** Apply a write's return plan to its row, or the default PII strip without one. */
  private shapeWriteRow(entity: T | null, plan: { cols: string[]; forcedPk: string[] } | undefined): T | null {
    if (!entity || !plan) return this.stripWritePii(entity);
    const keep = new Set(
      plan.cols.filter((c) => !plan.forcedPk.includes(c)).map((c) => this.meta.reverseColumnMap[c] ?? c),
    );
    for (const key of Object.keys(entity)) {
      if (!keep.has(key)) delete (entity as Record<string, unknown>)[key];
    }
    return entity;
  }

  /** `{ .c1, .c2, … }` projection clause. */
  private projection(cols: string[]): string {
    return `{ ${cols.map((c) => this.colRefName(c)).join(', ')} }`;
  }

  /**
   * `order .c1 asc, .c2 desc` clause (empty string when no orderBy). Supports,
   * besides a plain direction:
   *   - {@link JsonPathOrderBy} on a json column (≥ 0.12): `{ data: { path: […],
   *     type?, direction? } }` → `order .data->$n asc` (or
   *     `cast(.data->$n, "float")` for `type: 'numeric'`);
   *   - {@link OrderBySpec} `{ sort, nulls }`: `nulls: 'last'` is accepted as a
   *     no-op (PowDB is always nulls-last), `nulls: 'first'` throws E017.
   *
   * PowDB orders missing / JSON-null keys LAST in BOTH directions (an engine
   * contract): for identical cross-engine results pass `nulls: 'last'`
   * explicitly on Postgres, which defaults nulls-first for `desc`.
   */
  /**
   * Validate one orderBy direction token and return the PowQL keyword.
   *
   * Every direction site on this engine used to be spelled
   * `x === 'desc' ? 'desc' : 'asc'`, so `'DESC'`, a token the CORE explicitly
   * accepts and honours, compiled to `asc` here: identical application code
   * sorted one way on Postgres and silently the opposite way on PowDB. The rule
   * is core's {@link assertDirectionToken}, reused rather than re-derived, so
   * the two engines cannot drift again. `undefined` stays "not specified"
   * (defaults asc); `null` is a VALUE and is refused like any other bad token.
   */
  private dirKeyword(value: unknown, context: string): 'asc' | 'desc' {
    assertDirectionToken(value, context);
    return typeof value === 'string' && value.toLowerCase() === 'desc' ? 'desc' : 'asc';
  }

  private buildOrder(orderBy: OrderByClause | undefined, params: unknown[], alias?: string): string {
    if (!orderBy) return '';
    const keys = orderByEntries(orderBy).filter(([, dir]) => dir !== undefined);
    if (!keys.length) return '';
    const parts = keys.map(([field, dir]) => {
      if (dir && typeof dir === 'object') {
        const o = dir as Record<string, unknown>;
        // JSON-path ordering on a json column.
        if (Array.isArray(o.path)) {
          return this.buildJsonPathOrder(field, dir as JsonPathOrderBy, params, alias);
        }
        // OrderBySpec { sort, nulls }: accept nulls-last (PowDB default), refuse
        // nulls-first (no placement grammar). Distinct from vector/pick/_count.
        if ('sort' in o && !('distance' in o) && !('_count' in o) && !isRelationPickOrderBy(dir)) {
          const spec = dir as OrderBySpec;
          if (spec.nulls === 'first') {
            throw new UnsupportedFeatureError(
              'NULLS FIRST placement',
              'PowDB',
              `field "${field}": PowDB orders NULLs / missing keys LAST in both directions`,
            );
          }
          this.assertDecimalComparable(this.column(field), 'Ordering');
          this.assertEnumOrderable(this.column(field), 'Ordering');
          return `${this.ref(field, alias)} ${this.dirKeyword(spec.sort, `orderBy on "${field}"`)}`;
        }
        // Name the actual feature in the refusal, a pick-row ordering
        // reported as "vector / distance ordering" sends users hunting for
        // pgvector docs. Everything else stays E017 on PowDB.
        const feature = isRelationPickOrderBy(dir)
          ? 'relation pick-row ordering'
          : 'distance' in o
            ? 'vector / distance ordering'
            : '_count' in o
              ? 'relation _count ordering'
              : 'nulls' in o
                ? 'NULLS placement / sort-spec ordering'
                : 'object-valued ordering';
        throw new UnsupportedFeatureError(feature, 'PowDB', `field "${field}"`);
      }
      this.assertDecimalComparable(this.column(field), 'Ordering');
      this.assertEnumOrderable(this.column(field), 'Ordering');
      return `${this.ref(field, alias)} ${this.dirKeyword(dir, `orderBy on "${field}"`)}`;
    });
    return ` order ${parts.join(', ')}`;
  }

  /** Compile one {@link JsonPathOrderBy} entry to `order .col->$n asc` (+ optional numeric cast). */
  private buildJsonPathOrder(field: string, spec: JsonPathOrderBy, params: unknown[], alias?: string): string {
    const col = this.column(field);
    if (!isJsonColumn(col, this.schema.enums)) {
      throw new UnsupportedFeatureError('JSON-path ordering', 'PowDB', `field "${field}" is not a json column`);
    }
    requireCapability(this.capabilities, 'jsonDocs', 'JSON path ordering');
    if (spec.nulls === 'first') {
      throw new UnsupportedFeatureError(
        'NULLS FIRST placement',
        'PowDB',
        `field "${field}": PowDB orders missing / JSON-null keys LAST in both directions`,
      );
    }
    const pathExpr = this.jsonPathExpr(col, spec.path, params, alias);
    // `type: 'numeric'` casts a JSON STRING number for numeric ordering; native
    // JSON numbers already order numerically without a cast.
    const expr = spec.type === 'numeric' ? `cast(${pathExpr}, "float")` : pathExpr;
    return `${expr} ${this.dirKeyword(spec.direction, `JSON-path orderBy on "${field}"`)}`;
  }

  // -------------------------------------------------------------------------
  // Execution plumbing
  // -------------------------------------------------------------------------

  /**
   * Run PowQL with optional timeout, emitting a query event either way. The
   * `action` is passed PER CALL (never read from shared instance state) so the
   * retry-eligibility and the emitted event action stay correct even when a
   * concurrent operation runs on the same cached interface: a WRITE statement
   * carries a write action and can therefore never be mistaken for a replayable
   * read. Read statements pass a read-shaped action from {@link POWQL_READ_ACTIONS}.
   */
  private async exec(
    powql: string,
    params: unknown[],
    timeout?: number,
    action = 'raw',
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number; native: boolean }> {
    return this.execOnce(powql, params, timeout, action, false);
  }

  /** Build the E018 refusal for a write / `begin` on a read-only pool. */
  private readOnlyError(operation: string): ReadOnlyError {
    // Pass a clean detail: the ReadOnlyError constructor owns the "Route writes
    // to a writable primary." hint, so adding it here would double it. The
    // `[TURBINE_E018]` tag is added once, later, by formatErrorMessage.
    return new ReadOnlyError(`${operation} on "${this.table}" refused: this PowDB connection is read-only.`);
  }

  /**
   * Execute one statement, with the opt-in single stale-frame READ replay. When
   * `retryStaleReads` is on and a first-statement READ fails with the stale-wire
   * {@link isStaleFramePowdbError} ConnectionError (a socket idle-gap "received
   * unexpected frame" that the client cannot recover), the statement is retried
   * exactly once on a fresh pooled connection (the broken one was destroyed).
   * The replay is refused for writes (an ambiguous mutation reply is unsafe to
   * replay) and inside a transaction (a mid-tx statement cannot move connection),
   * so only the read-shaped actions in {@link POWQL_READ_ACTIONS}, outside a
   * `_txScoped` interface, are eligible. `action` is a per-call argument (never
   * `this`-state), so a concurrent op flipping instance fields cannot turn a
   * write into a retryable read.
   */
  private async execOnce(
    powql: string,
    params: unknown[],
    timeout: number | undefined,
    action: string,
    isRetry: boolean,
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number; native: boolean }> {
    // Read-only pool guard: refuse a write action locally, before the wire, so a
    // read-only target never even attempts the mutation (the engine refusal, if
    // any, is only the backstop for raw/injected paths). `action` is per-call,
    // so a concurrent read is never mistaken for a write. Reads (incl. explain)
    // and non-classified `raw` fall through unchanged.
    if (this.pool.readonly === true && POWQL_WRITE_ACTIONS.has(action)) {
      throw this.readOnlyError(action);
    }
    const start = performance.now();
    const run = this.pool.query(powql, params) as Promise<{
      rows: Record<string, unknown>[];
      rowCount: number;
      native?: boolean;
    }>;
    try {
      const result = timeout
        ? await Promise.race([
            run,
            new Promise<never>((_, reject) => setTimeout(() => reject(new TimeoutError(timeout)), timeout)),
          ])
        : await run;
      this.emit(action, powql, params, performance.now() - start, result.rowCount ?? result.rows.length);
      // The pool tags each result with the wire that actually served it
      // (adaptResult → false, adaptNativeResult → true). A heterogeneous
      // injected pool can fall back to the legacy wire per call, so read the
      // per-result flag and only fall back to the pool-level capability when a
      // hand-built pool (tests) omits the tag; never coerce legacy rows with
      // the native policy just because the pool reports nativeRaw.
      const native = result.native ?? Boolean(this.capabilities.nativeRaw);
      return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length, native };
    } catch (err) {
      if (!isRetry && this.shouldRetryStaleRead(err, action)) {
        // Transparent single replay on a fresh connection; the first (swallowed)
        // failure is not emitted, only the retried outcome is observed.
        return this.execOnce(powql, params, timeout, action, true);
      }
      this.emit(action, powql, params, performance.now() - start, 0, err as Error);
      throw err;
    }
  }

  /** Is `err` a replayable stale-frame failure for THIS (per-call) read-shaped, non-tx action? */
  private shouldRetryStaleRead(err: unknown, action: string): boolean {
    if (!this.pool.retryStaleReads) return false;
    if (this.isTxScoped()) return false;
    if (!POWQL_READ_ACTIONS.has(action)) return false;
    return isStaleFramePowdbError(err);
  }

  private emit(action: string, sql: string, params: unknown[], duration: number, rows: number, error?: Error): void {
    if (!this.onQuery) return;
    try {
      this.onQuery({
        sql,
        params,
        duration,
        model: this.table,
        action,
        rows,
        timestamp: new Date(),
        error,
      });
    } catch {
      /* listener errors never crash a query */
    }
  }

  /** Run a method body through the middleware chain (mirrors QueryInterface). */
  private async withMiddleware<R>(
    action: string,
    args: Record<string, unknown>,
    executor: () => Promise<R>,
  ): Promise<R> {
    // The unknown-key diagnostic, at the same seam and for the same reason as
    // `QueryInterface.executeWithMiddleware`. The option surface is the CORE
    // one because these args ARE core's args; PowDB reads them, it does not
    // define them.
    warnUnknownQueryOptions(this.table, action, args, this.advice ?? null);
    if (this.middlewares.length === 0) return executor();
    // A copy, as on the SQL engines: the statement is built from `args`, not
    // from what middleware sees, so `next()` throws on a changed copy rather
    // than doing nothing.
    const params = readOnlyMiddlewareParams(this.table, action, args);
    let index = 0;
    const next = async (p: { model: string; action: string; args: Record<string, unknown> }): Promise<unknown> => {
      assertMiddlewareArgsKept(params, p);
      if (index < this.middlewares.length) return this.middlewares[index++]!(p, next);
      return executor();
    };
    return next(params) as Promise<R>;
  }

  /** Map raw rows to typed entities. `native` is the wire that ACTUALLY served
   * this result (threaded from {@link execOnce}, not the pool-level capability),
   * so cells that arrived pre-typed over `queryNativeRaw` (F3) skip the legacy
   * string coercion (a genuine str `"null"` stays `"null"` instead of collapsing
   * to null) while a per-call legacy fallback on a native-capable pool still
   * coerces its string cells correctly. Defaults to the pool capability for the
   * rare caller with no per-result flag (hand-built test pools). */
  private shape(rows: Record<string, unknown>[], native = Boolean(this.capabilities.nativeRaw)): T[] {
    return rows.map((r) => rowToEntity(r, this.meta, native, this.schema.enums) as T);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  findMany<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
    W extends TypedWithClause = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args?: FindManyArgs<T, NoRelations, W, S, O>): Promise<QueryResult<T, NoRelations, W, S, O>[]>;
  async findMany(args: FindManyArgs<T> = {} as FindManyArgs<T>): Promise<T[]> {
    this.assertNoForceCustomPlan(args);
    this.assertNoRowLock(args);
    this.assertNoJsonEncoding(args);
    args = this.completePageOrder(this.normalizeArgs(args));
    return this.withMiddleware('findMany', args as unknown as Record<string, unknown>, async () => {
      // `limit: 0` means "no rows" (SQL `LIMIT 0`), and answering it client-side
      // is correct on every engine version: PowDB's projection fast path returned
      // ONE row for `limit 0` below 0.20. Validate first so a negative limit still
      // raises instead of falling through to a query.
      this.assertPagination(this.effectiveLimit(args), args.offset, 'findMany');
      if (this.effectiveLimit(args) === 0) return [];
      const { rows, native, resolvedWhere, nestedPlans, linkPlans, residualWith, forcedPk } = await this.runFind(
        args,
        'findMany',
      );
      const entities = this.shape(rows, native);
      if (nestedPlans.length) this.attachNestedRows(entities, nestedPlans);
      if (linkPlans.length) this.attachLinkRows(entities, linkPlans, native);
      if (residualWith) {
        await this.loadRelations(
          entities,
          residualWith,
          args.timeout,
          0,
          { args, resolvedWhere },
          resolveUnsafeFlag(args.includePii, 'includePii'),
          args.skipGlobalFilters,
        );
      }
      // LAST: every consumer of the internally-forced PK (relation stitching,
      // the loaders' correlation) has finished with it by here.
      this.stripForcedPk(entities, forcedPk);
      return entities;
    });
  }

  /**
   * Compile the findMany select into PowQL (no execution), pushing values into
   * `params`. Returns the query plus the RESOLVED where (relation filters
   * already collapsed to literal in-lists) so the F2 join path can re-emit the
   * exact parent predicate alias-qualified, and so {@link explain} can wrap it.
   *
   * When the engine supports nested projections (>= 0.18) and the strategy
   * does not opt out, eligible `with` relations compile INTO this statement as
   * nested-projection blocks (`nestedPlans`), one round-trip for the whole
   * shape, and only the ineligible remainder (`residualWith`) goes to the
   * post-execution loaders. Without nesting the emitted PowQL is byte-identical
   * to the pre-0.18 output (no alias, `.col` refs).
   */
  private async buildFind(
    args: FindManyArgs<T>,
    params: unknown[],
  ): Promise<{
    powql: string;
    resolvedWhere: WhereClause<T> | undefined;
    nestedPlans: NestedRelationPlan[];
    linkPlans: LinkPathPlan[];
    residualWith: Record<string, unknown> | undefined;
    /**
     * Columns fetched for internal use only, stripped before the caller sees
     * the rows: the PK (see {@link projectionPlan}) and the parent keys the
     * relation loaders correlate on.
     */
    forcedPk: string[];
  }> {
    // A cursor is checked with the SQL engines' rules first, so an invalid one
    // is E003 on every engine; a valid one is an engine gap (E017).
    const cursor = (args as { cursor?: unknown }).cursor;
    if (this.cursorCarriesValues(cursor)) {
      this.assertCursorPlaceable(cursor as Record<string, unknown>, args.orderBy);
      throw new UnsupportedFeatureError('cursor pagination', 'PowDB', 'use limit/offset instead');
    }
    // `distinct` names COLUMNS: Postgres compiles it to `SELECT DISTINCT ON
    // (col)`, one row per distinct value of those columns. PowQL's `distinct`
    // keyword is ROW-WIDE (`SELECT DISTINCT *`) and takes no column list, and
    // the language has no window functions to rebuild per-column distinct with,
    // so there is nothing faithful to emit. Accepting the option and emitting
    // the row-wide keyword returned a DIFFERENT row set under the same
    // argument, with no error and no warning, which is the one outcome the
    // dialect seam exists to prevent.
    //
    // Refused with the same E017 the other non-Postgres engines already raise
    // (query/builder.ts's `distinctOn` capability gate) and in the same
    // words, so `distinct` now means one thing across every engine and matches
    // what the README documents. Refused BEFORE the column names are resolved,
    // matching that gate's position, so `distinct: ['nope']` reports the
    // unsupported feature rather than the typo on every engine alike. The
    // element shape is checked first, as there: a non-string element is E003.
    if (args.distinct?.length) {
      dedupeColumnList(this.meta, args.distinct as string[]);
      throw new UnsupportedFeatureError(
        'DISTINCT ON (findMany distinct)',
        'PowDB',
        "findMany({ distinct }) requires PostgreSQL: PowQL's `distinct` is row-wide, not per-column. " +
          'Group in application code, or use groupBy({ by }) for one row per combination.',
      );
    }
    const resolvedWhere = await this.resolveRelationFilters(args.where, args.timeout, args.skipGlobalFilters);
    const { cols, forcedPk } = this.projectionPlan(
      args.select as Record<string, boolean> | undefined,
      args.omit as Record<string, boolean> | undefined,
      resolveUnsafeFlag(args.includePii, 'includePii'),
    );

    // Partition the `with` clause: nested-projection blocks vs loader residue.
    // A relation whose field name collides with a projected parent column stays
    // on the loaders (its block key would duplicate the column's). A parent
    // `distinct` used to be a third exclusion here (distinct over a row
    // containing a JSON array is not a defined comparison); the refusal above
    // now settles that one statement earlier, so the branch cannot be reached
    // with a `distinct` present and testing for it again would be dead code
    // implying the option is still accepted.
    const withClause = args.with as Record<string, unknown> | undefined;
    if (withClause) this.assertCountTopLevelOnly(withClause, 0);
    const nestedPlans: NestedRelationPlan[] = [];
    const linkPlans: LinkPathPlan[] = [];
    let residualWith = withClause;
    if (withClause && this.nestedProjectionsPreferred(args)) {
      const residue: Record<string, unknown> = {};
      for (const [relName, opt] of Object.entries(withClause)) {
        if (!opt) continue;
        const rel = this.meta.relations[relName];
        const plan =
          rel && !cols.includes(relName)
            ? this.planNestedRelation(relName, rel, opt, resolveUnsafeFlag(args.includePii, 'includePii'))
            : null;
        if (plan) {
          nestedPlans.push(plan);
          continue;
        }
        // Nested projection could not serve it: try a scalar link path (the narrow
        // to-one bigint/bytes case; the `schema links` snapshot is fetched lazily
        // inside, only when a genuine candidate reaches it), else it stays on the
        // loaders.
        const linkPlan =
          rel && !cols.includes(relName)
            ? await this.planLinkPathRelation(
                relName,
                rel,
                opt,
                resolveUnsafeFlag(args.includePii, 'includePii'),
                cols,
                linkPlans.length + 1,
                args.skipGlobalFilters,
              )
            : null;
        if (linkPlan) linkPlans.push(linkPlan);
        else residue[relName] = opt; // unknown relation: the loader raises its E003
      }
      residualWith = Object.keys(residue).length ? residue : undefined;
    }
    // The loaders (and the native join) read each parent's correlation key off
    // the fetched row, so a `select` / `omit` that leaves it out would stitch
    // nothing. Fetch it anyway and take it back off afterwards, as the SQL
    // engines' batched loader does.
    if (residualWith) {
      for (const column of this.loaderParentKeyColumns(residualWith)) {
        if (cols.includes(column)) continue;
        cols.push(column);
        forcedPk.push(column);
      }
    }

    const nest = nestedPlans.length > 0 || linkPlans.length > 0;
    const alias = nest ? 't0' : undefined;
    let where = this.buildWhere(resolvedWhere, params, alias);
    where = this.applyGlobalFilter(
      where,
      params,
      await this.globalFilterWhere(args.skipGlobalFilters, args.timeout),
      alias,
    );
    const filter = where ? ` filter ${where}` : '';
    const order = this.buildOrder(args.orderBy, params, alias);
    const limit = this.effectiveLimit(args);
    this.assertPagination(limit, args.offset, 'findMany');
    // Once per table per process, as on the SQL engines: a transaction builds
    // its own interfaces, so a per-interface flag repeated it in each one.
    if (limit === undefined && this.warnOnUnlimited && shouldWarnOnce(WARN_NS.unlimitedFindMany, this.table)) {
      logTo(this.logger, 'warn', `findMany on "${this.table}" has no limit: this scans the whole table.`, {
        code: 'unlimited-find-many',
        table: this.table,
        operation: 'findMany',
      });
    }
    const limitClause = limit !== undefined ? ` limit ${this.param(limit, params)}` : '';
    const offsetClause = args.offset ? ` offset ${this.param(args.offset, params)}` : '';
    let projection: string;
    if (nest) {
      // Aliased scan: every parent column keys itself (`col: t0.col`) so the
      // result columns keep their bare snake names, then the nested blocks.
      const aliasCtr = { n: 1 };
      const parts = cols.map((c) => `${quotePowqlIdent(c)}: t0.${quotePowqlIdent(c)}`);
      for (const plan of nestedPlans) {
        parts.push(await this.buildNestedBlock(plan, 't0', aliasCtr, params, args.timeout, args.skipGlobalFilters));
      }
      // Scalar link-path hops (flat native-typed fields; never a JSON block).
      for (const plan of linkPlans) parts.push(...this.linkPathFields(plan, 't0'));
      projection = `{ ${parts.join(', ')} }`;
    } else {
      projection = this.projection(cols);
    }
    const powql = `${this.qt}${nest ? ' as t0' : ''}${filter}${order}${limitClause}${offsetClause} ${projection}`;
    return { powql, resolvedWhere, nestedPlans, linkPlans, residualWith, forcedPk };
  }

  /** Build + run the findMany select; returns raw rows, the serving wire, the resolved where, and the `with` partition. */
  private async runFind(
    args: FindManyArgs<T>,
    action = 'findMany',
  ): Promise<{
    rows: Record<string, unknown>[];
    native: boolean;
    resolvedWhere: WhereClause<T> | undefined;
    nestedPlans: NestedRelationPlan[];
    linkPlans: LinkPathPlan[];
    residualWith: Record<string, unknown> | undefined;
    forcedPk: string[];
  }> {
    const params: unknown[] = [];
    const { powql, resolvedWhere, nestedPlans, linkPlans, residualWith, forcedPk } = await this.buildFind(args, params);
    const { rows, native } = await this.exec(powql, params, args.timeout, action);
    return { rows, native, resolvedWhere, nestedPlans, linkPlans, residualWith, forcedPk };
  }

  /**
   * Diagnostic surface: compile the same PowQL {@link findMany} would run for
   * `args` (no cache) and return the engine's plan as one string per line.
   *
   * Runs as a READ (`explain <query>`), so it is safe on a read-only pool and
   * eligible for the stale-read replay. The line content is engine-owned and is
   * NOT covered by semver (match plan node names / tree shape, never exact
   * bytes; mirrors PowDB's own `explain` contract).
   *
   * Does NOT run through the middleware chain: plan text is a diagnostic, not
   * entity rows, and `QueryInterface.explain` deliberately bypasses middleware
   * too, so both engines agree.
   */
  async explain(args: FindManyArgs<T> = {} as FindManyArgs<T>): Promise<string[]> {
    // `explain` must compile the statement `findMany` would run, so it
    // normalizes the same args the same way. Without this, explaining a query
    // written with `take` / `skip` would report a plan for a DIFFERENT
    // statement than the one that executes, which is the one thing a
    // diagnostic must not do.
    args = this.completePageOrder(this.normalizeArgs(args));
    const params: unknown[] = [];
    const { powql } = await this.buildFind(args, params);
    const { rows } = await this.exec(`explain ${powql}`, params, args.timeout, 'explain');
    return rows
      .map((r) => {
        const line = r.plan ?? Object.values(r)[0];
        return line == null ? '' : String(line);
      })
      .filter((line) => line.length > 0);
  }

  findUnique<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
    W extends TypedWithClause = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args: FindUniqueArgs<T, NoRelations, W, S, O>): Promise<QueryResult<T, NoRelations, W, S, O> | null>;
  async findUnique(args: FindUniqueArgs<T>): Promise<T | null> {
    this.assertNoForceCustomPlan(args);
    this.assertNoRowLock(args);
    this.assertNoJsonEncoding(args);
    args = this.normalizeArgs(args);
    // Prisma compound-unique selector → column conjunction (engine parity with
    // the SQL findUnique family; pure metadata, so this is a one-line adoption).
    if (args.where) {
      const expanded = expandCompoundUniqueWhere(this.meta, args.where as Record<string, unknown>);
      if (expanded !== args.where) args = { ...args, where: expanded as FindUniqueArgs<T>['where'] };
    }
    // AFTER the selector expansion, so a compound selector counts as the key it
    // is. Same rule and same message as the SQL engines: a `where` that matches
    // many rows plus `limit 1` returns an arbitrary one of them, and PowDB has
    // no more of an ordering guarantee there than Postgres does.
    this.assertIdentifiesOneRow(args.where as Record<string, unknown> | undefined);
    return this.withMiddleware('findUnique', args as unknown as Record<string, unknown>, async () => {
      const { rows, native, nestedPlans, linkPlans, residualWith, forcedPk } = await this.runFind(
        { ...args, limit: 1 } as FindManyArgs<T>,
        'findUnique',
      );
      if (!rows.length) return null;
      const entities = this.shape(rows, native);
      if (nestedPlans.length) this.attachNestedRows(entities, nestedPlans);
      if (linkPlans.length) this.attachLinkRows(entities, linkPlans, native);
      if (residualWith)
        await this.loadRelations(
          entities,
          residualWith,
          args.timeout,
          0,
          undefined,
          resolveUnsafeFlag(args.includePii, 'includePii'),
          args.skipGlobalFilters,
        );
      // See findMany: the strip is last, after every consumer of the key.
      this.stripForcedPk(entities, forcedPk);
      return entities[0]!;
    });
  }

  findFirst<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
    W extends TypedWithClause = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args?: FindManyArgs<T, NoRelations, W, S, O>): Promise<QueryResult<T, NoRelations, W, S, O> | null>;
  async findFirst(args: FindManyArgs<T> = {} as FindManyArgs<T>): Promise<T | null> {
    args = this.normalizeArgs(args, 'findFirst');
    this.assertNoForceCustomPlan(args);
    this.assertNoRowLock(args);
    return this.withMiddleware('findFirst', args as unknown as Record<string, unknown>, async () => {
      // An `offset` makes this a page of one, which gets the page tiebreaker
      // (the row would otherwise depend on which tied rows were skipped).
      const first = { ...args, limit: 1 } as FindManyArgs<T>;
      const { rows, native, nestedPlans, linkPlans, residualWith, forcedPk } = await this.runFind(
        args.offset === undefined ? first : this.completePageOrder(first),
        'findFirst',
      );
      if (!rows.length) return null;
      const entities = this.shape(rows, native);
      if (nestedPlans.length) this.attachNestedRows(entities, nestedPlans);
      if (linkPlans.length) this.attachLinkRows(entities, linkPlans, native);
      if (residualWith)
        await this.loadRelations(
          entities,
          residualWith,
          args.timeout,
          0,
          undefined,
          resolveUnsafeFlag(args.includePii, 'includePii'),
          args.skipGlobalFilters,
        );
      // See findMany: the strip is last, after every consumer of the key.
      this.stripForcedPk(entities, forcedPk);
      return entities[0]!;
    });
  }

  findUniqueOrThrow<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
    W extends TypedWithClause = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args: FindUniqueArgs<T, NoRelations, W, S, O>): Promise<QueryResult<T, NoRelations, W, S, O>>;
  async findUniqueOrThrow(args: FindUniqueArgs<T>): Promise<T> {
    const row = await this.findUnique(args);
    if (!row) throw new NotFoundError({ table: this.table, where: args.where as Record<string, unknown> });
    return row;
  }

  findFirstOrThrow<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
    W extends TypedWithClause = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args?: FindManyArgs<T, NoRelations, W, S, O>): Promise<QueryResult<T, NoRelations, W, S, O>>;
  async findFirstOrThrow(args: FindManyArgs<T> = {} as FindManyArgs<T>): Promise<T> {
    args = this.normalizeArgs(args, 'findFirstOrThrow');
    const row = await this.findFirst(args);
    if (!row) throw new NotFoundError({ table: this.table, where: (args.where ?? {}) as Record<string, unknown> });
    return row;
  }

  // -------------------------------------------------------------------------
  // Nested relations, batched N+1 loaders (hasMany / hasOne / belongsTo)
  // -------------------------------------------------------------------------

  /**
   * Load each requested relation for `parents` and attach it onto each row.
   *
   * `parent` is supplied ONLY by the top-level {@link findMany} (its args +
   * resolved where). When the effective `relationLoadStrategy` resolves to an
   * explicit `'join'` and the pool advertises `serverJoins`, an eligible
   * top-level relation is loaded with a native PowQL join instead of the keyed
   * loaders (F2); everything else (nested `with` levels, ineligible shapes, and
   * the default `'batched'` strategy) keeps the loaders. Output is byte-equal
   * either way (the join reuses the same stitch / shape helpers).
   */
  private async loadRelations(
    parents: T[],
    withClause: Record<string, unknown>,
    timeout?: number,
    depth = 0,
    parent?: PowqlParentContext<T>,
    includePii = false,
    skip?: unknown,
  ): Promise<void> {
    if (depth >= 10) {
      throw new ValidationError(`Nested 'with' on PowDB exceeded depth 10 (relation cycle?).`);
    }
    // Every relation name and the `_count` spec are checked BEFORE the
    // zero-parent return, so whether a `with` is accepted never depends on
    // whether the base query found rows: the SQL engines compile it either way.
    // Same errors as the SQL engines: E005 for an unknown relation (and for a
    // `_count` below the top level), E003 for a `_count` naming a to-one.
    const countSpec = withClause._count as WithCount | undefined;
    if (countSpec) {
      if (depth > 0) {
        throw new RelationError(
          `Unknown relation "_count" on table "${this.table}". ` +
            `${availableClause(Object.keys(this.meta.relations), 'It has no relations.')} ` +
            '(`_count` is supported on the top-level `with` only, on every relationLoadStrategy.)',
        );
      }
      resolveCountRelations(this.meta, countSpec);
    }
    for (const [relName, opt] of Object.entries(withClause)) {
      if (opt && relName !== '_count' && !ownLookup(this.meta.relations, relName)) {
        throw new RelationError(
          `Unknown relation "${relName}" on table "${this.table}". ` +
            availableClause(Object.keys(this.meta.relations), 'It has no relations.'),
        );
      }
    }
    if (!parents.length) return;
    // The resolved strategy is 'join' only for an EXPLICIT 'join' (per-query arg
    // or a client config the user set). The serverJoins capability is consulted
    // PER RELATION below, AFTER joinEligible, so a relation that would have
    // fallen back to the loaders anyway (paged parent, nested `with`, composite
    // key, …) never triggers the capability's E017.
    const strategyIsJoin = parent ? this.resolveStrategy(parent.args) === 'join' : false;
    for (const [relName, opt] of Object.entries(withClause)) {
      if (!opt || relName === '_count') continue;
      const rel = ownLookup(this.meta.relations, relName)!;
      if (strategyIsJoin && parent && this.joinEligible(rel, opt, parent.args)) {
        if (this.capabilities.serverJoins) {
          await this.loadRelationViaJoin(parents, rel, relName, opt, parent, timeout, includePii, skip);
          continue;
        }
        // An otherwise-eligible relation the engine cannot join: a PER-QUERY
        // `relationLoadStrategy: 'join'` is an explicit request, so throw a typed
        // E017; a CLIENT-LEVEL default silently falls back to the keyed loaders
        // (so pointing an existing app at an older engine keeps working).
        if (parent.args.relationLoadStrategy === 'join') {
          requireCapability(this.capabilities, 'serverJoins', 'native PowQL relation joins');
        }
      }
      if (rel.type === 'manyToMany') {
        await this.loadManyToMany(parents, rel, relName, opt, timeout, includePii, skip);
        continue;
      }
      const fk = normalizeKeyColumns(rel.foreignKey);
      const rk = normalizeKeyColumns(rel.referenceKey);
      if (fk.length > 1 || rk.length > 1) {
        throw new UnsupportedFeatureError('composite-key nested reads', 'PowDB', `relation "${relName}"`);
      }
      const options = (opt === true ? {} : opt) as FindManyArgs<object> & { with?: Record<string, unknown> };
      // The relation's own page, applied PER PARENT at stitch time (see pageOf),
      // never on the flat fetch below.
      const relLimit = options.limit;
      const relOffset = options.offset;
      this.assertPagination(relLimit, relOffset, `relation "${relName}"`);
      const single = rel.type === 'belongsTo' || rel.type === 'hasOne';
      if (relLimit === 0) {
        // `[]` on every parent by construction: nothing to fetch.
        for (const parent of parents) (parent as Record<string, unknown>)[relName] = single ? null : [];
        continue;
      }
      const targetQi = new PowqlInterface(this.pool, rel.to, this.schema, [], this.loaderChildOptions());
      const targetMeta = this.schema.tables[rel.to]!;

      // Local key on the parent, remote key on the target child.
      const parentKeyCol = rel.type === 'belongsTo' ? fk[0]! : rk[0]!;
      const childKeyCol = rel.type === 'belongsTo' ? rk[0]! : fk[0]!;
      const parentKeyField = this.meta.reverseColumnMap[parentKeyCol] ?? parentKeyCol;
      const childKeyField = targetMeta.reverseColumnMap[childKeyCol] ?? childKeyCol;

      const keys = [
        ...new Set(parents.map((p) => (p as Record<string, unknown>)[parentKeyField]).filter((k) => k != null)),
      ];
      // The loader buckets children by their correlation column, so that column
      // MUST be in the fetched projection even when the user's select/omit drops
      // it. Force it into the fetch here and strip it back off the entities after
      // stitching (the join path already gets this for free via `__tpk`).
      const userSelect = options.select as Record<string, boolean> | undefined;
      const userOmit = options.omit as Record<string, boolean> | undefined;
      // The RAW shape rules, before the force-add below: the forced key makes
      // an all-falsy select look populated to the child's projectionPlan,
      // which would accept here what the nested-projection path refuses. Same
      // messages as the SQL engines' assertProjectionShape, same reason.
      if (userSelect) {
        if (!Object.values(userSelect).some(Boolean)) {
          throw new ValidationError(selectNamesNothingMessage(targetMeta.name));
        }
        if (userOmit && Object.values(userOmit).some(Boolean)) {
          throw new ValidationError(selectOmitExclusiveMessage(targetMeta.name));
        }
      }
      const fkProjected = userSelect ? Boolean(userSelect[childKeyField]) : userOmit ? !userOmit[childKeyField] : true;
      let fetchOptions: FindManyArgs<object> = options;
      if (!fkProjected) {
        if (userSelect) {
          fetchOptions = {
            ...options,
            select: markStitchOnly({ ...userSelect, [childKeyField]: true }, [childKeyField]),
          } as unknown as FindManyArgs<object>;
        } else if (userOmit) {
          const omitWithoutFk = { ...userOmit };
          delete omitWithoutFk[childKeyField];
          fetchOptions = { ...options, omit: omitWithoutFk } as unknown as FindManyArgs<object>;
        }
      }
      // Chunk the key set so a single `in (…)` never exceeds PowDB's
      // per-statement param / row limits; merge each chunk's children. Keys are
      // normalized through joinKey (a Date maps to micros, matching the child
      // cell) so a datetime correlation column stitches instead of silently
      // returning [].
      const childByKey = new Map<string, T[]>();
      const chunkSize = this.keyChunkSize(targetMeta, childKeyCol);
      for (let i = 0; i < keys.length; i += chunkSize) {
        const chunk = keys.slice(i, i + chunkSize);
        const childWhere = {
          ...(fetchOptions.where as Record<string, unknown> | undefined),
          [childKeyField]: { in: chunk },
        } as WhereClause<object>;
        const children = (await targetQi.findMany({
          ...fetchOptions,
          // Unbounded: the relation limit/offset are per parent, applied below.
          limit: undefined,
          offset: undefined,
          where: childWhere,
          with: options.with,
          timeout: options.timeout ?? timeout,
          // Re-entering the public findMany, so the opt-in has to be spelled
          // in its PUBLIC form (the sentinel); a plain `true` is refused there.
          includePii: includePii ? UNSAFE : undefined,
          // The query's opt-out reaches the related table, as on the SQL engines;
          // without one the target's own global filter applies inside findMany.
          ...(skip !== undefined ? { skipGlobalFilters: skip } : {}),
        } as FindManyArgs<object>)) as T[];
        for (const child of children) {
          const k = this.joinKey((child as Record<string, unknown>)[childKeyField]);
          if (k == null) continue;
          const bucket = childByKey.get(k);
          if (bucket) bucket.push(child);
          else childByKey.set(k, [child]);
        }
      }
      // Strip the forced correlation column back off if the user excluded it,
      // so the emitted entities match their select/omit exactly.
      if (!fkProjected) {
        for (const bucket of childByKey.values()) {
          for (const child of bucket) delete (child as Record<string, unknown>)[childKeyField];
        }
      }
      for (const parent of parents) {
        const k = this.joinKey((parent as Record<string, unknown>)[parentKeyField]);
        const matches = (k == null ? undefined : childByKey.get(k)) ?? [];
        (parent as Record<string, unknown>)[relName] = single
          ? (matches[0] ?? null)
          : PowqlInterface.pageOf(matches, relLimit, relOffset);
      }
    }
    // Last, so `_count` is the final key on each row, as on the SQL engines.
    if (countSpec) await this.loadRelationCounts(parents, countSpec, timeout, skip);
  }

  /**
   * Refuse a `_count` anywhere below the top-level `with`, as the SQL engines
   * do (E005, their message). Checked over the whole tree before anything runs,
   * because a loader re-enters the child table's public findMany, where a
   * nested `_count` would otherwise read as top level and be counted.
   */
  private assertCountTopLevelOnly(withClause: Record<string, unknown>, depth: number): void {
    if (depth >= 10) return;
    if (depth > 0 && withClause._count) {
      throw new RelationError(
        `Unknown relation "_count" on table "${this.table}". ` +
          `${availableClause(Object.keys(this.meta.relations), 'It has no relations.')} ` +
          '(`_count` is supported on the top-level `with` only, on every relationLoadStrategy.)',
      );
    }
    for (const [relName, opt] of Object.entries(withClause)) {
      if (!opt || opt === true || relName === '_count') continue;
      const nested = (opt as { with?: unknown }).with;
      const rel = ownLookup(this.meta.relations, relName);
      if (!rel || !nested || typeof nested !== 'object' || !this.schema.tables[rel.to]) continue;
      new PowqlInterface(this.pool, rel.to, this.schema, [], this.loaderChildOptions()).assertCountTopLevelOnly(
        nested as Record<string, unknown>,
        depth + 1,
      );
    }
  }

  /**
   * The reserved `with: { _count: ... }` key: one count per selected to-many
   * relation, attached as `_count: { rel: n }` (0 for a parent with no rows),
   * which is the SQL engines' output. The relations are selected by the shared
   * `resolveCountRelations`, so `true` counts every to-many relation and the
   * refusals match. Each count honours the counted table's global filter the
   * way the SQL engines' correlated `COUNT(*)` does: hasMany counts the
   * surviving child rows, manyToMany counts junction rows whose TARGET
   * survives. One grouped query per relation per key chunk.
   */
  private async loadRelationCounts(
    parents: T[],
    countSpec: WithCount,
    timeout: number | undefined,
    skip: unknown,
  ): Promise<void> {
    const rels = resolveCountRelations(this.meta, countSpec);
    const countsOf = new Map<T, Record<string, number>>();
    for (const parent of parents) {
      const counts: Record<string, number> = {};
      for (const rel of rels) counts[rel.name] = 0;
      const row = parent as Record<string, unknown>;
      delete row._count;
      row._count = counts;
      countsOf.set(parent, counts);
    }
    for (const rel of rels) {
      const { parentKeyField, byKey } =
        rel.type === 'manyToMany'
          ? await this.countManyToMany(parents, rel, timeout, skip)
          : await this.countHasMany(parents, rel, timeout, skip);
      for (const parent of parents) {
        const k = this.joinKey((parent as Record<string, unknown>)[parentKeyField]);
        countsOf.get(parent)![rel.name] = (k == null ? undefined : byKey.get(k)) ?? 0;
      }
    }
  }

  /** Child rows per parent key for a hasMany `_count`, through the child's own groupBy. */
  private async countHasMany(
    parents: T[],
    rel: RelationDef,
    timeout: number | undefined,
    skip: unknown,
  ): Promise<{ parentKeyField: string; byKey: Map<string, number> }> {
    const fk = normalizeKeyColumns(rel.foreignKey);
    const rk = normalizeKeyColumns(rel.referenceKey);
    if (fk.length > 1 || rk.length > 1) {
      throw new UnsupportedFeatureError('composite-key relation _count', 'PowDB', `relation "${rel.name}"`);
    }
    const targetMeta = this.schema.tables[rel.to];
    if (!targetMeta) throw new ValidationError(`Relation "${rel.name}" targets unknown table "${rel.to}".`);
    const parentKeyField = this.meta.reverseColumnMap[rk[0]!] ?? rk[0]!;
    const childKeyField = targetMeta.reverseColumnMap[fk[0]!] ?? fk[0]!;
    const keys = [
      ...new Set(parents.map((p) => (p as Record<string, unknown>)[parentKeyField]).filter((k) => k != null)),
    ];
    const byKey = new Map<string, number>();
    const childQi = new PowqlInterface<object>(this.pool, rel.to, this.schema, [], this.loaderChildOptions());
    const chunkSize = this.keyChunkSize(targetMeta, fk[0]!);
    for (let i = 0; i < keys.length; i += chunkSize) {
      const groups = (await childQi.groupBy({
        by: [childKeyField],
        where: { [childKeyField]: { in: keys.slice(i, i + chunkSize) } },
        _count: true,
        timeout,
        // The key is only a stitch key and never returned, so a PII-tagged
        // foreign key does not make the count a PII read.
        includePii: UNSAFE,
        ...(skip !== undefined ? { skipGlobalFilters: skip } : {}),
      } as unknown as GroupByArgs<object>)) as Record<string, unknown>[];
      for (const g of groups) {
        const k = this.joinKey(g[childKeyField]);
        if (k != null) byKey.set(k, Number(g._count ?? 0));
      }
    }
    return { parentKeyField, byKey };
  }

  /**
   * Junction rows per parent key for a manyToMany `_count`. When the target
   * table has a global filter in force, only junction rows whose target row
   * survives it are counted, as the SQL engines' `EXISTS` on the target does.
   */
  private async countManyToMany(
    parents: T[],
    rel: RelationDef,
    timeout: number | undefined,
    skip: unknown,
  ): Promise<{ parentKeyField: string; byKey: Map<string, number> }> {
    const through = rel.through;
    if (!through) throw new ValidationError(`manyToMany relation "${rel.name}" is missing its junction (\`through\`).`);
    const sourceJ = normalizeKeyColumns(through.sourceKey);
    const targetJ = normalizeKeyColumns(through.targetKey);
    const sourceRef = normalizeKeyColumns(rel.referenceKey);
    const targetMeta = this.schema.tables[rel.to];
    if (!targetMeta) throw new ValidationError(`Relation "${rel.name}" targets unknown table "${rel.to}".`);
    if (sourceJ.length > 1 || targetJ.length > 1 || sourceRef.length > 1 || targetMeta.primaryKey.length > 1) {
      throw new UnsupportedFeatureError('composite-key relation _count', 'PowDB', `relation "${rel.name}"`);
    }
    const parentKeyField = this.meta.reverseColumnMap[sourceRef[0]!] ?? sourceRef[0]!;
    const keys = [
      ...new Set(parents.map((p) => (p as Record<string, unknown>)[parentKeyField]).filter((k) => k != null)),
    ];
    // (1) Junction rows for these parents.
    const junctionMeta = this.schema.tables[through.table];
    const sourceJColMeta = junctionMeta?.columns.find((c) => c.name === sourceJ[0]);
    const pairs: [string, string, unknown][] = [];
    const chunkSize = this.keyChunkSize(junctionMeta, sourceJ[0]!);
    for (let i = 0; i < keys.length; i += chunkSize) {
      const params: unknown[] = [];
      const keyClause = this.inClause(
        this.colRefName(sourceJ[0]!),
        keys.slice(i, i + chunkSize),
        params,
        sourceJColMeta,
      );
      const powql =
        `${quotePowqlIdent(through.table)} filter ${keyClause} ` +
        `{ ${this.colRefName(sourceJ[0]!)}, ${this.colRefName(targetJ[0]!)} }`;
      const { rows } = await this.exec(powql, params, timeout, 'findMany');
      for (const row of rows) {
        const sk = this.joinKey(row[sourceJ[0]!]);
        const tk = this.joinKey(row[targetJ[0]!]);
        if (sk != null && tk != null) pairs.push([sk, tk, row[targetJ[0]!]]);
      }
    }
    // (2) With a target global filter in force, keep the targets that survive it.
    const gf = resolveGlobalFilterFrom(
      this.options.globalFilters,
      rel.to,
      resolveSkipGlobalFilters(skip),
      this.schema.tables,
    );
    let surviving: Set<string> | null = null;
    if (gf && pairs.length) {
      surviving = new Set();
      const pkCol = targetMeta.primaryKey[0]!;
      const pkField = targetMeta.reverseColumnMap[pkCol] ?? pkCol;
      const targetQi = new PowqlInterface<object>(this.pool, rel.to, this.schema, [], this.loaderChildOptions());
      const targets = [...new Map(pairs.map(([, tk, raw]) => [tk, raw])).values()];
      const targetChunk = this.keyChunkSize(targetMeta, pkCol);
      for (let i = 0; i < targets.length; i += targetChunk) {
        const rows = (await targetQi.findMany({
          where: { [pkField]: { in: targets.slice(i, i + targetChunk) } },
          select: { [pkField]: true },
          timeout,
          includePii: UNSAFE,
          ...(skip !== undefined ? { skipGlobalFilters: skip } : {}),
        } as unknown as FindManyArgs<object>)) as Record<string, unknown>[];
        for (const row of rows) {
          const k = this.joinKey(row[pkField]);
          if (k != null) surviving.add(k);
        }
      }
    }
    const byKey = new Map<string, number>();
    for (const [sk, tk] of pairs) {
      if (surviving && !surviving.has(tk)) continue;
      byKey.set(sk, (byKey.get(sk) ?? 0) + 1);
    }
    return { parentKeyField, byKey };
  }

  /**
   * manyToMany nested read, a three-hop batched loader (no `json_agg`/join
   * pushdown): (1) read the junction rows for all parents in `sourceKey in (…)`
   * chunks, (2) read the target rows for the collected `targetKey`s, (3) stitch
   * each parent → its junction rows → its targets in memory. Mirrors the
   * single-key N+1 loaders; the junction's source/target columns must be single
   * (composite junction keys would need PowQL tuple-`in`, which it lacks).
   */
  private async loadManyToMany(
    parents: T[],
    rel: RelationDef,
    relName: string,
    opt: unknown,
    timeout?: number,
    includePii = false,
    skip?: unknown,
  ): Promise<void> {
    const through = rel.through;
    if (!through) throw new ValidationError(`manyToMany relation "${relName}" is missing its junction (\`through\`).`);
    const sourceJ = normalizeKeyColumns(through.sourceKey);
    const targetJ = normalizeKeyColumns(through.targetKey);
    const sourceRef = normalizeKeyColumns(rel.referenceKey);
    const targetMeta = this.schema.tables[rel.to];
    if (!targetMeta) throw new ValidationError(`Relation "${relName}" targets unknown table "${rel.to}".`);
    if (sourceJ.length > 1 || targetJ.length > 1 || sourceRef.length > 1 || targetMeta.primaryKey.length > 1) {
      throw new UnsupportedFeatureError(
        'composite-key manyToMany',
        'PowDB',
        `relation "${relName}", PowQL has no tuple-\`in\`, so composite junction/target keys can't be loaded`,
      );
    }
    const sourceJCol = sourceJ[0]!;
    const targetJCol = targetJ[0]!;
    const sourceRefCol = sourceRef[0]!;
    const targetPkCol = targetMeta.primaryKey[0]!;
    const parentRefField = this.meta.reverseColumnMap[sourceRefCol] ?? sourceRefCol;
    const targetPkField = targetMeta.reverseColumnMap[targetPkCol] ?? targetPkCol;
    const targetPkColMeta = targetMeta.columns.find((c) => c.name === targetPkCol);

    const parentKeys = [
      ...new Set(parents.map((p) => (p as Record<string, unknown>)[parentRefField]).filter((k) => k != null)),
    ];
    if (!parentKeys.length) {
      for (const parent of parents) (parent as Record<string, unknown>)[relName] = [];
      return;
    }

    // (1) Junction rows: sourceKeyVal(String) → [targetKeyVal(String)].
    const junctionMeta = this.schema.tables[through.table];
    const sourceJColMeta = junctionMeta?.columns.find((c) => c.name === sourceJCol);
    const targetsBySource = new Map<string, string[]>();
    const allTargetVals = new Set<string>();
    const junctionChunk = this.keyChunkSize(junctionMeta, sourceJCol);
    for (let i = 0; i < parentKeys.length; i += junctionChunk) {
      const chunk = parentKeys.slice(i, i + junctionChunk);
      const params: unknown[] = [];
      const keyClause = this.inClause(this.colRefName(sourceJCol), chunk, params, sourceJColMeta);
      const powql =
        `${quotePowqlIdent(through.table)} filter ${keyClause} ` +
        `{ ${this.colRefName(sourceJCol)}, ${this.colRefName(targetJCol)} }`;
      const { rows } = await this.exec(powql, params, timeout, 'findMany');
      for (const row of rows) {
        const sv = String(row[sourceJCol]);
        const tv = String(row[targetJCol]);
        const bucket = targetsBySource.get(sv);
        if (bucket) bucket.push(tv);
        else targetsBySource.set(sv, [tv]);
        allTargetVals.add(tv);
      }
    }

    // (2) Target rows by PK, honouring the relation's own where/with/select/…
    const options = (opt === true ? {} : opt) as FindManyArgs<object> & { with?: Record<string, unknown> };
    this.assertPagination(options.limit, options.offset, `relation "${relName}"`);
    if (options.limit === 0) {
      for (const parent of parents) (parent as Record<string, unknown>)[relName] = [];
      return;
    }
    const targetQi = new PowqlInterface(this.pool, rel.to, this.schema, [], this.loaderChildOptions());
    // This loader stitches on the TARGET's own primary key, so the PK has to be
    // in the fetch even when the caller's select/omit excludes it, and has to
    // come back off afterwards. Exactly the shape `loadRelation` uses for its
    // correlation column: force it in here, strip it after stitching. It cannot
    // be left to the projection's internal force-add, because that one is
    // stripped before findMany returns (see projectionPlan) and the map would
    // key every target on "undefined".
    const userSelect = options.select as Record<string, boolean> | undefined;
    const userOmit = options.omit as Record<string, boolean> | undefined;
    // The RAW shape rules, before the force-add: same reason and same messages
    // as `loadRelation`, since a forced key makes an all-falsy select look
    // populated to the child's own projection check.
    if (userSelect) {
      if (!Object.values(userSelect).some(Boolean)) {
        throw new ValidationError(selectNamesNothingMessage(targetMeta.name));
      }
      if (userOmit && Object.values(userOmit).some(Boolean)) {
        throw new ValidationError(selectOmitExclusiveMessage(targetMeta.name));
      }
    }
    const pkProjected = userSelect ? Boolean(userSelect[targetPkField]) : userOmit ? !userOmit[targetPkField] : true;
    let fetchOptions: FindManyArgs<object> & { with?: Record<string, unknown> } = options;
    if (!pkProjected) {
      if (userSelect) {
        fetchOptions = {
          ...options,
          select: markStitchOnly({ ...userSelect, [targetPkField]: true }, [targetPkField]),
        } as unknown as typeof fetchOptions;
      } else if (userOmit) {
        const omitWithoutPk = { ...userOmit };
        delete omitWithoutPk[targetPkField];
        fetchOptions = { ...options, omit: omitWithoutPk } as unknown as typeof fetchOptions;
      }
    }
    const targetByPk = new Map<string, T>();
    // Position of each target in the fetch, i.e. its rank under the relation's
    // `orderBy`; the stitch below sorts a parent's children by it when an
    // orderBy was given, so `limit` keeps that parent's top-N and not its first
    // N junction rows. Across fetch CHUNKS the rank is fetch order.
    const targetRank = new Map<string, number>();
    const targetValList = [...allTargetVals].map((v) =>
      targetPkColMeta ? coerceScalar(v, targetPkColMeta.tsType) : v,
    );
    const targetChunk = this.keyChunkSize(targetMeta, targetPkCol);
    for (let i = 0; i < targetValList.length; i += targetChunk) {
      const chunk = targetValList.slice(i, i + targetChunk);
      const where = {
        ...(options.where as Record<string, unknown> | undefined),
        [targetPkField]: { in: chunk },
      } as WhereClause<object>;
      const targets = (await targetQi.findMany({
        ...fetchOptions,
        // Unbounded: the relation limit/offset are per parent, applied in the stitch.
        limit: undefined,
        offset: undefined,
        where,
        with: options.with,
        timeout: options.timeout ?? timeout,
        // Public findMany, so the sentinel form. See loadRelation above.
        includePii: includePii ? UNSAFE : undefined,
        ...(skip !== undefined ? { skipGlobalFilters: skip } : {}),
      } as FindManyArgs<object>)) as T[];
      for (const t of targets) {
        const pk = String((t as Record<string, unknown>)[targetPkField]);
        targetByPk.set(pk, t);
        if (!targetRank.has(pk)) targetRank.set(pk, targetRank.size);
      }
    }

    // (3) Stitch: each parent → its junction targets (m2m is always a list).
    for (const parent of parents) {
      const sv = String((parent as Record<string, unknown>)[parentRefField]);
      const tvs = targetsBySource.get(sv) ?? [];
      const children: T[] = [];
      for (const tv of tvs) {
        const child = targetByPk.get(tv);
        if (child) children.push(child);
      }
      if (options.orderBy) {
        const rank = (t: T) => targetRank.get(String((t as Record<string, unknown>)[targetPkField])) ?? 0;
        children.sort((a, b) => rank(a) - rank(b));
      }
      (parent as Record<string, unknown>)[relName] = PowqlInterface.pageOf(children, options.limit, options.offset);
    }

    // Stitching is done: take the forced PK back off. Iterating the map rather
    // than the stitched lists is deliberate, one target can be linked from many
    // parents and is the SAME object in each, so this touches each entity once.
    if (!pkProjected) {
      for (const target of targetByPk.values()) delete (target as Record<string, unknown>)[targetPkField];
    }
  }

  // -------------------------------------------------------------------------
  // Nested relations: native PowQL joins (F2, opt-in via relationLoadStrategy)
  // -------------------------------------------------------------------------

  /**
   * Resolve the effective relation-load strategy: the per-query arg wins, then
   * the client config, then the PowDB default of `'batched'` (the keyed
   * loaders). PowDB deliberately does NOT inherit the SQL-side implicit `'join'`
   * default (that would silently flip every existing PowDB user onto brand-new
   * join generation). Only a value the user actually set to `'join'` activates it.
   */
  private resolveStrategy(args: FindManyArgs<T>): 'join' | 'batched' {
    const s = args.relationLoadStrategy ?? this.options.relationLoadStrategy ?? 'batched';
    return s === 'join' ? 'join' : 'batched';
  }

  /**
   * Per-relation eligibility for the join path (checked before the serverJoins
   * capability). Any `false` here is a SILENT fallback to the keyed loaders (it
   * is never an error), so an off-page or nested-`with` shape still returns
   * correct rows:
   *   - the parent query must not be paged (`limit`/`offset`/`take`, including the
   *     configured `defaultLimit`): a parent-filter join under a page would scan
   *     children of off-page parents, where the loaders are strictly better;
   *   - the relation must not request a nested `with` (its subtree stays on the
   *     loaders this round) or a `distinct`;
   *   - single-column relation keys only (a composite key falls to the loader,
   *     which throws the same E017 as today);
   *   - the PARENT-SIDE correlation column must be a single-column PK or unique
   *     column, or the INNER join would re-emit one child copy per matching
   *     parent row (a non-unique correlation key produces duplicate children the
   *     loader never would). For hasMany/hasOne/m2m that column is the relation's
   *     `referenceKey` on THIS (fetched) table; for belongsTo it is the
   *     `referenceKey` on the TARGET table (the join's non-fetched side);
   *   - m2m keeps any `orderBy`/`limit`/`offset` on the loader (the junction-order
   *     stitch can't be reproduced by the 3-table join deterministically);
   *   - a to-one relation `limit`/`offset` (meaningless) stays on the loader. A
   *     to-many relation `limit`/`offset` is a PER-PARENT bound on both paths,
   *     fetched unbounded and sliced per parent at stitch time (`pageOf`), so
   *     the join statement carries neither clause.
   */
  private joinEligible(rel: RelationDef, opt: unknown, args: FindManyArgs<T>): boolean {
    const effLimit = args.limit ?? this.defaultLimit;
    if (effLimit !== undefined || args.offset) return false;
    const options = (opt === true ? {} : opt) as FindManyArgs<object> & { with?: unknown };
    if (options.with) return false;
    if (options.distinct?.length) return false;
    if (rel.type === 'manyToMany') {
      const through = rel.through;
      if (!through) return false;
      if (
        normalizeKeyColumns(through.sourceKey).length > 1 ||
        normalizeKeyColumns(through.targetKey).length > 1 ||
        normalizeKeyColumns(rel.referenceKey).length > 1 ||
        (this.schema.tables[rel.to]?.primaryKey.length ?? 2) > 1
      ) {
        return false;
      }
      if (options.orderBy || options.limit !== undefined || options.offset) return false;
      // The parent joins on its referenceKey; a non-unique one duplicates.
      if (!this.isSingleColumnUnique(this.meta, normalizeKeyColumns(rel.referenceKey)[0]!)) return false;
      return true;
    }
    if (normalizeKeyColumns(rel.foreignKey).length > 1 || normalizeKeyColumns(rel.referenceKey).length > 1) {
      return false;
    }
    // Reject a non-unique correlation key: on belongsTo the fetched side joins on
    // the target's referenceKey, otherwise the fetched side joins on its own.
    if (rel.type === 'belongsTo') {
      const targetMeta = this.schema.tables[rel.to];
      if (!targetMeta || !this.isSingleColumnUnique(targetMeta, normalizeKeyColumns(rel.referenceKey)[0]!)) {
        return false;
      }
    } else if (!this.isSingleColumnUnique(this.meta, normalizeKeyColumns(rel.referenceKey)[0]!)) {
      return false;
    }
    const single = rel.type === 'belongsTo' || rel.type === 'hasOne';
    if ((options.limit !== undefined || options.offset) && single) return false;
    // A `limit 0` relation stays off the join statement for the same reason it
    // stays off a nested projection: PowDB answered `limit 0` with one row below
    // engine 0.20. The loader resolves it client-side, correctly on every version.
    if (options.limit === 0) return false;
    return true;
  }

  /**
   * True when `col` is a single-column unique key of `tableMeta`: the sole
   * primary-key column, a single-column entry in `uniqueColumns` (where a
   * per-column `unique: true` and an introspected single-column unique constraint
   * both land), or a single-column unique index. Used by {@link joinEligible} to
   * keep the INNER-join path off relations whose parent-side correlation column
   * can repeat (which would duplicate children).
   */
  private isSingleColumnUnique(tableMeta: TableMetadata, col: string): boolean {
    if (tableMeta.primaryKey.length === 1 && tableMeta.primaryKey[0] === col) return true;
    if (tableMeta.uniqueColumns.some((cols) => cols.length === 1 && cols[0] === col)) return true;
    return tableMeta.indexes.some(
      (idx) => idx.unique && !idx.docPath && idx.columns.length === 1 && idx.columns[0] === col,
    );
  }

  /** Dispatch one eligible relation to the correct native-join loader. */
  private async loadRelationViaJoin(
    parents: T[],
    rel: RelationDef,
    relName: string,
    opt: unknown,
    parent: PowqlParentContext<T>,
    timeout?: number,
    includePii = false,
    skip?: unknown,
  ): Promise<void> {
    if (rel.type === 'manyToMany') {
      await this.loadManyToManyViaJoin(parents, rel, relName, opt, parent, timeout, includePii, skip);
      return;
    }
    const options = (opt === true ? {} : opt) as FindManyArgs<object>;
    const targetMeta = this.schema.tables[rel.to];
    if (!targetMeta) throw new ValidationError(`Relation "${relName}" targets unknown table "${rel.to}".`);
    const targetQi = new PowqlInterface<object>(this.pool, rel.to, this.schema, [], this.options);
    const fk = normalizeKeyColumns(rel.foreignKey);
    const rk = normalizeKeyColumns(rel.referenceKey);
    // Correlation math is identical to the keyed loaders, only the transport
    // (join vs in-list) changes. Always join the RELATION TARGET (alias `c`) to
    // the already-fetched side (alias `p`), correlating on the fetched side's key
    // and projecting `__tpk` from the fetched side's correlation column.
    const parentKeyCol = rel.type === 'belongsTo' ? fk[0]! : rk[0]!;
    const childKeyCol = rel.type === 'belongsTo' ? rk[0]! : fk[0]!;
    const parentKeyField = this.meta.reverseColumnMap[parentKeyCol] ?? parentKeyCol;

    const params: unknown[] = [];
    const { cols: childCols, forcedPk: childForcedPk } = this.joinChildCols(targetQi, options, includePii);
    const filter = await this.joinFilter(
      targetQi,
      parent.resolvedWhere,
      options.where,
      'c',
      params,
      options.timeout ?? timeout,
      skip,
    );
    const order = targetQi.buildOrder(options.orderBy, params, 'c');
    // No limit/offset clause: on the join they would bound the TOTAL child
    // count across every parent. The relation's page is per parent (pageOf).
    this.assertPagination(options.limit, options.offset, `relation "${relName}"`);
    const proj = this.joinProjection(childCols, `p.${quotePowqlIdent(parentKeyCol)}`, 'c');
    const powql =
      `${targetQi.qt} as c join ${this.qt} as p ` +
      `on c.${quotePowqlIdent(childKeyCol)} = p.${quotePowqlIdent(parentKeyCol)}` +
      `${filter}${order} ${proj}`;
    // A READ: thread a read-shaped action through the exec seam.
    const { rows, native } = await targetQi.exec(powql, params, timeout, 'findMany');

    const single = rel.type === 'belongsTo' || rel.type === 'hasOne';
    const byKey = this.bucketByTpk(targetQi, rows, native, childForcedPk);
    for (const p of parents) {
      const key = this.joinKey((p as Record<string, unknown>)[parentKeyField]);
      const matches = (key == null ? undefined : byKey.get(key)) ?? [];
      (p as Record<string, unknown>)[relName] = single
        ? (matches[0] ?? null)
        : PowqlInterface.pageOf(matches, options.limit, options.offset);
    }
  }

  /**
   * manyToMany via chained joins: the target (alias `t`) → junction (alias `j`)
   * → the already-fetched side (alias `p`), correlating `__tpk` from the
   * junction's source key. Always a list, stitched exactly like the loader.
   */
  private async loadManyToManyViaJoin(
    parents: T[],
    rel: RelationDef,
    relName: string,
    opt: unknown,
    parent: PowqlParentContext<T>,
    timeout?: number,
    includePii = false,
    skip?: unknown,
  ): Promise<void> {
    const through = rel.through;
    if (!through) throw new ValidationError(`manyToMany relation "${relName}" is missing its junction (\`through\`).`);
    const options = (opt === true ? {} : opt) as FindManyArgs<object>;
    const targetMeta = this.schema.tables[rel.to];
    if (!targetMeta) throw new ValidationError(`Relation "${relName}" targets unknown table "${rel.to}".`);
    const targetQi = new PowqlInterface<object>(this.pool, rel.to, this.schema, [], this.options);
    const sourceJCol = normalizeKeyColumns(through.sourceKey)[0]!;
    const targetJCol = normalizeKeyColumns(through.targetKey)[0]!;
    const sourceRefCol = normalizeKeyColumns(rel.referenceKey)[0]!;
    const targetPkCol = targetMeta.primaryKey[0]!;
    const parentRefField = this.meta.reverseColumnMap[sourceRefCol] ?? sourceRefCol;

    const params: unknown[] = [];
    const { cols: childCols, forcedPk: childForcedPk } = this.joinChildCols(targetQi, options, includePii);
    const filter = await this.joinFilter(
      targetQi,
      parent.resolvedWhere,
      options.where,
      't',
      params,
      options.timeout ?? timeout,
      skip,
    );
    const proj = this.joinProjection(childCols, `j.${quotePowqlIdent(sourceJCol)}`, 't');
    const powql =
      `${targetQi.qt} as t ` +
      `join ${quotePowqlIdent(through.table)} as j on t.${quotePowqlIdent(targetPkCol)} = j.${quotePowqlIdent(targetJCol)} ` +
      `join ${this.qt} as p on j.${quotePowqlIdent(sourceJCol)} = p.${quotePowqlIdent(sourceRefCol)}` +
      `${filter} ${proj}`;
    const { rows, native } = await targetQi.exec(powql, params, timeout, 'findMany');

    const byKey = this.bucketByTpk(targetQi, rows, native, childForcedPk);
    for (const p of parents) {
      const key = this.joinKey((p as Record<string, unknown>)[parentRefField]);
      (p as Record<string, unknown>)[relName] = (key == null ? undefined : byKey.get(key)) ?? [];
    }
  }

  /**
   * The target column list to project through the join (honouring select/omit),
   * with a loud guard: a real column named `__tpk` would collide with the
   * reserved correlation alias, so refuse rather than silently mis-stitch.
   */
  private joinChildCols(
    targetQi: PowqlInterface<object>,
    options: FindManyArgs<object>,
    includePii = false,
  ): { cols: string[]; forcedPk: string[] } {
    const plan = targetQi.projectionPlan(
      options.select as Record<string, boolean> | undefined,
      options.omit as Record<string, boolean> | undefined,
      includePii,
    );
    if (plan.cols.includes('__tpk')) {
      throw new ValidationError(
        `relation target "${targetQi.table}" has a column named "__tpk", which collides with the reserved ` +
          `join correlation alias. Rename the column or load this relation with relationLoadStrategy: 'batched'.`,
      );
    }
    return plan;
  }

  /**
   * `{ __tpk: <tpkExpr>, <col>: <childAlias>.<col>, … }`. Each child column is
   * ALIASED to its bare name (a bare qualified ref `c.col` would come back named
   * `c.col`, not `col`) so the stitched rows shape identically to a flat select.
   */
  private joinProjection(childCols: string[], tpkExpr: string, childAlias: string): string {
    const parts = [
      `__tpk: ${tpkExpr}`,
      ...childCols.map((c) => `${quotePowqlIdent(c)}: ${childAlias}.${quotePowqlIdent(c)}`),
    ];
    return `{ ${parts.join(', ')} }`;
  }

  /**
   * `filter <parentWhere qualified p> [and <relationWhere qualified childAlias>]`.
   * The parent where is the ALREADY-RESOLVED predicate (relation filters collapsed
   * to literal in-lists before the base query ran); the relation where is resolved
   * on the target the same way before qualifying, so a nested relation filter in
   * the relation `where` never reaches the join unresolved. Params bind in order.
   * Each side carries its own table's global filter under the query's `skip`,
   * so the join returns exactly the rows the loaders would.
   */
  private async joinFilter(
    targetQi: PowqlInterface<object>,
    parentResolvedWhere: WhereClause<T> | undefined,
    relWhere: WhereClause<object> | undefined,
    childAlias: string,
    params: unknown[],
    timeout?: number,
    skip?: unknown,
  ): Promise<string> {
    const parts: string[] = [];
    const parentGf = await this.globalFilterWhere(skip, timeout);
    const pw = this.applyGlobalFilter(this.buildWhere(parentResolvedWhere, params, 'p'), params, parentGf, 'p');
    if (pw) parts.push(pw);
    const relResolved = await targetQi.resolveRelationFilters(relWhere, timeout, skip);
    const targetGf = await targetQi.globalFilterWhere(skip, timeout);
    const rw = targetQi.applyGlobalFilter(
      targetQi.buildWhere(relResolved, params, childAlias),
      params,
      targetGf,
      childAlias,
    );
    if (rw) parts.push(rw);
    return parts.length ? ` filter ${parts.join(' and ')}` : '';
  }

  /** Group join rows by their (normalized) `__tpk`, stripping it and shaping each child. */
  private bucketByTpk(
    targetQi: PowqlInterface<object>,
    rows: Record<string, unknown>[],
    native: boolean,
    forcedPk: string[] = [],
  ): Map<string, object[]> {
    const byKey = new Map<string, object[]>();
    for (const raw of rows) {
      const tpk = this.joinKey(raw.__tpk);
      delete raw.__tpk;
      const child = targetQi.shape([raw], native)[0]!;
      // The correlation runs on `__tpk` (the PARENT's key), so an internally
      // forced child PK has no consumer past this point and comes straight off.
      targetQi.stripForcedPk([child], forcedPk);
      if (tpk == null) continue;
      const bucket = byKey.get(tpk);
      if (bucket) bucket.push(child);
      else byKey.set(tpk, [child]);
    }
    return byKey;
  }

  /**
   * Normalize a correlation key to a stable string map key so a parent's key
   * value (a shaped entity field) and a child row's `__tpk` cell match across
   * wires and column types. A `Date` maps to microseconds
   * (`getTime()` ms times 1000), because a datetime correlation cell arrives as
   * raw micros (bigint on the native wire, a micros string on the legacy wire),
   * never as ms. bigint / number / string all stringify to the same digits, so
   * an int key matches whether it came back typed or as text.
   */
  private joinKey(v: unknown): string | null {
    if (v == null) return null;
    if (v instanceof Date) return (BigInt(v.getTime()) * 1000n).toString();
    if (typeof v === 'bigint') return v.toString();
    return String(v);
  }

  // -------------------------------------------------------------------------
  // Nested relations: nested projections / shaped results (PowDB >= 0.18)
  // -------------------------------------------------------------------------

  /**
   * Should this query's `with` compile to nested-projection blocks? Requires
   * the engine capability (>= 0.18), and an EXPLICIT `relationLoadStrategy:
   * 'batched'` (per-query or client-level) opts back out to the keyed loaders.
   * The default and `'join'` both prefer nesting: unlike the F2 INNER join it
   * has no fan-out, keeps childless parents, works under parent paging, and
   * applies per-parent `order`/`limit`/`offset` natively, so it is the
   * strictly-better single-statement path wherever it is eligible. Ineligible
   * relations fall through to the existing strategy resolution untouched.
   */
  private nestedProjectionsPreferred(args: FindManyArgs<T>): boolean {
    if (!this.capabilities.nestedProjections) return false;
    const explicit = args.relationLoadStrategy ?? this.options.relationLoadStrategy;
    return explicit !== 'batched';
  }

  /**
   * Plan one `with` relation as a nested-projection block, or return `null`
   * when the shape must stay on the loaders (ALWAYS a silent fallback with
   * identical output, never an error):
   *   - m2m (the block takes exactly one child table; the junction-order
   *     stitch has no nested equivalent), and composite relation keys;
   *   - a to-one relation carrying `limit`/`offset` (the loaders' semantics);
   *   - a relation `limit` of exactly 0 (a nested block would emit `limit 0`,
   *     which PowDB's projection fast path answered with ONE row below engine
   *     0.20; the loader path resolves it client-side and is correct on every
   *     version). A NEGATIVE relation limit is refused outright, not fallen back;
   *   - `distinct` inside the relation options (no nested grammar for it);
   *   - a projected child column whose tsType is `bigint` or `Uint8Array`
   *     (values ride a JSON array, which cannot carry them losslessly);
   *   - a projection key collision (a child column named like a sub-relation);
   *   - depth >= 10 (the loader path enforces the same cap by throwing, so the
   *     fallback surfaces the identical E003 today's users get);
   *   - any ineligible descendant (the WHOLE relation falls back, so one
   *     statement never mixes nested and loader semantics mid-subtree).
   */
  private planNestedRelation(
    relName: string,
    rel: RelationDef,
    opt: unknown,
    includePii: boolean,
    depth = 0,
  ): NestedRelationPlan | null {
    if (depth >= 10) return null;
    if (rel.type === 'manyToMany') return null;
    if (normalizeKeyColumns(rel.foreignKey).length > 1 || normalizeKeyColumns(rel.referenceKey).length > 1) {
      return null;
    }
    if (!this.schema.tables[rel.to]) return null; // the loader raises its own error
    const options = (opt === true ? {} : opt) as FindManyArgs<object> & { with?: Record<string, unknown> };
    if (options.distinct?.length) return null;
    const single = rel.type === 'belongsTo' || rel.type === 'hasOne';
    if (single && (options.limit !== undefined || options.offset)) return null;
    this.assertPagination(options.limit, options.offset, `relation "${relName}"`);
    if (options.limit === 0) return null;
    const targetQi = new PowqlInterface<object>(this.pool, rel.to, this.schema, [], this.options);
    const { cols, forcedPk } = targetQi.projectionPlan(
      options.select as Record<string, boolean> | undefined,
      options.omit as Record<string, boolean> | undefined,
      includePii,
    );
    const byName = new Map(targetQi.meta.columns.map((c) => [c.name, c]));
    for (const c of cols) {
      const ts = baseTsType(byName.get(c)?.tsType ?? '');
      if (ts === 'bigint' || ts === 'Uint8Array') return null;
    }
    const children: NestedRelationPlan[] = [];
    if (options.with) {
      for (const [subName, subOpt] of Object.entries(options.with)) {
        if (!subOpt) continue;
        const subRel = targetQi.meta.relations[subName];
        if (!subRel) return null; // let the loader raise its unknown-relation error
        const child = targetQi.planNestedRelation(subName, subRel, subOpt, includePii, depth + 1);
        if (!child) return null;
        children.push(child);
      }
    }
    // The block's object keys are the projected snake column names plus the
    // sub-relation field names; a duplicate key would mis-shape the JSON.
    const keys = new Set(cols);
    for (const child of children) {
      if (keys.has(child.relName)) return null;
      keys.add(child.relName);
    }
    return { relName, rel, options, targetQi, single, cols, forcedPk, children };
  }

  /**
   * Compile one {@link NestedRelationPlan} into its projection-field block:
   * `name: Target as tN filter <correlation> [and (<child where>)] [order …]
   * [limit …] [offset …] { col: tN.col, …, <sub-blocks> }`. Params bind in
   * emission order (the projection is the statement's final clause, so nested
   * params always follow the parent's filter/order/limit/offset params).
   * Aliases share the parent statement's counter, so arbitrarily deep and
   * self-referential trees stay collision-free (the same discipline as the SQL
   * engine's json_agg subqueries).
   *
   * The target's global filter is ANDed into the block's filter at every level,
   * under the query's `skip`, exactly as the SQL engines AND it into each
   * relation subquery: a block that omitted it handed back another tenant's rows.
   */
  private async buildNestedBlock(
    plan: NestedRelationPlan,
    parentAlias: string,
    aliasCtr: { n: number },
    params: unknown[],
    timeout?: number,
    skip?: unknown,
  ): Promise<string> {
    const { rel, relName, targetQi, options, single } = plan;
    const alias = `t${aliasCtr.n++}`;
    const fk = normalizeKeyColumns(rel.foreignKey)[0]!;
    const rk = normalizeKeyColumns(rel.referenceKey)[0]!;
    const parentKeyCol = rel.type === 'belongsTo' ? fk : rk;
    const childKeyCol = rel.type === 'belongsTo' ? rk : fk;
    // Exactly one equi-correlation predicate (the 0.18 correlation rule); the
    // child where chains behind it as a parenthesized `and` group, which the
    // grammar accepts even when the group itself contains `or`.
    const correlation = `${alias}.${quotePowqlIdent(childKeyCol)} = ${parentAlias}.${quotePowqlIdent(parentKeyCol)}`;
    const resolved = await targetQi.resolveRelationFilters(options.where as WhereClause<object>, timeout, skip);
    const targetGf = await targetQi.globalFilterWhere(skip, timeout);
    const childWhere = targetQi.applyGlobalFilter(
      targetQi.buildWhere(resolved, params, alias),
      params,
      targetGf,
      alias,
    );
    const filter = childWhere ? `${correlation} and (${childWhere})` : correlation;
    const order = targetQi.buildOrder(options.orderBy, params, alias);
    const limitClause = single
      ? ' limit 1'
      : options.limit !== undefined
        ? ` limit ${this.param(options.limit, params)}`
        : '';
    const offsetClause = !single && options.offset ? ` offset ${this.param(options.offset, params)}` : '';
    const parts = plan.cols.map((c) => `${quotePowqlIdent(c)}: ${alias}.${quotePowqlIdent(c)}`);
    for (const child of plan.children) {
      parts.push(await targetQi.buildNestedBlock(child, alias, aliasCtr, params, timeout, skip));
    }
    return (
      `${quotePowqlIdent(relName)}: ${targetQi.qt} as ${alias} ` +
      `filter ${filter}${order}${limitClause}${offsetClause} { ${parts.join(', ')} }`
    );
  }

  /**
   * Shape the nested JSON children back into typed entities on every parent
   * row. The nested field arrives as a decoded JSON array on the native wire
   * (or JSON text on the legacy wire, parsed here); its values are real JSON
   * types, so each child object goes through the NATIVE coercion policy
   * (`rowToEntity(…, true)`: a date column's micros number becomes a `Date`, a
   * json column's document passes through, a str `"null"` stays a string).
   * to-one relations unwrap to `[0] ?? null`, matching the loaders exactly.
   */
  private attachNestedRows(entities: T[], plans: NestedRelationPlan[]): void {
    for (const entity of entities) {
      for (const plan of plans) this.attachOneNested(entity as Record<string, unknown>, plan);
    }
  }

  private attachOneNested(row: Record<string, unknown>, plan: NestedRelationPlan): void {
    let value = row[plan.relName];
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        value = [];
      }
    }
    const items = Array.isArray(value) ? value : [];
    const shaped = items.map((o) =>
      rowToEntity(o as Record<string, unknown>, plan.targetQi.meta, true, this.schema.enums),
    );
    for (const child of shaped) {
      for (const sub of plan.children) plan.targetQi.attachOneNested(child, sub);
    }
    // After the sub-blocks, for the same reason the top-level strip runs last.
    plan.targetQi.stripForcedPk(shaped, plan.forcedPk);
    row[plan.relName] = plan.single ? (shaped[0] ?? null) : shaped;
  }

  // -------------------------------------------------------------------------
  // Scalar to-one link paths (PowDB >= 0.19.1, `linkPaths` capability)
  // -------------------------------------------------------------------------

  /**
   * The `schema links` snapshot for this pool, fetched at most once and cached on
   * the pool identity. A fetch failure resolves to `[]` (a missing listing is a
   * silent fallback to loaders, never an error). Only called when the `linkPaths`
   * capability is on, so the listing statement is guaranteed to exist.
   */
  private linksSnapshot(): Promise<LinkSnapshotRow[]> {
    const pool = this.pool as object;
    let snap = LINK_SNAPSHOT_CACHE.get(pool);
    if (!snap) {
      snap = this.fetchLinksSnapshot();
      LINK_SNAPSHOT_CACHE.set(pool, snap);
    }
    return snap;
  }

  private async fetchLinksSnapshot(): Promise<LinkSnapshotRow[]> {
    try {
      const { rows } = await this.exec('schema links', [], undefined, 'introspect');
      return rows.map((r) => ({
        owner: String(r.owner ?? ''),
        name: String(r.name ?? ''),
        target: String(r.target ?? ''),
        localKey: String(r.local_key ?? ''),
        targetKey: String(r.target_key ?? ''),
        cardinality: String(r.cardinality ?? ''),
      }));
    } catch {
      return [];
    }
  }

  /** True when `name` is a bare PowQL identifier (quoting leaves it unchanged). */
  private isBareIdent(name: string): boolean {
    return quotePowqlIdent(name) === name;
  }

  /**
   * Find the declared to-one link on THIS table that matches `rel` exactly: same
   * target, same correlation columns (owner localKey = the FK on this table, target
   * targetKey = the referenced key on target), cardinality `"to-one"`. Returns the
   * declared link (whose NAME drives the path spelling, which may differ from the
   * relation's own name) or `null` for no verifiable match (→ silent loader
   * fallback, never an error).
   */
  private findMatchingLink(snapshot: LinkSnapshotRow[], rel: RelationDef): LinkSnapshotRow | null {
    const localKey = normalizeKeyColumns(rel.foreignKey)[0];
    const targetKey = normalizeKeyColumns(rel.referenceKey)[0];
    if (!localKey || !targetKey) return null;
    for (const l of snapshot) {
      if (
        l.cardinality === 'to-one' &&
        l.owner === this.table &&
        l.target === rel.to &&
        l.localKey === localKey &&
        l.targetKey === targetKey
      ) {
        return l;
      }
    }
    return null;
  }

  /**
   * Plan one belongsTo `with` as a scalar link-path relation, or `null` when it
   * must stay on the loaders (ALWAYS a silent fallback with identical output).
   *
   * SCOPED TIGHT: this fires ONLY for a to-one relation whose child projection
   * includes a bigint/bytes column, exactly the case a JSON nested block cannot
   * carry, so nested projections have already fallen back to a per-relation loader
   * (`planNestedRelation` returned `null` for the same shape). Cases nested
   * projections DO serve keep nested projections: link-bearing statements are
   * NEVER plan-cached upstream, so replacing a cacheable nested projection with a
   * link path would regress a hot path for no gain. Requires: single-column
   * belongsTo; no relation `with` / `where` / `distinct` / `orderBy` /
   * `limit` / `offset` (a scalar path has no per-hop filter/order and cannot
   * reproduce those, such inputs stay on the loader for exact parity); no
   * global filter on the target, for the same reason; a link
   * name and all projected columns that are bare identifiers (a quoted segment in
   * a dotted link path is outside the verified spelling, fall back); and a
   * DECLARED link that verifiably matches (`findMatchingLink`).
   */
  private async planLinkPathRelation(
    relName: string,
    rel: RelationDef,
    opt: unknown,
    includePii: boolean,
    parentCols: string[],
    index: number,
    skip?: unknown,
  ): Promise<LinkPathPlan | null> {
    if (!this.capabilities.linkPaths) return null;
    if (rel.type !== 'belongsTo') return null;
    if (normalizeKeyColumns(rel.foreignKey).length !== 1 || normalizeKeyColumns(rel.referenceKey).length !== 1) {
      return null;
    }
    const targetMeta = this.schema.tables[rel.to];
    if (targetMeta?.primaryKey.length !== 1) return null;
    const options = (opt === true ? {} : opt) as FindManyArgs<object> & { with?: Record<string, unknown> };
    if (options.with || options.where || options.distinct?.length) return null;
    if (options.orderBy || options.limit !== undefined || options.offset) return null;

    const targetQi = new PowqlInterface<object>(this.pool, rel.to, this.schema, [], this.options);
    // A link hop has no per-hop filter, so it cannot carry the target's global
    // filter; such a relation stays on the loaders, which apply it.
    if (targetQi.hasGlobalFilter(skip)) return null;
    // `projectionPlan`, not `projectedColumns`: the plan is what carries
    // `forcedPk`, and reading the column LIST alone is what made this path's
    // strip dead. See the pkProjected line below.
    const { cols: userCols, forcedPk } = targetQi.projectionPlan(
      options.select as Record<string, boolean> | undefined,
      options.omit as Record<string, boolean> | undefined,
      includePii,
    );
    const byName = new Map(targetMeta.columns.map((c) => [c.name, c]));
    // Only adopt link paths where a JSON block genuinely cannot serve the case:
    // at least one projected child column is bigint/bytes. Otherwise nested
    // projections already handle it (and cache), so leave it to them.
    const hasCarrierBlockedCol = userCols.some((c) => {
      const ts = baseTsType(byName.get(c)?.tsType ?? '');
      return ts === 'bigint' || ts === 'Uint8Array';
    });
    if (!hasCarrierBlockedCol) return null;

    // All cheap checks passed: NOW fetch (and cache) the link snapshot, never
    // before, so a query with no link-path candidate issues no `schema links`.
    const link = this.findMatchingLink(await this.linksSnapshot(), rel);
    if (!link) return null;
    if (!this.isBareIdent(link.name)) return null;
    if (!userCols.every((c) => this.isBareIdent(c))) return null;

    // Always project the target PK for presence detection (an absent to-one yields
    // Empty at every hop; PK-Empty is the unambiguous "no linked row" signal).
    // `projectionPlan` has already put it in `userCols`, so there is nothing to
    // add; what is needed is knowing whether the CALLER asked for it.
    //
    // This is the line that was wrong. It read `userCols.includes(pkCol)`, and
    // the projection force-adds the PK, so the answer was ALWAYS true and the
    // strip in `attachLinkRows` never ran once. `forcedPk` is the caller's
    // intent rather than the fetched list: it names the PK columns that are in
    // `userCols` only because the projection put them there.
    const pkCol = targetMeta.primaryKey[0]!;
    if (!this.isBareIdent(pkCol)) return null;
    const pkProjected = !forcedPk.includes(pkCol);
    const cols = userCols;

    // Synthetic flat result keys (`l<index>_<col>`) keep the hop fields from
    // colliding with real parent columns or each other. Refuse the (astronomically
    // unlikely) case where a real parent/child column already uses the prefix.
    const keyPrefix = `l${index}_`;
    if (parentCols.some((c) => c.startsWith(keyPrefix)) || cols.some((c) => c.startsWith(keyPrefix))) return null;

    return { relName, linkName: link.name, targetQi, cols, pkCol, pkProjected, keyPrefix };
  }

  /**
   * The flat `l<i>_<col>: t0.<linkName>.<col>` projection fields for one link
   * plan. Both path segments and the synthetic result key go through
   * `quotePowqlIdent`, the same identifier boundary every other emission site
   * uses; verified against the engine that a quoted link hop and a quoted alias
   * parse exactly like their bare forms and yield the same result-column names.
   */
  private linkPathFields(plan: LinkPathPlan, parentAlias: string): string[] {
    const link = quotePowqlDotted(plan.linkName);
    return plan.cols.map(
      (c) => `${quotePowqlIdent(`${plan.keyPrefix}${c}`)}: ${parentAlias}.${link}.${quotePowqlDotted(c)}`,
    );
  }

  /**
   * Reconstruct each link-path relation's child entity from its flat hop fields
   * and attach it under the relation name, output indistinguishable from the
   * loader (same keys, same coercions). Presence: the target PK cell arriving
   * Empty (a null/dangling FK at the hop) means no linked row → `null`, matching
   * the loader's `matches[0] ?? null`. Otherwise the gathered snake cells go
   * through the SAME `rowToEntity` policy the loader uses (native micros → Date,
   * bigint per the int8 policy), and the PK is stripped back off if the user did
   * not project it. `native` is the wire that actually served the parent row.
   */
  private attachLinkRows(entities: T[], plans: LinkPathPlan[], native: boolean): void {
    for (const plan of plans) {
      const pkField = plan.targetQi.meta.reverseColumnMap[plan.pkCol] ?? plan.pkCol;
      for (const entity of entities) {
        const row = entity as Record<string, unknown>;
        const raw: Record<string, unknown> = {};
        for (const c of plan.cols) {
          raw[c] = row[`${plan.keyPrefix}${c}`];
          delete row[`${plan.keyPrefix}${c}`];
        }
        const child = rowToEntity(raw, plan.targetQi.meta, native, this.schema.enums);
        if (child[pkField] == null) {
          row[plan.relName] = null;
          continue;
        }
        if (!plan.pkProjected) delete child[pkField];
        row[plan.relName] = child;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Writes (reselect, PowDB has no RETURNING)
  // -------------------------------------------------------------------------

  /** Split `data` into scalar assignments; reject relation (nested-write) keys. */
  private scalarData(data: Record<string, unknown>): { col: ColumnMetadata; value: unknown }[] {
    const out: { col: ColumnMetadata; value: unknown }[] = [];
    for (const [field, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (resolveRelationDef(this.meta.relations, field)) {
        throw new UnsupportedFeatureError(
          'nested writes',
          'PowDB',
          `relation "${field}", nested writes need create()/update()/upsert(), not createMany()`,
        );
      }
      out.push({ col: this.column(field), value });
    }
    return out;
  }

  /**
   * Fill in a client-generated UUID for a defaulted **string** PK that wasn't
   * supplied. A server-generated PK ({@link ColumnMetadata.isGenerated}, e.g. an
   * `int` column with PowDB's `auto` modifier) is left untouched, PowDB assigns
   * it and the trailing `returning` reads it back, as is any non-string PK.
   */
  private applyPkDefault(data: Record<string, unknown>): Record<string, unknown> {
    const out = { ...data };
    for (const pk of this.meta.primaryKey) {
      const field = this.meta.reverseColumnMap[pk] ?? pk;
      const col = this.meta.columns.find((c) => c.name === pk);
      // "Supplied" means under EITHER spelling: `create` resolves both, so
      // testing the camelCase field alone made `{ user_id: 'x' }` look absent,
      // generated a UUID under `userId`, and wrote the column twice.
      if (
        out[field] == null &&
        (field === pk || out[pk] == null) &&
        col?.hasDefault &&
        !col.isGenerated &&
        col.tsType.replace(/\s*\|\s*null$/, '').trim() === 'string'
      ) {
        out[field] = randomUUID();
      }
    }
    return out;
  }

  /**
   * Fill every omitted column that declares a default, since PowDB has no
   * column defaults of its own (its only generated value is `auto`, which is
   * left to the engine). Without this an omitted defaulted column was written
   * as NULL, silently, or failed NOT NULL where every SQL engine applied the
   * default.
   *
   * "Omitted" means absent or `undefined` under BOTH spellings, exactly the
   * columns a SQL insert leaves to the database; an explicit `null` stays
   * `null`. The value comes from the column's declared default expression,
   * evaluated per row (`now()` is the insert time). An expression this cannot
   * evaluate faithfully, or metadata that does not carry the expression, is
   * refused rather than guessed.
   */
  private applyColumnDefaults(data: Record<string, unknown>): Record<string, unknown> {
    let out: Record<string, unknown> | undefined;
    for (const col of this.meta.columns) {
      if (!col.hasDefault || col.isGenerated || this.meta.primaryKey.includes(col.name)) continue;
      if (data[col.field] !== undefined || data[col.name] !== undefined) continue;
      const expr = col.defaultValue;
      const value = expr == null ? NO_DEFAULT : emulateColumnDefault(expr, col, this.schema.enums);
      if (value === NO_DEFAULT) {
        throw new UnsupportedFeatureError(
          `The default of column "${col.name}" on "${this.table}"`,
          'PowDB',
          (expr == null
            ? 'The schema metadata marks the column as defaulted but does not carry the default expression'
            : `The default expression \`${expr}\` has no client-side equivalent`) +
            ', and PowDB has no column defaults, so the value cannot be applied. Supply the field explicitly ' +
            'on create (or build the metadata with defineSchema, which records literal, now(), current_date and ' +
            'gen_random_uuid() defaults).',
        );
      }
      out ??= { ...data };
      out[col.field] = value;
    }
    return out ?? data;
  }

  /**
   * The table name as a PowQL type reference, backtick-quoted when it is a
   * reserved word (e.g. a table named `order`). Used in every emitted
   * statement; plain `this.table` stays in error messages.
   */
  private get qt(): string {
    return quotePowqlIdent(this.table);
  }

  create<
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args: CreateArgs<T, NoRelations, S, O>): Promise<FieldResult<T, S, O>>;
  async create(args: CreateArgs<T>): Promise<T> {
    args = this.normalizeArgs(args);
    return this.withMiddleware('create', args as unknown as Record<string, unknown>, async () => {
      const plan = this.writeReturnPlan(args);
      if (hasRelationFields(args.data as Record<string, unknown>, this.meta)) {
        return this.nestedCreate(args);
      }
      const data = this.applyColumnDefaults(this.applyPkDefault(args.data as Record<string, unknown>));
      const assigns = this.scalarData(data);
      const params: unknown[] = [];
      const body = assigns
        .map((a) => `${quotePowqlIdent(a.col.name)} := ${this.writeRef(a.value, a.col, params)}`)
        .join(', ');
      // `returning` surfaces the inserted row (all columns, schema order) in one round-trip.
      const { rows, native } = await this.exec(
        `insert ${this.qt} { ${body} } returning`,
        params,
        args.timeout,
        'create',
      );
      const row = rows.length ? this.shapeWriteRow(this.shape(rows, native)[0]!, plan) : null;
      if (!row) throw new NotFoundError({ table: this.table, where: data });
      return row;
    });
  }

  /**
   * Refuse a `createMany` whose rows do not all name the SAME fields.
   *
   * PowQL could express it: a multi-row insert carries one `{ col := … }` tuple
   * per row, each with its own column list, so a ragged call inserts every
   * value. The SQL engines cannot, their single statement takes its column list
   * from the first row, so a field only a later row names is dropped and a field
   * only the first row names is written as NULL over that column's default. They
   * refuse it (ValidationError, query/writes.ts), and PowDB matching that
   * refusal is what makes the call portable: a shape accepted here and rejected
   * by every other engine turns a PowDB-to-Postgres move into a hard error found
   * in production rather than at the first run.
   *
   * Runs AFTER `applyPkDefault`, on the rows as they will actually be written:
   * a defaulted string PK is filled in on every row, so `[{}, { name }]` is
   * refused for the missing `name`, not for the PK the client supplied itself.
   * Rows that all name the same fields (the overwhelmingly common shape,
   * including N rows of pure defaults) cost one `Object.keys` pass and emit
   * byte-identical PowQL.
   */
  private assertUniformCreateManyRows(rows: Record<string, unknown>[]): void {
    const definedKeys = (row: Record<string, unknown>): string[] =>
      Object.keys(row).filter((k) => row[k] !== undefined);
    const firstKeys = definedKeys(rows[0]!);
    const expected = new Set(firstKeys);
    const quoteList = (names: string[]): string => names.map((n) => `"${n}"`).join(', ');
    for (let i = 1; i < rows.length; i++) {
      const rowKeys = definedKeys(rows[i]!);
      // No stranger and the same count means the same set (object keys are unique).
      const unexpected = rowKeys.filter((k) => !expected.has(k));
      if (unexpected.length === 0 && rowKeys.length === expected.size) continue;
      const present = new Set(rowKeys);
      const missing = firstKeys.filter((k) => !present.has(k));
      const parts: string[] = [];
      if (missing.length > 0) parts.push(`does not supply ${quoteList(missing)}`);
      if (unexpected.length > 0) parts.push(`supplies ${quoteList(unexpected)}, which the first row does not`);
      throw new ValidationError(
        `createMany on "${this.table}": row ${i} ${parts.join(' and ')}. ` +
          'Every row must supply the same fields (a field set to `undefined` counts as omitted, exactly as it does ' +
          'in `create`). PowQL itself would insert the ragged rows, but the SQL engines build ONE statement whose ' +
          "column list comes from the first row, so there a later row's extra field is dropped and a field it " +
          "omits is written as NULL over that column's default. Supply the field explicitly on every row, or " +
          'split the call into one createMany per field set.',
      );
    }
  }

  createMany<
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args: CreateManyArgs<T, OptionalInput<T>, S, O>): Promise<FieldResult<T, S, O>[]>;
  async createMany(args: CreateManyArgs<T>): Promise<T[]> {
    args = this.normalizeArgs(args);
    return this.withMiddleware('createMany', args as unknown as Record<string, unknown>, async () => {
      if (args.onConflict !== undefined) {
        throw new UnsupportedFeatureError(
          'createMany({ onConflict })',
          'powdb',
          "PowQL's upsert statement takes one row. Call upsert() per row inside $transaction.",
        );
      }
      // Validated as every engine validates it; it acts only on onConflict's
      // update, which is refused above.
      resolveSkipGlobalFilters(args.skipGlobalFilters);
      if (args.skipDuplicates) {
        // PowQL's `insert … returning` has no conflict clause, so there is no
        // faithful skip-duplicates form; refuse rather than silently insert.
        throw new UnsupportedFeatureError(
          'createMany({ skipDuplicates: true })',
          'powdb',
          'PowQL insert has no ON CONFLICT DO NOTHING equivalent, filter duplicates before inserting.',
        );
      }
      // Resolved before the write, so a bad projection writes nothing.
      const plan = this.writeReturnPlan(args);
      const supplied = (args.data as Record<string, unknown>[]).map((d) => this.applyPkDefault(d));
      if (!supplied.length) return [];
      // Uniformity is judged on what the caller supplied, as the SQL engines
      // judge it; defaults are then filled per row.
      this.assertUniformCreateManyRows(supplied);
      const inputs = supplied.map((d) => this.applyColumnDefaults(d));
      const params: unknown[] = [];
      const tuples = inputs.map((d) => {
        const assigns = this.scalarData(d);
        return `{ ${assigns.map((a) => `${quotePowqlIdent(a.col.name)} := ${this.writeRef(a.value, a.col, params)}`).join(', ')} }`;
      });
      // Multi-row insert with `returning` hands back every inserted row in one round-trip.
      const { rows, native } = await this.exec(
        `insert ${this.qt} ${tuples.join(', ')} returning`,
        params,
        args.timeout,
        'createMany',
      );
      return this.shape(rows, native).map((r) => this.shapeWriteRow(r, plan) as T);
    });
  }

  update<
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args: UpdateArgs<T, NoRelations, S, O>): Promise<FieldResult<T, S, O>>;
  async update(args: UpdateArgs<T>): Promise<T> {
    args = this.normalizeArgs(args);
    return this.withMiddleware('update', args as unknown as Record<string, unknown>, async () => {
      const plan = this.writeReturnPlan(args);
      if (hasRelationFields(args.data as Record<string, unknown>, this.meta)) {
        // The nested engine re-enters `update` / `findUnique` for the parent
        // row before it writes anything, so the identity rule below still runs
        // first on this path.
        return this.nestedUpdate(args);
      }
      const allowFullTableScan = resolveUnsafeFlag(args.allowFullTableScan, 'allowFullTableScan');
      // Prisma compound-unique selector → column conjunction, so the selector
      // counts as the key it is (engine parity with the SQL buildUpdate).
      const userWhere = this.expandedWhere(args.where);
      const params: unknown[] = [];
      const resolvedWhere = await this.resolveRelationFilters(userWhere, args.timeout, args.skipGlobalFilters);
      let where = this.buildWhere(resolvedWhere, params);
      // `false` here refused an empty where even WITH the opt-in, while every
      // SQL engine accepted it: verified by probe on buildUpdate/buildDelete.
      this.assertCompiledWhere(where, allowFullTableScan, 'update', userWhere);
      this.assertMutationIdentifiesOneRow(userWhere, allowFullTableScan, 'update');
      where = this.applyGlobalFilter(where, params, await this.globalFilterWhere(args.skipGlobalFilters, args.timeout));
      let setClause = this.buildUpdateAssignments(args.data as Record<string, unknown>, params);
      // Optimistic locking, matching the SQL engines exactly: bump the version
      // column in the SET, add `version = expected` to the filter, and treat
      // "matched no row" as a lost race rather than a missing row.
      //
      // PowqlInterface ignored `optimisticLock` outright before 0.74.0, which is
      // worse than not supporting it: the update applied, the caller's version
      // check never happened, and a concurrent writer's change was overwritten
      // by a caller who believed they held the lock.
      const lock = args.optimisticLock;
      if (lock) {
        const versionCol = quotePowqlIdent(this.column(lock.field).name);
        setClause += `, ${versionCol} := ${this.ref(lock.field)} + 1`;
        params.push(lock.expected);
        const check = `${this.ref(lock.field)} = $${params.length}`;
        where = where ? `(${where}) and (${check})` : check;
      }
      // `returning` hands back the post-update row(s); take the first (single-row contract).
      const { rows, native } = await this.exec(
        `${this.qt} filter ${where} update { ${setClause} } returning`,
        params,
        args.timeout,
        'update',
      );
      const row = rows.length ? this.shapeWriteRow(this.shape(rows, native)[0]!, plan) : null;
      if (!row) {
        if (lock) {
          throw new OptimisticLockError({
            table: this.table,
            versionField: lock.field,
            expectedVersion: lock.expected,
          });
        }
        throw new NotFoundError({ table: this.table, where: args.where as Record<string, unknown> });
      }
      return row;
    });
  }

  async updateMany(args: UpdateManyArgs<T>): Promise<{ count: number }> {
    args = this.normalizeArgs(args);
    assertNoBulkWritePaging(this.table, 'updateMany', args);
    this.assertNoOptimisticLock(args, 'updateMany');
    return this.withMiddleware('updateMany', args as unknown as Record<string, unknown>, async () => {
      const params: unknown[] = [];
      const resolvedWhere = await this.resolveRelationFilters(args.where, args.timeout, args.skipGlobalFilters);
      let where = this.buildWhere(resolvedWhere, params);
      this.assertCompiledWhere(
        where,
        resolveUnsafeFlag(args.allowFullTableScan, 'allowFullTableScan'),
        'updateMany',
        args.where,
      );
      where = this.applyGlobalFilter(where, params, await this.globalFilterWhere(args.skipGlobalFilters, args.timeout));
      const setClause = this.buildUpdateAssignments(args.data as Record<string, unknown>, params);
      const filter = where ? ` filter ${where}` : '';
      const { rowCount } = await this.exec(
        `${this.qt}${filter} update { ${setClause} }`,
        params,
        args.timeout,
        'updateMany',
      );
      return { count: rowCount };
    });
  }

  /** Compile `data` into PowQL update assignments, including atomic operators. */
  private buildUpdateAssignments(data: Record<string, unknown>, params: unknown[]): string {
    const parts: string[] = [];
    for (const [field, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (resolveRelationDef(this.meta.relations, field)) {
        throw new UnsupportedFeatureError(
          'nested writes',
          'PowDB',
          `relation "${field}", nested writes need create()/update()/upsert(), not updateMany()`,
        );
      }
      // PowQL update assignments take values and the atomic operators only.
      if (isSqlExpr(value) || isColumnRef(value)) {
        throw new UnsupportedFeatureError(
          `update expressions (expr / col() in update data, "${this.table}.${field}")`,
          'powdb',
          'Compute the value in JavaScript and write it as a plain value, or use the atomic operators ' +
            '(increment, decrement, multiply, divide).',
        );
      }
      const colMeta = this.column(field);
      const ref = this.ref(field);
      const col = quotePowqlIdent(colMeta.name);
      const op = this.setOperatorOf(colMeta, value);
      if (op === 'set') {
        parts.push(`${col} := ${this.writeRef((value as Record<string, unknown>).set, colMeta, params)}`);
      } else if (op !== null) {
        this.assertDecimalComparable(colMeta, `\`${op}\``);
        // Same rule and message as the SQL engines' buildSetClauses.
        const operand = (value as Record<string, unknown>)[op];
        if (typeof operand !== 'number' || !Number.isFinite(operand)) {
          throw new ValidationError(
            `update operator "${op}" on "${this.table}.${field}" requires a finite number, got ${typeof operand}`,
          );
        }
        parts.push(`${col} := ${ref} ${POWQL_ARITHMETIC[op]} ${this.writeRef(operand, colMeta, params)}`);
      } else {
        this.assertBindableSetValue(field, colMeta, value);
        parts.push(`${col} := ${this.writeRef(value, colMeta, params)}`);
      }
    }
    if (!parts.length) throw new ValidationError(`update on "${this.table}" has no fields to set.`);
    return parts.join(', ');
  }

  /**
   * The atomic operator an update value names, or `null` for a plain value.
   * The SQL engines' `setOperatorOf` rule: a plain object with EXACTLY one key
   * from {@link UPDATE_OPERATOR_KEYS}, and on a json column only `set`, since
   * an object there IS the document (`{ increment: 1 }` is the document
   * `{"increment":1}`, and `{ set: doc }` writes a document shaped like
   * `{ set: ... }`).
   */
  private setOperatorOf(colMeta: ColumnMetadata, value: unknown): string | null {
    if (!isUnmatchedPlainObject(value)) return null;
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length !== 1 || !UPDATE_OPERATOR_KEYS.has(keys[0]!)) return null;
    const op = keys[0]!;
    if (op !== 'set' && isJsonColumn(colMeta, this.schema.enums)) return null;
    return op;
  }

  /**
   * A one-key plain object that is not an update operator, written to a
   * non-json column, is a misspelled operator (`{ incremnt: 1 }`): refused with
   * the SQL engines' message rather than stored as text.
   */
  private assertBindableSetValue(field: string, colMeta: ColumnMetadata, value: unknown): void {
    if (!isUnmatchedPlainObject(value) || isJsonColumn(colMeta, this.schema.enums)) return;
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length !== 1 || UPDATE_OPERATOR_KEYS.has(keys[0]!)) return;
    throw new ValidationError(
      `Unknown update operator "${keys[0]}" on "${this.table}.${field}". ` +
        `Supported: ${[...UPDATE_OPERATOR_KEYS].join(', ')}. ` +
        'A plain object is only written as a value on a json/jsonb column.',
    );
  }

  // -------------------------------------------------------------------------
  // Nested writes, create/update whose `data` carries relation ops (create,
  // connect, connectOrCreate, disconnect, set, delete, update, upsert). Reuses
  // the engine-agnostic nested-write engine (it only needs ctx.schema + the
  // table accessors PowqlInterface already provides). Runs as ONE flat top-level
  // PowDB transaction, single global write lock, no savepoints, so the whole
  // tree commits or rolls back together (mirrors the SQL path's coverage:
  // hasMany / hasOne / belongsTo; manyToMany nested writes are not handled by
  // the shared engine on any backend).
  // -------------------------------------------------------------------------

  private isTxScoped(): boolean {
    return (this.options as { _txScoped?: boolean })._txScoped === true;
  }

  private async nestedCreate(args: CreateArgs<T>): Promise<T> {
    const data = args.data as Record<string, unknown>;
    // Applied by the nested engine's final read-back, as on the SQL engines.
    const shape = { select: args.select, omit: args.omit };
    if (this.isTxScoped()) {
      return executeNestedCreate(this.buildNestedCtx(), this.table, data, 0, [], shape) as Promise<T>;
    }
    return this.runInImplicitTx((ctx) => executeNestedCreate(ctx, this.table, data, 0, [], shape)) as Promise<T>;
  }

  private async nestedUpdate(args: UpdateArgs<T>): Promise<T> {
    const data = args.data as Record<string, unknown>;
    const where = args.where as Record<string, unknown>;
    const shape = { select: args.select, omit: args.omit };
    if (this.isTxScoped()) {
      return executeNestedUpdate(this.buildNestedCtx(), this.table, where, data, 0, [], shape) as Promise<T>;
    }
    return this.runInImplicitTx((ctx) => executeNestedUpdate(ctx, this.table, where, data, 0, [], shape)) as Promise<T>;
  }

  /** Open a flat PowDB transaction on a pinned connection and run `fn` inside it. */
  private async runInImplicitTx<R>(fn: (ctx: NestedWriteContext) => Promise<R>): Promise<R> {
    // A transaction-control `begin` is a write on a read-only pool: refuse it
    // locally before checking out a connection (zero wire / pool activity), the
    // same guard the exec seam applies to plain writes.
    if (this.pool.readonly === true) throw this.readOnlyError('transaction (begin)');
    // Route tx keywords through the dialect (like the SQL path) so this never
    // drifts from `powdbDialect`; falls back to the literal lowercase keywords.
    const d = this.options.dialect;
    // Read before the checkout, so an empty slot (client.ts never loaded in this
    // copy of the package) refuses with no connection taken and no `begin` sent.
    const TransactionClient = transactionClientFor(`A nested write or lookup-first upsert on "${this.table}"`);
    const client = await this.pool.connect();
    // A no-op today (PowDB checkouts have no event surface), kept so this path
    // cannot become the one unguarded checkout if a transport ever emits 'error'.
    const checkout = guardCheckout(client);
    let began = false;
    try {
      await client.query(d?.beginStatement?.() ?? 'begin');
      began = true;
      const tx = new TransactionClient(
        client as unknown as never,
        this.schema,
        this.middlewares as unknown as never,
        this.options,
        // Pass the PowDB pool so its read-only guard + capabilities carry into
        // the transaction-scoped proxy pool (see createTxPool).
        this.pool as unknown as { readonly?: boolean; capabilities?: unknown },
      );
      const ctx: NestedWriteContext = {
        schema: this.schema,
        // The nested engine's internal `updateMany` for `set` reaches the
        // privilege sentinel through the same seam the SQL engines use.
        tx: unlockNestedWriteTx(
          tx as unknown as { table(name: string): Record<string, unknown> },
        ) as unknown as NestedWriteContext['tx'],
        scopedConnect: this.options?.scopedConnect === true,
      };
      // Plant the single-writer re-entrancy marker for the implicit tx's
      // subtree (same seam TurbineClient.$transaction uses), user code that
      // fires db.$transaction from inside (e.g. $use middleware around a
      // nested-write child op) must fast-fail E017, not queue into deadlock.
      const wrap = (client as { wrapTransactionCallback?: <T>(f: () => Promise<T>) => Promise<T> })
        .wrapTransactionCallback;
      const result = await (wrap ? wrap(() => fn(ctx)) : fn(ctx));
      await client.query(d?.commitStatement?.() ?? 'commit');
      return result;
    } catch (err) {
      // Only roll back a transaction we actually opened, a failed BEGIN
      // (queue timeout, re-entrancy E017) must not emit a stray ROLLBACK that
      // could land inside another transaction on a shared engine handle.
      if (began) {
        try {
          await client.query(d?.rollbackStatement?.() ?? 'rollback');
        } catch {
          /* best-effort, the connection may be gone */
        }
      }
      throw err;
    } finally {
      checkout.release();
    }
  }

  /** Already inside a transaction: build a context whose table accessors reuse the pinned pool. */
  private buildNestedCtx(): NestedWriteContext {
    const opts = { ...this.options, _txScoped: true } as QueryInterfaceOptions;
    const tx = {
      table: <U extends object>(name: string) =>
        new PowqlInterface<U>(this.pool, name, this.schema, this.middlewares, opts) as unknown as Record<
          string,
          unknown
        >,
    };
    return { schema: this.schema, tx: unlockNestedWriteTx(tx) as unknown as NestedWriteContext['tx'] };
  }

  delete<
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args: DeleteArgs<T, NoRelations, S, O>): Promise<FieldResult<T, S, O>>;
  async delete(args: DeleteArgs<T>): Promise<T> {
    args = this.normalizeArgs(args);
    this.assertNoOptimisticLock(args, 'delete');
    return this.withMiddleware('delete', args as unknown as Record<string, unknown>, async () => {
      const plan = this.writeReturnPlan(args);
      const allowFullTableScan = resolveUnsafeFlag(args.allowFullTableScan, 'allowFullTableScan');
      const userWhere = this.expandedWhere(args.where);
      const params: unknown[] = [];
      const resolvedWhere = await this.resolveRelationFilters(userWhere, args.timeout, args.skipGlobalFilters);
      let where = this.buildWhere(resolvedWhere, params);
      this.assertCompiledWhere(where, allowFullTableScan, 'delete', userWhere);
      this.assertMutationIdentifiesOneRow(userWhere, allowFullTableScan, 'delete');
      where = this.applyGlobalFilter(where, params, await this.globalFilterWhere(args.skipGlobalFilters, args.timeout));
      // `returning` hands back the deleted row(s), no separate pre-image reselect needed.
      const { rows, native } = await this.exec(
        `${this.qt} filter ${where} delete returning`,
        params,
        args.timeout,
        'delete',
      );
      const row = rows.length ? this.shapeWriteRow(this.shape(rows, native)[0]!, plan) : null;
      if (!row) throw new NotFoundError({ table: this.table, where: args.where as Record<string, unknown> });
      return row;
    });
  }

  async deleteMany(args: DeleteManyArgs<T>): Promise<{ count: number }> {
    args = this.normalizeArgs(args);
    assertNoBulkWritePaging(this.table, 'deleteMany', args);
    this.assertNoOptimisticLock(args, 'deleteMany');
    return this.withMiddleware('deleteMany', args as unknown as Record<string, unknown>, async () => {
      const params: unknown[] = [];
      const resolvedWhere = await this.resolveRelationFilters(args.where, args.timeout, args.skipGlobalFilters);
      let where = this.buildWhere(resolvedWhere, params);
      this.assertCompiledWhere(
        where,
        resolveUnsafeFlag(args.allowFullTableScan, 'allowFullTableScan'),
        'deleteMany',
        args.where,
      );
      where = this.applyGlobalFilter(where, params, await this.globalFilterWhere(args.skipGlobalFilters, args.timeout));
      const filter = where ? ` filter ${where}` : '';
      const { rowCount } = await this.exec(`${this.qt}${filter} delete`, params, args.timeout, 'deleteMany');
      return { count: rowCount };
    });
  }

  upsert<
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args: UpsertArgs<T, NoRelations, S, O>): Promise<FieldResult<T, S, O>>;
  async upsert(args: UpsertArgs<T>): Promise<T> {
    args = this.normalizeArgs(args);
    this.assertNoOptimisticLock(args, 'upsert');
    return this.withMiddleware('upsert', args as unknown as Record<string, unknown>, async () => {
      // The single-row rule for `upsert`, shared with the SQL engines through
      // query/compound-unique.ts. PowqlInterface is a PARALLEL implementation,
      // not a subclass, so a rule adopted only on the SQL side is two engines
      // disagreeing about whether a query is VALID, which is the failure class
      // 0.64.0 and 0.72.0 were both spent on. Before `applyPkDefault`, so a
      // refused upsert mints no client-side UUID and sends nothing.
      const upsertWhere = (this.expandedWhere(args.where) ?? {}) as Record<string, unknown>;
      this.assertMutationIdentifiesOneRow(upsertWhere as WhereClause<T>, false, 'upsert');
      const plan = this.writeReturnPlan(args);
      const createData = this.applyColumnDefaults(this.applyPkDefault(args.create as Record<string, unknown>));
      const pkCol = this.meta.primaryKey[0];
      const conflictColumns = Object.keys(upsertWhere)
        .filter((k) => upsertWhere[k] !== undefined)
        .map((k) => this.column(k).name);
      const updateData = (args.update ?? {}) as Record<string, unknown>;
      // PowQL's native `upsert … on .col` expresses exactly one shape: a single
      // conflict column that is the primary key, pinned to the value `create`
      // inserts, with a non-empty update and no predicate on its conflict
      // branch. Every other shape looks the row up by `where` first, in one
      // transaction, which is what the SQL engines do for the same shapes and
      // what the call means (query/compound-unique.ts upsertWhereMatchesCreate).
      //
      // That includes a table under a global filter. The native statement's
      // `on conflict` branch carries no predicate, so a tenant-scoped client
      // whose `create` key matched ANOTHER tenant's row updated that row, and
      // the tenant-filtered reselect then reported the write it had just made
      // as a NotFoundError. The lookup runs its find and its update through the
      // filtered interface, so another tenant's row is invisible to it: the
      // insert then collides on the key and fails, and nothing is overwritten.
      const filtered = this.hasGlobalFilter(args.skipGlobalFilters);
      // The shape the SQL engines answer with ONE conflict statement (`where`
      // pinned to `create`, a non-empty scalar update).
      const conflictShape =
        upsertWhereMatchesCreate(this.meta, upsertWhere, (args.create ?? {}) as Record<string, unknown>) &&
        !hasRelationFields(args.create as Record<string, unknown>, this.meta) &&
        !hasRelationFields(updateData, this.meta) &&
        Object.values(updateData).some((v) => v !== undefined);
      const native =
        this.meta.primaryKey.length === 1 &&
        pkCol !== undefined &&
        conflictColumns.length === 1 &&
        conflictColumns[0] === pkCol &&
        conflictShape &&
        !filtered;
      if (!native) {
        return this.upsertLookupFirst(upsertWhere, createData, updateData, {
          select: args.select,
          omit: args.omit,
          skipGlobalFilters: args.skipGlobalFilters,
          timeout: args.timeout,
          // That statement carries the global filter on its conflict branch, so a
          // key held by a row the filter hides writes nothing there (E001).
          hiddenConflictIsNotFound: conflictShape && filtered,
        });
      }
      const params: unknown[] = [];
      const createBody = this.scalarData(createData)
        .map((a) => `${quotePowqlIdent(a.col.name)} := ${this.writeRef(a.value, a.col, params)}`)
        .join(', ');
      const updateBody = this.buildUpdateAssignments(updateData, params);
      // PowDB 0.7.0's `upsert` statement does NOT accept a trailing `returning`
      // (verified: "unexpected trailing token … 'returning'"), because it is one
      // atomic insert-or-update, not two branches. So upsert alone keeps the
      // reselect-by-PK fetch; create/update/delete all use `returning`.
      await this.exec(
        `upsert ${this.qt} on ${this.colRefName(pkCol)} { ${createBody} } on conflict { ${updateBody} }`,
        params,
        args.timeout,
        'upsert',
      );
      const pkField = this.meta.reverseColumnMap[pkCol] ?? pkCol;
      // Either spelling, as `upsertLookupFirst` already does below: reading the
      // camelCase field alone reselected `undefined` for a snake-spelled PK and
      // reported a write that had SUCCEEDED as a NotFoundError.
      // `args` carries skipGlobalFilters too: an upsert that opted out of the
      // filter must not have its own write filtered out of the reselect.
      const row = await this.reselectByPk(createData[pkField] ?? createData[pkCol], args.timeout, args);
      if (!row) throw new NotFoundError({ table: this.table, where: createData });
      // Without a plan the reselect's default projection already left PII out.
      return plan ? (this.shapeWriteRow(row, plan) as T) : row;
    });
  }

  /**
   * `upsert` as Prisma defines it, for every shape the native `upsert … on`
   * statement cannot express: find the row `where` names, update it if it
   * exists, else insert `create`, in one flat transaction. PowDB's single
   * writer makes the read-then-write safe from concurrent writers; the
   * transaction makes it atomic with the write.
   *
   * The lookup is by `where`'s own values. It used to be by `create`'s values
   * for the conflict columns, which is what the native statement compares, and
   * so answered a different question whenever the two disagreed: `where: { id }`
   * with a `create` that leaves the key to the engine inserted a new row every
   * time. The find and the update run through the transaction's table
   * interface, so a configured global filter applies to both exactly as it does
   * to any other read or write, and `skipGlobalFilters` is forwarded to both.
   *
   * Both halves are compiled before the lookup, so an unknown field in `update`
   * is refused whether or not the row exists (the SQL engines do the same).
   */
  private async upsertLookupFirst(
    where: Record<string, unknown>,
    createData: Record<string, unknown>,
    updateData: Record<string, unknown>,
    shape: {
      select?: Record<string, boolean>;
      omit?: Record<string, boolean>;
      skipGlobalFilters?: unknown;
      timeout?: number;
      hiddenConflictIsNotFound?: boolean;
    },
  ): Promise<T> {
    const { skipGlobalFilters, timeout, hiddenConflictIsNotFound, ...projection } = shape;
    const skip = skipGlobalFilters === undefined ? {} : { skipGlobalFilters };
    const time = timeout === undefined ? {} : { timeout };
    this.scalarData(extractRelationFields(createData, this.meta).scalars);
    const scalarUpdate = extractRelationFields(updateData, this.meta).scalars;
    if (Object.values(scalarUpdate).some((v) => v !== undefined)) this.buildUpdateAssignments(scalarUpdate, []);
    const updateIsEmpty = Object.values(updateData).every((v) => v === undefined);
    const run = async (ctx: NestedWriteContext): Promise<T> => {
      const tbl = ctx.tx.table<T>(this.table);
      const existing = await tbl.findUnique({ where, ...projection, ...skip, ...time } as never);
      if (existing) {
        // An empty `update` means "leave it as it is": the row found is the answer.
        if (updateIsEmpty) return existing as T;
        return (await tbl.update({ where, data: updateData, ...projection, ...skip, ...time } as never)) as T;
      }
      if (hiddenConflictIsNotFound) {
        // `where` is pinned to `create`, so the insert below collides exactly
        // when the global filter is what hid the row: say so, as the SQL engines do.
        const hidden = await tbl.findUnique({ where, skipGlobalFilters: UNSAFE, ...time } as never);
        if (hidden) {
          throw new NotFoundError({
            table: this.table,
            where,
            operation: 'upsert',
            message:
              `upsert on "${this.table}" wrote nothing: the row that conflicts on the given key is excluded by the ` +
              `configured global filter for "${this.table}", so it was neither updated (the filter hides it) nor ` +
              'inserted (the key is taken). Pass `skipGlobalFilters: UNSAFE` to address it anyway.',
          });
        }
      }
      return (await tbl.create({ data: createData as Partial<T>, ...projection, ...time } as never)) as T;
    };
    return this.isTxScoped() ? run(this.buildNestedCtx()) : this.runInImplicitTx(run);
  }

  // -------------------------------------------------------------------------
  // Aggregates
  // -------------------------------------------------------------------------

  async count(args: CountArgs<T> = {}): Promise<number> {
    this.assertNoForceCustomPlan(args);
    args = this.normalizeArgs(args);
    return this.withMiddleware('count', (args ?? {}) as unknown as Record<string, unknown>, async () => {
      const params: unknown[] = [];
      const resolvedWhere = await this.resolveRelationFilters(args.where, args.timeout, args.skipGlobalFilters);
      let where = this.buildWhere(resolvedWhere, params);
      where = this.applyGlobalFilter(where, params, await this.globalFilterWhere(args.skipGlobalFilters, args.timeout));
      const filter = where ? ` filter ${where}` : '';
      const { rows } = await this.exec(`count(${this.qt}${filter})`, params, args.timeout, 'count');
      return Number((rows[0]?.value ?? rows[0]?.count ?? 0) as string | number);
    });
  }

  /**
   * Gate ONE field of a per-field `_count`.
   *
   * `_count: { col: true }` compiles to `count(T { .col })`, which counts
   * NON-NULL values of the column (SQL's `COUNT(col)`) only from engine 0.20 on.
   * Below 0.20 both PowDB frontends ignored the projection and returned the ROW
   * count.
   *
   * That divergence only EXISTS on a nullable column: where the column is NOT
   * NULL the row count and the non-null count are the same number, so the
   * pre-0.20 answer was already the right one and the query keeps working. The
   * gate is therefore per-column, not per-call: refusing the whole feature would
   * take a correct, working call away from every user on the engine line Turbine
   * shipped against and hand them nothing.
   *
   * Nullability comes from the column metadata (`introspectPowdbDatabase` reads
   * PowDB's `required` modifier; `defineSchema` declares it). Metadata that
   * claims NOT NULL for a column the live catalog lets be null would count rows
   * instead of values below 0.20, the same drift any stale-metadata query has.
   */
  private assertProjectedCountSupported(field: string): void {
    const col = this.column(field);
    if (!col.nullable) return;
    requireCapability(
      this.capabilities,
      'projectedCountNonNull',
      `per-field \`_count\` of the nullable column "${col.name}"`,
      'Below that version the engine ignored the column projection and returned the ROW count, which differs from ' +
        'every SQL engine exactly when the column is nullable. `_count: true` (a row count) and a per-field ' +
        '`_count` of a NOT NULL column are correct on every version and are never refused.',
    );
  }

  /**
   * Can `aggregate()` compute several aggregates in ONE statement on this engine?
   *
   * PowQL refuses a bare multi-aggregate projection (`T { a: sum(.x), b: sum(.y) }`
   * is "aggregate function in an unsupported position" on every engine version),
   * so the only one-statement form is a grouping over a literal key,
   * `T filter … group 1 { agg_0: sum(.x), agg_1: sum(.y) }`, which yields a
   * single group holding every row the filter matched. Measured against the
   * embedded addon at 0.7.1 through 0.28: below 0.13 a literal group key does not
   * parse, from 0.13 to 0.19.1 the grouped per-field `count` disagrees with the
   * scalar `count(T { .col })` on a nullable column, and from 0.20 every
   * aggregate kind (count / sum / avg / min / max over int, float, str, an
   * all-null column, and several filters) answers identically on both wires.
   *
   * Derived from the PROBED engine version rather than from a capability flag,
   * so an unprobed pool (`engineVersion: null`, e.g. an injected pool carrying
   * {@link ALL_POWDB_CAPABILITIES}) keeps the per-field statements: this changes
   * the emitted PowQL, and an older engine would reject it outright, the same
   * probe-only discipline `nestedProjections` follows.
   */
  private get groupsAggregatesInOneStatement(): boolean {
    const sem = parsePowdbSemver(this.capabilities.engineVersion);
    return sem !== null && atLeastVersion(sem, 0, 20);
  }

  aggregate<A extends AggregateArgs<T>>(args: A): Promise<AggregateResultOf<T, A>>;
  async aggregate(args: AggregateArgs<T>): Promise<AggregateResult<T>> {
    this.assertNoForceCustomPlan(args);
    this.assertNoPercentile(args);
    args = this.normalizeArgs(args);
    return this.withMiddleware('aggregate', args as unknown as Record<string, unknown>, async () => {
      const result: AggregateResult<T> = {};
      const filterParams: unknown[] = [];
      const resolvedWhere = await this.resolveRelationFilters(args.where, args.timeout, args.skipGlobalFilters);
      let where = this.buildWhere(resolvedWhere, filterParams);
      where = this.applyGlobalFilter(
        where,
        filterParams,
        await this.globalFilterWhere(args.skipGlobalFilters, args.timeout),
      );
      const filter = where ? ` filter ${where}` : '';

      // Plan every requested aggregate before any statement runs, so every
      // refusal (unknown column, the nullable per-field count gate, the PII
      // opt-in) fires with nothing sent. Each entry carries both spellings of
      // the same aggregate: the standalone scalar statement and the inner
      // expression of the one-statement form. `result`'s buckets are created
      // here, in the order the result has always had.
      // `col` is set for `_min` / `_max`, which return a stored cell and decode
      // through that column's own coercion; every other aggregate is a number.
      type Planned = {
        scalar: string;
        inner: string;
        col?: ColumnMetadata;
        /** A `_sum` over an int8 column: returned as exact decimal text (see {@link exactIntegerSumCell}). */
        exact?: boolean;
        assign: (v: unknown) => void;
      };
      const plan: Planned[] = [];
      if (args._count) {
        if (args._count === true) {
          plan.push({
            scalar: `count(${this.qt}${filter})`,
            inner: 'count(*)',
            assign: (v) => {
              result._count = (v as number | null) ?? 0;
            },
          });
        } else {
          const counts: Record<string, number> = {};
          result._count = counts;
          for (const field of Object.keys(args._count).filter((f) => (args._count as Record<string, boolean>)[f])) {
            this.assertProjectedCountSupported(field);
            const ref = this.ref(field);
            plan.push({
              scalar: `count(${this.qt}${filter} { ${ref} })`,
              inner: `count(${ref})`,
              assign: (v) => {
                counts[field] = (v as number | null) ?? 0;
              },
            });
          }
        }
      }
      for (const fn of ['_sum', '_avg', '_min', '_max'] as const) {
        const spec = args[fn];
        if (!spec) continue;
        const acc: Record<string, unknown> = {};
        (result as Record<string, unknown>)[fn] = acc;
        const powfn = fn.slice(1); // sum/avg/min/max
        for (const field of Object.keys(spec).filter((f) => (spec as Record<string, boolean>)[f])) {
          this.assertDecimalComparable(this.column(field), `\`${fn}\``);
          this.assertEnumAggregate(this.column(field), fn);
          // Same PII contract as the SQL engines: _min/_max return a stored cell.
          if (fn === '_min' || fn === '_max') {
            assertAggregatePiiOptIn(
              this.table,
              this.meta,
              field,
              this.column(field).name,
              `aggregate ${fn}`,
              resolveUnsafeFlag(args.includePii, 'includePii'),
            );
          }
          const ref = this.ref(field);
          plan.push({
            scalar: `${powfn}(${this.qt}${filter} { ${ref} })`,
            inner: `${powfn}(${ref})`,
            ...(fn === '_min' || fn === '_max' ? { col: this.column(field) } : {}),
            ...(fn === '_sum' && isInt8Column(this.column(field)) ? { exact: true } : {}),
            assign: (v) => {
              acc[field] = v;
            },
          });
        }
      }

      // A scalar cell and a grouped cell decode through the same wire decoder,
      // so one coercion serves both forms.
      const decode = (p: Planned, cell: unknown, native: boolean): unknown =>
        p.col
          ? decodeAggregateCell(cell, p.col, native, this.schema.enums)
          : p.exact
            ? exactIntegerSumCell(cell)
            : cell == null || cell === 'null'
              ? null
              : Number(cell);

      if (plan.length > 1 && this.groupsAggregatesInOneStatement) {
        const proj = plan.map((p, i) => `agg_${i}: ${p.inner}`).join(', ');
        const { rows, native } = await this.exec(
          `${this.qt}${filter} group 1 { ${proj} }`,
          [...filterParams],
          args.timeout,
          'aggregate',
        );
        // Zero groups means the filter matched no row. The per-field statements
        // below answer that case instead of a synthesized one, because what an
        // aggregate over NO rows returns is engine-versioned (`sum` answered 0
        // before PowDB 0.28 and null since), and the scalar form is the one
        // whose answer this method has always returned.
        const row = rows.length === 1 ? rows[0] : undefined;
        if (row) {
          for (const [i, p] of plan.entries()) p.assign(decode(p, row[`agg_${i}`], native));
          return result;
        }
      }
      for (const p of plan) {
        const { rows, native } = await this.exec(p.scalar, [...filterParams], args.timeout, 'aggregate');
        p.assign(decode(p, rows[0]?.value, native));
      }
      return result;
    });
  }

  groupBy<A extends GroupByArgs<T>>(args: A): Promise<GroupByResult<T, A>[]>;
  async groupBy(args: GroupByArgs<T>): Promise<Record<string, unknown>[]> {
    // The SQL engines' `by` refusals, before anything reads `by`.
    assertGroupByKeys(this.table, (args as { by?: unknown } | undefined)?.by);
    this.assertNoForceCustomPlan(args);
    this.assertNoPercentile(args);
    args = this.normalizeArgs(args);
    return this.withMiddleware('groupBy', args as unknown as Record<string, unknown>, async () => {
      // DISTINCT ON has no PowQL equivalent (no DISTINCT ON row source).
      if (args.distinctOn) {
        throw new UnsupportedFeatureError('groupBy distinctOn row source', 'PowDB');
      }
      // JSON-path group keys / aggregate targets (≥ 0.12) are gated once here.
      const usesJson =
        args.by.some((e) => typeof e !== 'string') ||
        (['_sum', '_avg', '_min', '_max'] as const).some((fn) => {
          const spec = args[fn];
          return spec !== undefined && Object.values(spec).some((v) => v != null && typeof v === 'object');
        });
      if (usesJson) {
        requireCapability(this.capabilities, 'jsonDocs', 'JSON-path groupBy keys / aggregate targets');
      }

      // `emitNative` decides whether the query GENERATION needs the legacy-wire
      // `json_type` discriminator (pool-level capability). The DECODE side reads
      // the wire that ACTUALLY served the result (`resultNative`, from exec), so
      // a per-call legacy fallback on a native-capable pool still decodes right.
      const emitNative = Boolean(this.capabilities.nativeRaw);
      const params: unknown[] = [];
      const resolvedWhere = await this.resolveRelationFilters(args.where, args.timeout, args.skipGlobalFilters);
      let where = this.buildWhere(resolvedWhere, params);
      where = this.applyGlobalFilter(where, params, await this.globalFilterWhere(args.skipGlobalFilters, args.timeout));
      const filter = where ? ` filter ${where}` : '';

      // Result-key namespace, mirroring the SQL builder's `claimResultKey`
      // (query/builder.ts): a group-key / aggregate output-name collision (with
      // `_count`, another key, or an aggregate output) throws E003.
      const usedKeys = new Set<string>();
      const claim = (key: string, what: string): void => {
        if (key === '_count' || usedKeys.has(key)) {
          throw new ValidationError(
            `groupBy output name "${key}" (${what}) collides with another output column on table ` +
              `"${this.table}": set an explicit \`alias\` (or rename the aggregate key) to disambiguate.`,
          );
        }
        usedKeys.add(key);
      };

      // Group keys + projection. `byReaders` drives the transform: a plain column
      // coerces by tsType; a JSON key reads its `gk_N` alias, disambiguating the
      // legacy-wire `null` / string-`"null"` group via its `gt_N` discriminator.
      type ByReader =
        | { kind: 'plain'; resultKey: string; rowKey: string; col: ColumnMetadata }
        | { kind: 'json'; resultKey: string; rowKey: string; discrim?: string };
      const groupExprs: string[] = [];
      const proj: string[] = [];
      const byOrderExprs = new Map<string, string>();
      const byReaders: ByReader[] = [];
      let gkN = 0;
      let gtN = 0;
      for (const entry of args.by as ((keyof T & string) | JsonPathGroupKey)[]) {
        if (typeof entry === 'string') {
          const col = this.column(entry);
          // Text grouping would put '7.5' and '7.50' in different groups.
          this.assertDecimalComparable(col, 'A groupBy key');
          assertAggregatePiiOptIn(
            this.table,
            this.meta,
            entry,
            col.name,
            'groupBy `by` key',
            resolveUnsafeFlag(args.includePii, 'includePii'),
          );
          // Keyed by the canonical FIELD, never by whichever of the column's
          // two legal spellings the caller wrote (`column` accepts both), so
          // neither the result shape nor the keys `orderBy` accepts depends on
          // that choice; `lookupGroupKey` reconciles the other spelling. Same
          // rule and same result shape as the SQL groupBy (query/aggregates.ts).
          claim(col.field, `column "${col.name}"`);
          if (col.name !== col.field) claim(col.name, `column "${col.name}"`);
          groupExprs.push(this.colRefName(col.name));
          proj.push(this.colRefName(col.name));
          byOrderExprs.set(col.field, this.colRefName(col.name));
          byReaders.push({ kind: 'plain', resultKey: col.field, rowKey: col.name, col });
        } else {
          const col = this.column(entry.field);
          if (!isJsonColumn(col, this.schema.enums)) {
            throw new ValidationError(
              `groupBy JSON group key on "${entry.field}" (table "${this.table}") requires a json column.`,
            );
          }
          assertAggregatePiiOptIn(
            this.table,
            this.meta,
            entry.field,
            col.name,
            'groupBy JSON `by` key',
            resolveUnsafeFlag(args.includePii, 'includePii'),
          );
          this.assertJsonPath('group key', entry.field, entry.path);
          const pathExpr = this.jsonPathExpr(col, entry.path, params);
          const alias = entry.alias ?? String(entry.path[entry.path.length - 1]);
          claim(alias, `JSON path on "${entry.field}"`);
          const gkAlias = `gk_${gkN++}`;
          groupExprs.push(pathExpr);
          proj.push(`${gkAlias}: ${pathExpr}`);
          byOrderExprs.set(alias, `.${gkAlias}`);
          let discrim: string | undefined;
          if (!emitNative) {
            // Legacy wire renders a missing value, JSON null, AND the string
            // "null" all as the cell "null". `min(json_type(path))` over the
            // group is "string" ONLY for the string-"null" group and "null"
            // otherwise (a bare `json_type` projection is not group-correlated).
            discrim = `gt_${gtN++}`;
            proj.push(`${discrim}: min(json_type(${pathExpr}))`);
          }
          byReaders.push({ kind: 'json', resultKey: alias, rowKey: gkAlias, discrim });
        }
      }

      // Aggregates: `agg_N` internal aliases (PowQL rejects reserved-word
      // aliases like `count:`). `aggInner` lets HAVING re-emit the exact inner
      // expression by user key; `aggOrderExprs` lets orderBy reference the alias.
      // `col` is set for a column `_min` / `_max`: a stored cell, decoded by its column.
      const aggReaders: {
        alias: string;
        outKey: string;
        numeric: boolean;
        exact?: boolean;
        col?: ColumnMetadata;
      }[] = [];
      const aggOrderExprs = new Map<string, string>();
      const aggInner = new Map<string, string>();
      let aggN = 0;
      // `_count` has the same two shapes as the SQL groupBy (query/aggregates.ts),
      // and the record form is why this is not a one-liner:
      //   - `true` / omitted → scalar `_count` (row count). Selected by DEFAULT
      //     unless the caller opts out with `_count: false`, so every groupBy row
      //     carries `_count` and `orderBy: { _count }` works without requesting it.
      //   - record form → `_all` is the row count and each field is that column's
      //     NON-NULL count, result `_count: { _all, field }`.
      // The record form used to fall through both branches here, so PowDB answered
      // `groupBy({ _count: { id: true } })` with the group keys and NO `_count` key
      // at all while every SQL engine returned the counts. Accepted and ignored is
      // the one outcome an aggregate must never have: the caller reads
      // `g._count.id` off a row that never carried it.
      const countArg = args._count as boolean | Record<string, boolean> | undefined;
      const scalarCount = countArg === true || countArg === undefined;
      const countIsRecord = !scalarCount && countArg !== false && typeof countArg === 'object';
      if (scalarCount) {
        const alias = `agg_${aggN++}`;
        proj.push(`${alias}: count(*)`);
        aggReaders.push({ alias, outKey: '_count', numeric: true });
        aggOrderExprs.set('_count', `.${alias}`);
      } else if (countIsRecord) {
        for (const [field, enabled] of Object.entries(countArg as Record<string, boolean>)) {
          if (!enabled) continue;
          const alias = `agg_${aggN++}`;
          if (field === '_all') {
            // Double underscore in the output key, collision-proof against a
            // real column named `all`, exactly as the SQL builder aliases it.
            claim('_count__all', '_count `_all`');
            proj.push(`${alias}: count(*)`);
            aggReaders.push({ alias, outKey: '_count:_all', numeric: true });
            // COUNT(*) is orderable whenever it is selected: the scalar form
            // above, or the record form containing `_all`. Same rule as SQL.
            aggOrderExprs.set('_count', `.${alias}`);
          } else {
            // Per-field count is the NON-NULL count, which the engine only
            // honours from the version `projectedCountSupported` gates on; below
            // it the projection was ignored and the ROW count came back. Same
            // per-column gate `aggregate()` applies, for the same reason.
            const col = this.column(field);
            this.assertProjectedCountSupported(field);
            claim(`_count_${col.name}`, `_count of column "${col.name}"`);
            const inner = this.colRefName(col.name);
            proj.push(`${alias}: count(${inner})`);
            aggReaders.push({ alias, outKey: `_count:${col.field}`, numeric: true });
          }
        }
      }
      for (const fn of ['_sum', '_avg', '_min', '_max'] as const) {
        const spec = args[fn] as Record<string, boolean | JsonPathAggregateTarget | undefined> | undefined;
        if (!spec) continue;
        const powfn = fn.slice(1); // sum/avg/min/max
        for (const [key, target] of Object.entries(spec)) {
          if (!target) continue;
          const alias = `agg_${aggN++}`;
          if (target === true) {
            const col = this.column(key);
            this.assertDecimalComparable(col, `\`${fn}\``);
            this.assertEnumAggregate(col, fn);
            if (fn === '_min' || fn === '_max') {
              assertAggregatePiiOptIn(
                this.table,
                this.meta,
                key,
                col.name,
                `groupBy ${fn}`,
                resolveUnsafeFlag(args.includePii, 'includePii'),
              );
            }
            claim(`${fn}_${col.name}`, `${fn} of column "${col.name}"`);
            const inner = this.colRefName(col.name);
            proj.push(`${alias}: ${powfn}(${inner})`);
            // Canonical field, so the result bucket and the keys `orderBy` /
            // `having` accept are the same whichever spelling was requested.
            aggReaders.push({
              alias,
              outKey: `${fn}:${col.field}`,
              numeric: fn === '_sum' || fn === '_avg',
              ...(fn === '_min' || fn === '_max' ? { col } : {}),
              ...(fn === '_sum' && isInt8Column(col) ? { exact: true } : {}),
            });
            aggOrderExprs.set(`${fn}:${col.field}`, `.${alias}`);
            aggInner.set(col.field, inner);
          } else {
            const col = this.column(target.field);
            if (!isJsonColumn(col, this.schema.enums)) {
              throw new ValidationError(
                `groupBy ${fn} target "${key}" on "${target.field}" (table "${this.table}") requires a json column.`,
              );
            }
            if (fn === '_min' || fn === '_max') {
              assertAggregatePiiOptIn(
                this.table,
                this.meta,
                target.field,
                col.name,
                `groupBy ${fn} JSON target`,
                resolveUnsafeFlag(args.includePii, 'includePii'),
              );
            }
            this.assertJsonPath(`${fn} target "${key}"`, target.field, target.path);
            const alwaysNumeric = fn === '_sum' || fn === '_avg';
            if (alwaysNumeric && target.type === 'text') {
              throw new ValidationError(
                `groupBy ${fn} target "${key}" on table "${this.table}": ` +
                  `${fn} over a JSON path is always numeric: remove \`type: 'text'\`.`,
              );
            }
            const numeric = alwaysNumeric || target.type === 'numeric';
            claim(`${fn}_${key}`, `${fn} JSON target "${key}"`);
            const pathExpr = this.jsonPathExpr(col, target.path, params);
            const inner = numeric ? `cast(${pathExpr}, "float")` : pathExpr;
            proj.push(`${alias}: ${powfn}(${inner})`);
            aggReaders.push({ alias, outKey: `${fn}:${key}`, numeric });
            aggOrderExprs.set(`${fn}:${key}`, `.${alias}`);
            aggInner.set(key, inner);
          }
        }
      }

      const having = this.buildHaving(args.having, params, aggInner);
      const order = this.buildGroupOrder(args.orderBy, byOrderExprs, aggOrderExprs);
      // LIMIT / OFFSET over the result groups, applied after ORDER BY (mirrors
      // the SQL groupBy). offset 0 is a no-op, matching findMany; `limit: 0` is
      // answered client-side (PowDB returned one row for it below engine 0.20).
      this.assertPagination(args.limit, args.offset, 'groupBy');
      if (args.limit === 0) return [];
      const limitClause = args.limit !== undefined ? ` limit ${this.param(args.limit, params)}` : '';
      const offsetClause = args.offset ? ` offset ${this.param(args.offset, params)}` : '';
      const powql = `${this.qt}${filter} group ${groupExprs.join(', ')}${having}${order}${limitClause}${offsetClause} { ${proj.join(', ')} }`;
      const { rows, native: resultNative } = await this.exec(powql, params, args.timeout, 'groupBy');

      // Reshape: group keys → user fields (coerced / null-disambiguated),
      // aggregates → nested `{ _sum: { field } }`; discriminators are stripped.
      // Group-key cells go through the SAME coercion policy `rowToEntity` uses,
      // by the wire that actually served this result, so a native-wire int cell
      // (bigint) or datetime cell (micros) never leaks into the result: it
      // becomes the same number / Date / PG-text-parity string an embedded /
      // legacy / SQL groupBy returns for the identical query.
      return rows.map((raw) => {
        const out: Record<string, unknown> = {};
        for (const r of byReaders) {
          if (r.kind === 'plain') {
            const cell = raw[r.rowKey];
            out[r.resultKey] = resultNative
              ? coerceNativeValue(cell, r.col)
              : typeof cell === 'string'
                ? coerceScalar(cell, r.col.tsType)
                : cell;
          } else {
            out[r.resultKey] = decodeGroupKeyCell(raw[r.rowKey], r.discrim ? raw[r.discrim] : undefined, resultNative);
          }
        }
        for (const a of aggReaders) {
          const cell = raw[a.alias];
          const v = a.col
            ? decodeAggregateCell(cell, a.col, resultNative, this.schema.enums)
            : a.exact
              ? exactIntegerSumCell(cell)
              : cell == null || cell === 'null'
                ? null
                : a.numeric
                  ? Number(cell)
                  : cell;
          if (a.outKey === '_count') out._count = (v as number) ?? 0;
          else {
            const [bucket, field] = a.outKey.split(':') as [string, string];
            out[bucket] ??= {} as Record<string, unknown>;
            (out[bucket] as Record<string, unknown>)[field] = v;
          }
        }
        return out;
      });
    });
  }

  /** Validate a JSON-path target (group key / aggregate target): non-empty array of keys/indexes. */
  private assertJsonPath(context: string, field: string, path: (string | number)[]): void {
    if (
      !Array.isArray(path) ||
      path.length === 0 ||
      path.some((el) => typeof el !== 'string' && !(typeof el === 'number' && Number.isFinite(el)))
    ) {
      throw new ValidationError(
        `groupBy ${context} on "${field}" (table "${this.table}") requires a non-empty \`path\` ` +
          `array of keys/indexes (e.g. { field: '${field}', path: ['category'] }).`,
      );
    }
  }

  /**
   * `having <expr>` over group aggregates. `_count` compares `count(*)` (parity
   * with the projection); a per-field aggregate re-emits its inner expression
   * (from `aggInner` when the field is a requested aggregate, so a JSON-path
   * aggregate reuses its bound placeholders, else `.field` for a plain column).
   *
   * Every token that reaches the PowQL text is builder-controlled: the field is
   * validated by `ref()`, the aggregate function comes from
   * {@link POWQL_HAVING_AGG_FNS} (unknown keys throw E003), the operator from a
   * fixed map, and every compared value is bound as a `$N` param.
   */
  private buildHaving(having: GroupByArgs<T>['having'], params: unknown[], aggInner: Map<string, string>): string {
    if (!having) return '';
    const conds: string[] = [];
    const cmp = (expr: string, filter: unknown) => {
      if (typeof filter === 'number') return `${expr} = ${this.param(filter, params)}`;
      const f = filter as Record<string, number>;
      // Map (not an object literal) so an inherited key such as `constructor`
      // cannot resolve to a truthy value and reach the emitted PowQL.
      const ops = new Map<string, string>([
        ['equals', '='],
        ['gt', '>'],
        ['gte', '>='],
        ['lt', '<'],
        ['lte', '<='],
        ['not', '!='],
      ]);
      return Object.entries(f)
        .filter(([k]) => ops.has(k))
        .map(([k, v]) => `${expr} ${ops.get(k)} ${this.param(v, params)}`)
        .join(' and ');
    };
    for (const [key, spec] of Object.entries(having)) {
      if (spec == null) continue;
      if (key === '_count') {
        conds.push(cmp('count(*)', spec));
      } else {
        for (const [aggKey, filter] of Object.entries(spec as Record<string, unknown>)) {
          if (filter == null) continue;
          // The function token is emitted verbatim into the PowQL text, so it
          // must come from the fixed allowlist, never from the caller's key.
          const fn = POWQL_HAVING_AGG_FNS.get(aggKey);
          if (!fn) {
            throw new ValidationError(
              `Unknown aggregate "${aggKey}" in having for field "${key}" on table "${this.table}". ` +
                `Supported: ${[...POWQL_HAVING_AGG_FNS.keys()].join(', ')}.`,
            );
          }
          const inner = this.lookupGroupKey(aggInner, key) ?? this.ref(key);
          const column = this.meta.columns.find((c) => c.field === key || c.name === key);
          if (column && fn !== 'count') this.assertDecimalComparable(column, `\`${aggKey}\` in having`);
          if (column && fn !== 'count') this.assertEnumAggregate(column, aggKey);
          conds.push(cmp(`${fn}(${inner})`, filter));
        }
      }
    }
    return conds.length ? ` having ${conds.join(' and ')}` : '';
  }

  /**
   * Compile a groupBy `orderBy` into a PowQL `order` body over the group RESULT
   * columns (by-fields, JSON group-key aliases, and requested aggregates). PowQL
   * cannot re-emit an aggregate EXPRESSION in `order` (engine error), but CAN
   * order by a projection alias on a grouped query (probed), so each key maps to
   * its projected alias (`.agg_N` / `.gk_N` / `.col`). Semantics and error
   * surface mirror the SQL `buildGroupByOrderBy` (0.32.2 R3-1): an aggregate not
   * requested in this call, or an unknown by-key, throws E003 listing the valid
   * keys. `nulls: 'first'` stays E017 (PowDB has no NULLS placement grammar).
   */
  private buildGroupOrder(
    orderBy: GroupByOrderBy | GroupByOrderBy[] | undefined,
    byOrderExprs: Map<string, string>,
    aggOrderExprs: Map<string, string>,
  ): string {
    if (!orderBy) return '';
    const aggBlocks = new Set(['_count', '_sum', '_avg', '_min', '_max']);
    const validKeys = (): string => {
      const keys = [...byOrderExprs.keys()];
      for (const k of aggOrderExprs.keys()) keys.push(k.includes(':') ? k.replace(':', '.') : k);
      return keys.join(', ') || '(none)';
    };
    const parts: string[] = [];
    for (const [key, value] of orderByEntries(orderBy)) {
      if (value === undefined) continue;
      if (aggBlocks.has(key)) {
        if (key === '_count') {
          const expr = aggOrderExprs.get('_count');
          if (!expr) {
            throw new ValidationError(
              `Cannot order groupBy by "_count" on table "${this.table}": _count is not selected. ` +
                `Orderable keys: ${validKeys()}.`,
            );
          }
          parts.push(`${expr} ${this.groupOrderDir(value, '_count')}`);
          continue;
        }
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          throw new ValidationError(
            `Invalid groupBy orderBy for "${key}" on table "${this.table}": ` +
              `expected a field map like { ${key}: { amount: 'desc' } }.`,
          );
        }
        for (const [field, dirSpec] of Object.entries(value as Record<string, unknown>)) {
          if (dirSpec === undefined) continue;
          // `field` is the caller's spelling of the aggregate's target column;
          // the registry is keyed by the canonical one.
          const expr = aggOrderExprs.get(`${key}:${field}`) ?? this.aggOrderExpr(aggOrderExprs, key, field);
          if (!expr) {
            throw new ValidationError(
              `Cannot order groupBy by "${key}.${field}" on table "${this.table}": ` +
                `that aggregate is not requested in this call. Orderable keys: ${validKeys()}.`,
            );
          }
          parts.push(`${expr} ${this.groupOrderDir(dirSpec, `${key}.${field}`)}`);
        }
        continue;
      }
      const expr = this.lookupGroupKey(byOrderExprs, key);
      if (!expr) {
        throw new ValidationError(
          `Unknown field "${key}" in groupBy orderBy on table "${this.table}". Orderable keys: ${validKeys()}.`,
        );
      }
      const keyColumn = this.meta.columns.find((c) => c.field === key || c.name === key);
      if (keyColumn) this.assertEnumOrderable(keyColumn, 'Ordering a groupBy');
      parts.push(`${expr} ${this.groupOrderDir(value, key)}`);
    }
    return parts.length ? ` order ${parts.join(', ')}` : '';
  }

  /** Resolve a groupBy order direction, refusing `nulls: 'first'` (E017); `nulls: 'last'` is a no-op. */
  private groupOrderDir(value: unknown, keyForMsg: string): string {
    if (value !== null && typeof value === 'object') {
      const spec = value as OrderBySpec;
      if (spec.nulls === 'first') {
        throw new UnsupportedFeatureError(
          'NULLS FIRST placement',
          'PowDB',
          `groupBy orderBy "${keyForMsg}": PowDB orders NULLs / missing keys LAST in both directions`,
        );
      }
      return this.dirKeyword(spec.sort, `groupBy orderBy "${keyForMsg}"`);
    }
    return this.dirKeyword(value, `groupBy orderBy "${keyForMsg}"`);
  }

  // -------------------------------------------------------------------------
  // Streaming / unsupported
  // -------------------------------------------------------------------------

  // biome-ignore lint/correctness/useYield: intentionally throws before yielding, PowDB has no server cursor.
  async *findManyStream(): AsyncGenerator<never, void, undefined> {
    throw new UnsupportedFeatureError(
      'cursor streaming (findManyStream)',
      'PowDB',
      'PowDB has no server-side cursor; page with findMany({ limit, offset }) instead',
    );
  }

  // biome-ignore lint/correctness/useYield: intentionally throws before yielding, PowDB has no server cursor.
  async *findManyStreamBatches(): AsyncGenerator<never, void, undefined> {
    throw new UnsupportedFeatureError(
      'cursor streaming (findManyStreamBatches)',
      'PowDB',
      'PowDB has no server-side cursor; page with findMany({ limit, offset }) instead',
    );
  }

  // Deferred queries. `db.pipeline()` and `$transaction([...])` take a
  // prebuilt statement, and a PowDB read is several round trips (relation
  // filters resolve first, loaders run after), so there is no single statement
  // to hand over. Each stub throws the typed refusal when called, which is
  // before the pipeline or transaction starts.

  private deferredUnsupported(method: string): never {
    throw new UnsupportedFeatureError(
      `deferred query (${method})`,
      'PowDB',
      'db.pipeline() and $transaction([...]) take deferred queries; run the calls inside ' +
        'db.$transaction(async (tx) => ...) instead',
    );
  }

  buildFindMany(_args?: unknown): never {
    return this.deferredUnsupported('buildFindMany');
  }

  buildFindFirst(_args?: unknown): never {
    return this.deferredUnsupported('buildFindFirst');
  }

  buildFindFirstOrThrow(_args?: unknown): never {
    return this.deferredUnsupported('buildFindFirstOrThrow');
  }

  buildFindUnique(_args?: unknown): never {
    return this.deferredUnsupported('buildFindUnique');
  }

  buildFindUniqueOrThrow(_args?: unknown): never {
    return this.deferredUnsupported('buildFindUniqueOrThrow');
  }

  buildCount(_args?: unknown): never {
    return this.deferredUnsupported('buildCount');
  }

  buildAggregate(_args?: unknown): never {
    return this.deferredUnsupported('buildAggregate');
  }

  buildGroupBy(_args?: unknown): never {
    return this.deferredUnsupported('buildGroupBy');
  }

  buildCreate(_args?: unknown): never {
    return this.deferredUnsupported('buildCreate');
  }

  buildCreateMany(_args?: unknown): never {
    return this.deferredUnsupported('buildCreateMany');
  }

  buildUpdate(_args?: unknown): never {
    return this.deferredUnsupported('buildUpdate');
  }

  buildUpdateMany(_args?: unknown): never {
    return this.deferredUnsupported('buildUpdateMany');
  }

  buildDelete(_args?: unknown): never {
    return this.deferredUnsupported('buildDelete');
  }

  buildDeleteMany(_args?: unknown): never {
    return this.deferredUnsupported('buildDeleteMany');
  }

  buildUpsert(_args?: unknown): never {
    return this.deferredUnsupported('buildUpsert');
  }

  /** SQL template cache counters. PowDB keeps no statement cache, so every counter is zero. */
  cacheStats(): { hits: number; misses: number; hitRate: number; size: number } {
    return { hits: 0, misses: 0, hitRate: 0, size: 0 };
  }

  // -------------------------------------------------------------------------
  // Reselect helper (upsert only, PowDB's upsert has no `returning`)
  // -------------------------------------------------------------------------

  /** Reselect a single row by its single-column primary key value. */
  private async reselectByPk(
    pkValue: unknown,
    timeout?: number,
    shape?: { select?: Record<string, boolean>; omit?: Record<string, boolean>; skipGlobalFilters?: unknown },
  ): Promise<T | null> {
    const pkField = this.meta.reverseColumnMap[this.meta.primaryKey[0]!] ?? this.meta.primaryKey[0]!;
    const { rows, native } = await this.runFind({
      where: { [pkField]: pkValue } as WhereClause<T>,
      limit: 1,
      timeout,
      select: shape?.select,
      omit: shape?.omit,
      ...(shape?.skipGlobalFilters === undefined ? {} : { skipGlobalFilters: shape.skipGlobalFilters }),
    } as FindManyArgs<T>);
    return rows.length ? this.shape(rows, native)[0]! : null;
  }

  /**
   * AND this table's configured global filter (soft-delete / multi-tenancy)
   * onto an ALREADY-COMPILED user filter, pushing its params after the user's.
   *
   * Before 0.74.0 `PowqlInterface` did not read `globalFilters` at all, so a
   * client configured for multi-tenancy applied its tenant predicate on every
   * SQL engine and NONE on PowDB, silently, and `skipGlobalFilters` was
   * accepted and inert. The rule itself is shared
   * ({@link resolveGlobalFilterFrom}) rather than restated here.
   *
   * It takes a COMPILED user filter, and that ordering is the contract, not an
   * implementation detail: the empty-`where` guard must see the USER filter
   * alone, or a configured global filter would silently satisfy it and turn a
   * refused mass mutation into an accepted one. Every write call site therefore
   * calls {@link assertCompiledWhere} first and this second.
   *
   * `alias` is forwarded so the nested/native-join paths qualify the filter's
   * column references the same way they qualify the user's.
   */
  private applyGlobalFilter(
    compiledUserWhere: string,
    params: unknown[],
    gf: WhereClause<T> | undefined,
    alias?: string,
  ): string {
    if (!gf) return compiledUserWhere;
    const gfWhere = this.buildWhere(gf, params, alias);
    if (!gfWhere) return compiledUserWhere;
    if (!compiledUserWhere) return gfWhere;
    return `(${compiledUserWhere}) and (${gfWhere})`;
  }

  /**
   * Tables whose global filter is being resolved by an operation above this
   * interface. A relation filter inside a global filter runs its own query on
   * the related table, which applies THAT table's filter, so two filters that
   * reach each other through relations would resolve forever; each table's
   * filter applies once per chain instead.
   */
  private get globalFilterStack(): readonly string[] {
    return (this.options as { _globalFilterStack?: readonly string[] })._globalFilterStack ?? [];
  }

  /** Whether this table's global filter constrains an operation under `skip`. */
  private hasGlobalFilter(skip: unknown): boolean {
    if (this.globalFilterStack.includes(this.table)) return false;
    const gf = resolveGlobalFilterFrom(
      this.options.globalFilters,
      this.table,
      resolveSkipGlobalFilters(skip),
      this.schema.tables,
    );
    return gf != null && !this.compilesToNothing(gf);
  }

  /**
   * This table's global filter for one operation, ready for
   * {@link applyGlobalFilter}: read under SQL three-valued logic, with every
   * relation filter in it (`posts: { some: ... }`, `user: { is: ... }`)
   * resolved to a literal key list by the same client-side resolution a
   * caller's `where` gets. The related table's own global filter bounds those
   * lookups, as on the SQL engines, and `skip` reaches them too.
   */
  private async globalFilterWhere(skip: unknown, timeout?: number): Promise<WhereClause<T> | undefined> {
    const stack = this.globalFilterStack;
    if (stack.includes(this.table)) return undefined;
    const gf = resolveGlobalFilterFrom(
      this.options.globalFilters,
      this.table,
      resolveSkipGlobalFilters(skip),
      this.schema.tables,
    ) as WhereClause<T> | null | undefined;
    if (!gf) return undefined;
    if (!this.namesRelation(gf)) return this.sqlTrueWhere(gf);
    const scoped = new PowqlInterface<T>(this.pool, this.table, this.schema, [], {
      ...this.loaderChildOptions(),
      _globalFilterStack: [...stack, this.table],
    } as QueryInterfaceOptions);
    return scoped.resolveRelationFilters(gf, timeout, skip);
  }

  /** Whether `where` holds a relation filter at any combinator depth. */
  private namesRelation(where: unknown): boolean {
    if (where === null || typeof where !== 'object' || Array.isArray(where)) return false;
    for (const [key, value] of Object.entries(where)) {
      if (value === undefined) continue;
      if (isCombinatorKey(key)) {
        const branches = combinatorBranches(key, value, this.table);
        if (branches?.some((w) => this.namesRelation(w))) return true;
      } else if (resolveRelationDef(this.meta.relations, key)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Empty-where guard, blocks accidental whole-table writes. Mirrors the SQL
   * path's `assertMutationHasPredicate` (query/where.ts): it gates on the
   * *compiled* PowQL filter fragment, NOT the shape of the `where` object, so a
   * `where` whose conditions all evaporate during compilation (`{}`,
   * `{ id: undefined }`, `{ AND: [] }`, `{ NOT: {} }`) is refused. A where that
   * compiles but is TRUE for every row (`NOT: { OR: [] }`, `id: { notIn: [] }`)
   * writes every row just the same, so `userWhere`, the caller's where before
   * relation filters were resolved, is folded by the SQL engines' rule
   * (`foldWhereFor`) and refused too.
   *
   * The fold also reads the schema's NOT NULL columns, as the SQL guard does:
   * `{ name: { not: null } }` or `NOT: { name: null }` on a NOT NULL column is
   * TRUE for every row (PowDB's `required` holds the same guarantee). It does
   * NOT trust foreign keys: PowDB declares none, so an orphan row is possible
   * and a belongsTo `is: {}` stays a condition.
   */
  private assertCompiledWhere(
    compiledWhere: string,
    allow: boolean | undefined,
    action: string,
    userWhere: WhereClause<T> | undefined,
  ): void {
    if (allow === true) return;
    if (
      compiledWhere.length > 0 &&
      (userWhere === undefined ||
        foldWhereFor(this.schema.tables, this.table, userWhere as Record<string, unknown>, POWDB_GUARD_FOLD) !== 'true')
    ) {
      return;
    }
    throw new ValidationError(emptyMutationWhereMessage(action, this.table));
  }
}

/**
 * The mass-mutation guard's fold options on PowDB (see `assertCompiledWhere`):
 * NOT NULL columns count, foreign keys do not (PowDB enforces none).
 */
const POWDB_GUARD_FOLD: WhereFoldOptions = {
  notNull: { foreignKeys: false, hasGlobalFilter: () => true },
};

/** Marks a default expression {@link emulateColumnDefault} cannot evaluate. */
const NO_DEFAULT = Symbol('turbine.powdb.noDefault');

/**
 * Evaluate a column's SQL default expression client-side, for one insert.
 *
 * Covers what `defineSchema` accepts (NULL, TRUE / FALSE, numeric and quoted
 * string literals, now() / current_timestamp, current_date, gen_random_uuid())
 * plus the trailing `::type` cast and wrapping parentheses introspection adds.
 * Anything else returns {@link NO_DEFAULT}: a guessed value would be a silent
 * divergence from the engine the schema was written for.
 */
function emulateColumnDefault(expr: string, col: ColumnMetadata, enums: PowdbEnums | undefined): unknown {
  let e = expr.trim();
  for (;;) {
    const unwrapped = e.replace(/::[a-z_][a-z0-9_ ]*(\(\d+(,\s*\d+)?\))?(\[\])?$/i, '').trim();
    const stripped = /^\((.*)\)$/s.test(unwrapped) ? unwrapped.slice(1, -1).trim() : unwrapped;
    if (stripped === e) break;
    e = stripped;
  }
  const ts = baseTsType(col.tsType);
  const upper = e.toUpperCase();
  if (upper === 'NULL') return null;
  if (upper === 'TRUE' || upper === 'FALSE') return ts === 'boolean' ? upper === 'TRUE' : NO_DEFAULT;
  if (
    ['NOW()', 'CURRENT_TIMESTAMP', 'LOCALTIMESTAMP', 'TRANSACTION_TIMESTAMP()', 'STATEMENT_TIMESTAMP()'].includes(upper)
  ) {
    return ts === 'Date' ? new Date() : NO_DEFAULT;
  }
  if (upper === 'CURRENT_DATE') {
    if (ts !== 'Date') return NO_DEFAULT;
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
  if (upper === 'GEN_RANDOM_UUID()' || upper === 'UUID_GENERATE_V4()')
    return ts === 'string' ? randomUUID() : NO_DEFAULT;
  const quoted = /^'((?:[^']|'')*)'$/s.exec(e);
  const literal = quoted ? quoted[1]!.replace(/''/g, "'") : /^-?\d+(\.\d+)?$/.test(e) ? e : undefined;
  if (literal === undefined) return NO_DEFAULT;
  // An enum default is one of its labels, stored as the label text.
  const labels = powdbEnumLabels(col, enums);
  if (labels) return labels.includes(literal) ? literal : NO_DEFAULT;
  if (isJsonColumn(col, enums)) {
    try {
      return JSON.parse(literal);
    } catch {
      return NO_DEFAULT;
    }
  }
  switch (ts) {
    case 'string':
      return literal;
    case 'number': {
      const n = Number(literal);
      if (literal.trim() === '' || !Number.isFinite(n)) return NO_DEFAULT;
      // An int8 default past 2^53 keeps every digit, as the column does.
      return isInt8Column(col) && /^-?\d+$/.test(literal) && !Number.isSafeInteger(n) ? BigInt(literal) : n;
    }
    case 'bigint':
      return /^-?\d+$/.test(literal) ? BigInt(literal) : NO_DEFAULT;
    case 'boolean': {
      const b = literal.toLowerCase();
      if (['t', 'true', 'y', 'yes', 'on', '1'].includes(b)) return true;
      if (['f', 'false', 'n', 'no', 'off', '0'].includes(b)) return false;
      return NO_DEFAULT;
    }
    case 'Date': {
      // A zone-less literal is UTC, as Turbine reads a zone-less timestamp.
      const zoned = /^\d{4}-\d\d-\d\d$/.test(literal) || /([zZ]|[+-]\d\d(:?\d\d)?)$/.test(literal);
      const d = new Date(zoned ? literal : `${literal.replace(' ', 'T')}Z`);
      return quoted && !Number.isNaN(d.getTime()) ? d : NO_DEFAULT;
    }
    default:
      return NO_DEFAULT;
  }
}

/**
 * Decode a `_min` / `_max` cell, which is a stored value of `col`, through the
 * same per-column coercion a row read uses: a string stays a string, a Date
 * column's micros become a Date, a bigint keeps its digits. Reading it as a
 * number turned every text minimum into null and every date into micros.
 */
/**
 * Whether `col` is a 64-bit integer column (`int8` / `bigint`), the type whose
 * `SUM` PostgreSQL widens to `numeric` and the SQL engines return as exact
 * decimal text rather than a JS number (query/aggregates.ts,
 * `isExactNumericType`). A column read from a live PowDB catalog reports the
 * engine's `int` and is not recognised, so its sum stays a number.
 */
function isInt8Column(col: ColumnMetadata): boolean {
  const pgType = col.pgType ?? '';
  const paren = pgType.indexOf('(');
  const base = (paren === -1 ? pgType : pgType.slice(0, paren)).trim().toLowerCase();
  return base === 'int8' || base === 'bigint';
}

/**
 * A `_sum` over an int8 column, as PostgreSQL returns it: the exact decimal
 * text, so a total past 2^53 keeps every digit. The native wire delivers the
 * engine's i64 as a `bigint` and the legacy wire as text; both are exact.
 */
function exactIntegerSumCell(cell: unknown): string | null {
  if (cell === undefined || cell === null || cell === 'null') return null;
  if (typeof cell === 'bigint') return cell.toString();
  if (typeof cell === 'number' && Number.isInteger(cell)) return BigInt(cell).toString();
  return String(cell);
}

/**
 * Whole-document equality on a json column (a bare object or array, or
 * `equals` with no `path`): PowQL has no document comparison, so it is an
 * engine gap (E017) on every spelling, never a value bound as data.
 */
function jsonDocumentEqualityUnsupported(col: ColumnMetadata): UnsupportedFeatureError {
  return new UnsupportedFeatureError(
    'JSON document equality (equals without path)',
    'PowDB',
    `column "${col.name}": pass a \`path\` to compare a specific json value; PowQL has no whole-document comparison`,
  );
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/**
 * The value integer text names for an integer column: a number when it is a
 * safe integer, else a bigint, so an int8 past 2^53 keeps every digit. Text
 * that is not an integer is refused (E003), as PostgreSQL refuses it.
 */
function integerTextValue(text: string, col: ColumnMetadata, table: string): number | bigint {
  const trimmed = text.trim();
  const shown = JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}...` : text);
  if (!/^[+-]?\d+$/.test(trimmed)) {
    throw new ValidationError(
      `Invalid value ${shown} for the integer column "${col.name}" on "${table}": expected an integer. ` +
        "Pass a number, a bigint, or integer text such as '42'.",
    );
  }
  const big = BigInt(trimmed);
  if (big < INT64_MIN || big > INT64_MAX) {
    throw new ValidationError(
      `Invalid value ${shown} for the integer column "${col.name}" on "${table}": it is outside the 64-bit range.`,
    );
  }
  const n = Number(big);
  return Number.isSafeInteger(n) ? n : big;
}

/** ISO 8601 date or date-time text: date, optional time and fraction, optional zone. */
const ISO_DATE_TEXT =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/**
 * The epoch micros a Date column stores for `text`, read the way PostgreSQL
 * reads the same text against a `date` / `timestamp` column, so
 * `{ birthday: '2000-02-29' }` matches what `{ birthday: new Date(...) }` does.
 *
 *   - A `date` column takes the calendar day and ignores any time or zone
 *     (PostgreSQL's date input does the same), at UTC midnight, which is how
 *     Turbine reads and writes a date.
 *   - Any other Date column takes the full instant; text with no zone is UTC,
 *     Turbine's zone-less convention. Up to microsecond precision is kept.
 *
 * Only ISO 8601 text is read. PostgreSQL also accepts words (`now`,
 * `infinity`) and other layouts; those are refused (E003) rather than guessed.
 */
function isoTextMicros(text: string, col: ColumnMetadata, table: string): bigint {
  const refuse = (why: string): ValidationError =>
    new ValidationError(
      `Invalid date text ${JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}...` : text)} for the Date ` +
        `column "${col.name}" on "${table}": ${why}. PowDB stores the column as epoch microseconds, so text is ` +
        'read as ISO 8601 (YYYY-MM-DD, optionally a time and a zone). Pass a Date for anything else.',
    );
  const m = ISO_DATE_TEXT.exec(text.trim());
  if (!m) throw refuse('it is not ISO 8601');
  const [, y, mo, d, hh, mi, ss, frac, zone] = m;
  const isDate = (col.pgType ?? '').trim().toLowerCase() === 'date';
  const day = new Date(0);
  day.setUTCFullYear(Number(y), Number(mo) - 1, Number(d));
  if (day.getUTCFullYear() !== Number(y) || day.getUTCMonth() !== Number(mo) - 1 || day.getUTCDate() !== Number(d)) {
    throw refuse('it names no calendar day');
  }
  if (isDate) return BigInt(day.getTime()) * 1000n;
  // PostgreSQL reads zone-less text against timestamptz in the SESSION time
  // zone, a server setting PowDB has no counterpart for, so no single reading
  // matches it; a plain `timestamp` has no zone and is read as UTC.
  if (!zone && /^timestamptz$|with time zone/i.test((col.pgType ?? '').trim())) {
    throw refuse('it has no zone, and PostgreSQL would read it in the session time zone; add Z or an offset');
  }
  const hours = Number(hh ?? 0);
  const minutes = Number(mi ?? 0);
  const seconds = Number(ss ?? 0);
  if (hours > 23 || minutes > 59 || seconds > 59) throw refuse('its time is out of range');
  let offsetMinutes = 0;
  if (zone && zone.toUpperCase() !== 'Z') {
    const digits = zone.slice(1).replace(':', '');
    const oh = Number(digits.slice(0, 2));
    const om = Number(digits.slice(2) || 0);
    if (oh > 15 || om > 59) throw refuse('its zone offset is out of range');
    offsetMinutes = (zone[0] === '-' ? -1 : 1) * (oh * 60 + om);
  }
  const ms = day.getTime() + ((hours * 60 + minutes - offsetMinutes) * 60 + seconds) * 1000;
  // Microseconds past the second, from the first six fraction digits (PostgreSQL rounds the rest).
  const fracMicros = frac ? Math.round(Number(`0.${frac}`) * 1e6) : 0;
  return BigInt(ms) * 1000n + BigInt(fracMicros);
}

function decodeAggregateCell(
  cell: unknown,
  col: ColumnMetadata,
  native: boolean,
  enums: PowdbEnums | undefined,
): unknown {
  if (cell === undefined || cell === null) return null;
  if (native) return coerceNativeValue(cell, col);
  // Legacy string wire: an aggregate over no rows renders the bareword `null`.
  if (typeof cell !== 'string') return cell;
  return cell === 'null' ? null : coerceValue(cell, col, enums);
}

/** Coerce a group-key scalar string by the column's TS type (numbers/bools). */
function coerceScalar(raw: string, tsType: string): unknown {
  const ts = baseTsType(tsType);
  if (raw === 'null') return null;
  if (ts === 'number' || ts === 'bigint') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (ts === 'boolean') return raw === 'true';
  if (ts === 'Date') return new Date(Number(raw) / 1000);
  return raw;
}

/**
 * Decode a JSON group-key cell, resolving the legacy-wire `null` ambiguity AND
 * normalizing the native typed wire to the SAME PG-`#>>`-text-parity shape.
 *
 * On the native typed wire (`native`) a cell arrives pre-typed (a JSON int as a
 * `bigint`, a bool as `boolean`, an unset value as `null`). Returned as-is that
 * would diverge from every other transport: the embedded / legacy / SQL wire
 * all yield the extracted TEXT (`'7'`, `'true'`), and a raw `bigint` even throws
 * on `JSON.stringify`. So a native scalar cell is rendered to its text form
 * ({@link nativeJsonKeyText}); `null`/`empty` stays `null`, and a genuine string
 * `"null"` stays the string (the wart the native wire was adopted to fix).
 *
 * On the legacy string wire a missing value, JSON null, AND the string `"null"`
 * all render the cell `"null"`; the group's `min(json_type(…))` discriminator is
 * `"string"` ONLY for the string-`"null"` group, so the cell is the string
 * `"null"` iff the discriminator is `"string"`, else `null`. Other cell values
 * pass through as the extracted string.
 */
function decodeGroupKeyCell(cell: unknown, discrim: unknown, native: boolean): unknown {
  if (native) return nativeJsonKeyText(cell);
  if (cell == null) return null;
  if (cell === 'null') return discrim === 'string' ? 'null' : null;
  return cell;
}

/**
 * Render a native-wire JSON group-key cell to the extracted-text shape the other
 * transports return (PG `#>>` / embedded legacy / SQL all give text keys). Keeps
 * `null` as `null`; a scalar (`bigint`/`number`/`boolean`/`string`) becomes its
 * string form; an object/array json sub-document is stringified (best-effort
 * parity: canonical byte-for-byte matching is not guaranteed for nested docs).
 */
function nativeJsonKeyText(cell: unknown): unknown {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === 'bigint') return cell.toString();
  if (typeof cell === 'number' || typeof cell === 'boolean') return String(cell);
  if (typeof cell === 'string') return cell;
  try {
    return JSON.stringify(cell);
  } catch {
    return String(cell);
  }
}
