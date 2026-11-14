# Documentation index

For getting started and the released API, use the [project README](../README.md)
and [public documentation](https://turbineorm.dev). Documents marked 0.94.0
describe additions first released in that version; an older installed package
does not have them.

| Document | Purpose |
| --- | --- |
| [Engine and version support](engine-support.md) | Generated matrix: support tier per engine and transport, the versions CI exercises, and the tests behind each feature claim |
| [Stability policy](../STABILITY.md) | Stable and Experimental surfaces, compatibility and formal 1.0 criteria |
| [Roadmap](ROADMAP.md) | Released baseline, 0.94.0 additions, proposed engine lifecycle and acceptance gates |
| [Engine integration checklist](engine-integration-checklist.md) | Practical implementation/review steps, source entry points and an evidence example |
| [Engine evidence and certification](engine-certification.md) | Narrow Yugabyte candidate smoke and evidence format, explicitly uncertified |
| [Local libSQL binding](libsql-local.md) | 0.94.0 local file/memory adapter and typed generation; excludes remote/sync/new Turso engine |
| [Local libSQL projects](libsql-cli.md) | Integrated init/pull/generate/catalog status, [typed seeds](libsql-seeding.md), and [read-only migration inspection](libsql-migration-inspection.md) and an [additive-only deploy](libsql-native-deploy.md) |
| [D1 Worker binding](d1-binding.md) | Integrated supplied binding, native batch, [catalog](d1-introspection.md) and [generated factory](d1-generation.md); local workerd evidence, no hosted certification |
| [Neon WebSocket binding](neon-websocket.md) | 0.94.0 optional Pool/Client ownership and session contracts; local native relay evidence only |
| [Neon HTTP binding](neon-http.md) | 0.94.0 stateless single-query and native batch facade; local PostgreSQL-backed HTTP bridge evidence; no hosted certification |
| [Live queries](live-queries.md) | 0.94.0 bounded notification-driven refetch and reconnect resync; no durable replay |
| [Notification multiplexing](notification-multiplexing.md) | 0.94.0 shared native listener with bounded subscriptions and explicit session affinity |
| [Migration operations](migration-operations.md) | 0.94.0 checksum admission, active-connection locking and engine-specific interruption/recovery boundaries |
| [SQLite migrations](sqlite-migrations.md) | Native SQL migrations, locking, checksums and runtime/policy limits |
| [SQLite streaming](sqlite-streaming.md) | Native incremental iteration, handle ownership and payload limits |
| [SQLite generated example](../examples/sqlite-generated/README.md) | Schema-specific factory from code-first or introspected metadata |
| [SQLite lifecycle example](../examples/sqlite-lifecycle/README.md) | Persistent-project init, migrations, generation and status |
| [SQL Server typed seeds](sql-server-seeding.md) | Restricted callback helper and CLI; native suite in the `mssql-integration` job |
| [Native lifecycle consumers](example-lifecycle-guide.md) | Packed SQLite/MySQL fresh and existing projects with recovery controls |
| [MySQL typed seeds](mysql-seeding.md) | 0.94.0 trusted DML callbacks and explicit native seed CLI |
| [MySQL schema comparison](mysql-schema.md) | 0.94.0 conservative diff and reviewed SQL migration scaffolding |
| [MySQL tools](mysql-tools.md) | 0.94.0 owned read-only snapshots, catalog/compile/sample tools and PII boundaries |
| [MySQL metadata](mysql-introspection-metadata.md) | Native generated columns, complex key facts and conservative relation cardinality |
| [SQL Server tools](sql-server-tools.md) | 0.94.0 fixed catalog reads and compilation; native suite in the `mssql-integration` job |
| [SQL Server metadata](mssql-introspection-metadata.md) | Scoped key/default/generated facts and conservative relation cardinality |
| [Relation names across engines](relation-names.md) | The unique foreign key to-one rule, which entry points take `legacyToManyUniques` and `relationNames`, and the edge cases that still differ across engines |
| [Usage guide](USING-TURBINE-ORM.md) | Repository guide to query and schema APIs |
| [Prisma migration guide](migrate-from-prisma.md) | Compatibility tooling and migration steps |
| [Benchmarks](../benchmarks/README.md) | Reproduction, exact headline checks and remaining measurement limits |
| [Contributor workflow](WORKFLOW.md) | Required branches, gates, release process and public-repository rules |
