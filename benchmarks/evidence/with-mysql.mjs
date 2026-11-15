import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

// Every allocated path belongs to this invocation, including failed initialization.
const bin = resolve(process.env.EVIDENCE_MYSQL_BIN ?? '/usr/bin');
const root = mkdtempSync(join(tmpdir(), 'turbine-evidence-mysql-'));
const data = join(root, 'data');
const socket = join(root, 'mysql.sock');
const identity = { root, data, socket, ownerUid: process.getuid(), binary: join(bin, 'mysqld'),
  binaryVersion: null, initialized: false, stopped: false, scratchDatabasesRemaining: null, dataRemoved: false };
const save = () => writeFileSync(join(root, 'identity.json'), `${JSON.stringify(identity, null, 2)}\n`);
let initialization, server, child, admin, listener;
let initLog, serverLog;
let interrupted = false;
const interrupt = () => { interrupted = true; child?.kill('SIGTERM'); initialization?.process.kill('SIGTERM'); };
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
function owned(args, log) {
  const process = spawn(identity.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  process.stdout.pipe(log, { end: false }); process.stderr.pipe(log, { end: false });
  const state = { process, exited: false };
  state.done = new Promise((resolveExit) => {
    process.once('error', (error) => { state.error = error; state.exited = true; resolveExit(); });
    process.once('exit', (code, signal) => { state.exit = { code, signal }; state.exited = true; resolveExit(); });
  });
  return state;
}
async function stop(state) {
  if (!state) return;
  if (!state.exited) state.process.kill('SIGTERM');
  const force = setTimeout(() => { if (!state.exited) state.process.kill('SIGKILL'); }, 15000);
  try { await state.done; } finally { clearTimeout(force); }
}
try {
  save();
  console.log(`Disposable MySQL identity and logs: ${root}`);
  assert.equal(statSync(root).uid, process.getuid());
  mkdirSync(data);
  identity.binaryVersion = execFileSync(identity.binary, ['--no-defaults', '--version'], { encoding: 'utf8' }).trim();
  const testFirst = process.argv.includes('--test');
  const outputPaths = process.argv.slice(2).filter((arg) => arg !== '--test');
  assert.ok(outputPaths.length, 'Usage: with-mysql.mjs NEW.json [NEW2.json ...]');
  listener = createServer();
  await new Promise((resolveListen, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolveListen); });
  identity.port = listener.address().port;
  await new Promise((resolveClose) => listener.close(resolveClose));
  initLog = createWriteStream(join(root, 'initialize.log'));
  initialization = owned(['--no-defaults', `--basedir=${dirname(bin)}`, `--datadir=${data}`, '--initialize-insecure'], initLog);
  identity.initializationPid = initialization.process.pid;
  await initialization.done;
  identity.initializationExit = initialization.exit;
  if (initialization.error) throw initialization.error;
  assert.equal(initialization.exit?.code, 0, `MySQL initialization failed; see ${root}/initialize.log`);
  identity.initialized = true;
  if (interrupted) throw new Error('Evidence wrapper interrupted during initialization');
  serverLog = createWriteStream(join(root, 'server.log'));
  server = owned(['--no-defaults', `--basedir=${dirname(bin)}`, `--datadir=${data}`,
    `--socket=${socket}`, `--port=${identity.port}`, '--bind-address=127.0.0.1', '--mysqlx=OFF',
    `--pid-file=${join(root, 'mysqld.pid')}`], serverLog);
  identity.pid = server.process.pid;
  const config = { host: '127.0.0.1', port: identity.port, user: 'root', database: 'mysql', connectTimeout: 1000 };
  const deadline = Date.now() + 30000;
  let readinessError;
  while (!admin) {
    if (server.exited) throw server.error ?? new Error(`Owned MySQL exited before readiness; see ${root}/server.log`);
    if (interrupted || Date.now() > deadline) throw new Error('Owned MySQL startup interrupted or timed out', { cause: readinessError });
    try { admin = await mysql.createConnection(config); }
    catch (error) { readinessError = error; await new Promise((resume) => setTimeout(resume, 100)); }
  }
  identity.actualServerVersion = (await admin.query('SELECT VERSION() AS version'))[0][0].version;
  assert.match(identity.actualServerVersion, /^8\.4\./, 'This wrapper requires a real MySQL 8.4 server');
  if (process.env.EVIDENCE_MYSQL_EXPECTED_VERSION) assert.equal(identity.actualServerVersion, process.env.EVIDENCE_MYSQL_EXPECTED_VERSION,
    'MySQL server does not match the requested exact version');
  save();
  for (const output of [...(testFirst ? [null] : []), ...outputPaths]) {
    if (interrupted) throw new Error('Evidence wrapper interrupted');
    child = spawn(process.execPath, ['--import', fileURLToPath(new URL('./node_modules/tsx/dist/loader.mjs', import.meta.url)),
      ...(output === null ? ['--test', fileURLToPath(new URL('./mysql-live.test.mjs', import.meta.url))]
        : [fileURLToPath(new URL('./run.mjs', import.meta.url)), output])], {
      stdio: 'inherit', env: { ...process.env, EVIDENCE_DISPOSABLE: '1',
        EVIDENCE_MYSQL_ADMIN_URL: `mysql://root@127.0.0.1:${identity.port}/mysql`,
        EVIDENCE_REQUIRE_ENGINES: process.env.EVIDENCE_REQUIRE_ENGINES ?? 'sqlite,mysql' },
    });
    const code = await new Promise((resolveExit, reject) => {
      child.once('error', reject); child.once('exit', (code) => resolveExit(code ?? 1));
    });
    child = undefined;
    if (code !== 0) { process.exitCode = code; break; }
  }
} catch (error) {
  identity.failure = error.message;
  throw error;
} finally {
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  let cleanupError;
  try {
    if (admin) {
      const [rows] = await admin.query("SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE LEFT(SCHEMA_NAME, 17) = 'turbine_evidence_'");
      identity.scratchDatabasesRemaining = rows.map((row) => row.name);
      assert.deepEqual(identity.scratchDatabasesRemaining, [], 'Scratch database cleanup incomplete');
    }
  } catch (error) { cleanupError = error; }
  if (listener?.listening) await new Promise((resolveClose) => listener.close(resolveClose));
  await stop(initialization); await stop(server);
  await admin?.end().catch(() => {});
  initLog?.end(); serverLog?.end();
  identity.stopped = (!initialization || initialization.exited) && (!server || server.exited);
  if (server) identity.exit = server.exit;
  rmSync(data, { recursive: true, force: true });
  for (const path of [socket, `${socket}.lock`, join(root, 'mysqld.pid')]) rmSync(path, { force: true });
  identity.dataRemoved = true;
  save();
  if (cleanupError) throw cleanupError;
  if (server && !identity.failure) assert.equal(identity.exit?.code, 0, 'Owned MySQL did not shut down cleanly; see retained server log');
}
