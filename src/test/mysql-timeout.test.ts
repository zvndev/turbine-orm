import assert from 'node:assert/strict';
import { it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { TimeoutError, TransactionOutcomeUnknownError } from '../errors.js';
import { MysqlPool, turbineMysql } from '../mysql.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(fault?: 'rollback' | 'commit', blocked = false) {
  const order: string[] = [];
  const failure = new Error('native failure marker');
  const work = gate();
  const conn = {
    async query(sql: string): Promise<[unknown, unknown]> {
      order.push(sql);
      if ((fault === 'rollback' && sql === 'ROLLBACK') || (fault === 'commit' && sql === 'COMMIT')) throw failure;
      if (blocked && sql === 'SELECT 7') await work.promise;
      return [[{ v: '8.4.0', value: 7 }], []];
    },
    async execute(sql: string): Promise<[unknown, unknown]> {
      return this.query(sql);
    },
    release() {
      order.push('release');
    },
    connection: {
      destroy() {
        order.push('destroy');
      },
    },
  };
  const pool = {
    query: conn.query.bind(conn),
    execute: conn.execute.bind(conn),
    async getConnection() {
      return conn;
    },
    async end() {
      order.push('pool-end');
    },
  };
  const db = await turbineMysql(
    pool,
    { tables: {}, enums: {} },
    {
      logging: true,
      logger: { debug: (_message, entry) => order.push(entry.code) },
    },
  );
  order.length = 0;
  return { db, pool, order, failure, work };
}

function invoke<T>(
  db: Awaited<ReturnType<typeof turbineMysql>>,
  api: 'transaction' | '$transaction',
  callback: () => Promise<T>,
) {
  return api === 'transaction' ? db.transaction(callback) : db.$transaction(callback);
}

for (const api of ['transaction', '$transaction'] as const) {
  for (const reason of [
    undefined,
    null,
    false,
    0,
    '',
    new Error('callback marker'),
    Promise.resolve('secondary'),
    {
      // biome-ignore lint/suspicious/noThenProperty: rejection must preserve this thenable without assimilation.
      then() {
        throw new Error('must not assimilate a rejection');
      },
    },
  ]) {
    it(`${api}: MySQL acknowledged rollback preserves ${String(reason)} by identity`, async () => {
      const { db, order } = await fixture();
      let actual: unknown = Symbol('not rejected');
      try {
        await invoke(db, api, async () => {
          throw reason;
        });
      } catch (error) {
        actual = error;
      }
      assert.equal(actual, reason);
      assert.deepEqual(order, [
        'START TRANSACTION',
        'ROLLBACK',
        'release',
        ...(api === '$transaction' ? ['transaction-rolled-back'] : []),
      ]);
    });
  }

  it(`${api}: MySQL success keeps native control order and return value`, async () => {
    const { db, order } = await fixture();
    const value = {};
    assert.equal(await invoke(db, api, async () => value), value);
    assert.deepEqual(order, [
      'START TRANSACTION',
      'COMMIT',
      'release',
      ...(api === '$transaction' ? ['transaction-committed'] : []),
    ]);
  });

  for (const fault of ['commit', 'rollback'] as const) {
    it(`${api}: MySQL ${fault} failure cannot claim confirmed rollback`, async () => {
      const { db, order, failure } = await fixture(fault);
      const reason = new Error('primary marker');
      await assert.rejects(
        invoke(db, api, async () => {
          if (fault === 'rollback') throw reason;
        }),
        (error) =>
          fault === 'rollback'
            ? error === reason
            : // A COMMIT with no server answer may have committed: E021, the driver's error as cause.
              error instanceof TransactionOutcomeUnknownError && error.cause === failure,
      );
      assert.deepEqual(order, [
        'START TRANSACTION',
        fault === 'commit' ? 'COMMIT' : 'ROLLBACK',
        ...(api === '$transaction' ? ['transaction-outcome-unknown'] : []),
        'destroy',
      ]);
    });
  }
}

it('MySQL idle deadline confirms rollback without claiming server cancellation', async () => {
  const { db, order, work } = await fixture();
  let late!: ReturnType<typeof db.$transaction>;
  await assert.rejects(
    db.$transaction(
      async (tx) => {
        await work.promise;
        late = tx.rawUnsafe('SELECT 7');
        await late.catch(() => {});
      },
      { timeout: 10 },
    ),
    (error) => {
      assert.ok(error instanceof TimeoutError);
      assert.equal(error.outcome, 'not-executed');
      assert.match(error.message, /Rollback was confirmed/);
      assert.doesNotMatch(error.message, /cancelled/);
      return true;
    },
  );
  assert.deepEqual(order, ['START TRANSACTION', 'ROLLBACK', 'release', 'transaction-rolled-back']);
  work.resolve();
  await delay(0);
  await assert.rejects(late, /was rolled back/);
  assert.equal(order.includes('SELECT 7'), false);
});

it('MySQL running deadline stays unknown and discards before a late statement settles', async () => {
  const { db, order, work } = await fixture(undefined, true);
  let finished = false;
  await assert.rejects(
    db.$transaction(
      async (tx) => {
        await tx.rawUnsafe('SELECT 7');
        finished = true;
        await assert.rejects(tx.rawUnsafe('SELECT 8'), /unknown outcome/);
      },
      { timeout: 10 },
    ),
    (error) => error instanceof TimeoutError && error.outcome === 'unknown',
  );
  assert.equal(finished, false);
  assert.deepEqual(order, ['START TRANSACTION', 'SELECT 7', 'transaction-outcome-unknown', 'destroy']);
  work.resolve();
  await delay(0);
  assert.equal(finished, true);
  assert.equal(order.includes('SELECT 8'), false);
  await db.disconnect();
  assert.equal(order.includes('pool-end'), false);
});

it('MySQL recovery bounds idle acknowledgement without adopting an unrelated TimeoutError', async () => {
  const { pool, work } = await fixture();
  const client = await new MysqlPool(pool).connect();
  const policy = client.transactionRecovery!;
  assert.equal(await policy.rollback(false, () => work.promise, 5), false);
  work.resolve();
  const unrelated = new TimeoutError(23, 'user', { outcome: 'unknown' });
  assert.equal(policy.finish({ end() {} }, true, unrelated), unrelated);
  client.release();
});
