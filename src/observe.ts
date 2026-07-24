/**
 * turbine-orm: Observability module
 *
 * Buffers query metrics in memory (keyed by model:action per minute bucket),
 * then periodically flushes aggregates (count, avg, p50, p95, p99, errors) to a
 * pluggable {@link ObserveSink}. The default sink writes to a dedicated
 * `_turbine_metrics` Postgres table over its own 1-connection pool, so metrics
 * writes never contend with the application pool; alternative sinks (for example
 * {@link HttpJsonSink}) can forward the same aggregates elsewhere.
 *
 * The aggregation privacy posture is deliberate: a batch carries only the
 * model/action identity, the counts, and the latency percentiles. It never
 * carries SQL text or bound parameter values.
 */

import pg from 'pg';
import type { QueryEvent, QueryEventListener } from './query/index.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ObserveConfig {
  /**
   * Metrics database connection string for the default Postgres sink. Optional
   * when a {@link ObserveConfig.sink} is supplied; at least one of the two must
   * be present.
   */
  connectionString?: string;
  flushIntervalMs?: number;
  retentionDays?: number;
  /**
   * A custom flush target. When omitted, the engine writes to `_turbine_metrics`
   * via the default Postgres sink (byte-identical to the pre-sink writer).
   */
  sink?: ObserveSink;
}

export interface ObserveHandle {
  stop(): Promise<void>;
}

/** One per-bucket aggregate row. Identity + numbers only: no SQL, no params. */
export interface MetricsFlushRow {
  /** Minute bucket the aggregate belongs to. */
  bucket: Date;
  model: string;
  action: string;
  count: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  errors: number;
}

/** A batch of aggregate rows handed to a sink on each flush. */
export interface MetricsFlushBatch {
  rows: MetricsFlushRow[];
}

/**
 * A pluggable flush target for the observe engine. `init` runs once at startup
 * (create tables, open connections); `flush` receives each aggregate batch;
 * `stop` tears down on shutdown. A sink must never let a flush error escape into
 * the application: metrics are best-effort by contract.
 */
export interface ObserveSink {
  init?(): Promise<void>;
  flush(batch: MetricsFlushBatch): Promise<void>;
  stop?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal buffer
// ---------------------------------------------------------------------------

interface BucketEntry {
  durations: number[];
  errors: number;
}

function floorToMinute(date: Date): Date {
  const d = new Date(date);
  d.setSeconds(0, 0);
  return d;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

// ---------------------------------------------------------------------------
// Schema DDL + statements (default Postgres sink)
// ---------------------------------------------------------------------------

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS _turbine_metrics (
  id          BIGSERIAL PRIMARY KEY,
  bucket      TIMESTAMPTZ NOT NULL,
  model       TEXT NOT NULL,
  action      TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  avg_ms      REAL NOT NULL DEFAULT 0,
  p50_ms      REAL NOT NULL DEFAULT 0,
  p95_ms      REAL NOT NULL DEFAULT 0,
  p99_ms      REAL NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(bucket, model, action)
);
CREATE INDEX IF NOT EXISTS idx_turbine_metrics_bucket ON _turbine_metrics(bucket);
`;

const UPSERT_SQL = `
INSERT INTO _turbine_metrics (bucket, model, action, count, avg_ms, p50_ms, p95_ms, p99_ms, error_count)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (bucket, model, action) DO UPDATE SET
  count = _turbine_metrics.count + EXCLUDED.count,
  avg_ms = (_turbine_metrics.avg_ms * _turbine_metrics.count + EXCLUDED.avg_ms * EXCLUDED.count)
           / (_turbine_metrics.count + EXCLUDED.count),
  p50_ms = EXCLUDED.p50_ms,
  p95_ms = EXCLUDED.p95_ms,
  p99_ms = EXCLUDED.p99_ms,
  error_count = _turbine_metrics.error_count + EXCLUDED.error_count
`;

const RETENTION_SQL = `DELETE FROM _turbine_metrics WHERE bucket < NOW() - INTERVAL '1 day' * $1`;

// ---------------------------------------------------------------------------
// Default sink: the _turbine_metrics Postgres writer
// ---------------------------------------------------------------------------

export interface PgMetricsSinkOptions {
  connectionString: string;
  retentionDays?: number;
}

/**
 * The default flush target: upserts each aggregate row into `_turbine_metrics`
 * and prunes rows older than `retentionDays`. The SQL and per-row/retention
 * ordering are byte-identical to the pre-sink `ObserveEngine.flush` writer.
 */
export class PgMetricsSink implements ObserveSink {
  private readonly pool: pg.Pool;
  private readonly retentionDays: number;

  constructor(options: PgMetricsSinkOptions) {
    this.pool = new pg.Pool({ connectionString: options.connectionString, max: 1 });
    this.retentionDays = options.retentionDays ?? 30;
  }

  async init(): Promise<void> {
    await this.pool.query(SCHEMA_DDL);
  }

  async flush(batch: MetricsFlushBatch): Promise<void> {
    if (batch.rows.length === 0) return;

    for (const row of batch.rows) {
      try {
        await this.pool.query(UPSERT_SQL, [
          row.bucket,
          row.model,
          row.action,
          row.count,
          row.avg,
          row.p50,
          row.p95,
          row.p99,
          row.errors,
        ]);
      } catch {
        // Fire-and-forget: never throw from flush
      }
    }

    try {
      await this.pool.query(RETENTION_SQL, [this.retentionDays]);
    } catch {
      // Best effort
    }
  }

  async stop(): Promise<void> {
    await this.pool.end();
  }
}

// ---------------------------------------------------------------------------
// Generic HTTP sink: POST JSON batches to any collector endpoint
// ---------------------------------------------------------------------------

export interface HttpJsonSinkOptions {
  /** Endpoint that receives POSTed JSON batches. */
  url: string;
  /** Extra request headers (for example an auth token). */
  headers?: Record<string, string>;
  /** Override the fetch implementation (defaults to the global `fetch`). */
  fetchFunction?: typeof fetch;
}

/**
 * Forwards each aggregate batch to an HTTP endpoint as a JSON POST. Fire-and-
 * forget: a failed request is swallowed and never throws, and there are no
 * retries beyond the engine's next scheduled flush. Aggregates only: the body
 * carries no SQL text and no parameter values.
 */
export class HttpJsonSink implements ObserveSink {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly fetchFn: typeof fetch;

  constructor(options: HttpJsonSinkOptions) {
    this.url = options.url;
    this.headers = options.headers ?? {};
    this.fetchFn = options.fetchFunction ?? fetch;
  }

  async flush(batch: MetricsFlushBatch): Promise<void> {
    if (batch.rows.length === 0) return;
    try {
      await this.fetchFn(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.headers },
        body: JSON.stringify(batch),
      });
    } catch {
      // Fire-and-forget: a failing collector never affects the application.
    }
  }
}

// ---------------------------------------------------------------------------
// Observe engine
// ---------------------------------------------------------------------------

export class ObserveEngine {
  private readonly sink: ObserveSink;
  private readonly buffer = new Map<string, BucketEntry>();
  private currentBucket: Date;
  private readonly flushIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly listener: QueryEventListener;
  private stopped = false;

  constructor(config: ObserveConfig) {
    if (!config.sink && !config.connectionString) {
      throw new Error('ObserveEngine requires either a connectionString or a sink');
    }
    this.sink =
      config.sink ??
      new PgMetricsSink({ connectionString: config.connectionString!, retentionDays: config.retentionDays ?? 30 });
    this.flushIntervalMs = config.flushIntervalMs ?? 60_000;
    this.currentBucket = floorToMinute(new Date());

    this.listener = (event: QueryEvent) => {
      if (this.stopped) return;
      const nowBucket = floorToMinute(new Date());
      if (nowBucket.getTime() !== this.currentBucket.getTime()) {
        this.currentBucket = nowBucket;
      }
      const key = `${event.model}:${event.action}`;
      let entry = this.buffer.get(key);
      if (!entry) {
        entry = { durations: [], errors: 0 };
        this.buffer.set(key, entry);
      }
      entry.durations.push(event.duration);
      if (event.error) entry.errors++;
    };
  }

  getListener(): QueryEventListener {
    return this.listener;
  }

  async init(): Promise<void> {
    await this.sink.init?.();
    this.timer = setInterval(() => {
      this.flush().catch(() => {});
    }, this.flushIntervalMs);
    // Unref so it doesn't keep the process alive
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      (this.timer as NodeJS.Timeout).unref();
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.size === 0) return;

    const bucket = this.currentBucket;
    const entries = new Map(this.buffer);
    this.buffer.clear();

    const rows: MetricsFlushRow[] = [];
    for (const [key, entry] of entries) {
      const [model, action] = key.split(':');
      const sorted = entry.durations.slice().sort((a, b) => a - b);
      const count = sorted.length;
      const avg = sorted.reduce((s, v) => s + v, 0) / count;
      rows.push({
        bucket,
        model: model ?? '',
        action: action ?? '',
        count,
        avg,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        p99: percentile(sorted, 0.99),
        errors: entry.errors,
      });
    }

    await this.sink.flush({ rows });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.flush();
    await this.sink.stop?.();
  }
}

// ---------------------------------------------------------------------------
// Exported helpers for testing
// ---------------------------------------------------------------------------

export { floorToMinute, percentile };
