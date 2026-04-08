/**
 * Neon serverless + Turbine on Vercel Edge.
 *
 * Demonstrates the `turbineHttp(pool, schema)` factory binding the
 * `@neondatabase/serverless` Pool to a Turbine schema. The same pattern
 * works on any other edge runtime — Cloudflare Workers, Deno Deploy,
 * Netlify Edge — because Turbine never opens a TCP socket itself.
 *
 * Usage (Next.js app router):
 *   - Place this file at `app/api/users/route.ts`
 *   - Set `DATABASE_URL` to your Neon connection string
 *   - Deploy and hit `GET /api/users`
 */

import { Pool } from '@neondatabase/serverless';
import { turbineHttp } from 'turbine-orm/serverless';
// After running `npx turbine generate`, this file exposes the introspected
// schema as `SCHEMA` (matching the generator's output convention).
import { SCHEMA } from './generated/turbine/metadata';

export const runtime = 'edge';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = turbineHttp(pool, SCHEMA);

export async function GET() {
  const users = await db.users.findMany({ limit: 10 });
  return Response.json(users);
}
