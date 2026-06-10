/**
 * turbine-orm — LISTEN/NOTIFY ($listen / $notify) tests
 *
 * Two layers:
 *
 *  1. **Unit (no DB).**
 *       - $notify issues `SELECT pg_notify($1, $2)` with BOUND [channel, payload]
 *         params via a mock pool;
 *       - $notify rejects an invalid channel with ValidationError;
 *       - $listen rejects an invalid channel with ValidationError BEFORE
 *         touching the pool (no connect() call).
 *
 *  2. **Integration (needs DATABASE_URL).** Real end-to-end:
 *       - $listen('w3_test_chan', handler), then $notify the same channel and
 *         assert the handler fires with the payload within ~2s;
 *       - after unsubscribe(), a subsequent $notify does NOT fire the handler;
 *       - the dedicated connection is cleaned up (disconnect() doesn't hang).
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/realtime.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TurbineClient } from '../client.js';
import { ValidationError } from '../errors.js';
import { introspect } from '../introspect.js';
import { validateChannel } from '../realtime.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const MOCK_SCHEMA: SchemaMetadata = {
  tables: {
    widgets: {
      name: 'widgets',
      columns: {
        id: { name: 'id', type: 'number', dbType: 'int4', nullable: false, isPrimaryKey: true, hasDefault: true },
      },
      primaryKey: ['id'],
      relations: {},
      indexes: [],
    },
  },
} as unknown as SchemaMetadata;

// ---------------------------------------------------------------------------
// Unit — no DB
// ---------------------------------------------------------------------------

describe('realtime validation (unit)', () => {
  it('validateChannel accepts plain identifiers', () => {
    assert.doesNotThrow(() => validateChannel('order_created'));
    assert.doesNotThrow(() => validateChannel('_private'));
    assert.doesNotThrow(() => validateChannel('chan123'));
  });

  it('validateChannel rejects bad channels', () => {
    assert.throws(() => validateChannel(''), ValidationError);
    assert.throws(() => validateChannel('1bad'), ValidationError);
    assert.throws(() => validateChannel('has space'), ValidationError);
    assert.throws(() => validateChannel('drop";--'), ValidationError);
    assert.throws(() => validateChannel('a.b'), ValidationError); // no namespacing for channels
    assert.throws(() => validateChannel('x'.repeat(64)), ValidationError); // too long
  });
});

describe('$notify (unit)', () => {
  it('issues SELECT pg_notify($1,$2) with bound [channel, payload]', async () => {
    const captured: { sql: string; params: unknown[] }[] = [];
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        captured.push({ sql, params: params ?? [] });
        return { rows: [], rowCount: 1 };
      },
      connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
      end: async () => {},
    };
    const db = new TurbineClient({ pool: pool as never }, MOCK_SCHEMA);

    await db.$notify('order_created', 'hello');
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.sql, 'SELECT pg_notify($1, $2)');
    assert.deepEqual(captured[0]!.params, ['order_created', 'hello']);
  });

  it('defaults payload to empty string', async () => {
    const captured: { sql: string; params: unknown[] }[] = [];
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        captured.push({ sql, params: params ?? [] });
        return { rows: [], rowCount: 1 };
      },
      connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
      end: async () => {},
    };
    const db = new TurbineClient({ pool: pool as never }, MOCK_SCHEMA);
    await db.$notify('ping');
    assert.deepEqual(captured[0]!.params, ['ping', '']);
  });

  it('rejects an invalid channel with ValidationError (no query)', async () => {
    let queried = false;
    const pool = {
      query: async () => {
        queried = true;
        return { rows: [], rowCount: 0 };
      },
      connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
      end: async () => {},
    };
    const db = new TurbineClient({ pool: pool as never }, MOCK_SCHEMA);
    await assert.rejects(() => db.$notify('bad channel!'), ValidationError);
    assert.equal(queried, false, 'no query should be issued for an invalid channel');
  });
});

describe('$listen (unit)', () => {
  it('rejects an invalid channel BEFORE touching the pool', async () => {
    let connected = false;
    const pool = {
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => {
        connected = true;
        return { query: async () => ({ rows: [] }), release: () => {}, on: () => {} };
      },
      end: async () => {},
    };
    const db = new TurbineClient({ pool: pool as never }, MOCK_SCHEMA);
    await assert.rejects(() => db.$listen('1bad', () => {}), ValidationError);
    assert.equal(connected, false, 'pool.connect() must NOT be called for an invalid channel');
  });

  it('quotes the channel and runs LISTEN on a dedicated client', async () => {
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      },
      on: () => {},
      removeListener: () => {},
      release: () => {},
    };
    const pool = {
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => client,
      end: async () => {},
    };
    const db = new TurbineClient({ pool: pool as never }, MOCK_SCHEMA);
    const sub = await db.$listen('order_created', () => {});
    assert.equal(sub.channel, 'order_created');
    assert.ok(queries.includes('LISTEN "order_created"'), 'LISTEN must be quoted');
    await sub.unsubscribe();
    assert.ok(queries.includes('UNLISTEN "order_created"'), 'unsubscribe must UNLISTEN (quoted)');
  });
});

// ---------------------------------------------------------------------------
// Integration — needs DATABASE_URL
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping realtime integration tests: DATABASE_URL not set');
}
const testFn = describe;

testFn('realtime integration (LISTEN/NOTIFY)', () => {
  // Without DATABASE_URL these tests register as skipped (visible in the
  // reporter summary) and the before/after hooks become no-ops.
  const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');
  let client: TurbineClient;
  let schema: SchemaMetadata;

  before(async () => {
    schema = await introspect({ connectionString: DATABASE_URL! });
    client = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 4 }, schema);
    await client.connect();
  });

  after(async () => {
    await client.disconnect();
  });

  it('$listen receives a $notify payload within 2s', async () => {
    let resolveFired!: (payload: string) => void;
    const fired = new Promise<string>((resolve) => {
      resolveFired = resolve;
    });
    const sub = await client.$listen('w3_test_chan', (payload) => resolveFired(payload));

    // Give the LISTEN a moment to register on the backend, then notify.
    await new Promise((r) => setTimeout(r, 100));
    await client.$notify('w3_test_chan', 'hello');

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('handler did not fire within 2s')), 2000),
    );
    const payload = await Promise.race([fired, timeout]);
    assert.equal(payload, 'hello');

    await sub.unsubscribe();
  });

  it('after unsubscribe, a subsequent notify does NOT fire the handler', async () => {
    let calls = 0;
    const sub = await client.$listen('w3_test_chan2', () => {
      calls++;
    });
    await new Promise((r) => setTimeout(r, 100));
    await sub.unsubscribe();

    await client.$notify('w3_test_chan2', 'should-not-arrive');
    // Wait long enough that a notification would have arrived if still subscribed.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(calls, 0, 'handler must not fire after unsubscribe');
  });

  it('disconnect() does not hang with an open subscription', async () => {
    const local = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 2 }, schema);
    await local.$listen('w3_test_chan3', () => {});
    // Intentionally do NOT unsubscribe — disconnect() must force-release it.
    await local.disconnect();
    assert.ok(true, 'disconnect() resolved without hanging');
  });
});
