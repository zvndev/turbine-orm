/**
 * turbine-orm, `$on('query')` event metadata: the raw-statement model name
 * and per-scope query tags for attribution.
 *
 * A tag is a caller-chosen label (`'checkout'`, `'nightly-report'`) that rides
 * on every {@link QueryEvent} emitted while a `db.$tag(label, fn)` callback is
 * running, including queries issued from inside awaited helpers, transactions
 * and pipelines. It exists so telemetry can answer "which feature issued this
 * query", which model + action alone cannot: `orders.findMany` is called from
 * a dozen places.
 *
 * The tag is scoped by async context rather than threaded through every query
 * argument type. A per-query option would have to be added to every args type,
 * the runtime option surface, and the prisma-compat unknown-option check, and
 * it would still miss raw SQL and pipelines. A scope reaches every emitter with
 * one read at the single emit seam in client.ts, and it costs nothing when no
 * `$on('query')` listener is registered, because the store is only read on the
 * emit path.
 *
 * ONE scope per realm. The store hangs off `globalThis` under a
 * `Symbol.for(...)` key for the same reason the warn-once registry does: the
 * package ships ESM and CJS, and a mixed graph loading both copies must still
 * see the tag a caller set through either copy.
 *
 * The tag never reaches SQL. It is metadata on the in-process event only; what
 * a listener does with it (log it, forward it to a collector) is the
 * listener's business.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { ValidationError } from './errors.js';
import type { QueryEvent } from './query/deferred.js';

/**
 * The `model` reported for statements that are not tied to one table: `raw`,
 * `sql`, the transaction-scoped `raw` / `rawQuery`, and prisma-compat's
 * `$queryRaw` / `$executeRaw` family. `action` names the entry point that ran
 * it. The `$` prefix cannot collide with a generated table accessor.
 */
export const RAW_QUERY_MODEL = '$raw';

/** Longest tag accepted. Keeps a tag a label, not a payload. */
export const MAX_QUERY_TAG_LENGTH = 128;

const SCOPE_KEY = Symbol.for('turbine.queryTag.scope');

function scope(): AsyncLocalStorage<string> {
  const g = globalThis as Record<symbol, unknown>;
  let store = g[SCOPE_KEY] as AsyncLocalStorage<string> | undefined;
  if (!store) {
    store = new AsyncLocalStorage<string>();
    g[SCOPE_KEY] = store;
  }
  return store;
}

/** The tag in force for the code currently running, or `undefined`. */
export function currentQueryTag(): string | undefined {
  return scope().getStore();
}

/**
 * Run `fn` with `tag` attached to every query event it causes. An inner scope
 * replaces an outer one for its own duration. Throws {@link ValidationError}
 * (E003) for a tag that is not a non-empty string of at most
 * {@link MAX_QUERY_TAG_LENGTH} characters, before `fn` runs.
 */
export function runWithQueryTag<R>(tag: string, fn: () => R): R {
  if (typeof tag !== 'string' || !tag.trim() || tag.length > MAX_QUERY_TAG_LENGTH) {
    throw new ValidationError(`$tag() needs a label of 1-${MAX_QUERY_TAG_LENGTH} characters.`);
  }
  return scope().run(tag, fn);
}

// ---------------------------------------------------------------------------
// Events for statements that do not go through a QueryInterface
// ---------------------------------------------------------------------------

/** A client's event sink, as QueryInterfaceOptions carries it. */
type QueryEventSink = ((event: QueryEvent) => void) | undefined;

/** Rows a driver result reports: the affected count, else the returned rows. */
export function resultRowCount(result: { rowCount?: number | null; rows?: unknown[] } | undefined): number {
  return typeof result?.rowCount === 'number' ? result.rowCount : (result?.rows?.length ?? 0);
}

/**
 * Emit one query event for a statement that ran outside a QueryInterface (raw
 * SQL, a pipeline slot, a transaction-batch slot). Never throws: a listener
 * problem must not turn a successful statement into a failed one.
 */
export function emitStatementEvent(sink: QueryEventSink, event: Omit<QueryEvent, 'timestamp'>): void {
  try {
    sink?.({ ...event, timestamp: new Date() });
  } catch {
    // Listener errors must never crash a query.
  }
}

/**
 * Split a DeferredQuery tag (`'<table>.<action>'`) into the event's model and
 * action. A tag without one is reported as a raw statement.
 */
export function deferredIdentity(tag: string): { model: string; action: string } {
  const at = tag.lastIndexOf('.');
  return at > 0 ? { model: tag.slice(0, at), action: tag.slice(at + 1) } : { model: RAW_QUERY_MODEL, action: tag };
}

/**
 * Run one statement and report it. `identity` is the event's model and action
 * (plus `batch` for a batch slot); for raw SQL the model is
 * {@link RAW_QUERY_MODEL} and the action names the entry point (`'raw'`,
 * `'sql'`, `'rawQuery'`, `'$queryRaw'` ...). `wrap` turns a driver error into
 * what the caller sees, and the event carries that same error.
 *
 * The failure is reported from inside the `catch`, never handed to a `finally`
 * through a local. SWC's minifier (the one Next.js runs over server bundles)
 * treats `error = wrap(err); throw error;` as a single-use temporary and
 * rewrites it to `throw wrap(err)`, dropping the assignment the `finally` then
 * reads. Every failed statement in a minified bundle was reported as a
 * success. `minified-events.test.ts` runs this module through that minifier.
 */
export async function runReportedStatement<R extends { rowCount?: number | null; rows?: unknown[] }>(
  sink: QueryEventSink,
  identity: Pick<QueryEvent, 'model' | 'action' | 'batch'>,
  sql: string,
  params: unknown[],
  run: () => Promise<R>,
  wrap: (err: unknown) => unknown,
): Promise<R> {
  const start = performance.now();
  const report = (rows: number, error?: Error): void => {
    if (!sink) return;
    emitStatementEvent(sink, {
      ...identity,
      sql,
      params,
      duration: performance.now() - start,
      rows,
      ...(error === undefined ? {} : { error }),
    });
  };
  let result: R;
  try {
    result = await run();
  } catch (err) {
    const error = wrap(err);
    report(0, error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
  report(resultRowCount(result));
  return result;
}

/** The identity of a raw statement run through `action`. */
export const rawIdentity = (action: string): Pick<QueryEvent, 'model' | 'action'> => ({
  model: RAW_QUERY_MODEL,
  action,
});
