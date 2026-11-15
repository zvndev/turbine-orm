# Reproducible cross-engine evidence

This independent harness measures a small, exact workload through the repository's
Turbine source, raw drivers, Drizzle stable **0.45.4**, and Drizzle RC
**1.0.0-rc.5**. It does not update the historical headline benchmark or publish
speed rankings. Its semantics marker is `cross-engine-exact-effects-v2`;
previous `cross-engine-exact-effects-v1` and historical `exact-ordered-v1` runs
cannot be aggregated with it. Version 2 adds explicit transactional MySQL native
drains and requires their real driver routes; the fixture and PostgreSQL/SQLite
workloads retain their existing results and transaction policies.

## Install and run

Use Node **24.10+**, with the same executable for installation and runs. From the
repository root:

```sh
npm ci
npm ci --prefix benchmarks/evidence
npm test --prefix benchmarks/evidence
npm run verify:pins --prefix benchmarks/evidence

# SQLite runs immediately; all unconfigured servers are explicitly unavailable.
EVIDENCE_ROUNDS=30 EVIDENCE_WARMUP=5 \
  npm run run --prefix benchmarks/evidence -- /tmp/evidence-sqlite-1.json
npm run validate --prefix benchmarks/evidence -- /tmp/evidence-sqlite-1.json
```

Every output path must be new. The runner refuses an existing file, writes a
non-success marker before setup, and saves `invalid` after execution/correctness/
cleanup failure. An interrupted or partial file cannot pass validation. SIGINT
and SIGTERM request cleanup at the next operation boundary; SIGKILL or host loss
can leave a randomly named scratch database for manual removal.

### Disposable PostgreSQL 18

Install PostgreSQL 18 tools yourself; the wrapper does not install system
packages, change permissions, or use sudo. For an isolated run with automatic
startup and shutdown:

```sh
EVIDENCE_PG_BIN=/usr/lib/postgresql/18/bin \
EVIDENCE_PG_ROOT=/tmp/turbine-comparative-postgres \
EVIDENCE_PG_USER=evidence EVIDENCE_PG_PORT=15432 \
EVIDENCE_ROUNDS=30 EVIDENCE_WARMUP=5 \
  npm run run:postgres --prefix benchmarks/evidence -- /tmp/evidence-pg-1.json
```

The wrapper initializes a new cluster if needed, or starts an existing stopped
cluster belonging to this user. It **refuses an already-running cluster** and
stops only the cluster it started, including when the runner fails. PostgreSQL
18.6 was used for the checked smoke artifacts; the runner separately records the
server's actual `server_version`. Supply a stopped cluster with that exact
server version to reproduce those artifacts. The default initialization uses
trust authentication in this disposable cluster, which listens on loopback.

Alternatively use an explicitly provisioned disposable loopback service:

```sh
EVIDENCE_DISPOSABLE=1 \
EVIDENCE_PG_ADMIN_URL=postgresql://evidence@127.0.0.1:15432/postgres \
EVIDENCE_REQUIRE_ENGINES=sqlite,postgresql \
  npm run run --prefix benchmarks/evidence -- /tmp/evidence-pg-external.json
```

### MySQL and SQL Server

`compose.yaml` pins official server images by immutable registry digest and
binds ports to loopback. `services.json` records the primary registry sources
and selected platform. Image discovery is not evidence of a running server.
Use an existing, authorized container runtime; do not change socket permissions.

On that host, set ephemeral passwords locally, then:

```sh
docker compose -p turbine-evidence -f benchmarks/evidence/compose.yaml up -d --wait

# Construct URLs without printing passwords or embedding them in shell history.
export EVIDENCE_MYSQL_ADMIN_URL="$(node -e '
const u = new URL("mysql://root@127.0.0.1:13306/mysql");
u.password = process.env.EVIDENCE_MYSQL_PASSWORD; process.stdout.write(u.href);')"
export EVIDENCE_MSSQL_ADMIN_URL="$(node -e '
const u = new URL("mssql://sa@127.0.0.1:11433/master");
u.password = process.env.EVIDENCE_MSSQL_PASSWORD; process.stdout.write(u.href);')"

EVIDENCE_DISPOSABLE=1 EVIDENCE_REQUIRE_ENGINES=sqlite,mysql,mssql \
  npm run run --prefix benchmarks/evidence -- /tmp/evidence-network-1.json

docker compose -p turbine-evidence -f benchmarks/evidence/compose.yaml down -v
unset EVIDENCE_MYSQL_ADMIN_URL EVIDENCE_MSSQL_ADMIN_URL
unset EVIDENCE_MYSQL_PASSWORD EVIDENCE_MSSQL_PASSWORD
```

Both password variables must be exported before Compose runs. SQL Server's
password must satisfy its complexity rules. These services initialize **new
disposable container storage**; do not attach existing database volumes. Accepting
the SQL Server developer EULA is explicit in the supplied Compose file.

The runner creates and drops a unique
`turbine_evidence_<16 random hex digits>` database for each network engine. It
does not seed an existing application database, grant privileges, or alter host
permissions. Admin URLs require `EVIDENCE_DISPOSABLE=1`, the matching protocol,
loopback, and no query parameters. Connection/SQL errors on a configured engine
invalidate the run. Unset URLs produce explicit unavailable records; a required
engine's unavailability fails the run. Secrets and endpoint URLs are never
written into result JSON.

The original `results/smoke-manifest.json` is retained as historical v1 evidence
with MySQL/MSSQL unavailable. `results/mysql-smoke-manifest.json` separately
records actual **MySQL Community 8.4.0**, **mysql2 3.24.6**, the raw/Turbine native
route audits and exact materialized raw/Turbine/Drizzle effects. Its local native
binary service is distinct from the pinned Compose image, which was not run.
SQL Server remains unavailable without a real service; build-only compilation
probes are not server execution or native TDS certification.

For authorized same-user MySQL 8.4 binaries, without Docker or system changes:

```sh
# The executable and any required shared libraries must already be installed.
# If needed, export LD_LIBRARY_PATH pointing at your existing extracted libs.
EVIDENCE_MYSQL_BIN=/path/to/mysql-8.4.0/bin \
EVIDENCE_MYSQL_EXPECTED_VERSION=8.4.0 \
EVIDENCE_ROUNDS=3 EVIDENCE_WARMUP=1 \
  npm run run:mysql --prefix benchmarks/evidence -- --test \
    /tmp/mysql-evidence-1.json /tmp/mysql-evidence-2.json /tmp/mysql-evidence-3.json
```

This wrapper always initializes a **new** same-user datadir and unique socket
under `/tmp`, chooses a free loopback port, and refuses a non-8.4 actual server.
`EVIDENCE_MYSQL_EXPECTED_VERSION` optionally enforces the exact patch version.
It uses `--no-defaults`, loopback-only MySQL networking and disables MySQL X.
Initialization uses an empty-password root account only in the new disposable
service. Never expose that service outside loopback. No existing datadir,
configuration, account or service is reused. A port-bind race fails closed.
`--test` runs the seven live correctness/negative controls first; they can also be
run via `npm run test:mysql --prefix benchmarks/evidence` against an explicitly
configured disposable loopback URL. The live command fails if its service is
missing; the default guard suite needs no network services.

Each supplied output is a separate runner process against that owned service.
On success or runner failure, the wrapper verifies that no evidence scratch DBs
remain, signals only its own server child, waits for exit, and removes its
datadir. It retains `identity.json`, initialization and server logs in the printed
unique directory. Startup/authentication errors retain their causes. SIGKILL or
host loss can prevent cleanup; a failed wrapper never certifies its outputs.

## Work and equivalence

The fixture contains 2,048 explicit integer primary keys, signed integer values,
Unicode/quote/backslash text, and nullable text. Expected results come from the
immutable input fixture, independently of ORM output, SQL generation and server
decoders. The foundation benchmark's `assertExact`/`canonical` guards retain
order, keys, nulls, text and exact integer checks. This workload intentionally
does not certify relations, decimal/temporal/JSON semantics or Prisma adapters.
The historical PostgreSQL Prisma harness remains separate; `pins.json` explains
why a current npm tag must not be assumed to mean a stable Prisma version.

| Scenario | Exact observable work |
| --- | --- |
| `page` | Ordered IDs 17–80; all four columns |
| `point` | Rotate IDs 1–16; every ID checked in preflight |
| `transaction` | Two increments, full ordered read inside transaction, commit |
| `native` | Drain all rows in order into a SHA-256 digest; retain no row array |

Each engine uses one shared native pool/handle across arms, pool maximum one,
and serial operations. Session/default isolation, durability and server versions
are recorded. Setup/reset and full independent effect verification are outside
timing. Each transaction arm uses its library's transaction API; rollback and
commit are verified through the raw driver. Drizzle RC's synchronous SQLite
transaction uses a synchronous callback, avoiding a premature commit around an
async callback. Turbine's write return/reselection work remains included in its
API measurement; raw/Drizzle UPDATEs do not request returning rows. Thus equal
logical effects do not imply identical SQL or round trips.

Warmup and measured rounds rotate arm order deterministically. Every measured
callback's result and complete database effects are verified, not just the
first example or row count. Live negative controls corrupt cells/order and write
the wrong row; tests also inject corruption only after preflight and warmup.
Native guards reject count-only drains. Required-service, pins, missing arms,
sample counts, distributions, source/runtime/transport campaign compatibility
and cleanup have refusal tests. MySQL live controls also reject a materialized
drain with a correct full digest, a forged digest without driver commands and
native corruption introduced only during timing.

Native consumption is separate from materialized reads:

- SQLite raw uses `iterate()`; Turbine uses native batches of 128. An untimed
  audit requires one real iterator to step exactly 2,048 rows per arm.
- PostgreSQL raw uses a transaction cursor with `FETCH 128`; Turbine uses its
  native cursor and retains its speculative LIMIT read and stream safety policy.
  An untimed pinned-`pg` wire audit observes DECLARE/FETCH/CLOSE. Hooks are removed
  before timing. Recorded SQL makes the extra work visible.
- Drizzle stable SQLite uses `sqlite-proxy` over the same native handle; its
  async callback overhead is included. RC uses its native `node-sqlite` adapter.
- MySQL raw uses the pinned callback connection's `Query.stream()` with
  highWaterMark 1; Turbine uses the integrated adapter's callback row events in
  batches of 128. Both drain one ordered SELECT into the same bounded digest,
  within an explicit BEGIN/COMMIT on the same max-one pool. Turbine includes its
  speculative LIMIT129 read inside that transaction; raw does not speculate.
  An untimed audit observes actual mysql2 Query/Execute commands, one result set,
  all result events, no materializing result callback or retained driver row
  array, pause/resume activity, one physical connection and BEGIN/COMMIT. Hooks
  are removed before warmup/timing, including failure paths. This is incremental
  network driver consumption, **not a MySQL server cursor**. Row/batch bounds do
  not bound individual row size, socket packets or server execution memory.
- Native MSSQL drains remain unavailable here pending a real service and an
  independent native route audit. Drizzle native drains are also unavailable.
- Stable Drizzle has no SQL Server adapter. Its arm is explicitly unavailable.

## Versions and resources

`pins.json` captures npm registry tags, publication metadata and integrity;
`package-lock.json` fixes transitive resolution. The runner refuses mismatched
manifest, lock, integrity or installed versions. SQL Server uses **mssql 11.0.2**
for every arm because RC.5 declares `^11.0.1`; latest **12.7.14** is separately
recorded rather than forcing an incompatible peer. Package discovery, installed
runtime versions, actual server versions and service image identity are distinct.
`runtime.sourcePg` records the root package's separately locked `#pg` import;
all measured PostgreSQL SQL operations use the shared injected benchmark pool.

Each sample retains wall time, client user/system CPU microseconds, RSS/heap
before and after, observed RSS at native batch boundaries, process-lifetime
maxRSS, context switches, and available same-user local PostgreSQL backend
CPU ticks/RSS. A backend must identify the exact random scratch database before
host `/proc` data is attributed to it. Container/remote server metrics are
unavailable. Server samples exclude other backends, shared workers and total
cluster memory. Client measurements include all process threads; boundary RSS
samples are not true allocation peaks, and lifetime maxRSS is not an arm peak.

Raw samples and min/median/mean/p90/p95/p99/max distributions remain in the
versioned JSON (`results.schema.json`). Before/after raw `SELECT 1` controls,
load averages, a 20% median-drift flag, CPU model/count, available parallelism,
and total memory describe shared-host conditions. Post-call checks are untimed
but affect cache and JIT state. No rows/second or superiority ranking is emitted.

Use at least three separate processes with identical settings for a campaign:

```sh
# Repeat the chosen run command three times with new output paths.
npm run validate --prefix benchmarks/evidence -- \
  /tmp/evidence-1.json /tmp/evidence-2.json /tmp/evidence-3.json
npm run summarize --prefix benchmarks/evidence -- /tmp/evidence-manifest.json \
  /tmp/evidence-1.json /tmp/evidence-2.json /tmp/evidence-3.json
```

The campaign validator refuses duplicate run IDs, partial catalogs, changed
source/harness hashes, installed versions, runtime, servers/settings, pooling,
or transports. It checks compatibility, not statistical significance. Runs with
fewer than 100 repetitions or 20 warmups are classified as `smoke`; larger runs
are only `measurement-candidate`. `performanceClaimsAllowed` remains **false**
in both cases. Skipped engines, tiny fixtures and shared-host noise cannot
support a general speed claim.

`results/smoke-manifest.json` (historical v1) and
`results/mysql-smoke-manifest.json` (v2) are separate three-process correctness/resource
manifests, with hashes of detailed local result files. They record actual versions,
completed sample counts, resource attribution, drift flags, explicit unavailable
engines and cleanup. Their counts are reproducibility evidence, not timing rankings. The v2 validator
intentionally refuses v1 results; no timings or samples are combined across
these manifests.


The harness fingerprint includes the executable exact-result oracle at
`benchmarks/equivalence.ts`, the root dependency locks and build configuration,
and the harness setup/configuration files. Validation requires nonempty Node,
V8, OpenSSL and source-driver provenance plus each completed engine's recorded
server settings. Historical artifacts retain their original fingerprints.

PostgreSQL native audits observe wire row and command-completion events. Each
FETCH must use the declared 128-row bound, drain all 2,048 fixture rows, and
close the cursor before COMMIT. The documented 129-row speculative Turbine
probe is recorded separately. A materialized SELECT, FETCH ALL, oversized
FETCH or decorative cursor sequence is refused. With an exclusively owned
loopback disposable server, run the live controls using:

```sh
EVIDENCE_DISPOSABLE=1 EVIDENCE_REQUIRE_ENGINES=postgresql \
  node --import ./node_modules/tsx/dist/loader.mjs --test pg-live.test.mjs
```

Supply `EVIDENCE_PG_ADMIN_URL` through the environment. MySQL setup saves an
identity and removes its owned datadir even if the binary is missing or
initialization fails. The ordinary guard suite includes both failure controls.

## Required native stream gate

`native-gate.mjs` turns the existing exact PostgreSQL/MySQL live suites into a
fail-closed gate. Install the root and evidence locks first, run `npm run gen:studio` before source CLI tests, and use Node **24.10+**. No new package
script or production dependency is required:

```sh
node --test benchmarks/evidence/native-gate.test.mjs

# Endpoint must belong to a newly provisioned disposable loopback service.
# Supply its admin URL through the matching environment variable, never an argument.
EVIDENCE_DISPOSABLE=1 EVIDENCE_PG_ADMIN_URL="$OWNED_PG_ADMIN_URL" \
  node benchmarks/evidence/native-gate.mjs postgresql 18.6 /tmp/pg-native-gate.json
EVIDENCE_DISPOSABLE=1 EVIDENCE_MYSQL_ADMIN_URL="$OWNED_MYSQL_ADMIN_URL" \
  node benchmarks/evidence/native-gate.mjs mysql 8.4.0 /tmp/mysql-native-gate.json
```

The exact expected version is mandatory: PostgreSQL **18.6** (distribution build
suffix accepted) or an exact **8.4.x** MySQL patch version. Actual server versions,
all six installed evidence dependency pins and the source driver's root lock
versions are checked. A missing endpoint, wrong version/protocol, remote URL or
non-disposable configuration fails before tests. Existing evidence scratch
databases cause refusal; the adapter never deletes another run's databases.

Required test identities are explicit: **one PostgreSQL case**, including bounded
FETCH/oversized/decorative cursor controls, and **seven MySQL cases**, including
materialization, forged digest, corrupt repetition, wrong committed effect and
consumer failure. The real Node reporter must report exactly those cases,
zero failures/skips/todos/cancellations, and a successful final summary. Filtering
or silently skipping a required case cannot pass. Suite labels do not inflate
test counts. Each child has a two-minute timeout and signal forwarding.

After the live tests, the unchanged `run.mjs` performs one warmup and one round,
validates exact effects/rows and actual native routes, and writes the existing
`cross-engine-exact-effects-v2` result/provenance schema. The companion gate JSON
references that result's SHA-256 and contains test counts, runtime/driver/server
provenance, native routes, correctness and scratch cleanup. The runner also
checks SQLite; other network endpoints are cleared. This smoke is not a timing
comparison and permits no speed claim or performance threshold.

Report and companion paths must be fresh. Failures write `invalid`, including
prerequisite failures; partial or initializing reports never certify success.
Private child diagnostics are retained alongside reports. A kill or host loss
can leave scratch data; incomplete reports do not assert cleanup. The endpoint
adapter owns scratch databases only, records that the service lifecycle belongs
to its caller, and never stops a supplied service.

To prove route refusal against an owned native service, append
`--fault-materialized`. It runs the same required suite, then deliberately
consumes real rows through a materializing query with an independently correct
digest. The actual driver-route audit must fail, the gate must exit nonzero and
record `invalid`, and scratch cleanup must still complete. The flag alters only
that child process; it does not edit source or relax the route validators.

For hosts with an authorized Docker runtime, the disposable setup is executable:

```sh
node benchmarks/evidence/native-gate-container.mjs postgresql /tmp/pg-container-gate.json
node benchmarks/evidence/native-gate-container.mjs mysql /tmp/mysql-container-gate.json
```

This wrapper chooses a unique container name and host loopback port, initializes
fresh tmpfs storage, creates a random ephemeral password, runs the endpoint gate,
and removes only its owned container and volumes on success/failure. Its separate
`*.container.json` identity records setup and verified removal. A deployment must
require both successful wrapper exit and complete gate/container reports.
`native-gate-services.json` pins PostgreSQL18.6 by digest and reuses MySQL's
existing `services.json` digest, with expected **8.4.13** derived from that image's
registry config. A container returning a different patch version fails rather
than borrowing the job's existing server or falling back to a mutable tag.
Registry metadata and local binary runs do not certify native container execution.
SQL Server is outside this gate and remains explicitly uncertified.

The shared workflow runs lightweight controls in the existing Node24 unit lane
and separate disposable PG18.6/MySQL native gates after the existing PG17 matrix
leg and MySQL batteries. It preserves the PG14–17 matrix, existing service pins
and test commands, and adds no jobs, floors, package scripts or performance
limits. The separate PG18.6 instance is necessary because the existing matrix
services do not have the required version. Native gate reports, exact-effect
results and container cleanup identities are retained as job artifacts. Local
binary evidence and command fixtures do not replace a successful container CI run.

The native gate snapshots the complete harness before required tests and checks
it before and after every child phase. Effects must match that fingerprint,
source identity, runtime and independently observed source-driver versions.
Linux process groups and `/proc` are required for worker cleanup: cancellation
and timeout terminate only the gate-owned group, escalate to SIGKILL after five
seconds, and verify that no live worker remains before returning. Dead zombies
awaiting OS reaping cannot execute or retain database connections. Invalid runs
still report scratch databases requiring removal by the disposable-service owner.
