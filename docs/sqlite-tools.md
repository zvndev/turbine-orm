# Read-only SQLite tools

With Node 22.12 or newer, CLI and MCP tools can read an existing SQLite file.
They use the same compiler, introspector, error catalog and PII guards as the
existing PostgreSQL tools. No optional database driver package is needed.

```sh
npx turbine capabilities --engine sqlite
npx turbine schema --engine sqlite --url ./app.sqlite
npx turbine schema users --engine sqlite --url ./app.sqlite
npx turbine compile '{"table":"users","operation":"findMany","args":{"where":{"id":1},"limit":5}}' --engine sqlite --url ./app.sqlite
npx turbine explain-error E003 --engine sqlite
npx turbine mcp --engine sqlite --url ./app.sqlite
```

The first five commands emit one JSON result. A compiler validation failure is
an `ok: false` result with the existing error code and catalog guidance. A tool
refusal (for example a write operation, locking read or hidden-column predicate)
is an error. Compilation reads the catalog and never executes the compiled
query. The default engine remains `postgresql`.

`capabilities` and the MCP `engine_capabilities` tool return `schemaVersion: 1`
with `scope: "read-only-tools"`. The `sql` object is derived from the actual
compiler dialect's capability object. The separate `transport` object describes
the tool adapter, including sessions, transactions, cursors, pipeline,
read-only enforcement and resource ownership. It does not describe an
application's ORM pool. Tool implementation, runtime availability and whether a
database is needed are separate facts. Discovery opens no database and performs
no connectivity probe. A bundled SQLite version is labeled `node-runtime`;
PostgreSQL server versions remain unknown. Use discovery rather than a static
support table to determine the current tool surface.

SQLite tools open one owned `DatabaseSync` handle per call with `readOnly: true`
and read within a snapshot transaction. Missing files are never created. Paths
and local `file:` or `sqlite:` URLs follow the existing CLI normalization rules;
remote URLs, query strings, `:memory:` and attached schemas are refused. Only
`main` is exposed. Callers cannot inject a database handle or pool into SQLite
MCP. Every handle closes after success, error or server disposal.

SQLite provides schema overview, table detail, relation graph, join paths,
query compilation, row sampling, the [SQLite doctor](sqlite-doctor.md), error lookup and capability discovery.
PostgreSQL-specific EXPLAIN, planner statistics and MCP migration status
are unavailable on SQLite and explicitly refused. SQLite schema row estimates
are `null`. Index descriptions are structural summaries; expression keys and
partial predicates are withheld, with withholding flags in the response.

PII tags are loaded as text from generated metadata in `--out`, using the same
fail-closed parser as PostgreSQL. Sampling never selects a tagged or
secret-named column. Compilation refuses predicates, ordering and aggregate
probes over hidden columns. Unreadable tag metadata hides every sampled value
and refuses column-bearing compile requests. Missing metadata is reported in
`piiTagSource`; in that case only the secret-name denylist protects values.
Column names remain visible, and returned row content is untrusted data.

SQLite read-only file opening is distinct from SQL read-only transactions:
`sql.readOnlyTransactions` is false while the tool transport enforces read-only
access through the native file handle. Neither cursor streaming nor pipeline
execution is exposed by these tools. There is no SQLite statement timeout or
server-side cancellation guarantee. Read-only discovery and error lookup remain
usable on runtimes without native SQLite; database tools report the runtime
prerequisite instead of falling back to another engine.
