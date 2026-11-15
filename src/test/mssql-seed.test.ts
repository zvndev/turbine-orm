import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import { MssqlPool } from '../mssql.js';
import { defineMssqlSeed, type MssqlSeedClient, type MssqlSeedTable, runMssqlSeed } from '../mssql-seed.js';
import type { SchemaMetadata } from '../schema.js';
import { mockColumn, mockTable } from './helpers.js';

const driver = createRequire(import.meta.url)('./fixtures/mssql-seed-driver.cjs');
const schema: SchemaMetadata = {
  tables: { users: mockTable('users', [mockColumn('id', 'id', 'int4'), mockColumn('email', 'email', 'text')]) },
  enums: {},
};
function fixture() {
  const native = new driver.ConnectionPool({});
  const pool = new MssqlPool(native, driver);
  return { native, pool, events: driver.events as { event: string; tx?: number; sql?: string }[] };
}
const options = { schema: 'app', logger: {} };

it('declares without running, rejects nonfunctions and validates metadata before checkout', async () => {
  let called = false;
  const fn = defineMssqlSeed(() => {
    called = true;
  });
  assert.equal(typeof fn, 'function');
  assert.equal(called, false);
  assert.throws(() => defineMssqlSeed(null as never), /callable/);
  const f = fixture();
  await assert.rejects(runMssqlSeed(f.pool, schema, fn, { schema: '' }), /schema/);
  assert.equal(f.events.filter((e) => e.event === 'begin').length, 0);
});

it('uses the actual native Transaction pin, commits rows, seals all handles and preserves borrowed ownership', async () => {
  const f = fixture();
  const start = f.events.length;
  let escaped!: MssqlSeedTable<{ id: number; email: string }>;
  await runMssqlSeed(
    f.pool,
    schema,
    async (tx) => {
      assert.deepEqual(Object.keys(tx).sort(), ['$transaction', 'table']);
      assert.ok(Object.isFrozen(tx));
      escaped = tx.table('users');
      assert.ok(Object.isFrozen(escaped));
      for (const key of [
        'pool',
        'client',
        'schema',
        'raw',
        'buildCreate',
        'findManyStream',
        '$connection',
        'constructor',
      ]) {
        assert.equal(Object.hasOwn(escaped, key), false);
      }
      assert.equal((escaped as unknown as { pool?: unknown }).pool, undefined);
      const row = await escaped.create({ data: { id: 1, email: 'first' } });
      assert.equal(row.email, 'first');
      assert.equal((await escaped.findMany())[0]?.email, 'first');
    },
    options,
  );
  assert.deepEqual(f.native.rows, [{ id: 1, email: 'first' }]);
  const observed = f.events.slice(start);
  const pin = observed.find((e) => e.event === 'begin')!.tx;
  const requests = observed.filter((e) => e.event === 'request' && !e.sql?.includes('ProductMajorVersion'));
  assert.ok(requests.length >= 3);
  assert.ok(requests.every((e) => e.tx === pin));
  assert.equal(observed.filter((e) => e.event === 'commit').length, 1);
  assert.equal(f.native.closed, false);
  const before = f.events.length;
  await assert.rejects(escaped.findMany(), /ended|committed|closed/);
  assert.equal(f.events.length, before, 'escaped table must not reach native Request');
});

it('rolls back callback failure and keeps a borrowed pool reusable', async () => {
  const f = fixture();
  await assert.rejects(
    runMssqlSeed(
      f.pool,
      schema,
      async (tx) => {
        await tx.table('users').create({ data: { id: 1, email: 'discard' } });
        throw new Error('callback failure');
      },
      options,
    ),
    /callback failure/,
  );
  assert.deepEqual(f.native.rows, []);
  assert.equal(f.native.closed, false);
  await runMssqlSeed(
    f.pool,
    schema,
    async (tx) => {
      await tx.table('users').create({ data: { id: 2, email: 'saved' } });
    },
    options,
  );
  assert.equal(f.native.rows[0].email, 'saved');
});

it('nested callbacks receive only sealed handles; rolled back rows and escaped scopes stay closed', async () => {
  const f = fixture();
  let nested!: MssqlSeedClient;
  await runMssqlSeed(
    f.pool,
    schema,
    async (tx) => {
      await assert.rejects(
        tx.$transaction(async (inner) => {
          nested = inner;
          assert.deepEqual(Object.keys(inner).sort(), ['$transaction', 'table']);
          await inner.table('users').create({ data: { id: 1, email: 'discard' } });
          await assert.rejects(tx.table('users').findMany(), /outer|scope|block/);
          throw new Error('undo savepoint');
        }),
        /undo savepoint/,
      );
      await assert.rejects(async () => nested.table('users').findMany(), /ended|block|closed|rolled back/);
      await tx.table('users').create({ data: { id: 2, email: 'kept' } });
    },
    options,
  );
  assert.deepEqual(f.native.rows, [{ id: 2, email: 'kept' }]);
});

it('refuses mismatched native schema resolution before invoking the callback', async () => {
  const f = fixture();
  let called = false;
  await assert.rejects(
    runMssqlSeed(
      f.pool,
      schema,
      () => {
        called = true;
      },
      { ...options, schema: 'other' },
    ),
    /resolution/,
  );
  assert.equal(called, false);
  assert.deepEqual(f.native.rows, []);
  assert.equal(f.native.closed, false);
});

it('unawaited eager work prevents commit and is drained before rollback', async (t) => {
  const makePin = createRequire(import.meta.url)('./fixtures/mssql-seed-pin.cjs');
  const f = makePin();
  const pool = new MssqlPool(f.native, f.driver);
  t.after(async () => {
    if (f.pinned) await f.pinned.rollback();
    await f.native.close();
  });
  let finish!: () => void;
  f.native.pause = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let pending!: Promise<unknown>;
  const running = runMssqlSeed(
    pool,
    schema,
    async (tx) => {
      pending = tx.table('users').create({ data: { id: 1, email: 'unawaited' } });
      void pending.catch(() => {});
      setImmediate(finish);
    },
    options,
  );
  await assert.rejects(running, /await|running|rolled back/);
  await pending.catch(() => {});
  assert.deepEqual(f.native.rows, []);
  assert.equal(f.pinned, undefined, 'unfinished seed work must return its native pin');
  assert.ok(f.events.includes('wire.rollback'));
  assert.ok(f.events.includes('pool.release'));
});

it('callback failure drains unfinished real-driver requests before rejecting', async (t) => {
  const f = createRequire(import.meta.url)('./fixtures/mssql-seed-pin.cjs')();
  t.after(async () => {
    if (f.pinned) await f.pinned.rollback();
    await f.native.close();
  });
  let finish!: () => void;
  f.native.pause = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const failure = new Error('original callback failure');
  const running = runMssqlSeed(
    new MssqlPool(f.native, f.driver),
    schema,
    async (tx) => {
      void tx
        .table('users')
        .create({ data: { id: 2, email: 'unfinished on throw' } })
        .catch(() => {});
      setImmediate(finish);
      throw failure;
    },
    options,
  );
  await assert.rejects(running, (error) => error === failure);
  assert.equal(f.pinned, undefined);
  assert.ok(f.events.includes('wire.rollback'));
  assert.ok(f.events.includes('pool.release'));
  assert.deepEqual(f.native.rows, []);
});

it('unfinished nested seed callbacks settle before the outer rollback', async () => {
  const f = fixture();
  let nestedFinished = false;
  await assert.rejects(
    runMssqlSeed(
      f.pool,
      schema,
      (tx) => {
        void tx
          .$transaction(async (inner) => {
            await new Promise<void>((resolve) => setImmediate(resolve));
            await inner.table('users').create({ data: { id: 3, email: 'nested unfinished' } });
            nestedFinished = true;
          })
          .catch(() => {});
      },
      options,
    ),
    /unfinished work was rolled back/,
  );
  assert.equal(nestedFinished, true);
  assert.deepEqual(f.native.rows, []);
});

it('discarded native checkouts drain ordinary requests before returning the real driver pin', async (t) => {
  const f = createRequire(import.meta.url)('./fixtures/mssql-seed-pin.cjs')();
  t.after(async () => {
    if (f.pinned) await f.pinned.rollback();
    await f.native.close();
  });
  const client = await new MssqlPool(f.native, f.driver).connect();
  await client.query('BEGIN TRANSACTION');
  let finish!: () => void;
  f.native.pause = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const pending = client.query('SELECT * FROM [users]');
  const rolledBack = once(f.pinned, 'rollback', { signal: AbortSignal.timeout(1000) });
  client.release(new Error('discard checkout with unfinished request'));
  assert.ok(f.pinned);
  finish();
  await pending;
  // release() is synchronous; observe completion through the real driver.
  await rolledBack;
  assert.equal(f.pinned, undefined);
  assert.ok(f.events.includes('wire.rollback'));
  assert.ok(f.events.includes('pool.release'));
  assert.deepEqual(f.native.rows, []);
});

it('real mssql.Transaction acquires one native pin, routes requests through it and releases on both outcomes', async () => {
  const makePin = createRequire(import.meta.url)('./fixtures/mssql-seed-pin.cjs');
  const f = makePin();
  const borrowed = new MssqlPool(f.native, f.driver);
  await runMssqlSeed(
    borrowed,
    schema,
    async (tx) => {
      await tx.table('users').create({ data: { id: 1, email: 'real driver pin' } });
      assert.equal((await tx.table('users').findMany()).length, 1);
      assert.ok(f.pinned, 'the actual driver must retain its native connection until commit');
    },
    options,
  );
  assert.equal(f.pinned, undefined);
  assert.deepEqual(f.events, [
    'pool.acquire',
    'wire.begin',
    'request.pinned',
    'request.pinned',
    'request.pinned',
    'wire.commit',
    'pool.release',
  ]);
  f.events.length = 0;
  await assert.rejects(
    runMssqlSeed(
      borrowed,
      schema,
      async (tx) => {
        await tx.table('users').create({ data: { id: 2, email: 'real driver rollback' } });
        throw new Error('undo native pin');
      },
      options,
    ),
    /undo native pin/,
  );
  assert.equal(f.pinned, undefined);
  assert.deepEqual(f.events, [
    'pool.acquire',
    'wire.begin',
    'request.pinned',
    'request.pinned',
    'wire.rollback',
    'pool.release',
  ]);
  assert.deepEqual(f.native.rows, [{ id: 1, email: 'real driver pin' }]);
  assert.equal(f.native.closed, false);
});
