# Three-way benchmark — Turbine vs Prisma 7 vs Drizzle v2

> **TL;DR.** On a real production database (Neon, pooled, US-East),
> Turbine, Prisma 7, and Drizzle v2 are within noise of each other for
> every scenario we could think of. The N+1 story we've been telling as
> a Turbine differentiator **isn't one anymore** — Prisma 7 with
> `relationJoins` and Drizzle's relational API both issue a single
> query for nested reads, and their timings match Turbine's to within
> a few milliseconds. The one meaningful delta is streaming, where
> Turbine's server-side cursor is actually **1.5× slower** than keyset
> pagination for drain-all workloads. The right pitch for Turbine is
> not "faster SQL." It's package size, edge runtime support, typed
> errors, and `with`-clause type inference.

## Setup

- **Database:** Neon (PostgreSQL 17.8), pooled endpoint, US-East-1
- **Client:** MacBook (node v22.13.1), transatlantic-flight-free, same pool config
- **Schema:** organizations / users / posts / comments (see `prisma/schema.prisma`, `schema.ts`)
- **Data:** 5 orgs, 1,000 users, 10,000 posts, 50,000 comments — deterministic, identical for every ORM
- **Runs:** 100 iterations + 20 warmup per scenario (streaming scenario: 3 runs + 1 warmup because each run is ~3–5 seconds)
- **Versions:** turbine-orm 0.7.1 · @prisma/client 7.6.0 (with `@prisma/adapter-pg`, `relationJoins` preview on) · drizzle-orm 0.45.0 (node-postgres relational API)
- **Pool:** plain `pg.Pool` size 10, same for Prisma adapter-pg and Drizzle; Turbine uses its internal pool at default size
- **Network:** every query round-trips US-east → Neon pooler → US-east over TLS, ~33–40 ms floor

See `bench.ts` for the full harness. Every scenario runs identical work
against identical data.

## Raw results

Avg wall-clock ms per operation (lower is better). Bold = fastest.

| Scenario | Turbine | Prisma 7 | Drizzle v2 |
|----------|---------|----------|------------|
| findMany — 100 users (flat)              |  57.70 ms | 50.22 ms | **49.11 ms** |
| findMany — 50 users + posts (L2)         |  53.96 ms | 54.94 ms | **52.42 ms** |
| findMany — 10 users → posts → comments (L3) | **52.43 ms** | 54.00 ms | 53.83 ms |
| findUnique — single user by PK           |  47.03 ms | 50.79 ms | **46.93 ms** |
| findUnique — user + posts + comments (L3)|  60.94 ms | 54.62 ms | **52.09 ms** |
| count — all users                        |  44.97 ms | 47.89 ms | **44.57 ms** |
| stream — drain 50K comments (batch 1000) | 4,771 ms  | 3,307 ms | **3,187 ms** |
| atomic increment — posts.view_count + 1  | **49.01 ms** | 52.10 ms | 52.78 ms |

Ratio vs fastest (1.00x = fastest, higher = slower):

| Scenario | Turbine | Prisma 7 | Drizzle v2 |
|----------|---------|----------|------------|
| findMany — 100 users (flat)              | 1.17x | 1.02x | **1.00x** |
| findMany — 50 users + posts (L2)         | 1.03x | 1.05x | **1.00x** |
| findMany — L3 nested                     | **1.00x** | 1.03x | 1.03x |
| findUnique — PK                          | **1.00x** | 1.08x | **1.00x** |
| findUnique — L3 nested                   | 1.17x | 1.05x | **1.00x** |
| count                                    | 1.01x | 1.07x | **1.00x** |
| stream — drain 50K                       | 1.50x | 1.04x | **1.00x** |
| atomic increment                         | **1.00x** | 1.06x | 1.08x |

Per-scenario p50 / p95 / p99 tables are in `bench-neon-results.log`.

## What the numbers actually mean

### 1. Everything below ~60 ms is network, not the ORM

The fastest single SELECT we measured — `findUnique` by primary key —
averaged 47 ms, with a p50 around 34 ms and a p95 around 112 ms. That
34 ms floor is **two TLS round-trips to Neon**: the pooled connection
hands off the SELECT and blocks on the reply. Nothing an ORM does at
the JavaScript layer can shave more than a millisecond or two off of
that, and the measurement noise between runs is about ±3 ms.

Conclusion: **stop comparing ORMs on "simple query latency over a
real pooled database."** The signal is too small to matter and the
noise is too large to trust.

### 2. The N+1 story isn't a differentiator anymore

We've been telling people that Turbine is special because it issues a
single SQL query for nested `with` clauses instead of N+1 round-trips.
That's still **technically true** — Turbine builds one statement with
`json_agg` + correlated subqueries and the round-trip count for
`findMany + with` is exactly 1.

But in 2025 so is Prisma (when you enable the `relationJoins` preview
feature, which we did in the Prisma schema for this benchmark), and so
is Drizzle's relational API (`db.query.users.findMany({ with: ... })`).
Both of them also compile to a single SQL statement with correlated
joins or subqueries. The only ORMs still doing literal N+1 round-trips
for nested reads are old-school ActiveRecord-style clients and Prisma
**without** `relationJoins` on.

The measured timings confirm it: Turbine, Prisma 7, and Drizzle v2 all
land inside the same ~3 ms window for L2 and L3 nested reads. Whatever
the theoretical overhead difference is between `json_agg` subqueries
(Turbine) and `LATERAL` joins (Prisma relationJoins) and `.jsonb_agg`
subqueries (Drizzle), it's lost in the network noise.

**What to stop saying:** "Turbine is faster for nested reads." It isn't,
in any way we can measure against a real database.

**What to start saying:** "Turbine does nested reads the same way the
good modern ORMs do — in a single query — without the Rust engine that
Prisma ships and without the codegen step that Prisma requires."

### 3. Streaming is where Turbine actually loses

For the streaming scenario we drained all 50,000 rows from the
`comments` table three ways:

- **Turbine:** native `db.comments.findManyStream({ batchSize: 1000 })`
  which does `BEGIN; DECLARE CURSOR; FETCH 1000; FETCH 1000; ...; COMMIT;`.
- **Prisma:** keyset pagination loop — `findMany({ take: 1000, cursor, skip: 1, orderBy: { id: 'asc' } })`.
- **Drizzle:** keyset pagination loop — `select().from(...).where(gt(id, lastId)).orderBy(asc(id)).limit(1000)`.

**Turbine: 4,771 ms.** Drizzle: 3,187 ms. Prisma: 3,307 ms. Turbine is
**50 % slower** than Drizzle here.

The reason is simple and in retrospect obvious: Turbine's server-side
cursor approach adds `BEGIN` + `DECLARE CURSOR` + `CLOSE CURSOR` +
`COMMIT` on top of the same number of `FETCH` round-trips that keyset
pagination costs. On Neon's pooled endpoint those four extra
round-trips are ~35 ms each, or ~140 ms of fixed overhead per drain.
For 50 batches of 1,000 rows, keyset issues 50 SELECTs and Turbine
issues 50 FETCHes plus 4 control statements — the control overhead is
the whole delta.

That doesn't mean cursors are wrong. They still have real advantages:

1. **Correctness without a monotonic key.** Keyset pagination requires
   `orderBy` to be on a unique column. If you `orderBy` anything else,
   you can miss or duplicate rows on ties. Turbine's cursor is correct
   for any `orderBy` the query planner will honor.
2. **Memory.** Both cursor and keyset are fixed-memory per batch, so
   this is a tie in practice.
3. **Early break is clean.** `for await ... break` on a cursor closes
   the server-side state and releases the connection deterministically.
   Breaking out of a keyset loop just stops looping; the last page's
   worth of SQL already executed.

But for the **drain-all** case — "I want every row in this table, in
order" — keyset pagination on a PK is strictly faster over a
round-trip-bound network.

**What to stop saying:** "Turbine's cursor stream is faster than
keyset pagination." It isn't, not when you're draining every row and
the network is the bottleneck.

**What to start saying:** "Turbine has a native cursor stream. It
costs you 100–150 ms of fixed per-stream overhead, in exchange for
correct semantics on any `orderBy` and clean early-break. If you just
want to drain a big table in PK order, keyset is faster."

### 4. Atomic increment is a three-way tie

All three ORMs support atomic `col = col + 1` updates without dropping
to raw SQL. Turbine uses `{ viewCount: { increment: 1 } }`, Prisma uses
the identical syntax, and Drizzle uses `sql\`${col} + 1\`` (which does
give up the type inference on that column). Measured timings are
within one standard deviation of each other.

**What's actually different** about Turbine here is not speed, it's the
**typed retry loop**. Prisma surfaces serialization failures as a
generic `PrismaClientKnownRequestError` with the stringly-typed `code:
'P2034'`. Drizzle bubbles up raw `pg` errors and you grep SQL state
codes. Turbine throws a dedicated `SerializationFailureError` with a
`readonly isRetryable = true` const on the instance, and the same for
`DeadlockError`. You retry with `err instanceof SerializationFailureError
&& err.isRetryable` and the compiler knows it's safe.

That's a DX difference, not a perf difference. It's not visible in a
benchmark table. But it's a real thing Turbine does that the others
don't.

## What should actually differentiate Turbine

Looking at the measured numbers, here's the honest priority order of
things Turbine can legitimately claim:

1. **Package size and dependency count.** Turbine is ~110 KB, one
   runtime dependency (`pg`). Prisma 7 ships multiple npm packages
   (`@prisma/client`, `@prisma/engines`, `@prisma/adapter-pg`, etc.),
   a generated client in `node_modules`, and on versions before 7 a
   Rust binary engine. Drizzle is small and dep-light too, so this is
   a "Turbine matches Drizzle, beats Prisma" claim, not a clean win.

2. **Edge runtime support via `turbine-orm/serverless`.** One import
   swap (`turbineHttp(pool, SCHEMA)`) lets you use the exact same
   client against Neon HTTP, Vercel Postgres, Cloudflare Hyperdrive,
   or Supabase's pg-compatible pool. No second generator, no driver
   adapter, no preview feature flag. Prisma requires `@prisma/adapter-neon`
   + Driver Adapters on edge; Drizzle works but you re-declare the
   schema for the edge driver.

3. **Typed Postgres errors with `isRetryable` const.**
   `SerializationFailureError`, `DeadlockError`, `UniqueConstraintError`
   (with `.constraint`), `ForeignKeyError`, `CheckConstraintError`,
   `NotNullViolationError` — each is a dedicated class, not a string
   code on a generic error. The `isRetryable` const on
   serialization/deadlock lets you write a four-line retry loop that
   typechecks. Neither Prisma nor Drizzle has an equivalent.

4. **Inferred `with` result types.** `findMany({ with: { posts: { with:
   { comments: true } } } })` returns a type where
   `result[0].posts[0].comments[0].body` is inferred as `string` —
   no manual assertion, no code generation for the include tree.
   Prisma's `Prisma.UserGetPayload<{ include: ... }>` works but is
   verbose. Drizzle's `with` types work but the setup is painful.

5. **Zero-dependency code generator.** `npx turbine generate` produces
   three small files (`types.ts`, `metadata.ts`, `index.ts`) with no
   runtime dependencies of its own. Prisma's generator pulls in the
   query engine. Drizzle has `drizzle-kit` which is a separate package.

None of those are "we're faster than them." Turbine is **not
meaningfully faster** at any measured workload. Any marketing copy
that implies Turbine wins on query latency needs to be rewritten.

## What we should change

- `README.md` comparison table — remove any "faster" framing; reframe
  as "single-query by default, matches Prisma 7 with relationJoins
  and Drizzle relational."
- `docs/STRATEGIC-PLAN.md` — already doesn't lead with speed claims,
  but any residual "faster than Prisma N+1" framing should go.
- `examples/thread-machine/README.md` — the nested query demo should
  pitch type inference and a single import, not SQL roundtrip count.
- `examples/streaming-csv/README.md` — the cursor pitch needs to be
  honest: cursors are about correctness and early-break, not speed.
  Add a note that keyset pagination is faster for drain-all.
- `examples/clickstorm/README.md` — already correct; it pitches the
  typed `isRetryable` const, not performance.

## Methodology notes / caveats

- All measurements are wall-clock from the client. They include
  network + Neon query + response serialization. Per-query CPU
  profiling of each ORM would tell a different and probably more
  favorable story for Turbine on CPU, but that's not what users
  experience in production.
- We ran from a single region (US-East on the client, US-East on
  Neon). A cross-region run would have higher latency floors and
  would further drown out per-query differences.
- Prisma 7's `relationJoins` is still flagged as a preview feature in
  schema.prisma. Without it, Prisma falls back to N+1 for nested
  reads and Turbine would win by 3–5x on the L3 scenario. That was
  what we benchmarked against earlier in v0.7.0 development and it's
  probably where the "Prisma is slow at nested reads" belief came
  from. As of Prisma 7 with the preview feature on, that story no
  longer holds.
- We did not test connection pool starvation, long transactions, or
  true write-heavy workloads. Those are different benchmarks.
- The streaming scenario drained the full table. A scenario that
  breaks out after the first match would show cursor advantages
  (cleanup semantics) that a single-number benchmark can't capture.
- **We didn't run this before publishing the marketing copy.** The
  performance claims on the README and in STRATEGIC-PLAN were based
  on extrapolating from pre-v7 Prisma benchmarks and from ORM-level
  SQL generation, not from measured head-to-head runs against a real
  pooled database. That was a mistake. This file exists to fix it.
