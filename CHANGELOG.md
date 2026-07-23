# Changelog

## 0.42.0 (2026-07-23)

### Fixed

- **`migrate-from-prisma` now pairs two relations to the same model by `@relation` name.**
  When a model had two or more relations pointing at the same target model (for example a
  `createdBy` / `modifiedBy` pair of foreign keys), the resolver reported them as
  "ambiguous" even though Prisma disambiguates them with a shared `@relation("Name")`.
  Resolution now matches the relation name first: an inverse relation field resolves
  through the foreign key pinned by the opposing side that carries the same name, and only
  falls back to the ambiguity report when there is no name or the named pair cannot be
  found. Such pairs now resolve fully with no unresolved items.
- **`@@unique` now matches a `UNIQUE INDEX`, not only a unique constraint.** Prisma creates
  composite uniques as unique indexes rather than table constraints, so every `@@unique`
  was reported as having "no unique constraint" even when the database had the exact unique
  index. The resolver now also accepts a match from a non-partial unique index whose column
  set equals the `@@unique` columns, and those index-backed uniques are included in the
  emitted name map (custom `@@unique(name:)` selector names preserved).
- **`migrate-from-prisma` now emits the generated client too.** The command previously wrote
  only the migration report and the typed name map, so users had to run `turbine pull`
  separately, and a partially resolved run (`--allow-partial`) emitted no client at all. It
  now always generates the standard client (`types.ts`, `metadata.ts`, `index.ts`) from the
  live introspected metadata alongside the report and name map, including on the
  `--allow-partial` path (unresolved Prisma items never block the client).
- **`migrate-from-prisma` now honors `--keep-column-names`.** The flag was accepted but
  silently ignored, so a keep-column-names client (raw snake_case field names) and the
  emitted name map (camelCase field names) disagreed. The flag now flows through to both the
  generated client and the name map's field values, which become the raw database column
  spellings so the two agree.
- **Prisma implicit many-to-many junctions are now detected.** A Prisma implicit m2m
  join table (e.g. `_UserOrganizations` with columns `A` and `B`) has no primary key,
  just a two-column `UNIQUE` index over the two foreign-key columns, so auto-detection
  previously skipped it and the `manyToMany` relations were missing (an `include` on
  either side threw at runtime). `turbine generate` / `pull` now accepts a two-column
  unique index over exactly the two single-column foreign keys as the junction key when a
  table has no primary key, with the same purity checks as before (exactly two foreign
  keys to two distinct tables, no payload columns). Tables that DO have a primary key, or
  that carry an extra payload column, are still never treated as junctions.
- **Index column parsing no longer swallows a partial-index `WHERE` clause.** Introspection
  parsed the indexed columns with a greedy match that, for a partial index like
  `CREATE UNIQUE INDEX ... (pos_id, pos_item_id) WHERE (pos_item_id IS NOT NULL)`, captured
  the trailing `WHERE (...)` as part of the column list. That garbage fragment then leaked
  into generated compound-unique selector names and produced a `types.ts` that failed to
  parse. Column parsing is now anchored on the `USING` clause, quoted identifiers are
  de-quoted, and expression columns are dropped conservatively.
- **Partial unique indexes are excluded from compound-unique selectors.** A partial `UNIQUE`
  index only guarantees uniqueness over its predicate's rows, not table-wide, so it can no
  longer back a `findUnique`-style compound selector in either the runtime `where` expansion
  or the generated `*WhereUnique` selector branches. `IndexMetadata` carries a new optional
  `partial` flag.
- **Generated compound-unique selector names are always valid TypeScript.** A synthetic
  selector name that is not a valid identifier (for example a junction-style quoted
  uppercase column) is now emitted as a single quoted string-literal key, so the generated
  `types.ts` always parses.
- **`turbine-orm/prisma-compat` delegate errors now reject instead of throwing.** Translation
  and validation errors raised while building a query (an unknown relation in `include`, a
  malformed compound selector, a missing `where`, a negative `take`, ...) previously threw
  synchronously from the delegate call, so a Prisma-style `.catch()` never fired. Every
  delegate method and the `$transaction` array-batch path now surface these as a rejected
  promise; error types and decoration are unchanged.

## 0.41.0 (2026-07-23)

### Breaking changes

- **Unique foreign keys now introspect as one-to-one (`hasOne`) relations.** When a
  child table's foreign-key column set is EXACTLY covered by a `UNIQUE` constraint or a
  plain (non-partial, non-expression) `UNIQUE` index, `turbine generate` / `pull` now
  emits a to-one relation on the parent side (`RelationDescriptor<Child, 'one', …>`)
  instead of a to-many array, matching Prisma one-to-one introspection. The relation is
  also renamed to the SINGULAR of the child table (e.g. `users.profiles` becomes
  `users.profile`), falling back to the previous plural name only if the singular
  collides with an existing column or relation. This is a correctness fix, and it is a
  double-barreled change when it applies:
  - **TypeScript consumers** get loud compile errors where the relation was iterated
    (`.map(...)`, `[0]`) or filtered with `some`/`every`/`none`; the fix is to read the
    relation as an object-or-`null`.
  - **Plain-JS consumers** silently receive `Child | null` (an object or `null`) where an
    array used to be; a childless parent is now `null` rather than `[]`.

  The parent-side field stays nullable (`Child | null`) even for a `NOT NULL` unique FK,
  matching Prisma. To keep the pre-0.41 to-many shape, pass `--legacy-to-many-uniques`
  (CLI), set `legacyToManyUniques: true` in `turbine.config`, or pass
  `legacyToManyUniques: true` to `introspect()`. Partial and expression unique indexes are
  deliberately excluded from the flip (they do not guarantee at most one child row).

### Added

- **`--import-ext <js|none|auto>` (config `importExtension`).** Controls the extension on
  the generated `index.ts` sibling imports. `js` emits `./types.js` (required by NodeNext
  `tsc` and by tsc-compiled ESM on Node, the previous behavior); `none` emits `./types`
  (correct for bundlers and `moduleResolution` `bundler`/`node10`: webpack, Next.js/SWC,
  Vite/esbuild); `auto` (the new default) walks up from the output directory to the nearest
  `tsconfig.json` (extends chains are not followed) and picks `.js` for `node16`/`nodenext`
  module resolution, extensionless otherwise, falling back to `.js` when the tsconfig is
  missing, unparseable, or ambiguous. Because the fallback is the previous behavior,
  NodeNext projects never regress; bundler projects that check generated files into source
  control will see a one-time diff to extensionless imports on the next regenerate.
- **`--keep-column-names` (config `keepColumnNames`).** Generates column FIELD names as the
  raw database column names (snake_case) instead of camelCase, so `user_id` stays `user_id`
  end to end (row keys, `where`/`orderBy`/`select`, nested `with` rows, aggregate keys). It
  is a pure generate-time transform with zero runtime changes; relation names, table
  accessors, and entity type names are unaffected. Opt-in: untouched schemas emit
  byte-identical output. The transform is also exported from the package root as
  `withDbFieldNames(schema)` so runtime-introspection and serverless users can apply the
  same identity mapping to a schema they build at runtime.
- **`introspect()` gains `legacyToManyUniques` and `onDefaultTableExclusion`** options, and
  `withDbFieldNames` / `applyTableFilters` / `DEFAULT_EXCLUDED_TABLES` are exported for
  programmatic use.

### Changed

- **Migration bookkeeping tables are excluded from introspection by default.**
  `turbine generate` / `pull` now skips `_turbine_migrations`, `_prisma_migrations`, and
  `_turbine_metrics`, so a freshly introspected schema no longer emits accessors and stray
  FK-derived relations for them. `generate` prints a note for any that were present. To
  keep one, name it in `include` (CLI `--include`, config `include`), which restores the
  old output for that table byte for byte. Only these three names are special-cased; other
  leading-underscore tables are never excluded.
### Added

- **`turbine migrate-from-prisma`, an official Prisma-to-Turbine migration path (phase 1).**
  Point the new command at a `schema.prisma` and it emits two artifacts next to your
  generated client:
  - `prisma-migration-report.md`, a per-model resolution report: each Prisma model
    mapped to its Turbine table + client accessor, every field, relation, junction
    table, and compound-unique selector, plus an explicit list of anything that could
    not be resolved (with the reason), and a fixed section of Prisma-vs-Turbine
    behavior notes (cursor exclusivity, `_count` shape, relation-array ordering, the
    `sslmode` URL recommendation).
  - `prisma-map.ts`, a typed `PRISMA_MAP` name map (models, fields, relations with
    cardinality, and compound-unique selector names including custom `@@unique(name:)`
    ones). It is the input to hand-written compat wrappers today and to the phase-2
    `turbine-orm/prisma-compat` runtime adapter next.

  The `schema.prisma` parser is hand-rolled and adds **zero dependencies**: it
  understands models, enums, views, `@map`/`@@map`, relations (including implicit
  m2m junctions), `@@unique` (named and default), and `@@id`, and is deliberately
  lenient: any attribute or block it does not recognize is skipped, never fatal.
  Names are resolved against the live database (via `turbine`'s existing
  introspection); a model that matches multiple candidate tables is reported
  UNRESOLVED rather than guessed. `--no-db` produces a parse-only report without a
  database, `--allow-partial` accepts an incomplete map, and `--no-timestamp` makes
  the output reproducible. The command exits non-zero when anything is unresolved
  (unless `--allow-partial`). `PrismaCompatMap` is exported from the package root so
  runtime consumers can share the shape.

- **`turbine-orm/prisma-compat`, a runtime PrismaClient-surface adapter (phase 2).**
  `createPrismaCompatClient(db, PRISMA_MAP, options?)` wraps a `TurbineClient` and
  exposes Prisma's `db.Model.findMany(...)` surface, driven by the `PRISMA_MAP` that
  `turbine migrate-from-prisma` emits. It is a pure TypeScript shim: **zero new
  dependencies**, never imported by core. It translates args recursively (`include` →
  `with`, `select` split into scalar selection + relations, field/relation renames both
  ways, `take`/`skip` → `limit`/`offset`, compound-unique selectors including custom
  `@@unique(name:)` names), reshapes results (`_count` keyed back to Prisma relation
  names, to-one relations surfaced as `object | null`), and supports both `$transaction`
  forms (callback and Prisma's lazy `$transaction([...])` array batching via the core
  batch path), `$queryRaw`/`$executeRaw` (with `Prisma.sql`-style nested-fragment
  flattening) and the `*Unsafe` variants. Options: `stablePkOrder` (passes through the
  core `stableRelationOrder` flag) and `prismaErrorCodes` (decorates thrown
  `TurbineError`s with the nearest Prisma code, e.g. `P2002`, without faking
  `instanceof`). Cursor translation: the idiomatic `cursor` + `skip: n` maps to an exact
  exclusive cursor + `offset n-1`; a **bare inclusive cursor** compiles to a `gte`/`lte`
  keyset predicate only when its field is the single `orderBy` key (or the single-column
  primary key with no `orderBy`) and otherwise throws a descriptive error rather than
  emit a wrong page. Documented non-goals (client extensions, `$use`, fluent relation
  chaining, Accelerate/Pulse, the Mongo API, byte-exact error identity) throw or are
  listed rather than silently mis-behaving.

- **`createMany({ skipDuplicates: true })` is now engine-gated.** PostgreSQL and SQLite
  emit `ON CONFLICT DO NOTHING` and MySQL emits its no-op `ON DUPLICATE KEY UPDATE`
  (unchanged); SQL Server and PowDB now throw `UnsupportedFeatureError`
  (`TURBINE_E017`) instead of silently ignoring the flag and inserting duplicate rows,
  since neither has a single-statement skip-duplicates form.
### Changed

- **Behavior change: `relationLoadStrategy` now defaults to `'auto'` on SQL engines.**
  Previously every `with` clause resolved as a single-statement `json_agg` join.
  The new `'auto'` default keeps that join for every relation EXCEPT the ones the
  introspected metadata proves are pathological: when a relation's probe column
  has no covering index, that relation alone falls back to the batched loader
  (one flat `WHERE fk = ANY($1)` follow-up), which pays the missing index once
  instead of once per parent row. This only ever replaces a provably catastrophic
  plan with an equivalent-output one. Result bytes are identical (the batched
  loader guarantees the same shape), and everything stays on the same
  connection/transaction, so most callers see no difference. What can change:
  middleware and query-event logging see more than one statement for a
  fallen-back relation, the per-query `timeout` now applies per statement rather
  than to a single statement, and tests that assert exact SQL text or statement
  counts on such a query may need updating. The fallback engages only when
  DB-backed index metadata exists (a generated / introspected client); a
  code-first `defineSchema`-only client behaves exactly like `'join'`. To restore
  the previous behavior everywhere, set `relationLoadStrategy: 'join'` at the
  client level (or per query). Composite-key relations always stay on the join
  plan. Dev builds print a once-per-relation note when the fallback engages, and
  the query event carries a `strategy: 'auto-batched'` tag. Tip: run
  `npx turbine doctor` (or add the missing FK index) to keep a relation on the
  single-statement join.

### Added

- **Prisma-style compound-unique `where` selectors.** The `findUnique` family (and
  `update` / `delete` / `upsert`, plus nested-write `connect` / `connectOrCreate` /
  `disconnect` / `set` / `delete`) now accept a synthetic selector key that holds
  a composite unique constraint's member columns, e.g.
  `findUnique({ where: { orgId_userId: { orgId, userId } } })`, which expands to
  the column conjunction (`WHERE "org_id" = $1 AND "user_id" = $2`). Selector names
  are derived from the primary key, composite UNIQUE constraints, and declared
  composite UNIQUE indexes (the code-first `defineSchema` source), and the
  generated `*WhereUnique` union gains a matching branch (plus an
  `*CompoundUniques` helper type). A selector with the wrong members throws a
  clear E003 listing the required fields; a name that collides with a real field,
  column, or relation is never treated as a selector. The expansion runs before
  cache fingerprinting, so an expanded query is byte-identical to (and shares the
  SQL-cache entry of) the spelled-out conjunction. The PowDB engine adopts the
  same selectors on `findUnique`.
- **`_count: { _all: true }` record form on `aggregate` and `groupBy`.** Both now
  accept the reserved `_all` key alongside per-field counts:
  `_count: { _all: true, email: true }` returns `{ _count: { _all: n, email: n } }`
  (Prisma parity). Scalar `_count: true` is unchanged and still returns a plain
  number; the emitted SQL for existing calls is byte-identical.
- **Opt-in `stableRelationOrder`.** A new client-config and per-query option that
  fills a primary-key-ascending `orderBy` into every to-many `with` relation that
  has no explicit ordering, so unordered child arrays come back deterministically
  (child-array order without an `orderBy` was never guaranteed, and the `'auto'`
  fallback above can change it). An explicit per-relation `orderBy` always wins.
  Off by default; when off the emitted SQL is byte-identical to before.
- **`QueryEvent.strategy`.** Query events emitted for an `'auto'` query that engaged
  the batched fallback now carry `strategy: 'auto-batched'`, so production
  observability can see which queries were re-planned.

### Fixed

- **The dev-mode missing-FK-index warning now dedupes process-wide.** It previously
  used a module-level set, which a dual-package (ESM + CJS) load or a bundler /
  HMR re-evaluation could reset or duplicate, causing the warning to repeat. The
  dedupe now lives on a `globalThis` registry keyed by `Symbol.for(...)`, shared
  across every module copy in the realm and surviving dev-server recompiles, so
  each relation warns at most once per process (bounded so it can never grow
  unboundedly). The deep-`with` advisory moved to the same registry.

## 0.40.1 (2026-07-22)

### Fixed

- **`turbine seed` now actually runs TypeScript `defineSeed` seeds.** The scaffolded
  `seed.ts` quickstart could print `Seed completed` while the seed callback never
  executed (no writes, no output). The self-run detection mistook the library's own
  compiled frame (`dist/seed.js`, or a plain-path `tsx` frame) for the caller, so the
  "this file is the entry" check never passed and the callback was never queued. Seed
  detection now identifies the library's own module by its real path and skips it,
  regardless of the `.ts`/`.js` layout or `tsx` plain-path stack frames, so a
  defineSeed file run via `turbine seed`, `tsx`, or `node` executes its callback. The
  CLI seed runner also reports honestly: if a seed file loads but no callback runs,
  that is now an error instead of a false success.
- **`turbine push` no longer hides destructive schema changes.** A diff that only
  removed a column reported `Database is already in sync` (the column stayed), and a
  mixed diff printed `Applied 0 statement(s)` next to a false `Altered`, with
  `--allow-destructive` doing nothing. Destructive statements (a dropped column, a
  lossy column-type change) now stay in the plan and flow through the existing
  data-loss guard: without consent, `push` refuses loudly with the same itemized,
  classified report the migration gate uses and a non-zero exit (nothing applied); on
  a TTY it offers the same typed two-step confirmation as `migrate up`; and
  `--allow-destructive` actually applies them.
- **`migrate deploy --allow-drift` is honored.** Deploy's own drift error recommends
  passing `--allow-drift`, but the flag previously changed nothing. It now bypasses
  checksum validation on `deploy` exactly as it does on `up`, with a loud warning.
- **`migrate create --auto` on a destructive-only diff produces a real migration.** It
  used to report `Database is already in sync: nothing to migrate` when the only
  change was a dropped column. It now writes a migration with the destructive
  statements flagged inline, matching `--from-diff`.
- **`migrate deploy` prints a destructive-statement notice.** Before applying, if the
  pending batch contains data-destroying statements, deploy now prints the same
  itemized, classified report as a notice (deploy still proceeds by design), instead
  of running `DROP TABLE` and similar with no warning.
- **`migrate status` lists applied migrations whose file was deleted.** Such entries
  now appear with a `! Missing file` marker and a warning banner, and are counted in
  "applied", instead of being silently dropped from the reported history.
- **Out-of-order applies are flagged.** When `migrate up`/`deploy` applies a migration
  whose timestamp is older than the newest already-applied migration, it now prints a
  one-line warning naming both.
- **Clearer drift remedies for deleted files.** The drift error's "roll back with
  `migrate down`" suggestion is impossible for a file that was deleted from disk; the
  message now tells you to restore the file for those, and scopes the roll-back
  suggestion to modified files.
- **Root `turbine --help` documents more flags.** The Migrate options block now lists
  `--from-diff`, `--recipe`, and `--allow-destructive`, and a new Init options block
  documents `--yes`, `--skip-schema`, `--skip-seed`, `--skip-push`, and
  `--skip-generate`.

## 0.40.0 (2026-07-21)

### Added

- **`turbine migrate create <name> --from-diff`.** Scaffold a migration from the
  live schema diff. Loads your code-first schema (the same file `push` uses),
  introspects the database, runs the diff, and writes the forward statements
  into the migration's `-- UP` section and the reverse statements into `-- DOWN`
  (a clearly commented "irreversible, write manually" placeholder is written
  when no reverse is derivable). Any data-destroying statement in either
  direction (a lossy `ALTER COLUMN ... TYPE` in UP, a `DROP TABLE` / `DROP
  COLUMN` reverse in DOWN) is flagged inline with loud comments and a file-level
  banner, and the statement is left intact so `migrate up` still refuses it by
  default unless you confirm interactively or pass `--allow-destructive`. Diff
  warnings (e.g. enum value removals the diff will not apply automatically) are
  surfaced as `-- NOTE:` comments. `--from-diff` cannot be combined with
  `--auto` or `--recipe`. This complements the existing `--auto` flag, which
  writes the raw diff without the destructive annotations.
- **Richer interactive `turbine init`.** `init` is now a sequenced bootstrap
  that detects project state and runs only the needed steps: write
  `turbine.config.ts` if missing, offer to create a starter schema file and seed
  file, and (when a reachable database is configured) offer to push the schema,
  generate the typed client, and run the seed file. Re-runs skip completed steps
  (existing files are detected), so `init` is safe to run repeatedly. New flags:
  `--yes` / `-y` accepts every step's default non-interactively, and
  `--skip-schema`, `--skip-seed`, `--skip-push`, `--skip-generate` skip
  individual steps. A destructive push keeps the existing typed confirmation. A
  bare non-interactive invocation behaves as before (scaffold files + generate
  run; push and seed do not) and prints a note pointing at `--yes` and the
  `--skip-*` flags.
- **Typed `groupBy` results.** `groupBy` no longer returns
  `Record<string, unknown>[]`: its result-row type is now inferred from the
  args, matching Prisma and Drizzle. Each `by` field carries its entity field
  type, `_count` is a `number`, `_sum` / `_avg` fields are `number | null`, and
  `_min` / `_max` fields carry the field's own type. No `as const` needed at the
  call site. Grouping by a JSON-path key still yields a runtime alias that can't
  be typed, so those columns are left off the row type (cast when grouping by a
  JSON path). Compile-time assertions guard the inference in the typecheck job.
- **`groupBy` `limit` and `offset`.** `groupBy` accepts optional `limit` and
  `offset`, compiled to `LIMIT` / `OFFSET` after `ORDER BY` (parameterized on
  PostgreSQL / SQLite / SQL Server, inlined on MySQL, native on PowDB). Useful
  for "top N groups" and paginated grouped results; pair with a deterministic
  `orderBy`.
- **Array `orderBy` (Prisma-style).** Everywhere an `orderBy` is accepted
  (`findMany`, a `with` relation, and `groupBy`) you can now pass an array of
  objects, e.g. `orderBy: [{ createdAt: 'desc' }, { id: 'asc' }]`. The array's
  element order is the authoritative multi-key sort precedence, so multi-key
  ordering no longer depends on JS object key iteration order. The single-object
  form is unchanged and byte-identical. Both forms flatten through one shared
  helper, so the SQL-template cache fingerprint, SQL build, and param-collect
  paths stay in lockstep (a permuted array is correctly a distinct cache key).
  Supported on every engine, including PowDB.
- **Configurable SQL-template cache size.** A new `sqlCacheSize` option on the
  client config (and `QueryInterfaceOptions`) bounds the per-table LRU SQL
  template cache. Default stays `1000`. Values are parameterized and never
  fragment the cache, so this bounds distinct query *shapes*: raise it for apps
  with a very large query surface to lift the hit rate, lower it to cap memory.
  `sqlCacheSize: 0` disables caching entirely (identical to `sqlCache: false`).
### Changed

- **PowDB 0.18.1 driver packages adopted.** The optional PowDB peers
  (`@zvndev/powdb-client`, `@zvndev/powdb-embedded`) now resolve to the
  published `0.18.1` line, so the nested-projection relation path shipped in
  0.39.0 lights up automatically on install via the engine version probe
  (previously it activated only against a locally built 0.18 engine). The
  supported peer range is unchanged. Storage-raised unique-constraint
  violations now arrive with the typed wire error class already mapped to
  `UniqueConstraintError` (E008); no behavior change for consumers.

## 0.39.0 (2026-07-20)

### Added

- **PowDB nested projections: `with` runs as one statement.** PowDB 0.18 adds
  nested projections (shaped results) to PowQL: a projection field can be a
  whole correlated child query returning a per-parent JSON array. Turbine now
  compiles eligible `with` clauses straight into the parent statement, so
  `db.users.findMany({ with: { posts: { orderBy: { views: 'desc' }, limit: 3 } } })`
  runs as ONE PowQL statement, with per-parent ordering, limits, and offsets
  applied natively by the engine, childless parents kept (`[]` for hasMany,
  `null` for to-one), and arbitrary nesting depth sharing one alias counter,
  the same single-query shape Turbine's `json_agg` strategy gives Postgres.
  On an engine >= 0.18 this replaces the batched N+1 loaders as the default
  relation path; an explicit `relationLoadStrategy: 'batched'` opts back out,
  and `'join'` also prefers nesting (it is the strictly better server-side
  path: no fan-out, survives parent paging, keeps childless parents).
  Ineligible shapes silently fall back to the loaders with identical output:
  many-to-many (the junction-order stitch has no nested equivalent),
  bigint-typed child columns (JSON cannot carry them losslessly), a to-one
  relation with paging, parent `distinct`, and projection-key collisions.
  PII-tagged child columns stay excluded at the query level; `select` /
  `omit` / `includePii` are honored; child JSON values are re-coerced per
  column type (datetime micros come back as `Date`). `explain()` shows the
  engine's nested plan. Everything is capability-gated on the probed engine
  version: older engines keep the loaders byte-for-byte, and the feature
  lights up automatically once the 0.18 driver packages are on npm.
- **PowDB typed wire error classes (engine >= 0.17).** PowDB 0.17 error frames
  carry a stable one-byte error class, and `wrapPowdbError` now classifies by
  it before the message-substring families, so a server-sanitized message
  ("query execution error") still maps to the right typed error: timeout →
  `TimeoutError` (E002), memory/size limit → `ValidationError` (E003),
  read-only refusal → `ReadOnlyError` (E018, `reason: 'snapshot'`),
  auth failure / rate limiting → `ConnectionError` (E004), constraint
  violation → `UniqueConstraintError` (E008), cooperative cancellation →
  `ConnectionError` (E004, final). The specific message families keep
  precedence where they extract richer detail (constraint and column names,
  RBAC-vs-snapshot read-only reasons); classless errors from older servers
  keep the exact pre-0.17 behavior.

### Changed

- PowDB driver dev/test baseline bumped to `@zvndev/powdb-client` /
  `@zvndev/powdb-embedded` `^0.17.0` (the peer range is unchanged and already
  admits 0.18). The PowQL lexer escape set was re-verified byte-identical
  through the 0.18 engine line, so `POWQL_LEXER_TESTED_CEILING` is now
  `'0.18'`.

## 0.38.1 (2026-07-19)

### Fixed

- **createMany respects declared column types in its UNNEST casts.** The
  bulk-insert cast picker fell back to a name-based heuristic (`*_id` implies
  `bigint[]`, `*_at` implies `timestamptz[]`) whenever the metadata carried no
  precomputed array type, so a `createMany` against a text or uuid foreign key
  (for example `author_id text`) failed with `invalid input syntax for type
  bigint`. The column's declared type in `pgTypes` now always wins; the
  heuristic survives only for columns entirely absent from the metadata.
  Build-only regression tests pin both behaviors.
- **PowDB embedded version detection under tsx on Node 20.** The optional-peer
  helper resolved the addon's version with `require('<pkg>/package.json')`,
  which tsx's CommonJS hook on Node 20 fails to load even though resolution
  succeeds, so every version-gated capability threw E017 ("could not report a
  version") on that lane. The helper now resolves the path and reads the file
  directly, which is loader-independent.
- **Error-code enforcement script recognizes typed subclasses.** The CI check
  now knows `ReadOnlyError` (E018) and `DestructivePushRefusal` (the
  `ValidationError` subclass thrown by `schemaPush`), which it previously
  flagged as untracked, keeping the error-codes gate red.

These three were the standing CI failures on main; the branch is fully green
again, and the hardened tag-publish gate introduced in 0.38.0 (which correctly
refused to publish over the red integration lane) now passes end to end.

## 0.38.0 (2026-07-19)

### Added

- **Studio data-tab power pass.** The Data tab grows the tools a real
  inspection session needs. Per-column filters (equals, not, contains,
  comparisons, IS NULL / IS NOT NULL) stack with the text search, compile to
  fully parameterized SQL on the server (validated column and operator
  whitelists, capped at 10), and are refused outright on redacted PII columns,
  including null checks, so a hidden value cannot be probed. Rows are
  selectable (checkbox column with select-all) with a selection bar for Copy
  JSON / Copy CSV / Delete selected / Clear; an Export modal copies or
  downloads the current page or selection as JSON or CSV; double-clicking any
  cell copies its raw value; and the page size is adjustable from 25 to 500
  rows (persisted).
- **Studio bulk writes, still PK-addressed.** In `--write` mode,
  `/api/row/insert` and `/api/row/delete` accept a `rows` array (capped at
  500): each entry passes the same per-row validation as a single write
  (full-primary-key addressing, column checks against introspected metadata),
  compiles to its own single-row statement, and the batch runs in one
  all-or-nothing transaction; a delete whose primary key matches nothing rolls
  the whole batch back. This powers multi-select delete and the new Paste
  rows flow (bulk insert from pasted TSV/CSV with a header row, or a JSON
  array, with live parse preview and per-row errors). Predicate-based
  mutations and bulk update remain deliberately unsupported.
- **Studio query-tab visibility.** After a run, View SQL / Copy SQL expose the
  single statement the builder compiled to. Builder validation messages now
  render (a disabled Run button explains which clause is incomplete instead
  of graying out silently), and the where builder gains IS NULL / IS NOT NULL
  operators. Loading a saved query now restores NOT combinators and null-check
  clauses correctly, the save dialog locks the target table to the builder's
  table, and deleting a saved query asks for confirmation.
- **Studio keyboard shortcuts, for real.** The shortcuts the command palette
  advertised now work: Cmd+Enter runs, Cmd+S saves (instead of the browser
  save dialog), G then Q / D / S switches tabs, R refreshes data, Shift+R
  reloads the schema. Tab buttons keep `aria-selected` in sync.
- **Typed row editor.** Enum and boolean columns get dropdowns, JSON columns
  validate before submit with the parse error shown inline, and timestamp
  fields carry ISO 8601 placeholders.

### Fixed

- **Nested-write errors no longer embed user-supplied values.** The
  connect/update miss messages in the nested-write engine interpolated the
  full `where`/`connect` object (including values such as email addresses)
  into the exception text even in safe error mode, contradicting the PII-safe
  errors contract. They now follow the same safe/verbose convention as
  `NotFoundError`: key names only in safe mode, full detail under verbose.
- **Demo mode now honors its "nothing is saved" promise for saved queries.**
  Saving a query in `turbine studio --demo` wrote `.turbine/studio-queries.json`
  into the working directory, and demo sessions displayed the project's real
  saved queries. Demo saved queries now live in memory only, die with the
  process, and the real file is never read or written.
- **Prototype-safe field validation.** Field names that collide with
  `Object.prototype` members (`constructor`, `toString`, `__proto__`, ...) in
  `where` / `orderBy` / `select` / nested-write `data` previously bypassed the
  unknown-column check via inherited lookups and crashed with a `TypeError`.
  All user-keyed metadata lookups are now `Object.hasOwn`-guarded and throw
  the normal typed `ValidationError` (E003).
- **Studio boot failures are visible.** A schema-load error now renders an
  error box with a Retry button on every tab instead of leaving the default
  Query tab on an eternal "Loading schema...". Live demo-mode toggles no
  longer reset the composed builder query, current table, filters, or
  selection; builder results re-run after a toggle so redaction on screen
  always reflects the server state.
- **Studio data-grid honesty.** Column headers render verbatim
  (`created_at`, not `CREATED_AT`), redacted PII columns show a
  sorting-disabled tooltip instead of a lying sort arrow, rate-limit (429)
  responses surface a retry hint, and nullable-typed columns
  (`number | null`) are classified correctly by the value editors.

### Changed

- **Release gate hardened.** The tag-triggered publish workflow now requires a
  live Postgres integration run (seeded fixture) and the packed-tarball smoke
  job before `npm publish`, matching the PR gate instead of trusting
  unit tests alone.
- **Site.** The hero version badge derives its tagline from the changelog at
  build time (it can no longer go stale), a full changelog page ships at
  /changelog, the landing page gains cards for `turbine doctor`, multi-engine
  support, `explain()`, and the MCP server, and the comparison table is dated
  with Prisma's `relationJoins` marked as Preview.

## 0.37.0 (2026-07-18)

### Added

- **Studio demo mode.** `npx turbine studio --demo` boots Studio with no
  database and no `DATABASE_URL`: a seeded in-memory sample dataset (users
  with PII-tagged emails and phones, posts, comments, orgs, relations wired)
  served by Turbine's own SQLite engine over the Node built-in `node:sqlite`
  `:memory:` (Node 22.5+). A demo banner carries two live toggles, PII
  (hidden/shown) and Writes (off/on), so the three Studio modes can be
  experienced in one session: read-only and redacted on boot, flip to see
  real-looking PII reveal warnings, flip again to insert/edit/delete rows.
  Writes genuinely apply to the in-memory store (edits stick, refresh shows
  them) but nothing is ever saved anywhere: the store dies with the process
  and every launch starts pristine. The full security model applies (token
  auth, Origin checks on mutating routes, rate limiting, nonce CSP), the
  mode switcher route exists only in demo mode, and the Postgres path is
  byte-identical when the flag is off.

## 0.36.1 (2026-07-18)

PowDB 0.16 support. The 0.16 driver contract is byte-identical to 0.15 (the
release is an engine-internal index-correctness fix plus documentation), so
this is a verification-and-pinning release, not a feature round.

### Changed

- **PowDB 0.16 verified and pinned.** The full live matrix (networked server +
  embedded addon) runs green on 0.16; dev dependencies track `^0.16.0` (the
  optional peer range `>=0.7.1 <1.0.0` already admits it). The PowQL
  literal-escaper's tested lexer ceiling is bumped to `0.16` after verifying
  the 0.16 lexer is untouched.
- **NUL-byte regression coverage.** PowDB 0.16 fixed wrong rows from
  non-unique string indexes on values with embedded NUL bytes (a new on-disk
  index format, rebuilt automatically on first writable open). A live
  integration test now locks the fix in through the ORM surface: indexed
  equality, prefix lookups, and index-driven updates around `"A"` vs
  `"A\0"` neighbors. The test fails on the 0.15 addon and passes on 0.16.
- **Read-only snapshot note.** The engines page documents the 0.16 index
  upgrade nuance for snapshot fleets: a read-only open rebuilds the affected
  indexes in memory on every open until a writable open persists the new
  format, so run snapshots through one writable open (or take them from a
  0.16 primary).

## 0.36.0 (2026-07-18)

The safety release: first-class PII field tagging with opt-in return semantics,
an opt-in writable Studio (read-only stays the default), an honest and hardened
migration story (destructive gate on `push`, declared indexes in DDL and diff,
a sanctioned backfill recipe), and the where-clause cache paths unified onto a
single canonical walk with a sampled production cross-check. Reviewed by five
independent passes (product, strategy, security, code quality, UX) before
release; every confirmed finding was fixed or explicitly documented below.

### Added

- **PII fields.** Tag a column `pii: true` in `defineSchema` (or `.pii()` on
  the fluent builder) and Turbine excludes it from every default projection:
  top-level rows, relation subqueries (`with`), the batched loader, positional
  JSON encoding, PowDB loaders and native joins, and the row a write returns.
  It comes back only when explicitly named in `select`, or via the new
  `includePii: true` read option, which restores every PII column at the top
  level and at every nested `with` level of that query. Filtering, ordering,
  and grouping by a PII column stay allowed (naming the column is itself the
  opt-in). Untagged schemas emit byte-identical SQL. The SQL cache key carries
  the flag, so a cached no-PII statement can never serve an opt-in call.
- **PII is enforced at the SQL level on writes.** A write against a table with
  PII columns (`create`, `createMany`, `update`, `delete`, `upsert`, nested
  writes) returns an explicit non-PII projection instead of `RETURNING *`:
  `RETURNING "col", ...` on Postgres and SQLite, a projected follow-up
  `SELECT` on MySQL, and per-column `OUTPUT INSERTED.` / `OUTPUT DELETED.` on
  SQL Server. PII values are persisted normally; they simply never cross the
  wire back unrequested. A PII-tagged primary key stays in the projection so
  the returned row remains addressable. Tables with no PII columns keep
  `RETURNING *` byte-for-byte. PowDB is the one exception (its `returning`
  keyword takes no column list per the driver spec), so the returned row is
  stripped client-side there; its upsert reselect already projects non-PII
  columns.
- **Writable Studio (opt-in).** `turbine studio --write` enables single-row
  insert/update/delete from the Data tab. Every write is addressed by the
  row's full primary key (the predicate is rebuilt from the PK alone, so a
  widened `where` cannot reach the database), compiled by the same validated
  builders as the library, runs in its own transaction with the same
  parameterized statement timeout and pinned `search_path`, and requires a
  matching `Origin` header. Without the flag the write endpoints do not exist
  (requests 404) and every transaction remains `BEGIN READ ONLY`. The UI shows
  a persistent WRITE MODE banner and a delete confirmation.
- **Studio PII redaction.** PII-tagged columns render as a redaction
  placeholder in every tab, applied server-side before serialization (table
  rows, builder rows, nested relation rows, and the echoed post-write row).
  Redacted columns are also excluded from the Data-tab substring search and
  from `orderBy`, so a redacted value cannot be probed or inferred through
  sort position. `--show-pii` reveals values for a launch, with a loud
  terminal warning and a persistent PII SHOWN banner in the browser.
- **Studio row editor: explicit set-NULL.** Nullable non-PK columns get a
  per-field NULL toggle (insert and edit) that sends an explicit `null`
  parameter end-to-end; a blank field still means "unchanged" (edit) or "use
  the default" (insert). A null-toggled PII field sends `null`, never the
  redaction placeholder.
- **Destructive gate on `push`.** `turbine push` now scans the statements it
  is about to apply with the same destructive-SQL scanner as `migrate up` and
  refuses to run them without the two-step typed confirmation (the literal
  phrase `destroy my data`, then `yes`) or an explicit `--allow-destructive`.
  The diff is computed once and the confirmed statements are exactly the ones
  applied (no re-diff between confirmation and apply), and the refusal is a
  typed `DestructivePushRefusal` (exported, extends `ValidationError`,
  carries the offending statements) rather than a message-text convention.
- **Declared indexes in SQL DDL.** `defineSchema` table-level
  `indexes: [{ columns, unique?, name? }]` now emit `CREATE [UNIQUE] INDEX`
  from `schemaToSQL`/`push`, and `schemaDiff` adds declared indexes missing
  from the live database (reverse: `DROP INDEX`). Matching is by name with a
  definition check: a name that matches an existing index whose uniqueness,
  column list, or partial-`WHERE` differs produces a warning, never a drop. A
  declared index that resolves to the same name as an automatic FK index
  supersedes it, so declaring a UNIQUE index on an FK column works. Undeclared
  database indexes are surfaced as warnings and never dropped.
- **Backfill migration recipe.** `turbine migrate create <name> --recipe
  backfill` scaffolds the sanctioned two-phase pattern for changing a
  populated column's type: nullable add, batched keyed `UPDATE` loop,
  `SET NOT NULL` (with the `CHECK ... NOT VALID` + `VALIDATE` note for huge
  tables), and an atomic rename swap, fully commented and reversible.
- **Check constraints round-trip.** Table-level `checks` now survive
  `generate`: the metadata emitter writes them into `metadata.ts`, and
  `schemaDiff` diffs named checks (add missing, warn on expression drift).
- **`TURBINE_CACHE_CHECK_SAMPLE`.** Opt-in sampled production re-verification
  of the SQL template cache: set it to a rate in (0, 1] and that fraction of
  cache hits rebuild the statement and compare byte-for-byte, logging once per
  fingerprint and throwing on mismatch. The dev-mode always-on cross-check is
  unchanged.

### Changed

- **The where-clause walk is unified, at every level.** `fingerprintWhere`,
  `buildWhereClause`, and `collectWhereParams` (the three-way hand-synced
  functions behind two previously shipped cache bugs) now consume one
  canonical enumeration (`walkWhere` in `src/query/where-compile.ts`) with a
  single column-aware scalar classifier. The relation sub-where walkers
  (the relation-filter `EXISTS` body and the relation `with`-clause `where`)
  are consumers of the same walk through one shared scoped trio, so no
  hand-mirrored where walker remains anywhere in the query builder. The
  dev-mode cross-check and the new sampled production cross-check stand as
  tripwires on top.
- **The query builder is physically decomposed.** The 7,000-line
  `query/builder.ts` is now a 2,300-line execution facade over four cohesive
  modules (`query/where.ts`, `query/relations.ts`, `query/writes.ts`,
  `query/aggregates.ts`). Pure refactor: the public `QueryInterface` API is
  unchanged and the emitted SQL is byte-identical (the full suite's exact SQL
  assertions pass with zero expectation edits).
- **Studio CSP hardened.** The inline UI script is authorized by a
  per-request nonce (`script-src 'self' 'nonce-...'`); `unsafe-inline` is gone
  from `script-src`. Mutating routes reject absent as well as mismatched
  `Origin` headers.
- **`redactUrl` redacts every credential.** Multi-URL strings (primary plus
  replicas) have all userinfo passwords redacted, plus case-insensitive
  `password=` query parameters.
- **PowQL literal escaper version ceiling.** The embedded
  literal-materialization fallback (pre-0.14 addons) now refuses to run
  against an engine line newer than the escaping rules were verified on
  (`POWQL_LEXER_TESTED_CEILING`), with a typed upgrade-pointing error, instead
  of assuming a future lexer tokenizes escapes identically.
- **Bundle-size claims are measured and gated.** `.size-limit.js` budgets are
  re-baselined to measured brotli sizes (main 52.36 kB, edge 39.78 kB) and
  `npm run size` now runs in `prepublishOnly`, so stale size marketing cannot
  ship again.
- **Docs honesty pass.** New "Migrations in Practice" page documenting exactly
  what `migrate create --auto` cannot do (blind `USING` casts, rename
  detection, `SET NOT NULL` backfill) and the sanctioned recipes; the
  `schemaDiff` example now matches the real signature; the engines page states
  up front that the CLI drives PostgreSQL only; `TURBINE_E018` added to the
  README error table; every "read-only Studio" claim reconciled with the
  opt-in write mode.

### Fixed

- `turbine push` could apply destructive statements without confirmation
  (it bypassed the gate `migrate up` already had).
- Declared-index emission could produce duplicate index names against the
  automatic FK indexes (apply-time failure) or silently skip a declared
  UNIQUE index whose name matched an existing plain index.
- `--recipe` with a missing name now errors instead of silently creating a
  plain migration.
- `push --help` now documents `--allow-destructive`.
- `schemaDiff` undeclared-index warnings now fire whenever a table defines an
  `indexes` array, including after the last declaration is removed (they were
  previously silenced exactly when the operator most needed them).
- A relation filter with a `null` value (`{ some: null }`) is now treated
  identically by the SQL build and the cached-parameter collection paths
  (latent asymmetry, unreachable through the public types).
- The SQL-cache segment for global filters now fingerprints another table's
  filter with that table's own column/relation context. Previously, a
  function global filter whose shape varied inside a nested relation filter
  could collapse two different SQL texts onto one cache entry (an exotic
  configuration; the dev-mode cross-check would have caught it).

## 0.35.0 (2026-07-16)

PowDB 0.14/0.15 adoption: the embedded transport joins the native typed wire,
relation loading can compile to native server-side joins, read-only snapshot
serving is a first-class deployment mode with a typed routing error, and every
engine gains `explain()`. Adversarially reviewed pre-release (19 findings
confirmed and fixed, including three high-severity ones and two pre-existing
loader bugs the new parity testing exposed).

### Added

- **Native PowQL joins for relation loading (PowDB >= 0.13).** Passing
  `relationLoadStrategy: 'join'` (per query, or client-wide via the new
  `TurbinePowdbOptions.relationLoadStrategy`) compiles eligible top-level
  relations - hasMany, hasOne, belongsTo, and many-to-many through the
  junction - to hash-accelerated server-side joins instead of keyed batch
  lookups: no key lists, no 1,000-key chunking. Eligibility requires no parent
  `limit`/`offset` and a unique (or primary-key) correlation column;
  ineligible relations silently use the batched loaders, so results are
  identical either way. PowDB's default remains the batched loaders.
- **Embedded native typed transport (PowDB addon >= 0.14).** Embedded queries
  now run through the engine's parameterized `queryWithParams` API: real
  positional `$N` binding (token-level, injection-inert) and the same lossless
  typed result cells as the networked wire, decoded by one shared path. A JSON
  `null`, a missing field, and the string `"null"` are now distinguishable on
  the embedded transport too. Older addons keep the literal-materialization
  path unchanged. Embedded `disconnect()` now performs a real checkpoint-flush
  `close()` on addon >= 0.14.
- **Read-only snapshot serving (PowDB >= 0.14).** Open an embedded snapshot
  with `turbinePowDB({ embedded: dir, readonly: true }, schema)`, or point at
  a `powdb-server --readonly`. A new `ReadOnlyError` (`TURBINE_E018`) is the
  routing signal: `reason: 'snapshot'` means nothing can write there (route
  writes to the primary), `reason: 'rbac'` means this connection's role may
  not write. A client-level `readonly: true` option fails writes fast locally,
  before the wire, on both transports.
- **`explain()` on every table accessor.** `db.posts.explain(args)` compiles
  the exact statement `findMany(args)` would run and returns the engine's plan
  as text lines: `EXPLAIN` on PostgreSQL/CockroachDB/YugabyteDB and MySQL,
  `EXPLAIN QUERY PLAN` on SQLite, native `explain` on PowDB (lowered executed
  plans since PowDB 0.14, selectivity estimates since 0.15). SQL Server throws
  a typed E017. Plan text is diagnostic output, not a stable API, and
  middleware does not run for it.
- **Driver-spec error taxonomy.** PowDB error mapping now covers the full
  quasi-stable family list from the upstream driver spec: query timeouts keep
  the engine's message, client-disconnect cancellations map to
  `ConnectionError`, bounded-join rejections map to `ValidationError` with the
  engine's fix hint, and `database is closed` maps to `ConnectionError`.

### Fixed

- Two pre-existing PowDB relation-loader bugs, exposed by the new
  join-vs-loader parity testing: a relation correlated on a datetime column
  silently stitched to empty (Date object identity was used as a map key), and
  a relation `select` that omitted the foreign key returned `[]` (the
  correlation column is now fetched internally and stripped from the output).
- `$transaction` on PowDB now carries the pool's `readonly` flag and
  capability set into the transaction scope; previously the read-only
  fail-fast guard and version gates did not apply inside transactions.
- An embedded PowDB transaction queued behind the single-writer gate when
  `disconnect()` ran no longer executes against the closed handle; it fails
  with a typed `ConnectionError`.

### Changed

- Dev/test matrix pinned to PowDB 0.15 (client, embedded addon, server). 0.15
  itself required no driver-surface changes: its per-index statistics and
  cardinality-aware conjunction planning benefit Turbine-generated queries,
  including the new native joins, with no code change.
- The upstream PowDB driver spec (`docs/integrations/powql-for-drivers.md` in
  the PowDB repository) is now the contract the driver is built against.

## 0.34.0 (2026-07-15)

PowDB engine parity with PowDB 0.12/0.13: the JSON document API, the lossless
native wire, code-first doc-field indexes, catalog introspection, and typed
connection errors. Adversarially reviewed pre-release (16 findings confirmed
and fixed, including a CJS build break and a retry race).

### Added
- **JSON documents on PowDB (engine >= 0.12).** The `json` column type is
  first-class: objects and arrays bind as typed document parameters, and
  Turbine's existing JSON API compiles to PowQL path expressions with every
  path segment and value bound as a typed parameter:
  - `JsonFilter` where-filters (`equals`/`not`/`gt`/`gte`/`lt`/`lte`/`hasKey`),
    top-level and inside relation filters. A digit-only segment addresses an
    array index (SQL-engine parity). `equals: null` matches a JSON `null` or a
    missing key on PowDB (documented divergence). `contains` and pathless
    `equals` throw a per-operator E017 (PowQL has no containment operator).
  - JSON-path `orderBy` (with numeric casting) and `groupBy` JSON-path group
    keys and aggregate targets, with the same alias, ordering, and error
    semantics as the SQL engines (including `_count` being selected by
    default and orderable without being requested).
  Every JSON feature is capability-gated: pre-0.12 engines get a typed E017
  with an upgrade hint instead of an engine parse error.
- **Native typed wire (engine >= 0.13, networked).** The networked transport
  uses PowDB's lossless `queryNativeRaw` API when the client and server
  support it: a JSON `null`, a missing field, and the string `"null"` are
  distinguishable end-to-end, and every result is coerced according to the
  wire that actually served it (heterogeneous injected pools included).
- **Doc-field expression indexes (engine >= 0.13).** `defineSchema` accepts
  `indexes: [{ docField, path, unique? }]` (and plain column indexes);
  `powqlSchemaDDL` emits the parenthesized `alter T add index (.col->"seg")`
  DDL. Numeric path segments are validated as non-negative integers at
  schema-build time. Declared code-first indexes never arm the missing-index
  advisor (SQL DDL generators do not create them).
- **Catalog introspection (engine >= 0.10).** `introspectPowdbDatabase`
  (exported from `turbine-orm/powdb`) reads a live PowDB catalog via
  `schema` and `describe` statements into `SchemaMetadata`. Relations are
  always empty (PowDB has no declared foreign keys) and the primary key is
  inferred heuristically, so `defineSchema` remains the recommended path.
- **Typed connection errors + opt-in stale-read retry.** Protocol-level
  failures (including the "received unexpected frame" shape produced by a
  stale idle socket) map to `ConnectionError` (E004) with `.cause` preserved,
  and `auth_failed` maps to a typed error. The `retryStaleReads` option
  replays a first-statement read once on that exact signature: never a
  write, never inside a transaction (the action is threaded per call, so
  concurrent operations cannot confuse the retry decision).
- Unique doc-field index violations map to `UniqueConstraintError` (E008).

### Changed
- **JSON-path `orderBy` defaults to NULLS LAST in both directions** on
  PostgreSQL and SQLite (previously PostgreSQL's `DESC` default put
  null/missing-path rows first). This matches pick-row relation ordering
  (0.33) and engines whose path ordering is nulls-last in both directions,
  so the same query orders identically across every driver. Pass
  `nulls: 'first' | 'last'` to override.
- **PowDB `protocol_error`-class failures now surface as `ConnectionError`
  (E004) instead of `ValidationError` (E003).** Update error handling that
  matched on E003 for connection-shaped failures.
- Engine note documented: `_sum` over a group with no value at the JSON path
  returns `null` on SQL engines and `0` on PowDB.

## 0.33.0 (2026-07-15)

### Added
- **Opt-in LATERAL plan for pick-row relation ordering** (PostgreSQL). Pick-row
  ordering entries accept `plan: 'lateral'` to compile as
  `LEFT JOIN LATERAL (SELECT ... ORDER BY ... LIMIT 1) ON true` instead of the
  default correlated scalar subquery. Results are identical (verified
  row-for-row on live PostgreSQL, including NULLS placement, pagination, the
  batched relation-load strategy, and streaming); the join plan can be
  substantially faster on large parent sets where the ordering subquery
  dominates. The default plan's SQL is byte-for-byte unchanged. `plan` is
  validated strictly: unknown values throw E003, and dialects without lateral
  join support (SQLite, MySQL, SQL Server, PowDB) throw a typed E017 via the
  new `supportsLateralJoin` dialect capability flag rather than emitting
  broken SQL. Lateral applies to top-level ordering entries; nested pick
  ordering keeps the subquery plan.

## 0.32.2 (2026-07-15)

### Fixed
- **`groupBy` can order by every column the result actually contains.**
  `orderBy` on `groupBy` previously validated keys against the table's
  physical columns only, so ordering by a JSON-path group-key alias threw
  E003 and ordering by an aggregate threw E005, even though HAVING already
  accepted both. `orderBy` now supports plain by-columns, JSON-path group-key
  aliases (explicit or default), `_count`, and `_sum`/`_avg`/`_min`/`_max`
  blocks including JSON aggregate targets keyed by their alias, with
  `{ sort, nulls }` specs, on all four SQL dialects. The ORDER BY re-emits
  the same expression as the SELECT list (already-bound JSON path parameters
  are reused, no extra binds). Ordering by an aggregate that was not
  requested, or by an unknown key, throws a `ValidationError` listing the
  valid keys for that call. PowDB refuses aggregate order keys with a typed
  E017 instead of emitting invalid PowQL.

## 0.32.1 (2026-07-14)

A first-run and hardening release: the new-project funnel now works out of the
box on current tooling defaults, the SQL cache polices its own invariants in
dev, and a latent MySQL pagination-cache bug is fixed. Fully adversarially
reviewed (11 findings confirmed and fixed pre-release).

### Fixed
- **CommonJS projects work with the CLI.** `npm init -y` on npm 11 writes
  `"type": "commonjs"`; in such projects the config and schema loaders received
  a CJS-interop double-wrapped `default` export, read every field as
  `undefined`, and every command failed with a misleading "No database URL
  provided". Both loaders now unwrap the interop shape, and config load errors
  are surfaced with the file name and cause instead of being silently
  swallowed. `turbine init` prints a note about the project module type.
- **MySQL pagination cache correctness.** On dialects that inline LIMIT/OFFSET
  literals into SQL (MySQL), the values are now part of the SQL-cache
  fingerprint (top-level and per-relation `with` limits). Previously a cache
  hit could silently reuse a different limit or offset value. Parameterized
  dialects (PostgreSQL, SQLite, SQL Server) are unaffected.
- **`distinct` cache fingerprint** now uses the user-supplied column order,
  matching the emitted `DISTINCT ON` clause.
- **Published tarball ships no install scripts.** `prepare` is stripped at pack
  time and restored afterward, so consumers using install-script auditing get
  no warnings. Local dev hook installation is unchanged.
- **Docs accuracy sweep** in `docs/USING-TURBINE-ORM.md`, the README, and the
  site: Studio described as it exists today (ORM-native builder, port 4983),
  the real `db.pipeline([...])` API (atomic by default, `{ transactional:
  false }` to opt out), error table extended through E017, CLI command list
  matches `turbine --help` (including `mcp` and `migrate deploy`), CJS wording
  made precise, and the quickstart requires Node 20 to match `engines`.

### Added
- **CLI auto-loads `.env`.** Every `turbine` command loads a local `.env` at
  startup (via `process.loadEnvFile`, Node 20.12+). Variables already in the
  environment always win, a warning is printed when an `.env`-sourced
  `DATABASE_URL` overrides a differing `url` in `turbine.config.ts`, and
  unreadable `.env` files degrade to a warning instead of crashing.
- **`turbine()` with no arguments** now falls back to the `DATABASE_URL`
  environment variable when no pool, connection string, or explicit connection
  fields are provided, matching what the docs and generated JSDoc always said.
- **Dev-mode SQL-cache cross-check.** When `NODE_ENV` is not `production`,
  every SQL-cache hit rebuilds the statement fresh and verifies the cached SQL
  and parameters match exactly, throwing a `ValidationError` (E003) on any
  lockstep mismatch. Zero overhead in production; disable with
  `TURBINE_DISABLE_CACHE_CHECK=1`. This class of invariant violation shipped
  silent wrong-results bugs twice before; it now fails loudly at development
  time.
- **Broader driver-error mapping.** `wrapPgError` now maps `57014`
  (server-side `statement_timeout` cancellation) to `TimeoutError` (E002), and
  connection-class failures (SQLSTATE `08xxx`, `53300`, `57P01`-`57P03`, plus
  driver-level `ECONNREFUSED`/`ECONNRESET`/`ETIMEDOUT`/`ENOTFOUND`/`EPIPE`) to
  `ConnectionError` (E004), all preserving the original error as `.cause`.
- **Quickstart smoke gate in CI.** A new job installs the packed tarball into a
  scratch CommonJS project and runs the documented quickstart literally (init,
  push, generate, first query via `turbine()` with an `.env`-sourced URL)
  against a real PostgreSQL service.

### Changed
- **Benchmarks re-measured on 0.32.0** against Prisma 7.6 (adapter-pg,
  `relationJoins`) and Drizzle 0.45 on local PostgreSQL 17.9 over a Unix
  socket, which isolates per-query overhead instead of hiding it behind
  network latency. All ten scenarios published, including the ones Turbine
  does not win. README, the site benchmarks page, and `benchmarks/RESULTS.md`
  all carry the new numbers and methodology.

## 0.32.0 (2026-07-13)

The last two raw-SQL escape hatches for version-driven data models, designed
first and adversarially reviewed (14 findings confirmed and fixed pre-release,
including two cache/SQL-validity bugs in the new code itself).

### Added
- **Pick-row relation ordering.** Order parents by a column or JSON path taken
  from ONE row of a to-many relation, chosen by an inner ordering and optional
  filter: `orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' },
  where: {...} }, by: { field: 'data', path: ['title'] }, direction: 'asc' } }`.
  Compiles to a correlated scalar subquery in ORDER BY (no FROM-clause
  restructuring), cache-safe, works with both relation-load strategies.
  Parents with zero related rows sort last by default. hasMany only;
  not combinable with `distinct` (clear error); plain-column `by` works on
  SQLite/MySQL/SQL Server, JSON `by` follows the JSON-ordering dialect rules.
- **JSON-path group keys and aggregate targets in `groupBy`.**
  `by: [{ field: 'data', path: ['category'], alias? }]` and
  `_sum: { price: { field: 'data', path: ['price'] } }` (also `_avg`, `_min`,
  `_max`; `_sum`/`_avg` always cast numeric). `having` works on the aliases;
  result-key collisions are detected on the EMITTED column names and throw
  upfront.
- **`distinctOn` row source for `groupBy`** (Postgres only): aggregate over the
  newest row per key, `distinctOn: { columns: ['instanceId'], orderBy:
  { createdAt: 'desc' } }` wraps the row source in `SELECT DISTINCT ON`.

### Fixed
- **`distinct` combined with any relation-based `orderBy`** (`_count`, to-one
  column, and the new pick shape) crashed at runtime with invalid SQL
  ("missing FROM-clause entry"). Now rejected with a clear `ValidationError`
  upfront. The `_count`/to-one crash predates this release.
- **SQL-cache collision on multi-column to-one relation `orderBy`.** The cache
  fingerprint sorted entries while the compiler preserved their order, so
  `{ name: 'asc', email: 'desc' }` and the swapped literal shared one cache
  entry and a warm cache silently served the wrong ORDER BY precedence. The
  fingerprint now captures insertion order. Predates this release.
- **JSON-path parameters now encode per dialect.** SQLite/MySQL/SQL Server
  JSON extraction takes a `'$.a.b'` JSONPath string, not a Postgres
  `text[]` — JSON filters, JSON ordering, and the new JSON groupBy now
  actually execute on those engines (verified live on `node:sqlite`).
  Predates this release for JSON filters/ordering.

## 0.31.0 (2026-07-13)

Three production-blocking bug fixes plus two new query capabilities that
eliminate common raw-SQL escape hatches in version-driven / multi-tenant
data models.

### Fixed
- **Owned-pool `disconnect()` leaked every driver connection** on the
  networked PowDB path — `turbinePowDB({host, port})` never patched
  `disconnect()`, so the driver pool's `close()` never ran and a one-shot
  script hung until the server's 300s idle timeout. Owned pools now close on
  `disconnect()`, and `PowdbPool.end()` additionally destroys still-checked-out
  clients (the driver's `close()` only reaps idle ones). Queries after
  `disconnect()` throw a typed `ConnectionError` on both transports.
- **Nested-relation `orderBy` rejected camelCase columns** —
  `with: { fields: { orderBy: { sortOrder: 'asc' } } }` threw E003 because the
  relation-subquery path skipped the target table's columnMap. Nested orderBy
  now accepts exactly what top-level orderBy accepts, unified across the join
  strategy, batched loader, m2m, and the MSSQL override; belongsTo/hasOne
  subqueries with an `orderBy` now order before their `LIMIT 1`.
- **Cold-client false E017 on a same-tick transaction burst** — the
  re-entrancy marker was planted with `AsyncLocalStorage.enterWith()` in the
  caller's context, so sibling `$transaction` calls launched in one tick could
  see each other's markers (runtime-dependent).
  The marker now lives only inside the transaction callback's async subtree
  via a new optional `wrapTransactionCallback` driver seam — the failure is
  impossible by construction. Implicit nested-write transactions plant the
  same marker. One contract change: a second raw manual `begin` from the same
  context now queues FIFO (bounded by `transactionQueueTimeoutMs`) instead of
  throwing E017.
- **Connection release now honors the destroy contract** (adversarial-review
  finding): `release(err)` with a truthy error destroys the connection instead
  of re-idling it, and any release with an un-ended `begin` fires a bounded
  best-effort `rollback` first — so a `$transaction` timeout can no longer
  return a connection with an open server-side transaction to the pool (which
  blocked the next transaction on PowDB's global write lock).

### Added
- **Column-to-column `where` comparison** — `{ equals: { col: 'otherField' } }`
  (also `not`/`gt`/`gte`/`lt`/`lte`) compiles to `"a" = "b"` with no bound
  param; cache-fingerprint-safe, works in relation filters and `with.where`.
  On json/jsonb columns an `equals` object stays a JSON value.
- **JSON-path `orderBy`** on same-table json/jsonb columns —
  `orderBy: { data: { path: ['weight'], direction: 'asc', type: 'numeric' } }`,
  top-level and in nested `with` orderBy. Cross-relation JSON ordering and
  grouped JSON aggregates are deferred to a designed
  0.32.

### Docs
- `docs/internal/NEXT-INTEGRATIONS.md` no longer claims PowDB was "declined" —
  the driver shipped in 0.22 and is load-bearing. (Per-call/per-table
  `warnOnUnlimited`, also requested, already shipped in 0.30.0.)

## 0.30.0 (2026-07-13)

Fixes and features for JSONB-heavy, Prisma-migrated workloads, plus
alignment with PowDB 0.10. Adversarially reviewed before ship; 15 review
findings (including one critical) fixed pre-release.

### Fixed
- **JSON/array filters inside relation filters were silently dropped.** A
  `JsonFilter` (`{ path, equals }`) under `some`/`every`/`none` — or in a
  `with.where` — compiled to a broken jsonb equality and matched nothing, with
  no error. Both paths now route through the real JSON/array clause builders,
  with the SQL-cache fingerprint and cache-hit param-collect mirrors kept in
  lockstep.
- **Postgres enum columns failed `createMany` with "column is of type X but
  expression is of type text".** The bulk `UNNEST($n::text[])` form defeated
  Postgres's enum inference. Enum columns (recognized via introspected
  metadata) now get an explicit `::"EnumName"` cast on every write bind —
  create, createMany (`::"EnumName"[]`), update, updateMany, upsert. Gated to
  the Postgres dialect; cross-schema type-name collisions are excluded via the
  newly recorded type schema.
- **FK/relation name collisions produced unsound generated types and
  unreachable relations.** A camelCase FK like `currentVersionId` derived a
  belongsTo that shadowed the scalar column (TS2430 under `--strict`,
  relation-where misroutes at runtime). Relation naming now disambiguates
  per-FK-column (`currentVersion`), with **legacy names preserved wherever
  they were collision-free** — regenerating a working schema does not rename
  its relations. `turbine mcp`, the SQLite/MySQL/MSSQL introspectors, and the
  new `schemaDefToMetadata` all share one naming implementation, and the
  generate-typecheck CI gate now compiles the colliding fixture under strict
  tsc.
- **`turbine-orm/powdb` was unusable from CommonJS with ESM-only
  `@zvndev/powdb-client` ≥ 0.9** (`ERR_PACKAGE_PATH_NOT_EXPORTED`): the CJS
  build lowered the lazy `import()` to `require()`. Optional-peer loads
  (powdb, mysql2, mssql) now route through a `.cts` helper whose
  NodeNext-built copy keeps a real `import()`. Peer ranges widened to
  `>=0.7.1 <1.0.0`.
- **A failed BEGIN no longer emits a best-effort ROLLBACK** (all engines).
  Previously a `$transaction` whose BEGIN threw (e.g. PowDB queue timeout)
  still sent ROLLBACK, which on single-handle engines (embedded PowDB) landed
  inside the *other* open transaction — silent partial commits. The PowDB
  pools additionally refuse to forward commit/rollback from a scope that never
  acquired the transaction gate. (found by adversarial review)

### Added
- **JsonFilter range operators** `gt`/`gte`/`lt`/`lte` (with `path`): numeric
  values compare via a `::numeric` cast, strings as extracted text.
  `db.products.findMany({ where: { data: { path: ['rating'], gte: 4 } } })`.
 
- **`schemaDefToMetadata(def)`** — pure `SchemaDef` → `SchemaMetadata`
  converter, so code-first schemas drive non-SQL engines without a live
  database: `turbinePowDB(pool, schemaDefToMetadata(mySchema))`.
- **PowDB concurrent transactions queue FIFO** instead of throwing E017 under
  the single-writer lock. Re-entrant and nested transactions still throw E017
  immediately (queueing them would deadlock; detection via a chained
  AsyncLocalStorage marker that survives cross-pool nesting). New
  `transactionQueueTimeoutMs` option (default 30000; `0`/`Infinity` waits
  forever) → `TimeoutError` E002 on elapse.
- **`turbine generate --no-timestamp`** — omits the `Generated at:` header so
  regenerated output is byte-identical.
- **`warnOnUnlimited` per call and per table** — `findMany({ warnOnUnlimited:
  false })`, or `warnOnUnlimited: { userProfiles: false }` in config (accessor
  or snake_case keys).
- **PowDB 0.10 alignment:** reserved PowQL words (incl. the new `schema` /
  `describe` keywords) are backtick-quoted automatically in bare-identifier
  positions of generated PowQL; the server's new "transaction gate timeout"
  maps to `TimeoutError` E002.

## 0.29.0 (2026-07-12)

**Feature:** batch `$transaction([...])` pipelines on drivers that support it.

### Changed
- **Batch `$transaction` is one write burst on pipelining drivers.** The array
  form previously awaited each deferred query sequentially — N statements cost
  N round trips even though the batch is a single atomic unit. When the
  checked-out `PgCompatPoolClient` advertises the new additive capability flag
  `supportsPipelining: true`, `transactionBatch` now dispatches every statement
  back-to-back inside BEGIN/COMMIT and collects replies in order
  (`Promise.allSettled` — all in-flight replies drain before a ROLLBACK, and
  the lowest-index failure is thrown, wrapped as before). The PowDB pool's
  checked-out clients advertise the flag; `node-postgres` paths are
  byte-identical to 0.28.x (flag absent → sequential path unchanged), and the
  pipelined path is disabled for dialects with `resultStrategy: 'reselect'`.

### Added
- `PgCompatPoolClient.supportsPipelining?: boolean` — optional, additive; any
  PgCompat driver whose connection preserves FIFO reply order over a single
  socket can opt in to get the batched-transaction fast path.

## 0.28.3 (2026-07-11)

**Patch:** `turbine generate` output typechecks again.

### Fixed
- **Generated client failed `tsc` with TS2415 ("incorrectly extends") since 0.26.** The base `TurbineClient.$transaction` gained the batch-array overload (`$transaction([...queries])`), but the generator's interface-merge for the typed client still emitted only the callback signature — and a merged member must be compatible with the base member on its own. The generated `TurbineClient` interface now redeclares both overloads (typed callback + batch array). Found dogfooding the BataDB demo app on 0.28.2.
- **New regression gate:** `generate-typecheck.test.ts` compiles freshly generated output with `tsc --noEmit` against the repo's own source types (path-mapped), so template ↔ client-type drift can never ship again — string-pin tests alone stayed green through this break.

## 0.28.2 (2026-07-10)

**Post-smoke-audit patch** for 0.28.1 — consumer typecheck + docs honesty.

### Fixed
- **`@types/pg` restored to `dependencies`.** Moving it to `devDependencies` in 0.28.1 broke strict `tsc` for consumers whose projects do not set `skipLibCheck` (published `.d.ts` files import `pg` types). Runtime was always fine; TypeScript-first installs were not. Release gate now requires a pack-install + strict consumer typecheck before publish.
- **README PowDB capability blurb** rewritten to match the real engine (returning writes, auto or UUID PKs, client-side relation loads incl. m2m, nested writes for hasMany/hasOne/belongsTo).
- **Bundle-size claim** clarified as brotli *import graph* excluding `pg`, not dual-build install size.
- **STABILITY.md** stable CLI list includes `doctor`, `mcp`, `migrate deploy`.
- **Committed `site/lib/version.ts`** regenerated so the git tree matches the package version.

## 0.28.1 (2026-07-10)

**Gold-standard OSS hygiene pass** — trust surface for consumers and CI, not a feature drop.

### Improved
- **Error messages include stable codes.** Every `TurbineError` message is prefixed with its code tag (e.g. `[TURBINE_E008] …`) so logs are greppable without structured field access. Branch on `err.code` / `instanceof` — do not parse the message text.
- **Coverage floors ratcheted** to lines/statements 80%, functions 82%, branches 82% (measured actuals ~82–84%).
- **Engine CI jobs are hard gates** (MySQL, SQL Server, CockroachDB, PowDB) — no longer `continue-on-error`.
- **Pack-smoke** verifies `sqlite`, `powdb`, and `adapters` subpath exports in addition to main/serverless/mysql/mssql.
- **Seeded generative SQL-safety fuzz** (`sql-safety-fuzz.test.ts`) over `quoteIdent`, equality/LIKE, and numeric filters.
- **Query module split:** `query/filters.ts` (filter-shape guards + fingerprints) and `query/deferred.ts` (`DeferredQuery` / options types) extracted from `builder.ts`.
- **`@types/pg` moved to `devDependencies`** — runtime `dependencies` is just `pg`.
- **`engines.node` is `>=20`** (matches the CI matrix; Node 18 is EOL).
- **SECURITY.md / STABILITY.md** supported-version tables updated for 0.28.x.
- **CODE_OF_CONDUCT.md** added; linked from README + CONTRIBUTING.
- Internal sprint/strategy scaffolding moved under `docs/internal/`.

## 0.28.0 (2026-07-09)

**Parity sprint — the largest feature release since multi-engine support.** A batch of gaps closed at once: query ergonomics (NULLS ordering, relation `_count`, ordering by a relation), schema completeness (referential actions, code-first enums/arrays/vector/checks), global filters for soft-delete and multi-tenancy, read replicas, a read-only MCP server for AI agents, seed-as-code, a non-interactive `migrate deploy`, Zod generation, and views + generated columns. Everything is additive — the Postgres default and the existing `findMany`/`with`/`where` API are unchanged, and `npm i turbine-orm` still installs only `pg`.

### Added — query ergonomics
- **`NULLS FIRST` / `NULLS LAST` ordering.** `orderBy` values accept a spec object `{ sort: 'asc' | 'desc', nulls?: 'first' | 'last' }` alongside the plain `'asc'` / `'desc'` direction: `orderBy: { lastLoginAt: { sort: 'desc', nulls: 'last' } }` → `ORDER BY "last_login_at" DESC NULLS LAST`. Applies everywhere an `orderBy` is compiled — top-level `findMany`/stream, `groupBy`, and the inner subquery of a `with` relation. Plain directions are byte-identical to before. **Behavioral note:** `NULLS FIRST/LAST` is a PostgreSQL and SQLite feature — on MySQL and SQL Server, explicit nulls placement throws `UnsupportedFeatureError` (E017) rather than emitting broken SQL.
- **Relation `_count` in `with`.** `with: { _count: true }` counts every to-many relation of the table; `with: { _count: { posts: true } }` counts only the named ones. Each becomes a correlated `COUNT(*)` scalar subquery (hasMany + manyToMany via the junction), assembled into a typed `_count: { [relation]: number }` object per row. Coexists with real relation subqueries. Errors: `RelationError` (E005) on an unknown relation, `ValidationError` (E003) on a to-one relation. The batched load strategy computes it with one grouped follow-up per counted relation — output deep-equal to the join strategy.
- **Ordering by a relation.** `orderBy: { posts: { _count: 'desc' } }` orders by a to-many relation's count (correlated `COUNT(*)`); `orderBy: { author: { name: 'asc' } }` orders by a to-one relation's target column (correlated scalar subquery, `{ sort, nulls }` supported). Relation ordering adds no bound params. To-many relations allow only `_count`; to-one allow real target columns. Unknown relation → E005, invalid key/column → E003.

### Added — schema completeness
- **Referential actions on foreign keys.** `references` now accepts `{ target, onDelete?, onUpdate? }` in addition to the `'table.column'` string, and the fluent builder gains `.references(target, { onDelete, onUpdate })`. Actions: `'cascade'`, `'restrict'`, `'set null'`, `'set default'`, `'no action'`; omitted clauses default to `NO ACTION`. DDL emits `ON DELETE …` / `ON UPDATE …`; introspection reads them back from `pg_constraint`, and `schemaDiff` detects action changes (non-destructive `DROP CONSTRAINT` + `ADD CONSTRAINT`). The plain string form is unchanged.
- **Code-first enums.** `defineSchema(tables, { enums: { post_status: ['draft', 'published', 'archived'] } })` declares enum types; columns opt in with `{ type: 'enum', enumName: 'post_status' }`. DDL emits `CREATE TYPE … AS ENUM (…)` before the tables that use it (labels are single-quote escaped), and codegen maps enum columns to string-literal unions.
- **Array columns.** `{ type: 'text', array: true }` emits `TEXT[]` (works with `varchar` lengths → `VARCHAR(8)[]`), maps to `T[]` in generated types, and is queryable with the existing `has` / `hasEvery` / `hasSome` operators end-to-end.
- **pgvector columns.** `{ type: 'vector', dimensions: 1536 }` emits `vector(1536)` and, by default, prepends `CREATE EXTENSION IF NOT EXISTS vector;` (pass `extensions: 'manual'` to emit a comment instead); maps to `number[]`. Gated on the Postgres dialect — a dialect without vector support throws `UnsupportedFeatureError` (E017).
- **Check constraints.** Column-level `check: 'price >= 0'` emits an inline `CHECK (expr)`; table-level `checks: [{ name?, expression }]` emit `CONSTRAINT "name" CHECK (expr)` (or a bare `CHECK` when unnamed). Introspection reads them back. A violation throws `CheckConstraintError` (E011) at write time.
- **New package-root exports:** `ReferentialAction`, `ReferenceDef`, `CheckDef`, `CheckMetadata`, and `DefineSchemaOptions`.

### Added — client
- **Global filters (soft-delete / multi-tenancy).** `TurbineConfig.globalFilters` maps a table accessor to a `WhereClause` — or a `() => WhereClause` evaluated per query build — that is AND-merged into the compiled `WHERE` of every read and mutation, **and every relation subquery targeting that table** (join and batched strategies, relation filters `some`/`every`/`none`, `_count`, and relation `orderBy`). Function filters enable per-request tenancy via closure. `create`/`createMany` are never filtered. A per-query `skipGlobalFilters: true | string[]` opts out. **Behavioral note:** the empty-`where` guard on `update`/`delete` still checks the *user-supplied* `where`, so a global filter never turns an unguarded mass mutation into an allowed one. Filter shape participates in the SQL cache; values are re-collected per build.
- **Read replicas.** `TurbineConfig.replicas` (connection strings or `PgCompatPool`s) load-balances read-only operations outside a transaction (`findMany`, `findFirst`, `findUnique`, `*OrThrow`, `count`, `aggregate`, `groupBy`, `findManyStream`) round-robin across replicas; ALL writes, `$transaction` bodies, `pipeline`, `raw`/`sql`, `$listen`/`$notify`, and observability flushes stay on the primary. `client.$primary()` returns a cached view that pins every operation (reads included) to the primary — for reading your own writes without replication lag. String replicas are owned pools (closed on `disconnect()`); external pools follow the caller-owns-lifecycle contract. Zero replicas = today's single-pool path, unchanged.
- **Batch `$transaction(DeferredQuery[])` overload.** Pass an array of `build*` deferred queries and they run atomically on one connection (`BEGIN` … each query … `COMMIT`), returning a positionally-typed results tuple. Any error rolls the whole batch back and rethrows; an empty array resolves to `[]`. The callback form is unchanged — `$transaction` accepts either.

### Added — CLI & tooling
- **`turbine mcp` — zero-dependency, read-only MCP server.** Speaks JSON-RPC 2.0 over stdio (protocol `2025-06-18`, server name `turbine-orm`) for AI agents like Claude Code and Cursor. Six read-only tools — `schema_overview`, `table_detail`, `migrate_status`, `doctor_report`, `explain_query` (schema-validated `findMany`-style builder args only — **no free-form SQL**), `sample_rows` (≤ 50 rows, table validated against the introspected schema). Every database access runs inside `BEGIN READ ONLY`; there is no write surface and no raw-SQL execution path. Malformed frames return a JSON-RPC error without crashing. `--include`/`--exclude` scope the exposed tables.
- **Studio / Observe refuse non-loopback binds by default.** `--host` other than loopback (`127.0.0.1` / `localhost` / `::1`) exits 1 unless you pass **`--allow-remote`** (loud warning when you do). Matches the “local single-user tool” security model instead of warn-and-proceed.
- **`turbine migrate deploy` — non-interactive production apply.** Never prompts (works with no TTY): applies all pending migrations inside the same advisory-lock + per-migration-transaction machinery as `migrate up`, reports `N applied`, and supports `--dry-run` to list pending without applying. Refuses to run (exit 1, clear message) on a checksum mismatch or a missing migration file, so a drifted history fails the deploy instead of diverging. It never auto-generates, seeds, or pushes.
- **Seed-as-code.** `turbine seed` resolves the seed from the config `seed` field (or `seedFile` alias) or the first default candidate — `seed.ts`, `seed.js`, then `seed.sql`. `.ts` runs through `npx tsx` (clear error if `tsx` is missing), `.js` is imported (a default-export function is called), `.sql` runs as SQL. New `defineSeed(fn)` export wires up a client from `DATABASE_URL`, runs your function, and disconnects.
- **`turbine generate --zod`.** Emits a `zod.ts` file alongside the generated types with a `XSchema` / `XCreateSchema` / `XUpdateSchema` per table, derived from column metadata (scalars, `z.coerce.date()` for dates, `z.enum([...])` for enums, `.array()`, `z.array(z.number())` for vectors, `.nullable()`; Create/Update optionality mirrors the generated input types). The generated file imports the user-side `zod` dep; the Turbine runtime never does.
- **`turbine generate --include-views`.** Introspects views and materialized views as read-only entities (`isView: true`): codegen emits an entity type and read accessors; a no-PK view's accessor omits the `findUnique` family (`Omit<QueryInterface<T>, 'findUnique' | 'findUniqueOrThrow'>`). **Behavioral note:** every write builder throws `ValidationError` (E003) "cannot write to a view".
- **STORED generated columns.** Introspection detects `GENERATED ALWAYS AS (…) STORED` columns; codegen keeps them in the entity type but omits them from `*Create`/`*Update` inputs. **Behavioral note:** `create`/`update`/`upsert` reject `data` containing a generated column with `ValidationError` (E003) before hitting Postgres.

### Docs
- New pages: **Global Filters**, **Read Replicas**, **MCP Server**, **Seeding**, **Zod Schemas**, and **Views & Generated Columns**. Extended the API Reference (NULLS ordering, relation `_count`, ordering by a relation), Schema & Migrations (referential actions, enums, arrays, vector, checks), Transactions (batch `$transaction`), Relations, and the CLI page (`migrate deploy`, `mcp`, `--zod`, `--include-views`, seed-as-code).
- **Quickstart honesty:** site `/quickstart` documents `tsx`, `"type": "module"`, `schema` vs `schemaFile`, and the empty-DB path (`defineSchema` → `push` → `generate`) alongside the existing-tables path.
- **Comparison copy corrected:** the Drizzle Studio row previously read "paid tier" — local Drizzle Studio is free (only the hosted Drizzle Gateway is paid). Softened across the README, landing page, and Drizzle migration guide.

### Chore
- Removed broken root `npm run examples` script (missing `examples/examples.ts`); added `examples/README.md` index. `npm run dogfood` unchanged.
- Widened optional peer `mssql` to `^10 || ^11 || ^12` (matches tested `mssql@12`).

## 0.27.1 (2026-07-08)

Identical to 0.27.0 with an internal lint cleanup in the destructive-statement scanner; 0.27.1 is the canonical release (0.27.0's npm artifact predates the tagged source).

## 0.27.0 (2026-07-08)

**Destructive migrations now require explicit, triple confirmation.** A migration file containing data-destroying SQL should never run just because it exists — and "one flag and your table is gone" is too easy.

### Added
- **Data-loss gate on `migrate up` and `migrate down`.** Before applying, Turbine scans every pending migration (UP direction) / every DOWN section being rolled back for destructive statements: `DROP TABLE`, `DROP SCHEMA`, `DROP COLUMN`, `TRUNCATE`, `DELETE FROM`, `UPDATE` without a `WHERE`, and `ALTER COLUMN … TYPE` (potentially lossy cast). Comments, string literals, and dollar-quoted bodies are stripped first, so `-- DROP TABLE x` or a seeded string containing SQL never false-positives; `DROP INDEX`/`DROP CONSTRAINT`/`DROP TRIGGER` are deliberately not flagged (recreatable, no row data). When something is found:
  - **Interactive CLI**: prints an itemized report (statement kind, target object, what it destroys), then requires typing the literal phrase `destroy my data`, then a final `yes`. Anything else aborts with nothing applied.
  - **Non-interactive (CI/pipes)**: always refuses; proceeding requires the explicit `--allow-destructive` flag, which also prints a loud warning.
  - **Programmatic API** (`migrateUp`/`migrateDown`): refuses by default with an itemized `MigrationError`; opt in with `allowDestructive: true`.
  - The refusal is checked BEFORE anything runs — a refused batch applies zero migrations.
- (`turbine push` and `migrate create --auto` were already non-destructive: the schema differ has never emitted forward `DROP TABLE`/`DROP COLUMN` statements — dropped columns are detected but excluded from executable statements.)

## 0.26.0 (2026-07-08)

**Dogfood release from migrating a large production Prisma app onto Turbine** — a batch of correctness fixes the migration surfaced, plus the tooling that makes Turbine's correlated relation loading robust on schemas that grew up under batched-loader ORMs: a missing-FK-index doctor, an opt-in batched loading strategy, and an opt-in lean JSON wire encoding.

### Fixed
- **`timestamp` (without time zone) columns are now parsed as UTC (correctness, behavior change).** Both the pg driver default (OID 1114) and nested `json_agg` strings parsed offset-less timestamps in *server-local* time — the same row produced a different instant per deployment region, and every timestamp shifted by the machine's UTC offset. Turbine now pins offset-less timestamps to UTC (`parseDbDate`), matching Prisma/Rails/Django semantics. The OID 1114 parser is registered only for Turbine-owned pools (external/serverless pools are never touched). Opt out with `utcTimestamps: false` if you relied on local-time parsing.
- **`hasOne` relation subqueries correlated in the wrong direction.** The `hasOne` path reused the `belongsTo` correlation (`target.pk = parent.fk`) instead of `target.fk = parent.pk`, producing wrong rows (or type-mismatch errors when the parent column wasn't a key). Only `belongsTo` reverses the correlation now. (Also fixed in the SQL Server `FOR JSON PATH` path.)
- **Wide tables no longer hit Postgres's 100-argument limit in relation subqueries.** `json_build_object` takes 2 arguments per column, so relations targeting tables with >50 columns failed with `cannot pass more than 100 arguments to a function`. The Postgres dialect now chunks into `(jsonb_build_object(…) || jsonb_build_object(…))::json` concatenation.
- **`distinct` + `orderBy` no longer conflicts with Postgres's DISTINCT ON rule.** `SELECT DISTINCT ON (cols) … ORDER BY other_col` is rejected by Postgres unless the DISTINCT columns lead the ORDER BY. Turbine now orders by the distinct columns in an inner query and applies the user's `orderBy` in an outer wrapper. (`distinct` + vector `orderBy` throws a clear validation error instead of emitting broken SQL.)
- **Top-level `select` combined with `with` no longer drops the relation from the result *type*.** When a generated entity interface declares optional relation props, the with-key was also a `keyof T` and the select-narrowing `Pick` silently removed it — forcing users to drop `select` and over-fetch. The with-clause keys are now unioned back into the result type (and `omit` can no longer strip a relation the `with` clause populates). Compile-time regression tests included.

### Added
- **`npx turbine doctor` — missing-FK-index advisor.** Turbine loads `with` relations as correlated subqueries: the child table is probed once per parent row, so an unindexed FK column costs a full table scan *per parent* — pathological on large tables, and invisible on the ORMs people migrate from (batched `IN (ids)` loading pays a missing index only once, so those schemas routinely lack FK indexes). `doctor` introspects the database, derives every column set relations will probe (hasMany/hasOne child FKs, belongsTo reference keys, many-to-many junction keys), reports the unindexed ones sorted by table row count with the exact `CREATE INDEX` statement, and `--fix` writes a ready-to-apply migration. Measured on a production-shaped dataset: one missing FK index turned a 659-parent query into 659 sequential scans of a 357K-row table (17.8s); with the index the same correlated query ran in 62ms — *faster* than the batched equivalent (92ms).
- **Dev-mode missing-index warning.** In non-production, the first query that builds a relation subquery over an unindexed FK logs a one-time warning naming the relation, the table/columns, and the exact index DDL (only when the schema metadata actually carries index info, so `defineSchema`-only users see no false positives).
- **`relationLoadStrategy: 'join' | 'batched'`** — opt-in batched relation loading, as a client-level default (`TurbineConfig`) or per-query on `findMany`/`findFirst`/`findUnique`. `'batched'` runs the base query without `json_agg` subqueries, then one flat follow-up per relation (`WHERE fk = ANY($1)`, chunked at 1,000 keys) and stitches client-side — results are deep-equal to the join strategy (verified by integration tests running both). Useful when FK indexes are missing or result sets are huge (flat rows transfer leaner than nested JSON). Sibling relations and key chunks load concurrently (keys travel as one `ANY($1)` array parameter, chunked at 32K). Honors per-relation `where`/`select`/`omit`/`orderBy`/nested `with`; per-relation `limit` is applied client-side per parent. Transaction-safe (follow-ups run on the same connection). Measured on a production-shaped worst case (8,814 parents × 6 relation trees, unindexed FKs, WAN link): join strategy 6.5s, `batched` ~1.9s — roughly 2× faster than a leading batched-loader ORM's equivalent query (~3.7s) on the same data.
- **Implicit `is` on bare to-one relation filters (Prisma-compatible).** `where: { vendor: { name: { contains: 'x' } } }` now works without the explicit `is` wrapper; `is: null` / `isNot: null` compile to NOT EXISTS / EXISTS. `WhereClause` types to-many relation props as `some`/`every`/`none` filters and to-one props as bare-or-`is`/`isNot`.
- **Relation filters inside `with.where` and at any nesting depth.** A relation's `with … where` can now filter by the relation's own relations (`with: { items: { where: { stage: { is: { active: true } } } } }`), and relation filters recurse through `some`/`none`/`every`/`is`/`isNot` with `OR`/`AND`/`NOT` support at every level.
- **`jsonEncoding: 'positional'`** — opt-in lean wire encoding for `with` relations (Postgres-only, default `'object'` unchanged). Relation subqueries emit `json_agg(json_build_array(…))` instead of `json_build_object('key', …)`, so key names stop being repeated in every nested object of every row; positions are mapped back to keys client-side and parsed output is **byte-identical** to the object encoding (integration tests assert deep-equality under both). Measured on a 14-column hasMany relation: **39% fewer wire bytes** and ~13% faster end-to-end `findMany` — the win grows with column count and result size. Composes with everything (`select`/`omit`, ordered/limited relations, hasOne/belongsTo, m2m, nested trees); `relationLoadStrategy: 'batched'` simply bypasses it (no JSON aggregation there). `benchmarks/json-encoding-bench.ts` reproduces the numbers.

## 0.25.0 (2026-07-06)

### Added
- **`turbineHttp` now accepts your generated client type for fully typed accessors.** `turbineHttp(pool, SCHEMA)` returned the base `TurbineClient`, so the generated typed accessors (`db.users`, `db.posts`, …) were invisible to TypeScript on the serverless/edge path — you had to cast at the call site. It now takes a backward-compatible type parameter: `turbineHttp<TurbineClient>(pool, SCHEMA)` (passing your generated client type) gives the exact same typed accessors as the TCP-path `turbine()` factory, no cast. The runtime object is unchanged — the base constructor already materializes those accessors per schema table — and existing untyped calls keep working (default = base client). Found dogfooding the BataDB edge path. (#30)

## 0.24.0 (2026-07-06)

**Dogfood fixes from building a fresh Next.js app on 0.23.2 (#28).** Five papercuts that made the first-run experience worse than it should be — a silent empty `generate`, two rejected column types, doc drift, undocumented prereqs, and an inaccurate `serial` type. All fixed; the only behavior change is the `serial` mapping (below), which is safe for existing databases.

### Changed
- **`serial` now emits `SERIAL` (int4), not `BIGSERIAL` (int8) — behavior change for NEW pushes.** A `serial` primary key was typed `number` but, being int8, read back over the wire as a **string** for large values — the generated type lied. `serial` now maps to `SERIAL` (int4), whose values fit in a JS `number` and are returned as numbers, so the type is accurate end-to-end. A new **`bigserial`** column type covers 64-bit auto-increment keys (int8; large values still read back as string, now documented). **Existing databases are unaffected:** `turbine push` / `migrate --auto` never auto-narrow a live column's integer width, so a `serial` column created as `BIGSERIAL` before 0.24.0 is left exactly as-is. Only brand-new `CREATE TABLE`s get `SERIAL`. (#28)

### Added
- **`bigserial`, `timestamptz`, and `jsonb` are now first-class `defineSchema` column types.** The docs' type table listed `timestamptz` and `jsonb`, but `defineSchema` rejected them; they now work. `timestamptz` is an explicit spelling of the timezone-aware timestamp Turbine already emitted for `timestamp`; `jsonb` is an explicit spelling of what `json` already emitted. Both aliases (`timestamp`, `json`) still work unchanged. (#28)
- **`TurbineConfig` is now exported as an alias of `TurbineCliConfig`** from `turbine-orm/cli`, matching what the docs import. (#28)
- **`turbine generate --allow-empty`** escape hatch for the two new guards below.

### Fixed
- **`turbine generate` no longer silently emits an empty client.** The `schema` config field is the Postgres schema *name* (default `public`), but the docs told users to put their schema *file path* there — so `generate` introspected `WHERE table_schema = './turbine/schema.ts'`, matched zero tables, and wrote an empty typed client with no error. `generate` now **errors (exit 1)** when `schema` looks like a file path (with a hint pointing at `schemaFile`) and when introspection matches **0 tables**. Pass `--allow-empty` to override. (#28)
- **Clearer CLI error for the CommonJS case.** When a project's `package.json` lacks `"type": "module"`, loading a `.ts` config/schema fails with Node's raw `ERR_REQUIRE_ESM`; the CLI now appends a hint to add `"type": "module"`. (#28)

### Docs
- **`USING-TURBINE-ORM.md` §0 corrected:** the config example used `schema: './turbine/schema.ts'` (should be `schema: 'public'` + `schemaFile:`) and `migrations:` (should be `migrationsDir:`). Added a **CLI prerequisites** section documenting that the CLI needs `tsx` installed and `"type": "module"` in `package.json`, with the exact error messages — neither is set by `create-next-app`. README quickstart updated to match. (#28)

## 0.23.2 (2026-07-03)

### Fixed
- **Published files no longer reference missing source maps.** `sourceMap`/`declarationMap` emitted `//# sourceMappingURL=…` comments in every published `dist/*.js` / `*.d.ts`, but the `files` allowlist excludes the `.map` files themselves — Node ignores the dangling reference, but Next.js/turbopack's stricter loader logged a failed-to-map warning on every stack trace through Turbine. Maps are now emitted only for local builds and never referenced from published output. (#25, #26)

### Changed
- `pg` dependency bumped 8.20.0 → 8.22.0 (upstream fixes; no API change). (#13)
- CI: actions/checkout 5 → 7, actions/setup-node 5 → 6; dev-dependency refresh. Docs site upgraded to Next 16 + Tailwind 4 with a real site-build CI gate, and the site's displayed version is now derived from the root `package.json` at build time (can't drift from the published package). (#4, #12, #23, #27)
- New docs page: **Turbine + BataDB guide** (`turbineorm.dev/batadb`) — typed Turbine over BataDB's edge HTTP driver or direct TCP, with the dual-transport pattern. (#24)

## 0.23.1 (2026-07-03)

**Coordinated release with PowDB `0.8.0`** — the PowDB engine's optional peers now accept the newly published `@zvndev/powdb-client@0.8.0` / `@zvndev/powdb-embedded@0.8.0`, and the full test suite runs green against those exact published artifacts (1113 passing / 0 failing).

### Changed
- **Widened the PowDB optional-peer range to `^0.7.1 || ^0.8.0`** for both `@zvndev/powdb-client` and `@zvndev/powdb-embedded`, ahead of the coordinated PowDB `0.8.0` release. The engine surface Turbine uses (`query` / `write` / `tx` / `returning`) is unchanged in `0.8.0` — Turbine does not call `applyRetainedUnits` — so the widening is safe and additive. Both remain optional peers (`peerDependenciesMeta` unchanged); a default `npm i turbine-orm` still installs only `pg`.

### Fixed
- **CJS build now compiles under TypeScript 6.0.** `tsconfig.cjs.json` sets `ignoreDeprecations: "6.0"` for its `module: CommonJS` / `moduleResolution: node10` pairing, which TS 6.0 otherwise rejects as a hard error (`TS5107`). The `typescript` devDependency floor moves to `^6.0.3` so the option is recognized. Emitted `dist/` output is byte-identical to the previous toolchain (verified by a full `dist` diff); no runtime or API change.

## 0.23.0 (2026-06-29)

**PowDB Phase B — server-generated PKs, many-to-many, nested writes, composite-key upsert — plus a correctness fix for relation filters.** All PowDB-only; the four SQL engines are untouched and `npm i turbine-orm` still installs only `pg`.

### Fixed
- **Relation filters (`some`/`none`/`every`) no longer return stale results on PowDB (correctness, affects 0.22.0).** PowDB's executor caches an `in (<subquery>)` result by **plan shape, ignoring the literal**, so a second relation filter of the same shape with a different value returned the first query's rows (reproduced against the raw embedded addon, no Turbine). Turbine no longer emits an IN-subquery for relation filters: it **resolves the inner predicate to a literal key list** (`resolveRelationFilters`) and filters with `in (<list>)`, which is always correct. This covers hasMany / hasOne / belongsTo (the 0.22.0 shapes) and the new manyToMany filters, at every nesting level, on `findMany`/`findUnique`/`update`/`delete`/`count`/`aggregate`/`groupBy`. Trades one extra round-trip per relation filter for correctness. *(Reported upstream to PowDB; the SQL engines were never affected — they use real `EXISTS`/`json_agg`.)*

### Added
- **Server-generated / auto-increment primary keys.** New `ColumnMetadata.isGenerated` flag distinguishes a DB-assigned PK (serial / `IDENTITY` / PowDB `auto`) from a client-side default. On PowDB, `powqlSchemaDDL` now emits the **`auto`** modifier (`unique auto id: int`) for a generated int PK and `create`/`createMany` let the engine assign the id (read back via `returning`) instead of synthesizing a client UUID. Introspection sets the flag from `nextval(` / `is_identity`; the code generator emits it. **No change to the SQL engines** — the flag is additive and they already omit undefined PKs and rely on `RETURNING`.
- **many-to-many nested reads** — `with: { tags: true }` on a junction relation now loads through the junction (batched, chunked at 1,000 keys), with correct empty-array semantics and nested `where`/`with`.
- **many-to-many relation filters** — `where: { tags: { some/none/every } }` through a junction table.
- **Nested writes on PowDB** — relation ops in `create`/`update` data (`create`, `connect`, `connectOrCreate`, `disconnect`, `set`, `delete`, `update`, `upsert` for hasMany/hasOne/belongsTo) now run through the shared nested-write engine as **one flat top-level transaction** (PowDB is single-writer / no savepoints, so the whole tree commits or rolls back together). Same coverage as the SQL engines.
- **Composite-key upsert on PowDB** — PowQL's native `upsert … on .col` takes a single conflict column, so a composite PK now falls back to an atomic reselect-or-write transaction.
- Live `powdb-integration` coverage for every item above (6 new tests against the real embedded addon), plus build-only DDL tests for the `auto` modifier and the composite-PK fix.

### Changed
- **`powqlSchemaDDL` no longer marks each column of a composite PK individually `unique`.** PowDB has no composite-unique constraint (its `unique` is single-column), and per-column `unique` wrongly forbade, e.g., a member having two tags. Composite-PK columns are now `required` only; a single-column PK still gets `unique`.

### Still unsupported on PowDB (throws `UnsupportedFeatureError` / E017)
- Composite-key **relation filters** and **composite-key m2m** (PowQL has no tuple-`in` `(a,b) in (…)`), nested writes inside `createMany`/`upsert` (use `create`/`update`), and the unchanged Postgres-only set: pgvector, LISTEN/NOTIFY, RLS `sessionContext`, cursor streaming.

## 0.22.0 (2026-06-28)

**New engine: PowDB.** Turbine now runs on [PowDB](https://github.com/zvndev/powdb), a single-node embedded database with its own query language (PowQL — not SQL), behind the same `findMany` / `with` / `where` / `create` API. PowDB is the only engine that runs **both** in-process (embedded) **and** over a network client against the same data. Postgres remains the default and primary target; PowDB is an additive optional-peer subpath export — `npm i turbine-orm` still installs only `pg`.

### Added
- **`turbine-orm/powdb`** — `await turbinePowDB(target, schema, options?)`. Because PowQL shares no surface with SQL, this is **not** a `Dialect`: a parallel `PowqlInterface` (PowQL generator with the same public method surface as `QueryInterface`) is wired in via the new `queryInterfaceFactory` seam, leaving the four SQL engines byte-identical.
  - **Two transports.** Embedded (in-process) via the native addon `@zvndev/powdb-embedded`, and networked via `@zvndev/powdb-client` against a `powdb-server`. Both are optional peer dependencies (`^0.7.1`), loaded by dynamic `import()` — neither is pulled by a default install.
  - **Embedded durability control.** `turbinePowDB({ embedded, syncMode: 'full' | 'normal' | 'off', memoryLimit })` exposes PowDB 0.7.1's `setSyncMode` / `openWithMemoryLimit`. With `syncMode: 'normal'`, embedded writes drop ~440× (fsync off the commit path) and **beat SQLite** on `create` (0.009 vs 0.016 ms p50), `update` (0.008 vs 0.012), `createMany` (0.278 vs 1.197), and nested `with` — while keeping a real storage engine, indexes, and WAL. `syncMode` / `memoryLimit` are feature-detected; using them on a pre-0.7.1 addon raises a clear `ConnectionError`.
  - **Honest capability surface.** PowDB writes use the `reselect` strategy with client-assigned UUID PKs (PowDB generates no IDs), N+1 relation loaders (no `json_agg` — keys chunked at 1,000), single-writer transactions (no nesting), and code-defined schemas via `defineSchema` (no wire introspection). Not-yet-built capabilities throw `UnsupportedFeatureError` (`E017`): many-to-many relation filters/nested reads, composite-key relations/reads/upsert, nested writes, cursor pagination / `findManyStream`, JSON/array/full-text/pgvector filters and vector ordering — plus the Postgres-only trio (pgvector, LISTEN/NOTIFY, RLS `sessionContext`).
- **`/engines#powdb` docs** — a full PowDB section (both transports, `syncMode`, the embedded-beats-SQLite benchmark, the E017 list, and the platform-binary caveat), plus PowDB coverage in the README "Database engines" section and `benchmarks/CROSS-ENGINE-RESULTS.md`.
- **`src/test/powdb.integration.test.ts`** — 10 tests exercising the real embedded addon (gated via `skipGate` so the unit lane stays green without it) and wired to a new in-process `powdb-integration` CI job (live addon on Linux, no container).

### Fixed
- **Empty-`where` guard now gates on the compiled PowQL filter**, mirroring the SQL path — `{ OR: [] }` / `{ AND: [] }` / `{ NOT: {} }` / `{ OR: [{ field: undefined }] }` can no longer bypass the mass-mutation guard on `updateMany` / `deleteMany`.
- **Single-writer transaction model hardened.** A re-entrant or concurrent `db.$transaction` on the networked transport used to hang forever on PowDB's global write lock; a pool-level `activeTransaction` guard (both transports) now throws `E017` immediately. Nested `tx.$transaction` likewise throws (no savepoints).
- **Embedded driver errors are now typed.** Embedded addon failures (every one tagged `GenericFailure`) are mapped by message shape to the right Turbine error (`E010` not-null, `E003` type/parse, `E008` unique), and addon load/shape failures raise a typed `ConnectionError`.

### Notes
- **Platform binaries (embedded).** `@zvndev/powdb-embedded` 0.7.1 ships prebuilt binaries for darwin-arm64 and linux-glibc (x64/arm64); other platforms (musl/Alpine, Windows, Intel macOS) build from source at install. The networked transport has no such constraint. musl/Intel-mac prebuilts are tracked upstream for PowDB 0.7.2.

## 0.21.0 (2026-06-26)

**Multi-dialect: SQLite, MySQL, and SQL Server engines.** Turbine is still Postgres-first, but the query/result core is now engine-agnostic behind a dialect/driver seam, and three new engines ship as additive subpath exports. Drivers are optional peer dependencies — `npm i turbine-orm` still installs only `pg`.

### Added
- **`turbine-orm/sqlite`** — `turbineSqlite(path | ':memory:', schema)`. **Zero new dependency** via Node's built-in `node:sqlite` (Node ≥ 22.5; `better-sqlite3` is a documented fallback for older Node). Single-query nested `with` via `json_group_array`/`json_object` (with a `json()` subresult wrap so nested trees aren't double-encoded), `RETURNING` writes (SQLite ≥ 3.35), `PRAGMA`-based introspection, and savepoint-nested transactions. Runs **in-process** — its full integration suite executes against `:memory:` in the normal unit lane.
- **`turbine-orm/mysql`** — `turbineMysql(config | pool, schema)`. Optional peer `mysql2`; MySQL **8.0+** (enforced on connect). Nested `with` via `JSON_ARRAYAGG`/`JSON_OBJECT`. MySQL has no `RETURNING`, so writes use the new `reselect` strategy (execute, then re-fetch the row); `INSERT … ON DUPLICATE KEY UPDATE` upserts; `information_schema` introspection; `GET_LOCK` migration locking. `createMany` returns `[]` (rows are inserted; re-query if you need them).
- **`turbine-orm/mssql`** — `turbineMssql(config | pool, schema)`. Optional peer `mssql`. Nested `with` via a dedicated `FOR JSON PATH` generator; writes return rows via `OUTPUT` / `MERGE`; `OFFSET … FETCH` paging; `INFORMATION_SCHEMA` + `sys.*` introspection; `sp_getapplock` locking.
- **`/engines` docs page** with a per-engine capability matrix, plus a "Database engines" section in the README and CLAUDE.md.
- **E017 `UnsupportedFeatureError`** — thrown when a Postgres-only feature (pgvector, LISTEN/NOTIFY, RLS `sessionContext`) is invoked on an engine whose capability flag reports it unsupported, rather than failing with a confusing driver error.

### Changed
- **The `Dialect` contract became a real multi-engine seam** — `resultStrategy` (`returning` / `reselect` / `output`), a `TurbineDriver` driver abstraction (every `BEGIN`/`COMMIT`/`SAVEPOINT`/isolation/`set_config` literal now routes through the dialect), `DialectIntrospector`, and additive SQL hooks (`wrapJsonSubresult`, `aggSupportsInlineOrderBy`, `castAggregate`, `buildInClause`, `buildRelationSubquery`, `buildLimitOffset`, `buildUpdate`/`buildDeleteStatement`). **PostgreSQL output is byte-identical and unchanged** — engines that don't define a hook fall back to the exact prior SQL.
- Engine drivers (`mysql2`, `mssql`) are devDependencies + **optional** peerDependencies; the root runtime dependency set remains exactly `pg`. A CI `pack-smoke` check verifies each engine subpath imports with its driver absent, and new `mysql:8` / SQL Server 2022 CI service-container jobs run the real integration suites.

### Fixed
- **MySQL optimistic-lock conflicts now throw `OptimisticLockError`.** On the `reselect` path the version-checked UPDATE was followed by a re-fetch on `where` only (no version predicate), so a conflict silently returned the stale row. The conflict is now detected from the UPDATE's affected-row count — identical behavior to the `RETURNING`/`OUTPUT` engines.

### Also in this release (product-review sprint)
- **Repositioning + onboarding fixes:** README and landing now lead with the "safety bundle" (read-only Studio, PII-safe errors, one dependency, checksummed migrations). Fixed copy-paste-breaking docs: serverless `SCHEMA` casing (the generator now also emits a lowercase `schema` alias), the non-existent `db.$queryRaw` (→ `db.sql`/`db.raw`), `timeoutMs` → `timeout`, and the `withRetry()` "built-in" claim.
- **Security:** closed a LOW stored-XSS gap in the Observe dashboard (`row.model`/`row.action` now escaped); hardened the Studio/Observe token check to SHA-256 + `crypto.timingSafeEqual`.
- **Docs + tests:** new nested-writes, optimistic-locking, and framework-recipes pages; Studio security-perimeter tests (401/403/429/READ-ONLY).

## 0.19.2 (2026-06-10)

**Patch release from a full product review + gold-standard audit** — closes a HIGH silent-wrong-rows hole in the SQL cache, makes two documented-but-broken behaviors actually work, and brings the docs/site in line with what the library does.

### Fixed
- **`where`-key order can no longer cross-bind parameters on a warm SQL cache (HIGH).** The cache fingerprint sorted `where` keys, but the SQL-build and cache-hit param-collect paths iterated object-insertion order — so two queries with the same fields in different key order shared one cached SQL string but pushed parameters in different positions. `findMany({ where: { tenantId, id } })` followed by `findMany({ where: { id, tenantId } })` could execute the cached SQL with the values swapped, silently returning the wrong row (a cross-tenant-leak class when the permuted fields are same-typed). Key enumeration is now canonicalized (sorted) across every fingerprint/build/collect triple — top-level `where`, relation-filter sub-wheres (`some`/`every`/`none`), alias wheres, nested `with` relation order, cursor, and the `findUnique` simple (plain-equality) path. 14 regression tests warm the cache then assert each column binds its own value. Array members (`OR`/`AND`/`NOT`) remain positional.
- **`{ equals: value }` works as plain equality on any column.** `where: { email: { equals: 'a@b.com' } }` — documented in the README and the most common operator a migrating Prisma user reaches for — previously threw `ValidationError` because `equals` was treated only as a JSONB filter key. It now compiles to `"col" = $n` (and `{ equals: null }` to `IS NULL`), parameterized, on the build path, the cache-hit path, and relation filters, while JSON/JSONB columns keep their existing containment behavior.
- **Nested-write input types are now real.** The exported `NestedCreateOp` / `NestedUpdateOp` / `ConnectOrCreateOp` types were referenced by zero code — `create({ data })` was typed as `Partial<T>` so the `create`/`connect`/`connectOrCreate`/`update`/`upsert`/`disconnect`/`delete` relation ops the runtime already supported were invisible to TypeScript. `CreateArgs`/`UpdateArgs` are now generic over the target's relations and surface the full nested-write op palette (matching `nested-write.ts` exactly), recursively, via the same `RelationDescriptor` brand that powers `with` inference. Untyped clients collapse to the old `Partial<T>`, so nothing breaks; generated clients get typed nested writes with no generator changes.

### Changed
- **Middleware docs no longer teach a silently-broken soft-delete pattern.** The README, the `$use` JSDoc, and the site `/queries` + `/observability` pages showed middleware mutating `params.args.where` to inject `deletedAt: null` — which does nothing, because SQL is generated before middleware runs. Replaced with working patterns (query timing, result transformation) plus an explicit "`params.args` is a read-only snapshot" warning, and the soft-delete recipe is now an explicit `where` filter / scoped helper.
- **New docs: `/studio` and `/observability` pages.** Studio (the flagship read-only-Studio differentiator) and the `$observe()` / `$on('query')` / `npx turbine observe` observability surface were undocumented on the site; both now have full pages, in the sidebar and sitemap, with the security model spelled out.
- **`/queries` documents `cursor`, `take`, and `distinct`; benchmarks page carries a measurement-vintage caveat; homepage repositioned** around Postgres-native depth (pgvector, RLS, LISTEN/NOTIFY, full-text) with a side-by-side pgvector comparison, since single-query nested relations are now table stakes across ORMs. Bundle-size claims corrected to the measured ~31 kB (main) / ~22 kB (edge) brotli.
- **CLI help completed.** `turbine observe` and the `migrate create --auto` / `--allow-drift` / `--step` flags are now in `--help`; column alignment fixed.

### Errors
- Site `/errors` page now documents **E015 `OptimisticLockError`** and **E016 `ExclusionConstraintError`** (they shipped in 0.15.0 / 0.18.0 but were never added to the page), and the `check-error-codes` CI gate — which had silently failed since 0.15.0 because its known-classes list was missing both — passes again.

### Tooling / CI
- DB-gated integration tests now report as **skipped** (via a `skipGate()` helper) instead of silently passing 0 tests when `DATABASE_URL` is unset.
- `test:unit` is now a glob instead of a hand-maintained file list (new test files can no longer be silently dropped from the release gate); `test:watch` watches the full suite.
- `npm audit` is a hard gate on production deps (`--audit-level=high`); the YugabyteDB integration job moved from per-PR to a nightly cron (pinned image) to stop burning ~6 min of red CI per push; new `pack-smoke` job installs the built tarball and verifies ESM/CJS/CLI/serverless; `release.yml` gained a post-publish smoke test and skips publishing a version that already exists on npm.
- Added `SECURITY.md` supported-versions refresh, `.github/dependabot.yml`, dead-code removal (`isReadOnlyStatement`, orphaned Studio CSS), and a CLAUDE.md architecture/LOC sync. Backfilled git tags for v0.11.0–v0.14.0 and v0.16.0 (published to npm without tags).

## 0.19.1 (2026-06-09)

**Patch release fixing everything found by the v0.19.0 post-release audit** — most importantly a broken new-user CLI happy path and two remaining silent-wrong-rows holes in the query builder.

### Fixed
- **CLI can load its own scaffolded `turbine.config.ts` again (HIGH).** `turbine init` scaffolds TypeScript files, but every subsequent command failed on current Node: the loader called `module.register('tsx/esm', …)`, which tsx rejects with "tsx must be loaded with --import instead of --loader" on every Node version that has `module.register()` — and the bare catch misreported it as "tsx is not installed", so following the suggested fix didn't help. The loader now uses tsx's supported programmatic API (`tsx/esm/api` `register()`, with a `module.register` fallback only for pre-4.0 tsx), and when registration genuinely fails the CLI reports the real underlying error (new `failed` status) instead of misdiagnosing. `turbine init` also notes the tsx requirement in Next Steps when tsx isn't installed. Verified end-to-end against the built CLI in a clean project.
- **The v0.19.0 unknown-operator guard no longer has a cache-hit bypass (HIGH).** The guard ran only in `buildWhereClause` (the cache-miss path); once an equality query warmed the SQL cache for a field set, a misspelled operator (e.g. `startWith`) flowed through `collectWhereParams` unguarded and executed `col = $1` with the operator object as the value — silently returning wrong rows, the exact bug 0.19.0 headlined as fixed. The guard now runs on **both** the build and param-collect paths (shared `assertBindableEqualityValue`), and unmatched plain objects fingerprint distinctly from equality (`key:obj(...)` vs `key:eq`) so they can never share a cache entry. The same guard now also covers relation-filter sub-wheres (`some`/`every`/`none`). Regression tests warm the cache with equality before asserting the throw.
- **Nested relation `where` now supports the full scalar filter surface (HIGH).** `with: { posts: { where: … } }` was equality-only on the server: operator objects were bound as literal values (silent zero/wrong rows) and `OR` produced `Unknown column "OR"` — while the Studio Query tab offered the full operator palette at every nesting level. Relation `where` (hasMany, belongsTo/hasOne, and manyToMany) now supports operator objects (`gt`/`gte`/`lt`/`lte`/`not`/`in`/`notIn`/`contains`/`startsWith`/`endsWith` + `mode: 'insensitive'`), `null` (IS NULL), and `OR`/`AND`/`NOT` combinators — fully parameterized against the relation alias, mirrored on the cache-hit param-collect path, with shape-aware `with`-fingerprinting (an equality where and an operator where can no longer share a cached SQL string). Misspelled operators in nested wheres throw the same `ValidationError` as top-level ones.
- **The operator guard no longer rejects class-instance equality values.** `where: { data: Buffer.from(…) }` on a `bytea` column threw `Unknown operators "0", "1"…` (and Decimal-style wrappers on numeric columns likewise). Only *plain object literals* — the actual typo shape — throw now; Buffers, Dates, arrays, and other class instances bind as values, consistently on both cold and cached paths.
- **`limit: 0` / `orderBy: {}` on a to-many relation no longer corrupt the query.** `limit: 0` took the wrapped-subquery path but skipped the LIMIT clause (truthiness vs `!== undefined` mismatch), silently dropping nested relations; `orderBy: {}` rendered a dangling `ORDER BY `. `limit: 0` now renders a real `LIMIT $n` (empty array result) and `orderBy` with no defined entries is treated as absent — on both hasMany and manyToMany, build and collect paths.
- **Studio's Query tab now respects `--schema`.** `/api/builder` ran unqualified SQL resolved via the connection's `search_path`, so with `--schema acme` the Data tab read `acme.users` while the Query tab silently read `public.users`. The builder transaction now pins `set_config('search_path', $1, true)` to the configured schema.
- **`npx turbine --version` prints the version again.** Via the `node_modules/.bin/turbine` symlink the package-root walk started in the consumer's tree and never found turbine-orm's package.json; the path is now `realpathSync`-resolved first.
- **`turbine init`'s example schema is now valid.** The scaffold used `type: 'timestamptz'`, which `defineSchema` rejects (the valid name is `timestamp`, which maps to TIMESTAMPTZ).
- **`new TurbineClient(config)` without schema metadata fails fast** with an actionable `ValidationError` pointing at `turbine generate`, instead of an opaque `TypeError: Cannot read properties of undefined (reading 'tables')`.

### Changed
- **README/docs caught up with the v0.19.0 Studio.** The npm README still documented the removed raw-SQL tab, SQL saved queries, the dead SELECT/WITH-only parser, and the pre-0.17.0 `SET LOCAL` timeout form. README, site docs (`/cli`, `/compatibility`, `/transactions`), CLAUDE.md, and the `studio.ts` header now describe the ORM-native reality — the security headline is "no SQL input surface at all". Site version strings (homepage hero, docs sidebar) now come from a single `site/lib/version.ts` instead of being hardcoded per page.
- **Legacy raw-SQL saved queries are dropped with a console notice** when Studio loads `.turbine/studio-queries.json`, instead of silently (the file isn't rewritten until a new query is saved, so the entries remain recoverable).
- **`npm run build` cleans `dist/` first.** The 0.19.0 tarball shipped ~286 kB of stale compiled artifacts from the long-deleted `src/query.ts`.
- **Missing public type exports added**: `WhereClause`, `WhereOperator`, `WhereValue`, `HavingClause`, and `MiddlewareFn` are now importable from the package root (previously `import type { WhereClause } from 'turbine-orm'` failed with TS2305 and there was no deep-import escape hatch).

### Tests
- New suite `where-guard-cache-and-relation-where` (28 tests: cache-warm bypass regressions, Buffer/class-instance equality, nested-relation operator/combinator SQL + param alignment + cache-hit parity, `limit: 0`/`orderBy: {}` edge cases). `relation-limit-param` and the new suite added to `test:unit` (the former had been missing from the list — part of why the cache bypass shipped green). Full suite: 1251 passing, 1 skipped, 0 failures (incl. live-DB integration).

## 0.19.0 (2026-06-09)

**Studio goes ORM-native, plus two correctness fixes to the query builder.** Studio no longer has a raw-SQL surface — every query is composed visually in Turbine ORM and previewed as the exact `findMany` call you'd write. Two query-builder bugs are fixed, one of which silently returned wrong data.

### Changed
- **Studio is now ORM-native** (`src/cli/studio.ts`, `src/cli/studio-ui.html`). The raw-SQL tab, its `/api/query` endpoint, and SQL-kind saved queries are gone. The default (and only) authoring surface is the visual **Query** composer — a `findMany` builder that drills into relations (`with`) recursively to any depth, picking fields (`select`/`omit`), filters (`where`), and `orderBy`/`limit` at every level, with a live TypeScript preview to copy into your code. Tabs are now **Query / Data / Schema**. `orderBy`/`limit` controls are hidden for to-one relations (they always resolve to a single row). Saved queries are builder-only; legacy raw-SQL entries are dropped on load. Polish: system font stack (no external font fetch / CSP violation), `204` favicon, `reltuples` row estimates clamped to ≥ 0.

### Fixed
- **Unknown `where` operators now throw instead of silently returning wrong rows.** A misspelled operator (e.g. `startWith` for `startsWith`, or any unrecognized key) previously fell through to plain equality — `col = $1` with the operator object as the value — quietly returning zero/wrong rows with no error. The WHERE builder now throws `ValidationError` for any plain object on a non-JSON column that matches no known filter shape, naming the offending key(s) and listing supported operators. JSON/JSONB column equality is unaffected. `orderBy` on an unknown field and `select`/`omit` passed as an array (instead of the `{ field: true }` object) now produce the same `[turbine]` + "Known fields" error format.
- **`limit` on a to-one relation no longer crashes the query.** A `with` clause on a `belongsTo`/`hasOne` relation that carried a `limit` (e.g. `with: { author: { limit: 10 } }`) pushed the limit value as a parameter but rendered a literal `LIMIT 1`, leaving an orphaned, untyped `$N` that Postgres rejected with `could not determine data type of parameter $1` (and shifting every later placeholder). To-one relations now ignore `limit` entirely on both the SQL-build and param-collect paths; `hasMany`/`manyToMany` are unchanged.

### Tests
- New suites: `relation-limit-param` (parameter/placeholder alignment, including the to-one-limit regression) and expanded `operator-validation` (misspelled/unknown operators, empty filter objects, orderBy + select/omit shape). Full suite: 1223 passing, 1 skipped, 0 failures (incl. live-DB integration).

## 0.18.0 (2026-06-08)

**Feature release: aggregate filtering, a typed raw-SQL escape hatch, many-to-many + self-relations, pgvector similarity search, RLS session context, and LISTEN/NOTIFY realtime.** This is also the first npm release to carry the 0.17.0 release-readiness fixes below (0.17.0 was tagged in the changelog but never published).

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
