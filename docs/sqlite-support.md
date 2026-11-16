# SQLite support and limitations

Both `turbine-orm/sqlite` (builtin node:sqlite) and
`turbine-orm/better-sqlite3` use the same SQL dialect and client. The native
contracts below run against real in-process SQLite databases, not SQL-only
mocks. Optional better-sqlite3 is an application-installed peer, currently
accepted at `^12.11.1`; it is not a Turbine runtime dependency.

## Tested runtimes

| Driver | Node | sqlite_version() | Peer version |
|---|---|---|---|
| Builtin | 26.12.0 | 3.54.0 | n/a |
| Builtin | 24.10.0 | 3.50.4 | n/a |
| Builtin metadata reproduction | 22.16.0 | 3.49.1 | n/a |
| better-sqlite3 | 26.12.0 and 24.10.0 | 3.53.2 | 12.11.1 |

These are observations of the tested binaries, not minimum SQLite library
version guarantees for arbitrary compatible native handles.

## Native coverage

| Capability | Builtin | better-sqlite3 | Evidence and boundary |
|---|---|---|---|
| Queries and relations | yes | yes | [Shared native operations](../src/test/sqlite-driver-capabilities.test.ts) exercise join, batched and flatten reads. Composite batched relations are refused; use join. |
| Nested writes | yes | yes | The shared native test creates a parent and child atomically, then forces a child constraint failure and verifies rollback. |
| Transactions and savepoints | yes | yes | Shared native tests verify nested savepoint rollback, outer commit and outer rollback; [ownership tests](../src/test/sqlite-binding.test.ts) verify FIFO isolation. Read-only mode is E017. |
| Streaming | yes | yes | [Native stream tests](../src/test/sqlite-native-stream.test.ts), binding iterator tests and [result metadata races](../src/test/sqlite-result-metadata.test.ts). Synchronous stepping cannot interrupt an executing SQLite call. |
| Introspection and generate | yes | yes | [Builtin metadata](../src/test/sqlite-introspection-metadata.test.ts), [binding introspection](../src/test/sqlite-binding.test.ts) and [optional generation](../src/test/generate-better-sqlite3.test.ts). CLI uses the builtin driver. |
| Views | partial | partial | [Read-only catalog tests](../src/test/sqlite-view-readonly.test.ts), binding view tests and [actual CLI generation](../src/test/sqlite-cli-project-command.test.ts). Main ordinary views only; no DDL management or inferred keys. |
| Migrations | yes | partial | [Native migrations](../src/test/sqlite-migrations.test.ts) and actual CLI lifecycle. File workflows use node:sqlite, not the peer's supplied handle. Writes require Node >= 24.10 authorizer support. |
| Seeds | yes | partial | [Seed helper](../src/test/sqlite-seed.test.ts) and [actual CLI](../src/test/sqlite-seed-cli.test.ts). The helper accepts builtin handles/files. Peer clients can seed in an explicit transaction, or seed their file through the builtin CLI. |
| CLI: Studio, doctor, MCP | partial | partial | Existing-project Studio is refused. [Doctor](../src/test/sqlite-doctor-dispatch.test.ts) and [MCP tools](../src/test/sqlite-tools.test.ts) are read-only, file-based builtin workflows, including files used by better-sqlite3. |
| JSON | partial | partial | Schema-aware JSON reads, nested JSON and path scalar filters work; unsupported equality/containment shapes are E017. Native binary JSONB stays binary. |
| Upsert | yes | yes | Shared native operations verify single and bulk upserts; [cross-engine correctness](../src/test/cross-engine-correctness.test.ts) covers conditional and filtered cases. |
| Enums | partial | partial | Schema enums use TEXT plus CHECK, verified by invalid native inserts on both drivers. Catalog discovery does not infer labels from arbitrary CHECK SQL. |

Broad suites written specifically for `DatabaseSync` are builtin coverage.
They cannot count as independent better-sqlite3 execution. The shared native
capability and result-metadata suites, optional binding suite, and optional
generated-consumer checks supply explicit peer coverage. This does not assert
that every builtin-specific authorizer, session or metadata failure injection
has a peer equivalent. See [decoding](sqlite-decoding.md),
[views](sqlite-view-readonly.md), [streaming](sqlite-streaming.md),
[migrations](sqlite-migrations.md), [seeds](sqlite-seeding.md),
[doctor](sqlite-doctor.md) and [tools](sqlite-tools.md) for their exact contracts.

## Relations from introspection

Both drivers, local libSQL and D1 derive relations with the naming pass every
engine shares. A foreign key whose columns are exactly the child's primary key
or a complete unique index (not partial, no expression key) gives the parent a
to-one, named as PostgreSQL names it: `profiles.user_id INTEGER UNIQUE`
referencing `users` gives `users.profile` (`hasOne`), where 0.93.1 gave
`users.profiles` (`hasMany`). Each column pair must have the same type
affinity. Because the catalog does not report column collations, a to-one is
also refused when the child table's DDL or the unique index's DDL contains
`COLLATE`, and when the parent table's DDL contains `COLLATE` and the
referenced key is not the rowid alias (`INTEGER PRIMARY KEY`): with
`code TEXT COLLATE NOCASE PRIMARY KEY` on the parent, the child values `'a'`
and `'A'` both reference the parent `'a'`. `legacyToManyUniques: true` keeps
`users.profiles` as an array. Which entry points take it, and which take
`relationNames`, is listed in
[Relation names across engines](relation-names.md#keeping-the-old-output).

### Shapes that follow PostgreSQL

These shapes derive the relations PostgreSQL derives for the same schema
([details and the remaining edge cases](relation-names.md#known-differences)):

- A junction with no primary key, `post_tag_links (post_id, tag_id, UNIQUE (post_id, tag_id))`, gets `posts.tags` and `tags.posts` (`manyToMany`) when both keys reference their targets' primary keys ([why](relation-names.md#junction-keys-to-another-column)).
- `ON DELETE` and `ON UPDATE` are read from `PRAGMA foreign_key_list`: relations carry `onDelete` and `onUpdate`.
- Two composite FKs from `returns` to `orders` are named from a declared `CONSTRAINT` name, read from the `CREATE TABLE` text, or else from the name PostgreSQL would generate: `returns.returnsTenantIdOrderId` for an unnamed key.
- A name two FKs both want goes to the first in source table, then constraint name, order, not `PRAGMA foreign_key_list` order.

## E017 inventory

Every row below is an `UnsupportedFeatureError` reachable using a SQLite
dialect, the public SQLite factories, or the explicitly named optional wrapper.
Feature names can include a field, table or relation. Multiple throw sites for
the same refusal are grouped and cited. SQLite view writes are E003, not E017.

| Refused request | Implementation | Alternative or boundary |
|---|---|---|
| Row locks: update/share/no-key-update/key-share | [row-lock](../src/query/row-lock.ts) | SQLite locks writes at database level; no row-lock clause. |
| Full-text `search` | [where](../src/query/where.ts) | Use LIKE/contains or native FTS5 SQL; the ORM search operator is PostgreSQL syntax. |
| Array filters: has/hasSome/hasEvery/isEmpty | [where](../src/query/where.ts) | No native array-column type. JSON arrays do not supply this API. |
| Vector filters/order and vector DDL | [where](../src/query/where.ts), [schema SQL](../src/schema-sql.ts) | PostgreSQL with pgvector. |
| Whole-document JSON equality and containment | [where](../src/query/where.ts) | Compare a scalar at an explicit path. Includes bare object equality. |
| JSON-path equals with null, object, array or boolean | [where](../src/query/where.ts) | Use deeper string/number paths. SQLite extracts booleans as 1/0, so boolean equality cannot distinguish numbers. |
| Insensitive in/notIn | [where](../src/query/where.ts) | Use OR branches of insensitive equals. NOCASE folds ASCII only. |
| findMany distinct and groupBy distinctOn | [builder](../src/query/builder.ts), [aggregates](../src/query/aggregates.ts) | GROUP BY or application deduplication; DISTINCT ON is PostgreSQL-only. |
| Percentile aggregates | [aggregates](../src/query/aggregates.ts) | Native extension SQL if explicitly available, or PostgreSQL. The driver build need not enable SQLite percentiles. |
| Tuple cursor predicate | [cursor-tuple](../src/query/cursor-tuple.ts) | Default lexicographic cursors work; tuple mode is disabled on SQLite. |
| Pick-row lateral plan | [relations](../src/query/relations.ts) | Use the default subquery plan. |
| Positional relation JSON encoding | [relations](../src/query/relations.ts) | Use object encoding. |
| Composite-key batched relations, many-to-many and counts | [batched-loader](../src/query/batched-loader.ts) | Use join. The same module refuses a missing correlation key rather than returning silently empty relations. |
| Multiple all-default rows in createMany | [portable SQLite dialect](../src/d1/sqlite-dialect.ts) | One create({ data: {} }) per row in a transaction. |
| Batched/deferred upsert on a globally filtered table | [writes](../src/query/writes.ts) | Unbatched upsert performs the lookup, or explicitly bypass the filter. MySQL-specific reselect refusals do not apply to SQLite RETURNING. |
| Enum arrays | [schema SQL](../src/schema-sql.ts) | Scalar TEXT plus CHECK enums are supported; arrays are not. |
| planCacheMode, forceCustomPlan, statementTimeoutMs | [client](../src/client.ts), [builder](../src/query/builder.ts) | PostgreSQL connection/plan-cache options. Per-query timeout does not preempt synchronous SQLite stepping. |
| Read-only transactions and RLS sessionContext | [client](../src/client.ts) | No equivalent transaction mode or PostgreSQL session GUCs. Read-only CLI tools use a genuinely read-only file handle. |
| LISTEN and NOTIFY | [client](../src/client.ts) | PostgreSQL realtime only. |
| Client statements inside its own transaction callback | [SQLite pool](../src/sqlite.ts) | Use the callback's tx client. |
| Pooled statements inside an externally opened transaction | [SQLite pool](../src/sqlite.ts) | Use the caller-owned native handle until commit/rollback. Concurrent external-transaction streams are also refused. |
| Native streaming without transaction state, iterate or iterator.return | [SQLite pool](../src/sqlite.ts) | Builtin native streaming requires Node 22.x >= 22.16 or Node >= 24. Better-sqlite3 supplies these capabilities independently of node:sqlite. |
| Native streaming or stream cancellation on a query-only supplied transport | [portable dialect](../src/d1/sqlite-dialect.ts), [builder](../src/query/builder.ts), [checkout](../src/checkout.ts) | Public SQLite factories provide checkouts and native iterators. A custom query-only transport cannot provide their ownership or cancellation contract. |
| node:sqlite sessions, changesets and authorizer through the peer adapter | [better-sqlite3](../src/better-sqlite3.ts) | The adapted connection is not a complete DatabaseSync. Use the original peer's APIs or builtin file tooling. |
| Native-session operations on a generic turbine-orm/core transport with sqliteDialect | [core](../src/core.ts) | Use the SQLite-specific factory for a real session contract; this is a separate supplied-transport API. |
| Prisma compatibility options | [prisma-compat](../src/prisma-compat.ts) | Wrapper-wide refusals also apply atop SQLite: row-bounded updateMany/deleteMany; negative take; write include/relation select; nested include cursor/distinct; filtered relation counts; update expr/col; paged count/aggregate/groupBy; unsupported $extends components. Use native Turbine operations or explicit queries as the error suggests. |

The [capability guards](../src/test/capabilities-guard.test.ts),
[SQLite JSON refusals](../src/test/sqlite-json-contains.test.ts),
[shared native refusals](../src/test/sqlite-driver-capabilities.test.ts) and
related per-feature suites check that unsupported shapes fail, including cache
hits. Global filters preserve E017 when adding their filter-key context; they
do not introduce a separate capability.

Source branches gated on capabilities SQLite actually has are excluded from
this inventory: update expressions, NULLS FIRST/LAST, bulk upsert, ordinary
EXPLAIN and default single-row inserts. PostgreSQL protocol-cancel branches,
MySQL reselect/left-to-right SET restrictions, PowDB-only methods, libSQL and
D1-specific driver errors are not reachable through these two SQLite factories.

## Remaining limits

- Builtin metadata before Node 22.16 / 23.11 cannot identify boolean/JSON
  origins. Star-free reads retain their stored form; callers must not assume
  metadata-dependent generated types on those runtimes. Node 22.5 native rows
  also drop a `__proto__` column before Turbine receives it. Use a current
  metadata-capable runtime.
- Builtin readers before Node 22.16 have no working `iterate()` alternative
  (before 22.13 there is none, and 22.13 to 22.15's `iterate()` also fixes the
  width before stepping). A star
  projection whose schema changes between prepare and the first step can omit
  added columns or return an earlier cell for a repeated name there, as
  [decoding](sqlite-decoding.md#wildcards-and-duplicate-output-names) describes.
  Turbine keeps `all()` on those runtimes rather than refusing star SQL.
- Caller schema metadata is authoritative and unqualified. It does not rewrite
  itself after DDL and cannot distinguish conflicting main/temp/attached logical
  mappings. Native view JSON fallback only applies to main origins.
- SQLite NUMERIC/REAL is not exact decimal arithmetic. Safe integers are numbers;
  larger integers are strings. Native JSONB BLOBs are preserved, not parsed as
  textual JSON. Use the exact-native-integer generation option when appropriate.
- STRICT and WITHOUT ROWID discovery is supported, but arbitrary native types,
  generated expressions, CHECK clauses and quoted names do not all round-trip
  through code generation or schema diff. Unsupported identifiers are refused
  by generation. Main ordinary view columns are nullable and computed columns
  can be unknown. No view keys, view DDL, temporary or attached view discovery.
- Owned handles set foreign keys and durable connection defaults; direct native
  access and multiple wrappers require caller coordination. One SQLite handle
  provides no parallel execution or network-pool semantics.
- Query timeout, AbortSignal and stream idle cleanup act between synchronous
  pulls. They cannot preempt SQLite already executing. Batch size limits row
  count, not one row's JSON/BLOB size or SQLite sort workspace.
- Many-to-many nested writes support connect, disconnect and set. Nested target
  create/update/delete and other operations are E003, as enforced by
  [assertManyToManyOpsSupported](../src/nested-write.ts). Write the target in the
  same transaction, then connect it or write the junction rows explicitly.
- CLI generation does not select the peer factory. Use library generate with
  `target: 'sqlite', sqliteBinding: 'better-sqlite3'` for that output. CLI
  migrations, seed, doctor and MCP use builtin file handles. Existing-project
  Studio, observe and PostgreSQL import workflows are unavailable for SQLite.
