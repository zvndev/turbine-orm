import type { defineSchema } from 'turbine-orm';

// The same definition supplies SQLite DDL and schema-specific generated types.
export const tables = {
  users: {
    id: { type: 'serial', primaryKey: true },
    email: { type: 'text', notNull: true, unique: true },
    displayName: { type: 'text', notNull: true },
  },
  posts: {
    id: { type: 'serial', primaryKey: true },
    userId: { type: 'integer', notNull: true, references: 'users.id' },
    title: { type: 'text', notNull: true },
    score: { type: 'integer', notNull: true, default: 0 },
  },
  comments: {
    id: { type: 'serial', primaryKey: true },
    postId: { type: 'integer', notNull: true, references: 'posts.id' },
    body: { type: 'text', notNull: true },
  },
  tags: {
    slug: { type: 'text', primaryKey: true },
    label: { type: 'text', notNull: true },
  },
} satisfies Parameters<typeof defineSchema>[0];
