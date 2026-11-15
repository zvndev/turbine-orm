# Consumer cost and generated type scale

`scripts/measure-consumer-cost.mjs` measures **an npm-packed candidate in real,
isolated consumers**. It does not change packaging, build the checkout, install
into the checkout, or enforce performance thresholds. Local libSQL initialization
opens a real native memory database and runs its required read-only integer-mode
admission SELECT; it runs no application query benchmark. No
competitor packages or database query benchmarks are involved in the default mode.
The optional [`--compare` mode](./COMPARISON.md) adds pinned PostgreSQL consumer
fixtures, independent strict compilation and separate native correctness oracles.

## Run

Use the exact tarball being evaluated, preferably the artifact produced by the
package gates. To produce a local development snapshot in your current checkout:

```sh
npm ci --ignore-scripts
npm run build
mkdir -p /tmp/consumer-candidate
npm pack --ignore-scripts --json --pack-destination /tmp/consumer-candidate
```

`--ignore-scripts` avoids the pack hooks' temporary manifest edits; this local
snapshot retains the development `prepare` declaration, unlike a release pack.
The tool records the actual packed manifest and disables all install scripts.
Do not substitute a different tarball when interpreting the result.

Prepare complete npm v3 locks for this exact tarball. These commands use example
paths; choose fresh directories for each campaign. Existing directories are
never overwritten.

```sh
node scripts/measure-consumer-cost.mjs \
  --tarball "${TARBALL:?absolute package archive path}" \
  --prepare-locks /tmp/consumer-locks --allow-network

# Default: all fifteen profiles, five-table compiler smoke, three runtime samples.
# Installs use npm ci --offline unless --allow-network is explicitly supplied.
node scripts/measure-consumer-cost.mjs \
  --tarball "${TARBALL:?absolute package archive path}" \
  --locks /tmp/consumer-locks --out /tmp/consumer-smoke

# Reproduce larger type-scale checks later, on an otherwise quiet host.
node scripts/measure-consumer-cost.mjs \
  --tarball "${TARBALL:?absolute package archive path}" \
  --locks /tmp/consumer-locks --out /tmp/consumer-scale \
  --profiles postgres --sizes 100,500,1000 --iterations 3 --timeout-ms 180000 \
  --compiler-heap-mb 4096

node --test tooling/consumer-cost/measure-consumer-cost.test.mjs
```

Lock preparation itself defaults to offline too; `--allow-network` explicitly
permits registry traffic and potentially expensive downloads. Preparing a lock
does **not** populate the cache with every package payload. On a cold cache,
the first measurement may also need `--allow-network`; subsequent offline replay
requires retaining the cache. `--cache PATH` chooses a dedicated npm cache. Copy
the candidate tarball, lock directory, evidence directory, and cache together for
offline reproduction on a compatible platform. Locks include platform-specific
optional dependencies; installation identities always reflect what actually
installed on the recorded Node/platform.

`--list` prints exact profile/tool pins. `--profiles` accepts comma-separated
names; unknown names fail before installation. `--sizes` accepts integers from
2 to 10000; the default is deliberately small. `--iterations` affects fresh
runtime processes, not compiler repeats. Each size gets one fresh compiler.
`--timeout-ms` applies separately to each spawned install, import, CLI command,
generation, and typecheck, rather than to the whole campaign.
`--compiler-heap-mb` bounds V8 old space per compiler (default 2048 MiB),
not total process RSS or host memory. Duplicate sizes are rejected. esbuild runs
through the existing runner dev tool API and has no separate deadline.

No new root dependencies are needed. esbuild comes from the checkout's existing
dev tooling; when absent, bundle measurements are `unavailable`. TypeScript and
Node declarations are pinned **inside the temporary consumers**, as development
dependencies in their locks. Their installed bytes do not enter the production
install size. Compiler checks use the consumer's compiler and declarations, with
`strict: true`, `skipLibCheck: false`, `noEmit: true`, and incremental compilation
disabled. They cannot borrow the checkout's dependencies.

## Profiles and boundaries

| Profile | Complete production install | Runtime initialization |
| --- | --- | --- |
| `postgres` | Candidate plus pinned `pg` and its production closure | Fresh unconnected `pg.Pool` and `TurbineClient` |
| `sqlite` | Candidate and mandatory production closure, native `node:sqlite` | In-memory SQLite database and `turbineSqlite`; cleanup after timing |
| `mysql` | Candidate plus pinned `mysql2` and **both** production closures | Unavailable: the public `turbineMysql()` factory probes `SELECT VERSION()` even for a supplied pool |
| `serverless` | Candidate plus pinned `pg` and its production closure | `turbineHttp()` with supplied `pg.Pool`, on Node |
| `cli` | Candidate and mandatory production closure | No config initialization; separate real executable `--help` cold startup |
| `sql` | Candidate and mandatory production closure, including unrelated `pg` | Unavailable: execution-free SQL composition has no engine initialization |
| `mysql-seed` | Candidate and mandatory production closure, including unrelated `pg`; no optional `mysql2` installed | Unavailable: native seed execution needs MySQL; only the public `./mysql/seed` entry is imported |
| `mssql-seed` | Candidate and mandatory production closure, including unrelated `pg`; no optional `mssql` installed | Unavailable: native seed execution needs SQL Server; only the public `./mssql/seed` entry is imported |
| `core` | Candidate plus `pg@8.23.1` and the complete production closure | Supplied unconnected pool; client ownership closes it; no SQL |
| `neon-ws` | Candidate, `@neondatabase/serverless@1.2.0`, `ws@8.18.3`, all production closures and mandatory unrelated `pg` | Unavailable without an actual WS endpoint/session contract; real driver imports only |
| `neon-http` | Candidate, `@neondatabase/serverless@1.2.0`, complete production closures and mandatory unrelated `pg` | Unavailable without an actual HTTP endpoint; no manufactured query source |
| `notification-hub` | Candidate plus `pg@8.23.1` and the complete production closure | Unsubscribed hub, owned unconnected pool; no checkout or LISTEN |
| `live-query` | Candidate and mandatory unrelated `pg` closure; no driver peer | Unavailable: callers supply query and subscription; local callbacks checked separately |
| `d1` | Candidate and mandatory unrelated `pg` closure; Worker binding has no Node driver peer | Unavailable outside Worker; invalid-binding refusal checks never substitute a fake binding |
| `libsql` | Candidate, `@libsql/client@0.18.0`, native platform payloads actually installed, all production closures and mandatory unrelated `pg` | Real native memory client, bigint admission SELECT, and supplied-client facade; consumer closes the native client after disconnect |

The original eight profiles and pins remain unchanged. The seven integrated
profiles are separate applications, so `pg@8.23.1` in core/hub does not upgrade
historical `pg@8.22.0`. Node-only WS includes an explicit `ws` implementation;
HTTP and WS factories are never invoked in initialization without real endpoints.
Installing a pinned Neon peer is an install fact, not hosted validation.

Every integrated profile runs separate ESM and CJS public behavior checks. Core
and hub exercise unconnected real pools and ownership; live-query exercises
subscribe-before-query, invalidation, disposal and subscription refusal using local
application callbacks. D1 checks invalid-binding admission and dialect refusals
without creating a working binding. libSQL checks remote URL refusal and real
native memory cleanup, including caller ownership and idempotent disconnect.
These are bounded correctness controls, not provider certification or query
performance evidence.

Integrated `publicTypes` sources resolve `import * as esm` and
`import cjs = require(...)` independently under NodeNext. Both conditional
public declaration graphs get the same positive and negative contracts in one
strict compiler invocation with `skipLibCheck: false`. The source is never
executed. D1 types check issued batches and rejected callback/options forms;
they do not promise static rejection of arbitrary method names through its
accessor type. The PostgreSQL generated 100/500/1000-table workload is unchanged.
Neither a passing D1 declaration nor local callbacks establish Worker, network,
remote libSQL, replicas, sync or hosted-provider compatibility.

The supplied-pool serverless profile uses the ordinary Node pg driver. It is not
an edge runtime, networkless HTTP adapter, or deployment measurement. PostgreSQL
and serverless initialization open no socket and execute no SQL. MySQL's real
driver and public entry are imported, but its factory is not invoked; an absent
initialization measurement is `null` with an explicit `unavailable` reason,
never zero milliseconds. Add a separate explicitly named adapter profile before
making claims about another adapter's cost.

The CLI's `runtime` measures the **public config entry**. `cliStartup` launches
the installed executable with `--help` and includes process startup/dispatch.
Its imported graph and bundle target the executable, covering the real tooling
graph rather than substituting the small config module for the CLI. Help does
not exercise every command, lazy tool, TypeScript config loader, or database
adapter; those unvisited runtime edges are outside the imported graph.

The historical SQL and seed entry profiles run separate correctness processes after the
runtime samples and imported graph. SQL checks real parameter binding, quoted
identifier escaping and rejection of forged fragments/identifiers/separators
using an explicitly local dialect contract. Seed checks prove callback identity,
no callback execution during declaration, and invalid callback rejection. They
do not call either native seed runner. These checks are not initialization or
native database evidence, and their execution costs never enter import timings.

Each historical SQL/seed entry also compiles its own consumer with strict declarations and
`skipLibCheck: false`, using its locked compiler. SQL checks opaque fragments;
seed consumers check typed exact numeric reads, nested callbacks, and refusal
of raw SQL, pool access and deferred builders. These `publicTypes` checks are
separate from PostgreSQL generated-schema `typeScale` and never execute the
consumer. The profiles do not invent edge or network adapter semantics.

An absent public export, native SQLite module, requested lock profile, or dev
tool is unavailable. A present but broken import, install, or compiler is a
failure. No simulated adapter or empty bundle replaces a missing measurement.

Every non-PG production install still pays for the candidate's mandatory `pg`.
`inventory.mandatoryPg` explicitly records its declaration, actual installation,
and whether it is unrelated to the chosen engine. The tool does not rewrite the
candidate's dependencies or conceal them with externalization.

## Evidence contract (schema version 1)

The primary machine-readable artifact is `OUT/report.json`. Every metric object
has a `status` (`measured`, `unavailable`, `failed`, or, for a spawned operation,
`timeout`/`resource-exhausted`). Missing metrics are absent or carry a reason, not a numeric zero.
Top-level `measured` means all applicable profile operations succeeded; it does
not mean every capability is measurable. Inspect nested `initialization` and
`completeBundle` statuses before drawing conclusions.

| Field | Meaning |
| --- | --- |
| `environment` | Exact Node/component versions, npm version, OS release, architecture and platform; no hostname, username, database URLs, or environment dump |
| `runner` | Git head/branch/dirty flag of this tool's checkout and hashes of runner, fixture generator, and profile definitions |
| `candidate` | Packed package name/version/manifest, manifest hash, tarball SHA-256, compressed bytes, regular-file payload bytes and count |
| `candidate.sourceRef` | Optional `--source-ref` caller assertion, explicitly **unverified**; runner HEAD is never presented as proof of the tarball's source |
| `options` | Profiles, table sizes, sample count, timeout and network opt-in |
| `profiles.NAME.installation` | npm ci outcome and wall time, not a cold-cache registry/download benchmark |
| `profiles.NAME.inventory` | Direct declared production dependencies, installed production package instances, transitive instances excluding direct paths, unique names, production node_modules file bytes/count, mandatory pg disclosure |
| `inventory.packages[]` | Installed path/name/version, lock integrity and resolved source, file bytes/count per package directory; directory bytes include nested packages and **must not be summed** |
| `runtime.samples[]` | Fresh-process `importMs`, separate `initMs` (nullable), and process peak RSS bytes; cleanup excluded from timings but included in peak RSS |
| `importedGraph` | Unique V8-observed JS module files during import/init or CLI help, with hashes and source file bytes; excludes builtins, native code, JSON and unvisited dynamic edges |
| `bundle` | esbuild version/settings, artifact bytes/gzip/brotli bytes, reachable input bytes/count, explicit external edges, and `completeBundle` capability status |
| `cliStartup` | Executable `--help` exit status and end-to-end wall time; no separate initialization timer |
| `behavior` | Separate correctness-process outcome/source hash for SQL/seed and integrated entries; native memory libSQL cleanup only, no native seed or external service execution |
| `publicTypes` | Strict public consumer compilation and diagnostics/resource artifacts; integrated sources check ESM and CJS; no generated-schema scale claim |
| `typeScale.cases[]` | Tables, exit/signal/status, compiler version/old-space bound, generation result, generated and per-file bytes/hashes, compiler wall time, compiler process peak RSS/CPU |
| `observation` (compiler commands) | Shared-host load/memory/pressure before/after plus Linux child VmRSS/VmHWM samples every 250 ms; explicit nulls when unobservable |
| `retainedWork` | Local temporary consumer directory retained on incomplete/failed runs or `--keep-work`; null after successful cleanup |

Npm lock sources/integrities and installed package versions identify drivers and
transitives exactly. `LOCKS/locks.json` binds every consumer manifest and lock to
their SHA-256 hashes, the profile definitions, and the exact candidate tarball.
Changed definitions or tarball identities require a fresh lock campaign; npm
never silently re-resolves them during replay. The report copies each consumer's
manifest/lock and entry source alongside command summaries, stdout/stderr,
runtime sample JSON, coverage files, bundle and esbuild metafile. Keep this whole
directory: the report alone is not all the evidence.

Installed size is the sum of regular file lengths under production node_modules,
excluding symlink payloads; it is neither allocated disk blocks nor a Docker
image size. The inventory excludes platform optionals not actually installed.
The candidate's unpacked payload is measured from regular tar entries, rather
than inferring it from the repository's dist directory.

Imported source bytes, reachable input bytes and bundle output bytes are
different quantities. V8 coverage collects a separate instrumented run; its
timings never enter the cold samples. Node builtins/native code are not bundled.
The standard JS pg bundle excludes absent optional `pg-native`, discloses that
edge, and includes the real JS driver's graph. Other unresolved external edges
make `completeBundle` unavailable: any emitted bytes describe a **partial
artifact**, not a complete application cost. This is particularly relevant to
dynamic optional-peer fallbacks, native libSQL binaries, both seed entries and optional MySQL tooling. CLI bundling may
itself be unavailable if its dynamic graph cannot be resolved. Bundles are size
artifacts, not claims of executable bundle compatibility.

Do not compare pg-externalized Turbine bytes to a different ORM's complete
application. Any future comparison must use the same full driver, runtime,
features, bundler/conditions, input program and exclusions, and must preserve the
complete install graph separately. This tool deliberately produces no ranking.

## Synthetic generated-schema compiler workload

`measure-consumer-cost-fixtures.mjs` creates deterministic schemas at any requested
size, including the 100/500/1000-table campaign. Each table has eight columns,
exact `int8` and `numeric` string values, an ordinary integer, dates, nullable
text, a required parent and a to-many children relation in a ring. No database or
hand-written replacement client is used. The **packed candidate's public
`generate()`** produces all three files with timestamps disabled.

The real consumer program invokes `findMany` on **every** generated accessor with
scalar filters and two-level nested relations. Type assertions inspect the actual
inferred query results, including exact numeric values, dates, nullability and
relation element types. `@ts-expect-error` checks reject lossy numeric assignment
and nonexistent relations. Assertions over generated interfaces alone would miss
client/query type regressions; they do not substitute for these compiler runs.
The workload targets the generated PostgreSQL client, not all engine factories.
It measures compiler scaling only, not query execution, generation throughput or
runtime numeric conversion.

Every size retains the synthetic metadata, generated files, consumer source,
tsconfig, generator source, hashes, diagnostics (`--extendedDiagnostics`), and
resource JSON under `OUT/postgres/tables-N/`. JSON encodes metadata `dateColumns`
sets as empty objects; the retained generator restores them to
`new Set(['created_at'])`. The three generated files' regular-file byte lengths are summed as
`generatedBytes`; the consumer, metadata input and generator are separate sizes.
Each case is checkpointed to `type-scale-progress.json`, including failures.

A timed-out compiler is `timeout`; a nonzero exit with V8's actual fatal heap
allocation diagnostic is `resource-exhausted`. A bare signal is only `failed`,
because a kill alone cannot establish OOM. The final in-process RSS/CPU metrics
are unavailable when the exit hook cannot run, and a stale resource file is
removed before every invocation. External Linux samples remain available on
aborts/timeouts when observed. Sampled VmHWM may miss the final peak and covers
only the compiler process, not descendants. Host snapshots include load average,
MemAvailable and raw CPU/memory PSI when available, without process identities
or environment dumps; other-platform missing observations remain null. They do
not attribute shared-host load to this workload or establish performance ranks.
Other sizes/profiles continue and preserve their own outcomes.

To investigate a failure, use the printed retained consumer path, restore the
chosen size's retained generated files/consumer/tsconfig into its `postgres/`
project, then run its `node_modules/typescript/bin/tsc -p tsconfig.json`. Never
compile the fixture against repository sources as a substitute for the tarball.

## Safety, exits and interpretation

Installs run in newly created temporary projects, with lifecycle scripts,
funding and audit network calls disabled, public registry only, and empty npm
user/global config files. Child environments do not inherit database URLs,
credentials, ambient Node flags or proxy/npm configuration. The caller's npm
cache can be reused without reading their npm auth config. No install hooks or
Git configuration writes are introduced. Child processes use `NODE_ENV=production`,
UTC and a fixed locale; compiler tools are still explicitly included as dev
dependencies for the separate typecheck step. Only trusted candidate code should be
measured: importing a package executes it; a temporary directory is not a sandbox.

Successful consumers are removed by default; failures/unavailable profiles and
`--keep-work` retain them. Evidence/locks are always retained. Remove printed
temporary directories when finished. A crash/forced termination may also leave
temporary directories. Exit 0 means applicable operations succeeded, exit 1
means invalid input or a failed/timed-out operation, and exit 2 means a profile
or required measurement tool was unavailable. Expected nested capability gaps
(MySQL/seed initialization, SQL composition without engine initialization, CLI config initialization, incomplete dynamic bundles)
remain explicit without failing otherwise useful measurements.

Serial samples do not flush the OS filesystem cache, control CPU frequency,
isolate other workloads, or produce confidence intervals. Cold means a fresh
Node process, not cold disk. Shared-host smoke timings are correctness evidence
only. Calibrate repeated quiet-host baselines before adding size/latency CI gates
or publishing performance claims. The negative controls exercise real compiler
errors, broken packed public imports, a missing profile, changed candidate
identity, impossible input and subprocess timeout handling; they set no arbitrary
latency or size floors.

## Integrated checkpoint and final serial replay

The integrated profile smoke uses the actual supplied archive, not checkout
`src/` or `dist/`. The development checkpoint archive SHA-256
`0d1c28b54d673b88dec8d927e7df18e79b678d3fcc0134b7ca657cc5cedf7077`
is not the final benchmark artifact. Its known original size holds remain owned
by the query-layer worker. A final archive requires fresh locks; do not relabel
checkpoint consumers or edit `locks.json` to accept it.

The shared runner currently has stale scope labels for native initialization
and marks core/hub pg as unrelated. The implementation handoff supplies a small,
tested `measure-consumer-cost-runner.UNAPPLIED.patch` for the runner owner. Apply
and review that correction before accepting final results. The owned fixtures
already work with the existing runner; until that correction lands, interpret
libSQL `runtime.initScope` / `behavior.scope` and core/hub
`mandatoryPg.unrelatedToSelectedEngine` using the explicit definitions above.

Run final measurements serially on an idle machine. The example uses fresh
output names, the final supplied archive, an isolated cache/TMPDIR and explicit
runtimes. Supply the archive, its SHA-256 and an unused output directory.
Run from the checkout matching the package being measured.

```sh
# Required caller inputs, never default to the checkpoint.
: "${FINAL_TARBALL:?absolute final archive path}"
: "${FINAL_SHA256:?caller-supplied final archive SHA-256}"
: "${CAMPAIGN_ROOT:?fresh owned HOME cache directory}"
printf '%s  %s\n' "$FINAL_SHA256" "$FINAL_TARBALL" | sha256sum --check -
mkdir -p "$CAMPAIGN_ROOT/tmp" "$CAMPAIGN_ROOT/npm-cache"
export TMPDIR="$CAMPAIGN_ROOT/tmp"
export NPM_CONFIG_CACHE="$CAMPAIGN_ROOT/npm-cache"
for NODE_BIN in \
  "${NODE22:?absolute Node 22 binary path}" \
  "${NODE24:?absolute Node 24 binary path}"
do
  NODE_LABEL=$("$NODE_BIN" --version)
  NODE_DIR=$(dirname "$NODE_BIN")
  # Registry resolution prepares locks; it is not an accepted install timing.
  PATH="$NODE_DIR:$PATH" "$NODE_BIN" scripts/measure-consumer-cost.mjs \
    --tarball "$FINAL_TARBALL" --prepare-locks "$CAMPAIGN_ROOT/locks-$NODE_LABEL" \
    --cache "$NPM_CONFIG_CACHE" --allow-network
  # Explicit cache-fill smoke, never an accepted timing sample. Inspect its
  # report; exit 2 can be unavailable bundling, while exit 1 requires repair.
  PATH="$NODE_DIR:$PATH" "$NODE_BIN" scripts/measure-consumer-cost.mjs \
    --tarball "$FINAL_TARBALL" --locks "$CAMPAIGN_ROOT/locks-$NODE_LABEL" \
    --out "$CAMPAIGN_ROOT/cache-fill-$NODE_LABEL" --cache "$NPM_CONFIG_CACHE" \
    --allow-network --sizes 5 --iterations 1
  # Final offline replay. Finish this runtime before advancing to the next.
  PATH="$NODE_DIR:$PATH" "$NODE_BIN" scripts/measure-consumer-cost.mjs \
    --tarball "$FINAL_TARBALL" --locks "$CAMPAIGN_ROOT/locks-$NODE_LABEL" \
    --out "$CAMPAIGN_ROOT/final-$NODE_LABEL" --cache "$NPM_CONFIG_CACHE" \
    --sizes 100,500,1000 --iterations 3 --timeout-ms 180000 --compiler-heap-mb 4096
done
```

Complete production install cost always includes mandatory pg, optional drivers
selected by the profile and their installed native/platform closure. Imported
JavaScript graphs omit native code/JSON and unvisited dynamic edges. The harness
does not report a library-only metric. If a separate library-only diagnostic is
created later, label it separately and retain the full installation fact. Bundle
output with unresolved optional/native edges is incomplete; absent runner
esbuild makes bundle cost unavailable. Neither is a complete application size.
No checkpoint install/import/type timings under contention are accepted here.

## Recorded historical campaign

See [RESULTS.md](./RESULTS.md) for an executed packed smoke and bounded serial
100/500/1000-table campaign. Its measurements describe that candidate, locked
toolchain and observed host only. Full generated bulk inputs stay outside public
source; the runner and fixtures above reproduce them deterministically.
