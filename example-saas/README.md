# example-saas: Project Management Tool

DX validation project for `turbine-orm`. This is a fake SaaS app (mini Linear/Jira)
that exercises every feature of the Turbine ORM to validate the developer experience
before npm publish.

## What this tests

- Schema definition with `defineSchema()`
- CRUD operations (create, findUnique, findMany, update, delete, upsert)
- Nested queries via `with` (L2, L3, L4 nesting depth)
- Filtering with operators (gt, lt, in, contains, startsWith)
- JSONB and array column filters
- Relation filters (some/every/none)
- Aggregations (count, groupBy, aggregate)
- Transactions ($transaction with typed accessors, nested savepoints)
- Pipeline batching (multiple queries in one round-trip)
- Middleware ($use for logging, timing, soft-delete)
- Select/omit field projection
- Raw SQL via tagged template literals
- Cursor-based and offset-based pagination

## Structure

```
example-saas/
  package.json
  tsconfig.json
  turbine/
    schema.ts            # defineSchema() definition
    migrations/
      001_initial.sql    # CREATE TABLE statements
    seed.ts              # Realistic fake data
  src/
    generated/           # What turbine generate would produce
      index.ts
      types.ts
      metadata.ts
    index.ts             # Main demo script exercising all features
  DX-REPORT.md           # Honest assessment of the developer experience
```

## Running

This is a DX validation project — the code is written to be realistic and correct
but does not need an actual database connection to validate the API surface.

```bash
npm install
npm run typecheck    # Validate all types compile
npm run start        # Would run the demo (needs DB)
npm run seed         # Would seed fake data (needs DB)
```
