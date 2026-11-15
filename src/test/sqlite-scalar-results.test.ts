/** Scalar-only normalization retains the raw materialization boundary. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { SqlitePool } from '../sqlite.js';
import { skipGate } from './helpers.js';

const native = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  } catch {
    return undefined;
  }
})();
const { it } = skipGate(!native, 'requires node:sqlite (Node >= 22.5)');

async function fixture(run: (db: DatabaseSync, pool: SqlitePool) => Promise<void>) {
  const db = new native!.DatabaseSync(':memory:');
  const pool = new SqlitePool(db);
  try {
    await run(db, pool);
  } finally {
    await pool.end();
    assert.equal(db.isOpen, false);
  }
}

it('scalar object results retain every integer, byte, null, date text and own prototype field', async () => {
  await fixture(async (db, pool) => {
    db.exec(`CREATE TABLE scalar_rows(n INTEGER, bytes BLOB, at TIMESTAMP, "__proto__" TEXT);
      INSERT INTO scalar_rows VALUES(9007199254740993,x'00ff','0001-01-01 01:02:03','first'),
      (-9007199254740991,x'',NULL,NULL),(-9223372036854775808,NULL,'2024-02-29','last')`);
    const rows = (await pool.query('SELECT * FROM scalar_rows ORDER BY rowid')).rows;
    assert.deepEqual(rows, [
      { n: '9007199254740993', bytes: Uint8Array.of(0, 255), at: '0001-01-01 01:02:03', ['__proto__']: 'first' },
      { n: -9007199254740991, bytes: new Uint8Array(), at: null, ['__proto__']: null },
      { n: '-9223372036854775808', bytes: null, at: '2024-02-29', ['__proto__']: 'last' },
    ]);
    for (const row of rows) {
      assert.deepEqual(Object.keys(row), ['n', 'bytes', 'at', '__proto__']);
      assert.equal(Object.getPrototypeOf(row), Object.prototype);
      assert.equal(Object.getOwnPropertyDescriptor(row, '__proto__')!.enumerable, true);
    }
  });
});

it('scalar wrapped rows read each cell immediately before its inherited setter and keep exact errors', async () => {
  await fixture(async (db, pool) => {
    const events: string[] = [];
    const sentinel = new Error('scalar setter sentinel');
    const prepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      const stmt = prepare(sql);
      if (!sql.includes('scalar-control')) return stmt;
      stmt.all = (() =>
        [1, 2].map((n) => {
          const row = Object.create(null);
          Object.defineProperties(row, {
            scalar_result: {
              enumerable: true,
              get: () => {
                events.push(`read:${n}`);
                return BigInt(n);
              },
            },
            next: {
              enumerable: true,
              get: () => {
                events.push(`next:${n}`);
                return n + 10;
              },
            },
          });
          return row;
        })) as typeof stmt.all;
      return stmt;
    };
    Object.defineProperty(Object.prototype, 'scalar_result', {
      configurable: true,
      set(value: number) {
        events.push(`set:${value}`);
        if (value === 2) throw sentinel;
        Object.defineProperty(this, 'scalar_result', { enumerable: true, configurable: true, get: () => value });
      },
    });
    try {
      await assert.rejects(
        pool.query('SELECT 1 AS scalar_result, 11 AS next /* scalar-control */'),
        (e) => e === sentinel,
      );
      assert.deepEqual(events, ['read:1', 'set:1', 'next:1', 'read:2', 'set:2']);
    } finally {
      Reflect.deleteProperty(Object.prototype, 'scalar_result');
    }
  });
});

it('the same SQL switches between scalar and declared boolean decoding after DDL and rollback', async () => {
  await fixture(async (db, pool) => {
    db.exec('CREATE TABLE items(v INTEGER); INSERT INTO items VALUES(1),(0),(NULL)');
    const sql = 'SELECT * FROM items ORDER BY rowid';
    assert.deepEqual((await pool.query(sql)).rows, [{ v: 1 }, { v: 0 }, { v: null }]);
    await pool.query('SAVEPOINT scalar_shape');
    db.exec('DROP TABLE items; CREATE TABLE items(v BOOLEAN); INSERT INTO items VALUES(1),(0),(NULL)');
    const reportsTypes = typeof native!.StatementSync.prototype.columns === 'function';
    assert.deepEqual(
      (await pool.query(sql)).rows,
      reportsTypes ? [{ v: true }, { v: false }, { v: null }] : [{ v: 1 }, { v: 0 }, { v: null }],
    );
    await pool.query('ROLLBACK TO scalar_shape');
    await pool.query('RELEASE scalar_shape');
    assert.deepEqual((await pool.query(sql)).rows, [{ v: 1 }, { v: 0 }, { v: null }]);
  });
});

it('scalar result planning preserves Array constructor hooks and their exact errors', async () => {
  await fixture(async (db, pool) => {
    db.exec('CREATE TABLE items(v INTEGER); INSERT INTO items VALUES(1),(0)');
    const sentinel = new Error('scalar projection constructor sentinel');
    const constructorDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'constructor')!;
    let hits = 0;
    try {
      Object.defineProperty(Array.prototype, 'constructor', {
        configurable: true,
        get(this: unknown[]) {
          if (this.length === 1 && this[0] === 'v') {
            hits++;
            throw sentinel;
          }
          return Array;
        },
      });
      await assert.rejects(pool.query('SELECT * FROM items ORDER BY rowid'), (error) => error === sentinel);
      assert.equal(hits, 1);
    } finally {
      Object.defineProperty(Array.prototype, 'constructor', constructorDescriptor);
    }
    assert.deepEqual((await pool.query('SELECT * FROM items ORDER BY rowid')).rows, [{ v: 1 }, { v: 0 }]);
  });
});
