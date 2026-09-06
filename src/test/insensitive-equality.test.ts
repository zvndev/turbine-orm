/**
 * turbine-orm, `mode: 'insensitive'` on the EQUALITY family.
 *
 * `mode` is a sibling key of `equals` / `not` / `in` / `notIn` on
 * `WhereOperator`, so `{ name: { equals: 'dup name', mode: 'insensitive' } }`
 * type-checks, but the builder read `mode` for the three LIKE operators only
 * and silently compiled the equality case-sensitively (`"name" = $1`, zero rows
 * where ILIKE finds 55). The case fold is `LOWER(col) = LOWER($n)`: exact,
 * portable to every engine, and evaluated by the DATABASE, because the JS
 * `toLowerCase()` disagrees with PostgreSQL's `LOWER` on `İ` and `ß`.
 *
 * Two layers:
 *  1. Build-only SQL pins (no DB).
 *  2. Live: the ORM's rows equal an `ILIKE` / `lower()` raw query on a fixture
 *     that carries `ß`, `İ` and a case-varied duplicate name.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/insensitive-equality.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { ValidationError } from '../errors.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { makeQuery, mockTable, skipGate } from './helpers.js';

function buildSchema(): SchemaMetadata {
  const tables: Record<string, TableMetadata> = {};
  tables.users = mockTable('users', [
    { name: 'id', field: 'id' },
    { name: 'name', field: 'name', pgType: 'text' },
    { name: 'email', field: 'email', pgType: 'varchar' },
    { name: 'age', field: 'age', pgType: 'int4' },
  ]);
  return { tables, enums: {} };
}

describe('mode: insensitive on the equality family (build-only)', () => {
  it('equals folds both sides with LOWER', () => {
    const q = makeQuery('users', buildSchema());
    const { sql, params } = q.buildFindMany({ where: { name: { equals: 'Dup Name', mode: 'insensitive' } } });
    assert.match(sql, /WHERE LOWER\("name"\) = LOWER\(\$1\)$/);
    assert.deepEqual(params, ['Dup Name']);
  });

  it('not folds both sides with LOWER', () => {
    const q = makeQuery('users', buildSchema());
    const { sql, params } = q.buildFindMany({ where: { name: { not: 'Dup Name', mode: 'insensitive' } } });
    assert.match(sql, /WHERE LOWER\("name"\) != LOWER\(\$1\)$/);
    assert.deepEqual(params, ['Dup Name']);
  });

  it('in / notIn fold the column and every list element inside the database', () => {
    const q = makeQuery('users', buildSchema());
    const inQ = q.buildFindMany({ where: { name: { in: ['Dup Name', 'USER 1'], mode: 'insensitive' } } });
    assert.match(inQ.sql, /WHERE LOWER\("name"\) IN \(SELECT LOWER\(v\) FROM unnest\(\$1::text\[\]\) AS v\(v\)\)$/);
    assert.deepEqual(inQ.params, [['Dup Name', 'USER 1']]);
    const notInQ = q.buildFindMany({ where: { name: { notIn: ['Dup Name'], mode: 'insensitive' } } });
    assert.match(
      notInQ.sql,
      /WHERE LOWER\("name"\) NOT IN \(SELECT LOWER\(v\) FROM unnest\(\$1::text\[\]\) AS v\(v\)\)$/,
    );
    assert.deepEqual(notInQ.params, [['Dup Name']]);
  });

  it('equals + not + contains in one operator object: every clause folds, params in operator order', () => {
    const q = makeQuery('users', buildSchema());
    const { sql, params } = q.buildFindMany({
      where: { name: { equals: 'a', not: 'b', contains: 'c', mode: 'insensitive' } },
    });
    assert.match(
      sql,
      /LOWER\("name"\) = LOWER\(\$1\) AND LOWER\("name"\) != LOWER\(\$2\) AND "name" ILIKE \$3 ESCAPE '\\'/,
    );
    assert.deepEqual(params, ['a', 'b', '%c%']);
  });

  it('null operands are untouched: equals null / not null stay IS NULL / IS NOT NULL', () => {
    const q = makeQuery('users', buildSchema());
    const { sql, params } = q.buildFindMany({ where: { name: { equals: null, mode: 'insensitive' } } });
    assert.match(sql, /WHERE "name" IS NULL$/);
    assert.deepEqual(params, []);
    const notNull = q.buildFindMany({ where: { name: { not: null, mode: 'insensitive' } } });
    assert.match(notNull.sql, /WHERE "name" IS NOT NULL$/);
  });

  it('without mode the equality family is byte-identical to before', () => {
    const q = makeQuery('users', buildSchema());
    const { sql } = q.buildFindMany({ where: { name: { equals: 'a', not: 'b', in: ['c'], notIn: ['d'] } } });
    assert.equal(
      sql,
      'SELECT "users".* FROM "users" WHERE "name" = $1 AND "name" != $2 AND "name" = ANY($3) AND "name" != ALL($4)',
    );
  });

  it('sensitive and insensitive shapes never share a cached template', () => {
    const q = makeQuery('users', buildSchema());
    const plain = q.buildFindMany({ where: { name: { in: ['a'] } } });
    const folded = q.buildFindMany({ where: { name: { in: ['a'], mode: 'insensitive' } } });
    assert.notEqual(plain.sql, folded.sql);
    // Warm hit: same shape, new values, same template, same param count.
    const again = q.buildFindMany({ where: { name: { in: ['b', 'c'], mode: 'insensitive' } } });
    assert.equal(again.sql, folded.sql);
    assert.deepEqual(again.params, [['b', 'c']]);
  });

  it('a relation sub-where and a with-clause where fold the same way against their qualifier', () => {
    const schema = buildSchema();
    schema.tables.posts = mockTable(
      'posts',
      [
        { name: 'id', field: 'id' },
        { name: 'author_id', field: 'authorId' },
        { name: 'title', field: 'title', pgType: 'text' },
      ],
      {
        author: {
          type: 'belongsTo',
          name: 'author',
          from: 'posts',
          to: 'users',
          foreignKey: 'author_id',
          referenceKey: 'id',
        },
      },
    );
    const q = makeQuery('posts', schema);
    const filtered = q.buildFindMany({ where: { author: { is: { name: { equals: 'ann', mode: 'insensitive' } } } } });
    assert.match(filtered.sql, /LOWER\("users"\."name"\) = LOWER\(\$1\)/);
    const withWhere = q.buildFindMany({ with: { author: { where: { name: { in: ['ann'], mode: 'insensitive' } } } } });
    assert.match(withWhere.sql, /LOWER\(t0\."name"\) IN \(SELECT LOWER\(v\) FROM unnest\(\$1::text\[\]\) AS v\(v\)\)/);
  });

  it('a non-string operand beside mode: insensitive is refused (E003), on build and on a warm cache alike', () => {
    const q = makeQuery('users', buildSchema());
    assert.throws(
      () => q.buildFindMany({ where: { age: { equals: 5, mode: 'insensitive' } } as never }),
      (e: unknown) => e instanceof ValidationError && /mode: 'insensitive'/.test((e as Error).message),
    );
    assert.throws(
      () => q.buildFindMany({ where: { name: { in: ['a', 5], mode: 'insensitive' } } as never }),
      (e: unknown) => e instanceof ValidationError && /mode: 'insensitive'/.test((e as Error).message),
    );
    // Warm the template with a valid call, then hit it with a bad operand: the
    // collect path must refuse too, or the cache would bind it.
    q.buildFindMany({ where: { name: { not: 'x', mode: 'insensitive' } } });
    assert.throws(
      () => q.buildFindMany({ where: { name: { not: 7, mode: 'insensitive' } } as never }),
      (e: unknown) => e instanceof ValidationError,
    );
  });

  it('a column reference beside mode: insensitive is still refused', () => {
    const q = makeQuery('users', buildSchema());
    assert.throws(
      () => q.buildFindMany({ where: { name: { equals: { col: 'email' }, mode: 'insensitive' } } as never }),
      ValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// Integration (needs DATABASE_URL)
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping insensitive-equality integration tests: DATABASE_URL not set');
}

const TABLE = 'qa78_ci_users';
const DDL = [
  `DROP TABLE IF EXISTS ${TABLE} CASCADE`,
  `CREATE TABLE ${TABLE} (id serial PRIMARY KEY, name text NOT NULL)`,
  `INSERT INTO ${TABLE} (name)
     SELECT CASE
       WHEN g % 4 = 0 THEN 'dup name'
       WHEN g % 4 = 1 THEN 'DUP NAME'
       WHEN g % 4 = 2 THEN 'Dup Name'
       ELSE 'user ' || g END
     FROM generate_series(1, 200) g`,
  `INSERT INTO ${TABLE} (name) VALUES ('straße'), ('STRASSE'), ('İstanbul'), ('istanbul'), ('ıstanbul'), ('café'), ('CAFÉ')`,
];

let pool: pg.Pool;
let db: TurbineClient;
let schema: SchemaMetadata;

const { it: liveIt, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

async function rawIds(sql: string, params: unknown[]): Promise<number[]> {
  const res = await pool.query<{ id: number }>(`SELECT id FROM ${TABLE} WHERE ${sql} ORDER BY id`, params);
  return res.rows.map((r) => r.id);
}

async function ormIds(where: Record<string, unknown>): Promise<number[]> {
  const rows = (await db.table(TABLE).findMany({ where, orderBy: { id: 'asc' } } as never)) as { id: number }[];
  return rows.map((r) => r.id);
}

describe('mode: insensitive on the equality family (live)', () => {
  before(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
    for (const sql of DDL) await pool.query(sql);
    schema = await introspect({ connectionString: DATABASE_URL! });
    db = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 4, warnOnUnlimited: false }, schema);
    await db.connect();
  });

  after(async () => {
    if (db) await db.disconnect();
    if (pool) {
      await pool.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await pool.end();
    }
  });

  liveIt('equals matches every case variant, like ILIKE without metacharacters', async () => {
    const expected = await rawIds('name ILIKE $1', ['dup name']);
    assert.equal(expected.length, 150, 'fixture: three of every four rows are a case variant');
    assert.deepEqual(await ormIds({ name: { equals: 'dup name', mode: 'insensitive' } }), expected);
    assert.deepEqual(await ormIds({ name: { equals: 'DUP NAME', mode: 'insensitive' } }), expected);
    // Without the mode the same operand matches one spelling only.
    assert.deepEqual(await ormIds({ name: { equals: 'dup name' } }), await rawIds('name = $1', ['dup name']));
  });

  liveIt('in matches the union of the case-folded list', async () => {
    const expected = await rawIds('lower(name) IN (lower($1), lower($2))', ['dup name', 'USER 7']);
    assert.equal(expected.length, 151);
    assert.deepEqual(await ormIds({ name: { in: ['dup name', 'USER 7'], mode: 'insensitive' } }), expected);
  });

  liveIt('not / notIn exclude every case variant', async () => {
    const notExpected = await rawIds('NOT (name ILIKE $1)', ['dup name']);
    assert.deepEqual(await ormIds({ name: { not: 'dup name', mode: 'insensitive' } }), notExpected);
    const notInExpected = await rawIds('lower(name) NOT IN (lower($1), lower($2))', ['DUP NAME', 'café']);
    assert.deepEqual(await ormIds({ name: { notIn: ['DUP NAME', 'café'], mode: 'insensitive' } }), notInExpected);
  });

  liveIt('the fold is the database fold: ß and dotted İ behave exactly as ILIKE does', async () => {
    for (const operand of ['STRASSE', 'straße', 'İstanbul', 'istanbul', 'ıstanbul', 'CAFÉ']) {
      const expected = await rawIds('name ILIKE $1', [operand]);
      assert.deepEqual(await ormIds({ name: { equals: operand, mode: 'insensitive' } }), expected, `equals ${operand}`);
      assert.deepEqual(
        await ormIds({ name: { in: [operand], mode: 'insensitive' } }),
        await rawIds('lower(name) = lower($1)', [operand]),
        `in [${operand}]`,
      );
    }
  });
});
