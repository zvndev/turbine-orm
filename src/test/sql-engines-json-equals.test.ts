/**
 * Whole-document JSON `equals` (no `path`) is equality, not containment.
 *
 * `{ doc: { equals: { a: 1 } } }` compiled to `doc @> '{"a":1}'`, which also
 * matched every document that merely CONTAINS `a: 1`, so `deleteMany` with it
 * deleted a superset. `not: { equals: X }` is its negation, and a plain
 * `not: X` on a JSON column means the same where the engine compares
 * documents exactly.
 *
 * Live on PostgreSQL (DATABASE_URL) and MySQL (MYSQL_URL); SQL Server and
 * SQLite refusals are build-only.
 *
 * Run: DATABASE_URL=... MYSQL_URL=... npx tsx --test src/test/sql-engines-json-equals.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TurbineClient } from '../client.js';
import { UnsupportedFeatureError } from '../errors.js';
import { mssqlDialect } from '../mssql.js';
import { turbineMysql } from '../mysql.js';
import type { SchemaMetadata } from '../schema.js';
import { sqliteDialect } from '../sqlite.js';
import { makeQuery, mockTable, skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const MYSQL_URL = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const pg = skipGate(!DATABASE_URL, 'requires DATABASE_URL');
const my = skipGate(!MYSQL_URL, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a MySQL 8 server');

const TABLE = 'sqle_json_docs';

/** Each document, and the ids a whole-document `equals` with it must return. */
const DOCS: [number, unknown][] = [
  [1, { a: 1 }],
  [2, { a: 1, b: 2 }],
  [3, { b: 2, a: 1 }],
  [4, [1, 2]],
  [5, [1]],
  [6, 's'],
  [7, null],
  [8, { a: { x: 1 } }],
  [9, {}],
  [10, 5],
];
// Row 11 is SQL NULL.

function schemaFor(jsonType: string): SchemaMetadata {
  return {
    tables: {
      [TABLE]: mockTable(TABLE, [
        { name: 'id', field: 'id', pgType: 'int4' },
        { name: 'doc', field: 'doc', pgType: jsonType },
      ]),
    },
    enums: {},
  };
}

type Db = { table(name: string): { findMany(a: unknown): Promise<unknown>; deleteMany(a: unknown): Promise<unknown> } };

async function ids(db: Db, where: Record<string, unknown>): Promise<number[]> {
  const rows = (await db.table(TABLE).findMany({ where, orderBy: { id: 'asc' } })) as { id: number }[];
  return rows.map((r) => r.id);
}

/** The shared expectations, run against one engine and column type. */
async function assertEquality(db: Db, label: string): Promise<void> {
  // Containment would also return 2 and 3 for the first, and 4 for the second.
  assert.deepEqual(await ids(db, { doc: { equals: { a: 1 } } }), [1], `${label}: object`);
  assert.deepEqual(await ids(db, { doc: { equals: { b: 2, a: 1 } } }), [2, 3], `${label}: key order is irrelevant`);
  assert.deepEqual(await ids(db, { doc: { equals: [1] } }), [5], `${label}: array`);
  assert.deepEqual(await ids(db, { doc: { equals: 's' } }), [6], `${label}: string document`);
  assert.deepEqual(await ids(db, { doc: { equals: 5 } }), [10], `${label}: number document`);
  assert.deepEqual(await ids(db, { doc: { equals: null } }), [7], `${label}: JSON null, not SQL NULL`);
  assert.deepEqual(await ids(db, { doc: { equals: {} } }), [9], `${label}: empty object`);
  // The negation, both spellings. SQL NULL is excluded, as for any `not`.
  const notA1 = [2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.deepEqual(await ids(db, { doc: { not: { equals: { a: 1 } } } }), notA1, `${label}: not { equals }`);
  assert.deepEqual(await ids(db, { doc: { not: { a: 1 } } }), notA1, `${label}: not <document>`);
  assert.deepEqual(await ids(db, { doc: { not: [1] } }), [1, 2, 3, 4, 6, 7, 8, 9, 10], `${label}: not <array>`);
  // A warm template binds by its own value.
  assert.deepEqual(await ids(db, { doc: { equals: [1, 2] } }), [4], `${label}: warm`);
  // deleteMany removes exactly the equal document.
  await db.table(TABLE).deleteMany({ where: { doc: { equals: { a: 1 } } } });
  assert.deepEqual(await ids(db, {}), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11], `${label}: deleteMany`);
}

describe('whole-document JSON equals on PostgreSQL', () => {
  for (const jsonType of ['jsonb', 'json']) {
    pg.it(`${jsonType} column`, async () => {
      const db = new TurbineClient({ connectionString: DATABASE_URL, warnOnUnlimited: false }, schemaFor(jsonType));
      const run = (sql: string, params: unknown[] = []) => db.pool.query(sql, params);
      try {
        await run(`DROP TABLE IF EXISTS ${TABLE}`);
        await run(`CREATE TABLE ${TABLE} (id int PRIMARY KEY, doc ${jsonType})`);
        for (const [id, doc] of DOCS)
          await run(`INSERT INTO ${TABLE} VALUES ($1, $2::${jsonType})`, [id, JSON.stringify(doc)]);
        await run(`INSERT INTO ${TABLE} VALUES (11, NULL)`);
        await assertEquality(db as unknown as Db, jsonType);
      } finally {
        await run(`DROP TABLE IF EXISTS ${TABLE}`);
        await db.disconnect();
      }
    });
  }
});

describe('whole-document JSON equals on MySQL', () => {
  my.it('JSON column', async () => {
    const db = await turbineMysql(MYSQL_URL, schemaFor('json'), { warnOnUnlimited: false });
    const pool = (db as unknown as { pool: { query(sql: string, params?: unknown[]): Promise<unknown> } }).pool;
    try {
      await pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
      await pool.query(`CREATE TABLE ${TABLE} (id INT PRIMARY KEY, doc JSON)`);
      for (const [id, doc] of DOCS) {
        await pool.query(`INSERT INTO ${TABLE} VALUES (:p1, CAST(:p2 AS JSON))`, [id, JSON.stringify(doc)]);
      }
      await pool.query(`INSERT INTO ${TABLE} VALUES (11, NULL)`);
      await assertEquality(db as unknown as Db, 'mysql');
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
      await db.disconnect();
    }
  });
});

describe('whole-document JSON equals, build-only', () => {
  it('PostgreSQL compiles equality, never containment, with one SQL text for every operand', () => {
    const q = makeQuery(TABLE, schemaFor('jsonb'));
    const a = q.buildFindMany({ where: { doc: { equals: { a: 1 } } } } as never);
    const b = q.buildFindMany({ where: { doc: { equals: [1] } } } as never);
    assert.match(a.sql, /"doc"::jsonb = \$1::jsonb/);
    assert.doesNotMatch(a.sql, /@>/);
    assert.equal(a.sql, b.sql);
    assert.deepEqual([a.params[0], b.params[0]], ['{"a":1}', '[1]']);
    const n = q.buildFindMany({ where: { doc: { not: { equals: { a: 1 } } } } } as never);
    assert.match(n.sql, /NOT \("doc"::jsonb = \$1::jsonb\)/);
  });

  it('SQL Server and SQLite refuse it (E017) rather than approximate it', () => {
    for (const dialect of [mssqlDialect, sqliteDialect]) {
      const q = makeQuery(TABLE, schemaFor('json'), { dialect });
      for (const where of [{ doc: { equals: { a: 1 } } }, { doc: { not: { equals: { a: 1 } } } }]) {
        assert.throws(() => q.buildFindMany({ where } as never), UnsupportedFeatureError, dialect.name);
      }
      // A plain `not: <document>` and a bare document are the same document
      // comparison, so they are refused too: compared as text, key order
      // decided the match.
      for (const where of [{ doc: { not: { a: 1 } } }, { doc: { a: 1 } }, { doc: { not: [1] } }]) {
        assert.throws(() => q.buildFindMany({ where } as never), UnsupportedFeatureError, dialect.name);
      }
      // A scalar keeps its bound-value comparison.
      const plain = q.buildFindMany({ where: { doc: { not: 5 } } } as never);
      assert.match(plain.sql, /!= (?:@p1|:p1)/, dialect.name);
      assert.deepEqual(plain.params, [5], dialect.name);
    }
  });
});
