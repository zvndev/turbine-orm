# Native SQLite preparation and decoding workload

This standalone experiment measures the cost of preparing each ordinary query
against a **benchmark-local** bounded statement reuse candidate. The candidate
is not a production statement cache. It uses the repository's existing
dependencies and `node:sqlite`.
It neither starts services nor modifies package lifecycle/config/CI files.

From the repository root, with dependencies installed:

```sh
npm run gen:studio
/path/to/node-v22.16.0/bin/node --expose-gc --import tsx --test benchmarks/sqlite-preparation/workload.test.mjs
/path/to/node-v24.10.0/bin/node --expose-gc --import tsx --test benchmarks/sqlite-preparation/workload.test.mjs
/path/to/node-v22.16.0/bin/node --expose-gc --import tsx benchmarks/sqlite-preparation/run.mjs --out /tmp/sqlite-preparation-22.json
/path/to/node-v24.10.0/bin/node --expose-gc --import tsx benchmarks/sqlite-preparation/run.mjs --out /tmp/sqlite-preparation-24.json
/path/to/node-v24.10.0/bin/node --import tsx benchmarks/sqlite-preparation/validate.mjs /tmp/sqlite-preparation-24.json
```

Run the runtimes **serially** and avoid simultaneous package lifecycle commands
or source tests. The runner requires exactly Node 22.16.0 or 24.10.0 and explicit
GC. It fails on missing native prerequisites instead of skipping or substituting
a newer runtime. `--rounds 4 --iterations 128` is the minimum smoke workload;
defaults are nine rounds and 1,500 iterations. Output is an explicitly chosen JSON
file; nothing is uploaded. Run from the root so `--import tsx` resolves locally.

## What is matched

Each native handle starts with the same 32-row in-memory fixture and counter.
Six arms rotate and reverse order each round: native fresh, identical native
fresh control, native reuse, production `SqlitePool` fresh, identical pool fresh
control, and pool reuse. Reuse holds at most 32 SQL-to-StatementSync references
per handle, refreshing hits by Map insertion order. Failures evict the statement;
failed preparation never enters the Map. Parameters are rebound every call.

The pool candidate temporarily intercepts `prepare` **only for serial ordinary
query calls**. It runs the actual production placeholder/binding/decoding and
ownership paths. Native arms return raw bigints/text; pool arms decode booleans,
JSON and safe/unsafe integers. Compare fresh versus reuse **within each family**;
a native raw arm is a decoding-free reference, not equivalent decoded output.
There is no new public execution interface or user option.

| Workload | Exact result/effect checks |
| --- | --- |
| Parameterized indexed read | All six columns, nulls, BLOB bytes, booleans/JSON and unsafe integers for every result |
| Wide JSON read | Same values plus a 2 KiB JSON field; raw versus decoded result checked independently |
| UPDATE without RETURNING | Every affected-row count and a separate final native counter read |
| UPDATE RETURNING | Every returned counter and a separate final native counter read |
| Transactions | BEGIN/update/read/alternating COMMIT or ROLLBACK; each intermediate value and exact committed effect |
| 16 SQL shapes | Fits the32-entry candidate; identical parameter sequences |
| 128 SQL shapes | Exceeds capacity; repeated bounded cyclic churn, each result checked |

The SQL shapes use trusted comment suffixes; caller values always remain bound.
Thus shape churn isolates preparation/retention; it does not model every plan
complexity or schema size. An application whose shapes exceed the cache capacity
may pay Map overhead without avoiding preparation.

Each cold sample is the first operation on an initialized fixture. This measures
statement-cold work, **not disk, OS cache, process startup or module startup**.
Each warm sample uses a separate initialized handle, 128 verified warmup iterations,
and then the measured workload. Counter reset occurs outside timing. Warmup,
fixture insertion, expected-output construction, exact validation, independent
final native reads, GC and cleanup are excluded from timing. Result accumulation,
JavaScript async dispatch and pool decoding are included. Preparation/hit counts
cover only timed operations; cumulative stats include warmup. Transactions have
four SQL operations per iteration. Boundary rowCount is driver-dependent and is
not treated as an affected-row contract; boundary row arrays must be empty.

Every result is compared with a JavaScript oracle calculated without database
queries, after timing. Results are never validated merely against another arm.
Timed workload and memory handles close in `finally`. The test suite injects wrong rows/counts, omitted
execution, false write success and unbounded retention to prove checks fail.
The report validator separately rejects missing/duplicate samples, incorrect
operation/effect counts, misleading preparation counts and missing cleanup.

## Correctness boundaries and optimization decision

The native controls cover changing bindings (including null/BLOB/unsafe integers),
preparation errors, unique violations, binding errors, user-function step errors,
recovery, native schema auto-reprepare and explicit invalidation. Stream controls
use the real pool iterator: same-checkout ordinary work refuses while another
caller's query queues until `return()`. Iterators always prepare fresh in this
experiment. Baseline factory controls verify borrowed handles survive disconnect
and owned handles refuse work after disconnect. Candidate pool teardown closes
its native handle; the candidate is not wired into either factory ownership path.
These are controls of existing behavior, not changes to streaming or ownership.

**External schema changes now refresh result decoding.** After
`SELECT v FROM changing` describes `v BOOLEAN`, dropping/recreating that table
with `v INTEGER` must make the same pool return 1. Both fresh and candidate
arms assert this exact result and record `passed-current-decode` with
`passed: true`. A newly constructed pool independently returns 1 as well.
Production decoding freshly describes each nonempty execution after stepping;
it keeps no SQL-keyed decoder entries. One most recent result-shape record can
reuse its decoder map only after column names, types and origins match that
fresh native description. Its record count is bounded at one across all SQL
shapes. Iterators describe after their first step and retain their snapshot's
decoder map until they close. The statement reuse
candidate and every timing, shape, effect and memory workload are unchanged.

Historical v1 reports record `unsupported-existing-stale-decode`, with observed
`true` and a fresh-pool result of 1. The validator still accepts that exact
historical observation and counts it in `documentedUnsupported`; it never
relabels it as a pass. New reports have zero such unsupported decoder controls.
Do not compare timings across these source versions without acknowledging the
extra per-execution metadata work. See [decoder behavior](../../docs/sqlite-decoding.md)
for runtime and caller-schema boundaries.

Memory is measured in six separate, serial child processes with forced GC,
before the fixture, after 4,096 and 8,192 unique shapes, after clearing references,
and after handle close. All 8,192 results in each child are checked exactly.
Snapshots include RSS, heap, external/array-buffer bytes and reference counts.
`StatementSync` on these exact runtimes has no explicit finalize API: eviction
bounds JavaScript references, **not a guaranteed native byte budget**. Process
RSS includes SQLite/JS allocator retention, fixture data and (on the pool route)
the one result-shape record and decoder metadata retained by an active execution. Historical reports also
include the former 1,000-entry SQL decoder cache. It is not a precise
per-statement size.
This workload cannot prove that native bindings release arbitrarily large BLOB
values or every driver-compatible borrowed handle behaves like `node:sqlite`.

No production reuse optimization is included. Native result correctness is
necessary but does not settle finalization/byte retention,
other compatible drivers, factory lifecycle or noisy timing. This tested harness
supplies the measurements needed to evaluate a later narrow ordinary-query
change without altering PostgreSQL, generic query, streaming or introspection
interfaces.

## Reading the JSON

Reports retain exact Node binary and SQLite source identities, repository head,
working-tree state, source hashes, lock hash, `tsx` version, host CPU/load/counter
snapshots, all raw paired timings, CPU usage, preparation counts, correctness
controls, memory snapshots and cleanup. Validate the report before using it.
If source hashes change, regenerate evidence; a matching commit name alone does
not establish matching code. Reports can include dirty/untracked source while
implementation is in progress; hashes identify the measured bytes.

Fresh-minus-reuse and fresh-minus-identical-control arrays are descriptive. The
latter exposes drift/noise in identical code, and raw ranges show outliers. They
are not confidence intervals, independent observations or a speedup claim.
GC occurs between samples, not inside them; cold and warm arms can still see
host contention, GC/allocator history, JIT differences and order effects. There
is no performance gate or automatically selected winner. Repeat on an isolated
host before making a performance claim, preserve negative controls, and report
uncertainty. No dependency, size budget, coverage floor or CI job is changed.
