/**
 * turbine-orm — LISTEN/NOTIFY realtime pub/sub
 *
 * Postgres LISTEN/NOTIFY is a first-class realtime primitive that neither
 * Prisma nor Drizzle expose ergonomically. This module backs the thin
 * `$listen` / `$notify` methods on TurbineClient.
 *
 * Design — **one dedicated connection per subscription**:
 *
 *   Each `$listen(channel, handler)` acquires its OWN long-lived client from
 *   the pool, runs `LISTEN "chan"`, and keeps that connection checked out for
 *   the life of the subscription. This is the simplest correct model: each
 *   subscription owns its lifecycle, `unsubscribe()` cleanly UNLISTENs and
 *   releases exactly one connection, and there is no shared multiplexing
 *   state to reason about. The trade-off is one pool slot per active channel
 *   — for the handful of channels a typical app listens on, that's a fine
 *   price for clarity. (A future optimization could multiplex many channels
 *   over a single shared notification connection.)
 *
 * Serverless / HTTP-pool caveat:
 *
 *   LISTEN requires a *persistent* TCP connection that can push asynchronous
 *   notification messages back to the client. Stateless HTTP drivers
 *   (Neon HTTP, Vercel Postgres over fetch) cannot hold such a connection, so
 *   `$listen` will surface a clear error rather than hang. `$notify` works
 *   everywhere — it's a single round-trip `SELECT pg_notify(...)`.
 */

import type { PgCompatPool } from './client.js';
import { ConnectionError, ValidationError, wrapPgError } from './errors.js';

// ---------------------------------------------------------------------------
// Identifier validation
// ---------------------------------------------------------------------------

/**
 * Strict Postgres identifier: a letter or underscore followed by letters,
 * digits, or underscores. Channel names CANNOT be parameterized in
 * LISTEN/UNLISTEN (`LISTEN $1` is a syntax error), so the channel is the one
 * place an identifier is interpolated into SQL — it MUST pass this regex AND
 * go through `quoteIdent` before reaching the SQL string.
 */
const CHANNEL_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Postgres NAMEDATALEN caps identifiers at 63 bytes. */
const MAX_CHANNEL_LEN = 63;

/**
 * Validate a LISTEN/NOTIFY channel name. Throws ValidationError on anything
 * that isn't a plain, reasonable-length SQL identifier. This is enforced for
 * BOTH `$listen` (where the channel is interpolated) and `$notify` (where the
 * channel is a bound param) — defensive parity, and it catches user typos
 * loudly.
 */
export function validateChannel(channel: string): void {
  if (typeof channel !== 'string' || channel.length === 0) {
    throw new ValidationError('[turbine] $listen/$notify channel must be a non-empty string');
  }
  if (channel.length > MAX_CHANNEL_LEN) {
    throw new ValidationError(
      `[turbine] $listen/$notify channel "${channel}" exceeds the ${MAX_CHANNEL_LEN}-character Postgres identifier limit`,
    );
  }
  if (!CHANNEL_REGEX.test(channel)) {
    throw new ValidationError(
      `[turbine] Invalid $listen/$notify channel "${channel}" — must match /^[A-Za-z_][A-Za-z0-9_]*$/ ` +
        '(letters, digits, underscores; cannot start with a digit)',
    );
  }
}

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

/** Handler invoked with the raw NOTIFY payload string (empty string if none). */
export type NotificationHandler = (payload: string) => void;

/**
 * A live LISTEN subscription. Call `unsubscribe()` to UNLISTEN, detach the
 * handler, and release the dedicated connection back to the pool.
 */
export interface Subscription {
  /** The channel this subscription is listening on. */
  readonly channel: string;
  /**
   * Stop listening: runs `UNLISTEN "chan"`, removes the notification listener,
   * and releases the dedicated connection. Idempotent — safe to call twice.
   */
  unsubscribe(): Promise<void>;
}

/**
 * The minimal surface a pooled client must expose for LISTEN to work: it must
 * speak `query()`, emit `'notification'` events, and be releasable. `pg.PoolClient`
 * satisfies this; stateless HTTP clients do NOT (they have no `.on`).
 */
interface ListenCapableClient {
  query(text: string, values?: unknown[]): Promise<unknown>;
  on?(event: 'notification', listener: (msg: { channel: string; payload?: string }) => void): unknown;
  removeListener?(event: 'notification', listener: (msg: { channel: string; payload?: string }) => void): unknown;
  release?(err?: Error | boolean): void;
}

/**
 * Internal registry handle so TurbineClient can track and tear down active
 * subscriptions on `disconnect()`.
 */
export interface ActiveSubscription extends Subscription {
  /** Tear down WITHOUT issuing UNLISTEN (used when the pool is being ended). */
  _forceRelease(): void;
}

/**
 * Acquire a dedicated connection, run `LISTEN "channel"`, and wire the handler.
 *
 * @param pool        the pg-compatible pool to check a long-lived client out of
 * @param channel     channel name — MUST already be validated by the caller
 * @param quotedChannel  the channel run through quoteIdent (interpolated into SQL)
 * @param handler     called with each notification's payload
 * @param onClosed    invoked when the subscription releases, so the client can
 *                    drop it from its active-subscription registry
 */
export async function createSubscription(
  pool: PgCompatPool,
  channel: string,
  quotedChannel: string,
  handler: NotificationHandler,
  onClosed: (sub: ActiveSubscription) => void,
): Promise<ActiveSubscription> {
  let client: ListenCapableClient;
  try {
    client = (await pool.connect()) as unknown as ListenCapableClient;
  } catch (err) {
    throw wrapPgError(err);
  }

  // Verify the checked-out client can actually receive async notifications.
  // Stateless HTTP drivers return a client with no `.on` — LISTEN would hang
  // forever waiting for messages that can never arrive, so fail loudly now and
  // give the connection straight back.
  if (typeof client.on !== 'function') {
    client.release?.();
    throw new ConnectionError(
      '[turbine] $listen requires a persistent connection that can push notifications. ' +
        'The configured pool returned a client with no event support (stateless HTTP drivers ' +
        'like Neon HTTP / Vercel Postgres cannot LISTEN). Use a TCP pg.Pool for LISTEN/NOTIFY.',
    );
  }

  const onNotification = (msg: { channel: string; payload?: string }): void => {
    // pg delivers ALL notifications for the connection to every listener; a
    // dedicated connection only ever LISTENs on one channel, but guard anyway.
    if (msg.channel === channel) {
      handler(msg.payload ?? '');
    }
  };

  try {
    client.on('notification', onNotification);
    await client.query(`LISTEN ${quotedChannel}`);
  } catch (err) {
    client.removeListener?.('notification', onNotification);
    client.release?.();
    throw wrapPgError(err);
  }

  let closed = false;

  const sub: ActiveSubscription = {
    channel,
    async unsubscribe(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        await client.query(`UNLISTEN ${quotedChannel}`);
      } catch (err) {
        // Best-effort: the connection may already be dead. Still detach +
        // release below so we don't leak the pool slot.
        client.removeListener?.('notification', onNotification);
        client.release?.();
        onClosed(sub);
        throw wrapPgError(err);
      }
      client.removeListener?.('notification', onNotification);
      client.release?.();
      onClosed(sub);
    },
    _forceRelease(): void {
      if (closed) return;
      closed = true;
      client.removeListener?.('notification', onNotification);
      // Destroy the connection (release(true)) rather than return it to the pool:
      // we skip UNLISTEN here (the pool is being torn down), so a recycled
      // connection would otherwise carry a stale LISTEN registration. Destroying
      // it guarantees no pooled backend keeps receiving NOTIFY traffic. Matters
      // most for external/serverless pools, where disconnect() is a no-op and the
      // pool outlives this client.
      client.release?.(true);
      onClosed(sub);
    },
  };

  return sub;
}
