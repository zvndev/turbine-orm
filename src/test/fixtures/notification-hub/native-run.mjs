// Native source runner. Fails if PostgreSQL binaries/driver/runtime are absent.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ownedPostgres } from '../../../../tooling/native-consumer-contracts/postgres-service.mjs';

const cwd = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const output = process.env.NOTIFICATION_HUB_EVIDENCE;
assert.ok(output && existsSync(output), 'Set NOTIFICATION_HUB_EVIDENCE to an existing output directory');
const root = mkdtempSync(join(output, 'native-'));
const report = {
  scope: 'native PostgreSQL source; owned local service, no proxy/provider',
  runtime: process.version,
  commands: [],
  services: [],
  failures: [],
};
const stops = [];
const env = { ...process.env, PG_PREFIX: process.env.PG_PREFIX, TURBINE_REQUIRE_ENGINE: 'postgres' };
function processGroup(pid) {
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
async function portClosed(port) {
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
const run = (dir, binary, args, expected = 0) => {
  const result = spawnSync(binary, args, { cwd: dir, env, encoding: 'utf8', timeout: 30_000 });
  report.commands.push({
    binary,
    args,
    pid: result.pid,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  assert.equal(result.status, expected, result.stderr);
};
async function child(label, args, childEnv = env, success = true) {
  const log = join(output, `${label}.log`);
  const fd = openSync(log, 'w+');
  const process_ = spawn(process.execPath, args, { cwd, env: childEnv, stdio: ['ignore', fd, fd] });
  const record = {
    label,
    binary: process.execPath,
    args,
    pid: process_.pid,
    pgid: processGroup(process_.pid),
    ownsProcessGroup: false,
    log,
  };
  report.commands.push(record);
  const timer = setTimeout(() => process_.kill('SIGTERM'), 60_000);
  try {
    record.exit = await new Promise((accept, reject) => {
      process_.once('error', reject);
      process_.once('exit', accept);
    });
    const bytes = Buffer.alloc(fstatSync(fd).size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      assert.ok(count > 0, 'Child log truncated while reading');
      offset += count;
    }
    const contents = bytes.toString('utf8');
    if (success) assert.equal(record.exit, 0, contents);
    else {
      assert.notEqual(record.exit, 0);
      assert.match(contents, /precondition is unmet/);
    }
  } finally {
    closeSync(fd);
    clearTimeout(timer);
  }
}
try {
  assert.ok(env.PG_PREFIX, 'PG_PREFIX with native PostgreSQL 18.6 is required');
  await child(
    'required-service-omission',
    ['--import', 'tsx', '--test', 'src/test/notification-hub-native.test.ts'],
    { ...env, DATABASE_URL: '' },
    false,
  );
  const service = await ownedPostgres({ root, env, run, driver: pg, report, registerStop: (stop) => stops.push(stop) });
  Object.assign(report.services[0], { pgid: processGroup(report.services[0].pid), ownsProcessGroup: false });
  report.backgroundPids = (await service.client.query('SELECT pid,backend_type FROM pg_stat_activity')).rows;
  await service.client.query('CREATE DATABASE notification_contract');
  const url = service.url.replace('/postgres', '/notification_contract');
  env.DATABASE_URL = url;
  await child('native-source', [
    '--import',
    'tsx',
    '--test',
    '--test-concurrency=1',
    'src/test/notification-hub.test.ts',
    'src/test/notification-hub-native.test.ts',
  ]);
  if (process.env.NOTIFICATION_HUB_PACKED_RUNNER) {
    await child('packed-native', [process.env.NOTIFICATION_HUB_PACKED_RUNNER], {
      ...env,
      NOTIFICATION_HUB_CONSUMER_ROOT: process.env.NOTIFICATION_HUB_CONSUMER_ROOT,
    });
  }
  report.remaining = (
    await service.client.query(
      "SELECT pid,datname FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid()",
    )
  ).rows;
  assert.deepEqual(report.remaining, []);
  await service.client.query('DROP DATABASE notification_contract');
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
  for (const command of report.commands) {
    command.pidGone = gone(command.pid);
  }
  for (const service of report.services) {
    service.pidGone = gone(service.pid);
    service.portClosed = await portClosed(service.port);
    service.socketGone = !existsSync(join(service.socket, `.s.PGSQL.${service.port}`));
    service.postmasterGone = !existsSync(join(service.datadir, 'postmaster.pid'));
    const pids = new Set([...service.log.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])));
    for (const backend of report.backgroundPids ?? []) pids.add(backend.pid);
    service.pidAudit = [...pids].map((pid) => ({ pid, gone: gone(pid) }));
    if (
      !service.pidGone ||
      !service.portClosed ||
      !service.socketGone ||
      !service.postmasterGone ||
      service.pidAudit.some((entry) => !entry.gone)
    ) {
      report.failures.push('Native service cleanup audit failed');
      process.exitCode = 1;
    }
  }
  rmSync(root, { recursive: true, force: true });
  report.removedRoot = root;
  report.rootGone = !existsSync(root);
  writeFileSync(join(output, 'native-report.json'), JSON.stringify(report, null, 2));
}
