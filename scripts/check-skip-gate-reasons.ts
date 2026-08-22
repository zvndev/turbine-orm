#!/usr/bin/env tsx
/**
 * `TURBINE_REQUIRE_ENGINE` coupling guard. Three checks, all closing the same
 * hole from different sides.
 *
 * ## Why this exists
 *
 * `skipGate(skip, reason)` in src/test/helpers.ts decides whether a CI job that
 * exists to run an engine's suite is allowed to SKIP that suite instead, and it
 * decides it by matching the human-readable `reason` string against
 * `ENGINE_GATE_PATTERNS`. That coupling is invisible: a reason reworded in a
 * routine cleanup ("DATABASE_URL not set" -> "no database configured") stops
 * matching, the gate goes back to skipping silently, and the job it was written
 * to protect reports GREEN over a suite that never ran. That is the exact
 * failure `TURBINE_REQUIRE_ENGINE` was introduced to catch, reintroduced one
 * level up, and nothing downstream re-asks.
 *
 * It already happened twice in the shipping cut of this feature: four PowDB
 * addon-VERSION gates said `requires @zvndev/powdb-embedded >= 0.18 (...)`,
 * which the `powdb` pattern did not match, so the powdb job never required them;
 * and one gate whose real condition was `!url || !haveTsx` said "no DATABASE_URL
 * (or tsx)", so a missing tsx failed the job blaming the database.
 *
 * ## The three checks
 *
 *  1. EVERY REASON IS CLAIMED. Each `skipGate` reason in src/test/** either
 *     matches a pattern in `ENGINE_GATE_PATTERNS` (some job can require it) or
 *     appears in {@link NON_ENGINE_GATES} with a written reason why no job can.
 *     The allowlist is exact-match and self-documenting, so adding to it is a
 *     decision someone makes on purpose.
 *
 *  2. EVERY TOKEN IS SET SOMEWHERE. Each key of `ENGINE_GATE_PATTERNS` appears
 *     in at least one `TURBINE_REQUIRE_ENGINE:` value in .github/workflows/**.
 *     A token no job sets is a gate nothing enforces, which is how `sqlite` came
 *     to be defined, documented, and inert.
 *
 *  3. EVERY TOKEN A WORKFLOW NAMES EXISTS. The reverse direction: a typo in a
 *     workflow (`TURBINE_REQUIRE_ENGINE: postgress`) throws at test time, but
 *     only in the job that has it, and only once someone reads the log.
 *
 *  4. EVERY FILE THAT CALLS `turbineSqlite()` IS GATED ON `node:sqlite`. Added
 *     0.76.0 after `src/test/sqlite-error-classification.test.ts` shipped
 *     ungated: it passed lint, typecheck, the full local suite, the coverage
 *     gates and the entire `prepublishOnly` chain, and failed only on the
 *     `unit-tests (20)` matrix leg, which is to say after the release was
 *     published. Checks 1-3 could not see it, and that is the point: they all
 *     validate gates that EXIST, and this one asks whether a gate exists.
 *
 *     SQLITE ONLY, on purpose. Its precondition is a Node VERSION (`node:sqlite`
 *     is a builtin only on >= 22.5), so it holds on every developer machine and
 *     on three of the four unit-matrix legs, which is exactly what makes a
 *     missing gate invisible until CI. The other three engines gate on an env
 *     var or an optional peer that CI sets deliberately and that fails loudly in
 *     the one job that owns it. Extending this to them was tried and produced
 *     eight false positives on correctly-ungated build-only suites (a test that
 *     asserts `mssqlDialect` emits SQL Server SQL through a mock driver needs no
 *     server), and an allowlist that long is the failure mode this file's own
 *     doctrine warns about.
 *
 *     Deliberately shape-agnostic: it looks for the reason TEXT, not for a
 *     `skipGate` call, because `src/test/sqlite.test.ts` hand-rolls its own
 *     `{ skip: ... }` wrapper and is correctly gated. The reason text is what
 *     `TURBINE_REQUIRE_ENGINE` matches on, so it is the thing that has to be
 *     right either way.
 *
 * Plus the anti-vacuous-pass rule this repo's other guards already follow (see
 * scripts/check-import-cycles.mjs and scripts/check-error-codes.ts): if the scan
 * finds zero call sites or zero workflow declarations, the layout has moved and
 * the check FAILS rather than passing over nothing.
 *
 * Run: tsx scripts/check-skip-gate-reasons.ts
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_GATE_PATTERNS } from '../src/test/helpers.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testDir = join(repoRoot, 'src/test');
const workflowDir = join(repoRoot, '.github/workflows');

/**
 * Reasons that are deliberately NOT engine-availability gates, each with the
 * reason no `TURBINE_REQUIRE_ENGINE` token can ever claim it.
 *
 * Exact string match, not a pattern: an entry here suppresses a build failure,
 * so it must name the one reason it excuses and not a family of them.
 */
const NON_ENGINE_GATES: Readonly<Record<string, string>> = {
  'set POWDB_URL to run the live networked PowDB suite':
    'CI runs no PowDB server. The embedded addon is the engine CI exercises (job: powdb-integration), ' +
    'and the networked transport has no container to point at, so no job can require this suite.',
  'no generated @prisma/client to compare against':
    'Compares Turbine option surface against a REAL generated Prisma client, which is not a dependency ' +
    'of this repo and is not installed in CI. The check is opportunistic by design.',
  'tsx is not installed in node_modules (run npm ci)':
    'A missing devDependency, not a missing database. Unreachable in practice (this suite runs UNDER ' +
    'tsx), and no engine token should claim it, or a broken install would be reported as a database problem.',
};

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Blank out `//` and block comments, preserving length and newlines so reported
 * line numbers still point at the source.
 *
 * Needed because these files DOCUMENT the mechanism they use: pgvector.test.ts
 * writes "skipGate(), and `t.skip()` covers a missing extension" in a doc
 * comment, which a raw text scan reads as a call site with no reason. String and
 * template literals are treated as opaque so a `//` inside a reason (a URL, a
 * path) is not mistaken for a comment.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const char = source[i]!;
    const next = source[i + 1];
    if (char === "'" || char === '"' || char === '`') {
      const start = i;
      i++;
      while (i < source.length) {
        if (source[i] === '\\') i += 2;
        else if (source[i] === char) {
          i++;
          break;
        } else i++;
      }
      out += source.slice(start, i);
      continue;
    }
    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (char === '/' && next === '*') {
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i += 2;
      continue;
    }
    out += char;
    i++;
  }
  return out;
}

/**
 * The reason ARGUMENT of every `skipGate(...)` call in a source file, as the set
 * of string literals it can evaluate to.
 *
 * Every literal is collected, not just the first, because a reason may be a
 * ternary over two preconditions and EACH branch has to be claimed (the
 * migrate-from-prisma gate is exactly that shape). A reason expression holding
 * no literal at all is reported as unreadable rather than skipped: this check is
 * only as good as its ability to see what it is checking.
 */
function skipGateReasons(rawSource: string): { literals: string[]; line: number }[] {
  const source = stripComments(rawSource);
  const out: { literals: string[]; line: number }[] = [];
  const call = /\bskipGate\s*\(/g;
  let match: RegExpExecArray | null = call.exec(source);
  while (match !== null) {
    const argsStart = match.index + match[0].length;
    // Walk to the matching close paren, tracking string state so a paren or a
    // comma inside a reason string is not read as syntax.
    let depth = 0;
    let end = -1;
    let quote: string | null = null;
    for (let i = argsStart; i < source.length; i++) {
      const char = source[i];
      if (quote !== null) {
        if (char === '\\') i++;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === "'" || char === '"' || char === '`') quote = char;
      else if (char === '(' || char === '[' || char === '{') depth++;
      else if (char === ')' && depth === 0) {
        end = i;
        break;
      } else if (char === ')' || char === ']' || char === '}') depth--;
    }
    if (end === -1) break;
    const args = source.slice(argsStart, end);
    // Everything after the FIRST top-level comma is the reason expression.
    const comma = topLevelComma(args);
    const reasonExpr = comma === -1 ? '' : args.slice(comma + 1);
    out.push({
      literals: stringLiterals(reasonExpr),
      line: source.slice(0, match.index).split('\n').length,
    });
    call.lastIndex = end;
    match = call.exec(source);
  }
  return out;
}

/** Index of the first comma at argument depth 0, outside any string. */
function topLevelComma(args: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const char = args[i];
    if (quote !== null) {
      if (char === '\\') i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') quote = char;
    else if (char === '(' || char === '[' || char === '{') depth++;
    else if (char === ')' || char === ']' || char === '}') depth--;
    else if (char === ',' && depth === 0) return i;
  }
  return -1;
}

/** Every string literal in an expression, un-escaped enough to compare. */
function stringLiterals(expr: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < expr.length; i++) {
    const quote = expr[i];
    if (quote !== "'" && quote !== '"' && quote !== '`') continue;
    let value = '';
    i++;
    for (; i < expr.length; i++) {
      if (expr[i] === '\\') {
        value += expr[i + 1] ?? '';
        i++;
        continue;
      }
      if (expr[i] === quote) break;
      value += expr[i];
    }
    out.push(value);
  }
  return out;
}

const tokens = Object.keys(ENGINE_GATE_PATTERNS);
const failures: string[] = [];

// --- Check 1: every reason is claimed -------------------------------------
let scanned = 0;
let reasonCount = 0;
for (const file of testFiles(testDir)) {
  const source = readFileSync(file, 'utf-8');
  if (!source.includes('skipGate')) continue;
  // helpers.ts declares skipGate; it has no call sites of its own.
  if (file === join(testDir, 'helpers.ts')) continue;
  scanned++;
  for (const { literals, line } of skipGateReasons(source)) {
    reasonCount++;
    const where = `${relative(repoRoot, file)}:${line}`;
    if (literals.length === 0) {
      failures.push(
        `${where}: the reason argument holds no string literal, so this guard cannot read it. ` +
          `Pass a literal (a ternary of literals is fine).`,
      );
      continue;
    }
    for (const reason of literals) {
      const claimedBy = tokens.filter((token) => ENGINE_GATE_PATTERNS[token]?.test(reason));
      if (claimedBy.length > 0 || reason in NON_ENGINE_GATES) continue;
      failures.push(
        `${where}: reason ${JSON.stringify(reason)} matches no engine pattern in ENGINE_GATE_PATTERNS ` +
          `(${tokens.join(', ')}) and is not in NON_ENGINE_GATES.\n` +
          `    A CI job setting TURBINE_REQUIRE_ENGINE therefore cannot force this suite to run, so it will ` +
          `skip silently under a green job.\n` +
          `    Fix: word the reason so it names the engine's precondition (the env var, or the addon), widen ` +
          `the pattern in src/test/helpers.ts, or add the reason to NON_ENGINE_GATES in this script with why ` +
          `no job can require it.`,
      );
    }
  }
}

if (scanned === 0 || reasonCount === 0) {
  console.error(
    `check-skip-gate-reasons: found ${scanned} file(s) and ${reasonCount} skipGate call site(s) under ` +
      `${relative(repoRoot, testDir)}; the tests have moved or the call shape changed, so this check would ` +
      `pass vacuously. Refusing to pass.`,
  );
  process.exit(1);
}

// --- Checks 2 and 3: tokens and workflows agree ---------------------------
const declared = new Map<string, string[]>();
let workflowFiles = 0;
for (const entry of readdirSync(workflowDir, { withFileTypes: true })) {
  if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
  workflowFiles++;
  const source = readFileSync(join(workflowDir, entry.name), 'utf-8');
  const declaration = /TURBINE_REQUIRE_ENGINE:\s*(.+)/g;
  let match: RegExpExecArray | null = declaration.exec(source);
  while (match !== null) {
    const raw = (match[1] ?? '').trim().replace(/^["']|["']$/g, '');
    for (const token of raw.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)) {
      const seen = declared.get(token) ?? [];
      seen.push(entry.name);
      declared.set(token, seen);
    }
    match = declaration.exec(source);
  }
}

if (workflowFiles === 0 || declared.size === 0) {
  console.error(
    `check-skip-gate-reasons: found ${workflowFiles} workflow file(s) and ${declared.size} ` +
      `TURBINE_REQUIRE_ENGINE declaration(s); refusing to pass vacuously.`,
  );
  process.exit(1);
}

for (const token of tokens) {
  if (declared.has(token)) continue;
  failures.push(
    `ENGINE_GATE_PATTERNS declares the token "${token}", but no job in .github/workflows sets it in ` +
      `TURBINE_REQUIRE_ENGINE.\n` +
      `    A token no job sets enforces nothing: every gate it would claim skips exactly as it did before.\n` +
      `    Fix: set it on the job that runs that engine's suite, or delete the token.`,
  );
}

for (const [token, files] of declared) {
  if (token in ENGINE_GATE_PATTERNS) continue;
  failures.push(
    `.github/workflows/${[...new Set(files)].join(', ')}: TURBINE_REQUIRE_ENGINE names "${token}", which is not ` +
      `a key of ENGINE_GATE_PATTERNS (${tokens.join(', ')}). skipGate throws on it, so that job fails at ` +
      `module load with a message nobody is looking for.`,
  );
}

/**
 * Reason strings in `{ skip: '…' }` position, the hand-rolled gate shape
 * `src/test/sqlite.test.ts` uses instead of `skipGate`. Both shapes are valid
 * gates, so both count; nothing else in the file does.
 */
function skipPropertyReasons(source: string): string[] {
  const out: string[] = [];
  const prop = /\bskip\s*:\s*(['"`])/g;
  let match: RegExpExecArray | null = prop.exec(source);
  while (match !== null) {
    const quote = match[1]!;
    const start = match.index + match[0].length;
    let i = start;
    while (i < source.length) {
      if (source[i] === '\\') i += 2;
      else if (source[i] === quote) break;
      else i++;
    }
    out.push(source.slice(start, i));
    prop.lastIndex = i + 1;
    match = prop.exec(source);
  }
  return out;
}

// --- Check 4: every engine test file carries that engine's gate -----------

/**
 * `ENGINE_GATE_PATTERNS` key -> the CALL that actually opens a driver.
 *
 * Matched on the factory CALL rather than the module specifier, which is the
 * whole precision of this check. Every engine module exports two very different
 * things: a `Dialect` object (`sqliteDialect`), which is a plain value a
 * build-only test asserts against on any Node version with no driver anywhere,
 * and the factory, which loads one. Gating on the specifier flagged eight
 * correctly-ungated build-only suites.
 */
const ENGINE_DRIVER_IMPORTS: Readonly<Record<string, RegExp>> = {
  sqlite: /\bturbineSqlite\s*\(/,
};

/**
 * A `node:sqlite` AVAILABILITY PROBE: a runtime require/import of the builtin
 * inside a try, which is the only way to learn on Node 20 that it is absent
 * without throwing ERR_UNKNOWN_BUILTIN_MODULE at load.
 *
 * THE INVARIANT IS THE PROBE, not the reason text, and that took two wrong cuts
 * to land on. Matching the reason pattern anywhere in the file is a false
 * negative: the very file this check exists for says "must not still be the
 * node:sqlite object" in an assertion message, which satisfies the pattern while
 * gating nothing. Matching it in skip-REASON position only is a false positive:
 * three correctly-gated files pass their reason through a variable
 * (`skip: sqliteSkip`, a struct field), and a text scan cannot follow that.
 *
 * The probe is what every correctly-gated file actually has and what the ungated
 * one lacked, it is unambiguous in source text, and it is the step that has to
 * happen for any gate to be possible at all. Check 1 then holds the reason
 * string itself to the pattern, so the two checks cover the two halves.
 *
 * Matched as the specifier in CALL position (parenthesized), which covers
 * `require('node:sqlite')`, `import('node:sqlite')` and the
 * `createRequire(process.cwd())('node:sqlite')` form all twenty existing call
 * sites actually use. A `type`-only `from 'node:sqlite'` deliberately does NOT
 * count and has no parens: it is erased at runtime and tells you nothing about
 * whether the builtin is there. (Every gated file has both, which is why the
 * distinction has to be drawn rather than assumed away.)
 */
const NODE_SQLITE_PROBE = /\(\s*['"`]node:sqlite['"`]\s*\)/;

/**
 * Files that import an engine module WITHOUT needing its driver, so no gate is
 * owed. Exact path match, and each entry says why, on the same rule as
 * {@link NON_ENGINE_GATES}: an entry here suppresses a build failure.
 */
const UNGATED_ENGINE_IMPORTS: Readonly<Record<string, string>> = {
  // Empty, and that is the result rather than an oversight: with the check
  // scoped to the `turbineSqlite()` call, every one of the 20 call sites in
  // src/test/** is genuinely gated. The escape hatch stays because the next file
  // that legitimately needs it should record WHY here rather than widen the
  // pattern, on the same rule as NON_ENGINE_GATES above.
};

let engineFilesChecked = 0;
for (const file of testFiles(testDir)) {
  const rel = relative(repoRoot, file).replace(/\\/g, '/');
  const raw = readFileSync(file, 'utf8');
  const source = stripComments(raw);
  // Reason POSITION only, never the whole file. Matching the pattern anywhere
  // is a false negative with teeth: the ungated file this check was written for
  // says "and must not still be the node:sqlite object" in an assertion message,
  // which satisfies `/\bnode:sqlite\b/` while gating nothing. Demonstrated, not
  // supposed: the first cut of this check passed on that exact file.
  for (const [token, driverNames] of Object.entries(ENGINE_DRIVER_IMPORTS)) {
    if (!driverNames.test(source)) continue;
    engineFilesChecked++;
    if (rel in UNGATED_ENGINE_IMPORTS) continue;
    if (NODE_SQLITE_PROBE.test(source)) continue;
    failures.push(
      `${rel}: calls turbineSqlite() without first probing that node:sqlite EXISTS ` +
        `(nothing in the file matches ${NODE_SQLITE_PROBE}).\n` +
        `    node:sqlite is a builtin only on Node >= 22.5, so this file passes on your machine and on three ` +
        `of the four unit-matrix legs, and fails on \`unit-tests (20)\` after review.\n` +
        `    Fix: probe with createRequire(process.cwd())('node:sqlite') in a try/catch and feed the result to ` +
        `skipGate(...) with a reason naming node:sqlite (that text is what TURBINE_REQUIRE_ENGINE=${token} ` +
        `matches, so check 1 will then hold you to it), the shape src/test/sqlite.test.ts uses. Or add this ` +
        `file to UNGATED_ENGINE_IMPORTS with the reason it needs no driver.`,
    );
  }
}

// Anti-vacuous, the same rule checks 1-3 follow: a scan that matched no engine
// import means the specifiers or the layout moved, not that everything is fine.
if (engineFilesChecked === 0) {
  console.error(
    'check-skip-gate-reasons: found no test file calling an engine factory. ' +
      'ENGINE_DRIVER_IMPORTS is stale or src/test/ moved; refusing to pass over nothing.',
  );
  process.exit(1);
}

if (failures.length > 0) {
  console.error(`\ncheck-skip-gate-reasons: ${failures.length} problem(s)\n`);
  for (const failure of failures) console.error(`  ${failure}\n`);
  process.exit(1);
}

console.log(
  `check-skip-gate-reasons: ${reasonCount} skipGate reason(s) across ${scanned} file(s) are all claimed by an ` +
    `engine pattern or allowlisted, and all ${tokens.length} token(s) (${tokens.join(', ')}) are set by a CI job. ` +
    `${engineFilesChecked} engine-factory call site(s) are gated or allowlisted.`,
);
