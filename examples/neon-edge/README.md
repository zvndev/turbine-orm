# Turbine + Neon Serverless (Edge runtime)

Minimal example showing Turbine running on the **edge** via the `@neondatabase/serverless` driver. Works on Vercel Edge, Cloudflare Workers, Deno Deploy, Netlify Edge — anywhere a direct TCP socket is unavailable.

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Set your Neon connection string
export DATABASE_URL="postgres://user:pass@ep-xxx.us-east-1.aws.neon.tech/neondb"

# 3. Push the schema
npx turbine push --schema ./schema.ts

# 4. Generate the typed client + runtime metadata
npx turbine generate
```

After step 4 you'll have a `generated/turbine/metadata.ts` file that exports `schema` — the runtime `SchemaMetadata` consumed by `turbineHttp()`.

## Files

| File | What it is |
|---|---|
| `schema.ts` | Code-first table definitions (`defineSchema`). Source of truth for `turbine push`. |
| `app.ts` | Edge route handler. Imports the generated `schema` and calls `turbineHttp(pool, schema)`. |

## Run on Vercel Edge

Drop `app.ts` at `app/api/users/route.ts` in any Next.js project, set `DATABASE_URL` in your Vercel project env, and deploy. The handler runs entirely on the Vercel Edge Network and talks to Neon over HTTP — no TCP, no cold-start connection pool.

## Environment variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | Neon Postgres connection string from the Neon dashboard |
