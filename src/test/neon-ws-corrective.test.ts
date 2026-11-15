/** Real Neon/PG failure regressions for query configs, accessors and connect/abort cleanup. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

const pgRoot = process.env.TURBINE_NEON_WS_PG_ROOT;
if (!pgRoot && process.env.TURBINE_REQUIRE_NEON_WS === '1') {
  throw new Error('Required corrective regressions need TURBINE_NEON_WS_PG_ROOT (PostgreSQL18.6), Neon1.2.0 and ws');
}

it('corrective WS held-outs use real Neon and PostgreSQL, with audited teardown', { skip: !pgRoot }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'turbine-ws-corrective-result-'));
  const report = join(root, 'result.json');
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/test/fixtures/neon-ws-corrective-regression.mjs', 'source'],
    {
      cwd: new URL('../../', import.meta.url),
      env: { ...process.env, TURBINE_WS_CORRECTIVE_REPORT: report },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  let force: ReturnType<typeof setTimeout> | undefined;
  const timeout = setTimeout(() => {
    child.kill('SIGTERM');
    force = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid!, 'SIGKILL');
    }, 25000);
  }, 90000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    assert.equal(code, 0, output);
    const result = JSON.parse(await readFile(report, 'utf8'));
    assert.equal(result.error, undefined);
    assert.equal(result.cleanupError, undefined);
    assert.equal(result.checks.length, 16);
    assert.deepEqual(result.findings, []);
    const audit = JSON.parse(await readFile(join(result.serviceRoot, 'audit.json'), 'utf8'));
    assert.equal(audit.stopped, true);
    assert.equal(audit.pidGone, true);
    assert.deepEqual(audit.remainingPids, []);
    assert.deepEqual(audit.remainingGroups, []);
  } finally {
    clearTimeout(timeout);
    clearTimeout(force);
  }
});
