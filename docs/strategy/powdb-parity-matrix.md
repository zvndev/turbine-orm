# Turbine ↔ PowDB Feature Parity Matrix

**Grounded firsthand** against a live `powdb-server` **v0.7.0** (built from source 2026-06-28) via
`@zvndev/powdb-client` **and** the in-process `@zvndev/powdb-embedded` addon. Every row below was
verified by running the actual PowQL against a real engine — not inferred from docs.

**v0.7.0 update (2026-06-28):** PowDB now supports a trailing `returning` keyword (`RETURNING *`) and
has fixed int→float coercion on every write path. Turbine's two ≤0.6.2 workarounds are retired:
`create`/`createMany`/`update`/`delete` now use `returning` instead of a follow-up reselect, and the
float-literal inlining hack in `writeRef` is gone (float columns are plain `$N` params again). `upsert`
is the lone write that still reselects — its statement rejects `returning`. A new **embedded** transport
(`turbinePowDB({ embedded: <dir> })`) runs the engine in-process; min supported version is **^0.7.0**.

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
| `between` (range) | `.c between $1 and $2` | ✅ (native PowQL only) |

---

## 3. Nested relations (`with`) — the crown jewel **degrades**

PowDB has no `json` type and no link navigation, so single-query `json_agg` nested `with` is
impossible. **Fallback: batched N+1 per-level loaders** (verified the core mechanic —
`Rel filter .fk in ($1,$2,…) { … }` works):

- Root select returns base rows; collect parent keys; one `in (…)` query **per relation level**
  (breadth-first, N+1-by-level not by-row); stitch into the exact `parseNestedRow` shape (hasMany→array,
  belongsTo/hasOne→object|null); m2m hops through the junction. Chunk large key sets (`MAX_PARAMS`=4096).
- The typed `WithResult` inference is compile-time only → **no type changes**;
  `users[0].posts[0].comments[0].author.name` resolves identically.
- **Documented caveat:** D round-trips for depth D, not one. The single-query guarantee is Postgres-only.
- Per-parent relation `limit` via `ROW_NUMBER() OVER (PARTITION …)` (window fns shipped) — Phase B/C.

---

## 4. Features that **throw** `UnsupportedFeatureError` (E017) — "don't make sense on PowDB"

| Feature | Why | Behavior |
|---|---|---|
| pgvector (KNN / distance) | no vector type | **throw** |
| `$listen` / `$notify` (LISTEN/NOTIFY) | only client-side polling `watch()` | **throw**; offer documented `$watch(powql,{intervalMs})` polling shim |
| RLS `sessionContext` / `$withSession` | no GUCs, no per-row policy | **throw** |
| nested `$transaction` (savepoints) | engine errors on nested `begin` | **throw** |
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

- `$transaction(fn)` → pin a pooled client, `begin`/`commit`/`rollback`. **Verified.**
- **Global write stall:** an open `begin` on one connection blocks all other writers (single global
  permit) — keep transactions short; documented prominently.
- Nested tx, isolation levels, optimistic locking, MVCC → throw / ignore-with-warn (no engine support).
- Write timeout: client `AbortSignal` frees the *client*; server query keeps running (no cancellation yet).

---

## 6. Error mapping (`wrapPowdbError`)

PowDB errors carry a string `.code`, not a SQLSTATE. Map:

| PowDB | Turbine | 
|---|---|
| `connect_failed` / `closed` | `ConnectionError` (E004) |
| `timeout` | `TimeoutError` (E002) |
| message `unique constraint violation on …` | `UniqueConstraintError` (E008) |
| `query_failed` / `type_coercion_failed` | `ValidationError` (E003) |
| (no FK/CHECK/deadlock surface) | E009/E011/E012/E013 never fire |

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
- **Durability:** Full only, checkpoint-bound (no explicit close — `disconnect()` drops the handle;
  hold the process open for the final WAL flush in short scripts).
- **Platform:** prebuilt binaries for macOS arm64/x64 and Linux glibc x64/arm64. Intel-mac/musl/Windows
  build from source (`npm run build` in the addon) — a clear `ConnectionError` explains the gap on a
  failed load.

---

## 9. Implementation status (built & verified — 2026-06-28, v0.7.0 adoption)

`src/powdb.ts` (driver shim, type mapping, DDL, error mapping, `powdbDialect`, `turbinePowDB`,
embedded pool + literal encoder) + `src/powql.ts` (`PowqlInterface` PowQL generator) are **shipped**.
Wired through the `queryInterfaceFactory` option on `QueryInterfaceOptions` (`builder.ts`) which
`TurbineClient.table()` consults (`client.ts`); the four SQL engines are byte-identical.
`./powdb` subpath export + optional peer deps (`@zvndev/powdb-client` **and** `@zvndev/powdb-embedded`,
both `^0.7.0`) added; root deps stay `{ pg, @types/pg }`.

**Verified live against `powdb-server` v0.7.0 AND `@zvndev/powdb-embedded` v0.7.0 — full CRUD passes on
both transports:** create (client-UUID + type coercion + `returning`), createMany (multi-row `returning`
→ real rows), update (atomic increment + `returning`), upsert (insert+update branches, reselect-by-PK),
delete (`returning` deleted row); plus a **float column round-trips a plain INTEGER value (7, 99) with
no workaround** (int→float coercion fixed on every write path) and an **adversarial string `a"b\c`
round-trips as data** through the embedded literal encoder. 36 build-only unit tests
(`src/test/powdb.test.ts`) lock PowQL generation, the literal encoder (adversarial cases), and embedded
param-materialization in CI (no server needed).

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
