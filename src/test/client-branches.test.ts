/**
 * turbine-orm — TurbineClient branch coverage tests
 *
 * Covers branch paths in src/client.ts not exercised by client-coverage.test.ts:
 *   1. Transaction isolation levels (ReadCommitted, RepeatableRead, Serializable)
 *   2. Nested transactions — SAVEPOINT/RELEASE/ROLLBACK TO with depth
 *   3. $use middleware chain — multiple middlewares compose in order
 *   4. External pool mode — disconnect() is a no-op
 *   5. Logging mode — console output on key operations
 *   6. withRetry utility — retryable errors, non-retryable, max attempts
 *
 * No real database required — uses mock pool.
 *
 * Run: npx tsx --test src/test/client-branches.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type PgCompatPool, TurbineClient, withRetry } from '../client.js';
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

const createMockPool = (): {
  pool: PgCompatPool;
  calls: QueryCall[];
  ended: { value: boolean };
} => {
  const calls: QueryCall[] = [];
  const ended = { value: false };

  const client = {
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values, via: 'client' });
      return { rows: [], rowCount: 0, fields: [] };
    },
    release(_err?: Error | boolean) {},
  };

  const pool: PgCompatPool = {
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values, via: 'pool' });
      return { rows: [], rowCount: 0, fields: [] };
    },
    async connect() {
      return client;
    },
    async end() {
      ended.value = true;
    },
  };

  return { pool, calls, ended };
};

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
// 1. Transaction isolation levels
// ---------------------------------------------------------------------------

describe('TurbineClient.$transaction — isolation levels', () => {
  it('ReadCommitted sends correct BEGIN SQL', async () => {
    const { pool, calls } = createMockPool();
    const db = new TurbineClient({ pool }, buildSchema());

    await db.$transaction(async () => {}, { isolationLevel: 'ReadCommitted' });

    const beginCall = calls.find((c) => c.text.includes('BEGIN'));
    assert.ok(beginCall, 'should have a BEGIN call');
    assert.match(beginCall!.text, /ISOLATION LEVEL READ COMMITTED/);
  });

  it('RepeatableRead sends correct BEGIN SQL', async () => {
    const { pool, calls } = createMockPool();
    const db = new TurbineClient({ pool }, buildSchema());

    await db.$transaction(async () => {}, { isolationLevel: 'RepeatableRead' });

    const beginCall = calls.find((c) => c.text.includes('BEGIN'));
    assert.ok(beginCall, 'should have a BEGIN call');
    assert.match(beginCall!.text, /ISOLATION LEVEL REPEATABLE READ/);
  });

  it('Serializable sends correct BEGIN SQL', async () => {
    const { pool, calls } = createMockPool();
    const db = new TurbineClient({ pool }, buildSchema());

    await db.$transaction(async () => {}, { isolationLevel: 'Serializable' });

    const beginCall = calls.find((c) => c.text.includes('BEGIN'));
    assert.ok(beginCall, 'should have a BEGIN call');
    assert.match(beginCall!.text, /ISOLATION LEVEL SERIALIZABLE/);
  });

  it('no isolation level sends plain BEGIN', async () => {
    const { pool, calls } = createMockPool();
    const db = new TurbineClient({ pool }, buildSchema());

    await db.$transaction(async () => {});

    const beginCall = calls.find((c) => c.text === 'BEGIN');
    assert.ok(beginCall, 'should have a plain BEGIN call');
  });
});

// ---------------------------------------------------------------------------
// 1b. Failed BEGIN — no stray ROLLBACK (adversarial-review regression)
// ---------------------------------------------------------------------------
//
// If BEGIN itself throws (e.g. a single-writer engine's transaction gate times
// out or rejects a re-entrant begin), the catch path must NOT issue its
// best-effort ROLLBACK: this context never opened a transaction, and on a
// driver with one shared engine handle (PowDB embedded) the stray statement
// rolled back a DIFFERENT caller's open transaction (live-reproduced silent
// partial commit).

const createBeginFailPool = (): { pool: PgCompatPool; calls: QueryCall[] } => {
  const calls: QueryCall[] = [];
  const client = {
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values, via: 'client' as const });
      if (text.startsWith('BEGIN')) throw new Error('begin refused (gate timeout)');
      return { rows: [], rowCount: 0, fields: [] };
    },
    release(_err?: Error | boolean) {},
  };
  const pool: PgCompatPool = {
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values, via: 'pool' });
      return { rows: [], rowCount: 0, fields: [] };
    },
    async connect() {
      return client;
    },
    async end() {},
  };
  return { pool, calls };
};

describe('TurbineClient — failed BEGIN issues no stray ROLLBACK', () => {
  it('$transaction: BEGIN failure propagates and sends NO rollback', async () => {
    const { pool, calls } = createBeginFailPool();
    const db = new TurbineClient({ pool }, buildSchema());

    await assert.rejects(
      db.$transaction(async () => {}),
      /begin refused/,
    );
    assert.ok(
      !calls.some((c) => c.text.includes('ROLLBACK')),
      `no ROLLBACK may follow a failed BEGIN, got: ${JSON.stringify(calls.map((c) => c.text))}`,
    );
  });

  it('transaction(): BEGIN failure propagates and sends NO rollback', async () => {
    const { pool, calls } = createBeginFailPool();
    const db = new TurbineClient({ pool }, buildSchema());

    await assert.rejects(
      db.transaction(async () => {}),
      /begin refused/,
    );
    assert.ok(
      !calls.some((c) => c.text.includes('ROLLBACK')),
      `no ROLLBACK may follow a failed BEGIN, got: ${JSON.stringify(calls.map((c) => c.text))}`,
    );
  });

  it('control: a failure AFTER a successful BEGIN still rolls back (both APIs)', async () => {
    const { pool, calls } = createMockPool();
    const db = new TurbineClient({ pool }, buildSchema());

    await assert.rejects(
      db.$transaction(async () => {
        throw new Error('fn failed');
      }),
      /fn failed/,
    );
    assert.ok(
      calls.some((c) => c.text === 'ROLLBACK'),
      '$transaction must still roll back after a successful BEGIN',
    );

    calls.length = 0;
    await assert.rejects(
      db.transaction(async () => {
        throw new Error('fn failed');
      }),
      /fn failed/,
    );
    assert.ok(
      calls.some((c) => c.text === 'ROLLBACK'),
      'transaction() must still roll back after a successful BEGIN',
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Nested transactions — SAVEPOINT / RELEASE / ROLLBACK TO
// ---------------------------------------------------------------------------

describe('TurbineClient.$transaction — nested savepoints (branch coverage)', () => {
  it('SAVEPOINT is created and RELEASE on success', async () => {
    const { pool, calls } = createMockPool();
    const db = new TurbineClient({ pool }, buildSchema());

    await db.$transaction(async (tx) => {
      await tx.$transaction(async () => {
        // inner no-op
      });
    });

    const clientCalls = calls.filter((c) => c.via === 'client');
    const texts = clientCalls.map((c) => c.text);

    assert.ok(texts.includes('BEGIN'));
    assert.ok(texts.some((t) => t.startsWith('SAVEPOINT sp_')));
    assert.ok(texts.some((t) => t.startsWith('RELEASE SAVEPOINT sp_')));
    assert.ok(texts.includes('COMMIT'));
  });

  it('ROLLBACK TO SAVEPOINT on nested failure, outer commits', async () => {
    const { pool, calls } = createMockPool();
    const db = new TurbineClient({ pool }, buildSchema());

    await db.$transaction(async (tx) => {
      try {
        await tx.$transaction(async () => {
          throw new Error('inner boom');
        });
      } catch {
        // swallow
      }
    });

    const clientCalls = calls.filter((c) => c.via === 'client');
    const texts = clientCalls.map((c) => c.text);

    assert.ok(texts.some((t) => t.startsWith('ROLLBACK TO SAVEPOINT sp_')));
    assert.ok(texts.includes('COMMIT'));
  });

  it('deeply nested savepoints use incrementing names', async () => {
    const { pool, calls } = createMockPool();
    const db = new TurbineClient({ pool }, buildSchema());

    await db.$transaction(async (tx) => {
      await tx.$transaction(async () => {});
      await tx.$transaction(async () => {});
      await tx.$transaction(async () => {});
    });

    const savepointCalls = calls
      .filter((c) => c.via === 'client' && c.text.startsWith('SAVEPOINT sp_'))
      .map((c) => c.text);
    assert.equal(savepointCalls.length, 3);
    assert.equal(savepointCalls[0], 'SAVEPOINT sp_1');
    assert.equal(savepointCalls[1], 'SAVEPOINT sp_2');
    assert.equal(savepointCalls[2], 'SAVEPOINT sp_3');
  });
});

// ---------------------------------------------------------------------------
// 3. $use middleware chain — multiple middlewares execute in order
// ---------------------------------------------------------------------------

describe('TurbineClient.$use — middleware chain (branch coverage)', () => {
  it('three middlewares execute in registration order with correct nesting', async () => {
    const { pool } = createMockPool();
    const db = new TurbineClient({ pool }, buildSchema());

    const log: string[] = [];

    db.$use(async (params, next) => {
      log.push('a-before');
      const result = await next(params);
      log.push('a-after');
      return result;
    });

    db.$use(async (params, next) => {
      log.push('b-before');
      const result = await next(params);
      log.push('b-after');
      return result;
    });

    db.$use(async (params, next) => {
      log.push('c-before');
      const result = await next(params);
      log.push('c-after');
      return result;
    });

    await db.table('users').findMany({ limit: 1 });

    assert.deepEqual(log, ['a-before', 'b-before', 'c-before', 'c-after', 'b-after', 'a-after']);
  });

  it('middleware can short-circuit without calling next', async () => {
    const { pool } = createMockPool();
    const db = new TurbineClient({ pool }, buildSchema());

    db.$use(async (_params, _next) => {
      // Short-circuit: return without calling next
      return [{ id: 999, name: 'Cached', email: 'cache@test.com' }];
    });

    const result = (await db.table('users').findMany({ limit: 1 })) as Array<{
      id: number;
      name: string;
    }>;
    assert.equal(result.length, 1);
    assert.equal(result[0]?.id, 999);
    assert.equal(result[0]?.name, 'Cached');
  });
});

// ---------------------------------------------------------------------------
// 4. External pool mode — disconnect() is a no-op
// ---------------------------------------------------------------------------

describe('TurbineClient — external pool mode (branch coverage)', () => {
  it('disconnect() does not call pool.end()', async () => {
    const { pool, ended } = createMockPool();
    const db = new TurbineClient({ pool }, buildSchema());

    await db.disconnect();
    assert.equal(ended.value, false);
  });

  it('end() alias does not call pool.end()', async () => {
    const { pool, ended } = createMockPool();
    const db = new TurbineClient({ pool }, buildSchema());

    await db.end();
    assert.equal(ended.value, false);
  });

  it('stats returns zeros when pool lacks stat fields', () => {
    const barePool: PgCompatPool = {
      async query() {
        return { rows: [], rowCount: 0, fields: [] };
      },
      async connect() {
        return {
          async query() {
            return { rows: [], rowCount: 0, fields: [] };
          },
          release() {},
        };
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
// 5. Logging mode — console output
// ---------------------------------------------------------------------------

describe('TurbineClient — logging mode (branch coverage)', () => {
  it('logging: true logs on external pool creation', () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));

    try {
      const { pool } = createMockPool();
      new TurbineClient({ pool, logging: true }, buildSchema());

      assert.ok(
        logs.some((l) => l.includes('[turbine]') && l.includes('external pool')),
        `Expected logging output about external pool, got: ${JSON.stringify(logs)}`,
      );
    } finally {
      console.log = origLog;
    }
  });

  it('logging: true logs on disconnect skip for external pool', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));

    try {
      const { pool } = createMockPool();
      const db = new TurbineClient({ pool, logging: true }, buildSchema());

      await db.disconnect();

      assert.ok(
        logs.some((l) => l.includes('disconnect') && l.includes('skipped')),
        `Expected disconnect skip log, got: ${JSON.stringify(logs)}`,
      );
    } finally {
      console.log = origLog;
    }
  });

  it('logging: true logs raw SQL execution', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));

    try {
      const { pool } = createMockPool();
      const db = new TurbineClient({ pool, logging: true }, buildSchema());

      await db.raw`SELECT 1`;

      assert.ok(
        logs.some((l) => l.includes('[turbine]') && l.includes('Raw SQL')),
        `Expected raw SQL log, got: ${JSON.stringify(logs)}`,
      );
    } finally {
      console.log = origLog;
    }
  });

  it('logging: true logs transaction commit', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));

    try {
      const { pool } = createMockPool();
      const db = new TurbineClient({ pool, logging: true }, buildSchema());

      await db.$transaction(async () => {});

      assert.ok(
        logs.some((l) => l.includes('committed')),
        `Expected transaction committed log, got: ${JSON.stringify(logs)}`,
      );
    } finally {
      console.log = origLog;
    }
  });
});

// ---------------------------------------------------------------------------
// 6. withRetry utility — retryable, non-retryable, max attempts
// ---------------------------------------------------------------------------

describe('withRetry — branch coverage', () => {
  it('retries on isRetryable error and succeeds', async () => {
    let attempt = 0;
    const result = await withRetry(
      () => {
        attempt++;
        if (attempt < 2) {
          const err = new Error('deadlock') as Error & { isRetryable: true };
          err.isRetryable = true;
          throw err;
        }
        return Promise.resolve('ok');
      },
      { baseDelay: 1, maxAttempts: 3 },
    );
    assert.equal(result, 'ok');
    assert.equal(attempt, 2);
  });

  it('does not retry non-retryable errors', async () => {
    let attempt = 0;
    await assert.rejects(
      () =>
        withRetry(
          () => {
            attempt++;
            throw new Error('not retryable');
          },
          { maxAttempts: 5, baseDelay: 1 },
        ),
      { message: 'not retryable' },
    );
    assert.equal(attempt, 1);
  });

  it('throws after max attempts exhausted', async () => {
    let attempt = 0;
    await assert.rejects(
      () =>
        withRetry(
          () => {
            attempt++;
            const err = new Error('serialization failure') as Error & { isRetryable: true };
            err.isRetryable = true;
            throw err;
          },
          { maxAttempts: 3, baseDelay: 1 },
        ),
      { message: 'serialization failure' },
    );
    assert.equal(attempt, 3);
  });

  it('calls onRetry callback with attempt number', async () => {
    const retries: number[] = [];
    let attempt = 0;
    await withRetry(
      () => {
        attempt++;
        if (attempt < 3) {
          const err = new Error('retry me') as Error & { isRetryable: true };
          err.isRetryable = true;
          throw err;
        }
        return Promise.resolve('done');
      },
      {
        baseDelay: 1,
        onRetry: (_err, attemptNum) => retries.push(attemptNum),
      },
    );
    assert.deepStrictEqual(retries, [1, 2]);
  });

  it('does not retry when isRetryable is not true', async () => {
    let attempt = 0;
    await assert.rejects(
      () =>
        withRetry(
          () => {
            attempt++;
            const err = new Error('not quite') as Error & { isRetryable: string };
            (err as unknown as Record<string, unknown>).isRetryable = 'yes';
            throw err;
          },
          { maxAttempts: 3, baseDelay: 1 },
        ),
      { message: 'not quite' },
    );
    assert.equal(attempt, 1, 'isRetryable must be strictly true');
  });
});

// ---------------------------------------------------------------------------
// 7. pg-style pool option aliases (max / idleTimeoutMillis / connectionTimeoutMillis)
// ---------------------------------------------------------------------------

describe('pool option aliases', () => {
  // biome-ignore lint/suspicious/noExplicitAny: reading pg.Pool's options bag
  const poolOptions = (db: TurbineClient): any => (db as any).pool.options;

  it('accepts the pg spellings as aliases', async () => {
    const db = new TurbineClient(
      { host: 'localhost', database: 'x', max: 7, idleTimeoutMillis: 1234, connectionTimeoutMillis: 999 },
      { tables: {}, enums: {} } as SchemaMetadata,
    );
    const opts = poolOptions(db);
    assert.equal(opts.max, 7);
    assert.equal(opts.idleTimeoutMillis, 1234);
    assert.equal(opts.connectionTimeoutMillis, 999);
    await db.disconnect();
  });

  it('the turbine-native field wins when both are set', async () => {
    const db = new TurbineClient(
      { host: 'localhost', database: 'x', poolSize: 3, max: 7, idleTimeoutMs: 50, idleTimeoutMillis: 1234 },
      { tables: {}, enums: {} } as SchemaMetadata,
    );
    const opts = poolOptions(db);
    assert.equal(opts.max, 3);
    assert.equal(opts.idleTimeoutMillis, 50);
    await db.disconnect();
  });
});
