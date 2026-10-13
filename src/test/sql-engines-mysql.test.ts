/**
 * turbine-orm/mysql against a real MySQL 8+ server: data errors, fractional
 * seconds, and typed JSON path equality.
 *
 * Gated on MYSQL_URL / MYSQL_TEST_URL (the database in the URL is used; the
 * tables here are prefixed `sqle_` and dropped afterwards).
 *
 * Run: MYSQL_URL=mysql://root@127.0.0.1:3306/<db> npx tsx --test src/test/sql-engines-mysql.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TurbineClient } from '../client.js';
import { TurbineError, UnsupportedFeatureError, ValidationError } from '../errors.js';
import { mssqlDialect } from '../mssql.js';
import { introspectMysqlWith, type MysqlPool, mysqlDialect, turbineMysql } from '../mysql.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable, skipGate } from './helpers.js';

const MYSQL_URL = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const gate = skipGate(!MYSQL_URL, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a MySQL 8 server');

const TABLES = ['sqle_events', 'sqle_docs', 'sqle_owners'];
const DDL = [
  `CREATE TABLE sqle_owners (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(5) NOT NULL,
    n INT,
    seen_at DATETIME(3),
    meta JSON
  )`,
  `CREATE TABLE sqle_events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    owner_id INT NOT NULL,
    at DATETIME(3) NOT NULL,
    stamped TIMESTAMP(3) NULL,
    CONSTRAINT fk_sqle_events_owner FOREIGN KEY (owner_id) REFERENCES sqle_owners(id)
  )`,
  `CREATE TABLE sqle_docs (
    id INT PRIMARY KEY,
    meta JSON
  )`,
];

// MySQL has no fractional seconds unless the column declares them; these
// instants each sit one millisecond before a rounding boundary.
const INSTANTS = ['1999-12-31T23:59:59.999Z', '2026-03-08T06:59:59.999Z', '2026-03-29T01:30:00.123Z'].map(
  (s) => new Date(s),
);

const DOCS: [number, unknown][] = [
  [1, { a: 5 }],
  [2, { a: '5' }],
  [3, { a: true }],
  [4, { a: 1 }],
  [5, { a: null }],
  [6, { a: [1, 2] }],
  [7, { a: { k: 1, j: 'x' } }],
  [8, {}],
  [9, { a: 5.0, b: { c: 'Deep' } }],
  [10, { a: 'five', b: { c: 'deep' } }],
];

describe('turbine-orm/mysql, engine correctness (real MySQL)', () => {
  let db: TurbineClient;
  let pool: MysqlPool;

  const ids = async (where: Record<string, unknown>): Promise<number[]> => {
    const rows = (await db.table('sqle_docs').findMany({ where, orderBy: { id: 'asc' } })) as { id: number }[];
    return rows.map((r) => r.id);
  };

  /** The error `fn` threw, or a failure if it threw nothing. */
  const thrown = async (fn: () => Promise<unknown>): Promise<unknown> => {
    try {
      await fn();
    } catch (err) {
      return err;
    }
    assert.fail('expected the operation to throw');
  };

  gate.before(async () => {
    const probe = await turbineMysql(MYSQL_URL, { tables: {}, enums: {} });
    pool = (probe as unknown as { pool: MysqlPool }).pool;
    for (const t of TABLES) await pool.query(`DROP TABLE IF EXISTS ${t}`);
    for (const stmt of DDL) await pool.query(stmt);
    const dbName = new URL(MYSQL_URL).pathname.replace(/^\//, '');
    const schema: SchemaMetadata = await introspectMysqlWith(
      async (sql, params) => (await pool.query(sql, params)).rows,
      dbName,
      { include: TABLES },
    );
    await probe.disconnect();
    db = await turbineMysql(MYSQL_URL, schema, { warnOnUnlimited: false });
    pool = (db as unknown as { pool: MysqlPool }).pool;
    for (const [id, meta] of DOCS) {
      await pool.query('INSERT INTO sqle_docs (id, meta) VALUES (:p1, CAST(:p2 AS JSON))', [id, JSON.stringify(meta)]);
    }
  });

  gate.after(async () => {
    if (!MYSQL_URL) return;
    for (const t of TABLES) await pool.query(`DROP TABLE IF EXISTS ${t}`);
    await db.disconnect();
  });

  describe('data exceptions are typed ValidationErrors naming the column', () => {
    const cases: [string, Record<string, unknown>, string, string][] = [
      ['a string longer than the column', { name: 'toolongvalue' }, 'name', '22001'],
      ['a number out of the column range', { name: 'a', n: 3_000_000_000 }, 'n', '22003'],
      ['a string that is not an integer', { name: 'a', n: 'abc' }, 'n', '22P02'],
      ['a string that is not a datetime', { name: 'a', seenAt: 'not a date' }, 'seen_at', '22007'],
      ['text that is not JSON', { name: 'a', meta: 'not json' }, 'meta', '22032'],
    ];
    for (const [label, data, column, sqlstate] of cases) {
      gate.it(label, async () => {
        const err = await thrown(() => db.table('sqle_owners').create({ data }));
        assert.ok(err instanceof ValidationError, `expected ValidationError, got ${(err as Error)?.constructor?.name}`);
        assert.equal((err as ValidationError).code, 'TURBINE_E003');
        assert.equal((err as ValidationError).column, column);
        assert.equal((err as ValidationError).sqlstate, sqlstate);
      });
    }

    gate.it('the bad value stays out of the message in safe mode', async () => {
      const err = await thrown(() => db.table('sqle_owners').create({ data: { name: 'a', n: 'secret-ish' } }));
      assert.ok(err instanceof ValidationError);
      assert.doesNotMatch((err as Error).message, /secret-ish/);
    });

    gate.it('division by zero in an atomic update, inside a transaction', async () => {
      const owner = (await db.table('sqle_owners').create({ data: { name: 'div', n: 4 } })) as { id: number };
      const err = await thrown(() =>
        db.$transaction((tx) =>
          tx.table('sqle_owners').update({ where: { id: owner.id }, data: { n: { divide: 0 } } }),
        ),
      );
      assert.ok(err instanceof ValidationError, `got ${(err as Error)?.constructor?.name}`);
      assert.equal((err as ValidationError).sqlstate, '22012');
    });

    gate.it('NaN, Infinity and an Invalid Date are refused before the server sees them', async () => {
      for (const data of [
        { name: 'a', n: Number.NaN },
        { name: 'a', n: Infinity },
        { name: 'a', seenAt: new Date('x') },
      ]) {
        const err = await thrown(() => db.table('sqle_owners').create({ data }));
        assert.ok(
          err instanceof ValidationError,
          `got ${(err as Error)?.constructor?.name} for ${String(Object.values(data)[1])}`,
        );
      }
      // NaN used to be stored as 0 without an error.
      assert.equal(await db.table('sqle_owners').count({ where: { n: 0 } }), 0);
    });

    gate.it('every one of them is a TurbineError', async () => {
      for (const [, data] of cases) {
        const err = await thrown(() => db.table('sqle_owners').create({ data }));
        assert.ok(err instanceof TurbineError);
      }
    });
  });

  describe('DATETIME(3) / TIMESTAMP(3) keep milliseconds on every read path', () => {
    gate.it('create, top-level read, join and batched relations, equality, aggregate', async () => {
      const owner = (await db.table('sqle_owners').create({ data: { name: 'ms', seenAt: INSTANTS[0] } })) as {
        id: number;
        seenAt: Date;
      };
      assert.equal(owner.seenAt.toISOString(), INSTANTS[0]!.toISOString(), 'create returned a rounded instant');
      for (const at of INSTANTS) {
        const ev = (await db.table('sqle_events').create({ data: { ownerId: owner.id, at, stamped: at } })) as {
          at: Date;
          stamped: Date;
        };
        assert.equal(ev.at.toISOString(), at.toISOString());
        assert.equal(ev.stamped.toISOString(), at.toISOString());
      }
      const expected = INSTANTS.map((d) => d.toISOString());
      const top = (await db.table('sqle_events').findMany({ orderBy: { id: 'asc' } })) as { at: Date; stamped: Date }[];
      assert.deepEqual(
        top.map((r) => r.at.toISOString()),
        expected,
      );
      assert.deepEqual(
        top.map((r) => r.stamped.toISOString()),
        expected,
      );
      for (const strategy of ['join', 'batched'] as const) {
        const [o] = (await db.table('sqle_owners').findMany({
          where: { id: owner.id },
          with: { sqleEvents: { orderBy: { id: 'asc' } } },
          relationLoadStrategy: strategy,
        })) as { sqleEvents: { at: Date | string; stamped: Date | string }[] }[];
        assert.deepEqual(
          o!.sqleEvents.map((e) => new Date(e.at).toISOString()),
          expected,
          `${strategy}: nested DATETIME(3)`,
        );
        assert.deepEqual(
          o!.sqleEvents.map((e) => new Date(e.stamped).toISOString()),
          expected,
          `${strategy}: nested TIMESTAMP(3)`,
        );
      }
      assert.equal(await db.table('sqle_events').count({ where: { at: INSTANTS[0] } }), 1, 'exact equality');
      assert.equal(
        await db.table('sqle_events').count({ where: { at: { gte: new Date('2000-01-01T00:00:00Z') } } }),
        2,
      );
      const agg = (await db.table('sqle_events').aggregate({ _min: { at: true } })) as { _min: { at: Date } };
      assert.equal(new Date(agg._min.at).toISOString(), INSTANTS[0]!.toISOString());
    });
  });

  describe('JSON path equals compares JSON values, not their text', () => {
    const shapes: [string, unknown, number[]][] = [
      ['a number', 5, [1, 9]],
      ['a numeric string', '5', [2]],
      ['true', true, [3]],
      ['the number 1', 1, [4]],
      ['null', null, [5]],
      ['an array', [1, 2], [6]],
      ['an object, keys in another order', { j: 'x', k: 1 }, [7]],
      ['a string', 'five', [10]],
    ];
    for (const [label, equals, expected] of shapes) {
      gate.it(label, async () => {
        assert.deepEqual(await ids({ meta: { path: ['a'], equals } }), expected);
      });
    }

    gate.it('a nested path compares case-sensitively', async () => {
      assert.deepEqual(await ids({ meta: { path: ['b', 'c'], equals: 'deep' } }), [10]);
    });

    gate.it('a warm template binds the next call by its own value', async () => {
      // Same shape, so the second and third calls reuse the cached SQL text.
      assert.deepEqual(await ids({ meta: { path: ['a'], equals: '5' } }), [2]);
      assert.deepEqual(await ids({ meta: { path: ['a'], equals: 5 } }), [1, 9]);
      assert.deepEqual(await ids({ meta: { path: ['a'], equals: [1, 2] } }), [6]);
    });
  });
});

describe('MySQL and SQL Server JSON path equals, build-only', () => {
  const schema: SchemaMetadata = {
    tables: {
      docs: mockTable('docs', [
        { name: 'id', field: 'id', pgType: 'int4' },
        { name: 'meta', field: 'meta', pgType: 'json' },
      ]),
    },
    enums: {},
  };

  it('the SQL text is the same for every operand type, and the params carry the type', () => {
    for (const dialect of [mysqlDialect, mssqlDialect]) {
      const q = makeQuery('docs', schema, { dialect });
      const builds = [5, '5', true, null].map((equals) =>
        q.buildFindMany({ where: { meta: { path: ['a', 'b'], equals } } } as never),
      );
      for (const b of builds) assert.equal(b.sql, builds[0]!.sql, dialect.name);
      assert.notDeepEqual(builds[0]!.params, builds[1]!.params, dialect.name);
    }
  });

  it('MySQL binds the operand as JSON text', () => {
    const q = makeQuery('docs', schema, { dialect: mysqlDialect });
    const built = q.buildFindMany({ where: { meta: { path: ['a'], equals: [1, 2] } } } as never);
    assert.match(built.sql, /JSON_EXTRACT\(`meta`, :p1\) = CAST\(:p2 AS JSON\)/);
    assert.deepEqual(built.params.slice(0, 2), ['$."a"', '[1,2]']);
    const str = q.buildFindMany({ where: { meta: { path: ['a'], equals: '5' } } } as never);
    assert.equal(str.params[1], '"5"');
  });

  it('SQL Server reads the type under the parent path and binds parent, key, type and text', () => {
    const q = makeQuery('docs', schema, { dialect: mssqlDialect });
    const built = q.buildFindMany({ where: { meta: { path: ['a', 'b'], equals: 5 } } } as never);
    assert.match(built.sql, /OPENJSON\(\[meta\], @p2\) AS \[jpe\]/);
    assert.match(built.sql, /COLLATE Latin1_General_BIN2/);
    assert.deepEqual(built.params.slice(0, 5), ['$."a"."b"', '$."a"', 'b', 2, '5']);
    const nul = q.buildFindMany({ where: { meta: { path: [0], equals: null } } } as never);
    assert.deepEqual(nul.params.slice(0, 5), ['$[0]', '$', '0', 0, null]);
  });

  it('SQL Server refuses arrays, objects and an empty path (E017)', () => {
    const q = makeQuery('docs', schema, { dialect: mssqlDialect });
    for (const where of [
      { meta: { path: ['a'], equals: [1] } },
      { meta: { path: ['a'], equals: { a: 1 } } },
      { meta: { path: [], equals: 1 } },
    ]) {
      assert.throws(() => q.buildFindMany({ where } as never), UnsupportedFeatureError);
    }
  });
});
