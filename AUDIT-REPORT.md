# Turbine ORM — Audit Report (basis for sprint)
Source: 5-agent critical product review, 2026-06-25, v0.19.2
Scores at audit time: **7.5/10** overall product quality.

## Verdicts
- **Is it real?** Yes — feature-complete pre-1.0 library. Build/typecheck/lint clean; 932 unit tests pass (332 DB-gated skips). Every advertised feature implemented.
- **Security:** No CRITICAL/HIGH. SQL-injection defense is rigorous. One LOW XSS in the Observe dashboard.
- **Engineering:** Strong — exemplary errors, sound transactions/migrations, investor-grade CI. Gaps: Studio security perimeter untested; coverage excludes CLI/codegen; some doc drift.
- **Differentiation:** Core `json_agg` single-query strategy is now COMMODITY (Prisma 7 default + Drizzle RQB v2 both ship it). Real moat = the *safety bundle*: read-only Studio + PII-safe errors + one dependency + checksummed migrations. Closest rival is Drizzle (owns same positioning, more mature).

## Findings → sprint scope (see SPRINT-PLAN.md)

### P0/P1 — broken or misleading (must fix)
- `schema` vs `SCHEMA` casing in serverless examples (README + serverless docs) → `undefined` at runtime, breaks flagship edge onboarding. `generate.ts:326` emits `SCHEMA`.
- `db.$queryRaw` documented but does not exist (compatibility doc) — real API is `db.raw` / `db.sql`.
- `timeoutMs` documented; source is `timeout` (`client.ts:229`).
- LOW XSS: `row.model`/`row.action` unescaped into `innerHTML` (`cli/observe-ui.ts:138,155`) under `script-src 'unsafe-inline'`.
- `withRetry()` presented as built-in in Drizzle comparison; it is user-written, not an export.
- Studio security perimeter (token/rate-limit/origin/READ-ONLY) has zero automated tests.
- Quickstart example accesses `.author` on a relation it never loaded (`quickstart/page.mdx:106`).

### P2 — accuracy + onboarding
- Nested writes (`connect`/`connectOrCreate`/`disconnect`/…) work but are undocumented.
- Optimistic locking exists but has no usage docs.
- Strategy: README + site lead with footprint/maximalism, not the actual moat (safety bundle).
- `with-inference.test.ts` docstring wrongly claims `tsx --test` catches type regressions (real guard is the typecheck job).
- CLAUDE.md "cli/ never imports query/" invariant is stale (`studio.ts` imports `QueryInterface`).
- `cockroachdb.ts:77` stale comment (says `SHOW INDEXES`, code uses `pg_indexes`).

### P3 — polish
- `@types/pg` is in `dependencies`, should be `devDependencies`.
- Missing Next.js/Express recipe + end-to-end RLS example.
- `sql-safety-property.test.ts` is mislabeled (fixed corpus, not property/fuzz).
- `crypto.timingSafeEqual` would harden the Studio token check.

### Deferred (NOT in this sprint)
- Refresh benchmarks (needs live DB at 1M+ rows) — manual.
- Configure `NPM_TOKEN` CI secret — manual (user action).
- Split `builder.ts` (4,462 LOC) — too risky to bundle with injection-critical changes; separate task.

## Adjacent strategic deliverables (parallel to sprint)
- **PowDB support decision** → `docs/strategy/powdb-decision.md`
- **MySQL/SQLite/MSSQL multi-dialect implementation plan** → `docs/strategy/multi-dialect-plan.md`
