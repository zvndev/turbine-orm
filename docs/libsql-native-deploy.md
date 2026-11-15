# Local libSQL migration deployment

`turbine migrate deploy --engine libsql` applies every pending migration to an
existing local native libSQL database. This is a bounded additive workflow, not
general SQLite migration parity. Install the optional `@libsql/client` peer and
initialize a persistent local project first.

```js
// turbine.config.mjs
export default {
  engine: 'libsql',
  url: 'file:./app.sqlite',
  migrationsDir: './migrations',
};
```

Migration files retain the existing `YYYYMMDDHHMMSS_description.sql` format and
`-- UP` / optional `-- DOWN` sections. Only UP runs:

```sql
-- UP
CREATE TABLE notes (
  id INTEGER PRIMARY KEY,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX notes_created ON notes(created_at);
INSERT INTO notes(id, body) VALUES (1, 'first note');
-- DOWN
DROP TABLE notes;
```

Run status before deployment and again after any interrupted or uncertain result:

```sh
turbine migrate status --engine libsql --exit-code
turbine migrate deploy --engine libsql
turbine migrate list --engine libsql
```

Status/list remain read-only: they open an existing file in native read-only
mode, never initialize history, execute migration SQL, upgrade legacy checksums
or acquire a writer transaction. `--exit-code` returns 2 for uninitialized,
pending, changed, missing, ignored or out-of-order history. Deploy returns a JSON
report whose `applied` list contains newly applied names. A successful retry with
no pending files returns an empty `applied` list without a history write.

## Admission and atomicity

Deploy captures all migration bytes before its first asynchronous operation.
Those exact UTF-8 bytes supply both executed sections and SHA-256 checksums.
Keep the directory and database paths stable while deployment runs. SQL lexical
admission uses a separate closed SQLite subset, not the CLI's PostgreSQL lexer.
BOM, ordinary comments, quoted names, escaped quotes, semicolons inside strings
and blobs are supported. Nested/unterminated comments, NUL, parameters and
unquoted non-ASCII identifiers refuse.

Migration files must be separate from the database and its existing WAL,
shared-memory and rollback-journal files, including hardlink aliases. Sidecar
symlinks and aliases between database files refuse before the native client is
opened. These checks do not protect against another process replacing paths
during deployment.

The runner owns a fresh `@libsql/client/node` client and native write transaction.
The tested native implementation prepares `BEGIN IMMEDIATE`. Schema, history,
checksums and order are inspected while holding that actual writer transaction.
Every pending SQL form is admitted before the first journal write. One commit
covers all pending files, their DDL/data and `_turbine_migrations` rows. Native
constraint/statement failures before commit roll back the selected batch. New
journal rows use the compatible id/name/checksum/applied_at schema. Matching
legacy checksums remain unchanged. Changed, missing, ignored, or out-of-order
files refuse; there is no bypass or checksum repair flag.

Deployment admits CREATE TABLE with explicit columns, CREATE [UNIQUE] INDEX,
and INSERT INTO ... VALUES with literal scalars, including signed numbers and
multiple tuples. Arithmetic and nested expressions in VALUES refuse. Foreign keys stay enabled.
Identifiers may use SQLite double quotes, backticks or brackets. Internal
history/SQLite metadata names are conservatively reserved even when they occur
as quoted values. DDL expressions allow only a fixed small set of scalar/date
functions and common parameterized type names. Unknown functions refuse;
native libSQL includes file I/O functions whose effects SQL rollback cannot undo.

Triggers, views and virtual/shadow tables in either pending SQL or the existing
catalog refuse. Existing defaults, CHECKs and expression indexes pass the same
function admission. REPLACE/conflict policies, INSERT SELECT, UPSERT, RETURNING,
UPDATE, DELETE, DROP, ALTER, TEMP, PRAGMA, ATTACH/DETACH, VACUUM, transaction
control and the no-transaction directive refuse. Unsupported forms in an already
applied migration are not re-executed; existing catalog admission still applies.

## Contention and interruption

There is no lock-wait flag. Another native writer or deployer causes an immediate
lock refusal before journal creation. The runner never closes or commits a
caller's connection or transaction. In DELETE journal mode an active reader can
block COMMIT. WAL readers can retain their prior snapshot while deployment
commits. Journal mode and durability settings are not changed.

A failed COMMIT is reported as an uncertain durable outcome, never confirmed
rollback or partial-DDL success. Cleanup failures cannot replace a primary
transaction failure, including an uncertain COMMIT. All owned cleanup steps are
attempted; cleanup-only failure after a confirmed commit explicitly reports that
COMMIT was acknowledged. After process loss, SQLite recovery and durable
status determine whether the batch committed. Retry only after inspecting
history and releasing conflicting connections. Native connection snapshots and
same-connection retries after SQLITE_BUSY have limitations; no general session
cleanup or in-process cancellation guarantee is supplied. The CLI's owned
process lifecycle is the tested workflow. SIGTERM and SIGKILL after actual
uncommitted DDL are tested with complete same-files replay after process exit.

Only existing filesystem databases are writable. Remote URLs, authentication,
replicas, sync, URL options, migration/database aliases and project-file database
collisions refuse. No create/up/down/repair/reset workflow, destructive override,
remote provider support or new Turso engine support is implied.
