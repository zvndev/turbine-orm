# D1 Worker binding

The D1 adapter was added in 0.94.0 and is Experimental in the
[engine support matrix](engine-support.md). It uses a supplied Cloudflare Worker
`D1Database` binding, its prepared statements and its native transactional batch.
It reuses Turbine's portable SQLite SQL generation and the supplied-transport
`turbineCore` ordinary-query and result machinery.
It does not open a Node SQLite database, a TCP socket or a PostgreSQL pool.

```ts
import { turbineD1 } from 'turbine-orm/d1';
import type { TurbineClient } from './generated/index.js';
import { SCHEMA } from './generated/metadata.js';

export default {
  async fetch(request: Request, env: Env) {
    const db = turbineD1<TurbineClient>(env.DB, SCHEMA);
    const users = await db.users.findMany({
      select: { id: true, name: true },
      with: { posts: { select: { title: true }, orderBy: { id: 'asc' }, limit: 3 } },
      orderBy: { id: 'asc' },
      limit: 10,
    });
    await db.disconnect();
    return Response.json(users);
  },
};
```

The generic contributes generated table accessor types. The returned client has
D1's API and refusal boundaries; it does not acquire the generated client's Node
SQLite transaction/session behavior. Existing metadata, generated row/input and
relation types are reused. The separate [generator](d1-generation.md) and [catalog reader](d1-introspection.md)
provide the D1-specific entry points. Without a generated client type, use `db.table<Row>('users')`.

The Worker must provide `node:async_hooks` for the shared core. The local runtime
fixture uses compatibility date `2026-01-01` with `nodejs_compat`. No other Node
builtin or database driver is required by the deployed optional entry graph.

## Reads and writes

Single-statement create, update, delete, eligible upsert, count, aggregate and
relation reads use prepared statements. Writes use SQLite `RETURNING`; rows are
mapped by the existing metadata, projection and relation parsers. Global filters
are validated at construction and apply to typed queries and relation reads.
Join, batched and auto relation loading share the existing query logic. A batched
relation read spans multiple ordinary statements; it has no snapshot guarantee.

Values are bound by numbered `?1` parameters, preserving repeated and reordered
references. Raw SQL also accepts `$1` numbering. Anonymous and named parameters,
unused trailing values, and more than 100 bound values are refused. Text outside
bindings must be trusted. SQL literals, quoted identifiers and comments do not
create placeholders or statement boundaries.

Booleans bind as 1/0, Dates as ISO text, JSON objects/arrays as JSON text, and
binary views as a copy of their exact byte range. Undefined binds as NULL.
Safe BigInts bind as numbers. Invalid Dates, non-finite numbers, unsafe integer
numbers/BigInts and unsupported JavaScript values are refused before dispatch.
Declared boolean, JSON, temporal and BLOB fields decode through metadata on
ordinary and nested reads. Raw results retain D1's native value shapes.

D1 returns JavaScript numbers and cannot promise exact retrieval of arbitrary
64-bit integers or decimals. Store exact values as TEXT, use string metadata for
those columns, or explicitly select textual values through raw SQL. SQLite
column affinity still applies. No PostgreSQL numeric, collation or engine parity
is claimed. D1 service limits, including SQL size and invocation limits, also
apply; this adapter does not split a native batch automatically.

## Native batches

```ts
const [post, count] = await db.$batch([
  db.posts.buildCreate({ data: { userId: 1, title: 'Hello', visible: true } }),
  db.posts.buildCount({ where: { userId: 1 } }),
]);

const results = await db.$batchRaw([
  { sql: 'UPDATE posts SET title = ?1 WHERE id = ?2', params: ['Updated', post.id] },
  { sql: 'SELECT title FROM posts WHERE id = $1', params: [post.id] },
]);
```

`$batch` accepts single-statement deferred queries built by the same facade and
returns a typed tuple in submission order. It validates every member before
preparing any statement, then calls `binding.batch` once. Later statements see
earlier statements' effects. A native SQL failure rolls back the batch. Native
unique, foreign-key, not-null and check violations map to Turbine's existing
constraint errors. `$batchRaw` retains the native results, metadata and ordering.

The batch commits before result transforms run. A missing-row exception or other
client-side transform failure cannot undo that commit. This is also why bulk
`createMany({ onConflict })` reconciliation is refused. Deferred batching does
not run execution middleware. Use ordinary typed calls when execution middleware
is required. Native batch does not use PostgreSQL pipeline, interactive
transactions, a callback, or a separately checked-out session.

`{ signal }` on either batch method checks cancellation before dispatch and throws
the exact abort reason. D1 offers no in-flight abort API here. After dispatch,
cancellation does not report a fictitious rollback; the native outcome settles
normally. Ordinary query timeouts follow the existing unknown-outcome timeout
contract and do not cancel D1 execution. Keep the Worker invocation alive until
its operations settle.

## Ownership and refusals

The binding remains owned by the Worker. Constructing the facade and calling
`connect()` perform no I/O and create no persistent connection. `disconnect()`
seals future facade calls, including hoisted accessors and lazy SQL, without
closing the binding. Disconnect drains admitted native batches and ordinary core operations. The
operations can still complete; callers must await their results. A new facade can reuse the same binding. No cross-request
session pinning, read-replica bookmark or consistency-session API is promised.

The adapter refuses `$transaction` callbacks and arrays, `transaction`,
`$withSession`, `$connection`, LISTEN/NOTIFY, row locks, PostgreSQL pipeline,
stream/cursor APIs, nested writes, lookup-first upserts and multi-statement writes
requiring an interactive checkout. Callbacks are never invoked. Raw transaction,
session, schema and migration SQL and multiple statements in one item are
refused before preparation. Use the supplied binding and D1 tooling explicitly
for schema provisioning and migrations. Turbine's Node SQLite migration history,
locking, authorizer and rebuild-atomicity contracts do not apply to D1.

## Evidence and verification

Focused tests execute a real D1 binding inside local Miniflare/workerd, including
prepared writes/reads, nested values, ordered batches, native constraint failures,
batch rollback, cancellation before dispatch and caller ownership. Required
runtime tests fail if Miniflare is unavailable. The local runtime is distinct
from a provider-hosted D1 run; no hosted certification is claimed.

`src/test/fixtures/d1/consumer.test.ts` checks generated ESM and CJS consumers under strict
TypeScript with `skipLibCheck: false`, official Worker binding type compatibility,
missing-export controls and no unrelated driver packages. `src/test/fixtures/d1/graph.test.ts`
rejects Node SQLite, TCP and PostgreSQL resolution before tree shaking, including
injected failure controls. The [generated factory](d1-generation.md) and
[catalog reader](d1-introspection.md) have separate installed-package gates.

Sources: [D1 database and batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/),
[prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/),
[return objects](https://developers.cloudflare.com/d1/worker-api/return-object/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/), and
[local development with Miniflare/workerd](https://developers.cloudflare.com/d1/best-practices/local-development/).

Run the required integration suite after building with `tsx --test
src/test/d1*.test.ts src/test/fixtures/d1/*.test.ts`. Its local Worker runtime
requires Node 22+ and Miniflare as a development prerequisite. It is deliberately
separate from the unbuilt unit suite and does not skip absent prerequisites.
