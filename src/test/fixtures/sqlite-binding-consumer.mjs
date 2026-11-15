/** Run from a physical installed consumer, ESM and CJS, with the real native peer. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(join(process.cwd(), 'package.json'));
const format = process.argv[2];
assert.ok(['esm', 'cjs', 'missing-esm', 'missing-cjs'].includes(format));
const cjs = format.endsWith('cjs');
const entry = process.env.SQLITE_BINDING_ENTRY;
const api = entry
  ? cjs
    ? require(entry)
    : await import(pathToFileURL(entry).href)
  : cjs
    ? require('turbine-orm/better-sqlite3')
    : await import('turbine-orm/better-sqlite3');
const main = cjs ? require('turbine-orm') : await import('turbine-orm');
const { defineSchema, schemaDefToMetadata } = main;
const { turbineBetterSqlite3, introspectBetterSqlite3Database, betterSqlite3Dialect } = api;
assert.equal(typeof turbineBetterSqlite3, 'function');
const schema = schemaDefToMetadata(
  defineSchema({
    items: {
      id: { type: 'integer', primaryKey: true },
      tenant: { type: 'integer' },
      active: { type: 'boolean' },
      prefs: { type: 'json' },
      at: { type: 'timestamp' },
      huge: { type: 'bigint' },
      bytes: { type: 'bytea' },
      precise: { type: 'double' },
    },
    children: {
      id: { type: 'integer', primaryKey: true },
      itemId: { type: 'integer', references: 'items.id' },
      active: { type: 'boolean' },
      prefs: { type: 'json' },
      huge: { type: 'bigint' },
      bytes: { type: 'bytea' },
      at: { type: 'timestamp' },
      precise: { type: 'double' },
    },
  }),
);
const checked = [];
let sqliteVersion = null;
if (format.startsWith('missing')) {
  assert.throws(() => require.resolve('better-sqlite3'), /Cannot find module/);
  await assert.rejects(turbineBetterSqlite3(':memory:', schema), /optional better-sqlite3.*Install the peer/);
  assert.equal(betterSqlite3Dialect.introspector, undefined, 'no migration/CLI lifecycle claim');
  checked.push('lazy import succeeds without peer; opening refuses');
} else {
  const Better = require('better-sqlite3');
  const file = join(process.cwd(), `sqlite-binding-${format}.db`);
  const db = await turbineBetterSqlite3(file, schema, { logger: {}, busyTimeoutMs: 100 });
  let populated = false;
  try {
    assert.equal(db.pool.db.isOpen, true);
    sqliteVersion = (await db.rawUnsafe('SELECT sqlite_version() AS v'))[0].v;
    for (const method of ['createSession', 'applyChangeset', 'setAuthorizer'])
      assert.throws(() => db.pool.db[method](), /TURBINE_E017/);
    assert.equal((await db.rawUnsafe('PRAGMA synchronous'))[0].synchronous, 2);
    assert.equal((await db.rawUnsafe('PRAGMA foreign_keys'))[0].foreign_keys, 1);
    assert.equal((await db.rawUnsafe('PRAGMA journal_mode'))[0].journal_mode, 'wal');
    for (const name of [':foo', '@foo', '$foo', ':é', '$1abc', ':__proto__']) {
      assert.deepEqual(await db.rawUnsafe(`SELECT ${name} AS value`), [{ value: null }]);
      assert.deepEqual(await db.rawUnsafe(`SELECT :p1 AS supplied,${name} AS omitted`, 7), [
        { supplied: 7, omitted: null },
      ]);
    }
    assert.deepEqual(await db.rawUnsafe("SELECT ':ignored' AS literal,:foo AS value /* @ignored */"), [
      { literal: ':ignored', value: null },
    ]);
    await assert.rejects(db.rawUnsafe("SELECT ':p1' AS literal,:foo AS value", 7), /Unknown SQLite binding/);
    checked.push('omitted and partial native named bindings retain NULL without binding quoted tokens');
    await db.rawUnsafe(
      'CREATE TABLE items(id INTEGER PRIMARY KEY,tenant INTEGER,active INTEGER,prefs TEXT,at TIMESTAMP,huge INTEGER,bytes BLOB,precise REAL)',
    );
    await db.rawUnsafe(
      'CREATE TABLE children(id INTEGER PRIMARY KEY,item_id INTEGER REFERENCES items(id),active INTEGER,prefs TEXT,huge INTEGER,bytes BLOB,at TIMESTAMP,precise REAL)',
    );
    const parent = {
      id: 1,
      tenant: 1,
      active: true,
      prefs: { ['__proto__']: { safe: true }, nested: [null, false, 1] },
      at: new Date('2024-02-03T04:05:06Z'),
      huge: '9007199254740993',
      bytes: Uint8Array.of(0, 255),
      precise: 1.2345678901234567,
    };
    const child = {
      id: 1,
      itemId: 1,
      active: false,
      prefs: [null, { v: true }],
      huge: '-9007199254740993',
      bytes: Uint8Array.of(1, 128),
      at: parent.at,
      precise: parent.precise,
    };
    assert.deepEqual(await db.table('items').create({ data: parent }), parent);
    assert.deepEqual(await db.table('children').create({ data: child }), child);
    const nullableChild = {
      id: 2,
      itemId: 1,
      active: null,
      prefs: null,
      huge: null,
      bytes: null,
      at: null,
      precise: null,
    };
    const emptyChild = { ...nullableChild, id: 3, bytes: new Uint8Array() };
    assert.deepEqual(await db.table('children').createMany({ data: [nullableChild, emptyChild] }), [
      nullableChild,
      emptyChild,
    ]);
    const prototypeSql = 'SELECT prefs AS "__proto__",id FROM items ORDER BY id';
    const prototypeRows = [{ ['__proto__']: parent.prefs, id: 1 }];
    assert.deepEqual(await db.rawUnsafe(prototypeSql), prototypeRows);
    const prototypeConnection = await db.pool.connect();
    try {
      const rows = [];
      for await (const batch of prototypeConnection.streamBatches(prototypeSql, [], 1)) rows.push(...batch);
      assert.deepEqual(rows, prototypeRows);
      assert.ok(Object.hasOwn(rows[0], '__proto__'));
    } finally {
      prototypeConnection.release();
    }
    checked.push('prototype-named result columns survive complete reads and native iteration');
    const rel = Object.entries(schema.tables.items.relations).find(([, r]) => r.to === 'children')?.[0];
    assert.ok(rel, 'actual relation metadata required');
    for (const strategy of ['join', 'batched']) {
      const got = await db
        .table('items')
        .findMany({ with: { [rel]: true }, relationLoadStrategy: strategy, orderBy: { id: 'asc' } });
      assert.deepEqual(got, [{ ...parent, [rel]: [child, nullableChild, emptyChild] }]);
      assert.equal(Object.getPrototypeOf(got[0]), Object.prototype);
    }
    checked.push('exact direct/join/batched values, prototypes, 17-digit REAL, huge integers, BLOB, JSON, bool, dates');
    await assert.rejects(db.table('children').create({ data: { ...child, id: 999, itemId: 999 } }), /TURBINE_E009/);
    assert.deepEqual(await db.rawUnsafe('SELECT $2 AS second,$1 AS first', 7, 'changed'), [
      { second: 'changed', first: 7 },
    ]);
    assert.deepEqual(await db.rawUnsafe('SELECT ?2 AS value,? AS later'), [{ value: null, later: null }]);
    await assert.rejects(db.rawUnsafe("SELECT ':p1' AS literal", 7), /Unknown SQLite binding/);
    const rollback = new Error('rollback sentinel');
    await assert.rejects(
      db.$transaction(async (tx) => {
        await tx.table('items').update({ where: { id: 1 }, data: { tenant: 9 } });
        throw rollback;
      }),
      (e) => e === rollback,
    );
    assert.deepEqual(await db.table('items').findUnique({ where: { id: 1 } }), parent);
    checked.push('native FK refusal and transaction rollback');
    const lock = new Better(file);
    try {
      lock.exec('BEGIN IMMEDIATE;UPDATE items SET tenant=4 WHERE id=1');
      await assert.rejects(db.rawUnsafe('UPDATE items SET tenant=5 WHERE id=1'), (e) => e.isRetryable === true);
    } finally {
      if (lock.inTransaction) lock.exec('ROLLBACK');
      lock.close();
    }
    assert.deepEqual(await db.table('items').findUnique({ where: { id: 1 } }), parent);
    checked.push('native competing-writer BUSY is retryable; original transaction unchanged');
    assert.deepEqual(await db.rawUnsafe("UPDATE items SET prefs='returning' WHERE id=1"), []);
    assert.equal((await db.table('items').findUnique({ where: { id: 1 } })).prefs, 'returning');
    await db.table('items').update({ where: { id: 1 }, data: { prefs: parent.prefs } });
    checked.push('rowless native execution through raw row-returning classifier');
    await db.rawUnsafe('CREATE VIEW changing AS SELECT active AS v FROM items');
    assert.deepEqual(await db.rawUnsafe('SELECT v FROM changing'), [{ v: true }]);
    const c = await db.pool.connect();
    try {
      await c.query('SAVEPOINT schema_change');
      await c.query('DROP VIEW changing');
      await c.query('CREATE VIEW changing AS SELECT tenant AS v FROM items');
      assert.deepEqual((await c.query('SELECT v FROM changing')).rows, [{ v: 1 }]);
      await c.query('ROLLBACK TO schema_change');
      await c.query('RELEASE schema_change');
    } finally {
      c.release();
    }
    assert.deepEqual(await db.rawUnsafe('SELECT v FROM changing'), [{ v: true }]);
    checked.push('native DDL/savepoint invalidation');
    const many = Array.from({ length: 1000 }, (_, i) => ({ ...parent, id: i + 10, tenant: i % 3 }));
    assert.deepEqual(await db.table('items').createMany({ data: many }), many);
    populated = true;
    assert.deepEqual(
      await db.table('items').findMany({ where: { id: { in: [11, 10] } }, orderBy: { id: 'asc' } }),
      many.slice(0, 2),
    );
    await assert.rejects(db.table('items').createMany({ data: [{ ...parent, id: 5000 }, parent] }));
    assert.equal(await db.table('items').findUnique({ where: { id: 5000 } }), null);
    checked.push('full-returning1000 and list binds; atomic conflicting bulk');
    const abort = new AbortController(),
      reason = { stop: 'caller abort' };
    const stream = db.table('items').findManyStream({ batchSize: 2, signal: abort.signal, orderBy: { id: 'asc' } });
    assert.deepEqual((await stream.next()).value, parent);
    abort.abort(reason);
    await assert.rejects(stream.next(), (e) => e === reason);
    const early = db.table('items').findManyStreamBatches({ batchSize: 3, orderBy: { id: 'asc' } });
    assert.equal((await early.next()).value.length, 3);
    await early.return();
    assert.equal(await db.table('items').count(), 1001);
    const held = await db.pool.connect();
    await held.query('BEGIN');
    await held.query('UPDATE items SET tenant=6 WHERE id=1');
    held.release();
    assert.deepEqual(await db.table('items').findUnique({ where: { id: 1 } }), parent);
    checked.push('abort identity, early stream return and released-transaction rollback');
    const raw = new Better(':memory:');
    try {
      raw.exec('CREATE TABLE caller(id INTEGER PRIMARY KEY,flag BOOLEAN);INSERT INTO caller VALUES(1,1)');
      const caller = await turbineBetterSqlite3(raw, introspectBetterSqlite3Database(raw), { logger: {} });
      assert.deepEqual(await caller.table('caller').findMany(), [{ id: 1, flag: true }]);
      await caller.disconnect();
      assert.equal(raw.open, true);
      raw.exec('BEGIN');
      await assert.rejects(caller.table('caller').findMany(), /caller-owned transaction/);
      raw.exec('ROLLBACK');
      const conn = await caller.pool.connect(),
        iterator = conn.streamBatches('SELECT id FROM caller', [], 1);
      await iterator.next();
      await caller.pool.end();
      assert.equal(raw.open, false);
      await assert.rejects(iterator.next(), /closed/);
      conn.release();
    } finally {
      if (raw.open) raw.close();
    }
    checked.push('caller ownership, external transaction refusal and close during active iterator');
    // A path-owned handle opts unwrapped statements into array results. A
    // proxied statement must keep its own all() and object rows.
    const prepare = Better.prototype.prepare;
    let ownedRaw;
    let owned;
    try {
      Better.prototype.prepare = function (sql) {
        ownedRaw = this;
        return prepare.call(this, sql);
      };
      owned = await turbineBetterSqlite3(':memory:', schema, { logger: {} });
      await owned.rawUnsafe('SELECT 1 AS warm');
    } finally {
      Better.prototype.prepare = prepare;
    }
    try {
      assert.ok(ownedRaw instanceof Better, 'the factory opened its handle with the installed peer');
      const nativePrepare = ownedRaw.prepare.bind(ownedRaw);
      let calls = 0;
      ownedRaw.prepare = (sql) => {
        const target = nativePrepare(sql);
        if (!sql.includes('wrapped-result')) return target;
        return new Proxy(target, {
          get(statement, key) {
            if (key === 'all')
              return (...params) => {
                calls++;
                if (Number(process.versions.node.split('.')[0]) >= 22) statement.raw(false);
                const rows = statement.all(...params);
                // Node 20's alias repair reads arrays even through compatible statements.
                return rows.map((row) => (Array.isArray(row) ? [Number(row[0]) + 1] : { v: Number(row.v) + 1 }));
              };
            const value = Reflect.get(statement, key, statement);
            return typeof value === 'function' ? value.bind(statement) : value;
          },
        });
      };
      assert.deepEqual(await owned.rawUnsafe('SELECT 41 AS v /* wrapped-result */'), [{ v: 42 }]);
      assert.equal(calls, 1);
    } finally {
      await owned?.disconnect();
    }
    assert.equal(ownedRaw.open, false);
    checked.push('path-owned proxied native statements keep their own object rows');
    // Generated bulk inserts bind positionally only on a path-owned handle,
    // where nothing outside this package can observe the peer's statements:
    // the peer then prepares the ? spelling. A caller-supplied handle keeps
    // the generated :pN text. Both write and return identical rows.
    const bulkDDL =
      'CREATE TABLE items(id INTEGER PRIMARY KEY,tenant INTEGER,active INTEGER,prefs TEXT,at TIMESTAMP,huge INTEGER,bytes BLOB,precise REAL)';
    const bulkData = [
      { id: 1, tenant: 7 },
      { id: 2, tenant: 8 },
      { id: 3, tenant: 7 },
    ];
    const bulkTexts = [];
    const bulkPrepare = Better.prototype.prepare;
    let bulkOwnedRows;
    let bulkSuppliedRows;
    try {
      Better.prototype.prepare = function (sql) {
        if (sql.startsWith('INSERT INTO "items"')) bulkTexts.push(sql);
        return bulkPrepare.call(this, sql);
      };
      const bulkOwned = await turbineBetterSqlite3(':memory:', schema, { logger: {} });
      try {
        await bulkOwned.rawUnsafe(bulkDDL);
        bulkOwnedRows = await bulkOwned.table('items').createMany({ data: bulkData });
      } finally {
        await bulkOwned.disconnect();
      }
      const bulkOwnedTexts = bulkTexts.splice(0, bulkTexts.length);
      assert.ok(bulkOwnedTexts.length >= 1, 'owned bulk insert reached the peer');
      for (const sql of bulkOwnedTexts) {
        assert.match(sql, /VALUES \(\?,/, 'owned handle prepares the positional spelling');
        assert.doesNotMatch(sql, /:p1\b/, 'owned handle never sees named bulk placeholders');
      }
      const bulkRaw = new Better(':memory:');
      try {
        const bulkSupplied = await turbineBetterSqlite3(bulkRaw, schema, { logger: {} });
        try {
          await bulkSupplied.rawUnsafe(bulkDDL);
          bulkSuppliedRows = await bulkSupplied.table('items').createMany({ data: bulkData });
        } finally {
          await bulkSupplied.disconnect();
          await bulkSupplied.pool.end();
        }
      } finally {
        if (bulkRaw.open) bulkRaw.close();
      }
      assert.ok(bulkTexts.length >= 1, 'supplied bulk insert reached the peer');
      for (const sql of bulkTexts) assert.match(sql, /VALUES \(:p1,/, 'supplied handle keeps the named spelling');
    } finally {
      Better.prototype.prepare = bulkPrepare;
    }
    assert.deepEqual(bulkSuppliedRows, bulkOwnedRows);
    assert.deepEqual(
      bulkOwnedRows.map((r) => [r.id, r.tenant]),
      bulkData.map((r) => [r.id, r.tenant]),
    );
    checked.push('generated bulk inserts bind positionally on owned handles and by name on supplied ones');
    const negative = await turbineBetterSqlite3(':memory:', schema, { logger: {} });
    await negative.disconnect();
    await assert.rejects(negative.table('items').findMany(), /disconnected|closed/);
    assert.equal(betterSqlite3Dialect.introspector, undefined);
    checked.push('path ownership and explicit missing native introspector');
  } finally {
    await db.disconnect();
    assert.equal(db.pool.db.isOpen, false);
    // Reopening proves the file's writes survived close with the native FULL policy.
    const reopened = new Better(file);
    if (populated) assert.equal(reopened.prepare('SELECT count(*) n FROM items').get().n, 1001);
    reopened.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
  }
}
const report = {
  node: process.version,
  executable: process.execPath,
  format,
  checked,
  checks: checked.length,
  sqliteVersion,
  nativePeer: format.startsWith('missing') ? null : require('better-sqlite3/package.json').version,
  consumer: process.cwd(),
  entrySha256: createHash('sha256')
    .update(readFileSync(entry ?? require.resolve('turbine-orm/better-sqlite3')))
    .digest('hex'),
  passed: true,
};
writeFileSync(join(process.cwd(), `sqlite-binding-${format}.json`), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
