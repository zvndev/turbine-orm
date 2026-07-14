#!/usr/bin/env node
/**
 * Restore the `prepare` script to package.json after packing/publishing.
 *
 * Companion to strip-prepare.mjs. Runs from `postpack` so the local working
 * tree keeps the husky-installing `prepare` entry that strip-prepare.mjs
 * removed for the packed tarball. Idempotent: does nothing if `prepare` is
 * already present.
 *
 * The entry is re-inserted immediately after `prepublishOnly` (its original
 * position), so strip plus restore round-trips to a byte-identical file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const text = readFileSync(pkgPath, 'utf8');

if (/^[ \t]*"prepare":/m.test(text)) {
  console.log('[restore-prepare] scripts.prepare already present, nothing to do');
  process.exit(0);
}

// Anchor on the prepublishOnly line and insert `prepare` right after it,
// reusing that line's exact indentation and line ending.
const anchorRe = /^([ \t]*)"prepublishOnly":[ \t]*"[^"]*",?(\r?\n)/m;
const match = text.match(anchorRe);

if (!match) {
  console.error('[restore-prepare] could not find "prepublishOnly" anchor, refusing to guess');
  process.exit(1);
}

const [full, indent, eol] = match;
const insertion = `${full}${indent}"prepare": "husky",${eol}`;
const next = text.replace(anchorRe, insertion);
writeFileSync(pkgPath, next);
console.log('[restore-prepare] restored scripts.prepare to package.json');
