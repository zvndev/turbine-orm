import type { DatabaseSync } from 'node:sqlite';
import type { OrderEvent } from './replay.js';

/** A separate file models a destination that transactionally deduplicates effects. */
export function initializeDestination(destination: DatabaseSync): void {
  destination.exec(`CREATE TABLE effects (tenant TEXT NOT NULL, consumer TEXT NOT NULL,
    event_id TEXT NOT NULL, position TEXT NOT NULL, order_id TEXT NOT NULL, title TEXT,
    quantity TEXT NOT NULL, amount TEXT NOT NULL, occurred_at TEXT NOT NULL, body BLOB NOT NULL,
    PRIMARY KEY(tenant,consumer,event_id)) STRICT`);
}

export function recordEffect(destination: DatabaseSync, consumer: string, event: OrderEvent, signal: AbortSignal): void {
  signal.throwIfAborted();
  // This atomic unique insert stands in for a remote service's idempotency key.
  // Replaying an event attempts the effect again, but creates only one destination row.
  destination.prepare(`INSERT INTO effects VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(tenant,consumer,event_id) DO NOTHING`).run(event.tenant, consumer, event.eventId,
    event.position, event.orderId, event.title, event.quantity, event.amount, event.occurredAt, event.body);
}
