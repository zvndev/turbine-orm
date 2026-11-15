import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { FORMAT, actions, faults, alive, assertQuiescent, validateSample, validateReport, validateBundle } from './model.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const sha = b => createHash('sha256').update(b).digest('hex');
const ns = () => process.hrtime.bigint().toString();
const { values } = parseArgs({ options: { bundle: { type: 'string' }, out: { type: 'string' },
  rounds: { type: 'string', default: '4' }, fault: { type: 'string', default: 'none' } } });
assert.ok(values.out, '--out required');
const out = resolve(values.out);
mkdirSync(dirname(out), { recursive: true });
const report = { format: FORMAT, status: 'running', signal: null, errors: [], samples: [], cleanup: [], events: [],
  rounds: Number(values.rounds), fault: values.fault, startedAt: new Date().toISOString(),
  parent: { pid: process.pid, runtime: process.version, execPath: process.execPath, binarySha256: sha(readFileSync(process.execPath)) },
  scope: { timing: 'worker operation only; excludes parent IPC and process setup; includes audit and result normalization',
    memory: 'individual worker process; snapshots and per-process high-water RSS; never sum high-water marks',
    cancellation: 'between synchronous native pulls only', ranking: 'none', diskCold: false, migrationWriter: false },
};
let active = null;
const persist = () => {
  writeFileSync(`${out}.tmp`, `${JSON.stringify(report, null, 2)}\n`);
  // Same directory replacement leaves the prior report intact until the write succeeds.
  renameSync(`${out}.tmp`, out);
};
function recordError(error, phase) {
  report.status = 'failed';
  report.errors.push({ phase, name: error.name, message: error.message, stack: error.stack });
  persist();
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  if (report.signal === null) report.signal = signal;
  recordError(new Error(`received ${signal}`), active?.phase ?? 'signal');
  if (active) for (const c of active.children) c.cancel?.(new Error(`aborted by ${signal}`));
});
function ensureRunning() { assert.equal(report.signal, null, `campaign interrupted by ${report.signal}`); }
let sequence = 0;
function startWorker(route, database) {
  const child = fork(join(here, 'worker.mjs'), [route, database, resolve(values.bundle), values.fault], {
    execPath: process.execPath, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], detached: true,
  });
  const state = { child, pid: child.pid, pgid: child.pid, exited: false, stdout: '', stderr: '', pending: null };
  active.children.push(state);
  const cap = (key, chunk) => { state[key] += chunk.toString(); if (state[key].length > 131072) state[key] = state[key].slice(-131072); };
  child.stdout.on('data', b => cap('stdout', b)); child.stderr.on('data', b => cap('stderr', b));
  state.exit = new Promise(resolveExit => {
    child.once('exit', (code, signal) => {
      state.exited = true; state.exitCode = code; state.exitSignal = signal;
      report.events.push({ kind: 'exit', pid: state.pid, code, signal, atNs: ns() });
      state.cancel?.(new Error(`owned child ${state.pid} exited (${code ?? signal})`));
      resolveExit();
    });
    child.once('error', error => { state.spawnError = error.message; state.cancel?.(error); });
  });
  child.on('message', msg => {
    report.events.push({ kind: 'reply', pid: state.pid, id: msg.id, atNs: ns() });
    if (state.pending?.id === msg.id) state.pending.resolve(msg);
  });
  state.request = (action, timeout = 8000) => new Promise((resolveRequest, reject) => {
    assert.equal(state.pending, null, 'one command per handle at a time');
    const id = ++sequence, sentNs = ns();
    const timer = setTimeout(() => { report.events.push({ kind: 'timeout', pid: state.pid, action, atNs: ns() }); state.cancel(new Error(`command deadline: ${action}`)); }, timeout);
    const clear = () => { clearTimeout(timer); state.pending = null; state.cancel = null; };
    state.cancel = error => { clear(); reject(error); };
    state.pending = { id, resolve: reply => {
      clear();
      const result = { action, pid: state.pid, id, sentNs, receivedNs: ns(), reply };
      if (!reply.ok) { const error = new Error(`${action}: ${reply.error?.message}`); error.workerReply = result; reject(error); }
      else resolveRequest(result);
    } };
    report.events.push({ kind: 'send', pid: state.pid, action, id, atNs: sentNs });
    if (state.exited || !child.connected) return state.cancel(new Error(`child unavailable: ${action}`));
    child.send({ action, id }, error => { if (error) state.cancel?.(error); });
  });
  return state;
}
const waitExit = async (state, ms) => {
  if (state.exited) return true;
  let timer;
  await Promise.race([state.exit, new Promise(resolveWait => { timer = setTimeout(resolveWait, ms); })]);
  clearTimeout(timer);
  return state.exited;
};
async function stopChildren(owned) {
  for (const state of owned.children) {
    if (!state.exited && !state.pending && !report.signal && values.fault !== 'stubborn-child') {
      try { const closed = await state.request('close', 1000); state.closeProof = closed.reply.value; }
      catch (error) { recordError(error, 'graceful-close'); }
    }
  }
  for (const state of owned.children) {
    if (!(await waitExit(state, 300))) {
      report.events.push({ kind: 'escalate', pid: state.pid, signal: 'SIGTERM', atNs: ns() });
      process.kill(-state.pgid, 'SIGTERM');
      if (!(await waitExit(state, 500))) {
        report.events.push({ kind: 'escalate', pid: state.pid, signal: 'SIGKILL', atNs: ns() });
        process.kill(-state.pgid, 'SIGKILL');
        assert.ok(await waitExit(state, 2000), `stubborn child ${state.pid} survived SIGKILL`);
      }
    }
  }
  assertQuiescent(owned.children);
}
async function cleanup(owned) {
  owned.phase = 'cleanup';
  // Fault signals/error happen after workload success and before file removal.
  if (values.fault === 'teardown-signal' && report.samples.length) {
    process.kill(process.pid, 'SIGTERM');
    await new Promise(resolveTurn => setImmediate(resolveTurn));
  }
  let cleanupError;
  try { await stopChildren(owned); }
  catch (e) { cleanupError = e; recordError(e, 'stop-children'); }
  const evidence = { root: owned.root, database: owned.database, children: owned.children.map(c => ({
    pid: c.pid, pgid: c.pgid, exited: c.exited, alive: alive(c.pid), groupAlive: alive(-c.pgid), exitCode: c.exitCode, exitSignal: c.exitSignal,
    stdout: c.stdout, stderr: c.stderr, closeProof: c.closeProof,
  })), paths: [owned.database, `${owned.database}-wal`, `${owned.database}-shm`, owned.root], filesRemoved: false };
  report.cleanup.push(evidence); persist();
  if (!cleanupError) {
    try {
      assertQuiescent(owned.children);
      if (values.fault === 'cleanup-error') throw new Error('injected cleanup error before removal');
      rmSync(owned.root, { recursive: true });
      evidence.filesRemoved = evidence.paths.every(path => !existsSync(path));
      assert.ok(evidence.filesRemoved, 'owned files remain');
    } catch (e) {
      recordError(e, 'remove-files');
      // Retry only after independently checking quiescence; retain the failure.
      assertQuiescent(owned.children);
      rmSync(owned.root, { recursive: true, force: true });
      evidence.filesRemoved = evidence.paths.every(path => !existsSync(path));
    }
  }
  persist();
}
try {
  assert.ok(faults.includes(values.fault), 'unknown fault');
  assert.ok(Number.isSafeInteger(report.rounds) && report.rounds >= 2 && report.rounds <= 100 && report.rounds % 2 === 0, 'rounds must be even, between 2 and 100');
  assert.ok(values.bundle, '--bundle required');
  report.bundle = JSON.parse(readFileSync(`${values.bundle}.json`));
  validateBundle(report.bundle);
  assert.equal(sha(readFileSync(values.bundle)), report.bundle.artifactSha256, 'bundle hash mismatch');
  assert.equal(sha(readFileSync(join(root, 'package-lock.json'))), report.bundle.lockSha256, 'lock mismatch');
  for (const [path, hash] of Object.entries(report.bundle.inputs)) assert.equal(sha(readFileSync(join(root, path))), hash, `source changed: ${path}`);
  const requireRoot = createRequire(join(root, 'package.json'));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json')));
  for (const name of ['pg', 'esbuild']) {
    const d = report.bundle.dependencies[name];
    assert.equal(d.entry, realpathSync(requireRoot.resolve(name)), `${name} differs from root resolution`);
    assert.equal(sha(readFileSync(d.entry)), d.entrySha256, `loaded ${name} driver changed`);
    const packagePath = requireRoot.resolve(`${name}/package.json`);
    assert.equal(sha(readFileSync(packagePath)), d.packageSha256, `${name} package hash mismatch`);
    const version = JSON.parse(readFileSync(packagePath)).version;
    assert.equal(d.version, version, `${name} version mismatch`);
    assert.equal(version, lock.packages[`node_modules/${name}`].version, `${name} differs from root lock`);
    assert.equal(d.integrity, lock.packages[`node_modules/${name}`].integrity, `${name} locked integrity mismatch`);
  }
  report.harness = Object.fromEntries(['run.mjs', 'worker.mjs', 'model.mjs', 'bundle.mjs'].map(x => [x, sha(readFileSync(join(here, x)))]));
  report.sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  for (let round = 0; round < report.rounds; round++) {
    for (const route of round % 2 ? ['turbine', 'native'] : ['native', 'turbine']) {
      ensureRunning();
      const fixtureRoot = mkdtempSync(join(tmpdir(), 'sqlite-contention-'));
      active = { root: fixtureRoot, database: join(fixtureRoot, 'workload.db'), children: [], phase: 'setup' };
      const sample = { round, route, runtime: process.version, workers: [], steps: [], fixture: fixtureRoot };
      // Retain partial samples and identities before the first setup request.
      report.partial = sample; persist();
      try {
        const writer = startWorker(route, active.database);
        const writerReady = await writer.request('init'); sample.workers.push(writerReady.reply.value);
        sample.steps.push(await writer.request('setup'));
        const reader = startWorker(route, active.database);
        const readerReady = await reader.request('init'); sample.workers.push(readerReady.reply.value);
        const owners = { setup: writer, ready: reader, snapshot: reader, commit: writer, 'snapshot-read': reader,
          'snapshot-end': reader, 'hold-writer': writer, contend: reader, 'failed-statement': reader,
          rollback: writer, 'rollback-read': reader, 'type-before': reader, 'schema-change': writer, 'type-after': reader,
          'stream-open': reader, 'stream-write': writer, 'checkpoint-held': writer, ownership: reader,
          'stream-return': reader, 'checkpoint-free': writer, 'stream-abort': reader, final: reader };
        active.phase = 'workload';
        for (const action of actions.slice(1)) {
          ensureRunning();
          // Isolated control: remove the reader-established-before-commit barrier.
          if (action === 'snapshot' && values.fault === 'no-barrier') sample.steps.push(await writer.request('commit'));
          if (action === 'commit' && values.fault === 'no-barrier') continue;
          if (action === 'commit' && values.fault === 'child-death') {
            process.kill(-writer.pgid, 'SIGKILL'); await writer.exit;
          }
          if (action === 'commit' && values.fault === 'premature-cleanup') assertQuiescent(active.children);
          const step = await owners[action].request(action, values.fault === 'command-timeout' ? 200 : 8000);
          sample.steps.push(step);
          // Fail at the first lost snapshot/rollback, before later SQL can mask it.
          if (action === 'snapshot-read') assert.deepEqual(step.reply.value, [{ id: 1, n: 10 }, { id: 2, n: 20 }, { id: 3, n: 30 }], 'reader snapshot coordination lost');
          if (action === 'rollback') assert.equal(step.reply.inTransaction, false, 'rollback was omitted');
        }
        validateSample(sample);
        report.samples.push(sample); delete report.partial; persist();
        if (values.fault === 'stubborn-child') {
          await reader.request('stubborn');
          throw new Error('injected stubborn child requires bounded escalation');
        }
      } catch (e) {
        if (e.workerReply) { sample.steps.push(e.workerReply); }
        recordError(e, active.phase);
        throw e;
      } finally {
        await cleanup(active); active = null;
      }
    }
  }
  if (report.errors.length === 0 && !report.signal) { report.status = 'passed'; validateReport(report); }
} catch (error) {
  if (report.status !== 'failed') recordError(error, active?.phase ?? 'setup');
} finally {
  if (active) {
    try { await cleanup(active); } catch (e) { recordError(e, 'final-cleanup'); }
  }
  if (report.signal || report.errors.length) report.status = 'failed';
  report.finishedAt = new Date().toISOString(); persist();
}
console.log(JSON.stringify({ status: report.status, samples: report.samples.length, errors: report.errors.map(x => x.message), report: out }));
process.exitCode = report.status === 'passed' ? 0 : 1;
