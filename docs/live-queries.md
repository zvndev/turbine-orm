# Live queries

Optional addition in 0.94.0. `src/live-query.ts` provides opt-in notification
invalidation followed by ordinary typed query callbacks. The integrated package
manifest exposes `turbine-orm/live-query` for ESM and CommonJS consumers.
Existing entry points and `$listen` / `$notify` behavior are unchanged.

```ts
import { liveQuery } from 'turbine-orm/live-query';
import { createNotificationHub } from 'turbine-orm/notification-hub';

// Once per application. Assert the actual endpoint's session affinity.
const hub = createNotificationHub(pool, {
  endpoint: 'direct', ownership: 'external', maxSubscriptions: 64,
  onError: recordRetryDiagnostic,
});
const snapshots = liveQuery({
  subscribe: (invalidate) => hub.subscribe('orders_changed', invalidate, {
    signal: requestAbortSignal,
    onResync: () => invalidate(), // reconnect AND overflow reread current state
    onError: recordRetryDiagnostic, // recoverable; not LiveQuery's terminal onError
  }),
  query: () => scopedDb.orders.findMany({
    select: { id: true, status: true },
    orderBy: { id: 'asc' },
    limit: 100,
  }),
  signal: requestAbortSignal,
});

try {
  for await (const rows of snapshots) {
    await sendLatestOrders(rows);
  }
} finally {
  await snapshots.dispose();
}
// At application shutdown, dispose ALL query handles before:
await hub.close();
await pool.end(); // caller-owned

```

The query result type is preserved, including selected fields, nested results,
nullable values and readonly tuples. Each refetch calls the supplied function
again. Ordinary client middleware, global filters, PII rules, projections,
parsers and query errors therefore apply on every read. The helper does not
compile SQL or interpret notification payloads.

Use a read callback with a bounded result and an explicit application scope.
Notifications may wake many consumers; they grant no access to rows. Capture
the authorized scope in the callback or use the application's scoped client.
The helper does not capture request-local async context across arbitrary
subscription event sources; re-enter such context inside the callback when
policy depends on it. Query and subscription callbacks must live for the whole
subscription, beyond the initial request if applicable.

The [runnable application example](../examples/notification-live-query/README.md)
owns the hub and explicit handles, cancels individual requests safely, and drains
reads before closing the hub and caller-owned pool. It includes a finite demo
and native source plus actual installed ESM/CJS execution on exact Node 22.16.0
and 24.10.0. Its endpoint must assert `direct` or `session-pool`.

## Public contract

```ts
interface LiveQuerySubscription {
  unsubscribe(): void | PromiseLike<void>;
}

interface LiveQuerySubscriptionCallbacks {
  onReconnect(): void;
  onError(error: unknown): void;
}

interface LiveQueryOptions<T> {
  query(signal: AbortSignal): T | PromiseLike<T>;
  subscribe(
    invalidate: () => void,
    callbacks: LiveQuerySubscriptionCallbacks,
  ): LiveQuerySubscription | PromiseLike<LiveQuerySubscription>;
  signal?: AbortSignal;
}

interface LiveQuery<T> extends AsyncIterableIterator<T> {
  readonly ready: Promise<void>;
  readonly closed: Promise<void>;
  dispose(): Promise<void>;
}

function liveQuery<T>(options: LiveQueryOptions<T>): LiveQuery<Awaited<T>>;
```

Creation schedules subscription setup immediately; consuming the iterator is
not required to start it. `subscribe` must resolve only after listening is
active. The first query starts after that resolution. `ready` resolves once the
first query is scheduled, without waiting for its result. Setup failure or
closure before readiness rejects `ready`; a synchronous first-query failure
can also reject it. Each live query has one consumer and permits only one
pending `next()`; another concurrent pull rejects with `TypeError`.

The narrow subscription contract composes with the integrated application-owned
notification hub. Many logical queries share one dedicated listener connection.
No factory or client extension is required.
`unsubscribe()` releases only the handle returned for this live query. A
subscription whose setup rejects must clean up any resources it acquired before
rejecting. The helper cannot clean up a handle it never receives.

## Coalescing and delivery

| State | Behavior |
| --- | --- |
| Subscription setup pending | Wait before querying; invalidations need no queue |
| Query in flight | Mark dirty on invalidation or reconnect; keep one dirty bit |
| Dirty query completes | Discard that snapshot and rerun once; further invalidations can require another rerun |
| Clean query completes | Resolve a waiting pull or replace the one buffered result |
| Buffered snapshot invalidated | Discard it immediately and start a refetch |
| Consumer is slow | Keep at most the newest clean undelivered result |
| Disposed or failed | Clear buffered state, abort the query signal, stop reruns and release the listener |

There is at most one query in flight, one dirty bit, one buffered result and one
pending pull. There is no event queue. The bound is on retained snapshots, not
on the size of a query result or queries per second. This is eager refetching:
consumer backpressure does not pause invalidation handling. Continuous
invalidation can postpone delivery until a query completes cleanly. Callbacks
should read state without causing their own repeated invalidations.

Delivery reports completed snapshots, without equality comparisons or cloning.
A result already delivered to a pull cannot be revoked when a later
invalidation arrives. Duplicate states may be delivered. Intermediate database
states and individual notifications can be coalesced away.

## Reconnect and errors

With the shared hub, map `onResync` to invalidation as above. Do not also map
`onReconnect` to invalidation: the hub already emits resync after reconnect.
`hub.subscribe` readiness gates the first read, and reconnect/overflow both
require fresh current state. With existing per-query `$listen`, forward `onReconnect` as in the example. `$listen`
retries connection loss itself and calls that hook after `LISTEN` is active
again. The helper invalidates and rereads, including when loss/reconnect raced
a query already in flight. Initial subscription rejection is terminal.

`LiveQuerySubscriptionCallbacks.onError` means **terminal failure**. Existing
`ListenOptions.onError` reports recoverable disconnects and retry attempts as
well, so forwarding it to terminal `onError` would stop automatic recovery.
Keep retry diagnostics with `$listen`. To deliberately stop on the first loss:

```ts
subscribe: (invalidate, { onError }) => db.$listen(
  'orders_changed',
  invalidate,
  { reconnect: false, onError },
)
```

A query throw/rejection or terminal subscription error rejects a waiting pull,
closes the iterator and starts listener cleanup. Later pulls reject with the
failure. `closed` and `dispose()` reject after cleanup. If both the operation
and cleanup fail, their errors appear in an `AggregateError` from `closed`;
a pull rejected earlier retains the original error. Cleanup failure discovered
after graceful cancellation is reported by `closed` / `dispose()` even though
a pending pull may already have completed normally. Lifecycle promise
rejections are internally observed, so ignoring `ready` or `closed` does not
create unhandled background rejections. Consumers should still handle iteration
and disposal errors.

## Cancellation and ownership

Returning a subscription without an `unsubscribe()` method rejects with native
`TypeError`. This optional helper imports no query-runtime error classes.

An aborted `signal`, `dispose()` or iterator `return()` stops delivery and
reruns immediately. Breaking a `for await` loop awaits `return()` and cleanup.
An already aborted signal prevents setup. Disposal is idempotent and waits for
pending subscription setup so a late handle is unsubscribed. Setup and cleanup
must eventually settle; the helper cannot forcibly reclaim a pending external
promise.

The callback receives an internal `AbortSignal`. Pass it to APIs that support
cancellation; ordinary queries that ignore it can finish externally. Disposal
does not wait for such a query. Its late result or rejection is observed and
discarded, and cannot trigger a rerun. The helper never disconnects a client or
ends a caller-owned pool.

Dispose live queries before disconnecting the client. The existing subscription
API does not report a client-initiated disconnect as a terminal subscription
event; a custom adapter must report its own terminal closure through `onError`
if it wants to propagate that closure.

## Evidence and transport boundary

The PostgreSQL adapter requires a real persistent session and enough pool
capacity for its dedicated listener plus reads. A direct endpoint or appropriate
session pool is required; stateless HTTP and transaction pooling do not provide
this listener contract. PostgreSQL notifications become visible after the
sending transaction commits. Disconnected notifications are lost; reconnect
refetch recovers current query state, not missed events.

Focused native tests use an isolated local PostgreSQL service with node-postgres.
`src/test/live-query-hub-pg.test.ts` runs the application composition with one
listener for 32 logical queries, real disconnect resync, bounded burst/slow-reader
behavior, scoped policy, independent cancellation and ordered disposal. See the
example README for its source-native and immutable installed-archive runner.
They assert commit/rollback effects, exact ordered rows, subscribe-before-read
races, actual backend termination/reconnection, scoped global filters,
middleware, PII refusal, cancellation and listener/pool cleanup. A test gate
requires `DATABASE_URL` when `TURBINE_REQUIRE_ENGINE=postgres` is set; missing
native prerequisites fail instead of becoming passing skips.

```sh
DATABASE_URL=postgresql://... TURBINE_REQUIRE_ENGINE=postgres \
  node --import tsx --test src/test/live-query-pg.test.ts
node --import tsx --test src/test/live-query.test.ts
npm run build
node src/test/fixtures/live-query/consumers.mjs /absolute/tested-package.tgz \
  --sha256 <tested-archive-sha256> --report /tmp/live-query-consumers.json
node src/test/fixtures/live-query/controls.mjs /tmp/live-query-controls
# A real locally installed Miniflare/workerd prerequisite, passed explicitly:
node src/test/fixtures/live-query/edge.mjs /path/to/miniflare/dist/src/index.js
```

The consumer fixture installs the supplied archive unchanged and verifies its
SHA256 and installed payload. It tests strict ESM/CJS consumers without
PostgreSQL driver types, preserves the result type, and checks the live-query and
notification-hub imports with the PostgreSQL driver physically absent. The
separate controls command injects faults into copied build fixtures. The edge
fixture runs the helper with a
callback subscription inside local workerd; it requires the runtime and fails
if absent. Its pinned compatibility date is `2026-08-06`. This proves the
helper's runtime behavior there, not a PostgreSQL connection from Workers or
a provider-hosted deployment.

This primitive provides volatile invalidation and refetch. It provides no
durable replay, CDC, outbox, exact notification history, browser WebSocket
gateway or all-dialect realtime guarantee. Local fixtures
do not promote any engine or transport support tier.
