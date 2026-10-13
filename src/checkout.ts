/**
 * turbine-orm, checking a connection out of a pool for a unit of work
 *
 * Every path that holds a pooled connection across awaits (`$transaction`,
 * `transaction()`, nested writes, cursor streams, `connect()`) starts the same
 * way: `pool.connect()`, a typed error if that fails, and a guard for the
 * checkout window (connection-guard.ts). They share this module so they cannot
 * drift apart on any of the three.
 *
 * {@link openCheckout} adds the one recovery that is always safe. A unit of
 * work opens with a statement that has no effect of its own (`BEGIN`, or the
 * `SELECT 1` of a connectivity check). If THAT statement fails because the
 * connection had already been closed by the server, nothing has run, so the
 * connection is destroyed and the statement is sent once more on a fresh one.
 * This is the write-path counterpart of the query builder's read retry: a
 * write cannot be resent after a lost connection, because nobody can tell
 * whether it committed first, but a transaction that has not begun holds no
 * write to lose.
 */

import { type CheckoutGuard, guardCheckout, settleEventLoop } from './connection-guard.js';
import {
  ConnectionError,
  explainConnectionLoss,
  isStaleConnectionError,
  UnsupportedFeatureError,
  wrapPgError,
} from './errors.js';
import type { PgCompatPool, PgCompatPoolClient } from './pg-types.js';

export interface Checkout {
  client: PgCompatPoolClient;
  /** Release through this, never `client.release()`, so the guard comes off. */
  checkout: CheckoutGuard;
}

/**
 * Check a connection out, as a typed Turbine error when that fails.
 *
 * `pool.connect()` is where the first-run failures actually land: wrong
 * password (SQLSTATE 28P01), no such database (3D000), nothing listening
 * (ECONNREFUSED), an unverifiable TLS certificate. Unwrapped, every one of
 * those left `$transaction`, `transaction()` and `connect()` as a raw pg
 * `DatabaseError` carrying a SQLSTATE in `.code`, the same property Turbine
 * puts `TURBINE_E0NN` in.
 *
 * Query paths reach the same errors through `pool.query()`, which checks out
 * internally and rejects with the connect error; the query boundary wraps
 * those, and {@link typeCheckoutTimeouts} types pg-pool's own checkout
 * failures on the pools Turbine owns.
 */
export async function acquireConnection(pool: PgCompatPool): Promise<Checkout> {
  if (typeof (pool as { connect?: unknown }).connect !== 'function') {
    const dialect = (pool as unknown as { dialect?: { name?: unknown } }).dialect?.name;
    throw new UnsupportedFeatureError(
      'Checking out a connection',
      typeof dialect === 'string' ? dialect : 'postgresql',
      'A transaction, a cursor stream, a pipeline or a write that takes several statements needs a connection ' +
        'of its own, and this pool has no `connect()` (a stateless HTTP driver). Pass a pool that can check out ' +
        'a connection, or run single statements.',
    );
  }
  let client: PgCompatPoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    throw checkoutError(err, pool);
  }
  return { client, checkout: guardCheckout(client) };
}

/** pg-pool's own words for a checkout that waited longer than `connectionTimeoutMillis`. */
const POOL_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect';
/** pg-pool's own words for a checkout from a pool that has been ended. */
const POOL_ENDED_MESSAGE = 'Cannot use a pool after calling end on the pool';

/** The pg-pool fields the timeout message reads. Absent on HTTP and engine pools. */
interface PoolSizing {
  readonly totalCount?: number;
  readonly waitingCount?: number;
  readonly options?: { readonly max?: number; readonly connectionTimeoutMillis?: number };
}

/**
 * A failed checkout as a typed error.
 *
 * pg-pool raises its two checkout failures as plain `Error`s with no code, so
 * `wrapPgError` (keyed on SQLSTATE and socket codes) passes them through and
 * the most common production connection failure, an exhausted pool, reached
 * callers as an untyped error: `instanceof ConnectionError` and
 * `code === 'TURBINE_E004'` both missed it. Everything else goes through
 * `wrapPgError` as before.
 */
export function checkoutError(err: unknown, pool?: unknown): unknown {
  if (!(err instanceof Error) || (err as { code?: unknown }).code !== undefined) return wrapPgError(err);
  if (err.message === POOL_TIMEOUT_MESSAGE) {
    const sizing = (pool ?? {}) as PoolSizing;
    const max = sizing.options?.max;
    const waitMs = sizing.options?.connectionTimeoutMillis;
    const waiting = sizing.waitingCount;
    const occupancy =
      max !== undefined
        ? ` All ${max} connections of the pool were checked out${waiting ? ` and ${waiting} other callers were waiting` : ''}.`
        : '';
    return new ConnectionError(
      `Timed out${waitMs ? ` after ${waitMs}ms` : ''} waiting for a free connection from the pool.${occupancy} ` +
        'Something is holding connections for longer than `connectionTimeoutMs`: long transactions or streams, ' +
        'or a query on the outer client inside a `$transaction` callback, which needs a second connection ' +
        'while the transaction holds the first (use `tx` there). Raise `poolSize` if the load is genuine.',
      { cause: err },
    );
  }
  if (err.message === POOL_ENDED_MESSAGE) {
    return new ConnectionError(
      'The connection pool has been shut down (`disconnect()` or `end()` was called), so no connection can be ' +
        'checked out. Create a new client, or stop issuing queries after shutting this one down.',
      { cause: err },
    );
  }
  return wrapPgError(err);
}

/** The pg-pool `connect` surface, in both its promise and callback forms. */
interface PatchablePool {
  connect?: (...args: unknown[]) => unknown;
}

/**
 * Make every checkout failure of a pool Turbine owns a typed error, for
 * `pool.query` as well as `pool.connect`.
 *
 * {@link acquireConnection} covers the paths that check out explicitly
 * (transactions, nested writes, streams, pipelines). An ordinary read or write
 * goes through `pool.query`, which checks out internally via `this.connect`
 * in callback form, so the conversion has to sit on `connect` itself. Wrapping
 * the error is all it does. For pools Turbine creates only, the same rule as
 * the connection guards: a caller's own pool is not Turbine's to patch.
 */
export function typeCheckoutTimeouts(pool: unknown): void {
  const p = pool as PatchablePool;
  const connect = p.connect;
  if (typeof connect !== 'function') return;
  p.connect = (...args: unknown[]): unknown => {
    const callback = args[0];
    if (typeof callback === 'function') {
      return connect.call(p, (err: unknown, ...rest: unknown[]) =>
        (callback as (...a: unknown[]) => unknown)(err ? checkoutError(err, pool) : err, ...rest),
      );
    }
    const pending = connect.apply(p, args) as Promise<unknown>;
    return pending.catch((err: unknown) => {
      throw checkoutError(err, pool);
    });
  };
}

/**
 * Check a connection out and run `opening` on it, retrying ONCE on a fresh
 * connection when `opening` fails with {@link isStaleConnectionError}.
 *
 * `opening` must be a statement with no effect (`BEGIN`, `SELECT 1`): the
 * retry is safe only because a failure there leaves nothing behind. Before the
 * retry the event loop runs one poll phase, so any other connection the server
 * closed alongside this one has been evicted from the idle list rather than
 * lent out again. On success the caller owns the checkout; on failure it has
 * already been released and the error (the retry's, if there was one) is
 * rethrown as {@link explainConnectionLoss} reports it.
 */
export async function openCheckout(
  pool: PgCompatPool,
  opening: (client: PgCompatPoolClient) => Promise<unknown>,
): Promise<Checkout> {
  for (let attempt = 0; ; attempt++) {
    const held = await acquireConnection(pool);
    try {
      await opening(held.client);
      return held;
    } catch (err) {
      const lostWith = held.checkout.lostWith;
      if (attempt === 0 && isStaleConnectionError(err)) {
        // Released WITH the error so pg-pool destroys it: the close that made
        // it fail may not have been read yet, and a connection the pool still
        // believes is queryable goes back to the idle list.
        held.checkout.release(err instanceof Error ? err : true);
        await settleEventLoop();
        continue;
      }
      held.checkout.release();
      throw explainConnectionLoss(err, lostWith);
    }
  }
}
