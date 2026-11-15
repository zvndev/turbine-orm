# Scoped MySQL doctor

The MySQL doctor inspects structural facts on one owned, native MySQL 8.x read-only transaction. It does not modify the database, generate repair SQL, read migration files, or write report files. The optional `mysql2` peer is required. There is no new root export or mandatory dependency.

The CLI and MCP `doctor_report` tool use the same collector through the native tool transport:

```sh
turbine doctor --engine mysql
turbine doctor --engine mysql --json
turbine mcp --engine mysql
```

Configuration selects the URL and its matching database/schema. `--url` and `--schema` can override configuration. MySQL `doctor_report` takes an empty arguments object and returns the same report as `doctor --json`. PostgreSQL doctor behavior is unchanged.

Only `--json`, connection selection, and help are accepted. Repair, concurrent-index, unused-index, audit, metrics, plan-divergence, pooler, schema-file and positional options are refused before opening a tool connection. A delivered report exits normally; inspect `ok` and each check. Connection/configuration failures fail the command and cannot produce a completed snapshot report.

The envelope is `{formatVersion:1, engine:'mysql', ok, checks, limitations}`. Check codes and order are stable within format version 1. `ok` is true only when every scoped check is `pass`. `warn`, `unknown`, and `fail` all make it false. Their severities are `warning`, `warning`, and `error`; a pass has severity `info`. Unknown coverage never means absence or clean health.

| Code | Observations and scope |
| --- | --- |
| `MYSQL_RUNTIME` | Numeric native version, allowlisted session SQL modes, count of unrecognized modes, and session FK enforcement. No mode change is made. |
| `MYSQL_VISIBILITY` | Reuses the existing whole-database grant guard. Requires provable SELECT, SHOW VIEW and TRIGGER coverage or global equivalents. Table/column grants, partial revokes and role grants produce an explicit unknown/refusal before catalog assessment. |
| `MYSQL_SCOPE` | Selected table count, visible/excluded catalog-object counts, whether filters apply. Migration observations cover the selected database independently of table filters. |
| `MYSQL_ENGINES` | Actual selected-table engines. InnoDB is recognized as transactional; known nontransactional engines warn; other engines, including NDB/FEDERATED, remain unknown. This is not certification of other engines. |
| `MYSQL_CONSTRAINTS` | Names, kinds and enforcement flags of selected tables' constraints. Expressions and row integrity are not inspected. |
| `MYSQL_FOREIGN_KEYS` | Declared ordered composite FK columns, target columns, same/external database scope, and current enforcement setting. No orphan scan. |
| `MYSQL_INDEXES` | Full-column leading BTREE coverage for each declared FK source and in-scope target, including primary keys. Actual ordered mixed-expression, prefix and invisible index scope is retained. Expressions are withheld. |
| `MYSQL_MIGRATIONS` | Observed history/journal presence and aggregate counts, only for InnoDB base tables. Any dirty entry fails; missing tracking objects remain unknown. This does not validate tracking rows, files, checksums, pending migrations, or drift. |

Index coverage is structural. A confirmed leading prefix can include later opaque keys: those later keys do not invalidate the confirmed leading columns. Without confirmed coverage, opaque, prefix, invisible or unsupported keys yield unknown coverage. Otherwise the result is `not-observed`, a warning without a claim that a new index is necessary or faster. Out-of-scope or external FK targets remain unknown. No identifier or index name is invented, and no DDL advice is emitted.

Only catalog identifiers and explicitly selected facts reach reports. Credentials, endpoints, accounts, grant text, SQL literal/default/predicate values, expression text, migration names/checksums, comments and data rows are omitted. Native query errors become fixed collection-failure facts. A visibility refusal leaves later checks unassessed; a collection failure retains preceding facts and marks the current check failed.

The collector borrows one already-open owned tool snapshot and leaves its lifecycle to its caller. The CLI adapter closes only its own checkout and pool. The native transport uses `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ` for the next transaction, followed by `START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY`. It issues no session/global SET and accepts no caller SQL. Concurrent DDL and nontransactional tables are outside consistent-snapshot guarantees; the report explicitly states this limitation. There is no query deadline, data-integrity certification or performance analysis.

Run focused unit checks without a service, and required native checks against an owned disposable MySQL service. The native suite creates and removes its own databases and accounts. The service must enable `partial_revokes` at startup so the refusal case executes; missing prerequisites fail when the engine is required:

```sh
node --import tsx --test src/test/mysql-doctor.test.ts
MYSQL_URL=mysql://root@127.0.0.1:3306/mysql TURBINE_REQUIRE_ENGINE=mysql \
  node --import tsx --test src/test/mysql-doctor-native.test.ts
```

The native suite exercises actual CLI/MCP processes, both SQL-mode configurations when run against each service configuration, grants/roles/partial revokes, transaction enforcement, snapshot reuse, caller-pool isolation, and session/database cleanup. Packed ESM/CommonJS consumption must additionally be exercised on supported Node runtimes. Record the exact tested source and package hashes; source checks alone do not establish installed-package evidence.
