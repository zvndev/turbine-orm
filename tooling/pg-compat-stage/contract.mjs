import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { files, fileHashes, hashBytes, hashFile, sourceHashes as normalInputs } from '../optional-package/artifact-contract.mjs';

export { files, fileHashes, hashBytes, hashFile };
export const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const packageVersion = JSON.parse(readFileSync(join(source, 'package.json'))).version;
// Exact normal build includes binary provenance and native unique selectors.
export const normalPin = '8c3d4f90faf7aaae4f38b567a65a432c49d10c246bb17f8697789fdb07f540a3';
export const pgPin = '8.22.0';
export const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
export function inputs(root = source) {
  const hashes = normalInputs(root);
  for (const path of [...files(join(root, 'tooling/pg-compat-stage')), ...['scripts/build-pg-compat-stage.mjs', 'scripts/strip-prepare.mjs', 'scripts/restore-prepare.mjs', '.npmignore', '.gitignore', 'docs/optional-pg-package-build.md'].map(name => join(root, name))]) {
    hashes[relative(root, path)] = hashFile(path);
  }
  return Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)));
}
export function toolsIdentity(root = source) {
  const npm = realpathSync(process.env.npm_execpath ?? (process.env.PATH ?? '').split(delimiter).map(path => join(path, 'npm')).find(existsSync));
  const paths = [process.execPath, npm, join(root, 'node_modules/typescript/lib/tsc.js'), join(root, 'node_modules/typescript/lib/_tsc.js'), join(root, 'node_modules/typescript/package.json')];
  return { node: process.version, npm, hashes: Object.fromEntries(paths.map(path => [path, hashFile(path)])) };
}
export function freshDirectory(path) {
  assert.ok(isAbsolute(path), 'Absolute fresh output required');
  const output = resolve(path);
  assert.ok(relative(source, output).startsWith(`..` + '/'), 'Output must be outside checkout');
  assert.ok(!existsSync(output), 'Output exists; preserve previous attempts');
  mkdirSync(output, { recursive: true });
  return output;
}
export function extract(archive, output, pin) {
  if (pin) assert.equal(hashFile(archive), pin, 'Archive pin mismatch');
  const members = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  assert.equal(new Set(members).size, members.length, 'Duplicate archive members');
  assert.ok(members.every(name => name.startsWith('package/') && !name.split('/').includes('..') && !name.includes('\\')), 'Unsafe archive member');
  assert.ok(execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8' }).trim().split('\n').every(line => /^[-d]/.test(line)), 'Links/special members refused');
  assert.ok(!existsSync(output));
  mkdirSync(output, { recursive: true });
  execFileSync('tar', ['-xzf', archive, '-C', output]);
  return join(output, 'package');
}
export function stageManifest(original) {
  assert.equal(original.name, 'turbine-orm');
  assert.equal(original.version, packageVersion);
  assert.deepEqual(original.dependencies, { pg: '^8.15.0' });
  const manifest = structuredClone(original);
  for (const key of Object.keys(manifest)) if (key.startsWith('//')) delete manifest[key];
  for (const key of ['scripts', 'devDependencies', 'lint-staged']) delete manifest[key];
  return Object.assign(manifest, { name: 'turbine-orm-pg-compat-stage', version: `${packageVersion}-pg-compat.0`, private: true,
    description: 'Optional full Turbine package with a tested compatible PostgreSQL driver pin.', dependencies: { pg: pgPin } });
}
export function expectedPayload(normal) {
  const manifest = stageManifest(JSON.parse(readFileSync(join(normal, 'package.json'))));
  const payload = Object.fromEntries(files(normal).map(path => [relative(normal, path), readFileSync(path)]));
  assert.equal(Object.keys(payload).length, 769, 'Pinned full normal inventory required');
  assert.equal(Object.keys(payload).filter(name => name.startsWith('dist/')).length, 765);
  payload['package.json'] = jsonBytes(manifest);
  payload['README.md'] = readFileSync(join(source, 'tooling/pg-compat-stage/README.md'));
  return payload;
}
export function exactPayload(root, expected) {
  assert.deepEqual(files(root).map(path => relative(root, path)), Object.keys(expected).sort(), 'Complete payload inventory mismatch');
  for (const [name, bytes] of Object.entries(expected)) assert.ok(readFileSync(join(root, name)).equals(bytes), `Unpermitted payload bytes: ${name}`);
}
export function npmRun(args, cwd = source, encoding) {
  const { npm } = toolsIdentity();
  return execFileSync(process.execPath, [npm, ...args], { cwd, encoding, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}` }, stdio: encoding ? 'pipe' : 'inherit' });
}
export function npmPack(cwd, destination) {
  const stdout = npmRun(['pack', '--json', '--pack-destination', destination], cwd, 'utf8');
  writeFileSync(join(destination, 'pack.stdout'), stdout);
  const start = /^\[\s*\{/m.exec(stdout)?.index;
  assert.notEqual(start, undefined, 'npm pack JSON missing after lifecycle output');
  return JSON.parse(stdout.slice(start))[0];
}
// Both producer and standalone verifier independently rebuild. A descriptor
// cannot claim a changed source hash while retaining stale emitted bytes.
export function rebuildNormal(output, pinnedArchive) {
  assert.equal(hashFile(pinnedArchive), normalPin, 'Required qualified normal pin');
  const before = inputs();
  const tools = toolsIdentity();
  const startedAt = new Date().toISOString();
  npmRun(['run', 'build']);
  assert.deepEqual(inputs(), before, 'Inputs changed during full build');
  const dist = fileHashes(join(source, 'dist'));
  const packDir = join(output, 'normal-pack');
  mkdirSync(packDir);
  const packed = npmPack(source, packDir);
  const archive = join(packDir, packed.filename);
  assert.equal(hashFile(archive), normalPin, 'Fresh normal package differs from pinned normal archive');
  const normal = extract(archive, join(output, 'normal-extracted'), normalPin);
  assert.deepEqual(fileHashes(join(normal, 'dist')), dist, 'Packed normal dist differs from rebuilt output');
  assert.deepEqual(inputs(), before, 'Inputs changed during normal packing/hooks');
  assert.deepEqual(toolsIdentity(), tools, 'Build tools changed');
  return { normal, receipt: { startedAt, finishedAt: new Date().toISOString(), tools, inputs: before, dist,
    normalArchive: archive, normalSha256: hashFile(archive), packed } };
}
export function verifyBinding(identity) {
  assert.equal(identity.schemaVersion, 1);
  assert.equal(identity.source, source, 'Verifier source is fixed by its own location');
  assert.equal(identity.normalSha256, normalPin);
  assert.equal(identity.pgPin, pgPin);
  assert.deepEqual(identity.build.tools, toolsIdentity(), 'Build tool identity mismatch');
  assert.deepEqual(identity.build.inputs, inputs(), 'Source/packed inputs stale or omitted');
  assert.deepEqual(identity.build.dist, fileHashes(join(source, 'dist')), 'Emitted output stale or omitted');
}
export function writePayload(root, payload) {
  for (const [name, bytes] of Object.entries(payload)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), bytes);
  }
}
