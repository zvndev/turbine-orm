/** Generation tooling only. Exact application values live in canonical TEXT. */
import { defineSchema, schemaDefToMetadata } from 'turbine-orm';
export const definition = defineSchema({
  replayEvents: {
    tenant: { type: 'text', notNull: true },
    position: { type: 'integer', notNull: true },
    eventId: { type: 'text', notNull: true },
    captured: { type: 'text', notNull: true },
    primaryKey: ['tenant', 'position'],
  },
  replayOrders: {
    tenant: { type: 'text', notNull: true },
    orderId: { type: 'text', notNull: true },
    eventId: { type: 'text', notNull: true },
    captured: { type: 'text', notNull: true },
    primaryKey: ['tenant', 'orderId'],
  },
});
export const metadata = schemaDefToMetadata(definition);
