import type { D1DatabaseBinding } from 'turbine-orm/d1';
import { initialize, ReplayApp } from './application.js';
/** Supply a local caller-owned binding; finite and safe to rerun by stable ID. */
export async function demo(binding: D1DatabaseBinding) {
  await initialize(binding);
  const source = new ReplayApp(binding),
    destination = new ReplayApp(binding);
  try {
    const event = await source.append('demo', {
      eventId: 'demo-event',
      orderId: 'demo-order',
      quantity: '9223372036854775807',
      amount: '999999999999999999999999999999.120000000001',
      occurredAt: '2026-11-07T12:34:56.123456Z',
      title: null,
      body: new Uint8Array([0, 128, 255]),
    });
    const checkpoint = await source.deliver('demo', 'warehouse', async (events) => {
      for (const item of events) await destination.applyDestination('warehouse', item);
    });
    return { event, checkpoint };
  } finally {
    await source.close();
    await destination.close();
  }
}
