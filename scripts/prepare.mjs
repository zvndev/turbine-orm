#!/usr/bin/env node
/**
 * `prepare` lifecycle script: install the husky git hooks when husky is
 * installed here, and do nothing, successfully, when it is not.
 *
 * ## Why not `"prepare": "husky"`
 *
 * npm runs a `file:` dependency's `prepare` script as part of the CONSUMER's
 * install, and every example under examples/ depends on this package as
 * `"turbine-orm": "file:../../"`. In a fresh clone the root has no
 * node_modules, so `husky` is not on PATH and `npm install` inside any example
 * died with `sh: husky: command not found` (exit 127) before it had installed
 * a single package. `"husky || true"` would hide a genuine hook-install
 * failure on a developer machine, which is the case the hooks exist for.
 *
 * So this answers the one question that differs between the two situations,
 * "does husky resolve from the repo root", and behaves accordingly:
 *   - it resolves: run it and exit with ITS status, so a real failure still
 *     fails `npm install` at the root, exactly as before.
 *   - it does not: print one line and exit 0. That is a consumer install (an
 *     example, a git dependency) and git hooks are not its business.
 *
 * The published tarball never carries a `prepare` at all: `prepack` strips it
 * (scripts/strip-prepare.mjs) and `postpack` restores it, so this file is
 * only ever reached from a checkout of the repository.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Resolve from the ROOT package.json, not from this file: that is where
// `npm install` puts devDependencies, and it is the only place husky should be.
const require = createRequire(resolve(repoRoot, 'package.json'));

// Resolve the package's main entry, NOT `husky/package.json`: husky declares
// `"exports": "./index.js"`, which makes every other subpath, package.json
// included, ERR_PACKAGE_PATH_NOT_EXPORTED. Measured: the subpath form
// reported husky missing from a checkout that had it installed.
let huskyEntry;
try {
  huskyEntry = require.resolve('husky');
} catch {
  console.log('[prepare] husky is not installed here, skipping git hook setup (expected for a consumer install)');
  process.exit(0);
}

// Run husky's own bin with the same node, from the repo root, so `.git` and
// `.husky/` resolve exactly as they did under `"prepare": "husky"`. The bin
// path comes from husky's package.json (read from disk, past the exports map)
// rather than a hardcoded `bin.js`.
const huskyDir = dirname(huskyEntry);
const huskyPkg = JSON.parse(readFileSync(resolve(huskyDir, 'package.json'), 'utf8'));
const binField = huskyPkg.bin;
const binRel = typeof binField === 'string' ? binField : binField?.husky;
if (typeof binRel !== 'string') {
  console.error('[prepare] husky is installed but declares no bin; refusing to guess');
  process.exit(1);
}

const result = spawnSync(process.execPath, [resolve(huskyDir, binRel)], {
  cwd: repoRoot,
  stdio: 'inherit',
});
if (result.error) {
  console.error(`[prepare] could not run husky: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
