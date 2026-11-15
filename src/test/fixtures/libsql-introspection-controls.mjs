/** Required-peer/native-engine and owned-handle faults, confined to disposable copies. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const peer = process.env.TURBINE_LIBSQL_INTROSPECTION_PEER;
assert.ok(peer, 'Native optional peer installation path is required.');
const root = mkdtempSync(join(tmpdir(), 'turbine-libsql-introspection-controls-'));
const report = { node: process.version, root, commands: [], passed: false };
const reportPath = process.env.TURBINE_LIBSQL_INTROSPECTION_REPORT;
const save = () => {
  if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
};
const active = new Map();
async function stop() {
  for (const [pid, child] of active) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    await new Promise((done) => child.once('close', done));
  }
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, async () => {
    await stop();
    rmSync(root, { recursive: true, force: true });
    save();
    process.exit(1);
  });
async function run(label, args, cwd, expected) {
  const child = spawn(process.execPath, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  active.set(child.pid, child);
  const record = { label, command: process.execPath, args, cwd, pid: child.pid, pgid: child.pid, ports: [] };
  report.commands.push(record);
  save();
  let output = '';
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    output += data;
  });
  const timeout = setTimeout(() => process.kill(-child.pid, 'SIGTERM'), 90_000);
  let status;
  try {
    status = await new Promise((done, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => done({ code, signal }));
    });
  } finally {
    clearTimeout(timeout);
    active.delete(child.pid);
  }
  Object.assign(record, status, { output, processAbsent: !existsSync(`/proc/${child.pid}`) });
  save();
  assert.equal(status.code, expected, `${label}: ${output}`);
  return output;
}
try {
  const source = join(root, 'source');
  mkdirSync(source);
  for (const name of ['src', 'types', 'package.json', 'tsconfig.json'])
    cpSync(join(repo, name), join(source, name), { recursive: true });
  const modules = join(source, 'node_modules');
  mkdirSync(modules);
  for (const name of readdirSync(join(repo, 'node_modules'))) {
    if (name !== '@libsql') symlinkSync(join(repo, 'node_modules', name), join(modules, name));
  }
  const tests = ['--import', 'tsx', '--test', 'src/test/libsql-introspection.test.ts'];
  assert.match(
    await run('required-native-suite-without-peer', tests, source, 1),
    /Cannot find package|MODULE_NOT_FOUND/,
  );
  const nativeModules = resolve(peer, '../..');
  const copiedModules = join(root, 'native/node_modules');
  cpSync(nativeModules, copiedModules, { recursive: true });
  symlinkSync(join(copiedModules, '@libsql'), join(modules, '@libsql'));
  const binaries = [];
  function findBinaries(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) findBinaries(file);
      else if (file.endsWith('.node')) binaries.push(file);
    }
  }
  findBinaries(copiedModules);
  assert.ok(binaries.length > 0, 'No native engines found to omit.');
  assert.ok(
    existsSync(join(copiedModules, '@libsql/client/lib-esm/node.js')),
    'Peer source must remain present for engine omission.',
  );
  for (const file of binaries) rmSync(file);
  report.omittedNativeBinaries = binaries;
  assert.match(
    await run('required-native-suite-without-engine', tests, source, 1),
    /native|binding|MODULE_NOT_FOUND|Cannot find/i,
  );

  // Owned-client observability uses real native clients behind an isolated peer
  // wrapper. No source injection point or shared peer mutation is needed.
  const handles = join(root, 'handles');
  mkdirSync(handles);
  cpSync(join(repo, 'dist'), join(handles, 'dist'), { recursive: true });
  cpSync(join(repo, 'package.json'), join(handles, 'package.json'));
  mkdirSync(join(handles, 'node_modules/@libsql/client'), { recursive: true });
  symlinkSync(join(repo, 'node_modules/pg'), join(handles, 'node_modules/pg'));
  const shim = join(handles, 'node_modules/@libsql/client');
  writeFileSync(
    join(shim, 'package.json'),
    JSON.stringify({ name: '@libsql/client', type: 'module', exports: { './node': './node.js' } }),
  );
  writeFileSync(
    join(shim, 'node.js'),
    `import { createClient as native } from ${JSON.stringify(pathToFileURL(join(resolve(peer), 'lib-esm/node.js')).href)};
export function createClient(config) {
 const client = native(config); const state = { client, closes: 0 }; globalThis.catalogHandle = state;
 return new Proxy(client, { get(target, key) {
  if (key === 'close') return () => { state.closes++; return client.close(); };
  if (key === 'execute') return async (statement) => {
   if (globalThis.catalogFault === 'probe' || (globalThis.catalogFault === 'catalog' && statement.sql.includes('sqlite_master'))) throw new Error('owned catalog injected native error');
   return client.execute(statement);
  };
  if (key === 'protocol' && globalThis.catalogFault === 'protocol') return 'https';
  const value = Reflect.get(target,key,target); return typeof value === 'function' ? value.bind(target) : value;
 }});
}`,
  );
  writeFileSync(
    join(handles, 'control.mjs'),
    `import assert from 'node:assert/strict';
import { introspectLibsql } from './dist/libsql/introspect.js';
for (const fault of [undefined, 'protocol', 'probe', 'catalog', 'rename']) {
 globalThis.catalogFault = fault;
 if (fault === undefined) await introspectLibsql(':memory:');
 else await assert.rejects(introspectLibsql(':memory:', fault === 'rename' ? { relationNames: { missing: {} } } : {}));
 assert.equal(globalThis.catalogHandle.closes, 1, fault);
 assert.equal(globalThis.catalogHandle.client.closed, true, fault);
}
console.log('owned native handles closed exactly once on success and four error paths');`,
  );
  assert.match(await run('owned-real-native-handle-cleanup', ['control.mjs'], handles, 0), /closed exactly once/);
  report.passed = true;
  console.log(
    JSON.stringify({
      node: process.version,
      missingPeer: 'required suite failed',
      missingNativeEngine: 'required suite failed',
      ownedHandles: 'closed once on success and four errors',
    }),
  );
} finally {
  await stop();
  rmSync(root, { recursive: true, force: true });
  report.fixtureRemoved = !existsSync(root);
  save();
}
