# Migration operations

This describes behavior added in 0.94.0. It does not change engine support
tiers. Migration files, SHA-256 checksums and command names keep their existing
formats. Use a dedicated deployment process and the engine's native runtime and
driver prerequisites.

| Engine | Deployment boundary | After interruption |
| --- | --- | --- |
| PostgreSQL | One transaction per ordinary file; one session advisory lock per database | Earlier files remain committed. The interrupted file rolls back when its backend exits. Inspect history before retrying. |
| SQLite | One native writer transaction for the entire selected batch | The selected batch rolls back. A writable native open may first need to recover a hot journal. |
| MySQL | One connection owns `GET_LOCK`; DDL implicitly commits | Durable DDL/data may remain. A dirty journal blocks automatic replay until explicit manual reconciliation. |
| SQL Server | Application locking and transactional batch/history handling | Preserve the existing unknown-COMMIT warning: a lost COMMIT response cannot establish whether it committed. Native SQL Server operations remain unverified here. |

## PostgreSQL admission and recovery

Run against a direct database endpoint. PgBouncer transaction pooling cannot
preserve the session advisory lock. Checking out a logical client or wrapping a
connection does not establish backend pinning. The existing CLI pooler refusal
and override are unchanged; an override does not prove safety.

Checksum comparison now happens before checksum writes. If pending UP SQL fails
the embedded-transaction, executable-UP or destructive-statement checks, existing
history checksums remain unchanged even with `--allow-drift`. Destructive or
embedded-transaction DOWN refusal also leaves verified legacy checksums alone.
Previously those paths could bless modified bytes or upgrade legacy hashes
before refusing the requested work. Successful admission retains the existing
re-baseline reporting and verified legacy upgrade behavior. An initially absent
tracking table can still be created before admission; this is not a guarantee
that every refusal performs zero database writes.

Ordinary files retain their individual transactions. Admission is separate from
execution: an admitted file can still fail in the database, and earlier files
and admitted checksum updates can already be durable. Files carrying
`-- turbine:no-transaction` retain their explicit partial-effect contract. Their
statements must be safe to retry after inspecting and reconciling actual effects.
Do not rewrite an applied migration merely to make a failed deploy appear clean.

Active application transactions can block migration DDL. The migration lock only
coordinates cooperating migration processes; it does not make application locks
disappear. A waiting deploy reads pending history after acquiring the lock, so it
does not reapply the preceding deploy's files. On backend loss, inspect status and
the actual schema/data before retrying. Do not infer a known COMMIT outcome from a
connection error or automatically replay an uncertain write.

## SQLite and MySQL operations

SQLite migration writers require Node >= 24.10 with native `setAuthorizer` and
`isTransaction`; read inspectors have the separately documented older floor.
An active reader in rollback-journal mode can prevent COMMIT. A failed COMMIT
must leave the entire selected batch unapplied, including history. Writer waits
are synchronous and block their JavaScript thread. After a killed process,
allow native journal recovery before evaluating status; a read-only inspector
cannot promise to recover a database requiring writes.

MySQL migrations require the optional `mysql2` driver and the documented native
server/storage/SQL-mode prerequisites. Session lock ownership spans implicit DDL
commits, but a dead client process need not immediately stop a blocked server
statement. Observe the actual backend and actual effects. The journal's completed
statement count records confirmed responses, not proof that later work did not
happen.

For dirty MySQL state, retain the unchanged migration file, inspect schema/data
and the exact journal, then manually reconcile to the desired applied or
rolled-back state. Only then use the existing explicit recovery operation with
the exact name/checksum and partial-DDL acknowledgement. Recovery updates
metadata; it neither executes inverse SQL nor verifies that a human's
reconciliation was correct. Never erase the journal and blindly retry.

## Focused validation

The operations suites use disposable native databases and separate processes.
They check exact rows, history order/checksums, active locks, concurrent deploys,
backend termination, killed processes and recovery. They do not measure speed,
certify a hosted provider or prove CockroachDB/YugabyteDB adapter behavior.

```sh
TURBINE_REQUIRE_ENGINE=postgres DATABASE_URL=... node --import tsx --test src/test/migration-operations-postgres.test.ts
TURBINE_REQUIRE_ENGINE=sqlite-migrations node --import tsx --test src/test/migration-operations-sqlite.test.ts
TURBINE_REQUIRE_ENGINE=mysql MYSQL_URL=... node --import tsx --test src/test/migration-operations-mysql.test.ts
```

Use native PostgreSQL, Node 24.10+ SQLite and native MySQL independently. Run
MySQL under both ordinary strict mode and strict mode with
`ANSI_QUOTES,NO_BACKSLASH_ESCAPES`. Missing required prerequisites must fail;
optional local skips are exclusions. SQL Server driver fixtures and a
required-service refusal are separate evidence scopes and do not certify native
SQL Server. These modules are Node CLI code; no edge migration runtime is claimed.
