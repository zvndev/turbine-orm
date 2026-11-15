import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { command } from '../optional-pg-transports/harness.mjs';
import { bounded } from '../optional-pg-transports/lifecycle.mjs';
import { runWithShutdown } from '../optional-pg-transports/run.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [identityFile, baseline, destination] = process.argv.slice(2);
assert.ok(identityFile && baseline && destination, 'Usage: node native.mjs IDENTITY BASELINE NEW_OUTPUT');
const identity = JSON.parse(readFileSync(identityFile));
const root = resolve(destination);
assert.ok(!existsSync(root));
mkdirSync(root, { recursive: true });
const report = { commands: [], services: [], results: [], identity, baseline };
assert.ok(process.env.PG_PREFIX, 'PG_PREFIX must name the local PostgreSQL installation.');
const env = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', DATABASE_URL: '', PG_PREFIX: process.env.PG_PREFIX };
const runtimes = (process.env.OPTIONAL_PACKAGE_NODES ?? process.execPath).split(',');
const serviceSource = readFileSync(join(here, '../native-consumer-contracts/postgres-service.mjs'), 'utf8');
assert.equal(serviceSource.split("probe.listen(0, '127.0.0.1')").length, 2);
const serviceCopy = join(root, 'postgres-service.mjs');
writeFileSync(serviceCopy, serviceSource.replace("probe.listen(0, '127.0.0.1')", "probe.listen(57175, '127.0.0.1')"));
const { ownedPostgres } = await import(pathToFileURL(serviceCopy));
await runWithShutdown(report, join(root, 'report.json'), async (scope) => {
  const run = (cwd, binary, args, extra = {}) => command(report, cwd, binary, args, { ...env, ...extra }, { scope });
  const cells = [];
  for (const driver of ['8.15.0', '8.23.0']) for (const staged of [false, true]) {
    const consumer = join(root, `${staged ? 'optional' : 'default'}-${driver}`);
    mkdirSync(consumer);
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { 'turbine-orm': `file:${staged ? identity.archive : baseline}`, pg: driver } }));
    await run(consumer, 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund']);
    cpSync(join(here, 'pg-consumer.mjs'), join(consumer, 'pg-consumer.mjs'));
    cells.push({ consumer, staged, driver });
  }
  const pg = createRequire(join(cells[0].consumer, 'package.json'))('pg');
  const serviceRoot = join(root, 'pg');
  mkdirSync(serviceRoot);
  let handle;
  const processLifecycle = {
    assertOpen: scope.assertOpen,
    closeClient: (client) => bounded(client?.end() ?? Promise.resolve(), 2000, 'PG close'),
    wait: (promise, label) => bounded(promise, 2000, label),
    spawn(binary, args, options) {
      const record = { binary, args, cwd: serviceRoot };
      handle = scope.spawn(binary, args, options, record);
      handle.service = true;
      return handle.child;
    },
    stop: () => handle.stop(true),
  };
  const service = await ownedPostgres({ root: serviceRoot, env, driver: pg, report, processLifecycle,
    run: (cwd, binary, args) => run(cwd, binary, args),
    registerStop(stop) {
      scope.registerStop(async () => {
        try { await stop(); }
        finally {
          handle.capture();
          Object.assign(report.services[0], handle.record);
          rmSync(join(serviceRoot, 'data'), { recursive: true, force: true });
          rmSync(join(serviceRoot, 'socket'), { recursive: true, force: true });
        }
      });
    },
  });
  for (const cell of cells) for (const node of runtimes) for (const format of ['esm', 'cjs']) {
    const output = await run(cell.consumer, node, ['pg-consumer.mjs'], { FORMAT: format, STAGED: cell.staged ? '1' : '0', OWNED_PG_URL: service.url, OPTIONAL_ESBUILD: resolve(here, '../../node_modules/esbuild/lib/main.js') });
    report.results.push({ ...JSON.parse(output.trim().split('\n').at(-1)), runtime: node });
  }
  for (const node of runtimes) for (const format of ['esm', 'cjs']) for (const driver of ['8.15.0', '8.23.0']) {
    const pair = report.results.filter((row) => row.runtime === node && row.format === format && row.pg === driver);
    assert.equal(pair.length, 2);
    assert.deepEqual(pair[0].rows, pair[1].rows);
    assert.deepEqual(pair[0].related, pair[1].related);
    assert.deepEqual(pair[0].exports, pair[1].exports);
  }
});
console.log(JSON.stringify({ report: join(root, 'report.json'), pass: report.success }));
