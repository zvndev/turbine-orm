# Real-network results, turbine-orm 0.78.0

Every other timing in this repository is measured over a Unix socket. The one file
that varies latency, `bench-latency.ts`, **models** it with an in-process TCP proxy
that delays each chunk by RTT/2. This is the first run against a real network link.

- **Harness:** `benchmarks/bench-network.ts` (`DATABASE_URL=<direct endpoint> npx tsx benchmarks/bench-network.ts`)
- **Database:** Neon PostgreSQL 17.11, `aws-us-east-1`, dedicated branch, direct
  (non-pooler) endpoint. The script refuses a pooled endpoint using the same
  `detectPooler` the CLI uses, because a pooler multiplexes backends and makes
  per-connection timing meaningless.
- **Client:** Apple Silicon MacBook Pro, Node v26.8.1, turbine-orm 0.78.0.
- **Link:** RTT median **22.17 ms** (medians of three runs: 23.23 / 22.17 / 20.63).
- **Fixture:** 1,000 users / 10,000 posts / 50,000 comments / 5 organizations.
- **Method:** 40 rounds after 8 warmup, arms interleaved and rotated every round
  (`Bench.interleave`, the same harness the socket benchmarks use). Each figure below
  is the **median of the three runs' medians**. Paginated queries carry an explicit
  `orderBy` so the page, and therefore the payload, is identical every round.

## Results

| Scenario | Arm | Median (ms) | Ratio |
|---|---|---:|---:|
| L2 nested, 200 users + posts | `positional` | **33.447** | 1.00x |
| | `object` | 36.486 | 1.09x |
| L3 nested, 50 users + posts + comments | `positional` | **35.293** | 1.00x |
| | `object` | 38.799 | 1.10x |
| 5-query dashboard batch | `pipeline()` | **24.071** | 1.00x |
| | sequential | 172.300 | 7.16x |
| Relation strategy, 200 users + posts | `join` | **34.729** | 1.00x |
| | `batched` | 57.922 | 1.67x |
| findUnique by primary key | raw `pg` | **22.328** | 1.00x |
| | turbine | 23.669 | 1.06x |

Relation payload over 200 parents: object **272.6 kB**, positional **216.0 kB**,
**20.8% smaller**. Every direction above reproduced in all three runs.

## What this settles that the proxy could not

**1. The positional-encoding saving converts to wall clock.** The published tables
state plainly that the payload reduction "does not appear in these tables at all",
because the proxy models latency and not bandwidth. On a real link it appears:
**9.1% on the L2 tree and 9.9% on L3**, from a 20.8% smaller payload. This is the
first measurement of the headline change of 0.71 on the axis where it pays.

Note the payload saving is **shape-dependent**: 20.8% here against the 34% measured
on the site's own tree. The ratio is set by how much of each row is key names, so a
tree with short values and long keys saves more. Quote it per shape, never as a
constant.

**2. `pipeline()` at 7.16x, against a modelled 6.9x.** One round trip versus roughly
seven. The proxy's prediction was slightly conservative and is otherwise confirmed.

**3. `relationLoadStrategy: 'batched'` really does invert.** It is fastest on a socket
and is **1.67x slower** here. The socket-only recommendation would have been actively
wrong for anyone on a network, which is nearly everyone. Confirmed, not merely modelled.

**4. Point reads converge at the round trip.** Turbine is within **6%** of hand-written
`pg`, both essentially the RTT floor. Turbine's ~1.5x advantage on hot small reads is
real and is a low-latency-link result, exactly as the socket page says.

## Caveats

- **One link, one region.** Client in one place, database in `us-east-1`. A different
  RTT moves every absolute number; the ratios are what travel.
- **Variance is higher than on a socket.** p95 runs to ~100 ms against a ~33 ms median
  on several arms, which is serverless-database behaviour (autoscaling, cold pages),
  not client noise. Medians across three runs are stable to within a few percent;
  single-round figures from this environment are not meaningful.
- **Latency, not bandwidth-constrained.** This link is fast. On a slower or metered
  link the encoding saving should grow, since it is a byte count rather than a
  round-trip count.
- **No competitor arms.** This run measures Turbine against itself and against raw
  `pg`. It is not a cross-ORM comparison and must not be quoted as one.
