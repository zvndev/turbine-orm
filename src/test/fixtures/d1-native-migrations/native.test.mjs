/** Required real-binding proof, using the established D1 Miniflare/workerd fixture and owned command supervisor. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { runD1MigrationContract } from './contract.ts';
import { installedConsumers } from './installed.mjs';

const require = createRequire(import.meta.url);
test('d1-native-migrations required actual workerd migration contract', { timeout: 120_000 }, async () => {
  const root = process.env.D1_MIGRATION_ROOT;
  const port = Number(process.env.D1_MIGRATION_PORT);
  assert(root && isAbsolute(root), 'Explicit absolute owned evidence root required');
  assert(Number.isSafeInteger(port) && port > 1024, 'Explicit announced port required');
  mkdirSync(root, { recursive: true });
  const module = process.env.TURBINE_D1_MINIFLARE_MODULE ?? 'miniflare';
  const nativeRequire = createRequire(require.resolve(module));
  const executable = process.env.MINIFLARE_WORKERD_PATH ?? nativeRequire('workerd').default;
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  assert.match(version, /^workerd \d{4}-\d{2}-\d{2}\b/);
  const server = createServer();
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', ok);
  });
  await new Promise((ok, fail) => server.close((error) => (error ? fail(error) : ok())));
  const packageRoot = process.env.D1_MIGRATION_PACKAGE;
  const localEntry = resolve('src/d1/migrate.ts');
  const esmEntry = packageRoot ? join(packageRoot, 'dist/d1/migrate.js') : localEntry;
  const bundle = await build({
    entryPoints: [resolve('src/test/fixtures/d1-native-migrations/worker.ts')],
    bundle: true,
    write: false,
    platform: 'neutral',
    format: 'esm',
    conditions: ['workerd'],
    metafile: true,
    plugins: [
      {
        name: 'd1-native-migrations-actual-entry',
        setup(b) {
          b.onResolve({ filter: /\/d1\/migrate\.js$/ }, () => ({ path: esmEntry }));
        },
      },
    ],
  });
  const inputs = Object.keys(bundle.metafile.inputs);
  assert(!inputs.some((name) => /node_modules\/(pg|pg-[^/]+|mysql2|mssql)\//.test(name)));
  assert(!inputs.some((name) => /(?:src|dist)\/(?:d1\.js|d1\/pool\.js|cli\/|sqlite\.js)/.test(name)));
  writeFileSync(join(root, 'worker.mjs'), bundle.outputFiles[0].text);
  writeFileSync(join(root, 'graph.json'), JSON.stringify(bundle.metafile, null, 2));
  const { Miniflare } = require(module);
  let runtime;
  const report = {
    node: process.version,
    executable,
    workerd: version.trim(),
    workerdSha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
    packageRoot,
    esmEntry,
    port,
    groups: [],
    disposed: false,
  };
  try {
    console.log(`d1-native-migrations starting owned Worker port ${port}, root ${root}`);
    runtime = new Miniflare({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: '2026-01-01',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: { DB: `d1-native-migrations-${process.pid}-${port}` },
      d1Persist: join(root, 'database'),
      host: '127.0.0.1',
      port,
      inspectorPort: 0,
    });
    const response = await runtime.dispatchFetch('http://localhost/');
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const worker = JSON.parse(text);
    assert.equal(worker.ok, true);
    assert.equal(worker.count, 18);
    report.groups.push({ format: 'Worker ESM', ...worker });
    const binding = await runtime.getD1Database('DB');
    if (packageRoot) {
      // These are installed Node consumers of a real Miniflare D1 proxy, not
      // imaginary CJS Worker modules. Resolution uses the package export map.
      const consumerRequire = createRequire(join(dirname(dirname(packageRoot)), 'package.json'));
      const cjs = consumerRequire('turbine-orm/d1/migrate');
      const resolvedCjs = consumerRequire.resolve('turbine-orm/d1/migrate');
      assert.equal(resolvedCjs, join(packageRoot, 'dist/cjs/d1/migrate.js'));
      const esmProbe = join(dirname(dirname(packageRoot)), 'esm-migrate.mjs');
      writeFileSync(esmProbe, "export * from 'turbine-orm/d1/migrate';");
      const esm = await import(pathToFileURL(esmProbe).href);
      for (const [format, api] of [
        ['Node ESM', esm],
        ['Node CJS', cjs],
      ]) {
        const result = await runD1MigrationContract(binding, api.migrateD1);
        assert.equal(result.count, 18);
        report.groups.push({ format, ...result });
      }
      report.generated = await installedConsumers(binding, packageRoot);
    } else {
      const source = await import(pathToFileURL(localEntry).href);
      const result = await runD1MigrationContract(binding, source.migrateD1);
      assert.equal(result.count, 18);
      report.groups.push({ format: 'Node source ESM', ...result });
    }
    const remaining = (
      await binding
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'",
        )
        .all()
    ).results;
    assert.deepEqual(remaining, [], 'owned schema cleanup');
  } finally {
    await runtime?.dispose();
    report.disposed = true;
    writeFileSync(join(root, 'native-evidence.json'), JSON.stringify(report, null, 2));
  }
});
