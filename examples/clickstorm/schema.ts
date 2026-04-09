import { defineSchema } from 'turbine-orm';

/**
 * Clickstorm — a minimal "like button" schema. One row per post with a
 * `likesCount` counter. The whole demo is about what happens to that
 * counter when 10,000 concurrent requests try to bump it.
 */
export default defineSchema({
  posts: {
    id: { type: 'serial', primaryKey: true },
    title: { type: 'text', notNull: true },
    likesCount: { type: 'integer', default: '0' },
    createdAt: { type: 'timestamp', default: 'now()' },
  },
});
