# Local libSQL migration inspection

The `turbine migrate status --engine libsql` command provides read-only inspection. It examines an existing
local database with the actual optional `@libsql/client/node` native driver. It
does not implement migration execution or a public package export. Use `--exit-code`
to return 2 for uninitialized history, pending, modified, missing, ignored or
out-of-order migrations; invalid history or inspection errors return 1. The JSON
report retains history, checksum classification and ordering independently.

`src/cli/libsql-migrate-status.ts` provides
`inspectLibsqlMigrations(filename, migrationsDir)`. Both arguments are filesystem
paths. Database URLs, memory databases and missing database files are refused.
The driver receives an encoded native SQLite `mode=ro` URI, which also prevents
creation if the file disappears after the initial existence check. Literal URL
metacharacters in a filename are encoded at both URI levels.

The returned fields are:

| Field | Meaning |
| --- | --- |
| `historyState` | `uninitialized` when main has no tracking table, otherwise `initialized`, including an empty table |
| `history` | Validated `AppliedMigration` rows in native ID order |
| `statuses` | Existing `MigrationStatus` records in filename order, including applied rows with missing files |
| `checksums` | Stored value, observed file SHA-256 when present, and `sha256-match`, `legacy-match`, `modified` or `missing` |
| `outOfOrder` | Backwards timestamp order in applied history, using the existing migration ordering rule |
| `ignoredFiles` | Misnamed SQL files reported by the existing migration file helper |

There is no aggregate success flag. Consumers must retain `historyState`, ordering
and ignored-file information alongside ordinary pending, drift and missing-file
counts. Uninitialized history is not evidence that migrations have been applied.

Only the canonical main `_turbine_migrations` metadata is recognized: ordinary
rowid table, integer rowid primary key, four ordinary id/name/applied_at/checksum
columns, required text columns, and a full single-column binary unique name key.
Views, case aliases, generated/extra columns, alternate primary keys, partial or
expression name keys, tracking triggers and foreign keys are refused. IDs must be
positive safe integers, names must follow the shared migration filename parser,
and timestamps must be valid SQLite UTC or ISO UTC calendar values. Malformed
history refuses inspection instead of becoming an empty history.

The unchanged shared migration module supplies filename discovery, UP/DOWN parsing,
checksum validity, status types and timestamp ordering. Each matching file is read
once and the same captured content is parsed and hashed. A reproducible legacy
checksum is reported as `legacy-match`; it is never upgraded. Drift and missing
files remain explicit. Neither UP nor DOWN SQL is executed.

Catalog validation and history rows use one native `transaction('read')` snapshot.
This is not a writer lock, session lock or filesystem snapshot. Concurrently edited
migration files can be observed at different instants; callers should keep them
stable during inspection. Native SQLite WAL coordination can involve shared-memory
sidecars even with a read-only database connection. This does not promise an
unchanged whole filesystem during concurrent external activity.

Every inspector call owns and closes its client and read transaction, including
validation, parser and cleanup failures. Existing application clients are not
borrowed or closed. No Node SQLite fallback is used. The root mandatory `pg`
dependency remains unchanged through reuse of the existing migration module.

The dedicated real-file suite runs without prerequisite skips on Node 22.16.0 and
24.10.0 with locked `@libsql/client` 0.18.0, native libSQL SQLite 3.45.1 on Linux.
It checks canonical and uninitialized histories, malformed schemas and rows,
missing/drift/legacy checksums, changed files, read-only write refusal, absence
after preflight, peer usability, transaction cleanup, and a second connection
committing between catalog and history reads. Closed-file fixtures preserve file
inventory, modes, modification times and bytes. An active WAL control checks
database/WAL bytes and file inventory separately from shared-memory coordination.

Run the focused suite with the desired Node binary:

```sh
node --import tsx --test src/test/libsql-migrate-status.test.ts
```

The CLI validates the local project before invoking this inspector. Set `migrationsDir`
in the existing project config. `migrate list` is an alias. No deployment, up/down,
recovery, checksum rewrite, remote libSQL, new Turso or sync behavior is established.
Future writer semantics require separate implementation and evidence.
