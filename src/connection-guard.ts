/**
 * turbine-orm, connection error guard
 *
 * A pg client emits `'error'` when its socket dies: a database restart, a
 * failover, a serverless compute suspend, `pg_terminate_backend`. pg-pool keeps
 * a listener on every IDLE client and removes it at checkout, so for as long as
 * a client is checked out nobody is listening unless the borrower is, and an
 * `'error'` event with no listener is thrown by Node's EventEmitter. The
 * process exits. Every place Turbine holds a connection across an await
 * (`$transaction`, `transaction()`, nested writes, cursor streams, pipelines,
 * `$listen`, Studio and MCP requests) was one database restart away from taking
 * the application down with it.
 *
 * The fix is a listener for exactly the checkout window: attached right after
 * `pool.connect()` resolves (a promise continuation, so no socket event can
 * slip in before it), removed right after `release()`, which is where pg-pool
 * re-attaches its own. The listener does not need to reject anything itself:
 * pg already fails the in-flight query and every queued one, and any later
 * query on the dead client rejects with "not queryable", so the pending call
 * always rejects on its own. What was missing was only the listener that stops
 * the event from being fatal. It also records the first error, for two reasons:
 * `release()` passes it on so the pool destroys the connection instead of
 * lending it out again, and callers can report the ORIGINAL cause (say, 57P01
 * `terminating connection due to administrator command`) rather than the
 * follow-on "Client has encountered a connection error and is not queryable".
 *
 * ZERO imports, same reason as connection-url.ts: `query/`, `cli/` and
 * client.ts all check connections out, and a leaf is the only place all three
 * can share without a new edge in the import graph.
 */

/** The listener surface of a pg client. HTTP and engine shims have none. */
interface ErrorEmitter {
  on?(event: 'error', listener: (err: Error) => void): unknown;
  removeListener?(event: 'error', listener: (err: Error) => void): unknown;
}

/** Anything checked out of a pool: a `release()` plus, on pg, the emitter surface. */
interface Releasable {
  release(err?: Error | boolean): void;
}

export interface ConnectionGuard {
  /** The first error the connection emitted while guarded, if it emitted one. */
  readonly lostWith: Error | undefined;
  /** Remove the listener. Idempotent. For clients Turbine owns outright (a bare `pg.Client`). */
  detach(): void;
}

export interface CheckoutGuard extends ConnectionGuard {
  /**
   * Hand the client back to its pool and remove the listener. Idempotent. A
   * connection that errored while checked out is released WITH that error, so
   * pg-pool destroys it rather than returning it to the idle set; an explicit
   * `err` argument takes precedence.
   */
  release(err?: Error | boolean): void;
}

/** The event surface of a pg-pool. Engine shims and HTTP pools have none. */
interface ConnectEmitter {
  on?(event: 'connect', listener: (client: ErrorEmitter) => void): unknown;
}

/**
 * Keep every connection a pool opens from ever emitting an unheard `'error'`.
 * For pools Turbine creates itself, where it can: pg-pool listens on IDLE
 * clients only, so a checkout made outside Turbine's own guarded paths
 * (`db.pool.connect()` in application code, a CLI server's request handler) is
 * otherwise one database restart from exiting the process. The listener
 * absorbs nothing that matters: the borrower's pending query still rejects,
 * and pg-pool still evicts a client that failed. A pool with no `connect`
 * event (an engine shim) is left alone.
 */
export function absorbCheckedOutErrors(pool: unknown): void {
  const emitter = pool as ConnectEmitter;
  if (typeof emitter.on !== 'function') return;
  emitter.on('connect', (client) => {
    client.on?.('error', () => {});
  });
}

/**
 * Guard a connection for as long as the caller holds it. Use {@link guardCheckout}
 * for a pooled checkout; this form is for a client whose whole lifetime the
 * caller owns (`new pg.Client()` in a CLI command or `schemaPush`).
 *
 * `onLost` runs once, on the first error, for a holder that has no query in
 * flight to learn about the loss from (a LISTEN connection waiting for
 * notifications).
 */
export function guardConnection(client: unknown, onLost?: (err: Error) => void): ConnectionGuard {
  const emitter = client as ErrorEmitter;
  let lostWith: Error | undefined;
  let attached = false;
  const onError = (err: Error): void => {
    if (lostWith) return;
    lostWith = err;
    onLost?.(err);
  };
  if (typeof emitter.on === 'function') {
    emitter.on('error', onError);
    attached = true;
  }
  return {
    get lostWith() {
      return lostWith;
    },
    detach(): void {
      if (!attached) return;
      attached = false;
      emitter.removeListener?.('error', onError);
    },
  };
}

/** Guard a pooled checkout from `pool.connect()` until its `release()`. */
export function guardCheckout(client: Releasable, onLost?: (err: Error) => void): CheckoutGuard {
  const guard = guardConnection(client, onLost);
  let released = false;
  return {
    get lostWith() {
      return guard.lostWith;
    },
    detach: guard.detach,
    release(err?: Error | boolean): void {
      if (released) return;
      released = true;
      try {
        client.release(err ?? guard.lostWith);
      } finally {
        // After release, not before: pg-pool re-attaches its idle listener
        // inside release(), so detaching second leaves no window with none.
        // A connection that already failed keeps the listener: it is being
        // destroyed, pg emits 'error' a second time when the socket finally
        // ends, and a pool that does not re-listen on release would let that
        // one through. A live connection must shed it, or listeners pile up
        // across checkouts.
        if (!guard.lostWith) guard.detach();
      }
    },
  };
}

/**
 * Resolve after the event loop has run at least one full poll phase.
 *
 * Two `setImmediate` hops, not one: a continuation that starts in the poll
 * phase would reach its first hop in the SAME iteration's check phase, before
 * any socket event that arrived meanwhile has been read. The second hop is
 * queued for the next iteration, which polls first. `setTimeout` stands in on
 * runtimes without `setImmediate` (edge), where one timer turn also polls.
 */
export function settleEventLoop(): Promise<void> {
  const hop: (fn: () => void) => unknown =
    typeof setImmediate === 'function' ? setImmediate : (fn) => setTimeout(fn, 0);
  return new Promise((resolve) => {
    hop(() => hop(resolve));
  });
}

/**
 * How long a pool must have gone without a connection coming back before the
 * next checkout waits for {@link settleEventLoop}. Long enough that a pool in
 * steady use never pays it; short enough to cover a serverless freeze between
 * invocations, which is where dead idle connections come from.
 */
export const LONG_IDLE_SETTLE_MS = 1000;

/** The pg-pool surface {@link settleLongIdleCheckouts} wraps. */
interface SettlablePool {
  on?(event: 'release', listener: (err: unknown) => void): unknown;
  connect?: (...args: unknown[]) => unknown;
  readonly idleCount?: number;
}

/**
 * Stop a pool from lending out a connection the server has already closed.
 *
 * pg-pool evicts an idle connection when its socket reports the close, which
 * needs the event loop to read the socket. When the loop has NOT run (a
 * serverless function frozen between invocations, a long synchronous block),
 * a restart, failover, pooler recycle or compute suspend in that window leaves
 * every idle connection dead but still in the idle list. The first checkout
 * after the thaw runs before the loop polls, so it gets one, and so does every
 * concurrent caller: measured on PostgreSQL 17 with the loop blocked across a
 * `pg_terminate_backend` of all five idle connections, five concurrent queries
 * all failed with 57P01. Awake, the same terminate costs nothing, because the
 * closes are read as they arrive.
 *
 * So a checkout that would reuse a connection idle for at least
 * {@link LONG_IDLE_SETTLE_MS} first waits for one poll phase. Every close that
 * arrived during the freeze is read then, pg-pool evicts those connections,
 * and the checkout gets a live one or opens a fresh one. No round trip: a
 * `SELECT 1` validation would cost one on every such checkout, and the loop
 * turn is what actually carries the information. A pool in steady use returns
 * a connection far more often than once a second and never pays it.
 *
 * Idle age is taken from the last clean `'release'`: pg-pool reuses the most
 * recently returned connection first, so that is the age of the one the next
 * checkout gets. Wrapping `connect` covers `pool.query` too, which checks out
 * through `this.connect`. Pools without pg-pool's `'release'` event (engine
 * shims, HTTP pools) are left alone. For pools Turbine creates only: a
 * caller's own pool is not Turbine's to patch.
 */
export function settleLongIdleCheckouts(pool: unknown, idleMs: number = LONG_IDLE_SETTLE_MS): void {
  const p = pool as SettlablePool;
  const connect = p.connect;
  if (typeof p.on !== 'function' || typeof connect !== 'function') return;
  let lastReturnedAt = performance.now();
  p.on('release', (err) => {
    if (!err) lastReturnedAt = performance.now();
  });
  p.connect = (...args: unknown[]): unknown => {
    if (!((p.idleCount ?? 0) > 0) || performance.now() - lastReturnedAt < idleMs) return connect.apply(p, args);
    const settled = settleEventLoop().then(() => connect.apply(p, args));
    // Callback form (pool.query's internal checkout): the callback carries the
    // result, and pg-pool returns nothing in that form either.
    return typeof args[0] === 'function' ? undefined : settled;
  };
}
