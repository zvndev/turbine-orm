# Turbine + Vercel Postgres

Minimal Next.js app router route handler using **Vercel Postgres** as the underlying database and Turbine as the query layer.

## Setup

```bash
# 1. Install deps
npm install

# 2. Provision a Vercel Postgres database
#    Vercel dashboard -> Storage -> Create -> Postgres
#    Vercel injects POSTGRES_URL into your project env automatically.

# 3. Push the schema
npx turbine push --schema ./schema.ts

# 4. Generate the typed client + runtime metadata
npx turbine generate

# 5. Run locally
npm run dev

# 6. Hit the route
curl http://localhost:3000/api/users
```

## Files

| File | What it is |
|---|---|
| `schema.ts` | `defineSchema(...)` source of truth |
| `app/api/users/route.ts` | App router GET handler. `runtime = 'edge'` — runs on Vercel Edge. |

## Environment variables

| Variable | Description |
|---|---|
| `POSTGRES_URL` | Provided automatically by Vercel when you attach a Postgres database to your project |

## Notes

`@vercel/postgres` wraps `@neondatabase/serverless` under the hood, so this example works on both the Edge and Node runtimes. Switch `runtime` from `'edge'` to `'nodejs'` in `route.ts` if you'd rather run on the Node runtime.
