import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { command } from '../../../../tooling/optional-pg-transports/harness.mjs';

// Reuse the existing native gate supervisor so a regressed startup cannot
// leave an unrecorded Miniflare or esbuild process after this negative test.
test('required D1 runtime refuses an absent workerd executable before opening fixtures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'd1-no-workerd-'));
  const report = { commands: [] };
  const env = { ...process.env, TMPDIR: root, MINIFLARE_WORKERD_PATH: join(root, 'absent-workerd') };
  // The child is an independent test runner, not this runner's IPC test worker.
  delete env.NODE_TEST_CONTEXT;
  try {
    await assert.rejects(
      command(
        report,
        resolve('.'),
        process.execPath,
        [
          '--import',
          resolve('node_modules/tsx/dist/loader.mjs'),
          '--test',
          '--test-reporter=tap',
          resolve('src/test/fixtures/d1/runtime.test.ts'),
        ],
        env,
        { timeoutMs: 12_000 },
      ),
      /ENOENT/,
    );
    const record = report.commands[0];
    assert.equal(record.code, 1);
    assert.equal(record.signal, null);
    assert.match(record.stdout, /# fail 1/);
    assert.match(record.stdout, /# skipped 0/);
    assert.equal(record.reaped, true);
    assert.deepEqual(record.remainingPids, []);
    assert.deepEqual(record.remainingGroups, []);
    assert.equal(record.ownershipReportRemoved, true);
    assert.equal(
      readdirSync(root).some((name) => name.startsWith('turbine-d1-runtime-')),
      false,
    );
    assert.equal(existsSync(join(root, 'absent-workerd')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
