# Durable order replay on local SQLite

The [runnable example](../examples/sqlite-durable-replay/README.md) atomically
commits an immutable business order, outbox snapshot and tenant position through
existing public Turbine transactions. Each consumer resumes from its own durable
checkpoint. An independent destination demonstrates idempotent external effects.
This is a fixed application protocol, with no shared library change.

## Native transaction and ordering contract

The caller lends a persistent `node:sqlite` handle configured with `journal_mode=WAL`,
`synchronous=FULL`, and `busy_timeout=0`. Construction validates these native
settings and refuses incompatible values without changing caller defaults.
The demo sets them only on handles it creates and owns.

Every append or consume uses `turbineSqlite(handle,...).transaction`. Immediately
after native `BEGIN`, its first statement updates the fixed singleton admission
row, before any read or callback. This acquires SQLite's actual database writer
lock through COMMIT or ROLLBACK. Competing independent handles and processes
therefore receive finite busy refusal, including duplicate-event acknowledgements.
There are no PostgreSQL row locks, sequences, leases or process-local ordering
assumptions. All writers serialize across the entire database, including different
tenants and consumers. A consumer holds this writer lock across delivery callbacks;
slow callbacks block appends until cancellation, deadline or completion.

| Fixed table | Durable role |
| --- | --- |
| `replay_admission` | Singleton native writer admission, never a sequence |
| `replay_stream` | Tenant primary key and transactional INTEGER position |
| `replay_orders` | Immutable business rows keyed by `(tenant, order_id)` |
| `replay_outbox` | Complete snapshot keyed by `(tenant, position)`; unique `(tenant, event_id)` |
| `replay_checkpoints` | Last acknowledged INTEGER keyed by `(tenant, consumer)` |

Positions allocate only after admission, in the same transaction as both inserts.
The update guards `position < 9223372036854775807` **before arithmetic** can
overflow INTEGER into SQLite REAL. Raw results explicitly `CAST(position AS TEXT)`;
positions never pass through a JavaScript number. Rollback restores allocation.
Position N+1 cannot commit ahead of N because the database has only one writer.
Order is per tenant, ascending position; no global tenant order is exposed.

Event identity is `(tenant, eventId)`. A duplicate must match every captured value
and every byte exactly. Decimal scale matters: `1.0` differs from `1.00`. Conflicting
reuse refuses. A fresh event for an existing business order refuses and rolls back
the allocation. Tenant and consumer are separate bound SQL values and composite
database keys, without concatenated identity strings. Authenticate both before
calling the application. Explicit tenant predicates do not inherit table-query
middleware or global filters. Direct writes bypass capture and violate the protocol.

`initialize()` creates a fresh fixed schema in one transaction. Existing tables
cause refusal. Production schema evolution and retention policies belong to the
application; this example has no arbitrary write callback, reset or pruning API.

## Exact application values

Each command property is read once and bytes are copied synchronously before the
first await. Callbacks receive fresh event and byte copies. Private positions and
the fully decoded bounded page are never entrusted to callback mutations.

| Value | Explicit representation and limit |
| --- | --- |
| Tenant, consumer, event and order identity | Nonempty, well-formed UTF-8 text, at most 128 bytes, no NUL |
| Title | Nullable UTF-8 text, at most 32,768 bytes, no NUL/unpaired surrogate |
| Quantity | TEXT: canonical nonnegative integer decimal, at most 30 digits |
| Amount | TEXT: nonnegative decimal, at most 30 integral and 12 fractional digits; scale preserved |
| Occurred time | TEXT: real calendar UTC `YYYY-MM-DDTHH:mm:ss.ffffffZ`, six exact fractional digits |
| Body | BLOB: copied Uint8Array, at most 32,768 bytes, including empty bytes |
| Position/checkpoint | Checked signed int64 INTEGER, exposed as decimal text |

No REAL/numeric affinity or generic Date/integer decoding improvement is implied.
The stored/read oracle compares complete values and ordering. Generated-client
checks project these TEXT/BLOB fields; ordinary generated INTEGER mappings are
not claimed to preserve arbitrary int64 values.

## Delivery, cancellation and uncertain outcomes

`consumeBatch` acquires native writer admission, creates/reads the checkpoint,
reads one ascending indexed page, invokes callbacks sequentially, then stages
the new checkpoint in the same transaction. It returns a count only after COMMIT.
Same-consumer contention cannot skip an acknowledged prefix. Different consumers
replay independently but still contend for SQLite's single writer.

Any callback throw or rejection rolls back the entire batch, preserving the exact
reason, including `undefined`, `null`, `false`, zero and empty text. Previously
successful external effects may repeat. There is no automatic consumer retry.
Delivery callback reentry into this database, including through an independent
application instance or ESM/CJS copy, is refused through shared async context.
Callbacks must use a separate destination database or external service.

An operation deadline and caller signal are checked before delivery, before
checkpoint staging, after staging, and before the transaction body returns.
Cancellation during a pending asynchronous callback rolls back without waiting
forever. A callback ignoring cancellation can still finish an external effect
later. Its counted slot remains occupied until it actually settles; late settlement
cannot advance the private acknowledgement. External completion order after
cancellation is not guaranteed. Synchronous callback code must yield to the event
loop: a timer cannot preempt a blocking JavaScript callback or operating-system I/O.

Cancellation racing an already dispatched COMMIT or an error observed after
COMMIT does **not** prove rollback. Durable state may already be committed.
The native fixture injects errors after a real COMMIT and aborts after a real
checkpoint COMMIT, then reconciles from another handle. These are local
post-COMMIT application fault controls, not a network or power-failure test.
Producer retries reuse the same event identity and exact command. Consumer
retries first read durable checkpoints and accept possible prefix redelivery.

`appendWithAdmissionRetry` captures its fixed command before awaits and retries
only `AdmissionBusyError` from the first admission statement, at most four attempts
with 10 ms waits. It accepts no callback. It never retries arbitrary transaction
errors or uncertain COMMIT. Other busy/rollback/closed errors remain explicit
refusals. Handle them with an application policy; do not wrap consumer callbacks
or COMMIT uncertainty in a generic automatic retry loop.

Delivery is **at least once**, conditional on retrying and retaining the stores.
An external effect cannot commit atomically with the source checkpoint. The
separate destination uses a unique `(tenant, consumer, eventId)` insert as its
idempotency protocol. Four attempts for a failed two-event batch produce two
complete destination rows. A real destination must provide an equivalent
durable idempotency key. This is not exactly-once external delivery.

## Polling, limits and caller ownership

`reconcile` is a local async generator. It drains a bounded batch on startup and
between finite polling waits, including after reopening a database and when no
wakeup was emitted. A full page requests the next page when the caller asks for
another observation. The generator has backpressure: a suspended caller also
suspends reconciliation. Counts are coalescible progress observations; the durable
checkpoint COMMIT acknowledges work. Discarding or never requesting a count cannot
undo a committed checkpoint. No hub, native CDC or cross-process notification
guarantee is provided. Explicit errors terminate that reconciliation handle.

| Per-instance retained resource | Bound |
| --- | --- |
| Active database operation | 1; concurrent use refuses |
| Read/delivery batch | Default 8, configurable 1 to 32 |
| Whole operation deadline | Default 250 ms, configurable 1 to 1,000 ms |
| Unsettled callback invocations | Default 2, configurable 1 to 8, including ignored cancellation |
| Reconciliation handles | 2, including generators suspended at yield |
| Polling wait | Default 100 ms, configurable 1 to 1,000 ms; close/abort wakes it |
| Append admission retries | At most 4 attempts, each native busy wait 0, inter-attempt delay 10 ms |

The app has one cooperative exclusive lease on a supplied handle, shared across
its ESM/CJS copies. Callers must not use that same handle, change its pragmas,
start native transactions, instrument its methods or lend it to another library
while application work is active. Use independent handles for other work. Native
construction refuses a pre-existing transaction. Outbox/destination disk retention,
callback allocations and independently owned external resources have no automatic
quota; production applications must bound them separately.

`close()` seals admission, aborts the current operation, wakes polling waits and
waits for finite native transaction cleanup. It never closes the caller's handle
or waits indefinitely for an ignored callback. The caller may still query that
handle. Its application lease remains held while an ignored callback is unsettled,
then releases; a new app cannot conceal those outstanding callbacks. Return or
dispose iterators explicitly. Close does not destroy retained data.

Evidence is scoped to local default `node:sqlite`, exact Node 22.16.0 and 24.10.0,
installed ESM/CJS, strict positive/negative example/generated consumers and owned
process interruption/reopen controls. Optional better-sqlite3, earlier Node bands,
hosted engines, durability under actual power loss, database-wide CDC, benchmarks
and support-tier promotion are outside this bounded example.
