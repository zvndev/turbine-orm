import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { D1DatabaseBinding } from '../d1/types.js';

interface Command {
  eventId: string;
  orderId: string;
  quantity: string;
  amount: string;
  occurredAt: string;
  title: string | null;
  body: Uint8Array;
}
const command = (): Command => ({
  eventId: 'e1',
  orderId: 'o1',
  quantity: '9223372036854775807',
  amount: '999999999999999999999999999999.120000000001',
  occurredAt: '2026-11-07T12:34:56.123456Z',
  title: null,
  body: new Uint8Array([0, 128, 255]),
});
const application = async () => {
  const url = new URL('../../examples/d1-durable-replay/application.ts', import.meta.url).href;
  return (await import(url)) as {
    capture: (input: Command) => Command;
    UnknownOutcome: new (cause: unknown) => Error & { outcome: string };
    ReplayApp: new (
      binding: D1DatabaseBinding,
    ) => {
      readonly status: { closed: boolean; active: number; unsettled: number };
      reconcile(
        tenant: string,
        input: Command,
        options?: { timeoutMs?: number; signal?: AbortSignal },
      ): Promise<unknown>;
      close(): Promise<{ settled: boolean; active: number; unsettled: number }>;
    };
    Stopped: new (message?: string) => Error;
  };
};
test('D1 application captures each command property once and owns bytes', async () => {
  const { capture } = await application();
  const input = command(),
    reads: string[] = [];
  const copy = capture(
    new Proxy(input, {
      get(target, key, receiver) {
        reads.push(String(key));
        return Reflect.get(target, key, receiver);
      },
    }),
  );
  assert.deepEqual(reads, Object.keys(input));
  input.body.fill(0);
  input.quantity = '0';
  assert.deepEqual(copy, command());
});

test('D1 admission rechecks capacity after either caller option getter reenters', async () => {
  const { ReplayApp, Stopped } = await application();
  for (const key of ['timeoutMs', 'signal']) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const binding: D1DatabaseBinding = {
      prepare() {
        const statement = {
          bind() {
            return statement;
          },
          async all() {
            reads++;
            await gate;
            return { success: true, results: [], meta: { changes: 0, duration: 0, last_row_id: 0 } };
          },
        };
        return statement;
      },
      async batch() {
        throw new Error('Read-only admission must not dispatch a batch');
      },
    };
    const app = new ReplayApp(binding),
      pending: Promise<unknown>[] = [];
    let outer: Promise<unknown> | undefined;
    const options = Object.defineProperty({}, key, {
      get() {
        for (let i = 0; i < 8; i++) pending.push(app.reconcile('tenant', command()));
        return key === 'timeoutMs' ? 2000 : undefined;
      },
    });
    try {
      assert.throws(() => {
        outer = app.reconcile('tenant', command(), options);
      }, Stopped);
      assert.equal(app.status.active, 8);
      assert.equal(reads, 8);
    } finally {
      release();
      await Promise.allSettled([...pending, ...(outer ? [outer] : [])]);
      assert.deepEqual(await app.close(), { settled: true, unsettled: 0, active: 0 });
    }
  }
});
test('D1 application refuses precision loss and bounded malformed inputs', async () => {
  const { capture } = await application();
  for (const patch of [
    { quantity: '9223372036854775808' },
    { quantity: '01' },
    { amount: '1.0' },
    { amount: 'NaN' },
    { occurredAt: '2026-02-30T12:34:56.123456Z' },
    { occurredAt: '2026-11-07T12:34:56.123Z' },
    { title: '\ud800' },
    { title: 'x'.repeat(4097) },
    { body: new Uint8Array(16385) },
    { eventId: 'bad/key' },
  ])
    assert.throws(() => capture({ ...command(), ...patch }), TypeError);
  assert.equal(capture({ ...command(), title: '雪\0', body: new Uint8Array(16384) }).body.length, 16384);
});
test('D1 post-dispatch uncertainty preserves every falsy cause', async () => {
  const { UnknownOutcome } = await application();
  for (const cause of [false, 0, '', null, undefined]) {
    const error = new UnknownOutcome(cause);
    assert.equal(error.cause, cause);
    assert.equal(error.outcome, 'unknown');
    assert.match(error.message, /reconcile/);
  }
});
