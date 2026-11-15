/** Actual driver regressions: admission snapshots, connecting shutdown, unknown
 * transaction outcomes and the 'transaction-outcome-unknown' log contract. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

const pgRoot = process.env.TURBINE_NEON_WS_PG_ROOT;
if (!pgRoot && process.env.TURBINE_REQUIRE_NEON_WS === '1') {
  throw new Error('Required WS lifecycle regressions need TURBINE_NEON_WS_PG_ROOT (PostgreSQL18.6), Neon1.2.0 and ws');
}

it('native WS lifecycle corrections, with held bytes and surviving caller resources', { skip: !pgRoot }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'turbine-ws-lifecycle-result-'));
  const report = join(root, 'result.json');
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/test/fixtures/neon-ws-lifecycle-regression.mjs', 'source'],
    {
      cwd: new URL('../../', import.meta.url),
      env: { ...process.env, TURBINE_WS_LIFECYCLE_REPORT: report },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(code, 0, output);
  const result = JSON.parse(await readFile(report, 'utf8'));
  assert.equal(result.error, undefined);
  assert.equal(result.checks.length, 16);
  assert.deepEqual(result.findings, []);
});

it('native lifecycle fixture awaits private service cleanup on SIGTERM', { skip: !pgRoot }, async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/test/fixtures/neon-ws-lifecycle-signal.mjs'], {
    cwd: new URL('../../', import.meta.url),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let serviceRoot = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
    const ready = output.match(/\{"ready":"([^"]+)"\}/);
    if (ready && !serviceRoot) {
      serviceRoot = ready[1]!;
      child.kill('SIGTERM');
    }
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(code, 143, output);
  assert.ok(serviceRoot);
  const audit = JSON.parse(await readFile(join(serviceRoot, 'audit.json'), 'utf8'));
  assert.equal(audit.stopped, true);
  assert.equal(audit.pidGone, true);
  assert.deepEqual(audit.remainingPids, []);
  assert.deepEqual(audit.remainingGroups, []);
});
