# Benchmarks

Turbine, Drizzle, Prisma and hand-written `pg` measured on the same fixture, with
the arms interleaved so that machine drift lands on all of them at once. The
published figures on turbineorm.dev come from one file, `results-<version>.json`,
which one benchmark round produces.

## A round

`run-round.sh` runs the whole round and builds that file:

1. `build-results.ts env` records the versions (from the installed packages),
   the Postgres server version (from `pg_settings` and `version()`) and the
   machine (CPU model, CPU count, memory, and whether it is a VM).
2. `verify-arms.ts` checks every headline arm against independent SQL results,
   including complete values, ordering, streamed rows and write effects.
   Each headline invocation repeats these checks before warmup or timing.
   The extended, stream-parity, latency and deep-offset suites each run their
   own complete exact-result preflight before the first timing sample.
3. `machine-control.ts before`, a control with no Turbine code in it.
4. `bench-interleaved.ts` (eleven headline scenarios), `bench-extended.ts`,
   `bench-stream-parity.ts` and `bench-latency.ts`, three runs each.
5. `deepoffset.ts`, then `machine-control.ts after`.
6. `build-results.ts build` writes `results.json` (median of the runs'
   medians, per arm per scenario) and `summary.txt` (every derived figure, the
   tie decisions, and the before/after control drift).

Every run waits for a quiet machine first, and a run that finished while the
machine was busy is thrown away and repeated. Quiet means CPU idle at or above
`QUIET_IDLE` percent (80 by default) for `QUIET_HOLD` samples in a row, read from
`/proc/stat` on Linux and `top` on macOS. The header of `run-round.sh` lists
every setting.

`build-results.ts build` reads only the output directory, so the same logs
always give the same `results.json`, and a round can be rebuilt without
measuring again.

## Full native engine comparisons

The common runner selects PostgreSQL by default. `BENCH_ENGINE=sqlite` or
`BENCH_ENGINE=mysql` selects the full engine catalog and a separate results
file. Stop concurrent builds, tests and comparison workers before setting
`COMPARISON_SERIALIZED=1`. The host quiet gate still applies before and after
each measured suite; this marker does not establish a quiet machine by itself.
`QUICK=1` is a plumbing smoke, never a final comparison.

```bash
# From benchmarks/, with the locked dependencies installed and root dist built:
npm run setup:sqlite
BENCH_ENGINE=sqlite COMPARISON_SERIALIZED=1 ./run-round.sh /tmp/sqlite-round

# Use a disposable MySQL database; never seed a production endpoint.
npm run setup:mysql
MYSQL_COMPARISON_OWNED=1 npm run seed:mysql
BENCH_ENGINE=mysql COMPARISON_SERIALIZED=1 ./run-round.sh /tmp/mysql-round
```

SQLite seeds and removes its own fixture. MySQL requires the seeded database;
`mysql-comparison-native.ts` also provides a disposable service launcher for
correctness and control runs. `bench-sqlite.ts --verify-only --full` writes the SQLite support catalog
and `bench-mysql.ts --catalog` lists MySQL support and refusal reasons. Both native launchers require the exact Node 24.10 runtime. The SQLite catalog includes 63 scenarios; MySQL
accounts for all 47 entries, retaining unsupported cells explicitly.

Stable Drizzle 0.45.4 and candidate Drizzle 1.0.0-rc.5 are separate arms.
PostgreSQL includes the RC arm by default. Prisma uses matched 7.10.1
client/CLI/adapters only where supported. `comparison-versions.json` records
the registry snapshot; installed versions are captured again in each report.
SQLite's node:sqlite and Prisma's better-sqlite3 can embed different SQLite
versions; these results are not a matched-driver comparison. Native MySQL
RETURNING, unsupported bindings and stream page emulation remain separately
labeled. No aggregate cross-engine score is produced.

The collectors preserve full headline/extended/secondary catalogs, source
hashes, versions and cleanup evidence. They reject missing arms, preflight-only
reports, incomplete samples and mixed provenance. SQLite admission requires
the exact delivered row counts, transaction/refusal observations, source inputs
and successful native closure for every expected handle. MySQL admission binds
the exact correctness inputs and compares server version, full SQL mode,
isolation, fixture identity and per-arm transport policy across repeats;
ephemeral ports and data directories may differ. Focused admission checks use
native positive reports plus disposable synthetic timing cells, never synthetic
performance evidence:

```bash
SECONDARY_POSITIVE_DIRECTORY=/tmp/secondary-native \
  node --import tsx --test secondary-results.test.ts
COMPARISON_POSITIVE_DIRECTORY=/tmp/native-comparison-controls \
  node --import tsx --test comparison-results.test.ts
# Fresh generation from benchmarks/, including the old-path failure control:
node --import tsx --test sqlite-generation-path.test.ts
node --import tsx --test mysql-comparison-cleanup.test.ts
```

The latter directory contains `sqlite-controls/none.json` from
`sqlite-comparison-controls.ts` and `mysql-ordinary.json.comparison.json` from
`mysql-comparison-native.ts`. Full campaigns retain each invocation's report,
including refused and not-applicable catalog cells, rather than converting them
to passing measurements.

MySQL pool shutdown can finish locally before the server consumes its quit
message. Cleanup observes the native process list for at most two seconds,
records each observation and still refuses any remaining backend. This happens
after measurement; the wait is never included in a timed call.

## On the benchmark runner

The `Benchmarks` workflow runs a full round on a GitHub-hosted `ubuntu-latest`
runner, with PostgreSQL 17 in Docker on the same VM, reached over a Unix socket.
Hosted VMs differ in CPU model from run to run, so compare ratios within a round.
It only runs when dispatched:

```bash
gh workflow run benchmarks.yml                     # this commit
gh workflow run benchmarks.yml -f ref=v0.91.0      # another release, same harness
gh workflow run benchmarks.yml -f quick=true       # smoke run, numbers are meaningless
```

With `ref`, the library is built from that ref and the harness (this directory)
comes from the workflow's own commit, so two releases are compared on the same
scenarios. The run uploads its output directory (every log, `env.json`,
`summary.txt`, `results.json` and the Postgres server log) as the artifact
`benchmark-round-<run id>`:

```bash
gh run download <run id> --dir /tmp/round
cp /tmp/round/benchmark-round-*/results.json benchmarks/results-<version>.json
```

## Locally

Use a database you can drop, reached over a Unix socket:

```bash
createdb turbine_bench
export DATABASE_URL="postgresql:///turbine_bench?host=/tmp"

npm ci && npm run build                        # repo root: the harness imports dist/
cd benchmarks && npm ci && npx prisma generate
npx tsx seed-neon.ts                           # 1,000 users, 10,000 posts, 50,000 comments
psql "$DATABASE_URL" -c ANALYZE
(cd .. && node dist/cli/index.js generate --out generated/turbine)

COMPARISON_SERIALIZED=1 ./run-round.sh /tmp/round
```

Rebuild the library after any change to `src/`: the harness resolves
`turbine-orm` to the repo root's `dist/`, so an unbuilt tree measures stale code.

`QUICK=1 ./run-round.sh /tmp/round` runs the same pipeline with tiny round
counts in a few minutes, with the quiet gate off. It proves the pipeline works
end to end on any machine, busy or not. Do not publish its numbers.

Absolute times are a property of the machine. Compare ratios within one round,
never absolute numbers across rounds or machines.

## Exact headline preflight

`npm run bench`, `bench:quick`, `bench:interleaved` and `npx tsx verify-arms.ts`
use the same headline arm definitions. The legacy `ITERATIONS` setting maps to
`ROUNDS` for `npm run bench`; its output now uses the interleaved harness. Direct
runs check the selected stable/raw arms and, with `INCLUDE_RC=1`, the RC JIT arm.
The standalone verifier additionally checks the RC no-jit control on every
scenario. `TURBINE_JSON` and `TURBINE_STREAM` retain their existing switches.

The oracle reads ordered flat tables through the driver and independently
assembles nested expectations. It compares every field and array position,
checks all 50 rotating user ids, and observes each of the 50,000 streamed rows.
A nonempty 1,000/10,000/50,000 fixture is required. Missing columns, extra columns,
undefined versus null, invalid dates, unsafe numeric integers and differing
arbitrary-precision values fail. Integer representations normalize with exact
integer arithmetic; decimal text is never converted to a JavaScript number.
The oracle overrides the int8 parser per query to preserve its independent
exact values without changing any client's parser configuration.

Increment arms all return the updated row. An independent before/after read
checks every post column, the intended single increment and absence of other
row changes, then restores counters outside timing, including on verification
failure. A plausible returned row alone cannot satisfy this check. Timed
increments retain their database effects; use only the disposable benchmark DB.

The dashboard is measured twice. The pipeline row compares independent reads
against independent concurrent reads, without transaction guarantees. The
transaction row uses one explicit READ COMMITTED transaction and one pinned
connection in every arm, including raw SQL. READ COMMITTED provides statement
snapshots, not a shared snapshot across the five reads. Both rows return all
five results and choose recent posts by `createdAt DESC, id DESC`. Flat and
nested list arms also state their ordering before applying limits.

Headline JSON identifies this contract as
`headlineSemantics: exact-ordered-pg-supplied-named-v2`. Every headline arm uses
the benchmark's locked PG driver in a separate pool with maximum size 10.
Turbine receives its pool from the caller and explicitly retains named prepared
statements; the preflight asserts the pool identity, emitted prepared name and
the presence of native prepared statements on its backend.
This differs from the former default-owned driver profile, so v1 logs cannot
be mixed into the new campaign. Default-owned/cold profiles remain separate.
Both aggregation commands require that version and matching complete scenario
and arm catalogs, and retain the marker in derived JSON. Historical/unversioned
logs must be processed with their original harness; they cannot join this campaign.
These query, RETURNING and transaction changes establish a new semantic
baseline. Do not compare their absolute times with earlier count-only runs.
Streaming still compares cursor and keyset strategies with different snapshot
and iteration costs; the scenario note remains part of its interpretation.
The transaction scenario is included in raw headline logs; the existing site's
fixed core-results catalog still publishes the original ten scenario slots.

After the normal setup, check headline types with
`npx tsc --project benchmarks/tsconfig.json` from the repository root. This
requires both generated clients. Run the database-free oracle/failure-injection
tests from the root with
`npx tsx --test src/test/benchmark-equivalence*.test.ts`.

### PostgreSQL stream, latency and pagination contracts

The original `bench-stream-parity.ts`, `bench-latency.ts` and `deepoffset.ts`
entry points accept `--preflight`. They require the original full fixture and
verify complete ordered values against flat raw-driver snapshots before any
timing. The latency suite keeps all three scenarios at RTT 0/1/5/25, with
rollback and disconnected-transaction controls. RTT 0 still traverses the
proxy; requested delays are not a calibrated physical network model.

All arms use separate supplied pg pools of ten with the locked benchmark
driver. Turbine explicitly retains named statements; native protocol
observations distinguish named, unnamed, cursor, page and pipeline routes.
The stream comparison consumes all fields through the same bounded canonical
hash fold. Prisma's arm is keyset page emulation. Its timings cannot be mixed
with historical count-only drains. In this two-driver-copy profile, public
stream cancellation refuses with E017 before SQL; ordinary drains and early
consumer cleanup are exercised.

The original published-post predicate matches 1,400 rows, so offset 9,000 is
an empty-page workload. It remains labeled as such and has a nonempty offset
40 correctness control. It does not establish deep nonempty-page performance.

Reports use `secondarySemantics: pg-secondary-exact-ordered-v1` and
`SECONDARY_REPORT` can retain each JSON report. `run-round.sh` executes all
three preflights before timing. Aggregation refuses preflight-only, incomplete,
incompatible or failed reports and changes in provenance between repeats.
`results.json.secondary` retains every scenario and arm, including distinct
Drizzle stable/RC entries. The older site fields are compatibility views.

For local native correctness on exact Node 24.10.0, `secondary-native.mjs`
creates and removes a private PostgreSQL 18.6 cluster, seeds the full fixture,
regenerates the PG client, and runs all preflights plus nine deliberate failure
controls. It never starts final timing. Set `SECONDARY_PG_PREFIX` to the
directory containing PostgreSQL's `bin`, `lib` and `share` directories:

```bash
node benchmarks/secondary-native.mjs /tmp/secondary-correctness-new
SECONDARY_POSITIVE_DIRECTORY=/tmp/secondary-correctness-new \
  node --import tsx --test benchmarks/secondary-results.test.ts
```

Execution uses the local built package payload. When that payload is taken
from a retained archive, set `SECONDARY_TURBINE_ARTIFACT` to record its path and
hash and separately verify all local payload files match it. This is distinct
from an installed-package consumer test. Final timing requires integrated
adapters, quiet workers, explicit host conditions and serialized campaigns.

## Current comparison dependencies

`comparison-versions.json` records the registry snapshot used by the locked
benchmark package. Drizzle stable 0.45.4 and candidate 1.0.0-rc.5 are separate
arms. Prisma CLI, client and adapters use the matched 7.10.1 release. The CLI's
`latest` tag currently resolves to 8.0.0-rc.30, but matching client and pg adapter
lookups return E404. That CLI is not a runnable matched Prisma 8 arm here.

The SQLite adapter uses better-sqlite3 12.11.1, the current compatible 12.x
release in its declared range; better-sqlite3 13.0.3 is a different dependency
profile. Turbine uses `node:sqlite`. Prisma's MySQL adapter uses mariadb 3.5.4,
while native Turbine and Drizzle use mysql2. Record actual driver and embedded
SQLite versions, pool sizes, transactions and result contracts in each campaign.
These adapter differences are part of the comparison, not hidden equivalence.

Dependency installation and smoke queries do not complete the full comparison.
The original suite and its exact preflights remain the campaign entry points.
Parallel setup work must finish before serialized final timing; record residual
host contention even after the participating workers are quiet.
