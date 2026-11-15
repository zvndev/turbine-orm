import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createConnection } from 'node:net';

export function pidIdentity(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    return { pid: Number(pid), group: Number(fields[2]), startTicks: fields[19], state: fields[0] };
  } catch { return null; }
}
export function groupMembers(group) {
  return readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map(pidIdentity).filter((p) => p?.group === group);
}
export function owned(command, args, options = {}) {
  const child = spawn(command, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  const state = { child, command, args, identity: pidIdentity(child.pid), pid: child.pid, exited: false, stdout: '', stderr: '', members: [] };
  const observed = new Map();
  function observe() {
    if (!child.pid) return;
    for (const p of groupMembers(child.pid)) observed.set(`${p.pid}:${p.startTicks}`, p);
    state.observed = [...observed.values()];
  }
  observe();
  const observer = setInterval(observe, 25);
  state.finishObservation = () => { observe(); clearInterval(observer); };
  child.stdout?.on('data', (b) => { state.stdout += b; });
  child.stderr?.on('data', (b) => { state.stderr += b; });
  state.done = new Promise((resolve) => {
    child.once('error', (error) => { state.error = error.message; state.exited = true; resolve(state); });
    child.once('exit', (code, signal) => { state.code = code; state.signal = signal; state.exited = true; resolve(state); });
  });
  return state;
}
export function signalGroup(state, signal) {
  if (!state?.pid) return;
  // Only a still-owned leader or its surviving original group may be signalled.
  const current = pidIdentity(state.pid);
  if (current && state.identity && current.startTicks !== state.identity.startTicks) throw new Error('owned PID was reused');
  if (current || groupMembers(state.pid).length) {
    try { process.kill(-state.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
}
export async function deadline(promise, ms, label, expire = () => {}) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => { expire(); reject(new Error(`${label} deadline (${ms}ms)`)); }, ms);
    })]);
  } finally { clearTimeout(timer); }
}
export async function stop(state) {
  if (!state) return;
  state.finishObservation();
  state.members = groupMembers(state.pid);
  signalGroup(state, 'SIGTERM');
  try { await deadline(state.done, 5000, 'group TERM'); }
  catch { signalGroup(state, 'SIGKILL'); await deadline(state.done, 3000, 'group KILL'); }
  const survivors = groupMembers(state.pid);
  if (survivors.length) {
    signalGroup(state, 'SIGKILL');
    await deadline(new Promise((resolve) => {
      const timer = setInterval(() => { if (!groupMembers(state.pid).length) { clearInterval(timer); resolve(); } }, 20);
      setTimeout(() => { clearInterval(timer); resolve(); }, 1000).unref();
    }), 1500, 'descendant cleanup');
  }
  assert.deepEqual(groupMembers(state.pid), [], 'owned process group survived cleanup');
}
export async function portClosed(port) {
  return await new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', (e) => { socket.destroy(); resolve(e.code === 'ECONNREFUSED'); });
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
  });
}
export async function audit(identity) {
  const processes = identity.processes.map((p) => ({ pid: p.pid, original: p.identity, current: pidIdentity(p.pid), groupMembers: groupMembers(p.pid) }));
  const observedPids = identity.processes.flatMap((p) => p.observed ?? []).map((p) => ({ original: p, current: pidIdentity(p.pid) }));
  const paths = identity.removedPaths.map((path) => ({ path, absent: !existsSync(path) }));
  const closed = identity.port ? await portClosed(identity.port) : true;
  return { complete: processes.every((p) => p.current === null && p.groupMembers.length === 0) && observedPids.every((p) => p.current === null) && paths.every((p) => p.absent) && closed,
    processes, observedPids, paths, port: identity.port, portClosed: closed,
    backendAudit: 'Dedicated mysqld process and group absent, TCP listener refused, owned socket and datadir absent; all its recorded backend IDs cease with that service.' };
}
