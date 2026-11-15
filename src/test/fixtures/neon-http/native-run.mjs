// Required native runner. Starts only its own disposable PG18.6; never borrows a service.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ownedPostgres } from '../../../../tooling/native-consumer-contracts/postgres-service.mjs';
import { controlFixtures } from './native-controls.mjs';
import {
  bounded,
  checkpoint,
  descendants,
  identity,
  OwnedChildren,
  persist,
  sameProcess,
  signalOwned,
} from './native-lifecycle.mjs';

const cwd = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
assert.ok(process.env.NEON_HTTP_EVIDENCE, 'NEON_HTTP_EVIDENCE required');
const output = resolve(process.env.NEON_HTTP_EVIDENCE);
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(output, 'service-'));
const report = {
  scope: 'branch source and actual unmodified installed archive; local HTTP-to-PG bridge',
  runtime: process.version,
  runner: identity(process.pid),
  root,
  phase: 'initialization',
  passed: false,
  interruptions: [],
  commands: [],
  services: [],
  failures: [],
};
const stops = [];
const ownedClients = [];
const serviceMonitors = [];
function observeService(service) {
  const found = new Map((service.processes ?? []).map((entry) => [entry.pid, entry]));
  for (const entry of descendants([service.process, ...found.values()].filter(Boolean))) found.set(entry.pid, entry);
  service.processes = [...found.values()];
}
const env = {
  ...process.env,
  TZ: 'UTC',
  PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
  TURBINE_REQUIRE_NEON_HTTP_NATIVE: '1',
  TURBINE_REQUIRE_NEON_HTTP_DRIVER: '1',
  NEON_HTTP_EXPECT_PG: '18.6',
};
const hash = (data) => createHash('sha256').update(data).digest('hex');
const reportPath = join(output, 'native-report.json');
const cancellation = new AbortController();
let primaryFailure;
function fail(error) {
  const message = error?.stack ?? String(error);
  primaryFailure ??= message;
  report.primaryFailure = primaryFailure;
  report.failures.push(message);
  report.passed = false;
  process.exitCode = report.interruptions[0]?.exitCode ?? 1;
}
const save = () => persist(reportPath, report);
const children = new OwnedChildren({ cwd, report, env, onChange: save });
const handlers = new Map();
for (const [signal, exitCode] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  const handler = () => {
    report.interruptions.push({ signal, exitCode, phase: report.phase });
    const error = new Error(`Interrupted by ${signal}`);
    fail(error);
    children.seal(error);
    cancellation.abort(error);
    // A late signal must replace even a previously written successful report.
    try {
      save();
    } catch (error_) {
      fail(error_);
    }
  };
  handlers.set(signal, handler);
  process.on(signal, handler);
}
save();
const group = (pid) => identity(pid)?.pgid ?? null;
function gone(pid) {
  return identity(pid) === null;
}
async function portClosed(port) {
  return new Promise((resolve_) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve_(false);
    });
    socket.once('connect', () => {
      socket.destroy();
      resolve_(false);
    });
    socket.once('error', (error) => {
      socket.destroy();
      resolve_(error.code === 'ECONNREFUSED');
    });
  });
}
async function run(dir, binary, args) {
  // The shared helper awaits initdb. Keep native commands inside the same durable
  // command owner rather than blocking JS signal handling with spawnSync.
  return children.run('', binary, args, { cwd: dir, env, timeout: 30_000 });
}
async function child(label, binary, args, childEnv = env, failure) {
  report.phase = label;
  return children.run(label, binary, args, {
    env: { ...childEnv, NEON_HTTP_NATIVE_REPORT: join(output, `${label}.json`) },
    log: join(output, `${label}.log`),
    failure,
  });
}
function files(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
  );
}
try {
  assert.ok(env.PG_PREFIX, 'PG_PREFIX with native PostgreSQL 18.6 required');
  const source = ['--import', 'tsx', '--test', '--test-concurrency=1', 'src/test/neon-http-native.test.ts'];
  await child(
    'required-service-omission',
    process.execPath,
    source,
    { ...env, NEON_HTTP_NATIVE_URL: '' },
    /NEON_HTTP_NATIVE_URL required/,
  );
  await child(
    'required-driver-omission',
    process.execPath,
    source,
    { ...env, NEON_HTTP_DRIVER_PATH: join(root, 'absent-driver.mjs') },
    /ERR_MODULE_NOT_FOUND|Cannot find module/,
  );
  children.check();
  report.phase = 'initialization';
  const service = await ownedPostgres({
    root,
    env,
    run,
    // Abort the helper's readiness retry loop through its existing Client/end contract.
    // No shared-helper patch, pg parser mutation, or borrowed service is needed.
    driver: {
      Client: class extends pg.Client {
        async connect() {
          await checkpoint('service-initialization', { services: report.services }, cancellation.signal);
          cancellation.signal.throwIfAborted();
          await super.connect();
          this.ready = true;
        }
        async end() {
          await super.end();
          if (!this.ready) cancellation.signal.throwIfAborted();
        }
      },
    },
    report,
    registerStop: (stop) => {
      const owned = report.services.at(-1);
      owned.process = identity(owned.pid);
      observeService(owned);
      serviceMonitors.push(setInterval(() => observeService(owned), 25));
      stops.push(stop);
      save();
    },
  });
  ownedClients.push(service.client);
  service.client.on('error', (error) => {
    fail(error);
    save();
  });
  observeService(report.services[0]);
  save();
  // Runner initialization is held after native PG readiness, before any native suite launch.
  await checkpoint('initialization', { services: report.services }, cancellation.signal);
  children.check();
  Object.assign(report.services[0], { pgid: group(report.services[0].pid), ownsProcessGroup: false });
  report.servicePids = (await service.client.query('SELECT pid,backend_type FROM pg_stat_activity')).rows;
  for (const process_ of report.servicePids) process_.pgid = group(process_.pid);
  for (const name of ['postgres', 'initdb'])
    report.services[0][`${name}Sha256`] = hash(readFileSync(join(env.PG_PREFIX, 'bin', name)));
  report.services[0].catalogSha256 = hash(readFileSync(join(env.PG_PREFIX, 'share/postgresql/postgres.bki')));
  env.NEON_HTTP_NATIVE_URL = service.url;
  // First a real source run; protocol tests are a separately labeled child process.
  await child('source-native', process.execPath, ['src/test/fixtures/neon-http/gate-run.mjs']);
  await child('intercepted-protocol', process.execPath, [
    '--import',
    'tsx',
    '--test',
    'src/test/neon-http.test.ts',
    'src/test/neon-http-driver.test.ts',
  ]);

  if (process.env.NEON_HTTP_ARCHIVE) {
    const archive = resolve(process.env.NEON_HTTP_ARCHIVE);
    assert.match(process.env.NEON_HTTP_ARCHIVE_SHA256 ?? '', /^[a-f0-9]{64}$/, 'Explicit archive SHA256 required');
    assert.equal(hash(readFileSync(archive)), process.env.NEON_HTTP_ARCHIVE_SHA256);
    const consumer = join(output, 'consumer');
    mkdirSync(consumer); // refuse accidental reuse/mutation of an older installed fixture
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    writeFileSync(join(consumer, 'entry.mjs'), 'export const load = (name) => import(name);\n');
    await child('install-actual-archive', 'npm', [
      'install',
      '--prefix',
      consumer,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--save-exact',
      archive,
      'pg@8.15.0',
      '@neondatabase/serverless@1.2.0',
    ]);
    const unpack = join(output, 'archive');
    mkdirSync(unpack);
    await run(cwd, 'tar', ['-xzf', archive, '-C', unpack]);
    const installed = join(consumer, 'node_modules/turbine-orm');
    const payload = files(join(unpack, 'package'));
    for (const path of payload)
      assert.equal(
        hash(readFileSync(join(installed, path))),
        hash(readFileSync(join(unpack, 'package', path))),
        `Exact actual archive payload: ${path}`,
      );
    assert.equal(JSON.parse(readFileSync(join(consumer, 'node_modules/pg/package.json'))).version, '8.15.0');
    assert.equal(
      JSON.parse(readFileSync(join(consumer, 'node_modules/@neondatabase/serverless/package.json'))).version,
      '1.2.0',
    );
    report.archive = {
      path: archive,
      sha256: hash(readFileSync(archive)),
      installed,
      unchangedFiles: payload.length,
      distFiles: payload.filter((path) => path.startsWith('dist/')).length,
      manifestSha256: hash(readFileSync(join(installed, 'package.json'))),
      pg: '8.15.0',
      neon: '1.2.0',
    };
    const packedEnv = { ...env, NEON_HTTP_CONSUMER_ROOT: consumer };
    for (const format of ['esm', 'cjs'])
      await child(
        `actual-installed-${format}`,
        process.execPath,
        ['src/test/fixtures/neon-http/native-consumer.mjs', format],
        packedEnv,
      );
    // Actual root default API compatibility and all published entry imports, both module formats.
    await child(
      'actual-default-compatibility',
      process.execPath,
      ['src/test/fixtures/neon-http/default-consumer.mjs'],
      packedEnv,
    );
    for (const control of controlFixtures(output)) {
      await child(control.name, process.execPath, [control.path, 'esm'], packedEnv, control.expected);
    }
    for (const path of payload)
      assert.equal(
        hash(readFileSync(join(installed, path))),
        hash(readFileSync(join(unpack, 'package', path))),
        `Installed archive stayed unchanged: ${path}`,
      );
  }
  report.remainingClients = (
    await service.client.query(
      "SELECT pid,datname FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid()",
    )
  ).rows;
  assert.deepEqual(report.remainingClients, []);
  report.remainingRelations = (
    await service.client.query(
      "SELECT relname FROM pg_class WHERE relname LIKE 'http_%' AND relnamespace='public'::regnamespace",
    )
  ).rows;
  assert.deepEqual(report.remainingRelations, []);
  report.nativeReports = [];
  for (const label of [
    'source-native',
    ...(report.archive
      ? ['actual-installed-esm', 'actual-installed-cjs', 'omit-native-effect', 'corrupt-native-effect']
      : []),
  ]) {
    const path = join(output, `${label}.json`);
    const native = JSON.parse(readFileSync(path));
    assert.equal(native.fetchRestored, true);
    assert.equal(native.bridge.closed, true);
    assert.equal(native.bridge.portClosed, true);
    assert.deepEqual(native.remainingObjects, []);
    if (!label.endsWith('native-effect')) {
      assert.equal(native.cases.length, 14);
      assert.deepEqual(native.failures, []);
    }
    report.nativeReports.push({ label, path, sha256: hash(readFileSync(path)), pid: native.pid, pgid: native.pgid });
  }
} catch (error) {
  fail(error);
} finally {
  report.phase = 'final-cleanup';
  // Seal first, even on ordinary failure. No later command may launch during teardown.
  try {
    await children.close();
  } catch (error) {
    fail(error);
  }
  try {
    await checkpoint('final-cleanup', { services: report.services }, cancellation.signal);
  } catch (error) {
    if (!cancellation.signal.aborted) fail(error);
  }
  for (const stop of stops.reverse()) {
    try {
      await bounded(Promise.resolve().then(stop), 5000, 'Owned PostgreSQL teardown');
    } catch (error) {
      fail(error);
    }
  }
  for (const client of ownedClients) {
    try {
      await bounded(client.end(), 1000, 'Owned PG admin connection teardown');
    } catch (error) {
      fail(error);
    }
  }
  // The helper's graceful stop can fail or wait on a client. Escalate only the
  // recorded native postmaster, whose start-time AND exact datadir still match.
  for (const service of report.services) {
    try {
      const owned = service.process;
      observeService(service);
      if (owned && sameProcess(owned)) {
        assert.ok(
          identity(owned.pid).command.includes(`${join(env.PG_PREFIX, 'bin/postgres')} -D ${service.datadir} `),
          'Refuse shutdown without exact owned PG command and datadir',
        );
        signalOwned(owned, 'SIGINT'); // PostgreSQL fast shutdown, including its own backends.
        const until = Date.now() + 5000;
        while (sameProcess(owned) && Date.now() < until) await delay(25);
        if (sameProcess(owned)) {
          service.escalated = true;
          // Postmaster is still alive: capture its children before any adoption.
          observeService(service);
          for (const entry of service.processes.filter((item) => item.pid !== owned.pid)) signalOwned(entry, 'SIGKILL');
          await delay(100);
          signalOwned(owned, 'SIGKILL');
        }
      }
      const until = Date.now() + 3000;
      while (service.processes.some(sameProcess) && Date.now() < until) await delay(25);
      service.pidGone = gone(service.pid);
      service.portClosed = await portClosed(service.port);
      service.socketGone = !existsSync(join(service.socket, `.s.PGSQL.${service.port}`));
      service.postmasterGone = !existsSync(join(service.datadir, 'postmaster.pid'));
      // Keep the server log even if helper cleanup threw before collecting it.
      const log = join(root, 'server.log');
      if (existsSync(log)) service.log = readFileSync(log, 'utf8');
      const pids = new Set([...(service.log ?? '').matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])));
      for (const entry of [...(report.servicePids ?? []), ...service.processes]) pids.add(entry.pid);
      service.pidAudit = [...pids].map((pid) => ({ pid, gone: gone(pid) }));
      if (!service.pidGone || !service.portClosed || service.pidAudit.some((entry) => !entry.gone)) {
        fail(new Error('Owned native cleanup failed'));
      }
    } catch (error) {
      fail(error);
    }
  }
  for (const monitor of serviceMonitors) clearInterval(monitor);
  for (const command of [...report.commands, ...(report.nativeReports ?? [])]) {
    command.pidGone = gone(command.pid);
    if (!command.pidGone || command.processes?.some((entry) => sameProcess(entry))) {
      fail(new Error(`Owned child still alive: ${command.pid}`));
    }
  }
  // Never erase a datadir that is still in use.
  try {
    assert.ok(
      report.services.every(
        (service) => service.pidGone && service.portClosed && service.pidAudit?.every((p) => p.gone),
      ),
      'Refuse removal while an owned native process is alive',
    );
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    fail(error);
  }
  report.removedRoot = root;
  report.rootGone = !existsSync(root);
  if (!report.rootGone) fail(new Error('Owned service root remains'));
  try {
    await checkpoint('report-finalization', {}, cancellation.signal);
  } catch (error) {
    if (!cancellation.signal.aborted) fail(error);
  }
  report.phase = 'complete';
  report.passed = report.failures.length === 0 && report.interruptions.length === 0 && report.rootGone;
  save();
  try {
    await checkpoint('report-written', {}, cancellation.signal);
  } catch (error) {
    if (!cancellation.signal.aborted) {
      fail(error);
      save();
    }
  }
  // Keep signal handlers until Node exits. Any signal in the final event-loop turn
  // still atomically replaces the report and sets the conventional signal status.
}
