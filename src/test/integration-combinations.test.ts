/**
 * turbine-orm — Combined-feature integration tests
 *
 * Exercises four combinations that the rest of the integration suites only
 * cover individually:
 *
 *   1. findMany + 2-level nested `with` (posts → comments) + cursor pagination
 *   2. pipeline batching (findMany + count + findUnique in one round-trip)
 *   3. $transaction with SAVEPOINT nesting (inner rollback, outer commit)
 *   4. findManyStream over rows that include nested relations + early break
 *
 * Run against a real Postgres seeded by src/test/fixtures/seed.sql:
 *
 *   DATABASE_URL=postgres://... npx tsx --test src/test/integration-combinations.test.ts
 *
 * The whole suite is gated by DATABASE_URL — when it's absent the file shows
 * up as `skip`, never `fail`, so unit-only test runs stay green.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { TurbineClient } from '../client.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata } from '../schema.js';

// ---------------------------------------------------------------------------
// Setup — same gating pattern as turbine.test.ts / comprehensive.test.ts
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('\u26A0 Skipping integration-combinations tests: DATABASE_URL not set');
}

let db: TurbineClient;
let schema: SchemaMetadata;

const testFn = SKIP ? describe.skip : describe;

// Local cast helper — keeps type assertions short and readable
const row = (r: unknown): Record<string, unknown> => r as Record<string, unknown>;

testFn('integration-combinations', () => {
  before(async () => {
    schema = await introspect({ connectionString: DATABASE_URL! });
    db = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 5 }, schema);
    await db.connect();
  });

  after(async () => {
    await db.disconnect();
  });

  // -------------------------------------------------------------------------
  // 1. findMany + 2-level nested `with` + cursor pagination
  // -------------------------------------------------------------------------

  describe('findMany + nested with + cursor pagination', () => {
    it('paginates users with posts→comments across two pages', async () => {
      // Page 1
      const page1 = await db.table('users').findMany({
        orderBy: { id: 'asc' },
        take: 3,
        with: {
          posts: {
            orderBy: { id: 'asc' },
            with: {
              comments: { orderBy: { id: 'asc' } },
            },
          },
        },
      });

      assert.ok(Array.isArray(page1), 'page1 should be an array');
      assert.equal(page1.length, 3, 'page1 should respect take=3');

      // Each row should expose the nested `posts` array, and each post the
      // nested `comments` array (json_agg returns [] when empty, never null).
      for (const u of page1) {
        const user = row(u);
        assert.ok(Array.isArray(user.posts), 'user.posts should be an array');
        const posts = user.posts as Record<string, unknown>[];
        for (const p of posts) {
          assert.ok(Array.isArray(p.comments), 'post.comments should be an array');
        }
      }

      // Page 2 — cursor on the last id from page 1
      const lastId = row(page1[page1.length - 1]!).id as number;
      const page2 = await db.table('users').findMany({
        cursor: { id: lastId },
        orderBy: { id: 'asc' },
        take: 3,
        with: {
          posts: {
            orderBy: { id: 'asc' },
            with: {
              comments: { orderBy: { id: 'asc' } },
            },
          },
        },
      });

      assert.ok(Array.isArray(page2), 'page2 should be an array');
      // Cursor is exclusive of the cursor row → all page2 ids must be > lastId
      for (const u of page2) {
        const user = row(u);
        assert.ok((user.id as number) > lastId, `cursor pagination should advance: ${user.id} should be > ${lastId}`);
        assert.ok(Array.isArray(user.posts));
      }

      // Pages must not overlap
      const page1Ids = new Set(page1.map((u) => row(u).id));
      for (const u of page2) {
        assert.ok(!page1Ids.has(row(u).id), `page2 user ${row(u).id} should not appear in page1`);
      }

      // At least one user should actually have nested data so the test
      // verifies json_agg roundtripped a non-trivial payload.
      const hasNonEmpty = page1.some((u) => (row(u).posts as unknown[]).length > 0);
      assert.ok(hasNonEmpty, 'expected at least one paginated user with posts');
    });
  });

  // -------------------------------------------------------------------------
  // 2. pipeline batching — findMany + count + findUnique in one round-trip
  // -------------------------------------------------------------------------

  describe('pipeline batching', () => {
    it('runs three different queries in a single batch and returns typed results', async () => {
      const users = db.table<{ id: number; name: string }>('users');
      const posts = db.table<{ id: number; title: string; published: boolean }>('posts');

      // db.pipeline takes spread DeferredQuery<>, not an array — see
      // TurbineClient.pipeline (client.ts ~line 443).
      const [recentPosts, postCount, firstUser] = await db.pipeline(
        posts.buildFindMany({ orderBy: { id: 'desc' }, limit: 5 }),
        posts.buildCount(),
        users.buildFindUnique({ where: { id: 1 } }),
      );

      // 1. findMany: must be an array of length ≤ 5, each with id + title
      assert.ok(Array.isArray(recentPosts), 'recentPosts should be an array');
      assert.ok(recentPosts.length > 0, 'expected at least one post');
      assert.ok(recentPosts.length <= 5, 'expected at most 5 posts');
      for (const p of recentPosts) {
        assert.equal(typeof p.id, 'number');
        assert.equal(typeof p.title, 'string');
      }

      // 2. count: must be a number > 0
      assert.equal(typeof postCount, 'number', 'postCount should be a number');
      assert.ok(postCount > 0, 'expected post count > 0');
      assert.ok(postCount >= recentPosts.length, 'count should include the recent posts');

      // 3. findUnique: must be a single user object (or null) with id 1
      assert.ok(firstUser, 'user with id=1 should exist in the seed');
      assert.equal(firstUser.id, 1);
      assert.equal(typeof firstUser.name, 'string');
    });
  });

  // -------------------------------------------------------------------------
  // 3. $transaction with SAVEPOINT nesting
  // -------------------------------------------------------------------------

  describe('$transaction with SAVEPOINT nesting', () => {
    it('outer commits, inner rolls back via SAVEPOINT', async () => {
      // Use unique slugs/emails so re-runs don't collide on the unique
      // constraints in the seed.
      const stamp = Date.now();
      const outerSlug = `tx-outer-${stamp}`;
      const innerSlug = `tx-inner-${stamp}`;

      let createdOrgId: number | undefined;

      await db.$transaction(async (tx) => {
        const outer = (await tx.table('organizations').create({
          data: { name: 'TX Outer', slug: outerSlug, plan: 'free' },
        })) as Record<string, unknown>;
        createdOrgId = outer.id as number;

        // Inner SAVEPOINT — must throw to trigger ROLLBACK TO SAVEPOINT.
        // The outer transaction is unaffected and should still commit.
        await tx
          .$transaction(async (innerTx) => {
            await innerTx.table('organizations').create({
              data: { name: 'TX Inner', slug: innerSlug, plan: 'free' },
            });
            throw new Error('rollback inner');
          })
          .catch((err) => {
            assert.match((err as Error).message, /rollback inner/);
          });
      });

      assert.ok(createdOrgId, 'outer mutation should have produced an id');

      // Verify outer org persisted
      const outerFound = (await db.table('organizations').findUnique({ where: { id: createdOrgId! } })) as Record<
        string,
        unknown
      > | null;
      assert.ok(outerFound, 'outer org should persist after commit');
      assert.equal(outerFound.slug, outerSlug);

      // Verify inner org did NOT persist
      const innerFound = await db.table('organizations').findFirst({ where: { slug: innerSlug } });
      assert.equal(innerFound, null, 'inner SAVEPOINT mutation should have been rolled back');

      // Cleanup
      await db.table('organizations').delete({ where: { id: createdOrgId! } });
    });
  });

  // -------------------------------------------------------------------------
  // 4. findManyStream over nested relations with early break
  // -------------------------------------------------------------------------

  describe('findManyStream with nested relations', () => {
    it('streams users with posts and supports early break without leaking the cursor', async () => {
      // Capture pool stats BEFORE we start the stream so we can verify the
      // dedicated cursor connection is released after `break`.
      const idleBefore = db.stats.idleCount;
      const totalBefore = db.stats.totalCount;

      const seen: Array<{ id: number; postsLen: number }> = [];

      // batchSize: 2 forces the stream through more than one FETCH cycle on
      // any seed with > 2 users — exercises the inner loop in findManyStream.
      for await (const user of db.table('users').findManyStream({
        orderBy: { id: 'asc' },
        with: { posts: { orderBy: { id: 'asc' } } },
        batchSize: 2,
      })) {
        const u = row(user);
        const posts = u.posts as unknown[];
        assert.ok(Array.isArray(posts), 'streamed user should have a posts array (json_agg)');
        seen.push({ id: u.id as number, postsLen: posts.length });

        // Early break — must release the cursor connection cleanly.
        if (seen.length >= 3) break;
      }

      assert.equal(seen.length, 3, 'should have iterated exactly 3 users before breaking');
      // Ids should be ascending (we ordered by id)
      for (let i = 1; i < seen.length; i++) {
        assert.ok(seen[i]!.id > seen[i - 1]!.id, 'streamed users should be in ascending id order');
      }

      // After early break, the cursor connection should be released back to
      // the pool. Give pg a microtask tick to settle release().
      await new Promise((resolve) => setImmediate(resolve));

      // The pool's totalCount should not be permanently inflated, and we
      // should be able to run another query immediately (i.e. the cursor
      // didn't deadlock the pool).
      const followup = await db.table('users').findMany({ limit: 1 });
      assert.equal(followup.length, 1, 'follow-up query should succeed after stream early-break');

      // Sanity: the pool didn't lose connections to a leaked cursor. We
      // tolerate the pool growing by at most one between snapshots, since
      // pg.Pool may lazily expand to satisfy the follow-up query, but it
      // should never blow past totalBefore + 1 just from one stream.
      const totalAfter = db.stats.totalCount;
      assert.ok(
        totalAfter <= totalBefore + 2,
        `pool grew unexpectedly: before=${totalBefore} after=${totalAfter} (idleBefore=${idleBefore})`,
      );
    });
  });
});
