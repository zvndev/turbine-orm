import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageEntries, readJson, sha256, sourceIdentity } from './archive.mjs';

export function verifyBundle(directory) {
  const out = resolve(directory);
  const identity = readJson(join(out, 'identity.json'));
  assert.equal(identity.format, 1);
  assert.equal(identity.status, 'built', 'Bundle did not finish building');
  assert.equal(
    sha256(readFileSync(join(out, 'source-identity.json'))),
    identity.provenance.sha256,
    'Retained source identity changed',
  );
  sourceIdentity(readJson(join(out, 'source-identity.json')), identity.sourceCommit, identity.artifact.sha256);
  const { manifest, entries } = packageEntries(readFileSync(join(out, 'turbine-orm.tgz')), identity.artifact.sha256);
  assert.equal(manifest.version, identity.artifact.version);
  for (const [file, hash] of Object.entries(identity.packageFiles)) {
    assert.equal(sha256(entries.get(`package/${file}`)), hash, `Archive input identity changed: ${file}`);
    assert.equal(
      sha256(readFileSync(join(out, 'stage/node_modules/turbine-orm', file))),
      hash,
      `Staged input changed: ${file}`,
    );
  }
  assert.equal(
    sha256(readFileSync(join(out, 'introspected-schema.json'))),
    identity.schemaSha256,
    'Schema identity changed',
  );
  for (const [file, hash] of Object.entries(identity.generatedFiles))
    assert.equal(sha256(readFileSync(join(out, 'stage/generated', file))), hash, `Generated input changed: ${file}`);
  for (const [file, hash] of Object.entries(identity.module.inputs))
    assert.equal(sha256(readFileSync(join(out, 'stage', file))), hash, `Bundle input changed: ${file}`);
  assert.equal(sha256(readFileSync(join(out, 'turbine-arm.mjs'))), identity.module.sha256, 'Bundle SHA256 changed');
  const pin = readJson(join(out, 'comparators.json'));
  assert.equal(pin.format, 1);
  assert.equal(pin.arms.length, 1);
  assert.deepEqual(pin.arms[0], {
    name: 'Turbine',
    version: manifest.version,
    driver: 'pg@8.22.0',
    implementationKind: 'typed-orm',
    sourceCommit: identity.sourceCommit,
    artifact: { path: join(out, 'turbine-orm.tgz'), sha256: identity.artifact.sha256 },
    module: { path: join(out, 'turbine-arm.mjs'), sha256: identity.module.sha256 },
    supported: identity.supported,
  });
  return identity;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const identity = verifyBundle(process.argv[2]);
  console.log(
    JSON.stringify({
      status: 'verified',
      label: identity.label,
      sourceCommit: identity.sourceCommit,
      moduleSha256: identity.module.sha256,
    }),
  );
}
