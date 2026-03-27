/**
 * turbine-orm — Pipeline execution
 *
 * Pipelines batch multiple independent queries into a single database round-trip.
 * Instead of N sequential awaits (N round-trips), you get 1 round-trip for all N queries.
 *
 * How it works:
 *   1. Each query method (findUnique, count, etc.) can produce a DeferredQuery descriptor
 *      containing the SQL, params, and a transform function.
 *   2. pipeline() collects these descriptors, executes them in a single Postgres
 *      pipeline/transaction, and maps each result through its transform.
 *
 * In the production Turbine engine, this would go through the Rust proxy which uses
 * actual Postgres pipeline protocol (libpq PQpipelineEnter). For the TS SDK prototype,
 * we simulate it by running queries concurrently on a single connection or via
 * a multi-statement batch.
 */

import type pg from 'pg';
import type { DeferredQuery } from './query.js';

// ---------------------------------------------------------------------------
// Pipeline executor
// ---------------------------------------------------------------------------

/**
 * Execute multiple deferred queries in a single batch.
 *
 * Uses a single connection from the pool and runs all queries within
 * a transaction to guarantee consistency and minimize round-trips.
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
): Promise<PipelineResults<T>> {
  if (queries.length === 0) {
    return [] as unknown as PipelineResults<T>;
  }

  // Acquire a single connection for the entire batch
  const client = await pool.connect();

  try {
    // Wrap in a transaction for consistency
    await client.query('BEGIN');

    // Execute all queries on the same connection — in sequence on a single
    // connection this avoids pool checkout overhead, and the Postgres server
    // processes them as a tight batch.
    //
    // Execute queries sequentially on the same connection to avoid the
    // "already executing a query" deprecation in pg@8. This is still faster
    // than separate pool checkouts because we skip N-1 acquire/release cycles.
    // Future: use actual Postgres pipeline protocol for true pipelining.
    const results: unknown[] = [];
    for (const q of queries) {
      const raw = await client.query(q.sql, q.params);
      results.push(q.transform(raw));
    }

    await client.query('COMMIT');

    return results as PipelineResults<T>;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
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
