# Turbine ORM

Postgres-first TypeScript ORM, with optional SQLite/MySQL/SQL Server engines behind subpath exports. Single-query nested relations via `json_agg`. Postgres remains the default and primary target; the other engines share the same typed API but several flagship features stay Postgres-only (see the capability notes in `dialect.ts` below).

## How work happens here, READ THIS FIRST

Full contract: **`docs/WORKFLOW.md`** (tracked). The non-negotiables, so you do
not have to open it before your first write:

- **`main` is protected and PR-only.** `ci-ok` is the sole required check and
  `enforce_admins` is on, so nobody pushes to `main` directly. Branch, push,
  `gh pr create`, wait for `ci-ok`, merge.
- **Never `--no-verify`. Never `git worktree`. Never force-push `main`.**
- **The tag publishes, not `npm publish`.** Land the release commit via PR, then
  `git tag vX.Y.Z && git push origin vX.Y.Z`; `release.yml` refuses a tag that
  is not on `origin/main`, runs the gates, and publishes the TESTED tarball with
  provenance and `--ignore-scripts`. A local publish is a gated fallback that
  refuses unless CI is green on HEAD.
- **Adding a CI job means adding it to `.github/workflows/gates.yml`, listing
  it in `gates-ok`'s `needs:` AND raising its anti-vacuous floor to match.** A
  test asserts the two are equal. `ci.yml` and `release.yml` both call
  gates.yml, so a tag runs the same matrix as a pull request; `ci-ok` (the
  required check) needs only `gates`.
- **A skipped suite is not a passing suite.** `TURBINE_REQUIRE_ENGINE` is set on
  every database job; an unset `DATABASE_URL` otherwise yields "12 tests, 0
  pass, 0 fail, 12 skipped" and exit 0.
- **Prove your guard fails.** Break the thing it checks, confirm a useful error,
  revert. A guard that has never failed is not known to work. This repo has
  shipped several assertions that were green because they tested nothing.
- **Prefer a mechanism over a correction.** A document edit re-drifts; a guard
  does not.
- **`DATABASE_URL` must be a direct endpoint, never a pooler, and never issue a
  session-level `SET`.**
- **This repo is PUBLIC.** See the `Don't` section at the end of this file.
- **If the plan is wrong, do the right thing and say so.** A recent 14-task plan
  carried eleven defects, all found during implementation and none in review.

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
    types.ts       , All public query arg types: WhereClause, WithClause,
                      FindManyArgs, RelationDescriptor, WithResult, UpdateOperatorInput,
                      AggregateArgs, JsonFilter, ArrayFilter, HavingClause /
                      HavingFieldFilter (0.53: a groupBy `having` field entry is
                      `(HavingAggregateFilter & WhereOperator) | WhereValue`, so an
                      aggregate filter AND a scalar filter on the grouped value can
                      share one object; plus AND/OR/NOT at any depth. _min/_max
                      operands are the column's own type, not numeric-only),
                      VectorFilter/VectorOrderBy (pgvector distance ops), etc.
    utils.ts       , Pure utility functions: quoteIdent(), escapeLike(),
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
                      Also `normalizePagination` (0.73): Prisma's `take` / `skip` folded
                      into `limit` / `offset` ONCE, at the same seams the relation-name pass
                      uses (`QueryInterface.normalizeArgs`, `PowqlInterface.normalizeArgs`,
                      plus `streamRaw`, whose speculative build spreads args and overrides
                      `limit`). `skip` was not a Turbine key at all while `take` was, so
                      `{ take, skip }` silently returned page one; half a recognized pair is
                      worse than neither half, since an unknown key is inert on its own. Not
                      read at each site, deliberately: `take` had SIX
                      `args?.take ?? args?.limit` reads and one of them is the SQL-cache
                      FINGERPRINT, where a miss is not a missing feature but two different
                      pages sharing one cached statement. Below the fold `limit`/`offset`
                      are the single authority and the aliases do not exist. Both spellings
                      of one bound with DIFFERENT values throws rather than picking.
                      pg-types' shipped .d.ts omits array OIDs from its setTypeParser
                      enum and types arrayParser loosely, so both are retyped locally
                      (comment says so); no dependency added.
    filters.ts     , Where-filter type guards + shape fingerprints (isWhereOperator,
                      isJsonFilter/isArrayFilter/isVectorFilter, sortedKeys/sortedEntries,
                      normalizeOrderBy). Kept out of builder.ts so the class stays about
                      SQL assembly rather than filter-shape bookkeeping.
    where-compile.ts, The canonical where-clause enumeration (added 0.36):
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
                      no walker is hand-mirrored anymore. The cache cross-check in
                      builder.ts reads the client's resolved `diagnostics.cacheCheck`
                      (0.90; no env read on the hot path): 'every-hit' (development
                      default, throw on mismatch) | `{ sample }` (rate in (0,1], log
                      `cache-mismatch` once per fingerprint then throw) | 'off'
                      (production default). The legacy TURBINE_* variables are read
                      only by diagnostics.ts. A mismatch is `InvariantError` (E020,
                      `invariant: 'sql-cache-lockstep'`), not E003. Two cheaper prechecks in
                      `crossCheckCache` run in EVERY mode (production, 'off' and
                      `sqlCache: false` included): on a miss the collected params must equal
                      the build's (`lastMissParams`, cleared once compared, so no bound
                      value outlives the call), and on a hit the collected count must equal
                      `SqlCacheEntry.paramCount` (`'sql-cache-param-count'`), before anything
                      is sent.
                      0.90 adds two rules here. `relationFilterValueProblem` /
                      `assertRelationFilterValues`: a quantifier (`some` / `none` / `every`)
                      must be a where object and `is` / `isNot` a where object or `null`;
                      anything else is E003 at every depth, global filters and `with`
                      wheres included, because `posts: { some: null }` used to compile to
                      nothing and a deleteMany carrying it deleted the table. And
                      `foldWhere` (`foldWhereFor` for plain metadata): what a where IS for
                      every row, `'empty'` / `'true'` / `'false'` / `'row'`, read from the
                      SQL the compiler would emit, branch for branch (a branch that compiles
                      to nothing is dropped from an `OR` and not negated by `NOT`). Constants
                      come from exactly three places: an empty `in` (FALSE), an empty
                      `notIn` (TRUE), and an `EXISTS` over a constant sub-where. The
                      mass-mutation guard (`userPredicateIsEmpty` in where.ts) refuses
                      `'true'` exactly as it refuses `'empty'`, so `NOT: { OR: [] }` and
                      `{ id: { notIn: [] } }` no longer write every row; anything not
                      provably constant is `'row'`, so folding never refuses a filter that
                      narrows. global-filters-config.ts runs the same fold at construction.
                      An `OR` branch that applies no condition (`{}`, `{ AND: [] }`) is TRUE
                      for its `OR`, as `OR: [{}]` always was (it used to be dropped, so its
                      `NOT` matched every other row); `OR: [{}]` compiles to `(1 = 1)`. A
                      branch emptied by `undefined` is still pruned before this rule. With
                      `options.notNull` (the guard only, via `guardFoldOptions` in where.ts)
                      the fold also reads NOT NULL columns: `not: null`, an empty
                      `contains` / `startsWith` / `endsWith`, a column compared with itself
                      and `hasEvery: []` are TRUE, and a bare to-one filter over a NOT NULL
                      foreign key is TRUE except on SQLite (orphans possible with
                      `foreign_keys` off) and when the target has a global filter. Reads never
                      consult it. `relationCardinalityProblem` refuses `is` / `isNot` on a
                      to-many (E003 naming `some` / `every` / `none`); PowDB calls the same
                      function.

    prepared-statement naming, A where (or having) clause containing a
                      CALLER-WRITTEN `AND` / `OR` ARRAY produces an UNNAMED prepared
                      statement (0.66). `AND: { ... }` written as ONE object is one branch
                      whatever the caller sends, so walkWhere tags it `fixedArity` and it
                      keeps its name. Load-bearing for `acquireSql`, not an
                      implementation detail: a named statement is never deallocated and
                      each pooled connection accumulates its own, which is fine while
                      the set of SQL texts is fixed by the application's code. A
                      combinator array's LENGTH is written into the text, one
                      parenthesized branch per element, so a `where.OR` assembled from a
                      UI multi-select lets a caller mint unbounded distinct statements
                      with no identifier and no value under their control. Measured on
                      PostgreSQL 16: 600 distinct arities left 600 prepared statements
                      and 20.9 MB of resident CachedPlan memory on ONE connection, and
                      200 further executions of an existing shape reclaimed none of it.
                      The mechanism: `markVariableArity()` on the BuilderCtx sets a
                      flag that `buildCacheEntry` reads immediately after the build
                      closure returns and turns into an EMPTY prepared-statement name,
                      so the entry is unnamed at CREATION and a later cache HIT can
                      never hand a warmed template a name. Unnamed is what bounds the
                      server (node-postgres skips `Parse` only for a statement already
                      parsed BY NAME), it is the same mechanism per-query
                      `forceCustomPlan` uses, and it changes NO SQL text. `in: [...]` is
                      deliberately NOT this shape: it binds `= ANY($1)`, one param
                      whatever the list length. Turbine's OWN synthesized wrappers
                      (`mergeGlobalFilter`'s `{ AND: [userWhere, globalFilter] }` and the
                      batched loader's `mergeChildWhere`, and nested-write.ts's
                      `scopeWhereToParent`) have a fixed arity of two and
                      are BRANDED via `markInternalCombinator` / `isInternalCombinator`
                      (query/utils.ts, a `Symbol.for('turbine.internalCombinator')` key:
                      `Symbol.for` for ESM/CJS cross-copy identity like the warn
                      registry, a SYMBOL so the `Object.keys` every where walker
                      enumerates never sees it and no emitted SQL can change), so they
                      stay NAMED. Without the brand every query on a table with a
                      configured global filter would lose its name, i.e. the rule would
                      have penalized precisely the multi-tenant setups it exists to
                      protect. The honest cost: a genuinely fixed two-branch `OR` (a
                      search box over name and email) loses its name too, because the
                      builder sees one call and cannot know whether the length varies
                      across calls. A second bound sits under all of this:
                      `boundedPreparedName` (utils.ts) hands out at most
                      `PREPARED_STATEMENT_BUDGET` (200) distinct names per PROCESS (a
                      `Symbol.for` registry, so the ESM and CJS copies share it), and a
                      statement past the budget is sent unnamed. The first shapes a process
                      runs keep their names, which in practice are its hot ones; a
                      server-side DEALLOCATE cannot do this job, because a pooled query does
                      not know which connection it will run on. Behind a pooler,
                      `preparedStatements` defaults to `false` (client.ts: a connection
                      string, `host` or `port` that `detectPooler` recognizes, on a pool
                      Turbine builds; an explicit `true` there warns, and since 0.90.2 so
                      does an explicit `true` on a supplied `pg.Pool` whose `options` name
                      a pooler, via `suppliedPoolEndpoint`), and
                      `TURBINE_DISABLE_PREPARED=1` turns names off everywhere.
    deferred.ts    , DeferredQuery, QueryInterfaceOptions, middleware/event types.
                      `queryInterfaceFactory` returns a `TableClient` (see below).
    table-client.ts, The table-accessor contract every engine implements (0.90).
                      `TABLE_METHODS` classifies each of QueryInterface's 34 public accessor
                      methods as `read` / `write` / `deferred` (the 15 `build*`) /
                      `primary` (`explain`, `cacheStats`), and `satisfies` a partial record
                      of QueryInterface's keys, so naming a method the class lacks fails to
                      compile. A type-only exhaustiveness check
                      (`EveryQueryInterfaceMemberClassified`) fails the build, NAMING the
                      member, when QueryInterface gains a public member that is neither in
                      `TABLE_METHODS` nor in `SqlInternalMember` (the five SQL-only
                      internals: collectWhereParams, fingerprintWhere, withFingerprint,
                      upsertNeedsLookup, resetUnlimitedWarnings). `TableClient<T, R, M>` is
                      `Pick<QueryInterface, TableMethod>`. `PowqlInterface implements` it,
                      so a missing or mistyped PowDB method is a compile error rather than
                      `undefined` at runtime; PowDB's `build*` throw E017 (it has no
                      deferred query, so `db.pipeline()` / `$transaction([...])` were a
                      `TypeError`) and its `cacheStats()` answers zeros. client.ts's
                      `READ_OPERATIONS` is DERIVED from the `read` entries.
                      `asQueryInterface` is the ONE cast from `TableClient` back to
                      `QueryInterface`, used by both factory call sites in client.ts
                      (`TransactionClient.table`, `TurbineClient.buildTableQI`); it sits next
                      to the check that makes it sound. Type-only imports, so no cycle.
    builder.ts      - QueryInterface class + the execute FACADE. Owns the
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
                      SHARED TEMPLATE CACHES (0.90.2): `templateCacheFor` gives every
                      QueryInterface built from ONE options object, for one schema object
                      and one table, the same LRU. Keyed by the options object's IDENTITY,
                      never a fingerprint of its fields, because options change the SQL
                      without being in the cache key; a copy with any field changed (the
                      batched loader's `defaultLimit: undefined` children) is another
                      object and so another cache. Every transaction of a client, and every
                      nested write, builds from ONE options object (`txQueryOptions`,
                      memoized per options object, returning already-tx-scoped options
                      as they are); a fresh `{ ...options, _txScoped: true }` per
                      transaction gave each `$transaction` an empty cache, so every
                      statement in it rebuilt its SQL. No options object (a bare
                      `new QueryInterface`) keeps a private cache. `cacheStats().size` is
                      the shared cache's; hits and misses stay per accessor. A groupBy
                      with a JSON-path key or JSON aggregate target is sent UNNAMED: its
                      aliases are caller text written into the SQL. `aggregate` / `groupBy` are not template-cached
                      but are NAMED since 0.90.2 (`withPreparedName`, the same
                      variable-arity bracket `buildCacheEntry` uses), and the `findFirst` /
                      `findFirstOrThrow` / `findUniqueOrThrow` wrappers pass the inner
                      statement's name through (they used to drop it). `create`,
                      `createMany` and `upsert` are still unnamed.
                      TIMEOUTS (0.90): a per-query `timeout` is a number of ms up to
                      2^31-1, or `0` for NO timeout (the pre-0.90 meaning, and the same word
                      `$transaction`'s `timeout` takes); `queryWithTimeout` maps 0 to no
                      timer, which is load-bearing, since without it the cancellable path
                      armed a 0 ms timer. Negative, NaN or a string is E003 (PowDB's twin
                      check in powql.ts says the same). On PostgreSQL through a
                      node-postgres pool outside a transaction (`cancelsOnTimeout`),
                      `queryCancellable` runs the statement on its own checkout and, at the
                      deadline, sends a protocol cancel (`sendCancelRequest`, utils.ts), then
                      waits at most `CANCEL_GRACE_MS` (2 s): cancelled is `TimeoutError`
                      `outcome: 'not-executed'`; a statement that finished first returns its
                      result late, because reporting a committed write as a timeout invites
                      a double apply; no answer is `'unknown'` and the connection is destroyed
                      rather than pooled busy. Inside `$transaction` the cancel goes to the
                      transaction's connection and the transaction is marked rolled back.
                      Every other engine and pool answers `'unknown'`.
    where.ts        - The whole WHERE web: the top-level and table-scoped
                      build/collect/fingerprint trios, leaf JSON/array/vector/text-search
                      clause builders, operator-clause + column-reference compilation, and
                      the client-level global-filter helpers. Owns the `BuilderCtx`
                      interface. Depends on nothing else in query/ (relation filters build
                      EXISTS inline), so it is the base module the others build on.
                      `textComparedOperand` (0.90) is THE MySQL rule for a value bound
                      against a text column: a number or bigint binds as its decimal text and
                      a boolean as `'1'` / `'0'`, because MySQL compares a number with text
                      numerically (`{ resetToken: 0 }` matched every non-digit token). The
                      where compiler applies it to each operand and list element, writes to
                      the keys they re-read by, and aggregates.ts to having `_min` / `_max`.
    aggregates.ts   - buildAggregate + buildGroupBy and helpers: HAVING clauses,
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
                      0.90: a `_min` / `_max` operand (and each `in` / `notIn` element) goes
                      through `whereMod.textComparedOperand`, since it compares a stored
                      cell; `_count` / `_sum` / `_avg` keep theirs. `assertGroupByKeys` runs
                      before anything reads `by`: missing, a string, an empty array or a
                      `null` entry is E003 naming `by` (the empty case points at
                      `aggregate()`).
    writes.ts       - Mutation SQL builders: create / createMany / update /
                      delete / upsert / updateMany / deleteMany plus the write-projection
                      helpers (writeReturningColumns / writeReselectSelection / parseWriteRow,
                      the PII column set, optimistic-lock + atomic-operator SET clauses,
                      reselect-by-where). Reuses where.ts; the async execute wrappers stay in
                      builder.ts. Single-row writes take `select` / `omit` (0.80) as a
                      `WriteProjection` (the column list, resolved in builder.ts by the SAME
                      `resolveProjection` reads use, because writes.ts cannot import
                      relations.ts without a cycle). It narrows the STATEMENT (RETURNING /
                      reselect / OUTPUT), and the update + delete template-cache keys carry a
                      `|rt=` segment for it: without one, two calls differing only in `select`
                      shared a statement and the second got the first's columns. PowDB narrows
                      the returned ROW instead (its `returning` takes no column list).
                      `upsertLookupReason` (0.81) is the one authority on when `upsert()`
                      looks the row up instead of running `buildUpsert`'s statement
                      (`where` not pinned to `create`, an empty `update`, a global filter
                      on an engine without `supportsUpsertUpdateWhere`, and since 0.90
                      `other-unique-key` on MySQL: `ON DUPLICATE KEY UPDATE` has no
                      conflict target and updates whichever unique key collides first, so
                      a `create` that can collide on a key `where` does not pin, the
                      primary key included, could update a row `where` does not name);
                      `buildUpsert`
                      REFUSES the same shapes, since a batched DeferredQuery has no round
                      trip for a lookup. The lookup itself is `upsertLookupFirst` in
                      builder.ts, which also takes nested relation writes and compiles both
                      halves BEFORE the lookup so validity never depends on whether the row
                      exists. `planCreateMany` (0.90) is the one sizing authority for
                      `createMany`: it validates every row once, then `rowsPerStatement`
                      measures the per-row parameter cost from one-row and two-row builds
                      and caps it by `maxBindParameters` and, for a plain INSERT,
                      `capabilities.maxInsertRows`, so chunks are sized before any statement is
                      built and no engine's own per-statement check refuses one. No per-row step
                      searches the column list (0.90.2): the generated-column check reads the column
                      list once per CALL (`generatedStoredColumns`), and the row-shape check
                      compares key sets without ordering them; both used to cost a column
                      search or a sort per row, ~3.6 µs a row. A test counts column-list reads
                      through a proxy and requires the same count for 2 rows and 500. The MySQL
                      reselect (0.90) re-reads a `create` only by a key whose value is known
                      EXACTLY (a supplied primary key, the driver's insert id for a
                      server-numbered key, decided by `isGenerated` when the metadata
                      records it, else a unique key supplied in full) and refuses with E017
                      before the INSERT when there is none: it used to re-read by a guessed
                      key and could return another tenant's row. A write that moves its row
                      out of its own `where` locks by `where` and re-reads by key
                      (`lockMovedRowKey`), and a re-read or lock matching more than one row
                      is E017 and rolls back. A multi-statement write runs in
                      `inOneTransaction` (builder.ts) on one deadline (`deadlineExec`), so
                      `timeout` bounds the whole call. `divide` on a MySQL integer column
                      compiles to `DIV` (truncates, as PostgreSQL does), and a `Date`
                      written to a `date` column binds its UTC day on every SQL engine
                      through the same `utcDateTimeRewrite` gate the where side uses.
    relations.ts    - Relation + orderBy compilation: the json_agg nested-relation
                      machinery (buildSelectWithRelations, buildRelationSubquery,
                      buildManyToManySubquery), the positional-encoding shapes + nested-row
                      parser, the full orderBy surface (plain / JSON-path / vector KNN /
                      relation _count / pick-row), relation _count expressions + their
                      global-filter params, and the with-clause fingerprint + param
                      collectors. Reuses where.ts (WHERE) and writes.ts (PII column set); the
                      last and most connected module. `resolveProjection` (0.64) is THE
                      single select/omit -> column-list authority, for the query's own table
                      and a relation target alike (`resolveColumns` / `resolveTargetColumns`
                      are now wrappers; the only difference is that the top level's "no
                      projection" is `null` for the `*` fast path while a relation gets
                      allColumns). It was two hand-synced implementations and they drifted:
                      the top level threw E003 on an unresolvable name while the relation side
                      FILTERED it out, so `with: { posts: { select: { titel: true } } }`
                      returned `[{}, {}]` and an `omit` typo returned the column it was asked
                      to hide. Worse than a depth inconsistency: the batched loader queries the
                      target table directly and so went through the THROWING path, meaning the
                      two strategies disagreed about whether a query was VALID and `'auto'`
                      picked between them on index coverage and table size. THE RULE, and it
                      has no third outcome: a caller-supplied name resolves to a column or
                      throws. A relation named in select/omit gets its own message
                      (`relationInProjectionMessage` in utils.ts) pointing at `with`, because
                      that is a Prisma habit rather than a typo and the generic text degrades
                      into "Did you mean <exactly what you typed>?". Same rule and same message
                      on PowDB (`PowqlInterface.projectionColumn`). Verified 0.64: EVERY other
                      caller-name site (where, orderBy, distinct, groupBy `by`, aggregate
                      targets, create/update `data`) already threw; projections were the only
                      silent one. 0.65, two projection SHAPE refusals (E003, shared messages
                      in utils.ts): a `select` naming no fields (empty/all-false), and
                      `select` + `omit` together. Both are PRESENCE-decided like the resolver
                      branch itself, and the batched loader re-asserts them on the RAW args
                      (`assertProjectionShape`, before includeKeysForBatching force-adds
                      correlation keys), because evaluated after the force-add an all-falsy
                      select looks populated and the verdict flipped between strategies
                      (review-caught). PowDB: same checks in projectedColumns + the loader's
                      force-add site. Before 0.65 the select branch returned early so the
                      omit half was never even name-validated on SQL engines while PowDB
                      APPLIED select-minus-omit. Studio's chips enforce the pair rule live
                      (choosing select clears omit and vice versa) and its emit drops a
                      stale saved query's omit when select is non-empty.
    batched-loader.ts, The `relationLoadStrategy: 'batched'` path. Instead of the default
                      single-statement `json_agg` join, runs the base query without relation
                      subqueries, then ONE flat follow-up per relation
                      (`WHERE fk = ANY($1)`, chunked at MAX_RELATION_KEYS=32_000) and stitches
                      client-side, output byte-for-byte equal to the join strategy. Runs on
                      the caller's executor/connection (tx-safe); per-relation `limit` applied
                      client-side per parent; composite-key relations throw E017. Validation
                      is DATA-INDEPENDENT (0.65): there is deliberately no early return on
                      zero parents/keys/children anywhere in the tree walk; each level
                      compiles its child findMany (one SQL string build, nothing executes)
                      before its data-dependent exit, and builder.ts invokes the loader even
                      for an empty base result (and a findUnique miss), so accept/reject
                      matches the join plan's compile-time validation exactly. An unknown
                      relation name is E005 (RelationError), same code and message as the
                      join path. The differential fuzz suite (src/test/strategy-fuzz.test.ts,
                      join-vs-batched acceptance agreement + deep row equality on seeded
                      random args; nightly extended run with a date-derived seed) is the
                      regression net for this whole class.

    flatten (strategy), `relationLoadStrategy: 'flatten'` has no module of its own: the
                      plan is built by `planFlatten` (query/builder.ts) over
                      `planFlattenWith` / `planFlattenNode` (query/relations.ts) and read
                      back by `makeFlattenParser`. An eligible TO-ONE relation compiles to a
                      `LEFT JOIN` with a PREFIXED SCALAR projection (`f0__email`) plus a
                      non-null discriminator column, instead of a correlated
                      `json_build_object` subquery, and the nested object is assembled
                      client-side. Rows are byte-identical to the join strategy's.
                      Eligibility is per relation and every refusal falls back to the
                      default correlated subquery SILENTLY and byte-identically (with a
                      once-only warning gated on `diagnostics.advice`, WARN_NS.flattenFallback,
                      code `flatten-fallback`): to-one only, a
                      PROVABLY UNIQUE target key, no per-relation `limit` / `orderBy`, no
                      `_count` in the nested `with`, no alias collision or over-length alias,
                      and depth < FLATTEN_MAX_DEPTH (10, mirroring the join cap). Four
                      QUERY-level gates turn the whole plan off: `jsonEncoding: 'positional'`
                      (a flattened relation emits no JSON to encode), a dialect that
                      generates relation subqueries itself (SQL Server's `FOR JSON PATH`),
                      `distinct`, and the findUnique family (one parent row means the
                      correlated subquery already runs once). Pagination needs no gate: a
                      unique-key join matches at most one row per parent, so it cannot change
                      the parent row count. The SQL-template cache key carries a `|fl=` +
                      plan-signature segment so a join-planned statement can never be served
                      to a flatten-planned call. SECURITY NOTE: the flat shape must never
                      reach Studio's PII redaction, which walks the NESTED object, see the
                      transform comment in cli/studio.ts's apiBuilder. Tests:
                      src/test/flatten-strategy.test.ts (build-only) and
                      src/test/flatten-parity.integration.test.ts.

    compound-unique.ts, Compound-unique where selectors (0.41): derives selector names
                      (`orgId_userId` or a declared composite-unique index name) from
                      primaryKey + uniqueColumns + IndexMetadata and normalizes
                      `where: { orgId_userId: {...} }` into flat column equality BEFORE
                      cache fingerprinting. Consumed by the findUnique family, nested-write
                      unique wheres (connect/connectOrCreate/etc.), and PowqlInterface.
                      0.73 adds the OTHER question about the same metadata:
                      `assertWhereIdentifiesOneRow` (over `whereIdentifiesOneRow` /
                      `uniqueKeyNames`), the findUnique refusal shared by EVERY engine,
                      message included. `findUnique({ where: { status: 'active' } })` used
                      to emit `LIMIT 1` with no ORDER BY and return an arbitrary one of the
                      matching rows, the same hazard the 0.61 empty-`where` guard already
                      refuses one step earlier and in the same words. The rule reads the TOP
                      LEVEL of the USER's where only (a key inside an `OR` does not identify
                      a row; a global filter is not an identity) and needs a plain equality
                      or an explicit `{ equals }`: NULL never counts, because PostgreSQL
                      permits any number of NULLs in a unique index. Extra predicates beside
                      the key are fine, they can only narrow a set that already holds at
                      most one row. SHARED rather than written twice because PowqlInterface
                      is a parallel implementation, and two copies of a rule this specific
                      is how two engines come to disagree about whether a query is VALID
                      (the 0.64 projection-resolver class). 0.81 adds the upsert question:
                      `upsertWhereMatchesCreate`, whether ONE conflict statement means what
                      the call says. `ON CONFLICT` compares the values it INSERTS (`create`'s)
                      and never reads `where`'s, so `where: { id: 5 }` with a keyless `create`
                      inserted a new row on every call. Only when every `where` key is pinned
                      to `create`'s value may an engine take its single-statement path;
                      otherwise it looks the row up by `where` in one transaction (Prisma's
                      contract). `false` is always safe (the lookup is correct for every
                      shape), so anything unrecognized answers false. Every engine and
                      prisma-compat read this one rule.
    relation-names.ts, THE relation-name rule (0.72), the twin of
                      `resolveColumnName` one level up. A relation carries one DECLARED
                      name (`blogPosts`) while the DDL anyone reads carries only the TABLE
                      name (`blog_posts`), so writing back what the schema shows failed:
                      E005 in `with`, E003 in a relation filter, E005 in `orderBy`, on
                      names the error text was ALREADY computing correctly ("Did you mean
                      ...?"). `resolveRelation` (query/utils.ts) accepts the declared name
                      first, else `snakeToCamel(key)` ONLY when that names a real declared
                      relation, so it is not a guess and an exact declared name always
                      wins. THE KEY DESIGN POINT is where it is applied: the `with` tree is
                      walked by SIX independent functions that each decide for themselves
                      which keys are relations (withFingerprint, collectWithParams,
                      buildRelationShapes, planFlattenWith, buildSelectWithRelations, the
                      batched loader, plus the positional row parser), and the fingerprint
                      IS the SQL-cache key, so a walker resolving differently from the
                      builder would serve one query's template to another SILENTLY. So
                      `normalizeWithClause` rewrites the whole tree ONCE, before any walker
                      runs (the `compound-unique` precedent, and the same "before
                      fingerprinting" slot `applyStableRelationOrder` uses), returning the
                      input BY REFERENCE when nothing changed so the common path allocates
                      nothing. An unresolvable key is left VERBATIM so the builder still
                      raises E005 by name, in context. Argument positions where a relation
                      key sits interleaved with column keys cannot be normalized that way
                      and resolve at their branch point instead, each one a documented
                      single authority: `where-compile.ts`'s walkWhere (the one branch
                      authority all three where paths consume), the orderBy relation
                      descents, the simple-where fast path, and the orderBy fingerprint +
                      its cache-hit param mirror. PowDB adopts the same rule explicitly
                      (`PowqlInterface.withDeclaredRelationNames`), because it is a
                      parallel implementation and a rule adopted only on the SQL side is an
                      engine that disagrees about which queries are VALID. Found by the
                      agent eval, not by review: after the column fix landed it was 65% of
                      remaining model failures. Regression net:
                      src/test/relation-spelling-symmetry.test.ts, same four-questions
                      shape as its column sibling (both spellings accepted, byte-identical
                      SQL, unknown still refused), mutation-tested at 30 of 67 failing.
    warn-registry.ts, Process-wide once-only dev-warn registry (0.41) keyed on a
                      globalThis Symbol.for('turbine.warnOnce.registry') so multi-instance
                      and dual-package (ESM+CJS) setups never double-warn; WARN_ONCE_CAP=500.
                      Namespaces: FK-advisor notes, deep-with, 'auto' strategy engagement,
                      unordered-page, PowDB link DDL skips, 'flatten' fallbacks, and
                      unknownConfigKey (0.53: client.ts warnUnknownConfigKeys checks every
                      key on the config object against TURBINE_CONFIG_KEYS and warns once
                      per key name (always on since 0.90), with suggestConfigKey's correction,
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
                      are 'prisma' and hand-translated). 0.73 gives the same tables a SECOND
                      consumer, `warnUnknownQueryOptions`, the core dev-mode warning for a
                      key that is on no arg interface and is therefore doing nothing. It
                      hangs at ONE seam per engine (`executeWithMiddleware` /
                      PowqlInterface's `withMiddleware`), which every public operation
                      already passes through carrying its own name, so a new operation
                      cannot be added without the diagnostic covering it. Motivating case:
                      `include`, which is Prisma's word for `with` and is simply ignored, so
                      the query runs, returns rows, and the relation is absent from every
                      one of them; it gets its own message rather than a nearest-name guess.
                      A WARNING and never an error, because `findMany({ ...optionsBag })` is
                      ordinary code and the surface grows between minors. Since 0.90 the
                      caller's advice logger (or `null`) is a REQUIRED parameter and the
                      module reads no environment: an omitted logger used to fall back to
                      the console whatever the client's `diagnostics` said. This is the file's
                      first runtime import (warn-registry + utils, both leaves that do not
                      import it back), so everything above it stays type-only.

    normalize-args.ts, `undefined` means absent, decided ONCE (0.90). `pruneUndefinedArgs`
                      runs at the args seam of every public operation and its `build*` twin,
                      before the empty-where guards, the fingerprint, the build and the param
                      collect read anything. A key whose value is `undefined` is removed, and so
                      is an object or combinator array that BECOMES empty because of it, so
                      `{ user: { email: undefined } }` is exactly `{}`. Never prunes `data` /
                      `create` / `update`, an operand value, or an object written empty. Also
                      carries prisma-compat's inclusive-cursor flag through the prune.
                      The cursor refusals sit beside it (0.90, every engine): `assertCursorWritten`
                      refuses `cursor: null`, a non-object and `{}` (each used to mean "no
                      cursor", so `cursor: last ? { id: last.id } : {}` cut page one from a
                      different order than every later page), and `assertCursorNotEmptied`
                      a cursor whose every field was `undefined`. A NULL cursor value on a
                      NOT NULL or primary-key column is refused by the cursor value check in
                      filters.ts.

    column-ref.ts  , `col('field')`, a column compared against another column of the same
                      row (`{ equals: col('b') }` emits `"a" = "b"`). BRANDED with a
                      `Symbol.for` key: a plain `{ col: 'id' }` is exactly what `JSON.parse`
                      makes from a request body, and if that shape were a reference,
                      `delete({ where: { id: body.id } })` could compile to `"id" = "id"`.
                      Same reasoning as `UNSAFE`.

    json-value.ts  , `jsonValue(v)`, the explicit JSON write: a JS string written to a json
                      column is raw JSON TEXT, so without the wrapper there is no way to store
                      the JSON string `"hello"` or JSON `null`. Branded the same way.

    expr.ts        , Update expressions (0.90): `expr.add/sub/mul/div/coalesce/greatest/
                      least/case/now/excluded`, accepted in `update`, `updateMany`, upsert
                      `update`, nested update data and `createMany`'s `onConflict.update`;
                      refused in create data. Nodes are frozen and carry a `Symbol.for` brand,
                      so a JSON look-alike `{ kind, args }` is a VALUE (refused on a non-JSON
                      column). `compileSetExpr` is the ONE traversal producing the SQL, the
                      params and the fingerprint together, the where-cache lesson applied
                      before it could bite. Rendering is chosen by `dialect.name`: GREATEST /
                      LEAST ignore NULLs on every engine, `now()` follows the UTC read path
                      per column type. A `case`, or a variadic with more than two operands,
                      makes the statement UNNAMED (its arity is in the text, the 0.66
                      variable-arity rule). `resolveExcludedFromCreate` turns
                      `expr.excluded(field)` into `create`'s value on the lookup-first upsert
                      path and in nested upserts. PowDB refuses expressions (E017).
                      Arithmetic is typed from its operands: integer between integers (DIV on
                      MySQL, so `expr.div` truncates toward zero everywhere, float target
                      included), and a result that can be non-integer is refused on an integer
                      column (E003). A bound value's class is in the fingerprint.

    row-lock.ts    , The `lock` read option (0.90). `resolveRowLock` is the one place a lock
                      value is validated and rendered; the SQL and the `|lk=` cache-key
                      segment both read it, and an unlocked key is byte-identical to before.
                      The clause is `FOR <mode> OF "<table>"` after pagination: `OF` keeps the
                      lock on the queried table's rows only, on every relation strategy, and
                      without it PostgreSQL refuses the flatten plan. Modes come from the
                      `dialect.rowLockModes` flag each engine sets explicitly (PostgreSQL all
                      four, MySQL 'update' and 'share', the rest none, so E017). Refused: a
                      locking read outside a transaction (E003, autocommit would release the
                      lock before the caller saw the rows; "inside" is `txScoped`), on a stream,
                      with `distinct`, and in an autocommit pipeline (`DeferredQuery.rowLock`,
                      checked in client.ts `pipeline()`). Studio and MCP refuse `lock` by name
                      (`findRowLockOption` in cli/pii-predicate-guard.ts). A lock that cannot be
                      taken is `LockNotAvailableError` (E013, see the error table).

    stream-idle.ts , The abandoned-stream guard (0.90), a leaf importing errors.ts only.
                      A cursor stream (`findManyStream` / `findManyStreamBatches`) that holds
                      its OWN connection between pulls is watched (one that fit the speculative
                      fetch holds nothing; one inside `$transaction` rides the caller's
                      connection and is not watched). Client `streamIdleTimeoutMs` (default
                      300000, `0` disables), per call `idleTimeoutMs`; `resolveStreamIdleTimeout`
                      is the E003 validator (a whole number of ms). NOTE the client's plain
                      `idleTimeoutMs` is the POOL's idle-connection timeout, a different thing.
                      `StreamIdleGuard` is an unref'd interval ticking at min(timeout/4, 5 s):
                      only time the consumer is suspended counts, never time Turbine spends
                      fetching. On expiry `expireIdleStream` (builder.ts) runs the dialect's
                      cleanup, releases the connection, logs `stream-idle-timeout` (always
                      on), and the next pull throws `TimeoutError` (E002, `'not-executed'`).
                      builder.ts drives the dialect's generator by hand (not `yield*`) so the
                      timer can close it while the consumer is suspended. PostgreSQL only:
                      `streamBackstopStatement` rides on the dialect's own BEGIN (matched by
                      exact text in `watchStreamConnection`, one simple-protocol round trip)
                      and sets `idle_in_transaction_session_timeout` TRANSACTION-LOCALLY
                      (`set_config(..., true)`, never a session `SET`) to timeout + 10 s,
                      reading `pg_settings` so a stricter existing limit is kept; a keepalive
                      `SELECT 1` goes out when the connection has been quiet for half the
                      timeout, so the server limit only fires when timers cannot run (a frozen
                      process), which surfaces as 25P03 -> `ConnectionError` (E004).

    sql-comment.ts , `sqlComment` (0.90): sqlcommenter key/values (`static`, `model` +
                      `action`, `tag` from `$tag`, per-statement `dynamic`) on every
                      statement a MODEL call sends, appended in `QueryInterface.outgoing()`
                      AFTER the SQL-template cache, so cache keys and hit rates do not change
                      and events keep commentless `sql` plus `e.comment`. `resolveSqlComment`
                      validates at construction (E003 for bad keys/values/types; E017 on a
                      backend that builds no SQL, i.e. PowDB, detected as
                      `queryInterfaceFactory` present, and for `dynamic` on MySQL, whose
                      mysql2 `execute()` keeps a server-side prepared statement per distinct
                      text against the server-wide `max_prepared_stmt_count`). Prepared
                      names: no comment keeps the template name; static/model/tag comments
                      get a `c_<fnv1a64>` name from the shared process budget (the `t_`
                      template name is not claimed when every statement is commented,
                      `alwaysComments`); ANY dynamic value makes the statement unnamed. A bad
                      dynamic key/value is dropped with one `sql-comment-dropped` warn and
                      never fails the query. Batch paths (`pipeline`, `$transaction([...])`)
                      go through `commentDeferred`. Raw SQL and transaction control get no
                      comment. `withoutTrailingComment` is for engine shims that read
                      statement text (sqlite.ts `statementReturnsRows`, so a value like
                      `orders-returning` cannot turn a write into a row read).

    index.ts       , Barrel re-export. All imports use `./query/index.js`.

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

  transaction-client-slot.ts, Where the implicit-transaction path finds `TransactionClient`
                      (0.90.1). client.ts calls `registerTransactionClient` once at module
                      evaluation; query/builder.ts and powql.ts read `transactionClientFor(...)`
                      before checking out a connection. Replaced their dynamic imports of
                      client.ts (see the "Don't import client.ts" rule at the end of this file).

  connection-url.ts, Zero-import leaf (0.71) owning everything that reads or rewrites a
                      CONNECTION STRING. Three jobs. (1) `detectPooler(connectionString,
                      environment?)` (0.90: `fillTargetFromEnvironment` fills an unset host /
                      port from PGHOST / PGPORT, `detectPoolerTarget` judges the result) +
                      `poolerRefusalMessage`: `turbine doctor` REFUSES a transaction-pooling
                      endpoint before opening a connection (`--allow-pooler` overrides;
                      default is refusal). A pooler multiplexes backends, so both the session
                      state doctor needs and the session-scoped views it reads
                      (pg_prepared_statements) belong to whichever backend answered. Matching
                      is on whole dot/dash/underscore TOKENS of the hostname (`pooler`,
                      `pgbouncer`, plus numbered forms), never a substring of the connection
                      string, so a database named `poolers` or a host `spooler.internal` is
                      not caught; ports are 6543 AND 6432 (PgBouncer's documented default
                      `listen_port`, included because the errors are asymmetric: a false
                      positive costs one flag on an interactive command, a false negative is
                      the hazard itself). Since 0.90 `migrate up` / `deploy` / `down` refuse
                      the same way (`--allow-pooler` overrides; `--dry-run`, `status` and
                      `create` are not refused), because the migration lock is a
                      SESSION-level advisory lock a pooler can take on one backend and
                      release on another. (2) `withStatementTimeoutOption`: index-stats.ts
                      used to issue a SESSION-LEVEL `SET statement_timeout` on a pool built
                      from a connection string, which through a pooler poisons a SHARED
                      backend that is not DISCARDed on release. It now goes in the
                      `options=-c` CONNECTION PARAMETER (the `withPlanCacheMode` pattern), and
                      plan-flip-probe.ts, which had the identical bug, now sets it
                      transaction-locally via `set_config(..., true)` inside its
                      `BEGIN READ ONLY` (`SET LOCAL x = $1` is a Postgres SYNTAX ERROR, which
                      is the 0.17.0 bug, so `set_config` is the parameterizable form). The
                      value is narrowed to a non-negative safe integer before it can reach the
                      wire, because a GUC value cannot be a bind param and anything carrying a
                      space can carry a second `-c`. (3) `mergeConnectionStringOptions`, shared
                      with `TurbineClient.withPlanCacheMode`. KEEP THIS FILE IMPORT-FREE, that
                      is what lets client.ts depend on it without a new edge.

  connection-guard.ts, Zero-import leaf (0.80): surviving a connection the SERVER closes.
                      Three mechanisms. (1) `guardCheckout` / `guardConnection`: pg-pool
                      listens for a client's 'error' only while it is IDLE, so a checked-out
                      client whose socket died emitted an unheard 'error' and NODE EXITED.
                      Every held connection carries a listener for exactly its checkout, and
                      `absorbCheckedOutErrors` puts one on every connection an owned pool
                      opens. A source scan in connection-loss.test.ts requires every
                      `pool.connect()` to be guarded and every `new pg.Client()` to call
                      `guardConnection`. (2) `settleLongIdleCheckouts` (owned pools only):
                      pg-pool evicts an idle connection when it READS the close, which needs
                      the event loop; after a freeze (serverless between invocations) every
                      idle connection is dead and still lendable. A checkout reusing one idle
                      >= LONG_IDLE_SETTLE_MS first waits for `settleEventLoop` (TWO
                      setImmediate hops, since one runs before the next poll), no round trip.
                      (3) `settleEventLoop` also precedes every retry below. Keep it
                      import-free: client.ts, query/, cli/ and powql.ts all share it.

  checkout.ts      , The one checkout seam (0.80): `acquireConnection` (typed E004 +
                      guard) and `openCheckout(pool, opening)`, which retries the OPENING
                      statement (BEGIN, connect()'s SELECT 1) once on a fresh connection when
                      it failed on a dead one (`isStaleConnectionError` in errors.ts, which is
                      deliberately narrower than "is a ConnectionError": a connection that
                      could not be OPENED is not retried). Safe because nothing has run.
                      `$transaction`, `transaction()`, nested writes and `connect()` open
                      here, so a failed BEGIN never reaches their catch and their ROLLBACK is
                      unconditional. THE READ/WRITE RULE: reads outside a transaction retry
                      once (`QueryInterface.readWithTimeout`), writes NEVER do, because a lost
                      connection does not say whether the statement committed. `currentAction`
                      cannot decide that (it is shared instance state a concurrent call can
                      overwrite), so read call sites call `readWithTimeout` explicitly and
                      stale-connection.test.ts pins which methods retry, with the read list
                      checked against reflection. Live net:
                      stale-connection.integration.test.ts freezes the loop for real (a
                      worker terminates backends while the main thread is in Atomics.wait).

  transaction-state.ts, The state one open transaction shares (0.90): whether it is still
                      open (a `tx` captured by an un-awaited promise or a timer is refused once
                      the transaction settles, because its connection may already serve another
                      request), the FIRST statement failure, and the savepoint stack. Blocks
                      that share a parent run one at a time, since two open savepoints on one
                      connection would roll each other back. `commitTransaction` refuses to
                      report success when PostgreSQL answers COMMIT with the `ROLLBACK` command
                      tag (an aborted transaction, no error), and `rolledBackError` builds the
                      error that carries the first failure as `cause`; a retryable first
                      failure keeps its class so `$retry` still retries (a `LockNotAvailableError`
                      included, which used to collapse to `SerializationFailureError`); any
                      other first failure is `TransactionRolledBackError` (E019), for the
                      transaction and a rolled-back savepoint block alike, and the pipeline
                      COMMIT-answered-with-ROLLBACK path goes through the same function. A callback that returns
                      with work still running rolls back (`unawaitedWorkError`, E003). Shared
                      by `$transaction`, nested blocks and raw `transaction()`.
                      Also tracks whether PostgreSQL has ABORTED the transaction (per
                      savepoint tick): the next statement is refused locally with the first
                      failure's class (retryable) or E019, never sent to come back as an
                      untyped 25P02; a successful `ROLLBACK TO` ends the abort. Each nested
                      `tx.$transaction` gets its own `TransactionScope` handle (`withBlock`);
                      a statement through an outer handle while an inner block is open is
                      E003. `withSavepoint` is the handle-less savepoint one multi-statement
                      write runs in. `runRaw` / `screenRaw` refuse transaction-control SQL on
                      the raw paths (via transaction-control.ts); raw `transaction()` keeps
                      SAVEPOINT / RELEASE / ROLLBACK TO.

  transaction-control.ts, Zero-import leaf (0.90): `findTransactionControl(sql, syntax)`
                      finds BEGIN / COMMIT / ROLLBACK / SAVEPOINT / RELEASE / SET
                      TRANSACTION / PREPARE TRANSACTION and the rest at statement STARTS,
                      with per-engine lexical rules (`ControlSyntax`: postgresql, mysql,
                      sqlite, mssql), so a word in a comment, literal or quoted identifier is
                      never a statement. Ambiguity reads as quoted (a missed statement goes
                      through as before; an invented one would refuse a valid query). NOT a
                      second splitter: `src/test/fx-tx-control.test.ts` holds it to
                      `cli/sql-statements.ts` over an adversarial corpus. Kept out of cli/
                      because library code imports one CLI file only (schema-sql.ts ->
                      `cli/destructive.ts`), and the CLI tokenizer would land in every engine
                      and edge bundle.

  sql-placeholders.ts, Zero-import leaf (0.90) every non-PostgreSQL engine entry shares.
                      `scanPlaceholders(sql, 'mysql' | 'sqlite' | 'mssql')` finds placeholders
                      outside string literals, quoted identifiers and comments under THAT
                      engine's lexical rules, and `rewritePositionalPlaceholders` maps `$n` to
                      `:pN` (SQLite, MySQL) or `@pN` (SQL Server), so `rawUnsafe(text, ...values)`
                      takes `$1..$n` on every engine (SQLite read `$1` as a parameter NAMED
                      `$1`, MySQL rejected it, SQL Server read it as a MONEY literal). A `?`, or a
                      `$n` past the values given, is E003; with no values the text is untouched.
                      MySQL's pool shim also expands a list bound as one `IN (:pN)` into one
                      placeholder per element, padded to the next power of two by repeating the
                      last element (at most 17 texts per base statement), refusing a statement
                      whose placeholders, list elements included, pass 65,535 (E003). Deliberately NOT `cli/sql-statements.ts`: that lexer is
                      PostgreSQL's grammar (dollar quotes, `E''`, nesting comments) and has no
                      backtick / bracket identifiers, `#` comments or MySQL backslash escapes;
                      different grammars, not a second lexer for one. Ambiguity reads as quoted.

  global-filters-config.ts, `globalFilters` checked at CONSTRUCTION (0.90). The config is
                      keyed by client ACCESSOR (`blogPosts`) while the builder looks filters
                      up by TABLE name, so a key that names neither was a filter applied to
                      nothing, which for a tenancy boundary is the worst way to fail.
                      `normalizeGlobalFilters` maps every key to its table, refuses an unknown
                      key and a static filter naming no column or relation, runs each static
                      filter through `foldWhereFor` so its WHOLE shape is checked at every
                      depth (a relation filter value like `author: { is: 5 }` used to pass
                      construction and fail the first query on that table, i.e. a request),
                      prefixes any E003 with `globalFilters["<key>"]`, and returns the map
                      the builder reads. `tableAccessorName` is the ONE place the accessor
                      name is derived. `assertStaticFiltersCompile` then compiles every static
                      filter through a real `QueryInterface.buildFindMany` with the client's
                      dialect (first each table alone, so an error names the filter that holds
                      it, then all together), so any value a query would refuse throws from the
                      constructor. `assertNoFilterCycle` refuses static filters that reach their
                      own table through relation filters, directly or via another table's
                      filter, naming the chain (it was a `RangeError` on every query). Function
                      filters are never called at construction: they are checked per query by
                      the resolver, and where.ts's `filtersBeingApplied` stack applies each
                      table's filter once per chain (a relation leading back to a table whose
                      filter is being compiled reads unfiltered).

  supplied-pool-types.ts, Turbine's column readings on a pool the CALLER supplied (0.90).
                      On an owned pool the int8 / UTC-temporal parsers are registered on the
                      pg module; a supplied pool keeps the caller's parser table, so Turbine
                      attaches its parsers to each of its OWN queries as a query-level `types`
                      (node-postgres reads it in place of the connection's). Every type
                      Turbine does not govern falls through to the table the query would have
                      used, so the caller's own parsers still apply, and the caller's own
                      queries on that pool are untouched.

  diagnostics.ts   , The `diagnostics` client option (0.90): `resolveDiagnostics(config, env)`
                      returns a frozen `{ mode, advice, cacheCheck }`. Mode defaults to
                      'production' when NODE_ENV is 'production' OR there is no `process`
                      (edge), else 'development'; resolved ONCE at construction and handed to
                      every query interface the client builds. Also reads the legacy
                      TURBINE_DISABLE_CACHE_CHECK / TURBINE_CACHE_CHECK_SAMPLE. E003 on an
                      unknown mode or key, a non-boolean `advice`, a sample outside (0, 1].
                      Imports only errors.ts. The ONE NODE_ENV reader in the library, with no
                      exceptions: powql.ts's unknown-option advice and no-limit warning go
                      through the client's logger and `diagnostics` since 0.90, and the
                      env-scan test's PENDING allowlist is empty. `advice` gates
                      the builder's advice (`this.advice`), the relations.ts advice
                      (`whereMod.adviceLogger(qi)`), option-surface's unknown-option
                      warning, utils.ts's redundant sort term and prisma-compat's option
                      advice; `cacheCheck` drives the builder's cache cross-check. Explicit
                      `cacheCheck` beats the legacy variables, which beat the mode default;
                      `TURBINE_DISABLE_CACHE_CHECK=1` wins over the sample variable.

  logger.ts        , The pluggable logger (0.90). `TurbineLogger` has optional
                      debug/info/warn/error methods called as `(message, entry)`, a missing
                      method drops the level (`{}` silences Turbine), a throwing method is
                      ignored, and `this` is kept. `TurbineLogEntry` = `{ code, table?,
                      operation?, error?, ... }`. `consoleLogger` prints `[turbine] message`
                      (plus the error when the message ends with ':'), looking `console` up
                      per call. `resolveLogger` is the E003 validator; `logTo` the one send
                      path. No line carries a bound value, whatever `logQueryParams` says.
                      Warn-once dedup is process-wide (a second client's logger does not see
                      a line the first already emitted). `CLIENT_LOG_CONTEXT`
                      (`Symbol.for('turbine-orm.clientLogContext')`) hands the client's
                      logger + diagnostics to prisma-compat. Only this module and seed.ts
                      call `console` directly by design. The types (`TurbineLogger`,
                      `TurbineLogEntry`, `TurbineLogCode`, `TurbineLogLevel`) and the
                      diagnostics types are exported from the package root; the runtime
                      `LOG_CODES` array is not. `src/test/fleet-diagnostics-env-scan.test.ts`
                      enforces both rules (one NODE_ENV reader, one console caller) over
                      `src/` minus `test/` and `cli/`, with a PENDING allowlist (now empty)
                      whose entries must still have a hit. The engine introspectors (sqlite,
                      mysql, mssql) take `IntrospectOptions.logger` and pass it to
                      `deriveEngineRelations`.

  log-codes.ts     , `LOG_CODES`, the closed list of every log `code` (50 at 0.90). The
                      CODE is the stable contract, the message text is not (STABILITY.md).
                      Library code imports it as a TYPE only (`TurbineLogCode`), so an
                      emitter cannot invent a code; the tests import the array, one test per
                      code plus a scan that fails on a code nothing emits.

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
                      `relationLoadStrategy: 'join' | 'batched' | 'auto' | 'flatten'` (client default,
                      overridable per query → query/batched-loader.ts; 'auto' is the 0.41.0
                      implicit default: join plan with per-relation batched fallback on
                      proven-unindexed correlation columns, event tag 'auto-batched',
                      composite-key/unknown relations always stay join), `jsonEncoding: 'object' |
                      'positional'` (lean `json_build_array` wire encoding for `with`
                      subqueries; 0.71: POSITIONAL IS THE POSTGRESQL DEFAULT and is also a
                      PER-QUERY arg on FindManyArgs/FindUniqueArgs. `json_build_object`
                      repeats every key on every row and `json_build_array` does not: server
                      time 0.685ms -> 0.350ms and 152 KB -> 100 KB on the L2 shape, which is
                      the whole of the nested-read gap. Rows are byte-identical, and the
                      value-fidelity `::text` casts survive because `buildJsonRow` drops only
                      the KEYS and passes each expression verbatim. THE DEFAULT AND THE
                      REFUSAL READ ONE CAPABILITY, `dialect.capabilities.positionalJson`
                      (0.90; both read `dialect.name === 'postgresql'` before), deliberately
                      NOT `buildJsonArray` being present: every engine spreads
                      `postgresDialect`, so a presence test hands them all positional (THE
                      INHERITANCE TRAP, see dialect.ts). `buildSelectWithRelations` refuses
                      positional with E017 on that same key, so the default can never select
                      an encoding the builder then refuses; a second question for either
                      would be a second authority, free to drift. The `fm:` and `fu:` cache keys carry a
                      `|je=` segment emitted for BOTH values (never only the non-default one,
                      so the key cannot depend on what the client default happens to be):
                      serving a positional template to an object-expecting parser is SILENT
                      WRONG ROWS, not an error, and the dev-only `crossCheckCache` is what
                      caught it in test, which is exactly why the key segment and not the
                      cross-check is the fix. Two consequences worth knowing: `flatten` on
                      Postgres now falls back for everyone who does not ALSO pass
                      `jsonEncoding: 'object'` (a plan change with no error, warned once), and
                      flipping the default made five assertions VACUOUS, including a PII test
                      matching the JSON KEY literal `/'secret'/` that would have passed with
                      the column fully projected. Assert the COLUMN REFERENCE, which both
                      encodings emit. The strategy-fuzz suite now carries encoding as a
                      differential axis plus an arm exercising all 15 JSON_WIRE_COERCION_OIDS
                      types), and `utcTimestamps` (default true; see parseDbDate
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
                      `replicas` only (external pool = no-op + one always-on warning). ALL config
                      validation now runs BEFORE any process-global side effect, so a throwing
                      constructor cannot leave the parser mode settled. `streamIdleTimeoutMs`
                      (see query/stream-idle.ts) and `sqlComment` (resolved after the other
                      config validation and before any process-global side effect, handed to
                      every query interface as `_sqlCommenter`; `pipeline()` and `runBatch`
                      comment each deferred query with its own model and action, see
                      query/sql-comment.ts) are client options since 0.90. `logger` and
                      `diagnostics` (0.90) are validated FIRST in the constructor; every line
                      the client writes goes through `logTo(this.logger, ...)` with a code from
                      log-codes.ts. Construction warnings (unknown config key, planCacheMode
                      ignored, prepared statements on a pooler, connection option ignored on
                      an external pool) are ALWAYS ON, whatever `diagnostics` says; `logging:
                      true` lifecycle lines go to `debug`. `$listen` reconnect lines moved from
                      console.error to warn (`listen-reconnecting`). A nested
                      `tx.$transaction` callback receives its own `TransactionClient`;
                      `poolerEndpoint` fills an unset host and port from PGHOST / PGPORT
                      before pooler detection; `closableRawClient` (the `$connection()` and
                      raw `transaction()` client) refuses `end` / `connect` and hides
                      `connection`.

  adapters/        , Database adapter layer for Postgres-compatible engines.
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
                      • `capabilities: EngineCapabilities` (0.90), REQUIRED: what the engine
                        can do, one fresh frozen literal per engine
                        (`Object.freeze({ ... } satisfies EngineCapabilities)`), 33 keys:
                        query shape (`distinctOn`, `positionalJson`, `nullsOrderingClause`,
                        `nullsSortHigh`, `insensitiveInList`), value semantics
                        (`jsonDocumentEquality`, `jsonExtractTyped`, `jsonExactNumericCast`,
                        `numericTextComparison`, `enforcesForeignKeys`,
                        `utcTimestampRewrite`, `paramTypeCasts`, `namedEnumTypes`,
                        `structuredValueColumns`), writes (`maxBindParameters`,
                        `maxInsertRows`, `upsertConflictTarget`, `setClauseOrder`,
                        `reselectLocksRows`, `integerDivision`, `updateExpressions`,
                        `bulkUpsertAppliesRepeatedKeys`, `partitionLimitPushdown`),
                        connections and transactions (`readOnlyTransactions`,
                        `connectionParameters`, `backendCancel`, `idleTransactionTimeout`,
                        `abortsTransactionOnError`, `connectionDriver`,
                        `preparesEveryStatement`, `statementSyntax`, which picks the lexer
                        transaction-state.ts screens raw SQL with) and DDL (`inlineForeignKeys`,
                        `unboundedTextKeys`). Every site that asked `dialect.name ===
                        '<engine>'` a capability question reads its key instead, so a
                        dialect built from an engine dialect under another name gets that
                        engine's answers rather than whichever side of a name test its name
                        fell on. A required key is the inverse of an optional hook: adding
                        one fails the build in all five engine files until each states its
                        value, and the spread cannot supply it because each literal is the
                        engine's own. `maxBindParameters(dialect)` reads
                        `capabilities.maxBindParameters` (`Infinity` is no limit), and
                        writes.ts `rowsPerStatement` reads `capabilities.maxInsertRows` (SQL
                        Server 1000; an `onConflict` MERGE is not bound by it).
                        A dialect with no `capabilities` is refused with one E003 by
                        `assertDialectCapabilities` (dialect.ts), which every public entry
                        point that takes a dialect calls: `TurbineClient` (and so
                        `turbineHttp`), `QueryInterface`, `schemaToSQL` and `introspect`.
                        `src/test/capabilities-guard.test.ts` pins every value per engine,
                        requires each engine's object to be its OWN and frozen, builds the
                        same ops under a renamed copy of each engine dialect and requires
                        identical SQL and the same `$transaction({ readOnly: true })`, and
                        SCANS `src/` (whole files, so a wrapped test is found) for every
                        way of testing the name: a comparison or `Object.is`, a switch,
                        `.has` / `.includes` / `.get` / `Object.hasOwn` / `in`, a keyed
                        lookup, a value read off the name, the name destructured or
                        aliased, a dialect bound to a name not ending in `dialect`, and a
                        comparison with, or a collection of, engine-name literals. The
                        allowlist (expr.ts GREATEST / LEAST / now() rendering, schema-sql.ts
                        DEFAULT spelling, error-hint lookups and their keyed maps, three
                        names passed on as error text, two dialects read for transaction
                        keywords, grammar branches inside the statement lexers) pins each
                        entry to a rule and an EXACT site count, so a new site in an exempt
                        file fails, and so does an entry whose sites are gone. The
                        `supports*` flags below are still top-level and inherited; moving
                        them in is 0.91 work.
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
                        (SQL Server `OFFSET/FETCH`; since 0.65 also sqlite + mysql, whose
                        grammars reject a bare `OFFSET` so offset-without-limit emits
                        `LIMIT -1` / `LIMIT 2^64-1` respectively), `buildUpdateStatement`/
                        `buildDeleteStatement` (mid-statement `OUTPUT`), and
                        `buildRelationSubquery` (SQL Server's `FOR JSON PATH` override).
                        `openStream()` and the engines' `DialectIntrospector` round out the
                        seam. `postgresDialect` has NO `introspector` since 0.90:
                        `introspect()` reads the PostgreSQL catalog itself when a dialect
                        has none, and the field reached introspect.ts through a dynamic
                        import that a non-splitting bundler inlines WHOLE, so the catalog
                        reader rode in the serverless entry and every engine entry (about
                        4 to 6 kB brotli each) for a function none of them call.
                      • Value-parity hooks (0.90), each ABSENT on `postgresDialect`, so the
                        spread that builds every engine dialect inherits nothing and a
                        presence test is sound (the inverse of the trap below: an engine
                        opts in by defining the hook on its own dialect, and PostgreSQL's
                        SQL is unchanged). `averageArgument(ref, type)` widens the `AVG`
                        input (MySQL and SQL Server; used by SELECT and HAVING alike in
                        aggregates.ts), because SQL Server averages an INT as an INT and
                        MySQL as a DECIMAL with four more digits. `decodeColumnValue(type)`
                        (SQL Server: json/jsonb, stored as NVARCHAR) is resolved once per
                        column in the row parser's `getCellKinds` and cached per table in
                        `dialectDecodeCache` as a `CELL_DIALECT` cell, so top-level and
                        nested rows decode the same way; it keys on the METADATA type, so a
                        schema introspected from SQL Server (`nvarchar`) still reads text.
                        (The SQL Server row cap of a plain `INSERT ... VALUES` is
                        `capabilities.maxInsertRows`, above.) `checkTextWrite(table, column, columnType, value)`
                        (SQLite only) returns a refusal for a string SQLite's type affinity
                        would store as TEXT in a numeric or boolean column; writes.ts
                        `coerceWriteValue` throws it as E003. Presence-gated, which is sound
                        here because no dialect spreads SQLite's. The type match is anchored
                        on whole type names, since a recorded type can be an enum's name.
                      • `buildEnumColumn(column, labels)` (0.90): MySQL inline `ENUM(...)`,
                        SQLite `TEXT` + CHECK, SQL Server `NVARCHAR` + CHECK over `N'...'`.
                        `schemaToSQL` emits `CREATE TYPE ... AS ENUM` only when
                        `capabilities.namedEnumTypes`; any other engine without the hook
                        gets E017 for an enum column (the inheritance trap again). Off
                        PostgreSQL an undeclared enum or an empty label list is E003, an
                        enum array E017, and a MySQL label with a backslash E003.
                      • `escapeLikePattern` (0.66), per-engine LIKE metacharacter
                        escaping for a bound `contains` / `startsWith` / `endsWith`
                        operand, defaulting to the shared `escapeLike` (the
                        SQL-standard `\` `%` `_`, paired with the `ESCAPE` clause the
                        builders always emit, which names `dialect.likeEscapeCharacter ?? '\'`). SQL Server overrides it because
                        T-SQL's `LIKE` ALSO treats `[` as opening a character class,
                        so `{ contains: '[draft]' }` silently means "contains any one
                        of d, r, a, f, t" there while every other engine reads the
                        value literally. Not injection (the operand stays bound), a
                        WRONG ANSWER, and a property of the engine's pattern grammar
                        rather than of the SQL text, which is what makes it a dialect
                        hook. Whatever a dialect returns must be escaped for its own
                        `likeEscapeCharacter`; the build and cache-hit param-collect
                        paths call the one hook, so they cannot drift.
                      • `likeEscapeCharacter` (0.90), the character `buildLikeClause`
                        (where.ts) names in `ESCAPE '<c>'`; absent on `postgresDialect`,
                        so nothing inherits it, and absent means `\`. MySQL names `!`:
                        in MySQL's default `sql_mode` `'\'` never closes, so every LIKE
                        filter was a syntax error on a caller-supplied pool without
                        `NO_BACKSLASH_ESCAPES` (Turbine sets that mode only on pools it
                        opens, and never runs a session `SET` on a caller's pool). A dialect
                        that sets it must define `escapeLikePattern` for the same
                        character. MySQL's `buildJsonObject` writes a key holding a
                        backslash as `CONVERT(X'<hex>' USING utf8mb4)` for the same reason.
                      • `buildPartitionLimit` (0.66), the per-correlation-key row bound
                        the batched relation loader pushes DOWN into its follow-up
                        query. That follow-up is one flat `WHERE fk = ANY($1)` over
                        every parent's children, so a trailing `LIMIT n` would cap the
                        TOTAL rather than the per-parent count; the hook wraps the
                        compiled child SELECT in `ROW_NUMBER() OVER (PARTITION BY fk
                        ORDER BY …) <= $n` instead. OPTIONAL, and absent means the
                        loader fetches every matching child and slices client-side,
                        which is what every engine did before: correct, but unbounded
                        in bytes over the wire (measured, 200 parents x ~505 children
                        with `limit: 3`, 101,000 rows fetched to keep 600, +52.9 MB
                        peak heap against +0.5 MB for the join plan). PostgreSQL only
                        in this release (gated on `capabilities.partitionLimitPushdown`);
                        the other engines' emitted SQL is unchanged.
                        The client-side slice is KEPT as the belt-and-braces bound and
                        is a no-op once the engine has already limited each partition.
                      • THE INHERITANCE TRAP, and the rule that follows from it: EVERY
                        engine dialect is built by SPREADING `postgresDialect`
                        (`...postgresDialect` in sqlite.ts / mysql.ts / mssql.ts /
                        powdb.ts), so an optional hook added to the Postgres dialect is
                        INHERITED by all of them and an "is the hook absent" fallback
                        NEVER FIRES. Hit live: the first `buildPartitionLimit` silently
                        enabled the window wrapper on SQLite. It is the same trap
                        behind the `DISTINCT ON` blocker. So ask a capability question
                        of `dialect.capabilities` (add a key to `EngineCapabilities` and
                        set it in every engine's literal), never of hook presence and
                        never of `dialect.name`: a name test hands a PostgreSQL-compatible
                        dialect under another name the non-PostgreSQL answer, and the
                        capabilities guard test refuses a new one. `dialect.name` is left
                        for RENDERING (which SQL text an engine spells), error text and
                        the lexers, each allowlisted with its reason. Those rendering
                        switches become per-engine hooks once engines stop spreading
                        `postgresDialect` (0.91).

  sqlite.ts        , `turbine-orm/sqlite` engine. `turbineSqlite(path | ':memory:' |
                      DatabaseSync, schema, options?)`, synchronous, zero new dependency
                      via Node's built-in `node:sqlite` (Node ≥ 22.5; `better-sqlite3`
                      documented fallback). `sqliteDialect` uses `resultStrategy:
                      'returning'`, `json_group_array(json(...))` nested relations, and
                      `COLLATE NOCASE` (ASCII-only) for insensitive matching. The
                      in-process test / edge / "try it in 10 seconds" engine. Since 0.90 a
                      column the SCHEMA declares boolean or json/jsonb reads back as a
                      boolean / parsed value on every read path. The direct-read half is
                      `resultColumnDecoders`, which reads `StatementSync.columns()` (declared
                      type plus origin table and column, all null for an expression, so a
                      computed column is never decoded) and so needs Node 22.16+ / 23.11+;
                      it is feature-detected, and on the band without it the columns keep
                      reading as stored. The join half is the boolean / json `jsonWireRule`,
                      gated on `driverReportsDeclaredTypes()`, the SAME capability question,
                      so the two halves cannot split into a strategy-dependent type flip.
                      REAL / NUMERIC through a join are carried as `printf('%!.17g')` text
                      and rebuilt (`json_object` rounds to 15 digits on SQLite 3.47 to 3.51).
                      A safe integer binds as INTEGER (node:sqlite binds every JS number as
                      REAL), so integer `divide` truncates and `3` written to TEXT is
                      `'3'`. Since 0.90 `disconnect()` / `end()` close a handle the factory
                      OPENED (path or `':memory:'`; a later query is E004), and the factory
                      closes it if the constructor or the open-time PRAGMAs throw; a
                      `DatabaseSync` the caller passed is never closed. `turbineMysql`,
                      `turbineMssql` and `turbinePowDB` likewise close a pool (or embedded
                      handle) they built when a later step throws (version refusal, an
                      embedded `syncMode` the addon cannot apply, constructor refusal).

  mysql.ts         , `turbine-orm/mysql` engine. `await turbineMysql(url | config |
                      mysql2-pool, schema, options?)`, MySQL 8.0+ via the optional peer
                      `mysql2` (loaded by dynamic import; never a root dep). `mysqlDialect`
                      uses `resultStrategy: 'reselect'` (no RETURNING, write then re-SELECT
                      by PK/where), `JSON_ARRAYAGG`/`JSON_OBJECT` nested relations, and
                      named `:pN` placeholders. A plain `createMany` returns `[]`
                      (count-not-rows); one with `onConflict` re-reads its rows by the
                      conflict key. A `create` re-reads by an exactly known key or is
                      refused with E017 before the INSERT (see writes.ts), and introspection
                      marks an `AUTO_INCREMENT` column `isGenerated` (0.90), so the insert id
                      is used even when another column also has a default. `averageArgument`
                      gives `_avg` over a non-BIGINT integer full double precision
                      (`+ 0E0`); BIGINT keeps its exact DECIMAL average. LIKE escapes with
                      `!` (`likeEscapeCharacter`, see dialect.ts), so an injected pool works in
                      any `sql_mode`; the owned pool still sets `NO_BACKSLASH_ESCAPES`, which
                      only raw SQL now depends on.

  mssql.ts         , `turbine-orm/mssql` engine. `await turbineMssql(url | config |
                      mssql-pool, schema, options?)`, SQL Server 2016+ via the optional
                      peer `mssql` (dynamic import). `mssqlDialect` uses `resultStrategy:
                      'output'` (`OUTPUT INSERTED.*` / `MERGE`), `FOR JSON PATH` nested
                      relations (`buildRelationSubquery` override), `OFFSET/FETCH` paging,
                      and named `@pN` placeholders. 0.90: `capabilities.maxInsertRows: 1000` (a larger
                      `createMany` is chunked in one transaction instead of throwing),
                      `decodeColumnValue` parses json/jsonb, and `averageArgument` makes
                      `_avg` over an integer fractional (FLOAT, or DECIMAL(38,0) for BIGINT
                      so the average stays exact).

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
                      surface as `QueryInterface`, enforced since 0.90 by `implements
                      TableClient`, see query/table-client.ts) wired in via the `queryInterfaceFactory`
                      option on `QueryInterfaceOptions`, `TurbineClient.table()` calls that
                      factory when present, else `new QueryInterface` (SQL engines untouched).
                      powdb.ts holds the driver shims (`PowdbPool` over the client `Pool`;
                      `PowdbEmbeddedPool` over a single `Database` handle), type mapping
                      (Turbine→PowQL `str/int/float/bool/json`; never emits `uuid/datetime/bytes`;
                      `Date`→int micros; an enum column of `schema.enums` → `str` holding the
                      label, via `powdbEnumLabels` in powdb-shared.ts: a non-label is E003,
                      ranges compare in declaration order, ordering it is E017), `powqlSchemaDDL`, `wrapPowdbError`, and `powdbDialect`
                      (`supportsReturning: true`; the Postgres-only flags stay false →
                      `$listen`/`$notify`/RLS/pgvector throw E017). PowDB realities shaping it:
                      writes use the trailing **`returning`** keyword (create/createMany/update/
                      delete), `upsert` reselects by PK (its statement rejects `returning`; a
                      **upsert** follows the shared `upsertWhereMatchesCreate` rule; only a single-column-PK `where` pinned to `create`'s value, with a non-empty `update`, no nested writes and no global filter, uses the native statement. Every other shape looks the row up BY `where` in one flat txn via `upsertLookupFirst` (0.81: it used to take the values from `create`), which is also what keeps a tenant-scoped upsert off another tenant's row; since 0.90, when `where` is pinned to `create` and the lookup misses only because the global filter hides the row, `hiddenConflictIsNotFound` makes it E001 and writes nothing, as on the SQL engines, instead of E008).
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
                      broken the 0.22.0 hasMany/belongsTo filters). Since 0.90 relation filters
                      INSIDE a global filter resolve the same way (`globalFilterWhere`), function
                      filters that reach each other once per chain; they used to make every query
                      on the table E003. A number, bigint or boolean against a Date column is E003
                      (it bound as raw micros), and a whole JSON document in a `where` is E017.
                      **Nested writes** (relation ops in
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

  powdb-shared.ts  , The PowDB engine's zero-cycle LEAF, the same shape pg-types.ts and
                      connection-url.ts use for client.ts / query/. Holds the primitives all
                      three PowDB modules need: identifier quoting (`quotePowqlIdent` /
                      `quotePowqlDotted` over `POWQL_KEYWORDS`), capability gating
                      (`PowdbCapabilities`, `ALL_POWDB_CAPABILITIES`, `requireCapability`),
                      type mapping (`PowqlType`, `powqlColumnType`, `isJsonColumn`,
                      `isPowdbDatetimeColumn`), value coercion (`coerceValue`,
                      `coerceNativeValue`, `rowToEntity`), the `PowdbFloatParam` /
                      `PowdbJsonParam` bind markers, and `isStaleFramePowdbError`. It imports
                      errors.ts and schema.ts and NOTHING else, which is the whole point:
                      powdb.ts re-exports `PowqlInterface` and `introspectPowdbDatabase` while
                      both of those imported the primitives back from it, so the three were a
                      runtime SCC in the largest engine entry, where an initialization-order
                      bug is hardest to trace. `scripts/check-import-cycles.mjs` pass 2 now
                      fails on any cycle under `src/` and its allowlist is EMPTY.
                      powdb.ts re-exports every previously public name EXPLICITLY, never with
                      `export *`, and that distinction is load-bearing: the leaf also exports
                      `isDateColumn` for powdb.ts's own parameter encoder, and a star
                      re-export puts it on the published `turbine-orm/powdb` surface (measured,
                      it was the one key that differed). The subpath's exports are otherwise
                      byte-identical to before the split, 34 runtime keys and 44 declared
                      names.

  errors.ts        , Error hierarchy rooted at TurbineError. Each error has a code
                      (TURBINE_E001-E020). wrapPgError() translates pg driver errors
                      (23505, 23503, 23502, 23514, 23P01, 40P01, 40001) into typed
                      Turbine errors. 0.90: 42P05 and 26000 (a named prepared statement
                      the server connection already holds, or never prepared, which is
                      what a transaction-pooling endpoint produces) are `ConnectionError`
                      (E004) carrying `sqlstate` and `PREPARED_STATEMENT_POOLER_HINT`
                      (direct endpoint, `preparedStatements: false`, or PgBouncer 1.21+
                      with `max_prepared_statements` above 0). `TimeoutError.outcome` is
                      `'not-executed'` (never sent, or the server confirmed the cancel:
                      safe to retry) or `'unknown'` (the default, the only answer never
                      wrong); see the timeout note under builder.ts. 25P02 (in failed
                      transaction) maps to `TransactionRolledBackError` (E019) as a fallback;
                      25P03 (idle_in_transaction_session_timeout, which a cursor stream sets
                      transaction-locally, see query/stream-idle.ts) is `ConnectionError` (E004);
                      the transaction state normally refuses that statement before it is sent. UnsupportedFeatureError (E017) is thrown directly
                      (not via wrapPgError) when a non-Postgres engine hits a Postgres-only
                      feature. 0.65: every TurbineError carries `.docsUrl`
                      (`https://turbineorm.dev/errors#eNNN` via docsUrlForCode) and
                      formatErrorMessage suffixes the message with that link ONCE,
                      idempotently (skipped when a `turbineorm.dev/errors#` link is already
                      in the text, so rewrapping never duplicates it). The errors page has an
                      `<a id="eNNN">` anchor per code; src/test/error-docs-sync.test.ts fails
                      the unit lane when a code has no docs row/anchor or a row outlives its
                      code. Message TEXT stays non-contract (STABILITY.md); the code tag and
                      `.docsUrl` are the stable parts.

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
                      or unlocked by the `includePii: UNSAFE` read arg. Enforced AT THE
                      SQL LEVEL on every engine (see the write projection below), with
                      parseWriteRow's strip as defense-in-depth.
                      (2) AGGREGATES: two shapes are REFUSED without `includePii: UNSAFE`
                      (ValidationError E003 naming the column): a PII column used as a
                      groupBy `by` key INCLUDING a JSON-path group key (the keys ARE the
                      values), and _min/_max over a PII column in BOTH groupBy and
                      aggregate INCLUDING JSON-path targets (they return a row's stored
                      cell). ALLOWED with no opt-in: _count (a count, not a value) and
                      _sum/_avg (computed across many rows, not a stored cell; the
                      single-row group is a known theoretical edge, the gate is
                      deliberately narrow). `includePii?: Unsafe` is a field on
                      FOUR arg interfaces: FindManyArgs, FindUniqueArgs, GroupByArgs
                      and AggregateArgs
                      (query/types.ts); with it set the emitted SQL is byte-identical to an
                      untagged schema. IT IS NOT A BOOLEAN: like `skipGlobalFilters` and
                      `allowFullTableScan` it is a PRIVILEGE option and its only accepted
                      value is the `UNSAFE` symbol exported from the package root
                      (`Symbol.for('turbine-orm.UNSAFE')`); `includePii: true` throws E003.
                      The reason is mass assignment: all three options are ordinary
                      siblings of `where`, so `findMany({ ...req.body })` let a REQUEST
                      BODY turn them on, and JSON.parse cannot produce a symbol. Applies on
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
                      `ColumnMetadata.declaredTsType` (0.90) carries a `defineSchema` `tsType`
                      (without `| null`) and ONLY `turbine generate` reads it; `tsType` stays
                      the type mapped from the database type, because every engine branches
                      on it. A declared type used to replace `tsType` in the metadata the
                      engines read, so embedded PowDB created integer, timestamptz and
                      boolean columns as strings and MySQL read a nested boolean as `1`.

  schema-builder.ts, defineSchema() API for code-first schema definitions. Produces
                      SchemaDef objects consumed by schema-sql.ts for DDL generation. Every
                      refusal of a malformed declaration is `ValidationError` (E003) since
                      0.90 (nine threw a plain `Error`: an unknown column type, an enum
                      with no `enumName`, a vector with no `dimensions`, a non-array
                      `indexes` / `manyToMany` / `checks` / `primaryKey`, a composite
                      primary key naming no column, an unknown type on the deprecated
                      `column` proxy). It also refuses an unknown key naming the nearest
                      valid one, a `__proto__` table or column, an index with both `columns`
                      and `docField`, and a `tsType` that is not one TypeScript type on one
                      line (`tsTypeTextProblem`, which generate.ts also applies to
                      `columnTypes`, since the text is emitted verbatim into source).
                      An integrity pass (0.90) refuses names it cannot resolve: a `references`
                      not in `table.column` form, or naming a column its in-schema target
                      lacks (a field name resolves to its column; a table outside the schema
                      is left alone), an index naming an unknown column, and two fields or
                      two tables mapping to one database name. `default` takes a number or
                      boolean as a literal; any other non-string default is E003.

  schema-metadata.ts, `defineSchema()` -> `SchemaMetadata` bridge (`schemaDefToMetadata`).
                      The pure-function equivalent of introspect + generate, for the paths
                      that have a SchemaDef and no live SQL database: PowDB, in-memory
                      SQLite bootstraps, tests. Same output shape the query builder,
                      TurbineClient and the non-SQL engines already consume.

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
                      DETERMINISM IS A CORRECTNESS REQUIREMENT HERE, not tidiness
                      (0.66): every catalog query carries an explicit ORDER BY, and the
                      FK query orders by (source table, constraint name), never
                      `con.oid`. Relation NAMES are resolved by walking FKs and claiming
                      names as they go, so creation order used to decide which of two
                      competing relations won a name AND its cardinality, meaning a
                      database restored from a dump and one built from migrations
                      disagreed about what `with: { profile: true }` returned. The FK
                      query also filters `con.conparentid = 0`: a partition CLONE of a
                      declared FK is a real `pg_constraint` row, so one declared foreign
                      key to a 2-partition table used to emit three belongsTo relations,
                      two of which resolve to null for most rows. `deriveCatalogRelations`
                      is THE single derivation seam, consumed by both `turbine generate`
                      and `cli/mcp.ts`, and its catalog inputs are REQUIRED parameters:
                      they were optional, MCP omitted two of them, and the two surfaces
                      silently disagreed about cardinality and about m2m entirely.

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

  prisma-compat.ts , `turbine-orm/prisma-compat` subpath (0.41): typed
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
                      Nothing is accepted and dropped (0.90): a filtered `_count` and a nested
                      `distinct` / `cursor` are E017; an unknown nested option (Turbine's
                      `limit` / `offset` / `with` included), an unknown `_count` key, an
                      unknown `$transaction` option, an unread nested-write key, and a
                      projection on a relation outside the map are E003. The array-form
                      `$transaction` forwards its options; `maxWait` is accepted, not
                      forwarded, and warned once. Its advice goes through the client's
                      logger via CLIENT_LOG_CONTEXT, gated on `diagnostics.advice`; the
                      stale-map check is always on.
                      Pure shim: zero new deps, never imported by core.

  errorMessages scoping, `errorMessages: 'safe' | 'verbose'` is a property of the
                      CLIENT, not of the last constructor to run (0.66). The mechanism is
                      an AsyncLocalStorage scope carrying that client's mode, established
                      around each operation, with a process-wide `clientModesDiverged`
                      fast path so a single-client app establishes no scope at all. TWO
                      rules keep it honest, and both were violated by the first cut.
                      (1) The divergence test belongs at CALL time, inside the accessor
                      wrapper, never at accessor-CREATION time: divergence is a property
                      of the process over TIME, so a delegate hoisted at module load
                      (`const users = db.users`) before a second client is constructed
                      stayed unscoped forever, and the SAFE client was the one that
                      leaked. The `table()` proxy is therefore built unconditionally.
                      (2) The scope must reach the EXECUTION, not the call. `client.sql`
                      returns a LAZY `TypedSqlQuery`, so wrapping the tagged-template
                      call opened and closed the scope before a row was fetched: it
                      compiled, ran, and protected nothing. The mode is passed to the
                      builder as the `runScoped` constructor parameter instead. Entry
                      points that must scope: table accessors, `$transaction`, `raw`,
                      `pipeline`, and `sql`.

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
                      0.80: a lost LISTEN connection reconnects with exponential backoff
                      (`ListenOptions`: reconnect / onError / onReconnect), default on;
                      NOTIFY is not durable, so onReconnect is the caller's cue to resync.

  engine-config.ts , The client-config seam for EVERY non-default engine factory
                      (`turbine-orm/sqlite`, `turbine-orm/mysql`, `turbine-orm/mssql`,
                      and since 0.75 `turbine-orm/powdb`).
                      Each builds its own driver pool and then hands a TurbineConfig to
                      TurbineClient; each used to list the keys it forwarded BY HAND, which
                      made the forwarded set an allowlist and quietly stranded every option
                      added afterwards (that is how `errorMessages` and later
                      `logQueryParams` became Postgres-only). `EngineClientConfig`
                      inverts the default: every TurbineConfig field is forwarded unless
                      named as excluded. Type declarations only, so it emits no runtime code
                      and is excluded from coverage.
                      THE RULE IS THE FACTORY'S, NOT THE TYPE'S, and 0.75 is what that
                      distinction cost: PowDB extended a four-key `Pick` AND hand-listed the
                      same four keys into `new TurbineClient`, so `globalFilters` reached
                      neither. The 0.74 fix that taught `PowqlInterface` to apply global
                      filters was verified against a recording pool one level BELOW the
                      drop, and shipped unreachable through the public factory. A factory
                      converts by extending this type and DESTRUCTURING its own transport
                      keys out of `options` before spreading the rest, never by listing what
                      goes in. `turbineHttp` (serverless.ts) is the same shape with a
                      different exclusion set, `Omit<TurbineConfig, 'pool'>`: it binds no
                      dialect and pins no prepared-statement mode, so it has no business
                      narrowing those away. Its allowlist was type-only (the runtime already
                      spread everything), which is the kind failure mode: a compile error on
                      a working option rather than a silent drop.

  seed.ts          , `defineSeed()` and the runner behind `turbine seed`. Loads the user's
                      seed module, opens a TurbineClient for it, and awaits the callback.

  prisma-schema-fingerprint.ts, Staleness detector for the `PRISMA_MAP` that
                      `turbine migrate-from-prisma` emits and `turbine-orm/prisma-compat` is
                      driven by. Nothing re-runs the generator, so a model added or a field
                      renamed in schema.prisma leaves the map describing a schema that no
                      longer exists, and the adapter simply has no entry for the new names.
                      The fingerprint makes that drift detectable instead of surfacing as
                      "this model is not on the compat client".

  cli/sql-statements.ts, THE one SQL tokenizer (0.66), a pure leaf with ZERO imports,
                      shared by the destructive-migration guard, `schemaPush`, the
                      statement splitter, and the embedded-transaction refusal. Returns
                      per statement three views from ONE walk: `raw` (verbatim, what
                      executes), `stripped` (comments removed AND literals emptied, what
                      the destructive RULES match), and `code` (comments removed,
                      literals kept, which is what dynamic SQL needs since the payload
                      lives IN a literal). Two lexers is how the guard came to disagree
                      with the runner about what a file contained, so a second one is
                      never the answer. It must lex the way PostgreSQL does, and the
                      three places that turned out not to: block comments NEST; `$` is a
                      legal identifier CHARACTER, so `x$y$` is one identifier and not a
                      dollar-quote opener (getting this wrong swallowed whole files);
                      and `BEGIN ATOMIC` bodies do not end at their inner semicolons.
                      Every ambiguity resolves toward SHOWING MORE, because both
                      consumers are refusal gates and under-splitting is a silent accept.

  cli/             , CLI entry point and commands (see CLI Architecture below).
```

## Site at site/

This repo ships the library **and** its marketing/docs site. The site lives at `site/` (a standalone Next.js 15 App Router project with its own `package.json` and `node_modules`) and deploys to `turbineorm.dev` via the Vercel project `zvn-dev/turbine-docs`.

- Library work stays in `src/`. Site work stays in `site/`. Don't cross the streams.
- Every release updates **both** surfaces in a single commit: library + `site/` + `CHANGELOG.md` + version bump, landed through a PR. The `vX.Y.Z` tag then publishes to npm via `release.yml`, and Vercel deploys the site from `main` on push.
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

**Atomic updates** (query/types.ts): `UpdateOperatorInput<V>` supports `set`, `increment`, `decrement`, `multiply`, `divide` for numeric fields. These generate `col = col + $n` style SQL for concurrent safety. `divide` on an integer column truncates on every engine (0.90: MySQL emits `DIV`, and SQLite binds a safe integer as INTEGER).

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
| E002 | `TimeoutError` | Query or transaction exceeds timeout. Carries `outcome`: `'not-executed'` or `'unknown'` (0.90) |
| E003 | `ValidationError` | Unknown column, invalid operator, empty where guard |
| E004 | `ConnectionError` | Pool connection failure. Since 0.90 also pg 42P05 / 26000, a named prepared statement behind a transaction pooler, with the pooler advice |
| E005 | `RelationError` | Unknown relation name in `with` clause |
| E006 | `MigrationError` | Migration file parse error, checksum mismatch |
| E007 | `CircularRelationError` | Nesting depth exceeds 10 |
| E008 | `UniqueConstraintError` | pg 23505, via `wrapPgError()` |
| E009 | `ForeignKeyError` | pg 23503, via `wrapPgError()` |
| E010 | `NotNullViolationError` | pg 23502, via `wrapPgError()` |
| E011 | `CheckConstraintError` | pg 23514, via `wrapPgError()` |
| E012 | `DeadlockError` | pg 40P01, `isRetryable = true as const` |
| E013 | `SerializationFailureError` | pg 40001, `isRetryable = true as const`. Subclass `LockNotAvailableError` (same code, retryable): a `lock` read with `noWait`, or a lock wait past the server's lock timeout (pg 55P03, MySQL 3572 / 1205, SQL Server 1222); on PostgreSQL it aborts the transaction, so take the lock in a nested `tx.$transaction` to recover |
| E014 | `PipelineError` | One or more queries in a pipeline batch failed |
| E015 | `OptimisticLockError` | Version mismatch on `optimisticLock` update |
| E016 | `ExclusionConstraintError` | pg 23P01, via `wrapPgError()` |
| E017 | `UnsupportedFeatureError` | A Postgres-only feature (pgvector, LISTEN/NOTIFY, RLS `sessionContext`) invoked on an engine whose capability flag reports it unsupported, thrown directly, not via `wrapPgError()` |
| E018 | `ReadOnlyError` | A write refused because the database is read-only, `reason: 'snapshot'` (PowDB snapshot serving / client-level `readonly: true` fail-fast) or `'rbac'` (read-only role). Thrown locally by the PowDB readonly guard and via `wrapPowdbError()` message families |
| E019 | `TransactionRolledBackError` | A transaction PostgreSQL rolled back instead of committing (the callback caught a failed statement, or a per-query timeout cancelled one); the first failure is `cause`. Deadlock, serialization and lock-not-available first failures keep their own class. Built by `rolledBackError` in transaction-state.ts; pg 25P02 also maps here via `wrapPgError()` as a fallback |
| E020 | `InvariantError` | Turbine caught a bug in itself before sending a statement it knew was wrong: two internal paths that must agree did not (the SQL-template cache vs a fresh build, `invariant: 'sql-cache-lockstep'`; a cached entry whose param count differs from the params collected, `'sql-cache-param-count'`; a where scope built from an already-quoted reference, `'where-scope-reference'`; a relation payload that does not parse as JSON, `'relation-payload-json'`, both formerly E003; and in powql.ts a relation filter reaching `buildWhere` unresolved, `'powql-relation-filter-unresolved'`, a JSON string operator with no PowQL spelling, `'powql-json-operator'`, and a JSON filter that compiled to no condition, `'powql-json-filter-empty'`, formerly E003 with an `internal:` prefix; since 0.90.1 also any field filter that compiled to no condition, `'powql-filter-empty'`, which used to fall back to an always-false condition that `NOT` turned into every row). Thrown by the always-on cache prechecks in query/builder.ts, `aliasWhereScope` in where.ts, `parseNestedRow` in relations.ts and the three PowQL generator sites. Not retryable, not caused by the arguments; the message names the query shape and no value |

`wrapPgError(err)` inspects the pg driver error's `.code` field and wraps it in the appropriate typed error, preserving the original as `.cause`. It is called in `client.ts` (raw queries, transaction pool proxy) and at query execution boundaries in `query/builder.ts`.

## CLI Architecture

The CLI (`src/cli/index.ts`) uses a zero-dependency argument parser on `process.argv`. No commander/yargs. Commands: `init`, `generate`/`pull`, `push`, `migrate create|up|deploy|down|status` (`deploy` is `up` with no prompts, for CI), `seed`, `status`, `doctor` (missing-FK-index advisor → `index-advisor.ts`; `--fix` writes an add-index migration; cached-plan divergence section → `plan-divergence.ts`, finding-only, `--no-plan-divergence` skips it and its pg_stats read; since 0.57 an `unindexed-filter` finding renders as EVIDENCE on the missing-index finding for the same column (`attachDivergenceToMissingIndexes` / `renderDivergenceEvidence`) rather than as a second entry, and the remediation text names `forceCustomPlan` without assuming the reader holds the core client or prisma-compat), `migrate-from-prisma` (0.41: zero-dep schema.prisma subset parser in `cli/prisma-schema.ts`, live-metadata resolver in `cli/prisma-resolve.ts`, Markdown report via `cli/prisma-report.ts`, emits the typed PRISMA_MAP module `generate.ts` also regenerates; `--no-db` parse-only mode), `studio`, `mcp` (read-only MCP server over JSON-RPC stdio -> `cli/mcp.ts`; ELEVEN tools as of 0.71, the newest being `compile_query` -> `cli/compile-query.ts`, which compiles a read query to the exact SQL WITHOUT executing it. Zero pool interaction is guaranteed by construction via `SEALED_POOL`, a `PgCompatPool` whose `query`/`connect`/`end` all throw; the one database access is the catalog read that resolves names, since a column cannot be validated against a schema nobody has seen. It reports statement count, chosen relation strategy, whether the query is bounded or reads every row, and unindexed correlation probes. `auto` reports its statement count as `null` with a stated RANGE rather than duplicating `planAuto`'s decision in cli/, which is the drift class this repo keeps paying for. A failed compile is a SUCCESSFUL result carrying E003/E005 and the fix, because that is the most useful outcome for an agent. Read operations only: the server has no write surface and compiling one would be the first. Args go through the shared `cli/pii-predicate-guard.ts` exactly as `explain_query` does), `observe` (metrics dashboard, requires TURBINE_OBSERVE_URL -> `cli/observe.ts`),
`skill` (0.73: writes `skills/turbine-orm/SKILL.md` from the PACKAGE into
`.claude/skills/` by default; `--print` to stdout, `--agents` for the AGENTS.md block,
`--dir` for another skills root. The skill is a shipped FILE, not generated text, and
`skills` is in package.json `files`; `evals/src/verify-skill.ts` executes every factual
claim in it against a live database and names the sentence to change when one moves,
which exists because the previous copy asserted a snake_case column name was rejected in
`orderBy` and the next release made that false).

**Config resolution** (`cli/config.ts`): Searches for `turbine.config.ts` / `.mts` / `.js` / `.mjs`, merges with `--url`/`--out`/`--schema` flags and `DATABASE_URL` env var.

**Migration system** (`cli/migrate.ts`): SQL-first migrations stored as timestamp-prefixed `.sql` files with `-- UP` and `-- DOWN` sections. CI gates (0.90): `push --dry-run --exit-code` exits 2 on a statement OR on a drift warning it cannot apply (`driftWarnings`: a declared UNIQUE index over a non-unique one of that name, a removed enum label, an undeclared index on a table that manages its indexes), while disclosed not-compared items and a named CHECK that differs only by PostgreSQL's rewrite of the expression stay 0; `migrate status --exit-code` exits 2 on a pending, modified, missing or MISNAMED migration file. `generate` refuses a `columnTypes` key naming no table with a did-you-mean, and with `include` set it reads the table list once (`generatorColumnTypesFor`) so a typo is not mistaken for a table the filter left out. Tracked in a `_turbine_migrations` table with SHA-256 checksums. Uses `pg_try_advisory_lock()` to prevent concurrent migration runs. Each migration runs in its own transaction. Checksum validation detects modified migration files. Destructive statements (both `migrate up`/`down` and, since 0.36, `push`) require a two-step typed confirmation (`destroy my data` then `yes`) or `--allow-destructive`. `migrate create <name> --recipe backfill` (0.36) scaffolds the sanctioned two-phase type-change pattern from the MIGRATION_RECIPES registry (fully commented: nullable add → batched keyed UPDATE → SET NOT NULL → atomic rename swap); `--recipe` without a name errors.

**Studio** (`cli/studio.ts`): Local web UI served over Node's built-in `http` module, no new runtime deps, read-only by default. ORM-native since v0.19: there is NO raw-SQL surface. The Query tab (default) is a visual `findMany` builder; `POST /api/builder` validates every identifier (table/relation/field/orderBy) against the introspected schema and compiles the args with `QueryInterface.buildFindMany` (`sqlCache: false`, all values as `$N` params). Saved queries are builder-kind only, legacy raw-SQL entries are dropped on load with a console notice. Binds `127.0.0.1` by default (warns loudly on non-loopback hosts), authenticates via a random 24-byte hex token (constant-time check on every `/api/*` route), per-session rate limiting (100 req/60s), refuses cross-origin requests, and ships nonce-based CSP + security headers (`script-src 'self' 'nonce-...'`, no unsafe-inline in script-src since 0.36; style-src keeps it; `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`). Every read runs inside `BEGIN READ ONLY` with `SELECT set_config('statement_timeout', $1, true)` (NOT `SET LOCAL ... = $1`, which Postgres rejects, that was the 0.17.0 critical bug) and `set_config('search_path', $1, true)` pinned to the configured `--schema`. **Write mode (0.36, `--write`; bulk since 0.38):** `/api/row/update|insert|delete` POST routes exist ONLY when writable (404 otherwise, deliberately not 403); each rebuilds the predicate from the FULL primary key alone via `extractPkWhere` (extra where keys dropped, operator objects refused, PK-addressed by construction), validates table/columns against metadata, compiles via buildUpdate/buildCreate/buildDelete (`sqlCache: false`), runs in a plain BEGIN txn with the same parameterized timeout + search_path, and requires a matching `Origin` (absent OR mismatched → 403). insert/delete also accept `rows: [...]` (MAX_BULK_ROWS=500): per-row validation up front, one statement per row in ONE all-or-nothing txn (any no-match → ROLLBACK + 404); bulk update refused; predicate-based mutations never exist. Views and PK-less tables refused. Loud startup warning + persistent red WRITE MODE banner. **PII redaction:** PII-tagged cells are redacted SERVER-SIDE ("•• redacted ••") before serialization, table rows, builder rows, nested `with` rows (redactBuilderRows walks the tree against each relation's target table), and the post-write echo; redacted columns are also excluded from the Data-tab ILIKE search OR-set, orderBy, AND the per-column `filters` param (even isNull, null-ness is an oracle too; parseTableFilters 400s). The Data tab's `filters` (JSON array, max 10, ops equals/not/contains/gt/gte/lt/lte/isNull/notNull) compile via a param-counter buildWhere shared with search, engine-aware placeholders. `--show-pii` reveals (terminal warning + persistent PII SHOWN banner). DB-less perimeter tests drive the exported `handleRequest` (src/test/studio-write.test.ts). **Temporal parity (0.54):** Studio builds a RAW pg pool and never constructs a TurbineClient, so it used to keep the driver's local-zone parsers and render a `date` cell as the previous evening east of UTC, which in `--write` is also the value an edit echoes BACK into the column; the Postgres path (never demo, which is sqlite) now calls `registerUtcTemporalParsers()` from query/utils.ts, the same helper client.ts uses. `cli/mcp.ts` does the same for its sampled rows. **Demo mode (0.37, `--demo`):** boots with NO DATABASE_URL against a seeded in-memory store (`cli/studio-demo.ts`: DEMO_SCHEMA users/posts/comments/orgs with pii-tagged email/phone + deterministic seed) backed by the sqlite engine over `node:sqlite` `:memory:` (Node >= 22.5, dynamic import with a clear error). `StudioContext.demo` + `dialect` branch the few PG-isms (pg_class counts → COUNT(*), ILIKE → LOWER LIKE, no BEGIN READ ONLY/set_config/search_path, `:pN` placeholders, `parseDemoRelationRows` re-parses sqlite's JSON-string relation columns); `POST /api/demo/mode` (demo-only, token+Origin gated) flips ctx.writable/ctx.showPii live for the UI's two toggle pills; boots read-only + redacted; each launch pristine, nothing persisted (saved queries too: demo routes them to ctx.memorySavedQueries, never .turbine/studio-queries.json, and never reads the real file). Postgres path byte-identical when off; tests in src/test/studio-demo.test.ts drive the REAL in-memory store through handleRequest. UI is an embedded single-file HTML/CSS/JS (`studio-ui.html`, prebuilt into `studio-ui.generated.ts` by `npm run gen:studio`) with Query / Data / Schema tabs matching the turbineorm.dev dark theme.

**PII predicate guard** (`cli/pii-predicate-guard.ts`): a pure leaf module (same role as `cli/rate-limit.ts` and `cli/destructive.ts`), the ONE walker that decides whether caller-supplied `findMany` args filter, sort, page, or de-duplicate on a hidden column. Studio's `/api/builder` and the MCP server's `explain_query` both run their args through it before the builder sees them; they supply only what genuinely differs, a `hiddenReason(table, column)` policy (Studio: a code-first `pii` tag unless `--show-pii`; MCP: that plus a secret-looking column NAME) and `refuseColumn` / `refuseDepth` / `refuseShape` callbacks that throw their own error type. It was two independently written copies with the same name and the same job, and they had drifted into the same hole. Walks `where` / `orderBy` (object AND array form) / `cursor` / `distinct`, boolean combinators, the relation-filter wrappers (`some`/`none`/`every`/`is`/`isNot`), the pick-row ordering shape (`pick.orderBy`, `pick.where` and the target column named in `by`'s VALUE, including the `{ field, path }` JSON form), `{ col }` column references in operator OPERANDS, and each `with` level against that relation's target. `select` / `omit` are deliberately allowed: they return values, and the values are redacted on the way out. It FAILS CLOSED in three places, and that posture, not the individual keys, is the rule: past `PII_GUARD_MAX_DEPTH` (32), on an unrecognized OBJECT-VALUED key under a relation, and on an unrecognized object-valued query-level arg. A scalar-valued unknown key is deliberately left to the builder, so a plain typo still reads as a typo (E003 by name). `isPickShape` MIRRORS `isRelationPickOrderBy` in `query/filters.ts` exactly, including its requirement that `pick` be an object carrying `orderBy`, because the builder branches on that predicate and a guard that answered it differently would be guarding a different query than the one that runs.

**UI module** (`cli/ui.ts`): Terminal formatting helpers, colors, spinners, tables, boxes. Imported throughout CLI but never by library code.

**Other CLI leaves**: `cli/local-server-output.ts` is the leaf both local servers share for what they emit: `responseErrorText` (an `Error` gives its message only, with its aggregated messages, cause or code when the message is empty; a non-Error gets a fixed sentence, never `stack` or `String(err)`) and `openInBrowser`, which launches only a plain `http` URL of the exact shape the servers print, so `--host` cannot put shell syntax in front of `cmd /c start`. `cli/loader.ts` registers a TypeScript loader (prefers `tsx/esm/api`'s `register()`, probed from the user's CWD) before the CLI `import()`s a user-supplied `turbine.config.ts` / schema file, which plain Node rejects with `ERR_UNKNOWN_FILE_EXTENSION`. `cli/pii-tags.ts` reads `ColumnMetadata.pii` out of the generated `metadata.ts` and applies it to a LIVE introspected schema: `pii` is a code-first declaration that `introspect.ts` never sets, so without this Studio's and the MCP server's redaction would be inert against a real database; it distinguishes "this file declares no PII" from "this file could not be parsed" (`PiiScan.ok === false`), and the latter fails closed by tagging every column. `cli/error-text.ts` (`errorText`, zero imports, 0.90) is how every CLI catch site reads an error: the message, else each aggregated error's message once, else the cause, else the code, else the name. A refused `localhost` rejects with an `AggregateError` whose message is EMPTY, so commands printed a bare prefix; a source scan keeps `cli/index.ts` on it. `cli/rate-limit.ts` is the fixed-window limiter (100 requests / 60s) both local servers share. `cli/local-server-guard.ts` holds the rest of the perimeter both local servers share: the `Host` allowlist that stops DNS rebinding, the ONE-TIME login ticket printed in the terminal (a URL that lands in history or a log is a spent ticket, not a standing key), and the one constant-time token comparison. `cli/code-first-tags.ts` overlays the `defineSchema()`-only tags (`pii`, `updatedAt`, `maxLength`, `tsType`) onto an introspected schema for `turbine generate`, since the database has no column for any of them. `cli/observe.ts` is the read-only metrics dashboard over the `_turbine_metrics` table written by `observe.ts`, with Studio's security model (loopback, random token, HttpOnly cookie, CSP, read-only transactions); its UI is the hand-authored embedded HTML in `cli/observe-ui.ts` (same pattern as `studio-ui.generated.ts` but with no build step).

## Testing

**Unit tests** run without a database. They use mock schemas from `src/test/helpers.ts` which provides `mockColumn()`, `mockTable()`, and `makeQuery()` (creates a QueryInterface with a null pool for build-only SQL tests).

**Integration tests** need a PostgreSQL instance with seeded data. Set `DATABASE_URL` env var. The small correctness fixture is `src/test/fixtures/seed.sql` (8 users / 10 posts / 20 comments / 5 orgs). The larger benchmark seed lives in `benchmarks/seed-neon.ts` and defaults to 1K users / 10K posts / 50K comments (override via `USERS`/`POSTS_PER_USER`/`COMMENTS_PER_POST`). Tests that require a database are gated via the `skipGate()` helper in `src/test/helpers.ts` when `DATABASE_URL` is absent, each test registers with `{ skip }` so the reporter shows real skipped counts, not silent passes.

**Coverage** is configured in `.c8rc.json`. It covers `src/**` but excludes `src/test/**`, `src/cli/**`, `src/generate.ts`, `src/introspect.ts`, `src/serverless.ts`, `src/index.ts`, and the three type-only modules that emit no runtime code (`src/query/deferred.ts`, `src/engine-config.ts`, `src/pg-types.ts`, each compiles to `export {};` and would only count as permanently-uncovered denominator). `src/query/types.ts` was excluded under that same rationale and no longer is: it carries the `UNSAFE` sentinel and the privilege-option guards, and measured 2026-09-06 it reads 99.67% lines on its own and RAISES the project figure from 96.98 to 97.09, so the exclusion was hiding well-tested runtime code rather than denominator noise. Thresholds: 93% lines, 78% functions, 89% branches, 93% statements. Those are MEASURED floors, re-baselined 2026-08-16 onto a corrected measurement: every earlier figure (75/59/85/75, and before it the aspirational 80/82/82/80 that had been failing continuously, which is how a permanently-red gate got normalized) was read under a broken coverage merge that understated the truth by about 20 points, see `//merge-bug` in `.c8rc.json`. `.c8rc.json` carries the measurements and the rule in its own `//` keys: raise as coverage improves, never lower one without recording why. `src/cli/**` is excluded HERE but has its own per-file gate, `npm run test:coverage:cli`, over ELEVEN files: `cli/studio.ts`, `cli/migrate.ts`, `cli/destructive.ts`, `cli/sql-statements.ts`, `cli/pii-predicate-guard.ts`, `cli/mcp.ts`, `cli/compile-query.ts`, `cli/error-catalog.ts`, `cli/local-server-guard.ts`, `cli/observe.ts` and `cli/index.ts`, each with its own floor (`cli/index.ts` is deliberately kept out of the aggregate pass, see `//cli-gate` in `.c8rc.json`); a new test file for any of them must be added to `coverage:cli:collect` in package.json or its coverage does not count. These numbers and this file list are asserted against `.c8rc.json` and package.json by `src/test/docs-claims-sync.test.ts`. THE TWO HALVES ARE SEPARATE, and both are required: a file added to `coverage:cli:collect` with no `coverage:cli:gate:<file>` of its own and no entry in `coverage:cli:gate:aggregate`'s `--include` list is COLLECTED and gated by nothing, i.e. a slower lane enforcing a floor of zero. That is what happened to mcp.ts and error-catalog.ts when they were first added.

## Key Patterns

- **Streaming has TWO public shapes (0.71).** `findManyStream` yields rows; `findManyStreamBatches` yields `T[]`. They are not stylistic alternatives: `yield parseRow(row)` per row means 50,000 rows is 50,000 promise resolutions and microtask turns, measured at **~7 ms / ~139 ns per row** over a 50K drain, which was the largest single component of the streaming gap. Both share ONE parser-selection site (`makeStreamRowParser`) and one database path (`streamRaw`), so the flatten / positional / PII decisions cannot diverge between them. `findManyStream` deliberately does NOT delegate to the batch method: doing so would parse a batch ahead of the consumer, so a `break` after row 1 would pay for 999 more rows. Its laziness is pinned by a test.
- **Adding a public method to `QueryInterface` fails the build until it is classified (0.90).** It must go in `TABLE_METHODS` (query/table-client.ts) as `read` / `write` / `deferred` / `primary`, or in `SqlInternalMember`, and `PowqlInterface`, which `implements TableClient`, must then have it with a matching signature. `READ_OPERATIONS` in client.ts, which decides what a read replica may serve, is derived from the `read` entries. Both used to be hand-maintained lists that failed SILENTLY: a read missing from `READ_OPERATIONS` just ran on the PRIMARY, and a method missing from `PowqlInterface` was `undefined` at runtime (`findManyStreamBatches` hit both; PowDB's `build*` and `cacheStats` were a `TypeError` until 0.90). `src/test/read-operations-drift.test.ts` stays as the run-time check (a name starting with `find`, or count/aggregate/groupBy, is a read; writes match none of it), with its anti-vacuous assertion, because reflection returning `[]` would make every check pass while testing nothing.
- **Never write a literal NUL byte into source.** `query/builder.ts`'s row-decode cache key uses NUL as its delimiter, correctly, because it is the one byte a Postgres identifier cannot contain even quoted, so no table or column name can forge a collision. Write it as the `\u0000` ESCAPE. A raw NUL makes byte-oriented tools classify the file as binary, and `grep` then reports ZERO matches for a term that is present rather than saying it declined to look. `query/builder.ts` is the largest file under `src/query/` and that silent empty result sent more than one search down the wrong path.
- All SQL identifiers quoted via `quoteIdent()`, doubles internal `"` chars per Postgres rules
- All user values parameterized (`$1, $2, ...`), never string-interpolated
- LIKE patterns escaped via `escapeLike()`, escapes `%`, `_`, `\`
- Empty-where guard blocks accidental mass mutations: update/delete with `{}`, an all-undefined where, or one that folds to always-true (`NOT: { OR: [] }`, `{ id: { notIn: [] } }`, an `OR` with an empty branch, `contains: ''` on a NOT NULL column, see `foldWhere`) throws `ValidationError` unless `allowFullTableScan: UNSAFE` (a literal `true` throws)
- `LRUCache` bounds the SQL template cache at 1,000 entries (Map insertion order for O(1) eviction)
- Module has no side effects, `setTypeParser` for int8 is gated behind a static flag in the TurbineClient constructor
- ESM source with `.js` extensions (NodeNext resolution), CJS output via separate `tsconfig.cjs.json`
- Middleware runs around execution: it can read and log params, time the call and transform the result, but it cannot change the query. `params.args` is a plain copy of the caller's args made on first read (`readOnlyMiddlewareParams`, utils.ts), so reading, spreading, `JSON.stringify` and `structuredClone` work; `next()` compares what it is passed against the caller's original (`assertMiddlewareArgsKept`) and throws a `TypeError` naming the first differing path (`params.args.where.role`), and assigning `params.args` throws at once. A structurally equal copy passes. Deliberately NOT a frozen object: a frozen object ignores writes silently in sloppy-mode code, so a tenant or soft-delete filter written in place would be dropped without a word, which is fail-open

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

- Don't add runtime dependencies beyond `pg`. Root `dependencies` stays exactly `{ pg }`, ONE entry. `@types/pg` lived here until 0.70.0 because the published `.d.ts` files named `pg.Pool` / `pg.PoolClient` / `pg.QueryResult`, and `pg` ships no declarations of its own, so those names made a types-only package a hard requirement for every consumer compiling under `strict`; moving it out without first clearing the declaration surface IS the 0.28.1 regression, which passed every repo gate and broke strangers' `tsc` anyway, because this repo typechecks against its own `devDependencies` and they do not. THE ORDER IS ONE-WAY: clear the surface, then move the dependency. `src/pg-types.ts` is the cleared surface, a ZERO-IMPORT leaf declaring the `PgCompat*` interfaces natively (zero imports so `query/` can name them without an edge back to `client.ts`, see the acyclicity rule below). Two gates keep it cleared, and BOTH are on the publish path, which is the whole point: a `consumer-types` job that installs the real tarball into a project with `pg` but NOT `@types/pg` and typechecks it under `strict` with `skipLibCheck: false` (that flag is load-bearing, measured: with it `true` the gate passes vacuously), plus the cheap text tripwire `scripts/check-no-pg-types.mjs` over every published `.d.ts`. The tripwire is a SCRIPT with one entry point (`npm run check:package-types`) because it started as an inline grep in a single ci.yml job, and ci.yml gates nothing about a release: `publish` in release.yml waits only on the jobs in its own `needs:`, and a local `npm publish` runs neither workflow. So the script is wired into `prepublishOnly` AND into a `consumer-types` job in ci.yml and release.yml alike, and release.yml's `publish` lists that job. `package-types` does not substitute for it: that job compiles with `skipLibCheck: true` and its fixture never touches `db.pool` or `transaction()`, so it passes the v0.28.1 regression (demonstrated, not assumed). The tripwire matches the pg package FAMILY, not the bare name: a leaked `pg/lib/*` or `pg-protocol` specifier (both reachable via `types/pg-internal.d.ts`, which is not published) breaks consumers even WITH `@types/pg` installed. The only sanctioned engine exception: `mysql2`, `mssql`, `@zvndev/powdb-client`, and `@zvndev/powdb-embedded` are **devDependencies + optional `peerDependencies`** (`peerDependenciesMeta.*.optional = true`), loaded lazily via dynamic `import()` from the `mysql`/`mssql`/`powdb` subpaths and never required for Postgres users; SQLite needs nothing at all (it uses the `node:sqlite` builtin). Those peer loads route through `src/optional-peer-import.cts`, the CJS build (`module: CommonJS`) lowers a plain `import()` to `require()`, which cannot load ESM-only peers (e.g. `@zvndev/powdb-client` ≥ 0.9, `ERR_PACKAGE_PATH_NOT_EXPORTED`); the `.cts` helper's NodeNext-built copy at `dist/optional-peer-import.cjs` keeps a REAL `import()` that the lowered copy falls back to. Don't replace it with a bare `import()` in the engine modules.
- Don't use `eval`, `new Function`, or shell interpolation
- Don't `import pg from 'pg'` (or `pg/lib/*`) in any module the serverless entry reaches. Import the driver as `#pg` (package.json `imports`: real `pg` on Node and `workerd`, the `src/pg-edge.ts` shim under `edge-light`/`browser`). A static `pg` import in the shared graph breaks every edge build while every Node gate stays green; `npm run check:edge` is the guard. The CLI and the engine files are Node-only and keep plain `pg`.
- Don't hand a caught error from `catch` to `finally` through a local (`catch (e) { err = wrap(e); throw err } finally { report(err) }`). SWC's minifier, which `next build` runs, drops that assignment. Report from inside the `catch`. `src/test/minified-events.test.ts` runs the event paths through SWC.
- Don't reference internal project names, client names, the applications findings were reported from, or internal planning documents in ANY tracked file, code comments, test names, CHANGELOG, release notes, commit messages, site. This repo is public. Describe changes by what they do, never by who asked for them or where feedback came from. `docs/internal/` and `AGENTS.md` are gitignored (local-only); the pre-commit hook enforces a private blocklist via `scripts/check-private-terms.mjs` + `.private-terms`.
- Don't break the Prisma-like API (`findMany`, `findUnique`, `with`, `where`)
- Don't put user values in SQL strings, always use `$N` parameterization
- Don't import `client.ts` from `query/` or `cli/` (would create a circular dependency). Since 0.65 this is machine-enforced by `scripts/check-import-cycles.mjs` (`npm run check:cycles`, in CI's lint job and prepublishOnly): no value import, static OR dynamic (`await import('../client.js')` fails too since 0.90.1: a non-splitting bundler wraps the whole client graph in lazy-init closures for one, about 1 kB brotli per entry); `import type` and type-position `import('../client.js').X` are allowed. A runtime value query/ needs from client.ts is REGISTERED by client.ts when it is evaluated: `src/transaction-client-slot.ts` is how query/builder.ts gets `TransactionClient` for the implicit transaction of a nested write or lookup-first upsert. One slot per package copy (deliberately not `Symbol.for`: a builder must construct its own copy's class), and an empty slot (client.ts never loaded, e.g. a deep-imported `QueryInterface`) is E003 on that path only, before any checkout. The same script's pass 1b refuses a dynamic value import of ANY of the package's own modules from library code (src/ minus test/ and cli/), for the same size reason; optional peers load through `importOptionalPeer` with a bare specifier and are not matched.
- Don't register type parsers outside the TurbineClient constructor
