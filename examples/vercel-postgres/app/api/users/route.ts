/**
 * Turbine + Vercel Postgres on the Next.js app router.
 *
 * `@vercel/postgres` exposes a `createPool` factory that returns a
 * pg-compatible Pool. Hand it to `turbineHttp(pool, schema)` and Turbine
 * runs on Vercel Edge or the Node runtime without any extra adapter.
 */

import { createPool } from '@vercel/postgres';
import { turbineHttp } from 'turbine-orm/serverless';
// After running `npx turbine generate` from your project root, this file
// exposes the introspected schema as `SCHEMA`. The relative path mirrors a
// typical Next.js app-router layout — adjust to wherever your generated/
// directory lives. (No `@/` alias is used so this file copy-pastes cleanly
// without a tsconfig.json `paths` entry.)
import { SCHEMA } from '../../../generated/turbine/metadata';

export const runtime = 'edge';

const pool = createPool({ connectionString: process.env.POSTGRES_URL });
const db = turbineHttp(pool, SCHEMA);

export async function GET() {
  const users = await db.users.findMany({ limit: 10 });
  return Response.json(users);
}
