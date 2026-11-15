# MySQL durable order replay

Read [the native transaction and ownership contract](../../docs/mysql-durable-replay.md).
Copy `application.ts` and `demo.ts` into an ESM TypeScript project with the normal
`turbine-orm` package, mysql2 and Node types installed. Compile strictly with
NodeNext and target ES2023. Set `MYSQL_PORT` and `MYSQL_DATABASE` to an owned,
fresh MySQL database meeting the documented settings, then run the compiled demo.
The caller creates the database and pool and owns dropping/ending them. Keep the
mysql2 default UTF8MB4 collation or another compatible UTF8MB4 collation, and keep
all three session character sets at utf8mb4; the app refuses incompatible settings.

The demo appends one exact order, drains one bounded batch to a persistent
idempotent inbox, checks its projection, closes the app, proves the caller pool
survived and ends the pool. There is no infinite watcher. Run another finite
`consumeBatch` after reopening to reconcile. DDL initialization is fresh-only
and is not atomic because MySQL DDL implicitly commits.

The installed native verifier is `src/test/fixtures/mysql-durable-replay/run.mjs`.
It requires explicit `MYSQL_REPLAY_ROOT`, `MYSQL_REPLAY_NODE22`, `MYSQL_REPLAY_NODE24`, `MYSQL_BASEDIR` and
`MYSQL_LIBRARY_PATH`; it never borrows an external database. Its installed
consumer directories must already contain the pinned normal archive, mysql2
3.24.6, TypeScript 6.0.3 and Node types. All services belong to its invocation.
