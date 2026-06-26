# Sprint Plan — Turbine ORM
Generated: 2026-06-25
Based on: AUDIT-REPORT.md (5-agent product review, v0.19.2)

## Sprint Goal
Eliminate every onboarding-breaking doc bug and the one security gap, document the
two undocumented competitive features (nested writes, optimistic locking), reposition
the top-line messaging around the real moat (the safety bundle), and put automated
tests around the Studio security perimeter — without touching injection-critical code.

## Success Criteria
- [ ] All P0/P1 broken/misleading items resolved (casing, `$queryRaw`, `timeoutMs`, Observe XSS, `withRetry` claim, quickstart `.author`)
- [ ] Studio security perimeter has automated tests (token 401 / rate-limit 429 / cross-origin 403 / read-only write rejection)
- [ ] Nested writes + optimistic locking documented
- [ ] README + landing hero lead with the safety bundle
- [ ] Build, typecheck, lint, and unit tests all green after merge
- [ ] No file edited by two tracks (zero merge conflicts)

## Dev Tracks (4) — zero file overlap

### Track 1: Code & Security Hardening — backend/security specialist
**Files owned:** `src/cli/observe-ui.ts`, `src/cli/observe.ts`, `src/cli/studio.ts`, `src/cli/index.ts`, `src/generate.ts`, `src/adapters/cockroachdb.ts`, `src/test/generate*.test.ts` (snapshot fixups only), `generated/turbine/metadata.ts` (if tracked), `package.json`, `CLAUDE.md`
**Tasks:**
- [ ] T1-1 (LOW-sec): Escape `row.model`/`row.action` via the existing `escapeHtml` pattern in `observe-ui.ts:138,155`
- [ ] T1-2 (P3): Harden Studio/Observe token check to `crypto.timingSafeEqual` over SHA-256 digests (constant length, no throw, no length leak)
- [ ] T1-3 (P2): Make the "Refuse to bind" comments at `cli/index.ts:~1138,~1229` accurate (warn-and-proceed on explicit `--host`)
- [ ] T1-4 (P1): Export a lowercase `schema` alias alongside `SCHEMA` in `generate.ts` generateMetadata; update tracked fixture + any generate snapshot test
- [ ] T1-5 (P2): Fix stale `cockroachdb.ts:77` comment (`SHOW INDEXES` → `pg_indexes`)
- [ ] T1-6 (P3): Move `@types/pg` `dependencies` → `devDependencies`
- [ ] T1-7 (P2): Fix stale CLAUDE.md invariant ("cli/ never imports query/")

### Track 2: README + Landing Positioning — product/copy specialist
**Files owned:** `README.md`, `site/app/page.tsx`
**Tasks:**
- [ ] T2-1 (P2-strategy): Reposition README hero around the safety bundle (DBA-approvable read-only Studio, PII-safe errors, one dependency, checksummed migrations) — re-order the lead, keep all technical content
- [ ] T2-2 (P1): Fix `schema` → `SCHEMA` in README serverless examples (~lines 708–757)
- [ ] T2-3 (P1): Correct the `withRetry()` "built-in" claim in the README comparison table
- [ ] T2-4 (P2-strategy): Align the landing hero (`site/app/page.tsx`) with the same safety-bundle lead; fix `withRetry` in the landing comparison table if present

### Track 3: Docs Pages (MDX) — docs specialist
**Files owned:** `site/app/(docs)/**` (MDX + docs nav/layout only)
**Tasks:**
- [ ] T3-1 (P1): Fix `schema` → `SCHEMA` in `serverless/page.mdx` (all blocks)
- [ ] T3-2 (P1): Fix `db.$queryRaw` → `db.raw` / `db.sql` in `compatibility/page.mdx`
- [ ] T3-3 (P1): Fix `timeoutMs` → `timeout` in `transactions/page.mdx`
- [ ] T3-4 (P1): Fix quickstart `.author` example (`quickstart/page.mdx:106`) — load `author` via nested `with` or remove the access
- [ ] T3-5 (P2): NEW page — nested writes (verify against `src/nested-write.ts`)
- [ ] T3-6 (P2): NEW page — optimistic locking (verify against `builder.ts` optimisticLock)
- [ ] T3-7 (P3): NEW recipe — Next.js/Express route handler + end-to-end RLS example with policy DDL
- [ ] T3-8: Update docs nav to include new pages

### Track 4: Test Coverage — test specialist
**Files owned:** `src/test/**` EXCEPT `src/test/generate*.test.ts` (Track 1 owns those)
**Tasks:**
- [ ] T4-1 (P1): Studio security-perimeter tests through the HTTP dispatch layer — invalid token → 401, rate limit → 429, cross-origin → 403, write under `BEGIN READ ONLY` → rejected. Test behavior, not implementation.
- [ ] T4-2 (P2): Fix `with-inference.test.ts` docstring (real guard is the typecheck job, not `tsx --test`)
- [ ] T4-3 (P3): Relabel `sql-safety-property.test.ts` to reflect it is a fixed adversarial corpus (no new deps); optionally expand the corpus

## Intentionally skipped (with reason)
- Refresh benchmarks — needs a live DB at 1M+ rows; manual follow-up.
- Configure `NPM_TOKEN` — user must add the CI secret (manual).
- Split `builder.ts` — injection-critical; too risky to bundle here.

## Manual actions for the user
- Add the `NPM_TOKEN` repo secret to re-enable automated publishing.
- Run a fresh large-dataset benchmark (correlated-subquery vs LATERAL) before 1.0.
