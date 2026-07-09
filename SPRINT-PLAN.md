# Sprint Plan — Turbine ORM (post product-review)

Generated: 2026-07-09  
Based on: product-review findings (conversation) rebased on `sprint/v0.28.0-parity`  
Skipped (per Kirby): npm token rotation

## Sprint Goal

Close remaining **security honesty gaps** (MCP free-form SQL, Studio non-loopback warn-only) and **launch hygiene** (quickstart that works, broken examples script, peer/engines alignment) so 0.28 can ship with claims that match the code.

## Success Criteria

- [ ] MCP has no free-form user SQL execution path for EXPLAIN
- [ ] Studio/Observe refuse non-loopback host without `--allow-remote`
- [ ] Site quickstart documents tsx, `"type": "module"`, schema vs schemaFile, empty-DB path
- [ ] `npm run examples` works or is removed; dogfood still valid
- [ ] `mssql` peer range includes what we test (^12)
- [ ] Unit tests pass; docs match new flags/tool shapes
- [ ] CHANGELOG notes security + hygiene (PM consolidates after merge)

## Already done on branch (do not re-do)

- Bundle sizes green (~42 / ~33 kB) + marketing updated
- MCP page + CLI docs for migrate deploy / zod / views / destructive
- Sitemap includes engines, nested-writes, optimistic-locking, recipes, mcp
- 0.28 parity feature code + CHANGELOG draft

## Intentionally deferred (post-sprint backlog)

- Split `builder.ts` into WHERE / relation / DML modules
- Hard-gate MySQL/SQLite CI (`continue-on-error` removal)
- Third-party re-benchmark at 0.28
- Quarterly competitive copy refresh
- npm publish + vercel prod (manual / Kirby after sprint green)

---

## Dev Tracks (no overlapping file ownership)

### Track 1: MCP EXPLAIN lockdown — Security
**Files owned:**
- `src/cli/mcp.ts`
- `src/test/mcp.test.ts`
- `site/app/(docs)/mcp/page.mdx`

**Tasks:**
- [ ] TASK-01: Replace free-form `explain_query` `{ sql }` with schema-validated builder args (table + findMany-like where/orderBy/limit/select). Compile via `QueryInterface.buildFindMany` (Studio pattern). Run `EXPLAIN (FORMAT JSON)` only on compiled SQL + bound params.
- [ ] TASK-02: Reject unknown tables/fields; keep READ ONLY + statement timeout + semicolon not needed if no free SQL.
- [ ] TASK-03: Update `mcp.test.ts` — reject free-form / injection; happy path on mock or build-only where possible.
- [ ] TASK-04: Update MCP docs — remove false “no raw-SQL” if still accurate only after fix; document new tool input.

**Must NOT edit:** `src/cli/index.ts`, package.json, quickstart, studio docs.

---

### Track 2: Studio/Observe `--allow-remote` hard-fail — Security
**Files owned:**
- `src/cli/index.ts` (host gate + flag parse + help only for studio/observe)
- `src/test/cli-flags.test.ts` and/or `src/test/studio.test.ts` / `studio-security.test.ts` as appropriate
- `site/app/(docs)/studio/page.mdx`

**Tasks:**
- [ ] TASK-05: Non-loopback `--host` without `--allow-remote` → exit 1 with clear error (studio + observe).
- [ ] TASK-06: With `--allow-remote`, proceed + keep loud warning.
- [ ] TASK-07: Loopback defaults unchanged (`127.0.0.1`, `localhost`, `::1`).
- [ ] TASK-08: Parse `--allow-remote`; document in CLI help + studio page.

**Must NOT edit:** `src/cli/mcp.ts`, package.json, quickstart, mcp page.

---

### Track 3: Quickstart onboarding honesty — Docs
**Files owned:**
- `site/app/(docs)/quickstart/page.mdx`

**Tasks:**
- [ ] TASK-09: Document prerequisites: `tsx` devDep, `"type": "module"`, Node ≥ 18 (link engines for SQLite ≥ 22.5).
- [ ] TASK-10: Call out `schema` vs `schemaFile`.
- [ ] TASK-11: Two paths: existing tables → generate; empty DB → defineSchema → push → generate.
- [ ] TASK-12: Install block includes `npm i -D tsx`.

**Must NOT edit:** other site pages, src/, package.json.

---

### Track 4: Package hygiene — Chore
**Files owned:**
- `package.json` (scripts.examples + peerDependencies.mssql only)
- `examples/README.md` (create if needed)
- Optionally remove dead script only — do not invent large demos

**Tasks:**
- [ ] TASK-13: Fix or remove broken `"examples": "tsx examples/examples.ts"` (file missing). Prefer: remove script + add `examples/README.md` index of real demos; keep `dogfood`.
- [ ] TASK-14: Widen `peerDependencies.mssql` to include `^12` (align with devDependency `^12.7.0`).

**Must NOT edit:** src/, site/, CHANGELOG.

---

### Track 5 (PM after merge): Docs sync + CHANGELOG
**Files owned after merge only:**
- `CHANGELOG.md` (append Security / Docs notes under 0.28.0 if needed)
- README Studio/MCP bullets if they contradict new behavior
- `site/app/(docs)/cli/page.mdx` only if host flag / mcp tool shape missing

## Quality bar (all agents)

- Read before edit; match existing style (Biome, ESM, no new deps).
- Prefer tests that prove the gate without requiring a live DB when possible.
- Commit in worktree with message: `Track N: <summary>`.
- Do not push, publish, or force-push.
- Do not touch npm tokens / `.npmrc`.

## Merge order

1. Track 4 (package.json — least conflict risk)
2. Track 3 (docs quickstart)
3. Track 1 (mcp)
4. Track 2 (cli index — largest)
5. PM CHANGELOG / residual docs

## Verification after merge

```bash
npm run typecheck && npm run lint && npm run test:unit
npm run size   # must stay green
```
