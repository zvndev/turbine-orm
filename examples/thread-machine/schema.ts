import { defineSchema } from 'turbine-orm';

/**
 * Thread Machine — a Hacker News-style schema that shows off deep typed `with`.
 *
 * The whole point: a single `findMany` on `stories` pulls the full 4-level
 * graph (story → author, story → comments → author, story → comments →
 * replies → author) in one round-trip, and every level is type-inferred.
 *
 * Apply with `npm run db:push` then `npm run db:generate`.
 */
export default defineSchema({
  users: {
    id: { type: 'serial', primaryKey: true },
    handle: { type: 'text', unique: true, notNull: true },
    karma: { type: 'integer', default: '0' },
    createdAt: { type: 'timestamp', default: 'now()' },
  },
  stories: {
    id: { type: 'serial', primaryKey: true },
    title: { type: 'text', notNull: true },
    url: { type: 'text' },
    score: { type: 'integer', default: '0' },
    authorId: { type: 'bigint', notNull: true, references: 'users.id' },
    createdAt: { type: 'timestamp', default: 'now()' },
  },
  comments: {
    id: { type: 'serial', primaryKey: true },
    body: { type: 'text', notNull: true },
    score: { type: 'integer', default: '0' },
    storyId: { type: 'bigint', notNull: true, references: 'stories.id' },
    authorId: { type: 'bigint', notNull: true, references: 'users.id' },
    createdAt: { type: 'timestamp', default: 'now()' },
  },
  replies: {
    id: { type: 'serial', primaryKey: true },
    body: { type: 'text', notNull: true },
    score: { type: 'integer', default: '0' },
    commentId: { type: 'bigint', notNull: true, references: 'comments.id' },
    authorId: { type: 'bigint', notNull: true, references: 'users.id' },
    createdAt: { type: 'timestamp', default: 'now()' },
  },
});
