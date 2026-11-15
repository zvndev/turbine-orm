# Ordinary SQLite query costs

This local harness compares two immutable bundles built from the same source
tree and dependency lock, with only `src/sqlite.ts` allowed to differ. Use a
correct decoder baseline that describes native columns after execution. Older
SQL-only decoder caches are not a valid optimization baseline.

```sh
node benchmarks/sqlite-query-cost/bundle.mjs --source /path/to/baseline-sqlite.ts --out /tmp/query-base.mjs
node benchmarks/sqlite-query-cost/bundle.mjs --out /tmp/query-candidate.mjs
node --expose-gc benchmarks/sqlite-query-cost/run.mjs --base /tmp/query-base.mjs --candidate /tmp/query-candidate.mjs --out /tmp/query-cost.json
node benchmarks/sqlite-query-cost/profile.mjs /tmp/query-base.mjs /tmp/query-profile.json
```

Use exactly Node 22.16.0 and 24.10.0 for campaigns, sequentially, without other
tests/builds on the same checkout. Bundling uses the installed development
esbuild. Bundles and manifests belong together; each manifest records every
input hash, SQLite source hash, artifact hash and lock/tool identity. The runner
rejects changed artifacts or mismatched shared inputs. It records its own hash,
runtime binary hash, SQLite version/source ID, CPU/load, raw rounds and result
counts. The profile exposes actual internal helpers only in measurement
bundles, without extending the public module API.

Each case rotates three arms: baseline, candidate and an identical baseline
control, each on its own in-memory native handle. Complete all three positions
before reversing direction (`Math.floor(round / ARMS.length) % 2`). The runner
requires complete six-round cycles; the default 12 rounds covers two cycles.
Each arm uses the preparation policy of its supplied bundle. Fixtures and expected results are computed
before timing. Every timed output is checked afterwards against independent JS
values, including unsafe integers, JSON, booleans and BLOBs; native counters
independently verify effects and transaction cleanup. Output retention and
ordinary promise overhead are included equally. The warmup is verified but is
excluded from reported result counts.

Cases include portable `$n` and dialect-native named reads, empty reads, wide
decoding, multiple rows, writes with/without RETURNING, commit/rollback,
16-shape reuse, 512-shape churn, long SQL and SQL above the memo byte cap.
Reports retain paired deltas and baseline-versus-identical-control noise.
Summary medians select the upper middle sample for even round counts; all raw
samples remain available for other summaries.
Shared-host timings are descriptive, with no automated speed certification.
Inspect every shape for regressions and report inconclusive differences as
such. Long-SQL gains do not imply equivalent gains for short ORM-generated
named SQL. The isolated profile costs are not additive query latency estimates.

The admission memo caches rewriting/classification, keyed by
SQL text and validated parameter count. Its admission memo is bounded to 128
entries and 128 KiB of accounted SQL payload; it retains no bindings, rows,
metadata or native statements. A separate bounded native statement memo now reuses
statements on unwrapped builtin handles; see [result decoding](../../docs/sqlite-decoding.md)
for eligibility and binding retention. Native metadata remains fresh after execution.
No native memory reclamation or broad SQLite parity claim follows from these measurements. Regression tests in
`src/test/sqlite-query-cost.test.ts` check bounds, current bindings, per-call
native preparation/description on wrapped handles, error validation, teardown and native DDL.
`src/test/sqlite-statement-reuse.test.ts` checks native reuse, binding limits and
differential equivalence against fresh preparation.
The separate decoder/stream suites retain the attachment, rollback, mutable
description and iterator ownership controls.

No service, socket, port, on-disk database or credentials are used. Native
ownership starts immediately after opening, including setup and constructor
failures. A fresh running report replaces any earlier success before artifact
loading; atomic checkpoints retain completed samples between fixtures. Ordinary
failures and SIGINT/SIGTERM retain primary and cleanup errors separately. Native
close is attempted even if pool teardown fails or reaches its deadline. A close
claim requires observed closure; closed native objects are not retained.
Uncatchable termination may leave a running checkpoint, never a new success.
Report writes and signal delivery points are outside measured operations.
Bundles/reports are caller-retained local artifacts. The dependency-free report
guards run in the existing Node20/22/24/26 unit job. The harness does not modify
the preparation benchmark.
