/**
 * Turbine + Vercel Postgres on the Next.js app router.
 *
 * `@vercel/postgres` exposes a `createPool` factory that returns a
 * pg-compatible Pool. Hand it to `turbineHttp(pool, schema)` and Turbine
 * runs on Vercel Edge or the Node runtime without any extra adapter.
 */

import { createPool } from '@vercel/postgres';
import { turbineHttp } from 'turbine-orm/serverless';
// After running `npx turbine generate`, this file exposes a typed
// `SchemaMetadata` constant called `schema`.
import { schema } from '@/generated/turbine/metadata';

export const runtime = 'edge';

const pool = createPool({ connectionString: process.env.POSTGRES_URL });
const db = turbineHttp(pool, schema);

export async function GET() {
  const users = await db.users.findMany({ limit: 10 });
  return Response.json(users);
}
