# Read-only MySQL tools

The native MySQL tool adapter uses the optional `mysql2` peer and the existing
MySQL introspector and compiler. Shared CLI/MCP dispatch must select this adapter;
the engine module alone does not enable command dispatch.

Configure `engine: 'mysql'` and a direct
`mysql://user:password@host:3306/database` URL. The schema must match that database.
Query parameters, fragments, malformed escapes, control characters and mixed
engine URLs are refused. Supply credentials through the environment; do not
commit them in config files. Advanced connection options and injected pools are
not accepted by this tool adapter.

```sh
npm install mysql2
npx turbine capabilities --engine mysql
npx turbine schema --engine mysql
npx turbine schema users --engine mysql
npx turbine compile '{"table":"users","operation":"findMany","args":{"where":{"id":1},"limit":5}}' --engine mysql
npx turbine explain-error E003 --engine mysql
npx turbine mcp --engine mysql
```

Implemented operations are schema overview, table detail, relation graph, join
paths, compile-only read queries, bounded row sampling, the [MySQL doctor](mysql-doctor.md),
error lookup and capability discovery. Migration status, EXPLAIN and planner statistics
are not implemented for this transport and must refuse before connecting.
Overview row estimates are `null`. Discovery only resolves the optional peer:
it does not connect, load the driver, or claim a server version or connectivity.
Database calls require native MySQL 8.x. MariaDB is not supported.

Each database call creates a new owned connection, sets the **next transaction**
to repeatable read, and starts `WITH CONSISTENT SNAPSHOT, READ ONLY` before
returning the scoped handle. There is no session-level `SET`. Release destroys
the socket and rolls back the read-only transaction. Errors and shutdown destroy
active connections too; shutdown also drains in-flight connection attempts.
No caller-owned connection is accepted or closed. The exposed client and pool
query methods refuse arbitrary SQL, including transaction commands. Only the
private fixed catalog executor and a validated projection/limit sampler can
execute statements. Sampling validates against metadata loaded on that same
active connection and binds its limit (1–100).

MySQL read-only transactions reject ordinary DML, including when the account has
write privileges. They do **not** independently prevent every DDL statement:
some DDL implicitly commits. The absence of arbitrary SQL and transaction-command
inputs is therefore part of the tool boundary, not just an extra convenience.
The snapshot covers transactional table data; concurrent DDL and nontransactional
tables are not snapshot-isolated. These tools expose no pipeline, cursor,
statement deadline or server-side cancellation guarantee. Use an account with
only the permissions needed to read the intended catalog and sampled tables.

Index responses are structural facts from `information_schema.STATISTICS`:
column keys, prefix lengths, direction, uniqueness, visibility and index type.
Expression keys are marked withheld, all native index definitions are withheld,
and enum labels are omitted. Expression text, predicates and default literals
are never returned. Identifiers remain schema shape, including unusual quoted
names. Native driver errors are replaced with a fixed message and a validated
error code, so stored literals, SQL and bindings are not echoed in errors.

The shared PII perimeter must run before sampling and compilation. Sampling
selects only visible columns and preserves redaction markers for hidden ones.
Generated metadata in `--out` supplies code-first PII tags; secret-looking column
names are also protected. Unreadable tags fail closed; missing metadata leaves
only the secret-name policy and is reported explicitly. The compiler reads
catalog metadata, releases its connection, and builds through `SEALED_POOL` with
`mysqlDialect`. It never executes the compiled query. Raw SQL, writes, locks and
hidden-column predicates remain refused by the existing shared handlers.
