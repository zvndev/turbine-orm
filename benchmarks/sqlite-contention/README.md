# SQLite WAL contention and iterator ownership

A reusable held-out workload for Node's native SQLite and the public Turbine
SQLite query/iterator route. Each arm launches a writer and reader as separate
OS processes with separate `DatabaseSync` handles. Parent request/reply barriers
establish every interleaving; promises around one synchronous handle do not
stand in for native concurrency.

From a checkout with root-lock dependencies installed:

```sh
npm ci
node --test benchmarks/sqlite-contention/harness.test.mjs
node benchmarks/sqlite-contention/bundle.mjs --out /tmp/sqlite-contention-bundle.mjs
node benchmarks/sqlite-contention/run.mjs --bundle /tmp/sqlite-contention-bundle.mjs --out /tmp/sqlite-contention.json --rounds 4
node benchmarks/sqlite-contention/controls.mjs --bundle /tmp/sqlite-contention-bundle.mjs --out /tmp/sqlite-contention-controls
node benchmarks/sqlite-contention/audit.mjs --out /tmp/sqlite-contention-audit.json /tmp/sqlite-contention.json
```

For auditing the fault controls too, append their nine campaign report paths
listed in `controls.json`; exclude the controls summary itself. Reports and bundles
are local retained artifacts, outside tracked source. Run campaigns sequentially
on exact Node 22.16.0 and 24.10.0. Pure guards also run on Node 20 and 26.
Missing `node:sqlite`, `columns()`, native iteration, `return()` or `isTransaction`
is a required-run failure. There are no capability skips. No migration writer
is exercised, so this does not certify Node22 migration support.

The source snapshot bundle uses unmodified public factory/query code, not a
published package or the CLI/MCP dispatcher. It includes every source-input
hash, root lock hash, root-resolved esbuild/pg versions, resolved paths, entry
hashes and locked integrity. The runner requires the factory/core source inputs, verifies every declared hash,
and re-resolves the driver/tool identities against the root lock before opening
a fixture. The local manifest is trusted build metadata, not an artifact signature.
Each Turbine worker records the actually loaded pg module from the module cache.
SQLite itself is the `node:sqlite` builtin, identified by the runtime executable
hash plus `sqlite_version()` and `sqlite_source_id()`. The separate benchmark
package's dependencies do not choose the driver. The generated bundle manifest
has local absolute paths and should stay local. This is branch evidence,
not final integration evidence.

Each round reverses native/Turbine order. A route sample is a complete scenario
on a fresh disposable file. Four rounds mean eight route samples and sixteen
worker processes. There is no warmup or speed ranking. Both routes use WAL,
FULL synchronous mode, foreign keys, 120 ms busy timeout and disabled automatic
checkpointing. Every route performs matching actual SQL, effects and transaction
boundaries, including the exact iterator SELECT. Reports compare native execution
audits, not just a list of intended SQL. The script refuses odd round counts.

The scenario checks:

- A reader explicitly begins and reads a snapshot before a writer commits. A
  second read retains that snapshot; rollback exposes the committed rows.
- A held `BEGIN IMMEDIATE` writer updates and inserts uncommitted rows while
  another process tries `BEGIN IMMEDIATE`. The contender must fail busy after
  the configured native timeout. A failing statement leaves its handle usable.
- Writer rollback hides both uncommitted effects. Expected rows, count and sum
  come from independent constants, with direct native final-state verification.
- Identical SQL reads TEXT, then a fresh BOOLEAN declaration after writer DDL.
  Both native descriptions and decoded values must change. The native baseline
  explicitly decodes declared BOOL columns after stepping; this is an
  application policy, not an automatic DatabaseSync behavior.
- A public `findManyStream` with an un-aborted signal and batch size one uses
  the existing native iterator, avoiding speculative materialization. A
  suspended reader blocks a truncating WAL checkpoint after a separate writer
  commits. Early return releases it and the checkpoint succeeds. Actual native
  `next`/`return` calls are retained, and an `.all()` stream is refused.
- The Turbine iterator owns its handle: a same-client query remains pending
  until return, then yields the exact final rows. Native SQLite permits another
  statement on its handle; its matching query runs after return. This extra
  Turbine ownership check is not a matched latency comparison.
- Aborting between pulls produces AbortError, closes the native iterator and
  leaves the handle usable. Native controls explicitly check an AbortSignal
  between pulls. Native calls remain synchronous; no running step is interrupted.
- Disconnecting a Turbine client that wraps a caller-supplied handle leaves it
  usable. Each worker then closes its own handle and exits before file removal.

Every operation includes local monotonic start/end boundaries, elapsed time,
process CPU deltas, RSS/heap snapshots and process-local maximum RSS. Setup,
process launch and parent IPC are outside the workload operation measurements;
query wrapping, execution auditing and result normalization are inside. Ownership
checks include their intentional 20 ms observation interval. Resource snapshots
are per worker, not per query allocation or total memory. On Linux the native
high-water RSS may include the pre-exec process baseline. Do not sum worker
high-water marks. The parent records its own barrier send/receive times and
actual worker PIDs, groups, identities and exits. Local shared-host timings are
descriptive; WAL checkpoints do not establish disk-cold reads.

`controls.mjs` runs a positive campaign and eight isolated native fault controls:
omitted snapshot barrier, omitted rollback, attempted cleanup with live children,
child death, stubborn child, SIGTERM during teardown, cleanup error and command
deadline. Each negative run must fail for its specific reason, retain a failed
report and remove every owned fixture only after child exit. A stubborn child
must require bounded SIGKILL escalation. No tracked code is faulted. Pure guards
also reject contradictory reports, stale metadata, wrong results/resources,
materialized streams, missing cleanup and mismatched SQL.

Reports are atomically replaced throughout setup, workload, teardown and signal
handling. An initial failure survives later cleanup errors or signals. Partial
samples and worker identities remain in failed reports. Teardown attempts a
bounded graceful close, then TERM and KILL of only the owned child groups.
Removal requires both exit observations and independent PID/group absence.
`audit.mjs` first reconciles every completed or partial sample with unique cleanup
records and exact owned paths/worker identities, then performs a later read-only
PID/group/file check. Missing ownership or native trace evidence cannot establish
a passing report. The auditor never cleans up.
No service, port, socket, credentials or another lane's fixtures are used.

The dependency-free contention and query-cost report guards run in the existing
Node20/22/24/26 unit job. Native campaigns remain explicit local evidence;
passing structural guards does not certify native concurrency behavior.
