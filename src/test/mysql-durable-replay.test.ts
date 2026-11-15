import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createPool } from 'mysql2/promise';

// Native integration is a separate explicit installed artifact fixture, never a silent skip.
// These admission controls run without a server, including in the ordinary unit suite.
interface Command {
  eventId: string;
  orderId: string;
  title: string | null;
  quantity: string;
  amount: string;
  occurredAt: string;
  body: Buffer;
}
interface Module {
  openOrderApplication(options: { pool: ReturnType<typeof createPool> }): Promise<{ close(): Promise<void> }>;
  capture(input: Command): Command;
  ddl: string[];
  Unacknowledged: new (uncertain: boolean, cause: unknown) => Error & { uncertain: boolean };
}
const application = async () => {
  const url = new URL('../../examples/mysql-durable-replay/application.ts', import.meta.url).href;
  return (await import(url)) as Module;
};
const command = () => ({
  eventId: 'event-1',
  orderId: 'order-1',
  title: null as string | null,
  quantity: '9223372036854775807',
  amount: '999999999999999999999999999999.120000000001',
  occurredAt: '2026-11-07T12:34:56.123456Z',
  body: Buffer.from([0, 255, 128]),
});

test('MySQL app refuses incompatible pool encodings before acquiring a connection', async () => {
  const { openOrderApplication } = await application();
  for (const charset of ['LATIN1_SWEDISH_CI', 'UTF8_GENERAL_CI', 'ASCII_GENERAL_CI']) {
    const pool = createPool({
      host: '127.0.0.1',
      namedPlaceholders: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      waitForConnections: false,
      connectionLimit: 1,
      connectTimeout: 1000,
      charset,
    });
    let acquisitions = 0;
    pool.getConnection = async () => {
      acquisitions++;
      throw new Error('Encoding admission should happen before acquisition');
    };
    try {
      await assert.rejects(openOrderApplication({ pool }), { name: 'TypeError', message: /UTF-8/ });
      assert.equal(acquisitions, 0);
    } finally {
      await pool.end();
    }
  }
});

test('MySQL order app captures every value once and owns the bytes', async () => {
  const { capture } = await application();
  const input = command();
  const reads: string[] = [];
  const supplied = new Proxy(input, {
    get(target, property, receiver) {
      reads.push(String(property));
      return Reflect.get(target, property, receiver);
    },
  });
  const captured = capture(supplied);
  assert.deepEqual(reads, Object.keys(input));
  input.body.fill(7);
  input.quantity = '0';
  assert.deepEqual(captured, command());
});

test('MySQL order app rejects malformed or excessive exact values', async () => {
  const { capture } = await application();
  for (const patch of [
    { quantity: '9223372036854775808' },
    { quantity: '01' },
    { amount: '1e10' },
    { amount: '1.1234567890123' },
    { occurredAt: '2026-02-30T12:34:56.123456Z' },
    { occurredAt: '2026-11-07T12:34:56.123Z' },
    { title: '\ud800' },
    { body: Buffer.alloc(65537) },
    { eventId: 'bad/key' },
  ]) {
    assert.throws(() => capture({ ...command(), ...patch }), TypeError);
  }
  assert.deepEqual(capture({ ...command(), title: 'a\0雪', body: Buffer.alloc(65531) }).body, Buffer.alloc(65531));
});

test('MySQL app preserves falsy failures in its explicit uncertainty result', async () => {
  const { Unacknowledged } = await application();
  for (const cause of [undefined, null, false, 0, '']) {
    const failure = new Unacknowledged(false, cause);
    assert.equal(failure.cause, cause);
    assert.equal(failure.uncertain, false);
  }
  assert.match(new Unacknowledged(true, false).message, /reconcile/);
});

test('fixed MySQL app tables use InnoDB with durable independent consumer/destination keys', async () => {
  const { ddl } = await application();
  assert.equal(ddl.length, 6);
  for (const sql of ddl) assert.match(sql, /ENGINE=InnoDB/);
  const contract = readFileSync(new URL('../../docs/mysql-durable-replay.md', import.meta.url), 'utf8');
  assert.match(contract, /at least once/);
  assert.match(contract, /mysql2 3.24.6/);
  assert.match(contract, /3.24.5/);
});
