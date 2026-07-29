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

**Dependency graph:** `client.ts` wraps `query/` with connection pooling and transactions. The `query/` module is the heart, it builds all SQL and parses results. `pipeline.ts` batches multiple `DeferredQuery` objects from `query/` into a single round-trip. The CLI (`cli/`) imports `generate.ts`, `introspect.ts`, and `schema-sql.ts`, and since v0.19 the ORM-native Studio (`cli/studio.ts`) also imports `QueryInterface`/`quoteIdent` from `query/`. The CLI still never imports `client.ts` directly, that's the real circular-dependency rule.

```
src/
  query/           , The heart, split into submodules:
    types.ts       , All public query arg types (~785 LOC): WhereClause, WithClause,
                      FindManyArgs, RelationDescriptor, WithResult, UpdateOperatorInput,
                      AggregateArgs, JsonFilter, ArrayFilter, HavingClause /
                      HavingFieldFilter (0.53: a groupBy `having` field entry is
                      `(HavingAggregateFilter & WhereOperator) | WhereValue`, so an
                      aggregate filter AND a scalar filter on the grouped value can
                      share one object; plus AND/OR/NOT at any depth. _min/_max
                      operands are the column's own type, not numeric-only),
                      VectorFilter/VectorOrderBy (pgvector distance ops), etc.
    utils.ts       , Pure utility functions (~130 LOC): quoteIdent(), escapeLike(),
                      LRUCache (1K entry cap), fnv1a64Hex(), sqlToPreparedName(),
                      OPERATOR_KEYS constant, resolveColumnName() (0.53: THE
                      key->column rule in one place, field map first then
                      camelToSnake validated against the reverse map/allColumns.
                      `toColumn` is it plus the E003 throw, and the value-side
                      passes (write coercion, updatedAt injector, nested-write FK
                      merge) call it directly; they used to read columnMap alone, so
                      a snake_case COLUMN key produced identical SQL with an
                      uncoerced value). Also the zone-less temporal READ parsers
                      (0.54): `registerUtcTemporalParsers()` is the one place OIDs
                      1114/1082/1115/1182 get registered (client.ts, cli/studio.ts,
                      cli/mcp.ts all call it, so the registrations cannot drift),
                      built from `createUtcTimestampParser(fallback)` /
                      `createUtcDateParser(fallback)` and `createPgArrayParser(element)`
                      over pg's arrayParser. Both scalar parsers are regex-driven and
                      DELEGATE anything not a plain `YYYY-MM-DD[ HH:MM:SS[.ffffff]]` to
                      the parser they replace (captured via getTypeParser BEFORE
                      registration), which is what keeps `infinity`/`-infinity` from
                      becoming an Invalid Date; they assemble via setUTCFullYear so 2-3
                      digit and 5-digit years and ` BC` are not silently remapped.
                      `parseUtcTimestampText` stays for known-shape callers only.
                      pg-types' shipped .d.ts omits array OIDs from its setTypeParser
                      enum and types arrayParser loosely, so both are retyped locally
                      (comment says so); no dependency added.
    filters.ts     , Where-filter type guards + shape fingerprints (isWhereOperator,
                      isJsonFilter/isArrayFilter/isVectorFilter, sortedKeys/sortedEntries,
                      normalizeOrderBy). Kept out of builder.ts so the class stays about
                      SQL assembly rather than filter-shape bookkeeping.
    where-compile.ts, The canonical where-clause enumeration (~300 LOC, added 0.36):
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
    deferred.ts    , DeferredQuery, QueryInterfaceOptions, middleware/event types.
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
    aggregates.ts   - buildAggregate + buildGroupBy and helpers (~900 LOC): HAVING clauses,
                      groupBy ordering, DISTINCT-ON sources, JSON-path aggregate targets.
                      Reuses where.ts for WHERE compilation; shared orderBy / row-parse
                      primitives stay class-resident via the ctx. HAVING (0.53) is
                      three pieces around buildHavingClauses: splitHavingField
                      partitions one field entry into aggregate keys (the fixed
                      HAVING_AGGREGATE_FNS map; an unknown `_`-prefixed key is a
                      misspelled aggregate → E003) and scalar operator keys;
                      buildHavingScalarClauses compiles the scalar half against the
                      `havingGroupKeys` map buildGroupBy fills while walking `by`
                      (HavingGroupKey = {kind:'column', field} → whereMod.
                      buildScalarClause, so the whole WHERE operator surface is
                      inherited, or {kind:'expr'} → the JSON group key's re-emitted
                      parenthesized extract), and a field that is NOT a `by` key
                      throws E003 rather than emitting SQL the engine rejects;
                      buildHavingCombinator does AND/OR/NOT recursively, mirroring
                      buildWhereClause's shapes. buildHavingNumericClauses is
                      operand-type-agnostic now (equals/not/gt/gte/lt/lte/in/notIn).
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
    batched-loader.ts, The `relationLoadStrategy: 'batched'` path. Instead of the default
                      single-statement `json_agg` join, runs the base query without relation
                      subqueries, then ONE flat follow-up per relation
                      (`WHERE fk = ANY($1)`, chunked at MAX_RELATION_KEYS=32_000) and stitches
                      client-side, output byte-for-byte equal to the join strategy. Runs on
                      the caller's executor/connection (tx-safe); per-relation `limit` applied
                      client-side per parent; composite-key relations throw E017.

    compound-unique.ts, Compound-unique where selectors (0.41): derives selector names
                      (`orgId_userId` or a declared composite-unique index name) from
                      primaryKey + uniqueColumns + IndexMetadata and normalizes
                      `where: { orgId_userId: {...} }` into flat column equality BEFORE
                      cache fingerprinting. Consumed by the findUnique family, nested-write
                      unique wheres (connect/connectOrCreate/etc.), and PowqlInterface.
    warn-registry.ts, Process-wide once-only dev-warn registry (0.41) keyed on a
                      globalThis Symbol.for('turbine.warnOnce.registry') so multi-instance
                      and dual-package (ESM+CJS) setups never double-warn; WARN_ONCE_CAP=500.
                      Namespaces: FK-advisor notes, deep-with, 'auto' strategy engagement,
                      unordered-page, PowDB link DDL skips, 'flatten' fallbacks, and
                      unknownConfigKey (0.53: client.ts warnUnknownConfigKeys checks every
                      key on the config object against TURBINE_CONFIG_KEYS and warns once
                      per key name outside production, with suggestConfigKey's correction,
                      closestName first then a camel-word-subsequence pass so `logParams`
                      still suggests `logQueryParams`; `url`/`schema`/queryInterfaceFactory
                      are exempt, and the whole check is try/caught so a diagnostic can
                      never fail a constructor), and unknownQueryOption (0.57:
                      prisma-compat's warnUnknownQueryOptions, once per
                      model.operation.key, sharing suggestKey with the config check).

    option-surface.ts, The query-arg OPTION SURFACE as runtime data (0.57). One
                      `Record<keyof SomeArgs<Row>, OptionKind>` table per arg interface
                      ('prisma' | 'native' | 'nativeAlias' | 'internal'), the
                      TURBINE_CONFIG_KEYS pattern lifted from client config to query args,
                      plus `applyNativeOptions` / `optionKeysOfKind` / `ALL_OPTION_TABLES`.
                      Type-only imports from ./types.js, so no cycle. Adding an option to a
                      core arg interface FAILS THE BUILD here until a human classifies it,
                      which is what stops prisma-compat stranding it by omission; listing a
                      key that is not on the interface fails as an excess property. THE ONE
                      RULE: 'native' only when the value contains no field/relation/column/
                      model NAME (`optimisticLock.field` and `distinctOn.columns` do, so they
                      are 'prisma' and hand-translated).

    index.ts       , Barrel re-export (~65 LOC). All imports use `./query/index.js`.

  index-advisor.ts , Missing-FK-index advisor. Derives every column set relations probe
                      (hasMany/hasOne child FKs, belongsTo reference keys, m2m junction keys)
                      from SchemaMetadata and checks each against the table's indexes/PK
                      (`findMissingRelationIndexes`). Consumed by `turbine doctor` (CLI report
                      + `--fix` migration) and the dev-mode runtime warning in query/builder.ts
                      (`missingIndexForRelation`, gated on `schemaHasIndexInfo` to avoid
                      false positives on `defineSchema`-only metadata).

  plan-divergence.ts, Cached-plan divergence advisor (0.56), doctor's third question about a
                      probe column: "this column's distribution makes a NAMED prepared
                      statement's generic plan unsafe". Pure (no pg import, no
                      EXPLAIN): reads relpages/reltuples plus the pg_stats rows collected by
                      index-stats.ts (`StatsSnapshot.columnStats`, gated on
                      `options.distributionColumns`, which the CLI fills from
                      `collectDivergenceCandidateColumns` + `collectDivergenceOrderColumns`)
                      and scores ONE shape, `WHERE col = $1 ORDER BY <other indexed column>
                      LIMIT $n`, on TWO branches (`PlanDivergenceFinding.branch`).
                      `sparse-value` (0.56, an index serves the equality): the
                      generic estimate `rows / n_distinct` sits ABOVE the plan boundary
                      `crossoverRows = sqrt(limit x relpages)` while real values sit below it.
                      Gates: the wrong plan must walk >= `minWalkPages` (50) AND >=
                      `minWalkFraction` (10%) of the table.
                      `unindexed-filter` (0.57, NO index serves the equality) is a THIRD
                      mechanism, not a variant: the good plan is a SEQ SCAN the generic plan
                      will not choose (custom seq scan + top-N sort bounded by pages, generic
                      keeps the ordered PK walk and fetches ~every tuple). Gates: rarest
                      bucket < assumedLimit AND `minGenericTupleWalk` (10,000) tuples, no
                      generic-side gate (measured: an unknown LIMIT discounts the ordered scan
                      10x whatever the child estimate is). It used to be dropped by a shape
                      gate BEFORE the considered counter, so the whole unindexed population
                      was outside both the findings and the notices. Branch-shaped fields are
                      OPTIONAL, never zero-filled; both branches sort on estimated EXTRA
                      BUFFER ACCESSES (a 0.57 reordering of existing sparse findings).
                      "Served by an index" = valid, non-partial, non-expression, leading
                      column, access method btree OR HASH (a hash index gives the same bitmap
                      path, measured 7 buffers); brin/gin/gist leading the column is scored by
                      neither rule and emits a notice. `orderColumnCorrelation` +
                      `heapNearlyOrdered` (0.57) disclose the branch's known false positive: a
                      heap in near-exact orderColumn order reads ~1.2x where a scattered one
                      reads ~80x, and the two are one sampled fifth decimal apart, so the
                      statistic QUALIFIES a finding and never suppresses one.
                      Findings carry the diagnostic SQL
                      whose FIRST step reads `pg_prepared_statements.generic_plans` (a finding
                      is EXPOSURE, not an incident: `auto` promotes only when the generic plan
                      is not estimated to cost more, which on many of these shapes it is).
                      DELIBERATELY not modelled: the opposite (dense, physically clustered)
                      direction. A second rule for it existed and was removed after live
                      measurement inverted its SIGN twice; the discriminator is where in the
                      heap a value's rows sit and no pg_stats input carries that. No `--fix`,
                      and it gates on ANALYZE freshness (last_analyze), never on the
                      `stats_reset` counter gate the cost tiers use.

  plan-flip-probe.ts, The REACHABILITY half of the divergence check (0.58). plan-divergence
                      answers "IF it flips, how bad"; this answers "CAN it flip", which
                      0.57 shipped without and got right 6 times in 13 on a real schema
                      (39 findings). Every false positive had one signature: the generic
                      plan keeps the same SEQ SCAN the good plan chose, so there is nothing
                      to diverge to. Split like index-stats.ts: PURE half
                      (`buildFlipProbeSql` / `verdictFromPlanJson` / `applyFlipVerdicts` /
                      `needsFlipProbe`, no pg import) plus a COLLECTOR (`probePlanFlips`).
                      Asks ONE question per finding, `EXPLAIN (FORMAT JSON)` with NO
                      ANALYZE (plans and discards, executes nothing) under
                      `force_generic_plan` only: the custom plan is not needed because a
                      generic seq scan refutes the claim on its own, which also removes the
                      need for a rare VALUE that statistics do not carry (`NULL` is safe
                      precisely because a generic plan ignores the value). LIMIT stays bound
                      as `$2`, the shape Turbine emits; an inlined limit takes a different
                      planner path. `unindexed-filter` findings only (sparse-value was 6/6
                      in 0.56, no measured precision problem to spend a round trip on).
                      Uses a pg `Client`, NOT a one-connection Pool: this is ONE transaction
                      over many statements, and node-postgres discards an errored connection
                      and hands out a fresh one, so through a pool the first failing probe
                      silently ends the txn and every later SAVEPOINT fails (caught by the
                      savepoint-recovery test, not by review). Failure is NEVER a silent
                      drop: error/timeout/unparseable -> 'unknown' -> finding SURVIVES with
                      a notice, and each probe is savepointed. REFUTATION RULE (0.59, the
                      0.58 one was half of it): the question is "is the generic plan the
                      ordered index walk the finding claims", and there are TWO independent
                      grounds for no: a `Sort` above the TARGET's scan (bounds cost by match
                      count, not by walk distance, whatever access feeds it) OR a `Seq Scan`
                      at the target itself. 0.58 shipped only the second, so every LOW-estimate
                      column with ANY usable index survived, since those plan as
                      `Limit > Sort > Bitmap Heap Scan` and never reach a seq scan (live case:
                      `btree (col) WHERE col IS NOT NULL`, which an equality predicate
                      IMPLIES, so the partial index is fully usable). NOT "exclude partial-index
                      columns": a partial index whose predicate is NOT implied cannot serve the
                      query and its column is a genuine finding (one measured at 19,961x); the
                      plan already carries the answer and cannot drift from PG's implication
                      rules. `Incremental Sort` does NOT refute (index supplies a PREFIX of the
                      order, so still partly the bad shape) and a `Sort` elsewhere in the plan
                      does not either; over-refuting deletes real findings INVISIBLY, so KEEP is
                      the safe direction. DELIBERATELY not an arithmetic gate: the natural rule
                      (generic estimate must exceed assumedLimit) is measured WRONG, the
                      boundary sits between estimates 3 and 4 on a 247-page fixture and
                      moves with the table since it is a cost comparison; a closed-form gate
                      was attempted and failed its own out-of-sample prediction.

  client.ts        , TurbineClient wraps a pg.Pool and auto-creates typed table accessors
                      via Object.defineProperty. Manages middleware ($use), transactions
                      ($transaction with SAVEPOINTs for nesting, isolation levels, timeouts,
                      and a sessionContext option that set_config()s txn-local GUCs for
                      Postgres RLS, plus the $withSession shorthand), typed raw SQL
                      (client.sql<T> -> typed-sql.ts), realtime ($listen/$notify ->
                      realtime.ts), raw SQL tagged templates, and pipeline batching.
                      Registers int8 parser
                      once (static flag) so bigint comes back as number. Also exports
                      PgCompatPool / PgCompatPoolClient / PgCompatQueryResult interfaces
                      and accepts an external pool via TurbineConfig.pool for serverless
                      drivers (Neon, Vercel Postgres, Cloudflare), when an external pool
                      is supplied, Turbine does NOT call pg.types.setTypeParser and
                      disconnect() becomes a no-op (caller owns lifecycle). TurbineConfig also
                      carries the relation/wire tuning added in 0.26.0:
                      `relationLoadStrategy: 'auto' | 'join' | 'batched'` (client default,
                      overridable per query → query/batched-loader.ts; 'auto' is the 0.41.0
                      implicit default: join plan with per-relation batched fallback on
                      proven-unindexed correlation columns, event tag 'auto-batched',
                      composite-key/unknown relations always stay join), `jsonEncoding: 'object' |
                      'positional'` (Postgres-only lean `json_build_array` wire encoding for
                      `with` subqueries), and `utcTimestamps` (default true; see parseDbDate
                      in query/utils.ts). 0.54 widened the read half of `utcTimestamps` from
                      OID 1114 alone to the whole zone-less temporal set, 1114 `timestamp`,
                      1082 `date`, 1115 `timestamp[]`, 1182 `date[]`, via the shared
                      `registerUtcTemporalParsers()` in query/utils.ts (cli/studio.ts and
                      cli/mcp.ts build raw pools and call the SAME helper, so a Studio cell
                      cannot render a different instant than the app reads). `date` therefore
                      reads at UTC midnight instead of the process's local midnight: a silent
                      EPOCH-value change for any process not running in UTC, and the fix for a
                      read-modify-write loop that walked the stored day backwards east of UTC
                      (the write half already rendered UTC components). Two statics now, not
                      one: `utcTimestampParserMode` is settled by EVERY client (external pools
                      included, since registration is process-global and they read through it,
                      so they take part in `assertUtcTimestampsAgree`), while
                      `utcTimestampParsersRegistered` gates the actual registration to
                      Turbine-OWNED pools. Also `planCacheMode: 'auto' | 'force_custom_plan' |
                      'force_generic_plan'` (0.54, Postgres-only, unset by default = nothing
                      emitted): pins the backend's custom-vs-generic plan choice, since PG
                      promotes a NAMED prepared statement to a value-blind generic plan on its
                      sixth execution and never reverts, which is wrong for a skewed predicate
                      (`count()` is the Turbine shape exposed; `findMany`/`findFirst` bind
                      `LIMIT $n` and are much less so). Applied as the `options=-c
                      plan_cache_mode=...` CONNECTION PARAMETER via `withPlanCacheMode`, never
                      a post-checkout `SET` (pg hands the client to the waiting caller in the
                      same tick it emits 'connect', so a `SET` there races the caller's first
                      query through pg's deprecated same-client queueing); a `?options=` on
                      the connection string or `PGOPTIONS` is APPENDED to, never replaced,
                      because pg's ConnectionParameters lets the URL win. Validated against the
                      frozen `PLAN_CACHE_MODES` at construction (a GUC value cannot be a bind
                      param, so the closed enum IS the injection boundary, and the emitted
                      literal is the matched MEMBER, never the caller's string), gated on the
                      `supportsPlanCacheMode` dialect flag (E017), owned pools + owned string
                      `replicas` only (external pool = no-op + one dev warning). ALL config
                      validation now runs BEFORE any process-global side effect, so a throwing
                      constructor cannot leave the parser mode settled.

  adapters/        , Database adapter layer (~530 LOC) for Postgres-compatible engines.
                      cockroachdb.ts + yugabytedb.ts override the operations with
                      compatibility gaps (migration locking, introspection SQL); alloydb
                      and timescale are pass-through adapters defined in index.ts.
                      Everything else falls through to standard PostgreSQL. Published as
                      the `turbine-orm/adapters` subpath export.

  dialect.ts       , The real multi-engine SQL seam (Phase-0 complete). Query generation,
                      DML, DDL, migration-tracking SQL, transactions, streaming, and
                      introspection all route through the `Dialect` contract; the package
                      stays PostgreSQL-native by default via `postgresDialect`. Key parts:
                      • `resultStrategy: 'returning' | 'reselect' | 'output'`, how a write
                        surfaces its affected rows. `returning` = trailing `RETURNING *`
                        (Postgres, SQLite ≥ 3.35); `reselect` = run the write then a
                        follow-up SELECT by PK/where (MySQL, no RETURNING); `output` =
                        rows come back from the same statement via `OUTPUT INSERTED.*` /
                        `MERGE` (SQL Server). The executor branches on this.
                      • Driver abstraction, engines bind via the external-pool seam
                        (`PgCompatPool` / `TurbineConfig.pool`); each engine ships a thin
                        pool shim (`SqlitePool`/`MysqlPool`/`MssqlPool`) plus
                        `paramPlaceholder`, `quoteIdentifier`, and tx-keyword hooks
                        (`begin/commit/rollback/savepoint/buildSetSessionConfig`).
                      • Capability flags, `supportsReturning`, `supportsVector`,
                        `supportsListenNotify`, `supportsRLS`, `supportsAdvisoryLock`,
                        `supportsILike`, `aggSupportsInlineOrderBy`, `jsonPathSupport`,
                        `supportsPlanCacheMode` (0.54, Postgres true / every other engine
                        explicitly false since they spread postgresDialect; it speaks for the
                        DIALECT, not the server, so a wire-compatible engine on
                        postgresDialect with no `plan_cache_mode` is accepted here and
                        refuses the connection parameter itself instead of raising E017).
                        Builders/client throw `UnsupportedFeatureError` (E017) when a flag
                        is false instead of emitting broken SQL.
                      • Additive hooks, `wrapJsonSubresult` (SQLite `json(...)`, MSSQL
                        `ISNULL(…, '[]')`), `aggSupportsInlineOrderBy` (forces the
                        inner-subquery rewrite for ordered to-many on MySQL/SQLite),
                        `castAggregate`, `buildInClause`/`inClauseParam`, `buildLimitOffset`
                        (SQL Server `OFFSET/FETCH`), `buildUpdateStatement`/
                        `buildDeleteStatement` (mid-statement `OUTPUT`), and
                        `buildRelationSubquery` (SQL Server's `FOR JSON PATH` override).
                        `openStream()` and the `DialectIntrospector` round out the seam.

  sqlite.ts        , `turbine-orm/sqlite` engine. `turbineSqlite(path | ':memory:' |
                      DatabaseSync, schema, options?)`, synchronous, zero new dependency
                      via Node's built-in `node:sqlite` (Node ≥ 22.5; `better-sqlite3`
                      documented fallback). `sqliteDialect` uses `resultStrategy:
                      'returning'`, `json_group_array(json(...))` nested relations, and
                      `COLLATE NOCASE` (ASCII-only) for insensitive matching. The
                      in-process test / edge / "try it in 10 seconds" engine.

  mysql.ts         , `turbine-orm/mysql` engine. `await turbineMysql(url | config |
                      mysql2-pool, schema, options?)`, MySQL 8.0+ via the optional peer
                      `mysql2` (loaded by dynamic import; never a root dep). `mysqlDialect`
                      uses `resultStrategy: 'reselect'` (no RETURNING, write then re-SELECT
                      by PK/where), `JSON_ARRAYAGG`/`JSON_OBJECT` nested relations, and
                      named `:pN` placeholders. `createMany` returns `[]` (count-not-rows).

  mssql.ts         , `turbine-orm/mssql` engine. `await turbineMssql(url | config |
                      mssql-pool, schema, options?)`, SQL Server 2016+ via the optional
                      peer `mssql` (dynamic import). `mssqlDialect` uses `resultStrategy:
                      'output'` (`OUTPUT INSERTED.*` / `MERGE`), `FOR JSON PATH` nested
                      relations (`buildRelationSubquery` override), `OFFSET/FETCH` paging,
                      and named `@pN` placeholders.

  powdb.ts +       , `turbine-orm/powdb` engine (PowDB **≥ 0.7.1**).
  powql.ts            `await turbinePowDB(url | connOpts | pool | { embedded: dir, syncMode?, memoryLimit? }, schema, options?)`
                      (`url` = `powdb://host:port`; networked path probes `serverVersion` and throws
                      `ConnectionError` below 0.7.0)
                      - PowDB, a single-node DB with its OWN query language **PowQL** (not SQL).
                      Two transports: **networked** via the optional peer `@zvndev/powdb-client`
                      (binary TCP), and **embedded** (preview) via the optional peer
                      `@zvndev/powdb-embedded` (in-process napi addon, no server). Both dynamic
                      `import()`, `npm i turbine-orm` still pulls only `pg`. PowQL shares no
                      surface with `SELECT…FROM…WHERE`, so this is NOT a `Dialect`: powql.ts ships
                      a parallel `PowqlInterface` (PowQL generator with the same public method
                      surface as `QueryInterface`) wired in via the `queryInterfaceFactory`
                      option on `QueryInterfaceOptions`, `TurbineClient.table()` calls that
                      factory when present, else `new QueryInterface` (SQL engines untouched).
                      powdb.ts holds the driver shims (`PowdbPool` over the client `Pool`;
                      `PowdbEmbeddedPool` over a single `Database` handle), type mapping
                      (Turbine→PowQL `str/int/float/bool/json`; never emits `uuid/datetime/bytes`;
                      `Date`→int micros), `powqlSchemaDDL`, `wrapPowdbError`, and `powdbDialect`
                      (`supportsReturning: true`; the Postgres-only flags stay false →
                      `$listen`/`$notify`/RLS/pgvector throw E017). PowDB realities shaping it:
                      writes use the trailing **`returning`** keyword (create/createMany/update/
                      delete), `upsert` reselects by PK (its statement rejects `returning`; a
                      **composite-PK upsert** reselects-or-writes in one flat txn via `upsertComposite`).
                      **PKs: server-assigned `auto` int OR client UUID**, `isGenerated` columns emit
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
                      `required` only, PowDB has no composite-unique, so per-column `unique` is emitted
                      ONLY for a single-column PK. **Single global write lock, single-writer transactions:**
                      a nested `tx.$transaction` throws E017 (`powdbDialect` savepoint keywords throw), and a
                      RE-ENTRANT `db.$transaction` (opened inside an active tx callback's async context,
                      detected via AsyncLocalStorage, queueing it would deadlock) throws E017; INDEPENDENT
                      concurrent `db.$transaction` calls queue FIFO on the pool-level `PowdbTxGate` and run
                      one at a time (this prevents the networked second-`begin` HANG on the held lock),
                      bounded by `transactionQueueTimeoutMs` (default 30s → TimeoutError; 0/Infinity waits
                      forever). The empty-where guard gates on the COMPILED PowQL filter (like the SQL
                      path), so `{OR:[]}`/`{AND:[]}`/`{NOT:{}}` are refused. `wrapPowdbError` maps BOTH
                      transports: the embedded napi addon tags every error `code:'GenericFailure'`, so
                      it maps by message shape (required/no-value→E010, type-mismatch/Parse/Execution/
                      StorageError→E003, unique→E008) before the networked `.code` switch. **Embedded
                      takes no params array**, so `PowdbEmbeddedPool` materializes each `$N` into
                      a PowQL literal via `encodePowqlLiteral`/`materializePowql`, string
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
                      (`docs/integrations/powql-for-drivers.md` in the PowDB repo) is the CONTRACT, spec
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
                      DEFAULT stays the batched loaders / nested projections (never inherits the
                      SQL-side default, 'join' pre-0.41 or 'auto' since). Join and
                      loader paths share one correlation-key normalizer (Date → micros; the old loader
                      Date-identity Map bug and the select-omits-FK bug are fixed; SCOPE, since this
                      line has already misdirected one audit: what is fixed is the loader forcing its
                      OWN correlation column into the child fetch. Nested descendants are safe by a
                      DIFFERENT mechanism, the loader hands `options.with` to the child's public
                      findMany, so each level resolves its own keys, unlike the SQL batched loader
                      which fetches flat and recurses over already-projected rows. Verified live on
                      addon 0.20. Separately, `projectedColumns` keeps the PK through `omit` and the
                      PII filter (0.63): the force-add under `select` used to be undone by the `omit`
                      pass that ran after it, which emptied every m2m relation via `targetByPk`).
                      **Readonly** (≥0.14):
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
                      a live NUL
                      regression test in powdb.integration.test.ts fails on the 0.15 addon and
                      passes on 0.16. **0.17/0.18 round (v0.39):** wrapPowdbError classifies by the
                      0.17 typed wire error class (`err.wireErrorClass`, networked) BEFORE the
                      generic message regexes but AFTER the detail-extracting message families
                      (class 3→E002, 4→E003, 5→E018 snapshot, 6/7→E004, 8→E008, 9→E004 final,
                      1/2→E003; 0/unknown falls through), so sanitized messages still classify
                      right. **Nested projections (0.18, `nestedProjections` capability):**
                      eligible `with` clauses compile INTO the parent statement as correlated
                      nested-projection blocks (buildFind partitions with → nestedPlans +
                      residualWith; planNestedRelation / buildNestedBlock / attachNestedRows in
                      powql.ts), per-parent order/limit/offset native, childless parents keep
                      []/null, recursion shares one alias counter (t0/t1/…), child JSON re-coerced
                      per column (rowToEntity native policy; date micros→Date). DEFAULT on >=0.18
                      (explicit 'batched' opts out; 'join' also prefers nesting); silent loader
                      fallback for m2m, bigint/bytes child columns, to-one paging, parent
                      distinct, projection-key collisions, ineligible descendants (whole relation
                      falls back), depth >= 10. `nestedProjections` stays OFF in
                      ALL_POWDB_CAPABILITIES (like nativeRaw: it flips real query generation, so
                      only a genuine version probe enables it). Ceiling: lexer verified
                      byte-identical 0.16→0.18, POWQL_LEXER_TESTED_CEILING '0.18', deps ^0.17.0
                      (0.18 npm publish pending upstream; feature lights up via the version
                      probe). Unit tests src/test/powdb-nested.test.ts; live 0.18 coverage in
                      powdb.integration.test.ts skip-gates on the addon version. See
                      `docs/internal/strategy/powdb-parity-matrix.md` (local-only, untracked).

  errors.ts        , Error hierarchy rooted at TurbineError. Each error has a code
                      (TURBINE_E001-E017). wrapPgError() translates pg driver errors
                      (23505, 23503, 23502, 23514, 23P01, 40P01, 40001) into typed
                      Turbine errors. UnsupportedFeatureError (E017) is thrown directly
                      (not via wrapPgError) when a non-Postgres engine hits a Postgres-only
                      feature.

  nested-write.ts  , Nested-write engine. Tree-walking create/update that resolves
                      relation fields in `data` (create, connect, connectOrCreate,
                      disconnect, set, delete, update, upsert) into batched SQL inside a
                      transaction, depth-capped at 10. Imported by query/builder.ts.

  schema.ts        , Postgres-to-TypeScript type mapping, SchemaMetadata/TableMetadata
                      interfaces, camelToSnake/snakeToCamel utilities, singularize helper.
                      ColumnMetadata.pii (0.36): code-first-only PII tag (defineSchema
                      `pii: true` / fluent `.pii()`; introspection NEVER auto-tags).
                      Contract, stated by enforcement point:
                      (1) ROW PROJECTIONS: a PII column is excluded from every default
                      row projection (top-level, `with` subqueries, batched loader,
                      positional encoding, PowQL loaders + native joins, and write
                      returns), and comes back only when named explicitly in `select`
                      or unlocked by the `includePii: true` read arg. Enforced AT THE
                      SQL LEVEL on every engine (see the write projection below), with
                      parseWriteRow's strip as defense-in-depth.
                      (2) AGGREGATES: two shapes are REFUSED without `includePii: true`
                      (ValidationError E003 naming the column): a PII column used as a
                      groupBy `by` key INCLUDING a JSON-path group key (the keys ARE the
                      values), and _min/_max over a PII column in BOTH groupBy and
                      aggregate INCLUDING JSON-path targets (they return a row's stored
                      cell). ALLOWED with no opt-in: _count (a count, not a value) and
                      _sum/_avg (computed across many rows, not a stored cell; the
                      single-row group is a known theoretical edge, the gate is
                      deliberately narrow). `includePii?: boolean` is a field on BOTH
                      GroupByArgs and AggregateArgs (query/types.ts); with it set the
                      emitted SQL is byte-identical to an untagged schema. Applies on
                      PowDB as well as the SQL engines.
                      (3) PREDICATES AND ORDERING: where / orderBy / having on a PII
                      column are ALWAYS permitted, with or without the flag: they return
                      no PII value, only narrow or sort rows.
                      `includePii` is a read arg, never a mutation arg. Writes on
                      PII-tagged tables emit an explicit non-PII projection AT THE SQL
                      LEVEL (writeReturningColumns: RETURNING list on PG/SQLite, projected
                      reselect on MySQL, per-column OUTPUT INSERTED./DELETED. on MSSQL via
                      mssqlOutput; a PII-tagged PK stays in the list so the row is
                      addressable; untagged tables keep RETURNING * byte-for-byte).
                      PowDB is the exception: its `returning` keyword takes no column list
                      (driver spec), so stripWritePii removes PII client-side there.
                      The fm:/fu: SQL-cache keys carry a `|pii=0/1` segment
                      (projection-invariant withFp made this mandatory). A schema with no
                      pii-tagged column is unaffected by ANY of the above and emits
                      byte-identical SQL (tested). TableMetadata.checks round-trips named check
                      constraints through generate (emitted into metadata.ts).

  schema-builder.ts, defineSchema() API for code-first schema definitions. Produces
                      SchemaDef objects consumed by schema-sql.ts for DDL generation.

  schema-sql.ts    , DDL generation from SchemaDef. All identifiers quoted via quoteIdent().
                      0.36 additions: schemaPush refuses destructive statements without
                      `allowDestructive` (ValidationError listing offenders; scanner lives
                      in cli/destructive.ts, a pure leaf, the one sanctioned lib→cli
                      import); declared plain indexes (`indexes: [{ columns, unique?,
                      name? }]`) emit CREATE [UNIQUE] INDEX (deterministic name
                      idx_<table>_<cols>; a declared index that resolves to the auto
                      FK-index name SUPERSEDES it, never emit duplicates); schemaDiff
                      reads pg_indexes indexdef, ADDs missing declared indexes, and on a
                      name match runs describeIndexDefMismatch (unique/columns/partial
                      drift → warning, NEVER a drop; anchor column parsing on the USING
                      clause so a partial index's WHERE parens aren't the column list).
                      Also provides schemaDiff() for auto-diff migrations.

  introspect.ts    , Reads information_schema + pg_catalog to produce SchemaMetadata.
                      Discovers tables, columns, types, relations, indexes, enums.

  generate.ts      , Code generator that emits three files from introspected schema:
                      types.ts (entity interfaces, Create/Update input types),
                      metadata.ts (runtime SchemaMetadata object), and
                      index.ts (typed TurbineClient subclass with table accessors).

  observe.ts       , Observability module. Buffers per-minute query metrics in memory,
                      flushes aggregates (count, avg, p50, p95, p99, errors) to a
                      _turbine_metrics table in a separate database. Non-blocking via
                      fire-and-forget INSERT with ON CONFLICT additive merge.

  pipeline.ts      , Batch query execution. Takes DeferredQuery[] and runs all SQL
                      in a single pg round-trip, then applies each query's transform.

  pipeline-submittable.ts, Real pg extended-query pipeline protocol. Uses
                      parse/bind/execute/sync wire messages on pg's Connection
                      (listener-swap pattern, same as pg-cursor) to send all pipeline
                      queries in one TCP flush, true 1-RTT execution.

  serverless.ts    , Edge / serverless driver binding. Exports turbineHttp(pool, schema)
                      which constructs a TurbineClient bound to an external pg-compatible
                      pool (Neon @neondatabase/serverless, @vercel/postgres, Cloudflare
                      Hyperdrive, etc.). Pure TypeScript shim, no extra runtime deps.
                      Published as the `turbine-orm/serverless` subpath export.

  prisma-compat.ts , `turbine-orm/prisma-compat` subpath (0.41, ~2.3K LOC): typed
                      PrismaClient-surface adapter over TurbineClient, driven by the
                      PrismaCompatMap that `turbine migrate-from-prisma` emits. Model
                      delegates under BOTH the Prisma model name (compat.User) and
                      Prisma's lowercased property spelling (compat.user); translates
                      include/select→with, take/skip, cursors (bare inclusive cursor
                      whose field != sort key THROWS rather than off-by-one),
                      compound-unique custom @@unique(name:) selectors, _count
                      reshaping, to-one array→object|null. $transaction in callback AND
                      lazy-array-batching forms, $queryRaw/$executeRaw (+Unsafe) with
                      Prisma.sql-style fragments, createMany skipDuplicates → core
                      ON CONFLICT DO NOTHING (E017 on mssql/powdb). Turbine-native query
                      options (0.57): every translator ends in one `applyNativeOptions` call
                      driven by query/option-surface.ts, replacing the ad-hoc
                      `if (typeof args.timeout === 'number')` allowlist that had silently
                      dropped forceCustomPlan / warnOnUnlimited / skipGlobalFilters /
                      allowFullTableScan / optimisticLock / stableRelationOrder / distinctOn
                      and most writes' timeout. Ordering matters and is deliberate:
                      stablePkOrder's default is written BEFORE the native copy (a per-call
                      arg wins) and updateMany/deleteMany's implicit allowFullTableScan AFTER
                      (Prisma parity cannot be turned into a thrown guard). `limit` on
                      updateMany/deleteMany throws E017; relationLoadStrategy 'query' maps to
                      'batched' (it used to be forwarded into a resolver with no 'query'
                      branch, silently giving the join). warnUnknownQueryOptions warns once
                      per model.operation.key on a key that is in neither PRISMA_ARG_KEYS[op]
                      nor the operation's non-'internal' table; warn-never-throw. $extends (0.53):
                      the `client` + `model` components only, object form AND the
                      Prisma.defineExtension callback form (`$extends(fn)` IS
                      `fn(client)`). applyExtension folds a validated extension into a
                      NEW immutable ExtensionState and `build(exts)` reassembles a whole
                      new client by the same path, so extending is chainable and the
                      tx-scoped delegates get the same `model` members (client members
                      deliberately do NOT: they usually close over the base client, so
                      reaching one through `tx` would run outside the txn). extendDelegate
                      returns the SAME delegate object when an extension contributes
                      nothing to it (zero query-path cost) and otherwise Object.assign's
                      onto a shallow copy carrying `$name`. `query`/`result` are typed
                      `never` AND throw E017 at $extends time with the alternative
                      (`client.$use` / compute in app code or a generated column;
                      `result` cannot be layered on the PII projection rules); any
                      unrecognized component (Accelerate/Pulse/replicas) throws by name.
                      A `client` member shadowing a delegate or CLIENT_RESERVED_KEYS, or a
                      `model` key naming no model, throws E003. `Prisma.getExtensionContext`
                      is the identity function; `$name` is runtime-only, not on the type.
                      Pure shim: zero new deps, never imported by core.

  typed-sql.ts     , Typed raw SQL escape hatch (Turbine's TypedSQL). buildTypedSql()
                      turns a tagged template into a parameterized (sql, params) pair -
                      every ${value} becomes $N, impossible to string-concat a value in.
                      TypedSqlQuery<T> is a thenable (await -> T[]) with .one() -> T|null
                      and .scalar<V>() -> V|null. Exposed as client.sql<T>`...`.

  realtime.ts      , LISTEN/NOTIFY pub/sub. createSubscription() checks out a dedicated
                      pooled connection, runs LISTEN "chan" (channel is the one
                      interpolated identifier, strict regex + quoteIdent), and wires the
                      pg 'notification' event to the handler. Exposed as client.$listen()
                      / client.$notify() (pg_notify($1,$2)). Subscriptions are tracked and
                      force-released on disconnect(); serverless HTTP pools (no persistent
                      connection) throw a clear error instead of hanging.

  cli/             , CLI entry point and commands (see CLI Architecture below).
```

## Site at site/

This repo ships the library **and** its marketing/docs site. The site lives at `site/` (a standalone Next.js 15 App Router project with its own `package.json` and `node_modules`) and deploys to `turbineorm.dev` via the Vercel project `zvn-dev/turbine-docs`.

- Library work stays in `src/`. Site work stays in `site/`. Don't cross the streams.
- Every release updates **both** surfaces in a single commit: library + `site/` + `CHANGELOG.md` + version bump, then `npm publish` + `vercel --prod`.
- Root-level helpers: `npm run site:dev`, `npm run site:build`, `npm run site:deploy`.
- See `AGENTS.md` at the repo root (local-only, untracked) for the full release playbook, the npm publish auth notes, and the verification checklist. Don't duplicate that content here, AGENTS.md is the source of truth.

## The json_agg Algorithm

The core of Turbine's single-query strategy lives in `buildRelationSubquery()` (query/relations.ts). For each relation in a `with` clause, it generates a correlated subquery that PostgreSQL evaluates per parent row.

1. **Alias generation.** A shared `aliasCounter: { n: number }` is passed through all nesting levels. Each call allocates `t0`, `t1`, `t2`, etc. This prevents alias collisions in arbitrarily deep trees.

2. **json_build_object.** Each child row is mapped to a JSON object: `json_build_object('id', t0."id", 'title', t0."title", 'createdAt', t0."created_at")`. Keys are camelCase field names; values reference the alias.

3. **json_agg + COALESCE (hasMany).** For one-to-many, the json_build_object is wrapped in `json_agg(...)`, then `COALESCE(..., '[]'::json)` ensures the result is never NULL (empty array fallback). For belongsTo/hasOne, no aggregation is used, just `LIMIT 1`.

4. **Correlation WHERE.** Links the subquery to its parent: hasMany uses `alias.foreignKey = parentRef.referenceKey` (child FK points to parent PK); belongsTo reverses this (`alias.referenceKey = parentRef.foreignKey`). manyToMany (`buildManyToManySubquery`) instead JOINs the target through the junction table (`RelationDef.through`) and correlates `junction.sourceKey = parentRef.referenceKey`. Self-relations are just hasMany/belongsTo where `from === to`, the per-call alias counter keeps them collision-free.

5. **Inner subquery wrapping for LIMIT/ORDER.** When a hasMany relation has `limit` or `orderBy`, the query restructures into two levels: an inner SELECT with WHERE/ORDER/LIMIT on raw rows, wrapped by an outer SELECT that applies json_agg to the inner alias (`t0i`). Without this, LIMIT on aggregated results is meaningless.

6. **Recursion with depth cap.** Nested `with` clauses recurse into `buildRelationSubquery()`, incrementing depth. At depth 10, a `CircularRelationError` is thrown with the full path trail. Back-references (e.g. posts -> user -> posts) are allowed since they are legitimate queries.

7. **parseNestedRow.** After query execution, `parseNestedRow()` walks the result. Relation columns arrive as JSON strings from pg; they are JSON.parsed, then each item is run through `parseRow()` to apply snake-to-camel mapping and date coercion on the target table.

## Type System

**Per-query plan control** (0.56): `forceCustomPlan?: boolean` on `FindManyArgs` / `FindUniqueArgs` / `CountArgs` / `AggregateArgs` / `GroupByArgs` sends that one statement UNNAMED, resolved at the single execute seam `preparedNameFor` in builder.ts (never per builder: the flag changes no SQL text). The mechanism is the DRIVER's, not a backend one: node-postgres skips `Parse` only for a statement already parsed BY NAME, so an unnamed statement is re-parsed every execution, the unnamed `CachedPlanSource` is replaced each time, and the custom-plan counter never reaches the promotion threshold. It is REFUSED (E003) against a client-level `planCacheMode: 'force_generic_plan'` (measured: that setting governs unnamed statements too), and E017 on any dialect without `supportsPlanCacheMode` plus `PowqlInterface.assertNoForceCustomPlan` for PowDB. Read arg only, writes do not take it.

**Query arg types** (query/types.ts): `WhereClause<T>` supports equality, null checks, operators (`gt`, `gte`, `lt`, `lte`, `not`, `in`, `notIn`, `contains`, `startsWith`, `endsWith`), `mode: 'insensitive'` for ILIKE, `OR`/`AND`/`NOT` combinators, and relation filters (`some`/`every`/`none`). `WithClause` maps relation names to `true | WithOptions`. `WithOptions` supports nested `with`, `where`, `orderBy`, `limit`, `select`, and `omit`.

**Atomic updates** (query/types.ts): `UpdateOperatorInput<V>` supports `set`, `increment`, `decrement`, `multiply`, `divide` for numeric fields. These generate `col = col + $n` style SQL for concurrent safety.

**Generated types** (generate.ts): The code generator emits three files:
- `types.ts`, Entity interfaces (singularized PascalCase), `*Create` types (optional for PK/default/nullable fields), `*Update` types (all non-PK fields optional), and `*With*` interfaces for each relation.
- `metadata.ts`, Runtime `SchemaMetadata` constant with column maps, relations, indexes.
- `index.ts`, `TurbineClient` subclass with `declare readonly` typed table accessors and a `turbine()` factory function.

**`with` clause inference (shipped since 0.7.1):** `findMany` / `findUnique` / `findFirst` / `findUniqueOrThrow` are generic over `W extends TypedWithClause<R>` and return `Promise<WithResult<T, R, W>[]>`. The recursive `WithResult` mapped type (query/types.ts) walks the `with` literal at arbitrary depth by reading the `RelationDescriptor<Target, Cardinality, TargetRelations>` phantom brand that the code generator emits on `*Relations` interfaces (see `generate.ts` ~line 183). Cardinality (`'many'` vs `'one'`) is re-applied at each level via `ApplyCardinality`, so `users[0].posts[0].comments[0].author.name` autocompletes end-to-end with no manual assertion. Compile-time assertions for this path live in `src/test/with-inference.test.ts`, if inference regresses, `tsx --test` exits non-zero because the test file fails to typecheck. The generated `*With*` interfaces (for annotating variables by hand) still exist for back-compat but are no longer required.

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
| E008 | `UniqueConstraintError` | pg 23505, via `wrapPgError()` |
| E009 | `ForeignKeyError` | pg 23503, via `wrapPgError()` |
| E010 | `NotNullViolationError` | pg 23502, via `wrapPgError()` |
| E011 | `CheckConstraintError` | pg 23514, via `wrapPgError()` |
| E012 | `DeadlockError` | pg 40P01, `isRetryable = true as const` |
| E013 | `SerializationFailureError` | pg 40001, `isRetryable = true as const` |
| E014 | `PipelineError` | One or more queries in a pipeline batch failed |
| E015 | `OptimisticLockError` | Version mismatch on `optimisticLock` update |
| E016 | `ExclusionConstraintError` | pg 23P01, via `wrapPgError()` |
| E017 | `UnsupportedFeatureError` | A Postgres-only feature (pgvector, LISTEN/NOTIFY, RLS `sessionContext`) invoked on an engine whose capability flag reports it unsupported, thrown directly, not via `wrapPgError()` |
| E018 | `ReadOnlyError` | A write refused because the database is read-only, `reason: 'snapshot'` (PowDB snapshot serving / client-level `readonly: true` fail-fast) or `'rbac'` (read-only role). Thrown locally by the PowDB readonly guard and via `wrapPowdbError()` message families |

`wrapPgError(err)` inspects the pg driver error's `.code` field and wraps it in the appropriate typed error, preserving the original as `.cause`. It is called in `client.ts` (raw queries, transaction pool proxy) and at query execution boundaries in `query/builder.ts`.

## CLI Architecture

The CLI (`src/cli/index.ts`) uses a zero-dependency argument parser on `process.argv`. No commander/yargs. Commands: `init`, `generate`/`pull`, `push`, `migrate create|up|down|status`, `seed`, `status`, `doctor` (missing-FK-index advisor → `index-advisor.ts`; `--fix` writes an add-index migration; cached-plan divergence section → `plan-divergence.ts`, finding-only, `--no-plan-divergence` skips it and its pg_stats read; since 0.57 an `unindexed-filter` finding renders as EVIDENCE on the missing-index finding for the same column (`attachDivergenceToMissingIndexes` / `renderDivergenceEvidence`) rather than as a second entry, and the remediation text names `forceCustomPlan` without assuming the reader holds the core client or prisma-compat), `migrate-from-prisma` (0.41: zero-dep schema.prisma subset parser in `cli/prisma-schema.ts`, live-metadata resolver in `cli/prisma-resolve.ts`, Markdown report via `cli/prisma-report.ts`, emits the typed PRISMA_MAP module `generate.ts` also regenerates; `--no-db` parse-only mode), `studio`.

**Config resolution** (`cli/config.ts`): Searches for `turbine.config.ts` / `.mts` / `.js` / `.mjs`, merges with `--url`/`--out`/`--schema` flags and `DATABASE_URL` env var.

**Migration system** (`cli/migrate.ts`): SQL-first migrations stored as timestamp-prefixed `.sql` files with `-- UP` and `-- DOWN` sections. Tracked in a `_turbine_migrations` table with SHA-256 checksums. Uses `pg_try_advisory_lock()` to prevent concurrent migration runs. Each migration runs in its own transaction. Checksum validation detects modified migration files. Destructive statements (both `migrate up`/`down` and, since 0.36, `push`) require a two-step typed confirmation (`destroy my data` then `yes`) or `--allow-destructive`. `migrate create <name> --recipe backfill` (0.36) scaffolds the sanctioned two-phase type-change pattern from the MIGRATION_RECIPES registry (fully commented: nullable add → batched keyed UPDATE → SET NOT NULL → atomic rename swap); `--recipe` without a name errors.

**Studio** (`cli/studio.ts`): Local web UI served over Node's built-in `http` module, no new runtime deps, read-only by default. ORM-native since v0.19: there is NO raw-SQL surface. The Query tab (default) is a visual `findMany` builder; `POST /api/builder` validates every identifier (table/relation/field/orderBy) against the introspected schema and compiles the args with `QueryInterface.buildFindMany` (`sqlCache: false`, all values as `$N` params). Saved queries are builder-kind only, legacy raw-SQL entries are dropped on load with a console notice. Binds `127.0.0.1` by default (warns loudly on non-loopback hosts), authenticates via a random 24-byte hex token (constant-time check on every `/api/*` route), per-session rate limiting (100 req/60s), refuses cross-origin requests, and ships nonce-based CSP + security headers (`script-src 'self' 'nonce-...'`, no unsafe-inline in script-src since 0.36; style-src keeps it; `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`). Every read runs inside `BEGIN READ ONLY` with `SELECT set_config('statement_timeout', $1, true)` (NOT `SET LOCAL ... = $1`, which Postgres rejects, that was the 0.17.0 critical bug) and `set_config('search_path', $1, true)` pinned to the configured `--schema`. **Write mode (0.36, `--write`; bulk since 0.38):** `/api/row/update|insert|delete` POST routes exist ONLY when writable (404 otherwise, deliberately not 403); each rebuilds the predicate from the FULL primary key alone via `extractPkWhere` (extra where keys dropped, operator objects refused, PK-addressed by construction), validates table/columns against metadata, compiles via buildUpdate/buildCreate/buildDelete (`sqlCache: false`), runs in a plain BEGIN txn with the same parameterized timeout + search_path, and requires a matching `Origin` (absent OR mismatched → 403). insert/delete also accept `rows: [...]` (MAX_BULK_ROWS=500): per-row validation up front, one statement per row in ONE all-or-nothing txn (any no-match → ROLLBACK + 404); bulk update refused; predicate-based mutations never exist. Views and PK-less tables refused. Loud startup warning + persistent red WRITE MODE banner. **PII redaction:** PII-tagged cells are redacted SERVER-SIDE ("•• redacted ••") before serialization, table rows, builder rows, nested `with` rows (redactBuilderRows walks the tree against each relation's target table), and the post-write echo; redacted columns are also excluded from the Data-tab ILIKE search OR-set, orderBy, AND the per-column `filters` param (even isNull, null-ness is an oracle too; parseTableFilters 400s). The Data tab's `filters` (JSON array, max 10, ops equals/not/contains/gt/gte/lt/lte/isNull/notNull) compile via a param-counter buildWhere shared with search, engine-aware placeholders. `--show-pii` reveals (terminal warning + persistent PII SHOWN banner). DB-less perimeter tests drive the exported `handleRequest` (src/test/studio-write.test.ts). **Temporal parity (0.54):** Studio builds a RAW pg pool and never constructs a TurbineClient, so it used to keep the driver's local-zone parsers and render a `date` cell as the previous evening east of UTC, which in `--write` is also the value an edit echoes BACK into the column; the Postgres path (never demo, which is sqlite) now calls `registerUtcTemporalParsers()` from query/utils.ts, the same helper client.ts uses. `cli/mcp.ts` does the same for its sampled rows. **Demo mode (0.37, `--demo`):** boots with NO DATABASE_URL against a seeded in-memory store (`cli/studio-demo.ts`: DEMO_SCHEMA users/posts/comments/orgs with pii-tagged email/phone + deterministic seed) backed by the sqlite engine over `node:sqlite` `:memory:` (Node >= 22.5, dynamic import with a clear error). `StudioContext.demo` + `dialect` branch the few PG-isms (pg_class counts → COUNT(*), ILIKE → LOWER LIKE, no BEGIN READ ONLY/set_config/search_path, `:pN` placeholders, `parseDemoRelationRows` re-parses sqlite's JSON-string relation columns); `POST /api/demo/mode` (demo-only, token+Origin gated) flips ctx.writable/ctx.showPii live for the UI's two toggle pills; boots read-only + redacted; each launch pristine, nothing persisted (saved queries too: demo routes them to ctx.memorySavedQueries, never .turbine/studio-queries.json, and never reads the real file). Postgres path byte-identical when off; tests in src/test/studio-demo.test.ts drive the REAL in-memory store through handleRequest. UI is an embedded single-file HTML/CSS/JS (`studio-ui.html`, prebuilt into `studio-ui.generated.ts` by `npm run gen:studio`) with Query / Data / Schema tabs matching the turbineorm.dev dark theme.

**UI module** (`cli/ui.ts`): Terminal formatting helpers, colors, spinners, tables, boxes. Imported throughout CLI but never by library code.

## Testing

**Unit tests** run without a database. They use mock schemas from `src/test/helpers.ts` which provides `mockColumn()`, `mockTable()`, and `makeQuery()` (creates a QueryInterface with a null pool for build-only SQL tests).

**Integration tests** need a PostgreSQL instance with seeded data. Set `DATABASE_URL` env var. The small correctness fixture is `src/test/fixtures/seed.sql` (8 users / 10 posts / 20 comments / 5 orgs). The larger benchmark seed lives in `benchmarks/seed-neon.ts` and defaults to 1K users / 10K posts / 50K comments (override via `USERS`/`POSTS_PER_USER`/`COMMENTS_PER_POST`). Tests that require a database are gated via the `skipGate()` helper in `src/test/helpers.ts` when `DATABASE_URL` is absent, each test registers with `{ skip }` so the reporter shows real skipped counts, not silent passes.

**Coverage** is configured in `.c8rc.json`. It covers `src/**` but excludes `src/test/**`, `src/cli/**`, `src/generate.ts`, `src/introspect.ts`, `src/serverless.ts`, and `src/index.ts`. Thresholds: 80% lines, 82% functions, 82% branches, 80% statements.

## Key Patterns

- All SQL identifiers quoted via `quoteIdent()`, doubles internal `"` chars per Postgres rules
- All user values parameterized (`$1, $2, ...`), never string-interpolated
- LIKE patterns escaped via `escapeLike()`, escapes `%`, `_`, `\`
- Empty-where guard blocks accidental mass mutations: update/delete with `{}` or all-undefined where throws `ValidationError` unless `allowFullTableScan: true`
- `LRUCache` bounds the SQL template cache at 1,000 entries (Map insertion order for O(1) eviction)
- Module has no side effects, `setTypeParser` for int8 is gated behind a static flag in the TurbineClient constructor
- ESM source with `.js` extensions (NodeNext resolution), CJS output via separate `tsconfig.cjs.json`
- Middleware runs after SQL generation, it can inspect/log params and transform results, but cannot modify the SQL itself

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

- Don't add runtime dependencies beyond `pg`. Root `dependencies` stays exactly `{ pg, @types/pg }`, `@types/pg` is required because published `.d.ts` files import `pg` types; moving it to `devDependencies` alone breaks consumer strict `tsc` (0.28.1 regression). Marketing "one dependency" means one **runtime** dep (`pg`); types packages that surface in public declarations stay in `dependencies`. The only sanctioned engine exception: `mysql2`, `mssql`, `@zvndev/powdb-client`, and `@zvndev/powdb-embedded` are **devDependencies + optional `peerDependencies`** (`peerDependenciesMeta.*.optional = true`), loaded lazily via dynamic `import()` from the `mysql`/`mssql`/`powdb` subpaths and never required for Postgres users; SQLite needs nothing at all (it uses the `node:sqlite` builtin). Those peer loads route through `src/optional-peer-import.cts`, the CJS build (`module: CommonJS`) lowers a plain `import()` to `require()`, which cannot load ESM-only peers (e.g. `@zvndev/powdb-client` ≥ 0.9, `ERR_PACKAGE_PATH_NOT_EXPORTED`); the `.cts` helper's NodeNext-built copy at `dist/optional-peer-import.cjs` keeps a REAL `import()` that the lowered copy falls back to. Don't replace it with a bare `import()` in the engine modules.
- Don't use `eval`, `new Function`, or shell interpolation
- Don't reference internal project names, client names, the applications findings were reported from, or internal planning documents in ANY tracked file, code comments, test names, CHANGELOG, release notes, commit messages, site. This repo is public. Describe changes by what they do, never by who asked for them or where feedback came from. `docs/internal/` and `AGENTS.md` are gitignored (local-only); the pre-commit hook enforces a private blocklist via `scripts/check-private-terms.mjs` + `.private-terms`.
- Don't break the Prisma-like API (`findMany`, `findUnique`, `with`, `where`)
- Don't put user values in SQL strings, always use `$N` parameterization
- Don't import `client.ts` from `query/` (would create circular dependency)
- Don't register type parsers outside the TurbineClient constructor
