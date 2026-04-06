# Sprint Plan — Turbine ORM v0.6.0

Generated: 2026-04-05
Based on: Product review conversation findings

## Sprint Goal

Address all P0/P1 security and credibility issues, harden the query engine with validation, update messaging to be accurate and defensible, and add missing test coverage — bringing Turbine from "impressive prototype" to "launch-ready."

## Success Criteria

- [ ] All P0 (CRITICAL) security issues resolved
- [ ] All P1 (HIGH) issues resolved
- [ ] Benchmark claims updated to be accurate and defensible
- [ ] "Prisma-compatible" messaging corrected
- [ ] Column validation added to orderBy/groupBy
- [ ] CJS build verified with test
- [ ] Unit tests pass (`npm run test:unit`)
- [ ] Build passes (`npm run build`)
- [ ] Lint passes (`npm run lint`)

## Dev Tracks

### Track 1: Security Hardening — CLI & Migrations

**Files touched:** `src/cli/index.ts`, `src/cli/migrate.ts`
**Tasks:**

- [ ] TASK-01 (P0): Fix shell injection in seed command — replace execSync string interpolation with execFileSync or spawn with array args
- [ ] TASK-02 (P1): Quote tracking table name in all SQL in migrate.ts — use quoteIdent() on TRACKING_TABLE at all interpolation sites
- [ ] TASK-03 (P2): Improve connection string redaction in CLI error paths — ensure DATABASE_URL never leaks in error messages

### Track 2: Query Engine Validation & Hardening

**Files touched:** `src/query.ts`, `src/schema-builder.ts`
**Tasks:**

- [ ] TASK-04 (P1): Add column validation to buildOrderBy — throw ValidationError for columns not in table metadata
- [ ] TASK-05 (P1): Add column validation to buildGroupBy args.by — throw ValidationError for columns not in table metadata
- [ ] TASK-06 (P2): Improve JSON.parse error handling in parseNestedRow — log warning instead of silent fallback
- [ ] TASK-07 (P2): Add runtime type validation in schema-builder — throw Error if ColumnDef.type is not in TYPE_MAP

### Track 3: Documentation & Messaging Accuracy

**Files touched:** `README.md`, `package.json`, `biome.json`, `src/query.ts` (comment only)
**Tasks:**

- [ ] TASK-08 (P1): Update package.json description — remove "2-3x faster than Prisma" claim, replace with accurate positioning
- [ ] TASK-09 (P1): Update README benchmark context — add note that Prisma 7 now uses join strategy by default, making claims version-specific
- [ ] TASK-10 (P1): Change "Prisma-compatible API" to "Prisma-inspired API" throughout README
- [ ] TASK-11 (P1): Update comparison table — fix "N+1 queries (default)" for Prisma to reflect join strategy
- [ ] TASK-12 (P2): Add error handling section to README with try/catch examples
- [ ] TASK-13 (P2): Enable noExplicitAny in biome.json (change "off" to "warn")
- [ ] TASK-14 (P2): Update query.ts header comment — remove "2-3x faster than Prisma" claim

### Track 4: Test Coverage & Build Verification

**Files touched:** `src/test/` (new and existing test files), `src/schema-sql.ts`
**Tasks:**

- [ ] TASK-15 (P1): Add unit tests for orderBy/groupBy column validation (after Track 2 changes)
- [ ] TASK-16 (P1): Add unit test verifying seed command uses safe child process execution
- [ ] TASK-17 (P2): Add unit tests for schema-builder runtime type validation
- [ ] TASK-18 (P2): Strengthen DEFAULT value validation regex in schema-sql.ts — tighten string literal pattern
- [ ] TASK-19 (P2): Add unit tests for DEFAULT value validation edge cases

## File Ownership (Conflict Prevention)

| File | Owner |
|------|-------|
| `src/cli/index.ts` | Track 1 |
| `src/cli/migrate.ts` | Track 1 |
| `src/query.ts` | Track 2 (logic) + Track 3 (comment only line 8) |
| `src/schema-builder.ts` | Track 2 |
| `README.md` | Track 3 |
| `package.json` | Track 3 |
| `biome.json` | Track 3 |
| `src/schema-sql.ts` | Track 4 |
| `src/test/*` | Track 4 |

## Intentionally Skipped

- **Streaming/cursor support** — Architecture-level change, too large for this sprint
- **Auto-diff migrations** — Major feature, needs its own sprint
- **GitHub issue/PR templates** — Low priority, non-code
- **LRU cache configurability** — Nice-to-have, not blocking launch
- **Extract query.ts into submodules** — Refactor, not blocking launch
