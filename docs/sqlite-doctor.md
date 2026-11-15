# SQLite doctor

The SQLite doctor adapter reports read-only catalog and connection observations.
The CLI and MCP `doctor_report` tool use the same collector:

```sh
turbine doctor --engine sqlite --url ./app.sqlite
turbine doctor --engine sqlite --url ./app.sqlite --json
```

The JSON envelope is `{ formatVersion: 1, engine: 'sqlite', ok, checks, limitations }`.
Checks have a stable `code`, `severity` (`info`, `warning`, `error`), `status`
(`pass`, `warn`, `fail`, `unknown`), and structural `facts`. Ordering is stable:
runtime, ownership, journal mode, foreign-key setting, catalog, child-index checks
sorted by table and native FK ID, then migration tracking. `ok` means every
reported check passed. It does not certify database correctness. An unknown result
makes `ok` false. Diagnostic findings do not change the CLI exit code; command,
configuration, opening and cleanup failures reject the operation.

| Code | Observation |
| --- | --- |
| `SQLITE_RUNTIME` | Actual Node version and `SELECT sqlite_version()` on the native connection. Missing native support fails; a failed version read is unknown. |
| `SQLITE_READ_ONLY` | The active handle belongs to the SQLite tool adapter, which opened the file with native `readOnly: true`. The collector leaves ownership with its caller. |
| `SQLITE_JOURNAL_MODE` | Current main database journal mode, without changing it. |
| `SQLITE_FOREIGN_KEYS` | Current connection setting. Disabled enforcement is a warning; enabled enforcement says nothing about historical rows or other connections. |
| `SQLITE_CATALOG` | Visibility of the main native catalog. Failed reads are unknown. |
| `SQLITE_FK_CHILD_INDEX` | Structural child-key coverage for each native FK group. A complete ordered left prefix, including an eligible primary-key index or INTEGER rowid alias, passes. |
| `SQLITE_MIGRATION_TRACKING` | Tracking-table visibility and bounded storage-shape observations. No migration files are read and no checksum is validated. |

Child-key diagnostics use native `foreign_key_list`, `index_list`, `index_xinfo`
and `table_xinfo` with the existing SQLite introspector and tool metadata helper.
Composite keys require the entire leading prefix. Equality-constrained child
columns can occur in any order within that prefix: an index on `(b, a)` covers
the FK equality probe on `(a, b)`. A unique index can cover a child key;
uniqueness is not required. A suffix alone, an unrelated leading column,
or a shortened prefix does not establish coverage. An expression after a complete
plain prefix does not invalidate that structural prefix.

An opaque expression, partial index, unreadable index or incomplete key metadata
can prevent a negative conclusion. The result then remains unknown rather than
asserting that an index is missing. These observations do not prove that SQLite
will choose an index, that collations match the parent comparison, that parent
keys are valid, or that foreign-key data is consistent. Workload-specific index
design remains a separate decision; this adapter emits no repair SQL.

The migration check only inspects an ordinary tracking table with the canonical
`id`, `name`, `applied_at`, `checksum` column shape. Views, virtual tables, hidden
columns and other shapes remain unknown. It reads at most 101 tracking entries,
reports storage facts for at most 100, and marks a longer history incomplete.
Stored names, checksums and timestamps are withheld. A readable table or an
entry count does not establish a clean migration state. SQLite's tracking format
has no dirty marker, so `dirtyState` is always `unknown`. Pending files, timestamp
validity, migration continuity and checksum correctness are outside this check.

The adapter needs `node:sqlite` with native read-only support (Node 22.12+).
Reader behavior is exercised on Node 22.16 and 24.10. No runtime dependency or
root public export is added. Only existing persistent database files and schema
`main` are supported. PostgreSQL-only `--fix`, `--unused`, `--audit`,
`--min-scans`, `--metrics-url`, `--no-plan-divergence`, `--no-concurrently` and
`--allow-pooler` are refused before opening a database. Table filters, positional
requests and request SQL are refused as well.

SQLite can create WAL sidecars even when its database file is opened read-only.
The command and integrated MCP handler therefore require existing WAL and SHM
sidecars before opening a WAL-format database. A checkpointed WAL-format file
without those files is refused. Keep the owning writer alive while inspecting
its existing WAL files, or arrange a disposable read-only snapshot explicitly.
Concurrent replacement or deletion of database/sidecar files is outside this
preflight guarantee; the caller must own a stable file set. No immutable URI or
automatic checkpoint is used.

For internal tool integration, `collectSqliteDoctorReport(client)` accepts an
active checkout from `createSqliteToolPool` inside a read snapshot. It reuses
`introspectSqliteToolClient` and never begins, commits, rolls back, releases or
closes that caller's resources. An arbitrary pg-compatible client receives no
SQL and produces an unknown catalog result. `runSqliteDoctor({ url, schema })`
owns its checkout, snapshot and pool and attempts all cleanup paths. If teardown
fails after collection, the rejected aggregate error retains `.report` and its
underlying errors. The caller should retain that report before surfacing the
cleanup failure.

There are no user-row scans, integrity scans, ANALYZE, VACUUM, writable PRAGMAs,
raw-SQL requests, automatic repairs or migration writes. Catalogs can still be
large, and synchronous native catalog reads have no cancellation deadline.
Reports withhold SQL expressions, predicates, defaults and filesystem paths.
Schema identifiers remain visible and should be treated as schema information.

Focused verification:

```sh
TURBINE_REQUIRE_ENGINE=sqlite node --import tsx --test src/test/sqlite-doctor*.test.ts
```

The dispatch tests concretely copy the source into a disposable staging directory,
without changing shared wiring, and execute the actual CLI and MCP entry points.
Native prerequisites are mandatory when the engine token is set. Both focused
files run in the existing required SQLite migration gate; local execution does
not establish that hosted CI has run. No new CI job is needed.
