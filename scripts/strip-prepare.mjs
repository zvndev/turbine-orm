#!/usr/bin/env node
/**
 * Remove the `prepare` script from package.json before packing/publishing.
 *
 * The `prepare` lifecycle only exists to install husky git hooks for local
 * development. Shipping it in the published manifest triggers allow-scripts
 * warnings for consumers and would run husky on git-dependency installs, where
 * husky is not present. `prepack` runs this to strip the entry from the packed
 * tarball; `postpack` (restore-prepare.mjs) puts it back so local dev keeps
 * working.
 *
 * This edits the JSON text surgically (a single line removal) rather than
 * re-serializing, so key order and formatting stay byte-for-byte identical and
 * the git working tree is not churned.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const text = readFileSync(pkgPath, 'utf8');

// Match the whole `    "prepare": "...",` line including its trailing newline.
const lineRe = /^[ \t]*"prepare":[ \t]*"[^"]*",?\r?\n/m;

if (!lineRe.test(text)) {
  console.log('[strip-prepare] no "prepare" script found, nothing to do');
  process.exit(0);
}

const next = text.replace(lineRe, '');
writeFileSync(pkgPath, next);
console.log('[strip-prepare] removed scripts.prepare from package.json');
