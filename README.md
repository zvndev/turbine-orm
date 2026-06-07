# turbine-orm

One dependency. No WASM engine. The Postgres ORM that ships light and locks tight.

```
npm install turbine-orm
```

**Full docs: [turbineorm.dev](https://turbineorm.dev)** — [Quick Start](https://turbineorm.dev/quickstart) · [API Reference](https://turbineorm.dev/queries) · [Relations](https://turbineorm.dev/relations) · [Transactions & Pipelines](https://turbineorm.dev/transactions) · [Serverless & Edge](https://turbineorm.dev/serverless) · [Typed Errors](https://turbineorm.dev/errors) · [Benchmarks](https://turbineorm.dev/benchmarks)

## Why Turbine?

Prisma ships a 1.6 MB WASM query engine. Drizzle ships zero runtime but no Studio, no typed errors, no migration checksums. Turbine ships **one dependency (`pg`) and no engine binary**, and bundles six things no other TS ORM has together:

1. **One runtime dependency (`pg`).** No engine binary, no WASM adapter, no adapter packages to keep in lockstep. The main entry bundles to ~30 KB gzipped (~109 KB minified); the edge entry to ~21 KB gzipped. Prisma's WASM query engine alone is 1.6 MB.
2. **Built-in read-only Studio.** `npx turbine studio` spins up a loopback-bound web UI with 192-bit auth tokens, `BEGIN READ ONLY` transactions, and a statement-stacking guard. The only TS ORM Studio that physically cannot mutate your database. DBA-approvable.
3. **PII-safe error messages.** Turbine errors show WHERE keys, not values. A `UniqueConstraintError` says which column violated the constraint — never the actual user data. Safe to log, safe to surface to monitoring, no scrubbing needed.
4. **SQL-first migrations with drift detection.** Write real SQL. SHA-256 checksums catch modified migration files. `pg_try_advisory_lock()` prevents concurrent runs. Each migration in its own transaction. No shadow database, no magic DSL.
5. **Edge-native — one import swap.** `turbineHttp(pool, schema)` — same API on Neon, Vercel Postgres, Cloudflare Hyperdrive, Supabase. No WASM bundle, no adapter package, no separate serverless build.
6. **Pipeline batching via wire protocol.** Real Parse/Bind/Execute pipeline — not queries wrapped in a transaction. N independent queries in one round-trip.

Every ORM claims single-query nested loads now (Prisma 7 and Drizzle v2 both use json_agg). Turbine does too — see [How It Works](#how-it-works). The differentiator isn't the query strategy; it's the one-dependency, no-WASM footprint, the read-only Studio, and the error messages that never leak user data.

## Benchmarks

Tested against **Prisma 7.6** (adapter-pg, relationJoins preview on) and **Drizzle 0.45** (relational queries) on a **Neon** PostgreSQL database (pooled endpoint, US-East, PostgreSQL 17.8). 100 iterations, 20 warmup, Node v22. Same schema, same data (1K users, 10K posts, 50K comments), same connection pool config. _Measured April 2026 on turbine-orm 0.7.1; the core read path these scenarios exercise is unchanged through 0.17.0 — see [`benchmarks/RESULTS.md`](./benchmarks/RESULTS.md) to reproduce._

| Scenario | Turbine | Prisma 7 | Drizzle v2 |
|---|---|---|---|
| findMany — 100 users (flat) | **51.97 ms** | 52.90 ms | 53.51 ms |
| findMany — 50 users + posts (L2) | **55.84 ms** | 56.10 ms | 88.80 ms |
| findMany — 10 users → posts → comments (L3) | 52.77 ms | 59.35 ms | **52.38 ms** |
| findUnique — single user by PK | **47.66 ms** | 52.15 ms | 47.78 ms |
| findUnique — user + posts + comments (L3) | **51.71 ms** | 54.42 ms | 52.47 ms |
| count — all users | **44.57 ms** | 47.54 ms | 46.75 ms |
| stream — iterate 50K rows (batch 1000) | 3,207 ms | **3,099 ms** | 4,620 ms |
| atomic increment — `view_count + 1` | 49.76 ms | 49.09 ms | **46.25 ms** |
| pipeline — 5-query batch | 318 ms | 327 ms | **316 ms** |

**Against a real pooled database, most single-query scenarios are within noise** — network round-trip to Neon is ~33–40 ms, which swamps per-query CPU overhead. But a few results stand out:

- **L2 nested reads.** Turbine and Prisma are neck-and-neck (~56 ms), while Drizzle is **1.59× slower** (89 ms) on the 50-user + posts scenario. Turbine's `json_agg` approach and SQL template caching pay off here.
- **Streaming 50K rows.** Turbine's optimized streaming (speculative first fetch + batch size 1000) matches Prisma at ~3.1–3.2 s. Drizzle's keyset pagination is 1.49× slower at 4.6 s. Turbine's cursor still gives you correctness on any `orderBy` and clean early-`break` semantics.
- **Pipeline batching** puts 5 independent queries through a single round-trip using the Postgres extended-query pipeline protocol — all three ORMs are tied here since each runs 5 queries sequentially in a transaction.

Performance is at parity with Prisma and Drizzle — the real reasons to choose Turbine are elsewhere: **one dependency and no WASM engine** (vs Prisma's 1.6 MB WASM query engine), the **only read-only Studio** in the TS ORM ecosystem, **PII-safe error messages** that never leak user data, and **SQL-first migrations** with SHA-256 drift detection. Deep type inference through `with` clauses works end-to-end: write `db.users.findMany({ with: { posts: { with: { comments: true } } } })` and `users[0].posts[0].comments[0].body` autocompletes — no manual assertion, no helper annotation.

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
  batchSize: 500,       // internal FETCH batch size (default: 1000)
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

Error codes: `TURBINE_E001` (NotFound), `TURBINE_E002` (Timeout), `TURBINE_E003` (Validation), `TURBINE_E004` (Connection), `TURBINE_E005` (Relation), `TURBINE_E006` (Migration), `TURBINE_E007` (CircularRelation), `TURBINE_E008` (UniqueConstraint), `TURBINE_E009` (ForeignKey), `TURBINE_E010` (NotNullViolation), `TURBINE_E011` (CheckConstraint), `TURBINE_E012` (Deadlock), `TURBINE_E013` (SerializationFailure), `TURBINE_E014` (Pipeline), `TURBINE_E015` (OptimisticLock), `TURBINE_E016` (ExclusionConstraint).

Full reference with `wrapPgError()` translation, retry patterns for `DeadlockError` / `SerializationFailureError`, and safe vs verbose message modes: **[turbineorm.dev/errors](https://turbineorm.dev/errors)**.

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
  studio                       Launch local read-only Studio web UI

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

## Studio

The only Postgres ORM with a Studio your DBA will approve. `turbine studio` launches a local, read-only web UI for exploring your database — no mutations, no writes, no way around the transaction guard.

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/mydb npx turbine studio
# With flags
npx turbine studio --port 5173 --host 127.0.0.1 --no-open
```

**Features**

- **Data / Schema / SQL / Builder tabs.** Browse rows, inspect tables and relations, run ad-hoc `SELECT`s, or compose queries visually with a live TypeScript preview.
- **Saved queries.** Named SQL snippets persisted to `.turbine/studio-queries.json` — share them across runs without committing them.
- **Cmd+K command palette.** Jump to any table, tab, or saved query in one keystroke.
- **Full-text search across rows.** The Data tab supports substring search across every text column of the current table.
- **Visual query composer.** The Builder tab lets you click together `where` / `orderBy` / `with` / `limit` clauses and renders the matching `db.table.findMany(...)` TypeScript in real time — copy it into your codebase.

**Security posture (read-only by design)**

- **Loopback by default** (`127.0.0.1`) with a loud warning if you bind to a non-loopback address.
- **Per-process auth token** — 24 random bytes of hex, stored in a `SameSite=Strict` `HttpOnly` cookie.
- **Every query runs inside `BEGIN READ ONLY` + `SET LOCAL statement_timeout = '30s'`.** Writes are physically impossible at the transaction level.
- **SELECT/WITH-only SQL parser** strips comments and rejects non-trailing semicolons, blocking statement-stacking attacks.
- **Security headers on every response** — `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.

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

Turbine resolves nested relations the same way Prisma 7 and Drizzle v2 do: correlated subqueries with `json_agg` + `json_build_object`, evaluated by PostgreSQL in a single round-trip. No N+1, no client-side stitching, no separate queries per relation. The `with` clause is fully type-inferred end-to-end — write `db.users.findMany({ with: { posts: { with: { comments: { with: { author: true } } } } } })` and `users[0].posts[0].comments[0].author.name` autocompletes with zero manual annotation.

The query strategy is table stakes now. What isn't table stakes: the one-dependency, no-WASM footprint, the read-only Studio your DBA will approve, the error messages that never leak PII, and the SQL-first migrations with SHA-256 drift detection. See [Why Turbine?](#why-turbine) for the full breakdown.

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
| **Engine / runtime** | No engine binary (`pg` only) | Client + 1.6 MB WASM engine | No engine | No engine |
| **Runtime deps** | 1 (`pg`) | `@prisma/client` + adapter | 0 | 0 |
| **Main bundle (gzip)** | ~30 KB | dominated by 1.6 MB WASM | ~7 KB core | small |
| **Studio** | Read-only, 192-bit auth | Full CRUD, cloud-hosted | Paid tier | None |
| **Error PII safety** | Keys only by default | Values in messages | Raw pg errors | Raw pg errors |
| **Migrations** | SQL-first, SHA-256 checksums | DSL-generated, shadow DB | SQL or Drizzle Kit | None |
| **Edge runtime** | One import swap, ~21 KB gzip | 1.6 MB WASM adapter | Native | Native |
| **Pipeline batching** | Parse/Bind/Execute protocol | Sequential in txn | Sequential | Manual |
| **Typed errors** | `isRetryable` discriminant | Error codes only | None | None |
| **Nested relations** | 1 query, deep type inference | 1 query, shallow inference | 1 query, `relations()` re-declaration | Manual (`jsonArrayFrom`) |
| **Multi-DB** | PostgreSQL only | PG, MySQL, SQLite, MSSQL | PG, MySQL, SQLite | PG, MySQL, SQLite |

All three ORMs now do single-query nested loads — that's table stakes. Turbine's real differentiators: no engine binary or WASM — just one dependency (`pg`), vs Prisma's 1.6 MB WASM query engine; the only read-only Studio in the ecosystem; error messages that never leak PII; and SQL-first migrations with SHA-256 drift detection. See [Benchmarks](#benchmarks) for performance numbers — most scenarios are within noise over a real pooled database.

## Limitations

Turbine is focused and opinionated. Here's what it doesn't do:

- **PostgreSQL only.** No MySQL, SQLite, or MSSQL. By design — going deep on one database enables the performance advantage and the edge-runtime story.
- **Full-text search** is available via a `search` filter — `where: { title: { search: 'hello & world', config: 'english' } }` compiles to a parameterized `to_tsvector(...) @@ to_tsquery(...)`. For advanced ranking (`ts_rank`, weighted vectors) use `db.raw`.
- **Large nested result sets.** Nested results are materialized server-side in PostgreSQL memory. For relations with 10K+ rows, always use `limit` in your `with` clause — or stream the parents with `findManyStream` and resolve children per-row.

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

- **[Quick Start](https://turbineorm.dev/quickstart)** — zero-to-first-query in five minutes
- **[API Reference](https://turbineorm.dev/queries)** — every `findMany` / `findUnique` / `create` / `update` / `delete` option, the full operator table, and `pipeline()` semantics
- **[Relations](https://turbineorm.dev/relations)** — deep `with` clause, nested options, relation filters (`some` / `every` / `none`), payload-size guidance
- **[Transactions & Pipelines](https://turbineorm.dev/transactions)** — isolation levels, nested SAVEPOINTs, retry loops for `DeadlockError` and `SerializationFailureError`
- **[Schema & Migrations](https://turbineorm.dev/schema)** — `defineSchema()`, auto-diff migrations, checksum validation
- **[Serverless & Edge](https://turbineorm.dev/serverless)** — Neon, Vercel Postgres, Cloudflare Hyperdrive, Supabase walkthroughs
- **[CLI](https://turbineorm.dev/cli)** — every command, flag, and config option
- **[Typed Errors](https://turbineorm.dev/errors)** — error code reference, `wrapPgError()` translation, retry patterns
- **[Migrating from Prisma](https://turbineorm.dev/migrate-from-prisma)** — API mapping table, side-by-side `findMany`, and notes on the differences

## Requirements

- Node.js >= 18.0.0
- PostgreSQL >= 14
- Works with both ESM (`import`) and CommonJS (`require`)

## License

MIT
