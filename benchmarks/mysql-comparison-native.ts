/** Disposable exact MySQL 8.4.0 supervisor. It runs correctness only by default. */
import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Connection, createConnection } from 'mysql2/promise';
// @ts-expect-error Existing JavaScript supervision helper; exercised by native cleanup controls.
import { groupAlive, stopOwned } from './mysql-preparation/native.mjs';
import { mysqlProcessSnapshot, auditMysqlProcesses } from './mysql-comparison-cleanup.js';
import { installedIdentity, timingAdmission } from './mysql-comparison-provenance.js';

interface Owned {
  role: string;
  command: string[];
  pid: number;
  group: number;
  exited: boolean;
  code: number | null;
  signal: string | null;
  child: ChildProcess;
  done: Promise<void>;
  log: string;
  startIdentity: ReturnType<typeof mysqlProcessSnapshot>;
}
const destination = process.argv[2];
const benchmarkDirectory = fileURLToPath(new URL('.', import.meta.url));
assert.ok(
  destination,
  'usage: node --import tsx benchmarks/mysql-comparison-native.ts NEW.json [--mode=ordinary|no-backslash] [--controls] [--timing]',
);
const output = resolve(destination);
const args = new Set(process.argv.slice(3));
for (const arg of args)
  assert.ok(
    ['--mode=ordinary', '--mode=no-backslash', '--controls', '--timing'].includes(arg),
    `unknown option ${arg}`,
  );
assert.ok(!(args.has('--mode=ordinary') && args.has('--mode=no-backslash')), 'choose one SQL mode');
const timing = args.has('--timing');
const nativeFault = process.env.MYSQL_COMPARISON_NATIVE_FAULT;
assert.ok(
  !nativeFault || ['setup', 'cleanup', 'signal-cleanup'].includes(nativeFault),
  'unknown native failure control',
);
assert.ok(!nativeFault || !timing, 'native failure controls require correctness-only mode');
assert.ok(
  !timing || process.env.MYSQL_COMPARISON_SERIALIZED === '1',
  'timing requires serial execution and MYSQL_COMPARISON_SERIALIZED=1',
);
const mode = args.has('--mode=no-backslash') ? 'no-backslash' : 'ordinary';
const prefix = process.env.MYSQL_COMPARISON_PREFIX;
assert.ok(prefix, 'MYSQL_COMPARISON_PREFIX must name the local MySQL installation.');
const libraries = process.env.MYSQL_COMPARISON_LIBRARIES ?? '';
const binary = join(prefix, 'bin/mysqld');
const env = { ...process.env, LD_LIBRARY_PATH: libraries, NODE_OPTIONS: '' };
// Reserve the report exclusively once the cheap admissions pass; every
// update below rewrites it through this descriptor, never by path.
let outputFd: number;
try {
  outputFd = openSync(output, 'wx+');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'EEXIST') assert.fail('refusing to overwrite native report');
  throw error;
}
const installed = installedIdentity();
const admittedPreflight = timing
  ? timingAdmission(process.env.MYSQL_COMPARISON_PREFLIGHT, installed.artifact.sha256!, mode, benchmarkDirectory)
  : null;
const root = mkdtempSync(join(process.env.MYSQL_COMPARISON_SCRATCH ?? tmpdir(), 'mysql-comparison-'));
const data = join(root, 'data'),
  socket = join(root, 'mysql.sock');
mkdirSync(data);
const logDir = `${output}.logs`;
mkdirSync(logDir, { recursive: false });
const processes: Owned[] = [];
const failures: string[] = [];
const identity: Record<string, unknown> = {
  root,
  data,
  socket,
  output,
  logDir,
  ownerUid: process.getuid?.(),
  mode,
  binary,
  startedAt: new Date().toISOString(),
  runnerPid: process.pid,
};
const report: Record<string, unknown> = {
  format: 'mysql-comparison-native-v1',
  status: 'failure',
  identity,
  failures,
  comparativeClaim: false,
  timing,
  nativeFault,
  installed,
  admittedPreflight,
  command: [process.execPath, ...process.argv.slice(1)],
  skipped: timing ? [] : ['comparative timing: run serially on an idle machine using the tested artifact'],
};
const writeReport = () => {
  const bytes = Buffer.from(JSON.stringify(report, null, 2) + '\n');
  ftruncateSync(outputFd, 0);
  let written = 0;
  while (written < bytes.length) written += writeSync(outputFd, bytes, written, bytes.length - written, written);
};
let admin: Connection | undefined;
let interrupted = false;
let port: number | undefined;
const signal = (p: Owned, sig: NodeJS.Signals) => {
  if (groupAlive(p.group))
    try {
      const current = mysqlProcessSnapshot(p.pid);
      if (current && p.startIdentity)
        assert.equal(current.starttime, p.startIdentity.starttime, 'owned PID identity changed; refusing signal');
      process.kill(-p.group, sig);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
};
function interrupt(sig: NodeJS.Signals) {
  interrupted = true;
  failures.push(`interrupted ${sig}`);
  // Let the active client restore fixtures before stopping its private server.
  for (const p of [...processes].reverse()) if (p.role !== 'server') signal(p, 'SIGTERM');
}
process.on('SIGTERM', interrupt);
process.on('SIGINT', interrupt);
function owned(role: string, cmd: string, argv: string[], extra: Record<string, string | undefined> = {}) {
  assert.ok(!interrupted, 'interrupted before owned process launch');
  const log = join(logDir, `${role}.log`);
  const fd = openSync(log, 'wx');
  const child = spawn(cmd, argv, {
    cwd: benchmarkDirectory,
    env: { ...env, ...extra },
    stdio: ['ignore', fd, fd],
    detached: true,
  });
  closeSync(fd);
  const state: Owned = {
    role,
    command: [cmd, ...argv],
    child,
    pid: child.pid ?? 0,
    group: child.pid ?? 0,
    exited: false,
    code: null,
    signal: null,
    log,
    startIdentity: child.pid ? mysqlProcessSnapshot(child.pid) : null,
    done: Promise.resolve(),
  };
  state.done = new Promise<void>((done) => {
    child.once('error', (error) => {
      state.exited = true;
      failures.push(`${role} spawn: ${String(error)}`);
      done();
    });
    child.once('exit', (code, sig) => {
      state.code = code;
      state.signal = sig;
      state.exited = true;
      done();
    });
  });
  processes.push(state);
  identity.processes = processes.map(({ child, done, ...p }) => p);
  writeReport();
  return state;
}
async function bounded(p: Owned, ms: number) {
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    failures.push(`${p.role} deadline ${ms}ms`);
    signal(p, 'SIGTERM');
    killTimer = setTimeout(() => signal(p, 'SIGKILL'), 5000);
  }, ms);
  try {
    await p.done;
    assert.ok(!interrupted, 'interrupted native comparison');
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
  }
}
async function stop(p: Owned) {
  const current = mysqlProcessSnapshot(p.pid);
  if (current && p.startIdentity)
    assert.equal(current.starttime, p.startIdentity.starttime, 'owned PID identity changed; refusing signal');
  await stopOwned({ process: p.child, done: p.done }, 5000);
}

const binHash = () => createHash('sha256').update(readFileSync(binary)).digest('hex');
try {
  identity.binaryVersion = execFileSync(binary, ['--no-defaults', '--version'], {
    env,
    encoding: 'utf8',
    timeout: 10000,
  }).trim();
  assert.match(String(identity.binaryVersion), /Ver 8\.4\.0\b/);
  identity.binarySha256 = binHash();
  const linkedLibraries = execFileSync('ldd', [binary], { env, encoding: 'utf8', timeout: 10000 });
  identity.linkedLibraries = linkedLibraries;
  identity.linkedLibraryHashes = Object.fromEntries(
    [...new Set(linkedLibraries.match(/\/[^\s()]+/g) ?? [])]
      .filter((path) => existsSync(path))
      .map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]),
  );
  const reserve = createServer();
  await new Promise<void>((r, j) => {
    reserve.once('error', j);
    reserve.listen(0, '127.0.0.1', r);
  });
  port = (reserve.address() as { port: number }).port;
  await new Promise<void>((r) => reserve.close(() => r()));
  identity.port = port;
  writeReport();
  console.log(JSON.stringify({ stage: 'owned-service-announcement-before-initialize', root, port, output, binary }));
  if (nativeFault === 'setup') throw new Error('forced native setup reporting fault');
  const init = owned('initialize', binary, [
    '--no-defaults',
    `--basedir=${prefix}`,
    `--datadir=${data}`,
    '--initialize-insecure',
  ]);
  await bounded(init, 60000);
  assert.equal(init.code, 0, `initialize failed; see ${init.log}`);
  const sqlMode = `ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION${mode === 'no-backslash' ? ',NO_BACKSLASH_ESCAPES' : ''}`;
  const server = owned('server', binary, [
    '--no-defaults',
    `--basedir=${prefix}`,
    `--datadir=${data}`,
    `--socket=${socket}`,
    `--port=${port}`,
    '--bind-address=127.0.0.1',
    '--mysqlx=OFF',
    `--pid-file=${join(root, 'mysqld.pid')}`,
    `--sql-mode=${sqlMode}`,
  ]);
  const until = Date.now() + 30000;
  while (!admin) {
    assert.ok(!server.exited && !interrupted && Date.now() < until, `startup failed; see ${server.log}`);
    try {
      admin = await createConnection({ socketPath: socket, user: 'root', connectTimeout: 500 });
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const database = `mysql_comparison_${process.pid}`;
  identity.database = database;
  identity.adminConnectionId = admin.threadId;
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
  const childEnv = {
    MYSQL_COMPARISON_URL: `mysql://root@127.0.0.1:${port}/${database}`,
    MYSQL_COMPARISON_MODE: mode,
    MYSQL_COMPARISON_OWNED: '1',
  };
  const loader = join(benchmarkDirectory, 'node_modules/tsx/dist/loader.mjs');
  const seed = owned(
    'seed',
    process.execPath,
    ['--import', loader, join(benchmarkDirectory, 'mysql-seed.ts')],
    childEnv,
  );
  await bounded(seed, 120000);
  assert.equal(seed.code, 0, `seed failed; see ${seed.log}`);
  const result = `${output}.comparison.json`;
  const run = owned(
    'preflight',
    process.execPath,
    ['--import', loader, join(benchmarkDirectory, 'bench-mysql.ts'), ...(timing ? [] : ['--verify-only'])],
    { ...childEnv, MYSQL_COMPARISON_OUTPUT: result },
  );
  await bounded(run, timing ? 3600000 : 240000);
  report.comparisonReport = result;
  if (existsSync(result)) report.comparison = JSON.parse(readFileSync(result, 'utf8'));
  assert.equal(run.code, 0, `comparison failed; see ${run.log}`);
  assert.equal((report.comparison as Record<string, unknown>).status, 'pass');
  if (args.has('--controls')) {
    const controls: Record<string, unknown>[] = [];
    report.controls = controls;
    for (const [fault, pattern] of [
      ['scalar', 'exact result mismatch'],
      ['stream-drop', 'observed stream completeness'],
      ['write-effect', 'write effect'],
      ['catalog-omit', 'complete 47-entry catalog'],
      ['arm-omit', 'complete five-arm roster'],
      ['seed-volume', 'SEED MISMATCH comments'],
      ['cleanup', 'forced cleanup reporting fault'],
      ['signal', 'interrupted SIGTERM'],
    ] as const) {
      const control = owned(
        `control-${fault}`,
        process.execPath,
        ['--import', loader, join(benchmarkDirectory, 'bench-mysql.ts'), '--verify-only'],
        {
          ...childEnv,
          MYSQL_COMPARISON_FAULT: fault,
          MYSQL_COMPARISON_OUTPUT: `${output}.control-${fault}.json`,
          GROUPS: 'headline',
        },
      );
      await bounded(control, 180000);
      controls.push({
        fault,
        code: control.code,
        signal: control.signal,
        log: control.log,
        expected: pattern,
        report: existsSync(`${output}.control-${fault}.json`)
          ? JSON.parse(readFileSync(`${output}.control-${fault}.json`, 'utf8'))
          : null,
      });
      assert.notEqual(control.code, 0, `control ${fault} unexpectedly passed`);
      assert.match(readFileSync(control.log, 'utf8'), new RegExp(pattern));
      const controlReport = JSON.parse(readFileSync(`${output}.control-${fault}.json`, 'utf8'));
      assert.equal(controlReport.status, 'failure');
      assert.ok(
        controlReport.cleanup.backendAllocated === false ||
          (controlReport.cleanup.fixtureRestored && controlReport.cleanup.oracleClosed),
        `control ${fault} cleanup incomplete`,
      );
    }
    // Repeat admission after destructive controls proves their restoration.
    const repeatResult = `${output}.repeat.json`;
    const repeat = owned(
      'repeat-admission',
      process.execPath,
      ['--import', loader, join(benchmarkDirectory, 'bench-mysql.ts'), '--verify-only'],
      { ...childEnv, MYSQL_COMPARISON_OUTPUT: repeatResult, MYSQL_COMPARISON_FAULT: '' },
    );
    await bounded(repeat, 240000);
    report.repeat = existsSync(repeatResult) ? JSON.parse(readFileSync(repeatResult, 'utf8')) : null;
    assert.equal(repeat.code, 0, 'repeat admission failed');
  }
  await admin.query(`DROP DATABASE \`${database}\``);
  identity.databaseDropped = true;
  const [remaining] = await admin.execute(
    'SELECT ID FROM information_schema.PROCESSLIST WHERE ID <> CONNECTION_ID() AND USER = ?',
    ['root'],
  );
  assert.equal((remaining as unknown[]).length, 0, 'private service has leftover connections');
  identity.remainingConnections = remaining;
  report.status = 'pass';
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  try {
    await admin?.end();
    identity.adminClosed = true;
  } catch (error) {
    failures.push(String(error));
  }
  for (const p of [...processes].reverse())
    try {
      if (nativeFault === 'signal-cleanup' && p.role === 'server') process.kill(process.pid, 'SIGTERM');
      await stop(p);
    } catch (error) {
      failures.push(String(error));
    }
  identity.cleanupAuditBeforeRemoval = auditMysqlProcesses(
    processes.map((p) => p.startIdentity).filter((p): p is NonNullable<typeof p> => p !== null),
    data,
  );
  if (
    !(identity.cleanupAuditBeforeRemoval as { remaining: unknown[] }).remaining.length &&
    processes.every((p) => !groupAlive(p.group))
  )
    rmSync(root, { recursive: true, force: true });
  else failures.push('owned descendants or data users remain; refusing storage removal');
  identity.rootRemoved = !existsSync(root);
  identity.cleanupAudit = auditMysqlProcesses(
    processes.map((p) => p.startIdentity).filter((p): p is NonNullable<typeof p> => p !== null),
    data,
  );
  identity.processes = processes.map(({ child, done, ...p }) => p);
  const alive = [];
  for (const p of processes) {
    try {
      process.kill(-p.group, 0);
      alive.push(p.group);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failures.push(String(error));
    }
  }
  identity.remainingProcessGroups = alive;
  identity.portClosed =
    port === undefined ||
    (await new Promise<boolean>((done) => {
      const s = connect({ host: '127.0.0.1', port: port! });
      s.once('connect', () => {
        s.destroy();
        done(false);
      });
      s.once('error', () => done(true));
      s.setTimeout(1000, () => {
        s.destroy();
        done(false);
      });
    }));
  if (nativeFault === 'cleanup') failures.push('forced native cleanup reporting fault after actual cleanup');
  if (alive.length || !identity.portClosed || !identity.rootRemoved || failures.length) {
    report.status = 'failure';
    process.exitCode = 1;
  }
  identity.finishedAt = new Date().toISOString();
  writeReport();
  closeSync(outputFd);
  process.off('SIGTERM', interrupt);
  process.off('SIGINT', interrupt);
  console.log(
    JSON.stringify({
      status: report.status,
      mode,
      output,
      failures,
      cleanup: { rootRemoved: identity.rootRemoved, remainingGroups: alive, portClosed: identity.portClosed },
    }),
  );
}
