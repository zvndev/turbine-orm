# Native database lifecycle examples

The executable [SQLite and MySQL apps](../examples/native-lifecycles/) use the
published package and generated accessors. Each app creates user 1, updates its
name, reads the exact stored result and closes its owned client. Run them against
a disposable database first. Copy the engine's app/config/schema files and the
shared `tsconfig.json` into an ordinary project; both engines also have `seed.ts`.

| Workflow | SQLite | MySQL 8.4 | SQL Server |
| --- | --- | --- | --- |
| Fresh/existing init, pull, typed client, status | Executed by the verifier | Executed in both modes | Available commands; no live-service evidence here |
| Reviewed native SQL migrations | Atomic batch, native authorization | Partial DDL journal and explicit recovery | Separate native runner; no service certification here |
| Schema preview/application | `push --dry-run`, then `push` | Read-only `diff`, scaffold SQL, then `migrate up` | No schema push/diff claim |
| Explicit seed callback | Shipped SQLite transaction callback | Shipped restricted DML callback | Implemented; native verification pending |
| JSON read-only tools | Supported subset | Capabilities/schema/compile verified | Supported subset; no live-service claim |

## SQLite: fresh database

Use Node 24.10+ for native migration and schema writes. The verifier also runs
with exact Node 24.10.0. SQLite needs no driver package. Install local TypeScript
tools so config and seed modules load in either package format:

```sh
npm init -y
npm pkg set type=module
npm install turbine-orm
npm install --save-dev typescript @types/node tsx
npx turbine init --engine sqlite --url ./app.sqlite --yes
```

For CommonJS, use `npm pkg set type=commonjs`. Init creates the database,
configuration and a starter migration. It applies no SQL and runs no seed.
Before applying the starter, replace its contents with
[`sqlite/initial.sql`](../examples/native-lifecycles/sqlite/initial.sql). This
example uses only an integer key and required `display_name`, matching the app
and schema files. Inspect both UP and DOWN sections.

Set `DATABASE_URL` in your environment to the local filename, then copy
[`sqlite/turbine.config.ts`](../examples/native-lifecycles/sqlite/turbine.config.ts),
[`sqlite/app.ts`](../examples/native-lifecycles/sqlite/app.ts),
[`sqlite/schema.ts`](../examples/native-lifecycles/sqlite/schema.ts),
[`sqlite/seed.ts`](../examples/native-lifecycles/sqlite/seed.ts) and
[`tsconfig.json`](../examples/native-lifecycles/tsconfig.json) to your project.

```sh
npx turbine migrate status --exit-code
# Exit 2 above means the reviewed starter is pending.
npx turbine migrate up
npx turbine pull --no-timestamp --import-ext js
npx tsc -p tsconfig.json
node build/app.js
npx turbine status
npx turbine migrate status --exit-code
npx turbine seed
npx turbine seed
```

The app prints user 1 with `Updated by the app`. It is a one-run demonstration:
rerunning it without deleting user 1 fails its insert. The seed upserts user 2,
so rerunning the seed preserves one row. Its callback runs in a transaction;
`EXAMPLE_SEED_FAIL=1` deliberately rejects after the write and leaves no partial
seed effect. Merely importing or compiling the seed never executes it.

To author another migration, use `turbine migrate create <name>`, edit the
generated UP/DOWN file and review it before `migrate up`. Migration status tracks
those SQL files, not arbitrary external changes.

## SQLite: existing database and schema changes

Select the existing filename with `DATABASE_URL`, then run `init --engine sqlite
--yes`. Init preserves tables, rows and existing files, including with `--force`.
It does not add a starter migration when user tables already exist. Use `pull`
to regenerate from the catalog. The small app expects the `users` definition in
`initial.sql`; adapt the app's generated accessors for other schemas. Do not
apply this initial CREATE to a database that already has that table.

The example schema retains `users` and adds `notes`:

```sh
npx turbine push --schema-file ./schema.ts --dry-run --exit-code
# Exit 2 means supported changes; exit 1 means refusal.
npx turbine push --schema-file ./schema.ts
npx turbine pull --no-timestamp --import-ext js
```

Preview changes no tables or rows. Apply uses the native writer lock and atomic
transaction. Unsupported dependencies or SQL remain refusals, even with a force
flag. A failed migration batch or seed callback rolls back its writes. SQLite
uses native journal/WAL recovery; it has no MySQL partial-DDL acknowledgment
workflow. See [SQLite migrations](sqlite-migrations.md) for leaf rebuild limits,
STRICT/WITHOUT ROWID preservation and native SQL restrictions.

## MySQL 8.4: fresh and existing databases

Provision a disposable database on a direct MySQL service and set `DATABASE_URL`
through your environment or secret manager. Credentials stay out of app/config
source and command arguments. The URL must select a database; init never creates
one. Install the optional peer explicitly:

```sh
npm init -y
npm pkg set type=module
npm install turbine-orm mysql2
npm install --save-dev typescript @types/node tsx
npx turbine init --engine mysql --yes
```

For CommonJS, change the package type to `commonjs`. On an empty database, replace
the starter migration with
[`mysql/initial.sql`](../examples/native-lifecycles/mysql/initial.sql) before
applying it. Copy the MySQL `app.ts`, `turbine.config.ts`, `schema.ts` and the
shared `tsconfig.json` into your project. On an existing database, init preserves
rows/files and emits no starter when user tables exist; use `pull` and adapt the
app to that catalog. This app expects the supplied `users` shape.

```sh
npx turbine migrate up
npx turbine pull --no-timestamp --import-ext js
npx tsc -p tsconfig.json
node build/app.js
npx turbine status
npx turbine migrate status --exit-code
```

The generated MySQL factory must be awaited before accessing tables. The app
uses that async factory in both ESM and CommonJS, and closes the client in
`finally`. Copy [`mysql/seed.ts`](../examples/native-lifecycles/mysql/seed.ts),
then run `npx turbine seed` twice to store one user 2. Setting
`EXAMPLE_SEED_FAIL=1` makes the callback fail after its write; that DML rolls back.
The [MySQL seed helper](mysql-seeding.md) exposes typed reads/DML and nested
callbacks only, requires fully visible InnoDB tables without triggers, and does
not roll back module imports or external connections. Each engine uses its own
seed helper.

The example schema adds `notes` through reviewed native SQL:

```sh
npx turbine diff --schema-file ./schema.ts --exit-code
npx turbine migrate create add_notes --from-diff --schema-file ./schema.ts
# Inspect the generated UP/DOWN SQL. DOWN drops the new table and its rows.
npx turbine migrate up
npx turbine diff --schema-file ./schema.ts --exit-code
npx turbine capabilities
npx turbine schema
npx turbine compile '{"table":"users","args":{"where":{"id":1},"limit":1}}'
```

The first diff exits 2 for the supported difference and writes nothing.
Scaffolding writes a migration without applying it. The last diff exits 0 after
application. Existing-table ALTER statements require `--allow-destructive`, even
when additive; these examples add a new table. The JSON tools report supported
operations, native catalog facts and compiled read SQL. Compile reports
`executed: false`; it does not run the app query. They do not replace migration
status or grant write access. See [MySQL schema comparison](mysql-schema.md) and
[MySQL SQL migrations](mysql-migrations.md) for current contracts.

## MySQL: partial effects and recovery refusals

MySQL DDL can commit before a later statement fails. The intentionally failing
[`partial-ddl.sql`](../examples/native-lifecycles/mysql/partial-ddl.sql) creates a
table, inserts one row and fails on a duplicate key. Use it only in a disposable
database. The verifier observes that table and row, then proves normal retry,
missing acknowledgment and wrong-checksum recovery all refuse without changing
the partial state.

After a real failure, inspect `turbine migrate status --exit-code`, the actual
schema and rows. Manually reconcile the database to the intended complete UP or
absent/complete DOWN state. Use the exact name/checksum printed by status with
`migrate recover <name> <checksum> applied|rolled-back
--acknowledge-partial-ddl`. Recovery records your reconciled outcome; it neither
replays SQL nor verifies that manual reconciliation was correct. Do not blindly
retry the file. The verifier explicitly removes its deliberately created table,
acknowledges `rolled-back`, and removes only its never-applied failure fixture.

## SQL Server: required-service path, not certification

Native SQL Server is unavailable for this example verification. No modeled
driver, fixture or SQLite run certifies SQL Server behavior. With your own
disposable SQL Server service, install `mssql` as the optional peer, set
`DATABASE_URL` in the environment, and use `init --engine mssql --yes`, `pull`,
`status`, and the separate SQL Server native migration commands documented in
[SQL Server migrations](sql-server-migrations.md). Await the generated factory and
close its owned client. No SQL Server app execution, native recovery result,
or schema push/diff is claimed here. The [SQL Server seed workflow](sql-server-seeding.md)
is implemented with fixture/packed checks; this example does not establish native seed behavior.

## Verify a built artifact

The [tarball verifier](../tooling/lifecycle-examples/README.md) installs the built
package in ordinary isolated consumer directories, with no source imports or
repository `node_modules` link. It covers fresh/existing SQLite on exact Node
24.10.0 and owned MySQL 8.4 in both SQL modes, each with ESM and CommonJS projects.
It records artifact/version/step/effect/error evidence and removes owned fixtures
on success or caught failure. Missing prerequisites fail; they do not become
passing skips. Evidence applies only to the versions and combinations in each
report.
