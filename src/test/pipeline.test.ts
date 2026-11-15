/**
 * turbine-orm, Pipeline execution tests
 *
 * Verifies `executePipeline` against a mock pg-compat pool:
 *   - acquires a single connection
 *   - wraps the batch in BEGIN/COMMIT (sequential fallback path)
 *   - executes queries in order
 *   - runs each query's `transform`
 *   - ROLLBACK on error
 *   - empty array short-circuits
 *   - non-transactional sequential mode (no BEGIN/COMMIT)
 *   - non-transactional partial failure rejects with a real PipelineError
 *   - capability detection routing
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ConnectionError,
  PipelineError,
  TransactionOutcomeUnknownError,
  TurbineErrorCode,
  UniqueConstraintError,
} from '../errors.js';
import { executePipeline } from '../pipeline.js';
import type { DeferredQuery } from '../query/index.js';

// ---------------------------------------------------------------------------
// Minimal mock pool
// ---------------------------------------------------------------------------

interface MockPool {
  pool: {
    connect(): Promise<{
      query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
      release: () => void;
    }>;
  };
  calls: Array<{ text: string; values?: unknown[] }>;
  released: { value: number };
}

function createMockPool(
  responder: (sql: string, values?: unknown[]) => { rows: unknown[]; rowCount?: number },
): MockPool {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const released = { value: 0 };

  const client = {
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values });
      const r = responder(text, values);
      return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
    },
    release() {
      released.value += 1;
    },
  };

  const pool = {
    async connect() {
      return client;
    },
  };

  return { pool, calls, released };
}

// ---------------------------------------------------------------------------
// DeferredQuery helper
// ---------------------------------------------------------------------------

function defer<T>(
  sql: string,
  params: unknown[],
  transform: (r: { rows: unknown[]; rowCount: number }) => T,
  tag = 'test',
): DeferredQuery<T> {
  return { sql, params, transform: transform as DeferredQuery<T>['transform'], tag };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executePipeline', () => {
  it('returns empty array for empty input (no connection acquired)', async () => {
    let connected = false;
    const pool = {
      async connect() {
        connected = true;
        return { query: async () => ({ rows: [] }), release: () => {} };
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: mock pool shape
    const result = await executePipeline(pool as any, []);
    assert.deepEqual(result, []);
    assert.equal(connected, false);
  });

  it('wraps queries in BEGIN/COMMIT on a single connection', async () => {
    const { pool, calls, released } = createMockPool((sql) => {
      if (sql.startsWith('SELECT 1')) return { rows: [{ n: 1 }] };
      if (sql.startsWith('SELECT 2')) return { rows: [{ n: 2 }] };
      return { rows: [] };
    });

    // biome-ignore lint/suspicious/noExplicitAny: mock pool shape
    const results = await executePipeline(pool as any, [
      defer('SELECT 1 AS n', [], (r) => (r.rows[0] as { n: number }).n),
      defer('SELECT 2 AS n', [], (r) => (r.rows[0] as { n: number }).n),
    ]);

    assert.deepEqual(results, [1, 2]);
    assert.equal(calls[0]?.text, 'BEGIN');
    assert.equal(calls[1]?.text, 'SELECT 1 AS n');
    assert.equal(calls[2]?.text, 'SELECT 2 AS n');
    assert.equal(calls[3]?.text, 'COMMIT');
    assert.equal(released.value, 1, 'connection released exactly once');
  });

  it('runs each query transform and preserves order', async () => {
    const { pool } = createMockPool((sql) => {
      if (sql.includes('users')) return { rows: [{ id: 1, name: 'Alice' }] };
      if (sql.includes('COUNT')) return { rows: [{ count: '42' }] };
      return { rows: [] };
    });

    // biome-ignore lint/suspicious/noExplicitAny: mock pool shape
    const [user, count] = await executePipeline(pool as any, [
      defer('SELECT * FROM users', [], (r) => r.rows[0] as { id: number; name: string }),
      defer('SELECT COUNT(*) FROM posts', [], (r) => Number((r.rows[0] as { count: string }).count)),
    ]);

    assert.deepEqual(user, { id: 1, name: 'Alice' });
    assert.equal(count, 42);
  });

  it('rolls back and propagates errors when a query fails', async () => {
    const calls: string[] = [];
    const released = { value: 0 };
    const pool = {
      async connect() {
        return {
          async query(text: string) {
            calls.push(text);
            if (text.includes('BOOM')) throw new Error('explode');
            return { rows: [], rowCount: 0 };
          },
          release() {
            released.value += 1;
          },
        };
      },
    };

    await assert.rejects(
      () =>
        executePipeline(
          // biome-ignore lint/suspicious/noExplicitAny: mock pool shape
          pool as any,
          [defer('SELECT BOOM', [], (r) => r.rows)],
        ),
      /explode/,
    );

    assert.equal(calls[0], 'BEGIN');
    assert.ok(calls.includes('ROLLBACK'), 'ROLLBACK must be issued on failure');
    assert.equal(released.value, 1, 'connection released even on failure');
  });

  it('passes parameter values to the underlying client', async () => {
    const seen: unknown[][] = [];
    const pool = {
      async connect() {
        return {
          async query(_text: string, values?: unknown[]) {
            if (values) seen.push(values);
            return { rows: [], rowCount: 0 };
          },
          release() {},
        };
      },
    };

    await executePipeline(
      // biome-ignore lint/suspicious/noExplicitAny: mock pool shape
      pool as any,
      [defer('SELECT $1', [42], (r) => r.rows), defer('SELECT $1, $2', ['a', 'b'], (r) => r.rows)],
    );

    assert.deepEqual(seen, [[42], ['a', 'b']]);
  });

  it('non-transactional mode skips BEGIN/COMMIT in sequential fallback', async () => {
    const { pool, calls, released } = createMockPool((sql) => {
      if (sql.startsWith('SELECT 1')) return { rows: [{ n: 1 }] };
      if (sql.startsWith('SELECT 2')) return { rows: [{ n: 2 }] };
      return { rows: [] };
    });

    const results = await executePipeline(
      // biome-ignore lint/suspicious/noExplicitAny: mock pool shape
      pool as any,
      [
        defer('SELECT 1 AS n', [], (r) => (r.rows[0] as { n: number }).n),
        defer('SELECT 2 AS n', [], (r) => (r.rows[0] as { n: number }).n),
      ],
      { transactional: false },
    );

    assert.deepEqual(results, [1, 2]);

    // No BEGIN/COMMIT in calls
    const texts = calls.map((c) => c.text);
    assert.ok(!texts.includes('BEGIN'), 'no BEGIN in non-transactional mode');
    assert.ok(!texts.includes('COMMIT'), 'no COMMIT in non-transactional mode');
    assert.ok(!texts.includes('ROLLBACK'), 'no ROLLBACK in non-transactional mode');
    assert.equal(released.value, 1, 'connection released exactly once');
  });

  it('non-transactional mode does not ROLLBACK on error', async () => {
    const calls: string[] = [];
    const released = { value: 0 };
    const pool = {
      async connect() {
        return {
          async query(text: string) {
            calls.push(text);
            if (text.includes('BOOM')) throw new Error('explode');
            return { rows: [], rowCount: 0 };
          },
          release() {
            released.value += 1;
          },
        };
      },
    };

    await assert.rejects(
      () =>
        executePipeline(
          // biome-ignore lint/suspicious/noExplicitAny: mock pool shape
          pool as any,
          [defer('SELECT BOOM', [], (r) => r.rows)],
          { transactional: false },
        ),
      // The driver's own message is no longer the rejection's message: a
      // non-transactional failure now rejects with the typed PipelineError the
      // option's docstring promises, and the driver error is its `.cause`. The
      // next test asserts that whole shape.
      (err: unknown) => err instanceof PipelineError && (err.cause as Error)?.message === 'explode',
    );

    assert.ok(!calls.includes('BEGIN'), 'no BEGIN');
    assert.ok(!calls.includes('ROLLBACK'), 'no ROLLBACK in non-transactional mode');
    assert.equal(released.value, 1, 'connection released');
  });

  /**
   * `PipelineError` (E014) was defined in errors.ts, documented on the errors
   * page with an `instanceof` example, and never CONSTRUCTED anywhere outside a
   * test. The sequential path threw the raw driver error and the pipelined path
   * bolted a `results` property onto it, so `err.results` happened to work while
   * `err instanceof PipelineError` and `err.code === 'TURBINE_E014'` were both
   * permanently false.
   */
  it('rejects a partly-failed non-transactional batch with a real PipelineError', async () => {
    const released = { value: 0 };
    const pool = {
      async connect() {
        return {
          async query(text: string) {
            if (text.includes('BOOM')) throw new Error('explode');
            return { rows: [{ n: 7 }], rowCount: 1 };
          },
          release() {
            released.value += 1;
          },
        };
      },
    };

    const err = await executePipeline(
      // biome-ignore lint/suspicious/noExplicitAny: mock pool shape
      pool as any,
      [
        defer('SELECT 1 AS n', [], (r) => (r.rows[0] as { n: number }).n),
        defer('SELECT BOOM', [], (r) => r.rows, 'posts.findMany'),
        defer('SELECT 3 AS n', [], (r) => (r.rows[0] as { n: number }).n),
      ],
      { transactional: false },
    ).then(
      () => null,
      (e: unknown) => e,
    );

    assert.ok(err instanceof PipelineError, `expected a PipelineError, got ${String(err)}`);
    assert.equal(err.code, TurbineErrorCode.PIPELINE);
    assert.equal(err.failedIndex, 1);
    assert.equal(err.failedTag, 'posts.findMany');
    assert.equal((err.cause as Error).message, 'explode');

    // Every query gets a slot, and the two AFTER the failure still ran: in
    // non-transactional mode the queries are independent, which is what the
    // option promises. The old code abandoned the batch at the first error.
    assert.deepEqual(
      err.results.map((slot) => slot.status),
      ['ok', 'error', 'ok'],
    );
    assert.deepEqual(
      err.results.filter((slot) => slot.status === 'ok').map((slot) => slot.value),
      [7, 7],
    );
    assert.equal(released.value, 1, 'connection released');
  });
});

/**
 * The sequential `{ transactional: false }` batch when its connection fails.
 * Each query autocommits, so one whose connection failed under it without an
 * answer may have committed: E021, never E004, whose advice is that a retry is
 * safe. Only a query the driver refused before sending it keeps E004.
 */
describe('executePipeline non-transactional sequential batch when the connection fails', () => {
  const lostMidStatement = () => new Error('Connection terminated unexpectedly');
  const notQueryable = () => new Error('Client has encountered a connection error and is not queryable');

  function failingPool(answer: (sql: string) => Error | { rows: unknown[]; rowCount: number }) {
    const sent: string[] = [];
    const releases: unknown[] = [];
    const pool = {
      async connect() {
        return {
          async query(text: string) {
            sent.push(text);
            const r = answer(text);
            if (r instanceof Error) throw r;
            return r;
          },
          release(err?: unknown) {
            releases.push(err);
          },
        };
      },
    };
    return { pool, sent, releases };
  }

  const run = (pool: unknown, queries: DeferredQuery<unknown>[]) =>
    // biome-ignore lint/suspicious/noExplicitAny: mock pool shape
    executePipeline(pool as any, queries, { transactional: false }).then(
      () => null,
      (e: unknown) => e,
    );
  const slotError = (err: PipelineError, i: number) => (err.results[i] as { error?: unknown }).error;

  it('reports a write whose answer was lost as an unknown outcome and keeps acknowledged slots', async () => {
    let dead = false;
    const { pool, sent, releases } = failingPool((sql) => {
      if (dead) return notQueryable();
      if (sql.startsWith('INSERT INTO b')) {
        dead = true;
        return lostMidStatement();
      }
      return { rows: [{ n: 1 }], rowCount: 1 };
    });
    const err = await run(pool, [
      defer('INSERT INTO a VALUES (1)', [], (r) => r.rowCount, 'a.create'),
      defer('INSERT INTO b VALUES (1)', [], (r) => r.rowCount, 'b.create'),
      defer('INSERT INTO c VALUES (1)', [], (r) => r.rowCount, 'c.create'),
    ]);
    assert.ok(err instanceof PipelineError, `got ${String(err)}`);
    assert.deepEqual(err.results[0], { status: 'ok', value: 1 }, 'an acknowledged slot keeps its result');
    const unknown = slotError(err, 1);
    assert.ok(unknown instanceof TransactionOutcomeUnknownError, `got ${String(unknown)}`);
    assert.ok(unknown.cause instanceof ConnectionError, 'the connection error is the cause');
    const refused = slotError(err, 2);
    assert.ok(refused instanceof ConnectionError, 'a statement the driver refused to send keeps E004');
    assert.equal(err.failedIndex, 1);
    assert.equal(err.failedTag, 'b.create');
    assert.equal(err.cause, unknown);
    assert.equal(sent.length, 3, 'the batch stays independent');
    assert.equal(releases.length, 1, 'released once');
    assert.ok(releases[0] instanceof Error, 'a connection that failed is released with the error, so it is discarded');
  });

  it('reports a SELECT whose answer was lost as unknown: it can write through a function', async () => {
    const { pool } = failingPool(() => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    const err = await run(pool, [defer('SELECT write_something()', [], (r) => r.rows)]);
    assert.ok(err instanceof PipelineError);
    assert.ok(slotError(err, 0) instanceof TransactionOutcomeUnknownError);
  });

  it('reports a sent COMMIT of an explicit BEGIN / INSERT / COMMIT batch as unknown', async () => {
    const { pool } = failingPool((sql) => (sql === 'COMMIT' ? lostMidStatement() : { rows: [], rowCount: 1 }));
    const err = await run(pool, [
      defer('BEGIN', [], (r) => r.rowCount),
      defer('INSERT INTO a VALUES (1)', [], (r) => r.rowCount),
      defer('COMMIT', [], (r) => r.rowCount),
    ]);
    assert.ok(err instanceof PipelineError);
    assert.deepEqual(
      err.results.map((slot) => slot.status),
      ['ok', 'ok', 'error'],
    );
    assert.ok(slotError(err, 2) instanceof TransactionOutcomeUnknownError, 'the COMMIT may have committed');
  });

  it('keeps the errors the server answered with', async () => {
    const { pool, releases } = failingPool(() =>
      Object.assign(new Error('duplicate key'), { code: '23505', severity: 'ERROR' }),
    );
    const err = await run(pool, [defer('INSERT INTO a VALUES (1)', [], (r) => r.rowCount)]);
    assert.ok(err instanceof PipelineError);
    assert.ok(slotError(err, 0) instanceof UniqueConstraintError);
    assert.deepEqual(releases, [undefined], 'a connection the server answered on is kept');
  });

  it('keeps E004 for a connection error the server answered with an ERROR', async () => {
    const { pool } = failingPool(() =>
      Object.assign(new Error('prepared statement "t_1" does not exist'), { code: '26000', severity: 'ERROR' }),
    );
    const err = await run(pool, [defer('SELECT 1', [], (r) => r.rows)]);
    assert.ok(err instanceof PipelineError);
    const answered = slotError(err, 0);
    assert.ok(answered instanceof ConnectionError && !(answered instanceof TransactionOutcomeUnknownError));
  });
});
