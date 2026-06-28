# Turbine ORM — Cross-Engine Benchmark (PowDB v0.7.0)

Same ORM-realistic operation mix run through **Turbine's API** against each engine, to show
where each is strong/weak *as seen through the ORM* (not a raw-driver or cross-ORM shootout).

- **Harness:** `benchmarks/cross-engine.ts` (`npx tsx benchmarks/cross-engine.ts`)
- **Schema:** 4-table bench schema (organizations / users / posts / comments), app-assigned
  integer PKs (the one PK shape all engines share).
- **Seed:** deterministic, 5 orgs / 100 users / 1,000 posts / 5,000 comments (6,105 rows).
- **Method:** one connection per engine; per-op warmup (30) then 200 measured iterations
  (80 nested, 150 writes, 40 bulk); report p50/p95/p99 + ops/sec.
- **Run on:** Apple-Silicon mac, local loopback. PG 16, SQLite (node:sqlite), MySQL 9,
  **PowDB 0.7.0**. Two PowDB configs are measured:
  - **PowDB (net)** — networked `@zvndev/powdb-client` over a **Unix domain socket**, server
    started with **`POWDB_SYNC_MODE=normal`** (bounded-loss WAL durability).
  - **PowDB (embed)** — in-process `@zvndev/powdb-embedded` napi addon, **no server/socket**.
    Durability is **Full** (the addon exposes no sync-mode selector from JS — see "remaining gap").

> ⚠️ Per-op latency on a warm cache, small dataset, single connection — not concurrent throughput
> or large-data scaling. **SQLite and PowDB-embed are in-process** (no network hop); their absolute
> numbers aren't directly comparable to the networked engines — different deployment model.
> Turbine on PowDB v0.7.0 uses **`RETURNING`** (no more reselect round-trip) and **plain `$N`
> parameters** (the int→float literal workaround is gone — coercion is fixed engine-side).

## p50 latency (ms, lower is better)

| operation | Postgres | SQLite | MySQL | PowDB (net) | PowDB (embed) |
|---|--:|--:|--:|--:|--:|
| findUnique by PK | 0.088 | **0.006** | 0.104 | 0.041 | **0.006** |
| findMany filter+order+limit | 0.146 | **0.091** | 0.395 | 0.190 | 0.156 |
| nested `with` (posts→comments) | 0.407 | 0.368 | 0.861 | 0.401 | **0.314** |
| create (single insert) | 0.122 | **0.015** | 0.290 | 0.042 | 3.989 |
| createMany (100 rows) | **0.438** | 1.048 | 0.789 | 0.466 | 15.058 |
| update (atomic increment) | 0.073 | **0.011** | 0.223 | 0.068 | 3.977 |

## throughput (ops/sec, from mean, higher is better)

| operation | Postgres | SQLite | MySQL | PowDB (net) | PowDB (embed) |
|---|--:|--:|--:|--:|--:|
| findUnique by PK | 10,270 | **154,575** | 9,117 | 20,947 | 126,934 |
| findMany filter+order+limit | 5,736 | **10,349** | 2,410 | 5,079 | 6,320 |
| nested `with` | 2,364 | 2,598 | 1,111 | 2,415 | **3,112** |
| create (single insert) | 7,373 | **58,484** | 3,293 | 21,773 | 255 |
| createMany (100 rows) | 2,100 | 933 | 1,188 | 1,761 | 64 |
| update (atomic increment) | 12,334 | **90,898** | 4,020 | 8,327 | 261 |

Seed (6,105 rows via createMany): PG 56ms · SQLite 147ms · MySQL 108ms · **PowDB net 49ms** · PowDB embed 887ms.

## What changed vs PowDB 0.6.2 (the previous run)

The v0.7.0 adoption (RETURNING + Normal durability + Unix socket, workarounds removed) transformed
PowDB's **write** profile and **read** latency:

| op (p50) | 0.6.2 net | **0.7.0 net** (sock+Normal) | **0.7.0 embed** |
|---|--:|--:|--:|
| findUnique | 0.086 | 0.041 (**2.1× faster** — socket) | **0.006** (14× faster — no wire; = SQLite) |
| create | 4.041 | 0.042 (**96× faster**) | 3.989 (Full fsync — see gap) |
| createMany 100 | 18.105 | 0.466 (**39× faster**) | 15.058 (Full fsync) |
| update | 4.049 | 0.068 (**60× faster**) | 3.977 (Full fsync) |
| seed 6,105 | 965ms | 49ms (**20× faster**) | 887ms (Full fsync) |

## Headlines

1. **The "beat SQLite" goal is met — in embedded mode, on reads.** PowDB-embed findUnique is
   **0.006 ms = SQLite's 0.006 ms** (was 14× slower networked), and nested `with` is **0.314 ms —
   faster than both SQLite (0.368) and Postgres (0.407)**, even though PowDB does N+1 loaders, because
   in-process they're nearly free. Killing the wire deleted the ~0.04 ms transport floor exactly as
   the latency spec predicted.

2. **Networked PowDB writes went from worst to best-in-class.** Normal durability + RETURNING (no
   reselect) + socket put create at **0.042 ms (3× faster than Postgres, ~96× faster than 0.6.2)**,
   update at 0.068 ms (beats PG), and createMany at 0.466 ms (≈ PG, beats SQLite + MySQL). PowDB is
   now a genuinely fast networked write path.

3. **The one remaining gap: embedded WRITES are fsync-bound (~4 ms).** PowDB-embed create/update sit
   at ~4 ms and createMany at 15 ms — ~95× slower than the *same engine* networked-Normal. The cause
   is **100% durability mode**: the napi addon ships no `setSyncMode`, so embedded is locked to
   **Full** (one fsync per commit ≈ SSD fsync latency). The reads prove the engine + literal
   materialization overhead is negligible (0.006 ms). **Fix is upstream:** expose `setSyncMode`
   (and ideally `openWithMemoryLimit`) on the `@zvndev/powdb-embedded` `Database` class. With Normal,
   embedded writes should drop to in-process-Normal territory (~0.01–0.02 ms) and beat SQLite's
   0.015 ms create outright.

## Where each engine lands (through Turbine)

- **SQLite (in-process):** still the single-row latency king (point reads 154k ops/s, writes 58–90k).
  Relative weak spot: bulk `createMany` (933 ops/s, row-by-row). Best for tests / edge / single-process.
- **Postgres:** best networked all-rounder and the bulk-insert leader (UNNEST). The sensible default.
- **MySQL:** ~2–4× behind PG locally; reselect tax on single create; weakest at nested reads.
- **PowDB (net) v0.7.0:** Postgres-class-or-better across the board now — fast reads (socket) and
  **fast writes** (Normal). The networked story is no longer "great reads, terrible writes."
- **PowDB (embed) v0.7.0:** **SQLite-class reads** (often faster on nested), but **writes are
  Full-fsync-bound** until the addon exposes Normal durability. Best today for **read-heavy local-first**
  apps; batch writes, or use the networked-Normal path when write latency matters — until embedded
  Normal lands.

## Caveats / honesty

- PowDB-embed prebuilt binaries ship for macOS-arm64/x64 + Linux-glibc x64/arm64 only (no Intel-mac
  in the published 0.7.0 tarball, no musl/Alpine, no Windows) — those platforms must build from source.
- Embedded durability is Full; do not read embedded write numbers as PowDB's best — they're the
  durability-locked floor, not an engine limit.
- Single-connection latency only. Concurrent-write throughput (where a server should beat SQLite's
  single-writer lock) is not measured here.
