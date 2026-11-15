import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('owned native concurrent deployers, SIGTERM/SIGKILL after actual DDL, durable inspection and exact replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'libsql-deploy-processes-'));
  const fixture = './fixtures/libsql-native-deploy-processes.mjs';
  const { processControls } = await import(fixture);
  const report = { scope: 'source native deployment process controls', node: process.version };
  try {
    await processControls({
      runner: fileURLToPath(new URL('../cli/libsql-migrate.ts', import.meta.url)),
      inspector: fileURLToPath(new URL('../cli/libsql-migrate-status.ts', import.meta.url)),
      loader: fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url)),
      root,
      report,
    });
  } finally {
    if (process.env.LIBSQL_DEPLOY_PROCESS_REPORT)
      writeFileSync(process.env.LIBSQL_DEPLOY_PROCESS_REPORT, JSON.stringify(report, null, 2));
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
  }
});
