/**
 * Turbine + Supabase.
 *
 * Supabase is Postgres under the hood — use the standard `pg` driver
 * directly. No HTTP proxy, no PostgREST shim. Get the connection string
 * from Supabase Dashboard -> Project Settings -> Database -> Connection
 * String -> URI ("Use connection pooling" recommended for serverless).
 */

import { TurbineClient } from 'turbine-orm';
// After running `npx turbine generate`, this file exposes the introspected
// schema as `SCHEMA` (matching the generator's output convention).
import { SCHEMA } from './generated/turbine/metadata.js';

async function main() {
  const db = new TurbineClient(
    {
      connectionString: process.env.SUPABASE_DB_URL,
      // Supabase serves over TLS via a managed cert. The pooler endpoint
      // (`*.pooler.supabase.com:6543`) presents Supabase's own CA chain,
      // which Node won't recognise out of the box. For production, prefer
      // pinning Supabase's CA explicitly via `ca: <pem string>` rather
      // than disabling verification — see Supabase docs for the current
      // root certificate.
      ssl: { rejectUnauthorized: false },
    },
    SCHEMA,
  );

  await db.connect();

  try {
    const users = await db.users.findMany({ limit: 10 });
    console.log(`Found ${users.length} users`);
    for (const user of users) {
      console.log(`  - ${user.email}`);
    }
  } finally {
    await db.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
