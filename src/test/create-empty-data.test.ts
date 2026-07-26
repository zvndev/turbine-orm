/**
 * turbine-orm: `create({ data: {} })` / `createMany({ data: [{}, …] })`.
 *
 * A `data` object that names no column used to compile to `INSERT INTO "t" ()
 * VALUES ()`, which is a syntax error on every engine but MySQL (Postgres 42601
 * `syntax error at or near ")"`). It is easy to reach honestly: a handler that
 * assembles its payload from optional request fields produces `{}` on a request
 * that supplied none of them, against a table where every column has a default
 * or is nullable. Same shape as the empty-`update` no-op fixed in 0.51.0.
 *
 * The correct statement differs per engine, so it lives behind the dialect seam
 * (`Dialect.buildDefaultValuesInsertStatement`). Two tiers here:
 *
 *  1. **Build-only** (no DB): the emitted statement per dialect, the E017
 *     refusals for shapes an engine cannot express, and the guarantee that a
 *     NON-empty create is untouched.
 *  2. **Live**: SQLite in-process via `node:sqlite`, plus Postgres / MySQL /
 *     SQL Server gated on DATABASE_URL / MYSQL_URL / MSSQL_URL.
 *
 * Run: npx tsx --test src/test/create-empty-data.test.ts
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it as nodeIt } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import type { Dialect } from '../dialect.js';
import { postgresDialect } from '../dialect.js';
import { UnsupportedFeatureError, ValidationError } from '../errors.js';
import { introspect } from '../introspect.js';
import { introspectMssqlWith, MssqlPool, mssqlDialect, turbineMssql } from '../mssql.js';
import { introspectMysqlWith, MysqlPool, mysqlDialect, turbineMysql } from '../mysql.js';
import type { SchemaMetadata } from '../schema.js';
import { sqliteDialect, turbineSqlite } from '../sqlite.js';
import { makeQuery, mockTable, skipGate } from './helpers.js';

// ---------------------------------------------------------------------------
// Tier 1, build-only
// ---------------------------------------------------------------------------

function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      report_schedule: mockTable('report_schedule', [
        { name: 'id', field: 'id' },
        { name: 'label', field: 'label', pgType: 'text' },
        { name: 'active', field: 'active', pgType: 'bool' },
      ]),
    },
  };
}

/** The same schema with `label` tagged as PII, so the write projection is explicit. */
function piiSchema(): SchemaMetadata {
  const s = schema();
  const label = s.tables.report_schedule!.columns.find((c) => c.name === 'label')!;
  label.pii = true;
  return s;
}

function q(dialect: Dialect, meta: SchemaMetadata = schema()) {
  return makeQuery('report_schedule', meta, { dialect });
}

describe('create({ data: {} }), emitted SQL per dialect', () => {
  nodeIt('postgres inserts a row of defaults', () => {
    const d = q(postgresDialect).buildCreate({ data: {} });
    assert.equal(d.sql, 'INSERT INTO "report_schedule" DEFAULT VALUES RETURNING *');
    assert.deepEqual(d.params, []);
  });

  nodeIt('sqlite inserts a row of defaults', () => {
    const d = q(sqliteDialect).buildCreate({ data: {} });
    assert.equal(d.sql, 'INSERT INTO "report_schedule" DEFAULT VALUES RETURNING *');
    assert.deepEqual(d.params, []);
  });

  nodeIt('mysql keeps its legal empty VALUES tuple (no RETURNING)', () => {
    const d = q(mysqlDialect).buildCreate({ data: {} });
    assert.equal(d.sql, 'INSERT INTO `report_schedule` () VALUES ()');
    assert.deepEqual(d.params, []);
  });

  nodeIt('mssql puts OUTPUT before DEFAULT VALUES', () => {
    const d = q(mssqlDialect).buildCreate({ data: {} });
    assert.equal(d.sql, 'INSERT INTO [report_schedule] OUTPUT INSERTED.* DEFAULT VALUES');
    assert.deepEqual(d.params, []);
  });

  nodeIt('an all-undefined data object takes the same path', () => {
    const d = q(postgresDialect).buildCreate({ data: { label: undefined } as never });
    assert.equal(d.sql, 'INSERT INTO "report_schedule" DEFAULT VALUES RETURNING *');
  });

  nodeIt('the PII write projection still applies', () => {
    // `writeReturningColumns` is unchanged: the tagged column must not appear.
    assert.equal(
      q(postgresDialect, piiSchema()).buildCreate({ data: {} }).sql,
      'INSERT INTO "report_schedule" DEFAULT VALUES RETURNING "id", "active"',
    );
    assert.equal(
      q(mssqlDialect, piiSchema()).buildCreate({ data: {} }).sql,
      'INSERT INTO [report_schedule] OUTPUT INSERTED.[id], INSERTED.[active] DEFAULT VALUES',
    );
  });

  nodeIt('a dialect with no all-defaults form refuses with E017', () => {
    const bare: Dialect = { ...postgresDialect, name: 'nodefaults', buildDefaultValuesInsertStatement: undefined };
    assert.throws(
      () => q(bare).buildCreate({ data: {} }),
      (e: Error) => e instanceof UnsupportedFeatureError,
    );
  });
});

describe('createMany({ data: [{}, …] }), emitted SQL per dialect', () => {
  nodeIt('postgres: one empty row uses DEFAULT VALUES', () => {
    const d = q(postgresDialect).buildCreateMany({ data: [{}] });
    assert.equal(d.sql, 'INSERT INTO "report_schedule" DEFAULT VALUES RETURNING *');
    assert.deepEqual(d.params, []);
  });

  nodeIt('postgres: N empty rows use a zero-column generate_series source', () => {
    const d = q(postgresDialect).buildCreateMany({ data: [{}, {}, {}] });
    assert.equal(d.sql, 'INSERT INTO "report_schedule" SELECT FROM generate_series(1, 3) RETURNING *');
    assert.deepEqual(d.params, []);
  });

  nodeIt('postgres: skipDuplicates still appends ON CONFLICT DO NOTHING', () => {
    const d = q(postgresDialect).buildCreateMany({ data: [{}, {}], skipDuplicates: true });
    assert.equal(
      d.sql,
      'INSERT INTO "report_schedule" SELECT FROM generate_series(1, 2) ON CONFLICT DO NOTHING RETURNING *',
    );
  });

  nodeIt('mysql repeats the empty VALUES tuple', () => {
    const d = q(mysqlDialect).buildCreateMany({ data: [{}, {}] });
    assert.equal(d.sql, 'INSERT INTO `report_schedule` () VALUES (), ()');
    assert.deepEqual(d.params, []);
  });

  nodeIt('sqlite: one empty row works, more than one is E017', () => {
    assert.equal(
      q(sqliteDialect).buildCreateMany({ data: [{}] }).sql,
      'INSERT INTO "report_schedule" DEFAULT VALUES RETURNING *',
    );
    assert.throws(
      () => q(sqliteDialect).buildCreateMany({ data: [{}, {}] }),
      (e: Error) => e instanceof UnsupportedFeatureError && /sqlite/.test(e.message),
    );
  });

  nodeIt('mssql: one empty row works, more than one is E017', () => {
    assert.equal(
      q(mssqlDialect).buildCreateMany({ data: [{}] }).sql,
      'INSERT INTO [report_schedule] OUTPUT INSERTED.* DEFAULT VALUES',
    );
    assert.throws(
      () => q(mssqlDialect).buildCreateMany({ data: [{}, {}] }),
      (e: Error) => e instanceof UnsupportedFeatureError && /mssql/.test(e.message),
    );
  });

  nodeIt('mysql refuses skipDuplicates on rows of pure defaults', () => {
    assert.throws(
      () => q(mysqlDialect).buildCreateMany({ data: [{}, {}], skipDuplicates: true }),
      (e: Error) => e instanceof UnsupportedFeatureError,
    );
  });

  nodeIt('a first row naming no column while a later row does is refused', () => {
    // The column list comes from the first row alone, so the later row's values
    // would be silently dropped. That used to be a syntax error, not data loss.
    // The reverse (a later row OMITTING a first-row field, which binds NULL over
    // that column's default) is refused by the same guard; both directions live
    // in src/test/create-many-uniform-rows.test.ts.
    assert.throws(
      () => q(postgresDialect).buildCreateMany({ data: [{}, { label: 'x' }] as never }),
      (e: Error) => e instanceof ValidationError && /row 1/.test(e.message),
    );
  });

  nodeIt('an empty data array is still the zero-row short circuit', () => {
    const d = q(postgresDialect).buildCreateMany({ data: [] });
    assert.equal(d.sql, 'SELECT * FROM "report_schedule" WHERE false');
  });
});

describe('a non-empty create is untouched', () => {
  for (const [name, dialect] of [
    ['postgres', postgresDialect],
    ['sqlite', sqliteDialect],
    ['mysql', mysqlDialect],
    ['mssql', mssqlDialect],
  ] as const) {
    nodeIt(`${name} still emits the column-driven INSERT`, () => {
      const d = q(dialect).buildCreate({ data: { label: 'weekly' } as never });
      assert.match(d.sql, /INSERT INTO .report_schedule. \(.label.\)/);
      assert.deepEqual(d.params, ['weekly']);
    });
  }
});

// ---------------------------------------------------------------------------
// Tier 2, live engines
// ---------------------------------------------------------------------------

/**
 * The probe table: every column either auto-assigns or defaults, so an empty
 * `data` is a legitimate insert. The auto-PK spelling and the text type differ
 * per engine (MySQL refuses a literal default on TEXT), so each caller supplies
 * both.
 */
const probeDdl = (autoPk: string, textType: string) =>
  `CREATE TABLE default_values_probe (id ${autoPk}, label ${textType} DEFAULT 'unnamed', runs INT DEFAULT 0)`;

/** node:sqlite is a builtin only on Node >= 22.5; probe without a static import. */
const hasNodeSqlite = (() => {
  try {
    createRequire(process.cwd())('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();

const sqliteGate = skipGate(!hasNodeSqlite, 'turbine-orm/sqlite requires node:sqlite (Node >= 22.5)');

describe('create({ data: {} }) live, sqlite', () => {
  sqliteGate.it('inserts and returns the defaulted row', async () => {
    const { introspectSqliteDatabase } = await import('../sqlite.js');
    const { DatabaseSync } = createRequire(process.cwd())('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec(probeDdl('INTEGER PRIMARY KEY AUTOINCREMENT', 'TEXT'));
    const client = turbineSqlite(db, introspectSqliteDatabase(db));
    const row = await client.table('default_values_probe').create({ data: {} });
    assert.equal((row as Record<string, unknown>).label, 'unnamed');
    assert.equal((row as Record<string, unknown>).runs, 0);
    assert.ok((row as Record<string, unknown>).id);

    const one = await client.table('default_values_probe').createMany({ data: [{}] });
    assert.equal(one.length, 1);
    await client.disconnect();
  });
});

const DATABASE_URL = process.env.DATABASE_URL;
const pgGate = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

describe('create({ data: {} }) live, postgres', () => {
  pgGate.it('inserts and returns the defaulted row, single and bulk', async () => {
    const bootstrap = new pg.Pool({ connectionString: DATABASE_URL! });
    await bootstrap.query('DROP TABLE IF EXISTS default_values_probe');
    await bootstrap.query(probeDdl('BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY', 'TEXT'));
    await bootstrap.end();

    const schemaMeta = await introspect({ connectionString: DATABASE_URL! });
    const client = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 2 }, schemaMeta);
    await client.connect();
    try {
      const row = (await client.table('default_values_probe').create({ data: {} })) as Record<string, unknown>;
      assert.equal(row.label, 'unnamed');
      assert.equal(row.runs, 0);

      const bulk = (await client.table('default_values_probe').createMany({ data: [{}, {}] })) as Record<
        string,
        unknown
      >[];
      assert.equal(bulk.length, 2);
      assert.equal(bulk[0]!.label, 'unnamed');
    } finally {
      await client.disconnect();
    }
  });
});

const MYSQL_URL = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const mysqlGate = skipGate(!MYSQL_URL, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a MySQL 8 server');

describe('create({ data: {} }) live, mysql', () => {
  mysqlGate.it('inserts and re-selects the defaulted row by insert id', async () => {
    const { createPool } = await import('mysql2/promise');
    const url = new URL(MYSQL_URL);
    const dbName = url.pathname.replace(/^\//, '');
    const rawPool = createPool({
      host: url.hostname,
      port: url.port ? Number(url.port) : 3306,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: dbName,
      namedPlaceholders: true,
      timezone: 'Z',
    });
    const pool = new MysqlPool(rawPool);
    try {
      await rawPool.query('DROP TABLE IF EXISTS default_values_probe');
      // VARCHAR, not TEXT: MySQL refuses a literal DEFAULT on a TEXT column.
      await rawPool.query(probeDdl('INT AUTO_INCREMENT PRIMARY KEY', 'VARCHAR(50)'));
      const dbSchema = await introspectMysqlWith(async (sql, params) => (await pool.query(sql, params)).rows, dbName);
      const client = await turbineMysql(pool, dbSchema);
      const row = (await client.table('default_values_probe').create({ data: {} })) as Record<string, unknown>;
      assert.equal(row.label, 'unnamed');
      assert.equal(row.runs, 0);
      assert.ok(row.id);

      // MySQL's createMany is count-not-rows, so assert the rows really landed.
      await client.table('default_values_probe').createMany({ data: [{}, {}] });
      assert.equal(await client.table('default_values_probe').count(), 3);
    } finally {
      await rawPool.query('DROP TABLE IF EXISTS default_values_probe');
      await rawPool.end();
    }
  });
});

const MSSQL_URL = process.env.MSSQL_URL ?? process.env.MSSQL_TEST_URL ?? '';
const mssqlGate = skipGate(!MSSQL_URL, 'requires MSSQL_URL pointing at a SQL Server 2016+ instance');

describe('create({ data: {} }) live, mssql', () => {
  mssqlGate.it('inserts and returns the defaulted row via OUTPUT', async () => {
    // `mssql` ships no bundled types, widen the specifier so tsc treats it as
    // `any` (TS7016) without @types/mssql. Only runs on the gated path.
    const mssqlSpecifier: string = 'mssql';
    // biome-ignore lint/suspicious/noExplicitAny: dynamic mssql import only on the gated path
    const mod: any = await import(mssqlSpecifier);
    const mssql = mod.default ?? mod;
    const url = new URL(MSSQL_URL);
    const rawPool = await new mssql.ConnectionPool({
      server: url.hostname,
      port: url.port ? Number(url.port) : 1433,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.replace(/^\//, ''),
      options: { encrypt: false, trustServerCertificate: true },
    }).connect();
    const pool = new MssqlPool(rawPool, mssql.default ?? mssql);
    const drop = "IF OBJECT_ID('default_values_probe','U') IS NOT NULL DROP TABLE default_values_probe";
    try {
      await rawPool.request().batch(drop);
      await rawPool.request().batch(probeDdl('INT IDENTITY(1,1) PRIMARY KEY', 'NVARCHAR(50)'));
      const dbSchema = await introspectMssqlWith(async (sql, params) => (await pool.query(sql, params)).rows, 'dbo');
      const client = await turbineMssql(pool, dbSchema);
      const row = (await client.table('default_values_probe').create({ data: {} })) as Record<string, unknown>;
      assert.equal(row.label, 'unnamed');
      assert.equal(row.runs, 0);
      assert.ok(row.id);

      // Multi-row all-defaults is refused rather than emitting invalid T-SQL.
      await assert.rejects(
        client.table('default_values_probe').createMany({ data: [{}, {}] }),
        (e: Error) => e instanceof UnsupportedFeatureError,
      );
    } finally {
      await rawPool.request().batch(drop);
      await rawPool.close();
    }
  });
});
