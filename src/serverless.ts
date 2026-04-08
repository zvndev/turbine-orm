/**
 * turbine-orm/serverless — edge / serverless driver integration
 *
 * Turbine runs on any Postgres driver that speaks the node-postgres API.
 * This module exposes a thin factory (`turbineHttp`) that binds an external
 * pg-compatible pool to a schema, so you can use Turbine on Vercel Edge,
 * Cloudflare Workers, Deno Deploy, Netlify Edge, or any other environment
 * where a direct TCP connection is unavailable.
 *
 * ## Supported drivers
 *
 * Any driver whose `Pool` satisfies `PgCompatPool` will work. The ones
 * below are verified:
 *
 * - **Neon** (`@neondatabase/serverless`) — HTTP and WebSocket transports
 * - **Vercel Postgres** (`@vercel/postgres`) — wraps Neon
 * - **Cloudflare Hyperdrive** — exposes a pg-compatible driver
 * - **Supabase** — use the regular `pg` package; Supabase is Postgres-native
 *
 * Turbine does NOT bundle any of these — install whichever you need and
 * pass its pool directly.
 *
 * ## Limitations over HTTP
 *
 * - **Streaming cursors** (`findManyStream`, `findManyCursor`) require
 *   server-side `DECLARE CURSOR`, which most HTTP drivers do not support.
 *   If you call these on an HTTP pool the underlying driver will error.
 * - **LISTEN/NOTIFY** is not available over HTTP.
 * - **Transactions** are supported but each transaction holds an HTTP
 *   connection for its duration — keep them short.
 *
 * ## Example — Neon on Vercel Edge
 *
 * ```ts
 * // app/api/users/route.ts
 * import { Pool } from '@neondatabase/serverless';
 * import { turbineHttp } from 'turbine-orm/serverless';
 * import { SCHEMA } from '../../generated/turbine/metadata';
 *
 * export const runtime = 'edge';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const db = turbineHttp(pool, SCHEMA);
 *
 * export async function GET() {
 *   const users = await db.table('users').findMany({ limit: 10 });
 *   return Response.json(users);
 * }
 * ```
 *
 * ## Example — Supabase (direct Postgres, no HTTP proxy needed)
 *
 * ```ts
 * import { TurbineClient } from 'turbine-orm';
 * import { SCHEMA } from './generated/turbine/metadata.js';
 *
 * const db = new TurbineClient({
 *   connectionString: process.env.SUPABASE_DB_URL,
 *   ssl: { rejectUnauthorized: false },
 * }, SCHEMA);
 * ```
 *
 * ## Example — Cloudflare Workers
 *
 * ```ts
 * // Use the Neon HTTP driver which works in Workers runtime
 * import { Pool } from '@neondatabase/serverless';
 * import { turbineHttp } from 'turbine-orm/serverless';
 * import { SCHEMA } from './generated/turbine/metadata';
 *
 * export default {
 *   async fetch(req: Request, env: Env) {
 *     const pool = new Pool({ connectionString: env.DATABASE_URL });
 *     const db = turbineHttp(pool, SCHEMA);
 *     const users = await db.table('users').findMany({ limit: 10 });
 *     return Response.json(users);
 *   }
 * };
 * ```
 */

import { type PgCompatPool, TurbineClient, type TurbineConfig } from './client.js';
import type { SchemaMetadata } from './schema.js';

// Re-export pg-compat types so consumers can import them from a single place.
export type { PgCompatPool, PgCompatPoolClient, PgCompatQueryResult } from './client.js';

/**
 * Options for `turbineHttp()`. Mirrors the fields of `TurbineConfig`
 * that are relevant for externally-managed pools.
 */
export interface TurbineHttpOptions extends Pick<TurbineConfig, 'logging' | 'defaultLimit' | 'warnOnUnlimited'> {}

/**
 * Create a TurbineClient bound to an external pg-compatible pool.
 *
 * Use this for serverless/edge environments where Turbine should NOT
 * manage its own `pg.Pool`. The caller retains ownership of the pool's
 * lifecycle — `db.disconnect()` is a no-op.
 *
 * @param pool - Any pg-compatible pool (Neon, Vercel Postgres, etc.)
 * @param schema - Introspected or hand-written schema metadata
 * @param options - Optional logging / defaultLimit / warnOnUnlimited
 * @returns A TurbineClient instance
 *
 * @example
 * ```ts
 * import { Pool } from '@neondatabase/serverless';
 * import { turbineHttp } from 'turbine-orm/serverless';
 * import { SCHEMA } from './generated/turbine/metadata.js';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const db = turbineHttp(pool, SCHEMA);
 *
 * const users = await db.table('users').findMany({ limit: 10 });
 * ```
 */
export function turbineHttp(
  pool: PgCompatPool,
  schema: SchemaMetadata,
  options: TurbineHttpOptions = {},
): TurbineClient {
  return new TurbineClient({ pool, ...options }, schema);
}
