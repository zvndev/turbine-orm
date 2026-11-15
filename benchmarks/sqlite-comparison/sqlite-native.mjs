/** Installed native semantic heldouts; run from an isolated consumer. */
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const cjs = process.env.SQLITE_NATIVE_FORMAT === 'cjs';
const main = cjs ? require('turbine-orm') : await import('turbine-orm');
const api = cjs ? require('turbine-orm/better-sqlite3') : await import('turbine-orm/better-sqlite3');
const Better = require('better-sqlite3');
const root = process.env.SQLITE_NATIVE_ROOT;
assert.ok(root, 'explicit owned scratch directory required');
const schema = main.schemaDefToMetadata(main.defineSchema({
  items: { id: { type: 'integer', primaryKey: true }, fullName: { type: 'text' }, tenant: { type: 'integer' },
    active: { type: 'boolean' }, prefs: { type: 'json' }, at: { type: 'timestamp' },
    huge: { type: 'bigint' }, bytes: { type: 'bytea' } },
  children: { id: { type: 'integer', primaryKey: true }, itemId: { type: 'integer', references: 'items.id' } },
}));
const ddl = `CREATE TABLE items(id INTEGER PRIMARY KEY, full_name TEXT, tenant INTEGER, active INTEGER,
  prefs TEXT, at TIMESTAMP, huge INTEGER, bytes BLOB);
  INSERT INTO items VALUES(1,'one',1,1,'{"a":1}','0001-01-01 01:02:03.123',9007199254740993,x'00ff'),
  (2,'two',2,0,'[false,null]','2024-02-29 12:34:56.123',-9007199254740993,x''),
  (3,NULL,1,NULL,NULL,NULL,9007199254740991,NULL);
  CREATE TABLE children(id INTEGER PRIMARY KEY,item_id INTEGER REFERENCES items(id));
  INSERT INTO children VALUES(1,1);`;
let serial = 0;
async function fixture(fn, { owned = false, configure } = {}) {
  const path = join(root, `native-${process.pid}-${serial++}.db`);
  assert.ok(!existsSync(path), 'refuse a collision');
  const raw = new Better(owned ? path : ':memory:');
  let db, active = raw;
  try {
    raw.exec(ddl);
    if (owned) raw.close();
    const prepare = Better.prototype.prepare;
    try {
      if (owned) Better.prototype.prepare = function (sql) { active = this; return prepare.call(this, sql); };
      db = await api.turbineBetterSqlite3(owned ? path : raw, schema, { logger: {}, busyTimeoutMs: 20 });
      if (owned) await db.rawUnsafe('SELECT 1');
    } finally { Better.prototype.prepare = prepare; }
    configure?.(active);
    await fn(db, active);
    await db.disconnect();
    assert.equal(raw.open, !owned, 'supplied handles survive disconnect');
  } finally {
    await db?.disconnect();
    if (owned && active.open) active.close();
    if (raw.open) raw.close();
    for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(path + suffix, { force: true });
  }
}

test('native rows preserve every scalar, own prototype field and both materialization modes', async () => {
  for (const owned of [false, true]) await fixture(async (db) => {
    const rows = await db.table('items').findMany({ orderBy: { id: 'asc' } });
    assert.equal(rows.length, 3);
    assert.deepEqual(Object.keys(rows[0]), ['id', 'fullName', 'tenant', 'active', 'prefs', 'at', 'huge', 'bytes']);
    assert.deepEqual(rows.map((r) => [r.id, r.active, r.prefs, r.huge]),
      [[1, true, { a: 1 }, '9007199254740993'], [2, false, [false, null], '-9007199254740993'], [3, null, null, 9007199254740991]]);
    assert.equal(rows[0].at.toISOString(), '0001-01-01T01:02:03.123Z');
    assert.equal(rows[1].at.toISOString(), '2024-02-29T12:34:56.123Z');
    assert.equal(rows[2].at, null);
    assert.equal(rows[0].bytes.constructor, Uint8Array);
    assert.deepEqual([...rows[0].bytes], [0, 255]);
    assert.deepEqual([...rows[1].bytes], []);
    assert.equal(rows[2].bytes, null);
    const raw = await db.rawUnsafe('SELECT prefs AS "__proto__",id AS "10",active AS "2" FROM items ORDER BY id');
    assert.deepEqual(Object.keys(raw[0]), ['2', '10', '__proto__']);
    assert.deepEqual(Object.getOwnPropertyDescriptor(raw[0], '__proto__'),
      { value: { a: 1 }, writable: true, enumerable: true, configurable: true });
    assert.ok(raw.every((r) => Object.getPrototypeOf(r) === Object.prototype));
    assert.deepEqual(await db.rawUnsafe('SELECT active AS v,active+2 AS v FROM items ORDER BY id'), [{ v: 3 }, { v: 2 }, { v: null }]);
    // The oracle distinguishes missing values, wrong order, date and prototype loss.
    for (const change of [
      (r) => { delete r[0].fullName; }, (r) => r.reverse(),
      (r) => { r[0].at = '0001-01-01T01:02:03.123Z'; },
    ]) {
      const broken = rows.map((r) => ({ ...r })); change(broken);
      assert.throws(() => assert.deepEqual(broken, rows), assert.AssertionError);
    }
  }, { owned });
});

test('warm SQL analysis retains NULL holes, repeated names, errors and current bindings', async () => {
  await fixture(async (db) => {
    for (const name of [':foo', '@foo', '$foo', ':é', ':__proto__']) {
      for (const value of [7, null, 9, undefined])
        assert.deepEqual(await db.rawUnsafe(`SELECT :p1 AS supplied,${name} AS omitted, :p1 AS again`, value),
          [{ supplied: value ?? null, omitted: null, again: value ?? null }]);
    }
    for (let i = 0; i < 140; i++) assert.deepEqual(await db.rawUnsafe(`SELECT :p1 AS v /* ${i} */`, i), [{ v: i }]);
    const values = [1, 2];
    assert.deepEqual((await db.pool.query('SELECT :p2 AS b,:p1 AS a', values)).rows, [{ b: 2, a: 1 }]);
    values.reverse();
    assert.deepEqual((await db.pool.query('SELECT :p2 AS b,:p1 AS a', values)).rows, [{ b: 1, a: 2 }]);
    assert.deepEqual(await db.rawUnsafe('SELECT ?3 AS hole,? AS anonymous'), [{ hole: null, anonymous: null }]);
    await assert.rejects(db.rawUnsafe('SELECT :foo AS omitted', 1));
    assert.deepEqual(await db.rawUnsafe('SELECT :foo AS omitted'), [{ omitted: null }]);
    assert.deepEqual(await db.rawUnsafe("SELECT ':foo ?3' AS quoted, :p1 AS v /* :ignored */ -- @ignored", 4),
      [{ quoted: ':foo ?3', v: 4 }]);
    const input = { x: 1 };
    assert.deepEqual(await db.rawUnsafe('SELECT :p1 AS j', input), [{ j: '{"x":1}' }]);
    input.x = 2;
    assert.deepEqual(await db.rawUnsafe('SELECT :p1 AS j', input), [{ j: '{"x":2}' }]);
  });
});

test('numeric aliases retain native object enumeration order before raw setters run', async () => {
  for (const owned of [false, true]) await fixture(async (db) => {
    let events = '';
    for (const key of ['2', '10']) Object.defineProperty(Object.prototype, key, { configurable: true, set(value) {
      events += `${key}:${value};`;
      Object.defineProperty(this, key, { value, enumerable: true, writable: true, configurable: true });
    } });
    let rows;
    try { rows = await db.rawUnsafe('SELECT 10 AS "10",2 AS "2"'); }
    finally { delete Object.prototype['2']; delete Object.prototype['10']; }
    assert.equal(events, '2:2;10:10;');
    assert.deepEqual(rows, [{ 2: 2, 10: 10 }]);
  }, { owned });
});

test('native array admission is concrete and wrapped peer methods retain object fallback', async () => {
  for (const owned of [false, true]) for (const wrapped of [false, 'all', 'columns', 'raw', 'safeIntegers']) {
    let last;
    await fixture(async (db) => {
      assert.deepEqual(await db.rawUnsafe('SELECT full_name FROM items WHERE id=1'), [{ full_name: 'one' }]);
      const actualArray = Array.isArray(last.get());
      const node20 = Number(process.versions.node.split('.')[0]) < 22;
      assert.equal(actualArray, node20 || (owned && !wrapped && process.env.SQLITE_NATIVE_EXPECT_ARRAYS === '1'));
    }, { owned, configure(raw) {
      const prepare = raw.prepare.bind(raw);
      raw.prepare = (sql) => {
        last = prepare(sql);
        if (wrapped) last[wrapped] = last[wrapped].bind(last);
        return last;
      };
    } });
  }
});

test('a SQL callback installing a numeric array setter retains each runtime native behavior', async () => {
  for (const owned of [false, true]) await fixture(async (db, raw) => {
    let nativeRows = 0;
    raw.function('install_array_proto', () => {
      Object.defineProperty(Array.prototype, '2', { configurable: true, get() { return 'inherited'; }, set(value) {
        if (this.length === 2 && this[0] === 11 && this[1] === 22 && value === 33) nativeRows++;
        Object.defineProperty(this, '2', { value, configurable: true, enumerable: true, writable: true });
      } });
      return 11;
    });
    let rows;
    try { rows = await db.rawUnsafe('SELECT install_array_proto() AS a,22 AS b,33 AS c'); }
    finally { delete Array.prototype['2']; }
    assert.deepEqual(rows, [{ a: 11, b: 22, c: 33 }]);
    assert.equal(nativeRows, 0);
  }, { owned });
});

test('native and wrapped statements preserve raw setters, final field accessors and exact errors', async () => {
  for (const owned of [false, true]) for (const wrapped of [false, true]) await fixture(async (db) => {
    const events = [], sentinel = new Error('raw getter');
    Object.defineProperty(Object.prototype, 'full_name', { configurable: true, set(value) {
      events.push(['raw-set', value]);
      Object.defineProperty(this, 'full_name', { configurable: true, enumerable: true, get() {
        events.push(['raw-get', value]); if (value === 'two') throw sentinel; return value;
      } });
    } });
    try {
      const raw = await db.rawUnsafe('SELECT full_name FROM items WHERE id < 3 ORDER BY id');
      assert.deepEqual(events, [['raw-set', 'one'], ['raw-set', 'two']]);
      assert.equal(typeof Object.getOwnPropertyDescriptor(raw[0], 'full_name').get, 'function');
      events.length = 0;
      await assert.rejects(db.table('items').findMany({ orderBy: { id: 'asc' }, limit: 2 }), (e) => e === sentinel);
      assert.deepEqual(events, [['raw-set', 'one'], ['raw-set', 'two'], ['raw-get', 'one'], ['raw-get', 'two']]);
    } finally { delete Object.prototype.full_name; }
    const finalEvents = [];
    Object.defineProperty(Object.prototype, 'fullName', { configurable: true, set(value) {
      finalEvents.push(value);
      Object.defineProperty(this, 'fullName', { configurable: true, enumerable: true, get() { throw sentinel; } });
    } });
    try {
      const rows = await db.table('items').findMany({ orderBy: { id: 'asc' }, limit: 2 });
      assert.deepEqual(finalEvents, ['one', 'two']);
      assert.equal(typeof Object.getOwnPropertyDescriptor(rows[0], 'fullName').get, 'function');
      assert.throws(() => rows[0].fullName, (e) => e === sentinel);
      finalEvents.length = 0;
      const relation = Object.keys(schema.tables.items.relations).find((key) => schema.tables.items.relations[key].to === 'children');
      assert.ok(relation);
      const counted = await db.table('items').findMany({ orderBy: { id: 'asc' }, limit: 2, with: { _count: { [relation]: true } } });
      assert.deepEqual(finalEvents, ['one', 'two']);
      assert.equal(typeof Object.getOwnPropertyDescriptor(counted[0], 'fullName').get, 'function');
      assert.deepEqual(counted.map((row) => row._count), [{ [relation]: 1 }, { [relation]: 0 }]);
    } finally { delete Object.prototype.fullName; }
  }, { owned, configure(raw) {
    if (wrapped) {
      const prepare = raw.prepare.bind(raw);
      raw.prepare = (sql) => { const stmt = prepare(sql); stmt.all = stmt.all.bind(stmt); return stmt; };
    }
  } });
});

test('native admission never invokes an own statement method getter during prepare', async () => {
  for (const owned of [false, true]) {
    let gets = 0;
    await fixture(async (db) => {
      assert.deepEqual(await db.rawUnsafe('SELECT 42 AS value'), [{ value: 42 }]);
      assert.equal(gets, 1);
    }, { owned, configure(raw) {
      const prepare = raw.prepare.bind(raw);
      raw.prepare = (sql) => {
        const stmt = prepare(sql), all = stmt.all;
        Object.defineProperty(stmt, 'all', { get() { gets++; return all; } });
        return stmt;
      };
    } });
  }
});

test('installed transforms verify mixed row keys and survive a reentrant typed projection', async () => {
  await fixture(async (db) => {
    const query = db.table('items').buildFindMany();
    const nested = db.table('items').buildFindMany({ select: { at: true, id: true } });
    let calls = 0;
    const first = { id: 1, get full_name() {
      calls++;
      const inner = nested.transform({ rows: [{ at: '2024-02-29 12:34:56.123', id: 9 }], rowCount: 1 });
      assert.deepEqual(Object.keys(inner[0]), ['at', 'id']);
      assert.ok(inner[0].at instanceof Date);
      return 'one';
    }, at: '0001-01-01 01:02:03.123' };
    const rows = query.transform({ rows: [first, { prefs: { n: 2 }, id: 2 }, { id: 3, at: null }], rowCount: 3 });
    assert.equal(calls, 1);
    assert.deepEqual(rows.map(Object.keys), [['id', 'fullName', 'at'], ['prefs', 'id'], ['id', 'at']]);
    assert.equal(rows[0].fullName, 'one');
    assert.equal(rows[0].at.toISOString(), '0001-01-01T01:02:03.123Z');
    assert.deepEqual(rows[1], { prefs: { n: 2 }, id: 2 });
    assert.deepEqual(rows[2], { id: 3, at: null });
  });
});

test('SQL-only reuse refreshes schema descriptions through views, temp, attachments and rollback', async () => {
  await fixture(async (db, raw) => {
    raw.exec('CREATE TABLE source(v BOOLEAN); INSERT INTO source VALUES(1); CREATE VIEW changing AS SELECT v FROM source');
    const sql = 'SELECT * FROM changing';
    assert.deepEqual(await db.rawUnsafe(sql), [{ v: true }]);
    await db.rawUnsafe('SAVEPOINT shape');
    raw.exec('DROP VIEW changing; DROP TABLE source; CREATE TABLE source(v INTEGER,extra TEXT); INSERT INTO source VALUES(1,\'new\'); CREATE VIEW changing AS SELECT * FROM source');
    assert.deepEqual(await db.rawUnsafe(sql), [{ v: 1, extra: 'new' }]);
    await db.rawUnsafe('ROLLBACK TO shape');
    await db.rawUnsafe('RELEASE shape');
    assert.deepEqual(await db.rawUnsafe(sql), [{ v: true }]);
    raw.exec('CREATE TEMP VIEW changing AS SELECT 4 AS other');
    assert.deepEqual(await db.rawUnsafe(sql), [{ other: 4 }]);
    raw.exec('DROP VIEW temp.changing; ATTACH DATABASE \'\:memory:\' AS aux; CREATE TABLE aux.source(v BOOLEAN); INSERT INTO aux.source VALUES(0)');
    assert.deepEqual(await db.rawUnsafe('SELECT * FROM aux.source'), [{ v: false }]);
    raw.exec('DROP TABLE aux.source; CREATE TABLE aux.source(v INTEGER); INSERT INTO aux.source VALUES(0)');
    assert.deepEqual(await db.rawUnsafe('SELECT * FROM aux.source'), [{ v: 0 }]);
  });
});

test('post-prepare external DDL changes wildcard width, aliases and types before stepping', async () => {
  const path = join(root, `external-${process.pid}.db`);
  assert.ok(!existsSync(path), 'refuse a collision');
  const raw = new Better(path), writer = new Better(path);
  let db;
  try {
    raw.exec('PRAGMA journal_mode=WAL; CREATE TABLE changing(v BOOLEAN); INSERT INTO changing VALUES(1)');
    const prepare = raw.prepare.bind(raw);
    let armed = true;
    raw.prepare = (sql) => {
      const stmt = prepare(sql);
      if (armed && sql === 'SELECT * FROM changing') {
        armed = false;
        writer.exec('DROP TABLE changing; CREATE TABLE changing(extra TEXT,v INTEGER); INSERT INTO changing VALUES(\'fresh\',1)');
      }
      return stmt;
    };
    db = await api.turbineBetterSqlite3(raw, { tables: {}, enums: {} }, { logger: {} });
    assert.deepEqual(await db.rawUnsafe('SELECT * FROM changing'), [{ extra: 'fresh', v: 1 }]);
    assert.equal(armed, false);
    assert.deepEqual(await db.rawUnsafe('SELECT * FROM changing'), [{ extra: 'fresh', v: 1 }]);
  } finally {
    await db?.disconnect(); raw.close(); writer.close();
    for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(path + suffix, { force: true });
  }
});

test('factory-owned array results refresh external wildcard DDL, temp views and rollback', async () => {
  await fixture(async (db, raw) => {
    const writer = new Better(raw.name);
    const prepare = raw.prepare.bind(raw);
    let armed = true;
    try {
      raw.exec('CREATE TABLE changing(v BOOLEAN); INSERT INTO changing VALUES(1)');
      raw.prepare = (sql) => {
        const stmt = prepare(sql);
        if (armed && sql === 'SELECT * FROM changing') {
          armed = false;
          writer.exec('DROP TABLE changing; CREATE TABLE changing(extra TEXT,v INTEGER); INSERT INTO changing VALUES(\'fresh\',1)');
        }
        return stmt;
      };
      assert.deepEqual(await db.rawUnsafe('SELECT * FROM changing'), [{ extra: 'fresh', v: 1 }]);
      assert.equal(armed, false);
      await db.rawUnsafe('SAVEPOINT owned_shape');
      raw.exec('DROP TABLE changing; CREATE TABLE changing(v BOOLEAN); INSERT INTO changing VALUES(0)');
      assert.deepEqual(await db.rawUnsafe('SELECT * FROM changing'), [{ v: false }]);
      await db.rawUnsafe('ROLLBACK TO owned_shape');
      await db.rawUnsafe('RELEASE owned_shape');
      assert.deepEqual(await db.rawUnsafe('SELECT * FROM changing'), [{ extra: 'fresh', v: 1 }]);
      raw.exec('CREATE TEMP VIEW changing AS SELECT 7 AS other');
      assert.deepEqual(await db.rawUnsafe('SELECT * FROM changing'), [{ other: 7 }]);
      raw.exec('DROP VIEW temp.changing; ATTACH DATABASE \':memory:\' AS aux; CREATE TABLE aux.flags(v BOOLEAN); INSERT INTO aux.flags VALUES(0)');
      assert.deepEqual(await db.rawUnsafe('SELECT * FROM aux.flags'), [{ v: false }]);
    } finally { writer.close(); }
  }, { owned: true });
});

test('streams, rowless writes, rollback and native error identity retain their boundaries', async () => {
  for (const owned of [false, true]) await fixture(async (db, raw) => {
    const connection = await db.pool.connect();
    try {
      const rows = [];
      for await (const batch of connection.streamBatches('SELECT * FROM items ORDER BY id', [], 1)) rows.push(...batch);
      assert.equal(rows.length, 3);
      assert.deepEqual(rows.map((r) => r.active), [true, false, null]);
      const stream = connection.streamBatches('SELECT prefs AS "__proto__" FROM items ORDER BY id', [], 1);
      assert.deepEqual((await stream.next()).value[0].__proto__, { a: 1 });
      await stream.return();
    } finally { connection.release(); }
    assert.deepEqual(await db.rawUnsafe('WITH value AS (SELECT 1) UPDATE items SET full_name=\'changed\' WHERE id=1'), []);
    const sentinel = new Error('rollback sentinel');
    await assert.rejects(db.$transaction(async (tx) => {
      await tx.table('items').update({ where: { id: 1 }, data: { fullName: 'rolled back' } }); throw sentinel;
    }), (e) => e === sentinel);
    assert.equal((await db.table('items').findUnique({ where: { id: 1 } })).fullName, 'changed');
    const prepare = raw.prepare.bind(raw);
    raw.prepare = (sql) => { if (sql.includes('native_sentinel')) throw sentinel; return prepare(sql); };
    await assert.rejects(db.rawUnsafe('SELECT native_sentinel()'), (e) => e === sentinel);
  }, { owned });
});

test('factory-owned optional connections retain FULL durability and installed peer identity', async () => {
  await fixture(async (db) => {
    assert.deepEqual(await db.rawUnsafe('PRAGMA synchronous'), [{ synchronous: 2 }]);
    assert.deepEqual(await db.rawUnsafe('SELECT sqlite_version() AS v'), [{ v: '3.53.2' }]);
    assert.equal(require('better-sqlite3/package.json').version, '12.11.1');
  }, { owned: true });
});
