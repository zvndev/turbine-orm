# Native MySQL relation workload

Run from the repository root after `npm ci` and `npm run gen:studio`:

```sh
node --test benchmarks/mysql-relations/guards.test.mjs
node benchmarks/mysql-relations/controls.mjs /tmp/relations-omissions.json guards
export MYSQL_RELATIONS_PREFIX=/path/to/mysql-8.4.0
export MYSQL_RELATIONS_LIBRARIES=/path/to/native-libraries
node benchmarks/mysql-relations/run.mjs /tmp/relations-ordinary.json
node benchmarks/mysql-relations/run.mjs /tmp/relations-no-backslash.json --mode=no-backslash
node benchmarks/mysql-relations/audit.mjs /tmp/relations-ordinary.json /tmp/relations-cleanup.json
node benchmarks/mysql-relations/controls.mjs /tmp/relations-native-controls.json native
```

Every output must be a new path. Existing reports are refused before service
startup. The supervisor reserves a sibling `.lock` and writes the final JSON
exclusively after cleanup. Failures and received signals are sticky; a failed
prerequisite never produces a successful sample. Logs and commands remain in
the report, including unsuccessful runs. The native controls first execute a
complete positive workload and then mutate disposable copies. Their nested
baseline is one native run, not an additional set of independent unit tests.

The dependency-light guard command works on Node 20 and newer. Native execution
loads the repository's locked mysql2 and public TypeScript MySQL factory using
the root-installed tsx loader. It requires Linux `/proc` and exact MySQL 8.4.0.
Configure `MYSQL_RELATIONS_PREFIX` to a binary installation and
`MYSQL_RELATIONS_LIBRARIES` to its native library directory. The default binary
prefix is `/usr/local/mysql`; libraries otherwise use `LD_LIBRARY_PATH`.
No caller endpoint or credentials are accepted.
Each invocation initializes its own datadir, socket, TCP port and process groups.
SQL mode is configured at service startup; no session setting is sent.

The bounded default is 64 measured transactions: four fixtures, two windows,
two unique-FK shapes, and four arms. Small, larger uniform, skewed and wide
fixtures include empty parents and absent profiles, tied ordering keys,
three nested levels, exact DECIMAL and unsigned BIGINT boundaries, parsed JSON,
binary bytes, DATE years 1000/9999 and millisecond DATETIME. A separate in-memory
oracle builds expected values from fixture input. Flat native reads verify the
entire fixture before and after the reads, independently of nested output.
Both the schema's native `hasOne` object/null and its existing
`legacyToManyUniques` array option are exercised without modifying metadata
derivation or generated types.

All arms share the same one-connection mysql2 pool, driver flags, selected
fields, ordering, window semantics and explicit transaction boundary. A common
bound `id >= 1` predicate ensures SELECTs all use native mysql2 prepared binding;
transaction control uses native queries. Raw
mysql2 uses four flat prepared SELECTs and stitches/slices materialized rows.
Join uses one real JSON statement. Batched must execute flat follow-ups.
Flatten must show a real derived-table LEFT JOIN for the unique profile while
children/leaves remain JSON; legacy to-many profiles truthfully retain the JSON
join fallback. A requested label is never proof of a route. Actual SQL and
native command classes, callbacks, retained result arrays, row counts and
decoded byte counts are recorded. Actual protocol QUERY/PREPARE/EXECUTE packets
and their completed command responses count exchanges separately from logical
SQL calls, including real prepare cache misses. Unsupported positional JSON must raise E017
without any native command, outside the measured samples.

The wall/CPU measurements include transaction commands, ORM decode/raw stitch,
native observation and native array serialization/hashing. Seed, introspection,
oracle/effect probes, assertions and final output hashing are outside timing.
Socket bytes are separately observed from the actual native connection; decoded
JSON bytes are not protocol bytes. Memory endpoints and lifetime maxRSS describe
only the worker process. Backend memory is not measured. Group sampling runs
every 25ms and records observed identities; independent group scans additionally
check for surviving descendants. Very short-lived descendants may finish
between identity samples. Every group receives TERM and a bounded KILL fallback.
Initialize/startup/worker/whole-run deadlines are 60/30/180/300 seconds.

For a larger opt-in campaign, use `--scale=2` through `--scale=4` and
`--repetitions=2` through `--repetitions=10`. Repetitions reverse arm order on
alternate rounds. The first execution is included; there is no warmup exclusion.
The fixture size and preparation cost change with scale. Reports capture load
averages and context switches on a shared machine. These local samples establish
correctness and observed costs, with no performance winner, global memory-bound,
optimizer or broad compatibility claim. Executing source through tsx is source
evidence; it does not certify an npm package. This directory is not included in
the published library archive and installs no new dependency or shared gate.
