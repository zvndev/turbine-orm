#!/usr/bin/env node
/**
 * Remove the `prepare` script from package.json before packing/publishing.
 *
 * The `prepare` lifecycle only exists to install husky git hooks for local
 * development. This strip only affects the published REGISTRY tarball (for
 * allow-scripts / manifest-audit hygiene: a consumer's `npm install` should
 * not see a `prepare` script it cannot run): `prepack` runs this to strip the
 * entry from the packed tarball, and `postpack` (restore-prepare.mjs) puts it
 * back so local dev keeps working. Git-dependency installs are unaffected: they
 * check out and use the repo's own package.json, which is restored by postpack.
 *
 * This edits the JSON text surgically (a single line removal) rather than
 * re-serializing, so key order and formatting stay byte-for-byte identical and
 * the git working tree is not churned. The removed script's value is saved to a
 * gitignored temp file so restore-prepare.mjs can put back the exact value
 * without hardcoding it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = resolve(repoRoot, 'package.json');
const savePath = resolve(repoRoot, '.prepare-script.json');
const text = readFileSync(pkgPath, 'utf8');

// Capture indent / value / trailing-comma / line-ending of the `prepare` line
// separately so we can both remove it cleanly and record its exact value.
const lineRe = /^([ \t]*)"prepare":[ \t]*("(?:[^"\\]|\\.)*")([ \t]*,?)(\r?\n)/m;
const match = text.match(lineRe);

if (!match) {
  console.log('[strip-prepare] no "prepare" script found, nothing to do');
  process.exit(0);
}

const [, , quotedValue, trailingComma] = match;
const value = JSON.parse(quotedValue);

// Persist the exact value so restore does not hardcode "husky".
writeFileSync(savePath, `${JSON.stringify({ value }, null, 2)}\n`);

// Remove the whole `prepare` line. If it had NO trailing comma it was the last
// script entry, so the PRECEDING entry now carries a dangling comma before the
// closing brace, so strip that too to keep the result valid JSON.
let next = text.replace(lineRe, '');
if (!trailingComma.includes(',')) {
  next = next.replace(/,([ \t]*\r?\n[ \t]*\})/, '$1');
}

writeFileSync(pkgPath, next);
console.log(`[strip-prepare] removed scripts.prepare (${JSON.stringify(value)}) from package.json`);
