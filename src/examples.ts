/**
 * turbine-orm — SDK Examples
 *
 * Comprehensive examples showing every query pattern.
 * Run with: npx tsx src/examples.ts
 *
 * Requires a running Postgres instance with the Turbine benchmark schema loaded.
 * Connection: postgres://turbine:turbine_bench@localhost:5433/turbine_bench
 */

import { TurbineClient } from './client.js';
import type {
  User,
  Post,
  Comment,
  Organization,
  UserWithPosts,
  UserWithPostsAndComments,
  OrgWithEverything,
} from './types.js';

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

const db = new TurbineClient({
  connectionString:
    process.env['DATABASE_URL'] ??
    'postgres://turbine:turbine_bench@localhost:5433/turbine_bench',
  poolSize: 10,
  logging: true,
});

async function main() {
  // Verify connection
  await db.connect();
  console.log('\n=== Turbine SDK Examples ===\n');

  // =========================================================================
  // 1. BASIC CRUD
  // =========================================================================

  console.log('--- 1. Basic CRUD ---\n');

  // -------------------------------------------------------------------------
  // findUnique — SELECT single row by primary key
  // -------------------------------------------------------------------------
  const user = await db.users.findUnique({
    where: { id: 1 },
  });
  console.log('findUnique user #1:', user?.name);

  // -------------------------------------------------------------------------
  // findMany — SELECT multiple rows with filters, ordering, pagination
  // -------------------------------------------------------------------------
  const members = await db.users.findMany({
    where: { orgId: 1, role: 'member' },
    orderBy: { createdAt: 'desc' },
    limit: 20,
  });
  console.log(`findMany members in org #1: ${members.length} rows`);

  // findMany — all posts, ordered by creation date
  const recentPosts = await db.posts.findMany({
    orderBy: { createdAt: 'desc' },
    limit: 5,
  });
  console.log(`findMany recent posts: ${recentPosts.length} rows`);

  // findMany — with offset for pagination
  const page2 = await db.users.findMany({
    where: { orgId: 1 },
    orderBy: { name: 'asc' },
    limit: 10,
    offset: 10,
  });
  console.log(`findMany page 2 users: ${page2.length} rows`);

  // -------------------------------------------------------------------------
  // create — INSERT single row, returns the created entity
  // -------------------------------------------------------------------------
  const newPost = await db.posts.create({
    data: {
      userId: 1,
      orgId: 1,
      title: 'Turbine SDK is live',
      content: 'Building the fastest Postgres ORM in TypeScript.',
      published: true,
    },
  });
  console.log('create post:', newPost.id, newPost.title);

  // -------------------------------------------------------------------------
  // createMany — Batch INSERT using UNNEST (100 comments in one query)
  // -------------------------------------------------------------------------
  const newComments = await db.comments.createMany({
    data: Array.from({ length: 100 }, (_, i) => ({
      postId: newPost.id,
      userId: ((i % 10) + 1),
      body: `Benchmark comment #${i + 1} — Turbine is fast!`,
    })),
  });
  console.log(`createMany comments: ${newComments.length} rows inserted`);

  // -------------------------------------------------------------------------
  // update — UPDATE row, returns the updated entity
  // -------------------------------------------------------------------------
  const updatedPost = await db.posts.update({
    where: { id: newPost.id },
    data: {
      title: 'Turbine SDK is live (updated)',
      content: 'Now with pipeline batching and nested relations.',
    },
  });
  console.log('update post:', updatedPost.id, updatedPost.title);

  // -------------------------------------------------------------------------
  // delete — DELETE row, returns the deleted entity
  // -------------------------------------------------------------------------

  // Clean up the comments we created first (FK constraint)
  for (const comment of newComments) {
    await db.comments.delete({ where: { id: comment.id } });
  }
  const deletedPost = await db.posts.delete({
    where: { id: newPost.id },
  });
  console.log('delete post:', deletedPost.id, deletedPost.title);

  // =========================================================================
  // 2. AGGREGATES
  // =========================================================================

  console.log('\n--- 2. Aggregates ---\n');

  // -------------------------------------------------------------------------
  // count — COUNT rows with optional filter
  // -------------------------------------------------------------------------
  const totalUsers = await db.users.count();
  console.log('count all users:', totalUsers);

  const orgMembers = await db.users.count({
    where: { orgId: 1, role: 'member' },
  });
  console.log('count members in org #1:', orgMembers);

  const publishedPosts = await db.posts.count({
    where: { published: true },
  });
  console.log('count published posts:', publishedPosts);

  // -------------------------------------------------------------------------
  // groupBy — GROUP BY with count
  // -------------------------------------------------------------------------
  const roleBreakdown = await db.users.groupBy({
    by: ['orgId', 'role'],
    where: { orgId: 1 },
  });
  console.log('groupBy roles in org #1:', roleBreakdown);

  // =========================================================================
  // 3. NESTED QUERIES — The main selling point
  // =========================================================================

  console.log('\n--- 3. Nested Queries ---\n');

  // -------------------------------------------------------------------------
  // Level 2: users -> posts
  // -------------------------------------------------------------------------
  const userWithPosts = await db.users.findUnique({
    where: { id: 1 },
    with: { posts: true },
  });
  console.log(
    `Nested L2 — user #${userWithPosts?.id} has ${(userWithPosts as unknown as UserWithPosts | null)?.posts?.length ?? 0} posts`,
  );

  // -------------------------------------------------------------------------
  // Level 3: users -> posts -> comments (with filters on posts)
  // -------------------------------------------------------------------------
  const userFull = await db.users.findUnique({
    where: { id: 1 },
    with: {
      posts: {
        with: { comments: true },
        where: { published: true },
        orderBy: { createdAt: 'desc' },
      },
    },
  });
  const fullPosts = (userFull as unknown as UserWithPostsAndComments | null)?.posts ?? [];
  console.log(
    `Nested L3 — user #${userFull?.id}: ${fullPosts.length} published posts, ` +
      `${fullPosts.reduce((sum, p) => sum + (p.comments?.length ?? 0), 0)} total comments`,
  );

  // -------------------------------------------------------------------------
  // Level 4: organizations -> users -> posts -> comments
  // -------------------------------------------------------------------------
  const org = await db.organizations.findUnique({
    where: { id: 1 },
    with: {
      users: {
        with: {
          posts: {
            with: { comments: true },
            where: { published: true },
          },
        },
      },
    },
  });
  const orgUsers = (org as unknown as OrgWithEverything | null)?.users ?? [];
  const orgPostCount = orgUsers.reduce((sum, u) => sum + (u.posts?.length ?? 0), 0);
  console.log(
    `Nested L4 — org "${org?.name}": ${orgUsers.length} users, ${orgPostCount} published posts`,
  );

  // -------------------------------------------------------------------------
  // Nested findMany — load all users with their posts
  // -------------------------------------------------------------------------
  const usersWithPosts = await db.users.findMany({
    where: { orgId: 1 },
    orderBy: { name: 'asc' },
    limit: 5,
    with: { posts: true },
  });
  console.log(
    `Nested findMany — ${usersWithPosts.length} users with posts loaded`,
  );

  // =========================================================================
  // 4. PIPELINE — Multiple queries in one round-trip
  // =========================================================================

  console.log('\n--- 4. Pipeline ---\n');

  const userId = 1;
  const orgId = 1;

  // -------------------------------------------------------------------------
  // 5 independent queries batched into 1 round-trip
  // -------------------------------------------------------------------------
  const [
    pipeUser,
    postCount,
    pipeRecentPosts,
    commentCount,
    topContributors,
  ] = await db.pipeline(
    db.users.buildFindUnique({ where: { id: userId } }),
    db.posts.buildCount({ where: { orgId } }),
    db.posts.buildFindMany({ where: { userId }, orderBy: { createdAt: 'desc' }, limit: 10 }),
    db.comments.buildCount({}),
    db.users.buildFindMany({ where: { orgId }, orderBy: { name: 'asc' }, limit: 5 }),
  );

  console.log(`Pipeline result [0] — user: ${pipeUser?.name}`);
  console.log(`Pipeline result [1] — post count for org: ${postCount}`);
  console.log(`Pipeline result [2] — recent posts: ${pipeRecentPosts.length}`);
  console.log(`Pipeline result [3] — total comments: ${commentCount}`);
  console.log(`Pipeline result [4] — top contributors: ${topContributors.map((u) => u.name).join(', ')}`);

  // -------------------------------------------------------------------------
  // Pipeline with mixed query types (create + read)
  // -------------------------------------------------------------------------
  const [newOrg, allOrgs] = await db.pipeline(
    db.organizations.buildCreate({
      data: {
        name: 'Pipeline Test Org',
        slug: `pipeline-test-${Date.now()}`,
        plan: 'pro',
      },
    }),
    db.organizations.buildFindMany({ orderBy: { createdAt: 'desc' }, limit: 5 }),
  );
  console.log(`Pipeline create + read — new org: ${newOrg.name}, total recent orgs: ${allOrgs.length}`);

  // Clean up
  await db.organizations.delete({ where: { id: newOrg.id } });

  // =========================================================================
  // 5. RAW SQL — Escape hatch for complex queries
  // =========================================================================

  console.log('\n--- 5. Raw SQL ---\n');

  // -------------------------------------------------------------------------
  // Tagged template literal with parameterized values
  // -------------------------------------------------------------------------
  const rawOrgId = 1;
  const postsByDay = await db.raw<{ day: Date; count: number }>`
    SELECT DATE_TRUNC('day', created_at) as day, COUNT(*)::int as count
    FROM posts
    WHERE org_id = ${rawOrgId}
    GROUP BY day
    ORDER BY day DESC
    LIMIT 7
  `;
  console.log(`Raw SQL — posts by day (last 7):`, postsByDay);

  // -------------------------------------------------------------------------
  // More complex raw query: top users by post count
  // -------------------------------------------------------------------------
  const topAuthors = await db.raw<{ userName: string; postCount: number }>`
    SELECT u.name as user_name, COUNT(p.id)::int as post_count
    FROM users u
    LEFT JOIN posts p ON p.user_id = u.id
    WHERE u.org_id = ${rawOrgId}
    GROUP BY u.id, u.name
    ORDER BY post_count DESC
    LIMIT 5
  `;
  console.log('Raw SQL — top authors:', topAuthors);

  // =========================================================================
  // 6. POOL STATS — Monitoring
  // =========================================================================

  console.log('\n--- 6. Pool Stats ---\n');
  console.log('Pool:', db.stats);

  // =========================================================================
  // Cleanup
  // =========================================================================

  await db.disconnect();
  console.log('\n=== Done ===\n');
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error('Example failed:', err);
  process.exit(1);
});
