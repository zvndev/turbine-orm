/**
 * turbine-orm/sqlite — in-process integration tests.
 *
 * These run in the normal `test:unit` lane (no DATABASE_URL, no container):
 * a `:memory:` SQLite database is created, seeded, introspected, and exercised
 * end-to-end through the real TurbineClient bound to `sqliteDialect`.
 */

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { TurbineClient } from '../client.js';
import { UnsupportedFeatureError } from '../errors.js';
import type { SchemaMetadata } from '../schema.js';
import { introspectSqliteDatabase, sqliteDialect, turbineSqlite } from '../sqlite.js';

// ---------------------------------------------------------------------------
// SQLite port of src/test/fixtures/seed.sql (+ a tags/post_tags m2m junction).
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE organizations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  plan        TEXT NOT NULL DEFAULT 'free',
  metadata    TEXT,
  created_at  TIMESTAMP NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id        INTEGER NOT NULL REFERENCES organizations(id),
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member',
  avatar_url    TEXT,
  last_login_at TIMESTAMP,
  created_at    TIMESTAMP NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_users_org_id ON users(org_id);

CREATE TABLE posts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  org_id      INTEGER NOT NULL REFERENCES organizations(id),
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  published   INTEGER NOT NULL DEFAULT 0,
  view_count  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMP NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_posts_user_id ON posts(user_id);

CREATE TABLE comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id     INTEGER NOT NULL REFERENCES posts(id),
  user_id     INTEGER NOT NULL REFERENCES users(id),
  body        TEXT NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_comments_post_id ON comments(post_id);

CREATE TABLE tags (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE post_tags (
  post_id INTEGER NOT NULL REFERENCES posts(id),
  tag_id  INTEGER NOT NULL REFERENCES tags(id),
  PRIMARY KEY (post_id, tag_id)
);
`;

const SEED_SQL = `
INSERT INTO organizations (id, name, slug, plan, metadata) VALUES
  (1, 'Acme Inc', 'acme', 'enterprise', '{"tier":"enterprise"}'),
  (2, 'Beta LLC', 'beta', 'pro', '{"tier":"pro"}');

INSERT INTO users (id, org_id, email, name, role, avatar_url) VALUES
  (1, 1, 'user1@example.com', 'Alice Admin',  'admin',  'https://a/1.png'),
  (2, 1, 'user2@example.com', 'Bob Editor',   'editor', 'https://a/2.png'),
  (3, 1, 'user3@example.com', 'Carol Member', 'member', NULL),
  (4, 2, 'user4@example.com', 'Dave Admin',   'admin',  NULL);

INSERT INTO posts (id, user_id, org_id, title, content, published, view_count) VALUES
  (1, 1, 1, 'Hello World',  'First post body', 1, 100),
  (2, 1, 1, 'Second Post',  'More content',    1, 75),
  (3, 1, 1, 'Draft Post',   'Not ready',       0, 0),
  (4, 2, 1, 'Editor Post',  'By the editor',   1, 42),
  (5, 4, 2, 'Org 2 Post',   'Across orgs',     1, 60);

INSERT INTO comments (post_id, user_id, body) VALUES
  (1, 2, 'Nice post!'),
  (1, 3, 'I agree'),
  (2, 2, 'Solid follow up'),
  (4, 1, 'Approved by admin');

INSERT INTO tags (id, name) VALUES (1, 'tech'), (2, 'news'), (3, 'draft');

INSERT INTO post_tags (post_id, tag_id) VALUES
  (1, 1), (1, 2), (2, 1), (3, 3);
`;

interface UserRow {
  id: number;
  orgId: number;
  email: string;
  name: string;
  role: string;
  avatarUrl: string | null;
  posts?: PostRow[];
}
interface PostRow {
  id: number;
  userId: number;
  orgId: number;
  title: string;
  content: string;
  published: number;
  viewCount: number;
  user?: UserRow;
  comments?: CommentRow[];
  tags?: TagRow[];
}
interface CommentRow {
  id: number;
  postId: number;
  userId: number;
  body: string;
  user?: UserRow;
}
interface TagRow {
  id: number;
  name: string;
}

// ---------------------------------------------------------------------------

let db: DatabaseSync;
let schema: SchemaMetadata;
let client: TurbineClient;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  db.exec(SEED_SQL);
  // Dogfood the introspector: build the runtime schema from the live DB.
  schema = introspectSqliteDatabase(db);
  client = turbineSqlite(db, schema);
});

afterEach(async () => {
  await client.disconnect();
});

describe('turbine-orm/sqlite — introspection', () => {
  it('discovers all tables, columns, and primary keys via PRAGMA', () => {
    assert.deepEqual(
      Object.keys(schema.tables).sort(),
      ['comments', 'organizations', 'post_tags', 'posts', 'tags', 'users'].sort(),
    );
    assert.deepEqual(schema.tables.users!.primaryKey, ['id']);
    assert.deepEqual(schema.tables.post_tags!.primaryKey, ['post_id', 'tag_id']);
    // snake → camel field mapping
    assert.equal(schema.tables.users!.reverseColumnMap.org_id, 'orgId');
    // date columns detected from declared TIMESTAMP affinity
    assert.ok(schema.tables.users!.dateColumns.has('created_at'));
  });

  it('derives belongsTo + hasMany relations from foreign keys', () => {
    const userRels = schema.tables.users!.relations;
    assert.equal(userRels.posts?.type, 'hasMany');
    assert.equal(userRels.organization?.type, 'belongsTo');

    const postRels = schema.tables.posts!.relations;
    assert.equal(postRels.user?.type, 'belongsTo');
    assert.equal(postRels.comments?.type, 'hasMany');
  });

  it('auto-detects the post_tags junction as a manyToMany relation', () => {
    const postTags = schema.tables.posts!.relations.tags;
    assert.equal(postTags?.type, 'manyToMany');
    assert.equal(postTags?.through?.table, 'post_tags');
    assert.equal(postTags?.through?.sourceKey, 'post_id');
    assert.equal(postTags?.through?.targetKey, 'tag_id');
    assert.equal(schema.tables.tags!.relations.posts?.type, 'manyToMany');
  });

  it('records unique constraints and indexes', () => {
    assert.ok(schema.tables.users!.uniqueColumns.some((cols) => cols.length === 1 && cols[0] === 'email'));
    assert.ok(schema.tables.users!.indexes.some((i) => i.name === 'idx_users_org_id'));
  });
});

describe('turbine-orm/sqlite — findMany / where / orderBy / limit / cursor', () => {
  it('findMany with equality + ordering + limit', async () => {
    const admins = await client
      .table<UserRow>('users')
      .findMany({ where: { role: 'admin' }, orderBy: { id: 'asc' }, limit: 10 });
    assert.deepEqual(
      admins.map((u) => u.id),
      [1, 4],
    );
    assert.equal(admins[0]!.name, 'Alice Admin');
  });

  it('comparison + IN operators', async () => {
    const hot = await client.table<PostRow>('posts').findMany({ where: { viewCount: { gt: 50 } } });
    assert.deepEqual(hot.map((p) => p.id).sort(), [1, 2, 5]);

    const staff = await client
      .table<UserRow>('users')
      .findMany({ where: { role: { in: ['admin', 'editor'] } }, orderBy: { id: 'asc' } });
    assert.deepEqual(
      staff.map((u) => u.role),
      ['admin', 'editor', 'admin'],
    );
  });

  it('case-insensitive contains (COLLATE NOCASE)', async () => {
    const found = await client
      .table<UserRow>('users')
      .findMany({ where: { name: { contains: 'alice', mode: 'insensitive' } } });
    assert.equal(found.length, 1);
    assert.equal(found[0]!.id, 1);
  });

  it('keyset cursor pagination', async () => {
    const page = await client.table<PostRow>('posts').findMany({ orderBy: { id: 'asc' }, cursor: { id: 2 }, take: 2 });
    assert.deepEqual(
      page.map((p) => p.id),
      [3, 4],
    );
  });

  it('findUnique returns one row or null', async () => {
    const u = await client.table<UserRow>('users').findUnique({ where: { id: 3 } });
    assert.equal(u?.name, 'Carol Member');
    assert.equal(u?.avatarUrl, null);
    const missing = await client.table<UserRow>('users').findUnique({ where: { id: 999 } });
    assert.equal(missing, null);
  });
});

describe('turbine-orm/sqlite — nested with (json() wrap proves real parsed tree)', () => {
  it('hasMany → hasMany → belongsTo: deep tree is objects, not strings', async () => {
    const users = await client.table<UserRow>('users').findMany({
      where: { id: 1 },
      with: { posts: { with: { comments: { with: { user: true } } } } },
    });
    const alice = users[0]!;

    // posts is a REAL array of REAL objects (not a JSON string-of-string).
    assert.ok(Array.isArray(alice.posts));
    assert.equal(alice.posts!.length, 3);
    const post = alice.posts!.find((p) => p.id === 1)!;
    assert.equal(typeof post, 'object');
    assert.equal(typeof post.title, 'string');
    assert.equal(post.title, 'Hello World');

    // Second level: comments nested under each post.
    assert.ok(Array.isArray(post.comments));
    assert.equal(post.comments!.length, 2);
    const comment = post.comments![0]!;
    assert.equal(typeof comment, 'object');
    assert.equal(typeof comment.body, 'string');

    // Third level: belongsTo user nested under each comment — a real object.
    assert.equal(typeof comment.user, 'object');
    assert.equal(typeof comment.user!.email, 'string');

    // Guard against double-encoding: the whole subtree must JSON round-trip
    // with the SAME shape (no embedded strings-of-JSON anywhere).
    const reparsed = JSON.parse(JSON.stringify(alice));
    assert.equal(typeof reparsed.posts[0].title, 'string');
    assert.equal(typeof reparsed.posts[0].comments[0].body, 'string');
  });

  it('belongsTo: posts → user is a single nested object (LIMIT 1)', async () => {
    const posts = await client.table<PostRow>('posts').findMany({ where: { id: 4 }, with: { user: true } });
    assert.equal(posts[0]!.user!.name, 'Bob Editor');
    assert.ok(!Array.isArray(posts[0]!.user));
  });

  it('manyToMany: posts → tags through the junction table', async () => {
    const posts = await client.table<PostRow>('posts').findMany({ where: { id: 1 }, with: { tags: true } });
    const tagNames = posts[0]!.tags!.map((t) => t.name).sort();
    assert.deepEqual(tagNames, ['news', 'tech']);
  });

  it('ordered + limited to-many uses the inner-subquery rewrite', async () => {
    const users = await client.table<UserRow>('users').findMany({
      where: { id: 1 },
      with: { posts: { orderBy: { viewCount: 'desc' }, limit: 2 } },
    });
    assert.deepEqual(
      users[0]!.posts!.map((p) => p.viewCount),
      [100, 75],
    );
  });
});

describe('turbine-orm/sqlite — writes return real rows (RETURNING)', () => {
  it('create returns the inserted row with a generated id', async () => {
    const created = await client.table<UserRow>('users').create({
      data: { orgId: 2, email: 'new@example.com', name: 'New User', role: 'member' },
    });
    assert.equal(typeof created.id, 'number');
    assert.equal(created.email, 'new@example.com');
    assert.equal(created.role, 'member');
  });

  it('createMany inserts multiple rows (multi-row VALUES, no UNNEST)', async () => {
    const rows = await client.table<TagRow>('tags').createMany({
      data: [{ name: 'alpha' }, { name: 'beta' }],
    });
    assert.equal(rows.length, 2);
    const all = await client.table<TagRow>('tags').findMany({ where: { name: { in: ['alpha', 'beta'] } } });
    assert.equal(all.length, 2);
  });

  it('upsert inserts then updates on conflict', async () => {
    const inserted = await client.table<TagRow>('tags').upsert({
      where: { id: 1 },
      create: { id: 1, name: 'tech' },
      update: { name: 'technology' },
    });
    assert.equal(inserted.name, 'technology'); // id 1 already exists → update path
  });

  it('update returns the updated row (boolean param coerces to 0/1)', async () => {
    // Untyped accessor so a JS boolean reaches the driver; SQLite has no boolean
    // type, so the shim binds true→1 and the row stores/returns 1.
    const updated = (await client
      .table('posts')
      .update({ where: { id: 3 }, data: { published: true, viewCount: 5 } })) as unknown as PostRow;
    assert.equal(updated.id, 3);
    assert.equal(updated.published, 1);
    assert.equal(updated.viewCount, 5);
  });

  it('updateMany / deleteMany return affected counts', async () => {
    const upd = await client.table<PostRow>('posts').updateMany({ where: { orgId: 1 }, data: { viewCount: 0 } });
    assert.equal(upd.count, 4);
    const del = await client.table<CommentRow>('comments').deleteMany({ where: { postId: 1 } });
    assert.equal(del.count, 2);
  });

  it('delete returns the removed row', async () => {
    // Use an unreferenced tag (FK enforcement, PRAGMA foreign_keys=ON, blocks
    // deleting tags 1-3 which post_tags references).
    const tmp = await client.table<TagRow>('tags').create({ data: { name: 'temp-del' } });
    const removed = await client.table<TagRow>('tags').delete({ where: { id: tmp.id } });
    assert.equal(removed.name, 'temp-del');
    const after = await client.table<TagRow>('tags').findUnique({ where: { id: tmp.id } });
    assert.equal(after, null);
  });
});

describe('turbine-orm/sqlite — count + aggregate (castAggregate hook)', () => {
  it('count returns a number (CAST not ::int)', async () => {
    // Untyped accessor: boolean where-value coerces to 1 in the driver.
    const n = await client.table('posts').count({ where: { published: true } });
    assert.equal(n, 4);
  });

  it('aggregate computes count/sum/avg/min/max', async () => {
    const agg = await client.table<PostRow>('posts').aggregate({
      _count: true,
      _sum: { viewCount: true },
      _avg: { viewCount: true },
      _max: { viewCount: true },
    });
    assert.equal(agg._count, 5);
    assert.equal(agg._sum?.viewCount, 277);
    assert.equal(agg._max?.viewCount, 100);
    assert.ok(typeof agg._avg?.viewCount === 'number');
  });

  it('groupBy aggregates per group', async () => {
    const groups = await client.table<PostRow>('posts').groupBy({
      by: ['userId'],
      _count: true,
      orderBy: { userId: 'asc' },
    });
    const u1 = groups.find((g) => (g as { userId: number }).userId === 1)!;
    assert.equal((u1 as { _count: number })._count, 3);
  });
});

describe('turbine-orm/sqlite — transactions + savepoints', () => {
  it('commits a successful $transaction', async () => {
    await client.$transaction(async (tx) => {
      await tx.table<TagRow>('tags').create({ data: { name: 'committed' } });
    });
    const found = await client.table<TagRow>('tags').findMany({ where: { name: 'committed' } });
    assert.equal(found.length, 1);
  });

  it('rolls the whole $transaction back on throw', async () => {
    await assert.rejects(
      client.$transaction(async (tx) => {
        await tx.table<TagRow>('tags').create({ data: { name: 'rolled-back' } });
        throw new Error('boom');
      }),
      /boom/,
    );
    const found = await client.table<TagRow>('tags').findMany({ where: { name: 'rolled-back' } });
    assert.equal(found.length, 0);
  });

  it('nested savepoint rolls back inner without losing outer', async () => {
    await client.$transaction(async (tx) => {
      await tx.table<TagRow>('tags').create({ data: { name: 'outer' } });
      await tx
        .$transaction(async (inner) => {
          await inner.table<TagRow>('tags').create({ data: { name: 'inner' } });
          throw new Error('inner-fail');
        })
        .catch(() => {
          /* swallow — only the SAVEPOINT should roll back */
        });
    });
    const outer = await client.table<TagRow>('tags').findMany({ where: { name: 'outer' } });
    const inner = await client.table<TagRow>('tags').findMany({ where: { name: 'inner' } });
    assert.equal(outer.length, 1, 'outer insert survives');
    assert.equal(inner.length, 0, 'inner insert was rolled back to the savepoint');
  });
});

describe('turbine-orm/sqlite — unsupported features throw UnsupportedFeatureError', () => {
  it('pgvector distance ops throw', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: exercising the vector orderBy surface
    const vectorArgs: any = { orderBy: { viewCount: { distance: { to: [1, 2, 3], metric: 'l2' } } } };
    await assert.rejects(
      client.table<PostRow>('posts').findMany(vectorArgs),
      (err: unknown) =>
        err instanceof UnsupportedFeatureError && /unsupported on "sqlite"/.test((err as Error).message),
    );
  });

  it('$listen / $notify throw (no LISTEN/NOTIFY)', async () => {
    await assert.rejects(
      client.$listen('ch', () => {}),
      UnsupportedFeatureError,
    );
    await assert.rejects(client.$notify('ch', 'x'), UnsupportedFeatureError);
  });

  it('sessionContext (RLS) throws', async () => {
    await assert.rejects(
      client.$transaction(async () => {}, { sessionContext: { 'app.tenant': '1' } }),
      UnsupportedFeatureError,
    );
  });

  it('capability flags report the SQLite feature set', () => {
    assert.equal(sqliteDialect.supportsVector, false);
    assert.equal(sqliteDialect.supportsListenNotify, false);
    assert.equal(sqliteDialect.supportsRLS, false);
    assert.equal(sqliteDialect.supportsAdvisoryLock, false);
    assert.equal(sqliteDialect.supportsReturning, true);
    assert.equal(sqliteDialect.resultStrategy, 'returning');
  });
});

describe('turbine-orm/sqlite — constraint errors map to typed Turbine errors', () => {
  it('UNIQUE violation surfaces a typed error (E008)', async () => {
    await assert.rejects(
      client.table<UserRow>('users').create({ data: { orgId: 1, email: 'user1@example.com', name: 'Dup' } }),
      (err: unknown) => (err as { code?: string }).code === 'TURBINE_E008',
    );
  });
});
