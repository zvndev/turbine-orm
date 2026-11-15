import { type OrderCommand, openOrderApplication } from './application.js';
export async function types(app: Awaited<ReturnType<typeof openOrderApplication>>, command: OrderCommand) {
  await app.append('A', command);
  // @ts-expect-error Exact BIGINT input is text.
  await app.append('A', { ...command, quantity: 9007199254740993 });
  // @ts-expect-error Exact timestamp input is text.
  await app.append('A', { ...command, occurredAt: new Date() });
  // @ts-expect-error Null is explicit for title; undefined is not admitted.
  await app.append('A', { ...command, title: undefined });
  // @ts-expect-error Callbacks have a bounded cancellation signal.
  app.consumeBatch('A', 'mail', 42);
}
