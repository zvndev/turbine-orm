import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('retained actual root archive has no D1 catalog export and stays byte-identical', () => {
  const rootArchive = process.env.TURBINE_D1_TARBALL;
  assert.ok(rootArchive, 'The retained actual root artifact is required for provenance.');
  const expected = process.env.TURBINE_D1_TARBALL_SHA256;
  assert.match(expected ?? '', /^[a-f0-9]{64}$/, 'Pin the retained actual root archive SHA256.');
  const hash = () => createHash('sha256').update(readFileSync(rootArchive)).digest('hex');
  assert.equal(hash(), expected);
  const root = mkdtempSync(join(tmpdir(), 'd1-native-'));
  try {
    const destination = join(root, 'node_modules/turbine-orm');
    mkdirSync(destination, { recursive: true });
    execFileSync('tar', ['-xzf', rootArchive, '--strip-components=1', '-C', destination]);
    const manifest = JSON.parse(readFileSync(join(destination, 'package.json'), 'utf8'));
    assert.equal(manifest.exports['./d1/introspect'], undefined);
    writeFileSync(join(root, 'consumer.cjs'), "require('turbine-orm/d1/introspect');");
    assert.throws(
      () => execFileSync(process.execPath, [join(root, 'consumer.cjs')], { stdio: 'pipe' }),
      /ERR_PACKAGE_PATH_NOT_EXPORTED/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    assert.equal(hash(), expected);
  }
});
