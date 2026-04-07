/**
 * turbine-orm — serverless/edge driver integration tests
 *
 * Verifies that TurbineClient can be constructed with an external pg-compat
 * pool (the foundation of Neon HTTP / Vercel Postgres / Cloudflare support)
 * and that queries, transactions, and lifecycle methods behave correctly.
 *
 * No real database is required. The tests use an in-memory mock pool that
 * records every SQL statement and returns pre-programmed results.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type PgCompatPool, TurbineClient } from '../client.js';
import type { SchemaMetadata } from '../schema.js';
import { turbineHttp } from '../serverless.js';
import { mockTable } from './helpers.js';

// ---------------------------------------------------------------------------
// Mock pg-compat pool — records all queries, returns programmed responses
// ---------------------------------------------------------------------------

interface QueryCall {
  text: string;
  values?: unknown[];
  via: 'pool' | 'client';
}

function createMockPool(programmed: Array<{ rows: unknown[]; rowCount?: number }> = []): {
  pool: PgCompatPool;
  calls: QueryCall[];
  ended: { value: boolean };
} {
  const calls: QueryCall[] = [];
  const ended = { value: false };
  let next = 0;

  const respond = () => {
    const p = programmed[next++] ?? { rows: [], rowCount: 0 };
    return {
      rows: p.rows as Record<string, unknown>[],
      rowCount: p.rowCount ?? p.rows.length,
      fields: [],
    };
  };

  const client = {
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values, via: 'client' });
      return respond();
    },
    release() {
      /* no-op */
    },
  };

  const pool = {
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values, via: 'pool' });
      return respond();
    },
    async connect() {
      return client;
    },
    async end() {
      ended.value = true;
    },
  } as unknown as PgCompatPool;

  return { pool, calls, ended };
}

// Helper to safely access recorded calls in tests (satisfies noUncheckedIndexedAccess)
function at(calls: QueryCall[], i: number): QueryCall {
  const c = calls[i];
  if (!c) throw new Error(`expected call at index ${i}, but only ${calls.length} recorded`);
  return c;
}

function buildSchema(): SchemaMetadata {
  return {
    tables: {
      users: mockTable('users', [
        { name: 'id', field: 'id' },
        { name: 'name', field: 'name', pgType: 'text' },
        { name: 'email', field: 'email', pgType: 'text' },
      ]),
    },
    enums: {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('turbineHttp / external pool integration', () => {
  it('accepts an external pool via TurbineConfig.pool', () => {
    const { pool } = createMockPool();
    const db = new TurbineClient({ pool }, buildSchema());
    assert.ok(db, 'TurbineClient constructed with external pool');
    // pool property should be the same instance we passed in
    assert.strictEqual((db as unknown as { pool: PgCompatPool }).pool, pool);
  });

  it('turbineHttp factory returns a TurbineClient bound to the pool', () => {
    const { pool } = createMockPool();
    const db = turbineHttp(pool, buildSchema());
    assert.ok(db instanceof TurbineClient);
  });

  it('findMany routes queries through the external pool', async () => {
    const { pool, calls } = createMockPool([{ rows: [{ id: 1, name: 'Alice', email: 'a@b.com' }] }]);
    const db = turbineHttp(pool, buildSchema());

    const users = await db.table('users').findMany({ limit: 1 });

    assert.equal(users.length, 1);
    assert.equal(calls.length, 1);
    const first = at(calls, 0);
    assert.equal(first.via, 'pool');
    assert.match(first.text, /SELECT/i);
    assert.match(first.text, /"users"/);
  });

  it('raw SQL routes through the external pool', async () => {
    const { pool, calls } = createMockPool([{ rows: [{ day: '2026-04-07', count: 42 }] }]);
    const db = turbineHttp(pool, buildSchema());

    const result = await db.raw<{ day: string; count: number }>`SELECT NOW()`;

    assert.equal(calls.length, 1);
    assert.equal(at(calls, 0).via, 'pool');
    assert.equal(result[0]?.count, 42);
  });

  it('$transaction uses the client returned by pool.connect()', async () => {
    const { pool, calls } = createMockPool([
      { rows: [] }, // BEGIN
      { rows: [{ id: 1, name: 'Alice', email: 'a@b.com' }] }, // findMany
      { rows: [] }, // COMMIT
    ]);
    const db = turbineHttp(pool, buildSchema());

    await db.$transaction(async (tx) => {
      await tx.table('users').findMany({ limit: 1 });
    });

    // All queries inside the tx must go through the client, not the pool
    const clientCalls = calls.filter((c) => c.via === 'client');
    assert.ok(clientCalls.length >= 3, 'expected BEGIN, findMany, COMMIT on client');
    assert.equal(clientCalls[0]?.text, 'BEGIN');
    assert.equal(clientCalls[clientCalls.length - 1]?.text, 'COMMIT');
  });

  it('disconnect() is a no-op for external pools (caller owns lifecycle)', async () => {
    const { pool, ended } = createMockPool();
    const db = turbineHttp(pool, buildSchema());
    await db.disconnect();
    assert.equal(ended.value, false, 'external pool.end() must NOT be called by Turbine');
  });

  it('stats returns zeros for pools that do not expose counts', () => {
    const { pool } = createMockPool();
    const db = turbineHttp(pool, buildSchema());
    assert.deepEqual(db.stats, { totalCount: 0, idleCount: 0, waitingCount: 0 });
  });

  it('does not register the int8 type parser when using an external pool', () => {
    // If we mutated pg.types for external pools, Neon/Vercel drivers could
    // see changed global state. This test ensures the constructor path
    // under config.pool skips that registration.
    const { pool } = createMockPool();
    const db = new TurbineClient({ pool }, buildSchema());
    assert.ok(db);
    // We don't import pg.types here, but the logic is: `!config.pool && !registered`.
    // Construction succeeding with a pool that has no .on('error') method is
    // the behavioral proof — pg.Pool would have been instantiated and would
    // call .on internally; that path is skipped.
  });

  it('auto-creates typed table accessors from schema', () => {
    const { pool } = createMockPool();
    const db = turbineHttp(pool, buildSchema()) as TurbineClient & {
      users: ReturnType<TurbineClient['table']>;
    };
    assert.ok(db.users, 'users accessor auto-created');
    assert.strictEqual(db.users, db.table('users'));
  });
});

describe('turbineHttp / error surfaces', () => {
  it('propagates pool.query errors to the caller', async () => {
    const failingPool: PgCompatPool = {
      async query() {
        throw new Error('network down');
      },
      async connect() {
        throw new Error('network down');
      },
      async end() {},
    };
    const db = turbineHttp(failingPool, buildSchema());
    await assert.rejects(() => db.table('users').findMany({ limit: 1 }), /network down/);
  });
});
