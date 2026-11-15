/**
 * turbine-orm/serverless: the existing generic pg-compatible pool binding.
 *
 * The historical turbineHttp name does not identify the driver's transport.
 * Neon Pool/Client use WebSockets; neon() uses HTTP and is not a Pool. Passing
 * an external Pool does not certify a provider, backend session mode or runtime.
 * Callback transactions need a connection pinned through the transaction.
 * LISTEN needs a persistent actual backend session and asynchronous events;
 * a logical checkout from a transaction pooler does not establish that contract.
 * Stateless HTTP drivers cannot supply interactive transactions or LISTEN.
 *
 * For the explicit optional Neon WebSocket lifecycle/session binding see
 * docs/neon-websocket.md. For this generic API, the caller owns the Pool:
 * disconnect releases Turbine subscriptions but does not end that Pool.
 *
 * @example Invocation-local Neon WebSocket Pool
 * ```ts
 * import { Pool } from '@neondatabase/serverless';
 * import { turbineHttp } from 'turbine-orm/serverless';
 * import { SCHEMA } from './generated/turbine/metadata.js';
 *
 * export async function handle(connectionString: string) {
 *   const pool = new Pool({ connectionString });
 *   const db = turbineHttp(pool, SCHEMA);
 *   try {
 *     const users = await db.table('users').findMany({ limit: 10 });
 *     return Response.json(users);
 *   } finally {
 *     try { await db.disconnect(); }
 *     finally { await pool.end(); }
 *   }
 * }
 * ```
 * In edge functions every Pool/Client must be created, used and closed within
 * one invocation. Configure an instance WebSocket implementation if required
 * by the runtime; do not change global driver defaults in a request handler.
 */

import { type PgCompatPool, TurbineClient, type TurbineConfig } from './client.js';
import type { SchemaMetadata } from './schema.js';

// Re-export pg-compat types so consumers can import them from a single place.
export type { PgCompatPool, PgCompatPoolClient, PgCompatQueryResult } from './client.js';

/**
 * Options for `turbineHttp()`: everything a `TurbineClient` takes except the
 * pool, which is this function's first argument.
 *
 * This used to be a three-key `Pick` (`logging` / `defaultLimit` /
 * `warnOnUnlimited`), which made the accepted set an ALLOWLIST that stopped
 * being maintained the day it was written. The runtime already spread the whole
 * object through, so the effect was purely at the type level: a serverless
 * caller passing `globalFilters` (or `errorMessages`, or `relationLoadStrategy`)
 * got an excess-property error on an option that would have worked. That is a
 * kinder failure than PowDB's silent drop, but the same allowlist, and it lands
 * on the edge deployments where a tenant filter matters most.
 *
 * Deliberately `Omit<TurbineConfig, 'pool'>` rather than `EngineClientConfig`:
 * unlike the SQL engine factories, this one binds no dialect and pins no
 * prepared-statement mode, so it has no business narrowing those away.
 */
export type TurbineHttpOptions = Omit<TurbineConfig, 'pool'>;

/**
 * Create a TurbineClient bound to an external pg-compatible pool.
 *
 * Use this for serverless/edge environments where Turbine should NOT
 * manage its own `pg.Pool`. The caller retains ownership of the pool's
 * lifecycle. `db.disconnect()` releases its subscriptions without ending the pool.
 *
 * ## Typed table accessors
 *
 * By default `turbineHttp` returns the base {@link TurbineClient}, so you
 * reach tables through `db.table('users')`. To get the *generated*, fully
 * typed accessors (`db.users.findMany()`), identical to what the TCP-path
 * `turbine()` factory gives you, pass your generated client type as the
 * `TClient` type argument. The runtime object is the same; the generated
 * subclass only adds `declare readonly` accessor typings, and the base
 * constructor already creates those accessors at runtime for every table in
 * the schema, so the assertion is sound (not a lie about the shape).
 *
 * @typeParam TClient - The generated `TurbineClient` subclass (from
 *   `./generated/turbine`). Defaults to the base client for back-compat.
 * @param pool - Any pg-compatible pool (Neon, Vercel Postgres, etc.)
 * @param schema - Introspected or hand-written schema metadata
 * @param options - Optional logging / defaultLimit / warnOnUnlimited
 * @returns A TurbineClient instance (typed as `TClient`)
 *
 * @example Untyped (back-compat), reach tables via `db.table(...)`
 * ```ts
 * import { Pool } from '@neondatabase/serverless';
 * import { turbineHttp } from 'turbine-orm/serverless';
 * import { SCHEMA } from './generated/turbine/metadata.js';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const db = turbineHttp(pool, SCHEMA);
 * const users = await db.table('users').findMany({ limit: 10 });
 * ```
 *
 * @example Typed, generated accessors, identical to the TCP client
 * ```ts
 * import { Pool } from '@neondatabase/serverless';
 * import { turbineHttp } from 'turbine-orm/serverless';
 * import type { TurbineClient } from './generated/turbine/index.js';
 * import { SCHEMA } from './generated/turbine/metadata.js';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const db = turbineHttp<TurbineClient>(pool, SCHEMA);
 * const users = await db.users.findMany({ limit: 10 }); // fully typed, no cast
 * ```
 */
export function turbineHttp<TClient extends TurbineClient = TurbineClient>(
  pool: PgCompatPool,
  schema: SchemaMetadata,
  options: TurbineHttpOptions = {},
): TClient {
  // The generated subclass only layers `declare readonly` accessor typings
  // over the base client; the base constructor materializes those same
  // accessors at runtime (Object.defineProperty per schema table). So the
  // returned instance genuinely has TClient's shape, the assertion is safe.
  return new TurbineClient({ pool, ...options }, schema) as TClient;
}
