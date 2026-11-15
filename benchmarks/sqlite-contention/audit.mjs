// Independent, read-only post-run audit. Never removes fixtures or signals processes.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { alive, FORMAT, validateCleanupCoverage } from './model.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' } } });
assert.ok(positionals.length > 0 && values.out, 'usage: audit.mjs --out audit.json report.json ...');
const result = { auditedAt: new Date().toISOString(), auditorPid: process.pid, reports: [] };
let failed = false;
for (const file of positionals) {
  const report = JSON.parse(readFileSync(file));
  assert.equal(report.format, FORMAT);
  let coverageError;
  try { validateCleanupCoverage(report); } catch (error) { coverageError = error.message; }
  const states = report.cleanup.flatMap(x => x.children).map(c => ({ pid: c.pid, pgid: c.pgid,
    pidAbsent: !alive(c.pid), groupAbsent: !alive(-c.pgid) }));
  const paths = [...new Set(report.cleanup.flatMap(x => x.paths))].map(path => ({ path, absent: !existsSync(path) }));
  const verified = !coverageError && report.cleanup.length > 0 && states.length > 0 && paths.length > 0 &&
    states.every(x => x.pidAbsent && x.groupAbsent) && paths.every(x => x.absent) && !existsSync(`${file}.tmp`);
  if (!verified) failed = true;
  result.reports.push({ file: resolve(file), campaignStatus: report.status, states, paths, verified, ...(coverageError ? { coverageError } : {}) });
}
result.status = failed ? 'failed' : 'passed';
writeFileSync(values.out, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ status: result.status, reports: result.reports.length,
  workers: result.reports.reduce((n, x) => n + x.states.length, 0), audit: resolve(values.out) }));
process.exitCode = failed ? 1 : 0;
