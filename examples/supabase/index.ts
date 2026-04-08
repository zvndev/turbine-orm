/**
 * Turbine + Supabase.
 *
 * Supabase is Postgres under the hood — use the standard `pg` driver
 * directly. No HTTP proxy, no PostgREST shim. Get the connection string
 * from Supabase Dashboard -> Project Settings -> Database -> Connection
 * String -> URI ("Use connection pooling" recommended for serverless).
 */

import { TurbineClient } from 'turbine-orm';
// After running `npx turbine generate`, this file exposes a typed
// `SchemaMetadata` constant called `schema`.
import { schema } from './generated/turbine/metadata.js';

async function main() {
  const db = new TurbineClient(
    {
      connectionString: process.env.SUPABASE_DB_URL,
      // Supabase serves over TLS — accept the managed cert.
      ssl: { rejectUnauthorized: false },
    },
    schema,
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
