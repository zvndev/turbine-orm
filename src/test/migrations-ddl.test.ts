/**
 * `schemaToSQL` per dialect.
 *
 * The code-first schema is written in one vocabulary (`serial`, `varchar` with a
 * `maxLength`, `text`, `json`, `now()`), and each dialect owns what that means.
 * The column type used to be mapped TWICE (once by `schemaToSQL`, again by the
 * dialect's `buildColumnDefinition`), so the second pass rewrote the first
 * pass's output: `INT AUTO_INCREMENT` became `INT`, `VARCHAR(12)` became
 * `VARCHAR(255)`, and on SQL Server `NVARCHAR(MAX)` became `NVARCHAR(255)`.
 *
 * Three layers:
 *   - DDL text for every dialect, plus Postgres byte-for-byte (no database)
 *   - the SQLite DDL executed in-process (node:sqlite)
 *   - the MySQL DDL executed on a live server (MYSQL_URL)
 *
 * SQL Server is checked by DDL text only: there is no server to run it on here.
 *
 * Run: MYSQL_URL=mysql://root@127.0.0.1:3306 npx tsx --test src/test/migrations-ddl.test.ts
 * The MySQL database defaults to `turbine_migrations_ddl`; set
 * MYSQL_DDL_DATABASE to use another.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import { defineSchema } from '../schema-builder.js';
import { schemaToSQL } from '../schema-sql.js';
import { sqliteDialect } from '../sqlite.js';
import { skipGate } from './helpers.js';

const DatabaseSync: (new (path: string) => DatabaseSyncType) | undefined = (() => {
  try {
    return createRequire(process.cwd())('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();

const MYSQL_URL = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const MYSQL_DATABASE = process.env.MYSQL_DDL_DATABASE ?? 'turbine_migrations_ddl';

const schema = defineSchema({
  mig_users: {
    id: { type: 'serial', primaryKey: true },
    email: { type: 'text', notNull: true, unique: true },
    code: { type: 'varchar', maxLength: 12, notNull: true },
    bio: { type: 'text' },
    doc: { type: 'json' },
    ratio: { type: 'double' },
    active: { type: 'boolean', default: 'true' },
    createdAt: { type: 'timestamptz', default: 'now()' },
    seenAt: { type: 'timestamp' },
    touchedAt: { type: 'timestamp', default: 'current_timestamp' },
    token: { type: 'uuid', default: 'gen_random_uuid()' },
  },
  mig_posts: {
    id: { type: 'bigserial', primaryKey: true },
    userId: { type: 'integer', notNull: true, references: { target: 'mig_users.id', onDelete: 'cascade' } },
    title: { type: 'text', notNull: true },
    slug: { type: 'text' },
    indexes: [{ columns: ['slug'] }],
  },
  mig_tags: {
    name: { type: 'text', notNull: true },
    postId: { type: 'bigint', notNull: true, references: 'mig_posts.id' },
    primaryKey: ['name', 'postId'],
  },
  mig_slugs: {
    value: { type: 'text', primaryKey: true },
  },
  mig_pages: {
    pageKey: { type: 'varchar', maxLength: 20, primaryKey: true },
    slugValue: { type: 'text', references: 'mig_slugs.value' },
  },
});

// Defaults that only mean something on SQL Server, kept apart because MySQL
// rejects a bare CURRENT_DATE default on a DATE column.
const tsqlDefaults = defineSchema({
  mig_clock: {
    id: { type: 'serial', primaryKey: true },
    archived: { type: 'boolean', default: 'false' },
    day: { type: 'date', default: 'current_date' },
  },
});

// ---------------------------------------------------------------------------
// DDL text
// ---------------------------------------------------------------------------

describe('schemaToSQL: MySQL', () => {
  const sql = schemaToSQL(schema, { dialect: mysqlDialect }).join('\n');

  it('keeps AUTO_INCREMENT on serial and bigserial primary keys', () => {
    assert.match(sql, /`id` INT AUTO_INCREMENT PRIMARY KEY/);
    assert.match(sql, /`id` BIGINT AUTO_INCREMENT PRIMARY KEY/);
  });

  it('keeps the declared VARCHAR length', () => {
    assert.match(sql, /`code` VARCHAR\(12\) NOT NULL/);
    assert.doesNotMatch(sql, /`code` VARCHAR\(255\)/);
  });

  it('emits text as TEXT, except where it is a key', () => {
    assert.match(sql, /`bio` TEXT,/);
    assert.match(sql, /`title` TEXT NOT NULL/);
    // UNIQUE, a composite primary key member, and a declared-index member would
    // all be ER_BLOB_KEY_WITHOUT_LENGTH as TEXT.
    assert.match(sql, /`email` VARCHAR\(255\) UNIQUE NOT NULL/);
    assert.match(sql, /`name` VARCHAR\(255\) NOT NULL/);
    assert.match(sql, /`slug` VARCHAR\(255\)/);
    // A foreign key column has to match the VARCHAR it references, so it is a key too.
    assert.match(sql, /`slug_value` VARCHAR\(255\)/);
    assert.match(sql, /`value` VARCHAR\(255\) PRIMARY KEY/);
    assert.doesNotMatch(sql, /`email` TEXT|`name` TEXT|`slug` TEXT|`slug_value` TEXT/);
  });

  it('declares foreign keys at table level, with their actions', () => {
    assert.match(sql, /FOREIGN KEY \(`user_id`\) REFERENCES `mig_users`\(`id`\) ON DELETE CASCADE/);
    assert.match(sql, /FOREIGN KEY \(`post_id`\) REFERENCES `mig_posts`\(`id`\)/);
    assert.doesNotMatch(sql, /`user_id` INT NOT NULL REFERENCES/, 'an inline REFERENCES is ignored by MySQL 8.0');
  });

  it('writes defaults MySQL can run', () => {
    assert.match(sql, /`token` CHAR\(36\) DEFAULT \(UUID\(\)\)/);
    assert.match(sql, /`active` TINYINT\(1\) DEFAULT TRUE/);
    assert.doesNotMatch(sql, /GEN_RANDOM_UUID/i);
  });

  it('keeps milliseconds: timestamps are DATETIME(3) and their NOW() default carries the same precision', () => {
    assert.match(sql, /`created_at` DATETIME\(3\) DEFAULT CURRENT_TIMESTAMP\(3\)/);
    assert.match(sql, /`seen_at` DATETIME\(3\),/);
    assert.match(sql, /`touched_at` DATETIME\(3\) DEFAULT CURRENT_TIMESTAMP\(3\)/);
    assert.doesNotMatch(sql, /DATETIME[,\s]|DEFAULT NOW\(\)|DEFAULT CURRENT_TIMESTAMP[,\s]/);
  });

  it('writes the clock default of a date column as an expression, which MySQL accepts', () => {
    const dated = defineSchema({
      mig_dated: { id: { type: 'serial', primaryKey: true }, on: { type: 'date', default: 'now()' } },
    });
    const ddl = schemaToSQL(dated, { dialect: mysqlDialect }).join('\n');
    assert.match(ddl, /`on` DATE DEFAULT \(CURRENT_DATE\)/);
    assert.doesNotMatch(ddl, /DEFAULT NOW\(\)/);
  });
});

describe('schemaToSQL: SQLite', () => {
  const sql = schemaToSQL(schema, { dialect: sqliteDialect }).join('\n');

  it('uses AUTOINCREMENT for serial and bigserial primary keys', () => {
    assert.equal((sql.match(/INTEGER PRIMARY KEY AUTOINCREMENT/g) ?? []).length, 2);
  });

  it('maps varchar, text, json and double to their affinities', () => {
    assert.match(sql, /"code" TEXT NOT NULL/);
    assert.match(sql, /"doc" TEXT,/);
    assert.match(sql, /"ratio" REAL,/);
  });

  it('writes defaults SQLite can run', () => {
    assert.match(sql, /"created_at" TEXT DEFAULT CURRENT_TIMESTAMP/);
    assert.match(sql, /"token" TEXT DEFAULT \(lower\(hex\(randomblob/);
    assert.doesNotMatch(sql, /NOW\(\)|GEN_RANDOM_UUID/i);
  });

  it('keeps inline foreign keys, which SQLite enforces', () => {
    assert.match(sql, /"user_id" INTEGER NOT NULL REFERENCES "mig_users"\("id"\) ON DELETE CASCADE/);
  });
});

describe('schemaToSQL: SQL Server (DDL text only, not run against a server)', () => {
  const sql = schemaToSQL(schema, { dialect: mssqlDialect }).join('\n');

  it('keeps IDENTITY on serial and bigserial primary keys', () => {
    assert.match(sql, /\[id\] INT IDENTITY\(1,1\) PRIMARY KEY/);
    assert.match(sql, /\[id\] BIGINT IDENTITY\(1,1\) PRIMARY KEY/);
  });

  it('keeps the declared NVARCHAR length', () => {
    assert.match(sql, /\[code\] NVARCHAR\(12\) NOT NULL/);
  });

  it('does not truncate text and json to 255 characters', () => {
    assert.match(sql, /\[bio\] NVARCHAR\(MAX\),/);
    assert.match(sql, /\[doc\] NVARCHAR\(MAX\),/);
    assert.match(sql, /\[title\] NVARCHAR\(MAX\) NOT NULL/);
  });

  it('keeps DOUBLE as FLOAT and timestamptz as DATETIMEOFFSET', () => {
    assert.match(sql, /\[ratio\] FLOAT,/);
    assert.match(sql, /\[created_at\] DATETIMEOFFSET DEFAULT CURRENT_TIMESTAMP/);
    assert.doesNotMatch(sql, /\[ratio\] REAL|DATETIME2/);
  });

  it('bounds text only where an index key needs it', () => {
    assert.match(sql, /\[email\] NVARCHAR\(255\) UNIQUE NOT NULL/);
    assert.match(sql, /\[name\] NVARCHAR\(255\) NOT NULL/);
    assert.match(sql, /\[slug\] NVARCHAR\(255\)/);
    assert.match(sql, /\[slug_value\] NVARCHAR\(255\)/);
  });

  it('writes defaults T-SQL can run', () => {
    assert.match(sql, /\[token\] UNIQUEIDENTIFIER DEFAULT NEWID\(\)/);
    assert.match(sql, /\[active\] BIT DEFAULT 1/);
    assert.doesNotMatch(sql, /GEN_RANDOM_UUID|NOW\(\)|DEFAULT TRUE/i);
  });

  it('writes the boolean and date defaults T-SQL has no literal for', () => {
    const clock = schemaToSQL(tsqlDefaults, { dialect: mssqlDialect }).join('\n');
    assert.match(clock, /\[archived\] BIT DEFAULT 0/);
    assert.match(clock, /\[day\] DATE DEFAULT \(CAST\(SYSDATETIME\(\) AS DATE\)\)/);
    assert.doesNotMatch(clock, /DEFAULT (FALSE|CURRENT_DATE)\b/i);
  });
});

describe('schemaToSQL: PostgreSQL is unchanged', () => {
  const sql = schemaToSQL(schema).join('\n');

  it('emits the Postgres types and an inline REFERENCES', () => {
    assert.match(sql, /"id" SERIAL PRIMARY KEY/);
    assert.match(sql, /"id" BIGSERIAL PRIMARY KEY/);
    assert.match(sql, /"code" VARCHAR\(12\) NOT NULL/);
    assert.match(sql, /"email" TEXT UNIQUE NOT NULL/);
    assert.match(sql, /"doc" JSONB,/);
    assert.match(sql, /"created_at" TIMESTAMPTZ DEFAULT NOW\(\)/);
    assert.match(sql, /"token" UUID DEFAULT GEN_RANDOM_UUID\(\)/);
    assert.match(sql, /"active" BOOLEAN DEFAULT TRUE/);
    assert.match(sql, /"user_id" INTEGER NOT NULL REFERENCES "mig_users"\("id"\) ON DELETE CASCADE/);
    assert.doesNotMatch(sql, /FOREIGN KEY \(/);
  });

  it('keeps enum, array and vector columns as Postgres tokens', () => {
    const exotic = defineSchema(
      {
        mig_exotic: {
          id: { type: 'serial', primaryKey: true },
          level: { type: 'enum', enumName: 'mig_level' },
          tags: { type: 'text', array: true },
        },
      },
      { enums: { mig_level: ['low', 'high'] } },
    );
    const out = schemaToSQL(exotic).join('\n');
    assert.match(out, /CREATE TYPE "mig_level" AS ENUM \('low', 'high'\);/);
    assert.match(out, /"level" "mig_level"/);
    assert.match(out, /"tags" TEXT\[\]/);
  });
});

// ---------------------------------------------------------------------------
// SQLite, executed
// ---------------------------------------------------------------------------

const sqliteGate = skipGate(!DatabaseSync, 'requires node:sqlite (Node >= 22.5)');

describe('schemaToSQL DDL runs on SQLite', () => {
  let db: DatabaseSyncType;

  before(() => {
    if (!DatabaseSync) return;
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const stmt of schemaToSQL(schema, { dialect: sqliteDialect })) db.exec(stmt);
  });

  sqliteGate.it('assigns ids and never reuses one after a delete (AUTOINCREMENT)', () => {
    const insert = db.prepare(`INSERT INTO mig_users (email, code) VALUES (?, ?)`);
    insert.run('a@x', 'a');
    insert.run('b@x', 'b');
    db.exec(`DELETE FROM mig_users WHERE email = 'b@x'`);
    insert.run('c@x', 'c');
    const rows = (
      db.prepare(`SELECT id, email FROM mig_users ORDER BY id`).all() as Array<{ id: number; email: string }>
    ).map((r) => ({ ...r }));
    assert.deepEqual(rows, [
      { id: 1, email: 'a@x' },
      { id: 3, email: 'c@x' },
    ]);
  });

  sqliteGate.it('fills the timestamp and uuid defaults', () => {
    const row = db.prepare(`SELECT created_at, token FROM mig_users WHERE email = 'a@x'`).get() as {
      created_at: string;
      token: string;
    };
    assert.match(row.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.match(row.token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  sqliteGate.it('enforces the foreign key and its ON DELETE CASCADE', () => {
    assert.throws(() => db.exec(`INSERT INTO mig_posts (user_id, title) VALUES (999, 't')`), /FOREIGN KEY/i);
    db.exec(`INSERT INTO mig_posts (user_id, title) VALUES (1, 't')`);
    db.exec(`DELETE FROM mig_users WHERE id = 1`);
    const left = db.prepare(`SELECT COUNT(*) AS n FROM mig_posts`).get() as { n: number };
    assert.equal(left.n, 0);
  });

  sqliteGate.it('creates the declared index', () => {
    const names = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{ name: string }>
    ).map((r) => r.name);
    assert.ok(names.includes('idx_mig_posts_slug'), names.join(', '));
  });
});

// ---------------------------------------------------------------------------
// MySQL, executed
// ---------------------------------------------------------------------------

const mysqlGate = skipGate(!MYSQL_URL, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a MySQL 8 server');

describe('schemaToSQL DDL runs on MySQL', () => {
  // biome-ignore lint/suspicious/noExplicitAny: mysql2 is an optional peer, loaded only when the gate is open.
  let pool: any;
  const tables = ['mig_pages', 'mig_slugs', 'mig_tags', 'mig_posts', 'mig_users'];

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
    await pool.query('SET FOREIGN_KEY_CHECKS=0');
    for (const t of tables) await pool.query(`DROP TABLE IF EXISTS \`${t}\``);
    await pool.query('SET FOREIGN_KEY_CHECKS=1');
    for (const stmt of schemaToSQL(schema, { dialect: mysqlDialect })) await pool.query(stmt);
  });

  after(async () => {
    if (!pool) return;
    await pool.query('SET FOREIGN_KEY_CHECKS=0');
    for (const t of tables) await pool.query(`DROP TABLE IF EXISTS \`${t}\``);
    await pool.query('SET FOREIGN_KEY_CHECKS=1');
    await pool.end();
  });

  mysqlGate.it('assigns an id to a row inserted without one', async () => {
    const [res] = await pool.query(`INSERT INTO mig_users (email, code) VALUES ('a@x', 'a')`);
    assert.equal(res.insertId, 1);
    const [res2] = await pool.query(`INSERT INTO mig_users (email, code) VALUES ('b@x', 'b')`);
    assert.equal(res2.insertId, 2);
  });

  mysqlGate.it('enforces the declared VARCHAR(12) length', async () => {
    await assert.rejects(
      pool.query(`INSERT INTO mig_users (email, code) VALUES ('c@x', 'this-is-longer-than-12')`),
      /Data too long/,
    );
  });

  mysqlGate.it('stores a 1,000-character text value whole', async () => {
    const long = 'x'.repeat(1000);
    await pool.query(`UPDATE mig_users SET bio = ? WHERE email = 'a@x'`, [long]);
    const [rows] = await pool.query(`SELECT bio FROM mig_users WHERE email = 'a@x'`);
    assert.equal(rows[0].bio.length, 1000);
  });

  mysqlGate.it('enforces the unique text column (it is VARCHAR, not TEXT)', async () => {
    await assert.rejects(pool.query(`INSERT INTO mig_users (email, code) VALUES ('a@x', 'z')`), /Duplicate entry/);
  });

  mysqlGate.it('fills the timestamp, boolean and uuid defaults', async () => {
    const [rows] = await pool.query(`SELECT created_at, active, token FROM mig_users WHERE email = 'a@x'`);
    assert.ok(rows[0].created_at instanceof Date);
    assert.equal(rows[0].active, 1);
    assert.match(rows[0].token, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  mysqlGate.it(
    'stores the .123 of a timestamp, and the column and its default are both millisecond precision',
    async () => {
      const [cols] = await pool.query(
        `SELECT column_name AS name, datetime_precision AS prec, column_default AS dflt
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'mig_users' AND column_name IN ('created_at', 'seen_at')`,
        [MYSQL_DATABASE],
      );
      const byName = Object.fromEntries(
        cols.map((c: { name: string; prec: number; dflt: string | null }) => [c.name, c]),
      );
      assert.equal(Number(byName.created_at.prec), 3, 'created_at is not DATETIME(3)');
      assert.equal(Number(byName.seen_at.prec), 3, 'seen_at is not DATETIME(3)');
      assert.match(String(byName.created_at.dflt), /^CURRENT_TIMESTAMP\(3\)$/i);

      // As written in SQL ...
      await pool.query(`UPDATE mig_users SET seen_at = '2026-03-04 05:06:07.123' WHERE email = 'a@x'`);
      const [[literal]] = await pool.query(
        `SELECT DATE_FORMAT(seen_at, '%Y-%m-%d %H:%i:%s.%f') AS shown FROM mig_users WHERE email = 'a@x'`,
      );
      assert.equal(literal.shown, '2026-03-04 05:06:07.123000');

      // ... and as a JS Date through the driver, the way the ORM binds it.
      const at = new Date(Date.UTC(2026, 6, 15, 12, 0, 0, 123));
      await pool.query(`UPDATE mig_users SET seen_at = ? WHERE email = 'a@x'`, [at]);
      const [[bound]] = await pool.query(`SELECT seen_at FROM mig_users WHERE email = 'a@x'`);
      assert.equal(bound.seen_at.getTime(), at.getTime(), 'the .123 was rounded away');
      assert.equal(bound.seen_at.getMilliseconds(), 123);
    },
  );

  mysqlGate.it('creates real foreign keys, and enforces them with the declared CASCADE', async () => {
    const [fk] = await pool.query(
      `SELECT delete_rule AS delete_rule FROM information_schema.referential_constraints
       WHERE constraint_schema = ? AND table_name = 'mig_posts'`,
      [MYSQL_DATABASE],
    );
    assert.equal(fk.length, 1, 'mig_posts has no foreign key constraint');
    assert.equal(fk[0].delete_rule, 'CASCADE');
    await assert.rejects(
      pool.query(`INSERT INTO mig_posts (user_id, title) VALUES (999, 't')`),
      /foreign key constraint/i,
    );
    await pool.query(`INSERT INTO mig_posts (user_id, title) VALUES (2, 't')`);
    await pool.query(`DELETE FROM mig_users WHERE id = 2`);
    const [left] = await pool.query(`SELECT COUNT(*) AS n FROM mig_posts`);
    assert.equal(Number(left[0].n), 0);
  });

  mysqlGate.it('accepts the composite primary key with a text member', async () => {
    await pool.query(`INSERT INTO mig_posts (user_id, title) VALUES (1, 't')`);
    const [[post]] = await pool.query(`SELECT id FROM mig_posts LIMIT 1`);
    await pool.query(`INSERT INTO mig_tags (name, post_id) VALUES ('x', ?)`, [post.id]);
    await assert.rejects(
      pool.query(`INSERT INTO mig_tags (name, post_id) VALUES ('x', ?)`, [post.id]),
      /Duplicate entry/,
    );
  });
});
