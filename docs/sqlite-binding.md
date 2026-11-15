# Optional better-sqlite3 binding

The optional `turbine-orm/better-sqlite3` entry uses the same typed tables,
queries, transactions and stream APIs as `turbine-orm/sqlite`. The existing
SQLite entry continues to use Node's built-in `node:sqlite` binding.

Install `better-sqlite3` in the application. The tested peer floor is 12.11.1.
Importing the optional entry does not load the peer. Opening a path loads it
lazily and reports a typed connection error if it is missing.

```ts
import { turbineBetterSqlite3 } from 'turbine-orm/better-sqlite3';
import { SCHEMA } from './metadata.js';

const db = await turbineBetterSqlite3('application.db', SCHEMA);
const rows = await db.table('users').findMany({ limit: 100 });
await db.disconnect();
```

A path belongs to the returned client. `disconnect()` closes its handle.
An already-open native handle belongs to its caller: the factory does not
change its pragmas, and `disconnect()` leaves it open. Keep the original handle
for native `better-sqlite3` APIs. The pool's internal compatibility handle is
not a full native handle. It explicitly refuses Node sessions, changesets and
authorizer registration. This entry does not add a migration CLI, native
authorizer, backup or changeset lifecycle.

Programmatic generation can select this binding explicitly:

```ts
import { generate } from 'turbine-orm';

generate({ schema: SCHEMA, target: 'sqlite', sqliteBinding: 'better-sqlite3', outDir: './generated' });
```

The generated `turbine()` factory is asynchronous and must be awaited. Omitting
`sqliteBinding`, or selecting `'node:sqlite'`, preserves the synchronous native
SQLite factory. This option is not forwarded by the CLI.

Factory-owned file handles enable WAL unless `wal: false`, retain FULL
synchronous durability, enable foreign keys unless `foreignKeys: false`, and
use the same bounded busy timeout as the built-in binding. Supplied handles
retain the caller's settings. Transactions and streams share the existing
single-handle FIFO ownership rules. Outside work waits for an owning
transaction; work issued through the original client from its own transaction
callback is refused. Releasing a pool checkout rolls back its unfinished
transaction. Caller-opened transactions remain caller owned.

Statements are prepared afresh. Decoders use native result metadata after
execution, including after schema changes and rollback. Big integers return
as exact decimal strings outside JavaScript's safe range. BLOBs return as
`Uint8Array`; boolean, JSON, date and null decoding follows the table schema.
Full-returning bulk writes return every inserted row.

Streams use the peer's native iterator and close it on early return, abort,
transaction end or pool shutdown. Node 20 uses array rows to preserve native
result columns named `__proto__`; the adapter creates own fields before shared
decoding. Factory-owned handles also use array rows for eligible ordinary reads on newer runtimes. Supplied handles keep object rows there. Row mode is selected before
iteration because this peer refuses changes while an iterator is executing. Batches bound row
count, not bytes or SQLite sort memory. Synchronous native work observes
cancellation between pulls, so it cannot promise an interrupt during a native
step.

Binding comparisons must remain explicit: Node's built-in driver and
`better-sqlite3` can embed different SQLite versions and have different native
allocation costs. Switching bindings is a full-stack change. Use separate
matched-binding comparisons to investigate ORM overhead.
