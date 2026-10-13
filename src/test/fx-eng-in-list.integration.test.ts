/**
 * `{ col: { in: [v] } }` matches exactly the rows `{ col: v }` matches, and
 * `{ col: { notIn: [v] } }` exactly the rows `{ col: { not: v } }` matches, on
 * every column type, live on MySQL and SQLite. The batched relation loader,
 * which correlates through the same list, returns the join plan's rows for
 * BIGINT and binary keys.
 *
 * MySQL used to bind the list as one JSON array and compare JSON values, so a
 * boolean, a date or time, a binary value, a decimal or bigint written as a
 * string, and a case-folded string all missed, and `notIn` matched every row
 * (`deleteMany({ where: { published: { notIn: [true] } } })` deleted the
 * published rows too). SQLite's JSON list could not carry bytes or a bigint.
 *
 * The column types every engine shares are in the cross-engine battery
 * (`in-list/*` scenarios); this file covers the engine-specific ones.
 *
 * Run: MYSQL_URL=mysql://user@host:3306/db npx tsx --test src/test/fx-eng-in-list.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import type { TurbineClient } from '../client.js';
import type { SchemaMetadata } from '../schema.js';
import { HAVE_NODE_SQLITE } from './fix-where-engines.js';
import { skipGate } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: tables are driven by name, with no generated types
type Any = any;

const MYSQL_URL = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
/** Its own database: test files run in parallel. Only `fxe_` tables are created and dropped in it. */
const DATABASE = process.env.TURBINE_IN_LIST_MYSQL_DB ?? 'turbine_dev_fx_eng_in_list';

type Case = readonly [label: string, field: string, value: unknown];

/** Assert the list forms against the scalar forms for one field and value. */
async function assertListMatchesScalar(table: Any, [label, field, value]: Case): Promise<void> {
  const ids = async (where: Record<string, unknown>) =>
    (await table.findMany({ where, orderBy: { id: 'asc' } })).map((r: { id: unknown }) => Number(r.id));
  const equal = await ids({ [field]: value });
  assert.ok(equal.length > 0, `${label}: the scalar form matched nothing, so the comparison is vacuous`);
  assert.deepEqual(await ids({ [field]: { in: [value] } }), equal, `${label}: in [v] differs from equals v`);
  assert.deepEqual(
    await ids({ [field]: { notIn: [value] } }),
    await ids({ [field]: { not: value } }),
    `${label}: notIn [v] differs from not v`,
  );
  assert.equal(await table.count({ where: { [field]: { in: [value] } } }), equal.length, `${label}: count`);
}

// ---------------------------------------------------------------------------
// MySQL
// ---------------------------------------------------------------------------

const mysql = skipGate(!MYSQL_URL, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a MySQL 8 server');

const MYSQL_TABLES = ['fxe_bin_kids', 'fxe_bin_parents', 'fxe_big_kids', 'fxe_big_parents', 'fxe_vals', 'fxe_art'];

describe('in / notIn match equality on every MySQL column type (live)', () => {
  let rawPool: Any;
  let admin: Any;
  /** Dropped again in `after` only when this file created it. */
  let createdDatabase = false;
  let db: TurbineClient & Any;
  let schema: SchemaMetadata;

  mysql.before(async () => {
    const { createPool } = await import('mysql2/promise');
    const url = new URL(MYSQL_URL);
    const server = {
      host: url.hostname,
      port: url.port ? Number(url.port) : 3306,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
    admin = createPool(server);
    const [existing] = await admin.query('SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [DATABASE]);
    if (existing.length === 0) {
      await admin.query(`CREATE DATABASE \`${DATABASE}\``);
      createdDatabase = true;
    }
    rawPool = createPool({
      ...server,
      database: DATABASE,
      namedPlaceholders: true,
      supportBigNumbers: true,
      timezone: 'Z',
    });
    for (const t of MYSQL_TABLES) await rawPool.query(`DROP TABLE IF EXISTS ${t}`);
    await rawPool.query(
      'CREATE TABLE fxe_vals (id INT PRIMARY KEY, flag TINYINT(1) NULL, email VARCHAR(64) NULL, big BIGINT NULL, ' +
        "amt DECIMAL(10,2) NULL, st ENUM('a','b') NULL, tm TIME NULL, bin BINARY(4) NULL, pad CHAR(4) NULL, " +
        'yr YEAR NULL, dbl DOUBLE NULL, day DATE NULL, at DATETIME(3) NULL)',
    );
    await rawPool.query(
      "INSERT INTO fxe_vals VALUES (1, 1, 'Alice@x', 9007199254740993, 1.50, 'a', '10:00:00', 0x01020304, 'ab', " +
        "2024, 0.1, '2026-01-02', '2026-01-02 03:04:05.006'), (2, 0, 'bob@x', 9007199254740992, 2.00, 'b', " +
        "'11:00:00', 0x05060708, 'cd', 2025, 0.3, '2026-01-03', '2026-01-03 00:00:00.000'), " +
        '(3, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)',
    );
    await rawPool.query('CREATE TABLE fxe_art (id INT PRIMARY KEY, published TINYINT(1) NOT NULL)');
    await rawPool.query('CREATE TABLE fxe_big_parents (id BIGINT PRIMARY KEY, name VARCHAR(10) NOT NULL)');
    await rawPool.query(
      'CREATE TABLE fxe_big_kids (id INT PRIMARY KEY, parent_id BIGINT NOT NULL, ' +
        'FOREIGN KEY (parent_id) REFERENCES fxe_big_parents(id))',
    );
    await rawPool.query(
      "INSERT INTO fxe_big_parents VALUES (9007199254740993, 'snow'), (9007199254740992, 'rain'), (5, 'sun')",
    );
    await rawPool.query(
      'INSERT INTO fxe_big_kids VALUES (1, 9007199254740993), (2, 9007199254740993), (3, 9007199254740992), (4, 5)',
    );
    await rawPool.query('CREATE TABLE fxe_bin_parents (id BINARY(16) PRIMARY KEY, name VARCHAR(10) NOT NULL)');
    await rawPool.query(
      'CREATE TABLE fxe_bin_kids (id INT PRIMARY KEY, parent_id BINARY(16) NOT NULL, ' +
        'FOREIGN KEY (parent_id) REFERENCES fxe_bin_parents(id))',
    );
    // Two keys whose bytes are not valid UTF-8 and differ only there: decoded
    // as text, both become the same replacement characters.
    await rawPool.query(
      "INSERT INTO fxe_bin_parents VALUES (UNHEX('ff00000000000000000000000000000a'), 'p1'), " +
        "(UNHEX('fe00000000000000000000000000000a'), 'p2')",
    );
    await rawPool.query(
      "INSERT INTO fxe_bin_kids VALUES (1, UNHEX('ff00000000000000000000000000000a')), " +
        "(2, UNHEX('fe00000000000000000000000000000a')), (3, UNHEX('fe00000000000000000000000000000a'))",
    );
    const { MysqlPool, introspectMysqlWith, turbineMysql } = await import('../mysql.js');
    const pool = new MysqlPool(rawPool);
    schema = await introspectMysqlWith(async (sql, params) => (await pool.query(sql, params)).rows, DATABASE, {
      include: MYSQL_TABLES,
    });
    db = (await turbineMysql(pool, schema, { warnOnUnlimited: false })) as Any;
  });
  mysql.after(async () => {
    if (rawPool) {
      for (const t of MYSQL_TABLES) await rawPool.query(`DROP TABLE IF EXISTS ${t}`);
      await rawPool.end();
    }
    if (createdDatabase) await admin.query(`DROP DATABASE \`${DATABASE}\``);
    await admin?.end();
  });

  const CASES: Case[] = [
    ['boolean true', 'flag', true],
    ['boolean false', 'flag', false],
    ['case-folded text', 'email', 'ALICE@X'],
    ['bigint past 2^53', 'big', 9007199254740993n],
    ['bigint as a string', 'big', '9007199254740992'],
    ['decimal as a string', 'amt', '1.50'],
    ['decimal as a number', 'amt', 2],
    ['enum', 'st', 'a'],
    ['time', 'tm', '10:00:00'],
    ['binary', 'bin', Buffer.from([1, 2, 3, 4])],
    ['char', 'pad', 'cd'],
    ['year', 'yr', 2024],
    ['double', 'dbl', 0.1],
    ['date as a Date', 'day', new Date('2026-01-02T00:00:00.000Z')],
    ['date as a string', 'day', '2026-01-03'],
    ['datetime with milliseconds', 'at', new Date('2026-01-02T03:04:05.006Z')],
  ];
  for (const c of CASES) {
    mysql.it(`${c[0]}: in [v] = equals v, notIn [v] = not v`, () => assertListMatchesScalar(db.table('fxe_vals'), c));
  }

  mysql.it('a list of several values, and lengths that pad (3 -> 4, 1000 -> 1024), still match', async () => {
    const ids = async (where: Record<string, unknown>) =>
      (await db.table('fxe_vals').findMany({ where, orderBy: { id: 'asc' } })).map((r: { id: number }) => r.id);
    assert.deepEqual(await ids({ big: { in: [9007199254740992n, 9007199254740993n, 7n] } }), [1, 2]);
    const many = Array.from({ length: 999 }, (_, i) => `z${i}@x`);
    assert.deepEqual(await ids({ email: { in: [...many, 'BOB@X'] } }), [2]);
    assert.deepEqual(await ids({ email: { notIn: [...many, 'BOB@X'] } }), [1]);
  });

  mysql.it('an empty list: in matches nothing, notIn matches every row (NULLs too)', async () => {
    assert.equal(await db.table('fxe_vals').count({ where: { flag: { in: [] } } }), 0);
    assert.equal(await db.table('fxe_vals').count({ where: { flag: { notIn: [] } } }), 3);
  });

  mysql.it('deleteMany with notIn [true] deletes only the false rows', async () => {
    await rawPool.query('DELETE FROM fxe_art');
    await rawPool.query('INSERT INTO fxe_art VALUES (1, 1), (2, 1), (3, 0)');
    const result = await db.table('fxe_art').deleteMany({ where: { published: { notIn: [true] } } });
    assert.equal(result.count, 1);
    const left = await db.table('fxe_art').findMany({ orderBy: { id: 'asc' } });
    assert.deepEqual(
      left.map((r: { id: number }) => r.id),
      [1, 2],
    );
  });

  for (const [label, parents, kids, rel] of [
    ['BIGINT', 'fxe_big_parents', 'fxe_big_kids', 'fxeBigKids'],
    ['BINARY(16)', 'fxe_bin_parents', 'fxe_bin_kids', 'fxeBinKids'],
  ] as const) {
    mysql.it(`batched relation loading on ${label} keys returns the join plan's rows`, async () => {
      const parentRel = Object.keys(schema.tables[parents]!.relations)[0]!;
      const childRel = Object.keys(schema.tables[kids]!.relations)[0]!;
      assert.equal(parentRel, rel);
      const read = (strategy: 'join' | 'batched') =>
        Promise.all([
          db.table(parents).findMany({
            orderBy: { name: 'asc' },
            relationLoadStrategy: strategy,
            select: { name: true },
            with: { [parentRel]: { select: { id: true }, orderBy: { id: 'asc' } } },
          }),
          db.table(kids).findMany({
            orderBy: { id: 'asc' },
            relationLoadStrategy: strategy,
            select: { id: true },
            with: { [childRel]: { select: { name: true } } },
          }),
        ]);
      const join = await read('join');
      const batched = await read('batched');
      assert.ok(
        join[0].every((p: Any) => p[parentRel].length > 0),
        'every parent has children on the join plan',
      );
      assert.deepEqual(batched, join);
    });
  }

  mysql.it('rawUnsafe takes $1..$n, outside literals, and refuses one with no value', async () => {
    const rows = await db.rawUnsafe("SELECT $1 AS a, '$2' AS b, $2 AS c", 'x', 5);
    assert.deepEqual(rows, [{ a: 'x', b: '$2', c: 5 }]);
    await assert.rejects(db.rawUnsafe('SELECT $2 AS a', 'x'), /\$2 names no value/);
  });
});

// ---------------------------------------------------------------------------
// SQLite (in memory)
// ---------------------------------------------------------------------------

const sqlite = skipGate(!HAVE_NODE_SQLITE, 'requires node:sqlite (Node >= 22.5)');

describe('in / notIn match equality on SQLite, BLOB and bigint included (live, in memory)', () => {
  let db: TurbineClient & Any;

  sqlite.before(async () => {
    const { createRequire } = await import('node:module');
    const { DatabaseSync } = createRequire(process.cwd())('node:sqlite');
    const { introspectSqliteDatabase, turbineSqlite } = await import('../sqlite.js');
    const raw = new DatabaseSync(':memory:');
    raw.exec(
      'CREATE TABLE vals (id INTEGER PRIMARY KEY, bin BLOB, big INTEGER, flag BOOLEAN, txt TEXT, nc TEXT COLLATE NOCASE, r REAL);' +
        "INSERT INTO vals VALUES (1, X'00ff', 9007199254740993, 1, '5', 'Abc', 1e999), (2, X'00fe', 9007199254740992, 0, 'x', 'zz', 1.5), " +
        '(3, NULL, NULL, NULL, NULL, NULL, NULL);' +
        'CREATE TABLE up (id BLOB PRIMARY KEY, name TEXT);' +
        'CREATE TABLE uk (id INTEGER PRIMARY KEY, up_id BLOB NOT NULL REFERENCES up(id));' +
        "INSERT INTO up VALUES (X'ff0a', 'p1'), (X'fe0a', 'p2');" +
        "INSERT INTO uk VALUES (1, X'ff0a'), (2, X'fe0a'), (3, X'fe0a');",
    );
    db = turbineSqlite(raw, introspectSqliteDatabase(raw), { warnOnUnlimited: false }) as Any;
  });
  sqlite.after(async () => {
    await db?.disconnect();
  });

  const CASES: Case[] = [
    ['binary', 'bin', Buffer.from([0, 0xff])],
    ['bigint past 2^53', 'big', 9007199254740993n],
    ['boolean', 'flag', true],
    ['number against TEXT affinity', 'txt', 5],
    ['NOCASE collation', 'nc', 'ABC'],
    ['infinity', 'r', Number.POSITIVE_INFINITY],
  ];
  for (const c of CASES) {
    sqlite.it(`${c[0]}: in [v] = equals v, notIn [v] = not v`, () => assertListMatchesScalar(db.vals, c));
  }

  sqlite.it("batched relation loading on BLOB keys returns the join plan's rows, both directions", async () => {
    const read = (strategy: 'join' | 'batched') =>
      Promise.all([
        db.up.findMany({
          orderBy: { name: 'asc' },
          relationLoadStrategy: strategy,
          select: { name: true },
          with: { uk: { select: { id: true }, orderBy: { id: 'asc' } } },
        }),
        db.uk.findMany({
          orderBy: { id: 'asc' },
          relationLoadStrategy: strategy,
          select: { id: true },
          with: { up: { select: { name: true } } },
        }),
      ]);
    const join = await read('join');
    assert.deepEqual(
      join[0].map((p: Any) => p.uk.length),
      [1, 2],
    );
    assert.deepEqual(await read('batched'), join);
  });
});
