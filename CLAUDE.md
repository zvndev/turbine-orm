# Turbine ORM

TypeScript ORM for PostgreSQL. Single-query nested relations via `json_agg`.

## Quick Reference

```bash
npm install           # Install deps
npm run build         # ESM + CJS output (dist/ and dist-cjs/)
npm run typecheck     # tsc --noEmit
npm run test:unit     # Schema builder + migration tests (no DB needed)
npm test              # All tests (needs DATABASE_URL)
npm run lint          # Biome lint
npm run lint:fix      # Biome lint --apply
```

## Architecture

The core insight: instead of N+1 queries for nested relations, Turbine generates a single SQL statement using PostgreSQL's `json_agg` + `json_build_object` with correlated subqueries.

**Dependency graph:** `client.ts` wraps `query.ts` with connection pooling and transactions. `query.ts` is the heart — it builds all SQL and parses results. `pipeline.ts` batches multiple `DeferredQuery` objects from `query.ts` into a single round-trip. The CLI (`cli/`) imports `generate.ts`, `introspect.ts`, and `schema-sql.ts` but never imports `query.ts` or `client.ts` directly.

```
src/
  query.ts          — The heart (~2K LOC). SQL generation for all operations (findMany,
                      findUnique, create, update, delete, aggregate, count). Builds WHERE
                      clauses with operators (gt, in, contains, etc.), json_agg nested
                      relation subqueries, and parameterized queries. Contains LRUCache
                      (1K entry cap), QueryInterface class, and all public arg types.

  client.ts         — TurbineClient wraps a pg.Pool and auto-creates typed table accessors
                      via Object.defineProperty. Manages middleware ($use), transactions
                      ($transaction with SAVEPOINTs for nesting, isolation levels, timeouts),
                      raw SQL tagged templates, and pipeline batching. Registers int8 parser
                      once (static flag) so bigint comes back as number. Also exports
                      PgCompatPool / PgCompatPoolClient / PgCompatQueryResult interfaces
                      and accepts an external pool via TurbineConfig.pool for serverless
                      drivers (Neon, Vercel Postgres, Cloudflare) — when an external pool
                      is supplied, Turbine does NOT call pg.types.setTypeParser and
                      disconnect() becomes a no-op (caller owns lifecycle).

  errors.ts         — Error hierarchy rooted at TurbineError. Each error has a code
                      (TURBINE_E001-E011). wrapPgError() translates pg driver constraint
                      errors (23505, 23503, 23502, 23514) into typed Turbine errors.

  schema.ts         — Postgres-to-TypeScript type mapping, SchemaMetadata/TableMetadata
                      interfaces, camelToSnake/snakeToCamel utilities, singularize helper.

  schema-builder.ts — defineSchema() API for code-first schema definitions. Produces
                      SchemaDef objects consumed by schema-sql.ts for DDL generation.

  schema-sql.ts     — DDL generation from SchemaDef. All identifiers quoted via quoteIdent().
                      Also provides schemaDiff() for auto-diff migrations.

  introspect.ts     — Reads information_schema + pg_catalog to produce SchemaMetadata.
                      Discovers tables, columns, types, relations, indexes, enums.

  generate.ts       — Code generator that emits three files from introspected schema:
                      types.ts (entity interfaces, Create/Update input types),
                      metadata.ts (runtime SchemaMetadata object), and
                      index.ts (typed TurbineClient subclass with table accessors).

  pipeline.ts       — Batch query execution. Takes DeferredQuery[] and runs all SQL
                      in a single pg round-trip, then applies each query's transform.

  serverless.ts     — Edge / serverless driver binding. Exports turbineHttp(pool, schema)
                      which constructs a TurbineClient bound to an external pg-compatible
                      pool (Neon @neondatabase/serverless, @vercel/postgres, Cloudflare
                      Hyperdrive, etc.). Pure TypeScript shim — no extra runtime deps.
                      Published as the `turbine-orm/serverless` subpath export.

  cli/              — CLI entry point and commands (see CLI Architecture below).
```

## Site at site/

This repo ships the library **and** its marketing/docs site. The site lives at `site/` (a standalone Next.js 15 App Router project with its own `package.json` and `node_modules`) and deploys to `turbineorm.dev` via the Vercel project `zvn-dev/turbine-docs`.

- Library work stays in `src/`. Site work stays in `site/`. Don't cross the streams.
- Every release updates **both** surfaces in a single commit: library + `site/` + `CHANGELOG.md` + version bump, then `npm publish` + `vercel --prod`.
- Root-level helpers: `npm run site:dev`, `npm run site:build`, `npm run site:deploy`.
- See `AGENTS.md` at the repo root for the full release playbook, the npm publish auth notes (granular token with bypass-2FA), and the verification checklist. Don't duplicate that content here — AGENTS.md is the source of truth.

## The json_agg Algorithm

The core of Turbine's single-query strategy lives in `buildRelationSubquery()` (query.ts ~line 2173). For each relation in a `with` clause, it generates a correlated subquery that PostgreSQL evaluates per parent row.

1. **Alias generation.** A shared `aliasCounter: { n: number }` is passed through all nesting levels. Each call allocates `t0`, `t1`, `t2`, etc. This prevents alias collisions in arbitrarily deep trees.

2. **json_build_object.** Each child row is mapped to a JSON object: `json_build_object('id', t0."id", 'title', t0."title", 'createdAt', t0."created_at")`. Keys are camelCase field names; values reference the alias.

3. **json_agg + COALESCE (hasMany).** For one-to-many, the json_build_object is wrapped in `json_agg(...)`, then `COALESCE(..., '[]'::json)` ensures the result is never NULL (empty array fallback). For belongsTo/hasOne, no aggregation is used, just `LIMIT 1`.

4. **Correlation WHERE.** Links the subquery to its parent: hasMany uses `alias.foreignKey = parentRef.referenceKey` (child FK points to parent PK); belongsTo reverses this (`alias.referenceKey = parentRef.foreignKey`).

5. **Inner subquery wrapping for LIMIT/ORDER.** When a hasMany relation has `limit` or `orderBy`, the query restructures into two levels: an inner SELECT with WHERE/ORDER/LIMIT on raw rows, wrapped by an outer SELECT that applies json_agg to the inner alias (`t0i`). Without this, LIMIT on aggregated results is meaningless.

6. **Recursion with depth cap.** Nested `with` clauses recurse into `buildRelationSubquery()`, incrementing depth. At depth 10, a `CircularRelationError` is thrown with the full path trail. Back-references (e.g. posts -> user -> posts) are allowed since they are legitimate queries.

7. **parseNestedRow.** After query execution, `parseNestedRow()` walks the result. Relation columns arrive as JSON strings from pg; they are JSON.parsed, then each item is run through `parseRow()` to apply snake-to-camel mapping and date coercion on the target table.

## Type System

**Query arg types** (query.ts lines 60-270): `WhereClause<T>` supports equality, null checks, operators (`gt`, `gte`, `lt`, `lte`, `not`, `in`, `notIn`, `contains`, `startsWith`, `endsWith`), `mode: 'insensitive'` for ILIKE, `OR`/`AND`/`NOT` combinators, and relation filters (`some`/`every`/`none`). `WithClause` maps relation names to `true | WithOptions`. `WithOptions` supports nested `with`, `where`, `orderBy`, `limit`, `select`, and `omit`.

**Atomic updates** (query.ts ~line 197): `UpdateOperatorInput<V>` supports `set`, `increment`, `decrement`, `multiply`, `divide` for numeric fields. These generate `col = col + $n` style SQL for concurrent safety.

**Generated types** (generate.ts): The code generator emits three files:
- `types.ts` — Entity interfaces (singularized PascalCase), `*Create` types (optional for PK/default/nullable fields), `*Update` types (all non-PK fields optional), and `*With*` interfaces for each relation.
- `metadata.ts` — Runtime `SchemaMetadata` constant with column maps, relations, indexes.
- `index.ts` — `TurbineClient` subclass with `declare readonly` typed table accessors and a `turbine()` factory function.

**Current limitation:** The `with` clause return types do not reflect included relations at the type level. The runtime correctly nests relation data, but TypeScript sees the base entity type. The generated `*With*` interfaces exist but must be manually asserted.

**DeferredQuery<T>** (query.ts line 436): Each `build*()` method returns `{ sql, params, transform, tag }` instead of executing. The `transform` function converts `pg.QueryResult` into the final typed value. Used by `pipeline()` for batching.

## Error System

All errors extend `TurbineError` which carries a `code: TurbineErrorCode` property for programmatic handling.

| Code | Class | When |
|---|---|---|
| E001 | `NotFoundError` | `findUniqueOrThrow`, `findFirstOrThrow`, missing row |
| E002 | `TimeoutError` | Query or transaction exceeds timeout |
| E003 | `ValidationError` | Unknown column, invalid operator, empty where guard |
| E004 | `ConnectionError` | Pool connection failure |
| E005 | `RelationError` | Unknown relation name in `with` clause |
| E006 | `MigrationError` | Migration file parse error, checksum mismatch |
| E007 | `CircularRelationError` | Nesting depth exceeds 10 |
| E008 | `UniqueConstraintError` | pg 23505 — via `wrapPgError()` |
| E009 | `ForeignKeyError` | pg 23503 — via `wrapPgError()` |
| E010 | `NotNullViolationError` | pg 23502 — via `wrapPgError()` |
| E011 | `CheckConstraintError` | pg 23514 — via `wrapPgError()` |

`wrapPgError(err)` inspects the pg driver error's `.code` field and wraps it in the appropriate typed error, preserving the original as `.cause`. It is called in `client.ts` (raw queries, transaction pool proxy) and at query execution boundaries in `query.ts`.

## CLI Architecture

The CLI (`src/cli/index.ts`) uses a zero-dependency argument parser on `process.argv`. No commander/yargs. Commands: `init`, `generate`/`pull`, `push`, `migrate create|up|down|status`, `seed`, `status`, `studio` (placeholder).

**Config resolution** (`cli/config.ts`): Searches for `turbine.config.ts` / `.js` / `.json`, merges with `--url`/`--out`/`--schema` flags and `DATABASE_URL` env var.

**Migration system** (`cli/migrate.ts`): SQL-first migrations stored as timestamp-prefixed `.sql` files with `-- UP` and `-- DOWN` sections. Tracked in a `_turbine_migrations` table with SHA-256 checksums. Uses `pg_try_advisory_lock()` to prevent concurrent migration runs. Each migration runs in its own transaction. Checksum validation detects modified migration files.

**UI module** (`cli/ui.ts`): Terminal formatting helpers — colors, spinners, tables, boxes. Imported throughout CLI but never by library code.

## Testing

**Unit tests** run without a database. They use mock schemas from `src/test/helpers.ts` which provides `mockColumn()`, `mockTable()`, and `makeQuery()` (creates a QueryInterface with a null pool for build-only SQL tests).

**Integration tests** need a PostgreSQL instance with seeded data. Set `DATABASE_URL` env var. The seed schema lives in `benchmarks/` and creates 5K users, 46K posts, and 432K comments. Tests that require a database use a `describe.skip` wrapper when `DATABASE_URL` is absent — they show as skipped, not failed.

**Coverage** is configured in `.c8rc.json`. It covers `src/**` but excludes `src/test/**`, `src/cli/**`, `src/generate.ts`, `src/introspect.ts`, `src/serverless.ts`, and `src/index.ts`. Thresholds: 55% lines/functions/statements, 75% branches.

## Key Patterns

- All SQL identifiers quoted via `quoteIdent()` — doubles internal `"` chars per Postgres rules
- All user values parameterized (`$1, $2, ...`) — never string-interpolated
- LIKE patterns escaped via `escapeLike()` — escapes `%`, `_`, `\`
- Empty-where guard blocks accidental mass mutations: update/delete with `{}` or all-undefined where throws `ValidationError` unless `allowFullTableScan: true`
- `LRUCache` bounds the SQL template cache at 1,000 entries (Map insertion order for O(1) eviction)
- Module has no side effects — `setTypeParser` for int8 is gated behind a static flag in the TurbineClient constructor
- ESM source with `.js` extensions (NodeNext resolution), CJS output via separate `tsconfig.cjs.json`
- Middleware runs after SQL generation — it can inspect/log params and transform results, but cannot modify the SQL itself

## Common Tasks

**Adding a new query method:**
1. Define the args interface in query.ts (e.g. `FooArgs<T>`) near the existing arg types (~line 150).
2. Add a `buildFoo()` method to `QueryInterface` that returns `DeferredQuery<T>`. Build SQL using parameterized queries, push values to `params[]`, reference columns via `this.tableMeta`.
3. Add a `foo()` method that calls `buildFoo()`, executes via `this.execute()`, and applies the transform.
4. Add unit tests in `src/test/` using `makeQuery()` from helpers to verify generated SQL without a database.
5. Add integration tests that run against the seeded database.

**Adding a new error type:**
1. Add the error code constant to `TurbineErrorCode` in errors.ts (e.g. `NEW_ERROR: 'TURBINE_E012'`).
2. Create the error class extending `TurbineError`, passing the code to `super()`.
3. If it maps to a pg error code, add a case to `wrapPgError()`.
4. Export from errors.ts and re-export from the package index.

**Adding a new CLI command:**
1. Add the command to the help text and JSDoc at the top of `cli/index.ts`.
2. Add a case to the main switch in the `run()` function.
3. Implement the handler, using `requireUrl()` for database-requiring commands and the `ui.ts` helpers for output.

**Modifying the code generator:**
1. Edit `generate.ts`. The three generator functions are `generateTypes()`, `generateMetadata()`, and `generateIndex()`.
2. Types are built by iterating `schema.tables` and `table.columns`. Entity names come from `entityName()` (singularized PascalCase via `snakeToPascal(singularize(tableName))`).
3. Test by running `npx turbine generate` against a database and inspecting the output in `generated/turbine/`.

## Don't

- Don't add runtime dependencies beyond `pg`
- Don't use `eval`, `new Function`, or shell interpolation
- Don't break the Prisma-like API (`findMany`, `findUnique`, `with`, `where`)
- Don't put user values in SQL strings — always use `$N` parameterization
- Don't import `client.ts` from `query.ts` (would create circular dependency)
- Don't register type parsers outside the TurbineClient constructor
