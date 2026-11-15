# Native packed consumer contracts

See [the executable contract and limitations](../../docs/native-value-contracts.md).

- `verify.mjs`: required native packed archive verification; every failed scope makes the command fail.
- `corpus.mjs`: held-out native DDL, exact expected rows, strict application and negative compiler calls.
- `postgres-service.mjs`: exclusive disposable PostgreSQL process ownership. MySQL reuses the existing lifecycle service helper unchanged.
- `harness.test.mjs`: dependency-free anti-vacuous controls for the existing Node 20/22/24/26 unit matrix.
- `cleanup.test.mjs`: required native post-start, corrupt-effect and signal failure cleanup checks.
- The guard suite runs in the existing Node 20/22/24/26 unit matrix; no new jobs or thresholds.

Run evidence belongs outside this source directory. Each invocation requires a
new output directory and removes its own random temporary service/application
root. Existing lifecycle, upgrade and evidence harnesses are read-only inputs.
