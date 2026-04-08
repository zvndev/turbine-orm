# Migrating from Prisma

Turbine is a Postgres-native TypeScript ORM with a Prisma-inspired API. If you're already on Prisma but want a smaller dependency footprint, edge/serverless support without an extra adapter, and a code-first schema (no `.prisma` DSL), Turbine is a near drop-in. Most of your query code will move over by renaming `include` to `with` and re-pointing your imports.

## API mapping

| Prisma | Turbine | Notes |
|---|---|---|
| `prisma.user.findMany` | `db.users.findMany` | Table accessor uses the snake_case table name (camelCased). |
| `prisma.user.findUnique` | `db.users.findUnique` | Same shape. |
| `prisma.user.findFirst` | `db.users.findFirst` | Same. |
| `prisma.user.findFirstOrThrow` | `db.users.findFirstOrThrow` | Throws `NotFoundError` (`TURBINE_E001`). |
| `prisma.user.findUniqueOrThrow` | `db.users.findUniqueOrThrow` | Same. |
| `prisma.user.create` | `db.users.create` | Same `data` shape. |
| `prisma.user.createMany` | `db.users.createMany` | Single `INSERT ... UNNEST` under the hood. |
| `prisma.user.update` | `db.users.update` | Supports atomic operators: `{ count: { increment: 1 } }`. |
| `prisma.user.updateMany` | `db.users.updateMany` | Empty `where` is rejected unless `allowFullTableScan: true`. |
| `prisma.user.delete` | `db.users.delete` | Same. |
| `prisma.user.deleteMany` | `db.users.deleteMany` | Empty `where` is rejected unless `allowFullTableScan: true`. |
| `prisma.user.upsert` | `db.users.upsert` | Same `where` / `create` / `update` shape. |
| `prisma.user.count` | `db.users.count` | Same. |
| `prisma.user.aggregate` | `db.users.aggregate` | `_sum` / `_avg` / `_min` / `_max` / `_count`. |
| `prisma.user.groupBy` | `db.users.groupBy` | `by`, `where`, `orderBy` supported. |
| `prisma.$transaction` | `db.$transaction` | Callback form with nested SAVEPOINTs and isolation levels. |
| `include: { posts: true }` | `with: { posts: true }` | The only renamed key. |
| `select: { id: true, name: true }` | `select: { id: true, name: true }` | Same. |
| `where: { name: { contains: 'a' } }` | `where: { name: { contains: 'a' } }` | All operators ported (`gt`/`gte`/`lt`/`lte`/`in`/`notIn`/`contains`/`startsWith`/`endsWith`/`mode: 'insensitive'`). |
| `where: { posts: { some: ... } }` | `where: { posts: { some: ... } }` | Relation filters: `some` / `every` / `none`. |

## Side-by-side example

A `findMany` with a nested `include` and ordering:

```ts
// Prisma
const users = await prisma.user.findMany({
  where: { orgId: 1 },
  include: { posts: { orderBy: { createdAt: 'desc' }, take: 5 } },
  orderBy: { createdAt: 'desc' },
  take: 10,
});
```

```ts
// Turbine
const users = await db.users.findMany({
  where: { orgId: 1 },
  with: { posts: { orderBy: { createdAt: 'desc' }, limit: 5 } },
  orderBy: { createdAt: 'desc' },
  limit: 10,
});
```

The two main lexical differences: Prisma's `include` becomes `with`, and Prisma's `take` becomes `limit`. Both queries resolve in a single SQL round-trip.

## Notable differences

- **No `schema.prisma`.** Turbine is code-first. Define tables in TypeScript with `defineSchema()` and run `npx turbine push` (or `migrate create --auto`) to apply them. The schema file is just a TypeScript module — no separate DSL, no separate parser.
- **`include` is `with`.** That's the rename. `with` accepts the same nested options (`where`, `orderBy`, `limit`, `select`, `omit`, and further `with`).
- **`take` is `limit`, `skip` is `offset`.** Otherwise pagination is the same.
- **Atomic update operators are first-class.** `data: { viewCount: { increment: 1 } }` generates `view_count = view_count + $1` — race-free without an extra round-trip. Operators: `set`, `increment`, `decrement`, `multiply`, `divide`.
- **Typed errors with codes.** Constraint violations come back as `UniqueConstraintError` / `ForeignKeyError` / `NotNullViolationError` / `CheckConstraintError`, all with `code` (`TURBINE_E008`–`E011`) and `cause` chaining. `findUniqueOrThrow` throws `NotFoundError` (`TURBINE_E001`) with the original `where` attached.
- **Driver-agnostic edge support.** Pass any pg-compatible pool (Neon, Vercel Postgres, Cloudflare Hyperdrive, Supabase) to `turbineHttp(pool, schema)` and Turbine runs on Vercel Edge, Cloudflare Workers, Deno Deploy, or Netlify Edge — no extra runtime dependencies.
- **Single dependency.** Turbine ships with `pg` as its only runtime dep (~110KB on npm). No engine binary, no WASM, no `@prisma/client` package to keep in sync.
- **Postgres only.** Turbine is intentionally PostgreSQL-only — no MySQL/SQLite/MSSQL — because the `json_agg` strategy is Postgres-specific.
