import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient } from '@libsql/client/node';
import { LibsqlPool, turbineLibsql } from '../libsql.js';

const schema = { tables: {}, enums: {} };
const open = () => turbineLibsql(':memory:', schema, { logger: {} });

test('libSQL preserves every native transaction cleanup rejection when disconnecting', async () => {
  for (const cleanup of [undefined, null, false, 0, new Error('native close failure')]) {
    const native = createClient({ url: ':memory:', intMode: 'bigint' });
    const transaction = native.transaction.bind(native);
    let closes = 0;
    native.transaction = async (...args: Parameters<typeof native.transaction>) => {
      const tx = await transaction(...args);
      const close = tx.close.bind(tx);
      tx.close = () => {
        close();
        closes++;
        throw cleanup;
      };
      return tx;
    };
    try {
      await native.execute('CREATE TABLE retained(n INTEGER)');
      const db = await turbineLibsql({ client: native, url: ':memory:' }, schema, { logger: {} });
      const reason = Symbol('callback failure');
      await assert.rejects(
        db.$transaction(async (tx) => {
          await tx.rawUnsafe('INSERT INTO retained VALUES(1)');
          throw reason;
        }),
        (error) => error === reason,
      );
      await assert.rejects(db.disconnect(), (error) => Object.is(error, cleanup));
      await assert.rejects(db.disconnect(), (error) => Object.is(error, cleanup));
      assert.ok(closes > 0);
      assert.equal(native.closed, false);
      assert.equal((await native.execute('SELECT count(*) FROM retained')).rows[0]![0], 0n);
    } finally {
      native.close();
    }
  }
});

test('libSQL refuses unquoted BOM control before native prepare while quoted data remains intact', async () => {
  const db = await open();
  try {
    await db.rawUnsafe('CREATE TABLE t(n INTEGER)');
    for (const sql of ['\uFEFFCOMMIT', '/* prefix */ \uFEFFEND', '\uFEFF\uFEFFROLLBACK', 'COMMIT\uFEFF']) {
      await assert.rejects(
        db.$transaction(async (tx) => {
          await tx.rawUnsafe('INSERT INTO t VALUES(1)');
          await tx.rawUnsafe(sql);
          throw new Error('BOM transaction control escaped');
        }),
        /byte-order mark/,
      );
      await assert.rejects(
        db.transaction(async (tx) => {
          await tx.query('INSERT INTO t VALUES(2)');
          await tx.query(sql);
          throw new Error('BOM transaction control escaped');
        }),
        /byte-order mark/,
      );
      assert.deepEqual(await db.rawUnsafe('SELECT * FROM t'), []);
    }
    assert.deepEqual(await db.rawUnsafe(`SELECT '\uFEFFCOMMIT' AS "\uFEFFlabel", $1 AS value /* \uFEFF */`, '\uFEFF'), [
      { '\uFEFFlabel': '\uFEFFCOMMIT', value: '\uFEFF' },
    ]);
  } finally {
    await db.disconnect();
  }

  const native = createClient({ url: ':memory:', intMode: 'bigint' });
  const pool = new LibsqlPool(native, true);
  try {
    await pool.query('CREATE TABLE t(n INTEGER)');
    await assert.rejects(
      pool.batch([{ text: 'INSERT INTO t VALUES(3)' }, { text: '\uFEFFCOMMIT' }]),
      /byte-order mark/,
    );
    assert.deepEqual((await pool.query('SELECT * FROM t')).rows, []);
    await assert.rejects(pool.query('\uFEFFBEGIN'), /byte-order mark/);
  } finally {
    await pool.end();
  }
});

test('libSQL retains every ancestor callback owner across independent nested pools', { timeout: 5000 }, async () => {
  const a = await open(),
    b = await open();
  const pending: Promise<unknown>[] = [];
  let delayed: Promise<unknown> | undefined;
  let resume!: () => void;
  const after = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let failure: unknown;
  try {
    const check = async (operation: Promise<unknown>, pattern: RegExp) => {
      const outcome = operation.then(
        () => 'executed',
        (error: unknown) => String(error),
      );
      pending.push(outcome);
      let timer: ReturnType<typeof setTimeout>;
      try {
        const result = await Promise.race([
          outcome,
          new Promise<string>((resolve) => {
            timer = setTimeout(() => resolve('blocked behind ancestor'), 100);
          }),
        ]);
        assert.match(result, pattern);
      } finally {
        clearTimeout(timer!);
      }
    };
    try {
      await a.$transaction(async (txA) =>
        b.$transaction(async (txB) => {
          await check(a.rawUnsafe('SELECT 7'), /Root operations/);
          await check(
            a.$transaction(async () => 1),
            /Root operations/,
          );
          await check(a.disconnect(), /Cannot disconnect/);
          assert.deepEqual(await txA.rawUnsafe('SELECT 1 AS n'), [{ n: 1 }]);
          assert.deepEqual(await txB.rawUnsafe('SELECT 2 AS n'), [{ n: 2 }]);
          // Descendants that run after callback completion are no longer reentry.
          delayed = after.then(() => a.rawUnsafe('SELECT 3 AS n'));
        }),
      );
    } catch (error) {
      failure = error;
    }
    resume();
    await Promise.all(pending);
    if (failure) throw failure;
    assert.deepEqual(await delayed, [{ n: 3 }]);
    assert.deepEqual(await a.rawUnsafe('SELECT 4 AS n'), [{ n: 4 }]);
  } finally {
    resume();
    await Promise.allSettled(pending);
    await a.disconnect();
    await b.disconnect();
  }
});
