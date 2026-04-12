# Sprint Plan — Turbine ORM Gold Standard Improvements

Generated: 2026-04-12
Based on: Gold Standard Audit (40/50) — conversation findings

## Sprint Goal

Ship P0, P2, and P3 improvements from the Gold Standard audit: fix release traceability, add bundle tracking and DX scripts, refactor the monolithic query module, add dev-only validation guards, and enforce error code hygiene via CI.

## Success Criteria

- [x] All 5 version tags exist and match npm releases (v0.7.0, v0.7.1, v0.8.0, v0.9.0, v0.9.1)
- [ ] `size-limit` tracks bundle size with PR-level reporting
- [ ] `test:watch`, `db:seed`, `db:reset` scripts work
- [ ] `query.ts` split into submodules (types, utils, builder)
- [ ] Dev-only validation guards behind `process.env.NODE_ENV`
- [ ] `next` release channel publishes on every main merge
- [ ] Error code enforcement script runs in CI
- [ ] All unit tests pass, typecheck clean, build clean

## Dev Tracks

### Track 1: Package & Config — DX Infrastructure
**Owner:** Dev Agent 1
**Files touched:** `package.json`, `.size-limit.json` (new)
**Tasks:**
- [x] TASK-01: Tag missing git releases (v0.8.0, v0.9.0, v0.9.1) — DONE pre-sprint
- [ ] TASK-02 (P0): Add `@size-limit/file` devDep + `.size-limit.json` config + `size-limit` npm script
- [ ] TASK-03 (P0): Add `test:watch` script to package.json
- [ ] TASK-05 (P2): Add `db:seed` and `db:reset` npm scripts

### Track 2: Query Module Refactor + Dev Guards
**Owner:** Dev Agent 2
**Files touched:** `src/query.ts` -> `src/query/`, `src/client.ts`, `src/index.ts`, `src/pipeline.ts`, `src/pipeline-submittable.ts`, `src/schema-sql.ts`, `src/cli/studio.ts`, `src/cli/migrate.ts`, `src/test/*.ts`
**Tasks:**
- [ ] TASK-06 (P2): Split `query.ts` (3,568 LOC) into `src/query/types.ts`, `src/query/utils.ts`, `src/query/builder.ts`, `src/query/index.ts`
- [ ] TASK-07 (P3): Add `process.env.NODE_ENV !== 'production'` validation guards in query builder

### Track 3: CI Workflows & Error Code Enforcement
**Owner:** Dev Agent 3
**Files touched:** `.github/workflows/ci.yml`, `.github/workflows/nightly.yml` (new), `scripts/check-error-codes.ts` (new)
**Tasks:**
- [ ] TASK-04 (P2): Add `next` release channel via nightly CI workflow
- [ ] TASK-08 (P3): Add error code enforcement script + CI job

## File Conflict Matrix

Zero file conflicts between tracks. Each track owns distinct files.
