/**
 * turbine-orm, LISTEN/NOTIFY realtime pub/sub
 *
 * Postgres LISTEN/NOTIFY is a first-class realtime primitive that neither
 * Prisma nor Drizzle expose ergonomically. This module backs the thin
 * `$listen` / `$notify` methods on TurbineClient.
 *
 * Design, **one dedicated connection per subscription**:
 *
 *   Each `$listen(channel, handler)` acquires its OWN long-lived client from
 *   the pool, runs `LISTEN "chan"`, and keeps that connection checked out for
 *   the life of the subscription. This is the simplest correct model: each
 *   subscription owns its lifecycle, `unsubscribe()` cleanly UNLISTENs and
 *   releases exactly one connection, and there is no shared multiplexing
 *   state to reason about. The trade-off is one pool slot per active channel
 *   - for the handful of channels a typical app listens on, that's a fine
 *   price for clarity. (A future optimization could multiplex many channels
 *   over a single shared notification connection.)
 *
 * Serverless / HTTP-pool caveat:
 *
 *   LISTEN requires a *persistent* TCP connection that can push asynchronous
 *   notification messages back to the client. Stateless HTTP drivers
 *   (Neon HTTP, Vercel Postgres over fetch) cannot hold such a connection, so
 *   `$listen` will surface a clear error rather than hang. `$notify` works
 *   everywhere, it's a single round-trip `SELECT pg_notify(...)`.
 *
 * Connection loss:
 *
 *   A subscription's connection is held indefinitely with no query in flight,
 *   so a database restart, failover or `pg_terminate_backend` reaches it only
 *   as an `'error'` event. That event used to have no listener, which exits the
 *   process. It is now guarded (connection-guard.ts), and the subscription
 *   RECONNECTS by default: the dead connection is destroyed, a fresh one is
 *   checked out with exponential backoff, and `LISTEN` is re-issued. Postgres
 *   does not queue notifications for a listener that is not connected, so
 *   anything NOTIFYed during the gap is gone for good; `onReconnect` is the
 *   caller's cue to resynchronise from the source of truth.
 */

import type { PgCompatPool } from './client.js';
import { type CheckoutGuard, guardCheckout } from './connection-guard.js';
import { ConnectionError, ValidationError, wrapPgError } from './errors.js';

// ---------------------------------------------------------------------------
// Identifier validation
// ---------------------------------------------------------------------------

/**
 * Strict Postgres identifier: a letter or underscore followed by letters,
 * digits, or underscores. Channel names CANNOT be parameterized in
 * LISTEN/UNLISTEN (`LISTEN $1` is a syntax error), so the channel is the one
 * place an identifier is interpolated into SQL, it MUST pass this regex AND
 * go through `quoteIdent` before reaching the SQL string.
 */
const CHANNEL_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Postgres NAMEDATALEN caps identifiers at 63 bytes. */
const MAX_CHANNEL_LEN = 63;

/**
 * Validate a LISTEN/NOTIFY channel name. Throws ValidationError on anything
 * that isn't a plain, reasonable-length SQL identifier. This is enforced for
 * BOTH `$listen` (where the channel is interpolated) and `$notify` (where the
 * channel is a bound param), defensive parity, and it catches user typos
 * loudly.
 */
export function validateChannel(channel: string): void {
  if (typeof channel !== 'string' || channel.length === 0) {
    throw new ValidationError('$listen/$notify channel must be a non-empty string');
  }
  if (channel.length > MAX_CHANNEL_LEN) {
    throw new ValidationError(
      `$listen/$notify channel "${channel}" exceeds the ${MAX_CHANNEL_LEN}-character Postgres identifier limit`,
    );
  }
  if (!CHANNEL_REGEX.test(channel)) {
    throw new ValidationError(
      `Invalid $listen/$notify channel "${channel}", must match /^[A-Za-z_][A-Za-z0-9_]*$/ ` +
        '(letters, digits, underscores; cannot start with a digit)',
    );
  }
}

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

/** Handler invoked with the raw NOTIFY payload string (empty string if none). */
export type NotificationHandler = (payload: string) => void;

/** Backoff for re-establishing a subscription whose connection was lost. */
export interface ListenReconnectOptions {
  /** Delay before the first reconnect attempt. Default 100 ms. */
  initialDelayMs?: number;
  /** Ceiling for the doubling delay between attempts. Default 30,000 ms. */
  maxDelayMs?: number;
}

/** Options for `$listen`. */
export interface ListenOptions {
  /**
   * Re-establish the subscription after its connection is lost (a restart,
   * failover, compute suspend, `pg_terminate_backend`). Default `true`. With
   * `false` the subscription ends at the first loss, after `onError`.
   */
  reconnect?: boolean | ListenReconnectOptions;
  /**
   * Called when the connection is lost and after each failed reconnect
   * attempt. Defaults to one `console.error` line per event. The subscription
   * keeps retrying unless `reconnect` is `false`; call `unsubscribe()` to stop.
   */
  onError?: (err: Error) => void;
  /**
   * Called once `LISTEN` is active again on a fresh connection. Notifications
   * sent while the subscription was disconnected were NOT delivered and never
   * will be, so this is where to resynchronise from the source of truth.
   */
  onReconnect?: () => void;
}

/**
 * A live LISTEN subscription. Call `unsubscribe()` to UNLISTEN, detach the
 * handler, and release the dedicated connection back to the pool.
 */
export interface Subscription {
  /** The channel this subscription is listening on. */
  readonly channel: string;
  /**
   * Stop listening: runs `UNLISTEN "chan"`, removes the notification listener,
   * and releases the dedicated connection. Idempotent, safe to call twice.
   * Also cancels a pending reconnect.
   */
  unsubscribe(): Promise<void>;
}

type NotificationMessage = { channel: string; payload?: string };

/**
 * The minimal surface a pooled client must expose for LISTEN to work: it must
 * speak `query()`, emit `'notification'` events, and be releasable. `pg.PoolClient`
 * satisfies this; stateless HTTP clients do NOT (they have no `.on`).
 */
interface ListenCapableClient {
  query(text: string, values?: unknown[]): Promise<unknown>;
  on?(event: 'notification', listener: (msg: NotificationMessage) => void): unknown;
  removeListener?(event: 'notification', listener: (msg: NotificationMessage) => void): unknown;
  release(err?: Error | boolean): void;
}

/**
 * Internal registry handle so TurbineClient can track and tear down active
 * subscriptions on `disconnect()`.
 */
export interface ActiveSubscription extends Subscription {
  /** Tear down WITHOUT issuing UNLISTEN (used when the pool is being ended). */
  _forceRelease(): void;
}

const DEFAULT_RECONNECT: Required<ListenReconnectOptions> = { initialDelayMs: 100, maxDelayMs: 30_000 };

/** One checked-out LISTEN connection and everything needed to let go of it. */
interface ListenConnection {
  client: ListenCapableClient;
  checkout: CheckoutGuard;
  onNotification: (msg: NotificationMessage) => void;
}

/**
 * Check out a dedicated connection, wire the handler and run `LISTEN`. Throws
 * (typed) on failure, having given the connection back.
 */
async function openListenConnection(
  pool: PgCompatPool,
  channel: string,
  quotedChannel: string,
  handler: NotificationHandler,
  onLost: (err: Error) => void,
): Promise<ListenConnection> {
  let client: ListenCapableClient;
  try {
    client = (await pool.connect()) as unknown as ListenCapableClient;
  } catch (err) {
    throw wrapPgError(err);
  }

  // Verify the checked-out client can actually receive async notifications.
  // Stateless HTTP drivers return a client with no `.on`, LISTEN would hang
  // forever waiting for messages that can never arrive, so fail loudly now and
  // give the connection straight back.
  if (typeof client.on !== 'function') {
    client.release();
    throw new ConnectionError(
      '$listen requires a persistent connection that can push notifications. ' +
        'The configured pool returned a client with no event support (stateless HTTP drivers ' +
        'like Neon HTTP / Vercel Postgres cannot LISTEN). Use a TCP pg.Pool for LISTEN/NOTIFY.',
    );
  }

  const checkout = guardCheckout(client, onLost);
  const onNotification = (msg: NotificationMessage): void => {
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
    checkout.release(err instanceof Error ? err : true);
    throw wrapPgError(err);
  }
  return { client, checkout, onNotification };
}

/**
 * Acquire a dedicated connection, run `LISTEN "channel"`, and wire the handler.
 * A failure here is thrown to the `$listen` caller; only a connection lost
 * AFTER the subscription is established is retried.
 *
 * @param pool        the pg-compatible pool to check a long-lived client out of
 * @param channel     channel name, MUST already be validated by the caller
 * @param quotedChannel  the channel run through quoteIdent (interpolated into SQL)
 * @param handler     called with each notification's payload
 * @param onClosed    invoked when the subscription ends, so the client can
 *                    drop it from its active-subscription registry
 * @param options     reconnect policy and loss/reconnect callbacks
 */
export async function createSubscription(
  pool: PgCompatPool,
  channel: string,
  quotedChannel: string,
  handler: NotificationHandler,
  onClosed: (sub: ActiveSubscription) => void,
  options: ListenOptions = {},
): Promise<ActiveSubscription> {
  const backoff =
    options.reconnect === false
      ? undefined
      : { ...DEFAULT_RECONNECT, ...(typeof options.reconnect === 'object' ? options.reconnect : {}) };
  const reportError =
    options.onError ??
    ((err: Error): void => {
      console.error(`[turbine] $listen "${channel}": ${err.message}${backoff && !closed ? ', reconnecting' : ''}`);
    });

  let closed = false;
  let current: ListenConnection | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = backoff?.initialDelayMs ?? 0;

  /** Let go of the held connection. A lost one is destroyed, never pooled. */
  const dropCurrent = (destroy: Error | boolean | undefined): void => {
    const conn = current;
    if (!conn) return;
    current = undefined;
    conn.client.removeListener?.('notification', conn.onNotification);
    conn.checkout.release(destroy);
  };

  const scheduleReconnect = (): void => {
    if (closed || !backoff) return;
    timer = setTimeout(() => {
      timer = undefined;
      void attemptReconnect();
    }, delay);
    // A process with nothing else to do should not stay alive just to retry.
    timer.unref?.();
    delay = Math.min(delay * 2, backoff.maxDelayMs);
  };

  const onLost = (err: Error): void => {
    if (closed || !current) return;
    dropCurrent(err);
    const lost = wrapPgError(err);
    reportError(lost instanceof Error ? lost : err);
    if (!backoff) {
      closed = true;
      onClosed(sub);
      return;
    }
    delay = backoff.initialDelayMs;
    scheduleReconnect();
  };

  const attemptReconnect = async (): Promise<void> => {
    if (closed) return;
    let conn: ListenConnection;
    try {
      conn = await openListenConnection(pool, channel, quotedChannel, handler, onLost);
    } catch (err) {
      if (closed) return;
      reportError(err instanceof Error ? err : new Error(String(err)));
      scheduleReconnect();
      return;
    }
    if (closed) {
      // unsubscribe() or disconnect() ran while this attempt was in flight.
      conn.client.removeListener?.('notification', conn.onNotification);
      conn.checkout.release(true);
      return;
    }
    current = conn;
    if (backoff) delay = backoff.initialDelayMs;
    options.onReconnect?.();
  };

  current = await openListenConnection(pool, channel, quotedChannel, handler, onLost);

  const stop = (): void => {
    closed = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const sub: ActiveSubscription = {
    channel,
    async unsubscribe(): Promise<void> {
      if (closed) return;
      stop();
      const conn = current;
      if (!conn) {
        // Between connections: nothing is LISTENing, so there is nothing to undo.
        onClosed(sub);
        return;
      }
      try {
        await conn.client.query(`UNLISTEN ${quotedChannel}`);
      } catch (err) {
        // Best-effort: the connection may already be dead. Still detach +
        // release below so we don't leak the pool slot.
        dropCurrent(true);
        onClosed(sub);
        throw wrapPgError(err);
      }
      dropCurrent(undefined);
      onClosed(sub);
    },
    _forceRelease(): void {
      if (closed) return;
      stop();
      // Destroy the connection (release(true)) rather than return it to the pool:
      // we skip UNLISTEN here (the pool is being torn down), so a recycled
      // connection would otherwise carry a stale LISTEN registration. Destroying
      // it guarantees no pooled backend keeps receiving NOTIFY traffic. Matters
      // most for external/serverless pools, where disconnect() is a no-op and the
      // pool outlives this client.
      dropCurrent(true);
      onClosed(sub);
    },
  };

  return sub;
}
