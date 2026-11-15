/** Required actual-archive gate; never creates an export overlay or repacks a caller archive. */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { command } from '../../../../tooling/optional-pg-transports/harness.mjs';
import { runWithShutdown } from '../../../../tooling/optional-pg-transports/run.mjs';

const archive = process.env.TURBINE_D1_GENERATION_ARCHIVE;
assert(archive && existsSync(archive), 'TURBINE_D1_GENERATION_ARCHIVE must name the built, packed artifact.');
assert.match(process.env.TURBINE_D1_GENERATION_SHA256 ?? '', /^[a-f0-9]{64}$/, 'An exact archive SHA256 is required.');
const root = mkdtempSync(join(tmpdir(), 'd1-generation-gate-'));
const reportPath = process.env.TURBINE_D1_GENERATION_REPORT ?? `${root}.json`;
const report = { commands: [], archive: resolve(archive), sha256: process.env.TURBINE_D1_GENERATION_SHA256, root };
try {
  await runWithShutdown(
    report,
    reportPath,
    async (scope) => {
      const output = await command(
        report,
        resolve('.'),
        process.execPath,
        [
          '--import',
          resolve('node_modules/tsx/dist/loader.mjs'),
          '--test',
          '--test-concurrency=1',
          '--test-reporter=tap',
          'src/test/d1-generation.test.ts',
          'src/test/fixtures/d1-generation/native.test.ts',
        ],
        { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
        { scope, timeoutMs: 180_000 },
      );
      assert.match(output, /^# tests 8$/m);
      for (const field of ['fail', 'skipped', 'cancelled']) assert.match(output, new RegExp(`^# ${field} 0$`, 'm'));
      process.stdout.write(output);
    },
    async () => {
      rmSync(root, { recursive: true, force: true });
      report.rootRemoved = !existsSync(root);
    },
  );
} catch (error) {
  console.error(error);
  process.exitCode = report.signalExitCode ?? 1;
}
console.log(`D1 generation ownership report: ${reportPath}`);
