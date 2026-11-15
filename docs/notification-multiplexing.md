# Notification multiplexing

This is an optional API, added in 0.94.0 and exported as `turbine-orm/notification-hub`.
`src/notification-hub.ts` provides a PostgreSQL listener shared by several channels
and consumers. Existing `$listen` subscriptions continue to hold one dedicated
connection each.

```ts
// Optional package entry:
import { createNotificationHub } from 'turbine-orm/notification-hub';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000, query_timeout: 5000 });
const hub = createNotificationHub(pool, {
  endpoint: 'direct',
  ownership: 'owned',
  maxChannels: 128,
  maxSubscriptions: 1024,
  reconnect: { initialDelayMs: 100, maxDelayMs: 30_000 },
});
const abort = new AbortController();
const subscription = await hub.subscribe('OrdersChanged', (payload) => {
  invalidateOrders(payload);
}, {
  signal: abort.signal,
  onError: (error) => recordFailure(error),
  onResync: (reason) => refreshOrders(reason),
});

await subscription.unsubscribe(); // or abort.abort()
await hub.close();
```

The application supplies the pool. The module does not import or instantiate a
driver, change parsers, patch a factory, or become reachable through existing
entries. It has no dependency on a live-query implementation or browser server.

## Session admission

`endpoint` is mandatory. `'direct'` means an actual direct PostgreSQL session;
`'session-pool'` asserts session pooling that preserves the backend for the full
checked-out listener lifetime. The caller must verify the deployment's real
pooler mode. A logical client with events, or a successful query followed by
release, does not prove session affinity.

Missing or other endpoint values fail before checkout. In particular, PgBouncer
transaction pooling supports NOTIFY but does not support LISTEN. Event support
on the returned client is an additional check, not certification of the endpoint.
See the [PgBouncer feature matrix](https://www.pgbouncer.org/features.html).
Stateless HTTP, transaction/statement pooling, and generic WebSocket transports
without a verified session contract are outside this API's supported contract.
The accepted string is an assertion, not runtime detection of a misconfigured pooler.

## Sharing and readiness

`subscribe(channel, handler, options?)` resolves a `Subscription` after LISTEN
acknowledgement. It reuses the existing channel rule: ASCII letters, digits and
underscores, starting with a letter or underscore, at most 63 characters. Names
are quoted, so `OrdersChanged` and `orderschanged` are distinct. Invalid names
are rejected before checkout.

There is one native checkout while consumers exist, one LISTEN per distinct
channel, and one reference per consumer. Removing the final reference to a
channel issues UNLISTEN. Removing the final consumer issues `UNLISTEN *`,
detaches the hub's event handlers and releases the connection. Cleanup failure
destroys the connection rather than returning a stale listener. New consumers
can later acquire another connection. Supply a pool whose checkouts are clean,
outside a transaction, and exclusively used by the borrower until release.

`stats` is an immutable snapshot of channel and consumer counts, connection and
reconnect status, and closure. Counts include pending registrations.
`maxChannels` and `maxSubscriptions` default to 128 and 1024 and must be positive
integers. Exceeding either limit rejects the new consumer. A fixed channel
snapshot per reconciliation also bounds server registrations during churn.
There is one reconciliation worker, at most one checkout in progress and one
backoff timer. Callbacks must avoid blocking the JavaScript thread.

## Delivery and errors

A synchronous handler receives notifications in driver order. Consumers run
independently: a thrown error or rejected promise is reported without preventing
peer delivery. `onError` receives connection, setup and handler errors. If it is
absent, the hub's fallback `onError` runs, or the default logger reports the
failure. An observer that throws or rejects is reported to the fallback; a
failing fallback is contained. Notifications carry raw payload strings, including
an empty string when no payload was supplied.

There is no payload queue. Each consumer can have at most one asynchronous
handler running. Notifications arriving while that handler is pending are
dropped and coalesced into `onResync('overflow')` after it settles. This bounded
policy makes asynchronous handlers appropriate for invalidation/refetch, rather
than processing every business event. Configure `onResync` when an async handler
needs a fresh snapshot after overload. Each consumer also has at most one
lifecycle observer running; repeated errors and resync requests coalesce into
bounded flags and the latest error. A slow or stuck callback affects its own
consumer. The fallback also admits at most one async call at a time.

## Reconnection and resynchronization

The default policy reconnects with exponential backoff from 100 ms to 30 seconds.
It destroys the lost connection, obtains a fresh one, and restores the channels
in a bounded membership snapshot before invoking `onReconnect()` followed by
`onResync('reconnect')` for previously ready consumers. Channels registered while
that snapshot is being restored can remain pending until a later reconciliation;
the reconnect callbacks do not certify readiness of those new subscriptions.
Await each new `subscribe()` promise before depending on its channel being ready.
This bounded snapshot lets established subscriptions resynchronize without waiting
for unrelated, continuously changing registrations. Readiness of new subscriptions
does not trigger these reconnect callbacks. A disconnect during initial establishment rejects pending
subscriptions; already ready consumers retry. `reconnect: false` ends consumers
on connection loss. Observer callbacks are serialized per consumer and do not
hold up physical cleanup.

No replay or exactly-once guarantee is made. Notifications during a disconnect
or while channels are being restored may be lost. PostgreSQL delivers NOTIFY
only after a sending transaction commits and can fold duplicate payloads within
that transaction. Use notifications to invalidate state and query the database
again. See [PostgreSQL NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html).

For a live query, subscribe before taking the initial snapshot, invalidate on
notifications, and invalidate again on `onResync`. The query callback should use
the ordinary typed client API so existing filters and projection policy still
apply. Retryable `onError` is diagnostic; it should not be mapped to a terminal
live-query error while reconnecting. A consumer can adapt this hub's standard
`Subscription` without importing another optional helper.

The [executable live-query application](../examples/notification-live-query/README.md)
composes both integrated optional entries. It owns explicit query handles and
one external-ownership hub, awaits `hub.subscribe` before each initial read,
and maps `onResync` to `invalidate` for reconnect and overflow. Its ordinary typed
query captures authorization scope. The native composed suite proves one
listener for 32 logical queries, committed versus rolled-back results, physical
backend termination with missed-state recovery, bounded burst/slow-reader
behavior, scoped filters/PII, sibling survival and teardown order. The runner
separates source-native proof from strict installed ESM/CJS example execution
against the supplied immutable archive on exact Node 22.16.0 and 24.10.0.

## Cancellation and ownership

An already aborted signal rejects without checkout. Later abort immediately
detaches that consumer and rejects pending readiness with an `AbortError`.
Unsubscribe and close are idempotent. They suppress future callback delivery;
an async callback already running cannot be cancelled by the hub, and its
settlement remains observed.

Native `pool.connect()` is not cancellable through this structural interface.
The hub rejects cancelled readiness promptly, but retains at most one outstanding
checkout and destroys an unused client when it eventually arrives. `close()`
waits for that settlement before pool teardown. Configure a finite native
connection timeout and query timeout; the hub cannot force an uncooperative
driver operation to settle. Unsubscribe also awaits current reconciliation.

Pool ownership defaults to `'external'`: the hub cleans its own listener but
never ends the pool. With explicit `'owned'`, only `close()` ends the pool, once,
after listener cleanup. Do not independently end the pool while the hub is active.
The hub is not automatically closed by another client's `disconnect()`.
Dispose all live-query handles before closing the hub, then drain any in-flight
reads that ignore cancellation before ending their pool. The executable example
owns that shutdown sequence; its hub never ends the caller-owned pool.

## Verification scope

Focused source tests use driver fixtures for failure injection and a native
PostgreSQL direct endpoint for fanout, commit/rollback effects, concurrent
membership changes, callback failure, physical backend termination, ordered
resubscription/resync, queued-checkout cancellation and release/end ownership.
The native prerequisite uses the repository's `TURBINE_REQUIRE_ENGINE=postgres`
gate; missing `DATABASE_URL` then fails instead of counting skipped tests as passes.

```sh
node --import tsx --test src/test/notification-hub.test.ts
TURBINE_REQUIRE_ENGINE=postgres DATABASE_URL=postgresql://... \
  node --import tsx --test src/test/notification-hub-native.test.ts
```

The original scoped fixture runners exercise an owned local PostgreSQL service
and strict installed ESM/CJS consumers with staged export wiring, including
omission and fault controls. That staged evidence is separate from the integrated
package export and retained-archive checks. Local native results do not certify
provider hosting, PgBouncer,
WebSocket drivers or edge runtimes. This API adds no durable storage, replay,
browser push server, cross-engine subscription or performance parity claim.
