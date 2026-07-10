# Nested Writes — Design Spec

Turbine ORM feature: create, connect, connectOrCreate, disconnect, set, and delete related records within a single `create()` or `update()` call. Full Prisma parity, arbitrary depth, full tree return.

## API Surface

### Inside create()

```ts
const user = await db.users.create({
  data: {
    email: 'alice@example.com',
    posts: {
      create: [
        { title: 'First Post', comments: { create: [{ body: 'Nice!' }] } },
        { title: 'Second Post' },
      ],
      connect: [{ id: 42 }],
      connectOrCreate: [{
        where: { slug: 'draft' },
        create: { title: 'Draft', slug: 'draft' },
      }],
    },
  },
});
// Returns: User & { posts: Post[] } — full tree
```

### Inside update()

```ts
const updated = await db.users.update({
  where: { id: 1 },
  data: {
    name: 'Alice Updated',
    posts: {
      create: [{ title: 'New Post' }],
      connect: [{ id: 99 }],
      connectOrCreate: [{ where: { slug: 'x' }, create: { title: 'X', slug: 'x' } }],
      disconnect: [{ id: 42 }],
      set: [{ id: 10 }, { id: 20 }],
      delete: [{ id: 5 }],
    },
  },
});
```

### Rules

- Relation fields keyed by relation name (same names as `with` clauses).
- `create` accepts a single object or array.
- `connect` / `disconnect` / `delete` accept a unique where clause (single or array).
- `connectOrCreate` accepts `{ where, create }` pairs (single or array).
- `set` is update-only: replaces the full relation set (disconnect all existing, connect these).
- `disconnect` / `set` / `delete` are only valid inside `update()`, not `create()`.
- Return type includes all nested relations that were written to.
- Non-relation scalar fields work exactly as today. Zero breaking changes.

## Architecture

### New file: `src/nested-write.ts` (~400-500 LOC)

Contains `executeNestedCreate()` and `executeNestedUpdate()`. Pure functions that accept a `TransactionClient`, table name, data, and schema metadata. Separated from `query/builder.ts` (already 3.1K LOC) to keep modules focused.

### Execution algorithm — `executeNestedCreate(tx, tableName, data, schema, depth)`

1. **Separate** scalar fields from relation fields using `schema.tables[tableName].relations`.
2. **Insert parent:** `tx.table(tableName).create({ data: scalars })` → `parentRow`.
3. **For each relation field** in data:
   - Resolve relation metadata (type, FK column, reference key).
   - **hasMany / hasOne** (parent owns PK, child holds FK):
     - `create`: inject parent's PK as FK value into each child record, batch-insert via `createMany` (UNNEST), recurse for grandchildren.
     - `connect`: batch-validate rows exist via `SELECT id FROM t WHERE id IN (...)`, then batch `UPDATE t SET fk = parent.pk WHERE id IN (...)`.
     - `connectOrCreate`: `INSERT ... ON CONFLICT DO NOTHING RETURNING *`, fallback `SELECT` for conflict rows, then batch `UPDATE` FK.
   - **belongsTo** (this table holds the FK):
     - `create`: insert related row first, then `UPDATE` parent's FK column.
     - `connect`: validate existence, `UPDATE` parent's FK.
4. **Final read:** Single `findUnique({ where: { pk }, with: { ...touchedRelations } })` using existing `json_agg` machinery to return full tree.
5. **Depth cap:** 10 levels, throws `CircularRelationError` (E007) with path trail.

### Execution algorithm — `executeNestedUpdate(tx, tableName, where, data, schema, depth)`

1. **Separate** scalar fields from relation fields.
2. **Update parent** with scalar data (if any): `tx.table(tableName).update({ where, data: scalars })` → `parentRow`.
3. **For each relation field**:
   - `create` / `connect` / `connectOrCreate`: same as nested create.
   - `disconnect`: `UPDATE` child FK to `NULL`. Error if FK is NOT NULL.
   - `set`: find all children currently linked → disconnect those not in set → connect those in set.
   - `delete`: `DELETE` matching child rows.
4. **Final read:** Same `findUnique` with `with` clause.

### Batching optimization

At each nesting level, all `create` items for the same relation are collected into a single `createMany` call (UNNEST — one query per relation per level, not per row). For grandchildren: insert all parents first, map returned IDs, batch all grandchildren with correct FK values in one `createMany`.

Typical "create user + 3 posts + 2 comments each" = 3 queries (1 user + 1 UNNEST posts + 1 UNNEST comments), not 9.

### Transaction handling

The `create()` / `update()` methods in `QueryInterface` detect relation fields in `data`. If present:
- If not already in a transaction: wrap in an implicit `$transaction`.
- If inside an existing `$transaction`: use a savepoint via nested `$transaction`.

If no relation fields, the existing fast path runs unchanged — zero overhead for non-nested writes.

## Type System

### Generated types (from `generate.ts`)

Per table with relations, emit:

```ts
// Unique key union — from PK + unique indexes
export type PostWhereUnique = { id: number } | { slug: string };

// Nested create operations for "posts" relation on User
export type PostNestedCreateInput = {
  create?: PostCreateInput | PostCreateInput[];
  connect?: PostWhereUnique | PostWhereUnique[];
  connectOrCreate?: PostConnectOrCreate | PostConnectOrCreate[];
};

// Nested update operations (superset — adds disconnect/set/delete)
export type PostNestedUpdateInput = PostNestedCreateInput & {
  disconnect?: PostWhereUnique | PostWhereUnique[];
  set?: PostWhereUnique[];
  delete?: PostWhereUnique[];
};

export type PostConnectOrCreate = {
  where: PostWhereUnique;
  create: PostCreateInput;
};

// Extended input types
export type UserCreateInput = UserCreate & {
  posts?: PostNestedCreateInput;
  profile?: ProfileNestedCreateInput;
};

export type UserUpdateInput = UserUpdate & {
  posts?: PostNestedUpdateInput;
  profile?: ProfileNestedUpdateInput;
};
```

`*CreateInput` extends `*Create` (existing type) with optional relation fields. The `create()` method accepts `CreateArgs<T>` where `data` is `Partial<T>` — the generated `*CreateInput` type flows through this. The generated typed client overrides the signature to use the specific input type for full autocomplete.

`*WhereUnique` is generated from the table's primary key columns plus each unique index. Each unique constraint becomes one branch of the union.

### Return type inference

When `data` contains relation keys, the return type includes those relations. The generated client overrides `create()` / `update()` to carry the nested type through. Internally, the final `findUnique` call uses the existing `WithResult` mapped type, which already handles arbitrary-depth relation inference.

### Back-compatibility

- Existing `*Create` and `*Update` types are untouched.
- `create({ data: { email: 'x' } })` (no relation fields) works exactly as before — same code path, same types, same performance.
- `*CreateInput` / `*UpdateInput` are new additive types. Generated alongside existing types.

## Integration Points

### Files modified

| File | Change |
|------|--------|
| `src/nested-write.ts` | **New.** Core nested write execution logic. |
| `src/query/builder.ts` | `create()` and `update()` detect relation fields → delegate to `nested-write.ts`. |
| `src/query/types.ts` | Add runtime type defs: `NestedCreateOp`, `NestedUpdateOp`, `ConnectOrCreateOp`. |
| `src/generate.ts` | Emit `*CreateInput`, `*UpdateInput`, `*WhereUnique`, `*ConnectOrCreate` types. |
| `src/index.ts` | Re-export new types. |
| `src/errors.ts` | No new error codes needed — reuses E001, E003, E005, E007, E009. |

### Files untouched

- `buildCreate()` / `buildCreateMany()` / `buildUpdate()` SQL builders.
- `client.ts` transaction infrastructure.
- `with` clause inference (reused as-is for final tree read).
- Schema metadata types.
- CLI, introspect, pipeline, serverless modules.

## Error Handling

| Scenario | Error | Code |
|----------|-------|------|
| Unknown relation name in `data` | `RelationError` | E005 |
| `connect` to non-existent row | `NotFoundError` (pre-validated) | E001 |
| `disconnect` on NOT NULL FK | `ValidationError` | E003 |
| Nesting depth > 10 | `CircularRelationError` | E007 |
| FK constraint violation (db-level) | `ForeignKeyError` | E009 |
| Unique constraint on connect | `UniqueConstraintError` | E008 |
| Partial failure at any point | Full transaction rollback | — |
| Empty create/connect array | No-op, skip silently | — |
| `disconnect` / `set` / `delete` inside `create()` | `ValidationError` ("only valid in update") | E003 |

## Testing Plan

### Unit tests (no DB)

- Relation field detection: correctly separates scalar vs relation fields.
- FK injection: parent PK correctly inserted as FK in child data.
- Tree walk order: depth-first, parent before children.
- Batching: multiple children consolidated into one `createMany` call.
- Validation: unknown relation names, disconnect-on-not-null, update-only ops in create.
- Type generation: `*CreateInput`, `*UpdateInput`, `*WhereUnique` output matches expected.

### Integration tests (with DB)

- Create user with posts → verify returned tree, verify DB state.
- Create user with posts with comments (3 levels) → verify full tree.
- Update user: create new posts + connect existing + disconnect.
- `connectOrCreate` — both the "create" and "connect" paths.
- `set` — replaces full relation set.
- `delete` — removes child rows.
- Transaction rollback on failure: partial nested write leaves no trace.
- Nested write inside explicit `$transaction` uses savepoint.
- belongsTo direction: create post with `author: { connect: { id: 1 } }`.

### Type tests (compile-time)

- `UserCreateInput` accepts nested `posts.create`.
- Return type of `create()` with nested data includes `posts: Post[]`.
- `disconnect` / `set` / `delete` rejected at type level inside `create()`.
- Deep nesting types work: `UserCreateInput.posts.create.comments.create`.

## Performance Characteristics

| Operation | Queries |
|-----------|---------|
| Create user (no nesting) | 1 (unchanged) |
| Create user + 50 posts | 3 (insert user + UNNEST posts + findUnique tree) |
| Create user + 3 posts + 2 comments each | 4 (user + posts + comments + read) |
| Create user + 3 posts + 2 comments each + 1 tag each | 5 |
| Update user + connect 5 posts | 4 (update + batch WHERE IN check + batch UPDATE FKs + read) |
| Update user + create 5 posts | 3 (update + UNNEST + read) |

General formula: `1 (root) + N (one UNNEST per relation per level) + 1 (final read)`. Connects batch existence checks via `WHERE id IN (...)` and batch FK updates in a single `UPDATE ... WHERE id IN (...)` statement.

Compare to Prisma: Prisma issues one INSERT per row at every level. A user + 50 posts = 51 queries. Turbine = 3.
