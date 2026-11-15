import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalize } from './oracle.mjs';
import { hash, require } from './provenance.mjs';

export function ownedProcess(binary, args, options = {}) {
  const process = spawn(binary, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  const state = { process, exited: false };
  state.done = new Promise((resolveExit) => {
    process.once('error', (error) => {
      state.error = error;
      state.exited = true;
      resolveExit();
    });
    process.once('exit', (code, signal) => {
      state.exit = { code, signal };
      state.exited = true;
      resolveExit();
    });
  });
  return state;
}
export function groupAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
export async function stopOwned(state, graceMs = 10000) {
  if (!state) return;
  const kill = (signal) => {
    try {
      process.kill(-state.process.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  // Kill the owned group even after its leader exited (orphaned children).
  if (groupAlive(state.process.pid)) kill('SIGTERM');
  const force = setTimeout(() => {
    if (groupAlive(state.process.pid)) kill('SIGKILL');
  }, graceMs);
  try {
    await state.done;
    const deadline = Date.now() + graceMs + 5000;
    while (groupAlive(state.process.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 30));
    assert.equal(groupAlive(state.process.pid), false, 'owned process group cleanup incomplete');
  } finally {
    clearTimeout(force);
  }
}
export async function portOpen(port) {
  return new Promise((resolveOpen) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (value) => {
      socket.destroy();
      resolveOpen(value);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(500, () => done(true));
  });
}
export async function withNative(root, mode, callback) {
  mkdirSync(root);
  const data = join(root, 'data'),
    socket = join(root, 'mysql.sock'),
    binary = resolve(process.env.MYSQL_PREP_MYSQLD ?? 'missing-mysqld');
  const identityPath = join(root, 'identity.json');
  const identity = {
    root,
    data,
    socket,
    ownerUid: process.getuid(),
    mode,
    binary,
    status: 'starting',
    cleanupErrors: [],
    children: [],
  };
  let initialization, server, child, listener, mysql, ready, interrupted;
  const logs = [];
  const save = () => writeFileSync(identityPath, `${JSON.stringify(identity, null, 2)}\n`);
  const interrupt = (name) => {
    interrupted = name;
    identity.interrupted = name;
    if (child && groupAlive(child.process.pid)) process.kill(-child.process.pid, 'SIGTERM');
  };
  const term = () => interrupt('SIGTERM'),
    int = () => interrupt('SIGINT');
  process.on('SIGTERM', term);
  process.on('SIGINT', int);
  try {
    save();
    assert.equal(statSync(root).uid, process.getuid());
    assert.ok(existsSync(binary), 'required native MySQL executable absent');
    identity.binarySha256 = hash(binary);
    identity.binaryVersion = execFileSync(binary, ['--no-defaults', '--version'], { encoding: 'utf8' }).trim();
    assert.match(identity.binaryVersion, /Ver 8\.4\.0\b/, 'exact native MySQL8.4.0 required');
    mkdirSync(data);
    listener = createServer();
    await new Promise((r, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', r);
    });
    identity.port = listener.address().port;
    await new Promise((r) => listener.close(r));
    function launch(args, name) {
      const log = createWriteStream(join(root, name));
      logs.push(log);
      const state = ownedProcess(binary, args);
      state.process.stdout.pipe(log, { end: false });
      state.process.stderr.pipe(log, { end: false });
      return state;
    }
    const basedir = dirname(dirname(binary));
    initialization = launch(
      ['--no-defaults', `--basedir=${basedir}`, `--datadir=${data}`, '--initialize-insecure'],
      'initialize.log',
    );
    identity.initializationPid = initialization.process.pid;
    save();
    const initDeadline = setTimeout(() => initialization.process.kill('SIGKILL'), 45000);
    try {
      await initialization.done;
    } finally {
      clearTimeout(initDeadline);
    }
    if (initialization.error) throw initialization.error;
    assert.equal(initialization.exit?.code, 0, 'owned native initialization failed; see initialize.log');
    if (interrupted) throw new Error(`interrupted: ${interrupted}`);
    const modeArgs =
      mode === 'default'
        ? []
        : [
            '--sql-mode=ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION,ANSI_QUOTES,NO_BACKSLASH_ESCAPES',
          ];
    server = launch(
      [
        '--no-defaults',
        `--basedir=${basedir}`,
        `--datadir=${data}`,
        `--socket=${socket}`,
        `--port=${identity.port}`,
        '--bind-address=127.0.0.1',
        '--mysqlx=OFF',
        '--performance-schema=ON',
        `--pid-file=${join(root, 'mysqld.pid')}`,
        ...modeArgs,
      ],
      'server.log',
    );
    identity.pid = server.process.pid;
    save();
    mysql = require('mysql2/promise');
    const deadline = Date.now() + 30000;
    while (!ready) {
      if (interrupted || Date.now() > deadline)
        throw new Error(`required native service readiness failed${interrupted ? `: ${interrupted}` : ''}`);
      if (server.exited) throw server.error ?? new Error('owned MySQL exited; see server.log');
      try {
        ready = await mysql.createConnection({
          host: '127.0.0.1',
          port: identity.port,
          user: 'root',
          connectTimeout: 500,
        });
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const [facts] = await ready.query('SELECT VERSION() AS version, @@sql_mode AS sqlMode');
    assert.equal(facts[0].version, '8.4.0');
    identity.facts = facts[0];
    await ready.end();
    ready = null;
    identity.status = 'ready';
    save();
    await callback({
      identity,
      identityPath,
      async run(node, output) {
        if (interrupted) throw new Error(`interrupted: ${interrupted}`);
        const args = ['--import', 'tsx', fileURLToPath(new URL('./run.mjs', import.meta.url)), output];
        child = ownedProcess(node, args, { env: { ...process.env, MYSQL_PREP_OWNED_IDENTITY: identityPath } });
        identity.childPid = child.process.pid;
        const childRecord = { pid: child.process.pid ?? null, node, args, output };
        identity.children.push(childRecord);
        identity.command = { node, args };
        save();
        const log = createWriteStream(`${output}.log`);
        logs.push(log);
        child.process.stdout.pipe(log, { end: false });
        child.process.stderr.pipe(log, { end: false });
        let force;
        const timeout = setTimeout(() => {
          if (groupAlive(child.process.pid)) process.kill(-child.process.pid, 'SIGTERM');
          force = setTimeout(() => {
            if (groupAlive(child.process.pid)) process.kill(-child.process.pid, 'SIGKILL');
          }, 2000);
        }, 180000);
        try {
          await child.done;
        } finally {
          clearTimeout(timeout);
          clearTimeout(force);
        }
        childRecord.exit = child.exit;
        if (child.error) {
          childRecord.error = child.error.message;
          throw child.error;
        }
        assert.equal(child.exit?.code, 0, `campaign failed; see ${output}.log`);
        assert.equal(JSON.parse(readFileSync(output, 'utf8')).status, 'passed');
        await stopOwned(child);
        childRecord.groupAbsent = !groupAlive(child.process.pid);
        child = null;
      },
    });
    if (interrupted) throw new Error(`interrupted: ${interrupted}`);
  } catch (error) {
    identity.failure = String(error.stack ?? error);
  } finally {
    await finalize(
      identity,
      [
        async () => {
          await stopOwned(child);
          for (const record of identity.children) {
            record.groupAbsent = !groupAlive(record.pid);
            assert.equal(record.groupAbsent, true, 'all recorded runtime child groups absent');
          }
          identity.childGroupAbsent = identity.children.every((record) => record.groupAbsent);
        },
        async () => {
          await ready?.end();
        },
        async () => {
          if (listener?.listening) await new Promise((r) => listener.close(r));
        },
        async () => {
          await stopOwned(initialization);
          identity.initializationGroupAbsent = !groupAlive(initialization?.process.pid);
        },
        async () => {
          await stopOwned(server);
          identity.serverGroupAbsent = !groupAlive(server?.process.pid);
          identity.serverExit = server?.exit;
        },
        async () => {
          // Never remove storage while an owned process can still use it.
          assert.equal(
            groupAlive(server?.process.pid) ||
              identity.children.some((record) => groupAlive(record.pid)) ||
              groupAlive(initialization?.process.pid),
            false,
          );
          rmSync(data, { recursive: true, force: true });
          for (const path of [socket, `${socket}.lock`, join(root, 'mysqld.pid')]) rmSync(path, { force: true });
          identity.dataAbsent = !existsSync(data);
          identity.socketAbsent = !existsSync(socket);
          if (identity.port) identity.portClosed = !(await portOpen(identity.port));
          assert.ok(identity.dataAbsent && identity.socketAbsent && (!identity.port || identity.portClosed));
        },
        async () => {
          if (server && !identity.failure) assert.equal(server.exit?.code, 0, 'clean native shutdown');
        },
        async () => {
          if (process.env.MYSQL_PREP_FAULT === 'cleanup')
            throw new Error('forced cleanup reporting fault after actual cleanup');
        },
        async () => {
          for (const log of logs) await new Promise((r) => log.end(r));
        },
        async () => {
          // Signals can arrive during any awaited cleanup, including log flush.
          if (interrupted) throw new Error(`interrupted: ${interrupted}`);
        },
      ],
      save,
    );
    process.off('SIGTERM', term);
    process.off('SIGINT', int);
  }
  return identity;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const output = resolve(process.argv[2] ?? '');
  assert.ok(process.argv[2], 'usage: node native.mjs NEW-output-directory');
  mkdirSync(output);
  const result = { format: 'mysql-preparation-campaign-v1', status: 'running', services: [], cleanupErrors: [] };
  try {
    const runtimes = [process.env.MYSQL_PREP_NODE22, process.env.MYSQL_PREP_NODE24];
    assert.ok(runtimes.every(Boolean), 'both exact runtime executable paths are required');
    for (const mode of ['default', 'ansi-no-backslash']) {
      const service = await withNative(join(output, mode), mode, async ({ run }) => {
        for (let i = 0; i < runtimes.length; i++)
          await run(runtimes[i], join(output, `${mode}-node${i ? 24 : 22}.json`));
      });
      result.services.push(service);
      assert.equal(
        service.status,
        'passed',
        `native service/campaign failed: ${service.failure ?? service.cleanupErrors.join('\n')}`,
      );
    }
  } catch (error) {
    result.failure = String(error.stack ?? error);
  }
  await finalize(result, [], (r) => writeFileSync(join(output, 'campaign.json'), `${JSON.stringify(r, null, 2)}\n`));
  console.log(JSON.stringify({ output, status: result.status }));
  if (result.status !== 'passed') process.exitCode = 1;
}
