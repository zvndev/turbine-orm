# Writing Turbine query arguments

A candidate skill, measured as arm D of the agent eval. Every construct below was
executed against a live database before being written down, so nothing here is
inferred from documentation.

## Relations are `with`, never `include`

Turbine spells the relation clause `with`. `include` is Prisma's spelling, and
Turbine does not reject it: an unrecognised top-level key is ignored, so the
query runs and silently returns rows with no relation attached.

```json
{ "table": "orders", "method": "findMany",
  "args": { "select": { "id": true },
            "with": { "customer": { "select": { "email": true } } } } }
```

## Relation names are derived, not the column and not the table

A relation name is not the foreign-key column and not always the table name:

- **belongsTo** (the side holding the FK) is the target table name, singularised
  and camelCased. `guild_id` on `cheese_wheels` gives the relation `guild`.
- **hasMany** (the side pointed at) is the child table name, camelCased and left
  plural: `cheese_wheels` gives `cheeseWheels`.
- **manyToMany** across a junction is named for the far table, not the junction.
  With `wheel_cultures` joining `cheese_wheels` and `cultures`, the relation on
  `cheese_wheels` is `cultures`. The junction is *also* exposed as a plain
  hasMany (`wheelCultures`), and picking it gives junction rows rather than the
  entities you wanted.

If a live `turbine mcp` connection is available, `relation_graph` lists these
names exactly. Read them rather than deriving them.

## Always write column names in camelCase

Results are always camelCase: `cave_humidity_pct` comes back as
`caveHumidityPct`. On the input side the DDL's snake_case spelling works in
some argument positions and is rejected in others, so the only spelling that
works everywhere is camelCase.

| argument | `ledger_handle` | `ledgerHandle` |
|---|---|---|
| `where` | accepted | accepted |
| `select` / `omit` | accepted | accepted |
| `distinct` | accepted | accepted |
| `cursor` | accepted | accepted |
| `orderBy` | **rejected, E003** | accepted |
| `groupBy` `by` | **rejected, E003** | accepted |
| `_avg` / `_sum` / `_min` / `_max` | **rejected, E003** | accepted |

Read the DDL for which columns exist, then convert every name to camelCase
before writing it into any argument. Copying `snake_case` straight out of the
DDL is the single most common way to fail a query that was otherwise correct.

## `select` may not name a relation

`select` and `omit` are for columns only. Naming a relation in `select` throws
`TURBINE_E003`. Relations go in `with`, which takes its own nested `select`.
`select` and `omit` are also mutually exclusive: passing both throws.

## WHERE operators

Bare values mean equality; `null` means IS NULL.

```json
{ "where": {
    "status": "graded",
    "retiredAt": null,
    "caveHumidityPct": { "gte": 90, "lte": 94 },
    "rindStyle": { "in": ["washed", "waxed"] },
    "givenName": { "contains": "Roux", "mode": "insensitive" },
    "batchRef": { "startsWith": "WB-" },
    "wheelCount": { "not": 0 } } }
```

Available: `equals`, `not`, `gt`, `gte`, `lt`, `lte`, `in`, `notIn`, `contains`,
`startsWith`, `endsWith`, plus `mode: "insensitive"`. Combinators `AND`, `OR`,
`NOT` nest at any depth; `AND` and `OR` take arrays.

## Relation filters: `some` / `none` / `every`

Filter parents by their children without returning the children:

```json
{ "where": { "cheeseWheels": { "some": { "status": "quarantined" } } } }
{ "where": { "ripeningChecks": { "none": {} } } }
{ "where": { "cheeseWheels": { "every": { "caveHumidityPct": { "gte": 85 } } } } }
```

`none: {}` means "has no rows at all". These are filters, not projections: they
add nothing to the result.

## Per-relation `orderBy`, `limit`, `where`, and nesting

Options inside `with` apply per parent row, so `limit: 3` means three children
each, not three overall.

```json
{ "with": { "affineurs": { "select": { "id": true },
                           "where": { "isJourneyman": true },
                           "orderBy": { "id": "desc" },
                           "limit": 3,
                           "with": { "cheeseWheels": { "select": { "id": true } } } } } }
```

## Ordering

`orderBy` takes an object or an array of objects (arrays keep their order as tie
breakers). Two special forms:

```json
{ "orderBy": [{ "pressedOn": "desc" }, { "id": "desc" }] }
{ "orderBy": { "affineurs": { "_count": "desc" } } }
{ "orderBy": { "tastingNotes": { "path": ["panel", "score"], "direction": "desc" } } }
```

## Pagination

`limit` and `offset`, with `take` and `skip` accepted as aliases.

## JSON columns are addressed by `path`

A `path` array walks the document. On the WHERE side it combines with the normal
operators:

```json
{ "where": { "tastingNotes": { "path": ["panel", "score"], "gte": 9 } } }
{ "where": { "credentialBlob": { "path": ["tier"], "equals": "master" } } }
```

`_count` accepts a JSON path too, and `groupBy` accepts one as a grouping key via
`{ "field": ..., "path": [...] }`. **`_avg`, `_sum`, `_min` and `_max` do not
work on a JSON path**: they reach the database as `avg(jsonb)` and fail there.

## Aggregates

```json
{ "table": "ripening_checks", "method": "aggregate",
  "args": { "where": { "rindScore": { "gte": 8 } },
            "_avg": { "aromaScore": true },
            "_max": { "aromaScore": true },
            "_count": { "id": true } } }
```

## groupBy and having

`by` lists the grouping columns. The `having` shape is **column first, aggregate
second**, which is the opposite of how it reads aloud:

```json
{ "table": "cheese_wheels", "method": "groupBy",
  "args": { "by": ["rindStyle"],
            "_count": { "id": true },
            "having": { "id": { "_count": { "gt": 55 } } },
            "orderBy": { "rindStyle": "asc" } } }
```

`having: { wheelCount: { _sum: { gt: 400 } } }` filters on a summed column. The
column named in `having` must be one you aggregated or grouped by.

## Unique lookups

`findUnique` needs a full unique key. For a single-column unique, name the
column. For a compound unique, use the joined selector whose value is an object
of the parts:

```json
{ "where": { "guildId_batchRef": { "guildId": 4, "batchRef": "WB-0007" } } }
```

Both `guildId_batchRef` and `guild_id_batch_ref` are accepted, and the inner keys
must be camelCase. Passing the two columns flat also works. A non-unique column
in `findUnique` is an error: use `findFirst`.

## `distinct`

`distinct: ["status"]` de-duplicates on those columns.

## Before you answer

- Did the task ask for a relation? Then it is `with`, not `include`, and not
  `select`.
- Did the task name exact columns? Then `select` exactly those and no more.
- Did the task ask for an order? Then `orderBy` it explicitly; without one, row
  order is undefined.
- Did the task ask for a count rather than rows? Then `count`, not `findMany`.
