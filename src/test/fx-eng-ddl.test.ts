/**
 * `schemaToSQL` on MySQL, SQLite and SQL Server: enum columns and two default
 * spellings.
 *
 *   - An enum column used to be emitted as PostgreSQL's `CREATE TYPE ... AS
 *     ENUM` plus a column naming that type, on every engine: two parse errors
 *     and no table on MySQL, a syntax error on SQLite, invalid T-SQL on SQL
 *     Server. The labels are now declared on the column, by each dialect's
 *     `buildEnumColumn`: an inline `ENUM(...)` on MySQL, text plus a CHECK on
 *     SQLite and SQL Server. PostgreSQL's DDL is unchanged.
 *   - A default with a doubled quote (`'it''s'`) or a PostgreSQL cast
 *     (`'x'::text`, as the catalog prints one) was refused on every engine.
 *
 * The cross-engine battery creates an enum table on every engine through this
 * same path (`oe_tags` in src/test/oracle/engines/fixture.ts).
 *
 * Run: MYSQL_URL=mysql://root@127.0.0.1:3306 MYSQL_FX_ENG_DATABASE=turbine_dev_fx_eng \
 *   npx tsx --test src/test/fx-eng-ddl.test.ts
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { after, before, describe, it } from 'node:test';
import { postgresDialect } from '../dialect.js';
import { CheckConstraintError, UnsupportedFeatureError, ValidationError } from '../errors.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { schemaToSQL } from '../schema-sql.js';
import { sqliteDialect } from '../sqlite.js';
import { HAVE_NODE_SQLITE } from './fix-where-engines.js';
import { skipGate } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: tables are driven by name, with no generated types
type Any = any;

const LABELS = ['active', "it's", 'int', 'date'] as const;

const def = defineSchema(
  {
    fxe_ddl_accounts: {
      id: { type: 'integer', primaryKey: true },
      status: { type: 'enum', enumName: 'fxe_status', notNull: true, default: "'active'" },
      previous: { type: 'enum', enumName: 'fxe_status' },
      motto: { type: 'text', default: "'it''s'" },
      code: { type: 'varchar', maxLength: 10, default: "'x'::character varying" },
      prefs: { type: 'jsonb', default: "'[]'::jsonb" },
      note: { type: 'text', default: "'n'::text" },
    },
  } as never,
  { enums: { fxe_status: LABELS } },
);

const sqlFor = (dialect?: typeof mysqlDialect) => schemaToSQL(def, dialect ? { dialect } : undefined).join('\n');

describe('enum columns: DDL per dialect', () => {
  it('PostgreSQL declares the type and names it, as before', () => {
    const sql = sqlFor();
    assert.match(sql, /CREATE TYPE "fxe_status" AS ENUM \('active', 'it''s', 'int', 'date'\);/);
    assert.match(sql, /"status" "fxe_status" NOT NULL DEFAULT 'active'/);
    assert.match(sql, /"previous" "fxe_status"/);
  });

  it('MySQL declares the labels inline, and a label named like a type is left alone', () => {
    const sql = sqlFor(mysqlDialect);
    assert.doesNotMatch(sql, /CREATE TYPE/);
    assert.match(sql, /`status` ENUM\('active', 'it''s', 'int', 'date'\) NOT NULL DEFAULT 'active'/);
    assert.match(sql, /`previous` ENUM\('active', 'it''s', 'int', 'date'\)[,\n]/);
  });

  it('SQLite uses TEXT and a CHECK over the labels', () => {
    const sql = sqlFor(sqliteDialect);
    assert.doesNotMatch(sql, /CREATE TYPE/);
    assert.match(
      sql,
      /"status" TEXT NOT NULL DEFAULT 'active' CHECK \("status" IN \('active', 'it''s', 'int', 'date'\)\)/,
    );
    assert.match(sql, /"previous" TEXT CHECK \("previous" IN \('active', 'it''s', 'int', 'date'\)\)/);
  });

  it('SQL Server uses NVARCHAR and a CHECK over N-prefixed labels', () => {
    const sql = sqlFor(mssqlDialect);
    assert.doesNotMatch(sql, /CREATE TYPE/);
    assert.match(
      sql,
      /\[status\] NVARCHAR\(255\) NOT NULL DEFAULT 'active' CHECK \(\[status\] IN \(N'active', N'it''s', N'int', N'date'\)\)/,
    );
    const long = defineSchema(
      { t: { id: { type: 'integer', primaryKey: true }, s: { type: 'enum', enumName: 'e' } } } as never,
      { enums: { e: ['a', 'b'.repeat(300)] } },
    );
    assert.match(schemaToSQL(long, { dialect: mssqlDialect }).join('\n'), /\[s\] NVARCHAR\(300\)/);
  });

  it('refuses what an engine cannot declare, before emitting anything', () => {
    const undeclared = defineSchema({
      t: { id: { type: 'integer', primaryKey: true }, s: { type: 'enum', enumName: 'elsewhere' } },
    } as never);
    // PostgreSQL may name a type that already exists; no other engine has one to name.
    assert.match(schemaToSQL(undeclared).join('\n'), /"s" "elsewhere"/);
    for (const dialect of [mysqlDialect, sqliteDialect, mssqlDialect]) {
      assert.throws(
        () => schemaToSQL(undeclared, { dialect }),
        (err) =>
          err instanceof ValidationError &&
          /enum type "elsewhere", which the schema does not declare/.test(err.message),
        dialect.name,
      );
    }
    const empty = defineSchema(
      { t: { id: { type: 'integer', primaryKey: true }, s: { type: 'enum', enumName: 'e' } } } as never,
      { enums: { e: [] } },
    );
    assert.throws(() => schemaToSQL(empty, { dialect: sqliteDialect }), /declares no labels/);
    const array = defineSchema(
      { t: { id: { type: 'integer', primaryKey: true }, s: { type: 'enum', enumName: 'e', array: true } } } as never,
      { enums: { e: ['a'] } },
    );
    assert.throws(() => schemaToSQL(array, { dialect: mysqlDialect }), UnsupportedFeatureError);
    const backslash = defineSchema(
      { t: { id: { type: 'integer', primaryKey: true }, s: { type: 'enum', enumName: 'e' } } } as never,
      { enums: { e: ['a\\b'] } },
    );
    assert.throws(
      () => schemaToSQL(backslash, { dialect: mysqlDialect }),
      (err) => err instanceof ValidationError && /backslash/.test(err.message),
    );
    assert.match(schemaToSQL(backslash, { dialect: sqliteDialect }).join('\n'), /IN \('a\\b'\)/);
  });

  it('an engine other than PostgreSQL without the hook refuses an enum column instead of emitting CREATE TYPE', () => {
    const inheriting = { ...postgresDialect, name: 'inheriting' } as typeof postgresDialect;
    assert.throws(
      () => schemaToSQL(def, { dialect: inheriting }),
      (err) => err instanceof UnsupportedFeatureError && /enum columns/.test(err.message),
    );
  });
});

describe('defaults with a doubled quote or a PostgreSQL cast', () => {
  it('are accepted on every dialect, and the cast is dropped', () => {
    for (const dialect of [undefined, sqliteDialect, mssqlDialect]) {
      const sql = sqlFor(dialect);
      const name = dialect?.name ?? 'postgresql';
      assert.match(sql, /"?\[?motto\]?"? (TEXT|NVARCHAR\(MAX\)) DEFAULT 'it''s'/, name);
      assert.match(sql, /DEFAULT 'x'/, name);
      assert.match(sql, /DEFAULT '\[\]'/, name);
      assert.match(sql, /DEFAULT 'n'/, name);
      assert.doesNotMatch(sql, /::/, name);
    }
    const sql = sqlFor(mysqlDialect);
    assert.match(sql, /`code` VARCHAR\(10\) DEFAULT 'x'/);
    assert.match(sql, /`prefs` JSON DEFAULT \('\[\]'\)/);
    assert.match(sql, /`note` TEXT DEFAULT \('n'\)/);
    assert.doesNotMatch(sql, /::/);
  });

  it('MySQL writes an expression default holding a quote or a backslash as hex bytes', () => {
    // MySQL re-parses a stored expression default on every insert under the
    // inserting session's NO_BACKSLASH_ESCAPES, so `('it''s')` broke every
    // insert on a Turbine connection. Hex has nothing to escape.
    assert.match(sqlFor(mysqlDialect), /`motto` TEXT DEFAULT \(CONVERT\(X'69742773' USING utf8mb4\)\)/);
    const more = defineSchema({
      t: {
        id: { type: 'integer', primaryKey: true },
        path: { type: 'text', default: "'C:\\temp'" },
        blob: { type: 'bytea', default: "'it''s'" },
        doc: { type: 'json', default: `'{"a":"it''s"}'` },
        word: { type: 'varchar', maxLength: 10, default: "'it''s'" },
      },
    });
    const sql = schemaToSQL(more, { dialect: mysqlDialect }).join('\n');
    assert.match(sql, /`path` TEXT DEFAULT \(CONVERT\(X'433a5c74656d70' USING utf8mb4\)\)/);
    assert.match(sql, /`blob` BLOB DEFAULT \(X'69742773'\)/);
    assert.match(sql, /`doc` JSON DEFAULT \(CONVERT\(X'7b2261223a226974277322/);
    // A literal (not expression) default is stored as a value, so a doubled quote is fine there.
    assert.match(sql, /`word` VARCHAR\(10\) DEFAULT 'it''s'/);
  });

  it('a statement hidden in a quoted default is still refused, as E003', () => {
    for (const value of ["'a'';DROP TABLE x'", "'x'::text; DROP TABLE x", "'DROP TABLE x'::text", "'it's'"]) {
      const bad = defineSchema({
        t: { id: { type: 'integer', primaryKey: true }, v: { type: 'text', default: value } },
      });
      assert.throws(() => schemaToSQL(bad), ValidationError, value);
    }
  });

  it('MySQL refuses a backslash in a literal default, which it reads two ways; the others keep it', () => {
    const slash = defineSchema({
      t: { id: { type: 'integer', primaryKey: true }, v: { type: 'varchar', maxLength: 20, default: "'C:\\temp'" } },
    });
    assert.throws(
      () => schemaToSQL(slash, { dialect: mysqlDialect }),
      (err) => err instanceof ValidationError && /backslash/.test(err.message),
    );
    assert.match(schemaToSQL(slash, { dialect: sqliteDialect }).join('\n'), /DEFAULT 'C:\\temp'/);
  });
});

// ---------------------------------------------------------------------------
// Live: the DDL runs, the labels and defaults hold, and other values are refused
// ---------------------------------------------------------------------------

async function exerciseClient(db: Any, refused: (err: unknown) => boolean): Promise<void> {
  const accounts = db.table('fxe_ddl_accounts');
  await accounts.create({ data: { id: 1 } });
  await accounts.create({ data: { id: 2, status: "it's", previous: 'int' } });
  const rows = await accounts.findMany({ orderBy: { id: 'asc' } });
  assert.deepEqual(
    rows.map((r: Any) => ({ ...r, prefs: JSON.stringify(r.prefs) })),
    [
      { id: 1, status: 'active', previous: null, motto: "it's", code: 'x', prefs: '[]', note: 'n' },
      { id: 2, status: "it's", previous: 'int', motto: "it's", code: 'x', prefs: '[]', note: 'n' },
    ],
  );
  assert.deepEqual(
    (await accounts.findMany({ where: { status: { in: ["it's", 'date'] } } })).map((r: Any) => r.id),
    [2],
  );
  await assert.rejects(() => accounts.create({ data: { id: 3, status: 'archived' } }), refused);
  assert.equal(await accounts.count(), 2);
}

const MYSQL_URL = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const MYSQL_DATABASE = process.env.MYSQL_FX_ENG_DATABASE ?? 'turbine_dev_fx_eng_ddl';
const mysql = skipGate(!MYSQL_URL, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a MySQL 8 server');

describe('enum columns and defaults on a MySQL server', () => {
  let pool: Any;
  let db: Any;
  before(async () => {
    if (!MYSQL_URL) return;
    const { createPool } = await import('mysql2/promise');
    const url = new URL(MYSQL_URL);
    const base = {
      host: url.hostname,
      port: url.port ? Number(url.port) : 3306,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
    const admin = createPool(base);
    await admin.query(`CREATE DATABASE IF NOT EXISTS \`${MYSQL_DATABASE}\``);
    await admin.end();
    pool = createPool({ ...base, database: MYSQL_DATABASE });
    await pool.query('DROP TABLE IF EXISTS `fxe_ddl_accounts`');
    for (const stmt of schemaToSQL(def, { dialect: mysqlDialect })) await pool.query(stmt);
    const { turbineMysql } = await import('../mysql.js');
    url.pathname = `/${MYSQL_DATABASE}`;
    db = await turbineMysql(url.toString(), schemaDefToMetadata(def), { warnOnUnlimited: false });
  });
  after(async () => {
    await db?.disconnect();
    await pool?.query('DROP TABLE IF EXISTS `fxe_ddl_accounts`');
    await pool?.end();
  });

  mysql.it('creates the table, stores the labels and defaults, and refuses another label', async () => {
    const [cols] = await pool.query(
      "SELECT COLUMN_NAME AS c, COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'fxe_ddl_accounts' AND COLUMN_NAME = 'status'",
      [MYSQL_DATABASE],
    );
    assert.equal(cols[0].t, "enum('active','it''s','int','date')");
    await exerciseClient(db, (err) => err instanceof ValidationError);
  });
});

const sqlite = skipGate(!HAVE_NODE_SQLITE, 'requires node:sqlite (Node >= 22.5)');

describe('enum columns and defaults on SQLite', () => {
  sqlite.it('creates the table, stores the labels and defaults, and the CHECK refuses another label', async () => {
    const { DatabaseSync } = createRequire(process.cwd())('node:sqlite');
    const raw = new DatabaseSync(':memory:');
    for (const stmt of schemaToSQL(def, { dialect: sqliteDialect })) raw.exec(stmt);
    const { turbineSqlite } = await import('../sqlite.js');
    const db = turbineSqlite(raw, schemaDefToMetadata(def), { warnOnUnlimited: false });
    await exerciseClient(db, (err) => err instanceof CheckConstraintError);
  });
});
