import type { OrderCommand, SqliteOrderReplay } from './replay.js';

// Strict installed example contract. This function is compiled, never executed.
export async function checkTypes(app: SqliteOrderReplay, command: OrderCommand): Promise<void> {
  const event = await app.append(command);
  const position: string = event.position;
  const bytes: Uint8Array = event.body;
  const quantity: string = event.quantity;
  void [position, bytes, quantity];
  await app.consumeBatch('tenant', 'consumer', (item, signal) => { signal.throwIfAborted(); void item.position; });
  // @ts-expect-error quantity is lossless decimal text
  await app.append({ ...command, quantity: 9007199254740993 });
  // @ts-expect-error timestamp is canonical microsecond text
  await app.append({ ...command, occurredAt: new Date() });
  // @ts-expect-error event identity is mandatory
  await app.append({ tenant: 't', orderId: 'o', title: null, quantity: '1', amount: '1', occurredAt: '', body: bytes });
  // @ts-expect-error delivery callbacks do not return replacement acknowledgement positions
  await app.consumeBatch('t', 'c', () => 'position');
  // @ts-expect-error tenant and consumer identity remain separate string values
  await app.checkpoint(['t', 'c'], 'c');
}
