# Multi-Dialect Support Plan — MySQL, SQLite, SQL Server

**Status:** Proposal / sequenced implementation plan
**Author:** database-tooling architect (planning pass)
**Date:** 2026-06-25
**Scope:** Add MySQL, SQLite, and MSSQL engines to Turbine ORM (PostgreSQL-only today).
**Constraint:** This document is planning + grounding only. No source code is modified by this plan.

> **TL;DR recommendation:** Build **SQLite first** (in-process, zero/near-zero new
> dependency via `node:sqlite`, perfect for tests/edge/demos), **MySQL second**
> (largest post-Postgres market, but forces the hard RETURNING re-architecture),
> and treat **MSSQL as optional / deferred** behind explicit demand. Adopt the
> **driver-injection** dependency strategy (mirror `TurbineConfig.pool` / `turbineHttp`)
> shipped as **subpath packages** (`turbine-orm/sqlite`, `/mysql`, `/mssql`) so the
> root package keeps its "one runtime dependency: `pg`" promise. Do **not** start
> any of this until the Postgres safety bundle hits **1.0** or **a credible volume of
> users explicitly ask** (see Strategic Framing). Total rough sizing: **~13–21
> engineer-weeks** for all three; **~5–8** to reach a polished SQLite + MySQL pair.

---

## 0. How the code is actually structured today (ground truth)

Everything below is grounded in the real source. The good news: **a deliberate
dialect seam already exists and already works for query/DDL/migration-tracking
SQL generation.** The bad news: **driver coupling, the execution model
(RETURNING-dependence), streaming, vector, realtime, RLS, and locking are NOT
behind the seam.** The plan's value is closing those gaps in the right order.

### 0.1 The `Dialect` contract (`src/dialect.ts`)

`DialectName = 'postgresql' | 'mysql' | 'sqlite' | (string & {})` is declared at
`src/dialect.ts:12` — MySQL and SQLite are *already named* in the type. The
`Dialect` interface (`src/dialect.ts:98-196`) is the seam. Only `postgresDialect`
(`src/dialect.ts:215-358`) is implemented. Every member and its Postgres behavior:

| Member | `src/dialect.ts` line | Postgres behavior | Varies per engine? |
|---|---|---|---|
| `name` | 100 / 216 | `'postgresql'` | identifier only |
| `paramPlaceholder(index)` | 103 / 223-225 | `` `$${index}` `` | **YES** — `?` (MySQL/SQLite), `@pN` (MSSQL) |
| `quoteIdentifier(name)` | 106 / 227-229 | `"…"`, doubles `"` | **YES** — `` `…` `` (MySQL), `"…"`/`[…]` (SQLite/MSSQL) |
| `escapeStringLiteral(value)` | 109 / 231-233 | doubles `'` | mostly same; MySQL also escapes `\` |
| `emptyJsonArrayLiteral` | 112 / 220 | `'[]'::json` | **YES** — `JSON_ARRAY()` / `json('[]')` / `'[]'` |
| `nullJsonLiteral` | 115 / 221 | `NULL` | same |
| `buildJsonObject(pairs)` | 118 / 235-238 | `json_build_object(...)` | **YES** — `JSON_OBJECT` / `json_object` / `FOR JSON` shape |
| `buildJsonArrayAgg(expr, orderBy?)` | 121 / 240-243 | `COALESCE(json_agg(expr ORDER BY…), '[]'::json)` | **YES** — crown-jewel divergence (§3) |
| `supportsReturning` | 124 / 217 | `true` | **YES** — `false` for MySQL, `true` SQLite 3.35+, MSSQL uses `OUTPUT` |
| `buildReturningClause(selection?)` | 127 / 245-247 | `` ` RETURNING *` `` | **YES** |
| `buildInsertStatement(input)` | 130 / 249-251 | `INSERT … RETURNING *` | **YES** |
| `buildBulkInsertStatement(input)` | 133 / 253-263 | `INSERT … SELECT * FROM UNNEST($1::t[], …)` | **YES** — UNNEST is PG-only (§4) |
| `buildUpsertStatement(input)` | 136 / 265-271 | `INSERT … ON CONFLICT (…) DO UPDATE SET … RETURNING *` | **YES** (§4) |
| `supportsILike` | 139 / 218 | `true` | **YES** |
| `buildInsensitiveLike(col, ref)` | 142 / 273-275 | `col ILIKE ref` | **YES** (§5) |
| `jsonPathSupport` | 145 / 219 | `'native'` | **YES** |
| `buildJsonContains(col, ref)` | 148 / 277-279 | `col @> ref::jsonb` | **YES** |
| `buildJsonPathExtract(col, ref)` | 151 / 281-283 | `col #>> ref::text[]` | **YES** |
| `buildCorrelation(lRef,lCols,rRef,rCols)` | 154 / 285-292 | `lRef."c" = rRef."c" AND …` | identifier-quoting only |
| `typeToTypeScript?(t, nullable)` | 162 / 294-296 | `pgTypeToTs` | **YES** (§7) |
| `arrayType?(baseType)` | 165 / 298-300 | `pgArrayType` | **YES** (only PG has true arrays) |
| `buildColumnType(input)` | 168 / 302-307 | `VARCHAR(n)` / passthrough | **YES** (§6/§7) |
| `buildColumnDefinition(input)` | 171 / 309-317 | column line w/ PK/UNIQUE/NOT NULL/DEFAULT/REFERENCES | **YES** (AUTO_INCREMENT/IDENTITY) |
| `buildPrimaryKeyConstraint(cols)` | 174 / 319-321 | `PRIMARY KEY (…)` | same |
| `buildCreateTableStatement(input)` | 177 / 323-326 | `CREATE TABLE … (…)` | same |
| `buildCreateIndexStatement(input)` | 180 / 328-330 | `CREATE INDEX … ON …(…)` | mostly same |
| `buildMigrationTrackingTable(table)` | 183 / 332-341 | `SERIAL`/`TIMESTAMPTZ` DDL | **YES** |
| `buildMigrationSelectApplied(table)` | 186 / 343-345 | `SELECT … ORDER BY id ASC` | same |
| `buildMigrationUpdateChecksum(table)` | 189 / 347-349 | parameterized UPDATE | placeholder only |
| `buildMigrationInsertApplied(table)` | 192 / 351-353 | `INSERT … ON CONFLICT (name) DO NOTHING` | **YES** |
| `buildMigrationDeleteApplied(table)` | 195 / 355-357 | parameterized DELETE | placeholder only |

Two **adjacent but unused/parallel** seams also exist:
- `DialectIntrospector` interface (`src/dialect.ts:198-207`) — declared, **never
  implemented or called**. Introspection today lives in `src/introspect.ts`.
- `DialectMigrator { acquireLock, releaseLock }` (`src/dialect.ts:209-212`) —
  declared, **never used**; migration locking actually goes through the *separate*
  `DatabaseAdapter` seam (`src/adapters/index.ts:48-87`). This duplication is a
  Phase-0 cleanup target (pick one seam).

**Proof the seam works:** `src/test/dialect.test.ts` already defines a working
`mysqlishDialect` (`src/test/dialect.test.ts:9-78`) and asserts that
`QueryInterface` routes identifiers, `?` placeholders, `LOWER() LIKE`,
`JSON_ARRAYAGG`/`JSON_OBJECT`, `JSON_CONTAINS`, `ON DUPLICATE KEY UPDATE`, MySQL
DDL, and MySQL migration-tracking SQL through the dialect — all build-only, no DB
(`src/test/dialect.test.ts:115-239`). This is a large head start: the *SQL-string
generation* layer is already ~80% abstracted.

### 0.2 Where the dialect is wired into query generation (`src/query/builder.ts`)

`QueryInterface` selects the dialect at `src/query/builder.ts:453`
(`this.dialect = options?.dialect ?? postgresDialect`). Two private helpers wrap
it: `q()` → `quoteIdentifier` (`builder.ts:468`) and `p()` → `paramPlaceholder`
(`builder.ts:473`). Confirmed dialect call sites:

- **Insert:** `buildCreate` → `dialect.buildInsertStatement(… returning:'*')`
  (`builder.ts:1253`).
- **Bulk insert:** `buildCreateMany` → `dialect.buildBulkInsertStatement`
  (`builder.ts:1313`), array casts via `getColumnArrayType` →
  `dialect.arrayType` (`builder.ts:4458-4460`).
- **Update / Delete:** `dialect.buildReturningClause('*')` appended
  (`builder.ts:1376`, `builder.ts:1527`).
- **Upsert:** `dialect.buildUpsertStatement` (`builder.ts:1593`).
- **Correlation:** `dialect.buildCorrelation` for self-relations
  (`builder.ts:3141,3144`) and hasMany/belongsTo subqueries
  (`builder.ts:4018,4020`).
- **Case-insensitive LIKE:** `dialect.buildInsensitiveLike` (`builder.ts:3473`).
- **Nested-relation JSON:** `dialect.buildJsonObject` (`builder.ts:3990,4079,4246,4281`),
  `dialect.buildJsonArrayAgg` (`builder.ts:4080,4082,4247,4282`),
  empty/null fallbacks `dialect.emptyJsonArrayLiteral`/`nullJsonLiteral`
  (`builder.ts:3985,4075,4241-4242,4276-4277`).
- **JSON filters:** `dialect.buildJsonPathExtract` (`builder.ts:4330`),
  `dialect.buildJsonContains` (`builder.ts:4334,4340`).

### 0.3 What is STILL hard-coded Postgres (the real work)

These are *not* behind the dialect and are the substance of the project:

1. **The execution/transform model assumes `RETURNING`.** `buildCreate`'s
   transform reads `result.rows[0]` and throws if missing
   (`builder.ts:1263-1273`); `buildUpsert` the same (`builder.ts:1605-1616`);
   `buildUpdate`/`buildDelete` append `RETURNING *` (`builder.ts:1376,1527`).
   MySQL has **no RETURNING** — `mysqlishDialect` already returns `''` from
   `buildReturningClause` (`dialect.test.ts:19`), which makes the *SQL* valid but
   leaves the *transform* with zero rows. **The DeferredQuery contract itself must
   gain an "execute-then-fetch" path for non-RETURNING engines.** This is the
   single biggest architectural gap and is invisible in the build-only tests.

2. **The nested COALESCE wrapper around each subquery is hard-coded.** Nested
   to-one/to-many values are wrapped `COALESCE((${subquery}), ${fallback})`
   (`builder.ts:3986,4076,4243,4278`) and the **LIMIT/ORDER-before-aggregate
   inner-subquery rewrite** (`SELECT json_agg(...) FROM (SELECT … LIMIT N) alias`,
   `builder.ts:4044-4082`) is plain SQL string assembly. It *uses* dialect JSON
   primitives but the *control flow* (correlated subqueries, COALESCE, the
   inner/outer wrap) is Postgres-shaped and must be validated/branched per engine
   (esp. MSSQL `FOR JSON`, §3).

3. **pgvector.** `VECTOR_METRIC_OPERATORS = { l2:'<->', cosine:'<=>', ip:'<#>' }`
   (`builder.ts:269-273`) and `pushVectorParam` emits `$n::vector`
   (`builder.ts:3580-3599`). No equivalent on MySQL/SQLite/MSSQL.

4. **Streaming via cursors.** `findManyStream` issues raw `BEGIN` /
   `DECLARE … NO SCROLL CURSOR FOR` / `FETCH n` / `CLOSE` / `COMMIT`
   (`builder.ts:1072-1093`). `DECLARE CURSOR` is Postgres syntax.

5. **Driver coupling in `client.ts`.** `import pg from 'pg'` (`client.ts:25`);
   `new pg.Pool` (`client.ts:514`) with default port 5432 (`client.ts:504`);
   `pg.types.setTypeParser(20, …)` int8 parser gated by a static flag
   (`client.ts:446-452`). Transactions use `BEGIN`/`COMMIT`/`ROLLBACK`
   (`client.ts:787-796`, `client.ts:822-942`); nesting uses `SAVEPOINT` /
   `RELEASE SAVEPOINT` / `ROLLBACK TO SAVEPOINT` (`client.ts:328-336`); isolation
   via `BEGIN ISOLATION LEVEL …` (`ISOLATION_LEVELS`, `client.ts:259-264,849`);
   RLS via `SELECT set_config($1,$2,true)` (`client.ts:867`); realtime via
   `$listen` and `SELECT pg_notify($1,$2)` (`client.ts:1000,1034`). Raw template
   SQL hard-codes `$N` (`client.ts:715`, `client.ts:351`).
   **Mitigation already present:** `TurbineConfig.pool` accepts any
   `PgCompatPool` (`client.ts:122-201`) and, when supplied, Turbine skips
   `setTypeParser` and makes `disconnect()` a no-op (`client.ts:446,1106-1112`).
   `turbineHttp(pool, schema)` (`src/serverless.ts:118-124`) is the existing
   driver-injection template to copy.

6. **Introspection is Postgres-catalog SQL.** `src/introspect.ts:29-112` queries
   `information_schema.*`, `pg_indexes`, and `pg_type`/`pg_enum`; it opens its own
   `new pg.Pool` (`introspect.ts:136`). `DialectIntrospector` (`dialect.ts:198-207`)
   is the intended-but-unused hook.

7. **Type mapping is a Postgres table.** `PG_TO_TS` (`src/schema.ts:122-184`,
   incl. `vector → number[]`), `DATE_TYPES` (`schema.ts:186`), `PG_TO_ARRAY`
   (`schema.ts:188-208`), `pgTypeToTs` (`schema.ts:211-221`). The int8→number
   parser story lives in `client.ts:446-452` and is documented in `schema.ts:126-129`.

8. **Migration locking.** `deriveLockId` (FNV-1a, `src/cli/migrate.ts:281-288`)
   feeds `pg_try_advisory_lock` via the `postgresql` adapter
   (`src/adapters/index.ts:100-114`). `migrateUp` opens a `new pg.Client`
   (`migrate.ts:396`) and uses dialect tracking SQL (`migrate.ts:418,454,480`).

9. **Packaging.** `package.json` deps are exactly `pg` + `@types/pg`
   (`package.json:77-80`); subpath exports are `.`, `./serverless`, `./cli`,
   `./adapters` (`package.json:6-27`); `sideEffects:false` (`package.json:42`).

---

## 1. The dependency tension (the core packaging decision)

Turbine's marketing promise is literally in the package description: *"One
dependency, no WASM engine"* (`package.json:4`) — and that one dependency is `pg`.
Every candidate driver breaks that promise if added to root `dependencies`:

| Engine | Primary driver | In-process? | Native build? | Notes |
|---|---|---|---|---|
| SQLite | `node:sqlite` (Node 22.5+, experimental) **or** `better-sqlite3` | yes | `node:sqlite` = **none**; `better-sqlite3` = N-API native | `node:sqlite` can make SQLite a **zero-dependency** engine on modern Node |
| MySQL | `mysql2` | no | pure JS | most popular; supports prepared statements, pooling, named placeholders |
| MSSQL | `mssql` (wraps `tedious`) **or** `tedious` directly | no | pure JS | heaviest API; `OUTPUT`/`MERGE` semantics |

**Decision: driver-injection + subpath packages. Do NOT add any driver to root
`dependencies`.** Three reinforcing tactics:

1. **Reuse the existing external-pool injection.** The cleanest, lowest-risk
   primitive already exists: `TurbineConfig.pool: PgCompatPool` (`client.ts:141`)
   plus `turbineHttp` (`serverless.ts:118-124`). Generalize `PgCompatPool` into a
   driver-neutral `TurbineDriver` adapter (connect/query/transaction/close) so a
   thin shim can wrap a `mysql2` pool or a `better-sqlite3` handle the same way
   Neon's pool is wrapped today. The caller installs the driver; Turbine never
   does. This preserves the root "one dependency" claim **exactly**.

2. **Ship engines as subpath exports**, mirroring `./serverless` and `./adapters`
   (`package.json:12-26`): add `turbine-orm/sqlite`, `turbine-orm/mysql`,
   `turbine-orm/mssql`. Each subpath exports the engine's `Dialect`,
   `DialectIntrospector`, driver shim, and a `turbineSqlite()/turbineMysql()/…`
   factory. The driver is declared as an **optional `peerDependency`** (with
   `peerDependenciesMeta.optional = true`), so `npm i turbine-orm` pulls nothing
   extra and only users who import a subpath install its peer.

3. **For SQLite, prefer `node:sqlite` to reach literal zero-dependency** on Node
   ≥ 22.5 (the package already targets `node:` builtins and `engines.node >=18`,
   `package.json:75` — the SQLite subpath would document Node ≥ 22). Offer a
   `better-sqlite3` shim as the fallback for older Node / wider compatibility.

This is the only strategy consistent with the repo's stated `Don't` rule —
*"Don't add runtime dependencies beyond `pg`"* (`CLAUDE.md`).

---

## 2. Parameter placeholders

Today `paramPlaceholder` is fully abstracted (`dialect.ts:223`, used via `p()` at
`builder.ts:473`) and the builder collects params positionally in `params[]`. The
mechanical changes per engine:

- **MySQL / SQLite:** `paramPlaceholder = () => '?'` (positional, index ignored —
  already proven in `dialect.test.ts:17`). The builder's positional ordering is
  preserved because params are pushed in generation order; `?` just drops the
  number. **Caveat:** any place that *reuses* a parameter index (binds `$3`
  twice) would break under `?`. Audit the upsert/update param assembly
  (`builder.ts:1583-1591`, `builder.ts:1393-1398`) — currently each value is
  pushed once, so positional `?` is safe, but the conformance matrix must lock
  this in.
- **MSSQL:** `@pN` named placeholders. `tedious`/`mssql` want named params with a
  separate `request.input('pN', type, value)` registration. `paramPlaceholder =
  (i) => `@p${i}`` plus a driver shim that maps the positional `params[]` to
  `@p1..@pN`. MSSQL also benefits from explicit parameter *typing* — the shim can
  infer from JS value types or fall back to the driver's default.
- **Raw SQL escape hatches** (`client.ts:715`, `client.ts:351`,
  `src/typed-sql.ts`) hard-code `$N` and must consult the dialect placeholder too,
  or they will produce Postgres-only SQL even on a MySQL client. (Phase-0 item.)

---

## 3. The nested-relation engine — the crown jewel (§ json_agg)

This is the differentiator and the hardest mapping. Turbine generates **one**
correlated-subquery tree using `json_agg(json_build_object(...))` with
`COALESCE(…, '[]'::json)` and an inner-subquery rewrite for `LIMIT`/`ORDER`
(`builder.ts:3717-4082`, algorithm documented in `CLAUDE.md` "The json_agg
Algorithm"). Mapping per engine:

### SQLite (single-query: YES)
- `json_object('k', v, …)` ↔ `buildJsonObject`; `json_group_array(json_object(...))`
  ↔ `buildJsonArrayAgg`; empty fallback `'[]'` (or `json('[]')`),
  `nullJsonLiteral = NULL`.
- **Critical semantic difference:** SQLite's `json_group_array` produces a JSON
  **string of strings** unless inner objects are wrapped with `json(...)` — nested
  objects double-encode. The dialect must wrap each nested subquery result in
  `json(...)` so the parsed tree is real JSON, not strings-in-strings. The current
  `COALESCE((subquery), fallback)` wrapper (`builder.ts:3986`) needs a dialect hook
  (`wrapJsonSubresult`) so SQLite can inject `json(...)`. **This is a Phase-0
  contract addition**, not just a config value.
- `ORDER BY` inside `json_group_array` is **not** supported the way PG's
  `json_agg(… ORDER BY …)` is; SQLite needs the inner-subquery rewrite
  (`builder.ts:4044-4082`) for *all* ordered to-many relations, not just limited
  ones. The builder already has that machinery — extend the "needs inner wrap"
  predicate to include `orderBy` when `dialect.aggOrderByInline === false`.
- `LIMIT`-before-aggregate: use the existing inner-subquery rewrite. Works.
- **Verdict:** single-query guarantee preserved; needs a `json()`-wrap hook and an
  "order requires inner subquery" flag.

### MySQL 8 (single-query: YES)
- `JSON_OBJECT('k', v, …)` and `JSON_ARRAYAGG(…)` with `COALESCE(…, JSON_ARRAY())`
  — already prototyped (`dialect.test.ts:36-39`).
- **Critical semantic difference:** `JSON_ARRAYAGG` is an aggregate with **no
  `ORDER BY` argument** (unlike PG `json_agg(… ORDER BY …)`). Any ordered to-many
  **must** use the inner-subquery rewrite. Same flag as SQLite.
- **NULL handling:** `JSON_ARRAYAGG` over an empty group returns `NULL`, so the
  `COALESCE(…, JSON_ARRAY())` is load-bearing (already in the prototype). For
  to-one (`belongsTo`/`hasOne`), the PG path returns a JSON object via a `LIMIT 1`
  subquery and `nullJsonLiteral = NULL`; MySQL is the same.
- **Type coercion of parsed JSON:** MySQL returns JSON columns as strings over the
  wire (handled by `parseNestedRow`'s `JSON.parse`, `builder.ts:3679-3711`).
  `mysql2` may auto-parse JSON depending on config — the shim must pin
  `{ typeCast }` / `supportBigNumbers` so behavior matches `parseNestedRow`'s
  expectation of receiving a **string** (or already-parsed object — both branches
  exist at `builder.ts:3679,3707`). Numbers in JSON lose the int8→number nuance
  (§7); document it.
- **Verdict:** single-query guarantee preserved (MySQL ≥ 8.0; **5.7 is out** — no
  `JSON_ARRAYAGG`).

### MSSQL (single-query: PARTIAL — highest risk)
- No `json_agg`. The idiomatic path is `(SELECT … FROM child WHERE corr FOR JSON
  PATH)` which yields a JSON **string**; for to-one add `, WITHOUT_ARRAY_WRAPPER`.
- **Empty-array coalescing:** `FOR JSON PATH` over zero rows returns **`NULL`, not
  `'[]'`** — must wrap `ISNULL((…FOR JSON PATH), '[]')`. The `WITHOUT_ARRAY_WRAPPER`
  to-one case returns `NULL` for no rows, which is the desired `nullJsonLiteral`.
- **`FOR JSON` is not an expression in all positions.** It is a query clause, so
  embedding it as a scalar requires the subquery-in-SELECT form `(SELECT … FOR
  JSON PATH)`. Turbine already builds correlated subqueries (`builder.ts:4082`),
  so the shape fits — but `buildJsonObject`/`buildJsonArrayAgg` do not map cleanly;
  MSSQL needs a **different code path** where the "object shape" is expressed by
  the child `SELECT`'s column aliases (`SELECT child.id AS id, child.title AS
  title … FOR JSON PATH`) rather than an explicit `JSON_OBJECT(...)`. This means
  the dialect contract needs a higher-level hook — `buildRelationSubquery`
  fragments — for MSSQL, OR an MSSQL-specific override of the subquery builder.
- **Ordering / LIMIT:** `ORDER BY` inside `FOR JSON` requires `TOP` or
  `OFFSET/FETCH`; `LIMIT N` → `ORDER BY … OFFSET 0 ROWS FETCH NEXT N ONLY` or
  `SELECT TOP N`. Reuse the inner-subquery rewrite.
- **Type coercion:** `FOR JSON` emits ISO-8601 datetimes and base64 for binary —
  `parseNestedRow` date coercion (`builder.ts:3638`) still works; binary differs.
- **Verdict:** single-query is **achievable but requires an MSSQL-specific
  subquery generator**, not just primitive swaps. This is why MSSQL is the
  expensive engine and a deferral candidate.

**Summary:** SQLite and MySQL preserve the single-query crown jewel with a
`json()`-wrap hook + an "order needs inner subquery" flag. MSSQL preserves it only
with a dedicated `FOR JSON` subquery path — a meaningfully larger build.

---

## 4. Upsert / RETURNING / createMany (returning generated rows)

The whole `create`/`upsert`/`update`/`delete` result contract assumes `RETURNING`
(`builder.ts:1263-1273,1376,1527,1605-1616`). Per engine:

- **PostgreSQL (today):** `INSERT … ON CONFLICT … DO UPDATE … RETURNING *`;
  `createMany` uses `UNNEST($1::t[], …)` (`dialect.ts:253-263`, `builder.ts:1313`).
- **SQLite (3.35+):** Has `RETURNING` **and** `ON CONFLICT … DO UPDATE` — closest
  to PG. `supportsReturning = true`. **No `UNNEST`** → `buildBulkInsertStatement`
  must emit multi-row `VALUES (?,?),(?,?)…` with flattened params (the
  `mysqlishDialect` bulk prototype, `dialect.test.ts:22-33`, is the template).
  `last_insert_rowid()` exists as a fallback but `RETURNING` makes it unnecessary.
  **Verdict:** create/upsert/createMany all return rows directly. Lowest friction.
- **MySQL:** **No `RETURNING`.** `INSERT … ON DUPLICATE KEY UPDATE` (no conflict
  target list; relies on the table's unique/PK indexes — note Turbine's upsert
  derives the conflict target from `where` keys at `builder.ts:1576-1579`, which
  MySQL ignores). To return the created/updated row, the engine must **execute
  then re-select**: capture `insertId`/`affectedRows` from `mysql2`'s result and
  issue a follow-up `SELECT … WHERE pk = ?` inside the same connection/transaction.
  This requires the new **non-RETURNING execution path** in the `DeferredQuery`
  contract (Phase-0/Phase-2 item). For `createMany`, `insertId` is the **first**
  auto-id and rows are sequential *only* for single-statement inserts with
  AUTO_INCREMENT — fragile; the safe approach is a transaction + re-select by a
  natural key, or accept "returns count, not rows" for MySQL createMany and
  document the divergence.
- **MSSQL:** No `RETURNING`, but `OUTPUT INSERTED.*` on `INSERT`/`UPDATE`/`DELETE`
  and `MERGE` for upsert. `MERGE … WHEN MATCHED THEN UPDATE … WHEN NOT MATCHED
  THEN INSERT … OUTPUT INSERTED.*` returns the row in one statement — so MSSQL can
  keep the single-statement-returns-row model via `OUTPUT` (the dialect's
  `buildReturningClause` becomes an `OUTPUT INSERTED.…` prefix injected into the
  statement, not a trailing clause — a contract shape change). `MERGE` has known
  footguns (must end with `;`, concurrency caveats) to document.

**Architectural conclusion:** the `Dialect`/`DeferredQuery` contract must grow an
explicit capability: `resultStrategy: 'returning' | 'output' | 'reselect'`, and
the executor (`builder.ts execute`/`queryWithTimeout`) must branch. PG/SQLite use
`returning`, MSSQL uses `output`, MySQL uses `reselect`. **This is the highest-
leverage Phase-0 change** because it unblocks all three engines' write paths.

---

## 5. Case-insensitive matching

`buildInsensitiveLike` is already abstracted (`dialect.ts:273`, used at
`builder.ts:3473`). Per engine:

- **PostgreSQL:** `col ILIKE ref` (`dialect.ts:274`).
- **MySQL:** default collations (`*_ci`) make `LIKE` case-insensitive already, but
  to be deterministic use `LOWER(col) LIKE LOWER(ref)` (prototype:
  `dialect.test.ts:40`). Note this can **defeat indexes**; document that
  insensitive matching may not use an index unless a generated/functional index
  exists.
- **SQLite:** `col LIKE ref` is ASCII-case-insensitive by default for ASCII only;
  for correctness use `col LIKE ref COLLATE NOCASE`. Unicode case-folding is **not**
  supported by `NOCASE` (ASCII-only) — document the limitation.
- **MSSQL:** collation-driven; default `*_CI_*` collations make `LIKE`
  insensitive. For determinism, `col LIKE ref COLLATE SQL_Latin1_General_CP1_CI_AS`
  or `LOWER()`. The escape handling (`escapeLike`, `ESCAPE` clause already emitted
  per `dialect.test.ts:149`) carries over.

---

## 6. Introspection + codegen

`src/introspect.ts` is Postgres-catalog SQL (`introspect.ts:29-112`) and opens its
own pool (`introspect.ts:136`). Plan: **implement the dormant `DialectIntrospector`
seam** (`dialect.ts:198-207`) and have each engine subpath provide one. The
generator (`src/generate.ts`) consumes the produced `SchemaMetadata` and is mostly
engine-agnostic (it emits TS from metadata), so most codegen work is upstream in
introspection + `typeToTypeScript`.

- **MySQL:** `information_schema.TABLES/COLUMNS/KEY_COLUMN_USAGE/
  TABLE_CONSTRAINTS/STATISTICS`. Largely portable from the existing queries
  (`introspect.ts:37-97`) — column names differ in case (`TABLE_NAME`) and MySQL
  lacks `udt_name` (use `DATA_TYPE`/`COLUMN_TYPE`). Indexes come from
  `information_schema.STATISTICS`, **not** `pg_indexes` (`introspect.ts:99-103`).
  No `pg_enum`; MySQL enums are inline `ENUM('a','b')` in `COLUMN_TYPE` — parse
  from there.
- **SQLite:** **no `information_schema`.** Use `PRAGMA table_info(t)`,
  `PRAGMA foreign_key_list(t)`, `PRAGMA index_list(t)`/`index_info`, and
  `sqlite_master`. A fully different introspector — but small (handful of pragmas).
- **MSSQL:** `INFORMATION_SCHEMA.*` exists and is closer to the SQL standard;
  identity columns and `IDENTITY`/computed columns come from `sys.columns`/
  `sys.identity_columns`. Indexes from `sys.indexes`.

The `arrayType`/`typeToTypeScript` hooks already flow through introspection
(`introspect.ts:178,185-186`) — each dialect supplies its own mapping (§7).

---

## 7. Type mapping (DB ↔ TypeScript) and the int8 story

Today: `PG_TO_TS` (`schema.ts:122-184`), `PG_TO_ARRAY` (`schema.ts:188-208`),
`pgTypeToTs` (`schema.ts:211-221`); int8 returns as `number` via a parser gated in
the client constructor (`client.ts:446-452`, documented `schema.ts:126-129`).

- **MySQL (`mysql2`):** `TINYINT(1)`→`boolean` (driver convention),
  `BIGINT`→`number|string` (mysql2 `supportBigNumbers`/`bigNumberStrings` — match
  the PG int8 policy: number if safe, else string), `DATETIME`/`TIMESTAMP`→`Date`
  (set `dateStrings:false`), `JSON`→`unknown` (pin `typeCast` so it returns string
  for `parseNestedRow`, or accept parsed objects — both branches exist
  `builder.ts:3679,3707`), `DECIMAL`→`string` (mirror PG `numeric`,
  `schema.ts:134`). No native arrays → `arrayType` returns nothing and bulk-insert
  uses `VALUES`. The prototype `typeToTypeScript` (`dialect.test.ts:43-53`) is the
  starting map.
- **SQLite:** dynamic typing / type affinity. Map declared types →
  `INTEGER`→`number` (note: integers up to 2^63 come back as JS `number` and lose
  precision past 2^53 — same caveat as int8; `better-sqlite3` offers BigInt mode),
  `REAL`→`number`, `TEXT`→`string`, `BLOB`→`Buffer/Uint8Array`, `NUMERIC`→`string`.
  No native `BOOLEAN` (0/1 ints) or `DATE` (TEXT/INTEGER) — map by declared type
  and document the affinity caveat. `node:sqlite` returns BigInt for large ints —
  the shim normalizes like the int8 parser.
- **MSSQL:** `BIGINT`→`number|string`, `BIT`→`boolean`, `DATETIME2`/
  `DATETIMEOFFSET`→`Date`, `NVARCHAR`→`string`, `UNIQUEIDENTIFIER`→`string`,
  `DECIMAL`→`string`, `VARBINARY`→`Buffer`. `mssql`/`tedious` have their own type
  parsers; the shim configures them (e.g. `tedious` `options.useUTC`).

**The int8/bignum policy generalizes cleanly:** each driver shim must implement
"safe-integer → number, else string" *outside* global state (PG's static-flag
pattern, `client.ts:446`), and **must not** mutate global parsers when an external
pool/driver is injected (the existing `!config.pool` guard, `client.ts:446`).

---

## 8. Features that may NOT port (degrade / throw / equivalent)

| Feature | Source | MySQL | SQLite | MSSQL | Strategy |
|---|---|---|---|---|---|
| pgvector (KNN orderBy, distance WHERE) | `builder.ts:269-273,3580-3599` | none (MySQL 9 `VECTOR` partial) | `sqlite-vec` ext (optional) | none native | **Throw** `unsupported on <engine>` from vector builders unless an extension is present; keep PG as the vector story |
| LISTEN/NOTIFY realtime | `client.ts:1000-1038`, `src/realtime.ts` | none (poll/CDC) | none | Service Broker / `SqlDependency` (heavy) | **Throw** clear unsupported error (same shape as the serverless-HTTP `$listen` error today) |
| RLS via `set_config` (sessionContext) | `client.ts:859-868` | no GUCs; session vars `SET @v` (not RLS) | none | `SESSION_CONTEXT()`/`sp_set_session_context` + native RLS | **MSSQL: real equivalent** via `sp_set_session_context`; **MySQL/SQLite: throw/no-op** with docs |
| Advisory-lock migration locking | `migrate.ts:281-309`, `adapters/index.ts:100-114` | `GET_LOCK(name, timeout)` / `RELEASE_LOCK` | single-writer; lock table or rely on file lock | `sp_getapplock`/`sp_releaseapplock` (session/transaction scoped) | **Equivalent per engine** — implement via the `DatabaseAdapter.acquireLock/releaseLock` seam (already pluggable). `deriveLockId` (FNV-1a) → string name for `GET_LOCK`/`sp_getapplock` |
| `statement_timeout` (txn/studio) | `adapters/index.ts:109-114` | `SET SESSION MAX_EXECUTION_TIME` (SELECT only) | `sqlite3_busy_timeout`/`progress_handler` | `SET LOCK_TIMEOUT` / query `OPTION` | Per-adapter `statementTimeout()` (seam exists, `adapters/index.ts:80`) |
| True wire-protocol pipelining | `src/pipeline-submittable.ts` (pg Connection) | no equivalent protocol | n/a (in-process) | no equivalent | **Degrade** to sequential execution (the existing HTTP fallback path, `pipeline.ts`) |
| Streaming cursors (`DECLARE CURSOR`) | `builder.ts:1072-1093` | `mysql2` streaming `.stream()` | `better-sqlite3` `.iterate()` / `node:sqlite` iterator | `tedious` `request.on('row')` streaming | **Equivalent per engine** via a `dialect.openStream()` driver hook replacing the raw cursor SQL |
| Savepoints / nested tx | `client.ts:328-336` | supported (`SAVEPOINT`) | supported (`SAVEPOINT`) | supported (`SAVE TRANSACTION name`) | MSSQL uses `SAVE TRANSACTION` + `ROLLBACK TRANSACTION name` (different keyword) — dialect tx-keyword hook |
| Isolation levels | `client.ts:259-264,849` | `SET TRANSACTION ISOLATION LEVEL` (before/after BEGIN differs) | only `DEFERRED/IMMEDIATE/EXCLUSIVE` (no SQL-standard levels) | `SET TRANSACTION ISOLATION LEVEL` | SQLite: map/ignore standard levels, document single-writer |

**Guiding rule:** prefer *throw-with-clear-message* over silent degradation for
features with no equivalent (vector, LISTEN/NOTIFY) so users are never surprised;
implement real equivalents for locking, timeouts, streaming, savepoints.

---

## 9. Transactions / savepoints / isolation specifics

- **SQLite single-writer:** only one write transaction at a time; concurrent
  writers get `SQLITE_BUSY`. The `$transaction` timeout machinery
  (`client.ts:887-911`) maps to a busy-timeout. Nested `$transaction` →
  `SAVEPOINT` works (`client.ts:328`). Recommend `journal_mode=WAL` in the shim
  for read concurrency. The retry layer (`withRetry`, `client.ts:59-82`) should
  treat `SQLITE_BUSY` as retryable (extend `wrapPgError` equivalent per engine).
- **MySQL:** `SAVEPOINT`/`RELEASE SAVEPOINT`/`ROLLBACK TO SAVEPOINT` identical to
  PG; isolation via `SET TRANSACTION ISOLATION LEVEL …` issued *before* `BEGIN`
  (PG appends it to `BEGIN`, `client.ts:849`) — dialect must own the BEGIN+isolation
  composition. Deadlock (error 1213) and lock-wait timeout (1205) map to the
  retryable `DeadlockError`/`SerializationFailureError` codes (E012/E013).
- **MSSQL:** `BEGIN TRANSACTION` / `COMMIT` / `ROLLBACK`; nesting via
  `SAVE TRANSACTION name` + `ROLLBACK TRANSACTION name` (**different keywords** —
  `client.ts:328-336` must route through a dialect tx-keyword hook). Isolation via
  `SET TRANSACTION ISOLATION LEVEL …` before BEGIN. Error 1205 (deadlock victim) →
  retryable.

**Conclusion:** `client.ts`'s transaction methods (`transaction`, `$transaction`,
`TransactionClient`) must route every literal SQL keyword (`BEGIN`, `COMMIT`,
`ROLLBACK`, `SAVEPOINT …`, isolation prefix, `set_config`) through the dialect.
Today they are hard-coded Postgres. This is a Phase-0 + per-phase task.

---

## Phased Plan

### Phase 0 — De-risk & complete the seam (no new engine yet)

**Goal:** make it *impossible* for hard-coded Postgres SQL to live outside the
dialect, and prove it with a conformance matrix. Until this is done, every engine
re-discovers the same gaps.

**Scope / tasks:**
1. **Result-strategy contract.** Add `resultStrategy: 'returning' | 'output' |
   'reselect'` to `Dialect` and branch the executor so create/upsert/update/delete
   no longer assume `result.rows[0]` from `RETURNING` (`builder.ts:1263-1273,
   1376,1527,1605-1616`). This is the keystone for MySQL/MSSQL writes.
2. **Driver abstraction.** Generalize `PgCompatPool` (`client.ts:122-201`) into a
   `TurbineDriver` seam (connect/query/transaction/stream/close + placeholder +
   capability flags). Route `client.ts`'s `BEGIN/COMMIT/ROLLBACK/SAVEPOINT/
   isolation/set_config` (`client.ts:328-336,787-942`) and the raw-SQL `$N`
   templating (`client.ts:715`, `typed-sql.ts`) through it.
3. **JSON subresult wrap hook.** Add `wrapJsonSubresult()` so the hard-coded
   `COALESCE((subquery), fallback)` (`builder.ts:3986,4076,4243,4278`) and the
   inner/outer aggregate wrap (`builder.ts:4044-4082`) are dialect-controlled
   (needed for SQLite `json(...)` and MSSQL `ISNULL(... , '[]')`). Add
   `aggSupportsInlineOrderBy` flag to force the inner-subquery rewrite when false.
4. **Streaming hook.** Replace raw `DECLARE CURSOR` (`builder.ts:1072-1093`) with
   `dialect.openStream(connection, sql, params, batchSize)`.
5. **Feature-capability flags + guard errors.** `supportsVector`,
   `supportsListenNotify`, `supportsRLS`, `supportsAdvisoryLock` → throw a typed
   `unsupported on <engine>` error from the relevant builders.
6. **Unify the locking seam.** Either delete `DialectMigrator` (`dialect.ts:209-212`)
   or fold `DatabaseAdapter` (`adapters/index.ts:48-87`) into it — one seam.
7. **Implement the dormant `DialectIntrospector`** (`dialect.ts:198-207`) and route
   `introspect()` through it (`introspect.ts:133-136`).
8. **Dialect conformance test matrix.** Expand `src/test/dialect.test.ts` into a
   parameterized suite that runs the *same* build-only assertions against every
   registered dialect (PG real + a SQLite + a MySQL + an MSSQL fixture dialect),
   asserting zero Postgres tokens leak (the `doesNotMatch(/json_agg|RETURNING|
   \$1|ILIKE/)` pattern already at `dialect.test.ts:151,162,201` generalized).

**Driver decision:** none (no engine yet).
**Degrades/throws:** establishes the throw infrastructure.
**Test strategy:** pure unit (no DB); extend the existing build-only suite.
**Rough size:** **2–3.5 engineer-weeks.** (Mostly refactor + the result-strategy
keystone.)
**Exit criteria:** PG behavior byte-identical (existing tests green); a fixture
non-PG dialect drives findMany/create/createMany/upsert/update/delete/nested-with
SQL with no Postgres leakage; result-strategy `reselect`/`output` paths unit-tested
with a mock driver.

---

### Phase 1 — SQLite (recommended FIRST)

**Why first:** in-process (no service container — runs in CI and on a laptop
instantly), `RETURNING` + `ON CONFLICT` since 3.35 (closest to PG semantics),
`node:sqlite` can make it **zero-dependency**, and it unlocks fast tests, edge
demos, and a "try Turbine in 10 seconds" story. It exercises the entire Phase-0
seam with the *least* exotic SQL.

**Scope / dialect methods to implement (`sqliteDialect`):**
- `paramPlaceholder = () => '?'`; `quoteIdentifier` with `"…"` (SQLite accepts
  both `"` and `` ` ``; standardize on `"`).
- `buildJsonObject` → `json_object(...)`; `buildJsonArrayAgg` →
  `COALESCE(json_group_array(json(expr)), json('[]'))`; `wrapJsonSubresult` →
  `json(...)`; `aggSupportsInlineOrderBy = false`.
- `supportsReturning = true`; `buildReturningClause = ' RETURNING *'`;
  `resultStrategy = 'returning'`.
- `buildInsertStatement`/`buildUpsertStatement` ≈ PG (`ON CONFLICT … DO UPDATE …
  RETURNING *`); `buildBulkInsertStatement` → multi-row `VALUES` (no `UNNEST`).
- `buildInsensitiveLike` → `col LIKE ref COLLATE NOCASE`.
- `buildJsonPathExtract` → `json_extract(col, ref)`; `buildJsonContains` → emulate
  via `json_extract`/`EXISTS` (document `limited`).
- DDL: `buildColumnType` (INTEGER/REAL/TEXT/BLOB/NUMERIC, `INTEGER PRIMARY KEY
  AUTOINCREMENT`), migration-tracking DDL.
- `DialectIntrospector` via `PRAGMA table_info`/`foreign_key_list`/`index_list`.
- Driver shim wrapping `node:sqlite` (primary) and `better-sqlite3` (fallback) to
  the `TurbineDriver` seam; `turbineSqlite(path | ':memory:', schema)` factory.

**Driver decision:** **`node:sqlite`** (zero dep, Node ≥ 22) as primary;
`better-sqlite3` optional peer for older Node.
**Features that degrade/throw:** vector → throw (or optional `sqlite-vec`);
LISTEN/NOTIFY → throw; RLS `set_config` → throw/no-op; pipelining → sequential
(in-process, free); isolation levels → mapped/ignored (single-writer, documented).
**Test strategy:** `:memory:` databases in unit tests — **no service container
needed.** Port `src/test/fixtures/seed.sql` to SQLite and run the full integration
suite in-process. This becomes the default fast CI lane.
**Rough size:** **2.5–4 engineer-weeks.**
**Exit criteria:** full findMany/with-nesting/create/createMany/upsert/update/
delete/transaction/savepoint suite green against `:memory:`; codegen round-trips a
SQLite schema; docs page + `turbineSqlite()` example; zero new root dependency.

---

### Phase 2 — MySQL (largest post-Postgres market)

**Why second:** biggest addressable market after Postgres; validates the
`reselect` result strategy and the no-`RETURNING` reality; MySQL 8's
`JSON_ARRAYAGG`/`JSON_OBJECT` preserve the single-query crown jewel.

**Scope / dialect methods (`mysqlDialect` — much already prototyped in
`dialect.test.ts:9-78`):**
- `paramPlaceholder = () => '?'`; `quoteIdentifier` → backticks.
- `buildJsonObject` → `JSON_OBJECT`; `buildJsonArrayAgg` →
  `COALESCE(JSON_ARRAYAGG(expr), JSON_ARRAY())`; `aggSupportsInlineOrderBy = false`
  (ordered to-many forced through inner-subquery rewrite).
- `supportsReturning = false`; `resultStrategy = 'reselect'` — **execute then
  re-SELECT by PK/unique within the same connection/transaction** to honor
  `create`/`upsert` returning a row (§4). Decide `createMany` policy: return count
  + best-effort re-select, documented.
- `buildUpsertStatement` → `INSERT … ON DUPLICATE KEY UPDATE …` (conflict target
  ignored — relies on table indexes; reconcile with `where`-derived target at
  `builder.ts:1576-1579`).
- `buildBulkInsertStatement` → multi-row `VALUES` (prototype `dialect.test.ts:22-33`).
- `buildInsensitiveLike` → `LOWER(col) LIKE LOWER(ref)`.
- `buildColumnType` (BIGINT AUTO_INCREMENT / DATETIME / JSON — prototype
  `dialect.test.ts:61-66`); migration tracking (prototype `dialect.test.ts:67-77`).
- `DialectIntrospector` via `information_schema.*` + `STATISTICS` + inline ENUM
  parsing.
- Locking adapter: `GET_LOCK(name, 0)` / `RELEASE_LOCK(name)` using
  `deriveLockId`→name (`migrate.ts:281-309` via `DatabaseAdapter` seam).
- Driver shim over `mysql2` (pooling, prepared statements, `typeCast`/bignum
  config matching the int8 policy).

**Driver decision:** **`mysql2`** (optional peer dependency).
**Features that degrade/throw:** RETURNING → `reselect`; vector → throw;
LISTEN/NOTIFY → throw; RLS `set_config` → throw; advisory locks → `GET_LOCK`;
streaming → `mysql2` `.stream()`; statement timeout → `MAX_EXECUTION_TIME`.
**Min version:** MySQL **8.0+** (5.7 lacks `JSON_ARRAYAGG`) — fail fast on connect
with a version check. MariaDB caveat: `JSON_ARRAYAGG` differs — treat as a separate
adapter or document unsupported.
**Test strategy:** CI **service container** (`services: mysql:8` in the workflow),
seeded from a MySQL port of the fixture; gate via the existing `skipGate()` pattern
(`src/test/helpers.ts`) when no MySQL URL.
**Rough size:** **3–5 engineer-weeks** (the `reselect` execution path + introspector
are the bulk).
**Exit criteria:** full suite green against MySQL 8 container including nested
`with`, `reselect` create/upsert returning real rows, deadlock retry (1213→E012),
`GET_LOCK` concurrent-migration test; docs page + `turbineMysql()`.

---

### Phase 3 — MSSQL (enterprise; hardest; optional/deferred)

**Why last / why optional:** no `RETURNING` (needs `OUTPUT`), no `json_agg` (needs
a dedicated `FOR JSON PATH` subquery generator, §3), `MERGE` upsert footguns,
`SAVE TRANSACTION` keyword divergence, and the smallest overlap with Turbine's
Postgres-first audience. Build **only** on explicit enterprise demand.

**Scope / dialect methods (`mssqlDialect`):**
- `paramPlaceholder = (i) => `@p${i}``; `quoteIdentifier` → `[…]` (or `"…"` with
  `QUOTED_IDENTIFIER ON`).
- **Dedicated nested-relation path:** override `buildRelationSubquery` to emit
  `(SELECT child cols … WHERE corr [ORDER BY … OFFSET/FETCH] FOR JSON PATH
  [, WITHOUT_ARRAY_WRAPPER])` with `ISNULL(…, '[]')` for to-many. This is a code
  path, not a primitive swap.
- `supportsReturning = false`; `resultStrategy = 'output'`; `buildReturningClause`
  → `OUTPUT INSERTED.*` injected mid-statement (contract shape change vs trailing
  clause); upsert → `MERGE … OUTPUT INSERTED.*`.
- `buildBulkInsertStatement` → multi-row `VALUES` (≤ 1000-row / 2100-param limits
  → chunk).
- `buildInsensitiveLike` → `COLLATE …_CI_AS` or `LOWER()`.
- `LIMIT/OFFSET` → `ORDER BY … OFFSET n ROWS FETCH NEXT m ROWS ONLY` (requires an
  `ORDER BY`); the builder's limit/order assembly must learn this.
- Transactions: `BEGIN TRANSACTION`/`SAVE TRANSACTION name`/`ROLLBACK TRANSACTION
  name`; RLS via `sp_set_session_context` + native RLS (real equivalent);
  `sp_getapplock`/`sp_releaseapplock` for migration locking.
- `DialectIntrospector` via `INFORMATION_SCHEMA.*` + `sys.columns`/`sys.indexes`/
  `sys.identity_columns`.
- Driver shim over `mssql`/`tedious` (named params + explicit typing).

**Driver decision:** **`mssql`** (wraps `tedious`) as an optional peer.
**Features that degrade/throw:** RETURNING → `OUTPUT`; vector → throw;
LISTEN/NOTIFY → throw (Service Broker out of scope); RLS → `sp_set_session_context`;
advisory lock → `sp_getapplock`; pipelining → sequential.
**Test strategy:** CI service container (`mcr.microsoft.com/mssql/server`),
license/EULA-accepted; heaviest container; gate via `skipGate()`.
**Rough size:** **5–8 engineer-weeks** (the `FOR JSON` subquery generator, `OUTPUT`/
`MERGE`, OFFSET/FETCH, and named-param driver are each non-trivial).
**Exit criteria:** nested `with` via `FOR JSON PATH` returns identical parsed trees
to PG for the fixture; `MERGE` upsert + `OUTPUT` returns rows; deadlock retry
(1205→E012); concurrent-migration `sp_getapplock` test; docs page.

---

## Risk Register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | RETURNING-dependence is deeper than the build-only tests reveal; `reselect`/`output` re-architecture leaks into many call sites | High | High | Phase-0 keystone (#1) lands the `resultStrategy` branch *before* any engine; mock-driver unit tests for all three strategies |
| R2 | MSSQL `FOR JSON` cannot be expressed through the existing primitive hooks → forces an engine-specific subquery generator, ballooning scope | High | High | Scope MSSQL behind explicit demand; design the relation-subquery builder to accept a dialect override in Phase 0 |
| R3 | Adding a driver silently breaks the "one dependency" promise / supply-chain story | Medium | High | Optional peerDeps + subpath packages + CI assert that root `dependencies` stays `{pg}` (a `package.json` guard test) |
| R4 | JSON double-encoding (SQLite) / NULL-vs-`[]` (MSSQL) produces subtly wrong nested trees | Medium | High | `wrapJsonSubresult` hook + parity tests asserting parsed tree equality against the PG fixture for every engine |
| R5 | bignum/int8 precision differs per driver → silent data corruption | Medium | High | Generalize the safe-integer policy (`client.ts:446-452`) into each shim; never mutate global parsers for injected drivers |
| R6 | Maintenance/CI cost: 3 more engines × service containers × matrix | High | Medium | SQLite needs no container (default lane); MySQL/MSSQL run on a slower nightly matrix (mirrors the parked-YugabyteDB nightly pattern in this repo's CI) |
| R7 | Feature divergence confuses users (vector/LISTEN work on PG only) | Medium | Medium | Throw typed `unsupported on <engine>` errors + a capability matrix in docs; never silently no-op |
| R8 | Dilutes the Postgres-focus moat / splits roadmap attention pre-1.0 | Medium | High | Gate the whole initiative behind the Strategic Framing trigger below |
| R9 | MySQL `ON DUPLICATE KEY UPDATE` ignores the `where`-derived conflict target → upsert hits the wrong unique index | Medium | Medium | Validate that the upsert `where` keys correspond to an actual unique/PK index at build time; document MySQL semantics |
| R10 | SQLite `node:sqlite` is experimental / API churn across Node versions | Medium | Low | Pin a min Node, keep `better-sqlite3` fallback, abstract behind the driver shim |

---

## Recommendation on ordering and on whether MSSQL is worth it

**Ordering: SQLite → MySQL → (maybe) MSSQL.** SQLite is the cheapest way to prove
the entire Phase-0 seam end-to-end, it needs no infrastructure, and it pays for
itself immediately as the fast in-process test/edge/demo engine even if no further
engine ships. MySQL is the only one with a large enough market to justify the
`reselect` re-architecture, and MySQL 8 keeps the single-query crown jewel intact.

**MSSQL: build only on explicit, paying-customer demand.** It is the most expensive
engine (dedicated `FOR JSON` subquery generator, `OUTPUT`/`MERGE`, OFFSET/FETCH,
named-param driver, `SAVE TRANSACTION` divergence) for the smallest overlap with
Turbine's Postgres-native audience. The right posture is: ensure the Phase-0
contract *can* express MSSQL (capability flags + relation-subquery override hook)
so the door is open, but do not spend the 5–8 weeks until an enterprise user
commits. If forced to choose, the resources are better spent deepening Postgres.

---

## Strategic Framing — when (if ever) to prioritize multi-dialect

The product review concluded Turbine's **moat is focus**: the Postgres "safety
bundle" (typed errors E001–E016, single-query nested relations, parameterized-by-
construction SQL, RLS/`set_config`, pgvector, LISTEN/NOTIFY, streaming cursors,
one dependency). Multi-dialect is *centrifugal* — it spreads effort across engines
and, done carelessly, makes Turbine "a worse Prisma" instead of "the best Postgres
ORM." Several of the highest-value features (pgvector, LISTEN/NOTIFY, RLS) **do not
port at all**, so multi-dialect necessarily ships a thinner product on MySQL/MSSQL.

**Recommended trigger — do not start until ALL of:**
1. **Post-1.0.** The Postgres API and the dialect/driver seams are stable; you are
   no longer changing the contract weekly. Multi-dialect on a moving contract
   triples the churn.
2. **Demonstrated pull, not push.** A credible volume of *real* users explicitly
   ask — concretely: **≥ ~15–20 distinct inbound requests** (issues/Discord/sales)
   naming SQLite or MySQL, or a specific paying customer blocked on it. Build for
   demand you can see, not demand you imagine.
3. **The Postgres bundle is "done enough"** that an engineer-month spent elsewhere
   is not stealing from a higher-ROI Postgres feature.

**The one exception worth pulling forward: SQLite for testing/demos.** Even before
the trigger, a `node:sqlite` engine has internal leverage — it gives Turbine an
in-process test database and a zero-friction "try it now" onboarding, which
*strengthens* the Postgres story rather than diluting it. If any multi-dialect work
starts early, it should be SQLite, scoped explicitly as "the test/edge engine,"
with MySQL/MSSQL held behind the full trigger.

**Bottom line:** keep deepening Postgres until 1.0 + visible demand; land the
Phase-0 seam opportunistically (it also cleans up `client.ts`/`builder.ts`); ship
SQLite when it helps your own tests; ship MySQL when users pull it; ship MSSQL only
when an enterprise pays for it.
