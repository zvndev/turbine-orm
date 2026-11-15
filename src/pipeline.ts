/**
 * turbine-orm, Pipeline execution
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

import { acquireConnection, type Checkout } from './checkout.js';
import { type CheckoutGuard, guardCheckout } from './connection-guard.js';
import { type Dialect, postgresDialect } from './dialect.js';
import {
  ConnectionError,
  driverConnectionLoss,
  explainConnectionLoss,
  PipelineError,
  type PipelineResultSlot,
  refusedBeforeSending,
  TimeoutError,
  TransactionOutcomeUnknownError,
  TurbineError,
  wrapPgError,
} from './errors.js';
import type { PgCompatPool, PgCompatPoolClient, PgCompatQueryResult } from './pg-types.js';
import {
  type PipelineRunOptions,
  pipelineClientNeedsDiscard,
  runPipelined,
  supportsExtendedPipeline,
} from './pipeline-submittable.js';
import type { DeferredQuery } from './query/index.js';
import { completeTransaction } from './transaction-outcome.js';
import { answeredWithError, sendControl, TransactionState } from './transaction-state.js';

// ---------------------------------------------------------------------------
// Pipeline options (public)
// ---------------------------------------------------------------------------

export interface PipelineOptions {
  /**
   * Whether to wrap the pipeline in a transaction (default: true).
   *
   * - `true` (default): All queries execute atomically within BEGIN/COMMIT.
   *   If any query fails, nothing in the batch is committed.
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

/** Minimal client interface for sequential execution */
interface SequentialClient {
  query(text: string, values?: unknown[]): Promise<PgCompatQueryResult>;
}

/**
 * Run one deferred query on the batch's connection. An engine without
 * RETURNING (MySQL) attaches a `reselect` plan that runs the write and then
 * fetches its row; sending `q.sql` alone would hand the transform a row-less
 * result, which a single-row write reads as "not found".
 */
function runOne(client: SequentialClient, q: DeferredQuery<unknown>): Promise<PgCompatQueryResult> {
  return q.reselect ? q.reselect((sql, params) => client.query(sql, params)) : client.query(q.sql, q.params);
}

/**
 * Execute queries sequentially on an already-acquired connection.
 * This is the fallback path for clients that don't support the extended-query
 * pipeline protocol (HTTP drivers, mocks, etc.).
 *
 * A transactional batch is settled by {@link completeTransaction}, the same
 * settlement as an explicit transaction, which releases the connection itself:
 * discarded when its state is not confirmed (a COMMIT with no answer is
 * `TransactionOutcomeUnknownError`, and a rollback the server did not
 * acknowledge is reported as no rollback). Every other path leaves the release
 * to the caller (the finally block in {@link executePipeline}).
 *
 * A `timeout` covers both modes and every statement, BEGIN and COMMIT
 * included (see {@link withDeadline}).
 */
async function runSequential<T extends readonly DeferredQuery<unknown>[]>(
  held: Checkout,
  queries: T,
  dialect: Dialect,
  options: PipelineOptions = {},
): Promise<PipelineResults<T>> {
  const { transactional = true, timeout } = options;
  if (timeout && timeout > 0) {
    return withDeadline(held, timeout, (fenced) => runSequential(fenced, queries, dialect, { transactional }));
  }
  const { client, checkout } = held;

  if (!transactional) return runIndependent(held, queries);

  // Transaction control is wrapped too. It used to be bare, so a connection
  // that died between checkout and BEGIN (or at COMMIT) surfaced the raw
  // driver error while every statement between them surfaced a typed
  // TurbineError, and a caller branching on `err.code` saw neither
  // `TURBINE_E004` nor a retryable flag for the one failure that is most
  // worth retrying.
  try {
    await sendControl(client, dialect.beginStatement());
  } catch (err) {
    // Whether a transaction began is not known, so the connection is not reused.
    checkout.release(err instanceof Error ? err : true);
    throw err;
  }
  const state = new TransactionState(client, dialect);
  const tracked = { query: (sql: string, values?: unknown[]) => state.run(() => client.query(sql, values)) };
  return completeTransaction(held, state, dialect, undefined, async () => {
    const results: unknown[] = [];
    for (const q of queries) {
      let raw: PgCompatQueryResult;
      try {
        raw = await runOne(tracked, q);
      } catch (err) {
        throw wrapPgError(err);
      }
      // Transformed BEFORE the COMMIT, so a transform that refuses its result
      // (a `...OrThrow` miss, an optimistic-lock conflict) rolls the batch back.
      results.push(q.transform(raw));
    }
    return results as PipelineResults<T>;
  });
}

/**
 * Run a sequential batch under the pipeline's `timeout`. The protocol path
 * enforces it by destroying its socket; this path had no deadline at all, so a
 * statement or COMMIT that never got an answer held the checkout forever.
 *
 * At the deadline the call rejects with `TimeoutError` (E002) and outcome
 * `'unknown'`, as on the protocol path: a statement or a COMMIT in flight may
 * still take effect. The connection is released with that error, so the pool
 * retires it instead of lending it out. The batch runs on a fenced copy of the
 * client that refuses every statement once the deadline has passed, without
 * sending it, so nothing the batch would still send (its next statement, its
 * COMMIT, or a cleanup ROLLBACK after a COMMIT it already sent) reaches the
 * connection. A late answer finds the call settled and the checkout released
 * (the guard releases once).
 */
function withDeadline<R>(held: Checkout, timeout: number, run: (fenced: Checkout) => Promise<R>): Promise<R> {
  const { client, checkout } = held;
  let expired: TimeoutError | undefined;
  // Everything but `query` is the client's own (a driver's transaction
  // recovery policy included), read and called with the client itself as the
  // receiver, so accessors and private fields keep working. The proxy's own
  // target is a fresh object, so a frozen client imposes no proxy invariant.
  const fenced = new Proxy({} as PgCompatPoolClient, {
    get(_target, key) {
      if (key === 'query')
        return (text: string, values?: unknown[]) => (expired ? Promise.reject(expired) : client.query(text, values));
      const value: unknown = Reflect.get(client, key, client);
      return typeof value === 'function' ? value.bind(client) : value;
    },
    has: (_target, key) => Reflect.has(client, key),
    getPrototypeOf: () => Reflect.getPrototypeOf(client),
  });
  return new Promise<R>((resolve, reject) => {
    const timer = setTimeout(() => {
      expired = new TimeoutError(timeout, 'Pipeline');
      try {
        checkout.release(expired);
      } catch {
        // The deadline is the outcome; a release that throws must not replace it.
      }
      reject(expired);
    }, timeout);
    run({ client: fenced, checkout })
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}

/**
 * The dialect whose transaction keywords this batch must use.
 *
 * `executePipeline` is handed a POOL and nothing else, so the pool is the only
 * place the engine can be read from; the engine pool shims are the objects that
 * know their own dialect, and one of them (`MssqlPool`) publishes it for exactly
 * this. Anything else, a real `pg.Pool`, a serverless HTTP pool, a test mock,
 * keeps PostgreSQL, which is what every one of them already spoke.
 *
 * This existed as three hard-coded strings, `BEGIN` / `COMMIT` / `ROLLBACK`,
 * which is the one engine-specific decision in this file and the one it was not
 * making. On SQL Server a bare `BEGIN` opens a statement BLOCK, not a
 * transaction: `MssqlTxClient` matches the dialect's `BEGIN TRANSACTION` and
 * nothing else, so a bare `BEGIN` missed that branch, reached the server as a
 * block opener with no `END`, and was rejected; the `COMMIT` and `ROLLBACK`
 * that followed then found no open transaction and silently did nothing. A
 * pipeline that documents itself as atomic was neither atomic nor rolled back.
 *
 * Duck-typed rather than `instanceof`, deliberately: importing an engine module
 * here would pull an optional peer's whole module graph into the Postgres path.
 * The three methods tested are exactly the three called below, so a partial
 * object can never be accepted and then fail at the call site.
 */
function poolDialect(pool: PgCompatPool): Dialect {
  const candidate = (pool as { dialect?: unknown }).dialect;
  if (
    candidate !== null &&
    typeof candidate === 'object' &&
    typeof (candidate as Dialect).beginStatement === 'function' &&
    typeof (candidate as Dialect).commitStatement === 'function' &&
    typeof (candidate as Dialect).rollbackStatement === 'function'
  ) {
    return candidate as Dialect;
  }
  return postgresDialect;
}

/**
 * Sequential fallback for `{ transactional: false }`: each query is
 * INDEPENDENT, which is what that option promises and what the real pipeline
 * path already did. A failing query records its slot and the batch keeps going
 * (there is no transaction to poison), and if anything failed the whole batch
 * rejects with a `PipelineError` carrying every slot.
 *
 * It used to `throw wrapPgError(err)` on the first failure instead. That both
 * abandoned the remaining queries, contradicting the option's own docstring,
 * and rejected with the raw driver error, so `err instanceof PipelineError` and
 * `err.code === 'TURBINE_E014'` were permanently false on the one path that
 * documents them, and `err.results` did not exist at all. The first failure is
 * still reachable, as `.cause` and as the first `error` slot.
 *
 * Each query autocommits, so one whose connection failed under it without an
 * answer from the server may have run and committed, a SELECT included (it can
 * write through a function it calls). Its slot is
 * `TransactionOutcomeUnknownError` (E021) carrying the connection error. Only a
 * query the driver refused before sending it keeps the connection error, whose
 * advice is that a retry is safe. A connection that failed is released with
 * the error, so the pool discards it.
 */
async function runIndependent<T extends readonly DeferredQuery<unknown>[]>(
  { client, checkout }: Checkout,
  queries: T,
): Promise<PipelineResults<T>> {
  const slots: PipelineResultSlot[] = [];
  let firstError: Error | undefined;
  let failedIndex: number | undefined;
  let failedTag: string | undefined;
  let lost: Error | undefined;

  const fail = (index: number, error: Error): void => {
    slots.push({ status: 'error', error });
    if (firstError !== undefined) return;
    firstError = error;
    failedIndex = index;
    failedTag = queries[index]?.tag;
  };

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i]!;
    let raw: PgCompatQueryResult;
    try {
      raw = await runOne(client, q);
    } catch (err) {
      const wrapped = wrapPgError(driverConnectionLoss(err) ?? err);
      let error = wrapped instanceof Error ? wrapped : new Error(String(wrapped));
      if (error instanceof ConnectionError) {
        lost ??= error;
        if (!answeredWithError(error) && !refusedBeforeSending(error))
          error = new TransactionOutcomeUnknownError(error);
      }
      fail(i, error);
      continue;
    }
    // A transform throw is a slot failure too, not a batch abort: that is what
    // the real pipeline path's `finalize` does with the same situation. It is
    // deliberately NOT run through wrapPgError, since it never came from the
    // driver.
    try {
      slots.push({ status: 'ok', value: q.transform(raw) });
    } catch (err) {
      fail(i, err instanceof Error ? err : new Error(String(err)));
    }
  }

  if (lost) checkout.release(lost);
  if (firstError === undefined) {
    return slots.map((slot) => (slot as { value: unknown }).value) as unknown as PipelineResults<T>;
  }
  throw new PipelineError({ results: slots, failedIndex, failedTag, cause: firstError });
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
  pool: PgCompatPool,
  queries: T,
  options?: PipelineOptions,
  /** @internal The client's dialect, when the pool does not name one (see {@link poolDialect}). */
  dialect: Dialect = poolDialect(pool),
): Promise<PipelineResults<T>> {
  if (queries.length === 0) {
    return [] as unknown as PipelineResults<T>;
  }

  // One client, reused for both capability check and execution. The shared
  // checkout types a connection-level failure (wrong password, TLS, refused,
  // an exhausted pool) and guards the checkout window: a connection that dies
  // mid-batch emits 'error', which with no listener exits the process.
  const held = await acquireConnection(pool);
  const { client, checkout }: { client: PgCompatPoolClient; checkout: CheckoutGuard } = held;

  try {
    if (supportsExtendedPipeline(client)) {
      // Real pipeline path, uses extended-query protocol wire methods
      const pipelineOptions: PipelineRunOptions = {
        transactional: options?.transactional ?? true,
        timeout: options?.timeout,
      };
      const results = await runPipelined(client, queries, pipelineOptions);
      return results as PipelineResults<T>;
    }
    // Sequential fallback, reuses the same client. This is the path every
    // non-Postgres engine takes (none of their clients expose pg's wire
    // internals), so it is the one that has to speak the engine's transaction
    // keywords rather than Postgres's.
    return await runSequential(held, queries, dialect, options);
  } catch (err) {
    // Already-typed Turbine errors pass through untouched; anything else is a
    // driver error that must not escape with a SQLSTATE sitting in the same
    // `.code` slot Turbine puts TURBINE_E0NN in.
    if (err instanceof TurbineError) throw explainConnectionLoss(err, checkout.lostWith);
    throw explainConnectionLoss(wrapPgError(err), checkout.lostWith);
  } finally {
    // A client the pipeline could not return to a clean state is released WITH
    // an error, which is how pg-pool is told to drop it rather than lend it
    // out again. `runPipelined` rolls back its own aborted transaction, so this
    // is the residue: a rollback that did not take, or a backend left in a
    // transaction by something other than this module. Releasing such a client
    // normally is what turned one failed batch into `25P02` on somebody else's
    // query. A transactional sequential batch was already released by its
    // settlement, which leaves this a no-op (the guard releases once).
    if (pipelineClientNeedsDiscard(client)) {
      checkout.release(new Error('turbine: pipeline connection left an open transaction and was discarded'));
    } else {
      checkout.release();
    }
  }
}

/**
 * Check whether a pool supports the real pipeline protocol.
 * Call this to determine at runtime whether pipelines will use the fast path
 * or fall back to sequential execution.
 *
 * Note: This acquires and immediately releases a connection to inspect it.
 */
export async function pipelineSupported(pool: PgCompatPool): Promise<boolean> {
  let checkout: CheckoutGuard | undefined;
  try {
    const client = await pool.connect();
    checkout = guardCheckout(client);
    return supportsExtendedPipeline(client);
  } catch {
    return false;
  } finally {
    checkout?.release();
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
