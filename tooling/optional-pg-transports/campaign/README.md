# Bounded installed PostgreSQL transport campaign

This lane prepares a runner and correctness controls. It does not establish final
comparative scores, package freeze, release readiness, or hosted certification.
It imports the supplied, SHA256-pinned installed archive in an isolated locked
consumer. No production source, local dist, original benchmark engine, root
Prisma 8 candidate, or shared harness is modified or used as runtime substitute.

## Serial measurement on an idle machine

Supply the final tested archive and SHA256, a fresh output directory and a
scratch directory. Set `PG_PREFIX` to a local PostgreSQL 18.6 installation and
use the exact Node 24.10.0 executable in `NODE24`.

```sh
"${NODE24:?absolute Node 24.10.0 binary path}" tooling/optional-pg-transports/campaign/run.mjs \
  --artifact "${FINAL_TARBALL:?absolute archive path}" --sha256 "${FINAL_SHA256:?archive SHA256}" \
  --out "${REPORT_ROOT:?fresh report directory}" --scratch "${SCRATCH_ROOT:?scratch directory}" \
  --mode preflight
```

Preflight collects zero timing samples and writes the resolved lock. For
collection, supply that lock with `--lock`, select `--mode collect` and provide
`--rounds 200 --warmup 10`. Run `audit.mjs OUTPUT_JSON REPORT_JSON...` afterward
to check cleanup. Each invocation creates an isolated service on ephemeral
loopback ports; it does not connect to an ambient `DATABASE_URL` or stop any
existing service. The service root is announced before initialization.

Collection requires the prepared lock and explicit rounds; it does not change
baseline versions or Node. `acceptedTiming` remains false because correctness
and cleanup checks alone do not establish comparative performance.

## Contracts and coverage

All query arms use one native PG table, 128 rows, two tenant values, 64-byte title
payloads, tenant 1, ordered `id,title` projection, and exactly 64 returned rows.
Every operation compares the entire ordered decoded payload outside the measured
interval. Normal buffered delivery, native cursors, and live snapshots are
different contracts and retain separate groups. No page emulation is labelled a
native iterator.

| Contract | Executable arms |
| --- | --- |
| PG buffered | raw pg, Turbine PG, supplied-pool core, Drizzle stable, Drizzle RC, Prisma 7 official PG adapter |
| WS buffered over local byte relay | raw Neon Pool, Turbine WS, Drizzle stable, Drizzle RC, Prisma 7 official Neon WS adapter |
| HTTP buffered over actual PG bridge | raw neon HTTP, Turbine HTTP, Drizzle stable, Drizzle RC, Prisma 7 official PrismaNeonHttp |
| Native cursor, PG and WS separately | raw pg-cursor, Turbine cursor; batch size 16, full drain and early return |
| Application hub/refetch, PG | the same six PG read arms composed with the existing application/hub, eight consumers and one shared listener per arm |

Drizzle is exactly 0.45.4 and alias `drizzle-rc` is exactly 1.0.0-rc.5. Prisma CLI,
client, and both official adapters are exactly 7.10.1. Neon is 1.2.0, ws 8.18.3,
pg 8.23.1, and pg-cursor 2.15.3. `contract.mjs` declares every direct tool pin;
the retained npm v3 lock records all transitive resolutions. Prisma's actual v7
WS factory owns its underlying pool; the runner observes and configures that
actual driver before its first checkout. The full arm owns and closes its clients
in every case. Other pools supplied to facades survive facade disconnect before
the arm closes them. Pool max is one for query arms. Live control composition uses
a separate three-slot pool for its listener/writer/query barriers.

Two-write successful commits and duplicate-middle-failure atomic rollback check
all 128 native rows, including unchanged tenant/secret fields and the third write
that must never execute. Core refuses transactions. PrismaNeonHttp 7.10.1 refuses
transactions; its real read arm is retained. HTTP sessions, interactive
transactions, cursors and listeners are unsupported. Core session/cursor APIs
are refused. No Drizzle or Prisma 7 native cursor is claimed by these adapters.
Application composition is labelled explicitly for every ORM and is not a
built-in subscription claim. CDC, durable replay, hosted Neon, TLS/auth/poolers,
SQL Server, remote libSQL, hosted D1 and sync certification are outside scope.

The existing installed ESM/CJS smoke and WS native consumer are reused. The
existing HTTP native contract runs in both formats, including bound parameters,
joins/filter admission, text/value decoding, batch options/rollback, early
refusals, abort-before-effects, and unknown outcome after native commit. UTC is
explicit, matching that fixture's original runner. New physical omission checks
also load and close actual ESM/CJS core with both pg and Neon absent. Installed pg
remains mandatory; import separation does not imply zero installation cost.

Live controls cover rollback silence via a driver-delivery barrier, eight
consumers sharing one listener, termination of an explicitly owned listener
backend, a gated reconnect gap with a missed update, current-state resync,
bounded snapshot coalescing, 1,000 invalidations producing at most one in-flight
read plus one dirty rerun, pending checkout close, and caller ownership. WS
controls include a real pending HTTP upgrade handshake and disconnect. These
controls establish only their stated contracts.

## Samples and resource boundaries

`workload.json` contains `groups[].samples[]`. Buffered/cursor samples retain
`arm`, `transport`, `contract`, `phase`, `round`, `firstResultMs`, `fullDrainMs`,
`rowCount`, `resultSha256`, CPU/memory/FD snapshots, and actual pool observations.
Warm arm order rotates once per round within a transport group. Query pools are
reused; cold samples mean first call on a fresh arm client in a warm process and
server, excluding imports/install. They are not process cold starts.

Buffered first-result time equals decoded full-array delivery. Cursor timing
starts before iterator construction, records the first yielded row and the final
iterator completion, including lease release. Consumers retain the full 64-row
payload for exact validation; this tiny control corpus is not a large-result
memory benchmark. Notification samples are timestamped as each promise resolves,
from immediately before the same-process COMMIT call through the typed snapshot
delivery. They include commit acknowledgement. They are not server commit
timestamps or raw notification wire latency. Eight fanout consumer samples are
correlated and must not be pooled as independent iterations. Notification arms
run serial blocks so other arms do not receive their updates; cross-arm drift
and block order are limitations, not an interleaved latency claim.

`groups[].stats` exposes Bench-compatible name/median/avg/p95/min/n fields plus
raw-sample p50/p99 and serial throughput. It never aggregates medians. p95 is null
below n=20; p99 is null below n=100. Small-n tails are explicitly unavailable or
unstable. CPU is client-process user/system delta; RSS/heap/FD are before/after
observations, not allocation deltas or peak memory. The HTTP bridge is in the
client process and creates a native PG client per request. That overhead is part
of this local bridge scope, not Neon production pooling. Server peak CPU/RSS,
concurrent/saturated throughput, process cold start, type scale, and installation
cost remain unavailable in this runner.

Neon 1.2.0's `query_timeout` callback wrapper is incompatible with pg-cursor's
callback-free Submittable lifecycle. Query arms use matching server-side
statement_timeout=3500 and explicit operation/owned-command deadlines instead of
patching the provider. This observation is version-specific. Controls retain the
earlier failed attempt and do not claim native WS CancelRequest support.

## Ownership, identity, and external integration

The existing `run.mjs`, `lifecycle.mjs`, `native-service.mjs`, PostgreSQL service
helper and HTTP bridge remain read-only. Their process supervision, pidfd,
subreaper, command deadline, signal status, teardown, and resource audits are
reused. Every report retains source/head/path, source and actual executed fixture
hashes, runtime binary/hash, native binary/hash, installed payload hashes, all
driver package identities, lock, server settings, commands/output/exit statuses,
PID/start-time/groups, paths and ports. Installed payload and archive are checked
again after the workload. Disposable consumers/services are removed. Cache and
evidence remain in the explicitly owned HOME scratch.

For actual service signal controls, set `OPTIONAL_PG_CONTROL_SIGNAL=SIGINT` or
`SIGTERM` on a fresh preflight invocation. The runner signals itself after owned
services are ready, then preserves 130/143 and audits teardown. This cannot
collect samples. `audit.mjs OUTPUT_JSON REPORT_JSON...` independently rechecks
retained identities, paths and port release without terminating anything.

`consumer-cost-profiles.UNAPPLIED.patch` proposes five profiles in the **existing**
consumer-cost harness. It changes neither shared files nor guard budgets. It is
syntax/application checked only, not integrated/native certified. It preserves
mandatory pg installation and unavailable initialization where a real transport
or callback is required. Apply it only to a matching harness revision and run the existing checks
for install/type dimensions; no second cost framework is introduced.

```sh
git apply --check tooling/optional-pg-transports/campaign/consumer-cost-profiles.UNAPPLIED.patch
node --test tooling/optional-pg-transports/campaign/contract.test.mjs
```

For a clean checkout without root dev dependencies, `guard-tooling.mjs` can direct
only the existing esbuild lifecycle test to an explicitly owned isolated esbuild
install through `OPTIONAL_PG_ESBUILD` and Node `--import`. It never enters the
workload consumer or changes production resolution. Normal root installs can run
the existing harness tests directly.
