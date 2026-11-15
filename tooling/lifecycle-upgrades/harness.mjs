import assert from 'node:assert/strict';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { artifact, sha256 } from '../lifecycle-examples/harness.mjs';

// Paths and pins are caller inputs, never release/registry assertions.
export function artifactPair(baseline, baselineHash, candidate, candidateHash) {
  const pair = {};
  for (const [label, path, pin] of [
    ['baseline', baseline, baselineHash],
    ['candidate', candidate, candidateHash],
  ]) {
    const value = artifact(path);
    assert.match(pin ?? '', /^[a-f0-9]{64}$/, `${label} requires an explicit SHA256 pin`);
    assert.equal(value.sha256, pin, `${label} artifact SHA256 differs from its pin`);
    pair[label] = value;
  }
  assert.notEqual(pair.baseline.sha256, pair.candidate.sha256, 'Identical artifacts cannot exercise an upgrade');
  return pair;
}

export function files(root, prefix = '', skipDependencies = false) {
  const result = {};
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (skipDependencies && !prefix && entry.name === 'node_modules') continue;
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert.ok(!entry.isSymbolicLink(), `Fixture payload must not contain symlinks: ${name}`);
    if (entry.isDirectory()) Object.assign(result, files(root, name, skipDependencies));
    else {
      assert.ok(entry.isFile(), `Expected ordinary file: ${name}`);
      result[name] = sha256(readFileSync(join(root, name)));
    }
  }
  assert.ok(Object.keys(result).length, 'File evidence must not be empty');
  return result;
}

export function payloadTransition(baseline, candidate) {
  for (const manifest of [baseline, candidate]) assert.equal(manifest.name, 'turbine-orm');
  assert.equal(baseline.version, candidate.version, 'This workload exercises equal-version unreleased artifacts');
  assert.equal(baseline.exports['./mysql/seed'], undefined, 'Baseline must precede the MySQL seed capability');
  assert.ok(candidate.exports['./mysql/seed'], 'Candidate must provide the new MySQL seed capability');
}

export function installedPayload(app, expected) {
  const root = join(app, 'node_modules/turbine-orm');
  assert.equal(lstatSync(root).isSymbolicLink(), false, 'Installed package must be ordinary application-local bytes');
  assert.ok(realpathSync(root).startsWith(`${realpathSync(app)}/`), 'Installed package escaped the application');
  // Nested dependencies belong to npm; all other installed files must match exactly.
  assert.ok(Object.keys(expected).length, 'Expected installed payload must not be empty');
  const actual = files(root, '', true);
  assert.deepEqual(actual, expected, 'Wrong installed bytes: package version alone cannot prove an upgrade');
  return sha256(JSON.stringify(actual));
}

export function preserved(actual, expected, label) {
  assert.ok(expected.length, `${label}: baseline evidence must be nonempty`);
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, `${label}: retained evidence differs`);
}

export function recovered(history, dirty, name, checksum) {
  assert.deepEqual(dirty, [], 'Recovery was skipped: dirty migration journal remains');
  assert.equal(
    history.filter((row) => row.name === name && row.checksum === checksum).length,
    1,
    'Recovery must record the exact applied outcome once',
  );
}
