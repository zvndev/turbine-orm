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
// Measured 2026-07-25 (end of the 0.50.0 sprint) with `npx size-limit` against
// a fresh build: main 62.44 kB, serverless 47.47 kB, sqlite 49.94 kB,
// mysql 51.15 kB, mssql 52.69 kB, powdb 65.91 kB, prisma-compat 7.16 kB.
// Earlier the same day, mid-sprint: main 59.66 / serverless 44.77 /
// sqlite 47.30 / mysql 48.42 / mssql 50.11 / powdb 63.31 / prisma-compat 6.63.
// Prior baseline 2026-07-24 (v0.49.0): main 59.03 / serverless 44.21 /
// sqlite 46.66 / mysql 47.81 / mssql 49.48. Prior 2026-07-23 (v0.47.0):
// main 57.06 / serverless 43.03 / sqlite 45.56 / mysql 46.71 / mssql 48.3.
//
// The 0.50.0 growth (main +2.8 kB) is accounted for and expected: every entry
// carries the shared client/query graph, and this release added many-to-many
// nested writes (nested-write.ts, the largest single addition), the temporal
// bind rewrite on both the write and where paths, and a much wider
// Postgres-type-to-array-cast table. Every engine entry moved by about the same
// amount, which is what a shared-graph change looks like; a jump in ONE entry
// would be the thing to investigate. prisma-compat rose 0.5 kB and stays an
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
    name: "main entry — import { TurbineClient } from 'turbine-orm'",
    path: 'dist/index.js',
    limit: '66 kB',
    ignore: ['pg'],
    modifyEsbuildConfig: nodePlatform,
  },
  {
    name: 'edge entry — turbine-orm/serverless (+ client graph)',
    // The shared client/query graph carries the multi-dialect seam (the
    // resultStrategy output/reselect executor branches + the additive relation /
    // pagination dialect-hook dispatch). These are tiny and engine-neutral, but
    // the edge bundle includes the query builder, so the budget gets a small bump.
    path: 'dist/serverless.js',
    limit: '50 kB',
    ignore: ['pg'],
    modifyEsbuildConfig: nodePlatform,
  },
  {
    name: 'sqlite entry — turbine-orm/sqlite (node:sqlite + client graph)',
    path: 'dist/sqlite.js',
    limit: '53 kB',
    ignore: ['pg', 'node:sqlite'],
    modifyEsbuildConfig: nodePlatform,
  },
  {
    name: 'mysql entry — turbine-orm/mysql (client graph; mysql2 lazy-loaded)',
    path: 'dist/mysql.js',
    limit: '54 kB',
    // mysql2 is an optional peer loaded via a dynamic import in the factory, so
    // it is never in the static graph — exclude it (and pg) from the footprint.
    ignore: ['pg', 'mysql2', 'mysql2/promise'],
    modifyEsbuildConfig: nodePlatform,
  },
  {
    name: 'mssql entry — turbine-orm/mssql (client graph; mssql lazy-loaded)',
    path: 'dist/mssql.js',
    // Slightly larger than the other engines: the FOR JSON PATH relation generator
    // and the INFORMATION_SCHEMA/sys introspector add real code (no extra deps).
    limit: '56 kB',
    // mssql is an optional peer loaded via a dynamic import in the factory, so it
    // is never in the static graph — exclude it (and pg) from the footprint.
    ignore: ['pg', 'mssql'],
    modifyEsbuildConfig: nodePlatform,
  },
  {
    name: 'powdb entry: turbine-orm/powdb (client graph + PowQL generator)',
    // The largest entry: it carries the whole client/query graph AND powql.ts,
    // a second, parallel query generator for a non-SQL language.
    path: 'dist/powdb.js',
    limit: '70 kB',
    // Both PowDB drivers are optional peers behind dynamic imports (the
    // networked client and the embedded napi addon), so neither is in the
    // static graph.
    ignore: ['pg', '@zvndev/powdb-client', '@zvndev/powdb-embedded'],
    modifyEsbuildConfig: nodePlatform,
  },
  {
    name: 'prisma-compat entry: turbine-orm/prisma-compat (adapter only)',
    // A pure shim: it wraps a TurbineClient the caller already has, so the core
    // graph is NOT bundled with it. If this number jumps toward the other
    // entries, something started importing core values instead of core types.
    path: 'dist/prisma-compat.js',
    limit: '9 kB',
    ignore: ['pg'],
    modifyEsbuildConfig: nodePlatform,
  },
];
