/**
 * Write-path rules against real engines (PostgreSQL, MySQL, SQLite):
 *
 * - Update expressions store the same value on every engine (integer
 *   arithmetic between integers, integer division truncating toward zero, a
 *   non-integer result refused on an integer column), and `expr.now()` stores
 *   the UTC day in a SQLite date column.
 * - `optimisticLock` on `delete` / `deleteMany` is refused and deletes nothing.
 * - A plain object, array, Map or Set written to a scalar column is refused
 *   and stores nothing.
 * - MySQL `create` with 0 in an AUTO_INCREMENT key returns the inserted row.
 * - `createMany({ onConflict })` whose rows share a key only under the column's
 *   comparison rules is E003 and rolls back, inside one statement (SQLite) and
 *   across the statements of a chunked call (every engine).
 *
 * Gated per engine: DATABASE_URL (PostgreSQL), MYSQL_URL, node:sqlite. Tables
 * are prefixed `fxw_` and dropped afterwards.
 *
 * Run: DATABASE_URL=... MYSQL_URL=... npx tsx --test src/test/fx-write-engines.integration.test.ts
 */

// biome-ignore-all lint/suspicious/noThenProperty: expr.case arms are { when, then }, the SQL CASE spelling; never thenable
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { UnsupportedFeatureError, ValidationError } from '../errors.js';
import { col, expr } from '../index.js';
import { introspect } from '../introspect.js';
import { skipGate } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: live harness drives untyped clients
type Any = any;

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const MYSQL_URL = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const HAVE_NODE_SQLITE = (() => {
  try {
    createRequire(process.cwd())('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();

async function thrown(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  assert.fail('expected the call to throw');
}

function assertE003(err: unknown, pattern: RegExp): void {
  assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
  assert.equal(err.code, 'TURBINE_E003');
  assert.match(err.message, pattern);
}

const SHARED_KEY = /two rows in this call share the conflict key \(email\)/;

/**
 * The stored value of each expression, from `n = 75, m = 2, f = 75`. One
 * table for every engine: a row here that differs per engine is the bug.
 */
const EXPR_CASES: [string, () => Record<string, unknown>, 'n' | 'f', number][] = [
  ['n DIV 2', () => ({ n: expr.div(col('n'), 2) }), 'n', 37],
  ['n DIV 4', () => ({ n: expr.div(col('n'), 4) }), 'n', 18],
  ['n DIV m', () => ({ n: expr.div(col('n'), col('m')) }), 'n', 37],
  ['(n DIV 2) + 0', () => ({ n: expr.add(expr.div(col('n'), 2), 0) }), 'n', 37],
  ['-n DIV 2 truncates toward zero', () => ({ n: expr.div(expr.sub(0, col('n')), 2) }), 'n', -37],
  ['(n * 3) DIV 2', () => ({ n: expr.div(expr.mul(col('n'), 3), 2) }), 'n', 112],
  [
    'case then n DIV 2',
    () => ({ n: expr.case([{ when: { n: { gt: 0 } }, then: expr.div(col('n'), 2) }], 0) }),
    'n',
    37,
  ],
  ['f = n DIV 2', () => ({ f: expr.div(col('n'), 2) }), 'f', 37],
  ['f = n * 1.5', () => ({ f: expr.mul(col('n'), 1.5) }), 'f', 112.5],
  ['f = f / 2', () => ({ f: expr.div(col('f'), 2) }), 'f', 37.5],
  ['f = n * 0.5', () => ({ f: expr.mul(col('n'), 0.5) }), 'f', 37.5],
];

/** Run {@link EXPR_CASES} against table `fxw_ar` (id, n, m INTEGER; f FLOAT). */
function exprCases(gate: ReturnType<typeof skipGate>, getDb: () => Any) {
  const t = () => getDb().table('fxw_ar');
  const reset = () => t().update({ where: { id: 1 }, data: { n: 75, m: 2, f: 75 } });
  for (const [name, data, column, expected] of EXPR_CASES) {
    gate.it(`expr: ${name} stores ${expected}`, async () => {
      await reset();
      const row = await t().update({ where: { id: 1 }, data: data() });
      assert.equal(Number(row[column]), expected);
      const reread = await t().findUnique({ where: { id: 1 } });
      assert.equal(Number(reread[column]), expected);
    });
  }
  gate.it('expr: a non-integer result is refused on an integer column, and nothing is stored', async () => {
    await reset();
    assertE003(
      await thrown(() => t().update({ where: { id: 1 }, data: { n: expr.mul(col('n'), 1.5) } })),
      /computes a non-integer value .*"n" is an integer column/,
    );
    assertE003(await thrown(() => t().update({ where: { id: 1 }, data: { n: col('f') } })), /non-integer value/);
    assert.equal(Number((await t().findUnique({ where: { id: 1 } })).n), 75);
  });
}

/** Run the delete and scalar-column refusals against `fxw_ar`. */
function refusals(gate: ReturnType<typeof skipGate>, getDb: () => Any, textRefusesObject: boolean) {
  const t = () => getDb().table('fxw_ar');
  gate.it('optimisticLock on delete and deleteMany is refused, and the row stays', async () => {
    const lock = { field: 'version', expected: 99 };
    assertE003(await thrown(() => t().delete({ where: { id: 1 }, optimisticLock: lock })), /delete on "fxw_ar"/);
    assertE003(await thrown(() => t().deleteMany({ where: { id: 1 }, optimisticLock: lock })), /deleteMany on/);
    // The equivalent: the version in `where`.
    await assert.rejects(t().delete({ where: { id: 1, version: 99 } }), { code: 'TURBINE_E001' });
    assert.ok(await t().findUnique({ where: { id: 1 } }));
  });

  gate.it('an object, array, Map or Set written to a scalar column is refused and stores nothing', async () => {
    await t().update({ where: { id: 1 }, data: { n: 75, label: 'orig' } });
    for (const value of [{ a: 1 }, [1, 2], new Map([['a', 1]]), new Set([1])]) {
      assertE003(await thrown(() => t().update({ where: { id: 1 }, data: { n: { set: value } } })), /Cannot write/);
      assertE003(await thrown(() => t().create({ data: { id: 9, n: value } })), /Cannot write/);
      assertE003(await thrown(() => t().createMany({ data: [{ id: 9, n: value }] })), /Cannot write/);
    }
    for (const value of [new Map([['a', 1]]), new Set([1])]) {
      assertE003(
        await thrown(() => t().update({ where: { id: 1 }, data: { label: value } })),
        /Cannot write a (Map|Set)/,
      );
    }
    // SQLite stores JSON in a text column, so an object there stays JSON text.
    if (textRefusesObject) {
      assertE003(
        await thrown(() => t().update({ where: { id: 1 }, data: { label: { set: { a: 1, b: 2 } } } })),
        /Cannot write an object/,
      );
      assertE003(
        await thrown(() => t().create({ data: { id: 9, n: 1, m: 1, label: ['a'] } })),
        /Cannot write an array/,
      );
    }
    const row = await t().findUnique({ where: { id: 1 } });
    assert.equal(Number(row.n), 75);
    assert.equal(row.label, 'orig');
    assert.equal(await t().count({ where: { id: 9 } }), 0);
  });
}

/** Count the INSERT statements a client sends from now on. */
function countInserts(db: Any): { n: number } {
  const counter = { n: 0 };
  db.$on('query', (e: { sql: string }) => {
    if (/^INSERT/.test(e.sql)) counter.n++;
  });
  return counter;
}

const ROWS = (n: number, first: string, last: string) => {
  const rows = Array.from({ length: n }, (_, i) => ({ email: `u${i}@x`, name: `n${i}` }));
  rows[0] = { email: first, name: 'first' };
  rows[n - 1] = { email: last, name: 'last' };
  return rows;
};

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

describe('write rules on PostgreSQL (live)', () => {
  const gate = skipGate(!DATABASE_URL, 'requires DATABASE_URL (PostgreSQL)');
  let db: Any;
  let admin: pg.Client;

  gate.before(async () => {
    admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query('DROP TABLE IF EXISTS fxw_ar, fxw_ci');
    await admin.query('DROP COLLATION IF EXISTS fxw_nocase');
    await admin.query(
      'CREATE TABLE fxw_ar (id int PRIMARY KEY, n int NOT NULL, m int NOT NULL, f float8, label text, version int NOT NULL DEFAULT 0)',
    );
    await admin.query(`INSERT INTO fxw_ar (id, n, m, f, label) VALUES (1, 75, 2, 75, 'orig')`);
    // A case-insensitive unique key, and an array column so createMany takes
    // the row-at-a-time form that chunks at the bind limit.
    await admin.query(
      "CREATE COLLATION fxw_nocase (provider = icu, locale = 'und-u-ks-level2', deterministic = false)",
    );
    await admin.query(
      'CREATE TABLE fxw_ci (id serial PRIMARY KEY, email text COLLATE fxw_nocase NOT NULL UNIQUE, name text, tags text[])',
    );
    const schema = await introspect({ connectionString: DATABASE_URL, include: ['fxw_ar', 'fxw_ci'] } as Any);
    db = new TurbineClient({ connectionString: DATABASE_URL, poolSize: 2, warnOnUnlimited: false }, schema);
  });

  gate.after(async () => {
    await db?.disconnect();
    if (admin) {
      await admin.query('DROP TABLE IF EXISTS fxw_ar, fxw_ci');
      await admin.query('DROP COLLATION IF EXISTS fxw_nocase');
      await admin.end();
    }
  });

  exprCases(gate, () => db);
  refusals(gate, () => db, true);

  gate.it(
    'createMany onConflict: a key equal under the collation across statements is E003 and rolls back',
    async () => {
      await admin.query('DELETE FROM fxw_ci');
      // 30,000 rows x 3 columns is past the 65,535 bind parameters of one statement.
      const rows = ROWS(30_000, 'Q@x', 'q@x').map((r) => ({ ...r, tags: ['t'] }));
      const inserts = countInserts(db);
      const err = await thrown(() =>
        db.table('fxw_ci').createMany({ data: rows, onConflict: { target: ['email'], update: ['name'] } }),
      );
      assertE003(err, SHARED_KEY);
      assert.ok(inserts.n >= 2, `expected a chunked call, got ${inserts.n} INSERT statement(s)`);
      assert.equal((await admin.query('SELECT count(*)::int AS n FROM fxw_ci')).rows[0].n, 0);
      // The same call with distinct keys commits every row.
      rows[29_999] = { email: 'z@x', name: 'last', tags: ['t'] };
      const out = await db
        .table('fxw_ci')
        .createMany({ data: rows, onConflict: { target: ['email'], update: ['name'] } });
      assert.equal(out.length, 30_000);
      assert.equal((await admin.query('SELECT count(*)::int AS n FROM fxw_ci')).rows[0].n, 30_000);
    },
  );
});

// ---------------------------------------------------------------------------
// MySQL
// ---------------------------------------------------------------------------

describe('write rules on MySQL (live)', () => {
  const gate = skipGate(!MYSQL_URL, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a MySQL 8 server');
  const TABLES = ['fxw_ar', 'fxw_ci', 'fxw_auto'];
  let db: Any;
  let raw: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
  const clients: Any[] = [];

  gate.before(async () => {
    const { introspectMysqlWith, turbineMysql } = await import('../mysql.js');
    const probe: Any = await turbineMysql(MYSQL_URL, { tables: {}, enums: {} });
    clients.push(probe);
    raw = async (sql, params = []) => (await probe.pool.query(sql, params)).rows;
    for (const t of TABLES) await raw(`DROP TABLE IF EXISTS ${t}`);
    await raw(
      'CREATE TABLE fxw_ar (id INT PRIMARY KEY, n INT NOT NULL, m INT NOT NULL, f DOUBLE, label VARCHAR(64), version INT NOT NULL DEFAULT 0)',
    );
    await raw(`INSERT INTO fxw_ar (id, n, m, f, label) VALUES (1, 75, 2, 75, 'orig')`);
    // The default collation compares case-insensitively.
    await raw(
      'CREATE TABLE fxw_ci (id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(64) NOT NULL UNIQUE, name VARCHAR(64), org_id INT)',
    );
    await raw('CREATE TABLE fxw_auto (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(20))');
    const dbName = decodeURIComponent(new URL(MYSQL_URL).pathname.slice(1));
    const schema = await introspectMysqlWith(async (sql, params) => raw(sql, params), dbName, { include: TABLES });
    db = await turbineMysql(MYSQL_URL, schema, { warnOnUnlimited: false } as never);
    clients.push(db);
  });

  gate.after(async () => {
    if (raw) for (const t of TABLES) await raw(`DROP TABLE IF EXISTS ${t}`);
    for (const c of clients) await c.disconnect();
  });

  exprCases(gate, () => db);
  refusals(gate, () => db, true);

  gate.it(
    'createMany onConflict: a key equal under the collation across statements is E003 and rolls back',
    async () => {
      await raw('DELETE FROM fxw_ci');
      // 30,000 rows x 3 columns is past the 65,535 bind parameters of one statement.
      const rows = ROWS(30_000, 'Q@x', 'q@x').map((r) => ({ ...r, orgId: 1 }));
      const conflict = { target: ['email'], update: ['name'] };
      const inserts = countInserts(db);
      assertE003(await thrown(() => db.table('fxw_ci').createMany({ data: rows, onConflict: conflict })), SHARED_KEY);
      assert.ok(inserts.n >= 2, `expected a chunked call, got ${inserts.n} INSERT statement(s)`);
      assert.deepEqual(await raw('SELECT COUNT(*) AS n FROM fxw_ci'), [{ n: 0 }]);
      rows[29_999] = { email: 'z@x', name: 'last', orgId: 1 };
      const out = await db.table('fxw_ci').createMany({ data: rows, onConflict: conflict });
      assert.equal(out.length, 30_000);
      assert.deepEqual(await raw('SELECT COUNT(*) AS n FROM fxw_ci'), [{ n: 30_000 }]);
    },
  );

  gate.it('create with 0 in an AUTO_INCREMENT key returns the row it inserted', async () => {
    await raw('DELETE FROM fxw_auto');
    const a = await db.table('fxw_auto').create({ data: { name: 'a' } });
    const zero = await db.table('fxw_auto').create({ data: { id: 0, name: 'zero' } });
    assert.equal(zero.id, a.id + 1);
    assert.equal(zero.name, 'zero');
    const err = await thrown(() =>
      db
        .table('fxw_auto')
        .createMany({ data: [{ id: 0, name: 'b' }], onConflict: { target: ['id'], update: ['name'] } }),
    );
    assert.ok(err instanceof UnsupportedFeatureError, String(err));
    assert.deepEqual(await raw('SELECT COUNT(*) AS n FROM fxw_auto'), [{ n: 2 }]);
  });
});

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

describe('write rules on SQLite (live, in memory)', () => {
  const gate = skipGate(!HAVE_NODE_SQLITE, 'turbine-orm/sqlite requires node:sqlite (Node >= 22.5)');
  let db: Any;
  let raw: Any;

  gate.before(async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { introspectSqliteDatabase, turbineSqlite } = await import('../sqlite.js');
    raw = new DatabaseSync(':memory:');
    raw.exec(`
      CREATE TABLE fxw_ar (id INTEGER PRIMARY KEY, n INTEGER NOT NULL, m INTEGER NOT NULL, f REAL, label TEXT,
        version INTEGER NOT NULL DEFAULT 0);
      INSERT INTO fxw_ar (id, n, m, f, label) VALUES (1, 75, 2, 75, 'orig');
      CREATE TABLE fxw_ci (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT);
      CREATE TABLE fxw_ev (id INTEGER PRIMARY KEY, day DATE, at DATETIME);
      INSERT INTO fxw_ev VALUES (1, NULL, NULL);
    `);
    db = turbineSqlite(raw, introspectSqliteDatabase(raw), { warnOnUnlimited: false } as never);
  });

  exprCases(gate, () => db);
  refusals(gate, () => db, false);

  gate.it('expr.now() stores the UTC day in a date column, as a Date value does', async () => {
    await db.table('fxw_ev').update({ where: { id: 1 }, data: { day: expr.now(), at: expr.now() } });
    const stored = raw.prepare('SELECT day, at FROM fxw_ev WHERE id = 1').get();
    assert.equal(stored.day, new Date().toISOString().slice(0, 10));
    assert.match(stored.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(await db.table('fxw_ev').count({ where: { day: new Date() } }), 1);
  });

  gate.it('createMany onConflict: two keys equal under NOCASE in one statement are E003', async () => {
    raw.exec('DELETE FROM fxw_ci');
    const data = [
      { email: 'Q@x', name: 'first' },
      { email: 'q@x', name: 'last' },
    ];
    const conflict = { target: ['email'], update: ['name'] };
    assertE003(await thrown(() => db.table('fxw_ci').createMany({ data, onConflict: conflict })), SHARED_KEY);
    raw.exec('DELETE FROM fxw_ci');
    // Inside a transaction the refusal rolls the statement back.
    assertE003(
      await thrown(() => db.$transaction((tx: Any) => tx.table('fxw_ci').createMany({ data, onConflict: conflict }))),
      SHARED_KEY,
    );
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM fxw_ci').get().n, 0);
  });

  gate.it('createMany onConflict: across statements it is E003 and rolls back', async () => {
    raw.exec('DELETE FROM fxw_ci');
    const rows = ROWS(40_000, 'Q@x', 'q@x');
    const conflict = { target: ['email'], update: ['name'] };
    const inserts = countInserts(db);
    assertE003(await thrown(() => db.table('fxw_ci').createMany({ data: rows, onConflict: conflict })), SHARED_KEY);
    assert.ok(inserts.n >= 2, `expected a chunked call, got ${inserts.n} INSERT statement(s)`);
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM fxw_ci').get().n, 0);
    rows[39_999] = { email: 'z@x', name: 'last' };
    assert.equal((await db.table('fxw_ci').createMany({ data: rows, onConflict: conflict })).length, 40_000);
  });
});
