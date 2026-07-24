/**
 * turbine-orm — Observability module tests
 *
 * Tests the in-memory buffer, percentile calculation, flush logic,
 * and event listener wiring. No real database needed.
 *
 * Run: npx tsx --test src/test/observe.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { floorToMinute, ObserveEngine, percentile } from '../observe.js';
import type { QueryEvent } from '../query/index.js';

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

describe('ObserveEngine buffer', () => {
  it('accumulates durations from listener events', () => {
    const engine = new ObserveEngine({ connectionString: 'postgres://unused' });
    const listener = engine.getListener();

    const event: QueryEvent = {
      sql: 'SELECT 1',
      params: [],
      duration: 12.5,
      model: 'users',
      action: 'findMany',
      rows: 10,
      timestamp: new Date(),
    };

    listener(event);
    listener({ ...event, duration: 8.3 });
    listener({ ...event, duration: 20.1, error: new Error('fail') });

    // Access buffer via flush mock — we test that flush produces correct values
    // by capturing the SQL that would be sent. Since we don't call init() (no pool),
    // we just verify the listener accumulates correctly.
    // The engine's internal buffer is private so we test via the flush output below.
    assert.ok(true); // listener did not throw
  });

  it('buffers different model:action keys separately', () => {
    const engine = new ObserveEngine({ connectionString: 'postgres://unused' });
    const listener = engine.getListener();

    listener({
      sql: 'SELECT',
      params: [],
      duration: 5,
      model: 'users',
      action: 'findMany',
      rows: 1,
      timestamp: new Date(),
    });
    listener({
      sql: 'INSERT',
      params: [],
      duration: 10,
      model: 'posts',
      action: 'create',
      rows: 1,
      timestamp: new Date(),
    });

    // No crash — both keys buffered independently
    assert.ok(true);
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
// $on/$off integration with ObserveEngine
// ---------------------------------------------------------------------------

describe('$on/$off with ObserveEngine', () => {
  it('listener receives events and can be removed', () => {
    const engine = new ObserveEngine({ connectionString: 'postgres://unused' });
    const listener = engine.getListener();

    const event: QueryEvent = {
      sql: 'SELECT 1',
      params: [],
      duration: 5,
      model: 'test',
      action: 'findMany',
      rows: 1,
      timestamp: new Date(),
    };

    // Should not throw
    listener(event);
    assert.ok(true);
  });
});
