/** Required-native supervisor controls, separate from the service-free tests. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditMysqlProcesses } from './mysql-comparison-cleanup.js';

assert.ok(process.env.MYSQL_COMPARISON_NATIVE_TEST_OUTPUT, 'explicit native control output directory required');
const output = resolve(process.env.MYSQL_COMPARISON_NATIVE_TEST_OUTPUT);
mkdirSync(output);
const directory = fileURLToPath(new URL('.', import.meta.url));
for (const fault of ['setup', 'cleanup', 'signal-cleanup']) {
  test(`native supervisor retains ${fault} failure while proving cleanup`, { timeout: 240000 }, async () => {
    const reportPath = join(output, `${fault}.json`);
    const child = spawn(
      process.execPath,
      [
        '--import',
        join(directory, 'node_modules/tsx/dist/loader.mjs'),
        join(directory, 'mysql-comparison-native.ts'),
        reportPath,
        '--mode=ordinary',
      ],
      {
        env: { ...process.env, GROUPS: 'agg', MYSQL_COMPARISON_NATIVE_FAULT: fault },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let log = '';
    child.stdout.on('data', (data) => {
      log += data;
      process.stdout.write(data);
    });
    child.stderr.on('data', (data) => {
      log += data;
      process.stderr.write(data);
    });
    const deadline = setTimeout(() => child.kill('SIGTERM'), 210000);
    let code: number | null;
    try {
      code = await new Promise<number | null>((done, reject) => {
        child.once('error', reject);
        child.once('exit', done);
      });
    } finally {
      clearTimeout(deadline);
    }
    assert.equal(code, 1, log);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.status, 'failure');
    assert.equal(report.timing, false);
    assert.match(
      report.failures.join('\n'),
      fault === 'signal-cleanup' ? /interrupted SIGTERM/ : new RegExp(`forced native ${fault}`),
    );
    assert.equal(report.identity.rootRemoved, true);
    assert.equal(report.identity.portClosed, true);
    assert.deepEqual(report.identity.remainingProcessGroups, []);
    assert.deepEqual(report.identity.cleanupAudit.remaining, []);
    assert.equal(existsSync(report.identity.data), false);
    assert.deepEqual(auditMysqlProcesses(report.identity.cleanupAudit.owned, report.identity.data).remaining, []);
  });
}
