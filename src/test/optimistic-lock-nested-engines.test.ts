/**
 * `optimisticLock` on an `update` whose `data` carries relation writes, on
 * every engine that runs nested writes. The parent's versioned UPDATE runs
 * first, so a stale version is E015 with nothing written, a version column in
 * `data` is E003 before the nested engine runs (middleware sees no inner
 * statement), a relation-only write bumps the version once, and a failing
 * relation write takes the bump back with it: the implicit transaction rolls
 * back, and inside a caller's `$transaction` the write's savepoint does, so the
 * caller can catch and carry on.
 *
 * Engines: SQLite always (node:sqlite); PostgreSQL with DATABASE_URL (RETURNING);
 * MySQL with MYSQL_URL (the write and its re-read, in a database of its own);
 * SQL Server with MSSQL_URL (OUTPUT); embedded PowDB (PowQL `returning`).
 * Server engines use only tables prefixed `onl_`, dropped at the end. PowDB has
 * no savepoints, so the caller-transaction rollback case is SQL-only.
 *
 * Run: DATABASE_URL=... MYSQL_URL=... MSSQL_URL=... npx tsx --test src/test/optimistic-lock-nested-engines.test.ts
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { OptimisticLockError, UniqueConstraintError, ValidationError } from '../errors.js';
import { UNSAFE } from '../index.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata } from '../schema.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { type GatedRunners, skipGate } from './helpers.js';
import { closeSqliteAfter, sqliteFixtureScope } from './sqlite-fixture-lifetime.js';

// biome-ignore lint/suspicious/noExplicitAny: engine clients are TurbineClient subclasses loaded dynamically
type Any = any;

const PARENTS = 'onl_parents';
const CHILDREN = 'onl_children';

const DDL: Record<'postgresql' | 'sqlite' | 'mysql' | 'mssql', string[]> = {
  postgresql: [
    `CREATE TABLE ${PARENTS} (id INT PRIMARY KEY, version INT NOT NULL, note TEXT)`,
    `CREATE TABLE ${CHILDREN} (id INT PRIMARY KEY, parent_id INT NOT NULL REFERENCES ${PARENTS}(id), note TEXT)`,
    `CREATE INDEX onl_children_parent ON ${CHILDREN} (parent_id)`,
  ],
  sqlite: [
    `CREATE TABLE ${PARENTS} (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, note TEXT)`,
    `CREATE TABLE ${CHILDREN} (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES ${PARENTS}(id), note TEXT)`,
    `CREATE INDEX onl_children_parent ON ${CHILDREN} (parent_id)`,
  ],
  mysql: [
    `CREATE TABLE ${PARENTS} (id INT PRIMARY KEY, version INT NOT NULL, note VARCHAR(64) NULL) ENGINE=InnoDB`,
    `CREATE TABLE ${CHILDREN} (id INT PRIMARY KEY, parent_id INT NOT NULL, note VARCHAR(64) NULL, ` +
      `INDEX (parent_id), CONSTRAINT onl_children_parent FOREIGN KEY (parent_id) REFERENCES ${PARENTS}(id)) ENGINE=InnoDB`,
  ],
  mssql: [
    `CREATE TABLE ${PARENTS} (id INT PRIMARY KEY, version INT NOT NULL, note NVARCHAR(64) NULL)`,
    `CREATE TABLE ${CHILDREN} (id INT PRIMARY KEY, parent_id INT NOT NULL REFERENCES ${PARENTS}(id), note NVARCHAR(64) NULL)`,
    `CREATE INDEX onl_children_parent ON ${CHILDREN} (parent_id)`,
  ],
};

interface Live {
  name: string;
  gate: GatedRunners;
  /** Whether a caller's `$transaction` puts the nested write in a savepoint. */
  savepoints: boolean;
  connect(): Promise<void>;
  /** Start the next test on a database of its own, where the engine needs that. */
  fresh?(): Promise<void>;
  db(): Any;
  close(): Promise<void>;
}

// --- sqlite ----------------------------------------------------------------

const DatabaseSync: (new (path: string) => DatabaseSyncType) | undefined = (() => {
  try {
    return createRequire(process.cwd())('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();

function sqliteLive(): Live {
  let c: Any;
  return {
    name: 'sqlite',
    gate: skipGate(!DatabaseSync, 'turbine-orm/sqlite requires node:sqlite (Node >= 22.5)'),
    savepoints: true,
    async connect() {
      const { introspectSqliteDatabase, turbineSqlite } = await import('../sqlite.js');
      const raw = closeSqliteAfter(new DatabaseSync!(':memory:'), sqliteCleanup);
      for (const stmt of DDL.sqlite) raw.exec(stmt);
      c = turbineSqlite(raw, introspectSqliteDatabase(raw));
    },
    db: () => c,
    async close() {
      await c?.disconnect();
    },
  };
}

// --- postgresql ------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL ?? '';

function postgresLive(): Live {
  let raw: pg.Client | undefined;
  let c: TurbineClient | undefined;
  const drop = `DROP TABLE IF EXISTS ${CHILDREN}, ${PARENTS}`;
  return {
    name: 'postgresql',
    gate: skipGate(!DATABASE_URL, 'requires DATABASE_URL'),
    savepoints: true,
    async connect() {
      raw = new pg.Client({ connectionString: DATABASE_URL });
      await raw.connect();
      await raw.query(drop);
      for (const stmt of DDL.postgresql) await raw.query(stmt);
      const schema = await introspect({ connectionString: DATABASE_URL, include: [PARENTS, CHILDREN] });
      c = new TurbineClient({ connectionString: DATABASE_URL, poolSize: 3 }, schema);
    },
    db: () => c,
    async close() {
      await c?.disconnect();
      await raw?.query(drop);
      await raw?.end();
    },
  };
}

// --- mysql -----------------------------------------------------------------

const MYSQL_URL = process.env.MYSQL_URL ?? '';
/** Its own database: mysql.test.ts asserts the exact table list of the URL's. */
const MYSQL_DATABASE = process.env.TURBINE_ONL_MYSQL_DB ?? 'turbine_onl';

function mysqlLive(): Live {
  let rawPool: Any;
  let c: Any;
  return {
    name: 'mysql',
    gate: skipGate(!MYSQL_URL, 'requires MYSQL_URL pointing at a MySQL 8 server'),
    savepoints: true,
    async connect() {
      const { createPool } = await import('mysql2/promise');
      const { MysqlPool, introspectMysqlWith, turbineMysql } = await import('../mysql.js');
      const url = new URL(MYSQL_URL);
      const base = {
        host: url.hostname,
        port: url.port ? Number(url.port) : 3306,
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
      };
      const admin = createPool(base);
      await admin.query(`DROP DATABASE IF EXISTS \`${MYSQL_DATABASE}\``);
      await admin.query(`CREATE DATABASE \`${MYSQL_DATABASE}\``);
      await admin.end();
      rawPool = createPool({ ...base, database: MYSQL_DATABASE, namedPlaceholders: true, timezone: 'Z' });
      for (const stmt of DDL.mysql) await rawPool.query(stmt);
      const pool = new MysqlPool(rawPool);
      const schema = await introspectMysqlWith(
        async (sql, params) => (await pool.query(sql, params)).rows,
        MYSQL_DATABASE,
      );
      c = await turbineMysql(pool, schema, { warnOnUnlimited: false });
    },
    db: () => c,
    async close() {
      if (!rawPool) return;
      await rawPool.query(`DROP DATABASE IF EXISTS \`${MYSQL_DATABASE}\``);
      await rawPool.end();
    },
  };
}

// --- mssql -----------------------------------------------------------------

const MSSQL_URL = process.env.MSSQL_URL ?? '';

function mssqlLive(): Live {
  let rawPool: Any;
  let c: Any;
  const dropAll = async () => {
    for (const t of [CHILDREN, PARENTS]) {
      await rawPool.request().batch(`IF OBJECT_ID('${t}','U') IS NOT NULL DROP TABLE ${t}`);
    }
  };
  return {
    name: 'mssql',
    gate: skipGate(!MSSQL_URL, 'requires MSSQL_URL pointing at a SQL Server 2016+ instance'),
    savepoints: true,
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
      const pool = new MssqlPool(rawPool, mssql);
      const schema = await introspectMssqlWith(async (sql, params) => (await pool.query(sql, params)).rows, 'dbo', {
        include: [PARENTS, CHILDREN],
      });
      c = await turbineMssql(pool, schema);
    },
    db: () => c,
    async close() {
      if (!rawPool) return;
      await dropAll();
      await rawPool.close();
    },
  };
}

// --- powdb (embedded) ------------------------------------------------------

let embeddedAvailable = false;
try {
  const mod = (await import('@zvndev/powdb-embedded')) as { Database?: { open?: unknown } };
  embeddedAvailable = typeof mod?.Database?.open === 'function';
} catch {
  embeddedAvailable = false;
}

/**
 * A database per test: on @zvndev/powdb-embedded 0.20.0 a second rolled-back
 * transaction on one handle fails its `rollback` ("bad heap superblock magic")
 * and leaves the handle inside the transaction, with or without a lock, so the
 * rollback cases here would read each other's wreckage on a shared handle.
 */
function powdbLive(): Live {
  let c: Any;
  let dir: string | undefined;
  const open = async () => {
    await close();
    const { powqlSchemaDDL, turbinePowDB } = await import('../powdb.js');
    dir = mkdtempSync(join(tmpdir(), 'turbine-onl-powdb-'));
    c = await turbinePowDB({ embedded: dir }, schema, { warnOnUnlimited: false });
    for (const stmt of powqlSchemaDDL(schema)) await c.rawUnsafe(stmt);
  };
  const close = async () => {
    await c?.disconnect();
    c = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  };
  let schema: SchemaMetadata;
  return {
    name: 'powdb',
    gate: skipGate(!embeddedAvailable, 'requires @zvndev/powdb-embedded (no prebuilt binary on this platform)'),
    savepoints: false,
    async connect() {
      schema = schemaDefToMetadata(
        defineSchema({
          [PARENTS]: {
            id: { type: 'integer', primaryKey: true },
            version: { type: 'integer', notNull: true },
            note: { type: 'text' },
          },
          [CHILDREN]: {
            id: { type: 'integer', primaryKey: true },
            parentId: { type: 'integer', notNull: true, references: `${PARENTS}.id` },
            note: { type: 'text' },
          },
        }),
      );
      await open();
    },
    fresh: open,
    db: () => c,
    close,
  };
}

// ---------------------------------------------------------------------------
// The battery
// ---------------------------------------------------------------------------

interface State {
  version: number;
  note: string | null;
  children: number[];
}

for (const live of [sqliteLive(), postgresLive(), mysqlLive(), mssqlLive(), powdbLive()]) {
  const { it, before, after } = live.gate;

  describe(`optimisticLock with nested relation writes on ${live.name}`, () => {
    let rel = '';
    /** Every model call middleware sees while a test records, else null. */
    let seen: string[] | null = null;
    const record = () =>
      live.db().$use(async (params: { model: string; action: string }, next: Any) => {
        seen?.push(`${params.model}.${params.action}`);
        return next(params);
      });
    before(async () => {
      await live.connect();
      const relations = live.db().schema.tables[PARENTS]?.relations ?? {};
      rel = Object.keys(relations).find((name) => relations[name].type === 'hasMany') ?? '';
      assert.ok(rel, `${PARENTS} has a to-many relation to ${CHILDREN}`);
      record();
    });
    after(async () => {
      await live.close();
    });

    const parents = () => live.db().table(PARENTS);
    const children = () => live.db().table(CHILDREN);

    /** Parent 1 at version 5, and child 7 already under it. */
    async function reset(): Promise<void> {
      if (live.fresh) {
        await live.fresh();
        record();
      }
      await children().deleteMany({ where: {}, allowFullTableScan: UNSAFE });
      await parents().deleteMany({ where: {}, allowFullTableScan: UNSAFE });
      await parents().create({ data: { id: 1, version: 5, note: 'original' } });
      await children().create({ data: { id: 7, parentId: 1, note: 'existing' } });
    }

    async function state(): Promise<State> {
      const row = await parents().findUnique({ where: { id: 1 } });
      const kids = (await children().findMany({ where: { parentId: 1 }, orderBy: { id: 'asc' } })) as { id: number }[];
      return { version: Number(row.version), note: row.note, children: kids.map((k) => Number(k.id)) };
    }

    const untouched: State = { version: 5, note: 'original', children: [7] };

    it('refuses a version column in data before the nested engine runs', async () => {
      await reset();
      const calls: string[] = [];
      seen = calls;
      try {
        await assert.rejects(
          parents().update({
            where: { id: 1 },
            data: { version: 9, [rel]: { create: { id: 8, note: 'new' } } },
            optimisticLock: { field: 'version', expected: 5 },
          }),
          (err: unknown) => err instanceof ValidationError && /writes "version" itself/.test(err.message),
        );
      } finally {
        seen = null;
      }
      assert.deepEqual(calls, [`${PARENTS}.update`], 'no inner statement ran');
      assert.deepEqual(await state(), untouched);
    });

    it('a stale version is E015 and writes neither the parent nor the child', async () => {
      await reset();
      await assert.rejects(
        parents().update({
          where: { id: 1 },
          data: { note: 'stale', [rel]: { create: { id: 8, note: 'new' } } },
          optimisticLock: { field: 'version', expected: 4 },
        }),
        OptimisticLockError,
      );
      assert.deepEqual(await state(), untouched);
    });

    it('a relation-only write with the current version bumps it once', async () => {
      await reset();
      const row = await parents().update({
        where: { id: 1 },
        data: { [rel]: { create: { id: 8, note: 'new' } } },
        optimisticLock: { field: 'version', expected: 5 },
      });
      assert.equal(Number(row.version), 6);
      assert.deepEqual(await state(), { version: 6, note: 'original', children: [7, 8] });
    });

    it('scalars and relation writes with the current version: one bump, both written', async () => {
      await reset();
      const row = await parents().update({
        where: { id: 1 },
        data: { note: 'edited', [rel]: { create: { id: 8, note: 'new' } } },
        optimisticLock: { field: 'version', expected: 5 },
      });
      assert.equal(Number(row.version), 6);
      assert.deepEqual(await state(), { version: 6, note: 'edited', children: [7, 8] });
    });

    it('a failing relation write rolls the version bump back with it', async () => {
      await reset();
      await assert.rejects(
        parents().update({
          where: { id: 1 },
          data: { note: 'edited', [rel]: { create: { id: 7, note: 'duplicate' } } },
          optimisticLock: { field: 'version', expected: 5 },
        }),
        UniqueConstraintError,
      );
      assert.deepEqual(await state(), untouched);
    });

    it("inside a caller's $transaction, a stale version leaves the transaction usable", async () => {
      await reset();
      await live.db().$transaction(async (tx: Any) => {
        await assert.rejects(
          tx.table(PARENTS).update({
            where: { id: 1 },
            data: { [rel]: { create: { id: 8, note: 'new' } } },
            optimisticLock: { field: 'version', expected: 4 },
          }),
          OptimisticLockError,
        );
        await tx.table(PARENTS).update({ where: { id: 1 }, data: { note: 'after' } });
      });
      assert.deepEqual(await state(), { version: 5, note: 'after', children: [7] });
    });

    if (live.savepoints) {
      it("inside a caller's $transaction, a failing relation write takes the bump back", async () => {
        await reset();
        await live.db().$transaction(async (tx: Any) => {
          await assert.rejects(
            tx.table(PARENTS).update({
              where: { id: 1 },
              data: { note: 'edited', [rel]: { create: { id: 7, note: 'duplicate' } } },
              optimisticLock: { field: 'version', expected: 5 },
            }),
            UniqueConstraintError,
          );
          await tx.table(PARENTS).update({ where: { id: 1 }, data: { note: 'after' } });
        });
        assert.deepEqual(await state(), { version: 5, note: 'after', children: [7] });
      });
    }
  });
}

// Register native teardown after the client teardown hooks.
const sqliteCleanup = sqliteFixtureScope();
