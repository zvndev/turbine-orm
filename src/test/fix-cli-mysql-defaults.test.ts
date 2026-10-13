/**
 * Column defaults in MySQL DDL.
 *
 * MySQL 8 rejects a literal default on a TEXT, BLOB or JSON column (ERROR 1101)
 * and a NOW() default on a DATE column (ER_INVALID_DEFAULT); both have to be
 * written as parenthesized expressions. The text checks pin the DDL, the live
 * checks run it on a real server and read the defaults back, and the last
 * suite pins that the PostgreSQL, SQLite and SQL Server output did not move.
 *
 * Run: MYSQL_URL=mysql://root@127.0.0.1:3306 MYSQL_FIX_CLI_DATABASE=turbine_dev_fix_cli \
 *   npx tsx --test src/test/fix-cli-mysql-defaults.test.ts
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import { defineSchema } from '../schema-builder.js';
import { schemaToSQL } from '../schema-sql.js';
import { sqliteDialect } from '../sqlite.js';
import { skipGate } from './helpers.js';

const MYSQL_URL = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const MYSQL_DATABASE = process.env.MYSQL_FIX_CLI_DATABASE ?? 'turbine_dev_fix_cli';
const mysqlGate = skipGate(!MYSQL_URL, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a MySQL 8 server');

const def = defineSchema({
  fcm_defaults: {
    id: { type: 'serial', primaryKey: true },
    role: { type: 'text', notNull: true, default: "'member'" },
    prefs: { type: 'json', default: "'{}'" },
    blobby: { type: 'bytea', default: "'abc'" },
    noted: { type: 'text', default: 'null' },
    scale: { type: 'text', default: '5' },
    flagText: { type: 'text', default: 'true' },
    day: { type: 'date', default: 'now()' },
    today: { type: 'date', default: 'current_date' },
    stamp: { type: 'timestamp', default: 'now()' },
    stampStamp: { type: 'timestamp', default: 'current_timestamp' },
    stampDay: { type: 'timestamp', default: 'current_date' },
    count: { type: 'integer', default: '0' },
    ratio: { type: 'double', default: '0.5' },
    active: { type: 'boolean', default: 'true' },
    label: { type: 'varchar', maxLength: 20, default: "'x'" },
    token: { type: 'uuid', default: 'gen_random_uuid()' },
  },
});

const ddl = (d = def) => schemaToSQL(d, { dialect: mysqlDialect }).join('\n');

describe('MySQL DDL defaults: text', () => {
  const sql = ddl();

  it('writes a literal default on TEXT, JSON and BLOB columns as an expression', () => {
    assert.match(sql, /`role` TEXT NOT NULL DEFAULT \('member'\)/);
    assert.match(sql, /`prefs` JSON DEFAULT \('\{\}'\)/);
    assert.match(sql, /`blobby` BLOB DEFAULT \('abc'\)/);
    assert.match(sql, /`scale` TEXT DEFAULT \(5\)/);
    assert.match(sql, /`flag_text` TEXT DEFAULT \(TRUE\)/);
  });

  it('leaves DEFAULT NULL alone, because that is the one literal those types accept', () => {
    assert.match(sql, /`noted` TEXT DEFAULT NULL/);
    assert.doesNotMatch(sql, /DEFAULT \(NULL\)/);
  });

  it('writes the clock default of a DATE column as CURRENT_DATE in parentheses', () => {
    assert.match(sql, /`day` DATE DEFAULT \(CURRENT_DATE\)/);
    assert.match(sql, /`today` DATE DEFAULT \(CURRENT_DATE\)/);
    assert.doesNotMatch(sql, /DEFAULT NOW\(\)/);
  });

  it('keeps a DATETIME(3) default at the column precision, and wraps CURRENT_DATE', () => {
    assert.match(sql, /`stamp` DATETIME\(3\) DEFAULT CURRENT_TIMESTAMP\(3\)/);
    assert.match(sql, /`stamp_stamp` DATETIME\(3\) DEFAULT CURRENT_TIMESTAMP\(3\)/);
    assert.match(sql, /`stamp_day` DATETIME\(3\) DEFAULT \(CURRENT_DATE\)/);
  });

  it('leaves literals that MySQL accepts as they were', () => {
    assert.match(sql, /`count` INT DEFAULT 0/);
    assert.match(sql, /`ratio` DOUBLE DEFAULT 0\.5/);
    assert.match(sql, /`active` TINYINT\(1\) DEFAULT TRUE/);
    assert.match(sql, /`label` VARCHAR\(20\) DEFAULT 'x'/);
    assert.match(sql, /`token` CHAR\(36\) DEFAULT \(UUID\(\)\)/);
  });

  it('writes the clock default of a TIME column as CURRENT_TIME in parentheses', () => {
    const timed = defineSchema({
      fcm_timed: { id: { type: 'serial', primaryKey: true }, at: { type: 'text', default: 'current_time' } },
    });
    const column = timed.tables.fcm_timed?.columns.at;
    assert.ok(column);
    (column as { type: string }).type = 'TIME';
    assert.match(ddl(timed), /`at` TIME DEFAULT \(CURRENT_TIME\)/);
  });
});

describe('MySQL DDL defaults: other dialects did not move', () => {
  it('PostgreSQL keeps every default exactly as written', () => {
    const sql = schemaToSQL(def).join('\n');
    assert.match(sql, /"role" TEXT NOT NULL DEFAULT 'member'/);
    assert.match(sql, /"prefs" JSONB DEFAULT '\{\}'/);
    assert.match(sql, /"blobby" BYTEA DEFAULT 'abc'/);
    assert.match(sql, /"day" DATE DEFAULT NOW\(\)/);
    assert.match(sql, /"today" DATE DEFAULT CURRENT_DATE/);
    assert.match(sql, /"stamp" TIMESTAMPTZ DEFAULT NOW\(\)/);
    assert.match(sql, /"token" UUID DEFAULT GEN_RANDOM_UUID\(\)/);
    assert.doesNotMatch(sql, /DEFAULT \(/);
  });

  it('SQLite and SQL Server spell them as they did', () => {
    const lite = schemaToSQL(def, { dialect: sqliteDialect }).join('\n');
    assert.match(lite, /"role" TEXT NOT NULL DEFAULT 'member'/);
    assert.match(lite, /"day" TEXT DEFAULT CURRENT_TIMESTAMP/);
    const tsql = schemaToSQL(def, { dialect: mssqlDialect }).join('\n');
    assert.match(tsql, /\[role\] NVARCHAR\(MAX\) NOT NULL DEFAULT 'member'/);
    assert.match(tsql, /\[today\] DATE DEFAULT \(CAST\(SYSDATETIME\(\) AS DATE\)\)/);
  });
});

describe('MySQL DDL defaults: run on a server', () => {
  // biome-ignore lint/suspicious/noExplicitAny: mysql2 is an optional peer, loaded only when the gate is open.
  let pool: any;
  const tables = ['fcm_defaults', 'fcm_timed'];

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
    for (const t of tables) await pool.query(`DROP TABLE IF EXISTS \`${t}\``);
  });

  after(async () => {
    if (!pool) return;
    for (const t of tables) await pool.query(`DROP TABLE IF EXISTS \`${t}\``);
    await pool.end();
  });

  mysqlGate.it('creates the table with every default', async () => {
    for (const stmt of schemaToSQL(def, { dialect: mysqlDialect })) await pool.query(stmt);
  });

  mysqlGate.it('fills the text, JSON and BLOB defaults on insert', async () => {
    await pool.query('INSERT INTO fcm_defaults () VALUES ()');
    const [[row]] = await pool.query('SELECT * FROM fcm_defaults');
    assert.equal(row.role, 'member');
    assert.deepEqual(row.prefs, {});
    assert.equal(Buffer.from(row.blobby).toString(), 'abc');
    assert.equal(row.noted, null);
    assert.equal(row.scale, '5');
    assert.equal(row.flag_text, '1');
  });

  mysqlGate.it('fills the date, datetime, numeric and uuid defaults on insert', async () => {
    const [[row]] = await pool.query('SELECT *, CURRENT_DATE() AS today_db FROM fcm_defaults');
    assert.ok(row.day instanceof Date && row.today instanceof Date);
    assert.equal(row.day.getTime(), row.today.getTime(), 'NOW() and CURRENT_DATE give the same DATE default');
    assert.ok(row.stamp instanceof Date && row.stamp_stamp instanceof Date);
    assert.ok(row.stamp_day instanceof Date);
    assert.equal(Number(row.count), 0);
    assert.equal(Number(row.ratio), 0.5);
    assert.equal(row.active, 1);
    assert.equal(row.label, 'x');
    assert.match(row.token, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  mysqlGate.it('a value written explicitly still replaces the default', async () => {
    await pool.query(`INSERT INTO fcm_defaults (role, prefs) VALUES ('admin', '{"a":1}')`);
    const [rows] = await pool.query(`SELECT role, prefs FROM fcm_defaults WHERE role = 'admin'`);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].prefs, { a: 1 });
  });

  mysqlGate.it('creates a TIME column with a CURRENT_TIME default', async () => {
    const timed = defineSchema({
      fcm_timed: { id: { type: 'serial', primaryKey: true }, at: { type: 'text', default: 'current_time' } },
    });
    const column = timed.tables.fcm_timed?.columns.at;
    assert.ok(column);
    (column as { type: string }).type = 'TIME';
    for (const stmt of schemaToSQL(timed, { dialect: mysqlDialect })) await pool.query(stmt);
    await pool.query('INSERT INTO fcm_timed () VALUES ()');
    const [[row]] = await pool.query('SELECT `at` FROM fcm_timed');
    assert.match(String(row.at), /^\d{2}:\d{2}:\d{2}/);
  });
});
