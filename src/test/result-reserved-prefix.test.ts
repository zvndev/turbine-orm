import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseSync as NativeDatabase } from 'node:sqlite';
import { introspectSqliteDatabase, turbineSqlite } from '../sqlite.js';
import { skipGate } from './helpers.js';

const DatabaseSync: typeof NativeDatabase | undefined = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();
const { it } = skipGate(!DatabaseSync, 'requires node:sqlite (Node >= 22.5)');
const userTables = ['SQLITExUpper', 'ordinary_records', 'sqliteArchive', 'sqlitex_records', 'sqliteλ_records'];
const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

function fixture() {
  const native = new DatabaseSync!(':memory:');
  native.exec('CREATE TABLE ordinary_records(id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL)');
  for (const name of userTables.filter((name) => name !== 'ordinary_records'))
    native.exec(`CREATE TABLE ${quote(name)}(id INTEGER PRIMARY KEY, full_name TEXT NOT NULL)`);
  for (const name of userTables) native.prepare(`INSERT INTO ${quote(name)} VALUES(?, ?)`).run(7, name);
  native.exec('ANALYZE');
  return native;
}

it('retains valid user tables beside the literal reserved prefix and excludes native internals', () => {
  const native = fixture();
  try {
    const actual = native.prepare("SELECT name FROM main.sqlite_master WHERE type='table' ORDER BY name").all();
    assert.ok(actual.some((row) => row.name === 'sqlite_sequence'));
    assert.ok(actual.some((row) => row.name === 'sqlite_stat1'));
    for (const name of ['sqlite_reserved', 'SQLITE_reserved', 'SqLiTe_reserved'])
      assert.throws(() => native.exec(`CREATE TABLE ${quote(name)}(id INTEGER)`), /reserved for internal use/);
    const schema = introspectSqliteDatabase(native);
    assert.deepEqual(Object.keys(schema.tables), userTables);
    for (const name of userTables) {
      assert.deepEqual(schema.tables[name]!.allColumns, ['id', 'full_name']);
      assert.deepEqual(
        schema.tables[name]!.columns.map((column) => column.field),
        ['id', 'fullName'],
      );
      assert.deepEqual({ ...native.prepare(`SELECT * FROM ${quote(name)}`).get() }, { id: 7, full_name: name });
    }
    assert.equal(native.isOpen, true);
  } finally {
    native.close();
  }
});

it('preserves main-catalog discovery, include/exclude, transactions and supplied-handle ownership', async () => {
  const native = fixture();
  let client: ReturnType<typeof turbineSqlite> | undefined;
  try {
    native.exec(`CREATE TEMP TABLE sqliteTempOnly(id INTEGER); ATTACH ':memory:' AS other;
      CREATE TABLE other.sqliteAttachedOnly(id INTEGER); BEGIN`);
    assert.deepEqual(Object.keys(introspectSqliteDatabase(native, { include: ['sqliteArchive'] }).tables), [
      'sqliteArchive',
    ]);
    assert.deepEqual(
      Object.keys(introspectSqliteDatabase(native, { exclude: ['sqliteArchive'] }).tables),
      userTables.filter((name) => name !== 'sqliteArchive'),
    );
    assert.equal(native.isTransaction, true);
    native.exec('ROLLBACK');
    const schema = introspectSqliteDatabase(native);
    assert.deepEqual(Object.keys(schema.tables), userTables);
    client = turbineSqlite(native, schema, { logger: {} });
    for (const name of userTables)
      assert.deepEqual(await client.table(name).findMany({ orderBy: { id: 'asc' } }), [{ id: 7, fullName: name }]);
    await client.disconnect();
    assert.equal(native.isOpen, true);
    assert.equal(native.prepare('SELECT COUNT(*) AS n FROM sqliteArchive').get()!.n, 1);
  } finally {
    await client?.disconnect();
    native.close();
  }
});
