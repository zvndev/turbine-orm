# MySQL typed seeds

MySQL seeds are explicit trusted JavaScript or TypeScript callback modules. They
run against an existing MySQL 8 database through the optional `mysql2` driver.
`init` never executes a seed. Apply your SQL migrations first.

```sh
npm install mysql2
npm install --save-dev tsx  # needed only for TypeScript modules/config
npx turbine seed --engine mysql
```

Select the module in your CLI config. `seedFile` takes precedence over the legacy
`seed` alias. Without either, the CLI uses the existing seed discovery order:
`seed.ts`, `seed.js`, `seed.sql`, then `turbine/seed.ts`, `turbine/seed.js`,
`turbine/seed.sql`. A discovered SQL file is refused; select `.mjs`, `.cjs`,
`.mts` or `.cts` explicitly with `seedFile`. An explicitly configured missing file fails;
it does not fall back to another seed.

```ts
// turbine.config.ts
import type { TurbineCliConfig } from 'turbine-orm/cli';
export default {
  engine: 'mysql',
  url: process.env.DATABASE_URL,
  seedFile: './turbine/seed.ts',
} satisfies TurbineCliConfig;
```

The module must export a default callback. Importing a module that only calls
`defineMysqlSeed` declares the callback without running it. Its other top-level
code still executes when imported. Use `.js`, `.mjs` or `.cjs` without `tsx`;
`.ts`, `.mts` and `.cts` require `tsx` installed in the invoking project. The
installed ESM and CommonJS CLI register that loader themselves.

```ts
// turbine/seed.ts
import { defineMysqlSeed } from 'turbine-orm/mysql/seed';
import type { User } from '../generated/turbine/types.js';

export default defineMysqlSeed(async (tx) => {
  const users = tx.table<User>('users');
  await users.upsert({
    where: { email: 'admin@example.test' },
    create: { email: 'admin@example.test', displayName: 'Administrator' },
    update: { displayName: 'Administrator' },
  });
});
```

Use actual database table names with `table<T>()`. The supplied row type gives
the ordinary query methods their field/value and result types; metadata and
server constraints remain authoritative at runtime. This handle does not add
generated named accessors. Seeds do not track history or promise automatic
idempotence: choose stable unique keys and write a callback safe to repeat.

## DML rollback boundary

MySQL DDL implicitly commits. This API therefore exposes a deliberately limited
handle: typed `findMany`, `findFirst`, `findFirstOrThrow`, `findUnique`,
`findUniqueOrThrow`, `count`, `aggregate`, `groupBy`, `create`, `createMany`,
`update`, `updateMany`, `delete`, `deleteMany` and `upsert`, plus callback-only
`$transaction` for nested savepoints. Nested callbacks receive the same limited
surface. Raw SQL, DDL, control SQL, deferred statements, streaming, driver
connections, pool access and disconnect are unavailable and refused at runtime.
It does not accept SQL seed files or implement preview/dry-run.

Await every operation, including nested transactions. Successful callbacks commit
their awaited DML together; a thrown callback error rolls that DML back. The
native transaction machinery checks unfinished work and guards transaction
scope; the seed wrapper also closes each handle when its own callback settles.
A captured table or nested handle cannot perform later operations. A failed
nested callback rolls back its savepoint; let the error escape the outer
callback to roll back all of the seed's writes.

Before invoking the callback, the runner requires a selected database, validates
that metadata references existing base tables, and refuses any non-InnoDB base
table or trigger in the database, including tables excluded from introspection.
A direct database-wide or global `TRIGGER` privilege is required to establish
that the trigger catalog is complete. Role-only and per-table grants do not
satisfy this conservative check. Accounts with partial revokes are refused:
a global grant can remain visible while a database-level revoke hides triggers.
Without that privilege an empty trigger catalog
could hide a trigger that writes to a nontransactional table.

Run while the schema is stable: concurrent external schema changes, temporary
tables shadowing base tables on supplied connections, malicious/custom pool
implementations, and code that mutates captured metadata are outside the
supported contract. Supply ordinary mysql2 pools without temporary tables and
use metadata for this database. Imports, files, network calls, captured
connections, separate clients and arbitrary module side effects are outside the
transaction. This executes trusted code and is not a security sandbox. An
unanswered COMMIT raises E021 and can leave the commit outcome unknown. Use a
database-enforced idempotency key before retrying; a read alone cannot settle
an in-flight COMMIT. Auto-increment counters are not transactional and may
have gaps after rollback.

## Direct use and ownership

```ts
import { runMysqlSeed } from 'turbine-orm/mysql/seed';
import { SCHEMA } from './generated/turbine/metadata.js';
import seed from './turbine/seed.js';

await runMysqlSeed(process.env.DATABASE_URL!, SCHEMA, seed);
```

The target accepts a URL, native factory connection config, or an existing
mysql2 promise pool. A URL/config pool is closed on success and failure. A
supplied pool remains open and keeps its SQL mode and lifecycle; configure its
named placeholders and normal Turbine driver flags as described for the MySQL
factory. The seed runner refuses a borrowed connection already in a transaction
or with autocommit disabled before starting its own transaction. It neither
commits nor rolls back the caller's transaction. Supply a promise pool directly;
a prewrapped `MysqlPool` is deliberately refused because it hides the native
checkout needed for this check.

`seed --help` with a MySQL config and `seed --engine mysql --help` describe this
workflow. Supported command flags are `--engine`, `--url`/`-u`, `--verbose`/`-v`
and `--help`/`-h`. Positional files, `--schema`, `--schema-file`, PostgreSQL seed
flags, `--force`, `--dry-run` and preview are refused before loading the module.
