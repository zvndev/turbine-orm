# SQL Server SQL-first migrations

The native runner in `src/cli/mssql-migrate.ts` implements inspect, status, up,
deploy and down for SQL Server 2016+. It uses the optional `mssql` peer. These
modules and their command adapter are wired into `turbine migrate --engine mssql`.
SQL Server remains Deferred; this is the bounded migration workflow below. No new package export is introduced.

Use the same `YYYYMMDDHHMMSS_name.sql` filenames and `-- UP` / `-- DOWN` sections
as other Turbine migrations. SQL Server has its own lexer: section-looking
lines inside strings or nested comments remain SQL, and `GO` separates batches
only outside literals, comments and quoted identifiers.

```sql
-- UP
CREATE TABLE [accounting].[invoices] (
  [id] int IDENTITY(1,1) NOT NULL PRIMARY KEY,
  [reference] nvarchar(200) NOT NULL
);
GO
CREATE VIEW [accounting].[invoice_references] AS
SELECT [id], [reference] FROM [accounting].[invoices];

-- DOWN
DROP VIEW [accounting].[invoice_references];
GO
DROP TABLE [accounting].[invoices];
```

`GO` must occupy its own line, optionally followed by a `--` comment. Repeat
counts (`GO 2`), inline `GO`, block comments on the separator line, sqlcmd
commands and substitution variables are refused. Batches are sent through the
native driver's `batch()` method; no semicolon splitting or SQL rewriting
changes SQL Server's batch scope or first-statement requirements for views.

## Runner methods

All methods accept `(target, migrationsDir, options?)` and return promises.
`target` is an `mssql://host/database` URL or a native config object with
`server` and `database`; borrowed pools are refused. URL query strings and
fragments are refused. String URLs match the native engine's local defaults,
`encrypt: false` and `trustServerCertificate: true`. Use a native config object
for other TLS/authentication requirements. The runner owns and closes its pool.
It sets pool min/max to 0/1, `abortTransactionOnError: true`,
`enableImplicitTransactions: false` and `useUTC: true`, preserving the remaining
native configuration, including TLS options.

| Method | Result |
| --- | --- |
| `inspectMssqlMigrationDeploy` | Shared `MigrationDeployPlan`: pending files, checksum mismatches, out-of-order warnings |
| `migrateMssqlStatus` | Shared `MigrationStatus[]`: applied/pending, checksum validity, missing files |
| `planMssqlMigrationRollback` | `{ files, missing }`, newest applied IDs first |
| `migrateMssqlUp` | Shared `MigrationRunResult` |
| `migrateMssqlDeploy` | Same result; permits supported destructive SQL without confirmation |
| `migrateMssqlDown` | `{ rolledBack, errors, rebaselined }` |

Common options are `schema` (default `dbo`), `lockWaitMs` (default 0, integer
0–2147483647) and `signal: AbortSignal`. Up and down accept a positive safe
integer `step`; down defaults to one migration. Up/down require
`allowDestructive: true` for destructive SQL. The conservative consent scan
flags every unquoted ALTER, UPDATE, DELETE, MERGE, TRUNCATE or DROP, even with a
WHERE clause. Deploy authorizes these supported operations. SQL inside strings,
comments or quoted identifiers does not trigger consent.

The command adapter supports create, up, deploy, down, status/list, dry-run,
status exit codes, and interactive confirmation supplied by its caller. Its
`--wait` accepts 1–2147483 whole seconds and applies to deploy only. Omit it for
zero wait; bare `--wait` means 300 seconds. Native `lockWaitMs: 0` remains valid.
`--step` applies to
up/down. Dry-run shows selected SQL without history writes or user SQL effects;
it does not certify SQL syntax or server permissions.

## Transaction and history semantics

One native `mssql.Transaction` pins one physical connection for the entire run.
It acquires `sys.sp_getapplock` with a database-scoped resource,
`LockOwner = Transaction`, exclusive mode and public principal. All cooperating
runs serialize across schemas, including read inspectors. A negative lock
result refuses the run. The server owns the finite lock wait. The owned pool's native `requestTimeout`
is raised, when necessary, to at least `lockWaitMs + 1000`; this also extends the
limit for migration SQL requests on that pool. With no explicit config it starts
at the native 15000ms default. An explicit zero remains unlimited; a lock wait
within 1000ms of the signed 32-bit maximum also uses an unlimited RPC timeout to
avoid overflow. This works across the supported mssql driver majors without
newer per-request overrides. AbortSignal can still cancel requests. [SQL Server application lock reference](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-getapplock-transact-sql).

**The whole selected run commits atomically**, including every selected file,
transactional DDL/DML and history update. This differs from the PostgreSQL
runner's transaction per file. A later failure rolls back earlier selected
files too. No separate lock connection can conflict with the writer.

The configured schema must already exist. It selects only the fully quoted
`[schema].[_turbine_migrations]` table; it does not change the login's default
schema. Qualify user objects explicitly with `schema.object`. Brackets, spaces,
Unicode and escaped closing brackets in schema/object identifiers are preserved.
Database/server-qualified references are refused.

Tracking uses `id int IDENTITY PRIMARY KEY`, unique `name nvarchar(255)`,
`checksum varchar(64)` and UTC `applied_at datetime2`. Existing tracking tables
must have this native shape, no triggers/FKs, temporal/memory-optimized/FileTable
mode or row-security predicates. Existing enabled user DML/DDL triggers anywhere
in the database refuse writes because they can hide SQL outside source preflight.

Inspect/status do not create tracking or upgrade checksums. A write creates
tracking only when applying at least one file. SHA-256 covers the complete raw
UTF-8 text, including both directions and comments. Each run reads an immutable
file snapshot once; those exact bytes are hashed and their selected SQL is
executed, even if a file changes while the lock is being acquired. A subsequent
inspection reports the new disk content as drift.

Stored short legacy hashes are accepted only when the original rolling-hash
algorithm reproduces them from the current source. Only writes upgrade proven
legacy hashes to SHA-256 in their transaction. Changed, missing and unproven
legacy files block both directions. `allowDrift`, `force`, caller-supplied
dialects/PG adapters and `noTransaction` are explicit refusals. No automatic
rebaseline, migration-history repair or destructive reset is provided.

## Supported SQL and recovery limits

This is a conservative lifecycle for trusted, reviewed transactional TABLE,
INDEX and VIEW DDL, SELECT/CTEs and INSERT/UPDATE/DELETE/MERGE/TRUNCATE. It is not
a T-SQL parser or a sandbox for hostile SQL. The server still validates syntax,
permissions, batch scope and transactional support. SQL error messages come from
the native driver. The lexer deliberately refuses procedural/control SQL,
including BEGIN/END (also CASE...END), TRY/CATCH, declarations/variables, temporary
tables, dynamic SQL, stored procedures, triggers/functions, sequence allocation,
database/session/security changes, external/bulk operations and all references
to the reserved `_turbine_migrations` identifier. Before user SQL effects, a
parameterized server check also refuses identifier aliases equal to that name
under the database collation, including trailing-space and collation-dependent
accent/width variants. Quote keyword identifiers.

The runner enables XACT_ABORT and quoted identifiers on its owned connection.
It checks XACT_STATE, transaction count and physical session identity around
batches and before commit. On failure it stops, examines transaction state when
the native pin remains usable, and rolls back. If the driver reports an automatic
server rollback, it does not query the released pin or issue another rollback.
Cleanup failures throw MigrationError with an AggregateError cause retaining the
primary error and every cleanup failure.
See the [native driver's transaction and cancellation documentation](https://tediousjs.github.io/node-mssql/).

A killed process/disconnected connection leaves SQL Server to roll back the
uncommitted transaction and release its lock; the next runner may have to wait
for server cleanup. A failed COMMIT acknowledgement has an **unknown outcome**:
inspect history on a fresh connection before retrying. Do not assume a rejected
promise proves that COMMIT did not reach the server. A cleanup error after a
confirmed commit explicitly says that migrations committed. Cancellation after
commit has been sent cannot undo the commit. There are no automatic retries.

The application lock coordinates only cooperating Turbine runners. It does not
stop administrators, existing external/CLR routines, server triggers, scheduled
jobs or applications from modifying objects. Such concurrent changes and external
side effects are outside atomic recovery guarantees. Identity gaps after rollback
are normal SQL Server behavior; history order follows applied IDs, not filenames.

## Native verification

`src/test/mssql-migrations.test.ts` exercises an observable driver fault model;
it is not SQL Server certification. Native cases in
`src/test/mssql-migrations-native.test.ts` create random disposable schemas and
verify actual rows/history, rollback of DDL after failure, quoted namespace
isolation, unsafe source/history/trigger refusal, legacy hashes, application-lock
timeout/wait/cancellation, AbortSignal after SQL, and a killed runner's retry.

Run them only against a disposable test database with the optional driver:

```sh
MSSQL_URL="$DISPOSABLE_MSSQL_URL" TURBINE_REQUIRE_ENGINE=mssql \
  npx tsx --test src/test/mssql-migrations-native.test.ts
```

`MSSQL_TEST_URL` is also accepted. Missing prerequisites skip locally and fail
when `TURBINE_REQUIRE_ENGINE=mssql` is set. The existing SQL Server CI unit-test
job supplies that requirement and discovers the file automatically. No Docker,
credentials, database creation or permission changes are performed by these tests.
