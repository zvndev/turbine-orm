/**
 * turbine-orm — WHERE-clause compilation (extracted from builder.ts)
 *
 * The whole WHERE web: the top-level build/collect/fingerprint trio, the
 * table-scoped trio for relation-filter EXISTS sub-wheres and relation
 * `with`-clause wheres, the leaf JSON/array/vector/text-search clause builders,
 * operator-clause + column-reference compilation, and the client-level
 * global-filter helpers. All functions take a {@link BuilderCtx} as their first
 * argument — the privacy-preserving view of the owning {@link QueryInterface}
 * instance (built once in its constructor) exposing exactly the class-resident
 * primitives this module needs. See builder.ts for the thin delegating methods.
 */

import type pg from 'pg';
import type { Dialect } from '../dialect.js';
import { UnsupportedFeatureError, ValidationError } from '../errors.js';
import type { RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';
import { camelToSnake } from '../schema.js';
import {
  assertBindableEqualsOperand,
  findArrayUniqueKey,
  findJsonUniqueKey,
  isArrayFilter,
  isColumnRef,
  isJsonFilter,
  isUnmatchedPlainObject,
  isWhereOperator,
  JSON_RANGE_OPERATORS,
  VECTOR_DISTANCE_COMPARATORS,
  VECTOR_METRIC_OPERATORS,
  validateTextSearchConfig,
} from './filters.js';
import type {
  ArrayFilter,
  ColumnRef,
  GlobalFilters,
  JsonFilter,
  JsonPathOrderBy,
  SkipGlobalFilters,
  TextSearchFilter,
  VectorFilter,
  WhereClause,
  WhereOperator,
} from './types.js';
import { escapeLike, OPERATOR_KEYS, type SqlCacheEntry } from './utils.js';
import {
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
  readonly crossSchemaTypeColumns: Set<string>;
  /**
   * The active query's `skipGlobalFilters` opt-out. A live getter/setter over
   * the owning instance's field: `build*` methods set it at their top, and the
   * synchronous SQL-build + param-collect tree reads it deep inside
   * `resolveGlobalFilter`.
   */
  currentSkip: SkipGlobalFilters | undefined;
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
  mutationInsertId(result: pg.QueryResult): unknown;
  acquireSql(cacheKey: string, build: (params: unknown[]) => string): SqlCacheEntry;
  crossCheckCache(
    op: string,
    cacheKey: string,
    entry: SqlCacheEntry,
    build: (params: unknown[]) => string,
    collectedParams: unknown[],
  ): void;
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
}

/**
 * A table-scoped WHERE compilation context for a sub-where that is NOT the
 * top-level `this.tableMeta` clause. Both relation-filter `EXISTS` sub-wheres
 * (correlated against the bare target table, `"target".col`) and relation
 * `with`-clause `where` filters (against a per-subquery alias, `t0.col`) compile
 * an arbitrary target table's where against a column qualifier. They differ ONLY
 * in that qualifier, the correlation parent handed to `buildRelationFilter`, and
 * the unknown-column error wording — so a single scoped build/collect/fingerprint
 * trio, driven by the SAME canonical {@link walkWhere} the top level uses, serves
 * both. See `buildScopedWhere` / `collectScopedWhereParams` / `fingerprintScopedWhere`.
 */
interface WhereScope {
  /** The target table's metadata (column map, relations, types). */
  meta: TableMetadata;
  /** The target table name (used for host binding + error messages). */
  table: string;
  /** SQL prefix before `q(col)` — `"target".` for EXISTS sub-wheres, `t0.` for aliases. */
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
export function fingerprintWhere(qi: BuilderCtx, where: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const event of walkWhere(qi.whereHost, where)) {
    switch (event.kind) {
      case 'or':
        parts.push(`OR[${event.conditions.map((cond) => fingerprintWhere(qi, cond)).join(',')}]`);
        break;
      case 'and':
        parts.push(`AND[${event.conditions.map((cond) => fingerprintWhere(qi, cond)).join(',')}]`);
        break;
      case 'not':
        parts.push(`NOT(${fingerprintWhere(qi, event.condition)})`);
        break;
      case 'relation':
        // { posts: { some: { published: true } } } → `posts:{some(...)}`
        parts.push(`${event.key}:{${fingerprintRelationParts(qi, event.relDef, event.filterObj).join(',')}}`);
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
export function fingerprintRelationParts(qi: BuilderCtx, relDef: RelationDef, filterObj: WhereRecord): string[] {
  const relParts: string[] = [];
  if (filterObj.some !== undefined)
    relParts.push(
      filterObj.some === null
        ? 'some(null)'
        : `some(${fingerprintRelFilter(qi, relDef.to, filterObj.some as Record<string, unknown>)})`,
    );
  if (filterObj.every !== undefined)
    relParts.push(
      filterObj.every === null
        ? 'every(null)'
        : `every(${fingerprintRelFilter(qi, relDef.to, filterObj.every as Record<string, unknown>)})`,
    );
  if (filterObj.none !== undefined)
    relParts.push(
      filterObj.none === null
        ? 'none(null)'
        : `none(${fingerprintRelFilter(qi, relDef.to, filterObj.none as Record<string, unknown>)})`,
    );
  if (filterObj.is !== undefined)
    relParts.push(
      filterObj.is === null
        ? 'is(null)'
        : `is(${fingerprintRelFilter(qi, relDef.to, filterObj.is as Record<string, unknown>)})`,
    );
  if (filterObj.isNot !== undefined)
    relParts.push(
      filterObj.isNot === null
        ? 'isNot(null)'
        : `isNot(${fingerprintRelFilter(qi, relDef.to, filterObj.isNot as Record<string, unknown>)})`,
    );
  return relParts;
}

/**
 * Fingerprint a relation filter sub-where for some/every/none. Thin wrapper
 * over the unified {@link fingerprintScopedWhere}. When the target table is
 * unknown, an empty-relations host makes every key scalar (matching the old
 * `meta?.relations` short-circuit).
 */
export function fingerprintRelFilter(qi: BuilderCtx, targetTable: string, subWhere: Record<string, unknown>): string {
  const meta = qi.schema.tables[targetTable];
  const host = meta ? scopedWhereHost(qi, meta) : emptyRelationsHost(qi, targetTable);
  return fingerprintScopedWhere(qi, host, subWhere);
}

/**
 * Walk a where clause and push ONLY values into `params`, in the EXACT same
 * order that `buildWhereClause` pushes them. Used on cache hit to fill params
 * without rebuilding SQL.
 *
 * @internal Exposed as package-private for testing.
 */
export function collectWhereParams(qi: BuilderCtx, where: Record<string, unknown>, params: unknown[]): void {
  // ONE canonical walk (shared with fingerprintWhere + buildWhereClause), so
  // the key order + combinator structure cannot drift out of lockstep.
  for (const event of walkWhere(qi.whereHost, where)) {
    switch (event.kind) {
      case 'or':
      case 'and':
        for (const cond of event.conditions) collectWhereParams(qi, cond, params);
        break;
      case 'not':
        collectWhereParams(qi, event.condition, params);
        break;
      case 'relation':
        collectRelationFilterParams(qi, event.relDef, event.filterObj, params);
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
      params.push((value as TextSearchFilter).search);
      return;
    case 'operator':
      collectOperatorParams(qi, rawColumn, value as WhereOperator, params, {
        meta: qi.tableMeta,
        table: qi.table,
        prefix: '',
      });
      return;
    default:
      // 'equality' | 'jsonThrow' | 'arrayThrow': same strict validation as
      // the build path, so a cache hit can never silently bind a
      // misspelled-operator object.
      assertBindableEqualityValue(qi, rawColumn, value, getColumnPgType(qi, rawColumn), qi.table);
      params.push(value);
      return;
  }
}

/**
 * Param-collect mirror of {@link buildRelationFilter} for one relation-filter
 * object (`{ some/every/none/is/isNot }`, already normalized). Pushes, per
 * present branch and in the canonical order some→none→every→is→isNot, the
 * branch's sub-where params THEN the target table's global-filter params —
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
): void {
  const target = relDef.to;
  if (filterObj.some !== undefined && filterObj.some !== null) {
    collectRelFilterParams(qi, target, filterObj.some as Record<string, unknown>, params);
    collectTargetGlobalFilterExists(qi, target, params);
  }
  if (filterObj.none !== undefined && filterObj.none !== null) {
    collectRelFilterParams(qi, target, filterObj.none as Record<string, unknown>, params);
    collectTargetGlobalFilterExists(qi, target, params);
  }
  if (filterObj.every !== undefined && filterObj.every !== null) {
    // gf is only emitted (build) when the `every` sub-where compiles to a
    // filter — otherwise `every` is trivially true and no subquery is built.
    if (buildSubWhereForRelation(qi, target, filterObj.every as Record<string, unknown>, []) !== null) {
      collectRelFilterParams(qi, target, filterObj.every as Record<string, unknown>, params);
      collectTargetGlobalFilterExists(qi, target, params);
    }
  }
  if (filterObj.is !== undefined) {
    if (filterObj.is !== null) collectRelFilterParams(qi, target, filterObj.is as Record<string, unknown>, params);
    collectTargetGlobalFilterExists(qi, target, params);
  }
  if (filterObj.isNot !== undefined) {
    if (filterObj.isNot !== null)
      collectRelFilterParams(qi, target, filterObj.isNot as Record<string, unknown>, params);
    collectTargetGlobalFilterExists(qi, target, params);
  }
}

export function collectRelFilterParams(
  qi: BuilderCtx,
  targetTable: string,
  subWhere: Record<string, unknown>,
  params: unknown[],
): void {
  const meta = qi.schema.tables[targetTable];
  if (!meta) return;
  collectScopedWhereParams(qi, relationWhereScope(qi, targetTable, meta), subWhere, params);
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
  if (op.equals !== undefined && op.equals !== null && !skipRef(op.equals)) {
    assertBindableEqualsOperand(op.equals, `"${column}"`);
    params.push(op.equals);
  }
  if (op.gt !== undefined && !skipRef(op.gt)) params.push(op.gt);
  if (op.gte !== undefined && !skipRef(op.gte)) params.push(op.gte);
  if (op.lt !== undefined && !skipRef(op.lt)) params.push(op.lt);
  if (op.lte !== undefined && !skipRef(op.lte)) params.push(op.lte);
  if (op.not !== undefined && op.not !== null && !skipRef(op.not)) params.push(op.not);
  if (op.in !== undefined) params.push(qi.inParam(op.in));
  if (op.notIn !== undefined) params.push(qi.inParam(op.notIn));
  if (op.contains !== undefined) params.push(`%${escapeLike(op.contains)}%`);
  if (op.startsWith !== undefined) params.push(`${escapeLike(op.startsWith)}%`);
  if (op.endsWith !== undefined) params.push(`%${escapeLike(op.endsWith)}`);
}

/**
 * Collect params from JSON filter. Mirrors buildJsonFilterClauses exactly:
 * the `path` is bound at most once (its placeholder is shared by every
 * extraction clause), then equals/contains/hasKey values, then the range
 * comparison values in {@link JSON_RANGE_OPERATORS} order.
 */
export function collectJsonFilterParams(qi: BuilderCtx, filter: JsonFilter, params: unknown[], column: string): void {
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
    params.push(JSON.stringify(filter.equals));
  }
  if (filter.contains !== undefined) {
    params.push(JSON.stringify(filter.contains));
  }
  if (filter.hasKey !== undefined) {
    params.push(filter.hasKey);
  }
  for (const { value } of jsonRangeEntries(qi, filter, column)) {
    pushPathOnce();
    params.push(value);
  }
}

/** Collect params from array filter. Mirrors buildArrayFilterClauses. */
export function collectArrayFilterParams(_qi: BuilderCtx, filter: ArrayFilter, params: unknown[]): void {
  if (filter.has !== undefined) params.push(filter.has);
  if (filter.hasEvery !== undefined) params.push(filter.hasEvery);
  if (filter.hasSome !== undefined) params.push(filter.hasSome);
  // isEmpty has no params (IS NULL / IS NOT NULL)
}

/**
 * Collect params for a vector distance WHERE filter. Mirrors
 * {@link buildVectorFilterClauses}: the `$n::vector` query vector first, then
 * the comparison threshold(s).
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
  for (const cmp of Object.keys(VECTOR_DISTANCE_COMPARATORS)) {
    const threshold = (dist as unknown as Record<string, unknown>)[cmp];
    if (threshold !== undefined) params.push(threshold);
  }
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
 * Resolve the configured global filter for `table`, evaluating a function
 * filter, honoring the active query's `skipGlobalFilters`. Returns `null` when
 * no filter applies, the query opted out, or the filter is empty.
 */
export function resolveGlobalFilter(
  qi: BuilderCtx,
  table: string,
  skip: SkipGlobalFilters | undefined = qi.currentSkip,
): Record<string, unknown> | null {
  const filters = qi.globalFilters;
  if (!filters) return null;
  if (skip === true) return null;
  if (Array.isArray(skip) && skip.includes(table)) return null;
  const raw = filters[table];
  if (raw === undefined) return null;
  const resolved = typeof raw === 'function' ? raw() : raw;
  if (resolved === null || resolved === undefined) return null;
  const obj = resolved as Record<string, unknown>;
  // An all-undefined filter (e.g. `{ tenantId: undefined }`) contributes
  // nothing — treat it as absent so it never emits a dangling clause.
  if (Object.keys(obj).every((k) => obj[k] === undefined)) return null;
  return obj;
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
  return { AND: [userWhere, gf] };
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
 * (unaliased) table name — the form used inside relation-filter `EXISTS`
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
    if (gf) parts.push(`${table}:${fingerprintWhere(qi, gf)}`);
  }
  return parts.length ? `|gf=${parts.join(';')}` : '';
}

/**
 * True when the USER-supplied `where` compiles to no predicate (`{}`,
 * `{ id: undefined }`, `{ OR: [{ a: undefined }] }`, …). This is the exact
 * signal the empty-`where` guard needs — the compiled emptiness, NOT the
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
  allowFullTableScan: boolean | undefined,
): void {
  if (whereSql.length > 0) return;
  if (allowFullTableScan === true) return;
  throw new ValidationError(
    `[turbine] ${operation} on "${qi.table}" refused: the \`where\` clause is empty. ` +
      `Pass \`allowFullTableScan: true\` to opt in, or check that your filter values are defined.`,
  );
}

/**
 * Build the inner WHERE expression (without the WHERE keyword).
 * Returns null if no conditions exist.
 * Supports: equality, operators, NULL, OR, AND, NOT, relation filters (some/every/none).
 */
export function buildWhereClause(qi: BuilderCtx, where: Record<string, unknown>, params: unknown[]): string | null {
  const andClauses: string[] = [];

  // ONE canonical walk (shared with fingerprintWhere + collectWhereParams).
  for (const event of walkWhere(qi.whereHost, where)) {
    switch (event.kind) {
      case 'or': {
        const orClauses: string[] = [];
        for (const orCond of event.conditions) {
          const sub = buildWhereClause(qi, orCond, params);
          if (sub) orClauses.push(sub);
        }
        if (orClauses.length > 0) andClauses.push(`(${orClauses.join(' OR ')})`);
        break;
      }
      case 'and':
        for (const andCond of event.conditions) {
          const sub = buildWhereClause(qi, andCond, params);
          if (sub) andClauses.push(sub);
        }
        break;
      case 'not': {
        const sub = buildWhereClause(qi, event.condition, params);
        if (sub) andClauses.push(`NOT (${sub})`);
        break;
      }
      case 'relation': {
        // { posts: { some: { published: true } } } → EXISTS / NOT EXISTS
        const relClause = buildRelationFilter(qi, event.key, event.relDef, event.filterObj, params);
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
        `[turbine] Column "${rawColumn}" on table "${qi.table}" is not a JSON column ` +
          `(actual type: ${getColumnPgType(qi, rawColumn)}); cannot apply JSON operator '${cls.jsonKey}'.`,
      );
    case 'array':
      andClauses.push(...buildArrayFilterClauses(qi, column, value as ArrayFilter, params, cls.colType));
      return;
    case 'arrayThrow':
      throw new ValidationError(
        `[turbine] Column "${rawColumn}" on table "${qi.table}" is not an array column ` +
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
        }),
      );
      return;
    default:
      // 'equality': a plain object literal that matched no known filter shape
      // is almost always a misspelled operator (`startWith` for `startsWith`);
      // the guard also runs on the cache-hit param-collect path.
      assertBindableEqualityValue(qi, rawColumn, value, getColumnPgType(qi, rawColumn), qi.table);
      params.push(value);
      andClauses.push(`${column} = ${qi.p(params.length)}`);
      return;
  }
}

/**
 * A {@link WhereHost} with no relations — used to fingerprint a sub-where
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
        `[turbine] Unknown field "${field}" in relation filter for table "${targetTable}". ` +
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
    unknownColumn: (field) =>
      new ValidationError(`[turbine] Unknown column "${field}" in where for table "${targetTable}"`),
  };
}

/**
 * Compile a scoped sub-where to SQL. Serves BOTH the relation-filter EXISTS
 * body ({@link buildSubWhereForRelation}) and the relation `with`-clause
 * `where` ({@link buildAliasWhere}) — the emitted SQL is byte-identical to the
 * former hand-mirrored walkers, since it renders the same clauses in the same
 * ({@link walkWhere}-canonical) key order.
 */
export function buildScopedWhere(
  qi: BuilderCtx,
  scope: WhereScope,
  where: Record<string, unknown>,
  params: unknown[],
): string | null {
  const clauses: string[] = [];
  for (const event of walkWhere(scope.host, where)) {
    switch (event.kind) {
      case 'or':
      case 'and': {
        const parts = event.conditions
          .map((cond) => buildScopedWhere(qi, scope, cond, params))
          .filter((s): s is string => s !== null)
          .map((s) => `(${s})`);
        if (parts.length > 0) clauses.push(`(${parts.join(event.kind === 'or' ? ' OR ' : ' AND ')})`);
        break;
      }
      case 'not': {
        const sub = buildScopedWhere(qi, scope, event.condition, params);
        if (sub) clauses.push(`NOT (${sub})`);
        break;
      }
      case 'relation': {
        const c = buildRelationFilter(qi, event.key, event.relDef, event.filterObj, params, scope.relationParent);
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
 * text-search scalar surface, so — unlike the top-level {@link buildScalarClause}
 * — those shapes are not special-cased here and keep their historical
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
  const col = meta.columnMap[field] ?? camelToSnake(field);
  if (!meta.allColumns.includes(col)) throw scope.unknownColumn(field);
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
        `[turbine] Column "${col}" on table "${scope.table}" is not a JSON column ` +
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
        `[turbine] Column "${col}" on table "${scope.table}" is not an array column ` +
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
      }),
    );
    return;
  }

  assertBindableEqualityValue(qi, col, value, pgTypeForColumn(qi, meta, col), scope.table);
  params.push(value);
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
): void {
  for (const event of walkWhere(scope.host, where)) {
    switch (event.kind) {
      case 'or':
      case 'and':
        for (const cond of event.conditions) collectScopedWhereParams(qi, scope, cond, params);
        break;
      case 'not':
        collectScopedWhereParams(qi, scope, event.condition, params);
        break;
      case 'relation':
        // Same some→none→every→is→isNot (each: sub-where params then target
        // global-filter params) as buildRelationFilter emits.
        collectRelationFilterParams(qi, event.relDef, event.filterObj, params);
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
  const col = meta.columnMap[field] ?? camelToSnake(field);

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
    collectOperatorParams(qi, col, value, params, { meta, table: scope.table, prefix: '' });
    return;
  }

  assertBindableEqualityValue(qi, col, value, pgTypeForColumn(qi, meta, col), scope.table);
  params.push(value);
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
export function fingerprintScopedWhere(qi: BuilderCtx, host: WhereHost, where: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const event of walkWhere(host, where)) {
    switch (event.kind) {
      case 'or':
        parts.push(`OR[${event.conditions.map((c) => fingerprintScopedWhere(qi, host, c)).join(',')}]`);
        break;
      case 'and':
        parts.push(`AND[${event.conditions.map((c) => fingerprintScopedWhere(qi, host, c)).join(',')}]`);
        break;
      case 'not':
        parts.push(`NOT(${fingerprintScopedWhere(qi, host, event.condition)})`);
        break;
      case 'relation':
        parts.push(`${event.key}:{${fingerprintRelationParts(qi, event.relDef, event.filterObj).join(',')}}`);
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
): string | null {
  const targetTable = relDef.to;
  const targetMeta = qi.schema.tables[targetTable];
  if (!targetMeta) return null;

  const qt = qi.q(targetTable);
  const qSelf = qi.q(parentTable ?? qi.table);
  const clauses: string[] = [];

  // Correlation: link child table to parent table (supports composite FKs)
  let correlation: string;
  if (relDef.type === 'hasMany' || relDef.type === 'hasOne') {
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
  // correlation and its params pushed AFTER the per-branch filter — mirrored
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
    const filterClause = buildSubWhereForRelation(qi, targetTable, subWhere, params);
    const filterAnd = filterClause ? ` AND ${filterClause}` : '';
    clauses.push(`EXISTS (SELECT 1 FROM ${qt} WHERE ${correlation}${filterAnd}${gfAnd()})`);
  }

  // "none": NOT EXISTS (SELECT 1 FROM target WHERE correlation AND filter AND gf)
  if (filterObj.none !== undefined && filterObj.none !== null) {
    const subWhere = filterObj.none as Record<string, unknown>;
    const filterClause = buildSubWhereForRelation(qi, targetTable, subWhere, params);
    const filterAnd = filterClause ? ` AND ${filterClause}` : '';
    clauses.push(`NOT EXISTS (SELECT 1 FROM ${qt} WHERE ${correlation}${filterAnd}${gfAnd()})`);
  }

  // "every": NOT EXISTS (SELECT 1 FROM target WHERE correlation AND gf AND NOT (filter))
  if (filterObj.every !== undefined && filterObj.every !== null) {
    const subWhere = filterObj.every as Record<string, unknown>;
    const filterClause = buildSubWhereForRelation(qi, targetTable, subWhere, params);
    if (filterClause) {
      // gf params pushed AFTER filter params (collect mirrors this order), but
      // placed textually inside the domain so it restricts which rows count.
      const gf = gfAnd();
      clauses.push(`NOT EXISTS (SELECT 1 FROM ${qt} WHERE ${correlation}${gf} AND NOT (${filterClause}))`);
    } else {
      // "every" with empty filter = true (all match trivially) — gf irrelevant.
    }
  }

  // "is": EXISTS — for to-one relations (same SQL as "some").
  // `is: null` = "no related row" (Prisma semantics) → NOT EXISTS.
  if (filterObj.is !== undefined) {
    if (filterObj.is === null) {
      clauses.push(`NOT EXISTS (SELECT 1 FROM ${qt} WHERE ${correlation}${gfAnd()})`);
    } else {
      const subWhere = filterObj.is as Record<string, unknown>;
      const filterClause = buildSubWhereForRelation(qi, targetTable, subWhere, params);
      const filterAnd = filterClause ? ` AND ${filterClause}` : '';
      clauses.push(`EXISTS (SELECT 1 FROM ${qt} WHERE ${correlation}${filterAnd}${gfAnd()})`);
    }
  }

  // "isNot": NOT EXISTS — for to-one relations (same SQL as "none").
  // `isNot: null` = "a related row exists" → EXISTS.
  if (filterObj.isNot !== undefined) {
    if (filterObj.isNot === null) {
      clauses.push(`EXISTS (SELECT 1 FROM ${qt} WHERE ${correlation}${gfAnd()})`);
    } else {
      const subWhere = filterObj.isNot as Record<string, unknown>;
      const filterClause = buildSubWhereForRelation(qi, targetTable, subWhere, params);
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
): string | null {
  const meta = qi.schema.tables[targetTable];
  if (!meta) return null;
  return buildScopedWhere(qi, relationWhereScope(qi, targetTable, meta), subWhere, params);
}

/**
 * Resolve a column's Postgres type from an arbitrary table's metadata
 * (relation targets, not just `qi.table`).
 */
export function pgTypeForColumn(_qi: BuilderCtx, meta: TableMetadata, column: string): string {
  return meta.dialectTypes?.[column] ?? meta.pgTypes?.[column] ?? 'text';
}

/**
 * The Postgres enum type name for a column, when the schema knows one.
 *
 * Introspection stores each column's `udt_name` in `pgTypes` and every
 * database enum in `schema.enums` (typname → labels); a column whose type
 * matches an enum key needs an explicit `::"EnumName"` cast on its write
 * binds — bulk-insert forms like `UNNEST($1::text[])` otherwise type the
 * value as text and Postgres refuses the implicit text→enum coercion
 * ("column X is of type Y but expression is of type text").
 *
 * Postgres-only by construction: gated on the active dialect being
 * `postgresql` AND on `schema.enums` having entries (only PG introspection
 * produces them — `defineSchema` and the other engines leave it empty), so
 * SQLite/MySQL/MSSQL/PowDB output is byte-identical.
 */
export function enumTypeForColumn(qi: BuilderCtx, column: string): string | null {
  if (qi.dialect.name !== 'postgresql') return null;
  const enums = qi.schema.enums;
  if (!enums) return null;
  // Cross-schema guard (N-5): introspection records pgTypeSchema ONLY when
  // the column's type lives OUTSIDE the introspected schema. A same-named
  // enum in another schema must not get this schema's cast — search_path
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
      ? `[turbine] Empty filter object on "${rawColumn}" for table "${table}". ` +
          `Provide a value or an operator like { gt: 1 }.`
      : `[turbine] Unknown operator${badKeys.length > 1 ? 's' : ''} ` +
          `${badKeys.map((k) => `"${k}"`).join(', ')} on "${rawColumn}" for table "${table}". ` +
          `Supported operators: ${[...OPERATOR_KEYS].join(', ')}.`,
  );
}

/**
 * Build the user-supplied `where` filter of a relation `with` clause against
 * the relation's table alias. Supports the same scalar surface as the
 * top-level WHERE builder — equality, IS NULL, operator objects (incl.
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
 * can emit — equality vs null vs operator sets vs combinators — or two
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
      `[turbine] mode: 'insensitive' cannot be combined with a column reference ({ col: "${ref.col}" }). ` +
        `Case-insensitive column-to-column comparison is not supported: use client.sql\`...\` ` +
        `for lower(a) = lower(b).`,
    );
  }
  const col = ctx.meta.columnMap[ref.col] ?? camelToSnake(ref.col);
  if (!ctx.meta.allColumns.includes(col)) {
    throw new ValidationError(
      `[turbine] Unknown field "${ref.col}" referenced by { col } in where on table "${ctx.table}". ` +
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
    throw new ValidationError(
      `[turbine] Column reference { col: "${ref.col}" } is not supported in this filter context.`,
    );
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

  if (op.equals !== undefined) {
    if (op.equals === null) {
      clauses.push(`${column} IS NULL`);
    } else if (isColumnRef(op.equals)) {
      clauses.push(`${column} = ${columnRefSql(qi, op.equals, refCtx, op.mode)}`);
    } else {
      assertBindableEqualsOperand(op.equals, column);
      params.push(op.equals);
      clauses.push(`${column} = ${qi.p(params.length)}`);
    }
  }
  if (op.gt !== undefined) {
    if (isColumnRef(op.gt)) {
      clauses.push(`${column} > ${columnRefSql(qi, op.gt, refCtx, op.mode)}`);
    } else {
      params.push(op.gt);
      clauses.push(`${column} > ${qi.p(params.length)}`);
    }
  }
  if (op.gte !== undefined) {
    if (isColumnRef(op.gte)) {
      clauses.push(`${column} >= ${columnRefSql(qi, op.gte, refCtx, op.mode)}`);
    } else {
      params.push(op.gte);
      clauses.push(`${column} >= ${qi.p(params.length)}`);
    }
  }
  if (op.lt !== undefined) {
    if (isColumnRef(op.lt)) {
      clauses.push(`${column} < ${columnRefSql(qi, op.lt, refCtx, op.mode)}`);
    } else {
      params.push(op.lt);
      clauses.push(`${column} < ${qi.p(params.length)}`);
    }
  }
  if (op.lte !== undefined) {
    if (isColumnRef(op.lte)) {
      clauses.push(`${column} <= ${columnRefSql(qi, op.lte, refCtx, op.mode)}`);
    } else {
      params.push(op.lte);
      clauses.push(`${column} <= ${qi.p(params.length)}`);
    }
  }
  if (op.not !== undefined) {
    if (op.not === null) {
      clauses.push(`${column} IS NOT NULL`);
    } else if (isColumnRef(op.not)) {
      clauses.push(`${column} != ${columnRefSql(qi, op.not, refCtx, op.mode)}`);
    } else {
      params.push(op.not);
      clauses.push(`${column} != ${qi.p(params.length)}`);
    }
  }
  if (op.in !== undefined) {
    params.push(qi.inParam(op.in));
    clauses.push(qi.inClause(column, qi.p(params.length), false));
  }
  if (op.notIn !== undefined) {
    params.push(qi.inParam(op.notIn));
    clauses.push(qi.inClause(column, qi.p(params.length), true));
  }
  const buildLikeClause = (paramRef: string) =>
    op.mode === 'insensitive' ? qi.dialect.buildInsensitiveLike(column, paramRef) : `${column} LIKE ${paramRef}`;

  if (op.contains !== undefined) {
    params.push(`%${escapeLike(op.contains)}%`);
    clauses.push(`${buildLikeClause(qi.p(params.length))} ESCAPE '\\'`);
  }
  if (op.startsWith !== undefined) {
    params.push(`${escapeLike(op.startsWith)}%`);
    clauses.push(`${buildLikeClause(qi.p(params.length))} ESCAPE '\\'`);
  }
  if (op.endsWith !== undefined) {
    params.push(`%${escapeLike(op.endsWith)}`);
    clauses.push(`${buildLikeClause(qi.p(params.length))} ESCAPE '\\'`);
  }

  return clauses;
}

/**
 * Resolve a {@link VectorMetric} to its pgvector distance operator from a
 * fixed allow-list, validating the target column is actually a `vector`
 * column. Throws {@link ValidationError} for an unknown metric or a
 * non-vector column — a user-supplied string can never become a SQL operator.
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
      `[turbine] Column "${field}" on table "${qi.table}" is not a vector column ` +
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
    throw new ValidationError(
      `[turbine] Vector distance on "${field}" requires a non-empty array of numbers for "to".`,
    );
  }
  for (const el of to) {
    if (typeof el !== 'number' || !Number.isFinite(el)) {
      throw new ValidationError(
        `[turbine] Vector "to" for column "${field}" must contain only finite numbers; ` + `got ${JSON.stringify(el)}.`,
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
 * Prisma-compat: a plain object on a to-one relation key —
 * `where: { vendor: { name: { contains: 'x' } } }` — is an implicit `is`
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
 * — build and collect sides alike, keeping the SQL-cache lockstep.
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
 * on which params are pushed — and both throw identically for invalid
 * shapes, so a warmed cache can never skip validation.
 */
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
        `[turbine] JSON range operator '${op}' on ${column} requires a \`path\` ` +
          `(e.g. { path: ['meta', 'score'], ${op}: ${JSON.stringify(value)} }).`,
      );
    }
    if (typeof value !== 'number' && typeof value !== 'string') {
      throw new ValidationError(
        `[turbine] JSON range operator '${op}' on ${column} requires a number or string, ` +
          `got ${JSON.stringify(value)}.`,
      );
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new ValidationError(`[turbine] JSON range operator '${op}' on ${column} requires a finite number.`);
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
    // Containment equality: column @> $N::jsonb
    params.push(JSON.stringify(filter.equals));
    clauses.push(qi.dialect.buildJsonContains(column, qi.p(params.length)));
  }

  if (filter.contains !== undefined) {
    // Containment: column @> $N::jsonb
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

  return clauses;
}

/**
 * Bind value for a JSON path parameter, encoded per dialect. PostgreSQL's
 * `#>>` takes a `text[]` (the segments as strings — or `nativeForm` when the
 * caller has a specific native binding, e.g. JsonFilter's raw path array).
 * Every other engine's JSON function (`json_extract` / `JSON_EXTRACT` /
 * `JSON_VALUE`) takes a `'$'`-rooted JSONPath STRING: binding the raw array
 * would arrive as `'["a"]'` (the driver shims JSON.stringify non-primitive
 * params) and fail at runtime with the engine's bad-JSON-path error. The
 * encoded path stays a bound parameter — never spliced into SQL text — so
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
 * comparison. PostgreSQL uses `(expr)::numeric` (exact — the right way to
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
    clauses.push(`${distanceExpr} ${sqlOp} ${qi.p(params.length)}`);
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
export function buildTextSearchClause(
  qi: BuilderCtx,
  column: string,
  filter: TextSearchFilter,
  params: unknown[],
): string {
  const config = filter.config ?? 'english';
  if (!validateTextSearchConfig(config)) {
    throw new ValidationError(
      `[turbine] Invalid text search config "${config}": only alphanumeric characters and underscores are allowed.`,
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

  // Fallback heuristic for unknown columns, routed through the active dialect
  // so non-Postgres packages can supply their own bulk-insert cast shape.
  if (column === 'id' || column.endsWith('_id')) return qi.dialect.arrayType?.('int8') ?? 'text[]';
  if (column.endsWith('_at')) return qi.dialect.arrayType?.('timestamptz') ?? 'text[]';
  return qi.dialect.arrayType?.('text') ?? 'text[]';
}
