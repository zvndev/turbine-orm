# Durable orders on local SQLite

This example composes public `turbineSqlite(...).transaction`, guarded transaction
queries and `rawUnsafe` into an application-owned order/outbox/checkpoint workflow.
It needs a persistent local `node:sqlite` file, Node 22.16 or 24.10, and no server.
The [contract](../../docs/sqlite-durable-replay.md) explains locking, exact values,
at least once effects, cancellation, ownership and the finite limits.

From a built repository checkout with its development dependencies installed:

```sh
npm run build
node --import tsx examples/sqlite-durable-replay/demo.ts "$HOME/.cache/sqlite-order-demo"
node --import tsx examples/sqlite-durable-replay/demo.ts "$HOME/.cache/sqlite-order-demo"
```

Use a directory owned exclusively by this demo. The first run creates the fixed
schema, appends three immutable orders and drains them to an independent SQLite
destination. The second reuses the exact event identities, reads the durable
checkpoint and creates no additional destination rows. Both runs close their
handles; the two files remain for restart. No reset, drop or destructive cleanup
command is provided. A partially initialized directory is refused, not reset.

`replay.ts` owns the fixed application protocol, `destination.ts` illustrates
destination idempotency, and `demo.ts` owns the handles and signal handlers.
Copy the files into a project with the same public Turbine package installed;
they also compile strictly as ESM and CommonJS. `type-consumer.ts` is a compile
fixture and is never invoked by the demo.

For the source regression, using an owned cache for every disposable file:

```sh
mkdir -p "$HOME/.cache/sqlite-replay-tests"
TMPDIR="$HOME/.cache/sqlite-replay-tests" TURBINE_REQUIRE_ENGINE=sqlite \
  node --import tsx --test src/test/sqlite-durable-replay.test.ts
```

Only application writes following this protocol are captured. Polling is local
reconciliation; SQLite CDC, notifications, hosted engines, optional bindings,
performance results and support-tier changes are outside this example.
