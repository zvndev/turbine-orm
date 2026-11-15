/** Actual repacks with forged descriptors, plus fresh-source/old-emission attacks. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileHashes, hashBytes, hashFile, sourceHashes } from './artifact-contract.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [identityPath, normalArchive, pin, destination] = process.argv.slice(2);
assert.ok(identityPath && normalArchive && pin && destination && !existsSync(destination));
assert.equal(hashFile(normalArchive), pin);
const identity = JSON.parse(readFileSync(identityPath));
assert.equal(identity.profile, 'better-sqlite3'); assert.equal(hashFile(identity.archive), identity.sha256);
const root = resolve(destination); mkdirSync(root);
const npm = process.env.npm_execpath; assert.ok(npm);
const commands = [], results = [];
function run(binary, args, cwd) {
  const output = spawnSync(binary, args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 16e6 });
  const record = { binary, binarySha256: hashFile(binary), args, cwd, status: output.status, signal: output.signal, error: output.error?.message, stdout: output.stdout, stderr: output.stderr };
  commands.push(record); return record;
}
function repack(staged, dir, edited) {
  const packedRun = run(process.execPath, [npm, 'pack', '--json', '--pack-destination', dir], staged);
  assert.equal(packedRun.status, 0);
  const packed = JSON.parse(packedRun.stdout)[0], archive = join(dir, packed.filename);
  Object.assign(edited, { archive, sha256: hashFile(archive), packed, stagedHashes: fileHashes(staged), exports: JSON.parse(readFileSync(join(staged, 'package.json'))).exports });
  const descriptor = join(dir, 'identity.json'); writeFileSync(descriptor, JSON.stringify(edited, null, 2));
  const rejected = run(process.execPath, [join(source, 'tooling/optional-package/verify-artifacts.mjs'), descriptor, normalArchive, pin, join(dir, 'verify')], source);
  assert.ok(rejected.status > 0, `Mutant admitted: ${dir}`);
  assert.match(rejected.stderr, /Optional payload inventory mismatch|Undeclared optional payload transformation|Runtime profile closure mismatch|pinned source\/build inputs changed|Default package drift|Source inputs changed/);
  return { archive, sha256: edited.sha256, rejection: rejected.stderr, status: rejected.status };
}
for (const fault of ['missing-esm-helper', 'missing-cjs-helper', 'missing-native-reference', 'missing-export', 'missing-declaration', 'forged-inventory', 'opaque-loader', 'aliased-loader', 'wrong-peer-pin', 'excluded-root-value', 'extra-subpath', 'missing-conditional-pg']) {
  const dir = join(root, fault), staged = join(dir, 'package'); mkdirSync(dir);
  cpSync(join(dirname(identityPath), 'package'), staged, { recursive: true });
  const edited = structuredClone(identity);
  if (fault === 'missing-esm-helper') rmSync(join(staged, 'dist/optional-peer-import.cjs'));
  if (fault === 'missing-cjs-helper') rmSync(join(staged, 'dist/cjs/optional-peer-import.cjs'));
  if (fault === 'missing-declaration') rmSync(join(staged, 'dist/client.d.ts'));
  if (fault === 'missing-conditional-pg') rmSync(join(staged, 'dist/unavailable-pg.js'));
  if (fault === 'forged-inventory') {
    const name = 'dist/optional-peer-import.cjs'; rmSync(join(staged, name));
    edited.closure.inventory = edited.closure.inventory.filter(row => row !== name);
    edited.closure.edges = edited.closure.edges.filter(row => row.from !== name && row.target !== name);
  }
  if (['missing-native-reference', 'opaque-loader', 'aliased-loader'].includes(fault)) {
    const path = join(staged, 'dist/better-sqlite3.js'), previous = readFileSync(path, 'utf8');
    const next = previous.replace("importOptionalPeer('better-sqlite3')", fault === 'missing-native-reference' ? 'Promise.resolve({})' : fault === 'opaque-loader' ? 'importOptionalPeer(process.env.UNREVIEWED_PEER)' : "((load) => load('better-sqlite3'))(importOptionalPeer)");
    assert.notEqual(next, previous); writeFileSync(path, next);
  }
  if (fault === 'excluded-root-value') {
    const path = join(staged, 'dist/profile.js');
    writeFileSync(path, readFileSync(path) + "\nexport {turbineSqlite} from './sqlite.js';\n");
  }
  if (['missing-export', 'wrong-peer-pin', 'extra-subpath'].includes(fault)) {
    const path = join(staged, 'package.json'), manifest = JSON.parse(readFileSync(path));
    if (fault === 'missing-export') delete manifest.exports['./better-sqlite3'];
    if (fault === 'wrong-peer-pin') manifest.dependencies['better-sqlite3'] = '^12.11.1';
    if (fault === 'extra-subpath') manifest.exports['./sqlite'] = manifest.exports['./better-sqlite3'];
    writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
  }
  results.push({ fault, ...repack(staged, dir, edited) });
}
for (const changedSource of ['src/better-sqlite3.ts', 'src/optional-peer-import.cts', 'src/cli/d1-local.ts']) {
  const dir = join(root, `stale-${changedSource.split('/').at(-1)}`), scratch = join(dir, 'source'), staged = join(dir, 'package');
  mkdirSync(scratch, { recursive: true });
  for (const name of Object.keys(identity.inputHashes)) { mkdirSync(dirname(join(scratch, name)), { recursive: true }); cpSync(join(source, name), join(scratch, name)); }
  cpSync(join(source, 'dist'), join(scratch, 'dist'), { recursive: true });
  symlinkSync(join(source, 'node_modules'), join(scratch, 'node_modules'));
  const path = join(scratch, changedSource); assert.ok(existsSync(path));
  writeFileSync(path, readFileSync(path) + '\n// Deliberate changed source with stale normal emission.\n');
  const inputs = sourceHashes(scratch);
  const edited = { ...identity, source: scratch, inputHashes: inputs, build: { ...identity.build, inputSha256: hashBytes(JSON.stringify(inputs)), distHashes: fileHashes(join(scratch, 'dist')) } };
  cpSync(join(dirname(identityPath), 'package'), staged, { recursive: true });
  results.push({ fault: 'fresh-source-old-emission-refreshed-descriptor', changedSource, ...repack(staged, dir, edited) });
}
writeFileSync(join(root, 'report.json'), JSON.stringify({ success: true, profile: 'better-sqlite3', runtime: { path: process.execPath, version: process.version, sha256: hashFile(process.execPath) }, results, commands }, null, 2));
console.log(JSON.stringify({ success: true, controls: results.length }));
