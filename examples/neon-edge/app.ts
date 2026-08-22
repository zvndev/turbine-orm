/**
 * Neon serverless + Turbine on Vercel Edge.
 *
 * Demonstrates the `turbineHttp(pool, schema)` factory binding the
 * `@neondatabase/serverless` Pool to a Turbine schema. The same pattern
 * works on any other edge runtime, Cloudflare Workers, Deno Deploy,
 * Netlify Edge, because Turbine never opens a TCP socket itself.
 *
 * Usage (Next.js app router):
 *   - Place this file at `app/api/users/route.ts`
 *   - Set `DATABASE_URL` to your Neon connection string
 *   - Deploy and hit `GET /api/users`
 */

import { Pool } from '@neondatabase/serverless';
import { turbineHttp } from 'turbine-orm/serverless';
// After running `npx turbine generate`, this directory holds the runtime
// schema (`SCHEMA`) and the generated client TYPE. Naming that type is what
// gives the edge client the same typed accessors as the TCP one; without it
// `turbineHttp` returns the base client and `db.users` does not compile.
import type { TurbineClient } from './generated/turbine/index.js';
import { SCHEMA } from './generated/turbine/metadata.js';

export const runtime = 'edge';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = turbineHttp<TurbineClient>(pool, SCHEMA);

export async function GET() {
  const users = await db.users.findMany({ limit: 10 });
  return Response.json(users);
}
