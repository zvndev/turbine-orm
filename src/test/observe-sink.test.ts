/**
 * turbine-orm: ObserveSink tests
 *
 * Covers the pluggable flush target added alongside the default Postgres sink:
 *   - the default (no sink) path emits byte-identical SQL + retention behavior;
 *   - a custom sink receives the aggregate batches;
 *   - HttpJsonSink POSTs JSON and never throws on a fetch failure;
 *   - config validation (at least one of connectionString / sink required).
 *
 * No real database or network. Run: npx tsx --test src/test/observe-sink.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  HttpJsonSink,
  type MetricsFlushBatch,
  ObserveEngine,
  type ObserveSink,
  type PgMetricsSink,
} from '../observe.js';
import type { QueryEvent } from '../query/index.js';

function event(overrides: Partial<QueryEvent> = {}): QueryEvent {
  return {
    sql: 'SELECT 1',
    params: [],
    duration: 10,
    model: 'users',
    action: 'findMany',
    rows: 1,
    timestamp: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Default path: byte-identical SQL
// ---------------------------------------------------------------------------

describe('ObserveEngine default (Postgres) sink', () => {
  it('emits the exact same upsert + retention statements as the pre-sink writer', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const mockPool = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values: values ?? [] });
        return { rows: [], rowCount: 0 };
      },
      end: async () => {},
    };

    const engine = new ObserveEngine({ connectionString: 'postgres://unused', retentionDays: 7 });
    (engine as unknown as { sink: { pool: unknown } }).sink.pool = mockPool;

    const listener = engine.getListener();
    listener(event({ duration: 10 }));
    listener(event({ duration: 20 }));
    listener(event({ duration: 30, error: new Error('oops') }));

    await engine.flush();

    // Exactly one upsert (single model:action key) + one retention delete.
    assert.equal(queries.length, 2);

    const upsert = queries[0]!;
    assert.ok(
      upsert.text.includes(
        'INSERT INTO _turbine_metrics (bucket, model, action, count, avg_ms, p50_ms, p95_ms, p99_ms, error_count)',
      ),
    );
    assert.ok(upsert.text.includes('ON CONFLICT (bucket, model, action) DO UPDATE SET'));
    // Value order: [bucket, model, action, count, avg, p50, p95, p99, errors]
    const v = upsert.values;
    assert.ok(v[0] instanceof Date);
    assert.equal(v[1], 'users');
    assert.equal(v[2], 'findMany');
    assert.equal(v[3], 3); // count
    assert.ok(Math.abs((v[4] as number) - 20) < 0.01); // avg = (10+20+30)/3
    assert.equal(v[8], 1); // error_count

    const retention = queries[1]!;
    assert.ok(retention.text.startsWith("DELETE FROM _turbine_metrics WHERE bucket < NOW() - INTERVAL '1 day' * $1"));
    assert.equal(retention.values[0], 7);
  });

  it('runs the CREATE TABLE DDL on init', async () => {
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
    await (engine as unknown as { sink: PgMetricsSink }).sink.init();
    assert.ok(queries.some((t) => t.includes('CREATE TABLE IF NOT EXISTS _turbine_metrics')));
    assert.ok(queries.some((t) => t.includes('CREATE INDEX IF NOT EXISTS idx_turbine_metrics_bucket')));
  });
});

// ---------------------------------------------------------------------------
// Custom sink receives batches
// ---------------------------------------------------------------------------

describe('ObserveEngine with a custom sink', () => {
  it('routes aggregate batches to the sink (no connectionString needed)', async () => {
    const batches: MetricsFlushBatch[] = [];
    let inited = false;
    let stopped = false;
    const sink: ObserveSink = {
      init: async () => {
        inited = true;
      },
      flush: async (batch) => {
        batches.push(batch);
      },
      stop: async () => {
        stopped = true;
      },
    };

    const engine = new ObserveEngine({ sink });
    await engine.init();
    assert.equal(inited, true);

    const listener = engine.getListener();
    listener(event({ model: 'posts', action: 'create', duration: 5 }));
    listener(event({ model: 'posts', action: 'create', duration: 15 }));

    await engine.flush();
    await engine.stop();

    assert.equal(stopped, true);
    // One flush from the explicit call; stop() flushes again but the buffer is
    // already drained, so only the first carries rows.
    const withRows = batches.filter((b) => b.rows.length > 0);
    assert.equal(withRows.length, 1);
    const row = withRows[0]!.rows[0]!;
    assert.equal(row.model, 'posts');
    assert.equal(row.action, 'create');
    assert.equal(row.count, 2);
    assert.equal(row.avg, 10);
    assert.ok(row.bucket instanceof Date);
  });

  it('does not hand the sink an empty batch when nothing buffered', async () => {
    let flushes = 0;
    const engine = new ObserveEngine({
      sink: {
        flush: async () => {
          flushes++;
        },
      },
    });
    await engine.flush();
    assert.equal(flushes, 0);
  });
});

// ---------------------------------------------------------------------------
// HttpJsonSink
// ---------------------------------------------------------------------------

describe('HttpJsonSink', () => {
  const batch: MetricsFlushBatch = {
    rows: [
      {
        bucket: new Date(),
        model: 'users',
        action: 'findMany',
        count: 3,
        avg: 20,
        p50: 20,
        p95: 30,
        p99: 30,
        errors: 1,
      },
    ],
  };

  it('POSTs a JSON body with merged headers', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const sink = new HttpJsonSink({
      url: 'https://collector.example/ingest',
      headers: { authorization: 'Bearer t' },
      fetchFunction: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return { ok: true } as Response;
      }) as unknown as typeof fetch,
    });

    await sink.flush(batch);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'https://collector.example/ingest');
    assert.equal(calls[0]!.init.method, 'POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers['content-type'], 'application/json');
    assert.equal(headers.authorization, 'Bearer t');
    const body = JSON.parse(calls[0]!.init.body as string);
    assert.equal(body.rows.length, 1);
    assert.equal(body.rows[0].model, 'users');
    // The body carries no SQL and no params: aggregates only.
    assert.equal('sql' in body.rows[0], false);
    assert.equal('params' in body.rows[0], false);
  });

  it('never throws when fetch rejects', async () => {
    const sink = new HttpJsonSink({
      url: 'https://collector.example/ingest',
      fetchFunction: (async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch,
    });
    await assert.doesNotReject(() => sink.flush(batch));
  });

  it('skips the request entirely for an empty batch', async () => {
    let called = false;
    const sink = new HttpJsonSink({
      url: 'https://collector.example/ingest',
      fetchFunction: (async () => {
        called = true;
        return { ok: true } as Response;
      }) as unknown as typeof fetch,
    });
    await sink.flush({ rows: [] });
    assert.equal(called, false);
  });

  it('a failing HTTP sink never breaks the engine flush', async () => {
    const engine = new ObserveEngine({
      sink: new HttpJsonSink({
        url: 'https://collector.example/ingest',
        fetchFunction: (async () => {
          throw new Error('boom');
        }) as unknown as typeof fetch,
      }),
    });
    engine.getListener()(event());
    await assert.doesNotReject(() => engine.flush());
  });
});

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe('ObserveConfig validation', () => {
  it('throws when neither connectionString nor sink is provided', () => {
    assert.throws(() => new ObserveEngine({}), /connectionString or a sink/);
  });

  it('accepts a sink alone', () => {
    assert.doesNotThrow(() => new ObserveEngine({ sink: { flush: async () => {} } }));
  });

  it('accepts a connectionString alone', () => {
    assert.doesNotThrow(() => new ObserveEngine({ connectionString: 'postgres://unused' }));
  });
});
