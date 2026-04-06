# Turbine ORM Launch Plan

## Assets
- npm: `turbine-orm@0.4.0`
- GitHub: github.com/zvndev/turbine-orm (public)
- Docs: turbineorm.dev
- Demo: turbine-demo-blog.fly.dev
- Debug endpoint: turbine-demo-blog.fly.dev/api/debug (shows generated SQL)

## Day 1: Soft Launch

### Hacker News — Show HN
Title: `Show HN: Turbine ORM – TypeScript Postgres ORM that resolves nested relations in 1 SQL query`

> I built a TypeScript Postgres ORM that uses `json_agg` to fetch nested relations in a single SQL query instead of N+1. On production benchmarks (Vercel to Neon), it's 19-28% faster than Drizzle and Prisma on nested reads.
>
> The pitch: `db.users.findMany({ with: { posts: { with: { comments: true } } } })` generates ONE query. Prisma sends 3. Only runtime dependency is `pg`.
>
> - npm: `npm install turbine-orm`
> - GitHub: github.com/zvndev/turbine-orm
> - Docs: turbineorm.dev
> - Live demo: turbine-demo-blog.fly.dev/api/debug (shows the actual SQL)
>
> 180 tests, Prisma-compatible API, MIT license. Looking for feedback on the DX and what's missing.

### Twitter/X thread
1. Hook — "I built a Postgres ORM that does nested queries in 1 SQL statement. Here's what Prisma sends vs what Turbine sends:" + side-by-side SQL screenshot
2. Benchmark numbers — production Vercel→Neon table
3. Code example — the `with` clause
4. "Only dependency is `pg`. No Rust binary. 70KB on npm." + install command
5. Link to docs + demo + "What would make you switch from Prisma?"

### Reddit
- r/typescript — "I built a Postgres ORM focused on nested query performance"
- r/node — same angle, emphasize zero-binary
- r/PostgreSQL — "Using json_agg for ORM-level nested relation loading"

## Day 2-3: Content

### Blog post (Dev.to + Hashnode)
Title: "How json_agg makes your Postgres ORM 2x faster on nested queries"
- The N+1 problem (what Prisma/Drizzle do)
- What json_agg is and why it's faster
- The actual SQL Turbine generates
- Honest benchmarks (production numbers, not inflated local ones)
- When to use Turbine vs Prisma vs Drizzle (honest about gaps)

### Demo video (optional, high-impact)
- 2-minute Loom: init → generate → nested query → debug SQL
- Post on Twitter + embed in README

## Week 1: Community

- TypeScript Discord, Node.js Discord, Postgres Slack
- GitHub Discussions: enable, pin Roadmap + "What features do you need?"
- README badges (npm version, license, CI status)

## Week 2: Credibility

- Run honest benchmarks with actual Turbine ORM (not raw pg)
- Publish reproducible benchmark suite in repo
- Framework guides: Next.js, Express

## Key message
> "What if your ORM sent 1 SQL query instead of 3? Turbine uses Postgres json_agg to load users → posts → comments in a single round-trip. 70KB, zero binary deps, Prisma-compatible API."

## What NOT to do
- Don't claim "10x faster" — honest numbers are compelling enough
- Don't bash Prisma — respect it, differentiate from it
- Don't launch on Product Hunt yet — save for v1.0
- Don't spam — quality posts in 3-4 communities beats 20 low-effort ones
