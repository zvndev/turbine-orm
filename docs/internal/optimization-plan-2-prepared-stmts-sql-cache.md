# Plan 2: Prepared Statements + Expanded SQL Template Cache

> Two related optimizations planned together because they share the same infrastructure (the SQL template LRU cache). Prepared statements save server-side parse+plan (~1-2ms/query on hot paths, plus reduced DB CPU which matters on Neon's compute-second billing). SQL cache expansion raises hit rate from ~5% to ~90% on typical apps.

## 1. Context from Exploration

### Current state
- `src/query.ts:590-618` defines `LRUCache<K, V>` (insertion-order Map, O(1) eviction).
- `src/query.ts:662` allocates a **per-QueryInterface** cache: `new LRUCache<string, string>(1000)`. Every table/model instance owns its own 1K cache — cardinality already bounded per-table.
- `src/query.ts:724-743` `queryWithTimeout` calls `this.pool.query(sql, params)` — the string form. **Never** passes `{ name, text, values }`.
- The **only** build method that consults `sqlCache` today is `buildFindUnique` (`src/query.ts:806-820`), and only for the "simple" fast path (`!args.with && isSimpleWhere`). Every other build method regenerates SQL from scratch on every call.
- pg driver behavior confirmed from `node_modules/pg/lib/client.js:467-480` and `node_modules/pg/lib/query.js:152-217`:
  - `parsedStatements` tracked **per `Connection`** (pg.Client), not globally or per `pg.Pool`.
  - On first use of a `name` on a given connection, pg sends Parse+Bind+Execute; on repeat uses it sends Bind+Execute only.
  - If `text` changes under an existing name, pg throws `"Prepared statements must be unique - '<name>' was used for a different statement"`.
  - A fresh connection has empty `parsedStatements`, so prepared statements naturally "warm up" per connection with no coordination needed.
- `TransactionClient.createTxPool` (`src/client.ts:265-279`) wraps pg.PoolClient behind a pool-like facade whose `query` signature is `(text, values?)`. Prepared statements on a transaction client work identically — we just need to widen the facade to accept the object form.
- `executePipeline` (`src/pipeline.ts:66-74`) calls `client.query(q.sql, q.params)` directly and needs matching changes.

### buildMethod inventory

| Method | Line | Cache today? | Regenerates every call? |
|---|---|---|---|
| `buildFindUnique` simple path | 793-831 | **Yes** | No (only cached path) |
| `buildFindUnique` general path | 833-863 | No | Yes |
| `buildFindMany` | 903-973 | No | Yes |
| `buildCreate` | 1153-1177 | No | Yes |
| `buildCreateMany` | 1191-1234 | No | Yes |
| `buildUpdate` | 1248-1278 | No | Yes |
| `buildDelete` | 1292-1313 | No | Yes |
| `buildUpsert` | 1327-1374 | No | Yes |
| `buildUpdateMany` | 1388-1408 | No | Yes |
| `buildDeleteMany` | 1422-1433 | No | Yes |
| `buildCount` | 1447-1458 | No | Yes |
| `buildAggregate` | 1619-1800 | No | Yes |
| `buildGroupBy` | 1472-1605 | No | Yes |

All methods emit pure parameterized SQL — all user values go through `params.push(...)`. The generated `sql` string IS the query shape. Cache-by-SQL-text works for every build method.

### What invalidates cache reuse

SQL-differing axes per method: column key sets (`select`, `omit`), WHERE shape (sorted keys, null-equality, operator names, combinators, relation-filter nesting), ORDER BY (columns + direction), LIMIT/OFFSET/cursor presence and `$N` placeholder positions, `with` tree recursively, aggregate column sets, atomic update ops. None involve raw values.

## 2. Design Overview

### Shape-keyed cache with two-phase builders

Each `build*` computes a **shape key** from args alone (cheap string join of key sets + flags), looks up SQL text in cache, skips SQL-building on a hit. On hit, still walk args once to fill `params[]` in the same order as the cached SQL's `$N` placeholders.

**Cache key format** (per method, with method prefix for namespacing):

```
fu:{sortedWhereKeys}|c={colKey}|op={opSignature}|w={withFingerprint}
fm:{sortedWhereKeys}|c={colKey}|o={orderBySig}|l={limit?}|cur={cursorSig}|w={withFingerprint}|d={distinctSig}
c:{sortedDataKeys}
cm:{sortedDataKeysOfRow0}|skip={bool}
u:{sortedDataKeysWithOps}|{whereShape}
d:{whereShape}
ups:{createKeys}|{conflictKeys}|{updateKeys}
um:{...}
dm:{whereShape}
cnt:{whereShape}
agg:{countSig}|{sumSig}|{avgSig}|{minSig}|{maxSig}|{whereShape}
gb:{bySig}|{aggSig}|{havingShape}|{whereShape}
```

**`withFingerprint` recursion**: for each relation in `with` (sorted): `relName/sl=colKey/om=omitKey/w=whereKeys/o=orderBy/l=hasLimit/W=(nested)`. This makes `findMany({with:{posts:{where:{published:true}, limit:10}}})` cache-hit across all boolean parameter values.

**Param-collection phase**: split complex builders into:
- `fingerprint<Method>(args): string` — shape hash
- `build<Method>Fresh(args, params): string` — returns SQL AND pushes to params (existing behavior)
- `collect<Method>Params(args, params): void` — pushes to params only, matches `$N` order from `build<Method>Fresh`

### Phased rollout

- **Phase 1 (this PR):** Split hot paths — `buildFindUnique` (both), `buildFindMany`, `buildCount`, `buildDelete`, `buildUpdate`. >90% of app traffic.
- **Phase 2 (follow-up PR):** `buildCreate`, `buildCreateMany`, `buildUpsert`, `buildUpdateMany`, `buildDeleteMany`, `buildAggregate`, `buildGroupBy`.

Phase 2 methods continue to work (they just always cache-miss) until their param-collector lands.

### Prepared statement name derivation

**Name format**: `t_<16hex>` where 16 hex = FNV-1a 64-bit hash of the **final SQL text** (not shape key). Hashing SQL text guarantees:
1. No collisions if two shape keys happen to normalize identically
2. No name reuse if SQL text ever changes for the same shape key
3. Length stays under NAMEDATALEN (63 bytes)
4. FNV-1a is single-loop, ~100ns for 300-char SQL

**Cache value shape**: `LRUCache<string, { sql: string; name: string }>` — store both so we don't re-hash on hits.

**Query submission change**: `queryWithTimeout` takes optional `preparedName`:

```ts
// miss or prepared disabled
pool.query(sql, params)
// hit
pool.query({ name: preparedName, text: sql, values: params })
```

### Stability gate / rollback

Two independent config flags in `TurbineConfig`:
1. **`preparedStatements: boolean`** — default `true` for Turbine-owned pools, `false` for external pools (`config.pool` provided). Neon HTTP / Vercel / Cloudflare Hyperdrive have different session semantics — each HTTP request may land on a different backend, so prepared statements may be silently ignored or trigger unique-name errors.
2. **`sqlCache: boolean`** — default `true`. Nuclear switch that disables the entire optimization.

Both flow through `QueryInterfaceOptions`.

## 3. Exact File Changes

### `src/query.ts`

**Near line 582-618 (adjacent to `LRUCache`)**:
- `interface SqlCacheEntry { sql: string; name: string; }`
- `function fnv1a64Hex(s: string): string`
- `function sqlToPreparedName(sql: string): string`

**Line 662**: change cache field type to `LRUCache<string, SqlCacheEntry>`.

**Lines 645-657 (`QueryInterfaceOptions`)**: add `preparedStatements?: boolean` and `sqlCache?: boolean`. Store on `QueryInterface` in constructor (lines 680-708).

**Lines 724-743 (`queryWithTimeout`)**: new signature `queryWithTimeout(sql, params, timeout?, preparedName?)`. Body:

```ts
const queryConfig = preparedName && this.preparedStatementsEnabled
  ? { name: preparedName, text: sql, values: params }
  : undefined;
const exec = queryConfig ? this.pool.query(queryConfig) : this.pool.query(sql, params);
```

Add instrumentation counters: `cacheHits`, `cacheMisses`, public getter `cacheStats(): { hits, misses, hitRate }`.

**Introduce `acquireSql(cacheKey, build)` helper**: checks cache, calls `build()` on miss, stores, returns `{ sql, name }`.

**`buildFindUnique` (lines 793-864)**:
- `fingerprintFindUnique(args): string`
- `collectFindUniqueParams(args, params): void`
- Both paths use `acquireSql`, pass `name` into DeferredQuery

**`buildWhere` (line 1883)** — split into three:
- `fingerprintWhere(where): string` — shape tokens only
- `collectWhereFreshSql(where, params): { sql }` — existing body unchanged, used on cache miss
- `collectWhereParams(where, params): void` — mirror walk, push values only, used on cache hit

Tests pin that `fingerprintWhere` is value-invariant and `collectWhereFreshSql` is deterministic.

**`buildFindMany` (lines 903-973)**:
- `fingerprintFindMany(args): string` — `"fm:"` + column key + where fingerprint + orderBy keys+dirs + limit flag + cursor shape + distinct + withFingerprint
- `collectFindManyParams(args, params)` — WHERE → cursor → LIMIT → OFFSET order

**`buildCount`, `buildDelete`, `buildUpdate`, `buildDeleteMany`, `buildUpdateMany`**: same pattern via `fingerprintWhere` / `collectWhereParams`. `buildUpdate`/`buildUpdateMany` additionally need `fingerprintSet(data)` + `collectSetParams(data, params)`.

**`withFingerprint(withClause, depth=0): string`** — mirror `buildSelectWithRelations` + `buildRelationSubquery` walk, emit shape tokens only.

**`DeferredQuery` (line 624)**: add `preparedName?: string`. All `build*` methods set it. All `execute` call sites forward it to `queryWithTimeout`.

**`findManyStream` (lines 994-1040)**: leave cursor path unchanged — DECLARE CURSOR requires SQL text, not prepared statement reference. Shape-level cache still helps (CPU side) without prepared statements.

### `src/pipeline.ts` (line 69)

Change `client.query(q.sql, q.params)` to:

```ts
q.preparedName
  ? client.query({ name: q.preparedName, text: q.sql, values: q.params })
  : client.query(q.sql, q.params)
```

### `src/client.ts`

**`TurbineConfig` (lines 81-129)**: add `preparedStatements?: boolean` and `sqlCache?: boolean`.

**Constructor (lines 301-394)**: extend `this.queryOptions`:

```ts
this.queryOptions = {
  defaultLimit: config.defaultLimit,
  warnOnUnlimited: config.warnOnUnlimited,
  preparedStatements: config.preparedStatements ?? !config.pool,
  sqlCache: config.sqlCache ?? true,
};
```

**`TransactionClient.createTxPool` (lines 265-279)**: widen `query` signature:

```ts
query: async (textOrConfig: string | { name?: string; text: string; values?: unknown[] }, values?: unknown[]) => {
  try {
    if (typeof textOrConfig === 'string') return await client.query(textOrConfig, values);
    return await client.query(textOrConfig);
  } catch (err) { throw wrapPgError(err); }
}
```

**`PgCompatPool` and `PgCompatPoolClient` interfaces**: **do NOT change.** External pools default `preparedStatements` off — Turbine won't call the object form on them.

### `benchmarks/bench.ts`

Insert between Scenario 5 and 6 (~line 265):

**Scenario: "hot findUnique — 1000 iterations"**
1. Warm cache + prepared statements with 100 warmup iterations
2. 1000 findUnique calls rotating through 50 distinct IDs
3. Report p50/p95/p99 + `process.cpuUsage()` delta

**Scenario: "hot findMany nested — 500 iterations"**
Rotating `where: { id: { in: [...] } }` through 50-id window, exercises with-clause SQL cache across differing param values.

## 4. Tests

### Unit tests — new file `src/test/sql-cache.test.ts`

1. `fingerprintWhere` value-invariant: `{id: 1}` and `{id: 999}` produce identical fingerprints
2. `fingerprintWhere` shape-sensitive: `{id: null}` ≠ `{id: 1}`, `{OR: [...]}` ≠ `{AND: [...]}`
3. `withFingerprint` recursion: `{posts: true}` ≠ `{posts: {where: {published: true}}}`; same tree different values = identical
4. SQL text identity across 10 calls with different values: `deferred.sql` byte-identical, cache size = 1
5. Cache hit counters: after 5 calls `{hits: 4, misses: 1}`
6. Cache miss on different shapes: 5 different WHERE sets = 5 misses
7. Eviction: 1001 unique shapes → 1001 misses, cache stays at 1000
8. Prepared name determinism: same SQL text → same preparedName
9. Prepared name format: matches `/^t_[0-9a-f]{16}$/`, length 18
10. DeferredQuery carries `preparedName`
11. Collision protection via SQL-text hashing
12. With-clause cache hit across param values

### Integration tests (DB required, `describe.skip` pattern)

New file `src/test/prepared-statements.test.ts`:

1. **Warm-path behavior**: 50 identical findUniques → 1 miss + 49 hits, all correct
2. **Wire verification via middleware spy**: confirm `preparedName` is set
3. **`pg_prepared_statements` inspection**: pin a single connection, run 10 identical queries, confirm `t_<hex>` name present
4. **Collision error handling**: force name collision, clear typed error
5. **External pool default off**: `PgCompatPool` shim → `preparedStatements = false`
6. **Explicit opt-in**: external pool + `preparedStatements: true` → object form
7. **Transaction reuse**: 10 identical findUniques in `$transaction` → reuse within tx
8. **Rollback kill switch**: `sqlCache: false` → cache stays empty; `preparedStatements: false` → string form

### Regression tests

Run existing `comprehensive.test.ts` and `stress.test.ts` unchanged. All operators, combinators, atomic updates, nested `with` must stay green.

## 5. Answers to Specific Gotchas

**pg prepared-statement namespacing across pool connections**: `parsedStatements` lives on Connection inside pg.Client. Pool lends out distinct Clients, each with its own map. Automatic, no coordination needed.

**Does pg re-prepare if server doesn't recognize name?** Yes — pg tracks "has been parsed" per Connection. New pool connection = empty `parsedStatements` = fresh Parse. Server-side eviction unlikely within a session.

**Is 1000-entry LRU cap enough?** Per-table cap. 50 tables × 1000 = 50K distinct SQL strings client-side. Server-side ~200-500 bytes/Parse × 50K = 25MB/connection × 10 pool max = 250MB worst case. Real apps hit 20-100 shapes per table, so real budget < 5MB server-wide. Document and leave at 1000.

**Name collisions**: FNV-1a 64-bit = 2^32 birthday bound (~4 billion SQL strings for 50% collision). Far above realistic app. pg surfaces actual collisions via "Prepared statements must be unique" error → `wrapPgError` passes through as clear error.

**Transaction client**: Dedicated PoolClient is a pg.Client with its own `parsedStatements`. Within-tx reuse is even stronger than across the pool. Facade widening at `src/client.ts:269-278` is two lines.

**Cache hit rate measurement**: `cacheStats()` on `QueryInterface` and aggregated on `TurbineClient`. Benchmark reads after scenarios, prints alongside ops/sec.

## 6. Rollback Strategy

- **`preparedStatements: false`**: disables `name` passing. SQL cache still works (CPU savings kept). Every query server-parsed.
- **`sqlCache: false`**: nuclear switch. Every call regenerates SQL as today. Implicitly disables prepared statements.

Defaults:
- Turbine-owned pool: both `true`
- External pool: `preparedStatements: false`, `sqlCache: true`

Runtime kill switch: `TURBINE_DISABLE_PREPARED=1` env var override in constructor.

## 7. Implementation Order

1. `src/query.ts` — add `fnv1a64Hex`, `sqlToPreparedName`, `SqlCacheEntry`, counters, new options, widen `queryWithTimeout`, add `preparedName` to `DeferredQuery`
2. `src/query.ts` — split `buildWhere` into fingerprint/collect pair (unblocks everything)
3. `src/query.ts` — refactor `buildFindUnique` + `buildFindMany`. Add `withFingerprint`
4. `src/query.ts` — refactor `buildCount`, `buildDelete`, `buildUpdate`, `buildDeleteMany`, `buildUpdateMany`
5. `src/client.ts` — plumb options, widen `createTxPool`, defaults
6. `src/pipeline.ts` — object-form call when `preparedName` set
7. Unit tests (`src/test/sql-cache.test.ts`)
8. Integration tests (`src/test/prepared-statements.test.ts`)
9. Phase 2 methods (separate PR): `buildCreate`, `buildCreateMany`, `buildUpsert`, `buildAggregate`, `buildGroupBy`
10. `benchmarks/bench.ts` — hot-path scenarios
11. `CHANGELOG.md` + `CLAUDE.md` — config flags + coverage summary

Each step independently type-checks and keeps `npm run test:unit` green.

### Critical Files for Implementation

- `src/query.ts`
- `src/client.ts`
- `src/pipeline.ts`
- `src/test/comprehensive.test.ts`
- `benchmarks/bench.ts`
