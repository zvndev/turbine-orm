#!/usr/bin/env node
/** Produce an optional package build with the existing default package as input. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { files, fileHashes, hashBytes, hashFile, loaderFiles, optionalManifest, rewriteDist, sourceHashes } from '../tooling/optional-package/artifact-contract.mjs';
import { profilePayload, profiles } from '../tooling/optional-package/profiles/contract.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [flag, destination, profileFlag, profile, ...extra] = process.argv.slice(2);
assert.ok(flag === '--out' && destination && extra.length === 0 &&
  (profileFlag === undefined || (profileFlag === '--profile' && Object.hasOwn(profiles, profile))),
  'Usage: npm run build:optional-package -- --out ABSOLUTE_NEW_DIRECTORY [--profile d1|sqlite|mysql|better-sqlite3]');
assert.ok(isAbsolute(destination), 'Output must be absolute');
const output = resolve(destination);
assert.ok(!existsSync(output), 'Output already exists; use a fresh directory to retain prior artifacts');
assert.ok(relative(source, output).startsWith('../'), 'Output must be outside the source checkout');
const original = JSON.parse(readFileSync(join(source, 'package.json')));
assert.equal(original.name, 'turbine-orm');
assert.deepEqual(Object.keys(original.dependencies), ['pg'], 'Review staging when mandatory dependencies change');
const inputHashes = sourceHashes(source);
const npmPath = process.env.npm_execpath ?? (process.env.PATH ?? '').split(delimiter).map(path => join(path, 'npm')).find(existsSync);
assert.ok(npmPath, 'npm executable required');
const npmCli = realpathSync(npmPath);
const env = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}` };
mkdirSync(output, { recursive: true });
// This script itself owns freshness, including direct invocation outside npm.
// The official prebuild regenerates Studio, and build removes old dist first.
const buildStartedAt = new Date().toISOString();
execFileSync(process.execPath, [npmCli, 'run', 'build'], { cwd: source, env, stdio: 'inherit' });
assert.deepEqual(sourceHashes(source), inputHashes, 'Source inputs changed during build');
const build = { command: [process.execPath, npmCli, 'run', 'build'], startedAt: buildStartedAt,
  finishedAt: new Date().toISOString(), node: { version: process.version, sha256: hashFile(process.execPath) },
  npmCliSha256: hashFile(npmCli), inputSha256: hashBytes(JSON.stringify(inputHashes)), distHashes: fileHashes(join(source, 'dist')) };
assert.ok(existsSync(join(source, 'dist/cjs/package.json')), 'Build did not produce CJS output');
const staged = join(output, 'package');
mkdirSync(staged);
let manifest, closure;
const rewrites = [];
if (profile) {
  const selected = profilePayload(source, source, original, profile, files(join(source, 'dist')).map(path => relative(source, path)));
  manifest = selected.manifest;
  closure = selected.closure;
  for (const [name, bytes] of Object.entries(selected.payload)) {
    mkdirSync(dirname(join(staged, name)), { recursive: true });
    writeFileSync(join(staged, name), bytes);
    if (existsSync(join(source, name)) && name.startsWith('dist/') && !readFileSync(join(source, name)).equals(bytes)) rewrites.push(name);
  }
} else {
for (const path of ['dist', 'skills', 'LICENSE']) cpSync(join(source, path), join(staged, path), { recursive: true });
const template = join(source, 'tooling/optional-package');
for (const path of loaderFiles) cpSync(join(template, path), join(staged, 'dist', path));
cpSync(join(template, 'README.md'), join(staged, 'README.md'));
manifest = optionalManifest(original);
writeFileSync(join(staged, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

for (const path of files(join(staged, 'dist'))) {
  if (!path.endsWith('.js')) continue;
  const previous = readFileSync(path);
  const name = relative(staged, path);
  const next = rewriteDist(name, previous);
  if (!next.equals(previous)) {
    writeFileSync(path, next);
    rewrites.push(name);
  }
}
assert.ok(rewrites.filter((path) => path.startsWith('dist/cjs/')).length >= 5, 'Missing CJS driver import sites');
assert.ok(rewrites.some((path) => path === 'dist/schema-sql.js'), 'Missing direct ESM driver import site');
}
for (const conditions of Object.values(manifest.exports)) {
  for (const condition of ['import', 'require']) {
    for (const kind of ['types', 'default']) assert.ok(existsSync(join(staged, conditions[condition][kind])), 'Export target absent');
  }
}
assert.deepEqual(sourceHashes(source), inputHashes, 'Source inputs changed during staging');
assert.deepEqual(fileHashes(join(source, 'dist')), build.distHashes, 'Build outputs changed during staging');
const stagedHashes = fileHashes(staged);
const packed = JSON.parse(execFileSync(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', output], { cwd: staged, env, encoding: 'utf8' }))[0];
const archive = join(output, packed.filename);
assert.deepEqual(sourceHashes(source), inputHashes, 'Source inputs changed during packing');
assert.deepEqual(fileHashes(staged), stagedHashes, 'Staged payload changed during packing');
let head = null;
try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
const identity = { schemaVersion: profile ? 3 : 2, ...(profile ? { profile, closure } : {}), stagedOnly: true, source, head, archive, sha256: hashFile(archive), packed,
  inputHashes, build, stagedHashes, rewrites, exports: manifest.exports, pgFloorRange: manifest.peerDependencies.pg };
writeFileSync(join(output, 'identity.json'), `${JSON.stringify(identity, null, 2)}\n`);
console.log(JSON.stringify({ archive, sha256: identity.sha256, identity: join(output, 'identity.json') }));
