// Measures the REAL bundled import graph (esbuild) of each public entry, not
// the bare barrel file. `pg` (the one runtime dependency) is excluded so the
// numbers reflect Turbine's own footprint; platform:node keeps Node builtins
// external, matching how the package is actually consumed.
const nodePlatform = (config) => {
  config.platform = 'node';
  return config;
};

export default [
  {
    name: "main entry — import { TurbineClient } from 'turbine-orm'",
    path: 'dist/index.js',
    limit: '35 kB',
    ignore: ['pg'],
    modifyEsbuildConfig: nodePlatform,
  },
  {
    name: 'edge entry — turbine-orm/serverless (+ client graph)',
    path: 'dist/serverless.js',
    limit: '25 kB',
    ignore: ['pg'],
    modifyEsbuildConfig: nodePlatform,
  },
  {
    name: 'sqlite entry — turbine-orm/sqlite (node:sqlite + client graph)',
    path: 'dist/sqlite.js',
    limit: '30 kB',
    ignore: ['pg', 'node:sqlite'],
    modifyEsbuildConfig: nodePlatform,
  },
];
