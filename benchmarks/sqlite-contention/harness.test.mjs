import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORMAT, BUSY_MS, STREAM_SQL, actions, initial, committed, finalRows,
  assertQuiescent, validateSample, validateReport, validateCleanupCoverage, validateBundle } from './model.mjs';

const hash = 'a'.repeat(64);
function sample(route = 'native', index = 0) {
  const value = {
    snapshot: initial, 'snapshot-read': initial, 'snapshot-end': committed, 'rollback-read': committed,
    final: { rows: finalRows, count: 5, sum: 161, nativeVerification: { rows: finalRows, count: 5, sum: 161, inTransaction: false } }, contend: { busy: true, error: route === 'native' ? { errcode: 5 } : { code: 'TURBINE_E013' } },
    'failed-statement': { failed: true, rows: committed },
    'type-before': [{ value: '1' }], 'type-after': [{ value: true }],
    'stream-open': { id: 1, n: 11 }, 'checkpoint-held': [{ busy: 1 }], 'checkpoint-free': [{ busy: 0 }],
    ownership: { pending: true }, 'stream-return': { done: true, rows: finalRows },
    'stream-abort': { name: 'AbortError', rows: finalRows },
  };
  const writerActions = ['setup', 'commit', 'hold-writer', 'rollback', 'schema-change', 'stream-write', 'checkpoint-held', 'checkpoint-free'];
  return { route, round: Math.floor(index / 2), fixture: `/fixture/sample-${index}`, runtime: 'v22.16.0', workers: [101 + index * 2, 102 + index * 2].map(pid => ({ pid, ppid: 999,
    runtime: { node: 'v22.16.0', execPath: '/fixture/node', binarySha256: hash, sqlite: { version: '3.x', sourceId: 'id' },
      loadedPg: { entry: '/fixture/pg.js', version: '8.x', entrySha256: hash } },
    pragmas: { journal_mode: 'wal', synchronous: 2, busy_timeout: BUSY_MS, foreign_keys: 1, wal_autocheckpoint: 0 },
  })), steps: actions.map((action, id) => ({ action, id, pid: writerActions.includes(action) ? 101 + index * 2 : 102 + index * 2, sentNs: '100', receivedNs: '200',
    reply: { id, ok: true, value: value[action] ?? true, inTransaction: action === 'hold-writer',
      audit: ['stream-open', 'stream-abort'].includes(action) ? [{ method: 'iterate', sql: STREAM_SQL }, { method: 'next', sql: STREAM_SQL }, ...(action === 'stream-abort' ? [{ method: 'return', sql: STREAM_SQL }] : [])] :
        action === 'stream-return' ? [{ method: 'return', sql: STREAM_SQL }] :
        ['commit', 'hold-writer', 'contend'].includes(action) ? [{ method: 'prepare', sql: 'BEGIN IMMEDIATE' }, { method: 'run', sql: 'BEGIN IMMEDIATE' }] :
        ['type-before', 'type-after'].includes(action) ? [{ method: 'columns', columns: [{ name: 'value', type: action === 'type-before' ? 'TEXT' : 'BOOLEAN' }] }] : [],
      metrics: { startedNs: '1000', endedNs: '120001000', wallMs: 120, userCpuUs: 10, systemCpuUs: 10, rssBytes: 1, heapUsedBytes: 1, maxRssKiB: 1 },
    } })) };
}
function report() {
  const samples = [sample('native', 0), sample('turbine', 1), sample('turbine', 2), sample('native', 3)];
  const driver = { entry: '/fixture/pg.js', version: '8.x', entrySha256: hash, packageSha256: hash, integrity: 'sha512-fixture' };
  return { format: FORMAT, status: 'passed', signal: null, errors: [], rounds: 2, fault: 'none', samples,
    sourceHead: 'a'.repeat(40), harness: Object.fromEntries(['run.mjs', 'worker.mjs', 'model.mjs', 'bundle.mjs'].map(name => [name, hash])),
    parent: { pid: 999, runtime: 'v22.16.0', execPath: '/fixture/node', binarySha256: hash },
    bundle: { format: 'sqlite-contention-bundle-v1', head: 'a'.repeat(40), artifactSha256: hash, lockSha256: hash,
      inputs: Object.fromEntries(['src/sqlite.ts', 'src/client.ts', 'src/query/builder.ts', 'src/schema-builder.ts', 'src/schema-metadata.ts'].map(name => [name, hash])),
      dependencies: { pg: driver, esbuild: { ...driver, entry: '/fixture/esbuild.js' } } },
    cleanup: samples.map(s => ({ root: s.fixture, database: `${s.fixture}/workload.db`, filesRemoved: true,
      paths: [`${s.fixture}/workload.db`, `${s.fixture}/workload.db-wal`, `${s.fixture}/workload.db-shm`, s.fixture],
      children: s.workers.map(w => ({ pid: w.pid, pgid: w.pid, exited: true, alive: false, groupAlive: false, exitCode: 0, exitSignal: null,
        closeProof: { closed: true, suppliedHandleUsableAfterDisconnect: true } })) })),
  };
}
const step = (s, name) => s.steps.find(x => x.action === name).reply;
test('complete independent contract and balanced report are accepted', () => assert.equal(validateReport(report()), true));
const mutations = [
  ['missing snapshot barrier', s => { step(s, 'snapshot-read').value = committed; }],
  ['omitted rollback', s => { step(s, 'rollback').inTransaction = true; }],
  ['rollback leaked a write', s => { step(s, 'rollback-read').value = finalRows; }],
  ['premature busy response', s => { step(s, 'contend').metrics.wallMs = 0; }],
  ['unbounded busy wait', s => { step(s, 'contend').metrics.wallMs = 6000; }],
  ['successful contender', s => { step(s, 'contend').value.busy = false; }],
  ['wrong native independent effect', s => { step(s, 'final').value.nativeVerification.sum = 0; }],
  ['missing fresh native description', s => { step(s, 'type-after').audit = []; }],
  ['lost rows', s => { step(s, 'final').value.rows = []; }],
  ['wrong independent count', s => { step(s, 'final').value.count = 0; }],
  ['wrong independent sum', s => { step(s, 'final').value.sum = 999; }],
  ['stale declared type', s => { step(s, 'type-after').value = [{ value: '1' }]; }],
  ['wrong pre-DDL type', s => { step(s, 'type-before').value = [{ value: true }]; }],
  ['unclosed native iterator', s => { step(s, 'stream-open').audit = []; }],
  ['materialized iterator', s => { step(s, 'stream-open').audit.push({ method: 'all', sql: STREAM_SQL }); }],
  ['missing iterator return', s => { step(s, 'stream-return').audit = []; }],
  ['checkpoint passed with live reader', s => { step(s, 'checkpoint-held').value[0].busy = 0; }],
  ['checkpoint blocked after return', s => { step(s, 'checkpoint-free').value[0].busy = 1; }],
  ['abort swallowed', s => { step(s, 'stream-abort').value.name = 'Error'; }],
  ['abort leaves unusable handle', s => { step(s, 'stream-abort').value.rows = []; }],
  ['early return leaked effects', s => { step(s, 'stream-return').value.rows = []; }],
  ['handle ownership lost', s => { s.route = 'turbine'; step(s, 'ownership').value.pending = false; }],
  ['same process for both handles', s => { s.workers[1].pid = s.workers[0].pid; }],
  ['wrong runtime identity', s => { s.workers[1].runtime.node = 'v20.0.0'; }],
  ['missing runtime hash', s => { s.workers[1].runtime.binarySha256 = ''; }],
  ['missing SQLite identity', s => { s.workers[1].runtime.sqlite.sourceId = ''; }],
  ['non-WAL database', s => { s.workers[1].pragmas.journal_mode = 'delete'; }],
  ['wrong durability', s => { s.workers[1].pragmas.synchronous = 0; }],
  ['wrong busy timeout', s => { s.workers[1].pragmas.busy_timeout = 0; }],
  ['worker failure', s => { step(s, 'final').ok = false; }],
  ['nonfinite CPU', s => { step(s, 'final').metrics.userCpuUs = NaN; }],
  ['negative memory', s => { step(s, 'final').metrics.rssBytes = -1; }],
  ['wrong barrier owner', s => { s.steps[0].pid = 102; }],
  ['invalid parent boundaries', s => { s.steps[0].sentNs = '300'; }],
  ['invalid worker boundaries', s => { step(s, 'final').metrics.endedNs = '0'; }],
  ['missing writer requirement', s => { step(s, 'commit').audit = []; }],
  ['missing action', s => { s.steps.pop(); }],
  ['reordered barriers', s => { [s.steps[2], s.steps[3]] = [s.steps[3], s.steps[2]]; }],
];
for (const [name, mutate] of mutations) test(`rejects ${name}`, () => { const s = sample(); mutate(s); assert.throws(() => validateSample(s)); });
const reports = [
  ['late teardown signal', r => { r.signal = 'SIGTERM'; }],
  ['cleanup failure hidden by passed status', r => { r.errors.push({ message: 'cleanup failed' }); }],
  ['live child at deletion', r => { r.cleanup[0].children[0].alive = true; }],
  ['missing cleanup', r => { r.cleanup.pop(); }],
  ['files remain', r => { r.cleanup[0].filesRemoved = false; }],
  ['child died during teardown', r => { r.cleanup[0].children[0].exitSignal = 'SIGTERM'; }],
  ['no supplied-handle ownership proof', r => { r.cleanup[0].children[0].closeProof = null; }],
  ['unbalanced order', r => { [r.samples[0], r.samples[1]] = [r.samples[1], r.samples[0]]; }],
  ['mismatched native SQL', r => { step(r.samples[1], 'commit').audit.push({ method: 'run', sql: 'COMMIT' }); }],
  ['empty samples', r => { r.samples = []; }],
  ['absent artifact identity', r => { r.bundle.artifactSha256 = ''; }],
];
for (const [name, mutate] of reports) test(`report rejects ${name}`, () => { const r = report(); mutate(r); assert.throws(() => validateReport(r)); });
test('cleanup refuses an unobserved child exit', () => assert.throws(() => assertQuiescent([{ pid: process.pid, exited: false }]), /premature cleanup/));
test('cleanup independently refuses a live PID even with a forged exit', () => assert.throws(() => assertQuiescent([{ pid: process.pid, exited: true }]), /is alive/));
test('cleanup refuses empty ownership', () => assert.throws(() => assertQuiescent([]), /identities/));

const evidenceOmissions = [
  ['missing group-state evidence', r => { delete r.cleanup[0].children[0].groupAlive; }, /cleanup groupAlive evidence missing/],
  ['duplicate cleanup fixture', r => { r.cleanup = r.cleanup.map(() => structuredClone(r.cleanup[0])); }, /duplicate cleanup fixture identity/],
  ['passed partial sample', r => { r.partial = { fixture: '/fixture/incomplete', workers: [] }; }, /passed report retains incomplete sample/],
  ['unrelated cleanup worker', r => { r.cleanup[0].children[0].pid = 777; r.cleanup[0].children[0].pgid = 777; }, /sample worker omitted from cleanup/],
  ['unrelated cleanup path', r => { r.cleanup[0].paths[0] = '/fixture/other'; }, /cleanup paths differ/],
  ['missing busy error', r => { delete step(r.samples[0], 'contend').value.error; }, /native busy error evidence missing/],
  ['missing contender execution', r => { step(r.samples[0], 'contend').audit = []; }, /native writer attempt missing: contend/],
  ['missing native pulls', r => { step(r.samples[0], 'stream-open').audit = step(r.samples[0], 'stream-open').audit.filter(a => a.method !== 'next'); }, /native stream evidence missing: stream-open\/next/],
  ['wrong loaded driver', r => { r.samples[1].workers[0].runtime.loadedPg.version = '0'; }, /loaded pg version differs/],
  ['empty source inputs', r => { r.bundle.inputs = {}; }, /bundle source inputs missing/],
  ['missing factory input', r => { delete r.bundle.inputs['src/sqlite.ts']; }, /bundle source input missing: src\/sqlite.ts/],
  ['missing source head', r => { delete r.sourceHead; }, /source head missing|string/],
  ['missing harness hash', r => { delete r.harness['worker.mjs']; }, /harness identity missing: worker.mjs/],
];
for (const [name, mutate, expected] of evidenceOmissions) test(`report rejects ${name}`, () => {
  const r = report();
  assert.equal(validateReport(r), true, 'complete positive prerequisite');
  mutate(r);
  assert.throws(() => validateReport(r), expected);
});
test('cleanup coverage refuses a live partial fixture omitted by completed samples', () => {
  const r = report();
  assert.equal(validateCleanupCoverage(r), true);
  r.partial = { fixture: '/fixture/live', workers: [{ pid: 777 }] };
  assert.throws(() => validateCleanupCoverage(r), /cleanup missing owned sample/);
});
test('bundle guard requires real source inputs before hash verification', () => {
  const bundle = report().bundle;
  assert.equal(validateBundle(bundle), true);
  bundle.inputs = {};
  assert.throws(() => validateBundle(bundle), /bundle source inputs missing/);
});

test('independent audit rejects a live fixture omitted from cleanup ownership', () => {
  const root = mkdtempSync(join(tmpdir(), 'sqlite-contention-audit-test-'));
  try {
    const r = report();
    for (const [index, sample] of r.samples.entries()) {
      const cleanup = r.cleanup[index];
      sample.fixture = join(root, `removed-${index}`);
      cleanup.root = sample.fixture;
      cleanup.database = join(cleanup.root, 'workload.db');
      cleanup.paths = [cleanup.database, `${cleanup.database}-wal`, `${cleanup.database}-shm`, cleanup.root];
      for (const [workerIndex, worker] of sample.workers.entries()) {
        worker.pid = 1000000000 + index * 2 + workerIndex;
        cleanup.children[workerIndex].pid = worker.pid;
        cleanup.children[workerIndex].pgid = worker.pid;
      }
    }
    const input = join(root, 'report.json'), output = join(root, 'audit.json');
    const audit = () => spawnSync(process.execPath, [fileURLToPath(new URL('./audit.mjs', import.meta.url)), '--out', output, input], { encoding: 'utf8' });
    writeFileSync(input, JSON.stringify(r));
    const positive = audit();
    assert.equal(positive.status, 0, `complete audit prerequisite: ${positive.stderr}`);
    assert.equal(JSON.parse(readFileSync(output)).status, 'passed');
    r.partial = { fixture: root, workers: [] };
    r.status = 'running';
    writeFileSync(input, JSON.stringify(r));
    const negative = audit();
    assert.equal(negative.status, 1, 'audit must reject omitted live fixture ownership');
    assert.match(JSON.parse(readFileSync(output)).reports[0].coverageError, /cleanup missing owned sample/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
