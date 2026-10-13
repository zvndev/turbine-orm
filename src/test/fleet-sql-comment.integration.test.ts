/**
 * turbine-orm: `sqlComment` against real engines.
 *
 *   1. PostgreSQL: hostile static and dynamic values reach the server inside
 *      the comment and every statement still parses and does exactly what it
 *      did without one (reads, writes, a pipeline, a stream); the server sees
 *      the comment (`pg_prepared_statements.statement`); a static comment is
 *      ONE prepared statement however often it runs; tags add one per label;
 *      and a dynamic value prepares nothing, so a trace id per request cannot
 *      grow the server's prepared statements.
 *   2. MySQL: the same hostile values through mysql2's placeholder rewrite and
 *      a reselect write.
 *   3. SQLite: the same values parse, and a write's change count is intact.
 *
 * The PostgreSQL clients run on a one-connection pool so `pg_prepared_statements`
 * (per session) is the session the statements ran on.
 *
 *   DATABASE_URL=postgres://... MYSQL_URL=mysql://.../db npx tsx --test src/test/fleet-sql-comment.integration.test.ts
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import type { SqlCommentOptions } from '../query/sql-comment.js';
import { resetPreparedNameBudget } from '../query/utils.js';
import type { SchemaMetadata } from '../schema.js';
import { introspectSqliteDatabase, turbineSqlite } from '../sqlite.js';
import { mockTable, skipGate } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: the suites drive untyped accessors
type Any = any;

const DATABASE_URL = process.env.DATABASE_URL;
const MYSQL_URL = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const DatabaseSync: (new (path: string) => DatabaseSyncType) | undefined = (() => {
  try {
    return createRequire(process.cwd())('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();

const TABLE = 'fleet_sql_comment_items';

/** Everything that could end, nest or extend a comment, or look like a placeholder or a statement. */
const HOSTILE = "x */ DROP TABLE fleet_sql_comment_items; /* y ' -- \n\u0000 $1 ? :p1 @p1 # \\ é";

function rowsSchema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      [TABLE]: mockTable(TABLE, [
        { name: 'id', field: 'id', pgType: 'int4' },
        { name: 'name', field: 'name', pgType: 'text' },
      ]),
    },
  };
}

const pgGate = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

describe('sqlComment (live PostgreSQL)', () => {
  let admin: pg.Client;

  function oneConnection(sqlComment: SqlCommentOptions): Any {
    return new TurbineClient(
      { connectionString: DATABASE_URL, poolSize: 1, warnOnUnlimited: false, logger: {}, sqlComment },
      rowsSchema(),
    );
  }

  /** This session's prepared statements: run through the client's only connection. */
  async function prepared(db: Any): Promise<{ name: string; statement: string }[]> {
    return db.raw`SELECT name, statement FROM pg_prepared_statements ORDER BY name`;
  }

  pgGate.before(async () => {
    admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await admin.query(`CREATE TABLE ${TABLE} (id int4 PRIMARY KEY, name text NOT NULL)`);
    await admin.query(`INSERT INTO ${TABLE} SELECT g, 'n' || g FROM generate_series(1, 20) g`);
  });

  pgGate.after(async () => {
    await admin?.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await admin?.end();
  });

  pgGate.it('hostile values: every statement parses and does what it did without a comment', async () => {
    resetPreparedNameBudget();
    const db = oneConnection({
      static: { evil: HOSTILE },
      model: true,
      tag: true,
      dynamic: () => ({ evil2: HOSTILE }),
    });
    try {
      const items = db.table(TABLE);
      await db.$tag(HOSTILE.slice(0, 100), async () => {
        assert.deepEqual(await items.findMany({ where: { id: { lte: 2 } }, orderBy: { id: 'asc' } }), [
          { id: 1, name: 'n1' },
          { id: 2, name: 'n2' },
        ]);
        assert.deepEqual(await items.update({ where: { id: 3 }, data: { name: 'renamed' } }), {
          id: 3,
          name: 'renamed',
        });
        assert.equal((await items.updateMany({ where: { id: { gte: 19 } }, data: { name: 'tail' } })).count, 2);
        assert.equal(await items.count({ where: { name: 'tail' } }), 2);
        const [first, total] = await db.pipeline(items.buildFindUnique({ where: { id: 1 } }), items.buildCount({}));
        assert.deepEqual([first, total], [{ id: 1, name: 'n1' }, 20]);
        const streamed: number[] = [];
        for await (const row of items.findManyStream({ orderBy: { id: 'asc' }, batchSize: 7 })) streamed.push(row.id);
        assert.equal(streamed.length, 20);
      });
      const { rows } = await admin.query(`SELECT count(*)::int AS n FROM ${TABLE}`);
      assert.equal(rows[0].n, 20, 'the table is intact');
    } finally {
      await db.disconnect();
    }
  });

  pgGate.it('a static comment is one prepared statement, and the server holds the commented text', async () => {
    resetPreparedNameBudget();
    const db = oneConnection({ static: { application: 'billing' }, model: true });
    try {
      for (let i = 1; i <= 5; i++) await db.table(TABLE).findMany({ where: { id: i }, limit: 1 });
      const statements = await prepared(db);
      assert.equal(statements.length, 1, JSON.stringify(statements));
      assert.match(statements[0]!.name, /^c_[0-9a-f]{16}$/);
      assert.ok(
        statements[0]!.statement.endsWith(` /*action='findMany',application='billing',model='${TABLE}'*/`),
        statements[0]!.statement,
      );
    } finally {
      await db.disconnect();
    }
  });

  pgGate.it('tags: one prepared statement per label', async () => {
    resetPreparedNameBudget();
    const db = oneConnection({ tag: true });
    try {
      const find = () => db.table(TABLE).findMany({ where: { id: 1 }, limit: 1 });
      for (const label of ['checkout', 'refund', 'checkout', 'report', 'refund']) await db.$tag(label, find);
      const statements = await prepared(db);
      assert.deepEqual(statements.map((s) => s.statement.slice(s.statement.indexOf(' /*') + 1)).sort(), [
        "/*tag='checkout'*/",
        "/*tag='refund'*/",
        "/*tag='report'*/",
      ]);
    } finally {
      await db.disconnect();
    }
  });

  pgGate.it('a dynamic value per request prepares nothing on the server', async () => {
    resetPreparedNameBudget();
    let trace: string | undefined;
    const db = oneConnection({ static: { app: 'x' }, dynamic: () => (trace ? { traceparent: trace } : undefined) });
    try {
      const find = () => db.table(TABLE).findMany({ where: { id: 1 }, limit: 1 });
      await find(); // unsampled: named, prepared once
      const before = await prepared(db);
      assert.equal(before.length, 1);
      for (let i = 0; i < 25; i++) {
        trace = `00-${String(i).padStart(32, '0')}-${String(i).padStart(16, '0')}-01`;
        assert.deepEqual(await find(), [{ id: 1, name: 'n1' }]);
      }
      assert.deepEqual(await prepared(db), before, '25 distinct trace ids added no prepared statement');
    } finally {
      await db.disconnect();
    }
  });
});

const mysqlGate = skipGate(!MYSQL_URL, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a MySQL 8 server');

describe('sqlComment (live MySQL)', () => {
  // biome-ignore lint/suspicious/noExplicitAny: mysql2 pool, loaded dynamically
  let rawPool: any;
  let db: Any;

  mysqlGate.before(async () => {
    const { createPool } = await import('mysql2/promise');
    rawPool = createPool({ uri: MYSQL_URL });
    await rawPool.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await rawPool.query(`CREATE TABLE ${TABLE} (id INT PRIMARY KEY, name VARCHAR(64) NOT NULL)`);
    await rawPool.query(`INSERT INTO ${TABLE} (id, name) VALUES (1, 'n1'), (2, 'n2'), (3, 'n3'), (4, 'n4')`);
    const { turbineMysql } = await import('../mysql.js');
    db = await turbineMysql(MYSQL_URL, rowsSchema(), {
      warnOnUnlimited: false,
      logger: {},
      sqlComment: { static: { evil: HOSTILE }, model: true, tag: true },
    });
  });

  mysqlGate.after(async () => {
    await db?.disconnect();
    await rawPool?.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await rawPool?.end();
  });

  mysqlGate.it('hostile values: reads, a reselect write and a change count are what they were', async () => {
    const items = db.table(TABLE);
    await db.$tag("it's */ /*", async () => {
      assert.deepEqual(await items.findMany({ where: { id: { in: [1, 2] } }, orderBy: { id: 'asc' } }), [
        { id: 1, name: 'n1' },
        { id: 2, name: 'n2' },
      ]);
      assert.deepEqual(await items.update({ where: { id: 3 }, data: { name: 'renamed' } }), { id: 3, name: 'renamed' });
      assert.equal((await items.updateMany({ where: { id: { gte: 3 } }, data: { name: 'tail' } })).count, 2);
      assert.equal(await items.count({ where: { name: 'tail' } }), 2);
    });
    const [rows] = await rawPool.query(`SELECT COUNT(*) AS n FROM ${TABLE}`);
    assert.equal(Number(rows[0].n), 4, 'the table is intact');
  });
});

const sqliteGate = skipGate(!DatabaseSync, 'node:sqlite requires Node >= 22.5');

describe('sqlComment (live SQLite)', () => {
  sqliteGate.it('hostile values parse, and a write still reports its change count', async () => {
    const raw = new DatabaseSync!(':memory:');
    raw.exec(`CREATE TABLE ${TABLE} (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`);
    for (let i = 1; i <= 4; i++) raw.prepare(`INSERT INTO ${TABLE} VALUES (?, ?)`).run(i, `n${i}`);
    const db = turbineSqlite(raw, introspectSqliteDatabase(raw), {
      warnOnUnlimited: false,
      logger: {},
      sqlComment: { static: { evil: HOSTILE }, model: true },
    }) as Any;
    try {
      const items = db.table(TABLE);
      assert.deepEqual(await items.findMany({ where: { id: 1 } }), [{ id: 1, name: 'n1' }]);
      assert.equal((await items.updateMany({ where: { id: { gte: 3 } }, data: { name: 'tail' } })).count, 2);
      assert.deepEqual(await items.update({ where: { id: 1 }, data: { name: 'one' } }), { id: 1, name: 'one' });
      assert.equal(raw.prepare(`SELECT count(*) AS n FROM ${TABLE}`).get()!.n, 4);
    } finally {
      await db.disconnect();
    }
  });

  sqliteGate.it('a comment value holding the word "returning" does not turn a write into a row read', async () => {
    // The SQLite engine picks between a row read and a change count by looking
    // for RETURNING in the statement; the comment is not part of the statement.
    const raw = new DatabaseSync!(':memory:');
    raw.exec(`CREATE TABLE ${TABLE} (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`);
    for (let i = 1; i <= 4; i++) raw.prepare(`INSERT INTO ${TABLE} VALUES (?, ?)`).run(i, `n${i}`);
    const db = turbineSqlite(raw, introspectSqliteDatabase(raw), {
      warnOnUnlimited: false,
      logger: {},
      sqlComment: { static: { route: 'orders-returning' }, tag: true },
    }) as Any;
    try {
      const items = db.table(TABLE);
      await db.$tag('returning', async () => {
        assert.equal((await items.updateMany({ where: { id: { gte: 3 } }, data: { name: 'tail' } })).count, 2);
        assert.equal((await items.deleteMany({ where: { id: 4 } })).count, 1);
      });
      assert.equal(raw.prepare(`SELECT count(*) AS n FROM ${TABLE}`).get()!.n, 3);
    } finally {
      await db.disconnect();
    }
  });
});
