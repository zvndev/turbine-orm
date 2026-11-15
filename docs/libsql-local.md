# Local libSQL execution

This document describes the optional local libSQL binding added in 0.94.0.
It uses `@libsql/client` and libSQL's SQLite fork. It is Deferred in the
[engine support matrix](engine-support.md): no further work is planned this
cycle and no support is promised.

The scope is Node.js with `:memory:` or a local `file:` URL. Remote libSQL/HTTP/
WebSocket URLs, file URLs with remote hosts or query parameters, replicas, sync,
encryption configuration, and the rewritten Turso engine are outside this
contract. The `@tursodatabase/database`, `/sync`, and `/serverless` packages are
separate implementations. No cloud or provider-hosted execution is implied.

## Open a local database

Install the optional `@libsql/client` package with its platform-native engine.
Import the new entry explicitly; existing public entries do not import it.
The callback transaction implementation currently retains the full
`TurbineClient` and its pg dependency graph. This binding is not pg-free.

```ts
import { defineSchema, schemaDefToMetadata, schemaToSQL } from 'turbine-orm';
import { libsqlDialect, turbineLibsql } from 'turbine-orm/libsql';

const definition = defineSchema({
  users: {
    id: { type: 'serial', primaryKey: true },
    name: { type: 'text', notNull: true },
    enabled: { type: 'boolean', notNull: true },
  },
});
const db = await turbineLibsql('file:app.db', schemaDefToMetadata(definition));
try {
  // Bootstrap a new, empty database. This is not a migration runner.
  for (const ddl of schemaToSQL(definition, { dialect: libsqlDialect })) {
    await db.rawUnsafe(ddl);
  }
  await db.table('users').create({ data: { name: 'Ada', enabled: true } });
  const users = await db.table('users').findMany({ orderBy: { id: 'asc' } });
} finally {
  await db.disconnect();
}
```

A string target creates an owned client with `intMode: 'bigint'` and one native
connection. Disconnect waits for active adapter leases, closes that client once,
and makes further adapter operations fail. A forced disconnect deadline is
refused because the synchronous native operation cannot be interrupted.

For a caller-owned client, pass `{ client, url }`. It must be an open native
local client created with `intMode: 'bigint'`. The adapter checks `protocol ===
'file'` and probes exact integer decoding before application writes. The URL is
an explicit caller attestation that the client uses that local database without
sync or replicas. The driver's private configuration cannot be inspected, so the
adapter cannot verify this attestation. Never pass a replica or remote client.

```ts
import { createClient } from '@libsql/client/node';
const client = createClient({ url: ':memory:', intMode: 'bigint', concurrency: 1 });
const db = await turbineLibsql({ client, url: ':memory:' }, metadata);
try {
  // Use db here. External client operations are the caller's responsibility.
} finally {
  await db.disconnect(); // closes adapter leases, leaves client open
  client.close();
}
```

A supplied client's already-open transaction remains the caller's. Construction
fails if that transaction prevents the read-only probe, without closing either
resource. Do not share the native client concurrently with the adapter: direct
external operations bypass adapter ordering and ownership checks.

## Values and typed queries

The binding reuses SQLite query and DDL generation. Typed writes, projections,
filters, nested relations, join/batched/flatten reads, deferred queries and
callback transactions run against the actual optional client.

| Value | Binding and result |
| --- | --- |
| Integers | Safe integral JS numbers bind as native INTEGER. Safe integers return numbers; wider signed 64-bit values return exact decimal strings. `bigint` writes retain native range checks. |
| REAL | Retains the driver's number result. Relation JSON carries enough precision to reconstruct the stored double. |
| Boolean | Binds as 0/1. Typed schema reads and native declared-BOOLEAN raw columns decode as booleans. |
| JSON | Binds as JSON text. Typed schema reads decode JSON; malformed text inserted externally stays text. |
| Date | Binds as ISO text, matching the portable SQLite query contract. Typed temporal reads return `Date`. This intentionally differs from the driver's direct Date-to-epoch binding. |
| BLOB | Accepts `Uint8Array`, Buffer and ArrayBuffer. Results are `Uint8Array`; nullable relation BLOBs preserve null. |
| Null/undefined | Bind as SQL NULL on raw bindings. Normal typed-write omission rules still apply. |
| Nonfinite number | Direct native bindings refuse NaN/Infinity. SQLite `IN` JSON expansion remains the portable dialect's existing encoding. |

Native `rowsAffected` supplies write counts; row-producing statements use their
actual returned row count. Raw result decoding follows native column types,
without guessing a table from an output alias. Schema-only BOOLEAN/JSON decoding
belongs to typed accessors; a raw read of an INTEGER/TEXT column stays as stored.

Raw values use `$1`, `$2`, and so on, and generated SQL uses `:p1`, `:p2`.
Repeated or reordered placeholders retain their parameter identity. Quoted SQL,
identifiers and comments do not bind values. Missing/unsupported placeholders,
NUL bytes and multiple statements fail before execution, since the native client
otherwise silently ignores trailing statements. Trigger bodies with internal
semicolons are conservatively refused by this entry's statement admission check.

## Transactions, batching and cancellation

Each adapter lease is exclusive. Unrelated adapter operations wait in submission
order while a transaction holds its lease. Native transactions are acquired using
`client.transaction('write')`, giving the adapter an actual libSQL transaction
object. COMMIT/ROLLBACK call its native methods; release closes any unfinished
transaction, rolling it back before the next lease proceeds. Caller-owned client
shutdown is independent of these adapter-owned transaction lifetimes.

If native COMMIT or ROLLBACK rejects and transaction close also throws, the
completion rejection stays primary, including its original native code and cause.
The adapter retains the first close rejection separately: disconnect and repeated
disconnect reject with that exact reason, even when it is `undefined`, `null`,
`false` or `0`. A cleanup failure closes adapter admission and refuses queued and
later lease work. Release still attempts transaction cleanup and releases its
queue slot; a later successful close does not erase the recorded failure.

A successful native COMMIT followed by a close failure also rejects, but its
writes are already committed. Neither rejection triggers a COMMIT retry or a
callback replay. A close that throws before closing can leave native state
unresolved; adapter refusal is not proof of rollback or native lock release.
Disconnect closes a factory-owned client once and leaves a supplied client under
its caller's control. If factory-client close also throws, an earlier transaction
cleanup rejection remains primary; without an earlier cleanup failure, the
factory-client close rejection is returned unchanged. The adapter never closes a
supplied client to recover from transaction cleanup failure.

Use the callback's `tx` for transaction work. Calling the root client, opening a
second root transaction, or disconnecting from its active callback fails instead
of waiting on its own lease. Escaped transaction handles reject late work. Nested
`tx.$transaction` uses native savepoints. Ordinary raw BEGIN/COMMIT/ROLLBACK on the
root entry is refused.

`db.$transaction([...])` executes the established deferred-query API in one native
transaction and rolls back the batch on failure. The lower-level
`LibsqlPool.batch([{ text, values }, ...])` calls the driver's actual atomic
`client.batch(statements, 'write')`, returns results in input order, and refuses
transaction-control statements. The first failing statement rolls back the
batch's earlier effects; later statements are not applied.

A callback timeout can roll back between native calls and reject late callback
work. JavaScript timers and AbortSignals cannot interrupt synchronous native
execution. The inherited stream API can return a small, buffered speculative
result; when it requires native incremental iteration it throws. A pre-aborted
stream sends no query. There is no incremental-stream or edge-runtime claim; use
bounded `findMany` reads. PostgreSQL session settings, LISTEN/NOTIFY, read-only
transaction options and backend-cancel behavior remain explicitly unsupported.

## Metadata, generation and schema lifecycle

Use `schemaDefToMetadata` for code-first metadata. `generateLibsqlFiles` from
`turbine-orm/libsql/generate` returns `index.ts`, `types.ts` and `metadata.ts` as
strings for the application's file writer. Its async `turbine()` factory binds
the generated schema to local libSQL. It reuses the existing SQLite type and
metadata emitters, pins exact integer declarations, and maps native BLOB/numeric
results to their actual read types. Existing PostgreSQL and native SQLite
generation is unchanged. Bigints are accepted on integer writes; use exact
string values in typed filters for integers wider than JavaScript's safe range.

The integrated [project CLI](libsql-cli.md) supports init, pull, generation and
catalog status. [Typed seeds](libsql-seeding.md) and [read-only migration
inspection](libsql-migration-inspection.md) use separate command paths. Inspection
reports existing history and checksums; it does not execute or repair migrations.

The standalone [local catalog reader](libsql-introspection.md) supplies native
main-table metadata through `turbine-orm/libsql/introspect`. It does
not enable the adapter's inherited schema lifecycle APIs. Migration tracking
builders throw, including status/checksum/history SQL generation. The `node:sqlite`
migration runner and rebuild authorization require its native handle and cannot
be inherited by a libSQL client. No migration format, checksum, journal,
authorization, locking, rebuild, or recovery guarantee is supplied here. Review
explicit DDL separately; generic schema-diff output is not authorization to
rebuild a database.

## Evidence boundary

The focused tests require the real optional client and native local engine; a
missing package or binary fails the suite rather than yielding prerequisite
skips. They exercise persisted-file reopen, integer limits, BLOB/JSON/boolean/
Date/REAL values, ordered relations, affected counts, real writer-lock failure,
rollback, nested savepoints, batch failure, ownership and cancellation boundaries.
The package fixtures install the built archive with integrated exports and check
strict ESM/CJS generation with `skipLibCheck: false`, without `@types/pg`, plus
missing-peer and changed-generator failure controls. It forbids loading
`node:sqlite` during both native consumers and requires each process to exit.
No remote, replica, sync, rewritten-engine, provider-hosted or comparative timing
evidence is claimed.

Primary references: [Turso TypeScript reference](https://docs.turso.tech/sdk/ts/reference),
[libSQL TypeScript client](https://github.com/tursodatabase/libsql-client-ts), and
[client API definitions](https://github.com/tursodatabase/libsql-client-ts/blob/main/packages/libsql-core/src/api.ts).
The upstream native client uses a distinct `Transaction` object and integer
modes; local execution here does not certify any other transport it offers.
