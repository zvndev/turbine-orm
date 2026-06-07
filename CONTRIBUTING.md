# Contributing to Turbine ORM

Thanks for your interest in contributing.

## Development Setup

```bash
git clone https://github.com/zvndev/turbine-orm.git
cd turbine-orm
npm install
```

## Running Tests

```bash
# Unit tests — no database needed
npm run test:unit

# Integration tests — spin up a throwaway Postgres + seed it, then run everything
./scripts/seed-test-db.sh
DATABASE_URL=postgres://turbine:turbine@localhost:54329/turbine_test npm test
```

Unit tests cover schema building, migration parsing, DDL generation, SQL builder output, error mapping, and Studio guards. Integration tests require a seeded Postgres. The small correctness fixture (`src/test/fixtures/seed.sql`, 5 users / 10 posts / 20 comments) is enough for the suite; the `benchmarks/seed-neon.ts` seeder (defaults to 1K users / 10K posts / 50K comments) is used for performance runs.

Stop the DB when you're done:

```bash
docker compose -f scripts/docker-compose.yml down
```

## Building

```bash
npm run build    # ESM + CJS output
npm run typecheck  # Type checking only
```

## Code Style

- TypeScript strict mode
- ESM imports with `.js` extensions (NodeNext resolution)
- JSDoc on all public APIs with `@example` blocks
- Biome for linting and formatting (`npm run lint`, `npm run format`)

## Pull Request Process

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Add tests for new functionality
4. Run `npm run typecheck && npm run test:unit` to verify
5. Open a PR with a clear description of what changed and why

## Architecture

```
src/
  client.ts         — Connection pool, transactions, middleware
  query/             — SQL generation, split into submodules:
    types.ts          — Public query arg types
    utils.ts          — quoteIdent, escapeLike, LRUCache
    builder.ts        — QueryInterface: WHERE clauses, json_agg nesting
    index.ts          — Barrel re-export
  nested-write.ts   — Tree-walking nested create/update engine
  schema.ts         — Type definitions, PG-to-TS mapping
  schema-builder.ts — defineSchema() API
  schema-sql.ts     — DDL generation, diff, push
  introspect.ts     — Database schema introspection
  generate.ts       — TypeScript code generation
  pipeline.ts       — Batch query execution
  observe.ts        — Observability / query metrics
  serverless.ts     — Edge/serverless driver binding (turbineHttp)
  adapters/         — Dialect adapters (CockroachDB, YugabyteDB, …)
  cli/              — CLI commands (init, generate, migrate, studio, etc.)
```

The query builder (`query/builder.ts`) is the core — it generates `json_agg` + `json_build_object` subqueries for nested relations, resolving entire object graphs in a single SQL statement.

## Reporting Bugs

Open a GitHub issue with:
- Turbine ORM version
- Node.js version
- PostgreSQL version
- Minimal reproduction code
- Expected vs actual behavior
