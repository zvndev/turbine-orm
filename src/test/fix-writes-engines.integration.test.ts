/**
 * Single-row writes and createMany against real engines.
 *
 * - MySQL `create` never returns a row it did not insert: a key filled by a
 *   non-numbering default is refused before the INSERT, and a number bound to a
 *   text key is re-read as text.
 * - MySQL `upsert` updates the row `where` names even when `create` also sets
 *   another unique key.
 * - MySQL `update` returns the row when the write moves it out of `where`, and
 *   inside `$transaction` a refused write leaves nothing behind when the error
 *   is caught.
 * - `createMany` chunks on SQL Server by rows and parameters, and is all or
 *   nothing inside `$transaction` on MySQL.
 * - Two rows sharing an onConflict key only under a collation are E003.
 *
 * Gated per engine: DATABASE_URL (PostgreSQL), MYSQL_URL, MSSQL_URL. Tables are
 * prefixed `fwe_` and dropped afterwards; each server engine uses the database
 * in its URL.
 *
 * Run: DATABASE_URL=... MYSQL_URL=... MSSQL_URL=... npx tsx --test src/test/fix-writes-engines.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { NotFoundError, UnsupportedFeatureError, ValidationError } from '../errors.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: live harness drives untyped clients
type Any = any;

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const MYSQL_URL = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const MSSQL_URL = process.env.MSSQL_URL ?? '';

/** The error `fn` rejected with, or a failure if it resolved. */
async function thrown(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  assert.fail('expected the call to throw');
}

// ---------------------------------------------------------------------------
// MySQL
// ---------------------------------------------------------------------------

describe('MySQL single-row writes and createMany (live)', () => {
  const gate = skipGate(!MYSQL_URL, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a MySQL 8 server');
  const TABLES = ['fwe_acct', 'fwe_auto', 'fwe_named', 'fwe_tasks', 'fwe_codes', 'fwe_bulk', 'fwe_ci'];
  let schema: SchemaMetadata;
  let db: Any;
  let raw: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
  const clients: Any[] = [];
  const client = async (options: Record<string, unknown> = {}): Promise<Any> => {
    const { turbineMysql } = await import('../mysql.js');
    const c = await turbineMysql(MYSQL_URL, schema, { warnOnUnlimited: false, ...options } as never);
    clients.push(c);
    return c;
  };

  gate.before(async () => {
    const { introspectMysqlWith, turbineMysql } = await import('../mysql.js');
    const probe: Any = await turbineMysql(MYSQL_URL, { tables: {}, enums: {} });
    clients.push(probe);
    raw = async (sql, params = []) => (await probe.pool.query(sql, params)).rows;
    for (const t of TABLES) await raw(`DROP TABLE IF EXISTS ${t}`);
    await raw(
      'CREATE TABLE fwe_acct (id CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY, org_id INT NOT NULL, secret VARCHAR(64))',
    );
    await raw('CREATE TABLE fwe_auto (id INT AUTO_INCREMENT PRIMARY KEY, label VARCHAR(20))');
    await raw('CREATE TABLE fwe_named (id INT PRIMARY KEY, name VARCHAR(20) NOT NULL UNIQUE, status VARCHAR(20))');
    await raw('CREATE TABLE fwe_tasks (id INT PRIMARY KEY, status VARCHAR(20), deleted_at DATETIME(3) NULL)');
    await raw('CREATE TABLE fwe_codes (id INT PRIMARY KEY, code VARCHAR(20) NOT NULL, n INT)');
    await raw('CREATE TABLE fwe_bulk (id INT PRIMARY KEY, a INT)');
    await raw('CREATE TABLE fwe_ci (code VARCHAR(20) PRIMARY KEY, n INT)');
    const dbName = decodeURIComponent(new URL(MYSQL_URL).pathname.slice(1));
    schema = await introspectMysqlWith(async (sql, params) => raw(sql, params), dbName, { include: TABLES });
    // Metadata that claims a uniqueness the table does not enforce (stale
    // metadata), so an `update` by `code` can reach two rows.
    schema.tables.fwe_codes!.uniqueColumns.push(['code']);
    db = await client();
  });

  gate.after(async () => {
    if (raw) for (const t of TABLES) await raw(`DROP TABLE IF EXISTS ${t}`);
    for (const c of clients) await c.disconnect();
  });

  gate.it(
    "create on a DEFAULT (UUID()) key is refused before the INSERT, never returning another tenant's row",
    async () => {
      await raw('DELETE FROM fwe_acct');
      await raw(
        `INSERT INTO fwe_acct (id, org_id, secret) VALUES ('0zz', 1, 'tenant-1-zero'), ('abc', 1, 'tenant-1-abc')`,
      );
      const tenant2 = await client({ globalFilters: { fwe_acct: () => ({ orgId: 2 }) } });
      const err = await thrown(() => tenant2.table('fwe_acct').create({ data: { orgId: 2, secret: 'tenant-2' } }));
      assert.ok(err instanceof UnsupportedFeatureError, String(err));
      assert.match((err as Error).message, /without "id" in data/);
      assert.deepEqual(await raw('SELECT COUNT(*) AS n FROM fwe_acct'), [{ n: 2 }], 'nothing was inserted');
      const own = await tenant2.table('fwe_acct').create({ data: { id: 'k-2', orgId: 2, secret: 'tenant-2' } });
      assert.deepEqual(own, { id: 'k-2', orgId: 2, secret: 'tenant-2' });
    },
  );

  gate.it('a number written to a text key is re-read as text, not matched numerically', async () => {
    await raw('DELETE FROM fwe_acct');
    await raw(`INSERT INTO fwe_acct (id, org_id, secret) VALUES ('0zz', 1, 'other')`);
    const row = await db.table('fwe_acct').create({ data: { id: 0, orgId: 3, secret: 'mine' } });
    assert.deepEqual(row, { id: '0', orgId: 3, secret: 'mine' });
  });

  gate.it('an AUTO_INCREMENT key is re-read by the generated id', async () => {
    const a = await db.table('fwe_auto').create({ data: { label: 'a' } });
    const b = await db.table('fwe_auto').create({ data: { label: 'b' } });
    assert.equal(b.id, a.id + 1);
    assert.equal(b.label, 'b');
  });

  gate.it('upsert updates the row where names, not the one another unique key in create collides with', async () => {
    await raw('DELETE FROM fwe_named');
    await raw(`INSERT INTO fwe_named VALUES (1, 'a', 'old'), (2, 'b', 'old')`);
    const row = await db.table('fwe_named').upsert({
      where: { name: 'a' },
      create: { id: 2, name: 'a', status: 'new' },
      update: { status: 'updated' },
    });
    assert.deepEqual(row, { id: 1, name: 'a', status: 'updated' });
    assert.deepEqual(await raw('SELECT id, status FROM fwe_named ORDER BY id'), [
      { id: 1, status: 'updated' },
      { id: 2, status: 'old' },
    ]);
    const created = await db.table('fwe_named').upsert({
      where: { name: 'c' },
      create: { id: 3, name: 'c', status: 'new' },
      update: { status: 'updated' },
    });
    assert.deepEqual(created, { id: 3, name: 'c', status: 'new' });
  });

  gate.it('update returns the row when the write moves it out of where', async () => {
    await raw('DELETE FROM fwe_tasks');
    await raw(`INSERT INTO fwe_tasks VALUES (1, 'open', NULL), (2, 'open', NULL), (3, 'open', NULL)`);
    const tasks = db.table('fwe_tasks');
    assert.equal(
      (await tasks.update({ where: { id: 1, NOT: { status: 'done' } }, data: { status: 'done' } })).status,
      'done',
    );
    assert.equal((await tasks.update({ where: { id: 2 }, data: { id: { increment: 100 } } })).id, 102);
    const soft = await client({ globalFilters: { fwe_tasks: { deletedAt: null } } });
    const deleted = await soft.table('fwe_tasks').update({ where: { id: 3 }, data: { deletedAt: new Date() } });
    assert.ok(deleted.deletedAt instanceof Date);
    assert.deepEqual(await raw('SELECT id FROM fwe_tasks ORDER BY id'), [{ id: 1 }, { id: 3 }, { id: 102 }]);
  });

  gate.it('a key changed by an expression is refused and changes nothing', async () => {
    const { col, expr } = await import('../index.js');
    const err = await thrown(() =>
      db.table('fwe_tasks').update({ where: { id: 1 }, data: { id: expr.add(col('id'), 5) } }),
    );
    assert.ok(err instanceof UnsupportedFeatureError, String(err));
    assert.deepEqual(await raw('SELECT id FROM fwe_tasks WHERE id IN (1, 6) ORDER BY id'), [{ id: 1 }]);
  });

  gate.it('inside $transaction, a write refused after its statement ran is rolled back even when caught', async () => {
    await raw('DELETE FROM fwe_codes');
    await raw(`INSERT INTO fwe_codes VALUES (1, 'x', 0), (2, 'x', 0)`);
    // The UPDATE reaches both rows; the re-read sees two and refuses.
    const outcome = await db.$transaction(async (tx: Any) => {
      try {
        await tx.table('fwe_codes').update({ where: { code: 'x' }, data: { n: 9 } });
        return 'no error';
      } catch (e) {
        return (e as Error).constructor.name;
      }
    });
    assert.equal(outcome, 'UnsupportedFeatureError');
    assert.deepEqual(
      await raw('SELECT n FROM fwe_codes ORDER BY id'),
      [{ n: 0 }, { n: 0 }],
      'the UPDATE was rolled back',
    );
  });

  gate.it('a chunked createMany inside $transaction is all or nothing when its error is caught', async () => {
    await raw('DELETE FROM fwe_bulk');
    const rows = Array.from({ length: 40_000 }, (_, i) => ({ id: i + 1, a: i }));
    rows[35_000] = { id: 5, a: 0 };
    const outcome = await db.$transaction(async (tx: Any) => {
      try {
        await tx.table('fwe_bulk').createMany({ data: rows });
        return 'no error';
      } catch (e) {
        return (e as Error).constructor.name;
      }
    });
    assert.equal(outcome, 'UniqueConstraintError');
    assert.deepEqual(await raw('SELECT COUNT(*) AS n FROM fwe_bulk'), [{ n: 0 }]);
  });

  gate.it('two onConflict rows equal under the collation are E003 and write nothing', async () => {
    await raw('DELETE FROM fwe_ci');
    const err = await thrown(() =>
      db.table('fwe_ci').createMany({
        data: [
          { code: 'A', n: 1 },
          { code: 'a', n: 2 },
        ],
        onConflict: { target: ['code'], update: ['n'] },
      }),
    );
    assert.ok(err instanceof ValidationError, String(err));
    assert.match((err as Error).message, /two rows in this call share the conflict key \(code\)/);
    assert.deepEqual(await raw('SELECT COUNT(*) AS n FROM fwe_ci'), [{ n: 0 }]);
  });

  gate.it('an update whose where matches nothing is still NotFoundError', async () => {
    const err = await thrown(() =>
      db.table('fwe_tasks').update({ where: { id: 999, NOT: { status: 'x' } }, data: { status: 'x' } }),
    );
    assert.ok(err instanceof NotFoundError, String(err));
  });
});

// ---------------------------------------------------------------------------
// SQL Server
// ---------------------------------------------------------------------------

describe('SQL Server createMany (live)', () => {
  const gate = skipGate(!MSSQL_URL, 'requires MSSQL_URL pointing at a SQL Server 2016+ instance');
  const TABLES = ['fwe_one', 'fwe_two', 'fwe_three', 'fwe_ci'];
  let rawPool: Any;
  let db: Any;
  const batch = (sql: string) => rawPool.request().batch(sql);

  gate.before(async () => {
    const specifier: string = 'mssql';
    const mod: Any = await import(specifier);
    const mssql = mod.default ?? mod;
    const { MssqlPool, introspectMssqlWith, turbineMssql } = await import('../mssql.js');
    const url = new URL(MSSQL_URL);
    const database = decodeURIComponent(url.pathname.slice(1));
    const base = {
      server: url.hostname,
      port: url.port ? Number(url.port) : 1433,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      options: { encrypt: false, trustServerCertificate: true },
    };
    const admin = await new mssql.ConnectionPool({ ...base, database: 'master' }).connect();
    await admin.request().batch(`IF DB_ID('${database}') IS NULL CREATE DATABASE [${database}]`);
    await admin.close();
    rawPool = await new mssql.ConnectionPool({ ...base, database }).connect();
    for (const t of TABLES) await batch(`IF OBJECT_ID('${t}','U') IS NOT NULL DROP TABLE ${t}`);
    await batch('CREATE TABLE fwe_one (id INT PRIMARY KEY)');
    await batch('CREATE TABLE fwe_two (id INT PRIMARY KEY, a INT)');
    await batch('CREATE TABLE fwe_three (id INT PRIMARY KEY, a INT, b INT)');
    await batch('CREATE TABLE fwe_ci (code NVARCHAR(20) PRIMARY KEY, n INT)');
    const pool = new MssqlPool(rawPool, mssql);
    const schema = await introspectMssqlWith(async (sql, params) => (await pool.query(sql, params)).rows, 'dbo', {
      include: TABLES,
    });
    db = await turbineMssql(pool, schema, { warnOnUnlimited: false } as never);
  });

  gate.after(async () => {
    if (!rawPool) return;
    for (const t of TABLES) await batch(`IF OBJECT_ID('${t}','U') IS NOT NULL DROP TABLE ${t}`);
    await rawPool.close();
  });

  for (const [table, rows, cols] of [
    ['fwe_one', 1200, ['id']],
    ['fwe_two', 1050, ['id', 'a']],
    ['fwe_three', 800, ['id', 'a', 'b']],
  ] as const) {
    gate.it(
      `${rows} rows x ${cols.length} columns are inserted and returned (row cap and parameter limit)`,
      async () => {
        const data = Array.from({ length: rows }, (_, i) => Object.fromEntries(cols.map((c) => [c, i + 1])));
        const out = await db.table(table).createMany({ data });
        assert.equal(out.length, rows);
        const counted = await rawPool.request().query(`SELECT COUNT(*) AS n FROM ${table}`);
        assert.equal(counted.recordset[0].n, rows);
      },
    );
  }

  gate.it(
    'two onConflict rows equal under the collation, over an existing key, are E003 and change nothing',
    async () => {
      await batch(`DELETE FROM fwe_ci; INSERT INTO fwe_ci (code, n) VALUES ('B', 0)`);
      const err = await thrown(() =>
        db.table('fwe_ci').createMany({
          data: [
            { code: 'B', n: 1 },
            { code: 'b', n: 2 },
          ],
          onConflict: { target: ['code'], update: ['n'] },
        }),
      );
      assert.ok(err instanceof ValidationError, String(err));
      assert.match((err as Error).message, /two rows in this call share the conflict key \(code\)/);
      const rows = await rawPool.request().query('SELECT code, n FROM fwe_ci');
      assert.deepEqual(rows.recordset, [{ code: 'B', n: 0 }]);
    },
  );
});

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

describe('PostgreSQL createMany onConflict (live)', () => {
  const gate = skipGate(!DATABASE_URL, 'requires DATABASE_URL pointing at a PostgreSQL database');
  let db: TurbineClient | undefined;
  let admin: pg.Client | undefined;

  gate.before(async () => {
    admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query('CREATE EXTENSION IF NOT EXISTS citext');
    await admin.query('DROP TABLE IF EXISTS fwe_ci');
    await admin.query('CREATE TABLE fwe_ci (code citext PRIMARY KEY, n int)');
    const schema = await introspect({ connectionString: DATABASE_URL, include: ['fwe_ci'] });
    db = new TurbineClient({ connectionString: DATABASE_URL, warnOnUnlimited: false }, schema);
  });

  gate.after(async () => {
    await db?.disconnect();
    await admin?.query('DROP TABLE IF EXISTS fwe_ci');
    await admin?.end();
  });

  gate.it('two rows equal under citext are E003 (SQLSTATE 21000) and write nothing', async () => {
    const err = await thrown(() =>
      (db as Any).table('fwe_ci').createMany({
        data: [
          { code: 'A', n: 1 },
          { code: 'a', n: 2 },
        ],
        onConflict: { target: ['code'], update: ['n'] },
      }),
    );
    assert.ok(err instanceof ValidationError, String(err));
    assert.match((err as Error).message, /two rows in this call share the conflict key \(code\)/);
    assert.equal(
      (err as Error & { cause?: { code?: string; sqlstate?: string } }).cause?.sqlstate ?? (err as Any).cause?.code,
      '21000',
    );
    const rows = await admin!.query('SELECT count(*)::int AS n FROM fwe_ci');
    assert.equal(rows.rows[0].n, 0);
  });
});
