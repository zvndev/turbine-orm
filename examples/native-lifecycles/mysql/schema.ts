import { defineSchema } from 'turbine-orm';

export default defineSchema({
  users: {
    id: { type: 'integer', primaryKey: true },
    display_name: { type: 'varchar', maxLength: 100, notNull: true },
  },
  notes: {
    id: { type: 'integer', primaryKey: true },
    body: { type: 'text' },
  },
});
