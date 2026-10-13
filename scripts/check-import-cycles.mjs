#!/usr/bin/env node
/**
 * Guard, in two passes:
 *
 *   1. No value import of client.ts from src/query/** or src/cli/**, static
 *      or dynamic. One named rule about one file, documented in full below.
 *      Beside it, no DYNAMIC value import of any of the package's own modules
 *      from library code (src/ minus src/test/** and src/cli/**), for the size
 *      reason given under "Forbidden" below.
 *   2. No runtime import cycle anywhere under src/ (excluding src/test/**),
 *      found by Tarjan SCC over the whole value-edge graph. Pass 1 is a rule
 *      and cannot see a cycle it was not told about; pass 2 is the detector.
 *      Its own reasoning lives beside it, at the bottom of this file.
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
 *   - Type-position `import('../client.js').X` inside a cast, and
 *     `typeof import('../client.js')`: type-only.
 *
 * When a module here genuinely needs a runtime value from client.ts, client.ts
 * hands it over instead: it registers the value with a leaf module when it is
 * evaluated (src/transaction-client-slot.ts is the pattern, and how
 * query/builder.ts gets TransactionClient for an implicit transaction).
 *
 * Forbidden, besides the static forms below: a DYNAMIC value import,
 * `await import('../client.js')` or `import('../client.js').then(...)`. It
 * used to be the sanctioned escape hatch (query/builder.ts had one until the
 * registration slot replaced it), and it is not a cycle at runtime, but a
 * bundler that does not split code inlines the target and wraps client.ts and
 * its whole static graph in lazy-init closures to keep its evaluation lazy:
 * about 1 kB brotli on every entry, for a module that is always already loaded.
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
import { dirname, join, relative, resolve, sep } from 'node:path';
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
// Any `import('...')` call, with what precedes and follows it, so the type
// positions can be told apart from a value import: `typeof import(...)` and
// `import(...).Member` (a type reference, as in a cast) are type-only, while
// `await import(...)`, `import(...).then(...)` and a bare `import(...)` load
// the module at run time.
const dynamicImportRe = /(\btypeof\s+)?\bimport\(\s*['"]([^'"]+)['"]\s*\)(\s*\.\s*([A-Za-z_$][\w$]*))?/g;
const PROMISE_MEMBERS = new Set(['then', 'catch', 'finally']);

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
  for (const [, typeofPrefix, spec, , member] of source.matchAll(dynamicImportRe)) {
    if (!resolvesToClient(file, spec)) continue;
    if (typeofPrefix) continue;
    if (member !== undefined && !PROMISE_MEMBERS.has(member)) continue;
    violations.push({ file, statement: `import('${spec}')${member ? `.${member}(...)` : ''} (dynamic)` });
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
      "const { TransactionClient } = await import('../client.js');",
      "const lazy = import('../client.js').then((m) => m.TransactionClient);",
      "const m = await import(\n  '../client.js'\n);",
    ].join('\n')
  );
  const good = findViolations(
    fixtureFile,
    [
      "import type { PgCompatPool } from '../client.js';",
      "export type { PgCompatPool } from '../client.js';",
      "type X = import('../client.js').PgCompatPoolClient;",
      "const c = pool as unknown as import('../client.js').PgCompatPoolClient;",
      "type M = typeof import('../client.js');",
      "const n = await import('../not-client.js');",
      "import { quoteIdent } from './utils.js';",
      "import { something } from '../not-client.js';",
      "import './not-client.js';",
    ].join('\n')
  );
  if (bad.length !== 11 || good.length !== 0) {
    console.error(
      `check-import-cycles: matcher self-test failed (expected 11 violations and 0 false positives, got ${bad.length} and ${good.length}); the guard cannot be trusted, refusing to pass`
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
  console.error('Value import of client.ts from a module that must not depend on it:');
  for (const v of violations) {
    console.error(`  ${relative(repoRoot, v.file)}: ${v.statement}`);
  }
  console.error(
    '\nclient.ts imports query/, so a static edge is a cycle. Use `import type` for types. If a runtime value is genuinely needed, have client.ts register it with a leaf module when it is evaluated (see src/transaction-client-slot.ts), not a dynamic `import(...)`: a non-splitting bundler wraps the whole client graph in lazy-init closures for one.'
  );
  process.exit(1);
}

console.log(`check-import-cycles: ${scanned} files scanned under ${scanRoots.join(', ')}, no value import of client.ts`);

// ---------------------------------------------------------------------------
// Pass 1b: no dynamic value import of the package's own modules from library
// code. The size cost described above is not particular to client.ts: any
// `await import('./x.js')` makes a non-splitting bundler wrap x.ts and its
// static graph in lazy-init closures. powql.ts (TransactionClient) and powdb.ts
// (PowqlInterface, which it also re-exported statically) each had one until
// 0.90.1. A peer driver is loaded through importOptionalPeer with a bare
// specifier, which this does not match. The CLI is exempt: it is Node-only and
// may load a subcommand lazily on purpose.

function findOwnDynamicImports(file, source) {
  const found = [];
  for (const [, typeofPrefix, spec, , member] of source.matchAll(dynamicImportRe)) {
    if (!spec.startsWith('.')) continue;
    if (typeofPrefix) continue;
    if (member !== undefined && !PROMISE_MEMBERS.has(member)) continue;
    found.push({ file, statement: `import('${spec}')${member ? `.${member}(...)` : ''} (dynamic)` });
  }
  return found;
}

{
  const fixtureFile = join(repoRoot, 'src/__dynamic_import_fixture__.ts');
  const bad = findOwnDynamicImports(
    fixtureFile,
    [
      "const { PowqlInterface } = await import('./powql.js');",
      "const m = import('./query/index.js').then((x) => x);",
      "const n = await import(\n  '../schema.js'\n);",
    ].join('\n')
  );
  const good = findOwnDynamicImports(
    fixtureFile,
    [
      "type X = import('./client.js').PgCompatPoolClient;",
      "type M = typeof import('./powql.js');",
      "const mysql = await import('mysql2/promise');",
      "const peer = await importOptionalPeer('mssql');",
    ].join('\n')
  );
  if (bad.length !== 3 || good.length !== 0) {
    console.error(
      `check-import-cycles: pass 1b self-test failed (expected 3 violations and 0 false positives, got ${bad.length} and ${good.length}); refusing to pass`
    );
    process.exit(1);
  }
}

const libraryFiles = tsFilesUnder(join(repoRoot, 'src')).filter((f) => {
  const rel = relative(join(repoRoot, 'src'), f).split(sep);
  return rel[0] !== 'test' && rel[0] !== 'cli';
});
if (libraryFiles.length === 0) {
  console.error('check-import-cycles: pass 1b scanned zero files, refusing to pass vacuously');
  process.exit(1);
}
const ownDynamic = libraryFiles.flatMap((f) => findOwnDynamicImports(f, readFileSync(f, 'utf-8')));
if (ownDynamic.length > 0) {
  console.error('Dynamic import of one of the package\'s own modules from library code:');
  for (const v of ownDynamic) console.error(`  ${relative(repoRoot, v.file)}: ${v.statement}`);
  console.error(
    '\nImport it statically. If that would be a cycle, have the module that owns the value register it with a leaf module when it is evaluated (see src/transaction-client-slot.ts).'
  );
  process.exit(1);
}
console.log(`check-import-cycles: pass 1b scanned ${libraryFiles.length} library files, no dynamic import of an own module`);

// ---------------------------------------------------------------------------
// Pass 2: real cycle detection over the whole value-import graph.
//
// Pass 1 enforces ONE edge in TWO directories against ONE file. It is a rule,
// not a detector, and it cannot see a cycle anywhere else. It also scans only
// `import` statements, while `export ... from` is a runtime edge exactly like
// an import: both edges of the PowDB cycle this pass was written to find were
// re-exports, so a scan for `import` alone found nothing at all. That cycle is
// gone (its shared primitives live in src/powdb-shared.ts), which is why the
// allowlist below is empty; it stays because the next one will be found the
// same way.
// ---------------------------------------------------------------------------

/**
 * Value edges only: `import type` and `export type` are erased at compile time.
 *
 * The head is `[^;'"]*?`, the same shape pass 1's staticEdgeRe already uses,
 * and that restriction is load-bearing rather than stylistic. A permissive
 * `[\s\S]*?` head lets one match start at an `export`/`import` line that has no
 * `from` clause (an exported interface, a default `import x from 'pg'`) and run
 * forward to the next `from '...'` several statements away. Measured on this
 * repo, that produced 25 statement-spanning matches, inventing a `client.ts ->
 * client.js` self edge and a `./metadata${ext}` target, counting a type-only
 * import as a value edge, and swallowing whatever real edges lay between. A
 * head that cannot contain `;` or a quote cannot leave the statement it began.
 */
const EDGE_RE = /(?:^|\n)[ \t]*((?:import|export)\b[^;'"]*?)\bfrom\s*['"](\.[^'"]+)['"]/g;

/**
 * Bare side-effect import: `import './x.js';`. No `from` clause, so EDGE_RE
 * cannot see it, and it is a runtime edge like any other.
 */
const BARE_EDGE_RE = /(?:^|\n)[ \t]*import\s*['"](\.[^'"]+)['"]/g;

/** Known cycles, each with the reason it is tolerated and who removes it. */
const KNOWN_CYCLES = [];

/**
 * Every specifier list on a statement head, with the leading keyword removed.
 * `import { type A, b }` still has a value edge via `b`; `import { type A }`
 * does not, because under verbatimModuleSyntax it emits nothing.
 */
function isAllTypeSpecifiers(head) {
  const names = head
    .replace(/^(?:import|export)\b/, '')
    .replace(/[{}]/g, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return names.length > 0 && names.every((n) => /^type\s/.test(n));
}

/** The relative specifiers `source` depends on at runtime. */
function valueEdgeSpecifiers(source) {
  const specs = [];
  for (const [, head, spec] of source.matchAll(EDGE_RE)) {
    const h = head.trim();
    // `import type ... from` / `export type ... from`: fully erased.
    if (/^(?:import|export)\s+type\b/.test(h)) continue;
    if (isAllTypeSpecifiers(h)) continue;
    specs.push(spec);
  }
  for (const [, spec] of source.matchAll(BARE_EDGE_RE)) specs.push(spec);
  return specs;
}

/**
 * Resolve a specifier written in `file` to a module in `fileSet`, honouring the
 * NodeNext convention of naming the EMITTED file: `./x.js` is `x.ts`, and the
 * `.cjs` / `.mjs` forms name `.cts` / `.mts` (that is how the optional-peer
 * helper is imported). Anything that resolves outside the set is not a node of
 * this graph and cannot take part in a cycle within it.
 */
function resolveModule(file, spec, fileSet) {
  const base = resolve(dirname(file), spec);
  const candidates = [
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.cjs$/, '.cts'),
    base.replace(/\.mjs$/, '.mts'),
    `${base}.ts`,
  ];
  for (const candidate of candidates) {
    if (fileSet.has(candidate)) return candidate;
  }
  return null;
}

/** Build the runtime module graph under `root`, excluding the test tree. */
function moduleEdges(root) {
  const testDir = join(root, 'test') + sep;
  const files = tsFilesUnder(root).filter((f) => !f.startsWith(testDir));
  const fileSet = new Set(files);
  const graph = new Map();
  for (const file of files) {
    const out = new Set();
    for (const spec of valueEdgeSpecifiers(readFileSync(file, 'utf-8'))) {
      const target = resolveModule(file, spec, fileSet);
      if (target) out.add(target);
    }
    graph.set(file, out);
  }
  return { graph, files };
}

/** Tarjan's SCC. Returns components with more than one member. */
function findCycles(graph) {
  let idx = 0;
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const comps = [];
  function strongconnect(v) {
    index.set(v, idx);
    low.set(v, idx);
    idx++;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)));
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) comps.push(comp);
    }
  }
  for (const v of graph.keys()) if (!index.has(v)) strongconnect(v);
  return comps;
}

// Self-test 1, the edge matcher. The cycle this pass exists to find is built
// from `export ... from` re-exports, so a matcher that quietly stopped seeing
// them would report a clean graph and prove nothing. Drive it with every form
// that IS a runtime edge and every form that is not.
{
  const found = valueEdgeSpecifiers(
    [
      "import { PowqlInterface } from './edge-a.js';",
      "import PowqlInterface from './edge-b.js';",
      "import { type PowdbCapabilities, quotePowqlIdent } from './edge-c.js';",
      "export { PowqlInterface } from './edge-d.js';",
      "export {\n  introspectPowdbDatabase,\n  type PowdbExec,\n} from './edge-e.js';",
      "export * from './edge-f.js';",
      "import './edge-g.js';",
    ].join('\n')
  );
  const notEdges = valueEdgeSpecifiers(
    [
      "import type { PowdbExec } from './no-a.js';",
      "export type { PowdbCapabilities } from './no-b.js';",
      "export {\n  type PowdbExec,\n  type PowdbIntrospectOptions,\n} from './no-c.js';",
      "const m = await import('./no-d.js');",
      "type X = import('./no-e.js').PowdbExec;",
      "import pg from 'pg';",
      "export interface NoF {\n  field: string;\n}\nimport type { NoG } from './no-g.js';",
    ].join('\n')
  );
  const expected = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((s) => `./edge-${s}.js`);
  if (found.join(',') !== expected.join(',') || notEdges.length !== 0) {
    console.error(
      `check-import-cycles: pass 2 edge-matcher self-test failed (expected ${expected.join(', ')} and no false positives, got ${found.join(', ') || '<none>'} and ${notEdges.join(', ') || '<none>'}); the guard cannot be trusted, refusing to pass`
    );
    process.exit(1);
  }
}

// Self-test 2, the detector. It must find the cycle in a synthetic two-node
// graph, and must NOT invent one in an acyclic graph of the same size.
{
  const cyclic = new Map([
    ['a', new Set(['b'])],
    ['b', new Set(['a'])],
  ]);
  const acyclic = new Map([
    ['a', new Set(['b'])],
    ['b', new Set()],
  ]);
  if (findCycles(cyclic).length !== 1 || findCycles(acyclic).length !== 0) {
    console.error('check-import-cycles: SCC self-test failed; the detector cannot be trusted, refusing to pass');
    process.exit(1);
  }
}

const { graph, files: moduleFiles } = moduleEdges(join(repoRoot, 'src'));

if (moduleFiles.length === 0) {
  console.error('check-import-cycles: pass 2 scanned zero files, refusing to pass vacuously');
  process.exit(1);
}

const unexpected = [];
for (const comp of findCycles(graph)) {
  const key = comp
    .map((f) => relative(repoRoot, f))
    .sort()
    .join(' <-> ');
  if (KNOWN_CYCLES.includes(key)) {
    console.log(`check-import-cycles: known cycle (allowlisted): ${key}`);
    continue;
  }
  unexpected.push(key);
}

if (unexpected.length > 0) {
  console.error('check-import-cycles: runtime import cycle detected:');
  for (const c of unexpected) console.error(`  ${c}`);
  console.error('');
  console.error('These modules import each other as VALUES, so one executes while the other');
  console.error('is half-initialized. `export ... from` counts: it is a runtime edge like an');
  console.error('import. Fix: hoist the shared symbols into a leaf module (see pg-types.ts');
  console.error('and connection-url.ts for the pattern), or make the edge `import type`.');
  process.exit(1);
}

console.log(`check-import-cycles: pass 2 scanned ${moduleFiles.length} files, no unexpected cycles`);
