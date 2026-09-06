/**
 * turbine-orm, engine value fidelity + error-surface regressions
 *
 * Everything here guards a rule that was already WRITTEN down somewhere and
 * not enforced anywhere:
 *
 *  1. A column's runtime TYPE must not depend on the relation strategy, and it
 *     must not depend on WHICH POOL the client was built from either. Turbine
 *     pins driver flags only on pools it builds, while pool injection is a
 *     documented entry point, so any flag that changes a value makes those two
 *     entry points disagree. A MySQL `json` column broke both axes in turn: the
 *     join embedded it in `JSON_OBJECT` so the row parsed it into an OBJECT
 *     while the driver, pinned to hand JSON back as text, gave a STRING
 *     everywhere else (under the default `'auto'` strategy, adding a `limit`
 *     flipped the type); and the text pin itself only ever reached Turbine's
 *     own pool. The assertions here therefore run BOTH pool shapes, not just
 *     all four relation plans.
 *  2. A column Turbine GENERATES a `boolean` type for must read back as a
 *     boolean, whatever the schema calls the column and whatever the driver can
 *     tell us. SQLite has no boolean storage class and MySQL's is `TINYINT(1)`,
 *     so a value the ORM itself wrote as `true` came back as 1, `row.ok ===
 *     true` was false, and `JSON.stringify(row)` emitted `1`. Both engines fix
 *     it from a capability only the DIRECT read paths have (result-field
 *     metadata / `StatementSync.columns()`), so the join half has to be
 *     reachable from what the SCHEMA records and gated on the same capability,
 *     or it puts the split back pointing the other way.
 *  3. A connection string must never be echoed into an error. It carries a
 *     password, and the trigger is a MALFORMED string, which is exactly when
 *     it gets pasted into a bug report.
 *  4. `errorMessages: 'safe'` must keep row values out of `.cause` on EVERY
 *     engine, not just the one whose driver happens to split values into a
 *     `detail` field.
 *  5. `errorMessages` is per client, not the last constructor to run.
 *
 * SQLite runs live and in-process (node:sqlite builtin), so its assertions
 * execute on every PR in the unit lane. MySQL and SQL Server have no
 * in-process form, so each is covered twice: on the pure dialect/augmenter
 * functions (unit lane, no server) AND live behind `MYSQL_URL` / `MSSQL_URL`,
 * because the pool-shape axis above is invisible to a dialect-level test.
 *
 * Run: npx tsx --test src/test/engine-value-fidelity.test.ts
 *      MYSQL_URL=mysql://user:pw@host:3306 MSSQL_URL=mssql://sa:pw@host:1433/db \
 *        npx tsx --test src/test/engine-value-fidelity.test.ts
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { after, describe, it as nodeIt } from 'node:test';
import { ConnectionError, REDACTED_DETAIL, setErrorMessageMode } from '../errors.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import type { SchemaMetadata } from '../schema.js';

// ---------------------------------------------------------------------------
// SQLite harness (in-process, no server)
// ---------------------------------------------------------------------------

type DatabaseSyncCtor = new (path: string) => DatabaseSyncType;
let DatabaseSync: DatabaseSyncCtor | undefined;
try {
  DatabaseSync = (createRequire(process.cwd())('node:sqlite') as { DatabaseSync?: DatabaseSyncCtor }).DatabaseSync;
} catch {
  DatabaseSync = undefined;
}
const sqliteSkip = DatabaseSync ? '' : 'requires node:sqlite (Node >= 22.5)';
const it: typeof nodeIt = sqliteSkip
  ? (((name: string) => nodeIt(name, { skip: sqliteSkip }, () => {})) as typeof nodeIt)
  : nodeIt;

/**
 * Does THIS runtime's `node:sqlite` report a result column's declared type?
 *
 * The engine feature-detects `StatementSync.prototype.columns()` and keeps
 * reading 1/0 when it is absent, on purpose: see `driverReportsDeclaredTypes`
 * in sqlite.ts. The band where it is absent is real and inside the supported
 * range, MEASURED here rather than taken from a version number: absent on Node
 * 22.13.1, present on 24.18.0 and 26.8.1. So the assertions below have to ask
 * the SAME question the engine asks, or this file is green only on the half of
 * the band that happens to have the capability, which is the very split the
 * rule it guards exists to prevent.
 */
const driverNamesBooleanColumns = (() => {
  try {
    const ns = createRequire(process.cwd())('node:sqlite') as {
      StatementSync?: { prototype?: { columns?: unknown } };
    };
    return typeof ns.StatementSync?.prototype?.columns === 'function';
  } catch {
    return false;
  }
})();
/** What a declared-BOOLEAN column reads back as on this runtime. */
const TRUE_VALUE: unknown = driverNamesBooleanColumns ? true : 1;
const FALSE_VALUE: unknown = driverNamesBooleanColumns ? false : 0;
const noCapabilitySkip = driverNamesBooleanColumns
  ? ''
  : 'this Node build has no StatementSync.columns(), so removing it would simulate nothing';

const DDL = `
CREATE TABLE orgs (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL
);
CREATE TABLE items (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  ok     BOOLEAN NOT NULL,
  n      INTEGER NOT NULL
);
CREATE INDEX idx_items_org_id ON items(org_id);
INSERT INTO orgs (name) VALUES ('acme');
INSERT INTO items (org_id, ok, n) VALUES (1, 1, 5), (1, 0, 6);
`;

// biome-ignore lint/suspicious/noExplicitAny: TurbineClient's table() is generic over a row shape the fixture does not declare.
let client: any;
let handle: DatabaseSyncType | undefined;

async function connect(): Promise<void> {
  const { introspectSqliteDatabase, turbineSqlite } = await import('../sqlite.js');
  // Safe: only called when `sqliteSkip` is '', i.e. the probe above found it.
  handle = new (DatabaseSync as DatabaseSyncCtor)(':memory:');
  handle.exec(DDL);
  const schema: SchemaMetadata = introspectSqliteDatabase(handle);
  client = turbineSqlite(handle, schema, { warnOnUnlimited: false });
}

after(async () => {
  if (client) await client.disconnect();
});

// ---------------------------------------------------------------------------
// 1 + 2, value fidelity across every read path (live SQLite)
// ---------------------------------------------------------------------------

describe('engine value fidelity: a declared boolean reads back as a boolean on every path', () => {
  it('agrees across top level, join, batched and flatten', async () => {
    if (!client) await connect();

    const top = await client.table('items').findMany({ orderBy: { id: 'asc' } });
    // Strict, not truthy: `1 === true` is false, which is the whole bug. The
    // expected value follows the driver capability, because a runtime that
    // cannot name a boolean result column is documented to keep 1/0 rather
    // than guess.
    assert.equal(top[0].ok, TRUE_VALUE);
    assert.equal(top[1].ok, FALSE_VALUE);
    assert.equal(typeof top[0].ok, driverNamesBooleanColumns ? 'boolean' : 'number');

    // The relation strategies. `flatten` declines a hasMany and falls back to
    // the correlated subquery, which is fine: the point is that whatever plan
    // runs, the value is the same.
    for (const relationLoadStrategy of ['join', 'batched', 'flatten'] as const) {
      const rows = await client.table('orgs').findMany({ with: { items: true }, relationLoadStrategy });
      const items = rows[0].items as { ok: unknown }[];
      assert.equal(items[0]?.ok, TRUE_VALUE, `relationLoadStrategy: ${relationLoadStrategy}`);
      assert.equal(items[1]?.ok, FALSE_VALUE, `relationLoadStrategy: ${relationLoadStrategy}`);
    }
  });

  it('returns a boolean from a write the ORM itself performed', async () => {
    if (!client) await connect();
    const created = await client.table('items').create({ data: { orgId: 1, ok: true, n: 7 } });
    assert.equal(created.ok, TRUE_VALUE);
    const readBack = await client.table('items').findUnique({ where: { id: created.id } });
    assert.equal(readBack.ok, TRUE_VALUE);
  });

  it('leaves a non-boolean value in a declared-boolean column alone, on every path', async () => {
    // SQLite does not enforce the declared type, so a column declared BOOLEAN
    // can hold anything. Only 0 and 1 mean true/false; everything else has to
    // read back as the driver returns it, and identically on the join path,
    // which is why that rule narrows its text carrier with a CASE.
    if (!client) await connect();
    handle?.exec('INSERT INTO items (org_id, ok, n) VALUES (1, 7, 8)');
    const odd = (await client.table('items').findMany({ where: { n: 8 } }))[0];
    assert.equal(odd.ok, 7);
    const joined = await client.table('orgs').findMany({ with: { items: { where: { n: 8 } } } });
    assert.equal((joined[0].items as { ok: unknown }[])[0]?.ok, 7);
    handle?.exec('DELETE FROM items WHERE n = 8');
  });
});

describe('engine value fidelity: the SQLite boolean rule is gated on the capability it depends on', () => {
  // `StatementSync.columns()` arrived after this engine's 22.5 floor, so there
  // is a real band where the driver cannot name a boolean result column.
  // Measured, not read off a release note: absent on 22.13.1, present on
  // 24.18.0 and 26.8.1. On it, every DIRECT read keeps 1/0; a join that
  // still converted would be the same strategy-dependent flip pointing the
  // other way, and it would only ever show up on that band.
  const withoutColumns = async (fn: () => Promise<void> | void): Promise<void> => {
    const ns = createRequire(process.cwd())('node:sqlite') as {
      StatementSync: { prototype: Record<string, unknown> };
    };
    const proto = ns.StatementSync.prototype;
    const saved = Object.getOwnPropertyDescriptor(proto, 'columns');
    assert.ok(saved, 'this Node build already lacks columns(), so the simulation would prove nothing');
    delete proto.columns;
    try {
      await fn();
    } finally {
      Object.defineProperty(proto, 'columns', saved);
    }
  };

  it('declares no BOOL rule when the driver cannot report declared types', async (t) => {
    if (sqliteSkip) return;
    if (noCapabilitySkip) return t.skip(noCapabilitySkip);
    const { sqliteDialect } = await import('../sqlite.js');
    // Present by default on a supported Node: the rule exists.
    assert.ok(sqliteDialect.jsonWireRule?.('BOOLEAN'), 'the rule must exist when the capability does');
    await withoutColumns(() => {
      assert.equal(sqliteDialect.jsonWireRule?.('BOOLEAN'), undefined);
    });
  });

  it('reads 1/0 on BOTH the top level and the join when the capability is missing', async (t) => {
    if (sqliteSkip) return;
    if (noCapabilitySkip) return t.skip(noCapabilitySkip);
    const { introspectSqliteDatabase, turbineSqlite } = await import('../sqlite.js');
    await withoutColumns(async () => {
      const db = new (DatabaseSync as DatabaseSyncCtor)(':memory:');
      db.exec(DDL);
      // biome-ignore lint/suspicious/noExplicitAny: see `client` above.
      const c: any = turbineSqlite(db, introspectSqliteDatabase(db), { warnOnUnlimited: false });
      const top = await c.table('items').findMany({ orderBy: { id: 'asc' } });
      const joined = await c.table('orgs').findMany({ with: { items: true }, relationLoadStrategy: 'join' });
      const items = joined[0].items as { ok: unknown }[];
      // The claim is AGREEMENT, not a particular value: whatever this runtime
      // can do, both paths do the same thing.
      assert.equal(items[0]?.ok, top[0].ok, 'join and top level must agree');
      assert.equal(items[1]?.ok, top[1].ok, 'join and top level must agree');
      assert.equal(top[0].ok, 1, 'without the capability, the direct read cannot know it is a boolean');
      await c.disconnect();
    });
  });
});

describe('engine value fidelity: MySQL json and boolean carry through the join strategy', () => {
  it('declares NO json rule, so nothing re-types the column on the join path', () => {
    // A `CAST(… AS CHAR)` carrier makes the join match a top-level read only on
    // a pool Turbine BUILT, because the text half came from a `typeCast`
    // override in MYSQL_DRIVER_FLAGS and an injected mysql2 pool never receives
    // those flags. So the carrier traded a strategy-dependent split for a
    // pool-dependent one. With no rule and no override, mysql2 parses the
    // column and JSON_OBJECT embeds it parsed, which is the one answer both
    // pool shapes reach, and the one `pg` gives for json/jsonb.
    assert.equal(mysqlDialect.jsonWireRule?.('json'), undefined);
  });

  it('gives TINYINT(1) a rule that decodes back to a real boolean', () => {
    const rule = mysqlDialect.jsonWireRule?.('tinyint(1)');
    assert.ok(rule, 'MySQL must declare a wire rule for `tinyint(1)` columns');
    assert.equal(rule.sql('`t0`.`ok`'), 'CAST(`t0`.`ok` AS CHAR)');
    assert.equal(rule.decode('1'), true);
    assert.equal(rule.decode('0'), false);
    // A TINYINT(1) can legally hold other integers; those keep the driver's
    // reading (a number), never a string.
    assert.equal(rule.decode('7'), 7);
  });

  it('leaves a plain tinyint alone, so a real one-byte integer is not made boolean', () => {
    // `tinyint` and `tinyint(1)` share a DATA_TYPE; only the recorded dialect
    // type separates them. Keying the rule on the bare spelling would have
    // turned every small integer into a boolean on the join path only.
    assert.equal(mysqlDialect.jsonWireRule?.('tinyint'), undefined);
  });

  it('SQL Server needs no json rule: nvarchar round-trips as text on both routes', () => {
    // SQL Server has no JSON column type on the supported floor (2016-2022);
    // JSON lives in NVARCHAR(MAX). FOR JSON PATH escapes an nvarchar cell as a
    // JSON string (only nested relations are JSON_QUERY-wrapped), so the join
    // already returns the same string a top-level read does. Asserted so the
    // absence stays a decision rather than an oversight; the live check below
    // is what proves it.
    assert.equal(mssqlDialect.jsonWireRule?.('nvarchar'), undefined);
    assert.equal(mssqlDialect.jsonWireRule?.('varchar'), undefined);
  });
});

const MSSQL_URL = process.env.MSSQL_URL ?? process.env.MSSQL_TEST_URL ?? '';
const mssqlSkip = MSSQL_URL ? '' : 'requires MSSQL_URL pointing at a SQL Server 2016+ instance';
const mssqlIt: typeof nodeIt = mssqlSkip
  ? (((name: string) => nodeIt(name, { skip: mssqlSkip }, () => {})) as typeof nodeIt)
  : nodeIt;

describe('engine value fidelity: SQL Server agrees across paths AND pool shapes', () => {
  // The same two questions asked of MySQL, asked here because the answers are
  // reached differently and both were previously only reasoned about: SQL
  // Server has no JSON column type (JSON is NVARCHAR, so text really is the
  // value) and `turbineMssql` pins no value-affecting driver options, so an
  // injected `mssql` pool has nothing to diverge from.
  mssqlIt('nvarchar JSON stays text and BIT stays boolean, on both pools', async () => {
    // Loaded through the same helper the engine uses, not a bare
    // `import('mssql')`. `mssql` v12 ships no declaration file and the repo
    // deliberately carries no `@types/mssql` (see the dependency rule in
    // CLAUDE.md), so a static specifier makes `tsc --noEmit` fail on TS7016 for
    // everyone, including the release gate, whether or not a SQL Server is
    // reachable. The engine types the namespace structurally for the same
    // reason.
    const { default: importOptionalPeer } = await import('../optional-peer-import.cjs');
    const mssql = (await importOptionalPeer('mssql')) as Record<string, unknown>;
    // biome-ignore lint/suspicious/noExplicitAny: the mssql namespace is structurally typed inside the engine.
    const sql: any = (mssql as { default?: unknown }).default ?? mssql;
    const { introspectMssqlWith, MssqlPool, turbineMssql } = await import('../mssql.js');
    const url = new URL(MSSQL_URL);
    const cfg = {
      server: url.hostname,
      port: url.port ? Number(url.port) : 1433,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      options: { encrypt: false, trustServerCertificate: true },
    };
    const DB = url.pathname.replace(/^\//, '') || 'turbine_fidelity';
    const admin = await new sql.ConnectionPool({ ...cfg, database: 'master' }).connect();
    await admin.request().batch(`IF DB_ID('${DB}') IS NULL CREATE DATABASE [${DB}]`);
    await admin.close();

    const raw = await new sql.ConnectionPool({ ...cfg, database: DB }).connect();
    try {
      for (const stmt of [
        "IF OBJECT_ID('mx_items') IS NOT NULL DROP TABLE mx_items",
        "IF OBJECT_ID('mx_orgs') IS NOT NULL DROP TABLE mx_orgs",
        'CREATE TABLE mx_orgs (id INT PRIMARY KEY, meta NVARCHAR(MAX), flag BIT NOT NULL)',
        'CREATE TABLE mx_items (id INT PRIMARY KEY, org_id INT REFERENCES mx_orgs(id), tags NVARCHAR(MAX))',
        'CREATE INDEX idx_mx_items_org ON mx_items(org_id)',
        `INSERT INTO mx_orgs (id, meta, flag) VALUES (1, N'{"tier":"gold"}', 1)`,
        `INSERT INTO mx_items (id, org_id, tags) VALUES (1, 1, N'["a","b"]')`,
      ]) {
        await raw.request().batch(stmt);
      }
      const shim = new MssqlPool(raw, sql);
      const schema = await introspectMssqlWith(async (s, p) => (await shim.query(s, p)).rows, 'dbo');
      const toOne = Object.keys(schema.tables.mx_items?.relations ?? {}).find(
        (r) => schema.tables.mx_items?.relations[r]?.type === 'belongsTo',
      );
      assert.ok(toOne, 'the fixture must introspect the belongsTo side');

      // biome-ignore lint/suspicious/noExplicitAny: TurbineClient, see `client` above.
      const injected: any = await turbineMssql(shim, schema, { warnOnUnlimited: false });
      // biome-ignore lint/suspicious/noExplicitAny: see above.
      const owned: any = await turbineMssql(MSSQL_URL, schema, { warnOnUnlimited: false });
      try {
        const readings: [string, unknown][] = [];
        for (const [poolName, db] of [
          ['owned', owned],
          ['injected', injected],
          // biome-ignore lint/suspicious/noExplicitAny: see above.
        ] as [string, any][]) {
          const top = (await db.table('mx_orgs').findMany())[0];
          readings.push([`${poolName}/top-level/meta`, top.meta], [`${poolName}/top-level/flag`, top.flag]);
          for (const strategy of ['join', 'batched'] as const) {
            const rows = await db
              .table('mx_items')
              .findMany({ with: { [toOne]: true }, relationLoadStrategy: strategy });
            const org = rows[0][toOne] as Record<string, unknown>;
            readings.push([`${poolName}/${strategy}/meta`, org.meta], [`${poolName}/${strategy}/flag`, org.flag]);
          }
        }
        const trail = readings.map(([l, v]) => `  ${l.padEnd(26)} ${JSON.stringify(v)}`).join('\n');
        for (const [label, value] of readings) {
          const expected = label.endsWith('/flag') ? true : '{"tier":"gold"}';
          assert.deepEqual(value, expected, `${label} disagreed. All readings:\n${trail}`);
        }
      } finally {
        await owned.disconnect();
        await injected.disconnect();
      }
    } finally {
      await raw.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 1b, MySQL json: live, and across BOTH pool shapes
// ---------------------------------------------------------------------------

const MYSQL_URL = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const mysqlSkip = MYSQL_URL ? '' : 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a MySQL 8 server';
const mysqlIt: typeof nodeIt = mysqlSkip
  ? (((name: string) => nodeIt(name, { skip: mysqlSkip }, () => {})) as typeof nodeIt)
  : nodeIt;

describe('engine value fidelity: a MySQL json column reads the same on every path AND every pool shape', () => {
  // The pool shape is the second axis, and the one a dialect-only test cannot
  // see. Turbine's own pool receives MYSQL_DRIVER_FLAGS; an injected mysql2
  // pool is a documented entry point and receives nothing. Any flag that
  // changes a VALUE therefore makes the two disagree, so this reads the same
  // column through four relation plans on both, and demands one answer.
  const DB = 'turbine_json_fidelity';
  const DOC = { tier: 'gold', n: 2 };
  const TAGS = ['a', 'b'];

  mysqlIt('owned and injected pools agree, on top level, join, batched and flatten', async () => {
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
    await admin.query(`CREATE DATABASE IF NOT EXISTS \`${DB}\``);
    await admin.end();

    // The INJECTED pool: exactly what a caller who reads the docs would build.
    // `namedPlaceholders` is the one flag Turbine's SQL requires; nothing here
    // touches how a value is typed.
    const rawPool = createPool({ ...base, database: DB, namedPlaceholders: true });
    for (const stmt of [
      'DROP TABLE IF EXISTS jf_items',
      'DROP TABLE IF EXISTS jf_orgs',
      'CREATE TABLE jf_orgs (id INT PRIMARY KEY, meta JSON)',
      'CREATE TABLE jf_items (id INT PRIMARY KEY, org_id INT, tags JSON, ' +
        'CONSTRAINT fk_jf_items_org FOREIGN KEY (org_id) REFERENCES jf_orgs(id))',
      'CREATE INDEX idx_jf_items_org_id ON jf_items(org_id)',
    ]) {
      await rawPool.query(stmt);
    }
    await rawPool.query('INSERT INTO jf_orgs (id, meta) VALUES (1, ?)', [JSON.stringify(DOC)]);
    await rawPool.query('INSERT INTO jf_items (id, org_id, tags) VALUES (1, 1, ?)', [JSON.stringify(TAGS)]);

    const shim = new MysqlPool(rawPool);
    const schema = await introspectMysqlWith(async (sql, params) => (await shim.query(sql, params)).rows, DB);
    // Relation names come from introspection; read them rather than guessing.
    const toOne = Object.keys(schema.tables.jf_items?.relations ?? {}).find(
      (r) => schema.tables.jf_items?.relations[r]?.type === 'belongsTo',
    );
    const toMany = Object.keys(schema.tables.jf_orgs?.relations ?? {}).find(
      (r) => schema.tables.jf_orgs?.relations[r]?.type === 'hasMany',
    );
    assert.ok(toOne && toMany, 'the fixture must introspect both sides of the FK');

    const ownedUrl = new URL(MYSQL_URL);
    ownedUrl.pathname = `/${DB}`;
    // biome-ignore lint/suspicious/noExplicitAny: TurbineClient, see `client` above.
    const owned: any = await turbineMysql(ownedUrl.toString(), schema, { warnOnUnlimited: false });
    // biome-ignore lint/suspicious/noExplicitAny: see above.
    const injected: any = await turbineMysql(shim, schema, { warnOnUnlimited: false });

    try {
      const readings: [string, unknown][] = [];
      for (const [poolName, db] of [
        ['owned', owned],
        ['injected', injected],
        // biome-ignore lint/suspicious/noExplicitAny: see above.
      ] as [string, any][]) {
        readings.push([`${poolName}/top-level`, (await db.table('jf_orgs').findMany())[0].meta]);
        for (const strategy of ['join', 'batched', 'flatten'] as const) {
          const rows = await db.table('jf_items').findMany({ with: { [toOne]: true }, relationLoadStrategy: strategy });
          readings.push([`${poolName}/to-one/${strategy}`, (rows[0][toOne] as { meta?: unknown }).meta]);
          const parents = await db
            .table('jf_orgs')
            .findMany({ with: { [toMany]: true }, relationLoadStrategy: strategy });
          readings.push([`${poolName}/to-many/${strategy}`, (parents[0][toMany] as { tags?: unknown }[])[0]?.tags]);
        }
      }
      for (const [label, value] of readings) {
        const expected = label.includes('to-many') ? TAGS : DOC;
        assert.deepEqual(
          value,
          expected,
          `${label} disagreed. All readings:\n${readings.map(([l, v]) => `  ${l.padEnd(26)} ${JSON.stringify(v)}`).join('\n')}`,
        );
      }
    } finally {
      await owned.disconnect();
      await injected.disconnect();
      await rawPool.end();
    }
  });

  mysqlIt('a boolean reads back as a boolean from a schema that predates the tinyint(1) spelling', async () => {
    // The join is the only read path that consults the RECORDED dialect type
    // (the top level reads the result fields), so a metadata file generated
    // before Turbine kept the display width, or a code-first `defineSchema`
    // column typed `boolean`, would read `true` at the top level and `1`
    // through a `with` join. Both spellings are exercised here; neither
    // requires the caller to regenerate.
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
    await admin.query(`CREATE DATABASE IF NOT EXISTS \`${DB}\``);
    await admin.end();
    const rawPool = createPool({ ...base, database: DB, namedPlaceholders: true });
    for (const stmt of [
      'DROP TABLE IF EXISTS bf_items',
      'DROP TABLE IF EXISTS bf_orgs',
      'CREATE TABLE bf_orgs (id INT PRIMARY KEY)',
      'CREATE TABLE bf_items (id INT PRIMARY KEY, org_id INT, ok BOOLEAN NOT NULL, n TINYINT NOT NULL, ' +
        'CONSTRAINT fk_bf_items_org FOREIGN KEY (org_id) REFERENCES bf_orgs(id))',
      'CREATE INDEX idx_bf_items_org_id ON bf_items(org_id)',
      'INSERT INTO bf_orgs (id) VALUES (1)',
      'INSERT INTO bf_items (id, org_id, ok, n) VALUES (1, 1, 1, 7), (2, 1, 0, 8)',
    ]) {
      await rawPool.query(stmt);
    }
    const shim = new MysqlPool(rawPool);
    const fresh = await introspectMysqlWith(async (sql, params) => (await shim.query(sql, params)).rows, DB);
    const toMany = Object.keys(fresh.tables.bf_orgs?.relations ?? {}).find(
      (r) => fresh.tables.bf_orgs?.relations[r]?.type === 'hasMany',
    );
    assert.ok(toMany, 'the fixture must introspect the hasMany side');

    // Rewrite the recorded type to each older spelling, leaving `tsType`
    // exactly as a real generated file has it. `n` is a genuine TINYINT and
    // must come through as the number 7 on every path.
    const degrade = (spelling: string): SchemaMetadata => ({
      ...fresh,
      tables: Object.fromEntries(
        Object.entries(fresh.tables).map(([name, t]) => {
          const columns = t.columns.map((c) =>
            /^boolean\b/.test(c.tsType) ? { ...c, dialectType: spelling, pgType: spelling } : c,
          );
          return [name, { ...t, columns, pgTypes: Object.fromEntries(columns.map((c) => [c.name, c.pgType])) }];
        }),
      ),
    });

    try {
      for (const spelling of ['tinyint', 'boolean', 'bool']) {
        // biome-ignore lint/suspicious/noExplicitAny: TurbineClient, see `client` above.
        const db: any = await turbineMysql(shim, degrade(spelling), { warnOnUnlimited: false });
        const top = await db.table('bf_items').findMany({ orderBy: { id: 'asc' } });
        assert.equal(top[0].ok, true, `${spelling}: top level`);
        const joined = await db.table('bf_orgs').findMany({ with: { [toMany]: true }, relationLoadStrategy: 'join' });
        const items = joined[0][toMany] as { ok: unknown; n: unknown }[];
        assert.equal(items[0]?.ok, true, `${spelling}: join disagreed with the top level`);
        assert.equal(items[1]?.ok, false, `${spelling}: join disagreed with the top level`);
        // The narrowness of the fix: a real one-byte integer is untouched.
        assert.equal(items[0]?.n, 7, `${spelling}: a genuine tinyint was re-typed`);
        await db.disconnect();
      }
    } finally {
      // The pool must close even on a failed assertion, or the runner hangs on
      // the open handle instead of reporting the failure.
      await rawPool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// 3, connection strings are never echoed
// ---------------------------------------------------------------------------

describe('engine connection errors never echo the connection string', () => {
  const PASSWORD = 'sup3r-s3cret-pw';
  const HOST = 'db.internal.example';

  // A string with a password and a host that CANNOT parse as a URL (a bare
  // colon in the port), which is the shape that reaches these branches.
  const malformed = (scheme: string) => `${scheme}://admin:${PASSWORD}@${HOST}:not-a-port/app`;

  const assertRedacted = (err: unknown, scheme: string) => {
    assert.ok(err instanceof ConnectionError, 'must be a typed ConnectionError');
    assert.equal(err.code, 'TURBINE_E004');
    assert.ok(!err.message.includes(PASSWORD), `password leaked: ${err.message}`);
    assert.ok(!err.message.includes(HOST), `host leaked: ${err.message}`);
    assert.ok(!err.message.includes(malformed(scheme)), 'the raw value leaked');
    // Says WHY the value is missing, so the message is not just unhelpful.
    assert.match(err.message, /may contain a password/);
  };

  it('MySQL', async () => {
    const { turbineMysql } = await import('../mysql.js');
    await assert.rejects(
      () => turbineMysql(malformed('mysql'), { tables: {}, enums: {} }),
      (err: unknown) => {
        assertRedacted(err, 'mysql');
        return true;
      },
    );
  });

  it('SQL Server', async () => {
    const { turbineMssql } = await import('../mssql.js');
    await assert.rejects(
      () => turbineMssql(malformed('mssql'), { tables: {}, enums: {} }),
      (err: unknown) => {
        assertRedacted(err, 'mssql');
        return true;
      },
    );
  });

  it('PowDB', async () => {
    const { parsePowdbUrl } = await import('../powdb.js');
    assert.throws(
      () => parsePowdbUrl(malformed('powdb')),
      (err: unknown) => {
        assertRedacted(err, 'powdb');
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 4, safe mode withholds a value-bearing driver MESSAGE
// ---------------------------------------------------------------------------

describe("errorMessages: 'safe' withholds row values that live in the driver message", () => {
  const SECRET = 'alice@example.com';

  /** A mysql2-shaped ER_DUP_ENTRY: value in `message`/`sqlMessage`, no `detail`. */
  const mysqlDupEntry = () => {
    const err = new Error(`Duplicate entry '${SECRET}' for key 'users.email'`) as Error & {
      errno: number;
      sqlMessage: string;
      sqlState: string;
    };
    err.errno = 1062;
    err.sqlMessage = `Duplicate entry '${SECRET}' for key 'users.email'`;
    err.sqlState = '23000';
    return err;
  };

  /** An mssql-shaped 2627: the value is in the trailing sentence of `message`. */
  const mssqlDuplicateKey = () => {
    const err = new Error(
      "Violation of UNIQUE KEY constraint 'UQ_users_email'. Cannot insert duplicate key in object " +
        `'dbo.users'. The duplicate key value is (${SECRET}).`,
    ) as Error & { number: number };
    err.number = 2627;
    return err;
  };

  after(() => setErrorMessageMode('safe'));

  const cases: [string, () => Error, (e: unknown) => unknown][] = [];

  it('MySQL: no row value survives anywhere on the thrown error', async () => {
    setErrorMessageMode('safe');
    const { wrapPgError } = await import('../errors.js');
    // The engine augmenter is what tags the driver error; run the real one.
    const mysql = await import('../mysql.js');
    // augmentMysqlError is module-private, and MysqlPool.query is its only
    // public route, so drive it through a queryable that throws the raw error.
    const pool = new mysql.MysqlPool({
      query: () => Promise.reject(mysqlDupEntry()),
      execute: () => Promise.reject(mysqlDupEntry()),
      getConnection: () => Promise.reject(new Error('unused')),
      end: () => Promise.resolve(),
    });
    const augmented = await pool.query('SELECT 1', [1]).then(
      () => undefined,
      (e: unknown) => e,
    );
    const wrapped = wrapPgError(augmented) as Error;
    const cause = wrapped.cause as (Error & { sqlMessage?: string }) | undefined;
    const rendered = [
      wrapped.message,
      JSON.stringify(wrapped, Object.getOwnPropertyNames(wrapped)),
      cause?.message,
      cause?.stack,
      cause?.sqlMessage,
    ].join('\n');
    assert.ok(!rendered.includes(SECRET), `row value leaked:\n${rendered}`);
    // Still diagnostic: the constraint NAME survives, and so does the code.
    assert.equal((wrapped as { constraint?: string }).constraint, 'email');
    assert.equal((wrapped as { code?: string }).code, 'TURBINE_E008');
    assert.match((wrapped.cause as Error).message, new RegExp(REDACTED_DETAIL.replace(/[[\]"]/g, '\\$&')));
  });

  it('SQL Server: no row value survives anywhere on the thrown error', async () => {
    setErrorMessageMode('safe');
    const { wrapPgError } = await import('../errors.js');
    const mssql = await import('../mssql.js');
    // MssqlPool needs a driver namespace; only `query` is exercised here, and
    // it rejects before touching anything else.
    const failing = {
      // biome-ignore lint/suspicious/noExplicitAny: minimal mssql Request stand-in.
      request: (): any => ({
        input: () => {},
        query: () => Promise.reject(mssqlDuplicateKey()),
        batch: () => Promise.reject(mssqlDuplicateKey()),
      }),
      connect: () => Promise.resolve(),
      close: () => Promise.resolve(),
      transaction: () => ({}),
    };
    // biome-ignore lint/suspicious/noExplicitAny: the mssql namespace is structurally typed inside the engine.
    const pool = new mssql.MssqlPool(failing as any, { ISOLATION_LEVEL: {} } as any);
    const augmented = await pool.query('SELECT 1', [1]).then(
      () => undefined,
      (e: unknown) => e,
    );
    const wrapped = wrapPgError(augmented) as Error;
    const rendered = `${wrapped.message}\n${(wrapped.cause as Error)?.message}\n${(wrapped.cause as Error)?.stack}`;
    assert.ok(!rendered.includes(SECRET), `row value leaked:\n${rendered}`);
    assert.equal((wrapped as { constraint?: string }).constraint, 'UQ_users_email');
  });

  it("'verbose' hands the driver message back in full", async () => {
    setErrorMessageMode('verbose');
    const { wrapPgError } = await import('../errors.js');
    const mysql = await import('../mysql.js');
    const pool = new mysql.MysqlPool({
      query: () => Promise.reject(mysqlDupEntry()),
      execute: () => Promise.reject(mysqlDupEntry()),
      getConnection: () => Promise.reject(new Error('unused')),
      end: () => Promise.resolve(),
    });
    const augmented = await pool.query('SELECT 1', [1]).then(
      () => undefined,
      (e: unknown) => e,
    );
    const wrapped = wrapPgError(augmented) as Error;
    assert.ok((wrapped.cause as Error).message.includes(SECRET));
    setErrorMessageMode('safe');
  });

  // Referenced above only to keep the shape explicit for a future engine.
  void cases;
});

// ---------------------------------------------------------------------------
// 5, errorMessages is per client
// ---------------------------------------------------------------------------

describe('errorMessages is per client, not the last constructor to run', () => {
  it('two clients at different modes each keep their own', async () => {
    if (sqliteSkip) return;
    const { introspectSqliteDatabase, turbineSqlite } = await import('../sqlite.js');
    const build = (mode: 'safe' | 'verbose') => {
      const db = new (DatabaseSync as DatabaseSyncCtor)(':memory:');
      db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE);
               INSERT INTO users (id, email) VALUES (1, 'alice@example.com');`);
      // biome-ignore lint/suspicious/noExplicitAny: see `client` above.
      return turbineSqlite(db, introspectSqliteDatabase(db), { errorMessages: mode, warnOnUnlimited: false }) as any;
    };

    // Order matters: the SAFE client is built FIRST. Under the old
    // process-global the verbose constructor would have downgraded it, which
    // is the direction that leaks.
    const safeClient = build('safe');
    const verboseClient = build('verbose');

    const notFound = async (c: { table: (n: string) => { findUniqueOrThrow: (a: unknown) => Promise<unknown> } }) => {
      try {
        await c.table('users').findUniqueOrThrow({ where: { email: 'nobody@example.com' } });
        return '';
      } catch (err) {
        return (err as Error).message;
      }
    };
    const dupCauseDetail = async (c: { table: (n: string) => { create: (a: unknown) => Promise<unknown> } }) => {
      try {
        await c.table('users').create({ data: { id: 2, email: 'alice@example.com' } });
        return undefined;
      } catch (err) {
        return ((err as Error).cause as { detail?: string } | undefined)?.detail;
      }
    };

    const safeMessage = await notFound(safeClient);
    const verboseMessage = await notFound(verboseClient);
    assert.ok(!safeMessage.includes('nobody@example.com'), `safe client leaked: ${safeMessage}`);
    assert.match(safeMessage, /where: \{ email \}/);
    assert.ok(verboseMessage.includes('nobody@example.com'), `verbose client was downgraded: ${verboseMessage}`);

    // The redacted `.cause` follows the same per-client mode.
    assert.equal(await dupCauseDetail(safeClient), REDACTED_DETAIL);
    assert.match(String(await dupCauseDetail(verboseClient)), /^Key \(email\)/);

    // And it holds in BOTH directions after the fact: re-checking the safe
    // client last proves the verbose one did not latch a global on its way
    // through.
    assert.ok(!(await notFound(safeClient)).includes('nobody@example.com'));

    await safeClient.disconnect();
    await verboseClient.disconnect();
    setErrorMessageMode('safe');
  });
});

// ---------------------------------------------------------------------------
// SQL Server LIKE pattern grammar
// ---------------------------------------------------------------------------

describe('mssqlDialect.escapeLikePattern escapes the T-SQL character-class opener', () => {
  it('escapes `[` in addition to the shared set', () => {
    // Without this, `contains: '[draft]'` means "contains any one of d, r, a,
    // f, t" on SQL Server: a silently over-broad predicate.
    assert.equal(mssqlDialect.escapeLikePattern?.('[draft]'), '\\[draft]');
    assert.equal(mssqlDialect.escapeLikePattern?.('a[b-z]c'), 'a\\[b-z]c');
  });

  it('still escapes the shared set, and escapes the escape character first', () => {
    assert.equal(mssqlDialect.escapeLikePattern?.('100%'), '100\\%');
    assert.equal(mssqlDialect.escapeLikePattern?.('foo_bar'), 'foo\\_bar');
    assert.equal(mssqlDialect.escapeLikePattern?.('a\\b'), 'a\\\\b');
    // A backslash already in the value must not become an escape for the `[`
    // that follows it.
    assert.equal(mssqlDialect.escapeLikePattern?.('a\\[b'), 'a\\\\\\[b');
  });

  it('leaves an ordinary value untouched', () => {
    assert.equal(mssqlDialect.escapeLikePattern?.('hello world'), 'hello world');
  });

  it('is the only dialect that treats `[` specially', async () => {
    const { postgresDialect } = await import('../dialect.js');
    const { sqliteDialect } = await import('../sqlite.js');
    // The other three leave `[` alone, which is why this is a dialect hook and
    // not a change to the shared escapeLike.
    assert.equal(postgresDialect.escapeLikePattern?.('[draft]') ?? '[draft]', '[draft]');
    assert.equal(sqliteDialect.escapeLikePattern?.('[draft]') ?? '[draft]', '[draft]');
    assert.equal(mysqlDialect.escapeLikePattern?.('[draft]') ?? '[draft]', '[draft]');
  });
});
