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
  if (typeof tag !== 'string' || tag.trim().length === 0) {
    throw new ValidationError('$tag() needs a non-empty string label, e.g. db.$tag("checkout", () => ...).');
  }
  if (tag.length > MAX_QUERY_TAG_LENGTH) {
    throw new ValidationError(
      `$tag() label is ${tag.length} characters; the limit is ${MAX_QUERY_TAG_LENGTH}. ` +
        'A tag names a feature or a code path, it is not a place to put request data.',
    );
  }
  return scope().run(tag, fn);
}
