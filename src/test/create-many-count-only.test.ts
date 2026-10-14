/**
 * turbine-orm: `createMany({ returning: false })` resolves to `{ count }`.
 *
 * The row-returning form sends `RETURNING *` (or `OUTPUT INSERTED.*`) and
 * parses every row back, which a caller that only needs to know the rows
 * landed pays for twice: in bytes from the server and in JavaScript. The
 * count-only form sends no RETURNING / OUTPUT on a plain insert and takes the
 * engine's row count. An `onConflict` call still returns its identity key
 * columns, because two input rows that write ONE table row (keys equal only
 * under a case-insensitive collation) are caught by seeing that row twice,
 * and the count is taken from those rows.
 *
 * Tier 1 is build-only (no DB): the statement each dialect sends and the
 * refusals. Tier 2 runs the same calls against live engines: SQLite
 * in-process, PostgreSQL / MySQL / SQL Server gated on DATABASE_URL /
 * MYSQL_URL / MSSQL_URL, and requires the count to equal what the database
 * shows.
 *
 * Run: npx tsx --test src/test/create-many-count-only.test.ts
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it as nodeIt } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import type { Dialect } from '../dialect.js';
import { postgresDialect } from '../dialect.js';
import { UnsupportedFeatureError, ValidationError } from '../errors.js';
import type { CreateManyArgs, OptionalInput } from '../index.js';
import { introspect } from '../introspect.js';
import { introspectMssqlWith, MssqlPool, mssqlDialect, turbineMssql } from '../mssql.js';
import { introspectMysqlWith, MysqlPool, mysqlDialect, turbineMysql } from '../mysql.js';
import type { QueryInterface } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { sqliteDialect, turbineSqlite } from '../sqlite.js';
import { makeQuery, mockTable, skipGate } from './helpers.js';

// ---------------------------------------------------------------------------
// Tier 1, build-only
// ---------------------------------------------------------------------------

function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      // `k` is the primary key and the only unique key, so it is the
      // onConflict target on every engine (MySQL needs exactly one key).
      cm_up: mockTable(
        'cm_up',
        [
          { name: 'k', field: 'k', pgType: 'text' },
          { name: 'n', field: 'n', pgType: 'int4' },
          { name: 'note', field: 'note', pgType: 'text' },
        ],
        {},
        ['k'],
      ),
    },
  };
}

function q(dialect: Dialect = postgresDialect) {
  return makeQuery('cm_up', schema(), { dialect });
}

const ROWS = [
  { k: 'a', n: 1, note: 'x' },
  { k: 'b', n: 2, note: 'y' },
];
const UPSERT = { target: ['k'] as ['k'], update: ['n'] as ['n'] };

describe('createMany returning: false, the statement', () => {
  nodeIt('a plain insert sends no RETURNING on PostgreSQL and SQLite, and no OUTPUT on SQL Server', () => {
    for (const dialect of [postgresDialect, sqliteDialect]) {
      assert.match(q(dialect).buildCreateMany({ data: ROWS }).sql, /RETURNING \*$/, dialect.name);
      const sql = q(dialect).buildCreateMany({ data: ROWS, returning: false }).sql;
      assert.doesNotMatch(sql, /RETURNING/, `${dialect.name}: ${sql}`);
    }
    assert.match(q(mssqlDialect).buildCreateMany({ data: ROWS }).sql, /OUTPUT INSERTED\.\*/);
    const mssql = q(mssqlDialect).buildCreateMany({ data: ROWS, returning: false }).sql;
    assert.doesNotMatch(mssql, /OUTPUT/, mssql);
  });

  nodeIt('returning: true is the default statement, byte for byte', () => {
    for (const dialect of [postgresDialect, sqliteDialect, mysqlDialect, mssqlDialect]) {
      const plain = q(dialect).buildCreateMany({ data: ROWS });
      const explicit = q(dialect).buildCreateMany({ data: ROWS, returning: true });
      assert.equal(explicit.sql, plain.sql, dialect.name);
      assert.deepEqual(explicit.params, plain.params, dialect.name);
    }
  });

  nodeIt('an onConflict call returns only its key column, which the count is taken from', () => {
    for (const dialect of [postgresDialect, sqliteDialect]) {
      const sql = q(dialect).buildCreateMany({ data: ROWS, onConflict: UPSERT, returning: false }).sql;
      assert.match(sql, /RETURNING "k"$/, `${dialect.name}: ${sql}`);
    }
    const mssql = q(mssqlDialect).buildCreateMany({ data: ROWS, onConflict: UPSERT, returning: false }).sql;
    assert.match(mssql, /OUTPUT INSERTED\.\[k\]/, mssql);
    assert.doesNotMatch(mssql, /INSERTED\.\[n\]|INSERTED\.\*/, mssql);
  });

  nodeIt('rows of pure defaults send no RETURNING either', () => {
    const sql = q().buildCreateMany({ data: [{}, {}], returning: false }).sql;
    assert.match(sql, /^INSERT INTO "cm_up" SELECT FROM generate_series\(1, 2\)$/, sql);
  });

  nodeIt('the count is the engine row count, or the rows back when there is none', () => {
    const plain = q().buildCreateMany({ data: ROWS, returning: false });
    assert.deepEqual(plain.transform({ rows: [], rowCount: 2 } as never), { count: 2 });
    assert.deepEqual(plain.transform({ rows: [{}, {}, {}], rowCount: null } as never), { count: 3 });
    const upsert = q().buildCreateMany({ data: ROWS, onConflict: UPSERT, returning: false });
    // Two identity rows back: one inserted, one updated.
    assert.deepEqual(upsert.transform({ rows: [{ k: 'a' }, { k: 'b' }], rowCount: 2 } as never), { count: 2 });
    assert.deepEqual(
      q()
        .buildCreateMany({ data: [], returning: false })
        .transform({ rows: [] } as never),
      {
        count: 0,
      },
    );
  });

  nodeIt('the identity check still refuses one table row written twice', () => {
    // SQLite applies the second of two keys equal under NOCASE as an update of
    // the first, in one statement; the row comes back twice.
    const upsert = q(sqliteDialect).buildCreateMany({
      data: [
        { k: 'Q', n: 1, note: 'x' },
        { k: 'r', n: 2, note: 'y' },
      ],
      onConflict: UPSERT,
      returning: false,
    });
    assert.throws(
      () => upsert.transform({ rows: [{ k: 'Q' }, { k: 'Q' }], rowCount: 2 } as never),
      (e: Error) => e instanceof ValidationError && /share the conflict key/.test(e.message),
    );
  });

  nodeIt('skipDuplicates counts on PostgreSQL and SQLite, and is E017 on MySQL whatever the rows', () => {
    for (const dialect of [postgresDialect, sqliteDialect]) {
      const sql = q(dialect).buildCreateMany({ data: ROWS, skipDuplicates: true, returning: false }).sql;
      assert.match(sql, /ON CONFLICT DO NOTHING$/, `${dialect.name}: ${sql}`);
    }
    // MySQL's skip is a no-op ON DUPLICATE KEY UPDATE, which counts a skipped
    // row as affected. Refused before the empty-data shortcut, so `data: []`
    // is refused too.
    for (const data of [ROWS, []]) {
      assert.throws(
        () => q(mysqlDialect).buildCreateMany({ data, skipDuplicates: true, returning: false }),
        (e: Error) => e instanceof UnsupportedFeatureError && /counts a skipped row as written/.test(e.message),
        `${data.length} rows`,
      );
    }
    // The rows form is unchanged there.
    assert.match(
      q(mysqlDialect).buildCreateMany({ data: ROWS, skipDuplicates: true }).sql,
      /ON DUPLICATE KEY UPDATE `k` = `k`$/,
    );
  });

  nodeIt('is refused with select or omit, and for a value that is not a boolean', () => {
    assert.throws(
      () => q().buildCreateMany({ data: ROWS, returning: false, select: { k: true } } as never),
      (e: Error) => e instanceof ValidationError && /takes no `select`/.test(e.message),
    );
    assert.throws(
      () => q().buildCreateMany({ data: ROWS, returning: false, omit: { note: true } } as never),
      (e: Error) => e instanceof ValidationError && /takes no `omit`/.test(e.message),
    );
    for (const bad of ['false', 0, null]) {
      assert.throws(
        () => q().buildCreateMany({ data: ROWS, returning: bad } as never),
        (e: Error) => e instanceof ValidationError && /returning must be true or false/.test(e.message),
        String(bad),
      );
    }
  });
});

/** Compile-time only: the result type follows the flag. Never called. */
type Row = { k: string; n: number; note: string };
export async function typeChecks(t: QueryInterface<Row>): Promise<void> {
  const counted: { count: number } = await t.createMany({ data: ROWS, returning: false });
  const rows: { k: string }[] = await t.createMany({ data: ROWS });
  const explicit: { k: string }[] = await t.createMany({ data: ROWS, returning: true });
  // @ts-expect-error returning: false resolves to { count }, not rows
  const wrong: { k: string }[] = await t.createMany({ data: ROWS, returning: false });
  const flag = Math.random() > 2;
  // @ts-expect-error a flag known only at run time can be either shape
  const unknown: { count: number } = await t.createMany({ data: ROWS, returning: flag });
  const deferred: { count: number } = t.buildCreateMany({ data: ROWS, returning: false }).transform({} as never);
  // Args typed ahead of the call keep the rows form, as before `returning` existed.
  const preTyped: CreateManyArgs<Row> = { data: ROWS };
  const preRows: Row[] = await t.createMany(preTyped);
  const preCount: CreateManyArgs<Row, OptionalInput<Row>, undefined, undefined, false> = {
    data: ROWS,
    returning: false,
  };
  const preCounted: { count: number } = await t.createMany(preCount);
  // @ts-expect-error the default args type is the rows form, so it holds no `false`
  const notCount: CreateManyArgs<Row> = { data: ROWS, returning: false };
  // A generic wrapper over CreateManyArgs<T> resolves to rows.
  const wrap = <R extends object>(qi: QueryInterface<R>, args: CreateManyArgs<R>): Promise<R[]> => qi.createMany(args);
  void [counted, rows, explicit, wrong, unknown, deferred, preRows, preCounted, notCount, wrap];
}

// ---------------------------------------------------------------------------
// Tier 2, live engines
// ---------------------------------------------------------------------------

interface CountingTable {
  createMany(args: Record<string, unknown>): Promise<unknown>;
  count(args?: Record<string, unknown>): Promise<number>;
  findMany(args?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
}

/**
 * The shared live battery. Each count is checked against what the table holds
 * afterwards, and against the row-returning form's length where that form
 * returns rows (MySQL's plain insert returns none).
 */
async function assertCounts(
  t: CountingTable,
  engine: { ignore: boolean; skipDuplicates: 'count' | 'refused' | 'unsupported'; plainReturnsRows: boolean },
): Promise<void> {
  // Plain insert.
  assert.deepEqual(await t.createMany({ data: ROWS, returning: false }), { count: 2 });
  assert.equal(await t.count(), 2);
  const returned = (await t.createMany({ data: [{ k: 'c', n: 3, note: 'z' }] })) as unknown[];
  assert.equal(returned.length, engine.plainReturnsRows ? 1 : 0);
  assert.equal(await t.count(), 3);

  // skipDuplicates counts the rows inserted, never the skipped ones.
  const dupAndNew = [
    { k: 'a', n: 9, note: 'dup' },
    { k: 'd', n: 4, note: 'w' },
  ];
  if (engine.skipDuplicates === 'count') {
    const out = await t.createMany({ data: dupAndNew, skipDuplicates: true, returning: false });
    assert.deepEqual(out, { count: 1 });
    assert.equal(await t.count(), 4);
  } else if (engine.skipDuplicates === 'refused') {
    // The engine counts a skipped row as affected, so the count form is E017
    // and writes nothing; the rows form still skips.
    await assert.rejects(
      t.createMany({ data: dupAndNew, skipDuplicates: true, returning: false }),
      (e: Error) => e instanceof UnsupportedFeatureError,
    );
    assert.equal(await t.count(), 3);
    await t.createMany({ data: dupAndNew, skipDuplicates: true });
    assert.equal(await t.count(), 4);
    assert.equal(await t.count({ where: { k: 'a', n: 1 } }), 1, 'the duplicate was skipped');
  } else {
    await t.createMany({ data: [{ k: 'd', n: 4, note: 'w' }], returning: false });
  }

  // onConflict update: one existing key updated, one new key inserted.
  const upsert = await t.createMany({
    data: [
      { k: 'a', n: 10, note: 'x' },
      { k: 'e', n: 5, note: 'v' },
    ],
    onConflict: UPSERT,
    returning: false,
  });
  assert.deepEqual(upsert, { count: 2 });
  assert.equal(await t.count(), 5);
  assert.equal(await t.count({ where: { k: 'a', n: 10 } }), 1, 'the conflicting row was updated');

  // The same call in the row-returning form agrees.
  const rowsBack = (await t.createMany({
    data: [
      { k: 'a', n: 11, note: 'x' },
      { k: 'f', n: 6, note: 'u' },
    ],
    onConflict: UPSERT,
  })) as unknown[];
  assert.equal(rowsBack.length, 2);

  if (engine.ignore) {
    const ignored = await t.createMany({
      data: [
        { k: 'a', n: 99, note: 'x' },
        { k: 'g', n: 7, note: 't' },
      ],
      onConflict: { target: ['k'], ignore: true },
      returning: false,
    });
    assert.deepEqual(ignored, { count: 1 }, 'an ignored conflict is not counted');
    assert.equal(await t.count({ where: { k: 'a', n: 11 } }), 1, 'and not written');
  }

  // No rows at all.
  assert.deepEqual(await t.createMany({ data: [], returning: false }), { count: 0 });
}

const hasNodeSqlite = (() => {
  try {
    createRequire(process.cwd())('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();
const sqliteGate = skipGate(!hasNodeSqlite, 'turbine-orm/sqlite requires node:sqlite (Node >= 22.5)');

describe('createMany returning: false live, sqlite', () => {
  sqliteGate.it('counts every shape, and the chunked and NOCASE paths still hold', async () => {
    const { introspectSqliteDatabase } = await import('../sqlite.js');
    const { DatabaseSync } = createRequire(process.cwd())('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE cm_up (k TEXT PRIMARY KEY, n INTEGER, note TEXT);
      CREATE TABLE cm_ci (k TEXT PRIMARY KEY COLLATE NOCASE, n INTEGER);
    `);
    const client = turbineSqlite(db, introspectSqliteDatabase(db));
    try {
      await assertCounts(client.table('cm_up') as never, {
        ignore: true,
        skipDuplicates: 'count',
        plainReturnsRows: true,
      });

      // A call too large for one statement is chunked; the counts are summed.
      const many = Array.from({ length: 40_000 }, (_, i) => ({ k: `m${i}`, n: i }));
      assert.deepEqual(await client.table('cm_ci').createMany({ data: many, returning: false }), { count: 40_000 });
      const again = many.map((row) => ({ ...row, n: row.n + 1 }));
      assert.deepEqual(await client.table('cm_ci').createMany({ data: again, onConflict: UPSERT, returning: false }), {
        count: 40_000,
      });

      // Two keys equal under NOCASE in one statement: SQLite writes one row
      // twice, which the identity columns still show.
      db.exec('DELETE FROM cm_ci');
      await assert.rejects(
        client.table('cm_ci').createMany({
          data: [
            { k: 'Q', n: 1 },
            { k: 'q', n: 2 },
          ],
          onConflict: UPSERT,
          returning: false,
        }),
        (e: Error) => e instanceof ValidationError && /share the conflict key/.test(e.message),
      );
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cm_ci').get().n, 0, 'the refused call wrote nothing');
    } finally {
      await client.disconnect();
    }
  });
});

const DATABASE_URL = process.env.DATABASE_URL;
const pgGate = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

describe('createMany returning: false live, postgres', () => {
  pgGate.it('counts every shape, in a pipeline too', async () => {
    const admin = new pg.Pool({ connectionString: DATABASE_URL! });
    const ddl = [
      'DROP TABLE IF EXISTS cm_up, cm_up2',
      'CREATE TABLE cm_up (k text PRIMARY KEY, n int, note text)',
      'CREATE TABLE cm_up2 (k text PRIMARY KEY, n int, note text)',
    ];
    for (const sql of ddl) await admin.query(sql);
    const client = new TurbineClient(
      { connectionString: DATABASE_URL!, poolSize: 2 },
      await introspect({ connectionString: DATABASE_URL!, include: ['cm_up', 'cm_up2'] }),
    );
    try {
      await assertCounts(client.table('cm_up') as never, {
        ignore: true,
        skipDuplicates: 'count',
        plainReturnsRows: true,
      });

      // onConflict's where: an existing row it excludes is neither updated nor counted.
      const filtered = await client.table('cm_up').createMany({
        data: [
          { k: 'a', n: 1, note: 'x' },
          { k: 'b', n: 1, note: 'y' },
          { k: 'h', n: 1, note: 's' },
        ],
        onConflict: { target: ['k'], update: ['n'], where: { n: { lt: 5 } } },
        returning: false,
      } as never);
      // a has n = 11 (excluded), b has n = 2 (updated), h is new.
      assert.deepEqual(filtered, { count: 2 });

      // Two tables in one transactional pipeline, counts from the command tags.
      const [first, second] = await client.pipeline(
        client.table('cm_up').buildCreateMany({ data: [{ k: 'p1', n: 1, note: 'p' }], returning: false }),
        client.table('cm_up2').buildCreateMany({
          data: [
            { k: 'p1', n: 1, note: 'p' },
            { k: 'p2', n: 2, note: 'p' },
          ],
          onConflict: UPSERT,
          returning: false,
        }),
      );
      assert.deepEqual([first, second], [{ count: 1 }, { count: 2 }]);
    } finally {
      await client.disconnect();
      await admin.query('DROP TABLE IF EXISTS cm_up, cm_up2');
      await admin.end();
    }
  });
});

const MYSQL_URL = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const mysqlGate = skipGate(!MYSQL_URL, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a MySQL 8 server');

describe('createMany returning: false live, mysql', () => {
  mysqlGate.it('counts every shape MySQL supports', async () => {
    const { createPool } = await import('mysql2/promise');
    const url = new URL(MYSQL_URL);
    const dbName = url.pathname.replace(/^\//, '');
    const rawPool = createPool({
      host: url.hostname,
      port: url.port ? Number(url.port) : 3306,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: dbName,
      namedPlaceholders: true,
      timezone: 'Z',
    });
    const pool = new MysqlPool(rawPool);
    try {
      await rawPool.query('DROP TABLE IF EXISTS cm_up');
      await rawPool.query('CREATE TABLE cm_up (k VARCHAR(50) PRIMARY KEY, n INT, note VARCHAR(50))');
      const dbSchema = await introspectMysqlWith(async (sql, params) => (await pool.query(sql, params)).rows, dbName);
      const client = await turbineMysql(pool, dbSchema);
      // MySQL's plain insert returns no rows; onConflict ignore and a counted
      // skipDuplicates are E017 there.
      await assertCounts(client.table('cm_up') as never, {
        ignore: false,
        skipDuplicates: 'refused',
        plainReturnsRows: false,
      });
    } finally {
      await rawPool.query('DROP TABLE IF EXISTS cm_up');
      await rawPool.end();
    }
  });
});

const MSSQL_URL = process.env.MSSQL_URL ?? process.env.MSSQL_TEST_URL ?? '';
const mssqlGate = skipGate(!MSSQL_URL, 'requires MSSQL_URL pointing at a SQL Server 2016+ instance');

describe('createMany returning: false live, mssql', () => {
  mssqlGate.it('counts every shape SQL Server supports', async () => {
    const mssqlSpecifier: string = 'mssql';
    // biome-ignore lint/suspicious/noExplicitAny: dynamic mssql import only on the gated path
    const mod: any = await import(mssqlSpecifier);
    const mssql = mod.default ?? mod;
    const url = new URL(MSSQL_URL);
    const rawPool = await new mssql.ConnectionPool({
      server: url.hostname,
      port: url.port ? Number(url.port) : 1433,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.replace(/^\//, ''),
      options: { encrypt: false, trustServerCertificate: true },
    }).connect();
    const pool = new MssqlPool(rawPool, mssql.default ?? mssql);
    const drop = "IF OBJECT_ID('cm_up','U') IS NOT NULL DROP TABLE cm_up";
    try {
      await rawPool.request().batch(drop);
      await rawPool.request().batch('CREATE TABLE cm_up (k NVARCHAR(50) PRIMARY KEY, n INT, note NVARCHAR(50))');
      const dbSchema = await introspectMssqlWith(async (sql, params) => (await pool.query(sql, params)).rows, 'dbo');
      const client = await turbineMssql(pool, dbSchema);
      // skipDuplicates is E017 on SQL Server.
      await assertCounts(client.table('cm_up') as never, {
        ignore: true,
        skipDuplicates: 'unsupported',
        plainReturnsRows: true,
      });
    } finally {
      await rawPool.request().batch(drop);
      await rawPool.close();
    }
  });
});
