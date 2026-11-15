# Native MySQL streaming resource evidence

This opt-in workload observes actual mysql2 callback streaming and Turbine's
public `findManyStream` and `findManyStreamBatches` (the native `streamBatches`
route). It measures **source execution**, not execution of a packaged release.
The selected archive is fingerprinted as an inherited reference and explicitly
marked unexercised. No remote endpoint is accepted. Native service setup and
cleanup reuse `../mysql-preparation/native.mjs` without changing that helper.

The default campaign has 44 independently isolated child processes per
runtime/mode: 176 samples across **exact Node22.16.0 / Node24.10.0**, native
**MySQL8.4.0**, and default / `ANSI_QUOTES,NO_BACKSLASH_ESCAPES` startup modes.
The two Turbine-created-pool lifecycle controls are labeled separately: that
factory adds `NO_BACKSLASH_ESCAPES` by contract, so their effective mode can
differ from server startup mode. Ordinary comparisons inject the same flags
and preserve the startup mode. No session setting is issued by this harness.

| Scenario | Selected rows / payload | Consumption and context |
| --- | --- | --- |
| Scaling | 129, 1,025, 4,097; 256 ASCII payload bytes each | Three stream arms, fast and slow; one explicitly materialized reference per size |
| Large row | 17; **131,072 payload bytes per row**, untruncated | Three stream arms, slow; batch size 8 |
| Early return | 1,025; 256 payload bytes each | First public row or first native/public batch; standalone pool checkout |
| AbortSignal | Finite 8-row view with server `SLEEP(0.03)` per row | Observe actual running query from a separate session, then abort a pending pull |
| Driver error | Missing fixture table | Actual native error, then ownership/reuse probes |
| Ambient transaction | 1,025; early return | Caller holds physical connection; update 7; own view 7 / independent observer 0; commit versus outer rollback |
| Transaction abort | Same finite slow view | Uncommitted update is rolled back by socket destruction; independent observer verifies 0 |
| Factory ownership | 129 | Turbine owns its pool and disconnect closes it |

The normal batch request is 32. Slow consumers wait 2 ms after each 32 selected
rows (8 for the large-row case), including the final partial interval. Row and
batch APIs therefore get the same row cadence. A row API's actual delivery unit
is one row, even when its native batch request is 32. Reports retain every
actual batch's row and complete canonical UTF-8 payload byte count, the total
and maximum whole-row bytes, and the full independent value digest. Canonical
payload bytes are an application representation, **not MySQL wire bytes**.
Socket bytes are a separately labeled cumulative observation.

## Reproduce

Install the repository's locked development dependencies. Nothing is added to
mandatory runtime dependencies. These cheap guards require only Node builtins
and run on Node20/22/24/26:

```sh
node --test benchmarks/mysql-streaming/harness.test.mjs
node benchmarks/mysql-streaming/omissions.mjs
```

Configure the owned native executable, its library search path if necessary,
both exact Node executables, and an existing local inherited reference archive:

```sh
export MYSQL_PREP_MYSQLD=/absolute/native-mysql/bin/mysqld
export LD_LIBRARY_PATH=/absolute/native-mysql-libraries
export MYSQL_STREAM_NODE22=/absolute/node-v22.16.0/bin/node
export MYSQL_STREAM_NODE24=/absolute/node-v24.10.0/bin/node
export MYSQL_STREAM_ARTIFACT=/absolute/existing/turbine-orm.tgz
node benchmarks/mysql-streaming/native.mjs /tmp/mysql-streaming-new-run
node benchmarks/mysql-streaming/audit.mjs /tmp/mysql-streaming-new-run
node benchmarks/mysql-streaming/controls.mjs /tmp/mysql-streaming-new-controls
node benchmarks/mysql-streaming/audit.mjs /tmp/mysql-streaming-new-controls
node benchmarks/mysql-streaming/late-signal.mjs /tmp/mysql-streaming-new-late-signal
```

Output directories must be new. Exact native prerequisites are mandatory;
missing prerequisites refuse with a retained failed report, never a skip or a
substitute service. Optional `MYSQL_STREAM_CASES=00,01,02` selects a development
subset, explicitly marked `partial`. It cannot pass `validateCampaign` as a
complete matrix. Native children have 30-second deadlines with TERM/KILL
escalation; they run serially to limit contention. SIGTERM handlers finalize
reports and cleanup, then re-raise SIGTERM with native signal exit semantics.
Reports are checkpointed before cleanup, and secondary finalizer failures do
not replace the original failure or suppress subsequent cleanup.

`controls.mjs` runs six executable faults on both exact runtimes: actual
materialization presented as streaming, unintended transaction commit instead of rollback, omitted
AbortSignal, false session-cleanup reporting, a finalizer failure after actual
cleanup, and SIGTERM during an observed running request. It requires the
intended refusal, failed report, independent database/session cleanup and exact
SIGTERM exit for interruption. Structural guards additionally reject truncated
payloads, wrong projections/order, omitted rows/batches, missing ownership,
missing fingerprints, missing backpressure, and premature/improper cancellation
claims. Their synthetic inputs are explicitly test models, not native evidence.

Successful sample, campaign and service admission also refuses retained failure,
interruption or cleanup diagnostics. Each batch's canonical bytes are checked
against its complete ordered rows in one linear pass. The ten named server
counters must reconcile with their recorded deltas, and sampled peak RSS must
cover both endpoint observations. These consistency checks do not establish a
total-memory bound. The historical corpus is revalidated without rewriting its
observations or treating validation as a new native measurement.

Driver loading is anchored with `createRequire(root/package.json)`. Both raw
and production optional-peer resolution must name the same real file and root
lock version. Reports retain entry/package/index/lib byte hashes, and every
observed physical connection and command must be an instance of those resolved
classes. A dependency-free isolated shadow-install regression proves a nested
benchmark mysql2 cannot replace the measured raw driver.

`late-signal.mjs` sends real SIGTERM during owned server shutdown, separately
on both exact runtimes. It requires failed service/campaign reports, stops
before the next mode, and preserves SIGTERM after cleanup/log flush. This
wrapper rechecks interruption after the read-only helper returns; it does not
change that helper.

The controller opens a separate native session and independently queries
`PROCESSLIST` and `information_schema.SCHEMATA` after **every** worker exits.
`audit.mjs`, run as a separate invocation after the campaign, probes each saved
initialization/server/worker PID and process group, TCP port, datadir, socket,
lock and pid file. Failure/interruption controls undergo the same probes.
Owned service identities and individual reports survive cleanup. A forged
cleanup flag cannot substitute for the controller's actual SQL probes.

The dependency-free guards run in the existing Node20/22/24/26 unit job.
No new CI job or budget increase is required. Larger million-row, concurrent,
network-delayed, cold-cache and sustained profiles are **unrun**. They need
separate resource planning and repeated observations before any general claim.

## Interpreting the observations

* Every result is checked against independently generated exact ordered values,
  with boolean, unsafe bigint, decimal, JSON, UTC datetime, binary and Unicode
  decoding. Raw mysql2's numeric tinyint is checked before explicit canonical
  boolean normalization. SQL is checked against an independent exact projection,
  table and order oracle. Transaction effects are independently read.
* The driver audit observes actual Query command class/method, callback versus
  event delivery, native field/row/end/error events, `_rows` retention,
  pause/resume/destroy calls and physical connection IDs. A process-local
  Readable push probe records actual high-water marks and maximum queued row
  length. These version-pinned observations can reveal buffering beyond one
  high-water mark. High-water marks are thresholds, not universal byte caps.
* Early return and abort have different costs. The raw arm explicitly resumes
  and drains unfinished native wire results. Turbine drains an unfinished result
  in a caller transaction, preserving that connection and uncommitted effects;
  outside a transaction it may discard the checkout. Reports retain observed
  wire rows and command settlement, return latency and socket destruction.
* Socket abort is **not an acknowledged server `KILL QUERY`**. Cancellation
  records client settlement separately from residual session observations until
  finite server work settles. No immediate server cancellation is certified.
* Each arm gets its own child, fresh fixture and pool/connection. Memory before
  and after includes the process's own source loader/driver/runtime baseline;
  sampled RSS can miss peaks and process maxRSS includes imports and seeding.
  Timings include instrumentation and exact row checks, and are not fair
  microbenchmarks for ranking query execution. No forced GC is performed.
* Process RSS/maxRSS proves no global native, driver, allocator or server bound.
  The workload also records server RSS, sort/temp-table/global statement and
  byte counters, EXPLAIN JSON, statement count and configured sort/read/network/
  packet/InnoDB buffers. Global counter deltas include observer overhead; the
  server cache persists across serial arms and runtime runs. Primary-key order
  generally needs no filesort. These facts do not bound every MySQL allocation.
* Driver lead counts emitted wire rows ahead of delivered application rows;
  packets already being parsed can add rows after pause. Neither a batch-size
  bound nor a sampled RSS plateau proves a total byte bound. The large-row case
  deliberately exceeds the scalar payload shape; no row is truncated.

Portable committed reports live in `results/*.json.gz` with a SHA256 manifest.
Read them with Node `gunzipSync` from `node:zlib`; the native JSON remains
accepted by `validateCampaign`. Exact unredacted commands and logs remain in
the local campaign directory. Checkout and Node executable paths are redacted
only in portable copies.

Committed results are branch evidence tied to their recorded source head and
hashes. They are not integrated-head results, a speed/memory winner, a global
plateau, broad engine parity, or production certification. SQL Server is not
part of this workload.
