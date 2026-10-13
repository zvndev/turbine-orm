/**
 * turbine-orm: the abandoned-stream idle guard.
 *
 * A cursor stream holds a checked-out connection between pulls (and, on
 * PostgreSQL, an open transaction whose snapshot pins the xmin horizon for the
 * whole database). A consumer that stops pulling without calling `return()`
 * leaves the stream suspended at a `yield` forever, and a suspended generator
 * runs no code, so nothing would ever release either. This guard is the code
 * that runs instead: a timer that notices the consumer has asked for nothing for
 * the configured time and closes the stream from outside.
 *
 * The consuming generator owns the {@link StreamIdleState}: it sets `suspended`
 * around each yield and bumps `pulls` when the consumer resumes it. That is two
 * writes per yield and no timer work, which is what keeps a per-row stream as
 * cheap as before (a timer refreshed per row costs about 15% per row; a
 * `setTimeout` per row more than doubles it).
 *
 * Leaf module: imports errors.ts only, so it stays in the serverless graph
 * without pulling anything node-only.
 */

import { TimeoutError, ValidationError } from '../errors.js';

/** The default for `streamIdleTimeoutMs` (client) and `idleTimeoutMs` (per call). */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;

/**
 * How much later than the idle timeout the PostgreSQL server-side limit fires.
 * The client timer always expires a stream first (it ticks at most every
 * {@link MAX_TICK_MS}, half this grace), so the server limit only acts when the
 * process has stopped running timers: frozen between serverless invocations,
 * or an event loop blocked for longer than the grace.
 */
export const STREAM_IDLE_BACKSTOP_GRACE_MS = 10_000;

/**
 * The largest idle timeout accepted. PostgreSQL's
 * `idle_in_transaction_session_timeout` is a 32-bit count of milliseconds, and
 * the backstop adds the grace to it.
 */
export const MAX_STREAM_IDLE_TIMEOUT_MS = 2_147_483_647 - STREAM_IDLE_BACKSTOP_GRACE_MS;

/** The longest gap between two idle checks, so expiry lands within 5 s of the timeout. */
const MAX_TICK_MS = 5_000;

/**
 * Validate an idle timeout: a whole number of milliseconds from 0 (disabled)
 * to {@link MAX_STREAM_IDLE_TIMEOUT_MS}, else E003. `undefined` means "not
 * set here", so the caller falls back to the next level.
 */
export function resolveStreamIdleTimeout(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_STREAM_IDLE_TIMEOUT_MS) {
    throw new ValidationError(
      `Invalid ${name}: ${typeof value === 'string' ? JSON.stringify(value) : String(value)}. Expected a whole ` +
        `number of milliseconds from 0 (no idle timeout) to ${MAX_STREAM_IDLE_TIMEOUT_MS}.`,
    );
  }
  return value;
}

/**
 * What the generator that yields to the consumer tells the guard. Written
 * around every yield; read by the guard's timer.
 */
export interface StreamIdleState {
  /** How many times the consumer has resumed the stream. */
  pulls: number;
  /** The stream is suspended at a yield, waiting for the consumer to ask for more. */
  suspended: boolean;
  /** Rows handed to the consumer so far, for the log line. */
  rows: number;
  /** Set when the guard closed the stream; the next pull throws it. */
  expired: TimeoutError | undefined;
}

export function newStreamIdleState(): StreamIdleState {
  return { pulls: 0, suspended: false, rows: 0, expired: undefined };
}

/** The E002 the next pull on an expired stream throws. */
export function streamIdleExpiredError(action: string, table: string, timeoutMs: number, unit: string): TimeoutError {
  return new TimeoutError(timeoutMs, 'Stream', {
    message:
      `${action} on "${table}" was closed after ${timeoutMs} ms with no ${unit} requested: its cursor and ` +
      `connection were released so an abandoned stream cannot hold a pooled connection and the database's ` +
      `snapshot. Consume faster, raise streamIdleTimeoutMs (client) or idleTimeoutMs (this call), or pass 0 ` +
      'to disable.',
    outcome: 'not-executed',
  });
}

/**
 * The PostgreSQL server-side limit for a stream's own transaction:
 * `idle_in_transaction_session_timeout` set to the idle timeout plus the grace,
 * TRANSACTION-LOCAL (`set_config(..., true)`), so it ends with the stream's
 * COMMIT and cannot reach another client through a transaction pooler.
 *
 * A stricter limit already in force (a role or server setting below ours) is
 * kept, so a stream never loosens what the operator configured. The value is a
 * validated integer, never caller text: a GUC value cannot be a bind parameter.
 * Reading `pg_settings` rather than calling `set_config` directly also means an
 * engine without the setting gets no row and no error.
 */
export function streamBackstopStatement(timeoutMs: number): string {
  const limit = timeoutMs + STREAM_IDLE_BACKSTOP_GRACE_MS;
  if (!Number.isSafeInteger(limit) || limit <= STREAM_IDLE_BACKSTOP_GRACE_MS || limit > 2_147_483_647) {
    throw new ValidationError(`Invalid stream idle timeout ${String(timeoutMs)} for the server-side limit.`);
  }
  return (
    "SELECT set_config('idle_in_transaction_session_timeout', CASE WHEN s.setting::bigint > 0 AND " +
    `s.setting::bigint < ${limit} THEN s.setting ELSE '${limit}' END, true) FROM pg_settings s ` +
    "WHERE s.name = 'idle_in_transaction_session_timeout'"
  );
}

/**
 * The timer half of the guard. One per open cursor stream, `unref()`ed so it
 * never keeps a process alive.
 *
 * It ticks every `min(timeout / 4, 5 s)`. A tick that finds the stream
 * suspended with no pull since the previous tick counts as idle; enough idle
 * ticks in a row to cover the timeout expire the stream, so expiry lands
 * between 1x the timeout and the timeout plus one tick. Time Turbine spends
 * fetching never counts, because the stream is not suspended then.
 *
 * With `keepalive` set (PostgreSQL, where {@link streamBackstopStatement} is
 * in force), a tick also sends a no-op statement when the connection has been
 * quiet for half the timeout. A consumer that pulls rows of an already-fetched
 * batch slowly is alive while the server sees an idle transaction; without the
 * keepalive the server limit would end a stream the consumer is still reading.
 * The server limit therefore only fires when this timer cannot run.
 */
export class StreamIdleGuard {
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly idleTicksToExpire: number;
  private lastPulls: number;
  private idleTicks = 0;
  private lastStatementAt = Date.now();
  private statementsInFlight = 0;
  private keepaliveInFlight = false;
  /** Settles once an expired stream's cleanup has run (connection released). */
  expiry: Promise<void> | undefined;

  constructor(
    private readonly state: StreamIdleState,
    private readonly timeoutMs: number,
    private readonly expiredError: () => TimeoutError,
    private readonly onExpire: () => Promise<void>,
    private readonly keepalive?: () => Promise<unknown>,
  ) {
    const tickMs = Math.max(1, Math.min(Math.floor(timeoutMs / 4), MAX_TICK_MS));
    this.idleTicksToExpire = Math.ceil(timeoutMs / tickMs);
    this.lastPulls = state.pulls;
    this.timer = setInterval(() => this.tick(), tickMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Bracket a statement on the stream's connection, so the keepalive knows it is busy. */
  statementStarted(): void {
    this.statementsInFlight++;
    this.lastStatementAt = Date.now();
  }

  statementSettled(): void {
    this.statementsInFlight--;
    this.lastStatementAt = Date.now();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private tick(): void {
    if (this.expiry) return;
    if (!this.state.suspended || this.state.pulls !== this.lastPulls) {
      this.lastPulls = this.state.pulls;
      this.idleTicks = 0;
    } else if (++this.idleTicks >= this.idleTicksToExpire) {
      this.stop();
      // Set before any await, so a pull that races the cleanup already sees it.
      this.state.expired = this.expiredError();
      this.expiry = this.onExpire();
      return;
    }
    if (
      this.keepalive &&
      !this.keepaliveInFlight &&
      this.statementsInFlight === 0 &&
      Date.now() - this.lastStatementAt >= this.timeoutMs / 2
    ) {
      this.keepaliveInFlight = true;
      this.statementStarted();
      // A failed keepalive is not reported here: the stream's next statement
      // meets the same broken connection and reports it with context.
      this.keepalive()
        .catch(() => undefined)
        .finally(() => {
          this.keepaliveInFlight = false;
          this.statementSettled();
        });
    }
  }
}

/** The connection surface a stream drives; structurally `StreamableConnection` in dialect.ts. */
interface StreamConnection {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * The stream's connection, as the dialect sees it, with two additions: every
 * statement is reported to the guard (for the keepalive), and, when `backstop`
 * is given, the dialect's own BEGIN carries {@link streamBackstopStatement} in
 * the same simple-protocol round trip, so the limit is in force from the
 * transaction's first statement at no extra cost. Matching the exact BEGIN text
 * the dialect emits keeps the dialect itself unchanged; the live backstop test
 * fails if that text ever stops matching.
 */
export function watchStreamConnection(
  base: StreamConnection,
  guard: () => StreamIdleGuard | undefined,
  backstop?: { begin: string; statement: string },
): StreamConnection {
  let backstopSent = false;
  return {
    query: async (text, values) => {
      let sql = text;
      if (backstop && !backstopSent && values === undefined && text === backstop.begin) {
        backstopSent = true;
        sql = `${text}; ${backstop.statement}`;
      }
      const g = guard();
      g?.statementStarted();
      try {
        return await base.query(sql, values);
      } finally {
        g?.statementSettled();
      }
    },
  };
}
