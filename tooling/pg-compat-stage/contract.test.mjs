import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileHashes, inputs, normalPin, pgPin, source, toolsIdentity, verifyBinding } from './contract.mjs';

function identity() {
  return { schemaVersion: 1, source, normalSha256: normalPin, pgPin,
    build: { inputs: inputs(), dist: fileHashes(join(source, 'dist')), tools: toolsIdentity() } };
}

test('accepts the actual complete tool identity alongside source and emitted inputs', () => {
  assert.doesNotThrow(() => verifyBinding(identity()));
});

test('refuses absent or wholly invented build tool provenance', () => {
  for (const tools of [undefined, { node: 'v0.0.0-forged', npm: '/nonexistent/forged-npm', hashes: {} }]) {
    const value = identity();
    if (tools === undefined) delete value.build.tools;
    else value.build.tools = tools;
    assert.throws(() => verifyBinding(value), /Build tool identity mismatch/);
  }
});

test('refuses individual version, executable, inventory and content-hash mismatches', () => {
  const original = identity();
  const mutations = [
    value => { value.build.tools.node = 'v0.0.0-forged'; },
    value => { value.build.tools.npm = '/nonexistent/forged-npm'; },
    value => { value.build.tools.hashes = {}; },
    value => { value.build.tools.hashes['/undeclared/build-tool'] = '0'.repeat(64); },
    ...Object.keys(original.build.tools.hashes).flatMap(path => [
      value => { delete value.build.tools.hashes[path]; },
      value => { value.build.tools.hashes[path] = '0'.repeat(64); },
    ]),
  ];
  for (const mutate of mutations) {
    const value = structuredClone(original);
    mutate(value);
    assert.throws(() => verifyBinding(value), /Build tool identity mismatch/);
  }
});

test('standalone verification refuses fabricated tools before output creation or rebuilding', () => {
  const root = mkdtempSync(join(tmpdir(), 'pg-stage-tool-identity-'));
  try {
    const value = identity();
    value.build.tools = { node: 'v0.0.0-forged', npm: '/nonexistent/forged-npm', hashes: {} };
    const descriptor = join(root, 'identity.json');
    writeFileSync(descriptor, JSON.stringify(value));
    const output = join(root, 'must-not-create');
    const result = spawnSync(process.execPath, [join(source, 'tooling/pg-compat-stage/verify.mjs'),
      descriptor, join(root, 'must-not-read-normal.tgz'), output], { encoding: 'utf8', timeout: 30000 });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Build tool identity mismatch/);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
