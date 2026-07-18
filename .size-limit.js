// Measures the REAL bundled import graph (esbuild) of each public entry, not
// the bare barrel file. `pg` (the one runtime dependency) is excluded so the
// numbers reflect Turbine's own footprint; platform:node keeps Node builtins
// external, matching how the package is actually consumed.
const nodePlatform = (config) => {
  config.platform = 'node';
  return config;
};

// Budgets re-baselined 2026-07-17 (v0.36.0) to the measured brotli sizes plus
// ~2 kB headroom. Measured: main 50.28 kB, serverless 39.08 kB, sqlite 41.63 kB,
// mysql 42.69 kB, mssql 44.28 kB. Growth since the 0.28.0 baseline comes from the
// safety-bundle work (typed capability errors, read-only guards, PII metadata)
// riding the shared client/query graph. Re-measure and re-baseline on each bump.
export default [
  {
    name: "main entry — import { TurbineClient } from 'turbine-orm'",
    path: 'dist/index.js',
    limit: '53 kB',
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
    limit: '42 kB',
    ignore: ['pg'],
    modifyEsbuildConfig: nodePlatform,
  },
  {
    name: 'sqlite entry — turbine-orm/sqlite (node:sqlite + client graph)',
    path: 'dist/sqlite.js',
    limit: '44 kB',
    ignore: ['pg', 'node:sqlite'],
    modifyEsbuildConfig: nodePlatform,
  },
  {
    name: 'mysql entry — turbine-orm/mysql (client graph; mysql2 lazy-loaded)',
    path: 'dist/mysql.js',
    limit: '45 kB',
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
    limit: '47 kB',
    // mssql is an optional peer loaded via a dynamic import in the factory, so it
    // is never in the static graph — exclude it (and pg) from the footprint.
    ignore: ['pg', 'mssql'],
    modifyEsbuildConfig: nodePlatform,
  },
];
