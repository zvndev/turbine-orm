/** Opt-in stream cancellation; cursor SQL and transaction ownership stay with their existing owners. */
import { acquireConnection, type Checkout } from '../checkout.js';
import type { StreamableConnection } from '../dialect.js';
import { ConnectionError, ValidationError } from '../errors.js';
import type { PgCompatPool, StreamQuerySettlement } from '../pg-types.js';
import { sendCancelRequest } from '../query-utils.js';

/** Existing PostgreSQL cancellation grace, shared by deadlines and stream signals. */
export const CANCEL_GRACE_MS = 2000;
export const TIMED_OUT: unique symbol = Symbol('timedOut');

/** Wait for both cancellation delivery and driver settlement within one grace. */
export async function settleBackendCancel<T>(
  delivery: Promise<boolean>,
  running: Promise<T>,
): Promise<{ delivered: boolean | typeof TIMED_OUT; answer: T | typeof TIMED_OUT }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), CANCEL_GRACE_MS);
  });
  try {
    const delivered = await Promise.race([delivery, grace]);
    const answer = await Promise.race([running, grace]);
    return { delivered, answer };
  } finally {
    clearTimeout(timer);
  }
}

export function resolveStreamSignal(signal: AbortSignal | undefined): AbortSignal | undefined {
  if (
    signal !== undefined &&
    (!signal ||
      typeof signal.aborted !== 'boolean' ||
      typeof signal.throwIfAborted !== 'function' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function')
  ) {
    throw new ValidationError('Stream signal must be an AbortSignal.');
  }
  signal?.throwIfAborted();
  return signal;
}

/**
 * Cancel only while this statement owns the backend. The scoped runner starts
 * cancellation only AFTER transaction/savepoint admission, and keeps accounting for
 * the actual driver promise even if the cancellation grace expires first.
 */
export function cancellableStreamConnection(
  base: StreamableConnection,
  target: StreamableConnection,
  signal: AbortSignal,
  onCancel: (error: unknown) => void,
  run: <T>(send: () => Promise<T>, settled: StreamQuerySettlement) => Promise<T> = (send) => send(),
): StreamableConnection {
  return {
    async query(text, values) {
      // A dialect's finally/catch must still close or roll back after abort.
      if (/^(?:CLOSE |COMMIT$|ROLLBACK$)/.test(text)) return base.query(text, values);
      let release!: () => void;
      const settled = {
        promise: new Promise<void>((resolve) => {
          release = resolve;
        }),
        closed: false,
      };
      let cancel: Promise<boolean> | undefined;
      let started = false;
      let wake!: () => void;
      const aborted = new Promise<void>((resolve) => {
        wake = resolve;
      });
      const onAbort = () => {
        if (started) {
          onCancel(signal.reason);
          cancel = sendCancelRequest(target, CANCEL_GRACE_MS);
        }
        wake();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      const running = run(() => {
        signal.throwIfAborted();
        started = true;
        return target.query(text, values);
      }, settled).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      try {
        const first = await Promise.race([running, aborted]);
        if (first !== undefined && cancel === undefined) {
          if ('error' in first) throw first.error;
          return first.result;
        }
        if (!started) throw signal.reason;
        const { delivered, answer } = await settleBackendCancel(cancel!, running);
        if (delivered !== true || answer === TIMED_OUT) {
          const error = new ConnectionError(
            'Stream cancellation was not confirmed within 2000ms. The connection cannot be reused; ' +
              'an ambient transaction must roll back.',
            { cause: signal.reason },
          );
          onCancel(error);
          throw error;
        }
        throw signal.reason;
      } finally {
        signal.removeEventListener('abort', onAbort);
        settled.closed = true;
        release();
      }
    },
  };
}

/** An aborted pool wait sends nothing; its eventual checkout is returned immediately. */
export async function acquireStreamConnection(pool: PgCompatPool, signal: AbortSignal): Promise<Checkout> {
  signal.throwIfAborted();
  const pending = acquireConnection(pool);
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    const held = await Promise.race([pending, aborted]);
    if (signal.aborted) {
      held.checkout.release();
      throw signal.reason;
    }
    return held;
  } catch (error) {
    if (signal.aborted)
      void pending.then(
        (held) => held.checkout.release(),
        () => {},
      );
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
