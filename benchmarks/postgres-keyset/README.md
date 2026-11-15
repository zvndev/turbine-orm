# Native PostgreSQL tuple-keyset experiment

This benchmark compares raw expanded-OR keyset SQL with a benchmark-only row-value
candidate on **the same owned native PostgreSQL 18.6 cluster**. It changes no
production SQL, API, parser, migration format, default or dependency. It imports
the corpus formula and `setup()` from `../postgres-pagination/` without changing
that harness. Reports, native samples and server logs remain outside the repo.

```sh
npm ci
node --test benchmarks/postgres-keyset/guards.test.mjs
PG_PREFIX=/path/to/portable/usr node --import tsx benchmarks/postgres-keyset/run.mjs \
  --out /tmp/postgres-keyset-node22.json --rounds 4 --iterations 3
PG_PREFIX=/path/to/portable/usr KEYSET_TEST_OUT=/tmp/postgres-keyset-controls-node22 \
  node --test benchmarks/postgres-keyset/native.test.mjs
```

Invoke native commands with exact Node **22.16.0 or 24.10.0**; run each runtime
serially. `PG_PREFIX` supplies `bin/{initdb,postgres}`, `share/postgresql` and
`lib/postgresql`, with host-compatible dynamic libraries. No endpoint is accepted,
download attempted or machine permission changed. Native tests require these
prerequisites and fail when absent. The guards need only Node builtins and support
the existing Node 20/22/24/26 matrix without TypeScript loaders or a database.

## Candidate and independent oracle

`compileTuple({ keys, cursor, uniqueSuffix, start })` returns either
`{ supported: true, sql, params }` or `{ supported: false, reason }`. Every plain
column key must have the same explicit direction and a caller-proven
`nullable: false` **in the filtered domain**, and the order must end in a
database-backed unique suffix. A composite unique suffix is supported. Values are
bound, identifiers quoted and parameter positions explicit. NULL, incomplete or
non-scalar cursors, nullable domains, mixed directions, duplicate columns and
missing unique suffixes refuse without SQL. There is no automatic fallback.
The non-null proof and uniqueness declaration are caller obligations here; this
small compiler does not inspect the database or handle collations, expression
keys, inclusive cursors, backward pagination or nullable ordering policies.

The existing corpus has nullable scores. **All measured cases explicitly filter
`score IS NOT NULL`**, so these measurements do not establish equivalence for the
original unfiltered nullable workload. Separate retained refusal records cover
nullable domains, NULL cursors and mixed directions. The eight measured cases are
deep ASC/DESC score-ID, ASC/DESC bucket-score-ID with multiple tie components,
selective, tiny, final partial and empty pages. Existing indexes are reused.
No new index or planner switch is introduced to force a favorable plan.

Expected pages are computed from the input formula using a JavaScript comparator
independent of SQL compilation. All fields and order are compared, including text
with Unicode, quotes and backslashes. Each method retains exact SQL, all binds,
full returned rows, row counts and hashes. Expanded OR repeats equality binds;
the tuple uses one bind per key. SQL and parameter arrays intentionally differ,
while complete result values agree. This is a raw SQL candidate experiment, not
a comparison of the production ORM's construction or decoding overhead.

## Costs and plans

`provided` starts with a known cursor. `locate` charges an ordered OFFSET lookup
of the preceding row, proves the located cursor's identity, then compiles the
page from that result. Lookup and page both remain inside the measured interval,
including all fetched rows and query counts. Random access cannot claim to avoid
the lookup. Both arms compile their statements on each operation and use the same
pinned `pg` driver and unnamed extended protocol. Neither arm receives prepared
statement reuse. There is no unrelated noise query.

Four even rounds alternate arm order. `connection-cold` opens a fresh connection
inside timing; it **does not** flush PostgreSQL shared buffers or OS caches. Warm
samples perform six complete workloads before timing on the same connection.
Cold and warm samples use a new connection per arm and round; backend PIDs are
retained. The full-value oracle and digest are timed equally in both arms.
Connection close and plan diagnostics are outside timing. Reports retain each
query's interval so an excluded lookup cannot masquerade as a charged workload.
The default campaign has 256 measured samples and 32 plan groups (48 statements).
All 128 paired arm costs and 128 supplied-versus-located charges are derived from
the retained samples, including any tuple losses. No pair is dropped by speed.

After measurements, every exact SQL/bind combination receives native
`EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)`. Full documents and extracted
index conditions, residual filters, rows/loops, rows removed, heap fetches, shared
hits/reads and planning/execution times are retained. These are separate unnamed
diagnostic executions, not the measured samples' execution plans. A fixed-fixture
native guard requires the deep tuple predicate to reach an index condition.
There is no speed threshold, global winner or statistical confidence claim.
Timings are small serial loopback measurements on an uncontrolled host; index
shape and removed-row observations are the primary evidence. No isolated CPU/RSS,
network-distance, transaction snapshot, concurrent writes or disk-cold conclusion
is supplied. Native SQL Server is outside this benchmark's scope.

## Controls, identity and cleanup

`guards.test.mjs` pins literal SQL and bind layouts, refusal cases, complete scope
counts, trace values and timing boundaries. Its deliberately synthetic validator
fixtures are confined to tests and never written as evidence. Omission/mutant
controls reject missing queries, tie-breakers, binds, results, plans, identities,
lookup charges and false cleanup.

`native.test.mjs` runs a positive native campaign plus six negative controls in
separate invocations: absent prerequisite, removed cursor predicate, removed ID
tie-breaker, excluded lookup interval, stopped server and SIGTERM. Intended
failure reasons, exit codes, retained failed wire traces where applicable and
cleanup facts must hold. It writes an incremental control ledger and logs outside
the repo. These native tests are explicit and are not part of lightweight CI.
The dependency-free guards run in the existing Node20/22/24/26 unit matrix.
Native controls remain a separate explicit invocation.

Every native report includes source HEAD/branch/status, per-file and combined
source/harness hashes, exact executable/hash/runtime versions, locked driver and
dependency files, server/initdb binary hashes, command, DDL, indexes, statistics
and settings. No archive is tested; the report explicitly records that limitation.
Successful inserts commit before `VACUUM (ANALYZE)` and `CHECKPOINT`; durability
settings must be on. One random cluster, socket and port belong to each invocation.
Finally, clients close and the owned server stops; every observed backend and
postmaster PID, port, socket, datadir and root is checked independently. A live
PID prevents datadir removal. Logs and failed reports survive cleanup. SIGINT and
SIGTERM use orderly finalization; SIGKILL and power loss cannot run finalizers.

Any production opt-in needs a separate reviewed contract for eligibility proofs,
fallback semantics, cache fingerprints and bind collection before integration.
This experiment grants no authority to rewrite the default builder.


Successful reports also reconcile every warmup and measured page/lookup call with
server log observations by backend PID, SQL, bind sequence and count. Each call
must use the unnamed extended protocol; a native named-execution control is
refused. The audit runs after timing and service shutdown. Driver loading is
root-resolved and its actual entry hash/version must match the root lock; the
shared fixture setup imports no driver. Persisted reports must retain native
observations, durability settings, nonnegative plans/timings, the deep fixture's
index condition and complete driver/runtime/log identities. Success cannot carry
a signal or deliberate fault. Historical reports without these required fields
are not accepted by the strengthened validator.
