# SQL Server seeding

Use `turbine-orm/mssql/seed` for explicit trusted seed callbacks. Install the
optional `mssql` driver in the application. No other engine driver is selected.

```ts
import { defineMssqlSeed, runMssqlSeed } from 'turbine-orm/mssql/seed';
import { SCHEMA } from './generated/turbine/metadata.js';

interface User { id: number; email: string }
const seed = defineMssqlSeed(async (tx) => {
  await tx.table<User>('users').create({ data: { email: 'hello@example.com' } });
  const users = await tx.table<User>('users').findMany({ select: { email: true } });
  console.log(users);
});
await runMssqlSeed(process.env.DATABASE_URL!, SCHEMA, seed, { schema: 'dbo' });
```

`defineMssqlSeed` only returns the callback. Importing its module or running
`init` never executes it. `runMssqlSeed` awaits the existing asynchronous
`turbineMssql` factory, opens one native `mssql.Transaction`, commits after the
callback completes, and rolls back on failure. It closes pools it creates on
success and failure. A supplied `MssqlPool`, or a native pool accepted by the
factory, remains owned by its caller.

The callback gets a frozen `MssqlSeedClient`. Its `table<T>(name)` returns a
frozen handle exposing `findMany`, `findUnique`, `findFirst`, their `OrThrow`
variants, `count`, `aggregate`, `groupBy`, `create`, `createMany`, `update`,
`updateMany`, `delete`, `deleteMany` and `upsert`. These retain existing typed
arguments and selected result types. Explicit row types must describe your
metadata accurately; this helper does not infer generated accessors.

There is no raw SQL, transaction control, pool, connection, schema, deferred
builder or stream access. `tx.$transaction(async (inner) => { ... })` uses a
savepoint and supplies another closed handle. Use `inner` inside that block.
Await every operation and every nested block. Unfinished work prevents commit;
a handle used after its callback ends is refused before a native Request runs.
Catch an inner callback error to keep the outer transaction, as with ordinary
Turbine savepoints.

## Schema and server assumptions

The existing SQL Server compiler emits bracketed **unqualified** table names.
The `schema` option defaults to `dbo`; it validates resolution and does not
change the login's default schema. Before calling the seed, fixed parameterized
catalog reads on the native transaction require every metadata table to resolve
to a base table in that namespace. A missing table, view, synonym, hidden catalog
entry or different resolved namespace refuses the callback. SQL Server may fall
back from the login default schema to `dbo`; that is accepted only when the
resolved table is actually in the requested namespace. Choose a login/default
schema consistent with the introspected metadata.

Use trusted metadata, middleware, native pool and server definitions. Concurrent
schema changes can invalidate metadata or resolution after the checks; coordinate
DDL separately. Triggers, cascades, computed/default expressions and user-defined
functions must preserve ordinary transactional semantics and must not commit or
roll back the enclosing transaction. Enabled triggers can also make SQL Server
reject the compiler's `OUTPUT` DML. Trigger actions on external systems,
nontransactional side effects, captured connections, imports and arbitrary module
code are outside this transaction. This is trusted application code, not a
JavaScript sandbox or a rollback guarantee for external effects.

## CLI workflow

Configure an existing database-first project:

```js
// turbine.config.mjs
export default {
  engine: 'mssql',
  url: process.env.DATABASE_URL,
  schema: 'dbo',
  seedFile: './turbine/seed.mjs',
};
```

```js
// turbine/seed.mjs
import { defineMssqlSeed } from 'turbine-orm/mssql/seed';
export default defineMssqlSeed(async (tx) => {
  await tx.table('users').create({ data: { email: 'hello@example.com' } });
});
```

Run `turbine seed --engine mssql`, or `turbine seed` with the configured engine.
`--url`, `--schema` and `--verbose` are supported. `seedFile` takes precedence over
the legacy `seed` alias. Without either, the existing seed candidate order is
used. If discovery finds an SQL file, the command refuses it. Configure `seedFile`
for `.mjs`, `.cjs`, `.mts` or `.cts` rather than relying on discovery for them.

JavaScript needs no `tsx`. TypeScript `.ts`/`.mts`/`.cts` modules require a
project-local `tsx` installation; the command registers it and imports the module
in the current process. The default export must be a callback, including through
ESM/CJS interop wrappers. Top-level module code executes during import, before the
seed transaction opens. Database introspection and file/option validation happen
before the seed is imported. There is no SQL-file execution, preview, dry-run,
positional file argument or implicit seed during `init`.

## Validation scope

Await each seed operation, including nested transactions. If a callback returns
or throws with requests still running, finalization waits for those requests to
settle before rollback releases the driver's transaction pin. Returning early
rejects the seed; throwing retains the original callback error. Configure the
native driver's request timeout to bound long-running statements.

Offline tests observe Turbine `MssqlPool`/Transaction and Request routing using
an explicit fault model, including rollback and ownership controls. A separate
control uses the installed driver's real `mssql.Transaction` acquire/release
lifecycle with a modeled wire connection to observe connection pinning. These
tests do not certify SQL Server. `src/test/mssql-seed-native.test.ts` uses a unique
owned table in a disposable database selected by `MSSQL_URL` (or
`MSSQL_TEST_URL`), removes only that table, and closes its own pool. Set
`TURBINE_REQUIRE_ENGINE=mssql` to make an absent service a failure instead of a
skip. Native SQL Server validation remains required before claiming service
certification.
