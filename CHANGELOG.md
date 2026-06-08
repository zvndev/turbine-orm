# Changelog

## Unreleased

**Feature release: aggregate filtering, a typed raw-SQL escape hatch, many-to-many + self-relations, pgvector similarity search, RLS session context, and LISTEN/NOTIFY realtime.**

### Added
- **`groupBy` HAVING** — filter aggregate groups with a `having` clause: `groupBy({ by: ['userId'], _count: true, having: { _count: { gt: 1 } } })`, or filter on a column aggregate via `having: { viewCount: { _sum: { gte: 100 } } }`. Supports `_count`/`_sum`/`_avg`/`_min`/`_max` with operators `gt`/`gte`/`lt`/`lte`/`in`/`notIn` (a bare number is shorthand for equality). HAVING params continue the WHERE param numbering; every value is bound as `$N`. Unknown columns or operators throw `ValidationError` before any SQL is built.
- **Typed raw SQL — `db.sql<T>`** (`src/typed-sql.ts`) — a typed escape hatch alongside `db.raw`: ``db.sql<{ id: number; name: string }>`SELECT id, name FROM users WHERE id = ${id}` `` returns `T[]` when awaited, `.one()` returns `T | null`, and `.scalar<V>()` returns the first column of the first row or `null`. Every `${value}` is bound as a `$N` parameter — injection payloads become data, never SQL.
- **Many-to-many through junction tables** (`buildManyToManySubquery` in `src/query/builder.ts`) — `generate` auto-detects *pure* junction tables (exactly two single-column FKs forming a two-column PK, no payload columns) and adds a `manyToMany` relation to both endpoints, loadable via `findMany({ with: { tags: true } })` with nested `where`/`orderBy`/`limit`. Composite-key junctions supported. Junctions carrying payload columns stay ordinary `hasMany` (by design). For non-pure or hand-built junctions, declare them in a code-first schema via `manyToMany: [{ name, target, through, sourceKey, targetKey, references? }]` (`applyManyToManyRelations` / `ManyToManyDef` in `src/schema-builder.ts`).
- **Self-relations** — a self-referencing FK (e.g. `categories.parent_id → categories.id`) introspects to a `belongsTo` + a `hasMany` on the same table, queryable as nested `parent`/`children` trees at arbitrary depth. Each `buildRelationSubquery()` call allocates a fresh alias, so parent and child references never collide. A lone self-FK auto-names the `belongsTo` for the singular table and the `hasMany` for the table.
- **pgvector similarity search** (`VectorFilter` / `VectorOrderBy` in `src/query/types.ts`) — KNN ranking via `orderBy: { embedding: { distance: { to: number[], metric: 'cosine', direction?: 'asc' | 'desc' } } }`, and distance WHERE filtering via `where: { embedding: { distance: { to, metric: 'l2', lt: 0.3 } } }` (`lt`/`lte`/`gt`/`gte`). Metrics `l2`/`cosine`/`ip` map to `<->`/`<=>`/`<#>`. The query vector is bound as `$n::vector`. Non-number elements, NaN/Infinity, unknown metrics, and distance ops on non-vector columns all throw `ValidationError`. Requires the pgvector extension + a `vector` column.
- **RLS session context** (`$transaction` `sessionContext` + `$withSession` in `src/client.ts`) — `db.$transaction(fn, { sessionContext: { 'app.current_tenant': id } })` applies each entry as `SELECT set_config(name, value, true)` after `BEGIN`, so Postgres RLS policies using `current_setting()` filter rows per transaction (the GUC auto-resets on commit). Values may be string/number/boolean. `db.$withSession(ctx, fn)` is the single-purpose shorthand. Invalid setting names throw `ValidationError` and roll the transaction back before any query runs.
- **LISTEN/NOTIFY realtime** (`src/realtime.ts`, `$listen`/`$notify` in `src/client.ts`) — `const sub = await db.$listen('channel', (payload) => { ... })` subscribes on a dedicated connection (requires a persistent pool; not available over serverless HTTP drivers), `await db.$notify('channel', 'msg')` publishes in one round-trip (works everywhere), and `await sub.unsubscribe()` issues `UNLISTEN`. Channel names are validated as plain identifiers; the payload is bound as a parameter and delivered to the handler as a string. `disconnect()` force-releases open subscriptions.

### Tests
- Full suite: 1208 passing, 1 skipped (pgvector live assertions, extension-gated — skipped, not failed, when the `vector` extension is unavailable), 0 failures.
- New suites: `group-by-having`, `typed-sql`, `many-to-many`, `self-relation`, `pgvector`, `rls-session`, `realtime`. Each pairs build-only SQL/parameterization assertions (no DB) with `DATABASE_URL`-gated integration coverage against bootstrapped, isolated tables.

### Docs
- README: added typed-SQL (`db.sql<T>`), groupBy HAVING, RLS session-context, and LISTEN/NOTIFY subsections under Usage Examples; a new "Vector search (pgvector)" section; many-to-many and self-relation examples in the relations content; and Many-to-many / Vector search / LISTEN/NOTIFY rows in the Comparison table.

---

## 0.17.0 (2026-06-06)

**Release-readiness pass: two correctness fixes, the PII-safe error guarantee made real, honest footprint numbers, and a size gate that measures something.**

### Fixed
- **Studio is no longer broken on plain PostgreSQL (CRITICAL).** Every Studio data/query request issued `SET LOCAL statement_timeout = $1`, which Postgres rejects (`SET` does not accept bind parameters) — so each query 500'd with `syntax error at or near "$1"`. The CockroachDB/YugabyteDB adapters had the same flaw. All now use `SELECT set_config('statement_timeout', $1, true)`, the parameterizable transaction-local form. The unit test mocked the pool and never sent the SQL to a real server, so the bug shipped green; a new integration test (`studio-timeout-integration`) runs the real SQL against a live connection.
- **`UniqueConstraintError` and other constraint errors no longer leak row values (CRITICAL).** The error `.message` unconditionally appended Postgres's raw `detail` string (e.g. `Key (email)=(alice@x.com) already exists.`), contradicting the documented "PII-safe, never the actual user data, safe to log" guarantee. The raw `detail` is now only appended in `verbose` mode; in the default `safe` mode the message carries column/constraint/key names only. Structured fields (`.columns`, `.column`, `.constraint`) and `.cause` still expose full detail for programmatic use. Applies to E008/E009/E010/E011/E016.
- **belongsTo nested writes with a NOT NULL foreign key now work (HIGH).** `posts.create({ data: { …, user: { connect/create/connectOrCreate } } })` previously inserted the parent row before setting the FK (via a follow-up UPDATE), failing the NOT NULL `user_id` constraint on the initial INSERT. belongsTo relations are now resolved before the parent INSERT and their FK folded into it. The hasMany direction is unchanged. New integration coverage exercises all three belongsTo ops.

### Changed
- **Honest footprint claims.** The README/package description previously headlined "~110 KB" and contrasted it with "Prisma's 1.6 MB WASM" — but that compared a minified bundle against an unpacked install (Turbine's own unpacked install is ~1.7 MB). Claims are now led by the true, durable differentiator — **one dependency, no WASM engine** — with correctly-labeled bundle figures (~27 KB brotli main entry, ~19 KB edge).
- **`size-limit` now measures the real bundled import graph** (`@size-limit/esbuild`) instead of the 2.6 KB barrel file, so the gate guards an actual number. Limits: 35 kB main, 25 kB edge.
- **`exports` map now lists `types` first** in each conditional export so TypeScript resolves declarations correctly under all module-resolution modes.

### Added
- `@types/pg` is now a runtime dependency — Turbine's public `.d.ts` re-exports `pg` types, so strict consumers (`skipLibCheck: false`) no longer hit `TS7016`.

### Tests
- Full suite: 1127 passing against a live database (0 failures). New regression tests: belongsTo nested-write integration (3), studio statement-timeout integration (3), PII-safe constraint-error messages (4).
- `test:coverage` now runs the full unit set (it had drifted to a stale ~20-file subset that left `nested-write.ts`/`observe.ts` near-uncovered, failing the gate at 69.6% functions). Coverage now passes: lines 78%, functions 83%, branches 86%.

### Docs
- `SECURITY.md` supported-versions table updated (was stuck at 0.5.x/0.6.x). README error-code list extended to E016. README full-text-search note corrected (the `search` filter shipped in 0.15). `CONTRIBUTING.md` architecture tree updated to the `src/query/` submodule split. `CLAUDE.md` coverage thresholds and seed-dataset sizes corrected. Benchmark results dated and version-caveated (measured on 0.7.1; core read path unchanged).

---

## 0.16.0 (2026-05-18)

**Feature release: observability, nested write update/upsert, is/isNot relation filters, cursor pagination tests, Neon guide.**

### Added
- **Event emitter** — `db.$on('query', fn)` and `db.$off('query', fn)` fire after every query with SQL text, params, duration, model, action, and row count. Param redaction in safe mode. Listener errors never crash queries.
- **Observability module** — `db.$observe({ connectionString })` buffers per-minute aggregated metrics (count, avg, p50, p95, p99, errors) and flushes to a dedicated `_turbine_metrics` table in a separate database. Non-blocking (fire-and-forget), 1-connection pool, configurable retention. Auto-starts from `TURBINE_OBSERVE_URL` env var.
- **`turbine observe` CLI** — local read-only dashboard for viewing query metrics. Same security model as Studio (loopback binding, 192-bit token, HttpOnly cookies, CSP, X-Frame-Options: DENY). Dark-theme SVG charts, top models table, error rates, time range selector.
- **Nested write `update`** — `{ posts: { update: { where: { id: 1 }, data: { title: 'new' } } } }` in `update()` context. Array form supported. BelongsTo derives where from parent FK automatically.
- **Nested write `upsert`** — `{ posts: { upsert: { where: { id: 1 }, create: {...}, update: {...} } } }`. Checks existence, creates with FK injection or updates.
- **`is`/`isNot` relation filters** — for to-one relations (belongsTo/hasOne): `where: { author: { is: { name: 'Alice' } } }`. Generates EXISTS/NOT EXISTS subqueries.
- **Neon guide** — `/neon` page on turbineorm.dev: "Turbine + Neon in 60 Seconds" covering install, generate, Node.js + serverless connections, migrations, and why Turbine on Neon.

### Fixed
- All Biome lint violations resolved — `npm run lint` now exits clean.

### Tests
- 812 unit tests (up from 711), all passing.
- Added test suites: `event-emitter` (10), `observe` (12), `nested-write-update-upsert` (15), `is-isNot-filter` (6), `cursor-pagination` (7), `client-branches` (17).

---

## 0.15.0 (2026-05-17)

**Feature release: select/omit type narrowing, optimistic locking, full-text search, retry utility, security hardening.**

### Added
- **Select/omit compile-time type narrowing** — `findMany`, `findUnique`, `findFirst` accept `select` and `omit` args that narrow the return type at compile time via `QueryResult<T, R, W, S, O>`. Preserves `with` relation additions while narrowing base entity fields.
- **Optimistic locking** — `update({ optimisticLock: { field: 'version', expected: 3 } })` auto-increments the version field and throws `OptimisticLockError` (E015) on concurrent modification.
- **Full-text search** — `TextSearchFilter` type with `search`, `config`, and `language` options. Generates `to_tsvector @@ plainto_tsquery` SQL with injection protection.
- **Retry utility** — `withRetry(fn, opts)` and `db.$retry(fn, opts)` with exponential backoff + jitter. Only retries errors marked `isRetryable` (deadlocks, serialization failures).
- **`ExclusionConstraintError`** (E016) — maps pg error code 23P01 via `wrapPgError()`.
- **SQL safety property tests** — 22 injection payloads verified against WHERE, UPDATE SET, and CREATE SQL generation.
- **Migrate from Drizzle** documentation page at `/migrate-from-drizzle`.

### Security
- Studio: Added `Content-Security-Policy` header, rate limiting (100 req/60s per token), ESCAPE clause on ILIKE queries, 10KB query length limit.
- Adapters: `statementTimeout()` now returns parameterized `{ sql, params }` instead of interpolated strings.

### Changed
- Release workflow supports `workflow_dispatch` with dry-run mode and auto-tag creation.
- Git tags synced through v0.10.0.

### Tests
- 711 unit tests (up from 686), all passing.
- Added test suites: `optimistic-lock`, `retry`, `text-search`, `sql-safety-property`.

---

## 0.14.0 (2026-05-10)

**Dialect-owned type metadata for future database packages.**

### Added
- Added optional `Dialect.typeToTypeScript()` and a PostgreSQL-backed implementation so PostgreSQL introspection can route generated TypeScript types through the dialect contract without source-breaking query-only dialect implementers.
- Added optional `Dialect.arrayType()` and wired PostgreSQL introspection/query fallback bulk-insert casts through the dialect contract.
- Added dialect-neutral `dialectType`, `arrayType`, and `dialectTypes` schema metadata aliases while preserving the existing `pgType`, `pgArrayType`, and `pgTypes` fields for compatibility.

### Tests
- Added dialect contract coverage for type mapping and metadata serialization.

---

## 0.13.3 (2026-05-10)

**Final integration fixture-size assertion patch.**

### Fixed
- Updated the remaining stream-ordering integration assertion to respect the documented 8-user seed fixture while still verifying ordering and limit behavior.

### Tests
- Targets the single remaining failure from GitHub CI run `25619796677` (`findManyStream` ordering).

---

## 0.13.2 (2026-05-10)

**Integration-suite stabilization for the v0.13 patch recovery.**

### Fixed
- Prevented unknown `with` relations from sharing the no-relation SQL cache key before relation validation runs.
- Updated legacy integration expectations for safe not-found messages and seeded fixture sizes.

### Tests
- GitHub CI run `25619387838` passed build, typecheck, lint, coverage, unit, error-code, and security jobs; this patch targets the remaining integration-only failures.

---

## 0.13.1 (2026-05-10)

**CI hardening patch for the v0.13 dialect-hook release.**

### Fixed
- Generated the Studio UI fixture before typecheck and test scripts so clean CI checkouts can resolve `studio-ui.generated.js`.
- Changed an internal Postgres bulk-insert dialect guard to throw `ValidationError`, preserving Turbine error-code enforcement.
- Corrected integration cursor pagination expectations for the seeded 8-user fixture.
- Fixed the query cache fingerprint for `isEmpty: true` vs `isEmpty: false` array filters and now emits `cardinality(...)` checks that exclude empty arrays from non-empty queries.
- Updated the CI package-size gate to parse npm output robustly and match the current published tarball size budget.

### Tests
- CI failure triage covered typecheck, build, unit, coverage, error-code, and integration logs from GitHub Actions run `25619209599`.

---

## 0.13.0 (2026-05-10)

**DDL and migration dialect hooks for future MySQL/SQLite packages.**

### Added
- Extended the `Dialect` contract with schema DDL builders for column types, column definitions, table creation, primary keys, and indexes.
- Added migration tracking SQL builders so dialect packages can own `_turbine_migrations` DDL and applied-migration record queries.
- `schemaToSQL()` / `schemaToSQLString()` now accept an optional dialect for build-time DDL generation while preserving PostgreSQL as the default.
- Added MySQL-style build-only regression coverage for backtick DDL, `BIGINT AUTO_INCREMENT`, `DATETIME`, `JSON`, FK indexes, and MySQL-shaped migration tracking SQL.

### Changed
- The root `turbine-orm` package remains PostgreSQL-only at runtime. This release removes another dialect-package blocker; it does not ship MySQL/SQLite drivers, introspection, or migration execution.
- Exported schema DDL dialect input types and `SchemaSqlOptions` for future dialect packages.

### Tests
- 681 unit tests, 0 failures.
- Lint, typecheck, and build clean.

---
## 0.12.0 (2026-05-10)

**DML dialect hooks for future MySQL/SQLite packages.**

### Added
- Extended the `Dialect` contract with DML SQL builders for `INSERT`, bulk insert, upsert, and `RETURNING` clauses.
- PostgreSQL's default dialect now owns the existing `RETURNING *`, `UNNEST(...)`, and `ON CONFLICT` generation instead of hardcoding those primitives in `QueryInterface`.
- Bulk insert dialect builders now return both SQL and params so non-Postgres dialects can use row-major `VALUES` params while PostgreSQL keeps column-array `UNNEST` params.
- Added MySQL-style build-only regression coverage for DML output: backtick identifiers, `?` placeholders, `VALUES (?, ?), (?, ?)`, `ON DUPLICATE KEY UPDATE`, and no Postgres-only `RETURNING` / `UNNEST` / `ON CONFLICT`.

### Changed
- No public Postgres import or runtime behavior changes. This is still foundation work for dialect packages, not MySQL/SQLite GA support.
- Exported DML dialect input/result types for future dialect packages.

### Tests
- 679 unit tests, 0 failures.
- Lint, typecheck, and build clean.

---

## 0.11.0 (2026-05-10)

**Dialect interface foundation for MySQL/SQLite expansion.**

### Added
- **Dialect contract** (`src/dialect.ts`) with PostgreSQL implementation and public exports for future `@turbine-orm/mysql` / `@turbine-orm/sqlite` packages.
- **Query builder dialect seam**: identifiers, placeholders, nested relation JSON aggregation, case-insensitive LIKE, JSON contains/path operations, and relation correlation now route through the active dialect while preserving PostgreSQL output by default.
- **Internal `TurbineConfig.dialect` option** so dialect packages can inject their SQL primitive implementation without forking the public client shape.
- **Dialect regression tests** proving a MySQL-style dialect can emit backtick identifiers, `?` placeholders, `JSON_OBJECT`, `JSON_ARRAYAGG`, `JSON_CONTAINS`, and non-`ILIKE` insensitive search.

### Changed
- PostgreSQL remains the default and `turbine-orm` imports are unchanged. This release is a compatibility-preserving foundation step, not a MySQL/SQLite GA release.
- Test scripts now include the dialect contract suite.

### Tests
- 678 unit tests, 0 failures.
- Lint, typecheck, and build clean.

---

## 0.10.0 (2026-05-09)

**Database adapters, composite FK support, marketing rewrite, full hardening pass.**

### Added
- **Database adapter system** (`src/adapters/`): pluggable `DatabaseAdapter`
  interface for PG-compatible databases. Ships `cockroachdb` (table-based
  locking, introspection overrides, transaction_timeout syntax), `yugabytedb`
  (distributed table locks), and no-op `alloydb`/`timescale` adapters.
  New `./adapters` subpath export.
- **Composite foreign key support**: `introspect.ts` now groups FK rows by
  constraint name. `RelationDef.foreignKey`/`referenceKey` accept
  `string | string[]`. New `buildCorrelation()` utility generates AND-joined
  equality clauses. Code generation emits array literals for composite FKs.
- **Compatibility docs page** (`/compatibility`): CockroachDB, YugabyteDB,
  AlloyDB, Timescale connection guides and feature matrices.
- **Multi-DB architecture plan** (`docs/MULTI_DB_PLAN.md`): design doc for
  future MySQL/SQLite/SQL Server as separate `@turbine-orm/*` packages.
- **Dynamic OG + Twitter images**: Next.js `ImageResponse` routes for social
  sharing previews.
- **JSON-LD structured data** on landing page (SoftwareApplication schema).
- **Per-page canonical URLs** and Twitter card metadata across all docs.
- **`upsert` and `groupBy` documentation** in API reference.
- **56 new tests** for database adapters (CockroachDB, YugabyteDB, pg-compat).
- **64 new tests** for coverage gaps: `client-coverage.test.ts` (middleware,
  timeouts, external pools, SAVEPOINTs) and `schema-diff.test.ts` (all
  schemaDiff patterns).
- **10 new tests** for relation filter field validation.
- **14 new tests** for composite FK correlation and introspection.

### Fixed
- **Validation gap in `buildSubWhereForRelation`** (medium-severity security
  finding): now validates column existence against target table metadata,
  throws `ValidationError` with field name and available columns.
- **Multi-column FK introspection bug**: composite FKs no longer split into
  separate single-column relations.
- **Dead `/roadmap` link** in Prisma migration page removed.
- **Pipeline API inconsistency** across docs unified to `db.pipeline(...)`.
- **Sidebar accessibility**: Escape key closes mobile menu, aria-expanded +
  aria-labels added.
- Removed 7 unused imports caught during lint cleanup.

### Changed
- **Landing page messaging** rewritten: leads with "110 KB. One dep." and
  actual differentiators (Studio, PII-safe errors, migrations). Feature
  section titled "What Prisma and Drizzle don't ship."
- **README top section** reframed around real moat; json_agg moved to
  "How it works" supporting section.
- **Comparison tables** expanded (9 rows, install size + Studio first).
- `migrate.ts` and `studio.ts` now accept optional `DatabaseAdapter` for
  pluggable locking and timeout strategies. Fully backwards-compatible.
- Hero badge changed from `v0.9` to `pre-1.0`.
- Cleaned 6 vestigial empty route directories from `site/app/`.

### Tests
- 674 unit tests, 0 failures (up from 530 in v0.9.2).
- Lint: 0 warnings, 0 errors (72 warnings suppressed with targeted
  `biome-ignore` comments including justification).
- TypeScript: strict check clean.

---

## 0.9.2 (2026-04-14)

**Docs + positioning patch.** Sharpens the landing-page/README pitch around the
real differentiators (one runtime dep, Studio, code-first + DB-first in one
CLI, first-class edge runtimes) and demotes `json_agg` as a headline feature
since Drizzle and Prisma 7 both use it. Ships four new site doc pages, a
contributor seed script, and two new internal design docs (dialect roadmap +
full DX reference).

### Docs
- **New site pages:** `/relations` (deep-dive on `with`, nested options,
  relation filters, payload-size warnings with concrete numbers),
  `/transactions` (`$transaction` callback form, isolation, timeouts, nested
  SAVEPOINTs, retry loops for `DeadlockError` / `SerializationFailureError`,
  `pipeline()` semantics), `/serverless` (Neon / Vercel Postgres / Cloudflare
  Hyperdrive / Supabase walkthroughs, `PgCompatPool` contract, edge memory
  budget table), `/migrate-from-prisma` (promoted from `docs/` with an 8-step
  checklist and schema translation example).
- **Landing hero + README** rewritten to lead with "one runtime dependency,"
  built-in Studio, code-first + DB-first in the same CLI, and edge runtime
  support. `json_agg` moved to the last feature rather than the first.
- **Sidebar + sitemap** updated to include the four new pages.

### Internal docs
- **`docs/NEXT-INTEGRATIONS.md`** — post-v1.0 dialect roadmap. Tier 1:
  CockroachDB (~1 engineer-week, PG-wire already compatible) and MySQL
  (4–6 weeks as `turbine-orm/mysql` subpath). Tier 2: SQLite (3 weeks; also
  wins internal CI speed). Tier 3 skip: SQL Server (engineering cost too high,
  audience already captured by TypeORM), MongoDB (philosophical mismatch).
  Tier 4 declined: PowDB (custom binary wire protocol, no SQL, no `json_agg`,
  no `information_schema` — revisit when PG-wire compat layer ships).
- **`docs/USING-TURBINE-ORM.md`** — 19-section full DX reference covering
  schema / client / reads / where / with / writes / transactions / pipeline /
  streaming / raw SQL / errors / CLI / migrations / Studio / testing /
  deployment / intentional non-features. Each section includes port notes
  for building a similar TypeScript client against another database.

### Contributor DX
- **`scripts/seed-test-db.sh` + `scripts/docker-compose.yml`** — one-command
  Postgres seed for the integration-test database (throwaway Docker Compose
  on port 54329, benchmark seeder on first run). `CONTRIBUTING.md` updated
  with the new path.
- **`.c8rc.json`** — scope comment added (why `cli/`, `generate.ts`,
  `introspect.ts`, `serverless.ts`, `index.ts` are excluded) and thresholds
  raised: lines 57→65, functions 64→70, statements 57→65, branches 80→82.

No runtime changes. 530/530 unit tests pass.

## 0.9.1 (2026-04-10)

**Docs + tests patch.** Restores accurate messaging around deep `with`-clause
type inference (shipped since 0.7.1) and locks in the end-to-end inference
path with compile-time assertions. No runtime changes — `WithResult`,
`RelationDescriptor`, and the generator's branded `*Relations` output were
already in place and correct; this release just stops claiming otherwise in
the README/landing page and adds a regression guard.

### Tests
- **End-to-end compile-time assertions for deep `with` inference through real
  call sites** (`src/test/with-inference.test.ts`). The existing tests only
  verified `WithResult` in isolation; the new sections 8 and 9 exercise
  `findMany` / `findUnique` / `findFirst` / `findUniqueOrThrow` at 1/2/3
  nested levels via both explicit type arguments and plain call-site literal
  inference (`users.findMany({ with: { posts: { with: { comments: ... } } } })`).
  If inference regresses at the user-facing signature, `tsx --test` now exits
  non-zero because the test file fails to typecheck. 530/530 unit tests pass.

### Docs
- **README + site/app/page.mdx:** removed the "deep `with` type inference
  lands in v1.0" caveat that slipped into 0.9.0 and replaced it with an
  accurate description of the shipped feature. Deep inference has been
  working end-to-end since 0.7.1 via the recursive `WithResult` mapped type
  and the generator's `RelationDescriptor`-branded `*Relations` interfaces —
  the 0.9.0 README was wrong, not the runtime.
- **CLAUDE.md "Type System" section** corrected: removed the stale "Current
  limitation: `with` clause return types do not reflect included relations
  at the type level" paragraph (a pre-0.7.1 artifact) and replaced it with
  an accurate architecture note covering `TypedWithClause`, `WithResult`,
  `RelationDescriptor`, and `ApplyCardinality`.

## 0.9.0 (2026-04-09)

**Studio Premium.** Turbine now ships a premium, read-only Studio web UI — the
only Postgres ORM with a Studio your DBA will approve. Loopback-bound by
default, random per-process auth token, every query runs inside
`BEGIN READ ONLY` + `SET LOCAL statement_timeout = '30s'`, and a strict
SELECT/WITH parser blocks statement stacking. No mutations, no writes, no way
around the transaction guard — the posture is unchanged from 0.8.0 and a
product review (8.1/10) found zero CRITICAL or HIGH vulnerabilities.

### Added
- **Premium Studio UI** with Data / Schema / SQL / Builder tabs — a
  single-file embedded HTML/CSS/JS bundle served by the CLI `turbine studio`
  command, matching the turbineorm.dev dark theme.
- **Cmd+K command palette** for fast navigation across tables, tabs, and
  saved queries.
- **Saved queries** — named SQL snippets persisted to
  `.turbine/studio-queries.json` and surfaced in the SQL tab and command
  palette.
- **Visual query composer** (Builder tab) with live TypeScript preview —
  pick a table, compose `where` / `orderBy` / `with` / `limit` visually, and
  watch the matching `db.table.findMany(...)` code render in real time.
- **Full-text search across table rows** — the Data tab now supports
  substring search across every text column via a `search` query parameter.
- **Sortable tables, JSON modal, toasts, keyboard shortcuts** — every data
  table is column-sortable; JSON/JSONB cells open in a full-screen modal;
  toast notifications confirm saves/errors; keyboard shortcuts for tab
  switching, row navigation, and query execution.
- **Four new backend endpoints:** `/api/builder` (preview SQL for a visual
  composer payload), `/api/saved-queries` (GET/POST/DELETE), and a `search`
  query parameter on `/api/tables/:name`.
- **CLI flag smoke test** (`src/test/cli-flags.test.ts`) — locks in every
  `turbine studio` flag (`--port`, `--host`, `--no-open`) against the
  argument parser.

### Changed
- **Migration advisory lock ID is now derived from the database name via
  FNV-1a** — fixes cluster-wide contention when two databases on the same
  Postgres cluster both run `turbine migrate up` concurrently. The previous
  implementation used a static lock ID, so a migration in database A would
  block a migration in database B. Lock ID is now a stable per-database
  32-bit FNV-1a hash of `current_database()` (top bit cleared for positive
  `int4`, matching Postgres advisory-lock semantics).
- **README Studio section rewritten** to headline read-only as a design
  feature, not a limitation. The old "Turbine Studio is planned but not yet
  available" bullet under Limitations has been removed.

### Fixed
- Two `any` leaks in `src/schema-builder.ts` public signatures — the
  column definition builder now exposes precise generic types end-to-end.
- Search endpoint parameter-index bug in `/api/tables/:name` — the search
  clause was using a stale `$N` index when combined with pagination params.
- Biome template-literal lint errors in `src/query.ts` surfaced by the new
  biome rules shipped in 2.4.10.

### Security
- **Studio posture unchanged from v0.8.0.** Loopback default (`127.0.0.1`,
  loud warning on non-loopback binds), 24-byte random hex token generated
  per process, `SameSite=Strict` `HttpOnly` auth cookies, every query
  wrapped in `BEGIN READ ONLY` + `SET LOCAL statement_timeout = '30s'`,
  SELECT/WITH-only parser that strips comments and rejects non-trailing
  semicolons (blocks statement stacking), and security headers
  (`X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy:
  no-referrer`). Product review scored the surface 8.1/10 and found
  **zero CRITICAL or HIGH vulnerabilities**.

## 0.8.0 (2026-04-09)

### Added
- **Real Postgres extended-query pipeline protocol.** `pipeline()` now uses
  the wire-level pipeline protocol (parse/bind/describe/execute/sync in a
  single TCP flush) on connections that support it, via `pipeline-submittable.ts`.
  Falls back to sequential execution for HTTP drivers, mocks, and other
  non-TCP connections. Verified 2.58× speedup over sequential on Neon.
- **SQL template caching with shape-keyed fingerprinting.** Queries with the
  same WHERE/WITH/ORDER BY structure (same keys and operators, different values)
  reuse cached SQL text. FNV-1a 64-bit hashing generates deterministic prepared
  statement names. LRU cache at 1,000 entries. Cache hit/miss stats via
  `queryInterface.cacheStats()`.
- **Prepared statement support.** When `preparedStatements: true` (default for
  owned pools), queries use pg's `{ name, text, values }` object form. Postgres
  caches the execution plan after the first call. Disable per-client or via
  `TURBINE_DISABLE_PREPARED=1` env var. Automatically disabled for external
  pools (serverless drivers).
- **Streaming speculative first fetch.** `findManyStream` now issues a
  `LIMIT batchSize+1` first query. If the result fits in one batch, rows are
  yielded directly without `DECLARE CURSOR` overhead. Only large result sets
  escalate to server-side cursors.
- **Default `batchSize` increased from 100 to 1000.** Reduces FETCH round-trips
  from 500 to 50 for a 50K-row drain, closing the streaming performance gap.
- **`parseNestedRow` short-circuit.** Empty hasMany (`'[]'`), null belongsTo
  (`'null'`, `null`), and pre-parsed arrays skip `JSON.parse` entirely.
- **`PipelineError` (`TURBINE_E014`)** with per-query result status array
  (`.results`), `.failedIndex`, and `.failedTag` for diagnosing partial
  pipeline failures in non-transactional mode.
- **`PipelineOptions`** type with `transactional` (default true) and `timeout`
  fields. Non-transactional mode uses per-query Sync for error isolation.
- **`pipelineSupported(pool)`** public probe — check at runtime whether a pool
  supports the real pipeline protocol.
- **`TurbineConfig` flags:** `preparedStatements` (boolean), `sqlCache` (boolean).
- New benchmark scenarios: pipeline (5-query dashboard batch) and hot findUnique
  (500× same shape, rotating IDs).
- 88 new unit tests (pipeline-submittable: 12, sql-cache: 54, stream-and-parse: 19,
  pipeline integration: 3). **486 tests total.**

### Changed
- **Benchmark results updated.** With SQL caching, prepared statements, and
  streaming optimizations, Turbine now wins or ties 6/8 scenarios on Neon.
  L2 nested reads: 1.59× faster than Drizzle. Streaming 50K rows: at parity
  with Prisma (~3.2 s), 1.49× faster than Drizzle. See `benchmarks/RESULTS.md`.

### Docs
- **Benchmarks reconciled against a real pooled database.** The
  README benchmark table and the "Turbine is fastest in every
  scenario" framing dated from a local Postgres run; a full three-way
  head-to-head against Prisma 7.6 (with `relationJoins`) and Drizzle
  0.45 on Neon (US-East, pooled, PostgreSQL 17.8) shows all three
  ORMs land within ~5 ms of each other on every read scenario because
  network latency dominates. Turbine's `findManyStream` is actually
  ~1.5× *slower* than keyset pagination for drain-all workloads
  because of `BEGIN/DECLARE/CLOSE/COMMIT` overhead. README, strategic
  plan, and the `streaming-csv` example have all been rewritten to
  pitch Turbine on architectural merits (one dep, edge import swap,
  typed errors, `with` inference) rather than speed. Full writeup:
  `benchmarks/RESULTS.md`.
- Added `benchmarks/seed-neon.ts` so the benchmark harness is fully
  reproducible against any Postgres endpoint (Neon, Vercel, local).
- `benchmarks/bench.ts` gained two new scenarios: streaming (drain
  50K rows three ways) and atomic counter (`view_count + 1`).

## 0.7.1 (2026-04-07)

This release is a hardening + DX pass on top of 0.7.0. CLI now reliably loads
TypeScript schema files, error messages are safer by default, two new typed
errors cover transient Postgres failures, composite primary keys are first
class, and the `with` clause is fully type-inferred at any nesting depth.

### Added
- **`DeadlockError`** (`TURBINE_E012`) and **`SerializationFailureError`** (`TURBINE_E013`) — both expose `isRetryable: true` for safe automatic retry on Postgres `40P01` and `40001` sqlstates. Surfaced through `wrapPgError()` at every query chokepoint.
- **Composite primary keys:** `defineSchema()` now accepts a table-level `primaryKey: ['col1', 'col2']` field. The DDL generator emits a `CONSTRAINT ... PRIMARY KEY (col1, col2)` and the typed `findUnique` accepts the composite key as an object.
- **Deep `with`-clause type inference:** the `WithResult` mapped type now recurses through arbitrarily nested `with` clauses, so `db.users.findMany({ with: { posts: { with: { comments: true } } } })` narrows the return type to `User & { posts: (Post & { comments: Comment[] })[] }` without manual assertions.
- **Typed `TransactionClient` table accessors:** the `tx` argument inside `$transaction(async (tx) => ...)` now exposes the same `tx.users` / `tx.posts` typed accessors as the top-level client. Generated clients emit a typed `TransactionClient` subclass alongside the main `TurbineClient` subclass.
- **Atomic update operator types in generated `*Update` interfaces:** numeric fields now allow `{ increment | decrement | multiply | divide | set: number }` at the type level, matching the runtime behaviour shipped in 0.6.2.
- **`findMany` unlimited-query warning:** `findMany` calls without a `limit` (and no `defaultLimit` configured) now emit a one-time warning per table. Disable with `warnOnUnlimited: false` in `TurbineConfig`.
- **Strict operator validation:** JSONB-only operators (`hasKey`, `path`) and array-only operators (`has`, `hasEvery`, `hasSome`) now throw `ValidationError` when applied to columns of the wrong Postgres type, instead of silently generating broken SQL.
- **`$transaction` timeout cleanup:** when a transaction exceeds its `timeout`, Turbine now destroys the underlying connection rather than returning it to the pool, freeing the slot immediately.
- **WHERE Operator Reference** in README — every operator (equality, sets, comparison, string, relation, array, combinators) with a one-line description and example.
- **Prisma migration guide** at `docs/migrate-from-prisma.md` — API mapping table, side-by-side `findMany` example, and notes on the differences (`include` -> `with`, code-first schema, typed errors, edge support).
- **Four serverless example apps** under `examples/`: `neon-edge` (Neon on Vercel Edge), `cloudflare-worker` (Hyperdrive + `pg`), `vercel-postgres` (`@vercel/postgres` on the Next.js app router), and `supabase` (direct `pg` to Supabase). Each is self-contained with `schema.ts`, entrypoint, `package.json`, and a setup README.

### Fixed
- **CLI `turbine push` failed on `.ts` schema files:** the loader now registers `tsx`/`tsm` as needed before importing the schema module, so `npx turbine push --schema ./schema.ts` works without a manual loader flag.
- **README contradicted runtime on atomic update operators:** the "no incremental updates" bullet under Limitations falsely claimed `{ count: { increment: 1 } }` was unsupported. Atomic operators have shipped since 0.6.2 — bullet removed and a worked example added under Usage Examples.
- **`NotFoundError` no longer leaks `where` values into error messages by default.** Messages are now `[turbine] findUniqueOrThrow on "users" found no record` with the original `where` still attached on the error object for programmatic inspection. Opt back into the verbose form with `errorMessages: 'verbose'` in `TurbineConfig` if you need the previous behaviour.

### Docs
- README: corrected stale `70KB` package size in the Next.js example to `~110KB` (matches the v0.6.3 fix).
- Next.js example rewritten to use the generated typed accessor (`db.users.findMany`) instead of the untyped `db.table<User>('users')` lookup.

## 0.7.0 (2026-04-07)

This release is a quality + reach overhaul driven by a full product review
and gold-standard OS audit. Biggest new capability: **Turbine now runs on
the edge** via any pg-compatible driver (Neon, Vercel Postgres, Cloudflare
Hyperdrive, etc.) without bundling a single extra dependency.

### Added
- **Serverless / edge support** (`turbine-orm/serverless`): new `turbineHttp(pool, schema)` factory and `PgCompatPool` / `PgCompatPoolClient` / `PgCompatQueryResult` interfaces. Plug in `@neondatabase/serverless`, `@vercel/postgres`, or any other pg-API compatible pool and Turbine runs on Vercel Edge, Cloudflare Workers, Deno Deploy, and similar environments.
- New `TurbineConfig.pool` option — pass an external pg-compatible pool and Turbine will route all queries through it instead of creating its own `pg.Pool`. `disconnect()` is a no-op for externally-owned pools.
- New public subpath export: `turbine-orm/serverless` (both ESM and CJS).
- **`with`-clause type inference:** optional second type parameter `QueryInterface<T, R>` surfaces included relations at the type level. Generated clients now emit `{Entity}Relations` interfaces, so `db.users.findMany({ with: { posts: true } })` narrows the return type to include `posts: Post[]`.
- New exports: `TypedWithClause`, `WithResult`, `PgCompatPool`, `PgCompatPoolClient`, `PgCompatQueryResult`, `turbineHttp`, `TurbineHttpOptions`.

### Changed
- **`serverless.ts` rewritten:** the old custom HTTP-proxy protocol (which required a nonexistent Turbine proxy server) is gone. It is replaced with a thin, driver-agnostic factory that binds any pg-compatible pool to a schema. No new runtime dependencies.
- `TurbineClient.stats` now returns zeros for pools that don't expose connection counts (HTTP drivers), instead of `undefined`.
- `pg.types.setTypeParser(20, ...)` registration is now skipped when Turbine is given an external pool — prevents Turbine from mutating global state owned by the external driver.

### Tests
- 308 unit tests passing (up from 254).
- New test file: `src/test/serverless.test.ts` — 9 tests covering external pool integration, transaction routing, lifecycle ownership, and error propagation via a mock `PgCompatPool`.
- New test file: `src/test/pipeline.test.ts` — 5 tests covering `executePipeline`: BEGIN/COMMIT wrapping, transform ordering, ROLLBACK on failure, parameter passing, and empty-input short-circuit.

### Docs
- README: new "Serverless / Edge" section with Neon, Supabase, and Vercel Postgres examples.
- `src/serverless.ts`: extensive JSDoc covering supported drivers, limitations over HTTP (streaming cursors, LISTEN/NOTIFY), and full usage examples for Neon on Vercel Edge and Cloudflare Workers.

## 0.6.3 (2026-04-07)

### Security
- **SSL/TLS support:** Added `ssl` option to `TurbineConfig` for secure connections to cloud providers (RDS, Supabase, Neon, etc.)
- Aggregate column aliases now quoted via `quoteIdent()` in `buildGroupBy()` and `buildAggregate()` — prevents potential SQL syntax injection
- Column validation added to `buildAggregate()` matching `buildGroupBy()` — rejects unknown field names
- `findManyStream()` batch size coerced to safe positive integer

### Changed
- **README repositioned:** Tagline and "Why Turbine?" section now lead with streaming, typed errors, pipeline, and middleware as primary differentiators. json_agg presented as shared approach rather than unique feature
- Removed stale "no WASM" claims about Prisma (Prisma 7 dropped Rust engine in Jan 2026)
- Package size claim corrected from "70KB" to "~110KB" (actual npm pack size)
- `pg.types.setTypeParser(20, ...)` moved from module scope into `TurbineClient` constructor with once-guard — fixes incorrect `sideEffects: false` in package.json

### Tests
- 254 unit tests passing
- Shared test helpers extracted to `src/test/helpers.ts`

## 0.6.2 (2026-04-06)

### Added
- **Typed constraint-violation errors:** `UniqueConstraintError`, `ForeignKeyError`, `NotNullViolationError`, `CheckConstraintError` — pg sqlstate codes (23505/23503/23502/23514) are translated automatically at every query chokepoint (CRUD, raw, transactions, pipelines, streaming)
- `wrapPgError()` helper translates pg driver errors into typed Turbine errors with `cause` chaining preserved for stack traces
- **Atomic update operators:** `update`/`updateMany` now support Prisma-style `{ increment, decrement, multiply, divide, set }` operators for race-free counter updates
  ```ts
  await db.posts.update({ where: { id: 5 }, data: { viewCount: { increment: 1 } } })
  ```
- New exported types `UpdateInput<T>` and `UpdateOperatorInput<V>` with conditional `V extends number` narrowing — `increment` on a non-numeric column is a compile-time error
- Operator detection uses strict single-key rule to avoid collisions with JSON column payloads

### Changed
- **`NotFoundError` now carries query context:** `findFirstOrThrow`, `findUniqueOrThrow`, `update`, `delete`, `upsert`, and `create` now throw `NotFoundError` with `{table, where, operation}` fields and Prisma-style messages:
  ```
  [turbine] findUniqueOrThrow on "users" found no record matching where: {"id":1}
  ```
- `NotFoundError` constructor accepts either a string (back-compat) or `{table?, where?, operation?, cause?, message?}` options object
- Removed dead `having` field from `GroupByArgs` interface (was silently ignored)

### Tests
- 514 integration tests + 239 unit tests, all passing
- 19 new tests for atomic update operators including 10-way concurrent atomicity proof
- 10 new NotFoundError unit tests covering back-compat, format, fields, override, cause chains
- New test file: `src/test/update-operators.test.ts`

## 0.6.1 (2026-04-06)

### Added
- **Streaming cursors:** `findManyStream()` returns `AsyncGenerator<T>` backed by PostgreSQL `DECLARE CURSOR` — constant memory for large result sets
- Configurable `batchSize` (default: 100) for internal FETCH batching
- Streaming supports all `findMany` options: `where`, `orderBy`, `limit`, `with` (nested relations)
- Early termination via `break` automatically cleans up cursor and connection
- **Next.js example app** (`examples/nextjs/`) — server-rendered demo with nested relations, code blocks, and streaming showcase
- **Auto-diff migrations:** `npx turbine migrate create <name> --auto` generates UP + DOWN SQL from schema diff
- Schema diff now detects DEFAULT value changes (SET DEFAULT / DROP DEFAULT)
- Schema diff now detects UNIQUE constraint changes (ADD / DROP CONSTRAINT)
- Schema diff generates reverse SQL for all operations (for DOWN migrations)
- Type changes now include USING clause for safe casting
- Fresh benchmark suite against Prisma 7.6 and Drizzle 0.45 (`benchmarks/`)
- README benchmarks updated with current numbers — Turbine 1.4–1.9x faster across all scenarios
- Reproducible benchmark harness: `cd benchmarks && npm install && npx prisma generate && npx tsx bench.ts`

### Changed
- `schemaDiff()` now returns `reverseStatements` alongside `statements`
- `createMigration()` accepts optional `autoContent` for pre-populated UP/DOWN
- README benchmark section replaced with fresh Prisma 7 / Drizzle v2 results (was Prisma 5.x / Drizzle v1)
- Comparison section updated to reflect all three ORMs now using single-query approaches

## 0.6.0 (2026-04-05)

### Security
- **CRITICAL:** Fixed shell injection in seed command — replaced `execSync` string interpolation with `execFileSync` array args
- Migration tracking table name now quoted via `quoteIdent()` at all SQL interpolation sites
- DEFAULT value validation rejects strings containing semicolons and SQL statement keywords
- Connection string redaction (`redactUrl()`) applied to all CLI error output paths

### Added
- Column validation in `orderBy` — throws `ValidationError` for unknown column names
- Column validation in `groupBy` — throws `ValidationError` for unknown column names
- Runtime type validation in `defineSchema()` — throws for invalid column types not in TYPE_MAP
- JSON parse warning in nested relation parsing — warns instead of silently falling back
- Error handling section in README with typed error examples and error code reference
- 20 new unit tests (validation, DEFAULT edge cases, schema type checks) — 171 total

### Changed
- README messaging: "Prisma-inspired API" replaces "Prisma-compatible API"
- README tagline leads with Postgres-native positioning instead of speed claims
- Benchmark section now notes results are against Prisma 5.x / Drizzle v1 with context about modern versions
- Comparison table updated: Prisma now shown as "1 query (LATERAL JOIN + json_agg, since v5.8)"
- package.json description updated to factual positioning: "Postgres-native TypeScript ORM"
- `noExplicitAny` lint rule changed from "off" to "warn" in biome.json
- "Why Turbine?" section rewritten to lead with architectural simplicity, not speed claims

### Fixed
- Stale "Prisma sends 3 separate queries" claim in README (Prisma 7+ uses single query)
- Stale "2-3x faster than Prisma" claim in package.json description
- Stale benchmark context in query.ts header comment

## 0.5.0 (2026-03-28)

### Security
- DDL identifier quoting via `quoteIdent()` on all CREATE/ALTER/DROP statements
- DEFAULT value validation against strict allowlist
- Path traversal protection on `--out` flag
- Shell escaping for seed file paths
- `json_build_object` key escaping

### Added
- Full migration engine: `turbine migrate create/up/down/status`
  - Advisory locking for concurrent migration safety
  - Checksum validation for drift detection
  - Per-migration transactions with rollback on failure
- LRU cache (1,000 entries) for SQL query templates
- Case-insensitive LIKE support (`mode: 'insensitive'` on string filters)
- Per-query timeout option
- Configurable `defaultLimit` and `warnOnUnlimited` for findMany
- CJS output alongside ESM (dual publishing)
- Pre-computed column type lookups (O(1) instead of O(n))
- 89 unit tests (schema-builder + migrations)

### Changed
- Node.js requirement lowered from >= 22 to >= 18
- Test runner changed from `node --experimental-strip-types` to `tsx`
- `numeric` type now consistently maps to `string` (removed runtime parser)
- Middleware JSDoc clarifies that args are captured before middleware runs

### Fixed
- Test suite was completely broken (import resolution mismatch)
- `numeric`/`bigint` type mismatch between generated types and runtime
- `process.exit(0)` in integration tests killed parallel test runner
- CLI `showVersion()` was hardcoded to v0.3.0
- Test files leaked into npm package via `dist/cjs/test/`

## 0.4.0 (2026-03-26)

### Added
- `findFirst`, `findFirstOrThrow`, `findUniqueOrThrow` query methods
- Middleware system (`db.$use()`) for query interception

## 0.3.0 (2026-03-25)

### Added
- Initial public release
- Schema introspection from `information_schema` + `pg_catalog`
- Type generation (entity interfaces, create/update types, relation types)
- Query builder with `json_agg` nested relations (L2-L4 depth)
- 18+ WHERE operators (gt, gte, lt, lte, in, notIn, contains, startsWith, endsWith, OR, AND, NOT)
- JSONB operators (contains, equals, path, hasKey)
- Array operators (has, hasEvery, hasSome, isEmpty)
- Transactions with nested SAVEPOINTs and isolation levels
- Pipeline batching
- Raw SQL tagged templates
- Schema builder (`defineSchema()`) with TypeScript objects
- CLI: init, generate, push, migrate, seed, status
