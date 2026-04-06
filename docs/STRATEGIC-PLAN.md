# Turbine ORM — Strategic Launch Plan

> Updated: 2026-04-05 | Status: Pre-launch (v0.5.0)

## Positioning

**One-liner:** "The Postgres ORM that sends 1 query instead of N+1 — Prisma's API, DBA-grade SQL."

**Core differentiator:** Turbine is the only TypeScript ORM that automatically resolves nested relations into `json_agg` + `json_build_object` correlated subqueries from a Prisma-like API. Not lateral joins (Drizzle), not multi-query batching (Prisma), not manual helpers (Kysely) — one query, automatically, from schema metadata.

**Position PostgreSQL-only as a feature:** "We go deeper on PostgreSQL than any alternative." Don't apologize for it. Hasura, PostGraphile, and Supabase all bet on Postgres-only. The depth enables the speed.

---

## Target Audiences (Priority Order)

### 1. Prisma users on serverless (primary)
- **Who:** TypeScript developers deploying to Vercel Functions, AWS Lambda, Cloudflare Workers
- **Pain:** Prisma's N+1 queries + WASM engine overhead = high latency on cold starts
- **Message:** "Drop-in Prisma-like API, 2-3x faster nested queries, 1 dependency instead of a WASM binary"
- **Where to reach them:** r/nextjs, r/typescript, Vercel Discord, Next.js Discord, X/Twitter #nextjs

### 2. Performance-conscious Node.js developers
- **Who:** Backend engineers building REST/tRPC APIs with deeply nested JSON responses
- **Pain:** N+1 queries are the #1 performance problem in ORMs
- **Message:** "Your ORM sends 3 queries. Turbine sends 1. Here's the SQL."
- **Where to reach them:** r/node, r/PostgreSQL, HN Show HN, Dev.to, Hashnode

### 3. Drizzle/Kysely evaluators
- **Who:** Developers who want type-safe SQL but miss Prisma's DX for nested relations
- **Pain:** Drizzle's relational API is powerful but requires more setup; Kysely's `jsonArrayFrom` is manual
- **Message:** "Prisma's `with` clause + PostgreSQL-native performance. No compromises."

---

## Content Strategy

### Pillar Content (write before any promotion)

1. **"How json_agg makes your Postgres ORM 2x faster on nested queries"**
   - The N+1 problem explained with actual SQL
   - What Prisma, Drizzle, and Turbine each generate (side-by-side)
   - Honest benchmarks with methodology
   - When NOT to use Turbine (large dataset caveats, non-Postgres needs)
   - Publish: Dev.to + Hashnode + own blog
   - Cross-post: HN, r/PostgreSQL, r/typescript

2. **"Migrating from Prisma to Turbine: A Complete Guide"**
   - Schema mapping (`.prisma` → `defineSchema()`)
   - API mapping (`include` → `with`, `$queryRaw` → `db.raw`)
   - Migration strategy (can run both in parallel)
   - What Turbine can't do yet (incremental updates, full-text search)
   - Publish: README section + standalone guide

3. **Demo video (2-3 minutes)**
   - `turbine init` → `turbine generate` → write nested query → show SQL → benchmark
   - Host on YouTube, embed in README
   - Share on X/Twitter as a thread

### Distribution Plan

| Channel | Content | Timing |
|---------|---------|--------|
| **Hacker News** | Show HN post (see template below) | Day 1 |
| **r/typescript** | "I built a Postgres ORM focused on nested query performance" | Day 1 |
| **r/node** | Same angle, emphasize zero-binary, 1 dep | Day 1 |
| **r/PostgreSQL** | "Using json_agg for ORM-level nested relation loading" — technical angle | Day 2 |
| **Dev.to** | Pillar article #1 | Day 2-3 |
| **X/Twitter** | Thread: side-by-side SQL + benchmarks + install | Day 1 |
| **TypeScript Discord** | #showcase channel | Day 1 |
| **Next.js Discord** | #tools-and-libraries | Day 2 |
| **Vercel community** | If community forum exists | Day 3 |

### HN Show HN Template

```
Title: Show HN: Turbine ORM – TypeScript Postgres ORM that resolves nested relations in 1 SQL query

I built a TypeScript Postgres ORM that uses json_agg to fetch nested relations
in a single SQL query instead of N+1. On production benchmarks (Vercel to Neon),
it's 19-28% faster than Drizzle and 2-3x faster than Prisma on nested reads.

The pitch: `db.users.findMany({ with: { posts: { with: { comments: true } } } })`
generates ONE query. Prisma sends 3.

- npm: npm install turbine-orm
- GitHub: github.com/zvndev/turbine-orm
- Only runtime dependency is `pg`

180 tests, Prisma-compatible API, MIT license.
Looking for feedback on the DX and what's missing.
```

---

## Pre-Launch Checklist

Before any public promotion, complete these:

- [x] All `@batadata` references removed from codebase → `turbine-orm`
- [x] Stale URLs removed from README (batadata.com, demo links)
- [x] Biome linter + formatter configured and passing
- [x] Custom error types with error codes (TurbineError hierarchy, TURBINE_E001-E007)
- [x] Doc comments on core json_agg algorithm (buildSelectWithRelations, buildRelationSubquery)
- [x] Circular dependency detection (cycle check + depth cap at 10)
- [x] "Limitations" section in README
- [x] CLI subcommand `--help` working (init, generate, push, migrate, seed, status)
- [x] Code coverage tooling (c8 configured, `npm run test:coverage`)
- [x] Int8 type safety fixed
- [x] Competitive comparison table in README (vs Prisma, Drizzle, Kysely)
- [x] Migration checksums upgraded (SHA-256, missing file detection, MigrationError)
- [x] COALESCE fallback fixed for belongsTo/hasOne (NULL instead of '[]')
- [ ] Blog post #1 written (json_agg deep dive)
- [ ] Prisma migration guide written
- [ ] Demo video recorded
- [ ] GitHub Discussions enabled
- [ ] README badges (npm version, CI status, license)
- [ ] npm publish dry-run passes clean

---

## Competitive Positioning Matrix

| | **Turbine** | **Prisma** | **Drizzle** | **Kysely** |
|---|---|---|---|---|
| Nested query approach | `json_agg` (1 query) | Multi-query or opt-in JOIN | LATERAL JOINs (1 query) | Manual `jsonArrayFrom` |
| API ergonomics | Prisma-like | Prisma | SQL-like + relational | SQL builder |
| Runtime deps | 1 (`pg`) | WASM compiler + driver | 0 | 0 |
| Schema definition | TypeScript | Custom DSL | TypeScript | Manual interfaces |
| PostgreSQL depth | Deep (native json_agg) | Shallow (raw SQL for JSONB) | Good (lateral joins) | Good (pg helpers) |
| Serverless fit | Excellent (tiny) | Improving (v7) | Excellent (7.4KB) | Good |
| Multi-DB | Postgres only | 6 databases | 5 databases | 4 databases |

**Key talking points:**
- vs Prisma: "Same API, 2-3x faster nested queries, no WASM binary, 1 dependency"
- vs Drizzle: "Prisma-level DX with PostgreSQL-native performance"
- vs Kysely: "Automatic relation resolution — no manual jsonArrayFrom wiring"

---

## What NOT to Do

- Don't claim "10x faster" — honest numbers are compelling enough
- Don't bash Prisma — respect it, differentiate from it
- Don't launch on Product Hunt yet — save for v1.0
- Don't spam — quality posts in 3-4 communities beats 20 low-effort ones
- Don't promise multi-DB support — own the Postgres-only position
- Don't compare download counts — Turbine is pre-launch, judge it on engineering

---

## Post-Launch Roadmap (v1.0 targets)

1. **Incremental updates** (`{ likes: { increment: 1 } }`) — Prisma parity
2. **Full-text search** — TSVECTOR operators
3. **Turbine Studio** — local web UI for schema browsing
4. **Framework guides** — Next.js, Express, Fastify, Hono
5. **Reproducible benchmark suite** — public repo, CI-driven
