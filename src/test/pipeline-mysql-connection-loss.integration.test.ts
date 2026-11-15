/** A committed independent MySQL write with a lost answer needs an unknown-outcome slot. Fails until fixed. */
import assert from 'node:assert/strict';
import net from 'node:net';
import { PipelineError, TransactionOutcomeUnknownError } from '../errors.js';
import { turbineMysql } from '../mysql.js';
import { skipGate } from './helpers.js';

const url = process.env.MYSQL_URL ?? '';
const { it } = skipGate(!url, 'requires MYSQL_URL pointing at disposable MySQL');

it('classifies a committed MySQL pipeline slot whose answer was lost as unknown', async () => {
  const mysql = await import('mysql2/promise');
  const admin = await mysql.createConnection(url);
  const table = `pipeline_mysql_loss_${process.pid}`;
  await admin.query(`CREATE TABLE ${table} (n integer)`);
  const target = new URL(url);
  const sockets = new Set<net.Socket>();
  let blocked = false;
  const proxy = net.createServer((client) => {
    const upstream = net.connect(Number(target.port || 3306), target.hostname);
    sockets.add(client).add(upstream);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    for (const socket of [client, upstream]) {
      socket.on('error', close);
      socket.on('close', close);
    }
    client.on('data', (chunk: Buffer) => {
      if (chunk.includes(`INSERT INTO ${table}`)) blocked = true;
      upstream.write(chunk);
    });
    upstream.on('data', (chunk: Buffer) => {
      if (!blocked) client.write(chunk);
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const endpoint = new URL(url);
  endpoint.host = `127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
  const db = await turbineMysql(endpoint.href, { tables: {}, enums: {} });
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = db
      .pipeline(
        [
          { sql: `INSERT INTO ${table} VALUES (1)`, params: [], tag: 'write', transform: (raw) => raw.rowCount },
          { sql: 'SELECT 2 AS n', params: [], tag: 'after', transform: (raw) => raw.rows },
        ],
        { transactional: false },
      )
      .catch((error: unknown) => error);
    let durable = false;
    for (let i = 0; i < 200; i++) {
      const [rows] = await admin.query(`SELECT count(*) AS n FROM ${table}`);
      if ((rows as { n: number }[])[0]?.n === 1) {
        durable = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    for (const socket of sockets) socket.destroy();
    assert.ok(durable, 'the INSERT committed before its response was lost');
    const error = await Promise.race([
      pending,
      new Promise((resolve) => {
        watchdog = setTimeout(() => resolve('pipeline did not settle after connection loss'), 2000);
      }),
    ]);
    assert.ok(error instanceof PipelineError, `got ${String(error)}`);
    const [write, after] = error.results;
    assert.ok(
      write?.status === 'error' && write.error instanceof TransactionOutcomeUnknownError,
      `the sent write must be E021, got ${write?.status === 'error' ? write.error.message : 'success'}`,
    );
    assert.equal(after?.status === 'error' && (after.error as { code?: string }).code, 'TURBINE_E004');
  } finally {
    clearTimeout(watchdog);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await db.disconnect();
    await admin.query(`DROP TABLE ${table}`);
    await admin.end();
  }
});
