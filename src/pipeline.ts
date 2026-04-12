/**
 * turbine-orm — Pipeline execution
 *
 * Pipelines batch multiple independent queries into a single database round-trip.
 * Instead of N sequential awaits (N round-trips), you get 1 round-trip for all N queries.
 *
 * How it works:
 *   1. Each query method (findUnique, count, etc.) can produce a DeferredQuery descriptor
 *      containing the SQL, params, and a transform function.
 *   2. pipeline() collects these descriptors, checks whether the underlying pool client
 *      supports the extended-query pipeline protocol, and either:
 *      (a) executes them via real Postgres pipeline protocol (one TCP flush), or
 *      (b) falls back to sequential execution on a single connection.
 *
 * Real pipeline mode uses `src/pipeline-submittable.ts` which drives the pg Connection's
 * wire-protocol methods (parse/bind/describe/execute/sync) directly with listener-swap.
 *
 * Sequential fallback covers HTTP-based drivers (Neon HTTP, Vercel Postgres, Cloudflare
 * Hyperdrive), mock pools in tests, and any pool that doesn't expose pg internals.
 */

import type pg from 'pg';
import { wrapPgError } from './errors.js';
import { type PipelineRunOptions, runPipelined, supportsExtendedPipeline } from './pipeline-submittable.js';
import type { DeferredQuery } from './query/index.js';

// ---------------------------------------------------------------------------
// Pipeline options (public)
// ---------------------------------------------------------------------------

export interface PipelineOptions {
  /**
   * Whether to wrap the pipeline in a transaction (default: true).
   *
   * - `true` (default): All queries execute atomically within BEGIN/COMMIT.
   *   If any query fails, the entire batch is rolled back.
   *
   * - `false`: Each query is independent. A failure in one query does NOT
   *   affect others. On partial failure, a `PipelineError` is thrown with
   *   per-query results in `.results`.
   */
  transactional?: boolean;

  /** Timeout in milliseconds. If exceeded, the connection is destroyed. */
  timeout?: number;
}

// ---------------------------------------------------------------------------
// Sequential fallback (for HTTP drivers, mocks, etc.)
// ---------------------------------------------------------------------------

/** Minimal client interface for sequential execution (avoids importing pg.PoolClient) */
interface SequentialClient {
  query(text: string, values?: unknown[]): Promise<pg.QueryResult>;
  release(err?: Error | boolean): void;
}

/**
 * Execute queries sequentially on an already-acquired connection.
 * This is the fallback path for clients that don't support the extended-query
 * pipeline protocol (HTTP drivers, mocks, etc.).
 *
 * The caller is responsible for acquiring the client and releasing it after
 * this function completes (in the finally block).
 */
async function runSequential<T extends readonly DeferredQuery<unknown>[]>(
  client: SequentialClient,
  queries: T,
  options: PipelineOptions = {},
): Promise<PipelineResults<T>> {
  const { transactional = true } = options;

  try {
    if (transactional) {
      await client.query('BEGIN');
    }

    const results: unknown[] = [];
    for (const q of queries) {
      let raw: pg.QueryResult;
      try {
        raw = await client.query(q.sql, q.params);
      } catch (err) {
        throw wrapPgError(err);
      }
      results.push(q.transform(raw));
    }

    if (transactional) {
      await client.query('COMMIT');
    }

    return results as PipelineResults<T>;
  } catch (err) {
    if (transactional) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Best-effort rollback
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Pipeline executor (public)
// ---------------------------------------------------------------------------

/**
 * Execute multiple deferred queries in a single batch.
 *
 * On pg.Pool-backed connections with the standard TCP driver, this uses the
 * real Postgres extended-query pipeline protocol for true 1-RTT execution.
 * On HTTP-based drivers (Neon HTTP, Vercel Postgres, etc.) or mock pools,
 * it falls back to sequential execution on a single connection.
 *
 * @example
 * ```ts
 * const [user, count, posts] = await executePipeline(pool, [
 *   db.users.buildFindUnique({ where: { id: 1 } }),
 *   db.posts.buildCount({ where: { orgId: 1 } }),
 *   db.posts.buildFindMany({ where: { userId: 1 }, limit: 10 }),
 * ]);
 * ```
 */
export async function executePipeline<T extends readonly DeferredQuery<unknown>[]>(
  pool: pg.Pool,
  queries: T,
  options?: PipelineOptions,
): Promise<PipelineResults<T>> {
  if (queries.length === 0) {
    return [] as unknown as PipelineResults<T>;
  }

  // Acquire a single client — reused for both capability check and execution
  const client = await pool.connect();

  try {
    if (supportsExtendedPipeline(client)) {
      // Real pipeline path — uses extended-query protocol wire methods
      const pipelineOptions: PipelineRunOptions = {
        transactional: options?.transactional ?? true,
        timeout: options?.timeout,
      };
      const results = await runPipelined(client, queries, pipelineOptions);
      return results as PipelineResults<T>;
    }
    // Sequential fallback — reuses the same client
    return await runSequential(client, queries, options);
  } finally {
    client.release();
  }
}

/**
 * Check whether a pool supports the real pipeline protocol.
 * Call this to determine at runtime whether pipelines will use the fast path
 * or fall back to sequential execution.
 *
 * Note: This acquires and immediately releases a connection to inspect it.
 */
export async function pipelineSupported(pool: pg.Pool): Promise<boolean> {
  let client: pg.PoolClient | undefined;
  try {
    client = await pool.connect();
    return supportsExtendedPipeline(client);
  } catch {
    return false;
  } finally {
    client?.release();
  }
}

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

/**
 * Extract the result types from a tuple of DeferredQuery objects.
 * If you pass [DeferredQuery<User>, DeferredQuery<number>, DeferredQuery<Post[]>],
 * you get back [User, number, Post[]].
 */
export type PipelineResults<T extends readonly DeferredQuery<unknown>[]> = {
  [K in keyof T]: T[K] extends DeferredQuery<infer R> ? R : never;
};
