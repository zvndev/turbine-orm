import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { openSync, closeSync, fsyncSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { FORMAT, checkReport } from './oracle.mjs';

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../..');
const { values } = parseArgs({ options: { out: { type: 'string' }, module: { type: 'string' }, archive: { type: 'string' }, snapshot: { type: 'string' },
  rounds: { type: 'string', default: '1' }, scale: { type: 'string', default: '1' }, delay: { type: 'string', default: '0' },
  deadline: { type: 'string', default: '30000' }, fault: { type: 'string', default: 'none' } } });
assert.ok(values.out, '--out required');
for (const [k, min, max] of [['rounds', 1, 20], ['scale', 1, 16], ['delay', 0, 20], ['deadline', 100, 120000]]) {
  assert.ok(/^\d+$/.test(values[k]) && Number(values[k]) >= min && Number(values[k]) <= max, `invalid ${k}`);
}
assert.ok(['none', 'missing-row', 'tie-window', 'wrong-limit', 'materialize', 'lost-handle', 'hang', 'self-signal'].includes(values.fault));
const fd = openSync(resolve(values.out), 'wx'); // Refuse existing destinations, including failed reports.
const sha = f => createHash('sha256').update(readFileSync(f)).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000 }).trim();
const files = dir => readdirSync(join(root, dir), { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
const host = () => ({ at: new Date().toISOString(), loadavg: os.loadavg(), freeMemory: os.freemem(), cpuTimes: os.cpus().map(c => c.times) });
const report = { format: FORMAT, status: 'running', failures: [], signal: null, samples: [], rounds: Number(values.rounds), scale: Number(values.scale),
  config: values, command: [process.execPath, ...process.execArgv, ...process.argv.slice(1)], before: host(),
  scope: { timing: 'read, decode, instrumentation, result retention and matched consumer delays; excludes setup/introspection/transaction begin/snapshot pin/EXPLAIN/commit',
    memory: 'worker snapshots and process high-water RSS; includes retained exact results; no global or child-payload memory bound',
    bytes: 'UTF-8 JSON serialization bytes; native safe fixture bigint integers normalized exactly to numbers; not wire/storage bytes',
    snapshot: 'one supplied native DatabaseSync; public $transaction/read pin/commit each arm; fixed pragmas; no concurrent writer',
    contention: 'no competing SQLite connection; shared-host load/cpu counters recorded; no isolation from other host workloads', ranking: 'diagnostic only; no speed claim' },
  cleanup: { servicesStarted: 0 }, provenance: {}, parent: { pid: process.pid, procStat: readFileSync(`/proc/${process.pid}/stat`, 'utf8') } };
let directory, child, deadlineTimer, killTimer, received;
const persist = () => { writeFileSync(fd, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8' }); fsyncSync(fd); };
const fail = e => { report.status = 'failed'; report.failures.push({ name: e.name, message: e.message, stack: e.stack }); };
const alive = id => { try { process.kill(id, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
const kill = signal => { if (child?.pid) { try { process.kill(-child.pid, signal); } catch (e) { if (e.code !== 'ESRCH') fail(e); } } };
const stop = () => { kill('SIGTERM'); killTimer ??= setTimeout(() => kill('SIGKILL'), 300); };
const handlers = Object.fromEntries(['SIGINT', 'SIGTERM'].map(signal => [signal, () => {
  report.signal ??= signal; fail(new Error(`received ${signal}`)); stop();
}]));
for (const [signal, fn] of Object.entries(handlers)) process.on(signal, fn);
try {
  const modulePath = resolve(values.module ?? join(root, 'src/sqlite.ts'));
  if (values.module) assert.ok(values.archive, '--archive required for packed module provenance');
  let packedFiles = null;
  if (values.module) {
    let packageRoot = dirname(modulePath);
    while (!existsSync(join(packageRoot, 'package.json'))) {
      const next = dirname(packageRoot); assert.notEqual(next, packageRoot, 'packed package root'); packageRoot = next;
    }
    // CJS has its own package.json; climb to the actual distribution root.
    if (packageRoot.endsWith('/dist/cjs')) packageRoot = resolve(packageRoot, '../..');
    const entries = execFileSync('tar', ['-tzf', resolve(values.archive)], { encoding: 'utf8', timeout: 10000 }).trim().split('\n');
    const payloads = entries.filter(f => f.startsWith('package/dist/') && !f.endsWith('/'));
    assert.ok(payloads.length > 0, 'nonempty archive payload');
    const unpacked = mkdtempSync(join(os.tmpdir(), 'sqlite-relations-archive-'));
    try {
      assert.ok(payloads.every(p => !p.split('/').includes('..')), 'archive paths');
      execFileSync('tar', ['-xzf', resolve(values.archive), '-C', unpacked, '--', ...payloads], { timeout: 10000 });
      packedFiles = Object.fromEntries(payloads.map(f => {
        const path = f.slice('package/'.length), expectedHash = sha(join(unpacked, f));
        assert.equal(sha(join(packageRoot, path)), expectedHash, `packed payload mismatch: ${path}`);
        return [path, expectedHash];
      }));
    } finally { rmSync(unpacked, { recursive: true, force: true }); }
    assert.ok(packedFiles[relative(packageRoot, modulePath)], 'loaded module belongs to archive');
  }
  const snapshot = values.snapshot ? JSON.parse(readFileSync(values.snapshot)) : null;
  if (snapshot) for (const [f, hash] of Object.entries(snapshot.files)) assert.equal(sha(join(root, f)), hash, `snapshot input changed: ${f}`);
  report.provenance = { head: snapshot?.head ?? git('rev-parse', 'HEAD'), branch: snapshot?.branch ?? git('branch', '--show-current'), worktree: root, status: snapshot ? 'disposable snapshot' : git('status', '--short'),
    snapshotIdentity: snapshot ? { path: values.snapshot, sha256: sha(values.snapshot), origin: snapshot.worktree } : null,
    kind: values.module ? 'packed-esm' : 'source', packedFiles, modulePath, moduleSha256: sha(modulePath),
    archive: values.archive ? { path: resolve(values.archive), sha256: sha(values.archive) } : null,
    files: Object.fromEntries([...files('src'), ...files('benchmarks/sqlite-relations')].sort().map(f => [f, sha(join(root, f))])),
    lockSha256: sha(join(root, 'package-lock.json')),
    tsx: JSON.parse(readFileSync(join(root, 'node_modules/tsx/package.json'))).version,
    runtime: { node: process.version, executable: realpathSync(process.execPath), binarySha256: sha(process.execPath), versions: process.versions },
    host: { release: os.release(), platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, cpus: os.cpus().length } };
  directory = mkdtempSync(join(os.tmpdir(), 'sqlite-relations-'));
  report.owned = { directory, port: null, socket: null, backend: 'embedded SQLite, no server process' };
  child = spawn(process.execPath, [...(values.module ? [] : ['--import', join(root, 'node_modules/tsx/dist/loader.mjs')]), join(here, 'worker.mjs'),
    modulePath, directory, values.rounds, values.scale, values.delay, values.fault], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  report.owned.pid = child.pid; report.owned.pgid = child.pid;
  report.owned.procStat = readFileSync(`/proc/${child.pid}/stat`, 'utf8');
  report.stdout = ''; report.stderr = '';
  child.stdout.on('data', b => { report.stdout = (report.stdout + b).slice(-65536); });
  child.stderr.on('data', b => { report.stderr = (report.stderr + b).slice(-65536); });
  child.on('message', m => { if (m.ready) { report.ready = m; if (process.send) process.send({ ready: true, owned: report.owned }); } if (m.result) received = m.result; });
  deadlineTimer = setTimeout(() => { fail(new Error('child/group deadline exceeded')); stop(); }, Number(values.deadline));
  await new Promise(resolveExit => {
    child.once('error', e => { fail(e); resolveExit(); });
    child.once('close', (code, signal) => { report.exit = { code, signal }; resolveExit(); });
  });
  clearTimeout(deadlineTimer); clearTimeout(killTimer);
  if (report.exit?.code !== 0 || report.exit?.signal) fail(new Error(`child exit ${JSON.stringify(report.exit)}`));
  assert.ok(received, 'nonempty child proof required');
  report.samples = received.samples; report.proof = received.proof;
  if (received.rejectedSample) report.rejectedSample = received.rejectedSample;
  report.failures.push(...received.failures); Object.assign(report.cleanup, received.cleanup);
  assert.ok(report.failures.length === 0, 'worker failures are sticky');
} catch (e) { fail(e); }
finally {
  clearTimeout(deadlineTimer); clearTimeout(killTimer);
  if (child?.pid && alive(-child.pid)) { fail(new Error('owned group survived exit')); kill('SIGKILL'); }
  try { if (directory) rmSync(directory, { recursive: true, force: true }); }
  catch (error) { fail(error); }
  Object.assign(report.cleanup, { childExited: !!report.exit, pidAbsent: !child?.pid || !alive(child.pid),
    groupAbsent: !child?.pid || !alive(-child.pid), pathAbsent: !!directory && !existsSync(directory) });
  report.after = host();
  try { for (const [f, hash] of Object.entries(report.provenance.files ?? {})) assert.equal(sha(join(root, f)), hash, `input changed during campaign: ${f}`); } catch (e) { fail(e); }
  if (report.failures.length === 0 && report.signal === null) {
    report.status = 'passed';
    try { report.validation = checkReport(report); } catch (e) { fail(e); }
  } else report.status = 'failed';
  persist(); closeSync(fd);
  for (const [signal, fn] of Object.entries(handlers)) process.off(signal, fn);
}
process.stderr.write(`${report.status}: ${report.samples.length} exact samples; ${values.out}\n`);
process.exitCode = report.status === 'passed' ? 0 : 1;
