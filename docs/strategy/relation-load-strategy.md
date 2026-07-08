# Plan: make correlated relation loading robust (index advisor + batched fallback + lean wire format)

Status: proposed (2026-07-08, revised same day after root-cause work) · Priority: high

## What we found (dogfood evidence, large production dataset)

Three endpoints were slower on Turbine than on a batched-loader ORM (Prisma), same
machine, same database. EXPLAIN ANALYZE work found **two distinct root causes** — and
neither is "correlated subqueries are slow."

### Root cause 1 — missing child-FK indexes get amplified N-parents×

Turbine loads each `with` relation as a correlated `json_agg` subquery per parent row.
If the child table has **no index leading with the FK column**, every parent probe is a
full seq scan. Measured on a 659-parent × 357K-child-row case:

| Strategy | Time |
|---|---|
| Correlated (Turbine), FK unindexed | **17,836 ms** |
| Batched `IN` (Prisma), FK unindexed | 92 ms |
| Correlated, FK indexed | **62 ms — fastest** |

The batched approach pays the seq scan once; the correlated approach pays it per parent.
With the index, correlated **wins**. The kicker: Prisma-managed schemas don't auto-index
FKs on Postgres, and Prisma's batched strategy silently masks every missing FK index —
the dogfood schema had ~30 unindexed FK columns on large tables. Three CREATE INDEX
statements took one endpoint 18 s → 0.22 s and another 4.4 s → 0.37 s, both now
**faster than the batched-ORM baseline**.

A second case of the same class: a junction table too small to look scary (~30K rows)
but probed 2,396 times = 4.0 s of a 4.4 s endpoint.

### Root cause 2 — json_agg wire format is fat on huge result sets

`json_build_object` repeats every key name in every nested object. An unpaginated
8,814-row query with 6 relation trees returned **~29 MB**; a batched loader moving the
same data as plain rows transfers a fraction of that. Irrelevant when app and DB are
co-located; dominant over slow links or at extreme result sizes.

## The plan, in priority order

### 1. Index advisor — `turbine doctor` (highest leverage, cheapest)

Turbine already introspects indexes. Detect every relation whose child-side FK (and
junction-table FKs for m2m) lacks an index whose leading column covers it:
- `turbine doctor` CLI: report table.column, estimated row count, and the affected
  relations; `--fix` emits a `CREATE INDEX CONCURRENTLY` migration file.
- Dev-mode (NODE_ENV !== 'production') runtime warning the first time a `with`/relation
  filter touches an unindexed FK.
- Docs: a "coming from a batched-loader ORM" page explaining WHY this matters more for
  join-strategy ORMs — batched loading hides missing FK indexes; correlated loading
  exposes them ruthlessly (and then outperforms once they exist).

### 2. Batched loader fallback (`relationLoadStrategy: 'join' | 'batched'`)

One `WHERE fk = ANY($ids)` query per relation, stitched client-side. The PowDB engine
already has these loaders (incl. m2m + key chunking) — promote them dialect-neutral.
Value: graceful degradation on unindexed schemas, and a lean wire format for
huge/unpaginated fetches (root cause 2). Client-level and per-query opt-in; run all
statements on one connection; document the snapshot-consistency caveat outside a txn.

### 3. Lean JSON encoding (positional arrays)

Turbine knows the column order at build time — emit
`json_agg(json_build_array(col1, col2, …))` instead of `json_build_object('key', …)`
and map positions→keys in `parseNestedRow`. Cuts the repeated-key overhead (est. ~50%
of nested payload bytes on wide tables) with zero API change. Prototype + measure.

### 4. LATERAL join variant (measure, may be free wins)

`LEFT JOIN LATERAL (SELECT json_agg…) ON true` sometimes plans better than scalar
SubPlans. Lower priority now that root cause 1 is understood — benchmark before
investing.

### 5. select+with type fix (compounding papercut)

Top-level scalar `select` combined with `with` drops relation keys from the result TYPE
(runtime fine) — `QueryResult`'s select-Pick excludes with-keys when the entity
interface declares optional relation props. Forces users to drop `select` and over-fetch
wide rows, which multiplies root cause 2. Union the with-keys back in.

## Acceptance

- `turbine doctor` flags all seeded missing-FK-index fixtures; `--fix` migration applies
  cleanly.
- New wide-fanout benchmark fixture (≥500 parents × ≥4 relations, WITH indexes) at
  parity or better vs batched baseline; unindexed variant emits the doctor warning.
- Existing benchmark suite shows no regression; parity harness passes on both load
  strategies and on the positional-array encoding.
