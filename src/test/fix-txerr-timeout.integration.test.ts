/**
 * turbine-orm: the `$transaction` `timeout` option, live Postgres.
 *
 * `0` means no timeout (the same word the per-query `timeout` uses), a
 * positive number is a deadline, and anything else is refused before BEGIN.
 *
 * Run: DATABASE_URL=... npx tsx --test src/test/fix-txerr-timeout.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import type { TurbineClient } from '../client.js';
import { TimeoutError, ValidationError } from '../errors.js';
import { skipGate } from './helpers.js';
import { DATABASE_URL, openFixture, sleep, type TxFixture } from './transactions-fixture.js';

const { it, before, after } = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

describe('$transaction timeout (live Postgres)', () => {
  let fx: TxFixture;
  let db: TurbineClient;

  before(async () => {
    fx = await openFixture('fxto');
    db = fx.client({ poolSize: 2 });
  });
  after(async () => {
    await fx?.close();
  });

  it('timeout: 0 sets no deadline, so a callback slower than any short timeout completes and commits', async () => {
    await fx.reset();
    const { counters } = fx.t;
    const started = Date.now();
    const result = await db.$transaction(
      async (tx) => {
        await tx.table(counters).update({ where: { id: 2 }, data: { n: { increment: 5 } } });
        await sleep(300);
        return 'done';
      },
      { timeout: 0 },
    );
    assert.equal(result, 'done');
    assert.ok(Date.now() - started >= 300, 'the callback ran to its end');
    assert.equal(await fx.count(counters, 'id = 2 AND n = 5'), 1, 'the write committed');
  });

  it('a positive timeout is still a deadline: the same callback is cut short and rolls back', async () => {
    await fx.reset();
    const { counters } = fx.t;
    await assert.rejects(
      db.$transaction(
        async (tx) => {
          await tx.table(counters).update({ where: { id: 2 }, data: { n: { increment: 5 } } });
          await sleep(300);
          return 'done';
        },
        { timeout: 80 },
      ),
      (err: unknown) => err instanceof TimeoutError,
    );
    assert.equal(await fx.count(counters, 'id = 2 AND n = 0'), 1, 'the write was rolled back');
  });

  it('a negative or non-numeric timeout is refused before the transaction opens', async () => {
    for (const bad of [-1, Number.NaN, '100']) {
      let ran = false;
      await assert.rejects(
        db.$transaction(
          async () => {
            ran = true;
          },
          { timeout: bad as never },
        ),
        (err: unknown) => err instanceof ValidationError && /timeout/.test(err.message),
        String(bad),
      );
      assert.equal(ran, false, `the callback ran with timeout ${String(bad)}`);
    }
  });
});
