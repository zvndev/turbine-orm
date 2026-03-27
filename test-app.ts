/**
 * Turbine ORM — Test Application
 *
 * Exercises every major ORM feature against a real Postgres database.
 * Uses the generated typed client for full type safety.
 *
 * Run: DATABASE_URL=postgres://localhost:5432/turbine_bench npx tsx test-app.ts
 */

import { TurbineClient } from './generated/turbine/index.js';
import type { Organization, User, Post, Comment } from './generated/turbine/types.js';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/turbine_bench';

const db = new TurbineClient({ connectionString: DATABASE_URL, logging: false });

// ─── Helpers ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function ok(label: string) {
  passed++;
  console.log(`  ✓ ${label}`);
}

function fail(label: string, err: unknown) {
  failed++;
  console.log(`  ✗ ${label}`);
  console.log(`    ${err instanceof Error ? err.message : String(err)}`);
}

async function test(label: string, fn: () => Promise<void>) {
  try {
    await fn();
    ok(label);
  } catch (err) {
    fail(label, err);
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   @batadata/turbine — Test Application       ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  await db.connect();
  console.log(`Connected to: ${DATABASE_URL}\n`);

  // ─── 1. Schema Introspection ─────────────────────────────────────────────

  console.log('── 1. Schema & Connection ──');

  await test('Pool stats are available', async () => {
    const stats = db.stats;
    assert(typeof stats.totalCount === 'number', 'totalCount should be number');
    assert(typeof stats.idleCount === 'number', 'idleCount should be number');
  });

  await test('Schema has 4 tables', async () => {
    const tables = Object.keys(db.schema.tables);
    assert(tables.length === 4, `Expected 4 tables, got ${tables.length}`);
    assert(tables.includes('users'), 'Missing users table');
    assert(tables.includes('posts'), 'Missing posts table');
    assert(tables.includes('comments'), 'Missing comments table');
    assert(tables.includes('organizations'), 'Missing organizations table');
  });

  await test('Table accessors are typed', async () => {
    // These should compile — typed accessors from generated client
    assert(typeof db.users !== 'undefined', 'db.users should exist');
    assert(typeof db.posts !== 'undefined', 'db.posts should exist');
    assert(typeof db.comments !== 'undefined', 'db.comments should exist');
    assert(typeof db.organizations !== 'undefined', 'db.organizations should exist');
  });

  // ─── 2. Basic Reads ──────────────────────────────────────────────────────

  console.log('\n── 2. Basic Reads ──');

  await test('findUnique — get user by id', async () => {
    const user = await db.users.findUnique({ where: { id: 1 } });
    assert(user !== null, 'User #1 should exist');
    assert(user!.id === 1, 'ID should be 1');
    assert(typeof user!.email === 'string', 'email should be string');
    assert(typeof user!.name === 'string', 'name should be string');
    assert(typeof user!.orgId === 'number', 'orgId should be number (camelCase)');
    assert(user!.createdAt instanceof Date, 'createdAt should be Date');
    console.log(`    → User: ${user!.name} (${user!.email})`);
  });

  await test('findUnique — returns null for missing record', async () => {
    const ghost = await db.users.findUnique({ where: { id: 999999 } });
    assert(ghost === null, 'Should return null');
  });

  await test('findMany — paginated, ordered', async () => {
    const page1 = await db.users.findMany({ orderBy: { id: 'asc' }, limit: 5 });
    const page2 = await db.users.findMany({ orderBy: { id: 'asc' }, limit: 5, offset: 5 });
    assert(page1.length === 5, `Page 1 should have 5 rows, got ${page1.length}`);
    assert(page2.length === 5, `Page 2 should have 5 rows, got ${page2.length}`);
    assert(page1[0]!.id < page2[0]!.id, 'Page 2 should have higher IDs');
    console.log(`    → Page 1 IDs: [${page1.map(u => u.id).join(', ')}]`);
    console.log(`    → Page 2 IDs: [${page2.map(u => u.id).join(', ')}]`);
  });

  await test('findMany — with where filter', async () => {
    const admins = await db.users.findMany({ where: { role: 'admin' }, limit: 10 });
    assert(admins.length > 0, 'Should find admins');
    for (const admin of admins) {
      assert(admin.role === 'admin', `Expected admin role, got ${admin.role}`);
    }
    console.log(`    → Found ${admins.length} admins`);
  });

  // ─── 3. Aggregations ─────────────────────────────────────────────────────

  console.log('\n── 3. Aggregations ──');

  await test('count — all users', async () => {
    const total = await db.users.count();
    assert(total === 100, `Expected 100 users, got ${total}`);
    console.log(`    → Total users: ${total}`);
  });

  await test('count — filtered', async () => {
    const published = await db.posts.count({ where: { published: true } });
    const all = await db.posts.count();
    assert(published > 0, 'Should have published posts');
    assert(published <= all, 'Published should be <= total');
    console.log(`    → Published: ${published} / ${all} total posts`);
  });

  await test('groupBy — users by role', async () => {
    const groups = await db.users.groupBy({ by: ['role'] });
    assert(groups.length > 0, 'Should have role groups');
    console.log(`    → Roles: ${groups.map(g => `${(g as Record<string, unknown>).role}: ${(g as Record<string, unknown>).count}`).join(', ')}`);
  });

  // ─── 4. Nested Relations (json_agg) ──────────────────────────────────────

  console.log('\n── 4. Nested Relations (core json_agg feature) ──');

  await test('L2: user → posts (hasMany)', async () => {
    const user = await db.users.findUnique({
      where: { id: 1 },
      with: { posts: true },
    });
    assert(user !== null, 'User should exist');
    const posts = (user as unknown as User & { posts: Post[] }).posts;
    assert(Array.isArray(posts), 'posts should be array');
    assert(posts.length > 0, 'User #1 should have posts');
    assert(typeof posts[0]!.title === 'string', 'Post should have title');
    console.log(`    → User "${user!.name}" has ${posts.length} posts`);
  });

  await test('L2: post → user (belongsTo)', async () => {
    const post = await db.posts.findUnique({
      where: { id: 1 },
      with: { user: true },
    });
    assert(post !== null, 'Post should exist');
    const author = (post as unknown as Post & { user: User }).user;
    assert(author !== null, 'Post should have an author');
    assert(typeof author.name === 'string', 'Author should have name');
    console.log(`    → Post "${post!.title.slice(0, 40)}..." by ${author.name}`);
  });

  await test('L3: user → posts → comments (deep nest)', async () => {
    const user = await db.users.findUnique({
      where: { id: 1 },
      with: {
        posts: {
          with: { comments: true },
          limit: 3,
        },
      },
    });
    assert(user !== null, 'User should exist');
    const posts = (user as unknown as User & { posts: (Post & { comments: Comment[] })[] }).posts;
    assert(posts.length > 0, 'Should have posts');
    let totalComments = 0;
    for (const p of posts) {
      assert(Array.isArray(p.comments), 'comments should be array');
      totalComments += p.comments.length;
    }
    console.log(`    → ${posts.length} posts with ${totalComments} total comments`);
  });

  await test('L4: org → users → posts → comments (deepest nest)', async () => {
    const org = await db.organizations.findUnique({
      where: { id: 1 },
      with: {
        users: {
          limit: 3,
          with: {
            posts: {
              limit: 2,
              with: { comments: { limit: 2 } },
            },
          },
        },
      },
    });
    assert(org !== null, 'Org should exist');
    const users = (org as unknown as Organization & { users: (User & { posts: (Post & { comments: Comment[] })[] })[] }).users;
    assert(users.length > 0, 'Org should have users');
    let postCount = 0;
    let commentCount = 0;
    for (const u of users) {
      postCount += u.posts.length;
      for (const p of u.posts) {
        commentCount += p.comments.length;
      }
    }
    console.log(`    → Org "${org!.name}": ${users.length} users, ${postCount} posts, ${commentCount} comments`);
  });

  await test('Nested with where + orderBy + limit', async () => {
    const user = await db.users.findUnique({
      where: { id: 1 },
      with: {
        posts: {
          where: { published: true },
          orderBy: { createdAt: 'desc' },
          limit: 5,
        },
      },
    });
    assert(user !== null, 'User should exist');
    const posts = (user as unknown as User & { posts: Post[] }).posts;
    assert(posts.length <= 5, `Should respect limit, got ${posts.length}`);
    for (const p of posts) {
      assert(p.published === true, 'All posts should be published');
    }
    // Check ordering
    for (let i = 1; i < posts.length; i++) {
      assert(
        new Date(posts[i - 1]!.createdAt).getTime() >= new Date(posts[i]!.createdAt).getTime(),
        'Posts should be ordered desc',
      );
    }
    console.log(`    → ${posts.length} published posts (ordered desc)`);
  });

  await test('findMany with nested relations', async () => {
    const users = await db.users.findMany({
      where: { orgId: 1 },
      limit: 3,
      with: { posts: { limit: 2 } },
    });
    assert(users.length > 0, 'Should find users');
    for (const u of users as unknown as (User & { posts: Post[] })[]) {
      assert(Array.isArray(u.posts), 'Each user should have posts array');
    }
    console.log(`    → ${users.length} users each with nested posts`);
  });

  // ─── 5. CRUD Mutations ───────────────────────────────────────────────────

  console.log('\n── 5. CRUD Mutations ──');

  let testOrgId: number;
  let testUserId: number;
  let testPostId: number;

  await test('create — organization', async () => {
    const org = await db.organizations.create({
      data: { name: 'Test App Org', slug: `test-app-${Date.now()}` },
    });
    assert(org.id > 0, 'Should have an ID');
    assert(org.name === 'Test App Org', 'Name should match');
    assert(org.plan === 'free', 'Default plan should be free');
    testOrgId = org.id;
    console.log(`    → Created org #${org.id}: ${org.name}`);
  });

  await test('create — user', async () => {
    const user = await db.users.create({
      data: {
        orgId: testOrgId,
        email: `test-${Date.now()}@example.com`,
        name: 'Test User',
        role: 'admin',
      },
    });
    assert(user.id > 0, 'Should have an ID');
    assert(user.orgId === testOrgId, 'org_id should match');
    assert(user.role === 'admin', 'role should be admin');
    testUserId = user.id;
    console.log(`    → Created user #${user.id}: ${user.name}`);
  });

  await test('create — post', async () => {
    const post = await db.posts.create({
      data: {
        userId: testUserId,
        orgId: testOrgId,
        title: 'Turbine Test Post',
        content: 'Testing the ORM end-to-end.',
        published: true,
      },
    });
    assert(post.id > 0, 'Should have an ID');
    assert(post.published === true, 'Should be published');
    testPostId = post.id;
    console.log(`    → Created post #${post.id}: ${post.title}`);
  });

  await test('update — post', async () => {
    const updated = await db.posts.update({
      where: { id: testPostId },
      data: { title: 'Turbine Test Post (updated)', viewCount: 42 },
    });
    assert(updated.title === 'Turbine Test Post (updated)', 'Title should update');
    assert(updated.viewCount === 42, 'viewCount should update');
    console.log(`    → Updated: "${updated.title}", views: ${updated.viewCount}`);
  });

  await test('createMany — batch insert comments', async () => {
    const comments = await db.comments.createMany({
      data: Array.from({ length: 10 }, (_, i) => ({
        postId: testPostId,
        userId: testUserId,
        body: `Test comment #${i + 1}`,
      })),
    });
    assert(comments.length === 10, `Expected 10, got ${comments.length}`);
    console.log(`    → Batch inserted ${comments.length} comments`);
  });

  await test('verify — nested read of created data', async () => {
    const post = await db.posts.findUnique({
      where: { id: testPostId },
      with: {
        user: true,
        comments: true,
      },
    });
    assert(post !== null, 'Post should exist');
    const full = post as unknown as Post & { user: User; comments: Comment[] };
    assert(full.user.name === 'Test User', 'Author should be Test User');
    assert(full.comments.length === 10, `Should have 10 comments, got ${full.comments.length}`);
    console.log(`    → Post with author "${full.user.name}" and ${full.comments.length} comments`);
  });

  // Clean up mutations
  await test('delete — cascade cleanup', async () => {
    // Delete comments first (FK), then post, then user, then org
    const comments = await db.comments.findMany({ where: { postId: testPostId } });
    for (const c of comments) {
      await db.comments.delete({ where: { id: c.id } });
    }
    await db.posts.delete({ where: { id: testPostId } });
    await db.users.delete({ where: { id: testUserId } });
    await db.organizations.delete({ where: { id: testOrgId } });

    // Verify cleanup
    const gone = await db.organizations.findUnique({ where: { id: testOrgId } });
    assert(gone === null, 'Org should be deleted');
    console.log(`    → Cleaned up all test records`);
  });

  // ─── 6. Pipeline (Batch Queries) ─────────────────────────────────────────

  console.log('\n── 6. Pipeline (Batch Queries) ──');

  await test('pipeline — 4 queries in one round-trip', async () => {
    const [user, postCount, recentPosts, orgCount] = await db.pipeline(
      db.users.buildFindUnique({ where: { id: 1 } }),
      db.posts.buildCount(),
      db.posts.buildFindMany({ orderBy: { id: 'desc' }, limit: 3 }),
      db.organizations.buildCount(),
    );

    assert(user !== null, 'User should exist');
    assert(typeof postCount === 'number' && postCount > 0, 'Should have posts');
    assert(recentPosts.length === 3, 'Should have 3 recent posts');
    assert(typeof orgCount === 'number' && orgCount > 0, 'Should have orgs');
    console.log(`    → User: ${user!.name}, Posts: ${postCount}, Orgs: ${orgCount}`);
  });

  // ─── 7. Raw SQL ──────────────────────────────────────────────────────────

  console.log('\n── 7. Raw SQL ──');

  await test('raw SQL — tagged template with params', async () => {
    const orgId = 1;
    const result = await db.raw<{ count: number }>`
      SELECT COUNT(*)::int AS count FROM users WHERE org_id = ${orgId}
    `;
    assert(result.length === 1, 'Should return one row');
    assert(typeof result[0]!.count === 'number', 'count should be number');
    console.log(`    → Users in org #1: ${result[0]!.count}`);
  });

  await test('raw SQL — complex aggregation', async () => {
    // Note: raw SQL returns snake_case column names (no auto-conversion)
    const result = await db.raw<{ org_name: string; user_count: number; post_count: number }>`
      SELECT
        o.name AS org_name,
        COUNT(DISTINCT u.id)::int AS user_count,
        COUNT(DISTINCT p.id)::int AS post_count
      FROM organizations o
      LEFT JOIN users u ON u.org_id = o.id
      LEFT JOIN posts p ON p.org_id = o.id
      GROUP BY o.id, o.name
      ORDER BY post_count DESC
      LIMIT 5
    `;
    assert(result.length > 0, 'Should have results');
    console.log('    → Top orgs by post count:');
    for (const r of result) {
      console.log(`      ${r.org_name}: ${r.user_count} users, ${r.post_count} posts`);
    }
  });

  // ─── 8. Transactions ─────────────────────────────────────────────────────

  console.log('\n── 8. Transactions ──');

  await test('transaction — commit', async () => {
    const slug = `tx-commit-${Date.now()}`;
    await db.transaction(async (client) => {
      await client.query('INSERT INTO organizations (name, slug) VALUES ($1, $2)', ['TX Org', slug]);
    });
    const org = await db.organizations.findUnique({ where: { slug } });
    assert(org !== null, 'Org should exist after commit');
    await db.organizations.delete({ where: { id: org!.id } });
    console.log(`    → Created and verified org in transaction`);
  });

  await test('transaction — rollback on error', async () => {
    const slug = `tx-rollback-${Date.now()}`;
    try {
      await db.transaction(async (client) => {
        await client.query('INSERT INTO organizations (name, slug) VALUES ($1, $2)', ['TX Rollback', slug]);
        throw new Error('Intentional rollback');
      });
    } catch {
      // Expected
    }
    const org = await db.organizations.findUnique({ where: { slug } });
    assert(org === null, 'Org should NOT exist after rollback');
    console.log(`    → Verified rollback — no orphan data`);
  });

  // ─── 9. SQL Injection Prevention ──────────────────────────────────────────

  console.log('\n── 9. Security ──');

  await test('SQL injection — where clause is parameterized', async () => {
    const result = await db.users.findUnique({
      where: { email: "'; DROP TABLE users; --" },
    });
    assert(result === null, 'Should return null, not crash');
    // Verify table still exists
    const count = await db.users.count();
    assert(count > 0, 'users table should still exist');
    console.log(`    → Injection attempt safely neutralized (${count} users intact)`);
  });

  await test('SQL injection — nested where is parameterized', async () => {
    const result = await db.users.findUnique({
      where: { id: 1 },
      with: { posts: { where: { title: "'; DROP TABLE posts; --" } } },
    });
    assert(result !== null, 'User should still exist');
    const postCount = await db.posts.count();
    assert(postCount > 0, 'posts table should still exist');
    console.log(`    → Nested injection neutralized (${postCount} posts intact)`);
  });

  // ─── 10. Edge Cases ───────────────────────────────────────────────────────

  console.log('\n── 10. Edge Cases ──');

  await test('empty relations return [] not null', async () => {
    // Create a user with no posts
    const org = await db.organizations.create({
      data: { name: 'Empty Test', slug: `empty-${Date.now()}` },
    });
    const user = await db.users.create({
      data: { orgId: org.id, email: `empty-${Date.now()}@test.com`, name: 'No Posts' },
    });
    const result = await db.users.findUnique({
      where: { id: user.id },
      with: { posts: true },
    });
    const posts = (result as unknown as User & { posts: Post[] }).posts;
    assert(Array.isArray(posts), 'Should be array');
    assert(posts.length === 0, 'Should be empty array');
    // Cleanup
    await db.users.delete({ where: { id: user.id } });
    await db.organizations.delete({ where: { id: org.id } });
    console.log(`    → Empty relation correctly returns []`);
  });

  await test('createMany with empty array returns []', async () => {
    const result = await db.organizations.createMany({ data: [] });
    assert(result.length === 0, 'Should return empty array');
    console.log(`    → Empty createMany returns []`);
  });

  await test('unknown relation throws clear error', async () => {
    try {
      await db.users.findUnique({ where: { id: 1 }, with: { doesNotExist: true } });
      throw new Error('Should have thrown');
    } catch (err) {
      assert(
        err instanceof Error && err.message.includes('Unknown relation'),
        `Expected 'Unknown relation' error, got: ${err}`,
      );
    }
    console.log(`    → Unknown relation throws descriptive error`);
  });

  // ─── Summary ──────────────────────────────────────────────────────────────

  await db.disconnect();

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log(`║   Results: ${passed} passed, ${failed} failed${' '.repeat(Math.max(0, 20 - String(passed).length - String(failed).length))}║`);
  console.log('╚══════════════════════════════════════════════╝\n');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
