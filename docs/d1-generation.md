# Optional D1 generated factory

`generateD1Files(schema, options)` emits `index.ts`, `types.ts` and `metadata.ts`
using the established SQLite declaration and metadata generators. The generated
`turbine(binding, options)` synchronously calls `turbineD1(binding, SCHEMA, options)`.
It accepts a caller-supplied Worker D1 binding, including the official
`D1Database` type. It performs no connection acquisition or schema provisioning.

```ts
// Run generation in Node. Write these three files to your own generated directory.
import { generateD1Files } from 'turbine-orm/d1/generate';
const files = generateD1Files(schema, { noTimestamp: true });

// In a Worker, import the generated factory.
import { turbine } from './generated/index.js';
const db = turbine(env.DB, { globalFilters: { posts: { visible: true } } });
const users = await db.users.findMany({ with: { posts: true } });
const [post, count] = await db.$batch([
  db.posts.buildCreate({ data: { userId: 1, title: 'Hello', visible: true } }),
  db.posts.buildCount(),
]);
await db.disconnect(); // Seals this facade; env.DB remains caller-owned.
```

The example's fields depend on the supplied schema. Start with code-first
`schemaDefToMetadata(defineSchema(...))`, or independently obtained D1 metadata.
The integrated [native catalog entry](d1-introspection.md) can supply this metadata.
Generation does not introspect a database. It does not add CLI, deployment,
cloud, migration or hosted-provider support.

The generator is a Node tool and may use the package's mandatory `pg`
dependency through shared generation infrastructure. The generated Worker runtime
imports only `turbine-orm/d1` and its local metadata. Type-only root imports carry
shared query declarations without loading the PostgreSQL or native SQLite
factory. The existing `node:async_hooks` error context requires `nodejs_compat`.
For CommonJS bundled into a Worker ESM module, the test bundler bridges that
builtin using an ESM reexport; this is test/consumer bundler configuration.

`GenerateD1Options` reuses the established per-file options: `noTimestamp`,
`importExt`, `importMode`, `columnTypes` and `logger`. `keepColumnNames: true`
preserves raw database column names through the existing schema transform.
`target` and `exactNativeIntegers` are fixed by this entry and are rejected at
runtime if supplied. No alternate generation flags or filesystem writes are
introduced. Existing PostgreSQL/default generation is unchanged.

Declared column types and explicit `columnTypes` overrides retain their meaning;
the latter takes precedence. Overrides are compile-time claims about stored
values, not parsers or validators. Table names, relation names and legacy
relation declarations, composite unique selectors, optional/defaulted inputs,
view restrictions and generated nonwriteable columns come from the shared
emitters. Runtime metadata is emitted without changing its column/parser facts.
The complete known SQLite factory block is checked before replacement. A drift
refuses with a validation error instead of guessing at a new declaration layout.

Integer rows and generated integer inputs use `number`, including BIGINT/int8
metadata. No libSQL string-integer policy is enabled. D1 still rejects non-finite
numbers and unsafe integers before preparing statements. Raw bindings accept a
BigInt only within JavaScript's safe-integer range, converting it to a number;
large BigInts refuse. The generated number input type is deliberately narrower
than that raw binding surface. Decimal/numeric declarations use `number | string`.
BLOB/bytea rows and generated inputs use `Uint8Array`, JSON keeps its shared type
or override, and date/timestamp rows keep the shared `Date` parser contract.
Nullable values retain nullability. Actual parsing remains the adapter's policy;
arbitrary dynamic SQLite storage and unsafe stored integers gain no new promise.

The client exposes schema-specific CRUD, relation projections, deferred queries,
`$batch` and `$batchRaw`. Session/transaction/pipeline/LISTEN methods and native
cursor methods are omitted. `createMany` and `buildCreateMany` retain projection
and count inference but exclude `onConflict` reconciliation. Row locks,
transaction-dependent nested writes, over-limit bulk work and unsupported raw
SQL still refuse under the adapter's existing rules. A schema-specific type
does not enable a dialect capability. D1's native batch is atomic for SQL errors;
a client transform failing after native commit cannot undo that commit. Aborting
before dispatch prevents side effects; aborting afterwards does not promise
native cancellation. Deferred queries must belong to the same facade.

The focused suite compiles actual generated ESM/CJS with strict checking and
official Worker binding types, then executes the factories and typed CRUD,
relations, composites, generated columns, values, scope and native batches in
local Miniflare/workerd. It includes generator drift, export omission, forbidden
runtime imports, absent drivers and refusal/ownership controls. An absent native
prerequisite fails. No hosted D1 certification is claimed.

The `./d1/generate` ESM/CJS exports, required native script, existing packed-job
step and separate measured optional-entry budget are integrated in this source
tree. Installed tests consume an explicit archive and SHA-256 without export
overlays. Hosted certification remains a separate decision.
