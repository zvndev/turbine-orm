/**
 * turbine-orm, Self-relation regression tests
 *
 * A self-referencing FK (e.g. `categories.parent_id → categories.id`)
 * introspects to a belongsTo + a hasMany on the SAME table. The query builder
 * handles this because each `buildRelationSubquery()` call allocates a fresh
 * alias (t0, t1, ...), so the parent and child references never collide even
 * though they target the same table.
 *
 * Two layers of coverage:
 *
 *  1. **Build-only (no DB).** Feeds a mock schema whose `categories` table has
 *     both a `parent` (belongsTo) and `children` (hasMany) self-relation and
 *     asserts the generated SQL correlates correctly with distinct aliases.
 *
 *  2. **Integration (needs DATABASE_URL).** Creates a real self-referencing
 *     table, seeds a parent→children tree, introspects it, and asserts that
 *     querying a parent with its children nested (and a child with its parent
 *     nested) returns the correct shapes.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/self-relation.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TurbineClient } from '../client.js';
import { introspect } from '../introspect.js';
import type { RelationDef, SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable, skipGate } from './helpers.js';

// ---------------------------------------------------------------------------
// Build-only (no DB), alias-collision regression
// ---------------------------------------------------------------------------

/**
 * Mock schema: a single `categories` table that references itself.
 *   parent  , belongsTo (this.parent_id → categories.id)
 *   children, hasMany   (categories.parent_id → this.id)
 */
function selfRelationSchema(): SchemaMetadata {
  const parent: RelationDef = {
    type: 'belongsTo',
    name: 'parent',
    from: 'categories',
    to: 'categories',
    foreignKey: 'parent_id',
    referenceKey: 'id',
  };
  const children: RelationDef = {
    type: 'hasMany',
    name: 'children',
    from: 'categories',
    to: 'categories',
    foreignKey: 'parent_id',
    referenceKey: 'id',
  };
  const categories = mockTable(
    'categories',
    [
      { name: 'id', field: 'id' },
      { name: 'name', field: 'name', pgType: 'text' },
      { name: 'parent_id', field: 'parentId' },
    ],
    { parent, children },
  );
  return { tables: { categories }, enums: {} };
}

describe('self-relation SQL generation (unit)', () => {
  it('hasMany children correlate to the parent row without alias collision', () => {
    const q = makeQuery('categories', selfRelationSchema());
    const { sql } = q.buildFindMany({ with: { children: true } });

    // The outer query selects from categories; the child subquery uses a fresh
    // alias (t0) and correlates the child's parent_id to the outer row's id.
    assert.match(sql, /json_agg/);
    assert.match(sql, /"categories"\s+t0\b/);
    assert.match(sql, /t0\."parent_id"\s*=\s*"categories"\."id"/);
  });

  it('belongsTo parent correlates with a distinct alias', () => {
    const q = makeQuery('categories', selfRelationSchema());
    const { sql } = q.buildFindMany({ with: { parent: true } });

    // belongsTo reverses the correlation: child alias's id = parent row's parent_id.
    assert.match(sql, /t0\."id"\s*=\s*"categories"\."parent_id"/);
    assert.match(sql, /LIMIT 1/);
  });

  it('both self-relations in one query use separate aliases (no collision)', () => {
    const q = makeQuery('categories', selfRelationSchema());
    const { sql } = q.buildFindMany({ with: { parent: true, children: true } });

    // Two subqueries → t0 and t1, each targeting "categories".
    assert.match(sql, /"categories"\s+t0\b/);
    assert.match(sql, /"categories"\s+t1\b/);
    // Both correlate to the SAME outer table name, but never to each other.
    assert.match(sql, /"categories"\."id"/);
    assert.match(sql, /"categories"\."parent_id"/);
  });

  it('nested self-relation (children → children) recurses with fresh aliases', () => {
    const q = makeQuery('categories', selfRelationSchema());
    const { sql } = q.buildFindMany({ with: { children: { with: { children: true } } } });

    // Three distinct aliases across two nesting levels: outer "categories",
    // t0 (first children level), t1 (nested children level).
    assert.match(sql, /\bt0\b/);
    assert.match(sql, /\bt1\b/);
    // The nested level correlates child rows to the t0 alias, not to "categories".
    // (nested parentRef is an alias, which the builder quotes: "t0".)
    assert.match(sql, /t1\."parent_id"\s*=\s*"?t0"?\."id"/);
  });
});

describe('self-relation FILTER SQL generation (unit)', () => {
  // A relation filter compiles to a correlated EXISTS. With the target table
  // named bare in the subquery's FROM, a self-relation's correlation
  // `"categories"."parent_id" = "categories"."id"` binds BOTH sides to the
  // inner row, so `some: {}` matched nothing and `none: {}` matched everything.
  // The inner table takes an alias whenever the parent reference would
  // otherwise name it.
  it('hasMany some: the EXISTS table is aliased and correlated to the OUTER row', () => {
    const q = makeQuery('categories', selfRelationSchema());
    const { sql } = q.buildFindMany({ where: { children: { some: {} } } });
    assert.match(sql, /EXISTS \(SELECT 1 FROM "categories" rf0 WHERE rf0\."parent_id" = "categories"\."id"\)/);
    assert.doesNotMatch(
      sql,
      /"categories"\."parent_id" = "categories"\."id"/,
      'the inner row must not correlate to itself',
    );
  });

  it('hasMany none / every: NOT EXISTS carries the same alias and qualifies the sub-where by it', () => {
    const q = makeQuery('categories', selfRelationSchema());
    const none = q.buildFindMany({ where: { children: { none: {} } } });
    assert.match(none.sql, /NOT EXISTS \(SELECT 1 FROM "categories" rf0 WHERE rf0\."parent_id" = "categories"\."id"\)/);
    const every = q.buildFindMany({ where: { children: { every: { name: { not: null } } } } });
    assert.match(
      every.sql,
      /NOT EXISTS \(SELECT 1 FROM "categories" rf0 WHERE rf0\."parent_id" = "categories"\."id" AND NOT \(rf0\."name" IS NOT NULL\)\)/,
    );
  });

  it("belongsTo is / bare / is null: the parent row is the aliased one, the FK is the outer row's", () => {
    const q = makeQuery('categories', selfRelationSchema());
    const is = q.buildFindMany({ where: { parent: { is: { id: 8 } } } });
    assert.match(
      is.sql,
      /EXISTS \(SELECT 1 FROM "categories" rf0 WHERE rf0\."id" = "categories"\."parent_id" AND rf0\."id" = \$1\)/,
    );
    assert.deepEqual(is.params, [8]);
    const bare = q.buildFindMany({ where: { parent: { id: 8 } } });
    assert.equal(bare.sql, is.sql, 'the bare to-one shape is the implicit `is`');
    const isNull = q.buildFindMany({ where: { parent: { is: null } } });
    assert.match(
      isNull.sql,
      /NOT EXISTS \(SELECT 1 FROM "categories" rf0 WHERE rf0\."id" = "categories"\."parent_id"\)/,
    );
  });

  it('two nested levels alias each level distinctly and chain the correlation through the alias', () => {
    const q = makeQuery('categories', selfRelationSchema());
    const { sql } = q.buildFindMany({ where: { children: { some: { children: { some: {} } } } } });
    // Outer level: rf0 correlated to the outer row. Inner level: its parent is
    // rf0 (an alias, so no capture is possible) and it keeps the bare name.
    assert.match(
      sql,
      /EXISTS \(SELECT 1 FROM "categories" rf0 WHERE rf0\."parent_id" = "categories"\."id" AND EXISTS \(SELECT 1 FROM "categories" WHERE "categories"\."parent_id" = rf0\."id"\)\)/,
    );
  });

  it('a self filter inside a with-clause where correlates to the with alias, not to itself', () => {
    const q = makeQuery('categories', selfRelationSchema());
    const { sql } = q.buildFindMany({ with: { children: { where: { children: { none: {} } } } } });
    // The with subquery's table is `t0`; the relation filter's parent reference
    // is that alias, so the bare inner name cannot capture it.
    assert.match(sql, /NOT EXISTS \(SELECT 1 FROM "categories" WHERE "categories"\."parent_id" = "?t0"?\."id"\)/);
  });

  it('count carries the aliased correlation too', () => {
    const q = makeQuery('categories', selfRelationSchema());
    const { sql } = q.buildCount({ where: { children: { some: {} } } });
    assert.match(sql, /FROM "categories" rf0 WHERE rf0\."parent_id" = "categories"\."id"/);
  });

  it('a non-self relation filter keeps its bare-table template byte for byte', () => {
    const schema = selfRelationSchema();
    schema.tables.posts = mockTable(
      'posts',
      [
        { name: 'id', field: 'id' },
        { name: 'category_id', field: 'categoryId' },
      ],
      {
        category: {
          type: 'belongsTo',
          name: 'category',
          from: 'posts',
          to: 'categories',
          foreignKey: 'category_id',
          referenceKey: 'id',
        },
      },
    );
    const q = makeQuery('posts', schema);
    const { sql } = q.buildFindMany({ where: { category: { is: { name: 'x' } } } });
    assert.match(
      sql,
      /EXISTS \(SELECT 1 FROM "categories" WHERE "categories"\."id" = "posts"\."category_id" AND "categories"\."name" = \$1\)/,
    );
    assert.doesNotMatch(sql, /rf0/);
  });
});

// ---------------------------------------------------------------------------
// Integration (needs DATABASE_URL)
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping self-relation integration tests: DATABASE_URL not set');
}
const testFn = describe;

testFn('self-relation integration', () => {
  // Without DATABASE_URL these tests register as skipped (visible in the
  // reporter summary) and the before/after hooks become no-ops.
  const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');
  let client: TurbineClient;
  let schema: SchemaMetadata;

  before(async () => {
    // Bootstrap a unique-named self-referencing table so we never clobber the
    // shared fixture (users/posts/comments/orgs).
    const setup = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 2 }, { tables: {}, enums: {} });
    await setup.connect();
    await setup.sql`DROP TABLE IF EXISTS _t2b_categories CASCADE`;
    await setup.sql`
      CREATE TABLE _t2b_categories (
        id serial PRIMARY KEY,
        name text NOT NULL,
        parent_id int REFERENCES _t2b_categories(id)
      )
    `;
    // Tree: Root(1) → {Child A(2), Child B(3)}; Child A → Grandchild(4)
    await setup.sql`INSERT INTO _t2b_categories (id, name, parent_id) VALUES
      (1, 'Root', NULL),
      (2, 'Child A', 1),
      (3, 'Child B', 1),
      (4, 'Grandchild', 2)`;
    await setup.sql`SELECT setval(pg_get_serial_sequence('_t2b_categories', 'id'), 4)`;
    await setup.disconnect();

    schema = await introspect({ connectionString: DATABASE_URL! });
    client = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 3 }, schema);
    await client.connect();
  });

  after(async () => {
    if (client) {
      await client.sql`DROP TABLE IF EXISTS _t2b_categories CASCADE`;
      await client.disconnect();
    }
  });

  it('introspects a self-FK into belongsTo + hasMany on the same table', () => {
    const cats = schema.tables._t2b_categories;
    assert.ok(cats, 'table should be introspected');
    const rels = Object.values(cats!.relations);
    const belongsTo = rels.find((r) => r.type === 'belongsTo' && r.to === '_t2b_categories');
    const hasMany = rels.find((r) => r.type === 'hasMany' && r.to === '_t2b_categories');
    assert.ok(belongsTo, 'should derive a belongsTo back to itself');
    assert.ok(hasMany, 'should derive a hasMany back to itself');
  });

  it('parent with nested children returns the correct child set', async () => {
    const cats = client.table('_t2b_categories');
    // Resolve the relation names introspection assigned (auto-named).
    const meta = schema.tables._t2b_categories!;
    const hasManyName = Object.values(meta.relations).find(
      (r) => r.type === 'hasMany' && r.to === '_t2b_categories',
    )!.name;

    const root = await cats.findFirst({
      where: { id: 1 } as never,
      with: { [hasManyName]: true } as never,
    });
    assert.ok(root, 'root row exists');
    const children = (root as Record<string, unknown>)[hasManyName] as Array<{ id: number; name: string }>;
    assert.equal(children.length, 2);
    const names = children.map((c) => c.name).sort();
    assert.deepEqual(names, ['Child A', 'Child B']);
  });

  it('child with nested parent returns the correct parent', async () => {
    const cats = client.table('_t2b_categories');
    const meta = schema.tables._t2b_categories!;
    const belongsToName = Object.values(meta.relations).find(
      (r) => r.type === 'belongsTo' && r.to === '_t2b_categories',
    )!.name;

    const childA = await cats.findFirst({
      where: { id: 2 } as never,
      with: { [belongsToName]: true } as never,
    });
    assert.ok(childA, 'child A exists');
    const parent = (childA as Record<string, unknown>)[belongsToName] as { id: number; name: string } | null;
    assert.ok(parent, 'parent should be present');
    assert.equal(parent!.id, 1);
    assert.equal(parent!.name, 'Root');
  });

  it('multi-level self-nesting (children → children) returns the grandchild tree', async () => {
    const cats = client.table('_t2b_categories');
    const meta = schema.tables._t2b_categories!;
    const hasManyName = Object.values(meta.relations).find(
      (r) => r.type === 'hasMany' && r.to === '_t2b_categories',
    )!.name;

    const root = await cats.findFirst({
      where: { id: 1 } as never,
      with: { [hasManyName]: { with: { [hasManyName]: true } } } as never,
    });
    assert.ok(root);
    const children = (root as Record<string, unknown>)[hasManyName] as Array<Record<string, unknown>>;
    const childA = children.find((c) => c.name === 'Child A')!;
    const grandkids = childA[hasManyName] as Array<{ name: string }>;
    assert.equal(grandkids.length, 1);
    assert.equal(grandkids[0]!.name, 'Grandchild');
  });
});
