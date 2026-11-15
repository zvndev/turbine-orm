/** Real wrapper interruption controls, gated only on the explicit integration archive fixture. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { comparisonRoot } from './sqlite-comparison-identity.js';

const artifact = process.env.SQLITE_TEST_ARTIFACT,
  digest = process.env.SQLITE_TEST_SHA256;
const destination = process.env.SQLITE_TEST_OUTPUT;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  test(`supervised SQLite runner cleans its process group and scratch after ${signal}`, {
    skip: !artifact || !digest || !destination ? 'explicit installed archive fixture/output required' : false,
    timeout: 20000,
  }, async () => {
    const output = resolve(destination!, signal);
    const child = spawn(
      process.execPath,
      [
        '--import',
        join(comparisonRoot, 'benchmarks/node_modules/tsx/dist/loader.mjs'),
        join(comparisonRoot, 'benchmarks/sqlite-comparison-run.ts'),
        '--artifact',
        artifact!,
        '--sha256',
        digest!,
        '--output',
        output,
      ],
      { env: { ...process.env, SQLITE_COMPARISON_FAULT: 'none' }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '',
      stderr = '',
      sent = false;
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (!sent && stdout.includes('sqlite-owned-child-started')) {
        sent = true;
        child.kill(signal);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const code = await new Promise<number | null>((done, reject) => {
      child.once('error', reject);
      child.once('exit', done);
    });
    mkdirSync(destination!, { recursive: true });
    writeFileSync(join(destination!, `${signal}.log`), `${stdout}${stderr}`);
    assert.ok(sent, 'signal was actually delivered after child supervision began');
    assert.equal(code, 1);
    const report = JSON.parse(readFileSync(join(output, 'runner.json'), 'utf8'));
    assert.equal(report.status, 'failed');
    assert.equal(report.commands[0].interrupted, true);
    assert.equal(report.commands[0].workersStopped, true);
    assert.ok(report.commands[0].linuxProcessStat);
    assert.deepEqual(report.cleanup.remainingOwnedWorkers, []);
    assert.deepEqual(report.cleanup.scratchPathUsers, []);
    assert.equal(report.cleanup.removed, true);
    assert.equal(existsSync(report.cleanup.scratch), false);
  });
}
