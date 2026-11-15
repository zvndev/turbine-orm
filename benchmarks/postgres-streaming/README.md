# Native PostgreSQL cursor resource evidence

This opt-in workload executes the current branch's public `findManyStream` and
`findManyStreamBatches` against an owned, disposable **PostgreSQL 18.6** service.
The comparison is a bounded raw `pg` SQL cursor, not a materialized result split
into arrays. Execution uses an immutable source bundle. An installed package is
**not executed**, and no packaged-release or integrated-head claim follows.

Each exact **Node 22.16.0 / 24.10.0** campaign runs 18 serial workers. The three
arms are raw cursor batches, public rows, and public batches. Arm order alternates
between profiles; workers use fresh databases and max-one-connection pools.

| Profile | Rows | Requested cursor batch | ASCII payload bytes per row | Consumption |
| --- | ---: | ---: | ---: | --- |
| Small | 257 | 32 | 256 | Full drain |
| Large | 4,097 | 32 | 256 | Full drain |
| Slow | 4,097 | 32 | 256 | 2 ms after each 32 rows and final partial batch |
| Wide | 17 | 8 | 131,072 | Full payload, 2 ms after each batch |
| Early | 1,025 | 32 | 256 | First public row or first raw/public batch, then return |
| Abort | 65 | 8 | 256 | First 8 rows, abort a pending second FETCH |

All arms select the same independently specified columns and `ORDER BY id ASC`.
Every delivered value is checked against an independently constructed oracle:
boolean, unsafe bigint string, exact numeric string, JSON, UTC timestamptz Date,
binary, Unicode and the entire payload. Each JS delivery's exact row count and
canonical UTF-8 bytes are retained. A rolling full-value digest avoids retaining
all delivered rows. Raw PostgreSQL values and public values must agree before
any reporting normalization; no type parser is installed by the harness.

## Run

Install the root locked development dependencies. No new dependency is needed.
Dependency-free guards run on Node 20/22/24/26:

```sh
node --test benchmarks/postgres-streaming/harness.test.mjs
node benchmarks/postgres-streaming/omissions.mjs
```

Provide a local native installation prefix containing `bin/postgres`,
`bin/initdb`, `share/postgresql`, and `lib/postgresql`. The executable and live
server must both identify exactly 18.6. No existing endpoint or datadir is
accepted. Use the exact Node executables, with a **new** output directory each
time, and keep campaigns serial:

```sh
export PG_STREAM_PREFIX=/absolute/postgresql-18.6
/absolute/node-22.16.0/bin/node benchmarks/postgres-streaming/native.mjs /tmp/pg-stream-22
node benchmarks/postgres-streaming/audit.mjs /tmp/pg-stream-22
/absolute/node-22.16.0/bin/node benchmarks/postgres-streaming/controls.mjs /tmp/pg-stream-controls-22 /tmp/pg-stream-22

/absolute/node-24.10.0/bin/node benchmarks/postgres-streaming/native.mjs /tmp/pg-stream-24
node benchmarks/postgres-streaming/audit.mjs /tmp/pg-stream-24
/absolute/node-24.10.0/bin/node benchmarks/postgres-streaming/controls.mjs /tmp/pg-stream-controls-24 /tmp/pg-stream-24
```

Missing native prerequisites retain a failed report and exit nonzero, never a
skip or substitute server. Existing report destinations refuse before writing.
The output contains per-worker reports, campaign JSON, server log, source bundle,
and its exact source/lock/driver provenance manifest. Run `audit.mjs` as a
separate invocation after each campaign. Failure controls independently repeat
the same resource audit after each refusal.

The existing unit job can run `harness.test.mjs` and `omissions.mjs`; no new job,
performance threshold, dependency, budget, or coverage floor is required. Native
campaigns remain an explicit opt-in operation.

## Ownership and route observations

Every stream receives a signal, including the non-abort profiles. This uses the
existing public cancellation contract to bypass speculation and require the
current native cursor route. Both arms use plain BEGIN/read-committed/read-write
transactions, unnamed SQL, max-one-connection pools, identical timeouts and no
startup overrides. The harness disables the stream idle timer in both routes;
the actual transaction settings are read back on the owner. Server startup keeps
fsync, synchronous commit and full-page writes enabled. Settings, executable
hashes, actual arguments and exits are recorded.

The worker observes actual `pg` Client and Query instances, protocol `dataRow`
events, cumulative field bytes and maximum retained result rows per FETCH. The
controller independently reconciles each BEGIN/DECLARE/FETCH/CLOSE/settlement
with PostgreSQL's own `log_statement=all` log. FETCH quantities must be exactly
the requested number. `FETCH ALL`, speculative SELECTs and buffered full-result
substitution fail admission. This is a **JavaScript pg driver** workload, not
the optional `pg-native` addon. Event row observations are not relabeled as
independent server row counters.

After each JavaScript delivery, the observed FETCH count must not exceed the
number of batches needed for the delivered rows. Draining every bounded FETCH
into retained arrays before the first delivery therefore fails as well. This
finite demand check does not establish a global memory bound. The source
manifest must include exactly the executed inputs recorded by esbuild's build
graph; an omitted executed module cannot pass through a minimum input count.

`pg_cursors` is session-local. It is queried on the actual checked-out physical
owner, including `pg_backend_pid()`, portal count, declaration, holdability and
scrollability. A different connection independently reads `pg_stat_activity` to
verify that the same database/backend owns an idle transaction while the
consumer is suspended. These observations use distinct sources with explicit
visibility limits; another session's empty `pg_cursors` is never used as proof.

The abort fixture has a finite, volatile row predicate that calls
`pg_sleep(0.03)`. Before aborting, the independent observer must see the second
FETCH active in `PgSleep`. The pending pull must reject and the actual driver
error must contain server cancellation code 57014. Raw pg sends its native
protocol cancel only to an active query, waits for settlement, then rolls back.
Turbine retains its current cancellation and checkout behavior. No transaction
queue, parser, production cancellation or core code is changed.

After full drain, early return and abort, a subsequent checkout checks zero
portals, runs a native query, and then runs a public lookup. Normal/early cases
must reuse the same backend. Abort may replace the physical connection, which
is reported rather than equated with same-backend reuse. The observer verifies
the reused connection is idle with no transaction. After every worker exits,
the controller queries both its complete registered backend PID list and its
database name. Both must be absent. A worker's cleanup flag cannot replace this
independent query.

Cleanup admission requires complete, unique process identities, the service
port and owned absolute paths, and registered observer/worker backend identities.
Saved audit arrays must match those registries exactly. Missing identities or
empty backend lists cannot stand in for observed absence. Earlier reports that
lack the complete build graph or ownership registry do not satisfy this contract.

## Failure controls and limits

`controls.mjs` requires a completed positive native campaign on the same exact
runtime. Ten actual native faults exercise FETCH ALL, buffered SELECT, omitted
AbortSignal, primary error, omitted database cleanup, worker finalizer failure,
combined primary/finalizer failure, external worker SIGTERM during FETCH,
service finalizer failure, and an actual controller SIGTERM during service
shutdown. Intended assertion messages, exact exits and independently audited
cleanup are required. A database-cleanup omission is recorded as a real leak
before the controller removes it; it never becomes a passing sample.

Reports checkpoint atomically from startup. Primary failures stay sticky through
cleanup; secondary failures are retained separately. Signals retain failed JSON,
clean up, then re-raise the OS signal. Workers have 30-second deadlines. Owned
init/service/worker process groups use bounded INT/TERM/KILL escalation. Each
group, service port, datadir and socket is independently checked after teardown.
Disposable omission staging is removed, and controls must fail their intended
assertion rather than an import or syntax error. The synthetic guard model is
explicitly not native evidence.

RSS is sampled every 2 ms plus endpoints. JS heap, external and array-buffer
endpoint observations are retained. These are process observations, not a bound
on total native/server memory. PG field bytes exclude wire framing; canonical
payload bytes represent application values. Diagnostic elapsed time includes
exact-value checks, owner/observer probes, cancellation checks and deliberate
consumer delays. It is not a throughput ranking. Host load and runtime/server
identities are recorded; other host activity is uncontrolled.

These finite local runs do not certify global memory bounds, production network
behavior, concurrent transaction queues, million-row workloads, all PostgreSQL
versions, or any other engine. Native SQL Server evidence remains pending;
fixtures do not provide certification. No global speed, parity or winner claim
is made.
