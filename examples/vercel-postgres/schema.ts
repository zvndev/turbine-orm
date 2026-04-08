import { defineSchema } from 'turbine-orm';

/**
 * Code-first schema for the Vercel Postgres example.
 *
 * Apply with `npx turbine push` and run `npx turbine generate` to emit
 * the typed runtime metadata at `generated/turbine/metadata.ts`.
 */
export default defineSchema({
  users: {
    id:        { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
    email:     { type: 'text', unique: true, notNull: true },
    createdAt: { type: 'timestamp', default: 'now()' },
  },
});
