# Using Turbine ORM — full DX reference

**Scope:** everything a user needs to do to use Turbine end-to-end — install, define a schema, query, write, transact, batch, stream, handle errors, migrate, and deploy to the edge.

**Why this doc exists:** it's also a **reference for building a PowQL-native TypeScript client with a similar DX**. Every section lists the DX pattern, the API shape, and a *port note* — what changes if your underlying store isn't Postgres. If you're building the PowDB TS client, read the port notes.

---

## 0. Installation & project layout

### Install

```bash
npm install turbine-orm
```

One runtime dependency: `pg`. Ships both ESM (`dist/`) and CJS (`dist-cjs/`). Serverless/edge entry at `turbine-orm/serverless`.

### Recommended project layout

```
project/
├── turbine.config.ts          # CLI config — DB URL, output path, schema path
├── turbine/
│   └── schema.ts              # defineSchema() — source of truth
├── generated/
│   └── turbine/               # emitted by `npx turbine generate`
│       ├── types.ts           # entity + Create + Update + Relations types
│       ├── metadata.ts        # runtime SchemaMetadata — edge-safe
│       └── index.ts           # typed TurbineClient + turbine() factory
├── migrations/
│   └── 20260410143022_init.sql
└── src/
    └── db.ts                  # export const db = turbine({ ... })
```

### `turbine.config.ts`

```ts
import type { TurbineConfig } from 'turbine-orm/cli';

export default {
  url: process.env.DATABASE_URL,
  out: './generated/turbine',
  schema: './turbine/schema.ts',
  migrations: './migrations',
} satisfies TurbineConfig;
```

**Port note for PowDB TS client:** mirror the `turbine.config.ts` concept — one config file that points at the DB, schema source, output dir, migrations dir. Users expect this shape.

---

## 1. Schema definition

Two workflows. Pick one per project, or mix.

### Code-first: `defineSchema`

```ts
// turbine/schema.ts
import { defineSchema } from 'turbine-orm';

export default defineSchema({
  organizations: {
    id: { type: 'serial', primaryKey: true },
    name: { type: 'text', notNull: true },
    createdAt: { type: 'timestamp', default: 'now()' },
  },
  users: {
    id: { type: 'serial', primaryKey: true },
    email: { type: 'text', unique: true, notNull: true },
    name: { type: 'text', notNull: true },
    orgId: { type: 'bigint', notNull: true, references: 'organizations.id' },
    role: { type: 'text', notNull: true, default: "'member'" },
    createdAt: { type: 'timestamp', default: 'now()' },
  },
  posts: {
    id: { type: 'serial', primaryKey: true },
    userId: { type: 'bigint', notNull: true, references: 'users.id' },
    title: { type: 'text', notNull: true },
    content: { type: 'text' },
    published: { type: 'boolean', notNull: true, default: 'false' },
    viewCount: { type: 'integer', notNull: true, default: '0' },
    createdAt: { type: 'timestamp', default: 'now()' },
  },
  memberships: {
    userId: { type: 'bigint', notNull: true, references: 'users.id' },
    orgId: { type: 'bigint', notNull: true, references: 'organizations.id' },
    role: { type: 'text', notNull: true, default: "'member'" },
    primaryKey: ['userId', 'orgId'],
  },
});
```

### Column options

| Option | Meaning |
|---|---|
| `type` | Postgres type. `serial`, `bigserial`, `text`, `varchar`, `integer`, `bigint`, `boolean`, `timestamp`, `timestamptz`, `date`, `uuid`, `jsonb`, `bytea`, etc. |
| `primaryKey: true` | Column-level PK. |
| `primaryKey: [...]` | Table-level composite PK. |
| `unique: true` | UNIQUE constraint. |
| `notNull: true` | NOT NULL. |
| `default: '...'` | Raw SQL default — quoted text values need their own quotes: `'member'`. Function calls like `now()` are passed through. |
| `references: 'table.column'` | Foreign key. Infers the relation direction. |
| `check: '...'` | CHECK constraint expression. |
| `index: true \| { using: 'gin' \| 'gist' }` | Index. |

### DB-first: introspect

```bash
npx turbine pull     # or: npx turbine generate
```

Reads `information_schema` + `pg_catalog`, emits the same three files as code-first. Use this when the database is the source of truth (legacy app, another team owns the schema).

### What the generator emits

Three files in `./generated/turbine/`:

1. **`types.ts`** — for each table:
   - `User` — the full entity interface (PascalCase, singularized).
   - `UserCreate` — optional PK / default / nullable; required otherwise. What you pass to `create({ data })`.
   - `UserUpdate` — all non-PK fields optional. What you pass to `update({ data })`.
   - `UserRelations` — phantom-branded relation descriptors. Feeds deep `with` inference.
2. **`metadata.ts`** — runtime `SchemaMetadata`. Pure data — no imports, edge-safe.
3. **`index.ts`** — `TurbineClient` subclass with `declare readonly users: TableApi<User, UserRelations>` + `turbine(config)` factory.

**Port note:** PowDB TS client should emit the same three-file split. Entity interfaces + `*Create` / `*Update` / `*Relations` types + runtime metadata + a typed client factory. The phantom-brand technique on `*Relations` is what enables deep type inference — port it verbatim.

---

## 2. Creating the client

### Node (owns the pool)

```ts
// src/db.ts
import { turbine } from '../generated/turbine';

export const db = turbine({
  connectionString: process.env.DATABASE_URL,
  max: 10,              // pool size
  idleTimeoutMillis: 30_000,
});
```

### Edge (external pool)

```ts
import { turbineHttp } from 'turbine-orm/serverless';
import { schema } from '../generated/turbine/metadata';
import { Pool } from '@neondatabase/serverless';

const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
export const db = turbineHttp(pool, schema);
```

Same surface, same types. On external pools, `db.disconnect()` is a no-op — the caller owns lifecycle.

### Middleware

```ts
db.$use(async (params, next) => {
  const started = Date.now();
  const result = await next(params);
  console.log(`${params.model}.${params.action} took ${Date.now() - started}ms`);
  return result;
});
```

Middleware runs *after* SQL generation — it sees the params, not the SQL — and can inspect/log/transform. Can't rewrite SQL.

**Port note:** the `$use` lifecycle hook pattern is widely-understood (Prisma, Mongoose). Recommend porting. Run the middleware stack against the *parsed* query, not the generated wire command, so middleware is dialect-independent.

---

## 3. Querying — reads

### `findMany`

Returns an array. All options are optional.

```ts
const users = await db.users.findMany({
  where: { role: 'admin', orgId: 1 },
  orderBy: { createdAt: 'desc' },
  limit: 20,       // or: take
  offset: 0,       // or: skip
  select: { id: true, email: true },  // or: omit
  with: { posts: true },
});
```

### `findUnique` / `findUniqueOrThrow`

Match on PK or `unique` constraint.

```ts
const user = await db.users.findUnique({ where: { id: 42 } });
// User | null

const user2 = await db.users.findUniqueOrThrow({ where: { email: 'a@b.c' } });
// User — throws NotFoundError (TURBINE_E001) if missing
```

Composite PK:

```ts
await db.memberships.findUnique({ where: { userId: 1, orgId: 2 } });
```

### `findFirst` / `findFirstOrThrow`

Non-unique match, first row per `orderBy`.

```ts
const latestPost = await db.posts.findFirst({
  where: { userId: 1 },
  orderBy: { createdAt: 'desc' },
});
```

### `count`

```ts
const n = await db.posts.count({ where: { published: true } });
```

### `aggregate`

```ts
const stats = await db.posts.aggregate({
  where: { userId: 1 },
  _sum: { viewCount: true },
  _avg: { viewCount: true },
  _min: { createdAt: true },
  _max: { createdAt: true },
  _count: true,
});
// stats._sum.viewCount, stats._avg.viewCount, ...
```

### `groupBy`

```ts
const byRole = await db.users.groupBy({
  by: ['role'],
  _count: true,
  orderBy: { _count: { role: 'desc' } },
});
// [{ role: 'admin', _count: 3 }, { role: 'member', _count: 42 }]
```

---

## 4. `where` clauses

All operators:

```ts
where: {
  // Equality — the default
  role: 'admin',

  // Null / not null
  deletedAt: null,

  // Numeric / date operators
  createdAt: { gte: new Date('2026-01-01'), lt: new Date('2026-02-01') },
  viewCount: { gt: 100 },

  // String operators
  email: { contains: '@acme.com' },
  name: { startsWith: 'A' },
  title: { endsWith: '.pdf' },
  body: { contains: 'urgent', mode: 'insensitive' }, // ILIKE

  // Set operators
  id: { in: [1, 2, 3] },
  status: { notIn: ['archived', 'deleted'] },

  // Negation
  role: { not: 'banned' },

  // Combinators
  OR: [{ role: 'admin' }, { orgId: 1 }],
  AND: [{ published: true }, { viewCount: { gt: 10 } }],
  NOT: { role: 'banned' },

  // Relation filters (EXISTS / NOT EXISTS subqueries)
  posts: { some: { published: true } },
  posts: { every: { published: true } },
  posts: { none: {} },

  // JSON / JSONB
  metadata: { path: ['tags'], array_contains: 'featured' },

  // Arrays
  tags: { array_contains: ['new', 'hot'] },
  tags: { array_contains_any: ['sale'] },
}
```

**Port note for PowDB:** PowQL uses a different filter syntax (`filter .age > 25`). The *user-facing* `where` object shape is worth keeping — it's what Prisma / Drizzle / Turbine users expect. Translate the object into PowQL pipelines under the hood. Don't expose PowQL syntax at the TS layer.

---

## 5. Nested relations — `with`

Same shape regardless of depth. Each level accepts every `findMany` option except `offset` (pagination across nested collections is generally wrong — if you need it, lift to a separate query).

```ts
const users = await db.users.findMany({
  with: {
    posts: {
      where: { published: true },
      orderBy: { createdAt: 'desc' },
      limit: 5,
      select: { id: true, title: true, createdAt: true },
      with: {
        comments: {
          where: { flagged: false },
          orderBy: { createdAt: 'asc' },
          limit: 20,
        },
      },
    },
    memberships: {
      with: { organization: true },
    },
  },
});

// Fully typed:
// users[0].posts[0].comments[0].body
// users[0].memberships[0].organization.name
```

**Depth cap:** 10. Beyond that → `CircularRelationError` with the full path.

**Return shape rule:** `hasMany` → `T[]` (never null, `[]` for empty). `belongsTo` / `hasOne` → `T | null`.

**Port note:** the single most important DX win in modern ORMs is deep `with` type inference. Port it aggressively. The mechanism:

1. Emit a branded `*Relations` interface alongside each entity:
   ```ts
   interface UserRelations {
     posts: RelationDescriptor<Post, 'many', PostRelations>;
     profile: RelationDescriptor<Profile, 'one', ProfileRelations>;
   }
   ```
2. Make `findMany<W>` generic over `W extends WithClause<UserRelations>`.
3. A recursive mapped type (`WithResult<T, R, W>`) walks `W` at arbitrary depth, reading the target + cardinality off `R`, re-applying cardinality at each level.

That's the trick. Without it, users write manual `UserWithPosts` / `UserWithPostsAndComments` types and hate you.

---

## 6. Writes

### `create`

```ts
const user = await db.users.create({
  data: { email: 'alice@example.com', name: 'Alice' },
});
// returns User
```

`data` is typed as `UserCreate` — PK, default-having, and nullable fields optional; everything else required.

### `createMany`

```ts
const { count } = await db.users.createMany({
  data: [
    { email: 'a@b.c', name: 'A' },
    { email: 'd@e.f', name: 'D' },
  ],
});
// Single INSERT ... UNNEST — one round-trip regardless of row count
```

### `update`

```ts
const updated = await db.users.update({
  where: { id: 1 },
  data: { name: 'Alice Updated' },
});
```

### Atomic update operators

```ts
await db.posts.update({
  where: { id: 1 },
  data: {
    viewCount: { increment: 1 },
    // also: decrement, multiply, divide, set
  },
});
// Generates: view_count = view_count + $1 — race-free, no extra round-trip
```

### `updateMany`

```ts
await db.posts.updateMany({
  where: { userId: 1 },
  data: { published: true },
});
```

**Empty-where guard.** `updateMany({ data, where: {} })` or all-undefined `where` throws `ValidationError` (TURBINE_E003). To mass-mutate on purpose: `updateMany({ data, where: {}, allowFullTableScan: true })`.

### `delete` / `deleteMany`

```ts
await db.posts.delete({ where: { id: 1 } });

await db.posts.deleteMany({
  where: { createdAt: { lt: new Date('2020-01-01') } },
});
```

Empty-where guard applies to `deleteMany` too.

### `upsert`

```ts
await db.users.upsert({
  where: { email: 'a@b.c' },
  create: { email: 'a@b.c', name: 'A' },
  update: { name: 'A' },
});
// INSERT ... ON CONFLICT DO UPDATE
```

**Port note:** keep the `upsert` shape identical — it's the only way to get race-free "create or update" without a transaction. PowDB equivalents will need similar atomic primitives in PowQL or a transaction-wrapped fallback documented clearly.

---

## 7. Transactions

Callback form. Throw to rollback.

```ts
await db.$transaction(async (tx) => {
  const user = await tx.users.create({ data: { email: 'a@b.c', name: 'A' } });
  await tx.posts.create({ data: { userId: user.id, title: 'Hi' } });
});
```

### Options

```ts
await db.$transaction(
  async (tx) => { /* ... */ },
  {
    isolationLevel: 'serializable',   // 'read committed' | 'repeatable read' | 'serializable'
    timeoutMs: 5_000,
  },
);
```

### Nested (SAVEPOINTs)

```ts
await db.$transaction(async (tx) => {
  await tx.users.create({ data: { /* ... */ } });
  try {
    await tx.$transaction(async (inner) => {
      await inner.auditLog.create({ data: { /* ... */ } });
      throw new Error('skip audit');
    });
  } catch {
    // inner rolled back to savepoint; outer still healthy
  }
  await tx.posts.create({ data: { /* ... */ } });
});
```

### Retryable errors

```ts
import { DeadlockError, SerializationFailureError } from 'turbine-orm';

try {
  await db.$transaction(/* ... */);
} catch (err) {
  if (err instanceof DeadlockError || err instanceof SerializationFailureError) {
    // err.isRetryable is `true as const` — TypeScript narrows here
    // retry with exponential backoff
  }
  throw err;
}
```

**Port note:** the `isRetryable = true as const` pattern matters more than it looks. Users' retry loops stay well-typed because the literal type never widens. Port this exactly — don't use a plain `readonly isRetryable: boolean`.

---

## 8. Pipeline batching

N independent queries, one round-trip. Not atomic.

```ts
import { pipeline } from 'turbine-orm';

const [user, posts, count] = await pipeline(db, [
  db.users.buildFindUnique({ where: { id: 1 } }),
  db.posts.buildFindMany({ where: { userId: 1 }, limit: 10 }),
  db.comments.buildCount({ where: { userId: 1 } }),
]);
```

Each `build*` method returns `DeferredQuery<T>` — `{ sql, params, transform, tag }`. The pipeline driver writes them all, reads all responses, applies each `transform`.

**Use when:** dashboard loads, edge fan-out reads, independent widget queries.

**Don't use when:** you need atomicity (use `$transaction`) or one query depends on another's result (must be independent).

**Port note:** pipelining maps to different primitives across stores. For PowDB, consider whether PowQL supports a batch-submit mode — if so, expose it as `pipeline()` with the same deferred-query shape. If not, document that `pipeline()` on PowDB falls back to sequential and skip it for now.

---

## 9. Streaming

For large result sets — uses `DECLARE CURSOR` under the hood, with a speculative first fetch so small results don't pay the cursor overhead.

```ts
for await (const user of db.users.findManyStream({
  where: { createdAt: { gte: new Date('2026-01-01') } },
  batchSize: 1000,
})) {
  await processUser(user);
}
```

Supports nested `with`:

```ts
for await (const user of db.users.findManyStream({
  with: { posts: { limit: 5 } },
  batchSize: 500,
})) {
  console.log(user.posts[0]?.title);
}
```

Clean early-break semantics — cursor is closed even on exception.

**Port note:** async iteration is the right API shape for streaming in TS. Match it regardless of underlying cursor mechanics.

---

## 10. Raw SQL

Tagged template. All values parameterized.

```ts
const rows = await db.raw<{ id: number; email: string }>`
  SELECT id, email FROM users
  WHERE created_at > ${since}
  AND org_id = ${orgId}
`;
```

Inside a transaction:

```ts
await db.$transaction(async (tx) => {
  const rows = await tx.raw`SELECT 1`;
});
```

Typed errors still apply — a unique-violation in raw SQL surfaces as `UniqueConstraintError` via `wrapPgError()`.

---

## 11. Errors

All errors extend `TurbineError` with a `code: TurbineErrorCode` discriminant.

| Code | Class | Triggered by |
|---|---|---|
| E001 | `NotFoundError` | `findUniqueOrThrow`, `findFirstOrThrow` |
| E002 | `TimeoutError` | Query or transaction timeout |
| E003 | `ValidationError` | Unknown column, invalid operator, empty-where guard |
| E004 | `ConnectionError` | Pool connect failure |
| E005 | `RelationError` | Unknown relation name in `with` |
| E006 | `MigrationError` | Checksum mismatch, parse error |
| E007 | `CircularRelationError` | Nesting depth > 10 |
| E008 | `UniqueConstraintError` | PG 23505 |
| E009 | `ForeignKeyError` | PG 23503 |
| E010 | `NotNullViolationError` | PG 23502 |
| E011 | `CheckConstraintError` | PG 23514 |
| E012 | `DeadlockError` | PG 40P01 — `isRetryable: true` |
| E013 | `SerializationFailureError` | PG 40001 — `isRetryable: true` |
| E014 | `PipelineError` | One or more pipeline queries failed |

### Canonical error handling

```ts
import {
  NotFoundError,
  UniqueConstraintError,
  ForeignKeyError,
  DeadlockError,
  SerializationFailureError,
} from 'turbine-orm';

try {
  await db.users.findUniqueOrThrow({ where: { id } });
} catch (err) {
  if (err instanceof NotFoundError) return res.status(404).end();
  if (err instanceof UniqueConstraintError) {
    // err.constraint, err.columns, err.cause (the original pg error)
    return res.status(409).json({ conflict: err.columns });
  }
  throw err;
}
```

**Port note:** a typed error hierarchy rooted at a single `*Error` base with a `code` string discriminant is boring and correct. Port the taxonomy. For PowDB, map PowDB's native error codes to new Turbine-style classes (`PowDbDeadlockError`, etc.).

---

## 12. CLI

```bash
npx turbine init                          # Scaffold config + schema + migrations dir
npx turbine generate                      # Introspect + emit typed client
npx turbine pull                          # Alias for generate
npx turbine push                          # Apply defineSchema to live DB (dev fast-path)
npx turbine push --dry-run                # Preview SQL
npx turbine migrate create <name>         # Blank migration file
npx turbine migrate create <name> --auto  # Auto-diff from defineSchema
npx turbine migrate up                    # Apply pending
npx turbine migrate down                  # Rollback last
npx turbine migrate status                # Applied vs pending
npx turbine seed                          # Run seed script
npx turbine status                        # Schema summary
npx turbine studio                        # Local read-only web UI
```

All commands read `turbine.config.ts` + `DATABASE_URL` env var + CLI flags (in that precedence order, last wins).

---

## 13. Migrations

SQL-first files with `-- UP` and `-- DOWN` sections:

```sql
-- 20260410143022_init.sql
-- UP
CREATE TABLE "users" (
  "id" SERIAL PRIMARY KEY,
  "email" TEXT UNIQUE NOT NULL,
  "created_at" TIMESTAMPTZ DEFAULT now()
);

-- DOWN
DROP TABLE "users";
```

**Tracking:** `_turbine_migrations` table stores `(timestamp, name, checksum, applied_at)`. SHA-256 checksums detect post-hoc edits to applied migrations.

**Concurrency:** `pg_try_advisory_lock()` keyed on DB name — two `migrate up` processes at once → second exits cleanly.

**Transaction:** each migration runs in its own `BEGIN` / `COMMIT`. Partial failure → clean rollback.

**Auto-diff:** `migrate create <name> --auto` runs `schemaDiff()` (compares `defineSchema` output against live DB via `introspect`) and writes the DDL delta. Always review before committing.

**Port note:** SQL-first migration files are the right default — plain text, diffable, fits any DB. For PowDB, replace the SQL parser with a PowQL parser, keep the rest (UP/DOWN split, checksum, advisory lock equivalent, per-migration transaction). The `_turbine_migrations` schema is trivially portable.

---

## 14. Studio (local dev UI)

```bash
npx turbine studio
# → http://127.0.0.1:5055?token=<auto-generated 24-byte hex>
```

Three tabs:

- **Data** — browse any table with pagination.
- **Schema** — tables, columns, relations, indexes.
- **Query** — free-form SELECT playground. Anything that isn't a SELECT is rejected.

**Security posture — port this if you build a PowDB Studio:**

1. **Loopback-only bind.** `127.0.0.1`, not `0.0.0.0`. Warn loudly if user forces a non-loopback host.
2. **Per-process auth token.** 24 random bytes, constant-time compared on every request.
3. **Read-only statement parser.** Strip SQL comments *first*, then check the first word is `SELECT` or `WITH`, then reject any non-trailing `;` to block statement stacking.
4. **Engine-level read-only transaction.** Every query runs inside `BEGIN READ ONLY` + `SET LOCAL statement_timeout = '30s'`. Belt-and-suspenders — even if the parser misses something, Postgres refuses writes.
5. **Security headers.** `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.
6. **CORS.** Exact origin match, not wildcard.

For PowDB: same five rules. The "every query in a read-only transaction" guarantee is the strongest one — a smart DBA can ignore the parser if the engine-level guarantee is absolute.

---

## 15. Testing patterns

### Mock schemas for unit tests

```ts
import { mockTable, makeQuery } from 'turbine-orm/test-helpers';

const usersTable = mockTable('users', {
  id: { type: 'integer', primaryKey: true },
  email: { type: 'text' },
});

const q = makeQuery(usersTable);
const { sql, params } = q.buildFindMany({ where: { email: 'a@b.c' } });
// Assert the generated SQL string — no DB required
```

Most unit tests should use this pattern. Build-only tests catch 90% of query-shape regressions without integration overhead.

### Integration tests

Require seeded Postgres. Gate with `describe.skip` when `DATABASE_URL` is absent:

```ts
const integration = process.env.DATABASE_URL ? describe : describe.skip;

integration('users integration', () => {
  // ...
});
```

In this repo, `./scripts/seed-test-db.sh` spins up a throwaway Postgres and seeds it so contributors can run the full suite.

---

## 16. Deployment checklist

### Node production

- [ ] `connectionString` from env — never commit it.
- [ ] Pool `max` sized to `(db_max_connections - reserved) / app_instances`.
- [ ] `statement_timeout` at DB level (belt) + per-transaction (suspenders).
- [ ] Migrations run as a separate step, not on app boot.
- [ ] `npm run typecheck && npm run test:unit` in CI.
- [ ] Error monitoring hooks into `TurbineError` subclasses, not string matching.

### Edge

- [ ] Import from `turbine-orm/serverless`, not `turbine-orm`.
- [ ] Every `findMany` has an explicit `limit`.
- [ ] Every nested `hasMany` in `with` has an explicit `limit`.
- [ ] Use pooled/HTTP driver endpoints, not direct DB endpoints.
- [ ] Region-match the edge function to the DB when possible.

---

## 17. Things intentionally not supported

- **Lazy loading.** Every field is explicit. If you want `user.posts` you write `with: { posts: true }`. This is a feature; it keeps query costs visible.
- **Model classes.** Rows are plain objects. No `user.save()`, no `user.$prisma`, no decorators. Plays well with JSON, serializers, validation libraries.
- **Automatic soft-delete.** Use middleware if you want it — `$use` can rewrite `findMany` to add `deletedAt: null`. Baking it in would hide it.
- **Multi-database at runtime.** One `TurbineClient` = one pool = one DB. For multi-tenancy, create multiple clients.
- **Hooks on entity mutation.** Use middleware for cross-cutting concerns. Entity-lifecycle hooks encourage spaghetti.

---

## 18. What to port to a PowDB TS client — summary

The API shapes that matter most, in rough priority:

1. **Generated client with typed `db.<table>` accessors.** The single biggest DX win.
2. **`findMany` / `findUnique` / `create` / `update` / `delete` surface with Prisma-like names.** Familiarity compounds.
3. **`where` object with operators (`gt`, `in`, `contains`, etc.) and `OR` / `AND` / `NOT` combinators.** Translate to PowQL filters under the hood; don't expose PowQL syntax at the TS layer.
4. **`with` clause with deep type inference via branded `*Relations` interfaces.** Without this, nested queries are untyped and users reach for `any`.
5. **Atomic update operators (`increment`, `decrement`).** Race-free without transactions.
6. **Empty-where guard on `updateMany` / `deleteMany`.** Has saved more production data than any feature I can name.
7. **Typed error hierarchy with `code` discriminants + `isRetryable` literal type.** Retry loops stay well-typed.
8. **Callback-style `$transaction` with nested savepoint-equivalents.** If PowDB has transactions, mirror this shape.
9. **Pipeline batching — if the underlying protocol supports batch-submit.** Edge runtime killer feature.
10. **Async-iterator streaming.** Right shape for TS, regardless of cursor mechanics.
11. **Built-in read-only Studio with the five security rules above.** Local DX + DBA-approvable.
12. **CLI with config file + env var + flag precedence.** Users expect this.
13. **SQL-first (or PowQL-first) migrations with checksums + advisory lock + per-migration transaction.** Battle-tested pattern.

The things you can skip without much regret:

- A full introspect-from-live-DB layer — ship code-first first, introspect later.
- Code-generation that emits a `TurbineClient` subclass — a factory function with inferred generics works fine.
- Middleware — nice to have, not v1 critical.
- Aggregate / groupBy — niche, ship it when someone asks.

---

## 19. See also

- **Site docs:** [turbineorm.dev](https://turbineorm.dev)
- **API reference:** [`site/app/(docs)/queries/page.mdx`](../site/app/\(docs\)/queries/page.mdx)
- **Migration guide:** [`site/app/(docs)/migrate-from-prisma/page.mdx`](../site/app/\(docs\)/migrate-from-prisma/page.mdx)
- **Next integrations plan:** [`NEXT-INTEGRATIONS.md`](./NEXT-INTEGRATIONS.md)
- **Release playbook:** [`../AGENTS.md`](../AGENTS.md)
