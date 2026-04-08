import { defineSchema } from 'turbine-orm';

/**
 * Code-first schema for the Cloudflare Worker example.
 *
 * Apply with `npx turbine push` against the upstream Postgres database
 * fronted by your Hyperdrive binding, then run `npx turbine generate`
 * to emit the typed runtime metadata at `generated/turbine/metadata.ts`.
 */
export default defineSchema({
  users: {
    id:        { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
    email:     { type: 'text', unique: true, notNull: true },
    createdAt: { type: 'timestamp', default: 'now()' },
  },
});
