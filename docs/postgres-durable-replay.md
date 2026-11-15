# Durable order replay on local PostgreSQL

The [runnable example](../examples/postgres-durable-replay/README.md) captures only
application order writes. Each write commits its business row, immutable outbox
snapshot and notification in one PostgreSQL transaction. Consumers resume from
a durable `(tenant, consumer)` checkpoint. Notifications are lossy wakeups; the
outbox is the source of truth. This composes existing public Turbine APIs without
changing the hub's overflow/resync behavior or introducing a library replay API.

## Schema and ordering

| Table | Key and role |
| --- | --- |
| `tenant_stream` | Tenant primary key and transactional bigint position |
| `orders` | `(tenant, order_id)` primary key; immutable example business order |
| `outbox` | `(tenant, position)` primary key; unique `(tenant, event_id)`; complete order snapshot |
| `checkpoints` | `(tenant, consumer)` primary key; last acknowledged position |

The schema is selected at application construction, validated as an ASCII
identifier and explicitly qualified in every application statement. Tenant and
consumer keys are bound values of 1 to 128 UTF-8 bytes. Authenticate these scopes
before calling the example. Notification payloads grant no authorization.
These raw, guarded transaction queries have explicit tenant predicates; they do
not inherit table-query middleware/global filters as an authorization policy.
Production deployments need appropriate database roles, migrations and business
authorization. `initialize()` is a one-time helper for a fresh example schema.

Append first creates/locks the tenant stream row, then checks an existing event
key, then allocates a position by updating that same row. The lock is held through
business insert, outbox insert, `pg_notify` and COMMIT. A transaction allocating
position N+1 must therefore wait for the transaction holding N to commit or roll
back. A rollback restores the allocation too. This makes a position checkpoint
safe without relying on sequence allocation order. A transaction that started
earlier but has not acquired the stream lock has no reserved position.

Ordering is ascending position within one tenant. There is no global tenant
order. All writers must follow this locking protocol, including duplicate-event
acknowledgements. External direct writes are neither captured nor covered by
the ordering proof. The fixture's notification-suppression injection is a
deliberate test fault, not another supported writer.

The stable event UUID is the producer's retry key. Duplicate keys are checked
after acquiring the stream lock and must match every command field exactly,
including bytes and decimal text. Conflicting reuse is refused. A new event ID
for an already-used order ID fails the business constraint and rolls back both
outbox and allocation. This example creates immutable orders; it does not offer
a generic arbitrary-write callback or transaction/session framework.

## Exact values and bounds

Commands contain lowercase UUIDs, nullable Unicode text, a nonnegative int8
decimal string, a bounded nonnegative numeric decimal string, a canonical UTC
timestamp with six fractional digits, and a Buffer. Decimal scale is retained:
`1.0` and `1.00` are distinct command representations. No rounded JSON comparison
or JavaScript-number conversion determines idempotency. PostgreSQL numeric has
no precision/scale rounding constraint here. Timestamps are read with a fixed
six-digit UTC formatter rather than decoded through a millisecond Date.

Each caller property is captured once and Buffer bytes are copied synchronously
before the first await. Invalid calendar dates, NUL and unpaired UTF-16 text are
refused. Raw outbox results are checked for their expected string/null/Buffer
types. Every callback receives its own copy; callback mutations cannot change
the private acknowledgement position, durable row or later callback values.

| Resource | Bound per application instance |
| --- | --- |
| Combined title and body | 65,536 bytes per command |
| Quantity | Nonnegative PostgreSQL int8 range, exact decimal string |
| Amount | Up to 30 integral and 12 fractional decimal digits |
| Read batch | Default 16, configurable 1 to 32 events, ascending indexed key scan |
| Active database operations / progress handles | 8 / 8 |
| Unsettled callbacks, including ignored cancellation | 8; further callback invocation refuses |
| Callback deadline | Whole batch, default 1,000 ms, configurable 1 to 2,000 ms |
| Reconciliation interval | Default 250 ms, configurable 1 to 2,000 ms |
| Local lock / statement / idle transaction timeout | 2,000 / 2,500 / 5,000 ms |

The caller must configure finite positive pool connection, query and statement
timeouts no greater than 3,000 ms. The example checks these settings without
altering caller defaults. Use enough pool capacity for a dedicated listener and
ordinary transactions. Bounds cover application-retained state and SQL reads,
not arbitrary allocations inside callback code, external service work, or disk
retention. Outbox rows and checkpoints are intentionally retained indefinitely;
pruning needs a separate policy covering every required consumer and retry key.

## Delivery and durable acknowledgement

`consumeBatch(tenant, consumer, deliver, signal)` locks the consumer checkpoint
row, reads one bounded page, invokes callbacks sequentially, and updates the
checkpoint in the same transaction. It resolves with the batch count only after
COMMIT acknowledgement. It holds the checkpoint lock across callbacks. Two
workers with the same consumer cannot silently skip each other's events;
contention can return a bounded lock timeout that the caller must handle.
Different consumers independently replay the same tenant's history.

Callback failure leaves the entire batch unacknowledged. The exact throw or
rejection is preserved, including `undefined`, `null`, `false`, zero and empty
text. An already successful callback prefix can repeat after restart/retry.
Same-consumer recursive drain from a delivery callback, even through a second
application object, is refused using async context before another lock wait.
Unrelated callers remain eligible to compete normally.

Delivery is **at least once**, conditional on retrying failures and keeping the
outbox/checkpoint store available and retained. External effects are not atomic
with checkpoint COMMIT. Use destination idempotency keyed by
`(tenant, consumer, eventId)` or an equivalent transactional destination protocol.
The native destination control records four callback attempts for two events
and uses an independent unique constraint to produce two raw destination rows.
This does not promise exactly-once external effects.

Callbacks receive an abort/deadline signal. A cancelled/timed-out callback cannot
later acknowledge its batch. The SQL transaction rolls back without awaiting an
arbitrary callback promise forever. Ignoring the signal may still complete an
external effect after rollback or after a competing retry has started. Invocation
order is ascending during a healthy batch; late external completion after
cancellation has no ordering guarantee. Ignored callbacks retain a counted slot
until they settle and are visible through `outstandingCallbacks`. `close()` does
not wait for them indefinitely. Callers own their callback's external resources
and must make them cancellable and bounded; never end a pool still used by such
external callback code. The fixture settles and audits every callback before exit.

An exception while awaiting COMMIT can mean that the server committed but its
response was lost. Producer retries must reuse the same event key and exact
values. Consumer retries must read the persisted checkpoint; they may find the
event already acknowledged or may replay it. An aborted caller can also lose
the response to a successful commit. The application does not infer rollback
from a rejected operation. Native fault controls throw after an actual server
COMMIT to reproduce application-visible lost responses for both producer and
checkpoint transactions. They do not claim a real network packet-fault test.

## Wakeups, progress and ownership

`watchProgress(tenant, consumer, deliver, signal)` composes the existing hub and
`liveQuery`. It subscribes before its first durable drain. Notifications,
reconnect/overflow resync, and a periodic timer invalidate the drain. Full pages
immediately request another bounded page. There is one active drain, one dirty
bit and at most one newest progress count per handle, with no event queue.

The returned `LiveQuery<number>` is a **coalescible progress observation**. Its
counts are not delivery messages or cumulative totals. A dirty snapshot can be
discarded after its checkpoint committed; nobody needs to call `next()` to
acknowledge anything. The native control forces this race and observes a later
zero-count snapshot while the earlier delivered event remains checkpointed.

Startup/restart drains persisted state, including notifications missed while no
process was listening. Periodic reconciliation recovers a deliberately omitted
notification; reconnect resync covers listener gaps. Exact notification history
is neither retained nor needed. A callback/query failure terminates the affected
progress handle and rejects its lifecycle promises. Handle the exact failure,
dispose it, then explicitly retry the consumer. Recoverable hub errors remain
diagnostics. Existing hub overflow/resync semantics are unchanged.

The caller owns the pool and supplies an explicit `direct` or `session-pool`
endpoint assertion. Transaction pooling/stateless HTTP cannot provide LISTEN.
The application owns its Turbine wrapper, hub, timers and progress handles.
Stop admission and call `close()`; it aborts handles, bounds callback waits,
drains finite SQL and closes the hub/wrapper. It never ends the external pool.
The finite demo then removes its own schema and ends its pool. SIGTERM exercises
the same order, including cancellation of a delivery in progress.

Evidence is scoped to local PostgreSQL 18.6, exact Node 22.16.0/24.10.0 and the
recorded node-postgres versions. The generated-client control strictly compiles
and executes an exact UUID/nullable-text/numeric projection; ordinary generated
Date/int8 mappings are not promoted into a microsecond/unsafe-integer guarantee.
Full exact event precision belongs to the explicit workflow representation above.
There is no database-wide CDC, logical replication, hosted gateway, non-PG
certification, benchmark result or support-tier promotion in this example.
