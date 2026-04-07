# turbine-orm

Postgres-native TypeScript ORM — runs on **Neon, Vercel Postgres, Cloudflare, Supabase**, and any pg-compatible driver. Streaming cursors, typed errors, single-query nested relations. 1 dependency, ~110KB.

```
npm install turbine-orm
```

## Why Turbine?

Turbine is a PostgreSQL-native TypeScript ORM with features no other ORM offers together: **cursor-based streaming** through nested relations, **typed error classes** with PostgreSQL constraint mapping, **pipeline batching** (N queries, 1 round-trip), **middleware**, and a driver-agnostic core that plugs into any pg-compatible pool so it runs on Vercel Edge, Cloudflare Workers, Deno Deploy, and similar environments. It resolves nested relations in a single SQL query using `json_agg` — an approach now shared by Prisma 7+ and Drizzle v2, but Turbine does it with 1 runtime dependency (`pg`) and ~110KB on npm.

**One query for nested relations.** When you write `db.users.findMany({ with: { posts: { with: { comments: true } } } })`, Turbine generates a single SQL statement using correlated subqueries with `json_agg`. Modern ORMs like Prisma 7+ and Drizzle v2 use similar single-query approaches (LATERAL JOINs). Turbine's advantage is architectural simplicity: 1 dependency, no code generation DSL, and PostgreSQL-native depth.

## Benchmarks

Tested against **Prisma 7.6** (adapter-pg, relationJoins) and **Drizzle 0.45** (relational queries) on the same PostgreSQL database. 200 iterations, 20 warmup, Node v22.

| Scenario | Turbine | Prisma 7 | Drizzle v2 |
|---|---|---|---|
| **findMany — 100 rows (flat)** | **0.39 ms** | 0.58 ms | 0.44 ms |
| **findMany — L2 nested (users + posts)** | **1.29 ms** | 1.84 ms | 1.30 ms |
| **findMany — L3 nested (users → posts → comments)** | **0.50 ms** | 0.91 ms | 0.69 ms |
| **findUnique by PK** | **0.08 ms** | 0.13 ms | 0.14 ms |
| **findUnique — L3 nested** | **0.18 ms** | 0.32 ms | 0.34 ms |
| **count** | **0.06 ms** | 0.10 ms | 0.08 ms |

| Scenario | Turbine | Prisma 7 | Drizzle v2 |
|---|---|---|---|
| findMany — flat | **1.00x** | 1.51x | 1.15x |
| findMany — L2 nested | **1.00x** | 1.43x | 1.01x |
| findMany — L3 nested | **1.00x** | 1.81x | 1.38x |
| findUnique by PK | **1.00x** | 1.67x | 1.69x |
| findUnique — L3 nested | **1.00x** | 1.81x | 1.93x |
| count | **1.00x** | 1.70x | 1.38x |

Turbine is fastest in every scenario. The advantage is largest on deep nesting (1.8x vs Prisma, up to 1.9x vs Drizzle) and single-record lookups (1.7x). All three ORMs now use single-query approaches for nested relations — Turbine's advantage comes from lower per-query overhead (minimal JS object allocation, no query plan compilation layer, direct pg driver access).

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

Turbine generates a single SQL query using Postgres `json_agg` + subqueries to fetch nested relations:

```sql
-- db.users.findMany({ where: { orgId: 1 }, with: { posts: { with: { comments: true } } } })
SELECT u.*,
  (SELECT COALESCE(json_agg(sub), '[]'::json) FROM (
    SELECT p.*,
      (SELECT COALESCE(json_agg(sub2), '[]'::json) FROM (
        SELECT c.* FROM comments c WHERE c.post_id = p.id
      ) sub2) AS comments
    FROM posts p WHERE p.user_id = u.id
  ) sub) AS posts
FROM users u WHERE u.org_id = 1
```

This resolves the entire 3-level object graph in one database round-trip. Prisma 7+ and Drizzle v2 also use single-query approaches (LATERAL JOINs), but Turbine's correlated subquery strategy has lower per-query overhead — see [Benchmarks](#benchmarks).

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
| **Nested relations** | 1 query (`json_agg`) | 1 query (LATERAL JOIN + json_agg, since v5.8) | 1 query (LATERAL JOINs) | Manual (`jsonArrayFrom`) |
| **API style** | `findMany`, `with` | `findMany`, `include` | SQL-like + relational | SQL builder |
| **Schema** | TypeScript | Custom DSL (`.prisma`) | TypeScript | Manual interfaces |
| **Runtime deps** | 1 (`pg`) | `@prisma/client` + adapter | 0 | 0 |
| **Multi-DB** | PostgreSQL only | PG, MySQL, SQLite, MSSQL | PG, MySQL, SQLite | PG, MySQL, SQLite |
| **Code generation** | `turbine generate` | `prisma generate` | Not needed | Not needed |

All three ORMs now use single-query approaches for nested relations. Turbine uses correlated subqueries with `json_agg`, Prisma 7 uses LATERAL JOIN + `json_agg`, and Drizzle uses LATERAL JOINs. Turbine is 1.4–1.9x faster due to lower per-query overhead — minimal JS object allocation, no query plan compilation layer, and direct pg driver access. See [Benchmarks](#benchmarks) for full results.

## Limitations

Turbine is focused and opinionated. Here's what it doesn't do:

- **PostgreSQL only.** No MySQL, SQLite, or MSSQL. This is by design — the `json_agg` approach is PostgreSQL-specific, and going deep on one database enables the performance advantage.
- **No incremental updates.** Prisma's `{ count: { increment: 1 } }` syntax is not yet supported. Use raw SQL for atomic increments.
- **No full-text search operators.** TSVECTOR/TSQUERY are not exposed in the query builder. Use `db.raw` for full-text queries.
- **Large nested result sets.** `json_agg` builds the entire JSON array in PostgreSQL memory. For relations with 10K+ rows, always use `limit` in your `with` clause to cap the aggregation size.
- **No admin UI.** Turbine Studio is planned but not yet available.

## Examples

- **[Next.js](./examples/nextjs/)** — Server-rendered app with nested relations, streaming, and live code demos

## Requirements

- Node.js >= 18.0.0
- PostgreSQL >= 14
- Works with both ESM (`import`) and CommonJS (`require`)

## License

MIT
