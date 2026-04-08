# Turbine ORM — Strategic Launch Plan

> Updated: 2026-04-08 | Status: v0.7.1 published, pre-launch promotion

## Positioning

**One-liner:** "TypeScript Postgres ORM where deep nested queries autocomplete end-to-end and the same client runs on every Postgres host."

**Core differentiator:** Turbine is the only TypeScript ORM that combines (a) deep typed `with` inference — `users[0].posts[0].comments[0].author.name` autocompletes after a single `findMany` with no casts, (b) cursor streaming through nested relations, (c) typed Postgres errors with `isRetryable`, and (d) a driver-agnostic core that runs on Neon, Vercel Postgres, Cloudflare Hyperdrive, and Supabase from the same generated client. No re-engineering for the edge.

**Position PostgreSQL-only as a feature:** "We go deeper on PostgreSQL than any alternative." Don't apologize for it. Hasura, PostGraphile, and Supabase all bet on Postgres-only. The depth enables the speed and the type story.

---

## Target Audiences (Priority Order)

### 1. Prisma users on serverless (primary)
- **Who:** TypeScript developers deploying to Vercel Functions, AWS Lambda, Cloudflare Workers
- **Pain:** Prisma's WASM engine + driver-adapter dance for edge runtimes; type inference falls off a cliff at depth 3+
- **Message:** "Drop-in Prisma-like API. Deep autocomplete chain. Runs on Cloudflare without an adapter package."
- **Where to reach them:** r/nextjs, r/typescript, Vercel Discord, Next.js Discord

### 2. Performance-conscious Node.js developers
- **Who:** Backend engineers building REST/tRPC APIs with deeply nested JSON responses
- **Pain:** N+1 queries are the #1 ORM performance problem; existing fixes either re-shape the API or re-declare relations
- **Message:** "One round-trip for the whole graph. Streaming cursors when the graph is too big to materialize."
- **Where to reach them:** r/node, HN Show HN, Dev.to, Hashnode

### 3. Drizzle/Kysely evaluators
- **Who:** Developers who want type-safe SQL but miss Prisma's DX for nested relations
- **Pain:** Drizzle's relational API requires re-declaring relations in a separate file; Kysely's `jsonArrayFrom` is manual; neither has typed Postgres error classes with `isRetryable`
- **Message:** "Prisma's `with` clause + zero relation re-declaration + typed errors out of the box."

---

## Content Strategy

### Pillar Content (write before any promotion)

1. **"Deep typed `with` inference: how Turbine makes nested Postgres queries autocomplete end-to-end"**
   - The pain: Prisma's `include` autocomplete falls off a cliff past depth 2-3
   - The fix: a recursive `WithResult<T, R, W>` type bound to generated metadata
   - Live screencast of the chain typing through
   - Honest gap analysis vs Prisma 7 / Drizzle v2
   - Publish: Dev.to + Hashnode + own blog
   - Cross-post: HN, r/typescript

2. **"Postgres ORM on Cloudflare Workers without a driver adapter"**
   - The pain: every other ORM ships a separate "edge" build or adapter package
   - The Turbine approach: drive any pg-compatible pool through `turbineHttp(pool, schema)`
   - End-to-end deploy walkthrough on Cloudflare Workers + Hyperdrive + Neon
   - Publish: Dev.to + own blog
   - Cross-post: r/nextjs, r/CloudFlare, Cloudflare Discord

3. **"Migrating from Prisma to Turbine: A Complete Guide"**
   - Schema mapping (`.prisma` → `defineSchema()`)
   - API mapping (`include` → `with`, `$queryRaw` → `db.raw`)
   - Migration strategy (can run both in parallel)
   - What Turbine can't do yet (full-text search, multi-DB)
   - Publish: README section + standalone guide (already exists at `docs/migrate-from-prisma.md`)

4. **Demo video (2-3 minutes)**
   - `turbine init` → `turbine generate` → write nested query → screencast the autocomplete chain → deploy to Cloudflare Workers
   - Host on YouTube, embed in README
   - Share on X/Twitter as a thread

### Distribution Plan

| Channel | Content | Timing |
|---------|---------|--------|
| **Hacker News** | Show HN post (see template below) | Day 1 |
| **r/typescript** | "I built a Postgres ORM with the deepest typed `with` inference I could manage" | Day 1 |
| **r/node** | Same angle, emphasize zero-binary, 1 dep, edge support | Day 1 |
| **r/nextjs** | "TypeScript Postgres on Vercel Edge without the Prisma adapter dance" | Day 2 |
| **Dev.to** | Pillar article #1 (typed inference) | Day 2-3 |
| **X/Twitter** | Thread: autocomplete screencast + four-runtime demo + install | Day 1 |
| **TypeScript Discord** | #showcase channel | Day 1 |
| **Next.js Discord** | #tools-and-libraries | Day 2 |
| **Cloudflare Discord** | #workers | Day 3 |

### HN Show HN Template

```
Title: Show HN: Turbine ORM – Postgres TypeScript ORM with deep typed nesting and edge support

I built a TypeScript Postgres ORM where users[0].posts[0].comments[0].author.name
autocompletes after a single findMany — no casts, no manual generics. The whole
object graph resolves in one database round-trip and the chain is fully type-inferred
from the with clause.

The other thing it gets right that I couldn't find elsewhere: it runs on every
Postgres host without re-engineering. Same generated client works on Neon, Vercel
Postgres, Cloudflare Hyperdrive, and Supabase — one import swap and you're on the edge.

- Streaming cursors (findManyStream) for constant-memory iteration
- Pipeline batching: N independent queries, 1 round-trip
- Typed Postgres errors with isRetryable for clean retry loops
- Atomic update operators ({ increment: 1 }) compile to race-free SQL
- 1 runtime dep (pg), ~110KB, no WASM, no DSL compiler

npm: npm install turbine-orm
GitHub: github.com/zvndev/turbine-orm

398 tests, MIT license. Looking for feedback on the DX and what's missing.
```

---

## Pre-Launch Checklist

Before any public promotion, complete these:

- [x] All `@batadata` references removed from codebase → `turbine-orm`
- [x] Stale URLs removed from README
- [x] Biome linter + formatter configured and passing
- [x] Custom error types with error codes (TurbineError hierarchy, TURBINE_E001-E011)
- [x] Doc comments on core nested-relation algorithm
- [x] Circular dependency detection (cycle check + depth cap at 10)
- [x] "Limitations" section in README
- [x] CLI subcommand `--help` working (init, generate, push, migrate, seed, status)
- [x] Code coverage tooling (c8 configured, `npm run test:coverage`)
- [x] Int8 type safety fixed
- [x] Competitive comparison table in README (vs Prisma, Drizzle, Kysely)
- [x] Migration checksums upgraded (SHA-256, missing file detection, MigrationError)
- [x] COALESCE fallback fixed for belongsTo/hasOne
- [x] Deep typed `with` inference (recursive `WithResult` + generator emits `RelationDescriptor`)
- [x] Edge / serverless example apps (Neon, Vercel, Cloudflare, Supabase)
- [x] Streaming cursors (`findManyStream`)
- [x] Pipeline batching
- [x] Atomic update operators
- [x] Typed Postgres errors (Deadlock / Serialization with `isRetryable`)
- [x] Auto-diff migrations
- [x] Prisma migration guide
- [ ] Pillar blog post #1 written (deep typed inference)
- [ ] Pillar blog post #2 written (edge runtime walkthrough)
- [ ] Demo video recorded
- [ ] GitHub Discussions enabled
- [ ] README badges (npm version, CI status, license)

---

## Competitive Positioning Matrix

| | **Turbine** | **Prisma 7** | **Drizzle v2** | **Kysely** |
|---|---|---|---|---|
| Nested query approach | 1 round-trip | 1 round-trip | 1 round-trip | Manual `jsonArrayFrom` |
| Deep type inference | Full chain (recursive) | Shallow (drops past depth 2-3) | Requires `relations()` re-declaration | Manual generics |
| API ergonomics | Prisma-like | Prisma | SQL-like + relational | SQL builder |
| Runtime deps | 1 (`pg`) | Engine + adapter package | 0 | 0 |
| Schema definition | TypeScript | Custom DSL | TypeScript (split files) | Manual interfaces |
| Edge runtime | Any pg-compatible pool | Driver Adapters (separate package) | HTTP drivers only | Manual |
| Streaming cursors | ✓ | ✗ | ✗ | Manual |
| Pipeline batching | ✓ | Serial in `$transaction` | ✗ | Manual |
| Typed Postgres errors | ✓ (with `isRetryable`) | Generic `code` strings | Raw pg errors | Raw pg errors |
| Atomic update operators | ✓ | ✓ | Raw SQL fragments | Manual |
| Multi-DB | Postgres only | 6 databases | 5 databases | 4 databases |

**Key talking points:**
- vs Prisma: "Same API. Deep autocomplete chain. Edge support without an adapter package."
- vs Drizzle: "Same single-query approach. Zero relation re-declaration. Typed errors out of the box."
- vs Kysely: "Automatic relation resolution. No manual jsonArrayFrom wiring."

---

## What NOT to Do

- Don't claim "10x faster" — honest numbers are compelling enough
- **Don't pitch "look at the SQL we generate"** — it's boring, obvious, and doesn't sell. The wow is the autocomplete chain and the runtime portability, not the query string.
- Don't bash Prisma — respect it, differentiate from it
- Don't launch on Product Hunt yet — save for v1.0
- Don't spam — quality posts in 3-4 communities beats 20 low-effort ones
- Don't promise multi-DB support — own the Postgres-only position
- Don't compare download counts — Turbine is pre-launch, judge it on engineering

---

## Post-Launch Roadmap (v1.0 targets)

1. **Full-text search** — TSVECTOR/TSQUERY operators in the query builder
2. **Turbine Studio** — local web UI for schema browsing
3. **Framework guides** — Next.js, Hono, Bun, Cloudflare Workers, Fastify
4. **Reproducible benchmark suite** — public repo, CI-driven
5. **Epic demo apps** — see `examples/` for the v0.7.1 expansion (streaming, ledger, leaderboard, dashboard pipeline)
