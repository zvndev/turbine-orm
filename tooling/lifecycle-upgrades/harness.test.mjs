import assert from 'node:assert/strict';
const packageVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url))).version;
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { command, prerequisite, sha256 } from '../lifecycle-examples/harness.mjs';
import { artifactPair, installedPayload, payloadTransition, preserved, recovered } from './harness.mjs';

function fixture(body) {
  const dir = mkdtempSync(join(tmpdir(), 'upgrade-guard-'));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('explicit artifact pins refuse absent, identical and incorrect archives', () =>
  fixture((dir) => {
    const a = join(dir, 'baseline.tgz');
    const b = join(dir, 'candidate.tgz');
    writeFileSync(a, 'old archive');
    writeFileSync(b, 'new archive');
    const oldHash = sha256(readFileSync(a));
    const newHash = sha256(readFileSync(b));
    assert.throws(() => artifactPair(), /Built package tarball is required/);
    assert.throws(() => artifactPair(a, undefined, b, newHash), /explicit SHA256 pin/);
    assert.throws(() => artifactPair(a, newHash, b, newHash), /differs from its pin/);
    assert.throws(() => artifactPair(a, oldHash, a, oldHash), /Identical artifacts/);
    assert.equal(artifactPair(a, oldHash, b, newHash).candidate.sha256, newHash);
  }));

test('payload identity requires the requested seed transition at equal versions', () => {
  const old = { name: 'turbine-orm', version: packageVersion, exports: {} };
  const next = { ...old, exports: { './mysql/seed': './dist/mysql-seed.js' } };
  payloadTransition(old, next);
  assert.throws(() => payloadTransition(old, old), /new MySQL seed capability/);
  assert.throws(() => payloadTransition(next, old), /Baseline must precede/);
  assert.throws(() => payloadTransition(old, { ...next, version: `${packageVersion}-different` }), /equal-version/);
});

test('unchanged or wrong installed bytes cannot pass on package version', () =>
  fixture((dir) => {
    const pkg = join(dir, 'node_modules/turbine-orm');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'turbine-orm', version: packageVersion }));
    writeFileSync(join(pkg, 'runtime.js'), 'old runtime');
    const expected = {
      'package.json': sha256(readFileSync(join(pkg, 'package.json'))),
      'runtime.js': sha256('new runtime'),
    };
    assert.throws(() => installedPayload(dir, expected), /Wrong installed bytes/);
    writeFileSync(join(pkg, 'runtime.js'), 'new runtime');
    assert.match(installedPayload(dir, expected), /^[a-f0-9]{64}$/);
    writeFileSync(join(pkg, 'stale-runtime.js'), 'unexpected old bytes');
    assert.throws(() => installedPayload(dir, expected), /Wrong installed bytes/);
    rmSync(join(pkg, 'stale-runtime.js'));
    assert.throws(() => installedPayload(dir, {}), /must not be empty/);
  }));

test('dropped stored writes/history and skipped recovery fail independently of stdout', () => {
  assert.throws(() => preserved([], [{ id: 1 }], 'stored writes'), /retained evidence differs/);
  assert.throws(() => preserved([], [{ name: 'initial', checksum: 'abc' }], 'history'), /retained evidence differs/);
  assert.throws(() => preserved([], [], 'history'), /must be nonempty/);
  assert.throws(() => recovered([], [{ name: 'partial' }], 'partial', 'abc'), /Recovery was skipped/);
  assert.throws(() => recovered([], [], 'partial', 'abc'), /exact applied outcome/);
  recovered([{ name: 'partial', checksum: 'abc' }], [], 'partial', 'abc');
});

test('missing native prerequisites refuse and command failures propagate', () =>
  fixture((dir) => {
    assert.throws(() => prerequisite('mysql', {}, '24.10.0'), /MYSQL_BASEDIR is required/);
    assert.throws(() => prerequisite('mysql', { MYSQL_BASEDIR: dir }, '24.10.0'), /Native MySQL binary is required/);
    assert.throws(() => prerequisite('sqlite', {}, '22.16.0'), /Node >=24.10/);
    const report = { steps: [] };
    assert.throws(
      () => command(report, dir, dir, process.execPath, ['-e', 'process.exit(7)'], process.env),
      /process.exit/,
    );
    assert.equal(report.steps[0].exit, 7);
    assert.throws(() => command(report, dir, dir, join(dir, 'missing-command'), [], process.env), /ENOENT/);
    assert.equal(report.steps[1].exit, null);
  }));

test('executable absent-artifact failures produce cleanup evidence on all unit runtimes', () =>
  fixture((dir) => {
    const path = join(dir, 'failure.json');
    const result = spawnSync(
      process.execPath,
      [
        new URL('./verify.mjs', import.meta.url).pathname,
        '--engine',
        'sqlite',
        '--baseline',
        join(dir, 'missing.tgz'),
        '--report',
        path,
      ],
      { encoding: 'utf8', timeout: 15_000 },
    );
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(existsSync(path));
    const report = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(report.passed, false);
    assert.match(report.error, /Built package tarball is required/);
    assert.deepEqual(report.services, []);
    assert.deepEqual(report.cleanup, { servicesStopped: true, fixtureRemoved: true });
  }));

for (const signal of [false, true]) {
  test(`fixture removal failure retains the final report${signal ? ' after SIGTERM' : ''}`, () =>
    fixture((dir) => {
      // Fault only the disposable executable copy, while running its real finalizer.
      const runnerUrl = new URL('./verify.mjs', import.meta.url);
      const original = readFileSync(runnerUrl, 'utf8');
      const importToken = 'readdirSync, readFileSync, rmSync, writeFileSync';
      const boundary = '  report.artifacts = artifactPair(';
      assert.equal(original.split(importToken).length, 2);
      assert.equal(original.split(boundary).length, 2);
      const source = original
        .replace(importToken, 'readdirSync, readFileSync, rmSync as nativeRmSync, writeFileSync')
        .replace(/from '(\.\.?\/[^']+)'/g, (_, name) => `from '${new URL(name, runnerUrl).href}'`)
        .replace(
          'let root;',
          `let root;
const rmSync = (path, options) => {
  if (path === root) throw Object.assign(new Error('fixture removal denied'), { code: 'EACCES' });
  return nativeRmSync(path, options);
};`,
        )
        .replace(
          boundary,
          `  root = ${JSON.stringify(join(dir, 'retained-fixture'))};
  mkdirSync(root);
  report.fixtureRoot = root;
  ${signal ? "process.kill(process.pid, 'SIGTERM'); await new Promise((resolve) => setTimeout(resolve, 2_000));" : ''}
  throw new Error('original workload failure');
${boundary}`,
        );
      const executable = join(dir, 'fault.mjs');
      const reportPath = join(dir, 'result.json');
      writeFileSync(executable, source);
      const result = spawnSync(process.execPath, [executable, '--engine', 'sqlite', '--report', reportPath], {
        encoding: 'utf8',
        timeout: 15_000,
      });
      assert.equal(result.status, signal ? 143 : 1, result.stdout + result.stderr);
      assert.ok(existsSync(reportPath), 'Final report must survive fixture removal failure');
      const report = JSON.parse(readFileSync(reportPath, 'utf8'));
      assert.equal(report.passed, false);
      assert.match(report.error, signal ? /Interrupted by SIGTERM/ : /original workload failure/);
      assert.equal(report.cleanup.servicesStopped, true);
      assert.equal(report.cleanup.fixtureRemoved, false);
      assert.ok(report.cleanup.errors.some((error) => /fixture removal denied/.test(error)));
      assert.ok(existsSync(report.fixtureRoot));
      assert.ok(report.finished);
    }));
}
