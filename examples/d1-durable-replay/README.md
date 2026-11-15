# Local D1 durable order replay

Call `demo(binding)` from `demo.ts` with a caller-owned local D1 binding. It initializes five fixed tables, appends an exact-value order by stable ID, polls a bounded prefix, applies an idempotent destination, acknowledges it, and closes both application facades. The binding remains usable. The demo terminates and is safe to rerun with the identical command.

Read the complete [contract](../../docs/d1-durable-replay.md) before adapting it. Delivery callbacks run outside D1 atomic batches and may be duplicated concurrently. Native batches cannot be cancelled. Post-dispatch errors require reconciliation. Exact bigint, decimal, microsecond time, and bytes are explicitly encoded in canonical TEXT.

For installed ESM/CJS, generated strict and Worker execution on local workerd, run the explicit [native fixture](../../src/test/fixtures/d1-durable-replay/run.mjs) with the documented owned root, exact Node binaries, and npm CLI. Native integration is separate from the ordinary source unit tests and is never silently skipped.
