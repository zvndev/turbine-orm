import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prerequisite } from '../lifecycle-examples/harness.mjs';
import { artifactPair } from './harness.mjs';

// Required native suite: missing inputs are failures, never silent skips.
for (const [signal, marker, code] of [
  ['SIGINT', 'mysql-0-module-fresh', 130],
  ['SIGTERM', 'mysql-0-module-fresh', 143],
  ['SIGTERM', 'mysql-mode-0-stopping', 143],
])
  test(`${signal} at ${marker} removes owned service and application fixtures`, { timeout: 240_000 }, async () => {
    const pair = artifactPair(
      process.env.UPGRADE_BASELINE,
      process.env.UPGRADE_BASELINE_SHA256,
      process.env.UPGRADE_CANDIDATE,
      process.env.UPGRADE_CANDIDATE_SHA256,
    );
    prerequisite('mysql');
    const dir = mkdtempSync(join(tmpdir(), 'upgrade-signal-'));
    const path = process.env.UPGRADE_CLEANUP_REPORT_PREFIX
      ? `${process.env.UPGRADE_CLEANUP_REPORT_PREFIX}-${signal}-${marker}.json`
      : join(dir, 'report.json');
    const child = spawn(
      process.execPath,
      [
        new URL('./verify.mjs', import.meta.url).pathname,
        '--engine',
        'mysql',
        '--exact-node',
        '24.10.0',
        '--baseline',
        pair.baseline.path,
        '--baseline-sha256',
        pair.baseline.sha256,
        '--candidate',
        pair.candidate.path,
        '--candidate-sha256',
        pair.candidate.sha256,
        '--report',
        path,
      ],
      { env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const exited = once(child, 'exit');
    let output = '';
    let sent = false;
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (!sent && output.includes(marker)) {
        sent = true;
        child.kill(signal);
      }
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    try {
      const [exit, exitSignal] = await exited;
      assert.equal(sent, true, output);
      assert.equal(exitSignal, null, output);
      assert.equal(exit, code, output);
      const report = JSON.parse(readFileSync(path, 'utf8'));
      assert.equal(report.passed, false);
      assert.match(report.error, new RegExp(`Interrupted by ${signal}`));
      assert.equal(report.services.length, 1, 'No second service may be started during cleanup');
      assert.match(report.services[0].version, /^8\.4\./);
      assert.equal(report.services[0].connectionsClosed, true);
      assert.deepEqual(report.cleanup, { servicesStopped: true, fixtureRemoved: true });
      assert.equal(report.artifactsUnchanged, true);
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
