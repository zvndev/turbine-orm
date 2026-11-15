/** SQL-only memoization must preserve binding validation and fresh native decoding. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { SqlitePool } from '../sqlite.js';
import { skipGate } from './helpers.js';

const native = (() => {
  try {
    return createRequire(process.cwd())('node:sqlite') as typeof import('node:sqlite');
  } catch {
    return undefined;
  }
})();
const { it } = skipGate(!native, 'requires node:sqlite (Node >= 22.5)');
const descriptions = typeof native?.StatementSync.prototype.columns === 'function';

async function fixture(run: (db: DatabaseSync, pool: SqlitePool) => Promise<void>) {
  const db = new native!.DatabaseSync(':memory:');
  const pool = new SqlitePool(db);
  try {
    await run(db, pool);
  } finally {
    await pool.end();
  }
}

function plans(pool: SqlitePool) {
  // Observe actual retained references without adding a production diagnostics API.
  return (
    pool as unknown as {
      queryPlans: {
        entries: Map<string, { valueCount: number; sql: string; returnsRows: boolean; bytes: number }>;
        bytes: number;
      };
    }
  ).queryPlans;
}

it('parameter count participates in SQL rewrite identity, including zero and failed bounds', async () => {
  await fixture(async (_db, pool) => {
    const sql = 'SELECT $2 AS value, $1 AS first';
    assert.deepEqual((await pool.query(sql, [1, 2])).rows, [{ value: 2, first: 1 }]);
    await assert.rejects(pool.query(sql, [1]), /\$2 names no value/);
    assert.deepEqual((await pool.query(sql)).rows, [{ value: null, first: null }]);
    assert.deepEqual((await pool.query(sql, [3, 4])).rows, [{ value: 4, first: 3 }]);
    await assert.rejects(pool.query(sql, [1]), /\$2 names no value/);
    const question = 'SELECT ? AS value';
    assert.deepEqual((await pool.query(question)).rows, [{ value: null }]);
    await assert.rejects(pool.query(question, [1]), /\?` placeholder cannot be bound/);
  });
});

it('warm SQL plans never retain bindings, rows or native statements', async () => {
  await fixture(async (db, pool) => {
    let prepares = 0;
    let metadata = 0;
    const prepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      prepares++;
      const stmt = prepare(sql);
      if (typeof stmt.columns === 'function') {
        const columns = stmt.columns.bind(stmt);
        stmt.columns = () => {
          metadata++;
          return columns();
        };
      }
      return stmt;
    };
    const sql = 'SELECT $1 AS value';
    for (const value of [1, null, 'changed', Uint8Array.of(3, 255), 9007199254740993n, false]) {
      const expected = typeof value === 'bigint' ? String(value) : value === false ? 0 : value;
      assert.deepEqual((await pool.query(sql, [value])).rows, [{ value: expected }]);
    }
    assert.equal(prepares, 6, 'every execution prepares a fresh native handle');
    assert.equal(metadata, descriptions ? 6 : 0, 'every nonempty result describes after execution');
    const retained = plans(pool);
    assert.equal(retained.entries.size, 1);
    assert.deepEqual(Object.keys(retained.entries.get(sql)!).sort(), ['bytes', 'returnsRows', 'sql', 'valueCount']);
    assert.equal(retained.entries.get(sql)!.valueCount, 1);
    assert.equal(retained.entries.get(sql)!.sql, 'SELECT :p1 AS value');
    assert.equal(retained.entries.get(sql)!.returnsRows, true);
    await pool.end();
    assert.equal(retained.entries.size, 0);
    assert.equal(retained.bytes, 0);
  });
});

it('SQL retention is bounded by entry count and UTF-16 payload bytes under churn', async () => {
  await fixture(async (_db, pool) => {
    const memo = plans(pool);
    const check = () => {
      assert.ok(memo.entries.size <= 128);
      assert.ok(memo.bytes <= 131072);
      assert.equal(
        memo.bytes,
        [...memo.entries.values()].reduce((sum, plan) => sum + plan.bytes, 0),
      );
    };
    for (let i = 0; i < 512; i++) {
      assert.deepEqual((await pool.query(`SELECT $1 AS n /* shape ${i} */`, [i])).rows, [{ n: i }]);
      check();
    }
    assert.equal(memo.entries.size, 128);
    assert.equal(memo.entries.has('SELECT $1 AS n /* shape 0 */'), true);
    assert.equal(memo.entries.has('SELECT $1 AS n /* shape 511 */'), false);
    await pool.end();
  });
  await fixture(async (_db, pool) => {
    const memo = plans(pool);
    for (let i = 0; i < 12; i++) {
      await pool.query(`SELECT $1 AS n /* ${'雪'.repeat(4000)} ${i} */`, [i]);
      assert.ok(memo.bytes <= 131072);
    }
    assert.ok(memo.entries.size > 0);
    assert.ok(memo.entries.size < 12, 'byte cap stops admission before entry cap');
    const oversized = `SELECT $1 AS n /* ${'x'.repeat(34000)} */`;
    assert.deepEqual((await pool.query(oversized, [9])).rows, [{ n: 9 }]);
    assert.equal(memo.entries.has(oversized), false);
    assert.ok(memo.bytes <= 131072);
  });
});

it('warm classification preserves comment handling, change counts and returning writes', async () => {
  await fixture(async (db, pool) => {
    db.exec('CREATE TABLE counter(n INTEGER); INSERT INTO counter VALUES(0)');
    for (let i = 0; i < 3; i++) {
      const written = await pool.query('UPDATE counter SET n=n+$1 /* turbine:tag=orders-returning */', [1]);
      assert.equal(written.rowCount, 1);
      assert.deepEqual(written.rows, []);
      const result = await pool.query('UPDATE counter SET n=n+$1 RETURNING n', [1]);
      assert.deepEqual(result.rows, [{ n: (i + 1) * 2 }]);
    }
  });
});

it('warm rewrite plans observe native DDL, aliases and empty-to-nonempty result shapes', async () => {
  await fixture(async (db, pool) => {
    const sql = 'SELECT v AS value FROM changing WHERE rowid=$1';
    db.exec('CREATE TABLE changing(v BOOLEAN); INSERT INTO changing VALUES(1)');
    assert.deepEqual((await pool.query(sql, [2])).rows, []);
    assert.deepEqual((await pool.query(sql, [1])).rows, [{ value: descriptions ? true : 1 }]);
    db.exec('DROP TABLE changing; CREATE TABLE changing(v INTEGER); INSERT INTO changing VALUES(1)');
    assert.deepEqual((await pool.query(sql, [1])).rows, [{ value: 1 }]);
    await pool.query('BEGIN');
    db.exec('DROP TABLE changing; CREATE TABLE changing(v BOOLEAN); INSERT INTO changing VALUES(1)');
    assert.deepEqual((await pool.query(sql, [1])).rows, [{ value: descriptions ? true : 1 }]);
    await pool.query('ROLLBACK');
    assert.deepEqual((await pool.query(sql, [1])).rows, [{ value: 1 }]);
  });
});
