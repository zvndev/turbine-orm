# Turbine ORM × PowDB × BataDB — Audit & Unified Strategy

**Date:** 2026-06-09 · **Inputs:** 21-agent audit/exploration workflow (4 release auditors + adversarial verifiers on every medium+ finding, 2 read-only project explorers, 2 assessors). All findings below survived adversarial re-verification; zero were refuted.

---

## TL;DR

1. **v0.19.0 shipped clean mechanically, but the audit found 3 high-severity bugs** — one breaks the new-user CLI happy path entirely, and two mean the release's headline fix ("unknown operators throw instead of silently returning wrong rows") still has silent-wrong-rows holes. **Ship v0.19.1 this week.**
2. **"Turbine 2 for PowDB" is real but smaller than the dream — and that's fine.** The full API cannot port (≈⅓ never will); the Prisma-like core ports cleanly as a *sibling package* on an extracted `turbine-core`. PowDB is an **SQLite competitor, not a Postgres competitor** (its own AGENTS.md says so), and the winning pitch is "the only SQLite-class embedded DB with a first-class Prisma-like typed ORM" — not "faster than Postgres."
3. **"Massive gains vs Postgres" is currently indefensible.** Zero Postgres numbers exist in the PowDB repo (the harness exists; it was never run). Architecturally, ORM-shaped server traffic rides exactly the path where PowDB's wins don't apply (TCP, all-string wire, global write lock, fsync-bound ~290 durable writes/sec) — and Turbine's signature single-query nested read is unimplementable on PowDB today, so the flagship workload would regress to N+1. Embedded/in-process is where PowDB shines (54ns point lookups, 3–10× SQLite on scans/aggregates).
4. **BataDB is far more real than "planned"** — a live Neon-fork stack on Fly.io (109 endpoints, CoW branching, scale-to-zero, PITR-via-branch, self-serve signup, internal review 6.5/10). Its moat *is* the Turbine pairing, and that pairing is currently broken at the seams (CLI/UI reference a nonexistent `@batadata/turbine` package; benchmarks pinned to turbine-orm 0.3.0). **PowDB-on-BataDB is a later, gated lane** — zero code relation today, and PowDB lacks online backups/replication.
5. **Sequence: v0.19.1 → BataDB×Turbine launch sprint → PowDB engine ask-list + turbine-core extraction → turbine-powdb MVP → managed-PowDB beta on BataDB.**

---

## Part 1 — v0.19.0 release audit

### What's verified good

- **Release mechanics:** tag `v0.19.0` → merge `64d3eec`; npm `latest` = 0.19.0 (published 2026-06-09 04:49 UTC); build/typecheck/lint/test:unit all green (827 unit, 0 fail); CHANGELOG entry accurate and complete vs `v0.18.0..v0.19.0`; tarball hygiene good (364 kB, no tests/maps/examples).
- **Site redeployed with the release** (sitemap lastmod 1 min after publish, matches repo HEAD). `/cli` Studio docs are fully ORM-native — zero stale refs to the removed SQL tab on any fetched page.
- **Studio security posture survived the rebuild intact** (independently reviewed): every `/api/*` route behind constant-time token check; all identifiers validated against introspected metadata before SQL; `BEGIN READ ONLY` + `set_config` timeout; loopback default; CSP/security headers; no XSS (textContent/escapeHtml throughout); per-session rate limiting.
- **Both headline fixes are in the shipped dist**, and the to-one-limit fix verifies clean at depth 3 with perfect param alignment.
- Package consumer surface: 59 consistent exports across ESM/CJS + subpaths; `.d.ts` passes `tsc --strict` with `skipLibCheck:false` under NodeNext **and** bundler resolution.

### Findings (all adversarially confirmed)

**HIGH — fix in v0.19.1:**

| # | Finding | Root cause | Fix |
|---|---|---|---|
| H1 | **CLI cannot load its own scaffolded `turbine.config.ts` on any supported Node** — `init → generate` happy path is broken for every new user, and the error misdiagnoses it as "tsx not installed" (installing tsx doesn't help) | `dist/cli/loader.js` calls `module.register('tsx/esm', cwd)` which throws "tsx must be loaded with --import" on Node ≥20.6; bare catch maps it to `missing`. Unit test only asserts status is "one of the documented codes" — so it shipped green | Use tsx's programmatic API (`tsImport`/`register` from `tsx/esm/api`); stop swallowing the real error; have `init` mention the tsx requirement or scaffold `.mjs` when tsx is absent |
| H2 | **SQL-cache hit bypasses the new unknown-operator validation** — after any equality query warms the cache for a field set, a misspelled operator silently executes `col = $1` with the operator object as the value. The exact bug the release headlines as fixed, still live for every consumer with default `sqlCache:true` | Guard added only to `buildWhereClause` (cache-miss path); `fingerprintWhere` maps unmatched objects to the equality fingerprint; `collectWhereParams` (runs every invocation) has no guard | Mirror the guard in `collectWhereParams` and/or give unmatched objects a distinct fingerprint; regression test must warm the cache first |
| H3 | **Nested relation `where` is equality-only on the server, but the new Studio UI offers full operator filters at every nesting level** — nested `contains`/`gt`/OR silently returns wrong rows (or a confusing "Unknown column \"OR\"" error). Contradicts the CHANGELOG claim of "filters (where) at every level" | `buildRelationSubquery` where-handling does bare `alias.col = $N` per entry (builder.ts:3748–3756; manyToMany 3913–3924); the a08bbe9 guard doesn't apply there | Route nested where through `buildWhereClause` with alias-prefixed columns; short-term: throw on operator objects in nested where + restrict Studio nested-where UI to equals |

**MEDIUM — bundle into v0.19.1:**

- **README (npm front page) still documents the removed raw-SQL Studio** — "Data/Schema/SQL/Builder tabs… ad-hoc SELECTs", SQL saved queries, the dead `SELECT/WITH-only parser` guard, and the pre-0.17 `SET LOCAL` claim that 0.17.0 itself fixed. Directly contradicts the release headline.
- **Operator guard rejects legit class-instance equality values** — `Buffer` for bytea now throws `Unknown operators "0","1"…` cold (but works after cache warm, per H2 — inconsistent both ways). Exempt `Buffer.isBuffer` + non-plain-prototype objects.
- **`WhereClause`/`WhereOperator`/`WhereValue` not exported from package root** (TS2305; no deep-import escape hatch). Audit for other omissions (e.g. `HavingClause`).
- **`/api/builder` ignores `--schema`** — Data tab reads `acme.users`, Query tab silently reads `public.users`. Fix: `set_config('search_path', $1, true)` in the builder transaction.
- **Site version strings say v0.18/v0.18.0** (homepage hero badge + every docs sidebar) while npm serves 0.19.0. Fix `site/app/page.tsx:160`, `:172`, `Sidebar.tsx:158`; long-term, import version from root package.json at build time.
- **CLAUDE.md Studio section stale on three counts** (SET LOCAL claim, `isReadOnlyStatement` described as active, old tab list) and omits the new `/api/builder` surface — misleads future agents.

**LOW/NIT (sweep opportunistically):** `init` scaffold uses `timestamptz` which `defineSchema` rejects; `--version` prints nothing; schemaless `TurbineClient` crashes with opaque TypeError; `limit: 0`/`orderBy: {}` on hasMany relations is the same orphaned-param crash class as the bdeb4fa fix; legacy raw-SQL saved queries silently destroyed on load (drop with a notice instead); stale compiled artifacts of deleted `src/query.ts` ship in the tarball (~286 kB); homepage doesn't market the v0.19 headline; site still mentions the dead statement-stacking guard; AGENTS.md playbook minor drift; "one dependency" vs two declared (`pg` + `@types/pg`).

### v0.19.1 patch plan (1–2 days)

1. H1 tsx loader rewrite + honest error + init guidance (this is the new-user front door — highest priority).
2. H2 + H3 query-builder fixes with cache-warm and nested-operator regression tests; Buffer/class-instance exemption rides along.
3. `/api/builder` search_path fix.
4. README Studio rewrite + root type exports + site version bump + CLAUDE.md/AGENTS.md/studio.ts-header drift cleanup + prune stale dist artifacts (`clean` before publish build).
5. Full suite + live-DB gate, publish, `vercel --prod`, tag.

---

## Part 2 — Turbine × PowDB: the "Turbine 2" question

### What PowDB actually is (verified)

Pure-Rust single-node embedded DB + optional TCP server, ~45K LOC, 8 crates, **v0.4.6 in release prep, ~2 months old**, genuinely well-engineered (691 tests, 3 fuzz targets, candid docs). Thesis: no SQL translation tier — PowQL's AST *is* the plan tree; mmap'd pages + compiled byte-level predicates. **Explicitly positioned against SQLite, not Postgres** ("no Postgres wire protocol… deliberate design decision"; non-goals: replication, fine-grained ACLs, UDFs/triggers).

PowQL surface is bigger than expected — joins (hash + nested-loop), group-by + having, window functions, materialized views, EXPLAIN, scalar fns, transactions (single-level). The JS client `@zvndev/powdb-client` 0.3.5 is published.

### The five hard gaps (block ORM parity, not polish)

1. **No wire parameterization** — the only query message is a raw PowQL string; `$params` parse but evaluate to `Empty`. An ORM must use client-side escaping — the pattern Turbine's own rules forbid.
2. **No RETURNING, no generated IDs, no uuid/bytes literal syntax** — `create()` cannot learn what it created.
3. **Transactions are engine-global across all server connections** (handler has no per-connection state; docs claim otherwise) — two pooled connections corrupt each other's transactions. An `explicit-transactions` branch exists, unmerged. No savepoints → no nested `$transaction`.
4. **No introspection + untyped lossy wire** — all values arrive as strings (NULL ambiguous with `'null'`, bytes destroyed), no describe statement → `turbine pull` has nothing to read; every result needs metadata-driven coercion.
5. **No constraints reachable from PowQL** — no PK/unique/FK/CHECK/defaults; the whole E008–E016 error taxonomy and constraint-based upsert have no server-side source.

Plus: **no JSON type, no json_agg, no correlated subqueries** → Turbine's signature single-query nested read is unimplementable; `with` becomes a batched IN-loader (k queries per nesting level, client-side regroup). And the type system caps rows at 4070 bytes (no >4KB text, no decimal/arrays/enums/vector).

### Feature matrix (32 features assessed)

- **maps-today (13):** CRUD reads, where operators (incl. insensitive via `lower()`, OR/AND/NOT), relation some/every/none (rewrites to uncorrelated IN-subqueries), orderBy/limit/offset/cursor, distinct (via window fns), select/omit, aggregate/groupBy/having (best-mapped chunk — PowQL even has window fns Turbine doesn't expose yet), atomic update operators, optimistic locking, createMany, middleware/$on/empty-where guard, codegen skeleton, Studio (rides along once core ports).
- **needs-powdb-work (8):** findUnique (unique indexes from PowQL), create-returning-row, upsert semantics, nested writes + $transaction (per-connection tx), pipeline (protocol batching), introspection/pull, migrations polish.
- **rethink (8):** nested `with` implementation (API survives, json_agg strategy doesn't), pgvector (structurally impossible at 4070-byte rows), sessionContext/RLS, realtime, observability, typed-raw escape hatch (safety model inverts), streaming, constraint-error taxonomy.
- **drop (3):** JSONB/array filters, full-text search, serverless subpath.

### Architecture decision: sibling package on extracted core — not a fork, not an in-repo adapter

Measured coupling in `builder.ts` (4,186 LOC): ~565 LOC of param/fingerprint caching is meaningless on a no-params wire; ~730 LOC of json_agg subqueries is unimplementable; CRUD is built on RETURNING/ON CONFLICT; `pg.Pool`/`QueryResult` thread through everything. **~25–30% conceptually reusable, near-zero line-reusable** — kills the fork. The existing `./adapters` seam covers only migration-locking/introspection/timeout SQL (stretches to CockroachDB/Yugabyte, "not one inch further"); the `dialect.ts` seam assumes SQL grammar + positional params + RETURNING — PowDB violates every axiom. An in-package backend would also break the "no runtime deps beyond pg" invariant and chain a stable product to a pre-1.0 engine.

**Plan:** extract `@zvndev/turbine-core` (query arg types minus PG-specific filters, the entire `WithResult`/`RelationDescriptor` inference machinery — ~85% of types.ts is backend-agnostic — errors minus constraint codes, defineSchema DSL, generate skeleton, LRU, guards, middleware contract). `turbine-orm` re-adopts it (pays for itself); **`turbine-powdb`** builds on it with a PowQL emitter, powdb-client executor, metadata-driven coercion, batched-IN relation loader.

### MVP scope (zero engine changes, 8–12 engineer-weeks)

Code-first only: defineSchema → generate (types + metadata that doubles as the wire-coercion table — this alone beats hand-writing `queryTyped` schemas and is the product hook); reads with full where/orderBy/select/omit; aggregates/groupBy/having; `with` at any depth via batched IN-loader **documented honestly as k queries**; writes with client-generated IDs + counts; optimistic locking; escaping safety; `migrate push`. Deferred until engine features land: transactions, nested writes, upsert, pipeline, pull, Studio. Ship as **explicitly experimental**.

### The engine ask-list (the negotiation with the PowDB roadmap, ~6–10 Rust-weeks)

Priority order: **(1)** wire-level prepare/bind, **(2)** RETURNING + generated IDs + uuid/datetime/bytes literals, **(3)** merge per-connection transactions, **(4)** describe/introspection + type-tagged wire values, **(5)** unique indexes from PowQL, **(6)** protocol batching. Full "Turbine 2" parity ≈ **5–7 engineer-months combined** — and pgvector/JSON/RLS/realtime never port.

**The ambitious play:** propose a PowQL **nested-read primitive** (engine-native child-row grouping — PowDB's AST-is-the-plan design is actually *well-suited* to this, better than SQL is). That single engine feature would make Turbine's signature DX portable *and* give PowDB a headline no SQLite-class engine has. This is the one place "ambitious" and "realistic" fully overlap.

---

## Part 3 — Performance: would we see massive gains on PowDB?

**Honest answer: no — and for Turbine's flagship workload, probably inverted.** Evidence:

- Every recorded PowDB number is **embedded in-process vs SQLite with durability off** (54ns point lookup, 3–10× scans/aggregates — real, but a different deployment model and a different competitor). The repo has a postgres:16.4 comparison harness and **zero Postgres rows in results.csv**.
- Turbine's own benchmarks show the wire is the bottleneck: fastest measured op ≈ 34–48ms over a real connection — ~6 orders of magnitude above PowDB's 54ns engine time. The engine isn't where ORM latency lives.
- ORM traffic rides PowDB's weakest path: TCP round trip per statement, no pipelining (Turbine's 5-query pipeline = 1 RTT on PG, 5 on PowDB), all-string serialization + client coercion, one writer behind a global RwLock, durable autocommit ~290 rows/sec (PowDB's own README).
- The L3 nested scenario (10 users → posts → comments): 1 query on Postgres, ~61 round trips on PowDB today.

**Where PowDB genuinely wins (market this):** embedded/in-process Rust (no syscalls — untouchable by any networked DB), single-table scans/aggregates, cold start/footprint/zero-config (one static binary — dev, edge, CI, on-device), batched ingest with one fsync (~15.6K rows/sec).

**Claim discipline** (pre-empting the HN takedown): every defensible PowDB claim today is *vs SQLite, embedded, durability disclosed*. Never compare embedded-PowDB to networked-Postgres. Never present durability-off numbers without the fsync caveat (the ~290/sec figure is in PowDB's own README — the receipts for the takedown exist). Don't say "supports transactions" in a multi-client context until per-connection tx merges. The April→June trajectory story (5 wins/10 losses → 15/15 vs SQLite, closing a 1267× deficit) is genuinely impressive and *is* defensible.

**Before any public Turbine-on-PowDB claim:** run the fair suite — same machine, both as localhost servers, Lane A durable (WalSyncMode::Full vs synchronous_commit=on, the only headline lane) + Lane B labeled non-durable, Turbine's existing seed + 10 scenarios + write/concurrency/transaction lanes, p50/p95/p99, DNFs reported not omitted. Pass bar for "gains": win Lane A at p95 under ≥16 concurrent clients.

---

## Part 4 — BataDB: the platform piece

### State (much further along than "planned")

Live on Fly.io today (health checks pass): Neon-fork data plane (pageserver, 3 safekeepers, SNI proxy with wake-on-connect) + 39.5K-LOC TypeScript control plane — 109 endpoints incl. 20 Neon-compatible, CoW branching, scale-to-zero + autoscaler, PITR-via-branch, query insights, teams/RBAC, audit log, Stripe usage tracking, self-serve signup, `bata` CLI, admin UI on Vercel. The June-8 ADR killed the AWS-v2 rewrite (its justifying benchmarks were loopback artifacts) and committed to hardening the Neon fork. Internal May review: 6.5/10, "real, working infrastructure software — not a demo."

### The Turbine pairing is the moat — and it's currently broken at the seams

- `bata` CLI + admin UI instruct `npm install @batadata/turbine` — **a package that doesn't exist** (real: `turbine-orm`). The headline onboarding flow fails as written.
- Benchmarks pin `turbine-orm@^0.3.0` (16 minors stale). README contradicts the June-8 ADR. `@batadata/serverless` v0.1.0 apparently unpublished. Docs ≈ 4 files, no getting-started.
- Launch gaps: billing cycle unfinished (nobody can pay end-to-end), PgBouncer follow-up pending, backups metadata-only, single-region/no-HA pageserver, plan-limit/abuse enforcement unproven.

### Standard + new thing: the right frame, with honest gating

**Lane 1 (now): BataDB = managed Postgres that pairs perfectly with Turbine.** "The vertical stack: database + ORM" — Neon-compatible API for migration, Turbine as the flagship DX. This is launchable within weeks and is the revenue/credibility engine.

**Lane 2 (gated): BataDB also hosts PowDB.** Zero code relation exists today, and that's correct — don't force it. Realistic shape: a "managed PowDB (beta)" lane — one Fly machine + volume per instance, powdb-server + TLS + password auth (powdb-example already proves this deployment shape). **Gates before offering it:** PowDB ships online/live backups (current backups corrupt live DBs), per-connection transactions merged, v0.5+ format-stability statement. PowDB-on-Neon-style-storage (WAL streaming into pageserver) is a research line, not a roadmap item.

The funnel: BataDB acquires Postgres users (standard, low-risk migration via Neon compat) → Turbine makes the DX sticky → PowDB lane is the adventurous offering for embedded/edge workloads, with Turbine-powdb as the shared DX layer. One client surface, three products.

---

## Part 5 — Sequenced roadmap

**Week 0 (now): turbine-orm v0.19.1** — the three highs + mediums above. The tsx-loader bug is silently zeroing out every new-user funnel the site/BataDB would drive.

**Weeks 1–4: BataDB×Turbine launch sprint** (highest leverage per hour of anything here)
1. Fix the `@batadata/turbine` package-name breakage in CLI + admin UI; bump benchmark pins to 0.19.x; fix README/ADR contradiction.
2. Finish the billing cycle end-to-end; publish `@batadata/serverless`; PgBouncer follow-up.
3. Getting-started docs + the "zero to connected database in 30 seconds" onboarding with Turbine front and center.
4. A "Works with BataDB" page on turbineorm.dev; a Turbine guide in BataDB docs (mirror the existing Neon guide).

**Weeks 2–6 (parallel, PowDB side): engine enablement**
5. File the 6-item ORM ask-list as PowDB issues; merge `explicit-transactions`; draft the PowQL nested-read primitive RFC.
6. Run the existing crates/compare harness **with Postgres enabled** — get private numbers before anyone claims anything publicly.

**Months 2–3: turbine-core extraction + turbine-powdb MVP** (8–12 wk, experimental flag) — ship when the first two engine asks (wire params, RETURNING+IDs) land; the MVP works without them but those two remove the biggest asterisks.

**Quarter 2: managed PowDB beta on BataDB** — gated on online backups + per-connection tx; fair benchmark suite published alongside (Lane A/Lane B discipline).

**Standing rule across all three:** version strings sourced from package.json at build time; release checklist includes README/site/CLAUDE.md drift check (three separate stale-docs findings this release trace to the same gap).

---

## Appendix: source reports

Full structured reports (4 audits with verification verdicts, PowDB exploration, BataDB exploration, API mapping matrix, perf assessment) archived from workflow `wf_44e6c201-3f1`; key file citations inline above. PowDB findings reference its repo at `release/0.4.6`; BataDB at commit ~2026-06-08 (Nexus→BataDB rebrand).
