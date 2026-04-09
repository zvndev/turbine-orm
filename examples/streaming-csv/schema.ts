import { defineSchema } from 'turbine-orm';

/**
 * Streaming CSV demo — a tiny e-commerce order schema. The seed inserts
 * 100K orders with 1-5 line items each (~300K rows total) so the streaming
 * export has something meaty to chew through while heap stays flat.
 */
export default defineSchema({
  customers: {
    id: { type: 'serial', primaryKey: true },
    email: { type: 'text', unique: true, notNull: true },
    name: { type: 'text', notNull: true },
    createdAt: { type: 'timestamp', default: 'now()' },
  },
  orders: {
    id: { type: 'serial', primaryKey: true },
    customerId: { type: 'bigint', notNull: true, references: 'customers.id' },
    status: { type: 'text', default: "'pending'" },
    totalCents: { type: 'integer', default: '0' },
    createdAt: { type: 'timestamp', default: 'now()' },
  },
  lineItems: {
    id: { type: 'serial', primaryKey: true },
    orderId: { type: 'bigint', notNull: true, references: 'orders.id' },
    productName: { type: 'text', notNull: true },
    quantity: { type: 'integer', default: '1' },
    unitPriceCents: { type: 'integer', default: '0' },
  },
});
