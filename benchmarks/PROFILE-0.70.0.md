# Where the time actually goes, turbine-orm 0.70.0

Measured 2026-08-15 against a freshly seeded `turbine_bench_070` (1,000 users /
10,000 posts / 50,000 comments), local PostgreSQL 17.9 over the Unix socket,
Node v24.18.0, Apple Silicon. This is the A0 gate for the 0.70.0 benchmark
round: no optimisation is proposed below that is not first located here.

> **TL;DR, and the headline is that the prior was wrong.**
>
> The working hypothesis going in was that the nested-read gap is row mapping,
> because Drizzle's 1.0 RC ships a JIT-compiled row mapper. It is not. Turbine's
> row mapping is **faster** than Drizzle's on both nested shapes. The entire L2
> and L3 gap is **server-side and on the wire**, and it is caused by one thing:
> `json_build_object` repeats every key for every row, which costs PostgreSQL
> CPU to emit and costs 55% more bytes to ship.
>
> Turbine already ships the fix. `jsonEncoding: 'positional'` emits
> `json_build_array` instead, and turning it on moves L2 from **1.17x Drizzle to
> 0.90x** and L3 from **1.17x to 0.87x**, returning byte-identical rows.
>
> The streaming gap is a different mechanism again, and also not row mapping:
> roughly half of it is the cost of yielding 50,000 rows one at a time through
> an async generator.
>
> `LEFT JOIN LATERAL` was measured and buys **nothing** (0.685 ms vs 0.697 ms
> against the correlated subquery, same plan). It is not the fix.

## Method

Wall-clock per operation folds together four costs with four different fixes, so
each is separated rather than inferred. A Turbine query is already three
separable steps, which is what makes an exact split possible:

```ts
const d   = qi.buildFindMany(args);      // 1. BUILD   SQL generation
const res = await pool.query(d.sql, …);  // 2. EXECUTE server + wire + driver
const out = d.transform(res);            // 3. PARSE   parseRow / parseNestedRow
```

EXECUTE is split again: `server` from `EXPLAIN (ANALYZE, TIMING OFF)` (TIMING
OFF because per-node instrumentation is charged per node *execution* and the
plans compared do not execute the same number of nodes); `driver JSON.parse` by
differencing the same query against a pool whose type parsers are the identity
function, so every cell arrives as the raw text the server sent; `wire` is the
residual. A V8 CPU profile taken through the inspector then breaks the JS side
down by function self-time, as an independent instrument.

**Two methodology traps were hit and are recorded because they change answers.**

1. *Phases and totals must be measured in the same regime.* Measured
   contiguously, Turbine's L2 costs 1.28 ms; measured with Drizzle and the RC
   rotating between its calls, the identical operation costs 2.34 ms, because
   the competitors evict its data between rounds. Attributing a 2.3 ms headline
   to phases measured in the 1.3 ms regime silently loses half the time. Every
   quantity subtracted from another below is measured in one interleaved
   rotation containing all arms.

2. *Wire bytes must be measured on an identity-parser pool.* Through a normal
   pool a `json` column arrives already parsed, so measuring `String(cell)`
   yields `"[object Object]"` for an object encoding and a comma-joined list for
   an array encoding, which **inverts** the comparison. The first pass of this
   profile reported object encoding as 12 KB against array encoding's 92 KB; the
   truth is 155 KB against 100 KB.

## Scenario 1: findMany L2, 50 users + posts

Turbine 2.379 ms vs Drizzle 1.804 ms in the published 0.66.0 harness.

Phase split, all arms in one interleaved rotation:

| phase | ms | % of total |
|---|---|---|
| build (SQL generation) | 0.008 | 0.7% |
| execute (server+wire+driver) | 0.904 | 70.3% |
| &nbsp;&nbsp;— server (EXPLAIN ANALYZE) | 0.764 | 59.4% |
| &nbsp;&nbsp;— driver JSON.parse | ~0 | ~0% |
| &nbsp;&nbsp;— wire/protocol residual | 0.168 | 13.0% |
| parse (transform) | 0.369 | 28.7% |
| client overhead (pool, middleware) | 0.004 | 0.3% |

Against Drizzle, decomposed the same way:

| | Turbine | Drizzle 0.45 |
|---|---|---|
| execute | 0.904 ms | 0.442 ms |
| map / parse | 0.369 ms | 0.664 ms |
| wire bytes | 158,540 B | 102,540 B |

**Turbine loses 0.46 ms on the SQL and wins 0.30 ms on the mapping.** The gap is
not in the row parser. It is in the statement.

### Which part of the statement

Three things differ between the two emitted queries: the join shape (correlated
scalar subquery vs `LEFT JOIN LATERAL`), the JSON encoding (`json_build_object`
vs `json_build_array`), and Turbine's `::text` casts on bigint columns. Priced
one at a time on the same data, server time and wire size:

| SQL shape | execute | server | wire |
|---|---|---|---|
| turbine: subquery, object, `::text` | 0.832 ms | 0.723 ms | 155 KB |
| turbine minus the `::text` casts | 0.782 ms | 0.697 ms | 152 KB |
| lateral + `json_build_object` | 0.774 ms | 0.685 ms | 152 KB |
| lateral + `json_build_array` | 0.426 ms | 0.350 ms | 100 KB |
| drizzle: lateral, array | 0.434 ms | 0.354 ms | 100 KB |

Reading down the column:

- **The join shape is worth nothing.** Correlated subquery 0.697 ms vs lateral
  0.685 ms with the encoding held constant. The plans are the same shape, an
  index scan on `idx_posts_user_id` under an aggregate, reached as `SubPlan 1`
  in one and `Nested Loop Left Join` in the other.
- **The encoding is the whole gap.** `json_build_object` 0.685 ms →
  `json_build_array` 0.350 ms, a **1.96x** server-side reduction, and 152 KB →
  100 KB on the wire.
- **The `::text` casts cost ~0.03 ms** server-side (0.723 → 0.697), about 4%.
  Real but minor, and they do **not** change what the caller receives: nested
  `post.id` comes back as a `number` from both Turbine and Drizzle. Verified,
  not assumed.

### The decisive test

`jsonEncoding: 'positional'` already emits `json_build_array`. End to end
through the shipping client, all three arms interleaved, two independent runs:

| | run 1 | run 2 |
|---|---|---|
| turbine, object encoding (default) | 1.16x Drizzle | 1.17x Drizzle |
| **turbine, positional encoding** | **0.90x Drizzle** | **0.90x Drizzle** |
| drizzle 0.45 | 1.00x | 1.00x |

Rows returned are **identical** (`JSON.stringify` equality against the object
path). The positional path moves work from the server onto `parseNestedRow`,
which decodes each array back into an object, so this could not have been
predicted from the server numbers alone and had to be measured end to end.

**Conclusion for L2: the gap is server-side JSON key repetition, and the fix is
an option Turbine already has.**

## Scenario 2: findMany L3, 10 users → posts → comments

Turbine 1.436 ms vs Drizzle 1.223 ms in the published harness. Same mechanism,
same proportions:

| phase | ms | % |
|---|---|---|
| build | 0.016 | 2.3% |
| execute | 0.551 | 76.7% |
| — server | 0.446 | 62.0% |
| — wire residual | 0.099 | 13.7% |
| parse | 0.179 | 24.9% |

Turbine's parse (0.179 ms) is again well under Drizzle's map residual
(0.419 ms), and Turbine ships 58,850 B against Drizzle's 38,100 B, the same 54%
excess. Positional encoding takes L3 from 1.17x Drizzle to **0.87x**.

**Conclusion for L3: identical to L2. Not plan-bound, not parse-bound,
encoding-bound.** The nested gap does not need a lateral strategy.

## Scenario 3: stream 50K comments, batch 1000

Turbine 54.01 ms vs Drizzle 40.81 ms vs raw pg 42.77 ms in the published
harness. This one is genuinely client-side, but it is still not mainly the row
parser. Draining the **same cursor** four ways, changing only how rows leave the
loop:

| drain | run 1 | run 2 | over no-parse |
|---|---|---|---|
| cursor, no parse | 42.19 ms | 43.47 ms | baseline |
| cursor + parse, synchronous loop | 46.08 ms | 48.13 ms | +3.9 / +4.7 ms |
| cursor + parse, generator yielding **batches** | 45.62 ms | 48.13 ms | +3.4 / +4.7 ms |
| cursor + parse, generator yielding **rows** | 53.69 ms | 54.98 ms | +11.5 / +11.5 ms |
| turbine `findManyStream` | 52.19 ms | 54.08 ms | +10.0 / +10.6 ms |

The per-row async generator costs **6.8–7.6 ms over 50,000 rows, ~135–152 ns per
row**, and yielding batches instead of rows removes essentially all of it while
keeping the parse cost. Turbine's own stream sits right on the per-row line,
which is what it is: `findManyStream` does `yield parseRow(row)` per row
(`src/query/builder.ts:3302` and `:3331`), so 50,000 rows is 50,000 promise
resolutions and microtask turns. Every competitor arm fetches a batch and loops
it synchronously.

The rest of the gap is accounted for: `parseRow` costs ~4–5 ms over 50K rows,
and the cursor protocol itself costs 2.6 ms more than keyset pagination
(43.5 ms vs 40.9 ms), which is the mechanism Turbine uses and the competitors do
not.

The CPU profile agrees and adds one detail: the largest single JS cost in the
streaming path is not Turbine's code at all. `parseDate` and `timeZoneOffset`
from the `postgres-date` package plus `utf8Slice` account for ~51% of active JS
self-time, against `parseRow [query/builder.js]` at 7.7%. That cost is paid by
the raw control too, so it does not explain the gap, but it does bound how much
any parser rewrite can win.

**Conclusion for stream: roughly 5 ms parse, roughly 7 ms per-row async
generator, roughly 2.6 ms cursor-vs-keyset protocol.**

## On the L2 gap that "widened" between 0.50.0 and 0.66.0

`RESULTS-0.66.0.md` recorded that the published L2 ratio went 1.21x → 1.32x with
no known cause, and flagged it for a bisect. Two hypotheses can now be killed
without one, and the rest must stay open.

**Killed: Turbine's emitted SQL changed.** The relation-SQL emission is
materially unchanged across the range. Token counts in `src/query/relations.ts`:

| | v0.50.0 | v0.66.0 | v0.70.0 |
|---|---|---|---|
| `json_build_object` | 19 | 20 | 20 |
| `json_build_array` | 2 | 2 | 2 |
| `LATERAL` | 4 | 4 | 4 |
| `::text` | 6 | 5 | 5 |

**Killed: the `::text` casts were added during the range.** They are present at
v0.50.0 and predate it, so they cannot have widened anything. (They cost ~4%
server-side and are worth removing on their own merits, but not for this.)

**What the profile does add** is a mechanism consistent with the original
reading. Turbine's L2 is 59% server time, and roughly half of that server time
is PostgreSQL emitting repeated JSON keys, a CPU-bound string-building cost.
Drizzle's and raw `pg`'s equivalents are dominated by scan and transfer. A
change in the environment between the two measurement dates that helped scan and
transfer would not help key emission proportionally, which is exactly the
"Turbine failed to pick up a gain the others got" pattern that was observed.

That is a plausible mechanism, **not** a demonstrated cause. Nothing here
measured the 2026-07-25 machine state, and no bisect over the sixteen releases
was run. **The widening remains unexplained as to cause.** What has changed is
that it is no longer interesting: the gap it describes is closed by an option
that already exists, so the bisect is no longer on the critical path.

## Recommended changes, in priority order

Owner of `src/` should treat these as proposals; nothing here was implemented.

1. **Make `jsonEncoding: 'positional'` the default on PostgreSQL, or at minimum
   promote it.** `src/client.ts` (`TurbineConfig.jsonEncoding`). This is the
   single change that closes both nested gaps, it needs no new machinery, and
   rows are byte-identical. It is not free of risk and the risk is not
   performance: positional encoding is a different decode path
   (`decodeJsonWireRow`, `src/query/relations.ts`), it is documented as
   Postgres-only, and per `CLAUDE.md` it gates off the `flatten` strategy
   entirely. A default flip needs the differential fuzz suite
   (`src/test/strategy-fuzz.test.ts`) run across encodings, not just a benchmark.

2. **Add a batch-yielding stream API.** `src/query/builder.ts:3302` and `:3331`.
   Something like `findManyStreamBatches()` yielding `T[]`, with
   `findManyStream` kept as-is over it. Worth ~7 ms of the ~13 ms streaming gap,
   measured, and it is additive rather than a behaviour change.

3. **Drop the `::text` casts on bigint in relation JSON**, if the value-fidelity
   reason they exist can be met another way. Worth ~4% of L2 server time. They
   predate 0.50.0 and were introduced for cross-strategy value fidelity, so this
   needs the fidelity tests, not just the benchmark. Lowest value of the three.

4. **Do not build a lateral relation strategy for this.** The `LEFT JOIN
   LATERAL` machinery at `src/query/relations.ts:1141` and the dialect
   capability flag at `src/dialect.ts:521` were the suggested candidate. Priced
   directly, lateral is worth 0.012 ms against the correlated subquery on this
   shape, inside noise, and produces the same plan. It may well be worth
   building for other reasons (pagination interactions, per-relation limits),
   but it will not close this gap and should not be justified by it.

### One unrelated finding

`src/query/builder.ts` contains a literal NUL byte (`\0`) on line 4321, used as
a delimiter in the `parseRow` decode-plan cache key:

```js
const shapeKey = `${table}\0${keys.join('\0')}`;
```

The delimiter choice is sound (a NUL cannot appear in a column name). The side
effect is that **`grep` treats the entire file as binary and silently reports no
matches**, which is how an earlier pass of this profile concluded that
`builder.ts` contained no `parseRow` at all. `grep -a`, `rg`, and editors are
unaffected. If a printable-but-illegal delimiter such as `\x1f` would satisfy the
same requirement, it would make the repo's largest and most-searched file
greppable again.

## Reproducing

```bash
createdb turbine_bench_070
cd benchmarks
DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" npx tsx seed-neon.ts
DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" npx prisma generate
# from the repo root
DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" npx tsx src/cli/index.ts generate --out generated/turbine

DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" npx tsx verify-arms.ts
DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" npx tsx profile-070.ts
DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" npx tsx profile-070-followup.ts
```
