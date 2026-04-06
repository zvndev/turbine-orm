/**
 * turbine-orm — Comprehensive integration test suite
 *
 * Tests every untested code path in query.ts and client.ts against a real Postgres.
 * Covers: select/omit, cursor pagination, distinct, upsert, updateMany, deleteMany,
 *         relation filters (some/every/none), JSONB operators, array operators,
 *         case-insensitive search, AND/NOT WHERE clauses, complex nested relation
 *         combinations (limit+orderBy+where at multiple levels), createMany features,
 *         defaultLimit, warnOnUnlimited, middleware, edge cases.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/comprehensive.test.ts
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { TurbineClient } from '../client.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata } from '../schema.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('\u26A0 Skipping comprehensive tests: DATABASE_URL not set');
}

let db: TurbineClient;
let schema: SchemaMetadata;

const testFn = SKIP ? describe.skip : describe;

testFn('comprehensive integration tests', () => {
  before(async () => {
    schema = await introspect({ connectionString: DATABASE_URL! });
    db = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 5 }, schema);
    await db.connect();
  });

  after(async () => {
    await db.disconnect();
  });

  // =========================================================================
  // 1. SELECT / OMIT
  // =========================================================================

  describe('select/omit', () => {
    it('findMany with select returns only specified fields', async () => {
      const users = await db.table('users').findMany({
        where: { id: 1 },
        select: { id: true, email: true },
      });
      assert.ok(users.length > 0);
      const user = users[0]!;
      assert.ok('id' in user);
      assert.ok('email' in user);
      // Other fields should not be present
      assert.ok(!('name' in user));
      assert.ok(!('role' in user));
      assert.ok(!('createdAt' in user));
    });

    it('findMany with omit excludes specified fields', async () => {
      const users = await db.table('users').findMany({
        where: { id: 1 },
        omit: { avatarUrl: true, lastLoginAt: true },
      });
      assert.ok(users.length > 0);
      const user = users[0]!;
      assert.ok('id' in user);
      assert.ok('email' in user);
      assert.ok('name' in user);
      assert.ok(!('avatarUrl' in user));
      assert.ok(!('lastLoginAt' in user));
    });

    it('findUnique with select returns only specified fields', async () => {
      const user = await db.table('users').findUnique({
        where: { id: 1 },
        select: { id: true, name: true },
      });
      assert.ok(user);
      assert.ok('id' in user);
      assert.ok('name' in user);
      assert.ok(!('email' in user));
      assert.ok(!('role' in user));
    });

    it('findFirst with select returns only specified fields', async () => {
      const user = await db.table('users').findFirst({
        where: { role: 'admin' },
        select: { id: true, email: true },
      });
      assert.ok(user);
      assert.ok('id' in user);
      assert.ok('email' in user);
      assert.ok(!('name' in user));
    });

    it('select with nested relations includes both selected fields and relations', async () => {
      const users = await db.table('users').findMany({
        where: { id: 1 },
        select: { id: true, name: true },
        with: { posts: true },
      });
      assert.ok(users.length > 0);
      const user = users[0]!;
      assert.ok('id' in user);
      assert.ok('name' in user);
      assert.ok('posts' in user);
      assert.ok(Array.isArray(user.posts));
    });

    it('omit with nested relations excludes fields but includes relations', async () => {
      const users = await db.table('users').findMany({
        where: { id: 1 },
        omit: { avatarUrl: true },
        with: { posts: true },
      });
      assert.ok(users.length > 0);
      const user = users[0]!;
      assert.ok(!('avatarUrl' in user));
      assert.ok('posts' in user);
    });

    it('select on nested relation restricts relation fields', async () => {
      const users = await db.table('users').findMany({
        where: { id: 1 },
        with: {
          posts: {
            select: { id: true, title: true },
            limit: 3,
          },
        },
      });
      assert.ok(users.length > 0);
      const posts = users[0]!.posts as Record<string, unknown>[];
      if (posts.length > 0) {
        const post = posts[0]!;
        assert.ok('id' in post);
        assert.ok('title' in post);
        assert.ok(!('content' in post));
        assert.ok(!('viewCount' in post));
      }
    });

    it('omit on nested relation excludes relation fields', async () => {
      const users = await db.table('users').findMany({
        where: { id: 1 },
        with: {
          posts: {
            omit: { content: true },
            limit: 3,
          },
        },
      });
      assert.ok(users.length > 0);
      const posts = users[0]!.posts as Record<string, unknown>[];
      if (posts.length > 0) {
        const post = posts[0]!;
        assert.ok('id' in post);
        assert.ok('title' in post);
        assert.ok(!('content' in post));
      }
    });
  });

  // =========================================================================
  // 2. CURSOR PAGINATION
  // =========================================================================

  describe('cursor pagination', () => {
    it('cursor with ascending order paginates forward', async () => {
      // Get first page
      const page1 = await db.table('users').findMany({
        orderBy: { id: 'asc' },
        take: 5,
      });
      assert.equal(page1.length, 5);

      // Get second page using cursor
      const lastId = (page1[4] as Record<string, unknown>).id;
      const page2 = await db.table('users').findMany({
        cursor: { id: lastId },
        orderBy: { id: 'asc' },
        take: 5,
      });
      assert.equal(page2.length, 5);
      // First item of page2 should be after last item of page1
      assert.ok(
        ((page2[0] as Record<string, unknown>).id as number) > ((page1[4] as Record<string, unknown>).id as number),
      );
    });

    it('cursor with descending order paginates backward', async () => {
      const page1 = await db.table('users').findMany({
        orderBy: { id: 'desc' },
        take: 5,
      });
      assert.equal(page1.length, 5);

      const lastId = (page1[4] as Record<string, unknown>).id;
      const page2 = await db.table('users').findMany({
        cursor: { id: lastId },
        orderBy: { id: 'desc' },
        take: 5,
      });
      assert.equal(page2.length, 5);
      // In desc order, page2 items should have smaller IDs
      const firstPage2Id = (page2[0] as Record<string, unknown>).id as number;
      const lastPage1Id = (page1[4] as Record<string, unknown>).id as number;
      assert.ok(firstPage2Id < lastPage1Id);
    });

    it('cursor combined with where filter', async () => {
      const page1 = await db.table('users').findMany({
        where: { role: 'member' },
        orderBy: { id: 'asc' },
        take: 3,
      });
      assert.ok(page1.length > 0);

      const lastId = (page1[page1.length - 1] as Record<string, unknown>).id;
      const page2 = await db.table('users').findMany({
        where: { role: 'member' },
        cursor: { id: lastId },
        orderBy: { id: 'asc' },
        take: 3,
      });
      // All page2 items should be members with id > lastId
      for (const user of page2) {
        const u = user as Record<string, unknown>;
        assert.equal(u.role, 'member');
        assert.ok((u.id as number) > (lastId as number));
      }
    });

    it('take overrides limit', async () => {
      const results = await db.table('users').findMany({
        orderBy: { id: 'asc' },
        limit: 100,
        take: 3,
      });
      assert.equal(results.length, 3);
    });
  });

  // =========================================================================
  // 3. DISTINCT
  // =========================================================================

  describe('distinct', () => {
    it('distinct on single column', async () => {
      const roles = await db.table('users').findMany({
        distinct: ['role'],
        select: { role: true },
        orderBy: { role: 'asc' },
      });
      // Should return unique roles only
      const roleValues = roles.map((r: Record<string, unknown>) => r.role);
      const uniqueRoles = [...new Set(roleValues)];
      assert.deepEqual(roleValues, uniqueRoles);
      // We know there are admin, editor, member roles
      assert.ok(roleValues.length >= 3);
    });

    it('distinct with where filter', async () => {
      const roles = await db.table('users').findMany({
        where: { orgId: 1 },
        distinct: ['role'],
        select: { role: true },
      });
      const roleValues = roles.map((r: Record<string, unknown>) => r.role);
      const uniqueRoles = [...new Set(roleValues)];
      assert.deepEqual(roleValues, uniqueRoles);
    });
  });

  // =========================================================================
  // 4. UPSERT
  // =========================================================================

  describe('upsert', () => {
    const testEmail = `upsert_test_${Date.now()}@example.com`;

    it('upsert inserts when no conflict', async () => {
      const result = await db.table('users').upsert({
        where: { email: testEmail },
        create: { email: testEmail, name: 'Upsert New', orgId: 1, role: 'member' },
        update: { name: 'Upsert Updated' },
      });
      assert.equal((result as Record<string, unknown>).email, testEmail);
      assert.equal((result as Record<string, unknown>).name, 'Upsert New');
    });

    it('upsert updates when conflict exists', async () => {
      const result = await db.table('users').upsert({
        where: { email: testEmail },
        create: { email: testEmail, name: 'Should Not See', orgId: 1, role: 'member' },
        update: { name: 'Upsert Updated' },
      });
      assert.equal((result as Record<string, unknown>).email, testEmail);
      assert.equal((result as Record<string, unknown>).name, 'Upsert Updated');
    });

    after(async () => {
      // Cleanup
      try {
        await db.table('users').delete({ where: { email: testEmail } });
      } catch {
        /* may not exist */
      }
    });
  });

  // =========================================================================
  // 5. UPDATE MANY / DELETE MANY
  // =========================================================================

  describe('updateMany / deleteMany', () => {
    let testOrgId: number;

    before(async () => {
      // Create a test org and users for bulk operations
      const org = (await db.table('organizations').create({
        data: { name: 'Bulk Test Org', slug: `bulk_test_${Date.now()}`, plan: 'free' },
      })) as Record<string, unknown>;
      testOrgId = org.id as number;
      await db.table('users').createMany({
        data: [
          { email: `bulk1_${Date.now()}@test.com`, name: 'Bulk 1', orgId: testOrgId, role: 'member' },
          { email: `bulk2_${Date.now()}@test.com`, name: 'Bulk 2', orgId: testOrgId, role: 'member' },
          { email: `bulk3_${Date.now()}@test.com`, name: 'Bulk 3', orgId: testOrgId, role: 'member' },
        ],
      });
    });

    it('updateMany updates multiple rows and returns count', async () => {
      const result = await db.table('users').updateMany({
        where: { orgId: testOrgId },
        data: { role: 'editor' },
      });
      assert.ok(typeof result.count === 'number');
      assert.equal(result.count, 3);
    });

    it('updateMany with operator where', async () => {
      const result = await db.table('users').updateMany({
        where: { orgId: testOrgId, role: 'editor' },
        data: { role: 'admin' },
      });
      assert.equal(result.count, 3);
    });

    it('updateMany with zero matches returns count 0', async () => {
      const result = await db.table('users').updateMany({
        where: { orgId: 999999 },
        data: { role: 'nobody' },
      });
      assert.equal(result.count, 0);
    });

    it('deleteMany deletes multiple rows and returns count', async () => {
      const result = await db.table('users').deleteMany({
        where: { orgId: testOrgId },
      });
      assert.equal(result.count, 3);
    });

    it('deleteMany with zero matches returns count 0', async () => {
      const result = await db.table('users').deleteMany({
        where: { orgId: 999999 },
      });
      assert.equal(result.count, 0);
    });

    after(async () => {
      try {
        await db.table('users').deleteMany({ where: { orgId: testOrgId } });
        await db.table('organizations').delete({ where: { id: testOrgId } });
      } catch {
        /* cleanup */
      }
    });
  });

  // =========================================================================
  // 6. RELATION FILTERS (some / every / none)
  // =========================================================================

  describe('relation filters in WHERE', () => {
    it('some: finds users who have at least one post', async () => {
      const users = await db.table('users').findMany({
        where: {
          posts: { some: { published: true } },
        },
        limit: 10,
      });
      assert.ok(users.length > 0);
      // Verify these users actually have published posts
      for (const user of users) {
        const u = user as Record<string, unknown>;
        const posts = await db.table('posts').findMany({
          where: { userId: u.id, published: true },
          limit: 1,
        });
        assert.ok(posts.length > 0, `User ${u.id} should have published posts`);
      }
    });

    it('none: finds users who have no posts with viewCount > 50', async () => {
      const users = await db.table('users').findMany({
        where: {
          posts: { none: { viewCount: { gt: 50 } } },
        },
        limit: 5,
      });
      // These users should have no posts with viewCount > 50
      for (const user of users) {
        const u = user as Record<string, unknown>;
        const highViewPosts = await db.table('posts').findMany({
          where: { userId: u.id, viewCount: { gt: 50 } },
        });
        assert.equal(highViewPosts.length, 0, `User ${u.id} should have no high-view posts`);
      }
    });

    it('every: finds users where all posts are published', async () => {
      const users = await db.table('users').findMany({
        where: {
          posts: { every: { published: true } },
        },
        limit: 5,
      });
      // These users should have no unpublished posts
      for (const user of users) {
        const u = user as Record<string, unknown>;
        const unpublished = await db.table('posts').findMany({
          where: { userId: u.id, published: false },
        });
        assert.equal(unpublished.length, 0, `User ${u.id} should have no unpublished posts`);
      }
    });

    it('relation filter combined with direct column filter', async () => {
      const users = await db.table('users').findMany({
        where: {
          role: 'admin',
          posts: { some: { published: true } },
        },
        limit: 10,
      });
      for (const user of users) {
        assert.equal((user as Record<string, unknown>).role, 'admin');
      }
    });
  });

  // =========================================================================
  // 7. JSONB OPERATORS
  // =========================================================================

  describe('JSONB operators', () => {
    it('jsonb contains: finds orgs containing specific JSON', async () => {
      const orgs = await db.table('organizations').findMany({
        where: {
          metadata: { contains: { tier: 'enterprise' } },
        },
      });
      assert.ok(orgs.length > 0);
      for (const org of orgs) {
        const meta = (org as Record<string, unknown>).metadata as Record<string, unknown>;
        assert.equal(meta.tier, 'enterprise');
      }
    });

    it('jsonb equals: finds orgs with exact JSON match via containment', async () => {
      const orgs = await db.table('organizations').findMany({
        where: {
          metadata: { equals: { tier: 'pro', features: ['api'], maxUsers: 25 } },
        },
      });
      assert.ok(orgs.length > 0);
    });

    it('jsonb path: finds orgs by nested JSON path value', async () => {
      const orgs = await db.table('organizations').findMany({
        where: {
          metadata: { path: ['tier'], equals: 'enterprise' },
        },
      });
      assert.ok(orgs.length > 0);
    });

    it('jsonb hasKey: finds orgs with specific JSON key', async () => {
      const orgs = await db.table('organizations').findMany({
        where: {
          metadata: { hasKey: 'tier' },
        },
      });
      assert.ok(orgs.length > 0);
    });
  });

  // =========================================================================
  // 8. ARRAY OPERATORS
  // =========================================================================

  describe('array operators', () => {
    it('array has: finds orgs with specific tag', async () => {
      const orgs = await db.table('organizations').findMany({
        where: {
          tags: { has: 'enterprise' },
        },
      });
      assert.ok(orgs.length > 0);
      for (const org of orgs) {
        const tags = (org as Record<string, unknown>).tags as string[];
        assert.ok(tags.includes('enterprise'));
      }
    });

    it('array hasEvery: finds orgs with all specified tags', async () => {
      const orgs = await db.table('organizations').findMany({
        where: {
          tags: { hasEvery: ['enterprise', 'sso'] },
        },
      });
      assert.ok(orgs.length > 0);
      for (const org of orgs) {
        const tags = (org as Record<string, unknown>).tags as string[];
        assert.ok(tags.includes('enterprise'));
        assert.ok(tags.includes('sso'));
      }
    });

    it('array hasSome: finds orgs with any of specified tags', async () => {
      const orgs = await db.table('organizations').findMany({
        where: {
          tags: { hasSome: ['enterprise', 'pro'] },
        },
      });
      assert.ok(orgs.length >= 2);
    });

    it('array isEmpty: finds orgs with empty tags', async () => {
      const orgs = await db.table('organizations').findMany({
        where: {
          tags: { isEmpty: true },
        },
      });
      // Orgs with id > 3 have empty tags
      assert.ok(orgs.length > 0);
      for (const org of orgs) {
        const tags = (org as Record<string, unknown>).tags as string[];
        assert.ok(!tags || tags.length === 0);
      }
    });

    it('array isEmpty false: finds orgs with non-empty tags', async () => {
      const orgs = await db.table('organizations').findMany({
        where: {
          tags: { isEmpty: false },
        },
      });
      assert.ok(orgs.length > 0);
      for (const org of orgs) {
        const tags = (org as Record<string, unknown>).tags as string[];
        assert.ok(tags.length > 0);
      }
    });
  });

  // =========================================================================
  // 9. CASE-INSENSITIVE SEARCH
  // =========================================================================

  describe('case-insensitive search (ILIKE)', () => {
    it('contains with mode insensitive', async () => {
      const users = await db.table('users').findMany({
        where: {
          email: { contains: 'USER1', mode: 'insensitive' },
        },
      });
      assert.ok(users.length > 0);
      for (const user of users) {
        assert.ok(((user as Record<string, unknown>).email as string).toLowerCase().includes('user1'));
      }
    });

    it('startsWith with mode insensitive', async () => {
      const users = await db.table('users').findMany({
        where: {
          email: { startsWith: 'USER', mode: 'insensitive' },
        },
      });
      assert.ok(users.length > 0);
    });

    it('endsWith with mode insensitive', async () => {
      const users = await db.table('users').findMany({
        where: {
          email: { endsWith: 'EXAMPLE.COM', mode: 'insensitive' },
        },
      });
      assert.ok(users.length > 0);
    });
  });

  // =========================================================================
  // 10. AND / NOT WHERE CLAUSES
  // =========================================================================

  describe('AND / NOT where clauses', () => {
    it('AND: explicit AND array', async () => {
      const users = await db.table('users').findMany({
        where: {
          AND: [{ role: 'admin' }, { orgId: { gt: 0 } }],
        },
      });
      for (const user of users) {
        assert.equal((user as Record<string, unknown>).role, 'admin');
      }
    });

    it('NOT: negates a condition', async () => {
      const users = await db.table('users').findMany({
        where: {
          NOT: { role: 'admin' },
        },
        limit: 10,
      });
      for (const user of users) {
        assert.notEqual((user as Record<string, unknown>).role, 'admin');
      }
    });

    it('NOT combined with OR', async () => {
      const users = await db.table('users').findMany({
        where: {
          NOT: { role: 'admin' },
          OR: [{ role: 'member' }, { role: 'editor' }],
        },
        limit: 10,
      });
      for (const user of users) {
        const role = (user as Record<string, unknown>).role;
        assert.notEqual(role, 'admin');
        assert.ok(role === 'member' || role === 'editor');
      }
    });

    it('deeply nested AND/OR/NOT', async () => {
      const users = await db.table('users').findMany({
        where: {
          AND: [
            {
              OR: [{ role: 'admin' }, { role: 'editor' }],
            },
            {
              NOT: { avatarUrl: null },
            },
          ],
        },
        limit: 10,
      });
      for (const user of users) {
        const u = user as Record<string, unknown>;
        assert.ok(u.role === 'admin' || u.role === 'editor');
        assert.ok(u.avatarUrl !== null);
      }
    });
  });

  // =========================================================================
  // 11. COMPLEX NESTED RELATIONS
  // =========================================================================

  describe('complex nested relations', () => {
    it('L3 nested with LIMIT on every level', async () => {
      const users = await db.table('users').findMany({
        limit: 3,
        with: {
          posts: {
            limit: 2,
            with: {
              comments: {
                limit: 2,
              },
            },
          },
        },
      });
      assert.ok(users.length <= 3);
      for (const user of users) {
        const u = user as Record<string, unknown>;
        const posts = u.posts as Record<string, unknown>[];
        assert.ok(Array.isArray(posts));
        assert.ok(posts.length <= 2);
        for (const post of posts) {
          const comments = post.comments as Record<string, unknown>[];
          assert.ok(Array.isArray(comments));
          assert.ok(comments.length <= 2);
        }
      }
    });

    it('L3 nested with ORDER BY on every level', async () => {
      const users = await db.table('users').findMany({
        limit: 3,
        orderBy: { id: 'asc' },
        with: {
          posts: {
            orderBy: { createdAt: 'desc' },
            limit: 5,
            with: {
              comments: {
                orderBy: { id: 'desc' },
                limit: 3,
              },
            },
          },
        },
      });
      assert.ok(users.length > 0);
      // Verify user ordering
      for (let i = 1; i < users.length; i++) {
        assert.ok(
          ((users[i] as Record<string, unknown>).id as number) >=
            ((users[i - 1] as Record<string, unknown>).id as number),
        );
      }
    });

    it('L3 nested with WHERE on every level', async () => {
      const users = await db.table('users').findMany({
        where: { role: 'member' },
        limit: 3,
        with: {
          posts: {
            where: { published: true },
            limit: 5,
            with: {
              comments: {
                limit: 3,
              },
            },
          },
        },
      });
      for (const user of users) {
        assert.equal((user as Record<string, unknown>).role, 'member');
        const posts = (user as Record<string, unknown>).posts as Record<string, unknown>[];
        for (const post of posts) {
          assert.equal(post.published, true);
        }
      }
    });

    it('L3 nested with LIMIT + ORDER BY + WHERE combined', async () => {
      const users = await db.table('users').findMany({
        where: { orgId: 1 },
        limit: 5,
        orderBy: { id: 'asc' },
        with: {
          posts: {
            where: { published: true },
            orderBy: { createdAt: 'desc' },
            limit: 3,
            with: {
              comments: {
                orderBy: { id: 'asc' },
                limit: 5,
              },
            },
          },
        },
      });
      assert.ok(Array.isArray(users));
      for (const user of users) {
        const u = user as Record<string, unknown>;
        assert.equal(u.orgId, 1);
        const posts = u.posts as Record<string, unknown>[];
        assert.ok(posts.length <= 3);
        for (const post of posts) {
          assert.equal(post.published, true);
          const comments = post.comments as Record<string, unknown>[];
          assert.ok(comments.length <= 5);
        }
      }
    });

    it('belongsTo with nested hasMany (reverse direction)', async () => {
      const posts = await db.table('posts').findMany({
        limit: 3,
        with: {
          user: {
            with: {
              posts: { limit: 2 },
            },
          },
        },
      });
      assert.ok(posts.length > 0);
      for (const post of posts) {
        const p = post as Record<string, unknown>;
        const user = p.user as Record<string, unknown>;
        assert.ok(user, 'post should have user');
        assert.ok('id' in user);
        const userPosts = user.posts as Record<string, unknown>[];
        assert.ok(Array.isArray(userPosts));
        assert.ok(userPosts.length <= 2);
      }
    });

    it('multiple sibling relations at same level', async () => {
      const users = await db.table('users').findMany({
        where: { id: 1 },
        with: {
          posts: { limit: 3 },
          organization: true,
        },
      });
      assert.ok(users.length > 0);
      const user = users[0] as Record<string, unknown>;
      assert.ok(Array.isArray(user.posts));
      assert.ok(user.organization);
      assert.ok('name' in (user.organization as Record<string, unknown>));
    });

    it('multiple sibling relations both with limits', async () => {
      const users = await db.table('users').findMany({
        where: { id: 1 },
        with: {
          posts: { limit: 2, orderBy: { id: 'asc' } },
          organization: true,
        },
      });
      assert.ok(users.length > 0);
      const user = users[0] as Record<string, unknown>;
      const posts = user.posts as Record<string, unknown>[];
      assert.ok(posts.length <= 2);
    });

    it('findUnique with L3 nested relations', async () => {
      const user = await db.table('users').findUnique({
        where: { id: 1 },
        with: {
          posts: {
            limit: 3,
            with: {
              comments: { limit: 2 },
            },
          },
        },
      });
      assert.ok(user);
      const posts = (user as Record<string, unknown>).posts as Record<string, unknown>[];
      assert.ok(Array.isArray(posts));
      assert.ok(posts.length <= 3);
      for (const post of posts) {
        const comments = post.comments as Record<string, unknown>[];
        assert.ok(Array.isArray(comments));
        assert.ok(comments.length <= 2);
      }
    });

    it('findFirst with nested relations + orderBy + limit', async () => {
      const user = await db.table('users').findFirst({
        where: { role: 'admin' },
        orderBy: { id: 'asc' },
        with: {
          posts: {
            orderBy: { createdAt: 'desc' },
            limit: 3,
          },
        },
      });
      assert.ok(user);
      const posts = (user as Record<string, unknown>).posts as Record<string, unknown>[];
      assert.ok(Array.isArray(posts));
      assert.ok(posts.length <= 3);
    });

    it('empty nested relations return empty array, never null', async () => {
      // Create a user with no posts
      const testEmail = `empty_rel_${Date.now()}@test.com`;
      const newUser = (await db.table('users').create({
        data: { email: testEmail, name: 'Empty Rel', orgId: 1, role: 'member' },
      })) as Record<string, unknown>;

      const found = await db.table('users').findUnique({
        where: { id: newUser.id },
        with: { posts: true },
      });
      assert.ok(found);
      const posts = (found as Record<string, unknown>).posts;
      assert.ok(Array.isArray(posts));
      assert.equal((posts as unknown[]).length, 0);

      // Cleanup
      await db.table('users').delete({ where: { id: newUser.id } });
    });
  });

  // =========================================================================
  // 12. CREATEMANY FEATURES
  // =========================================================================

  describe('createMany features', () => {
    it('createMany with skipDuplicates does not throw on conflict', async () => {
      const testEmail = `skip_dup_${Date.now()}@test.com`;
      // First insert
      await db.table('users').create({
        data: { email: testEmail, name: 'Skip Dup', orgId: 1, role: 'member' },
      });

      // Try to insert again with skipDuplicates — should not throw
      const result = await db.table('users').createMany({
        data: [
          { email: testEmail, name: 'Skip Dup', orgId: 1, role: 'member' },
          { email: `skip_dup2_${Date.now()}@test.com`, name: 'New User', orgId: 1, role: 'member' },
        ],
        skipDuplicates: true,
      });
      // Only the new user should be inserted
      assert.equal(result.length, 1);

      // Cleanup
      await db.table('users').deleteMany({ where: { email: { contains: 'skip_dup' } } });
    });
  });

  // =========================================================================
  // 13. AGGREGATES (extended)
  // =========================================================================

  describe('aggregate (extended)', () => {
    it('aggregate with where filter', async () => {
      const result = await db.table('posts').aggregate({
        where: { published: true },
        _count: true,
        _sum: { viewCount: true },
        _avg: { viewCount: true },
      });
      assert.ok(typeof result._count === 'number');
      assert.ok(result._count >= 0);
      assert.ok(result._sum);
      assert.ok(result._avg);
    });

    it('aggregate with per-column count', async () => {
      const result = await db.table('users').aggregate({
        _count: { avatarUrl: true, lastLoginAt: true },
      });
      assert.ok(typeof result._count === 'object');
      const countObj = result._count as Record<string, number>;
      assert.ok(typeof countObj.avatarUrl === 'number');
      assert.ok(typeof countObj.lastLoginAt === 'number');
      // avatar_url has some NULLs, so count should be less than total users
    });
  });

  // =========================================================================
  // 14. GROUPBY (extended)
  // =========================================================================

  describe('groupBy (extended)', () => {
    it('groupBy with _sum', async () => {
      const results = await db.table('posts').groupBy({
        by: ['published'],
        _sum: { viewCount: true },
      });
      assert.ok(results.length > 0);
      for (const row of results) {
        const r = row as Record<string, unknown>;
        assert.ok('published' in r);
        assert.ok('_sum' in r);
        const sum = r._sum as Record<string, unknown>;
        assert.ok(typeof sum.viewCount === 'number' || sum.viewCount === null);
      }
    });

    it('groupBy with _avg', async () => {
      const results = await db.table('posts').groupBy({
        by: ['published'],
        _avg: { viewCount: true },
      });
      assert.ok(results.length > 0);
      for (const row of results) {
        const r = row as Record<string, unknown>;
        assert.ok('_avg' in r);
      }
    });

    it('groupBy with _min and _max', async () => {
      const results = await db.table('posts').groupBy({
        by: ['published'],
        _min: { viewCount: true },
        _max: { viewCount: true },
      });
      assert.ok(results.length > 0);
      for (const row of results) {
        const r = row as Record<string, unknown>;
        assert.ok('_min' in r);
        assert.ok('_max' in r);
      }
    });

    it('groupBy with where filter', async () => {
      const results = await db.table('users').groupBy({
        by: ['role'],
        where: { orgId: 1 },
        _count: true,
      });
      assert.ok(results.length > 0);
    });

    it('groupBy with orderBy', async () => {
      const results = await db.table('users').groupBy({
        by: ['role'],
        _count: true,
        orderBy: { role: 'asc' },
      });
      assert.ok(results.length > 0);
      // Verify ordering
      for (let i = 1; i < results.length; i++) {
        const prev = (results[i - 1] as Record<string, unknown>).role as string;
        const curr = (results[i] as Record<string, unknown>).role as string;
        assert.ok(prev <= curr);
      }
    });

    it('groupBy with multiple aggregates combined', async () => {
      const results = await db.table('posts').groupBy({
        by: ['published'],
        _count: true,
        _sum: { viewCount: true },
        _avg: { viewCount: true },
        _min: { viewCount: true },
        _max: { viewCount: true },
      });
      assert.ok(results.length > 0);
      for (const row of results) {
        const r = row as Record<string, unknown>;
        assert.ok('_count' in r);
        assert.ok('_sum' in r);
        assert.ok('_avg' in r);
        assert.ok('_min' in r);
        assert.ok('_max' in r);
      }
    });
  });

  // =========================================================================
  // 15. DEFAULT LIMIT & WARN ON UNLIMITED
  // =========================================================================

  describe('defaultLimit and warnOnUnlimited', () => {
    it('defaultLimit is applied when no explicit limit', async () => {
      const limitedDb = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 2, defaultLimit: 5 }, schema);
      const users = await limitedDb.table('users').findMany();
      assert.equal(users.length, 5);
      await limitedDb.disconnect();
    });

    it('explicit limit overrides defaultLimit', async () => {
      const limitedDb = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 2, defaultLimit: 5 }, schema);
      const users = await limitedDb.table('users').findMany({ limit: 2 });
      assert.equal(users.length, 2);
      await limitedDb.disconnect();
    });

    it('warnOnUnlimited logs warning (no limit)', async () => {
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (msg: string) => warnings.push(msg);

      const warnDb = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 2, warnOnUnlimited: true }, schema);
      await warnDb.table('users').findMany({ limit: 10 }); // With limit — no warning
      assert.equal(warnings.length, 0);

      await warnDb.table('users').findMany(); // Without limit — should warn
      assert.ok(warnings.length > 0);
      assert.ok(warnings[0]!.includes('without limit'));

      console.warn = originalWarn;
      await warnDb.disconnect();
    });
  });

  // =========================================================================
  // 16. MIDDLEWARE
  // =========================================================================

  describe('middleware', () => {
    it('middleware receives correct model, action, and args', async () => {
      const calls: { model: string; action: string }[] = [];
      const mwDb = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 2 }, schema);
      mwDb.$use(async (params, next) => {
        calls.push({ model: params.model, action: params.action });
        return next(params);
      });
      await mwDb.table('users').findMany({ limit: 1 });
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.model, 'users');
      assert.equal(calls[0]!.action, 'findMany');
      await mwDb.disconnect();
    });

    it('multiple middlewares run in registration order', async () => {
      const order: number[] = [];
      const mwDb = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 2 }, schema);
      mwDb.$use(async (params, next) => {
        order.push(1);
        const result = await next(params);
        order.push(3);
        return result;
      });
      mwDb.$use(async (params, next) => {
        order.push(2);
        return next(params);
      });
      await mwDb.table('users').findMany({ limit: 1 });
      assert.deepEqual(order, [1, 2, 3]);
      await mwDb.disconnect();
    });

    it('middleware can transform results', async () => {
      const mwDb = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 2 }, schema);
      mwDb.$use(async (params, next) => {
        const result = await next(params);
        if (params.action === 'count') {
          return (result as number) * 100;
        }
        return result;
      });
      const count = await mwDb.table('users').count();
      // Should be original count * 100
      assert.ok(count > 100);
      assert.equal(count % 100, 0);
      await mwDb.disconnect();
    });
  });

  // =========================================================================
  // 17. findFirstOrThrow
  // =========================================================================

  describe('findFirstOrThrow', () => {
    it('returns first matching row', async () => {
      const user = await db.table('users').findFirstOrThrow({
        where: { role: 'admin' },
        orderBy: { id: 'asc' },
      });
      assert.ok(user);
      assert.equal((user as Record<string, unknown>).role, 'admin');
    });

    it('throws NotFoundError when no match', async () => {
      await assert.rejects(
        () => db.table('users').findFirstOrThrow({ where: { email: 'nonexistent_xyz@never.com' } }),
        (err: Error) => err instanceof NotFoundError,
      );
    });
  });

  // =========================================================================
  // 18. EDGE CASES
  // =========================================================================

  describe('edge cases', () => {
    it('special characters in string values', async () => {
      const testEmail = `special'quote"${Date.now()}@test.com`;
      const created = (await db.table('users').create({
        data: { email: testEmail, name: 'O\'Brien "The Great"', orgId: 1, role: 'member' },
      })) as Record<string, unknown>;
      assert.equal(created.name, 'O\'Brien "The Great"');

      const found = await db.table('users').findUnique({ where: { id: created.id } });
      assert.equal((found as Record<string, unknown>).name, 'O\'Brien "The Great"');

      await db.table('users').delete({ where: { id: created.id } });
    });

    it('unicode values', async () => {
      const testEmail = `unicode_${Date.now()}@test.com`;
      const created = (await db.table('users').create({
        data: { email: testEmail, name: '日本語テスト 🎉 Ñoño', orgId: 1, role: 'member' },
      })) as Record<string, unknown>;
      assert.equal(created.name, '日本語テスト 🎉 Ñoño');

      await db.table('users').delete({ where: { id: created.id } });
    });

    it('empty string values', async () => {
      // name is NOT NULL, so empty string should work
      const testEmail = `empty_str_${Date.now()}@test.com`;
      const created = (await db.table('users').create({
        data: { email: testEmail, name: '', orgId: 1, role: 'member' },
      })) as Record<string, unknown>;
      assert.equal(created.name, '');

      await db.table('users').delete({ where: { id: created.id } });
    });

    it('null handling: null equality, null inequality', async () => {
      const withNull = await db.table('users').findMany({
        where: { avatarUrl: null },
        limit: 3,
      });
      for (const user of withNull) {
        assert.equal((user as Record<string, unknown>).avatarUrl, null);
      }

      const withNotNull = await db.table('users').findMany({
        where: { avatarUrl: { not: null } },
        limit: 3,
      });
      for (const user of withNotNull) {
        assert.notEqual((user as Record<string, unknown>).avatarUrl, null);
      }
    });

    it('boolean values in where clause', async () => {
      const published = await db.table('posts').findMany({
        where: { published: true },
        limit: 3,
      });
      for (const post of published) {
        assert.equal((post as Record<string, unknown>).published, true);
      }

      const unpublished = await db.table('posts').findMany({
        where: { published: false },
        limit: 3,
      });
      for (const post of unpublished) {
        assert.equal((post as Record<string, unknown>).published, false);
      }
    });

    it('Date values are returned as Date objects', async () => {
      const user = await db.table('users').findUnique({ where: { id: 1 } });
      assert.ok(user);
      assert.ok((user as Record<string, unknown>).createdAt instanceof Date);
    });

    it('LIKE metacharacters are escaped', async () => {
      // Create a user with % and _ in name
      const testEmail = `like_escape_${Date.now()}@test.com`;
      await db.table('users').create({
        data: { email: testEmail, name: '100% complete_test', orgId: 1, role: 'member' },
      });

      // This should find the exact user, not match everything
      const found = await db.table('users').findMany({
        where: { name: { contains: '100% complete_test' } },
      });
      assert.equal(found.length, 1);
      assert.equal((found[0] as Record<string, unknown>).name, '100% complete_test');

      await db.table('users').delete({ where: { email: testEmail } });
    });

    it('empty where object returns all rows', async () => {
      const all = await db.table('organizations').findMany({ where: {} });
      const count = await db.table('organizations').count();
      assert.equal(all.length, count);
    });

    it('findMany with no args returns all rows', async () => {
      const all = await db.table('organizations').findMany();
      assert.ok(all.length > 0);
    });

    it('unknown table throws ValidationError', () => {
      assert.throws(
        () => db.table('nonexistent_table'),
        (err: Error) => err instanceof ValidationError,
      );
    });
  });

  // =========================================================================
  // 19. COMBINED OPERATORS
  // =========================================================================

  describe('combined where operators', () => {
    it('gt + lt + not combined on same column', async () => {
      const posts = await db.table('posts').findMany({
        where: {
          viewCount: { gt: 10, lt: 50, not: 25 },
        },
        limit: 10,
      });
      for (const post of posts) {
        const vc = (post as Record<string, unknown>).viewCount as number;
        assert.ok(vc > 10);
        assert.ok(vc < 50);
        assert.notEqual(vc, 25);
      }
    });

    it('multiple columns with operators simultaneously', async () => {
      const posts = await db.table('posts').findMany({
        where: {
          viewCount: { gte: 0 },
          published: true,
          title: { contains: 'e' },
        },
        limit: 10,
      });
      for (const post of posts) {
        const p = post as Record<string, unknown>;
        assert.ok((p.viewCount as number) >= 0);
        assert.equal(p.published, true);
        assert.ok((p.title as string).includes('e'));
      }
    });
  });

  // =========================================================================
  // 20. TRANSACTION EDGE CASES
  // =========================================================================

  describe('transaction edge cases', () => {
    it('transaction with multiple table operations + rollback', async () => {
      const testEmail = `tx_test_${Date.now()}@test.com`;

      await assert.rejects(async () => {
        await db.$transaction(async (tx) => {
          await tx.table('users').create({
            data: { email: testEmail, name: 'TX Test', orgId: 1, role: 'member' },
          });
          // Verify it exists within the transaction
          const found = await tx.table('users').findFirst({ where: { email: testEmail } });
          assert.ok(found);
          // Force rollback
          throw new Error('intentional rollback');
        });
      });

      // Verify the user was NOT persisted (rolled back)
      const afterRollback = await db.table('users').findFirst({ where: { email: testEmail } });
      assert.equal(afterRollback, null);
    });

    it('nested savepoint rollback does not affect outer transaction', async () => {
      const testEmail1 = `sp_outer_${Date.now()}@test.com`;
      const testEmail2 = `sp_inner_${Date.now()}@test.com`;

      await db.$transaction(async (tx) => {
        // Outer: create user 1
        await tx.table('users').create({
          data: { email: testEmail1, name: 'Outer', orgId: 1, role: 'member' },
        });

        // Inner savepoint: create user 2, then rollback
        try {
          await tx.$transaction(async (innerTx) => {
            await innerTx.table('users').create({
              data: { email: testEmail2, name: 'Inner', orgId: 1, role: 'member' },
            });
            throw new Error('inner rollback');
          });
        } catch {
          // Expected
        }

        // User 1 should still exist, user 2 should not
        const found1 = await tx.table('users').findFirst({ where: { email: testEmail1 } });
        assert.ok(found1);
        const found2 = await tx.table('users').findFirst({ where: { email: testEmail2 } });
        assert.equal(found2, null);
      });

      // Cleanup
      await db.table('users').delete({ where: { email: testEmail1 } });
    });
  });

  // =========================================================================
  // 21. PIPELINE (extended)
  // =========================================================================

  describe('pipeline (extended)', () => {
    it('pipeline with mixed query types', async () => {
      const [user, count, posts] = await db.pipeline(
        db.table('users').buildFindUnique({ where: { id: 1 } }),
        db.table('posts').buildCount({ where: { published: true } }),
        db.table('posts').buildFindMany({ where: { userId: 1 }, limit: 3 }),
      );
      assert.ok(user);
      assert.ok(typeof count === 'number');
      assert.ok(Array.isArray(posts));
    });

    it('empty pipeline returns empty array', async () => {
      const results = await db.pipeline();
      assert.deepEqual(results, []);
    });
  });

  // =========================================================================
  // 22. STREAMING (extended)
  // =========================================================================

  describe('findManyStream (extended)', () => {
    it('stream with where + orderBy + limit + nested relations', async () => {
      const collected: Record<string, unknown>[] = [];
      for await (const user of db.table('users').findManyStream({
        where: { role: 'member' },
        orderBy: { id: 'asc' },
        limit: 5,
        batchSize: 2,
        with: {
          posts: {
            limit: 2,
            orderBy: { id: 'asc' },
          },
        },
      })) {
        collected.push(user as Record<string, unknown>);
      }
      assert.ok(collected.length <= 5);
      for (const user of collected) {
        assert.equal(user.role, 'member');
        const posts = user.posts as unknown[];
        assert.ok(Array.isArray(posts));
        assert.ok(posts.length <= 2);
      }
      // Verify ordering
      for (let i = 1; i < collected.length; i++) {
        assert.ok((collected[i]!.id as number) >= (collected[i - 1]!.id as number));
      }
    });
  });

  // =========================================================================
  // 23. SQL CACHE BEHAVIOR
  // =========================================================================

  describe('SQL cache', () => {
    it('repeated identical queries work correctly (cache hit path)', async () => {
      const q = db.table('users');
      // Execute same query multiple times — exercises LRU cache
      const r1 = await q.findUnique({ where: { id: 1 } });
      const r2 = await q.findUnique({ where: { id: 1 } });
      const r3 = await q.findUnique({ where: { id: 2 } });
      assert.deepEqual((r1 as Record<string, unknown>).id, (r2 as Record<string, unknown>).id);
      assert.notEqual((r1 as Record<string, unknown>).id, (r3 as Record<string, unknown>).id);
    });
  });

  // =========================================================================
  // 24. FINDUNIQUE WITH OPERATORS
  // =========================================================================

  describe('findUnique with complex where', () => {
    it('findUnique with null in where (non-cached path)', async () => {
      const user = await db.table('users').findUnique({
        where: { id: 1, avatarUrl: null },
      });
      // May or may not find a user depending on data — just should not throw
      if (user) {
        assert.equal((user as Record<string, unknown>).avatarUrl, null);
      }
    });

    it('findUnique with operator where (non-cached path)', async () => {
      const user = await db.table('users').findUnique({
        where: { id: { gt: 0, lt: 2 } },
      });
      if (user) {
        assert.equal((user as Record<string, unknown>).id, 1);
      }
    });

    it('findUnique with OR (non-cached path)', async () => {
      const user = await db.table('users').findUnique({
        where: { OR: [{ id: 1 }, { id: 2 }] },
      });
      assert.ok(user);
      const id = (user as Record<string, unknown>).id as number;
      assert.ok(id === 1 || id === 2);
    });
  });
});
