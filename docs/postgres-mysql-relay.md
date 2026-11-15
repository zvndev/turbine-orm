# Fixed PostgreSQL to MySQL order relay

The [application](../examples/postgres-mysql-relay/application.ts) composes the
existing [PostgreSQL](postgres-durable-replay.md) orders/outbox/checkpoint protocol
and [MySQL](mysql-durable-replay.md) transactional inbox/mail projection. Their
full pool, durability, encoding, isolation and ownership prerequisites apply.
There is no additional package export or generic transaction/replay API.

## State and identity contract

PostgreSQL locks `(tenant,binding)` through page delivery and checkpoint COMMIT.
For each ordered event the relay awaits MySQL `deliverToInbox(binding,event)`.
That separately committed transaction serializes the projection row, uses a
current locking inbox read, checks the full private payload, and atomically
inserts a receipt plus increments the projection. Both `true` (new receipt) and
`false` (identical receipt) are successful commit acknowledgements. Only then
may the PostgreSQL callback complete. An incompatible event, conflicting reused
ID, rollback or failed/uncertain response never becomes skip/dead-letter success.

| Failure point | Reconciliation |
| --- | --- |
| Before target commit | Source checkpoint remains; retry from it. |
| Target commits, response lost | Source remains unacknowledged; target compares the receipt on retry. |
| Process dies between commits | Reopen both applications; source redelivers, target deduplicates. |
| Successful prefix then later failure | Entire source page rolls back; each target prefix receipt deduplicates. |
| Source commits, response lost | Read the current durable checkpoint; it may already have advanced. |

`sourceHistoryId` is a required canonical lowercase UUID asserted by the
deployment operator for exactly one PostgreSQL database/schema history. It stays
stable across process restarts. `consumer` is 1..27 ASCII letters, digits,
underscores or hyphens. The exact, injective binding is
`sourceHistoryId + '_' + consumer` (at most 64 characters), used as both the
source checkpoint consumer and destination consumer. Tenants retain their exact
1..64 ASCII key strings. There is no case folding, truncation or hash collision.

The deployment must allocate a new history UUID for unrelated databases/schemas,
forks, restores or resets that can reuse event IDs with a different history.
The UUID is an operator assertion, not automatic database authentication or a
durable registry proving a pool points to that history. Reusing it can alias
receipts; deleting target receipts or changing it can repeat effects. Authenticate
tenant/consumer access before calling the example. No notification authenticates
a request. Ordinary parallel instances with the same binding serialize on the
source checkpoint; distinct consumers and tenants remain independent.

## Exact common domain

| Field | Refused outside this domain |
| --- | --- |
| Event/order IDs | Canonical lowercase UUID text |
| Quantity | Nonnegative signed int8 decimal string, at most 9223372036854775807 |
| Amount | Nonnegative decimal text, up to 30 integral and 12 fractional digits; scale retained |
| occurredAt | Actual canonical UTC timestamp, years 1000..9999, exactly six fractional digits |
| Title/body | Valid UTF-8 without NUL or null; copied Buffer; combined at most 65536 bytes |
| Position | Positive signed int8 decimal string, retained only as source ordering/checkpoint state |

The source accepts broader scope and year ranges. This relay refuses those
values, including on persisted delivery, without acknowledging them. It does
not silently map scopes, round decimals/microseconds, or convert to JavaScript
numbers/Dates. Caller command properties are captured once and bytes copied
synchronously before admission; delivered values are independently captured.
The target receipt stores every command field including body hex in its private
payload. Source position is not part of that command identity. The source writer
protocol guarantees a unique position for a given tenant/event ID.

## Bounds, errors and lifetime

| Bound | Value |
| --- | --- |
| Relay operations | 8, no additional waiting queue |
| Target page wrappers | 8, including retained failed-close wrappers; opened lazily on first delivery |
| Source batch | Default 16, 1..32 |
| Whole callback page | 2000ms, using the existing source callback deadline |
| Target SQL | Default 2500ms, 1..3000 |
| Operation abort deadline | Default 6000ms, 1..10000 |
| Reconciliation | Default 4, 1..64 batches; interval default 250ms, 10..2000 |

All numeric options reject NaN, infinity, fractions, unsafe integers and values
outside their caps. Caller PG checkout/query/statement timeouts must be finite
positive values at most 3000ms. The unchanged target requires its bounded
nonqueued native pool, socket termination/settlement protocol and server limits.
Do not concurrently mutate caller pool settings or replace its native methods.

An overall deadline requests cancellation through the source and target signals.
It is not a hard wall-clock completion promise: finite checkout, SQL, rollback
and cleanup may follow it. No relay resource promise is abandoned in a race.
Each page opens its own target application wrapper on first delivery and checks
its server/database identity against the startup wrapper. It closes that page
wrapper before returning, including on failure. This drains the target's private
native SQL/acquisition promises as well as its public delivery promises. When
the source callback wait expires, the relay still owns and awaits this bounded
native settlement before freeing its operation slot. A failed-close wrapper
stays retained under the eight-wrapper cap and participates in final close.
A late target commit can survive source rollback; the next attempt deduplicates.
If page-wrapper close fails after both commits, the relay call can reject even
though the source checkpoint advanced. Reconciliation still reads that durable
checkpoint. An earlier operation failure, including a falsy reason, remains
primary when wrapper close also fails; final close reports retained close errors.
Original thrown/rejected values propagate, including falsy reasons; MySQL's
existing `Unacknowledged` retains its original cause and uncertainty flag.
The abortable polling timer also propagates the original abort reason, including
falsy values. No automatic retry infers rollback from an error.

Async context refuses recursive operations for the same source/schema/consumer/
tenant across relay objects and ESM/CJS copies in one Node realm. Close from the
same relay operation is refused before it can await itself. Unrelated callers
can compete. Reconciliation serially calls bounded drains against the current
checkpoint and waits between pages, including empty pages; it retains no event
queue. Timers are scheduling only and never acknowledge anything.

Startup validates options before constructing wrappers and closes its source
wrapper if target opening fails. Caller pools survive failed startup. `close`
seals admission synchronously, aborts work, awaits tracked operations and target
settlements, then closes both owned application wrappers. It never ends caller
pools. The caller owns provisioning, migrations, retained history and final pool
closure. Fresh-only `initialize` is not a two-engine atomic migration; MySQL DDL
implicitly commits and partial setup must be inspected by its owner.

Attempts are at least once, conditional on retrying and retaining both stores.
The concrete transactional target deduplicates its inbox/projection effect.
There is no distributed transaction, database-log CDC, or exactly-once arbitrary
external-effect claim. Local native evidence does not certify hosted services,
unsupported drivers, performance or package support expansion.

The scoped native fixtures use PostgreSQL 18.6 and MySQL 8.4.0 in ordinary and
NO_BACKSLASH_ESCAPES modes, exact Node 22.16.0/24.10.0, and installed ESM/CJS
consumers of the pinned normal package. Installed pg 8.23.1 and mysql2 3.24.6 are
distinct from source-lock pg 8.22.0 and mysql2 3.24.5. Close-failure controls
inject the reported failure after actual native cleanup, then check primary
errors and retained-wrapper admission. They do not claim a physical driver
cleanup failure was produced. Commit-response controls throw/delay after an
actual server commit; they do not claim network packet fault injection.
