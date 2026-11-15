# Native PostgreSQL pagination evidence

This isolated harness measures existing Turbine against its pinned `pg` dependency
using identical SQL, parameters, prepared names, selected values and total order.
It changes no production code. It requires **native PostgreSQL 18.6** and exact
**Node 22.16.0 or 24.10.0**. A missing prerequisite fails with a saved report.

```sh
npm ci
npm run gen:studio
node --import tsx --test benchmarks/postgres-pagination/validator.test.mjs
PG_PREFIX=/path/to/portable/usr node --import tsx benchmarks/postgres-pagination/run.mjs \
  --out /tmp/pagination-node22.json --rounds 4 --iterations 3
PG_PREFIX=/path/to/portable/usr node --import tsx benchmarks/postgres-pagination/controls.mjs \
  --out /tmp/pagination-controls-node22
```

Use the exact Node executable in each command and put its directory first in
`PATH` for npm. Repeat measurements serially on both runtimes. `PG_PREFIX` must
contain `bin/{initdb,postgres}`, `share/postgresql`, and `lib/postgresql`; the host
must satisfy their dynamic libraries. The harness never downloads a service,
accepts an existing endpoint, or changes Docker/host permissions. Linux `/proc`
and `getconf CLK_TCK` provide actual backend CPU/RSS observations.

Every invocation initializes its own random `/tmp/ppg-*` cluster, loopback port,
Unix socket directory and application connections. It creates tables only inside
that owned cluster's disposable `postgres` database. `initdb` synchronizes data;
fsync, full-page writes and synchronous commit must be on. Inserts commit before
`VACUUM (ANALYZE)` and `CHECKPOINT`. All indexes, DDL, statistics, planner settings,
server build/version and binary hashes are retained. The whole owned cluster and
its databases disappear during finalization. Process IDs, closed port, removed
socket/datadir, and application connections are audited separately. JSON reports
and server logs are written outside the service directory and survive ordinary
errors, SIGINT and SIGTERM. SIGKILL/power loss cannot run JavaScript finalizers.

## Corpus and oracle

The independent input formula creates 24,000 int4/text rows (plus 17 tiny rows),
four-row score ties, repeated score bands and NULL scores every nineteenth row.
JavaScript sorts these inputs independently of all SQL builders to predetermine
every page, cursor identity, field set, value and order. All scalar values are
compared, including Unicode and quote/backslash text. No result from the server
is used as the expected oracle. `corpus` in the report contains the exact expected
rows and hashes before measurement starts.

| Axis | Coverage |
| --- | --- |
| Predicates | `bucket = 7` (240/24,000) and `bucket >= 0` (24,000/24,000) |
| Order | score ASC NULLS LAST, ID ASC; score DESC NULLS LAST, ID ASC |
| Pages | Tiny, deep OFFSET 18,003, final partial, empty, selective deep/final/empty, NULL boundary and NULL cursor |
| Relations | Existing join strategy only: three parents, ordered child OFFSET 1 LIMIT 3 per parent |
| Methods | OFFSET; provided multi-column keyset; random access with cursor lookup then keyset |

`provided` means the caller already has the exact score/ID cursor. It excludes
cursor discovery and cannot support a random-access superiority claim. `locate`
performs and charges an ordered OFFSET lookup of the preceding row, verifies it
against the predetermined cursor, then seeks. Both return the same page as OFFSET.
Native supported lexicographic cursor predicates preserve ties, mixed directions
and the explicit NULL policy. There is no invented cursor API or production probe.

## Measurement boundary and limitations

Even rounds alternate raw-first and Turbine-first. Each case/method/temperature
has a fresh connection for each arm and round. Connection-cold includes fresh ORM
construction, native connection opening and its first statements. It does **not**
mean a cold database buffer cache or cold OS cache. Warm samples first execute six
identical workloads, then time the configured iterations on the same connection.
Both arms issue an identical `SELECT 1 AS noise` for each workload, including
warmup. Both do the same full-value verification and digest within measured time.
The raw arm uses precompiled SQL; ORM building and decoding are part of Turbine's
cost. Closing connections and diagnostic queries happen outside the timed region.

SQL/binds/names are checked at the driver boundary for every observed query.
Unexpected calls, row counts or full materialization fail. Reports preserve every
measured and warmup wire observation, query count, row count, actual connection
PID, client CPU, RSS, cumulative process maxRSS, backend CPU ticks and backend RSS.
Backend tick resolution is coarse and a zero delta does not establish zero CPU.
RSS is observed within a shared sequential process, not an isolated peak per arm.
Connection-cold backend CPU includes backend startup. Host activity is uncontrolled.

Paired ratios and median per-operation times are computed from raw samples;
`comparisons` includes every Turbine loss. `paginationComparisons` separately
retains supplied-cursor and lookup-inclusive ratios and losses against OFFSET.
Four rounds are a small local campaign, not a statistical population guarantee.
There is no global speed claim or threshold. Empty pages still execute and count.

After measurements, native `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)` runs
each exact statement with the same bind values. Full JSON, root output rows,
scan/index names, rows/loops, removed rows, buffers and timing are retained.
These are **unnamed diagnostic plans**, not proof of the named prepared plan used
by a sample. Each sample also records actual `pg_prepared_statements` generic/custom
counters outside the timer. Validation requires the exact native name/SQL set and
nonnegative integer execution counters whose sum includes every measured and warmup
call. Missing observations, stripped names, duplicate names and contradictory counts
refuse the report. This keeps plan collection out of production hot paths
and avoids presenting diagnostic planning as measured execution planning.

## Failure controls and CI

`controls.mjs` launches seven separate owned-service invocations: missing service,
broken service, wrong result order, unbounded materialization with a sliced return,
wrong independent oracle, SIGTERM, and stripped prepared-statement names. Expected failure exit codes and reasons,
retained reports, and all cleanup facts must hold. These are real native controls,
not fixture-based certification. Run them separately on both exact runtimes.

`validator.test.mjs` is a lightweight service-free validator suite with synthetic
inputs clearly confined to validation tests. It rejects missing/duplicate samples,
wrong row/SQL/parameter identities, unbalanced rounds, bad counters, contradictory
performance comparisons, duplicate/contradictory plans and false cleanup claims.
Its executable missing-service case must fail and save JSON; unsupported measurement
runtimes fail rather than skipping. Synthetic validator inputs are never evidence.

The existing unit matrix runs these lightweight controls on Node 20/22/24/26.
It adds no job, native-service dependency, performance threshold, coverage exclusion
or budget change. Large native reports are local artifacts, not checked-in claims.
