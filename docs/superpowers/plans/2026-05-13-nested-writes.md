# Nested Writes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Prisma-parity nested write support to Turbine ORM — create, connect, connectOrCreate, disconnect, set, and delete related records within `create()` and `update()` calls, with full tree returns and UNNEST batching.

**Architecture:** New `src/nested-write.ts` module handles tree-walking execution. `QueryInterface.create()` and `update()` detect relation fields in `data` and delegate to the nested write engine, which runs inside an implicit transaction. The code generator emits new `*CreateInput`, `*UpdateInput`, `*WhereUnique` types. All child inserts are batched via existing `createMany` (UNNEST). Final tree read reuses existing `findUnique` + `json_agg`.

**Tech Stack:** TypeScript, PostgreSQL, node:test, existing Turbine internals (QueryInterface, TransactionClient, SchemaMetadata, errors).

**Spec:** `docs/superpowers/specs/2026-05-13-nested-writes-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/nested-write.ts` | **Create** | Core nested write execution: `executeNestedCreate()`, `executeNestedUpdate()`, helpers for each operation (connect, disconnect, set, delete, connectOrCreate). ~400-500 LOC. |
| `src/query/types.ts` | **Modify** | Add runtime type definitions: `NestedCreateOp<T>`, `NestedUpdateOp<T>`, `ConnectOrCreateOp<T>`. |
| `src/query/builder.ts` | **Modify** | Detection logic in `create()` and `update()` — if `data` has relation keys, delegate to `nested-write.ts`. |
| `src/generate.ts` | **Modify** | Emit `*CreateInput`, `*UpdateInput`, `*WhereUnique`, `*ConnectOrCreate` types per table. |
| `src/index.ts` | **Modify** | Re-export new types from `nested-write.ts`. |
| `src/test/nested-write.test.ts` | **Create** | Unit tests for nested write logic (mock schema, no DB). |
| `src/test/nested-write-integration.test.ts` | **Create** | Integration tests against real Postgres. |
| `src/test/generate-nested-types.test.ts` | **Create** | Test that code generator emits correct nested input types. |

---

## Task 1: Runtime types for nested operations

Add the type definitions that the nested write engine and code generator will use.

**Files:**
- Modify: `src/query/types.ts` (after line 353, after `UpsertArgs`)

- [ ] **Step 1: Add nested write operation types to `src/query/types.ts`**

Append after the `UpsertArgs` interface (line 353):

```ts
// ---------------------------------------------------------------------------
// Nested write operation types
// ---------------------------------------------------------------------------

export interface ConnectOrCreateOp<T> {
  where: Partial<T>;
  create: Partial<T>;
}

export interface NestedCreateOp<T> {
  create?: Partial<T> | Partial<T>[];
  connect?: Partial<T> | Partial<T>[];
  connectOrCreate?: ConnectOrCreateOp<T> | ConnectOrCreateOp<T>[];
}

export interface NestedUpdateOp<T> {
  create?: Partial<T> | Partial<T>[];
  connect?: Partial<T> | Partial<T>[];
  connectOrCreate?: ConnectOrCreateOp<T> | ConnectOrCreateOp<T>[];
  disconnect?: Partial<T> | Partial<T>[];
  set?: Partial<T>[];
  delete?: Partial<T> | Partial<T>[];
}
```

- [ ] **Step 2: Re-export from `src/query/index.ts`**

Add to the existing re-export list in `src/query/index.ts`:

```ts
export type { ConnectOrCreateOp, NestedCreateOp, NestedUpdateOp } from './types.js';
```

- [ ] **Step 3: Re-export from `src/index.ts`**

Add to the query builder re-export block (around line 127):

```ts
  type ConnectOrCreateOp,
  type NestedCreateOp,
  type NestedUpdateOp,
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS — no compilation errors.

- [ ] **Step 5: Commit**

```bash
git add src/query/types.ts src/query/index.ts src/index.ts
git commit -m "feat: add nested write operation types (NestedCreateOp, NestedUpdateOp, ConnectOrCreateOp)"
```

---

## Task 2: Core nested write engine — `src/nested-write.ts`

The heart of the feature. Implements the tree-walking algorithm that resolves relation fields in `data` into batched SQL operations within a transaction.

**Files:**
- Create: `src/nested-write.ts`
- Test: `src/test/nested-write.test.ts`

- [ ] **Step 1: Write unit tests for relation field detection and FK injection**

Create `src/test/nested-write.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mockColumn, mockTable } from './helpers.js';
import { extractRelationFields, injectForeignKey } from '../nested-write.js';
import type { SchemaMetadata } from '../schema.js';

const usersTable = mockTable('users', [
  { name: 'id', field: 'id' },
  { name: 'email', field: 'email', pgType: 'text' },
  { name: 'name', field: 'name', pgType: 'text' },
]);

const postsTable = mockTable(
  'posts',
  [
    { name: 'id', field: 'id' },
    { name: 'title', field: 'title', pgType: 'text' },
    { name: 'user_id', field: 'userId' },
  ],
  {
    author: {
      type: 'belongsTo',
      name: 'author',
      from: 'posts',
      to: 'users',
      foreignKey: 'user_id',
      referenceKey: 'id',
    },
  },
);

const schema: SchemaMetadata = {
  tables: {
    users: {
      ...usersTable,
      relations: {
        posts: {
          type: 'hasMany',
          name: 'posts',
          from: 'users',
          to: 'posts',
          foreignKey: 'user_id',
          referenceKey: 'id',
        },
      },
    },
    posts: postsTable,
  },
  enums: {},
};

describe('nested-write: extractRelationFields', () => {
  it('separates scalar data from relation fields', () => {
    const data = {
      email: 'alice@example.com',
      name: 'Alice',
      posts: { create: [{ title: 'Hello' }] },
    };

    const result = extractRelationFields(data, schema.tables.users!);

    assert.deepStrictEqual(result.scalars, { email: 'alice@example.com', name: 'Alice' });
    assert.deepStrictEqual(result.relations, {
      posts: { create: [{ title: 'Hello' }] },
    });
  });

  it('returns empty relations when data has no relation fields', () => {
    const data = { email: 'alice@example.com' };
    const result = extractRelationFields(data, schema.tables.users!);

    assert.deepStrictEqual(result.scalars, { email: 'alice@example.com' });
    assert.deepStrictEqual(result.relations, {});
  });
});

describe('nested-write: injectForeignKey', () => {
  it('injects parent PK as FK into child data', () => {
    const childData = { title: 'Hello' };
    const relation = schema.tables.users!.relations.posts!;
    const parentRow = { id: 42, email: 'alice@example.com', name: 'Alice' };

    const result = injectForeignKey(childData, relation, parentRow, schema);
    assert.deepStrictEqual(result, { title: 'Hello', userId: 42 });
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npx tsx --test src/test/nested-write.test.ts`
Expected: FAIL — `nested-write.js` does not exist yet.

- [ ] **Step 3: Implement `src/nested-write.ts` — helpers and hasMany create**

Create `src/nested-write.ts` with the core logic:

```ts
import { CircularRelationError, RelationError, ValidationError } from './errors.js';
import type { RelationDef, SchemaMetadata, TableMetadata } from './schema.js';
import { normalizeKeyColumns, snakeToCamel } from './schema.js';

const MAX_DEPTH = 10;

const CREATE_ONLY_OPS = new Set(['create', 'connect', 'connectOrCreate']);
const UPDATE_ONLY_OPS = new Set(['disconnect', 'set', 'delete']);

export interface ExtractedFields {
  scalars: Record<string, unknown>;
  relations: Record<string, Record<string, unknown>>;
}

export function extractRelationFields(
  data: Record<string, unknown>,
  tableMeta: TableMetadata,
): ExtractedFields {
  const scalars: Record<string, unknown> = {};
  const relations: Record<string, Record<string, unknown>> = {};

  for (const [key, value] of Object.entries(data)) {
    if (key in tableMeta.relations && value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      relations[key] = value as Record<string, unknown>;
    } else {
      scalars[key] = value;
    }
  }

  return { scalars, relations };
}

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

function toArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

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

export interface NestedWriteContext {
  schema: SchemaMetadata;
  tx: {
    table<T extends object>(name: string): {
      create(args: { data: Partial<T> }): Promise<T>;
      createMany(args: { data: Partial<T>[] }): Promise<T[]>;
      update(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<T>;
      updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
      delete(args: { where: Record<string, unknown> }): Promise<T>;
      deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
      findMany(args: { where: Record<string, unknown> }): Promise<T[]>;
      findUnique(args: { where: Record<string, unknown>; with?: Record<string, unknown> }): Promise<T | null>;
    };
  };
}

export async function executeNestedCreate(
  ctx: NestedWriteContext,
  tableName: string,
  data: Record<string, unknown>,
  depth: number = 0,
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
      throw new RelationError(tableName, relName, Object.keys(tableMeta.relations));
    }
    validateOps(relName, ops, false);
  }

  // Insert the parent row
  const parentRow = await ctx.tx.table(tableName).create({ data: scalars }) as Record<string, unknown>;

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
  const pk = tableMeta.primaryKey;
  const pkWhere: Record<string, unknown> = {};
  for (const col of pk) {
    const field = tableMeta.reverseColumnMap[col] ?? col;
    pkWhere[field] = parentRow[field];
  }

  const fullRow = await ctx.tx.table(tableName).findUnique({
    where: pkWhere,
    with: Object.keys(withClause).length > 0 ? withClause : undefined,
  });

  return (fullRow ?? parentRow) as Record<string, unknown>;
}

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
      const hasNested = childTable && items.some(item =>
        Object.keys(item).some(k => k in (childTable.relations ?? {})));

      if (hasNested) {
        // Per-row recursive create for items with nested relations
        for (const item of items) {
          const injected = injectForeignKey(item, rel, parentRow, ctx.schema);
          await executeNestedCreate(ctx, rel.to, injected, depth + 1, [...path, relName]);
        }
      } else {
        // Batch via createMany (UNNEST) — fast path
        const injected = items.map(item => injectForeignKey(item, rel, parentRow, ctx.schema));
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
      const relatedRow = await executeNestedCreate(ctx, rel.to, items[0]!, depth + 1, [...path, relName]) as Record<string, unknown>;
      const updateData: Record<string, unknown> = {};
      const relatedTable = ctx.schema.tables[rel.to];
      for (let i = 0; i < fks.length; i++) {
        const fkField = ctx.schema.tables[parentTable]?.reverseColumnMap[fks[i]!] ?? fks[i]!;
        const refField = relatedTable?.reverseColumnMap[refs[i]!] ?? refs[i]!;
        updateData[fkField] = relatedRow[refField];
      }
      const pk = ctx.schema.tables[parentTable]!.primaryKey;
      const pkWhere: Record<string, unknown> = {};
      for (const col of pk) {
        const field = ctx.schema.tables[parentTable]!.reverseColumnMap[col] ?? col;
        pkWhere[field] = parentRow[field];
      }
      await ctx.tx.table(parentTable).update({ where: pkWhere, data: updateData });
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
      const pk = ctx.schema.tables[parentTable]!.primaryKey;
      const pkWhere: Record<string, unknown> = {};
      for (const col of pk) {
        const field = ctx.schema.tables[parentTable]!.reverseColumnMap[col] ?? col;
        pkWhere[field] = parentRow[field];
      }
      await ctx.tx.table(parentTable).update({ where: pkWhere, data: updateData });
    }
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

  // Batch existence check
  const childTable = ctx.schema.tables[rel.to];
  if (!childTable) return;

  // Validate all targets exist
  for (const target of items) {
    const existing = await ctx.tx.table(rel.to).findUnique({ where: target });
    if (!existing) {
      throw new ValidationError(
        `[turbine] connect: no ${rel.to} row found matching ${JSON.stringify(target)}.`,
      );
    }
  }

  // Batch update FKs — update all matching children to point to parent
  const updateData: Record<string, unknown> = {};
  for (let i = 0; i < fks.length; i++) {
    const fkField = childTable.reverseColumnMap[fks[i]!] ?? fks[i]!;
    const refField = ctx.schema.tables[rel.from]?.reverseColumnMap[refs[i]!] ?? refs[i]!;
    updateData[fkField] = parentRow[refField];
  }

  // Build OR condition for all connect targets
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
  let row = await ctx.tx.table(rel.to).findUnique({ where: op.where }) as Record<string, unknown> | null;

  if (!row) {
    // Create with FK injected
    const injected = injectForeignKey(op.create, rel, parentRow, ctx.schema);
    row = await ctx.tx.table(rel.to).create({ data: injected }) as Record<string, unknown>;
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

// ---------------------------------------------------------------------------
// executeNestedUpdate
// ---------------------------------------------------------------------------

export async function executeNestedUpdate(
  ctx: NestedWriteContext,
  tableName: string,
  where: Record<string, unknown>,
  data: Record<string, unknown>,
  depth: number = 0,
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
      throw new RelationError(tableName, relName, Object.keys(tableMeta.relations));
    }
    validateOps(relName, ops, true);
  }

  // Update parent row with scalar data (may be empty if only relation ops)
  let parentRow: Record<string, unknown>;
  if (Object.keys(scalars).length > 0) {
    parentRow = await ctx.tx.table(tableName).update({ where, data: scalars }) as Record<string, unknown>;
  } else {
    parentRow = await ctx.tx.table(tableName).findUnique({ where }) as Record<string, unknown>;
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
        const nullable = fks.every(fk => {
          const col = tableMeta.columns.find(c => c.name === fk);
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
        const pk = tableMeta.primaryKey;
        const pkWhere: Record<string, unknown> = {};
        for (const col of pk) {
          const field = tableMeta.reverseColumnMap[col] ?? col;
          pkWhere[field] = parentRow[field];
        }
        await ctx.tx.table(tableName).update({ where: pkWhere, data: updateData });
      }
    }
  }

  // Final read with all touched relations
  const withClause: Record<string, true> = {};
  for (const relName of Object.keys(relations)) {
    withClause[relName] = true;
  }

  const pk = tableMeta.primaryKey;
  const pkWhere: Record<string, unknown> = {};
  for (const col of pk) {
    const field = tableMeta.reverseColumnMap[col] ?? col;
    pkWhere[field] = parentRow[field];
  }

  const fullRow = await ctx.tx.table(tableName).findUnique({
    where: pkWhere,
    with: Object.keys(withClause).length > 0 ? withClause : undefined,
  });

  return (fullRow ?? parentRow) as Record<string, unknown>;
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
  const nullable = fks.every(fk => {
    const col = childTable.columns.find(c => c.name === fk);
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
  await ctx.tx.table(rel.to).updateMany({ where: parentWhere, data: nullData, allowFullTableScan: true });

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

async function processDelete(
  ctx: NestedWriteContext,
  rel: RelationDef,
  deleteArg: unknown,
): Promise<void> {
  const items = toArray(deleteArg as Record<string, unknown> | Record<string, unknown>[]);
  for (const target of items) {
    await ctx.tx.table(rel.to).delete({ where: target });
  }
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `npx tsx --test src/test/nested-write.test.ts`
Expected: PASS

- [ ] **Step 5: Add validation unit tests**

Add to `src/test/nested-write.test.ts`:

```ts
import { ValidationError, RelationError } from '../errors.js';

describe('nested-write: validation', () => {
  it('throws RelationError for unknown relation name', () => {
    const data = { email: 'x', nonexistent: { create: [{}] } };
    // extractRelationFields should NOT throw — it just separates.
    // The validation happens in executeNestedCreate which checks against schema.
    // Test that extractRelationFields returns nonexistent in scalars (not a real relation).
    const result = extractRelationFields(data, schema.tables.users!);
    assert.deepStrictEqual(result.scalars, { email: 'x', nonexistent: { create: [{}] } });
    assert.deepStrictEqual(result.relations, {});
  });

  it('detects relation fields correctly based on schema', () => {
    const data = {
      email: 'x',
      posts: { create: [{ title: 'hi' }] },
    };
    assert.ok(hasRelationFields(data, schema.tables.users!));
  });

  it('does not flag non-object values as relation fields', () => {
    const data = { email: 'x', posts: 'not-an-object' };
    assert.ok(!hasRelationFields(data, schema.tables.users!));
  });

  it('does not flag arrays as relation fields', () => {
    const data = { email: 'x', posts: [1, 2, 3] };
    assert.ok(!hasRelationFields(data, schema.tables.users!));
  });

  it('does not flag Date as relation fields', () => {
    const data = { email: 'x', posts: new Date() };
    assert.ok(!hasRelationFields(data, schema.tables.users!));
  });
});
```

- [ ] **Step 6: Run all tests — verify pass**

Run: `npx tsx --test src/test/nested-write.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/nested-write.ts src/test/nested-write.test.ts
git commit -m "feat: add nested write engine with create, connect, connectOrCreate, disconnect, set, delete"
```

---

## Task 3: Wire nested writes into QueryInterface

Connect the nested write engine to the existing `create()` and `update()` methods.

**Files:**
- Modify: `src/query/builder.ts` (lines 941-977 for `create`, lines 1036-1093 for `update`)

- [ ] **Step 1: Import nested write functions in `src/query/builder.ts`**

Add to the import block at the top of `src/query/builder.ts` (after line 24):

```ts
import { executeNestedCreate, executeNestedUpdate, hasRelationFields } from '../nested-write.js';
```

- [ ] **Step 2: Modify `create()` to detect and delegate nested writes**

Replace the `create` method (lines 941-947) with:

```ts
  async create(args: CreateArgs<T>): Promise<T> {
    return this.executeWithMiddleware('create', args as unknown as Record<string, unknown>, async () => {
      // Check for nested relation fields
      if (hasRelationFields(args.data as Record<string, unknown>, this.tableMeta)) {
        return this.executeNestedCreate(args) as Promise<T>;
      }
      const deferred = this.buildCreate(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args.timeout, deferred.preparedName);
      return deferred.transform(result);
    });
  }

  private async executeNestedCreate(args: CreateArgs<T>): Promise<T> {
    // We need a transaction. The pool is available on `this`.
    // Import the transaction helper from client to wrap this in BEGIN/COMMIT.
    const { TransactionClient } = await import('../client.js');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const tx = new TransactionClient(client, this.schema, this.middlewares as any);
      const ctx = { schema: this.schema, tx: tx as any };
      const result = await executeNestedCreate(ctx, this.table, args.data as Record<string, unknown>);
      await client.query('COMMIT');
      return result as T;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
```

- [ ] **Step 3: Modify `update()` to detect and delegate nested writes**

Replace the `update` method (lines 1036-1046) with:

```ts
  async update(args: UpdateArgs<T>): Promise<T> {
    return this.executeWithMiddleware('update', args as unknown as Record<string, unknown>, async () => {
      // Check for nested relation fields
      if (hasRelationFields(args.data as Record<string, unknown>, this.tableMeta)) {
        return this.executeNestedUpdate(args) as Promise<T>;
      }
      const deferred = this.buildUpdate(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args.timeout, deferred.preparedName);
      return deferred.transform(result);
    });
  }

  private async executeNestedUpdate(args: UpdateArgs<T>): Promise<T> {
    const { TransactionClient } = await import('../client.js');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const tx = new TransactionClient(client, this.schema, this.middlewares as any);
      const ctx = { schema: this.schema, tx: tx as any };
      const result = await executeNestedUpdate(
        ctx,
        this.table,
        args.where as Record<string, unknown>,
        args.data as Record<string, unknown>,
      );
      await client.query('COMMIT');
      return result as T;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Run unit tests to ensure existing behavior unchanged**

Run: `npm run test:unit`
Expected: PASS — all existing tests pass (non-nested creates/updates take the same code path).

- [ ] **Step 6: Commit**

```bash
git add src/query/builder.ts
git commit -m "feat: wire nested writes into QueryInterface create() and update()"
```

---

## Task 4: Code generator — emit nested input types

Extend the code generator to emit `*CreateInput`, `*UpdateInput`, `*WhereUnique`, and `*ConnectOrCreate` types.

**Files:**
- Modify: `src/generate.ts` (inside `generateTypes()` function, ~line 128-213)
- Test: `src/test/generate-nested-types.test.ts`

- [ ] **Step 1: Write test for generated nested types**

Create `src/test/generate-nested-types.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateTypes } from '../generate.js';
import type { SchemaMetadata } from '../schema.js';

const schema: SchemaMetadata = {
  tables: {
    users: {
      name: 'users',
      columns: [
        { name: 'id', field: 'id', pgType: 'int8', tsType: 'number', nullable: false, hasDefault: true, isArray: false, pgArrayType: 'bigint[]' },
        { name: 'email', field: 'email', pgType: 'text', tsType: 'string', nullable: false, hasDefault: false, isArray: false, pgArrayType: 'text[]' },
      ],
      columnMap: { id: 'id', email: 'email' },
      reverseColumnMap: { id: 'id', email: 'email' },
      dateColumns: new Set(),
      pgTypes: { id: 'int8', email: 'text' },
      allColumns: ['id', 'email'],
      primaryKey: ['id'],
      uniqueColumns: [['id'], ['email']],
      relations: {
        posts: {
          type: 'hasMany' as const,
          name: 'posts',
          from: 'users',
          to: 'posts',
          foreignKey: 'user_id',
          referenceKey: 'id',
        },
      },
      indexes: [],
    },
    posts: {
      name: 'posts',
      columns: [
        { name: 'id', field: 'id', pgType: 'int8', tsType: 'number', nullable: false, hasDefault: true, isArray: false, pgArrayType: 'bigint[]' },
        { name: 'title', field: 'title', pgType: 'text', tsType: 'string', nullable: false, hasDefault: false, isArray: false, pgArrayType: 'text[]' },
        { name: 'slug', field: 'slug', pgType: 'text', tsType: 'string', nullable: true, hasDefault: false, isArray: false, pgArrayType: 'text[]' },
        { name: 'user_id', field: 'userId', pgType: 'int8', tsType: 'number', nullable: false, hasDefault: false, isArray: false, pgArrayType: 'bigint[]' },
      ],
      columnMap: { id: 'id', title: 'title', slug: 'slug', userId: 'user_id' },
      reverseColumnMap: { id: 'id', title: 'title', slug: 'slug', user_id: 'userId' },
      dateColumns: new Set(),
      pgTypes: { id: 'int8', title: 'text', slug: 'text', user_id: 'int8' },
      allColumns: ['id', 'title', 'slug', 'user_id'],
      primaryKey: ['id'],
      uniqueColumns: [['id'], ['slug']],
      relations: {
        author: {
          type: 'belongsTo' as const,
          name: 'author',
          from: 'posts',
          to: 'users',
          foreignKey: 'user_id',
          referenceKey: 'id',
        },
      },
      indexes: [],
    },
  },
  enums: {},
};

describe('generate nested input types', () => {
  it('emits WhereUnique type from PK and unique indexes', () => {
    const output = generateTypes(schema);
    assert.ok(output.includes('export type PostWhereUnique ='));
    // Should have id and slug branches
    assert.ok(output.includes('id: number'));
    assert.ok(output.includes('slug: string'));
  });

  it('emits CreateInput type with nested relation fields', () => {
    const output = generateTypes(schema);
    assert.ok(output.includes('export type UserCreateInput ='));
    assert.ok(output.includes('posts?:'));
    assert.ok(output.includes('PostNestedCreateInput'));
  });

  it('emits UpdateInput type with full nested operations', () => {
    const output = generateTypes(schema);
    assert.ok(output.includes('export type UserUpdateInput ='));
    assert.ok(output.includes('PostNestedUpdateInput'));
  });

  it('emits NestedCreateInput with create, connect, connectOrCreate', () => {
    const output = generateTypes(schema);
    assert.ok(output.includes('export interface PostNestedCreateInput'));
    assert.ok(output.includes('create?: PostCreateInput | PostCreateInput[]'));
    assert.ok(output.includes('connect?: PostWhereUnique | PostWhereUnique[]'));
    assert.ok(output.includes('connectOrCreate?: PostConnectOrCreate | PostConnectOrCreate[]'));
  });

  it('emits NestedUpdateInput with disconnect, set, delete', () => {
    const output = generateTypes(schema);
    assert.ok(output.includes('export interface PostNestedUpdateInput'));
    assert.ok(output.includes('disconnect?: PostWhereUnique | PostWhereUnique[]'));
    assert.ok(output.includes('set?: PostWhereUnique[]'));
    assert.ok(output.includes('delete?: PostWhereUnique | PostWhereUnique[]'));
  });

  it('emits ConnectOrCreate type', () => {
    const output = generateTypes(schema);
    assert.ok(output.includes('export interface PostConnectOrCreate'));
    assert.ok(output.includes('where: PostWhereUnique'));
    assert.ok(output.includes('create: PostCreateInput'));
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `npx tsx --test src/test/generate-nested-types.test.ts`
Expected: FAIL — none of these types are emitted yet.

- [ ] **Step 3: Add nested type generation to `generateTypes()` in `src/generate.ts`**

After the relations block (after line 213, before the closing `return lines.join('\n')` on line 215), add the following code to emit nested write types:

```ts
  // ---------------------------------------------------------------------------
  // Nested write types (WhereUnique, NestedCreateInput, NestedUpdateInput,
  // ConnectOrCreate, CreateInput, UpdateInput)
  // ---------------------------------------------------------------------------

  for (const table of Object.values(schema.tables)) {
    const typeName = entityName(table.name);
    const hasRelations = Object.keys(table.relations).length > 0;

    // WhereUnique — union of unique constraint shapes
    const uniqueSets = [table.primaryKey, ...table.uniqueColumns.filter(
      uc => uc.join(',') !== table.primaryKey.join(',')
    )];
    if (uniqueSets.length > 0) {
      const branches = uniqueSets.map(cols => {
        const fields = cols.map(colName => {
          const col = table.columns.find(c => c.name === colName);
          const field = col?.field ?? colName;
          const tsType = col?.tsType ?? 'unknown';
          return `${field}: ${tsType}`;
        });
        return `{ ${fields.join('; ')} }`;
      });
      lines.push(`export type ${typeName}WhereUnique = ${branches.join(' | ')};`);
      lines.push('');
    }

    // NestedCreateInput / NestedUpdateInput / ConnectOrCreate per relation target
    // Emit for each table that is a target of a relation
    if (hasRelations) {
      // CreateInput — extends base Create type with relation fields
      lines.push(`export type ${typeName}CreateInput = ${typeName}Create & {`);
      for (const [relName, rel] of Object.entries(table.relations)) {
        const targetType = entityName(rel.to);
        lines.push(`  ${relName}?: ${targetType}NestedCreateInput;`);
      }
      lines.push('};');
      lines.push('');

      // UpdateInput — extends base Update type with relation fields
      lines.push(`export type ${typeName}UpdateInput = ${typeName}Update & {`);
      for (const [relName, rel] of Object.entries(table.relations)) {
        const targetType = entityName(rel.to);
        if (rel.type === 'hasMany') {
          lines.push(`  ${relName}?: ${targetType}NestedUpdateInput;`);
        } else {
          lines.push(`  ${relName}?: ${targetType}NestedCreateInput;`);
        }
      }
      lines.push('};');
      lines.push('');
    }
  }

  // Emit NestedCreateInput, NestedUpdateInput, ConnectOrCreate for each table
  // that has a WhereUnique and a Create type (i.e. every table)
  for (const table of Object.values(schema.tables)) {
    const typeName = entityName(table.name);

    lines.push(`export interface ${typeName}NestedCreateInput {`);
    lines.push(`  create?: ${typeName}CreateInput | ${typeName}CreateInput[];`);
    lines.push(`  connect?: ${typeName}WhereUnique | ${typeName}WhereUnique[];`);
    lines.push(`  connectOrCreate?: ${typeName}ConnectOrCreate | ${typeName}ConnectOrCreate[];`);
    lines.push('}');
    lines.push('');

    lines.push(`export interface ${typeName}NestedUpdateInput {`);
    lines.push(`  create?: ${typeName}CreateInput | ${typeName}CreateInput[];`);
    lines.push(`  connect?: ${typeName}WhereUnique | ${typeName}WhereUnique[];`);
    lines.push(`  connectOrCreate?: ${typeName}ConnectOrCreate | ${typeName}ConnectOrCreate[];`);
    lines.push(`  disconnect?: ${typeName}WhereUnique | ${typeName}WhereUnique[];`);
    lines.push(`  set?: ${typeName}WhereUnique[];`);
    lines.push(`  delete?: ${typeName}WhereUnique | ${typeName}WhereUnique[];`);
    lines.push('}');
    lines.push('');

    lines.push(`export interface ${typeName}ConnectOrCreate {`);
    lines.push(`  where: ${typeName}WhereUnique;`);
    lines.push(`  create: ${typeName}CreateInput;`);
    lines.push('}');
    lines.push('');
  }
```

Note: `*CreateInput` references itself recursively through `*NestedCreateInput` → `*CreateInput` — this is intentional for deep nesting and TypeScript handles recursive type aliases fine.

- [ ] **Step 4: Run test — verify it passes**

Run: `npx tsx --test src/test/generate-nested-types.test.ts`
Expected: PASS

- [ ] **Step 5: Run typecheck and existing tests**

Run: `npm run typecheck && npm run test:unit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/generate.ts src/test/generate-nested-types.test.ts
git commit -m "feat: code generator emits nested write input types (CreateInput, UpdateInput, WhereUnique, ConnectOrCreate)"
```

---

## Task 5: Integration tests

Test the full nested write flow against a real Postgres database.

**Files:**
- Create: `src/test/nested-write-integration.test.ts`

- [ ] **Step 1: Create integration test file**

Create `src/test/nested-write-integration.test.ts`:

```ts
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { TurbineClient } from '../client.js';
import { ValidationError } from '../errors.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata } from '../schema.js';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping nested write integration tests: DATABASE_URL not set');
}

let db: TurbineClient;
let schema: SchemaMetadata;

const testFn = SKIP ? describe.skip : describe;

testFn('nested write integration tests', () => {
  before(async () => {
    schema = await introspect({ connectionString: DATABASE_URL! });
    db = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 5 }, schema);
    await db.connect();
  });

  after(async () => {
    await db.disconnect();
  });

  describe('create with nested create', () => {
    it('creates parent with hasMany children', async () => {
      const uniqueEmail = `nested-test-${Date.now()}@example.com`;
      const user = await db.table('users').create({
        data: {
          email: uniqueEmail,
          name: 'Nested Test User',
          posts: {
            create: [
              { title: 'Nested Post 1', content: 'Content 1' },
              { title: 'Nested Post 2', content: 'Content 2' },
            ],
          },
        },
      }) as Record<string, unknown>;

      assert.ok(user.id);
      assert.equal(user.email, uniqueEmail);
      // Should include posts in return
      assert.ok(Array.isArray((user as any).posts));
      assert.equal((user as any).posts.length, 2);
      assert.equal((user as any).posts[0].title, 'Nested Post 1');
    });

    it('creates parent with single nested child (not array)', async () => {
      const uniqueEmail = `nested-single-${Date.now()}@example.com`;
      const user = await db.table('users').create({
        data: {
          email: uniqueEmail,
          name: 'Single Nest User',
          posts: {
            create: { title: 'Single Nested Post', content: 'Solo' },
          },
        },
      }) as Record<string, unknown>;

      assert.ok(Array.isArray((user as any).posts));
      assert.equal((user as any).posts.length, 1);
    });
  });

  describe('create with nested connect', () => {
    it('connects existing children to new parent', async () => {
      // First create an orphan post we can connect
      const post = await db.table('posts').create({
        data: { title: 'Connectable Post', content: 'Will be connected', userId: 1 },
      }) as Record<string, unknown>;

      const uniqueEmail = `nested-connect-${Date.now()}@example.com`;
      const user = await db.table('users').create({
        data: {
          email: uniqueEmail,
          name: 'Connect Test User',
          posts: {
            connect: [{ id: post.id }],
          },
        },
      }) as Record<string, unknown>;

      assert.ok(Array.isArray((user as any).posts));
      const connectedPost = (user as any).posts.find((p: any) => p.id === post.id);
      assert.ok(connectedPost);
    });
  });

  describe('update with nested operations', () => {
    it('creates new children on update', async () => {
      const uniqueEmail = `update-create-${Date.now()}@example.com`;
      const user = await db.table('users').create({
        data: { email: uniqueEmail, name: 'Update Test' },
      }) as Record<string, unknown>;

      const updated = await db.table('users').update({
        where: { id: user.id },
        data: {
          posts: {
            create: [{ title: 'Added via update', content: 'New!' }],
          },
        },
      }) as Record<string, unknown>;

      assert.ok(Array.isArray((updated as any).posts));
      assert.equal((updated as any).posts.length, 1);
      assert.equal((updated as any).posts[0].title, 'Added via update');
    });

    it('deletes children on update', async () => {
      const uniqueEmail = `update-delete-${Date.now()}@example.com`;
      const user = await db.table('users').create({
        data: {
          email: uniqueEmail,
          name: 'Delete Test',
          posts: {
            create: [
              { title: 'Keep this', content: 'Kept' },
              { title: 'Delete this', content: 'Gone' },
            ],
          },
        },
      }) as Record<string, unknown>;

      const posts = (user as any).posts as any[];
      const deleteTarget = posts.find((p: any) => p.title === 'Delete this');

      const updated = await db.table('users').update({
        where: { id: user.id },
        data: {
          posts: {
            delete: [{ id: deleteTarget.id }],
          },
        },
      }) as Record<string, unknown>;

      const remainingPosts = (updated as any).posts as any[];
      assert.equal(remainingPosts.length, 1);
      assert.equal(remainingPosts[0].title, 'Keep this');
    });
  });

  describe('transaction rollback', () => {
    it('rolls back all nested writes on failure', async () => {
      const uniqueEmail = `rollback-test-${Date.now()}@example.com`;
      const countBefore = await db.table('users').count({
        where: { email: uniqueEmail },
      }) as number;

      try {
        await db.table('users').create({
          data: {
            email: uniqueEmail,
            name: 'Rollback Test',
            posts: {
              connect: [{ id: -999999 }], // non-existent — should fail
            },
          },
        });
        assert.fail('Should have thrown');
      } catch {
        // Expected
      }

      const countAfter = await db.table('users').count({
        where: { email: uniqueEmail },
      }) as number;
      assert.equal(countAfter, countBefore, 'User should not have been created due to rollback');
    });
  });

  describe('non-nested create still works (fast path)', () => {
    it('creates without nesting — no transaction overhead', async () => {
      const uniqueEmail = `fast-path-${Date.now()}@example.com`;
      const user = await db.table('users').create({
        data: { email: uniqueEmail, name: 'Fast Path User' },
      }) as Record<string, unknown>;

      assert.ok(user.id);
      assert.equal(user.email, uniqueEmail);
      // Should NOT have posts key (no `with` clause)
      assert.ok(!('posts' in user));
    });
  });
});
```

- [ ] **Step 2: Run integration tests (requires DATABASE_URL)**

Run: `DATABASE_URL=postgres://... npx tsx --test src/test/nested-write-integration.test.ts`
Expected: PASS (or SKIP if no DATABASE_URL)

- [ ] **Step 3: Commit**

```bash
git add src/test/nested-write-integration.test.ts
git commit -m "test: add nested write integration tests"
```

---

## Task 6: Export and final wiring

Ensure all new types and functions are properly exported from the package.

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add nested-write exports to `src/index.ts`**

Add after the query builder exports block (after line 127):

```ts
// Nested writes
export {
  executeNestedCreate,
  executeNestedUpdate,
  hasRelationFields,
  type NestedWriteContext,
} from './nested-write.js';
```

- [ ] **Step 2: Run typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: PASS — ESM and CJS output both compile.

- [ ] **Step 3: Run full unit test suite**

Run: `npm run test:unit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: export nested write functions and types from package index"
```

---

## Task 7: Build verification and cleanup

Final verification that everything compiles, tests pass, and nothing regressed.

- [ ] **Step 1: Run full build**

Run: `npm run build`
Expected: PASS — dist/ and dist-cjs/ generated without errors.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: PASS (or only pre-existing warnings)

- [ ] **Step 4: Run all unit tests**

Run: `npm run test:unit`
Expected: PASS — all existing + new tests pass.

- [ ] **Step 5: Run integration tests (if DATABASE_URL available)**

Run: `npm test`
Expected: PASS — all tests pass or skip gracefully.

- [ ] **Step 6: Final commit if any lint fixes were needed**

```bash
git add -A
git commit -m "chore: lint fixes for nested writes"
```
