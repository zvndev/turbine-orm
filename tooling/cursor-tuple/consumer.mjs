import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run with each required Node runtime against the same already-built tarball.
const tarball = resolve(process.argv[2] ?? '');
assert.ok(process.argv[2] && existsSync(tarball), 'Pass a packed turbine-orm tarball as the first argument');
const here = dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(readFileSync(join(here, '../../package-lock.json'), 'utf8'));
const driverNames = new Set();
function collectDriver(name) {
  if (driverNames.has(name)) return;
  const entry = lock.packages[`node_modules/${name}`];
  assert.ok(entry?.version, `Root lock must identify ${name}`);
  driverNames.add(name);
  for (const dep of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies })) collectDriver(dep);
}
collectDriver('pg');
const driverOverrides = Object.fromEntries([...driverNames].map(name => [name, lock.packages[`node_modules/${name}`].version]));
const rootRequire = createRequire(join(here, '../../package.json'));
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const root = mkdtempSync(join(tmpdir(), 'tuple-cursor-consumer-'));
const results = [];
const drivers = [];
let cleanupError;
let failed = false;
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 120_000 });
  results.push({ command, args, exit: result.status, stdout: result.stdout, stderr: result.stderr });
  assert.equal(result.status, 0, `${command}: ${result.stdout}\n${result.stderr}\n${result.error ?? ''}`);
};
try {
  cpSync(join(here, 'fixtures'), root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'tuple-cursor-consumer', private: true, type: 'module', overrides: driverOverrides }));
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', strict: true, noEmit: true, skipLibCheck: false },
    include: ['consumer.mts', 'consumer.cts'],
  }));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball,
    `typescript@${lock.packages['node_modules/typescript'].version}`,
    `@types/node@${lock.packages['node_modules/@types/node'].version}`]);
  assert.equal(existsSync(join(root, 'node_modules/@types/pg')), false, 'Consumers must compile without @types/pg');
  const installed = createRequire(join(root, 'package.json'));
  const fromDriver = createRequire(installed.resolve('pg'));
  for (const name of driverNames) {
    const mainPath = fromDriver.resolve(name);
    let directory = dirname(mainPath);
    let packagePath = join(directory, 'package.json');
    while (!existsSync(packagePath) || JSON.parse(readFileSync(packagePath, 'utf8')).name !== name) {
      const parent = dirname(directory);
      assert.notEqual(parent, directory, `Cannot identify loaded ${name}`);
      directory = parent;
      packagePath = join(directory, 'package.json');
    }
    const version = JSON.parse(readFileSync(packagePath, 'utf8')).version;
    assert.equal(version, lock.packages[`node_modules/${name}`].version, `${name} must match the root lock`);
    assert.equal(sha(mainPath), sha(rootRequire.resolve(name)), `${name} loaded code must match the root driver`);
    drivers.push({ name, version, packagePath, mainPath, packageSha256: sha(packagePath), mainSha256: sha(mainPath) });
  }

  run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json']);
  run(process.execPath, ['runtime.mjs']);
  run(process.execPath, ['runtime.cjs']);
} catch (error) {
  failed = true;
  process.stderr.write(`${error.stack}\n`);
} finally {
  try { rmSync(root, { recursive: true, force: true }); } catch (error) { failed = true; cleanupError = error.message; }
  process.stdout.write(`${JSON.stringify({ node: process.version, execPath: process.execPath, fixtureRoot: root, tarball, drivers, cleanupError, results, status: failed ? 'failed' : 'passed', cleanup: !existsSync(root) }, null, 2)}\n`);
  process.exitCode = failed ? 1 : 0;
}
