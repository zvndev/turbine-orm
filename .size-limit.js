// Measures the REAL bundled import graph (esbuild) of each public entry, not
// the bare barrel file. `pg` (the one runtime dependency) is excluded so the
// numbers reflect Turbine's own footprint; platform:node keeps Node builtins
// external, matching how the package is actually consumed.
const nodePlatform = (config) => {
  config.platform = 'node';
  return config;
};

// HEADROOM CONVENTION (adopted 2026-07-25): every limit is the measured size
// plus ~5%, minimum 1 kB, rounded up to the next whole kB. The previous
// baselines sat ~1 kB above measured, which on a 59 kB entry is under 2%
// headroom: main was at 59.41 kB against a 60 kB limit, so the next unrelated
// change to the shared client/query graph turned the gate red without anything
// having actually regressed. A tripwire that fires on noise gets re-baselined
// reflexively and stops meaning anything. 5% is still tight enough that a real
// regression (a new module pulled into a shared graph) trips it and has to be
// re-baselined CONSCIOUSLY, with the reason recorded here.
//
// Measured 2026-08-16 at the 0.73.0 RELEASE COMMIT, `npm run build` then
// `npx size-limit`: main 85.10 kB, serverless 67.68 kB, sqlite 70.61 kB,
// mysql 71.91 kB, mssql 73.27 kB, powdb 88.67 kB, prisma-compat 12.78 kB.
//
// Only `main` went red (85.10 against 85), and the honest reading is that the
// limits were nearly exhausted BEFORE this release rather than blown by it. The
// PUBLISHED 0.72.0 tarball measures main 84.08, serverless 66.55, sqlite 69.55,
// mysql 70.76, mssql 72.28, powdb 87.54, prisma-compat 12.70, so 0.73.0's own
// contribution is ~1.1 kB uniformly across every entry carrying the shared
// client/query graph, and +0.08 kB on prisma-compat. That uniformity is the
// signature this budget looks for, and it is accounted for: the pagination-alias
// fold (`normalizePagination` in query/utils.ts plus the `normalizeArgs` seam on
// both engines), the findUnique identity guard and its shared message
// (query/compound-unique.ts), and the unknown-query-option warning
// (query/option-surface.ts, this file's first runtime code).
//
// The 80.57 -> 84.08 drift on main happened across 0.67-0.72 with no re-measure,
// which is the thing not to repeat: re-baseline when the gate goes red, not
// seven releases later when the cause is no longer separable.
//
// THE SERVERLESS ENTRY IS DELIBERATELY NOT ON THE 5% CONVENTION. Its 68 kB is a
// PUBLISHED CLAIM ("under 68 kB brotli (CI-enforced)", README comparison table),
// so the limit and the claim are the same number on purpose, and it keeps only
// 0.32 kB of headroom. When it goes red the choice is to shrink the edge graph
// or to change the README, and it has to be MADE rather than absorbed by
// bumping a limit. Every other entry follows the convention above.
//
// THE MAIN ENTRY JOINS THAT RULE (2026-08-21), because it is a published claim
// too and the two numbers had come apart in the worst direction. The README said
// "under 85 kB brotli ... enforced by size-limit in CI" in two places while the
// entry measured 85.22 kB and the gate here was 90 kB: the published figure was
// EXCEEDED, and the gate that was cited as enforcing it enforced something 4.78 kB
// looser, so nothing would have gone red until long after the sentence stopped
// being true. Measured 2026-08-21 against the 0.75.0 dist with `npx size-limit`:
// main 85.22, serverless 67.66, sqlite 70.61, mysql 71.97, mssql 73.33,
// powdb 89.09, cli 1.71, adapters 1.19, prisma-compat 12.78.
//
// So main is 86 kB here and "under 86 kB" in the README, one number in two
// places, 0.78 kB of headroom. That is a TIGHTENING of the gate (90 -> 86), not
// a re-baseline to cover a regression, and it is the only move that makes the
// sentence true without deleting it. When it goes red the same choice applies as
// for serverless: shrink the graph or change the claim, deliberately, in both
// files at once. Do not raise this number to make a build pass.
//
// BOTH CLAIM-PINNED ENTRIES RE-BASELINED 2026-08-22, at the end of the 0.76.0
// review-fix sprint. Measured on this build: main 86.14 (limit was 86),
// serverless 68.27 (limit was 68). Both went red by a few hundred bytes, and
// both are published claims, so this is the deliberate choice the notes above
// say has to be made rather than absorbed: main 87 kB, serverless 69 kB, and
// the README and site sentences moved to the same two numbers in the same
// commit.
//
// The growth is accounted for and it is uniform (+0.92 main, +0.61 serverless),
// which is the signature of the SHARED client/query graph rather than a new
// edge. It is this sprint's core fixes: the relation-target global filter now
// reaching every walker (query/relations.ts, query/where.ts), the `with`-spec
// shorthand unification behind `relationOptions()`, and the pipeline's dialect
// parameter. Checked before accepting it: no engine (mssql/mysql/sqlite/powql)
// and no `cli/` module is reachable from `dist/index.js`, so nothing leaked
// into the graph.
//
// Prior baseline 2026-08-09 at the 0.66.0 SPRINT COMMIT, `npm run build` then
// `npx size-limit`: main 80.57 kB, serverless 64.16 kB, sqlite 67.11 kB,
// mysql 68.24 kB, mssql 69.71 kB, powdb 85.03 kB, prisma-compat 12.42 kB.
//
// The gate went red on five entries before this re-baseline, which is the
// convention working. Growth from the 0.62.0 line is uniform across every entry
// carrying the shared client/query graph: serverless +3.65, mssql +3.69,
// mysql +3.87, sqlite +4.02, powdb +4.08, main +5.03 kB. That is a shared-graph
// change, and it is accounted for: the where/having depth caps
// (query/where-compile.ts), the variable-arity statement marking and its
// `INTERNAL_COMBINATOR` branding that keeps a query's prepared statement unnamed
// when its SQL text can grow without bound, the order-key dedupe and its
// resolved-expression identity, the `buildPartitionLimit` and
// `escapeLikePattern` dialect hooks, the shared vector-threshold validator, the
// per-client error-message mode, and the boolean/json wire rules. main carries
// ~1 kB more than the engines because it also holds the Postgres dialect that
// declares the two new hooks.
//
// prisma-compat moved +0.33 kB, an order of magnitude less than the shared
// graph, which is the property this budget exists to guard: it still takes a
// TurbineClient by value and imports only core TYPES. Its limit is left at
// 13 kB rather than re-baselined, because it did not go red.
//
// Prior baseline 2026-07-28 at the 0.62.0 RELEASE COMMIT, `npm run build` then
// `npx size-limit`: main 75.54 kB, serverless 60.51 kB, sqlite 63.09 kB,
// mysql 64.37 kB, mssql 66.02 kB, powdb 80.95 kB, prisma-compat 12.09 kB.
//
// The gate went red on mssql (by 18 bytes) and prisma-compat (by 1.09 kB)
// before this re-baseline. Growth from the 0.55.0 line is uniform across every
// entry that carries the shared client/query graph: main +3.06, serverless
// +3.06, sqlite +2.99, mysql +3.12, mssql +3.20, powdb +3.25 kB. That is the
// signature of a shared-graph change, and it is accounted for: the privilege
// sentinel and its resolvers plus `assertOrderDirection` (query/types.ts, called
// from every direction site on every engine), the connection-string classifier
// and the typed connection-error mapping with its per-code next steps
// (client.ts + errors.ts), and the `.cause` detail redaction.
//
// prisma-compat moved +3.64 kB, MORE than the shared-graph delta, and that is
// the one number here that is its own growth rather than inherited. It is real
// code, not a leaked import: the runtime option surface it now drives
// (query/option-surface.ts), `$extends` with its client + model components,
// write projections with field-name validation, and the unknown-option
// warnings. The property this budget exists to guard still holds and is the
// thing to check first if this number moves again: at 12.09 kB it remains an
// order of magnitude below the entries that bundle the core graph, so it is
// still taking a TurbineClient by value and importing core TYPES. If it ever
// jumps toward 60 kB, something started importing core values.
//
// Measured 2026-07-27 at the 0.55.0 RELEASE COMMIT, `npm run build` then
// `npx size-limit`: main 72.48 kB, serverless 57.45 kB, sqlite 60.1 kB,
// mysql 61.25 kB, mssql 62.82 kB, powdb 77.7 kB, prisma-compat 8.45 kB.
//
// The gate went red on serverless, sqlite and mysql before this re-baseline,
// which is the convention working. Growth from the 0.54.0 line is uniform:
// main +1.45, serverless +1.43, sqlite +1.37, mysql +1.35, mssql +1.28,
// powdb +1.32 kB, while prisma-compat moved -0.01 kB. Every entry that carries
// the shared client/query graph moved by the same amount and the one entry that
// does not carry it did not move at all, which is the signature of a
// shared-graph change rather than one module ballooning. It is accounted for:
// the temporal-infinity reading (the option, the per-strategy normalization in
// builder.ts and aggregates.ts, and the warning, whose text is long because it
// has to state a data-loss trade), the parser-overwrite warning, and the
// planCacheMode connection-parameter merge. prisma-compat staying flat is the
// property this budget exists to guard: it takes a TurbineClient by value and
// imports only types, so none of the above is in its bundle.
//
// Prior baseline 2026-07-26 at the 0.52.0 RELEASE COMMIT, `npm run build` then
// `npx size-limit`: main 68.78 kB, serverless 53.74 kB, sqlite 56.39 kB,
// mysql 57.68 kB, mssql 59.26 kB, powdb 74.09 kB, prisma-compat 7.53 kB.
//
// The gate went red on five entries before this re-baseline, which is the
// convention working rather than failing: 0.52.0 is a correctness release whose
// fixes land almost entirely in the SHARED client/query graph, so every entry
// moved together. Growth from the 0.50.0 line: main +3.6, serverless +3.6,
// sqlite +3.8, mysql +3.9, mssql +3.8 kB. That uniformity is the signature of a
// shared-graph change and is what makes it believable; ONE entry jumping alone
// would be the thing to investigate. It is accounted for: the two-source column
// type resolution and the untyped-column warning (builder.ts), the symmetric
// createMany row-shape guard (writes.ts), deterministic relation and `_count`
// key seeding (batched-loader.ts), the utcTimestamps process-scope check and
// logQueryParams (client.ts), and the new engine-config.ts forwarding module
// that all three non-Postgres factories now import.
//
// powdb rose more (+5.5 kB), and correctly so: it carries the shared graph plus
// its own PowDB 0.20 work, the datetime `in`/`notIn` equality-chain compiler and
// the per-column capability gates. prisma-compat rose 0.4 kB and stays an order
// of magnitude below the rest, so it is still type-only against the core; its
// limit is unchanged at 9 kB because the measured 7.53 kB is still under it.
//
// Prior baseline 2026-07-25 at the 0.50.0 RELEASE COMMIT, `npm run build` then
// `npx size-limit`, and confirmed byte-identical in CI: main 65.16 kB,
// serverless 50.18 kB, sqlite 52.61 kB, mysql 53.79 kB, mssql 55.45 kB,
// powdb 68.55 kB, prisma-compat 7.15 kB.
//
// This is the SECOND re-baseline in one release, which normally would be the
// smell this convention exists to catch, so the reason is recorded rather than
// waved through. The first set of limits was measured mid-sprint against a
// scratch build; three further changes landed afterwards (the `flatten`
// relation strategy, the cross-strategy value-fidelity coercion, and the
// derived `auto` threshold), so the serverless entry came out 0.18 kB OVER its
// fresh limit and CI went red. The gate worked: it caught real growth that had
// not been measured, rather than noise. Nothing was reduced to make it pass,
// and nothing was raised to hide a regression: the growth is the features
// listed below, and the numbers above are the honest post-feature sizes.
//
// Earlier the same day, mid-sprint: main 62.44 / serverless 47.47 /
// sqlite 49.94 / mysql 51.15 / mssql 52.69 / powdb 65.91 / prisma-compat 7.16.
// Earlier still: main 59.66 / serverless 44.77 /
// sqlite 47.30 / mysql 48.42 / mssql 50.11 / powdb 63.31 / prisma-compat 6.63.
// Prior baseline 2026-07-24 (v0.49.0): main 59.03 / serverless 44.21 /
// sqlite 46.66 / mysql 47.81 / mssql 49.48. Prior 2026-07-23 (v0.47.0):
// main 57.06 / serverless 43.03 / sqlite 45.56 / mysql 46.71 / mssql 48.3.
//
// The full 0.50.0 growth (main 59.03 -> 65.16, +6.1 kB) is accounted for and
// expected: every entry carries the shared client/query graph, and this release
// added many-to-many nested writes (nested-write.ts, the largest single
// addition), the temporal bind rewrite on both the write and where paths, a much
// wider Postgres-type-to-array-cast table, the `flatten` relation strategy, and
// the cross-strategy value-fidelity coercion. Every engine entry moved by about
// the same amount, which is what a shared-graph change looks like; a jump in ONE
// entry would be the thing to investigate. prisma-compat rose 0.5 kB and stays an
// order of magnitude below the rest, so it is still type-only against the core.
//
// `powdb` and `prisma-compat` are NEW entries here: both are published subpath
// exports (package.json `exports`) and both were previously unmeasured, so a
// size regression in either shipped invisibly. prisma-compat is small despite
// being ~1.7K LOC because it takes a TurbineClient by value and imports only
// types from the core, so the client/query graph is not in its bundle: that
// property is worth guarding, and this budget is what guards it.
export default [
  {
    name: "main entry, import { TurbineClient } from 'turbine-orm'",
    path: 'dist/index.js',
    // Same number as the README's claim, on purpose. See the note above.
    limit: '87 kB',
    ignore: ['pg'],
    modifyEsbuildConfig: nodePlatform,
  },
  {
    name: 'edge entry, turbine-orm/serverless (+ client graph)',
    // The shared client/query graph carries the multi-dialect seam (the
    // resultStrategy output/reselect executor branches + the additive relation /
    // pagination dialect-hook dispatch). These are tiny and engine-neutral, but
    // the edge bundle includes the query builder, so the budget gets a small bump.
    path: 'dist/serverless.js',
    limit: '69 kB',
    ignore: ['pg'],
    modifyEsbuildConfig: nodePlatform,
  },
  {
    name: 'sqlite entry, turbine-orm/sqlite (node:sqlite + client graph)',
    path: 'dist/sqlite.js',
    limit: '75 kB',
    ignore: ['pg', 'node:sqlite'],
    modifyEsbuildConfig: nodePlatform,
  },
  {
    name: 'mysql entry, turbine-orm/mysql (client graph; mysql2 lazy-loaded)',
    path: 'dist/mysql.js',
    limit: '76 kB',
    // mysql2 is an optional peer loaded via a dynamic import in the factory, so
    // it is never in the static graph, exclude it (and pg) from the footprint.
    ignore: ['pg', 'mysql2', 'mysql2/promise'],
    modifyEsbuildConfig: nodePlatform,
  },
  {
    name: 'mssql entry, turbine-orm/mssql (client graph; mssql lazy-loaded)',
    path: 'dist/mssql.js',
    // Slightly larger than the other engines: the FOR JSON PATH relation generator
    // and the INFORMATION_SCHEMA/sys introspector add real code (no extra deps).
    limit: '77 kB',
    // mssql is an optional peer loaded via a dynamic import in the factory, so it
    // is never in the static graph, exclude it (and pg) from the footprint.
    ignore: ['pg', 'mssql'],
    modifyEsbuildConfig: nodePlatform,
  },
  {
    name: 'powdb entry: turbine-orm/powdb (client graph + PowQL generator)',
    // The largest entry: it carries the whole client/query graph AND powql.ts,
    // a second, parallel query generator for a non-SQL language.
    path: 'dist/powdb.js',
    limit: '94 kB',
    // Both PowDB drivers are optional peers behind dynamic imports (the
    // networked client and the embedded napi addon), so neither is in the
    // static graph.
    ignore: ['pg', '@zvndev/powdb-client', '@zvndev/powdb-embedded'],
    modifyEsbuildConfig: nodePlatform,
  },
  {
    name: 'cli entry: turbine-orm/cli (config helper only)',
    // `turbine-orm/cli` exports defineConfig/loadConfig, not the CLI itself
    // (the bin is dist/cli/index.js and ships whole either way). Measured
    // 2026-08-02 at 1.71 kB. The budget guards the same property as
    // prisma-compat's: this entry must stay an order of magnitude below the
    // core-graph entries. A turbine.config.ts imports it, so if it ever pulls
    // the client/query graph, every config load pays for the whole ORM.
    path: 'dist/cli/config.js',
    limit: '3 kB',
    ignore: ['pg'],
    modifyEsbuildConfig: nodePlatform,
  },
  {
    name: 'adapters entry: turbine-orm/adapters (operation overrides only)',
    // Thin per-engine operation overrides (cockroachdb/yugabytedb SQL swaps)
    // with no core-graph import. Measured 2026-08-02 at 1.13 kB. Previously
    // unmeasured, so a core import creeping in shipped invisibly; these two
    // were the only published subpaths without a budget.
    path: 'dist/adapters/index.js',
    limit: '3 kB',
    ignore: ['pg'],
    modifyEsbuildConfig: nodePlatform,
  },
  {
    name: 'prisma-compat entry: turbine-orm/prisma-compat (adapter only)',
    // A pure shim: it wraps a TurbineClient the caller already has, so the core
    // graph is NOT bundled with it. If this number jumps toward the other
    // entries, something started importing core values instead of core types.
    path: 'dist/prisma-compat.js',
    limit: '14 kB',
    ignore: ['pg'],
    modifyEsbuildConfig: nodePlatform,
  },
];
