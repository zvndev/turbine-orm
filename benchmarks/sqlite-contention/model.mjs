import assert from 'node:assert/strict';
import { isAbsolute, join } from 'node:path';

export const FORMAT = 'sqlite-contention-v1';
export const BUSY_MS = 120;
export const STREAM_SQL = 'SELECT "items".* FROM "items" ORDER BY "id" ASC';
export const READ_SQL = 'SELECT id, n FROM items ORDER BY id';
export const TYPE_SQL = 'SELECT value FROM typed';
export const initial = [{ id: 1, n: 10 }, { id: 2, n: 20 }, { id: 3, n: 30 }];
export const committed = [{ id: 1, n: 11 }, ...initial.slice(1), { id: 4, n: 40 }];
export const finalRows = [...committed, { id: 6, n: 60 }];
export const actions = [
  'setup', 'ready', 'snapshot', 'commit', 'snapshot-read', 'snapshot-end',
  'hold-writer', 'contend', 'failed-statement', 'rollback', 'rollback-read',
  'type-before', 'schema-change', 'type-after', 'stream-open', 'stream-write',
  'checkpoint-held', 'ownership', 'stream-return', 'checkpoint-free', 'stream-abort', 'final',
];
export const faults = ['none', 'no-barrier', 'omit-rollback', 'premature-cleanup', 'child-death', 'stubborn-child', 'teardown-signal', 'cleanup-error', 'command-timeout'];


const hashPattern = /^[a-f0-9]{64}$/;
const requiredInputs = ['src/sqlite.ts', 'src/client.ts', 'src/query/builder.ts', 'src/schema-builder.ts', 'src/schema-metadata.ts'];
export function validateBundle(bundle) {
  assert.equal(bundle.format, 'sqlite-contention-bundle-v1');
  assert.match(bundle.head, /^[a-f0-9]{40}$/, 'bundle source head missing');
  assert.match(bundle.artifactSha256, hashPattern);
  assert.match(bundle.lockSha256, hashPattern);
  assert.ok(bundle.inputs && Object.keys(bundle.inputs).length > 0, 'bundle source inputs missing');
  for (const name of requiredInputs) assert.match(bundle.inputs[name] ?? '', hashPattern, `bundle source input missing: ${name}`);
  for (const [name, hash] of Object.entries(bundle.inputs)) {
    assert.ok(name.startsWith('src/') && !name.split('/').includes('..'), 'invalid source input path');
    assert.match(hash, hashPattern);
  }
  for (const name of ['pg', 'esbuild']) {
    const driver = bundle.dependencies?.[name];
    assert.ok(driver && isAbsolute(driver.entry), `bundle ${name} identity missing`);
    assert.ok(typeof driver.version === 'string' && driver.version.length > 0, `bundle ${name} version missing`);
    assert.match(driver.entrySha256, hashPattern);
    assert.match(driver.packageSha256, hashPattern);
    assert.ok(typeof driver.integrity === 'string' && driver.integrity.length > 0, `bundle ${name} integrity missing`);
  }
  return true;
}
export function validateCleanupCoverage(report) {
  assert.ok(Array.isArray(report.samples) && Array.isArray(report.cleanup), 'sample and cleanup ownership required');
  const samples = [...report.samples, ...(report.partial ? [report.partial] : [])];
  assert.ok(samples.length > 0, 'owned sample identity missing');
  const fixtures = samples.map(s => s.fixture);
  assert.ok(fixtures.every(path => typeof path === 'string' && isAbsolute(path)), 'owned fixture identity missing');
  assert.equal(new Set(fixtures).size, fixtures.length, 'duplicate sample fixture identity');
  assert.equal(report.cleanup.length, fixtures.length, 'cleanup missing owned sample');
  const roots = report.cleanup.map(c => c.root);
  assert.equal(new Set(roots).size, roots.length, 'duplicate cleanup fixture identity');
  assert.deepEqual([...roots].sort(), [...fixtures].sort(), 'cleanup fixture ownership differs');
  const seenPids = new Set();
  for (const c of report.cleanup) {
    assert.equal(c.database, join(c.root, 'workload.db'), 'cleanup database identity differs');
    assert.deepEqual(c.paths, [c.database, `${c.database}-wal`, `${c.database}-shm`, c.root], 'cleanup paths differ from owned fixture');
    assert.ok(Array.isArray(c.children) && c.children.length > 0, 'cleanup worker identities missing');
    const sample = samples.find(s => s.fixture === c.root);
    assert.ok(Array.isArray(sample.workers), 'sample worker identities missing');
    for (const child of c.children) {
      assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0, 'invalid owned PID');
      assert.equal(child.pgid, child.pid, 'detached worker group identity differs');
      assert.ok(!seenPids.has(child.pid), 'duplicate cleanup worker identity');
      seenPids.add(child.pid);
      for (const key of ['exited', 'alive', 'groupAlive']) assert.equal(typeof child[key], 'boolean', `cleanup ${key} evidence missing`);
    }
    for (const worker of sample.workers) assert.ok(c.children.some(child => child.pid === worker.pid), 'sample worker omitted from cleanup');
    if (report.samples.includes(sample)) assert.deepEqual(c.children.map(x => x.pid).sort(), sample.workers.map(x => x.pid).sort(), 'completed sample cleanup workers differ');
  }
  return true;
}

export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; }
}
export function assertQuiescent(children) {
  assert.ok(children.length > 0, 'cleanup requires owned child identities');
  for (const child of children) {
    assert.ok(child.exited, `premature cleanup: child ${child.pid} has not exited`);
    assert.ok(!alive(child.pid), `premature cleanup: child ${child.pid} is alive`);
    if (child.pgid) assert.ok(!alive(-child.pgid), `premature cleanup: group ${child.pgid} is alive`);
  }
}
export function assertMetrics(metrics) {
  for (const key of ['startedNs', 'endedNs']) assert.match(metrics[key], /^\d+$/, `worker ${key} missing`);
  assert.ok(BigInt(metrics.endedNs) >= BigInt(metrics.startedNs), 'invalid worker timing boundaries');
  assert.equal(metrics.wallMs, Number(BigInt(metrics.endedNs) - BigInt(metrics.startedNs)) / 1e6);
  for (const key of ['wallMs', 'userCpuUs', 'systemCpuUs', 'rssBytes', 'heapUsedBytes', 'maxRssKiB']) {
    assert.ok(Number.isFinite(metrics[key]) && metrics[key] >= 0, `invalid metric ${key}`);
  }
}
export function validateSample(s) {
  assert.ok(['native', 'turbine'].includes(s.route));
  assert.equal(s.steps.length, actions.length);
  assert.deepEqual(s.steps.map(x => x.action), actions);
  assert.equal(s.workers.length, 2);
  assert.notEqual(s.workers[0].pid, s.workers[1].pid);
  for (const w of s.workers) {
    assert.ok(Number.isSafeInteger(w.pid) && w.pid > 0, 'invalid worker PID');
    assert.equal(w.runtime.node, s.runtime);
    assert.match(w.runtime.binarySha256, /^[a-f0-9]{64}$/);
    assert.ok(w.runtime.sqlite.sourceId && w.runtime.sqlite.version);
    assert.equal(w.pragmas.journal_mode, 'wal');
    assert.equal(w.pragmas.busy_timeout, BUSY_MS);
    assert.equal(w.pragmas.synchronous, 2);
    assert.equal(w.pragmas.foreign_keys, 1);
    assert.equal(w.pragmas.wal_autocheckpoint, 0);
    if (s.route === 'turbine') {
      assert.match(w.runtime.loadedPg.entrySha256, /^[a-f0-9]{64}$/);
      assert.ok(w.runtime.loadedPg.entry && w.runtime.loadedPg.version);
    }
  }
  const step = name => s.steps.find(x => x.action === name).reply;
  for (const name of ['snapshot', 'snapshot-read']) assert.deepEqual(step(name).value, initial);
  for (const name of ['snapshot-end', 'rollback-read']) assert.deepEqual(step(name).value, committed);
  assert.deepEqual(step('final').value.rows, finalRows);
  assert.equal(step('final').value.count, 5);
  assert.equal(step('final').value.sum, 161);
  assert.deepEqual(step('final').value.nativeVerification, { rows: finalRows, count: 5, sum: 161, inTransaction: false });
  for (const [action, type] of [['type-before', 'TEXT'], ['type-after', 'BOOLEAN']]) {
    assert.ok(step(action).audit.some(x => x.method === 'columns' && x.columns.some(c => c.name === 'value' && c.type === type)), 'fresh native declared-type description missing');
  }
  assert.equal(step('rollback').inTransaction, false, 'rollback was omitted');
  assert.equal(step('contend').value.busy, true);
  const busyError = step('contend').value.error;
  assert.ok(busyError && (s.route === 'native' ? busyError.errcode === 5 : busyError.code === 'TURBINE_E013'), 'native busy error evidence missing');
  for (const action of ['commit', 'hold-writer', 'contend']) {
    for (const method of ['prepare', 'run']) assert.ok(step(action).audit.some(x => x.sql === 'BEGIN IMMEDIATE' && x.method === method), `native writer attempt missing: ${action}/${method}`);
  }
  assert.equal(step('hold-writer').inTransaction, true, 'writer lock transaction missing');
  assert.equal(step('contend').inTransaction, false, 'failed contender entered a transaction');
  for (const action of ['stream-open', 'stream-abort']) {
    for (const method of ['iterate', 'next']) assert.ok(step(action).audit.some(x => x.sql === STREAM_SQL && x.method === method), `native stream evidence missing: ${action}/${method}`);
  }
  for (const action of ['stream-return', 'stream-abort']) assert.ok(step(action).audit.some(x => x.sql === STREAM_SQL && x.method === 'return'), `native iterator return missing: ${action}`);
  assert.ok(step('contend').metrics.wallMs >= BUSY_MS * 0.8, 'busy timeout returned prematurely');
  assert.ok(step('contend').metrics.wallMs < 5000, 'busy timeout exceeded bound');
  assert.equal(step('failed-statement').value.failed, true);
  assert.deepEqual(step('failed-statement').value.rows, committed);
  assert.deepEqual(step('type-before').value, [{ value: '1' }]);
  assert.deepEqual(step('type-after').value, [{ value: true }]);
  assert.deepEqual(step('stream-open').value, { id: 1, n: 11 });
  assert.equal(step('checkpoint-held').value[0].busy, 1);
  assert.equal(step('checkpoint-free').value[0].busy, 0);
  assert.equal(step('stream-return').value.done, true);
  assert.deepEqual(step('stream-return').value.rows, finalRows);
  assert.equal(step('stream-abort').value.name, 'AbortError');
  assert.deepEqual(step('stream-abort').value.rows, finalRows);
  if (s.route === 'turbine') assert.equal(step('ownership').value.pending, true);
  for (const x of s.steps) {
    assertMetrics(x.reply.metrics);
    assert.equal(x.reply.ok, true);
    assert.equal(x.reply.id, x.id, 'worker reply identity differs');
    const writerActions = ['setup', 'commit', 'hold-writer', 'rollback', 'schema-change', 'stream-write', 'checkpoint-held', 'checkpoint-free'];
    assert.equal(x.pid, s.workers[writerActions.includes(x.action) ? 0 : 1].pid, 'wrong barrier owner');
    assert.ok(BigInt(x.sentNs) <= BigInt(x.receivedNs), 'invalid coordination boundary');
  }
  const at = name => s.steps.findIndex(x => x.action === name);
  assert.ok(at('snapshot') < at('commit') && at('commit') < at('snapshot-read'));
  const audit = s.steps.flatMap(x => x.reply.audit);
  assert.ok(audit.some(x => x.method === 'iterate' && x.sql === STREAM_SQL), 'native incremental iterator missing');
  assert.ok(!audit.some(x => x.method === 'all' && x.sql === STREAM_SQL), 'stream materialized');
  assert.ok(audit.some(x => x.method === 'return'), 'native iterator return missing');
  assert.ok(audit.some(x => x.sql === 'BEGIN IMMEDIATE'), 'writer requirement missing');
  return true;
}
export function comparableAudit(s) {
  return s.steps.flatMap(x => x.reply.audit)
    .filter(x => ['prepare', 'all', 'run', 'iterate'].includes(x.method))
    .map(({ sql, method, bindings }) => ({ sql, method, ...(bindings ? { bindings } : {}) }));
}
export function validateReport(r) {
  assert.equal(r.format, FORMAT);
  assert.equal(r.status, 'passed');
  assert.equal(r.signal, null);
  assert.equal(r.fault, 'none');
  assert.equal(r.partial, undefined, 'passed report retains incomplete sample');
  validateBundle(r.bundle);
  assert.match(r.sourceHead, /^[a-f0-9]{40}$/, 'report source head missing');
  for (const name of ['run.mjs', 'worker.mjs', 'model.mjs', 'bundle.mjs']) assert.match(r.harness?.[name] ?? '', hashPattern, `harness identity missing: ${name}`);
  assert.ok(Number.isSafeInteger(r.parent?.pid) && r.parent.pid > 0, 'parent identity missing');
  assert.match(r.parent.binarySha256, hashPattern);
  validateCleanupCoverage(r);
  assert.deepEqual(r.errors, []);
  assert.equal(r.samples.length, r.rounds * 2);
  assert.ok(r.rounds >= 2 && r.rounds % 2 === 0, 'balanced rounds required');
  for (const [index, s] of r.samples.entries()) {
    validateSample(s);
    assert.equal(s.round, Math.floor(index / 2), 'sample round identity differs');
    assert.equal(s.runtime, r.parent.runtime, 'parent and worker runtimes differ');
    for (const worker of s.workers) {
      assert.equal(worker.ppid, r.parent.pid, 'worker parent identity differs');
      assert.equal(worker.runtime.execPath, r.parent.execPath, 'worker executable identity differs');
      assert.equal(worker.runtime.binarySha256, r.parent.binarySha256, 'worker binary identity differs');
      if (s.route === 'turbine') {
        for (const key of ['entry', 'version', 'entrySha256']) assert.equal(worker.runtime.loadedPg[key], r.bundle.dependencies.pg[key], `loaded pg ${key} differs from bundle`);
      }
    }
  }
  for (let round = 0; round < r.rounds; round++) {
    const pair = r.samples.slice(round * 2, round * 2 + 2);
    assert.deepEqual(pair.map(x => x.route), round % 2 ? ['turbine', 'native'] : ['native', 'turbine']);
    assert.deepEqual(comparableAudit(pair[0]), comparableAudit(pair[1]), 'actual native SQL/effects differ by route');
  }
  assert.equal(r.cleanup.length, r.rounds * 2);
  for (const c of r.cleanup) {
    assert.equal(c.filesRemoved, true);
    assert.equal(c.children.length, 2);
    assert.ok(c.children.every(x => x.exited === true && x.alive === false && x.groupAlive === false && x.exitCode === 0 && x.exitSignal === null));
    assert.ok(c.children.every(x => x.closeProof?.closed === true && x.closeProof.suppliedHandleUsableAfterDisconnect === true));
    assert.equal(c.paths.length, 4);
  }
  assert.match(r.bundle.artifactSha256, /^[a-f0-9]{64}$/);
  assert.match(r.bundle.lockSha256, /^[a-f0-9]{64}$/);
  return true;
}
