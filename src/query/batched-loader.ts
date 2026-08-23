/**
 * turbine-orm, Batched relation loader (the `relationLoadStrategy: 'batched'` path)
 *
 * ## Why this exists
 *
 * Turbine's default `with`-clause strategy resolves nested relations in ONE SQL
 * statement using correlated `json_agg(json_build_object(...))` subqueries, one
 * probe per parent row (see `buildRelationSubquery` in builder.ts). That is the
 * right default: a single round-trip, and when the child FK columns are indexed
 * each probe is an index seek. But it degrades in two situations:
 *
 *   1. **Missing FK index**, a correlated probe per parent row becomes
 *      N-parents × full-table-scan. A batched-loader ORM pays that missing index
 *      only ONCE (a single `WHERE fk = ANY($1)` seq-scan), which is why schemas
 *      migrated from those ORMs often lack the index the json_agg path needs.
 *   2. **Huge unpaginated result sets**, the JSON wire format
 *      (`json_build_object` per row, re-serialized inside `json_agg`) is heavy to
 *      encode/decode compared with flat rows.
 *
 * This module implements the alternative, opt-in strategy: run the base query
 * WITHOUT relation subqueries, collect the parent keys, then issue ONE flat
 * follow-up query per relation (`SELECT ... FROM child WHERE fk = ANY($1)`),
 * and stitch the children onto the parents in memory. D relation levels cost D
 * extra round-trips instead of one, but each is a single indexed lookup over a
 * key set, and rows come back flat.
 *
 * ## Design constraints (see CLAUDE.md)
 *
 *   - **Same executor / connection path.** Every follow-up query runs through the
 *     caller's own executor ({@link RelationLoadContext.exec}) and child query
 *     interfaces built on the caller's pool. Inside a `$transaction` that pool is
 *     the pinned-connection `txPool`, so batched loads join the transaction, no
 *     separate pool checkout per query.
 *   - **Identical output shape.** The stitched result is byte-for-byte the same
 *     shape the join strategy produces: relation arrays for hasMany/manyToMany
 *     (`[]` when empty), single-or-null for hasOne/belongsTo, with the same
 *     camelCase keys and Date coercion, because the child rows are parsed by the
 *     very same `parseRow`/`buildFindMany` machinery via a child QueryInterface.
 *   - **Identical KEY ORDER.** Object key order is observable output: callers
 *     `JSON.stringify` results into HTTP bodies, ETags and cache keys. The
 *     follow-up queries run concurrently, so the completion order of two sibling
 *     relations is a race; every relation key (and every `_count` entry) is
 *     therefore SEEDED up front in the order the join plan emits it, and the
 *     concurrent loads only overwrite already-existing keys. See
 *     {@link seedRelationKeys}.
 *   - **Stitch keys never leak.** To stitch, the follow-up query must select the
 *     FK/PK it joins on even when the caller's `select`/`omit` excluded it; the
 *     loader adds those columns for the query and strips them from the returned
 *     entities afterwards ({@link includeKeysForBatching}).
 *
 * PowDB (powql.ts) has its own batched loaders for the same reasons, this is the
 * clean Postgres/SQL implementation, deliberately NOT shared with PowQL.
 *
 * @module
 */

import type { PartitionLimitInput } from '../dialect.js';
import { CircularRelationError, RelationError, UnsupportedFeatureError, ValidationError } from '../errors.js';
import type { PgCompatQueryResult } from '../pg-types.js';
import { normalizeKeyColumns, type RelationDef, type SchemaMetadata, type TableMetadata } from '../schema.js';
import type { ReselectExecutor } from './builder.js';
import { dedupeOrderEntries, isOrderBySpec, isRelationPickOrderBy, orderByEntries, sortedEntries } from './filters.js';
import type { SkipGlobalFilters, Unsafe, WithClause, WithCount, WithOptions } from './types.js';
import {
  availableClause,
  type ColumnNameSource,
  markInternalCombinator,
  ownLookup,
  resolveColumnName,
  selectNamesNothingMessage,
  selectOmitExclusiveMessage,
  sqlToPreparedName,
} from './utils.js';

/**
 * Max parent keys per follow-up query. On Postgres the whole key set travels as
 * ONE array parameter (`= ANY($1)`), so this is not a bind-parameter limit, it
 * only bounds planner/memory cost per statement. Keep it large: every extra
 * chunk is an extra network round-trip, and round-trips are exactly what the
 * batched strategy exists to minimize (a 9-chunk load was measured 2× slower
 * than a single-statement one over a WAN link).
 */
const MAX_RELATION_KEYS = 32_000;

/** Nesting cap, parity with the join strategy's depth-10 guard. */
const MAX_DEPTH = 10;

/**
 * A DeferredQuery, minimally typed for what the loader consumes. Kept local to
 * avoid a value import of builder.ts (which imports this module).
 */
interface Deferred {
  sql: string;
  params: unknown[];
  preparedName?: string;
  transform: (result: PgCompatQueryResult) => unknown;
}

/**
 * The read surface the loader needs from a child QueryInterface: build (but do
 * not execute) a flat findMany. The loader runs the built SQL through
 * {@link RelationLoadContext.exec}, so execution stays on the caller's connection.
 */
export interface BatchedChildReader {
  buildFindMany(args: Record<string, unknown>): Deferred;
}

/**
 * Everything the loader needs from the owning QueryInterface, passed as closures
 * so this module never imports builder.ts at runtime (it is imported BY it).
 */
export interface RelationLoadContext {
  /** Metadata of the table whose rows are the current `parents`. */
  parentMeta: TableMetadata;
  schema: SchemaMetadata;
  /** Build a child reader for `table`, bound to the caller's pool (tx-safe). */
  makeChild: (table: string) => BatchedChildReader;
  /** Run raw SQL through the caller's executor (same timeout/instrumentation path). */
  exec: ReselectExecutor;
  /** Quote an identifier via the active dialect. */
  quote: (name: string) => string;
  /** Build an `IN`/`ANY` predicate via the active dialect (PG: `expr = ANY($n)`). */
  buildInClause: (expr: string, paramRef: string, negated: boolean) => string;
  /** The single bound value for an `IN` list (PG: the array as-is). */
  inClauseParam: (values: unknown[]) => unknown;
  /** Placeholder for a 1-indexed parameter position (PG: `$n`). */
  paramPlaceholder: (index: number) => string;
  /**
   * The query's `skipGlobalFilters` opt-out, threaded onto every child
   * `buildFindMany` so relation row loads honor (or skip) the target table's
   * global filter exactly as the join strategy would.
   */
  skipGlobalFilters?: SkipGlobalFilters;
  /**
   * The query's `includePii` opt-in, threaded onto every child `buildFindMany`
   * so a batched relation load excludes (or includes) PII-tagged columns exactly
   * as the join strategy does at every nested level. Absent by default.
   *
   * Typed as the SENTINEL, not a boolean, and that is a contract not a style
   * choice: this value is copied verbatim onto child `FindManyArgs`, where a
   * plain `true` is refused as a privilege escalation. A boolean here would
   * type-check and then throw on the first relation follow-up.
   */
  includePii?: Unsafe;
  /**
   * Render `table`'s global filter against `alias` for a raw follow-up query
   * (the batched `_count`), numbering its `$n` placeholders AFTER
   * `precedingParams` already-bound params. Returns `null` when no filter
   * applies. Provided by the owning QueryInterface so this module needs no
   * filter machinery of its own.
   */
  tableGlobalFilter?: (
    table: string,
    alias: string,
    precedingParams: number,
  ) => { clause: string; params: unknown[] } | null;
  /**
   * The active dialect's {@link Dialect.buildPartitionLimit}, when it has one.
   * Absent means this engine cannot bound the follow-up per correlation key, so
   * the loader falls back to fetching every child and slicing client-side. The
   * same fallback runs, on every engine, for a relation whose ordering does not
   * force which rows the limit keeps. See {@link partitionOrderBy} and
   * {@link boundedChildQuery}.
   */
  buildPartitionLimit?: (input: PartitionLimitInput) => string;
}

/**
 * Column the {@link Dialect.buildPartitionLimit} wrapper adds to carry the
 * per-key row number. It is part of that statement's projection, so the loader
 * removes it from every raw row before the child's own transform parses them,
 * or it would surface as an extra field on every entity and break output
 * equality with the join strategy.
 */
const PARTITION_RANK_COLUMN = '__turbine_rn';

/**
 * The relation `orderBy` expressed as plain column/direction/nulls triples for
 * the window, or `null` when this pushdown cannot PROVE it would pick the same
 * rows the join plan picks. `null` sends the whole relation back to the
 * client-side slice, which is what every engine without the dialect hook does.
 *
 * ## Only a TOTAL order is eligible, and that is not a conservatism
 *
 * The join plan runs one correlated `… WHERE fk = parent ORDER BY … LIMIT n`
 * per parent; the pushdown runs one flat statement over every parent and ranks
 * with `ROW_NUMBER()`. When the ordering leaves TIES, "the first n" is not a
 * defined set, so the two plans are each free to return different tied rows,
 * and measured on PostgreSQL 16 (5 parents, 32 children, ties and NULLs on the
 * sort column, `limit: 2`) they do:
 *
 *   relation shape                         old (client slice) == join   window == join
 *   `orderBy: { sortKey: 'asc' }` w/ ties                        N                  N
 *   no `orderBy`                                                 Y                  N
 *   `{ sortKey: { sort:'asc', nulls:'first' } }`                 N                  N
 *   `orderBy: [{ sortKey }, { id }]` (total)                     Y                  Y
 *
 * So the rule is not "the window is wrong", it is that WITHOUT A TOTAL ORDER
 * neither implementation can be right, and the only shape where the pushdown
 * demonstrably regressed something that used to hold is the unordered one. The
 * bound is only taken where the answer is forced: the resolved column list must
 * cover a NOT NULL unique key of the target (see {@link totallyOrdered}), which
 * makes "the n smallest keys per parent" a single set in a single order that
 * both plans must return. Everything else keeps the pre-existing behaviour
 * rather than a silently different row set, because a wrong answer is worse
 * than a slower query.
 *
 * A caller who wants the bound on an unordered relation has an existing,
 * plan-symmetric way to ask for it: `stableRelationOrder` fills a primary-key
 * ascending order into every to-many relation that declares none, on the join
 * plan and the batched plan alike, which makes the shape totally ordered and
 * therefore eligible here.
 *
 * ## What else disqualifies a shape
 *
 * Only the plain direction and {@link OrderBySpec} forms are accepted. A
 * JSON-path, vector-distance, relation `_count` or pick-row ordering compiles
 * to an expression (sometimes with its own bound params) that the loader cannot
 * re-emit here. Same for a key that names no column: the child query build is
 * what reports that, with the proper E003, so this must not throw its own error
 * first.
 *
 * The entry list is DEDUPED first, with the same rule and the same metadata the
 * inner statement's own `orderBy` goes through (the follow-up is compiled as a
 * top-level `findMany` on the child table, which dedupes). Reading the RAW args
 * here made the wrapper's text vary while the statement it wraps did not, which
 * is a correctness divergence (`[{a:'asc'},{a:'desc'}]` sorts by `a ASC` inside
 * and would have ranked by `a ASC, a DESC` outside) and, because the wrapper is
 * named after its own text, an unbounded set of server-side prepared
 * statements: measured, 25 requests that were semantically one sort key left 26
 * named statements on one connection.
 */
function partitionOrderBy(
  meta: TableMetadata,
  orderBy: unknown,
): { column: string; direction: 'ASC' | 'DESC'; nulls?: 'FIRST' | 'LAST' }[] | null {
  // A child column spelled like the wrapper's rank alias would make the outer
  // `WHERE … <= $n` reference ambiguous (Postgres 42702) and the strip below
  // would delete a real value. It fails closed, but with a raw driver error
  // carrying no TURBINE_ code, on a query the join plan serves fine, so the
  // relation declines the pushdown instead.
  if (meta.allColumns.includes(PARTITION_RANK_COLUMN)) return null;
  const raw = orderByEntries(orderBy);
  // `meta.name` is the table the child statement is compiled against, so a
  // direction this refuses on a dropped term reads exactly as it does when the
  // child's own compile path refuses it a few lines later.
  const entries = dedupeOrderEntries(meta, raw, meta.name)?.entries ?? raw;
  // No ordering at all is the extreme case of the tie rule above: an unordered
  // window numbers each partition arbitrarily and the join plan's ORDER-BY-less
  // `LIMIT` takes arbitrary rows, and those arbitrary choices are made by
  // different plans over different row sets.
  if (entries.length === 0) return null;
  const out: { column: string; direction: 'ASC' | 'DESC'; nulls?: 'FIRST' | 'LAST' }[] = [];
  for (const [key, value] of entries) {
    // The one key-resolution rule. A bare `columnMap` read knows only the
    // FIELD spelling, so a snake-spelled orderBy declined the partition
    // pushdown and silently fell back to fetching every child row and slicing
    // client-side: two strategies, different bytes over the wire, one query.
    const column = resolveColumnName(meta, key);
    if (column === undefined) return null;
    let sort: unknown;
    let nulls: 'FIRST' | 'LAST' | undefined;
    if (isOrderBySpec(value)) {
      // EXACTLY `{ sort, nulls? }` and nothing else. `isOrderBySpec` only tests
      // for a `sort` key, and a JSON-path ordering can carry one too
      // (`{ path: ['a'], sort: 'asc' }`), which would be read here as a plain
      // column ordering and rank by the wrong expression. Anything with a key
      // outside the pair falls back to the client-side slice.
      for (const k of Object.keys(value)) if (k !== 'sort' && k !== 'nulls') return null;
      sort = value.sort;
      if (value.nulls === 'first') nulls = 'FIRST';
      else if (value.nulls === 'last') nulls = 'LAST';
      else if (value.nulls !== undefined) return null;
    } else if (typeof value === 'object' && value !== null) {
      // Relation `_count` / pick-row / vector orderings are objects too.
      return null;
    } else {
      sort = value;
    }
    if (sort !== 'asc' && sort !== 'desc') return null;
    out.push({ column, direction: sort === 'asc' ? 'ASC' : 'DESC', nulls });
  }
  return totallyOrdered(
    meta,
    out.map((o) => o.column),
  )
    ? out
    : null;
}

/**
 * True when sorting by `columns` can leave no two rows of `meta` tied: the list
 * covers every column of the primary key, or of some unique constraint, and
 * every column of that key is NOT NULL.
 *
 * The NOT NULL half is not decoration. A UNIQUE constraint over a nullable
 * column admits any number of NULL rows in PostgreSQL (they are all distinct to
 * the constraint and all equal to a sort), so such a key orders the non-null
 * rows and leaves the NULL ones tied with each other, which is exactly the
 * shape this rule exists to refuse. Primary-key columns are NOT NULL by
 * definition, and are checked anyway: metadata that says otherwise is metadata
 * this proof cannot rest on, and declining costs a bound rather than an answer.
 */
function totallyOrdered(meta: TableMetadata, columns: string[]): boolean {
  const sorted = new Set(columns);
  const nonNullable = (column: string): boolean => meta.columns.some((c) => c.name === column && c.nullable === false);
  const covered = (key: readonly string[] | undefined): boolean =>
    key !== undefined && key.length > 0 && key.every((c) => sorted.has(c) && nonNullable(c));
  return covered(meta.primaryKey) || (meta.uniqueColumns ?? []).some(covered);
}

/**
 * The default projection of `meta` expressed in FIELD names: which fields the
 * default (no `select`/`omit`) projection hides, and which it returns. Today the
 * only hidden class is PII-tagged columns, and only when `includePii` is off.
 *
 * Returns `undefined` for the overwhelmingly common untagged case, so callers
 * keep the `select: undefined, omit: undefined` fast path and the emitted SQL
 * stays byte-identical.
 */
export function defaultProjectionFields(
  meta: TableMetadata,
  // Either the already-resolved boolean (top-level callers) or the raw sentinel
  // (the relation-load context); both are only ever tested for truthiness.
  includePii: boolean | Unsafe | undefined,
): { hidden: ReadonlySet<string>; visible: string[] } | undefined {
  if (includePii) return undefined;
  const hidden = new Set<string>();
  const visible: string[] = [];
  for (const col of meta.columns) {
    const field = meta.reverseColumnMap[col.name] ?? col.name;
    if (col.pii) hidden.add(field);
    else visible.push(field);
  }
  return hidden.size === 0 ? undefined : { hidden, visible };
}

/**
 * Adjust a `select`/`omit` pair so that `fields` are guaranteed present in the
 * query result, returning the adjusted projection plus the list of fields that
 * were added ONLY for stitching and must be stripped from the final entities.
 *
 * Used both for the base query (parent keys) and each follow-up query (child
 * keys) so a caller's `select: { title: true }` on a relation still stitches even
 * though the FK was not requested, and the FK never appears in the output.
 */
/**
 * The two projection SHAPE rules from `resolveProjection`, checked on the RAW
 * caller args BEFORE `includeKeysForBatching` adjusts them. The adjustment
 * force-adds correlation keys to a `select`, so a shape that is invalid as
 * written (an all-falsy select, or select + omit together) can look valid
 * after it, and the batched plan would then accept a query the join plan
 * refuses, with 'auto' picking between them on data. Same messages as the
 * resolver so the two strategies refuse identically, word for word.
 */
export function assertProjectionShape(
  table: string,
  select: Record<string, boolean> | undefined,
  omit: Record<string, boolean> | undefined,
): void {
  // Array shapes fall through: buildFindMany's resolver has their specific
  // "must be an object" messages, and compiling is where they surface.
  if (!select || Array.isArray(select)) return;
  if (!Object.values(select).some(Boolean)) {
    throw new ValidationError(selectNamesNothingMessage(table));
  }
  if (omit && !Array.isArray(omit) && Object.values(omit).some(Boolean)) {
    throw new ValidationError(selectOmitExclusiveMessage(table));
  }
}

export function includeKeysForBatching(
  /**
   * The table the projection is compiled against. `select` / `omit` keys are
   * the CALLER's, and a column has two legal spellings there, so matching by
   * raw key made "is the correlation key already projected?" depend on which
   * was used: `select: { user_id: true }` with a `userId` key looked
   * unprojected, so the key was force-added AND marked stitch-only and
   * `stripFields` deleted the very column the caller asked for, while
   * `omit: { user_id: true }` failed to un-omit and tripped
   * `assertCorrelationKeyProjected`'s "bug in turbine" path on a legal query.
   */
  meta: ColumnNameSource,
  select: Record<string, boolean> | undefined,
  omit: Record<string, boolean> | undefined,
  fields: string[],
  /**
   * The default projection for this table when it is NOT `select`/`omit`-driven:
   * `hidden` are fields the default projection leaves out (today: PII-tagged
   * columns without `includePii`), `visible` is everything it does return.
   *
   * Without this, a correlation key that is itself PII-tagged is absent from
   * every row, the loader sees no keys, and it silently hands back empty
   * relation arrays. Passing it turns that case into an explicit select that
   * re-adds only the key, which is then stripped like any other stitch-only
   * field, so no PII value ever reaches the caller.
   */
  defaultProjection?: { hidden: ReadonlySet<string>; visible: string[] },
): { select?: Record<string, boolean>; omit?: Record<string, boolean>; strip: string[] } {
  const unique = [...new Set(fields)];
  /**
   * The caller's projection keys indexed by the column each resolves to, so a
   * correlation key is recognized under either spelling. A key resolving to no
   * column is left out: the projection build raises E003, where it belongs.
   */
  const keyByColumn = (projection: Record<string, boolean>): Map<string, string> => {
    const byColumn = new Map<string, string>();
    for (const key of Object.keys(projection)) {
      const column = resolveColumnName(meta, key);
      if (column !== undefined) byColumn.set(column, key);
    }
    return byColumn;
  };
  /** `fields` are canonical field names, but resolve them anyway rather than assume. */
  const columnOf = (field: string): string => resolveColumnName(meta, field) ?? field;
  if (select) {
    const next = { ...select };
    const strip: string[] = [];
    const selected = keyByColumn(select);
    for (const f of unique) {
      const existing = selected.get(columnOf(f));
      if (existing !== undefined && next[existing]) continue; // already projected, under either spelling
      next[f] = true;
      strip.push(f); // not requested by the caller, added only to stitch
    }
    return { select: next, omit, strip };
  }
  if (omit) {
    const next = { ...omit };
    const strip: string[] = [];
    const omitted = keyByColumn(omit);
    for (const f of unique) {
      const existing = omitted.get(columnOf(f));
      if (existing !== undefined && next[existing]) {
        delete next[existing]; // un-omit so the key is present; the caller wanted it gone
        strip.push(f);
      }
    }
    return { select, omit: next, strip };
  }
  // Neither select nor omit. Every column the DEFAULT projection returns is
  // already present, so normally there is nothing to strip; the exception is a
  // key the default projection hides (a PII-tagged correlation column), which
  // has to be asked for explicitly.
  const hiddenKeys = defaultProjection ? unique.filter((f) => defaultProjection.hidden.has(f)) : [];
  if (hiddenKeys.length > 0 && defaultProjection) {
    const explicit: Record<string, boolean> = {};
    for (const f of defaultProjection.visible) explicit[f] = true;
    for (const f of hiddenKeys) explicit[f] = true;
    return { select: explicit, omit: undefined, strip: hiddenKeys };
  }
  return { select, omit, strip: [] };
}

/** Delete stitch-only key fields from each row (no-op when `fields` is empty). */
export function stripFields(rows: Record<string, unknown>[], fields: string[]): void {
  if (fields.length === 0) return;
  for (const row of rows) {
    for (const f of fields) delete row[f];
  }
}

/**
 * The set of parent FIELD names a batched load of `withClause` needs present on
 * each parent row in order to stitch (the local key of every requested relation).
 * The caller adds these to the base query and strips the added ones afterwards.
 */
export function neededParentKeyFields(parentMeta: TableMetadata, withClause: WithClause): string[] {
  const fields = new Set<string>();
  for (const [relName, spec] of Object.entries(withClause)) {
    if (!spec) continue;
    // `_count` needs each counted relation's parent-side key to stitch counts.
    if (relName === '_count') {
      for (const rel of resolveCountRelations(parentMeta, spec as unknown as WithCount)) {
        for (const col of localKeyColumns(rel)) fields.add(parentMeta.reverseColumnMap[col] ?? col);
      }
      continue;
    }
    const rel = ownLookup(parentMeta.relations, relName);
    if (!rel) continue; // unknown relation, the join path throws; let the loader surface it
    for (const col of localKeyColumns(rel)) {
      fields.add(parentMeta.reverseColumnMap[col] ?? col);
    }
  }
  return [...fields];
}

/**
 * The parent-side key column(s) used to correlate a relation:
 *   - hasMany / hasOne:  the parent's `referenceKey` (child's FK points at it)
 *   - belongsTo:         the parent's `foreignKey`   (points at the child's PK)
 *   - manyToMany:        the parent's `referenceKey` (junction's sourceKey → it)
 */
function localKeyColumns(rel: RelationDef): string[] {
  if (rel.type === 'belongsTo') return normalizeKeyColumns(rel.foreignKey);
  return normalizeKeyColumns(rel.referenceKey);
}

/**
 * Resolve the set of to-many relations a `_count` spec selects. `true` counts
 * every to-many relation (hasMany + manyToMany) of the table; the record form
 * counts only the enabled names. Shared by the join builder and the batched
 * loader so both count the exact same relations.
 *
 * Errors: E005 ({@link RelationError}) for an unknown relation name, E003
 * ({@link ValidationError}) when a named relation is to-one.
 */
export function resolveCountRelations(parentMeta: TableMetadata, countSpec: WithCount): RelationDef[] {
  const isToMany = (r: RelationDef): boolean => r.type === 'hasMany' || r.type === 'manyToMany';
  if (countSpec === true) {
    return Object.values(parentMeta.relations).filter(isToMany);
  }
  const out: RelationDef[] = [];
  for (const [relName, enabled] of Object.entries(countSpec)) {
    if (!enabled) continue;
    const rel = ownLookup(parentMeta.relations, relName);
    if (!rel) {
      throw new RelationError(
        `Unknown relation "${relName}" in _count on table "${parentMeta.name}". ` +
          availableClause(Object.keys(parentMeta.relations), 'It has no relations.'),
      );
    }
    if (!isToMany(rel)) {
      throw new ValidationError(
        `_count is only supported for to-many relations; "${relName}" on ` +
          `"${parentMeta.name}" is a to-one relation.`,
      );
    }
    out.push(rel);
  }
  return out;
}

/** Stringified stitch key, robust to number/uuid/bigint type drift across a join. */
function keyOf(value: unknown): string {
  return String(value);
}

/**
 * Reject pick-row relation ordering anywhere inside a `with` tree's orderBy -
 * strategy parity with the join path, which throws this exact E003 at SQL
 * build time (`pickOrderNestedError` in builder.ts). Without this guard the
 * loaders would forward `options.orderBy` as the child reader's TOP-LEVEL
 * findMany orderBy, where the pick shape compiles fine, so the same query
 * would execute on 'batched' but throw on 'join'. Walks the whole tree up
 * front so acceptance never depends on which levels have rows, the batched
 * runners in builder.ts call this BEFORE the base query (a zero-row base
 * result must still reject, exactly like the join strategy's build-time throw).
 */
export function rejectNestedPickOrder(withClause: WithClause): void {
  for (const spec of Object.values(withClause)) {
    if (!spec || spec === true) continue;
    const options = spec as WithOptions;
    if (options.orderBy) {
      for (const [key, value] of Object.entries(options.orderBy)) {
        if (isRelationPickOrderBy(value)) {
          throw new ValidationError(
            `Pick-row ordering on relation "${key}" is only supported in a top-level ` +
              'findMany orderBy: nested `with` orderBy does not support it.',
          );
        }
      }
    }
    if (options.with) rejectNestedPickOrder(options.with as WithClause);
  }
}

/**
 * Load every relation in `withClause` for `parents` and attach it onto each row
 * in place. Mirrors the join strategy's output shape exactly. Recurses for nested
 * `with` by re-running itself against the freshly-loaded child rows.
 */
export async function loadRelationsBatched(
  ctx: RelationLoadContext,
  parents: Record<string, unknown>[],
  withClause: WithClause,
  timeout?: number,
  depth = 0,
  path: string[] = [ctx.parentMeta.name],
): Promise<void> {
  if (depth >= MAX_DEPTH) throw new CircularRelationError([...path, '…']);
  // Scope-rule parity with the join strategy: the whole tree validates even
  // with zero parents, so accept/reject never depends on data. There is
  // DELIBERATELY no `parents.length === 0` early return here: one used to sit
  // below this line, and it skipped relation-NAME resolution and every child
  // compile whenever the base query matched nothing, so a typo'd relation or
  // child select threw on populated data and passed silently on empty. The
  // loaders below all compile their child query before their own
  // data-dependent exits (one SQL string build per relation node; makeChild
  // creates a fresh QueryInterface, so this is NOT a template-cache hit, and
  // nothing executes), which keeps this path's acceptance byte-aligned with
  // the join plan's compile-time validation.
  if (depth === 0) rejectNestedPickOrder(withClause);

  // Resolve the relations to load in the SAME order the join plan emits their
  // columns (`sortedEntries` in buildSelectWithRelations), with the reserved
  // `_count` key last.
  const resolved: { relName: string; rel: RelationDef; options: WithOptions }[] = [];
  for (const [relName, spec] of sortedEntries(withClause as Record<string, unknown>)) {
    if (!spec || relName === '_count') continue;
    const rel = ownLookup(ctx.parentMeta.relations, relName);
    if (!rel) {
      // RelationError (E005), NOT ValidationError: the join strategy throws
      // E005 for this exact shape (relations.ts), and under 'auto' the two
      // must refuse identically or the error CODE depends on table size.
      throw new RelationError(
        `Unknown relation "${relName}" on table "${ctx.parentMeta.name}". ` +
          availableClause(Object.keys(ctx.parentMeta.relations), 'It has no relations.'),
      );
    }
    resolved.push({ relName, rel, options: spec === true ? {} : (spec as WithOptions) });
  }
  // A falsy `_count` opts out, exactly like a falsy relation spec.
  const countSpec = (withClause as { _count?: WithCount })._count;
  const hasCount = Boolean(countSpec);

  // NESTED `_count` is refused here so the two strategies answer alike.
  //
  // The join builder emits `_count` only for the TOP-LEVEL `with`; one level
  // down, `buildRelationSubquery` looks `_count` up as an ordinary relation
  // name, misses, and throws E005. This loader handled it at every depth, so
  // one query with one set of args either threw or returned populated counts
  // depending purely on which plan ran, and under the `'auto'` default that
  // choice is made by a cost heuristic reading index coverage and table size.
  // The same code therefore worked on a small table and threw on a large one.
  //
  // That is the same non-determinism as the correlation-key bug this module was
  // just fixed for, only louder, so it is closed the same way: by agreement.
  // Refusing is the direction that is a no-op for anyone on the default, since
  // there the shape already fails whenever the relation is NOT demoted. Nested
  // `_count` is a real feature (Prisma has it) and teaching the join path is
  // the right end state, but that means the four json_build_object emission
  // sites, the positional encoding, SQL Server's FOR JSON override and PowDB's
  // nested projections all learning it together, which is a feature release,
  // not a line in a correctness fix. Until then both strategies say no.
  if (hasCount && depth > 0) {
    throw new RelationError(
      `Unknown relation "_count" on table "${ctx.parentMeta.name}". ` +
        `${availableClause(Object.keys(ctx.parentMeta.relations), 'It has no relations.')} ` +
        '(`_count` is supported on the top-level `with` only, on every relationLoadStrategy.)',
    );
  }

  // Fix key order BEFORE anything is awaited: the loads below all write their
  // key on completion, and completion order is a race between concurrent
  // statements.
  seedRelationKeys(parents, ctx.parentMeta, resolved, hasCount);

  // Sibling relations are independent (each writes only its own parent[relName]
  // and reads only parent keys), so load them concurrently, on a pool that's
  // real parallelism, inside a transaction pg queues them on the one connection.
  const loads: Promise<void>[] = [];
  for (const { relName, rel, options } of resolved) {
    loads.push(
      rel.type === 'manyToMany'
        ? loadManyToMany(ctx, parents, rel, relName, options, timeout, depth, path)
        : loadToOneOrMany(ctx, parents, rel, relName, options, timeout, depth, path),
    );
  }
  // Reserved `_count` key, one grouped COUNT(*) follow-up per counted relation.
  if (hasCount) loads.push(loadCounts(ctx, parents, countSpec as WithCount));
  await Promise.all(loads);
}

/**
 * Give every relation key its final POSITION on each parent row before the
 * concurrent follow-up queries start, so the stitched object serializes to the
 * same bytes on every run and matches the join strategy.
 *
 * The reference order is the join plan's SELECT list: base columns, then the
 * relation columns in sorted `with` order, then the `_count__<rel>` scalars
 * (which `parseNestedRow` folds into a `_count` object appended last). A key
 * that is already present is re-inserted rather than seeded: under the `'auto'`
 * split some relations arrive resolved by the join plan and the rest are loaded
 * here, and only a re-insert can interleave the two sets into one canonical
 * order. Base (non-relation) columns are never touched.
 */
function seedRelationKeys(
  parents: Record<string, unknown>[],
  parentMeta: TableMetadata,
  resolved: { relName: string; rel: RelationDef; options: WithOptions }[],
  hasCount: boolean,
): void {
  // Placeholder per relation: the value an empty load produces, so a seeded key
  // is never a shape the caller could not otherwise see.
  const seeds = new Map<string, 'one' | 'many' | 'present'>();
  for (const { relName, rel } of resolved) {
    seeds.set(relName, rel.type === 'belongsTo' || rel.type === 'hasOne' ? 'one' : 'many');
  }
  // Relations the join plan already resolved onto these rows (the `'auto'`
  // split's residual join). Rows all come from one query, so one row's shape
  // answers for the batch.
  const sample = parents[0] as Record<string, unknown> | undefined;
  if (sample) {
    for (const relName of Object.keys(parentMeta.relations)) {
      // Already resolved by the join plan: it needs a position, never a
      // placeholder, so it is re-inserted rather than overwritten.
      if (!seeds.has(relName) && Object.hasOwn(sample, relName)) seeds.set(relName, 'present');
    }
  }
  const ordered = [...seeds.keys()].sort();
  const countPresent = hasCount || (sample !== undefined && Object.hasOwn(sample, '_count'));
  if (ordered.length === 0 && !countPresent) return;

  for (const parent of parents) {
    for (const relName of ordered) {
      if (Object.hasOwn(parent, relName)) {
        // Re-insert so this key sits in canonical order, value untouched.
        const existing = parent[relName];
        delete parent[relName];
        parent[relName] = existing;
      } else {
        parent[relName] = seeds.get(relName) === 'many' ? [] : null;
      }
    }
    if (!countPresent) continue;
    const existingCount = Object.hasOwn(parent, '_count') ? parent._count : undefined;
    delete parent._count;
    parent._count = existingCount ?? {};
  }
}

/**
 * hasMany / hasOne / belongsTo: one follow-up `SELECT ... WHERE childKey = ANY($1)`
 * (chunked), grouped by the correlation key and attached (array vs single-or-null).
 */
async function loadToOneOrMany(
  ctx: RelationLoadContext,
  parents: Record<string, unknown>[],
  rel: RelationDef,
  relName: string,
  options: WithOptions,
  timeout: number | undefined,
  depth: number,
  path: string[],
): Promise<void> {
  const fk = normalizeKeyColumns(rel.foreignKey);
  const rk = normalizeKeyColumns(rel.referenceKey);
  if (fk.length > 1 || rk.length > 1) {
    throw new UnsupportedFeatureError(
      'composite-key batched relation loading',
      'relationLoadStrategy: "batched"',
      `relation "${relName}", use the default 'join' strategy for composite-key relations`,
    );
  }
  const targetMeta = requireTable(ctx.schema, rel.to, relName);

  // Local key lives on the parent; the correlating key lives on the child.
  //   hasMany/hasOne: parent.referenceKey  ←  child.foreignKey
  //   belongsTo:      parent.foreignKey     →  child.referenceKey
  const parentKeyCol = rel.type === 'belongsTo' ? fk[0]! : rk[0]!;
  const childKeyCol = rel.type === 'belongsTo' ? rk[0]! : fk[0]!;
  const parentKeyField = ctx.parentMeta.reverseColumnMap[parentKeyCol] ?? parentKeyCol;
  const childKeyField = targetMeta.reverseColumnMap[childKeyCol] ?? childKeyCol;

  assertCorrelationKeyProjected(parents, parentKeyField, relName, ctx.parentMeta.name);
  const keys = uniqueKeys(parents, parentKeyField);
  const single = rel.type === 'belongsTo' || rel.type === 'hasOne';

  // The follow-up must project the child correlation key even if the caller's
  // select/omit excluded it; strip it back off afterwards so the shape matches join.
  //
  // AND the keys the child's OWN nested relations will correlate on. Passing
  // only `childKeyField` here was the whole of the silent-null bug: this level
  // stitched fine, then the recursion below asked the children for a key that
  // this projection had just dropped. The root call sites in builder.ts have
  // always resolved the full set through `neededParentKeyFields`; these nested
  // ones did not, so the defect needed a `select` (or an `omit` of the FK) on a
  // to-many with a to-one inside it, which is why `include` and `join` were both
  // clean and seventeen rounds of parity capture missed it.
  assertProjectionShape(targetMeta.name, options.select, options.omit);
  // Decide the per-parent pushdown BEFORE resolving the projection: when it is
  // on, the window's ORDER BY reads the order columns out of the derived table,
  // so they have to be projected (and, like the correlation keys, stripped
  // again afterwards). `null` means this relation keeps the client-side slice,
  // which is the case for every shape whose ordering does not force WHICH rows
  // the limit keeps. See {@link partitionOrderBy} and {@link boundedChildQuery}.
  const windowOrder = single || options.limit === undefined ? null : partitionOrderBy(targetMeta, options.orderBy);
  const pushDownLimit = windowOrder !== null && ctx.buildPartitionLimit !== undefined;
  // THE ONE PII EXCEPTION IN THE READ PATH, recorded here because the contract
  // in schema.ts says a PII column is excluded from every default projection
  // "at the SQL level". Ordering a LIMITED relation by a PII column force-adds
  // that column to this follow-up's SELECT list (the window reads it out of the
  // derived table), and it is removed from the entities by `proj.strip` before
  // anything returns. The join plan does the same thing in the same case: its
  // wrapped subquery projects `targetMeta.allColumns` into the derived table
  // whenever a relation carries a `limit` or an `orderBy`, and its
  // `json_build_object` then emits only the resolved, PII-free column list. So
  // the SQL-level statement is parity, and no PII value reaches a caller on
  // either plan. What is NOT identical, and is the honest cost of the pushdown:
  // on the join plan the value never leaves the server, while here it crosses
  // the wire and is dropped client-side. A caller who cannot accept that should
  // not order a limited relation by a PII column, which is a shape that already
  // reveals the column's ordering.
  const orderFields = pushDownLimit
    ? (windowOrder ?? []).map((o) => targetMeta.reverseColumnMap[o.column] ?? o.column)
    : [];
  const proj = includeKeysForBatching(
    targetMeta,
    options.select,
    options.omit,
    [childKeyField, ...orderFields, ...neededParentKeyFields(targetMeta, (options.with ?? {}) as WithClause)],
    defaultProjectionFields(targetMeta, ctx.includePii),
  );
  const child = ctx.makeChild(rel.to);
  const buildChunk = (chunk: unknown[]) =>
    child.buildFindMany({
      where: mergeChildWhere(options.where, childKeyField, chunk),
      select: proj.select,
      omit: proj.omit,
      orderBy: options.orderBy,
      skipGlobalFilters: ctx.skipGlobalFilters,
      includePii: ctx.includePii,
    });

  // Zero keys (no parents, or every parent's key is NULL): nothing to fetch,
  // but the child query still COMPILES, because compiling is where the
  // caller's select/omit/where/orderBy names are validated and the join plan
  // validates them regardless of data. Skipping this made a typo'd child
  // select throw or pass based on which rows the base query matched. Cost:
  // one SQL string build (the child is a fresh QueryInterface with its own
  // template LRU, so this is a build, not a cache hit); nothing executes.
  if (keys.length === 0) buildChunk([]);

  const chunks: unknown[][] = [];
  for (let i = 0; i < keys.length; i += MAX_RELATION_KEYS) chunks.push(keys.slice(i, i + MAX_RELATION_KEYS));
  // Chunks run concurrently, results concatenated in chunk order. A per-relation
  // `limit` is bounded IN THE DATABASE when the dialect can express "at most N
  // rows per correlation key" AND the relation's ordering forces which N those
  // are (see partitionOrderBy / boundedChildQuery); a plain trailing `LIMIT`
  // never can, because this one statement covers every parent. The client-side
  // slice below still runs either way.
  const chunkResults = await Promise.all(
    chunks.map(async (chunk) => {
      const deferred = buildChunk(chunk);
      const bounded = pushDownLimit
        ? boundedChildQuery(ctx, deferred, childKeyCol, windowOrder ?? [], options.limit as number)
        : deferred;
      const result = await ctx.exec(bounded.sql, bounded.params, bounded.preparedName);
      if (bounded !== deferred) stripRankColumn(result);
      return deferred.transform(result) as Record<string, unknown>[];
    }),
  );
  const allChildren: Record<string, unknown>[] = chunkResults.flat();

  // Recurse for nested `with` BEFORE stripping keys (children carry their own
  // keys). Recursion runs even with zero children: it is the validation walk
  // for the deeper levels of the tree (each level compiles its own child
  // query above), so a typo three levels down throws with or without data.
  if (options.with) {
    await loadRelationsBatched(
      { ...ctx, parentMeta: targetMeta },
      allChildren,
      options.with as WithClause,
      timeout,
      depth + 1,
      [...path, relName],
    );
  }

  // Symmetric to the parent-side assertion above. If the CHILD key were ever
  // missing, `groupBy` would bucket every child under the string "undefined",
  // no parent would match, and the relation would come back empty just as
  // silently. `includeKeysForBatching` makes that unreachable, which is exactly
  // what was true of the parent side until this week.
  assertCorrelationKeyProjected(allChildren, childKeyField, relName, targetMeta.name);
  const byKey = groupBy(allChildren, childKeyField);
  const limit = options.limit;
  for (const parent of parents) {
    const bucket = byKey.get(keyOf(parent[parentKeyField])) ?? [];
    if (single) {
      parent[relName] = bucket[0] ?? null;
    } else {
      parent[relName] = limit !== undefined ? bucket.slice(0, limit) : bucket;
    }
  }

  stripFields(allChildren, proj.strip);
}

/**
 * Rewrite a compiled child follow-up so the ENGINE returns at most `limit` rows
 * per correlation key, instead of returning every matching child and letting the
 * loader throw most of them away.
 *
 * WHY IT IS WORTH THE WRAPPER. The follow-up is one flat statement covering
 * every parent, so a trailing `LIMIT n` would cap the TOTAL, not the per-parent
 * count, and would starve most parents; that is exactly why the limit was
 * applied client-side and why the comment above used to say it could not be
 * pushed down. What it could not do was push down a `LIMIT`. A window function
 * expresses the actual requirement. Measured (200 posts, ~505 comments each,
 * `with: { comments: { limit: 3 } }`, 600 rows kept):
 *
 *   strategy   rows over the wire   peak heap
 *   join                      200      +0.5 MB
 *   batched (before)      101,000     +52.9 MB
 *
 * and this is not an opt-in-only path: `'auto'`, the default since 0.41, routes
 * a relation to the batched loader whenever its probe column is provably
 * unindexed, so on a "posts with 10K comments each" shape the old behaviour is
 * an OOM rather than a slowdown.
 *
 * WHAT IS DELIBERATELY NOT CHANGED. The mirror case is why this is a bound and
 * not a strategy switch: with NO per-relation limit the batched plan beat the
 * join plan 83 ms to 631 ms on the same data, so nothing here touches the
 * unlimited path. The client-side slice also stays: it is a no-op once the
 * engine has bounded each partition, and it is still the whole mechanism on an
 * engine with no {@link Dialect.buildPartitionLimit}, and on every relation
 * whose ordering leaves the choice of rows open ({@link partitionOrderBy}).
 *
 * WHAT THE CALLER GUARANTEES. `orderBy` is non-empty and totally orders the
 * target, so the window's rank and the outer sort agree by construction and the
 * n ranked rows per key are the n rows the join plan's per-parent
 * `ORDER BY … LIMIT n` returns, in the same order. That is the whole reason
 * this rewrite is allowed to change which rows come back over the wire.
 *
 * The prepared-statement name is REDERIVED from the wrapped text, never reused:
 * the child's name is the hash of the INNER statement, and sending different
 * text under a name the connection has already parsed would execute the old
 * statement with these params. An unnamed child (a variable-arity where) stays
 * unnamed.
 */
function boundedChildQuery(
  ctx: RelationLoadContext,
  deferred: Deferred,
  partitionColumn: string,
  orderBy: readonly { column: string; direction: 'ASC' | 'DESC'; nulls?: 'FIRST' | 'LAST' }[],
  limit: number,
): Deferred {
  const wrap = ctx.buildPartitionLimit;
  if (!wrap) return deferred;
  const sql = wrap({
    innerSql: deferred.sql,
    partitionColumn,
    orderBy,
    limitPlaceholder: ctx.paramPlaceholder(deferred.params.length + 1),
    rankColumn: PARTITION_RANK_COLUMN,
  });
  return {
    sql,
    params: [...deferred.params, limit],
    preparedName: deferred.preparedName ? sqlToPreparedName(sql) : deferred.preparedName,
    transform: deferred.transform,
  };
}

/**
 * Remove the window wrapper's rank column from every raw row, in place, before
 * the child's own transform parses them. It is the LAST column of the wrapper's
 * projection, so deleting it leaves the remaining key order untouched, which
 * matters: object key order is observable output here (callers stringify
 * results into HTTP bodies, ETags and cache keys).
 */
function stripRankColumn(result: PgCompatQueryResult): void {
  for (const row of result.rows as Record<string, unknown>[]) delete row[PARTITION_RANK_COLUMN];
}

/**
 * manyToMany: a three-hop batched loader (no join pushdown):
 *   (1) read junction rows for all parents (`sourceKey = ANY($1)` chunks),
 *   (2) read the target rows for the collected targetKeys,
 *   (3) stitch parent → junction targetKeys → target rows in memory.
 * Composite junction/target keys fall back to the join strategy (throw E017).
 */
async function loadManyToMany(
  ctx: RelationLoadContext,
  parents: Record<string, unknown>[],
  rel: RelationDef,
  relName: string,
  options: WithOptions,
  timeout: number | undefined,
  depth: number,
  path: string[],
): Promise<void> {
  const through = rel.through;
  if (!through) {
    throw new ValidationError(`manyToMany relation "${relName}" is missing its junction (\`through\`).`);
  }
  const sourceJ = normalizeKeyColumns(through.sourceKey);
  const targetJ = normalizeKeyColumns(through.targetKey);
  const sourceRef = normalizeKeyColumns(rel.referenceKey);
  const targetMeta = requireTable(ctx.schema, rel.to, relName);
  if (sourceJ.length > 1 || targetJ.length > 1 || sourceRef.length > 1 || targetMeta.primaryKey.length !== 1) {
    throw new UnsupportedFeatureError(
      'composite-key batched manyToMany loading',
      'relationLoadStrategy: "batched"',
      `relation "${relName}", use the default 'join' strategy for composite-key m2m relations`,
    );
  }
  const sourceJCol = sourceJ[0]!;
  const targetJCol = targetJ[0]!;
  const sourceRefCol = sourceRef[0]!;
  const targetPkCol = targetMeta.primaryKey[0]!;
  const parentRefField = ctx.parentMeta.reverseColumnMap[sourceRefCol] ?? sourceRefCol;
  const targetPkField = targetMeta.reverseColumnMap[targetPkCol] ?? targetPkCol;

  assertCorrelationKeyProjected(parents, parentRefField, relName, ctx.parentMeta.name);
  // No early return on zero parent keys: the code below flows through
  // naturally (zero junction chunks, zero target chunks), and the compile-only
  // build further down still validates the caller's names, same rule as the
  // to-one/to-many loader.
  const parentKeys = uniqueKeys(parents, parentRefField);

  // (1) Junction rows: sourceKeyVal → [targetKeyVal]. Raw SQL through the caller's
  // executor (the junction table has no relations we need, so no child reader).
  const targetsBySource = new Map<string, unknown[]>();
  const targetValSet = new Set<unknown>();
  const jTable = ctx.quote(through.table);
  const jSource = ctx.quote(sourceJCol);
  const jTarget = ctx.quote(targetJCol);
  const jChunks: unknown[][] = [];
  for (let i = 0; i < parentKeys.length; i += MAX_RELATION_KEYS) {
    jChunks.push(parentKeys.slice(i, i + MAX_RELATION_KEYS));
  }
  const jResults = await Promise.all(
    jChunks.map((chunk) => {
      const params: unknown[] = [ctx.inClauseParam(chunk)];
      const predicate = ctx.buildInClause(`${jTable}.${jSource}`, ctx.paramPlaceholder(1), false);
      const sql = `SELECT ${jTable}.${jSource} AS "s", ${jTable}.${jTarget} AS "t" FROM ${jTable} WHERE ${predicate}`;
      return ctx.exec(sql, params);
    }),
  );
  for (const { rows } of jResults) {
    for (const row of rows as Record<string, unknown>[]) {
      const sv = keyOf(row.s);
      const tv = row.t;
      if (tv == null) continue;
      const bucket = targetsBySource.get(sv);
      if (bucket) bucket.push(tv);
      else targetsBySource.set(sv, [tv]);
      targetValSet.add(tv);
    }
  }

  // (2) Target rows by PK, honouring the relation's own where/select/omit/orderBy.
  // Plus the keys the target's own nested relations need, same rule and same
  // reason as the to-many loader above: this level's PK is not the only key the
  // recursion below will ask these rows for.
  assertProjectionShape(targetMeta.name, options.select, options.omit);
  const proj = includeKeysForBatching(
    targetMeta,
    options.select,
    options.omit,
    [targetPkField, ...neededParentKeyFields(targetMeta, (options.with ?? {}) as WithClause)],
    defaultProjectionFields(targetMeta, ctx.includePii),
  );
  const child = ctx.makeChild(rel.to);
  const buildTargetChunk = (chunk: unknown[]) =>
    child.buildFindMany({
      where: mergeChildWhere(options.where, targetPkField, chunk),
      select: proj.select,
      omit: proj.omit,
      orderBy: options.orderBy,
      skipGlobalFilters: ctx.skipGlobalFilters,
      includePii: ctx.includePii,
    });
  const targetVals = [...targetValSet];
  // Compile-only when there is nothing to fetch: validation of the caller's
  // names lives in the build, and it must not depend on whether any junction
  // row matched (same rule as the to-one/to-many loader).
  if (targetVals.length === 0) buildTargetChunk([]);
  const tChunks: unknown[][] = [];
  for (let i = 0; i < targetVals.length; i += MAX_RELATION_KEYS) {
    tChunks.push(targetVals.slice(i, i + MAX_RELATION_KEYS));
  }
  const tResults = await Promise.all(
    tChunks.map(async (chunk) => {
      const deferred = buildTargetChunk(chunk);
      const result = await ctx.exec(deferred.sql, deferred.params, deferred.preparedName);
      return deferred.transform(result) as Record<string, unknown>[];
    }),
  );
  const targetsInOrder: Record<string, unknown>[] = tResults.flat();

  // Nested `with` on the target rows (before stripping their PK). Runs even
  // with zero targets: it is the validation walk for the deeper levels.
  if (options.with) {
    await loadRelationsBatched(
      { ...ctx, parentMeta: targetMeta },
      targetsInOrder,
      options.with as WithClause,
      timeout,
      depth + 1,
      [...path, relName],
    );
  }

  const targetByPk = new Map<string, Record<string, unknown>>();
  for (const t of targetsInOrder) targetByPk.set(keyOf(t[targetPkField]), t);

  // (3) Stitch. Iterate `targetsInOrder` (already ordered by the relation's
  // orderBy) and pick the ones each parent links to, so per-parent order honours
  // orderBy; then apply the per-relation `limit` client-side.
  //
  // CLIENT-SIDE ON PURPOSE, and not an oversight of the per-parent pushdown the
  // to-one/to-many loader uses. That pushdown ranks the follow-up rows with
  // `ROW_NUMBER() OVER (PARTITION BY <correlation column>)`, and this query has
  // no such column: step (2) reads TARGET rows by their own primary key, the
  // parent correlation lives one hop back in the junction, and a single target
  // row is legitimately linked to many parents, so it must be fetched once and
  // attached several times. Partitioning by parent would mean joining the
  // junction into the follow-up and returning one copy of the target row per
  // link, which spends exactly the bytes the pushdown exists to save; and the
  // bound would still have to respect a `limit` measured per parent, not per
  // fetched row. So the m2m loader keeps the slice below, on every engine.
  const limit = options.limit;
  for (const parent of parents) {
    const linked = new Set((targetsBySource.get(keyOf(parent[parentRefField])) ?? []).map(keyOf));
    if (linked.size === 0) {
      parent[relName] = [];
      continue;
    }
    const out: Record<string, unknown>[] = [];
    for (const t of targetsInOrder) {
      if (linked.has(keyOf(t[targetPkField]))) {
        out.push(t);
        if (limit !== undefined && out.length >= limit) break;
      }
    }
    parent[relName] = out;
  }

  stripFields(targetsInOrder, proj.strip);
}

/**
 * Load correlated `_count` values for the counted relations. One grouped
 * follow-up per relation (`SELECT key, COUNT(*) … WHERE key = ANY($1) GROUP BY
 * key`), attached onto each parent's `_count` object (0 when a parent has no
 * matching rows), byte-identical to the join strategy's `_count` output,
 * INCLUDING key order: the join plan emits its `_count__<rel>` columns in
 * `resolveCountRelations` order, so every key is seeded here in that same order
 * before the concurrent counts run and can only be overwritten in place.
 */
async function loadCounts(
  ctx: RelationLoadContext,
  parents: Record<string, unknown>[],
  countSpec: WithCount,
): Promise<void> {
  const rels = resolveCountRelations(ctx.parentMeta, countSpec);
  // Initialise every parent's `_count` up-front, and seed every counted
  // relation's key in `resolveCountRelations` order, so the concurrent
  // per-relation loads below only ever overwrite a key that already exists.
  // Without the seeded keys, insertion order is whichever COUNT statement
  // finishes first and the same query serializes differently run to run.
  for (const parent of parents) {
    if (parent._count === undefined) parent._count = {};
    const counts = parent._count as Record<string, number>;
    for (const rel of rels) counts[rel.name] = 0;
  }
  await Promise.all(rels.map((rel) => loadOneCount(ctx, parents, rel)));
}

/** One grouped COUNT(*) follow-up for a single to-many relation. */
async function loadOneCount(
  ctx: RelationLoadContext,
  parents: Record<string, unknown>[],
  rel: RelationDef,
): Promise<void> {
  let parentKeyCol: string;
  let childTable: string;
  let childKeyCol: string;

  if (rel.type === 'manyToMany') {
    const through = rel.through;
    if (!through) {
      throw new ValidationError(`manyToMany relation "${rel.name}" is missing its junction (\`through\`).`);
    }
    const sourceRef = normalizeKeyColumns(rel.referenceKey);
    const sourceJ = normalizeKeyColumns(through.sourceKey);
    if (sourceRef.length > 1 || sourceJ.length > 1) {
      throw new UnsupportedFeatureError(
        'composite-key batched _count',
        'relationLoadStrategy: "batched"',
        `relation "${rel.name}", use the default 'join' strategy for composite-key m2m _count`,
      );
    }
    parentKeyCol = sourceRef[0]!;
    childTable = through.table;
    childKeyCol = sourceJ[0]!;
  } else {
    // hasMany: child FK correlates to the parent reference key.
    const fk = normalizeKeyColumns(rel.foreignKey);
    const rk = normalizeKeyColumns(rel.referenceKey);
    if (fk.length > 1 || rk.length > 1) {
      throw new UnsupportedFeatureError(
        'composite-key batched _count',
        'relationLoadStrategy: "batched"',
        `relation "${rel.name}", use the default 'join' strategy for composite-key _count`,
      );
    }
    parentKeyCol = rk[0]!;
    childTable = rel.to;
    childKeyCol = fk[0]!;
  }

  const parentKeyField = ctx.parentMeta.reverseColumnMap[parentKeyCol] ?? parentKeyCol;
  const keys = uniqueKeys(parents, parentKeyField);

  const counts = new Map<string, number>();
  if (keys.length > 0) {
    const qChild = ctx.quote(childTable);
    const qKey = ctx.quote(childKeyCol);
    const chunks: unknown[][] = [];
    for (let i = 0; i < keys.length; i += MAX_RELATION_KEYS) chunks.push(keys.slice(i, i + MAX_RELATION_KEYS));
    // Global filter on the counted target, matching the join strategy so the
    // two strategies return identical counts under a filter. hasMany filters
    // the counted table directly; m2m counts junction rows but restricts them
    // to junction rows whose TARGET survives the target table's filter via
    // EXISTS, mirroring buildRelationCountExpr's EXISTS-on-target (which also
    // skips the filter when the junction targetKey arity doesn't match the
    // target PK). Rendered after the $1 key array.
    let gf: { clause: string; params: unknown[] } | null = null;
    if (ctx.tableGlobalFilter) {
      if (rel.type === 'manyToMany' && rel.through) {
        const targetKeys = normalizeKeyColumns(rel.through.targetKey);
        const targetMeta = ctx.schema.tables[rel.to];
        const pk = targetMeta?.primaryKey ?? [];
        if (targetMeta && pk.length > 0 && pk.length === targetKeys.length) {
          const targetGf = ctx.tableGlobalFilter(rel.to, 't', 1);
          if (targetGf) {
            const join = targetKeys.map((jc, i) => `t.${ctx.quote(pk[i]!)} = ${qChild}.${ctx.quote(jc)}`).join(' AND ');
            gf = {
              clause: `EXISTS (SELECT 1 FROM ${ctx.quote(rel.to)} t WHERE ${join} AND ${targetGf.clause})`,
              params: targetGf.params,
            };
          }
        }
      } else if (rel.type !== 'manyToMany') {
        gf = ctx.tableGlobalFilter(childTable, qChild, 1);
      }
    }
    const gfAnd = gf ? ` AND ${gf.clause}` : '';
    const results = await Promise.all(
      chunks.map((chunk) => {
        const params: unknown[] = [ctx.inClauseParam(chunk), ...(gf ? gf.params : [])];
        const predicate = ctx.buildInClause(`${qChild}.${qKey}`, ctx.paramPlaceholder(1), false);
        const sql =
          `SELECT ${qChild}.${qKey} AS "k", COUNT(*) AS "c" FROM ${qChild} ` +
          `WHERE ${predicate}${gfAnd} GROUP BY ${qChild}.${qKey}`;
        return ctx.exec(sql, params);
      }),
    );
    for (const { rows } of results) {
      for (const row of rows as Record<string, unknown>[]) {
        counts.set(keyOf(row.k), Number(row.c));
      }
    }
  }

  for (const parent of parents) {
    (parent._count as Record<string, number>)[rel.name] = counts.get(keyOf(parent[parentKeyField])) ?? 0;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * AND the batched correlation predicate (`key IN chunk`) onto the relation's own
 * `where`, matching the join strategy, which appends the correlation with
 * ` AND <extra>` and so never lets one predicate replace the other.
 *
 * A flat spread is kept for the overwhelmingly common case where the caller's
 * `where` does not name the correlation field, so the emitted SQL is unchanged
 * there. When it DOES name it (e.g. `with: { posts: { where: { userId: 1 } } }`,
 * or a belongsTo `where` on the child's PK), a bare spread would let the chunk
 * predicate silently overwrite the caller's filter and return rows the join
 * strategy excludes; the two are combined with `AND` instead so both apply.
 */
function mergeChildWhere(
  where: Record<string, unknown> | undefined,
  keyField: string,
  chunk: unknown[],
): Record<string, unknown> {
  const correlation = { [keyField]: { in: chunk } };
  if (!where) return correlation;
  // Branded: this `AND` is TURBINE's, always exactly two branches and decided
  // here rather than by the caller, so it must not put the follow-up on the
  // variable-arity (unnamed) prepared-statement path. Same rule and same
  // reason as the global-filter merge in where.ts.
  if (Object.hasOwn(where, keyField)) return markInternalCombinator({ AND: [where, correlation] });
  return { ...where, ...correlation };
}

/**
 * Refuse to stitch a relation whose correlation key was never projected.
 *
 * THE FAILURE THIS EXISTS TO REMOVE. `uniqueKeys` skips a row whose key is
 * `null` OR `undefined`, and a column the projection left out is `undefined`
 * for exactly the same reason it is for a genuinely null FK. So a loader that
 * has lost its key cannot tell itself apart from a page of parents that
 * legitimately point at nothing: both produce zero keys, and the empty-key
 * branch hands back `null` / `[]` for every parent. That is a wrong answer with
 * an HTTP 200 on it: a reporting endpoint summed a money column across the
 * relation, every row of it read as absent, and the total came back 0 for a
 * large fraction of a page. Nothing in the payload, the logs or the response
 * status distinguished it from the right answer.
 *
 * The two states ARE distinguishable, just not by the value: a column that was
 * not selected is ABSENT from the parsed entity (`'fk' in row === false`),
 * while a selected column holding SQL NULL is PRESENT with the value `null`.
 * Verified against a live database in both directions. So the discriminator is
 * property presence (`Object.hasOwn`, not `in`: the rest of this file uses it,
 * and a column named `constructor` or `toString` passes an `in` check on any
 * plain object), and it is checked over ALL parents rather than the first:
 * every row on one level shares one projection, so a field missing from every
 * row is a projection fault, while a field missing from some rows is not a
 * state this loader can produce at all.
 *
 * After {@link neededParentKeyFields} is applied at every nesting level this is
 * an unreachable invariant, which is the point: if it ever fires it is a bug in
 * Turbine, not in the caller's query, and the caller gets told so along with the
 * one-line workaround. E017 with the same remedy as the composite-key refusal a
 * few lines up, deliberately: to the caller both are "this strategy cannot serve
 * this shape, use 'join'", and inventing a code for an unreachable state would
 * be a new public error nobody can trigger.
 */
function assertCorrelationKeyProjected(
  parents: Record<string, unknown>[],
  field: string,
  relName: string,
  parentTable: string,
): void {
  if (parents.length === 0) return;
  if (parents.some((parent) => Object.hasOwn(parent, field))) return;
  throw new UnsupportedFeatureError(
    `batched loading of relation "${relName}" on "${parentTable}"`,
    'relationLoadStrategy: "batched"',
    `the correlation key "${field}" is missing from every parent row, so the relation cannot be stitched and ` +
      'would silently come back empty. This is a bug in turbine, please report it. ' +
      `Workaround: pass \`relationLoadStrategy: 'join'\` on this query.`,
  );
}

/** Distinct, non-null values of `field` across `rows`. */
function uniqueKeys(rows: Record<string, unknown>[], field: string): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const row of rows) {
    const v = row[field];
    if (v == null) continue;
    const k = keyOf(v);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

/** Group rows by the stringified value of `field`, preserving input order. */
function groupBy(rows: Record<string, unknown>[], field: string): Map<string, Record<string, unknown>[]> {
  const map = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const k = keyOf(row[field]);
    const bucket = map.get(k);
    if (bucket) bucket.push(row);
    else map.set(k, [row]);
  }
  return map;
}

/**
 * Resolve a table's metadata or throw a clear relation error. E005
 * (RelationError), matching the class the join path throws for its "Unknown
 * relation target" twin in relations.ts: only corrupt/partial metadata can
 * trigger either, but the error CODE must still not depend on which strategy
 * ran (the same rule as the unknown relation NAME above).
 */
function requireTable(schema: SchemaMetadata, table: string, relName: string): TableMetadata {
  const meta = schema.tables[table];
  if (!meta) throw new RelationError(`Unknown relation target "${table}" (relation "${relName}").`);
  return meta;
}
