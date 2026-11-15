# SQL Server catalog doctor

The SQL Server doctor collects advisory structural facts through the existing
catalog tool transport and introspector. It accepts an owned catalog handle;
it does not accept SQL, application pools or caller-supplied metadata.

The command integration supports:

```sh
turbine doctor --engine mssql
turbine doctor --engine mssql --json
turbine doctor --engine mssql --schema app --include orders,customers
```

An existing configuration can select `engine: 'mssql'`, its URL and namespace.
The MCP `doctor_report` tool takes an empty argument object and uses the same
collector. Discovery advertises this implementation without opening a database.
The adapter requires the optional `mssql` peer, like other SQL Server tools.

The collector and command adapter live in `src/cli/mssql-doctor.ts`. The shared
CLI, MCP and catalog transport provide command dispatch and provenance. These
were added in 0.94.0. There is no new package barrel export.

## Report contract

The JSON envelope is `{formatVersion: 1, engine: 'mssql', ok, checks,
limitations}`. Checks use stable codes, `pass`, `warn`, `fail` or `unknown`
status, and `info`, `warning` or `error` severity. Collection or cleanup failures
reject the operation instead of returning a successful partial report.

`ok` requires every scoped check to pass. A successful collection exits zero
and can have `ok: false`. In particular, this adapter explicitly reports
visibility, consistency, server version and migration state as unknown, so a
completed report does not certify a clean schema.

| Code | Meaning |
| --- | --- |
| `MSSQL_CATALOG_SCOPE` | Visible tables and canonical namespace when available; catalog permissions, omitted objects and cross-namespace completeness remain unknown. |
| `MSSQL_CATALOG_CONSISTENCY` | No consistent snapshot or native read-only transaction guarantee. |
| `MSSQL_RUNTIME_VERSION` | Server version discovery is unsupported. |
| `MSSQL_MIGRATION_STATE` | Migration history, dirty state and filesystem comparison are unsupported. |
| `MSSQL_WRITE_RESTRICTIONS` | Observed identity and generated read-only columns; absence of an observation does not grant write permission. |
| `MSSQL_VISIBLE_KEYS` | Visible primary and index properties; completeness, constraint trust and enforcement remain unknown. |
| `MSSQL_FK_CHILD_INDEX` | Complete ordered child-key left-prefix coverage through a corroborated active, unfiltered rowstore index, or unknown. |

Per-table and per-relationship checks repeat their codes. Facts are sorted with
binary string comparison, independent of process locale. Identifiers retain
catalog casing, use SQL Server brackets and double embedded closing brackets.
Schema and table are separate qualified components; a dot inside either name
is never interpreted as a namespace separator. Native identifier limits apply.
No index names or executable SQL suggestions are generated.

Composite foreign keys require every child column in order at the left of an
eligible index. Included columns do not substitute for key columns. Filtered,
computed, disabled, hypothetical, hash, columnstore, missing-flag or
incompletely ordered indexes cannot prove coverage. Primary keys require
corroborating activity, ordered-key and rowstore facts. No visible covering
index means unknown: restricted metadata access can hide catalog rows.
Coverage is advisory structure, with no workload, plan, collation applicability,
FK trust or performance guarantee.

The existing introspector owns relationship derivation. Only its visible
same-namespace base tables and relationships are assessed, with its normal
bookkeeping-table exclusions and configured include/exclude filters. Reversed
and many-to-many accessors do not create extra FK checks. Cross-namespace
relationships and hidden objects remain outside this assessment.

## Resource and execution boundaries

`collectMssqlDoctorReport(client, options)` calls
`introspectMssqlToolClient` to validate an active owned catalog token. It never
releases the caller's handle or ends its pool. Concurrent introspection on the
same handle is refused. `runMssqlDoctor(options)` creates its own pool and
handle, awaits `releaseMssqlToolClient`, and closes its pool on success or
failure. Cleanup failure fails the operation; a pending catalog request must
settle before the underlying pool closes.

Reads are fixed catalog queries only. There is no native SQL Server read-only
transaction or consistent snapshot in this transport. Concurrent DDL can change
facts between reads. No arbitrary query, user-row scan, plan execution, DDL,
writable `SET`, repair, migration change or autofix is performed. Connection
strings, native error details, default/computed/filter SQL literals and row
contents are withheld.

PostgreSQL-only `--fix`, `--unused`, `--audit`, `--min-scans`, `--metrics-url`,
`--no-plan-divergence`, `--no-concurrently` and `--allow-pooler` are refused
before checkout. Other unsupported options and positional arguments are also
refused. PostgreSQL doctor behavior is separate and preserved.

## Evidence limits

Transport fixtures exercise the actual packaged adapter, ESM/CJS outputs,
command dispatch, MCP framing, refusal and cleanup boundaries. Fixtures do not
establish native SQL Server behavior. The `mssql-integration` gate runs the
focused native test against SQL Server 2022. That test reads
existing catalogs only; it neither provisions objects nor proves all structural
cases. Setting `TURBINE_REQUIRE_ENGINE=mssql` makes a missing native prerequisite
fail rather than silently skip.
