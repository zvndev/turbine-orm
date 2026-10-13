/**
 * turbine-orm: re-checks of three transaction defects against live Postgres,
 * written from the original reproductions rather than from the fixes.
 *
 *   1. A nested write nobody awaited must not commit half of itself.
 *   2. A statement issued while a sibling `tx.$transaction` block is open must
 *      not be undone by that block's rollback.
 *   3. The client `transaction(fn)` hands out must not be usable once the
 *      transaction has settled, least of all after its connection went to the
 *      next caller.
 *
 * Run: DATABASE_URL=... npx tsx --test src/test/fix-txerr-reverify.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe, beforeEach as eachTest } from 'node:test';
import pg from 'pg';
import type { PgCompatPoolClient, TurbineClient } from '../client.js';
import { TransactionRolledBackError, ValidationError } from '../errors.js';
import { skipGate } from './helpers.js';
import { DATABASE_URL, openFixture, sleep, type TxFixture } from './transactions-fixture.js';

const { it, before, after } = skipGate(!DATABASE_URL, 'DATABASE_URL not set');
const beforeEach: typeof eachTest = DATABASE_URL ? eachTest : () => {};

function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

function e003(pattern: RegExp) {
  return (err: unknown): boolean => {
    assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
    assert.equal(err.code, 'TURBINE_E003');
    assert.match(err.message, pattern, err.message);
    return true;
  };
}

describe('re-verified transaction defects (live Postgres)', () => {
  let fx: TxFixture;
  let db: TurbineClient;
  let single: TurbineClient;

  before(async () => {
    fx = await openFixture('fxtr');
    db = fx.client({ poolSize: 4 });
    single = fx.client({ poolSize: 1 });
  });
  beforeEach(async () => {
    await fx.reset();
  });
  after(async () => {
    await fx?.close();
  });

  describe('a nested write that is never awaited does not commit half of itself', () => {
    /** Every insert into `table` takes 250ms, so a nested write is still mid-flight when the callback returns. */
    async function slowInserts(table: string, on: boolean): Promise<void> {
      if (!on) {
        await fx.raw.query(`DROP TRIGGER IF EXISTS fxtr_slow ON ${table}; DROP FUNCTION IF EXISTS fxtr_slow()`);
        return;
      }
      await fx.raw.query(`
        CREATE FUNCTION fxtr_slow() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.25); RETURN NEW; END $$;
        CREATE TRIGGER fxtr_slow BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fxtr_slow();
      `);
    }

    it('returns while the child inserts are still running: E003, nothing committed, nothing lands later', async () => {
      const { orgs, users } = fx.t;
      await slowInserts(users, true);
      try {
        let stray: Promise<unknown> | undefined;
        await assert.rejects(
          within(
            db.$transaction(async (tx) => {
              stray = tx.table(orgs).create({
                data: { name: 'half', members: { create: [{ email: 'h1@x' }, { email: 'h2@x' }] } },
              });
              stray.catch(() => {});
              await sleep(80);
              return 'ok';
            }),
            5000,
            'the transaction that returned mid-write',
          ),
          e003(/callback returned while a query it started on the transaction was still running/),
        );
        await stray?.catch(() => {});
        await sleep(700);
        assert.equal(await fx.count(orgs, "name = 'half'"), 0, 'the parent row was committed without its children');
        assert.equal(await fx.count(users, "email IN ('h1@x', 'h2@x')"), 0);
      } finally {
        await slowInserts(users, false);
      }
    });

    it('returning in the gap between two statements of the write: all or nothing, over many rounds', async () => {
      const { orgs, users } = fx.t;
      // The callback returns the instant the org INSERT's reply arrives, which is
      // when the nested write is between its first statement and its second.
      let onOrgInserted: (() => void) | undefined;
      const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
      const connect = pool.connect.bind(pool) as () => Promise<pg.PoolClient>;
      (pool as unknown as { connect: () => Promise<pg.PoolClient> }).connect = async () => {
        const client = await connect();
        const patched = client as pg.PoolClient & { gapped?: true };
        if (!patched.gapped) {
          patched.gapped = true;
          const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
          (client as unknown as { query: (...args: unknown[]) => unknown }).query = async (...args: unknown[]) => {
            const first = args[0];
            const text = typeof first === 'string' ? first : String((first as { text?: string }).text);
            const result = await query(...args);
            if (text.includes(`INSERT INTO "${orgs}"`)) onOrgInserted?.();
            return result;
          };
        }
        return client;
      };
      const gapDb = fx.client({ pool: pool as never });
      try {
        let committed = 0;
        let refused = 0;
        for (let round = 0; round < 40; round++) {
          await fx.reset();
          const inserted = new Promise<void>((resolve) => {
            onOrgInserted = resolve;
          });
          let stray: Promise<unknown> | undefined;
          const outcome = await within(
            gapDb.$transaction(async (tx) => {
              stray = tx.table(orgs).create({
                data: { name: 'half', members: { create: [{ email: 'h1@x' }, { email: 'h2@x' }] } },
              });
              stray.catch(() => {});
              await inserted;
              return 'ok';
            }),
            8000,
            `round ${round}`,
          ).then(
            () => 'committed' as const,
            (err: unknown) => {
              e003(/callback returned while a query/)(err);
              return 'refused' as const;
            },
          );
          await stray?.catch(() => {});
          await sleep(15);
          const org = await fx.count(orgs, "name = 'half'");
          const kids = await fx.count(users, "email IN ('h1@x', 'h2@x')");
          if (outcome === 'committed') {
            committed++;
            assert.deepEqual([org, kids], [1, 2], `round ${round}: committed ${org} org and ${kids} of 2 members`);
          } else {
            refused++;
            assert.deepEqual([org, kids], [0, 0], `round ${round}: refused but left ${org} org and ${kids} members`);
          }
        }
        assert.ok(refused + committed === 40);
        assert.ok(refused > 0, `no round returned mid-write (committed ${committed}), so this proved nothing`);
      } finally {
        onOrgInserted = undefined;
      }
    });

    it('an un-awaited nested update is held to the same rule', async () => {
      const { users, orgs } = fx.t;
      await slowInserts(orgs, true);
      try {
        await assert.rejects(
          within(
            db.$transaction(async (tx) => {
              tx.table(users)
                .update({ where: { email: 'a@x' }, data: { tenant: 'changed', org: { create: { name: 'new-org' } } } })
                .catch(() => {});
              await sleep(60);
            }),
            5000,
            'the un-awaited nested update',
          ),
          e003(/callback returned while a query/),
        );
        await sleep(500);
        assert.equal(await fx.count(users, "tenant = 'changed'"), 0);
        assert.equal(await fx.count(orgs, "name = 'new-org'"), 0);
      } finally {
        await slowInserts(orgs, false);
      }
    });
  });

  describe('a statement issued while a sibling block is open', () => {
    it('is not undone when that block rolls back', async () => {
      const { users } = fx.t;
      let parentId: unknown;
      await within(
        db.$transaction(async (tx) => {
          const block = tx.$transaction(async (inner) => {
            await inner.table(users).create({ data: { email: 'block@x' } });
            await sleep(150);
            throw new Error('block failed on purpose');
          });
          block.catch(() => {});
          // The block's SAVEPOINT is on the connection by now.
          await sleep(40);
          const parent = await tx.table(users).create({ data: { email: 'parent@x' } });
          parentId = parent.id;
          await assert.rejects(block, /block failed on purpose/);
        }),
        5000,
        'the transaction with a failing sibling block',
      );
      assert.ok(parentId !== undefined);
      assert.equal(
        await fx.count(users, `email = 'parent@x' AND id = ${String(parentId)}`),
        1,
        'the parent insert was undone',
      );
      assert.equal(await fx.count(users, "email = 'block@x'"), 0);
    });

    it('holds for Promise.all, for a read-then-write at the parent level, and for several blocks in a row', async () => {
      const { users } = fx.t;
      await within(
        db.$transaction(async (tx) => {
          const failing = (email: string) =>
            tx
              .$transaction(async (inner) => {
                await inner.table(users).create({ data: { email } });
                await sleep(60);
                throw new Error('nope');
              })
              .catch(() => {});
          const blocks = Promise.all([failing('b1@x'), failing('b2@x')]);
          await sleep(40);
          await Promise.all([
            tx.table(users).create({ data: { email: 'p1@x' } }),
            tx.table(users).update({ where: { email: 'a@x' }, data: { tenant: 'kept' } }),
          ]);
          await blocks;
          await failing('b3@x');
          await tx.table(users).create({ data: { email: 'p2@x' } });
        }),
        8000,
        'the transaction with several blocks',
      );
      assert.equal(await fx.count(users, "email IN ('p1@x', 'p2@x')"), 2);
      assert.equal(await fx.count(users, "email = 'a@x' AND tenant = 'kept'"), 1);
      assert.equal(await fx.count(users, "email IN ('b1@x', 'b2@x', 'b3@x')"), 0);
    });
  });

  describe('the client transaction(fn) hands out is closed when the transaction settles', () => {
    it('after COMMIT: a query is refused, not run', async () => {
      let leaked: PgCompatPoolClient | undefined;
      await single.transaction(async (client) => {
        leaked = client;
        await client.query('SELECT 1');
      });
      await assert.rejects(leaked!.query('SELECT 1'), e003(/This transaction committed/));
      await assert.rejects(
        new Promise((resolve, reject) => {
          const withCallback = leaked as unknown as { query(sql: string, cb: (err?: Error | null) => void): void };
          withCallback.query('SELECT 1', (err) => (err ? reject(err) : resolve(undefined)));
        }),
        e003(/This transaction committed/),
      );
    });

    it('after ROLLBACK: a query is refused, and says so', async () => {
      let leaked: PgCompatPoolClient | undefined;
      await assert.rejects(
        single.transaction(async (client) => {
          leaked = client;
          throw new Error('callback failed');
        }),
        /callback failed/,
      );
      await assert.rejects(leaked!.query('SELECT 1'), e003(/This transaction was rolled back/));
    });

    it('after the connection went to the next transaction: the late write does not run inside it', async () => {
      const { users } = fx.t;
      let leaked: PgCompatPoolClient | undefined;
      await single.transaction(async (client) => {
        leaked = client;
        await client.query('SELECT 1');
      });
      const next = single.transaction(async (client) => {
        await client.query(`INSERT INTO ${users} (email) VALUES ('next@x')`);
        await sleep(150);
      });
      await sleep(40);
      await assert.rejects(
        leaked!.query(`INSERT INTO ${users} (email) VALUES ('late@x')`),
        e003(/This transaction committed/),
      );
      await next;
      assert.equal(await fx.count(users, "email = 'late@x'"), 0, 'the late write ran in the next transaction');
      assert.equal(await fx.count(users, "email = 'next@x'"), 1);
    });

    it('release() is refused while the callback runs, and the connection survives the attempt', async () => {
      await assert.rejects(
        single.transaction(async (client) => {
          client.release();
        }),
        e003(/must not release its client/),
      );
      assert.equal((await single.rawUnsafe<{ one: number }>('SELECT 1 AS one'))[0]?.one, 1);
    });

    it('a failure the callback swallowed is E019, and the raw client is closed after it too', async () => {
      let leaked: PgCompatPoolClient | undefined;
      await assert.rejects(
        single.transaction(async (client) => {
          leaked = client;
          await client.query('SELECT 1/0').catch(() => {});
        }),
        (err: unknown) => err instanceof TransactionRolledBackError && /ROLLBACK TO SAVEPOINT/.test(err.message),
      );
      await assert.rejects(leaked!.query('SELECT 1'), e003(/This transaction was rolled back/));
    });
  });
});
