import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool, type RowDataPacket } from 'mysql2/promise';
import pg from 'pg';
import { openOrderRelay } from './application.js';

async function main() {
  assert.ok(process.env.DATABASE_URL && process.env.MYSQL_DATABASE && process.env.SOURCE_HISTORY_ID);
  const schema = process.env.PG_SCHEMA;
  assert.ok(schema, 'PG_SCHEMA names a fresh owned schema');
  const sourcePool = new pg.Pool({
    connectionString: process.env.DATABASE_URL, max: 6,
    connectionTimeoutMillis: 1000, query_timeout: 3000, statement_timeout: 2500,
  });
  const targetPool = createPool({
    host: '127.0.0.1', port: Number(process.env.MYSQL_PORT), user: 'root', database: process.env.MYSQL_DATABASE,
    namedPlaceholders: true, supportBigNumbers: true, bigNumberStrings: true,
    waitForConnections: false, connectionLimit: 4, connectTimeout: 1000,
  });
  const stop = new AbortController();
  const abort = () => stop.abort(new Error('Demo interrupted'));
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  let relay: Awaited<ReturnType<typeof openOrderRelay>> | undefined;
  try {
    relay = await openOrderRelay({
      sourcePool, targetPool, schema, sourceHistoryId: process.env.SOURCE_HISTORY_ID,
      consumer: 'mail', endpoint: 'direct', onDiagnostic: console.error,
    });
    await relay.initialize();
    await relay.append('tenant_A', {
      eventId: randomUUID(), orderId: randomUUID(), title: 'é雪💧', quantity: '9007199254740993',
      amount: '12345678901234567890.123456789012', occurredAt: '2026-11-07T12:34:56.123456Z',
      body: Buffer.from([0, 255, 128, 39, 92]),
    }, stop.signal);
    assert.equal(await relay.relayBatch('tenant_A', stop.signal), 1);
    assert.equal(await relay.reconcile('tenant_A', { maxBatches: 2, intervalMs: 10 }, stop.signal), 0);
    const [rows] = await targetPool.query<(RowDataPacket & { delivered: number })[]>(
      'SELECT delivered FROM mail_projection WHERE tenant=? AND consumer=?', ['tenant_A', relay.binding],
    );
    assert.equal(rows[0]!.delivered, 1);
    console.log(JSON.stringify({ finiteDemo: true, committedProjection: 1, repeatedRemaining: 0 }));
  } finally {
    try {
      await relay?.close();
      await sourcePool.query('SELECT 1');
      await targetPool.query('SELECT 1');
    } finally {
      await Promise.allSettled([sourcePool.end(), targetPool.end()]);
      process.off('SIGINT', abort);
      process.off('SIGTERM', abort);
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
