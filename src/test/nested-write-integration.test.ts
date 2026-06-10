import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { TurbineClient } from '../client.js';
import { ValidationError } from '../errors.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping nested write integration tests: DATABASE_URL not set');
}

let db: TurbineClient;
let schema: SchemaMetadata;

// Without DATABASE_URL every test below registers as skipped (visible in
// the reporter summary) and the before/after hooks become no-ops.
const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');
const testFn = describe;

const row = (r: unknown): Record<string, unknown> => r as Record<string, unknown>;

testFn('nested write integration tests', () => {
  before(async () => {
    schema = await introspect({ connectionString: DATABASE_URL! });
    db = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 5 }, schema);
    await db.connect();
  });

  after(async () => {
    await db.disconnect();
  });

  describe('create with nested create', () => {
    it('creates parent with hasMany children', async () => {
      const uniqueEmail = `nested-hm-${Date.now()}@example.com`;
      const user = row(
        await db.table('users').create({
          data: {
            email: uniqueEmail,
            name: 'Nested HasMany Test',
            orgId: 1,
            posts: {
              create: [
                { title: 'Nested Post 1', content: 'Content 1', orgId: 1 },
                { title: 'Nested Post 2', content: 'Content 2', orgId: 1 },
              ],
            },
          },
        }),
      );

      assert.ok(user.id);
      assert.equal(user.email, uniqueEmail);
      assert.ok(Array.isArray(user.posts));
      const posts = user.posts as Record<string, unknown>[];
      assert.equal(posts.length, 2);
      assert.equal(posts[0]!.title, 'Nested Post 1');
      assert.equal(posts[1]!.title, 'Nested Post 2');
    });

    it('creates parent with single nested child (not array)', async () => {
      const uniqueEmail = `nested-single-${Date.now()}@example.com`;
      const user = row(
        await db.table('users').create({
          data: {
            email: uniqueEmail,
            name: 'Single Nest User',
            orgId: 1,
            posts: {
              create: { title: 'Solo Post', content: 'Just one', orgId: 1 },
            },
          },
        }),
      );

      assert.ok(Array.isArray(user.posts));
      assert.equal((user.posts as unknown[]).length, 1);
    });
  });

  describe('create with nested connect', () => {
    it('connects existing children to new parent', async () => {
      const post = row(
        await db.table('posts').create({
          data: { title: 'Connectable Post', content: 'Will be connected', userId: 1, orgId: 1 },
        }),
      );

      const uniqueEmail = `nested-connect-${Date.now()}@example.com`;
      const user = row(
        await db.table('users').create({
          data: {
            email: uniqueEmail,
            name: 'Connect Test User',
            orgId: 1,
            posts: {
              connect: [{ id: post.id }],
            },
          },
        }),
      );

      assert.ok(Array.isArray(user.posts));
      const connected = (user.posts as Record<string, unknown>[]).find((p) => p.id === post.id);
      assert.ok(connected, 'connected post should be in returned tree');
    });
  });

  describe('create with connectOrCreate', () => {
    it('creates when no match exists', async () => {
      const uniqueEmail = `nested-cor-${Date.now()}@example.com`;
      const uniqueTitle = `CoR-Create-${Date.now()}`;
      const user = row(
        await db.table('users').create({
          data: {
            email: uniqueEmail,
            name: 'CoR Test',
            orgId: 1,
            posts: {
              connectOrCreate: [
                {
                  where: { id: -999999 },
                  create: { title: uniqueTitle, content: 'Created via CoR', orgId: 1 },
                },
              ],
            },
          },
        }),
      );

      const posts = user.posts as Record<string, unknown>[];
      assert.equal(posts.length, 1);
      assert.equal(posts[0]!.title, uniqueTitle);
    });

    it('connects when match exists', async () => {
      const existing = row(
        await db.table('posts').create({
          data: { title: 'Pre-existing CoR', content: 'Already here', userId: 1, orgId: 1 },
        }),
      );

      const uniqueEmail = `nested-cor2-${Date.now()}@example.com`;
      const user = row(
        await db.table('users').create({
          data: {
            email: uniqueEmail,
            name: 'CoR Connect Test',
            orgId: 1,
            posts: {
              connectOrCreate: [
                {
                  where: { id: existing.id },
                  create: { title: 'Should Not Create', content: 'Nope', orgId: 1 },
                },
              ],
            },
          },
        }),
      );

      const posts = user.posts as Record<string, unknown>[];
      const found = posts.find((p) => p.id === existing.id);
      assert.ok(found, 'should have connected the existing post');
      assert.equal(found!.title, 'Pre-existing CoR');
    });
  });

  describe('update with nested operations', () => {
    it('creates new children on update', async () => {
      const uniqueEmail = `update-create-${Date.now()}@example.com`;
      const user = row(
        await db.table('users').create({
          data: { email: uniqueEmail, name: 'Update Test', orgId: 1 },
        }),
      );

      const updated = row(
        await db.table('users').update({
          where: { id: user.id },
          data: {
            posts: {
              create: [{ title: 'Added via update', content: 'New!', orgId: 1 }],
            },
          },
        }),
      );

      assert.ok(Array.isArray(updated.posts));
      const posts = updated.posts as Record<string, unknown>[];
      assert.equal(posts.length, 1);
      assert.equal(posts[0]!.title, 'Added via update');
    });

    it('deletes children on update', async () => {
      const uniqueEmail = `update-delete-${Date.now()}@example.com`;
      const user = row(
        await db.table('users').create({
          data: {
            email: uniqueEmail,
            name: 'Delete Test',
            orgId: 1,
            posts: {
              create: [
                { title: 'Keep this', content: 'Kept', orgId: 1 },
                { title: 'Delete this', content: 'Gone', orgId: 1 },
              ],
            },
          },
        }),
      );

      const posts = user.posts as Record<string, unknown>[];
      const deleteTarget = posts.find((p) => p.title === 'Delete this')!;

      const updated = row(
        await db.table('users').update({
          where: { id: user.id },
          data: {
            posts: {
              delete: [{ id: deleteTarget.id }],
            },
          },
        }),
      );

      const remaining = updated.posts as Record<string, unknown>[];
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0]!.title, 'Keep this');
    });
  });

  describe('disconnect validation', () => {
    it('throws ValidationError for NOT NULL FK disconnect', async () => {
      const uniqueEmail = `disconnect-notNull-${Date.now()}@example.com`;
      const user = row(
        await db.table('users').create({
          data: {
            email: uniqueEmail,
            name: 'Disconnect Fail Test',
            orgId: 1,
            posts: {
              create: [{ title: 'Undisconnectable', content: 'FK is NOT NULL', orgId: 1 }],
            },
          },
        }),
      );

      const posts = user.posts as Record<string, unknown>[];
      await assert.rejects(
        () =>
          db.table('users').update({
            where: { id: user.id },
            data: {
              posts: {
                disconnect: [{ id: posts[0]!.id }],
              },
            },
          }),
        (err: Error) => {
          assert.ok(err instanceof ValidationError);
          assert.ok(err.message.includes('NOT NULL'));
          return true;
        },
      );
    });
  });

  describe('transaction rollback', () => {
    it('rolls back all nested writes on failure', async () => {
      const uniqueEmail = `rollback-${Date.now()}@example.com`;
      const countBefore = (await db.table('users').count({
        where: { email: uniqueEmail },
      })) as number;

      try {
        await db.table('users').create({
          data: {
            email: uniqueEmail,
            name: 'Rollback Test',
            orgId: 1,
            posts: {
              connect: [{ id: -999999 }],
            },
          },
        });
        assert.fail('Should have thrown');
      } catch {
        // Expected
      }

      const countAfter = (await db.table('users').count({
        where: { email: uniqueEmail },
      })) as number;
      assert.equal(countAfter, countBefore, 'user should not exist due to rollback');
    });
  });

  describe('nested write inside $transaction', () => {
    it('uses existing transaction (no double BEGIN)', async () => {
      const uniqueEmail = `tx-nested-${Date.now()}@example.com`;
      const result = await db.$transaction(async (tx) => {
        const user = row(
          await tx.table('users').create({
            data: {
              email: uniqueEmail,
              name: 'Tx Nested Test',
              orgId: 1,
              posts: {
                create: [{ title: 'Inside Tx', content: 'Nested in $tx', orgId: 1 }],
              },
            },
          }),
        );
        return user;
      });

      assert.ok(result.id);
      assert.ok(Array.isArray(result.posts));
      assert.equal((result.posts as unknown[]).length, 1);
    });

    it('rolls back nested write when outer transaction fails', async () => {
      const uniqueEmail = `tx-rollback-${Date.now()}@example.com`;
      try {
        await db.$transaction(async (tx) => {
          await tx.table('users').create({
            data: {
              email: uniqueEmail,
              name: 'Will Be Rolled Back',
              orgId: 1,
              posts: {
                create: [{ title: 'Ghost Post', content: 'Gone', orgId: 1 }],
              },
            },
          });
          throw new Error('forced rollback');
        });
      } catch {
        // Expected
      }

      const count = (await db.table('users').count({
        where: { email: uniqueEmail },
      })) as number;
      assert.equal(count, 0, 'user should not exist after outer tx rollback');
    });
  });

  describe('non-nested create still works (fast path)', () => {
    it('creates without nesting — no transaction overhead', async () => {
      const uniqueEmail = `fast-path-${Date.now()}@example.com`;
      const user = row(
        await db.table('users').create({
          data: { email: uniqueEmail, name: 'Fast Path User', orgId: 1 },
        }),
      );

      assert.ok(user.id);
      assert.equal(user.email, uniqueEmail);
      assert.ok(!('posts' in user), 'should not have posts key without with clause');
    });
  });

  // Regression: belongsTo nested writes put the FK on the PARENT row, so the
  // FK must be resolved BEFORE the parent INSERT. Earlier the parent was
  // inserted first and the FK set via a follow-up UPDATE, which failed the
  // NOT NULL `user_id` constraint on the initial INSERT. These exercise the
  // FK-on-parent direction (the prior tests only covered hasMany / FK-on-child).
  describe('create with belongsTo (FK on parent, NOT NULL)', () => {
    it('connect: sets the parent FK from an existing related row', async () => {
      const post = row(
        await db.table('posts').create({
          data: {
            title: 'belongsTo connect',
            content: 'x',
            orgId: 1,
            user: { connect: { id: 1 } },
          },
        }),
      );
      assert.ok(post.id);
      assert.equal(String(post.userId), '1', 'parent user_id should be set from the connected user');
      assert.ok(post.user && (post.user as Record<string, unknown>).id, 'nested user should be returned');
    });

    it('create: creates the related row and sets the parent FK to its PK', async () => {
      const email = `belongsto-create-${Date.now()}@example.com`;
      const post = row(
        await db.table('posts').create({
          data: {
            title: 'belongsTo create',
            content: 'y',
            orgId: 1,
            user: { create: { email, name: 'BelongsTo Created', orgId: 1 } },
          },
        }),
      );
      assert.ok(post.userId, 'parent user_id should be set to the created user PK');
      const nested = post.user as Record<string, unknown>;
      assert.equal(nested.email, email, 'nested created user should round-trip');
      assert.equal(String(post.userId), String(nested.id));
    });

    it('connectOrCreate: connects an existing related row', async () => {
      const post = row(
        await db.table('posts').create({
          data: {
            title: 'belongsTo connectOrCreate',
            content: 'z',
            orgId: 1,
            user: {
              connectOrCreate: {
                where: { id: 1 },
                create: { email: `cor-${Date.now()}@example.com`, name: 'nope', orgId: 1 },
              },
            },
          },
        }),
      );
      assert.equal(String(post.userId), '1', 'should connect to existing user, not create');
    });
  });
});
