# Sprint Plan — Turbine ORM v0.9.0 "Studio Premium"

Generated: 2026-04-09
Based on: `AUDIT-REPORT.md` (product review, 8.1/10)

## Sprint Goal

Ship **v0.9.0 "Studio Premium"** — integrate the frontend-agent-designed premium Studio UI, fix the engineering hygiene findings from the product review that are small and high-value, and cut a clean release (library + site + CHANGELOG + version in a single commit, then `npm publish` + `vercel --prod`).

## Explicit non-goals (deferred beyond this sprint)

- **Type-safe `with` return type inference.** The #1 adoption blocker per the review, but genuinely a week of conditional-type engineering. Track it in a GitHub issue, defer to v1.0.
- **Coverage threshold raise + stop excluding user-facing files.** Would be a second multi-day project. Leave as documented gap.
- **Docs pattern guides** (soft-delete, multi-tenant, troubleshooting). Separate content sprint.
- **OpenTelemetry / observability hooks.** Separate engineering sprint.

## Success Criteria

- [ ] All P0 issues resolved
- [ ] All P1 issues resolved
- [ ] `npm run build` clean (ESM + CJS)
- [ ] `npm run typecheck` clean
- [ ] `npm run lint` clean (0 errors — warnings in test files acceptable)
- [ ] `npm run test:unit` green (486+ tests)
- [ ] Studio Data / Schema / SQL / Builder tabs all functional
- [ ] Saved queries round-trip through the new UI
- [ ] `/api/builder` endpoint verified
- [ ] `CHANGELOG.md` entry written
- [ ] `package.json` version bumped to 0.9.0
- [ ] `site/app/cli/page.mdx` Studio section refreshed
- [ ] Single clean release commit ready to push + publish + deploy

---

## Dev Tracks

### Track 1: Studio Premium UI Integration

**Owner:** Dev Agent 1 (worktree)
**Files touched:**
- `src/cli/studio.ts` (wire HTML from generated file)
- `src/cli/studio-ui.html` (source of truth — do not delete)
- `src/cli/studio-ui.generated.ts` (NEW — build artifact)
- `scripts/build-studio-ui.mjs` (NEW — codegen script)
- `.gitignore` (add the generated file)
- `src/test/studio.test.ts` (add endpoint tests)

**Files you must NOT edit (other tracks own these):**
- `package.json` — Track 3 owns the version bump and will add the `prebuild` script that invokes your codegen
- `src/cli/migrate.ts` — Track 2
- `src/schema-builder.ts` — Track 2
- `README.md`, `CHANGELOG.md`, `site/**` — Track 3

**Tasks:**

- **TASK-1.1 (P0): Codegen script for Studio HTML.**
  - Create `scripts/build-studio-ui.mjs`
  - Reads `src/cli/studio-ui.html`
  - Writes `src/cli/studio-ui.generated.ts` with:
    ```typescript
    // AUTO-GENERATED from src/cli/studio-ui.html. Do not edit by hand.
    // Regenerate via: node scripts/build-studio-ui.mjs
    export const STUDIO_HTML: string = <JSON.stringify of file contents>;
    ```
  - `JSON.stringify` handles all backtick / `${}` / backslash / quote escaping for free.
  - Script must be idempotent and resolve paths via `import.meta.url`.

- **TASK-1.2 (P0): Wire the generated HTML into studio.ts.**
  - Replace the existing inline `STUDIO_HTML` constant in `src/cli/studio.ts` with `import { STUDIO_HTML } from './studio-ui.generated.js';`
  - Delete the old basic inline HTML constant.
  - Keep `Content-Type: text/html; charset=utf-8` + security headers.

- **TASK-1.3 (P0): Add `src/cli/studio-ui.generated.ts` to `.gitignore`.**
  - Run the codegen yourself so the file exists locally for typecheck/tests.

- **TASK-1.4 (P0): Verify the search endpoint fix.**
  - Previous session applied a fix in `src/cli/studio.ts::apiTableRows` that builds separate WHERE clauses per query (main vs count) with correct `$N` parameter indices.
  - Confirm: main query uses `$3` for the search pattern (after `$1=limit`, `$2=offset`); count query uses `$1` for the same pattern.
  - If wrong, fix it.

- **TASK-1.5 (P0): Add test coverage for new Studio backend endpoints.**
  - Extend `src/test/studio.test.ts` with unit tests for:
    - `apiBuilder` executing a `FindManyArgs`-shaped request (mock pool — no DB; verify generated SQL shape)
    - `apiListSavedQueries` / `apiCreateSavedQuery` / `apiDeleteSavedQuery` — temp dir for `.turbine/studio-queries.json`, round-trip verify
    - `apiTableRows` with `search` param — verify WHERE clause + param binding
  - Pure unit tests, mock the pool like `src/test/helpers.ts`.

- **TASK-1.6 (P1): Make the Studio module exports testable.**
  - If helpers like `isReadOnlyStatement`, `resolveColumnName`, `escapeLikePattern` aren't exported, export them so tests can hit them directly.

**Completion signal:** Commit with message `Track 1: integrate premium Studio UI + verify backend endpoints`. Include: codegen script, studio.ts changes, .gitignore update, new tests. **Do not commit `src/cli/studio-ui.generated.ts`** — it's build output.

**Quality bar:**
- `npm run typecheck` passes
- Test file compiles and the new tests pass against a mock pool
- ALWAYS read files before modifying them
- Match existing code style

---

### Track 2: Engineering Hygiene

**Owner:** Dev Agent 2 (worktree)
**Files touched:**
- `src/cli/migrate.ts` (advisory lock derivation)
- `src/schema-builder.ts` (2 `any` leaks)
- `src/test/cli-flags.test.ts` (NEW — smoke test)
- Any test file with remaining auto-fixable biome warnings

**Files you must NOT edit:**
- `src/cli/studio.ts`, `src/cli/studio-ui.html`, scripts/, .gitignore — Track 1
- `src/cli/index.ts` — CLI flag parsing is already in place; only test it
- `package.json`, `README.md`, `CHANGELOG.md`, `site/**` — Track 3

**Tasks:**

- **TASK-2.1 (P1): Derive advisory lock ID from database name.**
  - `src/cli/migrate.ts` currently hardcodes `pg_try_advisory_lock(8347291)` (around line 268 — read to confirm).
  - Fix: derive a stable 32-bit integer from the database name via FNV-1a:
    ```typescript
    function deriveLockId(databaseName: string): number {
      let hash = 0x811c9dc5;
      for (let i = 0; i < databaseName.length; i++) {
        hash ^= databaseName.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
      }
      return hash >>> 1; // positive int4
    }
    ```
  - Read the current database name via `SELECT current_database()` or pull from connection config. Match existing code style.
  - Update any test asserting on the old lock ID.

- **TASK-2.2 (P1): Kill the 2 `any` leaks in `src/schema-builder.ts` (around line 436).**
  - Read the file first. Replace with precise types.
  - If the fix is non-trivial and the `any` is load-bearing for generics, leave a `// biome-ignore lint/suspicious/noExplicitAny: <reason>` comment and document why in the commit message.

- **TASK-2.3 (P1): Add `src/test/cli-flags.test.ts`.**
  - If `parseArgs` from `src/cli/index.ts` is not exported (it probably isn't), use `child_process.spawnSync` to run the built CLI:
    - `node dist/cli/index.js --help` → assert stdout mentions `--port`, `--host`, `--no-open`
    - Also assert exit code is 0
  - Keep it small. It's a regression guard, not a fuzz test.

- **TASK-2.4 (P2): Auto-fixable biome issues.**
  - Run `npx biome check --write` in your worktree.
  - Fix any remaining errors in non-test files. Warnings in test files acceptable for this sprint.

**Completion signal:** Commit with message `Track 2: hygiene — advisory lock ID, any leaks, CLI flag smoke test`.

---

### Track 3: Release Prep + Docs

**Owner:** Dev Agent 3 (worktree)
**Files touched:**
- `package.json` (version bump + prebuild script)
- `CHANGELOG.md` (new v0.9.0 entry)
- `README.md` (rewrite Studio section)
- `site/app/cli/page.mdx` (Studio section)

**Files you must NOT edit:**
- `src/**` — Tracks 1 and 2
- `.gitignore`, `scripts/**` — Track 1

**Tasks:**

- **TASK-3.1 (P0): Bump version and wire prebuild script.**
  - `package.json`: `"version": "0.8.0"` → `"version": "0.9.0"`
  - Add `"prebuild": "node scripts/build-studio-ui.mjs"` in the `scripts` block immediately before the existing `build` script.
  - Do not touch other scripts.
  - **Note:** Track 1's codegen script won't exist in your worktree — do not run the build. Just wire it in.

- **TASK-3.2 (P0): Write `CHANGELOG.md` v0.9.0 entry.**
  - Lead with Studio Premium UI headline.
  - Match existing CHANGELOG style (read top of file first).
  - Sections:
    - **Added:** Premium Studio UI (Data/Schema/SQL/Builder tabs, Cmd+K palette, saved queries, visual query composer with live TS preview, full-text search, sortable tables, JSON modal, toasts, keyboard shortcuts). Four new backend endpoints: `/api/builder`, `/api/saved-queries` (GET/POST/DELETE), search param on `/api/tables/:name`.
    - **Changed:** Advisory lock ID derived from database name (fixes cluster-wide contention). README Studio section clarified — read-only is a design choice.
    - **Fixed:** 2 `any` leaks in `schema-builder.ts`. Search endpoint parameter-index bug. Biome template-literal lint errors in `query.ts`.
    - **Security:** Studio posture unchanged — loopback default, 24-byte token, SameSite=Strict HttpOnly cookies, BEGIN READ ONLY + statement_timeout, SELECT/WITH parser, statement-stacking block. No CVEs from product review.

- **TASK-3.3 (P0): Rewrite README Studio / Limitations section.**
  - Read `README.md` end-to-end first.
  - Replace any "planned" / "not yet available" text around Studio.
  - Write a section that headlines read-only as a feature: "the only Postgres ORM with a Studio your DBA will approve."
  - List feature set (Data/Schema/SQL/Builder tabs, saved queries, Cmd+K).
  - Boot instructions: `DATABASE_URL=... npx turbine studio [--port N] [--host H] [--no-open]`
  - Under 40 lines, match existing voice.

- **TASK-3.4 (P1): Update `site/app/cli/page.mdx` Studio section.**
  - Read first. Rewrite to match new README voice.
  - Add code block for boot command.
  - Mention the tabs + saved queries + Cmd+K palette.
  - Match existing MDX style.

- **TASK-3.5 (P2): Landing page alignment.**
  - If `site/app/page.mdx` mentions Studio, align with new messaging. Else skip.

**Completion signal:** Commit with message `Track 3: v0.9.0 release prep — version + CHANGELOG + README + site Studio refresh`.

---

## File Ownership (Conflict Prevention)

| File | Owner |
|------|-------|
| `src/cli/studio.ts` | Track 1 |
| `src/cli/studio-ui.html` | Track 1 |
| `scripts/build-studio-ui.mjs` | Track 1 |
| `src/cli/studio-ui.generated.ts` | Track 1 (gitignored) |
| `.gitignore` | Track 1 |
| `src/test/studio.test.ts` | Track 1 |
| `src/cli/migrate.ts` | Track 2 |
| `src/schema-builder.ts` | Track 2 |
| `src/test/cli-flags.test.ts` | Track 2 |
| test files with biome warnings | Track 2 |
| `package.json` | Track 3 |
| `CHANGELOG.md` | Track 3 |
| `README.md` | Track 3 |
| `site/app/cli/page.mdx` | Track 3 |
| `site/app/page.mdx` | Track 3 |

**Expected merge conflicts:** None. `package.json` is owned solely by Track 3.

---

## Phase 4: Merge order

1. Track 2 first (smallest, touches least)
2. Track 1 second (Studio — biggest)
3. Track 3 last (release prep needs codegen script from Track 1 for prebuild to work)
4. Verify: `node scripts/build-studio-ui.mjs && npm run build && npm run typecheck && npm run lint && npm run test:unit`

## Phase 5: Reviews

Five parallel review agents:
1. **PM Review** — task-by-task scorecard vs SPRINT-PLAN.md
2. **CEO Review** — does this move the product toward its wedge?
3. **Security Review** — any new vulnerabilities introduced?
4. **Code Quality Review** — error handling, typing, dead code
5. **UX Review** — Studio tabs, CLI output, docs site

## Phase 7: Ship

- Squash all sprint commits into ONE clean release commit
- Commit message: `v0.9.0 — Studio Premium + hygiene`
- `git push origin main`
- `npm publish`
- `cd site && vercel --prod`

## Manual actions required from user

- If 2FA required on npm publish, the CLI will prompt.
- If Vercel login expired, user may need to run `vercel login` interactively.
