// Test-only local bridge evidence. This is neither Neon hosting nor an official proxy.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { checkpoint } from './native-lifecycle.mjs';

export function assertLoopback(value) {
  const url = new URL(value);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Native HTTP requires loopback');
  return url;
}

export async function localBridge(pg, connectionString) {
  assertLoopback(connectionString);
  const requests = [];
  const clients = new Set();
  const active = new Set();
  const errors = [];
  // No pg parser mutation: each client asks for the original PostgreSQL text values.
  const types = { getTypeParser: () => (value) => value };
  const isolation = {
    ReadUncommitted: 'READ UNCOMMITTED',
    ReadCommitted: 'READ COMMITTED',
    RepeatableRead: 'REPEATABLE READ',
    Serializable: 'SERIALIZABLE',
  };
  const bridge = { requests, onExecuted: undefined, closed: false };
  const server = createServer((req, res) => {
    const pending = handle(req, res);
    active.add(pending);
    void pending.then(
      () => active.delete(pending),
      (error) => {
        errors.push(error.stack);
        res.destroy(error);
        active.delete(pending);
      },
    );
  });
  async function handle(req, res) {
    let client;
    let record;
    let transaction = false;
    try {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/sql');
      const requested = assertLoopback(req.headers['neon-connection-string']);
      const expected = new URL(connectionString);
      // Neon 1.2 adds its documented package application_name to the connection URL.
      const applicationName = requested.searchParams.get('application_name');
      requested.searchParams.delete('application_name');
      expected.searchParams.delete('application_name');
      // Neon 1.2 also respells postgres: as postgresql:. Only the scheme name is
      // normalized; host, port, user, password, database and query still compare exactly.
      const schemes = ['postgres:', 'postgresql:'];
      assert.ok(schemes.includes(requested.protocol), 'Never connect to a caller-selected host');
      if (schemes.includes(expected.protocol)) requested.protocol = expected.protocol;
      assert.equal(requested.href, expected.href, 'Never connect to a caller-selected host');
      assert.equal(req.headers['neon-raw-text-output'], 'true');
      assert.equal(req.headers['neon-array-mode'], 'true');
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        assert.ok(body.length <= 1_000_000, 'Local fixture request limit');
      }
      const payload = JSON.parse(body);
      const batch = Array.isArray(payload.queries);
      const queries = batch ? payload.queries : [payload];
      assert.ok(queries.length > 0);
      for (const query of queries) {
        assert.equal(typeof query.query, 'string');
        assert.ok(Array.isArray(query.params));
      }
      record = { queries, batch, headers: req.headers, results: [], outcome: 'started' };
      requests.push(record);
      client = new pg.Client({ connectionString, application_name: applicationName, types });
      clients.add(client);
      await client.connect();
      record.backendPid = client.processID;
      await checkpoint('active-native-child', {
        bridge: { port: bridge.port, endpoint: bridge.endpoint },
        backendPid: client.processID,
      });
      if (batch) {
        const level = req.headers['neon-batch-isolation-level'];
        assert.ok(level === undefined || Object.hasOwn(isolation, level));
        let begin = 'BEGIN';
        if (level !== undefined) begin += ` ISOLATION LEVEL ${isolation[level]}`;
        for (const [header, yes, no] of [
          ['neon-batch-read-only', 'READ ONLY', 'READ WRITE'],
          ['neon-batch-deferrable', 'DEFERRABLE', 'NOT DEFERRABLE'],
        ]) {
          const value = req.headers[header];
          assert.ok(value === undefined || value === 'true' || value === 'false');
          if (value !== undefined) begin += ` ${value === 'true' ? yes : no}`;
        }
        record.begin = begin;
        await client.query(begin);
        transaction = true;
      }
      for (const query of queries) {
        // Every submitted statement and every serialized parameter reaches PG unchanged.
        const result = await client.query({ text: query.query, values: query.params, rowMode: 'array' });
        assert.ok(!Array.isArray(result), 'Fixture admits one statement per native query');
        record.results.push({
          fields: result.fields,
          rows: result.rows,
          command: result.command,
          rowCount: result.rowCount,
          rowAsArray: true,
        });
      }
      if (transaction) await client.query('COMMIT');
      transaction = false;
      record.outcome = 'committed';
      // A barrier can delay HTTP delivery after a real commit for cancellation evidence.
      await bridge.onExecuted?.(record);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(batch ? { results: record.results } : record.results[0]));
    } catch (error) {
      if (transaction) {
        await client.query('ROLLBACK');
        record.outcome = 'rolled-back';
      }
      if (record) record.error = { message: error.message, code: error.code, where: error.where };
      const value = { message: error.message };
      for (const key of [
        'severity',
        'code',
        'detail',
        'hint',
        'position',
        'internalPosition',
        'internalQuery',
        'schema',
        'table',
        'column',
        'dataType',
        'constraint',
        'file',
        'line',
        'routine',
      ])
        if (error[key] !== undefined) value[key] = error[key];
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    } finally {
      if (client) {
        await client.end();
        clients.delete(client);
      }
    }
  }
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  bridge.port = server.address().port;
  bridge.endpoint = `http://127.0.0.1:${bridge.port}/sql`;
  bridge.drain = async () => {
    while (active.size) await Promise.allSettled([...active]);
  };
  bridge.close = async () => {
    await bridge.drain();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    assert.equal(clients.size, 0);
    bridge.closed = true;
    bridge.portClosed = await new Promise((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port: bridge.port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('error', (error) => {
        socket.destroy();
        resolve(error.code === 'ECONNREFUSED');
      });
    });
    assert.equal(bridge.portClosed, true);
    assert.deepEqual(errors, [], 'No hidden bridge infrastructure failures');
  };
  return bridge;
}
