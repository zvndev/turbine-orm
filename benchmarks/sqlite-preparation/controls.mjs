import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePool, turbineSqlite } from '../../src/sqlite.ts';
import { ARMS, CAPACITY, expectedRow, Preparation, READ, route, schema } from './workload.mjs';

export async function controls() {
  const results = [];
  for (const arm of ARMS) {
    const r = route(arm);
    try {
      for (const id of [1, 32, 2, 1]) {
        const result = await r.query(READ, [BigInt(id)]);
        assert.deepStrictEqual(result.rows, [expectedRow(id, r.pooled)]);
      }
      // Null, BLOB, string and unsafe integer bindings must replace previous values.
      for (const value of [1n, null, 'text', Uint8Array.of(0, 255), 9007199254740993n, 2n]) {
        const result = await r.query('SELECT :p1 AS value', [value]);
        const expected =
          r.pooled && typeof value === 'bigint'
            ? Number.isSafeInteger(Number(value))
              ? Number(value)
              : String(value)
            : value;
        assert.deepStrictEqual(result.rows, [{ value: expected }]);
      }
      await assert.rejects(r.query('SELECT no_such_column FROM items'));
      await assert.rejects(r.query('INSERT INTO counters VALUES(:p1, :p2)', [1n, 99n], false));
      await r.query('INSERT INTO counters VALUES(:p1, :p2)', [2n, 7n], false);
      assert.equal(Number(r.db.prepare('SELECT n FROM counters WHERE id=2').get().n), 7);
      for (let i = 0; i < CAPACITY * 4; i++) {
        assert.deepStrictEqual((await r.query(`SELECT :p1 AS n /* bounded ${i} */`, [BigInt(i)])).rows, [
          { n: r.pooled ? i : BigInt(i) },
        ]);
      }
      assert.ok(r.preparation.entries.size <= CAPACITY);
      assert.ok(r.preparation.peak <= CAPACITY);
      if (arm.endsWith('reuse')) assert.ok(r.preparation.evictions > 0);
      results.push({ control: 'binding-errors-bounds', arm, passed: true, ...r.preparation.stats() });
    } finally {
      await r.close();
    }
  }

  // Native SQLite auto-reprepares on schema changes. Both reuse and fresh
  // observe added columns; no JavaScript column metadata is cached here.
  for (const reuse of [false, true]) {
    const db = new DatabaseSync(':memory:');
    const p = new Preparation(db, reuse);
    try {
      db.exec('CREATE TABLE t(id INTEGER); INSERT INTO t VALUES(1)');
      const run = () => ({ ...p.prepare('SELECT * FROM t').get() });
      assert.deepStrictEqual(run(), { id: 1 });
      db.exec("ALTER TABLE t ADD COLUMN added TEXT DEFAULT 'added'");
      assert.deepStrictEqual(run(), { id: 1, added: 'added' });
      db.exec('DROP TABLE t');
      assert.throws(run);
      p.invalidate();
      db.exec("CREATE TABLE t(id TEXT); INSERT INTO t VALUES('changed')");
      assert.deepStrictEqual(run(), { id: 'changed' });
      results.push({ control: 'native-schema-auto-reprepare-and-explicit-invalidation', reuse, passed: true });
    } finally {
      p.invalidate();
      db.close();
    }
  }

  // Both pool routes must describe the current execution after external DDL.
  // Native statement invalidation alone does not establish decoder correctness.
  for (const arm of ['pool-fresh', 'pool-reuse']) {
    const r = route(arm);
    try {
      r.db.exec('CREATE TABLE changing(v BOOLEAN); INSERT INTO changing VALUES(1)');
      assert.deepStrictEqual((await r.query('SELECT v FROM changing')).rows, [{ v: true }]);
      r.db.exec('DROP TABLE changing; CREATE TABLE changing(v INTEGER); INSERT INTO changing VALUES(1)');
      r.preparation.invalidate();
      const current = (await r.query('SELECT v FROM changing')).rows;
      assert.deepStrictEqual(current, [{ v: 1 }]);
      const fresh = new SqlitePool(r.db);
      assert.deepStrictEqual((await fresh.query('SELECT v FROM changing')).rows, [{ v: 1 }]);
      results.push({
        control: 'external-schema-decoder-invalidation',
        arm,
        status: 'passed-current-decode',
        passed: true,
        observed: current,
        freshPool: [{ v: 1 }],
      });
    } finally {
      await r.close();
    }
  }

  for (const arm of ['pool-fresh', 'pool-reuse']) {
    const r = route(arm);
    let client;
    let iterator;
    try {
      client = await r.pool.connect();
      iterator = client.streamBatches(READ, [1n], 1);
      assert.deepStrictEqual((await iterator.next()).value, [expectedRow(1, true)]);
      const retained = r.preparation.entries.size;
      await assert.rejects(client.query('SELECT 7 AS n'), /active SQLite stream/);
      let settled = false;
      const waiting = r.query('SELECT :p1 AS n', [7n]).then((value) => {
        settled = true;
        return value;
      });
      await Promise.resolve();
      assert.equal(settled, false, 'ordinary query waits for active iterator');
      assert.equal(r.preparation.entries.size, retained, 'stream statement was not cached');
      await iterator.return();
      assert.deepStrictEqual((await waiting).rows, [{ n: 7 }]);
      assert.equal(settled, true);
      results.push({ control: 'active-stream-ownership-fresh-iterator', arm, passed: true });
    } finally {
      await iterator?.return();
      client?.release();
      await r.close();
    }
  }

  // Factory ownership, not merely pool.close(), is observable.
  const borrowed = new DatabaseSync(':memory:');
  try {
    const client = turbineSqlite(borrowed, schema, { logger: {}, warnOnUnlimited: false });
    assert.deepStrictEqual(await client.rawUnsafe('SELECT $1 AS n', 2), [{ n: 2 }]);
    await client.disconnect();
    assert.equal(borrowed.prepare('SELECT 9 AS n').get().n, 9);
    results.push({ control: 'borrowed-handle-survives-disconnect', passed: true });
  } finally {
    borrowed.close();
  }
  const owned = turbineSqlite(':memory:', schema, { logger: {}, warnOnUnlimited: false });
  try {
    assert.deepStrictEqual(await owned.rawUnsafe('SELECT $1 AS n', 2), [{ n: 2 }]);
  } finally {
    await owned.disconnect();
  }
  await assert.rejects(owned.rawUnsafe('SELECT 1'));
  results.push({ control: 'owned-handle-refuses-after-disconnect', passed: true });
  return results;
}
