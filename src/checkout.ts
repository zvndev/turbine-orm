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
import { explainConnectionLoss, isStaleConnectionError, wrapPgError } from './errors.js';
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
 * Query paths need no equivalent: `pool.query()` opens the connection itself
 * and rejects with the connect error, which the query boundary already wraps.
 */
export async function acquireConnection(pool: PgCompatPool): Promise<Checkout> {
  let client: PgCompatPoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    throw wrapPgError(err);
  }
  return { client, checkout: guardCheckout(client) };
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
