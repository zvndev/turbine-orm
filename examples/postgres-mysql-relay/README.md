# PostgreSQL orders to MySQL inbox

This finite application composes the adjacent, unchanged PostgreSQL and MySQL
durable order examples. Read [the contract](../../docs/postgres-mysql-relay.md).
Copy all three example directories with their relative paths into an installed
TypeScript project. Strictly compile with NodeNext, ES2023, Node/pg types,
`turbine-orm`, `pg` and `mysql2`.

The caller provisions a fresh PostgreSQL schema and MySQL database and configures
the documented durable UTF8MB4 MySQL service. Set `DATABASE_URL`, `PG_SCHEMA`,
`MYSQL_PORT`, `MYSQL_DATABASE` and `SOURCE_HISTORY_ID`, then execute the compiled
`postgres-mysql-relay/demo.js`. The history UUID identifies that exact source
history forever. Never reuse it for a reset/fork or unrelated source. The demo
initializes fresh tables, appends one exact order, relays it, and polls twice.
It leaves the durable rows for inspection and closes its caller-owned pools.

For an existing initialized deployment, call `openOrderRelay` and `relayBatch`
or bounded `reconcile` without `initialize`. Retry rejected batches explicitly;
always use the same source history and consumer binding after restart.

The offline native fixture is `src/test/fixtures/postgres-mysql-relay/run.mjs`.
It requires its explicit private evidence root, cached installed consumers and
owned native binaries. It starts no hosted service and never uses a host network
fallback. Tests cover target-first acknowledgement, actual process interruption
and reopen, exact native rows, finite cancellation and caller pool ownership.
