/**
 * turbine-orm: relation + orderBy compilation (extracted from builder.ts)
 *
 * The json_agg nested-relation machinery (buildSelectWithRelations,
 * buildRelationSubquery, buildManyToManySubquery), the positional-encoding
 * shapes + nested-row parser, the full orderBy surface (plain / JSON-path /
 * vector KNN / relation _count / pick-row), relation _count expressions and
 * their global-filter params, and the with-clause fingerprint + param
 * collectors. All functions take a {@link BuilderCtx} first argument; WHERE
 * compilation is reused from where.ts (whereMod.*), the PII column set from
 * writes.ts (writesMod.*), and the remaining primitives stay class-resident,
 * reached through the ctx. See builder.ts for the thin delegating methods and
 * the findMany/findUnique execute assembly.
 */

import { CircularRelationError, RelationError, UnsupportedFeatureError, ValidationError } from '../errors.js';
import { missingIndexForRelation } from '../index-advisor.js';
import type { RelationDef, TableMetadata } from '../schema.js';
import { camelToSnake, normalizeKeyColumns, snakeToCamel } from '../schema.js';
import { resolveCountRelations } from './batched-loader.js';
import {
  isJsonPathOrderBy,
  isOrderBySpec,
  isRelationPickOrderBy,
  isVectorOrderBy,
  normalizeOrderBy,
  orderByEntries,
  sortedEntries,
} from './filters.js';
import type {
  JsonPathOrderBy,
  OrderByClause,
  OrderBySpec,
  OrderDirection,
  RelationPickOrderBy,
  WithClause,
  WithCount,
  WithOptions,
} from './types.js';
import { ownLookup } from './utils.js';
import type { BuilderCtx } from './where.js';
import * as whereMod from './where.js';
import * as writesMod from './writes.js';

/**
 * Decode descriptor for `jsonEncoding: 'positional'`. Built during SQL
 * generation (see {@link buildRelationShape}) and consumed by the
 * transform to map key-less positional arrays back to keyed objects.
 *
 * - `keys` — camelCase field names in emitted array position, INCLUDING nested
 *   relation slots (a nested relation occupies one more position after the
 *   scalar columns, in `sortedEntries(with)` order).
 * - `nested` — sub-shape for each key in `keys` that is itself a relation slot.
 * - `cardinality` — `'one'` (belongsTo/hasOne, a single positional array or
 *   null) vs `'many'` (an array of positional arrays).
 */
export interface RelationShape {
  keys: string[];
  nested: Record<string, RelationShape>;
  cardinality: 'many' | 'one';
}

/** Relations already warned about missing FK indexes (once per process, dev only). */
const unindexedRelationWarned = new Set<string>();

/**
 * Resolve select/omit options into a list of snake_case column names.
 * Returns null if neither is provided (meaning all columns).
 */
export function resolveColumns(
  qi: BuilderCtx,
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
      .map(([k]) => qi.toColumn(k));
  }
  // Default / omit-only projection: PII-tagged columns are excluded unless the
  // caller passed `includePii: true`. An empty set (untagged schema) keeps the
  // `null`/`*` fast path so the emitted SQL is byte-identical to before.
  const piiCols = includePii ? undefined : writesMod.piiColumns(qi, qi.tableMeta);
  const hasPii = piiCols !== undefined && piiCols.size > 0;
  if (omit) {
    if (Array.isArray(omit)) {
      throw new ValidationError(
        `[turbine] "omit" must be an object mapping field names to true ` + `(e.g. { createdAt: true }), not an array.`,
      );
    }
    // Include all columns except those where value is true (and PII columns).
    const omitCols = new Set(
      Object.entries(omit)
        .filter(([, v]) => v)
        .map(([k]) => qi.toColumn(k)),
    );
    return qi.tableMeta.allColumns.filter((col) => !omitCols.has(col) && !(hasPii && piiCols!.has(col)));
  }
  if (hasPii) {
    return qi.tableMeta.allColumns.filter((col) => !piiCols!.has(col));
  }
  return null;
}

/**
 * Produce a fingerprint for a `with` clause tree. Recursion mirrors
 * buildSelectWithRelations / buildRelationSubquery.
 *
 * @internal Exposed as package-private for testing.
 */
export function withFingerprint(qi: BuilderCtx, withClause: WithClause | undefined, table?: string, depth = 0): string {
  if (!withClause) return '';
  const meta = qi.schema.tables[table ?? qi.table];
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
        `w=${whereMod.fingerprintAliasWhere(qi, opts.where as Record<string, unknown>, meta.relations[relName]?.to)}`,
      );
    }

    // orderBy shape (OrderBySpec nulls placement changes the SQL, so fingerprint it)
    if (opts.orderBy) {
      const targetRels = qi.schema.tables[relDef.to]?.relations;
      const oEntries = orderByEntries(opts.orderBy).map(
        ([k, d]) => `${k}:${orderByEntryFingerprint(qi, d, targetRels?.[k]?.to)}`,
      );
      subParts.push(`o=${oEntries.join(',')}`);
    }

    // limit presence, but on inline-pagination engines (MySQL) the literal
    // value is baked into the subquery SQL, so fingerprint the value there or
    // `{limit:3}` and `{limit:5}` would share one cached statement.
    if (opts.limit !== undefined) {
      subParts.push(qi.dialect.inlineLimitOffset ? `l=${opts.limit}` : 'l=1');
    }

    // nested with (recurse)
    if (opts.with) {
      const nested = withFingerprint(qi, opts.with as WithClause, relDef.to, depth + 1);
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
export function collectWithParams(qi: BuilderCtx, withClause: WithClause, params: unknown[], table?: string): void {
  const meta = qi.schema.tables[table ?? qi.table];
  if (!meta) return;

  for (const [relName, relSpec] of sortedEntries(withClause)) {
    const relDef = meta.relations[relName];
    if (!relDef) continue;
    collectRelationSubqueryParams(qi, relDef, relSpec, params, table ?? qi.table);
  }

  // `_count` global-filter params — mirror buildSelectWithRelations, which
  // appends the count subqueries (and any target-filter params) AFTER every
  // relation subquery, in resolveCountRelations order.
  const countSpec = (withClause as { _count?: WithCount })._count;
  if (countSpec !== undefined) {
    for (const rel of resolveCountRelations(meta, countSpec)) {
      collectRelationCountParams(qi, rel, params);
    }
  }
}

/**
 * Collect params from a single relation subquery. Mirrors buildRelationSubquery.
 */
export function collectRelationSubqueryParams(
  qi: BuilderCtx,
  relDef: RelationDef,
  spec: true | WithOptions,
  params: unknown[],
  _parentRef: string,
  depth = 0,
): void {
  if (spec === true) return; // No params for default include
  const targetTable = relDef.to;
  const targetMeta = qi.schema.tables[targetTable];
  if (!targetMeta) return;

  // A dialect that owns the whole subquery (buildRelationSubquery override,
  // SQL Server FOR JSON) compiles orderBy through its OWN paging clause -
  // plain directions only, no order params: so the native order-param
  // mirrors below must stay off for it (its documented contract remains
  // where → limit → nested).
  const nativeOrderPath = !qi.dialect.buildRelationSubquery;

  // manyToMany param order mirrors buildManyToManySubquery:
  //   orderBy params → where params → limit param → nested-with params
  //   (always, both paths).
  if (relDef.type === 'manyToMany') {
    const m2mOrderEntries = spec.orderBy ? orderByEntries(spec.orderBy).filter(([, dir]) => dir !== undefined) : [];
    if (nativeOrderPath && m2mOrderEntries.length > 0) {
      collectRelationOrderParams(qi, targetTable, targetMeta, m2mOrderEntries, params);
    }
    if (spec.where) {
      whereMod.collectAliasWhereParams(qi, targetTable, targetMeta, spec.where as Record<string, unknown>, params);
    }
    whereMod.collectTargetGlobalFilterAlias(qi, targetTable, params);
    if (spec.limit !== undefined && !qi.dialect.inlineLimitOffset) {
      params.push(Number(spec.limit));
    }
    if (spec.with) {
      for (const [nestedRelName, nestedSpec] of sortedEntries(spec.with)) {
        const nestedRelDef = targetMeta.relations[nestedRelName];
        if (!nestedRelDef) continue;
        collectRelationSubqueryParams(qi, nestedRelDef, nestedSpec, params, 'alias', depth + 1);
      }
    }
    return;
  }

  // Mirrors buildRelationSubquery's willWrap: `orderBy: {}` is treated as absent.
  const relOrderEntries = spec.orderBy ? orderByEntries(spec.orderBy).filter(([, dir]) => dir !== undefined) : [];
  const hasOrder = relOrderEntries.length > 0;
  const willWrap = relDef.type === 'hasMany' && (spec.limit !== undefined || hasOrder);

  // Non-wrapped path: nested relations BEFORE where/limit
  if (!willWrap && spec.with) {
    for (const [nestedRelName, nestedSpec] of sortedEntries(spec.with)) {
      const nestedRelDef = targetMeta.relations[nestedRelName];
      if (!nestedRelDef) continue;
      collectRelationSubqueryParams(qi, nestedRelDef, nestedSpec, params, 'alias', depth + 1);
    }
  }

  // orderBy params (JSON paths / relation-order global filters): mirrors
  // buildRelationSubquery, which builds its ORDER BY terms BEFORE compiling
  // spec.where (both wrapped and non-wrapped paths).
  if (nativeOrderPath && hasOrder) {
    collectRelationOrderParams(qi, targetTable, targetMeta, relOrderEntries, params);
  }

  // where params — mirrors buildAliasWhere push order
  if (spec.where) {
    whereMod.collectAliasWhereParams(qi, targetTable, targetMeta, spec.where as Record<string, unknown>, params);
  }

  // Global filter on the target — mirrors targetGlobalFilterAlias in
  // buildRelationSubquery (pushed after spec.where, before limit).
  whereMod.collectTargetGlobalFilterAlias(qi, targetTable, params);

  // limit param — only hasMany parameterizes its limit (mirrors
  // buildRelationSubquery). belongsTo/hasOne ignore limit (always LIMIT 1), so
  // pushing one here would orphan a param and desync the collect path.
  // `limit: 0` pushes (LIMIT 0 is honored), so check !== undefined.
  if (relDef.type === 'hasMany' && spec.limit !== undefined && !qi.dialect.inlineLimitOffset) {
    params.push(Number(spec.limit));
  }

  // Wrapped path: nested relations AFTER where/limit (inside inner subquery)
  if (willWrap && spec.with) {
    for (const [nestedRelName, nestedSpec] of sortedEntries(spec.with)) {
      const nestedRelDef = targetMeta.relations[nestedRelName];
      if (!nestedRelDef) continue;
      collectRelationSubqueryParams(qi, nestedRelDef, nestedSpec, params, 'innerAlias', depth + 1);
    }
  }
}

/**
 * Value-shape fingerprint for a single orderBy entry, so two queries whose
 * ORDER BY differs only in nulls placement, vector metric, or relation-count
 * vs relation-column never collide on one cached SQL string. Captures the
 * SQL-shaping bits (direction, nulls, metric, relation keys) — never values.
 */
export function orderByEntryFingerprint(qi: BuilderCtx, d: unknown, targetTable?: string): string {
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
      .map(([k, v]) => `${k}:${orderByEntryFingerprint(qi, v)}`)
      .join(',');
    const pickWhere = d.pick?.where
      ? `;pw=${whereMod.fingerprintAliasWhere(qi, d.pick.where as Record<string, unknown>, targetTable)}`
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
      .map(([k, v]) => `${k}=${orderByEntryFingerprint(qi, v)}`)
      .join(',')})`;
  }
  return String(d);
}

export function buildOrderBy(
  qi: BuilderCtx,
  orderBy: OrderByClause,
  params?: unknown[],
  lateralSink?: string[],
): string {
  // Dev-only: validate that orderBy fields exist in the table schema. Relation
  // orderBy keys (object values that are neither a vector nor an OrderBySpec)
  // are validated in the relation branch below, so skip them here.
  if (process.env.NODE_ENV !== 'production') {
    for (const [key, value] of orderByEntries(orderBy)) {
      if (isRelationOrderByValue(qi, value) && ownLookup(qi.tableMeta.relations, key)) continue;
      const snakeKey = camelToSnake(key);
      if (!qi.tableMeta.columns.some((c) => c.name === snakeKey) && !Object.hasOwn(qi.tableMeta.columnMap, key)) {
        console.warn(
          `[turbine] Unknown orderBy field "${key}" for table "${qi.tableMeta.name}". ` +
            'This will cause a runtime error.',
        );
      }
    }
  }

  const meta = qi.schema.tables[qi.table];
  let relOrdCounter = 0;
  return orderByEntries(orderBy)
    .map(([key, value]) => {
      // Vector KNN ordering: { distance: { to, metric, direction? } }
      if (isVectorOrderBy(value)) {
        if (meta && !(key in meta.columnMap)) {
          throw new ValidationError(
            `[turbine] Unknown field "${key}" in orderBy on table "${qi.table}". ` +
              `Known fields: ${Object.keys(meta.columnMap).join(', ') || '(none)'}.`,
          );
        }
        if (!params) {
          throw new ValidationError(
            `[turbine] Vector distance ordering on "${key}" is only supported in a top-level findMany orderBy.`,
          );
        }
        const rawColumn = qi.toColumn(key);
        const operator = whereMod.vectorOperator(qi, key, rawColumn, value.distance.metric);
        const placeholder = whereMod.pushVectorParam(qi, key, rawColumn, value.distance.to, params);
        const safeDir = value.distance.direction?.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
        return `${qi.q(rawColumn)} ${operator} ${placeholder} ${safeDir}`;
      }

      // JSON-path ordering: { path: [...], direction?, type?, nulls? } on a
      // json/jsonb column of THIS table. Path is bound as one text[] param.
      if (isJsonPathOrderBy(value)) {
        return buildJsonPathOrderEntry(qi, qi.table, qi.tableMeta, key, value, '', params);
      }

      // Relation ordering: an object value that is not a vector or OrderBySpec,
      // keyed by a relation name (`{ posts: { _count: 'desc' } }` / `{ author:
      // { name: 'asc' } }`).
      if (isRelationOrderByValue(qi, value)) {
        return buildRelationOrderBy(
          qi,
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
          `[turbine] Unknown field "${key}" in orderBy on table "${qi.table}". ` +
            `Known fields: ${Object.keys(meta.columnMap).join(', ') || '(none)'}.`,
        );
      }
      const { dir, nulls } = normalizeOrderBy(value as OrderDirection | OrderBySpec);
      return `${qi.toSqlColumn(key)} ${dir}${nullsSuffix(qi, nulls)}`;
    })
    .join(', ');
}

/**
 * True when an orderBy value is a relation-ordering object: a plain object
 * that is neither a vector KNN ordering nor an {@link OrderBySpec}. Its key
 * in the orderBy clause is a relation name.
 */
export function isRelationOrderByValue(_qi: BuilderCtx, value: unknown): boolean {
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
export function nullsSuffix(qi: BuilderCtx, nulls: 'first' | 'last' | undefined): string {
  if (!nulls) return '';
  if (qi.dialect.name !== 'postgresql' && qi.dialect.name !== 'sqlite') {
    throw new UnsupportedFeatureError(
      'NULLS FIRST/LAST ordering',
      qi.dialect.name,
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
export function resolveOrderByColumn(_qi: BuilderCtx, table: string, meta: TableMetadata, key: string): string {
  const col = ownLookup(meta.columnMap, key) ?? camelToSnake(key);
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
export function validateJsonPathOrderBy(
  qi: BuilderCtx,
  table: string,
  meta: TableMetadata,
  field: string,
  spec: JsonPathOrderBy,
): string {
  const col = resolveOrderByColumn(qi, table, meta, field);
  if (
    spec.path.length === 0 ||
    spec.path.some((el) => typeof el !== 'string' && !(typeof el === 'number' && Number.isFinite(el)))
  ) {
    throw new ValidationError(
      `[turbine] JSON-path orderBy on "${field}" (table "${table}") requires a non-empty \`path\` array ` +
        `of keys/indexes (e.g. { path: ['weight'], direction: 'asc' }).`,
    );
  }
  const colType = whereMod.pgTypeForColumn(qi, meta, col);
  if (!whereMod.isJsonColumnType(qi, colType)) {
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
export function buildJsonPathOrderEntry(
  qi: BuilderCtx,
  table: string,
  meta: TableMetadata,
  field: string,
  spec: JsonPathOrderBy,
  prefix: string,
  params?: unknown[],
): string {
  const col = validateJsonPathOrderBy(qi, table, meta, field, spec);
  if (!params) {
    throw new ValidationError(`[turbine] JSON-path ordering on "${field}" is not supported in this orderBy context.`);
  }
  params.push(whereMod.jsonPathParam(qi, spec.path));
  const extract = qi.dialect.buildJsonPathExtract(`${prefix}${qi.q(col)}`, qi.p(params.length));
  const lhs = spec.type === 'numeric' ? whereMod.castJsonNumeric(qi, extract) : extract;
  const dir = spec.direction?.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  // Rows whose document lacks the path extract to NULL. Without a nulls
  // clause, Postgres DESC defaults to NULLS FIRST, which both diverges from
  // pick-row ordering (NULLS LAST both directions since 0.33) and from
  // engines whose path ordering is nulls-last in both directions. Default to
  // NULLS LAST in BOTH directions unless the caller set `nulls` explicitly;
  // the grammar gate matches nullsSuffix.
  const nullsSql = spec.nulls
    ? nullsSuffix(qi, spec.nulls)
    : qi.dialect.name === 'postgresql' || qi.dialect.name === 'sqlite'
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
 * the correlation parent is the relation's alias, not `qi.table`.
 */
export function buildRelationOrderBy(
  qi: BuilderCtx,
  relName: string,
  value: Record<string, unknown>,
  alias: string,
  params?: unknown[],
  ctx?: { meta: TableMetadata; table: string; parentRef: string },
  lateralSink?: string[],
): string {
  const ownerMeta = ctx?.meta ?? qi.tableMeta;
  const ownerTable = ctx?.table ?? qi.table;
  const parentRef = ctx?.parentRef ?? qi.table;
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
    validatePickOrderBy(qi, relName, relDef, value, ctx !== undefined);
    return buildRelationPickOrderBy(qi, relName, relDef, value, alias, parentRef, params, lateralSink);
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
    return `${buildRelationCountExpr(qi, relDef, parentRef, alias, params)} ${dir}`;
  }

  // To-one: each entry orders by a correlated scalar subquery on a target column.
  const targetMeta = qi.schema.tables[relDef.to];
  if (!targetMeta) throw new RelationError(`[turbine] Unknown relation target "${relDef.to}"`);
  const qTarget = qi.q(relDef.to);
  const qParent = qi.q(parentRef);
  // belongsTo: alias.referenceKey = parent.foreignKey; hasOne: reversed.
  const correlation =
    relDef.type === 'belongsTo'
      ? qi.dialect.buildCorrelation(alias, relDef.referenceKey, qParent, relDef.foreignKey)
      : qi.dialect.buildCorrelation(alias, relDef.foreignKey, qParent, relDef.referenceKey);

  const entries = Object.entries(value);
  if (entries.length === 0) {
    throw new ValidationError(`[turbine] orderBy on to-one relation "${relName}" needs at least one target column.`);
  }
  return entries
    .map(([col, dirValue]) => {
      // columnMap-first resolution (camelToSnake fallback): mirrors the
      // scalar orderBy path so camelCase-named DB columns resolve here too.
      const snakeCol = ownLookup(targetMeta.columnMap, col) ?? camelToSnake(col);
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
        const gf = whereMod.targetGlobalFilterAlias(qi, relDef.to, alias, params);
        if (gf) where += ` AND ${gf}`;
      }
      return `(SELECT ${alias}.${qi.q(snakeCol)} FROM ${qTarget} ${alias} WHERE ${where}${qi.limitOneClause()}) ${dir}${nullsSuffix(qi, nulls)}`;
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
export function pickOrderNestedError(_qi: BuilderCtx, relName: string): ValidationError {
  return new ValidationError(
    `[turbine] Pick-row ordering on relation "${relName}" is only supported in a top-level ` +
      'findMany orderBy: nested `with` orderBy does not support it.',
  );
}

export function validatePickOrderBy(
  qi: BuilderCtx,
  relName: string,
  relDef: RelationDef,
  spec: RelationPickOrderBy,
  nested: boolean,
): void {
  if (nested) {
    throw pickOrderNestedError(qi, relName);
  }
  if (relDef.type === 'manyToMany') {
    throw new ValidationError(
      `[turbine] Pick-row ordering is not supported on manyToMany relation "${relName}": hasMany relations only.`,
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
    if (!qi.dialect.supportsLateralJoin) {
      throw new UnsupportedFeatureError(
        "pick-row ordering with plan: 'lateral'",
        qi.dialect.name,
        "LATERAL joins are only available on PostgreSQL. Omit `plan` (or use 'subquery').",
      );
    }
    // The lateral exposes one reserved output column, `__turbine_pick`. A
    // parent column with that exact name would make the unqualified WHERE
    // reference ambiguous once the join is in scope; refuse it explicitly.
    if (qi.tableMeta.allColumns.includes('__turbine_pick')) {
      throw new ValidationError(
        `[turbine] Pick-row ordering with plan: 'lateral' cannot be used: table "${qi.tableMeta.name}" ` +
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
export function buildRelationPickOrderBy(
  qi: BuilderCtx,
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
  const targetMeta = qi.schema.tables[relDef.to];
  if (!targetMeta) throw new RelationError(`[turbine] Unknown relation target "${relDef.to}"`);

  const dir = spec.direction?.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const limitOne = qi.buildPagination('1', undefined, true);
  // Parents with ZERO surviving related rows have no row to pick: the
  // correlated subquery yields NULL, and the LEFT JOIN LATERAL null-extends
  // its single row identically. Without a nulls clause, Postgres DESC
  // defaults to NULLS FIRST (every childless parent tops a "highest first"
  // sort). Default to NULLS LAST in BOTH directions (deterministic across
  // engines: SQLite's NULL-is-smallest default diverges from Postgres) unless
  // the caller set `nulls` explicitly; the grammar gate matches nullsSuffix.
  const nullsSql = spec.nulls
    ? nullsSuffix(qi, spec.nulls)
    : qi.dialect.name === 'postgresql' || qi.dialect.name === 'sqlite'
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
    const { byExpr, where, orderClause } = compilePickPieces(
      qi,
      relDef,
      targetMeta,
      spec,
      childAlias,
      parentRef,
      params,
    );
    lateralSink.push(
      ` LEFT JOIN LATERAL (SELECT ${byExpr} AS ${qi.q('__turbine_pick')} FROM ${qi.q(relDef.to)} ${childAlias}` +
        ` WHERE ${where}${orderClause}${limitOne}) ${alias} ON true`,
    );
    return `${alias}.${qi.q('__turbine_pick')} ${dir}${nullsSql}`;
  }

  // Subquery plan (default): a correlated scalar subquery in ORDER BY.
  const { byExpr, where, orderClause } = compilePickPieces(qi, relDef, targetMeta, spec, alias, parentRef, params);
  return `(SELECT ${byExpr} FROM ${qi.q(relDef.to)} ${alias} WHERE ${where}${orderClause}${limitOne}) ${dir}${nullsSql}`;
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
export function compilePickPieces(
  qi: BuilderCtx,
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
    const col = resolveOrderByColumn(qi, relDef.to, targetMeta, spec.by);
    byExpr = `${childAlias}.${qi.q(col)}`;
  } else {
    const col = validateJsonPathOrderBy(qi, relDef.to, targetMeta, spec.by.field, {
      path: spec.by.path,
    } as JsonPathOrderBy);
    params.push(whereMod.jsonPathParam(qi, spec.by.path));
    const extract = qi.dialect.buildJsonPathExtract(`${childAlias}.${qi.q(col)}`, qi.p(params.length));
    byExpr = spec.by.type === 'numeric' ? whereMod.castJsonNumeric(qi, extract) : extract;
  }

  // Correlation to the parent row, then the target's global filter (a
  // soft-deleted / other-tenant row must never be picked: matches the
  // `with` subquery and to-one relation-orderBy semantics), then pick.where.
  let where = qi.dialect.buildCorrelation(childAlias, relDef.foreignKey, qi.q(parentRef), relDef.referenceKey);
  const gf = whereMod.targetGlobalFilterAlias(qi, relDef.to, childAlias, params);
  if (gf) where += ` AND ${gf}`;
  if (spec.pick.where) {
    const pickWhere = whereMod.buildAliasWhere(qi, relDef.to, targetMeta, childAlias, spec.pick.where, params);
    if (pickWhere) where += ` AND ${pickWhere}`;
  }

  // pick.orderBy: same surface as a relation `with` orderBy on the target
  // (plain columns, OrderBySpec nulls, JSON-path specs); a nested pick in
  // here routes back through buildRelationOrderBy with ctx set and throws
  // the top-level-only E003.
  const orderClause = buildRelationOrderClause(
    qi,
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
export function collectRelationPickOrderParams(
  qi: BuilderCtx,
  relName: string,
  relDef: RelationDef,
  spec: RelationPickOrderBy,
  params: unknown[],
): void {
  validatePickOrderBy(qi, relName, relDef, spec, false);
  const targetMeta = qi.schema.tables[relDef.to];
  if (!targetMeta) throw new RelationError(`[turbine] Unknown relation target "${relDef.to}"`);
  if (typeof spec.by === 'string') {
    resolveOrderByColumn(qi, relDef.to, targetMeta, spec.by);
  } else {
    validateJsonPathOrderBy(qi, relDef.to, targetMeta, spec.by.field, { path: spec.by.path } as JsonPathOrderBy);
    params.push(whereMod.jsonPathParam(qi, spec.by.path));
  }
  whereMod.collectTargetGlobalFilterAlias(qi, relDef.to, params);
  if (spec.pick.where) {
    whereMod.collectAliasWhereParams(qi, relDef.to, targetMeta, spec.pick.where, params);
  }
  collectRelationOrderParams(qi, relDef.to, targetMeta, Object.entries(spec.pick.orderBy), params);
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
export function buildRelationOrderClause(
  qi: BuilderCtx,
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
        return buildJsonPathOrderEntry(qi, targetTable, targetMeta, key, dirValue, `${alias}.`, params);
      }
      if (isRelationOrderByValue(qi, dirValue)) {
        return buildRelationOrderBy(
          qi,
          key,
          dirValue as Record<string, unknown>,
          `${alias}ord${relOrdCounter++}`,
          params,
          { meta: targetMeta, table: targetTable, parentRef: alias },
        );
      }
      const col = resolveOrderByColumn(qi, targetTable, targetMeta, key);
      const { dir, nulls } = normalizeOrderBy(dirValue as OrderDirection | OrderBySpec);
      return `${alias}.${qi.q(col)} ${dir}${nullsSuffix(qi, nulls)}`;
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
export function collectRelationOrderParams(
  qi: BuilderCtx,
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
      validateJsonPathOrderBy(qi, targetTable, targetMeta, key, dirValue);
      params.push(whereMod.jsonPathParam(qi, dirValue.path));
      continue;
    }
    if (isRelationOrderByValue(qi, dirValue)) {
      // Pick-row ordering is top-level-only: the build path throws the same
      // E003 (buildRelationOrderBy with ctx set), so the mirror must too.
      if (isRelationPickOrderBy(dirValue)) {
        throw pickOrderNestedError(qi, key);
      }
      const relDef = targetMeta.relations[key];
      if (relDef && (relDef.type === 'hasMany' || relDef.type === 'manyToMany')) {
        collectRelationCountParams(qi, relDef, params);
      } else if (relDef) {
        for (const _col of Object.keys(dirValue as Record<string, unknown>)) {
          whereMod.collectTargetGlobalFilterAlias(qi, relDef.to, params);
        }
      }
      continue;
    }
    resolveOrderByColumn(qi, targetTable, targetMeta, key);
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
export function buildRelationCountExpr(
  qi: BuilderCtx,
  relDef: RelationDef,
  parentRef: string,
  alias: string,
  params?: unknown[],
): string {
  const qParent = qi.q(parentRef);
  const count = qi.castAgg('COUNT(*)', 'int');
  if (relDef.type === 'manyToMany') {
    if (!relDef.through) {
      throw new ValidationError(`[turbine] manyToMany relation "${relDef.name}" is missing its \`through\` junction.`);
    }
    const qJ = qi.q(relDef.through.table);
    const jalias = `${alias}j`;
    const sourceKeys = normalizeKeyColumns(relDef.through.sourceKey);
    const refKeys = normalizeKeyColumns(relDef.referenceKey);
    let where = sourceKeys.map((jc, i) => `${jalias}.${qi.q(jc)} = ${qParent}.${qi.q(refKeys[i]!)}`).join(' AND ');
    if (params) {
      const targetExists = manyToManyTargetGlobalFilterExists(qi, relDef, alias, jalias, params);
      if (targetExists) where += ` AND ${targetExists}`;
    }
    return `(SELECT ${count} FROM ${qJ} ${jalias} WHERE ${where})`;
  }
  // hasMany: child FK correlates to the parent reference key.
  const qTarget = qi.q(relDef.to);
  let where = qi.dialect.buildCorrelation(alias, relDef.foreignKey, qParent, relDef.referenceKey);
  if (params) {
    const gf = whereMod.targetGlobalFilterAlias(qi, relDef.to, alias, params);
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
export function manyToManyTargetGlobalFilterExists(
  qi: BuilderCtx,
  relDef: RelationDef,
  alias: string,
  jalias: string,
  params: unknown[],
): string {
  const gf = whereMod.resolveGlobalFilter(qi, relDef.to);
  if (!gf || !relDef.through) return '';
  const tMeta = qi.schema.tables[relDef.to];
  if (!tMeta || tMeta.primaryKey.length === 0) return '';
  const talias = `${alias}t`;
  const targetKeys = normalizeKeyColumns(relDef.through.targetKey);
  const pk = tMeta.primaryKey;
  if (targetKeys.length !== pk.length) return '';
  const join = targetKeys.map((jc, i) => `${talias}.${qi.q(pk[i]!)} = ${jalias}.${qi.q(jc)}`).join(' AND ');
  const gfClause = whereMod.buildAliasWhere(qi, relDef.to, tMeta, talias, gf, params);
  const gfAnd = gfClause ? ` AND ${gfClause}` : '';
  return `EXISTS (SELECT 1 FROM ${qi.q(relDef.to)} ${talias} WHERE ${join}${gfAnd})`;
}

/** Param-collect mirror of {@link manyToManyTargetGlobalFilterExists}. */
export function collectManyToManyTargetGlobalFilter(qi: BuilderCtx, relDef: RelationDef, params: unknown[]): void {
  const gf = whereMod.resolveGlobalFilter(qi, relDef.to);
  if (!gf || !relDef.through) return;
  const tMeta = qi.schema.tables[relDef.to];
  if (!tMeta || tMeta.primaryKey.length === 0) return;
  const targetKeys = normalizeKeyColumns(relDef.through.targetKey);
  if (targetKeys.length !== tMeta.primaryKey.length) return;
  whereMod.collectAliasWhereParams(qi, relDef.to, tMeta, gf, params);
}

/**
 * Param-collect mirror of {@link buildRelationCountExpr}'s global-filter
 * params (hasMany direct filter, or manyToMany EXISTS-on-target). Only pushes
 * when a filter applies — no-op otherwise.
 */
export function collectRelationCountParams(qi: BuilderCtx, relDef: RelationDef, params: unknown[]): void {
  if (relDef.type === 'manyToMany') {
    collectManyToManyTargetGlobalFilter(qi, relDef, params);
  } else {
    whereMod.collectTargetGlobalFilterAlias(qi, relDef.to, params);
  }
}

export function getCamelDateFields(qi: BuilderCtx, table: string, meta: TableMetadata): Set<string> {
  let camel = qi.camelDateFieldCache.get(table);
  if (!camel) {
    camel = new Set<string>();
    for (const col of meta.dateColumns) {
      camel.add(meta.reverseColumnMap[col] ?? col);
    }
    qi.camelDateFieldCache.set(table, camel);
  }
  return camel;
}

/** Parse a row that may contain JSON nested relation columns */
export function parseNestedRow(qi: BuilderCtx, row: Record<string, unknown>, table: string): Record<string, unknown> {
  const parsed = qi.parseRow(row, table);
  const meta = qi.schema.tables[table];
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
              ? parseNestedRow(qi, item as Record<string, unknown>, relDef.to)
              : item,
          );
        } else if (typeof jsonVal === 'object' && jsonVal !== null) {
          parsed[relName] = parseNestedRow(qi, jsonVal as Record<string, unknown>, relDef.to);
        } else {
          parsed[relName] = jsonVal;
        }
      } catch {
        console.warn(
          `[turbine] Warning: Failed to parse JSON for relation "${relName}" on table "${qi.table}". Using raw value.`,
        );
        parsed[relName] = rawValue;
      }
    } else if (Array.isArray(rawValue)) {
      parsed[relName] = rawValue.map((item) =>
        typeof item === 'object' && item !== null
          ? parseNestedRow(qi, item as Record<string, unknown>, relDef.to)
          : item,
      );
    } else if (typeof rawValue === 'object' && rawValue !== null) {
      parsed[relName] = parseNestedRow(qi, rawValue as Record<string, unknown>, relDef.to);
    } else {
      parsed[relName] = rawValue;
    }
  }

  return parsed;
}

/**
 * Resolve the emitted column list for a relation, honoring `select` / `omit`.
 * Shared by {@link buildRelationSubquery} (json order) and
 * {@link buildRelationShape} (decode key order) so they can never diverge.
 */
export function resolveTargetColumns(
  qi: BuilderCtx,
  spec: true | WithOptions,
  targetMeta: TableMetadata,
  includePii?: boolean,
): string[] {
  if (spec !== true && spec.select) {
    // Explicit `select` names the columns: a PII column named here IS the
    // opt-in and comes back regardless of the query's `includePii`.
    const selectedFields = Object.entries(spec.select)
      .filter(([, v]) => v)
      .map(([k]) => ownLookup(targetMeta.columnMap, k) ?? camelToSnake(k));
    return selectedFields.filter((col) => targetMeta.allColumns.includes(col));
  }
  // Default / omit-only relation projection: PII columns are excluded unless
  // the query opted in via `includePii`.
  const piiCols = includePii ? undefined : writesMod.piiColumns(qi, targetMeta);
  const hasPii = piiCols !== undefined && piiCols.size > 0;
  if (spec !== true && spec.omit) {
    const omittedFields = new Set(
      Object.entries(spec.omit)
        .filter(([, v]) => v)
        .map(([k]) => ownLookup(targetMeta.columnMap, k) ?? camelToSnake(k)),
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
export function buildJsonRow(qi: BuilderCtx, jsonPairs: [key: string, expr: string][]): string {
  if (qi.jsonEncoding === 'positional') {
    // buildJsonArray is defined on postgresDialect; positional is gated to PG
    // in buildSelectWithRelations, so the `?? buildJsonObject` never fires.
    return qi.dialect.buildJsonArray?.(jsonPairs.map(([, expr]) => expr)) ?? qi.dialect.buildJsonObject(jsonPairs);
  }
  return qi.dialect.buildJsonObject(jsonPairs);
}

/**
 * Build the top-level relation shapes for a `with` clause, mirroring
 * {@link buildSelectWithRelations}: same relation iteration order, same
 * per-relation column resolution, same nested recursion.
 */
export function buildRelationShapes(
  qi: BuilderCtx,
  table: string,
  withClause: WithClause,
  includePii?: boolean,
): Record<string, RelationShape> {
  const meta = qi.schema.tables[table];
  if (!meta) return {};
  const shapes: Record<string, RelationShape> = {};
  for (const [relName, relSpec] of sortedEntries(withClause)) {
    const relDef = meta.relations[relName];
    if (!relDef) continue; // buildSelectWithRelations already threw for this
    shapes[relName] = buildRelationShape(qi, relDef, relSpec, meta, includePii);
  }
  return shapes;
}

/**
 * Recursively describe one relation's positional layout: the camelCase key
 * order (scalar columns first, then nested relation slots in the same order
 * {@link buildRelationSubquery} appends them), the nested sub-shapes, and the
 * cardinality (single object for belongsTo/hasOne, array for the rest).
 */
export function buildRelationShape(
  qi: BuilderCtx,
  relDef: RelationDef,
  spec: true | WithOptions,
  parentMeta: TableMetadata,
  includePii?: boolean,
): RelationShape {
  void parentMeta;
  const targetMeta = qi.schema.tables[relDef.to];
  if (!targetMeta) return { keys: [], nested: {}, cardinality: 'many' };
  const targetColumns = resolveTargetColumns(qi, spec, targetMeta, includePii);
  const keys = targetColumns.map((col) => targetMeta.reverseColumnMap[col] ?? snakeToCamel(col));
  const nested: Record<string, RelationShape> = {};
  if (spec !== true && spec.with) {
    for (const [nestedRelName, nestedSpec] of sortedEntries(spec.with)) {
      const nestedRelDef = targetMeta.relations[nestedRelName];
      if (!nestedRelDef) continue;
      keys.push(nestedRelName);
      nested[nestedRelName] = buildRelationShape(qi, nestedRelDef, nestedSpec, targetMeta, includePii);
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
export function makeNestedParser(
  qi: BuilderCtx,
  withClause: WithClause,
  includePii?: boolean,
): (row: Record<string, unknown>) => Record<string, unknown> {
  if (qi.jsonEncoding !== 'positional') {
    return (row) => parseNestedRow(qi, row, qi.table);
  }
  const shapes = buildRelationShapes(qi, qi.table, withClause, includePii);
  return (row) => parseNestedRow(qi, decodePositionalRelations(qi, row, shapes), qi.table);
}

/**
 * Return a shallow copy of a top-level row with each relation column decoded
 * from its positional array(s) into the object representation. Only relation
 * columns are positional — base scalar columns stay object-keyed — so the
 * result is exactly what the object encoding would have handed parseNestedRow.
 */
export function decodePositionalRelations(
  qi: BuilderCtx,
  row: Record<string, unknown>,
  shapes: Record<string, RelationShape>,
): Record<string, unknown> {
  const cloned: Record<string, unknown> = { ...row };
  for (const [relName, shape] of Object.entries(shapes)) {
    if (relName in cloned) cloned[relName] = decodePositionalValue(qi, cloned[relName], shape);
  }
  return cloned;
}

/**
 * Decode one relation's positional JSON value. `json_agg` returns the value as
 * a JSON string at the top level (JSON.parse once); nested relation slots are
 * already-parsed arrays. A `'many'` value is an array of positional arrays; a
 * `'one'` value is a single positional array or null.
 */
export function decodePositionalValue(qi: BuilderCtx, raw: unknown, shape: RelationShape): unknown {
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
    return val.map((inner) => decodePositionalObject(qi, inner, shape));
  }
  return decodePositionalObject(qi, val, shape);
}

/** Map one positional array back to a keyed object using the shape's key order. */
export function decodePositionalObject(qi: BuilderCtx, arr: unknown, shape: RelationShape): unknown {
  if (!Array.isArray(arr)) return arr;
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < shape.keys.length; i++) {
    const key = shape.keys[i]!;
    const nestedShape = shape.nested[key];
    obj[key] = nestedShape ? decodePositionalValue(qi, arr[i], nestedShape) : arr[i];
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
export function buildSelectWithRelations(
  qi: BuilderCtx,
  table: string,
  withClause: WithClause,
  params: unknown[],
  columnsList?: string[] | null,
  depth?: number,
  path?: string[],
  includePii?: boolean,
): string {
  const meta = qi.schema.tables[table];
  if (!meta) throw new ValidationError(`[turbine] Unknown table "${table}"`);

  // Positional JSON encoding is Postgres-only in v1. Gate here — the single
  // entry point for every `with` clause — so no engine ever emits the
  // json_build_array shape its dialect can't produce (and mssql's FOR JSON
  // override path is never reached with positional active).
  if (qi.jsonEncoding === 'positional' && qi.dialect.name !== 'postgresql') {
    throw new UnsupportedFeatureError(
      "jsonEncoding: 'positional'",
      qi.dialect.name,
      'Positional relation encoding is only available on PostgreSQL in this version.',
    );
  }

  const cols = columnsList ?? meta.allColumns;
  const qtbl = qi.q(table);
  const baseCols = cols.map((col) => `${qtbl}.${qi.q(col)}`).join(', ');

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
    const subquery = buildRelationSubquery(qi, relDef, relSpec, params, table, aliasCounter, depth, path, includePii);
    relationSelects.push(`(${subquery}) AS ${qi.q(relName)}`);
  }

  // Reserved `_count` key → one correlated COUNT(*) scalar subquery per
  // selected to-many relation, aliased `_count__<rel>`. Appended after the
  // relation subqueries; the only params they can push come from a global
  // filter on the counted target (mirrored at the tail of collectWithParams).
  // Read via a cast so WithClause keeps its narrow `true | WithOptions` type.
  const countSpec = (withClause as { _count?: WithCount })._count;
  if (countSpec !== undefined) {
    for (const rel of resolveCountRelations(meta, countSpec)) {
      const expr = buildRelationCountExpr(qi, rel, table, `t${aliasCounter.n++}`, params);
      relationSelects.push(`${expr} AS ${qi.q(`_count__${rel.name}`)}`);
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
 *    `qi.q()` and all values are parameterized.
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
export function buildRelationSubquery(
  qi: BuilderCtx,
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
  const currentPath = path ?? [qi.table];

  const targetTable = relDef.to;

  // Hard depth cap — the `with` clause is a finite JSON structure so users can't
  // create true infinite recursion, but extremely deep nesting (10+ levels) produces
  // unmanageably large SQL. Back-references (e.g. posts → user → posts) are allowed
  // since they are legitimate queries (Prisma supports the same pattern).
  if (currentDepth >= 10) {
    throw new CircularRelationError([...currentPath, targetTable]);
  }
  const targetMeta = qi.schema.tables[targetTable];
  if (!targetMeta) throw new RelationError(`[turbine] Unknown relation target "${targetTable}"`);

  // Dev-only: correlated relation loading probes the child table once per parent
  // row, so a missing FK index multiplies into per-parent full-table scans (a
  // batched-loader ORM pays the same missing index only once, which is why
  // schemas migrated from one often lack these). Name the exact index to create
  // instead of letting the slowness look like an ORM problem.
  if (process.env.NODE_ENV !== 'production') {
    const warnKey = `${relDef.from}.${relDef.name}`;
    if (!unindexedRelationWarned.has(warnKey)) {
      const miss = missingIndexForRelation(qi.schema, relDef);
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
  const targetColumns = resolveTargetColumns(qi, spec, targetMeta, includePii);

  // Engine override seam (additive): a dialect whose JSON-aggregation shape does
  // not map onto buildJsonObject/buildJsonArrayAgg (SQL Server FOR JSON PATH) owns
  // the WHOLE subquery. Absent for PG/MySQL/SQLite → the native path below runs
  // unchanged (byte-identical output, all their tests stay green). The override
  // pushes params per the documented RelationSubqueryContext ordering contract,
  // which mirrors collectRelationSubqueryParams so the SQL cache / pipeline stay
  // in sync.
  if (qi.dialect.buildRelationSubquery) {
    return qi.dialect.buildRelationSubquery({
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
      quote: (name) => qi.q(name),
      buildWhere: (whereAlias) =>
        (spec !== true && spec.where
          ? whereMod.buildAliasWhere(
              qi,
              targetTable,
              targetMeta,
              whereAlias,
              spec.where as Record<string, unknown>,
              params,
            )
          : '') ?? '',
      recurse: (nRelDef, nSpec, nParent, nDepth, nPath) =>
        buildRelationSubquery(qi, nRelDef, nSpec, params, nParent, aliasCounter, nDepth, nPath, includePii),
    });
  }

  // Build JSON object pairs for resolved columns
  const jsonPairs: [key: string, expr: string][] = targetColumns.map((col) => [
    targetMeta.reverseColumnMap[col] ?? snakeToCamel(col),
    `${alias}.${qi.q(col)}`,
  ]);

  // Determine if this hasMany will take the wrapped subquery path (LIMIT or ORDER BY).
  // When wrapping, nested relations are built in the wrapped path referencing innerAlias,
  // so we must NOT build them here (they would push orphaned params).
  // An orderBy with no defined entries (`orderBy: {}`) is treated as absent —
  // it must neither trigger the wrap (dropping nested relations) nor render a
  // dangling `ORDER BY `. `limit: 0` is meaningful (LIMIT 0) and DOES wrap.
  const relOrderEntries =
    spec !== true && spec.orderBy ? orderByEntries(spec.orderBy).filter(([, dir]) => dir !== undefined) : [];
  const willWrap =
    relDef.type === 'hasMany' && spec !== true && (spec.limit !== undefined || relOrderEntries.length > 0);

  // manyToMany takes a dedicated JOIN-through-junction path. Nested relations,
  // where, orderBy, and select/omit are handled there (the target alias is the
  // row source, exactly like hasMany), so short-circuit before the hasMany logic.
  if (relDef.type === 'manyToMany') {
    return buildManyToManySubquery(
      qi,
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
      const nestedSubquery = buildRelationSubquery(
        qi,
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
      const fallback = nestedRelDef.type === 'hasMany' ? qi.dialect.emptyJsonArrayLiteral : qi.dialect.nullJsonLiteral;
      jsonPairs.push([nestedRelName, qi.dialect.wrapJsonSubresult(nestedSubquery, fallback)]);
    }
  }

  const jsonObj = buildJsonRow(qi, jsonPairs);

  // Quote parent ref — can be a table name or auto-generated alias
  const qParent = qi.q(parentRef);
  const qTarget = qi.q(targetTable);

  // Build ORDER BY for json_agg: unified with the top-level orderBy surface
  // (columnMap resolution, OrderBySpec nulls, JSON-path, relation ordering).
  // Param pushes here land BEFORE the spec.where params, mirrored by
  // collectRelationSubqueryParams.
  let orderClause = '';
  if (relOrderEntries.length > 0) {
    orderClause = buildRelationOrderClause(qi, targetTable, targetMeta, alias, relOrderEntries, params);
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
    whereClause = qi.dialect.buildCorrelation(alias, relDef.referenceKey, qParent, relDef.foreignKey);
  } else {
    whereClause = qi.dialect.buildCorrelation(alias, relDef.foreignKey, qParent, relDef.referenceKey);
  }

  // Additional filters — full scalar where surface (equality, null, operator
  // objects, OR/AND/NOT), properly parameterized against this alias.
  if (spec !== true && spec.where) {
    const extra = whereMod.buildAliasWhere(
      qi,
      targetTable,
      targetMeta,
      alias,
      spec.where as Record<string, unknown>,
      params,
    );
    if (extra) whereClause += ` AND ${extra}`;
  }

  // Global filter on the target table (soft-delete / tenancy) — AND-merged so
  // a `with` never surfaces filtered-out child rows. Pushed AFTER spec.where,
  // mirrored by collectRelationSubqueryParams.
  const gfExtra = whereMod.targetGlobalFilterAlias(qi, targetTable, alias, params);
  if (gfExtra) whereClause += ` AND ${gfExtra}`;

  // LIMIT — only meaningful for hasMany. A belongsTo / hasOne subquery returns
  // a single row (literal `LIMIT 1` below), so a `spec.limit` here must NOT push
  // a parameter: doing so orphans an untyped `$N` that the SQL never references,
  // which Postgres rejects with "could not determine data type of parameter $N"
  // (and shifts every later placeholder by one). To-one relations ignore limit.
  // `limit: 0` is honored (LIMIT 0 → empty array), so check !== undefined.
  let limitClause = '';
  if (relDef.type === 'hasMany' && spec !== true && spec.limit !== undefined) {
    limitClause = ` LIMIT ${qi.paginationRef(spec.limit, params)}`;
  }

  if (relDef.type === 'hasMany') {
    // When LIMIT or ORDER BY is used, wrap in a subquery so LIMIT applies to rows
    // BEFORE json_agg aggregation (otherwise LIMIT on aggregated result is meaningless)
    if (limitClause || orderClause) {
      const innerAlias = `${alias}i`;
      // Rewrite: SELECT json_agg(json_build_object(...)) FROM (SELECT * FROM table WHERE ... ORDER BY ... LIMIT N) AS alias
      // Inner SELECT always needs all columns for WHERE/ORDER to work; json_build_object filters later
      const innerSql = `SELECT ${targetMeta.allColumns.map((c) => `${alias}.${qi.q(c)}`).join(', ')} FROM ${qTarget} ${alias} WHERE ${whereClause}${orderClause}${limitClause}`;
      // For the json_build_object, reference the inner alias — only include resolved columns
      const innerJsonPairs: [key: string, expr: string][] = targetColumns.map((col) => [
        targetMeta.reverseColumnMap[col] ?? snakeToCamel(col),
        `${innerAlias}.${qi.q(col)}`,
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
          const nestedSub = buildRelationSubquery(
            qi,
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
            nestedRelDef.type === 'hasMany' ? qi.dialect.emptyJsonArrayLiteral : qi.dialect.nullJsonLiteral;
          innerJsonPairs.push([nestedRelName, qi.dialect.wrapJsonSubresult(nestedSub, fallback)]);
        }
      }
      const innerJsonObj = buildJsonRow(qi, innerJsonPairs);
      return `SELECT ${qi.dialect.buildJsonArrayAgg(innerJsonObj)} FROM (${innerSql}) ${innerAlias}`;
    }
    // Inline ORDER BY only when the dialect's array-agg supports it (PG). For
    // hasMany this path is reached only when there is no orderClause, so the
    // argument is `undefined` either way — keeping PG output byte-identical.
    const inlineOrder = qi.dialect.aggSupportsInlineOrderBy ? orderClause.trim() || undefined : undefined;
    return `SELECT ${qi.dialect.buildJsonArrayAgg(jsonObj, inlineOrder)} FROM ${qTarget} ${alias} WHERE ${whereClause}`;
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
export function buildManyToManySubquery(
  qi: BuilderCtx,
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
  const qTarget = qi.q(targetTable);
  const qJunction = qi.q(relDef.through.table);
  const qParent = qi.q(parentRef);
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
  const joinOn = targetKeys.map((jcol, i) => `${jalias}.${qi.q(jcol)} = ${talias}.${qi.q(targetPk[i]!)}`).join(' AND ');

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
    .map((jcol, i) => `${jalias}.${qi.q(jcol)} = ${qParent}.${qi.q(refKeys[i]!)}`)
    .join(' AND ');

  // ORDER BY on the target rows: unified with the top-level orderBy surface
  // (columnMap resolution, OrderBySpec nulls, JSON-path, relation ordering).
  // `orderBy: {}` (no defined entries) is treated as absent: it must not
  // render a dangling `ORDER BY `. Param pushes here land BEFORE the
  // spec.where params, mirrored by collectRelationSubqueryParams' m2m branch.
  const relOrderEntries =
    spec !== true && spec.orderBy ? orderByEntries(spec.orderBy).filter(([, dir]) => dir !== undefined) : [];
  let orderClause = '';
  if (relOrderEntries.length > 0) {
    orderClause = buildRelationOrderClause(qi, targetTable, targetMeta, talias, relOrderEntries, params);
  }

  // Additional WHERE filters on the target — full scalar where surface,
  // properly parameterized against the target alias.
  if (spec !== true && spec.where) {
    const extra = whereMod.buildAliasWhere(
      qi,
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
  const gfExtra = whereMod.targetGlobalFilterAlias(qi, targetTable, talias, params);
  if (gfExtra) whereClause += ` AND ${gfExtra}`;

  // LIMIT — `limit: 0` is honored (LIMIT 0 → empty array)
  let limitClause = '';
  if (spec !== true && spec.limit !== undefined) {
    limitClause = ` LIMIT ${qi.paginationRef(spec.limit, params)}`;
  }

  const fromJoin = `FROM ${qTarget} ${talias} JOIN ${qJunction} ${jalias} ON ${joinOn}`;

  // When LIMIT or ORDER BY is present, wrap the joined rows in an inner subquery
  // so the LIMIT applies to rows BEFORE aggregation (same approach as hasMany).
  if (limitClause || orderClause) {
    const innerAlias = `${talias}i`;
    const innerSql =
      `SELECT ${targetMeta.allColumns.map((c) => `${talias}.${qi.q(c)}`).join(', ')} ` +
      `${fromJoin} WHERE ${whereClause}${orderClause}${limitClause}`;
    const innerJsonPairs: [key: string, expr: string][] = targetColumns.map((col) => [
      targetMeta.reverseColumnMap[col] ?? snakeToCamel(col),
      `${innerAlias}.${qi.q(col)}`,
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
        const nestedSub = buildRelationSubquery(
          qi,
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
            ? qi.dialect.nullJsonLiteral
            : qi.dialect.emptyJsonArrayLiteral;
        innerJsonPairs.push([nestedRelName, qi.dialect.wrapJsonSubresult(nestedSub, fallback)]);
      }
    }
    const innerJsonObj = buildJsonRow(qi, innerJsonPairs);
    return `SELECT ${qi.dialect.buildJsonArrayAgg(innerJsonObj)} FROM (${innerSql}) ${innerAlias}`;
  }

  // Simple path: build the json object pairs directly off the target alias,
  // including any nested relations (correlated to the target alias).
  const jsonPairs: [key: string, expr: string][] = targetColumns.map((col) => [
    targetMeta.reverseColumnMap[col] ?? snakeToCamel(col),
    `${talias}.${qi.q(col)}`,
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
      const nestedSub = buildRelationSubquery(
        qi,
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
          ? qi.dialect.nullJsonLiteral
          : qi.dialect.emptyJsonArrayLiteral;
      jsonPairs.push([nestedRelName, qi.dialect.wrapJsonSubresult(nestedSub, fallback)]);
    }
  }
  const jsonObj = buildJsonRow(qi, jsonPairs);
  return `SELECT ${qi.dialect.buildJsonArrayAgg(jsonObj)} ${fromJoin} WHERE ${whereClause}`;
}
