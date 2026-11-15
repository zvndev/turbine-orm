// Imported by native-interruption.test.mjs, so the existing native job requires it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { bounded, identity, OwnedChildren, persist, sameProcess, signalOwned } from './native-lifecycle.mjs';

const fixture = new URL('./http-ownership-child.mjs', import.meta.url).pathname;
const evidence = resolve(process.env.NEON_HTTP_INTERRUPTION_EVIDENCE);
async function openPort(port) {
  return new Promise((accept) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      accept(true);
    });
    socket.once('error', () => {
      socket.destroy();
      accept(false);
    });
  });
}
for (const mode of ['normal', 'fast', 'pipes', 'nested', 'failure', 'timeout', 'SIGINT', 'SIGTERM', 'callback-error']) {
  test(`durable HTTP command ownership: ${mode}`, { timeout: 30_000 }, async () => {
    const root = join(evidence, `ownership-${mode}`);
    mkdirSync(root, { recursive: true });
    const report = { mode, commands: [], caller: identity(process.pid) };
    const witness = createServer();
    witness.listen(0, '127.0.0.1');
    await new Promise((accept) => witness.once('listening', accept));
    report.witness = { ...identity(process.pid), port: witness.address().port };
    let once = false;
    const owner = new OwnedChildren({
      cwd: root,
      env: process.env,
      report,
      onChange() {
        if (once || mode === 'normal') return;
        once = true;
        if (mode === 'callback-error') throw new Error('Deliberate onChange failure');
        // A synchronous event-loop stall begins BEFORE command admission. It ends
        // only after live leaf proof, then releases parent exit while still stalled.
        const until = Date.now() + 10_000;
        while (!existsSync(join(root, 'leaf.json'))) {
          assert.ok(Date.now() < until, 'Leaf ready barrier');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
        report.leafWhileAlive = JSON.parse(readFileSync(join(root, 'leaf.json')));
        assert.ok(sameProcess(report.leafWhileAlive));
        if (mode === 'timeout' || mode.startsWith('SIG')) return;
        writeFileSync(join(root, 'exit.release'), 'release');
        while (!existsSync(join(root, 'parent-exiting.json'))) {
          assert.ok(Date.now() < until, 'Parent exit barrier');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
        // Keep JS stopped until the supervisor independently proves all reaping.
        const proof = report.commands[0].ownershipReport;
        while (!JSON.parse(readFileSync(proof)).complete) {
          assert.ok(Date.now() < until, 'Supervisor completion independent of JS callbacks');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
        report.completedDuringCallbackStall = true;
      },
    });
    let running;
    try {
      const caller = identity(process.pid);
      assert.equal(signalOwned({ ...caller, startTime: `wrong-${caller.startTime}` }, 'SIGTERM'), false);
      report.pidGenerationMismatchRefused = true;
      running = owner.run(
        mode,
        process.execPath,
        mode === 'normal'
          ? ['-e', 'console.log("normal")']
          : [fixture, 'parent', root, mode.startsWith('SIG') ? 'timeout' : mode],
        { ...(mode === 'pipes' ? {} : { log: join(root, 'command.log') }), timeout: mode === 'timeout' ? 500 : 15_000 },
      );
      // Handle rejection before any later await.
      const result = running.then(
        () => null,
        (error) => error,
      );
      if (mode.startsWith('SIG')) owner.seal(new Error(`Interrupted by ${mode}`));
      const error = await result;
      report.error = error?.stack;
      if (mode === 'failure') assert.match(error?.message ?? '', /7/);
      else if (mode === 'timeout') assert.match(error?.message ?? '', /timed out/);
      else if (mode.startsWith('SIG')) assert.match(error?.message ?? '', /Interrupted by/);
      else if (mode === 'callback-error') assert.match(error?.message ?? '', /Deliberate onChange failure/);
      else assert.equal(error, null, error?.stack);
      await owner.close();
      await assert.rejects(owner.run('after-seal', process.execPath, ['-e', 'process.exit(0)']), /sealed|Interrupted/);
      report.launchAfterSealRefused = true;
      if (report.leafWhileAlive) {
        assert.equal(sameProcess(report.leafWhileAlive), false);
        assert.equal(await openPort(report.leafWhileAlive.port), false);
        assert.ok(report.commands[0].processes.some((p) => p.pid === report.leafWhileAlive.pid));
      }
      for (const command of report.commands) {
        assert.equal(sameProcess(command.supervisor), false);
        assert.ok(command.processes.every((p) => !sameProcess(p)));
        assert.deepEqual(command.ownershipProof.remaining, []);
        assert.equal(command.ownershipProof.complete, true);
      }
      assert.equal(await openPort(report.witness.port), true);
      assert.equal(sameProcess(report.witness), true);
      report.passed = true;
    } finally {
      await owner.close();
      await new Promise((accept) => witness.close(accept));
      persist(join(root, 'result.json'), report);
    }
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`HTTP supervisor survives stalled caller invocation ${signal}`, { timeout: 30_000 }, async () => {
    const root = join(evidence, `ownership-caller-${signal}`);
    const audit = new URL('./http-ownership-audit.py', import.meta.url).pathname;
    const child = spawn('python3', [audit, process.execPath, root, signal], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data) => {
      output += data;
    });
    child.stderr.on('data', (data) => {
      output += data;
    });
    const exited = new Promise((accept, reject) => {
      child.once('error', reject);
      child.once('close', (code) => accept(code));
    });
    assert.equal(await bounded(exited, 25_000, 'Cancelled invocation independent audit'), 0, output);
    const proof = JSON.parse(readFileSync(join(root, 'audit.json')));
    assert.equal(proof.passed, true);
    assert.equal(proof.externalRescue, false);
  });
}

test('HTTP close refuses failed command ownership admission', { timeout: 15_000 }, async () => {
  const root = join(evidence, 'ownership-admission-failure');
  mkdirSync(root, { recursive: true });
  const report = { commands: [] };
  let closing;
  const owner = new OwnedChildren({
    cwd: root,
    env: process.env,
    report,
    onChange() {
      if (closing) return;
      const path = report.commands[0].ownershipReport;
      const until = Date.now() + 10_000;
      while (!existsSync(path) || !JSON.parse(readFileSync(path)).failures.length) {
        assert.ok(Date.now() < until, 'Supervisor failed admission barrier');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      closing = owner.close().then(
        () => null,
        (error) => error,
      );
    },
  });
  try {
    const failed = await owner
      .run('absent-command', join(root, 'absent-command'), [], {
        log: join(root, 'command.log'),
        timeout: 2000,
      })
      .then(
        () => null,
        (error) => error,
      );
    assert.match(failed?.message ?? '', /FileNotFoundError/);
    const closeError = await closing;
    assert.match(closeError?.message ?? '', /FileNotFoundError/);
    assert.equal(sameProcess(report.commands[0].supervisor), false);
    report.passed = true;
    report.runError = failed.stack;
    report.closeError = closeError.stack;
  } finally {
    await owner.close();
    persist(join(root, 'result.json'), report);
  }
});

for (const mode of ['error', 'null', 'undefined', 'false', 'zero', 'empty', 'unprintable', 'cleanup-only']) {
  test(`HTTP removal failure preserves first error: ${mode}`, { timeout: 15_000 }, async () => {
    const root = join(evidence, `ownership-first-error-${mode}`);
    mkdirSync(root, { recursive: true });
    const report = { commands: [] };
    const owner = new OwnedChildren({ cwd: root, env: process.env, report });
    try {
      await owner.run(
        mode,
        process.execPath,
        [new URL('./http-error-preservation.mjs', import.meta.url).pathname, root, mode],
        { log: join(root, 'command.log'), timeout: 10_000 },
      );
      const fault = JSON.parse(readFileSync(join(root, 'fault-result.json')));
      assert.equal(fault.passed, true);
      assert.equal(fault.originalErrorRetained, true);
      assert.equal(fault.finalCallbackAfterCleanupFailure, true);
      assert.equal(fault.faultDirectoryCleanup.removed, true);
      assert.equal(existsSync(fault.faultDirectoryCleanup.path), false);
      report.passed = true;
    } finally {
      await owner.close();
      persist(join(root, 'result.json'), report);
    }
  });
}

test('HTTP missing Python retains spawn error and failed ownership proof', { timeout: 5000 }, async () => {
  const root = join(evidence, 'ownership-missing-python');
  mkdirSync(root, { recursive: true });
  const report = { commands: [] };
  const owner = new OwnedChildren({ cwd: root, env: { ...process.env, PATH: join(root, 'no-binaries') }, report });
  try {
    await assert.rejects(owner.run('missing-python', process.execPath, ['-e', 'process.exit(0)']), (error) => {
      assert.equal(error.code, 'ENOENT');
      assert.equal(error.syscall, 'spawn python3');
      return true;
    });
    const command = report.commands[0];
    assert.match(command.primaryFailure, /spawn python3 ENOENT/);
    assert.match(command.cleanupFailures.join('\n'), /Missing command ownership proof/);
    assert.equal(command.supervisor, null);
    assert.equal(command.ownershipProof, undefined);
    assert.equal(existsSync(dirname(command.ownershipReport)), false);
    assert.equal(owner.active.size, 0);
    report.passed = true;
  } finally {
    await owner.close();
    persist(join(root, 'result.json'), report);
  }
});
