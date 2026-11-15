# Original PostgreSQL installed-artifact preparation

This launcher reuses the original headline, extended, stream, RTT and deep-offset suites. Its default mode performs exact preflights and held-out controls without comparative timing. It installs a caller-specified archive into an owned scratch directory with the existing benchmark lock. Only the scratch manifest/lock replace the local `file:..` link with that archive and its integrity. Baseline manifests and pins remain unchanged.

Use exact Node 24.10.0 and PostgreSQL 18.6. Drizzle stable 0.45.4 and `drizzle-rc` 1.0.0-rc.5 stay separate. Prisma client, CLI and official PostgreSQL adapter remain 7.10.1. Prisma8 is outside this runner.

```bash
NODE24="${NODE24:?absolute Node 24 binary path}"
"$NODE24" benchmarks/pg-preparation/run.mjs \
  --artifact /absolute/path/to/final-tested.tgz \
  --sha256 ACTUAL_FINAL_SHA256 \
  --output /absolute/path/to/new-preflight-directory \
  --pg-prefix "${PG_PREFIX:?local PostgreSQL installation}" \
  --port 56465 \
  --service-root "${SERVICE_ROOT:?fresh local service directory}"
```

The archive is never rebuilt or repacked. Installed payload files are independently compared byte for byte with an extracted copy. The runner retains archive/runtime/server/driver hashes, the transformed install lock, generated client, exact commands, all suite reports and cleanup evidence. Local source/dist timing is unavailable in this scope. Secondary reports distinguish absent local source/dist identity from the actual installed distribution hash.

| Catalog | Preparation coverage |
| --- | --- |
| Headline | 11 original scenarios, 53 ordinary arms plus 11 optional RC no-JIT controls |
| Extended | 17 original rows, 93 arms, 113 independent verification cases |
| Stream | 7 original arms; native Turbine cursor versus version-specific Prisma7/Drizzle keyset pages |
| RTT | 3 original scenarios at 0/1/5/25ms, 72 arms; proxy to owned PG Unix socket |
| Deep offset | Nonempty offset40 control and original empty offset9000, 14 arms |
| Negative controls | Original secondary and extended held-out defects; headline omissions/content/no-write checks; every extended row and arm omission |

All original notes remain in reports: independent pipelines differ from READ COMMITTED transactions; batched relations have separate statement snapshots; cold clients establish `SELECT 1` untimed and use separate real pools with max10; variable-arity child statements stay unnamed. Raw L3 headline arms are absent in the original catalog. Flatten is unsupported for to-many. A native shared pg module admits stream AbortSignal; a foreign compatible wrapper or distinct module is refused with E017 before SQL. Native abort coverage here stops after the first batch and makes no in-flight backend-cancel claim.

`--smoke` additionally executes one retained sample per ordinary arm to check output plumbing. Stream overrides and drift/machine-control diagnostic counts retain their original behavior. This mode is explicitly marked noncomparative and never accepted timing evidence. `--fault worker-failure` and `--fault signal` exercise actual owned-service failure/SIGTERM cleanup and must exit nonzero.

Run final measurements serially on an idle machine. Each invocation uses a fresh service, the original fixture, all five suites and before/after raw controls. The default runs three process repeats inside the same installed consumer and seeded service, preserving fixture timestamps and execution paths:

```bash
PG_BENCH_SERIALIZED=1 "$NODE24" benchmarks/pg-preparation/run.mjs \
  --artifact /absolute/path/to/final-tested.tgz \
  --sha256 ACTUAL_FINAL_SHA256 \
  --output /absolute/path/to/new-final-pg-run-1 \
  --pg-prefix "${PG_PREFIX:?local PostgreSQL installation}" \
  --port 56465 \
  --service-root "${SERVICE_ROOT:?fresh local service directory}" \
  --expected-manifest /absolute/path/to/expected-final-manifest.json \
  --runs 3 --timing
```

A correctness preflight emits `observed-identity.json` and `admission-candidate.json`. Supply an independently prepared manifest of the final archive, source, installed dependencies, generated output and server through `--expected-manifest`. Timing requires a clean checkout and exact equality with that input. Generated output uses `--no-timestamp`. The output directory must be absent before invocation; repeat validation requires the same fixture across repeats.

Timing requires `PG_BENCH_SERIALIZED=1` and fails if a one-second `/proc/stat` observation is below 80% CPU idle before or after a suite. The runner does not wait for a quiet interval. `timingAccepted` remains false until the complete run is validated. Existing round and warmup configurations remain available; no timing is accepted automatically.

`BENCH_RETAIN_SAMPLES=1` enables backwards-compatible execution-order `samplesMs` in existing Bench callers. `summarizeSamples()` also serves the original extended cold path and raw machine controls. Each record retains n and method: arithmetic median p50, nearest-rank p95/p99. p99 is null below100 samples, marked unstable for100–999, and estimated from1000 onward. Percentiles are never computed from arm medians. No global RSS, independent throughput, install/type score or hosted-service certification is inferred. Worker resource diagnostics include untimed work and exclude child processes.

Services and workers use the established PostgreSQL process-group supervisor with PID/starttime identity checks, deadlines and escalation. The final audit checks owned PIDs/groups, retained child identities, observer, service paths and port. It removes scratch installs/caches on success, failure and handled SIGINT/SIGTERM. Existing output directories are refused. Foreign services are never stopped.

Result validation defaults to final scope and refuses missing external identity, absent executed inputs, changed Node/archive hashes, incomplete arm sets or summary-only samples. Explicit historical scope permits older reports without supplying missing provenance. Preparation scope checks observed inputs and samples without claiming comparative results. Extended unsupported flatten declarations are versioned.
