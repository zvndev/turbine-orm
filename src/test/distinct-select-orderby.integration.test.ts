/**
 * turbine-orm, `distinct` + a narrowed projection + `orderBy` on a column the
 * projection leaves out.
 *
 * `distinct` with an `orderBy` compiles two levels: an inner `DISTINCT ON`
 * ordered by the distinct columns then the user's order (which picks the
 * representative row), and an outer re-order by the user's order alone. The
 * outer ORDER BY named columns the inner `select` never projected, so the
 * statement failed with 42703 (`column "published" does not exist`), and the
 * same happened with NO user `select` when the projection was narrowed by the
 * PII rule. The fix projects every such order column into the inner derived
 * table under its own name and lists the projected columns explicitly in the
 * outer SELECT, so the extra column orders the result and never reaches a row.
 *
 * Two layers: build-only SQL pins, then live row sets against raw `DISTINCT ON`.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/distinct-select-orderby.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { makeQuery, mockTable, skipGate } from './helpers.js';

function buildSchema(): SchemaMetadata {
  const tables: Record<string, TableMetadata> = {};
  tables.posts = mockTable(
    'posts',
    [
      { name: 'id', field: 'id' },
      { name: 'author_id', field: 'authorId' },
      { name: 'published', field: 'published', pgType: 'bool' },
      { name: 'view_count', field: 'viewCount', pgType: 'int4' },
      { name: 'email', field: 'email', pgType: 'text', pii: true },
    ],
    {
      comments: {
        type: 'hasMany',
        name: 'comments',
        from: 'posts',
        to: 'comments',
        foreignKey: 'post_id',
        referenceKey: 'id',
      },
    },
  );
  tables.comments = mockTable('comments', [
    { name: 'id', field: 'id' },
    { name: 'post_id', field: 'postId' },
  ]);
  return { tables, enums: {} };
}

describe('distinct + narrowed projection + orderBy on an unprojected column (build-only)', () => {
  it('projects the missing order columns into the inner query and lists the selection in the outer', () => {
    const q = makeQuery('posts', buildSchema(), { warnOnUnlimited: false });
    const { sql } = q.buildFindMany({
      distinct: ['authorId', 'published'],
      orderBy: [{ published: 'asc' }, { authorId: 'asc' }, { id: 'desc' }],
      select: { id: true },
    });
    assert.equal(
      sql,
      'SELECT "id" FROM (SELECT DISTINCT ON ("author_id", "published") "posts"."id", "posts"."published", "posts"."author_id" ' +
        'FROM "posts" ORDER BY "author_id" ASC, "published" ASC, "published" ASC, "author_id" ASC, "id" DESC) ' +
        'AS "posts_distinct" ORDER BY "published" ASC, "author_id" ASC, "id" DESC',
    );
  });

  it('a selected order column is not projected twice', () => {
    const q = makeQuery('posts', buildSchema(), { warnOnUnlimited: false });
    const { sql } = q.buildFindMany({
      distinct: ['authorId'],
      orderBy: [{ authorId: 'asc' }, { viewCount: 'desc' }],
      select: { id: true, authorId: true },
    });
    assert.equal(
      sql,
      'SELECT "id", "author_id" FROM (SELECT DISTINCT ON ("author_id") "posts"."id", "posts"."author_id", "posts"."view_count" ' +
        'FROM "posts" ORDER BY "author_id" ASC, "author_id" ASC, "view_count" DESC) ' +
        'AS "posts_distinct" ORDER BY "author_id" ASC, "view_count" DESC',
    );
  });

  it('a PII-narrowed projection with no user select gets the same treatment and never lists the PII column outside', () => {
    const q = makeQuery('posts', buildSchema(), { warnOnUnlimited: false });
    const { sql } = q.buildFindMany({ distinct: ['email'], orderBy: { email: 'asc' } });
    assert.match(sql, /^SELECT "id", "author_id", "published", "view_count" FROM \(SELECT DISTINCT ON \("email"\) /);
    assert.match(
      sql,
      /"posts"\."email" FROM "posts" ORDER BY "email" ASC, "email" ASC\) AS "posts_distinct" ORDER BY "email" ASC$/,
    );
    assert.doesNotMatch(sql, /^SELECT [^(]*"email"[^(]* FROM \(/, 'the outer list must not carry the PII column');
  });

  it('a with clause keeps its relation and _count columns in the outer list', () => {
    const q = makeQuery('posts', buildSchema(), { warnOnUnlimited: false });
    const { sql } = q.buildFindMany({
      distinct: ['authorId'],
      orderBy: { viewCount: 'desc' },
      select: { id: true },
      with: { comments: true, _count: { comments: true } },
    } as never);
    assert.match(
      sql,
      /^SELECT "id", "comments", "_count__comments" FROM \(SELECT DISTINCT ON \("author_id"\) "posts"\."id", \(/,
    );
    assert.match(
      sql,
      /, "posts"\."view_count" FROM "posts" ORDER BY "author_id" ASC, "view_count" DESC\) AS "posts_distinct" ORDER BY "view_count" DESC$/,
    );
  });

  it('the full projection keeps the SELECT * wrapper byte for byte', () => {
    const q = makeQuery('posts', buildSchema(), { warnOnUnlimited: false });
    const schema = buildSchema();
    // A schema with no PII column projects `*`, the pre-existing fast path.
    schema.tables.posts!.columns = schema.tables.posts!.columns.filter((c) => c.name !== 'email');
    schema.tables.posts!.allColumns = schema.tables.posts!.allColumns.filter((c) => c !== 'email');
    const plain = makeQuery('posts', schema, { warnOnUnlimited: false });
    const { sql } = plain.buildFindMany({ distinct: ['authorId'], orderBy: { viewCount: 'desc' } });
    assert.equal(
      sql,
      'SELECT * FROM (SELECT DISTINCT ON ("author_id") "posts".* FROM "posts" ORDER BY "author_id" ASC, "view_count" DESC) ' +
        'AS "posts_distinct" ORDER BY "view_count" DESC',
    );
    // And a select that already covers the order columns needs no extras.
    const covered = q.buildFindMany({
      distinct: ['authorId'],
      orderBy: { id: 'asc' },
      select: { id: true, authorId: true },
    });
    assert.equal(
      covered.sql,
      'SELECT * FROM (SELECT DISTINCT ON ("author_id") "posts"."id", "posts"."author_id" FROM "posts" ORDER BY "author_id" ASC, "id" ASC) ' +
        'AS "posts_distinct" ORDER BY "id" ASC',
    );
  });
});

// ---------------------------------------------------------------------------
// Integration (needs DATABASE_URL)
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping distinct/select/orderBy integration tests: DATABASE_URL not set');
}

const TABLE = 'qa78_dso_posts';
const CHILD = 'qa78_dso_comments';
const DDL = [
  `DROP TABLE IF EXISTS ${CHILD}, ${TABLE} CASCADE`,
  `CREATE TABLE ${TABLE} (id serial PRIMARY KEY, author_id int NOT NULL, published bool NOT NULL, view_count int NOT NULL, email text NOT NULL)`,
  `CREATE TABLE ${CHILD} (id serial PRIMARY KEY, qa78_dso_post_id int NOT NULL REFERENCES ${TABLE}(id))`,
  `INSERT INTO ${TABLE} (author_id, published, view_count, email)
     SELECT g % 7, g % 2 = 0, (g * 37) % 101, 'u' || (g % 13) || '@example.test' FROM generate_series(1, 300) g`,
  `INSERT INTO ${CHILD} (qa78_dso_post_id) SELECT id FROM ${TABLE} WHERE id % 3 = 0`,
];

let pool: pg.Pool;
let db: TurbineClient;
let schema: SchemaMetadata;

const { it: liveIt, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

async function rawRows<T extends object>(sql: string): Promise<T[]> {
  return (await pool.query<T>(sql)).rows;
}

describe('distinct + narrowed projection + orderBy on an unprojected column (live)', () => {
  before(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
    for (const sql of DDL) await pool.query(sql);
    schema = await introspect({ connectionString: DATABASE_URL! });
    // Introspection never tags PII; tag the column the way a code-first
    // schema would so the projection rule narrows the default row.
    const email = schema.tables[TABLE]!.columns.find((c) => c.name === 'email');
    assert.ok(email);
    (email as { pii?: true }).pii = true;
    db = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 4, warnOnUnlimited: false }, schema);
    await db.connect();
  });

  after(async () => {
    if (db) await db.disconnect();
    if (pool) {
      await pool.query(`DROP TABLE IF EXISTS ${CHILD}, ${TABLE} CASCADE`);
      await pool.end();
    }
  });

  liveIt(
    'the exact failing call: distinct on two columns, ordered by them plus id desc, selecting id only',
    async () => {
      const rows = (await db.table(TABLE).findMany({
        distinct: ['authorId', 'published'],
        orderBy: [{ published: 'asc' }, { authorId: 'asc' }, { id: 'desc' }],
        select: { id: true },
      } as never)) as Record<string, unknown>[];
      const expected = await rawRows<{ id: number }>(
        `SELECT id FROM (SELECT DISTINCT ON (author_id, published) id, published, author_id FROM ${TABLE}
         ORDER BY author_id, published, id DESC) d ORDER BY published, author_id, id DESC`,
      );
      assert.equal(rows.length, 14, 'fixture: 7 authors x 2 published states');
      assert.deepEqual(
        rows,
        expected.map((r) => ({ id: r.id })),
      );
      for (const row of rows) assert.deepEqual(Object.keys(row), ['id'], 'no order column leaks into the row');
    },
  );

  liveIt('distinct on one column, ordered by it and an unselected second column', async () => {
    const rows = (await db.table(TABLE).findMany({
      distinct: ['authorId'],
      orderBy: [{ authorId: 'asc' }, { viewCount: 'desc' }],
      select: { id: true },
    } as never)) as Record<string, unknown>[];
    const expected = await rawRows<{ id: number }>(
      `SELECT id FROM (SELECT DISTINCT ON (author_id) id, author_id, view_count FROM ${TABLE}
         ORDER BY author_id, view_count DESC) d ORDER BY author_id, view_count DESC`,
    );
    assert.equal(rows.length, 7);
    assert.deepEqual(
      rows,
      expected.map((r) => ({ id: r.id })),
    );
  });

  liveIt('PII-narrowed projection with no select: the query succeeds and the row has no email key', async () => {
    const rows = (await db.table(TABLE).findMany({
      distinct: ['email'],
      orderBy: { email: 'asc' },
      limit: 2,
    } as never)) as Record<string, unknown>[];
    const expected = await rawRows<{ id: number }>(
      `SELECT id FROM (SELECT DISTINCT ON (email) id, email FROM ${TABLE} ORDER BY email, email) d ORDER BY email LIMIT 2`,
    );
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => r.id),
      expected.map((r) => r.id),
    );
    for (const row of rows) {
      assert.equal('email' in row, false, 'the PII column must not reach the row');
      assert.deepEqual(Object.keys(row).sort(), ['authorId', 'id', 'published', 'viewCount']);
    }
  });

  liveIt('with a relation and _count alongside a narrowed select', async () => {
    const rel = Object.values(schema.tables[TABLE]!.relations).find((r) => r.type === 'hasMany');
    assert.ok(rel);
    const rows = (await db.table(TABLE).findMany({
      distinct: ['authorId'],
      orderBy: { viewCount: 'desc' },
      select: { id: true },
      with: { [rel.name]: true, _count: { [rel.name]: true } },
    } as never)) as Record<string, unknown>[];
    const expected = await rawRows<{ id: number; n: number }>(
      `SELECT d.id, (SELECT count(*)::int FROM ${CHILD} c WHERE c.qa78_dso_post_id = d.id) AS n
         FROM (SELECT DISTINCT ON (author_id) id, view_count FROM ${TABLE} ORDER BY author_id, view_count DESC) d
        ORDER BY view_count DESC`,
    );
    assert.equal(rows.length, 7);
    assert.deepEqual(
      rows.map((r) => r.id),
      expected.map((r) => r.id),
    );
    for (const [i, row] of rows.entries()) {
      assert.deepEqual(Object.keys(row).sort(), ['_count', 'id', rel.name].sort());
      assert.equal((row._count as Record<string, number>)[rel.name], expected[i]!.n);
      assert.equal((row[rel.name] as unknown[]).length, expected[i]!.n);
    }
  });

  liveIt('a projection that already covers the order columns is unchanged', async () => {
    const rows = (await db.table(TABLE).findMany({
      distinct: ['authorId'],
      orderBy: { id: 'asc' },
      select: { id: true, authorId: true },
    } as never)) as Record<string, unknown>[];
    const expected = await rawRows<{ id: number; author_id: number }>(
      `SELECT id, author_id FROM (SELECT DISTINCT ON (author_id) id, author_id FROM ${TABLE} ORDER BY author_id, id) d ORDER BY id`,
    );
    assert.deepEqual(
      rows,
      expected.map((r) => ({ id: r.id, authorId: r.author_id })),
    );
  });
});
