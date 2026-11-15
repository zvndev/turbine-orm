/** Multirow result plans must stay local to one executed projection. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
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
const reportsTypes = typeof native?.StatementSync.prototype.columns === 'function';
const nativeArrays = reportsTypes && typeof native?.StatementSync.prototype.setReturnArrays === 'function';

async function fixture(run: (db: DatabaseSync, pool: SqlitePool) => Promise<void>) {
  const db = new native!.DatabaseSync(':memory:');
  const pool = new SqlitePool(db, {
    schema: schemaDefToMetadata(defineSchema({ items: { j: { type: 'json' } } })),
  });
  try {
    await run(db, pool);
  } finally {
    await pool.end();
  }
}

it('multirow normalization preserves per-cell types, nulls, exact integers and plain objects', async () => {
  await fixture(async (db, pool) => {
    db.exec(`CREATE TABLE items(b BOOLEAN,j TEXT,n INTEGER,bytes BLOB);
      INSERT INTO items VALUES(1,'{"n":1}',9007199254740993,x'00ff'),
        (0,'[false,null]',-9007199254740993,x''),(2,'invalid',9007199254740991,NULL),
        (NULL,NULL,NULL,x'42'),('unchanged','null',-9007199254740991,x'ff')`);
    const rows = (await pool.query('SELECT b,j,n,bytes FROM items ORDER BY rowid')).rows;
    assert.deepEqual(rows, [
      {
        b: reportsTypes ? true : 1,
        j: reportsTypes ? { n: 1 } : '{"n":1}',
        n: '9007199254740993',
        bytes: Uint8Array.of(0, 255),
      },
      {
        b: reportsTypes ? false : 0,
        j: reportsTypes ? [false, null] : '[false,null]',
        n: '-9007199254740993',
        bytes: new Uint8Array(),
      },
      { b: 2, j: 'invalid', n: 9007199254740991, bytes: null },
      { b: null, j: null, n: null, bytes: Uint8Array.of(66) },
      { b: 'unchanged', j: reportsTypes ? null : 'null', n: -9007199254740991, bytes: Uint8Array.of(255) },
    ]);
    assert.ok(rows.every((row: object) => Object.getPrototypeOf(row) === Object.prototype));
    assert.notEqual(rows[0], rows[1]);
    const returned = await pool.query('UPDATE items SET n=n WHERE rowid<=2 RETURNING b,j,n,bytes');
    assert.equal(returned.rowCount, 2);
    assert.deepEqual(returned.rows, rows.slice(0, 2));
  });
});

it('multirow keys follow each native projection including duplicate and numeric aliases', async () => {
  await fixture(async (db, pool) => {
    db.exec(`CREATE TABLE items(b BOOLEAN,j TEXT); INSERT INTO items VALUES(1,'{"n":1}'),(0,'[2]')`);
    for (let i = 0; i < 3; i++) {
      const result = await pool.query(
        'SELECT b AS "10",j AS "2",b AS value,j AS value,b+0 AS expr FROM items ORDER BY rowid',
      );
      assert.equal(result.rowCount, 2);
      assert.deepEqual(result.rows, [
        {
          '2': reportsTypes ? { n: 1 } : '{"n":1}',
          '10': reportsTypes ? true : 1,
          value: reportsTypes ? { n: 1 } : '{"n":1}',
          expr: 1,
        },
        { '2': reportsTypes ? [2] : '[2]', '10': reportsTypes ? false : 0, value: reportsTypes ? [2] : '[2]', expr: 0 },
      ]);
      assert.deepEqual(Object.keys(result.rows[0]), ['2', '10', 'value', 'expr']);
      assert.deepEqual((await pool.query('SELECT b+0 AS changed FROM items WHERE rowid=1')).rows, [{ changed: 1 }]);
      assert.deepEqual((await pool.query('SELECT j FROM items WHERE 0')).rows, []);
      assert.deepEqual((await pool.query('SELECT b+0 AS other FROM items ORDER BY rowid')).rows, [
        { other: 1 },
        { other: 0 },
      ]);
    }
  });
});

it('raw normalization retains builtin projection assignment order and object fallback order', async () => {
  for (const wrapped of [false, true]) {
    await fixture(async (db, pool) => {
      // Early node:sqlite builds ordinary native objects, so inherited setters
      // also run while the driver constructs rows, before normalization.
      const nativeSetters = Object.getPrototypeOf(db.prepare('SELECT 1 AS v').get()) === Object.prototype;
      if (wrapped) {
        const prepare = db.prepare.bind(db);
        db.prepare = (sql) => {
          const stmt = prepare(sql);
          const all = stmt.all.bind(stmt);
          stmt.all = (...params) => Reflect.apply(all, stmt, params);
          return stmt;
        };
      }
      await pool.query('SELECT 1 AS warm');
      const projectionOrder = nativeArrays && !wrapped;
      for (const sql of [
        'SELECT 10 AS "10",2 AS "2"',
        'SELECT 10 AS "10",2 AS "2",11 AS "10" UNION ALL SELECT 20,3,21',
      ]) {
        let events = '';
        let result: Awaited<ReturnType<typeof pool.query>>;
        try {
          for (const key of ['2', '10']) {
            Object.defineProperty(Object.prototype, key, {
              configurable: true,
              set(value: unknown) {
                const isRow = !Array.isArray(this);
                if (isRow) events += `${key};`;
                const stored =
                  isRow && key === '10' ? `${Object.hasOwn(this, '2') ? 'after' : 'before'}:${value}` : value;
                Object.defineProperty(this, key, {
                  value: stored,
                  writable: true,
                  configurable: true,
                  enumerable: true,
                });
              },
            });
          }
          result = await pool.query(sql);
        } finally {
          Reflect.deleteProperty(Object.prototype, '2');
          Reflect.deleteProperty(Object.prototype, '10');
        }
        const values = sql.includes('UNION') ? [11, 21] : [10];
        assert.equal(
          events,
          (nativeSetters ? '10;2;'.repeat(values.length) : '') +
            (projectionOrder ? '10;2;' : '2;10;').repeat(values.length),
        );
        assert.deepEqual(
          result.rows.map((row: Record<string, unknown>) => row['10']),
          values.map(
            (value) =>
              `${projectionOrder ? 'before' : 'after'}:${nativeSetters && !sql.includes('UNION') ? 'before:' : ''}${value}`,
          ),
        );
      }
      const failure = new Error('raw assignment order');
      let rejected = false;
      try {
        Object.defineProperty(Object.prototype, '10', {
          configurable: true,
          set(value: unknown) {
            if (!Array.isArray(this) && !Object.hasOwn(this, '2')) throw failure;
            Object.defineProperty(this, '10', { value, writable: true, configurable: true, enumerable: true });
          },
        });
        try {
          await pool.query('SELECT 10 AS "10",2 AS "2"');
        } catch (error) {
          assert.equal(error, failure);
          rejected = true;
        }
      } finally {
        Reflect.deleteProperty(Object.prototype, '10');
      }
      assert.equal(rejected, projectionOrder || nativeSetters);
    });
  }
});

it('multirow views with unchanged aliases refresh types after native DDL and savepoint rollback', async () => {
  await fixture(async (db, pool) => {
    db.exec(`CREATE TABLE source(v BOOLEAN); INSERT INTO source VALUES(1),(0);
      CREATE VIEW changing AS SELECT v AS value FROM source`);
    const sql = 'SELECT value FROM changing ORDER BY value DESC';
    const bools = [{ value: reportsTypes ? true : 1 }, { value: reportsTypes ? false : 0 }];
    const ints = [{ value: 1 }, { value: 0 }];
    assert.deepEqual((await pool.query(sql)).rows, bools);
    await pool.query('SAVEPOINT types');
    db.exec(
      'DROP VIEW changing; DROP TABLE source; CREATE TABLE source(v INTEGER); INSERT INTO source VALUES(1),(0); CREATE VIEW changing AS SELECT v AS value FROM source',
    );
    assert.deepEqual((await pool.query(sql)).rows, ints);
    await pool.query('ROLLBACK TO types');
    assert.deepEqual((await pool.query(sql)).rows, bools);
    await pool.query('RELEASE types');
  });
});

it('builtin ordinary results use arrays without retaining a native projection between calls', async () => {
  await fixture(async (db, pool) => {
    db.exec(`CREATE TABLE items(b BOOLEAN,j TEXT); INSERT INTO items VALUES(1,'{"n":1}'),(0,'[2]')`);
    const prepare = db.prepare.bind(db);
    let last: ReturnType<DatabaseSync['prepare']> | undefined;
    let prepares = 0;
    db.prepare = (sql) => {
      prepares++;
      last = prepare(sql);
      return last;
    };
    for (const limit of [1, 2, 0, 2]) {
      const result = await pool.query(`SELECT b AS "10",j AS "2",b AS v,j AS v FROM items ORDER BY rowid LIMIT $1`, [
        limit,
      ]);
      assert.deepEqual(
        result.rows,
        [
          {
            '2': reportsTypes ? { n: 1 } : '{"n":1}',
            '10': reportsTypes ? true : 1,
            v: reportsTypes ? { n: 1 } : '{"n":1}',
          },
          { '2': reportsTypes ? [2] : '[2]', '10': reportsTypes ? false : 0, v: reportsTypes ? [2] : '[2]' },
        ].slice(0, limit),
      );
      assert.equal(result.rowCount, limit);
      assert.ok(result.rows.every((row: object) => Object.getPrototypeOf(row) === Object.prototype));
      if (limit) {
        assert.deepEqual(Object.keys(result.rows[0]), ['2', '10', 'v']);
        // Observe the actual native mode without wrapping the methods under test.
        assert.equal(Array.isArray(last!.get({ p1: BigInt(limit) })), nativeArrays);
      }
    }
    assert.equal(prepares, 4, 'each ordinary execution prepares a fresh statement');
    assert.deepEqual((await pool.query('SELECT * FROM items ORDER BY rowid LIMIT 1')).rows, [
      { b: reportsTypes ? true : 1, j: reportsTypes ? { n: 1 } : '{"n":1}' },
    ]);
    assert.equal(Array.isArray(last!.get()), false, 'wildcard projections keep native object rows');
    assert.deepEqual((await pool.query('SELECT b FROM items /* wildcard * in comment */ LIMIT 1')).rows, [
      { b: reportsTypes ? true : 1 },
    ]);
    assert.equal(Array.isArray(last!.get()), false, 'admission is conservative for literal/comment stars');
    const collisions = await pool.query(
      'SELECT j AS "__proto__",b+2 AS "__proto__",b AS v,b+0 AS v FROM items ORDER BY rowid',
    );
    assert.deepEqual(
      collisions.rows,
      Object.hasOwn(db.prepare('SELECT 1 AS "__proto__"').get()!, '__proto__')
        ? [
            { ['__proto__']: 3, v: 1 },
            { ['__proto__']: 2, v: 0 },
          ]
        : [{ v: reportsTypes ? true : 1 }, { v: reportsTypes ? false : 0 }],
    );
    assert.ok(collisions.rows.every((row: object) => Object.getPrototypeOf(row) === Object.prototype));
    last = undefined;
  });
});

it('ordinary object fallback preserves wrapped methods and unavailable descriptions', async () => {
  for (const kind of ['all', 'columns', 'missing-columns', 'throwing-columns', 'arrays']) {
    await fixture(async (db, pool) => {
      db.exec(`CREATE TABLE items(b BOOLEAN,j TEXT); INSERT INTO items VALUES(1,'{"n":1}'),(0,'null')`);
      const prepare = db.prepare.bind(db);
      let switches = 0;
      let observed: unknown[] = [];
      db.prepare = (sql) => {
        const stmt = prepare(sql);
        if (kind === 'all') {
          const all = stmt.all.bind(stmt);
          stmt.all = () => {
            const rows = all();
            observed = rows;
            return rows;
          };
        } else if (kind === 'columns' && reportsTypes) stmt.columns = stmt.columns.bind(stmt);
        else if (kind === 'missing-columns') Object.defineProperty(stmt, 'columns', { value: undefined });
        else if (kind === 'throwing-columns')
          stmt.columns = () => {
            throw new Error('description unavailable');
          };
        else if (kind === 'arrays')
          stmt.setReturnArrays = () => {
            switches++;
            throw new Error('wrapped array mode must not be selected');
          };
        return stmt;
      };
      const typed = reportsTypes && kind !== 'missing-columns' && kind !== 'throwing-columns';
      assert.deepEqual((await pool.query('SELECT b,j FROM items ORDER BY rowid')).rows, [
        { b: typed ? true : 1, j: typed ? { n: 1 } : '{"n":1}' },
        { b: typed ? false : 0, j: typed ? null : 'null' },
      ]);
      assert.equal(switches, 0, kind);
      if (kind === 'all') {
        assert.equal(observed.length, 2);
        assert.ok(observed.every((row) => !Array.isArray(row)));
        assert.deepEqual(
          observed.map((row) => (row as { b: unknown }).b),
          [1n, 0n],
          'native rows stay untouched',
        );
      }
    });
  }
});

it('ordinary arrays resolve changed column positions and decoders after first-step reprepare', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-sqlite-result-'));
  const db = new native!.DatabaseSync(join(dir, 'database.sqlite'));
  const writer = new native!.DatabaseSync(join(dir, 'database.sqlite'));
  const pool = new SqlitePool(db);
  try {
    db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE items(b BOOLEAN,label TEXT,flag INTEGER);
      INSERT INTO items VALUES(1,'a',0),(0,'b',1)`);
    const sql = 'SELECT label,b,flag FROM items ORDER BY rowid';
    assert.deepEqual((await pool.query(sql)).rows, [
      { label: 'a', b: reportsTypes ? true : 1, flag: 0 },
      { label: 'b', b: reportsTypes ? false : 0, flag: 1 },
    ]);
    const prepare = db.prepare.bind(db);
    let armed = true;
    db.prepare = (text) => {
      const stmt = prepare(text);
      if (armed && text === sql) {
        armed = false;
        writer.exec(`DROP TABLE items; CREATE TABLE items(label TEXT,b INTEGER,flag BOOLEAN);
          INSERT INTO items VALUES('a',1,0),('b',0,1)`);
      }
      return stmt;
    };
    assert.deepEqual((await pool.query(sql)).rows, [
      { label: 'a', b: 1, flag: reportsTypes ? false : 0 },
      { label: 'b', b: 0, flag: reportsTypes ? true : 1 },
    ]);
    assert.equal(armed, false);
    await pool.query('SAVEPOINT shape');
    db.exec(
      "DROP TABLE items; CREATE TABLE items(flag INTEGER,b BOOLEAN,label TEXT); INSERT INTO items VALUES(1,0,'c')",
    );
    assert.deepEqual((await pool.query(sql)).rows, [{ label: 'c', b: reportsTypes ? false : 0, flag: 1 }]);
    await pool.query('ROLLBACK TO shape');
    await pool.query('RELEASE shape');
    assert.deepEqual((await pool.query(sql)).rows, [
      { label: 'a', b: 1, flag: reportsTypes ? false : 0 },
      { label: 'b', b: 0, flag: reportsTypes ? true : 1 },
    ]);
  } finally {
    await pool.end();
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
