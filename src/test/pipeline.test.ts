/**
 * turbine-orm — Pipeline execution tests
 *
 * Verifies `executePipeline` against a mock pg-compat pool:
 *   - acquires a single connection
 *   - wraps the batch in BEGIN/COMMIT (sequential fallback path)
 *   - executes queries in order
 *   - runs each query's `transform`
 *   - ROLLBACK on error
 *   - empty array short-circuits
 *   - non-transactional sequential mode (no BEGIN/COMMIT)
 *   - capability detection routing
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
      /explode/,
    );

    assert.ok(!calls.includes('BEGIN'), 'no BEGIN');
    assert.ok(!calls.includes('ROLLBACK'), 'no ROLLBACK in non-transactional mode');
    assert.equal(released.value, 1, 'connection released');
  });
});
