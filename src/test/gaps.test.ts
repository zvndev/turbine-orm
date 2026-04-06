/**
 * turbine-orm — High-priority gap tests
 *
 * Targeted second pass after comprehensive.test.ts. Each test fills a gap
 * identified in TEST-MATRIX.md that wasn't already covered. Focus areas:
 *   - Multi-column orderBy (mixed asc/desc)
 *   - Edge-case operator inputs (`in: []`, `limit: 0`, `limit: 1`, very large limit)
 *   - Nullable column round-trips (set to null, set from null back to value)
 *   - Empty result handling for aggregates / count / updateMany / deleteMany
 *   - Multi-column groupBy
 *   - Database-level constraint violations (unique, FK, NOT NULL)
 *   - Concurrent reads through the connection pool
 *   - Reserved-keyword identifiers (already-quoted)
 *   - Boolean equality and date comparisons
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/gaps.test.ts
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { TurbineClient } from '../client.js';
import { ForeignKeyError, NotFoundError, NotNullViolationError, UniqueConstraintError } from '../errors.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata } from '../schema.js';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('\u26A0 Skipping gap tests: DATABASE_URL not set');
}

let db: TurbineClient;
let schema: SchemaMetadata;

const testFn = SKIP ? describe.skip : describe;

// Small helper: cast a row to the index-signature type used throughout the tests.
const row = (r: unknown): Record<string, unknown> => r as Record<string, unknown>;

testFn('high-priority gap tests', () => {
  before(async () => {
    schema = await introspect({ connectionString: DATABASE_URL! });
    db = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 5 }, schema);
    await db.connect();
  });

  after(async () => {
    await db.disconnect();
  });

  // =========================================================================
  // 1. ORDER BY edge cases
  // =========================================================================

  describe('orderBy edge cases', () => {
    it('multi-column orderBy with mixed asc/desc', async () => {
      const users = await db.table('users').findMany({
        limit: 20,
        orderBy: { role: 'asc', id: 'desc' },
      });
      assert.ok(users.length > 0);
      // Verify role is monotonically non-decreasing, and within each role, id is non-increasing.
      for (let i = 1; i < users.length; i++) {
        const a = row(users[i - 1]);
        const b = row(users[i]);
        const roleA = String(a.role);
        const roleB = String(b.role);
        assert.ok(roleA <= roleB, `role should ascend: ${roleA} > ${roleB}`);
        if (roleA === roleB) {
          assert.ok((a.id as number) >= (b.id as number), 'id should descend within role');
        }
      }
    });

    it('orderBy on nullable column does not crash', async () => {
      // last_login_at has nulls — Postgres default NULLS LAST for ASC
      const users = await db.table('users').findMany({
        limit: 5,
        orderBy: { lastLoginAt: 'asc' },
      });
      assert.ok(Array.isArray(users));
    });
  });

  // =========================================================================
  // 2. LIMIT / OFFSET edge cases
  // =========================================================================

  describe('limit/offset edge cases', () => {
    it('limit: 0 returns empty array', async () => {
      const users = await db.table('users').findMany({ limit: 0 });
      assert.deepEqual(users, []);
    });

    it('limit: 1 returns exactly one row', async () => {
      const users = await db.table('users').findMany({ limit: 1, orderBy: { id: 'asc' } });
      assert.equal(users.length, 1);
    });

    it('very large limit (> total rows) returns all rows', async () => {
      const total = await db.table('users').count();
      const users = await db.table('users').findMany({ limit: 100_000 });
      assert.equal(users.length, total);
    });

    it('offset beyond row count returns empty array', async () => {
      const users = await db.table('users').findMany({
        limit: 10,
        offset: 1_000_000,
      });
      assert.deepEqual(users, []);
    });
  });

  // =========================================================================
  // 3. `in` operator edge cases
  // =========================================================================

  describe('in / notIn edge cases', () => {
    it('in with empty array returns no rows', async () => {
      const users = await db.table('users').findMany({
        where: { id: { in: [] } },
        limit: 10,
      });
      assert.deepEqual(users, []);
    });

    it('notIn with empty array returns all rows', async () => {
      const total = await db.table('users').count();
      const users = await db.table('users').findMany({
        where: { id: { notIn: [] } },
        limit: 100_000,
      });
      assert.equal(users.length, total);
    });

    it('in with single value', async () => {
      const users = await db.table('users').findMany({
        where: { id: { in: [1] } },
      });
      assert.equal(users.length, 1);
      assert.equal(row(users[0]).id, 1);
    });

    it('in with large list (250 values)', async () => {
      const ids = Array.from({ length: 250 }, (_, i) => i + 1);
      const users = await db.table('users').findMany({
        where: { id: { in: ids } },
        limit: 1000,
      });
      // Should match users where id is between 1..250 (we have 100 users, ids 1..100)
      assert.ok(users.length > 0);
      assert.ok(users.length <= 250);
      for (const u of users) {
        assert.ok(ids.includes(row(u).id as number));
      }
    });
  });

  // =========================================================================
  // 4. Nullable column update round-trip
  // =========================================================================

  describe('nullable update round-trip', () => {
    it('set nullable text column to null, then back to value', async () => {
      const created = row(
        await db.table('users').create({
          data: {
            email: `nullable_text_${Date.now()}@test.com`,
            name: 'Nullable Test',
            orgId: 1,
            role: 'member',
            avatarUrl: 'https://example.com/avatar.png',
          },
        }),
      );
      assert.equal(created.avatarUrl, 'https://example.com/avatar.png');

      // Set to null
      const cleared = row(
        await db.table('users').update({
          where: { id: created.id },
          data: { avatarUrl: null },
        }),
      );
      assert.equal(cleared.avatarUrl, null);

      // Set back to a value
      const restored = row(
        await db.table('users').update({
          where: { id: created.id },
          data: { avatarUrl: 'https://example.com/new.png' },
        }),
      );
      assert.equal(restored.avatarUrl, 'https://example.com/new.png');

      // Cleanup
      await db.table('users').delete({ where: { id: created.id } });
    });

    it('set nullable timestamp column to null, then back to a Date', async () => {
      const created = row(
        await db.table('users').create({
          data: {
            email: `nullable_ts_${Date.now()}@test.com`,
            name: 'Nullable TS',
            orgId: 1,
            role: 'member',
            lastLoginAt: new Date('2024-01-01T00:00:00Z'),
          },
        }),
      );
      assert.ok(created.lastLoginAt instanceof Date);

      const cleared = row(
        await db.table('users').update({
          where: { id: created.id },
          data: { lastLoginAt: null },
        }),
      );
      assert.equal(cleared.lastLoginAt, null);

      const newDate = new Date('2025-06-01T12:00:00Z');
      const restored = row(
        await db.table('users').update({
          where: { id: created.id },
          data: { lastLoginAt: newDate },
        }),
      );
      assert.ok(restored.lastLoginAt instanceof Date);
      assert.equal((restored.lastLoginAt as Date).toISOString(), newDate.toISOString());

      // Cleanup
      await db.table('users').delete({ where: { id: created.id } });
    });
  });

  // =========================================================================
  // 5. Empty result handling
  // =========================================================================

  describe('empty result handling', () => {
    it('count returns 0 for non-matching where', async () => {
      const c = await db.table('users').count({
        where: { email: 'definitely_does_not_exist@nowhere.test' },
      });
      assert.equal(c, 0);
    });

    it('updateMany returns count: 0 when no rows match', async () => {
      const result = await db.table('users').updateMany({
        where: { email: 'definitely_does_not_exist@nowhere.test' },
        data: { role: 'admin' },
      });
      assert.equal(result.count, 0);
    });

    it('deleteMany returns count: 0 when no rows match', async () => {
      const result = await db.table('users').deleteMany({
        where: { email: 'definitely_does_not_exist@nowhere.test' },
      });
      assert.equal(result.count, 0);
    });

    it('aggregate on empty result set returns null for sum/avg/min/max but 0 for count', async () => {
      const result = await db.table('posts').aggregate({
        where: { id: -1 },
        _count: true,
        _sum: { viewCount: true },
        _avg: { viewCount: true },
        _min: { viewCount: true },
        _max: { viewCount: true },
      });
      const r = row(result);
      assert.equal(r._count, 0);
      // Postgres returns NULL for SUM/AVG/MIN/MAX on empty set
      assert.equal(row(r._sum).viewCount, null);
      assert.equal(row(r._avg).viewCount, null);
      assert.equal(row(r._min).viewCount, null);
      assert.equal(row(r._max).viewCount, null);
    });

    it('findMany on empty filter returns empty array, not null', async () => {
      const users = await db.table('users').findMany({
        where: { email: 'definitely_does_not_exist@nowhere.test' },
      });
      assert.deepEqual(users, []);
    });
  });

  // =========================================================================
  // 6. groupBy: multi-column
  // =========================================================================

  describe('groupBy multi-column', () => {
    it('groupBy on two columns', async () => {
      // Snapshot both queries inside one transaction so concurrent test files
      // creating/deleting users (constraint tests, comprehensive tests) can't
      // race the assertion.
      await db.$transaction(
        async (tx) => {
          const groups = await tx.table('users').groupBy({
            by: ['orgId', 'role'],
            _count: true,
          });
          assert.ok(groups.length > 0);
          for (const g of groups) {
            const r = row(g);
            assert.ok('orgId' in r);
            assert.ok('role' in r);
            assert.ok(typeof r._count === 'number');
            assert.ok((r._count as number) > 0);
          }
          const total = await tx.table('users').count();
          const sumCounts = groups.reduce((acc, g) => acc + (row(g)._count as number), 0);
          assert.equal(sumCounts, total);
        },
        { isolationLevel: 'RepeatableRead' },
      );
    });

    it('groupBy on boolean column', async () => {
      await db.$transaction(
        async (tx) => {
          const groups = await tx.table('posts').groupBy({
            by: ['published'],
            _count: true,
          });
          assert.ok(groups.length === 1 || groups.length === 2);
          const total = await tx.table('posts').count();
          const sumCounts = groups.reduce((acc, g) => acc + (row(g)._count as number), 0);
          assert.equal(sumCounts, total);
        },
        { isolationLevel: 'RepeatableRead' },
      );
    });
  });

  // =========================================================================
  // 7. Database-level constraint violations surface as errors
  // =========================================================================

  describe('constraint violations', () => {
    it('unique constraint violation on duplicate email throws UniqueConstraintError', async () => {
      const email = `dup_${Date.now()}@test.com`;
      const created = row(
        await db.table('users').create({
          data: { email, name: 'Dup Test', orgId: 1, role: 'member' },
        }),
      );
      try {
        await assert.rejects(
          () =>
            db.table('users').create({
              data: { email, name: 'Dup Test 2', orgId: 1, role: 'member' },
            }),
          (err: Error) => {
            assert.ok(
              err instanceof UniqueConstraintError,
              `expected UniqueConstraintError, got ${err.constructor.name}`,
            );
            return true;
          },
        );
      } finally {
        await db.table('users').delete({ where: { id: created.id } });
      }
    });

    it('UniqueConstraintError exposes constraint and/or columns metadata', async () => {
      const email = `dup_meta_${Date.now()}@test.com`;
      const created = row(
        await db.table('users').create({
          data: { email, name: 'Dup Meta', orgId: 1, role: 'member' },
        }),
      );
      try {
        let caught: UniqueConstraintError | undefined;
        try {
          await db.table('users').create({
            data: { email, name: 'Dup Meta 2', orgId: 1, role: 'member' },
          });
        } catch (err) {
          if (err instanceof UniqueConstraintError) caught = err;
        }
        assert.ok(caught, 'expected UniqueConstraintError to be thrown');
        assert.ok(
          caught.constraint || (caught.columns && caught.columns.length > 0),
          'expected constraint or columns to be populated',
        );
      } finally {
        await db.table('users').delete({ where: { id: created.id } });
      }
    });

    it('FK constraint violation on insert throws ForeignKeyError', async () => {
      await assert.rejects(
        () =>
          db.table('users').create({
            data: {
              email: `bad_fk_${Date.now()}@test.com`,
              name: 'Bad FK',
              orgId: 999_999_999, // does not exist
              role: 'member',
            },
          }),
        (err: Error) => {
          assert.ok(err instanceof ForeignKeyError, `expected ForeignKeyError, got ${err.constructor.name}`);
          return true;
        },
      );
    });

    it('ForeignKeyError exposes constraint metadata', async () => {
      let caught: ForeignKeyError | undefined;
      try {
        await db.table('users').create({
          data: {
            email: `bad_fk_meta_${Date.now()}@test.com`,
            name: 'Bad FK Meta',
            orgId: 999_999_999,
            role: 'member',
          },
        });
      } catch (err) {
        if (err instanceof ForeignKeyError) caught = err;
      }
      assert.ok(caught, 'expected ForeignKeyError to be thrown');
      assert.ok(caught.constraint, 'expected constraint to be populated');
    });

    it('NOT NULL violation on insert throws NotNullViolationError', async () => {
      await assert.rejects(
        () =>
          db.table('users').create({
            // missing required `email`
            data: { name: 'No Email', orgId: 1, role: 'member' } as Record<string, unknown>,
          }),
        (err: Error) => {
          assert.ok(
            err instanceof NotNullViolationError,
            `expected NotNullViolationError, got ${err.constructor.name}`,
          );
          return true;
        },
      );
    });
  });

  // =========================================================================
  // 7b. NotFoundError carries query context
  // =========================================================================

  describe('NotFoundError context', () => {
    it('findUniqueOrThrow throws NotFoundError with table + where context', async () => {
      let caught: NotFoundError | undefined;
      try {
        await db.table('users').findUniqueOrThrow({ where: { id: 999_999_999 } });
      } catch (err) {
        if (err instanceof NotFoundError) caught = err;
      }
      assert.ok(caught, 'expected NotFoundError to be thrown');
      assert.equal(caught.table, 'users');
      assert.deepEqual(caught.where, { id: 999_999_999 });
      assert.equal(caught.operation, 'findUniqueOrThrow');
      // Message should mention the table and where
      assert.match(caught.message, /users/);
      assert.match(caught.message, /999999999/);
    });

    it('findFirstOrThrow throws NotFoundError with where context', async () => {
      let caught: NotFoundError | undefined;
      try {
        await db.table('users').findFirstOrThrow({
          where: { email: 'definitely_does_not_exist@nowhere.test' },
        });
      } catch (err) {
        if (err instanceof NotFoundError) caught = err;
      }
      assert.ok(caught);
      assert.equal(caught.table, 'users');
      assert.equal(caught.operation, 'findFirstOrThrow');
    });

    it('update on non-existent row throws NotFoundError with context', async () => {
      let caught: NotFoundError | undefined;
      try {
        await db.table('users').update({
          where: { id: 999_999_999 },
          data: { name: 'x' },
        });
      } catch (err) {
        if (err instanceof NotFoundError) caught = err;
      }
      assert.ok(caught, 'expected NotFoundError on update of non-existent row');
      assert.equal(caught.table, 'users');
      assert.equal(caught.operation, 'update');
    });
  });

  // =========================================================================
  // 8. Concurrent reads through the pool
  // =========================================================================

  describe('concurrent reads', () => {
    it('runs 20 concurrent findMany calls without interference', async () => {
      const promises = Array.from({ length: 20 }, (_, i) =>
        db.table('users').findMany({
          where: { id: { gt: i } },
          limit: 5,
          orderBy: { id: 'asc' },
        }),
      );
      const results = await Promise.all(promises);
      assert.equal(results.length, 20);
      for (let i = 0; i < results.length; i++) {
        const rows = results[i]!;
        for (const u of rows) {
          assert.ok((row(u).id as number) > i, `result ${i} should only contain id > ${i}`);
        }
      }
    });

    it('runs 10 concurrent counts and gets matching numbers', async () => {
      const promises = Array.from({ length: 10 }, () => db.table('users').count());
      const counts = await Promise.all(promises);
      const first = counts[0];
      for (const c of counts) {
        assert.equal(c, first);
      }
    });
  });

  // =========================================================================
  // 9. Boolean equality + date comparisons
  // =========================================================================

  describe('boolean and date filters', () => {
    it('boolean equality: published: true', async () => {
      const posts = await db.table('posts').findMany({
        where: { published: true },
        limit: 50,
      });
      for (const p of posts) {
        assert.equal(row(p).published, true);
      }
    });

    it('boolean equality: published: false', async () => {
      const posts = await db.table('posts').findMany({
        where: { published: false },
        limit: 50,
      });
      for (const p of posts) {
        assert.equal(row(p).published, false);
      }
    });

    it('date comparison with gt operator', async () => {
      const cutoff = new Date('2020-01-01T00:00:00Z');
      const posts = await db.table('posts').findMany({
        where: { createdAt: { gt: cutoff } },
        limit: 5,
      });
      for (const p of posts) {
        const created = row(p).createdAt as Date;
        assert.ok(created > cutoff);
      }
    });

    it('date comparison with lt operator returning empty', async () => {
      const cutoff = new Date('1900-01-01T00:00:00Z');
      const posts = await db.table('posts').findMany({
        where: { createdAt: { lt: cutoff } },
        limit: 5,
      });
      assert.deepEqual(posts, []);
    });
  });

  // =========================================================================
  // 10. Logical operators: nested + empty
  // =========================================================================

  describe('logical operator edge cases', () => {
    it('nested OR inside OR', async () => {
      const users = await db.table('users').findMany({
        where: {
          OR: [{ role: 'admin' }, { OR: [{ role: 'editor' }, { id: 1 }] }],
        },
        limit: 50,
      });
      for (const u of users) {
        const r = row(u);
        assert.ok(r.role === 'admin' || r.role === 'editor' || r.id === 1);
      }
    });

    it('AND combined with OR', async () => {
      const users = await db.table('users').findMany({
        where: {
          AND: [{ orgId: 1 }, { OR: [{ role: 'admin' }, { role: 'editor' }] }],
        },
        limit: 50,
      });
      for (const u of users) {
        const r = row(u);
        assert.equal(r.orgId, 1);
        assert.ok(r.role === 'admin' || r.role === 'editor');
      }
    });

    it('NOT excluding multiple conditions', async () => {
      const users = await db.table('users').findMany({
        where: {
          NOT: { role: 'admin' },
        },
        limit: 50,
      });
      for (const u of users) {
        assert.notEqual(row(u).role, 'admin');
      }
    });
  });

  // =========================================================================
  // 11. Aggregates: distinct count and combined
  // =========================================================================

  describe('aggregate edge cases', () => {
    it('count + sum + avg in one call', async () => {
      const result = row(
        await db.table('posts').aggregate({
          _count: true,
          _sum: { viewCount: true },
          _avg: { viewCount: true },
        }),
      );
      assert.ok(typeof result._count === 'number');
      assert.ok((result._count as number) > 0);
      assert.ok(row(result._sum).viewCount !== null);
      assert.ok(row(result._avg).viewCount !== null);
    });

    it('aggregate with where filter', async () => {
      const result = row(
        await db.table('posts').aggregate({
          where: { published: true },
          _count: true,
        }),
      );
      const totalPublished = await db.table('posts').count({ where: { published: true } });
      assert.equal(result._count, totalPublished);
    });
  });

  // =========================================================================
  // 12. Pipeline edge cases
  // =========================================================================

  describe('pipeline edge cases', () => {
    it('pipeline with mixed operations', async () => {
      const [user, postCount, firstPost] = await db.pipeline(
        db.table('users').buildFindUnique({ where: { id: 1 } }),
        db.table('posts').buildCount({ where: { userId: 1 } }),
        db.table('posts').buildFindFirst({ where: { userId: 1 }, orderBy: { id: 'asc' } }),
      );
      assert.ok(user);
      assert.ok(typeof postCount === 'number');
      if (firstPost) {
        assert.equal(row(firstPost).userId, 1);
      }
    });

    it('pipeline with single query still works', async () => {
      const [user] = await db.pipeline(db.table('users').buildFindUnique({ where: { id: 1 } }));
      assert.ok(user);
      assert.equal(row(user).id, 1);
    });
  });
});
