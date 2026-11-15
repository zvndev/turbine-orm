import { TimeoutError, TransactionOutcomeUnknownError, UnsupportedFeatureError } from '../errors.js';
import { logTo, type TurbineLogger } from '../logger.js';
import { answeredWithError } from '../transaction-state.js';

function timedOut(timeout: number, rollbackConfirmed = false): TimeoutError {
  return new TimeoutError(timeout, 'Transaction', {
    message: rollbackConfirmed
      ? `Transaction timed out after ${timeout}ms and rollback was confirmed. None of its writes were saved.`
      : `Transaction timed out after ${timeout}ms. Cancellation and rollback are not confirmed; its outcome is unknown.`,
    outcome: rollbackConfirmed ? 'not-executed' : 'unknown',
  });
}

/** Optional WS policy: no socket close establishes server cancellation/rollback. */
export function createRecovery(callerManaged: boolean) {
  let committing = false;
  let deadlineError: TimeoutError | undefined;
  return {
    pendingMessage: 'transaction cannot commit; rollback is not yet confirmed. ',
    sessionMessage: 'Your callback did not run; rollback is not yet confirmed.',
    commitSent(rolledBack = false): void {
      committing = !rolledBack;
    },
    async rollback(running: boolean, send: () => Promise<unknown>, graceMs: number): Promise<boolean> {
      // A later ROLLBACK cannot establish an in-flight COMMIT's outcome.
      if (committing || (running && !callerManaged)) return false;
      const rollback = send().then(
        () => true,
        () => false,
      );
      // A surviving caller Client cannot be returned while rollback is queued.
      if (callerManaged) return rollback;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          rollback,
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), graceMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    finish(
      state: { end(how: 'was rolled back' | 'ended with an unknown outcome'): void },
      clean: boolean,
      error: unknown,
      logger?: TurbineLogger,
    ): unknown {
      state.end(clean ? 'was rolled back' : 'ended with an unknown outcome');
      if (!clean && logger)
        logTo(logger, 'debug', 'Transaction ended with an unknown outcome', {
          code: 'transaction-outcome-unknown',
          operation: '$transaction',
        });
      if (deadlineError && clean && error === deadlineError) return timedOut(deadlineError.timeoutMs, true);
      // A COMMIT with no server answer (a lost socket, a timeout) may have
      // committed. An ERROR the server answered with keeps its class.
      return committing && !answeredWithError(error) ? new TransactionOutcomeUnknownError(error) : error;
    },
    assertTimeout(timeout: number): void {
      if (timeout && callerManaged) {
        throw new UnsupportedFeatureError(
          'transaction timeout',
          'caller-managed connection',
          'Cannot cancel or destroy this connection safely. Omit the timeout and await all transaction work.',
        );
      }
    },
    timeoutError(timeout: number): TimeoutError {
      deadlineError = timedOut(timeout);
      return deadlineError;
    },
  };
}
