---
name: turbine-orm
description: Use when writing or debugging Turbine ORM queries in TypeScript - covers the with clause, WHERE operators, relation filters, aggregates, groupBy having, pagination, JSON paths, and the errors each one throws
---

# Writing Turbine queries

Turbine is a Postgres-first TypeScript ORM with a Prisma-shaped API. If you know
Prisma, four differences account for most first-try failures, and they are the
first four sections here.

Every construct below is executed against a live database by
`evals/src/verify-skill.ts` in the turbine-orm repository, on every release. A
claim in this file that stops being true fails that check by name.

## 1. Relations are `with`, never `include`

```ts
const orders = await db.orders.findMany({
  select: { id: true, total: true },
  with: { customer: { select: { email: true } } },
});
```

`include` is Prisma's word. Written as a plain object literal TypeScript rejects
it, but that check does not apply to a spread (`findMany({ ...args })`) or to
JSON-shaped args, which is how generated and tool-driven code usually arrives.
On those paths it is ignored rather than refused: the query runs, returns rows,
and the relation is simply absent from every one of them. Since 0.73.0 it also
prints a dev-mode warning naming `with`; in production it is silent.

## 2. Relation names are derived, and not from the column

A relation name is not the foreign-key column, and not always the table name:

- **belongsTo** (the side holding the FK) is the target table, singularised and
  camelCased. `guild_id` on `cheese_wheels` gives the relation `guild`.
- **hasMany** (the side pointed at) is the child table, camelCased and left
  plural: `cheese_wheels` gives `cheeseWheels`.
- **manyToMany** across a junction is named for the FAR table, not the junction.
  With `wheel_cultures` joining `cheese_wheels` and `cultures`, the relation on
  `cheese_wheels` is `cultures`. The junction is *also* exposed as a plain
  hasMany (`wheelCultures`), and picking that one gives junction rows rather
  than the entities you wanted.

If a `turbine mcp` server is connected, `relation_graph` lists these names
exactly, and `find_join_path` returns the `with` clause to write. Read them
rather than deriving them.

## 3. Either spelling of a name works, and results are always camelCase

A column or relation may be written in the schema's `snake_case` or in the
generated `camelCase`, in every argument position, and the two produce identical
SQL. Results are always camelCase: `cave_humidity_pct` comes back as
`caveHumidityPct`.

Prefer camelCase, because that is what the generated types autocomplete and what
you will read back. A name that is neither spelling is a `ValidationError`
(`TURBINE_E003`) for a column, `RelationError` (`TURBINE_E005`) for a relation,
and the message suggests the closest real name.

## 4. `select` is columns only

`select` and `omit` name columns. Naming a relation in `select` throws
`TURBINE_E003` pointing at `with`; relations carry their own nested `select`.
`select` and `omit` together throw, and so does a `select` that names no field.

## Reads

| method | returns |
|---|---|
| `findMany` | `T[]` |
| `findFirst` / `findFirstOrThrow` | the first row matching an optional filter |
| `findUnique` / `findUniqueOrThrow` | one row addressed by a unique key |
| `count` | a `number` |
| `aggregate` | one row of aggregates |
| `groupBy` | one row per group |

`findUnique` requires a `where` that identifies a single row: a primary key, a
single-column unique, or every column of a compound unique. Anything else is
`TURBINE_E003` naming the keys that would work. Use `findFirst` for "any row
matching a filter", and give it an `orderBy` if you care which one.

## WHERE

A bare value means equality; `null` means `IS NULL`.

```ts
where: {
  status: 'graded',
  retiredAt: null,
  caveHumidityPct: { gte: 90, lte: 94 },
  rindStyle: { in: ['washed', 'waxed'] },
  givenName: { contains: 'Roux', mode: 'insensitive' },
  batchRef: { startsWith: 'WB-' },
  wheelCount: { not: 0 },
}
```

Operators: `equals`, `not`, `gt`, `gte`, `lt`, `lte`, `in`, `notIn`, `contains`,
`startsWith`, `endsWith`, plus `mode: 'insensitive'`. `AND`, `OR` and `NOT` nest
at any depth; `AND` and `OR` take arrays.

Values are always bound as parameters, and `contains` / `startsWith` /
`endsWith` escape LIKE wildcards for you. There is no code path in the typed API
that concatenates a value into SQL.

## Relation filters: `some` / `none` / `every`

Filter parents by their children without returning the children:

```ts
where: { cheeseWheels: { some: { status: 'quarantined' } } }
where: { ripeningChecks: { none: {} } }          // has no rows at all
where: { cheeseWheels: { every: { caveHumidityPct: { gte: 85 } } } }
```

These are filters, not projections: they add nothing to the result. To get the
children too, add a `with`.

## Per-relation options

Everything inside a `with` applies PER PARENT ROW, so `limit: 3` means three
children each, not three overall.

```ts
with: {
  affineurs: {
    select: { id: true },
    where: { isJourneyman: true },
    orderBy: { id: 'desc' },
    limit: 3,
    with: { cheeseWheels: { select: { id: true } } },   // nests to any depth
  },
}
```

## Ordering

`orderBy` takes an object or an array of objects; an array keeps its order as
tie breakers. Two special forms:

```ts
orderBy: [{ pressedOn: 'desc' }, { id: 'desc' }]
orderBy: { affineurs: { _count: 'desc' } }
orderBy: { tastingNotes: { path: ['panel', 'score'], direction: 'desc' } }
```

Without an `orderBy`, row order is undefined. A paginated query with no
`orderBy` is not just unordered, it is unstable: the same row can appear on two
pages or on none. Turbine warns about it in development.

## Pagination

`limit` and `offset`, with Prisma's `take` and `skip` accepted as aliases for
them. Passing both spellings of one bound with different values throws.

```ts
{ limit: 20, offset: 40 }      // the same query, written two ways
{ take: 20, skip: 40 }
```

For deep pages, prefer a `cursor` over a large `offset`.

## JSON columns

A `path` array walks the document, and combines with the normal operators:

```ts
where: { tastingNotes: { path: ['panel', 'score'], gte: 9 } }
where: { credentialBlob: { path: ['tier'], equals: 'master' } }
```

A path takes a DIFFERENT operator set from a plain column: `equals`, `gt`,
`gte`, `lt`, `lte`, `hasKey`, `contains`, `stringContains`, `stringStartsWith`,
`stringEndsWith`, plus `mode` (which applies to the three `string*` operators).
`contains` on a JSON column is containment (`@>`, a whole sub-document such as
`{ contains: { panel: { seats: 4 } } }`), NOT a substring test; the substring
operators on a path are `stringContains`, `stringStartsWith` and
`stringEndsWith`. `not`, `in`, `notIn`, `startsWith` and `endsWith` are refused
with `TURBINE_E003` listing the accepted set (the last two point at their
`string*` spelling); express `not` / `in` with `NOT` / `OR` around the path
filter instead.

`groupBy` accepts a JSON path as a grouping key via `{ field, path }`, and its
`_sum`, `_avg`, `_min` and `_max` accept the same `{ field, path }` object under
an alias key: `_sum: { score: { field: 'tastingNotes', path: ['panel', 'score'] } }`
comes back as `_sum.score`. `_sum` / `_avg` cast the value to numeric; `_min` /
`_max` compare as text unless `type: 'numeric'`. **`aggregate()` has no JSON-path
form**: every key there must be a column (anything else is `TURBINE_E003`) and
every value `true`; an object value is read as `true`, so the whole column
reaches the database as `avg(jsonb)` and fails there with a database error, not
a Turbine code. **`_count` never takes a path**, in `groupBy` or `aggregate()`:
an object under a `_count` key is read as `true` (a count of that column's
non-null values) and any path in it is ignored. To count per JSON value, group
by the path and read `_count`.

## Aggregates

```ts
await db.ripeningChecks.aggregate({
  where: { rindScore: { gte: 8 } },
  _avg: { aromaScore: true },
  _max: { aromaScore: true },
  _count: { id: true },
});
```

## groupBy and having

`by` lists the grouping columns. The `having` shape is **column first, aggregate
second**, which is the opposite of how it reads aloud:

```ts
await db.cheeseWheels.groupBy({
  by: ['rindStyle'],
  _count: { id: true },
  having: { id: { _count: { gt: 55 } } },
  orderBy: { rindStyle: 'asc' },
});
```

`having: { wheelCount: { _sum: { gt: 400 } } }` filters on a summed column. The
column named in `having` must be one you grouped by or aggregated.

## Unique lookups

For a single-column unique, name the column. For a compound unique, use the
joined selector whose value is an object of the parts, or pass the columns flat:

```ts
where: { guildId_batchRef: { guildId: 4, batchRef: 'WB-0007' } }
where: { guildId: 4, batchRef: 'WB-0007' }              // equivalent
```

## `distinct`

`distinct: ['status']` de-duplicates on those columns.

## Errors worth branching on

Every error extends `TurbineError` and carries a stable `code`. The ones a query
produces:

| code | class | means |
|---|---|---|
| `TURBINE_E003` | `ValidationError` | unknown column, bad operator, refused shape |
| `TURBINE_E005` | `RelationError` | unknown relation name in `with` |
| `TURBINE_E001` | `NotFoundError` | an `*OrThrow` matched nothing |
| `TURBINE_E008` | `UniqueConstraintError` | a write hit a unique constraint |

Branch on the class or the code, never on the message text: messages are not
covered by semver, and every message carries a link to its docs page.

## Before you answer

- Did the task ask for a relation? Then it is `with`, not `include`, and not
  `select`.
- Did it name exact columns? Then `select` exactly those and no more.
- Did it ask for an order? Then `orderBy` it explicitly.
- Did it ask for a count rather than rows? Then `count`, not `findMany`.
- Are you looking a row up by something that is not a unique key? Then
  `findFirst`, not `findUnique`.
