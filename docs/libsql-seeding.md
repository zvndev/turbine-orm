# Local libSQL seed callbacks

The optional `turbine-orm/libsql/seed` entry provides explicit trusted callbacks for the native `@libsql/client/node` adapter. Install the optional `@libsql/client` peer. It is separate from PostgreSQL and `node:sqlite` seeding. It does not migrate, rebuild, generate or automatically seed a database.

```ts
import { defineLibsqlSeed, runLibsqlSeed } from 'turbine-orm/libsql/seed';
import { introspectLibsql } from 'turbine-orm/libsql/introspect';

const url = 'file:./app.db'; // Already provisioned by your application.
const schema = await introspectLibsql(url);
const seed = defineLibsqlSeed(async (tx) => {
  await tx.table<{ id: number; label: string }>('items').create({
    data: { id: 1, label: 'example' },
  });
});
await runLibsqlSeed(url, schema, seed);
```

`defineLibsqlSeed` validates and returns a callback without executing it. Its argument is exactly the adapter's `TransactionClient`, also exported as `LibsqlSeedClient`. Table types are supplied with `table<Row>()`; metadata alone does not infer a generated schema type. The callback returns `void` or `Promise<void>`. The runner returns `Promise<void>`.

`runLibsqlSeed(target, schema, callback, options?)` uses `turbineLibsql` and its existing callback transaction. Strings accept only `:memory:` or local `file:` URLs without query or fragment options. A string creates an owned client and closes it before the runner settles, after commit or rollback. The programmatic API follows the factory's file-creation behavior; provision the schema first. An in-memory database starts empty, so any required DDL must be issued by the callback.

To retain ownership, pass `{ client, url }`, where `client` is a real native local client created with `intMode: 'bigint'`. The runner disconnects its wrapper and closes its acquired native transactions, but leaves this supplied client open after success and failure. The caller attests that it has no sync or replica configuration, which the native client's public interface cannot inspect. Do not use it concurrently or supply one with an active native transaction. Supplied clients are not reusable wrapper/pool instances.

Await every query and every nested `tx.$transaction(async inner => { ... })` block. Nested callbacks use the adapter's savepoints. Use `inner` inside its block; an ancestor handle cannot issue work inside a descendant savepoint. Escaped transaction, table and connection handles refuse queries after their scope settles. Work still outstanding when the callback settles causes rejection and rollback through the existing adapter lifecycle. Native execution cannot be interrupted; cleanup can wait for native work. The helper adds no timeout or cancellation mechanism.

This executes trusted module code with supported SQLite-like local transaction semantics. Callback failures roll back database work on the callback's transaction, including supported transactional DDL. Raw SQL is available through the ordinary transaction handle, subject to existing adapter statement and transaction-control checks. There is no additional DML-only or trigger prohibition. Existing triggers can run. Imports, captured native clients, independent connections, filesystem/network effects and arbitrary external effects are outside the transaction. This is not a sandbox, a guarantee about external effects, or remote/Turso certification.

Callback rejection values are preserved, even `undefined`, `null`, `false` or `0`. If wrapper disconnect also rejects, the runner throws `AggregateError` with `[callbackOrTransactionFailure, cleanupFailure]` for distinct failure events, including events that throw the same value. A transaction-cleanup failure exposed by both completion and disconnect is returned once, preserving the original rejection. A cleanup failure after a successful commit rejects the runner even though writes already committed. Inspect the database before retrying such a failure. Native transaction-finalization errors follow the adapter's existing lifecycle; the helper cannot undo an acknowledged commit.

## CLI integration contract

The `turbine-orm/libsql/seed` export and CLI dispatch were added in 0.94.0. The [installed workflow gate](libsql-project-workflow.md) tests them together with the local project helper.

The command module exports `cmdLibsqlSeed(args, config, resolveProject)`, `assertLibsqlSeedArguments(args, originalArgv?)` and `showLibsqlSeedHelp()`. The shared CLI selects engine `libsql`, resolves CLI URL precedence into config, and calls argument validation with original tokens before config or seed execution. The command accepts only seed/s aliases, `--engine libsql`, `--url`/`-u`, `--verbose`/`-v` and `--help`/`-h`. The shared router handles help without opening the database.

`config` carries `{ engine: 'libsql', url, seedFile?, seed? }`. `resolveProject` is a required zero-argument asynchronous function returning `{ url, schema }`. The CLI/project owner must validate unsupported config/runtime options, require an existing local regular database file, and introspect its main catalog without DDL before returning. It must return the same normalized URL as `config.url`. Seed code is imported only after this succeeds. The project helper owns file normalization, existence checks and metadata filters. Do not use an in-memory URL in the CLI: introspection and seeding open separate clients.

The route is `turbine seed --engine libsql --url file:./app.db`. `seedFile` wins over legacy `seed`; existing default discovery applies. Default discovery may select `seed.sql`, which this command explicitly refuses. Export a default callback from `.js`, `.mjs`, `.cjs`, `.ts`, `.mts` or `.cts`; TypeScript modules require project-local `tsx`. Native module imports work for both ESM and CommonJS builds using the existing shared module loader. Directly executing the module does not invoke a callback declared with `defineLibsqlSeed`.

SQL seed files, positional seed paths, preview/dry-run, PostgreSQL-only flags, remote URLs, sync/replica settings, Turso rewrites, migrations and rebuild are unsupported. No new mandatory runtime dependency is introduced. PostgreSQL and native SQLite seed dispatch and behavior remain owned by their existing paths.
