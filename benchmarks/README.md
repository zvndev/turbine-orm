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
2. `verify-arms.ts` proves every arm returns the same rows. Nothing is timed
   until it passes.
3. `machine-control.ts before`, a control with no Turbine code in it.
4. `bench-interleaved.ts` (the ten core scenarios), `bench-extended.ts`,
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

## On the benchmark runner

The `Benchmarks` workflow runs a full round on a dedicated self-hosted runner,
with PostgreSQL 17 in Docker on the same VM, reached over a Unix socket. It only
runs when dispatched:

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

./run-round.sh /tmp/round
```

Rebuild the library after any change to `src/`: the harness resolves
`turbine-orm` to the repo root's `dist/`, so an unbuilt tree measures stale code.

`QUICK=1 ./run-round.sh /tmp/round` runs the same pipeline with tiny round
counts in a few minutes, with the quiet gate off. It proves the pipeline works
end to end on any machine, busy or not. Do not publish its numbers.

Absolute times are a property of the machine. Compare ratios within one round,
never absolute numbers across rounds or machines.
