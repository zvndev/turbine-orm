/**
 * turbine-orm — Nested write engine
 *
 * Tree-walking create/update that resolves relation fields in `data` into
 * batched SQL operations within a transaction. Supports create, connect,
 * connectOrCreate, disconnect, set, and delete on related records at
 * arbitrary depth (capped at 10).
 *
 * This module is imported by `query/builder.ts` when the `data` argument
 * of `create()` or `update()` contains relation fields. It never imports
 * `client.ts` directly — the transaction handle is passed in via
 * `NestedWriteContext`.
 */

import { CircularRelationError, RelationError, ValidationError } from './errors.js';
import type { RelationDef, SchemaMetadata, TableMetadata } from './schema.js';
import { normalizeKeyColumns } from './schema.js';

const MAX_DEPTH = 10;

const CREATE_ONLY_OPS = new Set(['create', 'connect', 'connectOrCreate']);
const UPDATE_ONLY_OPS = new Set(['disconnect', 'set', 'delete']);

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
    table<T extends object>(name: string): {
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
export function extractRelationFields(
  data: Record<string, unknown>,
  tableMeta: TableMetadata,
): ExtractedFields {
  const scalars: Record<string, unknown> = {};
  const relations: Record<string, Record<string, unknown>> = {};

  for (const [key, value] of Object.entries(data)) {
    if (
      key in tableMeta.relations &&
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
    if (key in tableMeta.relations) {
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
          `Valid operations: create, connect, connectOrCreate${isUpdate ? ', disconnect, set, delete' : ''}.`,
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

  // Insert the parent row
  const parentRow = (await ctx.tx.table(tableName).create({ data: scalars })) as Record<string, unknown>;

  // Process each relation
  for (const [relName, ops] of Object.entries(relations)) {
    const rel = tableMeta.relations[relName]!;

    if (rel.type === 'hasMany' || rel.type === 'hasOne') {
      await processHasManyCreate(ctx, rel, ops, parentRow, depth, path, relName);
    } else if (rel.type === 'belongsTo') {
      await processBelongsToCreate(ctx, rel, ops, parentRow, tableName, depth, path, relName);
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
      throw new ValidationError(`[turbine] update: no ${tableName} row found matching ${JSON.stringify(where)}.`);
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
        await processDisconnect(ctx, rel, ops.disconnect, relName);
      }

      // set
      if (ops.set !== undefined) {
        await processSet(ctx, rel, ops.set as Record<string, unknown>[], parentRow);
      }

      // delete
      if (ops.delete !== undefined) {
        await processDelete(ctx, rel, ops.delete);
      }
    } else if (rel.type === 'belongsTo') {
      await processBelongsToCreate(ctx, rel, ops, parentRow, tableName, depth, path, relName);

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
        childTable &&
        items.some((item) => Object.keys(item).some((k) => k in (childTable.relations ?? {})));

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
      const relatedRow = (await executeNestedCreate(ctx, rel.to, items[0]!, depth + 1, [
        ...path,
        relName,
      ])) as Record<string, unknown>;
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
          `[turbine] connect on "${relName}": no ${rel.to} row found matching ${JSON.stringify(target)}.`,
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
      throw new ValidationError(`[turbine] connect: no ${rel.to} row found matching ${JSON.stringify(target)}.`);
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
  const nullData: Record<string, unknown> = {};
  for (const fk of fks) {
    const field = childTable.reverseColumnMap[fk] ?? fk;
    nullData[field] = null;
  }

  for (const target of items) {
    await ctx.tx.table(rel.to).update({ where: target, data: nullData });
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

  // Build parent FK match for finding current children
  const parentWhere: Record<string, unknown> = {};
  for (let i = 0; i < fks.length; i++) {
    const fkField = childTable.reverseColumnMap[fks[i]!] ?? fks[i]!;
    const refField = ctx.schema.tables[rel.from]?.reverseColumnMap[refs[i]!] ?? refs[i]!;
    parentWhere[fkField] = parentRow[refField];
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

async function processDelete(ctx: NestedWriteContext, rel: RelationDef, deleteArg: unknown): Promise<void> {
  const items = toArray(deleteArg as Record<string, unknown> | Record<string, unknown>[]);
  for (const target of items) {
    await ctx.tx.table(rel.to).delete({ where: target });
  }
}
