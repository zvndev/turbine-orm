# Turbine ORM

TypeScript ORM for PostgreSQL. Single-query nested relations via `json_agg`.

## Quick Reference

```bash
npm install           # Install deps
npm run build         # ESM + CJS output
npm run typecheck     # tsc --noEmit
npm run test:unit     # Schema builder + migration tests (no DB needed)
npm test              # All tests (needs DATABASE_URL)
```

## Architecture

The core insight: instead of N+1 queries for nested relations, Turbine generates a single SQL statement using PostgreSQL's `json_agg` + `json_build_object` with correlated subqueries.

```
src/
  query.ts          — The heart. SQL generation, WHERE clauses, json_agg nesting (~2K LOC)
  client.ts         — TurbineClient, connection pool, transactions, middleware
  schema.ts         — Postgres-to-TypeScript type mapping
  schema-builder.ts — defineSchema() API for code-first schemas
  schema-sql.ts     — DDL generation with quoteIdent() on all identifiers
  introspect.ts     — Reads information_schema + pg_catalog
  generate.ts       — Emits types.ts, metadata.ts, index.ts from introspection
  pipeline.ts       — Batch query execution in single round-trip
  serverless.ts     — HTTP driver scaffold (not yet implemented)
  cli/              — CLI commands: init, generate, push, migrate, seed, status
```

## Key Patterns

- All SQL identifiers quoted via `quoteIdent()` (prevents injection)
- All user values parameterized (`$1, $2, ...`)
- `LRUCache` bounds the SQL template cache at 1,000 entries
- Tests use `describe.skip` wrapper when DATABASE_URL is absent
- ESM source with `.js` extensions (NodeNext resolution)
- CJS output via separate `tsconfig.cjs.json`

## Testing

Integration tests need a Postgres with seeded data (5K users, 46K posts, 432K comments). Unit tests run anywhere.

## Don't

- Don't add runtime dependencies beyond `pg`
- Don't use `eval`, `new Function`, or shell interpolation
- Don't break the Prisma-like API (`findMany`, `findUnique`, `with`, `where`)
