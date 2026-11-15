/** Native prototype-named cells are data, not Object prototype setters. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { introspectSqliteDatabase, SqlitePool, turbineSqlite } from '../sqlite.js';
import { skipGate } from './helpers.js';

const native = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  } catch {
    return undefined;
  }
})();
const nativeOwnKeys = (() => {
  if (!native) return false;
  const db = new native.DatabaseSync(':memory:');
  try {
    return Object.hasOwn(db.prepare('SELECT 1 AS "__proto__"').get()!, '__proto__');
  } finally {
    db.close();
  }
})();
const { it } = skipGate(
  !nativeOwnKeys,
  'requires native node:sqlite rows to retain own __proto__ cells (Node 22.16/24)',
);

function assertRow(row: Record<string, unknown>, value: unknown, keys: string[]) {
  assert.equal(Object.getPrototypeOf(row), Object.prototype);
  assert.deepEqual(Object.keys(row), keys);
  assert.deepEqual(Object.getOwnPropertyDescriptor(row, '__proto__'), {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
}

async function fixture(run: (db: DatabaseSync, pool: SqlitePool) => Promise<void>) {
  const db = new native!.DatabaseSync(':memory:');
  let pool: SqlitePool | undefined;
  try {
    db.exec(`CREATE TABLE items(id INTEGER PRIMARY KEY,"__proto__" JSON,constructor TEXT,"toString" TEXT);
      INSERT INTO items VALUES(1,'{"polluted":true}','ctor','text'),(2,'null','two','second');`);
    pool = new SqlitePool(db, { schema: introspectSqliteDatabase(db) });
    await run(db, pool);
  } finally {
    if (pool) await pool.end();
    else db.close();
  }
}

it('single, multirow and fixed projections preserve own prototype keys and decoded values', async () => {
  await fixture(async (_db, pool) => {
    for (const sql of ['SELECT * FROM items', 'SELECT id,"__proto__",constructor,"toString" FROM items']) {
      for (const count of [1, 2]) {
        const rows = (await pool.query(`${sql} ORDER BY id LIMIT ${count}`)).rows;
        assert.equal(rows.length, count);
        for (let i = 0; i < rows.length; i++)
          assertRow(rows[i], i === 0 ? { polluted: true } : null, ['id', '__proto__', 'constructor', 'toString']);
      }
    }
    const rows = (await pool.query('UPDATE items SET constructor=constructor RETURNING *')).rows;
    assertRow(rows[0], { polluted: true }, ['id', '__proto__', 'constructor', 'toString']);
    const duplicate = (await pool.query('SELECT 1 AS "__proto__",2 AS "__proto__"')).rows[0];
    assertRow(duplicate, 2, ['__proto__']);
  });
});

it('native streams preserve first and subsequent prototype cells in object and array paths', async () => {
  for (const objectOnly of [false, true]) {
    await fixture(async (db, pool) => {
      if (objectOnly) {
        const prepare = db.prepare.bind(db);
        db.prepare = (sql) => {
          const stmt = prepare(sql);
          Object.defineProperty(stmt, 'setReturnArrays', { value: undefined });
          return stmt;
        };
      }
      const connection = await pool.connect();
      try {
        const rows: Record<string, unknown>[] = [];
        for await (const batch of connection.streamBatches!('SELECT * FROM items ORDER BY id', [], 1))
          rows.push(...batch);
        assert.equal(rows.length, 2);
        assertRow(rows[0]!, { polluted: true }, ['id', '__proto__', 'constructor', 'toString']);
        assertRow(rows[1]!, null, ['id', '__proto__', 'constructor', 'toString']);
      } finally {
        connection.release();
      }
    });
  }
});

it('introspected mapped fields retain native prototype text through CRUD and returning', async () => {
  const nativeDb = new native!.DatabaseSync(':memory:');
  nativeDb.exec(
    'CREATE TABLE prototype_rows(id INTEGER PRIMARY KEY,"__proto__" TEXT NOT NULL,constructor TEXT,"toString" TEXT)',
  );
  const schema = introspectSqliteDatabase(nativeDb);
  const field = schema.tables.prototype_rows!.columns.find((column) => column.name === '__proto__')!.field;
  const db = turbineSqlite(nativeDb, schema, { logger: {}, warnOnUnlimited: false });
  try {
    const table = db.table('prototype_rows');
    const created = await table.create({ data: { id: 1, [field]: 'safe', constructor: 'ctor', toString: 'text' } });
    assert.equal(created[field], 'safe');
    const selected = await table.findFirst({ where: { id: 1 } });
    assert.equal(selected?.[field], 'safe');
    assert.equal(Object.hasOwn(selected!, field), true);
    const updated = await table.update({ where: { id: 1 }, data: { [field]: 'changed' } });
    assert.equal(updated[field], 'changed');
    const removed = await table.delete({ where: { id: 1 } });
    assert.equal(removed[field], 'changed');
  } finally {
    await db.disconnect();
    nativeDb.close();
  }
});
