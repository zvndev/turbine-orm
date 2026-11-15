# MySQL SQL migrations

Use `turbine migrate` with `engine: 'mysql'` in project config or `--engine mysql`.
The commands use the native MySQL runner and load the optional `mysql2` peer only
when connecting. PostgreSQL and SQLite runners remain independent.

```sh
npm install mysql2
npx turbine migrate create create_items --engine mysql
# Edit turbine/migrations/YYYYMMDDHHMMSS_create_items.sql, then:
npx turbine migrate up --engine mysql
npx turbine migrate status --engine mysql --exit-code
npx turbine migrate down --engine mysql --allow-destructive
```

A project can use a TypeScript config and an ignored `.env`:

```ts
import type { TurbineCliConfig } from 'turbine-orm/cli';
export default {
  engine: 'mysql',
  url: process.env.DATABASE_URL,
  migrationsDir: './turbine/migrations',
} satisfies TurbineCliConfig;
```

Install `tsx` for TypeScript config loading on supported Node runtimes. `.env`
is loaded by Node 20.12+; an existing environment variable wins. URL precedence
is `--url`, `DATABASE_URL`, then config. The default migration directory is
`./turbine/migrations`. `create` only writes a shared-format template and needs
no database connection. MySQL initialization does not create the database.

| CLI command | Behavior |
| --- | --- |
| `migrate create <name>` | Create a file to edit, refusing replacement. |
| `migrate up [--step N]` | Apply pending SQL; destructive SQL needs `--allow-destructive`. |
| `migrate deploy [--wait[=seconds]]` | Apply all pending files noninteractively, permitting destructive SQL and always refusing drift. Bare `--wait` means 300 seconds; maximum 2147483 seconds. |
| `migrate down [--step N]` | Execute inverse SQL in reverse application order, default one file; destructive SQL needs `--allow-destructive`. |
| `migrate status [--exit-code]` | Show applied/pending/drift/missing/dirty history. `list` is an alias. |
| `migrate recover <name> <checksum> <applied\|rolled-back> --acknowledge-partial-ddl` | Record a manually reconciled outcome; execute no migration SQL. |

`migration` and `m` alias `migrate`. Ordinary errors exit 1. Status normally exits
0; with `--exit-code` it exits 2 for **any dirty journal**, pending migration,
checksum drift, missing file or ignored misnamed SQL file. Dirty records print
the exact recovery name/checksum, direction and confirmed response count, even
when a failed UP is absent from history or its file was removed.

UP/DOWN permit explicit `--allow-drift` to rebaseline modified files without
replaying their UP SQL. Deploy rejects this flag. `--force`, adapters,
`--allow-pending`, `--allow-pooler`, recipes and inert
generation flags such as `--out`/`--include` are refused before connection.
Explicitly supplied missing, empty or flag-looking value operands are refused;
a bare `--url` never falls back to a configured database for migration writes.
All destructive consent is explicit; ordinary writes never prompt/retry.

UP/DOWN/deploy support `--dry-run`. It inspects history under the native lock
and displays SQL without executing it or creating metadata. Dirty state and
blocking drift/missing files still fail. It does **not** certify executable SQL,
mode-dependent native SQL policy, server authorization, destructive consent or
future concurrent state. Those checks occur again during execution. An empty
or unsupported SQL section may therefore display successfully and fail when
executed. DOWN previews use application order; they do not promise undoing DDL.
Use `turbine migrate --engine mysql --help` for connection-free engine help;
`migrate --help` also respects an existing project's engine config.

Requirements are MySQL **8.0.17+**, a direct connection to one writable server,
an existing disposable or application database, strict SQL mode, default InnoDB,
and autocommit enabled. MariaDB is unsupported. The runner does not issue session
`SET` commands. The connection URL must select a database and have no query
parameters. `schema`, if supplied, must equal that database.

The runner opens and closes one dedicated native connection. Its database-wide
`GET_LOCK` remains owned by that same connection during inspection, DDL, data
changes, and history writes. The default lock wait is zero; `lockWaitMs` allows a
bounded wait and `onLockWait` reports contention. Named locks coordinate runners
on one MySQL server, so use a direct endpoint rather than a proxy that can move
sessions or a cluster-wide migration coordinator. Other writers must cooperate
with this lock; it does not freeze application traffic or manual DDL.

## Format and operations

Files retain the common `YYYYMMDDHHMMSS_name.sql` naming, `-- UP`/`-- DOWN`
markers, and SHA-256 checksum over the exact original file bytes. Existing legacy
checksums are upgraded only when the unchanged source reproduces the old hash.

| Function | Behavior |
| --- | --- |
| `inspectMysqlMigrationDeploy(url, dir, options?)` | Pending files, checksum/missing-file problems, out-of-order predictions, and `dirty` state. Creates no metadata. |
| `migrateMysqlStatus(url, dir, options?)` | Applied/pending files, checksum validity, missing files, and dirty entries, including failed UP files absent from history. Creates no metadata. |
| `migrateMysqlUp(url, dir, options?)` | Apply pending files; optional positive `step`, `allowDrift`, and `allowDestructive`. |
| `migrateMysqlDeploy(url, dir, options?)` | Apply all pending files with destructive consent; always refuse drift, even if passed `allowDrift`. |
| `planMysqlMigrationRollback(url, dir, options?)` | Select latest applied files in reverse application order; default `step: 1`. Refuse dirty state and missing selected files. |
| `migrateMysqlDown(url, dir, options?)` | Execute the selected DOWN SQL; requires consent for destructive operations. |
| `recoverMysqlMigration(url, dir, options)` | Finalize manually reconciled history; executes no migration SQL. |

Every returned status with `dirty` requires attention, whether `applied` is true
or false. A CLI status gate must consider this property explicitly; the shared
PostgreSQL/SQLite status summary does not know about it. Deploy plans likewise
carry `dirty`, separately from ordinary checksum mismatches. Execution errors
stop the batch and include a partial-effects notice. Earlier successful files
remain applied. Successful UP files appear in `noTransaction`, because MySQL
cannot offer a transaction around their DDL. Connection/setup failures can reject
the promise directly.

`allowDrift` on UP/DOWN explicitly records a new checksum without rerunning
already applied UP SQL. Missing files always block writes, including with drift
consent. `force` reapplication is refused. DOWN requires executable inverse SQL;
an empty section never silently erases history. A successful DOWN means its
inverse SQL completed, not that MySQL rolled back the earlier transaction.

History retains `_turbine_migrations(id, name, checksum, applied_at)`. Its
auto-increment id records application order. Binary, **NO PAD** migration-name
collation distinguishes case, accents, and trailing spaces independently of an
application database's collation. This collation requires MySQL 8.0.17+.
History timestamps are explicitly written as UTC. Application SQL executes
unchanged: its unique indexes, auto-increment gaps, native JSON validation, and
explicit column collations retain MySQL semantics.

## Partial DDL and recovery

MySQL DDL implicitly commits. Atomicity of an individual supported MySQL DDL
statement does not make a multi-statement migration transactional.
[MySQL atomic DDL documentation](https://dev.mysql.com/doc/refman/8.4/en/atomic-ddl.html).

Before each file's first statement, the runner commits a singleton record in
`_turbine_migration_state`. It includes the file name/checksum, UP/DOWN direction,
and total/confirmed statement counts. Each successful response advances the
confirmed count. A lost response may hide a successful statement: this count
does **not** prove later SQL had no effects. Killing a connection during a
statement can still leave effects from that statement.

After all statements succeed, only the InnoDB history write and journal deletion
share a small transaction. An execution failure, lost connection, or process
crash leaves the journal. All normal UP/deploy/DOWN calls then refuse automatic
retry, including drift/force attempts. The runner never tries to roll back
autocommitted migration DDL or data.

Recovery requires independently inspecting actual schema/data and reconciling
them to the intended completed UP state or completed DOWN state. Restore the
exact original migration file first if it changed or is missing. For example,
a failed UP that created a table but failed during data insertion may require
manual completion of the missing data, or manual removal of the table and any
other effects. Confirm that decision independently before recording the outcome:

```sh
npx turbine migrate recover 20260101000000_create_items <exact-sha256> applied \
  --engine mysql --acknowledge-partial-ddl
```

Use `rolled-back` only after manually reconciling actual schema/data to the
completed DOWN or absent-UP state. Neither outcome replays SQL or proves that
manual reconciliation was correct. The underlying function has the same contract:

```ts
await recoverMysqlMigration(url, migrationsDir, {
  name: dirty.name,
  checksum: dirty.checksum,
  outcome: 'applied', // or 'rolled-back', matching the manually reconciled state
  acknowledgePartialDdl: true,
});
```

The function checks the exact dirty record, unchanged source, and consistent
history under the same lock. It inserts/retains history for `applied`, or
removes/retains its absence for `rolled-back`, then clears the journal in one
InnoDB transaction. It cannot verify an operator's assertion about arbitrary
schema/data effects. It neither replays SQL nor attempts automatic repair.

## Supported SQL boundary

This initial runner supports unqualified table/index DDL and INSERT, UPDATE,
DELETE, and TRUNCATE statements. MySQL quote/comment splitting follows the
connection's `ANSI_QUOTES` and `NO_BACKSLASH_ESCAPES` modes. Native UPDATE always
requires destructive consent; MySQL numeric truthiness is broader than the
shared PostgreSQL destructive scanner. Type/charset/collation rewrites and
`ON DUPLICATE KEY UPDATE` also require consent. Deploy supplies that consent.

Preflight checks the entire selected batch before its first mutation. It
refuses transaction/session/lock control, client commands and DELIMITER,
executable comments/hints, temporary/non-InnoDB tables, qualified names
(including qualified column references), variables, routine/trigger definitions,
and direct references to runner metadata. Writes also refuse schemas containing
stored triggers or routines, whose indirect effects could defeat metadata and
lock guards. Status/inspection remain available for ordinary stored programs.
Metadata tables themselves must have the expected storage/columns/indexes and
no triggers or incoming/outgoing foreign keys. Unsupported SQL requires a future
explicit extension; this runner does not fall back to a generic dialect runner.

SQL files and privileged database objects are trusted code. These preflight
checks protect runner invariants; they are not a privilege sandbox for hostile
UDFs or concurrent privileged database administration.

## Native test gate

Install development dependencies and point `MYSQL_URL` at a **disposable** MySQL
8.0.17+ server. The test account needs CREATE/DROP DATABASE for isolated fixtures,
plus ordinary table/index/trigger/routine privileges in those databases and
visibility/termination of its own test connections. It must not be a production
endpoint. Each test creates a random database and removes it afterwards.

```sh
npm run gen:studio
MYSQL_URL=mysql://user:password@127.0.0.1:3306/test \
TURBINE_REQUIRE_ENGINE=mysql \
npx tsx --test src/test/mysql-migrations.test.ts src/test/mysql-cli-migrations.test.ts src/test/mysql-cli-migrations-packed.test.ts
```

Without `MYSQL_URL`, pure policy tests run and native cases explicitly skip.
Requiring `mysql` turns that missing prerequisite into a failure. The existing
`mysql-integration` CI job already runs every `src/test/*.test.ts` file with both
variables set; this suite therefore joins that required native gate directly.
The CLI suites also exercise real .env/TypeScript project config, packed ESM/CJS consumers, malformed operands and a PostgreSQL constructor refusal control. They check actual schema/data/history effects, failure/recovery, lock contention,
process interruption, and refusal controls. Server versions or SQL modes beyond
those actually exercised require their own certification.

All native `ALTER TABLE` statements require destructive consent, including column additions. MySQL partition operations, numeric-leading names and renames cannot inherit PostgreSQL scanner assumptions. Native lock-control functions are refused even when their names are quoted; ordinary quoted column identifiers remain valid.

The [journaled push command](mysql-push.md) applies a conservative planner result through this same runner and recovery journal. Ordinary SQL execution does not import schema files; `create --from-diff` uses the [schema planner](mysql-schema.md).
