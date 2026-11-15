import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { type TransactionClient, TurbineClient } from '../client.js';
import { TimeoutError, TransactionOutcomeUnknownError, ValidationError } from '../errors.js';
import type { PgCompatPool, PgCompatPoolClient } from '../pg-types.js';

const schema = { tables: {}, enums: {} };
type Api = 'transaction' | '$transaction' | 'batch';
function fixture(fault?: 'rollback' | 'release' | 'commit', wrapped = false) {
  const order: string[] = [];
  const failure = new Error(`${fault} marker`);
  let wraps = 0;
  const raw = Object.assign(new EventEmitter(), {
    async query(sql: string) {
      order.push(sql);
      if ((fault === 'rollback' && sql === 'ROLLBACK') || (fault === 'commit' && sql === 'COMMIT')) throw failure;
      return { rows: [], rowCount: 0, command: sql };
    },
    release(error?: unknown) {
      order.push(error ? 'discard' : 'release');
      if (fault === 'release') throw failure;
    },
    ...(wrapped
      ? {
          wrapTransactionCallback<T>(this: unknown, callback: () => Promise<T>) {
            assert.equal(this, raw);
            wraps++;
            return callback();
          },
        }
      : {}),
  });
  const pool = Object.assign(new EventEmitter(), {
    query: raw.query,
    async connect() {
      return raw;
    },
    async end() {},
  });
  const db = new TurbineClient(
    {
      pool: pool as unknown as PgCompatPool,
      logging: true,
      logger: { debug: (_message, entry) => order.push(entry.code) },
    },
    schema,
  );
  order.length = 0;
  return { db, raw, order, failure, wraps: () => wraps };
}
function invoke(db: TurbineClient, api: Api, callback: (handle: unknown) => Promise<unknown>) {
  return api === 'transaction'
    ? db.transaction(callback)
    : api === '$transaction'
      ? db.$transaction(callback)
      : db.$transaction([{ sql: 'SELECT 7', params: [], tag: 'hook.check', transform: () => 7 }]);
}

for (const api of ['transaction', '$transaction', 'batch'] as const) {
  it(`${api}: success releases once before its existing log`, async () => {
    const { db, order } = fixture();
    const value = await invoke(db, api, async () => 7);
    assert.deepEqual(value, api === 'batch' ? [7] : 7);
    assert.deepEqual(order, [
      'BEGIN',
      ...(api === 'batch' ? ['SELECT 7'] : []),
      'COMMIT',
      'release',
      ...(api === 'transaction' ? [] : ['transaction-committed']),
    ]);
  });
  it(`${api}: an unanswered COMMIT is E021 with its failure as cause, sends no ROLLBACK and discards`, async () => {
    const { db, order, failure } = fixture('commit');
    await assert.rejects(
      invoke(db, api, async () => 7),
      (error) => error instanceof TransactionOutcomeUnknownError && error.cause === failure,
    );
    assert.deepEqual(order, [
      'BEGIN',
      ...(api === 'batch' ? ['SELECT 7'] : []),
      'COMMIT',
      'discard',
      ...(api === 'transaction' ? [] : ['transaction-outcome-unknown']),
    ]);
  });
  it(`${api}: a throwing release after an acknowledged COMMIT sends no ROLLBACK and claims none`, async () => {
    const { db, order, failure } = fixture('release');
    await assert.rejects(
      invoke(db, api, async () => 7),
      (error) => error === failure,
    );
    assert.deepEqual(order, ['BEGIN', ...(api === 'batch' ? ['SELECT 7'] : []), 'COMMIT', 'release']);
  });
}
for (const api of ['transaction', '$transaction'] as const) {
  for (const kind of ['fulfilled-thenable', 'never-thenable', 'throwing-getter', 'promise'] as const) {
    it(`${api}: rejection ${kind} is never assimilated during settlement`, async () => {
      const { db, order } = fixture();
      let thenCalls = 0;
      const reason =
        kind === 'promise'
          ? Promise.resolve('secondary value')
          : kind === 'throwing-getter'
            ? Object.defineProperty({}, 'then', {
                get() {
                  thenCalls++;
                  throw new Error('secondary getter failure');
                },
              })
            : {
                // biome-ignore lint/suspicious/noThenProperty: this regression must reject a thenable by identity.
                then(resolve: (value: string) => void) {
                  thenCalls++;
                  if (kind === 'fulfilled-thenable') resolve('secondary value');
                },
              };
      let escaped!: PgCompatPoolClient & TurbineClient;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const pending = invoke(db, api, async (handle) => {
          escaped = handle as typeof escaped;
          throw reason;
        }).then(
          () => ({ resolved: true }),
          (error: unknown) => ({ error }),
        );
        const outcome = await Promise.race([
          pending,
          new Promise<{ timedOut: true }>((resolve) => {
            timer = setTimeout(() => resolve({ timedOut: true }), 1000);
          }),
        ]);
        assert.ok('error' in outcome, 'transaction must reject after cleanup without adopting its reason');
        assert.equal(outcome.error, reason);
        assert.equal(thenCalls, 0);
        assert.deepEqual(order, [
          'BEGIN',
          'ROLLBACK',
          'release',
          ...(api === 'transaction' ? [] : ['transaction-rolled-back']),
        ]);
        await assert.rejects(
          async () => (api === 'transaction' ? escaped.query('SELECT 1') : escaped.rawUnsafe('SELECT 1')),
          /was rolled back/,
        );
      } finally {
        clearTimeout(timer);
        await db.disconnect();
      }
    });
  }
  for (const reason of [undefined, null, 0, false, new Error('callback marker')]) {
    it(`${api}: callback rejection preserves ${String(reason)} and native closed-handle wording`, async () => {
      const { db, order } = fixture();
      let leaked!: PgCompatPoolClient & TurbineClient;
      let observed: unknown = Symbol('not rejected');
      try {
        await invoke(db, api, async (handle) => {
          leaked = handle as typeof leaked;
          throw reason;
        });
      } catch (error) {
        observed = error;
      }
      assert.equal(observed, reason);
      assert.deepEqual(order, [
        'BEGIN',
        'ROLLBACK',
        'release',
        ...(api === 'transaction' ? [] : ['transaction-rolled-back']),
      ]);
      await assert.rejects(
        async () => (api === 'transaction' ? leaked.query('SELECT 1') : leaked.rawUnsafe('SELECT 1')),
        (error) => error instanceof ValidationError && error.message.includes('was rolled back'),
      );
    });
  }
  it(`${api}: an unconfirmed native rollback discards the lease, keeps the primary error, claims no rollback`, async () => {
    const { db, order } = fixture('rollback');
    const reason = new Error('primary');
    let leaked!: PgCompatPoolClient & TurbineClient;
    await assert.rejects(
      invoke(db, api, async (handle) => {
        leaked = handle as typeof leaked;
        throw reason;
      }),
      (error) => error === reason,
    );
    assert.deepEqual(order, [
      'BEGIN',
      'ROLLBACK',
      'discard',
      ...(api === 'transaction' ? [] : ['transaction-outcome-unknown']),
    ]);
    await assert.rejects(
      async () => (api === 'transaction' ? leaked.query('SELECT 1') : leaked.rawUnsafe('SELECT 1')),
      /ended with an unknown outcome/,
    );
  });
  it(`${api}: optional callback wrapping retains the original receiver and runs once`, async () => {
    const { db, wraps } = fixture(undefined, true);
    await invoke(db, api, async () => 7);
    assert.equal(wraps(), 1);
  });
}
it('native idle deadline: confirmed rollback, not-executed, and no claim of a cancelled statement', async () => {
  const { db, order } = fixture();
  let escaped!: TransactionClient;
  await assert.rejects(
    db.$transaction(
      async (tx) => {
        escaped = tx;
        await delay(30);
      },
      { timeout: 5 },
    ),
    (error) => {
      assert.ok(error instanceof TimeoutError);
      assert.equal(error.outcome, 'not-executed');
      assert.equal(
        error.message,
        '[TURBINE_E002] Transaction timed out after 5ms and was rolled back, so none of its writes were saved. (https://turbineorm.dev/errors#e002)',
      );
      return true;
    },
  );
  assert.deepEqual(order, ['BEGIN', 'ROLLBACK', 'release', 'transaction-rolled-back']);
  await assert.rejects(escaped.rawUnsafe('SELECT 1'), /timed out/);
  await delay(30);
});
