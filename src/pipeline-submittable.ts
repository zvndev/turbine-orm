/**
 * turbine-orm, Real Postgres pipeline protocol implementation
 *
 * Uses the pg extended-query protocol wire methods (parse/bind/describe/execute/sync)
 * exposed on pg.Client's Connection object to send multiple queries in a single
 * TCP flush. This achieves true 1-RTT pipeline execution instead of the sequential
 * await-per-query approach.
 *
 * The approach (listener-swap):
 *   1. Detach the pg.Client's event listeners from the Connection
 *   2. Attach the pipeline state-machine listeners
 *   3. Cork the TCP stream, push all protocol messages, uncork (one TCP write)
 *   4. Drive a state machine over backend response events
 *   5. Restore original listeners and release the client
 *
 * This is the same pattern used by pg-cursor and pg-query-stream, but extended
 * to handle N queries in a single pipeline. Unlike those, the batch is not the
 * Client's active query, so the Client cannot fail it when the socket dies:
 * this module listens for the Connection's `end` / `error` itself while it
 * owns the connection (see `onConnectionLost`).
 */

import type { EventEmitter } from 'node:events';
import type PgResult from 'pg/lib/result';
import pg from '#pg';
import { PipelineError, TimeoutError, TransactionOutcomeUnknownError, wrapPgError } from './errors.js';
import type { PgCompatQueryResult } from './pg-types.js';
import type { DeferredQuery } from './query/index.js';
import { answeredWithError, rolledBackError } from './transaction-state.js';

// Read off pg's own module object (`pg.Result` IS `pg/lib/result`, `pg.utils`
// IS `pg/lib/utils`) rather than imported by subpath, so the whole driver comes
// through the one `#pg` alias that edge bundles swap out (see src/pg-edge.ts).
const Result = (pg as unknown as { Result: typeof PgResult }).Result;
const { prepareValue } = (pg as unknown as { utils: { prepareValue(value: unknown): unknown } }).utils;

// ---------------------------------------------------------------------------
// Types for pg internals used by the pipeline
// ---------------------------------------------------------------------------

/** The pg Connection object, an EventEmitter with wire-protocol methods */
export interface PgConnection extends EventEmitter {
  stream: {
    cork?: () => void;
    uncork?: () => void;
    writable?: boolean;
    destroy?: (err?: Error) => void;
    write?: (...args: unknown[]) => boolean;
  };
  parse(query: { text: string; name?: string; types?: number[] }): void;
  bind(config: {
    portal?: string;
    statement?: string;
    values?: unknown[];
    binary?: boolean;
    valueMapper?: (val: unknown, index: number) => unknown;
  }): void;
  describe(msg: { type: 'S' | 'P'; name?: string }): void;
  execute(config: { portal?: string; rows?: number }): void;
  sync(): void;
}

/** A pg PoolClient with the internals required by the pipeline */
export interface PgPoolClient {
  connection: PgConnection;
  /** pg.Client sets this to control query queue draining */
  readyForQuery: boolean;
  /** Type parser overrides (if the client has custom type parsers) */
  _types?: unknown;
  release(err?: Error | boolean): void;
}

/**
 * Marks a client this module could not hand back in a reusable state, so the
 * caller releases it WITH an error and the pool drops it instead of lending it
 * out again.
 *
 * A symbol, and `Symbol.for` so an ESM and a CJS copy of this module agree on
 * it (the same reason the internal-combinator brand uses one). Set only when
 * the backend still reports an open or aborted transaction after this module
 * has done what it can, which after {@link runPipelined}'s rollback means the
 * rollback itself did not take.
 */
const PIPELINE_DISCARD = Symbol.for('turbine.pipeline.discardClient');

/** Did {@link runPipelined} leave this client unusable? See {@link PIPELINE_DISCARD}. */
export function pipelineClientNeedsDiscard(client: unknown): boolean {
  return (
    typeof client === 'object' && client !== null && (client as Record<symbol, unknown>)[PIPELINE_DISCARD] === true
  );
}

/**
 * The `ReadyForQuery` transaction-status byte: `I` idle, `T` inside a
 * transaction block, `E` inside a FAILED transaction block. Absent when the
 * emitter does not carry one (a test double), which is treated as "unknown".
 */
type TransactionStatus = 'I' | 'T' | 'E' | undefined;

// ---------------------------------------------------------------------------
// Intercepted event names
// ---------------------------------------------------------------------------

/**
 * All backend message event names that the pg Client listens for.
 * Listeners for these events are snapshotted, detached, and restored.
 */
const INTERCEPTED_EVENTS = [
  'readyForQuery',
  'rowDescription',
  'dataRow',
  'commandComplete',
  'parseComplete',
  'bindComplete',
  'errorMessage',
  'emptyQuery',
  'portalSuspended',
  'noData',
  'notice',
  'copyInResponse',
  'copyData',
] as const;

// ---------------------------------------------------------------------------
// Pipeline options
// ---------------------------------------------------------------------------

export interface PipelineRunOptions {
  /**
   * Whether to wrap the pipeline in BEGIN/COMMIT (default: true).
   * When true, all queries execute atomically. On error, ROLLBACK is sent.
   * When false, each query gets its own Sync message for error isolation.
   *
   * A transactional batch that may write holds its COMMIT until every
   * query's transform has run, so a transform that throws (a `...OrThrow`
   * miss, an optimistic-lock conflict) rolls the writes back instead of
   * rejecting after they committed. That costs a second round trip; a batch
   * of plain SELECTs keeps the single one, its COMMIT sent with the batch and
   * its transforms run after it. A SELECT can still write through a function
   * it calls, so that COMMIT is never assumed to have changed nothing (see
   * `onConnectionLost`).
   */
  transactional?: boolean;

  /** Timeout in milliseconds. If exceeded, the connection is destroyed. */
  timeout?: number;
}

// ---------------------------------------------------------------------------
// Listener snapshot helpers
// ---------------------------------------------------------------------------

type ListenerMap = Map<string, ((...args: unknown[]) => void)[]>;

function snapshotListeners(emitter: EventEmitter): ListenerMap {
  const map: ListenerMap = new Map();
  for (const event of INTERCEPTED_EVENTS) {
    const listeners = emitter.rawListeners(event) as ((...args: unknown[]) => void)[];
    if (listeners.length > 0) {
      map.set(event, [...listeners]);
    }
  }
  return map;
}

function detachListeners(emitter: EventEmitter): void {
  for (const event of INTERCEPTED_EVENTS) {
    emitter.removeAllListeners(event);
  }
}

function restoreListeners(emitter: EventEmitter, snapshot: ListenerMap): void {
  for (const [event, listeners] of snapshot) {
    for (const fn of listeners) {
      emitter.on(event, fn);
    }
  }
}

// ---------------------------------------------------------------------------
// Core pipeline execution
// ---------------------------------------------------------------------------

/** A plain SELECT: its transform may run after COMMIT (see {@link batchMayWrite}). */
const READ_ONLY_STATEMENT = /^\s*select\b/i;

/**
 * Whether a transactional batch must hold its COMMIT until the transforms have
 * run. Anything that is not a plain SELECT counts as a write, so a statement
 * this cannot classify costs a round trip rather than correctness.
 *
 * It decides WHEN the COMMIT is sent, never what a lost COMMIT means: a SELECT
 * can call a function that writes, so a batch of SELECTs is not known to be
 * effect-free and its unanswered COMMIT is an unknown outcome like any other.
 */
export function batchMayWrite(queries: readonly DeferredQuery<unknown>[]): boolean {
  return queries.some((q) => !READ_ONLY_STATEMENT.test(q.sql));
}

/**
 * Execute multiple queries using the Postgres extended-query pipeline protocol.
 *
 * All protocol messages are buffered into a single TCP write via cork/uncork.
 * The backend processes them in order and sends back results which the pipeline state
 * machine collects.
 *
 * @param client - A pg PoolClient with an accessible Connection
 * @param queries - Array of DeferredQuery descriptors
 * @param options - Pipeline options (transactional, timeout)
 * @returns Array of transformed results in the same order as queries
 */
export async function runPipelined<T extends readonly DeferredQuery<unknown>[]>(
  client: PgPoolClient,
  queries: T,
  options: PipelineRunOptions = {},
): Promise<unknown[]> {
  const { transactional = true, timeout } = options;
  const connection = client.connection;

  // Snapshot and detach the Client's listeners
  const savedListeners = snapshotListeners(connection);
  detachListeners(connection);

  // Block the Client from processing queued queries while the pipeline owns the connection
  const savedReadyForQuery = client.readyForQuery;
  client.readyForQuery = false;

  return new Promise<unknown[]>((resolve, reject) => {
    // -----------------------------------------------------------------------
    // State machine
    // -----------------------------------------------------------------------

    /**
     * True when the batch is sent as BEGIN + queries + Sync and the COMMIT
     * follows only once every transform has succeeded (see
     * {@link PipelineRunOptions.transactional}).
     */
    const holdCommit = transactional && batchMayWrite(queries);

    /**
     * Where the exchange is: the batch itself, or the single follow-up
     * statement (the held COMMIT, or the recovery ROLLBACK) sent after it.
     */
    let phase: 'batch' | 'commit' | 'rollback' = 'batch';

    /** The command tag the COMMIT came back with (`ROLLBACK` when the server rolled back). */
    let commitTag: string | undefined;

    /** Transformed results, computed before a held COMMIT is sent. */
    let transformed: unknown[] | undefined;

    /**
     * Expected readyForQuery events:
     * - Transactional: 1 (single Sync at end)
     * - Non-transactional: N (one Sync per query)
     */
    const expectedRfq = transactional ? 1 : queries.length;

    // Results array: one Result per query (not counting BEGIN/COMMIT)
    const results: InstanceType<typeof Result>[] = [];
    for (let i = 0; i < queries.length; i++) {
      results.push(new Result(undefined, client._types));
    }

    // commandComplete counter, tracks position across all commands
    let commandIndex = 0;

    // readyForQuery counter
    let rfqCount = 0;

    // First error encountered
    let pipelineError: Error | null = null;

    // For non-transactional mode: per-query error tracking
    const queryErrors: (Error | null)[] = new Array<Error | null>(queries.length).fill(null);

    // Timeout handle
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    // Whether cleanup has already been performed
    let cleaned = false;

    /** Transaction status reported by the most recent ReadyForQuery. */
    let txStatus: TransactionStatus;

    /**
     * The results[] index the next backend message belongs to. Transactional
     * mode counts commands: 0 = BEGIN, 1..N = queries, N+1 = COMMIT (absent
     * when the COMMIT is held), and follow-up statements belong to no query.
     * Non-transactional mode gives each query its own Sync, so the
     * ReadyForQuery count IS the slot, which also places an error raised at a
     * query's implicit COMMIT (a deferred constraint), after its
     * CommandComplete, on that query rather than the next.
     */
    function currentQueryIndex(): number | null {
      const qIdx = !transactional ? rfqCount : phase === 'batch' ? commandIndex - 1 : -1;
      return qIdx >= 0 && qIdx < queries.length ? qIdx : null;
    }

    /** Record `qIdx` as the failing query on `error`, for the PipelineError. */
    function tagged(error: Error, qIdx: number): Error {
      return Object.assign(error, { failedIndex: qIdx, failedTag: queries[qIdx]!.tag });
    }

    // -----------------------------------------------------------------------
    // Cleanup: restore listeners
    // -----------------------------------------------------------------------

    function cleanup(): void {
      if (cleaned) return;
      cleaned = true;

      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }

      // Remove the pipeline listeners. The Client's own `end` / `error` listeners were
      // never detached, so only ours come off.
      detachListeners(connection);
      connection.removeListener('end', onConnectionLost);
      connection.removeListener('error', onConnectionLost);

      // Restore original listeners
      restoreListeners(connection, savedListeners);

      // Restore readyForQuery so the Client can process its queue
      client.readyForQuery = savedReadyForQuery;
    }

    // -----------------------------------------------------------------------
    // Finalize: called on final readyForQuery
    // -----------------------------------------------------------------------

    /**
     * Return the connection to the pool in a state the next borrower can use.
     *
     * The hazard this exists for: a transactional batch is `BEGIN` + queries +
     * `COMMIT` + ONE `Sync`, so a query error makes the backend skip everything
     * up to that Sync, the `COMMIT` included, and the connection goes back to
     * the pool `idle in transaction (aborted)`. The next borrower's first
     * statement then failed with `25P02`, a `$transaction` that landed on it
     * lost its write, and a non-transactional pipeline failed every slot and
     * released it still aborted, so the poisoning survived indefinitely.
     *
     * The recovery is one `ROLLBACK` on the same connection, sent AFTER the
     * ReadyForQuery that says the backend will accept a new statement, and
     * waited for: its own ReadyForQuery returns control here with `I`. That
     * keeps the connection, which matters at small pool sizes where discarding
     * is a reconnect on the caller's next query.
     *
     * Returns true when the caller should finalize now, false when a rollback
     * is in flight and the next ReadyForQuery will finish the job.
     */
    function settleTransactionState(): boolean {
      // `I` (idle) is the ordinary case and needs nothing, and neither does a
      // batch that had no error: transactional mode's COMMIT closed the
      // transaction, non-transactional mode never opened one. That keeps the
      // happy path at exactly one round trip, which a `ROLLBACK`-on-unknown
      // would have cost an extra Sync (caught by the cork/uncork test). A real
      // backend always sends the status byte; an emitter without one is only
      // ever a test double.
      if (txStatus === 'I') return true;
      if (txStatus === undefined && !(transactional && pipelineError)) return true;
      if (!transactional) {
        // Non-transactional mode opens no transaction of its own, so there is
        // nothing to roll back. Hand the client back marked for disposal.
        markDiscardIfInTransaction();
        return true;
      }
      return !sendFollowUp('ROLLBACK', 'rollback');
    }

    /** Mark the client so the caller releases it with an error and the pool drops it. */
    function markDiscard(): void {
      Object.defineProperty(client, PIPELINE_DISCARD, { value: true, enumerable: false, configurable: true });
    }

    /** Mark the client for disposal when the backend still reports an open or failed transaction. */
    function markDiscardIfInTransaction(): void {
      if (txStatus === 'E' || txStatus === 'T') markDiscard();
    }

    /**
     * Send one statement after the batch (the held COMMIT or the recovery
     * ROLLBACK) with its own Sync; its ReadyForQuery finishes the exchange.
     * Returns false when the socket would not take it, in which case the
     * connection is marked for disposal, since it cannot be repaired from here.
     */
    function sendFollowUp(text: 'COMMIT' | 'ROLLBACK', next: 'commit' | 'rollback'): boolean {
      phase = next;
      try {
        connection.stream.cork?.();
        try {
          connection.parse({ text, name: '' });
          connection.bind({ portal: '', statement: '', values: [], valueMapper: prepareValue });
          connection.execute({ portal: '', rows: 0 });
          connection.sync();
        } finally {
          connection.stream.uncork?.();
        }
        return true;
      } catch (err) {
        markDiscard();
        if (!pipelineError) pipelineError = err instanceof Error ? err : new Error(String(err));
        return false;
      }
    }

    /** Run every query's transform, in order; the first throw propagates. */
    function transformAll(): unknown[] {
      const out: unknown[] = [];
      for (let i = 0; i < queries.length; i++) {
        out.push(queries[i]!.transform(results[i]! as unknown as PgCompatQueryResult));
      }
      return out;
    }

    function finalize(): void {
      cleanup();

      if (transactional && pipelineError) {
        reject(pipelineError);
        return;
      }

      if (!transactional && pipelineError) {
        // In non-transactional mode, report every slot: what each query returned
        // or the error it failed with.
        const partialResults: Array<{ status: 'ok'; value: unknown } | { status: 'error'; error: Error }> = [];
        for (let i = 0; i < queries.length; i++) {
          const qErr = queryErrors[i];
          if (qErr) {
            partialResults.push({ status: 'error', error: qErr });
          } else {
            try {
              const q = queries[i]!;
              partialResults.push({ status: 'ok', value: q.transform(results[i]! as unknown as PgCompatQueryResult) });
            } catch (transformErr) {
              partialResults.push({ status: 'error', error: transformErr as Error });
            }
          }
        }
        // A REAL PipelineError, not the first driver error with a `results`
        // property bolted onto it. The old shape happened to satisfy
        // `err.results`, which is what the docs show callers reading, while
        // leaving `err instanceof PipelineError` and `err.code ===
        // 'TURBINE_E014'` permanently false: E014 was defined, documented, and
        // never constructed. The driver error survives as `.cause` and as the
        // first `error` slot, and `failedIndex` / `failedTag` (recorded on it by
        // `onErrorMessage`) move onto the typed error's own fields.
        const first = pipelineError as Error & { failedIndex?: number; failedTag?: string };
        reject(
          new PipelineError({
            results: partialResults,
            failedIndex: first.failedIndex,
            failedTag: first.failedTag,
            cause: pipelineError,
          }),
        );
        return;
      }

      // All succeeded. A held COMMIT ran the transforms before committing;
      // a read-only batch runs them now (there is nothing to undo).
      if (transformed) {
        resolve(transformed);
        return;
      }
      try {
        resolve(transformAll());
      } catch (err) {
        reject(err);
      }
    }

    // -----------------------------------------------------------------------
    // Event handlers
    // -----------------------------------------------------------------------

    function onParseComplete(): void {
      // No action needed, anonymous prepared statements
    }

    function onBindComplete(): void {
      // No action needed
    }

    function onNoData(): void {
      // DML without RETURNING, no RowDescription follows. Fine.
    }

    function onRowDescription(msg: { fields: Array<{ name: string; dataTypeID: number; format?: string }> }): void {
      const qIdx = currentQueryIndex();
      if (qIdx !== null && qIdx >= 0 && qIdx < results.length) {
        results[qIdx]!.addFields(msg.fields);
      }
    }

    function onDataRow(msg: { fields: Array<string | null> }): void {
      const qIdx = currentQueryIndex();
      if (qIdx !== null && qIdx >= 0 && qIdx < results.length) {
        const result = results[qIdx]!;
        const row = result.parseRow(msg.fields);
        result.addRow(row);
      }
    }

    function onCommandComplete(msg: { text?: string; command?: string }): void {
      // Past BEGIN and the queries: the COMMIT, held or sent with the batch
      // (or a recovery ROLLBACK, which no outcome reads).
      if (commandIndex > queries.length) commitTag = msg.command ?? msg.text;
      const qIdx = currentQueryIndex();
      if (qIdx !== null && qIdx >= 0 && qIdx < results.length) {
        results[qIdx]!.addCommandComplete(msg);
      }
      commandIndex++;
    }

    function onEmptyQuery(): void {
      // Treat like a commandComplete with no data
      commandIndex++;
    }

    function onErrorMessage(msg: Error & { code?: string; severity?: string }): void {
      const wrapped = wrapPgError(msg);
      const error = wrapped instanceof Error ? wrapped : new Error(String(wrapped));

      const qIdx = currentQueryIndex();
      if (transactional) {
        // In transactional mode, the first error aborts everything.
        // Postgres marks the transaction as aborted; subsequent commands
        // until Sync all return errors that the pipeline absorbs.
        pipelineError ??= qIdx === null ? error : tagged(error, qIdx);
      } else if (qIdx !== null) {
        // Non-transactional: record per-query error
        queryErrors[qIdx] = error;
        pipelineError ??= tagged(error, qIdx);
      }
      // Advance command index past the failed command
      commandIndex++;
    }

    function onPortalSuspended(): void {
      // The pipeline does not use row-limited portals.
    }

    /**
     * The socket closed, or failed, while the batch owned the connection. No
     * ReadyForQuery will come, so settle now and have the client discarded.
     *
     * What the caller is told follows what the server could have done. Before
     * a COMMIT is sent nothing is committed: the batch's first error, else a
     * connection error. That is only the batch phase of a batch that holds its
     * COMMIT. A batch of plain SELECTs sends its COMMIT with the batch, and a
     * SELECT can write through a function it calls, so it is never assumed to
     * have had no effect. A COMMIT the server did not answer, held or sent with
     * the batch, may have committed, so its outcome is unknown
     * (`TransactionOutcomeUnknownError`, as for every transaction Turbine
     * runs), unless the server answered it with the `COMMIT` or `ROLLBACK` tag
     * or an ERROR, which rolls the transaction back (a FATAL does not count, see
     * `answeredWithError`).
     *
     * In non-transactional mode every query autocommits at its own Sync, and
     * all of them went out in the batch's one write, so a query with no
     * ReadyForQuery yet may have run and committed, a SELECT included: its
     * slot is `TransactionOutcomeUnknownError` carrying the connection error,
     * unless the server answered it with an ERROR. Finished queries keep their
     * results, and no slot gets the connection error alone, whose advice is
     * that a retry is safe.
     */
    function onConnectionLost(err?: Error): void {
      if (cleaned) return;
      markDiscard();
      const lost = wrapPgError(err ?? new Error('Connection terminated unexpectedly')) as Error;
      if (!transactional) {
        for (let i = rfqCount; i < queries.length; i++) {
          const answer = queryErrors[i];
          if (answeredWithError(answer)) continue;
          const unknown = new TransactionOutcomeUnknownError(answer ?? lost);
          queryErrors[i] = unknown;
          if (!pipelineError || pipelineError === answer) pipelineError = tagged(unknown, i);
        }
      } else if (holdCommit && phase !== 'commit') pipelineError ??= lost;
      else if (commitTag === 'ROLLBACK') pipelineError ??= rolledBackError(undefined, 'transaction');
      else if (commitTag !== 'COMMIT' && !answeredWithError(pipelineError))
        pipelineError = new TransactionOutcomeUnknownError(pipelineError ?? lost);
      finalize();
    }

    function onReadyForQuery(msg?: { status?: string }): void {
      txStatus = msg?.status as TransactionStatus;
      // A follow-up statement's own ReadyForQuery is not one of the batch's, so
      // it must not advance the counter that decides when the batch is done.
      if (phase === 'rollback') {
        markDiscardIfInTransaction();
        finalize();
        return;
      }
      if (phase === 'commit') {
        // PostgreSQL answers COMMIT in a failed transaction with the tag
        // ROLLBACK and no error. Nothing here sends COMMIT after an error, but
        // the answer is checked rather than assumed.
        if (!pipelineError && commitTag === 'ROLLBACK') pipelineError = rolledBackError(undefined, 'transaction');
        markDiscardIfInTransaction();
        finalize();
        return;
      }
      rfqCount++;
      if (rfqCount < expectedRfq) return;
      if (holdCommit && !pipelineError && txStatus !== 'E') {
        try {
          transformed = transformAll();
        } catch (err) {
          // A transform refused its result: roll the batch's writes back.
          pipelineError = err instanceof Error ? err : new Error(String(err));
          if (!sendFollowUp('ROLLBACK', 'rollback')) finalize();
          return;
        }
        if (!sendFollowUp('COMMIT', 'commit')) finalize();
        return;
      }
      if (settleTransactionState()) finalize();
    }

    // -----------------------------------------------------------------------
    // Attach the pipeline listeners
    // -----------------------------------------------------------------------

    connection.on('parseComplete', onParseComplete);
    connection.on('bindComplete', onBindComplete);
    connection.on('noData', onNoData);
    connection.on('rowDescription', onRowDescription);
    connection.on('dataRow', onDataRow);
    connection.on('commandComplete', onCommandComplete);
    connection.on('emptyQuery', onEmptyQuery);
    connection.on('errorMessage', onErrorMessage);
    connection.on('portalSuspended', onPortalSuspended);
    connection.on('readyForQuery', onReadyForQuery);
    connection.on('notice', () => {});
    connection.on('copyInResponse', () => {});
    connection.on('copyData', () => {});
    connection.on('end', onConnectionLost);
    connection.on('error', onConnectionLost);

    // -----------------------------------------------------------------------
    // Timeout
    // -----------------------------------------------------------------------

    if (timeout && timeout > 0) {
      timeoutHandle = setTimeout(() => {
        // TimeoutError (E002), matching $transaction({ timeout }). A bare Error
        // here meant `pipeline({ timeout })` rejected with no .code, no
        // .docsUrl, and failing `instanceof TurbineError`, so the two timeout
        // paths in the same client disagreed about their own contract.
        pipelineError = new TimeoutError(timeout, 'Pipeline');
        // Detached before the socket goes, so the timeout is what the caller
        // hears whether the stream reports its end now or on a later tick.
        cleanup();
        if (connection.stream.destroy) {
          connection.stream.destroy(pipelineError);
        }
        reject(pipelineError);
      }, timeout);
    }

    // -----------------------------------------------------------------------
    // Send protocol messages, all in one TCP flush
    // -----------------------------------------------------------------------

    try {
      if (connection.stream.cork) {
        connection.stream.cork();
      }

      if (transactional) {
        // ---- Transactional mode ----
        // BEGIN + N×(parse+bind+describe+execute) + COMMIT + sync
        // One sync = one ReadyForQuery. A batch that may write leaves the
        // COMMIT out here and sends it after the transforms (holdCommit).

        // BEGIN
        connection.parse({ text: 'BEGIN', name: '' });
        connection.bind({ portal: '', statement: '', values: [], valueMapper: prepareValue });
        connection.execute({ portal: '', rows: 0 });

        // Each query
        for (const q of queries) {
          connection.parse({ text: q.sql, name: '' });
          connection.bind({
            portal: '',
            statement: '',
            values: q.params as unknown[],
            valueMapper: prepareValue,
          });
          connection.describe({ type: 'P', name: '' });
          connection.execute({ portal: '', rows: 0 });
        }

        if (!holdCommit) {
          connection.parse({ text: 'COMMIT', name: '' });
          connection.bind({ portal: '', statement: '', values: [], valueMapper: prepareValue });
          connection.execute({ portal: '', rows: 0 });
        }

        // Single Sync
        connection.sync();
      } else {
        // ---- Non-transactional mode ----
        // N×(parse+bind+describe+execute+sync)
        // Each sync = one ReadyForQuery
        // All messages still go in one cork/uncork (one TCP flush)

        for (const q of queries) {
          connection.parse({ text: q.sql, name: '' });
          connection.bind({
            portal: '',
            statement: '',
            values: q.params as unknown[],
            valueMapper: prepareValue,
          });
          connection.describe({ type: 'P', name: '' });
          connection.execute({ portal: '', rows: 0 });
          connection.sync();
        }
      }
    } catch (err) {
      // The send path threw PART WAY THROUGH an extended-query sequence, so the
      // backend has Parse/Bind bytes for the preceding queries and will never
      // receive their Sync. `valueMapper: prepareValue` runs synchronously
      // inside `bind`, so any param with a throwing `toPostgres`/`toJSON`, or a
      // circular reference, lands here.
      //
      // Returning that connection to the pool is what made this severe: the pool
      // reports it idle and healthy, the NEXT borrower checks it out, and its
      // first query hangs forever waiting on a ReadyForQuery for a sequence that
      // was never completed. The failure surfaces in an unrelated query with
      // nothing pointing back here. Destroy the connection instead: one dead
      // socket is recoverable, a wedged pool slot is not.
      //
      // Destroying the socket is the same move the timeout path above already
      // makes, and node-postgres drops a client whose stream errored rather than
      // returning it to the pool.
      if (connection.stream.destroy) {
        connection.stream.destroy(err instanceof Error ? err : new Error(String(err)));
      }
      cleanup();
      reject(err);
    } finally {
      // Always uncork, including on the throw path: leaving the stream corked
      // strands the buffered bytes and the socket with them.
      if (connection.stream.uncork) {
        connection.stream.uncork();
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------

/**
 * Check whether a pool client supports the extended-query pipeline protocol.
 *
 * Returns true if the client has a Connection object with the required wire
 * protocol methods (parse, bind, describe, execute, sync) and is an EventEmitter.
 *
 * Returns false for HTTP-based drivers (Neon HTTP, Vercel Postgres), mock pools,
 * and any pool that doesn't expose pg internals.
 */
export function supportsExtendedPipeline(poolClient: unknown): poolClient is PgPoolClient {
  if (!poolClient || typeof poolClient !== 'object') return false;
  const client = poolClient as Record<string, unknown>;
  const conn = client.connection;
  if (!conn || typeof conn !== 'object') return false;
  const c = conn as Record<string, unknown>;
  return (
    typeof c.parse === 'function' &&
    typeof c.bind === 'function' &&
    typeof c.describe === 'function' &&
    typeof c.execute === 'function' &&
    typeof c.sync === 'function' &&
    typeof c.on === 'function'
  );
}
