import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validate } from './validate.mjs';

// Explicit native invocation: missing prerequisites fail, never silently skip.
const out = process.env.KEYSET_TEST_OUT ? resolve(process.env.KEYSET_TEST_OUT) : mkdtempSync(join(os.tmpdir(), 'pg-keyset-controls-'));
const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
assert.ok(out !== root && !out.startsWith(root + sep), 'Native reports must remain outside repository');
mkdirSync(out, { recursive: true });
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const results = [];
const controls = [
  ['baseline', null, 0],
  ['missing', /Required owned native PG18.6 service missing/, 1],
  ['missing-predicate', /Independent full row oracle/, 1],
  ['missing-tiebreaker', /Independent full row oracle/, 1],
  ['exclude-lookup', /Charged query timing boundary/, 1],
  ['service', /closed|ended|queryable/i, 1],
  ['named-execution', /Native page\/lookup execution must be unnamed/, 1],
  ['signal', /Received SIGTERM/, 143],
];
for (const [fault, reason, exit] of controls) test(`owned PostgreSQL: ${fault}`, () => {
  const reportPath = join(out, `${fault}.json`);
  const args = ['--import', 'tsx', 'benchmarks/postgres-keyset/run.mjs', '--out', reportPath,
    ...(fault === 'baseline' ? [] : ['--iterations', '1']),
    ...(['baseline', 'missing'].includes(fault) ? [] : ['--fault', fault])];
  const child = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, ...(fault === 'missing' ? { PG_PREFIX: join(out, 'absent-required-service') } : {}) } });
  const log = join(out, `${fault}.log`);
  writeFileSync(log, `${child.stdout ?? ''}${child.stderr ?? ''}`);
  assert.equal(child.status, exit, `${fault}: ${child.error?.message ?? ''}; see ${log}`);
  const report = JSON.parse(readFileSync(reportPath));
  assert.equal(report.status, exit === 0 ? 'passed' : 'failed');
  if (reason) assert.match(report.failures.map((f) => f.message).join('\n'), reason, 'Intended native failure required');
  else validate(report);
  for (const key of ['processesAbsent', 'portClosed', 'datadirAbsent', 'socketAbsent', 'rootAbsent']) assert.equal(report.cleanup[key], true, `${fault}: ${key}`);
  assert.deepEqual(report.cleanup.errors, []);
  if (fault.startsWith('missing-')) assert.ok(report.failureTrace.length > 0, 'Native failed wire trace required');
  results.push({ fault, command: [process.execPath, ...args], exit: child.status, reportPath, reportSha256: hash(reportPath), log, logSha256: hash(log), cleanup: report.cleanup });
  writeFileSync(join(out, 'controls.json'), `${JSON.stringify({ node: process.version, results }, null, 2)}\n`);
});
