// Measures the REAL bundled import graph (esbuild) of each public entry, not
// the bare barrel file. `pg` (the one runtime dependency) is excluded so the
// numbers reflect Turbine's own footprint; platform:node keeps Node builtins
// external, matching how the package is actually consumed.
const nodePlatform = (config) => {
  config.platform = 'node';
  return config;
};

// Budgets re-baselined 2026-07-24 (v0.49.0). Measured at the release HEAD:
// main 59.03 kB, serverless 44.21 kB, sqlite 46.66 kB, mysql 47.81 kB,
// mssql 49.48 kB. The correctness release added ~2 kB to main: the nested-write
// parent-correlation helpers and empty-selector guard, the belongsTo scoped
// lookup, and the two new dialect capability gates in where.ts, all of which sit
// in every entry's graph. Prior baseline 2026-07-23 (v0.47.0): main 57.06 /
// serverless 43.03 / sqlite 45.56 / mysql 46.71 / mssql 48.3. main/edge moved ~0.1-0.3 kB when the ObserveSink seam
// (PgMetricsSink/HttpJsonSink) landed on the observe graph exported from the
// barrel; the doctor/index-stats work is CLI-only and not in any entry graph.
// A feature that trips a budget must consciously re-baseline here, never bump
// blindly. Prior baseline 2026-07-23 (v0.41.0): main 56.37 / serverless 42.54
// / sqlite 45.11 / mysql 46.19 / mssql 47.85. Re-measure and re-baseline on
// each bump.
export default [
  {
    name: "main entry — import { TurbineClient } from 'turbine-orm'",
    path: 'dist/index.js',
    limit: '60 kB',
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
    limit: '45 kB',
    ignore: ['pg'],
    modifyEsbuildConfig: nodePlatform,
  },
  {
    name: 'sqlite entry — turbine-orm/sqlite (node:sqlite + client graph)',
    path: 'dist/sqlite.js',
    limit: '48 kB',
    ignore: ['pg', 'node:sqlite'],
    modifyEsbuildConfig: nodePlatform,
  },
  {
    name: 'mysql entry — turbine-orm/mysql (client graph; mysql2 lazy-loaded)',
    path: 'dist/mysql.js',
    limit: '49 kB',
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
    limit: '51 kB',
    // mssql is an optional peer loaded via a dynamic import in the factory, so it
    // is never in the static graph — exclude it (and pg) from the footprint.
    ignore: ['pg', 'mssql'],
    modifyEsbuildConfig: nodePlatform,
  },
];
