import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inputTree, runtimeInventory, verifyInputTree, verifyRuntimeInventory } from './comparison-inventory.js';
import { mysqlBenchmarkHashes, timingAdmission } from './mysql-comparison-provenance.js';

test('paired declarations cannot omit actual source or driver implementation files', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'comparison-complete-input-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'commands'));
  writeFileSync(join(root, 'entry.js'), 'export { execute } from "./commands/execute.js";');
  writeFileSync(join(root, 'commands/execute.js'), 'export const execute = () => 1;');
  const complete = inputTree(root);
  verifyInputTree(root, complete);
  const paired = { ...complete };
  delete paired['commands/execute.js'];
  assert.throws(() => verifyInputTree(root, paired), /Complete actual input tree/);
  writeFileSync(join(root, 'commands/execute.js'), 'export const execute = () => 2;');
  assert.throws(() => verifyInputTree(root, complete), /Complete actual input tree/);
});

test('runtime admission independently retains unused files, executable and linked libraries', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'comparison-runtime-input-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'entry.js'), 'export const value = 1;');
  writeFileSync(join(root, 'unused.js'), 'export const unused = 2;');
  const actual = runtimeInventory(root, process.execPath);
  verifyRuntimeInventory(root, process.execPath, actual);
  for (const key of [join(root, 'unused.js'), process.execPath]) {
    const omitted = structuredClone(actual);
    delete omitted.files[key];
    omitted.sha256 = createHash('sha256').update(JSON.stringify(omitted.files)).digest('hex');
    assert.throws(() => verifyRuntimeInventory(root, process.execPath, omitted), /Complete actual runtime inventory/);
  }
});

test('native timing requires full correctness tuples, restored repeats and intended fault causes', (t) => {
  const directory = process.env.COMPARISON_POSITIVE_DIRECTORY;
  assert.ok(directory, 'Explicit retained admission fixture directory required');
  const envelope = JSON.parse(readFileSync(join(directory, '../ordinary-frozen-final.json'), 'utf8'));
  const expected = JSON.parse(readFileSync(join(directory, 'mysql-ordinary-manifest.json'), 'utf8'));
  const benchmark = new URL('.', import.meta.url).pathname;
  const hashes = mysqlBenchmarkHashes(benchmark);
  // Synthetic format controls only. Query values/cleanup facts come from the retained native run;
  // the harness metadata below is explicitly rewritten for the new admission schema.
  expected.hashes.benchmark = hashes;
  for (const field of ['packageRoot', 'entry', 'requireEntry'])
    expected.artifact[field] = envelope.installed.artifact[field];
  expected.artifact.mysqlEntry = expected.artifact.packageRoot + '/dist/mysql.js';
  expected.artifact.generationEntry = expected.artifact.packageRoot + '/dist/generate.js';
  for (const report of [envelope.comparison, envelope.repeat]) {
    report.hashes.benchmark = hashes;
    for (const field of ['mysqlEntry', 'generationEntry']) report.installed.artifact[field] = expected.artifact[field];
  }
  const root = mkdtempSync(join(tmpdir(), 'comparison-preflight-input-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'synthetic.json');
  const admit = (report: typeof envelope) => {
    writeFileSync(path, JSON.stringify(report));
    return timingAdmission(path, envelope.installed.artifact.sha256, 'ordinary', benchmark, expected);
  };
  admit(envelope);
  for (const mutate of [
    (r: typeof envelope) => {
      r.comparison.hashes.benchmark = {};
    },
    (r: typeof envelope) => {
      r.comparison.preflight = Array(419).fill({});
    },
    (r: typeof envelope) => {
      r.repeat = { status: 'pass' };
    },
    (r: typeof envelope) => {
      r.controls[0].report = { status: 'failure', error: 'required archive prerequisite missing' };
    },
    (r: typeof envelope) => {
      r.controls[0].report.cleanup.fixtureRestored = false;
    },
  ]) {
    const changed = structuredClone(envelope);
    mutate(changed);
    assert.throws(() => admit(changed));
  }
});
