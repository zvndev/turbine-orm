# Turbine ORM — Audit Report

Source: investor-grade product review run via `/product-review` on 2026-04-09.
Subject: `turbine-orm` v0.8.0 + `turbineorm.dev` docs site.
Rating: **8.1 / 10**

---

## 1. What it is

TypeScript ORM for PostgreSQL, Prisma-shaped API (`findMany` / `findUnique` / `with` / `where`), compiles nested relation queries into a single SQL statement using `json_agg` + `json_build_object` + correlated subqueries. Library is ~8,122 LOC TypeScript, one runtime dep (`pg`), ESM+CJS dual publish, with an in-repo CLI (`init` / `generate` / `push` / `migrate` / `studio`), a read-only local Studio web UI, and a serverless adapter for Neon / Vercel Postgres / Cloudflare. Published on npm at v0.8.0, site at turbineorm.dev.

## 2. Is it real? — Yes

Every claimed feature is wired up, not stubbed:

- findMany / findUnique / findFirst / create / createMany / update / delete / upsert / updateMany / deleteMany / count / aggregate → `src/query.ts:913–2064`
- findManyStream with DECLARE CURSOR + speculative first-fetch → `src/query.ts:1224–1299`
- SQL migrations with `-- UP`/`-- DOWN`, SHA-256 checksums, `pg_try_advisory_lock()`, per-migration tx → `src/cli/migrate.ts`
- Introspection + code generation → `src/introspect.ts`, `src/generate.ts`
- Pipeline batching via real Postgres extended-query protocol → `src/pipeline-submittable.ts`
- Transactions + nested savepoints + isolation levels + timeout cleanup → `src/client.ts:627–729`
- Studio HTTP server with auth, read-only guard, SELECT-only parser → `src/cli/studio.ts`
- Serverless adapter accepting external pools → `src/serverless.ts`

**What isn't real yet:**
- Type-safe inference on `with` clause return types (documented limitation)
- The premium Studio UI redesign is authored at `src/cli/studio-ui.html` (3,909 lines) but not yet integrated into `studio.ts`

## 3. Differentiation

### Genuinely differentiated
1. **Single-query nested relations by default with one runtime dep.** Drizzle's RQB uses the same json_agg algorithm but Drizzle is a much larger surface. Turbine at ~110 KB with `pg` only is unique.
2. **Read-only, security-hardened Studio.** No other TS ORM ships a Studio that is explicitly read-only. Loopback default, random 24-byte token, SameSite=Strict HttpOnly cookies, `BEGIN READ ONLY` + `SET LOCAL statement_timeout = '30s'`, SELECT/WITH parser, statement-stacking blocked.
3. **SQL-first migrations with checksum drift detection + advisory locks.** Closer to Sqitch/golang-migrate ergonomics than any TS ORM peer.
4. **Heterogeneous pipeline batching** via real extended-query protocol.
5. **External-pool edge mode** with no type-parser side effects.
6. **Typed error hierarchy mapped from SQLSTATE** with `readonly isRetryable` const signals.

### Table stakes
Prisma-like API shape, ESM+CJS dual publish, code-gen from introspection, transactions with savepoints, raw SQL tagged templates, middleware hooks, atomic update operators, empty-where guard.

## 4. Security Audit

**Zero CRITICAL / HIGH. Two MEDIUM + two LOW. No exploitable vulnerabilities.**

### MEDIUM
- **M1 — Studio auth token in URL query string on first request.** `src/cli/studio.ts:139`. 192-bit entropy, immediately moved to HttpOnly cookie, but URL can land in shell history. Acceptable for local dev tool.
- **M2 — Non-loopback binding is warning-only, not blocking.** `src/cli/index.ts:1123–1130`. Combined with 192-bit token, brute force infeasible, but warning could be missed in CI logs. Recommendation: require `TURBINE_STUDIO_ALLOW_REMOTE=1` env var.

### LOW
- L1 — `statement_timeout = 30s` in Studio could be tighter.
- L2 — Request body limit is 1 MB. Reasonable.

### Clean bill on
- SQL injection — every identifier via `quoteIdent()`, every value `$N`-parameterized, `escapeLike()` on LIKE operators, `toColumn()` rejects unknown field names at metadata layer.
- XSS in Studio — all cell rendering via `createTextNode`. No untrusted `innerHTML`.
- CSRF — SameSite=Strict + Origin validation.
- Statement stacking — `isReadOnlyStatement()` strips comments, rejects non-trailing `;`.
- Secrets — zero hardcoded credentials. DATABASE_URL never logged.
- Dangerous JS — zero eval / new Function / dynamic require.
- Dependency supply chain — one runtime dep (`pg@^8.13.1`).

## 5. Engineering Quality

### What's great
- Error handling is exemplary. 13–15 typed error classes with stable codes, SQLSTATE mapping, PII-safe mode, `isRetryable` const signals.
- Transaction safety — `releaseOnce()` guard, nested `SAVEPOINT`, timeout destroys connection, `try/finally` consistent.
- Migration safety — advisory lock, SHA-256 checksums, legacy djb2 auto-upgrade, per-migration atomic tx.
- SQL template cache — LRUCache bounded at 1,000 entries, FNV-1a 64-bit fingerprinting.
- Zero TODO/FIXME debt in src/. Clean git history.
- Benchmarks are honest — corrected downward when initial pitch didn't survive scrutiny.

### What's bad
- **Lint currently fails** — `npm run lint` reports 34 errors / 105 warnings / 67 infos. Not a CI blocker. Needs to flip to gating.
- **2 `any` leaks in public API** — `src/schema-builder.ts:436`.
- **Coverage thresholds are low** — 55% lines/functions/statements (industry norm 80%+). Config excludes exactly the user-facing surfaces (CLI, generate, introspect, serverless, index).
- **Hardcoded advisory lock ID** (`8_347_291`) in `src/cli/migrate.ts:268`. Two separate databases under the same cluster will contend. Derive from database name.

### What needs work
- **Type-safe `with` return types** — biggest engineering gap. Runtime nests correctly, `*With*` interfaces exist, but `.with({ posts: true })` doesn't narrow return type. Deferred — too big for this sprint.
- Observability hooks — no built-in OpenTelemetry, no cache hit-rate metrics.
- Middleware args typed as `Record<string, unknown>`.

## 6. Competitive Landscape — short version

Closest head-to-head: **Drizzle's Relational Query Builder**. Same json_agg algorithm. Turbine wins on footprint + read-only Studio; Drizzle wins on type-safe `with` inference (today). Closing the inference gap would eliminate the #1 reason a technical evaluator picks Drizzle over Turbine.

## 7. Before-launch punch list

1. Gate lint in CI
2. Kill the 2 `any` leaks
3. Fix hardcoded advisory lock ID
4. Integrate premium Studio UI (`studio-ui.html` is authored, needs wiring)
5. Clarify README "Studio is planned" — Studio IS available and read-only-by-design is a feature
6. Add test for CLI flag parsing (`--port` / `--host` / `--no-open`)
7. Version bump + CHANGELOG entry
8. Single release commit → `npm publish` + `git push` + `vercel --prod`

## 8. Strategic advice (launch strategy)

1. **Lead with the wedge:** "The only Postgres ORM with a read-only Studio your DBA will approve."
2. **Close the `with` inference gap** before 1.0 — defer beyond this sprint.
3. **Write the head-to-head with Drizzle yourself** — honest, not hostile.
4. **Get the first three real users by hand.** White-glove migration from Prisma.
5. **Launch on HN with the Studio as the hook**, not "ORM #47."

## 9. Rating — 8.1 / 10

Strong engineering with a clear, defensible wedge and honest self-assessment culture. Loses points for the known `with` inference gap, for a Studio UI currently undersold, and for small-but-telling hygiene issues. None are structural — all week-of-work fixes. This is **one release away** from being a 9, and the release it needs is named and scoped.
