# Turbine + Supabase

Minimal Node script that connects to a **Supabase** Postgres database via the standard `pg` driver and runs Turbine on top.

## Setup

```bash
# 1. Install deps
npm install

# 2. Grab your connection string
#    Supabase Dashboard -> Project Settings -> Database -> Connection String -> URI
#    For serverless / Lambda, use the "connection pooling" variant on port 6543
export SUPABASE_DB_URL="postgres://postgres.<project>:<password>@aws-0-us-east-1.pooler.supabase.com:6543/postgres"

# 3. Push the schema
npm run db:push

# 4. Generate the typed client + runtime metadata
npm run db:generate

# 5. Run the script
npm start
```

## Files

| File | What it is |
|---|---|
| `schema.ts` | `defineSchema(...)` source of truth |
| `index.ts` | Standalone script — opens a `TurbineClient`, runs `db.users.findMany`, prints results |

## Environment variables

| Variable | Description |
|---|---|
| `SUPABASE_DB_URL` | Postgres connection string from Supabase. Either the direct (5432) or pooled (6543) URL works. |

## Notes

Supabase serves Postgres directly — there is no HTTP fallback. Use the regular `TurbineClient` with `ssl: { rejectUnauthorized: false }` to accept Supabase's managed TLS certificate. For long-running processes use the direct (5432) URL; for serverless functions use the pooled (6543) URL.
