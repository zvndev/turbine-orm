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
 *   - whether the server's transaction is already aborted. On PostgreSQL a
 *     failed statement leaves the transaction ignoring every statement until a
 *     rollback to a savepoint set before it, so a statement sent then is
 *     refused here, with the failure that caused it, instead of coming back as
 *     an untyped SQLSTATE 25P02 that no retry would recognise.
 *   - which `tx` a statement came through. A nested block's callback gets its
 *     own handle, and a statement through an OUTER handle from inside the
 *     block is refused: it would run in the block's savepoint and be undone
 *     with it.
 *   - transaction-control SQL on the raw paths, which is refused (see
 *     {@link TransactionState.runRaw}).
 *
 * A leaf (errors.ts, the zero-import transaction-control.ts, and type-only
 * imports), so query/ can reach it without an import edge back to client.ts: a QueryInterface inside a transaction holds
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
import {
  type ControlKind,
  type ControlStatement,
  type ControlSyntax,
  findTransactionControl,
  mayHoldTransactionControl,
} from './transaction-control.js';

/** The key a transaction-scoped pool carries its {@link TransactionState} under. */
export const TRANSACTION_STATE: unique symbol = Symbol.for('turbine-orm.transactionState');

/** How a transaction ended, phrased to complete "This transaction ...". */
export type TransactionEnd = 'has ended' | 'committed' | 'was rolled back' | 'timed out';

/** The API that opened a transaction, which its error messages name. */
export type TransactionApi = '$transaction' | 'transaction';

type SavepointDialect = Pick<
  Dialect,
  'name' | 'savepointStatement' | 'releaseSavepointStatement' | 'rollbackToSavepointStatement'
>;

/**
 * One level of savepoint nesting: the transaction itself, or an open block.
 * Also what a `tx` handle is bound to (see {@link TransactionState.run}), so it
 * is exported as an opaque token: nothing outside this file reads its fields.
 */
export interface TransactionScope {
  readonly state: TransactionState;
  /** The frame this one is nested in (undefined for the transaction). */
  readonly parent: TransactionScope | undefined;
  /**
   * True for the transaction and for a block `tx.$transaction` handed its own
   * `tx`; false for the savepoint one multi-statement write runs in, which has
   * no handle of its own and is part of the handle that issued the write.
   */
  readonly handle: boolean;
  /** Settles when every block registered on this frame's child slot is done. */
  tail: Promise<void>;
  /** Blocks registered on {@link tail} that have not finished. */
  children: number;
  /** The tick at which this frame's savepoint was set (0 for the transaction). */
  readonly openedAt: number;
  /** True from the moment the frame's savepoint is set until it is released or rolled back. */
  open: boolean;
}

/** The savepoint block the current async context is running inside, if any. */
const currentFrame = new AsyncLocalStorage<TransactionScope>();

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
  /**
   * The server's own error that left the PostgreSQL transaction in its aborted
   * state, until a rollback to a savepoint set before it. Only recorded where
   * a failed statement aborts the transaction (see {@link abortsOnError}) and
   * only for a failure the SERVER reported: a client-side error (a value the
   * driver could not serialize) never reached the transaction and changes
   * nothing about what it will accept.
   */
  private dead: { error: unknown; at: number } | undefined;
  /** True where one failed statement makes the server ignore the rest of the transaction (PostgreSQL). */
  private readonly abortsOnError: boolean;
  /** The lexical rules for finding transaction-control SQL in raw text, or undefined where none apply (PowDB). */
  private readonly controlSyntax: ControlSyntax | undefined;
  private tick = 0;
  private savepointCount = 0;
  private readonly root: TransactionScope;
  /** Frames whose SAVEPOINT is set and not yet released or rolled back, outermost first. */
  private readonly openFrames: TransactionScope[] = [];
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
    this.root = {
      state: this,
      parent: undefined,
      handle: true,
      tail: Promise.resolve(),
      children: 0,
      openedAt: 0,
      open: true,
    };
    this.savepointWrites = options.userTransaction === true && dialectHasSavepoints(dialect);
    this.api = options.api ?? '$transaction';
    this.abortsOnError = dialect.name === 'postgresql';
    this.controlSyntax = controlSyntaxFor(dialect.name);
    this.endedSignal = new Promise<void>((resolve) => {
      this.signalEnded = resolve;
    });
  }

  /** Whether the transaction has settled (see {@link end}). */
  get ended(): boolean {
    return this.endedAs !== undefined;
  }

  /**
   * The first statement failure not undone by a savepoint rollback, if any.
   * Where the server aborted the transaction, the failure that did it: that is
   * the one a retry decision follows.
   */
  get firstFailure(): unknown {
    return this.dead?.error ?? this.failure?.error;
  }

  /** The scope of the transaction itself: what the `tx` handed to the callback is bound to. */
  get rootScope(): TransactionScope {
    return this.root;
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
   * `scope` is the handle the statement came through (the transaction's own
   * `tx`, or the one a nested block's callback received). A statement through
   * an OUTER handle from inside an open block is refused: it would run in the
   * block's savepoint and be undone with it.
   *
   * A statement issued while a savepoint block started before it at the same
   * level is still open waits for that block. Sent at once it would run inside
   * the block's savepoint and be undone if the block rolled back, after it had
   * already reported success.
   *
   * On PostgreSQL a statement sent after one failed is not sent at all: the
   * server would ignore it (SQLSTATE 25P02) and the failure that caused that
   * would be lost. `recovery` marks the one statement that is sent regardless,
   * a rollback to a savepoint the caller set by hand (see {@link runRaw}).
   */
  async run<T>(statement: () => Promise<T>, scope: TransactionScope = this.root, recovery = false): Promise<T> {
    this.assertOpen();
    this.assertNotFromInsideBlock(scope, 'A statement');
    this.started++;
    try {
      const inside = currentFrame.getStore();
      if (inside?.state === this && inside.children > 0) {
        await Promise.race([inside.tail, this.endedSignal]);
        this.assertOpen();
      }
      if (!recovery) this.assertNotAborted();
      const result = await this.send(statement);
      if (recovery) this.clearAbort();
      return result;
    } finally {
      this.started--;
    }
  }

  /**
   * {@link run} for a statement the caller wrote (`tx.raw`, `tx.rawUnsafe`,
   * `tx.sql`, the connection `$connection()` and `transaction()` hand out).
   *
   * Transaction-control SQL is refused with E003 before anything is sent.
   * `COMMIT`, `ROLLBACK` or `BEGIN` ends or reshapes the transaction behind the
   * state that tracks it, so later writes would autocommit and the callback's
   * own throw would keep them. A savepoint of the caller's own sits on the
   * connection's stack beside the ones Turbine sets, so those are refused too
   * inside `$transaction`, where `tx.$transaction(...)` is the savepoint.
   *
   * The raw `transaction()` API has no such block, so `SAVEPOINT`, `RELEASE`
   * and `ROLLBACK TO` stay available there: the only way to recover from a
   * failed statement without losing the transaction. A `ROLLBACK TO` is also
   * the one statement sent while the transaction is aborted, and when it
   * succeeds the abort is over.
   */
  async runRaw<T>(sql: unknown, statement: () => Promise<T>, scope: TransactionScope = this.root): Promise<T> {
    return this.run(statement, scope, this.screenRaw(sql));
  }

  /**
   * Check raw SQL for transaction control without sending it: throws E003 for
   * a statement the caller may not send, and answers whether the text rolls
   * back to a savepoint (the one control statement that is allowed to run in an
   * aborted transaction).
   */
  screenRaw(sql: unknown): boolean {
    if (this.controlSyntax === undefined || typeof sql !== 'string' || !mayHoldTransactionControl(sql)) return false;
    const found = findTransactionControl(sql, this.controlSyntax);
    if (found.length === 0) return false;
    const refused = found.find((s) => !(this.api === 'transaction' && SAVEPOINT_KINDS.has(s.kind)));
    if (refused !== undefined) throw transactionControlError(refused, this.api);
    return found.every((s) => s.kind === 'rollback-to');
  }

  /** Put one statement on the wire, counted for {@link whenIdle} and recorded on failure. */
  private async send<T>(statement: () => Promise<T>): Promise<T> {
    this.onWire++;
    try {
      return await statement();
    } catch (err) {
      this.noteFailure(err);
      if (this.abortsOnError && reportedByServer(err)) this.noteDead(err);
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

  /** Record `err` as what aborted the server's transaction, unless something already did. */
  private noteDead(err: unknown): void {
    if (this.dead === undefined) this.dead = { error: err, at: ++this.tick };
  }

  /**
   * Mark the transaction as one that must not commit, because of `err`: a
   * statement timed out and was cancelled, and whether it ran cannot be
   * relied on. The server aborts the transaction when the cancel lands, but a
   * cancel that arrives after the statement finished does nothing, and a
   * COMMIT would then keep it. A rollback to a savepoint set before the
   * statement clears the mark, as it clears the failure.
   *
   * Statements after it are refused like those after any failed statement: the
   * transaction cannot commit, so there is nothing to send them for.
   */
  abort(err: unknown): void {
    this.noteFailure(err);
    if (this.aborted === undefined) this.aborted = { error: err, at: ++this.tick };
    // The cancel's own error (57014) may already be recorded as the cause; this one says more.
    if (this.abortsOnError) this.dead = { error: err, at: this.dead?.at ?? ++this.tick };
  }

  /**
   * Refuse a statement the PostgreSQL transaction would ignore, with the
   * failure that aborted it. The same error a COMMIT in this state gets
   * ({@link rolledBackError}), so a deadlock, serialization conflict or lock
   * wait that was caught and followed by one more statement is still the
   * retryable class `$retry` looks for.
   */
  private assertNotAborted(): void {
    if (this.dead !== undefined) throw rolledBackError(this.dead.error, 'statement', this.api);
  }

  /** The caller rolled back to a savepoint of their own and the server accepted it: the abort is over. */
  private clearAbort(): void {
    if (this.dead === undefined) return;
    if (this.failure !== undefined && this.failure.error === this.dead.error) this.failure = undefined;
    this.dead = undefined;
  }

  /**
   * Refuse `what` issued through `scope` when the async context it was issued
   * from is inside a block opened through a handle nested under `scope`.
   *
   * `tx.$transaction(async (inner) => { await tx.users.update(...) })` sends
   * the update through the OUTER handle, but the connection is inside the
   * block's savepoint, so a throw from the block would undo an update the
   * caller placed outside it. The block's callback has its own handle for work
   * inside it. A context this state cannot see (a timer created before the
   * transaction, a callback API that drops the async context) is not refused:
   * it cannot be told apart from a statement at the right level.
   */
  private assertNotFromInsideBlock(scope: TransactionScope, what: string): void {
    const here = currentFrame.getStore();
    if (here === undefined || here.state !== this || here === scope) return;
    let inner: TransactionScope | undefined;
    for (let frame: TransactionScope | undefined = here; frame !== undefined; frame = frame.parent) {
      if (frame === scope) {
        if (inner !== undefined) throw outerHandleError(what);
        return;
      }
      // A write's own savepoint belongs to the handle that issued the write.
      if (frame.handle && frame.open && inner === undefined) inner = frame;
    }
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
   *
   * This is the savepoint of ONE multi-statement write, which belongs to the
   * handle that issued it. {@link withBlock} is a block the caller opened.
   */
  withSavepoint<R>(block: () => Promise<R>): Promise<R> {
    return this.openSavepoint(block, false, this.root);
  }

  /**
   * Run `block` as a nested `tx.$transaction(...)`: a savepoint (see
   * {@link withSavepoint}) whose callback receives a handle of its own, bound to
   * the scope it is given. `caller` is the handle `$transaction` was called on.
   */
  withBlock<R>(block: (scope: TransactionScope) => Promise<R>, caller: TransactionScope): Promise<R> {
    return this.openSavepoint(block, true, caller);
  }

  private async openSavepoint<R>(
    block: (scope: TransactionScope) => Promise<R>,
    handle: boolean,
    caller: TransactionScope,
  ): Promise<R> {
    this.assertOpen();
    if (handle) this.assertNotFromInsideBlock(caller, 'A nested `$transaction`');
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
    let frame: TransactionScope | undefined;
    try {
      if (known) {
        await Promise.race([previous, this.endedSignal]);
        this.assertOpen();
      }
      this.assertNotAborted();
      const name = `sp_${++this.savepointCount}`;
      await this.control(this.dialect.savepointStatement(name));
      const opened: TransactionScope = {
        state: this,
        parent,
        handle,
        tail: Promise.resolve(),
        children: 0,
        openedAt: ++this.tick,
        open: true,
      };
      frame = opened;
      this.openFrames.push(opened);
      let result: R;
      try {
        result = await currentFrame.run(opened, () => block(opened));
      } catch (err) {
        await this.rollbackTo(name, opened);
        throw err;
      }
      // A failure the block caught (or a statement its timeout cut short) leaves
      // the server's savepoint unusable, and PostgreSQL would refuse the RELEASE
      // anyway, so the block rolls back without asking.
      const doomed = this.doomedSince(opened);
      if (doomed !== undefined) {
        await this.rollbackTo(name, opened);
        throw rolledBackError(doomed.error, 'savepoint');
      }
      try {
        await this.control(this.dialect.releaseSavepointStatement(name));
      } catch (err) {
        const cause = this.failureSince(opened) ?? err;
        await this.rollbackTo(name, opened);
        throw rolledBackError(cause, 'savepoint');
      }
      return result;
    } finally {
      if (frame !== undefined) {
        frame.open = false;
        const at = this.openFrames.lastIndexOf(frame);
        if (at !== -1) this.openFrames.splice(at, 1);
      }
      parent.children--;
      this.started--;
      releaseSlot();
    }
  }

  /** The recorded failure, when it happened after `frame`'s savepoint was set. */
  private failureSince(frame: TransactionScope): unknown {
    return this.failure !== undefined && this.failure.at > frame.openedAt ? this.failure.error : undefined;
  }

  /**
   * What stops `frame` from being released: a statement cut short by its
   * timeout, or (on PostgreSQL) a failure the server aborted the savepoint for,
   * either one after the savepoint was set.
   */
  private doomedSince(frame: TransactionScope): { error: unknown } | undefined {
    if (this.aborted !== undefined && this.aborted.at > frame.openedAt) return this.aborted;
    if (this.dead !== undefined && this.dead.at > frame.openedAt) return this.dead;
    return undefined;
  }

  private async rollbackTo(name: string, frame: TransactionScope): Promise<void> {
    try {
      await this.control(this.dialect.rollbackToSavepointStatement(name));
    } catch {
      // The transaction cannot take the rollback (it settled, or the connection
      // is gone). The error that brought the block down is the one to report.
      return;
    }
    if (this.failureSince(frame) !== undefined) this.failure = undefined;
    if (this.aborted !== undefined && this.aborted.at > frame.openedAt) this.aborted = undefined;
    if (this.dead !== undefined && this.dead.at > frame.openedAt) this.dead = undefined;
  }

  /**
   * A savepoint statement: refused once settled, failures recorded and typed.
   * Typed INSIDE the statement, so the failure the state records is the Turbine
   * error and not the driver's.
   */
  private async control(sql: string): Promise<void> {
    this.assertOpen();
    await this.send(async () => {
      try {
        await this.client.query(sql);
      } catch (err) {
        throw wrapPgError(err);
      }
    });
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
  scope: 'transaction' | 'savepoint' | 'statement',
  api: TransactionApi = '$transaction',
): Error {
  const head =
    scope === 'transaction'
      ? 'The transaction was rolled back, not committed: a statement inside it failed, and PostgreSQL ' +
        'aborts a transaction at its first error, so COMMIT ended it as a ROLLBACK and none of its writes were saved.'
      : scope === 'savepoint'
        ? 'The nested `$transaction` block was rolled back, not released: a statement inside it failed, and ' +
          'PostgreSQL aborts at the first error, so none of the writes inside the block were kept. The outer ' +
          'transaction is usable again.'
        : 'This statement was not sent: an earlier statement in the transaction failed, and PostgreSQL ignores ' +
          'every statement after a failure until the transaction, or the savepoint it ran in, is rolled back. ' +
          'Nothing in the transaction can be saved now.';
  const message =
    `${head}${firstFailure !== undefined ? ' The statement that failed first is attached as `cause`.' : ''} ` +
    'Catching an error inside the callback does not undo the abort. To recover from an expected failure and ' +
    'keep the rest of the work, ' +
    (api === '$transaction'
      ? 'run the statement that can fail in its own nested `tx.$transaction(...)`, which rolls back only that savepoint.'
      : 'send `SAVEPOINT s` before the statement that can fail and `ROLLBACK TO SAVEPOINT s` when it does, which ' +
        'undoes only that statement.');
  // A failure that came through a raw driver connection (`transaction()`, `$connection()`,
  // `tx.sql`) is the driver's error, not yet a typed one; its class decides whether to retry.
  const typed = wrapPgError(firstFailure);
  if (typed instanceof LockNotAvailableError) return new LockNotAvailableError({ message, cause: firstFailure });
  if (typed instanceof SerializationFailureError) {
    return new SerializationFailureError({ message, cause: firstFailure });
  }
  if (typed instanceof DeadlockError) return new DeadlockError({ message, cause: firstFailure });
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

/**
 * The error for a statement (or a nested `$transaction`) issued through an
 * outer `tx` from inside one of its open nested blocks.
 */
function outerHandleError(what: string): ValidationError {
  return new ValidationError(
    `${what} was issued through the outer \`tx\` from inside one of its nested \`$transaction\` blocks. The ` +
      "connection is inside that block's savepoint, so the work would be undone if the block rolled back, " +
      "although the outer transaction goes on to commit. Use the `tx` the block's callback received for work " +
      'inside the block (`tx.$transaction(async (inner) => { await inner.users.update(...) })`), or issue this ' +
      'outside the block.',
  );
}

const SAVEPOINT_KINDS: ReadonlySet<ControlKind> = new Set<ControlKind>(['savepoint', 'release', 'rollback-to']);

/** The error for transaction-control SQL on a transaction's raw paths: what it would do, and what to do instead. */
function transactionControlError(statement: ControlStatement, api: TransactionApi): ValidationError {
  const where = api === '$transaction' ? 'inside a `$transaction` callback' : 'inside a `transaction()` callback';
  const ends =
    'it would end the transaction behind the back of the code that manages it, so every later statement ' +
    'would run on its own and be kept even if the callback then throws';
  let advice: string;
  let reason: string;
  switch (statement.kind) {
    case 'commit':
      reason = ends;
      advice = 'The transaction commits when the callback returns. Return from the callback to commit.';
      break;
    case 'rollback':
      reason = ends;
      advice =
        api === '$transaction'
          ? 'Throw an error from the callback to roll the transaction back, or run the work you may want to ' +
            "undo in a nested `tx.$transaction(...)`, which rolls back only that block's savepoint."
          : 'Throw an error from the callback to roll the transaction back, or send `SAVEPOINT s` first and ' +
            '`ROLLBACK TO SAVEPOINT s` to undo part of the work.';
      break;
    case 'begin':
      reason = 'a transaction is already open, and a second BEGIN does not nest';
      advice =
        api === '$transaction'
          ? 'For a block that can roll back on its own, use `tx.$transaction(...)`, which sets a savepoint.'
          : 'For a block that can roll back on its own, send `SAVEPOINT s`.';
      break;
    case 'set-transaction':
      reason = 'the transaction has already begun, so its characteristics can no longer be changed';
      advice = 'Pass `isolationLevel` and `readOnly` as the options of `$transaction(fn, options)` (or `transaction`).';
      break;
    case 'prepare':
      reason = ends;
      advice = 'Prepare the transaction from a connection you manage yourself, outside Turbine.';
      break;
    default:
      // savepoint, release, rollback-to: only reachable inside `$transaction`.
      reason =
        'a savepoint written by hand sits on the connection beside the ones `tx.$transaction` sets, and ' +
        'a rollback to the wrong one discards work the transaction state still counts as kept';
      advice =
        'Use a nested `tx.$transaction(async (inner) => { ... })`, which sets, releases and rolls back its own savepoint.';
  }
  return new ValidationError(`${statement.label} cannot be sent ${where}: ${reason}. ${advice}`);
}

/** The lexical rules for `dialectName`, or undefined when no SQL lexer applies (PowDB speaks PowQL). */
function controlSyntaxFor(dialectName: string): ControlSyntax | undefined {
  return dialectName === 'postgresql' || dialectName === 'mysql' || dialectName === 'sqlite' || dialectName === 'mssql'
    ? dialectName
    : undefined;
}

/**
 * Whether the SERVER reported `err`: a driver error carrying a SQLSTATE and a
 * severity, directly or as the `cause` of the Turbine error wrapping it. A
 * client-side failure (a value the driver could not serialize, a closed
 * client) has neither, and says nothing about the state of the transaction.
 */
function reportedByServer(err: unknown): boolean {
  let current = err;
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth++) {
    const { code, severity } = current as { code?: unknown; severity?: unknown };
    if (typeof code === 'string' && typeof severity === 'string' && /^[0-9A-Z]{5}$/.test(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
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
