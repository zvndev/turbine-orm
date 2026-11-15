import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertRows } from '../lifecycle-examples/harness.mjs';
import { compilerDiagnostics } from './compiler-refusals.mjs';
import { expectedRows, readInteger, values, negativeCodes, negativeStatements, typeControls } from './corpus.mjs';

const verifier = fileURLToPath(new URL('./verify.mjs', import.meta.url));
for (const control of [
  { name: 'wrong exact runtime', engine: 'fixtures', version: '0.0.0', error: /Exact Node version mismatch/ },
  { name: 'missing owned MySQL prerequisites despite an external URL', engine: 'mysql', error: /MYSQL_BASEDIR is required/ },
  { name: 'missing MySQL executable', engine: 'mysql', basedir: '/nonexistent-native-mysql', error: /Native MySQL binary required/ },
  { name: 'unsupported native certification target', engine: 'mssql', error: /Unsupported engine/ },
]) {
  test(`packed verifier refuses ${control.name}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'integer-required-guard-'));
    const out = join(root, 'evidence');
    try {
      const result = spawnSync(process.execPath, [verifier, '--engine', control.engine, '--exact-node', control.version ?? process.versions.node, '--out', out], {
        encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, MYSQL_BASEDIR: control.basedir ?? '', DATABASE_URL: 'mysql://borrowed.invalid/db' },
      });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      const report = JSON.parse(readFileSync(join(out, 'report.json')));
      assert.equal(report.passed, false);
      assert.match(report.error, control.error);
      assert.deepEqual(report.services, []);
      assert.deepEqual(report.steps, [], 'Prerequisite refusal must precede any install/service command');
      assert.deepEqual(report.cleanup.errors, []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('integer boundary oracle rejects empty, rounded and missing effects', () => {
  assert.equal(values.length, 11);
  assert.equal(readInteger('9007199254740991'), 9007199254740991);
  assert.equal(readInteger('-9007199254740991'), -9007199254740991);
  for (const digits of ['9007199254740992', '-9007199254740992', '9223372036854775807', '-9223372036854775808'])
    assert.equal(readInteger(digits), digits);
  for (const engine of ['sqlite', 'mysql']) {
    const expected = expectedRows(engine);
    assertRows(expected, expected);
    assert.throws(() => assertRows([], expected), /exact stored rows differ/);
    assert.throws(() => assertRows(expected.slice(1), expected), /exact stored rows differ/);
    const rounded = structuredClone(expected);
    rounded[1].value = '9007199254740992';
    assert.throws(() => assertRows(rounded, expected), /exact stored rows differ/);
  }
});


test('integer compiler controls require each intended diagnostic, including relation cardinality', () => {
  const source = typeControls();
  assert.equal(negativeStatements.length, 17);
  const messages = negativeStatements.map((statement, index) =>
    `invalid.ts(${source.slice(0, source.indexOf(statement)).split('\n').length},1): error TS${negativeCodes[index]}`);
  compilerDiagnostics(messages.join('\n'), source, negativeStatements, negativeCodes);
  for (let index = 0; index < messages.length; index++) {
    const wrong = [...messages];
    wrong[index] = wrong[index].replace(`TS${negativeCodes[index]}`, 'TS7006');
    assert.throws(() => compilerDiagnostics(wrong.join('\n'), source, negativeStatements, negativeCodes), /Missing compiler refusal/);
  }
  assert.throws(() => compilerDiagnostics(messages.slice(1).join('\n'), source, negativeStatements, negativeCodes), /Missing compiler refusal/);
  assert.throws(() => compilerDiagnostics('', source, [], []), /must be nonempty/);
  assert.throws(() => compilerDiagnostics('', source, negativeStatements, []), /explicit diagnostic/);
  assert.throws(() => compilerDiagnostics('', source, ['absent'], [2322]), /Missing type-negative statement/);
});
