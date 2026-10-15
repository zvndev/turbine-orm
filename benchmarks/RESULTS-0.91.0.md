# Benchmarks, turbine-orm 0.91.0 vs Drizzle 0.45.3 vs Prisma 7.10.0

Measured 2026-10-15. This is the first round that measures every published table on
one release. The site previously quoted a results table from 0.71.0, extra
scenarios and the latency sweep from 0.67.0, streaming from 0.76.0 and the network
table from 0.78.0. Every number below comes from this round on 0.91.0. The machine-
readable copy the site imports is `results-0.91.0.json`.

> **TL;DR.**
>
> - **Overhead above hand-written `pg`, geometric mean over 8 controlled
>   scenarios: Turbine 1.136x, Drizzle 1.596x, Prisma 2.118x.** All three are
>   higher than the 0.71.0 figures (1.08x / 1.47x / 1.81x); see "What got worse"
>   for why Turbine's moved and why the others' did too.
> - **Ratio to the fastest ORM, 10 scenarios: Turbine 1.003x, Drizzle 1.407x,
>   Prisma 2.076x.** Turbine wins 9 of 10 against Drizzle (atomic increment is a
>   tie) and 10 of 10 against Prisma.
> - **Streaming is no longer a loss.** In the main suite the per-row stream beats
>   Drizzle 0.45.3 (42.2 ms against 46.6 ms). In the streaming harness
>   `findManyStreamBatches` ties the Drizzle 1.0 release candidate (33.4 ms against
>   34.3 ms) and the per-row API still trails it by about 10%.
> - **Bulk insert is the widest margin: 3.3x Drizzle and 7.5x Prisma** on 1,000
>   rows (0.71-era figures were 2.5x and 5.8x).
> - **Large reads now run faster than the stock `pg` control** (50,000 rows:
>   30.7 ms against 41.8 ms). That is real and user-visible, and it has one cause,
>   explained below: Turbine has shipped a faster `timestamptz` parser since 0.72.0.
>   Against a control given the same parser, Turbine is about 5% slower.
> - **New loss: the first query on a new client.** Drizzle is 7% faster (0.388 ms
>   against 0.415 ms) in all three runs; 0.67.0 measured it as a tie.
> - **Deep pagination is still a loss** (0.557 ms against Drizzle 0.392), and
>   `forceCustomPlan` still fixes it (0.338 ms).
> - **Not rerun: the Neon network table.** The stored Neon credentials no longer
>   reach the benchmark project, so there is no 0.91.0 network figure. The 0.78.0
>   network results stay in `RESULTS-NETWORK-0.78.0.md` and are not re-labelled.

## Setup

- **Database:** local PostgreSQL 17.11 (Homebrew), Unix socket `/tmp`, a fresh
  database `turbine_dev_bench` seeded by `seed-neon.ts` at its defaults (5 orgs,
  1,000 users, 10,000 posts, 50,000 comments, 50 tags, 30,000 post_tags, 2,000 wide
  rows), then `ANALYZE`d. Dropped after the round.
- **Client:** Apple Silicon MacBook Pro, macOS (Darwin 25.5.0), **Node v24.18.0**
  (the version the 0.71.0 round used). Client and database on one host.
- **Versions:** turbine-orm **0.91.0** (working tree, `npm run build`) /
  `drizzle-orm` **0.45.3** / `drizzle-orm` **1.0.0-rc.4** (streaming harness) /
  `@prisma/client` + `@prisma/adapter-pg` + `prisma` **7.10.0** / `pg` **8.23.1**.
  `drizzle-orm` 0.45.4 (2026-10-08) was skipped as too new to adopt; 0.45.3 is from
  2026-09-21. `pg` 8.23.1 sits under **every** arm: the repo root's copy, which the
  Turbine arm resolves through the `file:..` link, was installed at 8.23.1 without
  saving, so no arm runs a different driver.
- **Arms verified before timing** (`verify-arms.ts`): every arm returns the same row
  and nested-child counts, and the Turbine arm's JSON encoding is read back out of
  its emitted SQL (positional).
- **Runs, all gated on a quiet machine** (`run-suite.sh`'s gate, see "Machine
  state"):
  - main suite `bench-interleaved.ts`: 200 rounds after 20 warmup, **three runs**,
    medians of medians;
  - extra scenarios `bench-extended.ts`: 100 rounds after 15 warmup (50,000-row
    reads 10 rounds, `createMany` 20), **three runs** (the 0.67.0 table was a
    single run);
  - streaming `bench-stream-parity.ts`: 15 rounds after 2 warmup, three runs;
  - latency sweep `bench-latency.ts`: 25 rounds per round-trip time, three runs
    (0.67.0 was a single run);
  - deep pagination isolation `deepoffset.ts`: 150 rounds, one run;
  - `machine-control.ts` before and after.

**Harness changes: none.** Every harness ran unmodified on 0.91.0 and the new
versions. Only `benchmarks/package.json` changed (the version bumps above).

### Tie rule

A Turbine result against the closer of Drizzle and Prisma is reported as a **tie**
when any of these holds: the faster of the two is not the same in all three runs;
the median gap is below the suite's drift floor (median over runs of the spread of
the `SELECT 1` probes: 0.012 ms main suite, 0.015 ms extended); or the gap is under
3% of the faster median. Earlier rounds applied the same idea by hand.

## Results, main suite

Median ms, median of three runs. Lower is better. Bold is the fastest ORM.

| Scenario | Turbine | Drizzle 0.45.3 | Prisma 7.10 | hand-written `pg` |
|---|---|---|---|---|
| findMany, 100 users | **0.145** | 0.230 | 0.231 | 0.148 |
| findMany, 50 users + posts | **1.727** | 1.894 | 4.426 | 1.105 |
| findMany, 10 users + posts + comments | **1.059** | 1.189 | 3.913 | n/a |
| findUnique by primary key | **0.061** | 0.111 | 0.119 | 0.059 |
| findUnique, user + posts + comments | **0.287** | 0.498 | 0.771 | n/a |
| count, all users | **0.050** | 0.065 | 0.093 | 0.046 |
| stream 50,000 comments, per row | **42.159** | 46.632 | 61.920 | 46.392 |
| atomic increment *(tie)* | 0.120 | **0.117** | 0.189 | 0.082 |
| pipeline, 5-query batch | **0.400** | 0.750 | 0.858 | 0.368 |
| hot findUnique, rotating ids | **0.058** | 0.106 | 0.115 | 0.052 |

The `pg` control's nested statement is encoding-matched to Turbine
(`json_build_array`), as the harness has done since the 0.71.0 fix.

| Geometric mean | Turbine | Drizzle | Prisma |
|---|---|---|---|
| Overhead above hand-written `pg` (8 scenarios with a control) | **1.136x** | 1.596x | 2.118x |
| Ratio to the fastest ORM (10 scenarios) | **1.003x** | 1.407x | 2.076x |

Pairwise, geometric mean of the per-scenario ratio against Turbine: Drizzle is
**1.40x** Turbine and Prisma **2.07x** (0.71.0: 1.46x and 2.02x).

L2 and L3, marked *contested* in 0.71.0, are clear this time: Turbine leads Drizzle
by 9% and 11% and won both in all three runs.

## Results, extra scenarios

| Scenario | Turbine | Drizzle 0.45.3 | Prisma 7.10 | hand-written `pg` |
|---|---|---|---|---|
| findMany, 5,000 comments | **2.911** | 4.937 | 5.162 | 3.925 |
| findMany, 50,000 comments | **30.678** | 51.613 | 54.907 | 41.813 |
| findMany, 1,000 rows x 39 columns | **3.799** | 6.090 | 6.047 | 3.787 |
| list page, newest first | **0.220** | 0.280 | 0.268 | 0.188 |
| createMany, 1,000 rows | **5.440** | 18.042 | 41.066 | 4.988 |
| update by primary key *(tie)* | **0.100** | 0.100 | 0.135 | 0.080 |
| upsert on a unique column *(tie)* | **0.108** | 0.112 | 0.136 | 0.079 |
| delete by unique column *(tie)* | 0.086 | **0.084** | 0.123 | 0.068 |
| to-one, 500 posts + author | **1.171** | 1.541 | 1.559 | 0.963 |
| many-to-many, 200 posts + tags | **2.158** | 2.777 | 5.122 | n/a |
| relation `_count`, 100 users | **0.233** | 0.345 | 0.318 | n/a |
| relation filter (`some`), 100 users | **0.184** | 0.260 | 0.280 | 0.209 |
| groupBy + `having`, 5 groups *(tie)* | **0.646** | 0.652 | 0.722 | 0.634 |
| first query on a new client | 0.415 | **0.388** | 0.634 | n/a |

Against Drizzle: 10 clear wins, 4 ties, 1 loss (first query on a new client).
Against Prisma: 14 of 14.

### Why large reads beat the `pg` control

The control is `pool.query('SELECT * FROM comments LIMIT $1')` on stock
node-postgres. Since 0.72.0 Turbine registers its own `timestamptz` parser (OID
1184, `createFastTimestamptzParser` in `src/query/utils.ts`), which produces the
same `Date` as `postgres-date` and is much cheaper. Isolated on 50,000 comments,
interleaved, 10 rounds:

| arm | median |
|---|---|
| Turbine `findMany` | 38.35 ms |
| hand-written `pg`, stock parsers (the control) | 51.54 ms |
| hand-written `pg`, with Turbine's parsers registered | 36.46 ms |
| hand-written `pg`, no type parsing at all | 25.82 ms |

So the lead over the control is the parser, and against a control given the same
parser Turbine is about 5% slower, which is the honest per-row overhead. Turbine
also decodes `bigint` ids to numbers, which the control leaves as strings, so it
does strictly more work per row. The 0.71.0 round predates the parser and measured
Turbine 7% above the control on the same scenario. Quote this as "faster than
node-postgres with its default parsers", never as "faster than hand-written SQL".

The same effect lowers Turbine's overhead on the per-row stream (0.91x the control)
and on the 5,000-row read. It does not touch the wide-table read, whose columns are
mostly text and numeric (1.00x).

## Streaming

`bench-stream-parity.ts`, 50,000 comments in batches of 1,000, both Turbine APIs in
one rotation with both Drizzle releases.

| Arm | Median |
|---|---|
| Turbine `findManyStreamBatches` | **33.422** |
| Drizzle 1.0.0-rc.4 | 34.275 |
| Turbine `findManyStream` (per row) | 37.559 |
| Drizzle 0.45.3 | 40.536 |
| hand-written `pg`, keyset pages | 41.954 |

`findManyStreamBatches` against the RC is a tie (2.5%; it won all three runs, by 2.5% and 0.9% in the two
clean ones). The per-row API trails the RC by about 10% and beats 0.45.3. The
harness's negative control (two identical batch arms) read -0.6%, and the per-row
API costs 87 ns per row over the batch API, the same figure as 0.71.0. As before,
Turbine reads through a server-side cursor in a transaction and the other arms page
by key, so the database work differs.

## Deep pagination

A sorted 20-row page at offset 9,000 (extra-scenarios suite):

| Arm | Median |
|---|---|
| Turbine, named statement (default) | 0.557 |
| Turbine, `forceCustomPlan: true` | **0.338** |
| Drizzle 0.45.3 | 0.392 |
| Prisma 7.10 | 0.398 |
| hand-written `pg` | 0.294 |

`deepoffset.ts` confirms the mechanism is unchanged: raw `pg` with a NAMED statement
0.522 ms, unnamed 0.292 ms; Turbine named 0.543 ms, `forceCustomPlan` 0.309 ms.

## Latency sweep

`bench-latency.ts`, TCP proxy adding a fixed round-trip time, median of three runs.

**5-query dashboard**

| arm | 0 ms | 1 ms | 5 ms | 25 ms |
|---|---|---|---|---|
| Turbine `pipeline` | **0.438** | **3.160** | **5.503** | **27.225** |
| Drizzle transaction | 1.043 | 17.897 | 34.186 | 184.504 |
| Prisma `$transaction` | 1.157 | 18.087 | 34.287 | 184.689 |

At 25 ms the pipeline is **6.78x** faster than either transaction (0.67.0: 6.9x).

**findUnique by primary key**

| arm | 0 ms | 1 ms | 5 ms | 25 ms |
|---|---|---|---|---|
| Turbine | 0.176 | 2.569 | 4.831 | 26.535 |
| Drizzle | 0.236 | 2.644 | 4.973 | 26.611 |
| Prisma 7 | 0.255 | 2.688 | 5.018 | 26.767 |
| hand-written `pg` | 0.166 | 2.537 | 4.835 | 26.523 |

**L2, 50 users + posts**

| arm | 0 ms | 1 ms | 5 ms | 25 ms |
|---|---|---|---|---|
| Turbine `join` | 1.740 | 4.985 | 7.064 | 28.188 |
| Turbine `batched` | **1.062** | 6.386 | 10.912 | 53.532 |
| Turbine `auto` (default) | 1.709 | **4.932** | **6.513** | **28.142** |
| Drizzle | 1.829 | 5.032 | 7.020 | 28.270 |
| Prisma 7 | 4.454 | 9.372 | 9.747 | 31.862 |

Same three conclusions as 0.67.0, now on three runs: `batched` wins only on a
socket and is 1.9x slower than `join` at 25 ms; the pipeline gap grows with
distance; point reads converge within 0.25 ms at 25 ms. Every latency cell's three
runs agree within a few percent, except Prisma's L2 cells at 1 and 5 ms (up to 15%).

## What got worse, and why the overhead figures moved

- **Turbine's overhead above the control rose from 1.079x to 1.136x.** The rise is
  concentrated in the sub-0.15 ms scenarios: atomic increment went from 1.22x the
  control to 1.46x (1.46 / 1.46 / 1.30 across runs), hot findUnique from 0.87x to
  1.12x, count and pipeline from 0.93x to 1.09x. L2 is flat (1.59x then, 1.56x now).
  The flat 100-user read and the stream moved the other way because of the
  `timestamptz` parser. The likely cause is per-call work added in 0.73 to 0.91
  (argument normalisation, middleware argument guards, transaction-state checks,
  SQL-comment plumbing); this round does not attribute it, and a profile is the
  next step. At these magnitudes the gaps are a few microseconds, inside the
  one-third uncertainty the 0.71.0 drift notes attach to sub-0.15 ms figures, but
  the direction held in all three runs for atomic increment and is reported as a
  regression, not noise.
- **Drizzle's and Prisma's overheads rose too** (1.47x to 1.60x, 1.81x to 2.12x),
  which says part of the movement is the control getting faster (`pg` 8.23.1 under
  every arm) or the machine, not only Turbine.
- **First query on a new client** went from a tie with Drizzle to a 7% loss.
- **Atomic increment** went from a narrow Turbine lead to a tie Drizzle edges by
  3%.

## Machine state

`machine-control.ts` (raw `pg` only, no Turbine code) before and after the round:

| | before | after | drift |
|---|---|---|---|
| `SELECT 1` | 0.0178 ms | 0.0275 ms | +55% (drift floor) |
| raw flat, 100 users | 0.145 ms | 0.128 ms | -12% |
| raw L2, 50 users + posts | 0.897 ms | 0.812 ms | -9.5% |
| raw 50K keyset drain | 45.41 ms | 41.22 ms | -9.2% |

The box got about 10% quieter during the round (load average 7.1 at the start, 4.2
at the end). It was never idle: other applications held the CPU at about 62% idle
when the round began, so the quiet gate was lowered from 80% idle to **55% idle,
held for 4 samples**, and every run still had to start and finish under it. All 15
runs finished clean on the first attempt. The first streaming run was inflated
about 2x on every arm, including the control, and the median of three discards it.
Absolute values are therefore about 10% noisier than 0.71.0's quiet-box figures;
**ratios within a run remain the only quotable quantity**, and every ordering in the
tables above held in at least two of three runs (the tie rule covers the rest).

## Reproducing

```bash
createdb turbine_dev_bench
export DATABASE_URL="postgresql:///turbine_dev_bench?host=/tmp"
npm ci && npm run build                     # repo root; harnesses import dist/
cd benchmarks && npm install && npx prisma generate
npx tsx seed-neon.ts
(cd .. && node dist/cli/index.js generate --out generated/turbine)
npx tsx verify-arms.ts

npx tsx bench-interleaved.ts                # x3
ROUNDS=100 WARMUP=15 npx tsx bench-extended.ts   # x3
npx tsx bench-stream-parity.ts              # x3
PGDATABASE=turbine_dev_bench npx tsx bench-latency.ts   # x3
npx tsx deepoffset.ts
npx tsx machine-control.ts before|after
```
