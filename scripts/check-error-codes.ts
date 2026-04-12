#!/usr/bin/env tsx
/**
 * Error code enforcement — verifies all thrown errors in src/ use
 * known TurbineError subclasses from src/errors.ts.
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
]);

// Also allow standard Error in test files and CLI UI code
const ALLOWED_IN_TESTS = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError']);

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
  // query runtime — allow standard Error the same way we allow it in CLI code.
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

      violations.push({
        file: relPath,
        line: i + 1,
        text: line.trim(),
        errorClass,
      });
    }
  }
}

if (violations.length > 0) {
  console.error(`\n Found ${violations.length} untracked error class(es):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} -- throw new ${v.errorClass}(...)`);
    console.error(`    ${v.text}\n`);
  }
  console.error(
    'Fix: Use a known TurbineError subclass from src/errors.ts,\n' +
    'or add the new class to KNOWN_ERRORS in scripts/check-error-codes.ts.\n'
  );
  process.exit(1);
} else {
  console.log('All thrown errors use known TurbineError subclasses.');
}
