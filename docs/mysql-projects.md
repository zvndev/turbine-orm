# MySQL projects and generated clients

MySQL uses the canonical CLI engine name `mysql` and the optional `mysql2` peer.
PostgreSQL remains the default engine. Install the native driver and the TypeScript
config loader in the project:

```sh
npm install turbine-orm mysql2
npm install --save-dev tsx
npx turbine init --engine mysql --url 'mysql://user:password@localhost:3306/app'
```

The database must already exist. Init reads its catalog, creates a MySQL config
and local `.env` exclusively, adds `/.env` to `.gitignore`, and preserves existing
config, environment, migration and generated files, including with `--force`.
Check an existing `.env` before continuing: init never replaces its URL.
Init never creates a database, applies SQL or seeds rows. For an empty database,
it writes a starter UP/DOWN SQL file in `turbine/migrations`; apply schema changes
using native MySQL tooling before generating the client.

```ts
// turbine.config.ts
import type { TurbineCliConfig } from 'turbine-orm/cli';

export default {
  engine: 'mysql',
  url: process.env.DATABASE_URL,
  out: './generated/turbine',
  include: ['users', 'posts'],
  columnTypes: { 'users.settings': '{ theme: string; beta?: boolean }' },
} satisfies TurbineCliConfig;
```

```sh
npx turbine pull
npx turbine generate --no-timestamp --import-ext js
npx turbine status
```

`pull`, `generate`, `gen` and `g` share the MySQL introspector and generator.
`status` (or `info`) prints a catalog summary. Filters (`include`/`exclude`), relation
renames, column type overrides, `--keep-column-names`, `--import-ext`, `--zod` and
`--no-timestamp` use the existing generator contracts. Valid overrides for excluded
tables are omitted; unknown tables/columns still fail. Empty selections require
`--allow-empty`. Zod validators require the consumer's optional `zod` installation.

`--url` takes precedence over `DATABASE_URL`, which takes precedence over config
`url`. The URL must use `mysql://`, name a host and database, and contain no query
parameters or fragment: the existing introspector does not implement native driver
URL options. The database name supplies the CLI `schema`; an explicit `schema`
must match it. A MySQL URL without `engine: 'mysql'` or `--engine mysql` is refused.
Bad config, incompatible URLs and PostgreSQL adapters are refused before dispatch.

The generated factory is asynchronous in both ESM and CommonJS:

```ts
import { turbine } from './generated/turbine/index.js';

const db = await turbine(process.env.DATABASE_URL!, {
  connectionLimit: 4,
  globalFilters: { users: { email: { contains: '@' } } },
});
const users = await db.users.findMany({ select: { email: true } });
await db.disconnect();
```

It forwards the existing `turbineMysql` target union and native options. Applications
can pass a connection config object, an existing mysql2 pool, or a `MysqlPool`.
Advanced native options such as TLS belong on an injected pool. Injected mysql2
pools need `namedPlaceholders: true`; the application retains ownership and closes
them. Schema-specific accessors, transaction callbacks, nested inputs and global
filters retain their generated types. Await the factory before accessing tables.
The existing engine requires MySQL 8.0+ and rejects MariaDB and MySQL 5.7.

MySQL project setup supports init/pull/generate/status. Separate workflows cover
[native SQL migrations and recovery](mysql-migrations.md),
[conservative schema comparison](mysql-schema.md),
[journaled push](mysql-push.md), [typed seeds](mysql-seeding.md) and
[read-only tools](mysql-tools.md). `--legacy-to-many-uniques` is forwarded to
introspection. `--include-views` and PostgreSQL-specific commands remain refused.
Use `turbine generate --engine mysql --help` for project command help.

## Native integration gate

The service test creates and drops only a randomly named disposable database. Use
a dedicated MySQL 8 test service and a test account with CREATE/DROP DATABASE:

```sh
MYSQL_URL='mysql://test:password@127.0.0.1:3306/test' \
TURBINE_REQUIRE_ENGINE=mysql \
npx tsx --test src/test/mysql-cli-project.integration.test.ts
```

It covers additive empty/existing init, actual catalog/relations, type overrides and
filtering, generated files, ESM/CommonJS TypeScript CLI config loading, native JSON
writes/reads and nested relation results. Missing `MYSQL_URL` is an explicit skip;
`TURBINE_REQUIRE_ENGINE=mysql` makes that missing prerequisite fail. Packed consumer
tests separately verify module resolution, async typing and the generated wrapper
with an injected transport; those checks do not certify native server behavior.
