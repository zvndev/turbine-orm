/** Real mysql2 transport against a synthetic wire fixture, not an SQL engine. */
import assert from 'node:assert/strict';
import type { EventEmitter } from 'node:events';
import type { Server, Socket } from 'node:net';
import { it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import mysql from 'mysql2';
import { MysqlPool } from '../mysql.js';

interface WireConnection extends EventEmitter {
  stream: Socket;
  sequenceId: number;
  handlePacket(packet: { sequenceId: number }): unknown;
  serverHandshake(config: Record<string, unknown>): void;
  writeOk(): void;
  writeColumns(columns: Record<string, unknown>[]): void;
  writeTextRow(values: string[]): void;
  writeEof(): void;
}
interface WireServer extends EventEmitter {
  _server: Server;
  listen(port: number, host: string, callback: () => void): void;
  close(callback: () => void): void;
}
interface WireCommand extends EventEmitter {
  _rows: unknown[][];
}

it('real mysql2 rows backpressure without result arrays; transaction discard and full drain remain usable', {
  timeout: 10000,
}, async () => {
  const server = mysql.createServer(() => {}) as unknown as WireServer;
  const sockets = new Set<Socket>();
  server.on('connection', (connection: WireConnection) => {
    sockets.add(connection.stream);
    connection.stream.on('close', () => sockets.delete(connection.stream));
    connection.on('error', () => {});
    // mysql2's fixture server retains its handshake command. Reset incoming
    // command sequence numbers as an actual server does between statements.
    const handle = connection.handlePacket;
    connection.handlePacket = function (packet) {
      if (packet?.sequenceId === 0) this.sequenceId = 0;
      return handle.call(this, packet);
    };
    connection.serverHandshake({
      protocolVersion: 10,
      serverVersion: '8.0.36-fixture',
      connectionId: 123,
      statusFlags: 2,
      characterSet: 45,
      capabilityFlags: 0xf7ff,
    });
    connection.on('query', (sql: string) => {
      if (/^START TRANSACTION|^COMMIT|^ROLLBACK/i.test(sql)) {
        connection.writeOk();
        return;
      }
      const common = { catalog: 'def', schema: 'fixture', table: 'items', orgTable: 'items', flags: 0, decimals: 0 };
      connection.writeColumns([
        { ...common, name: 'id', orgName: 'id', characterSet: 63, columnLength: 11, columnType: 3 },
        { ...common, name: 'flag', orgName: 'flag', characterSet: 63, columnLength: 1, columnType: 1 },
        { ...common, name: 'payload', orgName: 'payload', characterSet: 45, columnLength: 4096, columnType: 253 },
      ]);
      for (let id = 1; id <= 2507; id++) connection.writeTextRow([String(id), String(id % 2), 'x'.repeat(2048)]);
      connection.writeEof();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server._server.address();
  assert.ok(address && typeof address === 'object');
  const native = mysql.createPool({
    host: '127.0.0.1',
    port: address.port,
    user: 'fixture',
    connectionLimit: 1,
    namedPlaceholders: true,
  });
  let produced = 0;
  const commands: WireCommand[] = [];
  native.on('connection', (connection) => {
    const query = connection.query;
    connection.query = ((...args: unknown[]) => {
      const command = Reflect.apply(query, connection, args) as WireCommand;
      if (typeof args[1] !== 'function' && typeof args[0] === 'string' && /^SELECT/i.test(args[0])) {
        commands.push(command);
        command.on('result', () => produced++);
      }
      return command;
    }) as unknown as typeof query;
  });
  const pool = new MysqlPool(native.promise());
  try {
    const c = await pool.connect();
    const stream = c.streamBatches!('SELECT fixture_rows', [], 7);
    const first = (await stream.next()).value!;
    assert.equal(first.length, 7);
    assert.deepEqual(
      first.map((row) => row.id),
      [1, 2, 3, 4, 5, 6, 7],
    );
    assert.equal(first[0]!.flag, true);
    assert.equal(first[1]!.flag, false);
    await delay(20);
    assert.ok(produced >= 7 && produced <= 8, `native driver produced ${produced} rows for a seven-row batch`);
    assert.equal(commands.length, 1);
    assert.equal(commands[0]!._rows[0]!.length, 0, 'mysql2 must not retain materialized result rows');
    await stream.return(undefined);
    c.release();

    const tx = await pool.connect();
    await tx.query('START TRANSACTION');
    const partial = tx.streamBatches!('SELECT fixture_rows', [], 11);
    assert.equal((await partial.next()).value!.length, 11);
    await partial.return(undefined);
    await tx.query('COMMIT');
    tx.release();

    const drain = await pool.connect();
    let expected = 1;
    for await (const batch of drain.streamBatches!('SELECT fixture_rows', [], 1001)) {
      for (const row of batch) assert.equal(row.id, expected++);
    }
    assert.equal(expected, 2508);
    drain.release();
  } finally {
    await pool.end();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(resolve));
  }
});
