# Three-way benchmark, turbine-orm 0.66.0 vs Prisma 7.9 vs Drizzle 0.45

Measured 2026-08-09, immediately before tagging 0.66.0. This file does not
replace `RESULTS-0.50.0.md`; it is a fresh measurement taken because the numbers
quoted in the README and on the site were measured on 2026-07-25 against 0.50.0,
sixteen releases back.

> **TL;DR.** Turbine 0.66.0 has not regressed **against the code we shipped**.
> A direct interleaved A/B of 0.65.0 against 0.66.0 on the same database in the
> same process finds 0.66.0 equal or marginally faster on every shape measured,
> which is the question that gates this release. On a geometric mean over the
> ten three-way scenarios it is **1.82x faster than Prisma 7.9** and **1.32x
> faster than Drizzle 0.45**, and it runs at **1.09x hand-written `pg`** while
> Drizzle runs at 1.49x and Prisma at 1.86x.
>
> Two things changed since the 0.50.0 write-up and both are stated plainly
> below: the **L2 nested-relation gap to Drizzle widened** (published 1.21x, now
> 1.32x on the primary harness), and the **two harnesses now disagree on two
> scenarios** where the 0.50.0 run said they disagreed on one. Neither is caused
> by 0.66.0, and neither is hidden here.

## The release question, answered directly

The three-way numbers cannot separate "our code changed" from "the machine,
PostgreSQL, or the competitors changed", because the 0.50.0 run happened on a
different day. So the release gate was measured as its own experiment: both
builds loaded into ONE process, pointed at the SAME database, run once per round
each with the arm order rotated per round, 200 rounds after 20 warmup.

0.65.0 is the published release, built from the `v0.65.0` tag with its own
`npm install` and `npm run build`. 0.66.0 is the working tree.

| Shape | 0.65.0 | 0.66.0 | delta |
|---|---|---|---|
| L2, 50 users + posts | 2.507 ms | 2.460 ms | -1.9% |
| L3, 10 users to posts to comments | 1.192 ms | 1.169 ms | -2.0% |
| findMany, 100 users flat | 0.142 ms | 0.141 ms | -0.7% |
| findUnique by PK | 0.024 ms | 0.024 ms | 0.0% |

Nothing here is outside noise in the direction that matters, and nothing is
slower. This was worth measuring rather than assuming, because 0.66.0 changes
the query hot path in two ways that could plausibly have cost something:

- **`select` projections and write `data` are now canonically ordered** on every
  build, to close the caller-controlled-key-order prepared-statement channel.
  Measured separately, build-only, 20,000 compiles of the L2 query after 3,000
  warmup: 0.65.0 **5.97 us/op**, 0.66.0 **5.60 us/op**, emitting byte-identical
  SQL. The canonicalization did not cost build time. (It is also ~5.6 us against
  a 2.4 ms query, so the builder was never going to be the explanation.)
- **More statements are sent UNNAMED.** node-postgres skips `Parse` only for a
  statement already parsed BY NAME, so an unnamed statement is re-parsed on
  every execution. This was the specific regression risk, and it did not appear:
  `hot findUnique` measures **0.029 ms against a 0.033 ms raw `pg` control**,
  i.e. below the control, and `pipeline` measures 0.183 ms against 0.194 ms raw.

## Setup

Deliberately identical to the 0.50.0 run so the two are comparable.

- **Database:** local PostgreSQL 17.9 (Homebrew), Unix-socket connection at
  `/tmp/.s.PGSQL.5432`, no network hop, dedicated freshly seeded
  `turbine_bench_066` database. A container was again deliberately not used:
  Docker on macOS routes through a VM and a forwarded TCP port, which adds a
  latency floor and would not be comparable to the recorded runs.
- **Client:** Apple Silicon MacBook Pro (Apple M5 Max), macOS 26.5.1, Node
  v24.18.0. Client and database are the same host.
- **Data:** 5 orgs, 1,000 users, 10,000 posts, 50,000 comments, the
  deterministic `seed-neon.ts` fixture at its defaults, `ANALYZE`d after load.
  Counts verified before any number was recorded.
- **Versions measured:** turbine-orm **0.66.0** (working tree, `file:..`,
  `npm run build` output) / `@prisma/client` **7.9.0** / `@prisma/adapter-pg`
  **7.9.0** / `prisma` **7.9.0** / `drizzle-orm` **0.45.2** / `pg` **8.22.0**.
  The competitor versions are unchanged from the 0.50.0 run, which is what makes
  the two comparable; they are not necessarily the current latest today, and
  that should be re-checked before these numbers are quoted in marketing.
- **Runs:** interleaved harness 200 rounds + 20 warmup per arm per scenario
  (streaming: 9 rounds + 1 warmup, each draining 50K rows), **three full runs**,
  medians of medians. Contiguous harness (`bench.ts`) one full run as a
  cross-check.

## Results, primary (interleaved) harness

Median wall-clock ms per operation, median of three full runs. Lower is better.
Bold is the fastest ORM. The raw column is hand-written `pg`.

| Scenario | Turbine 0.66 | Prisma 7.9 | Drizzle 0.45 | raw pg |
|---|---|---|---|---|
| findMany, 100 users (flat) | **0.189 ms** | 0.254 ms | 0.248 ms | 0.164 ms |
| findMany, 50 users + posts (L2) | 2.379 ms | 4.289 ms | **1.804 ms** | 1.779 ms |
| findMany, 10 users to posts to comments (L3) | 1.436 ms | 3.990 ms | **1.223 ms** | n/a |
| findUnique, single user by PK | **0.038 ms** | 0.083 ms | 0.085 ms | 0.037 ms |
| findUnique, user + posts + comments (L3) | **0.197 ms** | 0.397 ms | 0.303 ms | n/a |
| count, all users | **0.043 ms** | 0.076 ms | 0.058 ms | 0.044 ms |
| stream, iterate 50K comments (batch 1000) | 54.013 ms | 57.925 ms | **40.810 ms** | 42.773 ms |
| atomic increment, posts.view_count + 1 | **0.073 ms** | 0.114 ms | 0.079 ms | 0.060 ms |
| pipeline, 5-query dashboard batch | **0.183 ms** | 0.386 ms | 0.366 ms | 0.194 ms |
| hot findUnique, rotating IDs | **0.029 ms** | 0.064 ms | 0.073 ms | 0.033 ms |

Geometric means over the ten scenarios:

| | ratio to the fastest ORM per scenario |
|---|---|
| Turbine 0.66.0 | **1.07x** |
| Drizzle 0.45 | 1.42x |
| Prisma 7.9 | 1.96x |

Overhead above hand-written `pg`, geometric mean over the eight scenarios that
have a raw control: **Turbine 1.09x**, Drizzle 1.49x, Prisma 1.86x.

## What got worse, and it is not 0.66.0

**The L2 gap to Drizzle widened: published 1.21x, now 1.32x.** The absolute
Turbine number barely moved (0.50.0 published 2.421 ms, now 2.379 ms). What
moved is everything else: the raw `pg` control went 1.953 to 1.779 ms (-9%) and
Drizzle went 2.001 to 1.804 ms (-10%), while Turbine improved 1.7%. So Turbine
did not get slower; it failed to pick up an environmental gain the other two
arms did. The 0.65.0-vs-0.66.0 A/B above rules this release out as the cause,
which leaves either drift between 2026-07-25 and today, or something in the
sixteen releases between 0.50.0 and 0.65.0. **This is an open question, not a
resolved one.** It is worth a bisect before the next set of marketing numbers is
quoted, and it should not be described as a win in the meantime.

L3 moved the same way and for what is probably the same reason (published 1.03x,
now 1.17x).

## Where the two harnesses disagree

The 0.50.0 write-up recorded that both harnesses agreed on every winner except
atomic increment. That is no longer true: they now disagree on **two**
scenarios.

| Scenario | interleaved (primary) | contiguous (`bench.ts`) |
|---|---|---|
| findMany L2 | Drizzle 1.804 vs Turbine 2.379 | **Turbine 1.34 vs Drizzle 2.03** |
| atomic increment | Turbine 0.073 vs Drizzle 0.079 | Drizzle fastest, Turbine 1.50x |

Both are reported as **unestablished**, not as wins. The interleaved harness is
treated as primary because it runs every arm once per round and rotates the arm
order, so drift over the life of the process is shared rather than attributed to
whichever arm happened to occupy that slice of wall clock; the contiguous
harness measures each ORM in one block and is exactly the design that lets drift
masquerade as a result. Where they disagree, the honest answer is that the
scenario is close enough that measurement design decides it.

The other eight scenarios agree on the winner across both harnesses.

## Drift floor

Read this before quoting any sub-millisecond figure. The `SELECT 1` probe run at
the head, middle and tail of each suite measured 0.0266 / 0.0107 / 0.0105 ms, a
**153.8% spread**, essentially all of it between the head probe and the rest
(process warmup). The multi-millisecond scenarios (L2, L3, stream) are stable
and their orderings are trustworthy. The sub-0.15 ms scenarios (findUnique,
count, atomic increment, pipeline, hot findUnique) carry roughly one third
uncertainty in their absolute values, and their orderings held across all three
runs but their MARGINS should not be quoted.

## Reproducing

```bash
createdb turbine_bench_066
cd benchmarks
DATABASE_URL="postgresql:///turbine_bench_066?host=/tmp" npx tsx seed-neon.ts
DATABASE_URL="postgresql:///turbine_bench_066?host=/tmp" npx prisma generate
# from the repo root, regenerate the Turbine client against the same database
DATABASE_URL="postgresql:///turbine_bench_066?host=/tmp" npx tsx src/cli/index.ts generate --out generated/turbine

# primary harness, run three times
DATABASE_URL="postgresql:///turbine_bench_066?host=/tmp" npx tsx bench-interleaved.ts
# cross-check
DATABASE_URL="postgresql:///turbine_bench_066?host=/tmp" npx tsx bench.ts
```
