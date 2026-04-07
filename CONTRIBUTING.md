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
# Unit tests (no database needed)
npm run test:unit

# All tests (requires DATABASE_URL)
DATABASE_URL=postgres://... npm test
```

Unit tests cover schema building, migration parsing, and DDL generation. Integration tests require a live Postgres database with seeded data.

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
  query.ts          — SQL generation, WHERE clauses, json_agg nesting
  schema.ts         — Type definitions, PG-to-TS mapping
  schema-builder.ts — defineSchema() API
  schema-sql.ts     — DDL generation, diff, push
  introspect.ts     — Database schema introspection
  generate.ts       — TypeScript code generation
  pipeline.ts       — Batch query execution
  serverless.ts     — HTTP driver (in development)
  cli/              — CLI commands (init, generate, migrate, etc.)
```

The query builder (`query.ts`) is the core — it generates `json_agg` + `json_build_object` subqueries for nested relations, resolving entire object graphs in a single SQL statement.

## Reporting Bugs

Open a GitHub issue with:
- Turbine ORM version
- Node.js version
- PostgreSQL version
- Minimal reproduction code
- Expected vs actual behavior
