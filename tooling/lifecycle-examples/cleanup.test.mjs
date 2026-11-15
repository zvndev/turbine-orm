import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { artifact, prerequisite } from './harness.mjs';

test('SIGTERM stops the exclusively owned native service and removes fixtures', { timeout: 120_000 }, async () => {
  const tarball = artifact(process.env.LIFECYCLE_TARBALL);
  prerequisite('mysql');
  const dir = mkdtempSync(join(tmpdir(), 'lifecycle-shutdown-control-'));
  const reportPath = process.env.LIFECYCLE_CLEANUP_REPORT ?? join(dir, 'shutdown.json');
  const child = spawn(
    process.execPath,
    [
      new URL('./verify.mjs', import.meta.url).pathname,
      '--engine',
      'mysql',
      '--tarball',
      tarball.path,
      '--report',
      reportPath,
    ],
    { env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const exited = once(child, 'exit');
  let output = '';
  let interrupted = false;
  child.stdout.on('data', (chunk) => {
    output += chunk;
    if (!interrupted && output.includes('mysql-0-module-fresh')) {
      interrupted = true;
      child.kill('SIGTERM');
    }
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  try {
    const [code, signal] = await exited;
    assert.equal(interrupted, true, `Must reach a real ready service before interruption:\n${output}`);
    assert.equal(signal, null, output);
    assert.equal(code, 143, output);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.passed, false);
    assert.match(report.error, /Interrupted by SIGTERM/);
    assert.equal(report.services.length, 1);
    assert.match(report.services[0].version, /^8\.4\./);
    assert.equal(report.services[0].stopped, true);
    assert.equal(report.services[0].connectionsClosed, true);
    assert.deepEqual(report.cleanup, { servicesStopped: true, fixtureRemoved: true });
    assert.equal(existsSync(report.fixtureRoot), false);
    assert.throws(() => process.kill(report.services[0].pid, 0), { code: 'ESRCH' });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
