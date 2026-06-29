# Turbine ORM — Cross-Engine Benchmark (PowDB v0.7.1)

Same ORM-realistic operation mix run through **Turbine's API** against each engine, to show
where each is strong/weak *as seen through the ORM* (not a raw-driver or cross-ORM shootout).

- **Harness:** `benchmarks/cross-engine.ts` (`npx tsx benchmarks/cross-engine.ts`)
- **Schema:** 4-table bench schema (organizations / users / posts / comments), app-assigned
  integer PKs (the one PK shape all engines share).
- **Seed:** deterministic, 5 orgs / 100 users / 1,000 posts / 5,000 comments (6,105 rows).
- **Method:** one connection per engine; per-op warmup (30) then 200 measured iterations
  (80 nested, 150 writes, 40 bulk); report p50/p95/p99 + ops/sec.
- **Run on:** Apple-Silicon mac, local loopback. PG 16, SQLite (node:sqlite), MySQL 9,
  **PowDB 0.7.1**. Two PowDB configs:
  - **PowDB (net)** — networked `@zvndev/powdb-client` over a Unix domain socket, server
    started with `POWDB_SYNC_MODE=normal`.
  - **PowDB (embed·norm)** — in-process `@zvndev/powdb-embedded` addon, **no server/socket**,
    opened with **`turbinePowDB({ embedded, syncMode: 'normal' })`** — the 0.7.1 knob that
    moves fsync off the commit path. (0.7.0 embedded had no such selector and was Full-only.)

> ⚠️ Per-op latency on a warm cache, small dataset, single connection — not concurrent
> throughput or large-data scaling. **SQLite and PowDB-embed are in-process** (no network hop);
> their absolute numbers aren't comparable to the networked engines. Absolute numbers carry
> run-to-run noise (the networked engines' figures here ran a touch higher than a prior idle
> run); the **relative** embed-vs-SQLite story below is the robust signal.

## p50 latency (ms, lower is better)

| operation | Postgres | SQLite | MySQL | PowDB (net) | PowDB (embed·norm) |
|---|--:|--:|--:|--:|--:|
| findUnique by PK | 0.092 | **0.006** | 0.115 | 0.060 | **0.006** |
| findMany filter+order+limit | 0.280 | **0.095** | 0.588 | 0.280 | 0.158 |
| nested `with` (posts→comments) | 0.685 | 0.409 | 1.251 | 0.758 | **0.355** |
| create (single insert) | 0.391 | 0.016 | 0.361 | 0.061 | **0.009** |
| createMany (100 rows) | 1.800 | 1.197 | 1.228 | 0.698 | **0.278** |
| update (atomic increment) | 0.211 | 0.012 | 0.260 | 0.065 | **0.008** |

## The headline: embedded `syncMode:'normal'` (0.7.1) closes the write gap — embedded now beats SQLite

PowDB's stated goal was to beat SQLite. On **v0.7.0** embedded reads already matched SQLite, but
embedded *writes* were Full-fsync-bound (~4 ms) because the addon couldn't select durability from
JS. **v0.7.1 added `setSyncMode`**, which Turbine now exposes as `turbinePowDB({ embedded, syncMode })`.
With `'normal'`, embedded writes drop ~440× and pass SQLite:

| op (p50) | SQLite | embed 0.7.0 (Full) | **embed 0.7.1 (normal)** | vs SQLite |
|---|--:|--:|--:|:--|
| create | 0.016 | 3.989 | **0.009** | **1.8× faster** ✅ |
| update | 0.012 | 3.977 | **0.008** | **1.5× faster** ✅ |
| createMany 100 | 1.197 | 15.06 | **0.278** | **4.3× faster** ✅ |
| findUnique | 0.006 | 0.006 | **0.006** | tie |
| nested `with` | 0.409 | 0.314 | **0.355** | **faster** ✅ |
| findMany | 0.095 | 0.156 | 0.158 | SQLite wins |

Embedded PowDB 0.7.1 now **wins or ties SQLite on every op except filtered-list**, while keeping a
real storage engine, indexes, WAL, and (unlike SQLite) a networked transport for the same data.
Seed time: 6,105 rows in **31 ms** (was 887 ms on 0.7.0-Full).

> Caveat — tail variance: embedded writes have a heavier p99 than SQLite (e.g. create p99 ~0.28 ms),
> so *mean*-based ops/sec is closer than the p50s suggest (create: SQLite 56k vs embed 28k ops/s by
> mean; createMany embed 2,410 vs SQLite 819). The p50/median — the standard latency measure — is the
> headline; the mean reflects occasional fsync-batch hitches under Normal mode.

## Networked PowDB (net+sock+Normal) — Postgres-class

create 0.061 ms, update 0.065 ms, createMany 0.698 ms, findUnique 0.060 ms — at or ahead of
Postgres on writes, with reads paying the (socket-halved) wire floor. The reselect→RETURNING +
Normal-durability work from 0.7.0 holds.

## What's verified, what's a known gap

- **`count(*)` bug (PowDB's heads-up): does not affect Turbine.** Turbine's PowQL generator emits
  PowDB's *native* `count(<Table>)` aggregate, never the SQL-frontend `SELECT count(*)` that was
  wrong before 0.7.1. Re-checked live on 0.7.1: `count`, filtered `count`, and `_count/_sum/_avg/_min/_max`
  all return correct scalars.
- **Upstream items closed in 0.7.1:** embedded `setSyncMode`/`openWithMemoryLimit`; `open()` no
  longer aborts the host on a corrupt dir (`Error::OpenPanicked`); PID-based data-dir lock (rejects a
  second live-process open); bindings version drift fixed.
- **Still open (upstream, 0.7.2):** musl/Alpine + a reliable Intel-mac prebuilt. 0.7.1 ships
  darwin-arm64 + linux-glibc (x64/arm64) only — other platforms build the addon from source.
- **Embedded durability note:** `'normal'` trades a bounded loss window (≤ one fsync interval) on
  OS crash / power loss for the write speed; `'full'` (default) keeps per-commit fsync. Process
  crash (not OS) loses nothing in either mode (WAL replay).

## Where each engine lands (through Turbine)

- **SQLite (in-process):** still elite on single-row latency and the simplest deploy; loses to
  embedded PowDB on bulk writes and nested reads. Best for tests / edge / single-process.
- **Postgres:** best networked all-rounder; the bulk-insert leader (UNNEST). The sensible default.
- **MySQL:** ~2–4× behind PG locally; weakest at nested reads.
- **PowDB (net):** Postgres-class across the board now — fast reads (socket) and fast writes (Normal).
- **PowDB (embed·norm):** **SQLite-class-or-better on reads AND writes** as of 0.7.1 — the
  local-first / SQLite-replacement story, with a networked sibling for the same data. Mind the
  platform-binary gap (no musl/Windows/Intel-mac prebuilt yet) and the Normal-mode loss window.
