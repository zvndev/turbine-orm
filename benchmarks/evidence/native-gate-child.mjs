import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../../', import.meta.url));

// Only this invocation's detached process group is eligible for termination.
// Zombies are already dead and cannot retain a database connection or execute.
export function liveGroup(group) {
  return readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .flatMap((name) => {
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return Number(fields[2]) === group && !['Z', 'X'].includes(fields[0]) ? [Number(name)] : [];
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ESRCH') return [];
        throw error;
      }
    });
}

export async function execute(args, env, stdout, stderr, commands, { timeoutMs = 120000, graceMs = 5000 } = {}) {
  assert.equal(process.platform, 'linux', 'Native gate worker cleanup requires Linux process groups and /proc');
  const out = openSync(stdout, 'wx', 0o600);
  let err;
  try {
    err = openSync(stderr, 'wx', 0o600);
  } catch (error) {
    closeSync(out);
    throw error;
  }
  const record = { executable: process.execPath, args, exitCode: null, signal: null, timedOut: false };
  commands.push(record);
  let child, force;
  const kill = (signal) => {
    if (!child?.pid || !liveGroup(child.pid).length) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  const interrupt = () => {
    kill('SIGTERM');
    force ??= setTimeout(() => kill('SIGKILL'), graceMs);
  };
  const timer = setTimeout(() => {
    record.timedOut = true;
    interrupt();
  }, timeoutMs);
  const signal = () => {
    record.interrupted = true;
    interrupt();
  };
  process.on('SIGINT', signal);
  process.on('SIGTERM', signal);
  try {
    child = spawn(process.execPath, args, { cwd: root, env, detached: true, stdio: ['ignore', out, err] });
    record.processGroup = child.pid;
    await new Promise((done, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        record.exitCode = code;
        record.signal = signal;
        done();
      });
    });
    assert.ok(
      record.exitCode === 0 && !record.timedOut && !record.interrupted,
      'Native child failed, was interrupted or timed out',
    );
  } finally {
    clearTimeout(timer);
    try {
      if (child?.pid && liveGroup(child.pid).length) {
        interrupt();
        const deadline = Date.now() + graceMs + 5000;
        // Keep the escalation alive after the runner exits: workers can outlive it.
        while (liveGroup(child.pid).length && Date.now() < deadline) await delay(25);
        record.remainingWorkers = liveGroup(child.pid);
        assert.deepEqual(record.remainingWorkers, [], 'Owned native workers survived forced termination');
      }
      record.workersStopped = true;
    } finally {
      clearTimeout(force);
      process.off('SIGINT', signal);
      process.off('SIGTERM', signal);
      closeSync(out);
      closeSync(err);
    }
  }
}
