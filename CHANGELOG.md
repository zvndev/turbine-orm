# Changelog

## 0.78.0 (2026-09-06)

A full product review, a gold-standard audit and a three-database end-to-end QA
run found five defects that all share one shape: **the query compiled, the
statement ran, the database returned rows, and the rows were wrong.** No error,
no warning, nothing in a log. The suite was 6,907 tests and green.

It missed them because it is exhaustively self-consistent. Every differential
fuzz compares the compiler against itself, so a rule the compiler applies
uniformly and wrongly agrees with itself perfectly. The write path was tested
one statement at a time rather than against the rule the documentation states,
so `update()` compiling an operator object correctly and `upsert()` compiling
the same object as a literal 200 lines away is two passing tests. The fixes are
below; the tests added with them assert against the stated rule, not against the
neighbouring implementation.

### Breaking

- **`update()`, `delete()` and `upsert()` require a `where` that identifies one
  row.** All three accepted any filter. `update` and `delete` mutated every
  matching row and returned one of them, arbitrarily; `upsert`'s `where` becomes
  its `ON CONFLICT` target, so a non-unique predicate emitted a conflict clause
  no constraint backs and PostgreSQL answered with a bare `Database error 42P10`
  naming nothing the caller wrote. `findUnique` has refused that exact shape
  since 0.73 through a shared helper none of the three called; they call it now,
  and the refusal is E003 naming the unique keys the table actually has, with
  its own sentence for a table that declares none. Use `updateMany` /
  `deleteMany` for "every row matching a filter", which is what they are for.

  Two consequences worth naming. `update({ where: {}, optimisticLock })` is
  refused: a version column is not unique, so that shape silently updated every
  row at that version and reported one, which is precisely the hazard. And the
  refusal message states the cost of its own escape hatch, because
  `allowFullTableScan: UNSAFE` gives up the empty-`where` guard as well, so an
  all-`undefined` `where` then matches every row instead of being refused.

- **`_sum` and `_avg` over `bigint` and `numeric` columns return exact strings.**
  They were passed through `Number()`, which silently rounds past 2^53 and turns
  a money column into a float. The type is now `number | string | null` on
  `AggregateResult` and on the groupBy result. `int4` and float columns still
  return JS numbers, and JSON-path aggregates are unchanged. The `::float` cast
  is gone from the generated SQL for those columns too, which had also collapsed
  distinct averages into ties when ordering by `_avg`.

- **A non-generated primary key is required in the generated `*Create` type.**
  The generator marked every PK optional, so a plain `text` PK or a composite PK
  of two ints typechecked when omitted and failed at the database. Optionality
  now follows the column: server-generated, defaulted or nullable.

- **`mode: 'insensitive'` applies to `equals`, `not`, `in` and `notIn`.** It was
  documented as case-insensitive matching and silently ignored on every operator
  except the LIKE family, so `{ email: { equals: 'A@B.com', mode: 'insensitive' } }`
  ran a case-sensitive comparison. A non-string operand beside the mode now
  throws E003 rather than being ignored.

- **Introspection refuses to generate when two columns of one table resolve to
  the same field.** A table with both `"createdAt"` and `created_at` emitted a
  duplicate interface member and mapped writes to whichever came last. It now
  throws E003 naming both columns, with `--keep-column-names` as the escape
  hatch.

### Security

- **A destructive statement inside a single-quoted routine body passed the
  confirmation gate.** `DO 'BEGIN DROP TABLE users; END'` ran with a clean
  inventory, no prompt and no `--allow-destructive`, verified live on PostgreSQL
  17. The tokenizer filled a statement's block list from the dollar-quote and
  `BEGIN ATOMIC` branches only, so a single-quoted body came back with no blocks
  and the scanner iterated nothing: every pass was skipped, the fail-closed
  "cannot classify" backstop included. Six shapes went through it, `DO` in three
  quoting forms plus `CREATE FUNCTION` and `CREATE PROCEDURE`. The existing
  suites are entirely dollar-quoted, which is why a backstop that had never been
  exercised against this form was green.

- **Two further shapes reached the same gate.** Two adjacent string literals are
  ONE string in PostgreSQL, so a `DROP TABLE` split across two quoted fragments
  read as destructive to the opener test while every rule that could have named
  it declined, and the skip for an already-handled verb was unconditional, so
  the statement was passed over on the strength of a pass that never spoke. And
  `COPY (DELETE FROM t RETURNING *) TO STDOUT` runs the DELETE through a wrapper
  the data-modifying-CTE rule never sees, because that rule fires only on a
  leading `WITH`.

- **And the opposite error, which failed ordinary migrations rather than passing
  destructive ones.** The unclassifiable-`EXECUTE` backstop matched the word
  anywhere in a statement's code, literals included, so `GRANT EXECUTE ON
  FUNCTION f() TO app` and `RAISE NOTICE 'EXECUTE the plan'` both armed the
  gate, and under `migrate deploy` there is no terminal to confirm at. Presence
  is decided against the literal-emptied view now, and the keyword must sit
  where plpgsql can begin a statement. A rewrite rule whose action is an
  `UPDATE` is judged the way a top-level `UPDATE` is, destructive only without a
  `WHERE`, so the standard updatable-view idiom is silent again. Each
  sub-statement of a body is judged on its own and reported once.

### Fixed

- **A multi-field `cursor` compiled to a conjunction, not a keyset.** `cursor:
  { score, id }` emitted `score > $1 AND id > $2`, which drops every row whose
  score ties the cursor's and whose id sorts below it. Paging a 600-row table
  with ties on the leading key visited 250 rows and skipped 350, silently, with
  every page individually well formed.

  It emits the expanded OR-of-ANDs seek now, ordered by `orderBy` precedence and
  honouring each field's own direction. Deliberately not a row-value comparison
  (`(a, b) > ($1, $2)`): that form cannot express a mixed direction and does not
  exist on every engine we target. One authority builds the seek entries for the
  fingerprint, the build and the cache-hit collect, so they cannot drift, and
  the cache key carries the direction of each field.

- **A relation filter on a self-relation correlated a row with itself.** The
  `EXISTS` subquery did not alias its target, so when the target's rendered name
  equalled the parent's, `where: { manager: { some: {} } }` resolved both sides
  of the correlation to the same row and returned nothing. The same file aliases
  correctly in `with` and in `orderBy: { _count }`, which is why it survived
  review. The alias now flows through the correlation, the scoped sub-where, the
  global-filter fragment and nested filters, and the junction gets its own.
  Non-self relations emit the same SQL as before, byte for byte.

- **`distinct` with a narrowed projection emitted SQL PostgreSQL rejects.**
  Ordering by a column that `select`, `omit` or the PII rule had removed put
  that column in the ORDER BY of a derived table that did not select it. The
  ordering columns are projected into the inner table and the outer columns are
  named explicitly, so the extra column never reaches a row.

- **`upsert`'s update branch bound an atomic operator object as a literal
  value.** `update: { name: { set: 'Upserted' } }` stored the TEXT
  `{"set":"Upserted"}` in a text column, and `{ views: { increment: 1 } }`
  failed 22P02 against an int one. `update()` compiles the same object
  correctly two hundred lines away, which is why two passing tests coexisted
  with the bug. The conflict-update SET now routes through the same builder, so
  the five operators mean the same thing everywhere and a misspelled one raises
  the same E003.

- **`upsert` on a table with a global filter failed 42702.** The filter was
  compiled unqualified into the conflict clause, so the column reference was
  ambiguous on both the insert and the update path. It goes through the aliased
  where builder now. A conflict against a row the filter hides inserts nothing
  and updates nothing, and raises E001 naming the filter and
  `skipGlobalFilters`.

- **A failing transactional `pipeline()` released its connection while the
  backend was still `idle in transaction (aborted)`.** The next caller to draw
  that connection from the pool got 25P02 on a query that had nothing to do
  with the failure. The transactional path now issues its own ROLLBACK after
  ReadyForQuery and waits for the status; a connection still in `E` or `T` is
  released with an error so the pool discards it. Non-transactional mode
  discards on a final status of `E`.

- **`turbine migrate` and `turbine seed` ignored the configured schema.** Push,
  generate, doctor and Studio all honoured `config.schema`; these two did not,
  so a code-first project on `schema: 'app'` pushed its tables into `app`,
  diffed against `app`, and applied the resulting migration into `public`,
  tracking table included. Both pin `search_path` through the connection
  parameter now, never a session `SET`. A schema that does not exist is refused
  up front with E006 naming CREATE SCHEMA, because PostgreSQL accepts a bogus
  `search_path` in silence and the eventual error names neither the schema nor
  the setting.

- **Dynamically assembled destructive DDL passed the confirmation gate.** A
  `DROP COLUMN` built inside a DO block, and eight further obfuscations of the
  same shape, ran live without the two-step prompt. Dynamic SQL whose payload
  the scanner cannot classify is now reported as unclassified rather than
  waved through, which is the honest answer: "cannot classify" reported as
  "clean" is the consent gate deciding in the author's favour on no evidence.
  `CREATE RULE ... DO INSTEAD DELETE` is flagged too. The controls hold: a
  dynamic ADD COLUMN, DROP CONSTRAINT or UPDATE with a WHERE stays silent.

- **`migrate down --step` accepted `-1`, `0` and `abc`.** `-1` reached
  `applied.reverse().slice(0, -1)`, which is every migration except the oldest,
  and began tearing down the history newest first. The other two were silent
  no-ops that read as a successful rollback. All three are E003 now.

- **The MCP server ran up to seven queries at once on one client and left its
  transport open after close.** Queries are sequential and close is observable.

- **prisma-compat replaced a caller's array `orderBy` with the primary key
  under a bare cursor.** The documented E017 for a cursor whose field is not
  the sort key never fired, because the check read only the first element. It
  flattens the array now. `OR: []` compiles to a predicate matching nothing,
  and a bare `null` on a to-one relation key means `{ is: null }` instead of
  being read as a column name.

- **`instanceof` on a Turbine error was false in the layout the README
  recommends.** A project with `"type": "commonjs"` and an `.mts` entry loads
  both the CJS and ESM copies of the package through the generated client, and
  each copy defines its own classes. Every error now carries a `Symbol.for`
  brand and `TurbineError` defines `Symbol.hasInstance`, keyed on the code, so
  an error thrown by one copy is `instanceof` the other copy's class and the
  right subclass.

- **An unclassified driver error reached the caller verbatim under
  `errorMessages: 'safe'`.** The whole point of safe mode is that a value never
  reaches a log, and `invalid input syntax for type integer: "<the value>"` is a
  value in a message. SQLSTATE class 22 and tsquery syntax errors map to
  `ValidationError` with the column and the SQLSTATE in the message and the
  driver text on `.detail`. `OptimisticLockError` moves the expected value to
  `.detail` for the same reason. No new error code.

- **Safe mode redacted two driver fields and PostgreSQL puts row values in
  five.** `hint`, `where` and `internalQuery` passed through verbatim, on the
  returned error and on `.cause` alike, with `util.inspect` rendering them.
  Reproduced live: a plpgsql `RAISE ... USING HINT` carried an email address, an
  `EXECUTE format(...)` put a bound value in `internalQuery`, and a cast failure
  rendered `unnamed portal parameter $1 = '...'` into `where`. The last two leak
  through a CLASSIFIED error too, so this was never confined to the unclassified
  path; one list and one helper drive both clone paths now, on every SQLSTATE.

  The scrub was too broad in the other direction as well. `Database error 42P01`
  deleted `relation "orders" does not exist`, the single most useful sentence a
  first-run user sees after forgetting to migrate, kept it nowhere including
  `.cause`, and bought no privacy, because a class-42 message is a grammar over
  schema object names. The driver's message survives now for the classes whose
  grammar cannot hold a row value (08, 3D, 3F, 42, 53, 57, 58), with 42601
  carved out because it quotes a token of the statement and a token can be a
  literal. `P0001` and class 55 still scrub: that text is written by the
  function author. When the text is withheld the message says so and names the
  setting that shows it, and the error gains `.sqlstate` beside its raw `.code`.
  It stays a plain driver error rather than becoming typed, deliberately:
  verbose mode returns the raw error and always has, so minting a `TurbineError`
  under safe mode would make the same database failure a different class
  depending on a log-redaction setting.

- **`mode: 'insensitive'` on `in` / `notIn` folded two different alphabets.**
  The column went through the engine's `LOWER` and the list elements through
  JavaScript's `toLowerCase()`. SQLite's `LOWER` is ASCII-only, so over one row
  spelled with an accented capital and one with an accented lowercase letter,
  the same operand matched one row through `equals` and the other through `in`.
  PostgreSQL folds both sides inside `unnest` unconditionally; every other
  dialect refuses the operator with E017, naming the engine and the branch form
  that works. Restoring it there needs a dialect hook with one verified
  implementation per engine, because each unpacks a bound IN-list in a subquery
  its own dialect writes, and the portable alternative of one placeholder per
  element would make the statement text a function of the list length, which the
  SQL-template cache keys on. `equals`, `not` and the LIKE operators are
  unaffected: they fold a single operand the engine can reach.

- **prisma-compat's empty-`OR` sentinel was dropped, or dropped its neighbour,
  depending on key order.** The sentinel is keyed on a real column of the table
  and was merged with `Object.assign`, so `{ OR: [], id: 5 }` kept `id = 5` and
  returned the row Prisma excludes, while `{ id: 5, OR: [] }` kept the sentinel
  and discarded the caller's own predicate. Same query, same meaning, opposite
  result. It is conjoined now, and the wrapper is branded internal so an empty
  `OR` does not quietly take a compat query off named prepared statements. A
  table whose metadata lists no column throws E003 rather than compiling to an
  empty `where`, which is not "no rows" but its exact opposite.

- **A `globalFilters` entry that was itself a relation filter failed 42P01 on
  two paths.** `aliasWhereScope` takes a bare alias (`t0`) and quotes it for a
  nested relation filter's correlation parent; the batched `_count` follow-up
  and the `upsert` conflict clause both handed it an already-rendered table
  reference, so the EXISTS body named the table three times over. Under
  `relationLoadStrategy: 'batched'` the count therefore failed while the join
  plan answered the same query correctly. A parameter with two meanings is the
  defect, so both callers go through one rendered-reference seam now and the
  bare-alias scope refuses a quoted alias by name. The existing
  strategy-agreement suite could not have caught it: every global filter it
  tested was a plain column filter, whose sub-where never needs a correlation
  parent, and `_count` was not covered because the batched plan answers it with
  a grouped COUNT rather than through the child's `findMany`.

### Added

- `RelationOrderBy` is a depth-bounded chain of to-one hops, matching what the
  builder has always compiled. Two- and three-hop ordering typechecks; the 12th
  hop is refused at the type level as it already was at runtime.
- `UpsertArgs.update` accepts the atomic operator objects `update()` accepts, so
  the type matches the conflict-update compiler.
- `$primary()` returns `this`, so the primary-only view keeps the generated
  table accessors, and the generated client gains a typed `$withSession`
  overload mirroring its typed `$transaction`.
- `OrderBySpec` and `RelationOrderByChain` are exported from the package root
  and the query barrel. `RelationOrderBy` became public this release and is
  written in terms of both, so annotating a variable by hand needed an import
  the package did not offer.
- `--keep-column-names` on `turbine generate`, for a schema that genuinely has
  colliding column spellings.
- `turbine init --schema` writes the schema into the generated config.
- `migrate up --allow-drift` re-baselines a checksum a reviewed edit changed,
  printing one line per file. `down` refuses drift in its own words rather than
  borrowing `up`'s.
- `migrate down --dry-run` and `migrate deploy --dry-run` report through the
  runner's own planner instead of a second copy of the rule. The old dry run
  built its list from `migrate status`, which sorts by filename and drops
  applied migrations whose file is missing, while the real run walks the
  tracking table newest-applied first and stops at the first file it cannot
  read. With a deleted file the two named different migrations, and a dry run
  that names the wrong migration is not a dry run.
- A migration batch containing an empty UP section is refused before anything
  is applied, and a `.sql` file that does not match the timestamp naming is
  warned about rather than ignored.

### CI

- `release.yml` and `nightly.yml` grant `contents: read` at the workflow level;
  only the publish jobs hold `contents: write` and `id-token: write`. All 65
  action references are pinned to full commit SHAs with the version in a
  trailing comment, and the existing Dependabot ecosystem keeps them current.
- A tag push whose version is already on npm fails the run instead of skipping
  silently. A `workflow_dispatch` still skips.
- `check-release-tests.mjs` bypasses the local gate only under
  `GITHUB_ACTIONS=true`. A bare `CI=1` no longer does.
- `lint-staged` runs the same flags as `npm run lint`, so the pre-commit hook
  and CI agree about what a warning is.
- `prepare` runs husky when it resolves and exits 0 otherwise, so a fresh clone
  can install the examples.

### Testing

- `ci-ok-needs-sync.test.ts` asserts what WORKFLOW.md already claimed: every
  `ci.yml` job is in `ci-ok`'s `needs`, and the anti-vacuous literal equals that
  count.
- `docs-claims-sync.test.ts` reads CLAUDE.md against `.c8rc.json`, `package.json`
  and the source tree. Five sentences were stale and are corrected once.
- `docs-snippet-imports.test.ts` refuses a docs snippet that imports a relative
  module with no extension. Twelve had to be fixed to make it pass.
- `verify-skill` creates a bigint and numeric fixture, compares aggregate output
  against the database's own text rendering, and drops the table afterwards.
- The SQLite declared-boolean assertions now ask the same capability question
  the engine asks. They expected `true` / `false` unconditionally while the
  engine deliberately keeps 1 / 0 whenever `StatementSync.columns()` is absent,
  so the file was green only on the part of the supported Node range that has
  the capability and red on the rest. Measured rather than read off a release
  note: `columns()` is absent on Node 22.13.1 and present on 24.18.0.
- `deriveLockId` has a test. It is the advisory-lock id the migration runner
  derives from the database name so sibling databases do not contend, and two
  properties are load-bearing and invisible from the path that uses it:
  stability across processes, and a value inside the positive int4 range
  `pg_advisory_lock`'s one-argument form accepts.
- `src/query/types.ts` is no longer excluded from coverage. It was on the
  type-only list, which is for files that compile to `export {};`, and it has
  carried the `UNSAFE` sentinel and the privilege-option guards since those
  moved in. Measured both ways over the same collected coverage: counting it
  raises the project figure from 96.98 to 97.09, because the file itself reads
  99.67. The exclusion was hiding well-tested runtime code, not denominator
  noise.

- `check-changelog-headings.mjs` gained the check `docs/releases/README.md`
  already told readers existed. No such gate existed, and a document that
  invents a mechanism is worse than one that states a convention, because the
  next reader stops looking. Whether a change is breaking is a judgement no
  regex makes, so the gate does the mechanical part: every `###` heading in the
  entry being released must be one of the sanctioned names. It checks the
  current entry only, because ninety-odd published entries use a wider
  vocabulary and rewriting them to satisfy a rule invented afterwards would make
  the log disagree with the releases it records.
- `ci-ok-needs-sync.test.ts` could not see two legal job shapes, so it failed
  open. Its job parser rejected an uppercase letter in a job id and a key
  carrying a trailing comment; with either shape the job sat outside `ci-ok`'s
  `needs` and all four assertions stayed green. The parser fails CLOSED now: any
  two-space key under `jobs:` that the job pattern did not claim is itself a
  failure, naming the lines. Verified against four mutations.
- `size-claim-sync.test.ts` read README.md, one of six places these numbers
  appear, so the re-baseline below left two false figures on the site's
  comparison table. It walks every tracked README, STABILITY, site and
  release-docs file now and requires each claim to equal a gate, with a floor on
  how many it found so the sweep cannot pass by matching nothing.
- `docs-snippet-imports.test.ts` scanned `site/app` and stopped there, so four
  extensionless imports sat in `docs/USING-TURBINE-ORM.md`, on the two snippets
  a new user reaches first. It walks `docs/` too.

### Measured

- The three size budgets moved: main 87 kB to 91 kB, serverless 69 kB to 72 kB,
  prisma-compat 14 kB to 16 kB, all brotli, in two steps as the review round
  landed. Checked against the esbuild metafile before each step and the answer
  was the same both times: 41 modules, the only `cli/` entries the one
  sanctioned pair, no engine module reachable. The growth is this release's own
  code inside modules already in the graph, and every published claim moved with
  the budgets, in eight places across the README, the site homepage and three
  docs pages.

### Docs

- The queries page carries the keyset cursor, the exact `_sum` / `_avg`
  rendering, the two-hop relation `orderBy` and its depth bound, the `mode` row,
  the `OR: []` semantics, and which warnings survive production.
- The errors page leads with `err.code`, documents the class-22 and tsquery
  mappings and the safe-mode scrub, and drops the old "returned unchanged"
  wording. The optimistic-locking page says the expected value lives on
  `.detail`.
- The migrate-from-prisma page notes that int8 and numeric totals arrive as
  exact strings where Prisma hands back a `Decimal`, and constructs the client
  with both arguments.
- README gains a pre-1.0 note linking STABILITY.md, `Experimental` labels on the
  engines that are, the `"type": "module"` step, the relation names
  introspection actually produces, and the `@types/node` requirement. The fuzz
  sentence is limited to the three strategies it covers.
- The zod page still described the primary-key optionality rule this release
  replaced, on the only page that ever documented it. The queries page claimed
  `_max` of a bigint is a string; it is a number until the value leaves the safe
  integer range, because `_min` / `_max` read one stored cell through the row
  rule while `_sum` / `_avg` follow the column type. That page also offered a
  bare-string `mode` form that does not exist, did not mention that folding both
  sides with `LOWER` puts a plain btree index out of reach, and had no prose at
  all about the new identity refusal on `update` / `updateMany`.
- The errors page says which failures are `TurbineError`s and which stay plain
  driver errors, and what safe mode actually withholds.
- `site/lib/changelog.generated.ts` was stale at 0.76.0 and is regenerated.

## 0.77.1 (2026-08-23)

**No package changes.** The published tarball is functionally identical to
0.77.0; `.github/` is not in `files`. This release exists because the thing it
fixes lives in the release workflow, and a release workflow can only be verified
by running one.

### Fixed

- **The post-publish smoke test could not have succeeded, for any release.** It
  went red on 0.73.1, the retry budget was raised from 12 x 10s to 30 x 10s, and
  it went red again on 0.77.0. Both versions published correctly, with
  provenance. Raising the number twice is how we found out the number was never
  the problem.

  The mechanism is npm's client-side cache, not registry propagation.
  `registry.npmjs.org` serves packuments with `Cache-Control: max-age=300`, and
  npm's `prefer-online` defaults to `false`, so for 300 seconds npm answers from
  its local cache without revalidating. The first attempt runs moments after
  publish and caches a packument that does not yet list the new version; all 29
  later attempts read that cached copy and never reach the network. `30 x 10s`
  is exactly `300s`, so the loop expired at the precise moment its own cache
  would have.

  `--prefer-online` forces revalidation per attempt, which is what makes a retry
  loop a retry loop. The budget stays at five minutes and is now a bound on
  genuine propagation lag rather than a race against a TTL. The failure message
  no longer reads as though the release failed, either: the step runs after an
  irreversible publish, so by the time it can fail the package is on the
  registry and the GitHub Release step still runs.

  This is the same lesson as the rest of 0.77.0, arriving one release later and
  at our own expense: the earlier fix changed a number and left the mechanism
  unexamined, so it came back.

## 0.77.0 (2026-08-23)

0.76.0 published from a commit whose CI was red. Nothing was wrong with the
gates: the failing job was `unit-tests (20)`, and the release went out from a
laptop, which never runs the Node 20 leg. The gates were real, thorough, and
sitting beside the road rather than on it.

That is the release. **Most of what follows moves an existing check onto the
path that actually reaches npm**, and the two user-visible bug fixes are both
cases of an error that could not be caught by the code written to catch it.

### Security

- **A polynomial regular expression on the PowDB type mapper.**
  `tsType.replace(/\s*\|\s*null$/i, '')` strips a trailing `| null` from a
  generated TypeScript type. `\s*` can begin matching at every position, so an
  input of N whitespace characters with no `|` costs O(N^2). Measured on Node 24:
  10,000 spaces took 39.6 ms, 20,000 took 150.3 ms, 40,000 took 617.5 ms.

  It was written **eight times** across `powdb.ts` and `powql.ts`. All eight now
  call one linear `baseTsType`, whose equivalence to the regex it replaces is
  asserted against the real old regex over a corpus and 4,000 generated inputs,
  not against a description of it. The same input that cost the regex 352 ms at
  30,000 characters costs the replacement 0.13 ms at 200,000.

  **Reachability, stated plainly: this was not remotely exploitable.** `tsType`
  comes from a generated `metadata.ts` or from a `defineSchema` call, so it is
  authored by the developer or derived from their own database catalog, never
  from request input. It is fixed because eight hand-copied spellings of one
  predicate is the drift shape this codebase keeps paying for, and because the
  linear version is not harder to read.

### Fixed

- **A pipeline timeout rejected with a bare `Error`, so it could not be
  retried.** `catch (e) { if (e instanceof TimeoutError) retry() }` silently did
  not retry, because the timeout branch in `pipeline-submittable.ts` never
  constructed a `TimeoutError`. It does now, carrying code `TURBINE_E002` like
  every other timeout in the package.

  `executePipeline` in `pipeline.ts` was also missing its `catch` entirely, so a
  raw pg driver error escaped unwrapped past `wrapPgError` and arrived as a
  driver object rather than a typed Turbine error. A unique-constraint violation
  inside a pipeline now surfaces as `UniqueConstraintError` (E008), matching
  every other execution path.

- **A relation payload that would not parse was returned as a raw string.**
  `parseNestedRow` caught a JSON parse failure, logged, and assigned the
  unparsed text to the relation field. A caller who asked for
  `with: { posts: true }` and expected an array received a string, and the
  failure surfaced later and elsewhere, as a type error with no visible
  connection to its cause.

  **This is a behaviour change.** It now throws a `ValidationError` (E003)
  naming the relation, with a once-only dev warning. If you were relying on the
  raw value reaching your code, you were relying on a bug, but the failure mode
  does move from silent to loud.

- **Every error message carried two prefixes.** `formatErrorMessage` prepends
  `[TURBINE_EXXX] `, and 433 call sites also hand-wrote a `[turbine] ` prefix
  into the message they passed in, so the shipped text read
  `[TURBINE_E003] [turbine] Unknown column "titel" on table "posts".` Two
  display-strips in the CLI existed only to undo the doubling at print time.

  Messages now carry one prefix. The 73 remaining occurrences are diagnostics
  that no code tag ever touches (`console.*`, `process.stderr`, Studio's HTTP
  bodies), where the prefix is the only thing marking the line as ours.
  `check:error-prefix` keeps the two populations apart by resolving the
  enclosing callee, because the same literal is correct in one and wrong in the
  other and no context-free rule can tell them apart.

  Error message text is not part of the stable contract (see `STABILITY.md`),
  but this is visible in every log line, so it is worth calling out.

### Changed

- **`main` is now protected and pull-request only.** `ci-ok` is the single
  required status check and `enforce_admins` is on. `ci-ok` aggregates all 19
  CI jobs, so a new job is covered the moment it joins the `needs:` list, where
  a hand-listed set of required contexts silently was not: the previous
  configuration listed eleven and left ten jobs unrequired, including every
  non-Postgres engine and the blocking security audit.

- **Releases are triggered by a tag.** `release.yml` runs the gate chain, then
  publishes with `--provenance`, creates the GitHub Release, and runs a
  post-publish registry smoke test. A local `npm publish` still works as a
  fallback but now refuses unless CI is green on `HEAD`, asked of GitHub rather
  than inferred from a local run, and failing closed on a missing run, an
  unfinished run, or an unusable `gh`.

- **`docs/WORKFLOW.md`** is new and tracked: branches, pull requests, releases,
  test requirements, the guard set, and the public-repo security rules, in one
  place. `CONTRIBUTING.md` and `CLAUDE.md` point at it.

### Internal

None of this changes the published API. It is listed because it changes what
can reach the registry.

- **Five checks moved onto the publish path.** `check:private-terms`,
  `check:cycles`, `check:error-prefix` and `check:skip-gates` now run in
  `release.yml` and in `prepublishOnly`, and `TURBINE_REQUIRE_ENGINE` is set on
  both of `release.yml`'s database jobs. `ci.yml` does not gate a tag push and
  `prepublishOnly` does not run when the tag path publishes, so on the one route
  that reaches npm they ran nowhere.

- **The shipped agent skill is verified by CI, not by habit.** `README.md`
  states that every factual claim in it is executed against a live database
  before release; the 417-line verifier was referenced by no workflow and no
  script. It is a required job now, 46 of 46 claims hold, and the verifier
  asserts its own coverage, because the claim list is hand-written and a
  sentence added to `SKILL.md` would otherwise become an unverified claim in
  silence.

- **Import-cycle detection finds real cycles.** The previous check answered one
  question, whether `query/` or `cli/` statically imports `client.ts`, and was
  blind to every other cycle. It now runs Tarjan over the whole value-import
  graph, sees `export ... from` re-export edges, excludes type-only edges, and
  carries two self-tests plus a zero-file refusal.

  It immediately found one: `powdb.ts` re-exported `PowqlInterface` and
  `introspectPowdbDatabase` while both of those modules imported values back
  from it, a three-node cycle in the largest engine entry. Broken by hoisting
  the shared primitives into `powdb-shared.ts`. The `turbine-orm/powdb` surface
  is byte-identical, verified across CJS, ESM and `.d.ts`.

- **`cli/index.ts`, `introspect.ts` and `generate.ts` are under coverage
  ratchets** for the first time. `cli/index.ts` is the largest file in the repo
  at 5,945 lines and was in no gate at all. It is deliberately kept out of the
  CLI aggregate: one file that size at 33% drags the aggregate's line and
  function floors down about 25 points, which would let the other eight files
  shed over a thousand covered lines with the gate still green.

- **Documented numbers that keep drifting are asserted from source.** The
  coverage floors, error-code range, module count and fixture row counts quoted
  in `STABILITY.md` and `CONTRIBUTING.md` were stale again, three weeks after
  the last time they were corrected by hand. `docs-claims-sync.test.ts` reads
  each one from `.c8rc.json`, `package.json`, the `TurbineErrorCode` union,
  `seed.sql` and the directory listing, so the next drift fails a test instead
  of surviving to the next audit.

- **Test-integrity fixes.** Five PII relation assertions were inside loops that
  did not execute on an empty result set, so they passed while testing nothing;
  they now assert a non-empty result first. A skip-on-unsupported branch used a
  bare `return`, reporting a pass; it calls `t.skip()` now.

## 0.76.0 (2026-08-22)

An outside review of 0.75.0 went looking for a SQL injection in the query
builder, did not find one, and found nine real defects in everything around it:
a code generator that trusts the database catalog, a PII guard that resolves a
name differently from the compiler it guards, a relation global filter that
emitted a placeholder and bound nothing, and a set of transport perimeters with
no ceiling on their input.

That shape is the release. **The invariant everyone worries about held; the
tooling built on top of it did not.** Two of these are remotely triggered, both
were reproduced by execution rather than inferred from reading, and both are
fixed here with the mechanism that makes the class hard to reintroduce rather
than the instance easy to close.

### Security

- **`turbine generate` gave a hostile database catalog arbitrary code execution
  in the developer's environment.** Table, relation and enum names were
  interpolated raw into JavaScript object-key position in the emitted
  `metadata.ts` / `types.ts` / `index.ts`. A Postgres enum named
  `` [Function('…')()+'x'] `` emitted a COMPUTED key, and a computed key inside an
  object literal is evaluated when the module is imported, which the generated
  client is, by every subsequent build. Reproduced end to end against a live
  database, including the payload executing on import.

  Two boundaries now, not one. `src/introspect.ts` refuses a catalog whose names
  carry characters no identifier can contain, so the payload never reaches the
  generator; and the generator emits every key through an ANCHORED identifier
  match, falling back to a quoted string literal, so a name that is merely
  unusual still round-trips and a name that is hostile cannot become syntax.
  Output for every ordinary schema is byte-identical.

  **This is a behaviour change:** `turbine generate` now fails with a
  `ValidationError` (E003) naming the offending object, where it previously
  emitted a file. If you have a table or column whose name contains a control
  character, a line separator, or a quote, generation will now stop.

- **A relation's global filter emitted `$N` and bound no parameter.** With a
  value-bearing `globalFilters` entry on a relation TARGET, `with: { rel: true }`
  built the filter into the correlated subquery and the collect path skipped it,
  so the driver refused the statement outright (`bind message supplies 1
  parameters, but prepared statement requires 2`). On the join plan this is the
  flagship single-query nested read, and on a multi-tenant schema it is every
  query that touches a filtered table. Live since 0.28.0, about 48 releases.

  Two things kept it hidden, and both are worth knowing. The default `auto`
  strategy falls back to the batched plan on an unindexed correlation column,
  and the batched plan was correct, so **adding the covering index `turbine
  doctor` tells you to create is what turned a working query into an error.**
  And the whole `global-filters.test.ts` fixture was built on `deletedAt: null`,
  which binds nothing, so every assertion in the file was blind to a
  collect-path that pushed nothing. The fixture is now value-bearing and the
  parameterless shape keeps its own separate case.

  The fix is not a patched branch: six independent walkers each decided for
  themselves what a `with` entry's options were, and `true` / `{}` / `{ … }` are
  now one shape (`relationOptions()`) for all of them.

- **SQL Server dropped a relation target's global filter entirely.** Found while
  fixing the above, and worse than it: `mssqlDialect` overrides
  `buildRelationSubquery` wholesale for `FOR JSON PATH` and returned before the
  filter could be applied, while the collect path still pushed its value. So on
  SQL Server the predicate simply vanished and the subquery returned every
  tenant's rows, with an orphan parameter riding along. There was no error.

  The filter is applied in the `buildWhere` closure the core hands to a dialect
  override, not in the override, so **every present and future dialect override
  inherits it** rather than each having to remember. `RelationSubqueryContext`
  deliberately carries no builder context, which is why it could not have been
  fixed in `src/mssql.ts`.

- **Two PII guard bypasses, one root cause.** A relation written in its
  `snake_case` DDL spelling (`blog_posts` for a declared `blogPosts`) walked
  straight past the guard's exact-match lookup and into the compiler, which
  since 0.72 accepts both spellings, so Studio and the MCP server filtered and
  sorted on hidden columns they had refused under the other spelling. Separately,
  `distinct: [["email"]]` slipped through a check that assumed the array's
  elements were strings, and emitted byte-identical SQL to `distinct: ["email"]`.

  Both are the guard disagreeing with the compiler about what a name is. It now
  resolves names through the same `resolveRelation` / `resolveColumnName` the
  builder uses, and refuses any non-string element in a field list.
  `src/test/pii-guard-symmetry.test.ts` asserts the two agree on ACCEPTANCE
  rather than checking a list of spellings, so the next spelling rule is covered
  the day it is written.

- **The destructive-migration scanner missed `concat()`.** `EXECUTE 'DROP TABLE '
  || 'users'` was flagged and `EXECUTE concat('DROP TABLE ', 'users')` was not,
  so a migration assembling a `DROP` that way applied it with no prompt and no
  `--allow-destructive`. The scanner now knows `concat` / `concat_ws` as
  proximity forms and `array_to_string` / `replace` / `regexp_replace` as
  open-call-wrapping verbs, gated on `EXECUTE`.

- **Three transport perimeters had no ceiling on their input.** The MCP stdio
  reader buffered an unframed line without limit, so a peer that never sent a
  newline grew it until the process died; it is now bounded at 8 MiB and ENDS the
  session rather than truncating, because there is no correct way to continue a
  stream whose framing has been lost. The shared rate limiter's key map never
  evicted, so under `--allow-remote` it held one permanent entry per source
  address ever seen; it now sweeps expired windows and is capped, evicting oldest
  first so it can only ever forgive a caller early. And `compile_query`'s
  fail-closed "does this query name a column" test read the top level only, so
  `with: { posts: { where: { secretNote: … } } }` was reported as safe to compile
  when the PII tag file could not be read; it now walks every depth and errs
  toward refusing.

- **`sample_rows` promised more than it enforced on an untagged schema.** The
  tool description said PII columns are never fetched without saying that `pii`
  is a code-first tag loaded from generated metadata, so on a project that has
  not run `turbine generate` a 13-word name denylist was the whole protection and
  `redactedColumns: []` read as "checked, holds no PII". The guarantee is
  unchanged and still stated; the description now names what decides the SET of
  hidden columns, points at the `piiTagSource` field, and says plainly that
  returned rows are untrusted database content rather than instructions.

### Fixed

- **`turbine` silently discarded unknown flags.** `push --dry-runn` executed for
  real, `doctor --fixx` exited 0 and wrote nothing, and `migrate create x --autoo`
  reported success and wrote an empty template. On the product whose sixth
  selling point is that dangerous operations ask first, a typo in a safety flag
  turned a dry run into a real one. The flag surface is now data, an unknown flag
  is an error with a nearest-name suggestion and the command's real flags, and an
  unknown COMMAND suggests too.

- **CLI failures went to stdout.** 633 `console.log` against 5 `console.error`,
  so `turbine generate > build.log` swallowed the error and CI capturing stderr
  saw nothing. Failures now write to stderr and a pure failure writes NOTHING to
  stdout, verified by measuring both streams separately. `doctor --json` and
  `skill --print` remain byte-clean on stdout.

- **`--schema ./schema.ts` was accepted and ignored on six commands.**
  `--schema` is the Postgres namespace; the file path belongs to the new
  `--schema-file`. The refusal that already existed on `generate` now covers
  `push`, `status`, `doctor`, `studio`, `mcp` and `migrate create`.

- **`turbine init` against an empty database told you to query a table you do not
  have.** It scaffolded a fully commented-out schema, found 0 tables, and then
  printed `db.users.findMany()`. It now writes a real two-table starter schema
  when the database is empty, and the next-steps text names a table the generated
  client actually has.

- **The documented import path did not compile.** `import { turbine } from
  './generated/turbine'` is a hard `TS2834` under NodeNext, the resolution this
  package itself ships. The CLI now derives the specifier from the generator's own
  extension resolution, and the README, JSDoc and docs snippets carry the form
  that compiles.

- **SQLite logic errors were untyped.** `no such table` / `no such column` /
  syntax errors have no SQLSTATE for `wrapPgError` to borrow, so they surfaced as
  a bare `Error` with `code: 'ERR_SQLITE_ERROR'`, no `TURBINE_E0NN` and no
  `docsUrl`, which made the typed-errors promise Postgres-only in practice. They
  are now `ValidationError` (E003) with the driver's text kept verbatim and the
  driver error attached as `cause`. `ValidationError` accepts a `cause` for the
  first time; the base class already redacts one under `errorMessages: 'safe'`,
  so this goes through the redaction rather than around it.

- **`compile_query` under-reported a relation written in `snake_case`.** The same
  exact-match bug as the PII guard, in the MCP tool: the relation was silently
  dropped from the report, so the statement count was low and the correlation
  probes were skipped for exactly the relation the caller asked about.

- **Seven of eight examples failed at step one.** They pinned `turbine-orm:
  ^0.7.x`, which on a `0.x` version resolves a release 68 versions old, passed a
  file path to `--schema`, and constructed a client the generator has not emitted
  in a long time. All eight now install from the workspace, run their own setup,
  and typecheck. Three were also missing `tsx`, which their own `db:push` needs,
  and one imported `pg` with no `@types/pg`; both were found by the new CI job
  rather than by reading.

- **A dangling `Available: ` on a table with no relations.** Fourteen error sites
  interpolated a joined key list directly, so on an empty list the message ended
  at the colon. One shared `availableClause()` now renders the list or a sentence
  saying there is none.

### Changed

- **PowDB refuses `distinct` with `UnsupportedFeatureError` (E017)** instead of
  compiling PowQL that silently ignored it. Verified across all four dialects
  before choosing where the refusal goes: PostgreSQL supports the feature and so
  raises E003 for an unknown column name, while SQLite, MySQL and SQL Server all
  raise E017 for the feature. E003-for-an-unknown-name is therefore not a shared
  contract, and PowDB refuses before resolving names, like its peers.

- **`pipeline()` takes the caller's dialect**, so a batch on SQL Server emits SQL
  Server transaction keywords rather than PostgreSQL's.

- **Writes on a PowDB table with a PII-tagged primary key keep the key.** The
  client-side strip removed it along with the other tagged columns, leaving a row
  nothing could address.

- **`jsonEncoding`, the MCP tool count, and the generated-SQL showcase** are
  corrected across the site. `relations` said `jsonEncoding` defaults to
  `'object'`, false since 0.71, with the knock-on that `flatten` silently
  no-ops on PostgreSQL under the real default. The landing page advertised eleven
  MCP tools and listed ten, and its "Generated SQL" panel showed
  `json_build_object`, which PostgreSQL no longer emits.

- **The bundle claim, the size gate and the site now carry one number.** The
  README said "under 85 kB brotli, enforced by size-limit in CI" while the entry
  measured 85.22 kB and the gate was 90 kB: the published figure was exceeded and
  the gate cited as enforcing it was 4.78 kB looser. Main is now **87 kB** and
  the edge entry **69 kB**, the same numbers in `.size-limit.js`, the README and
  the site, with a test that fails if they diverge. The re-baseline from 86/68 is
  this release's own growth in the shared client/query graph, checked against an
  esbuild metafile first to confirm no engine or CLI module had leaked in.

- **The streaming benchmark is re-measured and the claim reversed.** The site
  said in three places that Drizzle takes streaming by 22%, from a 0.71.0 run,
  while the same page carried a 0.72.0 table showing Turbine ahead. Three fresh
  runs of fifteen interleaved rounds: `findManyStreamBatches` **36.70 ms**,
  `findManyStream` **40.69 ms**, Drizzle 1.0.0-rc.4 **37.10 ms**, Drizzle 0.45.2
  **44.20 ms**. Against the published Drizzle the scenario has reversed on both
  Turbine spellings; **against the release candidate it is a tie, not a win** (the
  paired delta spanned -4.9% to +3.1% while the negative control spanned -3.7% to
  +3.2%), and the per-row API is a real 5-11% loss to rc.4. A new harness,
  `benchmarks/bench-stream-parity.ts`, runs both Turbine spellings in one
  rotation, because the old single-arm harness compared a per-row API against
  four arms consuming arrays and reported the API difference as a speed
  difference.

- **The competitor table said Drizzle's Gateway is paid.** It is free to
  self-host; the claim was true of the retired Drizzle Studio subscription. The
  cell now links the vendor's own page, and the table's footnote states the rule:
  a cell asserting someone else's pricing carries a link, because that is the
  cell that goes stale silently.

- **The README documents the code-first SQLite path.** The section said "SQLite
  needs nothing else" and then imported `./generated/turbine/metadata.js`, which
  only `turbine generate` produces and `generate` is Postgres-only. The
  `defineSchema` -> `schemaToSQL(schema, { dialect: sqliteDialect })` ->
  `schemaDefToMetadata` route works and was verified end to end; it simply was
  not written down. Same correction in the shipped JSDoc.

- **The prepared-statement memory channel is documented where a reader looks.**
  A named statement is never deallocated, and 0.66 closed the largest
  request-controlled case by sending variable-arity combinators unnamed. The
  residual channel is a caller-chosen `select` / `omit` / `with` subset, which the
  builder cannot distinguish from a hand-written one. It was a code comment; it is
  now in the queries docs and in the `preparedStatements` JSDoc, with the
  mitigation.

### Testing

- **`src/test/generate-injection.test.ts`** drives the real generator with
  hostile catalog names and executes the emitted module in a `node:vm` to prove
  nothing runs on import.
- **`src/test/pii-guard-symmetry.test.ts`** asserts the guard and the compiler
  agree on which queries are ACCEPTED, over both spellings and both field-list
  shapes.
- **`src/test/with-spec-shorthand-drift.test.ts`** sweeps `true` / `{}` / options
  across four dialects, two encodings and every nesting shape, asserting the SQL
  is identical and every placeholder is backed. SQL Server is in that sweep now;
  the block that pinned its broken behaviour has been replaced by one asserting
  the fix.
- **`src/test/global-filter-relation-strategies.integration.test.ts`** runs every
  relation-load strategy against a live database and compares rows, with an
  explicit precondition check on the covering index so a missing fixture index
  reads as a fixture problem rather than a product defect.
- **`src/test/mcp-perimeter-bounds.test.ts`** exercises each transport bound at
  the scale that made it a defect: 12 MiB unframed, 50,000 distinct rate-limit
  keys, and a 40-level nested args object.
- **`src/test/cli-arg-safety.test.ts`**, **`cli-first-run.paths.test.ts`**,
  **`sqlite-error-classification.test.ts`**, **`size-claim-sync.test.ts`**,
  **`destructive-dynamic-assembly.test.ts`**, **`pipeline-dialect-tx.test.ts`**,
  **`powdb-dialect-contract.test.ts`**.
- **Nine vacuous assertions removed.** `if (posts.length > 0) { … }` on a fixture
  that guarantees posts is an assertion that passes when the relation comes back
  empty, which is the failure it was written to catch. They assert now. One
  `createMany({ skipDuplicates })` case hedged with "or none" against a column
  that carries a unique index, and now asserts the exact count.
- **A shared-fixture leak.** `auto-compound-integration.test.ts` drops
  `idx_posts_user_id` in setup and did not put it back, so every later suite in
  the run planned differently. Since the index's absence is precisely what makes
  `auto` fall back to batched, which is what hid the relation global-filter bug
  for 48 releases, this is the one index whose leak is most likely to hide a
  defect. It is restored in teardown.

### CI

- **`examples-smoke`**: every example, installed from the packed tarball against
  a real Postgres, push -> generate -> `tsc --noEmit`. Nothing ran the examples
  before, which is how seven of eight stayed broken.
- **`ci-ok`**: one aggregate job that fails unless all eighteen others succeeded,
  intended as the single required check. Branch protection can only require job
  names it already knows, so a newly added job was not required until someone
  remembered to add it in a settings page; now forgetting is a visible diff in
  the workflow file. It runs with `if: always()`, because a skipped required
  check is reported as neutral rather than as a failure.

## 0.75.0 (2026-08-16)

0.74.0 fixed five options PowDB accepted and ignored, and verified the fix
against a recording pool. Running the same checks against a **live engine**
found that the headline fix never reached the public factory: `turbinePowDB`
hand-listed the four config keys it forwarded, so a `globalFilters` passed to it
was dropped one level above the code that had just been taught to honour it.

The lesson is the one this release series keeps paying for, one level up from
where it was last applied: **a fix verified through an internal seam is not
verified.** Asserting the emitted statement proves the option reaches the
builder; only executing the query proves it reaches the caller.

### Fixed

- **`turbinePowDB` dropped almost every client option, including
  `globalFilters`.** The factory forwarded `logging`, `defaultLimit`,
  `warnOnUnlimited` and `relationLoadStrategy` and nothing else, so
  `globalFilters`, `stableRelationOrder`, `errorMessages`, `logQueryParams`,
  `sqlCache` and everything else added to `TurbineConfig` since PowDB landed
  were accepted by the type and discarded before `TurbineClient` saw them.

  This is the same allowlist that `engine-config.ts` was written to kill for
  SQLite / MySQL / SQL Server; PowDB was never converted. It now extends
  `EngineClientConfig` like they do, so a new client option is engine-wide the
  day it lands and only a deliberate exclusion can take it away.

  **This changes what PowDB queries return** for anyone already passing these
  options: as of 0.74.0 the options worked, and as of this release they arrive.
  If you configure `globalFilters` against PowDB, your queries are filtered now.

- **`groupBy({ _count: { ... } })` returned no `_count` at all on PowDB.** The
  record form (`_count: { _all: true, email: true }`) fell through both branches
  of the aggregate selection, so PowDB answered with the group keys and no
  `_count` key on any row, while every SQL engine returned the counts. Reading
  `group._count.email` off that row threw. The scalar form (`_count: true`, and
  the default) was unaffected.

  `_all` is the row count and a named field is that column's NON-NULL count,
  matching the SQL builder and `aggregate()`, which already had this right. A
  per-field count of a nullable column is gated on the same engine version
  `aggregate()` gates on, for the same reason.

### Changed

- **`turbineHttp` (the `turbine-orm/serverless` subpath) accepts every client
  option.** `TurbineHttpOptions` was a three-key `Pick`, so passing
  `globalFilters` to a Neon / Vercel / Hyperdrive client was an excess-property
  error on an option the runtime would have honoured. It is now
  `Omit<TurbineConfig, 'pool'>`, which is exactly what the function already
  spread through. Type-level only: no runtime behaviour changes, and nothing
  that compiled before stops compiling.

### Testing

- **`src/test/option-behavior.integration.test.ts`** and
  **`src/test/powdb-option-behavior.integration.test.ts`**: the behavioural half
  of the option matrix, on PostgreSQL and on a live embedded PowDB. Same
  inventory as `option-observability.test.ts` (`ALL_OPTION_TABLES`), opposite
  question: not "does this option change the statement" but "does it change the
  answer". 105 assertions, every one of them reading or writing rows.

  Both were mutation-tested, and the fixtures are shaped by what escaped. A
  per-field `_count` was first asserted over the primary key, where the non-null
  count and the row count are the same number for every possible input, so an
  implementation that emitted `COUNT(*)` for both passed; both fixtures now carry
  a nullable column seeded with real NULLs, which is the one place the two
  answers differ.

## 0.74.0 (2026-08-17)

The 0.73.1 rule, asked of the second engine: **every option on every operation
must change the answer, or be refused.** `PowqlInterface` is a parallel
implementation of the same public surface, so a rule enforced on `QueryInterface`
alone is not a rule. Asking PowDB the same question found five options it
accepted and ignored, two of them load-bearing.

### Fixed

- **`globalFilters` did nothing on PowDB.** A client configured for
  multi-tenancy or soft-delete applied its predicate on every SQL engine and
  NONE on PowDB: the same application code returned one tenant's rows on
  Postgres and every tenant's rows on PowDB, with no error anywhere.
  `skipGlobalFilters` was equally inert, so the opt-OUT appeared to work too.

  If you run PowDB with `globalFilters` configured, **this release changes what
  your queries return**, which is the point, but it is a result change and not
  only a bug fix. The filter now applies to `findMany`, `findFirst`,
  `findUnique`, `count`, `aggregate`, `groupBy`, `update`, `updateMany`,
  `delete` and `deleteMany`, and to relation loads (each level resolves its own
  target table's filter).

  The rule is SHARED with the SQL engines (`resolveGlobalFilterFrom`) rather than
  restated, because two copies of a rule this specific is how the engines drifted
  before. The ordering is a contract in its own right: the empty-`where` guard
  still sees the USER predicate alone, so a configured global filter can never
  quietly turn a refused mass mutation into an accepted one.

- **`optimisticLock` did nothing on PowDB.** The version check never happened, so
  the update applied unconditionally: a concurrent writer's change was
  overwritten by a caller who believed they held the lock, and no error was
  raised. It now adds the version predicate, bumps the column, and raises
  `OptimisticLockError` (E015) when the row moved on, matching the SQL engines.

- **`stableRelationOrder` did nothing on PowDB**, so relation rows came back in
  whatever order the engine produced, from the option whose entire purpose is
  that they do not. The transform moved to `query/relation-names.ts` and both
  engines now run it.

- **`allowFullTableScan` was refused on PowDB's `update` / `delete`** even when
  passed, while every SQL engine accepted it.

- **`jsonEncoding` is now refused on PowDB** with `UnsupportedFeatureError`
  (E017) instead of being dropped. It selects between PostgreSQL's
  `json_build_object` and `json_build_array` relation encodings, and PowQL emits
  no JSON row encoding at all, so there was nothing for it to select.

### Internal

- `src/test/powdb-option-observability.test.ts`, the 0.73.1 matrix asked of
  PowQL, with one addition that is the whole reason to ask: an option PowDB
  cannot honour must throw E017, never be silently ignored. 90 assertions.
- The SQL matrix now runs over TWO schema shapes (single-column and composite
  primary key), since several options are key-shaped and one fixture only ever
  proves an option is observable in the shape it happens to have. 180 assertions.
- `$retry`, `$observe` and `pipelineSupported` were the three untested public
  client methods; the first two are thin delegations, which is exactly why they
  went uncovered, and what a delegation leaves unproven is the wiring.

## 0.73.1 (2026-08-17)

A correction to the 0.73.0 notes, and the gate that release should have shipped
with: **every option on every operation must change the answer, or be refused.**
0.73.0 fixed three arguments that were accepted and did nothing. It did not close
the class, and the suite could not have caught them: `take` appears in dozens of
tests while `skip` was not a key at all, so "is this option mentioned in a test"
was already true for the half that worked, and line coverage cannot tell "read
and used" from "read and dropped".

### Fixed

- **`migrate status` could crash on a fresh database when several ran at once.**
  `CREATE TABLE IF NOT EXISTS` is not atomic, so the losers of the tracking-table
  create race are retried once. The set of Postgres codes recognised as that race
  was written from what ONE measured run happened to produce, `23505` and
  `42P07`, and creating a table also creates its composite row TYPE, so a loser
  can instead report `42710` (`duplicate_object`) and fall through to the
  rethrow. `migrate up`/`down` hold the migration lock and were never affected;
  `migrate status` and the deploy inspector deliberately do not.

  The same shape as the bug in the notes below: an enumeration written from
  observation rather than from the rule.

### Internal

None of this changes a shipped code path; it is recorded because it is what the
release is mostly made of.

- **A gate for the whole option surface.** `src/test/option-observability.test.ts`
  compiles every operation x every non-internal option, twice, with and without
  that one option, and requires the two to differ in a declared way: the SQL or
  params differ, or the option is refused, or it unblocks a refusal, or it is
  declared observable only at execution and NAMES the test that proves it. 91
  assertions, driven from the same `ALL_OPTION_TABLES` inventory the compiler
  already binds, so a new option fails to compile until it is classified and then
  fails this file until someone says where it is observable. Neither step can be
  satisfied by an option that does nothing.

- **The per-query `timeout` had no core test.** It sits on all thirteen arg
  interfaces, and every assertion that it actually aborts a query ran through
  `turbine-orm/prisma-compat`, so the core client's behaviour rested on an
  adapter's test. Now covered per call site: `findMany`, `findFirst`, `count`,
  `aggregate`, `groupBy` and the writes each pass `args.timeout` separately.

- **`pipelineSupported` was untested at both levels**, and each of its failure
  modes is silent: a wrong `false` costs the 1-RTT batching with no error, and a
  leaked probe connection drains the pool somewhere else entirely.

- **The tracking-table race test reported `["[object Object]"]`** (it mapped
  `String` over the settled-result wrappers rather than over `.reason`), so the
  release it eventually blocked named no error code. It also only reproduces the
  race about 12% of the time, which is a smoke test and not a gate; the rule it
  covers is now asserted deterministically, one case per accepted code.

- **A claim in the 0.73.0 notes overstated how far two of its three bugs
  reached.** The notes said the Prisma pair `{ take: 20, skip: 40 }`
  "type-checked". Written the way the sentence shows it, a plain object literal,
  it did not: excess property checking rejects it (`TS2353`), and the same is
  true of `include`.

  What is true is narrower, and it is the reason a cross-model eval found these
  and code review had not. Both keys reached runtime only through the calling
  styles that check does not cover, all of which compile clean: a spread such as
  `findMany({ ...req.query })`, plain JavaScript, and any JSON-shaped caller,
  which includes the MCP tools, the `turbine-orm/prisma-compat` delegates (their
  args are `Record<string, unknown>`, so there every key genuinely did
  type-check) and the eval harness itself.

  The third bug is the one that was invisible to the type system: `findUnique`
  takes the full `WhereClause`, so a non-unique `where` compiled for every
  caller. The notes now draw that distinction instead of flattening all three
  into one sentence.

- The packaged skill (`skills/turbine-orm/SKILL.md`, installed by
  `npx turbine skill`) and `llms.txt` described `include` as simply ignored,
  without saying that a plain literal is a compile error. Both now say which
  paths reach the runtime behaviour. The instruction itself, relations go in
  `with`, was correct and is unchanged, and `npm run verify:skill` holds at
  46/46.

## 0.73.0 (2026-08-16)

The same rule as 0.72.0, one step further: **an argument the caller wrote must
change the answer, or be refused.** 0.72.0 was about names. This one is about
three arguments that were accepted and then did nothing, or did something other
than what they said, and it ships the agent skill they were found by.

All three produced a plausible result, which is why they lasted. A thrown error
gets fixed the same day.

### Breaking

- **`findUnique` now requires a `where` that identifies a single row.** A
  primary key, a single-column unique, or every column of a compound unique;
  extra predicates alongside the key are still fine, since they can only narrow
  a set that already holds at most one row. Anything else throws
  `ValidationError` (TURBINE_E003) naming the keys that would have worked.

  Before, `findUnique({ where: { status: 'active' } })` emitted
  `WHERE status = $1 LIMIT 1` with no `ORDER BY` and returned an arbitrary one
  of the rows that matched, differently between two calls with the same
  argument. Unlike the two option bugs below, this one was invisible to the type
  system: `where` is typed as the full `WhereClause`, so every TypeScript caller
  compiled clean. The caller who wrote `findUnique` asked for *the* row, and the
  `null` branch they wrote reads as "no such row" when it meant "none matched
  this filter". This extends the empty-`where` guard added in 0.61, which
  already refused the degenerate case for exactly this reason.

  `findFirst` is untouched: "the first row matching an optional filter" is its
  whole contract. Give it an `orderBy` if which row matters. A `null` value
  never satisfies the rule even on a unique column, because PostgreSQL permits
  any number of NULLs in a unique index.

- **`take` and `limit` (or `skip` and `offset`) with different values now
  throw** instead of silently preferring `take`. Equal values are accepted.

### Fixed

- **`skip` did nothing.** `take` was a recognized alias for `limit` and `skip`
  was not a Turbine key at all, so the Prisma pair `{ take: 20, skip: 40 }` ran
  and returned the FIRST page however far the caller thought they had paged.
  `skip` is now the alias for `offset` that `take` is for `limit`. Half a
  recognized pair is worse than neither half: an unknown key is inert on its
  own, but a half-recognized one changes the answer.

  **How far this reached, stated precisely.** Written as a plain object literal,
  `findMany({ take: 20, skip: 40 })` was a COMPILE ERROR on 0.72.0 and earlier
  (TS2353, excess property), so a TypeScript caller writing it that way was told.
  It reached runtime through the calling styles where TypeScript's
  excess-property check does not apply and which compile clean: a spread
  (`findMany({ ...req.query })`), plain JavaScript, and any JSON-shaped caller,
  which includes the MCP tools and anything an agent submits. That is also why a
  cross-model eval found it and code review had not.

  Both aliases are now folded ONCE, before anything reads them, so `limit` and
  `offset` are the single authority below that line and the two spellings share
  one SQL-cache entry. `take` used to be handled by six separate
  `args?.take ?? args?.limit` reads, one of which is the cache FINGERPRINT;
  adding `skip` the same way would have meant six more places to keep in step,
  and a miss in a fingerprint is not a missing feature, it is two different
  pages sharing one cached statement.

### Added

- **`npx turbine skill`** installs a query-writing skill into the project
  (`.claude/skills/turbine-orm/SKILL.md` by default). `--print` writes it to
  stdout, `--agents` prints a short instructions block for `AGENTS.md` /
  `CLAUDE.md`, `--dir <path>` installs under a different skills root. The skill
  ships in the package, so what an agent reads is what the repository tests:
  every factual claim in it is executed against a live database before release,
  by a checker that names the sentence to change when an answer moves.

- **An unknown query option now warns** outside production, once per
  `table.operation.key`, naming the key it thinks you meant. `include` gets its
  own message pointing at `with`, because that is the single largest source of
  confidently-wrong queries against Turbine: an unrecognized option is ignored,
  so the query runs, returns rows, and the relation is absent from every one of
  them. A warning rather than a refusal, deliberately, since
  `findMany({ ...someOptionsBag })` is ordinary code and the option surface
  grows between minors.

  It is driven by the same `query/option-surface.ts` tables that already bind
  the compiler in both directions, so a new option cannot be added without the
  diagnostic learning about it.

### Measured

The skill was shipped against a number rather than a hope. On a held-out schema
across 240 scored attempts (`evals/AGENT-EVAL-0.73.0.md`), the skill ALONE, with
no docs and no MCP connection, took first-try pass rate from **73% to 97%** on
`claude-sonnet-5` and **60% to 97%** on `claude-haiku-4-5`, against a measured
run-to-run noise band of about 7 points. On both models it matched or beat a
live `turbine mcp` connection. Twelve of the twenty cold failures were one
mistake, a relation named inside `select`, which the skill's fourth section
addresses and which drops to zero wherever the skill or the tools are present.

## 0.72.0 (2026-08-16)

A correctness release about one rule: **a column and a relation each have two
legal spellings, and which argument the name appears in must not change the
answer.**

Turbine has always accepted the snake_case column name in `where`, `select`,
`omit`, `distinct` and `cursor`, because `camelToSnake` is idempotent on an
already-snake string. It rejected the same name in `orderBy`, `groupBy`'s `by`,
and `_min` / `_max` / `_sum` / `_avg`, because those sites tested
`key in meta.columnMap`, which knows only the field spelling. Same column, same
table, same query: five positions accepted it and three refused it.

That asymmetry was not only an error message. Chasing the rule to every site it
should already have reached turned up **four wrong answers**, listed below. The
worst returned the wrong page of a cursor-paginated query with no error at all.

The relation half is the same rule one level up, and it was found by measurement
rather than review. A relation carries one declared name (`blogPosts`) while the
DDL anyone reads carries only the table name (`blog_posts`), so writing back what
the schema shows failed, on names the error text was already computing correctly
("Did you mean ...?"). A system that can name the intended relation can accept
it.

Both halves are widenings: every name that resolved before resolves to the same
thing, an exact declared name always wins, and an unknown name is still refused.

### Fixed

- **A cursor whose field was spelled the other way silently returned the wrong
  page.** `cursor: { created_at: … }` against `orderBy: { createdAt: 'desc' }`
  failed to match up the two spellings, defaulted to ascending, and emitted
  `"created_at" > $n` under `ORDER BY "created_at" DESC`. No error, plausible
  rows, wrong ones. Cursor fields and orderBy entries are now matched by the
  column they resolve to.

- **The batched relation loader deleted a column the caller had explicitly
  selected.** With `select: { user_id: true }` and a `userId` correlation key,
  the key looked unprojected, so it was force-added *and* marked stitch-only,
  and the strip pass removed the very column that was asked for. The mirror case
  (`omit: { user_id: true }`) failed to un-omit and raised an internal
  "bug in turbine" error on a legal query.

- **`groupBy` returned `undefined` for every group** when a `by` key used the
  column spelling. Rows are read through the field-named parser, so a result
  bucket keyed by the caller's spelling never matched. Group keys are now
  canonical, matching how `_count` / `_sum` / `_min` already mapped back.

- **A compound-unique selector accepted its own name and then refused its
  members.** The selector is registered under both spellings, so
  `{ org_id_user_id: { org_id, user_id } }` matched the selector and was
  rejected for its contents. Members are matched by resolved column now, and two
  spellings of one member are refused rather than silently picking one.

- **`orderBy` spelled the column way silently disabled the batched loader's
  per-parent `LIMIT` pushdown**, so it fetched every matching child row and
  sliced client-side: same rows, unbounded bytes over the wire.

- **A unique column spelled the column way drew a spurious unlimited-read
  warning**, because the "is this query pinned to one row?" check did not count
  it as pinning.

- **Relation names were rejected in their snake_case spelling** in `with`
  (E005), relation filters (E003), `orderBy` (E005), `_count`, and nested `with`
  at any depth. Accepted now on the SQL engines and on PowDB alike.

### Behaviour changes

Two of the fixes above change results for code that ran without error before, so
they are called out separately:

- A cursor-paginated query mixing the two spellings **returned the wrong page**
  and now returns the right one.
- `select` / `omit` naming a correlation key by its column spelling under
  `relationLoadStrategy: 'batched'` **dropped that column from the rows** and now
  returns it.

Both are Stable-surface behaviour changes, so per [STABILITY.md](./STABILITY.md)
the 1.0 Stable-surface freeze clock does not start with this release.

### Performance

**Streaming was Turbine's one remaining loss to Drizzle. It is now a win.**

The zone-less and offset temporal read parsers gained a fast path for the
canonical ISO wire shape, scanning it directly instead of running a regex and
assembling through `setUTCFullYear`. Anything that is not exactly that shape,
a five-digit year, a two-digit year, ` BC`, `infinity`, a colon-less offset, is
**declined** and delegated to the parser it replaced, so no value changes
meaning. That agreement is a differential test against the general parser as
running code, not a transcription of it.

Measured in one process on one build with the arms rotating inside every round,
because the change lives entirely in `pg.types` and can be swapped between two
calls. A negative control (the same profile measured twice under two names)
landed 1.9% apart, which is what makes the paired deltas reportable. Full
method and controls in `benchmarks/RESULTS-0.72.0.md`.

| 50K-row drain | before | after |
|---|---|---|
| `findManyStream` (yields rows) | 52.44 ms | **37.06 ms** (+28.6%) |
| `findManyStreamBatches` (yields `T[]`) | 47.43 ms | **31.65 ms** (+34.9%) |
| Drizzle 0.45.2, same rotation | | 42.09 ms |

Absolute numbers are not comparable to `RESULTS-0.71.0.md`, which is why the
Drizzle arm is re-measured here rather than read off that file. No other
scenario was re-run, so the rest of the 0.71.0 figures stand as published,
caveats included.

### Internal

- **The coverage gate was measuring an artifact, and had been for a long time.**
  c8 merges every test process's V8 coverage into one blob before converting to
  istanbul, and that merge is not monotonic: adding a process's coverage can
  lower the merged result. The proof is that a 448-test *subset* of this suite
  reported `query/relations.ts` at 91.88% while the full 5,819-test superset
  reported 41.78%, and a superset cannot cover less than its subset. Merging at
  the istanbul level instead, where the merge is additive, real coverage is
  **96.11% lines / 91.70% branches / 81.88% functions**, against floors that had
  been set at 75/85/59. Floors re-baselined to 93/89/78 with the measurement and
  the reason recorded in `.c8rc.json`. Every past note blaming
  `relations.ts` / `builder.ts` / `where.ts` for low coverage was the artifact
  talking; they read 95.84 / 97.29 / 98.37.

## 0.71.0 (2026-08-15)

A performance release, and the honest version of that sentence is that the
work was mostly finding out where the time was **not** going.

Turbine's nested reads have lost to Drizzle for several releases. The
assumption was that the row parser was slow, and the fix everyone expected was
a JIT-compiled mapper like the one Drizzle ships in its 1.0 release candidate.
Profiling says the opposite: Turbine's mapping is already the faster of the
two, 0.369 ms against 0.664 ms on the L2 shape. The gap was 59% server time,
and almost all of that was PostgreSQL building JSON. `json_build_object`
repeats every key on every row and `json_build_array` does not.

Turbine has shipped that encoding since 0.26 as `jsonEncoding: 'positional'`.
It is now the PostgreSQL default. Against Drizzle 0.45.2, Turbine goes from
seven of ten scenarios to nine of ten, and geometric mean from 1.079x to
1.025x. No row changes.

Three behaviour changes to Stable surfaces are below. Per
[STABILITY.md](./STABILITY.md), the 1.0 Stable-surface freeze clock therefore
does not start with this release.

### Behaviour changes

- **`jsonEncoding` now defaults to `'positional'` on PostgreSQL** (it was
  `'object'`, and stays `'object'` on every other engine). `TurbineConfig`
  fields are a Stable surface, so a changed default belongs here even though no
  API moved.

  What actually changes for you: the emitted SQL. Relation subqueries build
  `json_build_array` instead of `json_build_object`. Rows are byte-identical,
  verified by `JSON.stringify` equality including key order, and the
  value-fidelity `::text` casts are untouched because only the JSON *keys* are
  dropped, never the expressions. If you log SQL or read raw JSON in a debugger,
  it is now positional and less readable. Pass `jsonEncoding: 'object'` per
  query, or set it on the client, to get the old shape back.

  The default is derived from `dialect.name === 'postgresql'` rather than from a
  capability flag, deliberately. Every engine dialect is built by spreading
  `postgresDialect`, so testing whether the `buildJsonArray` hook exists hands
  positional to all of them. `buildSelectWithRelations` already refuses
  positional on exactly that dialect predicate, so deriving the default from the
  same predicate makes it structurally impossible for the default to select an
  encoding the builder then rejects.

- **`relationLoadStrategy: 'flatten'` now falls back to the default correlated
  subquery on PostgreSQL** unless you also pass `jsonEncoding: 'object'`. A
  flattened relation emits no JSON at all, so the two are not composed in this
  version. This is a plan change with no error: rows are identical, and a
  once-only dev warning names the encoding as the cause and tells you what to
  pass. `'auto'` never selected `flatten`, so this only affects callers who
  asked for it by name.

- **`turbine doctor` refuses to run through a connection pooler**, before it
  opens a connection. `doctor` is a Stable CLI command, so if you point it at a
  PgBouncer, a Neon `-pooler` endpoint, or Supabase's pooler in CI, that job now
  exits 1. Pass `--allow-pooler` to restore the old behaviour, or better, use
  the direct endpoint.

  The reason is not stylistic. A transaction pooler multiplexes many clients
  onto a few shared server backends and reuses one the moment a transaction
  ends, so session state set by one client can be left in force for another.
  `doctor` also reads `pg_prepared_statements` to confirm a cached plan, and
  through a pooler that view describes whichever backend answered rather than
  your application. Detection matches whole hostname tokens (`pooler`,
  `pgbouncer`, numbered variants) and ports 6543 and 6432, so a database named
  `poolers` or a host `spooler.internal` is not caught.

### Added

- **`findManyStreamBatches`**, a streaming method that yields `T[]` instead of
  `T`. `findManyStream` yields one row at a time, which over a 50,000 row drain
  is 50,000 promise resolutions and microtask turns, measured at **7.4 ms, about
  139 ns per row**. Both share one parser-selection site and one database path,
  so their flatten, encoding and PII decisions cannot diverge. `findManyStream`
  is unchanged, including its laziness: it deliberately does not delegate to the
  batch method, because that would parse a whole batch ahead of the consumer and
  make an early `break` pay for rows nobody asked for.

- **`jsonEncoding` as a per-query argument** on `findMany`, `findUnique`,
  `findFirst` and the stream methods, so a single query can opt back to object
  encoding for debuggability or to use `flatten`. An unrecognized value throws
  `TURBINE_E003` rather than falling back, because a silently ignored encoding
  option is invisible: you would get correct rows, no saving, and no signal.

- **`compile_query`**, an eleventh read-only MCP tool. It compiles a read query
  to the exact SQL it would send without executing it, which is possible because
  Turbine already separates build from execute: every `build*()` returns a
  `DeferredQuery` and nothing runs until it is executed. It reports the bound
  parameters, how many statements the query costs, the relation load strategy it
  takes, whether it is bounded by a `LIMIT` or reads every row, and relation
  probes no index serves. A query that fails to compile is a successful answer
  carrying `TURBINE_E003` / `TURBINE_E005` and how to fix it, which is the most
  useful outcome when an agent is still writing the query. Read operations only.

### Fixed

- **`turbine doctor` issued a session-level `SET statement_timeout`** on a pool
  it built from a connection string, in both `index-stats.ts` and
  `plan-flip-probe.ts`. Through a pooler that attaches to a shared backend that
  is not reset on release. The timeout is now a connection startup parameter in
  one case and transaction-local `set_config(..., true)` in the other. (`SET
  LOCAL x = $1` is a Postgres syntax error, which is why `set_config` is the
  parameterizable form.)

- **`findManyStreamBatches` ran on the primary with read replicas configured**,
  because `READ_OPERATIONS` is a hand-maintained list and a missing entry fails
  silently: the query works, it just does not use the replica. It also had no
  `PowqlInterface` stub, so on PowDB it was `undefined` and callers got
  `TypeError: not a function` instead of `TURBINE_E017`. Both lists are now
  checked mechanically against `QueryInterface`'s read surface.

- **`src/query/builder.ts` contained a literal NUL byte** as a cache-key
  delimiter, which made `grep` classify the repo's largest file as binary and
  report zero matches for terms that were present. Written as an escape now.
  Two benchmark files had picked up the same habit.

### Performance

Measured on PostgreSQL 17.9 over a Unix socket, 200 rounds, arm order rotated
per round, median of three runs, every run gated on an idle machine. Full
numbers and method in `benchmarks/RESULTS-0.71.0.md`.

| | vs fastest ORM | record |
|---|---|---|
| Turbine 0.71.0 | 1.025x | 10/10 vs Prisma, 9/10 vs Drizzle |
| Drizzle 0.45.2 | 1.498x | |
| Prisma 7.9.1 | 2.072x | |

Two caveats stated where they are quoted. The L2 and L3 wins are **contested**:
their margins sit inside the harness drift floor, and the contiguous
cross-check disagreed with itself across runs of the same configuration. And
the overhead figure over raw `pg` is published as **1.08x**, not the 1.00x the
harness records unadjusted, because the raw control still uses
`json_build_object` while Turbine no longer does, which is worth 1.83x on its
own. Streaming remains Turbine's one loss to Drizzle.

## 0.70.0 (2026-08-15)

An agent-first release. Turbine's MCP server grows from six read-only tools to
ten, aimed at the thing an agent actually struggles with on an unfamiliar
schema: working out how two tables connect. `dependencies` becomes literally one
entry. And the index-definition parser that feeds `turbine generate` was rebuilt
after it turned out to be silently dropping whole classes of index.

Two of those are breaking, and both are type-level or generation-level rather
than runtime. Nothing about how a query executes changes in this release.

### Breaking

- **`@types/pg` is no longer a dependency, and `db.pool` is typed by Turbine's
  own driver contract instead of by `pg.Pool`.** Root `dependencies` is now
  exactly `{ pg }`, one entry, which is what "one dependency" has always meant
  here and what it now also literally says.

  The types package could not simply be moved. It sat in `dependencies` because
  the published declarations named `pg.Pool` / `pg.PoolClient` /
  `pg.QueryResult`, and `pg` ships no declarations of its own, so those names
  made a types-only package a hard requirement for everyone compiling under
  `strict`. Moving it without clearing the surface first IS the v0.28.1
  regression, which passed every gate in this repo and broke strangers anyway,
  because this repo typechecks against its own `devDependencies` and they do
  not. The order is one-way: clear the declaration surface, then move the
  dependency. `src/pg-types.ts` is the cleared surface, a zero-import leaf
  declaring the `PgCompat*` interfaces natively.

  Those interfaces are not new. `PgCompatPool` / `PgCompatPoolClient` /
  `PgCompatQueryResult` have backed the external-pool seam since the serverless
  binding shipped, and were already exported from the package root. What changed
  is that `TurbineClient.pool` now says so. It was declared `pg.Pool` and
  assigned `config.pool as unknown as pg.Pool`, a cast that was simply false
  whenever an external pool (Neon, Vercel, Cloudflare Hyperdrive) or a
  non-Postgres engine was behind it: the property claimed members the object did
  not have, and the compiler had been told not to look. The new type is the
  truth, and the truth is narrower, so five call shapes that used to compile no
  longer do.

  | What breaks | Why | One-line fix |
  |---|---|---|
  | `db.pool.on('error', h)` | `on?` is optional; an HTTP driver has no event emitter | `db.pool.on?.('error', h)` |
  | `db.pool.totalCount` | now `number \| undefined`; HTTP pools expose no stats | `db.pool.totalCount ?? 0` |
  | `result.fields[0].name` | `fields?` is optional; only describing drivers report it | `result.fields?.[0]?.name` |
  | `result.command` | now `string \| undefined`; it is a pg-family command tag | `result.command ?? ''` |
  | `pool.query({ text, values })` | the object form is not on the contract | `pool.query(text, values)` |

  The same narrowing applies to the `transaction()` callback parameter, so
  `copyFrom` / `copyTo`, cursors, `escapeIdentifier` / `escapeLiteral` and
  `setTypeParser` / `getTypeParser` are no longer on it. If you genuinely hold a
  real `pg.Pool` and want all of it back, assert once where you take it rather
  than at each use:

  ```ts
  import type { Pool } from 'pg';
  const pool = db.pool as unknown as Pool;
  pool.on('error', handler);
  ```

  That assertion is now yours to make, which is the point: it is only sound when
  you know the pool is a real `pg.Pool`, and Turbine cannot know that. An
  application that never touches `db.pool` and never reads `.fields` or
  `.command` off a raw result compiles unchanged. `pg` remains a real runtime
  dependency; this is the type surface only, and `dist/pg-types.js` is
  `export {};` so no emitted JavaScript changed.

  One second-order effect worth naming, because it is invisible until it bites:
  `@types/pg` depends on `@types/node`, so while it was a runtime dependency,
  installing Turbine put `@types/node` into your `node_modules/@types` as a side
  effect. That no longer happens. Any TypeScript project already declares
  `@types/node` itself, so in practice this changes nothing, but if you were
  leaning on the accident, add it as a devDependency. Our own CJS consumer
  fixture was leaning on it, which is how we found out: it failed on the first
  real tag push, before publishing.

  Guarded so it cannot regress: `check:package-types` scans every published
  `.d.ts` for a reference to the whole `pg` family (including deep specifiers
  like `pg/lib/result` and `pg-protocol`), self-tests its own matcher before
  scanning, and refuses to pass on a zero-file scan. It runs in
  `prepublishOnly`, in CI, and in the release workflow, alongside a job that
  installs the real tarball into a project with `pg` but without `@types/pg` and
  typechecks it under `strict` with `skipLibCheck: false`.

- **A junction table whose only two-column UNIQUE index is PARTIAL no longer
  produces an automatic `manyToMany`.** `UNIQUE (post_id, tag_id) WHERE
  deleted_at IS NULL` constrains the rows matching the predicate and nothing
  else, so the pair can repeat freely across the table, and a relation derived
  from it can return the same child twice. The hasOne path already refused
  partial indexes for exactly this reason; the junction path was the one place
  that did not read the flag, so the two cardinality paths disagreed about
  whether the same index proved anything.

  If you relied on such a relation, declare it explicitly in a code-first schema
  (`defineSchema`), which is the supported way to describe a junction Turbine
  cannot verify for itself. A junction with a real primary key, a table-wide
  unique constraint, or a full unique index is unaffected.

### Added

- **Four new read-only MCP tools**, taking `npx turbine mcp` from six to ten.
  Every one of them runs inside the same `BEGIN READ ONLY` transaction as the
  rest, so an agent still cannot mutate anything through this server, and
  PII-tagged values are still redacted before they reach a model.
  - `relation_graph` returns the whole relation graph, or one table's subtree,
    with cardinality, keys, and the junction table for many-to-many. Tables past
    the depth limit are named in `omittedBeyondDepth`, so "not expanded" cannot
    be misread as "nothing there".
  - `find_join_path` answers "how do I get from `comments` to `orgs`" with the
    relation chain **and the `with` clause to write**. It returns every
    equal-shortest path rather than picking one, treats a many-to-many as a
    single hop with the junction reported but never in the emitted query, and
    answers `found: false` instead of throwing when there is no path.
  - `table_stats` returns the planner's row estimate, on-disk size, and indexes.
    A never-analyzed table reports `estimatedRows: null` with
    `analyzed: false`, never `0`, because "unknown" and "empty" are different
    facts and an agent acts differently on each.
  - `explain_error` maps a Turbine error code to its cause, fix, and docs link.
    It opens no connection at all, so it still answers while the database is
    unreachable, which is the usual situation for a `TURBINE_E004`.

### Fixed

- **`turbine mcp` could disclose a stored value through an index's reported
  columns.** The column extractor used a greedy match that ran from the key
  list's opening parenthesis to the last closing one in the definition, so on a
  partial index it swallowed the predicate: `CREATE INDEX ... (name) WHERE
  (email = '...')` reported a "column" containing the literal. The definition
  itself was already being withheld, so this was the one field carrying the
  value past the redaction. Reported columns are now cut at the key list, and a
  definition the parser cannot read is withheld rather than passed through.

- **The MCP server and `turbine generate` disagreed about which relations a
  schema has.** `cli/mcp.ts` carried its own weaker copy of the index-key
  parser: on `USING btree (id) INCLUDE (email)` the copy answered
  `['id) INCLUDE (email']` where introspection answered `['id']`. Those columns
  feed junction detection, so an index could be visible to one surface and
  invisible to the other, and an agent reading the schema over MCP was told
  about a different set of relations than the generated client has. Both callers
  now use one parser.

- **Index keys carrying a modifier were dropped entirely.** A `pg_indexes` key
  entry is `{ column | (expression) } [COLLATE c] [opclass] [ASC|DESC]
  [NULLS FIRST|LAST]`, and the old parser stripped exactly one of those, a
  trailing `ASC` or `DESC`. Everything else was kept, so
  `email COLLATE "C" text_pattern_ops`, `email text_pattern_ops` and
  `id NULLS FIRST` were all returned verbatim as column names. No table has a
  column called that, so the index was silently invisible to every consumer of
  index metadata. The parser is now a scanner rather than a regex, tracking
  paren depth, quoted identifiers and string literals, so a comma inside
  `coalesce(a, b)` is not a key boundary and an apostrophe inside a column named
  `"it's"` does not swallow the rest of the definition. An unterminated key list
  returns nothing rather than everything: the one input it cannot read must not
  be the one it forwards.

  This does not change relation cardinality. hasOne-vs-hasMany is decided by a
  separate function that this release does not touch, and its output was
  verified unchanged across every index shape. What can change is where the
  newly-visible index was previously missing: `turbine doctor` retires a
  missing-index finding for a column an opclass'd index already covers (and
  `--fix` stops proposing a duplicate), and a compound-unique selector that
  previously came out with spaces in its name, unusable by any caller, now comes
  out correct.

### Internal

- `npm run lint` now fails on warnings rather than exiting 0 with them.
- `TURBINE_REQUIRE_ENGINE` makes an engine test suite's skip gate throw instead
  of skip, and is set on each engine's CI job. A container that came up but
  rejected credentials, or a mistyped `MYSQL_URL`, previously left the job green
  with the entire suite silently skipped. `check:skip-gates` fails the build if
  a skip reason matches no known engine pattern, so rewording one cannot quietly
  disarm the guard.
- `check-private-terms` gained an `--all` mode and now runs in CI. It read the
  staged diff, so in a CI checkout it would have scanned zero files and passed
  vacuously. Both it and `check-no-pg-types` now refuse to pass on a zero-file
  scan.
- Studio's embedded UI had an unused `html` property on its DOM helper that
  assigned `innerHTML`. No caller used it; it is gone rather than left as the
  one unescaped path in a UI that renders database contents.

## 0.67.0 (2026-08-10)

A streaming and row-decoding release, plus the benchmark suite that found the
work. Two of the three named parts of the streaming gap are closed, `parseRow`
stops recomputing the same answer once per row, and the suite that measured all
of it grew from 10 scenarios to 24 with a latency axis attached. The additions
paid for themselves immediately: they surfaced a loss the old set could not see
(deep pagination hitting PostgreSQL's generic-plan cliff) and inverted a
strategy recommendation that was only true on a Unix socket.

### Fixed

- **`findManyStream` got slower as `batchSize` got bigger.** It opens with a
  speculative `LIMIT batchSize + 1` so a drain that fits in one batch never pays
  for BEGIN / DECLARE / CLOSE / COMMIT. When the drain does NOT fit, those rows
  cannot be reused: they were read outside the cursor's transaction, so yielding
  them and continuing from the cursor would splice two snapshots together, and
  resuming past them would need an `ORDER BY` the caller never asked for. So the
  cursor re-read from row one and the speculative fetch had cost `batchSize + 1`
  rows for nothing. The waste was therefore proportional to the one number a
  caller raises when they expect MORE rows, and streaming was the only operation
  in the benchmark suite that got slower as its batch size went up: measured
  over 50,000 rows, 56.98 ms at `batchSize: 1000` and 59.55 ms at 5000, while
  every other arm got faster. The speculation is now bounded BY `batchSize`
  rather than scaled by it. At or below the default (1000) nothing changes;
  above it, a caller asking for large batches has said not to expect a
  one-batch result, and the cursor is used directly. The cost of being wrong
  about that is four round trips on a drain that would have fit, never any
  transferred rows.

### Performance

- **`parseRow` resolves its column mapping once per result set instead of once
  per row.** It was recomputing the same answers for every row: a reverse-map
  lookup and two Set membership tests per column, plus a Map lookup per row for
  the camelCase date-field set. Every row of one result set has the same columns
  in the same order, so this is now a cached per-(table, column-shape) plan. The
  plan is VERIFIED against each row's key list rather than assumed, column by
  column, because applying a plan to a column list it does not describe would
  drop one column from the output and return another as `undefined`, silently;
  the comparison is a pointer compare per column against the driver's own
  interned column names, which is cheaper than the work it replaces. Measured
  ~25% off `parseRow` in isolation. It is on every read path, so it shows up
  wherever a result set is large: combined with the streaming fix above, a
  50,000-row `findManyStream` drops from 56.98 ms to 52.49 ms at
  `batchSize: 1000` and from 59.55 ms to 50.25 ms at 5000, against a
  hand-written `DECLARE CURSOR` / `FETCH` control measuring 43.37 ms and
  40.53 ms in the same runs. Output is unchanged, including each row's own key
  order.

### Benchmarks

- **The suite went from 10 scenarios to 24, and the additions changed two
  published conclusions.** The old set was skewed in a way worth naming: three
  of its ten scenarios were `findUnique`, its largest non-stream result was 100
  rows, and it measured no write other than one atomic increment. That flatters
  small hot reads, which is not where applications spend their time. The new
  `benchmarks/bench-extended.ts` adds large reads (5,000 and 50,000 rows, and a
  deliberately 39-column table), writes (`createMany` at 1,000 rows, update,
  upsert, delete), to-one and many-to-many relations, relation `_count`,
  relation filters, `groupBy` with `having`, and pagination at both a shallow
  and a deep offset. Turbine leads 17 of the 24. Both harnesses now share one
  extracted `bench-harness.ts`, so the interleaving, arm rotation, median
  handling and drift probe cannot drift apart between them.
- **A loss the old suite could not see: deep pagination.** A filtered, sorted
  20-row page costs 0.212 ms at offset 40 and 0.549 ms at offset 9,000, where
  Prisma costs 0.318 and Drizzle 0.341. The cause is not Turbine's SQL: it is
  that Turbine NAMES its prepared statements, which is what wins the repeated
  hot reads, and PostgreSQL promotes a named statement to a value-blind generic
  plan on its sixth execution, at which point a bound `OFFSET` is invisible to
  the planner. The raw-`pg` control settles it, since the same hand-written
  query costs 0.541 ms named and 0.272 ms unnamed. `forceCustomPlan: true`
  (shipped in 0.56.0) takes that query to 0.292 ms. Documented on the
  benchmarks page and in the `planCacheMode` section of the queries docs.
- **A cross-latency axis, which inverted a recommendation the socket-only
  numbers would have produced.** `benchmarks/bench-latency.ts` forwards to the
  same PostgreSQL socket through an in-process TCP proxy that delays each chunk
  by RTT/2, and reruns a subset at 0, 1, 5 and 25 ms. On a socket
  `relationLoadStrategy: 'batched'` is the fastest nested strategy by 1.34x; by
  **1 ms** of round-trip time it is already slower than the join, and at 25 ms
  it is 1.83x slower, because it buys its win with an extra round trip per
  relation. That is the behaviour `'auto'` already had, and `autoRoundTripMs`
  is the dial for it, but the published numbers had no way to show it. In the
  other direction, `pipeline`'s advantage over a transaction grows from 2.7x to
  6.9x as the link lengthens, and every point read converges to within 0.3 ms
  of raw `pg` at 25 ms. The proxy models latency only, not bandwidth or jitter.
- **The nested-read gap is root-caused.** Roughly 34% of an L2 `json_agg`
  payload is repeated JSON key strings (153.8 KB against 102.1 KB with
  `jsonEncoding: 'positional'`), and with encoding held equal the server-side
  and client-side costs both favour Turbine. Positional encoding wins both
  nested scenarios. It stays opt-in for now, for the reason stated on the
  benchmarks page.

## 0.66.0 (2026-08-09)

The output of a full audit of 0.65.0 across security, performance, migrations,
multi-engine parity and code quality. Almost every defect it found has one
shape: a rule that lives in two places and drifted, or a rule that is
documented and lives in none. The destructive-migration guard had its own SQL
lexer that disagreed with the runner's. `DISTINCT ON` was gated in one of the
two places that emit it. Vector validation ran on the build path and not the
cache-hit path. Four PowDB relation paths disagreed about whether a projection
keeps the primary key. Each fix below removes a copy rather than syncing one.

### Fixed

- **A nested block comment turned off the destructive-migration guard.**
  PostgreSQL nests `/* */`; the guard's private lexer ended a block comment at
  the first `*/`, and it split statements on a bare `;` while the runner used a
  correct tokenizer. Both bugs fail OPEN. The worst case was not a total miss
  but a PARTIAL inventory: for a file holding a commented-out block that itself
  contained a comment, a `DROP TABLE` and a `DELETE`, the guard listed only the
  `DELETE`, so the operator confirmed what they were shown and the unlisted
  `DROP TABLE` ran under that confirmation. A semicolon inside a quoted
  identifier (`DROP TABLE "we;ird"`) hid a statement the same way. There is now
  exactly one tokenizer (`src/cli/sql-statements.ts`, a pure leaf) and both
  callers consume it, returning per statement both the verbatim source that
  executes and the comment-stripped source the rules match against, from a
  single walk. Three more fail-opens in the same guard were found by scanning
  for the CLASS rather than re-checking the reported instance, and each was
  confirmed by executing it: `$` is legal INSIDE a PostgreSQL identifier, so
  `SELECT x$y$ FROM t;` was read as opening a dollar-quoted block and swallowed
  the rest of the file (the guard reported nothing and the following `DROP
  TABLE` ran); the procedural path that exists to catch dynamic SQL was still
  stripping comments with its own regex, so a `'x --'` literal earlier in a
  one-line `DO` block hid every destructive statement after it, reachable by
  accident rather than by intent; and `CREATE FUNCTION ... BEGIN ATOMIC DELETE
  FROM users; END;` split on the wrong semicolons. The `$` case also defeated
  the new embedded-transaction refusal, which reads the same tokenizer.

- **Destructive SQL assembled at run time was reported as nothing.** The rules
  need a parseable object name and dynamic SQL has none until it runs, so
  `DO $$ BEGIN EXECUTE format('DROP TABLE %I', 'users'); END $$;` (and the
  `'DROP TABLE ' || quote_ident(...)` and `'DROP ' || 'TABLE users'` spellings)
  dropped the table live while the operator was shown a clean inventory. They
  are now reported with an explicit unknown target. The trigger is evidence of
  runtime assembly (`||`, `format(`, `quote_*(`, `%I`), which is complete rather
  than a heuristic: a destructive statement whose object name is written out
  literally already matches a rule, so being dynamic requires concatenating or
  formatting. `RAISE NOTICE 'DROP the mic'` and a dynamic `SELECT` stay silent,
  because a guard that fires on prose teaches operators to confirm without
  reading.

- **`migrate down` skipped a migration it could not reverse and kept rolling
  back the ones underneath it.** Both failure branches continued where the SQL
  failure path correctly stopped. A `--step 3` where the middle migration had
  no `DOWN` section rolled back the third and then the FIRST, dropping a table
  whose rows the skipped migration had seeded, and left the tracking table
  claiming only that migration was applied. Rollback is now strictly LIFO with
  no gaps.

- **Query SHAPE could exhaust the database server.** Every distinct SQL shape
  was parsed as a NAMED prepared statement and never deallocated, so a caller
  who controlled only the ARITY of a boolean combinator (a `where.OR` array
  built from a UI multi-select) grew the backend without limit: 600 distinct
  shapes held 600 statements and 20.9 MB of cached plans on one connection,
  none of it reclaimed by reuse, and each pooled connection accumulated its
  own. A where clause containing a caller-written `AND`/`OR` array now compiles
  to an UNNAMED statement, which the driver re-parses per execution and never
  accumulates. Turbine's own synthesized wrappers stay named, so a table with a
  global filter is unaffected. `in: [...]` was never affected: it binds one
  parameter regardless of list length.

- **`findMany({ distinct })` emitted PostgreSQL-only `DISTINCT ON` on every
  engine.** The other spelling of the same feature, `groupBy({ distinctOn })`,
  was gated correctly, so this path had no dialect check at all and reached the
  driver as a raw syntax error carrying no Turbine code. It now throws
  `UnsupportedFeatureError` (E017) on SQLite, MySQL and SQL Server.

- **Composite foreign keys introspected as a cartesian product, and constraint
  names were treated as globally unique.** The FK query joined
  `key_column_usage` to `constraint_column_usage` on constraint name alone,
  which is an N-by-N cross join, so a two-column foreign key became four
  AND-ed correlations with two of them mispaired and the relation returned
  nothing, with no error and no warning. Separately, PostgreSQL only requires
  constraint-name uniqueness per table, so two tables sharing a name merged:
  one lost its foreign key entirely and the other pointed at the wrong table.
  A name collision in a different schema silently deleted relations from the
  generated client. Both are one query now, reading `pg_constraint` and pairing
  columns positionally with `unnest(conkey) WITH ORDINALITY`, keyed on the
  constraint OID. Referential actions rode the same collision and are fixed
  with it. Generated output is byte-identical for schemas that were already
  correct.

- **On MySQL, a `json` column's runtime type changed when you added a
  `limit`.** The join strategy embeds the column in `JSON_OBJECT` so it arrives
  parsed, while the batched and flatten plans read it directly so it arrives as
  text, and the default `auto` strategy picks between them. `row.org.meta.tier`
  worked on one query and threw on the same query one pagination argument
  later. `json` now has a wire rule like the other divergent types, so all four
  read paths agree.

- **The CockroachDB and YugabyteDB migration lock was released by the first
  migration's `COMMIT`.** The adapters hold a row lock and deliberately leave
  its transaction open, but the runner applied every migration on the same
  connection and committed per file, so migrations two onward ran unprotected
  and a concurrent `turbine migrate` could take the lock and replay them. The
  failure was silent, and a second face of it made a `-- turbine:no-transaction`
  migration fail or succeed depending on its position in the batch. The lock is
  now held on a dedicated connection. Serialization failures are treated as
  contention rather than crashing with a raw driver error. The regression test
  that previously passed BECAUSE of the bug has been rewritten.

- **Studio and the MCP server leaked the ordering of redacted columns.** The
  PII predicate guard recursed into `AND`/`OR`/`NOT` and relation keys, but a
  pick-row relation ordering puts column names two levels deeper under
  `pick.orderBy`, `pick.where` and `by`, none of which were visited, so a
  read-only session with redaction on could recover a hidden column's full
  ordering and run a character-by-character `startsWith` probe against it. A
  column reference (`{ gt: { col: 'secret' } }`) was a second channel through
  the operand rather than the key. Studio and MCP now share one guard
  (`src/cli/pii-predicate-guard.ts`) that FAILS CLOSED on any unrecognized
  structured shape, so the next ordering form is refused rather than waved
  through.

- **A per-relation `limit` under the batched strategy fetched every matching
  child.** Measured at 200 parents with about 505 children each, the batched
  plan pulled 101,000 rows over the wire to keep 600, at 52.9 MB of peak heap
  against the join plan's 0.5 MB. Reachable without opting in, because `auto`
  routes provably unindexed relations to batched. PostgreSQL now bounds it
  server-side with `ROW_NUMBER() OVER (PARTITION BY ...)`; other engines keep
  the client-side slice. The unlimited path, where batched legitimately beats
  join, emits byte-identical SQL.

- **Vector distance thresholds were validated on the build path only**, so a
  warm SQL cache under `NODE_ENV=production` accepted `NaN`, a string, or an
  object. PostgreSQL sorts NaN above everything, so `distance < NaN` matched
  every row: the opposite of the intent, silently, and only in production.

- **`turbine migrate create <name>` wrote raw argv into the migration body.**
  The name was sanitized for the filename only, and the header sits above the
  `-- UP` marker, so a newline-bearing name injected executable migration SQL
  and could set `-- turbine:no-transaction` to defeat the transaction wrapper.

- **Connection strings with passwords were echoed in errors** on MySQL, SQL
  Server and PowDB, contradicting `SECURITY.md`. The trigger was a MALFORMED
  DSN, which is exactly when someone pastes an error into a bug report.

- **`errorMessages: 'safe'` still leaked row values on MySQL and SQL Server**,
  because redaction hooked on a `detail` field those drivers never set while
  they put the value in `message`, `sqlMessage` and `stack`. The mode was also
  a process-global that the last constructed client won, so a second client
  silently downgraded the first. It is now per-client.

- **The where and having walkers had no depth cap**, so a 64 KB request body
  (under `express.json()`'s default limit) raised a `RangeError` rather than a
  typed error, bypassing the error surface entirely.

- **`ALTER COLUMN ... TYPE` emitted an explicit `USING` cast for narrowing
  conversions**, converting PostgreSQL's own refusal into silent truncation: a
  25-character value became 10. Same-family narrowing now emits the plain
  `ALTER`, so PostgreSQL's assignment cast decides. For a shortened `varchar`
  that means the migration is refused rather than truncating. Numeric and
  temporal narrowing still lose precision, because PostgreSQL's assignment cast
  rounds and truncates rather than refusing; the destructive gate now names the
  specific loss for each instead of the generic "cast may truncate or fail".

- **`schemaDiff` hardcoded the `public` schema** in all eight catalog reads
  while every other command honored `--schema`, so against a dedicated schema
  it reported every table missing and emitted duplicates into `public`. Worse,
  with a legacy copy in `public` it would `ALTER` and `DROP COLUMN` the wrong
  table. `schemaPush` now also pins a transaction-local `search_path`.

- **Column length and numeric precision changes were invisible** to the diff,
  which compared `udt_name` alone, so `push` reported "already in sync" for a
  schema that genuinely differed.

- **`doctor --fix` wrote an index migration that could never succeed.**
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS` matches on name, not validity, so
  over the INVALID index left by a failed concurrent build it silently no-oped
  while recording the migration as applied.

- **Prisma `@map(name: "...")` was ignored on fields**, though the model-level
  handler accepted both forms. The column name was discarded and the field name
  used instead, which in a legacy database is frequently a real column, so
  every read returned another column's data and every write landed in the wrong
  one, with a clean report. A `@relation(fields: [...])` matching no database
  foreign key also fell through to "take the only candidate" instead of
  reporting disagreement.

- **SQLite's JSON `contains` never matched anything.** The reported symptom was
  that object operands degraded; measurement showed scalars failed too, because
  the parameter is bound as JSON text while `json_each.value` yields the
  decoded value. It is now refused with E017 rather than silently returning
  fewer rows.

- **A `BOOLEAN` column typed `boolean` returned `1`/`0`** on SQLite and MySQL,
  including a value Turbine itself had written as `true`. **`_min`/`_max` on a
  date column returned a raw string** on SQLite while `findMany` and `groupBy`
  returned a `Date`. **SQL Server's `LIKE` treats `[` as a wildcard**, so
  `contains: '[draft]'` matched any title containing d, r, a, f or t.

- **PowDB returned the primary key through `omit: { id: true }`**, and its four
  relation paths disagreed about whether a projection keeps it. Also fixed:
  unqualified PowQL column references were emitted unquoted (narrowly, so
  keyword columns stay bare for pre-0.10 compatibility).

- **`PipelineError` (E014) was defined, documented, and never constructed**, so
  `err instanceof PipelineError` was permanently false and the documented
  example could not work. The non-transactional path also now runs every query
  and reports per slot, as its own option already promised.

- Migration files containing their own `BEGIN;`/`COMMIT;` broke the runner's
  wrapper and left the migration half-applied and unrecorded; they are now
  refused, and the shipped `--recipe backfill` scaffold no longer teaches the
  pattern. Section markers accept `--DOWN` and other loose spellings instead of
  folding the rollback into the UP. The tracking table tolerates the
  concurrent-create race that crashed 11 of 12 parallel `migrate status` calls.
  `schemaPush`'s bare `ROLLBACK` no longer replaces the error it is unwinding.
  The destructive rule set gained `DROP TYPE|DOMAIN|EXTENSION|SEQUENCE|FUNCTION
  ... CASCADE`, `DETACH PARTITION`, `EXPLAIN ANALYZE <DML>` (which executes) and
  a `rename` kind, and two quoted-identifier false positives are gone.

### Added

- `src/cli/sql-statements.ts` and `src/cli/pii-predicate-guard.ts`, both pure
  leaves shared by two callers, each with its own coverage floor.
- `check-error-codes` now asserts the REVERSE direction: every error code must
  be constructed somewhere outside the tests. That is what found E014.
- Redundant sort terms are dropped with a dev warning, and long sort lists lose
  their prepared-statement name, which closes the same unbounded-shape vector
  through `orderBy`, `distinct` and `distinctOn`.
- CI's PostgreSQL services now use `pgvector/pgvector`, so the pgvector suite
  executes for the first time instead of skipping itself, and the fixture
  carries GIN expression indexes so full-text search has live coverage.

### Changed

- Non-transactional pipelines reject with `PipelineError` (E014) rather than
  the raw driver error. `.results` keeps its shape and the driver error is
  `.cause`.
- `migrate up` now asks for confirmation on rename-only migrations, and refuses
  a migration file with no recognized `-- UP` marker.
- Studio and MCP refuse some previously-accepted structured query shapes.
  Over-refusing is the intended direction for a redaction boundary.
- The CockroachDB and YugabyteDB rows in the compatibility matrix now read
  Experimental, matching `STABILITY.md`. Their inherited PostgreSQL capability
  flags are documented for the first time.
- The main entry's import graph grew by roughly 5 kB brotli, and `.size-limit.js`
  was re-baselined to match, with the measurement and the reasoning recorded in
  the file. The growth is the new shared leaves plus the widened guards; it is
  not a new dependency, and the runtime dependency set is unchanged (`pg`).

- **Benchmarks re-run and republished.** The README and site had been quoting a
  2026-07-25 measurement of 0.50.0, sixteen releases stale. `RESULTS-0.66.0.md`
  is a fresh three-run measurement on the same hardware, PostgreSQL and fixture,
  with the competitor versions deliberately pinned to the previous run's so the
  two are comparable. Turbine runs at **1.09x hand-written `pg`** (Drizzle 1.49x,
  Prisma 1.86x) and is **1.82x faster than Prisma 7.9** / **1.32x faster than
  Drizzle 0.45** by geometric mean. Two things are now disclosed that were not
  before: the two harnesses disagree on **two** scenarios rather than one, so L2
  nested reads and atomic increment are recorded as contested rather than as
  wins; and the L2 gap to Drizzle widened since the 0.50.0 run (1.21x to 1.32x)
  for reasons this release does not explain. A direct interleaved A/B of 0.65.0
  against 0.66.0 on the same database rules out this release as the cause: 0.66.0
  measured equal or marginally faster on every shape, including the two the
  prepared-statement and projection changes could plausibly have slowed.

### Upgrading

Most of this release is a bug fix you do not have to act on. Four changes can
be noticed, and all four are noticed at BUILD or DEPLOY time rather than in
production, which is deliberate.

**A migration file may no longer contain its own transaction control.** If any
`.sql` migration in your repo contains `BEGIN`, `START TRANSACTION`, `COMMIT`,
`ROLLBACK` or `ABORT` outside a comment or a string, `turbine migrate` now
refuses it before running anything. This is the fix, not an inconvenience: the
runner already wraps each file in exactly one transaction, so an embedded
`COMMIT` ended that wrapper mid-file, made everything before it durable, ran
everything after it unprotected, and recorded the migration nowhere, which left
reruns failing forever on "already exists". Delete your own `BEGIN`/`COMMIT`
(the statements between them are still atomic, the runner supplies the
transaction), or put `-- turbine:no-transaction` in the file header if the
migration genuinely cannot run inside one, such as `CREATE INDEX CONCURRENTLY`.
`ROLLBACK TO SAVEPOINT` is still allowed: it leaves the wrapping transaction
open.

**A rename-only migration now prompts.** `RENAME COLUMN` and `RENAME TO` joined
the destructive rule set, so a migration containing nothing but renames now
requires the two-step typed confirmation. If such a migration runs unattended
in CI, it will block until you add `--allow-destructive` (or use
`turbine migrate deploy`, which is the no-prompt form). Worth checking before
your next pipeline run rather than during it.

**Relation names are now derived in a deterministic order.** Foreign keys used
to be walked in creation order (`pg_constraint.oid`), so a database restored
from a dump and one built from migrations could produce different relation
names and even different CARDINALITIES for the same logical schema, which meant
`with: { profile: true }` could read a different table depending on how the
database was built. The walk is now ordered by (source table, constraint name).
Two consequences on your next `turbine generate`: the relation key order in
`metadata.ts` may shift once, a cosmetic one-time diff, and in the rare case
where two relations competed for the same name, the winner can change. Read the
generated diff rather than skimming it. Partition clones no longer produce
phantom relations either, so one declared foreign key to a partitioned table now
yields one relation instead of one per partition.

**A migration that builds destructive SQL at run time now prompts.** If a
`DO` block or function body assembles a `DROP` / `TRUNCATE` / `DELETE` by
concatenation or `format()`, it appears in the confirmation inventory as
`<name assembled at run time>` rather than not appearing at all. Same
operational consequence as the rename change above: add `--allow-destructive`
or use `turbine migrate deploy` if such a migration runs unattended. Statements
with a literal object name are unaffected and still name their target exactly.

**A `select` projection emits its columns in the table's own order.** The
column list is now canonical rather than the order the caller wrote the keys in,
so the KEY INSERTION ORDER of a projected row object changed. Nothing reads a
projection positionally, and `omit` already worked this way, which is exactly
why `omit` never had the bug: caller-chosen key ORDER minted a distinct,
permanently cached, server-side prepared statement per permutation (measured at
5,040 statements and 39 MB from one seven-column table, reachable from an
ordinary `PATCH` body with no arrays and no opt-in). Only code that depends on
`Object.keys(row)` ordering, or that hashes `JSON.stringify(row)`, will notice.
Write `data` was canonicalized for the same reason and is not observable at all.

**Some previously-accepted query shapes are now refused.** `findMany({ distinct })`
throws `UnsupportedFeatureError` (`TURBINE_E017`) on SQLite, MySQL and SQL
Server instead of emitting `DISTINCT ON` for the driver to reject with an
untyped parse error. Studio and MCP refuse more structured argument shapes than
before. In both cases the refusal replaces something that was already failing,
just less legibly.

## 0.65.0 (2026-08-02)

A hardening release built around one new instrument: a seeded differential
fuzz suite that runs the same randomly generated query through the join and
batched relation strategies and demands they agree, both about the rows and
about whether the query is valid at all. It found three real bugs in its
first minutes of existence; all three are fixed below. The release also adds
error-docs links to every error, closes the last unguarded release path, and
tightens CI.

### Fixed

- **`offset` without `limit` was a syntax error on SQLite and MySQL.** The
  shared SQL path emits the Postgres shape, a bare ` OFFSET $n`, but SQLite's
  grammar only allows `OFFSET` after a `LIMIT` and MySQL has no bare `OFFSET`
  at all, so `findMany({ offset: 10 })` threw a driver syntax error on both
  engines. Each dialect now supplies its documented idiom (`LIMIT -1` on
  SQLite, `LIMIT 18446744073709551615` on MySQL); every other pagination shape
  emits byte-identically to before. Found by the fuzz suite on its first run.

- **A query's validity could depend on how many rows it matched.** The batched
  relation loader returned early when the base query matched nothing, BEFORE
  validating the `with` tree, so an unknown relation or a misspelled relation
  `select` threw on populated data and passed silently on empty data. The join
  strategy validates the whole statement at compile time regardless, and
  `relationLoadStrategy: 'auto'` picks between the two on index coverage and
  table size, so the same program could throw in production and pass in a
  fresh test database. The loader now walks the whole `with` tree even with
  zero parents: each level compiles its child query (one SQL string build,
  nothing executes), so acceptance is decided by the query alone. The same
  rule now holds on a `findUnique` miss. One disclosed consequence: a
  composite-key relation under an explicit `relationLoadStrategy: 'batched'`
  now throws its documented E017 even when the base query matches no rows
  (it already threw on any non-empty result; `'auto'` never demotes
  composite-key relations, so the default is unaffected).

- **An unknown relation in `with` threw E003 under the batched strategy and
  E005 under join.** E005 (`RelationError`) is the documented code for an
  unknown relation; the batched loader now throws it too, with the same
  message. Before this, an error handler catching `RelationError` worked or
  missed depending on which plan the `'auto'` heuristic picked.

- **`select` and `omit` together are now refused (E003) instead of silently
  half-applied.** When both were passed, the SQL engines ignored the `omit`
  half entirely, without even validating its names, so a typo there passed
  while the same typo alone threw; PowDB meanwhile APPLIED select-minus-omit,
  so one query projected different columns per backend. The pair is ambiguous
  (a narrowed projection minus fields), Prisma refuses it, and prisma-compat
  here already refused it; now every engine refuses it with the same message.
  Studio's builder chips enforce the rule live (picking a `select` chip
  switches modes and clears `omit`, and vice versa), and a saved query from
  before the rule loads with `select` winning.

  A `select` that names no fields (empty, or every value `false`) is refused
  the same way. It used to resolve to an empty column list, which emitted
  invalid SQL at the top level and quietly returned `[{}]` rows inside a
  relation. Both refusals are decided on the args as written, before the
  batched loader's internal key-forcing adjustments, so the verdict cannot
  differ between load strategies (an adversarial review of this release
  caught exactly that flip in the first version of the check, and the fuzz
  generator now keeps these shapes in its domain permanently).

### Added

- **Every error links to its documentation.** `TurbineError` gains a
  `docsUrl` property (`https://turbineorm.dev/errors#e003`-style), and every
  error message is suffixed with that link once, idempotently, so a wrapped
  and re-wrapped error never accumulates duplicates. The errors page has an
  anchor per code, and a new sync test fails the build if a code is added
  without a docs row, or a docs row outlives its code: a missing row is no
  longer a docs gap but a broken link printed into the user's own logs.

- **Differential strategy fuzz suite** (`src/test/strategy-fuzz.test.ts`).
  Seeded (mulberry32), runs in the unit lane on fixed seeds against in-memory
  SQLite with a deliberately skewed fixture, and asserts two properties per
  generated query: the join and batched strategies accept or reject
  identically (with the same error code), and when they accept, the rows are
  deeply equal. About 15% of cases plant one invalid name and assert both
  strategies refuse it. A nightly job runs 20,000 cases on a date-derived
  seed so the explored space moves; every failure message carries the seed,
  case index and full args for local reproduction via `TURBINE_FUZZ_SEED` /
  `TURBINE_FUZZ_CASES`.

- **The release path now runs the DB-backed suite.** `prepublishOnly` ends
  with a new gate that, outside CI, runs the full `npm test` against
  `DATABASE_URL` and refuses to publish when no database is reachable
  (`TURBINE_PUBLISH_WITHOUT_DB=1` is the loud emergency escape). A manual
  local publish is the normal release flow here and was the one path that
  never executed the generated SQL against a real Postgres; in CI the gate
  self-skips because the release workflow runs that suite as its own job.

- **The module-graph acyclicity rule is now a build failure.**
  `scripts/check-import-cycles.mjs` refuses any static value import of
  `client.ts` from `src/query/**` or `src/cli/**` (type-only and dynamic
  imports stay sanctioned), self-tests its own matcher before scanning, and
  runs in CI's lint job and in `prepublishOnly`. The rule previously lived
  only as prose in the contributor docs.

- **Size budgets for the last two unmeasured subpaths.** `turbine-orm/cli`
  (1.71 kB) and `turbine-orm/adapters` (1.13 kB) join `.size-limit.js`; both
  budgets guard the same property as prisma-compat's, staying an order of
  magnitude below the core-graph entries.

### Changed

- **Releases create their GitHub Release automatically.** The publish job now
  extracts the version's CHANGELOG section and creates the GitHub Release
  from it, idempotently (an existing release is left alone, and a re-run can
  backfill one without republishing). Release runs also wait for each other
  instead of racing, and a running release is never cancelled (`concurrency`
  with a single group; GitHub holds at most one further run pending, which
  fits the one-tag-at-a-time flow here).

- **CI hardening.** Every job in every workflow now carries an explicit
  `timeout-minutes` (the GitHub default is six hours, so one hung container
  could previously burn a day of runner budget); a CodeQL workflow scans
  pushes, PRs and a weekly schedule with the security-extended query pack;
  `npm audit` is clean again (brace-expansion, dev-only, lockfile-only bump).

- **SECURITY.md rewritten to describe the product that ships.** The old file
  said Studio "is read-only" (write mode shipped in 0.36) and pinned a
  supported-versions table that had drifted 36 minors; the new file states
  the actual perimeter (write-mode routes, full-PK-only predicates, Origin
  checks, PII redaction) and the real support rule: fixes land on the latest
  minor. STABILITY.md's version examples were re-stamped the same way, and
  `.docsUrl` joined its stable structured fields.

## 0.64.1 (2026-07-29)

Maintenance. No API change, and the emitted JavaScript and type declarations are
byte-identical to 0.64.0 (verified by diffing the whole build across the config
change below).

### Fixed

- **The `@next` prerelease channel has been broken for nine releases.** The
  nightly workflow sets the version to `<current>-next.<sha>` and publishes,
  but the CHANGELOG-heading guard in `prepublishOnly` demanded a `## <version>`
  heading for exactly that string, which by construction can never exist. So
  every nightly publish failed and the `next` dist-tag sat months behind
  `latest`: anyone who installed `turbine-orm@next` got something far older
  than they had reason to expect, which is worse than having no prerelease
  channel at all. A prerelease is now resolved to its base version, which is
  the entry that actually describes it.

  The failure was invisible for so long because the only symptom was a red
  workflow. The guard now has its own regression cases, including one that
  fails if stripping the suffix ever turns the check off entirely.

- **A plan-cache measurement could fail under a loaded test run.** Its buffer
  counters come from `pg_statio_user_tables`, and `pg_stat_force_next_flush()`
  flushes only the calling backend, so counts from a neighbouring connection
  could land inside a measurement window and inflate it. The baseline now waits
  for the counter to go quiet, and skips with a reason if it never does: a
  number measured on a moving counter proves nothing, and reporting it as a
  product failure is how a suite teaches people to ignore its own red.

### Changed

- **Removed a dev-only warning for an unknown `orderBy` field.** It printed
  `Unknown orderBy field "x" for table "y". This will cause a runtime error.`
  and then let compilation continue into the code that throws for the same key
  with a better message, one that names the table, suggests the closest column
  and lists the valid relations. Every unknown-key shape was measured (plain
  direction, `OrderBySpec`, JSON path, both relation-shaped values, array form)
  and all of them warn and then throw, so nothing loses a signal. What it cost
  was noise in dev logs and a second copy of the key-resolution rules that
  could drift from the real one. The refusal itself is now pinned by tests.

### Internal

- **TypeScript 7 readiness.** The CJS build declared `moduleResolution: "Node"`
  (node10), which TypeScript 6 deprecated and 7 removed outright: on 7 it fails
  the whole build with TS5108 before reading a file. It now uses `bundler`, the
  only resolver that pairs with `module: CommonJS` (the base config's
  `NodeNext` cannot be inherited here, since it reads the root package.json and
  would emit ESM into `dist/cjs`). Resolution mode is compile-time only, and
  the emitted tree is byte-for-byte unchanged.

  One test also imported the TypeScript compiler API to check that generated
  code parses. TypeScript 7 moved that API (the package root is now a version
  stub and the compiler lives under `unstable/*`), so the import pinned the
  repo to TypeScript 6. It drives the `tsc` binary instead, which is what the
  sibling generated-output test already did. That check turned out to be
  passing vacuously even before the switch, since running it from the repo root
  made `tsc` refuse the arguments and check nothing; it now asserts that `tsc`
  actually reached the source.

## 0.64.0 (2026-07-29)

**Breaking, and deliberately so.** A `select` or `omit` naming a field that does
not exist now throws instead of being quietly ignored. Previously that was true
only at the top level of a query; one level down, inside a relation, the same
key was filtered out and the query ran anyway.

This is the same class as 0.63.0's silent relation, seen from the other side:
a projection is a list of NAMES a human typed, and a name that does not resolve
has exactly two honest outcomes. It had a third.

### Fixed

- **A typo inside a relation's `select` or `omit` was silently ignored.** The
  `select` form returned `{}` rows; the `omit` form returned the column it was
  asked to hide.

  ```ts
  // before 0.64, no error either way
  with: { posts: { select: { titel: true } } }   // -> posts: [{}, {}]
  with: { posts: { omit:   { titel: true } } }   // -> title comes back
  ```

  The `omit` direction is the one worth staring at: a typo in the clause whose
  entire job is suppression returned the value it was meant to suppress. It is
  the idiom for a sensitive-but-untagged column (`passwordHash`, `resetToken`),
  so the caller asked for the column to be withheld, got no error, and shipped
  a response they believed was filtered.

- **The two relation-load strategies disagreed about whether such a query was
  valid at all.** The batched loader runs each relation as a real query against
  the target table, so it went through the strict resolver and threw; the join
  plan went through the silent one and returned rows. Under the `'auto'`
  default, which plan runs is decided by a cost heuristic reading index coverage
  and table size, so the same code threw on one table and quietly returned the
  wrong shape on another, and adding an index could flip it. Same failure mode
  as the nested `_count` disagreement fixed in 0.63.0, and both are now closed
  the same way: the strategies must never disagree about validity.

### Changed

- **A relation named in `select` or `omit` gets its own error**, naming the fix
  rather than hunting for a misspelling that is not there:

  ```
  [turbine] "comments" is a relation on table "post", not a column, so it
  cannot be named in `select`. Load it with `with: { comments: true }`, which
  is a sibling of `select`, not a member of it.
  ```

  This is a habit, not a typo: Prisma nests relations inside `select`, so it is
  the natural first guess coming from there. The generic unknown-field text
  degraded into `Did you mean "comments" (a relation)?` for a name spelled
  exactly right, which answers a question nobody asked. Applies at every depth
  and on every engine, PowDB included.

### Internal

- **The two projection resolvers are now one function.** They existed as
  `resolveColumns` (the query's own table) and `resolveTargetColumns` (a
  relation target), doing the same job against different metadata, and kept in
  step by whoever remembered. That is what produced the split above. Merged into
  a single `resolveProjection` that both call, which is the same move
  `walkWhere` represents for WHERE compilation after the top-level and
  relation-scoped walkers drifted twice. Two functions that must agree are a
  standing liability; one function cannot disagree with itself.

- **Audited every other place a caller-supplied name is resolved**: `where`,
  `orderBy` (including relation and SQL Server paths), `distinct`, `groupBy`
  `by` keys, aggregate targets, and create/update `data` keys. All of them
  already threw. Projections were the only silent one, and there is now no site
  in the codebase that filters an unresolvable name out instead of rejecting it.

### Upgrading

Nothing to do unless a query names a field that does not exist, in which case
it was already not doing what it said. If an upgrade surfaces a throw, the key
was being ignored before: check whether the intended column is spelled
differently, or whether it is a relation that belongs in `with`. The error names
both possibilities.

Turbine-native code is usually protected before this ever runs, since a
generated client types `select` / `omit` against the model. The paths this
catches are the untyped ones: a projection assembled from request parameters, a
compat layer, or plain JavaScript.

## 0.63.0 (2026-07-28)

Two silent data-corruption bugs, both of the same shape: **a projection narrowed
for one purpose removed a column another purpose depended on, and the code that
depended on it could not tell "absent" from "legitimately null".** Neither threw,
neither logged, and both returned a well-formed answer that was wrong.

One was reported against a 119-model application; the other was found while
fixing it and is more serious. Both are pinned by regression tests verified to
fail against the old code, and a 227-case matrix now enforces that the two
relation-load strategies agree on every projection, cardinality and depth.

### Fixed

- **A relation nested inside a `select`-narrowed relation came back `null` or
  `[]` under the batched strategy.** The batched loader stitches parents to
  children in JS, so every level needs its correlation key in the rows it was
  handed. The root call sites resolved that key set from the whole `with` clause;
  the two NESTED call sites passed only the single key that stitches their own
  level, so a child projection narrowed by `select` (or by an `omit` naming the
  FK) dropped the key the next level down was about to correlate on. The loader
  then saw zero keys and took its legitimate "no parent points anywhere" branch.

  A reporting endpoint that summed a money column across such a relation
  returned 0 for a large fraction of a page, with an HTTP 200 and nothing in the
  payload, the logs or the status to distinguish it from the truth.

  It needed three things at once, which is why it survived so long: the batched
  strategy (which `'auto'` selects on its own for an unindexed correlation
  column, so nobody has to ask for it), a `select` or `omit` on a to-many, and
  another relation inside it. `include` projects every scalar so the key is
  there, and `join` correlates in SQL and never reads a key off a row, so the
  two shapes people reach for first are both clean.

- **A PII-tagged column that is part of the primary key made rows unaddressable,
  and writing one back mutated every row that shared the rest of the key.**
  Found while fixing the above; worse, because it corrupts on the write path.
  The PK exemption ("tag sensitive data, not keys, the returned row must stay
  addressable") was stated in the docs and implemented at exactly one site, the
  write `RETURNING` list. Every read projection missed it, and `parseWriteRow`
  deleted the column the `RETURNING` list had deliberately kept.

  So a row came back without part of its own key. Round-tripping it into an
  `update` produced a PARTIAL predicate: the missing member is `undefined`,
  which the where compiler drops, and the empty-where guard does not fire
  because the other member is present. Measured on a composite `(org_id,
  email)` PK: **three rows rewritten where one was asked for, no error.** The
  exemption now lives inside the two PII helpers, so every projection inherits
  it and no call site can miss it again.

- **PowDB: `omit` could remove the primary key, emptying every many-to-many
  relation.** The same class in the PowDB engine. `projectedColumns` force-adds
  the PK under `select`, then applied `omit` afterwards and unconditionally,
  undoing it. The m2m loader keys its target map on that PK, so every target
  collapsed onto the string `"undefined"`, no parent matched, and the relation
  came back `[]` for every row. A PII-tagged PK was dropped there too, with the
  same consequence as above.

### Changed

- **A PII-tagged primary-key column is now returned by default reads.** Visible
  behaviour change, and the deliberate half of the write-path fix above: a row
  that cannot address itself is a silent-corruption hazard, and this is the
  policy the project already documented. Tag sensitive data, not keys.

- **Nested `_count` now throws on every strategy instead of only some.**
  BREAKING for anyone pinned to `'batched'` and using it. `_count` inside a
  nested `with` was refused by the join builder (E005) and accepted by the
  batched loader, so one query with one set of args either threw or returned
  populated counts depending purely on which plan ran, and under the `'auto'`
  default that is decided by a cost heuristic reading index coverage and table
  size. The same code therefore worked on a small table and threw on a large
  one. Both strategies now refuse it, which is the behaviour the codebase
  already documented in two places. Teaching the join path nested `_count` is
  the right end state and is tracked separately: it means the four
  `json_build_object` emission sites, the positional encoding, SQL Server's
  `FOR JSON` override and PowDB's nested projections all learning it together.

### Added

- **The batched loader refuses a relation whose correlation key is missing from
  every parent row**, instead of returning an empty one (E017, naming the
  relation and the workaround). The two states are distinguishable and were not
  being distinguished: an unprojected column is ABSENT from the parsed entity,
  while a selected column holding SQL NULL is PRESENT with the value `null`.
  This is the durable guard, because it fires on the class rather than on any
  one shape. Both loaders check it, on both the parent and the child side.

- **A 227-case strategy-equivalence matrix** (`select` / `omit` / bare x nested
  to-one / to-many / `_count` x depth 1-3 x every cardinality x root
  projection), asserting the join and batched strategies agree on both value
  and key ORDER, with a per-case precondition that the fixture actually carries
  data so a case cannot pass vacuously. The documented "byte-for-byte identical
  output" contract had never been enforced across shapes, which is the reason
  the first bug reached an application at all.

## 0.62.1 (2026-07-28)

### Fixed

- **SQL Server: a `BIGINT` child key came back as a string under the join
  strategy.** Silently breaking for anyone who was reading that string.
  Turbine narrows a safe `BIGINT` to a number on the driver's own rows, so a
  top-level read and the batched loader both return `1`. Since 0.51 the join
  strategy casts `BIGINT` to text so `FOR JSON PATH` cannot round it through an
  IEEE double, and that rule kept the text unconditionally, reproducing the raw
  driver value rather than the value Turbine hands back. So a `with` under the
  join strategy was the one route returning `'1'`, which means switching
  `relationLoadStrategy` for performance silently changed the caller's value
  types. The decode now re-applies the same safe-integer narrowing, the policy
  the mysql and sqlite dialects already use for their own 64-bit types; above
  2^53 all three keep the string, which is why the text is carried at all.

  Found by a new cross-engine battery that runs the identical fixture and the
  identical assertions on every engine, plus a tiebreaker case that compares a
  child row loaded through a relation against the same row read directly. "The
  two strategies disagree" does not say which is wrong; the driver's own value
  for a direct read does.

## 0.62.0 (2026-07-28)

A hardening sprint off the back of a full product review. The theme is one
class of bug: **an option the caller set that quietly did nothing**, and its
mirror, **a value the caller asked to be hidden that came back anyway**. Nine
of these shipped in previous versions. None threw, none logged, and most
returned a plausible answer, which is why the suite did not have them.

Every fix here was reproduced against the old code first, and every one is
pinned by a regression test that was checked to FAIL before the fix and pass
after. Two rounds of adversarial review ran over the sprint's own output; the
first round refuted all seven tracks, and the defects that round found are in
this release too, not deferred.

### Security

- **`skipGlobalFilters`, `includePii` and `allowFullTableScan` are now unlocked
  by a symbol, not by `true`.** BREAKING. All three were ordinary boolean
  siblings of `where` on the query-args object, so `findMany({ ...req.body })`
  turned a request field named `includePii` into a real privilege escalation:
  the tenant filter dropped, or the PII columns returned, from a body the
  attacker wrote. Typing them `boolean` and documenting the risk is not a
  boundary. They now take the exported `UNSAFE` sentinel
  (`includePii: UNSAFE`), which `JSON.parse` cannot produce at any depth, so
  mass assignment is structurally unable to set them. `true` THROWS rather
  than being ignored, so a call site that had the privilege keeps it only
  after a human edits it. The sentinel is registered with `Symbol.for`, so
  the ESM and CJS halves of a dual-package install agree on it.

- **`turbine init --url` no longer writes a password into `turbine.config.ts`.**
  The scaffold inlined whatever `--url` carried, and `turbine.config.ts` is a
  tracked file, so the first command a new user runs committed their database
  password. A password-bearing URL now goes to `.env` as `DATABASE_URL`, the
  config reads `process.env.DATABASE_URL`, and `.env` is appended to
  `.gitignore` when the file does not already ignore it (parsed line by line,
  honoring negations and anchors, not by substring). An existing
  `DATABASE_URL` in `.env` is never overwritten.

- **The MCP server no longer leaks index literals or opens a row-count
  oracle.** `explain_query` refused a predicate only on a code-first `pii`
  tag, while `sample_rows` also refuses to fetch a secret-NAMED column, so the
  exact column `sample_rows` would not show was extractable one character at a
  time through the planner's row estimate. `sanitizeIndex` now withholds an
  expression index's key list in both the partial and non-partial branch,
  finds the predicate boundary OUTSIDE string literals (a key list containing
  the text `' WHERE '` used to split mid-literal and ship the literal), and
  withholds a definition it cannot parse instead of passing it through. The
  secret-name rule is anchored to identifier segments, so `secretary_id` and
  other ordinary columns are no longer hard-refused.

- **PII redaction fails closed when it cannot read the tags.** Studio and the
  MCP server load PII tags out of the generated `metadata.ts`. A truncated
  file (an interrupted `turbine generate`, a disk-full write, a merge
  conflict) used to scan as "this schema tags nothing", which is
  byte-identical to success and served every tagged column. The scanner is now
  a real structural tokenizer that reports whether the object closed, an
  unreadable file redacts EVERY column rather than none, and both surfaces say
  so at startup.

- **The driver error attached as `.cause` is redacted under
  `errorMessages: 'safe'`.** Postgres puts the CONFLICTING ROW VALUES in a
  constraint error's `detail` field and nowhere else (`Key
  (email)=(alice@example.com) already exists.`). 'safe' mode kept those out of
  Turbine's own message and then attached the raw driver error verbatim, so
  the values still reached everywhere an error is rendered whole: Node's error
  printer walks the cause chain, and Sentry and similar sinks serialize each
  link. The cause is now a shallow clone with `detail` replaced, cloned rather
  than mutated so the driver's own object is untouched, and constructed so it
  stays a real native error with its `code`, prototype and stack intact.

### Fixed

- **`orderBy: { x: 'DESC' }` sorted the opposite way on some engines.** Every
  direction consumer was spelled `String(v).toLowerCase() === 'desc'` in one
  place and `v === 'desc'` in another, so an uppercase or misspelled direction
  fell through to the default in some paths and was honored in others, giving
  one query two sort orders across engines. One `assertOrderDirection` now
  validates every site on every engine: any casing is accepted, anything else
  throws E003 instead of silently sorting the other way.

- **`omit` was dropped on prisma-compat writes, and its keys were never
  validated.** `omit` is the idiom for a sensitive-but-untagged column, and it
  demonstrably works on `findMany`, so a caller had positive evidence for
  assuming it works on `create`. It was accepted and ignored. It now applies,
  and a misspelled key throws instead of silently returning the column: this
  projection is applied client-side and never reaches core, so core's E003 on
  an unknown projection key could not fire.

- **Studio's saved queries lost clauses on reload.** The builder pane holds
  database COLUMN names and a Turbine query addresses a FIELD, and the loader
  translated in neither direction, so on any snake_case schema a reloaded
  saved query returned more rows than it did when it was saved, with no toast
  and no error. Separately, two clauses on the SAME column under `AND` were
  merged with `Object.assign`, so a range like `gte 18` AND `lte 65` became
  `lte 65` alone: the pane showed two filters and the query applied one.

- **A connection failure escaped as a raw driver error.** `pool.connect()` was
  wrapped everywhere except the pipeline path, so a wrong password or refused
  connection there arrived as a pg `DatabaseError` whose `.code` holds a
  SQLSTATE, the same property Turbine puts `TURBINE_E0NN` in. Connection-class
  failures now come back as typed `ConnectionError` (E004) carrying the driver
  code and an actionable next step.

- **An unusable connection string is refused at construction.** A typo'd or
  truncated string was handed to pg, which resolved the missing parts from
  libpq defaults and connected somewhere else entirely. The check replays the
  parse pg itself performs rather than pattern-matching a scheme, so
  Unix-socket and Cloud SQL strings that pg accepts are still accepted.

### Added

- **A CLI coverage gate with per-file floors.** `cli/studio.ts` (write mode
  and PII redaction), `cli/migrate.ts` (destructive DDL) and
  `cli/destructive.ts` (the scanner that decides what counts as destructive)
  were excluded from coverage entirely, so there was no ratchet on the
  highest-consequence code in the package. `npm run test:coverage:cli` gates
  them with their own thresholds, per file rather than aggregate-only, and
  runs in CI and in `prepublishOnly`.

- **`check:package` and the missing subpath smoke tests on the release path.**
  `publint --strict` and `attw --pack` now run before publish, catching a
  broken exports map or CJS declarations that resolve to ESM. The release
  workflow import-smokes the `mysql`, `mssql`, `powdb` and `prisma-compat`
  subpaths with their optional peers absent; it previously checked fewer
  published entry points than CI did.

## 0.61.0 (2026-07-28)

Five defects found by a full product review of 0.60.1. Every one of them failed
SILENTLY, and four of the five returned a plausible answer, which is why the
suite did not have them: a test that asserts the happy path cannot see any of
these. Each was reproduced before it was fixed and is pinned by a regression
test in the direction that would have caught it.

### Fixed

- **`findUnique` returned an arbitrary row when its `where` had no predicate.**
  BREAKING, and a security fix. `{ id: undefined }` is what
  `{ id: req.params.id }` becomes when the parameter is missing or misspelled.
  Undefined keys are dropped downstream, so the emitted SQL was
  `SELECT … FROM t LIMIT 1`: no predicate at all, and a caller that would have
  handled `null` silently received someone else's row. `findUniqueOrThrow` was
  worse, promising to throw when nothing matched and returning a stranger's row
  instead. Both now throw `ValidationError` (E003). The check runs against the
  USER's `where`, before global filters merge, deliberately: a tenant filter is
  not a unique selector, and letting it satisfy the check would still return an
  arbitrary row from inside the tenant. `findFirst` is unchanged, since "the
  first row matching an optional filter" is its contract.

- **An unrecognized `isolationLevel` silently downgraded the transaction.**
  BREAKING. The level was resolved by indexing a plain object, and a miss
  produced `undefined`, which renders as a bare `BEGIN`. So
  `isolationLevel: 'serializable'` (wrong case) asked for SERIALIZABLE and got
  READ COMMITTED: the caller holds a guarantee it does not have, and the
  workload that needed it produces wrong data with no error. The TypeScript
  union never prevented this for a JavaScript consumer, a value from config or
  an environment variable, or anything crossing an `as`. Now throws
  `ValidationError` listing the accepted values, before a pool connection is
  taken. The map is also null-prototype now: `isolationLevel: 'constructor'`
  previously emitted `BEGIN ISOLATION LEVEL function Object() { [native code] }`.

- **COMMIT-time database errors escaped the typed-error system.** BEGIN and
  COMMIT were the only statements issued without `wrapPgError`. Postgres reports
  DEFERRABLE constraint violations, and a good share of SERIALIZABLE conflicts,
  at COMMIT rather than at the statement that caused them, so those surfaced as
  a raw pg `DatabaseError` carrying a SQLSTATE in `.code`, the SAME property
  Turbine puts `TURBINE_E0NN` in, with no `.cause`. A check for
  `TURBINE_E008` silently missed them, and a retry loop keyed on
  `SerializationFailureError.isRetryable` would never fire for exactly the
  commit-time conflicts that are the main reason to run SERIALIZABLE.

- **A throw in the pipeline send path wedged a pooled connection permanently.**
  `valueMapper: prepareValue` runs synchronously inside `bind`, so a parameter
  with a throwing `toPostgres`/`toJSON` (or a circular reference) escaped
  mid-sequence with Parse/Bind bytes corked and no `Sync` ever sent. The
  connection was then returned to the pool, which reported it idle and healthy;
  the next borrower's first query hung forever, with nothing pointing back at
  the pipeline call that caused it. `uncork()` now runs in a `finally` and the
  socket is destroyed rather than returned.

- **`turbine migrate up --dry-run` and `migrate down --dry-run` APPLIED the
  migrations.** The flag was parsed and read by `push` and `deploy` only. On
  `migrate up` it was inert: accepted, no warning, migrations applied. A flag
  whose entire purpose is "show me what this would do to the database", pointed
  at a production URL, ran it. Both now print the exact SQL, parsed through the
  same `parseMigrationContent` the executor uses, and execute nothing.

### Changed

- **Corrected claims in the README and site that were wrong or stale.** The
  bundle-size figure had drifted about 12% low over ten releases while naming a
  version and date, so it read as precise; prose now states the CI-enforced
  ceiling from `.size-limit.js` (under 77 kB main, under 61 kB edge) rather than
  a measurement that goes stale silently. "Prisma Studio is proprietary" was
  false, `@prisma/studio-core` is Apache-2.0; the accurate claim is that it has
  no read-only mode. The note on Kysely rested on a linked issue whose state had
  changed and now states the runtime behaviour directly. The comparison table
  credited Prisma with single-query nested relations by default, which its own
  Preview flag contradicts.

## 0.60.1 (2026-07-28)

### Changed

- **Corrected what the Prisma schema fingerprint is documented to normalize.** No
  behaviour change. 0.60.0 said "trailing whitespace", which reads as
  per-line. The rule is end-of-FILE only: whitespace and blank lines after the
  final newline are ignored, trailing whitespace on an individual line is hashed
  and does count as a change. That is the intended behaviour, since nothing in a
  checkout puts trailing spaces on a line, so it is an edit like any other. The
  0.60.0 entry, the source comment and the migration page now say so, the site
  page carries the full table, and five tests pin the boundary in both directions
  so a later tidy-up of the normalizer cannot quietly widen it.

## 0.60.0 (2026-07-28)

### Added

- **prisma-compat warns when its name map is stale.** Nothing re-runs
  `turbine migrate-from-prisma`. When the Prisma schema changes and the map does
  not, the adapter keeps translating the names it has: a model added last week is
  simply not on the compat client, a renamed field is quietly absent from results.
  Both read as adapter bugs, and neither produces any signal at all. The command
  now writes a `source: { path, hash }` into the emitted map, and
  `createPrismaCompatClient` compares that hash against the file on disk once per
  process and warns, naming the file and the command that fixes it.

  Subordinate to not breaking a working app, in every direction: skipped entirely
  when `NODE_ENV=production`; silent when the file is missing, since not shipping
  `prisma/` to production is normal and is not evidence of drift; silent in a
  bundled runtime with no `node:fs`; asynchronous and unawaited, so client
  construction never waits on a file read; and once per process per path. A map
  generated before this release, or written by hand, carries no `source` and is
  skipped. The fingerprint is FNV-1a over the file with line endings, a leading
  byte-order mark and end-of-FILE whitespace normalized away, so a Windows checkout
  of an unchanged file is not reported as drift. Nothing else is normalized. That
  end-of-file rule is not a per-line one: trailing whitespace on an individual line
  is hashed and does count as a change, as does an edited comment, because nothing
  in a checkout introduces either and an unnecessary regeneration costs less than a
  missed one.

- **`turbine migrate-from-prisma --if-db`**, so the command can live in
  `postinstall` next to `prisma generate` rather than depending on someone
  remembering to run it. When no connection string resolves, it prints one line
  saying nothing was regenerated and exits 0, instead of failing. An `npm ci`
  inside a build image legitimately has no database, and without the flag that
  would turn a missing `DATABASE_URL` into a failed install. Existing artifacts are
  left untouched. Documented on the CLI and migration pages, along with the CI
  check (`--no-timestamp` then `git diff --exit-code`) for projects that want the
  map's freshness enforced rather than nudged.

### Changed

- **Test-case names and provenance wording.** Test and fixture names that carried
  opaque external-report labels now state what they assert. `scripts/check-private-terms.mjs`
  gained a tracked set of patterns for wording that attributes a change to who
  reported it or identifies a system a measurement was taken on, so the check runs
  in CI and in every clone rather than only where a local blocklist exists. No code
  behaviour changes.

## 0.59.2 (2026-07-28)

### Changed

- **Example and fixture naming, no code behaviour changes.** Doctor remediation
  examples, source comments, unit-test fixtures and two benchmark seeds used
  table and column names carried over from schemas Turbine was validated
  against rather than synthetic ones. All are now generic (`documents` /
  `document_versions`, `ledger_entries` / `ledger_lines`, `product` /
  `category`, `user_session` / `tenant_id`). Test and benchmark identifiers are
  synthetic by policy, and the regression shapes they pin are unchanged.

## 0.59.1 (2026-07-28)

### Changed

- **Documentation wording only, no code behaviour changes.** Several notes in the
  changelog, README, site and source comments described a measurement by the
  environment it was taken in rather than by what was measured. The numbers are
  unchanged; only the framing is. Turbine's docs describe what the software does
  and what was measured, never where a report came from.

## 0.59.0 (2026-07-27)

### Fixed

- **The plan-flip probe missed every low-estimate column served by any usable
  index.** 0.58.0 refuted a finding when the generic plan was a `Seq Scan` of the
  target table. That is one of two ways a plan can fail to be the ordered index
  walk a finding claims, and it is the wrong one to pick alone: a column whose
  generic estimate is below the flip boundary plans as
  `Limit > Sort > Bitmap Heap Scan` whenever an index is available, never
  reaching a seq scan, so it survived as a false positive.

  The case that surfaced it carried `btree (col) WHERE col IS NOT NULL`. An
  equality predicate implies not-null, so that partial index is fully usable.
  Reproduced as a pair at the same estimate, differing only in whether the index
  exists:

  ```txt
  partial index, est 1.9   Limit > Sort > Bitmap Heap Scan   0.58.0 kept this
  no index,      est 1.9   Limit > Sort > Seq Scan           0.58.0 refuted this
  either,        est 500   Limit > Index Scan (no Sort)      both keep, correctly
  ```

  The refutation is now stated as the question actually being asked, **"is the
  generic plan the ordered index walk"**, with two independent grounds: a `Sort`
  above the target's scan (which bounds the cost by the match count rather than
  by how far the walk travels, whatever access feeds it), or a `Seq Scan` at the
  target itself. The second is kept as its own ground so a hypothetical ordered
  seq scan still refutes.

- **This is not "exclude columns with a partial index".** A partial index whose
  predicate is NOT implied by the equality cannot serve the query, and such a
  column produces a genuine finding: one was measured at 19,961x. The property
  that matters is whether the planner *could* use the index, which is a proof
  obligation over predicates, and the plan the probe already fetches carries the
  answer. Reading it is cheaper than re-deriving it and cannot drift from
  Postgres's own implication rules.

- **`Incremental Sort` deliberately does not refute.** It means the index
  supplies a prefix of the ordering, so the walk is still partly ordered and
  closer to the catastrophic shape than to the bounded one. Over-refuting deletes
  real findings invisibly; over-keeping only costs noise.

- **A `Sort` elsewhere in the plan does not refute.** Only one above the target
  table's own scan counts, so a sorted branch of a join cannot silently drop a
  finding.

## 0.58.0 (2026-07-27)

### Fixed

- **`turbine doctor`'s `unindexed-filter` findings are now put to the planner
  before being reported, which removes most of them.** The branch shipped in
  0.57.0 answering "IF this cached plan flips, how bad is it" without answering
  "CAN it flip at all". In validation against a large schema it emitted 39
  findings, and a measured sample of 13 of them held up only 6 times. Every
  false positive had the same
  signature: **the generic plan keeps the same sequential scan the good plan
  chose**, so the amplification the finding printed described a plan the planner
  would never pick.

  Each such finding now costs one `EXPLAIN` **without** `ANALYZE`, which plans
  and discards, executes nothing, and returns in microseconds:

  ```sql
  PREPARE p AS SELECT * FROM t WHERE col = $1 ORDER BY ord LIMIT $2;
  SET LOCAL plan_cache_mode = force_generic_plan;
  EXPLAIN (FORMAT JSON) EXECUTE p(NULL, 20);
  ```

  Only the generic plan is needed: the finding's whole claim is that a promoted
  plan abandons the seq scan, so a generic plan that IS a seq scan refutes it
  regardless of the custom plan. That also removes the need for a representative
  rare value, which statistics do not carry. `NULL` is safe precisely because the
  plan is generic, and the limit stays bound as `$2` because that is the shape
  Turbine emits.

  `doctor --json` gained `planDivergenceScored.flipProbed` and `.flipRefuted`, so
  a consumer can tell a verified list from an unverified one instead of inferring
  it from the count, and the human report states which it is.

- **A probe that fails keeps its finding.** Errors, timeouts and unparseable
  plans all yield `unknown`, the finding survives, and a notice says so. A
  diagnostic that deletes findings when the database is uncooperative would fail
  invisibly in exactly the environments (restricted roles, non-Postgres engines)
  where a human is least able to notice. Each probe is savepointed, so one
  unprobeable column does not cost the ones after it.

### Changed

- **The arithmetic gate this replaces was measured wrong and is NOT shipped.**
  The natural rule is to require the generic row estimate (`rows / n_distinct`)
  to exceed the assumed `LIMIT`, reasoning that Postgres discounts an ordered
  index walk by `min(1, limit / estimate)` so an estimate at or below the limit
  earns no discount. Measured on a 247-page fixture, the flip boundary sits
  between estimates **3 and 4**, not at the limit of 20:

  | generic estimate | 2 | 3 | 4 | 10 | 20 | 500 |
  | --- | --- | --- | --- | --- | --- | --- |
  | generic plan | seq | seq | index | index | index | index |
  | buffers | 250 | 250 | 20,074 | 20,074 | 19,071 | 765 |

  Estimates 4 through 20 are full-table walks that such a gate would discard. The
  real limit fraction for a BOUND limit is `ceil(0.1 x estimate) / estimate`,
  which pins to 0.1 at estimates of 10 or more but rises to `1/estimate` below
  that; the plan is then chosen by comparing that fraction of the full index scan
  against a seq scan plus sort. Because it is a cost comparison the boundary also
  moves with the table, landing in a different place on a 1976-page table and on
  an 89-page narrow one. A closed-form gate was attempted, failed its own
  out-of-sample prediction, and was dropped in favour of asking the planner.

## 0.57.0 (2026-07-27)

### Fixed

- **`turbine-orm/prisma-compat` silently dropped every Turbine-native query
  option, so 0.56.0's `forceCustomPlan` did nothing on that client.** The option
  shipped, was documented, was measured at the wire on the core client, and
  `turbine doctor`'s own remediation text told readers to reach for it. Through
  the compat adapter it was accepted by the type-checker and dropped on the
  floor. Measured before the fix on one pooled connection (`poolSize: 1`), the
  same read executed 3 warmup + 12 measured times per row, reading
  `pg_prepared_statements` on that same session afterwards:

  ```txt
  core,   default                 prepared: t_5109978894a0ccdd(g=10,c=5)
  core,   forceCustomPlan: true   prepared: NONE
  compat, default                 prepared: t_5109978894a0ccdd(g=10,c=5)
  compat, forceCustomPlan: true   prepared: t_5109978894a0ccdd(g=10,c=5)   NO EFFECT
  ```

  After the fix the compat row reads `prepared: NONE` like the core one. The
  `g=10` in the default rows is real generic-plan promotion, so the `NONE` is the
  option taking effect and not an artifact of a quiet fixture.

  It was never only `forceCustomPlan`. The translator built a fresh Turbine args
  object and copied a hand-written allowlist of keys, so **every** Turbine-only
  option added since that list was written was stranded the same way:
  `warnOnUnlimited`, `skipGlobalFilters`, `allowFullTableScan`, `timeout` on
  every write except `create`, `optimisticLock`, `stableRelationOrder`, and
  `distinctOn` on `groupBy`. Each is now forwarded and each is covered by a live
  test that asserts an observable consequence rather than the shape of an args
  object (`optimisticLock` raising `TURBINE_E015` on a stale version,
  `allowFullTableScan` getting a `where: {}` past the empty-where guard,
  `skipGlobalFilters` returning rows a configured global filter removes, and so
  on).

- **The drift that caused it is now a build failure.** `src/query/option-surface.ts`
  holds one `Record<keyof SomeArgs<Row>, OptionKind>` table per query-arg
  interface, the same mechanism `TURBINE_CONFIG_KEYS` already used for the client
  config. Adding an option to a core arg interface stops that file compiling
  until a human classifies the new key, and listing a key that is not on the
  interface fails as an excess property. It does not make one edit sufficient,
  deliberately: two options carry field names in their values
  (`optimisticLock.field`, `distinctOn.columns`), and a passthrough-by-default
  translator would forward the Prisma spelling into core, which is correct on a
  schema whose names coincide and broken on one that renames a column. What it
  does guarantee is that the second edit can no longer be forgotten in silence.

- **Unknown query-level options warn in compat instead of vanishing.**
  `compat.User.findMany({ thisOptionDoesNotExist: true })` used to be accepted
  and dropped as a class. It now logs one dev-only line per
  `model.operation.key`, in the same spirit as the unknown-client-config warning
  added in 0.53, with the nearest real option suggested:

  ```txt
  [turbine] prisma-compat: unknown option "customPlan" in User.findMany(), it is ignored. Did you mean "forceCustomPlan"?
  [turbine] prisma-compat: "limit" is Turbine's spelling and is ignored here; prisma-compat takes Prisma's "take". (User.findMany)
  ```

  It warns, never throws: a stray key must not turn a working app into a failing
  one on upgrade. Legitimate Prisma keys never warn (verified silent across 28
  realistic Prisma call shapes), and neither do the Turbine-only options the
  adapter hand-translates.

- **`turbine doctor`'s plan-divergence remediation no longer assumes which
  client you are holding.** Step 3 previously told every reader to scope the fix
  with `forceCustomPlan`, which was a no-op advice for a compat integration, and
  step 4 said "do NOT set `planCacheMode` on the client to fix this", which names
  a Turbine-specific option to a reader who may not have it. Step 3 now names the
  option first and prints both call shapes (compat's using Prisma's `take`, not
  Turbine's `limit`), states which release the compat passthrough needs, and asks
  for the same `pg_prepared_statements` confirmation rather than assuming the
  option took effect. Step 4 now names the database-wide `plan_cache_mode`
  mechanism and both ways of reaching it.

- **The core-client snippet doctor prints named an accessor that does not
  exist.** It printed `db.<raw table name>`, so on any snake_case schema the
  suggested code was `db.user_session.findMany(...)`, which is `undefined`.
  Both `TurbineClient` and the code generator define table accessors through
  `snakeToCamel`, and the snippet now does too.

- **`src/cli/index.ts` contained four literal NUL bytes**, from a map key written
  as a raw `0x00` byte rather than a `\u0000` escape. Behaviour was correct, but
  `grep` classified the largest file in the CLI as binary and skipped it, and
  neither lint nor typecheck noticed.

### Added

- **`turbine doctor` scores unindexed filter columns for cached-plan divergence,
  a THIRD mechanism.** Until now the check dropped every column with no index on
  the filter column before it even counted it as considered, so that population
  was outside the findings and outside the "not scored" notices alike. It is a
  distinct mechanism from the two already discussed: not the sparse-value
  direction the existing rule models, and not the dense-clustering direction that
  was written, measured and removed in 0.56.0 for predicting the wrong sign. Here
  **the good plan is a sequential scan that the generic plan will not choose**.
  With no index on the filter column the custom planner takes a seq scan plus a
  top-N sort, bounded by the table's pages; a promoted generic plan cannot see
  the value is rare, keeps the ordered primary-key walk, and fetches nearly every
  tuple before it fills the `LIMIT`.

  Fixture, printed so every number below is checkable (PostgreSQL 16, warm cache,
  `synchronize_seqscans`, `max_parallel_workers_per_gather` and `jit` off):

  ```sql
  CREATE TABLE t (id int PRIMARY KEY, organization_id int NOT NULL, payload text NOT NULL);
  INSERT INTO t SELECT g, <bucket(g)>, repeat('p', 60)
    FROM generate_series(1, 20000) g ORDER BY (g * 2654435761::bigint) % 1000003;
  -- 247 relpages, buckets 10,000 / 6,000 / 3,998 / 2
  -- read: WHERE organization_id = $1 ORDER BY id LIMIT $2, rarest value, limit 20
  ```

  `force_custom_plan` reads 250 buffers (Seq Scan), `force_generic_plan` reads
  20,074 (Index Scan on the primary key), and under `auto` seven executions of
  the rare value report `generic_plans 2, custom_plans 5`, so the promotion is
  real and not hypothetical. The branch's gates are its own: the rarest value
  must hold fewer rows than the assumed limit, and the promoted plan must walk at
  least 10,000 tuples. It carries no generic-side gate, for a measured reason
  recorded in the source.

  A finding on an unindexed column has a different first remedy, so the report
  renders it as **evidence attached to the missing-index finding** the same run
  already produced, never as a second entry, and it never suggests
  `forceCustomPlan` there. The leftover case, a column served only by a partial
  or expression index, keeps its own entry.

- **Findings carry the ordering column's correlation, and disclose the known
  false positive.** The size of an unindexed-filter flip is decided by how
  closely the heap tracks the column the generic plan walks, not by the filter
  column's own correlation. Six fixtures identical except for INSERT ordering,
  custom plan 250 buffers in all of them:

  | heap order | `pg_stats.correlation` on `id` | generic buffers | ratio |
  | --- | --- | --- | --- |
  | exact `id` order | 1.00000 | 303 | 1.2x |
  | shuffled within ~1 page | 0.99998 | 783 | 3.1x |
  | shuffled within ~2 pages | 0.99993 | 10,303 | 41x |
  | shuffled within ~4 pages | 0.99974 | 15,148 | 61x |
  | shuffled within ~20 pages | 0.99372 | 19,046 | 76x |
  | hash order | -0.00065 | 20,074 | 80x |

  The plan flips in all six; only the magnitude differs, and an append-only table
  with a serial primary key sits on the top row. `PlanDivergenceFinding` now
  carries `orderColumnCorrelation` and a `heapNearlyOrdered` boolean, both in the
  human report and in `doctor --json`, and the rendered text states the
  condition alongside the ratio instead of printing one number for both cases.
  Nothing is suppressed on it: the boundary sits between two adjacent sampled
  values, so it qualifies a finding and never decides one.

- **A column served only by a `brin` / `gin` / `gist` index is reported as not
  scored**, with the reason, rather than being described by a model that does not
  fit it. A **hash** index now counts as an equality path and routes the column
  to the sparse-value rule: measured, a hash index gives the custom plan a
  7-buffer Bitmap Heap Scan, so calling that column unindexed printed a 247-page
  seq scan as the good plan.

- `doctor --json` gained `planDivergenceScored` (`considered` / `indexed` /
  `unindexed`), so a consumer can tell "considered and clean" from "never looked
  at", and the divergence section of the human report prints the same split.

### Changed

- **`limit` on `updateMany` / `deleteMany` through prisma-compat now throws
  `UnsupportedFeatureError` (`TURBINE_E017`).** It was previously accepted and
  ignored, which silently dropped a safety bound on a mass mutation. This is the
  one place the release throws rather than warns, deliberately.
- **`relationLoadStrategy: 'query'` through prisma-compat now maps to Turbine's
  `'batched'`.** It used to be forwarded verbatim into a resolver with no
  `'query'` branch, so a caller asking for the per-relation plan silently got the
  join. Statement counts change for anyone who passed it.
- **`skipGlobalFilters` through prisma-compat goes from silently ignored to
  honoured.** That is the correct behaviour and matches the core client, but it
  is a real behaviour change on upgrade for a compat app that had the key present
  and inert.
- **Plan-divergence findings are sorted by estimated extra buffer accesses**
  rather than by `approxAmplification`, so existing sparse-value findings can
  change order. Both branches now report in the same units; that is not the same
  as equal conservatism, and the source says so.
- **`PlanDivergenceFinding.crossoverRows`, `crossoverRowsWide`,
  `valuesBelowCrossover`, `walkPages`, `walkFraction` and `approxAmplification`
  are now optional** and are absent on an `unindexed-filter` finding rather than
  zero-filled. A `--json` consumer reading them unconditionally must branch on
  `branch`.
- Several calibration numbers in the plan-divergence source were re-measured and
  corrected, including a page ladder that was about 8% high and a claim that one
  page of local heap disorder already costs 25x (measured 3.1x; the transition is
  between a one-page and a two-page window, because an index scan holds its heap
  pin).

### Known limits

- The divergence check's population is still relation-probe columns and leading
  index columns. A filter column that is neither an FK nor indexed is invisible
  to it in either branch, and feeding the index advisor's recommendations in does
  not change that: both derive from the same relation topology.
- The unindexed-filter branch's first gate is a constant (rarest bucket below the
  assumed limit), so it declines divergences whose absolute damage is larger than
  the ones it reports. Measured on the same fixture shape at 200,000 rows with a
  rarest bucket of 60: 2,473 buffers custom against 200,547 generic, an 81x flip
  and 198,074 extra buffer accesses, declined. Deriving the boundary from pages,
  rows and the cost constants is the honest fix and has not been done.

## 0.56.0 (2026-07-27)

### Added

- **`forceCustomPlan`, a per-query lever for the generic-plan cliff.** 0.55.0
  added the client-level `planCacheMode`, which is a connection parameter and
  therefore cannot say "custom here, `auto` there". `forceCustomPlan?: boolean`
  now sits on `FindManyArgs`, `FindUniqueArgs`, `CountArgs`, `AggregateArgs` and
  `GroupByArgs` (so `findMany` / `findUnique` / `findFirst` / the `OrThrow`
  forms / `count` / `aggregate` / `groupBy`, the streaming read, and the batched
  strategy's relation follow-ups):

  ```ts
  db.orders.findMany({
    where: { tenantId },
    orderBy: { id: 'asc' },
    limit: 20,
    forceCustomPlan: true,
  });
  ```

  `true` sends that one statement UNNAMED. State the mechanism carefully,
  because the tempting one-liner is wrong: PostgreSQL does NOT treat an unnamed
  statement as a one-shot plan that never enters the plan cache. It builds and
  saves a `CachedPlanSource` for it too. The option works one level up, in the
  driver: node-postgres only skips `Parse` for a statement it has already parsed
  BY NAME, so an unnamed statement is re-parsed on every execution, each `Parse`
  replaces the unnamed cached plan source with a fresh one whose custom-plan
  counter is zero, and the five-execution threshold that precedes promotion is
  never reached. No GUC, no `SET LOCAL`, no transaction, no extra round trip.

  Measured on the SQL Turbine itself emits (`LIMIT $n` included), 12 executions
  over one pooled connection: by default the statement is cached and promoted
  (`generic_plans = 7, custom_plans = 5`) and reads 26,802 buffers on a sparse
  tenant; with the option there is no entry in `pg_prepared_statements` at all
  and it reads 132.

  The fixture, so those two numbers can be checked rather than taken on trust
  (`synchronize_seqscans` and `max_parallel_workers_per_gather` off, as with
  every plan comparison here):

  ```sql
  CREATE TABLE t (id serial PRIMARY KEY, tenant_id int NOT NULL, pad text);
  -- 60 tenants over 200,000 rows, and the sparse tenant inserted LAST so its
  -- rows sit at the end of the heap: the ordered primary-key walk the generic
  -- plan chooses has to cross the whole table before it finds one.
  INSERT INTO t (tenant_id, pad)
    SELECT 2 + (g % 59), repeat('x', 180) FROM generate_series(1, 199900) g;
  INSERT INTO t (tenant_id, pad)
    SELECT 1, repeat('x', 180) FROM generate_series(1, 100) g;
  CREATE INDEX ON t (tenant_id);
  ANALYZE t;
  -- then, at LIMIT 100:
  --   SELECT * FROM t WHERE tenant_id = $1 ORDER BY id LIMIT $2
  ```

  Precedence, stated exactly because one of the four cases is the opposite of
  what the mechanism suggests. Client unset or `'auto'`: honoured, and this is
  what the option is for. Client `'force_custom_plan'`: redundant, harmless.
  Client `'force_generic_plan'`: **REFUSED**, `ValidationError` (E003) naming
  both settings. That was measured, not reasoned about: five executions of one
  unnamed statement read 19,107 buffers with that setting in force and 55 with
  the same connection set back to `auto`, so withholding the name buys nothing
  against it and accepting the flag would report a guarantee the next execution
  breaks. Omitted or `false` is byte-identical to 0.55.0 and does not opt out of
  a client-level setting. With `preparedStatements: false` every statement is
  already unnamed, so it is a no-op for plan choice. SQLite / MySQL / SQL Server
  / PowDB throw `UnsupportedFeatureError` (E017): an engine with no PostgreSQL
  plan cache cannot make this guarantee.

  There is deliberately no per-query `planCacheMode` three-value enum.
  `force_generic_plan` is a property of a CACHED plan and the only per-query
  lever is keeping a statement out of the cache, which can only ever mean
  custom, so an enum would promise a direction the mechanism cannot deliver.

  Not covered, and stated rather than left to be discovered: writes
  (`updateMany` / `deleteMany` can hit the same cliff) do not take it. It is a
  read arg.

- **`turbine doctor` detects the distribution that admits the flip.** A new
  finding-only section (skip with `--no-plan-divergence`; `planDivergence` and
  `planDivergenceNotices` in `--json`) scores every column doctor already knows
  about, relation probe columns and leading index columns, against `pg_stats`.

  The shape it models is narrow on purpose: `WHERE col = $1 ORDER BY <other
  indexed column> LIMIT $n`, where `rows / n_distinct` (what a generic plan
  assumes an equality matches) sits ABOVE the plan boundary while some real
  values sit far below it. The boundary is `sqrt(limit x relpages)`, where an
  ordered index scan's `limit / matching` share of the pages equals a bitmap
  scan's own; measured flip points track it. Each finding prints the statistics
  behind it and HOW MANY PAGES the wrong plan walks, plus a copy-pasteable
  diagnostic block whose FIRST step is
  `SELECT generic_plans, custom_plans FROM pg_prepared_statements`, because a
  finding describes exposure and not an incident: `auto` promotes only when the
  generic plan is not estimated to cost more than the average custom plan, and
  on many of these shapes it is, so nothing is ever promoted. The block ends by
  resetting `plan_cache_mode`, `synchronize_seqscans` and
  `max_parallel_workers_per_gather` so a paste does not leave a session pinned.

  It deliberately prints no amplification multiplier, and it deliberately does
  not model the opposite direction (a physically clustered dominant value). A
  rule for that direction was written and then REMOVED after measurement: on
  live fixtures it was wrong more often than right and twice it was wrong with
  the SIGN INVERTED, predicting "at least 16,032x" and "at least 2,675x" on
  columns where the generic plan was in fact 10x and 105x BETTER, so acting on
  it would have made those reads dramatically slower. The reason is structural
  rather than a bad constant: whether that flip helps or hurts turns on WHERE in
  the heap the dominant band sits, and `pg_stats.correlation` is identical
  whether it sits at the head or the tail. The same blind spot bounds what
  remains, so a clean report is stated as not being evidence of immunity.

  There is no `--fix`. The remedy is application code (`forceCustomPlan` on the
  affected reads), and the index that looks like a fix is measured not to be
  one: a composite index on `(col, order_col)` makes the GOOD plan better
  without stopping the generic plan from choosing the other one.

### Corrected

- **The 0.55.0 `ORDER BY` correction overcorrected.** 0.55.0 refuted "an
  `ORDER BY` is the necessary co-factor" with a 430x case that has no ordering
  and no limit, and that refutation stands. But it was published on its own, and
  read alone it says ordering does not matter, which misleads in the other
  direction. Both halves are true. In a table-by-table sweep of a multi-tenant
  schema, EVERY divergent shape measured was
  `WHERE tenant = $1 ORDER BY id ASC LIMIT $2`, and every shape without an
  ordering measured 1.00x. The mechanism is plain: an
  `ORDER BY` on a DIFFERENT indexed column hands the planner a second plan it
  can run away with, and a generic estimate on the wrong side of that boundary
  is what makes it take it. So: not necessary in general (do not conclude your
  unordered reads are safe), and still the strongest single predictor in
  practice, which is why the new `doctor` check models exactly that shape. The
  0.55.0 entry is left as published; this is the correction to it.

- **A custom plan is not automatically the better plan, with the fixture.**
  Nothing shipped previously said otherwise, but `planCacheMode:
  'force_custom_plan'` read as strictly safe, and it is not. Reproduced on
  PostgreSQL 16.14, `synchronize_seqscans` off, parallelism off:

  ```sql
  CREATE TABLE ev (id bigserial PRIMARY KEY, tenant_id int NOT NULL, pad text);
  -- head of the heap: 320,000 rows over 799 tenants in RANDOM physical order
  INSERT INTO ev (tenant_id, pad)
    SELECT t, repeat('x', 60)
    FROM (SELECT ((g % 800) + 1) AS t FROM generate_series(1, 320000) g
          ORDER BY random()) s
    WHERE t <> 400;
  -- tail of the heap: the dense tenant's 80,000 rows, inserted LAST
  INSERT INTO ev (tenant_id, pad)
    SELECT 400, repeat('x', 60) FROM generate_series(1, 80000) g;
  CREATE INDEX ev_tenant_idx ON ev (tenant_id);
  ANALYZE ev;   -- relpages 5334, n_distinct 800, correlation 0.004
  PREPARE q(int, int) AS SELECT * FROM ev WHERE tenant_id = $1 LIMIT $2;
  ```

  | `plan_cache_mode` | plan | buffers |
  |---|---|---|
  | `force_custom_plan` | Seq Scan | 4,262 |
  | `force_generic_plan` | Bitmap Heap Scan | 71 |

  60x, with no `ORDER BY` anywhere. The custom planner knows tenant 400 is 20%
  of the table, so with `LIMIT 20` it prices a sequential scan as nearly free on
  the assumption it stops almost immediately. It is right about HOW MANY rows
  match and wrong about WHERE they are: they are all at the end of the heap, so
  it reads 319,600 non-matching rows first. Re-insert the identical rows in
  random physical order and the effect vanishes and reverses (custom 2 buffers,
  generic in the seventies, the exact figure moving with the index leaf-page
  count on each rebuild): the variable is physical CLUSTERING, not selectivity.

  Read the comparison carefully, because the loose version of this claim is
  itself wrong. That is 60x against `force_generic_plan`, NOT against the
  default. On that fixture `plan_cache_mode = auto` never promotes (after nine
  executions `generic_plans = 0, custom_plans = 9`, because the generic plan's
  estimated cost 157 is far above the average custom cost 2.59 and `auto` only
  promotes when generic is not worse), and its plan is byte-identical to
  `force_custom_plan`'s. The honest claim is "there exists a shape where
  `force_generic_plan` is 60x better than both the default and a forced custom
  plan", not "forcing a custom plan is a 60x regression".

- **The parser-overwrite warning now fires under `NODE_ENV=production` too.**
  It was dev-only. `temporalInfinity`'s warning already fires in production
  deliberately, because production is where the destructive write commits, and
  the same argument applies here with more force: a parser overwrite is decided
  by which module calls `setTypeParser` LAST, and evaluation order is precisely
  what differs between a dev process and a bundled or lazily imported production
  one. A process can be clean in dev and wrong in production purely from import
  order, which made the case where it matters most the case where it was silent.
  Cost is bounded: once per OID per process, at client construction, only when a
  third party's non-default parser is actually being replaced. The message no
  longer claims to be dev-only and states why it fires.

### Fixed

- The `forceCustomPlan` integration suite took its `before` / `after` hooks from
  `node:test` directly while gating only its tests, so on a machine with no
  `DATABASE_URL` the setup hook still opened a pool with an undefined connection
  string and `npm run test:unit` exited non-zero. Hooks now come from the same
  gate as the tests, which is what the sibling suites already did.

## 0.55.0 (2026-07-27)

### Corrected

- **The 0.54.0 note about `planCacheMode` and `findMany` was false, and it told
  readers they were safe when they were not.** It said, in the changelog, in the
  README, on the docs site and in the `planCacheMode` JSDoc that ships in the
  published `.d.ts`: "`findMany` / `findFirst` bind `LIMIT $n`, and a
  parameterized limit denies the planner the limit fraction that makes a skewed
  plan look cheap, so those are much less exposed." PostgreSQL denies nothing.
  For an unknown `LIMIT` it SUBSTITUTES a default fraction, 10% of the child
  node's own row estimate, and that is not protection, it is a different wrong
  number, wrong in BOTH directions: too generous when the real limit is under
  10% of the matching rows, too stingy when it is over. Anyone who read the old
  text and concluded a paginated `findMany` did not need looking at was misled.

  What is actually true. Everything below is a number reproduced on
  PostgreSQL 16 on two fixtures small enough to rebuild, both stated so you can
  check them rather than take them on trust. `synchronize_seqscans` off and
  `max_parallel_workers_per_gather = 0` throughout (the first of those matters:
  it is on by default and makes a repeated seq scan resume where the last one
  stopped, which reported one 8,000-buffer scan below as 4 buffers until it was
  turned off).

  FIXTURE 1, the substituted defaults. 400,000 rows, `k = id % 104` so
  `n_distinct` is exactly 104, a btree on `k`, under `force_generic_plan`:

  | statement | generic estimate | rule |
  |---|---|---|
  | `WHERE k = $1` | 3846 rows | `rows / n_distinct` = 400000/104 |
  | `WHERE k > $1` | 133333 rows | 1/3 of the table |
  | `WHERE t LIKE $1` | 2000 rows | 0.5% of the table |
  | `WHERE k = $1 LIMIT $2` | `Limit` 385 rows | 10% of the 3846-row child |
  | `WHERE id = $1 LIMIT $2` | `Limit` 1 row | the 10% fraction clamps at 1 row |

  Two conditions on that 10% that are easy to miss, and the second one is the
  one Turbine walks into. It clamps at one row, so it is not always an
  overestimate. And an unknown `OFFSET` triggers the same substitution ON ITS
  OWN, even when the limit is a constant: `LIMIT 20 OFFSET $2` estimated 20 rows
  correctly but costed a 385-row prefix as its startup, and picked a DIFFERENT
  plan shape from the same query with no offset. Turbine binds both
  (`... LIMIT $2 OFFSET $3`), so a paginated read has
  no constant-limit escape. And note the direction: in that fixture the
  constant-limit form is the one that chose a seq scan, so "make the limit a
  literal" is not a fix either.

  FIXTURE 2, what actually goes wrong, and when. Two 200,000-row tables joined
  on an indexed key, with a skewed predicate (`k2` matches 190,000 rows for one
  value and one row for the rest; `n_distinct` sampled at roughly 1,600, which
  is an ANALYZE estimate and varies on rebuild), for the statement
  `SELECT count(*) FROM j JOIN jc ON jc.j_id = j.id WHERE j.k2 = $1`. NO LIMIT,
  no `OFFSET`, no `ORDER BY` anywhere in it:

  - custom plan: hash join, **1,770 shared buffers**
  - generic plan: nested loop (the ~1,600-way estimate makes 190,000 inner
    lookups look cheap), **761,002 shared buffers**, a 430x difference
  - and it PROMOTES under the default `plan_cache_mode = auto`:
    `pg_prepared_statements` reports `generic_plans = 2, custom_plans = 5` after
    seven executions

  That is the correction that matters most, because it inverts the ranking the
  0.54 text gave. The shape that bites you unprompted is the one with NO limit
  at all, because `auto` promotes only when the generic plan's ESTIMATED cost is
  not worse than the average custom cost, and this generic plan underestimates
  itself. A `LIMIT $n` frequently makes the generic plan look MORE expensive
  rather than less (its substituted row count is larger than the real one), and
  the limited statement in the same session was never promoted at all:
  `generic_plans = 0, custom_plans = 8` across eight executions.

  So the honest reading of `findMany` against `count()` is neither the 0.54
  claim nor its mirror image. A limited `findMany` gives the planner two things
  it cannot see instead of one (the predicate value and the limit count) and
  either alone can flip the plan shape, but MORE unknowns is not the same as
  more damage: the extra unknown often keeps the statement on custom plans.
  Measured, both `count()` and an UNLIMITED `findMany` compile to the pure
  parameterized-predicate shape that promotes on its own, and that is the shape
  to look at first.

  A note on the shapes we cannot show you. Earlier drafts of this entry carried
  further figures (a 2040x seq-scan case, an 858x correlated-column case, an
  early-termination cliff) whose fixtures were not written down and which did
  not reproduce on rebuild. They are gone rather than restated: publishing an
  unfalsifiable number in the entry that exists to correct one would be the same
  mistake. What survives from them is the qualitative point, which does hold on
  fixture 2 above: neither an `ORDER BY` nor any limit is required for a
  generic plan to be catastrophically worse than a custom one.

  Two corrections to the correction, so it is not overstated in the other
  direction:

  - **The sixth execution is a ceiling, not a trigger.** `auto` does not promote
    unconditionally on execution six; it promotes when the generic plan's
    estimated cost is not worse than the average custom cost, which for many
    statements is never. The README and the `planCacheMode` JSDoc said "promotes
    on its sixth execution" flatly, and now say this.
  - **`implicitPkOrdering` is OFF by default in core.** An earlier draft of this
    entry described it as a default Turbine supplies, which is wrong: a default
    `findMany({ where, limit })` emits `SELECT ... WHERE ... LIMIT $2` with no
    `ORDER BY` at all. The option is opt-in (`turbine-orm/prisma-compat`
    defaults it on, core does not), and turning it ON adds an ordering a generic
    plan can walk the whole table in. Nothing about the option changes here.

  The short rule: a plan-cached statement with any parameter can diverge; no
  shape of limit, bound or constant, protects you; and the promotion decision
  turns on the generic plan's own estimate, not on your query's shape. Measure
  with `plan_cache_mode = force_generic_plan` versus `force_custom_plan`, and
  check `pg_prepared_statements.generic_plans` to see whether a statement is
  actually being promoted under the default.

  Nothing about `planCacheMode` itself changes in this release. It still does
  what it did; the guidance around it was wrong.

- **The 0.54.0 `infinity` note overclaimed its own coverage.** It said the fix
  landed "on top-level, join relations and batched relations alike". It did not
  reach the join strategy: `json_build_object` renders an infinite timestamp as
  the string `"infinity"`, which no driver parser sees, so the join and
  positional paths kept returning an Invalid Date while the batched path
  returned a number, for the same row of the same query. Fixed below.

### Breaking

- **`infinity` / `-infinity` in a temporal column now read as the JS numbers
  `Infinity` / `-Infinity` on EVERY read strategy.** 0.54.0 stopped them
  becoming an Invalid Date on some paths and not others: the driver hands back a
  number, but `json_build_object` renders the same value as the string
  `"infinity"`, which no driver parser sees, so the join and positional
  strategies kept returning an Invalid Date while the batched and top-level
  paths returned a number, for the same row of the same query. Both forms are
  now normalized in ONE place, the ORM row parser, so the same stored value
  cannot read differently depending on which plan the query took.

  That normalization is what changes on upgrade. If you read infinity-bearing
  rows through a `with` clause (the join strategy, or the positional wire
  encoding), you were getting an Invalid Date and you now get the number.
  Everywhere else the value is what 0.54.0 already gave you.

  Applied in ONE place, so top-level reads, `findUnique` / `findFirst`,
  streaming, the join / batched / flatten strategies, the positional encoding,
  write `RETURNING` / reselect / `OUTPUT` projections and `groupBy` keys all take
  the same reading. `_min` / `_max` are mapped at their own assembly sites for
  the same reason (they hand back a stored cell, so they can carry the value;
  `_count` / `_sum` / `_avg` cannot). Array elements map too, so a `timestamp[]`
  reads `[Infinity, -Infinity]` rather than two Invalid Dates. Nothing is
  registered with `pg.types.setTypeParser` for this: the driver parsers are
  untouched, so raw SQL, `client.sql` and other libraries on the same `pg` keep
  the driver's value.

  **Why the number and not `null`.** `null` is the nicer-looking reading, and it
  was the one this release originally shipped with. It is also lossy, which a
  default may not be. Measured on PostgreSQL 16, on a nullable `timestamp`
  column holding `infinity`, with `valid_until::text` read back through a raw
  `pg` client:

  ```ts
  const row = await db.leases.findUnique({ where: { id } });
  await db.leases.update({ where: { id }, data: { ...row, note } });
  // reading the number: valid_until::text is still "infinity"
  // reading null:       valid_until::text is NULL, and nothing said so
  ```

  Under a `null` reading a stored `infinity` and a stored NULL are
  indistinguishable, so that write, the single commonest write shape there is,
  destroys the value with no error. The complaint the `null` reading answered is
  a real one, that `JSON.stringify` renders the number as `null` while the
  declared type says `Date`, but a lossy default is the wrong price for a
  cleaner JSON encoding. On a NOT NULL column the same write would at least fail
  loudly with `NotNullViolationError` (E010); on the nullable columns where
  `expires_at` / `valid_until` actually live, it is silent.

  **What the default costs you, stated plainly.** The generated types declare
  the field `Date`, and it hands back a `number`, so on exactly the rows holding
  an infinity:

  - `row.validUntil.toISOString()` and `.getTime()` throw a `TypeError`. Guard
    with `typeof row.validUntil === 'number'` (or `Number.isFinite`) before
    calling a `Date` method on a column that can hold one.
  - `JSON.stringify` still renders the value `null`, because JSON has no
    infinity literal. The API response is unchanged from 0.54.0 and from the
    Invalid Date before it.
  - `where: { col: null }` still compiles to `IS NULL` and does NOT match these
    rows. Filter them with `where: { col: 'infinity' }`. Compiling `null` to
    also match `infinity` would silently change every null predicate on every
    temporal column, which is far worse.

  **A one-time warning, and it is not dev-only.** When `temporalInfinity` is
  left unset and a stored infinity is actually read, Turbine says so once per
  process per field, naming the table and column, describing the reading and
  both escapes. Unlike every other Turbine warning it is NOT silenced by
  `NODE_ENV=production`, because production is where a `Date` method throws on
  live traffic and where a destructive write under the opt-in would commit. It
  costs one `console.warn` per field, and only on a row that actually held an
  infinity. Naming either reading in the config silences it: the warning exists
  to surface an unacknowledged trade, not to nag.

  Cross-engine: Postgres is the only engine that can produce an infinite
  temporal value (SQLite has none, MySQL and SQL Server have bounded datetime
  domains, PowDB stores micros). The row parser is engine-shared and is not
  dialect-gated, so the one visible effect elsewhere is that a stray
  `'infinity'` string on a date-typed column reads as the number instead of an
  Invalid Date.

### Added

- **`temporalInfinity` client option** (`'preserve' | 'null'`, exported as
  `TemporalInfinityReading`). `'preserve'` is the default described above and
  naming it explicitly silences the warning. `'null'` opts into reading a stored
  infinity as `null` instead: `JSON.stringify` is then honest about what the
  value became, the declared `Date | null` type holds so no method call throws,
  and `groupBy` / `distinct` / `_min` / `_max` take the same reading as the rows.
  Its cost is the data loss above, and three consequences worth spelling out
  before you choose it:

  - **`groupBy` keys stop being unique.** `GROUP BY` returns one row per
    distinct stored value and the ORM then relabels `infinity`, `-infinity` and
    SQL NULL all as `null`, so three rows holding those three values come back
    as three groups keyed `null`. Anything building a `Map` or
    `Object.fromEntries` off the group value keeps one of the three counts.
    `distinct: ['col']` has the same shape.
  - **`+infinity` and `-infinity` collapse into each other**, not just into
    NULL. On a `valid_until` column that puts "never expires" and "expired
    forever" in the same bucket.
  - **`_max` can return `null` on a table that plainly has rows.** With
    `2026-01-01`, `2026-06-01` and `infinity` stored, `aggregate` reports
    `_min: 2026-01-01, _max: null, _count: 3`, and `_max: null` is the same
    value an empty table returns.

  Reach for `'null'` when the rows are read-only in your code path and the
  declared type contract matters more than the stored value; rows read under it
  must not be written back. Both readings are identical on every read strategy,
  every write projection, `groupBy` keys and `_min` / `_max`, and the write path
  is untouched by either, so `'infinity'` / `'-infinity'` / `Infinity` /
  `-Infinity` all remain bindable and a value read as `null` is still
  recoverable if you know what it held. Anything outside the two values throws
  `ValidationError` (E003) at construction.

- **A one-time dev warning when Turbine overwrites a pg type parser that
  somebody else already customized.** `pg.types.setTypeParser` is
  process-global, which was documented; what was not is that it is
  RETROACTIVE. There is one parser table and it is consulted per row at decode
  time, so registration changes how every `pg.Pool` in the process decodes that
  OID, INCLUDING POOLS THAT ALREADY EXIST AND ARE ALREADY QUERYING. Same pool,
  same query, only a Turbine client construction in between (TZ=Asia/Tokyo):
  `date` went from `2026-07-20T15:00:00.000Z` to `2026-07-21T00:00:00.000Z`.
  The failure that creates is order-dependent and invisible: a reporting job
  reading through its own pool returns different days depending on whether some
  unrelated module has constructed a Turbine client yet, and with lazy route
  imports that ordering is not stable between requests. Turbine now says so
  once per OID (1114, 1082, 1115, 1182 and int8's 20) when the parser it is
  about to replace is not the driver's default. Detection is BEHAVIOURAL, not
  by function identity: `pg-types` keeps its default table private, so the
  registered parser is run over a canonical wire value and compared with what
  the default produces for it. That catches every parser that behaves
  observably differently, and deliberately stays silent about one that is
  observably equivalent. Turbine's own parsers are tagged, so a second
  registration in the same process (a client plus `turbine studio`, an ESM plus
  CJS copy) never reports itself. Dev-only, silent under `NODE_ENV=production`.
  The process-global notes in the README, the `utcTimestamps` JSDoc and the
  docs site now say "including pools that already exist and are already
  querying" instead of leaving it to inference.

## 0.54.0 (2026-07-27)

### Breaking

- **Postgres `date` columns now read back at UTC midnight, not the process's
  local midnight.** A `date` is a calendar day with no time zone, but the pg
  driver's default parser builds the JS `Date` from the process's LOCAL zone,
  so the stored day `2026-07-21` came back as `2026-07-20T22:00:00Z` in
  `Europe/Berlin` and `2026-07-20T15:00:00Z` in `Asia/Tokyo`: the wrong calendar
  day everywhere east of UTC. West of UTC the calendar day happened to be right,
  which is why this survived so long. The write side already rendered a bound
  `Date` from its UTC components, so the two halves disagreed, and east of UTC
  every read-modify-write cycle on a `date` column moved the STORED day one day
  earlier and kept going. Turbine now registers a UTC parser for OID 1082 under
  the existing `utcTimestamps` flag, alongside the `timestamp` (1114) parser it
  has always registered, and `infinity` / `-infinity` / BC dates / five-digit
  years keep the driver's own values.

  What changes for you: the calendar day is unchanged in a UTC-rendered form,
  but the EPOCH VALUE moves by your process's UTC offset. `getTime()`,
  `toISOString()` and `JSON.stringify(row)` change, so API payloads, exports and
  golden-file tests containing a `date` column change text. Code that reads
  LOCAL components off a `date` (`toLocaleDateString()`, `date-fns`/`dayjs`
  `format('yyyy-MM-dd')`) was correct by accident west of UTC and now reads the
  previous evening: format in UTC instead (`toISOString().slice(0, 10)`).
  Nothing stored in the database changes, no emitted SQL changes, and a process
  running in UTC is byte-identical. Opt out with `utcTimestamps: false`, which
  also reverts the write half.

  Scope: `pg.types.setTypeParser` is process-global, so constructing a
  TurbineClient on a Turbine-owned pool changes `date`, `date[]` and
  `timestamp[]` parsing for EVERY consumer of the same `pg` module in that
  process, including a second ORM, a query builder, or your own hand-written
  `pool.query` reporting code. That was already true of `timestamp` (OID 1114)
  and `int8`; this release widens the set to OIDs 1114, 1082, 1115 and 1182.
  Clients on an EXTERNAL pool never TRIGGER registration and a process
  containing only external-pool clients is untouched, but they read through the
  parsers an owned client installed, so they are not exempt from the effect. For
  that reason the `utcTimestamps` agreement check (which refuses a second client
  asking for the opposite value) now covers external-pool clients too: an
  external-pool client with `utcTimestamps: false` next to an owned client
  reading UTC would write local `date` literals and read UTC ones, which is the
  read-modify-write drift described above. That pairing now throws
  `ValidationError` (E003) at construction instead of corrupting stored days.

  Cross-engine, this REMOVES a divergence rather than creating one: SQLite,
  MySQL, SQL Server and PowDB already returned UTC midnight for a `date`
  column. Postgres was the outlier.

- **`date[]` and `timestamp[]` now agree with their scalar forms.** Postgres
  array OIDs do not inherit their element type's parser, so `timestamp[]` (OID
  1115) has been returning local-zone Dates ever since the scalar `timestamp`
  parser shipped, disagreeing with the `timestamp` column next to it in the same
  row. Both array OIDs (1115 and 1182) are now registered alongside their
  scalars, so scalar and array can no longer settle on different
  interpretations.

### Fixed

- **`infinity` / `-infinity` in a `timestamp` or `date` column no longer reads
  as an `Invalid Date`.** There were two independent bugs here, one behind the
  other, and fixing only the first would have changed nothing an ORM caller
  could see.

  At the driver level, the OID 1114 parser built its Date from the wire text
  directly, so `'infinity'` became `'infinityZ'` and then an `Invalid Date`. It
  now delegates every shape that is not a plain `YYYY-MM-DD HH:MM:SS[.ffffff]`
  to the driver's own parser, the way the new `date` parser already did, and
  keeps the driver's `Infinity` / `-Infinity`. Same for the new `timestamp[]`
  parser, which would otherwise have taken the defect to arrays as well. BC
  timestamps and five-digit years, which are not ISO-8601 parseable either, now
  come back as Dates rather than `Invalid Date`.

  Above it, `parseRow` re-coerced any non-`Date`, non-array value on a
  date-typed column, so it took the driver's number `Infinity` and ran
  `parseDbDate(String(Infinity))` = `parseDbDate('Infinity')`, reintroducing the
  Invalid Date on every scalar read path (top-level, join relations and batched
  relations alike). Arrays escaped only because they took an earlier branch,
  which is why the array form looked correct while every scalar read was not.
  Both halves are fixed, and the regression test asserts through `findMany`
  against a live database rather than through the parser, because a test at the
  parser seam passes while the ORM is still broken.

  > **The coverage claim above is wrong on two counts**, annotated rather than
  > rewritten. The join and positional strategies were NOT fixed (they see the
  > JSON string `"infinity"`, not the driver's number, and kept returning an
  > Invalid Date), and the reading this shipped, the number `Infinity` on a
  > field declared `Date`, was itself a defect. Both are addressed in 0.55.0,
  > where the value reads as `null`.

- **`turbine studio` renders zone-less `date` / `timestamp` cells the way the
  application reads them.** Studio builds its own raw pool and never constructs
  a `TurbineClient`, so it kept the driver's local-zone parsers: east of UTC a
  `date` cell displayed as the previous evening while the app reading the same
  row saw UTC midnight, and in `--write` mode that displayed value is what an
  edit echoes back into the column. It now registers the same UTC parsers, from
  one shared helper so the registrations cannot drift. `turbine mcp`, which also
  builds a raw pool and serializes sampled rows, gets the same treatment.

### Added

- **`PlanCacheMode` is exported from the package index**, so the option's type
  can be named directly instead of through
  `NonNullable<TurbineConfig['planCacheMode']>`.

- **`planCacheMode` client option** (`'auto' | 'force_custom_plan' |
  'force_generic_plan'`, Postgres only). PostgreSQL promotes a named prepared
  statement to a generic plan on its sixth execution, and a generic plan is
  costed blind to the bound values. A predicate whose selectivity varies wildly
  per value (the canonical case is a `tenant_id` equality on a shared table,
  where one value matches a handful of rows and another matches most of them) is
  then planned for the average value and never reverts, so a sparse tenant can
  be locked onto a plan chosen for a dense one. `planCacheMode:
  'force_custom_plan'` pins the backend's choice and removes that cliff.

  Which statements this reaches, measured rather than assumed: `count()` on such
  a predicate is promoted after five executions and is controlled by the option.
  `findMany` / `findFirst` bind `LIMIT $n`, and a parameterized limit denies the
  planner the limit fraction that makes a skewed plan look cheap, so those are
  much less exposed. Treat it as a targeted remedy for a statement measurably
  slower after its fifth execution, not a general speed-up.

  > **The two sentences about `LIMIT $n` above are FALSE.** Left in place
  > because released history is not rewritten, annotated because acting on them
  > leaves a real query unprotected. A bound limit does not deny the planner a
  > limit fraction, it substitutes a default of 10% of the child row estimate,
  > and an unknown `OFFSET` triggers the same substitution even when the limit
  > is a constant. Nor is the sixth execution a trigger: `auto` promotes only
  > when the generic plan's estimated cost is not worse than the average custom
  > cost. See the 0.55.0 entry for the measured rule and the fixtures.

  Applied as a connection parameter (`options=-c plan_cache_mode=...`) when the
  pool opens a connection, so it is in force for that connection's first
  statement and for every checkout, `$transaction`, stream and pipeline on it,
  and it cannot race the caller's first query. The default is `undefined`, in
  which case Turbine issues nothing and behaviour is byte-identical to before.
  The value is a closed enum validated at construction (a GUC value cannot be a
  bind parameter, so the enum check is the boundary); anything else throws
  `ValidationError` (E003). Engines whose dialect does not report the new
  `supportsPlanCacheMode` capability throw `UnsupportedFeatureError` (E017). On
  an externally supplied pool, where the caller owns connection lifecycle,
  it is a documented no-op with a dev-mode warning, the same ownership rule the
  type parsers follow; Turbine-owned string `replicas` on that same client are
  Turbine's own connections and do get it, which the warning says.

  Two limits worth knowing before you enable it. The capability flag can only
  speak for the dialect: a Postgres wire-compatible engine driven through the
  default dialect (CockroachDB, YugabyteDB, a pre-12 PostgreSQL) has no
  `plan_cache_mode`, and refuses the connection parameter itself with
  `unrecognized configuration parameter` rather than raising E017. And behind a
  connection pooler that filters startup parameters (PgBouncer's
  `ignore_startup_parameters`), set the GUC on the role instead
  (`ALTER ROLE ... SET plan_cache_mode = ...`). Where the option is unset,
  nothing is sent and nothing changes. An existing `PGOPTIONS` or a
  `?options=...` already on the connection string is preserved and appended to,
  never replaced.


## 0.53.0 (2026-07-27)

The release that finally finds the bug 0.50 and 0.52 both aimed at and missed.
Three consecutive releases fixed something real in the temporal write path, and
the reported symptom survived every one of them, because the defect was never in
the coercion itself. It was in which spelling of a key reaches it.

- **A write whose data key is spelled as the COLUMN name skipped every value
  coercion.** Turbine resolves a data key to a column in two places, and they
  did not agree. The SQL builder's `toColumn` accepts both the field name and
  the snake_case column name (it falls back to `camelToSnake` validated against
  the reverse map). The write-value coercion resolved the same key through
  `columnMap` alone, which maps field name to column name and knows nothing
  about the column spelling. So `{ last_run: date }` produced correct SQL with a
  completely uncoerced value, while `{ lastRun: date }` was correct. The
  temporal rewrite was the visible casualty (a zone-less column stored the
  process's local calendar fields), but the gap was total: array casts,
  JSON encoding, every per-column transform was skipped on that path. Both
  callers now share one `resolveColumnName` resolver, so the value a column
  receives no longer depends on how its key was spelled.
- **`findUnique` could return `null` for a row that `findFirst` finds.** The
  simple-where fast path pushed operands straight onto the params array while
  the general where walker routed them through `coerceWhereOperand`. On a
  zone-less `timestamp` / `date` / `time` column that is the same defect as
  above, on the read side: the same predicate against the same row found it one
  way and missed it the other, with no error. Both the build path and the
  cache-hit collector now coerce. The emitted SQL and the cache key are
  unchanged, so this is a value-only fix.
- **An unknown key in the client config was silently ignored.** `logParams`,
  `redactParams`, and every other near-miss did nothing at all, which reads as
  "the option is on and has no effect" rather than "the option does not exist".
  Unknown keys now warn once per key name (outside production) with a suggested
  correction, including the subsequence case that plain edit distance misses
  (`logParams` suggests `logQueryParams`).

### Added

- **Scalar `having` filters, and `AND` / `OR` / `NOT` inside `having`.** A
  `groupBy` field entry previously accepted only an aggregate filter
  (`{ _sum: { gt: 100 } }`). It now also accepts a filter on the grouped value
  itself (`{ categoryId: { not: null } }`, `{ status: { in: ['a', 'b'] } }`, or a
  bare value as equality shorthand), matching Prisma, and both forms may appear
  in the same object, ANDed. A scalar filter is legal only on a column listed in
  `by`, since a non-grouped column cannot be referenced in `HAVING` at all;
  anything else throws `ValidationError` (E003) naming the column instead of
  emitting SQL the database will reject. `_min` / `_max` are no longer typed as
  numeric-only either, because they return a stored cell: `MIN(title) > 'm'` is
  as valid as `MIN(views) > 10`.
- **`$extends` on `prisma-compat`.** The client and model extension components,
  in both the object and `Prisma.defineExtension` callback forms, returning a
  new client rather than mutating the existing one. `result` and `query`
  components are refused AT `$extends` time with an explanation and the
  alternative, rather than being accepted and silently ignored at the first
  query.

### Changed

- **The relation-strategy and unbounded-read warnings state the mechanism, not
  just the condition.** Every one of them now follows the same shape: what
  triggered it, why that costs what it costs, the fix, and the escape hatch. The
  `auto` to-one demotion said only that no covering index was found, which reads
  as a bug report about a missing index when the decision is a cardinality
  trade that stands even on a unique index. The `_count` demotion did not say
  that an inline `_count` is a correlated subquery re-evaluated once per parent
  row. The unbounded-read warning said the query "will fetch every row" and left
  the memory cost implicit, which is the part that actually bites.

## 0.52.0 (2026-07-26)

A correctness release, and an unusually self-critical one. Two of its four
headline items are corrections to things this project shipped and documented
wrongly in 0.50, not defects found in someone else's code.

- **A `Date` could still be stored in the process's local time zone.** 0.50
  fixed the binding but resolved the column's database type from ONE of the two
  places metadata carries it. Metadata that fills the table-level
  `dialectTypes` / `pgTypes` maps but not the per-column entries resolved to
  nothing, the rewrite silently no-opped, and the driver stored local calendar
  fields. A turbine-only round trip HIDES this, because the read path shifts
  back by the same offset: the ORM reports the value you wrote while the column
  is off by hours to psql, to another ORM, or to a BI tool.
- **`utcTimestamps: false` never reached the write path at all.** The flag was
  declared optional on the builder context and never copied onto it, so both
  consumers evaluated `undefined !== false` and read that as opted IN. Setting
  it therefore produced the worst available combination: reads stopped pinning
  UTC while writes kept rewriting to it. It is honored now, which means anyone
  already setting it writes DIFFERENT TEXT after this upgrade.
- **The 0.50 note about the `auto` strategy and relation `_count` was wrong
  twice.** It asserted that a grouped `COUNT(*)` scans the child table once
  whether it runs inline or batched. An inline `_count` is not a grouped scan,
  it is a correlated `COUNT(*)` re-evaluated per parent row. And the change it
  announced as a fix was a regression: it pinned bounded queries to the plan
  that measures 12.9x slower at 30 parent rows and 1,093x slower at 10,000.
  Reverted, with the crossover measured rather than assumed.
- **On PowDB below 0.20, every comparison against a `datetime` column returned
  wrong rows.** A timestamp literal binds as an integer, and the engine compared
  type tags rather than values, so a filter matched every non-null row, an
  equality matched none, and the answer changed with the access path. The
  exposure is narrow (turbine's own DDL never emits `datetime`), but where it
  applied it was silent.

Around those: `create({ data: {} })` emitted invalid SQL, `createMany` silently
wrote NULL over a column default for any row whose shape differed from the
first, relation `_count` key order was a race between concurrent queries, and
three of the five engines could not set half the client config.

### Added

- **PowDB 0.20.0 support.** Two version-gated capabilities resolved from the
  live version probe: comparisons against a native `datetime` column, and the
  per-field `_count` form (`count(T { .col })`), which upstream changed from a
  row count to a non-null count. The `_count` gate applies only to a NULLABLE
  column, because on a NOT NULL column the row count IS the non-null count and
  those calls were always correct. Turbine also now compiles a `datetime`
  `in` / `notIn` into an equality chain (`(.ts = $1 or .ts = $2)`, and `!=`
  joined by `and` plus `is not null` for the negated form), because the upstream
  0.20 fix covered the binary operators but NOT the list forms: a raw `in` still
  matches nothing and a raw `not in` still matches everything. That is the exact
  shape relation filters and the batched loaders emit, so it would have been a
  silently empty or silently widened relation. PowQL spends one nesting level
  per chain term, so lists are capped at 32 values and the loaders chunk to the
  same width. The tested lexer ceiling moves to 0.20, verified byte-identical
  upstream rather than assumed.
- **`logQueryParams`** (client config). Query-event parameters are redacted by
  default, and the only previous way to see them was `errorMessages: 'verbose'`,
  which also un-redacts `NotFoundError` messages. So "parameters visible, error
  messages still safe" was unreachable. `logQueryParams` derives from
  `errorMessages` when unset, so the default and the old spelling both still
  work.
- **`scopedConnect` gets a threat model in the docs**, not just a bullet. With
  it off (the default), a handler that forwards a client-supplied id into a
  nested `connect` hands any caller a cross-tenant write primitive.
- **`create({ data: {} })` inserts a row of defaults** on every SQL engine
  (`DEFAULT VALUES` on PostgreSQL and SQLite, `() VALUES ()` on MySQL,
  `OUTPUT INSERTED.* DEFAULT VALUES` on SQL Server), through a new dialect hook.
  It previously emitted `INSERT INTO t () VALUES ()` and failed with 42601. A
  handler building its payload from optional fields produces `{}` on a
  legitimate request. The multi-row all-defaults form raises a typed E017 on
  SQLite and SQL Server, which cannot express it, rather than emitting SQL the
  engine rejects.

### Fixed

- **A column's database type is resolved from both places metadata carries it.**
  `col.dialectType ?? col.pgType ?? tableMeta.dialectTypes[name] ?? tableMeta.pgTypes[name]`.
  A column in `dateColumns` that still resolves to nothing now raises a
  once-per-table dev warning naming the columns, because that is the residual
  silent-wrong-write shape.
  **Migration:** if your metadata carries types only in the table-level maps
  (hand-written, converted, or produced by a tool rather than by
  `turbine generate`), your zone-less `date` / `timestamp` columns have been
  storing local calendar fields. Establish the boundary before shifting any
  history: upgrade, run in dev, confirm the new warning is silent, and only then
  decide which rows predate the fix.
- **`utcTimestamps: false` applies to writes and where-clause binds.**
  **Migration:** the flag is genuinely per client on the write side, but the
  read side is a pg type parser on OID 1114, which is process-global and settled
  by the first turbine-owned client. Those cannot be made symmetric without
  changing every non-ORM read on the same pg module. So a process that builds
  two turbine-owned clients with OPPOSITE values now raises `ValidationError`
  (E003) at construction rather than silently producing a client whose reads and
  writes disagree. Give every client in a process the same value, or isolate the
  odd one. Clients on an external pool register no parser and are exempt.
- **Relation `_count` key order is deterministic again.** The batched loader ran
  its per-relation follow-ups through `Promise.all` and assigned each key on
  completion, so insertion order was a race: the same query on the same data
  produced up to 9 distinct key orders across 12 runs. Anything deriving an
  ETag, a cache key, or a snapshot from `JSON.stringify` of the payload saw
  different bytes per request. Relation keys and `_count` entries are now seeded
  in the join plan's own order before any query runs, so the batched, auto, and
  join outputs are byte-identical. Note this is a different axis from
  `stableRelationOrder`, which governs row order INSIDE a relation array.
- **`createMany` silently wrote NULL over column defaults.** It derives its
  entire column list from the first row, so a field a later row omitted was
  written as NULL over that column's default, and a field only a later row named
  was dropped and never reached the database. Both directions now raise E003
  naming the row index and the differing columns. An explicit `undefined` counts
  as omitted, matching single-row `create`.
  **Migration:** nested writes and `prisma-compat` split mixed-shape arrays into
  contiguous same-shape runs automatically, so `posts: { create: [...] }` and a
  compat `createMany` keep working and now apply column defaults correctly
  (Prisma binds literal NULL where a default exists only in the database, so
  this is strictly better). A DIRECT `db.t.createMany` with mixed rows still
  refuses, because it must remain one statement for `pipeline()` and the
  `$transaction([...])` array form. Split the call, or name the field on every
  row.
- **Relation `_count` on an unindexed foreign key batches again, from two parent
  rows up.** Measured on a 200,000-row child table: batched wins 1.73x at 2
  parents, 12.9x at 30, 311x at 1,000, and 1,093x at 10,000.
  `EXPLAIN (ANALYZE, BUFFERS)` at 30 parents shows 50,013 buffers inline against
  1,727 batched, `loops=30` with `Rows Removed by Filter: 199980` each time. An
  INDEXED `_count` is untouched and stays inline at every size (inline wins
  1.30x to 2.06x), because the per-parent subquery collapses to an index-only
  scan. No knob: choosing batched wrongly costs one round trip once, choosing
  inline wrongly costs 31 seconds, and `relationLoadStrategy: 'join'` already
  forces the single statement.
- **The engine factories dropped half the client config.** SQLite, MySQL, and
  SQL Server built their client from a hardcoded key allowlist, so
  `errorMessages`, `globalFilters`, `scopedConnect`, `utcTimestamps`,
  `implicitPkOrdering`, the SQL-cache options, and the new `logQueryParams` were
  unreachable on those engines. Forwarding is now by exclusion, so the next
  option added to `TurbineConfig` works everywhere on the day it lands.
- **The `prisma-compat` transaction client had no raw SQL.** `$queryRaw`,
  `$queryRawUnsafe`, `$executeRaw`, and `$executeRawUnsafe` exist on the
  transaction surface now, bound to the transaction's own connection (proven by
  a raw read seeing an uncommitted delegate write), sharing one factory with the
  client-level surface so the two cannot drift.
- **The many-to-many junction accessor warned about itself.** An m2m pair is
  declared on both sides, so the second visit found the junction's own
  registration and reported a collision on an accessor that existed and worked.
  Genuine collisions still warn once.
- **PowDB nested-projection `datetime` children came back as raw micro-second
  strings.** Micros exceed safe-integer range so the engine renders them as JSON
  text, and the coercion handled only numbers. Nested projections are the
  default on engine 0.18 and above, so this was the default path.
- **Five tracked source files contained literal NUL bytes**, each a Map-key or
  join separator written as a raw character rather than an escape sequence
  (`src/powdb.ts`, `src/index-advisor.ts`, `src/query/compound-unique.ts`, and
  the Studio UI source and its generated module). `grep` and `file` classify
  such a file as binary, so a search over it returns nothing and looks like a
  clean miss rather than an error. The runtime values are unchanged; the bytes
  are now escapes. Present since 0.48 in the PowDB case and longer in the
  others.

### Changed

- **PowDB `createMany` requires every row to name the same fields**, matching
  the SQL engines. PowQL tuples each carry their own column list, so ragged rows
  were actually correct there; the alignment is for portability, so that moving
  a codebase from PowDB to Postgres does not meet a new hard error.
  **Migration:** split the call, or name the field on every row.
- **PowDB storage-integrity failures are `ConnectionError` (E004), not E003.**
  A corrupt page, corrupt catalog, or CRC mismatch is an open-time integrity
  failure whose only recovery is restoring from a backup, not a query defect.
  **Migration:** code catching E003 for storage failures stops matching.
- **PowDB `limit: 0` returns `[]`** (it previously returned one row through a
  projection fast path) and a negative `limit` or `offset` raises E003
  client-side rather than being ignored.
- **`TransactionClient.rawQuery` is `@internal`.** It is the seam
  `prisma-compat` detects by shape. It takes a prebuilt SQL string, so escaping
  is the caller's problem, which is exactly what `tx.raw`'s tagged template
  exists to prevent. It still exists and still typechecks, so nothing breaks; it
  is no longer advertised. Note that transaction-scoped raw SQL (`tx.raw` and
  `tx.rawQuery`) emits no `$on('query')` event and runs no middleware or timing.
- **`PrismaCompatTransactionClient` is now an intersection type** including the
  raw surface and the lowercased alias delegates (the aliases already existed at
  runtime; the type omitted them).
  **Migration:** type-level only. A hand-built transaction-client stub typed
  against the old shape needs the raw methods added.
- **The `prisma-compat` SQL-fragment marker is a module-private symbol** rather
  than a global-registry `Symbol.for`, so a fragment cannot be forged from
  elsewhere in the process. The check fails closed either way (an unrecognized
  fragment binds as a parameter rather than splicing), so this is hardening.

### Documentation

- **The relations page taught the wrong model of `_count`, and it caused a bug
  report.** It stated that a grouped `COUNT(*)` scans the child table once
  whether inline or batched. It does not: the inline form is a correlated
  subquery per parent row. A reader believed the page and filed a report
  repeating its reasoning back to us. The page now leads with the correlated
  shape, carries the measured crossover and the `EXPLAIN` numbers, and names the
  two remedies.
- **"Resolves in one SQL statement" is now scoped to
  `relationLoadStrategy: 'join'`** on the queries, quickstart, and agent-facing
  pages. It has been inaccurate under the `auto` default since 0.41, and the new
  `_count` threshold widens it further. The agent-facing page additionally tells
  agents not to assert on statement counts unless a strategy is pinned.
- **A PowDB benchmark inference was over-generalized.** Upstream re-measured its
  own numbers and an indexed point lookup published as 3.0x FASTER than SQLite
  is 7.9x slower. Our page correctly cited that, then used it to explain all
  three of our read rows, when upstream measured one workload and ours differ by
  harness, hardware, row count, and durability mode. The claim is scoped to
  `findUnique`; `findMany` and nested `with` are stated as un-isolated between
  engine drift and host noise, and the benchmark record file now agrees with the
  public page instead of contradicting it.
- The README's PII claim said enforcement is "in the SQL on every engine". PowDB
  is the exception: its `returning` takes no column list, so the strip is
  client-side after the values cross the wire. That distinction matters when the
  claim is a security property.

## 0.51.0 (2026-07-26)

A read-correctness release. Two things in it silently returned wrong data, and
both were found by porting a real application onto the library rather than by
reading the code:

- **An unrecognized JSON filter operator compiled to no predicate at all.**
  `{ path: ['title'], string_contains: 'x' }` (the Prisma spelling, which
  turbine did not have) returned every row of the table, and inside an `AND` it
  dropped that conjunct, so a tenant scope written that way widened to the whole
  table. The same typo on a scalar column had always thrown. Unknown keys are
  refused now. Reads only, mutations were never at risk.
- **Values read through a `with` relation could differ from the same values read
  at top level, on every engine except Postgres.** A nested relation is built as
  JSON, and a JSON number is an IEEE double: SQLite and MySQL and SQL Server all
  rounded 64-bit integers, MySQL flattened `DECIMAL` to a float, and binary
  columns came back as base64 text or failed the query outright. Postgres was
  fixed in 0.50; the other three are measured and fixed here, so a top-level
  read, the `join` strategy, and the batched loader now agree everywhere.

Around those: `update({ data: {} })` emitted invalid SQL rather than doing
nothing, `createMany` into a table with an array column failed outright,
`orderBy` through more than one relation hop was refused, and MySQL and SQL
Server introspection ran every query against a pool the `finally` had already
closed. `orderBy` and nested `select` / `omit` are key-checked at compile time
now, the same way `where` became in 0.50.

### Added

- **`stringContains` / `stringStartsWith` / `stringEndsWith` on JSON path
  filters**, with `mode: 'insensitive'`. These match against the text at a JSON
  path. They are deliberately not called `contains`, which on a JSON column
  already means `@>` containment. Prisma's `string_contains` has no equivalent
  spelling in turbine, and the new strictness error names these when it sees it.
- **`orderBy` through multiple to-one relation hops.**
  `orderBy: { model: { category: { name: 'asc' } } }` threw E003 before; only a
  single hop compiled. Each additional hop becomes an `INNER JOIN` inside the
  SAME correlated subquery, so an N-hop chain still costs one subquery with one
  `LIMIT 1` rather than N levels of nesting. Every hop must be to-one: a to-many
  hop is refused with a message pointing at `{ pick, by }` or `_count`, because
  it has no single value to order by and picking an arbitrary row silently is
  worse than an error. Each hop applies its target's global filter to the join
  condition, so ordering never keys off a soft-deleted or other-tenant row.
  Depth is capped like nested `with`.
- **`updatedAt: true` / `.updatedAt()`** sets a column to the current time on
  every update that does not name it (Prisma's `@updatedAt`). Opt-in per column
  and NEVER inferred from a column name, so an application already managing its
  own timestamp is untouched and an untagged schema emits byte-identical SQL.
  The timestamp is client-side, so it flows through the same UTC coercion as any
  other bound `Date`.
- **`scopedConnect`** (client config, off by default) refuses a nested `connect`
  / `connectOrCreate` that would re-parent a to-many child already owned by a
  different parent. `connect: { id: 42 }` takes row 42 unconditionally, so a
  handler forwarding a client-supplied id hands any caller a cross-tenant write
  primitive, closable only by a hand-rolled check at every call site. Unowned
  children and idempotent re-connects still succeed. hasMany and hasOne only: a
  `belongsTo` connect takes nothing from anyone, and an m2m connect adds a
  junction row rather than moving one.
- **`relationNames`**, a per-table rename map for DERIVED relation names, on the
  introspection config AND as a `turbine.config.ts` key threaded to every CLI
  introspect call site (nobody introspects by hand; a port runs
  `npx turbine generate`). A port from another ORM becomes a mechanical mapping
  instead of a hand edit at every call site. A typo, an unknown table, or a name
  that would shadow a column is a typed E003, not a silent no-op: ignoring it
  would break the very call sites it exists to fix, at runtime.
- **Relation names in the "unknown field" error.** The message listed only
  columns (`Known fields: id, name.`), so a user who guessed a relation name
  wrong concluded that relations are not valid in `where` at all. It now lists
  relations too, marks them as valid in `where` and `with`, and suggests the
  closest match, with containment ranked above edit distance because the real
  miss is a longer guess like `modelVersions` for a relation derived as
  `versions`. Naming a relation where a column is expected says so and shows the
  nested form.

### Fixed

- **An unrecognized JSON filter operator was silently dropped.** See the summary
  above. Unknown keys and a `path` with no comparison now raise E003, on the SQL
  builder and PowQL alike, and the check runs on the cache-hit param-collect
  path too so a warmed cache cannot skip it.
  **Migration:** a filter that was silently matching everything now throws. The
  common case is a Prisma spelling: `string_contains` becomes `stringContains`,
  `string_starts_with` becomes `stringStartsWith`, `string_ends_with` becomes
  `stringEndsWith`. The error names the replacement.
- **Values diverged between read paths on SQLite, MySQL, and SQL Server.**
  Measured, not assumed, per engine: SQLite `INTEGER` 9007199254740993 came back
  9007199254740992 through `join` and `BLOB` failed the query outright ("JSON
  cannot hold BLOB values"); MySQL rounded `BIGINT` the same way, returned
  `DECIMAL` `'1000.50'` as `1000.5`, and returned `VARBINARY` as the literal
  string `base64:type15:AQL/`; SQL Server rounded `BIGINT` and returned
  `VARBINARY` as base64 text. The Postgres fix does not port directly (it
  decodes via pg OIDs), so the cast/decode pair is now a dialect hook,
  `jsonWireRule`, and each engine states its own divergent set. Postgres keeps
  its exact behavior through it.
  **Migration:** if you read a bigint, decimal, or binary column through a
  `with` relation on one of those three engines, the values you get back change
  with this upgrade, to the correct ones. Code that worked around the old
  behavior (parsing `base64:type15:…`, re-fetching a bigint at top level) should
  be removed.
- **`update({ data: {} })` emitted invalid SQL.** It compiled to
  `UPDATE t SET WHERE …` and failed with Postgres 42601. Any handler building a
  payload from optional fields produces `{}` on a legitimate request. It is a
  no-op returning the current row now, matching Prisma. The empty-where guard
  and `NotFoundError` still apply, and `optimisticLock` still emits a real
  `UPDATE`. `updateMany` reports `count: 0` and issues no statement.
- **`createMany` into a table with an array column failed.** The PostgreSQL bulk
  path is a column-major `UNNEST` transpose, and `unnest` flattens, so N rows of
  `text[]` arrived as one flat `text[]` and failed with 42804. Those tables use
  the row-major `VALUES` form now; tables with no array column keep the
  byte-identical `UNNEST` form.
- **MySQL and SQL Server introspection queried a closed pool.** Both
  `introspectMysql` and `introspectMssql` did `return somePromise` inside a
  `try` / `finally` whose `finally` closed the pool, so the pool closed before
  the promise settled. MySQL introspection failed outright.
- **`warnOnUnlimited` fired on reads that can match at most one row.** It no
  longer warns when the `where` pins a full primary key or unique column set to
  literal values. Conservative: an operator object, a null, an `OR`, or a
  partial key all still warn. A warning that cries wolf on correct code teaches
  people to disable it.

### Changed

- **`orderBy` and nested `select` / `omit` are key-checked.** `where` became
  key-checked in 0.50.0, but these stayed open records, so
  `orderBy: { nmae: 'asc' }` and `with: { posts: { select: { titel: true } } }`
  compiled and failed at runtime with E003. All four (including nested
  `orderBy`) are now checked against the right entity: `orderBy` against the
  table's columns AND its relations, and each nested block against the RELATION
  TARGET rather than the parent. A clause built dynamically still assigns,
  because an index signature satisfies each optional target key, so computed
  `orderBy` is not broken. The types degrade to the open record when the entity
  or its relations are unknown (`db.table(name)`, or a client generated before
  the relation brand), matching how `TypedWithClause` already degrades.
  **Migration:** this is a compile-time break only, and every error it produces
  was a runtime E003 before. Fix the misspelling, or regenerate if your client
  predates the relation brand.
- **The deferred `build*` family now carries its `with` generic into the return
  type.** `buildFindMany` / `buildFindUnique` / `buildFindFirst` and their
  `OrThrow` variants took the generic and discarded it, so a `pipeline()` result
  lost its relations. They return `DeferredQuery<QueryResult<…>>` now, the same
  type their async counterparts do.
  **Migration:** a hand-written annotation on a `build*` result that omitted the
  relations may now be too narrow; remove the annotation and let it infer.
- **Every em-dash is gone from the tracked source, docs, and site**, 3,253 of
  them across 254 files. No behavioral content.

## 0.50.0 (2026-07-25)

A correctness release, and the widest one so far. Four things in it are worth
reading before you upgrade:

- **A nested `belongsTo` update could rewrite every row of the related table.**
  A `NULL` parent foreign key compiled to `refKey IS NULL`, which matches every
  related row with a null reference key, and the nested `data` was applied to
  all of them. This is the reason to upgrade.
- **A `Date` written to a `date` or `timestamp` column was stored with the
  process's local offset**, so outside UTC the stored value was wrong and a
  `timestamp` column did not round-trip. Fixing it changes stored values for
  affected users: see the BREAKING entry under Changed, which tells you how to
  check whether you are one.
- **Studio's PII predicate guard had three holes**, and its depth limit failed
  open, so a query could read a redacted column through a relation filter,
  through `cursor` / `distinct`, or by nesting past the cap.
- **Many-to-many nested writes exist.** `connect` / `disconnect` / `set` on an
  m2m relation, which before 0.49 reported success and wrote nothing at all, are
  implemented rather than merely refused: the oldest silent-write gap in the
  library.

Around those: an unvalidated pagination argument could turn a paginated read
into a full-table read on Postgres, and a misspelled update operator could write
JSON text into a scalar column. Both are hard errors now. Every behavior that
changes in a way an existing app can notice is listed under Changed with the
exact error and the concrete fix.

### Added

- **Many-to-many nested writes: `connect`, `disconnect` and `set`.** m2m has
  never had a nested-write implementation on any engine. Before 0.49 the write
  fell off the end of the relation dispatch, so
  `db.posts.update({ where: { id: 1 }, data: { tags: { connect: [{ id: 7 }] } } })`
  returned a row and reported success while writing no junction row at all; 0.49
  turned that silence into a `ValidationError`. It now writes the junction rows,
  in the same transaction as the parent write, on every engine (the shared
  nested-write engine backs the SQL dialects and PowDB alike). `connect` is
  idempotent, by the strongest means each engine offers: where the junction
  constrains the pair and the dialect supports it (PostgreSQL, SQLite, MySQL),
  the insert goes through `createMany({ skipDuplicates: true })`, so the engine
  itself dedupes and two concurrent transactions connecting the same pair cannot
  both insert. Where that is unavailable (SQL Server and PowDB refuse it, and an
  implicit junction need not declare the constraint it fires on), it falls back
  to reading the parent's existing links for exactly the named targets inside
  the transaction and inserting only the missing ones. Target selectors resolve
  in ONE query for the whole list rather than one query per target, and are
  compared by a normalized key, so a junction column that a table parser hands
  back as a string cannot fail to match the number the parent write returned and
  insert a duplicate. `disconnect` is scoped by BOTH the parent key and the named
  targets, so it can neither clear the parent's other links nor touch another
  parent's rows, and `set` replaces the whole set (`set: []` clears it). On
  `create` only `connect` applies
  (`disconnect` / `set` are update-only on every relation type) and the junction
  rows are written after the parent insert, since they carry its key. A target
  selector that matches no row is refused rather than skipped, a composite
  junction key is refused rather than partially written, and a junction whose
  `sourceKey` and `targetKey` name the SAME column is refused rather than
  writing a link row that cannot mean what it says.
- **Junction-table accessors on the `prisma-compat` client.** Prisma's schema has
  no model for an implicit junction, so `PRISMA_MAP` has no entry for one and the
  compat client exposed no accessor: the escape hatch the m2m error message
  recommended was unreachable, and following it literally meant a second
  transaction on the core client, breaking the atomicity the advice asked for.
  Every many-to-many junction table in the Turbine metadata now gets an identity
  delegate (same table, no renames, no relations), built from one shared list so
  the accessor exists both on the client and inside `$transaction`. The
  accessor is an escape hatch and never worth breaking a real member of the
  client for, so a colliding junction name is skipped rather than installed: a
  Prisma model name, a table some model maps to, a model's lowercased property
  alias (`compat.user` for `model User`), and the client's own `$transaction` /
  `$queryRaw` / `$connect` family all keep their key. Every skip that costs the
  caller a capability warns once in dev.
- **`implicitPkOrdering` (client config, default `false` in core).** A `findMany`
  that paginates with no `orderBy` is ordered by the table's primary key
  ascending (every column of a composite key, in declaration order). An explicit
  `orderBy` wins and a PK-less table is untouched. A `cursor` query is ordered on
  the CURSOR's own field rather than the primary key when the two differ: a seek
  on column X ordered by column Y walks the table in an order the seek does not
  follow, which is no better than no order at all. Two shapes are deliberately
  left alone: `distinct` (an added `orderBy` changes which representative row
  `DISTINCT ON` picks, so it would change results, not just their order) and a
  MULTI-field cursor, where `a > $1 AND b > $2` is a conjunction rather than a
  composite keyset seek and no single ordering makes it sound. Both still warn.
  Off by default in core because switching it on rewrites SQL that existing
  applications already emit. `turbine-orm/prisma-compat` applies the same
  ordering unconditionally, with no flag to set (see Changed).
- **A dev warning for an unordered paginated `findMany`.** An unordered `LIMIT`
  is not stable in Postgres: as the heap changes underneath it the same query can
  return different rows, so a row can appear on two pages or on none. The warning
  names the table, the pagination shape, and the exact `orderBy` to add, and
  fires once per table and shape. A `cursor` counts as pagination and is the
  worst case rather than an exception: `WHERE id > $1 LIMIT $2` with no `ORDER
  BY` is precisely this bug, and the warning names the cursor's field rather than
  the primary key when they differ. It is gated exactly like `warnOnUnlimited`
  (per-call, per-table, then the global flag), silent under
  `NODE_ENV=production`, and suppressed only when `implicitPkOrdering` will
  actually order the query, so a PK-less table and an ambiguous multi-field
  cursor still hear about it with the flag on.
- **`autoToOneJoinMaxRows` (client config, default 1000).** The parent-row
  ceiling for the `'auto'` strategy's new to-one rule (see Changed).
- **`turbine migrate-from-prisma` reads the connection string your
  `datasource` block declares**, including its `env("NAME")` indirection, so a
  project whose schema says `url = env("DATABASE_URL_STAGING")` needs no `--url`
  flag. Precedence is unchanged where it already existed and the datasource is
  last: `--url`, then `DATABASE_URL`, then `url` in `turbine.config.ts`, then the
  datasource (`url`, then `directUrl`). A literal `url = "postgres://..."` works
  too. When nothing yields a URL, the existing error gains a fourth suggestion
  naming the exact variable the schema asked for.
- **The migration report resolves your many-to-many call sites for you.** A
  migration audit that greps the Turbine relation names (`grep -rn "manyToMany"
  generated/`, then searching for the names it prints) cannot find anything:
  application code written against the compat client uses the PRISMA field names,
  and the two are related only through `PRISMA_MAP`. That is true of every compat
  integration, so the recipe reports a clean audit no matter how many m2m writes
  a codebase has. `prisma-migration-report.md` now has a **"Many-to-many
  relations (audit these call sites)"** section listing every m2m relation with
  BOTH its Prisma field name and its Turbine relation name plus the junction
  table, and a ready-to-run `grep` over the Prisma names. In `--no-db` mode it
  says the list needs a database run rather than printing an empty one.
- **`relationLoadStrategy: 'flatten'`, a fourth relation plan.** An eligible
  to-one relation compiles to a `LEFT JOIN` over a derived table inside the same
  statement instead of a correlated subquery: one round-trip, no per-parent
  re-evaluation of the subquery, and no client-side stitching. The whole to-one
  subtree collapses into a single derived table that exposes only prefixed
  column names (`f0__id`, `f1__code`, …), so a child column can never collide
  with a parent column of the same name, and the nested object is reassembled
  client-side to a result **deep-equal** to the join strategy: same shape, same
  camelCase keys, same `Date` coercion. The match discriminator each node
  carries is deliberately value-free, so a PII-tagged key column never reaches
  the wire, and the correlation columns the outer `ON` needs are never projected
  to the caller. It is an **explicit opt-in** at the client or on a single query;
  `'auto'` is unchanged and never selects it. Cache keys carry a plan
  signature, so every pre-existing cache key stays byte-identical.
  **Eligibility, which matters because an ineligible relation falls back
  silently rather than erroring:** `belongsTo` / `hasOne` only, where the
  target-side correlation columns are PROVABLY unique, meaning an exact set
  match against the target primary key, a declared unique constraint, or a full
  unique index that is neither partial nor an expression index. The proof is
  exact set equality, so a unique index on `(a, b)` does not prove `(a)`. The
  relation must also carry no `limit` and no `orderBy`, contain no nested
  `_count` (a top-level `_count` is fine and stays a correlated `COUNT(*)`), and
  sit under the same depth cap of 10 the subquery path uses. Inside an eligible
  relation these all work: a relation `where`, target global filters, `select` /
  `omit`, to-one chains to the depth cap, self-relations, and a nested to-many,
  which stays a correlated subquery hanging off the joined node. Fallback is per
  relation, so one ineligible relation does not stop the others. Four conditions
  disable flattening for the whole query instead: `distinct`, `jsonEncoding:
  'positional'`, SQL Server (which has its own `FOR JSON PATH` relation
  compiler), and `findUnique`, which never plans one. `findFirst` does, since it
  routes through `findMany`. Runs on PostgreSQL, MySQL and SQLite; PowDB has its
  own relation path and is unaffected.
  **Performance, stated exactly:** measured on 9,200 parent rows against local
  PostgreSQL, `'flatten'` runs **1.33x faster than `'join'`** on a shallow to-one
  and **1.56x** on a two-deep to-one chain, and **loses to `'batched'`, which is
  2.83x faster than `'join'`** on the same shape. That ordering is structural
  rather than a defect: with 2,000 distinct targets behind 9,200 parents the join
  transmits the target's columns 9,200 times while the batched loader transmits
  2,000 rows once, and the gap closes as cardinality approaches 1:1. Local
  round-trip time of about 0.1 ms also favors the batched loader's extra
  round-trip more than a real network would. So the claim for `'flatten'` is one
  round-trip, transaction-trivial, no client-side stitching, and strictly better
  than `'join'` on large to-one parent sets. It is **not** the fastest plan, and
  that is why it is deliberately not wired into `'auto'`.
- **`where` is key-checked at compile time.** On a generated, typed client an
  unknown key in a `where` clause is now a type error rather than a silently
  ignored one: `where: { emial: 'x' }` used to compile, match nothing in the
  emitted SQL, and hand back the whole table. The check follows the clause
  wherever it nests, including inside `AND` / `OR` / `NOT`, inside a relation
  filter at arbitrary depth, and inside a nested `with` block's own `where`. No
  generator change was needed and no regeneration is required: it threads the
  `RelationDescriptor` brand the code generator has emitted on `*Relations`
  interfaces since 0.7.1, so an existing generated client picks it up on
  upgrade. The change is purely type-level and the emitted SQL is byte-identical.
  It is still deliberately permissive in four places, listed so nobody reads a
  clean compile as full coverage: (1) a client with no relations map, meaning a
  `defineSchema`-only client or an untyped `client.table(name)` call site, keeps
  the historical open-keyed clause because there is no relation type to thread;
  (2) a legacy generated client whose `*Relations` members are bare types
  (`posts: Post[]`) rather than brands has its relation KEY checked but not its
  VALUE; (3) `orderBy` everywhere, and `select` / `omit` inside a `with` block,
  remain open-keyed, though top-level `select` / `omit` are checked; and (4) the
  deferred `build*` variants used by `pipeline()` take the entity type only, so
  their `where` stays open-keyed. Every awaitable method is checked: `findMany`,
  `findFirst`, `findFirstOrThrow`, `findUnique`, `findUniqueOrThrow`,
  `findManyStream`, `update`, `delete`, `upsert`, `count`, `updateMany`,
  `deleteMany`, `aggregate` and `groupBy`. Because the
  guarantee is type-level, a transpile-only runner such as `tsx` will not
  surface it; `tsc --noEmit` is the gate.

### Fixed

- **A JS `Date` written to a `time` / `timetz` column was rejected outright.**
  The driver serialized it as a full ISO timestamp with the process offset
  (`1970-01-01T04:00:00.000-05:00`), and Postgres answered `22007 invalid input
  syntax for type time`, so a Prisma `DateTime @db.Time(6)` field had no working
  write path and no compat-layer workaround. A `Date` bound to a time-of-day
  column is now narrowed to a time literal built from its **UTC** components
  (Prisma's choice, and the only one that round-trips regardless of where the
  process runs), with an explicit `+00:00` on `timetz` so the session's
  `TimeZone` cannot be attached instead, and fractional seconds only when
  non-zero. Applied on every write path (create, createMany, upsert, and the
  update `set` clause) including the cache-hit param path, and on `where` too:
  filtering a time column by a `Date` raised the same `22007`, so the column had
  no working read path either. `createMany` needed a second fix on top of the
  value narrowing: the per-column array cast had no entry for `time` / `timetz`,
  so the value list fell through to `text[]` and Postgres answered `42804 column
  "start_at" is of type time without time zone but expression is of type text`
  even though every literal in it was valid. The cast table now covers every
  Postgres type that has no assignment cast from `text` (time and interval
  types, the network / geometric / range / multirange families, `tsvector`,
  `citext`, `money`, `vector`); `varchar` / `char` keep their `text[]` cast,
  which is correct and already-emitted SQL. `time` and `timetz` are deliberately
  still not `dateColumns`: they have no date part and still read back as
  strings. Every other column type emits byte-identical SQL and params.
- **BREAKING: a `Date` written to a `date` or `timestamp` column was stored with
  the process's local offset.** The driver serializes a `Date` using the
  process's calendar fields, and a zone-less column keeps whatever fields it is
  handed, so the value stored depended on the `TZ` of the machine that wrote it.
  Writing `new Date('2026-07-25T00:00:00Z')` to a `timestamp` column from a
  process in `America/Los_Angeles` stored `2026-07-24 17:00:00`, and reading it
  back gave `2026-07-24T17:00:00Z`, because Turbine's read path parses an
  offset-less value as UTC (`utcTimestamps`, on by default). A `timestamp`
  column was therefore not round-trip stable anywhere but UTC, a `date` column
  could land on the wrong day, and two app instances in different zones wrote
  different values for the same instant. Writes now bind the `Date`'s UTC
  components, mirroring the read path exactly. `timestamptz` is untouched (it
  stores a real instant, and the driver's offset-carrying string is already
  correct for it), as is every non-temporal column. PostgreSQL only: MySQL and
  SQL Server bind these types through their own drivers, and MySQL reads a
  zone-less literal in the session time zone, where a UTC literal would be
  misread. See Changed for who is affected and how to check.
- **An empty `orderBy` emitted invalid SQL.** `orderBy: []` (and an object whose
  every value is `undefined`) compiled to a bare `ORDER BY` with nothing after
  it: `SELECT "posts".* FROM "posts" ORDER BY  LIMIT $1`, which Postgres rejects
  with `syntax error at or near "LIMIT"`. It carries no ordering, so it is now
  treated as absent, which is also what the implicit-ordering and unordered-page
  logic already assumed. This matters more than it did: "pass an explicit
  `orderBy`" is the documented way out of the implicit ordering above, and code
  that assembles that array conditionally ends up passing `[]`.
- **`prisma-compat` pagination returned non-deterministic pages.** Prisma
  appends an implicit `ORDER BY <primary key> ASC` to a paginated `findMany`;
  the compat layer emitted a bare `LIMIT`, so a ported paginated endpoint
  silently inherited pages that can repeat a row or skip one as the heap changes
  underneath the query, and took the slower unordered plan. Compat now matches
  Prisma (see Changed).
- **The `'auto'` relation strategy ignored cardinality.** It kept the
  single-statement join whenever the correlation columns were indexed, but an
  index says nothing about how many parent rows the correlated subquery will be
  re-evaluated for. A to-one include on a large parent set is exactly the case
  where the batched follow-up wins, and `'auto'` was picking the slower plan.
  See Changed for the new rule.
- **The `'auto'` strategy demoted relation `_count` for nothing.** A grouped
  `COUNT(*) ... GROUP BY fk` scans the child table once whether it runs inline or
  as a follow-up, so moving `_count` off the join plan because its FK is
  unindexed bought no scan and cost a round-trip. See Changed.
- **A nested `belongsTo` update could rewrite every row of the related table.**
  `processBelongsToUpdate` derived its `where` by reading the parent's foreign
  key and comparing the related table's reference key to it. When the parent FK
  was `NULL`, that compiled to `refKey IS NULL`, which matches every related row
  with a null reference key, and the nested `data` was applied to all of them.
  `db.posts.update({ where: { id: 1 }, data: { author: { update: { name: 'x' } } } })`
  on a post with no `authorId` renamed every author-less row it could reach. The
  operation now routes through the same correlation helper every sibling nested
  operation uses: a `NULL` parent FK points at nothing, so there is nothing in
  scope, and it throws `NotFoundError` (E001) naming the relation. A target that
  exists but belongs to a different parent reports the same error rather than
  being written. **This is the reason to upgrade.**
- **`limit` / `offset` are validated on every path.** An unvalidated bound was
  passed through `Number()`, so `NaN` bound as SQL `NULL`, and Postgres reads
  `LIMIT NULL` as *no limit at all*: forwarding an unvalidated
  `req.query.limit` silently turned a paginated endpoint into a full-table read,
  and a bad `offset` silently vanished. This was never MySQL-specific; the
  inlined-literal path (MySQL) already checked, the parameterized path
  (Postgres, SQLite, SQL Server) did not. A single `paginationValue()` helper now
  validates every call site: top-level `limit` / `offset`, per-relation `limit`,
  the SQL-build path and the cache-hit param-collect path (a warmed template
  could otherwise bind an unvalidated value with the build path never running).
  Anything that is not a non-negative safe integer throws `ValidationError`
  (E003) naming the argument and the table.
- **A misspelled atomic operator was written into the column as JSON text.**
  `data: { viewCount: { incremnt: 1 } }` did not match a known operator, fell
  through to the plain-value branch, and stored the string `{"incremnt":1}`.
  It now throws `ValidationError` (E003) naming the unknown key and listing the
  supported operators. See Changed for the exact scope of the check.
- **Studio's PII predicate guard had three holes.** Relation filters were walked
  as if the wrapper (`some` / `none` / `every` / `is` / `isNot`) were itself a
  clause, so a redacted column inside one was never inspected; `cursor` and
  `distinct` were not walked at all, though both name columns directly and both
  leak the hidden value (paging on it is an oracle just as filtering is); and
  the depth limit **failed open**, returning silently past depth 10 so a
  deeply-nested clause was simply not checked. The walker now handles relation
  wrappers and field-name lists, and the depth cap fails **closed**: past 32
  levels the query is refused with `ValidationError` (E003) rather than passed
  unverified.
- **`findManyStream` inside a caller transaction opened a second connection.**
  It checked a connection out of the pool unconditionally, so a stream started
  inside `$transaction` ran on a different connection and a different snapshot,
  outside the caller's transaction. Inside a transaction it now rides the
  caller's pinned connection, emits no transaction control of its own
  (`ambientTransaction`), and releases nothing, so the caller's transaction is
  intact when iteration ends. Outside a transaction the behavior is unchanged.
- **A read-only client's nested writes bypassed the read-only guard.**
  `runInImplicitTx` built its `TransactionClient` without passing the source
  pool, so the transaction-scoped proxy pool lost the pool's `readonly` flag and
  its PowDB capability set. A read-only PowDB client's nested write skipped the
  `ReadOnlyError` (E018) check, and an older-engine client fell back to the full
  capability set inside the implicit transaction and could emit PowQL the engine
  rejects. The pool is now threaded through.
- **A failed `BEGIN` no longer emits a stray `ROLLBACK`.** The implicit-transaction
  wrapper rolled back in its `catch` even when the `BEGIN` itself had thrown, so a
  connection that never opened a transaction received a `ROLLBACK`.
- **Prototype-chain lookups in metadata and operator maps.** Relation names,
  aggregate-function keys, vector metric names and Studio table names were read
  with a bare index, so a key such as `constructor` or `toString` resolved to an
  inherited builtin and its source text could be spliced into the emitted
  statement. Every one of those lookups now goes through an own-property helper
  (or a `Map`, in the PowQL builders).
- **MySQL string-literal escaping doubled the quote but not the backslash.**
  `escapeStringLiteral` inherited the Postgres rule, but unless MySQL runs with
  `NO_BACKSLASH_ESCAPES` a `\` escapes the following character, so a value ending
  in a backslash could escape its own closing quote. The backslash is now escaped
  first. The only caller is `buildJsonObject` (relation and column names from
  schema metadata), so this is defence in depth rather than a user-value path.
- **PowQL `having` interpolated the caller's aggregate key.** The function token
  was derived from the key by stripping its leading underscore and emitted
  verbatim into the PowQL text. It now comes from a fixed allowlist
  (`_sum` / `_avg` / `_min` / `_max` / `_count`); any other key throws
  `ValidationError` (E003) listing the supported set. The comparison operators
  moved to a `Map` for the same reason.
- **`redactUrl` could be defeated, and backtracked.** The pattern missed a
  password containing `/`, `:` or `@`, so `postgres://u:pa/ss@host/db` printed in
  full, and its nested quantifiers made it a ReDoS candidate on a long
  non-matching string. It is replaced by a linear scan that anchors on the scheme
  and consumes the whole userinfo section.
- **`vector(n)` dimensions are validated before they reach the DDL.**
  `vectorDimensions` is the one number interpolated into a type token and was
  trusted to be numeric. It must now be an integer between 1 and 16000
  (pgvector's cap) or `ValidationError` (E003) names the column.
- **The upsert conflict-UPDATE predicate no longer orphans parameters.** MySQL
  and SQL Server both reported the inherited `supportsUpsertUpdateWhere: true`
  while their `buildUpsertStatement` emitted no predicate: `ON DUPLICATE KEY
  UPDATE` has no predicate slot, and `MERGE`'s `WHEN MATCHED AND` cannot take the
  unqualified column references the builder supplies (they are ambiguous between
  the target and source aliases). With a global filter in play the builder
  compiled the predicate and bound its parameters, which the statement then had
  no placeholder for. Both now report `false`. SQLite genuinely supports it and
  now emits it.
- **CJS consumers no longer see TS1479.** The CommonJS build emitted no
  declarations, so a consumer on `moduleResolution: node16` / `nodenext` that
  resolved the `require` condition was pointed at the ESM declarations, which
  live in a `"type": "module"` package: `tsc` reported "the file is an ES module
  and cannot be require()d" even though the runtime `require` worked. `dist/cjs`
  now ships its own declarations beside its `{"type":"commonjs"}` package.json.
- **PowQL doc-field index DDL quotes the indexed column.** The json document
  column was spliced in bare. See Changed: this changes emitted bytes for a
  keyword-named column.
- **Studio's session cookie was matched mid-value**, so a cookie whose name
  merely *ended* in `turbine_studio_token` could supply the token. The pattern is
  anchored on a cookie boundary now.
- **Studio's rate limiter counted only authenticated sessions.** Unauthenticated
  requests were rejected before the limiter ran, so they were unlimited. The
  limiter now runs first, keyed per caller.
- **Legacy migration checksums are upgraded only when they actually match.**
  A stored pre-0.6 djb2 checksum was accepted on length alone, so any short
  stored value suppressed drift detection for that file. The legacy hash is now
  recomputed and compared before the record is upgraded, and `migrate status`
  uses the same rule as `migrate up`.

### Changed

- **`prisma-compat` reads now emit `ORDER BY <primary key> ASC`.**
  A compat `findMany` with `take` / `skip` and no `orderBy` is ordered by the
  model's primary key ascending, matching Prisma. So is every `findFirst` /
  `findFirstOrThrow`, which core compiles to a bare `LIMIT 1`: "give me any one
  row" quietly meant "give me whichever row the heap hands back today", and it
  is the most common nondeterministic shape in Prisma-shaped code.
  `findUnique` / `findUniqueOrThrow` are never ordered (at most one row matches,
  so it would be pure overhead) and `distinct` reads are never ordered either:
  an added `orderBy` moves core's `DISTINCT ON` into its two-level derived-table
  rewrite, whose outer `ORDER BY` sees only the projected columns, so a
  `distinct` + `select` + `take` read would fail with `column "id" does not
  exist`. Cursor reads ARE ordered here, unlike core: the ordering is applied
  strictly after the cursor translation, so the seek direction is still resolved
  from the caller's own `orderBy`, and Prisma pairs cursor pagination with the
  same implicit key. This changes the SQL existing compat call sites emit and
  therefore which rows a given page returns: the new pages are the deterministic
  ones, and the old ones could repeat or skip a row. There is no opt-out flag,
  because reproducing Prisma's semantics is this layer's contract. Migration:
  none to keep Prisma's behavior. To page in a different order, pass an explicit
  `orderBy`, which always wins. Core is unchanged and still emits a bare `LIMIT`
  unless you set `implicitPkOrdering: true`.
- **The `'auto'` strategy (the default) picks a different plan for to-one
  relations on a large parent set.** A `belongsTo` / `hasOne` include now loads
  batched when the query is unbounded or its `limit` exceeds
  `autoToOneJoinMaxRows` (default 1000), instead of staying in the
  single-statement join whenever its correlation column happened to be indexed.
  `findUnique` is never affected (its parent set is one row). Results are
  unchanged and byte-identical either way; what changes is the plan and the
  round-trip count, so a query that was tuned against the old choice can move in
  either direction. Migration: pin the old plan with
  `relationLoadStrategy: 'join'` (per query or client-wide), or raise
  `autoToOneJoinMaxRows`. A dev-mode note names each relation `'auto'` moved and
  why.
- **The `'auto'` strategy keeps relation `_count` inline unless the parent set is
  large.** `_count` on an unindexed foreign key previously always moved to the
  batched follow-up; it now does so only when the query is also unbounded or
  bounded above `autoToOneJoinMaxRows`. Same results, one fewer round-trip on
  bounded queries. Related: the unindexed fallback now requires DB-backed index
  metadata to engage at all (a `defineSchema`-only schema can never prove a probe
  unindexed), while the new cardinality rule applies with or without it.
- **The many-to-many nested-write error covers a smaller set, and points
  somewhere reachable.** `connect` / `disconnect` / `set` no longer throw (see
  Added). The remaining operations (`create`, `connectOrCreate`, `update`,
  `upsert`, `delete`) still throw `ValidationError` (E003), and the message now
  names the operation, lists the supported set, and points at
  `db.table("<junction>")`, the one spelling that actually resolves on both the
  core and compat clients (and inside `$transaction`), rather than promising
  transaction scoping the old advice could not deliver.
- **Generated `*Create` / `*Update` input types accept a `Date` on `time` /
  `timetz` columns** (`string | Date`), matching the write path above and
  Prisma, which types those fields as `Date`. The row type stays `string`: that
  is what the column reads back as. This only widens an input type, so existing
  code still compiles.
- **BREAKING: a nested `belongsTo` update with a `NULL` parent FK throws.**
  It previously matched (and wrote) every related row with a null reference key.
  It now throws `NotFoundError` (E001). Migration: this is the fix, not a
  regression. If you were relying on the old behavior you were relying on a
  full-table update; write it explicitly as
  `db.authors.updateMany({ where: { ... }, data: { ... } })`.
- **BREAKING: a `Date` bound to a `date` or `timestamp` column is stored in
  UTC.** It was stored using the writing process's local calendar fields, so the
  value in the column depended on that machine's `TZ`. Writes now bind the
  `Date`'s UTC components, matching the read path, which has always interpreted
  an offset-less value as UTC. This changes the values your application writes
  from today on, and it means rows written BEFORE the upgrade from a non-UTC
  process are shifted relative to rows written after it. Only PostgreSQL, only
  the zone-less `date` / `timestamp` types, and only `Date` values: a string
  literal, a `timestamptz` column, and every other engine are unaffected.
  Migration: you are affected only if all three hold. (1) You have a `date` or
  `timestamp` column (not `timestamptz`), which you can check with
  `SELECT table_name, column_name, data_type FROM information_schema.columns
  WHERE data_type IN ('timestamp without time zone', 'date')`.
  (2) You write `Date` values to it
  through Turbine. (3) The process doing the writing did not run in UTC:
  `node -e "console.log(Intl.DateTimeFormat().resolvedOptions().timeZone,
  new Date().getTimezoneOffset())"` in your deployment environment, where a
  non-zero offset means the old writes were shifted by exactly that many
  minutes. If all three hold, existing rows written by that process can be
  corrected with `UPDATE t SET col = col + interval 'N minutes'` using that
  offset, scoped to the rows written before the upgrade. To keep the old
  behavior instead, set `utcTimestamps: false` in the client config: that is the
  same switch that turns off UTC read parsing, so reads and writes stay
  symmetric either way.
  Anything that is not a non-negative safe integer (`NaN`, a non-numeric string,
  a negative, a fraction, a value past `Number.MAX_SAFE_INTEGER`) throws
  `ValidationError` (E003): `limit on "users" must be a non-negative integer,
  received: NaN`. Numeric strings (`'5'`) still coerce. This applies to
  top-level `limit` / `offset` and per-relation `limit`, on every engine.
  Migration: coerce and validate at the edge, for example
  `const limit = Math.min(Number(req.query.limit) || 20, 100)`.
- **BREAKING: a single-key plain object in `data` on a non-json column throws.**
  On a scalar column that shape can only be a misspelled atomic operator, and
  binding it plainly wrote JSON text into the column. It now throws
  `ValidationError` (E003): `Unknown update operator "incremnt" on
  "posts.viewCount"`, listing the supported operators. The check is deliberately
  narrow and skips json / jsonb columns, arrays, `Date`s, class instances
  (`Buffer`, decimal wrappers) and multi-key objects, none of which are
  operator-shaped. Migration: fix the operator spelling, or move the value onto
  a json / jsonb column if it really is a payload.
- **BREAKING: the `dialect` option is removed from `migrateUp`, `migrateDown`,
  `migrateDeploy`, `migrateStatus` and `inspectMigrationDeploy`.** It advertised
  multi-engine migrations the runner never implemented: every one of these opens
  a `pg.Client` directly, so passing a SQLite or MySQL dialect produced
  non-Postgres SQL sent to a Postgres connection. The migration runner is
  Postgres-only and now says so in its signature. Migration: delete the option.
  If you were passing `postgresDialect`, the behavior is unchanged.
- **BREAKING (type-level): a typo in `select` or `omit` is a compile error.**
  `select?: S` alone could never reject one, because `S` is inferred *from* the
  object literal, so `{ emial: true }` simply became the inferred type and
  silently narrowed the result to `Pick<T, never>`. The property is now
  `S & FieldFlags<T, S>`, which maps any key that is not a field of `T` to
  `never` and reports the error at the offending key. Legitimate flag maps are
  unaffected and the result narrowing is unchanged. Migration: fix the
  misspelled key the compiler now points at.
- **`seedFile` is the canonical config key.** `turbine init` writes `seedFile`
  and scaffolds the seed to `./turbine/seed.ts` (a pre-existing root-level
  `./seed.ts` is kept, so a re-run never creates a second seed file). `seed`
  remains a back-compat alias and still works; `seedFile` wins when both are
  present. Config-less discovery gained the `turbine/` locations, appended after
  the root-level ones so no project that relies on `./seed.ts` changes behavior:
  `seed.ts`, `seed.js`, `seed.sql`, `turbine/seed.ts`, `turbine/seed.js`,
  `turbine/seed.sql`. Migration: none required; rename `seed` to `seedFile` when
  convenient.
- **PowQL doc-field index DDL quotes the indexed column**, so
  `alter T add index (.order->"x")` becomes ``alter T add index (.`order`->"x")``.
  This changes the emitted bytes for a column whose name is a PowQL keyword or is
  otherwise not a bare identifier; every other column emits identically. The
  previous form spliced the name in raw and failed to parse on a keyword-named
  column. Migration: none, unless you diff generated DDL byte-for-byte.
- **Studio refuses a query it cannot prove is PII-safe past 32 levels of
  nesting** rather than passing it through unchecked, and refuses a redacted
  column in `cursor` and `distinct` as it already did in `where` and `orderBy`.
  Migration: flatten the query, or restart Studio with `--show-pii`.

### Documentation

- **A published benchmark claim was wrong and has been corrected.** The README
  and the benchmarks page showed Turbine fastest at streaming 50K rows (60.7 ms)
  and labelled the scenario a near-tie. A fresh run against 0.50.0 measures
  **Drizzle 0.45 fastest at 50.18 ms against Turbine's 63.87 ms, a 27% Drizzle
  win**, reproduced in five runs across two harnesses, with Drizzle sitting
  exactly on the hand-written `pg` keyset control at 50.97 ms. The published
  figure rested on a single Drizzle measurement of 65.8 ms that did not
  reproduce. The loss is now stated plainly on both surfaces rather than the row
  being dropped. Two further corrections in the same table: the "four near-ties"
  is **two** (`count` is a clean Turbine win, streaming is a Drizzle win), and
  the "1.6x to 2.6x ahead of Prisma" range on nested shapes is actually **1.9x
  to 3.0x**, corrected even though it errs in our favor.
- **The whole benchmark section is republished from a fresh 2026-07-25 run
  against 0.50.0**, replacing figures measured once on 2026-07-21 against 0.39.0.
  The new harness (`benchmarks/bench-interleaved.ts`) runs every arm once per
  round, rotates the arm order every round, reports medians over three full runs,
  and adds a hand-written raw `pg` control arm. That control yields the strongest
  claim available, and the pages now lead with it: **Turbine runs at 1.07x
  hand-written `pg`, where Drizzle runs at 1.47x and Prisma at 1.84x.** Headline
  geomeans over ten scenarios are **1.87x faster than Prisma 7.9** and **1.36x
  faster than Drizzle 0.45**. The **measurement drift floor is now published
  alongside the table**: the identical control arm drifts 1% to 14% between runs
  on multi-millisecond scenarios but **21% to 47%** on the sub-0.15 ms ones, so
  every published sub-0.15 ms figure carries roughly one third uncertainty in its
  absolute value even though its ordering is stable. Full writeup in
  `benchmarks/RESULTS-0.50.0.md`; `benchmarks/RESULTS.md` is marked historical
  and its contradictory "pipeline about 3x faster" prose is scoped to the retired
  Prisma 7.6 table it describes. Claims this run cannot speak to are called out
  as unverified rather than carried forward, including the Prisma 7.6-to-7.9
  improvement percentages, which have been removed.
- **The migrate-from-prisma page no longer argues that a correlated indexed
  subquery beats the batched loader.** The page cited 659 parent rows to make
  that case, and fresh data contradicts it for to-one relations at every size at
  or above about 25 parent rows, on a plan Turbine's own `'auto'` default no
  longer follows. The passage now explains the actual tradeoff: a correlated
  subquery is one round-trip whose cost scales per parent row, the batched loader
  is two round-trips each of which is a flat keyset lookup, so the crossover
  depends on both parent-set size and round-trip time, with a table of break-even
  points from a local socket to a cross-region pooled connection. The
  index-versus-no-index finding, which is the point of the section and a ~290x
  difference, is unchanged.

## 0.49.0 (2026-07-25)

A correctness release. Two silent wrong-data paths on default code paths are
closed, several safety guards that could be switched off by a single character
are fixed, and every public claim that a file in this repo disproved has been
corrected. Two behaviors change in ways an existing app can notice; both are
listed under Changed with the exact opt-in.

### Fixed

- **Nested writes could touch rows belonging to another parent.**
  `delete` / `update` / `disconnect` / `upsert` inside a relation's `data` used
  only the caller-supplied `where`, with no predicate tying the target to the
  parent being written. `users.update({ where: { id: 1 }, data: { posts: { delete: { id: 4 } } } })`
  deleted post 4 even when it belonged to user 2, which turns any endpoint that
  forwards a client-supplied id into a cross-tenant write primitive. Every one of
  those operations now ANDs the relation correlation (`child.foreignKey =
  parent.referenceKey`) onto the caller's `where`, and reports `NotFoundError`
  (E001) when the target is not related to this parent. The same fix covers the
  `belongsTo` upsert, which looked up and rewrote the row named by `where`
  regardless of which row the parent actually pointed at.
- **The batched relation loader discarded relation `where` filters.** With
  `relationLoadStrategy: 'batched'` (and therefore on the `'auto'` default's
  batched fallback), the correlation predicate was spread over the caller's
  `where` when both named the same key, so `with: { posts: { where: { userId: 2 } } }`
  silently returned the parent's own posts instead of an empty set. The two
  predicates are now ANDed, and the join and batched strategies return
  byte-identical results.
- **A single `E'...'` string could disable the destructive-migration guard.**
  Both the migration statement splitter and the destructive scanner treated a
  backslash-escaped quote inside an escape string as the end of the literal, so
  everything after it parsed as string content: a migration containing
  `E'it\'s fine'` hid every following `DROP TABLE` from the two-step
  confirmation. Quoted identifiers containing an apostrophe (`"customer's_orders"`)
  had the same effect, and a dollar-quote tag with a digit in it (`$do1$`) hid a
  procedural body. All three are fixed, with regression tests that fail on the
  old code.
- **`doctor --unused` / `--audit` no longer recommend dropping an index the same
  run demands.** Indexes serving a live relation probe are subtracted from the
  drop suggestions (audit keeps the row, annotates it, and withholds the DROP),
  so the report can no longer contradict its own missing-index section.
- **`doctor` reports exact-duplicate indexes.** Two byte-identical indexes were
  invisible to the redundancy check, which only looked for a strict leading
  prefix. Exactly one side of the pair is reported.
- **Studio: banners no longer open a several-hundred-pixel void.** The app grid
  declared two rows for five children, so any visible banner (write, PII, demo)
  stretched into the implicit row. Also fixed: switching tables from another tab
  and then opening the Data tab rendered the previous table's rows under the new
  table's name until the next refresh.
- **PII redaction in Studio and the MCP server now has something to redact.**
  `pii: true` is a code-first declaration that introspection never infers, and
  both tools build their schema from live introspection, so their redaction was
  inert against a real database (it only ever worked under `studio --demo`).
  Both now read tags from the generated metadata in your `out` directory, Studio
  states at startup how many it found (and warns plainly when it found none), and
  the MCP `sample_rows` tool redacts tagged columns before rows reach an agent's
  context.
- **`_min` / `_max` and `groupBy` keys respected the PII contract only by
  accident.** See Changed: they are now gated.
- **A PII-tagged correlation column silently emptied its relation.** When a
  relation's `referenceKey` (or a child FK) was itself `pii: true`, the default
  projection left it out, the batched loader had no keys to stitch on, and every
  parent came back with an empty relation array on the DEFAULT `'auto'`
  strategy, with no error. The key is now projected explicitly and stripped
  after stitching, so the value still never reaches the caller.
- **Studio's query builder refused nothing on PII columns.** The Data tab
  already refused a `where` / `orderBy` / `isNull` on a redacted column (the
  answer is an oracle for the hidden value); `/api/builder` accepted all of
  them, at every `with` level. It now refuses them the same way. This became
  reachable in this same release, when PII tags started reaching Studio at all.
- **`redactUrl` left credentials in CLI output.** A password containing `/`,
  `:`, or `@` defeated the pattern, so `postgres://u:pa/ss@host/db` printed in
  full. It now anchors on the scheme and consumes the whole userinfo section.
- **`prisma-compat` had no way to opt into PII.** `includePii` now passes
  through on reads, `groupBy`, and `aggregate`, so a tagged schema is not a
  one-way door for compat call sites.
- **Nested-write `NotFoundError` carries `table` / `where` / `operation` again**,
  as the errors documentation promises, and its message says the target may
  belong to a different parent rather than only that it was not found.
- **Full-text `search` and array-column filters throw on engines that cannot run
  them.** They previously emitted PostgreSQL-only SQL on SQLite / MySQL / SQL
  Server; both are now gated by dialect capability and throw
  `UnsupportedFeatureError` (E017) with the portable alternative named.
- **Observability metrics were attributed to the wrong minute** when a flush
  straddled a bucket boundary; the bucket is part of the buffer key now.
- **The `_turbine` RLS test fixture** no longer needs a manual
  `GRANT USAGE ON SCHEMA public`, so `npm test` passes on a stock PostgreSQL.
- **`doctor --unused` now says when its own statistics are too young to act on**,
  matching the cost section, which already refuses to score them.
- **A wrong-shaped schema fails at construction with an actionable message**
  instead of dying later as `TypeError: this.tableMeta.columns is not iterable`.
  A `defineSchema()` result is named specifically, with the
  `schemaDefToMetadata(def)` fix.
- **Studio: reverse navigation finds one-sided relations.** "Referenced by" was
  derived only from a table's own `hasMany` / `hasOne`, so a relation declared
  only on the child (`comments.user -> users`, the norm in a `defineSchema`
  file) was unreachable from the parent even though the child grid visibly
  rendered the foreign key. Inbound `belongsTo` relations now count too.
- **Studio: counts read `1 row`, not `1 rows`**, and the PII banner no longer
  cites `--show-pii` when the flag was not passed (demo-mode pill).

### Changed

- **BREAKING (opt-in restores it): `groupBy` by a PII column, and `_min` / `_max`
  over one, now require `includePii: true`.** Both return stored values, which
  contradicted the documented contract that PII columns stay out of every default
  projection. Without the flag they throw `ValidationError` (E003) naming the
  column, the table, and the fix. `_count`, `_sum`, and `_avg` over a PII column
  need no opt-in, and `where` / `orderBy` / `having` on PII columns stay
  unrestricted. Untagged schemas emit byte-identical SQL and are unaffected.
  Migration: add `includePii: true` to the affected `groupBy` / `aggregate` call,
  or drop the PII column from `by` / `_min` / `_max`.
- **BREAKING (previously silent): a nested write on a many-to-many relation
  throws.** m2m has never had a nested-write implementation on any engine; the
  relation op fell off the end of the dispatch, so the write never happened and
  the call reported success. It now throws `ValidationError` (E003) naming the
  junction table. Migration: write junction rows directly
  (`db.userTags.createMany(...)`) inside the same `$transaction`.
- **A nested `delete` / `update` / `disconnect` selector that binds nothing is
  refused.** `delete: {}` or `delete: { id: undefined }` used to be caught by the
  empty-where guard; with the parent correlation now ANDed on, the merged
  predicate is never empty, so the caller's half is checked directly. It throws
  `ValidationError` (E003) rather than deleting every child of that parent.
  `delete: true` remains valid on a to-one relation and is refused on a to-many.
- **`doctor --json` has a stable key set.** `unused`, `redundant`, `audit`, and
  `invalid` are always present (empty when the scan did not run) rather than
  appearing only with a flag, and a `subtraction` object reports which scans
  ran. Each unused-index entry gained a structured `shape`
  (`kinds` / `accessMethod` / `definition`) beside the prose `caveat`, so a
  consumer never parses a sentence.
- **Coverage thresholds re-baselined to measured values** (lines/statements 75,
  branches 85, functions 59) with type-only modules excluded from the
  denominator, and the release workflow now gates publishing on the coverage and
  error-code jobs. The previous floors had been failing continuously, which is
  how a red gate got normalized. The reasoning, the measuring command, and a
  dated target for function coverage are recorded in `.c8rc.json`; floors ratchet
  up only.

### Documentation

- Corrected every claim a file in this repo disproved: the nested-relation
  benchmark ratios and the "slowest on all ten scenarios" line, the bundle-size
  figures on the landing page, the superseded PowDB-versus-SQLite headline in the
  cross-engine benchmark notes, `DISTINCT ON` described as a SQL Server gap when
  it is Postgres-only, and the coverage thresholds quoted in `STABILITY.md`.
- The Prisma migration guide gained a **Silent value differences** section
  (`Decimal` as `string`, `BigInt` as `number`, `select` / `include` dropped on
  writes, `aggregate()` ignoring `orderBy` / `take` / `skip`, JSON `equals`
  compiling to containment), documents that the 0.41 unique-FK change renames the
  relation as well as changing its shape, and no longer claims nested writes cover
  many-to-many.
- Full-text `search`, array-column filters, and `groupBy({ distinctOn })` are
  listed in the Postgres-only sets on the engines page, the README, and the
  migration guide, and appear in the capability matrix.
- The PII gate is documented where a reader lands: the `groupBy` and `aggregate`
  sections, the E003 row in the error table, and the Studio / MCP pages.

## 0.48.0 (2026-07-24)

### Added

- **PowDB introspection is relation-aware on 0.19.1+.** PowDB 0.19.1 ships a link
  introspection surface (`schema links` plus link rows in `describe`).
  `introspectPowdbDatabase` now reads declared entity links and populates
  `SchemaMetadata.relations` for the first time on PowDB: to-one links become
  `belongsTo` (with a synthesized reverse `hasMany`), to-many links become
  `hasMany`. Many-to-many junctions cannot be inferred from links, so
  `defineSchema` remains the recommended relation-aware path. Gated on a new
  patch-aware `linkIntrospection` capability (engine version probe, 0.19.1 floor).
- **Scalar link paths lift the bigint/bytes to-one loader fallback.** On PowDB
  0.19.1+, a `with` clause for a `belongsTo` relation whose projected child columns
  include bigint or bytes (which JSON projection blocks cannot carry, previously a
  per-relation loader round trip) now compiles to alias-qualified scalar link-path
  projections on the parent statement, single statement, when a matching link is
  declared in the database (verified against a cached `schema links` snapshot;
  any mismatch falls back silently to the loader). Output is loader-identical,
  including missing-relation `null` shapes and native bigint values. Cases nested
  projections already serve keep nested projections: the engine never plan-caches
  link-bearing queries, so hot cacheable paths are deliberately left alone. Gated
  on a new `linkPaths` capability (0.19.1 floor; 0.19.0 is never eligible).
- **Opt-in link DDL emission.** `powqlSchemaDDL` accepts `emitLinks: true` and
  emits one `link Owner.name -> Target on local = target` per single-column
  relation (composite-key and junction relations skipped; owner-column name
  collisions skipped with a once-only warning). The apply path existence-checks
  via `schema links` first (link DDL is create-only with no `if not exists`):
  already-declared identical links are skipped, and a declared link with
  different endpoints is warned about, never dropped or replaced. Note: the first
  link declaration permanently upgrades the data directory to catalog v7;
  pre-0.19 binaries can no longer open it.
- **0.19.1 hard-error mapping.** The two behaviors that silently returned wrong
  results on 0.19.0 (bare dotted projection paths, aggregates over link or nested
  projections) are hard errors on 0.19.1 and now wrap to `ValidationError` (E003)
  on both transports. Dev dependencies track `^0.19.1`; the PowQL lexer is
  verified unchanged 0.19.0 to 0.19.1, so the tested ceiling continues to cover
  the 0.19 line.

## 0.47.0 (2026-07-23)

### Added

- **`turbine doctor --unused`: index subtraction advice.** Doctor now reports the
  other half of index hygiene: indexes with zero scans since `stats_reset` (with the
  reset age printed and the honest caveats: counters zero on stats resets, and
  replica reads never feed primary counters, so a replica-only index looks dead
  here), redundant indexes whose columns are a leading prefix of a wider compatible
  index, and invalid indexes left behind by failed `CONCURRENTLY` builds. Suggestions
  are `DROP INDEX CONCURRENTLY` statements with reclaimable sizes, report-only:
  never written to a migration, never auto-applied, and there is deliberately no
  `--fix` for drops. Primary-key, unique-constraint, exclusion-constraint, and
  replica-identity indexes are always excluded. `--min-scans` adjusts the
  never-scanned threshold.
- **`turbine doctor --audit`: did doctor's own advice earn its keep?** Audits the
  indexes doctor previously suggested (by their deterministic names, 63-character
  truncation handled, post-truncation collisions reported as ambiguous rather than
  guessed) and flags the ones that have never been scanned since stats reset.
- **Workload-heat annotations.** When the `_turbine_metrics` table from the observe
  module is present (same database or `--metrics-url`), doctor maps query heat to
  tables and annotates findings ("hot in your workload: N queries/min, p95 X ms"),
  prioritizing hot findings. One honesty line is printed when heat data is
  unavailable. `doctor --json` carries all of the above as additive fields under the
  same `schemaVersion: 1` contract.
- **Pluggable observe sinks.** `ObserveEngine`'s flush target is now the
  `ObserveSink` interface. The default remains the `_turbine_metrics` Postgres
  writer, byte-identical to previous behavior (covered by a regression test). New
  `HttpJsonSink` POSTs metric batches as JSON to any HTTP endpoint (fire-and-forget,
  never throws), for self-hosted dashboards and metrics pipelines.
  `ObserveConfig.connectionString` is optional when a custom sink is provided.
  Telemetry remains aggregates only (model, action, counts, latency percentiles):
  no SQL text, no parameters, opt-in, off by default.

### Fixed

- **Doctor's index-column reads now survive node-pg's `name[]` handling.** The stats
  collector aggregated `pg_attribute.attname` into a `name[]`, which the driver
  returns as an unparsed string; iterating those columns (new in the redundancy
  check) would have thrown. The collector now casts to `text[]`.

## 0.46.0 (2026-07-23)

### Added

- **`turbine doctor` scores index suggestions by cost, not just topology.** On
  PostgreSQL, doctor now reads live statistics (`pg_stat_user_tables`,
  `pg_stat_user_indexes`, `pg_stats`, relation sizes, `stats_reset` age) and sorts
  missing-FK-index findings into three tiers: take freely, take deliberately, and
  scrutinize, printing the numbers behind each verdict (table size, writes per day
  since stats reset, existing index count, probing relations). Mostly-NULL FK columns
  get a partial-index suggestion (`CREATE INDEX ... WHERE col IS NOT NULL`) instead
  of a full one, and candidates on tables with high HOT-update ratios carry an
  explicit warning and a tier bump. Invalid indexes (failed `CONCURRENTLY` builds)
  are reported. When statistics are unavailable, too young, or never reset, doctor
  degrades honestly to the previous size-sorted topology report with a printed
  reason; it never fakes confidence. Non-Postgres engines keep the topology-only
  report.
- **`turbine doctor --json`.** Machine-readable report with a stable versioned
  contract (`schemaVersion: 1`): scored findings with tier, numbers, and SQL,
  invalid indexes, and degradation notices. Built for CI gates and external tooling.
- **No-transaction migrations and `CREATE INDEX CONCURRENTLY`.** A migration whose
  header carries the `-- turbine:no-transaction` directive now runs outside a
  transaction, one statement per query (required for `CONCURRENTLY`), and is
  recorded only after every statement succeeds. The statement splitter understands
  quotes, dollar-quoting, and line/block comments. `doctor --fix` emits
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS` migrations with this directive by
  default, including a recipe comment covering idempotency, the
  failed-build-leaves-INVALID-index trap, and `lock_timeout` guidance;
  `--no-concurrently` keeps the plain transactional form. `migrate up` prints a
  loud notice whenever it applies a no-transaction file.

## 0.45.0 (2026-07-23)

### Fixed

- **PowDB: `not` and `notIn` filters now match SQL null semantics.** PowDB 0.18.2
  changed `!=` and range comparisons to exclude missing-value rows (SQL parity), but
  Turbine still emitted `not (col = $n)` for the `not:` operator and a bare `not in`
  for `notIn`, both of which continue to match missing-value rows. On a nullable
  column, `where: { col: { not: v } }` and `{ notIn: [...] }` therefore returned
  different rows on PowDB than on every SQL engine. The `not:` leaf now compiles to
  `col != $n` (including the case-insensitive variant) and non-empty `notIn` appends
  an `is not null` presence guard; `notIn: []` keeps its match-everything semantics
  (SQL parity requires missing-value rows to match an empty `notIn`). The change is
  behavior-neutral on pre-0.18.2 engines, so it is not capability-gated. The
  `NOT: {...}` combinator remains a documented divergence for null-involved
  sub-clauses on PowDB (its whole-clause negation cannot be mechanically re-spelled).

### Added

- **PowDB 0.19 support: `entityLinks` capability and catalog v7 awareness.** The
  capability map now recognizes PowDB 0.19's entity links (`entityLinks`, gated on an
  engine version probe of 0.19+, never assumed). Query generation deliberately keeps
  Turbine-composed nested projections instead of link traversal: link-bearing plans
  are not cached by the engine, declared links cannot be introspected (so drift from
  the schema would be undetectable), and the published 0.19.0 builds have known
  link-projection defects. `wrapPowdbError` maps the new
  `unsupported catalog version` failure to `ConnectionError` (E004) with an upgrade
  hint, and the engines page documents the catalog v7 one-way door: the first `link`
  declaration permanently upgrades a data directory so pre-0.19 binaries can no
  longer open it; databases that never declare links stay on v6.
- **PowDB tested ceiling raised to 0.19.** The PowQL lexer is verified byte-identical
  from 0.18.0 through 0.19.0 (`link` was already a reserved keyword), so the string
  encoding ceiling (`POWQL_LEXER_TESTED_CEILING`) rises to `'0.19'`. Dev dependencies
  now track `@zvndev/powdb-client` / `@zvndev/powdb-embedded` `^0.19.0`, and the live
  integration suite exercises link DDL, traversal, catalog persistence, and the new
  null-semantics parity against the real 0.19.0 embedded engine.

## 0.44.0 (2026-07-23)

### Added

- **`turbine-orm/prisma-compat` emulates Prisma's client-side defaults.** Prisma fills
  `@default(uuid())` / `@default(cuid())` / `@updatedAt` in the client, so those columns
  usually have no database default and migrated call sites omit them (previously a
  NOT NULL violation on every such create). `migrate-from-prisma` now records these in
  the generated name map (`clientDefaults`, including `@default(now())` when
  introspection finds no database default), and the adapter fills them on
  `create`/`createMany` and touches `@updatedAt` fields on `update`/`updateMany`/
  `upsert`, exactly like Prisma. Explicitly provided values are never overwritten.

### Fixed

- **Nested writes now work in the `$transaction([...])` array form.** The lazy batch
  path compiled each call to a single SQL statement, which cannot express nested write
  data (`connect`, `create`, ...), so such a batch item failed with an unknown-field
  validation error. When any item in the array carries nested write data (or an upsert
  needs the lookup-first path below), the whole array now runs sequentially inside one
  transaction through the nested-write-capable path: ordering, atomicity, and Prisma's
  array-form contract are preserved. Plain batches keep the single-round-trip path.
- **`turbine-orm/prisma-compat` upsert now follows Prisma's lookup-first semantics.**
  Turbine core `upsert` compiles a single `INSERT ... ON CONFLICT` keyed on the create
  data's unique values. When an upsert's `where` key values differ from its `create`
  values, that inserts the create row even though the `where` row exists (a silent
  divergence from Prisma). The adapter now passes through to the native atomic upsert
  only when the `where` key values equal the create values; otherwise it emulates
  Prisma inside a transaction: look up by `where`, update the found row, else insert
  `create`. Core semantics are unchanged and now documented in the migration guide.

## 0.43.0 (2026-07-23)

### Fixed

- **`where` filters on many-to-many relations now route through the junction table.**
  A relation filter (`some` / `every` / `none`) on a `manyToMany` relation compiled the
  direct foreign-key correlation used for `hasMany` / `belongsTo`, which degenerates to
  `target.pk = parent.pk` and silently matches nothing (a `count` or `findMany` filtered
  on such a relation returned 0 rows while the `include` path returned the linked rows
  correctly). The filter now correlates through the junction:
  `EXISTS (SELECT 1 FROM junction WHERE junction.targetKey = target.pk AND
  junction.sourceKey = parent.ref)`, composite keys paired positionally, all bare table
  names so nested relation filters keep working. A `manyToMany` relation missing its
  `through` descriptor now throws a `ValidationError` instead of compiling wrong SQL.
- **`migrate-from-prisma` resolves a remaining unnamed relation pair by elimination.**
  When a model has several relations to the same target and all but one are pinned by
  `@relation("Name")` pairing or explicit `fields: [...]`, the one unnamed pair now takes
  the single unconsumed candidate instead of reporting "ambiguous", matching Prisma's own
  resolution. Two competing unnamed pairs still report ambiguous.
- **pg-style pool option aliases.** `turbine({ max, idleTimeoutMillis,
  connectionTimeoutMillis })` now works as documented aliases for `poolSize` /
  `idleTimeoutMs` / `connectionTimeoutMs` (the turbine-native field wins when both are
  set). Previously the pg spellings failed typecheck and were silently ignored by
  untyped callers, producing default pool sizing.
- **`turbine-orm/prisma-compat` matches Prisma's `time` column convention.** A Postgres
  `time` / `timetz` value now surfaces from the adapter as a `Date` on 1970-01-01 UTC
  (Prisma's epoch-day convention) instead of the driver's raw `HH:MM:SS` string, so
  `.getHours()`-style call sites survive migration. Turbine core is unchanged (raw
  string, documented).

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
  `CREATE UNIQUE INDEX ... (ledger_id, line_id) WHERE (line_id IS NOT NULL)`, captured
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
  `text[]`, JSON filters, JSON ordering, and the new JSON groupBy now
  actually execute on those engines (verified live on `node:sqlite`).
  Predates this release for JSON filters/ordering.

## 0.31.0 (2026-07-13)

Three production-blocking bug fixes plus two new query capabilities that
eliminate common raw-SQL escape hatches in version-driven / multi-tenant
data models.

### Fixed
- **Owned-pool `disconnect()` leaked every driver connection** on the
  networked PowDB path, `turbinePowDB({host, port})` never patched
  `disconnect()`, so the driver pool's `close()` never ran and a one-shot
  script hung until the server's 300s idle timeout. Owned pools now close on
  `disconnect()`, and `PowdbPool.end()` additionally destroys still-checked-out
  clients (the driver's `close()` only reaps idle ones). Queries after
  `disconnect()` throw a typed `ConnectionError` on both transports.
- **Nested-relation `orderBy` rejected camelCase columns** -
  `with: { fields: { orderBy: { sortOrder: 'asc' } } }` threw E003 because the
  relation-subquery path skipped the target table's columnMap. Nested orderBy
  now accepts exactly what top-level orderBy accepts, unified across the join
  strategy, batched loader, m2m, and the MSSQL override; belongsTo/hasOne
  subqueries with an `orderBy` now order before their `LIMIT 1`.
- **Cold-client false E017 on a same-tick transaction burst**, the
  re-entrancy marker was planted with `AsyncLocalStorage.enterWith()` in the
  caller's context, so sibling `$transaction` calls launched in one tick could
  see each other's markers (runtime-dependent).
  The marker now lives only inside the transaction callback's async subtree
  via a new optional `wrapTransactionCallback` driver seam, the failure is
  impossible by construction. Implicit nested-write transactions plant the
  same marker. One contract change: a second raw manual `begin` from the same
  context now queues FIFO (bounded by `transactionQueueTimeoutMs`) instead of
  throwing E017.
- **Connection release now honors the destroy contract** (adversarial-review
  finding): `release(err)` with a truthy error destroys the connection instead
  of re-idling it, and any release with an un-ended `begin` fires a bounded
  best-effort `rollback` first, so a `$transaction` timeout can no longer
  return a connection with an open server-side transaction to the pool (which
  blocked the next transaction on PowDB's global write lock).

### Added
- **Column-to-column `where` comparison**, `{ equals: { col: 'otherField' } }`
  (also `not`/`gt`/`gte`/`lt`/`lte`) compiles to `"a" = "b"` with no bound
  param; cache-fingerprint-safe, works in relation filters and `with.where`.
  On json/jsonb columns an `equals` object stays a JSON value.
- **JSON-path `orderBy`** on same-table json/jsonb columns -
  `orderBy: { data: { path: ['weight'], direction: 'asc', type: 'numeric' } }`,
  top-level and in nested `with` orderBy. Cross-relation JSON ordering and
  grouped JSON aggregates are deferred to a designed
  0.32.

### Docs
- `docs/internal/NEXT-INTEGRATIONS.md` no longer claims PowDB was "declined" -
  the driver shipped in 0.22 and is load-bearing. (Per-call/per-table
  `warnOnUnlimited`, also requested, already shipped in 0.30.0.)

## 0.30.0 (2026-07-13)

Fixes and features for JSONB-heavy, Prisma-migrated workloads, plus
alignment with PowDB 0.10. Adversarially reviewed before ship; 15 review
findings (including one critical) fixed pre-release.

### Fixed
- **JSON/array filters inside relation filters were silently dropped.** A
  `JsonFilter` (`{ path, equals }`) under `some`/`every`/`none`, or in a
  `with.where`, compiled to a broken jsonb equality and matched nothing, with
  no error. Both paths now route through the real JSON/array clause builders,
  with the SQL-cache fingerprint and cache-hit param-collect mirrors kept in
  lockstep.
- **Postgres enum columns failed `createMany` with "column is of type X but
  expression is of type text".** The bulk `UNNEST($n::text[])` form defeated
  Postgres's enum inference. Enum columns (recognized via introspected
  metadata) now get an explicit `::"EnumName"` cast on every write bind -
  create, createMany (`::"EnumName"[]`), update, updateMany, upsert. Gated to
  the Postgres dialect; cross-schema type-name collisions are excluded via the
  newly recorded type schema.
- **FK/relation name collisions produced unsound generated types and
  unreachable relations.** A camelCase FK like `currentVersionId` derived a
  belongsTo that shadowed the scalar column (TS2430 under `--strict`,
  relation-where misroutes at runtime). Relation naming now disambiguates
  per-FK-column (`currentVersion`), with **legacy names preserved wherever
  they were collision-free**, regenerating a working schema does not rename
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
  inside the *other* open transaction, silent partial commits. The PowDB
  pools additionally refuse to forward commit/rollback from a scope that never
  acquired the transaction gate. (found by adversarial review)

### Added
- **JsonFilter range operators** `gt`/`gte`/`lt`/`lte` (with `path`): numeric
  values compare via a `::numeric` cast, strings as extracted text.
  `db.products.findMany({ where: { data: { path: ['rating'], gte: 4 } } })`.
 
- **`schemaDefToMetadata(def)`**, pure `SchemaDef` → `SchemaMetadata`
  converter, so code-first schemas drive non-SQL engines without a live
  database: `turbinePowDB(pool, schemaDefToMetadata(mySchema))`.
- **PowDB concurrent transactions queue FIFO** instead of throwing E017 under
  the single-writer lock. Re-entrant and nested transactions still throw E017
  immediately (queueing them would deadlock; detection via a chained
  AsyncLocalStorage marker that survives cross-pool nesting). New
  `transactionQueueTimeoutMs` option (default 30000; `0`/`Infinity` waits
  forever) → `TimeoutError` E002 on elapse.
- **`turbine generate --no-timestamp`**, omits the `Generated at:` header so
  regenerated output is byte-identical.
- **`warnOnUnlimited` per call and per table**, `findMany({ warnOnUnlimited:
  false })`, or `warnOnUnlimited: { userProfiles: false }` in config (accessor
  or snake_case keys).
- **PowDB 0.10 alignment:** reserved PowQL words (incl. the new `schema` /
  `describe` keywords) are backtick-quoted automatically in bare-identifier
  ledger_entries of generated PowQL; the server's new "transaction gate timeout"
  maps to `TimeoutError` E002.

## 0.29.0 (2026-07-12)

**Feature:** batch `$transaction([...])` pipelines on drivers that support it.

### Changed
- **Batch `$transaction` is one write burst on pipelining drivers.** The array
  form previously awaited each deferred query sequentially, N statements cost
  N round trips even though the batch is a single atomic unit. When the
  checked-out `PgCompatPoolClient` advertises the new additive capability flag
  `supportsPipelining: true`, `transactionBatch` now dispatches every statement
  back-to-back inside BEGIN/COMMIT and collects replies in order
  (`Promise.allSettled`, all in-flight replies drain before a ROLLBACK, and
  the lowest-index failure is thrown, wrapped as before). The PowDB pool's
  checked-out clients advertise the flag; `node-postgres` paths are
  byte-identical to 0.28.x (flag absent → sequential path unchanged), and the
  pipelined path is disabled for dialects with `resultStrategy: 'reselect'`.

### Added
- `PgCompatPoolClient.supportsPipelining?: boolean`, optional, additive; any
  PgCompat driver whose connection preserves FIFO reply order over a single
  socket can opt in to get the batched-transaction fast path.

## 0.28.3 (2026-07-11)

**Patch:** `turbine generate` output typechecks again.

### Fixed
- **Generated client failed `tsc` with TS2415 ("incorrectly extends") since 0.26.** The base `TurbineClient.$transaction` gained the batch-array overload (`$transaction([...queries])`), but the generator's interface-merge for the typed client still emitted only the callback signature, and a merged member must be compatible with the base member on its own. The generated `TurbineClient` interface now redeclares both overloads (typed callback + batch array). Caught by type-checking a generated client on 0.28.2.
- **New regression gate:** `generate-typecheck.test.ts` compiles freshly generated output with `tsc --noEmit` against the repo's own source types (path-mapped), so template ↔ client-type drift can never ship again, string-pin tests alone stayed green through this break.

## 0.28.2 (2026-07-10)

**Post-smoke-audit patch** for 0.28.1, consumer typecheck + docs honesty.

### Fixed
- **`@types/pg` restored to `dependencies`.** Moving it to `devDependencies` in 0.28.1 broke strict `tsc` for consumers whose projects do not set `skipLibCheck` (published `.d.ts` files import `pg` types). Runtime was always fine; TypeScript-first installs were not. Release gate now requires a pack-install + strict consumer typecheck before publish.
- **README PowDB capability blurb** rewritten to match the real engine (returning writes, auto or UUID PKs, client-side relation loads incl. m2m, nested writes for hasMany/hasOne/belongsTo).
- **Bundle-size claim** clarified as brotli *import graph* excluding `pg`, not dual-build install size.
- **STABILITY.md** stable CLI list includes `doctor`, `mcp`, `migrate deploy`.
- **Committed `site/lib/version.ts`** regenerated so the git tree matches the package version.

## 0.28.1 (2026-07-10)

**Gold-standard OSS hygiene pass**, trust surface for consumers and CI, not a feature drop.

### Improved
- **Error messages include stable codes.** Every `TurbineError` message is prefixed with its code tag (e.g. `[TURBINE_E008] …`) so logs are greppable without structured field access. Branch on `err.code` / `instanceof`, do not parse the message text.
- **Coverage floors ratcheted** to lines/statements 80%, functions 82%, branches 82% (measured actuals ~82–84%).
- **Engine CI jobs are hard gates** (MySQL, SQL Server, CockroachDB, PowDB), no longer `continue-on-error`.
- **Pack-smoke** verifies `sqlite`, `powdb`, and `adapters` subpath exports in addition to main/serverless/mysql/mssql.
- **Seeded generative SQL-safety fuzz** (`sql-safety-fuzz.test.ts`) over `quoteIdent`, equality/LIKE, and numeric filters.
- **Query module split:** `query/filters.ts` (filter-shape guards + fingerprints) and `query/deferred.ts` (`DeferredQuery` / options types) extracted from `builder.ts`.
- **`@types/pg` moved to `devDependencies`**, runtime `dependencies` is just `pg`.
- **`engines.node` is `>=20`** (matches the CI matrix; Node 18 is EOL).
- **SECURITY.md / STABILITY.md** supported-version tables updated for 0.28.x.
- **CODE_OF_CONDUCT.md** added; linked from README + CONTRIBUTING.
- Internal sprint/strategy scaffolding moved under `docs/internal/`.

## 0.28.0 (2026-07-09)

**Parity sprint, the largest feature release since multi-engine support.** A batch of gaps closed at once: query ergonomics (NULLS ordering, relation `_count`, ordering by a relation), schema completeness (referential actions, code-first enums/arrays/vector/checks), global filters for soft-delete and multi-tenancy, read replicas, a read-only MCP server for AI agents, seed-as-code, a non-interactive `migrate deploy`, Zod generation, and views + generated columns. Everything is additive, the Postgres default and the existing `findMany`/`with`/`where` API are unchanged, and `npm i turbine-orm` still installs only `pg`.

### Added, query ergonomics
- **`NULLS FIRST` / `NULLS LAST` ordering.** `orderBy` values accept a spec object `{ sort: 'asc' | 'desc', nulls?: 'first' | 'last' }` alongside the plain `'asc'` / `'desc'` direction: `orderBy: { lastLoginAt: { sort: 'desc', nulls: 'last' } }` → `ORDER BY "last_login_at" DESC NULLS LAST`. Applies everywhere an `orderBy` is compiled, top-level `findMany`/stream, `groupBy`, and the inner subquery of a `with` relation. Plain directions are byte-identical to before. **Behavioral note:** `NULLS FIRST/LAST` is a PostgreSQL and SQLite feature, on MySQL and SQL Server, explicit nulls placement throws `UnsupportedFeatureError` (E017) rather than emitting broken SQL.
- **Relation `_count` in `with`.** `with: { _count: true }` counts every to-many relation of the table; `with: { _count: { posts: true } }` counts only the named ones. Each becomes a correlated `COUNT(*)` scalar subquery (hasMany + manyToMany via the junction), assembled into a typed `_count: { [relation]: number }` object per row. Coexists with real relation subqueries. Errors: `RelationError` (E005) on an unknown relation, `ValidationError` (E003) on a to-one relation. The batched load strategy computes it with one grouped follow-up per counted relation, output deep-equal to the join strategy.
- **Ordering by a relation.** `orderBy: { posts: { _count: 'desc' } }` orders by a to-many relation's count (correlated `COUNT(*)`); `orderBy: { author: { name: 'asc' } }` orders by a to-one relation's target column (correlated scalar subquery, `{ sort, nulls }` supported). Relation ordering adds no bound params. To-many relations allow only `_count`; to-one allow real target columns. Unknown relation → E005, invalid key/column → E003.

### Added, schema completeness
- **Referential actions on foreign keys.** `references` now accepts `{ target, onDelete?, onUpdate? }` in addition to the `'table.column'` string, and the fluent builder gains `.references(target, { onDelete, onUpdate })`. Actions: `'cascade'`, `'restrict'`, `'set null'`, `'set default'`, `'no action'`; omitted clauses default to `NO ACTION`. DDL emits `ON DELETE …` / `ON UPDATE …`; introspection reads them back from `pg_constraint`, and `schemaDiff` detects action changes (non-destructive `DROP CONSTRAINT` + `ADD CONSTRAINT`). The plain string form is unchanged.
- **Code-first enums.** `defineSchema(tables, { enums: { post_status: ['draft', 'published', 'archived'] } })` declares enum types; columns opt in with `{ type: 'enum', enumName: 'post_status' }`. DDL emits `CREATE TYPE … AS ENUM (…)` before the tables that use it (labels are single-quote escaped), and codegen maps enum columns to string-literal unions.
- **Array columns.** `{ type: 'text', array: true }` emits `TEXT[]` (works with `varchar` lengths → `VARCHAR(8)[]`), maps to `T[]` in generated types, and is queryable with the existing `has` / `hasEvery` / `hasSome` operators end-to-end.
- **pgvector columns.** `{ type: 'vector', dimensions: 1536 }` emits `vector(1536)` and, by default, prepends `CREATE EXTENSION IF NOT EXISTS vector;` (pass `extensions: 'manual'` to emit a comment instead); maps to `number[]`. Gated on the Postgres dialect, a dialect without vector support throws `UnsupportedFeatureError` (E017).
- **Check constraints.** Column-level `check: 'price >= 0'` emits an inline `CHECK (expr)`; table-level `checks: [{ name?, expression }]` emit `CONSTRAINT "name" CHECK (expr)` (or a bare `CHECK` when unnamed). Introspection reads them back. A violation throws `CheckConstraintError` (E011) at write time.
- **New package-root exports:** `ReferentialAction`, `ReferenceDef`, `CheckDef`, `CheckMetadata`, and `DefineSchemaOptions`.

### Added, client
- **Global filters (soft-delete / multi-tenancy).** `TurbineConfig.globalFilters` maps a table accessor to a `WhereClause`, or a `() => WhereClause` evaluated per query build, that is AND-merged into the compiled `WHERE` of every read and mutation, **and every relation subquery targeting that table** (join and batched strategies, relation filters `some`/`every`/`none`, `_count`, and relation `orderBy`). Function filters enable per-request tenancy via closure. `create`/`createMany` are never filtered. A per-query `skipGlobalFilters: true | string[]` opts out. **Behavioral note:** the empty-`where` guard on `update`/`delete` still checks the *user-supplied* `where`, so a global filter never turns an unguarded mass mutation into an allowed one. Filter shape participates in the SQL cache; values are re-collected per build.
- **Read replicas.** `TurbineConfig.replicas` (connection strings or `PgCompatPool`s) load-balances read-only operations outside a transaction (`findMany`, `findFirst`, `findUnique`, `*OrThrow`, `count`, `aggregate`, `groupBy`, `findManyStream`) round-robin across replicas; ALL writes, `$transaction` bodies, `pipeline`, `raw`/`sql`, `$listen`/`$notify`, and observability flushes stay on the primary. `client.$primary()` returns a cached view that pins every operation (reads included) to the primary, for reading your own writes without replication lag. String replicas are owned pools (closed on `disconnect()`); external pools follow the caller-owns-lifecycle contract. Zero replicas = today's single-pool path, unchanged.
- **Batch `$transaction(DeferredQuery[])` overload.** Pass an array of `build*` deferred queries and they run atomically on one connection (`BEGIN` … each query … `COMMIT`), returning a positionally-typed results tuple. Any error rolls the whole batch back and rethrows; an empty array resolves to `[]`. The callback form is unchanged, `$transaction` accepts either.

### Added, CLI & tooling
- **`turbine mcp`, zero-dependency, read-only MCP server.** Speaks JSON-RPC 2.0 over stdio (protocol `2025-06-18`, server name `turbine-orm`) for AI agents like Claude Code and Cursor. Six read-only tools, `schema_overview`, `table_detail`, `migrate_status`, `doctor_report`, `explain_query` (schema-validated `findMany`-style builder args only, **no free-form SQL**), `sample_rows` (≤ 50 rows, table validated against the introspected schema). Every database access runs inside `BEGIN READ ONLY`; there is no write surface and no raw-SQL execution path. Malformed frames return a JSON-RPC error without crashing. `--include`/`--exclude` scope the exposed tables.
- **Studio / Observe refuse non-loopback binds by default.** `--host` other than loopback (`127.0.0.1` / `localhost` / `::1`) exits 1 unless you pass **`--allow-remote`** (loud warning when you do). Matches the “local single-user tool” security model instead of warn-and-proceed.
- **`turbine migrate deploy`, non-interactive production apply.** Never prompts (works with no TTY): applies all pending migrations inside the same advisory-lock + per-migration-transaction machinery as `migrate up`, reports `N applied`, and supports `--dry-run` to list pending without applying. Refuses to run (exit 1, clear message) on a checksum mismatch or a missing migration file, so a drifted history fails the deploy instead of diverging. It never auto-generates, seeds, or pushes.
- **Seed-as-code.** `turbine seed` resolves the seed from the config `seed` field (or `seedFile` alias) or the first default candidate, `seed.ts`, `seed.js`, then `seed.sql`. `.ts` runs through `npx tsx` (clear error if `tsx` is missing), `.js` is imported (a default-export function is called), `.sql` runs as SQL. New `defineSeed(fn)` export wires up a client from `DATABASE_URL`, runs your function, and disconnects.
- **`turbine generate --zod`.** Emits a `zod.ts` file alongside the generated types with a `XSchema` / `XCreateSchema` / `XUpdateSchema` per table, derived from column metadata (scalars, `z.coerce.date()` for dates, `z.enum([...])` for enums, `.array()`, `z.array(z.number())` for vectors, `.nullable()`; Create/Update optionality mirrors the generated input types). The generated file imports the user-side `zod` dep; the Turbine runtime never does.
- **`turbine generate --include-views`.** Introspects views and materialized views as read-only entities (`isView: true`): codegen emits an entity type and read accessors; a no-PK view's accessor omits the `findUnique` family (`Omit<QueryInterface<T>, 'findUnique' | 'findUniqueOrThrow'>`). **Behavioral note:** every write builder throws `ValidationError` (E003) "cannot write to a view".
- **STORED generated columns.** Introspection detects `GENERATED ALWAYS AS (…) STORED` columns; codegen keeps them in the entity type but omits them from `*Create`/`*Update` inputs. **Behavioral note:** `create`/`update`/`upsert` reject `data` containing a generated column with `ValidationError` (E003) before hitting Postgres.

### Docs
- New pages: **Global Filters**, **Read Replicas**, **MCP Server**, **Seeding**, **Zod Schemas**, and **Views & Generated Columns**. Extended the API Reference (NULLS ordering, relation `_count`, ordering by a relation), Schema & Migrations (referential actions, enums, arrays, vector, checks), Transactions (batch `$transaction`), Relations, and the CLI page (`migrate deploy`, `mcp`, `--zod`, `--include-views`, seed-as-code).
- **Quickstart honesty:** site `/quickstart` documents `tsx`, `"type": "module"`, `schema` vs `schemaFile`, and the empty-DB path (`defineSchema` → `push` → `generate`) alongside the existing-tables path.
- **Comparison copy corrected:** the Drizzle Studio row previously read "paid tier", local Drizzle Studio is free (only the hosted Drizzle Gateway is paid). Softened across the README, landing page, and Drizzle migration guide.

### Chore
- Removed broken root `npm run examples` script (missing `examples/examples.ts`); added `examples/README.md` index. `npm run dogfood` unchanged.
- Widened optional peer `mssql` to `^10 || ^11 || ^12` (matches tested `mssql@12`).

## 0.27.1 (2026-07-08)

Identical to 0.27.0 with an internal lint cleanup in the destructive-statement scanner; 0.27.1 is the canonical release (0.27.0's npm artifact predates the tagged source).

## 0.27.0 (2026-07-08)

**Destructive migrations now require explicit, triple confirmation.** A migration file containing data-destroying SQL should never run just because it exists, and "one flag and your table is gone" is too easy.

### Added
- **Data-loss gate on `migrate up` and `migrate down`.** Before applying, Turbine scans every pending migration (UP direction) / every DOWN section being rolled back for destructive statements: `DROP TABLE`, `DROP SCHEMA`, `DROP COLUMN`, `TRUNCATE`, `DELETE FROM`, `UPDATE` without a `WHERE`, and `ALTER COLUMN … TYPE` (potentially lossy cast). Comments, string literals, and dollar-quoted bodies are stripped first, so `-- DROP TABLE x` or a seeded string containing SQL never false-positives; `DROP INDEX`/`DROP CONSTRAINT`/`DROP TRIGGER` are deliberately not flagged (recreatable, no row data). When something is found:
  - **Interactive CLI**: prints an itemized report (statement kind, target object, what it destroys), then requires typing the literal phrase `destroy my data`, then a final `yes`. Anything else aborts with nothing applied.
  - **Non-interactive (CI/pipes)**: always refuses; proceeding requires the explicit `--allow-destructive` flag, which also prints a loud warning.
  - **Programmatic API** (`migrateUp`/`migrateDown`): refuses by default with an itemized `MigrationError`; opt in with `allowDestructive: true`.
  - The refusal is checked BEFORE anything runs, a refused batch applies zero migrations.
- (`turbine push` and `migrate create --auto` were already non-destructive: the schema differ has never emitted forward `DROP TABLE`/`DROP COLUMN` statements, dropped columns are detected but excluded from executable statements.)

## 0.26.0 (2026-07-08)

**Dogfood release from migrating a large production Prisma app onto Turbine**, a batch of correctness fixes the migration surfaced, plus the tooling that makes Turbine's correlated relation loading robust on schemas that grew up under batched-loader ORMs: a missing-FK-index doctor, an opt-in batched loading strategy, and an opt-in lean JSON wire encoding.

### Fixed
- **`timestamp` (without time zone) columns are now parsed as UTC (correctness, behavior change).** Both the pg driver default (OID 1114) and nested `json_agg` strings parsed offset-less timestamps in *server-local* time, the same row produced a different instant per deployment region, and every timestamp shifted by the machine's UTC offset. Turbine now pins offset-less timestamps to UTC (`parseDbDate`), matching Prisma/Rails/Django semantics. The OID 1114 parser is registered only for Turbine-owned pools (external/serverless pools are never touched). Opt out with `utcTimestamps: false` if you relied on local-time parsing.
- **`hasOne` relation subqueries correlated in the wrong direction.** The `hasOne` path reused the `belongsTo` correlation (`target.pk = parent.fk`) instead of `target.fk = parent.pk`, producing wrong rows (or type-mismatch errors when the parent column wasn't a key). Only `belongsTo` reverses the correlation now. (Also fixed in the SQL Server `FOR JSON PATH` path.)
- **Wide tables no longer hit Postgres's 100-argument limit in relation subqueries.** `json_build_object` takes 2 arguments per column, so relations targeting tables with >50 columns failed with `cannot pass more than 100 arguments to a function`. The Postgres dialect now chunks into `(jsonb_build_object(…) || jsonb_build_object(…))::json` concatenation.
- **`distinct` + `orderBy` no longer conflicts with Postgres's DISTINCT ON rule.** `SELECT DISTINCT ON (cols) … ORDER BY other_col` is rejected by Postgres unless the DISTINCT columns lead the ORDER BY. Turbine now orders by the distinct columns in an inner query and applies the user's `orderBy` in an outer wrapper. (`distinct` + vector `orderBy` throws a clear validation error instead of emitting broken SQL.)
- **Top-level `select` combined with `with` no longer drops the relation from the result *type*.** When a generated entity interface declares optional relation props, the with-key was also a `keyof T` and the select-narrowing `Pick` silently removed it, forcing users to drop `select` and over-fetch. The with-clause keys are now unioned back into the result type (and `omit` can no longer strip a relation the `with` clause populates). Compile-time regression tests included.

### Added
- **`npx turbine doctor`, missing-FK-index advisor.** Turbine loads `with` relations as correlated subqueries: the child table is probed once per parent row, so an unindexed FK column costs a full table scan *per parent*, pathological on large tables, and invisible on the ORMs people migrate from (batched `IN (ids)` loading pays a missing index only once, so those schemas routinely lack FK indexes). `doctor` introspects the database, derives every column set relations will probe (hasMany/hasOne child FKs, belongsTo reference keys, many-to-many junction keys), reports the unindexed ones sorted by table row count with the exact `CREATE INDEX` statement, and `--fix` writes a ready-to-apply migration. Measured on a production-shaped dataset: one missing FK index turned a 659-parent query into 659 sequential scans of a 357K-row table (17.8s); with the index the same correlated query ran in 62ms, *faster* than the batched equivalent (92ms).
- **Dev-mode missing-index warning.** In non-production, the first query that builds a relation subquery over an unindexed FK logs a one-time warning naming the relation, the table/columns, and the exact index DDL (only when the schema metadata actually carries index info, so `defineSchema`-only users see no false positives).
- **`relationLoadStrategy: 'join' | 'batched'`**, opt-in batched relation loading, as a client-level default (`TurbineConfig`) or per-query on `findMany`/`findFirst`/`findUnique`. `'batched'` runs the base query without `json_agg` subqueries, then one flat follow-up per relation (`WHERE fk = ANY($1)`, chunked at 1,000 keys) and stitches client-side, results are deep-equal to the join strategy (verified by integration tests running both). Useful when FK indexes are missing or result sets are huge (flat rows transfer leaner than nested JSON). Sibling relations and key chunks load concurrently (keys travel as one `ANY($1)` array parameter, chunked at 32K). Honors per-relation `where`/`select`/`omit`/`orderBy`/nested `with`; per-relation `limit` is applied client-side per parent. Transaction-safe (follow-ups run on the same connection). Measured on a production-shaped worst case (8,814 parents × 6 relation trees, unindexed FKs, WAN link): join strategy 6.5s, `batched` ~1.9s, roughly 2× faster than a leading batched-loader ORM's equivalent query (~3.7s) on the same data.
- **Implicit `is` on bare to-one relation filters (Prisma-compatible).** `where: { vendor: { name: { contains: 'x' } } }` now works without the explicit `is` wrapper; `is: null` / `isNot: null` compile to NOT EXISTS / EXISTS. `WhereClause` types to-many relation props as `some`/`every`/`none` filters and to-one props as bare-or-`is`/`isNot`.
- **Relation filters inside `with.where` and at any nesting depth.** A relation's `with … where` can now filter by the relation's own relations (`with: { items: { where: { stage: { is: { active: true } } } } }`), and relation filters recurse through `some`/`none`/`every`/`is`/`isNot` with `OR`/`AND`/`NOT` support at every level.
- **`jsonEncoding: 'positional'`**, opt-in lean wire encoding for `with` relations (Postgres-only, default `'object'` unchanged). Relation subqueries emit `json_agg(json_build_array(…))` instead of `json_build_object('key', …)`, so key names stop being repeated in every nested object of every row; ledger_entries are mapped back to keys client-side and parsed output is **byte-identical** to the object encoding (integration tests assert deep-equality under both). Measured on a 14-column hasMany relation: **39% fewer wire bytes** and ~13% faster end-to-end `findMany`, the win grows with column count and result size. Composes with everything (`select`/`omit`, ordered/limited relations, hasOne/belongsTo, m2m, nested trees); `relationLoadStrategy: 'batched'` simply bypasses it (no JSON aggregation there). `benchmarks/json-encoding-bench.ts` reproduces the numbers.

## 0.25.0 (2026-07-06)

### Added
- **`turbineHttp` now accepts your generated client type for fully typed accessors.** `turbineHttp(pool, SCHEMA)` returned the base `TurbineClient`, so the generated typed accessors (`db.users`, `db.posts`, …) were invisible to TypeScript on the serverless/edge path, you had to cast at the call site. It now takes a backward-compatible type parameter: `turbineHttp<TurbineClient>(pool, SCHEMA)` (passing your generated client type) gives the exact same typed accessors as the TCP-path `turbine()` factory, no cast. The runtime object is unchanged, the base constructor already materializes those accessors per schema table, and existing untyped calls keep working (default = base client). Caught on the serverless/edge path. (#30)

## 0.24.0 (2026-07-06)

**First-run fixes from a fresh Next.js app on 0.23.2 (#28).** Five papercuts that made the first-run experience worse than it should be, a silent empty `generate`, two rejected column types, doc drift, undocumented prereqs, and an inaccurate `serial` type. All fixed; the only behavior change is the `serial` mapping (below), which is safe for existing databases.

### Changed
- **`serial` now emits `SERIAL` (int4), not `BIGSERIAL` (int8), behavior change for NEW pushes.** A `serial` primary key was typed `number` but, being int8, read back over the wire as a **string** for large values, the generated type lied. `serial` now maps to `SERIAL` (int4), whose values fit in a JS `number` and are returned as numbers, so the type is accurate end-to-end. A new **`bigserial`** column type covers 64-bit auto-increment keys (int8; large values still read back as string, now documented). **Existing databases are unaffected:** `turbine push` / `migrate --auto` never auto-narrow a live column's integer width, so a `serial` column created as `BIGSERIAL` before 0.24.0 is left exactly as-is. Only brand-new `CREATE TABLE`s get `SERIAL`. (#28)

### Added
- **`bigserial`, `timestamptz`, and `jsonb` are now first-class `defineSchema` column types.** The docs' type table listed `timestamptz` and `jsonb`, but `defineSchema` rejected them; they now work. `timestamptz` is an explicit spelling of the timezone-aware timestamp Turbine already emitted for `timestamp`; `jsonb` is an explicit spelling of what `json` already emitted. Both aliases (`timestamp`, `json`) still work unchanged. (#28)
- **`TurbineConfig` is now exported as an alias of `TurbineCliConfig`** from `turbine-orm/cli`, matching what the docs import. (#28)
- **`turbine generate --allow-empty`** escape hatch for the two new guards below.

### Fixed
- **`turbine generate` no longer silently emits an empty client.** The `schema` config field is the Postgres schema *name* (default `public`), but the docs told users to put their schema *file path* there, so `generate` introspected `WHERE table_schema = './turbine/schema.ts'`, matched zero tables, and wrote an empty typed client with no error. `generate` now **errors (exit 1)** when `schema` looks like a file path (with a hint pointing at `schemaFile`) and when introspection matches **0 tables**. Pass `--allow-empty` to override. (#28)
- **Clearer CLI error for the CommonJS case.** When a project's `package.json` lacks `"type": "module"`, loading a `.ts` config/schema fails with Node's raw `ERR_REQUIRE_ESM`; the CLI now appends a hint to add `"type": "module"`. (#28)

### Docs
- **`USING-TURBINE-ORM.md` §0 corrected:** the config example used `schema: './turbine/schema.ts'` (should be `schema: 'public'` + `schemaFile:`) and `migrations:` (should be `migrationsDir:`). Added a **CLI prerequisites** section documenting that the CLI needs `tsx` installed and `"type": "module"` in `package.json`, with the exact error messages, neither is set by `create-next-app`. README quickstart updated to match. (#28)

## 0.23.2 (2026-07-03)

### Fixed
- **Published files no longer reference missing source maps.** `sourceMap`/`declarationMap` emitted `//# sourceMappingURL=…` comments in every published `dist/*.js` / `*.d.ts`, but the `files` allowlist excludes the `.map` files themselves, Node ignores the dangling reference, but Next.js/turbopack's stricter loader logged a failed-to-map warning on every stack trace through Turbine. Maps are now emitted only for local builds and never referenced from published output. (#25, #26)

### Changed
- `pg` dependency bumped 8.20.0 → 8.22.0 (upstream fixes; no API change). (#13)
- CI: actions/checkout 5 → 7, actions/setup-node 5 → 6; dev-dependency refresh. Docs site upgraded to Next 16 + Tailwind 4 with a real site-build CI gate, and the site's displayed version is now derived from the root `package.json` at build time (can't drift from the published package). (#4, #12, #23, #27)
- New docs page: **Turbine + BataDB guide** (`turbineorm.dev/batadb`), typed Turbine over BataDB's edge HTTP driver or direct TCP, with the dual-transport pattern. (#24)

## 0.23.1 (2026-07-03)

**Coordinated release with PowDB `0.8.0`**, the PowDB engine's optional peers now accept the newly published `@zvndev/powdb-client@0.8.0` / `@zvndev/powdb-embedded@0.8.0`, and the full test suite runs green against those exact published artifacts (1113 passing / 0 failing).

### Changed
- **Widened the PowDB optional-peer range to `^0.7.1 || ^0.8.0`** for both `@zvndev/powdb-client` and `@zvndev/powdb-embedded`, ahead of the coordinated PowDB `0.8.0` release. The engine surface Turbine uses (`query` / `write` / `tx` / `returning`) is unchanged in `0.8.0`, Turbine does not call `applyRetainedUnits`, so the widening is safe and additive. Both remain optional peers (`peerDependenciesMeta` unchanged); a default `npm i turbine-orm` still installs only `pg`.

### Fixed
- **CJS build now compiles under TypeScript 6.0.** `tsconfig.cjs.json` sets `ignoreDeprecations: "6.0"` for its `module: CommonJS` / `moduleResolution: node10` pairing, which TS 6.0 otherwise rejects as a hard error (`TS5107`). The `typescript` devDependency floor moves to `^6.0.3` so the option is recognized. Emitted `dist/` output is byte-identical to the previous toolchain (verified by a full `dist` diff); no runtime or API change.

## 0.23.0 (2026-06-29)

**PowDB Phase B, server-generated PKs, many-to-many, nested writes, composite-key upsert, plus a correctness fix for relation filters.** All PowDB-only; the four SQL engines are untouched and `npm i turbine-orm` still installs only `pg`.

### Fixed
- **Relation filters (`some`/`none`/`every`) no longer return stale results on PowDB (correctness, affects 0.22.0).** PowDB's executor caches an `in (<subquery>)` result by **plan shape, ignoring the literal**, so a second relation filter of the same shape with a different value returned the first query's rows (reproduced against the raw embedded addon, no Turbine). Turbine no longer emits an IN-subquery for relation filters: it **resolves the inner predicate to a literal key list** (`resolveRelationFilters`) and filters with `in (<list>)`, which is always correct. This covers hasMany / hasOne / belongsTo (the 0.22.0 shapes) and the new manyToMany filters, at every nesting level, on `findMany`/`findUnique`/`update`/`delete`/`count`/`aggregate`/`groupBy`. Trades one extra round-trip per relation filter for correctness. *(Reported upstream to PowDB; the SQL engines were never affected, they use real `EXISTS`/`json_agg`.)*

### Added
- **Server-generated / auto-increment primary keys.** New `ColumnMetadata.isGenerated` flag distinguishes a DB-assigned PK (serial / `IDENTITY` / PowDB `auto`) from a client-side default. On PowDB, `powqlSchemaDDL` now emits the **`auto`** modifier (`unique auto id: int`) for a generated int PK and `create`/`createMany` let the engine assign the id (read back via `returning`) instead of synthesizing a client UUID. Introspection sets the flag from `nextval(` / `is_identity`; the code generator emits it. **No change to the SQL engines**, the flag is additive and they already omit undefined PKs and rely on `RETURNING`.
- **many-to-many nested reads**, `with: { tags: true }` on a junction relation now loads through the junction (batched, chunked at 1,000 keys), with correct empty-array semantics and nested `where`/`with`.
- **many-to-many relation filters**, `where: { tags: { some/none/every } }` through a junction table.
- **Nested writes on PowDB**, relation ops in `create`/`update` data (`create`, `connect`, `connectOrCreate`, `disconnect`, `set`, `delete`, `update`, `upsert` for hasMany/hasOne/belongsTo) now run through the shared nested-write engine as **one flat top-level transaction** (PowDB is single-writer / no savepoints, so the whole tree commits or rolls back together). Same coverage as the SQL engines.
- **Composite-key upsert on PowDB**, PowQL's native `upsert … on .col` takes a single conflict column, so a composite PK now falls back to an atomic reselect-or-write transaction.
- Live `powdb-integration` coverage for every item above (6 new tests against the real embedded addon), plus build-only DDL tests for the `auto` modifier and the composite-PK fix.

### Changed
- **`powqlSchemaDDL` no longer marks each column of a composite PK individually `unique`.** PowDB has no composite-unique constraint (its `unique` is single-column), and per-column `unique` wrongly forbade, e.g., a member having two tags. Composite-PK columns are now `required` only; a single-column PK still gets `unique`.

### Still unsupported on PowDB (throws `UnsupportedFeatureError` / E017)
- Composite-key **relation filters** and **composite-key m2m** (PowQL has no tuple-`in` `(a,b) in (…)`), nested writes inside `createMany`/`upsert` (use `create`/`update`), and the unchanged Postgres-only set: pgvector, LISTEN/NOTIFY, RLS `sessionContext`, cursor streaming.

## 0.22.0 (2026-06-28)

**New engine: PowDB.** Turbine now runs on [PowDB](https://github.com/zvndev/powdb), a single-node embedded database with its own query language (PowQL, not SQL), behind the same `findMany` / `with` / `where` / `create` API. PowDB is the only engine that runs **both** in-process (embedded) **and** over a network client against the same data. Postgres remains the default and primary target; PowDB is an additive optional-peer subpath export, `npm i turbine-orm` still installs only `pg`.

### Added
- **`turbine-orm/powdb`**, `await turbinePowDB(target, schema, options?)`. Because PowQL shares no surface with SQL, this is **not** a `Dialect`: a parallel `PowqlInterface` (PowQL generator with the same public method surface as `QueryInterface`) is wired in via the new `queryInterfaceFactory` seam, leaving the four SQL engines byte-identical.
  - **Two transports.** Embedded (in-process) via the native addon `@zvndev/powdb-embedded`, and networked via `@zvndev/powdb-client` against a `powdb-server`. Both are optional peer dependencies (`^0.7.1`), loaded by dynamic `import()`, neither is pulled by a default install.
  - **Embedded durability control.** `turbinePowDB({ embedded, syncMode: 'full' | 'normal' | 'off', memoryLimit })` exposes PowDB 0.7.1's `setSyncMode` / `openWithMemoryLimit`. With `syncMode: 'normal'`, embedded writes drop ~440× (fsync off the commit path) and **beat SQLite** on `create` (0.009 vs 0.016 ms p50), `update` (0.008 vs 0.012), `createMany` (0.278 vs 1.197), and nested `with`, while keeping a real storage engine, indexes, and WAL. `syncMode` / `memoryLimit` are feature-detected; using them on a pre-0.7.1 addon raises a clear `ConnectionError`.
  - **Honest capability surface.** PowDB writes use the `reselect` strategy with client-assigned UUID PKs (PowDB generates no IDs), N+1 relation loaders (no `json_agg`, keys chunked at 1,000), single-writer transactions (no nesting), and code-defined schemas via `defineSchema` (no wire introspection). Not-yet-built capabilities throw `UnsupportedFeatureError` (`E017`): many-to-many relation filters/nested reads, composite-key relations/reads/upsert, nested writes, cursor pagination / `findManyStream`, JSON/array/full-text/pgvector filters and vector ordering, plus the Postgres-only trio (pgvector, LISTEN/NOTIFY, RLS `sessionContext`).
- **`/engines#powdb` docs**, a full PowDB section (both transports, `syncMode`, the embedded-beats-SQLite benchmark, the E017 list, and the platform-binary caveat), plus PowDB coverage in the README "Database engines" section and `benchmarks/CROSS-ENGINE-RESULTS.md`.
- **`src/test/powdb.integration.test.ts`**, 10 tests exercising the real embedded addon (gated via `skipGate` so the unit lane stays green without it) and wired to a new in-process `powdb-integration` CI job (live addon on Linux, no container).

### Fixed
- **Empty-`where` guard now gates on the compiled PowQL filter**, mirroring the SQL path, `{ OR: [] }` / `{ AND: [] }` / `{ NOT: {} }` / `{ OR: [{ field: undefined }] }` can no longer bypass the mass-mutation guard on `updateMany` / `deleteMany`.
- **Single-writer transaction model hardened.** A re-entrant or concurrent `db.$transaction` on the networked transport used to hang forever on PowDB's global write lock; a pool-level `activeTransaction` guard (both transports) now throws `E017` immediately. Nested `tx.$transaction` likewise throws (no savepoints).
- **Embedded driver errors are now typed.** Embedded addon failures (every one tagged `GenericFailure`) are mapped by message shape to the right Turbine error (`E010` not-null, `E003` type/parse, `E008` unique), and addon load/shape failures raise a typed `ConnectionError`.

### Notes
- **Platform binaries (embedded).** `@zvndev/powdb-embedded` 0.7.1 ships prebuilt binaries for darwin-arm64 and linux-glibc (x64/arm64); other platforms (musl/Alpine, Windows, Intel macOS) build from source at install. The networked transport has no such constraint. musl/Intel-mac prebuilts are tracked upstream for PowDB 0.7.2.

## 0.21.0 (2026-06-26)

**Multi-dialect: SQLite, MySQL, and SQL Server engines.** Turbine is still Postgres-first, but the query/result core is now engine-agnostic behind a dialect/driver seam, and three new engines ship as additive subpath exports. Drivers are optional peer dependencies, `npm i turbine-orm` still installs only `pg`.

### Added
- **`turbine-orm/sqlite`**, `turbineSqlite(path | ':memory:', schema)`. **Zero new dependency** via Node's built-in `node:sqlite` (Node ≥ 22.5; `better-sqlite3` is a documented fallback for older Node). Single-query nested `with` via `json_group_array`/`json_object` (with a `json()` subresult wrap so nested trees aren't double-encoded), `RETURNING` writes (SQLite ≥ 3.35), `PRAGMA`-based introspection, and savepoint-nested transactions. Runs **in-process**, its full integration suite executes against `:memory:` in the normal unit lane.
- **`turbine-orm/mysql`**, `turbineMysql(config | pool, schema)`. Optional peer `mysql2`; MySQL **8.0+** (enforced on connect). Nested `with` via `JSON_ARRAYAGG`/`JSON_OBJECT`. MySQL has no `RETURNING`, so writes use the new `reselect` strategy (execute, then re-fetch the row); `INSERT … ON DUPLICATE KEY UPDATE` upserts; `information_schema` introspection; `GET_LOCK` migration locking. `createMany` returns `[]` (rows are inserted; re-query if you need them).
- **`turbine-orm/mssql`**, `turbineMssql(config | pool, schema)`. Optional peer `mssql`. Nested `with` via a dedicated `FOR JSON PATH` generator; writes return rows via `OUTPUT` / `MERGE`; `OFFSET … FETCH` paging; `INFORMATION_SCHEMA` + `sys.*` introspection; `sp_getapplock` locking.
- **`/engines` docs page** with a per-engine capability matrix, plus a "Database engines" section in the README and CLAUDE.md.
- **E017 `UnsupportedFeatureError`**, thrown when a Postgres-only feature (pgvector, LISTEN/NOTIFY, RLS `sessionContext`) is invoked on an engine whose capability flag reports it unsupported, rather than failing with a confusing driver error.

### Changed
- **The `Dialect` contract became a real multi-engine seam**, `resultStrategy` (`returning` / `reselect` / `output`), a `TurbineDriver` driver abstraction (every `BEGIN`/`COMMIT`/`SAVEPOINT`/isolation/`set_config` literal now routes through the dialect), `DialectIntrospector`, and additive SQL hooks (`wrapJsonSubresult`, `aggSupportsInlineOrderBy`, `castAggregate`, `buildInClause`, `buildRelationSubquery`, `buildLimitOffset`, `buildUpdate`/`buildDeleteStatement`). **PostgreSQL output is byte-identical and unchanged**, engines that don't define a hook fall back to the exact prior SQL.
- Engine drivers (`mysql2`, `mssql`) are devDependencies + **optional** peerDependencies; the root runtime dependency set remains exactly `pg`. A CI `pack-smoke` check verifies each engine subpath imports with its driver absent, and new `mysql:8` / SQL Server 2022 CI service-container jobs run the real integration suites.

### Fixed
- **MySQL optimistic-lock conflicts now throw `OptimisticLockError`.** On the `reselect` path the version-checked UPDATE was followed by a re-fetch on `where` only (no version predicate), so a conflict silently returned the stale row. The conflict is now detected from the UPDATE's affected-row count, identical behavior to the `RETURNING`/`OUTPUT` engines.

### Also in this release (product-review sprint)
- **Repositioning + onboarding fixes:** README and landing now lead with the "safety bundle" (read-only Studio, PII-safe errors, one dependency, checksummed migrations). Fixed copy-paste-breaking docs: serverless `SCHEMA` casing (the generator now also emits a lowercase `schema` alias), the non-existent `db.$queryRaw` (→ `db.sql`/`db.raw`), `timeoutMs` → `timeout`, and the `withRetry()` "built-in" claim.
- **Security:** closed a LOW stored-XSS gap in the Observe dashboard (`row.model`/`row.action` now escaped); hardened the Studio/Observe token check to SHA-256 + `crypto.timingSafeEqual`.
- **Docs + tests:** new nested-writes, optimistic-locking, and framework-recipes pages; Studio security-perimeter tests (401/403/429/READ-ONLY).

## 0.20.0 (not released)

There is no 0.20.0. The version was reserved for a product-review sprint whose work was folded into 0.21.0 instead, so the line jumps 0.19.2 to 0.21.0. Nothing was published to npm under 0.20.0 and no entry is missing from this file.

## 0.19.2 (2026-06-10)

**Patch release from a full product review + gold-standard audit**, closes a HIGH silent-wrong-rows hole in the SQL cache, makes two documented-but-broken behaviors actually work, and brings the docs/site in line with what the library does.

### Fixed
- **`where`-key order can no longer cross-bind parameters on a warm SQL cache (HIGH).** The cache fingerprint sorted `where` keys, but the SQL-build and cache-hit param-collect paths iterated object-insertion order, so two queries with the same fields in different key order shared one cached SQL string but pushed parameters in different ledger_entries. `findMany({ where: { tenantId, id } })` followed by `findMany({ where: { id, tenantId } })` could execute the cached SQL with the values swapped, silently returning the wrong row (a cross-tenant-leak class when the permuted fields are same-typed). Key enumeration is now canonicalized (sorted) across every fingerprint/build/collect triple, top-level `where`, relation-filter sub-wheres (`some`/`every`/`none`), alias wheres, nested `with` relation order, cursor, and the `findUnique` simple (plain-equality) path. 14 regression tests warm the cache then assert each column binds its own value. Array members (`OR`/`AND`/`NOT`) remain positional.
- **`{ equals: value }` works as plain equality on any column.** `where: { email: { equals: 'a@b.com' } }`, documented in the README and the most common operator a migrating Prisma user reaches for, previously threw `ValidationError` because `equals` was treated only as a JSONB filter key. It now compiles to `"col" = $n` (and `{ equals: null }` to `IS NULL`), parameterized, on the build path, the cache-hit path, and relation filters, while JSON/JSONB columns keep their existing containment behavior.
- **Nested-write input types are now real.** The exported `NestedCreateOp` / `NestedUpdateOp` / `ConnectOrCreateOp` types were referenced by zero code, `create({ data })` was typed as `Partial<T>` so the `create`/`connect`/`connectOrCreate`/`update`/`upsert`/`disconnect`/`delete` relation ops the runtime already supported were invisible to TypeScript. `CreateArgs`/`UpdateArgs` are now generic over the target's relations and surface the full nested-write op palette (matching `nested-write.ts` exactly), recursively, via the same `RelationDescriptor` brand that powers `with` inference. Untyped clients collapse to the old `Partial<T>`, so nothing breaks; generated clients get typed nested writes with no generator changes.

### Changed
- **Middleware docs no longer teach a silently-broken soft-delete pattern.** The README, the `$use` JSDoc, and the site `/queries` + `/observability` pages showed middleware mutating `params.args.where` to inject `deletedAt: null`, which does nothing, because SQL is generated before middleware runs. Replaced with working patterns (query timing, result transformation) plus an explicit "`params.args` is a read-only snapshot" warning, and the soft-delete recipe is now an explicit `where` filter / scoped helper.
- **New docs: `/studio` and `/observability` pages.** Studio (the flagship read-only-Studio differentiator) and the `$observe()` / `$on('query')` / `npx turbine observe` observability surface were undocumented on the site; both now have full pages, in the sidebar and sitemap, with the security model spelled out.
- **`/queries` documents `cursor`, `take`, and `distinct`; benchmarks page carries a measurement-vintage caveat; homepage repositioned** around Postgres-native depth (pgvector, RLS, LISTEN/NOTIFY, full-text) with a side-by-side pgvector comparison, since single-query nested relations are now table stakes across ORMs. Bundle-size claims corrected to the measured ~31 kB (main) / ~22 kB (edge) brotli.
- **CLI help completed.** `turbine observe` and the `migrate create --auto` / `--allow-drift` / `--step` flags are now in `--help`; column alignment fixed.

### Errors
- Site `/errors` page now documents **E015 `OptimisticLockError`** and **E016 `ExclusionConstraintError`** (they shipped in 0.15.0 / 0.18.0 but were never added to the page), and the `check-error-codes` CI gate, which had silently failed since 0.15.0 because its known-classes list was missing both, passes again.

### Tooling / CI
- DB-gated integration tests now report as **skipped** (via a `skipGate()` helper) instead of silently passing 0 tests when `DATABASE_URL` is unset.
- `test:unit` is now a glob instead of a hand-maintained file list (new test files can no longer be silently dropped from the release gate); `test:watch` watches the full suite.
- `npm audit` is a hard gate on production deps (`--audit-level=high`); the YugabyteDB integration job moved from per-PR to a nightly cron (pinned image) to stop burning ~6 min of red CI per push; new `pack-smoke` job installs the built tarball and verifies ESM/CJS/CLI/serverless; `release.yml` gained a post-publish smoke test and skips publishing a version that already exists on npm.
- Added `SECURITY.md` supported-versions refresh, `.github/dependabot.yml`, dead-code removal (`isReadOnlyStatement`, orphaned Studio CSS), and a CLAUDE.md architecture/LOC sync. Backfilled git tags for v0.11.0–v0.14.0 and v0.16.0 (published to npm without tags).

## 0.19.1 (2026-06-09)

**Patch release fixing everything found by the v0.19.0 post-release audit**, most importantly a broken new-user CLI happy path and two remaining silent-wrong-rows holes in the query builder.

### Fixed
- **CLI can load its own scaffolded `turbine.config.ts` again (HIGH).** `turbine init` scaffolds TypeScript files, but every subsequent command failed on current Node: the loader called `module.register('tsx/esm', …)`, which tsx rejects with "tsx must be loaded with --import instead of --loader" on every Node version that has `module.register()`, and the bare catch misreported it as "tsx is not installed", so following the suggested fix didn't help. The loader now uses tsx's supported programmatic API (`tsx/esm/api` `register()`, with a `module.register` fallback only for pre-4.0 tsx), and when registration genuinely fails the CLI reports the real underlying error (new `failed` status) instead of misdiagnosing. `turbine init` also notes the tsx requirement in Next Steps when tsx isn't installed. Verified end-to-end against the built CLI in a clean project.
- **The v0.19.0 unknown-operator guard no longer has a cache-hit bypass (HIGH).** The guard ran only in `buildWhereClause` (the cache-miss path); once an equality query warmed the SQL cache for a field set, a misspelled operator (e.g. `startWith`) flowed through `collectWhereParams` unguarded and executed `col = $1` with the operator object as the value, silently returning wrong rows, the exact bug 0.19.0 headlined as fixed. The guard now runs on **both** the build and param-collect paths (shared `assertBindableEqualityValue`), and unmatched plain objects fingerprint distinctly from equality (`key:obj(...)` vs `key:eq`) so they can never share a cache entry. The same guard now also covers relation-filter sub-wheres (`some`/`every`/`none`). Regression tests warm the cache with equality before asserting the throw.
- **Nested relation `where` now supports the full scalar filter surface (HIGH).** `with: { posts: { where: … } }` was equality-only on the server: operator objects were bound as literal values (silent zero/wrong rows) and `OR` produced `Unknown column "OR"`, while the Studio Query tab offered the full operator palette at every nesting level. Relation `where` (hasMany, belongsTo/hasOne, and manyToMany) now supports operator objects (`gt`/`gte`/`lt`/`lte`/`not`/`in`/`notIn`/`contains`/`startsWith`/`endsWith` + `mode: 'insensitive'`), `null` (IS NULL), and `OR`/`AND`/`NOT` combinators, fully parameterized against the relation alias, mirrored on the cache-hit param-collect path, with shape-aware `with`-fingerprinting (an equality where and an operator where can no longer share a cached SQL string). Misspelled operators in nested wheres throw the same `ValidationError` as top-level ones.
- **The operator guard no longer rejects class-instance equality values.** `where: { data: Buffer.from(…) }` on a `bytea` column threw `Unknown operators "0", "1"…` (and Decimal-style wrappers on numeric columns likewise). Only *plain object literals*, the actual typo shape, throw now; Buffers, Dates, arrays, and other class instances bind as values, consistently on both cold and cached paths.
- **`limit: 0` / `orderBy: {}` on a to-many relation no longer corrupt the query.** `limit: 0` took the wrapped-subquery path but skipped the LIMIT clause (truthiness vs `!== undefined` mismatch), silently dropping nested relations; `orderBy: {}` rendered a dangling `ORDER BY `. `limit: 0` now renders a real `LIMIT $n` (empty array result) and `orderBy` with no defined entries is treated as absent, on both hasMany and manyToMany, build and collect paths.
- **Studio's Query tab now respects `--schema`.** `/api/builder` ran unqualified SQL resolved via the connection's `search_path`, so with `--schema acme` the Data tab read `acme.users` while the Query tab silently read `public.users`. The builder transaction now pins `set_config('search_path', $1, true)` to the configured schema.
- **`npx turbine --version` prints the version again.** Via the `node_modules/.bin/turbine` symlink the package-root walk started in the consumer's tree and never found turbine-orm's package.json; the path is now `realpathSync`-resolved first.
- **`turbine init`'s example schema is now valid.** The scaffold used `type: 'timestamptz'`, which `defineSchema` rejects (the valid name is `timestamp`, which maps to TIMESTAMPTZ).
- **`new TurbineClient(config)` without schema metadata fails fast** with an actionable `ValidationError` pointing at `turbine generate`, instead of an opaque `TypeError: Cannot read properties of undefined (reading 'tables')`.

### Changed
- **README/docs caught up with the v0.19.0 Studio.** The npm README still documented the removed raw-SQL tab, SQL saved queries, the dead SELECT/WITH-only parser, and the pre-0.17.0 `SET LOCAL` timeout form. README, site docs (`/cli`, `/compatibility`, `/transactions`), CLAUDE.md, and the `studio.ts` header now describe the ORM-native reality, the security headline is "no SQL input surface at all". Site version strings (homepage hero, docs sidebar) now come from a single `site/lib/version.ts` instead of being hardcoded per page.
- **Legacy raw-SQL saved queries are dropped with a console notice** when Studio loads `.turbine/studio-queries.json`, instead of silently (the file isn't rewritten until a new query is saved, so the entries remain recoverable).
- **`npm run build` cleans `dist/` first.** The 0.19.0 tarball shipped ~286 kB of stale compiled artifacts from the long-deleted `src/query.ts`.
- **Missing public type exports added**: `WhereClause`, `WhereOperator`, `WhereValue`, `HavingClause`, and `MiddlewareFn` are now importable from the package root (previously `import type { WhereClause } from 'turbine-orm'` failed with TS2305 and there was no deep-import escape hatch).

### Tests
- New suite `where-guard-cache-and-relation-where` (28 tests: cache-warm bypass regressions, Buffer/class-instance equality, nested-relation operator/combinator SQL + param alignment + cache-hit parity, `limit: 0`/`orderBy: {}` edge cases). `relation-limit-param` and the new suite added to `test:unit` (the former had been missing from the list, part of why the cache bypass shipped green). Full suite: 1251 passing, 1 skipped, 0 failures (incl. live-DB integration).

## 0.19.0 (2026-06-09)

**Studio goes ORM-native, plus two correctness fixes to the query builder.** Studio no longer has a raw-SQL surface, every query is composed visually in Turbine ORM and previewed as the exact `findMany` call you'd write. Two query-builder bugs are fixed, one of which silently returned wrong data.

### Changed
- **Studio is now ORM-native** (`src/cli/studio.ts`, `src/cli/studio-ui.html`). The raw-SQL tab, its `/api/query` endpoint, and SQL-kind saved queries are gone. The default (and only) authoring surface is the visual **Query** composer, a `findMany` builder that drills into relations (`with`) recursively to any depth, picking fields (`select`/`omit`), filters (`where`), and `orderBy`/`limit` at every level, with a live TypeScript preview to copy into your code. Tabs are now **Query / Data / Schema**. `orderBy`/`limit` controls are hidden for to-one relations (they always resolve to a single row). Saved queries are builder-only; legacy raw-SQL entries are dropped on load. Polish: system font stack (no external font fetch / CSP violation), `204` favicon, `reltuples` row estimates clamped to ≥ 0.

### Fixed
- **Unknown `where` operators now throw instead of silently returning wrong rows.** A misspelled operator (e.g. `startWith` for `startsWith`, or any unrecognized key) previously fell through to plain equality, `col = $1` with the operator object as the value, quietly returning zero/wrong rows with no error. The WHERE builder now throws `ValidationError` for any plain object on a non-JSON column that matches no known filter shape, naming the offending key(s) and listing supported operators. JSON/JSONB column equality is unaffected. `orderBy` on an unknown field and `select`/`omit` passed as an array (instead of the `{ field: true }` object) now produce the same `[turbine]` + "Known fields" error format.
- **`limit` on a to-one relation no longer crashes the query.** A `with` clause on a `belongsTo`/`hasOne` relation that carried a `limit` (e.g. `with: { author: { limit: 10 } }`) pushed the limit value as a parameter but rendered a literal `LIMIT 1`, leaving an orphaned, untyped `$N` that Postgres rejected with `could not determine data type of parameter $1` (and shifting every later placeholder). To-one relations now ignore `limit` entirely on both the SQL-build and param-collect paths; `hasMany`/`manyToMany` are unchanged.

### Tests
- New suites: `relation-limit-param` (parameter/placeholder alignment, including the to-one-limit regression) and expanded `operator-validation` (misspelled/unknown operators, empty filter objects, orderBy + select/omit shape). Full suite: 1223 passing, 1 skipped, 0 failures (incl. live-DB integration).

## 0.18.0 (2026-06-08)

**Feature release: aggregate filtering, a typed raw-SQL escape hatch, many-to-many + self-relations, pgvector similarity search, RLS session context, and LISTEN/NOTIFY realtime.** This is also the first npm release to carry the 0.17.0 release-readiness fixes below (0.17.0 was tagged in the changelog but never published).

### Added
- **`groupBy` HAVING**, filter aggregate groups with a `having` clause: `groupBy({ by: ['userId'], _count: true, having: { _count: { gt: 1 } } })`, or filter on a column aggregate via `having: { viewCount: { _sum: { gte: 100 } } }`. Supports `_count`/`_sum`/`_avg`/`_min`/`_max` with operators `gt`/`gte`/`lt`/`lte`/`in`/`notIn` (a bare number is shorthand for equality). HAVING params continue the WHERE param numbering; every value is bound as `$N`. Unknown columns or operators throw `ValidationError` before any SQL is built.
- **Typed raw SQL, `db.sql<T>`** (`src/typed-sql.ts`), a typed escape hatch alongside `db.raw`: ``db.sql<{ id: number; name: string }>`SELECT id, name FROM users WHERE id = ${id}` `` returns `T[]` when awaited, `.one()` returns `T | null`, and `.scalar<V>()` returns the first column of the first row or `null`. Every `${value}` is bound as a `$N` parameter, injection payloads become data, never SQL.
- **Many-to-many through junction tables** (`buildManyToManySubquery` in `src/query/builder.ts`), `generate` auto-detects *pure* junction tables (exactly two single-column FKs forming a two-column PK, no payload columns) and adds a `manyToMany` relation to both endpoints, loadable via `findMany({ with: { tags: true } })` with nested `where`/`orderBy`/`limit`. Composite-key junctions supported. Junctions carrying payload columns stay ordinary `hasMany` (by design). For non-pure or hand-built junctions, declare them in a code-first schema via `manyToMany: [{ name, target, through, sourceKey, targetKey, references? }]` (`applyManyToManyRelations` / `ManyToManyDef` in `src/schema-builder.ts`).
- **Self-relations**, a self-referencing FK (e.g. `categories.parent_id → categories.id`) introspects to a `belongsTo` + a `hasMany` on the same table, queryable as nested `parent`/`children` trees at arbitrary depth. Each `buildRelationSubquery()` call allocates a fresh alias, so parent and child references never collide. A lone self-FK auto-names the `belongsTo` for the singular table and the `hasMany` for the table.
- **pgvector similarity search** (`VectorFilter` / `VectorOrderBy` in `src/query/types.ts`), KNN ranking via `orderBy: { embedding: { distance: { to: number[], metric: 'cosine', direction?: 'asc' | 'desc' } } }`, and distance WHERE filtering via `where: { embedding: { distance: { to, metric: 'l2', lt: 0.3 } } }` (`lt`/`lte`/`gt`/`gte`). Metrics `l2`/`cosine`/`ip` map to `<->`/`<=>`/`<#>`. The query vector is bound as `$n::vector`. Non-number elements, NaN/Infinity, unknown metrics, and distance ops on non-vector columns all throw `ValidationError`. Requires the pgvector extension + a `vector` column.
- **RLS session context** (`$transaction` `sessionContext` + `$withSession` in `src/client.ts`), `db.$transaction(fn, { sessionContext: { 'app.current_tenant': id } })` applies each entry as `SELECT set_config(name, value, true)` after `BEGIN`, so Postgres RLS policies using `current_setting()` filter rows per transaction (the GUC auto-resets on commit). Values may be string/number/boolean. `db.$withSession(ctx, fn)` is the single-purpose shorthand. Invalid setting names throw `ValidationError` and roll the transaction back before any query runs.
- **LISTEN/NOTIFY realtime** (`src/realtime.ts`, `$listen`/`$notify` in `src/client.ts`), `const sub = await db.$listen('channel', (payload) => { ... })` subscribes on a dedicated connection (requires a persistent pool; not available over serverless HTTP drivers), `await db.$notify('channel', 'msg')` publishes in one round-trip (works everywhere), and `await sub.unsubscribe()` issues `UNLISTEN`. Channel names are validated as plain identifiers; the payload is bound as a parameter and delivered to the handler as a string. `disconnect()` force-releases open subscriptions.

### Tests
- Full suite: 1208 passing, 1 skipped (pgvector live assertions, extension-gated, skipped, not failed, when the `vector` extension is unavailable), 0 failures.
- New suites: `group-by-having`, `typed-sql`, `many-to-many`, `self-relation`, `pgvector`, `rls-session`, `realtime`. Each pairs build-only SQL/parameterization assertions (no DB) with `DATABASE_URL`-gated integration coverage against bootstrapped, isolated tables.

### Docs
- README: added typed-SQL (`db.sql<T>`), groupBy HAVING, RLS session-context, and LISTEN/NOTIFY subsections under Usage Examples; a new "Vector search (pgvector)" section; many-to-many and self-relation examples in the relations content; and Many-to-many / Vector search / LISTEN/NOTIFY rows in the Comparison table.

---

## 0.17.0 (2026-06-06)

**Release-readiness pass: two correctness fixes, the PII-safe error guarantee made real, honest footprint numbers, and a size gate that measures something.**

### Fixed
- **Studio is no longer broken on plain PostgreSQL (CRITICAL).** Every Studio data/query request issued `SET LOCAL statement_timeout = $1`, which Postgres rejects (`SET` does not accept bind parameters), so each query 500'd with `syntax error at or near "$1"`. The CockroachDB/YugabyteDB adapters had the same flaw. All now use `SELECT set_config('statement_timeout', $1, true)`, the parameterizable transaction-local form. The unit test mocked the pool and never sent the SQL to a real server, so the bug shipped green; a new integration test (`studio-timeout-integration`) runs the real SQL against a live connection.
- **`UniqueConstraintError` and other constraint errors no longer leak row values (CRITICAL).** The error `.message` unconditionally appended Postgres's raw `detail` string (e.g. `Key (email)=(alice@x.com) already exists.`), contradicting the documented "PII-safe, never the actual user data, safe to log" guarantee. The raw `detail` is now only appended in `verbose` mode; in the default `safe` mode the message carries column/constraint/key names only. Structured fields (`.columns`, `.column`, `.constraint`) and `.cause` still expose full detail for programmatic use. Applies to E008/E009/E010/E011/E016.
- **belongsTo nested writes with a NOT NULL foreign key now work (HIGH).** `posts.create({ data: { …, user: { connect/create/connectOrCreate } } })` previously inserted the parent row before setting the FK (via a follow-up UPDATE), failing the NOT NULL `user_id` constraint on the initial INSERT. belongsTo relations are now resolved before the parent INSERT and their FK folded into it. The hasMany direction is unchanged. New integration coverage exercises all three belongsTo ops.

### Changed
- **Honest footprint claims.** The README/package description previously headlined "~110 KB" and contrasted it with "Prisma's 1.6 MB WASM", but that compared a minified bundle against an unpacked install (Turbine's own unpacked install is ~1.7 MB). Claims are now led by the true, durable differentiator, **one dependency, no WASM engine**, with correctly-labeled bundle figures (~27 KB brotli main entry, ~19 KB edge).
- **`size-limit` now measures the real bundled import graph** (`@size-limit/esbuild`) instead of the 2.6 KB barrel file, so the gate guards an actual number. Limits: 35 kB main, 25 kB edge.
- **`exports` map now lists `types` first** in each conditional export so TypeScript resolves declarations correctly under all module-resolution modes.

### Added
- `@types/pg` is now a runtime dependency, Turbine's public `.d.ts` re-exports `pg` types, so strict consumers (`skipLibCheck: false`) no longer hit `TS7016`.

### Tests
- Full suite: 1127 passing against a live database (0 failures). New regression tests: belongsTo nested-write integration (3), studio statement-timeout integration (3), PII-safe constraint-error messages (4).
- `test:coverage` now runs the full unit set (it had drifted to a stale ~20-file subset that left `nested-write.ts`/`observe.ts` near-uncovered, failing the gate at 69.6% functions). Coverage now passes: lines 78%, functions 83%, branches 86%.

### Docs
- `SECURITY.md` supported-versions table updated (was stuck at 0.5.x/0.6.x). README error-code list extended to E016. README full-text-search note corrected (the `search` filter shipped in 0.15). `CONTRIBUTING.md` architecture tree updated to the `src/query/` submodule split. `CLAUDE.md` coverage thresholds and seed-dataset sizes corrected. Benchmark results dated and version-caveated (measured on 0.7.1; core read path unchanged).

---

## 0.16.0 (2026-05-18)

**Feature release: observability, nested write update/upsert, is/isNot relation filters, cursor pagination tests, Neon guide.**

### Added
- **Event emitter**, `db.$on('query', fn)` and `db.$off('query', fn)` fire after every query with SQL text, params, duration, model, action, and row count. Param redaction in safe mode. Listener errors never crash queries.
- **Observability module**, `db.$observe({ connectionString })` buffers per-minute aggregated metrics (count, avg, p50, p95, p99, errors) and flushes to a dedicated `_turbine_metrics` table in a separate database. Non-blocking (fire-and-forget), 1-connection pool, configurable retention. Auto-starts from `TURBINE_OBSERVE_URL` env var.
- **`turbine observe` CLI**, local read-only dashboard for viewing query metrics. Same security model as Studio (loopback binding, 192-bit token, HttpOnly cookies, CSP, X-Frame-Options: DENY). Dark-theme SVG charts, top models table, error rates, time range selector.
- **Nested write `update`**, `{ posts: { update: { where: { id: 1 }, data: { title: 'new' } } } }` in `update()` context. Array form supported. BelongsTo derives where from parent FK automatically.
- **Nested write `upsert`**, `{ posts: { upsert: { where: { id: 1 }, create: {...}, update: {...} } } }`. Checks existence, creates with FK injection or updates.
- **`is`/`isNot` relation filters**, for to-one relations (belongsTo/hasOne): `where: { author: { is: { name: 'Alice' } } }`. Generates EXISTS/NOT EXISTS subqueries.
- **Neon guide**, `/neon` page on turbineorm.dev: "Turbine + Neon in 60 Seconds" covering install, generate, Node.js + serverless connections, migrations, and why Turbine on Neon.

### Fixed
- All Biome lint violations resolved, `npm run lint` now exits clean.

### Tests
- 812 unit tests (up from 711), all passing.
- Added test suites: `event-emitter` (10), `observe` (12), `nested-write-update-upsert` (15), `is-isNot-filter` (6), `cursor-pagination` (7), `client-branches` (17).

---

## 0.15.0 (2026-05-17)

**Feature release: select/omit type narrowing, optimistic locking, full-text search, retry utility, security hardening.**

### Added
- **Select/omit compile-time type narrowing**, `findMany`, `findUnique`, `findFirst` accept `select` and `omit` args that narrow the return type at compile time via `QueryResult<T, R, W, S, O>`. Preserves `with` relation additions while narrowing base entity fields.
- **Optimistic locking**, `update({ optimisticLock: { field: 'version', expected: 3 } })` auto-increments the version field and throws `OptimisticLockError` (E015) on concurrent modification.
- **Full-text search**, `TextSearchFilter` type with `search`, `config`, and `language` options. Generates `to_tsvector @@ plainto_tsquery` SQL with injection protection.
- **Retry utility**, `withRetry(fn, opts)` and `db.$retry(fn, opts)` with exponential backoff + jitter. Only retries errors marked `isRetryable` (deadlocks, serialization failures).
- **`ExclusionConstraintError`** (E016), maps pg error code 23P01 via `wrapPgError()`.
- **SQL safety property tests**, 22 injection payloads verified against WHERE, UPDATE SET, and CREATE SQL generation.
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
- **`docs/NEXT-INTEGRATIONS.md`**, post-v1.0 dialect roadmap. Tier 1:
  CockroachDB (~1 engineer-week, PG-wire already compatible) and MySQL
  (4–6 weeks as `turbine-orm/mysql` subpath). Tier 2: SQLite (3 weeks; also
  wins internal CI speed). Tier 3 skip: SQL Server (engineering cost too high,
  audience already captured by TypeORM), MongoDB (philosophical mismatch).
  Tier 4 declined: PowDB (custom binary wire protocol, no SQL, no `json_agg`,
  no `information_schema`, revisit when PG-wire compat layer ships).
- **`docs/USING-TURBINE-ORM.md`**, 19-section full DX reference covering
  schema / client / reads / where / with / writes / transactions / pipeline /
  streaming / raw SQL / errors / CLI / migrations / Studio / testing /
  deployment / intentional non-features. Each section includes port notes
  for building a similar TypeScript client against another database.

### Contributor DX
- **`scripts/seed-test-db.sh` + `scripts/docker-compose.yml`**, one-command
  Postgres seed for the integration-test database (throwaway Docker Compose
  on port 54329, benchmark seeder on first run). `CONTRIBUTING.md` updated
  with the new path.
- **`.c8rc.json`**, scope comment added (why `cli/`, `generate.ts`,
  `introspect.ts`, `serverless.ts`, `index.ts` are excluded) and thresholds
  raised: lines 57→65, functions 64→70, statements 57→65, branches 80→82.

No runtime changes. 530/530 unit tests pass.

## 0.9.1 (2026-04-10)

**Docs + tests patch.** Restores accurate messaging around deep `with`-clause
type inference (shipped since 0.7.1) and locks in the end-to-end inference
path with compile-time assertions. No runtime changes, `WithResult`,
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
  and the generator's `RelationDescriptor`-branded `*Relations` interfaces -
  the 0.9.0 README was wrong, not the runtime.
- **CLAUDE.md "Type System" section** corrected: removed the stale "Current
  limitation: `with` clause return types do not reflect included relations
  at the type level" paragraph (a pre-0.7.1 artifact) and replaced it with
  an accurate architecture note covering `TypedWithClause`, `WithResult`,
  `RelationDescriptor`, and `ApplyCardinality`.

## 0.9.0 (2026-04-09)

**Studio Premium.** Turbine now ships a premium, read-only Studio web UI, the
only Postgres ORM with a Studio your DBA will approve. Loopback-bound by
default, random per-process auth token, every query runs inside
`BEGIN READ ONLY` + `SET LOCAL statement_timeout = '30s'`, and a strict
SELECT/WITH parser blocks statement stacking. No mutations, no writes, no way
around the transaction guard, the posture is unchanged from 0.8.0 and a
product review (8.1/10) found zero CRITICAL or HIGH vulnerabilities.

### Added
- **Premium Studio UI** with Data / Schema / SQL / Builder tabs, a
  single-file embedded HTML/CSS/JS bundle served by the CLI `turbine studio`
  command, matching the turbineorm.dev dark theme.
- **Cmd+K command palette** for fast navigation across tables, tabs, and
  saved queries.
- **Saved queries**, named SQL snippets persisted to
  `.turbine/studio-queries.json` and surfaced in the SQL tab and command
  palette.
- **Visual query composer** (Builder tab) with live TypeScript preview -
  pick a table, compose `where` / `orderBy` / `with` / `limit` visually, and
  watch the matching `db.table.findMany(...)` code render in real time.
- **Full-text search across table rows**, the Data tab now supports
  substring search across every text column via a `search` query parameter.
- **Sortable tables, JSON modal, toasts, keyboard shortcuts**, every data
  table is column-sortable; JSON/JSONB cells open in a full-screen modal;
  toast notifications confirm saves/errors; keyboard shortcuts for tab
  switching, row navigation, and query execution.
- **Four new backend endpoints:** `/api/builder` (preview SQL for a visual
  composer payload), `/api/saved-queries` (GET/POST/DELETE), and a `search`
  query parameter on `/api/tables/:name`.
- **CLI flag smoke test** (`src/test/cli-flags.test.ts`), locks in every
  `turbine studio` flag (`--port`, `--host`, `--no-open`) against the
  argument parser.

### Changed
- **Migration advisory lock ID is now derived from the database name via
  FNV-1a**, fixes cluster-wide contention when two databases on the same
  Postgres cluster both run `turbine migrate up` concurrently. The previous
  implementation used a static lock ID, so a migration in database A would
  block a migration in database B. Lock ID is now a stable per-database
  32-bit FNV-1a hash of `current_database()` (top bit cleared for positive
  `int4`, matching Postgres advisory-lock semantics).
- **README Studio section rewritten** to headline read-only as a design
  feature, not a limitation. The old "Turbine Studio is planned but not yet
  available" bullet under Limitations has been removed.

### Fixed
- Two `any` leaks in `src/schema-builder.ts` public signatures, the
  column definition builder now exposes precise generic types end-to-end.
- Search endpoint parameter-index bug in `/api/tables/:name`, the search
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
- **`pipelineSupported(pool)`** public probe, check at runtime whether a pool
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
- **`DeadlockError`** (`TURBINE_E012`) and **`SerializationFailureError`** (`TURBINE_E013`), both expose `isRetryable: true` for safe automatic retry on Postgres `40P01` and `40001` sqlstates. Surfaced through `wrapPgError()` at every query chokepoint.
- **Composite primary keys:** `defineSchema()` now accepts a table-level `primaryKey: ['col1', 'col2']` field. The DDL generator emits a `CONSTRAINT ... PRIMARY KEY (col1, col2)` and the typed `findUnique` accepts the composite key as an object.
- **Deep `with`-clause type inference:** the `WithResult` mapped type now recurses through arbitrarily nested `with` clauses, so `db.users.findMany({ with: { posts: { with: { comments: true } } } })` narrows the return type to `User & { posts: (Post & { comments: Comment[] })[] }` without manual assertions.
- **Typed `TransactionClient` table accessors:** the `tx` argument inside `$transaction(async (tx) => ...)` now exposes the same `tx.users` / `tx.posts` typed accessors as the top-level client. Generated clients emit a typed `TransactionClient` subclass alongside the main `TurbineClient` subclass.
- **Atomic update operator types in generated `*Update` interfaces:** numeric fields now allow `{ increment | decrement | multiply | divide | set: number }` at the type level, matching the runtime behaviour shipped in 0.6.2.
- **`findMany` unlimited-query warning:** `findMany` calls without a `limit` (and no `defaultLimit` configured) now emit a one-time warning per table. Disable with `warnOnUnlimited: false` in `TurbineConfig`.
- **Strict operator validation:** JSONB-only operators (`hasKey`, `path`) and array-only operators (`has`, `hasEvery`, `hasSome`) now throw `ValidationError` when applied to columns of the wrong Postgres type, instead of silently generating broken SQL.
- **`$transaction` timeout cleanup:** when a transaction exceeds its `timeout`, Turbine now destroys the underlying connection rather than returning it to the pool, freeing the slot immediately.
- **WHERE Operator Reference** in README, every operator (equality, sets, comparison, string, relation, array, combinators) with a one-line description and example.
- **Prisma migration guide** at `docs/migrate-from-prisma.md`, API mapping table, side-by-side `findMany` example, and notes on the differences (`include` -> `with`, code-first schema, typed errors, edge support).
- **Four serverless example apps** under `examples/`: `neon-edge` (Neon on Vercel Edge), `cloudflare-worker` (Hyperdrive + `pg`), `vercel-postgres` (`@vercel/postgres` on the Next.js app router), and `supabase` (direct `pg` to Supabase). Each is self-contained with `schema.ts`, entrypoint, `package.json`, and a setup README.

### Fixed
- **CLI `turbine push` failed on `.ts` schema files:** the loader now registers `tsx`/`tsm` as needed before importing the schema module, so `npx turbine push --schema ./schema.ts` works without a manual loader flag.
- **README contradicted runtime on atomic update operators:** the "no incremental updates" bullet under Limitations falsely claimed `{ count: { increment: 1 } }` was unsupported. Atomic operators have shipped since 0.6.2, bullet removed and a worked example added under Usage Examples.
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
- New `TurbineConfig.pool` option, pass an external pg-compatible pool and Turbine will route all queries through it instead of creating its own `pg.Pool`. `disconnect()` is a no-op for externally-owned pools.
- New public subpath export: `turbine-orm/serverless` (both ESM and CJS).
- **`with`-clause type inference:** optional second type parameter `QueryInterface<T, R>` surfaces included relations at the type level. Generated clients now emit `{Entity}Relations` interfaces, so `db.users.findMany({ with: { posts: true } })` narrows the return type to include `posts: Post[]`.
- New exports: `TypedWithClause`, `WithResult`, `PgCompatPool`, `PgCompatPoolClient`, `PgCompatQueryResult`, `turbineHttp`, `TurbineHttpOptions`.

### Changed
- **`serverless.ts` rewritten:** the old custom HTTP-proxy protocol (which required a nonexistent Turbine proxy server) is gone. It is replaced with a thin, driver-agnostic factory that binds any pg-compatible pool to a schema. No new runtime dependencies.
- `TurbineClient.stats` now returns zeros for pools that don't expose connection counts (HTTP drivers), instead of `undefined`.
- `pg.types.setTypeParser(20, ...)` registration is now skipped when Turbine is given an external pool, prevents Turbine from mutating global state owned by the external driver.

### Tests
- 308 unit tests passing (up from 254).
- New test file: `src/test/serverless.test.ts`, 9 tests covering external pool integration, transaction routing, lifecycle ownership, and error propagation via a mock `PgCompatPool`.
- New test file: `src/test/pipeline.test.ts`, 5 tests covering `executePipeline`: BEGIN/COMMIT wrapping, transform ordering, ROLLBACK on failure, parameter passing, and empty-input short-circuit.

### Docs
- README: new "Serverless / Edge" section with Neon, Supabase, and Vercel Postgres examples.
- `src/serverless.ts`: extensive JSDoc covering supported drivers, limitations over HTTP (streaming cursors, LISTEN/NOTIFY), and full usage examples for Neon on Vercel Edge and Cloudflare Workers.

## 0.6.3 (2026-04-07)

### Security
- **SSL/TLS support:** Added `ssl` option to `TurbineConfig` for secure connections to cloud providers (RDS, Supabase, Neon, etc.)
- Aggregate column aliases now quoted via `quoteIdent()` in `buildGroupBy()` and `buildAggregate()`, prevents potential SQL syntax injection
- Column validation added to `buildAggregate()` matching `buildGroupBy()`, rejects unknown field names
- `findManyStream()` batch size coerced to safe positive integer

### Changed
- **README repositioned:** Tagline and "Why Turbine?" section now lead with streaming, typed errors, pipeline, and middleware as primary differentiators. json_agg presented as shared approach rather than unique feature
- Removed stale "no WASM" claims about Prisma (Prisma 7 dropped Rust engine in Jan 2026)
- Package size claim corrected from "70KB" to "~110KB" (actual npm pack size)
- `pg.types.setTypeParser(20, ...)` moved from module scope into `TurbineClient` constructor with once-guard, fixes incorrect `sideEffects: false` in package.json

### Tests
- 254 unit tests passing
- Shared test helpers extracted to `src/test/helpers.ts`

## 0.6.2 (2026-04-06)

### Added
- **Typed constraint-violation errors:** `UniqueConstraintError`, `ForeignKeyError`, `NotNullViolationError`, `CheckConstraintError`, pg sqlstate codes (23505/23503/23502/23514) are translated automatically at every query chokepoint (CRUD, raw, transactions, pipelines, streaming)
- `wrapPgError()` helper translates pg driver errors into typed Turbine errors with `cause` chaining preserved for stack traces
- **Atomic update operators:** `update`/`updateMany` now support Prisma-style `{ increment, decrement, multiply, divide, set }` operators for race-free counter updates
  ```ts
  await db.posts.update({ where: { id: 5 }, data: { viewCount: { increment: 1 } } })
  ```
- New exported types `UpdateInput<T>` and `UpdateOperatorInput<V>` with conditional `V extends number` narrowing, `increment` on a non-numeric column is a compile-time error
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
- **Streaming cursors:** `findManyStream()` returns `AsyncGenerator<T>` backed by PostgreSQL `DECLARE CURSOR`, constant memory for large result sets
- Configurable `batchSize` (default: 100) for internal FETCH batching
- Streaming supports all `findMany` options: `where`, `orderBy`, `limit`, `with` (nested relations)
- Early termination via `break` automatically cleans up cursor and connection
- **Next.js example app** (`examples/nextjs/`), server-rendered demo with nested relations, code blocks, and streaming showcase
- **Auto-diff migrations:** `npx turbine migrate create <name> --auto` generates UP + DOWN SQL from schema diff
- Schema diff now detects DEFAULT value changes (SET DEFAULT / DROP DEFAULT)
- Schema diff now detects UNIQUE constraint changes (ADD / DROP CONSTRAINT)
- Schema diff generates reverse SQL for all operations (for DOWN migrations)
- Type changes now include USING clause for safe casting
- Fresh benchmark suite against Prisma 7.6 and Drizzle 0.45 (`benchmarks/`)
- README benchmarks updated with current numbers, Turbine 1.4–1.9x faster across all scenarios
- Reproducible benchmark harness: `cd benchmarks && npm install && npx prisma generate && npx tsx bench.ts`

### Changed
- `schemaDiff()` now returns `reverseStatements` alongside `statements`
- `createMigration()` accepts optional `autoContent` for pre-populated UP/DOWN
- README benchmark section replaced with fresh Prisma 7 / Drizzle v2 results (was Prisma 5.x / Drizzle v1)
- Comparison section updated to reflect all three ORMs now using single-query approaches

## 0.6.0 (2026-04-05)

### Security
- **CRITICAL:** Fixed shell injection in seed command, replaced `execSync` string interpolation with `execFileSync` array args
- Migration tracking table name now quoted via `quoteIdent()` at all SQL interpolation sites
- DEFAULT value validation rejects strings containing semicolons and SQL statement keywords
- Connection string redaction (`redactUrl()`) applied to all CLI error output paths

### Added
- Column validation in `orderBy`, throws `ValidationError` for unknown column names
- Column validation in `groupBy`, throws `ValidationError` for unknown column names
- Runtime type validation in `defineSchema()`, throws for invalid column types not in TYPE_MAP
- JSON parse warning in nested relation parsing, warns instead of silently falling back
- Error handling section in README with typed error examples and error code reference
- 20 new unit tests (validation, DEFAULT edge cases, schema type checks), 171 total

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
