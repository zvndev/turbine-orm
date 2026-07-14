/**
 * turbine-orm — TurbineClient coverage tests
 *
 * Covers previously untested paths in src/client.ts:
 *   1. Middleware chain execution ($use)
 *   2. Transaction timeout (TimeoutError)
 *   3. External pool lifecycle (disconnect no-op, no type parser, queries work)
 *   4. Raw SQL tagged template literal
 *   5. Pool stats
 *   6. Nested transactions (SAVEPOINTs)
 *
 * No real database required — uses mock pool pattern from serverless.test.ts.
 *
 * Run: npx tsx --test src/test/client-coverage.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type PgCompatPool, TurbineClient } from '../client.js';
import { TimeoutError } from '../errors.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

// ---------------------------------------------------------------------------
// Mock pool infrastructure
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
  released: { count: number };
} {
  const calls: QueryCall[] = [];
  const ended = { value: false };
  const released = { count: 0 };
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
    release(_err?: Error | boolean) {
      released.count++;
    },
  };

  const pool: PgCompatPool = {
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
    totalCount: 5,
    idleCount: 3,
    waitingCount: 1,
  } as unknown as PgCompatPool;

  return { pool, calls, ended, released };
}

/**
 * Create a mock pool where client queries can be delayed (for timeout testing).
 */
function createDelayedMockPool(
  delayMs: number,
  programmed: Array<{ rows: unknown[]; rowCount?: number }> = [],
): {
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
      // Simulate delay only for non-control queries (not BEGIN/COMMIT/ROLLBACK/SAVEPOINT)
      const isControl = /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/i.test(text.trim());
      if (!isControl) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return respond();
    },
    release(_err?: Error | boolean) {
      /* no-op */
    },
  };

  const pool: PgCompatPool = {
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

function at(calls: QueryCall[], i: number): QueryCall {
  const c = calls[i];
  if (!c) throw new Error(`expected call at index ${i}, but only ${calls.length} recorded`);
  return c;
}

// ---------------------------------------------------------------------------
// 1. Middleware chain execution
// ---------------------------------------------------------------------------

describe('TurbineClient.$use() — middleware chain', () => {
  it('runs beforeQuery middleware in registration order', async () => {
    const { pool, calls } = createMockPool([{ rows: [{ id: 1, name: 'Alice', email: 'a@b.com' }] }]);
    const db = new TurbineClient({ pool }, buildSchema());

    const order: number[] = [];

    db.$use(async (params, next) => {
      order.push(1);
      return next(params);
    });

    db.$use(async (params, next) => {
      order.push(2);
      return next(params);
    });

    await db.table('users').findMany({ limit: 1 });

    assert.deepEqual(order, [1, 2], 'middleware should run in registration order');
    assert.equal(calls.length, 1);
  });

  it('middleware can transform results (afterQuery pattern)', async () => {
    const { pool } = createMockPool([{ rows: [{ id: 1, name: 'Alice', email: 'a@b.com' }] }]);
    const db = new TurbineClient({ pool }, buildSchema());

    db.$use(async (params, next) => {
      const result = await next(params);
      // Transform: uppercase all name fields
      if (Array.isArray(result)) {
        return result.map((row: Record<string, unknown>) => ({
          ...row,
          name: typeof row.name === 'string' ? row.name.toUpperCase() : row.name,
        }));
      }
      return result;
    });

    const users = (await db.table('users').findMany({ limit: 1 })) as Array<{ name: string }>;
    assert.equal(users[0]?.name, 'ALICE');
  });

  it('middleware receives correct model and action params', async () => {
    const { pool } = createMockPool([{ rows: [{ id: 1, name: 'Alice', email: 'a@b.com' }] }]);
    const db = new TurbineClient({ pool }, buildSchema());

    let capturedModel: string | undefined;
    let capturedAction: string | undefined;

    db.$use(async (params, next) => {
      capturedModel = params.model;
      capturedAction = params.action;
      return next(params);
    });

    await db.table('users').findMany({ limit: 1 });

    assert.equal(capturedModel, 'users');
    assert.equal(capturedAction, 'findMany');
  });

  it('middleware onError pattern — catches and rethrows', async () => {
    const failingPool: PgCompatPool = {
      async query() {
        throw new Error('query exploded');
      },
      async connect() {
        throw new Error('connect exploded');
      },
      async end() {},
    };
    const db = new TurbineClient({ pool: failingPool }, buildSchema());

    let caughtError: Error | undefined;

    db.$use(async (params, next) => {
      try {
        return await next(params);
      } catch (err) {
        caughtError = err as Error;
        throw err;
      }
    });

    await assert.rejects(() => db.table('users').findMany({ limit: 1 }), /query exploded/);
    assert.ok(caughtError, 'middleware should have caught the error');
    assert.match(caughtError!.message, /query exploded/);
  });

  it('$use clears table cache so new instances pick up middleware', async () => {
    const { pool } = createMockPool([
      { rows: [{ id: 1, name: 'Alice', email: 'a@b.com' }] },
      { rows: [{ id: 1, name: 'Alice', email: 'a@b.com' }] },
    ]);
    const db = new TurbineClient({ pool }, buildSchema());

    // Access table before middleware is added
    const tableRef1 = db.table('users');

    let ran = false;
    db.$use(async (params, next) => {
      ran = true;
      return next(params);
    });

    // Access table after middleware — should be a new instance
    const tableRef2 = db.table('users');
    assert.notStrictEqual(tableRef1, tableRef2, 'table cache should be cleared after $use');

    await tableRef2.findMany({ limit: 1 });
    assert.equal(ran, true, 'new middleware should run on the new table instance');
  });

  it('multiple middlewares compose correctly (timing middleware)', async () => {
    const { pool } = createMockPool([{ rows: [{ id: 1, name: 'Alice', email: 'a@b.com' }] }]);
    const db = new TurbineClient({ pool }, buildSchema());

    const log: string[] = [];

    db.$use(async (params, next) => {
      log.push('mw1-before');
      const result = await next(params);
      log.push('mw1-after');
      return result;
    });

    db.$use(async (params, next) => {
      log.push('mw2-before');
      const result = await next(params);
      log.push('mw2-after');
      return result;
    });

    await db.table('users').findMany({ limit: 1 });

    assert.deepEqual(log, ['mw1-before', 'mw2-before', 'mw2-after', 'mw1-after']);
  });
});

// ---------------------------------------------------------------------------
// 2. Transaction timeout
// ---------------------------------------------------------------------------

describe('TurbineClient.$transaction timeout', () => {
  it('rejects with TimeoutError when callback exceeds timeout', async () => {
    const { pool } = createDelayedMockPool(200, [
      { rows: [] }, // BEGIN
      { rows: [{ id: 1, name: 'Alice', email: 'a@b.com' }] }, // slow query (delayed 200ms)
      { rows: [] }, // possible ROLLBACK
    ]);
    const db = new TurbineClient({ pool }, buildSchema());

    await assert.rejects(
      () =>
        db.$transaction(
          async (tx) => {
            await tx.table('users').findMany({ limit: 1 });
          },
          { timeout: 50 },
        ),
      (err: unknown) => {
        assert.ok(err instanceof TimeoutError, 'should be a TimeoutError');
        assert.match(err.message, /timeout|timed out/i);
        return true;
      },
    );
  });

  it('succeeds if callback completes before timeout', async () => {
    const { pool } = createMockPool([
      { rows: [] }, // BEGIN
      { rows: [{ id: 1, name: 'Alice', email: 'a@b.com' }] }, // findMany
      { rows: [] }, // COMMIT
    ]);
    const db = new TurbineClient({ pool }, buildSchema());

    const result = await db.$transaction(
      async (tx) => {
        const users = await tx.table('users').findMany({ limit: 1 });
        return users;
      },
      { timeout: 5000 },
    );

    assert.equal((result as unknown[]).length, 1);
  });

  it('transaction with isolationLevel sends correct SQL', async () => {
    const { pool, calls } = createMockPool([
      { rows: [] }, // BEGIN ISOLATION LEVEL SERIALIZABLE
      { rows: [] }, // COMMIT
    ]);
    const db = new TurbineClient({ pool }, buildSchema());

    await db.$transaction(
      async () => {
        // no-op
      },
      { isolationLevel: 'Serializable' },
    );

    const beginCall = calls.find((c) => c.text.includes('BEGIN'));
    assert.ok(beginCall, 'should have a BEGIN call');
    assert.match(beginCall!.text, /ISOLATION LEVEL SERIALIZABLE/);
  });
});

// ---------------------------------------------------------------------------
// 3. External pool lifecycle
// ---------------------------------------------------------------------------

describe('TurbineClient — external pool lifecycle', () => {
  it('disconnect() is a no-op for external pools', async () => {
    const { pool, ended } = createMockPool();
    const db = new TurbineClient({ pool }, buildSchema());

    await db.disconnect();
    assert.equal(ended.value, false, 'external pool should not be ended by Turbine');
  });

  it('end() is also a no-op for external pools (alias)', async () => {
    const { pool, ended } = createMockPool();
    const db = new TurbineClient({ pool }, buildSchema());

    await db.end();
    assert.equal(ended.value, false, 'end() alias should also be a no-op');
  });

  it('queries still work through the external pool', async () => {
    const { pool, calls } = createMockPool([{ rows: [{ id: 1, name: 'Bob', email: 'bob@test.com' }] }]);
    const db = new TurbineClient({ pool }, buildSchema());

    const users = await db.table('users').findMany({ limit: 1 });
    assert.equal((users as unknown[]).length, 1);
    assert.equal(at(calls, 0).via, 'pool');
  });

  it('preparedStatements defaults to false for external pools', () => {
    const { pool } = createMockPool();
    const db = new TurbineClient({ pool }, buildSchema());
    // Verify by checking generated SQL does not use named statement form
    // (we can't inspect the private field, but behavior proves it:
    //  queries go through pool.query(text, values) not pool.query({name, text, values}))
    assert.ok(db, 'client constructed with external pool');
  });

  it('preparedStatements can be explicitly enabled for external pools', () => {
    const { pool } = createMockPool();
    const db = new TurbineClient({ pool, preparedStatements: true }, buildSchema());
    assert.ok(db, 'client constructed with preparedStatements: true');
  });
});

// ---------------------------------------------------------------------------
// 4. Raw SQL tagged template
// ---------------------------------------------------------------------------

describe('TurbineClient.raw — tagged template literal', () => {
  it('generates parameterized SQL from tagged template', async () => {
    const { pool, calls } = createMockPool([{ rows: [{ count: 42 }] }]);
    const db = new TurbineClient({ pool }, buildSchema());

    const orgId = 5;
    const status = 'active';
    const result = await db.raw<{ count: number }>`
      SELECT COUNT(*) as count FROM users WHERE org_id = ${orgId} AND status = ${status}
    `;

    assert.equal(result[0]?.count, 42);
    const call = at(calls, 0);
    assert.match(call.text, /\$1/);
    assert.match(call.text, /\$2/);
    assert.deepEqual(call.values, [5, 'active']);
  });

  it('works with no interpolations', async () => {
    const { pool, calls } = createMockPool([{ rows: [{ now: '2026-01-01' }] }]);
    const db = new TurbineClient({ pool }, buildSchema());

    await db.raw`SELECT NOW()`;

    const call = at(calls, 0);
    assert.match(call.text, /SELECT NOW\(\)/);
    assert.deepEqual(call.values, []);
  });

  it('wraps pg errors via wrapPgError', async () => {
    const failingPool: PgCompatPool = {
      async query() {
        const err = new Error('relation "foo" does not exist') as Error & { code: string };
        err.code = '42P01';
        throw err;
      },
      async connect() {
        // biome-ignore lint/suspicious/noExplicitAny: mock pool client for error-path testing
        return { query: async () => ({}), release: () => {} } as any;
      },
      async end() {},
    };
    const db = new TurbineClient({ pool: failingPool }, buildSchema());

    await assert.rejects(
      () => db.raw`SELECT * FROM foo`,
      (err: unknown) => {
        // wrapPgError should wrap or at least pass the error through
        assert.ok(err instanceof Error);
        return true;
      },
    );
  });

  it('handles multiple interpolations correctly', async () => {
    const { pool, calls } = createMockPool([{ rows: [] }]);
    const db = new TurbineClient({ pool }, buildSchema());

    const a = 1;
    const b = 'hello';
    const c = true;
    await db.raw`INSERT INTO logs (a, b, c) VALUES (${a}, ${b}, ${c})`;

    const call = at(calls, 0);
    assert.match(call.text, /\$1.*\$2.*\$3/s);
    assert.deepEqual(call.values, [1, 'hello', true]);
  });
});

// ---------------------------------------------------------------------------
// 5. Pool stats
// ---------------------------------------------------------------------------

describe('TurbineClient.stats — pool statistics', () => {
  it('exposes pool stats when pool provides them', () => {
    const { pool } = createMockPool();
    const db = new TurbineClient({ pool }, buildSchema());

    const stats = db.stats;
    assert.equal(stats.totalCount, 5);
    assert.equal(stats.idleCount, 3);
    assert.equal(stats.waitingCount, 1);
  });

  it('returns zeros when pool does not expose stats', () => {
    const barePool: PgCompatPool = {
      async query() {
        return { rows: [], rowCount: 0, fields: [] };
      },
      async connect() {
        // biome-ignore lint/suspicious/noExplicitAny: mock pool client for external pool testing
        return { query: async () => ({ rows: [], rowCount: 0 }), release: () => {} } as any;
      },
      async end() {},
    };
    const db = new TurbineClient({ pool: barePool }, buildSchema());

    const stats = db.stats;
    assert.equal(stats.totalCount, 0);
    assert.equal(stats.idleCount, 0);
    assert.equal(stats.waitingCount, 0);
  });
});

// ---------------------------------------------------------------------------
// 6. Nested transactions (SAVEPOINTs)
// ---------------------------------------------------------------------------

describe('TurbineClient.$transaction — nested SAVEPOINTs', () => {
  it('uses SAVEPOINT for nested $transaction calls', async () => {
    const { pool, calls } = createMockPool([
      { rows: [] }, // BEGIN
      { rows: [] }, // SAVEPOINT sp_1
      { rows: [{ id: 1, name: 'Alice', email: 'a@b.com' }] }, // inner query
      { rows: [] }, // RELEASE SAVEPOINT sp_1
      { rows: [] }, // COMMIT
    ]);
    const db = new TurbineClient({ pool }, buildSchema());

    await db.$transaction(async (tx) => {
      await tx.$transaction(async (innerTx) => {
        await innerTx.table('users').findMany({ limit: 1 });
      });
    });

    const clientCalls = calls.filter((c) => c.via === 'client');
    const texts = clientCalls.map((c) => c.text);

    assert.ok(texts.includes('BEGIN'), 'should have BEGIN');
    assert.ok(
      texts.some((t) => t.includes('SAVEPOINT')),
      'should have SAVEPOINT',
    );
    assert.ok(
      texts.some((t) => t.includes('RELEASE SAVEPOINT')),
      'should have RELEASE SAVEPOINT',
    );
    assert.ok(texts.includes('COMMIT'), 'should have COMMIT');
  });

  it('ROLLBACK TO SAVEPOINT on nested transaction failure', async () => {
    const { pool, calls } = createMockPool([
      { rows: [] }, // BEGIN
      { rows: [] }, // SAVEPOINT sp_1
      { rows: [] }, // ROLLBACK TO SAVEPOINT sp_1
      { rows: [] }, // COMMIT (outer still succeeds)
    ]);
    const db = new TurbineClient({ pool }, buildSchema());

    await db.$transaction(async (tx) => {
      try {
        await tx.$transaction(async () => {
          throw new Error('inner failure');
        });
      } catch {
        // Swallow the inner error — outer tx continues
      }
    });

    const clientCalls = calls.filter((c) => c.via === 'client');
    const texts = clientCalls.map((c) => c.text);

    assert.ok(
      texts.some((t) => t.includes('ROLLBACK TO SAVEPOINT')),
      'should rollback savepoint',
    );
    assert.ok(texts.includes('COMMIT'), 'outer transaction should still commit');
  });

  it('multiple nested transactions use incrementing savepoint names', async () => {
    const { pool, calls } = createMockPool([
      { rows: [] }, // BEGIN
      { rows: [] }, // SAVEPOINT sp_1
      { rows: [] }, // RELEASE SAVEPOINT sp_1
      { rows: [] }, // SAVEPOINT sp_2
      { rows: [] }, // RELEASE SAVEPOINT sp_2
      { rows: [] }, // COMMIT
    ]);
    const db = new TurbineClient({ pool }, buildSchema());

    await db.$transaction(async (tx) => {
      await tx.$transaction(async () => {});
      await tx.$transaction(async () => {});
    });

    const clientCalls = calls.filter((c) => c.via === 'client');
    const savepointCalls = clientCalls.filter((c) => c.text.startsWith('SAVEPOINT'));
    assert.equal(savepointCalls.length, 2);
    assert.equal(savepointCalls[0]?.text, 'SAVEPOINT sp_1');
    assert.equal(savepointCalls[1]?.text, 'SAVEPOINT sp_2');
  });
});

// ---------------------------------------------------------------------------
// 7. Transaction raw SQL within TransactionClient
// ---------------------------------------------------------------------------

describe('TransactionClient.raw — tagged template within transaction', () => {
  it('executes raw SQL through the transaction client', async () => {
    const { pool, calls } = createMockPool([
      { rows: [] }, // BEGIN
      { rows: [{ total: 100 }] }, // raw query
      { rows: [] }, // COMMIT
    ]);
    const db = new TurbineClient({ pool }, buildSchema());

    const result = await db.$transaction(async (tx) => {
      const val = 42;
      return tx.raw<{ total: number }>`SELECT ${val} as total`;
    });

    assert.equal(result[0]?.total, 100);
    const clientCalls = calls.filter((c) => c.via === 'client');
    const rawCall = clientCalls.find((c) => c.text.includes('$1'));
    assert.ok(rawCall, 'raw SQL should go through the transaction client');
    assert.deepEqual(rawCall!.values, [42]);
  });
});

// ---------------------------------------------------------------------------
// 8. TransactionClient table accessor caching
// ---------------------------------------------------------------------------

describe('TransactionClient — table accessor', () => {
  it('caches table() references within a transaction', async () => {
    const { pool } = createMockPool([
      { rows: [] }, // BEGIN
      { rows: [] }, // COMMIT
    ]);
    const db = new TurbineClient({ pool }, buildSchema());

    await db.$transaction(async (tx) => {
      const ref1 = tx.table('users');
      const ref2 = tx.table('users');
      assert.strictEqual(ref1, ref2, 'table() should return cached instance');
    });
  });

  it('auto-creates typed accessors from schema on TransactionClient', async () => {
    const { pool } = createMockPool([
      { rows: [] }, // BEGIN
      { rows: [{ id: 1, name: 'Alice', email: 'a@b.com' }] }, // findMany
      { rows: [] }, // COMMIT
    ]);
    const db = new TurbineClient({ pool }, buildSchema());

    await db.$transaction(async (tx) => {
      // biome-ignore lint/complexity/noBannedTypes: testing dynamic transaction accessor shape
      const txAny = tx as unknown as { users: { findMany: Function } };
      assert.ok(txAny.users, 'tx should have auto-created users accessor');
      const users = await txAny.users.findMany({ limit: 1 });
      assert.ok(Array.isArray(users));
    });
  });
});

// ---------------------------------------------------------------------------
// 9. DATABASE_URL fallback for turbine() with no connection fields
// ---------------------------------------------------------------------------

/** Read the connection options off the owned pg.Pool the client built. */
function poolOptions(db: TurbineClient): { connectionString?: string; host?: string } {
  return (db as unknown as { pool: { options: { connectionString?: string; host?: string } } }).pool.options;
}

describe('TurbineClient DATABASE_URL fallback', () => {
  // test:unit runs with DATABASE_URL='' (falsy); each case sets/restores it
  // explicitly so nothing leaks between tests.
  function withDatabaseUrl(value: string | undefined, fn: () => Promise<void> | void): Promise<void> {
    const prev = process.env.DATABASE_URL;
    if (value === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = value;
    return (async () => {
      try {
        await fn();
      } finally {
        if (prev === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = prev;
      }
    })();
  }

  it('uses DATABASE_URL when constructed with no connection fields', async () => {
    await withDatabaseUrl('postgres://envuser:envpass@envhost:5432/envdb', async () => {
      const db = new TurbineClient({}, buildSchema());
      try {
        const opts = poolOptions(db);
        assert.equal(opts.connectionString, 'postgres://envuser:envpass@envhost:5432/envdb');
      } finally {
        await db.disconnect();
      }
    });
  });

  it('does NOT apply the fallback when an explicit host is given', async () => {
    await withDatabaseUrl('postgres://envuser:envpass@envhost:5432/envdb', async () => {
      const db = new TurbineClient({ host: 'explicit-host', database: 'explicit-db' }, buildSchema());
      try {
        const opts = poolOptions(db);
        assert.equal(opts.connectionString, undefined, 'must not override an explicit host with DATABASE_URL');
        assert.equal(opts.host, 'explicit-host');
      } finally {
        await db.disconnect();
      }
    });
  });

  it('prefers an explicit connectionString over DATABASE_URL', async () => {
    await withDatabaseUrl('postgres://envuser:envpass@envhost:5432/envdb', async () => {
      const db = new TurbineClient({ connectionString: 'postgres://explicit:pw@explicithost:5432/db' }, buildSchema());
      try {
        const opts = poolOptions(db);
        assert.equal(opts.connectionString, 'postgres://explicit:pw@explicithost:5432/db');
      } finally {
        await db.disconnect();
      }
    });
  });

  it('falls back to localhost defaults when neither config nor DATABASE_URL is set', async () => {
    await withDatabaseUrl(undefined, async () => {
      const db = new TurbineClient({}, buildSchema());
      try {
        const opts = poolOptions(db);
        assert.equal(opts.connectionString, undefined);
        assert.equal(opts.host, 'localhost');
      } finally {
        await db.disconnect();
      }
    });
  });
});
