import type { OrderCommand, RelayOptions, openOrderRelay } from './application.js';

export async function typedConsumer(relay: Awaited<ReturnType<typeof openOrderRelay>>, command: OrderCommand) {
  const event = await relay.append('tenant_A', command);
  const exact: string = event.quantity;
  const count: number = await relay.relayBatch('tenant_A');
  // @ts-expect-error Numeric quantity would lose the int8 contract.
  const rounded: OrderCommand = { ...command, quantity: 9007199254740993 };
  // @ts-expect-error Dates discard microseconds.
  const milliseconds: OrderCommand = { ...command, occurredAt: new Date() };
  // @ts-expect-error Stable source history identity is mandatory.
  const unbound: RelayOptions = { consumer: 'mail' };
  // @ts-expect-error Progress counts are not events.
  const delivered: OrderCommand = await relay.relayBatch('tenant_A');
  return { exact, count, rounded, milliseconds, unbound, delivered };
}
