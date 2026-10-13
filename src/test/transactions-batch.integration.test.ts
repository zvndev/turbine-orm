/**
 * turbine-orm: batched work (`pipeline`, array `$transaction`) commits only
 * what it reports.
 *
 *   - A transactional pipeline whose transform refuses its result (an
 *     `...OrThrow` miss, an optimistic-lock conflict, an update that matched no
 *     row) used to COMMIT first and reject afterwards, so the rejected batch's
 *     writes were saved. It now rolls back, exactly like `$transaction([...])`
 *     with the same items. A batch of plain SELECTs keeps its single round trip.
 *   - `$transaction([...], options)` honours `isolationLevel`,
 *     `sessionContext` and `timeout`, which used to be ignored.
 *   - A Promise in a batch (the Prisma `$transaction([db.x.create()])` habit)
 *     is refused with the fix, instead of failing inside the batch after the
 *     write had already run on its own.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/transactions-batch.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe, beforeEach as eachTest } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { NotFoundError, OptimisticLockError, TimeoutError, ValidationError } from '../errors.js';
import type { DeferredQuery } from '../query/index.js';
import { skipGate } from './helpers.js';
import { DATABASE_URL, openFixture, type TxFixture } from './transactions-fixture.js';

const { it, before, after } = skipGate(!DATABASE_URL, 'DATABASE_URL not set');
const beforeEach: typeof eachTest = DATABASE_URL ? eachTest : () => {};

/** A one-value probe statement in deferred form. */
function probe<T>(sql: string, params: unknown[] = []): DeferredQuery<T> {
  return { sql, params, transform: (r) => (r.rows[0] as { v: T }).v, tag: 'probe' };
}

/** A real pool whose connections count the protocol Syncs they send (one per round trip of a pipeline). */
function syncCountingPool(counter: { syncs: number }): pg.Pool {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  const connect = pool.connect.bind(pool) as () => Promise<pg.PoolClient>;
  (pool as unknown as { connect: () => Promise<pg.PoolClient> }).connect = async () => {
    const client = await connect();
    const connection = (client as unknown as { connection: { sync: () => void; counted?: true } }).connection;
    if (!connection.counted) {
      connection.counted = true;
      const sync = connection.sync.bind(connection);
      connection.sync = () => {
        counter.syncs++;
        sync();
      };
    }
    return client;
  };
  return pool;
}

describe('transactions: batches commit only what they report (live Postgres)', () => {
  let fx: TxFixture;
  let db: TurbineClient;
  const users = () => db.table<{ id: number; email: string; tenant: string | null }>(fx.t.users);
  const counters = () => db.table<{ id: number; n: number; version: number }>(fx.t.counters);

  before(async () => {
    fx = await openFixture('tx90b');
    db = fx.client({ poolSize: 1 });
  });
  beforeEach(async () => {
    await fx.reset();
  });
  after(async () => {
    await fx?.close();
  });

  describe('a transactional pipeline rolls back when a transform rejects', () => {
    it('update matching no row: the pipeline and $transaction([...]) leave the same state', async () => {
      const batch = (email: string) => [
        users().buildCreate({ data: { email } }),
        users().buildUpdate({ where: { id: 999 }, data: { tenant: 'x' } }),
      ];
      await assert.rejects(db.pipeline(batch('pipe@x')), NotFoundError);
      await assert.rejects(db.$transaction(batch('array@x')), NotFoundError);
      assert.equal(await fx.count(fx.t.users, "email = 'pipe@x'"), 0, 'the pipeline committed its insert');
      assert.equal(await fx.count(fx.t.users, "email = 'array@x'"), 0);
    });

    it('optimistic-lock conflict: the other write in the batch is rolled back', async () => {
      await assert.rejects(
        db.pipeline([
          counters().buildUpdate({ where: { id: 1 }, data: { n: { increment: 1 } } }),
          counters().buildUpdate({
            where: { id: 2 },
            data: { n: 5 },
            optimisticLock: { field: 'version', expected: 9 },
          }),
        ]),
        OptimisticLockError,
      );
      assert.equal(await fx.count(fx.t.counters, 'id = 1 AND n = 100'), 1, 'counter 1 is unchanged');
    });

    it('findUniqueOrThrow miss after a write: the write is rolled back', async () => {
      await assert.rejects(
        db.pipeline([
          users().buildCreate({ data: { email: 'orthrow@x' } }),
          users().buildFindUniqueOrThrow({ where: { id: 999 } }),
        ]),
        NotFoundError,
      );
      assert.equal(await fx.count(fx.t.users, "email = 'orthrow@x'"), 0);
    });

    it('a statement error still rolls back and leaves the connection clean', async () => {
      await assert.rejects(
        db.pipeline([
          users().buildCreate({ data: { email: 'dup1@x' } }),
          users().buildCreate({ data: { email: 'a@x' } }),
        ]),
      );
      assert.equal(await fx.count(fx.t.users, "email = 'dup1@x'"), 0);
      // poolSize 1: the next query runs on the same connection.
      assert.equal(await users().count(), 3);
    });

    it('a successful writing batch commits and resolves every result', async () => {
      const [created, updated, total] = await db.pipeline([
        users().buildCreate({ data: { email: 'ok@x' } }),
        counters().buildUpdate({ where: { id: 1 }, data: { n: { increment: 1 } } }),
        users().buildCount(),
      ]);
      assert.equal((created as { email: string }).email, 'ok@x');
      assert.equal((updated as { n: number }).n, 101);
      assert.equal(total, 4);
      assert.equal(await fx.count(fx.t.users, "email = 'ok@x'"), 1);
    });

    it('round trips: a read-only batch keeps one, a writing batch takes two', async () => {
      const counter = { syncs: 0 };
      const pool = syncCountingPool(counter);
      const client = new TurbineClient({ pool, warnOnUnlimited: false }, fx.schema);
      try {
        const u = client.table(fx.t.users);
        await client.pipeline([u.buildCount(), u.buildFindMany({ limit: 1 })]);
        assert.equal(counter.syncs, 1, 'read-only batch');
        counter.syncs = 0;
        await client.pipeline([u.buildCount(), u.buildCreate({ data: { email: 'rt@x' } })]);
        assert.equal(counter.syncs, 2, 'writing batch: the batch, then the held COMMIT');
      } finally {
        await client.disconnect();
        await pool.end();
      }
    });
  });

  describe('array $transaction honours its options', () => {
    it('isolationLevel', async () => {
      const [level] = await db.$transaction([probe<string>("SELECT current_setting('transaction_isolation') AS v")], {
        isolationLevel: 'Serializable',
      });
      assert.equal(level, 'serializable');
    });

    it('sessionContext', async () => {
      const [tenant] = await db.$transaction([probe<string>("SELECT current_setting('app.tenant', true) AS v")], {
        sessionContext: { 'app.tenant': 'tenant-42' },
      });
      assert.equal(tenant, 'tenant-42');
    });

    it('timeout', async () => {
      await assert.rejects(db.$transaction([probe('SELECT pg_sleep(0.5)::text AS v')], { timeout: 50 }), TimeoutError);
      assert.equal(await users().count(), 3, 'the pool recovered');
    });

    it('invalid options are refused before anything runs, even for an empty batch', async () => {
      await assert.rejects(
        db.$transaction([], { isolationLevel: 'Bogus' as never }),
        (err: unknown) => err instanceof ValidationError && /isolationLevel/.test(err.message),
      );
      await assert.rejects(
        db.$transaction([users().buildCreate({ data: { email: 'never@x' } })], {
          sessionContext: { 'app.tenant': undefined as never },
        }),
        ValidationError,
      );
      assert.equal(await fx.count(fx.t.users, "email = 'never@x'"), 0);
    });
  });

  describe('promises in a batch are refused with the fix', () => {
    it('$transaction([db.x.create(...)]) names buildCreate and the callback form', async () => {
      await assert.rejects(
        db.$transaction([users().create({ data: { email: 'eager@x' } }) as never]),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError, String(err));
          assert.match(err.message, /item 0 is a Promise/);
          assert.match(err.message, /buildCreate/);
          assert.match(err.message, /callback form/);
          return true;
        },
      );
    });

    it('pipeline([db.x.count()]) is refused the same way', async () => {
      await assert.rejects(db.pipeline([users().count() as never]), /item 0 is a Promise/);
    });

    it('a value that is neither a function nor an array is refused', async () => {
      await assert.rejects(db.$transaction('SELECT 1' as never), ValidationError);
    });
  });
});
