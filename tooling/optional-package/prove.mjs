/** Installed-package proof. All mutable output stays in a fresh evidence root. */
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { command, installedPayload } from '../optional-pg-transports/harness.mjs';
import { runWithShutdown } from '../optional-pg-transports/run.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../..');
const [identityPath, destination] = process.argv.slice(2);
assert.ok(identityPath && destination, 'Usage: node tooling/optional-package/prove.mjs IDENTITY NEW_OUTPUT');
const identity = JSON.parse(readFileSync(identityPath));
const root = resolve(destination);
assert.ok(!existsSync(root), 'Retain old evidence; choose a fresh output directory');
mkdirSync(root, { recursive: true });
const report = { commands: [], services: [], identity, results: [] };
const env = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', DATABASE_URL: '' };
const runtimes = (process.env.OPTIONAL_PACKAGE_NODES ?? process.execPath).split(',');
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
assert.equal(hash(identity.archive), identity.sha256);
function closure(consumer) {
  const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json')));
  const packages = Object.entries(lock.packages).filter(([path]) => path);
  for (const [path, data] of packages) {
    assert.ok(!/(?:^|\/)node_modules\/(?:pg(?:-[^/]+)?|pgpass|@types\/pg)(?:\/|$)/.test(path), `Unwanted pg install: ${path}`);
    assert.ok(!/^pg(?:-|$)/.test(data.name ?? ''), `Unwanted pg alias: ${data.name}`);
  }
  const physical = [];
  function scan(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) continue; // npm executable links are not packages.
      if (entry.isDirectory()) scan(child);
      else if (entry.name === 'package.json') {
        let pkg;
        try { pkg = JSON.parse(readFileSync(child)); } catch { continue; }
        assert.ok(!/^(?:pg(?:-|$)|pgpass$|@types\/pg$)/.test(pkg.name ?? ''), `Physical pg package: ${child}`);
        if (pkg.name) physical.push({ path: child, name: pkg.name, version: pkg.version, sha256: hash(child) });
      }
    }
  }
  scan(join(consumer, 'node_modules'));
  assert.ok(physical.some((pkg) => pkg.name === 'turbine-orm-optional-stage'));
  return { lockSha256: hash(join(consumer, 'package-lock.json')), packages, physical };
}
await runWithShutdown(report, join(root, 'report.json'), async (scope) => {
  const run = (cwd, binary, args, extra = {}) => command(report, cwd, binary, args, { ...env, ...extra }, { scope });
  const consumer = join(root, 'no-driver');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { 'turbine-orm': `file:${identity.archive}` } }));
  await run(consumer, 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund']);
  report.productionClosure = closure(consumer);
  assert.equal(report.productionClosure.packages.length, 1, 'No-driver production closure must contain only the staged package');
  report.installedHashes = installedPayload(join(dirname(identityPath), 'package'), join(consumer, 'node_modules/turbine-orm'));
  cpSync(join(here, 'consumer.mjs'), join(consumer, 'consumer.mjs'));
  for (const node of runtimes) for (const format of ['esm', 'cjs']) {
    const out = await run(consumer, node, ['consumer.mjs'], { FORMAT: format });
    report.results.push(JSON.parse(out.trim().split('\n').at(-1)));
  }
  for (const node of runtimes) {
    const help = await run(consumer, node, ['node_modules/turbine-orm/dist/cli/index.js', '--help']);
    assert.match(help, /turbine/i, 'Packed CLI must start without pg');
  }
  // Compiler support is installed after the production dependency tree has been recorded.
  await run(consumer, 'npm', ['install', '--save-dev', '--ignore-scripts', '--no-audit', '--no-fund', '@types/node@22.20.4']);
  report.typeClosure = closure(consumer);
  for (const ext of ['mts', 'cts']) cpSync(join(here, 'typed.mts'), join(consumer, `typed.${ext}`));
  const tsc = join(source, 'node_modules/typescript/bin/tsc');
  for (const node of runtimes) {
    await run(consumer, node, [tsc, '--noEmit', '--strict', '--skipLibCheck', 'false', '--types', 'node', '--module', 'NodeNext', '--target', 'ES2023', 'typed.mts', 'typed.cts']);
    for (const mode of ['esm', 'cjs']) {
      const dir = `generated-${mode}`;
      await run(consumer, node, [tsc, '--strict', '--skipLibCheck', 'false', '--types', 'node', '--module', mode === 'esm' ? 'NodeNext' : 'CommonJS', '--moduleResolution', mode === 'esm' ? 'NodeNext' : 'Bundler', '--target', 'ES2023', '--outDir', dir, 'generated-sqlite/index.ts', 'generated-pg/index.ts']);
      if (mode === 'cjs') writeFileSync(join(consumer, dir, 'package.json'), '{"type":"commonjs"}');
      const expression = mode === 'esm' ? `const {turbine}=await import('./${dir}/generated-sqlite/index.js')` : `const {turbine}=require('./${dir}/generated-sqlite/index.js')`;
      await run(consumer, node, ['--input-type=' + (mode === 'esm' ? 'module' : 'commonjs'), '-e', `${expression}; const {DatabaseSync}=${mode === 'esm' ? "await import('node:sqlite')" : "require('node:sqlite')"}; const raw=new DatabaseSync(':memory:');raw.exec('CREATE TABLE items(id INTEGER PRIMARY KEY,tenant_id INTEGER NOT NULL,label TEXT NOT NULL UNIQUE,active BOOLEAN,payload JSON,happened_at TIMESTAMP,large BIGINT)'); const db=turbine(raw); ${mode === 'esm' ? 'await' : 'void'} db.disconnect();raw.close();`]);
    }
  }
  report.finalClosure = closure(consumer);
  report.types = { strict: true, skipLibCheck: false, formats: ['mts', 'cts'], generatedImportsExecuted: ['esm', 'cjs'] };
});
console.log(JSON.stringify({ report: join(root, 'report.json'), pass: report.success }));
