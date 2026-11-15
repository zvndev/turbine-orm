import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createOrderApplication, type OrderCommand } from './application.js';

async function main() {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required');
  const endpoint = process.env.NOTIFICATION_ENDPOINT;
  if (endpoint !== 'direct' && endpoint !== 'session-pool')
    throw new Error('Assert a direct or session-pool listener endpoint');
  const schema = `replay_${randomBytes(6).toString('hex')}`;
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 6,
    connectionTimeoutMillis: 1500,
    query_timeout: 3000,
    statement_timeout: 2500,
  });
  pool.on('error', (error) => console.error(error));
  const app = createOrderApplication({ pool, schema, endpoint, onDiagnostic: (error) => console.error(error) });
  const controller = new AbortController();
  let interrupted!: () => void;
  const signalReceived = new Promise<void>((yes) => {
    interrupted = yes;
  });
  const stop = () => {
    controller.abort();
    interrupted();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const order: OrderCommand = {
    eventId: randomUUID(),
    orderId: randomUUID(),
    title: 'durable order',
    quantity: '9007199254740993',
    amount: '12345678901234567890.123456789012',
    occurredAt: '2026-11-07T12:34:56.123456Z',
    body: Buffer.from([0, 255, 128]),
  };
  let initialized = false;
  try {
    await app.initialize();
    initialized = true;
    await app.append('tenant-7', order);
    if (process.env.REPLAY_WAIT_FOR_SIGNAL === '1') {
      const progress = app.watchProgress(
        'tenant-7',
        'mail',
        async (_event, signal) => {
          console.log(JSON.stringify({ readyForSignal: true, schema }));
          // A real request passes this signal to its bounded delivery API.
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', () => resolve(), { once: true });
          });
        },
        controller.signal,
      );
      await Promise.race([signalReceived, progress.closed]);
      await progress.dispose();
    } else {
      // External delivery uses a stable tenant/consumer/eventId idempotency key.
      // A real service persists this at its destination, not in this in-memory demo set.
      const delivered: string[] = [];
      assert.equal(
        await app.consumeBatch('tenant-7', 'mail', (event) => {
          assert.equal(event.quantity, order.quantity);
          assert.equal(event.amount, order.amount);
          assert.equal(event.occurredAt, order.occurredAt);
          assert.deepEqual(event.body, order.body);
          delivered.push(event.eventId);
        }),
        1,
      );
      await app.close();
      const restarted = createOrderApplication({
        pool,
        schema,
        endpoint,
        onDiagnostic: (error) => console.error(error),
      });
      try {
        assert.equal(await restarted.consumeBatch('tenant-7', 'mail', () => assert.fail('Already checkpointed')), 0);
      } finally {
        await restarted.close();
      }
      console.log(
        JSON.stringify({ delivered: delivered.length, restartRemaining: 0, callerPoolSurvived: !pool.ending }),
      );
    }
  } finally {
    controller.abort();
    try {
      await app.close();
    } finally {
      try {
        assert.equal((await pool.query('SELECT 42 AS answer')).rows[0]!.answer, 42);
        if (initialized) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await pool.end();
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
      }
    }
    if (process.env.REPLAY_WAIT_FOR_SIGNAL === '1')
      console.log(JSON.stringify({ signalCleanup: true, poolClosedByCaller: pool.totalCount === 0 }));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
