// Linux-only fixture ownership. Never signals a process group or an unverified PID.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function identity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return {
      pid: Number(pid),
      state: fields[0],
      session: Number(fields[3]),
      ppid: Number(fields[1]),
      pgid: Number(fields[2]),
      startTime: fields[19],
      command: readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim(),
    };
  } catch {
    return null;
  }
}
export function sameProcess(record) {
  const current = record && identity(record.pid);
  return Boolean(record?.startTime && current !== null && current.startTime === record.startTime);
}
export function descendants(owners) {
  const processes = readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .map(identity)
    .filter(Boolean);
  const found = new Map(owners.filter(sameProcess).map((entry) => [entry.pid, identity(entry.pid)]));
  let size;
  do {
    size = found.size;
    for (const entry of processes) if (found.has(entry.ppid)) found.set(entry.pid, entry);
  } while (found.size !== size);
  return [...found.values()];
}
export function signalOwned(record, signal) {
  if (!record?.startTime && record?.ownershipReport && existsSync(record.ownershipReport)) {
    Object.assign(record, JSON.parse(readFileSync(record.ownershipReport, 'utf8')).leader);
  }
  if (!sameProcess(record)) return false;
  try {
    process.kill(record.pid, signal);
    return true;
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
    return false;
  }
}
export async function bounded(operation, ms, label) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export function persist(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2));
  renameSync(temporary, path);
}
function failureText(reason) {
  try {
    const stack = reason?.stack;
    return typeof stack === 'string' ? stack : String(reason);
  } catch {
    return 'Unprintable thrown value';
  }
}
// Test barriers are opt-in and apply only to fixture processes, never the production adapter.
export async function checkpoint(phase, details = {}, signal) {
  if (!process.env.NEON_HTTP_TEST_BARRIER?.split(',').includes(phase)) return;
  const root = process.env.NEON_HTTP_TEST_CONTROL;
  assert.ok(root, 'NEON_HTTP_TEST_CONTROL required for a test barrier');
  const release = join(root, `${phase}.release`);
  persist(join(root, `${phase}.ready.json`), { phase, process: identity(process.pid), ...details });
  await new Promise((resolve, reject) => {
    let watcher;
    let timer;
    const finish = (error) => {
      watcher?.close();
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      if (error) reject(error);
      else resolve();
    };
    const aborted = () => finish(signal.reason);
    watcher = watch(root, () => {
      if (existsSync(release)) finish();
    });
    timer = setTimeout(() => finish(new Error(`Test barrier ${phase} was not released`)), 30_000);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
    else if (existsSync(release)) finish();
  });
}

export class OwnedChildren {
  constructor({ cwd, report, env, onChange = () => {} }) {
    Object.assign(this, { cwd, report, env, onChange });
    this.active = new Set();
    this.sealed = false;
  }
  seal(reason) {
    this.sealed = true;
    this.reason ??= reason;
    for (const entry of this.active)
      void this.stop(entry).catch((error) => {
        entry.record.stopError = error.stack;
        entry.error ??= error;
      });
  }
  check() {
    if (this.sealed) throw this.reason ?? new Error('Owned launches are sealed');
  }
  async run(label, binary, args, { env = this.env, cwd = this.cwd, log, timeout = 120_000, failure } = {}) {
    this.check();
    assert.equal(process.platform, 'linux', 'HTTP command ownership requires Linux');
    const temporary = log ? undefined : mkdtempSync(join(tmpdir(), 'http-owned-'));
    const ownershipReport = log ? `${log}.ownership.json` : join(temporary, 'ownership.json');
    const fd = log ? openSync(log, 'w') : undefined;
    let child;
    const caller = identity(process.pid);
    try {
      child = spawn(
        'python3',
        [
          fileURLToPath(new URL('./http-command-supervisor.py', import.meta.url)),
          ownershipReport,
          temporary ? '1' : '0',
          String(caller.pid),
          caller.startTime,
          String(timeout),
          label,
          binary,
          ...args,
        ],
        { cwd, env, detached: true, stdio: ['ignore', fd ?? 'pipe', fd ?? 'pipe', 'pipe'] },
      );
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    const record = {
      label,
      binary,
      args,
      cwd,
      ownsProcessGroup: false,
      log,
      ownershipReport,
      supervisor: identity(child.pid),
      ownership: 'fixture-local subreaper; pidfd signals; waitpid ECHILD',
    };
    const entry = { child, record };
    this.active.add(entry);
    this.report.commands.push(record);
    let stdout = '',
      stderr = '';
    child.stdout?.on('data', (part) => {
      stdout += part;
    });
    child.stderr?.on('data', (part) => {
      stderr += part;
    });
    // The command cannot inherit this descriptor. EOF requests teardown even
    // when the caller is killed while its JS thread or onChange is stalled.
    child.stdio[3].on('error', (error) => {
      if (error.code !== 'EPIPE' && error.code !== 'ECONNRESET') entry.error ??= error;
    });
    entry.done = new Promise((resolve) => {
      child.once('error', (error) => {
        entry.error = error;
      });
      child.once('close', (status, signal) => {
        record.supervisorExit = { status, signal };
        resolve();
      });
    });
    const refresh = () => {
      if (!existsSync(ownershipReport)) return;
      const proof = JSON.parse(readFileSync(ownershipReport, 'utf8'));
      Object.assign(record, proof.leader, { processes: proof.processes, termination: proof.termination });
    };
    const monitor = setInterval(() => {
      try {
        refresh();
      } catch (error) {
        entry.error ??= error;
      }
    }, 25); // Evidence only. The subreaper owns cleanup independently.
    const collect = () => {
      if (!existsSync(ownershipReport)) throw new Error(`Missing command ownership proof: ${label}`);
      const proof = JSON.parse(readFileSync(ownershipReport, 'utf8'));
      Object.assign(record, proof.leader, {
        supervisor: proof.supervisor ?? record.supervisor,
        processes: proof.processes,
        termination: proof.termination,
        status: proof.status ?? null,
        signal: proof.signal ?? null,
        ownershipProof: proof,
      });
      assert.equal(record.supervisorExit.status, 0, JSON.stringify(proof));
      assert.equal(record.supervisorExit.signal, null);
      assert.equal(proof.passed, true, JSON.stringify(proof));
      assert.equal(proof.complete, true, 'Subreaper must reap ALL children');
      assert.deepEqual(proof.remaining, []);
      assert.ok(
        proof.processes.every((item) => !sameProcess(item)),
        'Owned descendant survived',
      );
      if (proof.error) entry.error ??= new Error(proof.error);
    };
    entry.collect = collect;
    let primary;
    let failed = false;
    const retain = (error, cleanup = false) => {
      const description = failureText(error);
      if (cleanup) {
        record.cleanupFailures ??= [];
        record.cleanupFailures.push(description);
      }
      if (!failed) {
        failed = true;
        primary = error;
        record.primaryFailure = description;
      }
    };
    try {
      this.onChange();
      // The Python deadline is independent of the Node event loop. This bound
      // also covers its two failure-cleanup bounds and final output drain.
      await bounded(entry.done, timeout + 25_000, `HTTP command supervisor ${label}`);
      Object.assign(record, { stdout, stderr });
      // A spawn failure cannot produce proof. Preserve that original error;
      // finalization still collects and records the failed ownership admission.
      if (entry.error) throw entry.error;
      collect();
      if (entry.error) throw entry.error;
      this.check();
      const output = log ? readFileSync(log, 'utf8') : stdout + stderr;
      if (failure) {
        assert.notEqual(record.status, 0);
        assert.match(output, failure);
      } else assert.equal(record.status, 0, output);
    } catch (error) {
      retain(error);
    } finally {
      try {
        await this.stop(entry);
        collect();
      } catch (error) {
        retain(error, true);
      } finally {
        clearInterval(monitor);
        this.active.delete(entry);
        try {
          child.stdio[3].destroy();
        } catch (error) {
          retain(error, true);
        }
        try {
          if (temporary && !sameProcess(record.supervisor)) rmSync(temporary, { recursive: true, force: true });
        } catch (error) {
          retain(error, true);
        }
        try {
          this.onChange();
        } catch (error) {
          retain(error, true);
        }
      }
    }
    if (failed) throw primary;
  }
  stop(entry) {
    entry.stopping ??= (async () => {
      if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.stdio[3].end('stop\n');
      await bounded(entry.done, 22_000, `Stopping HTTP command supervisor ${entry.record.label}`);
      entry.collect();
    })();
    return entry.stopping;
  }
  async close() {
    this.sealed = true;
    const results = await Promise.allSettled([...this.active].map((entry) => this.stop(entry)));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
}
