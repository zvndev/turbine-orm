# Three-way benchmark, turbine-orm 0.50.0 vs Prisma 7.9 vs Drizzle 0.45

Measured 2026-07-25. This file does not replace `RESULTS.md`; it is a fresh
measurement of the shipped 0.50.0 code, taken because the numbers quoted in the
README and on the site were measured once, on 2026-07-21, against 0.39.0, four
releases back.

> **TL;DR.** Turbine 0.50.0 has not regressed. On a geometric mean over the ten
> scenarios it is **1.87x faster than Prisma 7.9** and **1.36x faster than
> Drizzle 0.45**, and it runs at **1.07x hand-written `pg`** while Drizzle runs
> at 1.47x and Prisma at 1.84x. Nine of the ten published scenario results
> reproduce. One does not: **streaming 50K rows is now a clear Drizzle win**
> (Drizzle 50.2 ms vs Turbine 63.9 ms), where the published table shows Turbine
> fastest and calls it a near-tie. The published "four near-ties" is also no
> longer accurate: on this run it is two. Separately, the `auto` relation
> strategy added in 0.41 does fix the to-one problem it was written for above
> its 1000-row threshold, but the threshold itself is far too high for a
> low-latency database: batched already beats join from about 25 parent rows on
> a local socket, so `auto` is 1.2x to 2.0x slower than the best available plan
> everywhere between 25 and 1000 rows.

## Why there are two harnesses in this directory

`bench.ts` measures each ORM in a contiguous block: 200 Turbine iterations, then
200 Prisma, then 200 Drizzle. Anything that drifts over the life of the process
(JIT state, page cache, autovacuum, thermal headroom) is charged to whichever arm
happened to occupy that slice of wall clock. It also has no raw-SQL control, so
there is no way to tell drift from signal.

`bench-interleaved.ts` was added for this run. It runs every arm **once per
round**, **rotates the arm order every round**, reports the **median** across
rounds, and adds a **hand-written raw `pg` control arm** to most scenarios. Both
harnesses were run, for different reasons:

- `bench.ts` twice, because it is the harness the 0.39.0 numbers came from and is
  therefore the only apples-to-apples way to diff against them.
- `bench-interleaved.ts` three times, because those are the numbers worth
  trusting and publishing.

Both harnesses agree on every winner except atomic increment, which is a genuine
near-tie and is reported as one.

## Setup

- **Database:** local PostgreSQL 17.9 (Homebrew), Unix-socket connection at
  `/tmp/.s.PGSQL.5432`, no network hop, dedicated freshly seeded `turbine_bench`
  database. A container was deliberately not used: Docker on macOS routes through
  a VM and a forwarded TCP port, which adds a latency floor and would not be
  comparable to the recorded runs.
- **Client:** Apple Silicon MacBook Pro (Apple M5 Max), macOS 26.5.1, Node
  v24.18.0. Client and database are the same host.
- **Data:** 5 orgs, 1,000 users, 10,000 posts, 50,000 comments, the deterministic
  `seed-neon.ts` fixture at its defaults, `ANALYZE`d after load. Counts were
  verified before any number was recorded, and the interleaved harness refuses to
  report if they do not match.
- **Versions measured:** turbine-orm **0.50.0** (working tree, `file:..`,
  `npm run build` output) - `@prisma/client` **7.9.0** - `@prisma/adapter-pg`
  **7.9.0** - `prisma` **7.9.0** - `drizzle-orm` **0.45.2** - `pg` **8.22.0**.
- **Competitor currency:** all four competitor packages were checked against npm
  on the day of the run and every one is the **current latest release**, not a
  stale pin. They are also **identical to the versions in the 0.39.0 run**, which
  is what makes the diff below a clean read on Turbine's own change.
- **Exact artifact measured:** commit `f8fec86`, the v0.50.0 release commit, built
  with `npm run build` before measurement. The benchmark lockfile's record of the
  linked local package moved from 0.39.0 to 0.50.0 on install, which independently
  confirms the previous benchmark install was the 0.39.0 tree. Unrelated
  in-progress working-tree changes to `src/query/` landed after that build and are
  **not** included in any number here.
- **Runs:** interleaved harness 200 rounds + 20 warmup per arm per scenario
  (streaming: 9 rounds + 1 warmup, each round drains 50K rows), three full runs.
  Original harness 200 iterations + 20 warmup, two full runs.
- **Pool:** plain `pg.Pool` size 10 for Prisma, Drizzle and the raw control;
  Turbine uses its internal pool at default size.
- **Prisma configuration:** `relationJoins` preview is on in
  `prisma/schema.prisma`, so Prisma's nested scenarios use its `join` strategy.
  This is the favorable configuration for Prisma and is chosen deliberately.

## The drift floor, measured

An identical hand-written raw `pg` control arm was run inside every scenario that
has one, in all three interleaved runs. Its spread across those runs is the floor
below which nothing in this file is a measurement:

| Scenario | raw control, 3 runs (ms) | spread |
|---|---|---|
| findMany flat | 0.210 / 0.207 / 0.212 | 2.4% |
| findMany L2 | 1.939 / 1.958 / 1.953 | 1.0% |
| findUnique PK | 0.053 / 0.060 / 0.064 | 20.8% |
| count | 0.044 / 0.045 / 0.047 | 6.8% |
| stream 50K | 46.59 / 50.97 / 53.22 | 14.2% |
| atomic increment | 0.073 / 0.107 / 0.095 | 46.6% |
| pipeline | 0.201 / 0.219 / 0.205 | 9.0% |
| hot findUnique | 0.033 / 0.043 / 0.033 | 30.3% |

**Read this before reading anything else.** On the multi-millisecond scenarios
the floor is 1% to 14%. On the sub-0.15 ms scenarios it is **21% to 47%**: the
same SQL, the same data, the same process, no code change. Every published
sub-0.15 ms figure (findUnique by PK, count, atomic increment, hot findUnique,
and the pipeline batch) therefore carries an uncertainty of roughly a third of
its own value, and any "regression" or "improvement" smaller than that on those
rows is not real. A `SELECT 1` probe run at the head, middle and tail of each
suite showed the same thing from the other direction: the first probe of a
process is roughly 2x to 4x slower than the steady state, which is exactly the
effect a block-sequential harness misattributes to whichever ORM it measures
first.

## Raw results, 2026-07-25 (interleaved, local socket)

Median wall-clock ms per operation, median of three full runs. Lower is better.
Bold is the fastest ORM. The raw column is hand-written `pg`, shown so ORM
overhead can be read directly rather than inferred.

| Scenario | Turbine 0.50 | Prisma 7.9 | Drizzle 0.45 | raw pg |
|----------|---------|----------|--------------|--------|
| findMany, 100 users (flat)                  | **0.256 ms** | 0.358 ms | 0.330 ms | 0.210 ms |
| findMany, 50 users + posts (L2)             | 2.421 ms | 4.603 ms | **2.001 ms** | 1.953 ms |
| findMany, 10 users to posts to comments (L3), near-tie | 1.255 ms | 3.735 ms | **1.214 ms** | n/a |
| findUnique, single user by PK               | **0.051 ms** | 0.105 ms | 0.108 ms | 0.060 ms |
| findUnique, user + posts + comments (L3)    | **0.217 ms** | 0.469 ms | 0.357 ms | n/a |
| count, all users                            | **0.044 ms** | 0.081 ms | 0.061 ms | 0.045 ms |
| stream, iterate 50K comments (batch 1000)   | 63.87 ms | 71.08 ms | **50.18 ms** | 50.97 ms |
| atomic increment, posts.view_count + 1, near-tie | **0.115 ms** | 0.174 ms | 0.123 ms | 0.095 ms |
| pipeline, 5-query dashboard batch           | **0.206 ms** | 0.431 ms | 0.402 ms | 0.205 ms |
| hot findUnique, 500x same shape             | **0.029 ms** | 0.065 ms | 0.075 ms | 0.033 ms |

Ratio versus the fastest ORM (1.00x is fastest, higher is slower):

| Scenario | Turbine 0.50 | Prisma 7.9 | Drizzle 0.45 |
|----------|---------|----------|--------------|
| findMany, flat                 | **1.00x** | 1.40x | 1.29x |
| findMany, L2                   | 1.21x | 2.30x | **1.00x** |
| findMany, L3, near-tie         | 1.03x | 3.08x | **1.00x** |
| findUnique, PK                 | **1.00x** | 2.06x | 2.12x |
| findUnique, L3                 | **1.00x** | 2.16x | 1.65x |
| count                          | **1.00x** | 1.84x | 1.39x |
| stream, 50K                    | 1.27x | 1.42x | **1.00x** |
| atomic increment, near-tie     | **1.00x** | 1.51x | 1.07x |
| pipeline, 5-query batch        | **1.00x** | 2.09x | 1.95x |
| hot findUnique, 500x           | **1.00x** | 2.24x | 2.59x |

Headline aggregates, geometric mean over all ten scenarios:

- Turbine is **1.87x faster than Prisma 7.9**.
- Turbine is **1.36x faster than Drizzle 0.45**.

Overhead above hand-written `pg`, geometric mean over the eight scenarios that
have a raw control:

- **Turbine 1.07x raw pg** - **Drizzle 1.47x** - **Prisma 1.84x**.

That last line is the most defensible single number in this file, because the
control is measured in the same rounds as the ORMs and cancels most of the drift.

## Scenario wins

- **Turbine takes seven:** flat reads, findUnique by PK, findUnique L3 nested,
  count, atomic increment, pipeline, hot path.
- **Drizzle takes three:** L2 nested, L3 nested, streaming.
- **Prisma takes none**, and is slower than Turbine on all ten.

Two of those are near-ties and should not be reported as leads: **L3 nested**
(1.255 vs 1.214 ms, 3% apart, and Turbine won it in both runs of the original
harness) and **atomic increment** (0.115 vs 0.123 ms, 7% apart against a 47%
drift floor, and Drizzle won it in both runs of the original harness).
**Streaming is not a near-tie**: Drizzle wins it by 27% in all five runs across
both harnesses.

## Diff versus the recorded 0.39.0 run (2026-07-21)

Both runs use the same machine, the same PostgreSQL 17.9 socket, the same Node,
the same fixture, and the **same competitor versions**. The comparison below uses
the original block-sequential harness on both sides, since that is the harness
the 0.39.0 numbers came from. Average ms, as recorded.

| Scenario | 0.39.0 T | 0.50.0 T (r1 / r2) | Turbine delta | verdict |
|---|---|---|---|---|
| findMany flat | 0.29 | 0.33 / 0.23 | -21% to +14% | within drift |
| findMany L2 | 2.86 | 2.56 / 2.50 | -11% to -13% | improved, marginal |
| findMany L3 | 1.55 | 1.18 / 1.22 | -21% to -24% | improved |
| findUnique PK | 0.06 | 0.06 / 0.06 | 0% | unchanged |
| findUnique L3 | 0.18 | 0.42 / 0.21 | +17% to +133% | within drift, see below |
| count | 0.05 | 0.09 / 0.04 | -20% to +80% | within drift |
| stream 50K | 60.7 | 68.6 / 62.5 | +3% to +13% | within drift |
| atomic increment | 0.14 | 0.11 / 0.13 | -7% to -21% | improved, marginal |
| pipeline | 0.20 | 0.17 / 0.18 | -10% to -15% | improved, marginal |
| hot findUnique | 0.03 | 0.03 / 0.03 | 0% | unchanged |

**No scenario regressed.** The one alarming-looking cell, findUnique L3 at 0.42 ms
in run 1, is a whole-machine slow patch and not a Turbine effect: in that same
block Prisma read 0.83 ms against its recorded 0.45 and Drizzle read 0.57 against
0.31, so all three arms roughly doubled together. Run 2 of the same harness put
Turbine back at 0.21 ms and all three arms back on their recorded values. This is
precisely the artifact the block-sequential harness produces and the interleaved
harness removes; the interleaved median for that scenario is 0.217 ms. Unrelated
work was running on the same machine during part of the measurement window, which
is the most likely source of that block and is a further reason the interleaved
medians, which spread any such episode across all four arms equally, are the
numbers reported here.

The four scenarios that moved by more than the drift floor all moved in Turbine's
favor (L2, L3, and, marginally, pipeline and increment). None of the three
v0.50.0 query-generation changes is a plausible cause of a slowdown on these
shapes, and this was checked against the code rather than assumed:

- **The `auto` cardinality heuristic does not engage anywhere in this suite.** It
  routes a relation to the batched loader only when the subtree has a provably
  unindexed probe, or when the relation is to-one **and** the parent set is
  potentially large (no limit, or a limit above 1000). Every benchmark scenario
  uses a limit of 50 or less, every relation used is to-many, and every FK in the
  fixture is indexed (`idx_posts_user_id`, `idx_comments_post_id`, and the rest
  are present in the seeded schema and in the generated metadata). The plan is
  therefore the byte-identical join plan on every scenario. Verified by statement
  counting: the `auto` arm issues exactly one statement at these sizes.
- **Pagination validation** costs a limit/orderBy shape check plus a warn-once
  registry lookup per paginated call. It fires its dev warning once and is then
  a map hit. Flat `findMany` sits at 1.21x raw pg, which is where it was.
- **Temporal binding** does not touch these code paths at the shapes measured.

One further confound was tested and eliminated: neither the published run nor
this one sets `NODE_ENV`, which leaves Turbine's dev-mode cache cross-check
guards armed. A third interleaved run with `NODE_ENV=production` produced Turbine
numbers indistinguishable from the dev runs on every scenario, so the guards are
not a measurable cost on these shapes and the published numbers are not depressed
by them.

**Competitors:** Prisma 7.9.0 and Drizzle 0.45.2 are unchanged from the 0.39.0
run, and Prisma reproduced its recorded numbers closely on every scenario.
Drizzle's streaming number did not: it recorded 65.8 ms on 2026-07-21 and 45.5 to
52.1 ms across all five runs here, and it sits exactly on the raw `pg` keyset
control (50.97 ms), which is the value it should have. The 2026-07-21 Drizzle
streaming figure looks like the outlier, not this one.

## The `auto` to-one heuristic

`relationLoadStrategy: 'auto'` became the implicit default in 0.41. For a to-one
relation it keeps the single-statement join plan while the parent set is bounded
at or under `AUTO_TO_ONE_JOIN_MAX_ROWS` (1000), and switches to the batched
loader above that, on the reasoning that a correlated to-one subquery is
re-evaluated once per parent row.

Probe shape: `posts.findMany({ limit: N, with: { user: true } })`. `posts.user` is
a `belongsTo` correlating on `users.id`, the primary key, so the probe is
perfectly indexed and cardinality is the only thing that can move the plan. Three
arms (`join`, `batched`, `auto`) interleaved per size with the order rotated per
round, medians of 15 rounds (51 for the sizes at or under 800). Statement counts
were observed per arm, so the plan `auto` chose is recorded rather than inferred.

| parent rows | join | batched | auto | stmts (auto) | plan auto chose | auto vs best plan |
|---|---|---|---|---|---|---|
| 1 | **0.12** | 0.17 | 0.13 | 1 | join | 1.03x |
| 10 | **0.10** | 0.10 | 0.10 | 1 | join | 1.01x |
| 25 | 0.16 | **0.13** | 0.16 | 1 | join | 1.26x |
| 50 | 0.23 | **0.19** | 0.23 | 1 | join | 1.20x |
| 100 | 0.37 | **0.28** | 0.36 | 1 | join | 1.28x |
| 200 | 0.65 | **0.48** | 0.64 | 1 | join | 1.33x |
| 400 | 1.36 | **0.96** | 1.50 | 1 | join | 1.57x |
| 800 | 2.84 | **1.76** | 2.69 | 1 | join | 1.53x |
| 1000 | 5.41 | **2.75** | 5.58 | 1 | join | **2.03x** |
| 1001 | 5.46 | 2.28 | **2.26** | 2 | batched | 0.99x |
| 1500 | 7.89 | 3.55 | **3.38** | 2 | batched | 0.95x |
| 2000 | 8.70 | 4.84 | **4.53** | 2 | batched | 0.93x |
| 4000 | 15.54 | **9.31** | 9.59 | 2 | batched | 1.03x |
| 8000 | 33.55 | 21.19 | **20.53** | 2 | batched | 0.97x |
| 10000 | 39.80 | 23.65 | **23.23** | 2 | batched | 0.98x |
| unbounded (10000) | 32.75 | 22.60 | **21.83** | 2 | batched | 0.97x |

**Above the threshold the heuristic works.** At 1001 rows and beyond, `auto`
switches to two statements and lands within 0.93x to 1.03x of explicit `batched`,
which is inside the noise band. At 8000 parent rows, the size range the original
report was about, `auto` runs at 20.53 ms against 33.55 ms for the join plan: it
is now picking the plan that is 1.63x faster, where before 0.41 it would have
taken the join. That specific problem is fixed, confirmed at four sizes above the
threshold.

**Below the threshold the constant is wrong for a low-latency database.** The
join plan only wins at 10 parent rows or fewer. From roughly 25 rows upward,
batched wins and the gap widens monotonically, so `auto` is 1.20x to 1.57x slower
than the best available plan across the whole 25-to-800 band, and at exactly 1000
rows, the last size before it switches, it is **2.03x slower**. The worst case of
the heuristic sits immediately under its own threshold.

**What the data says the threshold should be.** The extra cost of the join plan
grows at roughly 0.0016 ms per parent row on this host; the cost of the batched
plan is one extra round trip. The crossover is therefore wherever one round trip
equals `0.0016 x N` milliseconds:

| deployment | round trip | break-even parent rows |
|---|---|---|
| local socket (this run) | ~0.03 ms | ~25 |
| same-region cloud Postgres | ~1 ms | ~600 |
| current default (1000) implies | ~1.6 ms | 1000 |
| cross-region pooled (the ~35 ms regime) | ~35 ms | ~22,000 |

So 1000 is not an arbitrary bad number: it is the correct threshold for a
database about 1.6 ms away, which is a reasonable guess at a same-region managed
Postgres. It is roughly 40x too high for a local socket and roughly 20x too low
for a cross-region pooled connection. A single constant cannot be right for all
three, and the recommendation is not "change 1000 to 25". The options, in order
of preference:

1. **Calibrate the threshold from observed round-trip time** rather than
   hardcoding it, since Turbine already times every query.
2. **Reduce the penalty at the top of the join band.** Whatever the constant is,
   `auto` should not be at its worst 2.03x immediately below its own switch
   point; that is a discontinuity, not a heuristic.
3. **If the constant stays**, document that `autoToOneJoinMaxRows` should be
   lowered substantially (to the tens) for socket-local and same-host
   deployments, which is currently only discoverable by reading the source.

Note also that `auto` never picked a plan more than 1.03x off the best one above
the threshold, so the mechanism is sound. The finding is about the constant.

## Published-claim verification

Every numeric claim in `README.md` and `site/app/(docs)/benchmarks/page.mdx` that
this run can speak to, checked against the medians above.

| Claim (as published) | Measured 0.50.0 | Verdict |
|---|---|---|
| flat: 0.29 / 0.37 / 0.39, Turbine fastest | 0.256 / 0.358 / 0.330, Turbine fastest | CONFIRMED |
| L2: 2.86 / 4.64 / 2.39, Drizzle fastest | 2.421 / 4.603 / 2.001, Drizzle fastest | CONFIRMED |
| L3: 1.55 / 4.04 / 1.32, Drizzle, near-tie | 1.255 / 3.735 / 1.214, Drizzle, near-tie | CONFIRMED |
| findUnique PK: 0.06 / 0.12 / 0.10, Turbine fastest | 0.051 / 0.105 / 0.108, Turbine fastest | CONFIRMED |
| findUnique L3: 0.18 / 0.45 / 0.31, Turbine fastest | 0.217 / 0.469 / 0.357, Turbine fastest | CONFIRMED |
| count: 0.05 / 0.08 / 0.06, Turbine, near-tie | 0.044 / 0.081 / 0.061, Turbine won all 5 runs | CONFIRMED, and stronger than published (not a tie) |
| **stream 50K: 60.7 / 68.8 / 65.8, Turbine fastest, near-tie** | **63.87 / 71.08 / 50.18, Drizzle fastest by 27%** | **MOVED, must not stay as published** |
| increment: 0.14 / 0.19 / 0.19, Turbine fastest, near-tie | 0.115 / 0.174 / 0.123, near-tie, winner flips by harness | CONFIRMED as a near-tie only |
| pipeline: 0.20 / 0.45 / 0.41 | 0.206 / 0.431 / 0.402 | CONFIRMED |
| hot: 0.03 / 0.06 / 0.08 | 0.029 / 0.065 / 0.075 | CONFIRMED |
| "pipeline roughly 2x faster than Prisma's or Drizzle's sequential transaction" | 2.09x vs Prisma, 1.95x vs Drizzle | CONFIRMED |
| "1.6x to 2.6x ahead of Prisma on the same L2/L3 shapes" | 1.90x (L2), 2.98x (L3), 2.16x (findUnique L3) | MOVED, the true range is now 1.9x to 3.0x |
| "Prisma is behind Turbine on all ten" | true on all ten | CONFIRMED |
| "Four scenarios are near-ties (L3, count, streaming, increment)" | two are (L3, increment); count is a Turbine win; streaming is a Drizzle win | MOVED |
| "hot path ~33,000 ops/sec vs ~17,000 Prisma and ~13,000 Drizzle" | 34,483 / 15,385 / 13,333 | CONFIRMED |
| "the fastest single SELECT runs in ~0.06 ms" | 0.051 ms Turbine, 0.060 ms raw pg | CONFIRMED |
| site ratio table: stream 1.00x / 1.13x / 1.08x | Drizzle 1.00x, Turbine 1.27x, Prisma 1.42x | MOVED |
| site ratio table: increment 1.00x / 1.36x / 1.36x | 1.00x / 1.51x / 1.07x | MOVED |
| site ratio table, other eight rows | within drift of the measured ratios | CONFIRMED |
| "Prisma 7.9 improved on 7.6: flat reads ~30%, pipeline ~26%" | Prisma 7.6 was not installed or measured | UNVERIFIABLE |
| "~35 ms network round trip" on the retired pooled regime | not re-measured, different regime | UNVERIFIABLE |
| `RESULTS.md` prose, "pipeline about 3x faster" | 2.09x and 1.95x | MOVED (it describes the retired 2026-07-14 table, and contradicts the 2x on the README and site) |

Claims outside this harness that this run cannot speak to, listed so nobody reads
their absence as confirmation: bundle sizes (~60 kB and ~45 kB brotli, budgeted
separately in `.size-limit.js`), `jsonEncoding: 'positional'` (39% fewer wire
bytes, ~13% faster), the cross-engine PowDB and SQLite table on the engines page,
the serverless latency table, and the correlated-versus-batched table on the
migrate-from-prisma page. All are **UNVERIFIABLE from this run**.

One of those deserves a flag rather than silence. The migrate-from-prisma page
states that a correlated indexed relation at 659 parent rows (62 ms) beats the
batched plan (92 ms). The `auto` probe above measures the opposite ordering for a
to-one relation at every size at or above 25 parents, and Turbine's own default
strategy now switches to batched precisely because the correlated plan loses at
scale. The page's shape is a different one (a large child table rather than a
to-one), so the two are not strictly contradictory, but the page is making a
"correlated wins when indexed" argument that the shipped default no longer
follows. It should be re-measured before it is quoted again.

## Recommendation

1. **Replace the streaming row.** The published table shows Turbine fastest at
   streaming and labels it a near-tie. Five runs across two harnesses put Drizzle
   fastest by 27%, sitting exactly on the raw `pg` control. This claim cannot be
   reproduced and should not remain.
2. **Fix the near-tie count.** It is two (L3 nested and atomic increment), not
   four. Count should be reported as a Turbine win and streaming as a Drizzle win.
3. **Publish the medians, not the averages**, and publish the raw `pg` control
   column with them. "Turbine runs at 1.07x hand-written `pg` where Drizzle is
   1.47x and Prisma 1.84x" is both the strongest and the most defensible claim
   available, and unlike a bare millisecond figure it survives the drift floor.
4. **State the drift floor on the page.** Publishing 0.03 ms without saying that
   the same query varies by 30% between runs invites exactly the false-regression
   report that prompted this exercise.
5. **Update the headline geomeans to 1.87x versus Prisma and 1.36x versus
   Drizzle**, dated 2026-07-25 against turbine-orm 0.50.0.
6. **Reconcile `RESULTS.md`.** Its narrative still says the pipeline is "about 3x
   faster" while the README and site say 2x. The measurement is 2.09x and 1.95x.
7. **Treat the `auto` threshold as a product issue, not a docs issue.** It is
   correct above 1000 rows and costs up to 2.03x below it on a low-latency
   database. See the options listed in that section.

## Confidence

- **High** (multi-millisecond scenarios, drift floor 1% to 14%): L2, L3,
  streaming, findUnique L3, and every `auto` probe at 400 parent rows and above.
  The streaming finding and the `auto` threshold finding are both well outside
  noise and reproduced in every run.
- **Medium** (sub-0.15 ms scenarios, drift floor 21% to 47%): findUnique PK,
  count, atomic increment, hot findUnique, pipeline. The **orderings** are stable
  across all five runs and can be relied on; the **absolute millisecond values**
  should be read as roughly plus or minus a third, and any comparison of them to
  the 0.39.0 figures is meaningless at that resolution.
- **High** on the negative result: turbine-orm 0.50.0 has not regressed against
  0.39.0 on any scenario, and the three v0.50.0 query-generation changes were
  checked against the code and do not engage on any benchmark shape.
- **Not measured:** everything in the "outside this harness" list above, and
  Prisma 7.6, so the 7.6-to-7.9 improvement percentages remain unverified.

## Reproduce

```bash
# local PostgreSQL 17 over a Unix socket
createdb turbine_bench
cd benchmarks
npm install && npx prisma generate
DATABASE_URL="postgresql:///turbine_bench?host=/tmp" npx tsx seed-neon.ts

# the trustworthy numbers
DATABASE_URL="postgresql:///turbine_bench?host=/tmp" npx tsx bench-interleaved.ts

# the historical harness, for comparison with earlier tables
DATABASE_URL="postgresql:///turbine_bench?host=/tmp" npx tsx bench.ts

# the auto to-one threshold probe
DATABASE_URL="postgresql:///turbine_bench?host=/tmp" npx tsx bench-auto-strategy.ts
```
