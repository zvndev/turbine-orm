# Exact optional PostgreSQL transport gate

This checker installs a supplied, SHA256-pinned archive. It requires the four
integrated exports in that archive. No copied package, manifest overlay, fake
export, repack, HTTP native evidence or hosted/provider certification is involved.
The legacy WS/hub/live-query package adapters all call this checker.

The existing PostgreSQL CI job also runs `source-suite-gate.mjs` with an explicit
disposable service URL. It requires the source test count, zero failures/skips,
successful suite hooks and the cleanup audit. A zero process exit alone cannot
admit a failed teardown hook. The HTTP bridge has its own required native gate;
this checker does not substitute for that proof.

```sh
node scripts/check-optional-pg-transports.mjs /absolute/pretested.tgz \
  --sha256 <64-lowercase-hex-digits> --report /tmp/optional-smoke.json
```

`TURBINE_OPTIONAL_PG_SHA256` may supply the pin instead. The report preserves
archive identity, every command and child PID/exit/output, hashes of every installed
package payload file, actual dependency versions/edges/disk bytes, lockfile hash,
and cleanup proof. The consumer lockfile is retained next to the report. The
consumer and archive reference extraction are removed. Nothing changes the
installed turbine manifest or payload. Physical pg omission is restored before
final payload comparison. Absent-export controls use synthetic archives only.

Each run proves ESM import and CommonJS require behavior, strict `.mts`/`.cts`
declarations without `@types/pg`, optional Neon peer omission and subsequent
installation, main entry loading, callback snapshots/refetch/reconnect/disposal,
and hub structural external/owned checkout cleanup. Hub/live-query declarations
also compile with automatic type packages disabled. Live-query and hub run with
pg physically omitted. HTTP also imports without pg through the supplied-transport
core. WS and the main entry retain their pg graph and refuse import without it;
the default package still installs pg as a mandatory dependency.
HTTP accepts a caller-supplied query function; this gate only imports and typechecks
that entry. It does not invent a missing HTTP driver or report HTTP native success.

## Explicit native WS execution

For retained local PostgreSQL 18.6 binaries:

```sh
PG_PREFIX=/absolute/postgres-prefix node scripts/check-optional-pg-transports.mjs \
  /absolute/pretested.tgz --sha256 <hash> --native --report /tmp/optional-native.json
```

The shared owned-service helper creates a fresh cluster on an ephemeral loopback
port. The local ws byte relay uses another ephemeral port. Installed ESM/CJS
consumers use actual `@neondatabase/serverless@1.2.0` and `ws@8.18.3` for queries,
transactions, supplied Pool/Client ownership, a refused handshake, default PG
execution, invocation LISTEN refusal, and success/failure cleanup.

In existing disposable PostgreSQL service CI, omit `PG_PREFIX` and explicitly set:

```sh
TURBINE_OPTIONAL_PG_SERVICE_URL=postgres://user:password@localhost/database
TURBINE_OPTIONAL_PG_DISPOSABLE=1
```

The runner creates its own unique database and drops only that database. It never
stops the supplied service, kills its processes or probes its port for release.
Ambient `DATABASE_URL` alone is insufficient. Native requests cannot skip.
`neon-ws-native.ts` similarly supports explicit
`TURBINE_NEON_WS_PG_SERVICE_URL` plus `TURBINE_NEON_WS_PG_DISPOSABLE=1`, retaining
its original exact-18.6 binary-root path. The unapplied source-test guard change is
needed to select this new path in the existing suite.

To prove the service path using a surrounding service this task also owns:

```sh
PG_PREFIX=/absolute/postgres-prefix node tooling/optional-pg-transports/service-path-proof.mjs \
  /absolute/pretested.tgz <hash> /tmp/service-path.json
```

This runs both the exact installed consumer and the source fixture probe. The
source fixture probe is labelled source evidence, never installed archive evidence.
An optional fourth argument can name the source native suite in an
isolated source fixture. Its TAP must contain non-skipped tests, no failed suite
hooks and a real cleanup audit; exit status alone cannot establish success.

The source service fixture records residual server backends after client teardown
and force-drops only its unique owned database. This closes an aborted server-side
`pg_sleep` that has not yet observed its closed client socket. It always closes
the administration connection, including when database teardown fails.

## Measurement and integration

`--measure` uses the installed archive with esbuild/minify/platform=node and
Brotli quality 11. It retains ESM and CJS dependency metafiles. The CJS budget
comparison subtracts size-limit's 16-byte empty-project overhead. Explicit
entry limits and rationale live in `budgets.mjs`. Complete physical consumer
install bytes include mandatory pg, Neon, and ws relay dependencies and are
reported separately from driver-externalized library bytes and from type fixtures.
These measurements are before shared core extraction and must be recomputed
following core and WS correction integration. The retained archive predates the
independent WS correction lane; these smoke results do not establish that its
reviewed admission, handshake, outcome or event defects are fixed. They are not
marketing size claims.

`size-check.config.mjs` validates the existing checkout budgets plus the four new
limits without applying shared configuration edits. Esbuild's generated names
vary slightly between checkout paths and installed node_modules paths; the archive
measurements and normal size-limit checkout results are separately preserved.

`transport-ci.patch` records the optional transport checks for existing unit,
pack-smoke and PostgreSQL service jobs. The current workflow in
`.github/workflows/gates.yml` is authoritative. It reuses the packed archive and
SHA256 and runs source WebSocket checks against a disposable local database.
The native HTTP bridge has its own gate; this checker does not claim its results.

The existing 16-entry pg floor checker remains the sole
floor-import implementation and is not duplicated here.

```sh
node --test tooling/optional-pg-transports/harness.test.mjs
node node_modules/size-limit/bin.js --config tooling/optional-pg-transports/size-check.config.mjs
```

The guards exercise archive identity, absent exports, prerequisite omission,
installed payload tampering, nonzero children with misleading success output,
false native evidence, and missing cleanup/PID/group/datadir/socket/port/database
proof. Negative mutations are confined to synthetic fixtures. PostgreSQL wire,
parser, checksum, migration formats and production source remain unchanged.
SQL Server is native-unverified. libSQL, D1 and HTTP native runners are outside
this lane's ownership. No timing campaign is performed.

### Lifecycle ownership

The checker, source gate and local service proof share a sealed shutdown scope.
SIGINT/SIGTERM keep 130/143, while an earlier workload error remains primary.
Command deadlines include termination and output drain; owned detached sessions
are recorded with PID/start-time identity and terminated from leaves to parent so
parents can reap resistant workers. Failed cleanup still produces a failed JSON
report. The scope never signals a caller's group or service.

On an explicitly authorized disposable service, only a successfully created,
randomly named database can be force-dropped. Residual backends remain failure
evidence even when the forced drop and independent absence checks succeed.
Closing a relay socket does not count as PostgreSQL query cancellation.

The owned-postmaster adapter uses bounded lifecycle injection in the shared
`tooling/native-consumer-contracts/postgres-service.mjs` helper and refuses an
older helper without that capability before launching a service. Initialization
is awaited; default consumers retain their existing service API. Owned-service
and external disposable-service routes retain separate cleanup evidence.
