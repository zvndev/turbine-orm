# Next Integrations — database dialect expansion plan

**Status:** planning, post-v1.0
**Owner:** core
**Date:** 2026-04-14

Turbine is PostgreSQL-only today. That's intentional — depth over breadth was the right call for v0.x. Post-v1.0 we want to expand, but only to dialects where:

1. The architectural fit is **real**, not forced.
2. We can preserve the "one runtime dep" story per dialect (no engine binary, no WASM).
3. There's a large enough audience of TypeScript devs who'd pick us *over* Prisma or Drizzle on that dialect.

This doc inventories what Prisma and Drizzle support, then ranks candidates for Turbine.

---

## What the competition supports

### Prisma (7.x)

| Database | Support tier | Notes |
|---|---|---|
| PostgreSQL | GA | Primary target. `relationLoadStrategy: "join"` uses json_agg. |
| MySQL | GA | Full feature parity minus a few Postgres-specific types. |
| MariaDB | GA (via MySQL) | Treated as MySQL. |
| SQLite | GA | For dev + embedded. No json_agg equivalent — multi-query nested loads. |
| SQL Server | GA | Adapter-based; slower-moving. |
| MongoDB | GA (preview-graduated) | Hybrid — ORM semantics forced onto documents. Controversial. |
| CockroachDB | GA | Postgres wire-compat. Uses the Postgres driver. |
| PlanetScale (Vitess) | Via adapter | HTTP-based MySQL. |

Prisma's strategy is "every database, same DSL." Result: the DSL can't express dialect-specific features cleanly (`jsonb` operators, CockroachDB `AS OF SYSTEM TIME`, etc.) and each dialect's feature support varies.

### Drizzle (0.45)

| Database | Support tier | Notes |
|---|---|---|
| PostgreSQL (`drizzle-orm/pg-core`) | GA | Primary. Relational queries use json_agg. |
| MySQL (`drizzle-orm/mysql-core`) | GA | Uses `JSON_ARRAYAGG` for relational queries. |
| SQLite (`drizzle-orm/sqlite-core`) | GA | Uses `json_group_array`. |
| + 20+ driver adapters | GA | Neon, Vercel, PlanetScale, Turso, D1, Supabase, Xata, Bun-SQLite, better-sqlite3, `pg`, `postgres`, mysql2, etc. |

Drizzle's strategy is "three core dialects + any driver." Each dialect is a separate package with its own schema builder and query builder. Duplicative, but each dialect feels native.

### The decision framework it implies for us

**Prisma's approach (one DSL, many DBs):** low per-dialect engineering, but everything compromises toward the lowest common denominator. We already rejected this implicitly by not having a DSL.

**Drizzle's approach (one API surface, three native cores):** high per-dialect engineering, but each dialect is first-class. This is what we should copy — as a `turbine-orm/mysql` or `turbine-orm/sqlite` subpath export, not a dialect flag.

---

## Candidate ranking for Turbine

### Tier 1 — strong architectural fit, ship next

#### 1. **CockroachDB** — closest to free

- **Wire protocol:** Postgres v3, already compatible with `pg`.
- **SQL dialect:** Postgres-compatible, supports `json_agg` + `json_build_object`.
- **Work needed:** low. Mostly caveats to document — CRDB's `SERIAL` is not auto-increment, SAVEPOINT nesting has edge cases, `SELECT ... FOR UPDATE` semantics differ under the retryable serializable isolation.
- **Audience:** teams doing multi-region Postgres-compatible. Small but distinct from Neon.
- **Estimated effort:** 1 engineer-week (compat testing + docs), mostly no code change.
- **Branding:** "turbine-orm works with CockroachDB" — no new package, just a docs page and `cockroachdb.test.ts`.

#### 2. **MySQL / MariaDB** — biggest audience, largest engineering cost

- **Wire protocol:** `mysql2` driver, not `pg`. Distinct binary protocol.
- **SQL dialect:** `JSON_ARRAYAGG` + `JSON_OBJECT` (not `json_agg` + `json_build_object`). Backtick-quoted identifiers (not double-quotes). `?` parameters (not `$1`). `LIMIT ?, ?` for offset (not `OFFSET`). Different type system (no arrays, different JSON semantics, no `citext`, different `ENUM`).
- **Work needed:** high. New `query-mysql/` submodule mirroring `query/builder.ts`, new `quoteIdent` (backticks), new type mapping, new introspect (MySQL `information_schema` has different columns), new migrations table schema.
- **Audience:** huge. Most non-Postgres TypeScript teams are on MySQL (often via PlanetScale).
- **Estimated effort:** 4–6 engineer-weeks.
- **Branding:** `turbine-orm/mysql` subpath export with `turbineMysql(pool, schema)` factory. Shared `defineSchema()` DSL with dialect-tagged column types.

### Tier 2 — defensible but secondary

#### 3. **SQLite (better-sqlite3 / bun:sqlite / libsql/Turso)**

- **Wire protocol:** embedded, no wire. Or libsql's HTTP for Turso.
- **SQL dialect:** `json_group_array` + `json_object`. Permissive types. Limited ALTER TABLE.
- **Work needed:** medium. New query submodule but the SQL is closer to Postgres than MySQL is. Embedded means no pool; needs a different `PgCompatPool` contract.
- **Audience:** local dev, edge with Turso, Electron/Tauri apps, tests.
- **Estimated effort:** 3 engineer-weeks.
- **Branding:** `turbine-orm/sqlite` subpath, `turbineSqlite(db, schema)` for embedded, `turbineTurso(client, schema)` for HTTP.
- **Strategic note:** This is the single best win for **internal test ergonomics** — CI could run every unit test against SQLite for speed, then re-run a subset against Postgres for SQL-specific correctness.

### Tier 3 — skip unless a customer asks

#### 4. **SQL Server / Azure SQL**

- **Wire protocol:** TDS. Completely different from Postgres.
- **SQL dialect:** `FOR JSON PATH` aggregation (very different shape). `@p1` parameters. `[bracket]` identifiers. TOP vs LIMIT.
- **Work needed:** very high. Essentially a from-scratch backend.
- **Audience:** enterprise. Overlaps heavily with TypeORM's existing user base.
- **Verdict:** **skip.** Engineering cost is 2x MySQL, audience for "ORM on SQL Server" is already captured by TypeORM + Sequelize. We won't win here.

#### 5. **MongoDB**

- **Verdict:** **hard skip.** Mapping SQL semantics onto documents is a philosophical mistake. If users want MongoDB they want MongoDB's query model, not Turbine's.

### Tier 4 — declined, explicit

#### 6. **PowDB**

We evaluated this in April 2026. Outcome: **declined for now**, revisit when PowDB ships its PG-wire-protocol compatibility layer.

**Why declined:**

- PowDB uses a custom binary wire protocol (not Postgres v3) — the `pg` driver cannot connect.
- PowDB uses PowQL (pipeline DSL), not SQL — turbine-orm's entire SQL-generation layer doesn't apply.
- PowDB lacks `json_agg` / `json_build_object` — the primitive our relation loader is built on.
- PowDB lacks `information_schema` / `pg_catalog` — our introspect layer has no catalog to read.
- PowDB lacks `RETURNING`, SAVEPOINTs, `pg_try_advisory_lock` — no `$transaction` nesting, no migration lock.

Adding PowDB support today would not be "adding a dialect" — it would be writing a second ORM that happens to share a name, built against PowQL, with a re-implemented relation loader that doesn't have `json_agg` to lean on.

**What would change our mind:**

1. PowDB ships its planned Phase 3 Postgres-wire-protocol compat layer *with* a SQL parser that translates to PowQL.
2. PowDB adds a single-query nested-relation primitive (json_agg-equivalent or native pipeline nesting).
3. PowDB exposes `information_schema`-compatible views.

When those three ship, PowDB moves to Tier 1 alongside CockroachDB — the integration effort drops to "compat testing and docs."

**Alternative we recommend to the PowDB team:** build a PowQL-native TypeScript client with DX patterns mirrored from Turbine (see `USING-TURBINE-ORM.md` for the reference). Leaning into PowQL's pipeline model gets better ergonomics than forcing SQL abstractions onto it, and preserves PowDB's core thesis ("skip SQL translation overhead").

---

## Execution order (recommended)

```
v1.0 (Q2 2026):  Postgres (current). Ship v1.0 first. Don't gate on dialects.
v1.1 (Q3 2026):  CockroachDB — compat testing, docs page, CI job. 1 week.
v1.2 (Q3 2026):  SQLite — internal win first (speeds up CI), then external.
v1.3 (Q4 2026):  MySQL — the big expansion. Make or break for non-PG audience.
v1.4+:           Revisit PowDB if Phase 3 has shipped. Otherwise, hold.
```

**Do not ship all of these in parallel.** Each dialect added while we're still on 0.x dilutes the "Postgres-native, built for the edge" pitch. Ship v1.0 as Postgres-only. Then expand.

---

## Shared work that benefits every future dialect

Worth doing *before* any dialect work starts, because each of these reduces per-dialect effort:

1. **Extract a `DialectAdapter` interface** from `query/builder.ts` — identifier quoting, parameter placeholder, JSON aggregation builder, `LIMIT`/`OFFSET` clause, `RETURNING` support flag. Right now these are inlined.
2. **Parameterize the migration table schema** — MySQL and SQLite can't use `TIMESTAMPTZ`. Make `_turbine_migrations` a dialect-supplied DDL string.
3. **Split type mapping** — `schema.ts` bakes in the Postgres pg-to-TS map. Extract into `schema/postgres.ts`, `schema/mysql.ts`, etc.
4. **Test harness that takes a `DialectAdapter`** — today tests instantiate `QueryInterface` with a Postgres-quoted-identifier assumption. Parameterize so the same test suite runs against every dialect.

Estimate: 2–3 engineer-weeks of refactoring. Pays for itself by the second dialect.

---

## Decision

Ship v1.0 Postgres-only. Then CockroachDB (week), then SQLite (month), then MySQL (quarter). Skip MSSQL + Mongo. Revisit PowDB when PG-wire compat ships.
