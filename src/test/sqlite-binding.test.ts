/** Native optional binding contracts, independent of the default SQLite driver. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  type BetterSqlite3Database,
  introspectBetterSqlite3Database,
  turbineBetterSqlite3,
} from '../better-sqlite3.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';

const require = createRequire(import.meta.url);
const peer = (() => {
  try {
    return require(process.env.TURBINE_SQLITE_BINDING_PEER ?? 'better-sqlite3') as new (
      path: string,
    ) => BetterSqlite3Database;
  } catch (error) {
    if (process.env.TURBINE_REQUIRE_SQLITE_BINDING === '1') throw error;
    return undefined;
  }
})();
const metadata = schemaDefToMetadata(
  defineSchema({
    items: {
      id: { type: 'integer', primaryKey: true },
      tenant: { type: 'integer' },
      active: { type: 'boolean' },
      prefs: { type: 'json' },
      at: { type: 'timestamp' },
      huge: { type: 'bigint' },
      bytes: { type: 'bytea' },
    },
  }),
);
async function fixture() {
  const raw = new peer!(':memory:');
  raw.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE items(id INTEGER PRIMARY KEY,tenant INTEGER,active INTEGER,prefs TEXT,at TIMESTAMP,huge INTEGER,bytes BLOB);
    INSERT INTO items VALUES(1,1,1,'{"n":1}','2024-02-03 04:05:06',9007199254740993,x'00ff'),
      (2,2,0,'[false,null]','2024-02-03 04:05:06',-9007199254740993,x''),
      (3,1,NULL,NULL,NULL,9007199254740991,NULL)`);
  const db = await turbineBetterSqlite3(raw, metadata, { logger: {}, busyTimeoutMs: 30 });
  return {
    raw,
    db,
    close: async () => {
      await db.disconnect();
      await db.pool.end();
    },
  };
}

describe('optional SQLite binding', { skip: !peer && 'optional better-sqlite3 native peer is not installed' }, () => {
  it('introspects main views on request with filters, JSON decoding and write refusals', async () => {
    const raw = new peer!(':memory:');
    let db: Awaited<ReturnType<typeof turbineBetterSqlite3>> | undefined;
    try {
      raw.exec(readFileSync(new URL('./fixtures/sqlite-view-readonly.sql', import.meta.url), 'utf8'));
      raw.exec(`CREATE TEMP VIEW temp_views AS SELECT 1;
        ATTACH ':memory:' AS side; CREATE VIEW side.attached_views AS SELECT 2;
        CREATE TRIGGER view_write INSTEAD OF INSERT ON record_views
        BEGIN INSERT INTO records(id,label) VALUES(NEW.id,NEW.label); END;`);
      const tables = introspectBetterSqlite3Database(raw);
      assert.equal(tables.tables.record_views, undefined);
      assert.deepEqual(introspectBetterSqlite3Database(raw, { includeViews: false, logger: {} }), tables);
      const schema = introspectBetterSqlite3Database(raw, {
        includeViews: true,
        include: ['record_views', 'nested_views', 'temp_views', 'attached_views'],
        exclude: ['nested_views'],
        logger: {},
      });
      assert.deepEqual(Object.keys(schema.tables), ['record_views']);
      const view = schema.tables.record_views!;
      assert.equal(view.isView, true);
      assert.deepEqual(view.primaryKey, []);
      assert.deepEqual(view.uniqueColumns, []);
      assert.deepEqual(view.indexes, []);
      assert.deepEqual(Object.keys(view.relations), []);
      db = await turbineBetterSqlite3(raw, schema, { logger: {} });
      const rows = await db.table('record_views').findMany();
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0]!.payload, { nested: [true, null] });
      assert.equal(rows[0]!.active, true);
      const connection = await db.pool.connect();
      try {
        const streamed = [];
        for await (const batch of connection.streamBatches!('SELECT payload FROM record_views', [], 1))
          streamed.push(...batch);
        assert.deepEqual(streamed, [{ payload: { nested: [true, null] } }]);
      } finally {
        connection.release();
      }
      for (const write of [
        () => db!.table('record_views').create({ data: { id: 2, label: 'refused' } }),
        () => db!.table('record_views').update({ where: { id: 1 }, data: { label: 'refused' } }),
        () =>
          db!
            .table('record_views')
            .upsert({ where: { id: 1 }, create: { label: 'refused' }, update: { label: 'refused' } }),
        () => db!.table('record_views').delete({ where: { id: 1 } }),
      ])
        await assert.rejects(write, (error: unknown) => {
          assert.equal((error as { code: string }).code, 'TURBINE_E003');
          assert.match(String(error), /view \(read-only\)/);
          return true;
        });
      assert.equal(raw.inTransaction, false);
      assert.equal(raw.prepare('SELECT count(*) AS n FROM records').get()!.n, 1);
    } finally {
      await db?.disconnect();
      assert.equal(raw.open, true);
      raw.close();
    }
  });

  // A path-owned handle (array-capable statements) is checked by the installed
  // consumer, fixtures/sqlite-binding-consumer.mjs: the factory loads the peer by
  // its bare name, which resolves there as in an application, not from this repo.
  it('keeps proxied native statements on their object-row path', async () => {
    const raw = new peer!(':memory:');
    let db: Awaited<ReturnType<typeof turbineBetterSqlite3>> | undefined;
    try {
      db = await turbineBetterSqlite3(raw, metadata, { logger: {} });
      await db.rawUnsafe('SELECT 1 AS warm');
      const nativePrepare = raw.prepare.bind(raw);
      let calls = 0;
      raw.prepare = (sql) => {
        const target = nativePrepare(sql);
        if (!sql.includes('wrapped-result')) return target;
        return new Proxy(target, {
          get(statement, key) {
            if (key === 'all')
              return (...params: unknown[]) => {
                calls++;
                if (Number(process.versions.node.split('.')[0]) >= 22) statement.raw(false);
                const rows = statement.all(...params);
                // Retain the native mode on Node 20, whose existing alias
                // repair reads arrays even through compatible statements.
                return rows.map((row) => (Array.isArray(row) ? [Number(row[0]) + 1] : { v: Number(row.v) + 1 }));
              };
            const value = Reflect.get(statement, key, statement);
            return typeof value === 'function' ? value.bind(statement) : value;
          },
        });
      };
      assert.deepEqual(await db.rawUnsafe('SELECT 41 AS v /* wrapped-result */'), [{ v: 42 }]);
      assert.equal(calls, 1);
    } finally {
      await db?.disconnect();
      if (raw.open) raw.close();
    }
  });
  it('returns exact values/prototypes through typed, raw, list, aliases and RETURNING routes', async () => {
    const f = await fixture();
    try {
      const expected = [
        {
          id: 1,
          tenant: 1,
          active: true,
          prefs: { n: 1 },
          at: new Date('2024-02-03T04:05:06Z'),
          huge: '9007199254740993',
          bytes: Uint8Array.of(0, 255),
        },
        {
          id: 2,
          tenant: 2,
          active: false,
          prefs: [false, null],
          at: new Date('2024-02-03T04:05:06Z'),
          huge: '-9007199254740993',
          bytes: new Uint8Array(),
        },
        { id: 3, tenant: 1, active: null, prefs: null, at: null, huge: 9007199254740991, bytes: null },
      ];
      const q = f.db.table('items');
      const rows = await q.findMany({ orderBy: { id: 'asc' } });
      assert.deepEqual(rows, expected);
      assert.ok(rows.every((row) => Object.getPrototypeOf(row) === Object.prototype));
      assert.deepEqual(
        await q.findMany({ where: { id: { in: [2, 1] } }, orderBy: { id: 'asc' } }),
        expected.slice(0, 2),
      );
      assert.deepEqual(await f.db.rawUnsafe('SELECT $2 AS second,$1 AS first', 7, 'changed'), [
        { second: 'changed', first: 7 },
      ]);
      assert.deepEqual(await f.db.rawUnsafe('SELECT $2 AS second,$1 AS first'), [{ second: null, first: null }]);
      assert.deepEqual(await f.db.rawUnsafe('SELECT ? AS value'), [{ value: null }]);
      assert.deepEqual(await f.db.rawUnsafe('SELECT ?2 AS value,? AS later'), [{ value: null, later: null }]);
      assert.deepEqual(await f.db.rawUnsafe('SELECT :p1 AS value'), [{ value: null }]);
      await assert.rejects(f.db.rawUnsafe('SELECT 1 AS value', 7), /Unknown SQLite binding/);
      await assert.rejects(f.db.rawUnsafe("SELECT ':p1' AS value", 7), /Unknown SQLite binding/);
      await assert.rejects(f.db.rawUnsafe('SELECT $2 AS value', 7), /names no value/);
      assert.deepEqual(
        await f.db.rawUnsafe(
          'SELECT prefs AS "__proto__",active AS "2",huge AS "10",id AS duplicate,tenant AS duplicate FROM items WHERE id=$1',
          1,
        ),
        [{ ['__proto__']: { n: 1 }, '2': true, '10': '9007199254740993', duplicate: 1 }],
      );
      assert.deepEqual(await q.update({ where: { id: 1 }, data: { active: false, prefs: { changed: true } } }), {
        ...expected[0],
        active: false,
        prefs: { changed: true },
      });
      assert.deepEqual(introspectBetterSqlite3Database(f.raw).tables.items!.allColumns, [
        'id',
        'tenant',
        'active',
        'prefs',
        'at',
        'huge',
        'bytes',
      ]);
      await assert.rejects(f.db.rawUnsafe('UPDATE items SET tenant=9; DELETE FROM items'));
      assert.equal((await q.findMany()).length, 3);
      await assert.rejects(
        q.create({ data: { id: 1, tenant: 1 } }),
        (e) => !!e && typeof e === 'object' && 'code' in e && e.code === 'TURBINE_E008',
      );
      await assert.rejects(f.db.rawUnsafe('SELECT * FROM missing_items'), /TURBINE_E003/);
      assert.deepEqual(await f.db.rawUnsafe("UPDATE items SET prefs='returning' WHERE id=3"), []);
      assert.equal((await q.findUnique({ where: { id: 3 } }))!.prefs, 'returning');
      assert.deepEqual(
        await f.db.rawUnsafe(
          'WITH chosen AS (SELECT 3 AS id) UPDATE items SET tenant=8 WHERE id IN (SELECT id FROM chosen)',
        ),
        [],
      );
      assert.equal((await q.findUnique({ where: { id: 3 } }))!.tenant, 8);
      const c = await f.db.pool.connect();
      try {
        const iterator = c.streamBatches!("UPDATE items SET prefs='stepped' WHERE id=3", [], 1);
        assert.equal((await q.findUnique({ where: { id: 3 } }))!.prefs, 'returning', 'rowless stepping stays lazy');
        assert.equal((await iterator.next()).done, true);
        assert.equal((await q.findUnique({ where: { id: 3 } }))!.prefs, 'stepped');
      } finally {
        c.release();
      }
    } finally {
      await f.close();
    }
  });
  it('keeps omitted native named parameters NULL in reads, writes and streams', async () => {
    const f = await fixture();
    try {
      for (const name of [':foo', '@foo', '$foo', ':_name', ':é', '$1abc', ':__proto__']) {
        assert.deepEqual(await f.db.rawUnsafe(`SELECT ${name} AS value,${name} AS repeated`), [
          { value: null, repeated: null },
        ]);
        assert.deepEqual(await f.db.rawUnsafe(`SELECT :p1 AS supplied,${name} AS omitted`, 7), [
          { supplied: 7, omitted: null },
        ]);
      }
      assert.deepEqual(await f.db.rawUnsafe('SELECT :foo AS a,@foo AS b,$foo AS c,?3 AS same,? AS anonymous'), [
        { a: null, b: null, c: null, same: null, anonymous: null },
      ]);
      assert.deepEqual(
        await f.db.rawUnsafe("SELECT ':ignored' AS literal,:foo AS value /* @ignored */ -- $ignored\n"),
        [{ literal: ':ignored', value: null }],
      );
      await assert.rejects(f.db.rawUnsafe("SELECT ':p1' AS literal,:foo AS value", 7), /Unknown SQLite binding/);
      await assert.rejects(f.db.rawUnsafe('SELECT :p1 AS a,@p1 AS b', 7), /Conflicting SQLite parameter prefixes/);
      await f.db.rawUnsafe('INSERT INTO items(id,tenant) VALUES(:p1,:omitted)', 4);
      assert.equal((await f.db.table('items').findUnique({ where: { id: 4 } }))!.tenant, null);
      const connection = await f.db.pool.connect();
      try {
        const batches = [];
        for await (const batch of connection.streamBatches!('SELECT @foo AS value', [], 1)) batches.push(batch);
        assert.deepEqual(batches, [[{ value: null }]]);
      } finally {
        connection.release();
      }
    } finally {
      await f.close();
    }
  });
  it('does not retain column types across native view replacement or rollback', async () => {
    const f = await fixture();
    try {
      f.raw.exec('CREATE VIEW changing AS SELECT id,active AS value FROM items');
      // Schema declares items.active BOOLEAN even though native DDL uses INTEGER.
      const query = 'SELECT value FROM changing ORDER BY id';
      assert.deepEqual(await f.db.rawUnsafe(query), [{ value: true }, { value: false }, { value: null }]);
      const connection = await f.db.pool.connect();
      try {
        await connection.query('SAVEPOINT shape');
        f.raw.exec('DROP VIEW changing; CREATE VIEW changing AS SELECT id,tenant AS value FROM items');
        assert.deepEqual((await connection.query(query)).rows, [{ value: 1 }, { value: 2 }, { value: 1 }]);
        await connection.query('ROLLBACK TO shape');
        await connection.query('RELEASE shape');
        assert.deepEqual(await f.db.rawUnsafe(query), [{ value: true }, { value: false }, { value: null }]);
      } finally {
        connection.release();
      }
      f.raw.exec('ALTER TABLE items ADD COLUMN extra TEXT');
      assert.ok(Object.hasOwn((await f.db.rawUnsafe('SELECT * FROM items'))[0]!, 'extra'));
    } finally {
      await f.close();
    }
  });
  it('preserves result-column prototype names through complete reads and native streams', async () => {
    const f = await fixture();
    try {
      const sql = 'SELECT prefs AS "__proto__",id FROM items ORDER BY id';
      const expected = [
        { ['__proto__']: { n: 1 }, id: 1 },
        { ['__proto__']: [false, null], id: 2 },
        { ['__proto__']: null, id: 3 },
      ];
      assert.deepEqual(await f.db.rawUnsafe(sql), expected);
      const connection = await f.db.pool.connect();
      try {
        const rows: Record<string, unknown>[] = [];
        for await (const batch of connection.streamBatches!(sql, [], 1)) rows.push(...batch);
        assert.deepEqual(rows, expected);
        assert.ok(rows.every((row) => Object.hasOwn(row, '__proto__')));
      } finally {
        connection.release();
      }
    } finally {
      await f.close();
    }
  });
  it('keeps transaction rollback, outsider isolation, callback ownership and released checkout guarantees', async () => {
    const f = await fixture();
    try {
      let enter!: () => void, finish!: () => void;
      const entered = new Promise<void>((r) => {
          enter = r;
        }),
        gate = new Promise<void>((r) => {
          finish = r;
        });
      const rollback = new Error('rollback sentinel');
      const tx = f.db.$transaction(async (t) => {
        await t.table('items').update({ where: { id: 1 }, data: { tenant: 9 } });
        enter();
        await gate;
        throw rollback;
      });
      const rejected = assert.rejects(tx, (e) => e === rollback);
      await entered;
      let settled = false;
      const outside = f.db
        .table('items')
        .findUnique({ where: { id: 1 } })
        .then((r) => {
          settled = true;
          return r;
        });
      await delay(5);
      assert.equal(settled, false);
      finish();
      await rejected;
      assert.equal((await outside)!.tenant, 1);
      await f.db.$transaction(async (t) => {
        await t.table('items').findUnique({ where: { id: 1 } });
        await assert.rejects(f.db.table('items').findMany(), /tx.*client|transaction/i);
      });
      f.raw.exec('BEGIN');
      await assert.rejects(f.db.table('items').findMany(), /caller-owned transaction/);
      f.raw.exec('ROLLBACK');
      const c = await f.db.pool.connect();
      await c.query('BEGIN');
      await c.query('UPDATE items SET tenant=8 WHERE id=1');
      c.release();
      assert.equal(f.raw.inTransaction, false);
      assert.equal((await f.db.table('items').findUnique({ where: { id: 1 } }))!.tenant, 1);
      await assert.rejects(c.query('SELECT 1'), /released/);
      await f.db.disconnect();
      assert.equal(f.raw.open, true, 'supplied handle remains caller owned');
    } finally {
      await f.close();
    }
  });
  it('preserves complete bulk returning and atomic rollback on constraint failure', async () => {
    const f = await fixture();
    try {
      const data = Array.from({ length: 1000 }, (_, i) => ({
        id: i + 10,
        tenant: i % 3,
        active: i % 2 === 0,
        prefs: { i },
        at: new Date('2024-01-01T00:00:00Z'),
        huge: '9007199254740993',
        bytes: Uint8Array.of(i % 256),
      }));
      const rows = await f.db.table('items').createMany({ data });
      assert.equal(rows.length, 1000);
      assert.deepEqual(rows, data);
      await assert.rejects(
        f.db.table('items').createMany({
          data: [
            { id: 5000, tenant: 1 },
            { id: 1, tenant: 9 },
          ],
        }),
      );
      assert.equal(await f.db.table('items').findUnique({ where: { id: 5000 } }), null);
      const filtered = await turbineBetterSqlite3(f.raw, metadata, {
        logger: {},
        globalFilters: { items: { tenant: 1 } },
      });
      try {
        const only = await filtered.table('items').findMany();
        assert.ok(only.length > 0);
        assert.ok(only.every((r) => r.tenant === 1));
        await assert.rejects(filtered.table('items').findMany({ where: { tenant: { hasKey: 'x' } } } as never));
      } finally {
        await filtered.disconnect();
      }
    } finally {
      await f.close();
    }
  });
  it('steps bounded native batches, releases on return/abort, and closes during suspended work', async () => {
    const f = await fixture();
    let steps = 0,
      returns = 0,
      all = 0;
    // Observe actual peer methods without implementing a mock stepping engine.
    const raw = f.raw as BetterSqlite3Database & { function(name: string, fn: (n: number) => number): unknown };
    raw.function('observed', (n) => {
      steps++;
      return n;
    });
    raw.exec('CREATE VIEW observed_items AS SELECT observed(id) AS id FROM items');
    const prepare = raw.prepare.bind(raw);
    raw.prepare = (sql) => {
      const stmt = prepare(sql);
      if (sql.includes('observed_items')) {
        const iterate = stmt.iterate.bind(stmt),
          materialize = stmt.all.bind(stmt);
        stmt.all = (...p) => {
          all++;
          return materialize(...p);
        };
        stmt.iterate = (...p) => {
          const i = iterate(...p),
            end = i.return!.bind(i);
          i.return = () => {
            returns++;
            return end();
          };
          return i;
        };
      }
      return stmt;
    };
    try {
      const connection = await f.db.pool.connect();
      const iterator = connection.streamBatches!('SELECT id FROM observed_items', [], 1);
      assert.deepEqual((await iterator.next()).value, [{ id: 1 }]);
      assert.equal(steps, 1);
      assert.equal(all, 0);
      await iterator.return();
      assert.equal(returns, 1);
      connection.release();
      const abort = new AbortController(),
        reason = { cancel: 'native boundary' };
      const stream = f.db.table('items').findManyStream({ orderBy: { id: 'asc' }, batchSize: 1, signal: abort.signal });
      assert.equal((await stream.next()).value!.id, 1);
      abort.abort(reason);
      await assert.rejects(stream.next(), (e) => e === reason);
      assert.equal((await f.db.table('items').findMany()).length, 3);
      const held = await f.db.pool.connect(),
        pending = held.streamBatches!('SELECT id FROM items', [], 1);
      await pending.next();
      await f.db.pool.end();
      assert.equal(raw.open, false);
      await assert.rejects(pending.next(), /closed/);
      held.release();
    } finally {
      await f.close();
    }
  });
});
