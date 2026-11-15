import { defineSchema } from '../../schema-builder.js';
import { schemaDefToMetadata } from '../../schema-metadata.js';

export const definition = defineSchema({
  users: {
    id: { type: 'serial', primaryKey: true },
    name: { type: 'text', notNull: true, unique: true },
    enabled: { type: 'boolean', notNull: true },
    profile: { type: 'jsonb', notNull: true },
    createdAt: { type: 'timestamp', notNull: true },
    bytes: { type: 'bytea', notNull: true },
    amount: { type: 'double', notNull: true },
  },
  posts: {
    id: { type: 'serial', primaryKey: true },
    userId: { type: 'integer', notNull: true, references: 'users.id' },
    optionalBytes: { type: 'bytea' },
    title: { type: 'text', notNull: true },
    enabled: { type: 'boolean', notNull: true },
    profile: { type: 'jsonb', notNull: true },
    bytes: { type: 'bytea', notNull: true },
    amount: { type: 'double', notNull: true },
  },
});
export const schema = schemaDefToMetadata(definition);
export const user = {
  name: 'one',
  enabled: true,
  profile: { a: ['b', 2] },
  createdAt: new Date('2026-01-02T03:04:05.000Z'),
  bytes: new Uint8Array([0, 1, 255]),
  amount: 0.1 + 0.2,
};
