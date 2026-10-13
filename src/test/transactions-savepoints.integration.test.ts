/**
 * turbine-orm: multi-statement writes and nested blocks inside a caller's
 * transaction are all or nothing.
 *
 * A nested create or update, and an upsert that looks the row up first, issue
 * several statements. Inside `$transaction` they used to join the caller's
 * transaction statement by statement, so a failure part way through left the
 * statements before it in place and a caller that caught the error committed
 * half of the write. Each now runs in its own savepoint.
 *
 * Nested `tx.$transaction` blocks started side by side (`Promise.all`) used to
 * open savepoints that sat inside each other on the connection's one stack, so
 * a rollback in the first discarded the second even after it had reported
 * success. Blocks that share a parent now run one after another.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/transactions-savepoints.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe, beforeEach as eachTest } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { UniqueConstraintError } from '../errors.js';
import { skipGate } from './helpers.js';
import { DATABASE_URL, openFixture, sleep, type TxFixture } from './transactions-fixture.js';

const { it, before, after } = skipGate(!DATABASE_URL, 'DATABASE_URL not set');
const beforeEach: typeof eachTest = DATABASE_URL ? eachTest : () => {};

/** A real pool whose connections record every statement text they are sent. */
function recordingPool(log: string[]): pg.Pool {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  const connect = pool.connect.bind(pool) as () => Promise<pg.PoolClient>;
  (pool as unknown as { connect: () => Promise<pg.PoolClient> }).connect = async () => {
    const client = await connect();
    const marked = client as pg.PoolClient & { recorded?: true };
    if (!marked.recorded) {
      marked.recorded = true;
      const query = client.query.bind(client) as (...args: unknown[]) => unknown;
      (client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
        const first = args[0];
        log.push(typeof first === 'string' ? first : String((first as { text?: string }).text));
        return query(...args);
      };
    }
    return client;
  };
  return pool;
}

describe('transactions: savepoints for multi-statement writes and nested blocks (live Postgres)', () => {
  let fx: TxFixture;
  let db: TurbineClient;

  before(async () => {
    fx = await openFixture('tx90s');
    db = fx.client();
  });
  beforeEach(async () => {
    await fx.reset();
  });
  after(async () => {
    await fx?.close();
  });

  it('a nested create that fails part way leaves no half tree behind when the caller catches and commits', async () => {
    let failure: unknown;
    await db.$transaction(async (tx) => {
      try {
        await tx.table(fx.t.users).create({
          data: { email: 'half@x', posts: { create: [{ title: 'orphan-post' }], connect: [{ id: 999 }] } },
        });
      } catch (err) {
        failure = err;
      }
      await tx.table(fx.t.users).create({ data: { email: 'after@x' } });
    });
    assert.ok(failure instanceof Error, 'the nested create rejected');
    assert.equal(await fx.count(fx.t.users, "email = 'half@x'"), 0, 'the parent row was rolled back');
    assert.equal(await fx.count(fx.t.posts, "title = 'orphan-post'"), 0, 'the nested child was rolled back');
    assert.equal(await fx.count(fx.t.users, "email = 'after@x'"), 1, 'the rest of the transaction committed');
  });

  it('a nested update whose statement fails leaves the transaction usable', async () => {
    await db.$transaction(async (tx) => {
      await assert.rejects(
        tx.table(fx.t.users).update({
          where: { id: 3 },
          data: { tenant: 'changed', org: { create: { name: 'acme' } } },
        }),
        UniqueConstraintError,
      );
      await tx.table(fx.t.users).create({ data: { email: 'still-usable@x' } });
    });
    assert.equal(await fx.count(fx.t.users, "id = 3 AND tenant = 't1' AND org_id IS NULL"), 1, 'user 3 untouched');
    assert.equal(await fx.count(fx.t.users, "email = 'still-usable@x'"), 1);
  });

  it('a lookup-first upsert that fails part way is undone as a unit', async () => {
    await db.$transaction(async (tx) => {
      await assert.rejects(
        tx.table(fx.t.users).upsert({
          where: { email: 'up@x' },
          create: { email: 'up@x', posts: { connect: [{ id: 999 }] } },
          update: {},
        }),
      );
      await tx.table(fx.t.users).create({ data: { email: 'after-upsert@x' } });
    });
    assert.equal(await fx.count(fx.t.users, "email = 'up@x'"), 0, 'the inserted row went with the failed connect');
    assert.equal(await fx.count(fx.t.users, "email = 'after-upsert@x'"), 1);
  });

  it('side-by-side blocks: a failing block does not discard a sibling that succeeded', async () => {
    const outcomes = await db.$transaction(async (tx) =>
      Promise.allSettled([
        tx.$transaction(async (inner) => {
          await inner.table(fx.t.users).create({ data: { email: 'A@x' } });
          await sleep(60);
          throw new Error('A fails late');
        }),
        tx.$transaction(async (inner) => {
          await sleep(10);
          await inner.table(fx.t.users).create({ data: { email: 'B@x' } });
          return 'B done';
        }),
      ]),
    );
    assert.equal(outcomes[0].status, 'rejected');
    assert.deepEqual(outcomes[1], { status: 'fulfilled', value: 'B done' });
    assert.equal(await fx.count(fx.t.users, "email = 'A@x'"), 0, 'A was rolled back');
    assert.equal(await fx.count(fx.t.users, "email = 'B@x'"), 1, 'B reported success, so B is committed');
  });

  it('Promise.all over many blocks, with a block nested inside one of them, commits every block', async () => {
    const results = await db.$transaction(async (tx) =>
      Promise.all(
        [1, 2, 3, 4].map((i) =>
          tx.$transaction(async (inner) => {
            await inner.table(fx.t.users).create({ data: { email: `many${i}@x` } });
            if (i === 2) {
              // A block opened from inside a block is its child and must not wait for its siblings.
              await inner.$transaction(async (deeper) =>
                deeper.table(fx.t.users).create({ data: { email: 'deep@x' } }),
              );
            }
            return i;
          }),
        ),
      ),
    );
    assert.deepEqual(results, [1, 2, 3, 4]);
    assert.equal(await fx.count(fx.t.users, "email LIKE 'many%@x' OR email = 'deep@x'"), 5);
  });

  it('single-statement writes inside a transaction send no savepoint; nested writes do', async () => {
    const log: string[] = [];
    const pool = recordingPool(log);
    const client = new TurbineClient({ pool, warnOnUnlimited: false }, fx.schema);
    try {
      await client.$transaction(async (tx) => {
        await tx.table(fx.t.users).create({ data: { email: 'plain@x' } });
        await tx.table(fx.t.users).update({ where: { email: 'plain@x' }, data: { tenant: 't9' } });
      });
      assert.equal(log.filter((s) => /^SAVEPOINT/i.test(s)).length, 0, log.join('\n'));
      await client.$transaction(async (tx) => {
        await tx.table(fx.t.users).create({ data: { email: 'tree@x', posts: { create: [{ title: 'tp' }] } } });
      });
      assert.equal(log.filter((s) => /^SAVEPOINT/i.test(s)).length, 1, log.join('\n'));
      assert.equal(log.filter((s) => /^RELEASE SAVEPOINT/i.test(s)).length, 1, log.join('\n'));
    } finally {
      await client.disconnect();
      await pool.end();
    }
  });

  it('outside a transaction a nested write keeps its own BEGIN/COMMIT and takes no savepoint', async () => {
    const log: string[] = [];
    const pool = recordingPool(log);
    const client = new TurbineClient({ pool, warnOnUnlimited: false }, fx.schema);
    try {
      await client.table(fx.t.users).create({ data: { email: 'solo@x', posts: { create: [{ title: 'sp' }] } } });
      assert.equal(log.filter((s) => /^SAVEPOINT/i.test(s)).length, 0, log.join('\n'));
      assert.ok(log.some((s) => /^BEGIN/i.test(s)) && log.some((s) => /^COMMIT/i.test(s)), log.join('\n'));
    } finally {
      await client.disconnect();
      await pool.end();
    }
  });
});
