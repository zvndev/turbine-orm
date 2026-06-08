/**
 * turbine-orm — Self-relation regression tests
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
import { after, before, describe, it } from 'node:test';
import { TurbineClient } from '../client.js';
import { introspect } from '../introspect.js';
import type { RelationDef, SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

// ---------------------------------------------------------------------------
// Build-only (no DB) — alias-collision regression
// ---------------------------------------------------------------------------

/**
 * Mock schema: a single `categories` table that references itself.
 *   parent   — belongsTo (this.parent_id → categories.id)
 *   children — hasMany   (categories.parent_id → this.id)
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

// ---------------------------------------------------------------------------
// Integration (needs DATABASE_URL)
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping self-relation integration tests: DATABASE_URL not set');
}
const testFn = SKIP ? describe.skip : describe;

testFn('self-relation integration', () => {
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
