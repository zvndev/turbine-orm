# The extended benchmark suite

Companion to `RESULTS-0.66.0.md`, which reports ten scenarios. That set is
skewed: three of the ten are `findUnique`, the largest non-stream result is 100
rows, nothing measures a write other than one atomic increment, and nothing
measures aggregation, to-one relations, many-to-many, or relation filters.
Worse, every number in it is measured over a Unix socket, where a round trip is
about 0.05 ms.

`GAP-ANALYSIS-0.66.0.md` ended with the claim that fixing the suite would
probably move the picture more than fixing the code. That turned out to be
right, and in both directions: it found a loss the old suite could not see, and
it overturned a recommendation the old suite would have produced.

## What was added

**Fixture** (`seed-neon.ts`, re-run to rebuild). The existing tables are
unchanged and still assert their own counts before anything is reported.

| table | rows | why |
|---|---|---|
| `tags`, `post_tags` | 50, 30,000 | a real many-to-many through a junction |
| `bench_wide` | 2,000 x 39 columns | per-COLUMN costs, invisible on a 5-column row |
| `bench_writes` | scratch | writes that must not grow a table a read scenario measures |

**Harness** (`bench-harness.ts`). Extracted from `bench-interleaved.ts` rather
than copied, so the two halves of the suite cannot drift into measuring
slightly differently. It gains an untimed `setup` hook per arm, which is what
makes destructive scenarios measurable: a delete benchmark needs a row to
delete and a bulk insert needs an empty table, and neither is the thing being
measured.

**Scenarios** (`bench-extended.ts`, `GROUPS=large,list,relations,agg,writes,strategy,cold`).

**Latency** (`bench-latency.ts`). A TCP proxy in-process listens on loopback,
forwards to the PostgreSQL unix socket, and delays every chunk in each
direction by RTT/2. Delaying chunks models LATENCY and not bandwidth or jitter:
chunk spacing is preserved, so a large result costs one extra round trip rather
than one per chunk. Nagle is disabled on both sockets. The 0 ms row runs
through the proxy too, so it is the proxy's own overhead and every comparison
in the table is like for like.

## Method notes that constrain how to read this

- Same machine and database as the 0.66.0 run: local PostgreSQL 17.9
  (Homebrew), unix socket, `turbine_bench_066`.
- 100 interleaved rounds per scenario after 15 warmup, arm order rotated each
  round, medians reported. Heavy scenarios scale down (50,000-row reads run 10
  rounds, `createMany` 20).
- **The drift floor was 0.018 ms** across this run (`SELECT 1` median 0.0150 /
  0.0297 / 0.0113 at head / mid / tail). **A difference smaller than that is not
  a result**, and several below are. They are called out where they occur rather
  than reported as wins.
- Where an ORM cannot express a shape the way the others do, its arm is written
  the way that ORM's own documentation prescribes and the scenario carries a
  note. Those notes are printed with the numbers, not buried here.

---

## Results

### Large result sets

The headline suite's biggest non-stream read is 100 rows, which is far too few
for per-row decode cost to appear at all. This is where it appears.

| scenario | Turbine | Prisma 7.9 | Drizzle 0.45 | raw pg |
|---|---|---|---|---|
| findMany, 5,000 comments | **4.462 ms** (1.07x raw) | 5.156 (1.24x) | 4.837 (1.16x) | 4.174 |
| findMany, 50,000 comments | **44.751 ms** (1.07x raw) | 55.451 (1.33x) | 50.391 (1.20x) | 41.829 |
| findMany, 1,000 rows x 39 columns | **4.551 ms** (1.21x raw) | 6.087 (1.61x) | 6.118 (1.62x) | 3.772 |

Turbine is fastest on all three and runs within 7% of hand-written `pg` on
50,000 rows while the others are 20% and 33% above it. This is the single
biggest thing the old suite was hiding, and it is the same property the
streaming analysis measured directly: our row decode is the cheapest of the
three, and it only shows up once there are enough rows for it to matter.

The wide-table row isolates per-COLUMN cost specifically: 39 columns over 1,000
rows, where Prisma and Drizzle both land at ~1.6x raw and Turbine at 1.21x.

### List pages, and a real loss

| scenario | Turbine | Prisma 7.9 | Drizzle 0.45 | raw pg |
|---|---|---|---|---|
| published posts in org 1, newest first, page 3 | **0.212 ms** | 0.238 | 0.258 | 0.186 |
| the same query at offset 9,000 | 0.549 ms | **0.318** | 0.341 | 0.276 |
| ...with `forceCustomPlan: true` | **0.292 ms** | | | |

**Deep pagination is a genuine Turbine loss, and it is not our code.** Turbine
names its prepared statements, which is exactly what wins the hot small-query
scenarios, because node-postgres skips `Parse` only for a statement already
parsed BY NAME. PostgreSQL promotes a named statement to a value-blind GENERIC
plan on its sixth execution, and with `OFFSET` bound as a parameter that generic
plan cannot know the offset is 9,000.

Measured separately, and this is what settles it:

| arm | median |
|---|---|
| Turbine, named (default) | 0.586 ms |
| Turbine, `forceCustomPlan: true` | 0.321 ms |
| raw pg, unnamed | 0.307 ms |
| raw pg, **named** | 0.563 ms |

A hand-written raw `pg` query with a statement name reproduces the loss
exactly. Drizzle and Prisma avoid it only because they never name statements,
which is also why they never get the `Parse` skip that makes Turbine the
fastest arm on `hot findUnique` (0.029 ms against Drizzle's 0.073 ms in the
headline suite). It is one trade, visible in both directions for the first
time, with a per-query remedy that lands within 6% of raw.

### Relations

| scenario | Turbine | Prisma 7.9 | Drizzle 0.45 | raw pg |
|---|---|---|---|---|
| to-one, 500 posts + author | **1.419 ms** | 1.521 | 1.485 | 1.009 |
| many-to-many, 200 posts + tags | **2.341 ms** | 4.983 | 2.902 | n/a |
| relation `_count`, 100 users + post count | **0.240 ms** | 0.299 | 0.357 | n/a |
| relation filter, 100 users with a published post | **0.200 ms** | 0.268 | 0.252 | 0.209 |

Many-to-many is the widest margin in the suite that is not a write: 2.1x
Prisma and 1.24x Drizzle. It is also the one place the RESULT SHAPES differ,
and that difference is the finding rather than a caveat. Turbine derives the
junction from its two foreign keys and returns `post.tags[]`. Prisma and
Drizzle both need the junction as an explicit model or table here, so each
returns `post.postTags[].tag`, one level deeper, and the caller flattens it.

The relation-filter row is at raw parity (0.200 against 0.209, a difference
inside the drift floor, so read it as a tie with hand-written SQL rather than
as beating it).

The `_count` and relation-filter rows both have a note in the output: Drizzle's
relational API has neither primitive, so those arms are hand-written subqueries
through its query builder, which is what its docs prescribe.

### Aggregation

| scenario | Turbine | Prisma 7.9 | Drizzle 0.45 | raw pg |
|---|---|---|---|---|
| groupBy org, count + avg, having count > 100 | **0.701 ms** | 0.756 | 0.720 | 0.682 |

All three are within a few percent of raw. The 0.53.0 groupBy/HAVING machinery
costs 0.019 ms over hand-written SQL, and the gap to Drizzle is itself at the
drift floor. Report this as "no ORM has a problem here", not as a win.

### Writes

| scenario | Turbine | Prisma 7.9 | Drizzle 0.45 | raw pg |
|---|---|---|---|---|
| createMany, 1,000 rows | **6.780 ms** (1.38x raw) | 39.530 (8.06x) | 17.031 (3.47x) | 4.903 |
| update by primary key | 0.094 ms | 0.141 | 0.103 | 0.081 |
| upsert on a unique column | 0.105 ms | 0.140 | 0.113 | 0.082 |
| delete by unique column | 0.084 ms | 0.123 | 0.086 | 0.068 |

**Bulk insert is the largest margin in the whole suite: 5.8x Prisma and 2.5x
Drizzle**, and Turbine is the only arm within 2x of a hand-written `UNNEST`
insert. Nothing in the published suite came close to exercising this.

The three single-row write rows are honest ties between Turbine and Drizzle:
the differences are 0.009, 0.008 and 0.002 ms against a 0.018 ms drift floor.
Both are clearly ahead of Prisma, which is 1.7x to 1.8x raw on all three.

### Relation strategies (Turbine only)

| shape | join | batched | auto (default) | flatten |
|---|---|---|---|---|
| to-many, 200 users + posts | 4.734 ms | **3.541** | 4.746 | n/a |
| to-one, 500 posts + author | 2.658 ms | **1.048** | 2.650 | 1.734 |

Read this row with the latency table below, not on its own. See "What the
latency arm overturned".

`flatten` is the durable result here: 1.53x faster than `join` on the to-one
shape, and unlike `batched` it does not spend an extra round trip (it is one
statement, a `LEFT JOIN`), so the win is not a socket artifact. It is an
explicit opt-in that `auto` never selects, so every user on the default is
leaving it on the table for to-one relations.

### Cold start

First query on a fresh client, with the connection established untimed so what
is measured is statement building, `Parse`, and lazy initialisation rather than
the driver's TCP handshake. 80 rounds.

| Turbine | Prisma 7.9 | Drizzle 0.45 |
|---|---|---|
| **0.314 ms** | 0.518 | 0.343 |

Turbine and Drizzle are within 0.029 ms of each other and two earlier runs at
lower round counts disagreed about their order, so treat them as tied. Prisma
is consistently ~1.6x both.

---

## What the latency arm overturned

Medians in ms, through the delay proxy at four round-trip times.

**findUnique by PK**

| arm | 0 ms | 1 ms | 5 ms | 25 ms |
|---|---|---|---|---|
| Turbine | 0.168 | 2.572 | 4.888 | 26.509 |
| Prisma 7 | 0.253 | 2.751 | 5.146 | 26.828 |
| Drizzle | 0.236 | 2.642 | 5.025 | 26.753 |
| Raw | 0.159 | 2.571 | 4.873 | 26.526 |

**L2, 50 users + posts**

| arm | 0 ms | 1 ms | 5 ms | 25 ms |
|---|---|---|---|---|
| Turbine `join` | 2.527 | 5.115 | 7.809 | 29.487 |
| Turbine `batched` | **1.407** | 6.807 | 11.343 | **54.003** |
| Turbine `auto` | 2.485 | 5.603 | 8.168 | 28.529 |
| Prisma 7 | 4.522 | 7.629 | 9.762 | 30.653 |
| Drizzle | 1.897 | 4.620 | 7.258 | 27.856 |

**Dashboard, 5 independent queries**

| arm | 0 ms | 1 ms | 5 ms | 25 ms |
|---|---|---|---|---|
| Turbine `pipeline` | **0.395** | **3.059** | **5.583** | **26.830** |
| Prisma 7 `$transaction` | 1.133 | 18.346 | 35.169 | 183.841 |
| Drizzle transaction | 1.053 | 18.349 | 34.823 | 184.030 |

Three findings, and the first two were invisible to every previous measurement
in this repository.

**1. `batched` inverts, and the socket-only suite would have recommended it.**
On a socket it is the fastest strategy by 1.34x. By 1 ms of round-trip time it
is already slower than `join`, and at 25 ms it is 1.83x slower. It buys its win
by spending an extra round trip per relation to avoid building JSON on the
server, and that trade only pays when a round trip is nearly free. `auto`
choosing `join` here is correct for anything on a real link, and the strategy
table above would have said the opposite. This is the concrete reason
`autoRoundTripMs` exists in the client config, and the first measurement that
shows the break-even moving.

**2. `pipeline` is Turbine's largest structural advantage, and the socket
understated it by 2.5x.** It is one round trip against roughly seven (BEGIN,
five queries, COMMIT). At 0 ms it is 2.7x faster than Drizzle; at 25 ms it is
**6.9x**. Neither Prisma nor Drizzle has independent-query pipelining, so this
gap grows with every millisecond of distance between the app and the database,
which is the direction production actually lies.

**3. Small-read wins converge to nothing.** At 25 ms every `findUnique` arm is
within 0.3 ms of every other and of raw `pg`. Turbine's 1.5x advantage on hot
small reads is real and it is worth having, but it is a local-deployment and
low-latency-link result, and publishing it without this row overstates it.

**Limitation, stated plainly.** The proxy models latency, not bandwidth. The
34% payload reduction that `jsonEncoding: 'positional'` buys (see
`GAP-ANALYSIS-0.66.0.md`) therefore does not show up in this table at all, and
would only appear on a bandwidth-constrained link. If anything, the case for
that change is stronger than these numbers can show.

---

## Where this leaves the picture

Counting the two suites together, Turbine is fastest on 17 of the 22 shapes now
measured. The exceptions are worth naming precisely, because three of them are
one cause each rather than a general weakness:

1. **L2 and L3 nested reads.** One encoding default, already analysed and
   already implemented as an option. See `GAP-ANALYSIS-0.66.0.md`.
2. **Streaming.** Partly fixed since that analysis (the wasted speculative
   fetch), partly an honest trade for a cursor snapshot.
3. **Deep pagination.** The generic-plan cliff, a consequence of naming
   prepared statements, with a per-query remedy that closes it completely.
4. **`batched` over a network.** Not a defect: the default already avoids it.
5. **Cold start against Drizzle.** A tie within noise.

The suite is now honest about where it is measured. The largest remaining
methodological gap is bandwidth, which the latency proxy deliberately does not
model, and which is the one axis on which Turbine's payload work would pay off
most.
