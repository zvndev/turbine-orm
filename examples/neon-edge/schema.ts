import { defineSchema } from 'turbine-orm';

/**
 * Code-first schema for the Neon Edge example.
 *
 * Apply with `npx turbine push` (or `npx turbine migrate create --auto`)
 * and then run `npx turbine generate` to emit the typed runtime metadata
 * at `generated/turbine/metadata.ts` and the typed client subclass at
 * `generated/turbine/index.ts`. The edge entrypoint imports `schema` from
 * the generated metadata file and feeds it into `turbineHttp(pool, schema)`.
 */
export default defineSchema({
  users: {
    id:        { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
    email:     { type: 'text', unique: true, notNull: true },
    createdAt: { type: 'timestamp', default: 'now()' },
  },
});
