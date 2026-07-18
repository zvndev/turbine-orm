/**
 * turbine-orm: aggregate / groupBy compilation (extracted from builder.ts)
 *
 * buildAggregate + buildGroupBy and their helpers (HAVING clauses, groupBy
 * ordering, DISTINCT-ON sources, JSON-path aggregate targets). All functions
 * take a {@link BuilderCtx} first argument; WHERE compilation is reused from
 * where.ts (via `whereMod`), and the shared orderBy / row-parse primitives
 * stay class-resident, reached through the ctx. See builder.ts for the thin
 * delegating methods (buildGroupBy / buildAggregate).
 */

import { UnsupportedFeatureError, ValidationError } from '../errors.js';
import { snakeToCamel } from '../schema.js';
import type { DeferredQuery } from './deferred.js';
import { isJsonPathOrderBy, isVectorOrderBy, normalizeOrderBy } from './filters.js';
import type {
  AggregateArgs,
  AggregateResult,
  GroupByArgs,
  GroupByOrderBy,
  HavingClause,
  HavingFilter,
  HavingNumericOperator,
  JsonPathAggregateTarget,
  OrderBySpec,
  OrderDirection,
  WhereClause,
} from './types.js';
import type { BuilderCtx } from './where.js';
import * as whereMod from './where.js';

export function buildGroupBy<T extends object>(
  qi: BuilderCtx,
  args: GroupByArgs<T>,
): DeferredQuery<Record<string, unknown>[]> {
  const meta = qi.schema.tables[qi.table];
  if (meta) {
    for (const key of args.by) {
      if (typeof key === 'string' && !(key in meta.columnMap)) {
        throw new ValidationError(`Unknown column "${key}" in groupBy for table "${qi.table}"`);
      }
    }
  }
  qi.currentSkip = args.skipGlobalFilters;
  const gbWhere = whereMod.mergeGlobalFilter(qi, args.where as Record<string, unknown> | undefined);
  const { sql: whereSql, params } = gbWhere
    ? whereMod.buildWhere(qi, gbWhere as WhereClause<T>)
    : { sql: '', params: [] as unknown[] };

  // Row source. Plain: `"table"<WHERE>`. With `distinctOn` (PostgreSQL
  // only), the groupBy runs over one representative row per column
  // combination: the wrapper carries args.where INSIDE it (filter before
  // picking) and is aliased as the table name so every outer expression is
  // byte-identical either way.
  const fromSql = args.distinctOn
    ? buildDistinctOnSource(qi, args.distinctOn, whereSql, params)
    : `${qi.q(qi.table)}${whereSql}`;

  // Group keys: plain columns and/or JSON-path keys. Output-name collisions
  // are rejected up front — and the check runs over the EMITTED SQL output
  // column names (snake_case column / JSON alias / `_agg_key` aggregate
  // alias), not just the given arg keys: the driver keeps only the LAST
  // duplicate field per row object, so a JSON alias equal to another key's
  // snake_case column (or an aggregate output alias) would silently clobber
  // that value in the results.
  const groupExprs: string[] = [];
  const selectExprs: string[] = [];
  /** by entries in order: how to read each group key off the result row. */
  const byReaders: { resultKey: string; rowKey: string; raw: boolean }[] = [];
  // ORDER BY registries: map each key the groupBy RESULT actually contains to
  // the exact SELECT expression that produced it, so `orderBy` re-emits that
  // expression (never a SELECT alias, since not every dialect accepts alias
  // references in ORDER BY, and re-emitting mirrors HAVING's `jsonAggExprs`).
  // `byOrderExprs`: plain by-field name / JSON group-key alias → column or
  // extract expression. `aggOrderExprs`: `${aggKey}:${field}` → aggregate
  // expression (including any already-bound JSON-path placeholder, reused
  // exactly like HAVING since ORDER BY is appended after all other params).
  const byOrderExprs = new Map<string, string>();
  const usedResultKeys = new Set<string>();
  const claimResultKey = (key: string, what: string): void => {
    if (key === '_count' || usedResultKeys.has(key)) {
      throw new ValidationError(
        `[turbine] groupBy output name "${key}" (${what}) collides with another output column on table ` +
          `"${qi.table}": set an explicit \`alias\` (or rename the aggregate key) to disambiguate.`,
      );
    }
    usedResultKeys.add(key);
  };
  for (const entry of args.by) {
    if (typeof entry === 'string') {
      const col = qi.toColumn(entry);
      claimResultKey(entry, `column "${col}"`);
      // The emitted output column is the snake_case name; claim it too (when
      // it differs from the result key) so a JSON alias like 'created_at'
      // cannot silently shadow the 'createdAt' group key on the wire.
      if (col !== entry) claimResultKey(col, `column "${col}"`);
      groupExprs.push(qi.q(col));
      selectExprs.push(qi.q(col));
      byReaders.push({ resultKey: entry, rowKey: col, raw: false });
      byOrderExprs.set(entry, qi.q(col));
    } else {
      const col = resolveJsonPathTarget(qi, 'group key', entry.field, entry.path);
      params.push(whereMod.jsonPathParam(qi, entry.path));
      const extract = qi.dialect.buildJsonPathExtract(qi.q(col), qi.p(params.length));
      const alias = entry.alias ?? String(entry.path[entry.path.length - 1]);
      claimResultKey(alias, `JSON path on "${entry.field}"`);
      // Same expression (and the same $n placeholder) in SELECT and GROUP BY.
      selectExprs.push(`(${extract}) AS ${qi.q(alias)}`);
      groupExprs.push(extract);
      byReaders.push({ resultKey: alias, rowKey: alias, raw: true });
      // ORDER BY by this JSON alias re-emits the extract expression (with its
      // already-bound $n): the same reuse HAVING does for JSON aggregates.
      byOrderExprs.set(alias, extract);
    }
  }

  // _count
  const countSelected = args._count === true || args._count === undefined;
  if (countSelected) {
    // default: always include count
    selectExprs.push(`${qi.castAgg('COUNT(*)', 'int')} AS _count`);
  }

  // ORDER BY aggregate expressions, keyed `${aggKey}:${field}` (plus a bare
  // `_count`). Populated alongside the SELECT list below so `orderBy` can only
  // reference an aggregate that is actually requested. `COUNT(*)` (uncast) is
  // the ordering expression (the SELECT cast is only for the returned value).
  const aggOrderExprs = new Map<string, string>();
  if (countSelected) aggOrderExprs.set('_count', 'COUNT(*)');

  // _sum / _avg / _min / _max: `true` keeps the plain-column behavior; a
  // {@link JsonPathAggregateTarget} aggregates a JSON path under the arg key
  // as alias. `jsonAggFields` routes each JSON-aggregate row key back to its
  // alias (and coercion kind) in the transform; `jsonAggExprs` lets HAVING
  // reuse the exact aggregate expression (same placeholders) by alias.
  const jsonAggFields = new Map<string, { field: string; numeric: boolean }>();
  const jsonAggExprs = new Map<string, string>();
  const buildAggregates = (
    aggKey: '_sum' | '_avg' | '_min' | '_max',
    sqlFn: 'SUM' | 'AVG' | 'MIN' | 'MAX',
    spec: Record<string, boolean | JsonPathAggregateTarget | undefined> | undefined,
  ): void => {
    if (!spec) return;
    for (const [key, target] of Object.entries(spec)) {
      if (!target) continue;
      if (target === true) {
        const col = qi.toColumn(key);
        // Aggregate output aliases share the same output-name namespace as
        // the group keys: `_sum: { totalPrice: true, total_price: {json} }`
        // would emit two "_sum_total_price" columns and silently drop one.
        claimResultKey(`${aggKey}_${col}`, `${aggKey} of column "${col}"`);
        const inner = `${sqlFn}(${qi.q(col)})`;
        const expr = aggKey === '_avg' ? qi.castAgg(inner, 'float') : inner;
        selectExprs.push(`${expr} AS ${qi.q(`${aggKey}_${col}`)}`);
        aggOrderExprs.set(`${aggKey}:${key}`, expr);
        continue;
      }
      const col = resolveJsonPathTarget(qi, `${aggKey} target "${key}"`, target.field, target.path);
      const alwaysNumeric = aggKey === '_sum' || aggKey === '_avg';
      if (alwaysNumeric && target.type === 'text') {
        throw new ValidationError(
          `[turbine] groupBy ${aggKey} target "${key}" on table "${qi.table}": ` +
            `${aggKey} over a JSON path is always numeric: remove \`type: 'text'\`.`,
        );
      }
      const numeric = alwaysNumeric || target.type === 'numeric';
      claimResultKey(`${aggKey}_${key}`, `${aggKey} JSON target "${key}"`);
      params.push(whereMod.jsonPathParam(qi, target.path));
      const extract = qi.dialect.buildJsonPathExtract(qi.q(col), qi.p(params.length));
      const inner = `${sqlFn}(${numeric ? whereMod.castJsonNumeric(qi, extract) : extract})`;
      const expr = aggKey === '_avg' ? qi.castAgg(inner, 'float') : inner;
      selectExprs.push(`${expr} AS ${qi.q(`${aggKey}_${key}`)}`);
      jsonAggFields.set(`${aggKey}_${key}`, { field: key, numeric });
      jsonAggExprs.set(`${key}:${aggKey}`, expr);
      aggOrderExprs.set(`${aggKey}:${key}`, expr);
    }
  };
  buildAggregates('_sum', 'SUM', args._sum as Record<string, boolean | JsonPathAggregateTarget> | undefined);
  buildAggregates('_avg', 'AVG', args._avg as Record<string, boolean | JsonPathAggregateTarget> | undefined);
  buildAggregates('_min', 'MIN', args._min as Record<string, boolean | JsonPathAggregateTarget> | undefined);
  buildAggregates('_max', 'MAX', args._max as Record<string, boolean | JsonPathAggregateTarget> | undefined);

  let sql = `SELECT ${selectExprs.join(', ')} FROM ${fromSql} GROUP BY ${groupExprs.join(', ')}`;

  // HAVING — filter whole groups by their aggregate values.
  // Appends to the same `params` array, so placeholders continue from the
  // WHERE clause's parameter positions (qi.p(params.length) below).
  if (args.having) {
    const havingClauses = buildHavingClauses(qi, args.having, params, jsonAggExprs);
    if (havingClauses.length > 0) {
      sql += ` HAVING ${havingClauses.join(' AND ')}`;
    }
  }

  // ORDER BY, over the groupBy RESULT columns (by-fields, JSON aliases, and
  // requested aggregates), not the table's physical columns.
  if (args.orderBy) {
    const orderSql = buildGroupByOrderBy(qi, args.orderBy, byOrderExprs, aggOrderExprs);
    if (orderSql) sql += ` ORDER BY ${orderSql}`;
  }

  return {
    sql,
    params,
    transform: (result) =>
      result.rows.map((row) => {
        const parsed = qi.parseRow(row, qi.table);
        // Restructure aggregate results into nested objects (Prisma-style)
        const restructured: Record<string, unknown> = {};

        // Copy group-by fields. JSON-path keys read their alias off the raw
        // row (the alias is not a table column, so parseRow's snake→camel
        // mapping must not touch it).
        for (const reader of byReaders) {
          restructured[reader.resultKey] = reader.raw ? row[reader.rowKey] : parsed[reader.resultKey];
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

        // JSON-path aggregates keep their arg key verbatim; plain-column
        // aggregates keep the snake→camel field mapping.
        const jsonAgg = (rawKey: string) => jsonAggFields.get(rawKey);
        const fieldFor = (rawKey: string, col: string): string =>
          jsonAgg(rawKey)?.field ?? qi.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);

        for (const [rawKey, rawValue] of Object.entries(row)) {
          if (rawKey.startsWith('_sum_')) {
            sumObj[fieldFor(rawKey, rawKey.slice(5))] = rawValue !== null ? Number(rawValue) : null;
            hasSums = true;
          } else if (rawKey.startsWith('_avg_')) {
            avgObj[fieldFor(rawKey, rawKey.slice(5))] = rawValue !== null ? Number(rawValue) : null;
            hasAvgs = true;
          } else if (rawKey.startsWith('_min_')) {
            const j = jsonAgg(rawKey);
            minObj[fieldFor(rawKey, rawKey.slice(5))] = j?.numeric && rawValue !== null ? Number(rawValue) : rawValue;
            hasMins = true;
          } else if (rawKey.startsWith('_max_')) {
            const j = jsonAgg(rawKey);
            maxObj[fieldFor(rawKey, rawKey.slice(5))] = j?.numeric && rawValue !== null ? Number(rawValue) : rawValue;
            hasMaxs = true;
          }
        }

        if (hasSums) restructured._sum = sumObj;
        if (hasAvgs) restructured._avg = avgObj;
        if (hasMins) restructured._min = minObj;
        if (hasMaxs) restructured._max = maxObj;

        return restructured;
      }),
    tag: `${qi.table}.groupBy`,
  };
}

/**
 * Compile a groupBy `orderBy` into an ORDER BY body. Unlike findMany ORDER BY
 * ({@link buildOrderBy}, which validates keys against the table's physical
 * columns), groupBy ordering targets the columns the RESULT actually
 * contains: plain by-fields, JSON group-key aliases, and requested aggregates
 * (`_count` / `_sum` / `_avg` / `_min` / `_max`). Each key re-emits the exact
 * SELECT expression that produced it (`byOrderExprs` / `aggOrderExprs`),
 * mirroring how HAVING re-emits aggregate expressions, so no dialect ever has
 * to accept a SELECT-alias reference in ORDER BY, and any already-bound
 * JSON-path placeholder is reused verbatim (ORDER BY is the last clause, so
 * no `$n` renumbering). An aggregate key that was not requested, or an unknown
 * by-key, throws {@link ValidationError} E003 listing the valid keys.
 */
export function buildGroupByOrderBy(
  qi: BuilderCtx,
  orderBy: GroupByOrderBy,
  byOrderExprs: Map<string, string>,
  aggOrderExprs: Map<string, string>,
): string {
  const aggBlocks = new Set(['_count', '_sum', '_avg', '_min', '_max']);
  /** Human-readable list of every key this call can order by (for E003). */
  const validKeys = (): string => {
    const keys = [...byOrderExprs.keys()];
    for (const k of aggOrderExprs.keys()) {
      keys.push(k.includes(':') ? k.replace(':', '.') : k);
    }
    return keys.join(', ') || '(none)';
  };

  const parts: string[] = [];
  for (const [key, value] of Object.entries(orderBy)) {
    if (value === undefined) continue;

    // Aggregate ordering blocks.
    if (aggBlocks.has(key)) {
      if (key === '_count') {
        const expr = aggOrderExprs.get('_count');
        if (!expr) {
          throw new ValidationError(
            `[turbine] Cannot order groupBy by "_count" on table "${qi.table}": _count is not selected. ` +
              `Orderable keys: ${validKeys()}.`,
          );
        }
        const { dir, nulls } = normalizeOrderBy(value as OrderDirection | OrderBySpec);
        parts.push(`${expr} ${dir}${qi.nullsSuffix(nulls)}`);
        continue;
      }
      // `_sum` / `_avg` / `_min` / `_max`: an object of field → direction/spec.
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new ValidationError(
          `[turbine] Invalid groupBy orderBy for "${key}" on table "${qi.table}": ` +
            `expected a field map like { ${key}: { amount: 'desc' } }.`,
        );
      }
      for (const [field, dirSpec] of Object.entries(value as Record<string, OrderDirection | OrderBySpec>)) {
        if (dirSpec === undefined) continue;
        const expr = aggOrderExprs.get(`${key}:${field}`);
        if (!expr) {
          throw new ValidationError(
            `[turbine] Cannot order groupBy by "${key}.${field}" on table "${qi.table}": ` +
              `that aggregate is not requested in this call. Orderable keys: ${validKeys()}.`,
          );
        }
        const { dir, nulls } = normalizeOrderBy(dirSpec);
        parts.push(`${expr} ${dir}${qi.nullsSuffix(nulls)}`);
      }
      continue;
    }

    // Plain by-field name or JSON group-key alias.
    const expr = byOrderExprs.get(key);
    if (!expr) {
      throw new ValidationError(
        `[turbine] Unknown field "${key}" in groupBy orderBy on table "${qi.table}". ` +
          `Orderable keys: ${validKeys()}.`,
      );
    }
    const { dir, nulls } = normalizeOrderBy(value as OrderDirection | OrderBySpec);
    parts.push(`${expr} ${dir}${qi.nullsSuffix(nulls)}`);
  }
  return parts.join(', ');
}

/**
 * Validate a JSON-path target (group key or aggregate target) in groupBy:
 * the field must resolve to a real json/jsonb column and the path must be a
 * non-empty array of keys/indexes. Returns the resolved snake_case column.
 */
export function resolveJsonPathTarget(
  qi: BuilderCtx,
  context: string,
  field: string,
  path: (string | number)[],
): string {
  if (typeof field !== 'string') {
    throw new ValidationError(`[turbine] groupBy ${context} on table "${qi.table}" requires a string \`field\`.`);
  }
  const col = qi.toColumn(field);
  if (
    !Array.isArray(path) ||
    path.length === 0 ||
    path.some((el) => typeof el !== 'string' && !(typeof el === 'number' && Number.isFinite(el)))
  ) {
    throw new ValidationError(
      `[turbine] groupBy ${context} on "${field}" (table "${qi.table}") requires a non-empty \`path\` ` +
        `array of keys/indexes (e.g. { field: '${field}', path: ['category'] }).`,
    );
  }
  const colType = whereMod.pgTypeForColumn(qi, qi.tableMeta, col);
  if (!whereMod.isJsonColumnType(qi, colType)) {
    throw new ValidationError(
      `[turbine] groupBy ${context} on "${field}": column "${col}" on table "${qi.table}" is not a JSON ` +
        `column (actual type: ${colType}).`,
    );
  }
  return col;
}

/**
 * Build the `distinctOn` row source for groupBy (PostgreSQL only: other
 * engines throw {@link UnsupportedFeatureError} E017):
 *
 * ```sql
 * (SELECT DISTINCT ON ("c1") * FROM "table"<WHERE> ORDER BY "c1", <orderBy>) AS "table"
 * ```
 *
 * The wrapper is aliased as the table name so every outer expression (group
 * keys, aggregates, HAVING, ORDER BY) is byte-identical to the plain path.
 * `distinctOn.orderBy` is required (it decides which row survives) and
 * supports plain columns, {@link OrderBySpec} nulls, and JSON-path specs;
 * JSON paths push their text[] param here, after the WHERE params.
 */
export function buildDistinctOnSource<T extends object>(
  qi: BuilderCtx,
  distinctOn: NonNullable<GroupByArgs<T>['distinctOn']>,
  whereSql: string,
  params: unknown[],
): string {
  if (qi.dialect.name !== 'postgresql') {
    throw new UnsupportedFeatureError(
      'DISTINCT ON row source (groupBy distinctOn)',
      qi.dialect.name,
      'groupBy({ distinctOn }) requires PostgreSQL: SELECT DISTINCT ON is not portable.',
    );
  }
  if (!Array.isArray(distinctOn.columns) || distinctOn.columns.length === 0) {
    throw new ValidationError(
      `[turbine] groupBy distinctOn on table "${qi.table}" requires a non-empty \`columns\` array.`,
    );
  }
  const orderEntries = Object.entries(distinctOn.orderBy ?? {});
  if (orderEntries.length === 0) {
    throw new ValidationError(
      `[turbine] groupBy distinctOn on table "${qi.table}" requires \`orderBy\` to pick ONE row per ` +
        "column combination deterministically (e.g. orderBy: { createdAt: 'desc' }).",
    );
  }
  const distinctCols = distinctOn.columns.map((c) => qi.q(qi.toColumn(c)));
  // DISTINCT ON expressions must lead the ORDER BY; the user's orderBy then
  // decides which row survives per combination.
  const orderParts: string[] = [...distinctCols];
  for (const [key, value] of orderEntries) {
    if (isJsonPathOrderBy(value)) {
      orderParts.push(qi.buildJsonPathOrderEntry(qi.table, qi.tableMeta, key, value, '', params));
      continue;
    }
    if (isVectorOrderBy(value) || qi.isRelationOrderByValue(value)) {
      throw new ValidationError(
        `[turbine] groupBy distinctOn.orderBy on "${key}" (table "${qi.table}") supports plain columns, ` +
          'sort specs, and JSON-path orderings only.',
      );
    }
    const col = qi.resolveOrderByColumn(qi.table, qi.tableMeta, key);
    const { dir, nulls } = normalizeOrderBy(value as OrderDirection | OrderBySpec);
    orderParts.push(`${qi.q(col)} ${dir}${qi.nullsSuffix(nulls)}`);
  }
  return (
    `(SELECT DISTINCT ON (${distinctCols.join(', ')}) * FROM ${qi.q(qi.table)}${whereSql} ` +
    `ORDER BY ${orderParts.join(', ')}) AS ${qi.q(qi.table)}`
  );
}

/**
 * Build the SQL fragments for a {@link HavingClause}.
 *
 * Each aggregate expression (`COUNT(*)`, `SUM("col")`, etc.) is constructed
 * from a **schema-validated, quoted** column identifier: `qi.toColumn()`
 * throws {@link ValidationError} for unknown fields and `qi.q()` quotes via
 * the dialect, so no unvalidated identifier ever reaches the SQL string. Every
 * comparison value is pushed onto the shared `params` array and referenced by
 * a `$N` placeholder via {@link buildHavingNumericClauses} — there is no string
 * interpolation of user values.
 *
 * `jsonAggExprs` (from {@link buildGroupBy}) maps `alias:aggKey` to the
 * exact aggregate expression a JSON-path aggregate emitted in SELECT
 * (including its already-bound path placeholder), so HAVING on a JSON-path
 * aggregate alias reuses the same expression instead of resolving the alias
 * as a column.
 */
export function buildHavingClauses<T extends object>(
  qi: BuilderCtx,
  having: HavingClause<T>,
  params: unknown[],
  jsonAggExprs?: Map<string, string>,
): string[] {
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
      clauses.push(...buildHavingNumericClauses(qi, 'COUNT(*)', value as HavingFilter, params));
      continue;
    }

    // Otherwise `key` is a field name mapping to a per-aggregate filter object.
    if (typeof value !== 'object' || value === null) {
      throw new ValidationError(
        `[turbine] Invalid having filter for field "${key}" on table "${qi.table}": ` +
          `expected an aggregate object like { _sum: { gt: 100 } }.`,
      );
    }

    // toColumn validates the field against schema metadata (throws
    // ValidationError on unknown columns) and q() quotes the identifier — no
    // unvalidated identifier ever reaches the SQL string. Resolution is lazy:
    // a JSON-path aggregate alias is not a column, so it must not hit
    // toColumn when every aggregate under it resolves via `jsonAggExprs`.
    let quotedCol: string | null = null;
    const columnExpr = (): string => {
      quotedCol ??= qi.q(qi.toColumn(key));
      return quotedCol;
    };

    for (const [aggKey, filter] of Object.entries(value as Record<string, HavingFilter>)) {
      if (filter === undefined) continue;
      const fn = aggFnByKey[aggKey];
      if (!fn) {
        throw new ValidationError(
          `[turbine] Unknown aggregate "${aggKey}" in having for field "${key}" on table "${qi.table}". ` +
            `Supported: ${Object.keys(aggFnByKey).join(', ')}.`,
        );
      }
      const expr = jsonAggExprs?.get(`${key}:${aggKey}`) ?? `${fn}(${columnExpr()})`;
      clauses.push(...buildHavingNumericClauses(qi, expr, filter, params));
    }
  }

  return clauses;
}

/**
 * Convert a single having filter into one or more parameterized SQL
 * comparisons against the given aggregate expression. A bare number is
 * shorthand for equality. Unknown operator keys throw {@link ValidationError}.
 */
export function buildHavingNumericClauses(
  qi: BuilderCtx,
  expr: string,
  filter: HavingFilter,
  params: unknown[],
): string[] {
  // Bare number → equality.
  if (typeof filter === 'number') {
    params.push(filter);
    return [`${expr} = ${qi.p(params.length)}`];
  }

  if (typeof filter !== 'object' || filter === null) {
    throw new ValidationError(
      `[turbine] Invalid having filter on "${expr}" for table "${qi.table}": expected a number or operator object.`,
    );
  }

  const op = filter as HavingNumericOperator;
  const allowedKeys = new Set(['equals', 'not', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn']);
  for (const k of Object.keys(op)) {
    if (!allowedKeys.has(k)) {
      throw new ValidationError(
        `[turbine] Unknown having operator "${k}" on "${expr}" for table "${qi.table}". ` +
          `Supported: ${[...allowedKeys].join(', ')}.`,
      );
    }
  }

  const clauses: string[] = [];
  if (op.equals !== undefined) {
    params.push(op.equals);
    clauses.push(`${expr} = ${qi.p(params.length)}`);
  }
  if (op.not !== undefined) {
    params.push(op.not);
    clauses.push(`${expr} != ${qi.p(params.length)}`);
  }
  if (op.gt !== undefined) {
    params.push(op.gt);
    clauses.push(`${expr} > ${qi.p(params.length)}`);
  }
  if (op.gte !== undefined) {
    params.push(op.gte);
    clauses.push(`${expr} >= ${qi.p(params.length)}`);
  }
  if (op.lt !== undefined) {
    params.push(op.lt);
    clauses.push(`${expr} < ${qi.p(params.length)}`);
  }
  if (op.lte !== undefined) {
    params.push(op.lte);
    clauses.push(`${expr} <= ${qi.p(params.length)}`);
  }
  if (op.in !== undefined) {
    params.push(qi.inParam(op.in));
    clauses.push(qi.inClause(expr, qi.p(params.length), false));
  }
  if (op.notIn !== undefined) {
    params.push(qi.inParam(op.notIn));
    clauses.push(qi.inClause(expr, qi.p(params.length), true));
  }
  return clauses;
}

export function buildAggregate<T extends object>(
  qi: BuilderCtx,
  args: AggregateArgs<T>,
): DeferredQuery<AggregateResult<T>> {
  qi.currentSkip = args.skipGlobalFilters;
  const aggWhere = whereMod.mergeGlobalFilter(qi, args.where as Record<string, unknown> | undefined);
  const { sql: whereSql, params } = aggWhere
    ? whereMod.buildWhere(qi, aggWhere as WhereClause<T>)
    : { sql: '', params: [] as unknown[] };

  const meta = qi.schema.tables[qi.table];
  if (meta) {
    for (const group of [args._sum, args._avg, args._min, args._max]) {
      if (group && typeof group === 'object') {
        for (const key of Object.keys(group)) {
          if (!(key in meta.columnMap)) {
            throw new ValidationError(`Unknown column "${key}" in aggregate for table "${qi.table}"`);
          }
        }
      }
    }
    if (args._count && typeof args._count === 'object') {
      for (const key of Object.keys(args._count)) {
        if (!(key in meta.columnMap)) {
          throw new ValidationError(`Unknown column "${key}" in aggregate for table "${qi.table}"`);
        }
      }
    }
  }

  const selectExprs: string[] = [];

  // _count
  if (args._count === true) {
    selectExprs.push(`${qi.castAgg('COUNT(*)', 'int')} AS _count`);
  } else if (args._count && typeof args._count === 'object') {
    for (const [field, enabled] of Object.entries(args._count)) {
      if (enabled) {
        const col = qi.toColumn(field);
        selectExprs.push(`${qi.castAgg(`COUNT(${qi.q(col)})`, 'int')} AS ${qi.q(`_count_${col}`)}`);
      }
    }
  }

  // _sum
  if (args._sum) {
    for (const [field, enabled] of Object.entries(args._sum)) {
      if (enabled) {
        const col = qi.toColumn(field);
        selectExprs.push(`SUM(${qi.q(col)}) AS ${qi.q(`_sum_${col}`)}`);
      }
    }
  }

  // _avg
  if (args._avg) {
    for (const [field, enabled] of Object.entries(args._avg)) {
      if (enabled) {
        const col = qi.toColumn(field);
        selectExprs.push(`${qi.castAgg(`AVG(${qi.q(col)})`, 'float')} AS ${qi.q(`_avg_${col}`)}`);
      }
    }
  }

  // _min
  if (args._min) {
    for (const [field, enabled] of Object.entries(args._min)) {
      if (enabled) {
        const col = qi.toColumn(field);
        selectExprs.push(`MIN(${qi.q(col)}) AS ${qi.q(`_min_${col}`)}`);
      }
    }
  }

  // _max
  if (args._max) {
    for (const [field, enabled] of Object.entries(args._max)) {
      if (enabled) {
        const col = qi.toColumn(field);
        selectExprs.push(`MAX(${qi.q(col)}) AS ${qi.q(`_max_${col}`)}`);
      }
    }
  }

  if (selectExprs.length === 0) {
    selectExprs.push(`${qi.castAgg('COUNT(*)', 'int')} AS _count`);
  }

  const sql = `SELECT ${selectExprs.join(', ')} FROM ${qi.q(qi.table)}${whereSql}`;

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
            const field = qi.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
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
          const field = qi.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
          sumObj[field] = val !== null ? Number(val) : null;
          hasSums = true;
        } else if (key.startsWith('_avg_')) {
          const col = key.slice(5);
          const field = qi.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
          avgObj[field] = val !== null ? Number(val) : null;
          hasAvgs = true;
        } else if (key.startsWith('_min_')) {
          const col = key.slice(5);
          const field = qi.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
          minObj[field] = val;
          hasMins = true;
        } else if (key.startsWith('_max_')) {
          const col = key.slice(5);
          const field = qi.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
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
    tag: `${qi.table}.aggregate`,
  };
}
