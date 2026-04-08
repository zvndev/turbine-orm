# Turbine + Cloudflare Workers (Hyperdrive)

Minimal Worker that proxies a Postgres database through **Cloudflare Hyperdrive** and serves rows via Turbine.

## Setup

```bash
# 1. Install deps
npm install

# 2. Create a Hyperdrive binding for your database
npx wrangler hyperdrive create turbine-db --connection-string="postgres://user:pass@host/db"
# -> Copy the printed Hyperdrive ID into wrangler.toml

# 3. Push the schema (run against the upstream database directly,
#    not via Hyperdrive — pushing schema needs DDL which Hyperdrive proxies fine)
DATABASE_URL="postgres://user:pass@host/db" npx turbine push --schema ./schema.ts

# 4. Generate the typed client + runtime metadata
DATABASE_URL="postgres://user:pass@host/db" npx turbine generate

# 5. Develop locally
npm run dev

# 6. Deploy
npm run deploy
```

## Files

| File | What it is |
|---|---|
| `schema.ts` | `defineSchema(...)` source of truth |
| `index.ts` | Worker `fetch` handler. Builds a `pg.Pool` from `env.HYPERDRIVE.connectionString` and binds it to Turbine via `turbineHttp(pool, schema)`. |
| `wrangler.toml` | Worker config + Hyperdrive binding |

## How it works

Cloudflare Hyperdrive sits in front of any Postgres database and pools / caches connections at the edge. The binding gives you a `connectionString` you can hand directly to `pg.Pool`. Turbine then runs unchanged on top — no extra adapter, no HTTP fallback.

## Environment variables

| Variable | Where | Description |
|---|---|---|
| `env.HYPERDRIVE.connectionString` | Worker runtime | Provided automatically by the Hyperdrive binding declared in `wrangler.toml` |
| `DATABASE_URL` | Local CLI | Direct upstream Postgres URL — used by `turbine push` and `turbine generate` only |
