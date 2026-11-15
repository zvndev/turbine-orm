# SQLite seeding

`turbine seed` runs a trusted local JavaScript or TypeScript module when the
project selects `engine: 'sqlite'`. The module exports one callback, receives a
transaction client, and awaits its database work. Successful callback work
commits together. A rejected callback or failed commit rolls back that work and
the CLI exits 1. Completion prints `Seed completed` and exits 0.

The seed command needs **Node 22.12 or newer** with `node:sqlite`. TypeScript
modules also need `tsx` installed in the project, even on Node versions that
have native TypeScript stripping. No driver or mandatory dependency is added.
The native migration writer used by the fresh-project workflow needs Node 24.10
or newer.

## Fresh project

```sh
npm install turbine-orm
npm install --save-dev tsx
npx turbine init --engine sqlite --url ./turbine/dev.sqlite --yes
# Inspect/edit the starter UP/DOWN migration before applying it.
npx turbine migrate up
npx turbine generate
```

SQLite `init` creates a persistent database and migration scaffold. It does not
create, import or execute a seed. Add `seedFile` to the generated config, keeping
its other settings:

```ts
// turbine.config.ts
export default {
  engine: 'sqlite' as const,
  url: './turbine/dev.sqlite',
  out: './generated/turbine',
  migrationsDir: './turbine/migrations',
  seedFile: './turbine/seed.ts',
};
```

Create `turbine/seed.ts`. This example uses the starter migration's `users`
table and is safe to rerun for the same email:

```ts
import { defineSqliteSeed } from 'turbine-orm/sqlite/seed';

export default defineSqliteSeed(async (tx) => {
  await tx.raw`
    INSERT INTO users (email, display_name)
    VALUES (${'demo@example.test'}, ${'Demo user'})
    ON CONFLICT(email) DO UPDATE SET display_name = excluded.display_name
  `;

  const user = await tx.table<{
    id: number;
    email: string;
    displayName: string | null;
  }>('users').findUnique({ where: { email: 'demo@example.test' } });
  if (!user) throw new Error('Expected the seeded user');
});
```

```sh
npx turbine seed
npx turbine seed  # same email is updated, not duplicated
```

`defineSqliteSeed` gives `tx` its TypeScript type and returns the callback. It
never runs automatically. Execute the module through `turbine seed`, or invoke
it with the programmatic runner below. Running `tsx turbine/seed.ts` directly
only declares/exports the callback. The PostgreSQL `defineSeed` helper has a
different lifecycle and should not be used for SQLite seeds.

## Existing project and module formats

For an existing SQLite database, select `engine: 'sqlite'`, its filename and a
`seedFile` in the project config. Run `turbine pull` to generate metadata/client
files if desired, then `turbine seed`. The seed command inspects existing
metadata and never creates a missing database, creates tables or applies
migrations. Apply schema changes explicitly before seeding.

Supported modules are `.js`, `.mjs`, `.cjs`, `.ts`, `.mts` and `.cts`. ESM uses a
default export. CommonJS JavaScript can use:

```js
// seed.cjs
module.exports = async (tx) => {
  await tx.raw`INSERT INTO users (email) VALUES (${'cjs@example.test'})
    ON CONFLICT(email) DO NOTHING`;
};
```

TypeScript can use `export default defineSqliteSeed(...)` in both `"type":
"module"` and `"type": "commonjs"` projects. The shared loader registers ESM and
CommonJS hooks from project-local `tsx`; `.mts` and `.cts` select their explicit
module format. A plain default callback works too. Named-only exports and
objects are refused. A top-level script without a callable default is not a
completed SQLite seed.

File selection preserves existing CLI precedence: config `seedFile`, then the
legacy `seed` alias. Without either, discovery checks `seed.ts`, `seed.js`,
`seed.sql`, then those names under `turbine/`, in that order. Explicit paths win
even when missing. Set `seedFile` explicitly for other extensions or to bypass
an older discovered file. SQL seed files are refused by the SQLite module
runner; move the work into an awaited callback or an explicit migration.

Database selection preserves CLI precedence: `--url`, `DATABASE_URL`, config
`url`. A persistent path or local `file:` URL is required. An inherited
PostgreSQL `DATABASE_URL` is refused; unset it or explicitly override it with
`--url`. An unreadable config fails closed. The CLI does not fall back to a
PostgreSQL seed handler.

## Supported arguments

| Argument | Behavior |
| --- | --- |
| `seed` or `s` | Explicitly run the selected module |
| `--engine sqlite` | Select SQLite; otherwise config selects the engine |
| `--url <path>` or `-u <path>` | Override the database filename or local file URL |
| `--verbose` or `-v` | Accept the shared diagnostic option |
| `--help` or `-h` | With `--engine sqlite`, show SQLite seed help |

No positional seed path or forwarded module arguments are supported. Choose the
module in config. Other flags are refused, including `--dry-run`, `--preview`,
`--schema`, `--schema-file`, `--allow-pooler`, `--force`, `--include`, `--exclude`
and `--out`. SQLite projects use schema `main` and SQL migrations, so configured
PostgreSQL adapters and `schemaFile` are also refused.

## Ownership and failures

The runner opens a SQLite client using the committed SQLite factory, starts
one callback transaction, awaits the callback and commit/rollback, then awaits
client disconnection. It enables the factory's default foreign-key enforcement
and busy timeout. `tx` offers typed `table`, parameterized `raw`, and nested
transaction/savepoint APIs; it has no disconnect/close method. Do not retain it
after the callback, and await every operation before returning.

This is trusted code execution with the process's permissions. Module imports
happen before the callback transaction. Filesystem/network effects, other
connections and arbitrary user module side effects are outside that
transaction. They can persist after failure. There is no static safety preview
or sandbox. Avoid changing transaction boundaries manually or terminating the
process from a seed module.

A missing module/database, unsupported flag, loader/import error, invalid export
or callback/commit error exits nonzero without a completion message. Database
errors roll back awaited callback work; fix the cause and rerun. Reruns execute
the callback again, with no seed history/checksum tracking or automatic deduping.
Use natural keys, upserts or explicit guards when repeatability is needed. An
interruption after commit may leave committed rows, so rerun logic should allow
that outcome. SQLite's normal journal/WAL recovery handles interrupted writes.

## Programmatic runner

```ts
import { SCHEMA } from './generated/turbine/metadata.js';
import seed from './turbine/seed.js';
import { runSqliteSeed } from 'turbine-orm/sqlite/seed';

await runSqliteSeed('./turbine/dev.sqlite', SCHEMA, seed);
```

The signature is `runSqliteSeed(target, schema, callback, options?)`, with the
existing `TurbineSqliteOptions` factory options. A string target uses the
factory's normal open/create behavior, unlike the CLI's existing-file check.
A supplied `DatabaseSync` remains caller-owned and stays open after either
success or failure; the runner must not close it. Supply an idle handle and
keep it exclusive until the promise settles. A transaction already opened by
the caller is refused and remains the caller's to finish. The callback uses
this runner's transaction, including when the handle is borrowed. Handle
options/pragmas on a borrowed connection remain the caller's responsibility.

## better-sqlite3 applications

The dedicated seed helper's handle contract is node:sqlite. A better-sqlite3
handle is not a drop-in target. Seed the application's file through the SQLite
CLI (which opens it with node:sqlite), or run awaited seed writes in an explicit
`turbineBetterSqlite3` client transaction. The latter is an ordinary client
transaction and does not provide the helper's handle ownership or seed-file
loading lifecycle. See [SQLite support](sqlite-support.md).
