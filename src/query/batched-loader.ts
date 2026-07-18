/**
 * turbine-orm — Batched relation loader (the `relationLoadStrategy: 'batched'` path)
 *
 * ## Why this exists
 *
 * Turbine's default `with`-clause strategy resolves nested relations in ONE SQL
 * statement using correlated `json_agg(json_build_object(...))` subqueries — one
 * probe per parent row (see `buildRelationSubquery` in builder.ts). That is the
 * right default: a single round-trip, and when the child FK columns are indexed
 * each probe is an index seek. But it degrades in two situations:
 *
 *   1. **Missing FK index** — a correlated probe per parent row becomes
 *      N-parents × full-table-scan. A batched-loader ORM pays that missing index
 *      only ONCE (a single `WHERE fk = ANY($1)` seq-scan), which is why schemas
 *      migrated from those ORMs often lack the index the json_agg path needs.
 *   2. **Huge unpaginated result sets** — the JSON wire format
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
 *     the pinned-connection `txPool`, so batched loads join the transaction — no
 *     separate pool checkout per query.
 *   - **Identical output shape.** The stitched result is byte-for-byte the same
 *     shape the join strategy produces: relation arrays for hasMany/manyToMany
 *     (`[]` when empty), single-or-null for hasOne/belongsTo, with the same
 *     camelCase keys and Date coercion — because the child rows are parsed by the
 *     very same `parseRow`/`buildFindMany` machinery via a child QueryInterface.
 *   - **Stitch keys never leak.** To stitch, the follow-up query must select the
 *     FK/PK it joins on even when the caller's `select`/`omit` excluded it; the
 *     loader adds those columns for the query and strips them from the returned
 *     entities afterwards ({@link includeKeysForBatching}).
 *
 * PowDB (powql.ts) has its own batched loaders for the same reasons — this is the
 * clean Postgres/SQL implementation, deliberately NOT shared with PowQL.
 *
 * @module
 */

import type pg from 'pg';
import { CircularRelationError, RelationError, UnsupportedFeatureError, ValidationError } from '../errors.js';
import { normalizeKeyColumns, type RelationDef, type SchemaMetadata, type TableMetadata } from '../schema.js';
import type { ReselectExecutor } from './builder.js';
import { isRelationPickOrderBy } from './filters.js';
import type { SkipGlobalFilters, WithClause, WithCount, WithOptions } from './types.js';

/**
 * Max parent keys per follow-up query. On Postgres the whole key set travels as
 * ONE array parameter (`= ANY($1)`), so this is not a bind-parameter limit — it
 * only bounds planner/memory cost per statement. Keep it large: every extra
 * chunk is an extra network round-trip, and round-trips are exactly what the
 * batched strategy exists to minimize (a 9-chunk load was measured 2× slower
 * than a single-statement one over a WAN link).
 */
const MAX_RELATION_KEYS = 32_000;

/** Nesting cap — parity with the join strategy's depth-10 guard. */
const MAX_DEPTH = 10;

/**
 * A DeferredQuery, minimally typed for what the loader consumes. Kept local to
 * avoid a value import of builder.ts (which imports this module).
 */
interface Deferred {
  sql: string;
  params: unknown[];
  preparedName?: string;
  transform: (result: pg.QueryResult) => unknown;
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
   * as the join strategy does at every nested level. Default `false`.
   */
  includePii?: boolean;
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
}

/**
 * Adjust a `select`/`omit` pair so that `fields` are guaranteed present in the
 * query result, returning the adjusted projection plus the list of fields that
 * were added ONLY for stitching and must be stripped from the final entities.
 *
 * Used both for the base query (parent keys) and each follow-up query (child
 * keys) so a caller's `select: { title: true }` on a relation still stitches even
 * though the FK was not requested — and the FK never appears in the output.
 */
export function includeKeysForBatching(
  select: Record<string, boolean> | undefined,
  omit: Record<string, boolean> | undefined,
  fields: string[],
): { select?: Record<string, boolean>; omit?: Record<string, boolean>; strip: string[] } {
  const unique = [...new Set(fields)];
  if (select) {
    const next = { ...select };
    const strip: string[] = [];
    for (const f of unique) {
      if (!next[f]) {
        next[f] = true;
        strip.push(f); // not requested by the caller — added only to stitch
      }
    }
    return { select: next, omit, strip };
  }
  if (omit) {
    const next = { ...omit };
    const strip: string[] = [];
    for (const f of unique) {
      if (next[f]) {
        delete next[f]; // un-omit so the key is present; the caller wanted it gone
        strip.push(f);
      }
    }
    return { select, omit: next, strip };
  }
  // Neither select nor omit — every column is already present; nothing to strip.
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
    const rel = parentMeta.relations[relName];
    if (!rel) continue; // unknown relation — the join path throws; let the loader surface it
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
    const rel = parentMeta.relations[relName];
    if (!rel) {
      throw new RelationError(
        `[turbine] Unknown relation "${relName}" in _count on table "${parentMeta.name}". ` +
          `Available: ${Object.keys(parentMeta.relations).join(', ')}`,
      );
    }
    if (!isToMany(rel)) {
      throw new ValidationError(
        `[turbine] _count is only supported for to-many relations; "${relName}" on ` +
          `"${parentMeta.name}" is a to-one relation.`,
      );
    }
    out.push(rel);
  }
  return out;
}

/** Stringified stitch key — robust to number/uuid/bigint type drift across a join. */
function keyOf(value: unknown): string {
  return String(value);
}

/**
 * Reject pick-row relation ordering anywhere inside a `with` tree's orderBy —
 * strategy parity with the join path, which throws this exact E003 at SQL
 * build time (`pickOrderNestedError` in builder.ts). Without this guard the
 * loaders would forward `options.orderBy` as the child reader's TOP-LEVEL
 * findMany orderBy, where the pick shape compiles fine — so the same query
 * would execute on 'batched' but throw on 'join'. Walks the whole tree up
 * front so acceptance never depends on which levels have rows — the batched
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
            `[turbine] Pick-row ordering on relation "${key}" is only supported in a top-level ` +
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
  // Scope-rule parity with the join strategy: validate the whole tree BEFORE
  // the empty-parents early return, so accept/reject never depends on data.
  if (depth === 0) rejectNestedPickOrder(withClause);
  if (parents.length === 0) return;

  // Sibling relations are independent (each writes only its own parent[relName]
  // and reads only parent keys), so load them concurrently — on a pool that's
  // real parallelism, inside a transaction pg queues them on the one connection.
  const loads: Promise<void>[] = [];
  for (const [relName, spec] of Object.entries(withClause)) {
    if (!spec) continue;
    // Reserved `_count` key — one grouped COUNT(*) follow-up per counted relation.
    if (relName === '_count') {
      loads.push(loadCounts(ctx, parents, spec as unknown as WithCount));
      continue;
    }
    const rel = ctx.parentMeta.relations[relName];
    if (!rel) {
      throw new ValidationError(
        `[turbine] Unknown relation "${relName}" on table "${ctx.parentMeta.name}". ` +
          `Available: ${Object.keys(ctx.parentMeta.relations).join(', ')}`,
      );
    }
    const options: WithOptions = spec === true ? {} : (spec as WithOptions);

    loads.push(
      rel.type === 'manyToMany'
        ? loadManyToMany(ctx, parents, rel, relName, options, timeout, depth, path)
        : loadToOneOrMany(ctx, parents, rel, relName, options, timeout, depth, path),
    );
  }
  await Promise.all(loads);
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
      `relation "${relName}" — use the default 'join' strategy for composite-key relations`,
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

  const keys = uniqueKeys(parents, parentKeyField);
  const single = rel.type === 'belongsTo' || rel.type === 'hasOne';

  if (keys.length === 0) {
    for (const parent of parents) parent[relName] = single ? null : [];
    return;
  }

  // The follow-up must project the child correlation key even if the caller's
  // select/omit excluded it; strip it back off afterwards so the shape matches join.
  const proj = includeKeysForBatching(options.select, options.omit, [childKeyField]);
  const child = ctx.makeChild(rel.to);

  const chunks: unknown[][] = [];
  for (let i = 0; i < keys.length; i += MAX_RELATION_KEYS) chunks.push(keys.slice(i, i + MAX_RELATION_KEYS));
  // Chunks run concurrently, results concatenated in chunk order. Per-relation
  // `limit` is NOT pushed down here: `LIMIT` on a `fk = ANY($1)` query over the
  // whole batch would cap TOTAL children, not children-per-parent. It is applied
  // client-side per group after stitching (below).
  const chunkResults = await Promise.all(
    chunks.map(async (chunk) => {
      const deferred = child.buildFindMany({
        where: mergeChildWhere(options.where, childKeyField, chunk),
        select: proj.select,
        omit: proj.omit,
        orderBy: options.orderBy,
        skipGlobalFilters: ctx.skipGlobalFilters,
        includePii: ctx.includePii,
      });
      const result = await ctx.exec(deferred.sql, deferred.params, deferred.preparedName);
      return deferred.transform(result) as Record<string, unknown>[];
    }),
  );
  const allChildren: Record<string, unknown>[] = chunkResults.flat();

  // Recurse for nested `with` BEFORE stripping keys (children carry their own keys).
  if (options.with && allChildren.length > 0) {
    await loadRelationsBatched(
      { ...ctx, parentMeta: targetMeta },
      allChildren,
      options.with as WithClause,
      timeout,
      depth + 1,
      [...path, relName],
    );
  }

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
    throw new ValidationError(`[turbine] manyToMany relation "${relName}" is missing its junction (\`through\`).`);
  }
  const sourceJ = normalizeKeyColumns(through.sourceKey);
  const targetJ = normalizeKeyColumns(through.targetKey);
  const sourceRef = normalizeKeyColumns(rel.referenceKey);
  const targetMeta = requireTable(ctx.schema, rel.to, relName);
  if (sourceJ.length > 1 || targetJ.length > 1 || sourceRef.length > 1 || targetMeta.primaryKey.length !== 1) {
    throw new UnsupportedFeatureError(
      'composite-key batched manyToMany loading',
      'relationLoadStrategy: "batched"',
      `relation "${relName}" — use the default 'join' strategy for composite-key m2m relations`,
    );
  }
  const sourceJCol = sourceJ[0]!;
  const targetJCol = targetJ[0]!;
  const sourceRefCol = sourceRef[0]!;
  const targetPkCol = targetMeta.primaryKey[0]!;
  const parentRefField = ctx.parentMeta.reverseColumnMap[sourceRefCol] ?? sourceRefCol;
  const targetPkField = targetMeta.reverseColumnMap[targetPkCol] ?? targetPkCol;

  const parentKeys = uniqueKeys(parents, parentRefField);
  if (parentKeys.length === 0) {
    for (const parent of parents) parent[relName] = [];
    return;
  }

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
  const proj = includeKeysForBatching(options.select, options.omit, [targetPkField]);
  const child = ctx.makeChild(rel.to);
  const targetVals = [...targetValSet];
  const tChunks: unknown[][] = [];
  for (let i = 0; i < targetVals.length; i += MAX_RELATION_KEYS) {
    tChunks.push(targetVals.slice(i, i + MAX_RELATION_KEYS));
  }
  const tResults = await Promise.all(
    tChunks.map(async (chunk) => {
      const deferred = child.buildFindMany({
        where: mergeChildWhere(options.where, targetPkField, chunk),
        select: proj.select,
        omit: proj.omit,
        orderBy: options.orderBy,
        skipGlobalFilters: ctx.skipGlobalFilters,
        includePii: ctx.includePii,
      });
      const result = await ctx.exec(deferred.sql, deferred.params, deferred.preparedName);
      return deferred.transform(result) as Record<string, unknown>[];
    }),
  );
  const targetsInOrder: Record<string, unknown>[] = tResults.flat();

  // Nested `with` on the target rows (before stripping their PK).
  if (options.with && targetsInOrder.length > 0) {
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
 * matching rows) — byte-identical to the join strategy's `_count` output.
 */
async function loadCounts(
  ctx: RelationLoadContext,
  parents: Record<string, unknown>[],
  countSpec: WithCount,
): Promise<void> {
  const rels = resolveCountRelations(ctx.parentMeta, countSpec);
  // Initialise every parent's `_count` up-front so the concurrent per-relation
  // loads below (each writing its own key) never race on the object creation.
  for (const parent of parents) {
    if (parent._count === undefined) parent._count = {};
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
      throw new ValidationError(`[turbine] manyToMany relation "${rel.name}" is missing its junction (\`through\`).`);
    }
    const sourceRef = normalizeKeyColumns(rel.referenceKey);
    const sourceJ = normalizeKeyColumns(through.sourceKey);
    if (sourceRef.length > 1 || sourceJ.length > 1) {
      throw new UnsupportedFeatureError(
        'composite-key batched _count',
        'relationLoadStrategy: "batched"',
        `relation "${rel.name}" — use the default 'join' strategy for composite-key m2m _count`,
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
        `relation "${rel.name}" — use the default 'join' strategy for composite-key _count`,
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
    // EXISTS — mirroring buildRelationCountExpr's EXISTS-on-target (which also
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

/** Merge the batched correlation predicate (`key IN chunk`) into the relation's own where. */
function mergeChildWhere(
  where: Record<string, unknown> | undefined,
  keyField: string,
  chunk: unknown[],
): Record<string, unknown> {
  return { ...(where ?? {}), [keyField]: { in: chunk } };
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

/** Resolve a table's metadata or throw a clear relation error. */
function requireTable(schema: SchemaMetadata, table: string, relName: string): TableMetadata {
  const meta = schema.tables[table];
  if (!meta) throw new ValidationError(`[turbine] Relation "${relName}" targets unknown table "${table}".`);
  return meta;
}
