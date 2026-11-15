import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { lifecycle } from './lifecycle.mjs';
import { startService } from './native-service.mjs';

for (const createFails of [false, true]) test(`database cleanup ${createFails ? 'never drops after failed CREATE' : 'retains residual evidence while removing only fresh DB'}`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'optional-db-control-'));
  const report = { services: [], commands: [] }, scope = lifecycle(report), queries = [];
  let ended = 0;
  class Client {
    async connect() {}
    async end() { ended++; }
    async query(sql, values) {
      queries.push({ sql, values });
      if (sql.startsWith('CREATE DATABASE') && createFails) throw new Error('preexisting fixture database');
      if (sql.startsWith('SELECT version')) return { rows: [{ version: 'fixture only' }] };
      if (sql.startsWith('SELECT pid,state')) return { rows: [{ pid: 123, state: 'active' }] };
      return { rows: [] };
    }
  }
  class WebSocketServer { clients = new Set(); on() {} close(callback) { callback(); } }
  try {
    const starting = startService({ root, env: { TURBINE_OPTIONAL_PG_SERVICE_URL: 'postgres://127.0.0.1:1234/caller_preexisting', TURBINE_OPTIONAL_PG_DISPOSABLE: '1' }, pg: { Client }, WebSocketServer, report, scope });
    if (createFails) await assert.rejects(starting, /preexisting fixture/); else await starting;
    const errors = await scope.shutdown();
    const database = report.services[0];
    const drops = queries.filter(({ sql }) => sql.startsWith('DROP DATABASE'));
    assert.equal(drops.length, createFails ? 0 : 1);
    if (!createFails) {
      assert.equal(drops[0].sql, `DROP DATABASE "${database.database}" WITH (FORCE)`);
      assert.equal(database.created, true); assert.equal(database.databaseRemoved, true);
      assert.deepEqual(database.residualBackends, [{ pid: 123, state: 'active' }]);
      assert.equal(errors.length, 1); assert.match(database.cleanupErrors[0], /All owned database clients must close/);
    } else assert.deepEqual(errors, []);
    assert.equal(ended, 1); assert.equal(database.connectionsClosed, true);
    assert.ok(queries.every(({ sql }) => !sql.includes('"caller_preexisting"')));
    assert.equal(existsSync(root), true);
  } finally { await scope.shutdown(); scope.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('stalled WebSocket cleanup still closes the HTTP listener and administration client', { timeout: 5000 }, async () => {
  const { createServer } = await import('node:net');
  const root = mkdtempSync(join(tmpdir(), 'optional-relay-fault-'));
  const report = { services: [], commands: [] }, scope = lifecycle(report);
  let ended = 0;
  class Client {
    async connect() {}
    async end() { ended++; }
    async query(sql) { return { rows: sql.startsWith('SELECT version') ? [{ version: 'fixture only' }] : [] }; }
  }
  class WebSocketServer { clients = new Set(); on() {} close() {} }
  try {
    await startService({ root, env: { TURBINE_OPTIONAL_PG_SERVICE_URL: 'postgres://127.0.0.1:1234/caller', TURBINE_OPTIONAL_PG_DISPOSABLE: '1' }, pg: { Client }, WebSocketServer, report, scope });
    const port = report.services.find((service) => service.engine === 'websocket-relay').port;
    const errors = await scope.shutdown();
    assert.equal(errors.length, 1); assert.equal(ended, 1);
    const probe = createServer();
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
    await new Promise((resolve) => probe.close(resolve));
    assert.match(report.services[1].cleanupErrors[0], /Relay WebSocket close exceeded/);
  } finally { await scope.shutdown(); scope.dispose(); rmSync(root, { recursive: true, force: true }); }
});
