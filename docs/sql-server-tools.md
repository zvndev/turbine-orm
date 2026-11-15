# SQL Server catalog tools

The SQL Server adapter uses the optional `mssql` peer and the native SQL Server
introspector. The CLI/MCP dispatcher selects it explicitly for `engine: "mssql"`.

```sh
npm i mssql
turbine capabilities --engine mssql
turbine explain-error E003 --engine mssql
turbine schema --engine mssql --schema dbo --url mssql://localhost/app
turbine compile '{"table":"users","args":{"where":{"id":1},"limit":5}}' --engine mssql
turbine mcp --engine mssql --schema dbo
```

Use environment/config URLs for credentials. Discovery and Turbine error lookup
open no connection, including when the optional peer is absent. Discovery reports
driver resolution, SQL compiler capabilities, unknown server version and unprobed
connectivity separately.

The supported tools are `schema_overview`, `table_detail`, `relation_graph`,
`find_join_path`, `compile_query`, `explain_error`, `engine_capabilities` and
the scoped [catalog doctor](mssql-doctor.md) through `doctor_report`.
The default namespace is `dbo`; include/exclude filters use the existing native
introspector. Compilation uses the existing sealed compiler, with bracket
identifiers and `@pN` parameters. It accepts the six existing read operations,
never arbitrary SQL. Shared PII predicate and metadata-tag checks still apply.
Caller-supplied argument values can appear in the returned parameter list.

Catalog tools own a separate native pool per call, with at most one connection,
and await its closure. Application pools cannot be injected. Only the private
introspection executor can send the fixed, parameterized catalog statements.
Public pool/client query methods refuse every SQL statement. No transaction or
session-level SET is issued. Catalog reads are sequential but are not a consistent
snapshot; concurrent schema changes and catalog visibility permissions can affect
the result. An empty catalog does not prove that the database has no tables.

SQL Server has no advertised native read-only transaction. This adapter does not
prove database permission enforcement or expose data execution. `sample_rows`,
`explain_query`, `table_stats` and `migrate_status` refuse
before opening a connection. Row estimates are unknown (`null`).

Column defaults, computed expressions, checks and index definitions are withheld.
Identity/computed/default presence and index filter/disabled/hypothetical/computed
flags are structural facts. Index names, key columns and included columns remain
identifiers; a name containing SQL-like punctuation is never parsed as an
expression. Missing index flag rows yield unknown flags. No predicate or computed
expression text is returned.

Native URLs use the engine's existing local-development transport defaults:
`encrypt: false`, `trustServerCertificate: true`. Query parameters and fragments
are refused. Connect timeout is 15 seconds and native request timeout is 30
seconds; these are driver settings, not a SQL transaction timeout.

Run the focused tests after generating the ignored Studio module:

```sh
npm run gen:studio
npx tsx --test src/test/mssql-tools*.test.ts
```

The packed fixture tests compile and exercise ESM and CJS and strict consumers
with `skipLibCheck: false`, observe native connection/close events and test
absent-driver and failure paths. They do not prove live SQL Server behavior.
Native tests need an explicitly supplied disposable SQL Server endpoint:

```sh
TURBINE_REQUIRE_ENGINE=mssql MSSQL_URL=mssql://localhost/disposable \
  npx tsx --test src/test/mssql-tools-native.test.ts
```

Required-native mode fails when the endpoint is absent. Native tests create a
unique schema and disposable tables and remove only those objects. Without a
real endpoint, native verification remains unavailable.

After building, execute the integrated ESM/CommonJS cases:

```sh
node tooling/sql-server-tools/integration.mjs "$PWD" esm
node tooling/sql-server-tools/integration.mjs "$PWD" cjs
```
