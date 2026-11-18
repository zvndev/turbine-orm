/**
 * prisma-compat client lifecycle on a real Postgres: `$connect` opens a
 * connection and `$disconnect` closes the wrapped client's pool. Gated on
 * `DATABASE_URL`.
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { TurbineClient } from '../client.js';
import { createPrismaCompatClient } from '../prisma-compat.js';
import { skipGate } from './helpers.js';

const url = process.env.DATABASE_URL;
const { it } = skipGate(!url, 'DATABASE_URL not set');

const MAP = { enums: {}, models: {} };

describe('prisma-compat $connect / $disconnect (real Postgres)', () => {
  it('$disconnect ends the pool, once, for the client and its extensions', async () => {
    const db = new TurbineClient({ connectionString: url ?? '' }, { enums: {}, tables: {} });
    const compat = createPrismaCompatClient(db, MAP);
    const extended = compat.$extends({ client: { $hello: () => 'hi' } });
    await compat.$connect();
    assert.deepEqual(await compat.$queryRaw`SELECT 1::int AS one`, [{ one: 1 }]);
    const pool = (db as unknown as { pool: { ended?: boolean; ending?: boolean } }).pool;
    assert.equal(pool.ended || pool.ending, false, 'the pool is open before');
    await compat.$disconnect();
    assert.ok(pool.ended || pool.ending, 'the pool is closed after');
    // Idempotent, and the extended client shares the same close.
    await compat.$disconnect();
    await extended.$disconnect();
    await assert.rejects(compat.$queryRaw`SELECT 1`);
  });

  it('$connect fails on an unreachable database instead of at the first query', async () => {
    const db = new TurbineClient(
      { connectionString: 'postgres://nobody:nothing@127.0.0.1:1/none', connectionTimeoutMs: 2000 },
      { enums: {}, tables: {} },
    );
    const compat = createPrismaCompatClient(db, MAP);
    await assert.rejects(compat.$connect());
    await compat.$disconnect();
  });
});
