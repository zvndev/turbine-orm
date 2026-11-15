import { defineSchema } from '../../../schema-builder.js';

export const definition = defineSchema({
  users: {
    id: { type: 'serial', primaryKey: true },
    name: { type: 'text', notNull: true, unique: true },
    active: { type: 'boolean', notNull: true },
    profile: { type: 'jsonb' },
    createdAt: { type: 'timestamp', notNull: true },
    payload: { type: 'bytea' },
  },
  posts: {
    id: { type: 'serial', primaryKey: true },
    userId: { type: 'integer', notNull: true, references: 'users.id' },
    title: { type: 'text', notNull: true },
    visible: { type: 'boolean', notNull: true },
  },
});
