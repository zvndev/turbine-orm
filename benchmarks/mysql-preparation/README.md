# MySQL preparation execution evidence

A source-only, opt-in measurement harness. It changes no production execution,
cache, API, dependencies, CI jobs or thresholds. Root `npm ci` installs the exact
mysql2 **3.24.5** recorded in the root lock. Run `npm run gen:studio` after it.
The immutable reference archive is hashed; it is **not executed** by this harness.

The six arms use identical generated read SQL and fixture values: mysql2 text
`query`, an identical text control, actual binary `execute`, explicit prepared
handle reuse, `MysqlPool.query`, and full `items.findMany` with decoding. Turbine's
parameterized ordinary path **already uses mysql2.execute**; this is not a proposal
to turn preparation on. Raw driver booleans are checked as numbers; Turbine's are
checked as booleans against independently computed expected values. Raw results
are not timed through an artificial decoder to make their costs look equivalent.

Both direct connections and actual pools are used. Pools initialize two physical
sessions before timing and use serial checkout, not a concurrency stress model.
Rollback operations update and read on one checkout; another connection verifies
zero durable effects after **every operation**. The ORM rollback arm uses its
actual transaction/raw API. Comparisons with that arm include its extra transaction
bookkeeping. Read arms use the exact compiled SQL; protocol counters confirm the
route and execution count, including preparation and automatic reprepare separately.

## Run

Required: user-owned native MySQL **8.4.0** executable and its shared libraries,
exact Node **22.16.0** and **24.10.0** executables, and the immutable reference
archive with SHA256
`4b4836254f41d658696639ec65e51a5f5ff7ea25095433cb34c6e8807ba63beb`.
No supplied external URL is accepted. The wrapper creates new datadirs, sockets,
loopback ports and databases and removes its own storage after shutdown.
Absent prerequisites fail; no native case is silently skipped.

```sh
npm ci
npm run gen:studio
export MYSQL_PREP_MYSQLD=/path/to/mysql-8.4.0/bin/mysqld
export LD_LIBRARY_PATH=/path/to/mysql-libraries
export MYSQL_PREP_NODE22=/path/to/node-v22.16.0/bin/node
export MYSQL_PREP_NODE24=/path/to/node-v24.10.0/bin/node
export MYSQL_PREP_ARTIFACT=/path/to/reference.tgz
node benchmarks/mysql-preparation/native.mjs /tmp/NEW-mysql-preparation
node benchmarks/mysql-preparation/audit.mjs /tmp/NEW-mysql-preparation
node benchmarks/mysql-preparation/faults.mjs /tmp/NEW-mysql-preparation-faults
node --test benchmarks/mysql-preparation/harness.test.mjs
MYSQL_PREP_TEST_REPORT=/tmp/NEW-mysql-preparation/default-node22.json \
  node --test benchmarks/mysql-preparation/harness.test.mjs
node benchmarks/mysql-preparation/validate.mjs /tmp/NEW-mysql-preparation/default-node22.json
```

Four campaigns cover both exact runtimes and default versus startup
`ANSI_QUOTES,NO_BACKSLASH_ESCAPES`. Effective SQL modes are queried from the actual
session and retained; no benchmark session `SET` configures injected connections.
The separate owned-factory ownership control observes its existing mode setup.
`MYSQL_PREP_ROUNDS` (4..100, default 4) and `MYSQL_PREP_ITERATIONS` (16..100000,
default 32) control the sample size. Native faults deliberately corrupt effects,
route observations, bounds, summary arithmetic, interrupt with SIGTERM, and fail
cleanup reporting; all must exit nonzero and independently pass cleanup audits.
Use fresh output paths: report files refuse overwrite.

## Evidence and interpretation

Each campaign writes raw cold and warm observations in seeded randomized paired
order. All comparisons are recomputed from those samples, including paired
text-minus-arm differences, identical-control noise, medians and observed ranges.
They are observations, not confidence intervals. No speed winner, broad performance
claim or production optimization follows from a small local loopback campaign.
The validator rejects missing/duplicate controls, omitted effects, bad counters,
provenance omissions and fabricated comparison summaries.

Cold means an empty statement cache on an initialized route. Eight warmup operations
precede each warm sample. Fresh-process driver import, source import, fixture and
route/factory initialization, network-only probes, and actual checkout observations
are recorded separately. Each timed operation includes its ordinary query/decode
and checkout costs; checkout duration can be inspected but is not subtracted into
a purported pure execution estimate. Assertions and independent effect reads run
outside operation timing. CPU samples cover the timed application operation;
RSS/heap snapshots are process measurements, not server CPU or attribution to one
cache. Instrumentation and timer costs remain in the observations.

Independent native controls verify unsafe BIGINT strings, exact DECIMAL strings,
JSON/SQL NULL, booleans, UTC dates, Unicode and buffers; changing parameters; write
effects and rollback; failed prepare and failed execution followed by reuse; DDL
add/drop/recreate with changed result types; closed prepared/connection/checkout
handles; borrowed and owned lifecycle; and physical-session prepared ownership.
Churn executes 64 distinct shapes per route, records every occupancy/RSS snapshot,
and matches driver statement count to the server's exact global count after
a protocol drain on this
otherwise idle, owned server. Pre-drain snapshots separately bound the pending
COM_STMT_CLOSE occupancy (at most one extra statement per connection). Server metadata inference can automatically reprepare
an untyped `SELECT ?`; those counters are retained, not mislabeled as explicit
preparations. Explicit handle maps and each mysql2 statement LRU have capacity 8.
The SQL trace ring is capped at 64 records. Statement caches are drained/closed and
server occupancy is checked between routes.

Unsupported configurations are explicit. mysql2 text interpolation uses backslash
escaping and does not preserve arbitrary quotes/backslashes under
`NO_BACKSLASH_ESCAPES`; four text-arm/shape controls reproduce this. Complex JSON
and unsafe text **bindings** are excluded for those text configurations, while
binary binding controls run fully and all read arms check the complete stored rows.
This does not certify all-driver parser/name-cache memory bounds or an RSS plateau,
remote networks, concurrent load, all SQL types, or native SQL Server. A synthetic
report model is used only for dependency-free validator unit guards, never as
execution evidence. The existing unit gate runs the light guards on its
Node20/22/24/26 matrix.

Failure reports retain their original error and cleanup errors. Service identities
and logs survive removal of datadirs. Application sessions/database absence are
queried independently before shutdown; `audit.mjs` then probes owned PIDs, process
groups, ports, sockets, lock files and datadir paths. All executable/oracle/source,
installed-driver-file, runtime-binary, native-server-binary and reference-artifact
hashes are retained with the effective configuration and root lock identities.
All raw, preparation, control and service connections resolve the driver from the
repository root installation. A separate benchmark dependency installation cannot
substitute a different driver version for one arm.

The required-native shutdown regression sends actual SIGTERM and SIGINT while
the owned server is stopping and requires a failed, retained service identity:

```sh
MYSQL_PREP_SIGNAL_OUT=/tmp/NEW-mysql-cleanup-signals \
  node --test benchmarks/mysql-preparation/cleanup-signal.test.mjs
```

It uses the same `MYSQL_PREP_MYSQLD` and library environment above. Termination
during server shutdown or log flushing is included in the final status before
the campaign decides whether another SQL mode may start.
