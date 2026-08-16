#!/usr/bin/env node
/**
 * The coverage report and threshold gate, reading the coverage already on disk
 * in `.c8rc.json`'s temp directory.
 *
 * This replaces `c8 report` / `c8 check-coverage` for this repo because c8's
 * V8-level merge loses coverage on a run this size. See the long comment in
 * `coverage-istanbul-merge.mjs` for the measurement and the mechanism; the
 * short version is that a 448-test SUBSET of this suite reported
 * `query/relations.ts` at 91.88% while the full 5,819-test superset reported
 * 41.78%, which is not a number a release gate can read.
 *
 * Everything else is c8's: the same `.c8rc.json`, the same reporters, and the
 * same `checkCoverages` used by `c8 check-coverage`, so the gate's semantics
 * (global thresholds, exit code 1 on a miss) are unchanged.
 *
 * Usage:
 *   node scripts/coverage-report.mjs              report + check thresholds
 *   node scripts/coverage-report.mjs --no-check   report only
 */
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { createIstanbulMergeReport } from './coverage-istanbul-merge.mjs';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const rc = require(resolve(root, '.c8rc.json'));

const reportsDirectory = resolve(root, rc['reports-dir'] ?? './coverage');
const tempDirectory = resolve(root, rc['temp-directory'] ?? `${reportsDirectory}/tmp`);

// A gate with no collected coverage must fail, never report a vacuous pass.
// This is the same rule the CLI gate already follows (see .c8rc.json's
// //cli-gate-per-file note): the failure mode being guarded against is a
// collection step that silently did not run.
if (!existsSync(tempDirectory) || readdirSync(tempDirectory).filter((f) => f.endsWith('.json')).length === 0) {
  console.error(`[coverage] no coverage data in ${tempDirectory}. Run the collection step first.`);
  process.exit(1);
}

const report = createIstanbulMergeReport({
  include: rc.include ?? [],
  exclude: rc.exclude ?? [],
  extension: rc.extension ?? ['.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx'],
  excludeAfterRemap: rc['exclude-after-remap'] ?? false,
  excludeNodeModules: rc['exclude-node-modules'] ?? true,
  reporter: [].concat(rc.reporter ?? ['text']),
  reporterOptions: rc['reporter-options'] ?? {},
  reportsDirectory,
  tempDirectory,
  watermarks: rc.watermarks,
  omitRelative: rc['omit-relative'] ?? false,
  wrapperLength: rc['wrapper-length'] ?? 0,
  resolve: rc.resolve ?? '',
  all: rc.all ?? false,
  src: rc.src ? [].concat(rc.src) : [root],
  allowExternal: rc['allow-external'] ?? false,
  skipFull: rc['skip-full'] ?? false,
});

await report.run();

if (!process.argv.includes('--no-check') && rc['check-coverage'] !== false) {
  // c8's own gate, handed the patched report. `getCoverageMapFromAllCoverageFiles`
  // memoizes, so this does not repeat the conversion work `run()` just did.
  const { checkCoverages } = require('c8/lib/commands/check-coverage.js');
  await checkCoverages(
    {
      lines: rc.lines ?? 0,
      functions: rc.functions ?? 0,
      branches: rc.branches ?? 0,
      statements: rc.statements ?? 0,
      perFile: rc['per-file'] ?? false,
    },
    report,
  );
}
