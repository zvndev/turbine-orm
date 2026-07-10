# PowDB Support Plan — Turbine ORM's Fourth Backend

**Status:** Approved direction / sequenced implementation plan
**Author:** database-tooling architect (planning pass)
**Date:** 2026-06-25
**Turbine reviewed:** v0.19.2 · **PowDB reviewed:** v0.6.1 (`Cargo.toml:6`, client `@zvndev/powdb-client@0.6.1`)
**Scope:** Add **PowDB / PowQL** as a first-class Turbine backend, alongside PostgreSQL.
**Constraint:** Planning + grounding only. **No source code is modified by this plan.**
**Decision context:** This **reverses** the earlier `docs/strategy/powdb-decision.md` "don't build it"
recommendation. Kirby has decided to ship PowDB support. This document treats that doc's
"why it's hard" list as the **problem set to solve**, not a reason to stop.

> **TL;DR.** PowDB support is built **on top of the multi-dialect Phase-0 seam**
> (`docs/strategy/multi-dialect-plan.md`) as a fourth backend, but it needs **two things that
> seam does not yet have**: (1) a **non-pg transport** (`@zvndev/powdb-client`'s binary TCP
> protocol, not the Postgres wire), and (2) a **PowQL query-generation backend** that lives
> *above* the SQL-only `Dialect` (PowQL is a different language shape — a left-to-right pipeline,
> not SQL). Three PowDB realities define the work: **no `RETURNING`** (writes return an affected
> count → use the Phase-0 `reselect` result strategy), **no generated/serial IDs** (the app must
> supply primary keys → Turbine generates a UUID client-side via `defineSchema`), and **no JSON
> aggregation and no link navigation** (the headline single-query `json_agg` nested `with`
> **degrades to batched N+1 loaders** — the single-query guarantee does **not** hold on PowDB, and
> the docs must say so). Ship as a `turbine-orm/powdb` subpath with `@zvndev/powdb-client` as an
> **optional peer dependency** (root stays one-dependency). Factory: `turbinePowDB(connOpts, schema)`.
> Total rough sizing: **~9–14 engineer-weeks** to a credible CRUD+relations MVP **on top of**
> Phase-0; parity is **gated on PowDB engine work** (the §9 ask-list).

---

## 0. Ground truth — both repos, read first-hand

Everything below is grounded in the real source of both repos. Citations are file/line.

### 0.1 What PowDB is, and its concurrency model

PowDB is a **pure-Rust single-node embedded database with its own query language, PowQL** — not
SQL. The engine is `powdb_query::executor::Engine`, owning a `Catalog` (tables → columns +
B+tree indexes) and a `Wal`; the server wraps it in **`Arc<RwLock<Engine>>`** (`crates/server/src/handler.rs:312`).
`dispatch_query` (`handler.rs:338`) **splits read/write locks**: read-only PowQL takes `.read()`
(concurrent scans parallelize), every mutation takes `.write()` — so **all writes are globally
serialized through one lock**; it is **single-writer**. The wire layer is **strictly
request/response — no pipelining** (`docs/design/2026-06-05-deployment-and-sync-strategy.md:30`).
Pre-1.0, single-node only (no replication/sharding); deadlock detection + lock timeouts are a
**P1 roadmap item, not yet shipped** (`docs/design/2026-06-06-enterprise-readiness-roadmap.md:31`).

### 0.2 The client surface (the transport we must bind)

`@zvndev/powdb-client` (`clients/ts/`, package `@zvndev/powdb-client`, optional peer
`@types/node`) exposes a clean async API over a binary TCP/TLS socket:

| Surface | Signature (`clients/ts/src/…`) | Notes |
|---|---|---|
| `Client.connect(opts)` | `index.ts:178` | `opts = { host, port, dbName?, password?, user?, connectTimeoutMs?, tls? }`. **Host/port, not a connection string.** |
| `client.query(powql, params?, opts?)` | `index.ts:277` | **PowQL** text + positional **`$N` params** (`QueryParam = string\|number\|bigint\|boolean\|null`, `index.ts:51`); token-bound, injection-inert. |
| `client.querySql(sql, opts?)` | `index.ts:341` | Routes through the server-side **SQL frontend** (`docs/SQL.md`). |
| `client.queryTyped(powql, schema, opts?)` | `index.ts:394` | Coerces string columns to JS via a caller-supplied `TypedSchema`. |
| `client.watch(q, {intervalMs,onRows})` | `index.ts:419` | **Polling** live-data (no push). |
| `client.close()` | `index.ts:475` | Graceful Disconnect. |
| `new Pool(opts)` / `acquire` / `release` / `destroy` / `withClient` / `close` | `pool.ts:116` | FIFO pool, `max` (default 10), retry/backoff. Broken clients must be `destroy`'d, not `release`'d. |
| `escapeIdent` / `ident` / `powql` tagged template | `escape.ts` | Identifier escaping + a `powql\`…\`` builder. |

**Result model (`QueryResult`, `index.ts:37-41`) — the keystone constraint:**

```ts
| { kind: "rows";   columns: string[]; rows: string[][] }   // ALL VALUES ARE STRINGS
| { kind: "scalar"; value: string }
| { kind: "ok";     affected: bigint }                       // writes return a COUNT — no RETURNING
| { kind: "message"; message: string }
```

Every value serializes to a string server-side (`value_to_display`): Int→digits, Float→`{}`,
Bool→`"true"`/`"false"`, **DateTime→microseconds-since-epoch** (not ISO), Uuid→canonical,
**Bytes→`"<N bytes>"` (LOSSY)**, NULL→the bareword `"null"` (`clients/ts/src/typed.ts:1-25`).
Coercion is caller-driven via `TypedSchema` (`ColumnType = "int"|"float"|"bool"|"str"|"datetime"|"uuid"`,
`typed.ts:33`) — `bytes` throws; for `str` columns the `"null"` token is ambiguous with a literal
string `"null"` (`typed.ts:54-58`).

### 0.3 PowQL operation surface — far richer than the decision doc implied

PowQL is a pipeline language (`<Table> [distinct] [filter e] [group k [having e]] [order k] [limit n]
[offset n] { projection }`). **Shipped** (`AGENTS.md:219`, `docs/POWQL.md`): full scan, `filter`
(`=`,`>`,`<`,`>=`,`<=`,`and`/`or`/`not`, `in (list)`, `not in`, `between … and`, `like "A%"`,
`is null`/`is not null`, `?? ` coalesce, `case when`), `order` (multi-key asc/desc), `limit`/`offset`,
`distinct`, aggregates (`count`/`sum`/`avg`/`min`/`max`, `count(distinct …)`), `group … having`,
**joins** (inner/left/right/cross with `on` + alias-qualified refs), subqueries (IN / NOT IN / EXISTS /
correlated), `union`/`union all`, window functions, **mutations** (`insert` single + multi-row,
`update { col := expr }`, `delete`), **`upsert T on .key { … } [on conflict { … }]`** (key must be
`unique`), DDL (`type T { required unique field: t }`, `drop`, `alter … add column`, `alter … add unique`),
prepared queries, and **explicit transactions** (`begin`/`commit`/`rollback`).

**The SQL frontend** (`docs/SQL.md`, `client.querySql`) lowers a *subset* to PowQL: SELECT/JOIN/
WHERE/GROUP/HAVING/ORDER/LIMIT/OFFSET, INSERT … VALUES, UPDATE, DELETE, CREATE TABLE/INDEX, ALTER,
DROP, BEGIN/COMMIT/ROLLBACK. **But it explicitly rejects** SQL `IN` lists/subqueries, scalar/`EXISTS`
subqueries, table constraints, and `BETWEEN` — and has **no `RETURNING`, no `ON CONFLICT`/upsert**.
AGENTS.md frames the SQL tier as "the translation tier is the thing we're removing." (Decision in §2.)

### 0.4 The five hard constraints (the problem set)

| # | Constraint | Evidence | Consequence for Turbine |
|---|---|---|---|
| C1 | **No `RETURNING`** | writes → `{kind:"ok", affected}` (`index.ts:40`) | `create/update/delete/upsert` can't read the row back → **`reselect`** (§4) |
| C2 | **No generated/serial/default IDs** | "PowDB does not generate implicit IDs — every column must be explicitly defined" (`docs/POWQL.md:528`); omitted fields default to null only | App must supply PKs → Turbine **generates a UUID client-side** via `defineSchema` (§4) |
| C3 | **No JSON aggregation & no link navigation** | no `json` type (`docs/POWQL.md` type system: 7 scalar types); `User.posts` = "not yet implemented" (`AGENTS.md:112,223`) | **Single-query `json_agg` nested `with` is impossible** → **batched N+1 loaders** (§3) |
| C4 | **No introspection wire surface** | "PowDB has no `describe` statement yet" (`typed.ts:17`); Catalog exists engine-side but isn't exposed | **Code-first `defineSchema` is the interim (and primary) path** (§6) |
| C5 | **Single global `RwLock`; no isolation levels; no savepoints; no pipelining** | `handler.rs:312,338`; "Nesting transactions is not supported" (`docs/POWQL.md`); request/response only | `$transaction` maps to `begin/commit/rollback`; **nested tx / isolation / advisory locks throw**; `pipeline()` degrades to sequential (§5, §8) |

### 0.5 Where Turbine's seams reach — and the Phase-0 dependency

Turbine has three relevant seams. PowDB needs all of them generalized, and **two of those
generalizations are exactly the multi-dialect Phase-0 deliverables** — so **PowDB depends on
Phase-0 being built first.**

- **Transport** — `PgCompatPool` (`src/client.ts:122-132`) + `turbineHttp` (`src/serverless.ts:118`)
  is the injection template, but it is **pg-API-shaped** (`query(text, values) → {rows, rowCount,
  fields}`). PowDB's client is a different shape. Phase-0's generalized **`TurbineDriver`**
  (connect/query/transaction/close + placeholder + capability flags; multi-dialect-plan §1, Phase-0 #2)
  is what PowDB binds to.
- **Result strategy** — the entire write path assumes `RETURNING` (`buildCreate` transform reads
  `result.rows[0]` and throws if missing, `src/query/builder.ts:1263-1273`; update/delete append
  `dialect.buildReturningClause('*')`, `builder.ts:1376,1527`; upsert `builder.ts:1605-1616`).
  Phase-0's **`resultStrategy: 'returning' | 'output' | 'reselect'`** keystone (multi-dialect-plan §4,
  Phase-0 #1) is what PowDB's `reselect` plugs into.
- **Query generation** — `Dialect` (`src/dialect.ts:98-196`) is **SQL-string-shaped** (`buildInsertStatement`
  → `INSERT INTO …`, `buildJsonObject` → `json_build_object(…)`). It cannot express PowQL. PowDB
  needs a **higher abstraction** (§2). `DialectIntrospector` (`dialect.ts:198-207`) is the dormant
  hook for §6.

> **Explicit dependency note:** PowDB support **assumes the multi-dialect Phase-0 driver +
> result-strategy seam is built first.** Phase A below starts only after Phase-0's `TurbineDriver`,
> `resultStrategy`, and capability-flag work land. Attempting PowDB before Phase-0 means
> re-discovering and re-building those seams under PowDB-specific pressure.

---

## 1. Transport — the PowDB driver shim

PowDB has no Postgres wire protocol, so the `pg`-shaped path in `client.ts` does not apply. The shim
implements the Phase-0 **`TurbineDriver`** contract over `@zvndev/powdb-client`.

**Driver contract (target shape, from Phase-0):**

```ts
interface TurbineDriver {
  query(text: string, params?: unknown[]): Promise<TurbineResult>;   // returns {rows, rowCount, fields}
  begin(): Promise<TurbineDriverConnection>;                          // dedicated connection for a tx
  close(): Promise<void>;
  readonly capabilities: CapabilityFlags;                            // see §8
  readonly backend: QueryBackend;                                    // see §2 (PowQL, not SQL)
}
```

**`powdbDriver` implementation notes:**

1. **Connect / pool.** Wrap `new Pool({ host, port, dbName, password, user, tls, max })`
   (`pool.ts:116`). `connOpts` is host/port-based (no connection string) — `turbinePowDB` accepts a
   `PowDBConnOptions` object (or parses a `powdb://host:port/db` URL into it).
2. **`query(powql, params)`** → `pool.withClient(c => c.query(powql, params))` (`index.ts:277`).
   Params pass straight through as `QueryParam[]` (Turbine already collects positional `params[]`);
   the backend's placeholder is `$N`, which PowQL's `QueryWithParams` accepts natively — **one of
   the harder multi-dialect problems (placeholder reuse) does not exist here.**
3. **Result adaptation — the load-bearing shim.** PowDB returns `{ columns: string[], rows:
   string[][] }`. The shim maps this into the pg-compat `{ rows: Record<string,unknown>[], rowCount,
   fields }` that `DeferredQuery.transform` consumes (`builder.ts:307-318`), by:
   - zipping `columns` × each `string[]` row into an object;
   - **coercing every string** using a `TypedSchema` derived from Turbine's `SchemaMetadata` for the
     target table (§7): `int`→number/bigint, `float`→number, `bool`→boolean, `datetime`→`new
     Date(Number(micros / 1000n))`, `uuid`/`str`→string; `bytes`→throw `unsupported`.
   - resolving the **`"null"` bareword** to `null` using the column's known nullability + type
     (Turbine knows both from metadata, eliminating the `typed.ts:54` ambiguity for `str`);
   - mapping `{kind:"ok", affected}` to `{ rows: [], rowCount: Number(affected) }` (drives `reselect`);
     `{kind:"scalar"}`/`{kind:"message"}` to single-row/empty as appropriate.
4. **Transactions.** `begin()` calls `pool.acquire()` to pin **one** `Client`, sends `begin`, and
   returns a connection whose `query` runs on that pinned client; `commit`/`rollback` send the
   keyword then `release` (or `destroy` on error). Mirrors `TransactionClient`'s
   dedicated-connection model (`client.ts:283-391`).
5. **int8/bignum policy.** Reuse the "safe-integer → number, else string/bigint" rule already in
   `client.ts:446-452` and `typed.ts:65-76`, **without** mutating any global parser (PowDB has no
   global type registry to mutate — cleaner than pg).
6. **Error translation (`wrapPowdbError`).** PowDB errors are **not** numeric SQLSTATEs — the client
   throws `PowDBError` with a string `.code ∈ {connect_failed, auth_failed, query_failed, aborted,
   size_exceeded, protocol_error, closed, timeout, type_coercion_failed}` (`clients/ts/src/errors.ts:10-28`)
   plus a server message string. The shim needs a `wrapPowdbError` (parallel to `wrapPgError`,
   `src/errors.ts`) mapping: `connect_failed`/`closed`→`ConnectionError` (E004), `timeout`→`TimeoutError`
   (E002), the `"unique constraint violation"` **message match**→`UniqueConstraintError` (E008),
   `query_failed`/`type_coercion_failed`→`ValidationError` (E003). Note: with no FK/CHECK/deadlock
   surface, E009/E011/E012/E013 have **no PowDB source** — they simply never fire on this backend.

**Packaging.** Ship `turbine-orm/powdb` as a subpath export (mirroring `./serverless`/`./adapters`,
`package.json:6-27`). `@zvndev/powdb-client` is an **optional `peerDependency`**
(`peerDependenciesMeta.optional = true`) — `npm i turbine-orm` pulls nothing extra; only PowDB users
install the client. Root `dependencies` stays exactly `{ pg }` (`package.json:77-80`), preserving the
"one dependency, no WASM engine" promise (`package.json:4`). A `package.json` guard test asserts this.

**Factory:** `turbinePowDB(connOpts: PowDBConnOptions, schema: SchemaMetadata, options?)` →
`TurbineClient` bound to the PowDB driver. Same author-facing template as `turbineHttp`
(`serverless.ts:118-124`).

---

## 2. Query-generation backend — PowQL needs a `QueryBackend` above the SQL `Dialect`

**Decision: build a native `powqlBackend`, a parallel query-gen path above the SQL-only `Dialect` —
do NOT try to express PowQL through the `Dialect` interface, and do NOT route through `client.querySql`
as the strategic path.**

**Why not `Dialect`?** Every `Dialect` member returns **SQL text** (`buildInsertStatement` → `INSERT
INTO …`, `buildJsonObject` → `json_build_object`, `buildUpsertStatement` → `INSERT … ON CONFLICT …`,
`dialect.ts:235-271`). PowQL is a different *language shape*: pipeline-ordered, `type` not `CREATE
TABLE`, `:=` not `=` for assignment, `=` not `==` for comparison, trailing-brace `{ .field }`
projection, lowercase `and`/`or`/`not`/`null`, `upsert T on .k {…}` not `ON CONFLICT`. You cannot
make `buildInsertStatement` emit `insert User { name := $1 }` without redefining what the method
returns. The honest structure is a **second backend target**.

**Why not `client.querySql` (the tempting shortcut)?** It exists and would let Phase A reuse the SQL
`Dialect`. But it is a strategic dead-end: (a) AGENTS.md states the SQL tier is *being removed*;
(b) its subset **rejects `IN` lists/subqueries and `BETWEEN`** (`docs/SQL.md`) — exactly what
Turbine's where-builder emits for `in`/`notIn`; (c) **no `RETURNING`, no upsert** — so it solves
none of C1/C3 anyway. **Verdict:** `querySql` is acceptable only as a throwaway Phase-A spike to
validate the transport, never as the shipped backend. The shipped path is native PowQL.

**Abstraction.** Introduce `QueryBackend` (Phase-0 widens the seam so `Dialect` is one
implementation):

```ts
interface QueryBackend {
  readonly name: string;
  buildSelect(spec): BuiltQuery;            // findMany/findUnique/findFirst
  buildInsert(spec): BuiltQuery;            // create
  buildBulkInsert(spec): BuiltQuery;        // createMany
  buildUpdate(spec): BuiltQuery;            // update/updateMany
  buildDelete(spec): BuiltQuery;            // delete/deleteMany
  buildUpsert(spec): BuiltQuery;            // upsert
  buildAggregate(spec): BuiltQuery;         // aggregate/count
  buildGroupBy(spec): BuiltQuery;           // groupBy + having
  buildDDL(schemaDef): string[];            // defineSchema → type/alter
  readonly resultStrategy: 'returning' | 'output' | 'reselect';
  readonly supportsSingleQueryRelations: boolean;   // false for PowDB → §3
}
```

`postgresBackend` wraps today's `Dialect`. `powqlBackend` is new code. `QueryInterface` selects it the
same way it selects the dialect today (`builder.ts:453`).

**Operation → PowQL mapping (the conformance contract):**

| Turbine op | PowQL emitted | Status |
|---|---|---|
| `findMany` (cols, where, order, limit, offset, distinct) | `T [distinct] filter <e> order <k> limit n offset m { .c, … }` | ✅ direct |
| `findUnique`/`findFirst` | `T filter .pk = $1 limit 1 { … }` | ✅ direct |
| where `=,>,>=,<,<=` | `.col = $1`, `.col > $1`, … (note `=`, never `==`) | ✅ |
| where `not`, `in`, `notIn` | `not (…)`, `.col in ($1,$2)`, `.col not in (…)` | ✅ |
| where `contains/startsWith/endsWith` | `.col like $1` (build `%x%`/`x%`/`%x`, reuse `escapeLike`) | ✅ |
| where `mode:'insensitive'` (ILIKE) | `lower(.col) like lower($1)` (`upper`/`lower` scalars shipped) | ✅ (functional, may not use index) |
| where null checks | `.col is null` / `.col is not null` | ✅ |
| where `OR`/`AND`/`NOT` combinators | `(… and …) or (…)`, lowercase operators | ✅ |
| relation filters `some/every/none` | `exists (Rel filter …)` / `not exists (…)` | ✅ (correlated subqueries shipped) |
| `orderBy` (multi) | `order .a asc, .b desc` | ✅ |
| `limit`/`offset` | `limit n offset m` | ✅ |
| `count` | `count(T filter <e>)` | ✅ (`count(*)` is O(1) off heap header) |
| `aggregate` (`_sum/_avg/_min/_max/_count`) | `T filter <e> { s: sum(.x), a: avg(.y) }` | ✅ — **alias footgun:** aggregate keyword names are illegal aliases (`count:`/`sum:` fail); the backend must emit safe aliases (`n:`, `agg_sum_x:`) and map back (`AGENTS.md:112` footgun row) |
| `groupBy` + `having` | `T group .k having <agg-e> { .k, n: count(.x) }` | ✅ |
| `create` | `insert T { col := $1, … }` → **count only → reselect by PK (§4)** | ⚠️ reselect |
| `createMany` | multi-row `insert T { … }, { … }` → count → reselect by PK-set | ⚠️ reselect |
| `update`/`updateMany` | `T filter <e> update { col := $1 }` (expr updates `col := .col + 1` supported → maps `increment`/`decrement`/`multiply`/`divide`) | ⚠️ reselect for single-row `update()` return |
| `delete`/`deleteMany` | **reselect-then-`delete`** (§4): read pre-image, then `T filter <e> delete` | ⚠️ reselect-before |
| `upsert` | `upsert T on .key { create… } on conflict { update… }` — **key must be `unique`** (validate against metadata) → count → reselect | ⚠️ reselect + unique-key requirement |
| nested `with` | **NOT single-query — N+1 loaders (§3)** | ❌ degraded |
| `findManyStream` (cursors) | no `DECLARE CURSOR` → limit/offset paging or **throw** (§8) | ❌/emulated |
| pgvector / JSON filters / array ops | no types → **throw `unsupported on powdb`** (§8) | ❌ throw |

---

## 3. The crown jewel — nested relations degrade to batched N+1

Turbine's headline is single-query nested `with` via correlated `json_agg(json_build_object(…))`
(`builder.ts:3717-4087`, the "json_agg Algorithm" in CLAUDE.md). **PowDB cannot do this**: there is
no `json` type, no JSON aggregation function, and `User.posts` link navigation is "not yet
implemented" (`AGENTS.md:112,223`). Joins *exist*, but a join cannot fold a to-many child set into a
single parent row as a JSON array, and it multiplies parent rows — so the JSON-tree shape Turbine
returns can't come from one query.

**Fallback design — batched N+1 relation loaders:**

1. **Hook point.** In `buildSelectWithRelations` (`builder.ts:3758`), branch on
   `backend.supportsSingleQueryRelations`. For PowDB it is `false`: emit the **root** PowQL select
   with **no** relation subqueries (base columns only), and attach a `relationPlan` (the parsed
   `with` tree) to the `DeferredQuery`.
2. **Loader pass (runtime, in the executor, not the SQL).** After the root rows return, for each
   relation in the plan, run **one** PowQL query per level using an `in (…)` filter on the collected
   parent keys: e.g. root `User` rows → collect `id`s → `Post filter .user_id in ($1,$2,…) { … }` →
   collect post `id`s → `Comment filter .post_id in (…)`. One query per relation **level** (breadth-
   first), not per row — true N+1-by-level, not N+1-by-row. m2m goes through the junction table the
   same way (two `in` hops via `RelationDef.through`, `schema.ts:95-99`). **Chunk the key set:** PowDB
   bounds a query at `MAX_PARAMS`/`MAX_ROWS` (10M) and one 64 MiB result frame (`protocol.rs:23-36`),
   so a very large parent set must be split into several `in (…)` batches and the results concatenated.
3. **Stitch.** Group children by FK into the parents, exactly mirroring the shape
   `parseNestedRow` produces today (`builder.ts:3654-3715`): hasMany → array (empty `[]` fallback),
   belongsTo/hasOne → object or `null`. Recurse for nested `with` (depth-cap reuse: the depth-10
   `CircularRelationError` still applies). `where`/`orderBy`/`limit`/`select` on a relation are
   pushed into that level's PowQL (`filter`/`order`/`limit`/projection) — `limit` per-parent is the
   one lossy case (PowDB `limit` is global to the query, so per-parent limit needs either a windowed
   query — window functions *are* shipped — or a documented "limit applies across the batch" caveat;
   recommend the `ROW_NUMBER() over partition` rewrite as a Phase-C refinement).
4. **The typed API is preserved.** `WithResult<T,R,W>` and the `RelationDescriptor` inference
   (query/types.ts) are **compile-time only** — they don't care how the data was fetched. The N+1
   loader returns the identical runtime shape, so `users[0].posts[0].comments[0].author.name`
   autocompletes and resolves exactly as on Postgres. **No type changes.**

**Performance caveat (must be documented, prominently).** On PowDB, `with: { posts: { comments:
true } }` is **D round trips** (D = relation depth), not one — and each write path is single-writer
(§0.1). The single-query guarantee is a **Postgres-only** property of Turbine. The `turbine-orm/powdb`
docs page and a runtime note (one-time `console.warn` on first nested read, opt-out) must state:
*"Nested `with` on PowDB uses batched per-level loaders, not single-query `json_agg`. Expect one
round trip per relation level."* Marketing discipline (per `powdb-decision.md`): **no "faster than
Postgres" claims** — Turbine traffic rides PowDB's weakest path (many small round-trip writes).

---

## 4. Result model — `reselect` and the generated-ID problem

**C1 (no `RETURNING`).** Slot PowDB into the Phase-0 keystone as `resultStrategy = 'reselect'`. The
executor branch (Phase-0 #1) does: run the mutation (PowDB returns `{affected}`), then **issue a
follow-up `T filter .pk = $1 { … }`** on the same pinned connection/transaction and feed *those* rows
into `DeferredQuery.transform` — so `create/update/upsert` still return the row, and the existing
transforms (`builder.ts:1263-1273` etc.) are unchanged because they still receive `{rows:[row]}`.

**C2 (no generated/serial/default IDs — and no PK concept at all).** This is the sharp ergonomic edge.
PowDB inserts every column explicitly (`docs/POWQL.md:528`); there is no `SERIAL`, no server-side
`DEFAULT`, **and no `PRIMARY KEY` concept** — rows are located internally by a physical `RowId`
(page+slot, `table.rs`), which is not user-addressable, and the SQL frontend rejects `PRIMARY KEY`
(`sql.rs:581-583`). So Turbine's "primary key" maps to a **`unique`-declared column** on PowDB (the
only thing `reselect` and `upsert` can target). `reselect` needs that key's value at insert time — so
**Turbine must know it before inserting.** Resolution:

- **`defineSchema` declares a client-generated default for the PK** — recommend a `uuid` PK with a
  `@default(uuid())`-style marker. On `create()`, Turbine **generates the UUID in JS** (Node
  `crypto.randomUUID()`) before the `insert`, writes it as an explicit column, then `reselect`s by it.
  This restores ergonomic `db.users.create({ data: { name, email } })` with no app-supplied id.
- **App-supplied PKs** also work (the value is in `data` → reselect by it).
- **`createMany`:** generate UUIDs for each row, insert multi-row, reselect by `pk in (…)` (or, if the
  caller opts out of returning rows, return `{ count }` and skip the reselect — document the choice,
  mirroring the multi-dialect MySQL `createMany` policy).
- **`delete()` returns the deleted row:** PowDB has no `DELETE … RETURNING`, and the row is gone after
  delete — so the backend emits **reselect-then-delete**: `SELECT` the pre-image, then `delete`, both
  inside one transaction so it's atomic. `deleteMany` returns `{ count }` (`affected`).

**Referential integrity is Turbine's job.** PowDB has **no foreign keys, no `CHECK`, no cascade**
(§0.4, `sql.rs:581-583`). Turbine's nested-write engine (`nested-write.ts`: `create`/`connect`/
`disconnect`/`set`/`delete`/`upsert`) already resolves relation fields in `data` into batched writes
inside one transaction — that machinery ports, but on PowDB it is the **only** thing enforcing
relational consistency (the engine won't reject a dangling FK). Document that cascade/`onDelete`
semantics are application-enforced, not database-enforced, on this backend.

**Coercion on readback.** Every reselected value is a string (§0.2) → the §1 shim's
`SchemaMetadata`-driven `TypedSchema` coercion runs. DateTime is micros→`Date`. This is the same code
path as any read.

---

## 5. Transactions / isolation / locking

- **`$transaction(fn)`** → pin a `Client` (`pool.acquire`), `begin`, run `fn` against that client,
  `commit` (or `rollback` on throw), then `release`/`destroy`. Maps cleanly to PowDB's per-connection
  `begin/commit/rollback` (`docs/POWQL.md` Transactions). Implicit rollback on connection close is a
  free safety net. **Global-stall warning:** PowDB gates transactions with a single global semaphore
  permit (`TxGate`, `handler.rs:22-24,504-519`) — an open `begin` on **one** connection **blocks every
  other connection's transactions/writes** until it commits/rolls back/times out. So a Turbine
  connection pool buys read concurrency only, and any long-lived `$transaction` is a process-wide write
  stall. Keep transactions short; document this prominently.
- **Nested `$transaction` (SAVEPOINTs)** → **throw `unsupported on powdb`.** PowDB explicitly errors
  on `begin` inside an open transaction ("Nesting transactions is not supported"). Turbine's
  SAVEPOINT machinery (`client.ts:328-336`) has no PowDB equivalent. (Alternative: silently flatten
  the inner tx into the outer one — *rejected*, because it changes rollback semantics; throw is honest.)
- **Isolation levels** → **ignore-with-warn or throw** on the `isolationLevel` option
  (`client.ts:231,847-850`). PowDB exposes no SQL-standard levels; the global `RwLock` gives
  serialized writes + concurrent reads, closest to "read committed under a single writer." Document it.
- **Locking / migrations.** No `pg_advisory_lock` equivalent. But the single global write lock means
  concurrent migration runners are already serialized at the engine — still, two runners could both
  think they're first. Implement migration locking via a **lock row in a `_turbine_locks` table**
  (insert-with-unique-key as a mutex; PowDB `unique` enforces it) through the `DatabaseAdapter`
  seam (`adapters/index.ts:48-87`), or accept "single-writer + checksum guard is enough" and document.
- **No deadlock detection / lock timeouts / cooperative cancellation yet**
  (`enterprise-readiness-roadmap.md:31`; `README.md:212`, `CHANGELOG.md:54-58`). A write transaction
  can hang under contention, and **`POWDB_QUERY_TIMEOUT` is threshold-reporting only — it does not
  interrupt a running query.** Turbine's `$transaction` timeout can wire the client's `AbortSignal`
  (`index.ts:279`) to stop *waiting* and `destroy` the connection — but understand the limit: the
  **server-side query keeps running to completion and keeps holding its lock/permit**; aborting only
  frees the client. There is no way to cancel server work today (§9 ask #6).
- **`sessionContext` / RLS** → **throw** (no GUCs, no per-row policies; §8).

---

## 6. Introspection + codegen

**C4: no `describe`/`information_schema` wire surface** (`typed.ts:17`), even though the engine's
`Catalog` *has* tables/columns/indexes internally. Two-track plan:

- **Interim & primary: code-first `defineSchema()`.** `schema-builder.ts`/`schema-sql.ts` already
  produce `SchemaDef` → DDL. Add a `powqlBackend.buildDDL` that emits PowQL DDL from a `SchemaDef`:
  `type T { required unique <field>: <powql-type>, … }`, plus `alter T add unique .col` and `alter T
  add column`. Map TS/schema types → PowQL canonical names (§7) and **never emit a non-canonical type
  name** (unknown names silently coerce to `str` — a real footgun, `AGENTS.md` type-system note).
  `defineSchema` also marks the client-generated UUID PK (§4). This is the path users actually use on
  PowDB until the engine ships introspection.
- **When the engine grows a catalog wire surface** (§9 ask #3): implement the dormant
  `DialectIntrospector` (`dialect.ts:198-207`) as `powqlIntrospector`, reading tables/columns/types/
  unique-indexes, producing `SchemaMetadata`. `generate.ts` is largely backend-agnostic (it emits TS
  from metadata) — only `typeToTypeScript` (§7) and the introspector are PowDB-specific, so codegen
  (`types.ts`/`metadata.ts`/`index.ts`) drops in once metadata exists.

---

## 7. Type mapping — PowDB ↔ TypeScript

PowQL has **7 scalar types + null** (`docs/POWQL.md` Type System) — a much narrower surface than
Postgres's `PG_TO_TS` (`schema.ts:122-184`).

| PowQL type | TS type | Read coercion (string → JS) | Notes |
|---|---|---|---|
| `int` (i64) | `number` (\|`string`/`bigint` if > 2^53) | `Number(raw)`; safe-int policy | reuse `client.ts:446` rule |
| `float` (f64) | `number` | `Number(raw)` | |
| `bool` | `boolean` | `"true"`/`"false"` | |
| `str` | `string` | passthrough | `"null"` ambiguity resolved via metadata nullability |
| `datetime` (i64 epoch **micros**) | `Date` | `new Date(Number(micros / 1000n))` | **not ISO** — special-case in shim + `dateColumns` |
| `uuid` | `string` | passthrough (validate canonical) | natural PK type (§4) |
| `bytes` | `Buffer` | **LOSSY wire (`"<N bytes>"`)** → **throw `unsupported`** until binary wire lands | §9 ask #8 |
| null | `T \| null` | bareword `"null"` → `null` | metadata-driven |

**Not present** (vs Postgres): `numeric`/`decimal` (→ no arbitrary-precision; recommend `str` or
`float` with documented caveat), `json`/`jsonb`, arrays, `vector`, network/geometric types. Each maps
to a `defineSchema`/codegen error so a user can't declare an unsupported column on PowDB.

---

## 8. Features that won't port → typed `unsupported on powdb` errors

Add a `CapabilityFlags` set to the backend (Phase-0 #5) and throw a typed error (same shape as the
serverless-HTTP `$listen` error today) from the relevant builders:

| Feature | Turbine source | PowDB | Strategy |
|---|---|---|---|
| pgvector (KNN orderBy, distance WHERE) | `builder.ts:269-273,3580-3599` | none | **throw** |
| LISTEN/NOTIFY (`$listen`/`$notify`) | `client.ts:1000-1038`, `realtime.ts` | only polling `watch()` (`index.ts:419`) | **throw** on `$listen`/`$notify`; offer an optional `db.$watch(powql, {intervalMs})` shim documented as polling |
| RLS / `set_config` / `sessionContext` | `client.ts:859-868` | no GUCs, no per-row perms (planned) | **throw** |
| Streaming cursors (`DECLARE CURSOR`) | `builder.ts:1072-1093` | no server cursors | **throw**, or emulate via `limit`/`offset` paging (Phase C) |
| Wire pipelining (`pipeline()`) | `pipeline-submittable.ts` | request/response only (`…strategy.md:30`) | **degrade** to sequential (existing HTTP fallback path) |
| Nested tx / savepoints | `client.ts:328-336` | unsupported (`begin`-in-`begin` errors) | **throw** (§5) |
| Isolation levels | `client.ts:259-264` | none | **ignore-with-warn or throw** (§5) |
| Advisory-lock migration locking | `adapters/index.ts:100-114` | none | lock-row table or rely on single-writer (§5) |
| JSON filters / array ops / `numeric` / arrays | `builder.ts` JSON & array paths | no such types | **throw** at build + reject in `defineSchema` |

**Guiding rule (inherited from the multi-dialect plan):** prefer *throw-with-clear-message* over
silent degradation for anything with no equivalent, so users are never surprised.

---

## 9. Engine-side ask-list — what unlocks parity

Cross-checked against PowDB's shipped-vs-planned matrix (`AGENTS.md:219-223`). **Already shipped (boxes
ticked):** `$N` param binding ✅, `unique` indexes ✅, multi-row insert ✅, `upsert` ✅, explicit
transactions ✅, prepared queries ✅. **Still needed for Turbine parity, in priority order:**

1. **`RETURNING` (or "insert/update returns the row").** Removes the `reselect` round trip (§4) — the
   single biggest perf + simplicity win. *Highest leverage.*
2. **Generated/serial IDs + server-side `DEFAULT` expressions.** Removes the client-UUID requirement
   (C2/§4); lets `create()` omit the PK like every other ORM.
3. **A nested-read / JSON-aggregation primitive — or `User.posts` link navigation** (already *planned*,
   `AGENTS.md:223`). Either a `json_agg`/`json_object` equivalent **or** link navigation that lets one
   query return a parent with its child set. **This is the one that restores the crown jewel** — until
   it lands, nested `with` is N+1 (§3).
4. **A `describe` / catalog wire surface** (tables, columns, types, indexes, **unique** flags). The
   Catalog already holds this engine-side — exposing it enables `DialectIntrospector` → codegen (§6)
   and lossless typed coercion driven by the server rather than `defineSchema`.
5. **Per-connection isolation levels + savepoints (nested tx).** Restores `$transaction` nesting and
   the `isolationLevel` option (§5).
6. **Deadlock detection + lock timeouts** (already P1 roadmap, `enterprise-readiness-roadmap.md:31`).
   Makes concurrent writers safe instead of hang-prone.
7. **Protocol pipelining/batching.** Restores `pipeline()` 1-RTT batching instead of sequential (§8).
8. **Typed/binary result wire** (esp. **non-lossy `bytes`**, native `datetime`, explicit NULL vs
   `"null"`). Removes the string-coercion guesswork and the `bytes` block (§7).

Until #1–#3 land, Turbine-on-PowDB is honestly a **thinner Turbine**: correct, typed, parameterized,
and ergonomic, but with extra write round trips and N+1 nested reads. The plan ships that thinner
product deliberately and upgrades it as the engine closes the gaps.

---

## Phased Plan

### Phase A — Driver shim + `defineSchema` + basic CRUD via `reselect`

**Depends on:** multi-dialect **Phase-0** (`TurbineDriver`, `resultStrategy`, capability flags,
`QueryBackend` widening). Do not start before Phase-0 lands.

**Scope:**
- `powdbDriver` shim over `@zvndev/powdb-client` `Pool` (§1): connect, `query`, transaction-pin,
  close, **string→JS coercion** via `SchemaMetadata`-driven `TypedSchema`, `{affected}`→`rowCount`.
- `powqlBackend` skeleton (§2): `buildSelect` (no relations yet — flat findMany/findUnique with
  where/order/limit/offset/distinct), `buildInsert`/`buildUpdate`/`buildDelete`/`buildUpsert` with
  `resultStrategy='reselect'` (§4), `buildDDL` for `defineSchema`.
- Client-generated UUID PK default in `defineSchema` (§4, C2).
- `turbinePowDB(connOpts, schema)` factory + `turbine-orm/powdb` subpath + optional peer dep.
- Capability flags wired so unsupported surfaces (§8) throw.

**Degrades/throws:** nested `with` not yet wired (Phase B); vector/LISTEN/RLS/cursors/nested-tx throw.
**Test strategy:** spawn `powdb-server` in CI exactly like the client's own harness
(`clients/ts/test/run-with-server.ts` `spawn(… "powdb-server")`) — build from source (`cargo build -p
powdb-server`) or use the repo's `Dockerfile`/`docker-compose.yml` as a service container; gate via
the existing `skipGate()` helper (`src/test/helpers.ts`) when no PowDB is present (mirrors the parked-
YugabyteDB nightly pattern in this repo's CI). Port a small fixture to `defineSchema` + PowQL DDL.
**Rough size:** **3–5 engineer-weeks** (the coercion shim + `reselect` wiring are the bulk).
**Exit criteria:** `create/createMany/update/delete/upsert/findUnique/findFirst/findMany(flat)` green
against a live `powdb-server`; rows returned correctly typed (incl. `datetime` micros→`Date`); UUID
PKs auto-generated; root `dependencies` still `{ pg }` (guard test).

### Phase B — Full where/orderBy/aggregate + N+1 nested relations + introspection

**Scope:**
- Complete `where` surface in `powqlBackend` (§2): operators, `in/notIn`, `like` (contains/startsWith/
  endsWith via `escapeLike`), insensitive `lower() like`, `is null`, OR/AND/NOT, relation filters via
  `exists`/`not exists`.
- `aggregate`/`count`/`groupBy`+`having` with the **alias-footgun** workaround (safe aliases mapped
  back, §2).
- **N+1 batched relation loaders** (§3): branch `buildSelectWithRelations` on
  `supportsSingleQueryRelations=false`; per-level `in (…)` loaders; stitch into the `parseNestedRow`
  shape; nested `with`, `where`/`order`/`limit`/`select` per relation; depth-cap reuse; the prominent
  perf-caveat warn + docs.
- `DialectIntrospector` (`powqlIntrospector`) **iff** the engine has a catalog surface (§9 #4);
  otherwise document `defineSchema` as the supported codegen path and ship the introspector behind a
  feature check.
**Degrades/throws:** per-parent relation `limit` may apply across the batch (documented) pending the
window-function rewrite in Phase C.
**Test strategy:** full integration suite against `powdb-server` incl. deep `with` trees, parity test
asserting the **parsed nested tree equals the Postgres fixture's tree** for the same data.
**Rough size:** **4–6 engineer-weeks** (N+1 loaders + the where/aggregate surface).
**Exit criteria:** `users[0].posts[0].comments[0].author.name` resolves at runtime and typechecks;
aggregate/groupBy/having green; where surface at parity with Postgres (minus JSON/array/vector);
codegen round-trips a `defineSchema`-described PowDB schema.

### Phase C — Parity hardening + the engine-side ask-list

**Scope:**
- Per-parent relation `limit` via `ROW_NUMBER() over partition` (window functions are shipped).
- Cursor-stream emulation via `limit`/`offset` paging (or keep throwing — decide on demand).
- Migration locking hardening (lock-row table) + write-timeout via `AbortSignal`.
- `db.$watch` polling shim (documented non-LISTEN realtime).
- **Adopt engine features as they ship** (§9): switch `reselect`→`returning` when `RETURNING` lands;
  drop client-UUID when generated IDs land; switch N+1→single-query when the JSON/link-nav primitive
  lands; wire the real introspector when the catalog surface lands.
**Degrades/throws:** whatever the engine still lacks stays a typed `unsupported on powdb` error.
**Test strategy:** feature-flag matrix keyed to the connected `serverVersion` (`index.ts:165`) so the
suite exercises the best available path per server version.
**Rough size:** **2–3 engineer-weeks** of Turbine work (the rest is gated on PowDB shipping §9).
**Exit criteria:** documented capability matrix; graceful auto-upgrade as PowDB versions advance; no
silent feature gaps.

**Total Turbine-side sizing:** **~9–14 engineer-weeks** on top of Phase-0 for a credible
CRUD + relations MVP; full parity is **gated on PowDB engine work** (§9), not on Turbine effort.

---

## Risk Register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | No `RETURNING` makes every write 2 round trips (`reselect`), and `delete` needs reselect-before — perf + atomicity surprises | High | High | `reselect` inside one tx; document; push §9 #1; switch to `returning` when it ships |
| R2 | No generated IDs forces client UUIDs; users expect serial ints | High | Medium | `defineSchema` UUID-default as the idiom; clear docs; accept app-supplied PKs; push §9 #2 |
| R3 | Nested `with` is N+1, not single-query — the headline feature is absent on PowDB | High | High | Honest docs + first-read warn; per-level (not per-row) batching; push §9 #3; never claim "faster than Postgres" |
| R4 | String-only result wire → coercion bugs (datetime micros, `"null"` ambiguity, lossy `bytes`) | Medium | High | `SchemaMetadata`-driven `TypedSchema`; metadata-resolved NULL; **throw** on `bytes`; parity tests vs PG fixture |
| R5 | Pre-1.0 PowDB: on-disk format may change; no deadlock detection; single-writer | Medium | Medium | Document pre-1.0 status; client-side write timeout via `AbortSignal`; pin a min `serverVersion` |
| R6 | Targeting `querySql` as a shortcut bets on a tier PowDB is removing and still misses `IN`/subquery/`BETWEEN`/upsert/RETURNING | Medium | High | Use `querySql` only as a throwaway spike; ship native PowQL backend |
| R7 | Adding the client to root deps breaks the "one dependency" promise | Low | High | Optional peer dep + subpath + `package.json` guard test asserting `dependencies == {pg}` |
| R8 | `QueryBackend` widening leaks PowQL assumptions into the SQL `Dialect` path or vice-versa | Medium | Medium | Keep `postgresBackend` a thin wrapper over today's `Dialect`; conformance suite runs both backends |
| R9 | PowDB `upsert` requires a `unique` conflict key; Turbine derives it from `where` keys | Medium | Medium | Validate the conflict key is `unique` in metadata at build time; clear error otherwise |
| R10 | CI cost/flakiness of spawning `powdb-server` (build-from-source) | Medium | Low | Prebuilt binary or `Dockerfile` service container; nightly matrix like parked-YugabyteDB; `skipGate()` locally |

---

## Explicit dependency note

**PowDB support is built on top of, and must not start before, the multi-dialect Phase-0 seam**
(`docs/strategy/multi-dialect-plan.md`, "Phase 0"). Specifically it consumes:
(1) the generalized **`TurbineDriver`** (so `client.ts`'s `pg.Pool` coupling and the
`BEGIN/COMMIT/ROLLBACK` keywords route through a driver, not `pg`);
(2) the **`resultStrategy: 'returning' | 'output' | 'reselect'`** keystone (PowDB is the first real
`reselect` consumer);
(3) **capability flags + typed `unsupported` guards**; and
(4) the **`QueryBackend` widening** of the query-gen seam so PowQL can live above the SQL-only
`Dialect`. Phase-0 was scoped for MySQL/SQLite/MSSQL, but items (1)–(3) are backend-agnostic and (4)
is a natural generalization. Landing Phase-0 first means PowDB is a *fourth backend on a proven seam*
rather than a from-scratch second product.
