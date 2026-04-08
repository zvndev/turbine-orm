# Turbine ORM Launch Plan

## Assets
- npm: `turbine-orm@0.7.1`
- GitHub: github.com/zvndev/turbine-orm
- Docs: turbineorm.dev
- Demo: turbine-demo-blog.fly.dev (Next.js example)
- Edge demos: examples/{neon-edge,cloudflare-worker,vercel-postgres,supabase}

## Day 1: Soft Launch

### Hacker News — Show HN
Title: `Show HN: Turbine ORM – Postgres TypeScript ORM with deep typed nesting and edge support`

> I built a TypeScript Postgres ORM where `users[0].posts[0].comments[0].author.name` autocompletes after a single `findMany` — no casts, no manual generics. The whole object graph resolves in one database round-trip and the chain is fully type-inferred from the `with` clause.
>
> The other thing it gets right that I couldn't find elsewhere: it runs on every Postgres host without re-engineering. Same generated client works on Neon, Vercel Postgres, Cloudflare Hyperdrive, and Supabase — one import swap and you're on the edge.
>
> - Streaming cursors (`findManyStream`) for constant-memory iteration
> - Pipeline batching: N independent queries, 1 round-trip
> - Typed Postgres errors with `isRetryable` for clean retry loops
> - Atomic update operators (`{ increment: 1 }`) compile to race-free SQL
> - 1 runtime dep (`pg`), ~110KB, no WASM, no DSL compiler
>
> npm: `npm install turbine-orm` · GitHub: github.com/zvndev/turbine-orm
>
> 398 tests, MIT, MIT-licensed. Looking for feedback on the DX and what's missing.

### Twitter/X thread
1. Hook — "I built a Postgres ORM where this autocompletes:" + screencast of `users[0].posts[0].comments[0].author.name` typing through with no casts
2. The four runtimes — "Same client, four hosts" (Neon, Vercel, Cloudflare, Supabase)
3. Streaming demo — `for await (const row of db.users.findManyStream(...))` with memory-flat chart
4. "1 dep. ~110KB on npm. Reads like Prisma." + install command
5. Link to docs + demo + "What's the worst thing about your current ORM?"

### Reddit
- r/typescript — "I built a Postgres ORM with the deepest typed `with` inference I could manage"
- r/node — same angle, emphasize the zero-binary footprint and edge support
- r/nextjs — "TypeScript Postgres on Vercel Edge without the Prisma adapter dance"

## Day 2-3: Content

### Blog post (Dev.to + Hashnode)
Title: "Deep typed `with` inference: how Turbine makes nested Postgres queries autocomplete end-to-end"
- The pain: Prisma's `include` autocomplete falls off a cliff at depth 3+
- The fix: a recursive `WithResult<T, R, W>` type bound to the generated metadata
- Live screencast of the autocomplete chain
- The bonus: it's all in one round-trip
- When to use Turbine vs Prisma vs Drizzle (honest about gaps)

Companion post: "Postgres ORM on Cloudflare Workers without a driver adapter"
- The pain: every other ORM needs a separate "edge" build
- The Turbine approach: drive any pg-compatible pool via `turbineHttp`
- Walkthrough deploying the example to Workers + Hyperdrive

### Demo video (optional, high-impact)
- 2-minute Loom: init → generate → autocomplete chain → deploy to Cloudflare Workers
- Post on Twitter + embed in README

## Week 1: Community

- TypeScript Discord, Node.js Discord, Postgres Slack
- GitHub Discussions: enable, pin Roadmap + "What features do you need?"
- README badges (npm version, license, CI status)

## Week 2: Credibility

- Reproducible benchmark suite (Prisma 7 vs Drizzle v2 vs Turbine on the same dataset)
- Framework guides: Next.js, Hono, Bun, Cloudflare Workers
- Cookbook: streaming exports, pipeline dashboards, retry loops, ledger transactions

## Key message
> "TypeScript Postgres ORM where deep nested queries autocomplete end-to-end and the same client runs on Neon, Vercel, Cloudflare, and Supabase without re-engineering. ~110KB, one dep."

## What NOT to do
- Don't claim "10x faster" — honest numbers are compelling enough
- Don't pitch "look at the SQL we generate" — it's boring and obvious. The wow is the autocomplete chain and the runtime portability, not the query string.
- Don't bash Prisma — respect it, differentiate from it
- Don't launch on Product Hunt yet — save for v1.0
- Don't spam — quality posts in 3-4 communities beats 20 low-effort ones
