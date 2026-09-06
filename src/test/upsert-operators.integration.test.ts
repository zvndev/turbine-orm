/**
 * turbine-orm: `upsert`'s conflict-UPDATE branch, two properties.
 *
 * 1. OPERATORS. `update: { n: { increment: 1 } }` compiles through the same
 *    operator-aware SET compiler `update()` uses (`buildSetClause`), so `set` /
 *    `increment` / `decrement` / `multiply` / `divide` mean what they mean in
 *    `update()`, and a misspelled operator is refused with the same E003. The
 *    branch used to bind the operator OBJECT as the value, which stored the JSON
 *    text `{"set":"x"}` in a text column with no error. In `ON CONFLICT ... DO
 *    UPDATE SET`, both the target table and `excluded` are in scope, so the
 *    right-hand column reference an arithmetic operator needs is qualified
 *    with the table name (an unqualified one is 42702 on PostgreSQL).
 *
 * 2. GLOBAL FILTERS. The configured filter restricts the conflict-UPDATE
 *    (`... DO UPDATE SET ... WHERE <filter>`), and that predicate is compiled
 *    with the table qualifier for the same two-tables-in-scope reason. It used
 *    to be unqualified, so EVERY upsert on a globally filtered table failed at
 *    parse time with 42702, insert path and conflict path alike.
 *
 *    Documented semantics for a conflict against a row the filter hides: the
 *    predicate is false for that row, PostgreSQL skips the update and inserts
 *    nothing (the key is taken), the statement returns no row, and Turbine
 *    reports NotFoundError (E001) naming the filter. The hidden row is left
 *    exactly as it was.
 *
 * Every stored value is read back AS TEXT through a raw pg client, never
 * through the ORM's own row parser.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/upsert-operators.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it as plainIt } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { type Dialect, postgresDialect } from '../dialect.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { introspect } from '../introspect.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import { UNSAFE } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { sqliteDialect } from '../sqlite.js';
import { makeQuery, mockTable, skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping upsert operator integration tests: DATABASE_URL not set');
}

const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

const DDL = `
DROP TABLE IF EXISTS qa78_ups CASCADE;
DROP TABLE IF EXISTS qa78_tags CASCADE;
CREATE TABLE qa78_ups (
  id    INTEGER PRIMARY KEY,
  slug  TEXT NOT NULL UNIQUE,
  name  TEXT,
  n     INTEGER NOT NULL DEFAULT 0,
  big   BIGINT NOT NULL DEFAULT 0,
  price NUMERIC(12,2) NOT NULL DEFAULT 0
);
CREATE TABLE qa78_tags (
  id   SERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);
INSERT INTO qa78_tags (slug, name) VALUES ('shown', 'visible'), ('secret', 'hidden');
`;

describe('upsert: operators in the conflict-UPDATE branch (live Postgres)', () => {
  let raw: pg.Client;
  let db: TurbineClient;
  let schema: SchemaMetadata;

  const stored = async (id: number): Promise<Record<string, string | null>> => {
    const r = await raw.query(
      'SELECT name, n::text AS n, big::text AS big, price::text AS price FROM qa78_ups WHERE id = $1',
      [id],
    );
    return r.rows[0];
  };

  before(async () => {
    raw = new pg.Client({ connectionString: DATABASE_URL });
    await raw.connect();
    await raw.query(DDL);
    schema = await introspect({ connectionString: DATABASE_URL as string });
    db = new TurbineClient({ connectionString: DATABASE_URL as string, warnOnUnlimited: false }, schema);
  });

  after(async () => {
    await db?.disconnect();
    await raw?.query('DROP TABLE IF EXISTS qa78_ups CASCADE; DROP TABLE IF EXISTS qa78_tags CASCADE;');
    await raw?.end();
  });

  it('insert path: no conflict, the create branch is stored verbatim', async () => {
    const row = await db.table('qa78_ups').upsert({
      where: { id: 1 },
      create: { id: 1, slug: 'one', name: 'created', n: 5, big: '9007199254740993', price: 10 },
      update: { name: { set: 'never' } } as never,
    });
    assert.equal(row.name, 'created');
    assert.deepEqual(await stored(1), { name: 'created', n: '5', big: '9007199254740993', price: '10.00' });
  });

  it('conflict path: { set } stores the VALUE, not the operator object', async () => {
    await db.table('qa78_ups').upsert({
      where: { id: 1 },
      create: { id: 1, slug: 'one', name: 'never' },
      update: { name: { set: 'Upserted' } } as never,
    });
    assert.equal((await stored(1)).name, 'Upserted');
  });

  it('conflict path: increment / decrement on int, bigint and numeric columns are exact', async () => {
    await db.table('qa78_ups').upsert({
      where: { id: 1 },
      create: { id: 1, slug: 'one' },
      update: { n: { increment: 3 }, big: { increment: 1 }, price: { decrement: 0.5 } } as never,
    });
    assert.deepEqual(await stored(1), { name: 'Upserted', n: '8', big: '9007199254740994', price: '9.50' });
  });

  it('conflict path: multiply / divide on a numeric column', async () => {
    await db.table('qa78_ups').upsert({
      where: { id: 1 },
      create: { id: 1, slug: 'one' },
      update: { price: { multiply: 3 } } as never,
    });
    assert.equal((await stored(1)).price, '28.50');
    await db.table('qa78_ups').upsert({
      where: { id: 1 },
      create: { id: 1, slug: 'one' },
      update: { price: { divide: 3 } } as never,
    });
    assert.equal((await stored(1)).price, '9.50');
  });

  it('conflict path: an operator and a literal in one statement', async () => {
    const row = await db.table('qa78_ups').upsert({
      where: { slug: 'one' },
      create: { id: 1, slug: 'one' },
      update: { name: 'literal', n: { decrement: 8 } } as never,
    });
    assert.equal(row.name, 'literal');
    assert.equal(row.n, 0);
    assert.deepEqual(await stored(1), { name: 'literal', n: '0', big: '9007199254740994', price: '9.50' });
  });

  it('a misspelled operator on a scalar column is refused with E003 (the update() message), nothing written', async () => {
    await assert.rejects(
      db.table('qa78_ups').upsert({
        where: { id: 1 },
        create: { id: 1, slug: 'one' },
        update: { n: { incremnt: 1 } } as never,
      }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
        assert.match(err.message, /Unknown update operator "incremnt"/);
        return true;
      },
    );
    assert.equal((await stored(1)).n, '0');
  });

  it('a non-finite arithmetic operand is refused the way update() refuses it', async () => {
    await assert.rejects(
      db.table('qa78_ups').upsert({
        where: { id: 1 },
        create: { id: 1, slug: 'one' },
        update: { n: { increment: Number.NaN } } as never,
      }),
      /requires a finite number/,
    );
  });
});

describe('upsert under a global filter (live Postgres)', () => {
  let raw: pg.Client;
  let db: TurbineClient;

  const tag = async (slug: string): Promise<{ name: string } | undefined> =>
    (await raw.query('SELECT name FROM qa78_tags WHERE slug = $1', [slug])).rows[0];

  before(async () => {
    raw = new pg.Client({ connectionString: DATABASE_URL });
    await raw.connect();
    // The tables are created by the first describe's `before`; this one only
    // needs a client carrying the filter. Introspect again so the order the two
    // suites run in does not matter.
    await raw.query(DDL);
    const schema = await introspect({ connectionString: DATABASE_URL as string });
    db = new TurbineClient(
      {
        connectionString: DATABASE_URL as string,
        warnOnUnlimited: false,
        globalFilters: { qa78_tags: { name: { not: 'hidden' } } },
      },
      schema,
    );
  });

  after(async () => {
    await db?.disconnect();
    await raw?.query('DROP TABLE IF EXISTS qa78_ups CASCADE; DROP TABLE IF EXISTS qa78_tags CASCADE;');
    await raw?.end();
  });

  it('insert path succeeds (the filter never applies to an insert)', async () => {
    const row = await db.table('qa78_tags').upsert({
      where: { slug: 'fresh' },
      create: { slug: 'fresh', name: 'brand-new' },
      update: { name: 'updated' },
    });
    assert.equal(row.name, 'brand-new');
    assert.deepEqual(await tag('fresh'), { name: 'brand-new' });
  });

  it('conflict path against a VISIBLE row updates it', async () => {
    const row = await db.table('qa78_tags').upsert({
      where: { slug: 'shown' },
      create: { slug: 'shown', name: 'never' },
      update: { name: 'renamed' },
    });
    assert.equal(row.name, 'renamed');
    assert.deepEqual(await tag('shown'), { name: 'renamed' });
  });

  it('conflict path against a row the filter HIDES: nothing inserted, nothing updated, E001 names the filter', async () => {
    // Semantics: the conflict-UPDATE predicate is false for the hidden row, so
    // PostgreSQL skips the update; the unique key is taken, so nothing is
    // inserted either; the statement returns no row. The row stays as it was.
    await assert.rejects(
      db.table('qa78_tags').upsert({
        where: { slug: 'secret' },
        create: { slug: 'secret', name: 'resurrected' },
        update: { name: 'resurrected' },
      }),
      (err: unknown) => {
        assert.ok(err instanceof NotFoundError, `expected NotFoundError, got ${String(err)}`);
        assert.match(err.message, /global filter/);
        return true;
      },
    );
    assert.deepEqual(await tag('secret'), { name: 'hidden' });
    // The two seeded rows plus 'fresh' from the insert-path test: nothing else.
    assert.equal(Number((await raw.query('SELECT count(*)::int AS n FROM qa78_tags')).rows[0].n), 3);
  });

  it('skipGlobalFilters lifts the predicate and the hidden row is updated', async () => {
    const row = await db.table('qa78_tags').upsert({
      where: { slug: 'secret' },
      create: { slug: 'secret', name: 'x' },
      update: { name: 'unhidden' },
      skipGlobalFilters: UNSAFE,
    });
    assert.equal(row.name, 'unhidden');
  });
});

// ---------------------------------------------------------------------------
// Build-only SQL pins (no database)
// ---------------------------------------------------------------------------

function buildSchema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      qa78_ups: mockTable('qa78_ups', [
        { name: 'id', field: 'id', pgType: 'int4' },
        { name: 'name', field: 'name', pgType: 'text' },
        { name: 'n', field: 'n', pgType: 'int4' },
        { name: 'meta', field: 'meta', pgType: 'jsonb' },
      ]),
    },
  };
}

describe('upsert: build-only SQL pins', () => {
  plainIt('operators compile as in update(), with the arithmetic reference table-qualified', () => {
    const { sql, params } = makeQuery('qa78_ups', buildSchema()).buildUpsert({
      where: { id: 1 },
      create: { id: 1, name: 'c' },
      update: { name: { set: 'u' }, n: { increment: 2 } } as never,
    });
    assert.equal(
      sql,
      'INSERT INTO "qa78_ups" ("id", "name") VALUES ($1, $2) ON CONFLICT ("id") DO UPDATE SET ' +
        '"name" = $3, "n" = "qa78_ups"."n" + $4 RETURNING *',
    );
    assert.deepEqual(params, [1, 'c', 'u', 2]);
  });

  plainIt('a plain object is still a value on a json column, and byte-identical to before', () => {
    const { sql, params } = makeQuery('qa78_ups', buildSchema()).buildUpsert({
      where: { id: 1 },
      create: { id: 1 },
      update: { meta: { theme: 'dark' } } as never,
    });
    assert.equal(
      sql,
      'INSERT INTO "qa78_ups" ("id") VALUES ($1) ON CONFLICT ("id") DO UPDATE SET "meta" = $2 RETURNING *',
    );
    assert.deepEqual(params, [1, { theme: 'dark' }]);
  });

  plainIt('a misspelled operator on a scalar column is refused at build time', () => {
    assert.throws(
      () =>
        makeQuery('qa78_ups', buildSchema()).buildUpsert({
          where: { id: 1 },
          create: { id: 1 },
          update: { n: { incremnt: 1 } } as never,
        }),
      /Unknown update operator "incremnt"/,
    );
  });

  plainIt('every engine routes the conflict-UPDATE through the operator compiler', () => {
    // The operator reaches the SQL on all four, which is the property that was
    // missing (the branch bound the operator object as a value everywhere).
    // Only the column REFERENCE differs: SQL Server's MERGE aliases its target,
    // so the table name cannot qualify it there (see upsertReferenceQualifier).
    const build = (dialect: Dialect) =>
      makeQuery('qa78_ups', buildSchema(), { dialect }).buildUpsert({
        where: { id: 1 },
        create: { id: 1, n: 0 },
        update: { n: { increment: 2 } },
      });

    for (const [name, dialect, expected] of [
      ['postgres', postgresDialect, '"qa78_ups"."n" + $3'],
      ['sqlite', sqliteDialect, '"qa78_ups"."n" + :p3'],
      ['mysql', mysqlDialect, '`qa78_ups`.`n` + :p3'],
      ['mssql', mssqlDialect, '[n] + @p3'],
    ] as const) {
      const { sql, params } = build(dialect);
      assert.ok(sql.includes(expected), `${name}: expected ${expected} in ${sql}`);
      assert.deepEqual(params, [1, 0, 2], `${name}: the operand is bound, never inlined`);
    }
  });

  plainIt('the global-filter predicate on the conflict-UPDATE is table-qualified', () => {
    const { sql, params } = makeQuery('qa78_ups', buildSchema(), {
      globalFilters: { qa78_ups: { name: { not: 'hidden' } } },
    }).buildUpsert({
      where: { id: 1 },
      create: { id: 1, name: 'c' },
      update: { name: 'u' } as never,
    });
    assert.equal(
      sql,
      'INSERT INTO "qa78_ups" ("id", "name") VALUES ($1, $2) ON CONFLICT ("id") DO UPDATE SET "name" = $3 ' +
        'WHERE "qa78_ups"."name" != $4 RETURNING *',
    );
    assert.deepEqual(params, [1, 'c', 'u', 'hidden']);
  });
});
