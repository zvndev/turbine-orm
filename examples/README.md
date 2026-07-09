# Turbine ORM — Examples

Runnable demos for common hosts, drivers, and flagship features. Each subdirectory is self-contained (own `package.json` / README) unless noted.

## Full-stack dogfood

| Path | Description |
|---|---|
| [`dogfood.ts`](./dogfood.ts) | End-to-end exercise of nested relations, m2m, self-relations, groupBy + HAVING, typed raw SQL, RLS session context, LISTEN/NOTIFY, and optional pgvector. Imports from `../src` (working tree). |

```bash
export DATABASE_URL="postgres://user@localhost:5432/turbine_demo"
npm run dogfood
# or: npx tsx examples/dogfood.ts
```

## Hosting / driver adapters

| Path | Description |
|---|---|
| [`nextjs/`](./nextjs/) | Minimal Next.js App Router app — SSR pages, nested relations, streaming. |
| [`neon-edge/`](./neon-edge/) | Edge runtime via `@neondatabase/serverless` (Vercel Edge, Cloudflare Workers, Deno Deploy, Netlify Edge). |
| [`cloudflare-worker/`](./cloudflare-worker/) | Cloudflare Worker + Hyperdrive proxying Postgres through Turbine. |
| [`vercel-postgres/`](./vercel-postgres/) | Next.js route handler on Vercel Postgres. |
| [`supabase/`](./supabase/) | Node script on Supabase Postgres via the standard `pg` driver. |

## Feature demos

| Path | Description |
|---|---|
| [`streaming-csv/`](./streaming-csv/) | Server-side cursors export large nested result sets to CSV with a flat heap. |
| [`clickstorm/`](./clickstorm/) | Atomic `increment` vs read-modify-write race under concurrent "likes". |
| [`thread-machine/`](./thread-machine/) | Hacker News-style 4-level typed `with` inference from a single `findMany`. |

## Backlog

[`IDEAS.md`](./IDEAS.md) — remaining demo concepts from the v0.7.1 brainstorm.

## Notes

- Prefer each demo's own README for setup (`DATABASE_URL`, schema push, env vars).
- There is no root `npm run examples` entry — the old `examples/examples.ts` target was removed; use `npm run dogfood` or run a subdirectory demo directly.
