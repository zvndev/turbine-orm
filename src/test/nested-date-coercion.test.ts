/**
 * Regression test for nested-relation date coercion.
 *
 * Top-level date columns are coerced to JS `Date` via `parseRow`'s snake_case
 * `dateColumns` set. Nested relation rows arrive from `json_build_object` with
 * camelCase keys, so they previously missed that lookup and leaked through as
 * raw PG timestamp STRINGS — `users[0].createdAt` was a `Date` but
 * `users[0].posts[0].createdAt` was a string. The parity harness against Prisma
 * 7 / Drizzle surfaced this inconsistency. `parseRow` now also matches the
 * camelCase field name, and `parseNestedRow` recurses so coercion applies at
 * arbitrary depth and in the belongsTo direction.
 *
 * Run: DATABASE_URL=... npx tsx --test src/test/nested-date-coercion.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { TurbineClient } from '../client.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping nested-date-coercion integration test: DATABASE_URL not set');
}

// Without DATABASE_URL every test below registers as skipped (visible in
// the reporter summary) and the before/after hooks become no-ops.
const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');
const testFn = describe;
const row = (r: unknown): Record<string, unknown> => r as Record<string, unknown>;

testFn('nested relation date columns are coerced to Date at every depth', () => {
  let db: TurbineClient;
  let schema: SchemaMetadata;

  before(async () => {
    schema = await introspect({ connectionString: DATABASE_URL! });
    db = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 3 }, schema);
    await db.connect();
  });

  after(async () => {
    await db.disconnect();
  });

  it('coerces dates at L0 (top), L1 and L2 (hasMany nesting)', async () => {
    const users = (await db.table('users').findMany({
      with: { posts: { with: { comments: true } } },
      limit: 1,
    })) as Record<string, unknown>[];
    assert.ok(users.length > 0, 'fixture should have at least one user with posts');
    const user = row(users[0]);
    const post = row((user.posts as unknown[])[0]);
    const comment = row((post.comments as unknown[])[0]);

    assert.ok(user.createdAt instanceof Date, 'L0 user.createdAt should be a Date');
    assert.ok(post.createdAt instanceof Date, 'L1 post.createdAt should be a Date (was a string)');
    assert.ok(comment.createdAt instanceof Date, 'L2 comment.createdAt should be a Date (was a string)');
    // Same absolute instant, just a Date now — sanity check it parsed.
    assert.ok((comment.createdAt as Date).getTime() > 0);
  });

  it('coerces dates through a belongsTo relation', async () => {
    const posts = (await db.table('posts').findMany({
      with: { user: true },
      limit: 1,
    })) as Record<string, unknown>[];
    const post = row(posts[0]);
    const author = row(post.user);
    assert.ok(post.createdAt instanceof Date, 'post.createdAt should be a Date');
    assert.ok(author.createdAt instanceof Date, 'belongsTo user.createdAt should be a Date');
  });
});
