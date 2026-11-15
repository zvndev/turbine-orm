import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, expected, digest, bytes, checkSample, checkReport, ARMS, CASES, FORMAT, assertNativeRuntime } from './oracle.mjs';

// Synthetic validator input only. Native certification comes exclusively from run.mjs.
function sample(arm = 'join', name = 'small', window = 'page') {
  const value = expected(fixture(name), window);
  const count = arm === 'batched' ? 3 : 1, stream = arm.startsWith('stream-');
  const audit = Array.from({ length: count }, () => ({ sql: 'SELECT id FROM parents LEFT JOIN owners',
    method: stream ? 'iterate' : 'all', rows: 7, bytes: 300, iteratorClosed: true, plan: [{ detail: 'SCAN parents' }] }));
  return { name, round: 0, arm, window, value, valueHash: digest(value), deliveredBytes: bytes(value),
    audit, queries: count, nativeRows: count * 7, nativeBytes: count * 300, batches: [2, 2, 2, 1],
    maxParentBytes: Math.max(...value.map(bytes)), transactionRetained: true, ms: 1,
    memoryBefore: { rss: 100 }, memoryAfter: { rss: 100 }, resourceAfter: { maxRSS: 100 } };
}
function report() {
  return { format: FORMAT, status: 'passed', failures: [], signal: null, rounds: 1, scale: 1,
    provenance: { runtime: { binarySha256: 'unit-only' }, lockSha256: 'unit-only', files: { 'benchmarks/sqlite-relations/oracle.mjs': 'unit-only' } },
    proof: { sqlite: { sourceId: 'unit-only' }, loadedPg: { entrySha256: 'unit-only' }, prerequisites: true,
      refusal: { code: 'TURBINE_E017', nativeReads: 0 }, effects: CASES.map(name => ({ name, unchanged: true, parents: 10, children: 20, owners: 10, inputHash: digest(fixture(name)) })) },
    samples: CASES.flatMap(name => ['all', 'page'].flatMap(window => ARMS.map(arm => {
      const s = sample(arm, name, window); s.batches = window === 'all' ? [2, 2, 2, 2, 2] : [2, 2, 2, 1]; return s;
    }))), cleanup: { handleClosed: true, transactionClosed: true, childExited: true, pidAbsent: true, groupAbsent: true, pathAbsent: true, servicesStarted: 0 } };
}
test('fixture is deterministic and fanout and wide cases differ', () => {
  for (const name of CASES) assert.equal(digest(fixture(name)), digest(fixture(name)));
  assert.equal(fixture('large').children.length, 320);
  assert.equal(fixture('skewed').children.filter(c => c.parentId === 2).length, 96);
  assert.ok(bytes(fixture('wide')) > bytes(fixture('small')) * 20);
  assert.throws(() => fixture('unknown')); assert.throws(() => fixture('small', 0));
});
test('independent oracle pins ties, offset, null, optional and empty relations', () => {
  const all = expected(fixture('small'), 'all'), page = expected(fixture('large'), 'page');
  assert.deepEqual(all[1].children.map(c => c.id), [20001, 20000]);
  assert.equal(all[2].owner, null); assert.deepEqual(all[4].children, []);
  assert.equal(all[0].children[0].note, null);
  assert.deepEqual(page.map(p => p.id), [2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(page[0].children.map(c => c.id), [20000, 20003, 20002]);
});
test('valid synthetic materialized and native-iterator shapes admitted', () => {
  for (const arm of ARMS) assert.equal(checkSample(sample(arm), fixture('small')), true);
  assert.equal(checkReport(report()).samples, 48);
});
for (const [name, mutate, pattern] of [
  ['missing relation', s => s.value[0].children.pop(), /exact independent nested/],
  ['wrong tie/limit', s => s.value.find(p => p.children.length > 1).children.reverse(), /exact independent nested/],
  ['hidden materialization', s => { s.audit[0].method = 'all'; }, /stream used materializing route/],
  ['lost iterator', s => { s.audit[0].iteratorClosed = false; }, /native iterator cleanup/],
  ['missing native row proof', s => { s.audit[0].rows = 0; s.audit[0].bytes = 0; }, /native rows\/bytes\/plans/],
  ['missing plan', s => { s.audit[0].plan = []; }, /native rows\/bytes\/plans/],
  ['query counter mismatch', s => { s.queries++; }, /actual native query count/],
  ['lost snapshot', s => { s.transactionRetained = false; }, /caller snapshot retained/],
  ['parent batch overflow', s => { s.batches = [7]; }, /parent batch bound/],
  ['wrong digest', s => { s.valueHash = ''; }, /exact value hash/],
  ['wrong bytes', s => { s.deliveredBytes = 0; }, /delivered UTF-8/],
]) test(`guard rejects ${name}`, () => { const s = sample('stream-join'); mutate(s); assert.throws(() => checkSample(s, fixture('small')), pattern); });
for (const [name, mutate, pattern] of [
  ['sticky failure', r => r.failures.push('previous failure'), /sticky failures/],
  ['sticky signal', r => { r.signal = 'SIGINT'; }, /sticky OS signal/],
  ['empty proof', r => { r.proof = {}; }, /native identity proof/],
  ['missing provenance', r => { r.provenance = {}; }, /provenance required/],
  ['incomplete matrix', r => { r.samples.pop(); }, /complete nonempty matrix/],
  ['duplicate matrix', r => { r.samples[1] = r.samples[0]; }, /duplicate sample/],
  ['unsupported timed success', r => { r.proof.refusal.nativeReads = 1; }, /unsupported never timed/],
  ['lost handle', r => { r.cleanup.handleClosed = false; }, /native handle closure proof/],
  ['surviving child group', r => { r.cleanup.groupAbsent = false; }, /false !== true/],
  ['missing path cleanup', r => { r.cleanup.pathAbsent = false; }, /owned directory cleanup/],
]) test(`report guard rejects ${name}`, () => { const r = report(); mutate(r); assert.throws(() => checkReport(r), pattern); });
test('existing report refusal preserves exact bytes before any child starts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sqlite-relations-destination-'));
  try {
    const path = join(directory, 'success.json'), prior = '{"status":"passed","proof":"keep"}\n'; writeFileSync(path, prior);
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./run.mjs', import.meta.url)), '--out', path], { encoding: 'utf8', timeout: 5000 });
    assert.notEqual(child.status, 0); assert.match(child.stderr, /EEXIST/); assert.equal(readFileSync(path, 'utf8'), prior);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('runtime admission refuses unsupported versions before native timing', () => {
  for (const version of ['v20.19.0', 'v26.12.0', 'v22.15.0', 'v24.9.0']) assert.throws(() => assertNativeRuntime(version), /requires exact/);
  for (const version of ['v22.16.0', 'v24.10.0']) assertNativeRuntime(version);
});

test('runner retains primary failure and JSON when owned directory removal fails', () => {
  const stage = mkdtempSync(join(tmpdir(), 'sqlite-relations-finalizer-'));
  const ownedRecord = join(stage, 'owned-path.txt');
  const owned = [];
  try {
    cpSync(dirname(fileURLToPath(import.meta.url)), stage, { recursive: true });
    const runner = join(stage, 'run.mjs');
    const source = readFileSync(runner, 'utf8');
    assert.equal(source.split("root = resolve(here, '../..')").length, 2);
    writeFileSync(runner, source.replace("root = resolve(here, '../..')", 'root = process.cwd()'));
    // A protocol fixture isolates the real supervisor finalizer, without native prerequisites.
    writeFileSync(join(stage, 'worker.mjs'), `process.send({result:{samples:[],proof:{},failures:[{name:'Error',message:'primary worker fixture failure'}],cleanup:{}}},()=>process.disconnect());process.exitCode=1;`);
    const preload = join(stage, 'remove-fault.mjs');
    writeFileSync(preload, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
      const remove=fs.rmSync;fs.rmSync=(path,...args)=>{if(/[/]sqlite-relations-[A-Za-z0-9]{6}$/.test(String(path))){fs.writeFileSync(${JSON.stringify(ownedRecord)},String(path));throw new Error('owned directory removal fixture failure')}return remove(path,...args)};syncBuiltinESMExports();`);
    for (const fault of [false, true]) {
      const path = join(stage, `${fault}.json`);
      const child = spawnSync(process.execPath, [...(fault ? ['--import', preload] : []), runner, '--out', path], { encoding: 'utf8', timeout: 10000 });
      assert.equal(child.status, 1, child.stdout + child.stderr);
      const text = readFileSync(path, 'utf8');
      assert.ok(text.length > 0, 'Final failed report must be retained');
      const result = JSON.parse(text);
      owned.push(result.owned.directory);
      assert.equal(result.status, 'failed');
      assert.match(JSON.stringify(result.failures), /primary worker fixture failure/);
      assert.equal(result.cleanup.pidAbsent, true); assert.equal(result.cleanup.groupAbsent, true);
      assert.equal(result.cleanup.pathAbsent, !fault);
      assert.equal(existsSync(result.owned.directory), fault);
      if (fault) assert.match(JSON.stringify(result.failures), /owned directory removal fixture failure/);
    }
  } finally {
    if (existsSync(ownedRecord)) owned.push(readFileSync(ownedRecord, 'utf8'));
    for (const path of owned) rmSync(path, { recursive: true, force: true });
    rmSync(stage, { recursive: true, force: true });
  }
});
