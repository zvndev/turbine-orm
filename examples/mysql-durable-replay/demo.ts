import assert from 'node:assert/strict';
import { createPool } from 'mysql2/promise';
import { openOrderApplication } from './application.js';
const port = Number(process.env.MYSQL_PORT);
const pool = createPool({
  host: '127.0.0.1',
  port,
  user: 'root',
  database: process.env.MYSQL_DATABASE,
  namedPlaceholders: true,
  supportBigNumbers: true,
  bigNumberStrings: true,
  waitForConnections: false,
  connectionLimit: 4,
  connectTimeout: 1000,
});
const app = await openOrderApplication({ pool });
try {
  await app.initialize();
  const command = {
    eventId: 'demo',
    orderId: 'demo-order',
    title: null,
    quantity: '9007199254740993',
    amount: '10.000',
    occurredAt: '2026-11-07T12:34:56.123456Z',
    body: Buffer.from([0, 255, 128]),
  };
  await app.append('A', command);
  assert.equal(
    await app.consumeBatch('A', 'mail', async (event, signal) => {
      await app.deliverToInbox('mail', event, signal);
    }),
    1,
  );
  assert.deepEqual(await app.projection('A', 'mail'), [{ tenant: 'A', consumer: 'mail', delivered: 1 }]);
  console.log(JSON.stringify({ finiteDemo: true, exact: true, destination: 1 }));
} finally {
  await app.close();
  await pool.query('SELECT 1');
  await pool.end();
}
