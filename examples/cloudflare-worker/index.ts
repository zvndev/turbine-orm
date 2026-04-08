/**
 * Turbine on Cloudflare Workers via Hyperdrive.
 *
 * Hyperdrive exposes a `connectionString` on the binding that you feed
 * into the standard `pg` Pool. Turbine then runs on top via the
 * `turbineHttp(pool, schema)` factory — no extra runtime deps.
 *
 * Workers note: `pg` runs in Workers via the `nodejs_compat` flag (see
 * wrangler.toml). For pure HTTP/edge environments without Hyperdrive
 * use `@neondatabase/serverless` instead.
 */

import { Pool } from 'pg';
import { turbineHttp } from 'turbine-orm/serverless';
// After running `npx turbine generate`, this file exposes the introspected
// schema as `SCHEMA` (matching the generator's output convention).
import { SCHEMA } from './generated/turbine/metadata';

export interface Env {
  HYPERDRIVE: Hyperdrive;
}

interface Hyperdrive {
  connectionString: string;
}

export default {
  async fetch(_req: Request, env: Env): Promise<Response> {
    const pool = new Pool({ connectionString: env.HYPERDRIVE.connectionString });
    const db = turbineHttp(pool, SCHEMA);

    try {
      const users = await db.users.findMany({ limit: 10 });
      return Response.json(users);
    } finally {
      // Workers tear the isolate down after each request — release the
      // pool's TCP socket back to Hyperdrive so it can be reused.
      await pool.end();
    }
  },
};
