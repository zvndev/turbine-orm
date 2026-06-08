# Turbine ORM — Correctness Parity Harness

Proves that **Turbine returns results identical to Prisma 7 and Drizzle** across a
matrix of query scenarios, all run against the *same* deterministically-seeded
PostgreSQL dataset. This is the project's #1 trust artifact: it demonstrates that
Turbine's single-query `json_agg` strategy produces the same data as two
battle-tested incumbents.

## What it does

1. Connects Turbine, Prisma 7 (`@prisma/adapter-pg`), and Drizzle (`node-postgres`)
   to the same database.
2. Runs each scenario through all three ORMs.
3. **Normalises** every result into a comparison-safe canonical form
   (`normalize.ts`): camelCase keys, `bigint → number`, dates → canonical ISO
   instant, arrays sorted by primary key, ORM-specific extra keys stripped.
4. `assert.deepEqual`s **Turbine vs Prisma** and **Turbine vs Drizzle** for each
   scenario.
5. Prints a per-scenario PASS / FAIL matrix and **exits non-zero** if anything
   diverges.

## Running it

A local PostgreSQL 16 must be reachable. Create a dedicated DB so you don't
disturb the benchmark/seed data:

```bash
export PATH="/usr/local/opt/postgresql@16/bin:$PATH"
createdb turbine_parity
export DATABASE_URL="postgres://$USER@localhost:5432/turbine_parity"

cd benchmarks
npx prisma generate          # once — generates the Prisma client from prisma/schema.prisma

# Seed the small deterministic dataset, then run the matrix:
npm run parity
```

`npm run parity` is `tsx parity/seed.ts && tsx parity/run.ts`. You can also run the
two steps separately:

```bash
npx tsx parity/seed.ts       # 4 orgs / 20 users / 100 posts / 300 comments
npx tsx parity/run.ts        # the comparison matrix
```

Exit code `0` = full parity; non-zero = at least one mismatch (details printed).

## The dataset

`seed.ts` loads a **small, fully deterministic** fixture — parity needs
determinism, not scale:

- 4 organizations, 20 users, 100 posts (5/user), 300 comments (3/post)
- All `created_at` / `updated_at` / `last_login_at` values are pinned to fixed
  timestamps (no `NOW()`), so ordering and ISO normalisation are reproducible.
- Data is deliberately varied so the scenarios hit distinct branches: roles cycle
  `admin/editor/member`; names mix case (so `mode: 'insensitive'` differs from the
  default); some `avatar_url` / `last_login_at` are `NULL`; `view_count` spreads
  across `0..495`; `published` alternates.

## Scenario matrix

| Group       | Scenarios |
|-------------|-----------|
| findMany    | flat users, flat posts |
| findUnique  | user by PK, post by PK |
| nested      | depth 1 (users→posts), depth 2 (→comments), depth 3 (→author back-ref), belongsTo (post→user), nested orderBy+limit |
| where       | equals, not, null, in, notIn, gt, gte/lte, lt, contains, startsWith, endsWith, contains-insensitive, AND, OR, NOT |
| orderBy     | asc+limit, desc+limit, plus ordered-**sequence** assertions (prove ORDER BY emits the same row order, not just the same set) |
| pagination  | limit + offset |
| count       | all rows, filtered |
| aggregate   | sum / avg / min / max, filtered sum |

All scenarios are supported by all three ORMs. None are Turbine-only in the current
matrix.

## Known incumbent divergences (normalised, not Turbine bugs)

These are documented in `run.ts` / `normalize.ts` at the point they're handled.

1. **Prisma + `@prisma/adapter-pg` timestamptz offset.**
   This machine's Postgres runs with `timezone = America/New_York`. For
   `TIMESTAMPTZ` columns, Turbine (node-postgres) and Drizzle (node-postgres) both
   decode the value to the correct absolute instant regardless of session timezone
   — e.g. `2025-01-01 08:47:00-05` → `2025-01-01T13:47:00.000Z`.
   Prisma's driver adapter instead renders the *wall-clock* time and labels it
   UTC, yielding `…T08:47:00.000Z` (off by the session offset). **Turbine's instant
   is the correct one.** To compare data rather than this Prisma rendering
   artifact, the Prisma and Drizzle pools pin `SET timezone = UTC` (so wall-clock
   == UTC and all three agree). Turbine uses its own native pool and needs no pin.

2. **Turbine nested-relation date columns come back as strings, not `Date`.**
   Top-level rows get `Date` coercion; relation rows hydrated through
   `json_build_object` arrive as PG JSON timestamp strings (e.g.
   `2025-01-02T04:41:00+00:00`). This is a *cosmetic inconsistency* in Turbine
   (same instant, different JS type/format), not a data error. `normalize.ts`
   collapses any ISO-8601 timestamp string and any `Date` to one canonical
   `toISOString()` instant before comparing, so genuine instant differences are
   still caught (verified). **Flagged for the PM as a minor consistency
   nit — not fixed here (parity harness must not edit `src/`).**

3. **bigint representation.** Prisma returns `BIGINT` PKs/FKs as JS `bigint`;
   Turbine and Drizzle return `number`. Normalised to `number` everywhere.

4. **Aggregate shape.** Turbine and Prisma both return
   `{ _sum: { viewCount }, _avg, _min, _max }`. Drizzle has no aggregate sugar, so
   the harness builds the equivalent with raw `sum()/avg()/min()/max()` selects and
   reshapes to the same object. Drizzle returns `numeric` aggregates as strings and
   Prisma/Turbine return `avg` as a float; all are coerced to numbers and `avg` is
   compared rounded to 6 decimal places.

## Files

- `seed.ts` — deterministic schema + data loader.
- `normalize.ts` — canonicalisation helpers (`canon`, `rows`, `row`, `tree`, `pick`).
- `run.ts` — scenario definitions, runner, and PASS/FAIL matrix.
