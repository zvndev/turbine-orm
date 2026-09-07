# Cross-engine results, turbine-orm 0.78.0

Same ORM-realistic operation mix through Turbine's API against each engine, so you can
see where each engine is strong or weak *as seen through Turbine*. Not a raw-driver
shootout and not a cross-ORM comparison. Supersedes `CROSS-ENGINE-RESULTS.md`
(2026-07-26, PowDB 0.7.1), which had no SQL Server column.

- **Harness:** `benchmarks/cross-engine.ts` (`npx tsx benchmarks/cross-engine.ts`,
  env knobs in its header). Three harness defects fixed for this run, see below.
- **Fixture:** 5 orgs / 100 users / 1,000 posts / 5,000 comments (6,105 rows),
  app-assigned integer PKs, deterministic seed.
- **Method:** one connection per engine; per-op warmup (30) then 200 measured
  iterations (fewer for the heavier ops, per the harness); **median of three full
  runs**, each run measuring all five engines in sequence. Client and every database
  on one Apple Silicon MacBook Pro, Node v26.8.1, other unrelated containers running.
- **Engines, as detected on the day:** PostgreSQL 17.9 (Homebrew, TCP loopback),
  SQLite 3.53.4 (`node:sqlite`), MySQL 8.4.10 (Docker, arm64), **SQL Server via Azure
  SQL Edge 15.0.2000 (Docker, arm64), see the caveat**, PowDB embedded 0.20.0
  (`@zvndev/powdb-embedded`, `syncMode: 'normal'`).

## p50 latency, ms, lower is better

| operation | PostgreSQL | SQLite | MySQL | SQL Server¹ | PowDB emb |
|---|--:|--:|--:|--:|--:|
| findUnique by PK | 0.084 | **0.010** | 0.118 | 0.812 | 0.015 |
| findMany filter+order+limit | 0.189 | **0.085** | 0.438 | 1.221 | 0.231 |
| nested `with` (posts→comments) | **0.413** | 0.425 | 1.061 | 3.044 | 1.487 |
| create (single insert) | 0.091 | 0.017 | 0.370 | 2.714 | **0.014** |
| createMany (100 rows) | 0.540 | 1.148 | 1.473 | 5.828 | **0.442** |
| update (atomic increment) | 0.084 | 0.014 | 0.343 | 2.599 | **0.012** |

## p95 latency, ms

| operation | PostgreSQL | SQLite | MySQL | SQL Server¹ | PowDB emb |
|---|--:|--:|--:|--:|--:|
| findUnique by PK | 0.160 | 0.032 | 0.182 | 1.267 | 0.030 |
| findMany filter+order+limit | 0.290 | 0.144 | 0.712 | 1.917 | 0.308 |
| nested `with` | 0.690 | 0.664 | 1.624 | 3.932 | 1.805 |
| create | 0.216 | 0.037 | 0.679 | 4.786 | 0.058 |
| createMany (100 rows) | 0.990 | 1.469 | 23.532 | 8.288 | 1.260 |
| update | 0.142 | 0.022 | 0.640 | 3.689 | 0.017 |

Run-to-run stability (worst op, max/min of p50 across the three runs): SQLite 1.15x,
PowDB 1.25x, PostgreSQL 1.79x (nested), SQL Server 2.16x (point read), **MySQL 3.22x
(createMany)**. Read MySQL's bulk-insert p95 with that in mind.

¹ **SQL Server caveat, read before quoting a number.** The official
`mcr.microsoft.com/mssql/server:2022` image is amd64-only and crashes on startup under
emulation on Apple Silicon (fatal error, core dump, exit 1, reproduced twice). The only
way to run a SQL Server engine natively on this host is **Azure SQL Edge**, an arm64
build of the SQL Server 2019-era engine core that Microsoft has since retired. So this
column measures a discontinued product in a container, not SQL Server 2022 on the
hardware it ships for, and its absolute numbers are **not comparable** to the other
columns. It is included because a five-engine harness with a permanently empty fifth
column is worse than a labelled one. A real SQL Server measurement needs x64 hardware;
CI's `mssql-integration` job has it and runs 6,166 tests against the 2022 image.

## What changed since the July run (PowDB 0.7.1)

| operation | PostgreSQL | SQLite | MySQL | PowDB emb |
|---|--:|--:|--:|--:|
| findUnique by PK | 0.092 → 0.084 | 0.006 → 0.010 | 0.115 → 0.118 | 0.006 → 0.015 |
| findMany filter+order+limit | 0.280 → 0.189 | 0.095 → 0.085 | 0.588 → 0.438 | 0.158 → 0.231 |
| nested `with` | 0.685 → **0.413** | 0.409 → 0.425 | 1.251 → 1.061 | 0.355 → **1.487** |
| create | 0.391 → **0.091** | 0.016 → 0.017 | 0.361 → 0.370 | 0.009 → 0.014 |
| createMany (100 rows) | 1.800 → **0.540** | 1.197 → 1.148 | 1.228 → 1.473 | 0.278 → 0.442 |
| update | 0.211 → 0.084 | 0.012 → 0.014 | 0.260 → 0.343 | 0.008 → 0.012 |

**PostgreSQL improved on every row**, and by 1.7x to 4.3x on nested reads and writes.
That is the 0.71 positional encoding (nested) and the write-path work since (create,
createMany). SQLite and MySQL are flat within noise.

**PowDB embedded's nested `with` reads 4.2x slower than the prior doc's 0.355 ms.** That
row is the finding of the run, and it is not a performance regression. See the next section.
The other PowDB rows moved 1.2x to 1.6x, which a same-machine A/B of the two addons on one
ORM build reproduces on point ops (findUnique 0.007 → 0.010 ms, create 0.008 → 0.010 ms):
modest, engine-side, and within the range of this environment.

## The PowDB nested row, resolved: the fast number was a wrong answer

The prior doc measured PowDB 0.7.1, where `with` runs through Turbine's keyed loaders.
Re-run today: the SAME op the harness has always used
(`users.findMany({ where: { role: 'member' }, with: { posts: { with: { comments: true },
limit: 5 } }, limit: 10 })`), the SAME fixture (every user has 10 posts), through the
PUBLISHED turbine-orm 0.78.0, against both addons on one machine:

| | addon 0.7.1 (loaders) | addon 0.20.0 (nested projections, the default) | addon 0.20.0, `relationLoadStrategy: 'batched'` (loaders) |
|---|--:|--:|--:|
| p50 | 0.48 ms | 1.67 ms | 0.95 ms |
| posts returned per user (`limit: 5` of 10) | **1, 1, 1, 1, 1, 0, 0, 0, 0, 0** | 5, 5, 5, 5, 5, 5, 5, 5, 5, 5 | **1, 1, 1, 1, 1, 0, 0, 0, 0, 0** |

The loaders apply a relation `limit` to the flat child fetch
(`... where user_id in (...) limit 5`), so five posts are shared across ten parents; with
`orderBy: { id: 'desc' }, limit: 3` some parents get none. Nested projections (default on
addon >= 0.18) apply the limit per parent natively and return the right rows, which is why
the 0.78.0 column costs more: it returns ten times as many of them. Every PowDB number in
the tables above is from the default strategy on 0.20.0 and is a correct-answer number.

**This is a live bug in 0.78.0**, reachable two ways: `relationLoadStrategy: 'batched'` on
any addon, and the default on an addon below 0.18 (the package supports >= 0.7.1). The
native-join path (`'join'`) emits the same global `limit`. The SQL engines are not
affected: their batched loader fetches children without the relation limit and slices per
parent client-side (`src/query/batched-loader.ts`). The existing PowDB parity test for
exactly this shape compares the join path against the loader path, and both are wrong the
same way, so it passes. Fixed, with tests that assert the absolute per-parent count, in a
separate PR.

## Harness defects fixed for this run

Three, all in engine setup, all of which had made SQL Server unmeasurable and would have
made the July harness unable to include it either:

1. The raw `mssql` setup pool was handed an `mssql://` URL string. tedious does not
   parse that form (Turbine's `turbineMssql` does); the failure was "config.server is
   required". The setup config is now built from the URL.
2. tedious refuses an IP address as the TLS ServerName. The default host is now
   `localhost`.
3. The setup DDL used bare identifiers, and `plan` is a reserved word in T-SQL.
   Every identifier is now quoted per dialect, which also closes the door on the next
   reserved word.

Also corrected: the engine labels were hardcoded ("Postgres 16", "MySQL 9") and wrong
for what ran. They are still static, and say so.

## Where each engine lands, through Turbine

- **PostgreSQL:** the all-rounder and now the nested-read leader; bulk-insert leader
  among the servers. The default for a reason.
- **SQLite:** still the single-row latency king by an order of magnitude; loses to
  PostgreSQL on nested reads and to PowDB on bulk writes. Tests, edge, single-process.
- **MySQL:** 1.4x to 4x behind PostgreSQL, weakest at nested reads, and the noisiest
  engine in this environment (Docker on macOS).
- **SQL Server:** measured, labelled, not comparable. See the caveat.
- **PowDB embedded:** still the write leader (create, createMany, update) and SQLite-class
  on point reads. Nested reads are 3.6x behind PostgreSQL on this shape, and that is the
  first honest measurement of them: the prior figure was a wrong answer returned quickly.
