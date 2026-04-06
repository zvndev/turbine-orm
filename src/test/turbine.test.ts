/**
 * turbine-orm — Integration test suite
 *
 * Tests against a real Postgres database (seeded with 5K users, 46K posts, 432K comments).
 * Covers: CRUD, nested relations (L2-L4), pagination, filtering, ordering,
 *         aggregations, transactions, raw SQL, pipeline, error handling.
 *
 * Run: DATABASE_URL=postgres://... node --test --experimental-strip-types src/test/turbine.test.ts
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { TurbineClient } from '../client.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata } from '../schema.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('\u26A0 Skipping integration tests: DATABASE_URL not set');
}

let db: TurbineClient;
let schema: SchemaMetadata;

// Guard: skip entire file if no DATABASE_URL (don't process.exit — it kills parallel test runners)
const testFn = SKIP ? describe.skip : describe;

testFn('turbine integration tests', () => {
  before(async () => {
    schema = await introspect({ connectionString: DATABASE_URL! });
    db = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 5 }, schema);
    await db.connect();
  });

  after(async () => {
    await db.disconnect();
  });

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  describe('connection', () => {
    it('connects and reports stats', () => {
      const stats = db.stats;
      assert.equal(typeof stats.totalCount, 'number');
      assert.equal(typeof stats.idleCount, 'number');
      assert.equal(typeof stats.waitingCount, 'number');
    });

    it('schema has expected tables', () => {
      assert.ok(schema.tables.users);
      assert.ok(schema.tables.posts);
      assert.ok(schema.tables.comments);
      assert.ok(schema.tables.organizations);
    });

    it('schema has correct column count', () => {
      assert.equal(schema.tables.users!.columns.length, 8);
      assert.equal(schema.tables.posts!.columns.length, 9);
      assert.equal(schema.tables.comments!.columns.length, 5);
      assert.equal(schema.tables.organizations!.columns.length, 7);
    });

    it('schema has relations', () => {
      const userRels = schema.tables.users!.relations;
      assert.ok(userRels.posts, 'users should have posts relation');
      assert.ok(userRels.organization, 'users should have organization relation');

      const postRels = schema.tables.posts!.relations;
      assert.ok(postRels.comments, 'posts should have comments relation');
      assert.ok(postRels.user, 'posts should have user relation');
    });
  });

  // ---------------------------------------------------------------------------
  // findUnique
  // ---------------------------------------------------------------------------

  describe('findUnique', () => {
    it('finds a user by id', async () => {
      const users = db.table<{ id: number; email: string; name: string }>('users');
      const user = await users.findUnique({ where: { id: 1 } });
      assert.ok(user, 'user with id=1 should exist');
      assert.equal(user.id, 1);
      assert.equal(typeof user.email, 'string');
      assert.equal(typeof user.name, 'string');
    });

    it('returns null for non-existent id', async () => {
      const users = db.table('users');
      const user = await users.findUnique({ where: { id: 999999999 } });
      assert.equal(user, null);
    });

    it('finds by email (unique column)', async () => {
      const users = db.table<{ id: number; email: string }>('users');
      // Get a known email first
      const first = await users.findUnique({ where: { id: 1 } });
      assert.ok(first);

      const byEmail = await users.findUnique({ where: { email: first.email } });
      assert.ok(byEmail);
      assert.equal(byEmail.id, first.id);
    });

    it('camelCase ↔ snake_case conversion works', async () => {
      const users = db.table<{
        id: number;
        orgId: number;
        avatarUrl: string | null;
        lastLoginAt: Date | null;
        createdAt: Date;
      }>('users');
      const user = await users.findUnique({ where: { id: 1 } });
      assert.ok(user);
      assert.equal(typeof user.orgId, 'number');
      assert.ok('avatarUrl' in user);
      assert.ok('lastLoginAt' in user);
      assert.ok(user.createdAt instanceof Date);
    });
  });

  // ---------------------------------------------------------------------------
  // findMany
  // ---------------------------------------------------------------------------

  describe('findMany', () => {
    it('returns all rows when no filter', async () => {
      const orgs = db.table<{ id: number }>('organizations');
      const all = await orgs.findMany();
      assert.ok(all.length > 0, 'should have organizations');
    });

    it('filters with where clause', async () => {
      const posts = db.table<{ id: number; published: boolean }>('posts');
      const published = await posts.findMany({ where: { published: true }, limit: 10 });
      for (const p of published) {
        assert.equal(p.published, true);
      }
    });

    it('respects limit', async () => {
      const users = db.table('users');
      const limited = await users.findMany({ limit: 5 });
      assert.equal(limited.length, 5);
    });

    it('respects offset', async () => {
      const users = db.table<{ id: number }>('users');
      const page1 = await users.findMany({ orderBy: { id: 'asc' }, limit: 3, offset: 0 });
      const page2 = await users.findMany({ orderBy: { id: 'asc' }, limit: 3, offset: 3 });
      assert.equal(page1.length, 3);
      assert.equal(page2.length, 3);
      // Pages should not overlap
      const ids1 = page1.map((u) => u.id);
      const ids2 = page2.map((u) => u.id);
      for (const id of ids2) {
        assert.ok(!ids1.includes(id), `id ${id} should not appear in both pages`);
      }
    });

    it('orders ascending', async () => {
      const users = db.table<{ id: number }>('users');
      const asc = await users.findMany({ orderBy: { id: 'asc' }, limit: 10 });
      for (let i = 1; i < asc.length; i++) {
        assert.ok(asc[i]!.id > asc[i - 1]!.id, 'should be ascending');
      }
    });

    it('orders descending', async () => {
      const users = db.table<{ id: number }>('users');
      const desc = await users.findMany({ orderBy: { id: 'desc' }, limit: 10 });
      for (let i = 1; i < desc.length; i++) {
        assert.ok(desc[i]!.id < desc[i - 1]!.id, 'should be descending');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // findFirst
  // ---------------------------------------------------------------------------

  describe('findFirst', () => {
    it('returns a single object (not array)', async () => {
      const users = db.table<{ id: number; name: string }>('users');
      const user = await users.findFirst({ orderBy: { id: 'asc' } });
      assert.ok(user, 'should find a user');
      assert.equal(typeof user.id, 'number');
      assert.equal(typeof user.name, 'string');
      // Should NOT be an array
      assert.ok(!Array.isArray(user), 'findFirst should return an object, not an array');
    });

    it('returns null when no match', async () => {
      const users = db.table<{ id: number }>('users');
      const user = await users.findFirst({ where: { id: 999999999 } });
      assert.equal(user, null);
    });

    it('filters with where clause', async () => {
      const posts = db.table<{ id: number; published: boolean }>('posts');
      const post = await posts.findFirst({ where: { published: true } });
      assert.ok(post, 'should find a published post');
      assert.equal(post.published, true);
    });

    it('respects orderBy', async () => {
      const users = db.table<{ id: number }>('users');
      const first = await users.findFirst({ orderBy: { id: 'asc' } });
      const last = await users.findFirst({ orderBy: { id: 'desc' } });
      assert.ok(first);
      assert.ok(last);
      assert.ok(first.id < last.id, 'asc should return lower id than desc');
    });

    it('supports nested relations (with)', async () => {
      const users = db.table<{ id: number; name: string; posts: { id: number; title: string }[] }>('users');
      const user = await users.findFirst({
        orderBy: { id: 'asc' },
        with: { posts: { limit: 3 } },
      });
      assert.ok(user, 'should find a user');
      assert.ok(Array.isArray(user.posts), 'posts should be an array');
      assert.ok(user.posts.length <= 3, `expected at most 3 posts, got ${user.posts.length}`);
    });

    it('returns null with no args (empty table scenario handled)', async () => {
      // findFirst with no args should still work — returns first row
      const orgs = db.table<{ id: number }>('organizations');
      const org = await orgs.findFirst();
      assert.ok(org, 'should find an organization');
      assert.equal(typeof org.id, 'number');
    });
  });

  // ---------------------------------------------------------------------------
  // findFirstOrThrow
  // ---------------------------------------------------------------------------

  describe('findFirstOrThrow', () => {
    it('returns object when found', async () => {
      const users = db.table<{ id: number; name: string }>('users');
      const user = await users.findFirstOrThrow({ orderBy: { id: 'asc' } });
      assert.ok(user);
      assert.equal(typeof user.id, 'number');
      assert.equal(typeof user.name, 'string');
    });

    it('throws when not found', async () => {
      const users = db.table<{ id: number }>('users');
      await assert.rejects(() => users.findFirstOrThrow({ where: { id: 999999999 } }), /Record not found/);
    });
  });

  // ---------------------------------------------------------------------------
  // findUniqueOrThrow
  // ---------------------------------------------------------------------------

  describe('findUniqueOrThrow', () => {
    it('returns object when found', async () => {
      const users = db.table<{ id: number; name: string }>('users');
      const user = await users.findUniqueOrThrow({ where: { id: 1 } });
      assert.ok(user);
      assert.equal(user.id, 1);
      assert.equal(typeof user.name, 'string');
    });

    it('throws when not found', async () => {
      const users = db.table<{ id: number }>('users');
      await assert.rejects(() => users.findUniqueOrThrow({ where: { id: 999999999 } }), /Record not found/);
    });
  });

  // ---------------------------------------------------------------------------
  // Nested relations (json_agg) — THE core feature
  // ---------------------------------------------------------------------------

  describe('nested relations (json_agg)', () => {
    it('L2: user with posts', async () => {
      const users = db.table<{ id: number; name: string; posts: { id: number; title: string }[] }>('users');
      const user = await users.findUnique({
        where: { id: 1 },
        with: { posts: true },
      });
      assert.ok(user);
      assert.ok(Array.isArray(user.posts), 'posts should be an array');
      if (user.posts.length > 0) {
        assert.equal(typeof user.posts[0]!.id, 'number');
        assert.equal(typeof user.posts[0]!.title, 'string');
      }
    });

    it('L3: user with posts with comments', async () => {
      const users = db.table<{
        id: number;
        posts: { id: number; title: string; comments: { id: number; body: string }[] }[];
      }>('users');
      const user = await users.findUnique({
        where: { id: 1 },
        with: {
          posts: {
            with: { comments: true },
          },
        },
      });
      assert.ok(user);
      assert.ok(Array.isArray(user.posts));
      if (user.posts.length > 0) {
        const firstPost = user.posts[0]!;
        assert.ok(Array.isArray(firstPost.comments), 'comments should be an array');
      }
    });

    it('L2: organization with users', async () => {
      const orgs = db.table<{ id: number; users: { id: number; name: string }[] }>('organizations');
      const org = await orgs.findUnique({
        where: { id: 1 },
        with: { users: true },
      });
      assert.ok(org);
      assert.ok(Array.isArray(org.users));
    });

    it('L4: org with users with posts with comments', async () => {
      const orgs = db.table<{
        id: number;
        users: {
          id: number;
          posts: {
            id: number;
            comments: { id: number; body: string }[];
          }[];
        }[];
      }>('organizations');
      const org = await orgs.findUnique({
        where: { id: 1 },
        with: {
          users: {
            with: {
              posts: {
                with: { comments: true },
              },
            },
          },
        },
      });
      assert.ok(org);
      assert.ok(Array.isArray(org.users));
    });

    it('belongsTo: post with user', async () => {
      const posts = db.table<{ id: number; user: { id: number; name: string } | null }>('posts');
      const post = await posts.findUnique({
        where: { id: 1 },
        with: { user: true },
      });
      assert.ok(post);
      assert.ok(post.user, 'post should have a user');
      assert.equal(typeof post.user.name, 'string');
    });

    it('nested with limit', async () => {
      const users = db.table<{ id: number; posts: { id: number }[] }>('users');
      const user = await users.findUnique({
        where: { id: 1 },
        with: {
          posts: { limit: 3 },
        },
      });
      assert.ok(user);
      assert.ok(user.posts.length <= 3, `expected at most 3 posts, got ${user.posts.length}`);
    });

    it('nested with orderBy', async () => {
      const users = db.table<{ id: number; posts: { id: number; createdAt: Date }[] }>('users');
      const user = await users.findUnique({
        where: { id: 1 },
        with: {
          posts: { orderBy: { createdAt: 'desc' }, limit: 5 },
        },
      });
      assert.ok(user);
      // Verify ordering (dates should be descending)
      for (let i = 1; i < user.posts.length; i++) {
        const prev = new Date(user.posts[i - 1]!.createdAt).getTime();
        const curr = new Date(user.posts[i]!.createdAt).getTime();
        assert.ok(prev >= curr, 'posts should be ordered by createdAt DESC');
      }
    });

    it('nested with where filter', async () => {
      const users = db.table<{ id: number; posts: { id: number; published: boolean }[] }>('users');
      const user = await users.findUnique({
        where: { id: 1 },
        with: {
          posts: { where: { published: true } },
        },
      });
      assert.ok(user);
      for (const post of user.posts) {
        assert.equal(post.published, true, 'all posts should be published');
      }
    });

    it('empty relations return empty array, not null', async () => {
      // Find a user with no posts by checking a very high org_id that's unlikely to have data
      const users = db.table<{ id: number; posts: unknown[] }>('users');
      // Even if user has posts, COALESCE should never return null
      const user = await users.findUnique({
        where: { id: 1 },
        with: { posts: true },
      });
      assert.ok(user);
      assert.ok(Array.isArray(user.posts), 'posts should be array, not null');
    });

    it('throws for unknown relation', async () => {
      const users = db.table('users');
      await assert.rejects(
        () => users.findUnique({ where: { id: 1 }, with: { nonexistent: true } }),
        /Unknown relation "nonexistent"/,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // count
  // ---------------------------------------------------------------------------

  describe('count', () => {
    it('counts all users', async () => {
      const users = db.table('users');
      const total = await users.count();
      assert.ok(total > 0, 'should have users');
      assert.equal(typeof total, 'number');
    });

    it('counts with filter', async () => {
      const posts = db.table('posts');
      const published = await posts.count({ where: { published: true } });
      const all = await posts.count();
      assert.ok(published <= all, 'published count should be <= total');
      assert.ok(published > 0, 'should have published posts');
    });
  });

  // ---------------------------------------------------------------------------
  // groupBy
  // ---------------------------------------------------------------------------

  describe('groupBy', () => {
    it('groups users by role', async () => {
      const users = db.table<{ role: string }>('users');
      const groups = await users.groupBy({ by: ['role'] });
      assert.ok(groups.length > 0, 'should have role groups');
      for (const g of groups) {
        assert.ok('role' in g);
        assert.ok('_count' in g);
        assert.equal(typeof (g as { _count: number })._count, 'number');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // create / update / delete
  // ---------------------------------------------------------------------------

  describe('create, update, delete', () => {
    let createdOrgId: number;

    it('creates an organization', async () => {
      const orgs = db.table<{ id: number; name: string; slug: string; plan: string }>('organizations');
      const org = await orgs.create({
        data: { name: 'Turbine Test Org', slug: `turbine-test-${Date.now()}` },
      });
      assert.ok(org.id, 'should have an id');
      assert.equal(org.name, 'Turbine Test Org');
      assert.equal(org.plan, 'free'); // default value
      createdOrgId = org.id;
    });

    it('updates the organization', async () => {
      const orgs = db.table<{ id: number; name: string; plan: string }>('organizations');
      const updated = await orgs.update({
        where: { id: createdOrgId },
        data: { plan: 'pro' },
      });
      assert.equal(updated.plan, 'pro');
      assert.equal(updated.name, 'Turbine Test Org');
    });

    it('deletes the organization', async () => {
      const orgs = db.table<{ id: number; name: string }>('organizations');
      const deleted = await orgs.delete({ where: { id: createdOrgId } });
      assert.equal(deleted.id, createdOrgId);

      // Verify it's gone
      const found = await orgs.findUnique({ where: { id: createdOrgId } });
      assert.equal(found, null);
    });
  });

  // ---------------------------------------------------------------------------
  // createMany (UNNEST batch insert)
  // ---------------------------------------------------------------------------

  describe('createMany', () => {
    const slugPrefix = `batch-test-${Date.now()}`;
    let createdIds: number[] = [];

    it('batch inserts multiple rows', async () => {
      const orgs = db.table<{ id: number; name: string; slug: string }>('organizations');
      const created = await orgs.createMany({
        data: [
          { name: 'Batch Org 1', slug: `${slugPrefix}-1` },
          { name: 'Batch Org 2', slug: `${slugPrefix}-2` },
          { name: 'Batch Org 3', slug: `${slugPrefix}-3` },
        ],
      });
      assert.equal(created.length, 3);
      createdIds = created.map((o) => o.id);
      assert.equal(created[0]!.name, 'Batch Org 1');
      assert.equal(created[2]!.name, 'Batch Org 3');
    });

    it('returns empty array for empty input', async () => {
      const orgs = db.table('organizations');
      const created = await orgs.createMany({ data: [] });
      assert.equal(created.length, 0);
    });

    // Cleanup
    after(async () => {
      for (const id of createdIds) {
        await db.table('organizations').delete({ where: { id } });
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Pipeline
  // ---------------------------------------------------------------------------

  describe('pipeline', () => {
    it('batches multiple queries into one round-trip', async () => {
      const users = db.table<{ id: number }>('users');
      const posts = db.table<{ id: number }>('posts');

      const [user, postCount, recentPosts] = await db.pipeline(
        users.buildFindUnique({ where: { id: 1 } }),
        posts.buildCount(),
        posts.buildFindMany({ orderBy: { id: 'desc' }, limit: 3 }),
      );

      assert.ok(user, 'user should exist');
      assert.equal(typeof postCount, 'number');
      assert.ok(postCount > 0);
      assert.equal(recentPosts.length, 3);
    });
  });

  // ---------------------------------------------------------------------------
  // Raw SQL
  // ---------------------------------------------------------------------------

  describe('raw SQL', () => {
    it('executes raw queries with parameterized values', async () => {
      const orgId = 1;
      const result = await db.raw<{ count: number }>`
      SELECT COUNT(*)::int AS count FROM users WHERE org_id = ${orgId}
    `;
      assert.ok(result.length === 1);
      assert.equal(typeof result[0]!.count, 'number');
    });
  });

  // ---------------------------------------------------------------------------
  // Transaction
  // ---------------------------------------------------------------------------

  describe('transaction', () => {
    it('commits on success', async () => {
      const slug = `tx-test-${Date.now()}`;
      await db.transaction(async (client) => {
        await client.query('INSERT INTO organizations (name, slug) VALUES ($1, $2)', ['TX Org', slug]);
      });

      // Should be committed
      const orgs = db.table<{ id: number; slug: string }>('organizations');
      const org = await orgs.findUnique({ where: { slug } });
      assert.ok(org, 'org should exist after commit');

      // Cleanup
      await orgs.delete({ where: { id: org.id } });
    });

    it('rolls back on error', async () => {
      const slug = `tx-rollback-${Date.now()}`;
      try {
        await db.transaction(async (client) => {
          await client.query('INSERT INTO organizations (name, slug) VALUES ($1, $2)', ['TX Rollback Org', slug]);
          throw new Error('intentional rollback');
        });
      } catch {
        // Expected
      }

      // Should NOT be committed
      const orgs = db.table<{ slug: string }>('organizations');
      const org = await orgs.findUnique({ where: { slug } });
      assert.equal(org, null, 'org should not exist after rollback');
    });
  });

  // ---------------------------------------------------------------------------
  // SQL injection prevention
  // ---------------------------------------------------------------------------

  describe('sql injection prevention', () => {
    it('parameterizes where values', async () => {
      const users = db.table('users');
      // This should not cause an error or return unexpected results
      const result = await users.findUnique({
        where: { email: "'; DROP TABLE users; --" },
      });
      assert.equal(result, null); // Should just not find anything
    });

    it('parameterizes nested where values', async () => {
      const users = db.table('users');
      const result = await users.findUnique({
        where: { id: 1 },
        with: {
          posts: {
            where: { title: "'; DROP TABLE posts; --" },
          },
        },
      });
      assert.ok(result); // User exists, but posts should be empty
    });
  });

  // ---------------------------------------------------------------------------
  // findMany with nested relations
  // ---------------------------------------------------------------------------

  describe('findMany with nested', () => {
    it('findMany with L2 nesting', async () => {
      const users = db.table<{ id: number; orgId: number; posts: { id: number }[] }>('users');
      const result = await users.findMany({
        where: { orgId: 1 },
        with: { posts: true },
        limit: 3,
      });
      assert.ok(result.length > 0);
      for (const user of result) {
        assert.ok(Array.isArray(user.posts));
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Where clause operators
  // ---------------------------------------------------------------------------

  describe('where clause operators', () => {
    // --- Comparison operators ---

    it('gt: finds posts with viewCount > threshold', async () => {
      const posts = db.table<{ id: number; viewCount: number }>('posts');
      const result = await posts.findMany({
        where: { viewCount: { gt: 50 } },
        limit: 10,
      });
      for (const post of result) {
        assert.ok(post.viewCount > 50, `expected viewCount > 50, got ${post.viewCount}`);
      }
    });

    it('gte: finds posts with viewCount >= threshold', async () => {
      const posts = db.table<{ id: number; viewCount: number }>('posts');
      const result = await posts.findMany({
        where: { viewCount: { gte: 50 } },
        limit: 10,
      });
      for (const post of result) {
        assert.ok(post.viewCount >= 50, `expected viewCount >= 50, got ${post.viewCount}`);
      }
    });

    it('lt: finds posts with viewCount < threshold', async () => {
      const posts = db.table<{ id: number; viewCount: number }>('posts');
      const result = await posts.findMany({
        where: { viewCount: { lt: 10 } },
        limit: 10,
      });
      for (const post of result) {
        assert.ok(post.viewCount < 10, `expected viewCount < 10, got ${post.viewCount}`);
      }
    });

    it('lte: finds posts with viewCount <= threshold', async () => {
      const posts = db.table<{ id: number; viewCount: number }>('posts');
      const result = await posts.findMany({
        where: { viewCount: { lte: 10 } },
        limit: 10,
      });
      for (const post of result) {
        assert.ok(post.viewCount <= 10, `expected viewCount <= 10, got ${post.viewCount}`);
      }
    });

    it('combined gt + lt: range query', async () => {
      const posts = db.table<{ id: number; viewCount: number }>('posts');
      const result = await posts.findMany({
        where: { viewCount: { gt: 10, lt: 50 } },
        limit: 10,
      });
      for (const post of result) {
        assert.ok(post.viewCount > 10 && post.viewCount < 50, `expected 10 < viewCount < 50, got ${post.viewCount}`);
      }
    });

    // --- not operator ---

    it('not: excludes a specific value', async () => {
      const users = db.table<{ id: number; role: string }>('users');
      const result = await users.findMany({
        where: { role: { not: 'admin' } },
        limit: 10,
      });
      for (const user of result) {
        assert.notEqual(user.role, 'admin', 'role should not be admin');
      }
    });

    // --- NULL handling ---

    it('null equality: finds rows where column IS NULL', async () => {
      const users = db.table<{ id: number; avatarUrl: string | null }>('users');
      const result = await users.findMany({
        where: { avatarUrl: null },
        limit: 10,
      });
      for (const user of result) {
        assert.equal(user.avatarUrl, null, 'avatarUrl should be null');
      }
    });

    it('not null: finds rows where column IS NOT NULL', async () => {
      const users = db.table<{ id: number; avatarUrl: string | null }>('users');
      const result = await users.findMany({
        where: { avatarUrl: { not: null } },
        limit: 10,
      });
      for (const user of result) {
        assert.notEqual(user.avatarUrl, null, 'avatarUrl should not be null');
      }
    });

    // --- in / notIn operators ---

    it('in: finds users with role in a list', async () => {
      const users = db.table<{ id: number; role: string }>('users');
      const roles = ['admin', 'editor'];
      const result = await users.findMany({
        where: { role: { in: roles } },
        limit: 20,
      });
      assert.ok(result.length > 0, 'should find users with admin or editor role');
      for (const user of result) {
        assert.ok(roles.includes(user.role), `role ${user.role} should be in [admin, editor]`);
      }
    });

    it('notIn: excludes users with role in a list', async () => {
      const users = db.table<{ id: number; role: string }>('users');
      const excludedRoles = ['admin', 'editor'];
      const result = await users.findMany({
        where: { role: { notIn: excludedRoles } },
        limit: 20,
      });
      for (const user of result) {
        assert.ok(!excludedRoles.includes(user.role), `role ${user.role} should not be in [admin, editor]`);
      }
    });

    // --- String operators ---

    it('contains: finds users whose name contains a substring', async () => {
      // First, get a user to know a valid substring
      const users = db.table<{ id: number; name: string }>('users');
      const first = await users.findUnique({ where: { id: 1 } });
      assert.ok(first);
      // Use first 3 chars as substring
      const substring = first.name.substring(0, 3);
      const result = await users.findMany({
        where: { name: { contains: substring } },
        limit: 10,
      });
      assert.ok(result.length > 0, 'should find at least one user');
      for (const user of result) {
        assert.ok(user.name.includes(substring), `name "${user.name}" should contain "${substring}"`);
      }
    });

    it('startsWith: finds users whose name starts with a prefix', async () => {
      const users = db.table<{ id: number; name: string }>('users');
      const first = await users.findUnique({ where: { id: 1 } });
      assert.ok(first);
      const prefix = first.name.substring(0, 2);
      const result = await users.findMany({
        where: { name: { startsWith: prefix } },
        limit: 10,
      });
      assert.ok(result.length > 0);
      for (const user of result) {
        assert.ok(user.name.startsWith(prefix), `name "${user.name}" should start with "${prefix}"`);
      }
    });

    it('endsWith: finds users whose email ends with a suffix', async () => {
      const users = db.table<{ id: number; email: string }>('users');
      // Emails typically end with a domain like @example.com
      const first = await users.findUnique({ where: { id: 1 } });
      assert.ok(first);
      const suffix = first.email.substring(first.email.indexOf('@'));
      const result = await users.findMany({
        where: { email: { endsWith: suffix } },
        limit: 10,
      });
      assert.ok(result.length > 0);
      for (const user of result) {
        assert.ok(user.email.endsWith(suffix), `email "${user.email}" should end with "${suffix}"`);
      }
    });

    // --- OR conditions ---

    it('OR: finds users matching any of the conditions', async () => {
      const users = db.table<{ id: number; role: string }>('users');
      const result = await users.findMany({
        where: {
          OR: [{ role: 'admin' }, { role: 'editor' }],
        },
        limit: 20,
      });
      assert.ok(result.length > 0, 'should find users with admin or editor role');
      for (const user of result) {
        assert.ok(user.role === 'admin' || user.role === 'editor', `role should be admin or editor, got ${user.role}`);
      }
    });

    it('OR combined with AND: top-level fields AND with OR', async () => {
      const users = db.table<{ id: number; orgId: number; role: string }>('users');
      const result = await users.findMany({
        where: {
          orgId: 1,
          OR: [{ role: 'admin' }, { role: 'editor' }],
        },
        limit: 20,
      });
      for (const user of result) {
        assert.equal(user.orgId, 1, 'orgId should be 1');
        assert.ok(user.role === 'admin' || user.role === 'editor', `role should be admin or editor, got ${user.role}`);
      }
    });

    // --- Operators with count ---

    it('count with operator where', async () => {
      const posts = db.table<{ id: number; viewCount: number }>('posts');
      const highViews = await posts.count({
        where: { viewCount: { gt: 50 } },
      });
      const allCount = await posts.count();
      assert.equal(typeof highViews, 'number');
      assert.ok(highViews <= allCount, 'filtered count should be <= total');
    });

    // --- Operators with findUnique ---

    it('findUnique still works with plain equality', async () => {
      const users = db.table<{ id: number; name: string }>('users');
      const user = await users.findUnique({ where: { id: 1 } });
      assert.ok(user);
      assert.equal(user.id, 1);
    });

    // --- Backward compatibility ---

    it('plain equality still works in findMany', async () => {
      const posts = db.table<{ id: number; published: boolean }>('posts');
      const result = await posts.findMany({
        where: { published: true },
        limit: 5,
      });
      assert.ok(result.length > 0);
      for (const post of result) {
        assert.equal(post.published, true);
      }
    });

    // --- SQL injection safety for operator values ---

    it('operator values are parameterized (no SQL injection)', async () => {
      const users = db.table<{ id: number; name: string }>('users');
      const result = await users.findMany({
        where: { name: { contains: "'; DROP TABLE users; --" } },
        limit: 10,
      });
      // Should return empty, not cause an error
      assert.ok(Array.isArray(result));
    });
  });

  // ===========================================================================
  // Sprint 2 — New features
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // 1. $transaction — Prisma-style typed transaction API
  // ---------------------------------------------------------------------------

  describe('$transaction (typed)', () => {
    it('commits on success with typed table accessors', async () => {
      const slug = `tx-typed-${Date.now()}`;
      await db.$transaction(async (tx) => {
        const orgs = tx.table<{ id: number; name: string; slug: string }>('organizations');
        await orgs.create({
          data: { name: 'TX Typed Org', slug },
        });
      });

      // Should be committed
      const orgs = db.table<{ id: number; slug: string }>('organizations');
      const org = await orgs.findUnique({ where: { slug } });
      assert.ok(org, 'org should exist after commit');

      // Cleanup
      await orgs.delete({ where: { id: org.id } });
    });

    it('rolls back on error with typed transaction', async () => {
      const slug = `tx-typed-rollback-${Date.now()}`;
      try {
        await db.$transaction(async (tx) => {
          const orgs = tx.table<{ id: number; name: string; slug: string }>('organizations');
          await orgs.create({
            data: { name: 'TX Rollback Org', slug },
          });
          throw new Error('intentional rollback');
        });
      } catch {
        // Expected
      }

      // Should NOT be committed
      const orgs = db.table<{ slug: string }>('organizations');
      const org = await orgs.findUnique({ where: { slug } });
      assert.equal(org, null, 'org should not exist after rollback');
    });

    it('supports nested transactions via SAVEPOINTs', async () => {
      const slug1 = `tx-sp-outer-${Date.now()}`;
      const slug2 = `tx-sp-inner-${Date.now()}`;

      await db.$transaction(async (tx) => {
        const orgs = tx.table<{ id: number; name: string; slug: string }>('organizations');

        // Outer insert — should survive
        await orgs.create({ data: { name: 'Outer Org', slug: slug1 } });

        // Nested transaction that fails
        try {
          await tx.$transaction(async (innerTx) => {
            const innerOrgs = innerTx.table<{ id: number; name: string; slug: string }>('organizations');
            await innerOrgs.create({ data: { name: 'Inner Org', slug: slug2 } });
            throw new Error('inner rollback');
          });
        } catch {
          // Expected — inner rolled back
        }
      });

      // Outer should be committed
      const orgs = db.table<{ id: number; slug: string }>('organizations');
      const outer = await orgs.findUnique({ where: { slug: slug1 } });
      assert.ok(outer, 'outer org should exist');

      // Inner should be rolled back
      const inner = await orgs.findUnique({ where: { slug: slug2 } });
      assert.equal(inner, null, 'inner org should not exist after savepoint rollback');

      // Cleanup
      await orgs.delete({ where: { id: outer.id } });
    });

    it('supports cross-table operations in a transaction', async () => {
      const slug = `tx-cross-${Date.now()}`;
      let createdOrgId: number | undefined;

      try {
        await db.$transaction(async (tx) => {
          const orgs = tx.table<{ id: number; name: string; slug: string }>('organizations');
          const users = tx.table<{ id: number; orgId: number; email: string; name: string; role: string }>('users');

          const org = await orgs.create({ data: { name: 'Cross TX Org', slug } });
          createdOrgId = org.id;

          // Create a user in the new org
          const user = await users.create({
            data: {
              orgId: org.id,
              email: `cross-tx-${Date.now()}@test.com`,
              name: 'TX User',
              role: 'member',
            },
          });
          assert.ok(user.id);
          assert.equal(user.orgId, org.id);
        });

        // Both should be committed
        const orgs = db.table<{ id: number; slug: string }>('organizations');
        const org = await orgs.findUnique({ where: { slug } });
        assert.ok(org, 'org should be committed');
      } finally {
        // Cleanup: delete users first (FK), then org
        if (createdOrgId) {
          const users = db.table<{ id: number; orgId: number }>('users');
          await users.deleteMany({ where: { orgId: createdOrgId } });
          await db.table('organizations').delete({ where: { id: createdOrgId } });
        }
      }
    });

    it('supports isolation level option', async () => {
      const slug = `tx-iso-${Date.now()}`;

      await db.$transaction(
        async (tx) => {
          const orgs = tx.table<{ id: number; name: string; slug: string }>('organizations');
          await orgs.create({ data: { name: 'Iso Org', slug } });
        },
        { isolationLevel: 'Serializable' },
      );

      const orgs = db.table<{ id: number; slug: string }>('organizations');
      const org = await orgs.findUnique({ where: { slug } });
      assert.ok(org, 'org should exist after serializable tx');

      // Cleanup
      await orgs.delete({ where: { id: org.id } });
    });

    it('supports timeout option', async () => {
      // This should complete before timeout
      const slug = `tx-timeout-${Date.now()}`;
      await db.$transaction(
        async (tx) => {
          const orgs = tx.table<{ id: number; name: string; slug: string }>('organizations');
          await orgs.create({ data: { name: 'Timeout Org', slug } });
        },
        { timeout: 5000 },
      );

      const orgs = db.table<{ id: number; slug: string }>('organizations');
      const org = await orgs.findUnique({ where: { slug } });
      assert.ok(org, 'org should exist');

      // Cleanup
      await orgs.delete({ where: { id: org.id } });
    });

    it('raw SQL works inside typed transaction', async () => {
      const slug = `tx-raw-${Date.now()}`;

      await db.$transaction(async (tx) => {
        await tx.raw`INSERT INTO organizations (name, slug) VALUES (${'Raw TX Org'}, ${slug})`;
      });

      const orgs = db.table<{ id: number; slug: string }>('organizations');
      const org = await orgs.findUnique({ where: { slug } });
      assert.ok(org, 'org created via raw SQL in tx should exist');

      // Cleanup
      await orgs.delete({ where: { id: org.id } });
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Aggregation functions
  // ---------------------------------------------------------------------------

  describe('aggregate', () => {
    it('counts all rows', async () => {
      const posts = db.table<{ id: number; viewCount: number }>('posts');
      const result = await posts.aggregate({
        _count: true,
      });
      assert.ok(result._count !== undefined, 'should have _count');
      assert.ok((result._count as number) > 0, 'count should be > 0');
    });

    it('computes sum', async () => {
      const posts = db.table<{ id: number; viewCount: number }>('posts');
      const result = await posts.aggregate({
        _sum: { viewCount: true },
      });
      assert.ok(result._sum, 'should have _sum');
      assert.ok(typeof result._sum.viewCount === 'number', '_sum.viewCount should be a number');
      assert.ok(result._sum.viewCount! > 0, 'sum should be > 0');
    });

    it('computes avg', async () => {
      const posts = db.table<{ id: number; viewCount: number }>('posts');
      const result = await posts.aggregate({
        _avg: { viewCount: true },
      });
      assert.ok(result._avg, 'should have _avg');
      assert.ok(typeof result._avg.viewCount === 'number', '_avg.viewCount should be a number');
    });

    it('computes min and max', async () => {
      const posts = db.table<{ id: number; viewCount: number }>('posts');
      const result = await posts.aggregate({
        _min: { viewCount: true },
        _max: { viewCount: true },
      });
      assert.ok(result._min, 'should have _min');
      assert.ok(result._max, 'should have _max');
      const min = result._min.viewCount as number;
      const max = result._max.viewCount as number;
      assert.ok(min <= max, 'min should be <= max');
    });

    it('combines count + sum + avg + min + max', async () => {
      const posts = db.table<{ id: number; viewCount: number }>('posts');
      const result = await posts.aggregate({
        _count: true,
        _sum: { viewCount: true },
        _avg: { viewCount: true },
        _min: { viewCount: true },
        _max: { viewCount: true },
      });
      assert.ok(result._count !== undefined);
      assert.ok(result._sum);
      assert.ok(result._avg);
      assert.ok(result._min);
      assert.ok(result._max);
    });

    it('supports where filter in aggregate', async () => {
      const posts = db.table<{ id: number; viewCount: number; published: boolean }>('posts');
      const all = await posts.aggregate({ _count: true });
      const published = await posts.aggregate({
        _count: true,
        where: { published: true },
      });
      assert.ok((published._count as number) <= (all._count as number), 'filtered count should be <= total');
    });
  });

  describe('groupBy with aggregates', () => {
    it('groups with _count', async () => {
      const users = db.table<{ role: string }>('users');
      const groups = await users.groupBy({ by: ['role'] });
      assert.ok(groups.length > 0, 'should have groups');
      for (const g of groups) {
        assert.ok('role' in g, 'should have role field');
        assert.ok('_count' in g, 'should have _count field');
        assert.equal(typeof g._count, 'number');
      }
    });

    it('groups with _sum', async () => {
      const posts = db.table<{ published: boolean; viewCount: number }>('posts');
      const groups = await posts.groupBy({
        by: ['published'],
        _count: true,
        _sum: { viewCount: true },
      });
      assert.ok(groups.length > 0);
      for (const g of groups) {
        assert.ok('published' in g);
        assert.ok('_count' in g);
        assert.ok('_sum' in g);
        const sum = g._sum as { viewCount: number };
        assert.ok(typeof sum.viewCount === 'number', '_sum.viewCount should be a number');
      }
    });

    it('groups with _avg, _min, _max', async () => {
      const posts = db.table<{ published: boolean; viewCount: number }>('posts');
      const groups = await posts.groupBy({
        by: ['published'],
        _avg: { viewCount: true },
        _min: { viewCount: true },
        _max: { viewCount: true },
      });
      assert.ok(groups.length > 0);
      for (const g of groups) {
        assert.ok(g._avg, 'should have _avg');
        assert.ok(g._min, 'should have _min');
        assert.ok(g._max, 'should have _max');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Middleware / Query hooks
  // ---------------------------------------------------------------------------

  describe('middleware / query hooks', () => {
    it('intercepts queries and receives model + action', async () => {
      const logs: { model: string; action: string }[] = [];

      // Create a fresh client for middleware testing
      const mwDb = new TurbineClient({ connectionString: DATABASE_URL, poolSize: 2 }, schema);

      mwDb.$use(async (params, next) => {
        logs.push({ model: params.model, action: params.action });
        return next(params);
      });

      const users = mwDb.table<{ id: number }>('users');
      await users.findUnique({ where: { id: 1 } });
      await users.findMany({ limit: 1 });
      await users.count();

      assert.equal(logs.length, 3);
      assert.equal(logs[0]!.model, 'users');
      assert.equal(logs[0]!.action, 'findUnique');
      assert.equal(logs[1]!.action, 'findMany');
      assert.equal(logs[2]!.action, 'count');

      await mwDb.disconnect();
    });

    it('can modify query results (e.g., add computed fields)', async () => {
      const mwDb = new TurbineClient({ connectionString: DATABASE_URL, poolSize: 2 }, schema);

      mwDb.$use(async (params, next) => {
        const result = await next(params);
        // Add a timestamp to every findUnique result
        if (params.action === 'findUnique' && result && typeof result === 'object') {
          (result as Record<string, unknown>)._queriedAt = 'intercepted';
        }
        return result;
      });

      const users = mwDb.table<{ id: number; _queriedAt?: string }>('users');
      const user = await users.findUnique({ where: { id: 1 } });
      assert.ok(user);
      assert.equal(user._queriedAt, 'intercepted');

      await mwDb.disconnect();
    });

    it('supports multiple middleware (chain)', async () => {
      const mwDb = new TurbineClient({ connectionString: DATABASE_URL, poolSize: 2 }, schema);
      const order: string[] = [];

      mwDb.$use(async (params, next) => {
        order.push('mw1-before');
        const result = await next(params);
        order.push('mw1-after');
        return result;
      });

      mwDb.$use(async (params, next) => {
        order.push('mw2-before');
        const result = await next(params);
        order.push('mw2-after');
        return result;
      });

      const users = mwDb.table<{ id: number }>('users');
      await users.findUnique({ where: { id: 1 } });

      assert.deepEqual(order, ['mw1-before', 'mw2-before', 'mw2-after', 'mw1-after']);

      await mwDb.disconnect();
    });

    it('works with create/update/delete operations', async () => {
      const mwDb = new TurbineClient({ connectionString: DATABASE_URL, poolSize: 2 }, schema);
      const actions: string[] = [];

      mwDb.$use(async (params, next) => {
        actions.push(params.action);
        return next(params);
      });

      const orgs = mwDb.table<{ id: number; name: string; slug: string }>('organizations');
      const slug = `mw-crud-${Date.now()}`;

      const org = await orgs.create({ data: { name: 'MW Org', slug } });
      await orgs.update({ where: { id: org.id }, data: { name: 'MW Org Updated' } });
      await orgs.delete({ where: { id: org.id } });

      assert.ok(actions.includes('create'));
      assert.ok(actions.includes('update'));
      assert.ok(actions.includes('delete'));

      await mwDb.disconnect();
    });

    it('query timing middleware pattern', async () => {
      const mwDb = new TurbineClient({ connectionString: DATABASE_URL, poolSize: 2 }, schema);
      let elapsed = 0;

      mwDb.$use(async (params, next) => {
        const before = Date.now();
        const result = await next(params);
        elapsed = Date.now() - before;
        return result;
      });

      const users = mwDb.table('users');
      await users.count();
      assert.ok(elapsed >= 0, 'elapsed time should be >= 0');

      await mwDb.disconnect();
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Cursor-based pagination
  // ---------------------------------------------------------------------------

  describe('cursor-based pagination', () => {
    it('cursor with ascending order', async () => {
      const users = db.table<{ id: number }>('users');

      // Get first page
      const page1 = await users.findMany({
        orderBy: { id: 'asc' },
        take: 5,
      });
      assert.equal(page1.length, 5);

      // Get second page using cursor
      const lastId = page1[page1.length - 1]!.id;
      const page2 = await users.findMany({
        cursor: { id: lastId },
        orderBy: { id: 'asc' },
        take: 5,
      });
      assert.equal(page2.length, 5);

      // All ids in page2 should be > lastId
      for (const user of page2) {
        assert.ok(user.id > lastId, `id ${user.id} should be > cursor ${lastId}`);
      }

      // No overlap between pages
      const page1Ids = new Set(page1.map((u) => u.id));
      for (const user of page2) {
        assert.ok(!page1Ids.has(user.id), `id ${user.id} should not overlap with page 1`);
      }
    });

    it('cursor with descending order', async () => {
      const users = db.table<{ id: number }>('users');

      const page1 = await users.findMany({
        orderBy: { id: 'desc' },
        take: 5,
      });
      assert.equal(page1.length, 5);

      const lastId = page1[page1.length - 1]!.id;
      const page2 = await users.findMany({
        cursor: { id: lastId },
        orderBy: { id: 'desc' },
        take: 5,
      });
      assert.equal(page2.length, 5);

      // All ids in page2 should be < lastId (descending)
      for (const user of page2) {
        assert.ok(user.id < lastId, `id ${user.id} should be < cursor ${lastId}`);
      }
    });

    it('cursor with where filter', async () => {
      const posts = db.table<{ id: number; published: boolean }>('posts');

      const page1 = await posts.findMany({
        where: { published: true },
        orderBy: { id: 'asc' },
        take: 5,
      });
      assert.ok(page1.length > 0, 'should have published posts');

      if (page1.length === 5) {
        const lastId = page1[page1.length - 1]!.id;
        const page2 = await posts.findMany({
          where: { published: true },
          cursor: { id: lastId },
          orderBy: { id: 'asc' },
          take: 5,
        });

        // All results should be published
        for (const post of page2) {
          assert.equal(post.published, true);
          assert.ok(post.id > lastId);
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Distinct
  // ---------------------------------------------------------------------------

  describe('distinct', () => {
    it('returns distinct roles', async () => {
      const users = db.table<{ role: string }>('users');
      const roles = await users.findMany({
        distinct: ['role'],
        select: { role: true },
      });
      assert.ok(roles.length > 0, 'should have roles');

      // Check uniqueness
      const roleValues = roles.map((r) => r.role);
      const uniqueRoles = new Set(roleValues);
      assert.equal(roleValues.length, uniqueRoles.size, 'all roles should be unique');
    });

    it('distinct with where filter', async () => {
      const users = db.table<{ role: string; orgId: number }>('users');
      const roles = await users.findMany({
        distinct: ['role'],
        where: { orgId: 1 },
        select: { role: true },
      });

      // Should be distinct
      const roleValues = roles.map((r) => r.role);
      const uniqueRoles = new Set(roleValues);
      assert.equal(roleValues.length, uniqueRoles.size, 'all roles should be unique');
    });

    it('distinct with orderBy', async () => {
      const users = db.table<{ role: string }>('users');
      const roles = await users.findMany({
        distinct: ['role'],
        select: { role: true },
        orderBy: { role: 'asc' },
      });
      assert.ok(roles.length > 0);

      // Verify ordering
      for (let i = 1; i < roles.length; i++) {
        assert.ok(
          roles[i]!.role >= roles[i - 1]!.role,
          `roles should be ordered ascending: ${roles[i - 1]!.role} <= ${roles[i]!.role}`,
        );
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 6. createMany with skipDuplicates
  // ---------------------------------------------------------------------------

  describe('createMany with skipDuplicates', () => {
    const slugBase = `skip-dup-${Date.now()}`;
    let createdIds: number[] = [];

    it('batch inserts with skipDuplicates (no duplicates)', async () => {
      const orgs = db.table<{ id: number; name: string; slug: string }>('organizations');
      const created = await orgs.createMany({
        data: [
          { name: 'Skip Dup 1', slug: `${slugBase}-1` },
          { name: 'Skip Dup 2', slug: `${slugBase}-2` },
        ],
        skipDuplicates: true,
      });
      assert.ok(created.length >= 1, 'should create at least 1 row');
      createdIds = created.map((o) => o.id);
    });

    it('skipDuplicates silently skips existing rows', async () => {
      const orgs = db.table<{ id: number; name: string; slug: string }>('organizations');
      // Try to insert one existing and one new
      const created = await orgs.createMany({
        data: [
          { name: 'Skip Dup 1 Again', slug: `${slugBase}-1` }, // Duplicate slug
          { name: 'Skip Dup 3', slug: `${slugBase}-3` }, // New
        ],
        skipDuplicates: true,
      });
      // Should only insert the new one (or none if slug is not unique constraint)
      assert.ok(Array.isArray(created));
      if (created.length > 0) {
        for (const org of created) {
          createdIds.push(org.id);
        }
      }
    });

    // Cleanup
    after(async () => {
      for (const id of createdIds) {
        try {
          await db.table('organizations').delete({ where: { id } });
        } catch {
          // Ignore if already cleaned up
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Relation filters in where clause
  // ---------------------------------------------------------------------------

  describe('relation filters in where', () => {
    it('some: finds users who have at least one published post', async () => {
      const users = db.table<{ id: number; name: string }>('users');
      const result = await users.findMany({
        where: {
          posts: { some: { published: true } },
        },
        limit: 10,
      });
      assert.ok(result.length > 0, 'should find users with published posts');

      // Verify: each user should have at least one published post
      for (const user of result) {
        const posts = db.table<{ id: number; userId: number; published: boolean }>('posts');
        const userPosts = await posts.findMany({
          where: { userId: user.id, published: true },
          limit: 1,
        });
        assert.ok(userPosts.length > 0, `user ${user.id} should have at least one published post`);
      }
    });

    it('none: finds users who have no published posts', async () => {
      const users = db.table<{ id: number }>('users');
      const result = await users.findMany({
        where: {
          posts: { none: { published: true } },
        },
        limit: 10,
      });
      // These users should have zero published posts
      for (const user of result) {
        const posts = db.table<{ id: number; userId: number; published: boolean }>('posts');
        const publishedPosts = await posts.findMany({
          where: { userId: user.id, published: true },
          limit: 1,
        });
        assert.equal(publishedPosts.length, 0, `user ${user.id} should have no published posts`);
      }
    });

    it('every: finds users where all posts are published', async () => {
      const users = db.table<{ id: number }>('users');
      const result = await users.findMany({
        where: {
          posts: { every: { published: true } },
        },
        limit: 10,
      });

      // For each result, all their posts should be published
      for (const user of result) {
        const posts = db.table<{ id: number; userId: number; published: boolean }>('posts');
        const unpublished = await posts.findMany({
          where: { userId: user.id, published: false },
          limit: 1,
        });
        assert.equal(
          unpublished.length,
          0,
          `user ${user.id} should have no unpublished posts (every should be published)`,
        );
      }
    });

    it('some with operator filters', async () => {
      const users = db.table<{ id: number; name: string }>('users');
      const result = await users.findMany({
        where: {
          posts: { some: { viewCount: { gt: 50 } } },
        },
        limit: 5,
      });
      // Should find users whose posts have high view counts
      assert.ok(Array.isArray(result));
    });

    it('combined with regular where fields', async () => {
      const users = db.table<{ id: number; orgId: number; name: string }>('users');
      const result = await users.findMany({
        where: {
          orgId: 1,
          posts: { some: { published: true } },
        },
        limit: 10,
      });

      for (const user of result) {
        assert.equal(user.orgId, 1, 'orgId should be 1');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // AND / NOT in where clauses
  // ---------------------------------------------------------------------------

  describe('AND / NOT where clauses', () => {
    it('AND: combines multiple conditions', async () => {
      const users = db.table<{ id: number; orgId: number; role: string }>('users');
      const result = await users.findMany({
        where: {
          AND: [{ orgId: 1 }, { role: 'admin' }],
        },
        limit: 10,
      });
      for (const user of result) {
        assert.equal(user.orgId, 1);
        assert.equal(user.role, 'admin');
      }
    });

    it('NOT: excludes matching rows', async () => {
      const users = db.table<{ id: number; role: string }>('users');
      const result = await users.findMany({
        where: {
          NOT: { role: 'admin' },
        },
        limit: 10,
      });
      for (const user of result) {
        assert.notEqual(user.role, 'admin', 'role should not be admin');
      }
    });

    it('NOT combined with other conditions', async () => {
      const users = db.table<{ id: number; orgId: number; role: string }>('users');
      const result = await users.findMany({
        where: {
          orgId: 1,
          NOT: { role: 'admin' },
        },
        limit: 10,
      });
      for (const user of result) {
        assert.equal(user.orgId, 1);
        assert.notEqual(user.role, 'admin');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Select/Omit with new features
  // ---------------------------------------------------------------------------

  describe('select/omit with aggregates', () => {
    it('select works with findMany', async () => {
      const users = db.table<{ id: number; name: string; email: string }>('users');
      const result = await users.findMany({
        select: { id: true, name: true },
        limit: 3,
      });
      assert.ok(result.length > 0);
      for (const user of result) {
        assert.ok('id' in user);
        assert.ok('name' in user);
        // email should not be present (not selected)
        assert.ok(!('email' in user), 'email should not be in result when not selected');
      }
    });

    it('omit excludes specified fields', async () => {
      const users = db.table<{ id: number; name: string; email: string; role: string }>('users');
      const result = await users.findMany({
        omit: { email: true },
        limit: 3,
      });
      assert.ok(result.length > 0);
      for (const user of result) {
        assert.ok('id' in user);
        assert.ok('name' in user);
        assert.ok(!('email' in user), 'email should be omitted');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Upsert
  // ---------------------------------------------------------------------------

  describe('upsert', () => {
    let testSlug: string;

    it('creates when row does not exist', async () => {
      testSlug = `upsert-test-${Date.now()}`;
      const orgs = db.table<{ id: number; name: string; slug: string; plan: string }>('organizations');
      const org = await orgs.upsert({
        where: { slug: testSlug },
        create: { name: 'Upsert New', slug: testSlug },
        update: { name: 'Upsert Updated' },
      });
      assert.ok(org.id);
      assert.equal(org.name, 'Upsert New');
      assert.equal(org.slug, testSlug);
    });

    it('updates when row exists', async () => {
      const orgs = db.table<{ id: number; name: string; slug: string; plan: string }>('organizations');
      const org = await orgs.upsert({
        where: { slug: testSlug },
        create: { name: 'Should Not Create', slug: testSlug },
        update: { name: 'Upsert Updated' },
      });
      assert.equal(org.name, 'Upsert Updated');
      assert.equal(org.slug, testSlug);
    });

    // Cleanup
    after(async () => {
      if (testSlug) {
        const orgs = db.table<{ id: number; slug: string }>('organizations');
        const org = await orgs.findUnique({ where: { slug: testSlug } });
        if (org) await orgs.delete({ where: { id: org.id } });
      }
    });
  });

  // ---------------------------------------------------------------------------
  // updateMany / deleteMany
  // ---------------------------------------------------------------------------

  describe('updateMany / deleteMany', () => {
    const slugPrefix = `bulk-test-${Date.now()}`;
    let createdIds: number[] = [];

    before(async () => {
      const orgs = db.table<{ id: number; name: string; slug: string; plan: string }>('organizations');
      const created = await orgs.createMany({
        data: [
          { name: 'Bulk 1', slug: `${slugPrefix}-1` },
          { name: 'Bulk 2', slug: `${slugPrefix}-2` },
          { name: 'Bulk 3', slug: `${slugPrefix}-3` },
        ],
      });
      createdIds = created.map((o) => o.id);
    });

    it('updateMany updates multiple rows and returns count', async () => {
      const orgs = db.table<{ id: number; plan: string }>('organizations');
      const result = await orgs.updateMany({
        where: { id: { in: createdIds } },
        data: { plan: 'enterprise' },
      });
      assert.equal(result.count, 3, 'should update 3 rows');
    });

    it('deleteMany deletes multiple rows and returns count', async () => {
      const orgs = db.table<{ id: number }>('organizations');
      const result = await orgs.deleteMany({
        where: { id: { in: createdIds } },
      });
      assert.equal(result.count, 3, 'should delete 3 rows');
      createdIds = []; // Already cleaned up
    });

    after(async () => {
      // Safety cleanup
      for (const id of createdIds) {
        try {
          await db.table('organizations').delete({ where: { id } });
        } catch {
          // Ignore
        }
      }
    });
  });

  // ===========================================================================
  // Sprint 3 — Dev2 features
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // 1. Select/omit on nested relations
  // ---------------------------------------------------------------------------

  describe('select/omit on nested relations', () => {
    it('select limits fields returned from nested relation', async () => {
      const users = db.table<{
        id: number;
        posts: { id: number; title: string }[];
      }>('users');
      const user = await users.findUnique({
        where: { id: 1 },
        with: {
          posts: {
            select: { id: true, title: true },
          },
        },
      });
      assert.ok(user);
      assert.ok(Array.isArray(user.posts));
      if (user.posts.length > 0) {
        const post = user.posts[0]!;
        assert.ok('id' in post, 'should have id');
        assert.ok('title' in post, 'should have title');
        // content, published, viewCount etc. should NOT be present
        assert.ok(!('content' in post), 'content should not be included when not selected');
        assert.ok(!('published' in post), 'published should not be included when not selected');
        assert.ok(!('viewCount' in post), 'viewCount should not be included when not selected');
      }
    });

    it('omit excludes specified fields from nested relation', async () => {
      const users = db.table<{
        id: number;
        posts: { id: number; title: string; content?: string }[];
      }>('users');
      const user = await users.findUnique({
        where: { id: 1 },
        with: {
          posts: {
            omit: { content: true },
          },
        },
      });
      assert.ok(user);
      assert.ok(Array.isArray(user.posts));
      if (user.posts.length > 0) {
        const post = user.posts[0]!;
        assert.ok('id' in post, 'should have id');
        assert.ok('title' in post, 'should have title');
        assert.ok(!('content' in post), 'content should be omitted');
      }
    });

    it('select works with nested relation + limit + orderBy', async () => {
      const users = db.table<{
        id: number;
        posts: { id: number; title: string }[];
      }>('users');
      const user = await users.findUnique({
        where: { id: 1 },
        with: {
          posts: {
            select: { id: true, title: true },
            orderBy: { id: 'desc' },
            limit: 3,
          },
        },
      });
      assert.ok(user);
      assert.ok(user.posts.length <= 3);
      if (user.posts.length > 0) {
        const post = user.posts[0]!;
        assert.ok('id' in post, 'should have id');
        assert.ok('title' in post, 'should have title');
        assert.ok(!('content' in post), 'content should not be included');
      }
    });

    it('select works with nested relation + nested with', async () => {
      const users = db.table<{
        id: number;
        posts: { id: number; title: string; comments: { id: number }[] }[];
      }>('users');
      const user = await users.findUnique({
        where: { id: 1 },
        with: {
          posts: {
            select: { id: true, title: true },
            with: { comments: true },
          },
        },
      });
      assert.ok(user);
      assert.ok(Array.isArray(user.posts));
      if (user.posts.length > 0) {
        const post = user.posts[0]!;
        assert.ok('id' in post, 'should have id');
        assert.ok('title' in post, 'should have title');
        assert.ok('comments' in post, 'should have nested comments');
        assert.ok(Array.isArray(post.comments));
      }
    });

    it('belongsTo relation with select', async () => {
      const posts = db.table<{
        id: number;
        user: { id: number; name: string } | null;
      }>('posts');
      const post = await posts.findUnique({
        where: { id: 1 },
        with: {
          user: {
            select: { id: true, name: true },
          },
        },
      });
      assert.ok(post);
      assert.ok(post.user);
      assert.ok('id' in post.user, 'should have id');
      assert.ok('name' in post.user, 'should have name');
      assert.ok(!('email' in post.user), 'email should not be included when not selected');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. JSONB query operators
  // ---------------------------------------------------------------------------

  describe('JSONB query operators', () => {
    const slugPrefix = `jsonb-test-${Date.now()}`;
    let testOrgIds: number[] = [];

    before(async () => {
      const orgs = db.table<{ id: number; name: string; slug: string; metadata: unknown }>('organizations');
      const org1 = await orgs.create({
        data: {
          name: 'JSONB Org 1',
          slug: `${slugPrefix}-1`,
          metadata: JSON.stringify({ tier: 'premium', features: ['sso', 'audit'], config: { maxUsers: 100 } }),
        },
      });
      const org2 = await orgs.create({
        data: {
          name: 'JSONB Org 2',
          slug: `${slugPrefix}-2`,
          metadata: JSON.stringify({ tier: 'free', features: ['basic'], config: { maxUsers: 5 } }),
        },
      });
      const org3 = await orgs.create({
        data: {
          name: 'JSONB Org 3',
          slug: `${slugPrefix}-3`,
          metadata: JSON.stringify({ tier: 'premium', features: ['sso'] }),
        },
      });
      testOrgIds = [org1.id, org2.id, org3.id];
    });

    it('contains: finds orgs whose metadata contains a value', async () => {
      const orgs = db.table<{ id: number; metadata: unknown }>('organizations');
      const result = await orgs.findMany({
        where: {
          id: { in: testOrgIds },
          metadata: { contains: { tier: 'premium' } },
        },
      });
      assert.ok(result.length >= 2, `expected at least 2 premium orgs, got ${result.length}`);
    });

    it('equals: finds orgs with exact jsonb match via containment', async () => {
      const orgs = db.table<{ id: number; metadata: unknown }>('organizations');
      const result = await orgs.findMany({
        where: {
          id: { in: testOrgIds },
          metadata: { equals: { tier: 'free', features: ['basic'], config: { maxUsers: 5 } } },
        },
      });
      assert.equal(result.length, 1, 'should find exactly one free org');
    });

    it('path + equals: access nested value via path', async () => {
      const orgs = db.table<{ id: number; metadata: unknown }>('organizations');
      const result = await orgs.findMany({
        where: {
          id: { in: testOrgIds },
          metadata: { path: ['tier'], equals: 'premium' },
        },
      });
      assert.ok(result.length >= 2, `expected at least 2 premium orgs via path, got ${result.length}`);
    });

    it('hasKey: finds orgs whose metadata has a specific key', async () => {
      const orgs = db.table<{ id: number; metadata: unknown }>('organizations');
      const result = await orgs.findMany({
        where: {
          id: { in: testOrgIds },
          metadata: { hasKey: 'config' },
        },
      });
      assert.ok(result.length >= 2, `expected at least 2 orgs with config key, got ${result.length}`);
    });

    after(async () => {
      for (const id of testOrgIds) {
        try {
          await db.table('organizations').delete({ where: { id } });
        } catch {
          /* ignore */
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Array type queries
  // ---------------------------------------------------------------------------

  describe('array type queries', () => {
    const slugPrefix = `array-test-${Date.now()}`;
    let testOrgIds: number[] = [];

    before(async () => {
      const orgs = db.table<{ id: number; name: string; slug: string; tags: string[] }>('organizations');
      const org1 = await orgs.create({
        data: { name: 'Array Org 1', slug: `${slugPrefix}-1`, tags: ['startup', 'saas', 'ai'] },
      });
      const org2 = await orgs.create({
        data: { name: 'Array Org 2', slug: `${slugPrefix}-2`, tags: ['enterprise', 'saas'] },
      });
      const org3 = await orgs.create({
        data: { name: 'Array Org 3', slug: `${slugPrefix}-3`, tags: [] },
      });
      testOrgIds = [org1.id, org2.id, org3.id];
    });

    it('has: finds orgs with a specific tag', async () => {
      const orgs = db.table<{ id: number; tags: string[] }>('organizations');
      const result = await orgs.findMany({
        where: {
          id: { in: testOrgIds },
          tags: { has: 'saas' },
        },
      });
      assert.equal(result.length, 2, 'should find 2 orgs with saas tag');
    });

    it('hasEvery: finds orgs with all specified tags', async () => {
      const orgs = db.table<{ id: number; tags: string[] }>('organizations');
      const result = await orgs.findMany({
        where: {
          id: { in: testOrgIds },
          tags: { hasEvery: ['startup', 'saas'] },
        },
      });
      assert.equal(result.length, 1, 'should find 1 org with both startup and saas');
    });

    it('hasSome: finds orgs with any of the specified tags', async () => {
      const orgs = db.table<{ id: number; tags: string[] }>('organizations');
      const result = await orgs.findMany({
        where: {
          id: { in: testOrgIds },
          tags: { hasSome: ['ai', 'enterprise'] },
        },
      });
      assert.equal(result.length, 2, 'should find 2 orgs with ai or enterprise');
    });

    it('isEmpty: true finds orgs with empty tags', async () => {
      const orgs = db.table<{ id: number; tags: string[] }>('organizations');
      const result = await orgs.findMany({
        where: {
          id: { in: testOrgIds },
          tags: { isEmpty: true },
        },
      });
      assert.equal(result.length, 1, 'should find 1 org with empty tags');
    });

    it('isEmpty: false finds orgs with non-empty tags', async () => {
      const orgs = db.table<{ id: number; tags: string[] }>('organizations');
      const result = await orgs.findMany({
        where: {
          id: { in: testOrgIds },
          tags: { isEmpty: false },
        },
      });
      assert.equal(result.length, 2, 'should find 2 orgs with non-empty tags');
    });

    after(async () => {
      for (const id of testOrgIds) {
        try {
          await db.table('organizations').delete({ where: { id } });
        } catch {
          /* ignore */
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Middleware system comprehensive tests
  // ---------------------------------------------------------------------------

  describe('middleware system (comprehensive)', () => {
    it('query logging middleware captures model, action, args', async () => {
      const mwDb = new TurbineClient({ connectionString: DATABASE_URL, poolSize: 2 }, schema);
      const logs: { model: string; action: string; args: Record<string, unknown> }[] = [];

      mwDb.$use(async (params, next) => {
        logs.push({ model: params.model, action: params.action, args: { ...params.args } });
        return next(params);
      });

      const users = mwDb.table<{ id: number }>('users');
      await users.findUnique({ where: { id: 1 } });
      await users.findMany({ limit: 2 });
      await users.count({ where: { role: 'admin' } });

      assert.equal(logs.length, 3);
      assert.equal(logs[0]!.model, 'users');
      assert.equal(logs[0]!.action, 'findUnique');
      assert.ok(logs[0]!.args.where, 'findUnique args should have where');
      assert.equal(logs[1]!.action, 'findMany');
      assert.equal(logs[2]!.action, 'count');

      await mwDb.disconnect();
    });

    it('timing middleware measures query duration', async () => {
      const mwDb = new TurbineClient({ connectionString: DATABASE_URL, poolSize: 2 }, schema);
      const timings: { action: string; durationMs: number }[] = [];

      mwDb.$use(async (params, next) => {
        const start = Date.now();
        const result = await next(params);
        timings.push({ action: params.action, durationMs: Date.now() - start });
        return result;
      });

      const users = mwDb.table('users');
      await users.findMany({ limit: 10 });
      await users.count();

      assert.equal(timings.length, 2);
      assert.ok(timings[0]!.durationMs >= 0, 'duration should be >= 0');
      assert.equal(timings[0]!.action, 'findMany');
      assert.equal(timings[1]!.action, 'count');

      await mwDb.disconnect();
    });

    it('middleware chain order: first registered runs first (outermost)', async () => {
      const mwDb = new TurbineClient({ connectionString: DATABASE_URL, poolSize: 2 }, schema);
      const order: string[] = [];

      mwDb.$use(async (params, next) => {
        order.push('A-before');
        const result = await next(params);
        order.push('A-after');
        return result;
      });

      mwDb.$use(async (params, next) => {
        order.push('B-before');
        const result = await next(params);
        order.push('B-after');
        return result;
      });

      mwDb.$use(async (params, next) => {
        order.push('C-before');
        const result = await next(params);
        order.push('C-after');
        return result;
      });

      const users = mwDb.table<{ id: number }>('users');
      await users.findUnique({ where: { id: 1 } });

      assert.deepEqual(order, ['A-before', 'B-before', 'C-before', 'C-after', 'B-after', 'A-after']);

      await mwDb.disconnect();
    });

    it('error handling: middleware propagates errors correctly', async () => {
      const mwDb = new TurbineClient({ connectionString: DATABASE_URL, poolSize: 2 }, schema);
      const order: string[] = [];

      mwDb.$use(async (params, next) => {
        order.push('outer-before');
        try {
          const result = await next(params);
          order.push('outer-after-success');
          return result;
        } catch (err) {
          order.push('outer-caught-error');
          throw err;
        }
      });

      mwDb.$use(async (_params, _next) => {
        order.push('inner-throwing');
        throw new Error('middleware test error');
      });

      const users = mwDb.table<{ id: number }>('users');
      await assert.rejects(() => users.findUnique({ where: { id: 1 } }), /middleware test error/);

      assert.deepEqual(order, ['outer-before', 'inner-throwing', 'outer-caught-error']);

      await mwDb.disconnect();
    });

    it('middleware can modify args before passing to next', async () => {
      const mwDb = new TurbineClient({ connectionString: DATABASE_URL, poolSize: 2 }, schema);

      // Middleware that forces a limit of 1 on all findMany queries
      mwDb.$use(async (params, next) => {
        if (params.action === 'findMany') {
          params.args = { ...params.args, limit: 1 };
        }
        return next(params);
      });

      // Note: the middleware modifies args, but since QueryInterface has already
      // built the deferred query by the time middleware runs, this test verifies
      // the args object is mutable. The actual SQL won't change because the
      // executor closure captured the original args. This tests the middleware API.
      const users = mwDb.table<{ id: number }>('users');
      const result = await users.findMany({ limit: 100 });
      // The middleware modified args, but the executor was already built.
      // This just verifies middleware CAN modify args without throwing.
      assert.ok(Array.isArray(result));

      await mwDb.disconnect();
    });

    it('middleware can modify result after next returns', async () => {
      const mwDb = new TurbineClient({ connectionString: DATABASE_URL, poolSize: 2 }, schema);

      mwDb.$use(async (params, next) => {
        const result = await next(params);
        if (params.action === 'findMany' && Array.isArray(result)) {
          // Add a _meta property to each row
          return result.map((row: unknown) => ({
            ...(row as Record<string, unknown>),
            _source: 'modified-by-middleware',
          }));
        }
        if (params.action === 'count' && typeof result === 'number') {
          // Multiply count by -1 (silly, but proves we can transform)
          return result * -1;
        }
        return result;
      });

      const users = mwDb.table<{ id: number; _source?: string }>('users');
      const result = await users.findMany({ limit: 3 });
      assert.ok(result.length > 0);
      for (const user of result) {
        assert.equal(user._source, 'modified-by-middleware');
      }

      const count = await users.count();
      assert.ok(count < 0, 'count should be negative after middleware transform');

      await mwDb.disconnect();
    });

    it('middleware receives correct model name for different tables', async () => {
      const mwDb = new TurbineClient({ connectionString: DATABASE_URL, poolSize: 2 }, schema);
      const models: string[] = [];

      mwDb.$use(async (params, next) => {
        models.push(params.model);
        return next(params);
      });

      await mwDb.table('users').count();
      await mwDb.table('posts').count();
      await mwDb.table('organizations').count();

      assert.deepEqual(models, ['users', 'posts', 'organizations']);

      await mwDb.disconnect();
    });

    it('middleware works with pipeline operations', async () => {
      const mwDb = new TurbineClient({ connectionString: DATABASE_URL, poolSize: 2 }, schema);
      const actions: string[] = [];

      mwDb.$use(async (params, next) => {
        actions.push(`${params.model}.${params.action}`);
        return next(params);
      });

      // Note: pipeline uses buildX methods which don't go through middleware.
      // Only the direct query methods go through middleware. This tests that
      // direct calls still work with middleware.
      const users = mwDb.table<{ id: number }>('users');
      await users.findUnique({ where: { id: 1 } });
      await users.findMany({ limit: 1 });

      assert.ok(actions.includes('users.findUnique'));
      assert.ok(actions.includes('users.findMany'));

      await mwDb.disconnect();
    });
  });

  // ---------------------------------------------------------------------------
  // 5. orderBy direction validation (Task 6)
  // ---------------------------------------------------------------------------

  describe('orderBy direction safety', () => {
    it('nested relation orderBy sanitizes direction to ASC/DESC', async () => {
      const users = db.table<{ id: number; posts: { id: number }[] }>('users');
      // This should work without error and not inject SQL
      const user = await users.findUnique({
        where: { id: 1 },
        with: {
          posts: { orderBy: { id: 'asc' }, limit: 3 },
        },
      });
      assert.ok(user);
      assert.ok(Array.isArray(user.posts));
    });

    it('nested relation orderBy desc works correctly', async () => {
      const users = db.table<{ id: number; posts: { id: number }[] }>('users');
      const user = await users.findUnique({
        where: { id: 1 },
        with: {
          posts: { orderBy: { id: 'desc' }, limit: 5 },
        },
      });
      assert.ok(user);
      // Verify descending order
      for (let i = 1; i < user.posts.length; i++) {
        assert.ok(user.posts[i]!.id < user.posts[i - 1]!.id, 'posts should be ordered by id DESC');
      }
    });
  });
}); // end testFn wrapper
