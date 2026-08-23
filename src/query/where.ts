/**
 * turbine-orm: WHERE-clause compilation (extracted from builder.ts)
 *
 * The whole WHERE web: the top-level build/collect/fingerprint trio, the
 * table-scoped trio for relation-filter EXISTS sub-wheres and relation
 * `with`-clause wheres, the leaf JSON/array/vector/text-search clause builders,
 * operator-clause + column-reference compilation, and the client-level
 * global-filter helpers. All functions take a {@link BuilderCtx} as their first
 * argument: the privacy-preserving view of the owning {@link QueryInterface}
 * instance (built once in its constructor) exposing exactly the class-resident
 * primitives this module needs. See builder.ts for the thin delegating methods.
 */

import type { Dialect } from '../dialect.js';
import { getErrorMessageMode, UnsupportedFeatureError, ValidationError } from '../errors.js';
import type { PgCompatQueryResult } from '../pg-types.js';
import type { RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';
import { camelToSnake, normalizeKeyColumns } from '../schema.js';
import type { TemporalInfinityReading } from './deferred.js';
import {
  assertBindableEqualsOperand,
  findArrayUniqueKey,
  findJsonUniqueKey,
  isArrayFilter,
  isColumnRef,
  isJsonFilter,
  isUnmatchedPlainObject,
  isWhereOperator,
  JSON_FILTER_KEYS,
  JSON_RANGE_OPERATORS,
  JSON_STRING_OPERATORS,
  VECTOR_DISTANCE_COMPARATORS,
  VECTOR_METRIC_OPERATORS,
  validateTextSearchConfig,
} from './filters.js';
import type {
  ArrayFilter,
  ColumnRef,
  GlobalFilters,
  JsonEncoding,
  JsonFilter,
  JsonPathOrderBy,
  ResolvedSkipGlobalFilters,
  TextSearchFilter,
  VectorFilter,
  WhereClause,
  WhereOperator,
} from './types.js';
import {
  coerceTemporalValue,
  escapeLike,
  isInternalCombinator,
  markInternalCombinator,
  OPERATOR_KEYS,
  ownLookup,
  resolveColumnName,
  type SqlCacheEntry,
} from './utils.js';
import {
  assertWhereDepth,
  classifyScalarForSql,
  fingerprintScalarToken,
  type WhereHost,
  type WhereRecord,
  walkWhere,
} from './where-compile.js';

/**
 * The privacy-preserving view of a {@link QueryInterface} instance passed as the
 * first argument to every function in this module. Built once as an object
 * literal in the QueryInterface constructor (mirroring the `whereHost`
 * precedent). Data fields are live references to the instance's own state;
 * `currentSkip` is a live getter (it is reassigned per `build*` call). The
 * method members are the class-resident primitives these functions still need.
 */
export interface BuilderCtx {
  readonly dialect: Dialect;
  readonly table: string;
  readonly schema: SchemaMetadata;
  readonly tableMeta: TableMetadata;
  readonly whereHost: WhereHost;
  readonly globalFilters?: GlobalFilters;
  readonly scopedHostCache: Map<string, WhereHost>;
  readonly columnPgTypeMap: Map<string, string>;
  readonly columnArrayTypeMap: Map<string, string>;
  /**
   * The client's `utcTimestamps` setting, when the owning QueryInterface
   * supplies it. Optional so an older ctx literal (and every test that builds
   * one by hand) keeps the default. `false` opts out of BOTH the UTC read
   * parsing and the symmetric UTC bind rewriting for zone-less `date` /
   * `timestamp` columns (see `coerceWriteValue` in writes.ts).
   */
  readonly utcTimestamps?: boolean;
  /**
   * The client's `temporalInfinity` reading (`'preserve'` default, `'null'`).
   * Read by aggregates.ts, where `_min` / `_max` are assembled from the raw row
   * and so cannot go through `parseRow`. Optional so a hand-built ctx keeps the
   * default.
   */
  readonly temporalInfinity?: TemporalInfinityReading;
  readonly crossSchemaTypeColumns: Set<string>;
  /**
   * The active query's `skipGlobalFilters` opt-out. A live getter/setter over
   * the owning instance's field: `build*` methods set it at their top, and the
   * synchronous SQL-build + param-collect tree reads it deep inside
   * `resolveGlobalFilter`.
   */
  currentSkip: ResolvedSkipGlobalFilters | undefined;
  /**
   * Record that the statement being COMPILED right now has a SQL text whose
   * LENGTH is a function of an arity the caller chose, rather than of the
   * application's code. Two shapes qualify:
   *
   *  1. a caller-written `AND` / `OR` combinator array (one parenthesised
   *     branch per element), marked in {@link buildWhereClause} and its
   *     table-scoped twin;
   *  2. an `orderBy` longer than {@link MAX_NAMED_ORDER_KEYS} (one comma-
   *     separated term per entry), marked in relations.ts' `buildOrderBy` and
   *     `buildRelationOrderClause`.
   *
   * WHY THIS EXISTS, since it is the only "tell the builder something about the
   * shape" callback on this interface. Every distinct SQL text Turbine emits is
   * parsed on the server as a NAMED prepared statement (the name is a hash of
   * the text) and is never DEALLOCATEd. The client-side template cache is an
   * LRU bounded at 1,000 entries; the SERVER side has no bound at all, and each
   * pooled connection accumulates its own. That is fine while the set of SQL
   * texts is fixed by the application's code, which it is for every clause
   * except these: a `where.OR` assembled from a UI multi-select, or an
   * `orderBy` assembled from an "advanced sort" panel, lets a caller mint
   * unbounded distinct statements with no identifier and no value under their
   * control. Measured on PostgreSQL 16: 600 distinct `OR` arities left 600
   * prepared statements and 20.9 MB of CachedPlan memory resident on ONE
   * connection, and 200 further executions of an existing shape reclaimed none
   * of it. The `orderBy` half was measured the same way and is worse in one
   * respect: repeating a single key (`[{id:'asc'}, {id:'asc'}, ...]`) reached
   * eight distinct statements from ONE column, so the arity was not even
   * bounded by the table's width. That particular door is closed separately and
   * more directly, by refusing duplicate sort keys outright
   * ({@link dedupeOrderEntries}); this mark handles what remains, which is
   * the PERMUTATION space of distinct columns.
   *
   * `in: [...]` is deliberately NOT this shape and is not marked: it binds
   * `= ANY($1)`, one parameter whatever the list length, so a thousand-element
   * `in` is still one statement.
   *
   * What the mark does: {@link acquireSql} reads it immediately after the build
   * closure returns and gives the cache entry an EMPTY prepared-statement name,
   * so every execution of that shape goes out unnamed. Unnamed is what bounds
   * the server: node-postgres only skips `Parse` for a statement it has already
   * parsed BY NAME, so an unnamed statement is re-parsed each execution and
   * replaces the single unnamed cached plan source instead of adding to the
   * named table. It is the same mechanism the per-query `forceCustomPlan`
   * option uses, and it changes NO SQL text.
   *
   * The cost is honest and worth stating: a fixed two-branch `OR` (a search box
   * over name and email, say) is not actually variable-arity, and it loses its
   * named statement too, because the builder sees one call and cannot know
   * whether the length varies across calls. It pays one server-side parse per
   * execution and gives up generic-plan promotion, which for a skewed predicate
   * is frequently the better plan anyway. The `orderBy` threshold is chosen so
   * that this cost lands only on shapes that are already unusual: see
   * {@link MAX_NAMED_ORDER_KEYS}.
   */
  markVariableArity(): void;
  q(name: string): string;
  p(index: number): string;
  inParam(values: unknown): unknown;
  inClause(expr: string, paramRef: string, negated: boolean): string;
  toColumn(field: string): string;
  // Shared primitives reached by the aggregate/groupBy module (aggregates.ts).
  castAgg(expr: string, target: 'int' | 'float'): string;
  parseRow(row: Record<string, unknown>, table: string): Record<string, unknown>;
  nullsSuffix(nulls: 'first' | 'last' | undefined): string;
  isRelationOrderByValue(value: unknown): boolean;
  resolveOrderByColumn(table: string, meta: TableMetadata, key: string): string;
  buildJsonPathOrderEntry(
    table: string,
    meta: TableMetadata,
    field: string,
    spec: JsonPathOrderBy,
    prefix: string,
    params?: unknown[],
  ): string;
  // Shared primitives reached by the write module (writes.ts).
  toSqlColumn(field: string): string;
  mutationInsertId(result: PgCompatQueryResult): unknown;
  acquireSql(cacheKey: string, build: (params: unknown[]) => string): SqlCacheEntry;
  crossCheckCache(
    op: string,
    cacheKey: string,
    entry: SqlCacheEntry,
    build: (params: unknown[]) => string,
    collectedParams: unknown[],
  ): void;
  // Shared primitives + state reached by the relation/orderBy module (relations.ts).
  /**
   * The relation JSON encoding of the query BEING BUILT: its own `jsonEncoding`
   * arg, else the client's, which is `'positional'` on PostgreSQL and
   * `'object'` on every other engine.
   *
   * A live getter on the concrete ctx (like `currentSkip`), not a value copied
   * at construction, because it is now a per-query option. `readonly` here says
   * the modules may not write it, not that it cannot change between builds.
   */
  readonly jsonEncoding: JsonEncoding;
  readonly camelDateFieldCache: Map<string, Set<string>>;
  /**
   * Per-table memo of `Object.entries(meta.relations)`. See
   * `getRelationEntries` in relations.ts: the nested-row parser walks it once
   * per ROW, so rebuilding the array there was the hottest allocation in the
   * parse path.
   */
  readonly relationEntryCache: Map<string, [string, RelationDef][]>;
  limitOneClause(): string;
  buildPagination(limitPh: string | undefined, offsetPh: string | undefined, hasOrderBy: boolean): string;
  paginationRef(value: unknown, params: unknown[], arg?: string): string;
  /**
   * Coerce + validate a LIMIT/OFFSET argument (non-negative safe integer).
   * The cache-hit param-collect paths call it directly, so a warmed template
   * can never bind an unvalidated NaN (which Postgres reads as "no limit").
   */
  paginationValue(value: unknown, arg?: string): number;
}

/**
 * LIKE-escape one bound operand through the ACTIVE dialect, falling back to the
 * shared {@link escapeLike} (`\`, `%`, `_`) when the dialect declares no
 * override. See {@link Dialect.escapeLikePattern} for why an engine would need
 * one (T-SQL also treats `[` as a character-class opener, so the standard set
 * leaves `{ contains: '[draft]' }` matching any title containing d, r, a, f or
 * t).
 *
 * Every LIKE operand in this module goes through here, the scalar
 * `contains`/`startsWith`/`endsWith` family and the JSON substring operators,
 * on BOTH the SQL-build and the cache-hit param-collect side. That is the point
 * of routing it through one function: the two sides must escape identically or
 * a warmed template binds a differently-escaped value than the one its SQL was
 * compiled for.
 */
function likeOperand(qi: BuilderCtx, value: string): string {
  return qi.dialect.escapeLikePattern?.(value) ?? escapeLike(value);
}

/**
 * Render a caller-supplied VALUE for an error message, or a neutral placeholder
 * when the process is in the default `'safe'` error-message mode.
 *
 * SECURITY.md states that where-clause values are rendered as key names only.
 * These JSON-operator diagnostics used to interpolate the operand verbatim, and
 * the `path`-missing branch fires on a perfectly VALID value whose only problem
 * is a missing `path`, so the leak was not limited to malformed input: a
 * `stringContains` search term reached the error text (and from there a log
 * aggregator or an API error body) on a query the caller merely wrote wrong.
 *
 * Same gate the `NotFoundError` where-rendering already uses, so one setting
 * governs both.
 */
function valueForMessage(value: unknown): string {
  return getErrorMessageMode() === 'verbose' ? JSON.stringify(value) : '<value>';
}

/**
 * Column-reference resolution context threaded into
 * {@link QueryInterface.buildOperatorClauses} / `collectOperatorParams`: the
 * table whose fields a `{ col }` reference may name, plus the SQL prefix
 * (`''` top-level, `"table".` in relation-filter subqueries, `t0.` against a
 * relation alias) the compiled identifier must carry so it resolves in the
 * same scope as the operator's own column.
 */
interface ColumnRefContext {
  meta: TableMetadata;
  table: string;
  prefix: string;
  /**
   * The operator's own RAW (unquoted) column name. The `column` argument the
   * operator builders receive is already quoted on the build side and raw on
   * the collect side, so the temporal bind rewrite resolves the column's type
   * from here instead, the one value both sides pass identically.
   */
  rawColumn: string;
}

/**
 * A table-scoped WHERE compilation context for a sub-where that is NOT the
 * top-level `this.tableMeta` clause. Both relation-filter `EXISTS` sub-wheres
 * (correlated against the bare target table, `"target".col`) and relation
 * `with`-clause `where` filters (against a per-subquery alias, `t0.col`) compile
 * an arbitrary target table's where against a column qualifier. They differ ONLY
 * in that qualifier, the correlation parent handed to `buildRelationFilter`, and
 * the unknown-column error wording, so a single scoped build/collect/fingerprint
 * trio, driven by the SAME canonical {@link walkWhere} the top level uses, serves
 * both. See `buildScopedWhere` / `collectScopedWhereParams` / `fingerprintScopedWhere`.
 */
interface WhereScope {
  /** The target table's metadata (column map, relations, types). */
  meta: TableMetadata;
  /** The target table name (used for host binding + error messages). */
  table: string;
  /** SQL prefix before `q(col)`, `"target".` for EXISTS sub-wheres, `t0.` for aliases. */
  qualifier: string;
  /** The `parentTable` correlation argument for nested `buildRelationFilter` calls. */
  relationParent: string;
  /** {@link WhereHost} bound to `meta`, so {@link walkWhere} enumerates this scope's keys. */
  host: WhereHost;
  /** Typed error for an unknown column reference (wording differs per scope). */
  unknownColumn: (field: string) => ValidationError;
}

/**
 * Produce a value-invariant fingerprint of a where clause.
 * Same keys + same operator shapes + same combinator structure => same string.
 * Different values (e.g. id=1 vs id=999) => identical fingerprint.
 *
 * @internal Exposed as package-private for testing via class access.
 */
export function fingerprintWhere(qi: BuilderCtx, where: Record<string, unknown>, depth = 0): string {
  assertWhereDepth(depth);
  const parts: string[] = [];
  for (const event of walkWhere(qi.whereHost, where)) {
    switch (event.kind) {
      case 'or':
        parts.push(`OR[${event.conditions.map((cond) => fingerprintWhere(qi, cond, depth + 1)).join(',')}]`);
        break;
      case 'and':
        parts.push(`AND[${event.conditions.map((cond) => fingerprintWhere(qi, cond, depth + 1)).join(',')}]`);
        break;
      case 'not':
        parts.push(`NOT(${fingerprintWhere(qi, event.condition, depth + 1)})`);
        break;
      case 'relation':
        // { posts: { some: { published: true } } } → `posts:{some(...)}`
        parts.push(
          `${event.key}:{${fingerprintRelationParts(qi, event.relDef, event.filterObj, depth + 1).join(',')}}`,
        );
        break;
      case 'scalar':
        // Column-blind scalar token (see fingerprintScalarToken): the value's
        // shape alone distinguishes the SQL, so no column lookup is needed.
        parts.push(`${event.key}:${fingerprintScalarToken(event.value)}`);
        break;
    }
  }
  return parts.join('&');
}

/**
 * Fingerprint the present branches of a normalized relation filter, in the
 * fixed order some→every→none→is→isNot. A `null` branch tokenizes as
 * `<branch>(null)`; a present branch recurses through
 * {@link fingerprintRelFilter} so the FULL inner shape is captured (two
 * different sub-wheres must never collide on one cached SQL text).
 */
export function fingerprintRelationParts(
  qi: BuilderCtx,
  relDef: RelationDef,
  filterObj: WhereRecord,
  depth = 0,
): string[] {
  const relParts: string[] = [];
  if (filterObj.some !== undefined)
    relParts.push(
      filterObj.some === null
        ? 'some(null)'
        : `some(${fingerprintRelFilter(qi, relDef.to, filterObj.some as Record<string, unknown>, depth + 1)})`,
    );
  if (filterObj.every !== undefined)
    relParts.push(
      filterObj.every === null
        ? 'every(null)'
        : `every(${fingerprintRelFilter(qi, relDef.to, filterObj.every as Record<string, unknown>, depth + 1)})`,
    );
  if (filterObj.none !== undefined)
    relParts.push(
      filterObj.none === null
        ? 'none(null)'
        : `none(${fingerprintRelFilter(qi, relDef.to, filterObj.none as Record<string, unknown>, depth + 1)})`,
    );
  if (filterObj.is !== undefined)
    relParts.push(
      filterObj.is === null
        ? 'is(null)'
        : `is(${fingerprintRelFilter(qi, relDef.to, filterObj.is as Record<string, unknown>, depth + 1)})`,
    );
  if (filterObj.isNot !== undefined)
    relParts.push(
      filterObj.isNot === null
        ? 'isNot(null)'
        : `isNot(${fingerprintRelFilter(qi, relDef.to, filterObj.isNot as Record<string, unknown>, depth + 1)})`,
    );
  return relParts;
}

/**
 * Fingerprint a relation filter sub-where for some/every/none. Thin wrapper
 * over the unified {@link fingerprintScopedWhere}. When the target table is
 * unknown, an empty-relations host makes every key scalar (matching the old
 * `meta?.relations` short-circuit).
 */
export function fingerprintRelFilter(
  qi: BuilderCtx,
  targetTable: string,
  subWhere: Record<string, unknown>,
  depth = 0,
): string {
  const meta = qi.schema.tables[targetTable];
  const host = meta ? scopedWhereHost(qi, meta) : emptyRelationsHost(qi, targetTable);
  return fingerprintScopedWhere(qi, host, subWhere, depth);
}

/**
 * Walk a where clause and push ONLY values into `params`, in the EXACT same
 * order that `buildWhereClause` pushes them. Used on cache hit to fill params
 * without rebuilding SQL.
 *
 * @internal Exposed as package-private for testing.
 */
export function collectWhereParams(qi: BuilderCtx, where: Record<string, unknown>, params: unknown[], depth = 0): void {
  assertWhereDepth(depth);
  // ONE canonical walk (shared with fingerprintWhere + buildWhereClause), so
  // the key order + combinator structure cannot drift out of lockstep.
  for (const event of walkWhere(qi.whereHost, where)) {
    switch (event.kind) {
      case 'or':
      case 'and':
        for (const cond of event.conditions) collectWhereParams(qi, cond, params, depth + 1);
        break;
      case 'not':
        collectWhereParams(qi, event.condition, params, depth + 1);
        break;
      case 'relation':
        collectRelationFilterParams(qi, event.relDef, event.filterObj, params, depth + 1);
        break;
      case 'scalar':
        collectScalarParams(qi, event.key, event.value, params);
        break;
    }
  }
}

/**
 * Push a scalar WHERE value's params, mirroring {@link buildScalarClause}'s
 * emissions exactly. Both resolve the value's shape via the shared
 * {@link classifyScalarForSql}, so a cache HIT binds each `$N` to the value
 * the cached SQL expects. A JSON/array-shaped value on a non-JSON/array column
 * (`jsonThrow`/`arrayThrow`) falls through to the equality path here, the
 * same fall-through the collect path has always taken (the build path's typed
 * error there is only reachable on a MISS, before anything is cached).
 */
export function collectScalarParams(qi: BuilderCtx, key: string, value: unknown, params: unknown[]): void {
  const rawColumn = qi.toColumn(key);
  const cls = classifyScalarForSql(qi.whereHost, rawColumn, value);
  switch (cls.kind) {
    case 'null':
      // IS NULL is parameterless.
      return;
    case 'vector':
      // Validate the same way the build path does so the collect path never
      // diverges (it would throw before any param was pushed).
      vectorOperator(qi, key, rawColumn, (value as VectorFilter).distance.metric);
      collectVectorFilterParams(qi, key, rawColumn, value as VectorFilter, params);
      return;
    case 'json':
      collectJsonFilterParams(qi, value as JsonFilter, params, qi.q(rawColumn));
      return;
    case 'array':
      collectArrayFilterParams(qi, value as ArrayFilter, params);
      return;
    case 'textsearch':
      // Same gate the build path applies, so the collect path never diverges
      // (it throws before any param is pushed).
      requireFullTextSearch(qi);
      params.push((value as TextSearchFilter).search);
      return;
    case 'operator':
      collectOperatorParams(qi, rawColumn, value as WhereOperator, params, {
        meta: qi.tableMeta,
        table: qi.table,
        prefix: '',
        rawColumn,
      });
      return;
    default:
      // 'equality' | 'jsonThrow' | 'arrayThrow': same strict validation as
      // the build path, so a cache hit can never silently bind a
      // misspelled-operator object.
      assertBindableEqualityValue(qi, rawColumn, value, getColumnPgType(qi, rawColumn), qi.table);
      params.push(coerceWhereOperand(qi, qi.tableMeta, rawColumn, value));
      return;
  }
}

/**
 * Param-collect mirror of {@link buildRelationFilter} for one relation-filter
 * object (`{ some/every/none/is/isNot }`, already normalized). Pushes, per
 * present branch and in the canonical order some→none→every→is→isNot, the
 * branch's sub-where params THEN the target table's global-filter params -
 * exactly the order buildRelationFilter emits. When no global filter applies
 * the gf calls are no-ops, so this stays byte-identical to the pre-0.28 path.
 * Shared by every collect site that mirrors buildRelationFilter
 * (collectWhereParams, collectRelFilterParams, collectAliasWhereParams).
 */
export function collectRelationFilterParams(
  qi: BuilderCtx,
  relDef: RelationDef,
  filterObj: Record<string, unknown>,
  params: unknown[],
  depth = 0,
): void {
  const target = relDef.to;
  if (filterObj.some !== undefined && filterObj.some !== null) {
    collectRelFilterParams(qi, target, filterObj.some as Record<string, unknown>, params, depth + 1);
    collectTargetGlobalFilterExists(qi, target, params);
  }
  if (filterObj.none !== undefined && filterObj.none !== null) {
    collectRelFilterParams(qi, target, filterObj.none as Record<string, unknown>, params, depth + 1);
    collectTargetGlobalFilterExists(qi, target, params);
  }
  if (filterObj.every !== undefined && filterObj.every !== null) {
    // gf is only emitted (build) when the `every` sub-where compiles to a
    // filter, otherwise `every` is trivially true and no subquery is built.
    if (buildSubWhereForRelation(qi, target, filterObj.every as Record<string, unknown>, [], depth + 1) !== null) {
      collectRelFilterParams(qi, target, filterObj.every as Record<string, unknown>, params, depth + 1);
      collectTargetGlobalFilterExists(qi, target, params);
    }
  }
  if (filterObj.is !== undefined) {
    if (filterObj.is !== null)
      collectRelFilterParams(qi, target, filterObj.is as Record<string, unknown>, params, depth + 1);
    collectTargetGlobalFilterExists(qi, target, params);
  }
  if (filterObj.isNot !== undefined) {
    if (filterObj.isNot !== null)
      collectRelFilterParams(qi, target, filterObj.isNot as Record<string, unknown>, params, depth + 1);
    collectTargetGlobalFilterExists(qi, target, params);
  }
}

export function collectRelFilterParams(
  qi: BuilderCtx,
  targetTable: string,
  subWhere: Record<string, unknown>,
  params: unknown[],
  depth = 0,
): void {
  const meta = qi.schema.tables[targetTable];
  if (!meta) return;
  collectScopedWhereParams(qi, relationWhereScope(qi, targetTable, meta), subWhere, params, depth);
}

/**
 * Collect params from operator clauses. Mirrors buildOperatorClauses:
 * {@link ColumnRef} values compile into the SQL text, so they push NOTHING -
 * but they re-run the same validation (unknown ref / insensitive mode) so a
 * warmed cache can never skip a check the build path enforces.
 */
export function collectOperatorParams(
  qi: BuilderCtx,
  column: string,
  op: WhereOperator,
  params: unknown[],
  refCtx?: ColumnRefContext,
): void {
  const skipRef = (v: unknown): boolean => {
    if (!isColumnRef(v)) return false;
    if (refCtx) resolveColumnRef(qi, v, refCtx, op.mode);
    return true;
  };
  // Mirrors buildOperatorClauses' temporal bind rewrite exactly.
  const cv = (v: unknown): unknown => (refCtx ? coerceWhereOperand(qi, refCtx.meta, refCtx.rawColumn, v) : v);
  if (op.equals !== undefined && op.equals !== null && !skipRef(op.equals)) {
    assertBindableEqualsOperand(op.equals, `"${column}"`);
    params.push(cv(op.equals));
  }
  if (op.gt !== undefined && !skipRef(op.gt)) params.push(cv(op.gt));
  if (op.gte !== undefined && !skipRef(op.gte)) params.push(cv(op.gte));
  if (op.lt !== undefined && !skipRef(op.lt)) params.push(cv(op.lt));
  if (op.lte !== undefined && !skipRef(op.lte)) params.push(cv(op.lte));
  if (op.not !== undefined && op.not !== null && !skipRef(op.not)) params.push(cv(op.not));
  if (op.in !== undefined) params.push(qi.inParam(cv(op.in)));
  if (op.notIn !== undefined) params.push(qi.inParam(cv(op.notIn)));
  if (op.contains !== undefined) params.push(`%${likeOperand(qi, op.contains)}%`);
  if (op.startsWith !== undefined) params.push(`${likeOperand(qi, op.startsWith)}%`);
  if (op.endsWith !== undefined) params.push(`%${likeOperand(qi, op.endsWith)}`);
}

/**
 * Collect params from JSON filter. Mirrors buildJsonFilterClauses exactly:
 * the `path` is bound at most once (its placeholder is shared by every
 * extraction clause), then equals/contains/hasKey values, then the range
 * comparison values in {@link JSON_RANGE_OPERATORS} order.
 */
export function collectJsonFilterParams(qi: BuilderCtx, filter: JsonFilter, params: unknown[], column: string): void {
  assertJsonFilterKeys(filter, column);
  let pathPushed = false;
  const pushPathOnce = (): void => {
    if (!pathPushed) {
      // Only reached when a path-requiring clause validated filter.path.
      params.push(jsonPathParam(qi, filter.path!, filter.path));
      pathPushed = true;
    }
  };

  if (filter.path !== undefined && filter.equals !== undefined) {
    pushPathOnce();
    params.push(String(filter.equals));
  } else if (filter.equals !== undefined) {
    // Mirrors the build path's refusal, and thrown before any param is pushed,
    // like the text-search gate a few cases above. Not defensive: it is what
    // stops a warmed template serving a shape the cold build refuses.
    requireJsonContains(qi, 'equals');
    params.push(JSON.stringify(filter.equals));
  }
  if (filter.contains !== undefined) {
    requireJsonContains(qi, 'contains');
    params.push(JSON.stringify(filter.contains));
  }
  if (filter.hasKey !== undefined) {
    params.push(filter.hasKey);
  }
  for (const { value } of jsonRangeEntries(qi, filter, column)) {
    pushPathOnce();
    params.push(value);
  }
  for (const { pattern, value } of jsonStringEntries(filter, column)) {
    pushPathOnce();
    params.push(pattern(likeOperand(qi, value)));
  }
}

/** Collect params from array filter. Mirrors buildArrayFilterClauses. */
export function collectArrayFilterParams(qi: BuilderCtx, filter: ArrayFilter, params: unknown[]): void {
  requireArrayColumns(qi);
  if (filter.has !== undefined) params.push(filter.has);
  if (filter.hasEvery !== undefined) params.push(filter.hasEvery);
  if (filter.hasSome !== undefined) params.push(filter.hasSome);
  // isEmpty has no params (IS NULL / IS NOT NULL)
}

/**
 * Collect params for a vector distance WHERE filter. Mirrors
 * {@link buildVectorFilterClauses}: the `$n::vector` query vector first, then
 * the comparison threshold(s), both enumerated AND validated by the shared
 * {@link vectorThresholdEntries} (see there for the production-only bug that
 * inlining the loop on both sides produced).
 */
export function collectVectorFilterParams(
  qi: BuilderCtx,
  field: string,
  rawColumn: string,
  filter: VectorFilter,
  params: unknown[],
): void {
  const dist = filter.distance;
  pushVectorParam(qi, field, rawColumn, dist.to, params);
  for (const { threshold } of vectorThresholdEntries(filter, field)) params.push(threshold);
}

/** Build WHERE clause from a where object (supports operators, NULL, OR) */
export function buildWhere<T extends object>(
  qi: BuilderCtx,
  where: WhereClause<T>,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const clause = buildWhereClause(qi, where as Record<string, unknown>, params);
  if (!clause) return { sql: '', params: [] };
  return { sql: ` WHERE ${clause}`, params };
}

/**
 * THE global-filter resolution rule, with no dependency on a `BuilderCtx`.
 *
 * Split out from {@link resolveGlobalFilter} so `PowqlInterface` can consume
 * the SAME rule rather than a transcription of it. It is a parallel
 * implementation of the public surface, and this repository's history is
 * unambiguous that a rule written twice is how two engines come to disagree
 * (the 0.64 projection resolver, the 0.73 findUnique guard). Every clause here
 * is load-bearing on both engines: a function filter is evaluated PER BUILD so
 * per-request tenancy works, an all-undefined filter is treated as absent so it
 * cannot emit a dangling clause, and `skip` is honoured in both its whole-query
 * and per-table forms.
 */
export function resolveGlobalFilterFrom(
  filters: GlobalFilters | undefined,
  table: string,
  skip: ResolvedSkipGlobalFilters | undefined,
): Record<string, unknown> | null {
  if (!filters) return null;
  if (skip === true) return null;
  if (Array.isArray(skip) && skip.includes(table)) return null;
  const raw = filters[table];
  if (raw === undefined) return null;
  const resolved = typeof raw === 'function' ? raw() : raw;
  if (resolved === null || resolved === undefined) return null;
  const obj = resolved as Record<string, unknown>;
  // An all-undefined filter (e.g. `{ tenantId: undefined }`) contributes
  // nothing, treat it as absent so it never emits a dangling clause.
  if (Object.keys(obj).every((k) => obj[k] === undefined)) return null;
  return obj;
}

/**
 * Resolve the configured global filter for `table`, evaluating a function
 * filter, honoring the active query's `skipGlobalFilters`. Returns `null` when
 * no filter applies, the query opted out, or the filter is empty.
 */
export function resolveGlobalFilter(
  qi: BuilderCtx,
  table: string,
  skip: ResolvedSkipGlobalFilters | undefined = qi.currentSkip,
): Record<string, unknown> | null {
  return resolveGlobalFilterFrom(qi.globalFilters, table, skip);
}

/**
 * AND-merge this table's resolved global filter into a user `where`. Either
 * side may be absent. When no filter applies the user where is returned by
 * reference, so fingerprints/SQL stay byte-identical to the pre-0.28 path.
 */
export function mergeGlobalFilter(
  qi: BuilderCtx,
  userWhere: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const gf = resolveGlobalFilter(qi, qi.table);
  if (!gf) return userWhere;
  if (userWhere === undefined) return gf;
  // Branded: this `AND` is Turbine's, always exactly two branches, so it must
  // not put the statement on the variable-arity (unnamed) path. See
  // {@link markInternalCombinator}.
  return markInternalCombinator({ AND: [userWhere, gf] });
}

/**
 * SQL clause for `targetTable`'s global filter rendered against `alias`
 * (relation subqueries, `_count`, relation `orderBy`). Pushes its params to
 * `params`; returns `''` when no filter applies. Mirror:
 * {@link collectTargetGlobalFilterAlias}.
 */
export function targetGlobalFilterAlias(qi: BuilderCtx, targetTable: string, alias: string, params: unknown[]): string {
  const gf = resolveGlobalFilter(qi, targetTable);
  if (!gf) return '';
  const meta = qi.schema.tables[targetTable];
  if (!meta) return '';
  return buildAliasWhere(qi, targetTable, meta, alias, gf, params) ?? '';
}

/** Param-collect mirror of {@link targetGlobalFilterAlias}. */
export function collectTargetGlobalFilterAlias(qi: BuilderCtx, targetTable: string, params: unknown[]): void {
  const gf = resolveGlobalFilter(qi, targetTable);
  if (!gf) return;
  const meta = qi.schema.tables[targetTable];
  if (!meta) return;
  collectAliasWhereParams(qi, targetTable, meta, gf, params);
}

/**
 * SQL clause for `targetTable`'s global filter rendered against the bare
 * (unaliased) table name, the form used inside relation-filter `EXISTS`
 * subqueries. Pushes its params; `''` when none. Mirror:
 * {@link collectTargetGlobalFilterExists}.
 */
export function targetGlobalFilterExists(qi: BuilderCtx, targetTable: string, params: unknown[]): string {
  const gf = resolveGlobalFilter(qi, targetTable);
  if (!gf) return '';
  return buildSubWhereForRelation(qi, targetTable, gf, params) ?? '';
}

/** Param-collect mirror of {@link targetGlobalFilterExists}. */
export function collectTargetGlobalFilterExists(qi: BuilderCtx, targetTable: string, params: unknown[]): void {
  const gf = resolveGlobalFilter(qi, targetTable);
  if (!gf) return;
  collectRelFilterParams(qi, targetTable, gf, params);
}

/**
 * Value-invariant SQL-cache-key segment for the active global-filter
 * environment. Relation-subquery / relation-filter / `_count` / relation-
 * `orderBy` global filters are rendered at build time but their SHAPE is not
 * otherwise in the where/with fingerprint, so this segment guards the cache:
 * two different filter shapes never collide on one cached SQL text, while two
 * function-filter results of the SAME shape (differing only in values) share
 * the entry and bind their own params. Empty (`''`) when no filter applies, so
 * cache keys stay byte-identical when the feature is unused.
 */
export function globalFilterCacheSegment(qi: BuilderCtx): string {
  const filters = qi.globalFilters;
  if (!filters) return '';
  const parts: string[] = [];
  for (const table of Object.keys(filters).sort()) {
    // Function filters for OTHER tables may be request-scoped closures that
    // throw outside their own context; a query on an unrelated table must not
    // break on them. A throwing filter can't have contributed SQL to this
    // query either (merging it would have thrown first), so a constant
    // marker keeps the key shape-distinct without evaluating it.
    let gf: Record<string, unknown> | null | undefined;
    try {
      gf = resolveGlobalFilter(qi, table);
    } catch {
      parts.push(`${table}:!`);
      continue;
    }
    if (gf) {
      // Fingerprint with the FILTER's own table host, not the root table's:
      // classifying another table's filter with the root host can mistake a
      // relation filter for a scalar object and collide two shapes that
      // compile to different SQL. Unknown meta falls back to the root host
      // (same as scoped sub-wheres against an unknown target).
      const meta = qi.schema.tables[table];
      const host = meta && meta.name !== qi.tableMeta.name ? scopedWhereHost(qi, meta) : undefined;
      parts.push(`${table}:${host ? fingerprintScopedWhere(qi, host, gf) : fingerprintWhere(qi, gf)}`);
    }
  }
  return parts.length ? `|gf=${parts.join(';')}` : '';
}

/**
 * True when the USER-supplied `where` compiles to no predicate (`{}`,
 * `{ id: undefined }`, `{ OR: [{ a: undefined }] }`, …). This is the exact
 * signal the empty-`where` guard needs, the compiled emptiness, NOT the
 * fingerprint (which is non-empty for an all-undefined `OR`/`AND`). It ignores
 * any configured global filter, so a global filter never lets an unguarded
 * mass mutation through.
 */
export function userPredicateIsEmpty(qi: BuilderCtx, userWhere: Record<string, unknown>): boolean {
  const throwaway: unknown[] = [];
  return buildWhereClause(qi, userWhere, throwaway) === null;
}

export function assertMutationHasPredicate(
  qi: BuilderCtx,
  operation: 'update' | 'updateMany' | 'delete' | 'deleteMany',
  whereSql: string,
  // Already RESOLVED by the caller (writes.ts) through `resolveUnsafeFlag`, so
  // the sentinel check happens on every mutation, not only the guarded ones: a
  // literal `allowFullTableScan: true` must throw even when the `where` is
  // non-empty, or the escalation attempt goes unreported on most calls.
  allowFullTableScan: boolean | undefined,
): void {
  if (whereSql.length > 0) return;
  if (allowFullTableScan === true) return;
  throw new ValidationError(
    `${operation} on "${qi.table}" refused: the \`where\` clause is empty. ` +
      "Pass `allowFullTableScan: UNSAFE` to opt in (import { UNSAFE } from 'turbine-orm'), " +
      'or check that your filter values are defined.',
  );
}

/**
 * Build the inner WHERE expression (without the WHERE keyword).
 * Returns null if no conditions exist.
 * Supports: equality, operators, NULL, OR, AND, NOT, relation filters (some/every/none).
 */
export function buildWhereClause(
  qi: BuilderCtx,
  where: Record<string, unknown>,
  params: unknown[],
  depth = 0,
): string | null {
  assertWhereDepth(depth);
  const andClauses: string[] = [];
  // A combinator ARRAY is the one shape whose branch COUNT is written into the
  // SQL text, so the statement stops being a fixed shape (see
  // markVariableArity). Marked here, on the BUILD walk, because the mark
  // is read immediately after `build()` inside `acquireSql`, so it decides the
  // prepared-statement name of the very entry being created. The internal
  // wrapper the global-filter merge synthesizes is exempt, see
  // INTERNAL_COMBINATOR.
  const internal = isInternalCombinator(where);

  // ONE canonical walk (shared with fingerprintWhere + collectWhereParams).
  for (const event of walkWhere(qi.whereHost, where)) {
    switch (event.kind) {
      case 'or': {
        if (!internal) qi.markVariableArity();
        const orClauses: string[] = [];
        for (const orCond of event.conditions) {
          const sub = buildWhereClause(qi, orCond, params, depth + 1);
          if (sub) orClauses.push(sub);
        }
        if (orClauses.length > 0) andClauses.push(`(${orClauses.join(' OR ')})`);
        break;
      }
      case 'and':
        if (!internal) qi.markVariableArity();
        for (const andCond of event.conditions) {
          const sub = buildWhereClause(qi, andCond, params, depth + 1);
          if (sub) andClauses.push(sub);
        }
        break;
      case 'not': {
        const sub = buildWhereClause(qi, event.condition, params, depth + 1);
        if (sub) andClauses.push(`NOT (${sub})`);
        break;
      }
      case 'relation': {
        // { posts: { some: { published: true } } } → EXISTS / NOT EXISTS
        const relClause = buildRelationFilter(qi, event.key, event.relDef, event.filterObj, params, undefined, depth);
        if (relClause) andClauses.push(relClause);
        break;
      }
      case 'scalar':
        buildScalarClause(qi, event.key, event.value, params, andClauses);
        break;
    }
  }

  if (andClauses.length === 0) return null;
  return andClauses.join(' AND ');
}

/**
 * Emit the SQL clause(s) for one scalar WHERE key onto `andClauses`, pushing
 * any params. The shape decision comes from the shared
 * {@link classifyScalarForSql} so {@link collectScalarParams} pushes an
 * identical param list on a cache hit. The `*Throw` branches preserve the
 * strict-validation errors for a JSON/array operator on the wrong column type.
 */
export function buildScalarClause(
  qi: BuilderCtx,
  key: string,
  value: unknown,
  params: unknown[],
  andClauses: string[],
): void {
  const rawColumn = qi.toColumn(key);
  const column = qi.q(rawColumn);
  const cls = classifyScalarForSql(qi.whereHost, rawColumn, value);
  switch (cls.kind) {
    case 'null':
      andClauses.push(`${column} IS NULL`);
      return;
    case 'vector':
      andClauses.push(...buildVectorFilterClauses(qi, key, rawColumn, value as VectorFilter, params));
      return;
    case 'json':
      andClauses.push(...buildJsonFilterClauses(qi, column, value as JsonFilter, params));
      return;
    case 'jsonThrow':
      // A JSON-only operator on a non-JSON column was almost certainly a typo
      // or schema mismatch. `contains`/`equals` are shared with WhereOperator
      // (LIKE / equality), so only shape-unique keys reach here.
      throw new ValidationError(
        `Column "${rawColumn}" on table "${qi.table}" is not a JSON column ` +
          `(actual type: ${getColumnPgType(qi, rawColumn)}); cannot apply JSON operator '${cls.jsonKey}'.`,
      );
    case 'array':
      andClauses.push(...buildArrayFilterClauses(qi, column, value as ArrayFilter, params, cls.colType));
      return;
    case 'arrayThrow':
      throw new ValidationError(
        `Column "${rawColumn}" on table "${qi.table}" is not an array column ` +
          `(actual type: ${getColumnPgType(qi, rawColumn)}); cannot apply array operator '${cls.arrayKey}'.`,
      );
    case 'textsearch':
      andClauses.push(buildTextSearchClause(qi, column, value as TextSearchFilter, params));
      return;
    case 'operator':
      andClauses.push(
        ...buildOperatorClauses(qi, column, value as WhereOperator, params, {
          meta: qi.tableMeta,
          table: qi.table,
          prefix: '',
          rawColumn,
        }),
      );
      return;
    default:
      // 'equality': a plain object literal that matched no known filter shape
      // is almost always a misspelled operator (`startWith` for `startsWith`);
      // the guard also runs on the cache-hit param-collect path.
      assertBindableEqualityValue(qi, rawColumn, value, getColumnPgType(qi, rawColumn), qi.table);
      params.push(coerceWhereOperand(qi, qi.tableMeta, rawColumn, value));
      andClauses.push(`${column} = ${qi.p(params.length)}`);
      return;
  }
}

/**
 * A {@link WhereHost} with no relations, used to fingerprint a sub-where
 * whose target table is unknown (`schema.tables[t]` miss). `walkWhere` reads
 * only `tableMeta.relations`, so every key falls to the scalar path, matching
 * the pre-unification `meta?.relations` short-circuit.
 */
export function emptyRelationsHost(qi: BuilderCtx, table: string): WhereHost {
  return {
    tableMeta: { name: table, relations: {} } as TableMetadata,
    normalizeRelationFilter: (relDef, filterObj) => normalizeRelationFilter(qi, relDef, filterObj),
    getColumnPgType: () => 'text',
    isJsonColumnType: (colType) => isJsonColumnType(qi, colType),
  };
}

export function scopedWhereHost(qi: BuilderCtx, meta: TableMetadata): WhereHost {
  let host = qi.scopedHostCache.get(meta.name);
  if (!host) {
    host = {
      tableMeta: meta,
      normalizeRelationFilter: (relDef, filterObj) => normalizeRelationFilter(qi, relDef, filterObj),
      getColumnPgType: (column) => pgTypeForColumn(qi, meta, column),
      isJsonColumnType: (colType) => isJsonColumnType(qi, colType),
    };
    qi.scopedHostCache.set(meta.name, host);
  }
  return host;
}

/** Build the scope for a relation-filter EXISTS sub-where over the bare target table. */
export function relationWhereScope(qi: BuilderCtx, targetTable: string, meta: TableMetadata): WhereScope {
  return {
    meta,
    table: targetTable,
    qualifier: `${qi.q(targetTable)}.`,
    relationParent: targetTable,
    host: scopedWhereHost(qi, meta),
    unknownColumn: (field) =>
      new ValidationError(
        `Unknown field "${field}" in relation filter for table "${targetTable}". ` +
          `Known fields: ${Object.keys(meta.columnMap).join(', ') || '(none)'}.`,
      ),
  };
}

/** Build the scope for a relation `with`-clause `where` compiled against `alias`. */
export function aliasWhereScope(qi: BuilderCtx, targetTable: string, meta: TableMetadata, alias: string): WhereScope {
  return {
    meta,
    table: targetTable,
    qualifier: `${alias}.`,
    relationParent: alias,
    host: scopedWhereHost(qi, meta),
    unknownColumn: (field) => new ValidationError(`Unknown column "${field}" in where for table "${targetTable}"`),
  };
}

/**
 * Compile a scoped sub-where to SQL. Serves BOTH the relation-filter EXISTS
 * body ({@link buildSubWhereForRelation}) and the relation `with`-clause
 * `where` ({@link buildAliasWhere}), the emitted SQL is byte-identical to the
 * former hand-mirrored walkers, since it renders the same clauses in the same
 * ({@link walkWhere}-canonical) key order.
 */
export function buildScopedWhere(
  qi: BuilderCtx,
  scope: WhereScope,
  where: Record<string, unknown>,
  params: unknown[],
  depth = 0,
): string | null {
  assertWhereDepth(depth);
  const clauses: string[] = [];
  const internal = isInternalCombinator(where);
  for (const event of walkWhere(scope.host, where)) {
    switch (event.kind) {
      case 'or':
      case 'and': {
        // Same variable-arity rule as the top level: a nested relation filter
        // or a relation `with` where can carry a caller-sized OR just as easily.
        if (!internal) qi.markVariableArity();
        const parts = event.conditions
          .map((cond) => buildScopedWhere(qi, scope, cond, params, depth + 1))
          .filter((s): s is string => s !== null)
          .map((s) => `(${s})`);
        if (parts.length > 0) clauses.push(`(${parts.join(event.kind === 'or' ? ' OR ' : ' AND ')})`);
        break;
      }
      case 'not': {
        const sub = buildScopedWhere(qi, scope, event.condition, params, depth + 1);
        if (sub) clauses.push(`NOT (${sub})`);
        break;
      }
      case 'relation': {
        const c = buildRelationFilter(
          qi,
          event.key,
          event.relDef,
          event.filterObj,
          params,
          scope.relationParent,
          depth,
        );
        if (c) clauses.push(c);
        break;
      }
      case 'scalar':
        buildScopedScalarClause(qi, scope, event.key, event.value, params, clauses);
        break;
    }
  }
  return clauses.length > 0 ? clauses.join(' AND ') : null;
}

/**
 * Emit the SQL clause(s) for one scalar key of a scoped sub-where. Reproduces
 * the null / JSON / array / operator / equality fall-through both former
 * walkers shared (relation sub-wheres and alias wheres carry no vector or
 * text-search scalar surface, so, unlike the top-level {@link buildScalarClause}
 * - those shapes are not special-cased here and keep their historical
 * equality-guard behavior).
 */
export function buildScopedScalarClause(
  qi: BuilderCtx,
  scope: WhereScope,
  field: string,
  value: unknown,
  params: unknown[],
  clauses: string[],
): void {
  const meta = scope.meta;
  const col = resolveColumnName(meta, field);
  if (col === undefined) throw scope.unknownColumn(field);
  const qCol = `${scope.qualifier}${qi.q(col)}`;

  if (value === null) {
    clauses.push(`${qCol} IS NULL`);
    return;
  }

  if (typeof value === 'object' && !Array.isArray(value) && isJsonFilter(value)) {
    const colType = pgTypeForColumn(qi, meta, col);
    if (isJsonColumnType(qi, colType)) {
      clauses.push(...buildJsonFilterClauses(qi, qCol, value, params));
      return;
    }
    const jsonKey = findJsonUniqueKey(value);
    if (jsonKey) {
      throw new ValidationError(
        `Column "${col}" on table "${scope.table}" is not a JSON column ` +
          `(actual type: ${colType}); cannot apply JSON operator '${jsonKey}'.`,
      );
    }
  }

  if (typeof value === 'object' && !Array.isArray(value) && isArrayFilter(value)) {
    const colType = pgTypeForColumn(qi, meta, col);
    if (colType.startsWith('_')) {
      clauses.push(...buildArrayFilterClauses(qi, qCol, value, params, colType));
      return;
    }
    const arrayKey = findArrayUniqueKey(value);
    if (arrayKey) {
      throw new ValidationError(
        `Column "${col}" on table "${scope.table}" is not an array column ` +
          `(actual type: ${colType}); cannot apply array operator '${arrayKey}'.`,
      );
    }
  }

  if (isWhereOperator(value)) {
    clauses.push(
      ...buildOperatorClauses(qi, qCol, value, params, {
        meta,
        table: scope.table,
        prefix: scope.qualifier,
        rawColumn: col,
      }),
    );
    return;
  }

  assertBindableEqualityValue(qi, col, value, pgTypeForColumn(qi, meta, col), scope.table);
  params.push(coerceWhereOperand(qi, meta, col, value));
  clauses.push(`${qCol} = ${qi.p(params.length)}`);
}

/**
 * Cache-hit param-collect mirror of {@link buildScopedWhere}: pushes the exact
 * same params in the exact same order (driven by the same {@link walkWhere}),
 * without rebuilding SQL. Serves both {@link collectRelFilterParams} and
 * {@link collectAliasWhereParams}.
 */
export function collectScopedWhereParams(
  qi: BuilderCtx,
  scope: WhereScope,
  where: Record<string, unknown>,
  params: unknown[],
  depth = 0,
): void {
  assertWhereDepth(depth);
  for (const event of walkWhere(scope.host, where)) {
    switch (event.kind) {
      case 'or':
      case 'and':
        for (const cond of event.conditions) collectScopedWhereParams(qi, scope, cond, params, depth + 1);
        break;
      case 'not':
        collectScopedWhereParams(qi, scope, event.condition, params, depth + 1);
        break;
      case 'relation':
        // Same some→none→every→is→isNot (each: sub-where params then target
        // global-filter params) as buildRelationFilter emits.
        collectRelationFilterParams(qi, event.relDef, event.filterObj, params, depth);
        break;
      case 'scalar':
        collectScopedScalarParams(qi, scope, event.key, event.value, params);
        break;
    }
  }
}

/** Param-collect mirror of {@link buildScopedScalarClause}. */
export function collectScopedScalarParams(
  qi: BuilderCtx,
  scope: WhereScope,
  field: string,
  value: unknown,
  params: unknown[],
): void {
  if (value === null) return;
  const meta = scope.meta;
  // Unvalidated on purpose: this is the cache-HIT mirror, and a key that does
  // not resolve could never have produced the entry being served. It still
  // goes through the one authority, so the column it binds against cannot
  // differ from the one the build path emitted.
  const col = resolveColumnName(meta, field) ?? camelToSnake(field);

  if (typeof value === 'object' && !Array.isArray(value) && isJsonFilter(value)) {
    const colType = pgTypeForColumn(qi, meta, col);
    if (isJsonColumnType(qi, colType)) {
      collectJsonFilterParams(qi, value, params, `${qi.q(scope.table)}.${qi.q(col)}`);
      return;
    }
  }

  if (typeof value === 'object' && !Array.isArray(value) && isArrayFilter(value)) {
    const colType = pgTypeForColumn(qi, meta, col);
    if (colType.startsWith('_')) {
      collectArrayFilterParams(qi, value, params);
      return;
    }
  }

  if (isWhereOperator(value)) {
    collectOperatorParams(qi, col, value, params, { meta, table: scope.table, prefix: '', rawColumn: col });
    return;
  }

  assertBindableEqualityValue(qi, col, value, pgTypeForColumn(qi, meta, col), scope.table);
  params.push(coerceWhereOperand(qi, meta, col, value));
}

/**
 * Value-invariant fingerprint of a scoped sub-where. Same canonical
 * {@link walkWhere} as {@link fingerprintWhere}, so two shapes that compile to
 * different SQL never collide on one cached SQL string. Serves both
 * {@link fingerprintRelFilter} and {@link fingerprintAliasWhere}. Fingerprint
 * bytes are process-local cache keys (never persisted), so their exact text
 * may differ from the pre-unification walkers as long as collisions stay
 * impossible.
 */
export function fingerprintScopedWhere(
  qi: BuilderCtx,
  host: WhereHost,
  where: Record<string, unknown>,
  depth = 0,
): string {
  assertWhereDepth(depth);
  const parts: string[] = [];
  for (const event of walkWhere(host, where)) {
    switch (event.kind) {
      case 'or':
        parts.push(`OR[${event.conditions.map((c) => fingerprintScopedWhere(qi, host, c, depth + 1)).join(',')}]`);
        break;
      case 'and':
        parts.push(`AND[${event.conditions.map((c) => fingerprintScopedWhere(qi, host, c, depth + 1)).join(',')}]`);
        break;
      case 'not':
        parts.push(`NOT(${fingerprintScopedWhere(qi, host, event.condition, depth + 1)})`);
        break;
      case 'relation':
        parts.push(`${event.key}:{${fingerprintRelationParts(qi, event.relDef, event.filterObj, depth).join(',')}}`);
        break;
      case 'scalar':
        parts.push(`${event.key}:${fingerprintScalarToken(event.value)}`);
        break;
    }
  }
  return parts.join('&');
}

/**
 * Build relation filter SQL: WHERE EXISTS / NOT EXISTS subquery
 * Supports: some (EXISTS), every (NOT EXISTS ... NOT), none (NOT EXISTS)
 */
export function buildRelationFilter(
  qi: BuilderCtx,
  _relName: string,
  relDef: RelationDef,
  filterObj: Record<string, unknown>,
  params: unknown[],
  parentTable?: string,
  /**
   * Nesting depth of the WHERE walk that reached this relation filter. Each
   * relation descent is a level too: `{ posts: { some: { comments: { some:
   * … } } } }` recurses through here just as `NOT` does, and is exactly as
   * unbounded without a cap (see {@link assertWhereDepth}).
   */
  depth = 0,
): string | null {
  const targetTable = relDef.to;
  const targetMeta = qi.schema.tables[targetTable];
  if (!targetMeta) return null;

  const qt = qi.q(targetTable);
  const qSelf = qi.q(parentTable ?? qi.table);
  const clauses: string[] = [];

  // Correlation: link child table to parent table (supports composite FKs)
  let correlation: string;
  if (relDef.type === 'manyToMany') {
    // The target row is related iff a junction row links it to the parent.
    // Direct FK correlation (the other branches) would compile target.pk =
    // parent.pk and silently match nothing, so route through the junction:
    //   EXISTS (SELECT 1 FROM junction
    //           WHERE junction.targetKey = target.pk AND junction.sourceKey = parent.ref)
    // All bare table names (no aliases), so the scoped sub-where machinery and
    // nested relation filters inside the branch keep their qualification. The
    // fragment binds no params, so collectRelationFilterParams needs no mirror.
    if (!relDef.through) {
      throw new ValidationError(`manyToMany relation "${relDef.name}" is missing a \`through\` junction descriptor.`);
    }
    const qJunction = qi.q(relDef.through.table);
    const targetKeys = normalizeKeyColumns(relDef.through.targetKey);
    const targetPk = targetMeta.primaryKey;
    if (targetPk.length === 0) {
      throw new ValidationError(
        `manyToMany relation "${relDef.name}" targets table "${targetTable}" which has no primary key; ` +
          `cannot correlate the relation filter through the junction.`,
      );
    }
    if (targetKeys.length !== targetPk.length) {
      throw new ValidationError(
        `manyToMany relation "${relDef.name}": through.targetKey has ${targetKeys.length} column(s) ` +
          `but target "${targetTable}" primary key has ${targetPk.length}. Composite keys must pair positionally.`,
      );
    }
    const sourceKeys = normalizeKeyColumns(relDef.through.sourceKey);
    const refKeys = normalizeKeyColumns(relDef.referenceKey);
    if (sourceKeys.length !== refKeys.length) {
      throw new ValidationError(
        `manyToMany relation "${relDef.name}": through.sourceKey has ${sourceKeys.length} column(s) ` +
          `but referenceKey has ${refKeys.length}. Composite keys must pair positionally.`,
      );
    }
    const targetLink = targetKeys
      .map((jcol, i) => `${qJunction}.${qi.q(jcol)} = ${qt}.${qi.q(targetPk[i]!)}`)
      .join(' AND ');
    const parentLink = sourceKeys
      .map((jcol, i) => `${qJunction}.${qi.q(jcol)} = ${qSelf}.${qi.q(refKeys[i]!)}`)
      .join(' AND ');
    correlation = `EXISTS (SELECT 1 FROM ${qJunction} WHERE ${targetLink} AND ${parentLink})`;
  } else if (relDef.type === 'hasMany' || relDef.type === 'hasOne') {
    // parent.pk = child.fk
    correlation = qi.dialect.buildCorrelation(qt, relDef.foreignKey, qSelf, relDef.referenceKey);
  } else {
    // belongsTo: parent.fk = child.pk
    correlation = qi.dialect.buildCorrelation(qt, relDef.referenceKey, qSelf, relDef.foreignKey);
  }

  // The target table's global filter (soft-delete / tenancy) restricts the
  // DOMAIN of correlated rows in EVERY branch: `some`/`none`/`is`/`isNot`
  // ignore filtered-out rows, and `every` quantifies over only the surviving
  // rows ("every NON-deleted related row matches P"). It is ANDed into the
  // correlation and its params pushed AFTER the per-branch filter, mirrored
  // exactly in collectWhereParams' relation-filter branch. `qt` is the bare
  // target table, matching the `FROM ${qt}` here (see targetGlobalFilterExists).
  const gfAnd = (): string => {
    const gf = targetGlobalFilterExists(qi, targetTable, params);
    return gf ? ` AND ${gf}` : '';
  };

  // "some": EXISTS (SELECT 1 FROM target WHERE correlation AND filter AND gf)
  // A `null` branch is skipped (never reaches buildSubWhereForRelation, which
  // would throw on Object.keys(null)), matching collectRelationFilterParams,
  // which also skips null. Unreachable via normalization today, guarded anyway.
  if (filterObj.some !== undefined && filterObj.some !== null) {
    const subWhere = filterObj.some as Record<string, unknown>;
    const filterClause = buildSubWhereForRelation(qi, targetTable, subWhere, params, depth + 1);
    const filterAnd = filterClause ? ` AND ${filterClause}` : '';
    clauses.push(`EXISTS (SELECT 1 FROM ${qt} WHERE ${correlation}${filterAnd}${gfAnd()})`);
  }

  // "none": NOT EXISTS (SELECT 1 FROM target WHERE correlation AND filter AND gf)
  if (filterObj.none !== undefined && filterObj.none !== null) {
    const subWhere = filterObj.none as Record<string, unknown>;
    const filterClause = buildSubWhereForRelation(qi, targetTable, subWhere, params, depth + 1);
    const filterAnd = filterClause ? ` AND ${filterClause}` : '';
    clauses.push(`NOT EXISTS (SELECT 1 FROM ${qt} WHERE ${correlation}${filterAnd}${gfAnd()})`);
  }

  // "every": NOT EXISTS (SELECT 1 FROM target WHERE correlation AND gf AND NOT (filter))
  if (filterObj.every !== undefined && filterObj.every !== null) {
    const subWhere = filterObj.every as Record<string, unknown>;
    const filterClause = buildSubWhereForRelation(qi, targetTable, subWhere, params, depth + 1);
    if (filterClause) {
      // gf params pushed AFTER filter params (collect mirrors this order), but
      // placed textually inside the domain so it restricts which rows count.
      const gf = gfAnd();
      clauses.push(`NOT EXISTS (SELECT 1 FROM ${qt} WHERE ${correlation}${gf} AND NOT (${filterClause}))`);
    } else {
      // "every" with empty filter = true (all match trivially), gf irrelevant.
    }
  }

  // "is": EXISTS, for to-one relations (same SQL as "some").
  // `is: null` = "no related row" (Prisma semantics) → NOT EXISTS.
  if (filterObj.is !== undefined) {
    if (filterObj.is === null) {
      clauses.push(`NOT EXISTS (SELECT 1 FROM ${qt} WHERE ${correlation}${gfAnd()})`);
    } else {
      const subWhere = filterObj.is as Record<string, unknown>;
      const filterClause = buildSubWhereForRelation(qi, targetTable, subWhere, params, depth + 1);
      const filterAnd = filterClause ? ` AND ${filterClause}` : '';
      clauses.push(`EXISTS (SELECT 1 FROM ${qt} WHERE ${correlation}${filterAnd}${gfAnd()})`);
    }
  }

  // "isNot": NOT EXISTS, for to-one relations (same SQL as "none").
  // `isNot: null` = "a related row exists" → EXISTS.
  if (filterObj.isNot !== undefined) {
    if (filterObj.isNot === null) {
      clauses.push(`EXISTS (SELECT 1 FROM ${qt} WHERE ${correlation}${gfAnd()})`);
    } else {
      const subWhere = filterObj.isNot as Record<string, unknown>;
      const filterClause = buildSubWhereForRelation(qi, targetTable, subWhere, params, depth + 1);
      const filterAnd = filterClause ? ` AND ${filterClause}` : '';
      clauses.push(`NOT EXISTS (SELECT 1 FROM ${qt} WHERE ${correlation}${filterAnd}${gfAnd()})`);
    }
  }

  return clauses.length > 0 ? clauses.join(' AND ') : null;
}

/**
 * Build WHERE clause conditions for a relation filter subquery.
 * Uses the target table's column mapping to resolve field names.
 */
export function buildSubWhereForRelation(
  qi: BuilderCtx,
  targetTable: string,
  subWhere: Record<string, unknown>,
  params: unknown[],
  depth = 0,
): string | null {
  const meta = qi.schema.tables[targetTable];
  if (!meta) return null;
  return buildScopedWhere(qi, relationWhereScope(qi, targetTable, meta), subWhere, params, depth);
}

/**
 * Resolve a column's Postgres type from an arbitrary table's metadata
 * (relation targets, not just `qi.table`).
 */
export function pgTypeForColumn(_qi: BuilderCtx, meta: TableMetadata, column: string): string {
  return meta.dialectTypes?.[column] ?? meta.pgTypes?.[column] ?? 'text';
}

/**
 * Rewrite a WHERE operand bound against `column` the same way the write path
 * rewrites a `data` value ({@link coerceTemporalValue}): a JS `Date` on a
 * `time` / `timetz` column becomes a time-of-day literal (Postgres otherwise
 * answers `22007 invalid input syntax for type time` for the ISO timestamp the
 * driver would send), and on a zone-less `date` / `timestamp` column it becomes
 * the UTC-component literal, so a predicate matches the value a write of the
 * same `Date` stored.
 *
 * This is a VALUE transform only, it never changes the emitted SQL, so the
 * SQL-template cache is unaffected, and it is applied on the cache-hit
 * param-collect path as well as the build path.
 *
 * `timestamptz` and every non-temporal column are returned by identity.
 */
export function coerceWhereOperand(qi: BuilderCtx, meta: TableMetadata, column: string, value: unknown): unknown {
  if (!(value instanceof Date) && !Array.isArray(value)) return value;
  return coerceTemporalValue(
    pgTypeForColumn(qi, meta, column),
    value,
    // Same PostgreSQL + `utcTimestamps` gate as the write path (see
    // `utcDateTimeWrites` in writes.ts): only the read/write-symmetric engine
    // gets the zone-less rewrite. Time-of-day always rewrites.
    qi.dialect.name === 'postgresql' && qi.utcTimestamps !== false,
  );
}

/**
 * The Postgres enum type name for a column, when the schema knows one.
 *
 * Introspection stores each column's `udt_name` in `pgTypes` and every
 * database enum in `schema.enums` (typname → labels); a column whose type
 * matches an enum key needs an explicit `::"EnumName"` cast on its write
 * binds, bulk-insert forms like `UNNEST($1::text[])` otherwise type the
 * value as text and Postgres refuses the implicit text→enum coercion
 * ("column X is of type Y but expression is of type text").
 *
 * Postgres-only by construction: gated on the active dialect being
 * `postgresql` AND on `schema.enums` having entries (only PG introspection
 * produces them, `defineSchema` and the other engines leave it empty), so
 * SQLite/MySQL/MSSQL/PowDB output is byte-identical.
 */
export function enumTypeForColumn(qi: BuilderCtx, column: string): string | null {
  if (qi.dialect.name !== 'postgresql') return null;
  const enums = qi.schema.enums;
  if (!enums) return null;
  // Cross-schema guard: introspection records pgTypeSchema ONLY when
  // the column's type lives OUTSIDE the introspected schema. A same-named
  // enum in another schema must not get this schema's cast, search_path
  // would resolve `::"status"` to the wrong type. Skipping the cast restores
  // the pre-cast behavior for such columns. Columns without pgTypeSchema
  // (same-schema types, defineSchema/legacy metadata) keep the cast.
  if (qi.crossSchemaTypeColumns.has(column)) return null;
  const pgType = qi.columnPgTypeMap.get(column) ?? qi.tableMeta.pgTypes?.[column];
  if (!pgType || pgType.startsWith('_')) return null;
  return Object.hasOwn(enums, pgType) ? pgType : null;
}

/**
 * `::"EnumName"` cast suffix for a write-bind placeholder on an enum
 * column; `''` for every other column, so non-enum SQL stays byte-identical.
 * The type name is an introspected identifier and is quoted via the dialect.
 */
export function enumCastSuffix(qi: BuilderCtx, column: string): string {
  const enumType = enumTypeForColumn(qi, column);
  return enumType ? `::${qi.q(enumType)}` : '';
}

/**
 * Equality-fallthrough guard shared by every SQL-build path AND every
 * cache-hit param-collect path. A plain object literal that matched no known
 * filter shape on a non-JSON column is almost always a misspelled operator
 * (`startWith` for `startsWith`); binding it as `col = $1` silently returns
 * wrong rows. Class instances (Buffer for bytea, Decimal wrappers, ...) are
 * legitimate bind values and pass through, as do objects on json/jsonb
 * columns (object equality).
 */
export function assertBindableEqualityValue(
  qi: BuilderCtx,
  rawColumn: string,
  value: unknown,
  columnPgType: string,
  table: string,
): void {
  if (!isUnmatchedPlainObject(value)) return;
  if (isJsonColumnType(qi, columnPgType)) return;
  const badKeys = Object.keys(value as Record<string, unknown>);
  throw new ValidationError(
    badKeys.length === 0
      ? `Empty filter object on "${rawColumn}" for table "${table}". ` +
          `Provide a value or an operator like { gt: 1 }.`
      : `Unknown operator${badKeys.length > 1 ? 's' : ''} ` +
          `${badKeys.map((k) => `"${k}"`).join(', ')} on "${rawColumn}" for table "${table}". ` +
          `Supported operators: ${[...OPERATOR_KEYS].join(', ')}.`,
  );
}

/**
 * Build the user-supplied `where` filter of a relation `with` clause against
 * the relation's table alias. Supports the same scalar surface as the
 * top-level WHERE builder, equality, IS NULL, operator objects (incl.
 * `mode: 'insensitive'`), and OR/AND/NOT combinators. Unknown operator
 * objects throw via {@link assertBindableEqualityValue}.
 *
 * Param push order MUST mirror {@link collectAliasWhereParams} exactly, or
 * cache hits and pipeline batching will desync.
 */
export function buildAliasWhere(
  qi: BuilderCtx,
  targetTable: string,
  targetMeta: TableMetadata,
  alias: string,
  where: Record<string, unknown>,
  params: unknown[],
): string | null {
  return buildScopedWhere(qi, aliasWhereScope(qi, targetTable, targetMeta, alias), where, params);
}

/** Mirrors {@link buildAliasWhere} param-push order for the cache-hit collect path. */
export function collectAliasWhereParams(
  qi: BuilderCtx,
  targetTable: string,
  targetMeta: TableMetadata,
  where: Record<string, unknown>,
  params: unknown[],
): void {
  // The alias identifier is irrelevant to param collection (it only shapes SQL
  // text), so reuse the relation scope's host binding for `targetMeta`.
  collectScopedWhereParams(qi, aliasWhereScope(qi, targetTable, targetMeta, ''), where, params);
}

/**
 * Value-invariant, shape-aware fingerprint for a relation `with` clause's
 * `where` filter. Must distinguish every SQL shape {@link buildAliasWhere}
 * can emit, equality vs null vs operator sets vs combinators, or two
 * differently-shaped wheres would share one cached SQL string.
 */
export function fingerprintAliasWhere(qi: BuilderCtx, where: Record<string, unknown>, targetTable?: string): string {
  const meta = targetTable ? qi.schema.tables[targetTable] : undefined;
  const host = meta ? scopedWhereHost(qi, meta) : emptyRelationsHost(qi, targetTable ?? '');
  return fingerprintScopedWhere(qi, host, where);
}

/**
 * Validate a `{ col }` column reference against its table and return the
 * resolved snake_case column name. Shared by the SQL-build path
 * ({@link buildOperatorClauses}) and the cache-hit param-collect path
 * (`collectOperatorParams`) so both always throw identically: a warmed
 * cache can never skip the check.
 */
export function resolveColumnRef(
  _qi: BuilderCtx,
  ref: ColumnRef,
  ctx: ColumnRefContext,
  mode?: 'default' | 'insensitive',
): string {
  if (mode === 'insensitive') {
    throw new ValidationError(
      `mode: 'insensitive' cannot be combined with a column reference ({ col: "${ref.col}" }). ` +
        `Case-insensitive column-to-column comparison is not supported: use client.sql\`...\` ` +
        `for lower(a) = lower(b).`,
    );
  }
  const col = resolveColumnName(ctx.meta, ref.col);
  if (col === undefined) {
    throw new ValidationError(
      `Unknown field "${ref.col}" referenced by { col } in where on table "${ctx.table}". ` +
        `Known fields: ${Object.keys(ctx.meta.columnMap).join(', ') || '(none)'}.`,
    );
  }
  return col;
}

/**
 * Compile a `{ col }` reference to its quoted, prefix-matched SQL identifier.
 * NO param is bound: the referenced column is part of the SQL text (and of
 * the where fingerprint, via `fingerprintOperatorShape` in `filters.ts`).
 */
export function columnRefSql(
  qi: BuilderCtx,
  ref: ColumnRef,
  ctx: ColumnRefContext | undefined,
  mode?: 'default' | 'insensitive',
): string {
  if (!ctx) {
    throw new ValidationError(`Column reference { col: "${ref.col}" } is not supported in this filter context.`);
  }
  return `${ctx.prefix}${qi.q(resolveColumnRef(qi, ref, ctx, mode))}`;
}

/**
 * Build SQL clauses for a single operator object on a column.
 * Each operator key becomes its own clause, all ANDed together.
 *
 * `equals`/`not`/`gt`/`gte`/`lt`/`lte` also accept a {@link ColumnRef}
 * (`{ col: 'otherField' }`) which compiles to a column-to-column comparison
 * against `refCtx`: no param bound, so `collectOperatorParams` mirrors by
 * pushing nothing and the referenced name lives in the fingerprint.
 */
export function buildOperatorClauses(
  qi: BuilderCtx,
  column: string,
  op: WhereOperator,
  params: unknown[],
  refCtx?: ColumnRefContext,
): string[] {
  const clauses: string[] = [];
  // Temporal bind rewrite, identical to `collectOperatorParams`. Value-only, so
  // the emitted SQL (and therefore the template cache) is untouched.
  const cv = (v: unknown): unknown => (refCtx ? coerceWhereOperand(qi, refCtx.meta, refCtx.rawColumn, v) : v);

  if (op.equals !== undefined) {
    if (op.equals === null) {
      clauses.push(`${column} IS NULL`);
    } else if (isColumnRef(op.equals)) {
      clauses.push(`${column} = ${columnRefSql(qi, op.equals, refCtx, op.mode)}`);
    } else {
      assertBindableEqualsOperand(op.equals, column);
      params.push(cv(op.equals));
      clauses.push(`${column} = ${qi.p(params.length)}`);
    }
  }
  if (op.gt !== undefined) {
    if (isColumnRef(op.gt)) {
      clauses.push(`${column} > ${columnRefSql(qi, op.gt, refCtx, op.mode)}`);
    } else {
      params.push(cv(op.gt));
      clauses.push(`${column} > ${qi.p(params.length)}`);
    }
  }
  if (op.gte !== undefined) {
    if (isColumnRef(op.gte)) {
      clauses.push(`${column} >= ${columnRefSql(qi, op.gte, refCtx, op.mode)}`);
    } else {
      params.push(cv(op.gte));
      clauses.push(`${column} >= ${qi.p(params.length)}`);
    }
  }
  if (op.lt !== undefined) {
    if (isColumnRef(op.lt)) {
      clauses.push(`${column} < ${columnRefSql(qi, op.lt, refCtx, op.mode)}`);
    } else {
      params.push(cv(op.lt));
      clauses.push(`${column} < ${qi.p(params.length)}`);
    }
  }
  if (op.lte !== undefined) {
    if (isColumnRef(op.lte)) {
      clauses.push(`${column} <= ${columnRefSql(qi, op.lte, refCtx, op.mode)}`);
    } else {
      params.push(cv(op.lte));
      clauses.push(`${column} <= ${qi.p(params.length)}`);
    }
  }
  if (op.not !== undefined) {
    if (op.not === null) {
      clauses.push(`${column} IS NOT NULL`);
    } else if (isColumnRef(op.not)) {
      clauses.push(`${column} != ${columnRefSql(qi, op.not, refCtx, op.mode)}`);
    } else {
      params.push(cv(op.not));
      clauses.push(`${column} != ${qi.p(params.length)}`);
    }
  }
  if (op.in !== undefined) {
    params.push(qi.inParam(cv(op.in)));
    clauses.push(qi.inClause(column, qi.p(params.length), false));
  }
  if (op.notIn !== undefined) {
    params.push(qi.inParam(cv(op.notIn)));
    clauses.push(qi.inClause(column, qi.p(params.length), true));
  }
  const insensitive = op.mode === 'insensitive';

  if (op.contains !== undefined) {
    params.push(`%${likeOperand(qi, op.contains)}%`);
    clauses.push(buildLikeClause(qi, column, qi.p(params.length), insensitive));
  }
  if (op.startsWith !== undefined) {
    params.push(`${likeOperand(qi, op.startsWith)}%`);
    clauses.push(buildLikeClause(qi, column, qi.p(params.length), insensitive));
  }
  if (op.endsWith !== undefined) {
    params.push(`%${likeOperand(qi, op.endsWith)}`);
    clauses.push(buildLikeClause(qi, column, qi.p(params.length), insensitive));
  }

  return clauses;
}

/**
 * Gate the full-text `search` filter on {@link Dialect.supportsFullTextSearch}.
 * The clause it guards is `to_tsvector(...) @@ to_tsquery(...)`, which only
 * PostgreSQL parses, so every other engine gets a typed
 * {@link UnsupportedFeatureError} (E017) instead of a raw driver syntax error.
 * Called from BOTH the build and the param-collect side (mirroring the vector
 * gate) so the two paths can never diverge.
 */
export function requireFullTextSearch(qi: BuilderCtx): void {
  if (qi.dialect.supportsFullTextSearch) return;
  throw new UnsupportedFeatureError(
    'the full-text search filter (`search`)',
    qi.dialect.name,
    'Full-text `search` compiles to PostgreSQL to_tsvector/to_tsquery. ' +
      'Use `contains` (LIKE) on this engine, or run the query on PostgreSQL.',
  );
}

/**
 * Gate the pathless JSON containment filters (`contains`, and the `equals`
 * spelling that compiles to the same expression) on
 * {@link Dialect.supportsJsonContains}.
 *
 * The engine this exists for is SQLite, whose emulation compares a decoded
 * `json_each.value` against a param bound as JSON TEXT and therefore matched
 * NOTHING, for every operand type: object, array, string and number alike all
 * returned zero rows where PostgreSQL and MySQL returned the document (measured
 * in-process, table in dialect.ts). Fewer rows with no error is precisely what
 * the capability contract exists to convert into a refusal, and since the
 * feature never worked there, refusing it removes nothing.
 *
 * Called from BOTH the build and the param-collect side, and here that is
 * load-bearing rather than symmetric-for-its-own-sake: a {@link JsonFilter}
 * fingerprints by which KEYS are present, not by what they hold, so every
 * `contains` on a column shares one cache entry and a build-only gate would be
 * skipped for the entire warm life of that entry.
 */
export function requireJsonContains(qi: BuilderCtx, clause: 'contains' | 'equals'): void {
  if (qi.dialect.supportsJsonContains) return;
  throw new UnsupportedFeatureError(
    `JSON containment (\`${clause}\` without \`path\`)`,
    qi.dialect.name,
    `This engine has no equivalent of PostgreSQL's \`@>\`, and the emulation Turbine used for ` +
      `\`${clause}\` matched no rows for any operand rather than failing, so it is refused instead. ` +
      'Filter on the specific value instead: `{ path: [...], equals: ... }` compiles to a real JSON ' +
      'extraction (`json_extract`) rather than an emulation. For structural containment, run the ' +
      'query on PostgreSQL or MySQL.',
  );
}

/**
 * Gate the array filter operators (`has` / `hasEvery` / `hasSome` / `isEmpty`)
 * on {@link Dialect.supportsArrayColumns}. They compile to PostgreSQL array
 * operators (`= ANY(col)`, `@>`, `&&`, `cardinality(col)`) over a native array
 * column, which no other supported engine has. Called from BOTH the build and
 * the param-collect side.
 */
export function requireArrayColumns(qi: BuilderCtx): void {
  if (qi.dialect.supportsArrayColumns) return;
  throw new UnsupportedFeatureError(
    'the array column filter set (`has` / `hasEvery` / `hasSome` / `isEmpty`)',
    qi.dialect.name,
    'Array filters compile to PostgreSQL array operators over a native array ' +
      'column; this engine has no array column type.',
  );
}

/**
 * Resolve a {@link VectorMetric} to its pgvector distance operator from a
 * fixed allow-list, validating the target column is actually a `vector`
 * column. Throws {@link ValidationError} for an unknown metric or a
 * non-vector column, a user-supplied string can never become a SQL operator.
 */
export function vectorOperator(qi: BuilderCtx, field: string, rawColumn: string, metric: string): string {
  if (!qi.dialect.supportsVector) {
    throw new UnsupportedFeatureError(
      'pgvector distance operations',
      qi.dialect.name,
      'Vector search requires PostgreSQL with the pgvector extension.',
    );
  }
  const colType = getColumnPgType(qi, rawColumn);
  if (colType !== 'vector') {
    throw new ValidationError(
      `Column "${field}" on table "${qi.table}" is not a vector column ` +
        `(actual type: ${colType}); cannot apply a vector distance operation.`,
    );
  }
  // ownLookup, not a bare index: an inherited Object.prototype member
  // ("constructor", "toString", …) would otherwise resolve to a truthy builtin
  // and be spliced into the ORDER BY / WHERE clause as its source text.
  const op = ownLookup(VECTOR_METRIC_OPERATORS, metric);
  if (!op) {
    throw new ValidationError(
      `Unknown vector metric "${metric}" for column "${field}". ` +
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
export function pushVectorParam(
  qi: BuilderCtx,
  field: string,
  _rawColumn: string,
  to: unknown,
  params: unknown[],
): string {
  if (!qi.dialect.supportsVector) {
    throw new UnsupportedFeatureError(
      'pgvector distance operations',
      qi.dialect.name,
      'Vector search requires PostgreSQL with the pgvector extension.',
    );
  }
  if (!Array.isArray(to) || to.length === 0) {
    throw new ValidationError(`Vector distance on "${field}" requires a non-empty array of numbers for "to".`);
  }
  for (const el of to) {
    if (typeof el !== 'number' || !Number.isFinite(el)) {
      throw new ValidationError(
        `Vector "to" for column "${field}" must contain only finite numbers; ` + `got ${JSON.stringify(el)}.`,
      );
    }
  }
  // Bind as a pgvector text literal '[1,2,3]'. Elements are already validated
  // as finite numbers, so the joined string is safe; it is still passed as a
  // bound param (never interpolated) and cast with ::vector.
  params.push(`[${(to as number[]).join(',')}]`);
  return `${qi.p(params.length)}::vector`;
}

/**
 * Prisma-compat: a plain object on a to-one relation key -
 * `where: { vendor: { name: { contains: 'x' } } }`, is an implicit `is`
 * filter. Normalize it to `{ is: obj }` so all downstream handling (SQL,
 * params, fingerprint) sees one canonical shape. To-many relations still
 * require an explicit `some`/`every`/`none` (a bare object there is
 * ambiguous and was never valid in Prisma either).
 */
export function normalizeRelationFilter(
  _qi: BuilderCtx,
  relDef: RelationDef,
  filterObj: Record<string, unknown>,
): Record<string, unknown> {
  if (
    (relDef.type === 'belongsTo' || relDef.type === 'hasOne') &&
    !('some' in filterObj) &&
    !('every' in filterObj) &&
    !('none' in filterObj) &&
    !('is' in filterObj) &&
    !('isNot' in filterObj)
  ) {
    return { is: filterObj };
  }
  return filterObj;
}

/**
 * Case-insensitive json/jsonb column-type check. Postgres reports lowercase
 * udt_names, but SQLite/MySQL introspection surfaces the DECLARED type
 * (e.g. `JSON`), so every JSON-feature gate compares through this predicate
 * - build and collect sides alike, keeping the SQL-cache lockstep.
 */
export function isJsonColumnType(_qi: BuilderCtx, colType: string): boolean {
  const t = colType.toLowerCase();
  return t === 'json' || t === 'jsonb';
}

export function getColumnPgType(qi: BuilderCtx, column: string): string {
  return qi.columnPgTypeMap.get(column) ?? 'text';
}

/**
 * Get the Postgres base element type for an array column.
 * E.g. '_text' → 'text', '_int4' → 'integer'
 */
export function getArrayElementType(_qi: BuilderCtx, pgType: string): string {
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
 * Validate and enumerate the range comparisons (`gt`/`gte`/`lt`/`lte`) on a
 * JSON filter, in the fixed {@link JSON_RANGE_OPERATORS} order. Shared by
 * the SQL-build path ({@link buildJsonFilterClauses}) and the cache-hit
 * param-collect path ({@link collectJsonFilterParams}) so both always agree
 * on which params are pushed, and both throw identically for invalid
 * shapes, so a warmed cache can never skip validation.
 */
/**
 * One LIKE comparison, honoring `mode: 'insensitive'` through the dialect and
 * always carrying the `ESCAPE '\'` clause that pairs with {@link escapeLike}.
 *
 * Shared by the scalar `contains` / `startsWith` / `endsWith` operators and by
 * the JSON substring operators, so the two can never drift into escaping their
 * operands the same way but comparing them differently.
 */
function buildLikeClause(qi: BuilderCtx, column: string, paramRef: string, insensitive: boolean): string {
  const base = insensitive ? qi.dialect.buildInsensitiveLike(column, paramRef) : `${column} LIKE ${paramRef}`;
  return `${base} ESCAPE '\\'`;
}

/**
 * Refuse a {@link JsonFilter} carrying a key that is not a JSON operator, and
 * refuse a filter that selects a `path` but never compares it.
 *
 * Both shapes used to compile to NOTHING. `buildJsonFilterClauses` only ever
 * emitted a clause for a key it recognized, so `{ path: ['title'],
 * string_contains: 'x' }`, the Prisma spelling, and an easy typo besides -
 * produced an empty clause list, the predicate vanished, and the query
 * returned EVERY row. Inside an `AND` it silently dropped that conjunct, so a
 * tenant scope written this way widened to the whole table. The equivalent
 * typo on a scalar column has always thrown; this closes the inconsistency.
 *
 * Called from both the SQL-build path and the cache-hit param-collect path, so
 * a warmed SQL cache cannot skip the check.
 */
export function assertJsonFilterKeys(filter: JsonFilter, column: string): void {
  const obj = filter as Record<string, unknown>;
  const present = Object.keys(obj).filter((k) => obj[k] !== undefined);

  for (const key of present) {
    if (JSON_FILTER_KEYS.has(key)) continue;
    const suggestion = JSON_PRISMA_SPELLINGS[key];
    throw new ValidationError(
      `Unknown JSON filter operator "${key}" on ${column}.` +
        (suggestion ? ` Did you mean \`${suggestion}\`?` : '') +
        ` Supported operators: ${[...JSON_FILTER_KEYS].sort().join(', ')}.`,
    );
  }

  // `mode` and `path` are modifiers, not comparisons: a filter made only of
  // those compares nothing, which is exactly the silent no-op shape above.
  if (present.length > 0 && present.every((k) => k === 'path' || k === 'mode')) {
    throw new ValidationError(
      `JSON filter on ${column} selects a \`path\` but has no comparison. ` +
        `Add one of: ${[...JSON_FILTER_KEYS]
          .filter((k) => k !== 'path' && k !== 'mode')
          .sort()
          .join(', ')}.`,
    );
  }
}

/**
 * The Prisma spelling of each JSON operator, so a migrator who writes the
 * name they already know gets told the turbine one instead of a bare list.
 */
const JSON_PRISMA_SPELLINGS: Record<string, string> = {
  string_contains: 'stringContains',
  string_starts_with: 'stringStartsWith',
  string_ends_with: 'stringEndsWith',
  array_contains: 'contains',
  startsWith: 'stringStartsWith',
  endsWith: 'stringEndsWith',
};

/**
 * Validate and enumerate the substring comparisons on a JSON filter, in the
 * fixed {@link JSON_STRING_OPERATORS} order. Shared by the build and collect
 * paths exactly like {@link jsonRangeEntries}, so both agree on the params
 * pushed and both throw identically on an invalid shape.
 */
export function jsonStringEntries(
  filter: JsonFilter,
  column: string,
): { op: string; pattern: (escaped: string) => string; value: string }[] {
  const entries: { op: string; pattern: (escaped: string) => string; value: string }[] = [];
  for (const [op, pattern] of Object.entries(JSON_STRING_OPERATORS)) {
    const value = (filter as Record<string, unknown>)[op];
    if (value === undefined) continue;
    if (filter.path === undefined) {
      throw new ValidationError(
        `JSON operator '${op}' on ${column} requires a \`path\` ` +
          `(e.g. { path: ['meta', 'title'], ${op}: ${valueForMessage(value)} }).`,
      );
    }
    if (typeof value !== 'string') {
      // `typeof` rather than the value: it says everything the reader needs
      // (they passed a number where a string belongs) and carries no data.
      throw new ValidationError(
        `JSON operator '${op}' on ${column} requires a string, got ${typeof value} ` + `(${valueForMessage(value)}).`,
      );
    }
    entries.push({ op, pattern, value });
  }
  return entries;
}

export function jsonRangeEntries(
  _qi: BuilderCtx,
  filter: JsonFilter,
  column: string,
): { sqlOp: string; value: number | string }[] {
  const entries: { sqlOp: string; value: number | string }[] = [];
  for (const [op, sqlOp] of Object.entries(JSON_RANGE_OPERATORS)) {
    const value = (filter as Record<string, unknown>)[op];
    if (value === undefined) continue;
    if (filter.path === undefined) {
      throw new ValidationError(
        `JSON range operator '${op}' on ${column} requires a \`path\` ` +
          `(e.g. { path: ['meta', 'score'], ${op}: ${valueForMessage(value)} }).`,
      );
    }
    if (typeof value !== 'number' && typeof value !== 'string') {
      throw new ValidationError(
        `JSON range operator '${op}' on ${column} requires a number or string, ` +
          `got ${typeof value} (${valueForMessage(value)}).`,
      );
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new ValidationError(`JSON range operator '${op}' on ${column} requires a finite number.`);
    }
    entries.push({ sqlOp, value });
  }
  return entries;
}

/**
 * Build SQL clauses for JSONB filter operators on a column.
 * Supports: path, equals, contains, hasKey, gt, gte, lt, lte.
 *
 * The `path` param is bound at most once and its placeholder is shared by
 * every clause that extracts it (equals + range ops), so the param list
 * stays byte-identical to {@link collectJsonFilterParams}.
 */
export function buildJsonFilterClauses(
  qi: BuilderCtx,
  column: string,
  filter: JsonFilter,
  params: unknown[],
): string[] {
  assertJsonFilterKeys(filter, column);
  const clauses: string[] = [];

  // Lazily bind the path once; reuse the same $N in every extraction clause.
  let pathParamIdx: number | null = null;
  const pathExtract = (): string => {
    if (pathParamIdx === null) {
      // Only reached when a path-requiring clause validated filter.path.
      params.push(jsonPathParam(qi, filter.path!, filter.path));
      pathParamIdx = params.length;
    }
    return qi.dialect.buildJsonPathExtract(column, qi.p(pathParamIdx));
  };

  if (filter.path !== undefined && filter.equals !== undefined) {
    // Path access + equals: column #>> $N::text[] = $M
    const extract = pathExtract();
    params.push(String(filter.equals));
    clauses.push(`${extract} = ${qi.p(params.length)}`);
  } else if (filter.equals !== undefined) {
    // Containment equality: column @> $N::jsonb. A pathless `equals` compiles
    // to the SAME containment expression `contains` does, so it inherits the
    // same engine limitation and is refused under its own clause name (the two
    // spellings are far enough apart that naming the wrong one would send the
    // reader to the wrong line).
    requireJsonContains(qi, 'equals');
    params.push(JSON.stringify(filter.equals));
    clauses.push(qi.dialect.buildJsonContains(column, qi.p(params.length)));
  }

  if (filter.contains !== undefined) {
    // Containment: column @> $N::jsonb
    requireJsonContains(qi, 'contains');
    params.push(JSON.stringify(filter.contains));
    clauses.push(qi.dialect.buildJsonContains(column, qi.p(params.length)));
  }

  if (filter.hasKey !== undefined) {
    // Key existence: column ? $N
    params.push(filter.hasKey);
    clauses.push(`${column} ? ${qi.p(params.length)}`);
  }

  // Range comparisons on the extracted path: numbers compare numerically
  // (cast through the dialect), strings compare as text.
  for (const { sqlOp, value } of jsonRangeEntries(qi, filter, column)) {
    const extract = pathExtract();
    params.push(value);
    const lhs = typeof value === 'number' ? castJsonNumeric(qi, extract) : extract;
    clauses.push(`${lhs} ${sqlOp} ${qi.p(params.length)}`);
  }

  // Substring comparisons on the extracted path. The operand is LIKE-escaped
  // exactly like the scalar `contains` family, so a value containing `%` or
  // `_` matches literally instead of turning into a wildcard.
  for (const { pattern, value } of jsonStringEntries(filter, column)) {
    const extract = pathExtract();
    params.push(pattern(likeOperand(qi, value)));
    clauses.push(buildLikeClause(qi, extract, qi.p(params.length), filter.mode === 'insensitive'));
  }

  return clauses;
}

/**
 * Bind value for a JSON path parameter, encoded per dialect. PostgreSQL's
 * `#>>` takes a `text[]` (the segments as strings, or `nativeForm` when the
 * caller has a specific native binding, e.g. JsonFilter's raw path array).
 * Every other engine's JSON function (`json_extract` / `JSON_EXTRACT` /
 * `JSON_VALUE`) takes a `'$'`-rooted JSONPath STRING: binding the raw array
 * would arrive as `'["a"]'` (the driver shims JSON.stringify non-primitive
 * params) and fail at runtime with the engine's bad-JSON-path error. The
 * encoded path stays a bound parameter, never spliced into SQL text, so
 * the build/collect param mirrors stay in lockstep and injection-safe.
 */
export function jsonPathParam(qi: BuilderCtx, path: readonly (string | number)[], nativeForm?: unknown): unknown {
  if (qi.dialect.jsonPathSupport === 'native') return nativeForm ?? path.map(String);
  return `$${path
    .map((seg) =>
      typeof seg === 'number' || /^\d+$/.test(String(seg)) ? `[${seg}]` : `."${String(seg).replace(/"/g, '\\"')}"`,
    )
    .join('')}`;
}

/**
 * Cast an extracted JSON path text value to a numeric type for range
 * comparison. PostgreSQL uses `(expr)::numeric` (exact, the right way to
 * compare JSON numbers, and `::float` would lose precision on big ints);
 * other dialects route through {@link Dialect.castAggregate} (SQLite/MySQL/
 * SQL Server have no `::` operator) as a float cast.
 */
export function castJsonNumeric(qi: BuilderCtx, extract: string): string {
  if (qi.dialect.name === 'postgresql') return `(${extract})::numeric`;
  return qi.dialect.castAggregate ? qi.dialect.castAggregate(`(${extract})`, 'float') : `(${extract})::numeric`;
}

/**
 * Build SQL clauses for Array filter operators on a column.
 * Supports: has, hasEvery, hasSome, isEmpty.
 */
export function buildArrayFilterClauses(
  qi: BuilderCtx,
  column: string,
  filter: ArrayFilter,
  params: unknown[],
  pgType: string,
): string[] {
  requireArrayColumns(qi);
  const clauses: string[] = [];
  const elementType = getArrayElementType(qi, pgType);

  if (filter.has !== undefined) {
    // value = ANY(column)
    params.push(filter.has);
    clauses.push(`${qi.p(params.length)} = ANY(${column})`);
  }

  if (filter.hasEvery !== undefined) {
    // column @> ARRAY[...]::type[]
    params.push(filter.hasEvery);
    clauses.push(`${column} @> ${qi.p(params.length)}::${elementType}[]`);
  }

  if (filter.hasSome !== undefined) {
    // column && ARRAY[...]::type[]
    params.push(filter.hasSome);
    clauses.push(`${column} && ${qi.p(params.length)}::${elementType}[]`);
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
export function buildVectorFilterClauses(
  qi: BuilderCtx,
  field: string,
  rawColumn: string,
  filter: VectorFilter,
  params: unknown[],
): string[] {
  const dist = filter.distance;
  const operator = vectorOperator(qi, field, rawColumn, dist.metric);
  const placeholder = pushVectorParam(qi, field, rawColumn, dist.to, params);
  const distanceExpr = `${qi.q(rawColumn)} ${operator} ${placeholder}`;

  const clauses: string[] = [];
  for (const { sqlOp, threshold } of vectorThresholdEntries(filter, field)) {
    params.push(threshold);
    clauses.push(`${distanceExpr} ${sqlOp} ${qi.p(params.length)}`);
  }
  return clauses;
}

/**
 * Validate and enumerate the distance comparisons on a vector filter, in the
 * fixed {@link VECTOR_DISTANCE_COMPARATORS} order. Shared by the SQL-build path
 * ({@link buildVectorFilterClauses}) and the cache-hit param-collect path
 * ({@link collectVectorFilterParams}), exactly like {@link jsonRangeEntries}.
 *
 * IT IS THE VALIDATION THAT MAKES THIS SHARED, not the enumeration. Both sides
 * used to inline the same `for` loop, and only the build side checked the
 * threshold. That build side does not run on a cache HIT, and outside dev the
 * lockstep cross-check (which re-runs it, and is what masked this) is off, so a
 * warmed template bound `lt: NaN`, `lt: '5'` or `lt: { a: 1 }` straight into
 * the statement. NaN is the one that matters: Postgres sorts it above every
 * real distance, so `distance < NaN` matches EVERY row, i.e. the predicate
 * inverts, silently, in production only. Same bug class as the 0.19.2 /
 * 0.32.1 cache-hit drifts, and the same fix: one function, both paths.
 *
 * The "at least one comparison" refusal lives here too, so the collect path
 * cannot quietly accept a filter the build path rejects.
 */
export function vectorThresholdEntries(filter: VectorFilter, field: string): { sqlOp: string; threshold: number }[] {
  const dist = filter.distance;
  const entries: { sqlOp: string; threshold: number }[] = [];
  for (const [cmp, sqlOp] of Object.entries(VECTOR_DISTANCE_COMPARATORS)) {
    const threshold = (dist as unknown as Record<string, unknown>)[cmp];
    if (threshold === undefined) continue;
    if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
      throw new ValidationError(
        `Vector distance threshold "${cmp}" on "${field}" must be a finite number; ` +
          `got ${typeof threshold} (${valueForMessage(threshold)}).`,
      );
    }
    entries.push({ sqlOp, threshold });
  }
  if (entries.length === 0) {
    throw new ValidationError(
      `Vector distance filter on "${field}" requires at least one comparison (lt / lte / gt / gte).`,
    );
  }
  return entries;
}

/**
 * Build SQL clause for full-text search using to_tsvector @@ to_tsquery.
 * The config name is validated to prevent injection (only alphanumeric + underscore).
 */
export function buildTextSearchClause(
  qi: BuilderCtx,
  column: string,
  filter: TextSearchFilter,
  params: unknown[],
): string {
  requireFullTextSearch(qi);
  const config = filter.config ?? 'english';
  if (!validateTextSearchConfig(config)) {
    throw new ValidationError(
      `Invalid text search config "${config}": only alphanumeric characters and underscores are allowed.`,
    );
  }
  params.push(filter.search);
  return `to_tsvector('${config}', ${column}) @@ to_tsquery('${config}', ${qi.p(params.length)})`;
}

/**
 * Get the Postgres array type for a column (used by UNNEST in createMany).
 * Uses pre-computed Map for O(1) lookup instead of linear scan.
 */
export function getColumnArrayType(qi: BuilderCtx, column: string): string {
  const arrayType = qi.columnArrayTypeMap.get(column);
  if (arrayType) return arrayType;

  // The column's DECLARED type always beats any name-based guess: a text/uuid
  // "author_id" must never be cast bigint[] just because of its suffix (that
  // produced real 22P02 failures on createMany against uuid-keyed tables).
  const declared = Object.hasOwn(qi.tableMeta.pgTypes, column) ? qi.tableMeta.pgTypes[column] : undefined;
  if (declared) return qi.dialect.arrayType?.(declared) ?? 'text[]';

  // Last-resort heuristic for columns absent from the metadata entirely,
  // routed through the active dialect so non-Postgres packages can supply
  // their own bulk-insert cast shape.
  if (column === 'id' || column.endsWith('_id')) return qi.dialect.arrayType?.('int8') ?? 'text[]';
  if (column.endsWith('_at')) return qi.dialect.arrayType?.('timestamptz') ?? 'text[]';
  return qi.dialect.arrayType?.('text') ?? 'text[]';
}
