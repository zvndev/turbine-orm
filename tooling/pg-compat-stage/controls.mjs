import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exactPayload, expectedPayload, extract, fileHashes, freshDirectory, hashFile, jsonBytes, normalPin, npmPack, source } from './contract.mjs';

const [identityPath, pinnedNormal, destination] = process.argv.slice(2);
assert.ok(identityPath && pinnedNormal && destination);
const identity = JSON.parse(readFileSync(identityPath));
const root = freshDirectory(destination);
const normal = extract(pinnedNormal, join(root, 'normal'), normalPin);
const stage = extract(identity.archive, join(root, 'stage'), identity.sha256);
const expected = expectedPayload(normal);
exactPayload(stage, expected);
const report = { positive: true, controls: [] };
const edit = (dir, name, fn) => writeFileSync(join(dir, name), fn(readFileSync(join(dir, name))));
for (const [name, mutate] of [
  ['extra-executable', dir => writeFileSync(join(dir, 'dist/undeclared.js'), 'export const surprise = 1;\n')],
  ['appended-executable', dir => edit(dir, 'dist/sql.js', bytes => `${bytes}\nexport const surprise = 1;\n`)],
  ['missing-edge-loader', dir => rmSync(join(dir, 'dist/pg-edge.js'))],
  ['missing-runtime', dir => rmSync(join(dir, 'dist/cjs/index.js'))],
  ['missing-declaration', dir => rmSync(join(dir, 'dist/index.d.ts'))],
  ['changed-declaration', dir => edit(dir, 'dist/index.d.ts', bytes => `${bytes}\nexport declare const surprise: 1;\n`)],
  ['missing-license', dir => rmSync(join(dir, 'LICENSE'))],
  ['missing-skills', dir => rmSync(join(dir, 'skills'), { recursive: true })],
  ['wrong-cjs-scope', dir => writeFileSync(join(dir, 'dist/cjs/package.json'), '{"type":"module"}\n')],
  ['added-export', dir => edit(dir, 'package.json', bytes => { const value = JSON.parse(bytes); value.exports['./surprise'] = './dist/sql.js'; return jsonBytes(value); })],
  ['unpinned-driver', dir => edit(dir, 'package.json', bytes => { const value = JSON.parse(bytes); value.dependencies.pg = '^8.15.0'; return jsonBytes(value); })],
  ['extra-mandatory-dependency', dir => edit(dir, 'package.json', bytes => { const value = JSON.parse(bytes); value.dependencies.surprise = '1.0.0'; return jsonBytes(value); })],
  ['arbitrary-readme', dir => writeFileSync(join(dir, 'README.md'), 'Unreviewed replacement\n')],
]) {
  const output = join(root, name);
  mkdirSync(output);
  const packageRoot = join(output, 'package');
  cpSync(stage, packageRoot, { recursive: true });
  mutate(packageRoot);
  const packed = npmPack(packageRoot, output);
  const archive = join(output, packed.filename);
  const extracted = extract(archive, join(output, 'extracted'));
  // Truthfully refresh all descriptor claims. Admission must still reject.
  const mutant = { ...identity, archive, sha256: hashFile(archive), stagedHashes: fileHashes(extracted), packed };
  writeFileSync(join(output, 'identity.json'), jsonBytes(mutant));
  let rejection;
  try { exactPayload(extracted, expected); } catch (error) { rejection = error.stack; }
  assert.ok(rejection, `Escaped complete payload contract: ${name}`);
  report.controls.push({ name, rejected: true, archive, sha256: mutant.sha256, rejection });
}
for (const name of ['forged-build-tools', 'omitted-build-tools']) {
  const mutant = structuredClone(identity);
  if (name === 'omitted-build-tools') delete mutant.build.tools;
  else mutant.build.tools = { node: 'v0.0.0-forged', npm: '/nonexistent/forged-npm', hashes: {} };
  const descriptor = join(root, `${name}.json`);
  writeFileSync(descriptor, jsonBytes(mutant));
  let rejection;
  try {
    execFileSync(process.execPath, [join(source, 'tooling/pg-compat-stage/verify.mjs'), descriptor, pinnedNormal, join(root, `${name}-verification`)], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    writeFileSync(join(root, `${name}.stdout`), error.stdout ?? '');
    writeFileSync(join(root, `${name}.stderr`), error.stderr ?? '');
    assert.match(String(error.stderr), /Build tool identity mismatch/);
    rejection = String(error.stderr);
  }
  assert.ok(rejection, `Unverified tool provenance accepted: ${name}`);
  report.controls.push({ name, rejected: true, rejection });
}
// A private source copy is not a checkout. Even refreshed source and dist
// claims must fail a standalone verifier which actually recompiles the source.
const snapshot = join(root, 'stale-source');
mkdirSync(snapshot);
for (const name of ['src', 'types', 'skills', 'scripts', 'tooling', 'docs', 'dist', 'node_modules',
  'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.cjs.json', 'README.md', 'LICENSE', '.npmignore', '.gitignore']) {
  cpSync(join(source, name), join(snapshot, name), { recursive: true });
}
const changed = join(snapshot, 'src/sql.ts');
writeFileSync(changed, `${readFileSync(changed)}\nexport const pgStageStaleSourceControl = 8675309;\n`);
const snapshotContract = await import(pathToFileURL(join(snapshot, 'tooling/pg-compat-stage/contract.mjs')));
const mutant = structuredClone(identity);
mutant.source = snapshot;
mutant.build.inputs = snapshotContract.inputs();
mutant.build.dist = fileHashes(join(snapshot, 'dist'));
mutant.build.tools = snapshotContract.toolsIdentity();
const mutantPath = join(root, 'stale-source-identity.json');
writeFileSync(mutantPath, jsonBytes(mutant));
// Show that descriptor equality alone would admit this changed source.
snapshotContract.verifyBinding(mutant);
let rejected = false;
try {
  execFileSync(process.execPath, [join(snapshot, 'tooling/pg-compat-stage/verify.mjs'), mutantPath, pinnedNormal, join(root, 'stale-source-verification')], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
} catch (error) {
  writeFileSync(join(root, 'stale-source.stdout'), error.stdout ?? '');
  writeFileSync(join(root, 'stale-source.stderr'), error.stderr ?? '');
  assert.match(String(error.stderr), /Fresh normal package differs from pinned normal archive/);
  rejected = true;
}
assert.equal(rejected, true, 'Stale source escaped independently rebuilding verifier');
report.controls.push({ name: 'stale-source-with-refreshed-descriptor', rejected, source: snapshot, sourceSha256: hashFile(changed), descriptorEqualityPassed: true, independentRebuildRejected: true });
writeFileSync(join(root, 'report.json'), jsonBytes({ success: true, ...report }));
console.log(JSON.stringify({ success: true, controls: report.controls.length, report: join(root, 'report.json') }));
