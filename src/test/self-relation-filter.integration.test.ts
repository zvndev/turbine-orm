/**
 * turbine-orm, relation filters on a SELF-referencing relation, live.
 *
 * A relation filter compiles to a correlated `EXISTS (SELECT 1 FROM target
 * WHERE target.fk = parent.pk ...)`. When target and parent are the same table
 * and the inner FROM names it bare, the correlation binds both sides to the
 * inner row (`"comments"."parent_id" = "comments"."id"`), so `some: {}` matched
 * nothing, `none: {}` matched everything, `is: null` matched every row, and the
 * defect propagated through nested filters and into a `with` clause's `where`
 * on the batched path. The inner table now takes an alias whenever the parent
 * reference would otherwise name it.
 *
 * Every row set here is asserted against raw SQL written by hand. The non-self
 * hasMany / belongsTo / manyToMany filters are asserted too, so a regression in
 * the ordinary shapes cannot hide behind the self fix.
 *
 * Creates and drops its own `qa78_*` tables:
 *   DATABASE_URL=postgres://... npx tsx --test src/test/self-relation-filter.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { introspect } from '../introspect.js';
import type { RelationDef, SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping self-relation filter integration tests: DATABASE_URL not set');
}

const TABLES = ['qa78_comment_tags', 'qa78_comments', 'qa78_tags', 'qa78_authors'];

const DDL = [
  `DROP TABLE IF EXISTS ${TABLES.join(', ')} CASCADE`,
  'CREATE TABLE qa78_authors (id serial PRIMARY KEY, name text NOT NULL)',
  'CREATE TABLE qa78_tags (id serial PRIMARY KEY, name text NOT NULL)',
  `CREATE TABLE qa78_comments (
     id serial PRIMARY KEY,
     parent_id int REFERENCES qa78_comments(id),
     author_id int REFERENCES qa78_authors(id),
     body text
   )`,
  `CREATE TABLE qa78_comment_tags (
     comment_id int NOT NULL REFERENCES qa78_comments(id),
     tag_id int NOT NULL REFERENCES qa78_tags(id),
     PRIMARY KEY (comment_id, tag_id)
   )`,
  "INSERT INTO qa78_authors (name) VALUES ('ann'), ('bob'), ('cid'), ('dee')",
  "INSERT INTO qa78_tags (name) VALUES ('tag1'), ('tag2'), ('tag3')",
  // 200 roots (no parent), authors cycle through 1..4.
  `INSERT INTO qa78_comments (id, parent_id, author_id, body)
     SELECT g, NULL, (g % 4) + 1, 'root ' || g FROM generate_series(1, 200) g`,
  // 90 replies to roots 1..5 (18 each); every third has no author; bodies
  // alternate between two prefixes so a sub-where can split them.
  `INSERT INTO qa78_comments (id, parent_id, author_id, body)
     SELECT g, ((g - 201) % 5) + 1,
            CASE WHEN g % 3 = 0 THEN NULL ELSE (g % 4) + 1 END,
            CASE WHEN g % 2 = 0 THEN 'reply ' || g ELSE 'note ' || g END
     FROM generate_series(201, 290) g`,
  // 10 grandchildren under replies 201..210, so roots 1..5 have depth-two trees.
  `INSERT INTO qa78_comments (id, parent_id, author_id, body)
     SELECT g, 200 + (g - 290), (g % 4) + 1, 'deep ' || g FROM generate_series(291, 300) g`,
  `INSERT INTO qa78_comment_tags (comment_id, tag_id)
     SELECT id, 1 FROM qa78_comments WHERE id % 10 = 0
     UNION ALL
     SELECT id, 2 FROM qa78_comments WHERE id % 15 = 0`,
  "SELECT setval(pg_get_serial_sequence('qa78_comments', 'id'), 300)",
];

let pool: pg.Pool;
let db: TurbineClient;
let schema: SchemaMetadata;
/** Declared relation names, resolved from the introspected metadata by shape. */
let rel: { children: string; parent: string; author: string; tags: string; authorComments: string };

const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

function findRelation(table: string, pred: (r: RelationDef) => boolean): string {
  const hit = Object.values(schema.tables[table]!.relations).find(pred);
  assert.ok(hit, `no relation on ${table} matched`);
  return hit.name;
}

async function ids(sql: string, params: unknown[] = []): Promise<number[]> {
  const res = await pool.query<{ id: number }>(sql, params);
  return res.rows.map((r) => r.id);
}

async function ormIds(
  table: string,
  where: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<number[]> {
  const rows = (await db.table(table).findMany({ where, orderBy: { id: 'asc' }, ...extra } as never)) as {
    id: number;
  }[];
  return rows.map((r) => r.id);
}

describe('self-relation filters correlate to the outer row (live)', () => {
  before(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
    for (const sql of DDL) await pool.query(sql);
    schema = await introspect({ connectionString: DATABASE_URL! });
    rel = {
      children: findRelation('qa78_comments', (r) => r.type === 'hasMany' && r.to === 'qa78_comments'),
      parent: findRelation('qa78_comments', (r) => r.type === 'belongsTo' && r.to === 'qa78_comments'),
      author: findRelation('qa78_comments', (r) => r.type === 'belongsTo' && r.to === 'qa78_authors'),
      tags: findRelation('qa78_comments', (r) => r.type === 'manyToMany' && r.to === 'qa78_tags'),
      authorComments: findRelation('qa78_authors', (r) => r.type === 'hasMany' && r.to === 'qa78_comments'),
    };
    db = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 4, warnOnUnlimited: false }, schema);
    await db.connect();
  });

  after(async () => {
    if (db) await db.disconnect();
    if (pool) {
      await pool.query(`DROP TABLE IF EXISTS ${TABLES.join(', ')} CASCADE`);
      await pool.end();
    }
  });

  it('hasMany some: {} returns the rows that HAVE children', async () => {
    const expected = await ids(
      'SELECT c.id FROM qa78_comments c WHERE EXISTS (SELECT 1 FROM qa78_comments k WHERE k.parent_id = c.id) ORDER BY c.id',
    );
    assert.equal(expected.length, 15, 'fixture: 5 roots + 10 replies have children');
    assert.deepEqual(await ormIds('qa78_comments', { [rel.children]: { some: {} } }), expected);
  });

  it('hasMany none: {} returns the leaves', async () => {
    const expected = await ids(
      'SELECT c.id FROM qa78_comments c WHERE NOT EXISTS (SELECT 1 FROM qa78_comments k WHERE k.parent_id = c.id) ORDER BY c.id',
    );
    assert.equal(expected.length, 285);
    assert.deepEqual(await ormIds('qa78_comments', { [rel.children]: { none: {} } }), expected);
  });

  it('hasMany every: rows whose every child has an author (vacuously true for leaves)', async () => {
    const expected = await ids(
      'SELECT c.id FROM qa78_comments c WHERE NOT EXISTS (SELECT 1 FROM qa78_comments k WHERE k.parent_id = c.id AND NOT (k.author_id IS NOT NULL)) ORDER BY c.id',
    );
    const leaves = await ids(
      'SELECT c.id FROM qa78_comments c WHERE NOT EXISTS (SELECT 1 FROM qa78_comments k WHERE k.parent_id = c.id)',
    );
    assert.ok(
      expected.length < 300 && expected.length > leaves.length,
      'fixture: some parents have an authorless child',
    );
    assert.deepEqual(
      await ormIds('qa78_comments', { [rel.children]: { every: { authorId: { not: null } } } }),
      expected,
    );
  });

  it('hasMany some with a sub-where on the child body', async () => {
    const expected = await ids(
      "SELECT c.id FROM qa78_comments c WHERE EXISTS (SELECT 1 FROM qa78_comments k WHERE k.parent_id = c.id AND k.body LIKE 'reply%') ORDER BY c.id",
    );
    assert.ok(expected.length > 0 && expected.length < 15);
    assert.deepEqual(
      await ormIds('qa78_comments', { [rel.children]: { some: { body: { startsWith: 'reply' } } } }),
      expected,
    );
  });

  it('belongsTo is / bare: the children of one parent', async () => {
    const expected = await ids('SELECT id FROM qa78_comments WHERE parent_id = 3 ORDER BY id');
    assert.equal(expected.length, 18);
    assert.deepEqual(await ormIds('qa78_comments', { [rel.parent]: { is: { id: 3 } } }), expected);
    assert.deepEqual(await ormIds('qa78_comments', { [rel.parent]: { id: 3 } }), expected);
  });

  it('belongsTo is: null / isNot: null split roots from non-roots', async () => {
    const roots = await ids('SELECT id FROM qa78_comments WHERE parent_id IS NULL ORDER BY id');
    const nonRoots = await ids('SELECT id FROM qa78_comments WHERE parent_id IS NOT NULL ORDER BY id');
    assert.equal(roots.length, 200);
    assert.deepEqual(await ormIds('qa78_comments', { [rel.parent]: { is: null } }), roots);
    assert.deepEqual(await ormIds('qa78_comments', { [rel.parent]: { isNot: null } }), nonRoots);
  });

  it('belongsTo isNot with a sub-where excludes exactly the parents matching it', async () => {
    const expected = await ids(
      'SELECT c.id FROM qa78_comments c WHERE NOT EXISTS (SELECT 1 FROM qa78_comments p WHERE p.id = c.parent_id AND p.author_id = 2) ORDER BY c.id',
    );
    assert.deepEqual(await ormIds('qa78_comments', { [rel.parent]: { isNot: { authorId: 2 } } }), expected);
  });

  it('two nested levels: rows with a grandchild', async () => {
    const expected = await ids(
      `SELECT c.id FROM qa78_comments c WHERE EXISTS (
         SELECT 1 FROM qa78_comments k WHERE k.parent_id = c.id AND EXISTS (
           SELECT 1 FROM qa78_comments g WHERE g.parent_id = k.id))
       ORDER BY c.id`,
    );
    assert.deepEqual(expected, [1, 2, 3, 4, 5]);
    assert.deepEqual(
      await ormIds('qa78_comments', { [rel.children]: { some: { [rel.children]: { some: {} } } } }),
      expected,
    );
  });

  it('a self filter reached through another table: authors of a reply to one of the first two replies', async () => {
    const expected = await ids(
      `SELECT a.id FROM qa78_authors a WHERE EXISTS (
         SELECT 1 FROM qa78_comments c WHERE c.author_id = a.id AND EXISTS (
           SELECT 1 FROM qa78_comments p WHERE p.id = c.parent_id AND p.parent_id IS NOT NULL AND p.id <= 202))
       ORDER BY a.id`,
    );
    // Grandchildren 291 and 292 (authors 4 and 1): two of the four authors, so
    // a filter that matched everything or nothing would both be caught.
    assert.deepEqual(expected, [1, 4], 'fixture');
    assert.deepEqual(
      await ormIds('qa78_authors', {
        [rel.authorComments]: { some: { [rel.parent]: { is: { parentId: { not: null }, id: { lte: 202 } } } } },
      }),
      expected,
    );
  });

  for (const strategy of ['join', 'batched'] as const) {
    it(`inside a with-clause where (${strategy}): children that are themselves leaves`, async () => {
      const rows = (await db.table('qa78_comments').findMany({
        where: { id: { in: [1, 2] } },
        orderBy: { id: 'asc' },
        with: { [rel.children]: { where: { [rel.children]: { none: {} } }, orderBy: { id: 'asc' } } },
        relationLoadStrategy: strategy,
      } as never)) as ({ id: number } & Record<string, { id: number }[]>)[];
      assert.equal(rows.length, 2);
      for (const row of rows) {
        const expected = await ids(
          `SELECT k.id FROM qa78_comments k WHERE k.parent_id = $1
             AND NOT EXISTS (SELECT 1 FROM qa78_comments g WHERE g.parent_id = k.id) ORDER BY k.id`,
          [row.id],
        );
        assert.equal(expected.length, 16, `fixture: root ${row.id} has 18 children, 2 of them with grandchildren`);
        assert.deepEqual(
          row[rel.children]!.map((c) => c.id),
          expected,
          `${strategy}: children of ${row.id}`,
        );
      }
    });
  }

  it('count agrees with the raw count for a self filter', async () => {
    const n = await db.table('qa78_comments').count({ where: { [rel.children]: { some: {} } } } as never);
    assert.equal(n, 15);
  });

  it('non-self hasMany / belongsTo / manyToMany filters are unchanged (regression net)', async () => {
    const authorsWithDeep = await ids(
      "SELECT a.id FROM qa78_authors a WHERE EXISTS (SELECT 1 FROM qa78_comments c WHERE c.author_id = a.id AND c.body LIKE 'deep%') ORDER BY a.id",
    );
    assert.deepEqual(
      await ormIds('qa78_authors', { [rel.authorComments]: { some: { body: { startsWith: 'deep' } } } }),
      authorsWithDeep,
    );

    const byAnn = await ids(
      "SELECT c.id FROM qa78_comments c WHERE EXISTS (SELECT 1 FROM qa78_authors a WHERE a.id = c.author_id AND a.name = 'ann') ORDER BY c.id",
    );
    assert.ok(byAnn.length > 0);
    assert.deepEqual(await ormIds('qa78_comments', { [rel.author]: { is: { name: 'ann' } } }), byAnn);

    const tagged = await ids(
      `SELECT c.id FROM qa78_comments c WHERE EXISTS (
         SELECT 1 FROM qa78_tags t WHERE EXISTS (
           SELECT 1 FROM qa78_comment_tags j WHERE j.tag_id = t.id AND j.comment_id = c.id) AND t.name = 'tag1')
       ORDER BY c.id`,
    );
    assert.equal(tagged.length, 30);
    assert.deepEqual(await ormIds('qa78_comments', { [rel.tags]: { some: { name: 'tag1' } } }), tagged);
    const untagged = await ids(
      'SELECT c.id FROM qa78_comments c WHERE NOT EXISTS (SELECT 1 FROM qa78_comment_tags j WHERE j.comment_id = c.id) ORDER BY c.id',
    );
    assert.deepEqual(await ormIds('qa78_comments', { [rel.tags]: { none: {} } }), untagged);
  });
});
