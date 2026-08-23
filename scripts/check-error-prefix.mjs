#!/usr/bin/env node
/**
 * Guard: no message that reaches a TurbineError may hand-write a `[turbine] `
 * prefix.
 *
 * `formatErrorMessage` (src/errors.ts) prepends `[${code}] ` unless the message
 * already starts with that exact tag. A hand-written `[turbine] ` never matches
 * `[TURBINE_E003]`, so the two prefixes stack:
 *
 *   [TURBINE_E003] [turbine] Unknown column "titel" on table "posts". (…)
 *
 * The tempting objection is that a prefix rule is unnecessary because
 * `formatErrorMessage` already guarantees the `[CODE]` tag. That is true, and
 * it is not the failure mode: the bug is the INTERACTION between the automatic
 * tag and a manual one, which no rule about either one alone can see. That is
 * also why the check has to resolve the enclosing callee rather than match the
 * literal, since the same literal is correct in a diagnostic and wrong in a
 * thrown message.
 *
 * ## What is NOT a violation, and why
 *
 * A `[turbine] ` prefix is correct wherever nothing prepends a code tag. Those
 * sinks are enumerated in {@link DIAGNOSTIC_SINKS} and identified by the
 * CALLEE that encloses the string, not by the file or the line:
 *
 *   - `console.log` / `console.warn` / `console.error` and friends: dev
 *     diagnostics and the once-only warn registry's output. They never pass
 *     through `formatErrorMessage`, and the prefix is the only thing marking
 *     the line as Turbine's in a busy application log.
 *   - `process.stderr.write` / `process.stdout.write`: the same role for the
 *     CLI and the MCP server, which write to the stream directly.
 *   - `sendJson`: Studio's HTTP error payload. It is a response body, not an
 *     Error, and the browser has no other signal of who produced it.
 *   - `Error` / `RangeError` / `TypeError`: plain JS errors, deliberately not
 *     TurbineError (sealed-pool invariants, a socket-destroy cause). Nothing
 *     tags them, so nothing doubles.
 *
 * Everything else is a violation, including a bare `message = \`[turbine] …\``
 * or a `…Message()` helper that returns one, because those are exactly the
 * indirections through which the prefix crept back into error text. The list
 * is an allowlist and not a denylist on purpose: a NEW construction is refused
 * until someone classifies it, which is the direction that fails closed.
 *
 * A helper that BUILDS a string for one of those sinks cannot be recognised by
 * its own callee (it has none), so such a site opts out with a
 * `{@link MARKER}` comment on the line or the line above, stating where the
 * string goes. One site uses it today: Studio's `unknownTableMessage`, whose
 * every caller is a `sendJson` body. The marker is per-site and must say why,
 * so it cannot quietly become a blanket exemption.
 *
 * Fails closed twice, matching scripts/check-import-cycles.mjs: a self-test
 * proves the matcher still fires on the known-bad shapes and stays silent on
 * the known-good ones, and a scan that finds zero files is refused rather than
 * passed.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scanRoot = join(repoRoot, 'src');

/** The literal that must never open an error message. */
const PREFIX = '[turbine] ';

/**
 * Callees whose string arguments are NOT run through `formatErrorMessage`, so
 * a `[turbine] ` there is the only prefix and is correct. See the module doc
 * for the reasoning behind each entry.
 */
const DIAGNOSTIC_SINKS = new Set([
  'console.log',
  'console.warn',
  'console.error',
  'console.info',
  'console.debug',
  'process.stderr.write',
  'process.stdout.write',
  'sendJson',
  'Error',
  'RangeError',
  'TypeError',
]);

/**
 * Per-site opt-out for a string that is built here but consumed by a
 * {@link DIAGNOSTIC_SINKS} callee somewhere else. Must carry a reason.
 */
const MARKER = 'turbine-prefix-ok';

function tsFilesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(full));
    else if (/\.(ts|cts|mts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/**
 * The callee of the innermost call expression enclosing `idx`, or `''` when the
 * position sits in no call at all (a bare assignment, an array literal at
 * statement level).
 *
 * Scans backwards with bracket matching. `{` and `[` at depth zero are stepped
 * OVER rather than treated as a stop, because the shapes that matter are
 * argument objects and argument arrays:
 *
 *   new TimeoutError(0, 'Query', { message: `[turbine] …` })  ->  TimeoutError
 *   sendJson(res, 400, { error: `[turbine] …` })              ->  sendJson
 *
 * Stopping at the `{` would report both as "no callee" and lose the only
 * distinction the allowlist is built on.
 */
function enclosingCallee(source, idx) {
  let depth = 0;
  let open = -1;
  for (let i = idx - 1; i >= 0; i--) {
    const c = source[i];
    if (c === ')' || c === ']' || c === '}') depth++;
    else if (c === '(') {
      if (depth === 0) {
        open = i;
        break;
      }
      depth--;
    } else if (c === '[' || c === '{') {
      if (depth > 0) depth--;
    }
  }
  if (open <= 0) return '';
  const before = source.slice(Math.max(0, open - 120), open);
  const m = before.match(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*$/);
  return m ? m[1] : '';
}

/** True when the line holding `idx` is a comment line (`//`, `/*`, or ` * `). */
function isCommentLine(source, idx) {
  const start = source.lastIndexOf('\n', idx - 1) + 1;
  const line = source.slice(start, idx).trimStart();
  return line.startsWith('//') || line.startsWith('*') || line.startsWith('/*');
}

/**
 * True when the line holding `idx`, or any line of the comment block directly
 * above it, carries the {@link MARKER} opt-out.
 *
 * The whole block, not just the line before: the marker must state where the
 * string goes, that reason rarely fits on one line, and a lookback of exactly
 * one line puts a three-line justification out of reach of the site it
 * justifies. The author then reads an exemption that is not in force.
 */
function hasMarker(source, idx) {
  const lineStart = source.lastIndexOf('\n', idx - 1) + 1;
  const lineEnd = source.indexOf('\n', idx);
  const thisLine = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
  if (thisLine.includes(MARKER)) return true;
  const above = source.slice(0, lineStart === 0 ? 0 : lineStart - 1).split('\n');
  for (let i = above.length - 1; i >= 0; i--) {
    const line = above[i].trimStart();
    if (!(line.startsWith('//') || line.startsWith('*') || line.startsWith('/*'))) return false;
    if (above[i].includes(MARKER)) return true;
  }
  return false;
}

/**
 * Every hand-written `[turbine] ` prefix in `source` that will be doubled.
 * Only an occurrence that OPENS a string literal is a prefix; one in the
 * middle of a concatenation is part of the text and is left alone.
 */
function findViolations(source) {
  const found = [];
  let idx = -1;
  while ((idx = source.indexOf(PREFIX, idx + 1)) !== -1) {
    const quote = source[idx - 1];
    if (quote !== '`' && quote !== "'" && quote !== '"') continue;
    if (isCommentLine(source, idx)) continue;
    if (hasMarker(source, idx)) continue;
    const callee = enclosingCallee(source, idx);
    if (DIAGNOSTIC_SINKS.has(callee)) continue;
    found.push({
      index: idx,
      line: source.slice(0, idx).split('\n').length,
      callee: callee || '<no enclosing call>',
    });
  }
  return found;
}

// Self-test before scanning anything. A matcher that silently stopped matching
// would turn this guard into a green light for the exact bug it exists to stop,
// and an over-eager one would demand the prefix be deleted from the diagnostics
// where it belongs. Drive it with every shape of both.
{
  const bad = findViolations(
    [
      'throw new ValidationError(`[turbine] Unknown table "x".`);',
      "throw new RelationError('[turbine] Unknown relation.');",
      'super(TurbineErrorCode.TIMEOUT, `[turbine] ${context} timed out`);',
      'message = `[turbine] Unique constraint violation`;',
      'return new TimeoutError(0, "Query", { message: "[turbine] canceled" });',
      'const lines = [`[turbine] Refusing to apply migrations:`, ""];',
      'export function m(t) {\n  return `[turbine] Unknown field on "${t}".`;\n}',
    ].join('\n')
  );
  const good = findViolations(
    [
      'throw new ValidationError(`Unknown table "x".`);',
      "console.warn('[turbine] findMany has no limit: this scans the whole table.');",
      'console.log(`[turbine] Using external pool, ${n} tables`);',
      "console.error('[turbine] Unexpected pool error:', err.message);",
      'process.stderr.write(`[turbine] mcp pool error: ${m}\\n`);',
      "sendJson(res, 400, { error: '[turbine] bulk update is not supported' });",
      "throw new Error('[turbine] the compile path must never execute a statement');",
      '// `[turbine] ` is the prefix this guard is about',
      ' *   `[turbine] findUniqueOrThrow on "users" found no record`',
      "const stripped = line.replace('[turbine] ', '');",
      // The marker exempts a helper whose output only reaches a sink. Its
      // negative control is the unmarked `return` helper in `bad` above: the
      // two strings differ only by the marker, so a marker that stopped being
      // read would move this line into the violation count and fail here.
      'function unknownTableMessage(n) {\n  // turbine-prefix-ok: every caller is a sendJson body\n  return `[turbine] Unknown table "${n}".`;\n}',
      // Same again with the marker at the TOP of a multi-line block, which is
      // where a real justification ends up. A one-line lookback misses this.
      'function m2(n) {\n  // turbine-prefix-ok: reaches sendJson only,\n  // never a TurbineError, so nothing tags it.\n  return `[turbine] Unknown table "${n}".`;\n}',
    ].join('\n')
  );
  const badCallees = bad.map((v) => v.callee).join(', ');
  if (bad.length !== 7 || good.length !== 1 || good[0].callee !== 'line.replace') {
    console.error(
      `check-error-prefix: matcher self-test failed (expected 7 violations and 1 known line.replace hit, got ${bad.length} [${badCallees}] and ${good.length} [${good.map((v) => v.callee).join(', ')}]); the guard cannot be trusted, refusing to pass`
    );
    process.exit(1);
  }
}

const testDir = join(scanRoot, 'test') + sep;
const files = tsFilesUnder(scanRoot).filter((f) => !f.startsWith(testDir));

if (files.length === 0) {
  console.error('check-error-prefix: scanned zero files; the scan root has moved, refusing to pass vacuously');
  process.exit(1);
}

const violations = [];
for (const file of files) {
  const source = readFileSync(file, 'utf-8');
  for (const v of findViolations(source)) {
    violations.push(`${relative(repoRoot, file)}:${v.line}  (in ${v.callee})`);
  }
}

if (violations.length > 0) {
  console.error('check-error-prefix: hand-written `[turbine] ` prefix on a message that reaches a TurbineError:');
  for (const v of violations) console.error(`  ${v}`);
  console.error('');
  console.error('formatErrorMessage already prepends `[TURBINE_EXXX] `, so a second');
  console.error('hand-written prefix renders as `[TURBINE_E003] [turbine] ...`.');
  console.error('Fix: delete the `[turbine] ` from the message literal.');
  console.error('');
  console.error('If the string is a diagnostic that no code tag ever touches (a console');
  console.error('call, a stream write, an HTTP body), keep the prefix and add its callee');
  console.error('to DIAGNOSTIC_SINKS in this script, with the reason.');
  process.exit(1);
}

console.log(`check-error-prefix: ${files.length} files scanned under src/, no doubled error prefix`);
