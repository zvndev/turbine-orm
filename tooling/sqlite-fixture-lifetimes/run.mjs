/** Run a no-network source audit without coverage collection or hidden cleanup success. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
if (outIndex < 0 || !args[outIndex + 1]) throw new Error('Usage: node run.mjs --out NEW_DIRECTORY [--allow-unsupported] [-- TEST_FILES...]');
const out = resolve(args[outIndex + 1]);
// Refuse reuse: stale records must never satisfy completeness checks.
mkdirSync(out);
const records = resolve(out, 'processes');
mkdirSync(records);
const separator = args.indexOf('--');
const files = separator < 0 ? readdirSync('src/test').filter((f) => f.endsWith('.test.ts')).sort().map((f) => `src/test/${f}`) : args.slice(separator + 1);
if (!files.length) throw new Error('No source test files selected');
const observer = fileURLToPath(new URL('./observe.mjs', import.meta.url));
const runtimeFlags = process.execArgv.filter((arg) => arg === '--experimental-sqlite');
const argv = [...runtimeFlags, '--import', observer, '--import', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=4', ...files];
const logPath = resolve(out, 'tests.log');
const log = openSync(logPath, 'w+');
const env = { ...process.env, DATABASE_URL: '', MYSQL_URL: '', MYSQL_TEST_URL: '', MSSQL_URL: '', POWDB_URL: '',
  TURBINE_SQLITE_LIFETIME_REPORT: records };
delete env.NODE_TEST_CONTEXT;
delete env.NODE_V8_COVERAGE;
const child = spawn(process.execPath, argv, { env, stdio: ['ignore', log, log], detached: true });
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const inputHashes = { observer: hash(observer), runner: hash(fileURLToPath(import.meta.url)), files: Object.fromEntries(files.map((file) => [file, hash(file)])) };
const identity = { inputHashes, pid: process.pid, ppid: process.ppid, childPid: child.pid, execPath: process.execPath, node: process.version, cwd: process.cwd(), argv, files, started: new Date().toISOString() };
writeFileSync(resolve(out, 'command.json'), `${JSON.stringify(identity, null, 2)}\n`);
let timedOut = false;
// A hang guard, not a budget: the whole observed suite takes 8.5 to 10 minutes on CI runners.
const timer = setTimeout(() => { timedOut = true; process.kill(-child.pid, 'SIGKILL'); }, 1_200_000);
const forward = (signal) => { try { process.kill(-child.pid, signal); } catch {} };
const interrupt = () => forward('SIGINT');
const terminate = () => forward('SIGTERM');
process.once('SIGINT', interrupt);
process.once('SIGTERM', terminate);
const result = await new Promise((done) => {
  child.once('error', (error) => done({ error: error.message }));
  child.once('close', (status, signal) => done({ status, signal }));
});
clearTimeout(timer);
process.removeListener('SIGINT', interrupt);
process.removeListener('SIGTERM', terminate);
// Read the log back through the descriptor that wrote it, then close it.
const logSize = fstatSync(log).size;
const logBytes = Buffer.alloc(logSize);
let logRead = 0;
while (logRead < logSize) {
  const n = readSync(log, logBytes, logRead, logSize - logRead, logRead);
  if (!n) break;
  logRead += n;
}
const logText = logBytes.toString('utf8', 0, logRead);
closeSync(log);
const allReports = readdirSync(records).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(resolve(records, f), 'utf8')));
const reports = allReports.filter((r) => r.ppid === child.pid);
const additionalReports = allReports.filter((r) => r.ppid !== child.pid);
const missing = files.filter((file) => !reports.some((r) => r.complete && r.argv.slice(1).some((arg) => resolve(arg) === resolve(file))));
const counts = Object.fromEntries(['constructed', 'opened', 'observedClosed', 'leaked', 'cleanupClosed', 'remaining'].map((key) => [key, reports.reduce((sum, r) => sum + r[key], 0)]));
counts.cleanupFailures = reports.reduce((sum, r) => sum + r.cleanupFailures.length, 0);
const incomplete = reports.filter((r) => !r.complete).map((r) => r.pid);
const unsupported = reports.filter((r) => !r.supported).map((r) => r.pid);
const failedTap = logText.split('\n').filter((line) => /^\s*not ok \d+\b/.test(line));
const allowUnsupported = args.includes('--allow-unsupported');
const nativeCovered = !unsupported.length && counts.opened > 0;
const unavailable = reports.length === files.length && unsupported.length === reports.length;
const ok = result.status === 0 && !failedTap.length && !timedOut && !missing.length && !incomplete.length && !counts.leaked && !counts.cleanupFailures && !counts.remaining && counts.opened === counts.observedClosed &&
  (nativeCovered || (allowUnsupported && unavailable));
const summary = { ...identity, finished: new Date().toISOString(), ...result, timedOut, ok,
  outcome: ok ? (unsupported.length ? 'unsupported' : 'pass') : 'fail', allowUnsupported,
  processCount: reports.length, additionalReports, failedTap, counts, missing, incomplete, unsupported, logPath };
writeFileSync(resolve(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
if (!ok) {
  console.error(logText.split('\n').slice(-70).join('\n'));
  process.exitCode = 1;
}
