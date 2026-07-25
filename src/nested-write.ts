/**
 * turbine-orm — Nested write engine
 *
 * Tree-walking create/update that resolves relation fields in `data` into
 * batched SQL operations within a transaction. Supports create, connect,
 * connectOrCreate, disconnect, set, delete, update, and upsert on related
 * records at arbitrary depth (capped at 10).
 *
 * This module is imported by `query/builder.ts` when the `data` argument
 * of `create()` or `update()` contains relation fields. It never imports
 * `client.ts` directly — the transaction handle is passed in via
 * `NestedWriteContext`.
 */

import {
  CircularRelationError,
  describeTargetForMessage,
  NotFoundError,
  RelationError,
  ValidationError,
} from './errors.js';
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
  tx: {
    table<T extends object>(
      name: string,
    ): {
      create(args: { data: Partial<T> }): Promise<T>;
      createMany(args: { data: Partial<T>[] }): Promise<T[]>;
      update(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<T>;
      updateMany(args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
        allowFullTableScan?: boolean;
      }): Promise<{ count: number }>;
      delete(args: { where: Record<string, unknown> }): Promise<T>;
      deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
      findMany(args: { where: Record<string, unknown> }): Promise<T[]>;
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
    result[fkField] = parentRow[refField];
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function toArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
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
 * many-to-many relations have no nested-write branch on any engine: the junction
 * row would have to be written too, and there is no safe default for what to put
 * in its extra columns. Refusing loudly is the only honest option, because the
 * alternative (falling off the end of the dispatch) drops the write silently and
 * reports success.
 */
function manyToManyUnsupported(relName: string, rel: RelationDef): ValidationError {
  return new ValidationError(
    `[turbine] Nested writes are not supported on the many-to-many relation "${relName}" ` +
      `(via the "${rel.through?.table ?? 'junction'}" junction table). Write the junction rows directly ` +
      `(db.${rel.through?.table ?? 'junction'}.create / createMany) inside the same $transaction.`,
  );
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
  // resolved BEFORE the parent is inserted — otherwise a NOT NULL FK column
  // fails on the initial INSERT. We resolve each belongsTo op (create/connect/
  // connectOrCreate) to its referenced row and fold the FK values into the
  // parent's own INSERT.
  const belongsToFks: Record<string, unknown> = {};
  for (const [relName, ops] of Object.entries(relations)) {
    const rel = tableMeta.relations[relName]!;
    if (rel.type === 'belongsTo') {
      Object.assign(belongsToFks, await resolveBelongsToForCreate(ctx, rel, ops, tableName, depth, path, relName));
    } else if (rel.type === 'manyToMany') {
      throw manyToManyUnsupported(relName, rel);
    }
  }

  // Insert the parent row (scalars + resolved belongsTo foreign keys)
  const parentRow = (await ctx.tx.table(tableName).create({
    data: { ...scalars, ...belongsToFks },
  })) as Record<string, unknown>;

  // Process hasMany / hasOne relations — their FK lives on the CHILD, so they
  // need the parent row to exist first.
  for (const [relName, ops] of Object.entries(relations)) {
    const rel = tableMeta.relations[relName]!;
    if (rel.type === 'hasMany' || rel.type === 'hasOne') {
      await processHasManyCreate(ctx, rel, ops, parentRow, depth, path, relName);
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
      // create, connect, connectOrCreate — same as nested create
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

      // update (belongsTo — derive where from parent FK)
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
      throw manyToManyUnsupported(relName, rel);
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
        // Batch via createMany (UNNEST) — fast path
        const injected = items.map((item) => injectForeignKey(item, rel, parentRow, ctx.schema));
        await ctx.tx.table(rel.to).createMany({ data: injected });
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

  // create — insert the related row, then update parent's FK
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

  // connect — validate existence, update parent's FK
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

  // Derive where from parent's FK values
  const fks = normalizeKeyColumns(rel.foreignKey);
  const refs = normalizeKeyColumns(rel.referenceKey);
  const parentMeta = ctx.schema.tables[parentTable];
  const relatedTable = ctx.schema.tables[rel.to];

  const where: Record<string, unknown> = {};
  for (let i = 0; i < fks.length; i++) {
    const fkField = parentMeta?.reverseColumnMap[fks[i]!] ?? fks[i]!;
    const refField = relatedTable?.reverseColumnMap[refs[i]!] ?? refs[i]!;
    where[refField] = parentRow[fkField];
  }

  await ctx.tx.table(rel.to).update({ where, data: item.data });
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
    ? (((await ctx.tx.table(rel.to).findMany({ where: scopeWhereToParent(item.where, correlation) }))[0] ??
        null) as Record<string, unknown> | null)
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
