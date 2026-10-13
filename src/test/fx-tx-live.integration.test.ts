/**
 * turbine-orm: transactions after a failed statement, nested block handles and
 * raw transaction control, on a real PostgreSQL server.
 *
 * `fx-tx-state.test.ts` pins the same rules against a fake connection. These
 * cases are the ones where the SERVER's behavior is the point: the real 25P02,
 * a real row lock that fails a `noWait` read and times a query out, a real
 * rollback to a savepoint, and what a stray COMMIT does to later writes.
 *
 * Run: DATABASE_URL=... npx tsx --test src/test/fx-tx-live.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe, beforeEach as eachTest } from 'node:test';
import pg from 'pg';
import type { TransactionClient, TurbineClient } from '../client.js';
import {
  LockNotAvailableError,
  TimeoutError,
  TransactionRolledBackError,
  ValidationError,
  wrapPgError,
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

async function openClient(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  return client;
}

describe('transactions after a failed statement, handles and raw control (live Postgres)', () => {
  let fx: TxFixture;
  let db: TurbineClient;

  before(async () => {
    fx = await openFixture('fxtl');
    db = fx.client({ poolSize: 4 });
  });
  beforeEach(async () => {
    await fx.reset();
  });
  after(async () => {
    await fx?.close();
  });

  /** Another connection holds the row lock on counter 1 until `release()`. */
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

  describe('a statement after a failed one', () => {
    it('lock noWait failure, caught, then one more statement: the retryable class, and $retry retries', async () => {
      const { counters } = fx.t;
      const lock = await holdCounterOne();
      let attempts = 0;
      try {
        const error = await within(
          db
            .$retry(
              () =>
                db.$transaction(async (tx) => {
                  attempts++;
                  await tx
                    .table(counters)
                    .findMany({ where: { id: 1 }, lock: { mode: 'update', noWait: true } })
                    .catch(() => {});
                  return tx.table(counters).count();
                }),
              { maxAttempts: 3, baseDelay: 1 },
            )
            .then(
              () => undefined,
              (err: unknown) => err,
            ),
          5000,
          'the retried transaction',
        );
        assert.ok(error instanceof LockNotAvailableError, String(error));
        assert.equal(error.isRetryable, true);
        assert.match(error.message, /This statement was not sent/);
        assert.ok(error.cause instanceof LockNotAvailableError, 'the lock failure itself is the cause');
        assert.equal(attempts, 3);
      } finally {
        await lock.release();
      }
    });

    it('every path gives a TurbineError, never the driver 25P02', async () => {
      const { counters } = fx.t;
      for (const [label, next] of [
        ['accessor', (tx: TransactionClient) => tx.table(counters).count()],
        ['raw', (tx: TransactionClient) => tx.raw`SELECT 1`],
        ['rawUnsafe', (tx: TransactionClient) => tx.rawUnsafe('SELECT 1')],
        ['nested block', (tx: TransactionClient) => tx.$transaction(async () => 1)],
        ['$connection', (tx: TransactionClient) => tx.$connection().query('SELECT 1')],
      ] as const) {
        await assert.rejects(
          db.$transaction(async (tx) => {
            await tx.rawUnsafe('SELECT 1/0').catch(() => {});
            return next(tx);
          }),
          (err: unknown) => {
            assert.ok(err instanceof TransactionRolledBackError, `${label}: ${String(err)}`);
            assert.equal(err.code, 'TURBINE_E019');
            assert.equal((err.cause as { sqlstate?: string }).sqlstate, '22012', `${label}: the division is the cause`);
            return true;
          },
          label,
        );
      }
    });

    it('a per-query timeout, caught, then one more statement: E019 with the TimeoutError as cause', async () => {
      const { users, counters } = fx.t;
      const lock = await holdCounterOne();
      let caught: unknown;
      try {
        await assert.rejects(
          within(
            db.$transaction(async (tx) => {
              await tx.table(users).create({ data: { email: 'kept?@x' } });
              try {
                await tx.table(counters).update({ where: { id: 1 }, data: { n: 7 }, timeout: 150 });
              } catch (err) {
                caught = err;
              }
              return tx.table(users).count();
            }),
            4000,
            'the transaction that queried after a timeout',
          ),
          (err: unknown) => {
            assert.ok(err instanceof TransactionRolledBackError, String(err));
            assert.ok(err.cause instanceof TimeoutError, String(err.cause));
            assert.match(err.message, /This statement was not sent/);
            return true;
          },
        );
      } finally {
        await lock.release();
      }
      assert.ok(caught instanceof TimeoutError);
      assert.equal(await fx.count(users, "email = 'kept?@x'"), 0);
    });

    it('the documented recovery works: a lock failure in a nested block, caught, and the transaction commits', async () => {
      const { users, counters } = fx.t;
      const lock = await holdCounterOne();
      let inner: unknown;
      try {
        await within(
          db.$transaction(async (tx) => {
            await tx.table(users).create({ data: { email: 'before@x' } });
            try {
              await tx.$transaction((block) =>
                block.table(counters).findMany({ where: { id: 1 }, lock: { mode: 'update', noWait: true } }),
              );
            } catch (err) {
              inner = err;
            }
            await tx.table(users).create({ data: { email: 'after@x' } });
            assert.equal(await tx.table(counters).count(), 2);
          }),
          4000,
          'the transaction that recovered in a nested block',
        );
      } finally {
        await lock.release();
      }
      assert.ok(inner instanceof LockNotAvailableError, String(inner));
      assert.equal(await fx.count(users, "email IN ('before@x', 'after@x')"), 2);
    });

    it('a failure inside a block that stays uncaught rolls the block back and the outer goes on', async () => {
      const { users } = fx.t;
      await db.$transaction(async (tx) => {
        await assert.rejects(
          tx.$transaction(async (block) => {
            await block.table(users).create({ data: { email: 'in-block@x' } });
            await block.table(users).create({ data: { email: 'a@x' } });
          }),
        );
        await tx.table(users).create({ data: { email: 'after-block@x' } });
      });
      assert.equal(await fx.count(users, "email = 'in-block@x'"), 0);
      assert.equal(await fx.count(users, "email = 'after-block@x'"), 1);
    });

    it('raw transaction(): a rollback to a savepoint recovers, and a statement without one is E019', async () => {
      const { users } = fx.t;
      const done = await db.transaction(async (client) => {
        await client.query(`INSERT INTO ${users} (email) VALUES ('raw-kept@x')`);
        await client.query('SAVEPOINT s');
        await client.query(`INSERT INTO ${users} (email) VALUES ('a@x')`).catch(() => {});
        await client.query('ROLLBACK TO SAVEPOINT s');
        await client.query(`INSERT INTO ${users} (email) VALUES ('raw-also@x')`);
        return 'ok';
      });
      assert.equal(done, 'ok');
      assert.equal(await fx.count(users, "email IN ('raw-kept@x', 'raw-also@x')"), 2);

      await assert.rejects(
        db.transaction(async (client) => {
          await client.query(`INSERT INTO ${users} (email) VALUES ('a@x')`).catch(() => {});
          await client.query(`INSERT INTO ${users} (email) VALUES ('raw-lost@x')`);
        }),
        (err: unknown) => err instanceof TransactionRolledBackError && /ROLLBACK TO SAVEPOINT/.test(err.message),
      );
      assert.equal(await fx.count(users, "email = 'raw-lost@x'"), 0);
    });

    it('the server really does answer 25P02 on a connection used outside Turbine, and that is E019', async () => {
      const client = await openClient();
      try {
        await client.query('BEGIN');
        await client.query('SELECT 1/0').catch(() => {});
        const err = await client.query('SELECT 1').then(
          () => undefined,
          (e: unknown) => e,
        );
        assert.equal((err as { code?: string }).code, '25P02');
        const wrapped = wrapPgError(err);
        assert.ok(wrapped instanceof TransactionRolledBackError, String(wrapped));
        assert.equal(wrapped.cause, err);
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        await client.end();
      }
    });
  });

  describe('the outer tx inside a nested block', () => {
    it('a write through the outer handle in a block that then throws is refused, not silently undone', async () => {
      const { users } = fx.t;
      await db.$transaction(async (tx) => {
        await assert.rejects(
          tx.$transaction(async () => {
            await tx.table(users).update({ where: { id: 1 }, data: { email: 'moved@x' } });
            throw new Error('the block fails');
          }),
          (err: unknown) => err instanceof ValidationError && /outer `tx`/.test(err.message),
        );
      });
      assert.equal(await fx.count(users, "email = 'moved@x'"), 0);
    });

    it("the block's own handle does the work and is undone with the block", async () => {
      const { users } = fx.t;
      await db.$transaction(async (tx) => {
        await assert.rejects(
          tx.$transaction(async (block) => {
            await block.table(users).update({ where: { id: 1 }, data: { email: 'undone@x' } });
            throw new Error('the block fails');
          }),
          /the block fails/,
        );
        await tx.table(users).update({ where: { id: 2 }, data: { email: 'outer@x' } });
      });
      assert.equal(await fx.count(users, "email = 'undone@x'"), 0);
      assert.equal(await fx.count(users, "email = 'outer@x'"), 1);
    });

    it('a nested write through the block handle keeps its own savepoint, and the block commits with the outer', async () => {
      const { orgs, users } = fx.t;
      await db.$transaction(async (tx) => {
        await tx.$transaction(async (block) => {
          await block
            .table(orgs)
            .create({ data: { name: 'initech', members: { create: [{ email: 'n1@x' }] } } as never });
          // Fails part way: the savepoint of the write undoes the org, and the block carries on.
          await block
            .table(orgs)
            .create({ data: { name: 'vandelay', members: { create: [{ email: 'a@x' }] } } as never })
            .catch(() => {});
          await block.table(orgs).create({ data: { name: 'umbrella' } });
        });
      });
      assert.equal(await fx.count(orgs, "name IN ('initech', 'umbrella')"), 2);
      assert.equal(await fx.count(orgs, "name = 'vandelay'"), 0);
      assert.equal(await fx.count(users, "email = 'n1@x'"), 1);
    });
  });

  describe('raw SQL that ends the transaction', () => {
    const attempts: Array<[string, (tx: TransactionClient) => Promise<unknown>]> = [
      ['tx.rawUnsafe', (tx) => tx.rawUnsafe('COMMIT')],
      ['tx.raw', (tx) => tx.raw`COMMIT`],
      ['tx.sql', (tx) => tx.sql`COMMIT`.then((rows) => rows)],
      ['$connection().query', (tx) => tx.$connection().query('COMMIT')],
      ['a second statement in the text', (tx) => tx.rawUnsafe('SELECT 1; COMMIT')],
      ['ROLLBACK', (tx) => tx.rawUnsafe('ROLLBACK')],
      ['END', (tx) => tx.rawUnsafe('END')],
    ];
    for (const [label, send] of attempts) {
      it(`${label}: refused, so the callback's throw still undoes its writes`, async () => {
        const { users } = fx.t;
        await assert.rejects(
          db.$transaction(async (tx) => {
            await tx.table(users).update({ where: { id: 1 }, data: { email: 'early@x' } });
            await assert.rejects(
              send(tx),
              (err: unknown) => err instanceof ValidationError && err.code === 'TURBINE_E003',
            );
            await tx.table(users).update({ where: { id: 2 }, data: { email: 'late@x' } });
            throw new Error('the callback fails');
          }),
          /the callback fails/,
        );
        assert.equal(await fx.count(users, "email IN ('early@x', 'late@x')"), 0, 'neither write was kept');
      });
    }

    it('before the guard, a stray COMMIT made the later write permanent: it does not any more', async () => {
      const { users } = fx.t;
      await assert.rejects(
        db.$transaction(async (tx) => {
          const conn = tx.$connection();
          await conn.query(`UPDATE ${users} SET email = 'c1@x' WHERE id = 1`);
          await assert.rejects(conn.query('COMMIT'), ValidationError);
          await tx.table(users).update({ where: { id: 3 }, data: { email: 'c3@x' } });
          throw new Error('the callback fails');
        }),
        /the callback fails/,
      );
      assert.equal(await fx.count(users, "email IN ('c1@x', 'c3@x')"), 0);
    });

    it('statements that only mention the words run, and a transaction still commits once', async () => {
      const { users } = fx.t;
      await db.$transaction(async (tx) => {
        await tx.rawUnsafe(`SELECT 'COMMIT; ROLLBACK' AS note /* BEGIN */`);
        await tx.rawUnsafe('DO $$ BEGIN PERFORM 1; END $$');
        await tx.table(users).update({ where: { id: 1 }, data: { email: 'words@x' } });
      });
      assert.equal(await fx.count(users, "email = 'words@x'"), 1);
    });

    it('transaction(): savepoints work, COMMIT is refused, and the writes survive only a clean return', async () => {
      const { users } = fx.t;
      await assert.rejects(
        db.transaction(async (client) => {
          await client.query(`UPDATE ${users} SET email = 'raw1@x' WHERE id = 1`);
          await client.query('SAVEPOINT a');
          await client.query(`UPDATE ${users} SET email = 'raw2@x' WHERE id = 2`);
          await client.query('ROLLBACK TO SAVEPOINT a');
          await client.query('RELEASE SAVEPOINT a');
          await assert.rejects(client.query('COMMIT'), ValidationError);
          throw new Error('the callback fails');
        }),
        /the callback fails/,
      );
      assert.equal(await fx.count(users, "email IN ('raw1@x', 'raw2@x')"), 0);
    });
  });

  describe('$connection()', () => {
    it('cannot end or reconnect the connection, and the driver object is out of reach; it still works', async () => {
      const { counters } = fx.t;
      await db.$transaction(async (tx) => {
        const conn = tx.$connection() as unknown as Record<string, unknown>;
        assert.throws(() => (conn.end as () => void)(), /must not end its client/);
        assert.throws(() => (conn.connect as () => void)(), /must not connect its client/);
        assert.equal(conn.connection, undefined);
        const rows = (await tx.$connection().query(`SELECT count(*)::int AS n FROM ${counters}`)).rows;
        assert.equal((rows[0] as { n: number }).n, 2);
      });
    });
  });
});
