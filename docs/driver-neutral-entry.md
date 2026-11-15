# Supplied-transport core entry

`turbine-orm/core`, added in 0.94.0, provides `turbineCore` and `CoreClient`
for ordinary SQL execution through an explicitly supplied `PgCompatPool`, for
ESM and CommonJS consumers. This addition does not change engine support tiers
or certify a provider.

```ts
import { turbineCore, type PgCompatPool } from 'turbine-orm/core';
import { schema } from './schema.js';

const pool: PgCompatPool = applicationTransport;
const db = turbineCore(pool, schema, {
  ownership: 'caller',
  globalFilters: { invoices: { tenantId: requestTenant } },
});

const invoices = await db.table('invoices').findMany({
  orderBy: { id: 'asc' },
  limit: 20,
});
await db.disconnect();
```

`table<T>(name)` uses the existing query compiler, cached statements, row
parsers, projection policy, middleware and global-filter validation. `raw`,
`sql`, `rawUnsafe` and `rawQuery` use the supplied pool too. `raw` and `sql` are
tagged templates that parameterize interpolated values. `rawUnsafe` and
`rawQuery` take SQL text; callers must keep untrusted data in their parameter
arrays. Raw SQL does not acquire table-level global filters or projection
policy.

The pool must provide `query(text, values)`, `connect()` and `end()`. The core
never calls `connect()`: its presence preserves the existing pool interface,
while adapters can implement it as a refusal. Prepared statement names are
disabled, so the pool receives the two-argument query form. Supply a `dialect`
for another SQL transport. The dialect owns SQL rendering and wire decoding;
this entry does not detect or import an engine driver.

`CoreOptions` accepts ordinary `QueryInterfaceOptions`, excluding transaction
internals and the query-interface factory, plus `ownership` and
`getTypeParser`. Internal transaction flags supplied from untyped code are
removed. The factory creates dynamic table getters where names do not collide
with client members; `table<T>(name)` is the explicit typed accessor.

## Ownership and shutdown

`ownership: 'caller'` is the default. Disconnect seals this facade and its
cached table and lazy SQL handles, waits for admitted statements to settle,
and leaves the pool open. `ownership: 'client'` additionally calls `pool.end()`
exactly once. Concurrent or repeated disconnects share the same promise,
including a pool-close failure. Shutdown has no implicit deadline and cannot
force an arbitrary transport's remote operation to stop.

A query timeout retains the existing query engine's behavior for a transport
without backend cancellation: the caller receives a timeout with outcome
`unknown`, and the remote operation may still finish. Disconnect waits for
that admitted operation. The core does not add remote AbortSignal support or
promise rollback after cancellation.

## Session refusal boundary

The following operations fail locally before callbacks, SQL or checkout:

- Callback and deferred `$transaction`, `transaction`, `$withSession` and
  `$connection`.
- Extended-query `pipeline`, `$listen` and `$notify`.
- `findManyStream` and `findManyStreamBatches`, on iterator consumption.
- Row-locking reads, nested writes and upserts requiring an implicit lookup
  transaction.
- Transaction-control statements recognized by the existing engine lexer in
  raw SQL, including control after another statement.

A transport-specific binding can expose its own native atomic batch API.
Persistent WebSocket and local libSQL bindings can use the existing full
client when they need interactive transactions. Raw SQL remains an escape
hatch: the transaction-control lexer cannot establish whether arbitrary SQL,
stored functions or application extensions require session affinity.

## PostgreSQL parsing and compatibility

Default synchronous `new TurbineClient(config, schema)` construction and its
PostgreSQL parsers, transactions and native cancellation remain in the
existing entry. The package retains its mandatory `pg` dependency. Installing
the package normally still installs `pg`; the optional graph does not resolve
it when that graph is imported.

The supplied transport owns its ordinary row decoding. No global driver
parser is installed by the core. With the default PostgreSQL dialect, relation
columns that require PostgreSQL wire coercion use the explicit
`getTypeParser(oid, 'text')` callback. Without it, those decoded wire values
raise `UnsupportedFeatureError` instead of borrowing a native parser from
another entry. Supply the same scalar, array and temporal readings on the
transport as the schema expects. A transport-specific dialect can supply its
own JSON wire rules.

The existing `query/utils.ts` compatibility exports retain native parser
functions. The shared implementation in `query-utils.ts` reaches native
parsers and protocol cancellation through module-local runtime registration, populated by the
PostgreSQL compatibility entry. That runtime is local to each module copy,
like the existing `TransactionClient` registration slot. Loading the core
alone does not register a transaction client. The core's explicit PostgreSQL
relation decoders do not depend on that native runtime.

## Evidence and runtime scope

Focused source tests exercise SQL values and ordering, parsing, filters,
middleware, failures, timeouts, ownership and refusal before dispatch. Native
PostgreSQL tests require `DATABASE_URL`; setting
`TURBINE_REQUIRE_ENGINE=postgres` turns an unavailable prerequisite into a
failure.

The import guard rejects database-driver imports before tree shaking and
includes a native-client failure control. Packed tests use an isolated copy
with the proposed export map, retain mandatory `pg` installation first, then
remove it only inside the consumer fixture. They check ESM/CJS resolution,
strict TypeScript consumers without `@types/pg`, missing-driver controls and
an omitted-export failure control. A narrow native `node:sqlite` supplied-pool
fixture demonstrates installed execution; it does not certify a SQLite
adapter or duplicate its dialect.

The edge graph requires `node:async_hooks` support. Local Miniflare/workerd
execution with `nodejs_als` proves a Worker runtime using a simulated supplied
transport. It does not prove a hosted provider, remote database or ordinary
browser runtime. Optional packed/Worker prerequisites are required when
`TURBINE_DRIVER_NEUTRAL_PACKED=1`; excluded suites are reported as skips, not
passes. Package exports and CI wiring supplied as integration patches are
separate from committed source behavior.
