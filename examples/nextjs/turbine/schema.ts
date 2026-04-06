import { defineSchema } from 'turbine-orm';

export default defineSchema({
  organizations: {
    id: { type: 'serial', primaryKey: true },
    name: { type: 'text', notNull: true },
    slug: { type: 'text', unique: true, notNull: true },
    plan: { type: 'text', default: "'free'" },
    domain: { type: 'text' },
    logoUrl: { type: 'text' },
    createdAt: { type: 'timestamp', default: 'now()' },
  },
  users: {
    id: { type: 'serial', primaryKey: true },
    email: { type: 'text', unique: true, notNull: true },
    name: { type: 'text', notNull: true },
    role: { type: 'text', default: "'member'" },
    avatarUrl: { type: 'text' },
    orgId: { type: 'bigint', notNull: true, references: 'organizations.id' },
    bio: { type: 'text' },
    createdAt: { type: 'timestamp', default: 'now()' },
  },
  posts: {
    id: { type: 'serial', primaryKey: true },
    title: { type: 'text', notNull: true },
    content: { type: 'text', default: "''" },
    published: { type: 'boolean', default: 'false' },
    viewCount: { type: 'integer', default: '0' },
    userId: { type: 'bigint', notNull: true, references: 'users.id' },
    orgId: { type: 'bigint', notNull: true, references: 'organizations.id' },
    slug: { type: 'text' },
    createdAt: { type: 'timestamp', default: 'now()' },
  },
  comments: {
    id: { type: 'serial', primaryKey: true },
    body: { type: 'text', notNull: true },
    userId: { type: 'bigint', notNull: true, references: 'users.id' },
    postId: { type: 'bigint', notNull: true, references: 'posts.id' },
    createdAt: { type: 'timestamp', default: 'now()' },
  },
});
