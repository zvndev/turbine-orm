# Journaled MySQL schema push

MySQL push uses the [conservative schema planner](mysql-schema.md) and the
[existing native migration runner](mysql-migrations.md). It supports the same
additions as the planner. It adds no rebuild, removal, rename or type conversion.

```sh
# Read-only preview; --exit-code returns 2 when a supported difference exists.
turbine push --engine mysql --dry-run --schema-file ./turbine/schema.ts --exit-code
# Apply explicitly, preserving an ordinary SQL migration first.
turbine push --engine mysql --yes --schema-file ./turbine/schema.ts
# Every ALTER, including an additive ALTER, needs separate consent.
turbine push --engine mysql --yes --allow-destructive
```

Apply and engine-specific help require explicit `--engine mysql`. Preview may
use a configured MySQL engine. The existing PostgreSQL flag set is preserved.
Omitting both `--dry-run` and `--yes`, combining them, or passing a missing,
empty or flag-looking operand refuses before schema import or connection.
`--exit-code` only applies to preview. There is no prompt, force, allow-drift,
allow-pending, step, wait, filter or adapter bypass.

The complete schema must be representable by the existing planner. Its native
version, visibility, identifier, Unicode-default, table, column, index and FK
restrictions still apply. Importing a schema executes trusted application code;
preview makes no Turbine file, history or schema writes, but cannot prevent
side effects inside an application module.

## Files, history and concurrent runners

Before preview or apply, push acquires the existing server/database advisory
migration lock. It refuses dirty state, pending migrations, checksum drift,
missing applied files and ignored SQL files, even when the requested schema
would be a no-op. It never silently applies an existing pending file.
A no-op or refused plan creates no migration directory or file.

After a successful plan and ALTER consent check, apply rechecks the catalog and
file inventory. It creates one timestamped `schema_push_<random>.sql` using the
shared exclusive file writer and ordinary `-- UP` / `-- DOWN` sections. Existing
files are never replaced. It validates and freezes the generated SQL bytes,
flushes the file and migrations directory, and computes the ordinary full-file
SHA-256. A flush failure stops before database writes and retains the file.
Durability still depends on the filesystem and storage; syncing the migrations
directory does not guarantee newly created ancestor directories survive a crash.
Use a durable, version-controlled migrations directory for deployment.

The runner then rechecks history and permits exactly that one pending migration,
with its frozen name/checksum. New pending files, edits, deletions or ignored
SQL discovered before metadata creation refuse with the scaffold retained.
The complete migration inventory is checked again at every DDL boundary.
Uncooperative filesystem writers can still race reads; keep migration sources
stable while executing. Valid legacy checksums retain the runner's existing
verified upgrade behavior; there is no drift rebaseline option.

The cooperative lock covers planning, file persistence and execution on the
runner's pinned native connection. Other Turbine runners using that lock cannot
interleave. Catalog reads use newly owned connections; no application pool is
borrowed, mutated or closed.

## Native DDL and recovery

Immediately before each statement, push compares the current supported plan
with the exact remaining SQL suffix. Before the first statement it also compares
native catalog facts against the original plan, excluding runner bookkeeping.
After the last confirmed statement, it requires a no-op before finalizing
history. Observed catalog drift stops execution. Every statement still uses the
existing native SQL-mode parser, ownership checks and dirty journal; every
ALTER still requires destructive consent.

These checks are **not a DDL lock or an atomic dictionary snapshot**. MySQL
catalog reads can cache or omit a concurrent change even across repeated reads.
An external administrator or application can change schema or data between a
check and execution. Stop external schema writers. Unique/FK validation,
permissions, resource limits and concurrent data can still cause native failure.

MySQL DDL implicitly commits. A failure can leave earlier statements applied,
or the last statement applied without its response being confirmed. The ordinary
`_turbine_migration_state` counts confirmed responses only. No atomic MySQL DDL,
automatic replay or automatic reconciliation is promised. Files remain after
all failures following persistence, including a failure before a dirty row exists.

Inspect the retained file, actual schema/rows, history and journal:

```sh
turbine migrate status --engine mysql --exit-code
# Independently reconcile actual effects to applied or rolled-back first.
turbine migrate recover <exact-name> <sha256> <applied|rolled-back> \
  --engine mysql --acknowledge-partial-ddl
```

Recovery only records the independently reconciled outcome through the existing
runner; it executes no migration SQL. A recovered `rolled-back` migration remains
pending. Review and run it explicitly with `migrate up --allow-destructive`, or
resolve it deliberately; the next push still refuses pending files. Never delete
a dirty migration or change its checksum to make a retry pass. DOWN is inverse
SQL and can delete data; it is not a rollback of implicit commits.

Native tests exercise MySQL 8.4 in default and ANSI_QUOTES/NO_BACKSLASH_ESCAPES
modes, process loss at each native statement/journal boundary, manual recovery,
and packed Node 22/24 ESM/CommonJS CLI consumers. Other server versions and
managed/proxy deployments are not certified by those tests.
