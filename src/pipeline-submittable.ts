/**
 * turbine-orm — Real Postgres pipeline protocol implementation
 *
 * Uses the pg extended-query protocol wire methods (parse/bind/describe/execute/sync)
 * exposed on pg.Client's Connection object to send multiple queries in a single
 * TCP flush. This achieves true 1-RTT pipeline execution instead of the sequential
 * await-per-query approach.
 *
 * The approach (listener-swap):
 *   1. Detach the pg.Client's event listeners from the Connection
 *   2. Attach our own state-machine listeners
 *   3. Cork the TCP stream, push all protocol messages, uncork (one TCP write)
 *   4. Drive a state machine over backend response events
 *   5. Restore original listeners and release the client
 *
 * This is the same pattern used by pg-cursor and pg-query-stream, but extended
 * to handle N queries in a single pipeline.
 */

import type { EventEmitter } from 'node:events';
import type pg from 'pg';
import Result from 'pg/lib/result';
import { prepareValue } from 'pg/lib/utils';
import { wrapPgError } from './errors.js';
import type { DeferredQuery } from './query.js';

// ---------------------------------------------------------------------------
// Types for pg internals we interact with
// ---------------------------------------------------------------------------

/** The pg Connection object — an EventEmitter with wire-protocol methods */
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

/** A pg PoolClient with the internal fields we need */
export interface PgPoolClient {
  connection: PgConnection;
  /** pg.Client sets this to control query queue draining */
  readyForQuery: boolean;
  /** Type parser overrides (if the client has custom type parsers) */
  _types?: unknown;
  release(err?: Error | boolean): void;
}

// ---------------------------------------------------------------------------
// Event names we intercept
// ---------------------------------------------------------------------------

/**
 * All backend message event names that the pg Client listens for.
 * We snapshot, detach, and restore listeners for these events.
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

/**
 * Execute multiple queries using the Postgres extended-query pipeline protocol.
 *
 * All protocol messages are buffered into a single TCP write via cork/uncork.
 * The backend processes them in order and sends back results which our state
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

  // Block the Client from processing any queued queries while we own the connection
  const savedReadyForQuery = client.readyForQuery;
  client.readyForQuery = false;

  return new Promise<unknown[]>((resolve, reject) => {
    // -----------------------------------------------------------------------
    // State machine
    // -----------------------------------------------------------------------

    /**
     * Total expected commandComplete events:
     * - Transactional: BEGIN + N queries + COMMIT = N + 2
     * - Non-transactional: N queries
     */
    const totalCommands = transactional ? queries.length + 2 : queries.length;

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

    // commandComplete counter — tracks position across all commands
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

    /**
     * Map commandComplete index to the corresponding results[] index.
     * In transactional mode: index 0 = BEGIN, 1..N = queries, N+1 = COMMIT
     * In non-transactional mode: index maps 1:1
     */
    function commandToQueryIndex(cmdIdx: number): number | null {
      if (transactional) {
        if (cmdIdx === 0 || cmdIdx === totalCommands - 1) return null;
        return cmdIdx - 1;
      }
      return cmdIdx;
    }

    /** Get the current query-results index for row data */
    function currentQueryIndex(): number | null {
      return commandToQueryIndex(commandIndex);
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

      // Remove our listeners
      detachListeners(connection);

      // Restore original listeners
      restoreListeners(connection, savedListeners);

      // Restore readyForQuery so the Client can process its queue
      client.readyForQuery = savedReadyForQuery;
    }

    // -----------------------------------------------------------------------
    // Finalize: called on final readyForQuery
    // -----------------------------------------------------------------------

    function finalize(): void {
      cleanup();

      if (transactional && pipelineError) {
        reject(pipelineError);
        return;
      }

      if (!transactional && pipelineError) {
        // In non-transactional mode, attach partial results to the error
        const partialResults: Array<{ status: 'ok'; value: unknown } | { status: 'error'; error: Error }> = [];
        for (let i = 0; i < queries.length; i++) {
          const qErr = queryErrors[i];
          if (qErr) {
            partialResults.push({ status: 'error', error: qErr });
          } else {
            try {
              const q = queries[i]!;
              partialResults.push({ status: 'ok', value: q.transform(results[i]! as unknown as pg.QueryResult) });
            } catch (transformErr) {
              partialResults.push({ status: 'error', error: transformErr as Error });
            }
          }
        }
        (pipelineError as Error & { results?: unknown }).results = partialResults;
        reject(pipelineError);
        return;
      }

      // All succeeded — transform results
      try {
        const transformed: unknown[] = [];
        for (let i = 0; i < queries.length; i++) {
          const q = queries[i]!;
          transformed.push(q.transform(results[i]! as unknown as pg.QueryResult));
        }
        resolve(transformed);
      } catch (err) {
        reject(err);
      }
    }

    // -----------------------------------------------------------------------
    // Event handlers
    // -----------------------------------------------------------------------

    function onParseComplete(): void {
      // No action needed — anonymous prepared statements
    }

    function onBindComplete(): void {
      // No action needed
    }

    function onNoData(): void {
      // DML without RETURNING — no RowDescription follows. Fine.
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

      if (transactional) {
        // In transactional mode, the first error aborts everything.
        // Postgres marks the transaction as aborted; subsequent commands
        // until Sync all return errors which we absorb.
        if (!pipelineError) {
          const qIdx = currentQueryIndex();
          if (qIdx !== null && qIdx >= 0 && qIdx < queries.length) {
            (error as Error & { failedIndex?: number; failedTag?: string }).failedIndex = qIdx;
            (error as Error & { failedTag?: string }).failedTag = queries[qIdx]!.tag;
          }
          pipelineError = error;
        }
      } else {
        // Non-transactional: record per-query error
        const qIdx = currentQueryIndex();
        if (qIdx !== null && qIdx >= 0 && qIdx < queries.length) {
          queryErrors[qIdx] = error;
          if (!pipelineError) {
            (error as Error & { failedIndex?: number; failedTag?: string }).failedIndex = qIdx;
            (error as Error & { failedTag?: string }).failedTag = queries[qIdx]!.tag;
            pipelineError = error;
          }
        }
      }
      // Advance command index past the failed command
      commandIndex++;
    }

    function onPortalSuspended(): void {
      // We don't use row-limited portals
    }

    function onReadyForQuery(): void {
      rfqCount++;
      if (rfqCount >= expectedRfq) {
        finalize();
      }
    }

    // -----------------------------------------------------------------------
    // Attach our listeners
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

    // -----------------------------------------------------------------------
    // Timeout
    // -----------------------------------------------------------------------

    if (timeout && timeout > 0) {
      timeoutHandle = setTimeout(() => {
        pipelineError = new Error(`[turbine] Pipeline timed out after ${timeout}ms`);
        if (connection.stream.destroy) {
          connection.stream.destroy(pipelineError);
        }
        cleanup();
        reject(pipelineError);
      }, timeout);
    }

    // -----------------------------------------------------------------------
    // Send protocol messages — all in one TCP flush
    // -----------------------------------------------------------------------

    try {
      if (connection.stream.cork) {
        connection.stream.cork();
      }

      if (transactional) {
        // ---- Transactional mode ----
        // BEGIN + N×(parse+bind+describe+execute) + COMMIT + sync
        // One sync = one ReadyForQuery

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

        // COMMIT
        connection.parse({ text: 'COMMIT', name: '' });
        connection.bind({ portal: '', statement: '', values: [], valueMapper: prepareValue });
        connection.execute({ portal: '', rows: 0 });

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

      if (connection.stream.uncork) {
        connection.stream.uncork();
      }
    } catch (err) {
      cleanup();
      reject(err);
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
