# turbine-orm

**A Postgres ORM written from scratch. One dependency.**

Turbine compiles typed queries straight to SQL. There is no query engine, no WASM, and nothing between your code and Postgres except `pg`: `dependencies` is literally one line. Nested relations resolve in one statement. The client is small enough for a Worker or a Lambda cold start, sits next to hand-written `pg` in the benchmarks, ships an 11-tool read-only MCP server so coding agents can work your schema safely, and includes the operational tooling (index advice, migration guards, PII projection) that usually lives in a paid cloud tier. MIT, and the engine seam is documented if you want to fork it.

```
npm install turbine-orm
```

**Docs: [turbineorm.dev](https://turbineorm.dev)** · [Quick Start](https://turbineorm.dev/quickstart) · [Why Turbine](https://turbineorm.dev/why-turbine) · [API Reference](https://turbineorm.dev/queries) · [Relations](https://turbineorm.dev/relations) · [AI Agents](https://turbineorm.dev/ai-agents) · [Benchmarks](https://turbineorm.dev/benchmarks) · [Errors](https://turbineorm.dev/errors)

**Contents:** [Why Turbine](#why-turbine) · [Benchmarks](#benchmarks) · [Quick Start](#quick-start) · [Queries](#queries) · [Built for agents](#built-for-agents) · [Safety tooling](#safety-tooling) · [Postgres features](#postgres-features) · [Serverless and edge](#serverless-and-edge) · [Database engines](#database-engines) · [From scratch, and forkable](#from-scratch-and-forkable) · [Comparison](#comparison) · [Limitations](#limitations) · [Requirements](#requirements) · [Contributing](#contributing)

## Why Turbine

Six reasons, each with the mechanism that makes it true:

1. **One dependency.** `dependencies` is `{ "pg": "^8.13.1" }`. No engine binary, no WASM compiler, no adapter packages in lockstep. The optional engines (SQLite, MySQL, SQL Server, PowDB) are peer dependencies or Node builtins you install only if you use them.
2. **Written from scratch.** Turbine is not a layer over Knex or a query-builder library. Query compilation is plain string building with an FNV-1a shape fingerprint into a bounded LRU of SQL templates, so there is no plan cache to size and no compiler running on your event loop.
3. **Nested relations in one statement.** A `with` clause compiles to correlated `json_agg` subqueries, so users with posts with comments is one round trip, typed end to end: `users[0].posts[0].comments[0].author.name` autocompletes with no annotation.
4. **Close to raw SQL.** In the last published run, Turbine's overhead over a hand-written `pg` control was 1.08x by geometric mean. The table is below; the losses are stated with the wins.
5. **Agents get typed tools, not a SQL prompt.** `npx turbine mcp` exposes eleven read-only MCP tools, including a relation graph and a join-path finder that returns the `with` clause to write. Every tool runs inside `BEGIN READ ONLY`, and PII-tagged columns are redacted before rows reach a model.
6. **The dangerous operations ask first.** Destructive migration statements refuse to run without typed consent. `update`/`delete` with an empty `where` throws. Columns tagged `pii: true` are excluded from the emitted SQL's projections. `turbine doctor` reports missing FK indexes offline, no account, no telemetry.

## Benchmarks

Measured **2026-08-15 against turbine-orm 0.71.0**, versus **Prisma 7.9.1** (`@prisma/adapter-pg`, `relationJoins` on) and **Drizzle 0.45.2** (relational queries), on local **PostgreSQL 17.9** over a Unix socket, with a hand-written `pg` control arm. Node v24.18.0, Apple Silicon (M5 Max). Same schema, same data (1K users, 10K posts, 50K comments), same pool config. Each figure is the median over 200 rounds with arm order rotated per round, taken as the median of three full runs.

| Scenario | Turbine 0.71 | Prisma 7.9 | Drizzle 0.45 | raw pg |
|---|---|---|---|---|
| findMany, 100 users (flat) | **0.181 ms** | 0.241 ms | 0.242 ms | 0.164 ms |
| findMany, 50 users + posts (L2) *(contested)* | **1.670 ms** | 4.302 ms | 1.711 ms | 1.847 ms |
| findMany, 10 users → posts → comments (L3) *(contested)* | **1.082 ms** | 4.204 ms | 1.166 ms | n/a |
| findUnique, single user by PK | **0.035 ms** | 0.078 ms | 0.080 ms | 0.036 ms |
| findUnique, user + posts + comments (L3) | **0.146 ms** | 0.374 ms | 0.285 ms | n/a |
| count, all users | **0.038 ms** | 0.070 ms | 0.053 ms | 0.041 ms |
| stream, iterate 50K rows (batch 1000) | 50.39 ms | 54.81 ms | **39.49 ms** | 42.33 ms |
| atomic increment, `view_count + 1` *(contested)* | **0.067 ms** | 0.106 ms | 0.073 ms | 0.055 ms |
| pipeline, 5-query batch | **0.165 ms** | 0.338 ms | 0.341 ms | 0.177 ms |
| hot findUnique, 500x same shape | **0.026 ms** | 0.059 ms | 0.069 ms | 0.030 ms |

What that run says:

- **Turbine ran at 1.08x hand-written `pg`**, where Drizzle ran at 1.47x and Prisma at 1.81x (geometric mean over the eight scenarios with a raw control). That 1.08x is the conservative reading: the raw L2 control statement still uses the `json_build_object` encoding Turbine has moved off, which is worth 1.83x on its own, so the figure the harness records unadjusted is 1.00x. The adjusted one is published instead.
- Across all ten scenarios Turbine was **2.02x faster than Prisma 7.9** and **1.46x faster than Drizzle 0.45** by geometric mean. Turbine took nine scenarios, Drizzle one, Prisma none. The one Drizzle took was streaming, and 0.72.0 takes it back (below).
- **Streaming was Drizzle's one win, by 22%** (39.49 ms vs 50.39 ms) on 0.71.0. **0.72.0 closes it**: the remaining gap was temporal decoding rather than the cursor, and a direct scan for the canonical ISO wire shape (declining anything else back to `pg`'s own parser) takes `findManyStream` from 52.44 ms to **37.06 ms** against Drizzle's 42.09 ms re-measured in the same rotation, and `findManyStreamBatches` to **31.65 ms**. Scope, because it matters: that is a targeted re-measurement of one scenario on a paired one-process harness, not a re-run of the ten above, so the table's stream row still shows 0.71.0 and the absolute values are not comparable. Method and controls in [`benchmarks/RESULTS-0.72.0.md`](benchmarks/RESULTS-0.72.0.md).
- **Pipelining is Turbine's clearest win**: one TCP flush for 5 queries runs 2.04x faster than Prisma and 2.07x faster than Drizzle, level with raw `pg`.
- Three scenarios (L2, L3, atomic increment) are marked *contested*: the contiguous cross-check harness disagrees with itself across runs of the same configuration there, so neither side claims them. Both nested reads were losses in the previous run and the improvement behind them reproduces on both harnesses; whether it is enough to pass Drizzle is what is unsettled.
- The sub-0.15 ms scenarios carry roughly one third uncertainty in their absolute values. Orderings held across runs; margins should not be quoted, and that includes L2's 2.5%.

Full method, the drift-floor measurement, and the harness-disagreement table: [`benchmarks/RESULTS-0.71.0.md`](https://github.com/zvndev/turbine-orm/blob/main/benchmarks/RESULTS-0.71.0.md).

Reproduce it: `cd benchmarks && npm install && npx prisma generate && DATABASE_URL=... npx tsx bench-interleaved.ts`

## Quick Start

```bash
npm install turbine-orm
npm install --save-dev tsx        # the CLI loads .ts config/schema files via tsx

npx turbine init --url postgres://user:pass@localhost:5432/mydb
npx turbine generate              # introspect the DB, emit a typed client
```

```typescript
import { turbine } from './generated/turbine';

const db = turbine({ connectionString: process.env.DATABASE_URL });

const users = await db.users.findMany({
  where: { role: 'admin' },
  orderBy: { createdAt: 'desc' },
  limit: 10,
});

await db.disconnect();
```

`generate` writes three files to `./generated/turbine/`: entity types, runtime schema metadata, and a typed client with a `turbine()` factory. The factory is generated (it is typed against your schema), so import it from your output directory, not from `'turbine-orm'`. ESM and CommonJS both work.

Full walkthrough, including the code-first `defineSchema` path for an empty database: [turbineorm.dev/quickstart](https://turbineorm.dev/quickstart).

## Queries

The API is Prisma-shaped: `findMany`, `findUnique`, `findFirst`, `create`, `update`, `delete`, `upsert`, plus `count`, `aggregate`, `groupBy`, and streaming. A tour of the parts worth knowing:

### Nested relations, one statement

```typescript
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
// users[0].posts[0].comments is typed, and this was one SQL statement
```

Per-relation `where`, `orderBy`, `limit`, `select`, and `omit` work at every depth. Many-to-many junction tables are auto-detected during `generate`, and self-referencing FKs give you parent and children relations. Relation filters (`some` / `every` / `none`) filter parents by their children.

Four load strategies produce identical rows: `join` (one statement), `batched` (one flat follow-up per relation), `flatten` (LEFT JOIN for eligible to-one relations), and `auto` (the default: the join plan, falling back to batched per relation when the correlation column has no covering index). A differential fuzz suite holds the strategies to byte-identical output. Details: [turbineorm.dev/relations](https://turbineorm.dev/relations).

### Writes, including atomic operators

```typescript
await db.users.create({ data: { email: 'a@b.com', name: 'Alice', orgId: 1 } });

await db.users.createMany({ data: [/* ... */] });   // one INSERT via UNNEST, not N inserts

await db.posts.update({
  where: { id: 1 },
  data: { viewCount: { increment: 1 } },  // col = col + $n, no read-modify-write race
});
```

Atomic operators: `increment`, `decrement`, `multiply`, `divide`, `set`. Nested writes (`create`, `connect`, `connectOrCreate`, `disconnect`, `set`, `delete`, `update`, `upsert` inside `data`) run in one transaction. `update` / `delete` with an empty `where` throws `ValidationError` rather than touching every row; see [privilege options](#the-unsafe-symbol) for the explicit opt-out.

### WHERE operators

Equality, `not`, `in` / `notIn`, `gt` / `gte` / `lt` / `lte`, `contains` / `startsWith` / `endsWith` (with `mode: 'insensitive'` for ILIKE), Postgres array operators (`has` / `hasEvery` / `hasSome`), JSON path filters, full-text `search`, pgvector `distance`, and `AND` / `OR` / `NOT` at any depth. LIKE wildcards in user input are escaped; every value is a bound parameter. The full table with examples: [turbineorm.dev/queries](https://turbineorm.dev/queries).

### Transactions

```typescript
await db.$transaction(async (tx) => {
  const user = await tx.users.create({ data: { email: 'new@example.com', name: 'New', orgId: 1 } });
  await tx.posts.create({ data: { userId: user.id, orgId: 1, title: 'First' } });
});
```

Nested `$transaction` calls become SAVEPOINTs. Isolation levels, timeouts, and `sessionContext` (transaction-local GUCs for Postgres RLS) are options. `tx` deliberately exposes a smaller surface than `db`; reaching for a client-only member is a compile error, not a production surprise. Reference: [turbineorm.dev/transactions](https://turbineorm.dev/transactions).

### Pipelining, at the protocol level

```typescript
const [user, postCount, recent] = await db.pipeline(
  db.users.buildFindUnique({ where: { id: 1 } }),
  db.posts.buildCount({ where: { orgId: 1 } }),
  db.posts.buildFindMany({ where: { userId: 1 }, limit: 5 }),
);
// 3 queries, 1 TCP flush
```

`db.pipeline(...)` uses the Postgres extended-query protocol (Parse/Bind/Execute/Sync) to send N queries in one flush. That is wire pipelining, not a batch transaction. Every query method has a `build*` twin returning `{ sql, params, transform }`, and the write builders batch too: `db.$transaction([...])` takes an array of built queries and runs them atomically.

### Raw SQL, still parameterized

```typescript
const users = await db.sql<{ id: number; name: string }>`
  SELECT id, name FROM users WHERE org_id = ${orgId}
`;                                     // every ${value} becomes $N, never concatenated

const one = await db.sql<{ id: number }>`SELECT id FROM users WHERE id = ${42}`.one();
```

`db.sql<T>` is the typed escape hatch (thenable, with `.one()` and `.scalar()`); `db.raw` is the untyped one. Neither has a code path that interpolates a value into SQL text.

### Streaming

```typescript
for await (const user of db.users.findManyStream({
  where: { orgId: 1 },
  orderBy: { id: 'asc' },
  with: { posts: true },
})) {
  process.stdout.write(`${user.email}\n`);
}
```

Backed by `DECLARE CURSOR` on a dedicated connection: constant memory at any row count, safe to `break` early, nested `with` per batch.

### Global filters

```typescript
const db = turbine({
  connectionString: process.env.DATABASE_URL,
  globalFilters: {
    posts: { deletedAt: null },                      // soft delete
    orders: () => ({ tenantId: currentTenant() }),   // per-request tenancy
  },
});
```

A global filter is a `WhereClause` that is AND-merged into every query on a table: reads, relation subqueries targeting it, and the predicates of `update` / `delete` / `upsert`. Values are parameterized. Details: [turbineorm.dev/global-filters](https://turbineorm.dev/global-filters).

### The UNSAFE symbol

Three options remove a safety boundary: `skipGlobalFilters`, `includePii`, and `allowFullTableScan`. Each accepts exactly one value, a symbol exported from the package:

```typescript
import { UNSAFE } from 'turbine-orm';

await db.sessions.deleteMany({ where: {}, allowFullTableScan: UNSAFE });
```

`true` throws. The reason is mass assignment: these options sit next to `where` on the same object, and a handler that spreads `req.body` into query args must not let a JSON payload disable tenancy or unlock PII. `JSON.parse` cannot produce a symbol, so there is no untrusted-data path to the privilege. Full rationale: [turbineorm.dev/global-filters](https://turbineorm.dev/global-filters#privilege-options-and-the-unsafe-symbol).

### Typed errors

```typescript
import { NotFoundError, UniqueConstraintError } from 'turbine-orm';

try {
  await db.users.findUniqueOrThrow({ where: { id: 999 } });
} catch (err) {
  if (err instanceof NotFoundError) { /* err.code === 'TURBINE_E001' */ }
}
```

Every error extends `TurbineError` with a stable code (`TURBINE_E001` through `E018`) and a `docsUrl`. Error messages carry keys, never values: a `NotFoundError` says `where: { id, email }` without printing the email, so errors are safe to forward to a tracker without a scrubbing rule. Retryable failures (`DeadlockError`, `SerializationFailureError`) expose `isRetryable: true` as a typed const. Full table: [turbineorm.dev/errors](https://turbineorm.dev/errors).

## Built for agents

An agent pointed at a database usually gets a connection string and guesses. Turbine gives it typed tools instead:

```bash
npx turbine mcp    # read-only MCP server over JSON-RPC stdio, ships in the package
```

Eleven tools, every one inside `BEGIN READ ONLY` with a statement timeout, so an agent cannot mutate anything through this server:

| Tool | What it answers |
|---|---|
| `schema_overview` | Tables, columns, relations, indexes, estimated row counts. |
| `table_detail` | One table, in full. |
| `relation_graph` | The whole relation graph, or one table's subtree, with cardinality, keys, and junction tables. |
| `find_join_path` | "How do I get from `comments` to `orgs`": the relation chain **and the `with` clause to write**. |
| `table_stats` | Planner row estimate, on-disk size, indexes. Reports `analyzed: false` instead of guessing `0`. |
| `explain_query` | `EXPLAIN` for a schema-validated `findMany` plan. No free-form SQL input exists. |
| `compile_query` | The exact SQL a read query would send, without running it: bound params, statement count, relation strategy, and whether it is bounded by a `LIMIT`. |
| `explain_error` | A Turbine error code, mapped to cause, fix, and docs link. |
| `sample_rows` | Up to 50 rows; PII-tagged columns are never fetched, and the reply lists what was hidden. |
| `migrate_status` | Applied vs pending migrations, without applying anything. |
| `doctor_report` | Missing relation indexes, from the same advisor `turbine doctor` uses. |

The rest of the agent story is structural: query args are fully typed, so a wrong query is a compile error the agent can read; errors carry stable codes it can branch on; and [llms.txt](https://turbineorm.dev/llms.txt) / [llms-full.txt](https://turbineorm.dev/llms-full.txt) give it the docs in fetchable form. Setup for Claude Code and Cursor, plus a drop-in instructions snippet: [turbineorm.dev/ai-agents](https://turbineorm.dev/ai-agents).

## Safety tooling

**`turbine doctor`: index advice, offline.** Turbine loads relations as correlated subqueries, so an unindexed FK becomes a scan per parent row. `doctor` derives every column set the relation queries probe, reports the ones with no covering index with a cost tier, and `--fix` writes the migration. It also detects cached-plan divergence: columns whose value distribution makes a named prepared statement's generic plan unsafe, verified with a plan-only `EXPLAIN`. No cloud service, no account.

**Destructive migrations need consent.** `migrate up`, `migrate down`, and `push` scan for `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, unqualified `DELETE` / `UPDATE`, and `ALTER COLUMN ... TYPE`, print an itemized report, and refuse. Interactively you type `destroy my data`, then `yes`; in CI you pass `--allow-destructive`. A refused batch applies nothing. Migrations are SQL files, checksummed with SHA-256, applied under `pg_try_advisory_lock()`.

**PII stays in the database.** Tag a column `pii: true` in the schema and it is excluded from every default projection at the SQL level: `RETURNING "id", "name"` instead of `RETURNING *`. It is also refused as a `groupBy` key and a `_min` / `_max` target. Reading it back takes `includePii: UNSAFE`, per query. A schema with no tagged column emits byte-identical SQL.

**Studio is read-only by default.** `npx turbine studio` binds loopback, authenticates with a per-process token, runs every read inside `BEGIN READ ONLY`, and has no raw-SQL surface: queries are composed in a builder validated identifier by identifier. Without `--write`, the write endpoints do not exist in the router. PII cells are redacted server-side. Try it with no database: `npx turbine-orm@latest studio --demo` boots a seeded in-memory sample. Docs: [turbineorm.dev/studio](https://turbineorm.dev/studio).

**Observability without an agent.** `db.$on('query')` taps every query with params redacted by default; `db.$observe()` flushes p50/p95/p99 aggregates per minute to a metrics table, and `npx turbine observe` is the dashboard. Docs: [turbineorm.dev/observability](https://turbineorm.dev/observability).

## Postgres features

Going deep on one database means the parts other ORMs push to raw SQL are typed surface here:

- **pgvector**: KNN ordering and distance filters, `orderBy: { embedding: { distance: { to, metric: 'cosine' } } }`, values bound as parameters. [Docs](https://turbineorm.dev/vector)
- **LISTEN/NOTIFY**: `db.$listen(channel, handler)` and `db.$notify(channel, payload)`. Your database is the message bus. [Docs](https://turbineorm.dev/realtime)
- **RLS session context**: `$transaction(fn, { sessionContext })` sets transaction-local GUCs so Row-Level Security policies filter for you. [Docs](https://turbineorm.dev/transactions)
- **Full-text search**: `where: { body: { search: 'postgres & orm' } }` compiles to `to_tsvector @@ to_tsquery`, parameterized. [Docs](https://turbineorm.dev/queries#full-text-search)
- **Read replicas** with a `$primary()` escape hatch ([docs](https://turbineorm.dev/read-replicas)), **views and generated columns** ([docs](https://turbineorm.dev/views)), **optimistic locking** ([docs](https://turbineorm.dev/optimistic-locking)), and **`explain()`** on every table accessor ([docs](https://turbineorm.dev/queries#explain))

## Serverless and edge

The core is driver-agnostic: hand any pg-compatible pool to `turbineHttp()` and Turbine runs on Vercel Edge, Cloudflare Workers, Deno Deploy, or anywhere else without TCP. The main entry's import graph is held under **85 kB brotli** (edge entry under **68 kB**) with `pg` external, enforced by `size-limit` in CI; run `npm run size` for the current figure.

```typescript
import { Pool } from '@neondatabase/serverless';
import { turbineHttp } from 'turbine-orm/serverless';
import { SCHEMA } from './generated/turbine/metadata';

const db = turbineHttp(new Pool({ connectionString: process.env.DATABASE_URL }), SCHEMA);
const users = await db.table('users').findMany({ with: { posts: true }, limit: 10 });
```

HTTP drivers cannot hold a cursor or a LISTEN connection, so `findManyStream` and `$listen` are unavailable there; everything else works. Walkthroughs for Neon, Vercel Postgres, Supabase, and Hyperdrive: [turbineorm.dev/serverless](https://turbineorm.dev/serverless).

## Database engines

Postgres is the default and primary target. The same typed API also runs on **SQLite** (Node's built-in `node:sqlite`, zero extra installs, Node ≥ 22.5), **MySQL 8** (`mysql2`), **SQL Server 2016+** (`mssql`), and **PowDB** (embedded or networked), each behind a subpath export with its driver as an optional peer:

```bash
npm install turbine-orm                        # SQLite needs nothing else
npm install turbine-orm mysql2                 # MySQL
npm install turbine-orm mssql                  # SQL Server
npm install turbine-orm @zvndev/powdb-embedded # PowDB, in-process
```

```typescript
import { turbineSqlite } from 'turbine-orm/sqlite';
import { SCHEMA } from './generated/turbine/metadata.js';

const db = turbineSqlite(':memory:', SCHEMA);
const users = await db.users.findMany({ with: { posts: true }, limit: 10 });
```

Single-statement nested `with` works on all four SQL engines (`json_agg`, `json_group_array`, `JSON_ARRAYAGG`, `FOR JSON PATH`). Postgres-only features (pgvector, LISTEN/NOTIFY, RLS `sessionContext`, true cursor streaming) throw a typed `UnsupportedFeatureError` (`TURBINE_E017`) elsewhere instead of degrading silently. The `turbine generate` / `migrate` CLI is Postgres-only. Full capability matrix and per-engine notes: [turbineorm.dev/engines](https://turbineorm.dev/engines).

**Migrating from Prisma?** `turbine migrate-from-prisma` reads your `schema.prisma` and emits a typed mapping; `turbine-orm/prisma-compat` then wraps a TurbineClient in a `PrismaClient`-shaped surface, so `prisma.user.findMany({ include })` keeps working while you port. [Guide](https://turbineorm.dev/migrate-from-prisma). Coming from Drizzle: [the mapping](https://turbineorm.dev/migrate-from-drizzle).

## From scratch, and forkable

Turbine is MIT and has no cloud tier, no paid gateway, and no telemetry. Everything named on this page is in the box.

It is also built to be extended rather than wrapped. All SQL generation routes through a documented `Dialect` contract (identifier quoting, placeholders, result strategy, capability flags, JSON aggregation hooks); the SQLite, MySQL, and SQL Server engines are implementations of that seam, not forks of the core. If you need an engine Turbine does not ship, the seam is where you start: [turbineorm.dev/dialects](https://turbineorm.dev/dialects).

## Comparison

| | **Turbine** | **Prisma** | **Drizzle** | **Kysely** |
|---|---|---|---|---|
| **Engine / runtime** | No engine binary (`pg` only) | Client + TS/WASM query compiler | No engine | No engine |
| **Runtime deps** | 1 (`pg`) | `@prisma/client` + required driver adapter | 0 | 0 |
| **Main bundle (brotli)** | under 85 kB import graph (CI-enforced), `pg` external | ~1.6 MB client (TS/WASM compiler) | ~7 KB core | small |
| **Studio** | Read-only by default | Full CRUD, cloud-hosted | Free; hosted Gateway paid | None |
| **Error PII safety** | Keys only by default | Values in messages | Raw pg errors | Raw pg errors |
| **Migrations** | SQL-first, SHA-256 checksums | DSL-generated, shadow DB | SQL or Drizzle Kit | None |
| **Edge runtime** | One import swap, under 68 kB brotli (CI-enforced) | Driver adapter + WASM compiler | Native | Native |
| **Pipeline batching** | Parse/Bind/Execute protocol | Sequential in txn | Sequential | Manual |
| **Typed errors** | `isRetryable` discriminant | Error codes only | None | None |
| **Nested relations** | 1 query, deep type inference | 1 query per relation by default; single-query `relationJoins` is Preview | 1 query, `relations()` re-declaration | Manual (`jsonArrayFrom`) |
| **Index advice** | `turbine doctor`, offline, `--fix` | Optimize retired March 2026 (cloud Query Insights) | None | None |
| **MCP server for agents** | 11 read-only tools, PII-redacted | Official MCP server | `drizzle-kit mcp` | None |
| **Vector search** | Built-in `distance` / KNN | Preview / raw | Extension API | Manual |
| **LISTEN/NOTIFY** | `$listen` / `$notify` | None | None | None |

Competitor columns last checked August 2026, against Prisma 7 and Drizzle 0.45. Features marked Preview may change; bundle sizes move release to release. The longer version of this argument, including what is not a reason to switch: [turbineorm.dev/why-turbine](https://turbineorm.dev/why-turbine).

## Limitations

Stated so you do not find out three weeks in:

- **Postgres-first.** The other engines are real and tested, but pgvector, LISTEN/NOTIFY, RLS `sessionContext`, full-text `search`, array filters, and `distinct` are Postgres-only and throw `UnsupportedFeatureError` elsewhere. The CLI (`generate`, `migrate`) is Postgres-only.
- **Only Postgres streams with a true cursor.** The other engines' `findManyStream` materializes the result first, then yields in batches: same rows, not constant memory.
- **Large nested result sets** are materialized in PostgreSQL memory. For relations with 10K+ rows, put a `limit` in the `with` clause, or stream parents and resolve children per batch.
- **It is younger** than Prisma or Drizzle: fewer Stack Overflow answers, a smaller community. The migration paths in both directions are real, which is the honest mitigation.

## Type mapping

| Postgres | TypeScript | Notes |
|---|---|---|
| `int2`, `int4`, `float4`, `float8` | `number` | |
| `int8` / `bigint` | `number` | Values above `Number.MAX_SAFE_INTEGER` come back as `string` to avoid precision loss |
| `numeric`, `money` | `string` | Arbitrary precision, kept exact |
| `text`, `varchar`, `uuid`, `citext` | `string` | |
| `timestamptz`, `timestamp`, `date` | `Date` | Zone-less columns read and write as UTC by default (`utcTimestamps`); the full temporal semantics, including `temporalInfinity`, are at [turbineorm.dev/schema](https://turbineorm.dev/schema#zone-less-columns-timestamp-and-date-read-as-utc) |
| `boolean` | `boolean` | |
| `json`, `jsonb` | `unknown` | |
| `bytea` | `Buffer` | |
| Array types | `T[]` | |

## Examples

- **[Thread Machine](https://github.com/zvndev/turbine-orm/tree/main/examples/thread-machine/)**: HN clone rendered from a single `findMany`, 4 levels deep, typed through the chain
- **[Streaming CSV](https://github.com/zvndev/turbine-orm/tree/main/examples/streaming-csv/)**: 100K orders to CSV with constant memory
- **[Clickstorm](https://github.com/zvndev/turbine-orm/tree/main/examples/clickstorm/)**: atomic increment vs read-modify-write under 10K concurrent clicks
- Runtime targets: [Next.js](https://github.com/zvndev/turbine-orm/tree/main/examples/nextjs/) · [Neon Edge](https://github.com/zvndev/turbine-orm/tree/main/examples/neon-edge/) · [Vercel Postgres](https://github.com/zvndev/turbine-orm/tree/main/examples/vercel-postgres/) · [Cloudflare Worker](https://github.com/zvndev/turbine-orm/tree/main/examples/cloudflare-worker/) · [Supabase](https://github.com/zvndev/turbine-orm/tree/main/examples/supabase/)

## Requirements

- Node.js ≥ 20 (the SQLite engine needs ≥ 22.5 for `node:sqlite`)
- PostgreSQL ≥ 14 tested; CI runs the integration suite against PostgreSQL 14, 15, 16, and 17
- ESM and CommonJS both supported

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](https://github.com/zvndev/turbine-orm/blob/main/CONTRIBUTING.md) for setup and the PR checklist; participants agree to the [Code of Conduct](https://github.com/zvndev/turbine-orm/blob/main/CODE_OF_CONDUCT.md). The unit suite runs without a database:

```bash
npm install
npm run test:unit
```

Per-release detail lives in the [CHANGELOG](https://github.com/zvndev/turbine-orm/blob/main/CHANGELOG.md) and at [turbineorm.dev/changelog](https://turbineorm.dev/changelog).

## License

MIT
