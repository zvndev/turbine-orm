# Remaining Work — Post v0.10.0

**Last updated:** 2026-05-09
**Current package version:** 0.14.0

---

## Immediate Next Steps (from product review)

### 1. Test Coverage Expansion
- Integration test coverage is gated behind DATABASE_URL — many paths untested in CI
- Need CI workflow with a real Postgres instance (GitHub Actions `services:` block)
- Target: 80%+ line coverage on `src/query/builder.ts` and `src/client.ts`

### 2. Performance & Optimization
- See `docs/optimization-plan-1-pipeline.md` — pipeline batching improvements
- See `docs/optimization-plan-2-prepared-stmts-sql-cache.md` — prepared statement reuse
- See `docs/optimization-plan-3-streaming-and-parse.md` — cursor streaming for large result sets

### 3. Content & Marketing (Strategic Plan)
- See `docs/STRATEGIC-PLAN.md` for full content strategy
- Priority articles: "Deep typed with inference" + "Postgres ORM on Cloudflare Workers"
- Target: r/nextjs, r/typescript, HN Show HN, Dev.to

---

## Multi-Database Expansion

### Phase 1: Extract Core (prerequisite for all dialects)
- Extract shared types into `@turbine-orm/core` or internal module boundary
- Define `Dialect` interface (see `docs/MULTI_DB_PLAN.md` section 3)
- Refactor PostgreSQL query, DML, schema DDL, and migration tracking SQL paths to implement the Dialect interface
- No MySQL/SQLite runtime support yet — foundation work only

### Phase 2: MySQL/MariaDB (`@turbine-orm/mysql`)
- New query builder using `JSON_ARRAYAGG` + `JSON_OBJECT`
- Backtick quoting, `?` parameters, MySQL `information_schema`
- `mysql2` driver integration
- Estimated: 4-6 engineer-weeks

### Phase 3: SQLite (`@turbine-orm/sqlite`)
- `json_group_array` + `json_object` for nested relations
- `better-sqlite3` / `bun:sqlite` / Turso (libsql) drivers
- Limited ALTER TABLE requires migration workarounds
- Estimated: 3-4 engineer-weeks

### Architecture Decision
- **Chosen:** Option C (Hybrid) — `turbine-orm` stays as-is, new dialects as `@turbine-orm/mysql` etc.
- Full rationale in `docs/MULTI_DB_PLAN.md`

---

## Already Shipped in v0.10.0

- [x] PG-compatible adapter system (CockroachDB, YugabyteDB, AlloyDB, Timescale)
- [x] Composite foreign key support
- [x] Relation filter validation (column existence checking)
- [x] Multi-column FK introspection fix
- [x] Database compatibility docs page
- [x] Dynamic OG images
- [x] Sidebar accessibility improvements
- [x] README reframing
- [x] Upsert + groupBy documentation
- [x] 100+ new unit tests across adapters, composite FKs, schema-diff, client coverage

---

## Plan Files Index

| File | Purpose |
|------|---------|
| `docs/MULTI_DB_PLAN.md` | Full architecture for MySQL/SQLite expansion (1,097 lines) |
| `docs/NEXT-INTEGRATIONS.md` | Competitor analysis + candidate ranking |
| `docs/STRATEGIC-PLAN.md` | Marketing, positioning, content strategy |
| `docs/optimization-plan-1-pipeline.md` | Pipeline batching improvements |
| `docs/optimization-plan-2-prepared-stmts-sql-cache.md` | Prepared statement reuse |
| `docs/optimization-plan-3-streaming-and-parse.md` | Cursor streaming |
| `docs/OPTIMIZATION-CHECKPOINT.md` | Progress checkpoint on optimization work |
