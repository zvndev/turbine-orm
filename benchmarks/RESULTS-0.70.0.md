# Four-way benchmark, turbine-orm 0.70.0 vs Prisma 7.9.1 vs Drizzle 0.45.2 vs Drizzle 1.0.0-rc.4

Measured 2026-08-15. This replaces `RESULTS-0.66.0.md` as the current
measurement; that file stays as the previous datum. It adds a fourth competitor
arm, Drizzle's 1.0 release candidate with its JIT-compiled row mapper enabled,
because that is the thing that will move these numbers when 1.0 lands and
publishing only against 0.45.2 at that point would look like version-shopping.

> **TL;DR.**
>
> Turbine 0.70.0 has **not regressed**. On the primary harness it is
> **1.85x faster than Prisma 7.9.1** and **1.37x faster than Drizzle 0.45.2** on
> a geometric mean over ten scenarios, and it runs at **1.08x hand-written
> `pg`** while Drizzle runs at 1.52x and Prisma at 1.85x. It wins 10/10 against
> Prisma and 7/10 against Drizzle.
>
> It still loses **L2, L3 and streaming**, and those losses are published below
> rather than averaged away. The `RESULTS-0.66.0.md` L2 gap did not close; it
> **widened again**, from 1.32x to 1.40x.
>
> The reason is now known rather than open. `PROFILE-0.70.0.md` locates the
> entire nested-read gap in the `json_build_object` wire encoding, not in row
> mapping and not in the query plan. **Turbine already ships the fix.** Re-run
> unchanged except for `jsonEncoding: 'positional'`, Turbine **wins L2 and L3**,
> goes **9/10 against Drizzle**, and its geometric mean improves to **1.03x**.
> That configuration is measured here as its own full three-run suite.
>
> The RC arm is not a threat on nine of ten scenarios, and is a real one on the
> tenth: it drains 50K rows in **32.2 ms against raw node-postgres' 42.5 ms**,
> i.e. faster than the driver it is built on, because 1.0 replaces pg's type
> parsers with its own codecs.

## Setup

Deliberately identical to the 0.66.0 and 0.50.0 runs so the three are
comparable.

- **Database:** local PostgreSQL 17.9 (Homebrew), Unix-socket connection at
  `/tmp/.s.PGSQL.5432`, no network hop, dedicated freshly seeded
  `turbine_bench_070`. A container was again deliberately not used: Docker on
  macOS routes through a VM and a forwarded TCP port, which adds a latency floor
  and would not be comparable to the recorded runs.
- **Client:** Apple Silicon MacBook Pro, macOS (Darwin 25.5.0), Node v24.18.0.
  Client and database are the same host.
- **Data:** 5 orgs, 1,000 users, 10,000 posts, 50,000 comments, the
  deterministic `seed-neon.ts` fixture at its defaults, `ANALYZE`d after load.
  Counts verified before any number was recorded.
- **Versions measured:** turbine-orm **0.70.0** (working tree, `file:..`,
  `npm run build` output) / `@prisma/client` **7.9.1** / `@prisma/adapter-pg`
  **7.9.1** / `prisma` **7.9.1** / `drizzle-orm` **0.45.2** / `drizzle-orm`
  **1.0.0-rc.4** (the `rc` dist-tag) / `pg` **8.22.0**.
- **Competitor version check, 2026-08-15.** Prisma **has moved**, 7.9.0 → 7.9.1,
  and the arm was bumped. Drizzle's `latest` is **still 0.45.2**, unchanged since
  the 0.50.0 run, so benchmarking against it remains legitimate; its `rc` tag is
  1.0.0-rc.4. `pg` has moved 8.22.0 → 8.23.0 and was **deliberately not bumped**:
  it is the raw control and it also underlies the Prisma, Drizzle and Turbine
  arms, so changing it would move all five arms at once and break comparability
  with the recorded runs for no gain.
- **Runs:** interleaved harness 200 rounds + 20 warmup per arm per scenario
  (streaming: 9 rounds + 1 warmup, each draining 50K rows), **three full runs**
  per configuration, medians of medians. Contiguous harness (`bench.ts`) one full
  run as a cross-check.

### Arms are verified before they are timed

`verify-arms.ts` runs first and refuses the benchmark unless every arm is doing
the same work. It exists because two arms failed it:

1. **The RC arm silently ran without its JIT mapper and against the wrong
   connection.** Drizzle 1.0 does not accept `drizzle(pool, config)`. That
   positional form destructures `client`/`connection` off the POOL object, finds
   neither, constructs a brand-new default `pg.Pool`, and **discards the config
   entirely**, so `relations` and `jit` are both dropped and no error is raised.
   The supported 1.0 spelling is `drizzle({ client: pool, ... })`. JIT engagement
   is now asserted by identity against the library's own exported
   `makeJitRqbMapper` in the harness itself, on every RC run, because `jit: true`
   also falls back silently through `jitCompatCheck`.

2. **The RC streaming arm looked too good to be true and had to be cleared.** It
   measured 32 ms against raw `pg`'s 42 ms, which is the exact shape of a loop
   that terminates early. It is real: all four streaming arms are asserted to
   drain exactly 50,000 rows, project the same 5 columns, and decode `createdAt`
   to a `Date`.

Row-for-row equivalence of all five read arms is checked on the flat, L2 and L3
shapes, and the RC's JIT and non-JIT mappers are checked against each other.

## Results, primary (interleaved) harness

Median wall-clock ms per operation, median of three full runs. Lower is better.
Bold is the fastest ORM. The raw column is hand-written `pg`.

| Scenario | Turbine 0.70 | Prisma 7.9.1 | Drizzle 0.45 | raw pg |
|---|---|---|---|---|
| findMany, 100 users (flat) | **0.153 ms** | 0.207 ms | 0.210 ms | 0.130 ms |
| findMany, 50 users + posts (L2) | 2.011 ms | 3.744 ms | **1.437 ms** | 1.584 ms |
| findMany, 10 users to posts to comments (L3) | 1.210 ms | 3.539 ms | **1.040 ms** | n/a |
| findUnique, single user by PK | **0.030 ms** | 0.068 ms | 0.074 ms | 0.031 ms |
| findUnique, user + posts + comments (L3) | **0.172 ms** | 0.364 ms | 0.290 ms | n/a |
| count, all users | **0.039 ms** | 0.070 ms | 0.054 ms | 0.041 ms |
| stream, iterate 50K comments (batch 1000) | 51.227 ms | 54.449 ms | **39.336 ms** | 41.184 ms |
| atomic increment, posts.view_count + 1 | **0.062 ms** | 0.101 ms | 0.069 ms | 0.052 ms |
| pipeline, 5-query dashboard batch | **0.166 ms** | 0.338 ms | 0.337 ms | 0.172 ms |
| hot findUnique, rotating IDs | **0.026 ms** | 0.057 ms | 0.070 ms | 0.029 ms |

Geometric means over the ten scenarios:

| | ratio to the fastest ORM per scenario |
|---|---|
| Turbine 0.70.0 | **1.078x** |
| Drizzle 0.45.2 | 1.471x |
| Prisma 7.9.1 | 1.999x |

Overhead above hand-written `pg`, geometric mean over the eight scenarios that
have a raw control: **Turbine 1.076x**, Drizzle 1.515x, Prisma 1.853x.

Head-to-head, scenarios won: Turbine beats Prisma **10/10** and Drizzle
**7/10**. Drizzle beats Prisma 7/10.

## What Turbine loses, stated plainly

Three scenarios, and all three are the same three as 0.66.0.

| | Turbine | best | ratio | 0.66.0 ratio |
|---|---|---|---|---|
| L2 | 2.011 ms | Drizzle 1.437 ms | **1.40x** | 1.32x |
| L3 | 1.210 ms | Drizzle 1.040 ms | **1.16x** | 1.17x |
| stream 50K | 51.227 ms | Drizzle 39.336 ms | **1.30x** | 1.32x |

**The L2 gap widened again**, 1.32x → 1.40x, continuing the trend
`RESULTS-0.66.0.md` flagged and could not explain. L3 and streaming are flat.

Absolute values are **lower across every arm** than the 0.66.0 run, including
raw `pg` (flat 0.164 → 0.130 ms, L2 raw 1.779 → 1.584 ms). The machine is
simply faster today than on 2026-08-09. **Absolute numbers must not be compared
across the two dates; only ratios within a run are meaningful.** That is also
why the L2 widening is quoted as a ratio.

## The cause of the nested losses, and the configuration that removes them

`PROFILE-0.70.0.md` is the full workup. The short version, because it changes
what should be done about the table above:

- The nested gap is **not row mapping**, which was the prior going in. Turbine's
  parse costs 0.369 ms on L2 against Drizzle's 0.664 ms. Turbine's mapper is
  **faster**.
- It is **not the query plan**. `LEFT JOIN LATERAL` was measured directly
  against the correlated subquery with the encoding held constant: 0.685 ms vs
  0.697 ms, inside noise, same plan shape.
- It is the **JSON wire encoding**. `json_build_object` repeats every key on
  every row; `json_build_array` does not. Server time 0.685 ms → 0.350 ms, a
  1.96x reduction, and 152 KB → 100 KB on the wire.

Turbine ships that encoding as `jsonEncoding: 'positional'`. Re-running the
identical three-run protocol, four arms, changing only that one client option:

| Scenario | Turbine, positional | Prisma 7.9.1 | Drizzle 0.45 | raw pg |
|---|---|---|---|---|
| findMany, 100 users (flat) | **0.170 ms** | 0.234 ms | 0.229 ms | 0.146 ms |
| findMany, 50 users + posts (L2) | **1.572 ms** | 4.072 ms | 1.643 ms | 1.755 ms |
| findMany, 10 users to posts to comments (L3) | **0.917 ms** | 3.567 ms | 1.030 ms | n/a |
| findUnique, single user by PK | **0.032 ms** | 0.071 ms | 0.074 ms | 0.032 ms |
| findUnique, user + posts + comments (L3) | **0.143 ms** | 0.366 ms | 0.289 ms | n/a |
| count, all users | **0.040 ms** | 0.070 ms | 0.054 ms | 0.042 ms |
| stream, iterate 50K comments (batch 1000) | 52.270 ms | 55.935 ms | **39.157 ms** | 42.698 ms |
| atomic increment, posts.view_count + 1 | **0.073 ms** | 0.120 ms | 0.079 ms | 0.058 ms |
| pipeline, 5-query dashboard batch | **0.191 ms** | 0.398 ms | 0.380 ms | 0.192 ms |
| hot findUnique, rotating IDs | **0.030 ms** | 0.065 ms | 0.073 ms | 0.032 ms |

| | ratio to the fastest ORM |
|---|---|
| Turbine 0.70.0, positional | **1.029x** |
| Drizzle 0.45.2 | 1.487x |
| Prisma 7.9.1 | 2.073x |

Overhead above raw `pg`: **Turbine 1.049x**, Drizzle 1.500x, Prisma 1.888x.
Head-to-head against Drizzle: **9/10**, losing only streaming.

L2 goes from a 1.40x loss to a **1.05x win**; L3 from a 1.16x loss to a **1.12x
win**. Rows returned are byte-identical to the default encoding, verified by
`JSON.stringify` equality.

**This is reported as a measurement, not as the headline.** The default in
0.70.0 is object encoding, so the first table is what a user gets today and is
the one that should be quoted. Whether the default should change is a decision
for the owner of `src/`, and it carries real risk that a benchmark cannot
settle: positional is a separate decode path, is documented Postgres-only, and
gates off the `flatten` strategy entirely.

## The Drizzle 1.0 release candidate

Run as a five-arm suite, three runs. **Arm counts are not mixed across suites**:
adding a fifth arm puts one more competitor's working set between every other
arm's consecutive calls, and that is measurable, not cosmetic (see "Why a fifth
arm needs its own suite" below). The four-arm numbers above and the five-arm
numbers here are each internally consistent and must not be compared
cell-for-cell.

| Scenario | Turbine 0.70 | Prisma 7.9.1 | Drizzle 0.45 | **Drizzle 1.0-rc.4 (jit)** | raw pg |
|---|---|---|---|---|---|
| findMany, 100 users (flat) | **0.173 ms** | 0.233 ms | 0.234 ms | 0.193 ms | 0.144 ms |
| findMany, 50 users + posts (L2) | 2.211 ms | 3.962 ms | **1.621 ms** | 1.764 ms | 1.676 ms |
| findMany, 10 users to posts to comments (L3) | 1.143 ms | 3.306 ms | **0.995 ms** | 1.112 ms | n/a |
| findUnique, single user by PK | **0.037 ms** | 0.081 ms | 0.080 ms | 0.091 ms | 0.035 ms |
| findUnique, user + posts + comments (L3) | **0.193 ms** | 0.405 ms | 0.317 ms | 0.364 ms | n/a |
| count, all users | **0.043 ms** | 0.078 ms | 0.058 ms | 0.065 ms | 0.044 ms |
| stream, iterate 50K comments (batch 1000) | 52.572 ms | 57.202 ms | 41.767 ms | **32.235 ms** | 42.478 ms |
| atomic increment, posts.view_count + 1 | **0.071 ms** | 0.116 ms | 0.077 ms | 0.073 ms | 0.057 ms |
| pipeline, 5-query dashboard batch | 0.194 ms | 0.394 ms | 0.370 ms | 0.417 ms | **0.192 ms** |
| hot findUnique, rotating IDs | **0.032 ms** | 0.070 ms | 0.078 ms | 0.086 ms | 0.033 ms |

| | ratio to the fastest ORM |
|---|---|
| Turbine 0.70.0 | **1.098x** |
| Drizzle 0.45.2 | 1.448x |
| Drizzle 1.0.0-rc.4 (jit) | 1.491x |
| Prisma 7.9.1 | 2.020x |

**The JIT row mapper is not, on this suite, a general win.** The RC is *slower*
than the shipping 0.45.2 on eight of ten scenarios, including both nested reads
it was expected to help, and its geometric mean is marginally worse (1.491x vs
1.448x). Turbine beats it **7/10**. That should be read with the caution it
deserves: this is a release candidate, the RQB v2 relational path is a rewrite,
and pre-release performance is not a promise about 1.0.

**The one place it is a genuine threat is streaming**, and it is a large one:
32.235 ms against Drizzle 0.45's 41.767 ms and against raw node-postgres'
42.478 ms. Beating the driver it is built on is only possible because 1.0
replaces pg's type parsers with its own codecs layer, and `PROFILE-0.70.0.md`
independently found that pg's `postgres-date` parser plus `utf8Slice` account
for ~51% of active JS self-time in the streaming path. Those two findings agree.
**When 1.0 ships, streaming is the scenario to re-measure first**, and Turbine's
streaming gap should be expected to look worse against 1.0 than against 0.45.

## Where the two harnesses disagree

`RESULTS-0.66.0.md` recorded two disagreements between the interleaved and
contiguous harnesses. There is now **one**.

| Scenario | interleaved (primary) | contiguous (`bench.ts`) |
|---|---|---|
| atomic increment | Turbine 0.062 vs Drizzle 0.069 | Drizzle fastest, Turbine 1.27x |

Atomic increment is therefore reported as **unestablished**, not as a win, for
the third release running.

**L2 no longer disagrees.** In 0.66.0 the contiguous harness called it for
Turbine while the interleaved harness called it for Drizzle; both now agree that
Drizzle wins it (contiguous: Turbine 3.06 ms vs Drizzle 1.69 ms). The
contested-scenario count went down because a contested scenario resolved into a
**loss**, which is worth saying explicitly rather than presenting as an
improvement in agreement.

The other eight scenarios agree on the winner across both harnesses.

## Why a fifth arm needs its own suite

Adding an arm is not free for the other arms. Every arm runs once per round, so
each additional arm puts one more working set between an arm's consecutive
calls. While profiling, the identical Turbine L2 query measured **1.28 ms** when
the only other arms were its own phases and **2.34 ms** when two Drizzle arms
rotated between its calls. That is cache eviction, not noise, and it is why the
default suite is still exactly the four arms 0.50.0 and 0.66.0 measured, and the
RC is run separately. Within either suite every arm is on equal footing, which
is the point of interleaving; it is only *across* suites that absolute values
must not be mixed.

## Drift floor

Read this before quoting any sub-millisecond figure. The `SELECT 1` probe was
run at the head, middle and tail of every suite.

| suite | run 1 spread | run 2 spread | run 3 spread |
|---|---|---|---|
| four-arm | 75.8% | 84.4% | 113.4% |
| four-arm, positional | 40.4% | 36.3% | 35.5% |
| five-arm with RC | 43.1% | 21.9% | **353.3%** |

Most of the spread is between the head probe and the rest, i.e. process warmup,
as in previous runs. The exception is the third five-arm run, where the **middle**
probe spiked to 0.0645 ms against a 0.0168 ms head. That is a genuine
mid-process disturbance, and it is exactly what the median-of-three-runs
protocol exists to absorb; it is disclosed rather than dropped.

The multi-millisecond scenarios (L2, L3, stream) are stable and their orderings
are trustworthy. **The sub-0.15 ms scenarios (findUnique, count, atomic
increment, pipeline, hot findUnique) carry roughly one third uncertainty in
their absolute values. Their orderings held across all three runs, but their
MARGINS are not quotable.** In particular, "Turbine is 2.7x faster than Drizzle
on hot findUnique" is not a supportable claim at 0.026 ms against a drift floor
of 0.012–0.024 ms.

## Reproducing

```bash
createdb turbine_bench_070
cd benchmarks
DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" npx tsx seed-neon.ts
DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" npx prisma generate
# from the repo root, regenerate the Turbine client against the same database
DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" npx tsx src/cli/index.ts generate --out generated/turbine

# arms must verify before anything is timed
DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" npx tsx verify-arms.ts

# primary four-arm suite, run three times
DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" npx tsx bench-interleaved.ts
# the same suite with the positional wire encoding
DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" TURBINE_JSON=positional npx tsx bench-interleaved.ts
# five-arm suite including drizzle 1.0.0-rc.4 with jit
DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" INCLUDE_RC=1 npx tsx bench-interleaved.ts
# contiguous cross-check
DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" npx tsx bench.ts

# medians of medians across the three runs of a configuration
npx tsx aggregate-runs.ts run1.log run2.log run3.log
```
