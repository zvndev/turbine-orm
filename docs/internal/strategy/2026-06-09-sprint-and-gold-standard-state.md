# State checkpoint — 2026-06-09 sprint + gold-standard audit

## Sprint (COMPLETE)

Branch: `sprint/v0.19.2-review-fixes` (local only — NOT merged to main, NOT pushed, NOT published).
All gates green: 1,264 tests — 932 pass / 332 skipped / 0 fail; typecheck, lint, build, site build, size-limit (31.2/22.3 kB vs 35/25 limits).

Shipped on the branch (from /product-review findings + 5-agent review panel):
- P0: `equals` operator works as plain equality (build + cache-hit + relation paths; JSONB preserved); nested-write op types wired into create/update typing; broken soft-delete middleware example replaced on README + JSDoc + site.
- HIGH (found by review panel, pre-existing since ≤0.19.1): where-key-order cache cross-binding — fingerprints sorted keys, build/collect iterated insertion order → permuted `{tenantId, id}` literals could bind wrong params on a warm cache (cross-tenant-leak class). Canonicalized across where/relFilter/aliasWhere/with/cursor families + findUnique simple path (a re-verifier catch). 14 regression tests in src/test/where-key-order.test.ts, gated into test:unit.
- Site: new /studio + /observability pages, queries gaps (cursor/take/distinct/full-text; fixed nonexistent-`skip` doc bug), migrate-from-prisma corrections, benchmarks vintage caveat, hero → "The Postgres-maximalist ORM", pgvector head-to-head (Turbine/Prisma/Drizzle) on /vector, bundle claims fixed to measured 31/22 kB brotli.
- Hygiene: DB-gated tests report skipped via skipGate() (src/test/helpers.ts); dead studio code deleted; CLI help completed (observe, migrate flags); new tests added to test:unit.

Review verdicts after iteration: PM SHIP IT · CEO PROMISING BUT (both asks done) · Security YES · Code Quality YES · UX YES.
Known LOW deferred: middleware shallow-copies args, so DEEP mutation still reaches SQL — consider structuredClone in a future patch. Also deferred: builder.ts split, WhereClause type-closing, live benchmark re-run.

Next actions for the sprint: merge to main + release as v0.19.2 (version bump, CHANGELOG entry, npm publish + vercel --prod per AGENTS.md) when Kirby says go.

## Gold-standard audit (2 of 3 agents reported)

- Docs 4.5/5 · DX 4.5/5 — husky hook concern was a false alarm (v9 hooksPath verified working). Top fixes: replace hand-maintained 44-file test:unit list with a convention/glob; fix stale 3-file test:watch; sync CLAUDE.md src-tree (missing adapters/, dialect.ts, nested-write.ts, pipeline-submittable.ts); add CODE_OF_CONDUCT.md + README→CONTRIBUTING link.
- CI/CD 3/5 — **CI on main permanently red**: scripts/check-error-codes.ts KNOWN_ERRORS stale (missing OptimisticLockError E015 + ExclusionConstraintError E016) — one-line fix; YugabyteDB job burns 6 min failing every run (pin image or move to scheduled); npm-audit job is continue-on-error (defanged).
- Build 4/5 — exports/sideEffects/size gates all correct; headroom down to ~11%; stale "~27 kB" comments in .size-limit.js.
- Release 2.5/5 — **release.yml + nightly.yml have NEVER published (ENEEDAUTH — NPM_TOKEN repo secret missing)**; no provenance on real releases; git tags missing for v0.11–v0.14, v0.16; AGENTS.md `--ignore-scripts` publish skips prepublishOnly gates; no post-publish smoke test.
- Security 3.5/5 — 0 prod vulns (1 moderate dev-only brace-expansion); SECURITY.md versions table stale (lists 0.17.x/0.16.x); no dependabot.yml; audit gate defanged.
- Testing 4.5/5 (1.34:1 ratio, type-level + property tests; missing generative fuzz; ratchet coverage floors) · Error Handling 4/5 (E015/E016 missing from site errors page; codes not in message strings) · Code Org 4/5 (builder.ts 4,462 LOC god file — proven bug magnet; extract where-compiler) · Tech Debt 3.5/5 (zero TODOs, but tracked sprint/strategy/audit scaffolding in public repo + CLAUDE.md drift).
- AUDIT COMPLETE. Overall ≈ 38/50.

## P0s DONE on the branch (commit "fix: gold-standard P0s")
- check-error-codes KNOWN_ERRORS += E015/E016 (error-codes CI gate passes again)
- SECURITY.md versions → 0.19.x/0.18.x
- .github/dependabot.yml added (npm root + site + actions, weekly)

## Remaining improvement plan (not implemented)
P0-manual (Kirby): set NPM_TOKEN repo secret → activates release.yml provenance publish + @next channel.
P1: backfill git tags v0.11–v0.14, v0.16; fix/park YugabyteDB CI job (6 min red every run); make npm audit a hard gate; replace hand-listed test:unit with glob/convention; fix stale test:watch; add E015/E016 to site errors page; post-publish smoke job; npm-pack install smoke test.
P2: extract where-compiler/relation-subquery from builder.ts; move tracked sprint/strategy/audit scaffolding out of public repo; CLAUDE.md doc-sync pass (LOC counts, fixture counts, src-tree); CODE_OF_CONDUCT.md + README contributing link; one seeded generative fuzz test; ratchet coverage floors; append (TURBINE_E0NN) to error messages.


## ADDENDUM — P1/P2 follow-up implemented (2026-06-09, second pass)

Done on the branch (commits ecfe759, ab963dc, 38477da, 90ba493 + tag backfill):
- Error-codes CI gate fixed (E015/E016) — main was red since 0.15.0; now green.
- SECURITY.md supported-versions -> 0.19.x/0.18.x; .github/dependabot.yml added.
- YugabyteDB CI job moved out of ci.yml into nightly.yml (cron), image pinned off :latest — stops the ~6min red-X-per-PR.
- npm audit is now a HARD gate (`--omit=dev --audit-level=high`, 0 prod vulns today); non-blocking full-tree audit kept for visibility.
- pack-smoke CI job (npm pack -> install tarball -> verify ESM/CJS/CLI/serverless) + post-publish smoke step in release.yml (retry-install the published version).
- release.yml now skips publish when the version already exists on npm — so the 8 backfilled tags (v0.11–v0.14, v0.16) won't paint Release runs red.
- test:unit is now a glob (`DATABASE_URL= tsx --test src/test/*.test.ts`) — no more hand-maintained 47-file list dropping new tests silently; test:watch un-staled to full glob.
- CLAUDE.md architecture map synced (adapters/, dialect.ts, nested-write.ts, pipeline-submittable.ts; LOC counts; E001-E016; seed fixture counts 5 orgs/8 users/10 posts/20 comments).
- Site /errors page documents E015/E016; README gained a Contributing section.
- migrate.ts self-referential @deprecated comment fixed; stale ~27kB size comments in workflows -> ~31kB.

Git tags backfilled: v0.11.0, v0.12.0, v0.13.0, v0.13.1, v0.13.2, v0.13.3, v0.14.0, v0.16.0 (annotated, on the correct version-bump commits, LOCAL — not yet pushed).

DELIBERATELY SKIPPED: CODE_OF_CONDUCT.md (Contributor Covenant text trips Anthropic's output content-filter — drop it or add it by hand outside the agent).

STILL OUTSTANDING (all P2, optional, not blocking a release):
- builder.ts (~4.4K LOC) extraction into where-compiler/relation-subquery modules.
- Move tracked sprint/strategy/audit scaffolding out of the public repo tree.
- One seeded generative fuzz test; ratchet coverage floors; append (TURBINE_E0NN) to error message strings.
- MANUAL (Kirby): set NPM_TOKEN repo secret -> activates release.yml provenance publish + @next channel; push tags + branch.

Final verification on the branch: 1264 tests / 932 pass / 332 skip / 0 fail; typecheck + lint + build + site build clean; size 31.19/22.29 kB vs 35/25; error-codes gate green.
