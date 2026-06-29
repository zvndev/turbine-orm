# Turbine ↔ PowDB Feature Parity Matrix

**Grounded firsthand** against a live `powdb-server` **v0.7.0** (built from source 2026-06-28) via
`@zvndev/powdb-client` **and** the in-process `@zvndev/powdb-embedded` addon. The rows below were
established by running the actual PowQL against a real engine — not inferred from docs. The embedded
transport additionally has automated regression coverage in CI (`src/test/powdb.integration.test.ts`,
the `powdb-integration` job); the networked transport has no CI service container (exercised by the
embedded suite + by hand).

**v0.7.0 update (2026-06-28):** PowDB now supports a trailing `returning` keyword (`RETURNING *`) and
has fixed int→float coercion on every write path. Turbine's two ≤0.6.2 workarounds are retired:
`create`/`createMany`/`update`/`delete` now use `returning` instead of a follow-up reselect, and the
float-literal inlining hack in `writeRef` is gone (float columns are plain `$N` params again). `upsert`
is the lone write that still reselects — its statement rejects `returning`. A new **embedded** transport
(`turbinePowDB({ embedded: <dir> })`) runs the engine in-process; min supported version is **^0.7.1**.

**v0.7.1 update (2026-06-29):** the embedded addon now exposes durability + memory selection from JS, so
`turbinePowDB({ embedded, syncMode: 'normal' })` moves fsync off the commit path — embedded writes drop
from ~4 ms (Full) to ~0.008 ms and **beat SQLite** (see `benchmarks/CROSS-ENGINE-RESULTS.md`). Also picks
up upstream fixes: `open()` no longer aborts the host on a corrupt dir, a PID-based data-dir lock, and the
SQL-frontend `count(*)` fix (Turbine was unaffected — it emits PowDB's native `count(<Table>)`, not SQL
`count(*)`).

This matrix supersedes the capability assumptions in `powdb-support-plan.md` where firsthand testing
contradicted them (noted inline). It is the implementation spec for `turbine-orm/powdb`.

---

## 0. The decisive firsthand findings (these reshape the design)

1. **`uuid`, `datetime`, and `bytes` columns cannot hold client-supplied values.** PowDB has no
   literal syntax for them and `cast($1, "uuid")` / `cast($1, "datetime")` return
   `invalid cast type`. A string param into a `uuid` column fails with
   `type mismatch: expected Uuid, got str`. → **Turbine never emits PowDB `uuid`/`datetime`/`bytes`
   columns.** It maps everything onto the four *writable* scalar types: `str`, `int`, `float`, `bool`.
   - Turbine PK / UUID → PowDB **`str`** (holds a client-generated `crypto.randomUUID()` string).
   - Turbine `Date` → PowDB **`int`** (epoch **micros**), coerced both ways by Turbine.
   - Turbine `Buffer`/bytes → **rejected** at `defineSchema` (no writable binary type).
   - This *retires* the plan's "uuid PK bound via `$N`" idea (C2), which is impossible on the wire.

2. **All result values are strings** (`{kind:"rows", columns, rows: string[][]}`); NULL is the
   bareword `"null"`. A write **with** trailing `returning` returns `{kind:"rows"}` (columns = full
   table schema order, `RETURNING *` only — `returning .col` is a parse error); **without** it,
   `{kind:"ok", affected:bigint}`. _(0.7.0; ≤0.6.2 had no `RETURNING` at all → reselect.)_

3. **Bare aggregate projection is broken**: `T { n: count(.id) }` returns one *null* row per table row,
   not one aggregate row. → global aggregates MUST use the scalar form `count(T …)` / `sum(T { .col })`.

4. **Aggregate aliases can't be SQL keywords**: `T { count: count(.id) }` → `expected '(', got ':'`.
   → emit safe aliases (`agg_0`, `agg_count_id`) and map back.

5. **Correlated `exists` does not correlate** reliably; relation filters use the **IN-subquery** form
   `Outer filter .pk in (Related { .fk })` (verified: returns exactly the matching parents).

---

## 1. Type mapping (`defineSchema` → PowQL DDL)

| Turbine field type | PowDB column | Read coercion (string → JS) | Verified |
|---|---|---|:--:|
| `string` (incl. PK / UUID) | `str` | passthrough; `"null"`→null if nullable | ✅ |
| `number` (integer) | `int` | `Number`; >2⁵³ → string (int8 policy) | ✅ |
| `number` (float) | `float` | `Number` | ✅ |
| `bigint` | `int` (i64) | `BigInt`/`Number` per safe-int | ✅ |
| `boolean` | `bool` | `"true"`/`"false"` | ✅ |
| `Date` | `int` (epoch micros) | `new Date(Number(micros)/1000)` | ✅ |
| `Buffer` / bytes | — | **reject in `defineSchema`** | n/a |
| `uuid`/`datetime` native | — | **never emitted** (unwritable on wire) | ✅ |

PK is declared `required unique <pk>: str` and gets a client-generated UUID default.

---

## 2. Query operations

| Turbine op | PowQL emitted | Status |
|---|---|:--:|
| `findMany` (where/order/limit/offset/distinct/select) | `T [distinct] filter <e> order <k> limit n offset m { .c, … }` | ✅ works |
| `findUnique` / `findFirst` / `*OrThrow` | `T filter <e> limit 1 { … }` | ✅ works |
| `create` | `insert T { c := $n, … } returning` → row (one round-trip) | ✅ via `returning` |
| `createMany` | `insert T { … }, { … } returning` → real rows | ✅ via `returning` |
| `update` (single, returns row) | `T filter <e> update { c := $n } returning` → post-update row | ✅ via `returning` |
| `updateMany` | `T filter <e> update { c := $n }` → `{affected}` | ✅ (count path, no `returning`) |
| `delete` (returns row) | `T filter <e> delete returning` → deleted row | ✅ via `returning` |
| `deleteMany` | `T filter <e> delete` → `{affected}` | ✅ (count path, no `returning`) |
| `upsert` | `upsert T on .pk { create… } on conflict { update… }` → **reselect by PK** | ✅ (upsert rejects `returning`) |
| atomic update ops (`increment`/`decrement`/`multiply`/`divide`/`set`) | `c := .c + $n` / `- * /` / `:= $n` | ✅ (`:= .age + $2` verified) |
| `count` | `count(T filter <e>)` → scalar | ✅ |
| `aggregate` (`_sum`/`_avg`/`_min`/`_max`/`_count`) | one scalar query per agg: `sum(T filter <e> { .col })`, … | ✅ (NOT bare projection) |
| `groupBy` + `having` | `T group .k having <e> { .k, agg_0: count(.x) }` (safe aliases) | ✅ |

### where operators

| Operator | PowQL | Status |
|---|---|:--:|
| eq / null-eq | `.c = $n` / `.c is null` | ✅ |
| `gt/gte/lt/lte` | `.c > $n` etc. | ✅ |
| `not` | `not (…)` | ✅ |
| `in` / `notIn` | `.c in ($1,$2,…)` / `.c not in (…)` | ✅ |
| `contains`/`startsWith`/`endsWith` | `.c like $n` (`%x%`/`x%`/`%x`, `escapeLike`) | ✅ |
| `mode:'insensitive'` (ILIKE) | `lower(.c) like lower($n)` | ✅ (may not use index) |
| null checks | `.c is null` / `.c is not null` | ✅ |
| `OR`/`AND`/`NOT` combinators | lowercase `and`/`or`/`not`, parens | ✅ |
| relation filter `some` | `Outer filter .pk in (Rel filter <e> { .fk })` | ✅ (IN-subquery, not `exists`) |
| relation filter `none` | `Outer filter .pk not in (Rel filter <e> { .fk })` | ✅ |
| relation filter `every` | `.pk not in (Rel filter not(<e>) { .fk })` | ⚠ derived form (Phase B) |

---

## 3. Nested relations (`with`) — the crown jewel **degrades**

PowDB has no `json` type and no link navigation, so single-query `json_agg` nested `with` is
impossible. **Fallback: batched N+1 per-level loaders** (verified the core mechanic —
`Rel filter .fk in ($1,$2,…) { … }` works):

- Root select returns base rows; collect parent keys; one `in (…)` query **per relation level**
  (breadth-first, N+1-by-level not by-row); stitch into the exact `parseNestedRow` shape (hasMany→array,
  belongsTo/hasOne→object|null); m2m hops through the junction. Large key sets are chunked into batches
  of `MAX_RELATION_KEYS = 1000` (one loader query per chunk, merged before grouping) so a single `in (…)`
  never exceeds PowDB's per-statement param / row limits.
- The typed `WithResult` inference is compile-time only → **no type changes**;
  `users[0].posts[0].comments[0].author.name` resolves identically.
- **Documented caveat:** D round-trips for depth D, not one. The single-query guarantee is Postgres-only.
- Per-parent relation `limit` via `ROW_NUMBER() OVER (PARTITION …)` (window fns shipped) — Phase B/C.

---

## 4. Features that **throw** `UnsupportedFeatureError` (E017) — "don't make sense on PowDB"

| Feature | Why | Behavior |
|---|---|---|
| pgvector (KNN / distance) | no vector type | **throw** |
| `$listen` / `$notify` (LISTEN/NOTIFY) | no server push | **throw** |
| RLS `sessionContext` / `$withSession` | no GUCs, no per-row policy | **throw** |
| nested `tx.$transaction` (savepoints) | no savepoints | **throw** E017 (`powdbDialect` savepoint keywords throw) |
| re-entrant / concurrent `db.$transaction` | single global write lock | **throw** E017 (pool begin-while-active guard — prevents the networked hang) |
| isolation levels | single `RwLock`, no SQL levels | **ignore-with-warn** |
| JSON filters / path ops | no `json` type | **throw** (+ reject in `defineSchema`) |
| array operators (`hasSome`/`has`/…) | no array type | **throw** (+ reject) |
| `bytes` columns | unwritable on wire | **reject in `defineSchema`** |
| `pipeline()` 1-RTT batching | request/response only | **degrade** to sequential |
| cursor streaming (`findManyStream`) | no server cursor | **emulate** via limit/offset paging, or throw |
| advisory-lock migration locking | none | lock-row table, or rely on single-writer |
| FK / CHECK / cascade enforcement | none in engine | **application-enforced** (nested-write engine); documented |

---

## 5. Transactions / concurrency

PowDB has **one global write lock** and supports neither concurrent nor nested transactions. Turbine
enforces that single-writer model at the client layer so a second transaction fails fast with a typed
error instead of hanging or leaking raw engine text:

- `$transaction(fn)` → pin a pooled client, `begin`/`commit`/`rollback`. **Verified live (both transports).**
- **Nested `tx.$transaction`** → `UnsupportedFeatureError` (E017). PowDB has no savepoints, so
  `powdbDialect.savepointStatement`/`releaseSavepointStatement`/`rollbackToSavepointStatement` throw. The
  override runs synchronously (before any query), so the nested call fails fast with no partial DB state.
- **Re-entrant / concurrent `db.$transaction`** (a fresh top-level transaction opened while another is
  open) → `UnsupportedFeatureError` (E017). Both `PowdbPool` and `PowdbEmbeddedPool` track a pool-level
  `activeTransaction` flag and reject a `begin` while a transaction is already open. On the **networked**
  transport this is critical: without the guard the second `begin` checks out a second pooled connection
  and blocks **forever** on the write lock the open transaction holds — the `await` never resolves. The
  guard converts that hang into a prompt typed error (verified live: returns in ~20 ms, no hang). The flag
  is also cleared on connection release so a tx torn down by a timeout never wedges the pool.
- **Embedded transactions:** one handle = one connection. No query may overlap an open transaction
  (single handle); nested/concurrent transactions throw (as above).
- Isolation levels, optimistic locking, MVCC → ignore-with-warn / no engine support.
- Write timeout: client `AbortSignal` frees the *client*; server query keeps running (no cancellation yet).

---

## 6. Error mapping (`wrapPowdbError`)

The two transports surface errors differently and `wrapPowdbError` handles both:

- **Networked** (`@zvndev/powdb-client`) carries a *semantic* string `.code` (not a SQLSTATE).
- **Embedded** (`@zvndev/powdb-embedded` napi addon) tags **every** error `code:'GenericFailure'`, so the
  class can only be recovered from the message text. `wrapPowdbError` therefore runs message-shape checks
  first (they fire on both transports), then falls through to the networked `.code` switch.

| PowDB signal | Turbine |
|---|---|
| `connect_failed` / `closed` (code) | `ConnectionError` (E004) |
| `timeout` / `aborted` (code) | `TimeoutError` (E002) |
| message `unique constraint violation on …` | `UniqueConstraintError` (E008) |
| message `required` / `not null` / `no value` (`column 'x' is required …`) | `NotNullViolationError` (E010) |
| message `type mismatch` / `Parse(…)` / `Execution(…)` / `StorageError(…)` / `row too large` | `ValidationError` (E003) |
| `query_failed` / `type_coercion_failed` (code) | `ValidationError` (E003) |
| (no FK/CHECK/deadlock surface) | E009/E011/E012/E013 never fire |

The original error is preserved as `.cause` on every wrapped class.

---

## 7. Introspection / codegen

- No wire introspection (`.tables`/`.schema` are CLI-embedded only). → **code-first `defineSchema` is the
  only path.** `defineSchema` emits PowQL DDL (`type T { required unique pk: str, … }`,
  `alter T add unique .col`) and marks the client-UUID PK.
- `DialectIntrospector` (`powqlIntrospector`) ships only when the engine exposes a catalog wire surface.

---

## 8. Phasing (Turbine-side)

- **Phase A** — driver shim + coercion + `defineSchema`/DDL + flat CRUD (create/createMany/update/
  delete/upsert/findUnique/findFirst/findMany-flat); UUID-str PK; capability throws; `turbinePowDB()` +
  `turbine-orm/powdb` subpath + optional peer dep + root-deps guard. **Tested live.**
- **Phase B** — full where surface + relation filters (IN-subquery) + aggregate/groupBy (safe aliases) +
  **N+1 nested `with`** loaders + per-parent limit; introspector iff catalog surface lands.
- **Phase C (0.7.0 — done for writes)** — auto-upgrade as PowDB ships RETURNING / fixed int→float:
  reselect→`returning` for create/createMany/update/delete (upsert excepted), float-literal workaround
  dropped. Embedded transport added. Still pending: generated server IDs (drop client-UUID),
  JSON-agg/link-nav (N+1→single-query), wire introspection.

**Honest positioning:** Turbine-on-PowDB is a *thinner Turbine* — correct, typed, parameterized,
ergonomic. Writes are now single-round-trip via `returning` (upsert still reselects), but nested `with`
is still N+1 until the engine ships JSON-agg / link navigation. No "faster than Postgres" claims.

### Embedded transport (`turbinePowDB({ embedded: <dir> })`)

- In-process via the `@zvndev/powdb-embedded` napi addon (optional peer; dynamic `import()`). No server,
  no socket. `Database.open(dir)` once; one handle = one connection (tx keywords run serially on it).
- **The addon takes NO params array** (`query(powql)` is string-only). `PowdbEmbeddedPool` materializes
  each positional `$N` into a PowQL literal via the `encodePowqlLiteral`/`materializePowql` pair —
  string escaping matches the engine lexer exactly (`\"` `\\` `\n` `\t`; everything else raw), so it is
  injection-safe (verified: quotes, backslashes, `$N`, `"); drop … --`, raw CR, emoji round-trip as data).
- **Durability:** selectable via `turbinePowDB({ embedded, syncMode })` (addon ≥ 0.7.1): `'full'`
  (default, fsync per commit), `'normal'` (fsync off the commit path — ~15–40× faster writes, bounded
  loss ≤ one fsync interval on OS-crash/power-loss; a *process* crash still loses nothing via WAL replay),
  `'off'` (bench-only). Also `memoryLimit` (bytes). Used against an addon < 0.7.1 these throw a clear
  `ConnectionError`. `disconnect()` is still checkpoint-bound (no explicit close) — a process that writes
  then exits *immediately* may lose the last unsynced write; hold the process open for the final flush or
  rely on WAL replay on reopen.
- **Per-row size cap:** the embedded engine caps a single row at ~4070 bytes (a write past it surfaces as
  `StorageError("row too large …")` → `ValidationError` E003).
- **Platform:** prebuilt binaries for macOS arm64/x64 and Linux glibc x64/arm64. Intel-mac/musl/Windows
  build from source (`npm run build` in the addon) — a clear `ConnectionError` explains the gap on a
  failed load. The embedded peer is pinned `^0.7.1` at install; there is no embedded version method, so
  the **≥ 0.7.1 requirement is enforced at install time** (the networked transport additionally probes
  `serverVersion` at connect and throws a clear `ConnectionError` below 0.7.0). musl/Alpine + a reliable
  Intel-mac prebuilt are slated for PowDB 0.7.2 (upstream).

### Other documented caveats

- **`divide: 0`** in an atomic update sets the column to **null** (PowDB's behavior — no divide-by-zero
  error is raised).
- **`int8` columns surface as JS `number`** and lose precision past 2⁵³. For keys/ids larger than 2⁵³,
  declare the column `bigint` (read back via `BigInt`) rather than `number`.

---

## 9. Implementation status (built & verified — 2026-06-28, v0.7.0 adoption)

`src/powdb.ts` (driver shim, type mapping, DDL, error mapping, `powdbDialect`, `turbinePowDB`,
embedded pool + literal encoder) + `src/powql.ts` (`PowqlInterface` PowQL generator) are **shipped**.
Wired through the `queryInterfaceFactory` option on `QueryInterfaceOptions` (`builder.ts`) which
`TurbineClient.table()` consults (`client.ts`); the four SQL engines are byte-identical.
`./powdb` subpath export + optional peer deps (`@zvndev/powdb-client` **and** `@zvndev/powdb-embedded`,
both `^0.7.0`) added; root deps stay `{ pg, @types/pg }`.

**Automated coverage:** the embedded transport now has a live integration suite,
`src/test/powdb.integration.test.ts`, that runs the **real** `@zvndev/powdb-embedded` addon in-process
(gated to skip cleanly where no prebuilt binary loads). It is wired into CI as the `powdb-integration`
job (in-process, **no service container**) and covers RETURNING column-order round-trip, error-class
mapping (unique / not-null / type-mismatch / parse → typed), the empty-where guard, transactions
(commit/rollback + nested/re-entrant throw), chunked relation loads, and the E017 guards. The build-only
unit suite (`src/test/powdb.test.ts`) locks PowQL generation, the literal encoder (adversarial cases),
embedded param-materialization, the single-writer transaction guard, error mapping, and the
connection-string / version guard with no engine needed. (The **networked** transport has no CI service
container — it is exercised by the embedded suite and by hand against a local `powdb-server`.)

**Manually verified against `powdb-server` v0.7.0 AND `@zvndev/powdb-embedded` v0.7.0 — full CRUD passes
on both transports:** create (client-UUID + type coercion + `returning`), createMany (multi-row
`returning` → real rows), update (atomic increment + `returning`), upsert (insert+update branches,
reselect-by-PK), delete (`returning` deleted row); plus a **float column round-trips a plain INTEGER
value with no workaround**, an **adversarial string `a"b\c` round-trips as data**, the **networked
re-entrant transaction throws in ~20 ms (no hang)**, and a **> 1000-parent relation loads fully across
chunked `in (…)` queries**.

**v0.7.0 engine facts adopted (both retired Turbine's ≤0.6.2 workarounds):**
1. **`returning` keyword** (`RETURNING *`, all columns, schema order; `returning .col` is a parse error;
   `upsert … returning` is also a parse error). → create/createMany/update/delete use it; upsert reselects.
2. **int→float coercion fixed** on every write path (literal, expression, upsert). → the float-literal
   inlining hack in `writeRef` is removed; float columns are plain `$N` params again. (The embedded
   encoder still emits a float-form literal for a `PowdbFloatParam` so an integer-valued float stays
   unambiguous.)

**Still Phase B/C:** manyToMany `with` + relation filters, composite-key relations, per-parent relation
`limit`, nested writes (create/connect/…), `aggregate`/`groupBy` ordering edge cases, cursor streaming,
nested transactions/isolation, introspection (no catalog wire surface yet), and the auto-upgrade path
(reselect→returning, drop client-UUID, N+1→single-query) as PowDB closes those gaps.
