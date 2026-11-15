import assert from 'node:assert/strict';
const packageVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url))).version;
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ddl, invalid, modes, nativeRows, relations, typeControls } from './corpus.mjs';
import {
  assertRows,
  command,
  compilerDiagnostics,
  files,
  installedPayload,
  pinnedArchive,
  prerequisites,
  sha256,
} from './harness.mjs';

function fixture(body) {
  const root = mkdtempSync(join(tmpdir(), 'value-contract-guard-'));
  try {
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
test('missing and incorrect archive pins refuse before package installation', () =>
  fixture((root) => {
    const archive = join(root, 'candidate.tgz');
    writeFileSync(archive, 'fixture archive');
    assert.throws(() => pinnedArchive(), /Explicit archive SHA256/);
    assert.throws(() => pinnedArchive(archive, '0'.repeat(64)), /does not match pin/);
    assert.throws(() => pinnedArchive(join(root, 'absent.tgz'), '0'.repeat(64)), /tarball.*required/);
    assert.equal(pinnedArchive(archive, sha256('fixture archive')).sha256, sha256('fixture archive'));
  }));
test('required native prerequisites fail closed and ignore external URLs', () => {
  assert.throws(() => prerequisites('mssql', {}, '24.10.0'), /Unknown required native engine/);
  assert.throws(
    () => prerequisites('mysql', { DATABASE_URL: 'mysql://borrowed' }, '24.10.0'),
    /MYSQL_BASEDIR required/,
  );
  assert.throws(
    () => prerequisites('postgresql', { DATABASE_URL: 'postgres://borrowed' }, '24.10.0'),
    /PG_PREFIX required/,
  );
  assert.throws(
    () => prerequisites('mysql', { MYSQL_BASEDIR: '/nonexistent' }, '24.10.0'),
    /Native MySQL binary.*required/,
  );
  assert.throws(() => prerequisites('sqlite', {}, '20.19.0'), /Node >=22/);
  prerequisites('sqlite', {}, '24.10.0');
});
test('exact native oracle catches empty, dropped, rounded and wrong values', () => {
  const expected = nativeRows();
  assert.equal(expected.length, 6);
  assertRows(expected, expected);
  for (const actual of [
    [],
    expected.slice(1),
    expected.map((row) => ({ ...row, external_id: '9007199254740992' })),
    expected.map((row) => ({ ...row, amount: '12345678901234567000' })),
    expected.map((row) => ({ ...row, payload: null })),
    expected.map((row) => ({ ...row, note: 'wrong' })),
  ])
    assert.throws(() => assertRows(actual, expected), /exact stored rows differ/);
  assert.throws(() => assertRows([], []), /expected rows must be nonempty/);
});
test('per-parent oracle catches global limits, array cardinality and ordering faults', () => {
  assertRows(relations, relations);
  assert.throws(() => assertRows([relations[0]], relations), /exact stored rows differ/);
  assert.throws(
    () =>
      assertRows(
        relations.map((row) => ({ ...row, profiles: [] })),
        relations,
      ),
    /exact stored rows differ/,
  );
  assert.throws(
    () =>
      assertRows(
        relations.map((row) => ({ ...row, invoices: [...row.invoices].reverse() })),
        relations,
      ),
    /exact stored rows differ/,
  );
});
test('every negative statement must have its own compiler diagnostic', () => {
  const source = typeControls();
  assert.equal(invalid.length, 7);
  const messages = invalid.map(
    (statement, index) =>
      `invalid.ts(${source.slice(0, source.indexOf(statement)).split('\n').length},1): error TS${index >= 4 ? '2339' : '2322'}`,
  );
  compilerDiagnostics(messages.join('\n'), source, invalid);
  const incidental = [...messages];
  incidental[4] = incidental[4].replace('TS2339', 'TS7006');
  assert.throws(() => compilerDiagnostics(incidental.join('\n'), source, invalid), /Missing compiler refusal/);
  assert.throws(() => compilerDiagnostics(messages.slice(1).join('\n'), source, invalid), /Missing compiler refusal/);
  assert.throws(() => compilerDiagnostics('', source, []), /must be nonempty/);
  assert.throws(() => compilerDiagnostics('', source, ['absent']), /Missing type-negative statement/);
});
test('installed identity rejects a package with correct version and wrong bytes', () =>
  fixture((root) => {
    const pkg = join(root, 'node_modules/turbine-orm');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'turbine-orm', version: packageVersion }));
    writeFileSync(join(pkg, 'runtime.js'), 'expected');
    const expected = files(pkg);
    assert.match(installedPayload(root, expected), /^[a-f0-9]{64}$/);
    writeFileSync(join(pkg, 'runtime.js'), 'wrong');
    assert.throws(() => installedPayload(root, expected), /Wrong installed bytes/);
  }));
test('successful stdout cannot excuse a failed command or missing effect', () =>
  fixture((root) => {
    const report = { steps: [] };
    assert.throws(
      () =>
        command(report, root, root, process.execPath, ['-e', 'console.log("passed"); process.exitCode=9'], process.env),
      /9 !== 0/,
    );
    const result = command(report, root, root, process.execPath, ['-e', 'console.log("passed")'], process.env);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /passed/);
    assert.throws(() => assertRows([], nativeRows()), /exact stored rows differ/);
    assert.equal(report.steps.length, 2);
  }));
test('corpus distinguishes native decimal storage and uses enforced table foreign keys', () => {
  assert.equal(modes.length, 2);
  assert.match(modes[1], /ANSI_QUOTES,NO_BACKSLASH_ESCAPES/);
  for (const engine of ['sqlite', 'postgresql', 'mysql']) {
    const statements = ddl(engine);
    assert.equal(statements.length, 3);
    assert.match(statements[1], /UNIQUE.+FOREIGN KEY \(customer_id\) REFERENCES customers\(id\)/);
    assert.match(statements[2], /GENERATED ALWAYS.+FOREIGN KEY/);
    assert.match(statements[2], engine === 'sqlite' ? /amount TEXT NOT NULL/ : /amount DECIMAL\(30,10\) NOT NULL/);
  }
});
test('CLI missing native prerequisites exits nonzero with a durable failed report', () =>
  fixture((root) => {
    const out = join(root, 'report');
    const child = spawnSync(
      process.execPath,
      [new URL('./verify.mjs', import.meta.url).pathname, '--engine', 'mysql', '--out', out],
      {
        encoding: 'utf8',
        env: { ...process.env, MYSQL_BASEDIR: '', DATABASE_URL: 'mysql://borrowed' },
      },
    );
    assert.notEqual(child.status, 0);
    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
    assert.equal(report.passed, false);
    assert.equal(report.services.length, 0);
    assert.match(report.error, /MYSQL_BASEDIR required|Node >=22/);
    assert.equal(report.cleanup.fixtureRemoved, true);
  }));

for (const fault of ['removal', 'archive'])
  for (const signal of [false, true]) {
    test(`${fault} cleanup failure preserves the report and ${signal ? 'SIGTERM' : 'workload failure'}`, () =>
      fixture((dir) => {
        const sourceUrl = new URL('./verify.mjs', import.meta.url);
        let source = readFileSync(sourceUrl, 'utf8').replace(
          /from '(\.\.?\/[^']+)'/g,
          (_, path) => `from '${new URL(path, sourceUrl).href}'`,
        );
        if (fault === 'removal')
          source = source
            .replace('readFileSync, rmSync, writeFileSync', 'readFileSync, rmSync as nativeRmSync, writeFileSync')
            .replace(
              'let root;',
              `let root;
const rmSync = (path, options) => {
  if (path === root) throw new Error('fixture removal denied');
  return nativeRmSync(path, options);
};`,
            );
        const boundary = "  if (args['exact-node'])";
        assert.equal(source.split(boundary).length, 2);
        source = source.replace(
          boundary,
          `  root = ${JSON.stringify(join(dir, 'retained'))};
  mkdirSync(root);
  report.fixtureRoot = root;
  ${fault === 'archive' ? "report.artifact = { path: 'missing-archive.tgz', sha256: 'a'.repeat(64) };" : ''}
  ${signal ? "process.kill(process.pid, 'SIGTERM'); await new Promise(resolve => setTimeout(resolve, 50));" : ''}
  throw new Error('original workload failure');
${boundary}`,
        );
        const path = join(dir, 'fault.mjs');
        const out = join(dir, 'evidence');
        writeFileSync(path, source);
        const result = spawnSync(process.execPath, [path, '--out', out, '--engine', 'sqlite'], {
          encoding: 'utf8',
          timeout: 15_000,
        });
        assert.equal(result.status, signal ? 143 : 1, result.stdout + result.stderr);
        const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
        assert.equal(report.passed, false);
        assert.match(report.error, signal ? /Interrupted by SIGTERM/ : /original workload failure/);
        assert.equal(report.cleanup.fixtureRemoved, fault !== 'removal');
        assert.ok(report.cleanup.errors.length > 0);
        assert.ok(report.finished);
        if (fault === 'archive') assert.equal(report.artifactUnchanged, false);
      }));
  }
