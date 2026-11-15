import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient } from '@libsql/client/node';
import * as api from '../libsql.js';

const reasons = () => [
  undefined,
  null,
  false,
  0,
  Symbol('cleanup'),
  Object.freeze(new Error('cleanup')),
  // biome-ignore lint/suspicious/noThenProperty: rejection must not assimilate its reason.
  Object.freeze({ then: () => assert.fail('cleanup reason was assimilated') }),
];

async function rejectsWith(work: Promise<unknown>, expected: unknown) {
  let rejected = false;
  try {
    await work;
  } catch (error) {
    rejected = true;
    assert(Object.is(error, expected), 'exact retained rejection');
  }
  assert(rejected, 'expected rejection');
}

test('first transaction cleanup survives a later factory-client close rejection', async () => {
  for (const first of reasons()) {
    for (const factory of reasons()) {
      const db = await api.turbineLibsql(':memory:', { tables: {}, enums: {} }, { logger: {} });
      const native = (db.pool as api.LibsqlPool).client;
      const nativeClose = native.close.bind(native);
      const transaction = native.transaction.bind(native);
      const primary = Symbol('native completion');
      const later = Object.freeze(new Error('later transaction close'));
      let transactionCloses = 0;
      let clientCloses = 0;
      let completions = 0;
      native.transaction = async (...args: Parameters<typeof native.transaction>) => {
        const tx = await transaction(...args);
        const rollback = tx.rollback.bind(tx);
        const close = tx.close.bind(tx);
        tx.commit = async () => {
          completions++;
          await rollback();
          throw primary;
        };
        tx.close = () => {
          close();
          throw ++transactionCloses === 1 ? first : later;
        };
        return tx;
      };
      native.close = () => {
        clientCloses++;
        nativeClose();
        throw factory;
      };
      try {
        await db.rawUnsafe('CREATE TABLE t(n INTEGER, payload TEXT)');
        await rejectsWith(
          db.$transaction(async (tx) => {
            await tx.rawUnsafe("INSERT INTO t VALUES(1, 'rolled back')");
          }),
          primary,
        );
        assert.deepEqual((await native.execute({ sql: 'SELECT * FROM t' })).rows, []);
        await rejectsWith(db.disconnect(), first);
        await rejectsWith(db.disconnect(), first);
        assert.equal(completions, 1);
        assert.equal(transactionCloses, 2);
        assert.equal(clientCloses, 1);
        assert.equal(native.closed, true);
      } finally {
        nativeClose();
      }
    }
  }
});

test('without earlier cleanup, factory close rejects exactly and supplied clients stay caller-owned', async () => {
  for (const reason of reasons()) {
    const db = await api.turbineLibsql(':memory:', { tables: {}, enums: {} }, { logger: {} });
    const native = (db.pool as api.LibsqlPool).client;
    const close = native.close.bind(native);
    let calls = 0;
    native.close = () => {
      calls++;
      close();
      throw reason;
    };
    try {
      await rejectsWith(db.disconnect(), reason);
      await rejectsWith(db.disconnect(), reason);
      assert.equal(calls, 1);
      assert.equal(native.closed, true);
    } finally {
      close();
    }

    const supplied = createClient({ url: ':memory:', intMode: 'bigint' });
    const suppliedClose = supplied.close.bind(supplied);
    let suppliedCloses = 0;
    supplied.close = () => {
      suppliedCloses++;
      throw reason;
    };
    try {
      const borrowed = new api.LibsqlPool(supplied);
      await borrowed.end();
      await borrowed.end();
      assert.equal(suppliedCloses, 0);
      assert.equal(supplied.closed, false);
      assert.equal((await supplied.execute('SELECT 42 AS n')).rows[0]?.n, 42n);
    } finally {
      suppliedClose();
    }
  }
});
