import assert from 'node:assert/strict';
import { spawnSync, fork, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, symlinkSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkReport } from './oracle.mjs';

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../..');
const { values } = parseArgs({ options: { out: { type: 'string' } } });
assert.ok(values.out && !existsSync(values.out), 'new --out required');
assert.ok(['v22.16.0', 'v24.10.0'].includes(process.version), 'exact native runtime required');
const stage = mkdtempSync(join(tmpdir(), 'sqlite-relations-controls-'));
const results = [];
const sha = f => createHash('sha256').update(readFileSync(f)).digest('hex');
const alive = id => { try { process.kill(id, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
const files = dir => readdirSync(join(stage, dir), { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
function audit(r) {
  assert.ok(!alive(r.parent.pid) && !alive(-r.parent.pid), 'independent runner process/group audit');
  assert.equal(r.cleanup.pidAbsent, true); assert.equal(r.cleanup.groupAbsent, true); assert.equal(r.cleanup.pathAbsent, true);
  assert.ok(!alive(r.owned.pid) && !alive(-r.owned.pgid), 'independent owned process/group audit');
  assert.ok(!existsSync(r.owned.directory), 'independent owned path audit');
}
try {
  cpSync(join(root, 'src'), join(stage, 'src'), { recursive: true });
  mkdirSync(join(stage, 'benchmarks'), { recursive: true });
  cpSync(here, join(stage, 'benchmarks/sqlite-relations'), { recursive: true });
  for (const file of ['package.json', 'package-lock.json']) cpSync(join(root, file), join(stage, file));
  symlinkSync(join(root, 'node_modules'), join(stage, 'node_modules'), 'dir');
  const snapshot = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim(), worktree: root,
    files: Object.fromEntries([...files('src'), ...files('benchmarks/sqlite-relations')].map(f => [f, sha(join(stage, f))])) };
  const identity = join(stage, 'snapshot.json'); writeFileSync(identity, JSON.stringify(snapshot));
  const script = join(stage, 'benchmarks/sqlite-relations/run.mjs');
  const args = fault => [script, '--snapshot', identity, '--out', join(stage, `${fault}.json`), '--fault', fault, '--deadline', fault === 'hang' ? '1500' : '15000'];
  const baseline = spawnSync(process.execPath, args('none'), { encoding: 'utf8', timeout: 20000, detached: true });
  assert.equal(baseline.status, 0, baseline.stderr);
  const good = JSON.parse(readFileSync(join(stage, 'none.json'))); checkReport(good); audit(good);
  results.push({ control: 'native-prerequisite', exit: baseline.status, report: good });
  for (const [fault, pattern] of [
    ['missing-row', /exact independent nested/], ['tie-window', /exact independent nested/], ['wrong-limit', /exact independent nested/],
    ['materialize', /stream used materializing route/], ['lost-handle', /native handle closure proof/],
    ['hang', /child\/group deadline exceeded/], ['self-signal', /SIGTERM/],
  ]) {
    const child = spawnSync(process.execPath, args(fault), { encoding: 'utf8', timeout: 20000, detached: true });
    assert.equal(child.status, 1, child.stderr);
    const r = JSON.parse(readFileSync(join(stage, `${fault}.json`)));
    assert.equal(r.status, 'failed'); assert.match(JSON.stringify(r.failures), pattern);
    assert.equal(r.ready?.prerequisites, true, 'fault after native prerequisites'); audit(r);
    results.push({ control: fault, exit: child.status, report: r });
  }
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const out = join(stage, `${signal}.json`);
    const child = fork(script, ['--snapshot', identity, '--out', out, '--fault', 'hang', '--deadline', '15000'], { execPath: process.execPath, execArgv: [], detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let ready = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 18000);
    child.on('message', m => { if (m.ready) { ready = true; child.kill(signal); } });
    const exit = await new Promise(resolveExit => child.once('exit', (code, osSignal) => resolveExit({ code, signal: osSignal })));
    clearTimeout(timer); assert.equal(ready, true); assert.equal(exit.code, 1); assert.equal(exit.signal, null);
    const r = JSON.parse(readFileSync(out)); assert.equal(r.status, 'failed'); assert.equal(r.signal, signal); audit(r);
    results.push({ control: `parent-${signal}`, exit, report: r });
  }
} finally { rmSync(stage, { recursive: true, force: true }); }
writeFileSync(values.out, `${JSON.stringify({ runtime: process.version, command: process.argv, results, stageRemoved: !existsSync(stage) }, null, 2)}\n`, { flag: 'wx' });
process.stderr.write(`passed ${results.length} native prerequisite/control reports: ${values.out}\n`);
