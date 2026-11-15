import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function save(path, value) {
  writeFileSync(path + '.tmp', JSON.stringify(value, null, 2) + '\n');
  renameSync(path + '.tmp', path);
}
export function alive(pid, group = false) {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try { process.kill(group ? -pid : pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; }
}
export function startTicks(pid) {
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19]; } catch { return null; }
}
export function owned(command, args, options = {}) {
  const child = spawn(command, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  const record = { command, args, pid: child.pid ?? null, startTicks: startTicks(child.pid), exit: null };
  let error;
  child.on('error', e => { error = e; record.error = e.message; });
  const done = new Promise(resolve => child.on('close', (code, signal) => { record.exit = { code, signal }; resolve(); }));
  return { child, record, done, error: () => error };
}
export async function within(promise, ms, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}
export async function stop(group, onSent) {
  if (!group?.record.pid) return;
  const pid = group.record.pid;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL']) {
    if (!alive(pid, true)) break;
    if (alive(pid) && group.record.startTicks) assert.equal(startTicks(pid), group.record.startTicks, 'Refusing termination of a reused process identity');
    (group.record.termination ??= []).push(signal);
    process.kill(-pid, signal);
    onSent?.(signal);
    // A postmaster waits for its children before exiting. Do not kill children
    // separately and leave unreaped zombies behind the controller's back.
    try {
      await within((async () => { await group.done; for (let i = 0; i < 120 && alive(pid, true); i++) await delay(25);
        assert.equal(alive(pid, true), false, 'Owned descendant group termination deadline'); })(), 3100, 'Owned process termination deadline');
    } catch { /* escalate */ }
  }
  await within(group.done, 3000, 'Owned process did not close after escalation');
  assert.equal(alive(pid, true), false, 'Owned process group remains');
}
export function portOpen(port) {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.setTimeout(500, () => finish(false));
  });
}
export function ownership(report) {
  const pid = n => Number.isInteger(n) && n > 1;
  assert.ok(Array.isArray(report.processes) && report.processes.length > 0, 'Owned process identities required');
  assert.ok(report.processes.every(p => pid(p.pid)), 'Every owned process PID required');
  assert.equal(new Set(report.processes.map(p => p.pid)).size, report.processes.length, 'Unique owned process PIDs required');
  assert.ok(Number.isInteger(report.port) && report.port > 0 && report.port <= 65535, 'Owned service port required');
  assert.ok([report.serviceRoot, report.data, report.socket].every(p => typeof p === 'string' && isAbsolute(p)), 'Owned absolute service paths required');
  assert.equal(report.data, join(report.serviceRoot, 'data'), 'Owned data path required');
  assert.equal(report.socket, join(report.serviceRoot, 'socket'), 'Owned socket path required');
  assert.ok(pid(report.observerPid), 'Owned observer PID required');
  assert.ok(Array.isArray(report.samples), 'Owned sample registry required');
  assert.equal(report.processes.length, report.samples.length + 3, 'Complete owned process registry required');
  for (const s of report.samples) {
    assert.ok(Array.isArray(s.sessionIds) && s.sessionIds.length > 0 && s.sessionIds.every(pid), 'Owned sample session PIDs required');
    assert.equal(new Set(s.sessionIds).size, s.sessionIds.length, 'Unique sample session PIDs required');
    for (const n of [s.backendPid, s.portalProbePid, s.reuse?.pid].filter(n => n !== undefined))
      assert.ok(pid(n) && s.sessionIds.includes(n), 'Measured/reused backend must be registered');
  }
  return [...new Set([report.observerPid, ...report.samples.flatMap(s => s.sessionIds)])];
}
export async function audit(report) {
  const pids = ownership(report);
  const groups = report.processes.map(p => ({ pid: p.pid, processAbsent: !alive(p.pid), groupAbsent: !alive(p.pid, true) }));
  assert.ok(groups.length > 0, 'Owned process identities required');
  assert.ok(groups.every(p => p.processAbsent && p.groupAbsent), 'Independent process/group audit failed');
  const paths = [report.serviceRoot, report.data, report.socket].filter(Boolean).map(path => ({ path, absent: !existsSync(path) }));
  assert.ok(paths.length === 3 && paths.every(p => p.absent), 'Independent service path audit failed');
  const portClosed = report.port ? !(await portOpen(report.port)) : true;
  assert.ok(portClosed, 'Independent port audit failed');
  const backends = pids.map(pid => ({ pid, absent: !alive(pid) }));
  assert.ok(backends.every(p => p.absent), 'Independent backend process audit failed');
  return { groups, paths, portClosed, backends };
}
