/**
 * turbine-orm, Observability module tests
 *
 * Tests the in-memory buffer, percentile calculation, flush logic,
 * and event listener wiring. No real database needed.
 *
 * Run: npx tsx --test src/test/observe.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type PgCompatPool, TurbineClient } from '../client.js';
import { floorToMinute, type MetricsFlushBatch, ObserveEngine, percentile } from '../observe.js';
import type { QueryEvent } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

// ---------------------------------------------------------------------------
// percentile()
// ---------------------------------------------------------------------------

describe('percentile()', () => {
  it('returns 0 for empty array', () => {
    assert.equal(percentile([], 0.5), 0);
  });

  it('returns the single element for a single-element array', () => {
    assert.equal(percentile([42], 0.5), 42);
    assert.equal(percentile([42], 0.95), 42);
    assert.equal(percentile([42], 0.99), 42);
  });

  it('computes p50 correctly', () => {
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    assert.equal(percentile(data, 0.5), 5);
  });

  it('computes p95 correctly', () => {
    const data = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(percentile(data, 0.95), 95);
  });

  it('computes p99 correctly', () => {
    const data = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(percentile(data, 0.99), 99);
  });
});

// ---------------------------------------------------------------------------
// floorToMinute()
// ---------------------------------------------------------------------------

describe('floorToMinute()', () => {
  it('floors seconds and ms to zero', () => {
    const d = new Date('2026-01-15T10:23:45.678Z');
    const floored = floorToMinute(d);
    assert.equal(floored.getSeconds(), 0);
    assert.equal(floored.getMilliseconds(), 0);
    assert.equal(floored.getMinutes(), 23);
  });

  it('does not mutate the input date', () => {
    const d = new Date('2026-01-15T10:23:45.678Z');
    floorToMinute(d);
    assert.equal(d.getSeconds(), 45);
  });
});

// ---------------------------------------------------------------------------
// ObserveEngine buffer accumulation
// ---------------------------------------------------------------------------

/**
 * Build an engine whose sink captures every flushed batch. This is the public
 * seam for observing the (private) per-minute buffer: the aggregates the engine
 * would have written are handed to the sink verbatim, so assertions here are
 * assertions on the real aggregation, not on a re-implementation of it.
 */
function captureEngine(batches: MetricsFlushBatch[]): ObserveEngine {
  return new ObserveEngine({
    sink: {
      flush: async (batch) => {
        batches.push(batch);
      },
    },
  });
}

describe('ObserveEngine buffer', () => {
  it('accumulates count, avg, errors and percentiles from listener events', async () => {
    const batches: MetricsFlushBatch[] = [];
    const engine = captureEngine(batches);
    const listener = engine.getListener();

    const at = new Date('2026-01-15T10:00:00.000Z');
    const event: QueryEvent = {
      sql: 'SELECT 1',
      params: [],
      duration: 12.5,
      model: 'users',
      action: 'findMany',
      rows: 10,
      timestamp: at,
    };

    listener(event);
    listener({ ...event, duration: 8.3 });
    listener({ ...event, duration: 20.1, error: new Error('fail') });

    await engine.flush();

    assert.equal(batches.length, 1);
    const rows = batches[0]!.rows;
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.model, 'users');
    assert.equal(row.action, 'findMany');
    assert.equal(row.count, 3);
    assert.equal(row.errors, 1);
    // avg = (12.5 + 8.3 + 20.1) / 3
    assert.ok(Math.abs(row.avg - 13.633333333333333) < 1e-9, `avg was ${row.avg}`);
    // Percentiles are computed over the SORTED durations [8.3, 12.5, 20.1] at
    // index ceil(p * n) - 1: p50 -> 1, p95 -> 2, p99 -> 2.
    assert.equal(row.p50, 12.5);
    assert.equal(row.p95, 20.1);
    assert.equal(row.p99, 20.1);
  });

  it('flushing twice does not re-report an already-flushed bucket', async () => {
    const batches: MetricsFlushBatch[] = [];
    const engine = captureEngine(batches);
    const listener = engine.getListener();

    listener({
      sql: 'SELECT',
      params: [],
      duration: 5,
      model: 'users',
      action: 'findMany',
      rows: 1,
      timestamp: new Date('2026-01-15T10:00:00.000Z'),
    });

    await engine.flush();
    await engine.flush();

    assert.equal(batches.length, 1, 'the second flush had an empty buffer and must be a no-op');
    assert.equal(batches[0]!.rows.length, 1);
  });

  it('buffers different model:action keys separately', async () => {
    const batches: MetricsFlushBatch[] = [];
    const engine = captureEngine(batches);
    const listener = engine.getListener();

    const at = new Date('2026-01-15T10:00:00.000Z');
    listener({ sql: 'SELECT', params: [], duration: 5, model: 'users', action: 'findMany', rows: 1, timestamp: at });
    listener({ sql: 'SELECT', params: [], duration: 7, model: 'users', action: 'findUnique', rows: 1, timestamp: at });
    listener({ sql: 'INSERT', params: [], duration: 10, model: 'posts', action: 'create', rows: 1, timestamp: at });

    await engine.flush();

    const rows = batches[0]!.rows;
    assert.equal(rows.length, 3);
    const key = (r: (typeof rows)[number]) => `${r.model}:${r.action}`;
    assert.deepEqual(rows.map(key).sort(), ['posts:create', 'users:findMany', 'users:findUnique']);
    for (const row of rows) {
      assert.equal(row.count, 1, `${key(row)} must not absorb another key's events`);
    }
    assert.equal(rows.find((r) => key(r) === 'users:findUnique')!.avg, 7);
  });
});

// ---------------------------------------------------------------------------
// ObserveEngine flush (with mock pool)
// ---------------------------------------------------------------------------

describe('ObserveEngine flush', () => {
  it('generates correct upsert SQL', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const mockPool = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values: values ?? [] });
        return { rows: [], rowCount: 0 };
      },
      end: async () => {},
    };

    // Hack: replace the default sink's internal pool with our mock
    const engine = new ObserveEngine({ connectionString: 'postgres://unused', retentionDays: 7 });
    (engine as unknown as { sink: { pool: unknown } }).sink.pool = mockPool;

    const listener = engine.getListener();
    listener({
      sql: 'SELECT',
      params: [],
      duration: 10,
      model: 'users',
      action: 'findMany',
      rows: 5,
      timestamp: new Date(),
    });
    listener({
      sql: 'SELECT',
      params: [],
      duration: 20,
      model: 'users',
      action: 'findMany',
      rows: 3,
      timestamp: new Date(),
    });
    listener({
      sql: 'SELECT',
      params: [],
      duration: 30,
      model: 'users',
      action: 'findMany',
      rows: 1,
      timestamp: new Date(),
      error: new Error('oops'),
    });

    await engine.flush();

    // Should have upsert + retention delete
    assert.equal(queries.length, 2);
    const upsert = queries[0]!;
    assert.ok(upsert.text.includes('INSERT INTO _turbine_metrics'));
    assert.ok(upsert.text.includes('ON CONFLICT'));

    // Values: [bucket, model, action, count, avg, p50, p95, p99, errors]
    const vals = upsert.values;
    assert.equal(vals[1], 'users');
    assert.equal(vals[2], 'findMany');
    assert.equal(vals[3], 3); // count
    assert.equal(vals[8], 1); // error_count

    // avg = (10+20+30)/3 = 20
    assert.ok(Math.abs((vals[4] as number) - 20) < 0.01);

    // retention query
    const retention = queries[1]!;
    assert.ok(retention.text.includes('DELETE FROM _turbine_metrics'));
    assert.equal(retention.values[0], 7);
  });

  it('does nothing when buffer is empty', async () => {
    const queries: string[] = [];
    const mockPool = {
      query: async (text: string) => {
        queries.push(text);
        return { rows: [], rowCount: 0 };
      },
      end: async () => {},
    };

    const engine = new ObserveEngine({ connectionString: 'postgres://unused' });
    (engine as unknown as { sink: { pool: unknown } }).sink.pool = mockPool;

    await engine.flush();
    assert.equal(queries.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Per-minute bucket attribution
// ---------------------------------------------------------------------------

describe('ObserveEngine bucket attribution', () => {
  function makeEvent(timestamp: Date, duration: number, overrides: Partial<QueryEvent> = {}): QueryEvent {
    return {
      sql: 'SELECT 1',
      params: [],
      duration,
      model: 'users',
      action: 'findMany',
      rows: 1,
      timestamp,
      ...overrides,
    };
  }

  it('flushes one correctly stamped row per minute bucket', async () => {
    const batches: MetricsFlushBatch[] = [];
    const engine = captureEngine(batches);

    const listener = engine.getListener();
    listener(makeEvent(new Date('2026-01-15T10:00:30.000Z'), 10));
    listener(makeEvent(new Date('2026-01-15T10:00:30.000Z'), 20));
    listener(makeEvent(new Date('2026-01-15T10:01:10.000Z'), 30));

    await engine.flush();

    assert.equal(batches.length, 1);
    const rows = batches[0]!.rows;
    assert.equal(rows.length, 2);

    const first = rows.find((r) => r.bucket.getTime() === new Date('2026-01-15T10:00:00.000Z').getTime());
    const second = rows.find((r) => r.bucket.getTime() === new Date('2026-01-15T10:01:00.000Z').getTime());
    assert.ok(first, 'expected a row stamped 10:00:00');
    assert.ok(second, 'expected a row stamped 10:01:00');
    assert.equal(first.count, 2);
    assert.equal(first.avg, 15);
    assert.equal(second.count, 1);
    assert.equal(second.avg, 30);
  });

  it('keeps model/action identity separate within one bucket', async () => {
    const batches: MetricsFlushBatch[] = [];
    const engine = captureEngine(batches);

    const listener = engine.getListener();
    const at = new Date('2026-01-15T10:00:05.000Z');
    listener(makeEvent(at, 10));
    listener(makeEvent(at, 40, { model: 'posts', action: 'create', error: new Error('oops') }));

    await engine.flush();

    const rows = batches[0]!.rows;
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.bucket.getTime(), new Date('2026-01-15T10:00:00.000Z').getTime());
    }
    assert.equal(rows.find((r) => r.model === 'posts')!.errors, 1);
    assert.equal(rows.find((r) => r.model === 'users')!.errors, 0);
  });
});

// ---------------------------------------------------------------------------
// $on/$off integration with ObserveEngine
// ---------------------------------------------------------------------------

describe('$on/$off with ObserveEngine', () => {
  function createMockPool(): PgCompatPool {
    return {
      query: async () => ({ rows: [{ id: 1 }] as Record<string, unknown>[], rowCount: 1, fields: [] }),
      connect: async () => ({
        query: async () => ({ rows: [{ id: 1 }] as Record<string, unknown>[], rowCount: 1, fields: [] }),
        release: () => {},
      }),
      end: async () => {},
    } as unknown as PgCompatPool;
  }

  function createSchema(): SchemaMetadata {
    return {
      tables: {
        users: mockTable('users', [
          { name: 'id', field: 'id' },
          { name: 'email', field: 'email', pgType: 'text' },
        ]),
      },
      enums: {},
    };
  }

  it('records the queries emitted while attached, and none after removal', async () => {
    const batches: MetricsFlushBatch[] = [];
    const engine = captureEngine(batches);
    const listener = engine.getListener();

    const db = new TurbineClient({ pool: createMockPool() }, createSchema());
    db.$on('query', listener);

    await db.table('users').findMany();
    await db.table('users').findMany();

    db.$off('query', listener);
    await db.table('users').findMany();

    await engine.flush();

    assert.equal(batches.length, 1);
    const rows = batches[0]!.rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.model, 'users');
    assert.equal(rows[0]!.action, 'findMany');
    // Two queries ran while the listener was attached, one after $off.
    assert.equal(rows[0]!.count, 2);
    assert.equal(rows[0]!.errors, 0);
  });
});
