# Changelog

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
