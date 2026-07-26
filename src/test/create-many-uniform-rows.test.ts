/**
 * turbine-orm: `createMany` refuses rows that do not name the same fields.
 *
 * `createMany` compiles ONE statement and takes its column list from the FIRST
 * row alone, so a row that disagrees with the first row loses data silently, in
 * both directions:
 *
 *   createMany({ data: [{ n: 5 }, {}] })              -> row 2 gets n = NULL,
 *                                                        overwriting `n int default 7`
 *   createMany({ data: [{ n: 5 }, { n: undefined }] }) -> same, and single-row
 *                                                        `create({ data: { n: undefined } })`
 *                                                        takes the default, so two
 *                                                        calls a reader treats as
 *                                                        equivalent behave differently
 *   createMany({ data: [{ n: 1 }, { label: 'x' }] })   -> `label` never reaches the
 *                                                        database at all
 *
 * The other direction (first row names nothing, a later row does) was already
 * refused; the guard now covers every shape, which is what its own message
 * ("every row must supply the same fields") always claimed.
 *
 * Making the heterogeneous shapes WORK was considered and rejected: a per-cell
 * `DEFAULT` keyword needs the row-major `VALUES` form, which SQLite has no
 * grammar for (`VALUES (1, DEFAULT)` is a parse error there) and which would
 * also drop PostgreSQL off the column-major `UNNEST` binding. See
 * `assertUniformCreateManyRows` in query/writes.ts.
 *
 * Tier 1 is build-only (no DB); tier 2 runs the same shapes against live
 * engines: SQLite in-process via `node:sqlite`, plus Postgres / MySQL / SQL
 * Server gated on DATABASE_URL / MYSQL_URL / MSSQL_URL.
 *
 * Run: npx tsx --test src/test/create-many-uniform-rows.test.ts
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it as nodeIt } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import type { Dialect } from '../dialect.js';
import { postgresDialect } from '../dialect.js';
import { ValidationError } from '../errors.js';
import { introspect } from '../introspect.js';
import { mssqlDialect } from '../mssql.js';
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
      default_probe: mockTable('default_probe', [
        { name: 'id', field: 'id' },
        { name: 'label', field: 'label', pgType: 'text' },
        { name: 'n', field: 'n', pgType: 'int4' },
      ]),
    },
  };
}

function q(dialect: Dialect = postgresDialect) {
  return makeQuery('default_probe', schema(), { dialect });
}

/** Every dialect shares the guard: it runs before any SQL is generated. */
const dialects = [
  ['postgres', postgresDialect],
  ['sqlite', sqliteDialect],
  ['mysql', mysqlDialect],
  ['mssql', mssqlDialect],
] as const;

describe('createMany refuses rows that name different fields', () => {
  nodeIt('a later row that OMITS a first-row field is refused (NULL over the default)', () => {
    assert.throws(
      () => q().buildCreateMany({ data: [{ n: 5 }, {}] as never }),
      (e: Error) =>
        e instanceof ValidationError &&
        /row 1 does not supply "n"/.test(e.message) &&
        /createMany on "default_probe"/.test(e.message),
    );
  });

  nodeIt('an explicit `undefined` counts as omitted, exactly as in `create`', () => {
    // `create({ data: { n: undefined } })` filters the key out and lets the
    // column default apply, so the bulk path must not bind it as NULL either.
    assert.equal(q().buildCreate({ data: { label: 'a', n: undefined } as never }).params.length, 1);
    assert.throws(
      () => q().buildCreateMany({ data: [{ n: 5 }, { n: undefined }] as never }),
      (e: Error) => e instanceof ValidationError && /row 1 does not supply "n"/.test(e.message),
    );
  });

  nodeIt('a later row that ADDS a field is refused (the value would be dropped)', () => {
    assert.throws(
      () => q().buildCreateMany({ data: [{ n: 5 }, { n: 6, label: 'x' }] as never }),
      (e: Error) =>
        e instanceof ValidationError && /row 1 supplies "label", which the first row does not/.test(e.message),
    );
  });

  nodeIt('a disjoint row reports both directions', () => {
    assert.throws(
      () => q().buildCreateMany({ data: [{ n: 1 }, { label: 'x' }] as never }),
      (e: Error) =>
        e instanceof ValidationError &&
        /does not supply "n"/.test(e.message) &&
        /supplies "label", which the first row does not/.test(e.message),
    );
  });

  nodeIt('the reported index is the offending row, not the first mismatch scanned', () => {
    assert.throws(
      () => q().buildCreateMany({ data: [{ n: 1 }, { n: 2 }, { n: 3 }, {}] as never }),
      (e: Error) => e instanceof ValidationError && /row 3 does not supply "n"/.test(e.message),
    );
  });

  nodeIt('the first row naming no column while a later row does is still refused', () => {
    assert.throws(
      () => q().buildCreateMany({ data: [{}, { n: 5 }] as never }),
      (e: Error) => e instanceof ValidationError && /row 1 supplies "n"/.test(e.message),
    );
  });

  nodeIt('the message tells the user both fixes', () => {
    let message = '';
    try {
      q().buildCreateMany({ data: [{ n: 5 }, {}] as never });
    } catch (e) {
      message = (e as Error).message;
    }
    assert.match(message, /Supply the field explicitly on every row/);
    assert.match(message, /split the call into one createMany per row shape/);
    // The `undefined` equivalence is the whole point of the finding, so the
    // message has to say it rather than leaving the reader to discover it.
    assert.match(message, /`undefined` counts as omitted/);
  });

  for (const [name, dialect] of dialects) {
    nodeIt(`${name} refuses the same shapes (the guard precedes SQL generation)`, () => {
      assert.throws(
        () => q(dialect).buildCreateMany({ data: [{ n: 5 }, {}] as never }),
        (e: Error) => e instanceof ValidationError,
      );
      assert.throws(
        () => q(dialect).buildCreateMany({ data: [{}, { n: 5 }] as never }),
        (e: Error) => e instanceof ValidationError,
      );
    });
  }
});

describe('uniform createMany is untouched', () => {
  nodeIt('postgres still emits the column-major UNNEST form', () => {
    const d = q().buildCreateMany({ data: [{ n: 1 }, { n: 2 }] as never });
    assert.equal(d.sql, 'INSERT INTO "default_probe" ("n") SELECT * FROM UNNEST($1::integer[]) RETURNING *');
    assert.deepEqual(d.params, [[1, 2]]);
  });

  nodeIt('key ORDER may differ between rows, only the set matters', () => {
    const d = q().buildCreateMany({
      data: [
        { n: 1, label: 'a' },
        { label: 'b', n: 2 },
      ] as never,
    });
    assert.equal(
      d.sql,
      'INSERT INTO "default_probe" ("n", "label") SELECT * FROM UNNEST($1::integer[], $2::text[]) RETURNING *',
    );
    assert.deepEqual(d.params, [
      [1, 2],
      ['a', 'b'],
    ]);
  });

  nodeIt('a uniformly `undefined` field is uniform (all rows take the default)', () => {
    const d = q().buildCreateMany({ data: [{ n: 1, label: undefined }, { n: 2 }] as never });
    assert.equal(d.sql, 'INSERT INTO "default_probe" ("n") SELECT * FROM UNNEST($1::integer[]) RETURNING *');
  });

  nodeIt('rows that are all empty still take the all-defaults INSERT', () => {
    assert.equal(
      q().buildCreateMany({ data: [{}, {}] as never }).sql,
      'INSERT INTO "default_probe" SELECT FROM generate_series(1, 2) RETURNING *',
    );
    assert.equal(
      q().buildCreateMany({ data: [{ n: undefined }, {}] as never }).sql,
      'INSERT INTO "default_probe" SELECT FROM generate_series(1, 2) RETURNING *',
    );
  });

  nodeIt('an empty data array is still the zero-row short circuit', () => {
    assert.equal(q().buildCreateMany({ data: [] }).sql, 'SELECT * FROM "default_probe" WHERE false');
  });
});

// ---------------------------------------------------------------------------
// Tier 2, live engines
// ---------------------------------------------------------------------------

/** Every column defaults, so an omitted field is data loss rather than an error. */
const probeDdl = (autoPk: string, textType: string) =>
  `CREATE TABLE createmany_uniform_probe (id ${autoPk}, label ${textType} DEFAULT 'unnamed', n INT DEFAULT 7)`;

/**
 * The live assertions, shared by every engine: the two reverse shapes are
 * refused with E003 and write NOTHING, and the uniform call still lands rows
 * whose omitted column carries its default.
 */
async function assertLiveBehavior(table: {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  createMany(args: { data: Record<string, unknown>[] }): Promise<unknown>;
  count(): Promise<number>;
  findMany(args?: Record<string, unknown>): Promise<unknown[]>;
}) {
  await assert.rejects(
    table.createMany({ data: [{ n: 5 }, {}] }),
    (e: Error) => e instanceof ValidationError && /row 1 does not supply "n"/.test(e.message),
  );
  await assert.rejects(
    table.createMany({ data: [{ n: 5 }, { n: undefined }] }),
    (e: Error) => e instanceof ValidationError && /row 1 does not supply "n"/.test(e.message),
  );
  await assert.rejects(table.createMany({ data: [{}, { n: 5 }] }), (e: Error) => e instanceof ValidationError);
  // A refused call must not have written a partial batch.
  assert.equal(await table.count(), 0);

  // Single-row create: the omitted column takes its default. This is the
  // behavior the bulk path is now consistent with.
  const one = (await table.create({ data: { n: undefined } })) as Record<string, unknown>;
  assert.equal(Number(one.n), 7);

  await table.createMany({ data: [{ n: 5 }, { n: 6 }] });
  assert.equal(await table.count(), 3);
}

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

describe('createMany uniformity live, sqlite', () => {
  sqliteGate.it('refuses both reverse shapes and writes nothing', async () => {
    const { introspectSqliteDatabase } = await import('../sqlite.js');
    const { DatabaseSync } = createRequire(process.cwd())('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec(probeDdl('INTEGER PRIMARY KEY AUTOINCREMENT', 'TEXT'));
    const client = turbineSqlite(db, introspectSqliteDatabase(db));
    try {
      await assertLiveBehavior(client.table('createmany_uniform_probe') as never);
    } finally {
      await client.disconnect();
    }
  });
});

const DATABASE_URL = process.env.DATABASE_URL;
const pgGate = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

describe('createMany uniformity live, postgres', () => {
  pgGate.it('refuses both reverse shapes and writes nothing', async () => {
    const bootstrap = new pg.Pool({ connectionString: DATABASE_URL! });
    await bootstrap.query('DROP TABLE IF EXISTS createmany_uniform_probe');
    await bootstrap.query(probeDdl('BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY', 'TEXT'));
    await bootstrap.end();

    const schemaMeta = await introspect({ connectionString: DATABASE_URL! });
    const client = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 2 }, schemaMeta);
    await client.connect();
    try {
      await assertLiveBehavior(client.table('createmany_uniform_probe') as never);
    } finally {
      await client.disconnect();
      const cleanup = new pg.Pool({ connectionString: DATABASE_URL! });
      await cleanup.query('DROP TABLE IF EXISTS createmany_uniform_probe');
      await cleanup.end();
    }
  });
});

const MYSQL_URL = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const mysqlGate = skipGate(!MYSQL_URL, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a MySQL 8 server');

describe('createMany uniformity live, mysql', () => {
  mysqlGate.it('refuses both reverse shapes and writes nothing', async () => {
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
      await rawPool.query('DROP TABLE IF EXISTS createmany_uniform_probe');
      // VARCHAR, not TEXT: MySQL refuses a literal DEFAULT on a TEXT column.
      await rawPool.query(probeDdl('INT AUTO_INCREMENT PRIMARY KEY', 'VARCHAR(50)'));
      const dbSchema = await introspectMysqlWith(async (sql, params) => (await pool.query(sql, params)).rows, dbName);
      const client = await turbineMysql(pool, dbSchema);
      await assertLiveBehavior(client.table('createmany_uniform_probe') as never);
    } finally {
      await rawPool.query('DROP TABLE IF EXISTS createmany_uniform_probe');
      await rawPool.end();
    }
  });
});
