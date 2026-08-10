# The three scenarios Drizzle wins, measured rather than reasoned about

Companion to `RESULTS-0.66.0.md`. That file reports wall-clock for ten
scenarios. This one takes the three where Drizzle 0.45 is ahead and splits each
wall number into the parts that have different fixes, so a proposal can be
sized before it is written.

Same machine and database as the 0.66.0 run: local PostgreSQL 17.9 (Homebrew),
Unix socket, `turbine_bench_066` (1,000 users / 10,000 posts / 50,000 comments).

Reproduce with the scripts added alongside this file:

```bash
DATABASE_URL="postgresql:///turbine_bench_066?host=/tmp" npx tsx split-l2-l3.ts
DATABASE_URL="postgresql:///turbine_bench_066?host=/tmp" npx tsx split-stream.ts
DATABASE_URL="postgresql:///turbine_bench_066?host=/tmp" npx tsx split-stream2.ts
DATABASE_URL="postgresql:///turbine_bench_066?host=/tmp" npx tsx split-parserow.ts
```

## Method, and one thing it corrects

A wall-clock number folds together three costs with three different fixes:
server planning and execution, bytes on the wire, and client-side decode. The
scripts separate them:

- **Server** is `EXPLAIN (ANALYZE, TIMING OFF)`'s own reported planning plus
  execution time. `TIMING OFF` matters: per-node instrumentation is charged per
  node *execution*, and the two plan shapes under comparison do not execute the
  same number of nodes, so leaving it on biases the comparison toward whichever
  shape has fewer.
- **Wire** is measured through a pool whose type parsers are the identity
  function, so every cell is the raw text Postgres actually sent. Reading a
  `json` column through the default parser and stringifying the result back does
  not measure this, it measures `JSON.stringify` of a parsed object, and the
  first version of this script did exactly that and reported Drizzle sending
  *more* bytes than Turbine. It sends fewer.
- **Client** is the residual.

Wall time is interleaved: every arm runs once per round with the start order
rotated per round, median across rounds, matching `bench-interleaved.ts`.

---

## Scenario 1 and 2: nested relations (L2 and L3)

### What is being compared

**L2**, `findMany` of 50 users each with all their posts. **L3**, `findMany` of
10 users, each with 5 posts, each post with all its comments.

Turbine emits a correlated subquery per relation:

```sql
SELECT "users"."id", ..., (
  SELECT COALESCE(json_agg(json_build_object(
    'id', t0."id"::text, 'userId', t0."user_id"::text, 'orgId', t0."org_id"::text,
    'title', t0."title", 'content', t0."content", 'published', t0."published",
    'viewCount', t0."view_count", 'createdAt', t0."created_at", 'updatedAt', t0."updated_at"
  )), '[]'::json)
  FROM "posts" t0 WHERE t0."user_id" = "users"."id"
) AS "posts"
FROM "users" LIMIT $1
```

Drizzle emits a `LEFT JOIN LATERAL` with a positional array:

```sql
select "users"."id", ..., "users_posts"."data" as "posts"
from "users" left join lateral (
  select coalesce(json_agg(json_build_array(
    "users_posts"."id", "users_posts"."user_id", ..., "users_posts"."updated_at"
  )), '[]'::json) as "data"
  from "posts" "users_posts" where "users_posts"."user_id" = "users"."id"
) "users_posts" on true limit $1
```

Two differences, and it matters which one is responsible.

### The split

Turbine appears twice: as shipped (`jsonEncoding: 'object'`, the default) and
with `jsonEncoding: 'positional'`, which has been in the package since 0.26.0
and emits exactly the `json_build_array` shape Drizzle uses. That isolates the
encoding from the plan shape.

**L2, 50 users + posts**

| arm | server | wall | client | wire |
|---|---|---|---|---|
| Turbine `object` (default) | 0.970 ms | 2.389 ms | 1.419 ms | 153.8 KB |
| Turbine `positional` | 0.424 ms | **1.732 ms** | 1.308 ms | 102.1 KB |
| Drizzle | 0.363 ms | 1.791 ms | 1.428 ms | 99.2 KB |

**L3, 10 users to posts to comments**

| arm | server | wall | client | wire |
|---|---|---|---|---|
| Turbine `object` (default) | 0.376 ms | 0.751 ms | 0.375 ms | 57.4 KB |
| Turbine `positional` | 0.237 ms | **0.601 ms** | 0.364 ms | 38.9 KB |
| Drizzle | 0.240 ms | 0.748 ms | 0.508 ms | 37.1 KB |

Confirmed stable across three independent runs at 120 and 300 rounds. The
absolute numbers move between runs, the ordering does not.

### What this says

**The plan shape is a wash.** With the encoding held equal, server time is
0.424 vs 0.363 ms (L2) and 0.237 vs 0.240 ms (L3). A correlated `SubPlan` and a
`Nested Loop Left Join` over a lateral cost the same here, and PostgreSQL plans
both as an index scan on the FK per parent row. **There is no case for
rewriting the relation generator to emit `LATERAL`.** That was the obvious
hypothesis going in and the measurement does not support it.

**Our row parser is already faster than Drizzle's.** Client-side, Turbine is
1.308 vs 1.428 ms on L2 and 0.364 vs 0.508 ms on L3, while decoding *more*
bytes. Nothing to fix here.

**The entire gap is the key strings.** `json_build_object` writes every key
name into every nested object of every row. On L2 that is 34% of the payload
(153.8 KB down to 102.1 KB) and it costs 0.55 ms of server time, which is
larger than the entire published gap to Drizzle. Switching encodings turns both
losses into wins.

The residual 2.9 KB between Turbine `positional` and Drizzle on L2 is the
`::text` casts on the three `bigint` columns. That is the 0.51.0 JSON-wire
value-fidelity feature: `json_build_object` renders `int8` and `numeric`
differently from what the driver hands back for the same column, so Turbine
casts to text and re-runs the driver's own parser on the way out. Drizzle does
not, and loses precision above 2^53 in a nested relation. That is a correctness
cost we are choosing, and it is 2.8% of the payload.

### Hypothesis: make positional the default on PostgreSQL

The change is not "write new SQL", it is "flip a default that already exists",
which is why it is worth taking seriously. It is also not free, and four things
have to be resolved first.

**1. It cannot be a global default.** `positional` is Postgres-only and throws
`UnsupportedFeatureError` (E017) on any other engine when a `with` clause is
present. The default has to be dialect-conditional, and per the rule in
CLAUDE.md it must gate on `dialect.name === 'postgresql'`, never on hook
presence: every engine dialect is built by spreading `postgresDialect`, so
`buildJsonArray` is defined on all of them and a presence check would silently
enable this on SQLite. That is the same trap `buildPartitionLimit` hit live in
0.66.0.

**2. It silently disables `flatten`.** `planFlatten` refuses the whole plan when
`jsonEncoding === 'positional'` (query/builder.ts, the `queryLevelBlock`
branch), because a flattened relation emits no JSON to encode and the two were
never composed. Flipping the default would therefore turn `flatten` off for
every caller who explicitly opted into it. The blast radius is bounded, since
`flatten` is an explicit opt-in that `'auto'` never selects, and the caller
gets a once-only dev warning. It is still a silent behaviour change for the
people most likely to care about relation performance, so the ordering should
be: compose the two first, or make the default resolution explicitly prefer
`flatten` when the caller asked for it.

**3. The failure mode gets worse.** Today a drift between the emitted column
list and the recorded key list is a loud error, because the keys travel with
the data. Positional decoding maps array positions back to names from a
build-time `RelationShape`, so the same drift becomes a silent wrong-field bug.
Current coverage is 7 unit tests and 6 integration parity cases asserting deep
equality against the object encoding. That is reasonable but it is
example-based. Before this becomes the default it wants the treatment
join-vs-batched got in 0.65.0: object-vs-positional added to the differential
fuzz suite (`src/test/strategy-fuzz.test.ts`), which already generates random
`with` trees and asserts deep row equality between two strategies, and would
generalise to a third arm. The 50-element chunking in `buildJsonArray` needs a
wide-table case specifically, since it is the one place the position mapping is
non-trivial.

**4. If it becomes per-query rather than client-level, the SQL template cache
key needs an encoding segment**, the same way `flatten` carries `|fl=` and PII
carries `|pii=`. A positional-planned call must never be served a template
built for the object encoding.

**Recommended sequencing.** Ship it as a documented recommendation and a
`'auto'`-style opt-in first, extend the fuzz suite in the same release, and
flip the default only in the release after the fuzz suite has run against it,
including a nightly extended run. The win is real and already built; the risk
is entirely in the silent-wrong-answer direction, which is the direction this
codebase has learned to be slow about.

**One thing the local benchmark understates.** Every number here is over a Unix
socket, where 50 KB of extra payload is nearly free. Over a real network the
34% byte reduction is worth considerably more than the 0.55 ms of server time
it saves locally, and the case for the default gets stronger, not weaker. See
the proposed latency arm below.

---

## Scenario 3: streaming 50K rows

### What is being compared

The three arms are not doing the same thing, which the single wall number
hides:

- **Turbine** opens a `DECLARE CURSOR` / `FETCH` / `CLOSE` inside a
  transaction. One stable snapshot for the whole walk, no `ORDER BY` required,
  no row duplicated or missed if the table is written during iteration, and it
  yields one row at a time at constant memory.
- **Drizzle and Prisma** do keyset pagination: 50 independent
  `SELECT ... WHERE id > $1 ORDER BY id LIMIT 1000` statements, each on its own
  snapshot, each handing back an array.

So Turbine is buying a stronger guarantee. The first question is what that
guarantee costs.

### The cursor protocol is free

| arm | median |
|---|---|
| raw `pg` keyset loop, rows untouched | 44.18 ms |
| raw `pg` cursor loop, rows untouched | 44.75 ms |
| Drizzle keyset | 44.63 ms |
| Turbine `findManyStream` | 56.98 ms |

A hand-written cursor costs 0.6 ms more than a hand-written keyset loop over
50,000 rows. The snapshot guarantee is not the problem. Every one of the
remaining ~12 ms is Turbine's own per-row work.

### Where the 12 ms goes

| step | batch 1000 | batch 5000 |
|---|---|---|
| raw cursor, rows untouched | 43.37 ms | 48.20 ms |
| plus `parseRow` per row | +6.23 | +10.42 |
| plus per-row `async *` yield | +5.02 | +5.78 |
| Turbine `findManyStream` | +0.62 | +3.16 |
| *(speculative first fetch, measured separately)* | *1.04* | *5.62* |

Three named causes.

**a. `parseRow`, ~6 ms.** Per row it allocates `Object.keys(row)`, calls
`getCamelDateFields` (a Map lookup) once per *row* rather than once per result
set, and per column does a reverse-map lookup plus two `Set` membership tests
before the assignment. A prototype that computes a plan once per column shape
(field name, and whether that column needs date handling) and reuses it for
every row measures **5.82 ms to 3.66 ms over 50,000 rows, a 37% cut**, with
output asserted byte-identical to the current implementation. `new Function` is
out per CLAUDE.md, so the compiled-mapper trick other ORMs use is unavailable,
but most of the win does not need it.

This is the highest-value item in this document, because `parseRow` is on
**every read path**, not just streams. The flat `findMany` scenario in the
published benchmark returns 100 rows, which is too few for it to show up at
all. See the larger-result-set scenario proposed below.

**b. Per-row `async *` yield, ~5 ms.** `findManyStream` is an async generator
that yields one row at a time, so a 50,000-row drain is 50,000 suspend/resume
cycles, each a microtask tick, roughly 100 ns per row. This is inherent to the
API's promise, not a defect: row-at-a-time constant-memory iteration is the
feature. The fix is additive rather than corrective, an API that yields batches
(`findManyStreamBatches`, or a `mode: 'batch'` option) for callers who are
going to loop over an array anyway. That is also the shape that makes the
comparison against Drizzle's keyset arm apples-to-apples, since Drizzle hands
back arrays.

**c. The speculative first fetch, 1.0 ms at batch 1000 and 5.6 ms at batch
5000.** `findManyStream` opens with `LIMIT batchSize + 1`, hoping to satisfy the
whole drain in one round trip. On overflow it **discards those rows and
restarts from a cursor**. The optimisation is sound for small drains, which is
what it is for, but on any result larger than one batch it is pure waste, and
the waste scales with `batchSize`.

That is a real bug with a visible signature: Turbine is the only arm that gets
*slower* as `batchSize` rises (56.98 ms at 1000, 59.55 ms at 5000) while every
other arm gets faster. A user tuning `batchSize` upward for throughput is
currently paying for it twice.

The fix is to bound the speculation rather than remove it: cap the speculative
limit at a constant (`min(batchSize, SPEC_MAX) + 1`) so the one-round-trip win
is preserved for genuinely small drains while the waste stops tracking
`batchSize`. Reusing the fetched rows instead of discarding them is tempting
and is **not** sound: they were read outside the cursor's transaction, so
splicing them in front of the cursor's rows would mix two snapshots, and
resuming with `OFFSET batchSize` would additionally require an `ORDER BY` the
caller never asked for.

### What was fixed, and what it measured

Both (a) and (c) shipped. `parseRow` now caches a per-(table, column-shape)
decode plan, verified column by column against each row rather than assumed,
and the speculative fetch is bounded by `batchSize` rather than scaled by it.

| | before | after | raw cursor control (after) |
|---|---|---|---|
| `findManyStream`, batch 1000 | 56.98 ms | **52.49 ms** | 43.37 ms |
| `findManyStream`, batch 5000 | 59.55 ms | **50.25 ms** | 40.53 ms |

Overhead above a hand-written cursor falls from +12.23 ms to +9.12 ms at the
default batch size and from +16.89 ms to +9.72 ms at 5000. The absolute numbers
move between runs (the raw-cursor control moved too, which is why it is quoted
alongside), so the load-bearing result is the one that does not: **the stream no
longer gets slower as `batchSize` rises.** It used to go 56.98 to 59.55 while
every other arm got faster; it now goes 52.49 to 50.25 and tracks them.

The `parseRow` half was measured at ~25% rather than the 37% the first
prototype suggested. That prototype resolved the plan once per batch, which
`parseRow` cannot do (it is called one row at a time from a dozen sites), and
it carried no verification. The shipped version pays for a per-column
comparison and is worth it: without it a plan is accepted for a different
column set of the same width, which drops a column from the output and returns
another as `undefined`, silently.

### Expected result for the rest

Bounding the speculation and landing the `parseRow` plan cache is roughly
1.0 + 2.3 ms at batch 1000, taking the stream arm to about 53.7 ms against
Drizzle's 44.6 ms. That closes a quarter of the gap. The remaining ~9 ms is the
per-row parse floor and the per-row yield, and closing that is an API addition,
not a tuning exercise. **Turbine will not beat a keyset loop at row-at-a-time
iteration, and should stop implying it might**: it is doing more work for a
guarantee the keyset loop does not provide. The honest framing is that the
cursor is the right default for correctness, batches are available when you
want throughput, and the numbers should be published side by side with what
each one guarantees.

---

## What else the benchmark should measure

> **Done.** Everything in Tier 1 and Tier 2 below, plus most of Tier 3, is now
> implemented in `bench-extended.ts` / `bench-latency.ts` and reported in
> `RESULTS-EXTENDED.md`. The prediction at the end of this section ("fixing the
> suite is likely to move the picture more than fixing the code") held: the new
> scenarios found a loss the old suite could not see (deep pagination hits the
> generic-plan cliff) and the latency arm OVERTURNED a recommendation the
> socket-only numbers would have produced (`batched` wins on a socket and loses
> by 1.83x at 25 ms RTT). Bandwidth remains unmodelled.


The current ten scenarios skew heavily toward small, hot, single-table reads,
which is where Turbine looks best and where the least real-world time is spent.
Three of the ten are `findUnique`-shaped. Nothing measures a write path other
than a single atomic increment, nothing measures aggregation, and the largest
non-stream result set is 100 rows.

Ordered by how much they would change what we know:

**Tier 1, would likely move the published ranking**

1. **A network-latency arm.** Everything above is a Unix socket, where round
   trips are ~0.05 ms and payload size is nearly free. Both are first-order in
   production. Re-running the existing ten against a same-region TCP endpoint
   (and one cross-region) is the single highest-value addition, because it
   changes the sign of several trade-offs at once: the `batched` strategy's
   extra round trip, the `auto` threshold (`autoRoundTripMs` exists precisely
   because the break-even moves ~17x between a socket and a 2.7 ms link), and
   the whole JSON-encoding question above.
2. **Large flat result sets, 5,000 and 50,000 rows.** The current flat
   `findMany` is 100 rows, which hides per-row parse cost entirely. This is
   where the `parseRow` work above pays off and where a regression would
   currently go unnoticed.
3. **Filtered, sorted, paginated list.** `where` + `orderBy` + `limit`/`offset`,
   the single most common query in a web application, and completely absent.
   Include a deep-offset variant (`offset 10000`), a classic pain point.
4. **Bulk insert.** `createMany` of 1,000 and 10,000 rows. Prisma has a
   dedicated path, Drizzle has multi-row `values()`, and we have never measured
   ours against either.

**Tier 2, common shapes with real generator differences**

5. **To-one relations (`belongsTo`).** Posts with their author. Every nested
   scenario today is `hasMany`. To-one is at least as common and is the only
   shape `flatten` applies to, so this is the scenario that would tell us
   whether `flatten` earns its existence against Drizzle rather than only
   against our own `join`.
6. **Many-to-many through a junction.** Tags on posts. Turbine auto-detects the
   junction; Drizzle requires an explicit `relations()` re-declaration and two
   hops. A genuine differentiator, unmeasured.
7. **Aggregation.** `groupBy` with `_count` / `_sum` / `_avg` and a `having`
   clause. Dashboard staple, and 0.53.0 built a lot of machinery for it that has
   never been benchmarked.
8. **Relation filters.** `where: { posts: { some: { published: true } } }`,
   which compiles to `EXISTS`. Common, and ORMs differ enormously here.
9. **Relation `_count`.** `with: { posts: { _count: true } }`.

**Tier 3, worth having for regression safety**

10. **Write paths beyond increment:** `update` by PK, `upsert`, `delete`,
    `updateMany`.
11. **Nested writes inside a transaction**, the Prisma-parity feature.
12. **Cold start:** first query on a fresh pool, including `Parse` and planning,
    versus steady state. We publish a "hot findUnique" number and no cold one.
13. **A wide table**, 30+ columns, to expose per-column costs that a 5-column
    `comments` row cannot.
14. **`join` vs `batched` vs `auto` vs `flatten` on one high-fan-out shape**,
    reported together. `bench-auto-strategy.ts` exists but is not part of the
    published table, so the strategy that is the *default* has no published
    number.

## Where we actually stand

On the ten published scenarios Turbine is the fastest ORM on seven, and the
geometric mean is 1.82x Prisma and 1.32x Drizzle. This analysis does not change
that, it explains the three exceptions:

- **L2 and L3 are not a design problem.** The plan shape is equivalent to
  Drizzle's and the row parser is already faster. The whole gap is one encoding
  default, the alternative is already implemented and tested, and turning it on
  wins both scenarios today.
- **The stream is partly a real defect** (the speculative fetch is wasted work
  that grows with `batchSize`) **and partly an honest trade** (a cursor snapshot
  and row-at-a-time iteration against 50 independent keyset statements). About a
  quarter of the gap is recoverable without touching the API.
- **The benchmark is measuring the wrong distribution of work.** Small hot reads
  are over-represented, writes and aggregation are absent, and a socket
  understates exactly the costs where we are strongest. Fixing the suite is
  likely to move the picture more than fixing the code.
