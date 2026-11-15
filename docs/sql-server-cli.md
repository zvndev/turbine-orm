# SQL Server database-first CLI

SQL Server 2016+ uses the optional `mssql` driver. PostgreSQL remains the default
CLI engine. Set `engine: 'mssql'` or pass `--engine mssql` explicitly.

```sh
npm install turbine-orm mssql
npm install -D tsx typescript @types/node
# Export DATABASE_URL=mssql://user:password@host:1433/database privately.
npx turbine init --engine mssql --schema dbo
npx turbine pull
npx turbine status
```

`init` writes a `turbine.config.ts` that reads `DATABASE_URL`. It preserves existing
config and generated files, including with `--force`. With a URL, it generates
from an existing catalog unless `--skip-generate` is set or output already exists.
Without a URL, it only creates config. It never creates a database, applies DDL,
seeds data, changes permissions, or writes credentials to config.

`pull` and `generate` introspect the selected namespace (`dbo` by default) and
emit schema-specific types, metadata and an async client factory. `status` lists
tables and columns. Config supports `include`, `exclude`, `relationNames`,
`columnTypes`, `keepColumnNames`, `importExtension`, and `legacyToManyUniques`.
The latter keeps reverse unique-FK relations as arrays under their plural
names (`users.profiles`) instead of the to-one `users.profile`;
`--legacy-to-many-uniques` selects it from the CLI.
Generator flags such as
`--zod` and `--no-timestamp` also work. Empty introspection fails unless
`--allow-empty` is supplied. A misspelled type override fails, including when
filters omit its table; valid overrides for omitted tables are ignored.

```ts
import { turbine } from './generated/turbine/index.js';

const db = await turbine({
  server: 'sql.example.com',
  database: 'app',
  user: process.env.SQL_USER!,
  password: process.env.SQL_PASSWORD!,
  options: { encrypt: true, trustServerCertificate: false },
}, { logger: {} });

const users = await db.users.findMany({ select: { email: true } });
await db.disconnect();
```

The generated factory preserves the native `turbineMssql` target/options surface
and pool ownership. It accepts a URL, a native connection config object, or an
existing `MssqlPool`. It returns a promise. Driver TLS settings belong in the
connection config object's `options`; client options belong in the second
argument. A supplied pool remains caller-owned.

The native URL transport currently uses `encrypt: false` and
`trustServerCertificate: true`. CLI URLs reject query parameters and fragments
instead of silently ignoring TLS settings. Use the native factory with a config
object for connections that require different settings; CLI introspection does
not yet expose that connection-config surface.

`schema` selects the catalog namespace. Runtime SQL still uses unqualified table
names through the existing native factory, so the login's default schema must
resolve to the same objects. Neither CLI schema selection nor the native
`schema` client option changes the login's default schema. No session setting or
permission change is performed.

SQL-first migrations are described in [SQL Server migrations](sql-server-migrations.md).
Separate workflows provide [typed callback seeds](sql-server-seeding.md),
[catalog and compile tools over CLI/MCP](sql-server-tools.md), and a
[scoped catalog doctor](mssql-doctor.md). The `mssql-integration` gate runs their native suites against SQL Server 2022.
SQL Server remains Deferred and its lifecycle is not complete.
Code-first `push`/`diff`, `schemaFile`, `--with-schema`, `--include-views`, Studio
and observe remain unsupported. PostgreSQL-specific tool operations are refused.
Generate after applying schema changes with SQL-first migrations or your existing
SQL Server tooling.

The local test suite distinguishes packed driver-fixture tests from native SQL
Server tests. The latter require a disposable test database with permission to
create/drop temporary schemas and tables:

```sh
MSSQL_URL='mssql://…/disposable_test_database' TURBINE_REQUIRE_ENGINE=mssql \
  npx tsx --test src/test/mssql-cli-native.test.ts
npx tsx --test src/test/mssql-cli-project.test.ts src/test/mssql-cli-packed.test.ts
```

The native case checks real row effects, same-named tables in two schemas,
identity defaults, actual init/pull/status, filters, type overrides, empty-schema
refusal and unsupported migration-override refusal. It cleans up only its randomly
named objects. The existing SQL Server CI job runs this test with the required
engine token, so missing service prerequisites fail that job.
