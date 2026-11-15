/**
 * Transaction-scoped transport facades shared by every engine.
 *
 * The driver keeps connection acquisition, SQL execution and iterator cleanup.
 * These facades route work through the transaction state and prevent a borrowed
 * connection from being released by a query accessor or raw callback. No driver,
 * client, query compiler or parser is loaded by this runtime boundary.
 *
 * @internal
 */

import { ValidationError, wrapPgError } from './errors.js';
import type { PgCompatPool, PgCompatPoolClient, PgCompatQueryResult } from './pg-types.js';
import { guardNativeStream } from './query/stream-idle.js';
import { TRANSACTION_STATE, type TransactionScope, type TransactionState } from './transaction-state.js';

function assertNativeStreamOpen(state: TransactionState, scope: TransactionScope): void {
  state.assertOpen();
  if (!scope.open) throw new ValidationError('This native stream belongs to a savepoint block that has ended.');
}

/** A native iterator's pulls obey the same transaction lifetime and scope as queries. */
function transactionNativeStream(
  client: PgCompatPoolClient,
  state: TransactionState,
  scope: TransactionScope,
  text: string,
  values: unknown[],
  batchSize: number,
  signal?: AbortSignal,
  raw = false,
): AsyncGenerator<Record<string, unknown>[], void, undefined> {
  // The driver must see the original signal so it can wake an in-flight pull.
  const stream = client.streamBatches!(text, values, batchSize, signal);
  const pull = () => {
    assertNativeStreamOpen(state, scope);
    return stream.next();
  };
  return guardNativeStream(stream, () => state.run(pull, scope, raw && state.screenRaw(text)));
}

/**
 * The connection `transaction(fn)` and `tx.$connection()` hand out: the
 * checked-out client, with every statement routed through the transaction's
 * state, so one issued after the transaction settled is refused rather than
 * run on a connection that is back in the pool, and transaction-control SQL
 * (`COMMIT`, `BEGIN`, ...) is refused rather than ending the transaction behind
 * the state that tracks it.
 *
 * What would take the connection away is refused too: `release` (the
 * transaction returns it itself), `end` and `connect`, and the driver's
 * `connection` (the wire-level object, whose writes bypass every check here) is
 * hidden. Everything else is the driver client's own.
 */
export function guardTransactionConnection(
  client: PgCompatPoolClient,
  state: TransactionState,
  scope: TransactionScope = state.rootScope,
  api: 'transaction()' | '$connection()' = 'transaction()',
): PgCompatPoolClient {
  // The refusals name the API the caller used: a `tx.$connection()` caller
  // never called `transaction()`.
  const who = api === 'transaction()' ? 'transaction(): the callback' : '$connection(): the $transaction callback';
  const target = client as unknown as Record<PropertyKey, unknown>;
  const send = target.query as (...args: unknown[]) => unknown;
  const query = (...args: unknown[]): unknown => {
    const first = args[0] as { submit?: unknown; text?: unknown } | string | null;
    const text = typeof first === 'string' ? first : first?.text;
    // Callback form and submittables (cursors, COPY streams) answer through
    // their own channel, not a promise: checked, then passed straight through.
    if (
      typeof args[args.length - 1] === 'function' ||
      typeof (first as { submit?: unknown } | null)?.submit === 'function'
    ) {
      state.assertOpen();
      state.screenRaw(text);
      return send.apply(client, args);
    }
    return state.runRaw(text, () => send.apply(client, args) as Promise<unknown>, scope);
  };
  const streamBatches = client.streamBatches
    ? (text: string, values: unknown[], batchSize: number, signal?: AbortSignal) =>
        transactionNativeStream(client, state, scope, text, values, batchSize, signal, true)
    : undefined;
  const release = (): never => {
    throw new ValidationError(
      `${who} must not release its client; the transaction releases it after COMMIT or ROLLBACK.`,
    );
  };
  const refuse = (verb: string): (() => never) => {
    return () => {
      throw new ValidationError(
        `${who} must not ${verb} its client; the transaction owns the connection and ` +
          'returns it to the pool after COMMIT or ROLLBACK.',
      );
    };
  };
  const overrides = {
    query,
    streamBatches,
    connection: undefined,
    release,
    end: refuse('end'),
    connect: refuse('connect'),
  };
  const bound = new Map<PropertyKey, unknown>();
  return new Proxy(target, {
    has(t, prop) {
      return prop === 'connection' ? false : Reflect.has(t, prop);
    },
    get(t, prop) {
      if (Object.hasOwn(overrides, prop)) return overrides[prop as keyof typeof overrides];
      const value = Reflect.get(t, prop, t);
      if (typeof value !== 'function') return value;
      let fn = bound.get(prop);
      if (fn === undefined) {
        fn = (value as (...a: unknown[]) => unknown).bind(t);
        bound.set(prop, fn);
      }
      return fn;
    },
  }) as unknown as PgCompatPoolClient;
}

/**
 * A pool-shaped view of one borrowed transaction connection. Prepared query
 * configs reach the driver intact, failures keep the common error mapping,
 * and native iterator pulls share the query lifetime and savepoint scope.
 * The source pool's optional engine flags retain their original values.
 *
 * @internal
 */
export function createTransactionPool(
  client: PgCompatPoolClient,
  state: TransactionState,
  scope: TransactionScope,
  sourcePool?: { readonly readonly?: boolean; readonly capabilities?: unknown },
): PgCompatPool {
  const query = (textOrConfig: string | { name?: string; text: string; values?: unknown[] }, values?: unknown[]) =>
    state.run(async () => {
      try {
        if (typeof textOrConfig === 'string') {
          return await client.query(textOrConfig, values);
        }
        // Object form for prepared statements: { name, text, values }
        // A driver client accepts it, but the two-argument `query` in the
        // PgCompatPoolClient contract does not describe it, so the cast is local.
        return await (client as unknown as { query(config: unknown): Promise<PgCompatQueryResult> }).query(
          textOrConfig,
        );
      } catch (err) {
        throw wrapPgError(err);
      }
    }, scope);
  // Return a minimal pool-compatible object that routes queries
  // through the transaction client
  const txPool: Record<PropertyKey, unknown> = {
    query,
    // The transaction's connection is not this pool's to lend: a "checkout"
    // runs on it through the same guarded `query`, and releasing it is a
    // no-op, so nothing reached through the pool can hand the connection back
    // to the real pool while the transaction still holds it.
    connect: async () => {
      state.assertOpen();
      return { query, ...(txPool.streamBatches ? { streamBatches: txPool.streamBatches } : {}), release: () => {} };
    },
    runStreamQuery: <T>(statement: () => Promise<T>, settled: import('./pg-types.js').StreamQuerySettlement) =>
      state.run(statement, scope, false, settled),
    assertStreamOpen: () => assertNativeStreamOpen(state, scope),
    [TRANSACTION_STATE]: state,
  };
  if (client.streamBatches) {
    // Only native streams need this facade. Each pull has the same scope
    // and lifetime checks as a query; cleanup must work after the scope ends.
    txPool.streamBatches = (text: string, values: unknown[], batchSize: number, signal?: AbortSignal) =>
      transactionNativeStream(client, state, scope, text, values, batchSize, signal);
  }
  // Carry the parent pool's PowDB-only flags through so a transaction-scoped
  // PowqlInterface reads the same read-only guard and capabilities it would
  // outside the transaction (a plain pg pool has neither, so nothing changes).
  if (sourcePool?.readonly !== undefined) txPool.readonly = sourcePool.readonly;
  if (sourcePool?.capabilities !== undefined) txPool.capabilities = sourcePool.capabilities;
  return txPool as unknown as PgCompatPool;
}
