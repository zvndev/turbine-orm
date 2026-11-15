// Fixture-specific announced-port adaptation of tooling/native-consumer-contracts/postgres-service.mjs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Service-specific helper: never accepts an existing datadir or endpoint.
export async function ownedPostgres({ root, env, run, driver, report, registerStop, processLifecycle }) {
  const data = join(root, 'data');
  const socket = join(root, 'socket');
  const port = Number(env.PRISMA8_OWNED_PORT);
  assert.ok(Number.isInteger(port) && port > 1024 && port < 65536, 'Announced private port required');
  const args = [
    '-D',
    data,
    '-h',
    '127.0.0.1',
    '-p',
    String(port),
    '-k',
    socket,
    '-c',
    'timezone=UTC',
    '-c',
    'shared_buffers=32MB',
    '-c',
    'max_connections=32',
    '-c',
    `dynamic_library_path=${join(env.PG_PREFIX, 'lib/postgresql')}`,
    '-c',
    'log_statement=all',
  ];
  const identity = {
    engine: 'postgresql',
    pid: null,
    datadir: data,
    socket,
    port,
    args,
    stopped: false,
    startup: 'pending',
  };
  report.services.push(identity);
  let child, log, closed;
  let spawnError;
  let client;
  let stopping;
  const stop = () =>
    (stopping ??= (async () => {
      try {
        await (processLifecycle ? processLifecycle.closeClient(client) : client?.end());
        identity.connectionsClosed = true;
      } finally {
        if (processLifecycle) await processLifecycle.stop();
        else {
          if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
          const result = child ? await Promise.race([closed, delay(15_000, null, { ref: false })]) : true;
          if (!result && child?.pid) {
            child.kill('SIGKILL');
            await closed;
          }
        }
        identity.stopped = true;
        if (!child) {
          rmSync(data, { recursive: true, force: true });
          rmSync(socket, { recursive: true, force: true });
          identity.datadirRemoved = true;
          identity.socketRemoved = true;
        }
        if (log) {
          const flushed = new Promise((resolve) => log.end(resolve));
          await (processLifecycle ? processLifecycle.wait(flushed, 'PostgreSQL log drain') : flushed);
          identity.log = readFileSync(logPath, 'utf8');
        }
      }
    })());
  // Own partial startup before creating socket/data paths or invoking initdb.
  registerStop(stop);
  const logPath = join(root, 'server.log');
  try {
    processLifecycle?.assertOpen();
    mkdirSync(socket, { recursive: true });
    await run(root, join(env.PG_PREFIX, 'bin/initdb'), [
      '-D',
      data,
      '-U',
      'contract',
      '-A',
      'trust',
      '--no-locale',
      '--encoding=UTF8',
      '--no-instructions',
      '-L',
      join(env.PG_PREFIX, 'share/postgresql'),
    ]);
    processLifecycle?.assertOpen();
    log = createWriteStream(logPath);
    child = (processLifecycle?.spawn ?? spawn)(join(env.PG_PREFIX, 'bin/postgres'), args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    identity.pid = child.pid;
    closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
    child.on('error', (error) => {
      spawnError = error;
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    const url = `postgresql://contract@127.0.0.1:${port}/postgres`;
    for (let attempt = 0; attempt < 120; attempt++) {
      processLifecycle?.assertOpen();
      if (spawnError) throw spawnError;
      assert.equal(child.exitCode, null, 'Owned PostgreSQL exited');
      const candidate = new driver.Client({
        host: socket,
        port,
        user: 'contract',
        database: 'postgres',
        connectionTimeoutMillis: 500,
      });
      try {
        await candidate.connect();
        client = candidate;
        break;
      } catch {
        await (processLifecycle ? processLifecycle.closeClient(candidate) : candidate.end());
        await delay(100);
      }
    }
    assert.ok(client, 'Owned PostgreSQL failed to become ready');
    const {
      rows: [facts],
    } = await client.query(
      "SELECT version(), current_setting('server_version') AS server_version, current_setting('data_directory') AS datadir, current_setting('TimeZone') AS timezone, current_setting('max_connections')::int AS max_connections",
    );
    assert.equal(facts.server_version, '18.6', 'Exact PostgreSQL 18.6 required');
    assert.equal(facts.datadir, data);
    assert.equal(facts.timezone, 'UTC');
    assert.equal(facts.max_connections, 32);
    Object.assign(identity, facts, { startup: 'ready' });
    return { client, url, stop };
  } catch (error) {
    identity.startup = 'failed';
    identity.startupFailure = error?.stack ?? String(error);
    try {
      await stop();
    } catch (cleanupError) {
      identity.startupCleanupFailure = cleanupError?.stack ?? String(cleanupError);
    }
    throw error;
  }
}

// Optional tooling may inject bounded ownership without changing default consumers.
ownedPostgres.processLifecycle = true;
