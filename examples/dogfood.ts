/**
 * turbine-orm — dogfood demo
 *
 * Exercises every feature shipped in the v0.18 line end-to-end against a real
 * Postgres, so you can SEE them work (not just read tests):
 *
 *   - nested relations in one query (baseline / regression check)
 *   - many-to-many through a junction table  (auto-detected)
 *   - self-relations (authors.mentor_id -> authors)
 *   - groupBy + HAVING
 *   - typed raw SQL  (db.sql<T>, .one(), .scalar())
 *   - RLS session-context  ($transaction sessionContext / $withSession)
 *   - LISTEN/NOTIFY realtime  ($listen / $notify)
 *   - pgvector KNN  (skipped automatically if the extension isn't installed)
 *
 * Run:
 *   export DATABASE_URL="postgres://<you>@localhost:5432/turbine_demo"
 *   npx tsx examples/dogfood.ts
 *
 * It is idempotent: it (re)creates a small demo schema each run. Imports come
 * from ../src so you're exercising the working tree.
 */

import assert from 'node:assert/strict';
import pg from 'pg';
import { introspect } from '../src/introspect.js';
import { TurbineClient } from '../src/client.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://macbookpro-kirby@localhost:5432/turbine_demo';

const ok = (label: string, detail = '') => console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
const skip = (label: string, why: string) => console.log(`  \x1b[33m- ${label} — skipped (${why})\x1b[0m`);
const head = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);

async function setupSchema(): Promise<boolean> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  let hasVector = false;
  try {
    await c.query('DROP TABLE IF EXISTS posts_tags, posts, tags, authors CASCADE');
    // Self-relation: authors.mentor_id -> authors.id
    await c.query(`CREATE TABLE authors (
      id serial PRIMARY KEY,
      name text NOT NULL,
      tenant text NOT NULL,
      mentor_id int REFERENCES authors(id)
    )`);
    await c.query(`CREATE TABLE posts (
      id serial PRIMARY KEY,
      author_id int NOT NULL REFERENCES authors(id),
      title text NOT NULL,
      published boolean NOT NULL DEFAULT false,
      view_count int NOT NULL DEFAULT 0
    )`);
    await c.query(`CREATE TABLE tags (id serial PRIMARY KEY, name text NOT NULL)`);
    // Pure junction -> auto-detected as many-to-many on both posts and tags
    await c.query(`CREATE TABLE posts_tags (
      post_id int NOT NULL REFERENCES posts(id),
      tag_id  int NOT NULL REFERENCES tags(id),
      PRIMARY KEY (post_id, tag_id)
    )`);

    // Seed: 3 authors (Ada mentors Bob & Cleo), posts, tags, m2m links
    await c.query(`INSERT INTO authors (id, name, tenant, mentor_id) OVERRIDING SYSTEM VALUE VALUES
      (1,'Ada','acme',NULL), (2,'Bob','acme',1), (3,'Cleo','globex',1)`);
    await c.query(`SELECT setval('authors_id_seq', 3)`);
    await c.query(`INSERT INTO posts (id, author_id, title, published, view_count) OVERRIDING SYSTEM VALUE VALUES
      (1,1,'Intro to Turbine', true, 120),
      (2,1,'json_agg deep dive', true, 80),
      (3,1,'Draft notes', false, 0),
      (4,2,'Bob first post', true, 45),
      (5,3,'Cleo on Globex', true, 60)`);
    await c.query(`SELECT setval('posts_id_seq', 5)`);
    await c.query(`INSERT INTO tags (id, name) OVERRIDING SYSTEM VALUE VALUES (1,'orm'),(2,'sql'),(3,'postgres')`);
    await c.query(`SELECT setval('tags_id_seq', 3)`);
    await c.query(`INSERT INTO posts_tags (post_id, tag_id) VALUES
      (1,1),(1,2),(1,3), (2,1),(2,2), (4,1), (5,3)`);

    try {
      await c.query('CREATE EXTENSION IF NOT EXISTS vector');
      await c.query('DROP TABLE IF EXISTS items');
      await c.query('CREATE TABLE items (id serial PRIMARY KEY, label text, embedding vector(3))');
      await c.query(`INSERT INTO items (label, embedding) VALUES
        ('a','[1,0,0]'),('b','[0,1,0]'),('c','[0.9,0.1,0]'),('d','[0,0,1]')`);
      hasVector = true;
    } catch {
      /* pgvector not installed — demo will skip the vector section */
    }
  } finally {
    await c.end();
  }
  return hasVector;
}

async function main() {
  console.log('\x1b[1m\x1b[36mturbine-orm dogfood demo\x1b[0m  →', DATABASE_URL.replace(/:\/\/[^@]*@/, '://***@'));
  const hasVector = await setupSchema();

  const schema = await introspect({ connectionString: DATABASE_URL });
  const db = new TurbineClient({ connectionString: DATABASE_URL, poolSize: 4 }, schema);
  await db.connect();

  try {
    // ---- Baseline: nested relations in ONE query (regression check) ----------
    head('1. Nested relations (single json_agg query)');
    const authors = await db.table('authors').findMany({
      with: { posts: { with: { tags: true }, orderBy: { id: 'asc' } } },
      orderBy: { id: 'asc' },
    });
    const ada = authors.find((a: any) => a.name === 'Ada') as any;
    assert.equal(ada.posts.length, 3);
    assert.ok(Array.isArray(ada.posts[0].tags));
    ok('authors -> posts -> tags nested', `Ada has ${ada.posts.length} posts, first post has ${ada.posts[0].tags.length} tags`);

    // ---- Many-to-many (auto-detected junction) -------------------------------
    head('2. Many-to-many through junction (auto-detected)');
    const posts = await db.table('posts').findMany({ with: { tags: true }, orderBy: { id: 'asc' } });
    const introPost = posts.find((p: any) => p.title === 'Intro to Turbine') as any;
    assert.equal(introPost.tags.length, 3);
    const tagNames = introPost.tags.map((t: any) => t.name).sort();
    assert.deepEqual(tagNames, ['orm', 'postgres', 'sql']);
    ok('posts.with({ tags: true })', `"Intro to Turbine" -> [${tagNames.join(', ')}]`);
    // reverse direction also auto-detected
    const tags = await db.table('tags').findMany({ with: { posts: true }, where: { name: 'orm' } });
    ok('tags.with({ posts: true })', `tag "orm" is on ${(tags[0] as any).posts.length} posts`);

    // ---- Self-relation -------------------------------------------------------
    head('3. Self-relations (authors.mentor_id -> authors)');
    // singular belongsTo = "author", hasMany = "authors" (auto-named)
    const mentees = await db.table('authors').findMany({ with: { authors: true }, where: { name: 'Ada' } });
    const adaMentees = (mentees[0] as any).authors.map((m: any) => m.name).sort();
    assert.deepEqual(adaMentees, ['Bob', 'Cleo']);
    ok('Ada -> mentees', `[${adaMentees.join(', ')}]`);
    const withMentor = await db.table('authors').findMany({ with: { author: true }, where: { name: 'Bob' } });
    ok('Bob -> mentor', (withMentor[0] as any).author?.name);

    // ---- groupBy + HAVING ----------------------------------------------------
    head('4. groupBy + HAVING');
    const prolific = (await db.table('posts').groupBy({
      by: ['authorId'],
      _count: true,
      having: { _count: { gt: 1 } },
    })) as any[];
    ok('authors with > 1 post', `authorId(s): ${prolific.map((r) => `${r.authorId}(${r._count})`).join(', ')}`);
    const highViews = (await db.table('posts').groupBy({
      by: ['authorId'],
      where: { published: true },
      _sum: { viewCount: true },
      having: { viewCount: { _sum: { gte: 100 } } },
    })) as any[];
    ok('authors with >=100 published views', `${highViews.length} group(s)`);

    // ---- Typed raw SQL -------------------------------------------------------
    head('5. Typed raw SQL (db.sql<T>)');
    const rows = await db.sql<{ id: number; name: string }>`SELECT id, name FROM authors ORDER BY id`;
    assert.equal(rows.length, 3);
    ok('await db.sql<T>`...`', `${rows.length} rows, rows[0].name = ${rows[0]!.name}`);
    const one = await db.sql<{ name: string }>`SELECT name FROM authors WHERE id = ${2}`.one();
    ok('.one()', one?.name);
    const total = await db.sql<{ n: number }>`SELECT COUNT(*)::int AS n FROM posts`.scalar<number>();
    ok('.scalar<number>()', `${total} posts`);
    // injection is data, not code:
    const evil = "x'; DROP TABLE authors; --";
    const none = await db.sql<{ id: number }>`SELECT id FROM authors WHERE name = ${evil}`;
    assert.equal(none.length, 0);
    const stillThere = await db.sql<{ n: number }>`SELECT COUNT(*)::int AS n FROM authors`.scalar<number>();
    assert.equal(stillThere, 3);
    ok('injection payload bound as param', 'authors table intact, 0 matches');

    // ---- RLS session-context -------------------------------------------------
    head('6. RLS session-context ($transaction / $withSession)');
    const seen = await db.$transaction(
      async (tx) => {
        const r = await tx.raw<{ v: string }>`SELECT current_setting('app.current_tenant') AS v`;
        return r[0]!.v;
      },
      { sessionContext: { 'app.current_tenant': 'acme' } },
    );
    assert.equal(seen, 'acme');
    ok('sessionContext sets txn-local GUC', `current_setting('app.current_tenant') = "${seen}" inside txn`);
    const viaWith = await db.$withSession({ 'app.current_tenant': 'globex' }, async (tx) => {
      const r = await tx.raw<{ v: string }>`SELECT current_setting('app.current_tenant') AS v`;
      return r[0]!.v;
    });
    ok('$withSession shorthand', `= "${viaWith}"`);
    // GUC is gone outside the transaction (txn-local)
    const after = await db.raw<{ v: string }>`SELECT current_setting('app.current_tenant', true) AS v`;
    assert.ok(!after[0]!.v);
    ok('GUC auto-resets after txn', 'empty outside the transaction');

    // ---- LISTEN / NOTIFY -----------------------------------------------------
    head('7. LISTEN / NOTIFY realtime');
    const got = new Promise<string>((resolve) => {
      db.$listen('demo_chan', (payload) => resolve(payload)).then((sub) => {
        // notify after the listener is established
        db.$notify('demo_chan', 'hello from turbine').then(() => {
          // auto-unsubscribe shortly after
          setTimeout(() => sub.unsubscribe(), 250);
        });
      });
    });
    const payload = await Promise.race([
      got,
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
    ]);
    assert.equal(payload, 'hello from turbine');
    ok('$listen + $notify', `handler received "${payload}"`);

    // ---- pgvector ------------------------------------------------------------
    head('8. pgvector KNN');
    if (hasVector) {
      const near = await db.table('items').findMany({
        orderBy: { embedding: { distance: { to: [1, 0, 0], metric: 'cosine' } } },
        limit: 2,
      });
      ok('KNN orderBy by cosine distance', `nearest to [1,0,0]: ${near.map((i: any) => i.label).join(', ')}`);
    } else {
      skip('pgvector KNN', 'vector extension not installed in this database');
    }

    head('All sections passed ✅');
  } finally {
    await db.disconnect();
  }
}

main().catch((e) => {
  console.error('\n\x1b[31mDEMO FAILED:\x1b[0m', e);
  process.exitCode = 1;
});
