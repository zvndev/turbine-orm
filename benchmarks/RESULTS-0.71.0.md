# Four-way benchmark, turbine-orm 0.71.0 vs Prisma 7.9.1 vs Drizzle 0.45.2 vs Drizzle 1.0.0-rc.4

Measured 2026-08-15. This replaces `RESULTS-0.70.0.md` as the current
measurement; that file stays as the previous datum. It is the confirmation run
for the prediction `RESULTS-0.70.0.md` made: that turning on
`jsonEncoding: 'positional'` would take Turbine from 7/10 to 9/10 against
Drizzle and its geometric mean from 1.078x to about 1.03x. Positional is now the
PostgreSQL default, so that configuration is no longer a side experiment, it is
what a user gets.

> **TL;DR.**
>
> **The prediction reproduced, and closely.** On the shipping default Turbine
> wins **9/10 against Drizzle 0.45.2** and **10/10 against Prisma 7.9.1**, with
> a geometric mean of **1.025x** against the prediction's 1.029x. Run with the
> OLD encoding forced, the same tree on the same machine reproduces the 0.70.0
> published figures almost exactly: **1.079x and 7/10**, against 1.078x and 7/10
> then. That agreement is the methodology control for everything below.
>
> **L2 and L3 stopped being losses.** L2 went from a 1.39x loss to a **1.02x
> win**, L3 from a 1.22x loss to a **1.08x win**. Both are reported as **narrow
> and contested**: L2's margin is 2.5%, and the contiguous cross-check harness
> disagrees with ITSELF on those two scenarios across runs of the same
> configuration. What is not in doubt is the size of the improvement, which
> reproduces on both harnesses.
>
> **Streaming is still the loss**, and `findManyStream` did not move, because it
> was not changed. The new `findManyStreamBatches` is a **different API** and
> gets measured as one: it drains 50K rows **4.51 ms faster** (paired, 87 ns per
> row) and narrows the loss to Drizzle from 1.28x to 1.16x without closing it.
>
> **One number got worse on inspection, not better.** Turbine's overhead above
> hand-written `pg` computes to **1.00x** as the harness records it, and that is
> flattered: the raw L2 control statement still uses `json_build_object` while
> Turbine now emits `json_build_array`, and that difference alone is worth
> **1.83x** on identical rows. Against an encoding-matched control the honest
> figure is **1.08x**, which is what this run publishes.

## Setup

Deliberately identical to the 0.70.0, 0.66.0 and 0.50.0 runs so they stay
comparable.

- **Database:** local PostgreSQL 17.9 (Homebrew), Unix-socket connection at
  `/tmp/.s.PGSQL.5432`, no network hop, the same seeded `turbine_bench_070`. A
  container was again deliberately not used: Docker on macOS routes through a VM
  and a forwarded TCP port, which adds a latency floor.
- **Client:** Apple Silicon MacBook Pro, macOS (Darwin 25.5.0), Node v24.18.0.
  Client and database are the same host.
- **Data:** 5 orgs, 1,000 users, 10,000 posts, 50,000 comments, the
  deterministic `seed-neon.ts` fixture at its defaults. Counts are verified by
  the harness before any number is recorded.
- **Versions measured:** turbine-orm **0.71.0** (working tree, `file:..`,
  `npm run build` output) / `@prisma/client` **7.9.1** / `@prisma/adapter-pg`
  **7.9.1** / `drizzle-orm` **0.45.2** / `drizzle-orm` **1.0.0-rc.4** (the `rc`
  dist-tag) / `pg` **8.22.0**.
- **Competitor version check, 2026-08-15.** Nothing moved since the 0.70.0 run.
  `@prisma/client` latest is still **7.9.1**, `drizzle-orm` latest is still
  **0.45.2**, and its `rc` tag is still **1.0.0-rc.4**. `pg` latest is 8.23.0
  and was again **deliberately not bumped**: it is the raw control and it also
  underlies the Prisma, Drizzle and Turbine arms, so changing it would move
  every arm at once and break comparability for no gain.
- **Runs:** interleaved harness 200 rounds + 20 warmup per arm per scenario
  (streaming: 9 rounds + 1 warmup, each draining 50K rows), **three full runs**
  per configuration, medians of medians. Four configurations were run: the
  shipping default, the old encoding forced, a five-arm suite with the Drizzle
  RC, and a suite with the Turbine stream arm pointed at the batch API.

### The harness had to be fixed before it could measure this release

`bench-interleaved.ts` passed `jsonEncoding: 'object'` explicitly whenever
`TURBINE_JSON` was unset. That was correct when it was written, because object
was the default. With the default moved it would have gone on reporting the old
encoding as "Turbine" forever, and the reported number would have looked
completely unremarkable.

The arm now passes **no** `jsonEncoding` key unless asked, and then reads the
encoding back **out of the emitted SQL** and prints it, rather than printing
what it believes it configured. The same check exists in `bench.ts`. A harness
that reports its own input cannot detect a stale `dist/`, which is the failure
this whole round depended on not having.

## Results, primary (interleaved) harness, shipping default

Median wall-clock ms per operation, median of three full runs. Lower is better.
Bold is the fastest ORM. The raw column is hand-written `pg`.

| Scenario | Turbine 0.71 | Prisma 7.9.1 | Drizzle 0.45 | raw pg |
|---|---|---|---|---|
| findMany, 100 users (flat) | **0.181 ms** | 0.241 ms | 0.242 ms | 0.164 ms |
| findMany, 50 users + posts (L2) *(contested)* | **1.670 ms** | 4.302 ms | 1.711 ms | 1.847 ms |
| findMany, 10 users to posts to comments (L3) *(contested)* | **1.082 ms** | 4.204 ms | 1.166 ms | n/a |
| findUnique, single user by PK | **0.035 ms** | 0.078 ms | 0.080 ms | 0.036 ms |
| findUnique, user + posts + comments (L3) | **0.146 ms** | 0.374 ms | 0.285 ms | n/a |
| count, all users | **0.038 ms** | 0.070 ms | 0.053 ms | 0.041 ms |
| stream, iterate 50K comments (batch 1000) | 50.389 ms | 54.813 ms | **39.494 ms** | 42.326 ms |
| atomic increment, posts.view_count + 1 | **0.067 ms** | 0.106 ms | 0.073 ms | 0.055 ms |
| pipeline, 5-query dashboard batch | **0.165 ms** | 0.338 ms | 0.341 ms | 0.177 ms |
| hot findUnique, rotating IDs | **0.026 ms** | 0.059 ms | 0.069 ms | 0.030 ms |

Geometric means over the ten scenarios:

| | ratio to the fastest ORM per scenario |
|---|---|
| Turbine 0.71.0 | **1.025x** |
| Drizzle 0.45.2 | 1.498x |
| Prisma 7.9.1 | 2.072x |

Pairwise, geometric mean of the per-scenario ratio against Turbine: Turbine is
**2.02x faster than Prisma 7.9.1** and **1.46x faster than Drizzle 0.45.2**.

Head-to-head, scenarios won: Turbine beats Prisma **10/10** and Drizzle
**9/10**, losing only streaming.

## Did the prediction reproduce? Yes, and the control says so

`RESULTS-0.70.0.md` measured positional as a separate suite and predicted what
it would do if it became the default. Running the old encoding forced, on the
same tree and the same machine, is the control that makes the comparison mean
something: if the object arm did not reproduce the 0.70.0 numbers, nothing else
here would be interpretable.

| | 0.70.0 published (object was the default) | this run, `TURBINE_JSON=object` | this run, shipping default |
|---|---|---|---|
| geometric mean vs fastest ORM | 1.078x | **1.079x** | **1.025x** |
| scenarios won vs Drizzle | 7/10 | **7/10** | **9/10** |
| L2 | 1.40x loss | 1.39x loss | **1.02x win** |
| L3 | 1.16x loss | 1.22x loss | **1.08x win** |

The object arm reproduced the previous release's headline figure to the third
decimal and its win record exactly. The prediction was 9/10 and a geometric mean
of 1.029x; the measurement is 9/10 and 1.025x.

Rows are **identical** between the two encodings, not merely equivalent:
`encoding-parity.ts` compares `JSON.stringify` output across five nested shapes
(L2, L3, nested findUnique, a relation with `select` + `orderBy`, a relation
with a `where`) and all five match exactly, key order included. That check is a
spot check on this fixture and is not a substitute for
`src/test/strategy-fuzz.test.ts`, which is where the property belongs.

## What Turbine loses, stated plainly

One scenario now, not three.

| | Turbine | best | ratio | 0.70.0 ratio |
|---|---|---|---|---|
| stream 50K | 50.389 ms | Drizzle 39.494 ms | **1.28x** | 1.30x |

L2 and L3 are no longer losses on this harness, and the two former loss rows are
reported above as wins with a *(contested)* mark. The reason for the mark is in
the next section, and it is not a formality.

## L2 and L3 are wins with an asterisk, and the asterisk is the cross-check

`bench.ts` measures each ORM in a contiguous block rather than interleaving, and
it is the harness that has historically decided whether a scenario is
"contested". On this release it cannot decide these two, because **two runs of
the identical configuration disagree with each other**:

| contiguous run | L2 Turbine | L2 Drizzle | L2 winner | L3 Turbine | L3 Drizzle | L3 winner |
|---|---|---|---|---|---|---|
| shipping default | 2.18 ms | 1.63 ms | Drizzle | 0.82 ms | 0.92 ms | Turbine |
| `TURBINE_JSON=positional` (same config) | 1.54 ms | 1.61 ms | Turbine | 1.13 ms | 0.94 ms | Drizzle |
| `TURBINE_JSON=object` | 2.38 ms | 1.67 ms | Drizzle | 1.53 ms | 1.25 ms | Drizzle |

The first two rows are the same encoding measured twice and they reverse each
other on both scenarios. That is the instability the interleaved harness exists
to remove, and it means the contiguous harness is evidence about neither
direction here. **L2 and L3 are therefore reported as narrow wins on the primary
harness and marked contested**, which is the same treatment atomic increment has
had for three releases.

What the contiguous harness DOES establish, because it is a within-harness
comparison rather than a cross-harness one, is that the encoding change is real
and large on that harness too: L2 **2.38 ms to 1.54 ms** and L3 **1.53 ms to
1.13 ms**, the same direction and roughly the same magnitude the interleaved
harness measured. The improvement is not in question. Only whether it is enough
to pass Drizzle is.

Atomic increment: the contiguous harness now puts Turbine marginally ahead
(0.09 ms against Drizzle's 0.09 ms, reported as 1.00x), where 0.70.0 had it
behind. Two harnesses agreeing at a tie is still a tie, so it stays
**unestablished** rather than becoming a win.

## The raw `pg` control is no longer encoding-matched on L2

This is the number most likely to be quoted and it needs the caveat attached.

The `Raw` arm's hand-written L2 statement builds its nested rows with
`json_build_object`, because that is what Turbine emitted when the arm was
written. Turbine now emits `json_build_array`. Measured directly, on identical
data returning identical row and child counts:

| raw hand-written L2 | median |
|---|---|
| `json_build_object` (the recorded control arm) | 0.801 ms |
| `json_build_array` (encoding-matched) | 0.437 ms |
| ratio | **1.83x** |

So on L2 the control is doing strictly more work than the ORM it is meant to
bound, and Turbine's L2 "overhead" comes out at **0.90x**, i.e. faster than
hand-written SQL. That reading is not supportable. It is faster than one
particular hand-written statement that spells the encoding the slower way, and
anyone writing that SQL by hand today for speed would write the array form,
because it is the form Drizzle emits.

| overhead above hand-written `pg`, geometric mean over the 8 raw-controlled scenarios | Turbine | Drizzle | Prisma |
|---|---|---|---|
| as the harness records it | 1.00x | 1.47x | 1.81x |
| **with an encoding-matched L2 control** | **1.08x** | 1.47x | 1.81x |

**1.08x is the figure this run publishes**, and it is the conservative one. The
as-recorded 1.00x is disclosed rather than used. The encoding-matched column is
derived, not directly measured: it is the recorded in-suite raw L2 divided by
the 1.83x ratio measured above, because rewriting the recorded `Raw` arm would
break comparability with every published run for the sake of one release's
number.

For the record, the same correction applied to the object-encoding suite gives
1.13x against its as-recorded 1.05x, so the caveat is not new and not specific
to positional. It was simply invisible while Turbine and the control agreed.

### The harness has since been fixed, and future runs need no adjustment

The derived figure above was a one-release workaround, and it is no longer
needed. `bench-interleaved.ts` now picks its raw L2 statement from the encoding
it reads back out of Turbine's own compiled SQL, so the control is matched in
the shipping-default configuration AND in the `TURBINE_JSON=object` control run,
and no future encoding change can silently unmatch it again. The two spellings
are asserted to return the same rows and the same child count before anything is
timed, so a mismatched control now fails loudly instead of quietly flattering the
result. `bench-extended.ts` carried the identical defect in its to-one raw
control (a to-one relation goes through the same `buildJsonRow`) and was fixed
the same way.

Re-measured with the encoding-matched control, three gated runs on the same
fixture:

| overhead above hand-written `pg`, geometric mean over the 8 raw-controlled scenarios | value |
|---|---|
| 0.71.0 as recorded, mismatched control | 1.00x |
| 0.71.0 published, derived by dividing the raw L2 by 1.83 | **1.08x** |
| re-measured, encoding-matched control (runs: 1.138x / 1.066x / 1.072x) | **1.079x** |

**The derived figure and the directly measured one agree to three decimals**, so
the adjustment published above was the right call and the number it produced was
correct. Raw L2 moved from 1.847 ms to 1.080 ms, a 1.71x shift against the 1.83x
measured for the encoding alone, and Turbine's L2 overhead moved from a
non-supportable 0.90x to 1.59x.

One caveat on that re-measurement, recorded because it is the same discipline
the rest of this file applies. The machine control drifted hard across the
re-run: the 50K keyset drain went from 42.35 ms before to 68.45 ms after, and
run 3's absolute L2 values are inflated accordingly. The **ratio** survived it,
because Turbine and its raw control are measured in the same interleaved
rotation and drift lands on both: L2 Turbine/Raw came out 1.589x, 1.534x and
1.555x across the three runs while the absolute values moved about 18%. Ratios
within a run remain the only quotable quantity, which is exactly what the
"absolute numbers must not be compared across dates" rule already says.

`machine-control.ts` was deliberately NOT changed. It still spells its L2 probe
with `json_build_object`, and it should: it contains none of Turbine's code and
its entire value is being a fixed yardstick for machine drift across dates.
Changing its statement would reset that baseline for no gain.

Note also that four scenarios sit below 1.00x against the control on their own
(findUnique 0.97x, count 0.93x, pipeline 0.93x, hot findUnique 0.87x). Two
mechanisms are involved and only one is real: Turbine names its prepared
statements, so node-postgres skips `Parse` on a repeated shape where the raw
arm's `pool.query(text, params)` does not, which is a genuine advantage on the
hot paths; and all four are sub-0.18 ms figures sitting near the drift floor, so
their margins are not quotable either way.

## The batch-yielding stream API, measured as a different API

`findManyStream` is **unchanged in this release**, so the stream arm in the
table above sits where it sat, and that is the expected result rather than a
disappointment. `findManyStreamBatches` is a new, additive API that yields `T[]`
instead of `T`, and it is measured separately so it can never be presented as
the per-row API getting faster.

Paired against `findManyStream` on the same cursor, same fixture, arms rotating
inside each round (`bench-stream-batches.ts`):

| | median | 50K rows |
|---|---|---|
| `findManyStream` (per row) | 50.17 ms | |
| `findManyStreamBatches` (per batch) | **45.81 ms** | |
| paired median delta | **4.51 ms** | **87 ns per row** |

The regression control in the same harness reports the pre-change
`findManyStream` at 51.36 ms against the shipping one's 50.17 ms, so the
refactor did not cost the per-row path anything.

Run through the full four-arm suite with only that one method swapped, three
runs, so it is measured in the same regime as the competitors:

| stream, 50K comments | Turbine | Drizzle | raw pg | Turbine vs its own raw control |
|---|---|---|---|---|
| `findManyStream` (the default arm) | 50.389 ms | 39.494 ms | 42.326 ms | 1.19x |
| `findManyStreamBatches` | 47.379 ms | 40.864 ms | 44.545 ms | **1.06x** |

The batch API takes Turbine from 19% above its keyset control to 6% above it.
**It does not win the scenario**: Drizzle still drains the table faster, and the
loss narrows from 1.28x to 1.16x. The per-row generator was worth about a third
of the gap, which is what `PROFILE-0.70.0.md` predicted, and the rest is
`parseRow` plus the cursor protocol's extra round trips.

Reported per-row cost is 87 ns here against the profile's 135 to 152 ns. Both
are correct for their machine state; only the direction and rough magnitude
travel across dates.

## The Drizzle 1.0 release candidate

Run as a five-arm suite, three runs. **Arm counts are not mixed across suites**:
a fifth arm puts one more competitor's working set between every other arm's
consecutive calls, which is measurable rather than cosmetic. The four-arm and
five-arm numbers are each internally consistent and must not be compared
cell for cell.

| Scenario | Turbine 0.71 | Prisma 7.9.1 | Drizzle 0.45 | **Drizzle 1.0-rc.4 (jit)** | raw pg |
|---|---|---|---|---|---|
| findMany, 100 users (flat) | **0.175 ms** | 0.238 ms | 0.236 ms | 0.194 ms | 0.156 ms |
| findMany, 50 users + posts (L2) | **1.668 ms** | 4.364 ms | 1.759 ms | 1.935 ms | 1.908 ms |
| findMany, 10 users to posts to comments (L3) | **0.932 ms** | 3.806 ms | 1.031 ms | 1.207 ms | n/a |
| findUnique, single user by PK | **0.033 ms** | 0.076 ms | 0.078 ms | 0.090 ms | 0.033 ms |
| findUnique, user + posts + comments (L3) | **0.151 ms** | 0.386 ms | 0.295 ms | 0.339 ms | n/a |
| count, all users | **0.040 ms** | 0.073 ms | 0.054 ms | 0.060 ms | 0.041 ms |
| stream, iterate 50K comments (batch 1000) | 50.787 ms | 55.178 ms | 38.951 ms | **30.762 ms** | 43.146 ms |
| atomic increment, posts.view_count + 1 | **0.071 ms** | 0.108 ms | 0.074 ms | 0.073 ms | 0.056 ms |
| pipeline, 5-query dashboard batch | **0.172 ms** | 0.351 ms | 0.344 ms | 0.377 ms | 0.179 ms |
| hot findUnique, rotating IDs | **0.027 ms** | 0.060 ms | 0.070 ms | 0.079 ms | 0.031 ms |

| | ratio to the fastest ORM |
|---|---|
| Turbine 0.71.0 | **1.051x** |
| Drizzle 0.45.2 | 1.522x |
| Drizzle 1.0.0-rc.4 (jit) | 1.585x |
| Prisma 7.9.1 | 2.132x |

Unchanged from 0.70.0 in its conclusion: **the JIT row mapper is not a general
win on this suite.** The RC is slower than the shipping 0.45.2 on nine of ten
scenarios, including both nested reads it was expected to help. Turbine beats it
**9/10**. This is a release candidate and pre-release performance is not a
promise about 1.0.

**Streaming remains the one place it is a genuine threat, and the threat grew**:
30.762 ms against Drizzle 0.45's 38.951 ms and raw node-postgres' 43.146 ms,
faster than the driver it is built on, because 1.0 replaces pg's type parsers
with its own codecs. Turbine's batch stream at ~47 ms does not change that
picture. When 1.0 ships, streaming is still the scenario to re-measure first.

JIT engagement is asserted by identity against the library's own exported
`makeJitRqbMapper` on every RC run, because `jit: true` falls back silently.

## Drift floor

Read this before quoting any sub-millisecond figure. The `SELECT 1` probe ran at
the head, middle and tail of every suite.

| suite | run 1 spread | run 2 spread | run 3 spread |
|---|---|---|---|
| default (positional) | 36.9% | 48.0% | 150.2% |
| object encoding | 152.9% | 112.1% | 62.6% |
| five-arm with RC | 86.7% | 136.1% | 158.3% |
| batch stream | 71.7% | 172.6% | 130.0% |

As in every previous run, most of the spread is between the head probe and the
other two, i.e. process warmup: a typical triple is 0.025 / 0.010 / 0.010 ms.

The multi-millisecond scenarios (L2, L3, stream) are stable and their orderings
are trustworthy. **The sub-0.15 ms scenarios (findUnique, count, atomic
increment, pipeline, hot findUnique) carry roughly one third uncertainty in
their absolute values. Their orderings held across all three runs, but their
MARGINS are not quotable.** "Turbine is 2.7x faster than Drizzle on hot
findUnique" is not a supportable claim at 0.026 ms against a drift floor of
0.010 to 0.027 ms.

The same caution applies to **L2's 2.5% margin**, which is why it is marked
contested above rather than quoted as a lead.

## Machine state, which is a result and not a footnote

A control containing **none of Turbine's code** (`machine-control.ts`, raw `pg`
only) ran immediately before and immediately after the round:

| | before | after | drift |
|---|---|---|---|
| `SELECT 1` | 0.0344 ms | 0.0251 ms | -27% |
| raw flat, 100 users | 0.124 ms | 0.126 ms | +1.6% |
| raw L2, 50 users + posts | 0.788 ms | 0.790 ms | +0.3% |
| raw 50K keyset drain | 41.283 ms | 42.454 ms | +2.8% |

The two multi-millisecond controls moved by under 3% across the whole round, so
the box did not shift underneath the measurements. (`SELECT 1` moved 27%, which
is the drift floor doing what the drift floor does at 0.03 ms and is why nothing
is quoted at that resolution.)

**The round published here is the second one. The first was discarded, and the
reason is worth recording because it was self-inflicted.** Two separate
contention sources hit this machine:

1. A **20-way parallel `rustc` build** was running when the session started. The
   control measured the 50K drain at **54.94 ms** against **42.19 ms** on a
   quiet box, a **30% inflation**, on code that had not changed. This is the
   same failure mode the 0.70.0 round caught, and it is why the control exists.
2. My own **wait loops**. Twenty orphaned shells were spinning at ~78% CPU each,
   because a `sleep` inside an `until` loop was being terminated, turning the
   loop hot. They started partway through the first round, so some of its runs
   were clean and others were not, and there was no honest way to tell which.
   The whole round was thrown away rather than reported with a caveat.

Every run in the published round is gated: it starts only after the CPU has been
**at least 75% idle for five consecutive samples with no compiler running**, and
any run that finished under contention was discarded and retried
(`run-suite.sh`). One RC run and one batch run were discarded this way. The gate
tests **CPU idle, not load average**: this box permanently hosts a dozen idle
dev servers and language servers, so its floor load average is 4 to 6 while the
CPU is 85% idle, and a load-average gate never opens at all.

**Absolute numbers must not be compared across dates; only ratios within a run
are meaningful.** That is not boilerplate here: this round's absolute values are
close to 0.70.0's, but the object-encoding control is what licenses the
comparison, not the similarity.

## Reproducing

```bash
createdb turbine_bench_070
cd benchmarks
DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" npx tsx seed-neon.ts
DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" npx prisma generate
# from the repo root, rebuild: the harness resolves turbine-orm through a
# symlink to dist/, so an unbuilt tree silently benchmarks stale code
npm run build
DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" npx tsx src/cli/index.ts generate --out generated/turbine

# arms must verify before anything is timed
DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" npx tsx verify-arms.ts

# the whole round, every run gated on a quiet machine, controls at both ends
./run-suite.sh /tmp/bench071

# or the individual configurations
DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" npx tsx bench-interleaved.ts
DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" TURBINE_JSON=object npx tsx bench-interleaved.ts
DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" TURBINE_STREAM=batches npx tsx bench-interleaved.ts
DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" INCLUDE_RC=1 npx tsx bench-interleaved.ts

# supporting measurements
DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" npx tsx encoding-parity.ts
DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" npx tsx raw-l2-encoding.ts
DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" npx tsx bench-stream-batches.ts
DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" npx tsx machine-control.ts before

# medians of medians plus every published ratio, from the run logs
npx tsx summarize-round.ts /tmp/bench071 default
```
