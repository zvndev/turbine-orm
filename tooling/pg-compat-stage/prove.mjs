import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { command } from '../optional-pg-transports/harness.mjs';
import { bounded } from '../optional-pg-transports/lifecycle.mjs';
import { runWithShutdown } from '../optional-pg-transports/run.mjs';
import { extract, files, freshDirectory, hashFile, jsonBytes, normalPin, packageVersion, pgPin, source, toolsIdentity } from './contract.mjs';

const [identityFile, baseline, destination, node22, node24, ...extra] = process.argv.slice(2);
assert.ok(identityFile && baseline && destination && node22 && node24 && !extra.length,
  'Usage: node prove.mjs IDENTITY PINNED_NORMAL NEW_OUTPUT NODE22 NODE24');
const identity = JSON.parse(readFileSync(identityFile));
assert.equal(hashFile(identity.archive), identity.sha256);
assert.equal(hashFile(baseline), normalPin);
const root = freshDirectory(destination);
assert.ok(process.env.TMPDIR && resolve(process.env.TMPDIR).startsWith(dirname(root)), 'Owned parent TMPDIR required');
const report = { identity, commands: [], services: [], installs: [], results: [], driverFaults: [] };
const here = join(source, 'tooling/pg-compat-stage');
const npm = toolsIdentity().npm;
assert.ok(process.env.PG_PREFIX, 'PG_PREFIX must name the local PostgreSQL installation.');
const env = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', DATABASE_URL: '', TZ: 'UTC',
  PG_PREFIX: process.env.PG_PREFIX, npm_config_offline: 'true',
  STAGE_TSC: join(source, 'node_modules/typescript/lib/tsc.js'), STAGE_TYPE_ROOTS: join(source, 'node_modules/@types') };
function physicalFiles(root, symlinks) {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) { symlinks.push({ path, target: readlinkSync(path) }); return []; }
    assert.ok(entry.isDirectory() || entry.isFile());
    return entry.isDirectory() ? physicalFiles(path, symlinks) : [path];
  }).sort();
}
await runWithShutdown(report, join(root, 'report.json'), async scope => {
  const run = (cwd, binary, args, extraEnv = {}) => command(report, cwd, binary, args, { ...env, ...extraEnv }, { scope, timeoutMs: 180_000 });
  assert.equal((await run(root, node22, ['--version'])).trim(), 'v22.16.0');
  assert.equal((await run(root, node24, ['--version'])).trim(), 'v24.10.0');
  report.runtimes = [node22, node24].map(path => ({ path, sha256: hashFile(path) }));
  const normalReference = extract(baseline, join(root, 'normal-reference'), normalPin);
  const stageReference = extract(identity.archive, join(root, 'stage-reference'), identity.sha256);
  const cells = [];
  for (const [label, archive, appPg, actualPg, staged] of [
    ['stage-with-legacy-app', identity.archive, '8.15.0', pgPin, true],
    ['default-floor-control', baseline, '8.22.0', '8.22.0', false],
    ['default-current-control', baseline, '8.23.1', '8.23.1', false],
    ['default-legacy-negative', baseline, '8.15.0', '8.15.0', false],
  ]) {
    const dir = join(root, label);
    mkdirSync(dir);
    writeFileSync(join(dir, 'package.json'), jsonBytes({ private: true, type: 'module', dependencies: { 'turbine-orm': `file:${archive}`, pg: appPg } }));
    await run(dir, process.execPath, [npm, 'install', '--offline', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund']);
    const require = createRequire(join(dir, 'package.json'));
    const packageRoot = join(dir, 'node_modules/turbine-orm');
    const reference = staged ? stageReference : normalReference;
    // Nested dependency files belong to the installed graph, not the archive.
    const payload = Object.fromEntries(files(reference).map(path => [path.slice(reference.length + 1), readFileSync(path)]));
    const nested = join(packageRoot, 'node_modules');
    const actualNames = files(packageRoot).filter(path => !path.startsWith(nested + '/')).map(path => path.slice(packageRoot.length + 1));
    assert.deepEqual(actualNames, Object.keys(payload).sort());
    for (const [name, bytes] of Object.entries(payload)) assert.ok(readFileSync(join(packageRoot, name)).equals(bytes), `Installed payload: ${name}`);
    const stageRequire = createRequire(require.resolve('turbine-orm'));
    const driverPath = resolve(dirname(stageRequire.resolve('pg')), '../package.json');
    assert.equal(JSON.parse(readFileSync(driverPath)).version, actualPg);
    assert.equal(JSON.parse(readFileSync(resolve(dirname(require.resolve('pg')), '../package.json'))).version, appPg);
    if (staged) assert.ok(driverPath.startsWith(join(packageRoot, 'node_modules/pg/')));
    const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json')));
    const physicalLock = JSON.parse(readFileSync(join(dir, 'node_modules/.package-lock.json')));
    assert.equal(lock.packages['node_modules/turbine-orm'].name ?? 'turbine-orm', staged ? 'turbine-orm-pg-compat-stage' : 'turbine-orm');
    assert.equal(lock.packages['node_modules/turbine-orm'].version, staged ? `${packageVersion}-pg-compat.0` : packageVersion);
    assert.equal(lock.packages['node_modules/turbine-orm'].dependencies.pg, staged ? pgPin : '^8.15.0');
    const tree = JSON.parse(await run(dir, process.execPath, [npm, 'ls', '--all', '--omit=dev', '--omit=optional', '--json']));
    const symlinks = [];
    const installedFiles = physicalFiles(join(dir, 'node_modules'), symlinks);
    const productionHashes = Object.fromEntries(installedFiles.map(path => [path.slice(dir.length + 1), hashFile(path)]));
    const physicalPackages = installedFiles.filter(path => path.endsWith('/package.json')).map(path => ({ path, sha256: hashFile(path), manifest: JSON.parse(readFileSync(path)) }));
    const driverRoot = dirname(driverPath);
    const driverHashes = Object.fromEntries(files(driverRoot).map(path => [path.slice(driverRoot.length + 1), hashFile(path)]));
    assert.ok(symlinks.every(row => row.path.startsWith(join(dir, 'node_modules/.bin/'))), 'Only npm bin symlinks admitted');
    assert.equal(physicalPackages.some(row => row.manifest.name === '@types/pg'), false, 'Strict installed consumer has no pg declarations dependency');
    const install = { label, dir, appPg, actualPg, staged, archiveSha256: hashFile(archive), driverPath, driverHashes, productionHashes, lock, physicalLock, tree, physicalPackages, symlinks, packagePayloadFiles: actualNames.length };
    report.installs.push(install);
    writeFileSync(join(dir, 'production-install-proof.json'), jsonBytes(install));
    for (const name of ['consumer.mjs', 'namespaces.mjs', 'typed.mts']) cpSync(join(here, name), join(dir, name));
    cpSync(join(here, 'typed.mts'), join(dir, 'typed.cts'));
    cells.push({ dir, label, actualPg, staged });
  }
  const serviceRoot = join(root, 'pg');
  mkdirSync(serviceRoot);
  const serviceSource = readFileSync(join(source, 'tooling/native-consumer-contracts/postgres-service.mjs'), 'utf8');
  assert.equal(serviceSource.split("probe.listen(0, '127.0.0.1')").length, 2);
  const serviceCopy = join(root, 'postgres-service.mjs');
  writeFileSync(serviceCopy, serviceSource.replace("probe.listen(0, '127.0.0.1')", "probe.listen(59851, '127.0.0.1')"));
  const { ownedPostgres } = await import(pathToFileURL(serviceCopy));
  let handle;
  const processLifecycle = { assertOpen: scope.assertOpen,
    closeClient: client => bounded(client?.end() ?? Promise.resolve(), 2000, 'PG client close'),
    wait: (promise, label) => bounded(promise, 2000, label),
    spawn(binary, args, options) { handle = scope.spawn(binary, args, options, { binary, args, cwd: serviceRoot }); handle.service = true; return handle.child; },
    stop: () => handle.stop(true) };
  const driver = createRequire(join(cells[0].dir, 'node_modules/turbine-orm/package.json'))('pg');
  const service = await ownedPostgres({ root: serviceRoot, env, driver, report, processLifecycle,
    run: (cwd, binary, args) => run(cwd, binary, args),
    registerStop(stop) { scope.registerStop(async () => {
      try { await stop(); }
      finally {
        handle.capture(); Object.assign(report.services[0], handle.record);
        rmSync(join(serviceRoot, 'data'), { recursive: true, force: true });
        rmSync(join(serviceRoot, 'socket'), { recursive: true, force: true });
      }
    }); } });
  for (const node of [node22, node24]) for (const cell of cells) {
    const namespaces = JSON.parse((await run(cell.dir, node, ['namespaces.mjs'])).trim());
    report.results.push({ kind: 'namespaces', label: cell.label, node, namespaces });
    for (const format of ['esm', 'cjs']) {
      const stdout = await run(cell.dir, node, ['consumer.mjs'], { FORMAT: format, STAGED: cell.staged ? '1' : '0', EXPECT_PG: cell.actualPg, OWNED_PG_URL: service.url });
      report.results.push({ kind: 'native', label: cell.label, node, ...JSON.parse(stdout.trim().split('\n').at(-1)) });
    }
  }
  // Compare every export namespace against the normal package on each runtime.
  for (const node of [node22, node24]) {
    const namespaces = report.results.filter(row => row.kind === 'namespaces' && row.node === node);
    const comparable = row => Object.fromEntries(Object.entries(row.namespaces).map(([name, value]) => [name, { esm: value.esm, cjs: value.cjs }]));
    for (const row of namespaces) assert.deepEqual(comparable(row), comparable(namespaces[0]));
  }
  // Real present driver faults must propagate through unchanged ESM/CJS loaders.
  const installedDriver = dirname(report.installs[0].driverPath);
  const manifestPath = join(installedDriver, 'package.json');
  const manifest = readFileSync(manifestPath);
  const mainPath = join(installedDriver, 'lib/index.js');
  const main = readFileSync(mainPath);
  for (const [fault, mutate, pattern] of [
    ['malformed-manifest', () => writeFileSync(manifestPath, '{invalid'), /(?:Invalid package config|Error parsing|Expected property name|ERR_INVALID_PACKAGE_CONFIG)/],
    ['missing-main', () => writeFileSync(manifestPath, jsonBytes({ ...JSON.parse(manifest), main: 'missing.cjs', exports: undefined })), /MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|Cannot find/],
    ['transitive-init', () => writeFileSync(mainPath, "throw Object.assign(new Error('stage driver initialization sentinel'),{code:'MODULE_NOT_FOUND'});\n"), /stage driver initialization sentinel/],
  ]) {
    try {
      mutate();
      for (const node of [node22, node24]) for (const format of ['esm', 'cjs']) {
        const expression = format === 'esm' ? "import('turbine-orm')" : "Promise.resolve().then(()=>require('turbine-orm'))";
        const script = `const assert=require('node:assert/strict'); ${expression}.then(()=>{throw Error('Present driver fault swallowed')},error=>{assert.match(String(error.stack),${pattern}); console.log(JSON.stringify({refused:true,code:error.code,message:error.message}));});`;
        const stdout = await run(cells[0].dir, node, ['-e', script]);
        report.driverFaults.push({ fault, node, format, ...JSON.parse(stdout.trim()) });
      }
    } finally { writeFileSync(manifestPath, manifest); writeFileSync(mainPath, main); }
  }
  assert.equal(hashFile(manifestPath), report.installs[0].driverHashes['package.json']);
  assert.equal(hashFile(mainPath), report.installs[0].driverHashes['lib/index.js']);
});
console.log(JSON.stringify({ success: report.success, report: join(root, 'report.json') }));
