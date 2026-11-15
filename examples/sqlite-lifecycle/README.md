# SQLite CLI lifecycle

Use a persistent SQLite file, SQL migrations, and a schema-specific typed client.
This workflow uses Node's built-in SQLite driver. Init, pull, and schema status
require Node 22.12+; native migration writes require the driver's `isTransaction`
and `setAuthorizer` capabilities (Node 24.10+). Use a current Node version for
this full example.

In a new project:

```sh
npm init -y
npm install turbine-orm
npm install --save-dev typescript tsx @types/node
npx turbine init --engine sqlite --yes
npx turbine migrate status
npx turbine migrate up
npx turbine generate --no-timestamp --import-ext js
```

Init creates `turbine.config.ts`, a persistent `turbine/dev.sqlite` database, and
a starter `turbine/migrations/<timestamp>_create_users.sql` migration. It leaves
the SQL for `migrate up` to apply. Keep the SQL migration files in version
control; ignore the local database, its `-wal` / `-shm` companions, and generated
output. Repeated init preserves existing config, migrations, and generated
files, including with `--force`.

Create `app.ts`:

```ts
import { turbine } from './generated/turbine/index.js';

const db = turbine('./turbine/dev.sqlite');
try {
  await db.users.create({
    data: { email: 'hello@example.test', displayName: 'Hello SQLite' },
  });
  const users = await db.users.findMany({
    select: { email: true, displayName: true },
    orderBy: { id: 'asc' },
  });
  console.log(users);
} finally {
  await db.disconnect();
}
```

Run it with `npx tsx app.ts`. In a CommonJS project, put the awaited operations
inside `async function main()` and call `void main()`. The generated factory
works in both module modes. For emitted native Node ESM, use a NodeNext
TypeScript configuration and keep `--import-ext js`.

For later changes:

```sh
npx turbine migrate create add_user_bio
# Edit the new file's -- UP and -- DOWN sections using SQLite SQL.
npx turbine migrate up --allow-destructive
npx turbine pull --no-timestamp
npx turbine status
# In deployment, apply committed migration files without prompts:
npx turbine migrate deploy
```

For example, a migration can contain:

```sql
-- UP
ALTER TABLE users ADD COLUMN bio TEXT;

-- DOWN
ALTER TABLE users DROP COLUMN bio;
```

The native migration policy conservatively requires destructive consent for all
ALTER TABLE statements, including this additive change. Review the SQL before
using `--allow-destructive`.

Rollback uses `npx turbine migrate down --allow-destructive`; review the DOWN
SQL and back up valuable data first. Root `status` describes tables;
`migrate status` describes migration history.

For an existing database:

```sh
npx turbine init --engine sqlite --url ./existing.sqlite --yes
npx turbine pull --no-timestamp
```

Init introspects an existing schema and generates its typed factory. It does
not invent a baseline migration for existing tables. Prepare and review a SQL
baseline separately before deploying to an empty environment. Pull, generate,
and status open an existing database read-only and refuse missing files.

The URL setting remains `url` / `--url` / `DATABASE_URL`, with flag, environment,
then config precedence. SQLite accepts local filenames, `file:./relative.sqlite`,
`file:///absolute/path.sqlite`, and `sqlite:./relative.sqlite`. It rejects
`:memory:`, remote URLs, URI query/fragment options, PostgreSQL connection
strings, PostgreSQL adapters, and non-`main` schemas. An exported PostgreSQL
`DATABASE_URL` must be unset or overridden with `--url` in this project.

SQLite schema diff/push, CLI seeding, Studio, and doctor are not supported by
this lifecycle. Maintain schema changes in explicit SQLite UP/DOWN SQL. The
existing introspector omits views, keeps reverse unique-FK relations to-many,
and treats primary keys as defaulted, including natural keys. Generation
supports table include/exclude filters, relation name overrides, column type
overrides, raw column field names, Zod output, and sibling import extensions.
The root package still installs `pg`.
