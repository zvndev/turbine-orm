# Roadmap and acceptance gates

Turbine's next goal is a complete, typed application lifecycle for each primary
SQL engine, followed by improvements justified by reproducible measurements.
This is a proposed, multi-release program, not a delivery calendar or a support
announcement. [STABILITY](../STABILITY.md) remains the API and support contract.
Use the [engine integration checklist](engine-integration-checklist.md) to turn
a row below into a small implementation and a reproducible test report.

## What exists, and what has not shipped

The baseline row is what `v0.93.1` shipped. The rows marked 0.94.0 arrived
with that release.

| Status | Verified scope | Boundary |
| --- | --- | --- |
| Baseline (`v0.93.1`) | PostgreSQL query API, generated clients, SQL migrations, CLI and agent tools; SQLite, MySQL and MSSQL query factories and introspectors under their subpath exports | PostgreSQL is the reference path. Non-PostgreSQL engines, distributed adapters and the serverless binding remain Experimental under STABILITY. A factory is not a complete lifecycle or certification. |
| Added in 0.94.0: SQLite lifecycle | SQLite schema-specific generation from metadata or introspection; native incremental reads; persistent CLI init/pull/generate/status/seed, SQL migration create/up/down/deploy/status, and conservative schema preview/apply with atomic leaf-table rebuilds | See the [generated example](../examples/sqlite-generated/README.md), [lifecycle example](../examples/sqlite-lifecycle/README.md), [migration contract](sqlite-migrations.md) [seed contract](sqlite-seeding.md) and [stream contract](sqlite-streaming.md). These need 0.94.0 or later. |
| Added in 0.94.0: network-engine lifecycle | Typed asynchronous MySQL and MSSQL generation, CLI init/pull/generate/status, SQL-first migrations, callback seeds and scoped catalog tools | [MySQL](mysql-projects.md) and [SQL Server](sql-server-cli.md) contracts include refused features and connection constraints. MySQL has scoped native 8.4 evidence in two SQL modes. SQL Server's native migration, seed, CLI, doctor and tools suites run in the `mssql-integration` job against SQL Server 2022; broader engine certification remains pending. |
| Added in 0.94.0: shared APIs | Optional [SQL composition with typed projections, scoped joins, ordering, CTEs and set operations](sql-fragments.md), opt-in [native integer declarations](native-integer-types.md), and an internal transaction transport seam | SQL projection types remain caller declarations; integer generation does not change runtime coercion or default output. SQL composition does not change existing CRUD or raw APIs. The seam preserves PostgreSQL behavior and does not remove the mandatory `pg` dependency. |
| Added in 0.94.0: evidence tooling | Independent exact-result/effect checks for the original PostgreSQL headline, extended and secondary suites, full native SQLite/MySQL comparison catalogs, matched dashboard transaction modes, retained Yugabyte smoke evidence, and a [packed consumer-cost harness](../tooling/consumer-cost/README.md) | The [original comparison contracts](../benchmarks/README.md#full-native-engine-comparisons) retain unsupported cells, separate Drizzle stable/RC arms and Prisma where supported. Each suite needs its own admitted native results; a headline preflight does not certify other suites, installed artifacts or final timing. [Yugabyte smoke evidence](engine-certification.md) remains uncertified. The [recorded consumer campaign](../tooling/consumer-cost/RESULTS.md) covers eight packed profiles and strict 100/500/1,000-table PostgreSQL consumers. These are single-host measurements, not performance rankings. Native seed initialization remains unmeasured. |
| Added in 0.94.0: consumer evidence | [Packed lifecycle examples](../examples/native-lifecycles/README.md), [installed artifact upgrades](native-lifecycle-upgrades.md), [native generated-client value contracts](native-value-contracts.md), a [SQLite preparation/decoding workload](../benchmarks/sqlite-preparation/README.md), [MySQL preparation measurements](../benchmarks/mysql-preparation/README.md), [native MySQL streaming resource evidence](../benchmarks/mysql-streaming/README.md), [PostgreSQL cursor resource and ownership evidence](../benchmarks/postgres-streaming/README.md), native [SQLite relation/fanout](../benchmarks/sqlite-relations/README.md) and [MySQL relation/fanout](../benchmarks/mysql-relations/README.md) workloads, and [PostgreSQL deep-pagination evidence](../benchmarks/postgres-pagination/README.md) with a [separate tuple-keyset experiment](../benchmarks/postgres-keyset/README.md) | Generated-client contracts cover selected SQLite, MySQL8.4 and PostgreSQL18.6 values and relation windows; default unsafe BIGINT typing is not certified. SQLite and MySQL upgrade evidence compares explicitly pinned, unreleased artifacts with the same package version; it does not certify a released-version upgrade or SQL Server. SQLite decoding now refreshes native result metadata after schema changes; its ordinary-query cost regression is tracked in the [decoding contract](sqlite-decoding.md). A bounded SQL-text rewrite/classification memo has [paired native measurements](../benchmarks/sqlite-query-cost/README.md); native statements and decoder metadata stay fresh. Multirow result construction now reuses projection keys and decoder lookups within each result, with a [paired native supplement](../benchmarks/sqlite-query-cost/result-cost.md). Single-row/cold-query regressions, metadata costs, statement reuse and native memory bounds remain unresolved. No production statement cache is enabled. MySQL text binding excludes unsupported escaping modes; PostgreSQL expanded-OR keyset predicates are not assumed to start an index seek. An explicit [tuple cursor predicate](cursor-pagination.md) now requires supported non-null builtin ordering keys and a unique suffix; it does not promise a particular plan or change default pagination. |
| Proposed | Remaining engine lifecycle, transport separation, packaging, advanced SQL and tooling work below | Unchecked gates are work to do. No new engine tier or performance leadership follows from this roadmap. |

The root [README](../README.md) and the [CHANGELOG](../CHANGELOG.md) describe
0.94.0. Public release notes must identify the first version that includes
each addition.

## The loop every engine must complete

Every PostgreSQL, SQLite, MySQL and MSSQL workstream repeats this order:
**full correctness -> typed lifecycle -> tooling -> fair benchmarks -> measured
optimization -> certification**. Each additional engine/transport repeats it
independently. Existing support does not waive a stage when its scope changes.
These are evidence gates, not a serialized implementation schedule. Engine
tracks run in parallel, and independent generation, migration, streaming,
tooling and measurement work can proceed together within each track.

| Gate | Acceptance evidence |
| --- | --- |
| Full correctness | Independent native SQL/driver oracles check exact rows, values and write effects, ordering, per-parent relation bounds, transactions/savepoints, global filters and PII projection. Exercise failures, cancellation, retries and connection ownership. Required real-engine suites execute with zero unexplained skips; unsupported semantics refuse explicitly. |
| Typed lifecycle | A fresh application and an existing database both reach schema-specific reads, writes and transactions without manual entity casts. Demonstrate deterministic generation, migration create/apply/status/deploy/rollback, drift detection, seed and incremental schema iteration. Prove lock contention, interrupted migration recovery and preservation of migration history. |
| Tooling | Schema inspection, compile-only queries, native explain/index advice and migration diagnostics work for that engine. Studio and agent tools state exactly which operations are supported and which permissions enforce read-only access. Capability refusals occur before unintended execution. |
| Fair benchmarks | Validate all selected arms against independent oracles before timing. Retain at least three independent full rounds with pinned versions, raw-driver controls, resource/tail/error data and every loss. Missing benchmark scope stays missing. |
| Measured optimization | Fix a reproduced application or profile deficiency, then rerun the same correctness and workload contracts. Report benefit, variation and costs in SQL, round trips, CPU, memory or types; preserve regressions in the record. A native limitation may close a feature gap only when documented and independently demonstrated. |
| Certification | Review the complete evidence for an exact engine/server/driver/transport/runtime tuple and packed consumer. Publish its scope, limitations, evidence date and support tier; wire required regression checks into [shared gates](../.github/workflows/gates.yml) following [WORKFLOW](WORKFLOW.md). Smoke-only or stale evidence cannot promote it. |

## Primary engine work

PostgreSQL regression protection runs throughout. SQLite, MySQL and MSSQL
lifecycle tracks run concurrently, using shared interfaces where appropriate
and native designs where semantics differ. A schema-application feature depends
on its engine's proven runner and recovery behavior; generated clients, native
streams and tooling need not wait for another engine's lifecycle to finish.
Optimization can start as soon as an engine has a correct baseline.

| Engine and source | Current boundary | Next checkable deliverables, through certification |
| --- | --- | --- |
| [PostgreSQL](../src/client.ts) | Reference path; CI matrix covers 14-18. Existing features do not establish new-version or transport certification. | Revalidate full generated/code-first/existing-database workflows, migrations and tools; explicitly test or narrow any added server version. Measure deep OFFSET/custom-plan tradeoffs, row/batch streams, bulk writes and sparse/high-fanout relations against current comparators. Preserve parser behavior, supplied-pool ownership, prepared-statement bounds and migration compatibility. Certify the tested tuple after those gates. |
| [SQLite](../src/sqlite.ts) | Branch lifecycle includes SQL migrations and conservative schema preview/apply with leaf-table rebuilds preserving representable existing STRICT/WITHOUT ROWID modes; unsupported dependencies and definitions are refused. Explicit seed callbacks run transactionally. SQLite schema/compile/error/discovery, read-only MCP tools and the scoped [doctor](sqlite-doctor.md) are implemented; Studio remains unsupported. Introspection preserves native key defaults/nullability and computed write restrictions; safe unique-FK reverses are to-one with an opt-out. Views and uncertain affinity/collation cases remain limited. | Close or explicitly scope those metadata gaps; extend the tested schema planner conservatively. Native WAL contention and ownership evidence is implemented. Doctor reports read-only catalog observations with explicit WAL-file preconditions and unknown migration integrity; it does not repair or scan user rows. Extend busy-lock and recovery evidence conservatively. Preserve fresh native result metadata while measuring ordinary reads, streams and full-returning bulk writes against the original comparison contracts. Ordinary-query overhead and original PK/relation workload gap closure remain unresolved. Certify fresh and introspected packed consumers and the complete runtime-qualified workflow. |
| [MySQL](../src/mysql.ts) | MySQL 8+ factory, optional `mysql2`, introspection and query support; typed asynchronous generation and CLI init/pull/generate/status are implemented in source; native service certification is pending. Writes use reselect where needed; bulk inserts cannot promise returned rows. Native bounded streaming is implemented; transaction early return drains remaining wire rows and native-hook signal forwarding is implemented; public streamed-read AbortSignal options are implemented; ordinary queries remain outside that option. MariaDB is rejected. | Native runner/status/dirty-state recovery and actual CLI create/up/deploy/down/status/recover are implemented with MySQL 8.4 evidence in two SQL modes. MySQL 8.4 tests cover generated clients, native streams, exact metadata and read-only CLI/MCP snapshot tools in two SQL modes. The [MySQL doctor](mysql-doctor.md) reports scoped runtime, visibility, engine, constraint and migration-journal observations through owned read-only snapshots; unsupported roles/partial grants remain unknown. Preserve opaque expression/prefix index facts and the configured unique-FK cardinality opt-out. Conservative read-only diff and reviewed SQL scaffolding feed the native recovery-aware runner. Explicit [journaled push](mysql-push.md) now persists one migration and refuses pending/dirty/drifted history before apply; ALTER requires separate consent and native failure retains partial-DDL evidence. Rebuild and automatic recovery remain refused. Explicit [typed DML seeds](mysql-seeding.md) and actual CLI dispatch are implemented with MySQL 8.4 evidence in two modes; partial grants/revokes that cannot establish trigger visibility are refused; no SQL files, raw statements or external-effect rollback guarantee. Packed fresh/existing-DB examples exercise seed, generation, schema iteration and recovery in both modes; verify unique/autoincrement/default, collation, JSON and exact decimal semantics. Retain native backpressure/cancellation and owned-connection controls. Compare returnless/reselected writes, relation plans, bulk chunking and prepared-cache costs; certify only the versions and semantics exercised. |
| [MSSQL](../src/mssql.ts) | Optional `mssql`, introspection and query support using OUTPUT/MERGE; typed asynchronous generation and CLI init/pull/generate/status are implemented in source; native service certification is pending. Native bounded request streaming is implemented; native-hook signal forwarding is implemented; public streamed-read AbortSignal options are implemented, with native SQL Server cancellation certification pending; native read-only transactions are not advertised. | SQL-first runner/status/transaction-owned locks and GO batch parsing are implemented with actual CLI dispatch; native SQL Server recovery certification remains pending. Validate these with the generated factory and CLI against real SQL Server while other engine tracks proceed in parallel. Typed restricted seed callbacks and actual CLI dispatch are implemented with packed fixture tests and real-driver transaction-pin controls, including unfinished-request drain before rollback; a native seed suite runs in `mssql-integration`. Fixed catalog-only CLI/MCP tools and richer scoped/generated/unique-key metadata are implemented with fixture and packed-consumer coverage. The [scoped SQL Server doctor](mssql-doctor.md) adds generated-write observations and conservative composite FK index coverage, with explicit unknown visibility, consistency, version and migration state; a native doctor suite runs in `mssql-integration`. Gate schema diff/push on proven runner and recovery behavior. Verify schemas, identity/defaults, OUTPUT, MERGE races and exact values through the actual driver, including decimal precision. Validate advertised server floors against real servers or narrow them. Profile request/parameter/JSON costs and justified bulk paths once their correctness baselines exist. Certify with recovery and consumer evidence. |

SQLite has distinct runtime requirements: ordinary queries use `node:sqlite`
from Node 22.5; native streaming needs Node 22.x from 22.16 or Node 24+; CLI
project commands need Node 22.12+; native migration writes need Node 24.10+.
The linked contracts and runtime capability checks govern each operation.
SQLite stepping and lock waits remain synchronous, and a parent-row batch limit
cannot bound one large BLOB or nested JSON value. MySQL's lack of RETURNING and
SQL Server's connection-scoped session context also need explicit native
contracts, rather than PostgreSQL guarantees inferred from shared method names.

## Shared work and broader transports

| Workstream | Acceptance gate |
| --- | --- |
| Dialect, driver and transport separation | Reuse [Dialect](../src/dialect.ts), metadata and native bindings. Resolve effective transactions, pinning, savepoints, streaming, pipeline, cancellation and read-only capabilities per binding. Keep runtime refusals for dynamic callers. Preserve PostgreSQL SQL, parser ownership and hot-path behavior; do not add hidden catalog/EXPLAIN round trips. |
| Dependency and footprint | No new mandatory dependencies. Prove a future non-PostgreSQL core/runtime import works with `pg` absent, in packed ESM and CJS consumers and declarations. Measure complete application install/import/bundle, RSS and cold start by engine and runtime; preserve existing size guards without unexplained budget increases. See the comparison policy below. |
| Advanced SQL and native schema features | Optional reusable fragments, safe identifiers, typed projections, scoped joins/subqueries, ordering, CTEs, UNION/UNION ALL and distinct INTERSECT/EXCEPT are implemented. Recursive queries, windows, ALL variants of intersection/difference and native lateral/JSON composition remain proposed. Preserve alias scope, outer-join nullability, parameter numbering and typecheck costs; projection types are caller declarations and decoding remains manual. State tenant/PII policy coverage on each new surface; raw SQL is not automatically policy protected. Include required indexes, constraints, views, generated columns and extension metadata in schema lifecycle tests. |
| Routing and operations | Extend existing routing only with explicit consistency, sticky-primary scopes, transaction pinning, failover and ownership tests. Add engine-native diagnostics, compile/schema tools and tracing without leaking parameters. Benchmark tracing cost and held-out agent task correctness, calls, tokens and elapsed time with equal documentation/tool access; retain failed attempts. |
| Consumer and type scale | Test packed fresh and upgraded applications, not only repository imports. Measure generated bytes, strict typecheck time/memory and diagnostic quality on reproducible 100/500/1,000-table fixtures. Preserve existing generated clients and migration history across upgrades. |

Transport compatibility is a candidate for testing, not a certification shortcut:

| Family | Proposed scope and native acceptance |
| --- | --- |
| PostgreSQL TCP, poolers, HTTP and WebSocket | The generic [serverless binding](../src/serverless.ts) remains Experimental. Optional [WebSocket](neon-websocket.md) and [HTTP](neon-http.md) bindings, [notification multiplexing](notification-multiplexing.md) and bounded [live queries](live-queries.md) shipped in 0.94.0 with local relay/bridge and native PostgreSQL evidence. Hosted-provider certification and durable replay remain absent. Certify each actual driver/transport/runtime separately for connection pinning, transactions, pipeline, cancellation and cursors. An HTTP binding must not inherit TCP session guarantees from a PostgreSQL dialect. |
| CockroachDB / YugabyteDB | Existing [adapters](../src/adapters/index.ts) remain Experimental. Verify distributed retries, migration locks, introspection, routing/failover and relation plans. Yugabyte's narrow smoke is explicitly uncertified; require the complete loop before promotion. |
| D1 | The [Worker binding](d1-binding.md) (0.94.0), native sequential atomic batch, [catalog introspection](d1-introspection.md) and actual [typed generated factory](d1-generation.md) are integrated with local workerd and installed ESM/CJS evidence. Interactive callback sessions, native cursors, full schema/migration lifecycle and hosted Cloudflare certification remain unavailable. No Node SQLite or TCP guarantees are inferred. |
| libSQL local | [Local execution](libsql-local.md) (0.94.0), typed generation, [main-catalog introspection](libsql-introspection.md), [project CLI](libsql-cli.md), [typed seeds](libsql-seeding.md) and [read-only migration inspection](libsql-migration-inspection.md) are integrated with native local and installed ESM/CJS evidence. An [additive-only local deploy](libsql-native-deploy.md) is available. General migration writes/recovery, remote routes, sync/replicas, the new Turso engine and comparative costs remain separate work. |
| Rewritten Turso engine | Separate proposed adapter for `@tursodatabase/database` and its sync/serverless contracts. The libSQL binding does not establish compatibility or certification. |
| Bun and mobile SQLite | Proposed runtime-native bindings; verify parser/value behavior, connection ownership, lifecycle and resource bounds independently of `node:sqlite`. |
| MariaDB, PlanetScale, TiDB, SingleStore | Proposed separate version/provider/transport rows with SQL/JSON/DDL/FK and migration-mode contracts. Do not remove the MySQL MariaDB guard as a substitute for integration. |
| MongoDB | Proposed architecture investigation and explicit go/no-go before implementation. BSON, missing/null, ObjectId/Decimal128, indexes, atomic updates, aggregation and schema evolution require a document model, not another SQL dialect. If adopted, repeat the full loop. |
| PowDB | Existing Experimental engine remains in maintenance mode under STABILITY: correctness and data-safety fixes, no feature expansion. |

## Fair dependency and performance comparisons

The package currently mandates `pg`; the MySQL, SQL Server, better-sqlite3,
libSQL, Neon, PowDB and Miniflare packages are optional peers, and SQLite uses a
Node builtin ([manifest](../package.json)). The shared client and
[query utilities](../src/query/utils.ts) still import `#pg`. Parser extraction
does not make the current package driver-free.

Compare complete applications using the **same driver and version** whenever
the bindings permit: Turbine+pg against other PostgreSQL clients+pg; for SQLite
use the same native binding or identify the binding difference explicitly.
Count the entire required and transitive install graph, runtime imports and
generated artifacts. Separate production runtime from CLI/build dependencies.
Report library-only sizes with driver externalization separately from complete
application sizes; the current [size guard](../.size-limit.js) excludes `pg`.
For non-PostgreSQL apps, the unrelated mandatory `pg` cost remains part of
Turbine's total until packaging changes.

Removing `pg` is an **explicit packaging transition**: installs, default
construction, imports and missing-driver failures can change. It requires a
versioned compatibility decision, installation/migration instructions, preserved
PostgreSQL defaults or a documented replacement, and packed ESM/CJS/type/edge
consumer checks with and without each optional driver. It is not a silent
dependency edit, and this roadmap does not authorize that transition.

For timing, pin current stable and candidate competitor lines separately at the
start of each campaign. Match selected columns, exact values, ordering, relation
limits, constraints/indexes, durability, isolation, pool sizes and driver settings.
Independent concurrent reads and transactional reads are separate workloads.
Retain generated SQL, schema/seed, invocation, versions, round data, errors,
timeouts, CPU/RSS, p50/p95/p99, throughput at fixed offered load and connection
budget, and cold import/init/connection/first-query costs. Unsupported operations
stay unsupported, never zero-time wins. Report losses and variation alongside
aggregates; investigate material regressions outside measured noise.

The [2026-10-15 PostgreSQL 0.92.0 report](../benchmarks/RESULTS-0.92.0.md)
records workload-specific results and losses against its pinned versions. It
does not establish leadership for today's competitors, other engines or every
query. The branch's stronger headline oracle does not retroactively revalidate
that historical run. Any new leadership statement needs dated, repeatable
evidence for the named workloads; no global speed claim or promised percentage
improvement is an acceptance result.

## Releasing toward 1.0

The [formal criteria](../STABILITY.md#the-road-to-10) still govern: audit three
consecutive minor releases without Stable-surface breaks, real-engine parity
and CI, held coverage floors, synchronized package/tag/GitHub releases, and
durable migration compatibility. Reconcile the actual changelog and API diffs
when assessing the freeze; this roadmap does not declare it satisfied.

Before promoting an engine, publish its complete example, capability/support
matrix, upgrade and recovery instructions, and verified test report. A
release may retain Experimental engines with explicit limits; proposed platform
expansion need not block a stable scoped SQL release. Refresh the gap and
competitor matrix before each promotion and after relevant engine/runtime
changes. New correctness or performance gaps re-enter the same loop.
