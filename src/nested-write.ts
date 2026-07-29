/**
 * turbine-orm, Nested write engine
 *
 * Tree-walking create/update that resolves relation fields in `data` into
 * batched SQL operations within a transaction. Supports create, connect,
 * connectOrCreate, disconnect, set, delete, update, and upsert on related
 * records at arbitrary depth (capped at 10).
 *
 * This module is imported by `query/builder.ts` when the `data` argument
 * of `create()` or `update()` contains relation fields. It never imports
 * `client.ts` directly, the transaction handle is passed in via
 * `NestedWriteContext`.
 */

import {
  CircularRelationError,
  describeTargetForMessage,
  NotFoundError,
  RelationError,
  UnsupportedFeatureError,
  ValidationError,
} from './errors.js';
import { resolveColumnName } from './query/utils.js';
import type { RelationDef, SchemaMetadata, TableMetadata } from './schema.js';
import { normalizeKeyColumns } from './schema.js';

const MAX_DEPTH = 10;

const CREATE_ONLY_OPS = new Set(['create', 'connect', 'connectOrCreate']);
const UPDATE_ONLY_OPS = new Set(['disconnect', 'set', 'delete', 'update', 'upsert']);

// ---------------------------------------------------------------------------
// Public helper types
// ---------------------------------------------------------------------------

export interface ExtractedFields {
  scalars: Record<string, unknown>;
  relations: Record<string, Record<string, unknown>>;
}

/**
 * Transaction context for nested write operations.
 * Matches the subset of TransactionClient that we actually use.
 */
export interface NestedWriteContext {
  schema: SchemaMetadata;
  /**
   * Refuse a `connect` / `connectOrCreate` that would RE-PARENT a to-many
   * child already owned by a different parent. Off by default.
   *
   * `connect: { id: 42 }` on a to-many relation means "make row 42 mine", and
   * it does that unconditionally: if another parent owns row 42, the row is
   * silently taken from them. A handler that forwards a client-supplied id
   * into a nested connect therefore hands any caller a cross-tenant write
   * primitive, and the only defense is a hand-rolled ownership check at every
   * call site. With this on, connecting a child whose foreign key already
   * points at a DIFFERENT parent raises E003; connecting an unowned child
   * (null FK) or one this parent already owns still succeeds, so the
   * legitimate uses are untouched.
   *
   * Applies to `hasMany` / `hasOne` only. A `belongsTo` connect points the row
   * being written at a parent, which takes nothing from anyone, and a
   * many-to-many connect adds a junction row rather than moving one.
   */
  scopedConnect?: boolean;
  tx: {
    table<T extends object>(
      name: string,
    ): {
      create(args: { data: Partial<T> }): Promise<T>;
      createMany(args: { data: Partial<T>[]; skipDuplicates?: boolean }): Promise<T[]>;
      update(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<T>;
      updateMany(args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
        allowFullTableScan?: boolean;
      }): Promise<{ count: number }>;
      delete(args: { where: Record<string, unknown> }): Promise<T>;
      deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
      findMany(args: { where: Record<string, unknown>; warnOnUnlimited?: boolean }): Promise<T[]>;
      findUnique(args: { where: Record<string, unknown>; with?: Record<string, unknown> }): Promise<T | null>;
    };
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Separates scalar data fields from relation operation fields.
 *
 * A key is treated as a relation field only when:
 * 1. It matches a relation name in `tableMeta.relations`
 * 2. Its value is a non-null, non-array, non-Date plain object
 *
 * Everything else goes into `scalars`.
 */
export function extractRelationFields(data: Record<string, unknown>, tableMeta: TableMetadata): ExtractedFields {
  const scalars: Record<string, unknown> = {};
  const relations: Record<string, Record<string, unknown>> = {};

  for (const [key, value] of Object.entries(data)) {
    if (
      Object.hasOwn(tableMeta.relations, key) &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !(value instanceof Date)
    ) {
      relations[key] = value as Record<string, unknown>;
    } else {
      scalars[key] = value;
    }
  }

  return { scalars, relations };
}

/**
 * Quick check: does `data` contain any relation fields that would trigger
 * the nested write path? Used by QueryInterface to decide whether to
 * delegate to the nested write engine or take the fast scalar-only path.
 */
export function hasRelationFields(data: Record<string, unknown>, tableMeta: TableMetadata): boolean {
  for (const key of Object.keys(data)) {
    if (Object.hasOwn(tableMeta.relations, key)) {
      const val = data[key];
      if (val !== null && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Inject the parent row's PK value(s) as FK field(s) into child data.
 * Handles composite keys. Returns a new object (does not mutate input).
 */
export function injectForeignKey(
  childData: Record<string, unknown>,
  relation: RelationDef,
  parentRow: Record<string, unknown>,
  schema: SchemaMetadata,
): Record<string, unknown> {
  const fks = normalizeKeyColumns(relation.foreignKey);
  const refs = normalizeKeyColumns(relation.referenceKey);
  const childTable = schema.tables[relation.to];
  const result = { ...childData };

  for (let i = 0; i < fks.length; i++) {
    const fkCol = fks[i]!;
    const refCol = refs[i]!;
    const refField = schema.tables[relation.from]?.reverseColumnMap[refCol] ?? refCol;
    const fkField = childTable?.reverseColumnMap[fkCol] ?? fkCol;
    assignByColumn(result, childTable, fkField, parentRow[refField]);
  }

  return result;
}

/**
 * Set `field` on `target`, first dropping any OTHER key that names the SAME
 * column.
 *
 * The engine always writes the canonical FIELD spelling, while a caller's own
 * `data` may legally spell the same column its snake_case way (the write
 * builders resolve both). Overwriting only the identical key left both in the
 * object, and the INSERT/UPDATE then named one column twice, which PostgreSQL
 * refuses (42701 "specified more than once"). Dropping the alias makes the
 * column spelling behave exactly as the field spelling always did: the value the
 * relation dictates wins.
 *
 * Only SCALAR keys are droppable. A relation is resolved to a column by the very
 * same rule (nothing stops a schema from naming a relation the way a column is
 * spelled), but a relation key carries a nested write rather than a value, so
 * dropping it would discard the whole operation silently, a strictly worse
 * outcome than the duplicate-column error this drop exists to prevent. The
 * relation-shape test matches {@link splitData}, so a key routed to `relations`
 * there is never treated as an alias here.
 */
function assignByColumn(
  target: Record<string, unknown>,
  meta: TableMetadata | undefined,
  field: string,
  value: unknown,
): void {
  const column = meta && resolveColumnName(meta, field);
  if (column) {
    for (const key of Object.keys(target)) {
      if (key === field || isRelationEntry(meta, key, target[key])) continue;
      if (resolveColumnName(meta, key) === column) delete target[key];
    }
  }
  target[field] = value;
}

/** Does `key` name a relation on `meta` AND carry a nested-write payload? */
function isRelationEntry(meta: TableMetadata, key: string, value: unknown): boolean {
  return (
    Object.hasOwn(meta.relations, key) &&
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

/**
 * Split rows destined for `createMany` into CONTIGUOUS runs that each name the
 * same fields.
 *
 * `createMany` compiles ONE statement whose column list comes from the first
 * row, so it refuses a batch whose rows disagree about which fields they name
 * (`assertUniformCreateManyRows` in query/writes.ts): a field a later row omits
 * would be bound as NULL over that column's default, and a field only a later
 * row names would be dropped. Rows that arrive as ordinary user input, a nested
 * `create: [...]` array or a Prisma-shaped `createMany` on the compat layer, are
 * allowed to mix shapes, so the caller splits the batch instead of refusing it
 * and issues one `createMany` per run. Every run is internally uniform, so the
 * refusal still stands where it matters and none of the corruption it exists to
 * stop becomes reachable.
 *
 * Runs are CONTIGUOUS rather than grouped by shape across the whole array: one
 * statement inserted the rows in array order, and running contiguous runs in
 * order keeps that, so generated keys stay ascending with the caller's array.
 * Grouping non-adjacent rows would batch harder (`A B A B` in two statements
 * rather than four) at the cost of reordering rows, which is observable through
 * any server-assigned sequence.
 *
 * A uniform array, the overwhelmingly common shape, yields exactly one run
 * holding the ORIGINAL array, so the caller makes the one call it always made.
 *
 * A key whose value is `undefined` is not named, matching `definedKeys` in
 * query/writes.ts (and single-row `create`).
 *
 * @internal shared by the nested-write batch path and turbine-orm/prisma-compat.
 */
export function createManyShapeRuns<T extends Record<string, unknown>>(rows: T[]): T[][] {
  if (rows.length === 0) return [];
  const runs: T[][] = [];
  let current: T[] = [];
  let currentShape = '';
  for (const row of rows) {
    const shape = rowShapeKey(row);
    if (current.length === 0) {
      currentShape = shape;
    } else if (shape !== currentShape) {
      runs.push(current);
      current = [];
      currentShape = shape;
    }
    current.push(row);
  }
  runs.push(current);
  // One run means every row agreed: hand back the caller's own array so the
  // resulting call is indistinguishable from the ungrouped one.
  return runs.length === 1 ? [rows] : runs;
}

/**
 * Order-independent identity of the fields a row names. Each key is written
 * length-prefixed so no delimiter can appear inside one: a property name may
 * legally contain any character at all, so a plain join would let two distinct
 * key sets collide on the same string.
 */
function rowShapeKey(row: Record<string, unknown>): string {
  return Object.keys(row)
    .filter((k) => row[k] !== undefined)
    .sort()
    .map((k) => `${k.length}:${k}`)
    .join(',');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function toArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * Stringified comparison key for a key value, matching `keyOf` in
 * query/batched-loader.ts (the loader stitches parent and child rows across two
 * tables the same way).
 *
 * Two rows read from DIFFERENT tables go through different column parsers, so
 * the same logical key can arrive as `1` from one and `'1'` from the other (a
 * bigint junction column read as text next to a numeric target primary key).
 * Strict identity also fails outright for object-valued keys: two `Date`s or two
 * `Buffer`s holding the same value are never `===`, so a `Set` of them
 * de-duplicates nothing. Comparing on the string form makes both work.
 */
function keyOf(value: unknown): string {
  return String(value);
}

/**
 * Validate that all operation keys in a nested write are recognized and
 * allowed for the current context (create vs update).
 */
function validateOps(relationName: string, ops: Record<string, unknown>, isUpdate: boolean): void {
  for (const opName of Object.keys(ops)) {
    if (!CREATE_ONLY_OPS.has(opName) && !UPDATE_ONLY_OPS.has(opName)) {
      throw new ValidationError(
        `[turbine] Unknown nested write operation "${opName}" on relation "${relationName}". ` +
          `Valid operations: create, connect, connectOrCreate${isUpdate ? ', disconnect, set, delete, update, upsert' : ''}.`,
      );
    }
    if (!isUpdate && UPDATE_ONLY_OPS.has(opName)) {
      throw new ValidationError(
        `[turbine] Operation "${opName}" on relation "${relationName}" is only valid inside update(), not create().`,
      );
    }
  }
}

/**
 * Build a PK-based where clause from a parent row and its table metadata.
 */
function pkWhere(tableMeta: TableMetadata, row: Record<string, unknown>): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  for (const col of tableMeta.primaryKey) {
    const field = tableMeta.reverseColumnMap[col] ?? col;
    // A PARTIAL primary key here is not a filter, it is a mass mutation.
    // `undefined` values are dropped when the where compiles, and the
    // empty-where guard only fires when NOTHING survives, so a composite PK
    // missing one member compiles to a predicate on the remaining member and
    // the statement rewrites every row that shares it. The row is supposed to
    // be one this engine just read, so a missing member is an internal fault,
    // and the only safe response is to refuse rather than to run.
    if (row[field] === undefined) {
      throw new ValidationError(
        `[turbine] Cannot address a row of "${tableMeta.name}" by primary key: "${field}" is missing from the ` +
          'row this nested write is operating on, so the generated predicate would match more rows than intended. ' +
          'This is a bug in turbine, please report it.',
      );
    }
    where[field] = row[field];
  }
  return where;
}

/**
 * The child-side predicate that ties a hasMany/hasOne relation's rows to THIS
 * parent: `child.foreignKey = parent.referenceKey`. This is the exact
 * correlation the connect/connectOrCreate/set paths already write when they
 * point a child AT the parent, read back here as a filter.
 *
 * Returns `null` when the parent's reference key is null/undefined: SQL
 * equality never matches NULL, so no child can be related and every scoped
 * operation must report not-found rather than run unscoped.
 */
function parentCorrelationWhere(
  ctx: NestedWriteContext,
  rel: RelationDef,
  parentRow: Record<string, unknown>,
): Record<string, unknown> | null {
  const fks = normalizeKeyColumns(rel.foreignKey);
  const refs = normalizeKeyColumns(rel.referenceKey);
  const childTable = ctx.schema.tables[rel.to];
  const parentTable = ctx.schema.tables[rel.from];
  const where: Record<string, unknown> = {};

  for (let i = 0; i < fks.length; i++) {
    const fkField = childTable?.reverseColumnMap[fks[i]!] ?? fks[i]!;
    const refField = parentTable?.reverseColumnMap[refs[i]!] ?? refs[i]!;
    const value = parentRow[refField];
    if (value === null || value === undefined) return null;
    where[fkField] = value;
  }
  return where;
}

/**
 * The related-side predicate for a belongsTo relation: the parent holds the
 * foreign key, so the related row this parent points at satisfies
 * `related.referenceKey = parent.foreignKey`. The mirror image of
 * {@link parentCorrelationWhere}, which reads the hasMany/hasOne direction.
 *
 * Returns `null` when the parent's foreign key is null/undefined: the parent
 * points at nothing, so no related row is in scope.
 */
function belongsToCorrelationWhere(
  ctx: NestedWriteContext,
  rel: RelationDef,
  parentRow: Record<string, unknown>,
  parentTable: string,
): Record<string, unknown> | null {
  const fks = normalizeKeyColumns(rel.foreignKey);
  const refs = normalizeKeyColumns(rel.referenceKey);
  const parentMeta = ctx.schema.tables[parentTable];
  const relatedTable = ctx.schema.tables[rel.to];
  const where: Record<string, unknown> = {};

  for (let i = 0; i < fks.length; i++) {
    const fkField = parentMeta?.reverseColumnMap[fks[i]!] ?? fks[i]!;
    const refField = relatedTable?.reverseColumnMap[refs[i]!] ?? refs[i]!;
    const value = parentRow[fkField];
    if (value === null || value === undefined) return null;
    where[refField] = value;
  }
  return where;
}

/**
 * AND the caller-supplied child `where` with the parent correlation so a nested
 * delete/update/disconnect can only ever touch rows that actually belong to the
 * parent being written.
 *
 * The flat merge is used whenever the two predicates name disjoint fields (the
 * overwhelmingly common case: the caller addresses the child by its primary
 * key). It keeps every caller key at the top level, so compound-unique selector
 * expansion still sees them. When the caller's `where` names a correlation
 * field itself, the two are combined with `AND` instead, so neither predicate
 * can silently overwrite the other.
 */
function scopeWhereToParent(
  target: Record<string, unknown>,
  correlation: Record<string, unknown>,
): Record<string, unknown> {
  for (const key of Object.keys(correlation)) {
    if (Object.hasOwn(target, key)) return { AND: [target, correlation] };
  }
  return { ...target, ...correlation };
}

/**
 * The caller's own selector must name at least one bound value.
 *
 * The parent correlation is ANDed onto every nested delete/update/disconnect
 * target, which makes the merged predicate non-empty by construction. That
 * defeats the empty-where guard downstream: `delete: {}` or
 * `delete: { id: req.body.postId }` with an undefined body field would compile
 * to `WHERE user_id = $1` and remove EVERY child of this parent instead of
 * throwing. So the caller's half is checked here, before the merge.
 *
 * `true` is accepted only on a to-one relation, where it means "the single
 * related row" and the correlation alone identifies it. On a to-many it would
 * mean "all of them", which is never what a caller spelled `delete: true` for.
 */
function assertTargetSelectsSomething(target: unknown, op: string, relName: string, rel: RelationDef): void {
  const toOne = rel.type === 'hasOne' || rel.type === 'belongsTo';
  if (target === true) {
    if (toOne) return;
    throw new ValidationError(
      `[turbine] Nested ${op} on to-many relation "${relName}" needs a "where" selector: ` +
        `"${op}: true" would ${op} every related "${rel.to}" row.`,
    );
  }
  if (target && typeof target === 'object' && !Array.isArray(target)) {
    const bound = Object.values(target as Record<string, unknown>).some((v) => v !== undefined);
    if (bound) return;
  }
  throw new ValidationError(
    `[turbine] Nested ${op} on relation "${relName}" requires a selector with at least one defined value. ` +
      `An empty or all-undefined "where" would ${op} every related "${rel.to}" row of this parent.`,
  );
}

/**
 * The many-to-many nested-write operations that DO write junction rows:
 * `connect`, `disconnect` and `set`. Everything else (create, connectOrCreate,
 * delete, update, upsert) would have to write the TARGET row as well, and there
 * is no safe default for the junction's own extra columns, so those still
 * refuse loudly. Falling off the end of the dispatch instead would drop the
 * write silently and report success.
 */
const M2M_SUPPORTED_OPS = new Set(['connect', 'disconnect', 'set']);

/**
 * How to reach a junction table's write accessor, spelled per client because the
 * two clients expose it under DIFFERENT keys.
 *
 * On the core client the auto-created property accessors are CAMELCASED
 * (`db.userTags` for `user_tags`, see the `Object.defineProperty` loops in
 * client.ts), so `db["user_tags"]` is `undefined` for every snake_case junction
 * - which is every junction `turbine pull` produces over a hand-written join
 * table. `db.table("user_tags")` takes the raw table name and exists on both
 * TurbineClient and the TransactionClient handed to `$transaction`, so that is
 * the form to recommend.
 *
 * The prisma-compat client has no `table()` method at all; it exposes each
 * junction as a model delegate keyed by the RAW table name (`junctionModels` in
 * prisma-compat.ts), inside `$transaction` too.
 */
function junctionAccessorHint(junction: string): string {
  return (
    `db.table("${junction}").create / createMany on the core client (inside $transaction too), ` +
    `or db["${junction}"].create / createMany on the prisma-compat client`
  );
}

/**
 * The refusal for a many-to-many nested operation that is still unsupported.
 * Names the operation, the ones that ARE supported, and a remedy that is
 * actually reachable on the reader's client (see {@link junctionAccessorHint}).
 */
function manyToManyOpUnsupported(op: string, relName: string, rel: RelationDef): ValidationError {
  const junction = rel.through?.table ?? 'junction';
  return new ValidationError(
    `[turbine] Nested "${op}" is not supported on the many-to-many relation "${relName}" ` +
      `(via the "${junction}" junction table). The supported many-to-many nested operations are ` +
      `connect, disconnect and set. To ${op} a "${rel.to}" row itself, write it directly on the ` +
      `"${rel.to}" table inside the same $transaction and link it with a nested connect; to write ` +
      `link rows by hand, use the junction accessor: ${junctionAccessorHint(junction)}.`,
  );
}

/** Refuse every op on an m2m relation that the junction-write path does not handle. */
function assertManyToManyOpsSupported(relName: string, rel: RelationDef, ops: Record<string, unknown>): void {
  for (const op of Object.keys(ops)) {
    if (!M2M_SUPPORTED_OPS.has(op)) throw manyToManyOpUnsupported(op, relName, rel);
  }
}

/**
 * Everything a junction write needs, resolved once per relation operation from
 * the SAME `through` descriptor the read path uses (see `buildManyToManySubquery`
 * in query/relations.ts): the junction table, the field names of its source and
 * target key columns, the parent's reference-key VALUE, and the target table's
 * primary-key field (the column `through.targetKey` points at).
 */
interface JunctionPlan {
  /** Junction table name. */
  table: string;
  /** Junction field holding the source (parent) key. */
  sourceField: string;
  /** Junction field holding the target key. */
  targetField: string;
  /** This parent's reference-key value, the only source key a write may use. */
  parentValue: unknown;
  /** Target-table field whose value goes into `targetField`. */
  targetKeyField: string;
  /**
   * True when the junction declares the (source, target) PAIR unique, a
   * two-column primary key, unique constraint, or full (non-partial) unique
   * index over exactly those two columns.
   *
   * Every junction INTROSPECTION can detect is one of these by construction
   * (`addAutoManyToManyRelations` accepts only a two-column PK or a two-column
   * UNIQUE over exactly the two FK columns), so this is true on the generated
   * path. A hand-declared `defineSchema` manyToMany can name a junction with no
   * constraint at all, and there `ON CONFLICT DO NOTHING` would dedupe nothing:
   * see {@link processManyToManyConnect}.
   */
  pairIsUnique: boolean;
}

/**
 * Does the junction constrain the (source, target) pair to at most one row?
 * Only a key over EXACTLY the two columns qualifies: a unique over a superset
 * permits duplicate pairs, and a PARTIAL unique index only constrains the rows
 * matching its predicate.
 */
function junctionPairIsUnique(junctionMeta: TableMetadata, sourceCol: string, targetCol: string): boolean {
  const covers = (cols: readonly string[]): boolean =>
    cols.length === 2 && cols.includes(sourceCol) && cols.includes(targetCol);

  if (covers(junctionMeta.primaryKey)) return true;
  if ((junctionMeta.uniqueColumns ?? []).some(covers)) return true;
  return (junctionMeta.indexes ?? []).some((idx) => idx.unique && !idx.partial && !idx.docPath && covers(idx.columns));
}

/**
 * Resolve the junction descriptor for a many-to-many nested write.
 *
 * Composite source/target keys are refused rather than guessed: a multi-column
 * link row cannot be addressed with the single-column `in (...)` predicates the
 * batched junction writes below use, and emitting a partially-keyed delete would
 * unlink rows the caller never named.
 */
function junctionPlan(
  ctx: NestedWriteContext,
  rel: RelationDef,
  relName: string,
  parentRow: Record<string, unknown>,
): JunctionPlan {
  const through = rel.through;
  if (!through) {
    throw new ValidationError(
      `[turbine] manyToMany relation "${relName}" is missing a \`through\` junction descriptor.`,
    );
  }
  const junctionMeta = ctx.schema.tables[through.table];
  if (!junctionMeta) {
    throw new ValidationError(
      `[turbine] Nested write on the many-to-many relation "${relName}": junction table ` +
        `"${through.table}" is not present in the schema metadata, so its rows cannot be written. ` +
        `Regenerate the schema (turbine generate) so the junction table is included.`,
    );
  }
  const targetMeta = ctx.schema.tables[rel.to];
  if (!targetMeta) {
    throw new ValidationError(
      `[turbine] Nested write on the many-to-many relation "${relName}": unknown target table "${rel.to}".`,
    );
  }

  const sourceKeys = normalizeKeyColumns(through.sourceKey);
  const targetKeys = normalizeKeyColumns(through.targetKey);
  const refKeys = normalizeKeyColumns(rel.referenceKey);
  const targetPk = targetMeta.primaryKey;
  if (sourceKeys.length !== 1 || targetKeys.length !== 1 || refKeys.length !== 1 || targetPk.length !== 1) {
    throw new ValidationError(
      `[turbine] Nested writes on the many-to-many relation "${relName}" (via "${through.table}") support ` +
        `single-column junction keys only; this relation links on composite keys ` +
        `(source ${sourceKeys.length}, target ${targetKeys.length}, target primary key ${targetPk.length} column(s)). ` +
        `Write the junction rows directly inside the same $transaction: ${junctionAccessorHint(through.table)}.`,
    );
  }

  // The two junction columns must DIFFER. When they collide (a `through` typo
  // that names one column twice) every predicate and every inserted row this
  // module builds is keyed by ONE object property, so the source key silently
  // overwrites the target key: the disconnect predicate loses its parent scope
  // and deletes other parents' link rows, and the inserted row carries no parent
  // key at all. Introspection can never produce this (it requires two distinct
  // FK columns), but a hand-declared `defineSchema` manyToMany can.
  if (sourceKeys[0] === targetKeys[0]) {
    throw new ValidationError(
      `[turbine] Nested write on the many-to-many relation "${relName}" cannot run: the junction ` +
        `"${through.table}" names the same column "${sourceKeys[0]}" as BOTH its sourceKey and its ` +
        `targetKey, so a link row cannot hold the parent key and the target key at once. Fix the ` +
        `relation's \`through\` descriptor to name the two distinct junction columns.`,
    );
  }

  const parentField = ctx.schema.tables[rel.from]?.reverseColumnMap[refKeys[0]!] ?? refKeys[0]!;
  const parentValue = parentRow[parentField];
  if (parentValue === null || parentValue === undefined) {
    throw new ValidationError(
      `[turbine] Nested write on the many-to-many relation "${relName}" cannot run: the parent's reference ` +
        `key "${parentField}" is ${parentValue === null ? 'null' : 'missing from the loaded row'}, so no ` +
        `junction row can be correlated to this parent.`,
    );
  }

  return {
    table: through.table,
    sourceField: junctionMeta.reverseColumnMap[sourceKeys[0]!] ?? sourceKeys[0]!,
    targetField: junctionMeta.reverseColumnMap[targetKeys[0]!] ?? targetKeys[0]!,
    parentValue,
    targetKeyField: targetMeta.reverseColumnMap[targetPk[0]!] ?? targetPk[0]!,
    pairIsUnique: junctionPairIsUnique(junctionMeta, sourceKeys[0]!, targetKeys[0]!),
  };
}

/** The E003 for a target selector that matched no row. */
function noTargetRow(op: string, relName: string, rel: RelationDef, target: unknown): ValidationError {
  return new ValidationError(
    `[turbine] Nested ${op} on the many-to-many relation "${relName}": no "${rel.to}" row found ` +
      `matching ${describeTargetForMessage(target)}.`,
  );
}

/**
 * The plain primary-key values of `items` when EVERY selector is simple
 * equality on the target's primary key (`{ id: 7 }`), else `null`.
 *
 * This is the overwhelmingly common connect payload, and it is the only shape
 * that can be resolved by one `IN (...)` read: anything else (a secondary
 * unique, a compound-unique selector, an operator object like
 * `{ id: { in: [...] } }`, a multi-key selector) still needs its own
 * `findUnique` to know WHICH row it names.
 */
function simplePkSelectors(items: Record<string, unknown>[], targetKeyField: string): unknown[] | null {
  const values: unknown[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const keys = Object.keys(item);
    if (keys.length !== 1 || keys[0] !== targetKeyField) return null;
    const value = item[targetKeyField];
    if (value === null || value === undefined) return null;
    // An operator object (`{ gt: 1 }`, `{ in: [...] }`) is not an equality
    // selector. Date and Buffer keys are objects too; they ARE plain values, but
    // they are rare enough that routing them down the per-selector path costs
    // nothing and keeps this test to one cheap rule.
    if (typeof value === 'object') return null;
    values.push(value);
  }
  return values;
}

/**
 * Resolve each caller-supplied target selector to the target row's key value,
 * de-duplicated in first-seen order. A selector that matches no row is refused:
 * silently skipping it is exactly the failure mode this path exists to remove.
 *
 * A payload of plain primary-key selectors (see {@link simplePkSelectors}) is
 * resolved with ONE `IN (...)` read instead of a `findUnique` per target, so a
 * 20-target connect costs one round trip rather than twenty. The per-selector
 * path stays for arbitrary unique selectors, and BOTH refuse a target that does
 * not exist, naming it.
 */
async function resolveJunctionTargets(
  ctx: NestedWriteContext,
  rel: RelationDef,
  relName: string,
  plan: JunctionPlan,
  op: string,
  items: Record<string, unknown>[],
): Promise<unknown[]> {
  for (const target of items) assertTargetSelectsSomething(target, op, relName, rel);

  const pkValues = simplePkSelectors(items, plan.targetKeyField);
  if (pkValues) return resolveJunctionTargetsByPk(ctx, rel, relName, plan, op, pkValues);

  const values: unknown[] = [];
  const seen = new Set<string>();
  for (const target of items) {
    const row = (await ctx.tx.table(rel.to).findUnique({ where: target })) as Record<string, unknown> | null;
    if (!row) throw noTargetRow(op, relName, rel, target);
    const value = row[plan.targetKeyField];
    if (value === null || value === undefined) {
      throw new ValidationError(
        `[turbine] Nested ${op} on the many-to-many relation "${relName}": the "${rel.to}" row matching ` +
          `${describeTargetForMessage(target)} has no "${plan.targetKeyField}" value to link.`,
      );
    }
    const key = keyOf(value);
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(value);
  }
  return values;
}

/** One-read resolution for a payload of plain primary-key selectors. */
async function resolveJunctionTargetsByPk(
  ctx: NestedWriteContext,
  rel: RelationDef,
  relName: string,
  plan: JunctionPlan,
  op: string,
  pkValues: unknown[],
): Promise<unknown[]> {
  const wanted: unknown[] = [];
  const seen = new Set<string>();
  for (const value of pkValues) {
    const key = keyOf(value);
    if (seen.has(key)) continue;
    seen.add(key);
    wanted.push(value);
  }
  if (wanted.length === 0) return [];

  const rows = (await ctx.tx.table(rel.to).findMany({
    where: { [plan.targetKeyField]: { in: wanted } },
    warnOnUnlimited: false,
  })) as Record<string, unknown>[];

  // Keyed by string, so a target primary key read back in a different shape than
  // the caller wrote it (a bigint `1` for a supplied `'1'`) still matches.
  const found = new Map<string, unknown>();
  for (const row of rows) {
    const value = row[plan.targetKeyField];
    if (value === null || value === undefined) continue;
    found.set(keyOf(value), value);
  }

  // The DB-side value is returned, not the caller's, so the junction insert
  // writes the same shape the per-selector path would.
  return wanted.map((value) => {
    const hit = found.get(keyOf(value));
    if (hit === undefined) throw noTargetRow(op, relName, rel, { [plan.targetKeyField]: value });
    return hit;
  });
}

/** The junction rows linking this parent to `values`. */
function junctionRows(plan: JunctionPlan, values: unknown[]): Record<string, unknown>[] {
  return values.map((v) => ({ [plan.sourceField]: plan.parentValue, [plan.targetField]: v }));
}

/** The `feature` string both refusing engines tag their skipDuplicates E017 with. */
const SKIP_DUPLICATES_FEATURE = 'createMany({ skipDuplicates: true })';

/**
 * Per-schema memo of whether the bound engine accepts
 * `createMany({ skipDuplicates })`, so the engines that refuse it pay for the
 * refusal once instead of on every connect.
 *
 * The capability is not reachable from here as a flag, the `Dialect` is private
 * to QueryInterface / TurbineClient and `NestedWriteContext` carries only the
 * schema and the transaction, so it is read from the engine's OWN structured
 * refusal (`UnsupportedFeatureError.feature`) rather than from a hardcoded
 * engine list that would drift. Both refusing engines throw while BUILDING the
 * statement, before anything is written, so the attempt is side-effect-free.
 *
 * Getting the memo wrong is harmless in both directions: a stale `false` only
 * costs the read-then-insert fallback, and a stale `true` is re-detected and
 * corrected by the same catch.
 */
const skipDuplicatesSupport = new WeakMap<SchemaMetadata, boolean>();

/**
 * Insert the link rows with `ON CONFLICT DO NOTHING` semantics. Returns false
 * (having written nothing) when the engine refuses the option, so the caller can
 * fall back.
 */
async function insertJunctionRowsSkippingDuplicates(
  ctx: NestedWriteContext,
  plan: JunctionPlan,
  values: unknown[],
): Promise<boolean> {
  if (skipDuplicatesSupport.get(ctx.schema) === false) return false;
  try {
    await ctx.tx.table(plan.table).createMany({ data: junctionRows(plan, values), skipDuplicates: true });
    skipDuplicatesSupport.set(ctx.schema, true);
    return true;
  } catch (err) {
    if (err instanceof UnsupportedFeatureError && err.feature === SKIP_DUPLICATES_FEATURE) {
      skipDuplicatesSupport.set(ctx.schema, false);
      return false;
    }
    throw err;
  }
}

/**
 * `connect`: link this parent to each target, idempotently.
 *
 * Two strategies, because idempotence has to survive CONCURRENCY:
 *
 * 1. Junction constrains the pair AND the engine supports `skipDuplicates`
 *    (PostgreSQL, SQLite and MySQL: `ON CONFLICT DO NOTHING` / a no-op
 *    `ON DUPLICATE KEY UPDATE`), one INSERT, no read. The engine resolves the
 *    conflict, so two transactions connecting the same pair at the same time
 *    both succeed and one link row exists. This is the introspected path:
 *    every junction introspection can detect declares the pair unique.
 * 2. Otherwise, read this parent's existing link rows for exactly these targets
 *    and insert only the missing ones. Used when the engine refuses the option
 *    (SQL Server and PowDB have no single-statement skip-duplicates form and
 *    throw E017), and when the junction does NOT constrain the pair, where
 *    `ON CONFLICT DO NOTHING` has no constraint to fire on and would let a
 *    repeated connect insert a second link row. Read-then-insert is not
 *    concurrency-safe (both transactions can read "missing"); on an unconstrained
 *    junction nothing available here is, and this at least keeps a serially
 *    repeated connect idempotent.
 */
async function processManyToManyConnect(
  ctx: NestedWriteContext,
  rel: RelationDef,
  relName: string,
  plan: JunctionPlan,
  items: Record<string, unknown>[],
): Promise<void> {
  if (items.length === 0) return;
  const values = await resolveJunctionTargets(ctx, rel, relName, plan, 'connect', items);
  if (values.length === 0) return;

  if (plan.pairIsUnique && (await insertJunctionRowsSkippingDuplicates(ctx, plan, values))) return;

  const existing = (await ctx.tx.table(plan.table).findMany({
    where: { [plan.sourceField]: plan.parentValue, [plan.targetField]: { in: values } },
    // An internal engine read: never lecture the caller about a missing `limit`
    // on a statement they did not write.
    warnOnUnlimited: false,
  })) as Record<string, unknown>[];
  // Compared as strings: the junction column and the target primary key are read
  // through DIFFERENT tables' parsers, so an already-linked pair can arrive as
  // `'1'` here and `1` there, and strict identity would re-insert it.
  const linked = new Set(existing.map((r) => keyOf(r[plan.targetField])));
  const missing = values.filter((v) => !linked.has(keyOf(v)));
  if (missing.length === 0) return;

  await ctx.tx.table(plan.table).createMany({ data: junctionRows(plan, missing) });
}

/**
 * `disconnect`: remove the link rows for exactly the named targets.
 *
 * Scoped by BOTH keys in one statement. A delete scoped by the source key alone
 * would unlink every target of this parent, and one scoped by the target key
 * alone would unlink OTHER parents' rows.
 */
async function processManyToManyDisconnect(
  ctx: NestedWriteContext,
  rel: RelationDef,
  relName: string,
  plan: JunctionPlan,
  items: Record<string, unknown>[],
): Promise<void> {
  if (items.length === 0) return;
  const values = await resolveJunctionTargets(ctx, rel, relName, plan, 'disconnect', items);
  if (values.length === 0) return;

  await ctx.tx.table(plan.table).deleteMany({
    where: { [plan.sourceField]: plan.parentValue, [plan.targetField]: { in: values } },
  });
}

/**
 * `set`: replace this parent's whole link set, in one transaction.
 *
 * `set: []` clears every link of this parent (Prisma's semantics, and the same
 * choice the hasMany/hasOne `set` path already makes). The clearing delete is
 * always scoped by the source key, so it can never touch another parent's rows.
 */
async function processManyToManySet(
  ctx: NestedWriteContext,
  rel: RelationDef,
  relName: string,
  plan: JunctionPlan,
  items: Record<string, unknown>[],
): Promise<void> {
  const values = await resolveJunctionTargets(ctx, rel, relName, plan, 'set', items);

  await ctx.tx.table(plan.table).deleteMany({ where: { [plan.sourceField]: plan.parentValue } });
  if (values.length === 0) return;
  await ctx.tx.table(plan.table).createMany({ data: junctionRows(plan, values) });
}

/**
 * Run every supported junction operation for one many-to-many relation, in the
 * order the caller's payload implies: `set` (a full replacement) first, then
 * `disconnect`, then `connect`.
 */
async function processManyToMany(
  ctx: NestedWriteContext,
  rel: RelationDef,
  relName: string,
  ops: Record<string, unknown>,
  parentRow: Record<string, unknown>,
): Promise<void> {
  assertManyToManyOpsSupported(relName, rel, ops);
  if (ops.set === undefined && ops.disconnect === undefined && ops.connect === undefined) return;

  const plan = junctionPlan(ctx, rel, relName, parentRow);
  if (ops.set !== undefined) {
    await processManyToManySet(
      ctx,
      rel,
      relName,
      plan,
      toArray(ops.set as Record<string, unknown> | Record<string, unknown>[]),
    );
  }
  if (ops.disconnect !== undefined) {
    await processManyToManyDisconnect(
      ctx,
      rel,
      relName,
      plan,
      toArray(ops.disconnect as Record<string, unknown> | Record<string, unknown>[]),
    );
  }
  if (ops.connect !== undefined) {
    await processManyToManyConnect(
      ctx,
      rel,
      relName,
      plan,
      toArray(ops.connect as Record<string, unknown> | Record<string, unknown>[]),
    );
  }
}

/**
 * The E001 raised when a nested delete/update/disconnect target is not a child
 * of this parent (it belongs to another parent, or does not exist at all).
 * Matches Prisma's behavior: the nested where is scoped to the relation, so a
 * row outside the relation is simply "not found".
 */
function notRelatedToParent(op: string, relName: string, rel: RelationDef, target: unknown): NotFoundError {
  // Object form, not the legacy string one: `err.table` / `err.where` /
  // `err.operation` are a documented part of the NotFoundError contract, and a
  // string-constructed error silently drops all three.
  return new NotFoundError({
    table: rel.to,
    where: target,
    operation: `nested ${op}`,
    message:
      `[turbine] Nested ${op} on relation "${relName}": no "${rel.to}" record matching ` +
      `${describeTargetForMessage(target)} is related to this parent. Either it does not exist, ` +
      `or it belongs to a different parent (a nested ${op} can only touch this parent's rows).`,
  });
}

/** Re-tag a NotFoundError from a scoped child write as a relation-scoped miss. */
function rethrowAsNotRelated(err: unknown, op: string, relName: string, rel: RelationDef, target: unknown): never {
  if (err instanceof NotFoundError) {
    // Only re-tag a miss on THIS relation's own write. A NotFoundError raised
    // deeper in the tree already names its own relation, and re-tagging it here
    // would rename someone else's failure; keep it, and preserve the original
    // as `cause` in either direction.
    if (err.operation?.startsWith('nested ')) throw err;
    const tagged = notRelatedToParent(op, relName, rel, target);
    (tagged as { cause?: unknown }).cause ??= err;
    throw tagged;
  }
  throw err;
}

// ---------------------------------------------------------------------------
// executeNestedCreate
// ---------------------------------------------------------------------------

/**
 * Tree-walking create: inserts the parent row, then processes each relation
 * operation (create, connect, connectOrCreate), and finally reads back the
 * full tree using `findUnique` with an auto-built `with` clause.
 */
export async function executeNestedCreate(
  ctx: NestedWriteContext,
  tableName: string,
  data: Record<string, unknown>,
  depth = 0,
  path: string[] = [],
): Promise<Record<string, unknown>> {
  if (depth > MAX_DEPTH) {
    throw new CircularRelationError(path);
  }

  const tableMeta = ctx.schema.tables[tableName];
  if (!tableMeta) {
    throw new ValidationError(`[turbine] Unknown table "${tableName}".`);
  }

  const { scalars, relations } = extractRelationFields(data, tableMeta);

  // Validate all relation operations
  for (const [relName, ops] of Object.entries(relations)) {
    const rel = tableMeta.relations[relName];
    if (!rel) {
      throw new RelationError(
        `[turbine] Unknown relation "${relName}" on table "${tableName}". ` +
          `Available relations: ${Object.keys(tableMeta.relations).join(', ') || '(none)'}.`,
      );
    }
    validateOps(relName, ops, false);
  }

  // belongsTo relations put the foreign key on the PARENT row, so they must be
  // resolved BEFORE the parent is inserted, otherwise a NOT NULL FK column
  // fails on the initial INSERT. We resolve each belongsTo op (create/connect/
  // connectOrCreate) to its referenced row and fold the FK values into the
  // parent's own INSERT.
  const belongsToFks: Record<string, unknown> = {};
  for (const [relName, ops] of Object.entries(relations)) {
    const rel = tableMeta.relations[relName]!;
    if (rel.type === 'belongsTo') {
      Object.assign(belongsToFks, await resolveBelongsToForCreate(ctx, rel, ops, tableName, depth, path, relName));
    } else if (rel.type === 'manyToMany') {
      // Validated BEFORE the parent insert so an unsupported m2m op refuses
      // without having written anything; the junction rows themselves need the
      // parent's key, so they are written after the insert (below).
      assertManyToManyOpsSupported(relName, rel, ops);
    }
  }

  // Insert the parent row (scalars + resolved belongsTo foreign keys). The
  // resolved keys win over a caller-supplied value for the same column under
  // either spelling (see assignByColumn), so `{ authorId: 1, author: { connect } }`
  // and `{ author_id: 1, author: { connect } }` both take the connected row.
  const parentData: Record<string, unknown> = { ...scalars };
  for (const [field, value] of Object.entries(belongsToFks)) {
    assignByColumn(parentData, tableMeta, field, value);
  }
  const parentRow = (await ctx.tx.table(tableName).create({ data: parentData })) as Record<string, unknown>;

  // Process hasMany / hasOne relations, their FK lives on the CHILD, so they
  // need the parent row to exist first.
  for (const [relName, ops] of Object.entries(relations)) {
    const rel = tableMeta.relations[relName]!;
    if (rel.type === 'hasMany' || rel.type === 'hasOne') {
      await processHasManyCreate(ctx, rel, ops, parentRow, depth, path, relName);
    } else if (rel.type === 'manyToMany') {
      // The junction row carries the parent's key, so it can only be written
      // once the parent row exists. Same transaction, same ordering rule the
      // hasMany path follows.
      await processManyToMany(ctx, rel, relName, ops, parentRow);
    }
  }

  // Build the `with` clause for the final read to return the full tree
  const withClause: Record<string, true> = {};
  for (const relName of Object.keys(relations)) {
    withClause[relName] = true;
  }

  // Final read using existing json_agg machinery
  const fullRow = await ctx.tx.table(tableName).findUnique({
    where: pkWhere(tableMeta, parentRow),
    with: Object.keys(withClause).length > 0 ? withClause : undefined,
  });

  return (fullRow ?? parentRow) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// executeNestedUpdate
// ---------------------------------------------------------------------------

/**
 * Tree-walking update: updates the parent row with scalar data, then
 * processes each relation operation (create, connect, connectOrCreate,
 * disconnect, set, delete), and reads back the full tree.
 */
export async function executeNestedUpdate(
  ctx: NestedWriteContext,
  tableName: string,
  where: Record<string, unknown>,
  data: Record<string, unknown>,
  depth = 0,
  path: string[] = [],
): Promise<Record<string, unknown>> {
  if (depth > MAX_DEPTH) {
    throw new CircularRelationError(path);
  }

  const tableMeta = ctx.schema.tables[tableName];
  if (!tableMeta) {
    throw new ValidationError(`[turbine] Unknown table "${tableName}".`);
  }

  const { scalars, relations } = extractRelationFields(data, tableMeta);

  // Validate all relation operations
  for (const [relName, ops] of Object.entries(relations)) {
    const rel = tableMeta.relations[relName];
    if (!rel) {
      throw new RelationError(
        `[turbine] Unknown relation "${relName}" on table "${tableName}". ` +
          `Available relations: ${Object.keys(tableMeta.relations).join(', ') || '(none)'}.`,
      );
    }
    validateOps(relName, ops, true);
  }

  // Update parent row with scalar data (may be empty if only relation ops)
  let parentRow: Record<string, unknown>;
  if (Object.keys(scalars).length > 0) {
    parentRow = (await ctx.tx.table(tableName).update({ where, data: scalars })) as Record<string, unknown>;
  } else {
    parentRow = (await ctx.tx.table(tableName).findUnique({ where })) as Record<string, unknown>;
    if (!parentRow) {
      throw new ValidationError(
        `[turbine] update: no ${tableName} row found matching ${describeTargetForMessage(where)}.`,
      );
    }
  }

  // Process each relation
  for (const [relName, ops] of Object.entries(relations)) {
    const rel = tableMeta.relations[relName]!;

    if (rel.type === 'hasMany' || rel.type === 'hasOne') {
      // create, connect, connectOrCreate, same as nested create
      await processHasManyCreate(ctx, rel, ops, parentRow, depth, path, relName);

      // disconnect
      if (ops.disconnect !== undefined) {
        await processDisconnect(ctx, rel, ops.disconnect, relName, parentRow);
      }

      // set
      if (ops.set !== undefined) {
        await processSet(ctx, rel, ops.set as Record<string, unknown>[], parentRow);
      }

      // delete
      if (ops.delete !== undefined) {
        await processDelete(ctx, rel, ops.delete, relName, parentRow);
      }

      // update
      if (ops.update !== undefined) {
        await processNestedUpdate(ctx, rel, ops.update, relName, parentRow);
      }

      // upsert
      if (ops.upsert !== undefined) {
        await processNestedUpsert(ctx, rel, ops.upsert, parentRow, relName);
      }
    } else if (rel.type === 'belongsTo') {
      await processBelongsToCreate(ctx, rel, ops, parentRow, tableName, depth, path, relName);

      // update (belongsTo, derive where from parent FK)
      if (ops.update !== undefined) {
        await processBelongsToUpdate(ctx, rel, ops.update, parentRow, tableName);
      }

      // upsert (belongsTo)
      if (ops.upsert !== undefined) {
        await processBelongsToUpsert(ctx, rel, ops.upsert, parentRow, tableName);
      }

      if (ops.disconnect !== undefined) {
        // For belongsTo disconnect, null out the FK on the parent
        const fks = normalizeKeyColumns(rel.foreignKey);
        const nullable = fks.every((fk) => {
          const col = tableMeta.columns.find((c) => c.name === fk);
          return col?.nullable ?? false;
        });
        if (!nullable) {
          throw new ValidationError(
            `[turbine] Cannot disconnect "${relName}": foreign key column(s) ${fks.join(', ')} are NOT NULL. Use delete instead.`,
          );
        }
        const updateData: Record<string, unknown> = {};
        for (const fk of fks) {
          const field = tableMeta.reverseColumnMap[fk] ?? fk;
          updateData[field] = null;
        }
        await ctx.tx.table(tableName).update({
          where: pkWhere(tableMeta, parentRow),
          data: updateData,
        });
      }
    } else {
      await processManyToMany(ctx, rel, relName, ops, parentRow);
    }
  }

  // Final read with all touched relations
  const withClause: Record<string, true> = {};
  for (const relName of Object.keys(relations)) {
    withClause[relName] = true;
  }

  const fullRow = await ctx.tx.table(tableName).findUnique({
    where: pkWhere(tableMeta, parentRow),
    with: Object.keys(withClause).length > 0 ? withClause : undefined,
  });

  return (fullRow ?? parentRow) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// hasMany/hasOne create operations
// ---------------------------------------------------------------------------

async function processHasManyCreate(
  ctx: NestedWriteContext,
  rel: RelationDef,
  ops: Record<string, unknown>,
  parentRow: Record<string, unknown>,
  depth: number,
  path: string[],
  relName: string,
): Promise<void> {
  // create
  if (ops.create !== undefined) {
    const items = toArray(ops.create as Record<string, unknown> | Record<string, unknown>[]);
    if (items.length > 0) {
      // Check if any items have nested relations (need per-row recursion)
      const childTable = ctx.schema.tables[rel.to];
      const hasNested =
        childTable && items.some((item) => Object.keys(item).some((k) => Object.hasOwn(childTable.relations ?? {}, k)));

      if (hasNested) {
        // Per-row recursive create for items with nested relations
        for (const item of items) {
          const injected = injectForeignKey(item, rel, parentRow, ctx.schema);
          await executeNestedCreate(ctx, rel.to, injected, depth + 1, [...path, relName]);
        }
      } else {
        // Batch via createMany (UNNEST), fast path.
        //
        // A nested `create: [...]` array is ordinary user input and may
        // legitimately mix row shapes (`[{ title }, { title, published }]`),
        // which one createMany cannot express, see createManyShapeRuns. Split
        // it into contiguous same-shape runs and issue one createMany per run:
        // every run stays uniform, so an omitted field takes its column default
        // instead of being written as NULL, and the rows still reach the
        // database in the caller's array order exactly as the single statement
        // put them there. A uniform array is one run and one identical call.
        const injected = items.map((item) => injectForeignKey(item, rel, parentRow, ctx.schema));
        for (const run of createManyShapeRuns(injected)) {
          await ctx.tx.table(rel.to).createMany({ data: run });
        }
      }
    }
  }

  // connect
  if (ops.connect !== undefined) {
    const items = toArray(ops.connect as Record<string, unknown> | Record<string, unknown>[]);
    if (items.length > 0) {
      await batchConnect(ctx, rel, items, parentRow);
    }
  }

  // connectOrCreate
  if (ops.connectOrCreate !== undefined) {
    const items = toArray(ops.connectOrCreate as Record<string, unknown> | Record<string, unknown>[]);
    for (const item of items) {
      const op = item as { where: Record<string, unknown>; create: Record<string, unknown> };
      await connectOrCreate(ctx, rel, op, parentRow);
    }
  }
}

// ---------------------------------------------------------------------------
// belongsTo create operations
// ---------------------------------------------------------------------------

/**
 * Resolve a belongsTo relation's create/connect/connectOrCreate op to the
 * foreign-key value(s) that belong on the PARENT row, returning them keyed by
 * the parent's own field names so they can be merged into the parent INSERT.
 *
 * Used by the create path only. (The update path uses processBelongsToCreate,
 * which UPDATEs the FK after the parent already exists.)
 */
async function resolveBelongsToForCreate(
  ctx: NestedWriteContext,
  rel: RelationDef,
  ops: Record<string, unknown>,
  parentTable: string,
  depth: number,
  path: string[],
  relName: string,
): Promise<Record<string, unknown>> {
  const fks = normalizeKeyColumns(rel.foreignKey);
  const refs = normalizeKeyColumns(rel.referenceKey);
  const parentMeta = ctx.schema.tables[parentTable]!;
  const relatedTable = ctx.schema.tables[rel.to];

  let relatedRow: Record<string, unknown> | null = null;

  if (ops.create !== undefined) {
    const items = toArray(ops.create as Record<string, unknown> | Record<string, unknown>[]);
    if (items.length > 0) {
      relatedRow = (await executeNestedCreate(ctx, rel.to, items[0]!, depth + 1, [...path, relName])) as Record<
        string,
        unknown
      >;
    }
  } else if (ops.connect !== undefined) {
    const items = toArray(ops.connect as Record<string, unknown> | Record<string, unknown>[]);
    if (items.length > 0) {
      const target = items[0]!;
      relatedRow = (await ctx.tx.table(rel.to).findUnique({ where: target })) as Record<string, unknown> | null;
      if (!relatedRow) {
        throw new ValidationError(
          `[turbine] connect on "${relName}": no ${rel.to} row found matching ${describeTargetForMessage(target)}.`,
        );
      }
    }
  } else if (ops.connectOrCreate !== undefined) {
    const items = toArray(ops.connectOrCreate as Record<string, unknown> | Record<string, unknown>[]);
    if (items.length > 0) {
      const op = items[0] as { where: Record<string, unknown>; create: Record<string, unknown> };
      relatedRow = (await ctx.tx.table(rel.to).findUnique({ where: op.where })) as Record<string, unknown> | null;
      if (!relatedRow) {
        // For belongsTo the FK lives on the parent, so the related row is
        // created plainly (no FK injection) and we read its reference key.
        relatedRow = (await ctx.tx.table(rel.to).create({ data: op.create })) as Record<string, unknown>;
      }
    }
  }

  const fkScalars: Record<string, unknown> = {};
  if (relatedRow) {
    for (let i = 0; i < fks.length; i++) {
      const fkField = parentMeta.reverseColumnMap[fks[i]!] ?? fks[i]!;
      const refField = relatedTable?.reverseColumnMap[refs[i]!] ?? refs[i]!;
      fkScalars[fkField] = relatedRow[refField];
    }
  }
  return fkScalars;
}

async function processBelongsToCreate(
  ctx: NestedWriteContext,
  rel: RelationDef,
  ops: Record<string, unknown>,
  parentRow: Record<string, unknown>,
  parentTable: string,
  depth: number,
  path: string[],
  relName: string,
): Promise<void> {
  const fks = normalizeKeyColumns(rel.foreignKey);
  const refs = normalizeKeyColumns(rel.referenceKey);

  // create, insert the related row, then update parent's FK
  if (ops.create !== undefined) {
    const items = toArray(ops.create as Record<string, unknown> | Record<string, unknown>[]);
    if (items.length > 0) {
      const relatedRow = (await executeNestedCreate(ctx, rel.to, items[0]!, depth + 1, [...path, relName])) as Record<
        string,
        unknown
      >;
      const updateData: Record<string, unknown> = {};
      const relatedTable = ctx.schema.tables[rel.to];
      for (let i = 0; i < fks.length; i++) {
        const fkField = ctx.schema.tables[parentTable]?.reverseColumnMap[fks[i]!] ?? fks[i]!;
        const refField = relatedTable?.reverseColumnMap[refs[i]!] ?? refs[i]!;
        updateData[fkField] = relatedRow[refField];
      }
      const parentMeta = ctx.schema.tables[parentTable]!;
      await ctx.tx.table(parentTable).update({
        where: pkWhere(parentMeta, parentRow),
        data: updateData,
      });
    }
  }

  // connect, validate existence, update parent's FK
  if (ops.connect !== undefined) {
    const items = toArray(ops.connect as Record<string, unknown> | Record<string, unknown>[]);
    if (items.length > 0) {
      const target = items[0]!;
      const existing = await ctx.tx.table(rel.to).findUnique({ where: target });
      if (!existing) {
        throw new ValidationError(
          `[turbine] connect on "${relName}": no ${rel.to} row found matching ${describeTargetForMessage(target)}.`,
        );
      }
      const updateData: Record<string, unknown> = {};
      const relatedTable = ctx.schema.tables[rel.to];
      for (let i = 0; i < fks.length; i++) {
        const fkField = ctx.schema.tables[parentTable]?.reverseColumnMap[fks[i]!] ?? fks[i]!;
        const refField = relatedTable?.reverseColumnMap[refs[i]!] ?? refs[i]!;
        updateData[fkField] = (existing as Record<string, unknown>)[refField];
      }
      const parentMeta = ctx.schema.tables[parentTable]!;
      await ctx.tx.table(parentTable).update({
        where: pkWhere(parentMeta, parentRow),
        data: updateData,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// connect, connectOrCreate, disconnect, set, delete helpers
// ---------------------------------------------------------------------------

/**
 * Refuse a connect that would take a to-many child away from another parent,
 * when {@link NestedWriteContext.scopedConnect} is on. See that field for why.
 *
 * Compares the child's CURRENT foreign key against the parent's reference
 * value. Null (unowned) passes, an exact match passes (idempotent re-connect),
 * anything else is refused. Values are compared after normalizing to a
 * primitive, so a bigint FK read back as a string cannot look like a mismatch
 * against the number the parent write returned.
 */
function assertConnectInScope(
  ctx: NestedWriteContext,
  rel: RelationDef,
  child: Record<string, unknown>,
  parentRow: Record<string, unknown>,
  target: Record<string, unknown>,
): void {
  if (!ctx.scopedConnect) return;
  if (rel.type !== 'hasMany' && rel.type !== 'hasOne') return;

  const childTable = ctx.schema.tables[rel.to];
  const parentTable = ctx.schema.tables[rel.from];
  if (!childTable) return;

  const fks = normalizeKeyColumns(rel.foreignKey);
  const refs = normalizeKeyColumns(rel.referenceKey);
  const key = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

  for (let i = 0; i < fks.length; i++) {
    const fkField = childTable.reverseColumnMap[fks[i]!] ?? fks[i]!;
    const refField = parentTable?.reverseColumnMap[refs[i]!] ?? refs[i]!;
    const current = key(child[fkField]);
    if (current === null) continue;
    if (current === key(parentRow[refField])) continue;
    throw new ValidationError(
      `[turbine] connect refused: ${rel.to} row ${describeTargetForMessage(target)} is already owned by ` +
        `another "${rel.from}" (its ${fks[i]} is ${current}). \`scopedConnect\` only allows connecting a row ` +
        `that is unowned or already owned by this parent; re-parenting must be an explicit update.`,
    );
  }
}

async function batchConnect(
  ctx: NestedWriteContext,
  rel: RelationDef,
  items: Record<string, unknown>[],
  parentRow: Record<string, unknown>,
): Promise<void> {
  const fks = normalizeKeyColumns(rel.foreignKey);
  const refs = normalizeKeyColumns(rel.referenceKey);

  const childTable = ctx.schema.tables[rel.to];
  if (!childTable) return;

  // Validate all targets exist
  for (const target of items) {
    const existing = await ctx.tx.table(rel.to).findUnique({ where: target });
    if (!existing) {
      throw new ValidationError(
        `[turbine] connect: no ${rel.to} row found matching ${describeTargetForMessage(target)}.`,
      );
    }
    assertConnectInScope(ctx, rel, existing as Record<string, unknown>, parentRow, target);
  }

  // Build FK update data to point children at parent
  const updateData: Record<string, unknown> = {};
  for (let i = 0; i < fks.length; i++) {
    const fkField = childTable.reverseColumnMap[fks[i]!] ?? fks[i]!;
    const refField = ctx.schema.tables[rel.from]?.reverseColumnMap[refs[i]!] ?? refs[i]!;
    updateData[fkField] = parentRow[refField];
  }

  // Update each matching child
  for (const target of items) {
    await ctx.tx.table(rel.to).update({ where: target, data: updateData });
  }
}

async function connectOrCreate(
  ctx: NestedWriteContext,
  rel: RelationDef,
  op: { where: Record<string, unknown>; create: Record<string, unknown> },
  parentRow: Record<string, unknown>,
): Promise<void> {
  const fks = normalizeKeyColumns(rel.foreignKey);
  const refs = normalizeKeyColumns(rel.referenceKey);
  const childTable = ctx.schema.tables[rel.to];
  if (!childTable) return;

  // Try to find existing
  let row = (await ctx.tx.table(rel.to).findUnique({ where: op.where })) as Record<string, unknown> | null;

  if (!row) {
    // Create with FK injected
    const injected = injectForeignKey(op.create, rel, parentRow, ctx.schema);
    row = (await ctx.tx.table(rel.to).create({ data: injected })) as Record<string, unknown>;
  } else {
    assertConnectInScope(ctx, rel, row, parentRow, op.where);
    // Update FK to point to parent
    const updateData: Record<string, unknown> = {};
    for (let i = 0; i < fks.length; i++) {
      const fkField = childTable.reverseColumnMap[fks[i]!] ?? fks[i]!;
      const refField = ctx.schema.tables[rel.from]?.reverseColumnMap[refs[i]!] ?? refs[i]!;
      updateData[fkField] = parentRow[refField];
    }
    await ctx.tx.table(rel.to).update({ where: op.where, data: updateData });
  }
}

async function processDisconnect(
  ctx: NestedWriteContext,
  rel: RelationDef,
  disconnectArg: unknown,
  relName: string,
  parentRow: Record<string, unknown>,
): Promise<void> {
  const fks = normalizeKeyColumns(rel.foreignKey);
  const childTable = ctx.schema.tables[rel.to];
  if (!childTable) return;

  // Check FK nullability
  const nullable = fks.every((fk) => {
    const col = childTable.columns.find((c) => c.name === fk);
    return col?.nullable ?? false;
  });
  if (!nullable) {
    throw new ValidationError(
      `[turbine] Cannot disconnect "${relName}": foreign key column(s) ${fks.join(', ')} on "${rel.to}" are NOT NULL. Use delete instead.`,
    );
  }

  const items = toArray(disconnectArg as Record<string, unknown> | Record<string, unknown>[]);
  if (items.length === 0) return;

  const nullData: Record<string, unknown> = {};
  for (const fk of fks) {
    const field = childTable.reverseColumnMap[fk] ?? fk;
    nullData[field] = null;
  }

  // Disconnect nulls the child's FK, so an unscoped target would strip ANOTHER
  // parent's child off that parent. Scope every target to this parent's rows.
  const correlation = parentCorrelationWhere(ctx, rel, parentRow);
  for (const target of items) {
    assertTargetSelectsSomething(target, 'disconnect', relName, rel);
    if (!correlation) throw notRelatedToParent('disconnect', relName, rel, target);
    try {
      await ctx.tx.table(rel.to).update({ where: scopeWhereToParent(target, correlation), data: nullData });
    } catch (err) {
      rethrowAsNotRelated(err, 'disconnect', relName, rel, target);
    }
  }
}

async function processSet(
  ctx: NestedWriteContext,
  rel: RelationDef,
  setItems: Record<string, unknown>[],
  parentRow: Record<string, unknown>,
): Promise<void> {
  const fks = normalizeKeyColumns(rel.foreignKey);
  const refs = normalizeKeyColumns(rel.referenceKey);
  const childTable = ctx.schema.tables[rel.to];
  if (!childTable) return;

  // Build parent FK match for finding current children. `set` clears the
  // current children with `allowFullTableScan: true`, which is exactly what
  // disables the empty-where guard downstream, so a null/undefined reference
  // key here would null the FK of EVERY row in the child table. Same guard as
  // parentCorrelationWhere, spelled inline because `set` also needs the
  // (identical) forward direction for the reconnect below.
  const parentWhere: Record<string, unknown> = {};
  for (let i = 0; i < fks.length; i++) {
    const fkField = childTable.reverseColumnMap[fks[i]!] ?? fks[i]!;
    const refField = ctx.schema.tables[rel.from]?.reverseColumnMap[refs[i]!] ?? refs[i]!;
    const value = parentRow[refField];
    if (value === null || value === undefined) {
      throw new ValidationError(
        `[turbine] Nested set on relation "${rel.name}" cannot run: the parent's reference key ` +
          `"${refField}" is ${value === null ? 'null' : 'missing from the loaded row'}, so no child rows ` +
          `can be correlated to this parent.`,
      );
    }
    parentWhere[fkField] = value;
  }

  // Disconnect all current children
  const nullData: Record<string, unknown> = {};
  for (const fk of fks) {
    const field = childTable.reverseColumnMap[fk] ?? fk;
    nullData[field] = null;
  }
  await ctx.tx.table(rel.to).updateMany({
    where: parentWhere,
    data: nullData,
    allowFullTableScan: true,
  });

  // Connect the specified items
  const updateData: Record<string, unknown> = {};
  for (let i = 0; i < fks.length; i++) {
    const fkField = childTable.reverseColumnMap[fks[i]!] ?? fks[i]!;
    const refField = ctx.schema.tables[rel.from]?.reverseColumnMap[refs[i]!] ?? refs[i]!;
    updateData[fkField] = parentRow[refField];
  }
  for (const target of setItems) {
    await ctx.tx.table(rel.to).update({ where: target, data: updateData });
  }
}

// ---------------------------------------------------------------------------
// update / upsert operations (update-context only)
// ---------------------------------------------------------------------------

async function processNestedUpdate(
  ctx: NestedWriteContext,
  rel: RelationDef,
  updateArg: unknown,
  relName: string,
  parentRow: Record<string, unknown>,
): Promise<void> {
  const items = toArray(
    updateArg as
      | { where: Record<string, unknown>; data: Record<string, unknown> }
      | { where: Record<string, unknown>; data: Record<string, unknown> }[],
  );
  if (items.length === 0) return;

  const correlation = parentCorrelationWhere(ctx, rel, parentRow);
  for (const item of items) {
    if (!item.where || !item.data) {
      throw new ValidationError(`[turbine] Nested update on "${rel.name}" requires both "where" and "data" fields.`);
    }
    assertTargetSelectsSomething(item.where, 'update', relName, rel);
    if (!correlation) throw notRelatedToParent('update', relName, rel, item.where);
    try {
      await ctx.tx.table(rel.to).update({ where: scopeWhereToParent(item.where, correlation), data: item.data });
    } catch (err) {
      rethrowAsNotRelated(err, 'update', relName, rel, item.where);
    }
  }
}

async function processNestedUpsert(
  ctx: NestedWriteContext,
  rel: RelationDef,
  upsertArg: unknown,
  parentRow: Record<string, unknown>,
  relName: string,
): Promise<void> {
  const items = toArray(
    upsertArg as
      | { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }
      | { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }[],
  );
  if (items.length === 0) return;

  // The upsert's `where` is scoped to the relation, so a row that matches it but
  // belongs to ANOTHER parent is not "existing" here: it is never updated, and
  // the create branch runs instead (any resulting unique-constraint violation is
  // surfaced to the caller rather than silently rewriting a stranger's row).
  const correlation = parentCorrelationWhere(ctx, rel, parentRow);
  for (const item of items) {
    if (!item.where || !item.create || !item.update) {
      throw new ValidationError(
        `[turbine] Nested upsert on "${rel.name}" requires "where", "create", and "update" fields.`,
      );
    }
    assertTargetSelectsSomething(item.where, 'upsert', relName, rel);
    const scoped = correlation ? scopeWhereToParent(item.where, correlation) : null;
    const existing = scoped ? await ctx.tx.table(rel.to).findUnique({ where: scoped }) : null;
    if (existing && scoped) {
      try {
        await ctx.tx.table(rel.to).update({ where: scoped, data: item.update });
      } catch (err) {
        rethrowAsNotRelated(err, 'upsert', relName, rel, item.where);
      }
    } else {
      const injected = injectForeignKey(item.create, rel, parentRow, ctx.schema);
      await ctx.tx.table(rel.to).create({ data: injected });
    }
  }
}

async function processBelongsToUpdate(
  ctx: NestedWriteContext,
  rel: RelationDef,
  updateArg: unknown,
  parentRow: Record<string, unknown>,
  parentTable: string,
): Promise<void> {
  const item = updateArg as { data: Record<string, unknown> };
  if (!item.data) {
    throw new ValidationError(`[turbine] Nested update on belongsTo "${rel.name}" requires a "data" field.`);
  }

  // The related row is the one this parent's FK points at. Route through the
  // shared correlation helper (like every sibling operation) so a NULL parent
  // FK reports not-found instead of compiling to `refField IS NULL` and
  // updating EVERY row of the related table with a null reference key.
  const where = belongsToCorrelationWhere(ctx, rel, parentRow, parentTable);
  if (!where) {
    // Parent FK is NULL: it points at nothing, so nothing is in scope to update.
    const nullFk = Object.fromEntries(normalizeKeyColumns(rel.foreignKey).map((c) => [c, null]));
    throw notRelatedToParent('update', rel.name, rel, nullFk);
  }

  try {
    await ctx.tx.table(rel.to).update({ where, data: item.data });
  } catch (err) {
    rethrowAsNotRelated(err, 'update', rel.name, rel, where);
  }
}

async function processBelongsToUpsert(
  ctx: NestedWriteContext,
  rel: RelationDef,
  upsertArg: unknown,
  parentRow: Record<string, unknown>,
  parentTable: string,
): Promise<void> {
  const item = upsertArg as {
    where: Record<string, unknown>;
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  };
  if (!item.where || !item.create || !item.update) {
    throw new ValidationError(
      `[turbine] Nested upsert on belongsTo "${rel.name}" requires "where", "create", and "update" fields.`,
    );
  }

  // Scope the lookup to the row this parent actually points at. Without the
  // correlation, a `where` naming any other row would update a record with no
  // relationship to the parent being written. A miss falls through to the
  // create branch (and re-points the parent's FK), which is the same choice the
  // hasMany/hasOne nested upsert makes: an upsert whose target is out of the
  // relation creates a row owned by this parent rather than rewriting a
  // stranger's.
  const correlation = belongsToCorrelationWhere(ctx, rel, parentRow, parentTable);
  // findMany, not findUnique: the scoped where ANDs a non-unique-looking
  // correlation onto the caller's selector. The correlation targets the
  // relation's reference key (unique or the PK by construction), so at most one
  // row can come back.
  const existing = correlation
    ? (((
        await ctx.tx.table(rel.to).findMany({
          where: scopeWhereToParent(item.where, correlation),
          // Internal engine read (see the connect path): no unlimited-findMany warning.
          warnOnUnlimited: false,
        })
      )[0] ?? null) as Record<string, unknown> | null)
    : null;
  if (existing) {
    const relatedMeta = ctx.schema.tables[rel.to]!;
    await ctx.tx.table(rel.to).update({ where: pkWhere(relatedMeta, existing), data: item.update });
  } else {
    // Create the related row, then update parent's FK to point at it
    const createdRow = (await ctx.tx.table(rel.to).create({ data: item.create })) as Record<string, unknown>;

    const fks = normalizeKeyColumns(rel.foreignKey);
    const refs = normalizeKeyColumns(rel.referenceKey);
    const parentMeta = ctx.schema.tables[parentTable]!;
    const relatedTable = ctx.schema.tables[rel.to];

    const updateData: Record<string, unknown> = {};
    for (let i = 0; i < fks.length; i++) {
      const fkField = parentMeta.reverseColumnMap[fks[i]!] ?? fks[i]!;
      const refField = relatedTable?.reverseColumnMap[refs[i]!] ?? refs[i]!;
      updateData[fkField] = createdRow[refField];
    }
    await ctx.tx.table(parentTable).update({
      where: pkWhere(parentMeta, parentRow),
      data: updateData,
    });
  }
}

async function processDelete(
  ctx: NestedWriteContext,
  rel: RelationDef,
  deleteArg: unknown,
  relName: string,
  parentRow: Record<string, unknown>,
): Promise<void> {
  const items = toArray(deleteArg as Record<string, unknown> | Record<string, unknown>[]);
  if (items.length === 0) return;

  // Without the correlation this deletes ANY row the caller can name: a
  // cross-tenant delete primitive for any endpoint that forwards a client id.
  const correlation = parentCorrelationWhere(ctx, rel, parentRow);
  for (const target of items) {
    assertTargetSelectsSomething(target, 'delete', relName, rel);
    if (!correlation) throw notRelatedToParent('delete', relName, rel, target);
    try {
      await ctx.tx.table(rel.to).delete({ where: scopeWhereToParent(target, correlation) });
    } catch (err) {
      rethrowAsNotRelated(err, 'delete', relName, rel, target);
    }
  }
}
