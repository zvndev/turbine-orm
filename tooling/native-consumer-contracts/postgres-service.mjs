import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Service-specific helper: never accepts an existing datadir or endpoint.
export async function ownedPostgres({ root, env, run, driver, report, registerStop, processLifecycle }) {
  const data = join(root, 'data');
  const socket = join(root, 'socket');
  mkdirSync(socket, { recursive: true });
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
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
    'max_connections=12',
    '-c',
    `dynamic_library_path=${join(env.PG_PREFIX, 'lib/postgresql')}`,
    '-c',
    'log_statement=all',
  ];
  processLifecycle?.assertOpen();
  const logPath = join(root, 'server.log');
  const log = createWriteStream(logPath);
  const child = (processLifecycle?.spawn ?? spawn)(join(env.PG_PREFIX, 'bin/postgres'), args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  let spawnError;
  child.on('error', (error) => {
    spawnError = error;
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const identity = { engine: 'postgresql', pid: child.pid, datadir: data, socket, port, args, stopped: false };
  report.services.push(identity);
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
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
          const result = await Promise.race([closed, delay(15_000, null, { ref: false })]);
          if (!result && child.pid) {
            child.kill('SIGKILL');
            await closed;
          }
        }
        identity.stopped = true;
        const flushed = new Promise((resolve) => log.end(resolve));
        await (processLifecycle ? processLifecycle.wait(flushed, 'PostgreSQL log drain') : flushed);
        identity.log = readFileSync(logPath, 'utf8');
      }
    })());
  registerStop(stop);
  try {
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
      "SELECT version(), current_setting('server_version') AS server_version, current_setting('data_directory') AS datadir, current_setting('TimeZone') AS timezone",
    );
    assert.equal(facts.server_version, '18.6', 'Exact PostgreSQL 18.6 required');
    assert.equal(facts.datadir, data);
    assert.equal(facts.timezone, 'UTC');
    Object.assign(identity, facts);
    return { client, url, stop };
  } catch (error) {
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
