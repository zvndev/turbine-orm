import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect, createServer as tcpServer } from 'node:net';
import { join } from 'node:path';
import { ownedPostgres } from '../native-consumer-contracts/postgres-service.mjs';
import { command } from './harness.mjs';
import { bounded } from './lifecycle.mjs';
import { describeReason } from './reason.mjs';

async function freePort(port) {
  const server = tcpServer();
  try {
    await bounded(new Promise((resolve, reject) => {
      server.once('error', reject); server.listen(port, '127.0.0.1', resolve);
    }), 1000, 'Port audit');
  } finally { if (server.listening) await new Promise((resolve) => server.close(resolve)); }
}
const onceStop = (stop) => { let stopping; return () => stopping ??= stop(); };
async function closeClient(client) {
  if (!client) return;
  try { await bounded(client.end(), 1500, 'PostgreSQL client close'); }
  finally { client.connection?.stream?.destroy(); }
}

export async function startService({ root, env, pg, WebSocketServer, report, scope }) {
  scope.assertOpen();
  const registerStop = (stop) => scope.registerStop(onceStop(stop));
  let url;
  if (env.PG_PREFIX) {
    // Owned services require the shared helper's bounded lifecycle capability.
    assert.equal(ownedPostgres.processLifecycle, true, 'Owned PostgreSQL helper must support bounded lifecycle injection');
    let handle;
    const processLifecycle = {
      assertOpen: scope.assertOpen, closeClient,
      wait: (promise, label) => bounded(promise, 1500, label),
      spawn(binary, args, options) {
        const record = { cwd: root, binary, args };
        handle = scope.spawn(binary, args, options, record); handle.service = true;
        return handle.child;
      },
      stop: () => handle.stop(true),
    };
    const service = await ownedPostgres({ root, env, driver: pg, report, processLifecycle,
      run: (cwd, binary, args) => command(report, cwd, binary, args, env, { scope, timeoutMs: 60000 }),
      registerStop(stop) {
        const identity = report.services.find((item) => item.pid === handle.child.pid);
        identity.supervisor = handle.record.supervisor;
        registerStop(async () => {
          let failure, failed = false;
          try { await stop(); } catch (error) { failed = true; failure = error; }
          try {
            handle.capture();
            Object.assign(identity, { pid: handle.record.pid, supervisor: handle.record.supervisor, ownershipProof: handle.record.ownershipProof, ownedProcesses: handle.record.ownedProcesses, group: handle.record.group, groupPolicy: handle.record.ownership, remainingPids: handle.record.remainingPids, remainingGroups: handle.record.remainingGroups });
            assert.deepEqual(identity.remainingPids, [], 'Owned PostgreSQL PIDs must disappear');
            assert.deepEqual(identity.remainingGroups, [], 'Owned PostgreSQL groups must disappear');
            await freePort(identity.port); identity.portReleased = true;
            await rm(identity.datadir, { recursive: true, force: true });
            await rm(identity.socket, { recursive: true, force: true });
            identity.datadirRemoved = !existsSync(identity.datadir);
            identity.socketRemoved = !existsSync(join(identity.socket, `.s.PGSQL.${identity.port}`));
            assert.equal(identity.datadirRemoved, true); assert.equal(identity.socketRemoved, true);
            identity.auditComplete = true;
          } catch (error) {
            (identity.cleanupErrors ??= []).push(describeReason(error));
            if (!failed) { failed = true; failure = error; }
          }
          if (failed) throw failure;
        });
      },
    });
    scope.assertOpen(); url = service.url;
    const identity = report.services.find((item) => item.supervisor?.pid === handle.child.pid);
    handle.capture();
    identity.pid = handle.record.pid; identity.supervisor = handle.record.supervisor;
    identity.ownedProcesses = handle.record.ownedProcesses;
    identity.group = handle.record.group; identity.groupPolicy = handle.record.ownership;
  } else {
    assert.equal(env.TURBINE_OPTIONAL_PG_DISPOSABLE, '1', 'Explicit disposable service assertion required');
    const admin = new pg.Client({ connectionString: env.TURBINE_OPTIONAL_PG_SERVICE_URL, connectionTimeoutMillis: 2000, query_timeout: 2500, statement_timeout: 2000 });
    // Identifier contains only generated safe characters. Never reuse the caller's database.
    const database = `optional_gate_${process.pid}_${randomUUID().replaceAll('-', '')}`;
    const identity = { engine: 'postgresql', ownership: 'database-only', database, created: false, stopped: false, pid: null, group: null, datadir: null, socket: null, port: Number(new URL(env.TURBINE_OPTIONAL_PG_SERVICE_URL).port || 5432) };
    identity.cleanupExclusions = 'Caller owns service process/group/datadir/socket/port and preexisting databases; own only freshly created database and clients';
    report.services.push(identity);
    registerStop(async () => {
      const errors = [];
      try {
        if (identity.created) {
          try {
            identity.residualBackends = (await admin.query('SELECT pid,state FROM pg_stat_activity WHERE datname=$1', [database])).rows;
            assert.deepEqual(identity.residualBackends, [], 'All owned database clients must close before drop');
          } catch (error) { errors.push(error); }
          // Socket close is not evidence that PostgreSQL cancelled an active query.
          // Preserve that failure above, but still remove ONLY this freshly created DB.
          try { await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`); }
          catch (error) { errors.push(error); }
          try {
            identity.remainingDatabases = (await admin.query('SELECT datname FROM pg_database WHERE datname=$1', [database])).rows;
            identity.remainingBackends = (await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1', [database])).rows;
            assert.deepEqual(identity.remainingDatabases, []); assert.deepEqual(identity.remainingBackends, []);
            identity.databaseRemoved = true;
          } catch (error) { errors.push(error); }
        } else identity.databaseRemoved = true;
      } finally {
        try { await closeClient(admin); identity.connectionsClosed = true; }
        catch (error) { errors.push(error); }
        identity.stopped = identity.databaseRemoved === true;
        identity.auditComplete = identity.stopped && identity.connectionsClosed === true;
        identity.cleanupErrors = errors.map(describeReason);
      }
      if (errors.length) throw new AggregateError(errors, 'Owned database cleanup failed (residual evidence retained)');
    });
    await admin.connect(); scope.assertOpen();
    identity.version = (await admin.query('SELECT version() AS version')).rows[0].version;
    scope.assertOpen();
    await admin.query(`CREATE DATABASE "${database}"`); identity.created = true;
    scope.assertOpen();
    const endpoint = new URL(env.TURBINE_OPTIONAL_PG_SERVICE_URL); endpoint.pathname = `/${database}`;
    url = endpoint.toString();
  }
  scope.assertOpen();
  const endpoint = new URL(url);
  const server = createServer();
  const wss = new WebSocketServer({ server, path: '/v1' });
  const sockets = new Set(), incoming = new Set();
  const relay = { engine: 'websocket-relay', pid: process.pid, port: null, sockets: 0, stopped: false };
  report.services.push(relay);
  let sealed = false;
  server.on('connection', (socket) => {
    incoming.add(socket); socket.on('close', () => incoming.delete(socket));
    if (sealed) socket.destroy();
  });
  registerStop(async () => {
    sealed = true;
    const errors = [];
    // Stop admission before draining upgraded and unupgraded incoming sockets.
    const serverClosed = server.listening ? new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) : Promise.resolve();
    for (const client of wss.clients) try { client.terminate(); } catch (error) { errors.push(error); }
    for (const socket of [...sockets, ...incoming]) try { socket.destroy(); } catch (error) { errors.push(error); }
    const results = await Promise.allSettled([
      bounded(new Promise((resolve) => wss.close(resolve)), 1500, 'Relay WebSocket close'),
      bounded(serverClosed, 1500, 'Relay HTTP close'),
    ]);
    for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
    await new Promise((resolve) => setImmediate(resolve));
    try {
      assert.equal(wss.clients.size, 0); assert.equal(sockets.size, 0); assert.equal(incoming.size, 0);
      if (relay.port !== null) await freePort(relay.port);
      Object.assign(relay, { stopped: true, connectionsClosed: true, auditComplete: true, portReleased: true, sockets: sockets.size, webSockets: wss.clients.size, httpSockets: incoming.size });
    } catch (error) { errors.push(error); }
    relay.cleanupErrors = errors.map(describeReason);
    try { writeFileSync(join(root, 'relay-cleanup.json'), JSON.stringify(relay, null, 2)); }
    catch (error) { errors.push(error); relay.cleanupErrors.push(describeReason(error)); }
    if (errors.length) throw new AggregateError(errors, 'Relay cleanup failed');
  });
  wss.on('connection', (client) => {
    if (sealed || scope.signal.aborted) { client.terminate(); return; }
    const socket = connect({ host: endpoint.hostname, port: Number(endpoint.port || 5432) });
    sockets.add(socket);
    socket.on('data', (chunk) => { if (client.readyState === 1) client.send(chunk); });
    socket.on('close', () => { sockets.delete(socket); client.close(); });
    socket.on('error', () => client.close());
    client.on('message', (chunk) => socket.write(chunk));
    client.on('close', () => socket.destroy());
    client.on('error', () => socket.destroy());
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  relay.port = server.address().port;
  scope.assertOpen();
  return { url, proxy: `127.0.0.1:${relay.port}/v1` };
}
