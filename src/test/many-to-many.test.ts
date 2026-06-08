/**
 * turbine-orm — Many-to-many (junction table) tests
 *
 * Three layers:
 *
 *  1. **Build-only (no DB).** Feeds a mock schema with a `manyToMany` RelationDef
 *     carrying a `through` junction descriptor and asserts the generated SQL
 *     JOINs the target through the junction, correlates to the parent, and keeps
 *     every user value parameterized. Composite-key junctions covered too.
 *
 *  2. **Introspection heuristic (no DB).** Proves the conservative junction
 *     auto-detection fires for a PURE 2-FK/2-col-PK junction and does NOT fire
 *     for a junction carrying extra (non-PK, non-FK) columns.
 *
 *  3. **Integration (needs DATABASE_URL).** Creates real posts/tags/junction
 *     tables, seeds them, introspects, and asserts auto-detected m2m relations
 *     plus `with: { tags: true }` (and nested where/orderBy) return correctly.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/many-to-many.test.ts
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { TurbineClient } from '../client.js';
import { introspect } from '../introspect.js';
import type { RelationDef, SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

// ---------------------------------------------------------------------------
// Build-only (no DB) — m2m JOIN-through-junction SQL
// ---------------------------------------------------------------------------

/**
 * Mock schema: posts <-> tags through posts_tags(post_id, tag_id).
 *   posts.tags — manyToMany through posts_tags
 */
function m2mSchema(): SchemaMetadata {
  const tagsRel: RelationDef = {
    type: 'manyToMany',
    name: 'tags',
    from: 'posts',
    to: 'tags',
    foreignKey: 'id', // unused for m2m correlation, kept for shape parity
    referenceKey: 'id', // posts PK that the junction.post_id references
    through: { table: 'posts_tags', sourceKey: 'post_id', targetKey: 'tag_id' },
  };
  const posts = mockTable(
    'posts',
    [
      { name: 'id', field: 'id' },
      { name: 'title', field: 'title', pgType: 'text' },
    ],
    { tags: tagsRel },
  );
  const tags = mockTable('tags', [
    { name: 'id', field: 'id' },
    { name: 'name', field: 'name', pgType: 'text' },
  ]);
  const postsTags = mockTable('posts_tags', [
    { name: 'post_id', field: 'postId' },
    { name: 'tag_id', field: 'tagId' },
  ]);
  return { tables: { posts, tags, posts_tags: postsTags }, enums: {} };
}

/** Composite-key variant: junction references a 2-col PK on both sides. */
function compositeM2mSchema(): SchemaMetadata {
  const rel: RelationDef = {
    type: 'manyToMany',
    name: 'rights',
    from: 'lefts',
    to: 'rights',
    foreignKey: 'id',
    referenceKey: ['org_id', 'id'],
    through: {
      table: 'links',
      sourceKey: ['left_org_id', 'left_id'],
      targetKey: ['right_org_id', 'right_id'],
    },
  };
  const lefts = mockTable(
    'lefts',
    [
      { name: 'org_id', field: 'orgId' },
      { name: 'id', field: 'id' },
    ],
    { rights: rel },
  );
  const rights = mockTable('rights', [
    { name: 'org_id', field: 'orgId' },
    { name: 'id', field: 'id' },
    { name: 'label', field: 'label', pgType: 'text' },
  ]);
  // Mark rights PK as composite so the JOIN uses both columns.
  rights.primaryKey = ['org_id', 'id'];
  const links = mockTable('links', [
    { name: 'left_org_id', field: 'leftOrgId' },
    { name: 'left_id', field: 'leftId' },
    { name: 'right_org_id', field: 'rightOrgId' },
    { name: 'right_id', field: 'rightId' },
  ]);
  return { tables: { lefts, rights, links }, enums: {} };
}

describe('many-to-many SQL generation (unit)', () => {
  it('JOINs the target through the junction and correlates to the parent', () => {
    const q = makeQuery('posts', m2mSchema());
    const { sql, params } = q.buildFindMany({ with: { tags: true } });

    // Aggregates target rows into a JSON array.
    assert.match(sql, /json_agg/);
    // JOINs tags through posts_tags on junction.tag_id = tags.id.
    assert.match(sql, /FROM\s+"tags"\s+t0\s+JOIN\s+"posts_tags"\s+t0j\s+ON\s+t0j\."tag_id"\s*=\s*t0\."id"/);
    // Correlates junction.post_id to the parent posts.id.
    assert.match(sql, /t0j\."post_id"\s*=\s*"posts"\."id"/);
    // No filters → no extra params.
    assert.deepEqual(params, []);

    // Expose the exact SQL for the report.
    console.log(`M2M SQL (tags: true):\n${sql}`);
  });

  it('parameterizes a where filter on the m2m target', () => {
    const q = makeQuery('posts', m2mSchema());
    const { sql, params } = q.buildFindMany({ with: { tags: { where: { name: 'sql' } } } });
    assert.match(sql, /t0\."name"\s*=\s*\$1/);
    assert.deepEqual(params, ['sql']);
    // The value must NOT appear inline in the SQL text.
    assert.ok(!sql.includes("'sql'"), 'value must be a bound param, not inlined');
  });

  it('wraps in an inner subquery for LIMIT/ORDER so LIMIT applies pre-aggregation', () => {
    const q = makeQuery('posts', m2mSchema());
    const { sql, params } = q.buildFindMany({
      with: { tags: { orderBy: { name: 'desc' }, limit: 5 } },
    });
    // Inner subquery wraps the joined rows; outer aggregates.
    assert.match(sql, /FROM\s+\(SELECT .* JOIN "posts_tags" t0j .* ORDER BY t0\."name" DESC LIMIT \$1\) t0i/);
    assert.deepEqual(params, [5]);
  });

  it('supports composite-key junctions (AND-joined column pairs)', () => {
    const q = makeQuery('lefts', compositeM2mSchema());
    const { sql } = q.buildFindMany({ with: { rights: true } });
    // JOIN on BOTH target-key columns.
    assert.match(sql, /t0j\."right_org_id"\s*=\s*t0\."org_id"\s+AND\s+t0j\."right_id"\s*=\s*t0\."id"/);
    // Correlation on BOTH source-key columns to the parent.
    assert.match(sql, /t0j\."left_org_id"\s*=\s*"lefts"\."org_id"\s+AND\s+t0j\."left_id"\s*=\s*"lefts"\."id"/);
  });

  it('all where values across nested m2m are parameterized, never interpolated', () => {
    const q = makeQuery('posts', m2mSchema());
    const evil = "x'; DROP TABLE tags; --";
    const { sql, params } = q.buildFindMany({ with: { tags: { where: { name: evil } } } });
    assert.ok(!sql.includes('DROP TABLE'), 'payload must not reach SQL text');
    assert.deepEqual(params, [evil]);
  });
});

// ---------------------------------------------------------------------------
// Integration (needs DATABASE_URL)
//
// The junction auto-detection heuristic requires reading a live information_schema,
// so it is covered against a real database below: it asserts the heuristic FIRES
// for a pure 2-FK/2-col-PK junction (`_t2b_posts_tags`) and does NOT fire for a
// junction carrying payload columns (`_t2b_payload_link`).
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping many-to-many integration tests: DATABASE_URL not set');
}
const testFn = SKIP ? describe.skip : describe;

testFn('many-to-many integration', () => {
  let client: TurbineClient;
  let schema: SchemaMetadata;

  before(async () => {
    const setup = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 2 }, { tables: {}, enums: {} });
    await setup.connect();
    await setup.sql`DROP TABLE IF EXISTS _t2b_payload_link CASCADE`;
    await setup.sql`DROP TABLE IF EXISTS _t2b_posts_tags CASCADE`;
    await setup.sql`DROP TABLE IF EXISTS _t2b_posts CASCADE`;
    await setup.sql`DROP TABLE IF EXISTS _t2b_tags CASCADE`;
    await setup.sql`CREATE TABLE _t2b_posts (id serial PRIMARY KEY, title text NOT NULL)`;
    await setup.sql`CREATE TABLE _t2b_tags (id serial PRIMARY KEY, name text NOT NULL)`;
    await setup.sql`
      CREATE TABLE _t2b_posts_tags (
        post_id int NOT NULL REFERENCES _t2b_posts(id),
        tag_id  int NOT NULL REFERENCES _t2b_tags(id),
        PRIMARY KEY (post_id, tag_id)
      )
    `;
    // A junction-with-PAYLOAD table — two FKs but an extra `note` column. The
    // heuristic must NOT treat this as a pure junction (it's a first-class
    // entity), so no manyToMany relation should be auto-detected from it.
    await setup.sql`
      CREATE TABLE _t2b_payload_link (
        post_id int NOT NULL REFERENCES _t2b_posts(id),
        tag_id  int NOT NULL REFERENCES _t2b_tags(id),
        note    text,
        PRIMARY KEY (post_id, tag_id)
      )
    `;
    await setup.sql`INSERT INTO _t2b_posts (id, title) VALUES (1, 'First'), (2, 'Second')`;
    await setup.sql`INSERT INTO _t2b_tags (id, name) VALUES (1, 'sql'), (2, 'orm'), (3, 'pg')`;
    await setup.sql`INSERT INTO _t2b_posts_tags (post_id, tag_id) VALUES
      (1, 1), (1, 2), (2, 2), (2, 3)`;
    await setup.sql`SELECT setval(pg_get_serial_sequence('_t2b_posts', 'id'), 2)`;
    await setup.sql`SELECT setval(pg_get_serial_sequence('_t2b_tags', 'id'), 3)`;
    await setup.disconnect();

    schema = await introspect({ connectionString: DATABASE_URL! });
    client = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 3 }, schema);
    await client.connect();
  });

  after(async () => {
    if (client) {
      await client.sql`DROP TABLE IF EXISTS _t2b_payload_link CASCADE`;
      await client.sql`DROP TABLE IF EXISTS _t2b_posts_tags CASCADE`;
      await client.sql`DROP TABLE IF EXISTS _t2b_posts CASCADE`;
      await client.sql`DROP TABLE IF EXISTS _t2b_tags CASCADE`;
      await client.disconnect();
    }
  });

  it('auto-detects posts.tags and tags.posts manyToMany relations', () => {
    const posts = schema.tables._t2b_posts!;
    const tags = schema.tables._t2b_tags!;
    const postsToTags = Object.values(posts.relations).find((r) => r.type === 'manyToMany' && r.to === '_t2b_tags');
    const tagsToPosts = Object.values(tags.relations).find((r) => r.type === 'manyToMany' && r.to === '_t2b_posts');
    assert.ok(postsToTags, 'posts should gain a manyToMany to tags');
    assert.ok(tagsToPosts, 'tags should gain a manyToMany to posts');
    assert.equal(postsToTags!.through?.table, '_t2b_posts_tags');
    assert.equal(tagsToPosts!.through?.table, '_t2b_posts_tags');
  });

  it('preserves the ordinary hasMany from the junction (additive, non-destructive)', () => {
    const posts = schema.tables._t2b_posts!;
    // posts should still have a hasMany to the junction table itself.
    const toJunction = Object.values(posts.relations).find((r) => r.type === 'hasMany' && r.to === '_t2b_posts_tags');
    assert.ok(toJunction, 'original hasMany to the junction table must remain');
  });

  it('does NOT auto-detect m2m through a junction carrying payload columns', () => {
    // _t2b_payload_link has two FKs (post_id, tag_id) but ALSO a `note` column,
    // so it is a first-class entity, not a pure junction. The conservative
    // heuristic must skip it — posts/tags get NO m2m routed through it.
    const posts = schema.tables._t2b_posts!;
    const tags = schema.tables._t2b_tags!;
    const viaPayload = [...Object.values(posts.relations), ...Object.values(tags.relations)].find(
      (r) => r.type === 'manyToMany' && r.through?.table === '_t2b_payload_link',
    );
    assert.equal(viaPayload, undefined, 'payload junction must not yield a manyToMany relation');
    // The ordinary belongsTo/hasMany derived from its FKs must still exist.
    const hasManyToPayload = Object.values(posts.relations).find(
      (r) => r.type === 'hasMany' && r.to === '_t2b_payload_link',
    );
    assert.ok(hasManyToPayload, 'payload junction still has ordinary hasMany relations');
  });

  it('findMany with: { <m2m>: true } returns each post with its tags array', async () => {
    const posts = client.table('_t2b_posts');
    const rel = Object.values(schema.tables._t2b_posts!.relations).find(
      (r) => r.type === 'manyToMany' && r.to === '_t2b_tags',
    )!;
    const rows = (await posts.findMany({
      orderBy: { id: 'asc' } as never,
      with: { [rel.name]: true } as never,
    })) as Array<Record<string, unknown>>;
    assert.equal(rows.length, 2);
    const first = rows.find((r) => r.id === 1)!;
    const firstTags = (first[rel.name] as Array<{ name: string }>).map((t) => t.name).sort();
    assert.deepEqual(firstTags, ['orm', 'sql']);
    const second = rows.find((r) => r.id === 2)!;
    const secondTags = (second[rel.name] as Array<{ name: string }>).map((t) => t.name).sort();
    assert.deepEqual(secondTags, ['orm', 'pg']);
  });

  it('nested where on the m2m target filters tags', async () => {
    const posts = client.table('_t2b_posts');
    const rel = Object.values(schema.tables._t2b_posts!.relations).find(
      (r) => r.type === 'manyToMany' && r.to === '_t2b_tags',
    )!;
    const rows = (await posts.findMany({
      where: { id: 1 } as never,
      with: { [rel.name]: { where: { name: 'sql' } } } as never,
    })) as Array<Record<string, unknown>>;
    const tags = rows[0]![rel.name] as Array<{ name: string }>;
    assert.equal(tags.length, 1);
    assert.equal(tags[0]!.name, 'sql');
  });

  it('nested orderBy + limit on the m2m target applies pre-aggregation', async () => {
    const posts = client.table('_t2b_posts');
    const rel = Object.values(schema.tables._t2b_posts!.relations).find(
      (r) => r.type === 'manyToMany' && r.to === '_t2b_tags',
    )!;
    const rows = (await posts.findMany({
      where: { id: 2 } as never,
      with: { [rel.name]: { orderBy: { name: 'asc' }, limit: 1 } } as never,
    })) as Array<Record<string, unknown>>;
    const tags = rows[0]![rel.name] as Array<{ name: string }>;
    assert.equal(tags.length, 1);
    // post 2 has tags {orm, pg}; asc-ordered first is 'orm'.
    assert.equal(tags[0]!.name, 'orm');
  });
});
