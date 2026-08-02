#!/usr/bin/env node
/**
 * Guard: no static value import of client.ts from src/query/** or src/cli/**.
 *
 * ## Why this exists
 *
 * The dependency rule that keeps the module graph acyclic is prose in
 * CLAUDE.md ("Don't import client.ts from query/"), and prose does not fail a
 * build. client.ts imports query/, so a static value import in the other
 * direction is a real cycle: it typechecks, both bundlers and Node will
 * "handle" it by executing one module with the other half-initialized, and the
 * failure surfaces later as an undefined binding at runtime in whichever file
 * loads first. The same rule covers src/cli/**: the CLI imports generate/
 * introspect/schema-sql and QueryInterface, never the client, so Studio and
 * the other commands stay usable without pulling the pooling layer in.
 *
 * ## What is allowed, and why
 *
 *   - `import type { X } from '../client.js'`: erased at compile time, no
 *     runtime edge, no cycle. This is how cli/studio.ts consumes PgCompatPool.
 *   - Dynamic `await import('../client.js')`: a deliberate lazy edge, resolved
 *     at call time when both modules are fully initialized. The one sanctioned
 *     site is in query/builder.ts (interactive transactions need
 *     TransactionClient), noted in CLAUDE.md.
 *   - Type-position `import('../client.js').X` inside a cast: type-only.
 *
 * Forbidden: `import { X } from`, `import X from`, `export ... from`, bare
 * `import '../client.js'` (a side-effect import IS a runtime edge, and
 * client.ts is the module with the process-global side effects someone would
 * reach for it to trigger), and `require(...)`, including the mixed
 * `import { type A, B }` form. An all-type inline form
 * (`import { type A } from`) is also refused: under verbatimModuleSyntax it
 * emits `import {}`, a real edge, and `import type` says the same thing
 * unambiguously. `export type ... from` IS allowed: it is fully erased.
 *
 * Known strictness: an import statement at line start inside a BLOCK comment
 * is flagged even though it compiles to nothing. Deliberate: distinguishing
 * comment state needs a real parser, and deleting a commented-out cycle is
 * never the wrong fix.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clientModule = resolve(repoRoot, 'src/client.ts');
const scanRoots = ['src/query', 'src/cli'];

function tsFilesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(full));
    else if (/\.(ts|cts|mts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Does this import specifier, written in `file`, resolve to src/client.ts? */
function resolvesToClient(file, spec) {
  if (!spec.startsWith('.')) return false;
  const resolved = resolve(dirname(file), spec).replace(/\.js$/, '.ts');
  return resolved === clientModule;
}

/**
 * Static import/export statements that create a module-graph edge. Dynamic
 * `import('...')` and type-position `import('...').X` never match: neither has
 * a `from` clause or an `export`/`import` statement head followed by one.
 */
const staticEdgeRe = /(?:^|\n)[ \t]*((?:import|export)\b[^;'"]*?)\bfrom\s*['"]([^'"]+)['"]/g;
// Bare side-effect import: `import '../client.js';`. No `from`, so the edge
// matcher above cannot see it, and it is the form someone reaches for to
// trigger client.ts's process-global registrations. Still a runtime edge.
const bareImportRe = /(?:^|\n)[ \t]*import\s*['"]([^'"]+)['"]/g;
const requireRe = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

function findViolations(file, source) {
  const violations = [];
  for (const [, head, spec] of source.matchAll(staticEdgeRe)) {
    if (!resolvesToClient(file, spec)) continue;
    // `import type` and `export type ... from` are both fully erased under
    // verbatimModuleSyntax: no runtime edge, no cycle.
    if (/^(?:import|export)\s+type\b/.test(head.trim())) continue;
    violations.push({ file, statement: `${head.trim()} from '${spec}'` });
  }
  for (const [, spec] of source.matchAll(bareImportRe)) {
    if (!resolvesToClient(file, spec)) continue;
    violations.push({ file, statement: `import '${spec}'` });
  }
  for (const [, spec] of source.matchAll(requireRe)) {
    if (!resolvesToClient(file, spec)) continue;
    violations.push({ file, statement: `require('${spec}')` });
  }
  return violations;
}

// Self-test before scanning anything: a matcher that silently stopped matching
// would turn this guard into a green light for the exact bug it exists to
// stop. Drive it with a fixture that contains every forbidden form plus every
// allowed one, from a path where '../client.js' resolves to src/client.ts.
{
  const fixtureFile = join(repoRoot, 'src/query/__cycle_guard_fixture__.ts');
  const bad = findViolations(
    fixtureFile,
    [
      "import { TurbineClient } from '../client.js';",
      "import TurbineClient from '../client.js';",
      "import { type PgCompatPool, TurbineClient } from '../client.js';",
      "import { type PgCompatPool } from '../client.js';",
      "export { TurbineClient } from '../client.js';",
      "export * from '../client.js';",
      "import '../client.js';",
      "const c = require('../client.js');",
    ].join('\n')
  );
  const good = findViolations(
    fixtureFile,
    [
      "import type { PgCompatPool } from '../client.js';",
      "export type { PgCompatPool } from '../client.js';",
      "const { TransactionClient } = await import('../client.js');",
      "type X = import('../client.js').PgCompatPoolClient;",
      "import { quoteIdent } from './utils.js';",
      "import { something } from '../not-client.js';",
      "import './not-client.js';",
    ].join('\n')
  );
  if (bad.length !== 8 || good.length !== 0) {
    console.error(
      `check-import-cycles: matcher self-test failed (expected 8 violations and 0 false positives, got ${bad.length} and ${good.length}); the guard cannot be trusted, refusing to pass`
    );
    process.exit(1);
  }
}

const violations = [];
let scanned = 0;
for (const root of scanRoots) {
  for (const file of tsFilesUnder(join(repoRoot, root))) {
    scanned += 1;
    violations.push(...findViolations(file, readFileSync(file, 'utf-8')));
  }
}

if (scanned === 0) {
  console.error('check-import-cycles: scanned zero files; the scan roots have moved, refusing to pass vacuously');
  process.exit(1);
}

if (violations.length > 0) {
  console.error('Static value import of client.ts from a module that must not depend on it:');
  for (const v of violations) {
    console.error(`  ${relative(repoRoot, v.file)}: ${v.statement}`);
  }
  console.error(
    '\nclient.ts imports query/, so this edge is a cycle. Use `import type` for types, or a dynamic `await import(...)` if a runtime value is genuinely needed (see the sanctioned site in query/builder.ts).'
  );
  process.exit(1);
}

console.log(`check-import-cycles: ${scanned} files scanned under ${scanRoots.join(', ')}, no static value import of client.ts`);
