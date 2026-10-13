/**
 * `createMany({ onConflict })` against real engines: what each one actually
 * writes and returns. Inserts only, updates only and a mix; the per-row
 * expression reading both rows; `where` excluding an existing row; `ignore`;
 * a global filter meeting another tenant's row on the conflict key (it must be
 * neither updated nor returned); PII never returned; chunking past the
 * bind-parameter limit staying all-or-nothing; inside `$transaction`; a
 * composite key; a duplicate key in one call refused with nothing written. Plus
 * the single-row upsert with an atomic operator on a column `create` also
 * supplies, which SQL Server used to reject as an ambiguous column.
 *
 * Engines: SQLite always (node:sqlite); PostgreSQL with DATABASE_URL; MySQL
 * with MYSQL_URL (8.0.19+); SQL Server with MSSQL_URL. Server engines use the
 * database their URL names and only tables prefixed `wcu_`, dropped at the end.
 * No session-level SET is issued.
 *
 * Run: DATABASE_URL=... MYSQL_URL=... MSSQL_URL=... npx tsx --test src/test/wave-c-upsert-live.integration.test.ts
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { UnsupportedFeatureError, ValidationError } from '../errors.js';
import { col, expr, UNSAFE } from '../index.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: engine clients are TurbineClient subclasses loaded dynamically
type Any = any;

const TABLES = ['wcu_items', 'wcu_pairs'];

const DDL = {
  postgresql: [
    'CREATE TABLE wcu_items (id SERIAL PRIMARY KEY, sku TEXT NOT NULL UNIQUE, tenant_id TEXT NOT NULL, qty INT NOT NULL DEFAULT 0, note TEXT, email TEXT)',
    'CREATE TABLE wcu_pairs (id SERIAL PRIMARY KEY, k1 TEXT NOT NULL, k2 INT NOT NULL, v INT NOT NULL, UNIQUE (k1, k2))',
  ],
  sqlite: [
    'CREATE TABLE wcu_items (id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL UNIQUE, tenant_id TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 0, note TEXT, email TEXT)',
    'CREATE TABLE wcu_pairs (id INTEGER PRIMARY KEY AUTOINCREMENT, k1 TEXT NOT NULL, k2 INTEGER NOT NULL, v INTEGER NOT NULL, UNIQUE (k1, k2))',
  ],
  mysql: [
    'CREATE TABLE wcu_items (id INT AUTO_INCREMENT PRIMARY KEY, sku VARCHAR(64) NOT NULL UNIQUE, tenant_id VARCHAR(16) NOT NULL, qty INT NOT NULL DEFAULT 0, note VARCHAR(64) NULL, email VARCHAR(64) NULL)',
    'CREATE TABLE wcu_pairs (id INT AUTO_INCREMENT PRIMARY KEY, k1 VARCHAR(16) NOT NULL, k2 INT NOT NULL, v INT NOT NULL, UNIQUE KEY wcu_pairs_k (k1, k2))',
  ],
  mssql: [
    'CREATE TABLE wcu_items (id INT IDENTITY(1,1) PRIMARY KEY, sku NVARCHAR(64) NOT NULL UNIQUE, tenant_id NVARCHAR(16) NOT NULL, qty INT NOT NULL DEFAULT 0, note NVARCHAR(64) NULL, email NVARCHAR(64) NULL)',
    'CREATE TABLE wcu_pairs (id INT IDENTITY(1,1) PRIMARY KEY, k1 NVARCHAR(16) NOT NULL, k2 INT NOT NULL, v INT NOT NULL, CONSTRAINT wcu_pairs_k UNIQUE (k1, k2))',
  ],
} as const;

type EngineName = keyof typeof DDL;

interface Live {
  name: EngineName;
  skip: string;
  connect(): Promise<void>;
  db(): Any;
  /** A second client on the same database with a tenant filter on wcu_items. */
  filtered(): Promise<Any>;
  close(): Promise<void>;
}

/** Tag `email` as PII, the way a code-first schema would; introspection never does. */
function tagPii(schema: SchemaMetadata): SchemaMetadata {
  const email = schema.tables.wcu_items?.columns.find((c) => c.name === 'email');
  if (email) email.pii = true;
  return schema;
}

const TENANT_FILTER = { wcu_items: { tenantId: 't1' } };

// --- sqlite ----------------------------------------------------------------

const DatabaseSync: (new (path: string) => DatabaseSyncType) | undefined = (() => {
  try {
    return createRequire(process.cwd())('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();

function sqliteLive(): Live {
  let db: DatabaseSyncType;
  let schema: SchemaMetadata;
  let c: Any;
  return {
    name: 'sqlite',
    skip: DatabaseSync ? '' : 'turbine-orm/sqlite requires node:sqlite (Node >= 22.5)',
    async connect() {
      const { introspectSqliteDatabase, turbineSqlite } = await import('../sqlite.js');
      db = new DatabaseSync!(':memory:');
      for (const stmt of DDL.sqlite) db.exec(stmt);
      schema = tagPii(introspectSqliteDatabase(db));
      c = turbineSqlite(db, schema);
    },
    db: () => c,
    async filtered() {
      const { turbineSqlite } = await import('../sqlite.js');
      return turbineSqlite(db, schema, { globalFilters: TENANT_FILTER });
    },
    async close() {
      await c?.disconnect();
    },
  };
}

// --- postgresql ------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL ?? '';

function postgresLive(): Live {
  let raw: pg.Client;
  let schema: SchemaMetadata;
  const clients: TurbineClient[] = [];
  return {
    name: 'postgresql',
    skip: DATABASE_URL ? '' : 'requires DATABASE_URL',
    async connect() {
      raw = new pg.Client({ connectionString: DATABASE_URL });
      await raw.connect();
      await raw.query(`DROP TABLE IF EXISTS ${TABLES.join(', ')} CASCADE`);
      for (const stmt of DDL.postgresql) await raw.query(stmt);
      schema = tagPii(await introspect({ connectionString: DATABASE_URL, include: TABLES }));
      clients.push(new TurbineClient({ connectionString: DATABASE_URL, poolSize: 3 }, schema));
    },
    db: () => clients[0],
    async filtered() {
      const c = new TurbineClient(
        { connectionString: DATABASE_URL, poolSize: 2, globalFilters: TENANT_FILTER },
        schema,
      );
      clients.push(c);
      return c;
    },
    async close() {
      for (const c of clients) await c.disconnect();
      await raw?.query(`DROP TABLE IF EXISTS ${TABLES.join(', ')} CASCADE`);
      await raw?.end();
    },
  };
}

// --- mysql -----------------------------------------------------------------

const MYSQL_URL = process.env.MYSQL_URL ?? '';

function mysqlLive(): Live {
  let rawPool: Any;
  let pool: Any;
  let schema: SchemaMetadata;
  let c: Any;
  const dropAll = async () => {
    for (const t of TABLES) await rawPool.query(`DROP TABLE IF EXISTS \`${t}\``);
  };
  return {
    name: 'mysql',
    skip: MYSQL_URL ? '' : 'requires MYSQL_URL pointing at a MySQL 8.0.19+ database',
    async connect() {
      const { createPool } = await import('mysql2/promise');
      const { MysqlPool, introspectMysqlWith, turbineMysql } = await import('../mysql.js');
      const url = new URL(MYSQL_URL);
      const database = decodeURIComponent(url.pathname.slice(1));
      const base = {
        host: url.hostname,
        port: url.port ? Number(url.port) : 3306,
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
      };
      const admin = createPool(base);
      await admin.query(`CREATE DATABASE IF NOT EXISTS \`${database}\``);
      await admin.end();
      rawPool = createPool({ ...base, database, namedPlaceholders: true, timezone: 'Z' });
      await dropAll();
      for (const stmt of DDL.mysql) await rawPool.query(stmt);
      pool = new MysqlPool(rawPool);
      schema = tagPii(
        await introspectMysqlWith(async (sql, params) => (await pool.query(sql, params)).rows, database, {
          include: TABLES,
        }),
      );
      c = await turbineMysql(pool, schema);
    },
    db: () => c,
    async filtered() {
      const { turbineMysql } = await import('../mysql.js');
      return turbineMysql(pool, schema, { globalFilters: TENANT_FILTER });
    },
    async close() {
      if (rawPool) {
        await dropAll();
        await rawPool.end();
      }
    },
  };
}

// --- mssql -----------------------------------------------------------------

const MSSQL_URL = process.env.MSSQL_URL ?? '';

function mssqlLive(): Live {
  let rawPool: Any;
  let pool: Any;
  let schema: SchemaMetadata;
  let c: Any;
  const dropAll = async () => {
    for (const t of TABLES) await rawPool.request().batch(`IF OBJECT_ID('${t}','U') IS NOT NULL DROP TABLE ${t}`);
  };
  return {
    name: 'mssql',
    skip: MSSQL_URL ? '' : 'requires MSSQL_URL pointing at a SQL Server 2016+ instance',
    async connect() {
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
      await dropAll();
      for (const stmt of DDL.mssql) await rawPool.request().batch(stmt);
      pool = new MssqlPool(rawPool, mssql);
      schema = tagPii(
        await introspectMssqlWith(async (sql, params) => (await pool.query(sql, params)).rows, 'dbo', {
          include: TABLES,
        }),
      );
      c = await turbineMssql(pool, schema);
    },
    db: () => c,
    async filtered() {
      const { turbineMssql } = await import('../mssql.js');
      return turbineMssql(pool, schema, { globalFilters: TENANT_FILTER });
    },
    async close() {
      if (rawPool) {
        await dropAll();
        await rawPool.close();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The battery
// ---------------------------------------------------------------------------

interface Item {
  id: number;
  sku: string;
  tenantId: string;
  qty: number;
  note: string | null;
  email?: string | null;
}

const bySku = (rows: Item[]) =>
  rows
    .map((r) => ({ sku: r.sku, tenantId: r.tenantId, qty: Number(r.qty), note: r.note ?? null }))
    .sort((a, b) => a.sku.localeCompare(b.sku));

const e017 = (err: unknown) => err instanceof UnsupportedFeatureError && err.code === 'TURBINE_E017';

for (const live of [sqliteLive(), postgresLive(), mysqlLive(), mssqlLive()]) {
  const { it, before, after } = skipGate(Boolean(live.skip), live.skip || 'unreachable');
  const mysql = live.name === 'mysql';

  describe(`createMany onConflict on ${live.name}`, () => {
    before(async () => {
      await live.connect();
    });
    after(async () => {
      await live.close();
    });

    const items = () => live.db().table('wcu_items');
    const reset = async (rows: Partial<Item>[] = []) => {
      await items().deleteMany({ where: {}, allowFullTableScan: UNSAFE });
      if (rows.length > 0) await items().createMany({ data: rows });
    };
    const all = async () => bySku((await items().findMany({ orderBy: { sku: 'asc' } })) as Item[]);

    it('a mix of new and existing keys: inserts the new, updates the existing per row, returns both', async () => {
      await reset([{ sku: 'a', tenantId: 't1', qty: 1 }]);
      const out = (await items().createMany({
        data: [
          { sku: 'a', tenantId: 't1', qty: 5 },
          { sku: 'b', tenantId: 't1', qty: 2 },
        ],
        onConflict: { target: ['sku'], update: { qty: expr.add(col('qty'), expr.excluded('qty')) } },
      })) as Item[];
      const expected = [
        { sku: 'a', tenantId: 't1', qty: 6, note: null },
        { sku: 'b', tenantId: 't1', qty: 2, note: null },
      ];
      assert.deepEqual(bySku(out), expected);
      assert.deepEqual(await all(), expected);
    });

    it('all new keys behave as createMany; all existing keys as a per-row update', async () => {
      await reset();
      const inserted = (await items().createMany({
        data: [
          { sku: 'a', tenantId: 't1', qty: 1, note: 'one' },
          { sku: 'b', tenantId: 't1', qty: 2, note: 'two' },
        ],
        onConflict: { target: ['sku'], update: ['qty'] },
      })) as Item[];
      assert.equal(inserted.length, 2);
      const updated = (await items().createMany({
        data: [
          { sku: 'a', tenantId: 't1', qty: 10, note: 'ignored' },
          { sku: 'b', tenantId: 't1', qty: 20, note: 'ignored' },
        ],
        onConflict: { target: ['sku'], update: ['qty'] },
      })) as Item[];
      // Only the listed field takes the incoming value; note keeps its stored one.
      const expected = [
        { sku: 'a', tenantId: 't1', qty: 10, note: 'one' },
        { sku: 'b', tenantId: 't1', qty: 20, note: 'two' },
      ];
      assert.deepEqual(bySku(updated), expected);
      assert.deepEqual(await all(), expected);
    });

    it('where excludes an existing row: it is neither updated nor returned; new rows still insert', async () => {
      await reset([{ sku: 'a', tenantId: 't1', qty: 50 }]);
      const call = () =>
        items().createMany({
          data: [
            { sku: 'a', tenantId: 't1', qty: 1 },
            { sku: 'b', tenantId: 't1', qty: 2 },
          ],
          onConflict: { target: ['sku'], update: ['qty'], where: { qty: { lt: 10 } } },
        });
      if (mysql) {
        await assert.rejects(call(), e017);
        return;
      }
      const out = (await call()) as Item[];
      assert.deepEqual(
        bySku(out).map((r) => r.sku),
        ['b'],
      );
      assert.deepEqual(await all(), [
        { sku: 'a', tenantId: 't1', qty: 50, note: null },
        { sku: 'b', tenantId: 't1', qty: 2, note: null },
      ]);
    });

    it('ignore skips existing keys and returns only the inserted rows', async () => {
      await reset([{ sku: 'a', tenantId: 't1', qty: 50 }]);
      const call = () =>
        items().createMany({
          data: [
            { sku: 'a', tenantId: 't1', qty: 1 },
            { sku: 'b', tenantId: 't1', qty: 2 },
          ],
          onConflict: { target: ['sku'], ignore: true },
        });
      if (mysql) {
        await assert.rejects(call(), e017);
        return;
      }
      assert.deepEqual(
        bySku((await call()) as Item[]).map((r) => r.sku),
        ['b'],
      );
      assert.equal((await all())[0]!.qty, 50);
    });

    it("a global filter keeps the conflict-UPDATE off another tenant's row", async () => {
      await reset([{ sku: 'x', tenantId: 't2', qty: 7, note: 'theirs' }]);
      const filtered = await live.filtered();
      const call = () =>
        filtered.table('wcu_items').createMany({
          data: [
            { sku: 'x', tenantId: 't1', qty: 99, note: 'mine' },
            { sku: 'y', tenantId: 't1', qty: 1, note: null },
          ],
          onConflict: { target: ['sku'], update: ['qty', 'note'] },
        });
      if (mysql) {
        await assert.rejects(call(), e017);
        return;
      }
      const out = (await call()) as Item[];
      // The other tenant's row is not updated and not returned; its key is
      // taken, so no row for it was inserted either.
      assert.deepEqual(
        bySku(out).map((r) => r.sku),
        ['y'],
      );
      assert.deepEqual(await all(), [
        { sku: 'x', tenantId: 't2', qty: 7, note: 'theirs' },
        { sku: 'y', tenantId: 't1', qty: 1, note: null },
      ]);
    });

    it('a PII column is written but never returned, and select cannot name it', async () => {
      await reset([{ sku: 'a', tenantId: 't1', qty: 1, email: 'old@example.test' }]);
      const out = (await items().createMany({
        data: [
          { sku: 'a', tenantId: 't1', qty: 2, email: 'new@example.test' },
          { sku: 'b', tenantId: 't1', qty: 3, email: 'b@example.test' },
        ],
        onConflict: { target: ['sku'], update: ['qty', 'email'] },
      })) as Item[];
      assert.equal(out.length, 2);
      for (const row of out) assert.ok(!('email' in row), `${live.name} returned the PII column`);
      const stored = (await items().findMany({
        select: { sku: true, email: true },
        includePii: UNSAFE,
        orderBy: { sku: 'asc' },
      })) as Item[];
      assert.deepEqual(
        stored.map((r) => r.email),
        ['new@example.test', 'b@example.test'],
      );
      await assert.rejects(
        items().createMany({
          data: [{ sku: 'a', tenantId: 't1', qty: 1 }],
          onConflict: { target: ['sku'], update: ['qty'] },
          select: { email: true },
        }),
        ValidationError,
      );
    });

    it('select narrows the returned rows', async () => {
      await reset();
      const out = (await items().createMany({
        data: [{ sku: 'a', tenantId: 't1', qty: 4 }],
        onConflict: { target: ['sku'], update: ['qty'] },
        select: { sku: true, qty: true },
      })) as Item[];
      assert.deepEqual(
        out.map((r) => ({ ...r, qty: Number(r.qty) })),
        [{ sku: 'a', qty: 4 }],
      );
    });

    it('a duplicate key in one call is refused and nothing is written', async () => {
      await reset();
      await assert.rejects(
        items().createMany({
          data: [
            { sku: 'a', tenantId: 't1', qty: 1 },
            { sku: 'a', tenantId: 't1', qty: 2 },
          ],
          onConflict: { target: ['sku'], update: ['qty'] },
        }),
        (err: unknown) => err instanceof ValidationError && /rows 0 and 1 share the conflict key/.test(err.message),
      );
      assert.deepEqual(await all(), []);
    });

    it('a composite unique key is a target', async () => {
      const pairs = live.db().table('wcu_pairs');
      await pairs.deleteMany({ where: {}, allowFullTableScan: UNSAFE });
      await pairs.createMany({ data: [{ k1: 'a', k2: 1, v: 1 }] });
      await pairs.createMany({
        data: [
          { k1: 'a', k2: 1, v: 10 },
          { k1: 'a', k2: 2, v: 20 },
        ],
        onConflict: { target: ['k2', 'k1'], update: { v: expr.greatest(col('v'), expr.excluded('v')) } },
      });
      const rows = (await pairs.findMany({ orderBy: { k2: 'asc' } })) as { k2: number; v: number }[];
      assert.deepEqual(
        rows.map((r) => [Number(r.k2), Number(r.v)]),
        [
          [1, 10],
          [2, 20],
        ],
      );
    });

    it('inside $transaction: committed with it, rolled back with it', async () => {
      await reset([{ sku: 'a', tenantId: 't1', qty: 1 }]);
      const db = live.db();
      const write = (tx: Any) =>
        tx.table('wcu_items').createMany({
          data: [
            { sku: 'a', tenantId: 't1', qty: 5 },
            { sku: 'b', tenantId: 't1', qty: 6 },
          ],
          onConflict: { target: ['sku'], update: ['qty'] },
        });
      await assert.rejects(
        db.$transaction(async (tx: Any) => {
          await write(tx);
          throw new Error('roll it back');
        }),
        /roll it back/,
      );
      assert.deepEqual(
        (await all()).map((r) => [r.sku, r.qty]),
        [['a', 1]],
      );
      await db.$transaction(async (tx: Any) => {
        await write(tx);
      });
      assert.deepEqual(
        (await all()).map((r) => [r.sku, r.qty]),
        [
          ['a', 5],
          ['b', 6],
        ],
      );
    });

    it('past the bind-parameter limit: chunks commit together or not at all', async (t) => {
      // PostgreSQL binds one array per column (UNNEST), so a call never
      // reaches its limit there.
      if (live.name === 'postgresql') return t.skip('UNNEST binds one parameter per column');
      const pairs = live.db().table('wcu_pairs');
      await pairs.deleteMany({ where: {}, allowFullTableScan: UNSAFE });
      const limit = { sqlite: 32766, mysql: 65535, mssql: 2098 }[live.name];
      const count = Math.ceil(limit / 3) + 50;
      const data = Array.from({ length: count }, (_, i) => ({ k1: 'c', k2: i, v: i }));
      // The LAST row violates NOT NULL, so the last chunk fails after the first committed nothing.
      const poisoned = [...data.slice(0, -1), { k1: 'c', k2: count - 1, v: null }];
      await assert.rejects(pairs.createMany({ data: poisoned, onConflict: { target: ['k1', 'k2'], update: ['v'] } }));
      assert.equal(await pairs.count(), 0, 'the first chunk was rolled back with the failed one');
      const out = await pairs.createMany({ data, onConflict: { target: ['k1', 'k2'], update: ['v'] } });
      assert.equal(await pairs.count(), count);
      assert.equal(out.length, count);
    });

    it('single-row upsert: an atomic operator on a column create also supplies', async () => {
      await reset();
      const call = () =>
        items().upsert({
          where: { sku: 'z' },
          create: { sku: 'z', tenantId: 't1', qty: 1 },
          update: { qty: { increment: 1 } },
        });
      assert.equal(Number((await call()).qty), 1);
      assert.equal(Number((await call()).qty), 2);
    });
  });
}
