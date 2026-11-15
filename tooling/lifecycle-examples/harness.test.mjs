import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { artifact, assertRows, command, configFile, prerequisite, scrub } from './harness.mjs';

test('required consumer inputs fail closed instead of skipping', () => {
  const root = mkdtempSync(join(tmpdir(), 'lifecycle-input-controls-'));
  try {
    assert.throws(() => artifact(), /Built package tarball is required/);
    assert.throws(() => artifact(join(root, 'missing.tgz')), /Built package tarball is required/);
    assert.throws(() => artifact(root), /Built package tarball is required/);
    assert.throws(() => configFile(root), /Consumer config is required/);
    writeFileSync(join(root, 'turbine.config.ts'), "export default { engine: 'sqlite' };\n");
    assert.ok(configFile(root).endsWith('turbine.config.ts'));
    assert.throws(() => prerequisite('mysql', {}, '24.10.0'), /MYSQL_BASEDIR is required/);
    assert.throws(() => prerequisite('mysql', { MYSQL_BASEDIR: root }, '24.10.0'), /Native MySQL binary is required/);
    assert.throws(() => prerequisite('sqlite', {}, '24.9.0'), /Node >=24.10/);
    assert.throws(() => prerequisite('sqlite', {}, '22.16.0'), /Node >=24.10/);
    prerequisite('sqlite', {}, '24.10.0');
    prerequisite('sqlite', {}, '26.0.0');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('row effect verification rejects missing, incorrect and empty expected rows', () => {
  const expected = [{ id: 1, display_name: 'Updated by the app' }];
  assertRows(expected, expected);
  assert.throws(() => assertRows([], expected), /exact stored rows differ/);
  assert.throws(() => assertRows([{ id: 1, display_name: 'old' }], expected), /exact stored rows differ/);
  assert.throws(() => assertRows([], []), /expected rows must be nonempty/);
});

test('commands record errors and cannot pass on a successful exit with a missing effect', () => {
  const root = mkdtempSync(join(tmpdir(), 'lifecycle-command-controls-'));
  const report = { steps: [] };
  try {
    const result = command(report, root, root, process.execPath, ['-e', 'console.log("[]")'], process.env);
    assert.equal(report.steps.length, 1);
    assert.equal(report.steps[0].exit, 0);
    assert.throws(() => assertRows(JSON.parse(result.stdout), [{ id: 1 }]), /exact stored rows differ/);
    command(
      report,
      root,
      root,
      process.execPath,
      ['-e', 'console.error("deliberate failure");process.exit(7)'],
      process.env,
      7,
    );
    assert.equal(report.steps[1].exit, 7);
    assert.match(report.steps[1].stderr, /deliberate failure/);
    assert.throws(() => command(report, root, root, join(root, 'absent-node'), [], process.env), /ENOENT/);
    assert.match(report.steps[2].error, /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('report sanitizer withholds connection URLs and normalizes fixture paths', () => {
  const text = scrub(
    'mysql://reader:withheld@localhost/catalog mssql://reader@localhost/catalog /tmp/fixture/app.ts',
    '/tmp/fixture',
  );
  assert.equal(text, '[database URL withheld] [database URL withheld] $FIXTURE/app.ts');
});

test('the executable runner reports an absent artifact as failure with no fixtures', () => {
  const root = mkdtempSync(join(tmpdir(), 'lifecycle-runner-controls-'));
  try {
    const report = join(root, 'failed.json');
    const child = spawnSync(
      process.execPath,
      [
        new URL('./verify.mjs', import.meta.url).pathname,
        '--engine',
        'sqlite',
        '--tarball',
        join(root, 'absent.tgz'),
        '--report',
        report,
      ],
      { encoding: 'utf8', timeout: 15_000 },
    );
    assert.equal(child.status, 1, child.stdout + child.stderr);
    assert.ok(existsSync(report));
    const result = JSON.parse(readFileSync(report, 'utf8'));
    assert.equal(result.passed, false);
    assert.match(result.error, /Built package tarball is required/);
    assert.deepEqual(result.services, []);
    assert.deepEqual(result.cleanup, { fixtureRemoved: true, servicesStopped: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
