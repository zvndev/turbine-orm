# SQLite migrations

SQLite migrations use SQL files with the same timestamp filenames, `-- UP` and
`-- DOWN` markers, SHA-256 checksums and status fields as PostgreSQL migrations.
Select `engine: 'sqlite'` and a persistent database filename in the CLI config.
The native SQLite writer requires **Node 24.10 or newer**. It checks for
`DatabaseSync.setAuthorizer` and `DatabaseSync.isTransaction` before creating a
database. Ordinary SQLite ORM query support keeps its existing runtime floor.
Read inspectors require the native read-only and transaction-state capabilities
available in Node 22.x from 22.16, or Node 24 and newer.

```ts
export default {
  engine: 'sqlite',
  url: './turbine/dev.sqlite',
  migrationsDir: './turbine/migrations',
};
```

```sql
-- UP
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE
);

-- DOWN
DROP TABLE users;
```

```sh
npx turbine migrate create users
npx turbine migrate up
npx turbine migrate status
npx turbine migrate deploy
npx turbine migrate down --allow-destructive
```

`up` applies pending files in filename order. `--step` selects a positive number
of files. `down` defaults to one migration and follows reverse **application ID**
order, including migrations originally applied out of timestamp order. A missing
or empty DOWN section stops the rollback; the entire selected rollback batch
stays applied. `deploy` opts in to destructive SQL, matching PostgreSQL deploy.
`up` and `down` require explicit destructive confirmation or
`--allow-destructive`.

For explicit local data seeding after migrations, see [SQLite seeding](sqlite-seeding.md).
SQLite init never runs a seed automatically.

## Transactions and locking

A run opens **one owned `DatabaseSync` handle**. `BEGIN IMMEDIATE` acquires the
SQLite writer lock on that handle, before reading history or selecting pending
files. There is no advisory-lock connection, lock table, stale lock record or
second writer transaction. Other SQLite writers contend for the same native
lock, including ordinary application writers.

**The entire selected batch is one transaction.** SQL, tracking inserts/deletes,
legacy checksum upgrades and explicit checksum rebaselines commit together. If
migration 3 fails after migrations 1 and 2 ran in that batch, all three roll back.
This differs from PostgreSQL's per-migration transactions. Reduce `--step` when
a smaller transaction is needed. Programmatic SQL-failure results contain one
error and no successful `applied`/`rolledBack`/`rebaselined` entries.

The default lock attempt fails immediately. `--wait` supplies bounded native busy
waiting; another writer's committed history is read after the lock is acquired,
so its migrations are not applied twice. `DatabaseSync` calls and lock waiting
block the calling JavaScript thread. `onLockWait` fires once when writer
contention starts. The same configured busy timeout applies if COMMIT must wait
for existing readers.

On failure the runner rolls back any remaining transaction and closes the
handle. Native `ON CONFLICT ROLLBACK` can itself end the transaction and release
the writer lock; this is detected and reported without a tracking write. If the
process is terminated, SQLite's journal/WAL recovery rolls back its uncommitted
batch and releases its locks. Retry the same migration command after correcting
the failure. A process interrupted after COMMIT may have completed the batch;
status and a rerun read the committed history and skip it.

The runner enables foreign keys before starting the transaction. Immediate and
deferred constraints remain enabled; a deferred violation at COMMIT rolls back
the batch. Cascades use SQLite's native semantics. The separate code-first
`push` workflow below uses a conservative native schema planner.

## Checksums, history and read-only inspection

Checksums hash the exact UTF-8 migration file, including comments and both
sections. The pre-v0.6 rolling hash is accepted only if recomputing that old
algorithm over the current content matches the stored hash. A successful write
run upgrades a verified old hash to SHA-256 inside its transaction.

Modified files block both apply and rollback. `--allow-drift` explicitly replaces
the stored hash with the current file's hash; it does not execute an already
applied UP again. A rollback removes selected history rows, so only surviving
rows appear in a successful rebaseline report. Missing applied files always
block writes, including with `--allow-drift`; restore them first.

Status, deploy inspection and rollback planning open existing databases read-only
and never create a database or tracking table. A missing filename has no applied
history. Inspectors neither upgrade legacy hashes nor rebaseline modified ones.
Missing applied files remain visible in status. These operations preserve the
database schema and stored hashes. SQLite itself can coordinate reads through
its native WAL/shared-memory files.

The existing SQLite dialect's tracking DDL is accepted, including its original
column order and UTC `datetime('now')` timestamps. History is ordered by its
integer primary key, rather than potentially equal timestamps. Malformed
tracking schemas/rows, tracking triggers and foreign keys into the tracking
table are refused. Tracking writes must affect exactly one row, and the final
history must match the executed batch before commit. A constraint that silently
ignores an insert cannot leave applied SQL without its history row.

## SQL policy and supported options

The native helper accepts only schema `main` (or no schema). PostgreSQL adapter
locks and caller-supplied dialects are refused. The helper takes a normalized
filesystem filename; CLI URL normalization happens before calling it.

The runner owns the transaction. `BEGIN`, `END`, `COMMIT`, `ROLLBACK`, savepoint
control, `-- turbine:no-transaction`, all PRAGMAs, ATTACH/DETACH, VACUUM and virtual
table creation are unsupported. A migration must not access
`_turbine_migrations`, install triggers or foreign keys against it, or change its
entry in `sqlite_sequence`. Native autoincrement and consented DROP/RENAME of
user tables remain supported. Explicit user-sequence changes require destructive
consent; the tracking sequence must remain unchanged throughout user SQL.
SQLite's authorizer enforces these rules, including indirect trigger effects.
Native CREATE TRIGGER bodies execute intact, without splitting their semicolons.

Destructive detection uses SQLite quoting/comment rules for its static inventory
and native authorization for effects that appear only at execution. The native
gate is deliberately conservative: all UPDATEs and ALTER TABLE operations,
replacement INSERTs (including a table's default `ON CONFLICT REPLACE`) and trigger
creation require destructive opt-in. An existing trigger can make an otherwise
ordinary INSERT destructive. Such a native-only refusal rolls back the entire
batch and asks for explicit opt-in; a static preview cannot resolve every trigger
effect. Preview checksums and history are read-only; execution remains the final
SQL/capability/policy check.

Migration sources containing NUL characters are refused, since the native SQL
API would otherwise execute only a prefix. Rollback checksums are checked against
the exact source snapshot used for execution, including if a file changes after
the initial history inspection.

## Code-first schema diff and push

`push` can create ordinary SQLite rowid tables and indexes, add scalar columns,
or rebuild a leaf table to change a column's nullability or default. Existing
native `STRICT` and `WITHOUT ROWID` tables also support this bounded workflow,
including tables with both options. It reuses `defineSchema()` and the SQLite DDL generator. The SQL-first
migration commands above retain their existing behavior.

```ts
// turbine/schema.ts
import { defineSchema } from 'turbine-orm';
export default defineSchema({
  items: {
    id: { type: 'serial', primaryKey: true },
    name: { type: 'text', notNull: true, default: "'untitled'" },
  },
});
```

```sh
# Preview works with an existing database or a missing filename; no file is created.
npx turbine push --schema-file turbine/schema.ts --dry-run --exit-code
# Exit 2 means there are supported changes; exit 1 means the plan was refused.
npx turbine push --schema-file turbine/schema.ts
npx turbine generate
```

Use the SQL-first SQLite config above; supply `--schema-file` to `push`, or put
the definition at its default `turbine/schema.ts` location. SQLite project
`init`/`generate` still use their SQL-first configuration contract. `push`
requires schema `main`, no include/exclude filters, and Node 24.10+ for writes.
`--force` and `--allow-destructive` cannot override a safety refusal.

The displayed plan is checked against a catalog fingerprint again under
`BEGIN IMMEDIATE`, using the same writer lock as SQL migrations. Rebuild creates
a replacement, copies values and hidden rowids entirely within SQLite, retains
the AUTOINCREMENT high-water mark, drops the original, renames the replacement,
and restores its explicit indexes before its triggers. Copying rows does not
fire application triggers. Existing table constraints must match the declared
definition; their original SQL is retained. Foreign keys remain enabled for the
whole operation, with native validation before and after. All steps commit or
roll back together, including index creation failures. Native recovery also
handles a process killed during the transaction.

Existing table modes come from the native catalog and survive rebuilds; they
are not new `defineSchema()` options. A new table still uses the ordinary
generator. For `WITHOUT ROWID`, copying uses only declared columns, preserving
the primary key's order and native NOT NULL enforcement. An `INTEGER PRIMARY
KEY` on such a table still requires a supplied value; it does not become a
serial or AUTOINCREMENT key. Rowid tables continue to retain hidden rowids.

`STRICT` tables retain native lossless insertion checks. Existing type/key
definitions must match the generator exactly, and additions must use types
accepted by native STRICT SQLite. For example, `integer`, `text`, `real` and
`bytea` map to supported native types; `numeric` does not. `ANY` and `INT`
catalog declarations are outside this slice because the generator cannot
reproduce them exactly. All STRICT column additions use a leaf rebuild: native
ADD invokes an internal integrity PRAGMA that the migration authorizer refuses.
This keeps the existing authorization boundary and applies the same dependency
guards as other rebuilds. Defaults are inserted under native type rules; a
constraint failure rolls back every step. Explicit and implicit primary-key
NOT NULL requirements are preserved without repeated rebuilds.

Rebuilds with inbound or self-referencing foreign keys are refused: dropping a
referenced table can run cascades even with deferred checks. Views and triggers
owned by another table are conservatively treated as opaque dependencies.
Generated columns, named column constraints, NOT NULL conflict policies,
unknown table options, arrays, vectors and length limits are outside this
slice. Type/key/reference/CHECK changes, column removal/rename, constrained new
columns and conflicting index definitions require reviewed SQL migrations.
Nullable data blocks a requested NOT NULL constraint before DDL is issued.

Tables and indexes omitted from the definition are retained and listed as
preserved, as are existing triggers. This is a conservative supported-change
planner; a no-change result is not a claim that every database object is
represented in the code-first schema. Push neither creates migration records nor
changes their checksums or sequence. SQL migration status continues to report
file history, so teams should choose how to record reviewed deployment changes.

## better-sqlite3 files

The CLI manages a SQLite file with node:sqlite, including a file used by a
better-sqlite3 application. It does not use the application's live handle or
adapt better-sqlite3 into the migration writer's authorizer/session contract.
Finish application transactions and coordinate concurrent writers before a
migration. The builtin writer's Node >= 24.10 requirement still applies.
See [SQLite support](sqlite-support.md) for the binding and capability boundaries.
