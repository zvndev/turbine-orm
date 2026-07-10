# Plan 3: `findManyStream` Fast-Path + `parseNestedRow` Short-Circuit

> Two hot-path micro-optimizations bundled together. Plan 3a fixes the streaming slowdown (4771ms vs Drizzle's 3188ms on 50K drain — the BEGIN/COMMIT overhead tax). Plan 3b skips `JSON.parse` on empty relation columns.

## Optimization 1: `findManyStream` fast-path for small drains

### Context
`src/query.ts:994` — current `findManyStream` ALWAYS does `BEGIN + DECLARE CURSOR + FETCH loop + CLOSE + COMMIT`, even for small result sets. Default `batchSize: 100` means 500 RTTs for 50K rows on Neon. Drizzle keyset: 51.

Delta ≈ BEGIN + COMMIT = 2 × 35ms = 70ms overhead + parse costs.

### Two improvements

**1a. Raise default `batchSize` from 100 to ~1000.**

Find where default is set (in `findManyStream` signature or internal default). Trade-off: memory floor per batch vs round-trip count. At 1000 rows × ~500 bytes/row = ~500KB/batch — fine for server-side cursor semantics. Document in JSDoc. Existing callers who pass explicit `batchSize` unaffected.

**1b. Speculative first fetch.**

Issue `SELECT ... LIMIT batchSize+1` first as a normal non-cursor query. If `rows.length <= batchSize`: yield those rows, return. Zero cursor overhead, zero BEGIN/COMMIT, one round-trip. Only if result overflows: escalate to `DECLARE CURSOR` and fetch remaining rows.

This makes small drains match a plain `findMany` in speed while keeping correctness guarantees (deterministic cleanup, nested `with`, any `orderBy`) for large drains.

### Gotchas

- **Reuse SQL generation path**: speculative fetch uses same WHERE/ORDER BY/WITH clause generation as cursor path. Don't duplicate.
- **Nested `with` clauses**: speculative SELECT uses `json_agg` same as `findMany`. Confirmed.
- **User-supplied small batchSize**: respect it. Maybe use `Math.max(userBatch, speculationThreshold)` for the speculative LIMIT, but respect the user's intent for any subsequent cursor fetches.
- **Early `break` in for-await**: speculative path returns cleanly, no cursor to close. Cursor path already handles this.
- **Snapshot semantics change**: cursor path has all rows in one transaction snapshot. Speculative + escalation path spans TWO transactions on overflow — if rows change between the speculative SELECT and the subsequent cursor open, the user could see inconsistencies. **Document this trade-off.** Users wanting strict single-snapshot semantics can wrap in `$transaction` explicitly.
- **Middleware runs for stream fast path**: currently `$use` sees stream queries on large drains via the BEGIN. With the fast path, middleware sees them on small drains too (because they go through normal `queryWithTimeout`). Doc in changelog.
- **Breaking change?** No — transparent to existing call sites. Same API, same return type, same ordering guarantees. Just faster for small drains.

### Tests (`src/test/turbine.test.ts` or new file)

1. **Small drain stays under batchSize**: seed 500 rows, `findManyStream({batchSize: 1000})`, verify single speculative fetch (no `DECLARE CURSOR` in pg log), all 500 yielded correctly
2. **Drain equals batchSize exactly**: 1000 rows / 1000 batch → one speculative fetch, no escalation
3. **Drain exceeds batchSize**: 1500 rows / 1000 batch → speculative fetch of 1001, detect overflow, open cursor for remaining, yield all 1500 in order
4. **Early break on small drain**: break after 10 rows, no resource leak, correct count
5. **Early break on large drain after escalation**: break after 1200 rows of 2000, cursor + transaction properly closed
6. **Throw in consumer on small drain**: cleanup fires
7. **Throw in consumer on large drain**: cursor close + rollback fires
8. **Nested `with` on small drain**: `findManyStream({with: {posts: true}, batchSize: 1000})` on 500 users → json_agg relations populated, all typed through
9. **Nested `with` on large drain overflow**: same `with` with 2000 users → cursor path preserves relations

### Benchmark additions to `benchmarks/bench.ts`

- **7b: Small drain (1K rows)**: Turbine speculative should match plain `findMany`, should match Drizzle keyset
- **7c: Large drain (50K rows)**: cursor path — should still win on peak heap memory, aim to match Drizzle wall-clock
- **Document**: small drain = speed parity; large drain = memory flat

## Optimization 2: `parseNestedRow` JSON.parse short-circuit

### Context
`src/query.ts:2244` — `parseNestedRow` always runs `JSON.parse` on relation columns, even when value is literal `'[]'` or `null`. For findMany results where a relation is frequently empty (e.g. `users` with `with: { posts: true }` where most users have no posts), this is measurable waste: ~500ns/parse × thousands of rows.

### The fix

Before `JSON.parse(val)`:

```ts
if (val === '[]' || rawValue === null) {
  parsed[key] = relDef.type === 'hasMany' ? [] : null;
  continue;
}
if (val === 'null') { parsed[key] = null; continue; }
```

Skip parse entirely for the common empty cases.

### Gotchas addressed

1. **`hasMany` returns `'[]'` when empty** (because of `COALESCE(..., '[]'::json)` in relation subquery). **`belongsTo`/`hasOne` returns `null` when no match.** Short-circuit distinguishes via `relDef.type`.
2. **Non-empty results still go through `parseRow` per item** — non-empty branch unchanged.
3. **Graceful JSON.parse failure**: try/catch fallback preserved for the `typeof === 'string' && val !== '[]' && val !== 'null'` branch.
4. **Nested short-circuit propagation**: deep sub-relations flow through `parseRow` unchanged (pre-existing minor bug that sub-relation Date fields aren't coerced — out of scope, call out in PR).

### Tests (unit, no DB)

1. Empty `hasMany` as array: `{id:1, posts:[]}` → `{id:1, posts:[]}` (reference equality signal optional)
2. Empty `hasMany` as `'[]'` string: verify `JSON.parse` NOT called (spy)
3. Null `belongsTo` as `'null'` string: `{id:1, author:'null'}` → `{id:1, author:null}`
4. Null `belongsTo` as JS null: `{id:1, author:null}` → `{id:1, author:null}`
5. Non-empty `hasMany` (array path): `{id:1, posts:[{id:10}]}` → snake→camel applied via `parseRow`
6. Non-empty `hasMany` (string path): `{id:1, posts:'[{"id":10}]'}` → `JSON.parse` called, items through `parseRow`
7. Malformed JSON fallback: `{id:1, posts:'not json'}` → warn logged, raw value preserved
8. Mixed row: `{id:1, posts:[], comments:[{id:5}]}` → both paths fire correctly
9. Undefined relation (no column in row): key absent from output

### Integration test

Query users with `with: { posts: true, comments: true }` where 90% of users have 0 posts. Verify counts match raw SQL. Correctness, not perf.

### Benchmark addition

**Scenario 9: findMany with mostly-empty relation**

Query 5K users `with: { comments: true }` where most users have no comments. Seed condition via WHERE filter or synthetic seed. Compare against:
- Git-stashed baseline version of `parseNestedRow`
- Prisma + Drizzle equivalents

Expected delta: baseline ~600ms for 5K × 5 relations × 50ns ≈ ~590ms after. <2%/relation, cumulative across real apps. **Honest threshold**: if actual delta <0.5%, reconsider shipping.

### Risks

- **Very low.** Locally scoped, all early-return branches preserve semantics. Worst case is regression in rare malformed-JSON path, already a logged warning today.
- **Branch prediction**: extra `=== '[]'` and `=== 'null'` checks. JIT handles common case well. For standard pg (pre-parsed objects), `typeof !== 'string'` fails fast. Net: ~5ns/row overhead.
- **Pre-existing sub-relation Date bug**: untouched. Not made worse, not fixed. Call out in PR for follow-up.

## Cross-cutting: Order of Operations

**Ship Optimization 1 first.**

Rationale:
- Bigger customer-visible win (1500+ms on Neon 50K drain → parity with Drizzle)
- Riskier (snapshot semantics, default batchSize change) — benefits from landing alone, isolated changelog, independent rollback
- Opt 2 requires new test infrastructure (empty-relation seed) that Opt 1 doesn't
- Opt 2 benefit is small (<2%) and safer to ship with wider coverage once Opt 1 stable

### Proposed PR sequence

1. **PR #1: `findManyStream` default `batchSize` raise.** Single-line + docs. Lowest-risk big win. Observe one release cycle.
2. **PR #2: `findManyStream` speculative first fetch.** Depends on #1 for clean history. Snapshot-semantics doc note, unit + integration tests, bench scenarios 7b/7c.
3. **PR #3: `parseNestedRow` short-circuit.** Independent of #1/#2 but validated easier with #2's bench in place. Small diff, high coverage, negligible risk.

All three can ship in a single minor version (e.g. 0.N+1.0) with changelog section breaking them out. No breaking changes.

## Backwards-compat summary

| Change | Breaking? | Observable? | Mitigation |
|---|---|---|---|
| Default `batchSize` 100 → 1000 | No (default) | Peak memory ↑ ~10× on stream | Doc in JSDoc; users can set explicitly |
| Speculative first fetch | No | Snapshot spans 2 tx on overflow | Doc note; users wrap in `$transaction` for strict |
| Middleware runs for stream fast path | No | `$use` sees stream queries on small drains | Doc in changelog |
| `parseNestedRow` short-circuit | No | None — outputs identical | None needed |

### Critical Files for Implementation

- `src/query.ts`
- `src/test/turbine.test.ts`
- `benchmarks/bench.ts`
- `CLAUDE.md`
- `CHANGELOG.md`
