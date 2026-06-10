# Sprint Plan — Turbine ORM v0.19.1 → v0.19.2

Generated: 2026-06-09
Based on: /product-review findings (5-agent audit: codebase, security, competitive, engineering, UX). Security audit: zero CRITICAL/HIGH/MEDIUM findings — this sprint is contract fixes + docs + hygiene.

## Sprint Goal

Eliminate every documented-but-broken behavior and every undocumented flagship feature, so a new user's first hour contains zero contract violations.

## Success Criteria

- [ ] `where: { field: { equals: value } }` works on non-JSON columns (P0)
- [ ] Soft-delete middleware example no longer documents a silently-broken pattern (P0)
- [ ] Nested-write op types either wired into input typing or un-exported (P0)
- [ ] `/studio` docs page exists and is in the site sidebar (P1)
- [ ] `turbine observe` appears in `--help`, README, and site docs (P1)
- [ ] `cursor`/`take`/`distinct` documented; migrate-from-prisma corrected re: `take` (P1)
- [ ] DB-gated tests report as `skipped`, not silent pass (P2)
- [ ] Dead code removed: `isReadOnlyStatement`, orphaned `.sql-editor` CSS (P2)
- [ ] Doc drift fixed: CLAUDE.md builder.ts LOC, release.yml "308 tests" comment (P2)
- [ ] All tests pass, typecheck/lint/build clean, site builds

## Intentionally skipped (and why)

- builder.ts split into modules — high-risk refactor, no user-facing value this sprint
- Closing `WhereClause` index signature / typing `WithOptions.where` — breaking-change territory, needs design
- Benchmark re-run vs Prisma 7 / LATERAL comparison — needs live Neon infra; caveat text updated instead
- Release-path consolidation — process decision for Kirby

## Dev Tracks (isolated worktrees, zero file overlap)

### Track 1: Core query engine — `equals` operator + nested-write typing
**Files:** `src/query/utils.ts`, `src/query/builder.ts`, `src/query/types.ts`, `src/index.ts` (exports), unit-test files in `src/test/`
- [ ] TASK-01 (P0): Support `equals` as plain equality operator on non-JSON columns
- [ ] TASK-02 (P0): Wire `NestedCreateOp`/`NestedUpdateOp`/`ConnectOrCreateOp` into create/update input typing, or un-export if it breaks inference

### Track 2: Repo docs — middleware example, README observe, drift
**Files:** `README.md`, `src/client.ts` (JSDoc only), `CLAUDE.md`, `.github/workflows/release.yml` (comment only)
- [ ] TASK-03 (P0): Replace broken soft-delete middleware example in README + `$use` JSDoc
- [ ] TASK-04 (P1): Document `turbine observe` + `$observe` in README
- [ ] TASK-05 (P2): Fix CLAUDE.md builder.ts LOC drift; fix stale "308 tests" comment in release.yml

### Track 3: Site — studio page, observe docs, queries gaps, hero repositioning
**Files:** `site/**` only
- [ ] TASK-06 (P1): Create `/studio` docs page; add to sidebar
- [ ] TASK-07 (P1): Create/extend observability docs
- [ ] TASK-08 (P1): Document `cursor`, `take`, `distinct` in /queries; fix migrate-from-prisma `take` note
- [ ] TASK-09 (P1): Update stale benchmark caveat (0.17.0 → current); note Prisma 7 landscape honestly
- [ ] TASK-10 (P2): Reposition homepage hero toward "Postgres-maximalist" framing

### Track 4: CLI surfaces — help text + dead code
**Files:** `src/cli/index.ts`, `src/cli/studio.ts`, `src/cli/studio-ui.html` (+ regenerated `studio-ui.generated.ts`), studio test files (only isReadOnlyStatement tests)
- [ ] TASK-11 (P1): Add `observe` to help; add `--auto`, `--allow-drift`, `--step` flags to help text
- [ ] TASK-12 (P2): Delete `isReadOnlyStatement()` + its tests; remove orphaned `.sql-editor` CSS; run `npm run gen:studio`

### Track 5: Test hygiene — proper skip reporting
**Files:** DB-gated integration test files in `src/test/` only
- [ ] TASK-13 (P2): Convert silent `const SKIP = !DATABASE_URL` no-op guards to node:test `skip` so reporters show skipped counts
