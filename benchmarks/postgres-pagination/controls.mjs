import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { out: { type: 'string' } } });
assert.ok(values.out, '--out directory required');
const out = resolve(values.out);
mkdirSync(out, { recursive: true });
const controls = [];
const reasons = { missing: /Required owned native PG18.6 service/, service: /closed|ended|queryable/i,
  ordering: /Independent ordered row\/shape oracle/, materialization: /Wire SQL\/parameter\/row identity/,
  oracle: /Independent ordered row\/shape oracle/, signal: /Received SIGTERM/,
  preparation: /Native prepared name set/ };
for (const [fault, reason] of Object.entries(reasons)) {
  const file = join(out, `${fault}.json`);
  const args = ['--import', 'tsx', 'benchmarks/postgres-pagination/run.mjs', '--out', file, '--iterations', '1',
    ...(fault === 'missing' ? [] : ['--fault', fault])];
  const child = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60000,
    env: { ...process.env, ...(fault === 'missing' ? { PG_PREFIX: join(out, 'absent-required-service') } : {}) } });
  writeFileSync(join(out, `${fault}.log`), `${child.stdout ?? ''}${child.stderr ?? ''}`);
  assert.equal(child.status, fault === 'signal' ? 143 : 1, `${fault}: unexpected exit ${child.error?.message}`);
  const report = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(report.status, 'failed');
  assert.match(report.failures.map((f) => f.message).join('\n'), reason, `${fault}: wrong failure`);
  for (const key of ['rootAbsent', 'portClosed', 'processesAbsent', 'socketAbsent', 'datadirAbsent', 'applicationsAbsent']) assert.equal(report.cleanup[key], true, `${fault}: ${key}`);
  assert.deepEqual(report.cleanup.errors, []);
  controls.push({ fault, command: [process.execPath, ...args], exit: child.status, report: file, cleanup: report.cleanup });
}
writeFileSync(join(out, 'controls.json'), `${JSON.stringify({ node: process.version, controls }, null, 2)}\n`);
process.stdout.write(`passed ${controls.length} native executable refusal/finalization controls: ${out}\n`);
