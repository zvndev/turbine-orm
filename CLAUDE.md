# Turbine ORM

Postgres-first TypeScript ORM, with optional SQLite/MySQL/SQL Server engines behind subpath exports. Single-query nested relations via `json_agg`. Postgres remains the default and primary target; the other engines share the same typed API but several flagship features stay Postgres-only (see the capability notes in `dialect.ts` below).

## Quick Reference

```bash
npm install           # Install deps
npm run build         # ESM + CJS output (dist/ and dist/cjs/)
npm run typecheck     # tsc --noEmit
npm run test:unit     # Schema builder + migration tests (no DB needed)
npm test              # All tests (needs DATABASE_URL)
npm run lint          # Biome lint
npm run lint:fix      # Biome lint --apply
```

## Architecture

The core insight: instead of N+1 queries for nested relations, Turbine generates a single SQL statement using PostgreSQL's `json_agg` + `json_build_object` with correlated subqueries.

**Dependency graph:** `client.ts` wraps `query/` with connection pooling and transactions. The `query/` module is the heart — it builds all SQL and parses results. `pipeline.ts` batches multiple `DeferredQuery` objects from `query/` into a single round-trip. The CLI (`cli/`) imports `generate.ts`, `introspect.ts`, and `schema-sql.ts`, and since v0.19 the ORM-native Studio (`cli/studio.ts`) also imports `QueryInterface`/`quoteIdent` from `query/`. The CLI still never imports `client.ts` directly — that's the real circular-dependency rule.

```
src/
  query/            — The heart, split into submodules:
    types.ts        — All public query arg types (~785 LOC): WhereClause, WithClause,
                      FindManyArgs, RelationDescriptor, WithResult, UpdateOperatorInput,
                      AggregateArgs, JsonFilter, ArrayFilter, HavingClause (groupBy
                      aggregate filtering), VectorFilter/VectorOrderBy (pgvector distance
                      ops), etc.
    utils.ts        — Pure utility functions (~130 LOC): quoteIdent(), escapeLike(),
                      LRUCache (1K entry cap), fnv1a64Hex(), sqlToPreparedName(),
                      OPERATOR_KEYS constant.
    filters.ts      — Where-filter type guards + shape fingerprints (isWhereOperator,
                      isJsonFilter/isArrayFilter/isVectorFilter, sortedKeys/sortedEntries,
                      normalizeOrderBy). Kept out of builder.ts so the class stays about
                      SQL assembly rather than filter-shape bookkeeping.
    where-compile.ts — The canonical where-clause enumeration (~300 LOC, added 0.36):
                      walkWhere() is THE single key-ordering/branch authority that
                      fingerprintWhere/buildWhereClause/collectWhereParams in builder.ts
                      all consume (kills the 3-way hand-sync drift class behind the
                      0.19.2/0.32.1 cache bugs), plus classifyScalarForSql (column-aware
                      scalar-shape decision) and fingerprintScalarToken (deliberately
                      column-blind for fingerprint byte-stability). Relation sub-wheres one
                      level down (the relation-filter EXISTS body AND the relation
                      `with`-clause `where`) are ALSO consumers now: builder.ts binds a
                      per-target-table WhereHost and drives ONE `buildScopedWhere` /
                      `collectScopedWhereParams` / `fingerprintScopedWhere` trio (over a
                      small `WhereScope` = column qualifier + meta + correlation parent), so
                      no walker is hand-mirrored anymore. cacheCrossCheckMode() in
                      builder.ts: 'dev' (always-on NODE_ENV guard) | 'sampled'
                      (TURBINE_CACHE_CHECK_SAMPLE env, rate in (0,1], log-once-per-
                      fingerprint then throw) | 'off'.
    deferred.ts     — DeferredQuery, QueryInterfaceOptions, middleware/event types.
    builder.ts      - QueryInterface class + the execute FACADE (~2.4K LOC). Owns the
                      constructor, connection/middleware/timeout execution, the SQL-template
                      cache (acquireSql + crossCheckCache), findMany/findUnique/findFirst +
                      streaming assembly, count, the async create/update/delete/upsert
                      wrappers (incl. nested-write plumbing), and the shared primitives
                      (q/p/castAgg/toColumn/toSqlColumn/pagination/parseRow, dev NODE_ENV
                      guards). All WHERE / aggregate / write / relation SQL GENERATION now
                      lives in the sibling modules below; builder.ts keeps only thin
                      delegating methods for the cross-module + public + @internal entry
                      points. The seam is a single `BuilderCtx` object literal (built once
                      in the constructor, mirroring the `whereHost` precedent): a
                      privacy-preserving view exposing exactly the class-resident primitives
                      the modules need: live data fields, a `currentSkip` getter/setter, and
                      bound method members. Each module's functions are `export function
                      f(qi: BuilderCtx, …)` and import each other directly; the class holds a
                      `private readonly ctx: BuilderCtx`.
    where.ts        - The whole WHERE web (~1.8K LOC): the top-level and table-scoped
                      build/collect/fingerprint trios, leaf JSON/array/vector/text-search
                      clause builders, operator-clause + column-reference compilation, and
                      the client-level global-filter helpers. Owns the `BuilderCtx`
                      interface. Depends on nothing else in query/ (relation filters build
                      EXISTS inline), so it is the base module the others build on.
    aggregates.ts   - buildAggregate + buildGroupBy and helpers (~760 LOC): HAVING clauses,
                      groupBy ordering, DISTINCT-ON sources, JSON-path aggregate targets.
                      Reuses where.ts for WHERE compilation; shared orderBy / row-parse
                      primitives stay class-resident via the ctx.
    writes.ts       - Mutation SQL builders (~750 LOC): create / createMany / update /
                      delete / upsert / updateMany / deleteMany plus the write-projection
                      helpers (writeReturningColumns / writeReselectSelection / parseWriteRow,
                      the PII column set, optimistic-lock + atomic-operator SET clauses,
                      reselect-by-where). Reuses where.ts; the async execute wrappers stay in
                      builder.ts.
    relations.ts    - Relation + orderBy compilation (~2.1K LOC): the json_agg nested-relation
                      machinery (buildSelectWithRelations, buildRelationSubquery,
                      buildManyToManySubquery), the positional-encoding shapes + nested-row
                      parser, the full orderBy surface (plain / JSON-path / vector KNN /
                      relation _count / pick-row), relation _count expressions + their
                      global-filter params, and the with-clause fingerprint + param
                      collectors. Reuses where.ts (WHERE) and writes.ts (PII column set); the
                      last and most connected module.
    batched-loader.ts — The `relationLoadStrategy: 'batched'` path. Instead of the default
                      single-statement `json_agg` join, runs the base query without relation
                      subqueries, then ONE flat follow-up per relation
                      (`WHERE fk = ANY($1)`, chunked at MAX_RELATION_KEYS=1000) and stitches
                      client-side — output byte-for-byte equal to the join strategy. Runs on
                      the caller's executor/connection (tx-safe); per-relation `limit` applied
                      client-side per parent; composite-key relations throw E017.

    index.ts        — Barrel re-export (~65 LOC). All imports use `./query/index.js`.

  index-advisor.ts  — Missing-FK-index advisor. Derives every column set relations probe
                      (hasMany/hasOne child FKs, belongsTo reference keys, m2m junction keys)
                      from SchemaMetadata and checks each against the table's indexes/PK
                      (`findMissingRelationIndexes`). Consumed by `turbine doctor` (CLI report
                      + `--fix` migration) and the dev-mode runtime warning in query/builder.ts
                      (`missingIndexForRelation`, gated on `schemaHasIndexInfo` to avoid
                      false positives on `defineSchema`-only metadata).

  client.ts         — TurbineClient wraps a pg.Pool and auto-creates typed table accessors
                      via Object.defineProperty. Manages middleware ($use), transactions
                      ($transaction with SAVEPOINTs for nesting, isolation levels, timeouts,
                      and a sessionContext option that set_config()s txn-local GUCs for
                      Postgres RLS — plus the $withSession shorthand), typed raw SQL
                      (client.sql<T> -> typed-sql.ts), realtime ($listen/$notify ->
                      realtime.ts), raw SQL tagged templates, and pipeline batching.
                      Registers int8 parser
                      once (static flag) so bigint comes back as number. Also exports
                      PgCompatPool / PgCompatPoolClient / PgCompatQueryResult interfaces
                      and accepts an external pool via TurbineConfig.pool for serverless
                      drivers (Neon, Vercel Postgres, Cloudflare) — when an external pool
                      is supplied, Turbine does NOT call pg.types.setTypeParser and
                      disconnect() becomes a no-op (caller owns lifecycle). TurbineConfig also
                      carries the relation/wire tuning added in 0.26.0:
                      `relationLoadStrategy: 'join' | 'batched'` (client default, overridable
                      per query → query/batched-loader.ts), `jsonEncoding: 'object' |
                      'positional'` (Postgres-only lean `json_build_array` wire encoding for
                      `with` subqueries), and `utcTimestamps` (default true — registers the
                      OID 1114 parser, only for Turbine-owned pools, so offset-less `timestamp`
                      values parse as UTC; see parseDbDate in query/utils.ts).

  adapters/         — Database adapter layer (~530 LOC) for Postgres-compatible engines.
                      cockroachdb.ts + yugabytedb.ts override the operations with
                      compatibility gaps (migration locking, introspection SQL); alloydb
                      and timescale are pass-through adapters defined in index.ts.
                      Everything else falls through to standard PostgreSQL. Published as
                      the `turbine-orm/adapters` subpath export.

  dialect.ts        — The real multi-engine SQL seam (Phase-0 complete). Query generation,
                      DML, DDL, migration-tracking SQL, transactions, streaming, and
                      introspection all route through the `Dialect` contract; the package
                      stays PostgreSQL-native by default via `postgresDialect`. Key parts:
                      • `resultStrategy: 'returning' | 'reselect' | 'output'` — how a write
                        surfaces its affected rows. `returning` = trailing `RETURNING *`
                        (Postgres, SQLite ≥ 3.35); `reselect` = run the write then a
                        follow-up SELECT by PK/where (MySQL — no RETURNING); `output` =
                        rows come back from the same statement via `OUTPUT INSERTED.*` /
                        `MERGE` (SQL Server). The executor branches on this.
                      • Driver abstraction — engines bind via the external-pool seam
                        (`PgCompatPool` / `TurbineConfig.pool`); each engine ships a thin
                        pool shim (`SqlitePool`/`MysqlPool`/`MssqlPool`) plus
                        `paramPlaceholder`, `quoteIdentifier`, and tx-keyword hooks
                        (`begin/commit/rollback/savepoint/buildSetSessionConfig`).
                      • Capability flags — `supportsReturning`, `supportsVector`,
                        `supportsListenNotify`, `supportsRLS`, `supportsAdvisoryLock`,
                        `supportsILike`, `aggSupportsInlineOrderBy`, `jsonPathSupport`.
                        Builders/client throw `UnsupportedFeatureError` (E017) when a flag
                        is false instead of emitting broken SQL.
                      • Additive hooks — `wrapJsonSubresult` (SQLite `json(...)`, MSSQL
                        `ISNULL(…, '[]')`), `aggSupportsInlineOrderBy` (forces the
                        inner-subquery rewrite for ordered to-many on MySQL/SQLite),
                        `castAggregate`, `buildInClause`/`inClauseParam`, `buildLimitOffset`
                        (SQL Server `OFFSET/FETCH`), `buildUpdateStatement`/
                        `buildDeleteStatement` (mid-statement `OUTPUT`), and
                        `buildRelationSubquery` (SQL Server's `FOR JSON PATH` override).
                        `openStream()` and the `DialectIntrospector` round out the seam.

  sqlite.ts         — `turbine-orm/sqlite` engine. `turbineSqlite(path | ':memory:' |
                      DatabaseSync, schema, options?)` — synchronous, zero new dependency
                      via Node's built-in `node:sqlite` (Node ≥ 22.5; `better-sqlite3`
                      documented fallback). `sqliteDialect` uses `resultStrategy:
                      'returning'`, `json_group_array(json(...))` nested relations, and
                      `COLLATE NOCASE` (ASCII-only) for insensitive matching. The
                      in-process test / edge / "try it in 10 seconds" engine.

  mysql.ts          — `turbine-orm/mysql` engine. `await turbineMysql(url | config |
                      mysql2-pool, schema, options?)` — MySQL 8.0+ via the optional peer
                      `mysql2` (loaded by dynamic import; never a root dep). `mysqlDialect`
                      uses `resultStrategy: 'reselect'` (no RETURNING — write then re-SELECT
                      by PK/where), `JSON_ARRAYAGG`/`JSON_OBJECT` nested relations, and
                      named `:pN` placeholders. `createMany` returns `[]` (count-not-rows).

  mssql.ts          — `turbine-orm/mssql` engine. `await turbineMssql(url | config |
                      mssql-pool, schema, options?)` — SQL Server 2016+ via the optional
                      peer `mssql` (dynamic import). `mssqlDialect` uses `resultStrategy:
                      'output'` (`OUTPUT INSERTED.*` / `MERGE`), `FOR JSON PATH` nested
                      relations (`buildRelationSubquery` override), `OFFSET/FETCH` paging,
                      and named `@pN` placeholders.

  powdb.ts +        — `turbine-orm/powdb` engine (PowDB **≥ 0.7.1**).
  powql.ts            `await turbinePowDB(url | connOpts | pool | { embedded: dir, syncMode?, memoryLimit? }, schema, options?)`
                      (`url` = `powdb://host:port`; networked path probes `serverVersion` and throws
                      `ConnectionError` below 0.7.0)
                      — PowDB, a single-node DB with its OWN query language **PowQL** (not SQL).
                      Two transports: **networked** via the optional peer `@zvndev/powdb-client`
                      (binary TCP), and **embedded** (preview) via the optional peer
                      `@zvndev/powdb-embedded` (in-process napi addon, no server). Both dynamic
                      `import()` — `npm i turbine-orm` still pulls only `pg`. PowQL shares no
                      surface with `SELECT…FROM…WHERE`, so this is NOT a `Dialect`: powql.ts ships
                      a parallel `PowqlInterface` (PowQL generator with the same public method
                      surface as `QueryInterface`) wired in via the `queryInterfaceFactory`
                      option on `QueryInterfaceOptions` — `TurbineClient.table()` calls that
                      factory when present, else `new QueryInterface` (SQL engines untouched).
                      powdb.ts holds the driver shims (`PowdbPool` over the client `Pool`;
                      `PowdbEmbeddedPool` over a single `Database` handle), type mapping
                      (Turbine→PowQL `str/int/float/bool/json`; never emits `uuid/datetime/bytes`;
                      `Date`→int micros), `powqlSchemaDDL`, `wrapPowdbError`, and `powdbDialect`
                      (`supportsReturning: true`; the Postgres-only flags stay false →
                      `$listen`/`$notify`/RLS/pgvector throw E017). PowDB realities shaping it:
                      writes use the trailing **`returning`** keyword (create/createMany/update/
                      delete) — `upsert` reselects by PK (its statement rejects `returning`; a
                      **composite-PK upsert** reselects-or-writes in one flat txn via `upsertComposite`).
                      **PKs: server-assigned `auto` int OR client UUID** — `isGenerated` columns emit
                      PowDB's `auto` modifier (`powqlSchemaDDL`) and let the engine assign the id;
                      otherwise a defaulted string PK gets a client UUID (`applyPkDefault`). No
                      JSON-agg/link-nav (→N+1 `with` loaders incl. **m2m via the junction**
                      `loadManyToMany`, keys chunked at `MAX_RELATION_KEYS=1000`). **`describe`-based
                      introspection** (`introspectPowdbDatabase` in `powdb-introspect.ts`, exported from
                      the `turbine-orm/powdb` subpath) reads a live catalog (`schema` + `describe T`) into
                      `SchemaMetadata` for bootstrap; relations are always `{}` (PowDB has no declared FKs)
                      and the PK is a heuristic, so `defineSchema` stays the relation-aware path. The
                      exec must be RECORD-keyed (zip the raw client's positional rows); a mis-shaped exec
                      that yields zero named tables throws rather than returning an empty schema, and an
                      optional `capabilities` arg gates it (E017 below 0.10). **Relation filters (`some`/`none`/`every`, all
                      cardinalities incl. m2m) resolve CLIENT-SIDE** (`resolveRelationFilters` →
                      literal `in (list)`), NEVER an IN-subquery: PowDB's executor caches a subquery
                      result by plan shape ignoring the literal → a repeated `in (<subquery>)` returns
                      stale rows (a real engine bug, reproduced on the raw addon; it had silently
                      broken the 0.22.0 hasMany/belongsTo filters). **Nested writes** (relation ops in
                      create/update data) route to the shared `executeNestedCreate/Update` engine via
                      `runInImplicitTx` (one flat top-level txn; same hasMany/hasOne/belongsTo coverage
                      as SQL; m2m nested writes unhandled on every backend). Composite-PK columns are
                      `required` only — PowDB has no composite-unique, so per-column `unique` is emitted
                      ONLY for a single-column PK. **Single global write lock — single-writer transactions:**
                      a nested `tx.$transaction` throws E017 (`powdbDialect` savepoint keywords throw), and a
                      RE-ENTRANT `db.$transaction` (opened inside an active tx callback's async context,
                      detected via AsyncLocalStorage — queueing it would deadlock) throws E017; INDEPENDENT
                      concurrent `db.$transaction` calls queue FIFO on the pool-level `PowdbTxGate` and run
                      one at a time (this prevents the networked second-`begin` HANG on the held lock),
                      bounded by `transactionQueueTimeoutMs` (default 30s → TimeoutError; 0/Infinity waits
                      forever). The empty-where guard gates on the COMPILED PowQL filter (like the SQL
                      path), so `{OR:[]}`/`{AND:[]}`/`{NOT:{}}` are refused. `wrapPowdbError` maps BOTH
                      transports: the embedded napi addon tags every error `code:'GenericFailure'`, so
                      it maps by message shape (required/no-value→E010, type-mismatch/Parse/Execution/
                      StorageError→E003, unique→E008) before the networked `.code` switch. **Embedded
                      takes no params array**, so `PowdbEmbeddedPool` materializes each `$N` into
                      a PowQL literal via `encodePowqlLiteral`/`materializePowql` — string
                      escaping matches the engine lexer exactly (`\"` `\\` `\n` `\t`; else raw),
                      injection-safe. Embedded durability is selectable (`syncMode` 'full'|'normal'|'off'
                      + `memoryLimit`, addon ≥0.7.1; `'normal'` moves fsync off the commit path → embedded
                      writes beat SQLite, see benchmarks); checkpoint-bound `disconnect()`, ~4070-byte
                      per-row cap, macOS-arm64/x64 + Linux-glibc only; live regression coverage in
                      `src/test/powdb.integration.test.ts` (CI `powdb-integration` job, in-process, no
                      container). (≤0.6.2 reselect + float-literal workarounds retired in 0.7.0; embedded
                      `syncMode`/`memoryLimit` + `count(*)`-fix picked up in 0.7.1.)
                      **0.12/0.13 parity round (capabilities-gated):** a bound connection resolves
                      `PowdbCapabilities` (`capabilitiesFromVersion`: networked reads the probed
                      `serverVersion`, embedded reads the addon package.json version via the
                      `.cts` optional-peer helper so it compiles under both module targets), and every
                      version-gated feature calls `requireCapability` for a typed E017 with an upgrade
                      hint instead of a raw parse error. **`json` is a first-class column type** (≥0.12):
                      `powqlColumnType` maps json/jsonb columns to `json`, a JS object/array binds as a
                      `PowdbJsonParam` (serialized to canonical JSON text), and `JsonFilter` path
                      filters / orderBy / groupBy compile to PowQL `->` path expressions (segments bound
                      as params; a digit-only string segment binds as an int array index for SQL parity;
                      `contains` and pathless `equals` stay E017). **Doc-field expression indexes** (≥0.13)
                      are declared via `defineSchema` `indexes: [{ docField, path }]` and emitted by
                      `powqlSchemaDDL` (`alter T add index (.col->"seg")`; numeric path segments validated
                      non-negative-integer at build time). Code-first declared indexes carry
                      `IndexMetadata.declared` so they never flip `schemaHasIndexInfo` (the SQL DDL
                      generators do not emit them, so counting them would arm FK-advisor false positives).
                      **Native typed wire** (≥0.13, `nativeRaw` capability): networked pools route through
                      `queryNativeRaw`, so cells arrive pre-typed (int as bigint, datetime as micros); each
                      result is TAGGED with the serving wire and `PowqlInterface` coerces PER-RESULT (never
                      the pool flag), so a genuine str `"null"` survives and groupBy keys (plain + JSON)
                      come back with PG-text parity across transports. **`retryStaleReads`** (networked
                      opt-in) replays a first-statement READ once on a stale-frame `ConnectionError`; the
                      action is threaded per-call so a concurrent op can never turn a WRITE into a replayed
                      insert. **Error reclassification:** `protocol_error` (and the "received unexpected
                      frame" idle-socket shape) now maps to `ConnectionError` E004 (was E003), `.cause`
                      preserved. **0.14/0.15 round (v0.35):** the upstream driver spec
                      (`docs/integrations/powql-for-drivers.md` in the PowDB repo) is the CONTRACT — spec
                      gaps get filed upstream, never reverse-engineered around. Embedded joins the native
                      typed wire: on addon ≥0.14 `PowdbEmbeddedPool.exec` routes `queryWithParams` (real
                      $N binding + the same tagged WireValue decode as networked; `materializePowql`
                      literal-encoding stays as the <0.14 fallback), `nativeRaw` is feature-detected on the
                      opened handle, and `end()` does a real checkpoint-flush `close()`. **Native relation
                      joins** (`serverJoins` capability ≥0.13): explicit `relationLoadStrategy: 'join'`
                      (per-query or TurbinePowdbOptions) compiles eligible top-level relations to INNER
                      PowQL joins (`Child as c join Parent as p on … { __tpk: p.pk, c.cols }`) with the
                      parent where re-emitted alias-qualified; eligibility = no parent limit/offset +
                      unique/PK correlation column + top-level, else silent loader fallback; PowDB's
                      DEFAULT stays the batched loaders (never inherits the SQL 'join' default). Join and
                      loader paths share one correlation-key normalizer (Date → micros; the old loader
                      Date-identity Map bug and the select-omits-FK bug are fixed). **Readonly** (≥0.14):
                      `{ embedded, readonly: true }` opens via `openReadOnly`; client-level
                      `readonly: true` fails writes fast locally; both refusal shapes map to
                      `ReadOnlyError` E018 with `reason: 'snapshot' | 'rbac'` (0.15 spec split). The
                      tx-pool proxy in client.ts carries `readonly` + `capabilities` through
                      `$transaction` (review-caught bypass). **explain()** on `PowqlInterface` (and
                      `QueryInterface` via the `explainQuery` dialect hook: PG `EXPLAIN`, sqlite
                      `EXPLAIN QUERY PLAN`, mysql `EXPLAIN`, mssql E017); plan text is diagnostic,
                      middleware does NOT run for explain on any engine. 0.15 itself needed no driver
                      surface (engine-side stats/planner; explain gains est_rows tokens that flow
                      through). **0.16 (v0.36.1):** engine-internal NUL-safe index keys (on-disk
                      index v3, auto-rebuilt on first writable open; a READ-ONLY open rebuilds in
                      memory every open until a writable open persists it, documented on the
                      engines page); driver spec byte-identical, lexer untouched (verified), so
                      POWQL_LEXER_TESTED_CEILING bumped to '0.16' and deps to ^0.16.0; a live NUL
                      regression test in powdb.integration.test.ts fails on the 0.15 addon and
                      passes on 0.16. See
                      `docs/internal/strategy/powdb-parity-matrix.md` (local-only, untracked).

  errors.ts         — Error hierarchy rooted at TurbineError. Each error has a code
                      (TURBINE_E001-E017). wrapPgError() translates pg driver errors
                      (23505, 23503, 23502, 23514, 23P01, 40P01, 40001) into typed
                      Turbine errors. UnsupportedFeatureError (E017) is thrown directly
                      (not via wrapPgError) when a non-Postgres engine hits a Postgres-only
                      feature.

  nested-write.ts   — Nested-write engine. Tree-walking create/update that resolves
                      relation fields in `data` (create, connect, connectOrCreate,
                      disconnect, set, delete, update, upsert) into batched SQL inside a
                      transaction, depth-capped at 10. Imported by query/builder.ts.

  schema.ts         — Postgres-to-TypeScript type mapping, SchemaMetadata/TableMetadata
                      interfaces, camelToSnake/snakeToCamel utilities, singularize helper.
                      ColumnMetadata.pii (0.36): code-first-only PII tag (defineSchema
                      `pii: true` / fluent `.pii()`; introspection NEVER auto-tags).
                      Contract: PII columns are excluded from every default projection
                      (top-level, `with` subqueries, batched loader, positional encoding,
                      PowQL loaders + native joins, and write returns). Writes on
                      PII-tagged tables emit an explicit non-PII projection AT THE SQL
                      LEVEL (writeReturningColumns: RETURNING list on PG/SQLite, projected
                      reselect on MySQL, per-column OUTPUT INSERTED./DELETED. on MSSQL via
                      mssqlOutput; a PII-tagged PK stays in the list so the row is
                      addressable; untagged tables keep RETURNING * byte-for-byte).
                      PowDB is the exception: its `returning` keyword takes no column list
                      (driver spec), so stripWritePii removes PII client-side there.
                      parseWriteRow's strip stays as defense-in-depth. Returned only via explicit
                      `select` naming or the `includePii: true` read arg (reads only, not
                      mutations); where/orderBy/groupBy on PII always allowed. The fm:/fu:
                      SQL-cache keys carry a `|pii=0/1` segment (projection-invariant
                      withFp made this mandatory). Untagged schemas emit byte-identical
                      SQL (tested). TableMetadata.checks round-trips named check
                      constraints through generate (emitted into metadata.ts).

  schema-builder.ts — defineSchema() API for code-first schema definitions. Produces
                      SchemaDef objects consumed by schema-sql.ts for DDL generation.

  schema-sql.ts     — DDL generation from SchemaDef. All identifiers quoted via quoteIdent().
                      0.36 additions: schemaPush refuses destructive statements without
                      `allowDestructive` (ValidationError listing offenders; scanner lives
                      in cli/destructive.ts — a pure leaf, the one sanctioned lib→cli
                      import); declared plain indexes (`indexes: [{ columns, unique?,
                      name? }]`) emit CREATE [UNIQUE] INDEX (deterministic name
                      idx_<table>_<cols>; a declared index that resolves to the auto
                      FK-index name SUPERSEDES it — never emit duplicates); schemaDiff
                      reads pg_indexes indexdef, ADDs missing declared indexes, and on a
                      name match runs describeIndexDefMismatch (unique/columns/partial
                      drift → warning, NEVER a drop; anchor column parsing on the USING
                      clause so a partial index's WHERE parens aren't the column list).
                      Also provides schemaDiff() for auto-diff migrations.

  introspect.ts     — Reads information_schema + pg_catalog to produce SchemaMetadata.
                      Discovers tables, columns, types, relations, indexes, enums.

  generate.ts       — Code generator that emits three files from introspected schema:
                      types.ts (entity interfaces, Create/Update input types),
                      metadata.ts (runtime SchemaMetadata object), and
                      index.ts (typed TurbineClient subclass with table accessors).

  observe.ts        — Observability module. Buffers per-minute query metrics in memory,
                      flushes aggregates (count, avg, p50, p95, p99, errors) to a
                      _turbine_metrics table in a separate database. Non-blocking via
                      fire-and-forget INSERT with ON CONFLICT additive merge.

  pipeline.ts       — Batch query execution. Takes DeferredQuery[] and runs all SQL
                      in a single pg round-trip, then applies each query's transform.

  pipeline-submittable.ts — Real pg extended-query pipeline protocol. Uses
                      parse/bind/execute/sync wire messages on pg's Connection
                      (listener-swap pattern, same as pg-cursor) to send all pipeline
                      queries in one TCP flush — true 1-RTT execution.

  serverless.ts     — Edge / serverless driver binding. Exports turbineHttp(pool, schema)
                      which constructs a TurbineClient bound to an external pg-compatible
                      pool (Neon @neondatabase/serverless, @vercel/postgres, Cloudflare
                      Hyperdrive, etc.). Pure TypeScript shim — no extra runtime deps.
                      Published as the `turbine-orm/serverless` subpath export.

  typed-sql.ts      — Typed raw SQL escape hatch (Turbine's TypedSQL). buildTypedSql()
                      turns a tagged template into a parameterized (sql, params) pair —
                      every ${value} becomes $N, impossible to string-concat a value in.
                      TypedSqlQuery<T> is a thenable (await -> T[]) with .one() -> T|null
                      and .scalar<V>() -> V|null. Exposed as client.sql<T>`...`.

  realtime.ts       — LISTEN/NOTIFY pub/sub. createSubscription() checks out a dedicated
                      pooled connection, runs LISTEN "chan" (channel is the one
                      interpolated identifier — strict regex + quoteIdent), and wires the
                      pg 'notification' event to the handler. Exposed as client.$listen()
                      / client.$notify() (pg_notify($1,$2)). Subscriptions are tracked and
                      force-released on disconnect(); serverless HTTP pools (no persistent
                      connection) throw a clear error instead of hanging.

  cli/              — CLI entry point and commands (see CLI Architecture below).
```

## Site at site/

This repo ships the library **and** its marketing/docs site. The site lives at `site/` (a standalone Next.js 15 App Router project with its own `package.json` and `node_modules`) and deploys to `turbineorm.dev` via the Vercel project `zvn-dev/turbine-docs`.

- Library work stays in `src/`. Site work stays in `site/`. Don't cross the streams.
- Every release updates **both** surfaces in a single commit: library + `site/` + `CHANGELOG.md` + version bump, then `npm publish` + `vercel --prod`.
- Root-level helpers: `npm run site:dev`, `npm run site:build`, `npm run site:deploy`.
- See `AGENTS.md` at the repo root (local-only, untracked) for the full release playbook, the npm publish auth notes, and the verification checklist. Don't duplicate that content here — AGENTS.md is the source of truth.

## The json_agg Algorithm

The core of Turbine's single-query strategy lives in `buildRelationSubquery()` (query/relations.ts). For each relation in a `with` clause, it generates a correlated subquery that PostgreSQL evaluates per parent row.

1. **Alias generation.** A shared `aliasCounter: { n: number }` is passed through all nesting levels. Each call allocates `t0`, `t1`, `t2`, etc. This prevents alias collisions in arbitrarily deep trees.

2. **json_build_object.** Each child row is mapped to a JSON object: `json_build_object('id', t0."id", 'title', t0."title", 'createdAt', t0."created_at")`. Keys are camelCase field names; values reference the alias.

3. **json_agg + COALESCE (hasMany).** For one-to-many, the json_build_object is wrapped in `json_agg(...)`, then `COALESCE(..., '[]'::json)` ensures the result is never NULL (empty array fallback). For belongsTo/hasOne, no aggregation is used, just `LIMIT 1`.

4. **Correlation WHERE.** Links the subquery to its parent: hasMany uses `alias.foreignKey = parentRef.referenceKey` (child FK points to parent PK); belongsTo reverses this (`alias.referenceKey = parentRef.foreignKey`). manyToMany (`buildManyToManySubquery`) instead JOINs the target through the junction table (`RelationDef.through`) and correlates `junction.sourceKey = parentRef.referenceKey`. Self-relations are just hasMany/belongsTo where `from === to` — the per-call alias counter keeps them collision-free.

5. **Inner subquery wrapping for LIMIT/ORDER.** When a hasMany relation has `limit` or `orderBy`, the query restructures into two levels: an inner SELECT with WHERE/ORDER/LIMIT on raw rows, wrapped by an outer SELECT that applies json_agg to the inner alias (`t0i`). Without this, LIMIT on aggregated results is meaningless.

6. **Recursion with depth cap.** Nested `with` clauses recurse into `buildRelationSubquery()`, incrementing depth. At depth 10, a `CircularRelationError` is thrown with the full path trail. Back-references (e.g. posts -> user -> posts) are allowed since they are legitimate queries.

7. **parseNestedRow.** After query execution, `parseNestedRow()` walks the result. Relation columns arrive as JSON strings from pg; they are JSON.parsed, then each item is run through `parseRow()` to apply snake-to-camel mapping and date coercion on the target table.

## Type System

**Query arg types** (query/types.ts): `WhereClause<T>` supports equality, null checks, operators (`gt`, `gte`, `lt`, `lte`, `not`, `in`, `notIn`, `contains`, `startsWith`, `endsWith`), `mode: 'insensitive'` for ILIKE, `OR`/`AND`/`NOT` combinators, and relation filters (`some`/`every`/`none`). `WithClause` maps relation names to `true | WithOptions`. `WithOptions` supports nested `with`, `where`, `orderBy`, `limit`, `select`, and `omit`.

**Atomic updates** (query/types.ts): `UpdateOperatorInput<V>` supports `set`, `increment`, `decrement`, `multiply`, `divide` for numeric fields. These generate `col = col + $n` style SQL for concurrent safety.

**Generated types** (generate.ts): The code generator emits three files:
- `types.ts` — Entity interfaces (singularized PascalCase), `*Create` types (optional for PK/default/nullable fields), `*Update` types (all non-PK fields optional), and `*With*` interfaces for each relation.
- `metadata.ts` — Runtime `SchemaMetadata` constant with column maps, relations, indexes.
- `index.ts` — `TurbineClient` subclass with `declare readonly` typed table accessors and a `turbine()` factory function.

**`with` clause inference (shipped since 0.7.1):** `findMany` / `findUnique` / `findFirst` / `findUniqueOrThrow` are generic over `W extends TypedWithClause<R>` and return `Promise<WithResult<T, R, W>[]>`. The recursive `WithResult` mapped type (query/types.ts) walks the `with` literal at arbitrary depth by reading the `RelationDescriptor<Target, Cardinality, TargetRelations>` phantom brand that the code generator emits on `*Relations` interfaces (see `generate.ts` ~line 183). Cardinality (`'many'` vs `'one'`) is re-applied at each level via `ApplyCardinality`, so `users[0].posts[0].comments[0].author.name` autocompletes end-to-end with no manual assertion. Compile-time assertions for this path live in `src/test/with-inference.test.ts` — if inference regresses, `tsx --test` exits non-zero because the test file fails to typecheck. The generated `*With*` interfaces (for annotating variables by hand) still exist for back-compat but are no longer required.

**DeferredQuery<T>** (query/builder.ts): Each `build*()` method returns `{ sql, params, transform, tag }` instead of executing. The `transform` function converts `pg.QueryResult` into the final typed value. Used by `pipeline()` for batching.

## Error System

All errors extend `TurbineError` which carries a `code: TurbineErrorCode` property for programmatic handling.

| Code | Class | When |
|---|---|---|
| E001 | `NotFoundError` | `findUniqueOrThrow`, `findFirstOrThrow`, missing row |
| E002 | `TimeoutError` | Query or transaction exceeds timeout |
| E003 | `ValidationError` | Unknown column, invalid operator, empty where guard |
| E004 | `ConnectionError` | Pool connection failure |
| E005 | `RelationError` | Unknown relation name in `with` clause |
| E006 | `MigrationError` | Migration file parse error, checksum mismatch |
| E007 | `CircularRelationError` | Nesting depth exceeds 10 |
| E008 | `UniqueConstraintError` | pg 23505 — via `wrapPgError()` |
| E009 | `ForeignKeyError` | pg 23503 — via `wrapPgError()` |
| E010 | `NotNullViolationError` | pg 23502 — via `wrapPgError()` |
| E011 | `CheckConstraintError` | pg 23514 — via `wrapPgError()` |
| E012 | `DeadlockError` | pg 40P01 — `isRetryable = true as const` |
| E013 | `SerializationFailureError` | pg 40001 — `isRetryable = true as const` |
| E014 | `PipelineError` | One or more queries in a pipeline batch failed |
| E015 | `OptimisticLockError` | Version mismatch on `optimisticLock` update |
| E016 | `ExclusionConstraintError` | pg 23P01 — via `wrapPgError()` |
| E017 | `UnsupportedFeatureError` | A Postgres-only feature (pgvector, LISTEN/NOTIFY, RLS `sessionContext`) invoked on an engine whose capability flag reports it unsupported — thrown directly, not via `wrapPgError()` |
| E018 | `ReadOnlyError` | A write refused because the database is read-only — `reason: 'snapshot'` (PowDB snapshot serving / client-level `readonly: true` fail-fast) or `'rbac'` (read-only role). Thrown locally by the PowDB readonly guard and via `wrapPowdbError()` message families |

`wrapPgError(err)` inspects the pg driver error's `.code` field and wraps it in the appropriate typed error, preserving the original as `.cause`. It is called in `client.ts` (raw queries, transaction pool proxy) and at query execution boundaries in `query/builder.ts`.

## CLI Architecture

The CLI (`src/cli/index.ts`) uses a zero-dependency argument parser on `process.argv`. No commander/yargs. Commands: `init`, `generate`/`pull`, `push`, `migrate create|up|down|status`, `seed`, `status`, `doctor` (missing-FK-index advisor → `index-advisor.ts`; `--fix` writes an add-index migration), `studio`.

**Config resolution** (`cli/config.ts`): Searches for `turbine.config.ts` / `.js` / `.json`, merges with `--url`/`--out`/`--schema` flags and `DATABASE_URL` env var.

**Migration system** (`cli/migrate.ts`): SQL-first migrations stored as timestamp-prefixed `.sql` files with `-- UP` and `-- DOWN` sections. Tracked in a `_turbine_migrations` table with SHA-256 checksums. Uses `pg_try_advisory_lock()` to prevent concurrent migration runs. Each migration runs in its own transaction. Checksum validation detects modified migration files. Destructive statements (both `migrate up`/`down` and, since 0.36, `push`) require a two-step typed confirmation (`destroy my data` then `yes`) or `--allow-destructive`. `migrate create <name> --recipe backfill` (0.36) scaffolds the sanctioned two-phase type-change pattern from the MIGRATION_RECIPES registry (fully commented: nullable add → batched keyed UPDATE → SET NOT NULL → atomic rename swap); `--recipe` without a name errors.

**Studio** (`cli/studio.ts`): Local web UI served over Node's built-in `http` module — no new runtime deps, read-only by default. ORM-native since v0.19: there is NO raw-SQL surface. The Query tab (default) is a visual `findMany` builder; `POST /api/builder` validates every identifier (table/relation/field/orderBy) against the introspected schema and compiles the args with `QueryInterface.buildFindMany` (`sqlCache: false`, all values as `$N` params). Saved queries are builder-kind only — legacy raw-SQL entries are dropped on load with a console notice. Binds `127.0.0.1` by default (warns loudly on non-loopback hosts), authenticates via a random 24-byte hex token (constant-time check on every `/api/*` route), per-session rate limiting (100 req/60s), refuses cross-origin requests, and ships nonce-based CSP + security headers (`script-src 'self' 'nonce-...'` — no unsafe-inline in script-src since 0.36; style-src keeps it; `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`). Every read runs inside `BEGIN READ ONLY` with `SELECT set_config('statement_timeout', $1, true)` (NOT `SET LOCAL ... = $1`, which Postgres rejects — that was the 0.17.0 critical bug) and `set_config('search_path', $1, true)` pinned to the configured `--schema`. **Write mode (0.36, `--write`):** `/api/row/update|insert|delete` POST routes exist ONLY when writable (404 otherwise, deliberately not 403); each rebuilds the predicate from the FULL primary key alone via `extractPkWhere` (extra where keys dropped, operator objects refused — single-row by construction), validates table/columns against metadata, compiles via buildUpdate/buildCreate/buildDelete (`sqlCache: false`), runs in a plain BEGIN txn with the same parameterized timeout + search_path, and requires a matching `Origin` (absent OR mismatched → 403). Views and PK-less tables refused. Loud startup warning + persistent red WRITE MODE banner. **PII redaction:** PII-tagged cells are redacted SERVER-SIDE ("•• redacted ••") before serialization — table rows, builder rows, nested `with` rows (redactBuilderRows walks the tree against each relation's target table), and the post-write echo; redacted columns are also excluded from the Data-tab ILIKE search OR-set and orderBy (no substring/sort inference oracle). `--show-pii` reveals (terminal warning + persistent PII SHOWN banner). DB-less perimeter tests drive the exported `handleRequest` (src/test/studio-write.test.ts). UI is an embedded single-file HTML/CSS/JS (`studio-ui.html`, prebuilt into `studio-ui.generated.ts` by `npm run gen:studio`) with Query / Data / Schema tabs matching the turbineorm.dev dark theme.

**UI module** (`cli/ui.ts`): Terminal formatting helpers — colors, spinners, tables, boxes. Imported throughout CLI but never by library code.

## Testing

**Unit tests** run without a database. They use mock schemas from `src/test/helpers.ts` which provides `mockColumn()`, `mockTable()`, and `makeQuery()` (creates a QueryInterface with a null pool for build-only SQL tests).

**Integration tests** need a PostgreSQL instance with seeded data. Set `DATABASE_URL` env var. The small correctness fixture is `src/test/fixtures/seed.sql` (8 users / 10 posts / 20 comments / 5 orgs). The larger benchmark seed lives in `benchmarks/seed-neon.ts` and defaults to 1K users / 10K posts / 50K comments (override via `USERS`/`POSTS_PER_USER`/`COMMENTS_PER_POST`). Tests that require a database are gated via the `skipGate()` helper in `src/test/helpers.ts` when `DATABASE_URL` is absent — each test registers with `{ skip }` so the reporter shows real skipped counts, not silent passes.

**Coverage** is configured in `.c8rc.json`. It covers `src/**` but excludes `src/test/**`, `src/cli/**`, `src/generate.ts`, `src/introspect.ts`, `src/serverless.ts`, and `src/index.ts`. Thresholds: 80% lines, 82% functions, 82% branches, 80% statements.

## Key Patterns

- All SQL identifiers quoted via `quoteIdent()` — doubles internal `"` chars per Postgres rules
- All user values parameterized (`$1, $2, ...`) — never string-interpolated
- LIKE patterns escaped via `escapeLike()` — escapes `%`, `_`, `\`
- Empty-where guard blocks accidental mass mutations: update/delete with `{}` or all-undefined where throws `ValidationError` unless `allowFullTableScan: true`
- `LRUCache` bounds the SQL template cache at 1,000 entries (Map insertion order for O(1) eviction)
- Module has no side effects — `setTypeParser` for int8 is gated behind a static flag in the TurbineClient constructor
- ESM source with `.js` extensions (NodeNext resolution), CJS output via separate `tsconfig.cjs.json`
- Middleware runs after SQL generation — it can inspect/log params and transform results, but cannot modify the SQL itself

## Common Tasks

**Adding a new query method:**
1. Define the args interface in `query/types.ts` (e.g. `FooArgs<T>`) near the existing arg types.
2. Add a `buildFoo()` method to `QueryInterface` that returns `DeferredQuery<T>`. Build SQL using parameterized queries, push values to `params[]`, reference columns via `this.tableMeta`.
3. Add a `foo()` method that calls `buildFoo()`, executes via `this.execute()`, and applies the transform.
4. Add unit tests in `src/test/` using `makeQuery()` from helpers to verify generated SQL without a database.
5. Add integration tests that run against the seeded database.

**Adding a new error type:**
1. Add the error code constant to `TurbineErrorCode` in errors.ts (e.g. `NEW_ERROR: 'TURBINE_E012'`).
2. Create the error class extending `TurbineError`, passing the code to `super()`.
3. If it maps to a pg error code, add a case to `wrapPgError()`.
4. Export from errors.ts and re-export from the package index.

**Adding a new CLI command:**
1. Add the command to the help text and JSDoc at the top of `cli/index.ts`.
2. Add a case to the main switch in the `run()` function.
3. Implement the handler, using `requireUrl()` for database-requiring commands and the `ui.ts` helpers for output.

**Modifying the code generator:**
1. Edit `generate.ts`. The three generator functions are `generateTypes()`, `generateMetadata()`, and `generateIndex()`.
2. Types are built by iterating `schema.tables` and `table.columns`. Entity names come from `entityName()` (singularized PascalCase via `snakeToPascal(singularize(tableName))`).
3. Test by running `npx turbine generate` against a database and inspecting the output in `generated/turbine/`.

## Don't

- Don't add runtime dependencies beyond `pg`. Root `dependencies` stays exactly `{ pg, @types/pg }` — `@types/pg` is required because published `.d.ts` files import `pg` types; moving it to `devDependencies` alone breaks consumer strict `tsc` (0.28.1 regression). Marketing "one dependency" means one **runtime** dep (`pg`); types packages that surface in public declarations stay in `dependencies`. The only sanctioned engine exception: `mysql2`, `mssql`, `@zvndev/powdb-client`, and `@zvndev/powdb-embedded` are **devDependencies + optional `peerDependencies`** (`peerDependenciesMeta.*.optional = true`), loaded lazily via dynamic `import()` from the `mysql`/`mssql`/`powdb` subpaths and never required for Postgres users; SQLite needs nothing at all (it uses the `node:sqlite` builtin). Those peer loads route through `src/optional-peer-import.cts` — the CJS build (`module: CommonJS`) lowers a plain `import()` to `require()`, which cannot load ESM-only peers (e.g. `@zvndev/powdb-client` ≥ 0.9, `ERR_PACKAGE_PATH_NOT_EXPORTED`); the `.cts` helper's NodeNext-built copy at `dist/optional-peer-import.cjs` keeps a REAL `import()` that the lowered copy falls back to. Don't replace it with a bare `import()` in the engine modules.
- Don't use `eval`, `new Function`, or shell interpolation
- Don't reference internal project names, client names, dogfood-source projects, or internal planning documents in ANY tracked file — code comments, test names, CHANGELOG, release notes, commit messages, site. This repo is public. Describe changes by what they do, never by who asked for them or where feedback came from. `docs/internal/` and `AGENTS.md` are gitignored (local-only); the pre-commit hook enforces a private blocklist via `scripts/check-private-terms.mjs` + `.private-terms`.
- Don't break the Prisma-like API (`findMany`, `findUnique`, `with`, `where`)
- Don't put user values in SQL strings — always use `$N` parameterization
- Don't import `client.ts` from `query/` (would create circular dependency)
- Don't register type parsers outside the TurbineClient constructor
