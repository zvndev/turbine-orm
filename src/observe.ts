/**
 * turbine-orm — Observability module
 *
 * Buffers query metrics in memory (keyed by model:action per minute bucket),
 * then periodically flushes aggregates (count, avg, p50, p95, p99, errors)
 * to a dedicated _turbine_metrics table. Uses a separate 1-connection pool
 * so metrics writes never contend with the application pool.
 */

import pg from 'pg';
import type { QueryEvent, QueryEventListener } from './query/index.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ObserveConfig {
  connectionString: string;
  flushIntervalMs?: number;
  retentionDays?: number;
}

export interface ObserveHandle {
  stop(): Promise<void>;
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
// Schema DDL
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
// Observe engine
// ---------------------------------------------------------------------------

export class ObserveEngine {
  private readonly pool: pg.Pool;
  private readonly buffer = new Map<string, BucketEntry>();
  private currentBucket: Date;
  private readonly flushIntervalMs: number;
  private readonly retentionDays: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly listener: QueryEventListener;
  private stopped = false;

  constructor(config: ObserveConfig) {
    this.pool = new pg.Pool({ connectionString: config.connectionString, max: 1 });
    this.flushIntervalMs = config.flushIntervalMs ?? 60_000;
    this.retentionDays = config.retentionDays ?? 30;
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
    await this.pool.query(SCHEMA_DDL);
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

    for (const [key, entry] of entries) {
      const [model, action] = key.split(':');
      const sorted = entry.durations.slice().sort((a, b) => a - b);
      const count = sorted.length;
      const avg = sorted.reduce((s, v) => s + v, 0) / count;
      const p50 = percentile(sorted, 0.5);
      const p95 = percentile(sorted, 0.95);
      const p99 = percentile(sorted, 0.99);

      try {
        await this.pool.query(UPSERT_SQL, [bucket, model, action, count, avg, p50, p95, p99, entry.errors]);
      } catch {
        // Fire-and-forget — never throw from flush
      }
    }

    try {
      await this.pool.query(RETENTION_SQL, [this.retentionDays]);
    } catch {
      // Best effort
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.flush();
    await this.pool.end();
  }
}

// ---------------------------------------------------------------------------
// Exported helpers for testing
// ---------------------------------------------------------------------------

export { floorToMinute, percentile };
