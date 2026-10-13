/**
 * Update expressions against real engines: every node kind, with NULL
 * operands, evaluated by each database and compared with a JavaScript
 * evaluator of SQL's semantics, plus the `expr.now()` time-zone convention, a
 * nested update and the single-row upsert's `expr.excluded` on both of its
 * paths.
 *
 * The differential is the point: the build tests pin the SQL TEXT per engine,
 * and only execution shows that MySQL's GREATEST (NULL if any argument is NULL)
 * was really rewritten to PostgreSQL's meaning (NULLs ignored), that SQL
 * Server's VALUES-list MAX does the same, and that a case arm's NULL
 * comparison falls through.
 *
 * Engines: SQLite always (node:sqlite); PostgreSQL with DATABASE_URL; MySQL
 * with MYSQL_URL; SQL Server with MSSQL_URL. Each server engine uses the
 * database its URL names and only tables prefixed `wce_`, which it drops at
 * the end. No session-level SET is issued anywhere: the PostgreSQL time-zone
 * case sets TimeZone as a connection parameter.
 *
 * Run: DATABASE_URL=... MYSQL_URL=... MSSQL_URL=... npx tsx --test src/test/wave-c-expr-live.integration.test.ts
 */

// biome-ignore-all lint/suspicious/noThenProperty: expr.case arms are { when, then }, the SQL CASE spelling; never thenable
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { col, expr, UNSAFE } from '../index.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: engine clients are TurbineClient subclasses loaded dynamically
type Any = any;

const TABLES = ['wce_children', 'wce_parents', 'wce_counters', 'wce_times', 'wce_vals'];

// ---------------------------------------------------------------------------
// DDL per engine (same shape, engine spelling)
// ---------------------------------------------------------------------------

const DDL = {
  postgresql: [
    'CREATE TABLE wce_vals (id INT PRIMARY KEY, a INT, b INT, c INT, t TEXT, out_i INT, out_t TEXT)',
    'CREATE TABLE wce_times (id INT PRIMARY KEY, tz TIMESTAMPTZ, ts TIMESTAMP, day DATE)',
    'CREATE TABLE wce_counters (id SERIAL PRIMARY KEY, key TEXT NOT NULL UNIQUE, hits INT NOT NULL DEFAULT 0)',
    'CREATE TABLE wce_parents (id INT PRIMARY KEY, name TEXT)',
    'CREATE TABLE wce_children (id INT PRIMARY KEY, parent_id INT NOT NULL REFERENCES wce_parents(id), views INT NOT NULL DEFAULT 0)',
  ],
  sqlite: [
    'CREATE TABLE wce_vals (id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, c INTEGER, t TEXT, out_i INTEGER, out_t TEXT)',
    'CREATE TABLE wce_times (id INTEGER PRIMARY KEY, tz TIMESTAMPTZ, ts TIMESTAMP, day DATE)',
    'CREATE TABLE wce_counters (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, hits INTEGER NOT NULL DEFAULT 0)',
    'CREATE TABLE wce_parents (id INTEGER PRIMARY KEY, name TEXT)',
    'CREATE TABLE wce_children (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES wce_parents(id), views INTEGER NOT NULL DEFAULT 0)',
  ],
  mysql: [
    'CREATE TABLE wce_vals (id INT PRIMARY KEY, a INT NULL, b INT NULL, c INT NULL, t VARCHAR(64) NULL, out_i INT NULL, out_t VARCHAR(64) NULL)',
    'CREATE TABLE wce_times (id INT PRIMARY KEY, tz TIMESTAMP(3) NULL, ts DATETIME(3) NULL, day DATE NULL)',
    'CREATE TABLE wce_counters (id INT AUTO_INCREMENT PRIMARY KEY, `key` VARCHAR(64) NOT NULL UNIQUE, hits INT NOT NULL DEFAULT 0)',
    'CREATE TABLE wce_parents (id INT PRIMARY KEY, name VARCHAR(64) NULL)',
    'CREATE TABLE wce_children (id INT PRIMARY KEY, parent_id INT NOT NULL, views INT NOT NULL DEFAULT 0, CONSTRAINT wce_children_parent FOREIGN KEY (parent_id) REFERENCES wce_parents(id))',
  ],
  mssql: [
    'CREATE TABLE wce_vals (id INT PRIMARY KEY, a INT NULL, b INT NULL, c INT NULL, t NVARCHAR(64) NULL, out_i INT NULL, out_t NVARCHAR(64) NULL)',
    'CREATE TABLE wce_times (id INT PRIMARY KEY, tz DATETIMEOFFSET(3) NULL, ts DATETIME2(3) NULL, day DATE NULL)',
    'CREATE TABLE wce_counters (id INT IDENTITY(1,1) PRIMARY KEY, [key] NVARCHAR(64) NOT NULL UNIQUE, hits INT NOT NULL DEFAULT 0)',
    'CREATE TABLE wce_parents (id INT PRIMARY KEY, name NVARCHAR(64) NULL)',
    'CREATE TABLE wce_children (id INT PRIMARY KEY, parent_id INT NOT NULL REFERENCES wce_parents(id), views INT NOT NULL DEFAULT 0)',
  ],
} as const;

type EngineName = keyof typeof DDL;

interface Live {
  name: EngineName;
  skip: string;
  connect(): Promise<void>;
  /** The client the tests drive. */
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
    skip: DatabaseSync ? '' : 'turbine-orm/sqlite requires node:sqlite (Node >= 22.5)',
    async connect() {
      const { introspectSqliteDatabase, turbineSqlite } = await import('../sqlite.js');
      const db = new DatabaseSync!(':memory:');
      db.exec('PRAGMA foreign_keys = ON');
      for (const stmt of DDL.sqlite) db.exec(stmt);
      c = turbineSqlite(db, introspectSqliteDatabase(db));
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
  let raw: pg.Client;
  let c: TurbineClient;
  return {
    name: 'postgresql',
    skip: DATABASE_URL ? '' : 'requires DATABASE_URL',
    async connect() {
      raw = new pg.Client({ connectionString: DATABASE_URL });
      await raw.connect();
      await raw.query(`DROP TABLE IF EXISTS ${TABLES.join(', ')} CASCADE`);
      for (const stmt of DDL.postgresql) await raw.query(stmt);
      const schema = await introspect({ connectionString: DATABASE_URL, include: TABLES });
      // A session zone far from UTC, set as a CONNECTION PARAMETER (never a
      // session-level SET), so a now() that stored the session's wall clock in
      // a zone-less column would read back hours off.
      const url = new URL(DATABASE_URL);
      const options = url.searchParams.get('options');
      url.searchParams.set('options', `${options ? `${options} ` : ''}-c TimeZone=America/New_York`);
      c = new TurbineClient({ connectionString: url.toString(), poolSize: 3 }, schema);
      await c.connect();
    },
    db: () => c,
    async close() {
      await c?.disconnect();
      await raw?.query(`DROP TABLE IF EXISTS ${TABLES.join(', ')} CASCADE`);
      await raw?.end();
    },
  };
}

// --- mysql -----------------------------------------------------------------

const MYSQL_URL = process.env.MYSQL_URL ?? '';

function mysqlLive(): Live {
  let rawPool: Any;
  let c: Any;
  const dropAll = async () => {
    // Children first: the FK forbids dropping the parent while it is referenced.
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
      const pool = new MysqlPool(rawPool);
      const schema: SchemaMetadata = await introspectMysqlWith(
        async (sql, params) => (await pool.query(sql, params)).rows,
        database,
        { include: TABLES },
      );
      c = await turbineMysql(MYSQL_URL, schema);
    },
    db: () => c,
    async close() {
      await c?.disconnect();
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
      const pool = new MssqlPool(rawPool, mssql);
      const schema: SchemaMetadata = await introspectMssqlWith(
        async (sql, params) => (await pool.query(sql, params)).rows,
        'dbo',
        { include: TABLES },
      );
      c = await turbineMssql(pool, schema);
    },
    db: () => c,
    async close() {
      if (rawPool) {
        await dropAll();
        await rawPool.close();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// A JavaScript evaluator of the SQL semantics
// ---------------------------------------------------------------------------

type Row = Record<string, number | string | null>;

/** The predicate forms the cases use: equality (null is IS NULL) and gt/gte/lt/lte. */
function matches(when: Record<string, unknown>, row: Row): boolean {
  return Object.entries(when).every(([field, cond]) => {
    const v = row[field] ?? null;
    if (cond === null) return v === null;
    if (typeof cond !== 'object') return v !== null && v === cond;
    if (v === null) return false; // a comparison with NULL is unknown, so not true
    const { gt, gte, lt, lte } = cond as Record<string, number>;
    return (
      (gt === undefined || (v as number) > gt) &&
      (gte === undefined || (v as number) >= gte) &&
      (lt === undefined || (v as number) < lt) &&
      (lte === undefined || (v as number) <= lte)
    );
  });
}

function evaluate(node: unknown, row: Row): number | string | null {
  if (node === null) return null;
  if (typeof node === 'number' || typeof node === 'string') return node;
  const n = node as { kind?: string; col?: string; args?: unknown[]; else?: unknown };
  if (typeof n.col === 'string' && n.kind === undefined) return row[n.col] ?? null;
  const args = (n.args ?? []) as unknown[];
  switch (n.kind) {
    case 'add':
    case 'sub':
    case 'mul':
    case 'div': {
      const [a, b] = args.map((x) => evaluate(x, row)) as [number | null, number | null];
      if (a === null || b === null) return null;
      if (n.kind === 'add') return a + b;
      if (n.kind === 'sub') return a - b;
      if (n.kind === 'mul') return a * b;
      return Math.trunc(a / b);
    }
    case 'coalesce':
      return args.map((x) => evaluate(x, row)).find((v) => v !== null) ?? null;
    case 'greatest':
    case 'least': {
      const vals = args.map((x) => evaluate(x, row)).filter((v): v is number => v !== null);
      if (vals.length === 0) return null;
      return n.kind === 'greatest' ? Math.max(...vals) : Math.min(...vals);
    }
    case 'case': {
      for (const arm of args as { when: Record<string, unknown>; then: unknown }[]) {
        if (matches(arm.when, row)) return evaluate(arm.then, row);
      }
      return n.else === undefined ? null : evaluate(n.else, row);
    }
    default:
      throw new Error(`the evaluator does not know ${String(n.kind)}`);
  }
}

// ---------------------------------------------------------------------------
// Fixture rows and cases
// ---------------------------------------------------------------------------

const VALS: Row[] = [
  { id: 1, a: 5, b: 3, c: 2, t: 'x' },
  { id: 2, a: null, b: 3, c: 2, t: null },
  { id: 3, a: 5, b: null, c: null, t: 'y' },
  { id: 4, a: null, b: null, c: null, t: null },
  { id: 5, a: -4, b: 7, c: 7, t: 'z' },
  { id: 6, a: 10, b: 2, c: null, t: 'x' },
];

/** `[name, target field, expression]`. Every integer result is exact on every engine. */
const CASES: [string, 'outI' | 'outT', () => unknown][] = [
  ['add of two columns', 'outI', () => expr.add(col('a'), col('b'))],
  ['sub of a column and a value', 'outI', () => expr.sub(col('a'), 1)],
  ['mul of two columns', 'outI', () => expr.mul(col('a'), col('b'))],
  ['div that is exact', 'outI', () => expr.div(expr.mul(col('a'), 2), 2)],
  ['coalesce of three', 'outI', () => expr.coalesce(col('a'), col('b'), 0)],
  ['coalesce with a value', 'outI', () => expr.coalesce(col('a'), 9)],
  ['greatest ignores NULL', 'outI', () => expr.greatest(col('a'), col('b'))],
  ['least of three ignores NULL', 'outI', () => expr.least(col('a'), col('b'), col('c'))],
  ['greatest with a value', 'outI', () => expr.greatest(col('a'), 0)],
  ['least with a NULL operand', 'outI', () => expr.least(col('a'), null)],
  [
    'case with a NULL arm and an else',
    'outI',
    () =>
      expr.case(
        [
          { when: { a: { gt: 4 } }, then: 1 },
          { when: { a: null }, then: 2 },
        ],
        3,
      ),
  ],
  ['case without else is NULL when no arm matches', 'outI', () => expr.case([{ when: { t: 'x' }, then: col('b') }])],
  ['nested nodes', 'outI', () => expr.add(expr.coalesce(col('a'), 0), expr.greatest(col('b'), col('c')))],
  ['coalesce on text', 'outT', () => expr.coalesce(col('t'), 'none')],
  [
    'case on text with a column fallback',
    'outT',
    () => expr.case([{ when: { a: { gte: 5 } }, then: 'big' }], col('t')),
  ],
];

const FIELD: Record<string, string> = { outI: 'out_i', outT: 'out_t' };

// ---------------------------------------------------------------------------
// The battery
// ---------------------------------------------------------------------------

for (const live of [sqliteLive(), postgresLive(), mysqlLive(), mssqlLive()]) {
  const { it, before, after } = skipGate(Boolean(live.skip), live.skip || 'unreachable');

  describe(`update expressions on ${live.name}`, () => {
    before(async () => {
      await live.connect();
    });
    after(async () => {
      await live.close();
    });

    const vals = () => live.db().table('wce_vals');

    for (const [name, target, build] of CASES) {
      it(`${name} matches the SQL evaluator`, async () => {
        await vals().deleteMany({ where: {}, allowFullTableScan: UNSAFE });
        await vals().createMany({ data: VALS });
        const node = build();
        await vals().updateMany({ where: { id: { in: VALS.map((r) => r.id) } }, data: { [target]: node } });
        const rows = (await vals().findMany({ orderBy: { id: 'asc' } })) as Row[];
        const got = rows.map((r) => {
          const v = r[target];
          return v === null || v === undefined ? null : target === 'outI' ? Number(v) : String(v);
        });
        const want = VALS.map((r) => evaluate(node, r));
        assert.deepEqual(got, want, `${live.name}: ${name} (${FIELD[target]})`);
      });
    }

    it('expr.now() stores what writing new Date() stores, on every temporal type', async () => {
      if (live.name === 'postgresql') {
        const zone = await live.db().sql`SELECT current_setting('TimeZone') AS zone`.one();
        assert.equal(zone.zone, 'America/New_York', 'the session zone this case depends on');
      }
      const times = live.db().table('wce_times');
      await times.deleteMany({ where: {}, allowFullTableScan: UNSAFE });
      await times.createMany({ data: [{ id: 1 }, { id: 2 }] });
      const before = Date.now();
      await times.update({ where: { id: 1 }, data: { tz: expr.now(), ts: expr.now(), day: expr.now() } });
      const now = new Date();
      await times.update({ where: { id: 2 }, data: { tz: now, ts: now, day: now } });
      const [byExpr, byValue] = (await times.findMany({ orderBy: { id: 'asc' } })) as {
        tz: Date;
        ts: Date;
        day: Date;
      }[];
      for (const field of ['tz', 'ts'] as const) {
        const a = new Date(byExpr![field]).getTime();
        const b = new Date(byValue![field]).getTime();
        // A zone-convention bug is hours off; a slow CI machine is seconds off.
        assert.ok(
          Math.abs(a - b) < 120_000,
          `${live.name} ${field}: expr ${byExpr![field]} vs value ${byValue![field]}`,
        );
        assert.ok(Math.abs(a - before) < 120_000, `${live.name} ${field} is not now: ${byExpr![field]}`);
      }
      const dayOf = (d: unknown) => new Date(d as string).toISOString().slice(0, 10);
      assert.equal(dayOf(byExpr!.day), dayOf(byValue!.day), `${live.name} day`);
    });

    it('a nested update takes expressions in its data', async () => {
      const db = live.db();
      await db.table('wce_children').deleteMany({ where: {}, allowFullTableScan: UNSAFE });
      await db.table('wce_parents').deleteMany({ where: {}, allowFullTableScan: UNSAFE });
      await db.table('wce_parents').create({ data: { id: 1, name: 'p' } });
      await db.table('wce_children').createMany({ data: [{ id: 10, parentId: 1, views: 4 }] });
      const relation = Object.entries(db.schema.tables.wce_parents.relations).find(
        ([, r]) => (r as { to: string }).to === 'wce_children',
      )![0];
      await db.table('wce_parents').update({
        where: { id: 1 },
        data: { name: 'q', [relation]: { update: { where: { id: 10 }, data: { views: expr.mul(col('views'), 3) } } } },
      });
      const child = await db.table('wce_children').findUnique({ where: { id: 10 } });
      assert.equal(Number(child.views), 12);
      // A nested upsert's excluded reads its own create, on both branches.
      const upsert = () =>
        db.table('wce_parents').update({
          where: { id: 1 },
          data: {
            [relation]: {
              upsert: {
                where: { id: 11 },
                create: { id: 11, views: 7 },
                update: { views: expr.add(col('views'), expr.excluded('views')) },
              },
            },
          },
        });
      await upsert();
      assert.equal(Number((await db.table('wce_children').findUnique({ where: { id: 11 } })).views), 7, 'created');
      await upsert();
      assert.equal(Number((await db.table('wce_children').findUnique({ where: { id: 11 } })).views), 14, 'updated');
    });

    it('upsert: expr.excluded reads create, on the one-statement path and the lookup path', async () => {
      const counters = live.db().table('wce_counters');
      await counters.deleteMany({ where: {}, allowFullTableScan: UNSAFE });
      const bump = (hits: number) => ({
        where: { key: 'k' },
        create: { key: 'k', hits },
        update: { hits: expr.add(col('hits'), expr.excluded('hits')) },
      });
      assert.equal(Number((await counters.upsert(bump(5))).hits), 5, 'inserted');
      assert.equal(Number((await counters.upsert(bump(4))).hits), 9, 'updated by the incoming value');
      // `where` by id is not pinned to `create`, so this upsert looks the row up.
      const row = await counters.findUnique({ where: { key: 'k' } });
      const looked = await counters.upsert({
        where: { id: row.id },
        create: { key: 'other', hits: 10 },
        update: { hits: expr.add(col('hits'), expr.excluded('hits')) },
      });
      assert.equal(Number(looked.hits), 19, 'lookup path adds create.hits');
      assert.equal(looked.key, 'k');
    });
  });
}
