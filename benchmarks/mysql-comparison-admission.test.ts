import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coverage } from './bench-mysql.js';
import { ARM_NAMES, catalog } from './mysql-comparison-catalog.js';
import { connectionOptions } from './mysql-comparison-config.js';
import { installedIdentity, timingAdmission } from './mysql-comparison-provenance.js';

test('catalog retains 47 exact identities, separate stable/RC/v7 arms and refusals', () => {
  const matrix = coverage(catalog());
  assert.equal(matrix.length, 47);
  assert.deepEqual(ARM_NAMES, ['Turbine', 'Raw', 'Drizzle', 'Drizzle RC', 'Prisma 7']);
  const refusals = matrix.flatMap((s) => s.arms.filter((a) => a.status === 'unsupported').map((a) => [s.id, a.name]));
  assert.equal(refusals.length, 55);
  assert.ok(refusals.some(([id, name]) => id === 'headline.pipeline' && name === 'Turbine'));
  assert.ok(refusals.some(([id, name]) => id === 'writes.bulk' && name === 'Turbine'));
  assert.ok(refusals.some(([id, name]) => id === 'stream.native' && name === 'Prisma 7'));
  assert.equal(
    matrix.find((s) => s.id === 'writes.bulk-count')!.arms.filter((a) => a.status === 'supported').length,
    5,
  );
});

test('omitted or substituted catalog work cannot pass admission', () => {
  assert.throws(() => coverage(catalog().slice(1)), /complete 47-entry/);
  const changed = catalog();
  changed[0] = { ...changed[0]!, id: 'headline.substituted' };
  assert.throws(() => coverage(changed), /original catalog identity/);
});

test('missing archive identity fails before allocating any backend', () => {
  const value = process.env.MYSQL_COMPARISON_ARTIFACT;
  delete process.env.MYSQL_COMPARISON_ARTIFACT;
  try {
    assert.throws(installedIdentity, /explicit MYSQL_COMPARISON_ARTIFACT/);
  } finally {
    if (value !== undefined) process.env.MYSQL_COMPARISON_ARTIFACT = value;
  }
});

test('wrong explicit archive hash is rejected before archive extraction or a backend', () => {
  const root = mkdtempSync(join(tmpdir(), 'mysql-comparison-hash-control-'));
  const artifact = process.env.MYSQL_COMPARISON_ARTIFACT,
    sha = process.env.MYSQL_COMPARISON_ARTIFACT_SHA256;
  const path = join(root, 'not-an-archive');
  writeFileSync(path, 'omission control');
  process.env.MYSQL_COMPARISON_ARTIFACT = path;
  process.env.MYSQL_COMPARISON_ARTIFACT_SHA256 = '0'.repeat(64);
  try {
    assert.throws(installedIdentity, /explicit archive hash mismatch/);
  } finally {
    if (artifact === undefined) delete process.env.MYSQL_COMPARISON_ARTIFACT;
    else process.env.MYSQL_COMPARISON_ARTIFACT = artifact;
    if (sha === undefined) delete process.env.MYSQL_COMPARISON_ARTIFACT_SHA256;
    else process.env.MYSQL_COMPARISON_ARTIFACT_SHA256 = sha;
    rmSync(root, { recursive: true, force: true });
  }
});

test('external endpoints and URL options cannot bypass owned service admission', () => {
  const url = process.env.MYSQL_COMPARISON_URL,
    owned = process.env.MYSQL_COMPARISON_OWNED;
  process.env.MYSQL_COMPARISON_OWNED = '1';
  try {
    process.env.MYSQL_COMPARISON_URL = 'mysql://root@remote.invalid/mysql_comparison_probe';
    assert.throws(connectionOptions, /owned loopback/);
    process.env.MYSQL_COMPARISON_URL = 'mysql://root@127.0.0.1/mysql_comparison_probe?ssl=false';
    assert.throws(connectionOptions, /URL options/);
    process.env.MYSQL_COMPARISON_URL = 'mysql://root@127.0.0.1/mysql_comparison_probe';
    delete process.env.MYSQL_COMPARISON_OWNED;
    assert.throws(connectionOptions, /owned-service admission/);
  } finally {
    if (url === undefined) delete process.env.MYSQL_COMPARISON_URL;
    else process.env.MYSQL_COMPARISON_URL = url;
    if (owned === undefined) delete process.env.MYSQL_COMPARISON_OWNED;
    else process.env.MYSQL_COMPARISON_OWNED = owned;
  }
});

test('timing cannot start without a named final-artifact preflight', () => {
  assert.throws(
    () => timingAdmission(undefined, '0'.repeat(64), 'ordinary', '.'),
    /explicit MYSQL_COMPARISON_PREFLIGHT/,
  );
});
