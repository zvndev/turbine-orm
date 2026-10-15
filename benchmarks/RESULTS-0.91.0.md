# Benchmarks, turbine-orm 0.91.0 vs Drizzle 0.45.3 vs Prisma 7.10.0

Measured 2026-10-15 on a dedicated machine by the repository's `benchmarks.yml` workflow (Grandprix run 38737935805). Every table the site publishes comes from this one round. The machine-readable copy the site imports is `results-0.91.0.json`.

## Summary

- **Ratio to the fastest ORM, 10 scenarios: Turbine 1.000x, Drizzle 1.404x, Prisma 2.005x.** Drizzle takes 1.40x as long as Turbine and Prisma 2.00x. Turbine wins or ties every core scenario against Drizzle and wins all ten against Prisma.
- **Overhead above hand-written `pg`, 8 scenarios with a control: Turbine 1.141x, Drizzle 1.609x, Prisma 2.165x.**
- **Bulk insert is the widest margin:** 1,000 rows in 5.183 ms, against 16.66 ms for Drizzle and 44.69 ms for Prisma.
- **Pipelining over a network:** five dashboard queries 25 ms from the database take 24.87 ms as one batch, against 171.03 ms for a Drizzle transaction.
- **Losses:** deep `OFFSET` pagination without `forceCustomPlan`, and per-row streaming against the Drizzle 1.0 release candidate.

## Setup

- **Machine:** AMD Ryzen 9 7950X host, 4-vCPU 16 GB Firecracker VM, client and PostgreSQL 17 (Docker) on the same VM over a Unix socket. The host runs nothing but CI VMs and was otherwise idle.
- **Versions:** turbine-orm 0.91.0, `drizzle-orm` 0.45.3 (and 1.0.0-rc.4 in the streaming harness), `@prisma/client` + `@prisma/adapter-pg` 7.10.0 with `relationJoins`, `pg` 8.23.1 under every arm, Node v24.18.0, PostgreSQL 17.11.
- **Data:** `seed-neon.ts` defaults (5 orgs, 1,000 users, 10,000 posts, 50,000 comments, 50 tags, 30,000 post_tags, 2,000 wide rows), then `ANALYZE`.
- **Runs:** `run-round.sh` runs `verify-arms.ts`, a machine control before and after, then three runs each of the main suite (200 rounds after 20 warmup), the extra scenarios, the streaming harness and the latency sweep, plus one deep-pagination isolation. Each figure is the median of the three runs' medians. Arm order rotates every round.
- **Machine drift:** SELECT 1 0.035 -> 0.030 (-14.4%); raw flat 100 users 0.166 -> 0.164 (-1.3%); raw L2 50 users + posts 1.022 -> 1.018 (-0.4%); raw 50K keyset drain 50.601 -> 50.353 (-0.5%).

## The hand-written control does the same work

Where a query returns nested rows (the 50-users-with-posts read and the to-one read), the control decodes them into objects with `Date` timestamps, as every ORM arm does. Until this round it returned bare JSON arrays with timestamps as strings, which bounded a cheaper job than the one being measured: measured on this machine, that moved L2 from 2.23x to 1.86x and the overhead geomean from 1.158x to 1.141x.

The 0.71.0 round published 1.08x, adjusted by hand because its L2 control did more work than Turbine (`json_build_object` against Turbine's array encoding). The figure above is not adjusted.

L2 is still the outlier: Turbine and Drizzle both take about 1.9x the control there, while every other controlled scenario sits between 0.91x and 1.22x. Without L2 the geomean is about 1.06x. Where that time goes is under investigation.

## Results, main suite

Medians in ms.

| Scenario | Turbine | Drizzle | Prisma | raw pg | Turbine / raw |
|---|---|---|---|---|---|
| findMany, 100 users | 0.204 | 0.307 | 0.349 | 0.198 | 1.03x |
| findMany, 50 users + posts *(tie)* | 1.470 | 1.488 | 2.930 | 0.791 | 1.86x |
| findMany, 10 users + posts + comments | 0.795 | 0.899 | 2.303 | n/a | n/a |
| findUnique by primary key | 0.090 | 0.151 | 0.179 | 0.074 | 1.22x |
| findUnique, user + posts + comments | 0.278 | 0.467 | 0.599 | n/a | n/a |
| count, all users | 0.080 | 0.115 | 0.170 | 0.077 | 1.04x |
| stream 50,000 comments, per row *(tie)* | 55.27 | 57.33 | 85.99 | 56.38 | 0.98x |
| atomic increment | 0.175 | 0.185 | 0.274 | 0.143 | 1.22x |
| pipeline, 5-query batch | 0.333 | 0.707 | 0.782 | 0.365 | 0.91x |
| hot findUnique, rotating ids | 0.078 | 0.143 | 0.159 | 0.072 | 1.08x |

## Results, extra scenarios

| Scenario | Turbine | Drizzle | Prisma | raw pg | Turbine / raw |
|---|---|---|---|---|---|
| findMany, 5,000 comments | 3.882 | 5.867 | 7.001 | 4.849 | 0.80x |
| findMany, 50,000 comments | 43.42 | 71.25 | 82.62 | 55.44 | 0.78x |
| findMany, 1,000 rows x 39 columns | 4.379 | 6.925 | 7.242 | 4.127 | 1.06x |
| list page, newest first | 0.321 | 0.395 | 0.401 | 0.275 | 1.17x |
| createMany, 1,000 rows | 5.183 | 16.66 | 44.69 | 3.511 | 1.48x |
| update by primary key | 0.159 | 0.172 | 0.250 | 0.136 | 1.17x |
| upsert on a unique column *(tie)* | 0.210 | 0.210 | 0.281 | 0.154 | 1.36x |
| delete by unique column *(tie)* | 0.167 | 0.167 | 0.258 | 0.128 | 1.30x |
| to-one, 500 posts + author | 1.774 | 1.936 | 2.302 | 1.285 | 1.38x |
| many-to-many, 200 posts + tags | 1.642 | 2.498 | 3.821 | n/a | n/a |
| relation `_count`, 100 users | 0.379 | 0.486 | 0.520 | n/a | n/a |
| relation filter (`some`), 100 users | 0.285 | 0.408 | 0.461 | 0.319 | 0.89x |
| groupBy + `having`, 5 groups | 0.916 | 0.971 | 1.077 | 0.894 | 1.02x |
| first query on a new client *(tie)* | 0.502 | 0.495 | 0.691 | n/a | n/a |

Large reads beat the control (50,000 rows: 43.42 ms against 55.44 ms) because Turbine parses `timestamptz` with its own faster parser while the control uses node-postgres's default. Against a control given the same parser, Turbine is slower. Quote this as faster than node-postgres's default parsing, never as faster than hand-written SQL.

## Streaming

Draining 50,000 rows in batches of 1,000. Turbine reads through a server-side cursor; the Drizzle arms and the control page by key.

| Arm | Median ms |
|---|---|
| Drizzle 1.0.0-rc.4 | 47.85 |
| Turbine findManyStreamBatches | 48.07 |
| Turbine findManyStream (per row) | 52.28 |
| hand-written pg, keyset pages | 54.50 |
| Drizzle 0.45.3 | 55.51 |

## Deep pagination

A sorted 20-row page at offset 9,000. Turbine 0.764 ms, with `forceCustomPlan` 0.567 ms; Drizzle 0.622; Prisma 0.616; control 0.393. A named prepared statement gets a generic plan that cannot see the bound offset; `forceCustomPlan` sends it unnamed.

## Latency sweep

A five-query dashboard with simulated round-trip time added by a local proxy.

| Added RTT | Turbine pipeline | Drizzle transaction | Prisma $transaction |
|---|---|---|---|
| 0 ms | 0.438 | 1.062 | 1.233 |
| 1 ms | 2.664 | 16.16 | 16.27 |
| 5 ms | 4.726 | 30.49 | 30.68 |
| 25 ms | 24.87 | 171.03 | 171.12 |

## Not rerun

The real-network (Neon) table was not rerun this round. `RESULTS-NETWORK-0.78.0.md` stays as it is, labelled 0.78.0.

## Reproducing

`gh workflow run benchmarks.yml` runs this round on a fresh VM and uploads every log plus `results.json` as an artifact. To run it locally, see `benchmarks/README.md` and `run-round.sh`.
