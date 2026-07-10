# Plan 1: Real Postgres Pipeline Protocol for `db.pipeline()`

> **Priority: HIGHEST.** This is the single change that would let Turbine legitimately claim a 4-5x win over Prisma `$transaction` and Drizzle on dashboard workloads. Currently `db.pipeline()` is sequential under the hood despite the "N queries in 1 round-trip" marketing.

## 1. Investigation Summary

### Does `pg` support libpq-style pipeline mode natively?

**No, not as a one-call API.** `pg` (node-postgres) has no `pool.pipeline()` / `client.pipelineBegin()` / `PQpipelineEnter` equivalent. The `pg` project has a years-old open issue tracking pipeline mode (brianc/node-postgres#2408 and related) and has explicitly punted on it. The `pg-native` binding around libpq also does not expose `PQpipelineEnter` / `PQpipelineSync`.

However, **`pg` DOES expose the raw Postgres extended-protocol wire methods on the `Connection` object**, which is all we need to roll real pipelining ourselves without forking.

### The load-bearing internals verified

1. **`pg` version installed: `8.20.0`**, dependency pinned `^8.13.1` (turbine-orm/package.json:58). pg-protocol 1.13.0.
2. **`Client.query(config)` accepts custom Submittables** — any object with a `.submit(connection)` method. This is how `pg-cursor` and `pg-query-stream` work. Verified at node_modules/pg/lib/client.js:612.
3. **`Connection` exposes raw wire methods**: `parse`, `bind`, `describe`, `execute`, `flush`, `sync`, `close`, `query` (verified at node_modules/pg/lib/connection.js:150-206). Each maps to a pg-protocol serializer message.
4. **`Connection` is an EventEmitter that re-emits every backend message** with its protocol name: `parseComplete`, `bindComplete`, `rowDescription`, `dataRow`, `commandComplete`, `emptyQuery`, `portalSuspended`, `errorMessage`, `readyForQuery`, `noData`.
5. **The `Client` dispatches all backend messages to `this._activeQuery.handleX(...)`.** A custom Submittable stays `_activeQuery` from submission until `_handleReadyForQuery` fires. One Submittable can legally consume every `commandComplete` / `rowDescription` / `dataRow` of all N queries as long as **we send exactly one trailing `Sync`**.
6. **Built-in `pg.Query` already "pipelines" a single statement**: its `prepare(connection)` method calls parse + bind + describe + execute + sync in one stream flush (query.js:163-182, with `stream.cork()` / `stream.uncork()`). What it does NOT do is batch **multiple statements** behind a single sync. That is the missing piece.
7. **`utils.prepareValue`** (exported at node_modules/pg/lib/utils.js:209) is the value mapper that `pg.Query` passes to `connection.bind({valueMapper: ...})`. Using it keeps param encoding identical to normal pg queries.
8. **`pg/lib/result.js` `Result` class** (parseRow/addFields/addCommandComplete) is what `pg.Query` uses internally. Importable via `require('pg/lib/result')`. Reusing it means our Submittable produces `pg.QueryResult`-shaped objects byte-identical to what `client.query()` normally returns.

### Multi-statement text alternative — REJECTED

Sending `sql1; sql2; sql3` as a single Simple Query breaks parameterization (no `$1, $2` binding), would require literal-injecting values, regresses Turbine's security model. Non-starter.

### Vendoring / forking?

**Nothing to vendor or fork.** Everything we need is public: `pg.Client.query(submittable)`, `client.connection.parse/bind/describe/execute/sync`, and `pg`'s package exports map at `node_modules/pg/package.json:31` which exposes `"./lib/*": "./lib/*.js"` — so `pg/lib/utils` and `pg/lib/result` are officially importable subpaths.

## 2. API Design

### Public shape (backward-compatible default)

Keep `db.pipeline(...queries)` working exactly as it does today — same signature, same ordered-tuple return. Add an **options overload** for the transactional knob:

```ts
db.pipeline(q1, q2, q3)                                // today's API, still works
db.pipeline([q1, q2, q3], { transactional: false })    // new: true pipeline, no BEGIN/COMMIT
db.pipeline([q1, q2, q3], { transactional: true })     // explicit: pipelined AND wrapped in tx
```

### Default behavior

**Change the default from sequential+transactional to pipelined+transactional.** Existing callers get the same semantics (BEGIN/COMMIT wrapper, all-or-nothing, same ordered results) but with actual 1-RTT execution. BEGIN and COMMIT become extended-protocol messages in the same flush as the queries.

### Why not default to non-transactional?

Because today's `db.pipeline()` users rely on atomicity. Dropping BEGIN/COMMIT silently would be a semantic break. Non-transactional pipeline is strictly opt-in — trades atomicity for minimum overhead and per-query error isolation.

### Transaction mode error semantics (unchanged externally)

If any query in a transactional pipeline fails, the whole pipeline rejects and the transaction rolls back. We embed BEGIN/COMMIT in the single pipelined flush. If query N fails, Postgres marks the transaction aborted; subsequent messages up to the next Sync are discarded. We send an explicit ROLLBACK as a safety net.

### Non-transactional mode error semantics (new, opt-in)

Send a `Sync` per query (all in one TCP flush). Each query is its own mini-transaction boundary. Query 3 failing does NOT cancel 4, 5. The pipeline either resolves with full results or rejects with `PipelineError` carrying `.results: Array<{status: 'ok'; value} | {status: 'error'; error}>`.

## 3. Implementation Approach

### The core: listener-swap (not `_activeQuery`)

After `pool.connect()` returns a PoolClient (which is a pg.Client):
1. Grab `poolClient.connection` (public field).
2. Set `poolClient.readyForQuery = false` to block any queued queries on the Client.
3. Snapshot the Client's existing listeners via `connection.listeners(eventName)` for: `readyForQuery`, `rowDescription`, `dataRow`, `commandComplete`, `parseComplete`, `errorMessage`, `emptyQuery`, `portalSuspended`, `noData`.
4. `connection.removeAllListeners(eventName)` for each.
5. Attach our own listeners that drive a state machine over `results: Result[]`.
6. `connection.stream.cork()`, push parse/bind/describe/execute for each query plus BEGIN/COMMIT bookends and trailing Sync, `connection.stream.uncork()` — one TCP flush.
7. Wait for final `readyForQuery` event.
8. Restore the Client's original listeners, set `poolClient.readyForQuery = true`.
9. Release the poolClient.

**Why listener-swap instead of using Client's `_activeQuery`:** on errorMessage, the Client nulls `_activeQuery` *before* calling our `handleError`, which breaks multi-query error handling. Listener-swap bypasses `_activeQuery` entirely. The only fields we touch are `client.connection` and `client.readyForQuery`, both public and stable since pg 7.x.

### State machine

- `results: Result[]` — one `pg/lib/result` `Result` per deferred query
- `index: number` — advance on each `commandComplete`
- `error: Error | null` — first error; defer rejection until final RFQ
- On `rowDescription` → `results[index].addFields(msg.fields)`
- On `dataRow` → `results[index].addRow(results[index].parseRow(msg.fields))`
- On `commandComplete` → `results[index].addCommandComplete(msg); index++`
- On `errorMessage` → record error, keep draining
- On `readyForQuery` → resolve with `results.map((r, i) => queries[i].transform(r))` OR reject

### Transactional flush pattern

```
connection.stream.cork()

// BEGIN as extended-query
connection.parse({text: 'BEGIN', name: ''})
connection.bind({values: [], valueMapper: prepareValue})
connection.execute({portal: '', rows: 0})

for (const q of queries) {
  connection.parse({text: q.sql, name: ''})
  connection.bind({values: q.params, valueMapper: prepareValue})
  connection.describe({type: 'P', name: ''})
  connection.execute({portal: '', rows: 0})
}

connection.parse({text: 'COMMIT', name: ''})
connection.bind({values: [], valueMapper: prepareValue})
connection.execute({portal: '', rows: 0})

connection.sync()  // single sync at the end
connection.stream.uncork()
```

`4N + 3` protocol messages, one TCP flush, one RTT, one RFQ event.

### Non-transactional flush pattern

```
for (const q of queries) {
  connection.parse(...); connection.bind(...); connection.describe(...); connection.execute(...)
  connection.sync()   // per-query sync boundary
}
```

One `cork()`/`uncork()` — all messages in one TCP write. N `ReadyForQuery` messages; resolve on the Nth.

### Capability detection (fallback path)

```ts
function supportsExtendedPipeline(poolClient): boolean {
  const conn = (poolClient as any).connection;
  return conn
      && typeof conn.parse === 'function'
      && typeof conn.bind === 'function'
      && typeof conn.execute === 'function'
      && typeof conn.sync === 'function'
      && typeof conn.on === 'function';
}
```

If `false`: use the existing sequential BEGIN/COMMIT loop (factor out into `runSequential()`). Covers Neon HTTP, Vercel Postgres, Cloudflare Hyperdrive, mock pools in tests. This means **only real TCP `pg` pool users get the optimization** — exactly the target audience.

### Param encoding & type parsers

- **Outgoing params**: import `prepareValue` from `pg/lib/utils.js` and pass as `valueMapper` to `connection.bind()`.
- **Incoming row types**: pass `poolClient._types` to `new Result(undefined, poolClient._types)`. Fallback to global `pg-types` if undefined. Turbine's int8-as-number override is on the global registry so both paths work.

### Backpressure, timeouts, cancellation

- **Timeout**: setTimeout that destroys `connection.stream` and rejects with `TimeoutError`. Pool discards the dead client.
- **Cancellation**: same — destroy the stream.
- **Backpressure**: cork/uncork buffers all messages into one chunk. 5-query pipeline is <10 KB, well within kernel buffers.

## 4. Error Handling Decision Table

| Scenario | Transactional (default) | `{transactional: false}` |
|---|---|---|
| All queries succeed | Resolve `[r1, r2, ..., rN]` tuple | Resolve `[r1, r2, ..., rN]` tuple |
| Query 3 of 5 fails | All 5 rolled back. Reject with `wrapPgError(q3_error)`. `err.failedIndex = 2`. `err.failedTag = q3.tag`. | Queries 1, 2, 4, 5 succeed. Reject with `PipelineError` carrying partial results. |
| Connection dies mid-flush | `ConnectionError`, client destroyed | Same |
| Timeout | `TimeoutError`, stream destroyed | Same |
| pg error code (23505 etc) | `wrapPgError` translates to typed error | Same, per failing slot |

## 5. Fallback Strategy

Feature-detect at each `pipeline()` call. If detection says "not pipelineable":
1. Log one-time warning if `logging: true`.
2. Execute existing BEGIN/COMMIT sequential loop via `runSequential()` helper.
3. Return the same `PipelineResults<T>` shape.

Add `db.pipelineSupported()` probe method for callers to inspect.

## 6. Testing Strategy

### Unit tests (no DB)
Extend `src/test/pipeline.test.ts`:
1. Fallback path, transactional — mock pool (no `.connection`), sequential runs.
2. Fallback path, non-transactional — verifies sequential path WITHOUT `BEGIN`/`COMMIT`.
3. Capability detection — various fake shapes.
4. Aggregate error type — fake that fails on query 3 of 5, verify `PipelineError`.
5. **PipelineSubmittable state machine** — fake `Connection` EventEmitter with stubbed methods, drive synthetic events, assert transforms run in order.

### Integration tests (DB required)
New file `src/test/pipeline-real.test.ts`:
1. **Correctness**: 10 queries sequential vs pipelined → `deepEqual`.
2. **Parameter fidelity**: int, bigint, boolean, string, null, Date, Buffer, array, JSONB.
3. **Error isolation (non-transactional)**: query 3 violates unique constraint, 1/2/4/5 succeed.
4. **Error atomicity (transactional)**: same scenario, whole batch rolls back.
5. **Concurrent pipelines**: 10 `db.pipeline()` calls in parallel.
6. **Mixed with non-pipelined**: interleave on same pool.

### RTT proof tests

**Approach C (SHIP THIS): TCP-write count assertion.** In `src/test/pipeline-submittable.test.ts`, stub `Connection.stream` as a mock Writable that counts `.write()` calls between `cork()`/`uncork()`. Drive 5-query pipeline. Assert single write during the cork window. **Cheapest possible "we pipelined" proof; cannot be accidentally regressed.**

**Approach B: Latency delta on Neon.** `benchmarks/bench-pipeline.ts` (or extend `bench.ts`) — 5-query dashboard against Neon. Assertion: pipelined ≤ 1.5 × single-query latency. Sequential > 175ms. Target: 3x+ delta.

### Benchmark scenario for `benchmarks/bench.ts`

**"pipeline — 5 queries, dashboard load"**, inserted between atomic increment and summary:

```ts
// Turbine — real pipeline
const turbineFn = () => turbine.pipeline(
  turbine.users.buildFindUnique({ where: { id: 1 } }),
  turbine.posts.buildCount({ where: { userId: 1 } }),
  turbine.comments.buildCount({ where: { userId: 1 } }),
  turbine.posts.buildFindMany({ where: { userId: 1 }, orderBy: { createdAt: 'desc' }, limit: 5 }),
  turbine.users.buildCount({}),
);

// Prisma — $transaction([]) (verify if it actually pipelines in v7)
const prismaFn = () => prisma.$transaction([...]);

// Drizzle — db.transaction with 5 awaits (no batch API in v0.45)
const drizzleFn = () => drizzleDb.transaction(async (tx) => { ... });
```

Measure against Neon. Expected: Turbine ~4-5× faster than Prisma `$transaction` and Drizzle. Also run against local Postgres for CPU-overhead reveal.

**Caveat**: Prisma 7 `$transaction([])` behavior needs empirical verification. If it has pipelined, our win shrinks; if still sequential, the 4-5× gap is real and claimable.

## 7. Files to Touch (in order)

1. **`src/pipeline-submittable.ts`** (new) — core `runPipelined(client, queries, {transactional})` with listener-swap, cork/uncork flush, event draining.
2. **`types/pg-internal.d.ts`** (new) — ambient declarations for `pg/lib/utils.js` (`prepareValue`) and `pg/lib/result.js` (`Result`).
3. **`src/pipeline.ts`** — add `transactional?: boolean` option. Extract existing body as `runSequential()`. Add `supportsExtendedPipeline()`. Route accordingly. Preserve `PipelineResults<T>`.
4. **`src/client.ts`** — update `pipeline()` method for new overload. Add `db.pipelineSupported()` probe.
5. **`src/errors.ts`** — add `PipelineError` class (code `TURBINE_E012`) with `.results`, `.failedIndex`, `.failedTag`.
6. **`src/index.ts`** — re-export `PipelineError` and `PipelineOptions`.
7. **`src/test/pipeline.test.ts`** — fallback, capability detection, non-transactional mode, aggregate error.
8. **`src/test/pipeline-submittable.test.ts`** (new) — state machine + single-TCP-write assertion.
9. **`src/test/pipeline-integration.test.ts`** (new, `describe.skip` unless `DATABASE_URL`) — correctness, concurrency, errors.
10. **`benchmarks/bench.ts`** — new "pipeline — 5 queries, dashboard load" scenario.
11. **`README.md`** — update pipeline section: "true 1-RTT pipeline on `pg.Pool`-backed connections; sequential fallback on HTTP drivers."
12. **`CHANGELOG.md`** — 0.8.0 entry.
13. **`CLAUDE.md`** — update `pipeline.ts` section.

## 8. Risks and Unknowns

### Known risks

1. **pg internals drift.** We depend on `client.connection`, `client.readyForQuery`, event names, `pg/lib/utils.prepareValue`, `pg/lib/result`. Stable for 10+ years but a major pg release could break us. Mitigation: pin `^8.20.0`, runtime compat check in `supportsExtendedPipeline()`, fallback to sequential.
2. **Re-entrancy during listener swap.** `readyForQuery = false` on entry blocks queued queries. Set back to `true` on exit before reattaching listeners. Unit test pins this.
3. **Neon pooler (port 5432) vs direct connection.** Anonymous prepared statements (`name: ''`) should be safe since they don't use the prepared-statement cache. Verify in integration tests.
4. **Supabase pgBouncer transaction mode.** Should be fine because pipeline is a single transaction in transactional mode. Explicit test scenario.
5. **Query.tag cardinality for debugging.** Surface `.failedIndex` and `.failedTag` on errors.
6. **Isolation level threading.** Accept `isolationLevel?: ...` in `PipelineOptions` and build BEGIN text dynamically.

### Open questions

1. **Does Prisma 7 `$transaction([...])` actually pipeline?** Need empirical benchmark to confirm. Marketing has been fuzzy. If it has pipelined, we still win over Drizzle and raw `pg`.
2. **pg native pipeline mode coming?** brianc/node-postgres#2408 open. If pg 9.x ships it, switch to native. Inline `TODO(pg-native-pipeline)`.
3. **`@neondatabase/serverless` WebSocket driver Connection shape?** Runtime probe via capability detection handles both cases.
4. **`describe` for DML-with-RETURNING vs plain DML.** Plain DML produces `NoData` message instead of `RowDescription`. Verify `pg/lib/result` handles this gracefully — integration test for "INSERT with RETURNING" + "INSERT without RETURNING" in one pipeline.
5. **`pipeline()` inside `$transaction`?** Currently uses `pool.connect()` which grabs a fresh client — silent correctness bug if called inside a transaction. Either explicitly support (take the tx's client) or document the restriction.
6. **Type parser availability.** `poolClient._types` if present, else global `pg-types`. Integration test for bigint round-trip.

### Critical Files for Implementation

- `src/pipeline.ts`
- `src/client.ts`
- `src/query.ts` (read only — `DeferredQuery` shape must be honored)
- `node_modules/pg/lib/client.js` (reference for `_activeQuery`, `readyForQuery`, event wiring)
- `node_modules/pg/lib/connection.js` (reference for `parse/bind/describe/execute/sync/flush`)
- `benchmarks/bench.ts` (head-to-head scenario)
