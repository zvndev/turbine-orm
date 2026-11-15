// Explicit required-native acceptance; no prerequisite skip or external service rescue.
import './native-proof.test.mjs';
import './http-ownership.test.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { bounded } from './native-lifecycle.mjs';

for (const key of ['PG_PREFIX', 'NEON_HTTP_INTERRUPTION_EVIDENCE', 'NEON_HTTP_ARCHIVE', 'NEON_HTTP_ARCHIVE_SHA256']) {
  assert.ok(process.env[key], `${key} required for native interruption acceptance`);
}
const scenarios = [
  'positive',
  ...[
    'service-initialization',
    'initialization',
    'active-native-child',
    'final-cleanup',
    'report-finalization',
    'report-written',
  ].flatMap((phase) => ['SIGINT', 'SIGTERM'].map((signal) => `signal:${phase}:${signal}`)),
  'missing-prefix',
  'missing-binary',
  'wrong-sha',
  'cleanup-error',
  'cleanup-error-signal',
  'cleanup-hang',
  'remove-error',
  'stubborn-signal',
  'stubborn-parent-graceful',
  'stubborn-timeout',
];
for (const [index, scenario] of scenarios.entries()) {
  test(`required native runner cleanup: ${scenario}`, { timeout: 200_000 }, async () => {
    const supervisor = new URL('./supervise-native-interruption.py', import.meta.url).pathname;
    const output = join(
      resolve(process.env.NEON_HTTP_INTERRUPTION_EVIDENCE),
      `case-${String(index + 1).padStart(2, '0')}`,
    );
    const child = spawn('python3', [supervisor, process.execPath, output, scenario], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (part) => {
      log += part;
    });
    child.stderr.on('data', (part) => {
      log += part;
    });
    const done = new Promise((accept, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => accept({ code, signal }));
    });
    const exit = await bounded(done, 190_000, `Supervisor ${scenario}`);
    assert.equal(exit.signal, null, log);
    assert.equal(exit.code, 0, log);
    console.log(log.trim());
  });
}
