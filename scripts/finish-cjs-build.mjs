#!/usr/bin/env node
/**
 * Finish the CommonJS build in dist/cjs:
 *
 *   1. Write dist/cjs/package.json as `{"type":"commonjs"}`, so the .js files
 *      next to it load as CommonJS inside a `"type": "module"` package.
 *   2. Rewrite `require("#pg")` to `require("pg")`.
 *
 * Why (2). The shared modules import the driver as `#pg`, a package.json
 * `imports` alias whose only job is to give EDGE bundlers a pg-free shim. Node
 * resolves `#name` against the NEAREST package.json, which for dist/cjs is the
 * one written in step 1, so the alias would have to be restated there, and
 * publint --strict rejects an `imports` field in a nested package.json. Edge
 * bundlers never reach this tree: every subpath export lists `import` before
 * `require`, and an edge build resolves the ESM files. So the CJS build is
 * Node-only and simply names the driver. `npm run check:edge` covers the ESM
 * serverless entry, which is the one edge bundles load.
 *
 * Fails closed: the rewrite must find the expected sites, and no `require` of
 * `#pg` may remain, so a renamed file or a changed emit shape is a build error
 * rather than a CJS build that throws MODULE_NOT_FOUND at require time.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cjsDir = join(root, 'dist', 'cjs');

writeFileSync(join(cjsDir, 'package.json'), '{"type":"commonjs"}\n');

const SPECIFIER = /require\((["'])#pg\1\)/g;
function jsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? jsFiles(p) : e.name.endsWith('.js') ? [p] : [];
  });
}

const rewritten = [];
for (const file of jsFiles(cjsDir)) {
  const text = readFileSync(file, 'utf8');
  const next = text.replace(SPECIFIER, 'require("pg")');
  if (next !== text) {
    writeFileSync(file, next);
    rewritten.push(relative(root, file));
  }
}

// client, query/utils, observe, introspect and pipeline-submittable import #pg.
const EXPECTED_MIN = 5;
if (rewritten.length < EXPECTED_MIN) {
  console.error(
    `finish-cjs-build: rewrote require("#pg") in ${rewritten.length} file(s), expected at least ${EXPECTED_MIN}. ` +
      'The CJS emit shape changed; fix this script before shipping a CJS build that cannot resolve the driver.',
  );
  process.exit(1);
}
