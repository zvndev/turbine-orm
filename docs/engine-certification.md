# Engine evidence and certification

YugabyteDB is a **candidate, uncertified integration**. PostgreSQL wire
compatibility and a successful statement-timeout smoke do not establish full
engine support. The nightly job exercises only the Yugabyte adapter's
transaction-local timeout SQL and a subsequent `SELECT 1`; it does not test
cancellation, migrations, distributed locking, retries, failover, query/type
correctness or the complete application lifecycle.

The scheduled `yugabytedb-integration` job launches the stable
`2026.1.2.0-b137` image, pinned by digest, using the foreground command from
[Yugabyte's Docker quickstart](https://docs.yugabyte.com/stable/quick-start/docker/).
It preserves the image's `/sbin/tini --` entrypoint. Launch is a normal step so
container startup failure can retain artifacts. A bounded `pg` query against the
same endpoint used by the smoke must observe a Yugabyte `version()` response
before tests run. Exhausted retries fail explicitly. The smoke sets
`TURBINE_REQUIRE_ENGINE=postgres` because its availability guard checks
`DATABASE_URL`; `TURBINE_TEST_ENGINE=yugabytedb` selects the adapter.

The nightly job fails on launch, readiness or smoke failure. It is scheduled
only, outside the reusable PR/release gates. Its status never authorizes a
publish. GitHub's current [service syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idservicesservice_idcommand)
supports `services.<id>.command`; moving launch into a step addresses evidence
collection rather than an invalid command key.

## Evidence format v1

The `yugabytedb-candidate-<head>` artifact retains `evidence.json`, container and
launch logs, and `tests.tap` when tests execute, including after ordinary job
failure. Cancellation, runner loss or failure before checkout/setup can prevent
artifact collection; absence is missing evidence, never success.

| Field | Meaning |
| --- | --- |
| `schemaVersion`, `scope` | `1`, `ysql-statement-timeout-smoke-v1` |
| `supportStatus`, `certified` | Always `candidate`, `false` in this schema |
| `outcome` | `passed`, `failed`, `readiness-failed`, `skipped`, `missing`, `incomplete` or `unsupported` |
| `observedAt`, `head` | Observation timestamp and checked-out Git head |
| `image` | Requested immutable reference and Docker-observed image ID |
| `engine` | Observed engine identity and YSQL's reported Yugabyte version, independent of the requested image tag |
| `driver`, `transport`, `runtime` | Installed `pg` version, observed TCP binding, actual Node version |
| `readiness` | `missing`, `ready` or `failed`, with actual probe attempts |
| `tests` | Fixed test scope, outcome, process exit code, TAP counts and log SHA-256 |
| `failureCode` | Generic failure stage/code without connection secrets |

Unobserved identities and versions are `unknown`; absent process results and
counts are `null`. A passed smoke requires all provenance fields, positive
readiness, the two expected test identities, exit zero, two passes, zero skips,
failures, cancellations and todos, and a matching retained log. Missing,
corrupted or contradictory successful observations are rejected. No outcome in
this schema can become `certified`; a future certification policy needs a
separate, broader scope and evidence review.

The helpers use existing dependencies. Run their synthetic positive and negative
controls with:

```sh
npx tsx --test src/test/engine-certification*.test.ts
```

The existing unit gate includes these files. These controls verify the guards
and reporter contract; they do not demonstrate a live engine. A fresh successful
nightly artifact is required even for the narrow smoke result. Full engine
certification requires versioned lifecycle, correctness, recovery and package
consumer evidence for each engine/server/driver/transport/runtime combination.
