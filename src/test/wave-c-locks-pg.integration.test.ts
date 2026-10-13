/**
 * Row locks (`lock`) against a live PostgreSQL.
 *
 * Every claim is checked from a SECOND transaction, because a lock is only
 * observable by someone it blocks: `skipLocked` hands two workers disjoint
 * rows, `noWait` fails at once with `LockNotAvailableError`, a blocking lock
 * waits until a per-query `timeout` ends it, and the four modes conflict
 * exactly as PostgreSQL's row-lock table says (which is what proves each mode
 * reaches the server as itself). Relation loading never locks the related
 * table, on any strategy.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/wave-c-locks-pg.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe, beforeEach as eachTest } from 'node:test';
import type { TransactionClient, TurbineClient } from '../client.js';
import { LockNotAvailableError, SerializationFailureError, TimeoutError, ValidationError } from '../errors.js';
import { tableAccessorName } from '../global-filters-config.js';
import type { RowLock, RowLockMode } from '../query/types.js';
import { skipGate } from './helpers.js';
import { DATABASE_URL, openFixture, type TxFixture } from './transactions-fixture.js';

const { it, before, after } = skipGate(!DATABASE_URL, 'DATABASE_URL not set');
const beforeEach: typeof eachTest = DATABASE_URL ? eachTest : () => {};

type Row = { id: number };
const ids = (rows: readonly Row[]) => rows.map((r) => r.id);

interface Held<T> {
  readonly value: T;
  /** Commit the holding transaction and wait for it. */
  release(): Promise<void>;
}

/**
 * Run `body` in a transaction that stays open, and its locks held, until
 * `release()`. A failure in `body` rejects here and ends the transaction.
 */
async function hold<T>(db: TurbineClient, body: (tx: TransactionClient) => Promise<T>): Promise<Held<T>> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let ready!: (value: T) => void;
  let failed!: (error: unknown) => void;
  const value = new Promise<T>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  const done = db.$transaction(async (tx) => {
    try {
      ready(await body(tx));
    } catch (error) {
      failed(error);
      throw error;
    }
    await gate;
  });
  done.catch(() => {});
  const v = await value;
  return {
    value: v,
    async release() {
      open();
      await done;
    },
  };
}

function lockNotAvailable(err: unknown): boolean {
  assert.ok(err instanceof LockNotAvailableError, `expected LockNotAvailableError, got ${String(err)}`);
  assert.ok(err instanceof SerializationFailureError, 'a retry loop catching E013 also catches it');
  assert.equal(err.code, 'TURBINE_E013');
  assert.equal(err.isRetryable, true);
  assert.equal((err.cause as { code?: string }).code, '55P03');
  return true;
}

describe('lock: live PostgreSQL', () => {
  let fx: TxFixture;
  let db: TurbineClient;
  let users: string;
  let posts: string;

  before(async () => {
    fx = await openFixture('wclk');
    db = fx.client({ poolSize: 6 });
    users = fx.t.users;
    posts = fx.t.posts;
  });
  beforeEach(async () => {
    await fx.reset();
    // Users 1..5 (1 and 3 in tenant t1, 2 in t2), posts 1 and 2 by user 1.
    // Explicit ids: CockroachDB's SERIAL does not count from 1.
    await fx.raw.query(`INSERT INTO ${users} (id, email, tenant) VALUES (4, 'd@x', 't2'), (5, 'e@x', 't2')`);
  });
  after(async () => {
    await fx?.close();
  });

  /** Try to take `lock` on user `id` from another transaction, without waiting. */
  async function canLock(table: string, id: number, mode: RowLockMode = 'update'): Promise<boolean> {
    try {
      await db.$transaction((tx) => tx.table(table).findUnique({ where: { id }, lock: { mode, noWait: true } }));
      return true;
    } catch (err) {
      lockNotAvailable(err);
      return false;
    }
  }

  it('skipLocked: two workers claim disjoint rows, and released rows are claimable again', async () => {
    const claim = (tx: TransactionClient) =>
      tx.table<Row>(users).findMany({ orderBy: { id: 'asc' }, limit: 3, lock: { mode: 'update', skipLocked: true } });
    const first = await hold(db, claim);
    try {
      assert.deepEqual(ids(first.value), [1, 2, 3]);
      const second = await hold(db, claim);
      try {
        assert.deepEqual(ids(second.value), [4, 5], 'the locked rows are skipped, not waited for');
      } finally {
        await second.release();
      }
    } finally {
      await first.release();
    }
    const again = await db.$transaction(claim);
    assert.deepEqual(ids(again), [1, 2, 3]);
  });

  it('noWait: LockNotAvailableError at once, on every read entry point', async () => {
    const held = await hold(db, (tx) => tx.table(users).findUnique({ where: { id: 1 }, lock: 'update' }));
    try {
      const noWait: RowLock = { mode: 'update', noWait: true };
      const attempts: [string, (tx: TransactionClient) => Promise<unknown>][] = [
        ['findMany', (tx) => tx.table(users).findMany({ where: { id: 1 }, lock: noWait })],
        ['findFirst', (tx) => tx.table(users).findFirst({ where: { id: 1 }, lock: noWait })],
        ['findFirstOrThrow', (tx) => tx.table(users).findFirstOrThrow({ where: { id: 1 }, lock: noWait })],
        ['findUnique', (tx) => tx.table(users).findUnique({ where: { id: 1 }, lock: noWait })],
        ['findUniqueOrThrow', (tx) => tx.table(users).findUniqueOrThrow({ where: { id: 1 }, lock: noWait })],
      ];
      for (const [label, attempt] of attempts) {
        const started = performance.now();
        await assert.rejects(db.$transaction(attempt), lockNotAvailable, label);
        assert.ok(performance.now() - started < 2000, `${label} did not wait`);
      }
      // An unlocked row is free.
      assert.equal(await canLock(users, 2), true);
    } finally {
      await held.release();
    }
  });

  it('noWait aborts the transaction; inside a nested $transaction (a savepoint) it does not', async () => {
    const held = await hold(db, (tx) => tx.table(users).findUnique({ where: { id: 1 }, lock: 'update' }));
    try {
      let after: unknown;
      await assert.rejects(
        db.$transaction(async (tx) => {
          await assert.rejects(
            tx.table(users).findUnique({ where: { id: 1 }, lock: { mode: 'update', noWait: true } }),
            lockNotAvailable,
          );
          try {
            await tx.table(users).findUnique({ where: { id: 2 } });
          } catch (err) {
            after = err;
            throw err;
          }
        }),
      );
      // The aborted transaction refuses the next statement locally, with the
      // first failure's class, so a retry wrapper still sees a retryable error
      // instead of the server's untyped 25P02.
      assert.ok(after instanceof LockNotAvailableError, `expected LockNotAvailableError, got ${String(after)}`);
      assert.equal(after.isRetryable, true);
      // The first failure rides along as the cause.
      assert.ok(lockNotAvailable(after.cause), 'the cause is the noWait failure itself');

      const claimed = await db.$transaction(async (tx) => {
        await assert.rejects(
          tx.$transaction((sp) =>
            sp.table(users).findUnique({ where: { id: 1 }, lock: { mode: 'update', noWait: true } }),
          ),
          lockNotAvailable,
        );
        return tx.table<Row>(users).findUnique({ where: { id: 2 }, lock: 'update' });
      });
      assert.equal(claimed?.id, 2, 'the transaction went on after the savepoint rolled back');
    } finally {
      await held.release();
    }
  });

  it('a plain lock waits for the holder to commit; an unlocked read does not wait', async () => {
    const held = await hold(db, (tx) => tx.table(users).findUnique({ where: { id: 1 }, lock: 'update' }));
    let resolvedAt = 0;
    const waiter = db
      .$transaction((tx) => tx.table<Row>(users).findUnique({ where: { id: 1 }, lock: 'update' }))
      .then((row) => {
        resolvedAt = performance.now();
        return row;
      });
    let committedAt = 0;
    try {
      const plain = await db.table<Row>(users).findUnique({ where: { id: 1 } });
      assert.equal(plain?.id, 1, 'MVCC: a plain read is not blocked');
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(resolvedAt, 0, 'still waiting while the holder is open');
    } finally {
      committedAt = performance.now();
      await held.release();
    }
    assert.equal((await waiter)?.id, 1);
    assert.ok(resolvedAt >= committedAt, 'resolved only after the holder committed');
  });

  it('a blocking lock waits, and a per-query timeout ends the wait with TimeoutError', async () => {
    const held = await hold(db, (tx) => tx.table(users).findUnique({ where: { id: 1 }, lock: 'share' }));
    try {
      const started = performance.now();
      await assert.rejects(
        db.$transaction((tx) => tx.table(users).findUnique({ where: { id: 1 }, lock: 'update', timeout: 200 })),
        (err: unknown) => err instanceof TimeoutError && err.code === 'TURBINE_E002',
      );
      const waited = performance.now() - started;
      assert.ok(waited >= 150 && waited < 5000, `waited ${Math.round(waited)} ms`);
      // A compatible lock does not wait at all.
      assert.equal(await canLock(users, 1, 'share'), true);
    } finally {
      await held.release();
    }
    // The holder committed normally, and the row is free again.
    assert.equal(await canLock(users, 1), true);
  });

  it('the four modes conflict exactly as PostgreSQL row locks do', async () => {
    const modes: RowLockMode[] = ['keyShare', 'share', 'noKeyUpdate', 'update'];
    // PostgreSQL's conflict table, held mode -> requested modes that must wait.
    const conflicts: Record<RowLockMode, RowLockMode[]> = {
      keyShare: ['update'],
      share: ['noKeyUpdate', 'update'],
      noKeyUpdate: ['share', 'noKeyUpdate', 'update'],
      update: ['keyShare', 'share', 'noKeyUpdate', 'update'],
    };
    for (const heldMode of modes) {
      const held = await hold(db, (tx) => tx.table(users).findUnique({ where: { id: 1 }, lock: heldMode }));
      try {
        for (const wanted of modes) {
          const free = await canLock(users, 1, wanted);
          assert.equal(free, !conflicts[heldMode].includes(wanted), `held ${heldMode}, requested ${wanted}`);
        }
      } finally {
        await held.release();
      }
    }
  });

  for (const [strategy, extra] of [
    ['join', {}],
    ['batched', {}],
    ['auto', {}],
    ['flatten', { jsonEncoding: 'object' }],
  ] as const) {
    it(`relationLoadStrategy '${strategy}': only the queried table is locked`, async () => {
      const held = await hold(db, async (tx) => {
        const rows = await tx.table<Row & { author: { id: number } }>(posts).findMany({
          where: { id: 1 },
          with: { author: true },
          relationLoadStrategy: strategy,
          ...extra,
          lock: 'update',
        });
        const locks = await tx.raw<{ rel: string; mode: string }>`
          SELECT relation::regclass::text AS rel, mode FROM pg_locks
          WHERE pid = pg_backend_pid() AND locktype = 'relation'`;
        return { rows, locks };
      });
      try {
        assert.equal(held.value.rows[0]?.author.id, 1, 'the relation loaded');
        // FOR UPDATE takes RowShareLock on the locked table (and its indexes); a
        // table read only to load a relation gets AccessShareLock.
        const rowShare = held.value.locks.filter((l) => l.mode === 'RowShareLock').map((l) => l.rel);
        assert.ok(rowShare.includes(posts), String(rowShare));
        assert.deepEqual(
          rowShare.filter((rel) => rel.startsWith(users)),
          [],
          'nothing of the related table is lock-scanned',
        );
        assert.equal(await canLock(posts, 1), false, 'the post is locked');
        assert.equal(await canLock(posts, 2), true, 'a post outside the where is not');
        assert.equal(await canLock(users, 1), true, 'its author is not');
      } finally {
        await held.release();
      }
    });
  }

  it('a lateral pick runs (OF keeps the joined subquery out of the lock)', async () => {
    const held = await hold(db, (tx) =>
      tx.table<Row>(users).findMany({
        orderBy: { posts: { pick: { orderBy: { id: 'desc' } }, by: 'title', plan: 'lateral' } },
        lock: 'noKeyUpdate',
      }),
    );
    try {
      assert.equal(held.value.length, 5);
      assert.equal(await canLock(users, 1, 'noKeyUpdate'), false);
      assert.equal(await canLock(posts, 2), true);
    } finally {
      await held.release();
    }
  });

  it('a cursor page locks that page', async () => {
    const held = await hold(db, (tx) =>
      tx.table<Row>(users).findMany({ orderBy: { id: 'asc' }, cursor: { id: 2 }, limit: 2, lock: 'update' }),
    );
    try {
      assert.deepEqual(ids(held.value), [3, 4], 'the page after the cursor');
      assert.equal(await canLock(users, 3), false);
      assert.equal(await canLock(users, 4), false);
      assert.equal(await canLock(users, 2), true, 'the cursor row itself is not on the page');
      assert.equal(await canLock(users, 5), true);
    } finally {
      await held.release();
    }
  });

  it('a global filter limits the lock to rows in scope', async () => {
    const tenant = fx.client({ globalFilters: { [tableAccessorName(users)]: { tenant: 't1' } } });
    const held = await hold(tenant, (tx) => tx.table<Row>(users).findMany({ orderBy: { id: 'asc' }, lock: 'update' }));
    try {
      assert.deepEqual(ids(held.value), [1, 3]);
      assert.equal(await canLock(users, 1), false);
      assert.equal(await canLock(users, 2), true, "another tenant's row is untouched");
      assert.equal(await canLock(users, 4), true);
    } finally {
      await held.release();
    }
  });

  it('outside a transaction every entry point is E003 and nothing locks', async () => {
    const t = db.table(users);
    const calls: Promise<unknown>[] = [
      t.findMany({ lock: { mode: 'update', skipLocked: true } }),
      t.findFirst({ lock: 'update' }),
      t.findFirstOrThrow({ lock: 'update' }),
      t.findUnique({ where: { id: 1 }, lock: 'update' }),
      t.findUniqueOrThrow({ where: { id: 1 }, lock: 'update' }),
    ];
    for (const call of calls) {
      await assert.rejects(
        call,
        (err: unknown) => err instanceof ValidationError && /needs a transaction/.test(err.message),
      );
    }
  });
});
