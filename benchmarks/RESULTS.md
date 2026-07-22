# Three-way benchmark: Turbine vs Prisma 7 vs Drizzle 0.45

> **TL;DR.** Measured 2026-07-14 on a **local PostgreSQL 17.9** database over a
> Unix socket (no network hop). With the network removed, every query is
> sub-millisecond and the gap between ORMs is per-query overhead, not noise.
> Turbine wins 6 of 10 scenarios (flat reads, findUnique by PK and nested,
> count, pipeline, and the hot path), Drizzle wins 3 (L2 nested, streaming,
> atomic increment), and L3 nested is a Turbine/Drizzle near-tie that flips
> between runs. Prisma trails on every scenario here because its per-query
> work is no longer masked by network latency. This is a different regime
> from the earlier pooled-Neon table and is not directly comparable to it.

## Setup

- **Database:** local PostgreSQL 17.9 (Homebrew), Unix-socket connection, no network hop
- **Client:** Apple Silicon MacBook Pro (Apple M5 Max), macOS, Node v24.18.0
- **Schema:** organizations / users / posts / comments (see `prisma/schema.prisma`, `schema.ts`)
- **Data:** 5 orgs, 1,000 users, 10,000 posts, 50,000 comments, deterministic and identical for every ORM
- **Runs:** 200 iterations + 20 warmup per scenario (streaming scenario: 3 runs + 1 warmup because each run drains 50K rows). Two full runs; the table below is from the first, and the shape held on the second.
- **Versions:** turbine-orm 0.32.0 (working tree) · @prisma/client 7.6.0 and @prisma/adapter-pg 7.6.0 (`relationJoins` preview on) · drizzle-orm 0.45.2 (node-postgres relational API) · pg 8.20.0
- **Measured:** 2026-07-14. Reproduce with `cd benchmarks && npm install && npx prisma generate && DATABASE_URL=… npx tsx bench.ts`.
- **Pool:** plain `pg.Pool` size 10, same for the Prisma adapter-pg and Drizzle; Turbine uses its internal pool at default size
- **Network:** none. Client and database are the same host over a local socket, so there is no round-trip floor.

See `bench.ts` for the full harness. Every scenario runs identical work against identical data.

> **Why this looks nothing like the previous table.** The prior run measured
> against a pooled **Neon** database in another region, where a ~35 ms network
> round-trip dominated every query and compressed all three ORMs into the noise
> floor (most single-query deltas were within ~3 ms of each other). This run
> removes the network entirely. Absolute latencies drop by roughly two orders
> of magnitude and the per-query overhead that Neon hid becomes the whole
> signal. Both regimes are honest; they answer different questions. Do not
> compare the two tables cell for cell.

## Raw results, 2026-07-14 (local socket)

Average wall-clock ms per operation (lower is better). Bold = fastest.

| Scenario | Turbine | Prisma 7 | Drizzle 0.45 |
|----------|---------|----------|--------------|
| findMany, 100 users (flat)                  | **0.22 ms** | 0.53 ms | 0.34 ms |
| findMany, 50 users + posts (L2)             | 2.41 ms | 4.63 ms | **1.82 ms** |
| findMany, 10 users → posts → comments (L3)  | 1.13 ms | 3.69 ms | **1.01 ms** |
| findUnique, single user by PK               | **0.06 ms** | 0.11 ms | 0.09 ms |
| findUnique, user + posts + comments (L3)    | **0.18 ms** | 0.43 ms | 0.30 ms |
| count, all users                            | **0.06 ms** | 0.08 ms | 0.07 ms |
| stream, iterate 50K comments (batch 1000)   | 58.6 ms | 69.7 ms | **48.9 ms** |
| atomic increment, posts.view_count + 1      | 0.13 ms | 0.23 ms | **0.11 ms** |
| pipeline, 5-query dashboard batch           | **0.20 ms** | 0.61 ms | 0.58 ms |
| hot findUnique, 500x same shape             | **0.05 ms** | 0.09 ms | 0.10 ms |

Ratio vs fastest (1.00x = fastest, higher = slower):

| Scenario | Turbine | Prisma 7 | Drizzle 0.45 |
|----------|---------|----------|--------------|
| findMany, 100 users (flat)                  | **1.00x** | 2.41x | 1.54x |
| findMany, 50 users + posts (L2)             | 1.32x | 2.54x | **1.00x** |
| findMany, L3 nested                         | 1.12x | 3.67x | **1.00x** |
| findUnique, PK                              | **1.00x** | 1.72x | 1.44x |
| findUnique, L3 nested                       | **1.00x** | 2.44x | 1.71x |
| count                                       | **1.00x** | 1.51x | 1.21x |
| stream, iterate 50K                         | 1.20x | 1.43x | **1.00x** |
| atomic increment                            | 1.15x | 2.05x | **1.00x** |
| pipeline, 5-query batch                     | **1.00x** | 3.07x | 2.91x |
| hot findUnique, 500x                        | **1.00x** | 2.08x | 2.20x |

## Full distribution (avg / p50 / p95 / p99, ms)

| Scenario | Turbine | Prisma 7 | Drizzle 0.45 |
|----------|---------|----------|--------------|
| findMany, flat        | 0.22 / 0.21 / 0.29 / 0.35 | 0.53 / 0.47 / 0.92 / 1.79 | 0.34 / 0.29 / 0.56 / 0.70 |
| findMany, L2          | 2.41 / 2.45 / 2.71 / 2.92 | 4.63 / 4.70 / 5.00 / 5.09 | 1.82 / 1.83 / 2.08 / 2.25 |
| findMany, L3          | 1.13 / 1.14 / 1.30 / 1.43 | 3.69 / 3.75 / 4.06 / 4.73 | 1.01 / 1.00 / 1.28 / 1.62 |
| findUnique, PK        | 0.06 / 0.06 / 0.09 / 0.12 | 0.11 / 0.11 / 0.16 / 0.25 | 0.09 / 0.09 / 0.14 / 0.21 |
| findUnique, L3        | 0.18 / 0.16 / 0.27 / 0.47 | 0.43 / 0.39 / 0.62 / 1.06 | 0.30 / 0.29 / 0.34 / 0.57 |
| count                 | 0.06 / 0.05 / 0.07 / 0.22 | 0.08 / 0.08 / 0.11 / 0.14 | 0.07 / 0.06 / 0.10 / 0.13 |
| stream, 50K           | 58.6 / 57.4 / 62.9 / 62.9 | 69.7 / 68.9 / 72.2 / 72.2 | 48.9 / 48.7 / 49.8 / 49.8 |
| atomic increment      | 0.13 / 0.12 / 0.16 / 0.21 | 0.23 / 0.20 / 0.39 / 0.51 | 0.11 / 0.10 / 0.19 / 0.23 |
| pipeline              | 0.20 / 0.17 / 0.37 / 0.61 | 0.61 / 0.54 / 1.03 / 1.42 | 0.58 / 0.52 / 0.86 / 1.65 |
| hot findUnique        | 0.05 (mean of 500)        | 0.09 (mean of 500)        | 0.10 (mean of 500)        |

(The hot-path scenario reports a single mean over a 500-call loop, so it has no percentile spread.)

## What the numbers actually mean

### 1. On a local socket, the ORM layer is the whole story

The previous Neon run made the point that everything below ~60 ms was network,
not the ORM. This run makes the opposite point on purpose. With the network
removed, the fastest single SELECT (`findUnique` by PK) runs in ~0.06 ms, and
the difference between ORMs is now the difference in their JavaScript per-query
work. That is why Turbine's SQL template cache and prepared statements, and
Prisma's engine-less-client overhead, both show up clearly here where Neon
buried them under a ~35 ms round-trip.

**Conclusion.** A socket-local benchmark measures which layer is leanest. A
pooled-remote benchmark measures whether that leanness matters over a real
network (usually only a little). Read both, and read them separately.

### 2. Turbine leads the simple and repeated-shape reads

Flat `findMany`, `findUnique` (PK and nested), `count`, and the hot
500x-same-shape loop all go to Turbine. Shape-keyed SQL template caching lets a
repeated query skip SQL generation entirely, and prepared statements let
Postgres reuse the execution plan. On the hot path Turbine runs at ~22,000
ops/sec versus ~10,000 for both Prisma and Drizzle.

### 3. Drizzle leads nested reads, streaming, and atomic increment

Drizzle's relational query builder is fastest on L2 (50 users + posts, 1.82 ms
vs Turbine's 2.41 ms) and edges L3 in this run. Its keyset-pagination drain of
50K comments is fastest at ~49 ms, and its tagged-`sql` atomic increment is
fastest at ~0.11 ms. Turbine's `json_agg` nesting sits just behind Drizzle and
comfortably ahead of Prisma (1.9x to 3.3x) on the same shapes. L3 is a genuine
near-tie: Drizzle edged it in the first run (1.01 vs 1.13 ms), Turbine in the
second (1.05 vs 1.34 ms).

Turbine's cursor still has advantages a single number does not show:

1. **Correctness without a monotonic key.** Keyset requires `orderBy` on a
   unique column. Cursors work with any `orderBy`.
2. **Clean early break.** `for await ... break` closes server-side state and
   releases the connection deterministically.
3. **Nested `with` inside the stream.** Cursor batches support full `with`
   clause resolution per batch.

### 4. Pipeline batching is Turbine's clearest win

The 5-query dashboard batch runs in ~0.20 ms on Turbine versus ~0.61 ms
(Prisma) and ~0.58 ms (Drizzle), about 3x faster. Turbine sends all five
queries in a single TCP flush using the Postgres extended-query pipeline
protocol; Prisma's `$transaction([])` and Drizzle's `db.transaction()` both run
their queries sequentially, waiting for each reply before sending the next. On
a local socket that serialization cost is small in absolute terms but still 3x
the single-flush path, and on a high-latency connection it grows with every
round-trip.

### 5. Atomic increment: typed retry, not raw speed

All three ORMs issue a single `col = col + 1` UPDATE. Drizzle is fastest here by
a couple hundredths of a millisecond. What differs about Turbine is not speed,
it is the **typed retry loop**: `SerializationFailureError` and `DeadlockError`
carry a `readonly isRetryable = true` const, so you retry with
`err instanceof SerializationFailureError && err.isRetryable` and the compiler
knows it is safe. Prisma surfaces `P2034` as a stringly-typed code; Drizzle
bubbles raw `pg` errors. That is a DX difference, not a benchmark line.

## Caveats

- **These are socket-local numbers.** They isolate per-query overhead and
  deliberately exclude the network that usually dominates production latency.
  For a networked, pooled database the deltas here shrink toward the noise floor.
- **All measurements are wall-clock from the client** over a local socket,
  including query execution and result serialization.
- **Single machine.** Client and database are the same host; there is no
  round-trip and no pooler hop.
- **Prisma 7's `relationJoins` is a preview feature.** Without it, Prisma falls
  back to N+1 and would lose the nested scenarios by a much wider margin.
- **We did not test connection pool starvation, long transactions, or true
  write-heavy workloads.** Those are different benchmarks.
- **The streaming scenario drains the full table.** A scenario that breaks out
  after the first match would show cursor cleanup advantages a single number
  cannot capture.
- **Run-to-run variance is a few tenths of a millisecond** on the sub-ms
  scenarios. Winners were stable across two full runs except L3, which flipped
  between Turbine and Drizzle and should be read as a tie.

## Raw results, 2026-07-21 (local socket)

> **TL;DR.** Same local-socket regime as 2026-07-14, measured against the newest
> competitor releases (Prisma 7.9.0, up from 7.6.0; Drizzle unchanged at 0.45.2;
> pg 8.22.0). Turbine holds stable wins on flat reads, findUnique by PK and L3
> nested, pipeline, and the hot path. Drizzle holds L2 nested. Four scenarios
> (L3 nested, count, streaming, atomic increment) flipped winners between the two
> runs and are reported as near-ties. Prisma 7.9 improved noticeably on flat reads
> (0.53 to 0.37 ms) and pipeline (0.61 to 0.45 ms) but still trails everywhere.

- **Database:** local PostgreSQL 17.9 (Homebrew), Unix-socket connection, dedicated freshly seeded database
- **Client:** Apple Silicon MacBook Pro (Apple M5 Max), macOS, Node v24.18.0
- **Data:** 5 orgs, 1,000 users, 10,000 posts, 50,000 comments, deterministic (same fixture as prior runs)
- **Runs:** 200 iterations + 20 warmup per scenario (streaming: 3 + 1). Two full runs; the table is from the first, and the winner flips between runs are called out as near-ties rather than leads.
- **Versions:** turbine-orm 0.39.0 (working tree) · @prisma/client 7.9.0 and @prisma/adapter-pg 7.9.0 · prisma 7.9.0 · drizzle-orm 0.45.2 · pg 8.22.0
- **Measured:** 2026-07-21.

| Scenario | Turbine | Prisma 7.9 | Drizzle 0.45 |
|----------|---------|----------|--------------|
| findMany, 100 users (flat)                  | **0.29 ms** | 0.37 ms | 0.39 ms |
| findMany, 50 users + posts (L2)             | 2.86 ms | 4.64 ms | **2.39 ms** |
| findMany, 10 users -> posts -> comments (L3), near-tie | 1.55 ms | 4.04 ms | **1.32 ms** |
| findUnique, single user by PK               | **0.06 ms** | 0.12 ms | 0.10 ms |
| findUnique, user + posts + comments (L3)    | **0.18 ms** | 0.45 ms | 0.31 ms |
| count, all users, near-tie                  | **0.05 ms** | 0.08 ms | 0.06 ms |
| stream, iterate 50K comments (batch 1000), near-tie | **60.7 ms** | 68.8 ms | 65.8 ms |
| atomic increment, posts.view_count + 1, near-tie | **0.14 ms** | 0.19 ms | 0.19 ms |
| pipeline, 5-query dashboard batch           | **0.20 ms** | 0.45 ms | 0.41 ms |
| hot findUnique, 500x same shape             | **0.03 ms** | 0.06 ms | 0.08 ms |

Near-tie scenarios flipped winners between the two runs (run 2: Drizzle took count
0.07 vs 0.10, streaming 58.3 vs 70.5, and increment 0.09 vs 0.15; Turbine took L3
0.90 vs 1.36). Treat those four as within noise on this host. Versus 2026-07-14,
Prisma 7.9 improved flat reads by roughly 30% and pipeline by roughly 26% over
Prisma 7.6; Drizzle's streaming number was slower this session in both runs.
