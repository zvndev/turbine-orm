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
  the implicit m2m junction tables, and an explicit list of anything UNRESOLVED (a
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

## API mapping

## The lexical diff

- `include:` becomes `with:`
- `skip:` becomes `offset:`
- `take:` works as-is at the top level (it is an alias for `limit`); inside a nested `with` block, the per-relation cap is spelled `limit:`

## Feature parity

These are all supported today, so don't infer absence from a missing example:

- **Nested writes** — `create` / `connect` / `connectOrCreate` on create, plus `disconnect` / `set` / `delete` / `update` / `upsert` on update, in one transaction (depth cap 10).
- **Relation `_count`** — `with: { _count: { posts: true } }` counts to-many relations without loading them.
- **`distinct`** — compiles to `DISTINCT ON`.
- **`cursor`** — keyset pagination (exclusive; drop any `skip: 1`).
- **`groupBy`** and **`aggregate`** — `_count` / `_sum` / `_avg` / `_min` / `_max`.
- **Typed raw SQL** — `` db.raw`...` `` and the typed `` db.sql<T>`...` `` (Prisma's TypedSQL replacement).

Before you benchmark, run `npx turbine doctor --fix` to add the foreign-key indexes Prisma leaves off — see the [canonical guide](https://turbineorm.dev/migrate-from-prisma) for why this is the one mandatory step.
