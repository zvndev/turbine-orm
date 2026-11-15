// Required local workflow. Never borrows a host database, service, config or credential.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ownedPostgres } from '../../../../tooling/native-consumer-contracts/postgres-service.mjs';
import { poolerRelay } from './relay.mjs';
import { assertContractEvidence } from './reporter.mjs';

const cwd = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const fixture = fileURLToPath(new URL('.', import.meta.url));
assert.ok(process.env.PG_POOLER_EVIDENCE, 'PG_POOLER_EVIDENCE required');
const output = resolve(process.env.PG_POOLER_EVIDENCE);
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(output, 'owned-'));
const report = {
  scope: 'local PG18.6 + real PgBouncer + WS byte relay; source and unmodified installed archive',
  root,
  runtime: process.version,
  commands: [],
  services: [],
  failures: [],
};
const stops = [];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
let active;
let interrupted;
function stopChild(signal) {
  if (!active?.pid) return;
  try {
    process.kill(-active.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
function group(pid) {
  try {
    return Number(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[2]);
  } catch {
    return null;
  }
}
function gone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}
function persist() {
  writeFileSync(join(output, 'native-report.json'), JSON.stringify(report, null, 2));
}
function checkSignal() {
  if (interrupted) throw new Error(`Interrupted by ${interrupted}`);
}
const handlers = Object.fromEntries(
  ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [
    signal,
    () => {
      interrupted = signal;
      stopChild('SIGTERM');
    },
  ]),
);
for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
function run(dir, binary, args) {
  checkSignal();
  const result = spawnSync(binary, args, { cwd: dir, env: process.env, encoding: 'utf8', timeout: 30_000 });
  report.commands.push({
    binary,
    args,
    cwd: dir,
    pid: result.pid,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}
async function child(label, binary, args, env, failure) {
  checkSignal();
  const path = join(output, `${label}.log`);
  const fd = openSync(path, 'w+');
  const proc = spawn(binary, args, {
    cwd: env.PG_POOLER_CONSUMER || cwd,
    env,
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  active = proc;
  const record = {
    label,
    binary,
    args,
    cwd: env.PG_POOLER_CONSUMER || cwd,
    pid: proc.pid,
    pgid: group(proc.pid),
    ownsProcessGroup: true,
    log: path,
  };
  report.commands.push(record);
  persist();
  const closed = new Promise((accept, reject) => {
    proc.once('error', reject);
    proc.once('close', (code, signal) => accept({ code, signal }));
  });
  let killTimer;
  const timer = setTimeout(() => {
    stopChild('SIGTERM');
    killTimer = setTimeout(() => stopChild('SIGKILL'), 5000);
  }, 90_000);
  try {
    const status = await closed;
    Object.assign(record, status);
    record.pidGone = gone(proc.pid);
    record.groupGone = gone(-proc.pid);
    assert.equal(record.groupGone, true, 'all command children must exit before proceeding');
    checkSignal();
    const bytes = Buffer.alloc(fstatSync(fd).size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      assert.ok(count > 0, 'Child log truncated while reading');
      offset += count;
    }
    const log = bytes.toString('utf8');
    if (failure) {
      assert.notEqual(status.code, 0);
      assert.match(log, failure);
    } else {
      assert.equal(status.code, 0, log);
      if (label.startsWith('source-') || label.startsWith('installed-v'))
        record.contractEvidence = assertContractEvidence(log);
    }
  } finally {
    closeSync(fd);
    clearTimeout(timer);
    clearTimeout(killTimer);
    // Keep the detached group's ownership after its leader exits. Detecting an
    // orphan must fail admission AND reap the orphan before dropping the handle.
    try {
      for (const [signal, grace] of [
        ['SIGTERM', 1000],
        ['SIGKILL', 3000],
      ]) {
        if (!proc.pid || gone(-proc.pid)) break;
        record.termination ??= [];
        record.termination.push({ pgid: proc.pid, signal });
        stopChild(signal);
        const deadline = Date.now() + grace;
        while (!gone(-proc.pid) && Date.now() < deadline) await delay(25);
      }
      record.groupGoneAfterCleanup = !proc.pid || gone(-proc.pid);
      assert.ok(record.groupGoneAfterCleanup, 'owned command group survived bounded cleanup');
    } finally {
      active = undefined;
      persist();
    }
  }
}
async function unusedPort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((accept) => probe.close(accept));
  return port;
}
async function closedPort(port) {
  return new Promise((accept) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      accept(false);
    });
    socket.once('error', (error) => {
      socket.destroy();
      accept(error.code === 'ECONNREFUSED');
    });
    socket.setTimeout(1000, () => {
      socket.destroy();
      accept(false);
    });
  });
}
try {
  const env = { ...process.env, TZ: 'UTC', TURBINE_REQUIRE_ENGINE: 'pgbouncer' };
  for (const name of [
    'PG_PREFIX',
    'PG_POOLER_BINARY',
    'PG_POOLER_ARCHIVE',
    'PG_POOLER_NODE22',
    'PG_POOLER_NODE24',
    'PG_POOLER_NPM_CLI',
  ])
    assert.ok(env[name], `${name} required`);
  assert.equal(run(root, join(env.PG_PREFIX, 'bin/postgres'), ['--version']), 'postgres (PostgreSQL) 18.6');
  const binaryVersion = run(root, env.PG_POOLER_BINARY, ['--version']);
  assert.match(binaryVersion, /^PgBouncer 1\.26\.1\b/);
  report.pgbouncer = {
    binary: env.PG_POOLER_BINARY,
    version: binaryVersion,
    sha256: hash(readFileSync(env.PG_POOLER_BINARY)),
  };
  report.archive = { path: resolve(env.PG_POOLER_ARCHIVE), sha256: hash(readFileSync(env.PG_POOLER_ARCHIVE)) };
  if (env.PG_POOLER_SHA256) {
    assert.match(env.PG_POOLER_SHA256, /^[a-f0-9]{64}$/, 'Archive pin must be a lowercase SHA256.');
    assert.equal(report.archive.sha256, env.PG_POOLER_SHA256, 'Archive differs from the tested package.');
    report.archive.expectedSha256 = env.PG_POOLER_SHA256;
  }
  const runtimes = [
    [env.PG_POOLER_NODE22, 'v22.16.0'],
    [env.PG_POOLER_NODE24, 'v24.10.0'],
  ];
  for (const [binary, version] of runtimes) assert.equal(run(root, binary, ['--version']), version);
  const reporterArg = `--test-reporter=${join(fixture, 'reporter.mjs')}`;
  const sourceArgs = [
    '--import',
    'tsx',
    '--test',
    reporterArg,
    '--test-concurrency=1',
    'src/test/optional-pg-pooler.test.ts',
  ];
  const missing = {
    ...env,
    PG_POOLER_SESSION_URL: '',
    PG_POOLER_TRANSACTION_URL: '',
    PG_POOLER_DIRECT_URL: '',
    PG_POOLER_ADMIN_URL: '',
  };
  for (const [binary, version] of runtimes)
    await child(`missing-services-${version}`, binary, sourceArgs, missing, /precondition is unmet/);
  const pgService = await ownedPostgres({
    root,
    env,
    run,
    driver: pg,
    report,
    registerStop: (stop) => stops.push(stop),
  });
  const pgIdentity = report.services[0];
  Object.assign(pgIdentity, { pgid: group(pgIdentity.pid), ownsProcessGroup: false });
  report.backgroundPids = (await pgService.client.query('SELECT pid, backend_type FROM pg_stat_activity')).rows;
  await pgService.client.query('CREATE DATABASE pooler_contract');
  const direct = pgService.url.replace('/postgres', '/pooler_contract');
  const port = await unusedPort();
  const ini = join(root, 'pgbouncer.ini');
  const users = join(root, 'users.txt');
  writeFileSync(users, '"contract" ""\n');
  writeFileSync(
    ini,
    `[databases]\nsession_contract = host=127.0.0.1 port=${pgIdentity.port} dbname=pooler_contract user=contract pool_mode=session pool_size=1\ntransaction_contract = host=127.0.0.1 port=${pgIdentity.port} dbname=pooler_contract user=contract pool_mode=transaction pool_size=2\n[pgbouncer]\nlisten_addr=127.0.0.1\nlisten_port=${port}\nunix_socket_dir=\nauth_type=trust\nauth_file=${users}\nadmin_users=contract\nmax_client_conn=30\ndefault_pool_size=1\nreserve_pool_size=0\nmax_prepared_statements=0\nserver_reset_query=DISCARD ALL\nserver_reset_query_always=0\nserver_idle_timeout=0\nserver_lifetime=3600\nquery_wait_timeout=8\nlogfile=${join(root, 'pgbouncer.log')}\npidfile=${join(root, 'pgbouncer.pid')}\n`,
  );
  const log = openSync(join(output, 'pgbouncer-stderr.log'), 'w');
  const bouncer = spawn(env.PG_POOLER_BINARY, [ini], { detached: true, stdio: ['ignore', log, log] });
  closeSync(log);
  const stopped = new Promise((accept) => bouncer.once('close', (code, signal) => accept({ code, signal })));
  let startError;
  bouncer.on('error', (error) => {
    startError = error;
  });
  const bouncerIdentity = {
    engine: 'pgbouncer',
    pid: bouncer.pid,
    pgid: group(bouncer.pid),
    ownsProcessGroup: true,
    port,
    ini,
    config: readFileSync(ini, 'utf8'),
  };
  report.services.push(bouncerIdentity);
  stops.push(async () => {
    if (bouncer.exitCode === null && bouncer.signalCode === null) {
      assert.ok(
        readFileSync(`/proc/${bouncer.pid}/cmdline`, 'utf8').includes(ini),
        'owned config identity required before termination',
      );
      bouncer.kill('SIGTERM');
    }
    const done = await Promise.race([stopped, delay(10_000, null, { ref: false })]);
    if (!done) {
      bouncer.kill('SIGKILL');
      await stopped;
    }
    bouncerIdentity.stopped = true;
    bouncerIdentity.log = readFileSync(join(root, 'pgbouncer.log'), 'utf8');
  });
  persist();
  let admin;
  for (let attempt = 0; attempt < 100; attempt++) {
    checkSignal();
    if (startError) throw startError;
    assert.equal(bouncer.exitCode, null, 'PgBouncer exited before ready');
    const candidate = new pg.Client({
      connectionString: `postgresql://contract@127.0.0.1:${port}/pgbouncer`,
      connectionTimeoutMillis: 500,
    });
    try {
      await candidate.connect();
      admin = candidate;
      break;
    } catch {
      await candidate.end();
      await delay(50);
    }
  }
  assert.ok(admin, 'PgBouncer did not become ready');
  stops.push(() => admin.end());
  const relay = await poolerRelay(port);
  const relayIdentity = {
    engine: 'ws-byte-relay',
    pid: process.pid,
    pgid: group(process.pid),
    ownsProcessGroup: false,
    port: relay.port,
    targetPort: port,
  };
  report.services.push(relayIdentity);
  stops.push(async () => {
    await relay.close();
    relayIdentity.stopped = true;
    relayIdentity.routes = relay.routes;
  });
  Object.assign(env, {
    PG_POOLER_DIRECT_URL: direct,
    PG_POOLER_SESSION_URL: `postgresql://contract@127.0.0.1:${port}/session_contract`,
    PG_POOLER_TRANSACTION_URL: `postgresql://contract@127.0.0.1:${port}/transaction_contract`,
    PG_POOLER_ADMIN_URL: `postgresql://contract@127.0.0.1:${port}/pgbouncer`,
    PG_POOLER_WS_PORT: String(relay.port),
    PG_POOLER_EXPECT_VERSION: '1.26.1',
  });
  persist();
  const consumer = join(root, 'consumer');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
  // Mandatory pg remains installed through the actual archive's dependencies.
  await child(
    'install-actual-archive',
    env.PG_POOLER_NODE22,
    [
      env.PG_POOLER_NPM_CLI,
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      report.archive.path,
      '@neondatabase/serverless@1.2.0',
      'ws@8.18.3',
    ],
    { ...env, PG_POOLER_CONSUMER: consumer },
  );
  for (const file of ['contract.mjs', 'consumer.mjs']) copyFileSync(join(fixture, file), join(consumer, file));
  const installed = join(consumer, 'node_modules/turbine-orm');
  const payloads = ['notification-hub.js', 'neon-ws.js', 'neon-ws/transport.js', 'realtime.js'];
  report.payloads = {};
  for (const file of payloads.flatMap((file) => [`dist/${file}`, `dist/cjs/${file}`])) {
    const installedHash = hash(readFileSync(join(installed, file)));
    assert.equal(installedHash, hash(readFileSync(join(cwd, file))), `actual archive payload mismatch: ${file}`);
    report.payloads[file] = installedHash;
  }
  report.installedManifest = JSON.parse(readFileSync(join(installed, 'package.json')));
  assert.deepEqual(report.installedManifest.dependencies, { pg: '^8.15.0' });
  for (const [binary, version] of runtimes) {
    await child(
      `installed-missing-services-${version}`,
      binary,
      [join(consumer, 'consumer.mjs'), 'esm'],
      { ...missing, PG_POOLER_CONSUMER: consumer },
      /PG_POOLER_DIRECT_URL required/,
    );
    await child(
      `wrong-mode-${version}`,
      binary,
      sourceArgs,
      {
        ...env,
        PG_POOLER_SESSION_URL: env.PG_POOLER_TRANSACTION_URL,
        PG_POOLER_TRANSACTION_URL: env.PG_POOLER_SESSION_URL,
      },
      /Real PgBouncer admission failed/,
    );
    await child(`source-${version}`, binary, sourceArgs, env);
    for (const format of ['esm', 'cjs'])
      await child(`installed-${version}-${format}`, binary, [reporterArg, join(consumer, 'consumer.mjs'), format], {
        ...env,
        PG_POOLER_CONSUMER: consumer,
      });
  }
  // Every child has finished. All clients must be detached, even though bouncer retains idle PG servers.
  report.poolsAtFinish = (await admin.query('SHOW POOLS')).rows;
  assert.ok(
    report.poolsAtFinish.every(
      (row) => row.database === 'pgbouncer' || (Number(row.cl_active) === 0 && Number(row.cl_waiting) === 0),
    ),
  );
  assert.ok(relay.routes.some((route) => route.path === '/session'));
  assert.ok(relay.routes.some((route) => route.path === '/transaction'));
  assert.ok(relay.routes.every((route) => route.target === `127.0.0.1:${port}`));
  assert.equal(hash(readFileSync(env.PG_POOLER_ARCHIVE)), report.archive.sha256, 'reviewed archive remains unmodified');
  await relay.close();
  stops.pop();
  relayIdentity.stopped = true;
  relayIdentity.routes = relay.routes;
  await admin.end();
  stops.pop();
  await stops.pop()(); // PgBouncer stops before its backend database is dropped.
  await pgService.client.query('DROP DATABASE pooler_contract');
  report.databaseDropped = true;
} catch (error) {
  report.failures.push(error.stack);
  process.exitCode = 1;
} finally {
  for (const stop of stops.reverse()) {
    try {
      await stop();
    } catch (error) {
      report.failures.push(error.stack);
      process.exitCode = 1;
    }
  }
  for (const service of report.services) {
    service.portClosed = await closedPort(service.port);
    service.pidGone = service.engine === 'ws-byte-relay' ? null : gone(service.pid);
    if (service.ownsProcessGroup) service.groupGone = gone(-service.pgid);
    if (service.engine === 'postgresql') {
      service.socketGone = !existsSync(join(service.socket, `.s.PGSQL.${service.port}`));
      service.postmasterGone = !existsSync(join(service.datadir, 'postmaster.pid'));
      const pids = new Set([...service.log.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])));
      for (const backend of report.backgroundPids || []) pids.add(backend.pid);
      service.pidAudit = [...pids].map((pid) => ({ pid, gone: gone(pid) }));
    }
    if (
      !service.portClosed ||
      service.pidGone === false ||
      service.groupGone === false ||
      service.pidAudit?.some((entry) => !entry.gone)
    ) {
      report.failures.push('Owned service cleanup audit failed');
      process.exitCode = 1;
    }
  }
  rmSync(root, { recursive: true, force: true });
  report.rootGone = !existsSync(root);
  report.interrupted = interrupted;
  for (const [signal, handler] of Object.entries(handlers)) process.removeListener(signal, handler);
  persist();
}
