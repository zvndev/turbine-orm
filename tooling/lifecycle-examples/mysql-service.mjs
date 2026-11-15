import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const freePort = async () => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return port;
};

// Starts only a fresh datadir created by this invocation. No external URL input.
export async function ownedMysql({ root, mode, env, run, driver, report, registerStop }) {
  const datadir = join(root, 'data');
  const socket = join(root, 'mysql.sock');
  mkdirSync(datadir, { recursive: true });
  const port = await freePort();
  const binary = join(env.MYSQL_BASEDIR, 'bin/mysqld');
  const serviceEnv = {
    ...env,
    LD_LIBRARY_PATH: [env.MYSQL_LIBRARY_PATH, env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
  };
  run(
    root,
    binary,
    ['--no-defaults', '--initialize-insecure', `--basedir=${env.MYSQL_BASEDIR}`, `--datadir=${datadir}`],
    serviceEnv,
  );
  const identity = { datadir, socket, port, mode, pid: null, stopped: false, connectionsClosed: false };
  report.services.push(identity);
  const log = createWriteStream(join(root, 'server.log'));
  const child = spawn(
    binary,
    [
      '--no-defaults',
      `--basedir=${env.MYSQL_BASEDIR}`,
      `--datadir=${datadir}`,
      '--bind-address=127.0.0.1',
      `--port=${port}`,
      `--socket=${socket}`,
      `--pid-file=${join(root, 'mysql.pid')}`,
      '--mysqlx=0',
      `--sql-mode=${mode}`,
      '--innodb-buffer-pool-size=64M',
      '--log-error-verbosity=2',
    ],
    { env: serviceEnv, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  identity.pid = child.pid;
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  let spawnError;
  child.once('error', (error) => {
    spawnError = error;
  });
  const connections = new Set();
  const connect = async (database) => {
    const connection = await driver.createConnection({
      socketPath: socket,
      user: 'root',
      database,
      connectTimeout: 1000,
    });
    connections.add(connection);
    return connection;
  };
  let stopping;
  const stop = () =>
    (stopping ??= (async () => {
      try {
        await Promise.all([...connections].map((connection) => connection.end()));
        identity.connectionsClosed = true;
      } finally {
        if (child.exitCode === null && child.signalCode === null && child.pid) child.kill('SIGTERM');
        const result = await Promise.race([closed, delay(15_000, undefined, { ref: false }).then(() => null)]);
        if (!result && child.pid) {
          child.kill('SIGKILL');
          await closed;
        }
        identity.stopped = true;
        identity.log = readFileSync(join(root, 'server.log'), 'utf8');
        log.end();
      }
    })());
  registerStop?.(stop);
  try {
    let admin;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (spawnError) throw spawnError;
      assert.equal(child.exitCode, null, `Owned MySQL exited; inspect ${root}/server.log`);
      try {
        admin = await connect();
        break;
      } catch {
        await delay(100);
      }
    }
    assert.ok(admin, `Owned MySQL did not become ready; inspect ${root}/server.log`);
    const [[facts]] = await admin.query(
      'SELECT VERSION() AS version, @@sql_mode AS sqlMode, @@GLOBAL.sql_mode AS serverSqlMode, @@port AS port, @@datadir AS datadir',
    );
    assert.match(facts.version, /^8\.4\./, 'This example verifier requires native MySQL 8.4');
    assert.equal(facts.port, port);
    assert.equal(facts.datadir.replace(/\/$/, ''), datadir);
    assert.deepEqual(facts.serverSqlMode.split(',').sort(), mode.split(',').sort());
    // mysql2 negotiates CLIENT_IGNORE_SPACE; record the observed session mode too.
    assert.deepEqual(
      facts.sqlMode
        .split(',')
        .filter((item) => item !== 'IGNORE_SPACE')
        .sort(),
      mode.split(',').sort(),
    );
    Object.assign(identity, facts, { datadir });
    return { admin, connect, port, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
