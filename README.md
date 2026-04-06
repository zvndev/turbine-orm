# turbine-orm

Postgres-native TypeScript ORM. Single-query nested relations via `json_agg`, Prisma-inspired API, 1 dependency, 70KB.

```
npm install turbine-orm
```

## Why Turbine?

Turbine uses Postgres `json_agg` to resolve nested relations in **a single SQL query** — no N+1, no WASM binary, no multi-database abstraction tax. One runtime dependency (`pg`), 70KB on npm.

**One query for nested relations.** When you write `db.users.findMany({ with: { posts: { with: { comments: true } } } })`, Turbine generates a single SQL statement using correlated subqueries with `json_agg`. Modern ORMs like Prisma 7+ and Drizzle v2 use similar single-query approaches (LATERAL JOINs). Turbine's advantage is architectural simplicity: 1 dependency, no code generation DSL, and PostgreSQL-native depth.

## Benchmarks

Production results from Vercel Serverless hitting Neon Postgres (20 iterations, warm):

| Scenario | Turbine | Drizzle | Prisma |
|---|---|---|---|
| **Nested L3 (median)** | **5.3ms** | 6.5ms | 7.4ms |
| Nested L3 (min) | **4.4ms** | 5.7ms | 6.0ms |
| Nested L2 | **6.5ms** | 9.1ms | 10.2ms |
| Simple select | 5.6ms | 7.1ms | 3.9ms |

Local Docker results (50K iterations, HDR histograms):

| Scenario | Turbine | Drizzle | Prisma |
|---|---|---|---|
| **L2 nested p50** | **201us** | 523us | 835us |
| **L2 nested RPS (c=50)** | **24,041** | 6,360 | 3,784 |
| L2 nested memory | 109MB | 117MB | 233MB |

Turbine is 2.6x faster than Drizzle and 4.2x faster than Prisma on nested queries at p50. Throughput is 3.8x higher than Drizzle and 6.3x higher than Prisma.

> **Note:** These benchmarks were run against Prisma 5.x (which used separate queries per nesting level by default) and Drizzle v1. Prisma 7+ now uses LATERAL JOIN + `json_agg` by default, and Drizzle v2 uses a similar single-query approach. We plan to publish updated benchmarks against the latest versions. The architectural advantage (single SQL query with correlated subqueries) remains, but the gap may be smaller against modern versions.

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
  migrate create <name> Create a new SQL migration file
  migrate up            Apply pending migrations
  migrate down          Rollback last migration
  migrate status        Show applied/pending migrations
  seed                  Run seed file
  status                Show database schema summary

Options:
  --url, -u <url>       Postgres connection string
  --out, -o <dir>       Output directory (default: ./generated/turbine)
  --schema, -s <name>   Postgres schema (default: public)
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
# Create a new migration
npx turbine migrate create add_users_table
# -> Creates turbine/migrations/001_add_users_table.sql with UP/DOWN sections

# Apply all pending migrations
npx turbine migrate up

# Rollback the last applied migration
npx turbine migrate down

# Check migration status (applied vs pending)
npx turbine migrate status
```

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

This resolves the entire 3-level object graph in one database round-trip. Prisma would send 3 queries. The performance difference scales with nesting depth and network latency.

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
| **Runtime deps** | 1 (`pg`) | WASM compiler + driver | 0 | 0 |
| **Multi-DB** | PostgreSQL only | PG, MySQL, SQLite, MSSQL | PG, MySQL, SQLite | PG, MySQL, SQLite |
| **Code generation** | `turbine generate` | `prisma generate` | Not needed | Not needed |

Turbine is fastest on nested queries because it generates a single SQL statement using PostgreSQL-native `json_agg`. Prisma 7+ uses LATERAL JOIN + json_agg by default (similar single-query approach). Drizzle achieves single-query via LATERAL JOINs. Turbine uses correlated subqueries — a different SQL strategy with similar performance characteristics.

## Limitations

Turbine is focused and opinionated. Here's what it doesn't do:

- **PostgreSQL only.** No MySQL, SQLite, or MSSQL. This is by design — the `json_agg` approach is PostgreSQL-specific, and going deep on one database enables the performance advantage.
- **No incremental updates.** Prisma's `{ count: { increment: 1 } }` syntax is not yet supported. Use raw SQL for atomic increments.
- **No full-text search operators.** TSVECTOR/TSQUERY are not exposed in the query builder. Use `db.raw` for full-text queries.
- **Large nested result sets.** `json_agg` builds the entire JSON array in PostgreSQL memory. For relations with 10K+ rows, always use `limit` in your `with` clause to cap the aggregation size.
- **No admin UI.** Turbine Studio is planned but not yet available.

## Requirements

- Node.js >= 18.0.0
- PostgreSQL >= 14
- Works with both ESM (`import`) and CommonJS (`require`)

## License

MIT
