/**
 * Engine introspectors and hostile catalog names.
 *
 * The SQLite, MySQL and SQL Server introspectors build records keyed by catalog
 * names. A plain `{}` turns a table named `__proto__` into a prototype
 * assignment (the table disappears) and answers `tables.constructor` with a
 * function; the records are prototype-less, as in the PostgreSQL introspector.
 * Live on SQLite (in-process) and MySQL (MYSQL_URL).
 *
 * Run: MYSQL_URL=... npx tsx --test src/test/sql-engines-introspect.test.ts
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe } from 'node:test';
import { ValidationError } from '../errors.js';
import { introspectMysqlWith, turbineMysql } from '../mysql.js';
import type { SchemaMetadata } from '../schema.js';
import { introspectSqliteDatabase, turbineSqlite } from '../sqlite.js';
import { skipGate } from './helpers.js';

const HAVE_NODE_SQLITE = (() => {
  try {
    createRequire(process.cwd())('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();
const sqlite = skipGate(!HAVE_NODE_SQLITE, 'turbine-orm/sqlite requires node:sqlite (Node >= 22.5)');
const MYSQL_URL = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const mysql = skipGate(!MYSQL_URL, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a MySQL 8 server');

/** Every catalog-keyed record of the schema is prototype-less and holds the hostile names as data. */
function assertHostileNamesKept(schema: SchemaMetadata): void {
  assert.equal(Object.getPrototypeOf(schema.tables), null, 'tables');
  assert.ok(Object.hasOwn(schema.tables, '__proto__'), 'the table named __proto__ is present');
  assert.ok(Object.hasOwn(schema.tables, 'constructor'), 'the table named constructor is present');
  const t = schema.tables['__proto__' as string]!;
  for (const key of ['columnMap', 'reverseColumnMap', 'dialectTypes', 'pgTypes', 'relations'] as const) {
    assert.equal(Object.getPrototypeOf(t[key]), null, key);
  }
  assert.ok(Object.hasOwn(t.reverseColumnMap, 'toString'), 'the column named toString is present');
  const ctor = schema.tables['constructor' as string]!;
  assert.equal(Object.hasOwn(ctor.relations, 'valueOf'), false);
  assert.equal(typeof (ctor.relations as Record<string, unknown>).valueOf, 'undefined');
}

describe('SQLite introspection', () => {
  sqlite.it('keeps tables and columns named after Object.prototype members', async () => {
    const db = turbineSqlite(':memory:', { tables: {}, enums: {} });
    const handle = (db.pool as unknown as { db: Parameters<typeof introspectSqliteDatabase>[0] }).db;
    handle.exec('CREATE TABLE "__proto__" (id INTEGER PRIMARY KEY, "toString" TEXT)');
    handle.exec('CREATE TABLE "constructor" (id INTEGER PRIMARY KEY, label TEXT)');
    assertHostileNamesKept(introspectSqliteDatabase(handle));
    await db.disconnect();
  });

  sqlite.it('refuses two columns that resolve to one field, naming them escaped', async () => {
    const db = turbineSqlite(':memory:', { tables: {}, enums: {} });
    const handle = (db.pool as unknown as { db: Parameters<typeof introspectSqliteDatabase>[0] }).db;
    handle.exec('CREATE TABLE "t\u001b[31m" (id INTEGER PRIMARY KEY, user_id INTEGER, "userId" INTEGER)');
    assert.throws(
      () => introspectSqliteDatabase(handle),
      (err: unknown) =>
        err instanceof ValidationError && /Field collision/.test(err.message) && !err.message.includes('\u001b'),
    );
    await db.disconnect();
  });

  sqlite.it('an error naming a missing table escapes terminal control characters', async () => {
    const db = turbineSqlite(':memory:', { tables: {}, enums: {} });
    const err = await db.pool.query('SELECT * FROM "x\u001b[2Jy"').then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.ok(err instanceof ValidationError);
    assert.ok(!(err as Error).message.includes('\u001b'), 'raw ESC reached the message');
    assert.match((err as Error).message, /\\u001b/);
    await db.disconnect();
  });
});

describe('MySQL introspection', () => {
  mysql.it('keeps tables and columns named after Object.prototype members', async () => {
    const db = await turbineMysql(MYSQL_URL, { tables: {}, enums: {} });
    const pool = (
      db as unknown as { pool: { query(sql: string, p?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> } }
    ).pool;
    try {
      await pool.query('DROP TABLE IF EXISTS `__proto__`, `constructor`');
      await pool.query('CREATE TABLE `__proto__` (id INT PRIMARY KEY, `toString` TEXT)');
      await pool.query('CREATE TABLE `constructor` (id INT PRIMARY KEY, label TEXT)');
      const dbName = new URL(MYSQL_URL).pathname.replace(/^\//, '');
      const schema = await introspectMysqlWith(async (sql, params) => (await pool.query(sql, params)).rows, dbName, {
        include: ['__proto__', 'constructor'],
      });
      assertHostileNamesKept(schema);
      assert.equal(Object.getPrototypeOf(schema.enums), null, 'enums');
    } finally {
      await pool.query('DROP TABLE IF EXISTS `__proto__`, `constructor`');
      await db.disconnect();
    }
  });
});
