/**
 * turbine-orm, how a transaction ends and what is reported about it
 *
 * Every transaction Turbine runs on a connection of its own ends here: the
 * caller's (`$transaction`, its array form, `transaction()`) and Turbine's own
 * (a nested write, a lookup-first upsert, a write split across statements, the
 * sequential pipeline). One settlement, so the rules cannot drift between
 * them:
 *
 *   - a rollback is reported only on the server's word: a ROLLBACK it
 *     acknowledged before any COMMIT was sent, or its answer to the COMMIT
 *     itself (an ERROR, or the `ROLLBACK` command tag);
 *   - a COMMIT the server did not answer may have committed, so no ROLLBACK is
 *     sent after it (one could not tell), the connection is discarded, and the
 *     caller gets `TransactionOutcomeUnknownError`;
 *   - a connection whose rollback is not confirmed is discarded, never reused.
 *
 * Kept out of client.ts so query/ and pipeline.ts can reach it (query/ must not
 * import client.ts; see transaction-client-slot.ts).
 */

import type { Checkout } from './checkout.js';
import type { Dialect } from './dialect.js';
import { explainConnectionLoss, TimeoutError, TransactionOutcomeUnknownError } from './errors.js';
import { logTo, type TurbineLogger } from './logger.js';
import type { PgCompatPoolClient } from './pg-types.js';
import { sendCancelRequest } from './query-utils.js';
import {
  answeredWithError,
  commitTransaction,
  rolledBackError,
  sendControl,
  type TransactionApi,
  type TransactionState,
  unawaitedWorkError,
} from './transaction-state.js';

/**
 * How long a transaction being abandoned (timed out, failed, or returned with
 * work still running) gives its in-flight statement to answer a cancel
 * request, and its ROLLBACK to answer, before the connection is destroyed
 * instead of reused.
 */
export const TX_ABORT_GRACE_MS = 2000;

/** Whether `pending` settles (either way) within `ms`. */
export async function settlesWithin(pending: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([
      pending.then(
        () => true,
        () => true,
      ),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stop a transaction that will not commit, on the server and now: cancel the
 * statement it is running (the protocol's CancelRequest, which also reaches the
 * right backend through a pooler), wait for it to answer, then ROLLBACK, which
 * releases every lock the transaction holds.
 *
 * Closing the socket alone does not do that. PostgreSQL notices a closed
 * client only when it next writes to it, so a backend waiting on a lock keeps
 * the transaction, and every lock it already took, until that lock clears.
 *
 * Resolves `true` when the connection is rolled back and reusable, `false` when
 * it is not (the cancel could not be sent, the statement or the ROLLBACK did not
 * answer within {@link TX_ABORT_GRACE_MS}, or the ROLLBACK failed); the caller
 * then destroys it. Call after `state.end()`, so nothing new is sent meanwhile.
 */
async function rollbackOnServer(
  client: PgCompatPoolClient,
  state: TransactionState,
  dialect: Dialect,
): Promise<boolean> {
  if (client.transactionRecovery)
    return client.transactionRecovery.rollback(
      state.running,
      () => sendControl(client, dialect.rollbackStatement()),
      TX_ABORT_GRACE_MS,
    );
  if (state.running) {
    if (!(await sendCancelRequest(client, TX_ABORT_GRACE_MS))) return false;
    if (!(await state.whenIdle(TX_ABORT_GRACE_MS))) return false;
  }
  let failed = false;
  const rollback = sendControl(client, dialect.rollbackStatement()).catch(() => {
    failed = true;
  });
  return (await settlesWithin(rollback, TX_ABORT_GRACE_MS)) && !failed;
}

/**
 * The lifecycle every transaction shares once BEGIN has run: `before` (the
 * `sessionContext` settings), the body (raced against `timeout`), COMMIT, and
 * on any failure the settlement below. Releases the checkout either way.
 *
 * The state is ended as soon as the body settles, BEFORE the COMMIT, so a
 * handle that leaked out of the callback can never slip a statement in ahead
 * of the COMMIT or onto the connection after it. Work the body started and did
 * not await is caught there too: the transaction does not commit part of it.
 *
 * Nothing is reported as rolled back unless the server said so: a ROLLBACK
 * acknowledged, or on PostgreSQL the COMMIT's own answer, the `ROLLBACK` tag
 * or an ERROR. On PostgreSQL a COMMIT that was sent and not answered (a
 * `query_timeout`, a lost connection) may have committed, and a
 * ROLLBACK after it cannot tell (it only reports that no transaction is open),
 * so none is sent, the connection is discarded, and the caller gets
 * {@link TransactionOutcomeUnknownError}. A connection that cannot be confirmed
 * clean is destroyed instead of reused (see {@link rollbackOnServer}). A
 * driver's {@link TransactionRecovery} policy reports its own outcomes.
 *
 * `api` names the API that opened the transaction in its messages. Undefined
 * is a transaction Turbine opened for one call (a nested write, a lookup-first
 * upsert, a write split across statements, a sequential pipeline): there a
 * statement's timeout ends the transaction, so its error reports what the
 * transaction's settlement established rather than what the statement alone
 * could.
 */
export async function completeTransaction<R>(
  { client, checkout }: Checkout,
  state: TransactionState,
  dialect: Dialect,
  api: TransactionApi | undefined,
  body: () => Promise<R>,
  logger?: TurbineLogger,
  timeout = 0,
  before?: () => Promise<void>,
): Promise<R> {
  const recovery = client.transactionRecovery;
  // 0: COMMIT not sent. 1: sent, no answer that says it did not commit.
  // 2: the server answered that it did not commit (an ERROR, or ROLLBACK).
  let commit = 0;
  let timedOut = false;
  let doomed: unknown;
  let result: R;
  try {
    await before?.();
    // Engine seam: single-writer engines (PowDB) scope their re-entrancy
    // marker to the body's async subtree (see
    // PgCompatPoolClient.wrapTransactionCallback). Absent everywhere else.
    const wrap = client.wrapTransactionCallback;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      result = await Promise.race([
        wrap ? (wrap.call(client, body) as Promise<R>) : body(),
        new Promise<never>((_, reject) => {
          if (timeout) {
            timer = setTimeout(() => {
              timedOut = true;
              state.end('timed out');
              // Native pg builds its error once the outcome is known, below.
              reject(recovery?.timeoutError(timeout));
            }, timeout);
          }
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const unawaited = state.busy;
    state.end('has ended');
    if (unawaited) throw unawaitedWorkError(api ?? '$transaction', recovery?.pendingMessage);
    // A statement inside was cut short by its timeout, and the callback
    // caught the error: whether it ran is not known, so nothing commits.
    // Presence decides, not the reason's value: a block may reject with `undefined`.
    const must = state.mustRollBack;
    if (must) {
      doomed = rolledBackError(must.error, 'refused', api);
      throw doomed;
    }
    commit = 1;
    // A COMMIT answered with ROLLBACK (a statement failed and the callback
    // caught it) rejects inside the COMMIT's trace, with the first failed
    // statement as the cause.
    await commitTransaction(client, dialect.commitStatement(), state.firstFailure, api, () => {
      commit = 2;
    });
  } catch (err) {
    // A COMMIT with no answer the engine's errors can carry may have
    // committed (see EngineCapabilities.classifiesCommitAnswer).
    const classifies = dialect.capabilities.classifiesCommitAnswer;
    if (commit === 1 && classifies && answeredWithError(err)) commit = 2;
    const unknown = !recovery && commit === 1 && classifies;
    if (!timedOut) state.end('has ended');
    const clean = !unknown && (await rollbackOnServer(client, state, dialect));
    const rolledBack = clean || (!recovery && commit === 2);
    let failure: unknown = err;
    if (recovery) failure = recovery.finish(state, clean, err, logger);
    // A deadline keeps its own handle wording, which is true either way.
    else if (!timedOut) state.end(rolledBack ? 'was rolled back' : 'ended with an unknown outcome');
    // A deadline, and in a transaction Turbine opened a statement's timeout,
    // ends the transaction before COMMIT. A policy words its own deadline.
    const ms = timedOut
      ? recovery
        ? 0
        : timeout
      : api || commit || !(err instanceof TimeoutError)
        ? 0
        : err.timeoutMs;
    if (ms) {
      const what = timedOut ? 'Transaction' : 'Query';
      const lead = `${what} timed out after ${ms}ms`;
      failure = new TimeoutError(ms, what, {
        ...(timedOut ? {} : { cause: err }),
        message: rolledBack
          ? // Not "its statement was cancelled": a cancel request that lands after
            // the statement finished is ignored, and nothing here sees which.
            `${lead}${timedOut ? ' and' : ', and the transaction it ran in'} was rolled back, so none of its writes ` +
            'were saved.'
          : `${lead}. COMMIT was never sent, so none of the transaction's writes were saved and ` +
            'a retry cannot apply them twice, but its rollback is not confirmed: it may hold locks until the ' +
            'server sees the connection close.',
        outcome: rolledBack ? 'not-executed' : 'unknown',
      });
    } else if (unknown) failure = new TransactionOutcomeUnknownError(err);
    else if (doomed && err === doomed && !rolledBack) failure = state.mustRollBack!.error;
    // An engine left unusable by the failed ROLLBACK (or COMMIT) says so.
    if (!clean) failure = client.unusable ?? failure;
    try {
      checkout.release(
        clean ? undefined : new Error('[turbine] transaction connection discarded: rollback not confirmed'),
      );
    } catch {
      // A pool whose release throws must not replace the transaction's own
      // failure (E021 and its cause included) or skip the outcome log.
    }
    if (logger && rolledBack) {
      logTo(logger, 'debug', 'Transaction rolled back', { code: 'transaction-rolled-back', operation: '$transaction' });
    } else if (logger && !recovery) {
      // A policy logs its own unknown outcome, in finish().
      logTo(logger, 'debug', 'Transaction ended with an unknown outcome', {
        code: 'transaction-outcome-unknown',
        operation: '$transaction',
      });
    }
    // Reject directly: returning an arbitrary failure would assimilate thenables.
    throw explainConnectionLoss(failure, checkout.lostWith);
  }
  // Outside the try: once COMMIT is acknowledged nothing may roll back or
  // report a rollback, even when the release itself throws.
  state.end('committed');
  checkout.release();
  if (logger)
    logTo(logger, 'debug', 'Transaction committed', { code: 'transaction-committed', operation: '$transaction' });
  return result;
}
