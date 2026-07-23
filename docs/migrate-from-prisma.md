# Migrating from Prisma

Turbine is a Postgres-native TypeScript ORM with a Prisma-inspired API. Moving from Prisma is mostly a rename plus a re-pointed import.

**The full, maintained guide lives at [turbineorm.dev/migrate-from-prisma](https://turbineorm.dev/migrate-from-prisma).** It has the complete API mapping, side-by-side examples, schema translation, the `doctor`-first index step, cursor semantics, and the connection-URL note. This file is a short pointer so the two copies don't drift.

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
