# turbine-orm

Postgres-native TypeScript ORM — runs on **Neon, Vercel Postgres, Cloudflare, Supabase**, and any pg-compatible driver. Streaming cursors, typed errors, single-query nested relations. 1 dependency, ~110KB.

```
npm install turbine-orm
```

## Why Turbine?

Turbine is a PostgreSQL-native TypeScript ORM with features no other ORM offers together: **deep typed `with` inference** (`users[0].posts[0].comments[0].author` autocompletes after one `findMany`), **cursor-based streaming** through nested relations, **typed error classes** with PostgreSQL constraint mapping, **pipeline batching** (N queries, 1 round-trip), **middleware**, and a driver-agnostic core that plugs into any pg-compatible pool so it runs on Vercel Edge, Cloudflare Workers, Deno Deploy, and similar environments. 1 runtime dependency (`pg`), ~110KB on npm.

**One round-trip for nested relations.** `db.users.findMany({ with: { posts: { with: { comments: true } } } })` resolves the entire object graph in a single database round-trip, regardless of nesting depth. Prisma 7+ and Drizzle v2 also do single-query nested loads — Turbine's advantage is architectural simplicity: 1 dependency, no code generation DSL, no query plan compiler.

## Benchmarks

Tested against **Prisma 7.6** (adapter-pg, relationJoins preview on) and **Drizzle 0.45** (relational queries) on a **Neon** PostgreSQL database (pooled endpoint, US-East, PostgreSQL 17.8). 100 iterations, 20 warmup, Node v22. Same schema, same data (1K users, 10K posts, 50K comments), same connection pool config.

| Scenario | Turbine | Prisma 7 | Drizzle v2 |
|---|---|---|---|
| findMany — 100 users (flat) | 57.70 ms | 50.22 ms | **49.11 ms** |
| findMany — 50 users + posts (L2) | 53.96 ms | 54.94 ms | **52.42 ms** |
| findMany — 10 users → posts → comments (L3) | **52.43 ms** | 54.00 ms | 53.83 ms |
| findUnique — single user by PK | 47.03 ms | 50.79 ms | **46.93 ms** |
| findUnique — user + posts + comments (L3) | 60.94 ms | 54.62 ms | **52.09 ms** |
| count — all users | 44.97 ms | 47.89 ms | **44.57 ms** |
| atomic increment — `view_count + 1` | **49.01 ms** | 52.10 ms | 52.78 ms |

**Against a real pooled database, all three ORMs are within noise of each other.** Network round-trip to Neon is ~33–40 ms, which swamps whatever per-query CPU overhead any of the three ORMs add on the client. Any claim that one of these ORMs is "2× faster" than another on a production database is almost certainly measured on a local Unix socket where the network floor disappears — that's not what users see in deployed apps.

Two places where the benchmark does show a meaningful difference:

- **Streaming 50K rows.** Turbine's `findManyStream` (server-side `DECLARE CURSOR`) is ~1.5× slower than keyset pagination with Prisma or Drizzle for a drain-all workload (~4.8 s vs ~3.2 s), because cursors pay `BEGIN + DECLARE + CLOSE + COMMIT` overhead on top of the same number of `FETCH` round-trips. Turbine's cursor is still the right tool when `orderBy` isn't on a unique column or when early `break` has to release state deterministically, but it's not faster for "give me every row in order."
- **L3 `findUnique`** showed Turbine ~15 % slower than Drizzle in this run. Small sample, could be variance, but it's not a win.

What Turbine actually gets right isn't speed. It's: **one runtime dependency** (`pg`, ~110 KB), a **single import swap** for edge runtimes (`turbine-orm/serverless`), **typed Postgres errors** with a `readonly isRetryable` const for retry loops, and **inferred `with` result types** — `users[0].posts[0].comments[0].author.name` autocompletes from a single `findMany` with no manual assertion.

> Full analysis with p50/p95/p99 and methodology notes: [`benchmarks/RESULTS.md`](./benchmarks/RESULTS.md).
> Reproduce: `cd benchmarks && npm install && npx prisma generate && DATABASE_URL=... npx tsx bench.ts`

## Quick Start

```bash
# 1. Install
npm install turbine-orm

# 2. Initialize project
npx turbine init --url postgres://user:pass@localhost:5432/mydb

# 3. Generate typed client from your database
npx turbine generate
```

Works with both ESM and CommonJS:

```typescript
// ESM
import { turbine } from './generated/turbine';

// CommonJS
const { turbine } = require('./generated/turbine');
```

This introspects your database and generates a fully-typed client at `./generated/turbine/`.

```typescript
import { turbine } from './generated/turbine';

const db = turbine({ connectionString: process.env.DATABASE_URL });

// Type-safe queries with autocompletion
const users = await db.users.findMany({
  where: { role: 'admin' },
  orderBy: { createdAt: 'desc' },
  limit: 10,
});

await db.disconnect();
```

## Usage Examples

### findMany with nested relations

```typescript
// Single query -- returns users with their posts and each post's comments
const users = await db.users.findMany({
  where: { orgId: 1 },
  with: {
    posts: {
      with: { comments: true },
      orderBy: { createdAt: 'desc' },
      limit: 5,
    },
  },
});

// users[0].posts[0].comments -- fully typed, single round-trip
```

### findUnique

```typescript
const user = await db.users.findUnique({
  where: { id: 42 },
  with: { posts: true },
});
// user.posts is Post[] -- resolved in the same query
```

### create

```typescript
const newUser = await db.users.create({
  data: {
    email: 'alice@example.com',
    name: 'Alice',
    orgId: 1,
  },
});
// Returns the full row with generated id, createdAt, etc.
```

### createMany (batch insert with UNNEST)

```typescript
const users = await db.users.createMany({
  data: [
    { email: 'a@b.com', name: 'A', orgId: 1 },
    { email: 'b@b.com', name: 'B', orgId: 1 },
    { email: 'c@b.com', name: 'C', orgId: 1 },
  ],
});
// Single INSERT with UNNEST -- not 3 separate inserts
```

### update / delete

```typescript
const updated = await db.users.update({
  where: { id: 42 },
  data: { name: 'Alice Updated' },
});

const deleted = await db.users.delete({
  where: { id: 42 },
});
```

### Atomic update operators

For race-free counter updates, pass an operator object instead of a literal. Turbine generates `col = col + $n` style SQL so concurrent updates are safe.

```typescript
// Atomic increment — no read-modify-write race
await db.posts.update({
  where: { id: 1 },
  data: { viewCount: { increment: 1 } },
});

// Other supported operators on numeric columns
await db.posts.update({
  where: { id: 1 },
  data: {
    viewCount:  { increment: 5 },
    likesCount: { decrement: 1 },
    score:      { multiply: 2 },
    rank:       { divide: 2 },
    title:      { set: 'New title' }, // explicit set, equivalent to a literal
  },
});
```

### Transactions

```typescript
await db.$transaction(async (tx) => {
  const user = await tx.users.create({
    data: { email: 'new@example.com', name: 'New', orgId: 1 },
  });
  await tx.posts.create({
    data: { userId: user.id, orgId: 1, title: 'First Post', content: '...' },
  });
});
// Fully typed -- tx.users and tx.posts have the same API as db.users and db.posts
```

### Pipeline (batch queries in one round-trip)

```typescript
const [user, postCount, recentPosts] = await db.pipeline(
  db.users.buildFindUnique({ where: { id: 1 } }),
  db.posts.buildCount({ where: { orgId: 1 } }),
  db.posts.buildFindMany({ where: { userId: 1 }, limit: 5 }),
);
// 3 queries, 1 database round-trip
```

### Raw SQL (tagged template)

```typescript
const stats = await db.raw<{ day: Date; count: number }>`
  SELECT DATE_TRUNC('day', created_at) AS day, COUNT(*)::int AS count
  FROM posts WHERE org_id = ${orgId}
  GROUP BY day ORDER BY day
`;
```

### Case-insensitive search

```typescript
const users = await db.users.findMany({
  where: {
    email: { contains: 'alice', mode: 'insensitive' },
  },
});
// Generates: WHERE email ILIKE '%alice%'
```

### Streaming large result sets

```typescript
// Stream rows using PostgreSQL cursors — constant memory, no matter how many rows
for await (const user of db.users.findManyStream({
  where: { orgId: 1 },
  batchSize: 500,       // internal FETCH batch size (default: 100)
  orderBy: { id: 'asc' },
  with: { posts: true }, // nested relations work too
})) {
  process.stdout.write(`${user.email}\n`);
}
```

Uses `DECLARE CURSOR` under the hood — rows are fetched in batches on a dedicated connection, parsed individually, and yielded via `AsyncGenerator`. Safe to `break` early; the cursor and connection are cleaned up automatically.

### Query timeout

```typescript
const users = await db.users.findMany({
  where: { orgId: 1 },
  timeout: 5000, // 5 second timeout
});
```

### Default limit

```typescript
// Set a default limit for all queries on a model
const db = turbine({
  connectionString: process.env.DATABASE_URL,
  defaultLimit: 100,
});
```

### Middleware

```typescript
// Query timing
db.$use(async (params, next) => {
  const start = Date.now();
  const result = await next(params);
  console.log(`${params.model}.${params.action} took ${Date.now() - start}ms`);
  return result;
});

// Soft-delete filter
db.$use(async (params, next) => {
  if (params.action === 'findMany' || params.action === 'findUnique') {
    params.args.where = { ...params.args.where, deletedAt: null };
  }
  return next(params);
});
```

### Error handling

Turbine throws typed errors you can catch programmatically:

```typescript
import { NotFoundError, ValidationError, TimeoutError } from 'turbine-orm';

try {
  const user = await db.users.findUniqueOrThrow({ where: { id: 999 } });
} catch (err) {
  if (err instanceof NotFoundError) {
    // err.code === 'TURBINE_E001'
    console.log('User not found');
  } else if (err instanceof TimeoutError) {
    // err.code === 'TURBINE_E002'
    console.log('Query timed out');
  } else if (err instanceof ValidationError) {
    // err.code === 'TURBINE_E003'
    console.log('Invalid query:', err.message);
  }
}
```

Error codes: `TURBINE_E001` (NotFound), `TURBINE_E002` (Timeout), `TURBINE_E003` (Validation), `TURBINE_E004` (Connection), `TURBINE_E005` (Relation), `TURBINE_E006` (Migration), `TURBINE_E007` (CircularRelation).

## WHERE Operator Reference

Every operator supported by the `where` clause. Operators compose freely with `AND`, `OR`, `NOT`, and the relation filters `some` / `every` / `none`.

### Equality

| Operator | Description | Example |
|---|---|---|
| literal | Implicit equality | `where: { email: 'a@b.com' }` |
| `equals` | Explicit equality | `where: { email: { equals: 'a@b.com' } }` |
| `not` | Inequality (or `not: null` for `IS NOT NULL`) | `where: { role: { not: 'admin' } }` |

### Sets

| Operator | Description | Example |
|---|---|---|
| `in` | Match any value in the array | `where: { id: { in: [1, 2, 3] } }` |
| `notIn` | Match none of the values in the array | `where: { role: { notIn: ['banned', 'spam'] } }` |

### Comparison

| Operator | Description | Example |
|---|---|---|
| `gt` | Greater than | `where: { score: { gt: 100 } }` |
| `gte` | Greater than or equal | `where: { score: { gte: 100 } }` |
| `lt` | Less than | `where: { score: { lt: 100 } }` |
| `lte` | Less than or equal | `where: { score: { lte: 100 } }` |

### String

| Operator | Description | Example |
|---|---|---|
| `contains` | Substring match (`LIKE %v%`) | `where: { title: { contains: 'sql' } }` |
| `startsWith` | Prefix match (`LIKE v%`) | `where: { email: { startsWith: 'admin@' } }` |
| `endsWith` | Suffix match (`LIKE %v`) | `where: { email: { endsWith: '@acme.com' } }` |
| `mode: 'insensitive'` | Switch any string operator to `ILIKE` | `where: { title: { contains: 'SQL', mode: 'insensitive' } }` |

LIKE wildcards in user input are escaped automatically — `%`, `_`, and `\` are treated as literals.

### Relation filters

Filter parent rows by predicates against their related child rows. Available on `hasMany` and `hasOne` relations.

| Operator | Description | Example |
|---|---|---|
| `some` | At least one related row matches | `where: { posts: { some: { published: true } } }` |
| `every` | Every related row matches | `where: { posts: { every: { published: true } } }` |
| `none` | No related row matches | `where: { posts: { none: { published: false } } }` |

### Array columns

Operators for Postgres array columns (`text[]`, `int[]`, etc.).

| Operator | Description | Example |
|---|---|---|
| `has` | Array contains the given element | `where: { tags: { has: 'sql' } }` |
| `hasEvery` | Array contains every element in the list | `where: { tags: { hasEvery: ['sql', 'postgres'] } }` |
| `hasSome` | Array contains at least one element from the list | `where: { tags: { hasSome: ['sql', 'mysql'] } }` |

### Combinators

| Operator | Description | Example |
|---|---|---|
| `AND` | All sub-clauses must match | `where: { AND: [{ orgId: 1 }, { role: 'admin' }] }` |
| `OR` | Any sub-clause matches | `where: { OR: [{ role: 'admin' }, { role: 'owner' }] }` |
| `NOT` | Negate a sub-clause | `where: { NOT: { role: 'banned' } }` |

## CLI

```
npx turbine <command> [options]

Commands:
  init                  Initialize a Turbine project (creates config, dirs, templates)
  generate | pull       Introspect database and generate TypeScript types + client
  push                  Apply schema-builder definitions to database
  migrate create <name>        Create a new SQL migration file
  migrate create <name> --auto Auto-generate from schema diff
  migrate up                   Apply pending migrations
  migrate down                 Rollback last migration
  migrate status               Show applied/pending migrations
  seed                         Run seed file
  status                       Show database schema summary

Options:
  --url, -u <url>       Postgres connection string
  --out, -o <dir>       Output directory (default: ./generated/turbine)
  --schema, -s <name>   Postgres schema (default: public)
  --auto                Auto-generate migration from schema diff
  --dry-run             Show SQL without executing
  --verbose, -v         Detailed output
```

### Schema-first workflow

Define your schema in TypeScript and push it to the database:

```typescript
// turbine/schema.ts
import { defineSchema } from 'turbine-orm';

export default defineSchema({
  users: {
    id:        { type: 'serial', primaryKey: true },
    email:     { type: 'text', unique: true, notNull: true },
    name:      { type: 'text', notNull: true },
    orgId:     { type: 'bigint', notNull: true, references: 'organizations.id' },
    createdAt: { type: 'timestamp', default: 'now()' },
  },
});
```

```bash
npx turbine push --dry-run   # Preview SQL
npx turbine push             # Apply to database
npx turbine generate         # Regenerate typed client
```

### Migration workflow

```bash
# Create a blank migration (write SQL manually)
npx turbine migrate create add_users_table

# Auto-generate migration from schema diff (compares defineSchema() vs live DB)
npx turbine migrate create add_email_index --auto
# -> Generates UP (ALTER/CREATE) and DOWN (reverse) SQL automatically

# Apply all pending migrations
npx turbine migrate up

# Rollback the last applied migration
npx turbine migrate down

# Check migration status (applied vs pending)
npx turbine migrate status
```

## Serverless / Edge

Turbine's core is driver-agnostic: pass any pg-compatible pool to `TurbineConfig.pool` (or use the `turbineHttp()` factory) and Turbine runs on **Vercel Edge**, **Cloudflare Workers**, **Deno Deploy**, **Netlify Edge**, or any other environment where a direct TCP connection is unavailable. No new dependencies — install whichever driver you already use.

### Neon Serverless (HTTP / WebSocket)

```ts
// app/api/users/route.ts
import { Pool } from '@neondatabase/serverless';
import { turbineHttp } from 'turbine-orm/serverless';
import { schema } from '@/generated/turbine/metadata';

export const runtime = 'edge';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = turbineHttp(pool, schema);

export async function GET() {
  const users = await db.table('users').findMany({
    with: { posts: { with: { comments: true } } },
    limit: 10,
  });
  return Response.json(users);
}
```

### Vercel Postgres

```ts
import { createPool } from '@vercel/postgres';
import { turbineHttp } from 'turbine-orm/serverless';
import { schema } from './generated/turbine/metadata.js';

const pool = createPool({ connectionString: process.env.POSTGRES_URL });
const db = turbineHttp(pool, schema);
```

### Supabase (direct Postgres — no HTTP proxy needed)

```ts
import { TurbineClient } from 'turbine-orm';
import { schema } from './generated/turbine/metadata.js';

const db = new TurbineClient({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
}, schema);
```

### Cloudflare Workers

```ts
import { Pool } from '@neondatabase/serverless';
import { turbineHttp } from 'turbine-orm/serverless';
import { schema } from './generated/turbine/metadata';

export default {
  async fetch(req: Request, env: Env) {
    const pool = new Pool({ connectionString: env.DATABASE_URL });
    const db = turbineHttp(pool, schema);
    const users = await db.table('users').findMany({ limit: 10 });
    return Response.json(users);
  },
};
```

### Limitations on HTTP drivers

- **Streaming cursors** (`findManyStream`) require `DECLARE CURSOR`, which most HTTP drivers don't support. Use `findMany` with `limit` + pagination instead.
- **LISTEN/NOTIFY** is not available over HTTP.
- Transactions work but hold an HTTP connection for their duration — keep them short.

When Turbine receives an external pool, `db.disconnect()` is a no-op: the caller owns the pool's lifecycle.

## Configuration

Create `turbine.config.ts` in your project root (or run `npx turbine init`):

```typescript
import type { TurbineCliConfig } from 'turbine-orm/cli';

const config: TurbineCliConfig = {
  url: process.env.DATABASE_URL,
  out: './generated/turbine',
  schema: 'public',
  migrationsDir: './turbine/migrations',
  seedFile: './turbine/seed.ts',
  schemaFile: './turbine/schema.ts',
};

export default config;
```

Priority order: CLI flags > environment variables (`DATABASE_URL`) > config file > defaults.

## How It Works

Turbine resolves the entire object graph in a single database round-trip, regardless of nesting depth. The `with` clause is fully type-inferred end-to-end — `users[0].posts[0].comments[0].author.name` autocompletes from a single `findMany` call, with no manual type assertions.

Prisma 7+ and Drizzle v2 also do single-query nested loads. Turbine's advantage isn't query latency (see [Benchmarks](#benchmarks) — all three are within noise over a real pooled database); it's architectural simplicity. One runtime dependency (`pg`), no DSL compiler, no driver adapter shim for edge, and deep `with` type inference without verbose helper types.

## Type Mapping

Turbine maps Postgres types to TypeScript:

| Postgres | TypeScript | Notes |
|---|---|---|
| `int2`, `int4`, `float4`, `float8` | `number` | Standard numeric types |
| `int8` / `bigint` | `number` | Values > `Number.MAX_SAFE_INTEGER` (2^53 - 1) are returned as `string` at runtime to avoid precision loss. This affects < 0.01% of use cases (auto-increment IDs, counts, etc. are all safe). |
| `numeric`, `money` | `string` | Arbitrary precision — kept as string to avoid JS float issues |
| `text`, `varchar`, `uuid`, `citext` | `string` | |
| `timestamptz`, `timestamp`, `date` | `Date` | |
| `boolean` | `boolean` | |
| `json`, `jsonb` | `unknown` | |
| `bytea` | `Buffer` | |
| Array types | `T[]` | e.g. `_text` → `string[]` |

## Comparison

| | **Turbine** | **Prisma** | **Drizzle** | **Kysely** |
|---|---|---|---|---|
| **Nested relations** | 1 query, deep type inference | 1 query (since v5.8), shallow inference | 1 query, requires `relations()` re-declaration | Manual (`jsonArrayFrom`) |
| **API style** | `findMany`, `with` | `findMany`, `include` | SQL-like + relational | SQL builder |
| **Schema** | TypeScript | Custom DSL (`.prisma`) | TypeScript | Manual interfaces |
| **Runtime deps** | 1 (`pg`) | `@prisma/client` + adapter | 0 | 0 |
| **Multi-DB** | PostgreSQL only | PG, MySQL, SQLite, MSSQL | PG, MySQL, SQLite | PG, MySQL, SQLite |
| **Code generation** | `turbine generate` | `prisma generate` | Not needed | Not needed |

All three ORMs now do single-query nested loads. Over a real pooled database (Neon, US-East) all three land inside the same ~3 ms window for nested reads — the network round-trip swamps per-query ORM overhead. Turbine's differentiators are architectural, not latency: one runtime dependency, one import swap for edge, typed errors with `isRetryable`, and deep `with` type inference without helper types. See [Benchmarks](#benchmarks) and [`benchmarks/RESULTS.md`](./benchmarks/RESULTS.md) for the full breakdown.

## Limitations

Turbine is focused and opinionated. Here's what it doesn't do:

- **PostgreSQL only.** No MySQL, SQLite, or MSSQL. By design — going deep on one database enables the performance advantage and the edge-runtime story.
- **No full-text search operators.** TSVECTOR/TSQUERY are not exposed in the query builder. Use `db.raw` for full-text queries.
- **Large nested result sets.** Nested results are materialized server-side in PostgreSQL memory. For relations with 10K+ rows, always use `limit` in your `with` clause — or stream the parents with `findManyStream` and resolve children per-row.
- **No admin UI.** Turbine Studio is planned but not yet available.

## Examples

**Feature demos**

- **[Thread Machine](./examples/thread-machine/)** — HN clone rendered from a single `findMany`. 4-level object graph (stories → comments → replies → author), every property autocompletes through the chain
- **[Streaming CSV](./examples/streaming-csv/)** — Export 100K orders + line items to CSV with constant memory. PostgreSQL cursors, live heap meter, nested `with` inside `findManyStream`
- **[Clickstorm](./examples/clickstorm/)** — Side-by-side atomic-increment vs read-modify-write load test. 10K concurrent clicks. The atomic path wins every time

**Runtime targets**

- **[Next.js](./examples/nextjs/)** — Server-rendered app with nested relations, streaming, and live code demos
- **[Neon Edge](./examples/neon-edge/)** — Vercel Edge route handler talking to Neon over HTTP via `@neondatabase/serverless`
- **[Vercel Postgres](./examples/vercel-postgres/)** — Next.js app router route handler on `@vercel/postgres`
- **[Cloudflare Worker](./examples/cloudflare-worker/)** — Worker `fetch` handler with `pg` over Cloudflare Hyperdrive
- **[Supabase](./examples/supabase/)** — Standalone script over the standard `pg` driver against Supabase

## Guides

- **[Migrating from Prisma](./docs/migrate-from-prisma.md)** — API mapping table, side-by-side `findMany`, and notes on the differences

## Requirements

- Node.js >= 18.0.0
- PostgreSQL >= 14
- Works with both ESM (`import`) and CommonJS (`require`)

## License

MIT
