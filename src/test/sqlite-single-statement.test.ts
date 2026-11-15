import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { SqlitePool, turbineSqlite } from '../sqlite.js';
import { skipGate } from './helpers.js';

const native = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  } catch {
    return undefined;
  }
})();
const { it } = skipGate(!native, 'requires node:sqlite (Node >= 22.5)');
const streamAvailable = (() => {
  if (!native) return false;
  const probe = new native.DatabaseSync(':memory:');
  try {
    return typeof probe.isTransaction === 'boolean';
  } finally {
    probe.close();
  }
})();
const { it: streamIt } = skipGate(
  !streamAvailable,
  'requires native node:sqlite stream state (Node 22.x >= 22.16, or Node >= 24)',
);

it('refuses every unconsumed statement before prefix writes on cold, repeated and public raw routes', async () => {
  const db = new native!.DatabaseSync(':memory:');
  db.exec('CREATE TABLE t(n INTEGER); INSERT INTO t VALUES(0)');
  const pool = new SqlitePool(db);
  const client = turbineSqlite(db, { tables: {}, enums: {} }, { logger: {} });
  try {
    for (const suffix of [
      ' UPDATE t SET n=n+100',
      ' /* tail */ UPDATE t SET n=n+100',
      " SELECT ';'",
      '\u0000UPDATE t SET n=100',
    ]) {
      const sql = `UPDATE t SET n=n+$1;${suffix}`;
      for (let i = 0; i < 2; i++) await assert.rejects(pool.query(sql, [1]), /accepts one statement/);
      await assert.rejects(client.rawUnsafe(sql, 1), /accepts one statement/);
      assert.equal(db.prepare('SELECT n FROM t').get()!.n, 0);
    }
    await assert.rejects(pool.query('UPDATE t SET n=1; UPDATE t SET n=2'), /accepts one statement/);
    assert.equal(db.prepare('SELECT n FROM t').get()!.n, 0);
    assert.deepEqual((await pool.query('SELECT n FROM t')).rows, [{ n: 0 }]);
  } finally {
    await client.disconnect();
    await pool.end();
  }
});

it('uses native statement boundaries for trigger bodies, quotes and trailing comments', async () => {
  const db = new native!.DatabaseSync(':memory:');
  const pool = new SqlitePool(db);
  try {
    await pool.query('CREATE TABLE t(n INTEGER)');
    await pool.query('CREATE TABLE audit(n INTEGER)');
    await pool.query(
      'CREATE TRIGGER tr AFTER INSERT ON t BEGIN INSERT INTO audit VALUES(new.n); INSERT INTO audit VALUES(new.n+1); END; -- done\n;; /* trailing */',
    );
    await pool.query(' ; /* lead */ INSERT INTO t VALUES(7); /* trailing unclosed');
    assert.deepEqual((await pool.query('SELECT n FROM audit ORDER BY n; -- tail')).rows, [{ n: 7 }, { n: 8 }]);
    for (const sql of [
      "SELECT 'one;two' AS value",
      'SELECT 1 AS "semi;colon"',
      'SELECT 1 AS [semi;colon]',
      'SELECT 1 AS `semi;colon`',
    ])
      assert.equal((await pool.query(sql)).rowCount, 1);
  } finally {
    await pool.end();
  }
});

streamIt('refuses a second statement before stepping the native stream and releases ownership', async () => {
  const db = new native!.DatabaseSync(':memory:');
  const pool = new SqlitePool(db);
  let steps = 0;
  db.function('observed', () => ++steps);
  const connection = await pool.connect();
  try {
    const iterator = connection.streamBatches!('SELECT observed() AS value; SELECT 2', [], 10);
    await assert.rejects(iterator.next(), /accepts one statement/);
    assert.equal(steps, 0);
    assert.deepEqual((await connection.query('SELECT 1 AS value')).rows, [{ value: 1 }]);
  } finally {
    connection.release();
    await pool.end();
  }
});

it('refuses trailing SQL before a PRAGMA can change state during native prepare', async () => {
  const db = new native!.DatabaseSync(':memory:');
  const pool = new SqlitePool(db);
  const cache = () => db.prepare('PRAGMA cache_size').get()!.cache_size;
  const before = cache();
  try {
    for (const text of [
      'PRAGMA cache_size=123; SELECT 1',
      'EXPLAIN PRAGMA cache_size=123; SELECT 1',
      'EXPLAIN QUERY PLAN PRAGMA cache_size=123; SELECT 1',
      ' /* lead */ ; PRAGMA "cache_size"=123; "quoted"',
      'PRAGMA cache_size=123\u0000SELECT 1',
      'PRAGMA cache_size=123; -- end\nSELECT 1',
    ]) {
      await assert.rejects(pool.query(text), /accepts one statement/);
      assert.equal(cache(), before);
    }
    await pool.query("PRAGMA cache_size='123'; /* trailing */ ; -- done");
    assert.equal(cache(), 123);
  } finally {
    await pool.end();
  }
});
