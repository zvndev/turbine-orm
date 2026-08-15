#!/usr/bin/env node
/**
 * Guard: no reference to the `pg` module family in the PUBLISHED declarations.
 *
 * ## Why this exists
 *
 * `pg` ships no type declarations of its own, so any `@types/pg` name that
 * reaches an EXPORTED declaration makes tsc emit a pg module import into the
 * published `.d.ts`. That turns a runtime-free types package into a hard
 * requirement for every consumer compiling under `strict`, which is why
 * `@types/pg` sat in `dependencies` for so long. v0.28.1 moved it to
 * devDependencies while the declaration surface still named pg types, and
 * consumer builds broke. The order is one-way: clear the surface FIRST
 * (src/pg-types.ts), then move the dependency. This script is what keeps the
 * surface clear afterwards.
 *
 * ## One source of truth, three gates
 *
 * The tripwire used to be an inline `grep` in a single CI job, which meant the
 * gate proving the change safe was not on the publish path at all: a tag push
 * or a local `npm publish` reached npm without ever asking the question. The
 * logic lives here now and is called by `npm run check:package-types`, which
 * `prepublishOnly`, ci.yml's `consumer-types` job and release.yml's
 * `consumer-types` job all run. A gate with one caller is a gate with one way
 * to be bypassed.
 *
 * This is the CHEAP half of the check. It names the offending file and line and
 * it fires on the CJS mirrors too, but it only reads text. The end-to-end proof
 * (the real tarball installed into a project that has `pg` but not
 * `@types/pg`, compiled under `strict` + `skipLibCheck: false`) lives in the
 * workflow jobs and is not redundant with this.
 *
 * ## What counts as a hit
 *
 * A BARE specifier (not `./x`, not `/x`) that is `pg` itself, or is in the pg
 * package family: anything matching `pg/...` or `pg-...`, plus `@types/pg`.
 * Two widenings over the grep this replaces, and neither is a live bug today:
 *
 *   - Quote-agnostic. tsc emits single quotes today, so the old pattern
 *     matched; that is a formatter setting, not a contract, and a build that
 *     emitted double quotes would have walked past a tripwire that still looked
 *     like it was on duty.
 *   - Deep specifiers. src/pipeline-submittable.ts imports `pg/lib/result` and
 *     `pg/lib/utils` (typed by the unpublished types/pg-internal.d.ts), and
 *     `pg-protocol` is reachable the same way. A leak of one of those breaks
 *     consumers EVEN WITH `@types/pg` installed, because the deep path is not
 *     what that package declares. The old pattern matched neither.
 *
 * `pgsql`-style names are deliberately NOT hits: the character after `pg` must
 * be `/` or `-`, so only the package family matches.
 *
 * ## Why it strips comments instead of grepping raw text
 *
 * The grep this replaces could not tell prose from code, so the rule that came
 * with it was "a doc comment must not spell the import forms out literally",
 * i.e. a documentation edit could redden the build. Declarations carry the
 * source's JSDoc verbatim and this repo's JSDoc is full of import examples, so
 * that rule gets more expensive as the widened specifier set above matches more
 * prose. Comments are blanked (positions preserved, so line numbers stay
 * exact) with a string-aware pass, then the specifier forms are matched against
 * the code that remains. Triple-slash `/// <reference types="..." />`
 * directives are collected from the RAW text first, because those are code
 * wearing a comment's clothes.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = resolve(repoRoot, 'dist');

/**
 * Every `.d.ts` under dist/, which is a superset of the published set: both
 * tsconfigs exclude `src/test`, so no test declarations are emitted, and
 * package.json's `files` excludes nothing else that ends in `.d.ts`. Scanning
 * the superset is deliberate, an exclusion rule here could only ever shrink the
 * scan silently.
 */
function declarationFilesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...declarationFilesUnder(full));
    else if (entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/**
 * Blank out `//` and block comments, replacing their characters with spaces and
 * keeping every newline, so an offset into the result is the same offset into
 * the source and line numbers need no separate bookkeeping. String literals are
 * tracked so a `//` inside one does not open a comment.
 */
function blankComments(source) {
  const out = source.split('');
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      i++;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (char === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') {
        out[i] = ' ';
        i++;
      }
      continue;
    }
    if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (; i < stop; i++) if (source[i] !== '\n') out[i] = ' ';
      continue;
    }
    i++;
  }
  return out.join('');
}

/**
 * Every module specifier a declaration file can name, in the forms tsc emits:
 * `from '...'`, a bare side-effect `import '...'`, type-position
 * `import('...')`, `import x = require('...')`, `declare module '...'`, and the
 * `/// <reference types="..." />` directive.
 */
const SPECIFIER_FORMS = [
  [/(?:^|[\s;})])(?:import|export)\b[^;'"`]*?\bfrom\s*['"]([^'"]+)['"]/g, 'from'],
  [/(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g, 'side-effect import'],
  [/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, 'import()'],
  [/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, 'require()'],
  [/\bdeclare\s+module\s+['"]([^'"]+)['"]/g, 'declare module'],
];

const REFERENCE_TYPES = /\/\/\/\s*<reference\s+types\s*=\s*['"]([^'"]+)['"]/g;

/** The pg package family. `pgsql`, `pgvector` and the like are not in it. */
function isPgFamily(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return false;
  return /^pg$|^pg[/-]|^@types\/pg(?:\/|$)/.test(specifier);
}

function lineAt(source, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (source[i] === '\n') line++;
  return line;
}

/** Every pg-family reference in one declaration file's text. */
function findPgReferences(source) {
  const hits = [];
  for (const match of source.matchAll(REFERENCE_TYPES)) {
    if (isPgFamily(match[1])) {
      hits.push({ specifier: match[1], form: 'reference types', line: lineAt(source, match.index) });
    }
  }
  const code = blankComments(source);
  for (const [pattern, form] of SPECIFIER_FORMS) {
    for (const match of code.matchAll(pattern)) {
      if (isPgFamily(match[1])) {
        hits.push({ specifier: match[1], form, line: lineAt(code, match.index) });
      }
    }
  }
  return hits;
}

// Self-test before scanning anything. A matcher that silently stopped matching
// would turn this guard into a green light for the exact regression it exists
// to stop, and the widened specifier set is precisely the kind of pattern that
// can be edited into uselessness. Drive it with every forbidden form, then with
// the shapes that must NOT fire: the relative import of our own pg-types
// module, unrelated bare packages, a `pg`-prefixed package that is not in the
// family, and prose in a doc comment spelling the import forms out literally.
{
  const bad = findPgReferences(
    [
      "import { Pool } from 'pg';",
      'import { PoolClient } from "pg";',
      "export { Pool } from 'pg';",
      "import 'pg';",
      "declare const p: import('pg').Pool;",
      'declare const q: import("pg-protocol").Parser;',
      "declare const r: import('pg/lib/result');",
      "import pg = require('pg');",
      "declare module 'pg' {}",
      "declare const s: import('@types/pg');",
      '/// <reference types="pg" />',
    ].join('\n'),
  );
  const good = findPgReferences(
    [
      "import type { PgCompatPool } from './pg-types.js';",
      "export type { PgCompatPool } from '../pg-types.js';",
      "import { Pool } from 'pgsql-driver';",
      "declare const a: import('mysql2/promise').Pool;",
      "import { EventEmitter } from 'node:events';",
      '/// <reference types="node" />',
      "/** Use it as: import { Pool } from 'pg'; and never from 'pg/lib/result'. */",
      '/* declare const x: import("pg").Pool; */',
      "// import pg = require('pg');",
    ].join('\n'),
  );
  if (bad.length !== 11 || good.length !== 0) {
    console.error(
      `check-no-pg-types: matcher self-test failed (expected 11 hits and 0 false positives, got ${bad.length} and ${good.length}); the guard cannot be trusted, refusing to pass`,
    );
    process.exit(1);
  }
}

let distExists = false;
try {
  distExists = statSync(distDir).isDirectory();
} catch {
  distExists = false;
}
if (!distExists) {
  console.error(
    `::error file=package.json::check-no-pg-types: ${relative(repoRoot, distDir)} does not exist. This gate reads the BUILT declarations, so run \`npm run build\` first; passing without them would be vacuous.`,
  );
  process.exit(1);
}

const violations = [];
let scanned = 0;
for (const file of declarationFilesUnder(distDir)) {
  scanned += 1;
  for (const hit of findPgReferences(readFileSync(file, 'utf-8'))) {
    violations.push({ file: relative(repoRoot, file), ...hit });
  }
}

if (scanned === 0) {
  console.error(
    'check-no-pg-types: scanned zero declaration files under dist/; the build layout has moved, so this check would pass vacuously. Refusing to pass.',
  );
  process.exit(1);
}

if (violations.length > 0) {
  console.error(
    '::error file=src/pg-types.ts::A pg type name reached the published declarations. @types/pg is a devDependency, so this breaks every consumer compiling under strict. Use the PgCompat* interfaces from src/pg-types.ts instead of pg.Pool / pg.PoolClient / pg.QueryResult.',
  );
  console.error('Offending declarations:');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}: ${v.form} '${v.specifier}'`);
  }
  console.error(
    "\nA deep specifier (pg/lib/*, pg-protocol) breaks consumers even WITH @types/pg installed, because it is not what that package declares. Those live behind types/pg-internal.d.ts and must not reach an exported declaration.",
  );
  process.exit(1);
}

console.log(`check-no-pg-types: ${scanned} declaration files scanned under dist/, no pg-family type references`);
