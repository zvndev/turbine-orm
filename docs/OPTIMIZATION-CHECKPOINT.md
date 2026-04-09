# Turbine Optimization Checkpoint

> **Paused: 2026-04-09.** Resume by reading this file first, then the three plan files it links.

## Where we are

After the Neon benchmark reconciliation (commit `853f99c`, **not yet pushed**), we discovered that all three ORMs (Turbine / Prisma 7 / Drizzle) land within ~5ms of each other on a real pooled database because network RTT dominates. `findManyStream` is actually *slower* than keyset pagination for drain-all workloads. Speed is no longer the pitch.

User's follow-up question: *"what is unique really about Turbine then? and are there spots for us to optimize beyond our current speeds so we can get faster than drizzle / prisma? We had tested stuff that was way faster originally, it has to be possible."*

An Explore agent investigated the hot path and found **6 optimization targets**. The biggest finding: **`db.pipeline()` does not actually pipeline.** `src/pipeline.ts` line 42 acquires 1 connection, BEGIN, then loops sequentially with `await client.query()`, COMMIT. It's N+2 round-trips, not 1. The comment at line 63-64 admits: *"Future: use actual Postgres pipeline protocol for true pipelining."*

## What's unique about Turbine (the real differentiators after the benchmark)

1. **Deep typed `with` inference** — genuinely unique; Prisma drops past depth 2-3, Drizzle needs `relations()` re-declaration
2. **Typed Postgres errors with `isRetryable: true as const`** — `DeadlockError`, `SerializationFailureError`
3. **One-import-swap edge story** via `turbineHttp(pool, schema)` for Neon/Vercel/Cloudflare/Supabase
4. **`db.pipeline()` as an API concept** — nothing else has it; but **the implementation is currently fake** (sequential under the hood). Fixing this is the biggest untapped win and would let Turbine legitimately claim something both Prisma `$transaction` and Drizzle cannot match.
5. **1 runtime dep (pg), ~110KB, no WASM, no DSL compiler**

## Plans drafted (complete, ready to implement)

| # | Plan | File | Status |
|---|------|------|--------|
| 1 | **Real pipeline protocol** (THE BIG ONE) | [optimization-plan-1-pipeline.md](./optimization-plan-1-pipeline.md) | ✅ Done |
| 2 | **Prepared statements + SQL cache expansion** | [optimization-plan-2-prepared-stmts-sql-cache.md](./optimization-plan-2-prepared-stmts-sql-cache.md) | ✅ Done |
| 3 | **`findManyStream` fast-path + `parseNestedRow` short-circuit** | [optimization-plan-3-streaming-and-parse.md](./optimization-plan-3-streaming-and-parse.md) | ✅ Done |
| 4 | **Built-in metrics middleware** | *not yet planned* | ⏸️ Not dispatched |

Each of the three plan files is a full, self-contained implementation plan written by a Plan agent — no code, just step-by-step instructions, file-by-file changes, gotchas, tests, and benchmark scenarios.

## Recommended order when we resume

1. **Plan 1 first.** Pipeline protocol rewrite. Biggest win, headline differentiator. On Neon a 5-query dashboard load would go from ~175ms → ~40ms. No one else has this. Riskiest plan (touches pg internals via listener-swap) so it benefits from landing alone.
2. **Plan 2 second.** Prepared statements + SQL cache. Lower risk, material CPU win, reduces DB compute-seconds (which matters on Neon billing).
3. **Plan 3 third.** Streaming fast-path + parseNestedRow short-circuit. Safest, ships as two small PRs.
4. **Plan 4 last** (and only if we still care after 1-3 land). Metrics middleware is a DX win, not a perf win.

## Resume prompt

When restarting, use something like:

> *"Continue the Turbine optimization work. Read `docs/OPTIMIZATION-CHECKPOINT.md` to catch up, then start implementing Plan 1 (pipeline protocol rewrite) following `docs/optimization-plan-1-pipeline.md`."*

## Open loose ends

- **Commit `853f99c`** (benchmark reconciliation: README + STRATEGIC-PLAN + streaming-csv README + CHANGELOG + benchmarks/seed-neon.ts + benchmarks/bench.ts + benchmarks/RESULTS.md) is **local only**. Decide whether to push before starting Plan 1.
- **Plan 4 (metrics middleware)** was never dispatched to an agent. Decide if worth dispatching now or deferring.
- **Prisma 7 `$transaction` pipelining behavior** is an open question in Plan 1. The benchmark scenario designed in Plan 1 will reveal whether Prisma 7 actually pipelines at the protocol level or is still sequential. If it is sequential, our win is 4-5x and genuinely claimable. If Prisma pipelines, our win shrinks but we still beat Drizzle and raw `pg`.
- **Node `pg` driver version pinned: `^8.13.1`, installed `8.20.0`.** Plan 1 depends on this version range. If pg upgrades break `client.connection` / `client.readyForQuery` / `pg/lib/utils` / `pg/lib/result`, Plan 1 needs a compat check.
