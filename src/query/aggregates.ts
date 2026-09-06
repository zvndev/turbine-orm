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
import type { TableMetadata } from '../schema.js';
import { snakeToCamel } from '../schema.js';
import type { DeferredQuery } from './deferred.js';
import {
  dedupeColumnList,
  isJsonPathOrderBy,
  isUnmatchedPlainObject,
  isVectorOrderBy,
  isWhereOperator,
  normalizeOrderBy,
  orderByEntries,
} from './filters.js';
import type {
  AggregateArgs,
  AggregateResult,
  GroupByArgs,
  GroupByOrderBy,
  HavingClause,
  HavingComparisonOperator,
  JsonPathAggregateTarget,
  OrderBySpec,
  OrderDirection,
  WhereClause,
} from './types.js';
import { assertOrderDirection, resolveSkipGlobalFilters, resolveUnsafeFlag } from './types.js';
import { isTemporalInfinity, ownLookup, parseDbDate, resolveColumnName, warnRedundantSortTerm } from './utils.js';
import type { BuilderCtx } from './where.js';
import * as whereMod from './where.js';
import { assertWhereDepth } from './where-compile.js';

/**
 * Enforce the PII contract on the aggregate surface. A PII-tagged
 * (`defineSchema` `pii: true`) column is excluded from every default
 * projection, and a value-returning aggregate is a projection by another name:
 * `groupBy({ by: ['email'] })` emits one row per distinct plaintext email, and
 * `_min`/`_max` return a stored cell verbatim. Both therefore REQUIRE the same
 * `includePii` opt-in (the UNSAFE sentinel) that reads use.
 *
 * Deliberately NOT gated: `_count` (a count, never a value), `_sum` / `_avg`
 * (a computed total across many rows, not a stored cell), and `where` /
 * `orderBy` / `having` on PII columns (they return no values at all). Untagged
 * schemas short-circuit on the `pii` lookup, so their SQL is byte-identical.
 *
 * Shared with the PowQL aggregate paths (src/powql.ts) so every engine applies
 * one policy.
 */
export function assertAggregatePiiOptIn(
  table: string,
  meta: TableMetadata | undefined,
  field: string,
  column: string,
  usage: string,
  includePii: boolean | undefined,
): void {
  if (includePii === true || !meta) return;
  const colMeta = meta.columns.find((c) => c.name === column);
  if (!colMeta?.pii) return;
  throw new ValidationError(
    `${usage} on column "${field}" of table "${table}" is refused: that column is ` +
      'PII-tagged (`pii: true`), and this aggregate returns its stored values, which are excluded ' +
      'from every default projection. Pass `includePii: UNSAFE` on this call to opt in ' +
      "(import { UNSAFE } from 'turbine-orm'). " +
      '`_count` over a PII column (a count, not a value) and `where` / `orderBy` / `having` on PII ' +
      'columns need no opt-in.',
  );
}

export function buildGroupBy<T extends object>(
  qi: BuilderCtx,
  args: GroupByArgs<T>,
): DeferredQuery<Record<string, unknown>[]> {
  const meta = qi.schema.tables[qi.table];
  // Up-front, so a bad `by` key is reported before anything else in the call,
  // and through `qi.toColumn` (the ONE `resolveColumnName` rule) rather than
  // `key in meta.columnMap`, which knows only the FIELD spelling and so
  // rejected the snake_case COLUMN name that `where` / `select` / `distinct`
  // accept and that an introspected schema's DDL declares.
  for (const key of args.by) {
    if (typeof key === 'string') qi.toColumn(key);
  }
  qi.currentSkip = resolveSkipGlobalFilters(args.skipGlobalFilters);
  // Resolve the PII opt-in ONCE, here, so the sentinel check runs on every
  // groupBy (including one whose `by` names no PII column) rather than only on
  // the paths that happen to consult it.
  const includePii = resolveUnsafeFlag(args.includePii, 'includePii');
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
  // are rejected up front, and the check runs over the EMITTED SQL output
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
  // The group-key set a `having` SCALAR filter may reference, keyed the same
  // way (by-field name / JSON group-key alias). Separate from `byOrderExprs`
  // because HAVING needs to know HOW the key is addressed: a plain by-field
  // routes through the shared WHERE compiler by field name, a JSON group key
  // re-emits its extract expression. See {@link buildHavingClauses}.
  const havingGroupKeys = new Map<string, HavingGroupKey>();
  const usedResultKeys = new Set<string>();
  const claimResultKey = (key: string, what: string): void => {
    if (key === '_count' || usedResultKeys.has(key)) {
      throw new ValidationError(
        `groupBy output name "${key}" (${what}) collides with another output column on table ` +
          `"${qi.table}": set an explicit \`alias\` (or rename the aggregate key) to disambiguate.`,
      );
    }
    usedResultKeys.add(key);
  };
  for (const entry of args.by) {
    if (typeof entry === 'string') {
      const col = qi.toColumn(entry);
      // The group key's identity is the COLUMN, so everything keyed off it
      // uses the canonical FIELD name rather than whichever spelling the caller
      // wrote. The result key above all: rows are read through `parseRow`,
      // whose keys are field names, so `by: ['created_at']` keyed by the
      // caller's spelling read `parsed['created_at']` and returned `undefined`
      // for every group. `_count` / `_sum` / `_min` in the same transform
      // already map their alias back through `reverseColumnMap`.
      const field = qi.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
      assertAggregatePiiOptIn(qi.table, meta, entry, col, 'groupBy `by` key', includePii);
      claimResultKey(field, `column "${col}"`);
      // The emitted output column is the snake_case name; claim it too (when
      // it differs from the result key) so a JSON alias like 'created_at'
      // cannot silently shadow the 'createdAt' group key on the wire.
      if (col !== field) claimResultKey(col, `column "${col}"`);
      groupExprs.push(qi.q(col));
      selectExprs.push(qi.q(col));
      byReaders.push({ resultKey: field, rowKey: col, raw: false });
      // Registered ONCE, under the canonical field: `orderBy` and `having`
      // may spell the same group key the other way, and {@link lookupGroupKey}
      // reconciles that at lookup time rather than doubling every
      // "orderable keys" list.
      byOrderExprs.set(field, qi.q(col));
      havingGroupKeys.set(field, { kind: 'column', field });
    } else {
      const col = resolveJsonPathTarget(qi, 'group key', entry.field, entry.path);
      assertAggregatePiiOptIn(qi.table, meta, entry.field, col, 'groupBy JSON `by` key', includePii);
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
      // Parenthesized: a scalar having predicate appends comparison / IS NULL
      // operators to this expression, and the extract is emitted bare here.
      havingGroupKeys.set(alias, { kind: 'expr', expr: `(${extract})`, label: `JSON group key "${alias}"` });
    }
  }

  // _count
  //   - `true` / omitted → scalar `_count` column (COUNT(*)), result `_count: number`.
  //   - record form → one column per selection: `_all` → COUNT(*) AS "_count__all"
  //     (double underscore, collision-proof against a real column named `all`),
  //     each field → COUNT(col) AS "_count_<col>", result `_count: { _all, field }`.
  const countArg = args._count;
  const countIsRecord = countArg !== true && countArg !== undefined && typeof countArg === 'object';
  const scalarCount = countArg === true || countArg === undefined;
  if (scalarCount) {
    // default: always include the scalar count
    selectExprs.push(`${qi.castAgg('COUNT(*)', 'int')} AS _count`);
  } else if (countIsRecord) {
    for (const [field, enabled] of Object.entries(countArg as Record<string, boolean>)) {
      if (!enabled) continue;
      if (field === '_all') {
        selectExprs.push(`${qi.castAgg('COUNT(*)', 'int')} AS ${qi.q('_count__all')}`);
      } else {
        const col = qi.toColumn(field);
        selectExprs.push(`${qi.castAgg(`COUNT(${qi.q(col)})`, 'int')} AS ${qi.q(`_count_${col}`)}`);
      }
    }
  }

  // ORDER BY aggregate expressions, keyed `${aggKey}:${field}` (plus a bare
  // `_count`). Populated alongside the SELECT list below so `orderBy` can only
  // reference an aggregate that is actually requested. `COUNT(*)` (uncast) is
  // the ordering expression (the SELECT cast is only for the returned value).
  // COUNT(*) is orderable whenever it is selected: scalar `_count`, OR the
  // record form containing `_all`.
  const countSelected = scalarCount || (countIsRecord && (countArg as Record<string, boolean>)._all === true);
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
        if (aggKey === '_min' || aggKey === '_max') {
          assertAggregatePiiOptIn(qi.table, meta, key, col, `groupBy ${aggKey}`, includePii);
        }
        // Aggregate output aliases share the same output-name namespace as
        // the group keys: `_sum: { totalPrice: true, total_price: {json} }`
        // would emit two "_sum_total_price" columns and silently drop one.
        claimResultKey(`${aggKey}_${col}`, `${aggKey} of column "${col}"`);
        const inner = `${sqlFn}(${qi.q(col)})`;
        const expr = aggKey === '_avg' ? plainAvgExpr(qi, col) : inner;
        selectExprs.push(`${expr} AS ${qi.q(`${aggKey}_${col}`)}`);
        // Canonical field, matching the result bucket the transform fills;
        // `orderBy` may spell it either way (see {@link lookupGroupKey}).
        aggOrderExprs.set(`${aggKey}:${qi.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col)}`, expr);
        continue;
      }
      const col = resolveJsonPathTarget(qi, `${aggKey} target "${key}"`, target.field, target.path);
      if (aggKey === '_min' || aggKey === '_max') {
        assertAggregatePiiOptIn(qi.table, meta, target.field, col, `groupBy ${aggKey} JSON target`, includePii);
      }
      const alwaysNumeric = aggKey === '_sum' || aggKey === '_avg';
      if (alwaysNumeric && target.type === 'text') {
        throw new ValidationError(
          `groupBy ${aggKey} target "${key}" on table "${qi.table}": ` +
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

  // HAVING, filter whole groups by their aggregate values.
  // Appends to the same `params` array, so placeholders continue from the
  // WHERE clause's parameter positions (qi.p(params.length) below).
  if (args.having) {
    const havingClauses = buildHavingClauses(qi, args.having, params, jsonAggExprs, havingGroupKeys);
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

  // LIMIT / OFFSET over the result groups, applied AFTER ORDER BY. Routed
  // through the dialect pagination hook (parameterized on PG/SQLite/SQL Server,
  // inlined on MySQL); params append after the WHERE/HAVING/ORDER BY params, so
  // no `$n` renumbering. `offset` without a deterministic `orderBy` yields an
  // arbitrary window (same caveat as findMany).
  if (args.limit !== undefined || args.offset !== undefined) {
    const limitPh = args.limit !== undefined ? qi.paginationRef(args.limit, params, 'limit') : undefined;
    const offsetPh = args.offset !== undefined ? qi.paginationRef(args.offset, params, 'skip/offset') : undefined;
    sql += qi.buildPagination(limitPh, offsetPh, args.orderBy !== undefined);
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
        //   scalar form → the plain `_count` (or driver-lowercased `count`) column.
        //   record form → assemble `{ _all, field, ... }` from the `_count__all`
        //   and `_count_<col>` columns. `_count__all` MUST be matched before the
        //   generic `_count_` prefix (its slice(7) would map through snakeToCamel).
        if ('_count' in row) {
          restructured._count = row._count;
        } else if ('count' in row) {
          restructured._count = row.count;
        } else {
          const countObj: Record<string, unknown> = {};
          let hasCount = false;
          for (const [rawKey, rawValue] of Object.entries(row)) {
            if (rawKey === '_count__all') {
              countObj._all = rawValue;
              hasCount = true;
            } else if (rawKey.startsWith('_count_')) {
              const col = rawKey.slice(7);
              const field = qi.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
              countObj[field] = rawValue;
              hasCount = true;
            }
          }
          if (hasCount) restructured._count = countObj;
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

        // A JSON-path `_sum` / `_avg` casts its extracted text to numeric in
        // SQL and is always a number; a plain column follows its source type
        // (see {@link isExactNumericType}).
        const sumAvg = (rawKey: string, rawValue: unknown): number | string | null =>
          jsonAgg(rawKey) ? (rawValue !== null ? Number(rawValue) : null) : sumAvgValue(qi, rawKey.slice(5), rawValue);

        for (const [rawKey, rawValue] of Object.entries(row)) {
          if (rawKey.startsWith('_sum_')) {
            sumObj[fieldFor(rawKey, rawKey.slice(5))] = sumAvg(rawKey, rawValue);
            hasSums = true;
          } else if (rawKey.startsWith('_avg_')) {
            avgObj[fieldFor(rawKey, rawKey.slice(5))] = sumAvg(rawKey, rawValue);
            hasAvgs = true;
          } else if (rawKey.startsWith('_min_')) {
            const j = jsonAgg(rawKey);
            minObj[fieldFor(rawKey, rawKey.slice(5))] =
              j?.numeric && rawValue !== null ? Number(rawValue) : temporalAggValue(qi, rawKey.slice(5), rawValue);
            hasMins = true;
          } else if (rawKey.startsWith('_max_')) {
            const j = jsonAgg(rawKey);
            maxObj[fieldFor(rawKey, rawKey.slice(5))] =
              j?.numeric && rawValue !== null ? Number(rawValue) : temporalAggValue(qi, rawKey.slice(5), rawValue);
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
/**
 * Read a caller-supplied groupBy result key out of a registry keyed by the
 * CANONICAL name (the field for a `by` column / aggregate target, the alias
 * for a JSON group key).
 *
 * `by`, `orderBy` and `having` are three arguments of one call, each free to
 * spell a column either way, so `by`'s choice must not decide what the other
 * two may name. Reconciled here rather than by registering both spellings,
 * which would list every group key twice in the "orderable keys" text: try the
 * key as written (which is what carries a JSON alias, not a column), then its
 * canonical field.
 */
function lookupGroupKey<V>(qi: BuilderCtx, registry: Map<string, V>, key: string): V | undefined {
  const direct = registry.get(key);
  if (direct !== undefined) return direct;
  const canonical = canonicalFieldName(qi, key);
  return canonical === undefined ? undefined : registry.get(canonical);
}

/**
 * The canonical FIELD name for a caller-supplied column name, or `undefined`
 * when it names no column (a JSON group-key alias, a typo). One hop through
 * {@link resolveColumnName} and back via `reverseColumnMap`, so both spellings
 * land on one string.
 */
function canonicalFieldName(qi: BuilderCtx, key: string): string | undefined {
  const column = resolveColumnName(qi.tableMeta, key);
  if (column === undefined) return undefined;
  return qi.tableMeta.reverseColumnMap[column] ?? snakeToCamel(column);
}

export function buildGroupByOrderBy(
  qi: BuilderCtx,
  orderBy: GroupByOrderBy | GroupByOrderBy[],
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
  // Redundant-sort-term dropping, groupBy's spelling of it (see
  // `dedupeOrderEntries` in filters.ts for why this drops rather than refuses).
  // The findMany rule compares the RESOLVED COLUMN because its keys are field
  // names; here the keys are RESULT keys (by-fields, JSON group-key aliases,
  // aggregate blocks) that have already been resolved into the exact SELECT
  // expression they re-emit, so the expression IS the identity, and comparing
  // it is both cheaper and stricter: an alias and a JSON group key that extract
  // the same path collapse onto one term, which is what "sorts by the same
  // thing" means. Direction is excluded for the same reason as in filters.ts: a
  // second term on an expression the first already ordered by cannot move a row
  // whichever way it points.
  //
  // Done in place rather than up front because groupBy does not go through the
  // SQL-template cache at all, so there is no fingerprint for this to stay in
  // step with; the compile path is the only path.
  const seen = new Map<string, string>();
  const pushOrderTerm = (expr: string, label: string, value: OrderDirection | OrderBySpec): void => {
    const first = seen.get(expr);
    if (first !== undefined) {
      warnRedundantSortTerm(qi.table, 'groupBy orderBy', [{ key: label, first, resolved: expr }]);
      return;
    }
    seen.set(expr, label);
    const { dir, nulls } = normalizeOrderBy(value);
    parts.push(`${expr} ${dir}${qi.nullsSuffix(nulls)}`);
  };

  for (const [key, value] of orderByEntries(orderBy)) {
    if (value === undefined) continue;

    // Aggregate ordering blocks.
    if (aggBlocks.has(key)) {
      if (key === '_count') {
        const expr = aggOrderExprs.get('_count');
        if (!expr) {
          throw new ValidationError(
            `Cannot order groupBy by "_count" on table "${qi.table}": _count is not selected. ` +
              `Orderable keys: ${validKeys()}.`,
          );
        }
        // Refuse a direction that is neither asc nor desc BEFORE normalizeOrderBy,
        // whose `=== 'desc' ? DESC : ASC` would silently sort ascending.
        assertOrderDirection(value, `groupBy orderBy "_count" on table "${qi.table}"`);
        pushOrderTerm(expr, '_count', value as OrderDirection | OrderBySpec);
        continue;
      }
      // `_sum` / `_avg` / `_min` / `_max`: an object of field → direction/spec.
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new ValidationError(
          `Invalid groupBy orderBy for "${key}" on table "${qi.table}": ` +
            `expected a field map like { ${key}: { amount: 'desc' } }.`,
        );
      }
      for (const [field, dirSpec] of Object.entries(value as Record<string, OrderDirection | OrderBySpec>)) {
        if (dirSpec === undefined) continue;
        // `field` is the caller's spelling of the aggregate's target column;
        // the registry is keyed by the canonical one.
        const canonical = canonicalFieldName(qi, field);
        const expr =
          aggOrderExprs.get(`${key}:${field}`) ??
          (canonical === undefined ? undefined : aggOrderExprs.get(`${key}:${canonical}`));
        if (!expr) {
          throw new ValidationError(
            `Cannot order groupBy by "${key}.${field}" on table "${qi.table}": ` +
              `that aggregate is not requested in this call. Orderable keys: ${validKeys()}.`,
          );
        }
        assertOrderDirection(dirSpec, `groupBy orderBy "${key}.${field}" on table "${qi.table}"`);
        pushOrderTerm(expr, `${key}.${field}`, dirSpec);
      }
      continue;
    }

    // Plain by-field name or JSON group-key alias.
    const expr = lookupGroupKey(qi, byOrderExprs, key);
    if (!expr) {
      throw new ValidationError(
        `Unknown field "${key}" in groupBy orderBy on table "${qi.table}". ` + `Orderable keys: ${validKeys()}.`,
      );
    }
    assertOrderDirection(value, `groupBy orderBy "${key}" on table "${qi.table}"`);
    pushOrderTerm(expr, key, value as OrderDirection | OrderBySpec);
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
    throw new ValidationError(`groupBy ${context} on table "${qi.table}" requires a string \`field\`.`);
  }
  const col = qi.toColumn(field);
  if (
    !Array.isArray(path) ||
    path.length === 0 ||
    path.some((el) => typeof el !== 'string' && !(typeof el === 'number' && Number.isFinite(el)))
  ) {
    throw new ValidationError(
      `groupBy ${context} on "${field}" (table "${qi.table}") requires a non-empty \`path\` ` +
        `array of keys/indexes (e.g. { field: '${field}', path: ['category'] }).`,
    );
  }
  const colType = whereMod.pgTypeForColumn(qi, qi.tableMeta, col);
  if (!whereMod.isJsonColumnType(qi, colType)) {
    throw new ValidationError(
      `groupBy ${context} on "${field}": column "${col}" on table "${qi.table}" is not a JSON ` +
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
    throw new ValidationError(`groupBy distinctOn on table "${qi.table}" requires a non-empty \`columns\` array.`);
  }
  const orderEntries = Object.entries(distinctOn.orderBy ?? {});
  if (orderEntries.length === 0) {
    throw new ValidationError(
      `groupBy distinctOn on table "${qi.table}" requires \`orderBy\` to pick ONE row per ` +
        "column combination deterministically (e.g. orderBy: { createdAt: 'desc' }).",
    );
  }
  // A repeated DISTINCT ON column is a no-op, so drop it rather than emit it
  // twice (see `dedupeColumnList`). The orderBy below needs no equivalent: its
  // keys come from an object, and the DISTINCT ON columns lead the ORDER BY, so
  // a key repeating one of them is already merged by `orderParts`' construction.
  const dedupedCols = dedupeColumnList(qi.tableMeta, distinctOn.columns);
  if (dedupedCols) warnRedundantSortTerm(qi.table, 'groupBy distinctOn.columns', dedupedCols.dropped);
  const distinctCols = (dedupedCols?.columns ?? distinctOn.columns).map((c) => qi.q(qi.toColumn(c)));
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
        `groupBy distinctOn.orderBy on "${key}" (table "${qi.table}") supports plain columns, ` +
          'sort specs, and JSON-path orderings only.',
      );
    }
    const col = qi.resolveOrderByColumn(qi.table, qi.tableMeta, key);
    assertOrderDirection(value, `groupBy distinctOn.orderBy "${key}" on table "${qi.table}"`);
    const { dir, nulls } = normalizeOrderBy(value as OrderDirection | OrderBySpec);
    orderParts.push(`${qi.q(col)} ${dir}${qi.nullsSuffix(nulls)}`);
  }
  return (
    `(SELECT DISTINCT ON (${distinctCols.join(', ')}) * FROM ${qi.q(qi.table)}${whereSql} ` +
    `ORDER BY ${orderParts.join(', ')}) AS ${qi.q(qi.table)}`
  );
}

/**
 * Maps a per-field aggregate key to its SQL function name. The set of allowed
 * keys is fixed here: any OTHER underscore-prefixed key on a field's filter
 * object is rejected by {@link ValidationError} (never interpolated), and every
 * non-underscore key is a scalar operator on the grouped value itself.
 */
const HAVING_AGGREGATE_FNS: Record<string, string> = {
  _sum: 'SUM',
  _avg: 'AVG',
  _min: 'MIN',
  _max: 'MAX',
  _count: 'COUNT',
};

/**
 * How one groupBy group key is addressed from a `having` SCALAR filter: a
 * plain `by` column (compiled by the shared WHERE machinery, by field name) or
 * a JSON-path group key (its SELECT/GROUP BY extract expression, re-emitted
 * verbatim with its already-bound path placeholder).
 */
export type HavingGroupKey = { kind: 'column'; field: string } | { kind: 'expr'; expr: string; label: string };

/**
 * Build the SQL fragments for a {@link HavingClause}.
 *
 * A field entry carries an AGGREGATE filter (`{ _sum: { gt: 100 } }`), a
 * SCALAR filter on the grouped value itself (`{ not: null }`, `{ in: [...] }`,
 * or a bare value as equality shorthand), or both in one object (ANDed,
 * scalar first). `AND` / `OR` / `NOT` combine predicates at any depth.
 *
 * Each aggregate expression (`COUNT(*)`, `SUM("col")`, etc.) is constructed
 * from a **schema-validated, quoted** column identifier: `qi.toColumn()`
 * throws {@link ValidationError} for unknown fields and `qi.q()` quotes via
 * the dialect, so no unvalidated identifier ever reaches the SQL string. Every
 * comparison value is pushed onto the shared `params` array and referenced by
 * a `$N` placeholder via {@link buildHavingNumericClauses} (aggregates) or the
 * shared WHERE compiler (scalars), there is no string interpolation of user
 * values.
 *
 * `jsonAggExprs` (from {@link buildGroupBy}) maps `alias:aggKey` to the
 * exact aggregate expression a JSON-path aggregate emitted in SELECT
 * (including its already-bound path placeholder), so HAVING on a JSON-path
 * aggregate alias reuses the same expression instead of resolving the alias
 * as a column. `groupKeys` is the resolved `by` key set (see
 * {@link HavingGroupKey}): a scalar filter is legal ONLY on a group key,
 * because a non-grouped column cannot be referenced in HAVING at all.
 */
export function buildHavingClauses<T extends object>(
  qi: BuilderCtx,
  having: HavingClause<T>,
  params: unknown[],
  jsonAggExprs?: Map<string, string>,
  groupKeys?: Map<string, HavingGroupKey>,
  depth = 0,
): string[] {
  assertWhereDepth(depth, 'having');
  const clauses: string[] = [];

  for (const [key, value] of Object.entries(having)) {
    if (value === undefined) continue;

    // Top-level `_count` (no field) → COUNT(*) for the whole group.
    if (key === '_count') {
      clauses.push(...buildHavingNumericClauses(qi, 'COUNT(*)', value, params));
      continue;
    }

    // AND / OR / NOT, mixing scalar and aggregate predicates at any depth.
    if (key === 'AND' || key === 'OR' || key === 'NOT') {
      clauses.push(...buildHavingCombinator(qi, key, value, params, jsonAggExprs, groupKeys, depth));
      continue;
    }

    // Otherwise `key` is a field name. Split its aggregate keys from its
    // scalar operator keys: everything the fixed aggregate map does not name
    // filters the grouped value itself.
    const { aggEntries, scalarFilter } = splitHavingField(qi, key, value);

    if (scalarFilter !== undefined) {
      clauses.push(...buildHavingScalarClauses(qi, key, scalarFilter, params, groupKeys));
    }

    if (aggEntries.length === 0) continue;

    // toColumn validates the field against schema metadata (throws
    // ValidationError on unknown columns) and q() quotes the identifier, no
    // unvalidated identifier ever reaches the SQL string. Resolution is lazy:
    // a JSON-path aggregate alias is not a column, so it must not hit
    // toColumn when every aggregate under it resolves via `jsonAggExprs`.
    let quotedCol: string | null = null;
    const columnExpr = (): string => {
      quotedCol ??= qi.q(qi.toColumn(key));
      return quotedCol;
    };

    for (const agg of aggEntries) {
      const expr = jsonAggExprs?.get(`${key}:${agg.key}`) ?? `${agg.fn}(${columnExpr()})`;
      clauses.push(...buildHavingNumericClauses(qi, expr, agg.filter, params));
    }
  }

  return clauses;
}

/**
 * Partition one `having` field entry into its aggregate filters and its scalar
 * filter. A non-object value (or an object naming no aggregate key) is scalar
 * in full, so the whole value keeps its original shape (operator object, JSON
 * filter, bare value, `null`). An unknown UNDERSCORE-prefixed key is a
 * misspelled aggregate, not a scalar operator, and throws E003 naming it.
 */
function splitHavingField(
  qi: BuilderCtx,
  field: string,
  value: unknown,
): { aggEntries: { key: string; fn: string; filter: unknown }[]; scalarFilter: unknown } {
  if (!isUnmatchedPlainObject(value)) return { aggEntries: [], scalarFilter: value };

  const aggEntries: { key: string; fn: string; filter: unknown }[] = [];
  const scalarKeys: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue;
    // ownLookup, not a bare index: an inherited Object.prototype member
    // ("constructor", "toString", …) would otherwise resolve to a truthy
    // builtin and be spliced into the HAVING clause as its source text.
    const fn = ownLookup(HAVING_AGGREGATE_FNS, k);
    if (fn) {
      aggEntries.push({ key: k, fn, filter: v });
    } else if (k.startsWith('_')) {
      throw new ValidationError(
        `Unknown aggregate "${k}" in having for field "${field}" on table "${qi.table}". ` +
          `Supported: ${Object.keys(HAVING_AGGREGATE_FNS).join(', ')}.`,
      );
    } else {
      scalarKeys[k] = v;
    }
  }

  if (aggEntries.length === 0) return { aggEntries, scalarFilter: value };
  return { aggEntries, scalarFilter: Object.keys(scalarKeys).length > 0 ? scalarKeys : undefined };
}

/**
 * Compile a `having` AND / OR / NOT branch. Each condition is a nested
 * {@link HavingClause}; its own clauses are ANDed (parenthesized when there is
 * more than one) before being combined. `AND` contributes its parts directly
 * (the caller ANDs them), mirroring {@link buildWhereClause}'s combinator
 * shapes so HAVING and WHERE read the same way.
 */
function buildHavingCombinator<T extends object>(
  qi: BuilderCtx,
  key: 'AND' | 'OR' | 'NOT',
  value: unknown,
  params: unknown[],
  jsonAggExprs?: Map<string, string>,
  groupKeys?: Map<string, HavingGroupKey>,
  depth = 0,
): string[] {
  const conditions = Array.isArray(value) ? value : [value];
  // Same variable-arity shape as the WHERE combinators: an ARRAY branch writes
  // one parenthesized condition per element into the SQL text, so a
  // caller-sized `having.OR` is a new statement per length.
  //
  // DEFENSIVE, not load-bearing, today: `buildGroupBy` and `buildAggregate`
  // assemble their SQL directly and never go through `acquireSql`, so they
  // carry no prepared-statement name for the mark to clear (asserted in
  // prepared-statement-arity.test.ts). It is marked anyway so that routing
  // them through the cache later cannot silently reopen the hole, and so the
  // rule reads the same in both clause compilers. The DEPTH cap above is the
  // half of this that bites here and now.
  if (Array.isArray(value) && key !== 'NOT') qi.markVariableArity();
  const parts: string[] = [];
  for (const condition of conditions) {
    if (!isUnmatchedPlainObject(condition)) {
      throw new ValidationError(
        `Invalid having "${key}" on table "${qi.table}": expected ` +
          `${key === 'OR' ? 'an array of having objects' : 'a having object (or an array of them)'}.`,
      );
    }
    const sub = buildHavingClauses(qi, condition as HavingClause<T>, params, jsonAggExprs, groupKeys, depth + 1);
    if (sub.length === 0) continue;
    parts.push(sub.length === 1 ? sub[0]! : `(${sub.join(' AND ')})`);
  }
  if (parts.length === 0) return [];
  if (key === 'AND') return parts;
  if (key === 'OR') return [`(${parts.join(' OR ')})`];
  return [`NOT (${parts.join(' AND ')})`];
}

/**
 * Compile a SCALAR `having` filter: a predicate on the GROUPED value itself,
 * as Prisma's groupBy allows (`having: { typeId: { not: null } }` →
 * `HAVING "type_id" IS NOT NULL`).
 *
 * Placement is always HAVING, never WHERE. For a group key the two are
 * result-equivalent (the value is constant within the group), but a scalar
 * predicate ORed with an aggregate one is only expressible in HAVING, so one
 * placement covers every shape and matches Prisma's emitted SQL.
 *
 * The field MUST be one of the `by` group keys: a predicate on any other
 * column cannot appear in HAVING (Postgres answers "column must appear in the
 * GROUP BY clause"), so it throws {@link ValidationError} E003 pointing at
 * `where` / `by` / an aggregate filter instead of emitting invalid SQL.
 *
 * A plain by-column routes through the shared WHERE compiler
 * ({@link whereMod.buildScalarClause}), so the operator set, enum casts, LIKE
 * escaping, `mode: 'insensitive'`, and the dialect IN-clause form are
 * inherited rather than reimplemented. A JSON-path group key compiles against
 * its re-emitted extract expression.
 */
function buildHavingScalarClauses(
  qi: BuilderCtx,
  field: string,
  value: unknown,
  params: unknown[],
  groupKeys: Map<string, HavingGroupKey> | undefined,
): string[] {
  const ref = groupKeys ? lookupGroupKey(qi, groupKeys, field) : undefined;
  if (!ref) {
    const known = groupKeys ? [...groupKeys.keys()] : [];
    throw new ValidationError(
      `having on "${field}" (table "${qi.table}") filters the grouped value itself, but ` +
        `"${field}" is not one of the \`by\` group keys [${known.join(', ') || 'none'}]. A predicate on a ` +
        'non-grouped column cannot go in HAVING: move it to `where` (it filters rows, not groups), add ' +
        `"${field}" to \`by\`, or filter an aggregate of it instead (e.g. { ${field}: { _count: { gt: 0 } } }).`,
    );
  }

  const clauses: string[] = [];
  if (ref.kind === 'column') {
    whereMod.buildScalarClause(qi, ref.field, value, params, clauses);
    return clauses;
  }

  // JSON-path group key: the extract expression IS the group key, so it can
  // carry a predicate in HAVING. It is not a column, so the column-typed
  // surface (enum casts, temporal rewrites, column references) does not apply.
  if (value === null) {
    clauses.push(`${ref.expr} IS NULL`);
  } else if (isWhereOperator(value)) {
    clauses.push(...whereMod.buildOperatorClauses(qi, ref.expr, value, params));
  } else if (isUnmatchedPlainObject(value)) {
    throw new ValidationError(
      `Unknown operator${Object.keys(value as object).length > 1 ? 's' : ''} ` +
        `${Object.keys(value as object)
          .map((k) => `"${k}"`)
          .join(', ')} on ${ref.label} in having for table "${qi.table}".`,
    );
  } else {
    params.push(value);
    clauses.push(`${ref.expr} = ${qi.p(params.length)}`);
  }
  return clauses;
}

/**
 * Convert a single having aggregate filter into one or more parameterized SQL
 * comparisons against the given aggregate expression. A bare value is
 * shorthand for equality. Operands are not numeric-only: `_min` / `_max`
 * return a stored cell, so `MIN("title") > 'm'` is as valid as
 * `SUM("views") > 10`. Unknown operator keys throw {@link ValidationError}.
 */
export function buildHavingNumericClauses(qi: BuilderCtx, expr: string, filter: unknown, params: unknown[]): string[] {
  if (filter === null) {
    throw new ValidationError(
      `Invalid having filter on "${expr}" for table "${qi.table}": expected a value or operator object.`,
    );
  }

  // Bare value (number, string, boolean, Date, …) → equality.
  if (typeof filter !== 'object' || filter instanceof Date) {
    params.push(filter);
    return [`${expr} = ${qi.p(params.length)}`];
  }

  const op = filter as HavingComparisonOperator<unknown>;
  const allowedKeys = new Set(['equals', 'not', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn']);
  for (const k of Object.keys(op)) {
    if (!allowedKeys.has(k)) {
      throw new ValidationError(
        `Unknown having operator "${k}" on "${expr}" for table "${qi.table}". ` +
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

/**
 * `_min` / `_max` over a TEMPORAL column, aligned with the row parser.
 *
 * These two are the only aggregates that hand back a row's stored cell rather
 * than something computed across rows, so they are the only ones that can carry
 * a Postgres `infinity`. They are assembled from the RAW row (a Date must stay
 * a Date, and `parseRow`'s snake→camel mapping would collide with the `_min_`
 * alias), so the infinity mapping has to be applied here too. Without it
 * `aggregate({ _max: { ts: true } })` would return the driver's `Infinity`
 * while `findMany` returned `null` for the very same value.
 *
 * Gated on the column being temporal, so a numeric `_max` is untouched, and on
 * the client's `temporalInfinity` reading, so it cannot disagree with the rows
 * `findMany` returns for the same column. An absent reading resolves to the
 * default, `'preserve'`, exactly as it does in the row parser.
 *
 * Note what the opt-in `'null'` reading then means for `_max` on a table that
 * plainly has rows: `null` is the same value an empty table and an all-NULL
 * column return, so `_min` can report a real date while `_max` reports
 * "nothing" (documented, and one of the reasons `'null'` is not the default).
 */
function temporalAggValue(qi: BuilderCtx, col: string, value: unknown): unknown {
  if (!qi.tableMeta.dateColumns.has(col)) return value;
  if (isTemporalInfinity(value)) {
    if (qi.temporalInfinity === 'null') return null;
    if (typeof value === 'number') return value;
    return value === '-infinity' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }
  // A STRING on a temporal column means the driver handed the value back
  // untyped, which is what every engine without pg's OID-keyed type parsers
  // does. Verified on SQLite: `findMany` returned a `Date` for `at` and
  // `groupBy` returned a `Date` for the same column used as a group key, while
  // `aggregate({ _max: { at: true } })` returned the raw string
  // '2024-01-15 12:00:00', so ONE column disagreed with itself across three
  // read paths and with the `Date` the generated types promise. `_min`/`_max`
  // are assembled from the RAW row here (they cannot go through `parseRow`,
  // whose snake→camel mapping would collide with the `_min_` alias), so the
  // coercion `parseRow` applies has to be applied here as well, on the same
  // terms: offset-less text is pinned to UTC unless `utcTimestamps: false`.
  //
  // On PostgreSQL this branch is unreachable and the emitted values are
  // unchanged: the driver's date/timestamp parsers already produce a `Date`.
  if (typeof value === 'string') return qi.utcTimestamps !== false ? parseDbDate(value) : new Date(value);
  return value;
}

/**
 * Whether `SUM` / `AVG` over a column of `pgType` is EXACT on the wire and must
 * not be narrowed to a JS number.
 *
 * PostgreSQL widens both past their input: over int8 they are `numeric`, over
 * numeric they stay `numeric`. (An int2 / int4 sum is int8 and its average
 * `numeric` too, but those totals fit a double, which is the line this draws.)
 * The driver delivers `numeric` as its exact text, because no parser is
 * registered for it, deliberately: the type is arbitrary-precision. `Number()`
 * over that text rounded a `SUM(int8)` of 461168601842738790350 to
 * 461168601842738800000 and a numeric(12,2) total of 1020.50 to 1020.5, while
 * `_min` / `_max` on the very same columns came back exact, because they hand
 * the driver's value through untouched.
 *
 * So for these source types the aggregate is returned as the driver delivered
 * it (on PostgreSQL the text, a string; an engine whose driver already hands
 * back a number keeps that number) and `_avg` is not cast to float in SQL,
 * which would otherwise round on the server before the value reached the
 * wire. Every other type keeps `Number()` and the cast. Spelled for every
 * engine's type names: the PostgreSQL `udt_name` (`int8`, `numeric`) and the
 * SQL names the other dialects report (`bigint`, `decimal`), with case and any
 * `(precision, scale)` suffix ignored. JSON-path aggregates never reach this:
 * they cast the extracted text to numeric themselves and stay numbers.
 */
function isExactNumericType(pgType: string): boolean {
  const paren = pgType.indexOf('(');
  const base = (paren === -1 ? pgType : pgType.slice(0, paren)).trim().toLowerCase();
  return base === 'int8' || base === 'bigint' || base === 'numeric' || base === 'decimal';
}

/** `AVG(col)`, float-cast unless the source column is exact (see {@link isExactNumericType}). */
function plainAvgExpr(qi: BuilderCtx, col: string): string {
  const inner = `AVG(${qi.q(col)})`;
  return isExactNumericType(whereMod.getColumnPgType(qi, col)) ? inner : qi.castAgg(inner, 'float');
}

/**
 * A `_sum` / `_avg` value over a plain column: the driver's value verbatim
 * for an exact source type (see {@link isExactNumericType}), a JS number for
 * every other, `null` for an aggregate over zero rows.
 */
function sumAvgValue(qi: BuilderCtx, col: string, value: unknown): number | string | null {
  if (value === null || value === undefined) return null;
  if (isExactNumericType(whereMod.getColumnPgType(qi, col))) return value as number | string;
  return Number(value);
}

export function buildAggregate<T extends object>(
  qi: BuilderCtx,
  args: AggregateArgs<T>,
): DeferredQuery<AggregateResult<T>> {
  qi.currentSkip = resolveSkipGlobalFilters(args.skipGlobalFilters);
  // Resolved once, up front: see buildGroupBy.
  const includePii = resolveUnsafeFlag(args.includePii, 'includePii');
  const aggWhere = whereMod.mergeGlobalFilter(qi, args.where as Record<string, unknown> | undefined);
  const { sql: whereSql, params } = aggWhere
    ? whereMod.buildWhere(qi, aggWhere as WhereClause<T>)
    : { sql: '', params: [] as unknown[] };

  const meta = qi.schema.tables[qi.table];
  // Every target is validated up front, including one whose falsy value the
  // builders below skip, and through `qi.toColumn` (the ONE
  // `resolveColumnName` rule). `key in meta.columnMap` knows only the FIELD
  // spelling, so the snake_case COLUMN name that `where` / `select` and even
  // `groupBy`'s own `_min` accepted was rejected here.
  for (const group of [args._sum, args._avg, args._min, args._max]) {
    if (group && typeof group === 'object') {
      for (const key of Object.keys(group)) qi.toColumn(key);
    }
  }
  if (args._count && typeof args._count === 'object') {
    for (const key of Object.keys(args._count)) {
      // `_all` is the reserved COUNT(*) selector, not a column.
      if (key !== '_all') qi.toColumn(key);
    }
  }

  const selectExprs: string[] = [];

  // _count. `true` → scalar COUNT(*). Record form: reserved `_all` → COUNT(*) AS
  // "_count__all" (double underscore, collision-proof against a real column named
  // `all`); each field → COUNT(col) AS "_count_<col>".
  if (args._count === true) {
    selectExprs.push(`${qi.castAgg('COUNT(*)', 'int')} AS _count`);
  } else if (args._count && typeof args._count === 'object') {
    for (const [field, enabled] of Object.entries(args._count)) {
      if (!enabled) continue;
      if (field === '_all') {
        selectExprs.push(`${qi.castAgg('COUNT(*)', 'int')} AS ${qi.q('_count__all')}`);
      } else {
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
        selectExprs.push(`${plainAvgExpr(qi, col)} AS ${qi.q(`_avg_${col}`)}`);
      }
    }
  }

  // _min / _max return a stored cell verbatim, so a PII-tagged column needs the
  // same `includePii` opt-in a row projection needs. _count / _sum / _avg do not.
  if (args._min) {
    for (const [field, enabled] of Object.entries(args._min)) {
      if (enabled) {
        const col = qi.toColumn(field);
        assertAggregatePiiOptIn(qi.table, meta, field, col, 'aggregate _min', includePii);
        selectExprs.push(`MIN(${qi.q(col)}) AS ${qi.q(`_min_${col}`)}`);
      }
    }
  }

  // _max
  if (args._max) {
    for (const [field, enabled] of Object.entries(args._max)) {
      if (enabled) {
        const col = qi.toColumn(field);
        assertAggregatePiiOptIn(qi.table, meta, field, col, 'aggregate _max', includePii);
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
        // Check for per-column counts. `_count__all` MUST be matched before the
        // generic `_count_` prefix (its slice(7) is `_all`, which snakeToCamel
        // would mangle to `All`).
        const countObj: Record<string, number> = {};
        let hasCountFields = false;
        for (const [key, val] of Object.entries(row)) {
          if (key === '_count__all') {
            countObj._all = val as number;
            hasCountFields = true;
          } else if (key.startsWith('_count_')) {
            const col = key.slice(7);
            const field = qi.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
            countObj[field] = val as number;
            hasCountFields = true;
          }
        }
        if (hasCountFields) aggResult._count = countObj;
      }

      // Build nested aggregate objects
      const sumObj: Record<string, number | string | null> = {};
      const avgObj: Record<string, number | string | null> = {};
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
          sumObj[field] = sumAvgValue(qi, col, val);
          hasSums = true;
        } else if (key.startsWith('_avg_')) {
          const col = key.slice(5);
          const field = qi.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
          avgObj[field] = sumAvgValue(qi, col, val);
          hasAvgs = true;
        } else if (key.startsWith('_min_')) {
          const col = key.slice(5);
          const field = qi.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
          minObj[field] = temporalAggValue(qi, col, val);
          hasMins = true;
        } else if (key.startsWith('_max_')) {
          const col = key.slice(5);
          const field = qi.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
          maxObj[field] = temporalAggValue(qi, col, val);
          hasMaxs = true;
        }
      }

      if (hasSums) aggResult._sum = sumObj as Partial<Record<keyof T & string, number | string | null>>;
      if (hasAvgs) aggResult._avg = avgObj as Partial<Record<keyof T & string, number | string | null>>;
      if (hasMins) aggResult._min = minObj as Partial<Record<keyof T & string, unknown>>;
      if (hasMaxs) aggResult._max = maxObj as Partial<Record<keyof T & string, unknown>>;

      return aggResult;
    },
    tag: `${qi.table}.aggregate`,
  };
}
