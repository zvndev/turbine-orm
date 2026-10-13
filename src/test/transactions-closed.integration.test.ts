/**
 * turbine-orm: a `tx` used after its transaction settled is refused.
 *
 * A TransactionClient runs on one pooled connection. Once its transaction
 * commits, rolls back or times out, that connection is back in the pool, and
 * with a pool that reuses the most recently released connection first the
 * next transaction to start usually gets exactly it. A `tx` kept past the end
 * of its callback (a missing `await`, an `async` `forEach`, a timer) used to
 * keep sending statements on it: inside another request's transaction, under
 * that request's row-level-security settings, committing or rolling back with
 * it. Every entry point on a settled `tx` now throws E003 without sending
 * anything.
 *
 * `poolSize: 1` makes the reuse certain rather than likely.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/transactions-closed.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe, beforeEach as eachTest } from 'node:test';
import type { TransactionClient, TurbineClient } from '../client.js';
import { TimeoutError, ValidationError } from '../errors.js';
import { skipGate } from './helpers.js';
import { DATABASE_URL, openFixture, sleep, type TxFixture } from './transactions-fixture.js';

const { it, before, after } = skipGate(!DATABASE_URL, 'DATABASE_URL not set');
const beforeEach: typeof eachTest = DATABASE_URL ? eachTest : () => {};

function closedWith(how: RegExp) {
  return (err: unknown): boolean => {
    assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
    assert.equal(err.code, 'TURBINE_E003');
    assert.match(err.message, how, err.message);
    assert.match(err.message, /refused/);
    return true;
  };
}

describe('transactions: a settled tx refuses every call (live Postgres)', () => {
  let fx: TxFixture;
  let db: TurbineClient;

  before(async () => {
    fx = await openFixture('tx90k');
    db = fx.client({ poolSize: 1 });
  });
  beforeEach(async () => {
    await fx.reset();
  });
  after(async () => {
    await fx?.close();
  });

  it('a captured tx cannot read another request’s session settings or write into its transaction', async () => {
    let leakedA: TransactionClient | undefined;
    await db.$withSession({ 'app.tenant': 'tenant-A' }, async (tx) => {
      leakedA = tx;
    });
    const requestB = db.$withSession({ 'app.tenant': 'tenant-B' }, async (tx) => {
      await tx.table(fx.t.users).create({ data: { email: 'B-row@x' } });
      await sleep(150);
    });
    await sleep(40);
    // Request B now holds the only connection, the one A's tx was bound to.
    await assert.rejects(
      leakedA!.raw`SELECT current_setting('app.tenant', true) AS tenant`,
      closedWith(/This transaction committed/),
    );
    await assert.rejects(
      leakedA!.table(fx.t.users).create({ data: { email: 'A-late@x' } }),
      closedWith(/This transaction committed/),
    );
    await requestB;
    assert.equal(await fx.count(fx.t.users, "email = 'A-late@x'"), 0, 'the late write never ran');
    assert.equal(await fx.count(fx.t.users, "email = 'B-row@x'"), 1, 'request B is untouched');
  });

  it('the async forEach shape: work scheduled past the callback is refused, not run in the next transaction', async () => {
    const outcomes: unknown[] = [];
    await db.$withSession({ 'app.tenant': 'tenant-A' }, async (tx) => {
      [1, 2].forEach(async (i) => {
        try {
          await sleep(60);
          await tx.raw`SELECT current_setting('app.tenant', true) AS tenant`;
          outcomes.push(`ran ${i}`);
        } catch (err) {
          outcomes.push(err);
        }
      });
    });
    await db.$withSession({ 'app.tenant': 'tenant-B' }, async () => {
      await sleep(150);
    });
    assert.equal(outcomes.length, 2);
    for (const outcome of outcomes) closedWith(/This transaction committed/)(outcome);
  });

  it('after the callback throws, the tx says the transaction was rolled back', async () => {
    let leaked: TransactionClient | undefined;
    await assert.rejects(
      db.$transaction(async (tx) => {
        leaked = tx;
        throw new Error('boom');
      }),
      /boom/,
    );
    await assert.rejects(leaked!.table(fx.t.users).count(), closedWith(/This transaction was rolled back/));
  });

  it('after a timeout, the still-running callback is refused at its next statement', async () => {
    let late: unknown;
    let done!: () => void;
    const finished = new Promise<void>((resolve) => {
      done = resolve;
    });
    await assert.rejects(
      db.$transaction(
        async (tx) => {
          await sleep(120);
          try {
            await tx.table(fx.t.users).create({ data: { email: 'after-timeout@x' } });
          } catch (err) {
            late = err;
          }
          done();
        },
        { timeout: 40 },
      ),
      TimeoutError,
    );
    await finished;
    closedWith(/This transaction timed out/)(late);
    assert.equal(await fx.count(fx.t.users, "email = 'after-timeout@x'"), 0);
  });

  it('every entry point on a settled tx is refused: accessors, raw, rawQuery, nested $transaction, streams', async () => {
    let tx!: TransactionClient;
    let stream!: AsyncGenerator<unknown>;
    await db.$transaction(async (t) => {
      tx = t;
      stream = t.table(fx.t.users).findManyStream();
    });
    const refused = closedWith(/This transaction committed/);
    await assert.rejects(tx.table(fx.t.users).findMany(), refused);
    await assert.rejects(tx.table(fx.t.users).update({ where: { id: 1 }, data: { tenant: 'x' } }), refused);
    await assert.rejects(tx.table(fx.t.users).delete({ where: { id: 3 } }), refused);
    await assert.rejects(tx.raw`SELECT 1`, refused);
    await assert.rejects(tx.rawQuery('SELECT 1'), refused);
    await assert.rejects(
      tx.$transaction(async () => 'never'),
      refused,
    );
    await assert.rejects(stream.next(), refused);
    // Building a statement sends nothing, so it stays available.
    assert.match(tx.table(fx.t.users).buildCount().sql, /SELECT/);
    assert.equal(await fx.count(fx.t.users, 'id = 3'), 1, 'the refused delete never ran');
  });

  it('a statement still running when the callback returns rolls the transaction back', async () => {
    let unawaited: Promise<unknown> | undefined;
    await assert.rejects(
      db.$transaction(async (tx) => {
        // Not awaited: still running when the callback returns, so committing
        // would save whatever part of the caller's work happened to have run.
        unawaited = tx.rawQuery(`INSERT INTO ${fx.t.users} (email) VALUES ('queued@x')`);
        // The rollback cancels it on the server, so it may reject before the
        // assertion below gets to it.
        unawaited.catch(() => {});
      }),
      (err: unknown) => err instanceof ValidationError && /callback returned while a query/.test(err.message),
    );
    await unawaited?.catch(() => {});
    assert.equal(await fx.count(fx.t.users, "email = 'queued@x'"), 0, 'the unawaited insert was committed');
  });
});
