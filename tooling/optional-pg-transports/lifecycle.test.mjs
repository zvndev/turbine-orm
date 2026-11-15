import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { command } from './harness.mjs';
import { bounded, lifecycle, processIdentity } from './lifecycle.mjs';
import { runWithShutdown } from './run.mjs';
const worker = fileURLToPath(new URL('./fixtures/lifecycle-worker.mjs', import.meta.url));

for (const fault of ['FileNotFoundError', 'ProcessLookupError', 'PermissionError', 'OSError']) {
  test(`proc child-list observation handles ${fault} without losing ownership`, { timeout: 8000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'optional-proc-race-'));
    const report = { commands: [] };
    try {
      // Exercise the real supervisor and kernel reaping, changing only one
      // observation. Disappearing proc entries are transient; access/I/O faults
      // must still reject rather than certify an unobservable command tree.
      const shim = join(root, 'python3');
      writeFileSync(shim, `#!/usr/bin/python3
import pathlib, sys, runpy
if sys.argv[1].endswith('http-command-supervisor.py'):
 original=pathlib.Path.read_text
 fired=False
 def observe(self,*args,**kwargs):
  global fired
  if not fired and str(self).startswith('/proc/') and self.name=='children':
   fired=True
   pathlib.Path(${JSON.stringify(join(root, 'injected'))}).write_text(${JSON.stringify(fault)})
   raise ${fault}(${fault === 'ProcessLookupError' ? 3 : fault === 'FileNotFoundError' ? 2 : fault === 'PermissionError' ? 13 : 5}, 'injected child-list observation', str(self))
  return original(self,*args,**kwargs)
 pathlib.Path.read_text=observe
sys.argv=sys.argv[1:]
runpy.run_path(sys.argv[0],run_name='__main__')
`);
      chmodSync(shim, 0o755);
      const run = command(report, root, process.execPath, ['-e', 'setTimeout(() => {}, 80)'], { ...process.env, PATH: root }, { timeoutMs: 3000 });
      const transient = fault === 'FileNotFoundError' || fault === 'ProcessLookupError';
      if (transient) await run;
      else await assert.rejects(run, new RegExp(fault));
      assert.equal(readFileSync(join(root, 'injected'), 'utf8'), fault);
      const record = report.commands[0], proof = record.ownershipProof;
      assert.equal(proof.complete, true);
      assert.equal(proof.passed, transient);
      assert.equal(proof.failures.length, transient ? 0 : 1);
      assert.deepEqual(proof.remaining, []);
      assert.ok(proof.reaped.some((item) => item.pid === proof.leader.pid));
      for (const item of proof.processes) {
        const live = processIdentity(item.pid);
        assert.ok(!live || live.startTime !== item.startTime);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

for (const pipes of ['redirected', 'inherited']) test(`fast new-session orphan is adopted and reaped (${pipes} pipes)`, { timeout: 8000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'optional-escaped-'));
  const report = { commands: [] };
  try {
    // A fast-exit shell, including a session change before its
    // leader exits. No JS poll has to observe that parent/child relationship.
    await command(report, root, '/bin/sh', ['-c', `setsid /bin/sleep 120 </dev/null ${pipes === 'redirected' ? '>/dev/null 2>&1' : ''} & echo $! > marker`], process.env, { timeoutMs: 3000 });
    const pid = Number(readFileSync(join(root, 'marker'), 'utf8'));
    const record = report.commands[0], proof = record.ownershipProof;
    assert.equal(processIdentity(pid), null);
    assert.ok(record.ownedProcesses.some((item) => item.pid === pid));
    assert.ok(proof.reaped.some((item) => item.pid === pid));
    assert.equal(proof.complete, true); assert.equal(proof.subreaper, true);
    assert.equal(record.reaped, true); assert.equal(record.ownershipReportRemoved, true);
    assert.deepEqual(record.remainingPids, []); assert.deepEqual(record.remainingGroups, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const capability of ['pidfd_open', 'pidfd_send_signal', 'signal_syscall', 'subreaper']) test(`missing kernel ${capability} fails before command admission`, { timeout: 5000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'optional-capability-'));
  const report = { commands: [] };
  try {
    // Isolated interpreter fault; the reserved supervisor bytes stay untouched.
    const shim = join(root, 'python3');
    writeFileSync(shim, `#!/usr/bin/python3
import os, signal, ctypes, sys, runpy
${capability === 'subreaper' ? 'class Missing:\n def prctl(self,*args): return -1\nctypes.CDLL=lambda *args,**kwargs: Missing()' : capability === 'signal_syscall' ? "def unsupported(*args): raise OSError(38, 'pidfd signal syscall unavailable')\nsignal.pidfd_send_signal=unsupported" : `del ${capability === 'pidfd_open' ? 'os' : 'signal'}.${capability}`}
sys.argv=sys.argv[1:]
runpy.run_path(sys.argv[0],run_name='__main__')
`);
    chmodSync(shim, 0o755);
    await assert.rejects(command(report, root, '/bin/sh', ['-c', 'touch admitted'], { ...process.env, PATH: root }), /Command ownership admission failed/);
    assert.equal(existsSync(join(root, 'admitted')), false);
    assert.equal(report.commands[0].reaped, undefined);
    assert.equal(report.commands[0].admission.status, 1);
    assert.equal(report.commands[0].ownershipProof, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('body callback throw still stops its service child after a null cleanup callback', { timeout: 8000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'optional-callback-'));
  const report = { commands: [] }, primary = new Error('body callback failure');
  try {
    await assert.rejects(runWithShutdown(report, join(root, 'report.json'), async (scope) => {
      const handle = scope.spawn(process.execPath, [worker, join(root, 'marker')], {}, {});
      handle.service = true;
      handle.child.stdout.resume(); handle.child.stderr.resume();
      const until = Date.now() + 3000;
      while (!existsSync(join(root, 'marker')) && Date.now() < until) await delay(10);
      assert.equal(existsSync(join(root, 'marker')), true);
      scope.registerStop(() => { throw null; });
      throw primary;
    }), (reason) => reason === primary);
    const result = JSON.parse(readFileSync(join(root, 'report.json')));
    assert.deepEqual(result.cleanupErrors, ['null']);
    assert.equal(result.lifecycle.children[0].reaped, true);
    assert.equal(processIdentity(JSON.parse(readFileSync(join(root, 'marker'))).pid), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const thenable = { then() { throw new Error('Thrown thenable must not be assimilated'); } };
const hostile = { get stack() { throw null; }, toString() { throw undefined; } };
for (const reason of [new Error('original rejection'), null, undefined, false, 0, -0, NaN, 1n, Symbol('reason'), '', thenable, hostile]) {
  for (const phase of ['body', 'stop']) test(`arbitrary ${phase} rejection keeps identity (${typeof reason}, ${reason === null ? 'null' : phase})`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'optional-reason-'));
    const report = { commands: [] }, stages = [];
    const before = ['SIGINT', 'SIGTERM'].map((name) => process.listenerCount(name));
    let rejected = false;
    try {
      try {
        await runWithShutdown(report, join(root, 'report.json'), async (scope) => {
          scope.registerStop(() => { stages.push('last stop'); });
          scope.registerStop(() => { stages.push('fault stop'); throw phase === 'stop' ? reason : null; });
          if (phase === 'body') throw reason;
        }, () => { stages.push('final cleanup'); throw new Error('secondary final cleanup'); });
      } catch (error) { rejected = true; assert.equal(error, reason); }
      assert.equal(rejected, true);
      assert.deepEqual(stages, ['fault stop', 'last stop', 'final cleanup']);
      const saved = JSON.parse(readFileSync(join(root, 'report.json')));
      assert.equal(saved.success, false); assert.equal(typeof saved.failure, 'string');
      assert.equal(saved.cleanupErrors.length, 2);
      assert.deepEqual(['SIGINT', 'SIGTERM'].map((name) => process.listenerCount(name)), before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('report I/O failure is secondary to arbitrary primary rejection and always disposes handlers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'optional-report-io-'));
  try {
    for (const reason of [new Error('original before report I/O'), null, undefined, thenable]) {
      const report = { commands: [] };
      const listeners = process.listenerCount('SIGTERM');
      let rejected = false;
      try {
        await runWithShutdown(report, root, () => { throw reason; }); // real EISDIR
      } catch (error) { rejected = true; assert.equal(error, reason); }
      assert.equal(rejected, true); assert.equal(report.success, false);
      assert.match(report.persistenceErrors[0], /EISDIR/);
      assert.match(report.cleanupErrors[0], /EISDIR/);
      assert.equal(process.listenerCount('SIGTERM'), listeners);
    }
    const report = { commands: [] };
    await assert.rejects(runWithShutdown(report, root, () => {}), { code: 'EISDIR' });
    assert.equal(report.success, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const name of ['SIGINT', 'SIGTERM']) test(`${name} before pending acquisition rejection remains the first outcome`, { timeout: 5000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'optional-signal-order-'));
  const runner = join(root, 'runner.mjs');
  writeFileSync(runner, `import {writeFileSync} from 'node:fs';
import {runWithShutdown} from ${JSON.stringify(new URL('./run.mjs', import.meta.url).href)};
const report={commands:[]};let primary;
try {await runWithShutdown(report,${JSON.stringify(join(root, 'report.json'))},async scope=>{
  primary=scope.signal;
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('signal was not delivered')),1000);scope.signal.addEventListener('abort',()=>{clearTimeout(timer);resolve();},{once:true});process.kill(process.pid,${JSON.stringify(name)});});
  writeFileSync(${JSON.stringify(join(root, 'ordering.json'))},JSON.stringify({signal:report.signal}));
  throw new Error('later acquisition failure');
});} catch(error) {if(error!==primary.reason) process.exitCode=91;else process.exitCode ||= 1;}`);
  const child = spawn(process.execPath, [runner], { stdio: 'ignore' });
  const exit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    assert.deepEqual(await bounded(exit, 4000, 'Signal ordering'), { code: name === 'SIGINT' ? 130 : 143, signal: null });
    assert.equal(JSON.parse(readFileSync(join(root, 'ordering.json'))).signal, name);
    const report = JSON.parse(readFileSync(join(root, 'report.json')));
    assert.match(report.failure, /Interrupted by/); assert.match(report.secondaryErrors[0], /later acquisition/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exit; rmSync(root, { recursive: true, force: true });
  }
});

test('command error observed before teardown signals remains primary', { timeout: 5000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'optional-command-order-'));
  writeFileSync(join(root, 'runner.mjs'), `import {setTimeout as delay} from 'node:timers/promises';
import {runWithShutdown} from ${JSON.stringify(new URL('./run.mjs', import.meta.url).href)};
import {command} from ${JSON.stringify(new URL('./harness.mjs', import.meta.url).href)};
const report={commands:[]};
try {await runWithShutdown(report,${JSON.stringify(join(root, 'report.json'))},scope=>{
  const spawn=scope.spawn;
  scope.spawn=(...args)=>{const handle=spawn(...args);const stop=handle.stop;
    handle.stop=async()=>{process.kill(process.pid,'SIGTERM');await delay(20);return stop();};return handle;};
  return command(report,${JSON.stringify(root)},process.execPath,['-e','process.exitCode=7'],process.env,{scope});
});} catch(error) {process.exitCode ||= 1;}`);
  const child = spawn(process.execPath, [join(root, 'runner.mjs')], { stdio: 'ignore' });
  const exit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    assert.deepEqual(await bounded(exit, 4000, 'Command error ordering'), { code: 1, signal: null });
    const report = JSON.parse(readFileSync(join(root, 'report.json')));
    assert.match(report.failure, /failed \(7/); assert.equal(report.signal, 'SIGTERM');
    assert.deepEqual(report.cleanupErrors, []);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exit; rmSync(root, { recursive: true, force: true });
  }
});

test('deadline reaps SIGTERM-resistant descendants before parent and bounds inherited pipes', { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'optional-deadline-'));
  const report = { commands: [] };
  try {
    await assert.rejects(command(report, root, process.execPath, [worker, join(root, 'marker')], process.env, { timeoutMs: 500 }), /Child command exceeded 500ms/);
    const identity = JSON.parse(readFileSync(join(root, 'marker')));
    assert.equal(existsSync(`/proc/${identity.pid}`), false);
    const record = report.commands[0];
    assert.ok(record.ownedProcesses.some((item) => item.pid === identity.pid));
    assert.equal(record.reaped, true);
    assert.deepEqual(record.remainingPids, []); assert.deepEqual(record.remainingGroups, []);
    for (const item of record.ownedProcesses) assert.equal(existsSync(`/proc/${item.pid}`), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shutdown seals launches synchronously and executes stop callbacks once despite failure', async () => {
  const report = { commands: [] }, scope = lifecycle(report, { cleanupMs: 100 });
  let stops = 0;
  scope.registerStop(async () => { stops++; throw new Error('cleanup fixture failure'); });
  try {
    const first = scope.shutdown();
    assert.equal(scope.shutdown(), first);
    assert.throws(() => scope.spawn(process.execPath, [], {}, {}), /sealed/);
    assert.throws(() => scope.registerStop(() => {}), /sealed/);
    assert.equal((await first).length, 1); assert.equal(stops, 1);
    assert.equal(report.lifecycle.sealed, true);
  } finally { scope.dispose(); }
});

test('primary failure is preserved and failed final report survives cleanup failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'optional-report-'));
  const report = { commands: [] }, primary = new Error('primary fixture failure');
  try {
    await assert.rejects(runWithShutdown(report, join(root, 'report.json'), async (scope) => {
      scope.registerStop(async () => { throw new Error('cleanup fixture failure'); });
      throw primary;
    }), (error) => error === primary);
    const result = JSON.parse(readFileSync(join(root, 'report.json')));
    assert.equal(result.success, false); assert.match(result.failure, /primary fixture failure/);
    assert.equal(result.cleanupErrors.length, 1); assert.match(result.cleanupErrors[0], /cleanup fixture failure/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const name of ['SIGINT', 'SIGTERM']) for (const cleanupFails of [false, true]) test(`${name} writes failure evidence, reaps workers and preserves signal status (cleanup failure: ${cleanupFails})`, { timeout: 12000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'optional-signal-'));
  const reportPath = join(root, 'report.json'), marker = join(root, 'marker');
  const script = `import {runWithShutdown} from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL('./run.mjs', import.meta.url))).href)};
import {command} from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL('./harness.mjs', import.meta.url))).href)};
try {await runWithShutdown({commands:[]},${JSON.stringify(reportPath)},scope=>{${cleanupFails ? "scope.registerStop(async()=>{throw new Error('cleanup fault fixture');});" : ''}return command({commands:[]},${JSON.stringify(root)},process.execPath,[${JSON.stringify(worker)},${JSON.stringify(marker)}],process.env,{scope});});}
catch(error){console.error(error.message);process.exitCode ||= 1;}`;
  writeFileSync(join(root, 'runner.mjs'), script);
  const child = spawn(process.execPath, [join(root, 'runner.mjs')], { stdio: 'ignore' });
  const exit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(marker) && Date.now() < deadline) await delay(20);
    assert.equal(existsSync(marker), true);
    const identity = JSON.parse(readFileSync(marker));
    child.kill(name); child.kill(name);
    assert.deepEqual(await bounded(exit, 6000, 'Signal fixture'), { code: name === 'SIGINT' ? 130 : 143, signal: null });
    const report = JSON.parse(readFileSync(reportPath));
    assert.equal(report.success, false); assert.equal(report.signal, name);
    assert.equal(report.cleanupErrors.length, cleanupFails ? 1 : 0);
    if (cleanupFails) assert.match(report.cleanupErrors[0], /cleanup fault fixture/);
    assert.equal(existsSync(`/proc/${identity.pid}`), false);
    for (const record of report.lifecycle.children) {
      assert.equal(record.reaped, true);
      for (const item of record.ownedProcesses) assert.equal(existsSync(`/proc/${item.pid}`), false);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exit;
    rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup deadline writes a failed report without extending a stalled stop', { timeout: 2000 }, async () => {
  const report = { commands: [] }, scope = lifecycle(report, { cleanupMs: 50 });
  scope.registerStop(() => new Promise(() => {}));
  try {
    const errors = await scope.shutdown();
    assert.equal(errors.length, 1); assert.match(errors[0], /Resource cleanup exceeded 50ms/);
  } finally { scope.dispose(); }
});

for (const name of ['SIGINT', 'SIGTERM']) test(`${name} during cleanup preserves an earlier primary failure`, { timeout: 8000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'optional-primary-'));
  const reportPath = join(root, 'report.json'), marker = join(root, 'marker');
  writeFileSync(join(root, 'runner.mjs'), `import {writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {runWithShutdown} from ${JSON.stringify(new URL('./run.mjs', import.meta.url).href)};
try {await runWithShutdown({commands:[]},${JSON.stringify(reportPath)},async scope=>{scope.registerStop(async()=>{writeFileSync(${JSON.stringify(marker)},'ready');await delay(300);throw new Error('cleanup failure');});throw new Error('first failure');});}
catch(error){process.exitCode ||= 1;}`);
  const child = spawn(process.execPath, [join(root, 'runner.mjs')], { stdio: 'ignore' });
  const exit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    const until = Date.now() + 3000;
    while (!existsSync(marker) && Date.now() < until) await delay(10);
    assert.equal(existsSync(marker), true); child.kill(name);
    assert.deepEqual(await bounded(exit, 4000, 'Primary failure fixture'), { code: 1, signal: null });
    const result = JSON.parse(readFileSync(reportPath));
    assert.equal(result.success, false); assert.match(result.failure, /first failure/);
    assert.equal(result.signal, name); assert.match(result.cleanupErrors[0], /cleanup failure/);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exit; rmSync(root, { recursive: true, force: true }); }
});

test('optional measurement runs in an owned process and drains its esbuild worker (synthetic entries only)', { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'optional-measure-control-'));
  const { mkdirSync } = await import('node:fs');
  const report = { commands: [] }, scope = lifecycle(report);
  try {
    mkdirSync(join(root, 'dist'));
    for (const entry of ['neon-ws', 'neon-http', 'live-query', 'notification-hub']) writeFileSync(join(root, 'dist', `${entry}.js`), 'export const fixture = () => 1;');
    const output = await command(report, root, process.execPath, [fileURLToPath(new URL('./measure.mjs', import.meta.url)), root, join(root, 'synthetic')], process.env, { scope });
    assert.deepEqual(Object.keys(JSON.parse(output).entries), ['neon-ws', 'neon-http', 'live-query', 'notification-hub']);
    assert.deepEqual(await scope.shutdown(), []);
    assert.equal(report.commands[0].reaped, true);
    for (const item of report.commands[0].ownedProcesses) assert.equal(existsSync(`/proc/${item.pid}`), false);
  } finally { await scope.shutdown(); scope.dispose(); rmSync(root, { recursive: true, force: true }); }
});
