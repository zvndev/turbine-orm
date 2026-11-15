/**
 * Correctness-only launcher for the ORIGINAL secondary entry points. Owns one
 * private native cluster, seeds the original full fixture, generates the normal
 * PG client, and runs --preflight. It never starts a timing campaign.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = fileURLToPath(new URL('..', import.meta.url));
const destination = resolve(process.argv[2] ?? 'missing-output');
assert.ok(process.argv[2], 'usage: node benchmarks/secondary-native.mjs <new-output-directory>');
mkdirSync(destination);
assert.equal(process.version, 'v24.10.0', 'Use exact Node24.10.0');
assert.ok(process.env.SECONDARY_PG_PREFIX, 'SECONDARY_PG_PREFIX must name the local PostgreSQL installation.');
const prefix = resolve(process.env.SECONDARY_PG_PREFIX);
const ownedRoot = mkdtempSync(join(tmpdir(), 'pg-secondary-'));
const data = join(ownedRoot, 'data');
const socket = join(ownedRoot, 'socket');
mkdirSync(socket);
const report = {
  status: 'running',
  mode: 'original-suites-correctness-only',
  root,
  output: destination,
  serviceRoot: ownedRoot,
  data,
  socket,
  node: process.execPath,
  nodeVersion: process.version,
  port: null,
  processes: [],
  runs: [],
  errors: [],
  cleanup: {},
  command: [process.execPath, ...process.execArgv, ...process.argv.slice(1)],
};
const save = () => writeFileSync(join(destination, 'native.json'), JSON.stringify(report, null, 2) + '\n');
const active = new Set();
let service, observer;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
function start(executable, args, name, env = {}) {
  const fd = openSync(join(destination, `${name}.log`), 'wx');
  const child = spawn(executable, args, {
    cwd: root,
    detached: true,
    env: { ...process.env, ...env },
    stdio: ['ignore', fd, fd],
  });
  const identity = { name, executable, args, pid: child.pid, pgid: child.pid, exit: null };
  report.processes.push(identity);
  active.add(child);
  save();
  const done = new Promise((resolveDone, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      identity.exit = { code, signal };
      closeSync(fd);
      active.delete(child);
      save();
      resolveDone(identity.exit);
    });
  });
  return { child, identity, done };
}
function signalGroup(child, signal = 'SIGTERM') {
  try {
    process.kill(-child.pid, signal);
  } catch (e) {
    if (e.code !== 'ESRCH') throw e;
  }
}
async function bounded(process, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      process.done,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          signalGroup(process.child, 'SIGKILL');
          reject(new Error(`${process.identity.name} exceeded correctness deadline`));
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function run(executable, args, name, env) {
  const process = start(executable, args, name, env);
  const exit = await bounded(process, 120000);
  assert.deepEqual(exit, { code: 0, signal: null }, `${name} failed; see ${join(destination, name + '.log')}`);
  return process;
}
const stop = () => {
  report.errors.push('interrupted');
  for (const child of active) signalGroup(child);
  save();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
try {
  await run(join(prefix, 'bin/postgres'), ['--version'], 'server-version');
  assert.equal(readFileSync(join(destination, 'server-version.log'), 'utf8').trim(), 'postgres (PostgreSQL) 18.6');
  await run(
    join(prefix, 'bin/initdb'),
    [
      '-D',
      data,
      '-U',
      'secondary_owner',
      '-A',
      'trust',
      '--no-locale',
      '--encoding=UTF8',
      '--no-instructions',
      '-L',
      join(prefix, 'share/postgresql'),
    ],
    'initdb',
  );
  const portProbe = createServer();
  await new Promise((done, reject) => {
    portProbe.once('error', reject);
    portProbe.listen(0, '127.0.0.1', done);
  });
  report.port = portProbe.address().port;
  await new Promise((done) => portProbe.close(done));
  service = start(
    join(prefix, 'bin/postgres'),
    [
      '-D',
      data,
      '-h',
      '127.0.0.1',
      '-p',
      String(report.port),
      '-k',
      socket,
      '-c',
      'timezone=UTC',
      '-c',
      'max_connections=80',
      '-c',
      'shared_buffers=32MB',
      '-c',
      `dynamic_library_path=${join(prefix, 'lib/postgresql')}`,
      '-c',
      'log_statement=all',
    ],
    'postgres',
  );
  for (let n = 0; n < 100; n++) {
    const client = new pg.Client({
      host: socket,
      port: report.port,
      user: 'secondary_owner',
      database: 'postgres',
      connectionTimeoutMillis: 300,
    });
    client.on('error', () => {});
    try {
      await client.connect();
      observer = client;
      break;
    } catch {
      await client.end();
      await delay(50);
    }
  }
  assert.ok(observer, 'Owned server not ready');
  report.server = (
    await observer.query(
      "SELECT version(), current_setting('data_directory') data, current_setting('TimeZone') timezone",
    )
  ).rows[0];
  assert.equal(report.server.data, data);
  report.server.settings = Object.fromEntries(
    (
      await observer.query('SELECT name,setting FROM pg_settings WHERE name=ANY($1::text[])', [
        [
          'max_connections',
          'shared_buffers',
          'fsync',
          'synchronous_commit',
          'full_page_writes',
          'default_transaction_isolation',
          'plan_cache_mode',
        ],
      ])
    ).rows.map((r) => [r.name, r.setting]),
  );
  assert.equal(report.server.settings.max_connections, '80');
  await observer.query('CREATE DATABASE secondary_bench');
  const url = `postgresql://secondary_owner@localhost:${report.port}/secondary_bench?host=${encodeURIComponent(socket)}`;
  const env = {
    DATABASE_URL: url,
    PGSOCKET: `${socket}/.s.PGSQL.${report.port}`,
    PGDATABASE: 'secondary_bench',
    PGUSER: 'secondary_owner',
    USERS: '1000',
    POSTS_PER_USER: '10',
    COMMENTS_PER_POST: '5',
    WIDE_ROWS: '2000',
    RTTS: '0,1,5,25',
  };
  const loader = fileURLToPath(new URL('./node_modules/tsx/dist/loader.mjs', import.meta.url));
  const ts = (file) => ['--import', loader, `benchmarks/${file}`];
  await run(process.execPath, ts('seed-neon.ts'), 'seed', env);
  await run(process.execPath, ['benchmarks/secondary-generate.mjs'], 'generate', env);
  for (const file of ['bench-stream-parity.ts', 'bench-latency.ts', 'deepoffset.ts']) {
    const name = file.replace(/\.ts$/, '');
    const reportPath = join(destination, `${name}.json`);
    await run(process.execPath, [...ts(file), '--preflight'], name, { ...env, SECONDARY_REPORT: reportPath });
    const suite = JSON.parse(readFileSync(reportPath));
    assert.equal(suite.status, 'passed');
    assert.equal(suite.timing, false);
    assert.equal(suite.cleanup.closed, true);
    const sessions = (
      await observer.query('SELECT pid,state,application_name FROM pg_stat_activity WHERE pid=ANY($1::int[])', [
        suite.cleanup.sessionPids,
      ])
    ).rows;
    assert.deepEqual(sessions, [], 'Original suite leaked backend sessions');
    report.runs.push({
      name,
      verified: suite.verified.length,
      reportPath,
      sha256: createHash('sha256').update(readFileSync(reportPath)).digest('hex'),
      sessions,
    });
    save();
  }
  if (process.env.SECONDARY_CONTROLS !== '0')
    await run(process.execPath, [...ts('secondary-controls.ts'), destination], 'controls', env);
  const left = (
    await observer.query("SELECT pid,state,application_name FROM pg_stat_activity WHERE datname='secondary_bench'")
  ).rows;
  assert.deepEqual(left, [], 'Correctness controls leaked backend sessions');
  await observer.query('DROP DATABASE secondary_bench');
  report.cleanup.databaseDropped = true;
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.errors.push(String(error));
} finally {
  if (observer) {
    try {
      await observer.end();
      report.cleanup.observerClosed = true;
    } catch (e) {
      report.errors.push(String(e));
    }
  }
  for (const child of active) if (child !== service?.child) signalGroup(child);
  if (service && service.identity.exit === null) {
    signalGroup(service.child);
    await bounded(service, 10000);
  }
  for (const identity of report.processes) {
    try {
      process.kill(-identity.pgid, 0);
      report.errors.push(`Process group remains: ${identity.pgid}`);
    } catch (e) {
      if (e.code !== 'ESRCH') report.errors.push(String(e));
    }
  }
  rmSync(ownedRoot, { recursive: true, force: true });
  report.cleanup.serviceRootRemoved = true;
  if (report.errors.length) report.status = 'failed';
  save();
  process.off('SIGTERM', stop);
  process.off('SIGINT', stop);
}
console.log(JSON.stringify({ status: report.status, output: destination, runs: report.runs, cleanup: report.cleanup }));
process.exitCode = report.status === 'passed' ? 0 : 1;
