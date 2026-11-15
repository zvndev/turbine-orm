/** Required installed migration proof, using the existing owned command supervisor. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { archiveIdentity, command, installedPayload } from '../../../../tooling/optional-pg-transports/harness.mjs';
import { runWithShutdown } from '../../../../tooling/optional-pg-transports/run.mjs';

const archive = resolve(process.env.TURBINE_D1_MIGRATIONS_ARCHIVE ?? '');
const identity = archiveIdentity(archive, process.env.TURBINE_D1_MIGRATIONS_SHA256);
assert.deepEqual(identity.manifest.exports['./d1/migrate'], {
  import: { types: './dist/d1/migrate.d.ts', default: './dist/d1/migrate.js' },
  require: { types: './dist/cjs/d1/migrate.d.ts', default: './dist/cjs/d1/migrate.js' },
});
const root = mkdtempSync(join(tmpdir(), 'd1-migrations-gate-'));
const reportPath = process.env.TURBINE_D1_MIGRATIONS_REPORT ?? `${root}.json`;
const report = { commands: [], archive, sha256: identity.sha256, root };
const env = { ...process.env, TMPDIR: root, TMP: root, TEMP: root };
try {
  await runWithShutdown(
    report,
    reportPath,
    async (scope) => {
      const consumer = join(root, 'consumer');
      const reference = join(root, 'reference');
      const compiler = join(root, 'compiler');
      for (const directory of [consumer, reference, compiler]) mkdirSync(directory);
      writeFileSync(
        join(consumer, 'package.json'),
        JSON.stringify({ name: 'd1-migrations-proof', private: true, type: 'module' }),
      );
      writeFileSync(join(compiler, 'package.json'), JSON.stringify({ name: 'd1-migrations-compiler', private: true }));
      await command(report, reference, 'tar', ['-xzf', archive, '--strip-components=1'], env, { scope });
      await command(
        report,
        consumer,
        'npm',
        ['install', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund', archive, 'pg@8.23.1'],
        env,
        { scope },
      );
      await command(
        report,
        compiler,
        'npm',
        ['install', '--no-audit', '--no-fund', '--save-exact', 'typescript@5.9.3'],
        env,
        { scope },
      );
      const library = join(consumer, 'node_modules/turbine-orm');
      report.payload = installedPayload(reference, library);
      const portProbe = createServer();
      let port;
      try {
        await new Promise((ok, fail) => {
          portProbe.once('error', fail);
          portProbe.listen(0, '127.0.0.1', ok);
        });
        port = portProbe.address().port;
      } finally {
        if (portProbe.listening)
          await new Promise((ok, fail) => portProbe.close((error) => (error ? fail(error) : ok())));
      }
      const nativeRoot = join(root, 'native');
      report.nativePort = port;
      console.log(`D1 migrations owned native fixture: ${nativeRoot}, 127.0.0.1:${port}`);
      const output = await command(
        report,
        resolve('.'),
        process.execPath,
        [
          '--import',
          resolve('node_modules/tsx/dist/loader.mjs'),
          '--test',
          '--test-reporter=tap',
          'src/test/fixtures/d1-native-migrations/native.test.mjs',
        ],
        {
          ...env,
          D1_MIGRATION_ROOT: nativeRoot,
          D1_MIGRATION_PORT: String(port),
          D1_MIGRATION_PACKAGE: library,
          D1_MIGRATION_TSC59: join(compiler, 'node_modules/typescript/bin/tsc'),
        },
        { scope, timeoutMs: 180_000 },
      );
      assert.match(output, /^# tests 1$/m);
      assert.match(output, /^# pass 1$/m);
      for (const field of ['fail', 'cancelled', 'skipped']) assert.match(output, new RegExp(`^# ${field} 0$`, 'm'));
      process.stdout.write(output);
      report.native = JSON.parse(readFileSync(join(nativeRoot, 'native-evidence.json'), 'utf8'));
      assert.equal(report.native.disposed, true);
      assert.deepEqual(
        report.native.groups.map(({ format, count }) => ({ format, count })),
        [
          { format: 'Worker ESM', count: 18 },
          { format: 'Node ESM', count: 18 },
          { format: 'Node CJS', count: 18 },
        ],
      );
      assert.equal(report.native.generated.length, 2);
      for (const result of report.native.generated) {
        assert.deepEqual(result.strictTypes, ['6.0.3', '5.9.3']);
        assert.equal(result.omissionControl, true);
      }
      installedPayload(reference, library);
      assert.equal(createHash('sha256').update(readFileSync(archive)).digest('hex'), identity.sha256);
      report.payloadUnchanged = true;
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
console.log(`D1 migration ownership report: ${reportPath}`);
