#!/usr/bin/env tsx
/**
 * Error code enforcement. Two checks, in opposite directions:
 *
 *  1. NO UNTRACKED CLASSES. Every `throw new X(...)` in src/ names a known
 *     TurbineError subclass from src/errors.ts (or one of the narrow, explicitly
 *     listed exceptions below).
 *
 *  2. NO UNREACHABLE CODES. Every error class that carries a TURBINE_E* code is
 *     CONSTRUCTED somewhere in production code. `PipelineError` (E014) was
 *     defined, exported, listed in the error table, and documented on the errors
 *     page with a runnable `instanceof` example, while the only `new
 *     PipelineError(` in the whole repo lived in a test: the two pipeline paths
 *     that were supposed to raise it threw the raw driver error instead, one of
 *     them with a `results` property assigned onto it so the DOCUMENTED FIELD
 *     worked and the documented TYPE CHECK never could. Check 1 cannot see that,
 *     because it only ever looks at classes that ARE thrown. This one closes it.
 *
 * Production code here means all of src/ except src/test/**. errors.ts COUNTS:
 * `wrapPgError` is the production construction site for every driver-mapped code
 * (E008-E013, E016), which is exactly how those codes are meant to be reached,
 * and a rule that excluded errors.ts would flag five reachable codes to catch
 * one unreachable one.
 *
 * Run: tsx scripts/check-error-codes.ts
 * Used in CI to prevent untracked error types from shipping.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Known error classes from src/errors.ts
const KNOWN_ERRORS = new Set([
  'TurbineError',
  'NotFoundError',
  'TimeoutError',
  'ValidationError',
  'ConnectionError',
  'RelationError',
  'MigrationError',
  'CircularRelationError',
  'UniqueConstraintError',
  'ForeignKeyError',
  'NotNullViolationError',
  'CheckConstraintError',
  'DeadlockError',
  'SerializationFailureError',
  'PipelineError',
  'OptimisticLockError',
  'ExclusionConstraintError',
  'UnsupportedFeatureError',
  'ReadOnlyError',
  // Typed subclasses of the above defined outside errors.ts:
  // DestructivePushRefusal (schema-sql.ts) extends ValidationError so callers
  // can `instanceof` the refusal instead of sniffing message text.
  'DestructivePushRefusal',
]);

// Also allow standard Error in test files and CLI UI code
const ALLOWED_IN_TESTS = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError']);

// Error classes that are defined AND thrown inside a single CLI-only module.
// They carry no TURBINE_E* code because they never reach a query runtime: the
// CLI catches them and prints them. Scoped per file so the same class name
// cannot be thrown from library code without tripping this check.
//
// PrismaParseError (src/cli/prisma-schema.ts) is the parse failure of the
// zero-dependency schema.prisma reader used by `turbine migrate-from-prisma`.
const FILE_LOCAL_ERRORS = new Map<string, Set<string>>([
  ['src/cli/prisma-schema.ts', new Set(['PrismaParseError'])],
  // The PII guard's refusal callbacks (`refuseColumn` / `refuseDepth` /
  // `refuseShape`) exist so each caller throws ITS OWN error type: Studio throws
  // an HTTP refusal, the MCP server throws a JSON-RPC one. The symmetry test
  // therefore has to supply a third, and a test-local class is the point rather
  // than a shortcut.
  ['src/test/pii-guard-symmetry.test.ts', new Set(['GuardRefusal'])],
]);

function walkDir(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...walkDir(full));
    } else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

const srcDir = join(process.cwd(), 'src');
const files = walkDir(srcDir);
const violations: { file: string; line: number; text: string; errorClass: string }[] = [];

// Match: throw new SomeError(
const THROW_PATTERN = /throw\s+new\s+(\w+)\s*\(/g;

for (const file of files) {
  const relPath = relative(process.cwd(), file);
  const content = readFileSync(file, 'utf-8');
  const lines = content.split('\n');

  const isTestFile = relPath.includes('/test/') || relPath.endsWith('.test.ts');
  const isCliFile = relPath.includes('/cli/');
  const isErrorsFile = relPath.endsWith('src/errors.ts');
  // Generator and schema tooling files are invoked via the CLI, not at
  // query runtime, allow standard Error the same way we allow it in CLI code.
  const isToolingFile =
    relPath.endsWith('generate.ts') ||
    relPath.endsWith('schema-builder.ts') ||
    relPath.endsWith('schema-sql.ts') ||
    relPath.endsWith('introspect.ts');

  // Skip the errors definition file itself
  if (isErrorsFile) continue;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match: RegExpExecArray | null;
    THROW_PATTERN.lastIndex = 0;

    while ((match = THROW_PATTERN.exec(line)) !== null) {
      const errorClass = match[1];

      // Known Turbine errors are always OK
      if (KNOWN_ERRORS.has(errorClass)) continue;

      // Standard errors are OK in test files, CLI code, and tooling files
      if ((isTestFile || isCliFile || isToolingFile) && ALLOWED_IN_TESTS.has(errorClass)) continue;

      // Module-local error classes are OK in the one file that owns them
      if (FILE_LOCAL_ERRORS.get(relPath)?.has(errorClass)) continue;

      violations.push({
        file: relPath,
        line: i + 1,
        text: line.trim(),
        errorClass,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Check 2: every declared error code is actually reachable
// ---------------------------------------------------------------------------

const errorsSource = readFileSync(join(srcDir, 'errors.ts'), 'utf-8');

/** `NOT_FOUND: 'TURBINE_E001',` -> member name -> code. */
const declaredCodes = new Map<string, string>();
for (const m of errorsSource.matchAll(/^\s{2}([A-Z0-9_]+):\s*'(TURBINE_E\d+)',/gm)) {
  declaredCodes.set(m[1]!, m[2]!);
}

/**
 * Class -> the code it passes to `super(...)`. Read by walking errors.ts and
 * remembering the most recent `export class X extends`, then taking the first
 * `TurbineErrorCode.MEMBER` that follows: the super call that names the code
 * sits several lines into the constructor and is often split across lines, so
 * matching `super(` and the member on ONE line silently misses those (it missed
 * three, which then reported as "declared code with no class").
 *
 * `TurbineError` itself is skipped, by the `extends Error` test: it takes the
 * code as a CONSTRUCTOR PARAMETER rather than naming one, so the first member
 * reference after it belongs to the next class down.
 */
const classCodes = new Map<string, string>();
let currentClass: string | null = null;
for (const line of errorsSource.split('\n')) {
  const decl = /^export class (\w+) extends (\w+)/.exec(line);
  if (decl) {
    currentClass = decl[2] === 'Error' ? null : decl[1]!;
    continue;
  }
  if (!currentClass) continue;
  const member = /TurbineErrorCode\.([A-Z0-9_]+)/.exec(line);
  if (member) {
    classCodes.set(currentClass, declaredCodes.get(member[1]!) ?? member[1]!);
    currentClass = null;
  }
}

/** Count `new X(` across all of src/ except the tests. */
const constructionCounts = new Map<string, number>();
for (const file of files) {
  const relPath = relative(process.cwd(), file);
  if (relPath.includes('/test/') || relPath.endsWith('.test.ts')) continue;
  const content = readFileSync(file, 'utf-8');
  for (const m of content.matchAll(/\bnew\s+(\w+)\s*\(/g)) {
    const name = m[1]!;
    if (classCodes.has(name)) constructionCounts.set(name, (constructionCounts.get(name) ?? 0) + 1);
  }
}

const unreachable = [...classCodes]
  .filter(([cls]) => (constructionCounts.get(cls) ?? 0) === 0)
  .map(([cls, code]) => `${code} (${cls})`);

// A code declared in TurbineErrorCode that no class ever passes to super() can
// never appear on a thrown error either, so it is the same failure one step
// earlier.
const claimedCodes = new Set(classCodes.values());
const unclaimed = [...declaredCodes.entries()]
  .filter(([, code]) => !claimedCodes.has(code))
  .map(([member, code]) => `${code} (TurbineErrorCode.${member})`);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

let failed = false;

if (violations.length > 0) {
  failed = true;
  console.error(`\n Found ${violations.length} untracked error class(es):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} -- throw new ${v.errorClass}(...)`);
    console.error(`    ${v.text}\n`);
  }
  console.error(
    'Fix: Use a known TurbineError subclass from src/errors.ts,\n' +
    'or add the new class to KNOWN_ERRORS in scripts/check-error-codes.ts.\n'
  );
}

if (classCodes.size === 0 || declaredCodes.size === 0) {
  failed = true;
  console.error(
    `\n Could not read the error codes out of src/errors.ts ` +
    `(${declaredCodes.size} codes, ${classCodes.size} classes).\n` +
    ' The reachability check would pass vacuously, so it fails instead.\n'
  );
}

if (unreachable.length > 0) {
  failed = true;
  console.error(`\n Found ${unreachable.length} error code(s) that are never constructed:\n`);
  for (const entry of unreachable) console.error(`  ${entry}`);
  console.error(
    '\nFix: throw it from the code path it documents, or delete it.\n' +
    'A code that no production path constructs cannot be caught by `instanceof`\n' +
    'or matched on `.code`, however completely it is documented.\n'
  );
}

if (unclaimed.length > 0) {
  failed = true;
  console.error(`\n Found ${unclaimed.length} declared code(s) with no error class:\n`);
  for (const entry of unclaimed) console.error(`  ${entry}`);
  console.error('\nFix: add the class that passes this code to super(), or remove the code.\n');
}

if (failed) {
  process.exit(1);
}

console.log(
  `All thrown errors use known TurbineError subclasses, and all ${classCodes.size} error codes are constructed.`,
);
