/**
 * turbine-orm, the `turbine:query` tracing channel.
 *
 * Every statement that emits a `$on('query')` event is also published on the
 * Node `diagnostics_channel` tracing channel named {@link QUERY_CHANNEL}, so a
 * tracer or APM agent can turn Turbine queries into spans without any setup in
 * the application: it subscribes to the channel, and the application never
 * passes it a client.
 *
 * The events follow the TracingChannel lifecycle for an async call: `start`
 * and `end` when the statement is handed to the driver, then `error` (on
 * failure), `asyncStart` and `asyncEnd` when it settles. All five carry the
 * same context object, so a subscriber can key its own state on it. `start`
 * runs in the caller's async context, so the active span there is the
 * statement's parent.
 *
 * The context never carries a bound parameter value: `sql` is the
 * parametrized text Turbine built (`$1`, `$2`, ...), without the `sqlComment`,
 * and `paramCount` is how many values were bound. Result rows are not
 * attached either. That is why the events are published directly rather than
 * through `tracePromise`, which would put the driver result on the context.
 * A consequence: stores bound with `bindStore` are not entered, so read the
 * caller's async context in the `start` subscriber instead.
 *
 * Cost without a subscriber: one `hasSubscribers` read per statement, and no
 * object is built. The channel is looked up once, through
 * `process.getBuiltinModule`, so no Node builtin is imported statically and
 * the edge entry stays builtin-free. Where that function is missing (Node
 * before 20.16 or 22.3, edge runtimes) nothing is published.
 */

/** The tracing channel name. Subscribe with `diagnostics_channel.tracingChannel('turbine:query')`. */
export const QUERY_CHANNEL = 'turbine:query';

/**
 * The context object published on every `turbine:query` event. `rowCount` and
 * `durationMs` are set before `asyncStart`, and `error` before the `error`
 * event; the start events see only the identity fields.
 */
export interface QueryChannelContext {
  /** The table, or `'$raw'` for raw SQL. */
  model: string;
  /** The entry point: `findMany`, `create`, `raw`, `$queryRaw` ... */
  operation: string;
  /** The parametrized statement, never its values, and without the `sqlComment`. */
  sql: string;
  /** How many values were bound to `sql`. */
  paramCount: number;
  /** Rows returned or affected. 0 for a failed statement. */
  rowCount?: number;
  /** Wall time of the statement, in ms. In a pipeline, the batch's time split evenly across its statements. */
  durationMs?: number;
  /** The error the caller receives, on failure. */
  error?: Error;
  /** `'pipeline'` or `'transaction'` for a statement sent as part of a batch. */
  batch?: 'pipeline' | 'transaction';
  /** Set on a failed first attempt of a read that Turbine sent once more on a fresh connection. */
  retried?: true;
}

interface ChannelLike {
  readonly hasSubscribers: boolean;
  publish(message: unknown): void;
}

interface TracingChannelLike {
  readonly hasSubscribers?: boolean;
  start: ChannelLike;
  end: ChannelLike;
  asyncStart: ChannelLike;
  asyncEnd: ChannelLike;
  error: ChannelLike;
}

let channel: TracingChannelLike | null | undefined;

function queryChannel(): TracingChannelLike | null {
  if (channel !== undefined) return channel;
  channel = null;
  try {
    const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
    const dc = proc?.getBuiltinModule?.('node:diagnostics_channel') as
      | { tracingChannel?: (name: string) => TracingChannelLike }
      | undefined;
    channel = dc?.tracingChannel?.(QUERY_CHANNEL) ?? null;
  } catch {
    channel = null;
  }
  return channel;
}

function subscribed(c: TracingChannelLike): boolean {
  // TracingChannel#hasSubscribers is Node 22+ and 20.13+; older ones check each channel.
  if (typeof c.hasSubscribers === 'boolean') return c.hasSubscribers;
  return (
    c.start.hasSubscribers ||
    c.end.hasSubscribers ||
    c.asyncStart.hasSubscribers ||
    c.asyncEnd.hasSubscribers ||
    c.error.hasSubscribers
  );
}

/** True when something subscribes to `turbine:query`. */
export function queryChannelActive(): boolean {
  const c = queryChannel();
  return c !== null && subscribed(c);
}

/**
 * Publish `start` and `end` for a statement about to be sent, and return the
 * context to settle with {@link settleQueryTrace}. Undefined, and nothing
 * built, when nobody subscribes. Never throws.
 */
export function startQueryTrace(
  model: string,
  operation: string,
  sql: string,
  paramCount: number,
  batch?: 'pipeline' | 'transaction',
): QueryChannelContext | undefined {
  const c = queryChannel();
  if (c === null || !subscribed(c)) return undefined;
  const context: QueryChannelContext = { model, operation, sql, paramCount };
  if (batch !== undefined) context.batch = batch;
  try {
    c.start.publish(context);
    c.end.publish(context);
  } catch {
    // A subscriber problem must not fail the statement.
  }
  return context;
}

/**
 * Publish `error` (on failure), `asyncStart` and `asyncEnd` for a statement
 * started with {@link startQueryTrace}. A no-op for an undefined context.
 * Never throws.
 */
export function settleQueryTrace(
  context: QueryChannelContext | undefined,
  rowCount: number,
  durationMs: number,
  error?: Error,
  retried?: boolean,
): void {
  if (context === undefined) return;
  const c = queryChannel();
  if (c === null) return;
  context.rowCount = rowCount;
  context.durationMs = durationMs;
  if (retried) context.retried = true;
  try {
    if (error !== undefined) {
      context.error = error;
      c.error.publish(context);
    }
    c.asyncStart.publish(context);
    c.asyncEnd.publish(context);
  } catch {
    // A subscriber problem must not fail the statement.
  }
}
