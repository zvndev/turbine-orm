# Turbine DX Report

Honest assessment of the @batadata/turbine developer experience, written from the
perspective of a TypeScript developer building a project management SaaS (mini Linear/Jira).

**Date:** 2026-03-26
**Turbine Version:** 0.2.0
**Schema:** 5 tables, 4 levels of nesting, JSONB + array columns

---

## 1. Setup Experience

### What went well

- **Client factory pattern is clean.** `turbine({ connectionString })` is exactly what
  developers expect. No ceremony, no boilerplate.

- **`turbine generate` output is excellent.** The generated client gives you typed table
  accessors (`db.teams`, `db.tasks`) with full IntelliSense. This is the gold standard
  set by Prisma, and Turbine matches it.

- **Pool configuration is sensible.** Defaults (poolSize: 10, idle timeout: 30s) are
  production-ready. The `db.stats` accessor is a nice touch for monitoring.

- **Connection verification via `db.connect()`** is explicit and clear.

### Friction points

- **No `turbine init` command** to scaffold the directory structure. A new user has to
  manually create `turbine/schema.ts`, `turbine/migrations/`, and figure out the
  generated client directory. Compare to `prisma init` which creates everything.

- **`defineSchema()` cannot express array columns** (e.g., `TEXT[]`). The `ColumnTypeName`
  union has no array variant. In a real SaaS, array columns for tags/labels are extremely
  common. You have to fall back to raw SQL migrations and rely on introspection to pick
  up the array type. This means the schema definition and the actual database can diverge.

- **No enum support in `defineSchema()`.** Postgres enums are common for status/role
  fields. The schema builder only supports plain types, so you end up using `TEXT` with
  application-level validation.

- **The relationship between `turbine/schema.ts` and `turbine generate` is unclear.**
  The generate command seems to introspect the live database, not read the schema file.
  So what is the schema file actually for? Migration generation? Documentation? This
  needs to be clarified in docs.

---

## 2. Query API

### What feels natural

- **`findUnique` / `findMany` / `create` / `update` / `delete`** -- these are exactly
  what Prisma and Drizzle users expect. Zero learning curve.

- **`where` clause operators** (`gt`, `lt`, `in`, `notIn`, `contains`, `startsWith`,
  `endsWith`) are well-chosen and match Prisma's API. The `not` operator for exclusion
  is useful.

- **`OR` / `AND` / `NOT` compound filters** work as expected in the where clause.

- **`createMany` with UNNEST** is a nice performance optimization. Most ORMs use
  multi-row INSERT which is slower at scale.

- **`upsert`** with separate `create` and `update` data -- clean API that matches Prisma.

- **`updateMany` / `deleteMany` returning `{ count }` instead of the full rows** is a
  sensible default for bulk operations.

### What feels awkward

- **No `findFirst()` method.** This is the most common query pattern in real apps ("find
  the first matching row"). You have to write `findMany({ limit: 1 })[0]` which is
  verbose and semantically unclear. Prisma has `findFirst` and it's probably the most
  used method after `findMany`.

- **No `findUniqueOrThrow()` / `findFirstOrThrow()`.** In request handlers, you almost
  always want to throw a 404 if the record is missing. Having to write
  `const team = await db.teams.findUnique(...); if (!team) throw new NotFoundError()`
  on every route is tedious.

- **`count()` returns `number` but `groupBy()` returns `Record<string, unknown>[]`.**
  The groupBy result type is too loose. You get raw `unknown` values and have to cast.
  Prisma returns strongly-typed group results. This makes groupBy results awkward to
  work with in TypeScript.

- **`aggregate()` result structure is nested.** The `_sum`, `_avg` etc. are nested
  objects which matches Prisma but feels unnecessary for single-table aggregation. Minor
  issue.

---

## 3. Nested Queries (The Killer Feature)

### What's great

- **The `with` clause is genuinely elegant.** `with: { tasks: true }` to load all tasks
  for a project in a single SQL query via json_agg is the best DX for eager loading I've
  seen. No N+1, no manual joins, just declare what you want.

- **Nested filtering and ordering.** Being able to do
  `with: { tasks: { where: { status: 'active' }, orderBy: { createdAt: 'desc' } } }`
  is powerful. You can filter and sort at each nesting level.

- **L4 nesting works.** `team -> projects -> tasks -> comments` with author data at the
  leaf level compiles and generates correct SQL. This is the main selling point and it
  delivers.

- **Single SQL query** for arbitrary nesting depth. No waterfall of queries. This is
  what makes Turbine faster than Prisma for nested reads.

### What needs work

- **Return types for nested queries require manual casting.** When you use `with`,
  TypeScript does not automatically infer the nested shape. You have to define separate
  interfaces (`TeamWithMembers`, `TeamWithEverything`) and cast:
  ```ts
  const team = await db.teams.findUnique({ where: { id: 1 }, with: { members: true } });
  const twm = team as unknown as TeamWithMembers;
  ```
  This is the biggest DX gap compared to Prisma, where the return type automatically
  includes the nested relations based on the `include` argument. Fixing this requires
  conditional types on the `with` clause shape.

- **No `include` alias for `with`.** Prisma users will instinctively type `include:`
  and get a type error. Consider supporting both or at least documenting the difference.

- **Nested writes are not supported.** You cannot do:
  ```ts
  await db.teams.create({
    data: {
      name: 'Acme',
      members: { create: [{ email: 'a@b.com', name: 'Alice' }] },
    },
  });
  ```
  This is a significant gap. In a real SaaS, creating parent + children in one call is
  extremely common. Currently you must use `$transaction` for atomicity, which is more
  verbose.

- **`select` / `omit` in nested relations** is supported in the `WithOptions` type but
  it is not clear whether the SQL generation actually handles it. The type says yes, but
  it would need testing.

---

## 4. Transactions

### What's great

- **`$transaction` with typed table accessors** is the right API. The `tx` object gives
  you the same `.teams`, `.tasks` etc. as the main client. No loss of type safety inside
  transactions.

- **Nested transactions via SAVEPOINTs** work correctly. This is a feature many ORMs
  skip, and it's valuable for complex business logic where inner operations can fail
  without rolling back everything.

- **Isolation levels and timeouts** are supported as options. Good for when you need
  serializable reads or want to prevent runaway transactions.

- **`tx.raw()` inside transactions** works, which is important for escape hatches.

### Minor issues

- **No sequential transaction API** (Prisma's `$transaction([query1, query2])` array
  syntax). This is less flexible than the callback API but sometimes simpler for
  independent operations that just need atomicity.

---

## 5. Pipeline

### What's great

- **The concept is excellent.** Batching 5 independent queries into 1 round-trip with
  `db.pipeline(q1, q2, q3, q4, q5)` is a genuine performance feature. The API is clean
  and the tuple return type preserves individual query types.

- **`.build*()` methods on every query type** make it composable. You can build a
  deferred query from any table accessor and pass it to the pipeline.

### What needs work

- **Cannot use `with` (nested queries) inside pipelines.** This limits the usefulness
  for the exact scenario where you'd want batching -- loading a dashboard with multiple
  nested data sources. This is because nested queries produce more complex SQL that the
  pipeline executor would need to handle.

- **No automatic batching.** Unlike Prisma's `$transaction` array form or DataLoader,
  there's no way to have the client automatically batch queries that happen in the same
  tick. You have to explicitly use `pipeline()`. For request handlers where multiple
  services each make queries, this means the developer has to restructure their code.

---

## 6. Middleware

### What's great

- **The `$use` API matches Prisma exactly.** Developers familiar with Prisma middleware
  will be immediately productive.

- **The `params` object exposes `model`, `action`, and `args`**, which is everything you
  need for logging, timing, soft-delete, multi-tenancy, and other cross-cutting concerns.

- **Middleware stacking works correctly.** Multiple middlewares execute in order.

### What could be better

- **No way to remove or disable a middleware** once registered. In testing, you might
  want to disable the timing middleware. Consider returning an unsubscribe function from
  `$use()`.

- **Middleware runs on the query level, not the SQL level.** You cannot inspect or modify
  the generated SQL. For debugging, it would be helpful to have access to the actual SQL
  being executed.

---

## 7. Raw SQL

### What's great

- **Tagged template literals with automatic parameterization.** This is the right API.
  `db.raw\`SELECT * FROM users WHERE id = ${userId}\`` is safe, readable, and familiar.

- **Generic return type parameter** `db.raw<{ name: string; count: number }>` gives type
  safety on the result without runtime overhead.

### What could be better

- **No `$queryRaw` / `$executeRaw` distinction.** Prisma separates queries that return
  rows from those that don't (INSERT/UPDATE/DELETE). Turbine's `raw()` always returns
  rows, which means `INSERT ... RETURNING *` works but plain `INSERT` returns an empty
  array. This is fine but should be documented.

---

## 8. Comparison to Prisma/Drizzle

| Feature | Turbine | Prisma | Drizzle |
|---------|---------|--------|---------|
| Nested eager loading | Single json_agg query | N+1 or batch | Manual joins |
| Type inference on includes | Manual casting needed | Automatic | Manual |
| Schema definition | `defineSchema()` objects | `.prisma` DSL | TypeScript |
| Migration generation | From live DB | From schema diff | From schema diff |
| Pipeline batching | Explicit `pipeline()` | `$transaction([])` | No equivalent |
| Middleware | `$use()` | `$use()` | No equivalent |
| Transactions | `$transaction(fn)` | Same | `db.transaction(fn)` |
| Raw SQL | Tagged templates | Tagged templates | `sql\`\`` |
| Array/JSONB filters | Supported | Supported | Manual |
| Nested writes | Not supported | Supported | Not supported |
| `findFirst` | Not available | Available | `.limit(1)` |
| Type-safe return | Partial (no `with` inference) | Full | Full |

### Where Turbine wins

1. **Performance on nested reads.** Single json_agg query vs N+1 is a real,
   measurable advantage. For dashboard-style pages that load parent + children +
   grandchildren, Turbine should be significantly faster.

2. **Pipeline batching.** No other TypeScript ORM has this as a first-class feature.
   For microservice backends making many independent queries per request, this reduces
   latency.

3. **createMany with UNNEST.** Batch inserts are faster than multi-row INSERT.

### Where Turbine needs to catch up

1. **Type inference on nested queries.** This is the number one DX issue. Having to
   manually define `TeamWithMembers` and cast is a dealbreaker for some developers.

2. **Nested writes.** Creating parent + children in one call is table stakes for an ORM.

3. **`findFirst` / `findFirstOrThrow`.** These are the most commonly used query methods
   in real applications.

4. **Schema definition completeness.** No array types, no enums, no onDelete cascade.
   The schema definition feels like an afterthought compared to the query engine.

---

## 9. Suggested Improvements (Priority Order)

### P0 -- Must fix before npm publish

1. **Add `findFirst()` and `findFirstOrThrow()`.**
   Trivial to implement: `findFirst` = `findMany({ ...args, limit: 1 })[0]`.

2. **Add `findUniqueOrThrow()`.** Same pattern, throws if null.

3. **Document the relationship between schema.ts and turbine generate.** Users need to
   know whether to define schema in TypeScript or rely on introspection.

### P1 -- Should fix soon after launch

4. **Automatic return type inference for `with` clause.** Use conditional types:
   ```ts
   type FindUniqueResult<T, W extends WithClause | undefined> =
     W extends undefined ? T :
     T & { [K in keyof W]: /* inferred relation type */ };
   ```
   This is the single biggest DX improvement possible.

5. **Add `findFirst()` support.** (If not done in P0.)

6. **Add array column type to defineSchema.** Something like `{ type: 'text[]' }` or
   `{ type: 'text', array: true }`.

7. **Add enum support to defineSchema.** Either inline enums or a separate `defineEnum`.

### P2 -- Nice to have

8. Add `include` as an alias for `with`.
9. Add nested writes (`create` / `connect` / `connectOrCreate` in data).
10. Add `onDelete` cascade/setNull/restrict to schema definition.
11. Return unsubscribe function from `$use()`.
12. Add `$queryRaw` / `$executeRaw` distinction.
13. Add automatic batching (DataLoader-style) as an opt-in feature.

---

## 10. Overall Verdict

**Turbine is ready for early adopters but not for a broad npm launch.**

The core query engine is impressive -- json_agg nested queries, pipeline batching, and
the middleware system are genuine differentiators. The API surface is well-designed and
will feel familiar to Prisma users.

However, the type inference gap on nested queries is a significant DX regression compared
to Prisma. Developers who choose an ORM primarily for type safety will be disappointed
when they have to manually cast nested results. This single issue should be the top
priority before launch.

The schema definition system needs array and enum support to handle real-world schemas.
Without these, developers will have a mismatch between their `defineSchema()` and their
actual database, which undermines the "schema as code" value proposition.

For a 0.2.0 release targeting early adopters who value performance over DX polish,
Turbine is viable. For a 1.0 release targeting Prisma migration, the type inference and
schema definition gaps need to be closed first.

**Score: 7/10** -- Strong foundation, needs DX polish on types and schema.
