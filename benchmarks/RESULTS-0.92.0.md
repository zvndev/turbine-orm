# Benchmarks, turbine-orm 0.92.0 vs Drizzle 0.45.3 vs Prisma 7.10.0

Measured 2026-10-15 on a dedicated machine by the repository's `benchmarks.yml` workflow (Grandprix run 38764376656, commit 8724ade). Every table the site publishes comes from this one round. The machine-readable copy the site imports is `results-0.92.0.json`.

## Summary

- **Ratio to the fastest ORM, 10 scenarios: Turbine 1.000x, Drizzle 1.494x, Prisma 2.132x.** Drizzle takes 1.49x as long as Turbine and Prisma 2.13x. Turbine wins or ties every scenario in this round against both, core and extra (24 of 24).
- **Overhead above hand-written `pg`, 8 scenarios with a control: Turbine 1.088x, Drizzle 1.590x, Prisma 2.133x.**
- **Nested reads got faster in 0.92.0.** The 50-users-with-posts read went from 1.470 ms to 1.075 ms, which is 1.26x the hand-written control (1.86x in 0.91.0). Relation rows now decode in one pass.
- **Bulk insert is the widest margin:** 1,000 rows in 5.176 ms, against 16.81 ms for Drizzle and 44.75 ms for Prisma.
- **Pipelining over a network:** five dashboard queries 25 ms from the database take 24.86 ms as one batch, against 171.03 ms for a Drizzle transaction.
- **Losses:** deep `OFFSET` pagination without `forceCustomPlan`, and per-row streaming against the Drizzle 1.0 release candidate.

## Setup

- **Machine:** AMD Ryzen 9 7950X host, 4-vCPU 16 GB Firecracker VM, client and PostgreSQL 17 (Docker) on the same VM over a Unix socket. The host runs nothing but CI VMs and was otherwise idle.
- **Versions:** turbine-orm 0.92.0, `drizzle-orm` 0.45.3 (and 1.0.0-rc.4 in the streaming harness), `@prisma/client` + `@prisma/adapter-pg` 7.10.0 with `relationJoins`, `pg` 8.23.1 under every arm, Node v24.18.0, PostgreSQL 17.11.
- **Data:** `seed-neon.ts` defaults (5 orgs, 1,000 users, 10,000 posts, 50,000 comments, 50 tags, 30,000 post_tags, 2,000 wide rows), then `ANALYZE`.
- **Runs:** `run-round.sh` runs `verify-arms.ts`, a machine control before and after, then three runs each of the main suite (200 rounds after 20 warmup), the extra scenarios, the streaming harness and the latency sweep, plus one deep-pagination isolation. Each figure is the median of the three runs' medians. Arm order rotates every round.
- **Machine drift:** SELECT 1 0.029 -> 0.033 (+10.7%, a 4 µs move on a 30 µs query); raw flat 100 users 0.167 -> 0.165 (-0.9%); raw L2 50 users + posts 1.028 -> 1.020 (-0.7%); raw 50K keyset drain 51.359 -> 50.652 (-1.4%).

## What changed since 0.91.0

The same workflow ran on 0.91.0 earlier the same day (run 38737935805). Turbine's nested reads, the scenarios 0.92.0 changed:

| Scenario | 0.91.0 ms | 0.92.0 ms | Change |
|---|---|---|---|
| findMany, 50 users + posts | 1.470 | 1.075 | -27% |
| findMany, 10 users + posts + comments | 0.795 | 0.620 | -22% |
| findUnique, user + posts + comments | 0.278 | 0.246 | -12% |
| to-one, 500 posts + author | 1.774 | 1.555 | -12% |
| many-to-many, 200 posts + tags | 1.642 | 1.477 | -10% |

Other scenarios moved by up to about 7% in either direction between the two rounds, the hand-written control included, so differences that size are between-round variation rather than a change in Turbine.

## The hand-written control does the same work

Where a query returns nested rows (the 50-users-with-posts read and the to-one read), the control decodes them into objects with `Date` timestamps, as every ORM arm does. Large flat reads still beat the control, for the reason under the extra scenarios.

## Results, main suite

Medians in ms.

| Scenario | Turbine | Drizzle | Prisma | raw pg | Turbine / raw |
|---|---|---|---|---|---|
| findMany, 100 users | 0.208 | 0.310 | 0.352 | 0.201 | 1.03x |
| findMany, 50 users + posts | 1.075 | 1.485 | 2.955 | 0.854 | 1.26x |
| findMany, 10 users + posts + comments | 0.620 | 0.884 | 2.270 | n/a | n/a |
| findUnique by primary key | 0.090 | 0.149 | 0.179 | 0.075 | 1.20x |
| findUnique, user + posts + comments | 0.246 | 0.460 | 0.599 | n/a | n/a |
| count, all users | 0.079 | 0.114 | 0.169 | 0.078 | 1.01x |
| stream 50,000 comments, per row *(tie)* | 55.02 | 55.13 | 82.84 | 57.03 | 0.96x |
| atomic increment | 0.164 | 0.182 | 0.259 | 0.135 | 1.21x |
| pipeline, 5-query batch | 0.343 | 0.701 | 0.784 | 0.360 | 0.95x |
| hot findUnique, rotating ids | 0.078 | 0.145 | 0.158 | 0.070 | 1.11x |

## Results, extra scenarios

| Scenario | Turbine | Drizzle | Prisma | raw pg | Turbine / raw |
|---|---|---|---|---|---|
| findMany, 5,000 comments | 3.894 | 5.874 | 6.924 | 4.864 | 0.80x |
| findMany, 50,000 comments | 42.39 | 70.22 | 81.05 | 53.86 | 0.79x |
| findMany, 1,000 rows x 39 columns | 4.392 | 6.947 | 7.304 | 4.108 | 1.07x |
| list page, newest first | 0.331 | 0.402 | 0.401 | 0.279 | 1.19x |
| createMany, 1,000 rows | 5.176 | 16.81 | 44.75 | 3.472 | 1.49x |
| update by primary key | 0.166 | 0.184 | 0.263 | 0.138 | 1.20x |
| upsert on a unique column *(tie)* | 0.210 | 0.214 | 0.282 | 0.146 | 1.44x |
| delete by unique column *(tie)* | 0.155 | 0.162 | 0.250 | 0.122 | 1.27x |
| to-one, 500 posts + author | 1.555 | 1.992 | 2.174 | 1.265 | 1.23x |
| many-to-many, 200 posts + tags | 1.477 | 2.487 | 3.810 | n/a | n/a |
| relation `_count`, 100 users | 0.376 | 0.492 | 0.527 | n/a | n/a |
| relation filter (`some`), 100 users | 0.282 | 0.409 | 0.464 | 0.319 | 0.88x |
| groupBy + `having`, 5 groups | 0.968 | 1.005 | 1.095 | 0.929 | 1.04x |
| first query on a new client *(tie)* | 0.501 | 0.502 | 0.685 | n/a | n/a |

Large reads beat the control (50,000 rows) because Turbine parses `timestamptz` with its own faster parser while the control uses node-postgres's default. Against a control given the same parser, Turbine is slower. Quote this as faster than node-postgres's default parsing, never as faster than hand-written SQL.

## Streaming

Draining 50,000 rows in batches of 1,000. Turbine reads through a server-side cursor; the Drizzle arms and the control page by key.

| Arm | Median ms |
|---|---|
| Drizzle 1.0.0-rc.4 | 46.99 |
| Turbine findManyStreamBatches | 48.22 |
| Turbine findManyStream (per row) | 52.54 |
| hand-written pg, keyset pages | 54.43 |
| Drizzle 0.45.3 | 54.96 |

## Deep pagination

A sorted 20-row page at offset 9,000. Turbine 0.759 ms, with `forceCustomPlan` 0.568 ms; Drizzle 0.620; Prisma 0.614; control 0.398. A named prepared statement gets a generic plan that cannot see the bound offset; `forceCustomPlan` sends it unnamed.

## Latency sweep

A five-query dashboard with simulated round-trip time added by a local proxy.

| Added RTT | Turbine pipeline | Drizzle transaction | Prisma $transaction |
|---|---|---|---|
| 0 ms | 0.428 | 1.070 | 1.206 |
| 1 ms | 2.673 | 16.15 | 16.35 |
| 5 ms | 4.771 | 30.54 | 30.76 |
| 25 ms | 24.86 | 171.03 | 171.14 |

## Not rerun

The real-network (Neon) table was not rerun this round. `RESULTS-NETWORK-0.78.0.md` stays as it is, labelled 0.78.0.

## Reproducing

`gh workflow run benchmarks.yml` runs this round on a fresh VM and uploads every log plus `results.json` as an artifact. To run it locally, see `benchmarks/README.md` and `run-round.sh`.
