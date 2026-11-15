import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { treeHashes, fileHash, assertSuccess } from './proof.mjs';
import { owned, stop, deadline, signalGroup, audit } from './lifecycle.mjs';

const here = dirname(fileURLToPath(import.meta.url)), repo = process.cwd();
const [destination, ...args] = process.argv.slice(2);
assert.ok(destination, 'Usage: node benchmarks/mysql-relations/run.mjs NEW.json [--mode=ordinary|no-backslash] [--scale=1..4] [--repetitions=1..10]');
const options = { mode: 'ordinary', scale: 1, repetitions: 1 };
for (const arg of args) {
  const m = /^--(mode|scale|repetitions)=(.+)$/.exec(arg);
  assert.ok(m, `unknown argument ${arg}`);
  options[m[1]] = m[1] === 'mode' ? m[2] : Number(m[2]);
}
assert.ok(['ordinary', 'no-backslash'].includes(options.mode), 'invalid SQL mode');
assert.ok(Number.isInteger(options.scale) && options.scale >= 1 && options.scale <= 4, 'scale must be 1..4');
assert.ok(Number.isInteger(options.repetitions) && options.repetitions >= 1 && options.repetitions <= 10, 'repetitions must be 1..10');
const output = resolve(destination);
// Reserve the destination exclusively up front; the report is written
// through this descriptor at the end, never re-looked-up by path.
let outputFd;
try { outputFd = openSync(output, 'wx'); }
catch (error) { if (error.code === 'EEXIST') assert.fail('destination already exists; refusing to overwrite evidence'); throw error; }
const lockPath = `${output}.lock`;
const reservation = openSync(lockPath, 'wx'); closeSync(reservation);
let root, initialization, server, worker, admin;
const processes = [], signals = [], failures = [];
const identity = { processes, removedPaths: [], port: null };
const report = { format: 'mysql-relations-v1', status: 'failure', options, failures, signals, identity,
  command: [process.execPath, ...process.argv.slice(1)], cwd: repo, startedAt: new Date().toISOString(),
  limits: { initializeMs: 60000, startupMs: 30000, workerMs: 180000, totalMs: 300000, stopTermMs: 5000, stopKillMs: 3000 },
  measurement: 'Each arm includes START TRANSACTION, native commands, result materialization, decoding/stitching and COMMIT. Native auditing includes serialization and hashing of native result arrays inside timing; process-group observation also adds overhead. Setup, seed, introspection, socket counter probe, independent oracle, assertions, final result hashing and provenance are outside timing. Raw and batched fetch all matching children before per-parent slicing. Native rows/decoded JSON bytes are materialized arrays, not wire row bytes. Socket bytes are separately observed. Memory endpoints and lifetime maxRSS are process-local, not a global memory bound. Local shared-machine samples support no performance winner claim.' };
function record(state, role) {
  processes.push(state);
  state.role = role;
  return state;
}
function interrupt(signal) {
  signals.push(signal);
  failures.push(`interrupted by ${signal}`);
  signalGroup(worker ?? server ?? initialization, 'SIGTERM');
}
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
const totalTimer = setTimeout(() => {
  failures.push('total deadline'); signalGroup(worker ?? server ?? initialization, 'SIGTERM');
}, report.limits.totalMs);
try {
  assert.equal(JSON.parse(readFileSync(join(repo, 'package.json'))).name, 'turbine-orm', 'run from repository root');
  const require = createRequire(join(repo, 'package.json'));
  const mysql = require('mysql2/promise');
  const bin = resolve(process.env.MYSQL_RELATIONS_PREFIX ?? '/usr/local/mysql');
  const executable = join(bin, 'bin/mysqld');
  const env = { ...process.env, NODE_OPTIONS: '', LD_LIBRARY_PATH: process.env.MYSQL_RELATIONS_LIBRARIES ?? process.env.LD_LIBRARY_PATH ?? '' };
  const version = execFileSync(executable, ['--no-defaults', '--version'], { encoding: 'utf8', timeout: 10000, env }).trim();
  assert.match(version, /Ver 8\.4\.0\b/, 'requires exact MySQL8.4.0 binary');
  root = mkdtempSync(join(tmpdir(), 'mysql-relations-'));
  const data = join(root, 'data'), socket = join(root, 'mysql.sock');
  identity.root = root; identity.data = data; identity.socket = socket;
  identity.removedPaths = [root, data, socket, `${socket}.lock`, join(root, 'mysqld.pid')];
  report.provenance = { harness: treeHashes(here), source: treeHashes(join(repo, 'src')),
    lock: { path: join(repo, 'package-lock.json'), sha256: fileHash(join(repo, 'package-lock.json')) },
    git: { head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
      status: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }).trim() },
    binary: { path: executable, version, sha256: fileHash(executable) } };
  const listener = createServer();
  await new Promise((resolveListen, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolveListen); });
  identity.port = listener.address().port;
  await new Promise((resolveClose) => listener.close(resolveClose));
  initialization = record(owned(executable, ['--no-defaults', `--basedir=${bin}`, `--datadir=${data}`, '--initialize-insecure'], { env }), 'initialize');
  await deadline(initialization.done, report.limits.initializeMs, 'MySQL initialize', () => signalGroup(initialization, 'SIGTERM'));
  assert.equal(initialization.code, 0, `initialize failed: ${initialization.stderr}`);
  assert.equal(signals.length, 0, 'interrupted initialization');
  const sqlMode = `STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION${options.mode === 'no-backslash' ? ',NO_BACKSLASH_ESCAPES' : ''}`;
  server = record(owned(executable, ['--no-defaults', `--basedir=${bin}`, `--datadir=${data}`, `--socket=${socket}`,
    `--port=${identity.port}`, '--bind-address=127.0.0.1', '--mysqlx=OFF', `--pid-file=${join(root, 'mysqld.pid')}`, `--sql-mode=${sqlMode}`], { env }), 'server');
  const start = Date.now();
  while (!admin) {
    assert.equal(signals.length, 0, 'interrupted startup');
    assert.ok(!server.exited && Date.now() - start < report.limits.startupMs, `owned service startup failed: ${server.stderr}`);
    try { admin = await mysql.createConnection({ socketPath: socket, user: 'root', connectTimeout: 1000 }); }
    catch { await new Promise((resume) => setTimeout(resume, 50)); }
  }
  identity.adminBackend = admin.threadId;
  await admin.query('CREATE DATABASE relations');
  await admin.end(); admin = undefined;
  worker = record(owned(process.execPath, ['--import', require.resolve('tsx/esm'), join(here, 'worker.mjs')], {
    env: { ...env, MYSQL_RELATIONS_SOCKET: socket, MYSQL_RELATIONS_MODE: options.mode,
      MYSQL_RELATIONS_SCALE: String(options.scale), MYSQL_RELATIONS_REPETITIONS: String(options.repetitions) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }), 'worker');
  worker.child.on('message', (message) => {
    if (message.stage === 'complete') report.proof = message.proof;
    if (message.stage === 'prerequisites-passed') console.log(JSON.stringify({ stage: message.stage, fixture: message.fixture, legacy: message.legacy }));
  });
  await deadline(worker.done, report.limits.workerMs, 'native workload', () => signalGroup(worker, 'SIGTERM'));
  assert.equal(worker.code, 0, `native worker failed: ${worker.stderr}`);
  assert.equal(signals.length, 0, 'interrupted workload');
  assert.ok(report.proof, 'native worker exited without proof');
} catch (error) { failures.push(error.message); }
finally {
  clearTimeout(totalTimer);
  if (admin) await deadline(admin.end(), 2000, 'admin close').catch((e) => failures.push(e.message));
  for (const state of [worker, server, initialization]) {
    try { await stop(state); } catch (e) { failures.push(e.message); }
  }
  if (server && server.code !== 0) failures.push(`server exit ${server.code}, signal ${server.signal}`);
  try { if (root) rmSync(root, { recursive: true, force: true }); }
  catch (e) { failures.push(`owned path removal: ${e.message}`); }
  identity.processes = processes.map(({ role, pid, identity: processIdentity, code, signal, error, command, args, members, observed }) =>
    ({ role, pid, identity: processIdentity, code, signal, error, command, args, members, observed }));
  report.logs = processes.map(({ role, stdout, stderr }) => ({ role, stdout, stderr }));
  try { report.cleanup = await audit(identity); }
  catch (e) { report.cleanup = { complete: false, error: e.message }; }
  if (!report.cleanup.complete) failures.push('independent cleanup audit incomplete');
  report.status = failures.length === 0 ? 'success' : 'failure';
  if (report.status === 'success') {
    try { assertSuccess(report); } catch (e) { failures.push(e.message); report.status = 'failure'; }
  }
  report.finishedAt = new Date().toISOString();
  try { writeFileSync(outputFd, `${JSON.stringify(report, null, 2)}\n`); }
  finally { try { closeSync(outputFd); } finally { rmSync(lockPath, { force: true }); } }
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
}
console.log(JSON.stringify({ output, status: report.status, cases: report.proof?.cases.length ?? 0, failures }));
if (report.status !== 'success') process.exitCode = 1;
