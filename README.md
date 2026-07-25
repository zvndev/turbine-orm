# turbine-orm

**The Postgres ORM that assumes your database has real data in it.**

Most query layers are designed for the shape of a laptop database: empty, disposable, nobody's. Turbine is designed for the same schema six months later, when it is holding customer records. The database UI you point at it is read-only until you say otherwise. The columns you tagged as personal data stay out of query results, out of logs, and out of aggregates. The operations that can lose data make you say so out loud before they run.

```
npm install turbine-orm
```

**Full docs: [turbineorm.dev](https://turbineorm.dev)** — [Quick Start](https://turbineorm.dev/quickstart) · [API Reference](https://turbineorm.dev/queries) · [Relations](https://turbineorm.dev/relations) · [Transactions & Pipelines](https://turbineorm.dev/transactions) · [Serverless & Edge](https://turbineorm.dev/serverless) · [Typed Errors](https://turbineorm.dev/errors) · [Benchmarks](https://turbineorm.dev/benchmarks)

## Why Turbine?

First, what is **not** a reason. Resolving a nested `with` clause in one statement is table stakes in 2026: Drizzle has compiled relational queries to `LEFT JOIN LATERAL` plus JSON aggregation since 0.28, Prisma does the same under its `relationJoins` preview flag, and Kysely ships `jsonArrayFrom` / `jsonObjectFrom` helpers for it. Turbine does it too, it does it well, and it is documented under [How It Works](#how-it-works) as a correctness detail rather than a headline.

The reason to reach for Turbine is that every layer between you and a production database is built on one assumption: **the rows are real**. That plays out in five concrete places.

1. **The database UI is read-only, and writes are a per-launch decision.** `npx turbine studio` binds loopback, authenticates with a 192-bit per-process token, and runs every read inside `BEGIN READ ONLY`. In the default mode the write endpoints do not exist in the router at all (they 404), so there is nothing to bypass. `--write` opts a single launch in to edits, each addressed by its full primary key rather than a predicate, compiled by the same validated builder your app uses. There is no raw-SQL surface at all since v0.19.
2. **PII is a schema contract, enforced in the SQL.** Tag a column `pii: true` and it is excluded from every default projection on every engine: top-level rows, `with` subqueries, batched loaders, write returns, and the Studio UI. It is also **refused** as a `groupBy` key and as a `_min` / `_max` target, because both hand back a stored cell. `includePii: true` unlocks it explicitly per read. A schema with no tagged column emits byte-identical SQL.
3. **Errors carry keys, never values.** A `NotFoundError` says `where: { id, email }`. A `UniqueConstraintError` names the column that conflicted. Neither prints the user's data, so the error is safe to send straight to Sentry with no scrubbing rule in front of it. The full `where` object stays available as `err.where` in code.
4. **Data-destroying statements need consent.** `migrate up`, `migrate down` and `push` scan for `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, unqualified `DELETE` / `UPDATE`, and `ALTER COLUMN … TYPE`, print an itemized report, and refuse to run. Interactively you type `destroy my data` and then `yes`; in CI you pass `--allow-destructive`. A refused batch applies nothing.
5. **The review a DBA would have given you, offline.** `npx turbine doctor` derives every column set the ORM's relation subqueries probe and reports the ones with no covering index, with a cost tier per finding. `--fix` writes the migration. No cloud service, no telemetry, no account: it reads your introspected schema.

**On "only".** Each of these is checkable, so here is the checkable version, current as of July 2026: no other TypeScript ORM ships a studio that is read-only by default or that redacts PII (Prisma Studio is proprietary and its read-only request has been open since February 2021; Drizzle Studio is not open source and self-hosting runs through the paid Drizzle Gateway; TypeORM, MikroORM, Kysely and Sequelize have no studio). No TypeScript ORM CLI offers missing-index advice: not the Prisma CLI, drizzle-kit, kysely-ctl, or the MikroORM / TypeORM / Sequelize CLIs, and Prisma Optimize was retired in March 2026 in favour of cloud-only Query Insights. Prior art exists outside TypeScript, notably Ruby's `active_record_doctor`, so the honest claim is "no TypeScript ORM", not "no ORM". Turbine is the only TypeScript ORM that ships all five of the above together.

Two more things worth knowing, which are about cost rather than safety:

- **One runtime dependency (`pg`).** No engine binary, no WASM, no adapter packages in lockstep. The main entry's **import graph** is ~65 kB brotli (edge ~50 kB) with `pg` external (measured 2026-07-25 on 0.50.0: 65.16 kB and 50.18 kB, budgeted in `.size-limit.js`). That is the client footprint your bundler sees, not the size of the dual ESM+CJS build on disk, which is larger. Prisma 7 dropped its Rust query engine but its client still ships a TypeScript/WASM query compiler, a ~1.6 MB bundle, down from the ~14 MB Rust-era client.
- **Real pipelining, not a batch transaction.** `db.pipeline(...)` uses the Postgres extended-query protocol (Parse/Bind/Execute/Sync) to put N independent queries in one TCP flush. node-postgres does not expose pipelining in its pure-JS core ([brianc/node-postgres#2646](https://github.com/brianc/node-postgres/issues/2646) was still open as of July 2026), and Drizzle's `db.batch()` is an implicit transaction on specific drivers rather than independent-query pipelining.

**Beyond the safety bundle, what ships today:** [global filters](https://turbineorm.dev/global-filters) for soft-delete and multi-tenancy · [read replicas](https://turbineorm.dev/read-replicas) with a `$primary()` escape hatch · a read-only [MCP server](https://turbineorm.dev/mcp) for AI agents · [seed-as-code](https://turbineorm.dev/seeding) and a non-interactive `migrate deploy` for CI · [Zod generation](https://turbineorm.dev/zod) · read-only [views & generated columns](https://turbineorm.dev/views) · [optional SQLite / MySQL / SQL Server / PowDB engines](https://turbineorm.dev/engines) behind subpath exports · a [Prisma migration toolkit](https://turbineorm.dev/migrate-from-prisma) (schema mapper plus a runtime compat adapter) · a cost-aware index advisor in [`turbine doctor`](https://turbineorm.dev/cli#turbine-doctor).

Per-release detail lives in the [CHANGELOG](./CHANGELOG.md) and at [turbineorm.dev/changelog](https://turbineorm.dev/changelog).

## Benchmarks

Measured **2026-07-25 against turbine-orm 0.50.0** (commit `f8fec86`), tested against **Prisma 7.9.0** (`@prisma/adapter-pg`, `relationJoins` preview on) and **Drizzle 0.45.2** (relational queries) on a **local PostgreSQL 17.9** database over a Unix socket, with a **hand-written `pg` control arm**. Node v24.18.0, Apple Silicon MacBook Pro (M5 Max). Same schema, same data (1K users, 10K posts, 50K comments), same pool config.

Every arm runs once per round, the arm order rotates every round, and each figure is the median over 200 rounds, taken as the median of three full runs. A local socket has no network round-trip, so these numbers are mostly sub-millisecond and isolate per-query overhead instead of hiding it behind network latency.

Prisma's nested scenarios run on its **`join`** load strategy, which is its favorable configuration and is chosen deliberately.

| Scenario | Turbine 0.50 | Prisma 7.9 | Drizzle 0.45 | raw pg |
|---|---|---|---|---|
| findMany, 100 users (flat) | **0.256 ms** | 0.358 ms | 0.330 ms | 0.210 ms |
| findMany, 50 users + posts (L2) | 2.421 ms | 4.603 ms | **2.001 ms** | 1.953 ms |
| findMany, 10 users → posts → comments (L3) *(near-tie)* | 1.255 ms | 3.735 ms | **1.214 ms** | n/a |
| findUnique, single user by PK | **0.051 ms** | 0.105 ms | 0.108 ms | 0.060 ms |
| findUnique, user + posts + comments (L3) | **0.217 ms** | 0.469 ms | 0.357 ms | n/a |
| count, all users | **0.044 ms** | 0.081 ms | 0.061 ms | 0.045 ms |
| stream, iterate 50K rows (batch 1000) | 63.87 ms | 71.08 ms | **50.18 ms** | 50.97 ms |
| atomic increment, `view_count + 1` *(near-tie)* | **0.115 ms** | 0.174 ms | 0.123 ms | 0.095 ms |
| pipeline, 5-query batch | **0.206 ms** | 0.431 ms | 0.402 ms | 0.205 ms |
| hot findUnique, 500x same shape | **0.029 ms** | 0.065 ms | 0.075 ms | 0.033 ms |

**The number worth quoting: Turbine runs at 1.07x hand-written `pg`, where Drizzle runs at 1.47x and Prisma at 1.84x** (geometric mean over the eight scenarios with a raw control). Across all ten scenarios Turbine is **1.87x faster than Prisma 7.9** and **1.36x faster than Drizzle 0.45** by geometric mean.

- **Turbine takes seven scenarios**, Drizzle three, Prisma none. Prisma is behind Turbine on all ten. Two of the ten (L3 nested, atomic increment) are genuine near-ties and are not leads for either side.
- **Drizzle wins streaming outright, by 27%** (50.18 ms vs Turbine's 63.87 ms), reproduced in every run. Drizzle sits exactly on the raw `pg` keyset control, which is where a thin builder should sit; Turbine's cursor carries about 25% overhead above hand-written keyset pagination on a full-table drain. That overhead buys cursor semantics keyset cannot offer (any `orderBy`, deterministic early break, nested `with` per batch), but on this shape it is a loss and it is an open optimization target. A previous version of this table showed Turbine fastest here and called it a near-tie; that rested on a Drizzle figure we could not reproduce, and it was wrong.
- **Drizzle also leads nested reads (L2).** Turbine's `json_agg` nesting is close behind and **1.9x to 3.0x ahead of Prisma** on the same L2/L3 shapes.
- **Pipeline batching is Turbine's clearest win**: one TCP flush for 5 queries runs the dashboard batch 2.09x faster than Prisma's and 1.95x faster than Drizzle's sequential transaction, level with the raw `pg` control.

> **Read the drift floor before quoting a sub-millisecond figure.** The identical raw control arm drifts 1% to 14% between runs on the multi-millisecond scenarios but **21% to 47%** on the sub-0.15 ms ones (findUnique by PK, count, atomic increment, hot findUnique, pipeline). Those orderings are stable across all five runs; their absolute values carry roughly one third uncertainty. Full per-run drift tables in [`benchmarks/RESULTS-0.50.0.md`](./benchmarks/RESULTS-0.50.0.md).

Net: Turbine is competitive-to-ahead across the board rather than a clean sweep, and the honest takeaway is unchanged: performance is close enough that the real reasons to choose Turbine are elsewhere. **One dependency and no WASM** (vs Prisma 7's ~1.6 MB TypeScript/WASM query compiler), the **only read-only-by-default Studio** in the TS ORM ecosystem, **PII-safe error messages** that never leak user data, and **SQL-first migrations** with SHA-256 drift detection. Deep type inference through `with` clauses works end-to-end: write `db.users.findMany({ with: { posts: { with: { comments: true } } } })` and `users[0].posts[0].comments[0].body` autocompletes, with no manual assertion and no helper annotation.

> Full analysis, methodology and the drift floor: [`benchmarks/RESULTS-0.50.0.md`](./benchmarks/RESULTS-0.50.0.md). Historical runs: [`benchmarks/RESULTS.md`](./benchmarks/RESULTS.md).
> Reproduce: `cd benchmarks && npm install && npx prisma generate && DATABASE_URL=... npx tsx bench-interleaved.ts`

## Quick Start

```bash
# 1. Install (the CLI also needs tsx to load .ts config/schema files)
npm install turbine-orm
npm install --save-dev tsx

# 2. Initialize project
npx turbine init --url postgres://user:pass@localhost:5432/mydb

# 3. Generate typed client from your database
npx turbine generate
```

> **CLI prerequisites.** The `turbine` CLI loads your `turbine.config.ts` / `turbine/schema.ts` directly, so a fresh project needs `tsx` installed (otherwise `.ts` config loading fails with *"Loading .ts config / schema files requires tsx to be installed"*). Turbine ships both ESM and CommonJS builds, so the CLI loads your config and schema correctly in either an ESM (`"type": "module"`) or a CommonJS project; ESM is recommended but not required. See [USING-TURBINE-ORM.md §0](docs/USING-TURBINE-ORM.md) for details.

The `turbine-orm` package ships real dual builds, so importing the package works from either module system:

```typescript
// ESM
import { TurbineClient, defineSchema } from 'turbine-orm';

// CommonJS
const { TurbineClient, defineSchema } = require('turbine-orm');
```

> **`turbine` is not exported by the package.** The `turbine()` factory is emitted into the *generated* client, because it is typed against your schema. Import it from your output directory (`./generated/turbine`), never from `'turbine-orm'`. From the package itself you get the untyped-but-generic `TurbineClient`, which takes a `SchemaMetadata` as its second argument.

The generated client (`./generated/turbine/`) is TypeScript source: it re-exports across files with ESM-style `./metadata.js` specifiers, so you consume it through your bundler, `tsx`, or `tsc` like the rest of your app:

```typescript
import { turbine } from './generated/turbine';
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

### Many-to-many relations

Turbine auto-detects pure junction tables during `generate` — a table whose primary key is exactly two single-column foreign keys and which carries no other columns (e.g. `posts_tags(post_id, tag_id)`). Both endpoints gain a many-to-many relation you can load like any other:

```typescript
const posts = await db.posts.findMany({
  with: { tags: true }, // each post comes back with its tags array
});

// Nested where / orderBy / limit work on the m2m target too
const post = await db.posts.findFirst({
  where: { id: 1 },
  with: { tags: { where: { name: 'sql' }, orderBy: { name: 'asc' }, limit: 5 } },
});
```

A junction table that carries extra columns (a "payload") is treated as a first-class entity, so it stays an ordinary `hasMany` — that's by design. For those, or for any junction you want to wire up by hand, declare the relation explicitly in your code-first schema:

```typescript
import { defineSchema } from 'turbine-orm';

export default defineSchema({
  posts: {
    id:    { type: 'serial', primaryKey: true },
    title: { type: 'text', notNull: true },
    manyToMany: [
      { name: 'tags', target: 'tags', through: 'postsTags',
        sourceKey: 'postId', targetKey: 'tagId' },
    ],
  },
  // ...tags and postsTags table definitions
});
```

`sourceKey`/`targetKey` are the junction columns referencing each side's primary key; add `references` if the source side is keyed on something other than `id`.

Since 0.50, a many-to-many relation also takes **`connect`, `disconnect` and `set`** as nested writes, so link rows are written for you inside the write's transaction:

```typescript
// link (idempotent: an existing link is left alone, never duplicated)
await db.posts.update({ where: { id: 1 }, data: { tags: { connect: [{ id: 7 }, { id: 9 }] } } });

// unlink exactly those two, and nothing else
await db.posts.update({ where: { id: 1 }, data: { tags: { disconnect: [{ id: 7 }] } } });

// replace the whole link set (`set: []` clears it)
await db.posts.update({ where: { id: 1 }, data: { tags: { set: [{ id: 3 }] } } });

// on create, `connect` links after the parent row exists
await db.posts.create({ data: { title: 'hi', tags: { connect: [{ id: 3 }] } } });
```

The other nested operations (`create`, `connectOrCreate`, `update`, `upsert`, `delete`) would have to write the target row too, and there is no safe default for a junction's own extra columns, so they throw `ValidationError` (`TURBINE_E003`) naming the supported set. For those, write the target row on its own table and link it with `connect`, or write junction rows directly through the junction accessor, inside the same `$transaction`. Composite junction keys are refused for the same reason (nothing partially-keyed is emitted).

### Self-relations

A self-referencing foreign key (e.g. `categories.parent_id → categories.id`) introspects to a `belongsTo` *and* a `hasMany` on the same table, so parent and child queries just work — including nested trees:

```typescript
// A category with its parent and its children
const category = await db.categories.findFirst({
  where: { id: 2 },
  with: { parent: true, children: true },
});

// Walk a level deeper
const tree = await db.categories.findFirst({
  where: { id: 1 },
  with: { children: { with: { children: true } } },
});
```

When a table has a single self-referencing FK, Turbine auto-names the relations after the table: the `belongsTo` is named for the singular (`category`) and the `hasMany` for the table (`categories`). Rename them in your code-first schema if you prefer `parent`/`children`.

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

`tx` is a `TransactionClient`, which is deliberately a **smaller** object than `db`. It has table accessors (`tx.users`, or `tx.table('users')`), `tx.$transaction(fn)` for SAVEPOINT-nested blocks, `tx.raw` for tagged-template raw SQL, and `tx.schema`. It does **not** have `tx.sql`, `tx.pipeline`, `tx.$use`, `tx.$listen` / `tx.$notify`, `tx.$observe`, `tx.$on` / `tx.$off`, `tx.$retry`, `tx.$primary`, `tx.$withSession`, `tx.pipelineSupported()`, `tx.transaction()`, `tx.connect()`, `tx.pool`, `tx.stats`, `tx.disconnect()` or `tx.end()`. `TransactionClient` declares exactly `table()`, `$transaction()`, `raw` and `schema` (plus the generated per-table accessors) and has no index signature, so reaching for any of the others is a **compile error** (`TS2339`), caught in your editor rather than in production. See [Transactions & Pipelines](https://turbineorm.dev/transactions#transactionclient-reference) for the full surface and the reason each omission exists.

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

### Typed raw SQL (`db.sql<T>`)

`db.sql<T>` is the typed escape hatch: you supply the row shape and get a thenable query with `.one()` and `.scalar()` helpers. Every `${value}` is bound as a `$N` parameter — never interpolated — so injection isn't possible even with hostile input.

```typescript
// Awaiting the query returns T[]
const users = await db.sql<{ id: number; name: string }>`
  SELECT id, name FROM users WHERE org_id = ${orgId}
`;

// .one() returns T | null
const user = await db.sql<{ id: number; name: string }>`
  SELECT id, name FROM users WHERE id = ${42}
`.one();

// .scalar() returns the first column of the first row, or null
const total = await db.sql<{ count: number }>`
  SELECT COUNT(*)::int AS count FROM users
`.scalar();
```

Reach for `db.sql<T>` when you want a hand-written query with a known return type; use `db.raw` when you don't need the typing or the helpers.

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

### Relation loading and wire encoding

A few client options tune how `with` relations are loaded and encoded. All are optional and default to today's behavior.

```typescript
const db = turbine({
  connectionString: process.env.DATABASE_URL,
  // How with-clause relations resolve: 'auto' (default since 0.41.0: the
  // single-statement join plan, with a per-relation batched fallback when the
  // correlation column has no covering index), 'join' (always one correlated-
  // subquery statement), or 'batched' (base query + one flat follow-up per
  // relation). Override per query on findMany/findFirst/findUnique.
  relationLoadStrategy: 'auto',
  // 'positional' (Postgres-only) drops repeated JSON keys from relation
  // subqueries — ~39% fewer wire bytes on wide relations, byte-identical output.
  // Default 'object'.
  jsonEncoding: 'object',
  // Parse `timestamp` (without time zone) as UTC — the Prisma/Rails/Django
  // convention — so results don't shift with the server's local zone.
  // Default true; set false for the legacy local-time interpretation.
  utcTimestamps: true,
});
```

Run `npx turbine doctor` to catch relations whose child-side FK lacks a covering index — the correlated-subquery strategy probes the child once per parent row, so a missing FK index costs a full scan per parent.

### Pool and statement configuration

```typescript
const db = turbine({
  connectionString: process.env.DATABASE_URL,
  poolSize: 10,               // max pooled connections (default 10; pg alias: max)
  idleTimeoutMs: 30_000,      // close an idle connection after this (pg alias: idleTimeoutMillis)
  connectionTimeoutMs: 5_000, // give up acquiring a connection after this (pg alias: connectionTimeoutMillis)
  preparedStatements: true,   // see the warning below
  sqlCache: true,             // SQL template cache (default true)
  sqlCacheSize: 1000,         // distinct query SHAPES retained per table (default 1000)
});
```

Where a pg-style alias exists (`max`, `idleTimeoutMillis`, `connectionTimeoutMillis`), the explicit Turbine field wins when both are set.

> **`preparedStatements` and connection poolers.** With prepared statements on, Turbine submits queries as `{ name, text, values }` so Postgres caches the parse and plan **per backend connection**. That is a real win against a database you connect to directly, and a hazard behind a transaction-pooling proxy (PgBouncer in `transaction` mode, Supabase's pooler port, some serverless poolers): the named statement is prepared on one backend and your next query may land on another, which fails with `prepared statement "..." does not exist`. Turbine defaults it to `true` only for pools it creates itself and `false` for external pools passed via `pool` / `turbineHttp()`, because serverless drivers are the common case there. If you are pointing a Turbine-owned pool at a transaction pooler, set `preparedStatements: false`. The environment variable `TURBINE_DISABLE_PREPARED=1` turns it off globally without a code change.

### Client escape hatches

| Member | Type | What it is for |
|---|---|---|
| `db.table<T>(name)` | `QueryInterface<T>` | Query a table by string name. This is the escape hatch for tables that are absent from your generated types: a table created after the last `generate`, a table reached over `turbineHttp(pool, SCHEMA)` where there is no generated subclass, or a name that is not a valid identifier. Pass `T` yourself to get typing back. The name is still validated against the schema metadata. |
| `db.pool` | `pg.Pool` | The underlying pool, for anything Turbine does not wrap. |
| `db.schema` | `SchemaMetadata` | The metadata the client was built from. |
| `db.stats` | `{ totalCount, idleCount, waitingCount }` | Pool gauges for a health endpoint. Returns zeros on drivers that do not expose counts (Neon HTTP). |
| `db.transaction(fn)` | raw `pg.PoolClient` | The pre-typed transaction API. Prefer `$transaction`; this exists for hand-written SQL that needs the same connection. |
| `db.end()` | `Promise<void>` | Alias for `disconnect()`. Both are a no-op for an external pool, because the caller owns its lifecycle. |
| `QueryInterface.cacheStats()` | `{ size, hits, misses, hitRate }` | Per-table SQL-template cache counters, e.g. `db.users.cacheStats()`. Useful to confirm a hot path is actually reusing a cached template rather than re-fingerprinting a new shape every call. |

### Building queries without running them

Every query method has a `build*` twin that returns a `DeferredQuery` (`{ sql, params, transform, tag }`) instead of executing. That is what `pipeline()` and the array form of `$transaction()` consume, and it is not read-only: the write builders are batchable too.

```typescript
// Reads and writes in ONE atomic batch, one connection, one BEGIN/COMMIT
const [order, _items, updated] = await db.$transaction([
  db.orders.buildCreate({ data: { userId: 1, total: 4200 } }),
  db.orderItems.buildCreateMany({ data: [{ orderId: 1, sku: 'A' }, { orderId: 1, sku: 'B' }] }),
  db.users.buildUpdate({ where: { id: 1 }, data: { orderCount: { increment: 1 } } }),
]);
```

The full set: `buildFindMany`, `buildFindUnique`, `buildFindFirst`, `buildFindUniqueOrThrow`, `buildFindFirstOrThrow`, `buildCount`, `buildAggregate`, `buildGroupBy`, `buildCreate`, `buildCreateMany`, `buildUpdate`, `buildUpdateMany`, `buildUpsert`, `buildDelete`, `buildDeleteMany`.

Use `db.pipeline(...)` when the queries are independent and you want one round-trip with no transaction; use `db.$transaction([...])` when you want all-or-nothing. Nested writes (relation operations inside `data`) open their own transaction, so those methods stay `async` and have no `build*` twin.

### Middleware

Middleware wraps every query. It runs **after SQL generation**, so it can observe what's about to execute (`params.model`, `params.action`, `params.args`), measure timing, and transform the result returned by `next()` — but it cannot change the query itself.

```typescript
// Query timing
db.$use(async (params, next) => {
  const start = Date.now();
  const result = await next(params);
  console.log(`${params.model}.${params.action} took ${Date.now() - start}ms`);
  return result;
});

// Result transformation — redact a field on the way out
db.$use(async (params, next) => {
  const result = await next(params);
  if (params.model === 'users' && Array.isArray(result)) {
    for (const row of result as { email?: string }[]) row.email = '[redacted]';
  }
  return result;
});
```

> **Warning:** `params.args` is a read-only snapshot — mutating it does not change the executed SQL. The query is fully built and parameterized before middleware runs.

Middleware can't rewrite queries, so cross-cutting predicates like **soft deletes** and **multi-tenancy** belong to [global filters](https://turbineorm.dev/global-filters) instead. A global filter is a `WhereClause` that Turbine `AND`-merges into the compiled `WHERE` of every query on a table: reads, the relation subqueries that target it, and the predicate of `update` / `delete` / `upsert`. `create` and `createMany` are never filtered, since a new row has nothing to scope.

```typescript
const db = turbine({
  connectionString: process.env.DATABASE_URL,
  globalFilters: {
    // Soft delete (static)
    posts: { deletedAt: null },
    users: { deletedAt: null },
    // Multi-tenancy: a function is evaluated every time a query is built,
    // so a closure over per-request state gives you request-scoped isolation
    orders: () => ({ tenantId: currentTenant() }),
  },
});

await db.posts.findMany();
// SELECT ... FROM "posts" WHERE "deleted_at" IS NULL

await db.users.findMany({ where: { role: 'admin' } });
// SELECT ... FROM "users" WHERE "role" = $1 AND "deleted_at" IS NULL
```

Values are always parameterized. Opt a single query out with `skipGlobalFilters: true` (or a table-name array). Note that a global filter does **not** satisfy the empty-`where` guard: an `update` or `delete` with no `where` of its own still throws unless you pass `allowFullTableScan: true`.

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

Error codes: `TURBINE_E001` (NotFound), `TURBINE_E002` (Timeout), `TURBINE_E003` (Validation), `TURBINE_E004` (Connection), `TURBINE_E005` (Relation), `TURBINE_E006` (Migration), `TURBINE_E007` (CircularRelation), `TURBINE_E008` (UniqueConstraint), `TURBINE_E009` (ForeignKey), `TURBINE_E010` (NotNullViolation), `TURBINE_E011` (CheckConstraint), `TURBINE_E012` (Deadlock), `TURBINE_E013` (SerializationFailure), `TURBINE_E014` (Pipeline), `TURBINE_E015` (OptimisticLock), `TURBINE_E016` (ExclusionConstraint), `TURBINE_E017` (UnsupportedFeature: a Postgres-only feature invoked on another engine), `TURBINE_E018` (ReadOnly: a write refused on a read-only database, reason `'snapshot'` | `'rbac'`).

Full reference with `wrapPgError()` translation, retry patterns for `DeadlockError` / `SerializationFailureError`, and safe vs verbose message modes: **[turbineorm.dev/errors](https://turbineorm.dev/errors)**.

### groupBy with HAVING

`groupBy` aggregates rows by one or more columns. Add a `having` clause to filter the resulting groups by their aggregates. Every comparison value is parameterized.

```typescript
// Users with more than one post
const prolific = await db.posts.groupBy({
  by: ['userId'],
  _count: true,
  having: { _count: { gt: 1 } },
});

// Groups whose summed view count clears a threshold
const popular = await db.posts.groupBy({
  by: ['published'],
  _sum: { viewCount: true },
  having: { viewCount: { _sum: { gte: 100 } } },
});
```

Filter on the group count with `_count`, or on a column aggregate with `{ column: { _sum | _avg | _min | _max: { ... } } }`. Operators are `gt`, `gte`, `lt`, `lte`, `in`, and `notIn` (a bare number is shorthand for equality). `having` predicates combine with `AND`, and `where` filters rows *before* grouping while `having` filters groups *after*.

### Multi-tenant queries with RLS session context

Set transaction-local Postgres settings (GUCs) so PostgreSQL Row-Level Security policies that call `current_setting()` filter rows for you. Pass `sessionContext` to `$transaction`, or use the `$withSession` shorthand.

```typescript
// Postgres policy: USING (tenant_id = current_setting('app.current_tenant')::int)
const rows = await db.$transaction(
  async (tx) => tx.documents.findMany(),
  { sessionContext: { 'app.current_tenant': tenantId } },
);

// Shorthand for a single-purpose session
const rows2 = await db.$withSession(
  { 'app.current_tenant': tenantId },
  async (tx) => tx.documents.findMany(),
);
```

Each entry is applied as `SELECT set_config(name, value, true)` right after `BEGIN`, so the setting is scoped to the transaction and resets automatically on commit. Values may be strings, numbers, or booleans (coerced to strings). Invalid setting names throw `ValidationError` and roll the transaction back before any query runs.

### Realtime with LISTEN/NOTIFY

Subscribe to a Postgres channel with `$listen` and publish to it with `$notify`. The handler receives the notification payload as a string.

```typescript
const sub = await db.$listen('order_created', (payload) => {
  console.log('new order:', payload);
});

await db.$notify('order_created', JSON.stringify({ id: 1 }));

// Later, when you're done
await sub.unsubscribe();
```

`$listen` holds a dedicated connection open for the lifetime of the subscription, so it requires a real persistent pool — it is not available over serverless HTTP drivers. `$notify` is a single round-trip and works everywhere. Channel names are validated as plain identifiers; the payload is always bound as a parameter.

## Vector search (pgvector)

Query a `vector` column for nearest neighbors. Requires the [pgvector](https://github.com/pgvector/pgvector) extension and a `vector` column on your table.

**KNN ranking** — order by distance to a query vector and take the closest rows:

```typescript
const similar = await db.items.findMany({
  orderBy: { embedding: { distance: { to: queryVector, metric: 'cosine' } } },
  limit: 5,
});
// queryVector is a number[]; nearest-first by default (direction: 'desc' to invert)
```

**Distance filter** — keep only rows within a distance threshold:

```typescript
const close = await db.items.findMany({
  where: { embedding: { distance: { to: queryVector, metric: 'l2', lt: 0.3 } } },
});
```

`metric` selects the pgvector operator: `'l2'` → `<->` (Euclidean), `'cosine'` → `<=>` (cosine distance), `'ip'` → `<#>` (negative inner product). Distance filters accept `lt`, `lte`, `gt`, and `gte`. The query vector is always bound as `$n::vector` — never interpolated.

> **Note:** pg has no built-in parser for the `vector` type, so a fetched `vector` column comes back as a string literal like `'[1,2,3]'` unless you register a parser (e.g. via pgvector's own client helpers). Querying by distance works regardless.

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
  init                               Initialize a Turbine project (creates config, dirs, templates)
  generate | pull                    Introspect database and generate TypeScript types + client
  push                               Apply schema-builder definitions to database
  migrate create <name>              Create a new SQL migration file
  migrate create <name> --auto       Auto-generate from schema diff
  migrate create <name> --from-diff  Like --auto, but flag destructive statements
  migrate up                         Apply pending migrations
  migrate deploy                     Apply pending migrations without prompts
  migrate down                       Rollback last migration (--step N for last N)
  migrate status                     Show applied/pending migrations
  seed                               Run seed file
  status                             Show database schema summary
  doctor                             Check relations for missing FK indexes (--fix emits migration)
  studio                             Launch local Studio web UI (read-only; --write for writes, --demo for a sample DB)
  mcp                                Start read-only MCP server over JSON-RPC stdio
  observe                            Launch local metrics dashboard (requires TURBINE_OBSERVE_URL)

Options:
  --url, -u <url>       Postgres connection string
  --out, -o <dir>       Output directory (default: ./generated/turbine)
  --schema, -s <name>   Postgres schema (default: public)
  --auto                Auto-generate migration from schema diff
  --from-diff           Like --auto, but flag destructive statements (migrate create)
  --recipe <name>       Scaffold a sanctioned pattern, e.g. backfill (migrate create)
  --step, -n <N>        Apply/rollback only N migrations (migrate up / down)
  --allow-drift         Bypass checksum validation (migrate up / deploy)
  --allow-destructive   Run data-destroying statements without confirmation (up / down / push)
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

# Same diff, but destructive statements flagged inline (still refused by
# migrate up unless confirmed or --allow-destructive); cannot combine with --auto/--recipe
npx turbine migrate create sync_schema --from-diff

# Apply all pending migrations
npx turbine migrate up

# Rollback the last applied migration
npx turbine migrate down

# Check migration status (applied vs pending)
npx turbine migrate status
```

**Destructive migrations require explicit confirmation.** If a pending migration (or a DOWN
section being rolled back) contains data-destroying SQL — `DROP TABLE`, `DROP COLUMN`,
`TRUNCATE`, `DELETE FROM`, `UPDATE` without `WHERE`, `ALTER COLUMN … TYPE` — Turbine refuses
to run it and prints an itemized report. Interactively you must type `destroy my data` and
then `yes`; in CI you must pass `--allow-destructive`. A refused batch applies nothing.

## Studio

`turbine studio` launches a local web UI for exploring your database. It is **read-only by default** (no mutations, no writes, every transaction `BEGIN READ ONLY`) and since v0.19 has **no raw-SQL surface at all**: every query is composed visually in the ORM and compiled by the same validated query builder your application uses. Since v0.36, `--write` opts a launch in to primary-key-addressed insert/update/delete through that same validated builder (single rows, or a capped multi-select batch run in one all-or-nothing transaction since v0.38); without the flag the write endpoints do not exist.

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/mydb npx turbine studio
# With flags
npx turbine studio --port 5173 --host 127.0.0.1 --no-open
```

**Try it without a database.** `npx turbine-orm@latest studio --demo` boots Studio against a seeded, in-memory sample database (users, posts, comments, orgs) with no `DATABASE_URL` and no extra dependency, backed by Turbine's own SQLite engine over `node:sqlite` (Node 22.5+). An in-UI switcher flips the three modes live (Read-only / Show PII / Write), so you can feel PII redaction and the write flow back to back. Writes genuinely apply to the in-memory store but nothing is ever saved: every launch starts fresh.

**Features**

- **Query / Data / Schema tabs.** Compose queries visually, browse rows, and inspect tables and relations.
- **ORM-native query composer.** The Query tab builds a real `findMany` — drill into relations (`with`) to any depth, pick fields (`select`/`omit`), add filters (`where`), `orderBy`, and `limit` at every level — with a live TypeScript preview of the exact call to copy into your codebase.
- **Saved queries.** Named builder queries persisted to `.turbine/studio-queries.json` — share them across runs without committing them.
- **Cmd+K command palette.** Jump to any table, tab, or saved query in one keystroke.
- **Full-text search across rows.** The Data tab supports substring search across every text column of the current table.
- **PII redaction.** Columns tagged `pii: true` in the schema render as a redaction placeholder in every tab. `--show-pii` reveals them, with a loud startup warning. Tags are a code-first declaration (introspection never infers one), so Studio reads them from the generated metadata in your `out` directory; if it finds none it says so at startup rather than implying a protection it cannot apply.
- **Opt-in write mode.** `--write` enables insert/update/delete from the Data tab (single rows, multi-select delete, and paste-to-insert batches), gated per row by the full primary key, compiled by the same validated builders, and flagged with a persistent WRITE MODE banner. Read-only stays the default on every launch.

**Security posture (read-only by default)**

- **No SQL input surface.** There is nothing to inject into: builder requests are validated identifier-by-identifier against the introspected schema, and every value is bound as a `$N` parameter.
- **Loopback by default** (`127.0.0.1`). Non-loopback `--host` is **refused** unless you pass `--allow-remote` (loud warning when you opt in).
- **Per-process auth token**: 24 random bytes of hex, stored in a `SameSite=Strict` `HttpOnly` cookie.
- **Every read query runs inside `BEGIN READ ONLY`** with a 30s transaction-local statement timeout (parameterized `set_config`). Without `--write`, the write endpoints do not exist (they 404) and writes are impossible at the transaction level; with it, each write runs in its own transaction with the same timeout and schema pinning, requires the row's full primary key, and rejects absent or mismatched `Origin` headers.
- **Security headers on every response**: nonce-based CSP, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, plus per-session rate limiting and cross-origin refusal.

## Observability

Built-in query metrics with zero new dependencies. `$observe` buffers per-query timings in memory and flushes **per-minute aggregates** — count, avg, p50, p95, p99, and error count per `model:action` — to a `_turbine_metrics` table in a **separate database**, over its own 1-connection pool so metrics writes never contend with your application pool.

```typescript
const handle = await db.$observe({
  connectionString: process.env.TURBINE_OBSERVE_URL!, // metrics DB (not your app DB)
  flushIntervalMs: 60_000, // default: 60s
  retentionDays: 30,       // default: 30 — older buckets are pruned on flush
});

// Later, to flush remaining metrics and close the metrics pool
await handle.stop();
```

`$observe` creates the `_turbine_metrics` table if it doesn't exist. Flushes are fire-and-forget (`INSERT ... ON CONFLICT` additive merge) and never throw into your application. If the `TURBINE_OBSERVE_URL` environment variable is set, the client starts observing automatically on construction — no code needed.

For your own instrumentation, subscribe to query events with `$on('query')` — each event carries `sql`, `params`, `duration` (ms), `model`, `action`, `rows`, `timestamp`, and `error` (if the query failed):

```typescript
db.$on('query', (e) => {
  if (e.duration > 200) {
    console.warn(`slow query: ${e.model}.${e.action} (${e.duration.toFixed(1)}ms, ${e.rows} rows)`);
  }
});
```

View the collected metrics in a local dashboard:

```bash
TURBINE_OBSERVE_URL=postgres://... npx turbine observe
# Flags: --port (default 4984), --host (default 127.0.0.1), --no-open
```

Same security model as Studio: loopback by default, non-loopback refused without `--allow-remote`, per-process random auth token in an `HttpOnly` cookie, CSP headers, and read-only access to the metrics table.

## Serverless / Edge

Turbine's core is driver-agnostic: pass any pg-compatible pool to `TurbineConfig.pool` (or use the `turbineHttp()` factory) and Turbine runs on **Vercel Edge**, **Cloudflare Workers**, **Deno Deploy**, **Netlify Edge**, or any other environment where a direct TCP connection is unavailable. No new dependencies — install whichever driver you already use.

### Neon Serverless (HTTP / WebSocket)

```ts
// app/api/users/route.ts
import { Pool } from '@neondatabase/serverless';
import { turbineHttp } from 'turbine-orm/serverless';
import { SCHEMA } from '@/generated/turbine/metadata';

export const runtime = 'edge';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = turbineHttp(pool, SCHEMA);

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
import { SCHEMA } from './generated/turbine/metadata.js';

const pool = createPool({ connectionString: process.env.POSTGRES_URL });
const db = turbineHttp(pool, SCHEMA);
```

### Supabase (direct Postgres — no HTTP proxy needed)

```ts
import { TurbineClient } from 'turbine-orm';
import { SCHEMA } from './generated/turbine/metadata.js';

const db = new TurbineClient({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
}, SCHEMA);
```

### Cloudflare Workers

```ts
import { Pool } from '@neondatabase/serverless';
import { turbineHttp } from 'turbine-orm/serverless';
import { SCHEMA } from './generated/turbine/metadata';

export default {
  async fetch(req: Request, env: Env) {
    const pool = new Pool({ connectionString: env.DATABASE_URL });
    const db = turbineHttp(pool, SCHEMA);
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

## Database engines

Turbine is **Postgres-first** — `import { TurbineClient } from 'turbine-orm'` targets PostgreSQL, and the safety bundle above is built around it. When you need another database, the same typed API runs on **SQLite**, **MySQL 8**, and **SQL Server** through subpath exports — plus **PowDB**, a single-node embedded database with its own query language (PowQL). Multi-engine is *additive*, not a pivot: pick the engine that fits, keep the same `findMany` / `with` / `where` API.

Two engines run **in-process** (no server): **SQLite** (always — there is no SQLite wire protocol) and **PowDB**, which uniquely runs *both* in-process (embedded) *and* over a network client against the same data. The root install stays one dependency (`pg`). Each engine's driver is its own concern: SQLite needs nothing (Node's built-in `node:sqlite`), while MySQL, SQL Server, and PowDB use **optional peer dependencies** you install only if you use them.

```bash
# SQLite — zero extra deps (Node >= 22.5, built-in node:sqlite)
npm install turbine-orm

# MySQL 8 — optional peer
npm install turbine-orm mysql2

# SQL Server 2016+ — optional peer
npm install turbine-orm mssql

# PowDB — optional peer; embedded (in-process) or networked transport
npm install turbine-orm @zvndev/powdb-embedded   # in-process
npm install turbine-orm @zvndev/powdb-client     # networked
```

Each engine ships a factory that returns the same `TurbineClient`:

```ts
// SQLite — synchronous; pass a file path, ':memory:', or an open DatabaseSync
import { turbineSqlite } from 'turbine-orm/sqlite';
import { SCHEMA } from './generated/turbine/metadata.js';

const db = turbineSqlite(':memory:', SCHEMA);
const users = await db.users.findMany({ with: { posts: true }, limit: 10 });
```

```ts
// MySQL 8 — async; connection string, mysql2 config, or an existing mysql2 pool
import { turbineMysql } from 'turbine-orm/mysql';
import { SCHEMA } from './generated/turbine/metadata.js';

const db = await turbineMysql('mysql://user:pass@localhost:3306/app', SCHEMA);
```

```ts
// SQL Server 2016+ — async; connection string, mssql config, or an existing pool
import { turbineMssql } from 'turbine-orm/mssql';
import { SCHEMA } from './generated/turbine/metadata.js';

const db = await turbineMssql('mssql://sa:Passw0rd!@localhost:1433/app', SCHEMA);
```

```ts
// PowDB — async; embedded (in-process) or networked. Schema is code-defined.
import { turbinePowDB } from 'turbine-orm/powdb';
import { schemaDefToMetadata } from 'turbine-orm';
import { schema } from './schema.js'; // defineSchema({...})

// PowDB has no introspection-driven `turbine generate`, so derive the runtime
// SchemaMetadata from the code-first definition.
const SCHEMA = schemaDefToMetadata(schema);

// Embedded, in-process. syncMode 'normal' moves fsync off the commit path:
const db = await turbinePowDB({ embedded: './data', syncMode: 'normal' }, SCHEMA);
// …or networked against a running powdb-server:
// const db = await turbinePowDB('powdb://127.0.0.1:7070', SCHEMA);
```

Migrating from Prisma? `turbine migrate-from-prisma` emits a typed `PRISMA_MAP`, and the
`turbine-orm/prisma-compat` subpath wraps a `TurbineClient` in Prisma's `db.Model.*`
surface (no new dependencies):

```ts
import { TurbineClient } from 'turbine-orm';
import { createPrismaCompatClient } from 'turbine-orm/prisma-compat';
import { SCHEMA } from './generated/turbine/metadata.js';
import { PRISMA_MAP } from './generated/turbine/prisma-map.js';

const db = new TurbineClient({ connectionString: process.env.DATABASE_URL }, SCHEMA);
const prisma = createPrismaCompatClient(db, PRISMA_MAP);

const users = await prisma.User.findMany({ include: { posts: { take: 5 } } });
```

### Capability matrix

Everything is honest about what ports and what doesn't. Features marked **PG-only** throw a typed `UnsupportedFeatureError` (`TURBINE_E017`) on other engines rather than silently degrading.

| Feature | PostgreSQL | SQLite | MySQL 8 | SQL Server |
|---|:---:|:---:|:---:|:---:|
| Single-query nested `with` | ✓ `json_agg` | ✓ `json_group_array` | ✓ `JSON_ARRAYAGG` | ✓ `FOR JSON PATH` |
| Transactions + savepoints | ✓ | ✓ (single-writer) | ✓ | ✓ |
| Streaming (`findManyStream`) | ✓ | ✓ | ✓ | ✓ |
| Migrations (`turbine migrate` CLI) | ✓ | PG-only (CLI) | PG-only (CLI) | PG-only (CLI) |
| pgvector distance / KNN | ✓ | ✗ E017 | ✗ E017 | ✗ E017 |
| LISTEN/NOTIFY realtime | ✓ | ✗ E017 | ✗ E017 | ✗ E017 |
| RLS `sessionContext` | ✓ | ✗ E017 | ✗ E017 | ✗ E017 |

✗ E017 = throws `UnsupportedFeatureError`. The full matrix (atomic updates, introspection, optimistic locking, per-cell mechanics) is on [turbineorm.dev/engines](https://turbineorm.dev/engines).

**Engine notes:** SQLite uses `RETURNING` (≥ 3.35) just like Postgres. MySQL has no `RETURNING`, so writes re-`SELECT` the affected row and **`createMany` returns `[]`** (the rows ARE inserted — re-query if you need them). SQL Server returns rows via `OUTPUT`/`MERGE`; `DISTINCT ON` is Postgres-only. Only Postgres streams via a true cursor (constant memory); the other engines' `findManyStream` materializes the result then yields it in batches. Optimistic locking throws `OptimisticLockError` on all engines (on MySQL the conflict is detected from the version-checked UPDATE's affected-row count). The `turbine` CLI (`generate`, `migrate`) is currently PostgreSQL-only — point the engine factories at a hand-written or programmatically introspected `SCHEMA`.

**PowDB** speaks its own non-SQL query language (PowQL), so it sits outside the SQL matrix above. Writes use a trailing **`returning`** keyword (upsert reselects by PK). PKs are server-assigned `auto` ints **or** client UUIDs. Nested relations run as **one statement** on engine 0.18+ (PowQL nested projections — per-parent order/limit, childless parents kept, the same single-query shape as Postgres `json_agg`); older engines and ineligible shapes (many-to-many via the junction) load client-side with identical output. Nested writes cover hasMany/hasOne/belongsTo, and route through the same shared nested-write engine as the SQL engines, so the many-to-many `connect` / `disconnect` / `set` junction writes added in 0.50 apply here too (they are ordinary reads and writes on the junction table); the remaining many-to-many operations throw `ValidationError`. Transactions are single-writer: concurrent `$transaction` calls queue FIFO (bounded by `transactionQueueTimeoutMs`); nested/re-entrant transactions throw typed errors (no savepoints). Schema is code-first via `defineSchema` — `schemaDefToMetadata()` bridges it to any engine that needs runtime metadata, and a programmatic `describe`-based introspector exists since 0.34 (relations excluded). JSON documents are first-class on engine 0.12+: `JsonFilter` where-filters, JSON-path `orderBy`/`groupBy`, doc-field expression indexes, and a lossless native wire (0.13+) that keeps JSON `null`, missing fields, and the string `"null"` distinct. Embedded `syncMode: 'normal'` moves fsync off the commit path; the networked transport runs the same data over a socket. Cursor streaming and the Postgres-only trio (pgvector / LISTEN/NOTIFY / RLS session GUCs) throw `UnsupportedFeatureError`. Full details: **[turbineorm.dev/engines#powdb](https://turbineorm.dev/engines#powdb)**.

Full setup, signatures, and the complete support matrix: **[turbineorm.dev/engines](https://turbineorm.dev/engines)**.

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

Turbine resolves nested relations the same way Prisma 7 and Drizzle do: correlated subqueries with `json_agg` + `json_build_object`, evaluated by PostgreSQL in a single round-trip. No N+1, no client-side stitching, no separate queries per relation. The `with` clause is fully type-inferred end-to-end — write `db.users.findMany({ with: { posts: { with: { comments: { with: { author: true } } } } } })` and `users[0].posts[0].comments[0].author.name` autocompletes with zero manual annotation.

The query strategy is table stakes now. What isn't table stakes: the one-dependency, no-WASM footprint, the read-only Studio your DBA will approve, the error messages that never leak PII, and the SQL-first migrations with SHA-256 drift detection. See [Why Turbine?](#why-turbine) for the full breakdown.

## Type Mapping

Turbine maps Postgres types to TypeScript:

| Postgres | TypeScript | Notes |
|---|---|---|
| `int2`, `int4`, `float4`, `float8` | `number` | Standard numeric types |
| `int8` / `bigint` | `number` | Values > `Number.MAX_SAFE_INTEGER` (2^53 - 1) are returned as `string` at runtime to avoid precision loss. This affects < 0.01% of use cases (auto-increment IDs, counts, etc. are all safe). |
| `numeric`, `money` | `string` | Arbitrary precision — kept as string to avoid JS float issues |
| `text`, `varchar`, `uuid`, `citext` | `string` | |
| `timestamptz`, `timestamp`, `date` | `Date` | `timestamp` (without time zone) is parsed as UTC by default (Prisma/Rails/Django convention), so the same row yields the same instant in every region. Opt out with `utcTimestamps: false`. |
| `boolean` | `boolean` | |
| `json`, `jsonb` | `unknown` | |
| `bytea` | `Buffer` | |
| Array types | `T[]` | e.g. `_text` → `string[]` |

## Comparison

| | **Turbine** | **Prisma** | **Drizzle** | **Kysely** |
|---|---|---|---|---|
| **Engine / runtime** | No engine binary (`pg` only) | Client + TS/WASM query compiler | No engine | No engine |
| **Runtime deps** | 1 (`pg`) | `@prisma/client` + required driver adapter | 0 | 0 |
| **Main bundle (brotli)** | ~65 kB import graph, `pg` external | ~1.6 MB client (TS/WASM compiler) | ~7 KB core | small |
| **Studio** | Read-only, 192-bit auth | Full CRUD, cloud-hosted | Free; hosted Gateway paid | None |
| **Error PII safety** | Keys only by default | Values in messages | Raw pg errors | Raw pg errors |
| **Migrations** | SQL-first, SHA-256 checksums | DSL-generated, shadow DB | SQL or Drizzle Kit | None |
| **Edge runtime** | One import swap, ~50 kB brotli | Driver adapter + WASM compiler | Native | Native |
| **Pipeline batching** | Parse/Bind/Execute protocol | Sequential in txn | Sequential | Manual |
| **Typed errors** | `isRetryable` discriminant | Error codes only | None | None |
| **Nested relations** | 1 query, deep type inference | 1 query, shallow inference | 1 query, `relations()` re-declaration | Manual (`jsonArrayFrom`) |
| **Many-to-many** | Auto-detected from junctions | Implicit/explicit | Explicit `relations()` | Manual joins |
| **Vector search** | Built-in `distance` / KNN | Preview / raw | Extension API | Manual |
| **LISTEN/NOTIFY** | `$listen` / `$notify` | None | None | None |
| **Multi-DB** | Postgres-first (+ SQLite/MySQL/MSSQL engines) | PG, MySQL, SQLite, MSSQL | PG, MySQL, SQLite | PG, MySQL, SQLite |

Reading the table: no engine binary and no WASM, just one runtime dependency (`pg`), against Prisma 7's ~1.6 MB TypeScript/WASM query compiler plus a required driver adapter; a Studio that is read-only by default, which as of July 2026 no other TypeScript ORM ships; error messages that never leak PII; and SQL-first migrations with SHA-256 drift detection. See [Benchmarks](#benchmarks) for performance numbers: most scenarios are within noise over a real pooled database.

*Competitor columns are re-verified against competitor releases on a fixed schedule. Last checked July 2026, against Prisma 7 and Drizzle 0.45. Features marked Preview or beta may change, and bundle sizes move release to release.*

**A note on Kysely.** Kysely's [`jsonArrayFrom` / `jsonObjectFrom`](https://kysely.dev/docs/recipes/relations) relations recipe builds nested results with the same correlated-subquery-plus-JSON approach Turbine uses — good evidence the pattern is the right one. The gap is in what the driver can no longer see once rows are aggregated into JSON: nested fields lose their column types, so a `Date` inside a `jsonArrayFrom` result is typed `Date` but arrives as a **string** at runtime ([kysely-org/kysely#482](https://github.com/kysely-org/kysely/issues/482)), and the nesting isn't type-checked at depth. Turbine's `WithResult` inference types the whole tree, and `parseNestedRow` re-applies date coercion (and snake→camel mapping) to every nested row — so `users[0].posts[0].createdAt` is an actual `Date`, at any depth, with no plugin to wire up.

## Limitations

Turbine is focused and opinionated. Here's what it doesn't do:

- **Postgres-first.** PostgreSQL is the default and primary target — going deep on one database is what enables the safety bundle and the edge-runtime story. SQLite, MySQL 8, and SQL Server engines are available as additive subpath exports (see [Database engines](#database-engines)), but several flagship features (pgvector, LISTEN/NOTIFY, RLS `sessionContext`, full-text `search`, array-column filters, `groupBy({ distinctOn })`) are Postgres-only and throw `UnsupportedFeatureError` elsewhere.
- **Full-text search** is available via a `search` filter — `where: { title: { search: 'hello & world', config: 'english' } }` compiles to a parameterized `to_tsvector(...) @@ to_tsquery(...)`. PostgreSQL only: the other engines throw `UnsupportedFeatureError` (`TURBINE_E017`) rather than degrade to a `LIKE`. For advanced ranking (`ts_rank`, weighted vectors) use `db.raw`.
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

- Node.js >= 20.0.0
- PostgreSQL >= 14 (tested). CI runs the integration suite against PostgreSQL 14, 15, 16 and 17 on every change; 14 is the oldest version anything is verified on. Nothing in Turbine's introspection or query generation is known to require a feature newer than PostgreSQL 12, so older servers may well work, but they are untested and unsupported.
- Works with both ESM (`import`) and CommonJS (`require`)

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, the test strategy, and the PR checklist. Participants agree to the [Code of Conduct](CODE_OF_CONDUCT.md). The unit suite runs without a database:

```bash
npm install
npm run test:unit
```

Integration tests need a PostgreSQL instance via `DATABASE_URL` (see CONTRIBUTING.md for a one-command seeded setup).

## License

MIT
