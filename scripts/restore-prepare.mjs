#!/usr/bin/env node
/**
 * Restore the `prepare` script to package.json after packing/publishing.
 *
 * Companion to strip-prepare.mjs. Runs from `postpack` so the local working
 * tree keeps the husky-installing `prepare` entry that strip-prepare.mjs
 * removed for the packed tarball. Idempotent: does nothing if `prepare` is
 * already present.
 *
 * The value comes from the gitignored temp file strip-prepare.mjs wrote (so it
 * is never hardcoded); if that file is missing we fall back to a sensible
 * default. The entry is re-inserted immediately after `prepublishOnly` (its
 * original position), and the trailing comma is COMPUTED from the insertion
 * position rather than hardcoded, so strip plus restore round-trips to a
 * byte-identical file and never emits invalid JSON, even if `prepublishOnly`
 * is the last script.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const DEFAULT_VALUE = 'husky';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = resolve(repoRoot, 'package.json');
const savePath = resolve(repoRoot, '.prepare-script.json');
const text = readFileSync(pkgPath, 'utf8');

/** Read the strip-saved value, falling back to the default if it is missing/bad. */
function readSavedValue() {
  if (!existsSync(savePath)) return DEFAULT_VALUE;
  try {
    const parsed = JSON.parse(readFileSync(savePath, 'utf8'));
    return typeof parsed?.value === 'string' ? parsed.value : DEFAULT_VALUE;
  } catch {
    return DEFAULT_VALUE;
  }
}

/** Remove the temp file if present (best-effort cleanup). */
function cleanupSaved() {
  if (existsSync(savePath)) rmSync(savePath, { force: true });
}

if (/^[ \t]*"prepare":/m.test(text)) {
  console.log('[restore-prepare] scripts.prepare already present, nothing to do');
  cleanupSaved();
  process.exit(0);
}

// Anchor on the prepublishOnly line and insert `prepare` right after it,
// reusing that line's exact indentation and line ending.
const anchorRe = /^([ \t]*)"prepublishOnly":[ \t]*"(?:[^"\\]|\\.)*"([ \t]*,?)(\r?\n)/m;
const match = text.match(anchorRe);

if (!match) {
  console.error('[restore-prepare] could not find "prepublishOnly" anchor, refusing to guess');
  process.exit(1);
}

const [full, indent, , eol] = match;
const value = readSavedValue();

// Decide the inserted line's trailing comma from what follows the anchor: if the
// next non-empty content is the closing brace, `prepare` becomes the last script
// and must NOT carry a trailing comma; otherwise it does.
const rest = text.slice(match.index + full.length);
const prepareIsLast = /^[ \t]*\}/.test(rest);
const prepareComma = prepareIsLast ? '' : ',';

// The anchor (prepublishOnly) now has `prepare` after it, so it MUST end with a
// comma. Preserve its body byte-for-byte and add a comma only if it lacks one.
const anchorBody = full.slice(0, full.length - eol.length);
const anchorWithComma = anchorBody.endsWith(',') ? anchorBody : `${anchorBody},`;

const insertion = `${anchorWithComma}${eol}${indent}"prepare": ${JSON.stringify(value)}${prepareComma}${eol}`;
const next = text.replace(anchorRe, insertion);
writeFileSync(pkgPath, next);
cleanupSaved();
console.log(`[restore-prepare] restored scripts.prepare (${JSON.stringify(value)}) to package.json`);
