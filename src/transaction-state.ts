/**
 * turbine-orm, the state one open transaction shares
 *
 * Everything a `$transaction` hands out (table accessors, raw SQL, nested
 * `$transaction` blocks, streams) runs on ONE pooled connection. This module
 * owns what those share:
 *
 *   - whether the transaction is still open. Once it settles, a `tx` that was
 *     captured somewhere (an un-awaited promise, an `async` `forEach`, a timer)
 *     must not send anything: its connection is back in the pool and may
 *     already be running another request's transaction.
 *   - the first statement failure. PostgreSQL aborts a transaction at its first
 *     error and answers the COMMIT that follows with `ROLLBACK`; that failure is
 *     what the caller needs to see as the cause.
 *   - savepoint blocks. Savepoints are a stack on the connection, so two blocks
 *     open at once would share it and a rollback in one would undo the other.
 *     Blocks that share a parent therefore run one at a time, and a statement
 *     at the parent's level waits for a block opened before it.
 *   - what is still running: statements on the wire (what a cancel request
 *     stops, and what a ROLLBACK must wait for) and work started but not
 *     settled (which, when the callback returns, means a missing `await`).
 *
 * A leaf (errors.ts plus type-only imports), so query/ can reach it without an
 * import edge back to client.ts: a QueryInterface inside a transaction holds
 * only its pool, and that pool carries this state under
 * {@link TRANSACTION_STATE}.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Dialect } from './dialect.js';
import {
  DeadlockError,
  LockNotAvailableError,
  SerializationFailureError,
  TransactionRolledBackError,
  ValidationError,
  wrapPgError,
} from './errors.js';
import type { PgCompatPoolClient, PgCompatQueryResult } from './pg-types.js';

/** The key a transaction-scoped pool carries its {@link TransactionState} under. */
export const TRANSACTION_STATE: unique symbol = Symbol.for('turbine-orm.transactionState');

/** How a transaction ended, phrased to complete "This transaction ...". */
export type TransactionEnd = 'has ended' | 'committed' | 'was rolled back' | 'timed out';

/** The API that opened a transaction, which its error messages name. */
export type TransactionApi = '$transaction' | 'transaction';

type SavepointDialect = Pick<
  Dialect,
  'savepointStatement' | 'releaseSavepointStatement' | 'rollbackToSavepointStatement'
>;

/** One level of savepoint nesting: the transaction itself, or an open block. */
interface SavepointFrame {
  readonly state: TransactionState;
  /** Settles when every block registered on this frame's child slot is done. */
  tail: Promise<void>;
  /** Blocks registered on {@link tail} that have not finished. */
  children: number;
  /** The tick at which this frame's savepoint was set (0 for the transaction). */
  readonly openedAt: number;
}

/** The savepoint block the current async context is running inside, if any. */
const currentFrame = new AsyncLocalStorage<SavepointFrame>();

export interface TransactionStateOptions {
  /** The API that opened the transaction (default `$transaction`). */
  api?: TransactionApi;
  /**
   * True for a transaction the CALLER opened (`$transaction`, `$withSession`).
   * Multi-statement writes inside one get a savepoint of their own, so a
   * failure part way through cannot leave half of the write behind in a
   * transaction that goes on to commit. An internal transaction (a nested
   * write's own BEGIN/COMMIT) is atomic already and gets none.
   */
  userTransaction?: boolean;
}

export class TransactionState {
  /** True when multi-statement writes run inside their own savepoint (see {@link withSavepoint}). */
  readonly savepointWrites: boolean;
  private endedAs: TransactionEnd | undefined;
  private failure: { error: unknown; at: number } | undefined;
  /** A statement cut short that may still have run: the transaction must roll back (see {@link abort}). */
  private aborted: { error: unknown; at: number } | undefined;
  private tick = 0;
  private savepointCount = 0;
  private readonly root: SavepointFrame;
  /** Frames whose SAVEPOINT is set and not yet released or rolled back, outermost first. */
  private readonly openFrames: SavepointFrame[] = [];
  /** Statements sent on the connection that have not answered yet. */
  private onWire = 0;
  /** Statements and savepoint blocks started through the transaction that have not settled. */
  private started = 0;
  private idleWaiters: Array<() => void> = [];
  /** Settles at the first {@link end}, releasing anything still queued behind a block. */
  private readonly endedSignal: Promise<void>;
  private signalEnded!: () => void;
  private readonly api: TransactionApi;

  constructor(
    readonly client: PgCompatPoolClient,
    private readonly dialect: SavepointDialect,
    options: TransactionStateOptions = {},
  ) {
    this.root = { state: this, tail: Promise.resolve(), children: 0, openedAt: 0 };
    this.savepointWrites = options.userTransaction === true && dialectHasSavepoints(dialect);
    this.api = options.api ?? '$transaction';
    this.endedSignal = new Promise<void>((resolve) => {
      this.signalEnded = resolve;
    });
  }

  /** Whether the transaction has settled (see {@link end}). */
  get ended(): boolean {
    return this.endedAs !== undefined;
  }

  /** The first statement failure not undone by a savepoint rollback, if any. */
  get firstFailure(): unknown {
    return this.failure?.error;
  }

  /** Why the transaction must roll back instead of committing (see {@link abort}), if it must. */
  get abortedWith(): unknown {
    return this.aborted?.error;
  }

  /**
   * Whether a statement or savepoint block started through the transaction is
   * still running. True when the callback settles means work it started was
   * not awaited.
   */
  get busy(): boolean {
    return this.started > 0;
  }

  /** Whether a statement is on the wire right now (what a cancel request would stop). */
  get running(): boolean {
    return this.onWire > 0;
  }

  /**
   * Run the transaction's callback. Statements and blocks it starts are then
   * known to sit at the transaction's top level, which is what lets a block
   * whose async context was lost be told apart from a sibling.
   */
  enter<R>(fn: () => R): R {
    return currentFrame.run(this.root, fn);
  }

  /**
   * Resolve `true` once no statement is on the wire, or `false` after `ms`.
   * Called after {@link end}, when nothing new can be sent.
   */
  whenIdle(ms: number): Promise<boolean> {
    if (this.onWire === 0) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      this.idleWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /**
   * Mark the transaction settled. Called as soon as the callback settles,
   * BEFORE the COMMIT or ROLLBACK, and again with the outcome; from the first
   * call on every statement issued through the transaction is refused.
   */
  end(how: TransactionEnd): void {
    if (this.endedAs === undefined) this.signalEnded();
    this.endedAs = how;
  }

  /** Throw the closed-transaction error when the transaction has settled. */
  assertOpen(): void {
    if (this.endedAs !== undefined) throw closedTransactionError(this.endedAs, this.api);
  }

  /**
   * Run a statement issued THROUGH the transaction (an accessor, raw SQL, a
   * stream): refused once the transaction has settled, and its failure recorded
   * as a candidate cause for a later ROLLBACK-at-COMMIT.
   *
   * A statement issued while a savepoint block started before it at the same
   * level is still open waits for that block. Sent at once it would run inside
   * the block's savepoint and be undone if the block rolled back, after it had
   * already reported success.
   */
  async run<T>(statement: () => Promise<T>): Promise<T> {
    this.assertOpen();
    this.started++;
    try {
      const inside = currentFrame.getStore();
      if (inside?.state === this && inside.children > 0) {
        await Promise.race([inside.tail, this.endedSignal]);
        this.assertOpen();
      }
      return await this.send(statement);
    } finally {
      this.started--;
    }
  }

  /** Put one statement on the wire, counted for {@link whenIdle} and recorded on failure. */
  private async send<T>(statement: () => Promise<T>): Promise<T> {
    this.onWire++;
    try {
      return await statement();
    } catch (err) {
      this.noteFailure(err);
      throw err;
    } finally {
      this.onWire--;
      if (this.onWire === 0 && this.idleWaiters.length > 0) {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const wake of waiters) wake();
      }
    }
  }

  /** Record `err` as the first failure, unless one is already recorded. */
  noteFailure(err: unknown): void {
    if (this.failure === undefined) this.failure = { error: err, at: ++this.tick };
  }

  /**
   * Mark the transaction as one that must not commit, because of `err`: a
   * statement timed out and was cancelled, and whether it ran cannot be
   * relied on. The server aborts the transaction when the cancel lands, but a
   * cancel that arrives after the statement finished does nothing, and a
   * COMMIT would then keep it. A rollback to a savepoint set before the
   * statement clears the mark, as it clears the failure.
   */
  abort(err: unknown): void {
    this.noteFailure(err);
    if (this.aborted === undefined) this.aborted = { error: err, at: ++this.tick };
  }

  /**
   * Run `block` inside a savepoint: released when it resolves, rolled back to
   * when it rejects, so the rest of the transaction is unaffected either way.
   *
   * Blocks that share a parent run one at a time. A savepoint is a position on
   * the connection's one stack, so a block that opened second sits inside the
   * first: rolling the first back would discard the second even after it had
   * released and reported success. A block started from INSIDE another block's
   * callback is nested under it and does not wait.
   *
   * A block whose callback swallowed a statement failure resolves normally,
   * but PostgreSQL refuses to RELEASE a savepoint inside an aborted
   * transaction. That case rolls the savepoint back and rejects with the same
   * rolled-back error a COMMIT gets, carrying the failure as `cause`, so the
   * outer transaction stays usable.
   */
  async withSavepoint<R>(block: () => Promise<R>): Promise<R> {
    this.assertOpen();
    const inside = currentFrame.getStore();
    const known = inside?.state === this;
    // No frame of this transaction means the caller's async context was lost
    // (a callback API that does not carry it, such as a timer created before
    // the transaction). Such a block cannot be told apart from a sibling, and
    // waiting as one could mean waiting on its own ancestor forever, so it
    // nests under the innermost open savepoint: where the connection puts it.
    const parent = known ? inside : (this.openFrames[this.openFrames.length - 1] ?? this.root);
    const previous = parent.tail;
    let releaseSlot!: () => void;
    const mine = new Promise<void>((resolve) => {
      releaseSlot = resolve;
    });
    parent.tail = known ? mine : Promise.all([previous, mine]).then(() => undefined);
    parent.children++;
    this.started++;
    let frame: SavepointFrame | undefined;
    try {
      if (known) {
        await Promise.race([previous, this.endedSignal]);
        this.assertOpen();
      }
      const name = `sp_${++this.savepointCount}`;
      await this.control(this.dialect.savepointStatement(name));
      frame = { state: this, tail: Promise.resolve(), children: 0, openedAt: ++this.tick };
      this.openFrames.push(frame);
      let result: R;
      try {
        result = await currentFrame.run(frame, block);
      } catch (err) {
        await this.rollbackTo(name, frame);
        throw err;
      }
      const aborted = this.aborted !== undefined && this.aborted.at > frame.openedAt ? this.aborted.error : undefined;
      if (aborted !== undefined) {
        await this.rollbackTo(name, frame);
        throw rolledBackError(aborted, 'savepoint');
      }
      try {
        await this.control(this.dialect.releaseSavepointStatement(name));
      } catch (err) {
        const cause = this.failureSince(frame) ?? err;
        await this.rollbackTo(name, frame);
        throw rolledBackError(cause, 'savepoint');
      }
      return result;
    } finally {
      if (frame !== undefined) {
        const at = this.openFrames.lastIndexOf(frame);
        if (at !== -1) this.openFrames.splice(at, 1);
      }
      parent.children--;
      this.started--;
      releaseSlot();
    }
  }

  /** The recorded failure, when it happened after `frame`'s savepoint was set. */
  private failureSince(frame: SavepointFrame): unknown {
    return this.failure !== undefined && this.failure.at > frame.openedAt ? this.failure.error : undefined;
  }

  private async rollbackTo(name: string, frame: SavepointFrame): Promise<void> {
    try {
      await this.control(this.dialect.rollbackToSavepointStatement(name));
    } catch {
      // The transaction cannot take the rollback (it settled, or the connection
      // is gone). The error that brought the block down is the one to report.
      return;
    }
    if (this.failureSince(frame) !== undefined) this.failure = undefined;
    if (this.aborted !== undefined && this.aborted.at > frame.openedAt) this.aborted = undefined;
  }

  /** A savepoint statement: refused once settled, failures recorded and typed. */
  private async control(sql: string): Promise<void> {
    this.assertOpen();
    try {
      await this.send(() => this.client.query(sql));
    } catch (err) {
      const wrapped = wrapPgError(err);
      const recorded = this.failure;
      if (recorded !== undefined && recorded.error === err) recorded.error = wrapped;
      throw wrapped;
    }
  }
}

/** The state carried by a transaction-scoped pool, or undefined for any other pool. */
export function transactionStateOf(pool: unknown): TransactionState | undefined {
  if (pool === null || typeof pool !== 'object') return undefined;
  const state = (pool as { [TRANSACTION_STATE]?: unknown })[TRANSACTION_STATE];
  return state instanceof TransactionState ? state : undefined;
}

/**
 * Run a multi-statement operation as one unit inside the caller's transaction.
 *
 * When `pool` belongs to a transaction the caller opened (`$transaction`,
 * `$withSession`), `operation` runs inside its own savepoint: if it throws
 * part way through, the statements it already ran are rolled back and the
 * caller's transaction carries on as if the operation had never started. On
 * any other pool (no transaction, or Turbine's own implicit transaction, which
 * is atomic already) it simply runs `operation`.
 *
 * Every user-facing write that issues more than one statement inside a
 * transaction already goes through this from `TransactionClient`'s accessors
 * (nested creates and updates, lookup-first upserts); call it from any new
 * multi-statement operation that can be reached some other way.
 */
export function withSavepoint<R>(pool: unknown, operation: () => Promise<R>): Promise<R> {
  const state = transactionStateOf(pool);
  return state?.savepointWrites ? state.withSavepoint(operation) : operation();
}

/**
 * Send COMMIT and refuse to report success when the server rolled back instead.
 *
 * PostgreSQL answers COMMIT in an aborted transaction with the command tag
 * `ROLLBACK` and no error. Other engines never set `command` on a COMMIT
 * result, so the check is inert for them.
 */
export async function commitTransaction(
  client: { query(text: string): Promise<PgCompatQueryResult> },
  commitSql: string,
  firstFailure?: unknown,
  api: TransactionApi = '$transaction',
): Promise<void> {
  let result: PgCompatQueryResult;
  try {
    result = await client.query(commitSql);
  } catch (err) {
    throw wrapPgError(err);
  }
  if (commitWasRolledBack(result)) throw rolledBackError(firstFailure, 'transaction', api);
}

/** Whether a COMMIT result reports that the server rolled the transaction back. */
export function commitWasRolledBack(result: { command?: string } | null | undefined): boolean {
  return result?.command === 'ROLLBACK';
}

/**
 * The error for work that was rolled back although the caller expected it to
 * commit (a transaction) or be kept (a savepoint block).
 *
 * A retryable first failure (deadlock, serialization conflict, lock not
 * available) keeps its class, so `$retry` and `isRetryable` checks retry the
 * whole transaction, which is the documented response to all three. Anything
 * else is a {@link TransactionRolledBackError} (E019) with the first failure as
 * `cause`: nothing was committed, and the server did the rolling back.
 */
export function rolledBackError(
  firstFailure: unknown,
  scope: 'transaction' | 'savepoint',
  api: TransactionApi = '$transaction',
): Error {
  const head =
    scope === 'transaction'
      ? 'The transaction was rolled back, not committed: a statement inside it failed, and PostgreSQL ' +
        'aborts a transaction at its first error, so COMMIT ended it as a ROLLBACK and none of its writes were saved.'
      : 'The nested `$transaction` block was rolled back, not released: a statement inside it failed, and ' +
        'PostgreSQL aborts at the first error, so none of the writes inside the block were kept. The outer ' +
        'transaction is usable again.';
  const message =
    `${head}${firstFailure !== undefined ? ' The statement that failed first is attached as `cause`.' : ''} ` +
    'Catching an error inside the callback does not undo the abort. To recover from an expected failure and ' +
    'keep the rest of the work, ' +
    (api === '$transaction'
      ? 'run the statement that can fail in its own nested `tx.$transaction(...)`, which rolls back only that savepoint.'
      : 'send `SAVEPOINT s` before the statement that can fail and `ROLLBACK TO SAVEPOINT s` when it does, which ' +
        'undoes only that statement.');
  if (firstFailure instanceof LockNotAvailableError) return new LockNotAvailableError({ message, cause: firstFailure });
  if (firstFailure instanceof SerializationFailureError) {
    return new SerializationFailureError({ message, cause: firstFailure });
  }
  if (firstFailure instanceof DeadlockError) return new DeadlockError({ message, cause: firstFailure });
  return new TransactionRolledBackError(message, firstFailure !== undefined ? { cause: firstFailure } : undefined);
}

/** The error for a statement sent through a transaction that has settled. */
export function closedTransactionError(how: TransactionEnd, api: TransactionApi = '$transaction'): ValidationError {
  const handle = api === '$transaction' ? '`tx`' : 'the client `transaction()` passed in';
  return new ValidationError(
    `This transaction ${how}, so a query issued through ${handle} afterwards was refused rather than sent on a ` +
      `connection that no longer belongs to it. Every query on it has to finish inside the \`${api}\` callback. ` +
      'The usual causes are a missing `await`, an `async` callback passed to `forEach` (use `for ... of` or ' +
      '`await Promise.all(...)`), or the handle kept in a variable or a timer. Run work that belongs after the ' +
      'transaction on the Turbine client itself.',
  );
}

/**
 * The error for a callback that returned while work it started through the
 * transaction was still running. Committing then would save whatever part of
 * that work had run, so the transaction is rolled back instead.
 */
export function unawaitedWorkError(api: TransactionApi): ValidationError {
  return new ValidationError(
    `The \`${api}\` callback returned while a query it started on the transaction was still running, so the ` +
      'transaction was rolled back instead of committing part of that work. Await every query before the ' +
      'callback returns. The usual causes are a missing `await`, an `async` callback passed to `forEach` (use ' +
      '`for ... of` or `await Promise.all(...)`), or a promise that was started and not returned.',
  );
}

/** Whether `dialect` can set a savepoint at all (PowDB cannot, and says so by throwing). */
function dialectHasSavepoints(dialect: SavepointDialect): boolean {
  try {
    dialect.savepointStatement('sp_probe');
    return true;
  } catch {
    return false;
  }
}
