/**
 * turbine-orm: work the server rolled back is E019 (`TransactionRolledBackError`),
 * unless the first failure was one a retry fixes.
 *
 * Every case here is a callback that CAUGHT a failure and went on, which is the
 * shape that used to come back as E003 ("validation failed") although nothing
 * the caller passed was invalid. The pass condition is the class, the code, the
 * `cause`, and that nothing was committed.
 *
 * Run: DATABASE_URL=... npx tsx --test src/test/fix-txerr-rolled-back.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe, beforeEach as eachTest } from 'node:test';
import pg from 'pg';
import type { TransactionClient, TurbineClient } from '../client.js';
import {
  DeadlockError,
  LockNotAvailableError,
  SerializationFailureError,
  TimeoutError,
  TransactionRolledBackError,
  UniqueConstraintError,
  ValidationError,
} from '../errors.js';
import { skipGate } from './helpers.js';
import { DATABASE_URL, openFixture, type TxFixture } from './transactions-fixture.js';

const { it, before, after } = skipGate(!DATABASE_URL, 'DATABASE_URL not set');
const beforeEach: typeof eachTest = DATABASE_URL ? eachTest : () => {};

/** Reject if `work` has not settled within `ms`: a hang becomes a failure. */
function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** The assertions every E019 shares. */
function isRolledBack(pattern: RegExp, cause?: unknown) {
  return (err: unknown): boolean => {
    assert.ok(err instanceof TransactionRolledBackError, `expected TransactionRolledBackError, got ${String(err)}`);
    assert.equal(err.code, 'TURBINE_E019');
    assert.equal(err.name, 'TransactionRolledBackError');
    assert.match(err.docsUrl, /\/errors#e019$/);
    assert.equal('isRetryable' in err, false, 'E019 is not retryable on its own');
    assert.ok(!(err instanceof ValidationError), 'a rolled-back transaction is not a validation failure');
    assert.match(err.message, pattern, err.message);
    if (cause !== undefined) assert.equal(err.cause, cause);
    else assert.ok(err.cause !== undefined, 'the first failure is attached as cause');
    return true;
  };
}

async function openClient(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  return client;
}

describe('rolled-back work is TransactionRolledBackError (live Postgres)', () => {
  let fx: TxFixture;
  let db: TurbineClient;
  let single: TurbineClient;

  before(async () => {
    fx = await openFixture('fxte');
    db = fx.client({ poolSize: 4 });
    single = fx.client({ poolSize: 1 });
  });
  beforeEach(async () => {
    await fx.reset();
  });
  after(async () => {
    await fx?.close();
  });

  it('$transaction: a caught failure, then COMMIT answered with ROLLBACK, is E019 with the failure as cause', async () => {
    const { users } = fx.t;
    let caught: unknown;
    await assert.rejects(
      db.$transaction(async (tx) => {
        await tx.table(users).create({ data: { email: 'kept?@x' } });
        try {
          await tx.table(users).create({ data: { email: 'a@x' } });
        } catch (err) {
          caught = err;
        }
        return 'resolved ok';
      }),
      isRolledBack(/rolled back, not committed[\s\S]*tx\.\$transaction/),
    );
    assert.ok(caught instanceof UniqueConstraintError, String(caught));
    assert.equal(await fx.count(users, "email = 'kept?@x'"), 0, 'the earlier insert is gone');
  });

  it('$transaction: the cause is the failed statement itself', async () => {
    const { users } = fx.t;
    let caught: unknown;
    const error = await db
      .$transaction(async (tx) => {
        try {
          await tx.table(users).create({ data: { email: 'a@x' } });
        } catch (err) {
          caught = err;
        }
      })
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    isRolledBack(/rolled back/, caught)(error);
  });

  it('$retry does not retry E019: the failure behind it is not known to be transient', async () => {
    let attempts = 0;
    await assert.rejects(
      db.$retry(
        () =>
          db.$transaction(async (tx) => {
            attempts++;
            await tx.raw`SELECT 1/0`.catch(() => {});
          }),
        { maxAttempts: 3, baseDelay: 1 },
      ),
      isRolledBack(/rolled back/),
    );
    assert.equal(attempts, 1);
  });

  describe('a per-query timeout inside $transaction', () => {
    async function holdCounterOne(): Promise<{ release: () => Promise<void> }> {
      const locker = await openClient();
      await locker.query('BEGIN');
      await locker.query(`SELECT * FROM ${fx.t.counters} WHERE id = 1 FOR UPDATE`);
      return {
        release: async () => {
          await locker.query('ROLLBACK').catch(() => {});
          await locker.end();
        },
      };
    }

    it('a callback that catches the timeout and returns is E019 with the TimeoutError as cause', async () => {
      const { users, counters } = fx.t;
      const lock = await holdCounterOne();
      let caught: unknown;
      try {
        await assert.rejects(
          within(
            db.$transaction(async (tx) => {
              await tx.table(users).create({ data: { email: 'q-caught@x' } });
              try {
                await tx.table(counters).update({ where: { id: 1 }, data: { n: 7 }, timeout: 150 });
              } catch (err) {
                caught = err;
              }
              return 'done';
            }),
            3000,
            'the transaction whose callback caught the timeout',
          ),
          isRolledBack(/rolled back, not committed/),
        );
      } finally {
        await lock.release();
      }
      assert.ok(caught instanceof TimeoutError, String(caught));
      assert.equal(await fx.count(users, "email = 'q-caught@x'"), 0);
    });

    it('a nested block that catches the timeout is E019 at the block, and the outer transaction commits', async () => {
      const { users, counters } = fx.t;
      const lock = await holdCounterOne();
      try {
        await within(
          db.$transaction(async (tx) => {
            await tx.table(users).create({ data: { email: 'q-outer@x' } });
            await assert.rejects(
              tx.$transaction(async (inner) => {
                await inner.table(users).create({ data: { email: 'q-inner@x' } });
                try {
                  await inner.table(counters).update({ where: { id: 1 }, data: { n: 7 }, timeout: 150 });
                } catch {}
              }),
              isRolledBack(/nested `\$transaction` block was rolled back/),
            );
            await tx.table(users).create({ data: { email: 'q-after@x' } });
          }),
          3000,
          'the transaction with a timed-out nested block',
        );
      } finally {
        await lock.release();
      }
      assert.equal(await fx.count(users, "email IN ('q-outer@x', 'q-after@x')"), 2);
      assert.equal(await fx.count(users, "email = 'q-inner@x'"), 0);
    });
  });

  it('a nested block that swallows a failure is E019 at the block, and the outer transaction carries on', async () => {
    const { users } = fx.t;
    await db.$transaction(async (tx) => {
      await tx.table(users).create({ data: { email: 'outer@x' } });
      await assert.rejects(
        tx.$transaction(async (inner) => {
          await inner.table(users).create({ data: { email: 'inner@x' } });
          await inner
            .table(users)
            .create({ data: { email: 'a@x' } })
            .catch(() => {});
        }),
        isRolledBack(/nested `\$transaction` block was rolled back, not released[\s\S]*outer transaction is usable/),
      );
      await tx.table(users).create({ data: { email: 'after@x' } });
    });
    assert.equal(await fx.count(users, "email IN ('outer@x', 'after@x')"), 2);
    assert.equal(await fx.count(users, "email = 'inner@x'"), 0);
  });

  it('transaction(fn): a caught failure is E019, and the message names the savepoint fix for this API', async () => {
    const { users } = fx.t;
    await assert.rejects(
      single.transaction(async (client) => {
        await client.query(`INSERT INTO ${users} (email) VALUES ('raw-kept?@x')`);
        await client.query('SELECT 1/0').catch(() => {});
      }),
      (err: unknown) => {
        isRolledBack(/rolled back, not committed[\s\S]*ROLLBACK TO SAVEPOINT/)(err);
        assert.doesNotMatch((err as Error).message, /tx\.\$transaction/);
        return true;
      },
    );
    assert.equal(await fx.count(users, "email = 'raw-kept?@x'"), 0);
  });

  describe('a retryable first failure keeps its class', () => {
    /** A callback that triggers `sqlstate` on purpose, swallows it, and returns. */
    const swallow = (sqlstate: string) => (tx: TransactionClient) =>
      tx.rawUnsafe(`DO $$ BEGIN RAISE EXCEPTION 'on purpose' USING ERRCODE = '${sqlstate}'; END $$`).catch(() => {});

    it('40P01 stays DeadlockError and is retryable', async () => {
      let attempts = 0;
      await assert.rejects(
        db.$retry(
          () =>
            db.$transaction(async (tx) => {
              attempts++;
              await swallow('40P01')(tx);
            }),
          { maxAttempts: 2, baseDelay: 1 },
        ),
        (err: unknown) => {
          assert.ok(err instanceof DeadlockError, String(err));
          assert.equal(err.isRetryable, true);
          assert.equal(err.code, 'TURBINE_E012');
          assert.match(err.message, /rolled back, not committed/);
          assert.ok(err.cause instanceof DeadlockError, 'the first failure is the cause');
          return true;
        },
      );
      assert.equal(attempts, 2, 'the whole transaction was retried');
    });

    it('40001 stays SerializationFailureError', async () => {
      await assert.rejects(db.$transaction(swallow('40001')), (err: unknown) => {
        assert.ok(err instanceof SerializationFailureError, String(err));
        assert.ok(!(err instanceof LockNotAvailableError));
        assert.equal(err.isRetryable, true);
        assert.match(err.message, /rolled back, not committed/);
        return true;
      });
    });

    it('55P03 stays LockNotAvailableError, not its parent', async () => {
      await assert.rejects(db.$transaction(swallow('55P03')), (err: unknown) => {
        assert.ok(err instanceof LockNotAvailableError, String(err));
        assert.equal(err.isRetryable, true);
        assert.equal(err.code, 'TURBINE_E013');
        assert.match(err.message, /rolled back, not committed/);
        return true;
      });
    });

    it('a nested block keeps the class too', async () => {
      await db.$transaction(async (tx) => {
        await assert.rejects(tx.$transaction(swallow('40P01')), (err: unknown) => {
          assert.ok(err instanceof DeadlockError, String(err));
          assert.match(err.message, /nested `\$transaction` block was rolled back/);
          return true;
        });
      });
    });

    it('a real deadlock: the victim that swallows it rejects with DeadlockError, the other commits', async () => {
      const { counters } = fx.t;
      let arrived = 0;
      let release!: () => void;
      const bothHoldOne = new Promise<void>((resolve) => {
        release = resolve;
      });
      const run = (first: number, second: number): Promise<'committed' | DeadlockError> =>
        db
          .$transaction(async (tx) => {
            await tx.rawUnsafe(`UPDATE ${counters} SET n = n + 1 WHERE id = ${first}`);
            if (++arrived === 2) release();
            await bothHoldOne;
            try {
              await tx.rawUnsafe(`UPDATE ${counters} SET n = n + 1 WHERE id = ${second}`);
            } catch {
              // the deadlock victim swallows the failure and returns
            }
          })
          .then(
            () => 'committed' as const,
            (err: unknown) => {
              assert.ok(err instanceof DeadlockError, `expected DeadlockError, got ${String(err)}`);
              return err;
            },
          );
      const outcomes = await within(Promise.all([run(1, 2), run(2, 1)]), 10_000, 'the deadlocked pair');
      const failed = outcomes.filter((o): o is DeadlockError => o !== 'committed');
      assert.equal(failed.length, 1, 'exactly one transaction is the deadlock victim');
      assert.equal(outcomes.filter((o) => o === 'committed').length, 1);
      assert.equal(failed[0]!.isRetryable, true);
      assert.match(failed[0]!.message, /rolled back, not committed/);
    });
  });
});
