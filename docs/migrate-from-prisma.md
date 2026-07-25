# Migrating from Prisma

Turbine is a Postgres-native TypeScript ORM with a Prisma-inspired API. Moving from Prisma is mostly a rename plus a re-pointed import.

**The full, maintained guide lives at [turbineorm.dev/migrate-from-prisma](https://turbineorm.dev/migrate-from-prisma).** It has the complete API mapping, side-by-side examples, schema translation, the `doctor`-first index step, cursor semantics, and the connection-URL note. This file is a short pointer so the two copies don't drift.

## Automated name mapping: `turbine migrate-from-prisma`

> Proposal note (phase 1). This section documents the new command; the canonical
> user-facing guide lives on the site migration page, which is being restructured
> in the same release.

Instead of hand-transcribing every model, run:

```bash
# resolve names against your live database
DATABASE_URL=postgres://... npx turbine migrate-from-prisma --schema prisma/schema.prisma

# or a database-free preflight (parse only, no resolution)
npx turbine migrate-from-prisma --schema prisma/schema.prisma --no-db
```

It parses your `schema.prisma` (a zero-dependency parser: models, `@map`/`@@map`,
relations including implicit m2m junctions, `@@unique` including named selectors,
and `@@id`) and writes two files into the generate output directory (`--out`,
default `./generated/turbine`):

- **`prisma-migration-report.md`**: every Prisma model mapped to its Turbine table
  and `db.<accessor>`, with per-field, per-relation, and compound-unique mappings,
  the implicit m2m junction tables, a many-to-many audit list pairing each Prisma
  field name with its Turbine relation name, and an explicit list of anything UNRESOLVED (a
  model that matches several candidate tables is reported, never guessed; add an
  `@@map` to disambiguate). It closes with the Prisma-vs-Turbine behavior notes
  (cursor exclusivity, `_count` shape, unordered relation arrays, the `sslmode` URL
  recommendation).
- **`prisma-map.ts`**: a typed `PRISMA_MAP` name map (`import type { PrismaCompatMap }
  from 'turbine-orm'`) covering models, fields, relations (with cardinality), and
  compound-unique selector names, including custom `@@unique(name:)` names. Feed it to
  hand-written compatibility wrappers now, or to the phase-2 `turbine-orm/prisma-compat`
  runtime adapter.

Flags: `--no-db` (parse-only, no database), `--allow-partial` (exit 0 even with
unresolved items), `--no-timestamp` (reproducible output). Within this command
`--schema` names the Prisma **file**, not the Postgres namespace (which is `public`);
multi-schema (`@@schema`) is not resolved in v1 and is noted in the report.

**Connection string.** The command uses, in order: `--url`, then `DATABASE_URL`,
then `url` in `turbine.config.ts`, then the `datasource` block in the schema you
pointed it at, including its `env("...")` indirection. So a project whose schema
declares `url = env("DATABASE_URL_STAGING")` needs no flag as long as that
variable is exported. If none of them yields a URL, the error names the variable
the datasource asked for.

### Auditing your many-to-many call sites

Turbine relation names and Prisma field names are different names for the same
relation, related only through `PRISMA_MAP`. An audit that greps the Turbine name
(`grep -rn "manyToMany" generated/`, then searching your code for the relation
names it prints) finds nothing in application code written against the compat
client, and reports a clean bill of health that is not real.

You do not need a recipe for this: the report's **"Many-to-many relations (audit
these call sites)"** section lists every m2m relation with BOTH names and the
junction table, and ends with a ready-to-run `grep` over the Prisma field names.
Run that grep, and review every write whose `data` nests one of those fields.

## API mapping

## The lexical diff

- `include:` becomes `with:`
- `skip:` becomes `offset:`
- `take:` works as-is at the top level (it is an alias for `limit`); inside a nested `with` block, the per-relation cap is spelled `limit:`

## Feature parity

These are all supported today, so don't infer absence from a missing example:

- **Nested writes** — `create` / `connect` / `connectOrCreate` on create, plus `disconnect` / `set` / `delete` / `update` / `upsert` on update, in one transaction (depth cap 10). On a **many-to-many** relation the supported set is `connect` / `disconnect` / `set` (Turbine writes the junction rows); the rest throw `ValidationError` (`TURBINE_E003`) naming that set. The compat client also exposes an accessor per implicit junction table, so link rows can be written by hand inside the same `$transaction`.
- **Relation `_count`** — `with: { _count: { posts: true } }` counts to-many relations without loading them.
- **`distinct`** — compiles to `DISTINCT ON`.
- **`cursor`** — keyset pagination (exclusive; drop any `skip: 1`).
- **Deterministic pages**: a compat `findMany` with `take` / `skip` and no `orderBy` is ordered by the model's primary key ascending, as Prisma does, so ported pagination cannot repeat or skip a row. Core keeps the bare `LIMIT` unless you set `implicitPkOrdering: true`.
- **`groupBy`** and **`aggregate`** — `_count` / `_sum` / `_avg` / `_min` / `_max`.
- **Typed raw SQL** — `` db.raw`...` `` and the typed `` db.sql<T>`...` `` (Prisma's TypedSQL replacement).

Before you benchmark, run `npx turbine doctor --fix` to add the foreign-key indexes Prisma leaves off — see the [canonical guide](https://turbineorm.dev/migrate-from-prisma) for why this is the one mandatory step.
