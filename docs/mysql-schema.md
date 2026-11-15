# Conservative MySQL schema comparison

The MySQL schema planner compares a complete `SchemaDef` with a read-only native catalog snapshot and scaffolds ordinary SQL migration files. Execution uses the existing MySQL migration runner and partial-DDL recovery journal. The [journaled push workflow](mysql-push.md) can preview and explicitly apply the same conservative plan. There is no automatic rebuild or unjournaled apply API.

The CLI uses the native MySQL schema snapshot and existing migration runner.

Usage:

```sh
turbine diff --engine mysql --schema-file ./turbine/schema.ts --exit-code
turbine migrate create add_profiles --engine mysql --from-diff --schema-file ./turbine/schema.ts
# Review the generated UP and DOWN sections before execution.
turbine migrate up --engine mysql --allow-destructive
turbine migrate status --engine mysql --exit-code
# DOWN deletes the added objects and any data they contain.
turbine migrate down --engine mysql --allow-destructive
```

`diff` returns 0 for a no-op, 2 for a supported difference with `--exit-code`, and 1 for an error or unsupported definition. It writes neither files nor database objects. `create --from-diff` writes a file only after the complete comparison succeeds and migration history has no pending, dirty, drifted, missing or ignored SQL files. No-op and refused plans do not even create the migrations directory. Configured `schemaFile` is imported only for comparison/scaffolding; ordinary SQL migration execution never imports it.

## Supported declarations

| SchemaDef type | Native storage |
| --- | --- |
| `serial`, `bigserial` | `INT`, `BIGINT` with `AUTO_INCREMENT`, only as the sole primary key |
| `smallint`, `integer`, `bigint` | Signed `SMALLINT`, `INT`, `BIGINT` |
| `boolean` | `TINYINT(1)`; MySQL does not enforce a two-value domain |
| `varchar` | Explicit `maxLength` in 1..16383, `utf8mb4_0900_bin` |
| `text` | `TEXT`, `utf8mb4_0900_bin` |
| `json`, `jsonb` | Native MySQL `JSON`; PostgreSQL JSONB semantics are not implied |
| `date` | Native `DATE`, without timezone or default conversion |

New tables use InnoDB with `ROW_FORMAT=DYNAMIC`, UTF-8 and a binary collation. Single or composite primary keys, plain ordered column indexes and unique keys are supported within the modeled InnoDB key byte limit. TEXT, JSON and DATE keys are refused. Indexes with explicit names compare by name and exact definition; automatically named indexes may match a complete equivalent native key by ordered columns and uniqueness.

Foreign keys are single-column references to an in-schema primary or unique key with the same modeled native type and collation. The planner creates supporting indexes explicitly, creates all tables before adding FKs, and removes added FKs before other DOWN statements. `CASCADE`, `RESTRICT`/`NO ACTION`, and valid nullable `SET NULL` actions are supported. MySQL `SET DEFAULT` is refused.

Defaults are restricted to in-range signed integer and boolean literals, SQL single-quoted VARCHAR literals with doubled apostrophes, or nullable `NULL`. Backslashes, control characters and arbitrary default expressions are refused. VARCHAR defaults containing question marks, supplementary Unicode or invalid surrogates are also refused: MySQL 8 can report supplementary characters as `?` in its utf8mb3 default catalog. Existing defaults with catalog question marks refuse comparison even when the desired value appears equal; use a reviewed native migration for these definitions. This spelling is independent of `ANSI_QUOTES` and `NO_BACKSLASH_ESCAPES`. Defaults for TEXT, JSON and DATE are not supported.

On existing tables, the planner may append nullable columns or NOT NULL columns with a supported non-NULL literal default, add plain indexes/unique keys and add modeled FKs. It never changes primary keys or existing column definitions. Native uniqueness/FK checks can still fail on existing data, and literal defaults may backfill rows. Review these effects before execution.

## Refusals and prerequisites

Comparison requires native MySQL 8.0.17+ in the 8.x series, case-sensitive table names, enabled foreign keys and InnoDB pages of at least 16 KiB. Live tests exercise MySQL 8.4.0. `mysql2` remains an optional peer. There is no SQL Server service prerequisite or evidence for this feature.

The selected database must match config `schema`. Include/exclude filters are refused because the schema must describe every user table. Existing migration, metrics and Prisma bookkeeping tables are excluded. Their definitions remain owned by their respective runners.

Effective database-wide `SELECT`, `SHOW VIEW` and `TRIGGER` visibility grants, or global equivalents, must be visible in `SHOW GRANTS`. This includes privileges expanded from an active default role on the newly opened connection. Backtick and ANSI_QUOTES scope spellings are accepted. Table-only grants and partial revokes are refused rather than treating hidden tables/triggers/views as absent. Snapshot acquisition issues catalog reads and a read-only transaction on one newly owned connection; it never changes session settings and closes that connection on every path.

Removals, renames, type/default/nullability changes, views, checks, triggers, partitions, generated or invisible columns, unsigned types, non-modeled collations, native comments/options, and prefix/expression/descending/invisible/unsupported indexes are refused. Arrays, enums, vectors, timestamps, UUID, binary, floating-point and unparameterized numeric semantics are not modeled. Application PII and TypeScript type annotations do not change DDL. Identifiers containing dots, slashes, control characters, invalid Unicode or trailing whitespace are refused. Rebuilds cannot be enabled by a force flag.

## Review and recovery

Files reuse the shared timestamped filenames, `-- UP`/`-- DOWN` sections and SHA-256 checksums. The generated header explains destructive DOWN and includes an informational catalog fingerprint. Every native `ALTER TABLE` requires `--allow-destructive`, even an additive ALTER; DOWN also drops data. Native deploy retains its existing explicit behavior of allowing destructive SQL without an interactive prompt.

MySQL DDL implicitly commits. A later statement can fail after earlier statements have taken effect. Inspect the actual schema, rows, history and `_turbine_migration_state`; reconcile manually and use the existing exact-name/checksum `migrate recover ... --acknowledge-partial-ddl` workflow. The planner never implements an alternative recovery path.

Catalog reads are not an atomic snapshot of concurrent DDL. A repeated native catalog read detects observed changes during comparison, but a later change can still invalidate the plan. The fingerprint in a manually scaffolded file is not an execution lock or an automatic precondition. Journaled push separately rechecks catalog facts and the remaining plan at execution boundaries, with the same concurrent-DDL limitations. Stop concurrent schema changes and review again before running generated SQL. The native runner rechecks its SQL policy, history and consent at execution; it does not verify this catalog fingerprint. Resource limits, permissions and concurrent data changes can still make valid SQL fail.

## Internal CLI interfaces

- `inspectMysqlSchema(url)` owns the native connection and returns stable `SchemaMetadata`, supplemental native safety facts and a fingerprint. It reuses `introspectMysqlWith`; it does not parse or execute index display metadata.
- `planMysqlSchema(schema, snapshot)` is pure and returns ordered UP/DOWN steps or a refusal.
- `createMysqlSchemaMigration(url, migrationsDir, name, schema)` checks history, snapshots and plans, then uses shared `createMigration`. A no-op returns no file.
- `cmdMysqlSchema(args, config, loadSchema, argv)` presents the read-only diff. The shared CLI passes its existing schema loader.
- `cmdMysqlMigrate(args, config, loadSchema?)` accepts the same optional loader only for `create --from-diff`.

These are engine-local CLI seams. Existing PostgreSQL and SQLite schema generation, parsers and migration formats are unchanged.
