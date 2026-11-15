import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { defineSchema, schemaDefToMetadata, TurbineClient } from 'turbine-orm';
import { createApplication } from './application.js';

async function main() {
  const endpoint = process.env.NOTIFICATION_ENDPOINT;
  if (endpoint !== 'direct' && endpoint !== 'session-pool') {
    throw new Error(
      'Assert NOTIFICATION_ENDPOINT=direct or session-pool. Transaction pooling and stateless HTTP cannot LISTEN.',
    );
  }
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required');
  const name = `live_orders_${randomBytes(6).toString('hex')}`;
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 2000,
    query_timeout: 3000,
    statement_timeout: 2500,
  });
  const application = createApplication({
    pool,
    endpoint,
    channel: name,
    onDiagnostic: (error) => console.error('Listener retry diagnostic:', error.message),
  });
  const db = new TurbineClient(
    { pool, diagnostics: { advice: false } },
    schemaDefToMetadata(
      defineSchema({
        [name]: {
          id: { type: 'integer', primaryKey: true },
          tenantId: { type: 'integer', notNull: true },
          title: { type: 'text', notNull: true },
        },
      }),
    ),
  );
  const request = new AbortController();
  const interrupted = () => request.abort();
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  let created = false;
  try {
    await pool.query(
      `CREATE TABLE "${name}" (id integer PRIMARY KEY, tenant_id integer NOT NULL, title text NOT NULL)`,
    );
    created = true;
    // In a server, obtain this from authenticated request context, never NOTIFY payloads.
    const tenantId = 7;
    const query = () =>
      db.table<{ id: number; tenantId: number; title: string }>(name).findMany({
        where: { tenantId },
        select: { id: true, title: true },
        orderBy: { id: 'asc' },
        limit: 100,
      });
    const first = application.watch(query, request.signal);
    const sibling = application.watch(query, request.signal);
    assert.deepEqual((await first.next()).value, []);
    assert.deepEqual((await sibling.next()).value, []);
    // Real writers should notify in the same transaction (or use a database trigger).
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(`INSERT INTO "${name}" VALUES (1, 7, 'packed order'), (2, 8, 'other tenant')`);
      await writer.query('SELECT pg_notify($1, $2)', [name, 'invalidate']);
      await writer.query('COMMIT');
    } catch (error) {
      await writer.query('ROLLBACK');
      throw error;
    } finally {
      writer.release();
    }
    const expected = [{ id: 1, title: 'packed order' }];
    assert.deepEqual((await first.next()).value, expected);
    await first.dispose(); // Sibling subscription keeps the shared listener alive.
    assert.deepEqual((await sibling.next()).value, expected);
    assert.equal(application.hub.stats.subscriptions, 1);
    // Await a send before pulling again. LiveQuery retains only its newest clean snapshot.
    console.log(JSON.stringify({ snapshots: expected, siblingAlive: true, subscriptions: 1 }));
    request.abort();
    await sibling.closed;
  } finally {
    request.abort();
    try {
      await application.close();
    } finally {
      try {
        await db.disconnect(); // External pool remains caller-owned.
        if (created) await pool.query(`DROP TABLE "${name}"`);
      } finally {
        await pool.end();
        process.off('SIGINT', interrupted);
        process.off('SIGTERM', interrupted);
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
