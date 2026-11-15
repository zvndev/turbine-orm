// Linux native tooling ownership. The immutable HTTP fixture supplies the kernel owner.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bounded, identity, sameProcess } from '../../src/test/fixtures/neon-http/native-lifecycle.mjs';
import { describeReason } from './reason.mjs';

export { bounded };
export function processIdentity(pid) {
  const item = identity(pid);
  return item && { ...item, parent: item.ppid, group: item.pgid };
}
const supervisor = fileURLToPath(new URL('../../src/test/fixtures/neon-http/http-command-supervisor.py', import.meta.url));
const prerequisites = fileURLToPath(new URL('./ownership-prerequisites.py', import.meta.url));

// Adapt the existing fd3 protocol, not its run-only JS API: the PostgreSQL helper
// needs synchronous spawn, output streams and explicit stop. child is the
// supervisor; record.pid/group always describe the actual command leader.
export function ownedChild(binary, args, options, record) {
  assert.equal(process.platform, 'linux', 'Native lifecycle ownership requires Linux');
  assert.equal(typeof binary, 'string', 'Child file must be a string');
  // No workload has launched yet. Missing APIs, kernel support or signal syscall
  // permission fail here; the immutable supervisor also admits its own subreaper.
  const admission = spawnSync('python3', [prerequisites], { env: options.env, encoding: 'utf8', timeout: 2000 });
  record.admission = { pid: admission.pid, status: admission.status, signal: admission.signal, stderr: admission.stderr };
  if (admission.error) throw admission.error;
  assert.equal(admission.status, 0, `Command ownership admission failed: ${admission.stderr}`);
  Object.assign(record.admission, JSON.parse(admission.stdout));
  const root = mkdtempSync(join(tmpdir(), 'optional-owned-'));
  const ownershipReport = join(root, 'ownership.json');
  const caller = identity(process.pid);
  const { deadlineMs = 180_000, ...spawnOptions } = options;
  let child;
  try {
    child = spawn('python3', [supervisor, ownershipReport, '1', String(caller.pid), caller.startTime,
      String(deadlineMs), binary, binary, ...args], {
      ...spawnOptions, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
  let spawnError, commandError;
  child.on('error', (error) => { spawnError ??= error; });
  Object.assign(record, { supervisor: identity(child.pid), ownershipReport,
    ownership: 'immutable HTTP fixture subreaper; pidfd signals; waitpid ECHILD; no group signals' });
  // The command never inherits fd3. EOF also requests cleanup after caller death.
  child.stdio[3].on('error', (error) => {
    if (error.code !== 'EPIPE' && error.code !== 'ECONNRESET') spawnError ??= error;
  });
  const capture = () => {
    if (!existsSync(ownershipReport)) return;
    const proof = JSON.parse(readFileSync(ownershipReport, 'utf8'));
    Object.assign(record, { supervisor: proof.supervisor ?? record.supervisor, ownershipProof: proof,
      ownedProcesses: proof.processes.map((item) => ({ ...item, parent: item.ppid, group: item.pgid })),
      ...(proof.leader ? { pid: proof.leader.pid, group: proof.leader.pgid, startTime: proof.leader.startTime } : {}),
      code: proof.status ?? null, signal: proof.signal ?? null });
  };
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => { record.supervisorExit = { code, signal }; resolve(); });
    child.once('error', resolve);
  });
  const closed = new Promise((resolve) => child.once('close', () => {
    try {
      capture();
      if (!record.ownershipProof?.passed) spawnError ??= new Error(`Command ownership failed: ${JSON.stringify(record.ownershipProof)}`);
      if (record.ownershipProof?.error) commandError = new Error(record.ownershipProof.error);
    } catch (error) { spawnError ??= error; }
    resolve();
  }));
  let stopping;
  const stop = () => (stopping ??= (async () => {
    let failure;
    try {
      if (child.exitCode === null && child.signalCode === null) child.stdio[3].end('stop\n');
      await bounded(exited, 22_000, 'Child supervisor exit/reap');
      await bounded(closed, 500, 'Child output drain');
      if (spawnError) throw spawnError;
      capture();
      const proof = record.ownershipProof;
      assert.ok(proof, 'Missing command ownership proof');
      assert.deepEqual(record.supervisorExit, { code: 0, signal: null }, JSON.stringify(proof));
      assert.equal(proof.subreaper, true, 'Kernel subreaper admission required');
      assert.equal(proof.passed, true, JSON.stringify(proof));
      assert.equal(proof.complete, true, 'waitpid ECHILD completion required');
      assert.deepEqual(proof.remaining, []);
      record.remainingPids = [...record.ownedProcesses, record.supervisor].filter(sameProcess);
      record.remainingGroups = [...new Set([...record.ownedProcesses.map((item) => item.group), record.supervisor.pgid])].filter((group) => {
        try { process.kill(-group, 0); return true; }
        catch (error) { if (error.code === 'ESRCH') return false; throw error; }
      });
      assert.deepEqual(record.remainingPids, [], 'Owned child descendants must disappear');
      assert.deepEqual(record.remainingGroups, [], 'Owned child groups must disappear');
      record.reaped = true;
    } catch (error) { failure = { reason: error }; }
    finally {
      const cleanup = (operation) => {
        try { operation(); }
        catch (error) {
          (record.cleanupFailures ??= []).push(describeReason(error));
          failure ??= { reason: error };
        }
      };
      cleanup(() => child.stdio[3].destroy());
      cleanup(() => child.stdout?.destroy());
      cleanup(() => child.stderr?.destroy());
      // Retain failure evidence whenever the supervisor could still own resources.
      if (!sameProcess(record.supervisor)) {
        cleanup(() => {
          rmSync(root, { recursive: true, force: true });
          record.ownershipReportRemoved = !existsSync(root);
        });
      }
    }
    if (failure) throw failure.reason;
  })());
  return { child, record, exited, closed, stop, capture, get spawnError() { return spawnError ?? commandError; } };
}

export function lifecycle(report, { cleanupMs = 12000 } = {}) {
  const controller = new AbortController();
  const children = new Set(), stops = [];
  let sealed = false, shutdown, primary, sequence = 0;
  const observed = new Map();
  const noteFailure = (reason) => { if (!observed.has(reason)) observed.set(reason, ++sequence); };
  const fail = (reason) => {
    noteFailure(reason);
    const order = observed.get(reason);
    if (!primary || order < primary.order) primary = { kind: 'failure', reason, order };
  };
  const assertOpen = () => { if (sealed || controller.signal.aborted) throw controller.signal.reason ?? new Error('Resource launches sealed'); };
  const handlers = new Map(['SIGINT', 'SIGTERM'].map((name) => [name, () => {
    if (!report.signal) {
      report.signal = name;
      report.signalExitCode = name === 'SIGINT' ? 130 : 143;
      const reason = new Error(`Interrupted by ${name}`);
      primary ??= { kind: 'signal', reason, order: ++sequence };
      controller.abort(reason);
    }
    sealed = true;
  }]));
  for (const [name, handler] of handlers) process.on(name, handler);
  return {
    signal: controller.signal, assertOpen, fail, noteFailure,
    get primary() { return primary; },
    spawn(binary, args, options, record) {
      assertOpen();
      const handle = ownedChild(binary, args, options, record); children.add(handle);
      return handle;
    },
    registerStop(stop) { assertOpen(); stops.push(stop); },
    shutdown() {
      sealed = true;
      return shutdown ??= (async () => {
        const errors = [];
        for (const handle of children) if (!handle.service) try { await handle.stop(); } catch (error) { fail(error); errors.push(describeReason(error)); }
        for (const stop of stops.reverse()) try { await bounded(Promise.resolve().then(stop), cleanupMs, 'Resource cleanup'); } catch (error) { fail(error); errors.push(describeReason(error)); }
        for (const handle of children) if (handle.service) try { await handle.stop(true); } catch (error) { fail(error); errors.push(describeReason(error)); }
        report.lifecycle = { sealed: true, errors, children: [...children].map((handle) => handle.record) };
        return errors;
      })();
    },
    dispose() { for (const [name, handler] of handlers) process.off(name, handler); },
  };
}
