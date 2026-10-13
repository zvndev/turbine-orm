/**
 * turbine-orm: a per-query `timeout: 0` means no timeout, live Postgres.
 *
 * The same word `$transaction` uses. A query that has to wait on a lock holds
 * until the lock is released; a positive timeout still cancels it on the server.
 *
 * Run: DATABASE_URL=... npx tsx --test src/test/fix-txerr-timeout-zero.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import type { TurbineClient } from '../client.js';
import { TimeoutError, ValidationError } from '../errors.js';
import { skipGate } from './helpers.js';
import { DATABASE_URL, openFixture, sleep, type TxFixture } from './transactions-fixture.js';

const { it, before, after } = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

describe('per-query timeout: 0 (live Postgres)', () => {
  let fx: TxFixture;
  let db: TurbineClient;

  before(async () => {
    fx = await openFixture('fxtz');
    db = fx.client({ poolSize: 3 });
  });
  after(async () => {
    await fx?.close();
  });

  /** Hold `statement`'s lock on the fixture's counters table until the returned function is called. */
  async function holdLock(statement: string): Promise<() => Promise<void>> {
    await fx.raw.query('BEGIN');
    await fx.raw.query(statement);
    return async () => {
      await fx.raw.query('COMMIT');
    };
  }

  it('a write waiting on a row lock outlasts timeout: 0 and commits once the lock is released', async () => {
    await fx.reset();
    const { counters } = fx.t;
    const release = await holdLock(`SELECT * FROM ${counters} WHERE id = 2 FOR UPDATE`);
    const started = Date.now();
    const pending = db.table(counters).update({ where: { id: 2 }, data: { n: { increment: 7 } }, timeout: 0 });
    pending.catch(() => {});
    await sleep(300);
    await release();
    await pending;
    assert.ok(Date.now() - started >= 250, 'the update waited for the lock instead of timing out');
    assert.equal(await fx.count(counters, 'id = 2 AND n = 7'), 1);
  });

  it('a read waiting on a table lock outlasts timeout: 0', async () => {
    await fx.reset();
    const { counters } = fx.t;
    const release = await holdLock(`LOCK TABLE ${counters} IN ACCESS EXCLUSIVE MODE`);
    const started = Date.now();
    const pending = db.table(counters).findMany({ orderBy: { id: 'asc' }, timeout: 0 });
    pending.catch(() => {});
    await sleep(300);
    await release();
    const rows = (await pending) as { id: number }[];
    assert.ok(Date.now() - started >= 250, 'the read waited for the lock instead of timing out');
    assert.deepEqual(
      rows.map((r) => r.id),
      [1, 2],
    );
  });

  it('a positive timeout on the same wait still cancels the statement', async () => {
    await fx.reset();
    const { counters } = fx.t;
    const release = await holdLock(`SELECT * FROM ${counters} WHERE id = 2 FOR UPDATE`);
    try {
      await assert.rejects(
        db.table(counters).update({ where: { id: 2 }, data: { n: { increment: 7 } }, timeout: 80 }),
        (err: unknown) => err instanceof TimeoutError,
      );
    } finally {
      await release();
    }
    assert.equal(await fx.count(counters, 'id = 2 AND n = 0'), 1, 'the timed-out write made no change');
  });

  it('a negative timeout is refused and names the 0 option', async () => {
    await assert.rejects(
      db.table(fx.t.counters).findMany({ timeout: -1 }),
      (err: unknown) =>
        err instanceof ValidationError && err.code === 'TURBINE_E003' && /or 0 for no timeout/.test(err.message),
    );
  });
});
