/** Faults only disposable copies. Repacking and descriptor edits cannot bless them. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileHashes, hashFile, sourceHashes, verifyPayload } from '../artifact-contract.mjs';
const [identityPath, originalArchive, originalPin, destination] = process.argv.slice(2);
assert.ok(identityPath && originalArchive && originalPin && destination && !existsSync(destination));
assert.equal(hashFile(originalArchive), originalPin);
const identity = JSON.parse(readFileSync(identityPath));
assert.equal(hashFile(identity.archive), identity.sha256);
const root = resolve(destination), here = dirname(fileURLToPath(import.meta.url));
mkdirSync(root);
const npm = process.env.npm_execpath;
assert.ok(npm, 'Set npm_execpath to the npm CLI JavaScript file, or run through npm exec.');
const subprocess = { encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 };
const results = [];
for (const fault of ['missing-loader', 'changed-loader', 'missing-declaration', 'missing-target', 'missing-workerd-target', 'altered-code', 'unsupported-export', 'cjs-scope']) {
  const output = join(root, fault), staged = join(output, 'package');
  mkdirSync(output);
  cpSync(join(dirname(identityPath), 'package'), staged, { recursive: true });
  if (fault === 'missing-loader') rmSync(join(staged, 'dist/optional-pg.cjs'));
  if (fault === 'changed-loader') writeFileSync(join(staged, 'dist/optional-pg.cjs'), 'module.exports = {};');
  if (fault === 'missing-declaration') rmSync(join(staged, 'dist/client.d.ts'));
  if (fault === 'missing-target') rmSync(join(staged, 'dist/query/builder.js'));
  if (fault === 'missing-workerd-target') rmSync(join(staged, 'dist/unavailable-pg.js'));
  if (fault === 'altered-code') { const path = join(staged, `dist/${identity.profile}.js`); writeFileSync(path, readFileSync(path) + '\nexport const unreviewed = 42;\n'); }
  if (fault === 'unsupported-export') {
    const path = join(staged, 'package.json'), manifest = JSON.parse(readFileSync(path));
    manifest.exports['./cli'] = manifest.exports['.']; writeFileSync(path, JSON.stringify(manifest));
  }
  if (fault === 'cjs-scope') writeFileSync(join(staged, 'dist/cjs/package.json'), '{"type":"module"}');
  const packed = JSON.parse(execFileSync(process.execPath, [npm, 'pack', '--json', '--pack-destination', output], { ...subprocess, cwd: staged }))[0];
  const archive = join(output, packed.filename);
  const edited = { ...identity, archive, sha256: hashFile(archive), stagedHashes: fileHashes(staged) };
  // Adversarial self-declared inventory and exports do not define the contract.
  edited.exports = JSON.parse(readFileSync(join(staged, 'package.json'))).exports;
  const descriptor = join(output, 'identity.json');
  writeFileSync(descriptor, JSON.stringify(edited, null, 2));
  let rejection;
  try { execFileSync(process.execPath, [join(here, '../verify-artifacts.mjs'), descriptor, originalArchive, originalPin, join(output, 'verify')], subprocess); }
  catch (error) { rejection = { status: error.status, stdout: error.stdout, stderr: error.stderr }; }
  assert.ok(rejection?.status > 0, `${fault} must reject`);
  assert.match(rejection.stderr, /Optional payload inventory mismatch|Undeclared optional payload transformation/, fault);
  results.push({ fault, archive, sha256: edited.sha256, ...rejection });
}
const originalRoot = join(root, 'original');
mkdirSync(originalRoot);
execFileSync('tar', ['-xzf', originalArchive, '-C', originalRoot], subprocess);
const changedSource = join(identity.source, 'tooling/optional-package/profiles/fixture.mjs');
const before = readFileSync(changedSource);
try {
  writeFileSync(changedSource, Buffer.concat([before, Buffer.from('\n// deliberate stale-source control\n')]));
  assert.throws(() => verifyPayload(join(originalRoot, 'package'), join(dirname(identityPath), 'package'), identity.source, identity), /Source inputs changed or omitted/);
  results.push({ fault: 'stale-source', rejected: true });
} finally { writeFileSync(changedSource, before); }
assert.deepEqual(sourceHashes(identity.source), identity.inputHashes);
assert.equal(verifyPayload(join(originalRoot, 'package'), join(dirname(identityPath), 'package'), identity.source, identity).exactOptionalPayload, true);
writeFileSync(join(root, 'report.json'), JSON.stringify({ success: true, profile: identity.profile, results, sourceRestored: true }, null, 2));
console.log(JSON.stringify({ success: true, controls: results.length }));
