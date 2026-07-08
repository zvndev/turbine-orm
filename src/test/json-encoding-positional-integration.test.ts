/**
 * turbine-orm — positional JSON encoding parity (integration)
 *
 * Runs the SAME nested `with` queries under `jsonEncoding: 'object'` and
 * `jsonEncoding: 'positional'` against a real Postgres and asserts the parsed
 * results are deep-equal. This is the load-bearing guarantee: positional is a
 * pure wire-size optimization — flipping the flag must never change output
 * (dates, null to-one relations, orderBy+limit windows, select/omit all
 * included).
 *
 * Run against a real Postgres seeded by src/test/fixtures/seed.sql:
 *
 *   DATABASE_URL=postgres://... npx tsx --test src/test/json-encoding-positional-integration.test.ts
 *
 * Gated by DATABASE_URL — absent, every test is reported skipped (never failed).
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
  console.log('⚠ Skipping positional-encoding integration tests: DATABASE_URL not set');
}

let objDb: TurbineClient;
let posDb: TurbineClient;
let schema: SchemaMetadata;

const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

describe('json-encoding positional parity', () => {
  before(async () => {
    schema = await introspect({ connectionString: DATABASE_URL! });
    objDb = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 3 }, schema);
    posDb = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 3, jsonEncoding: 'positional' }, schema);
    await objDb.connect();
    await posDb.connect();
  });

  after(async () => {
    await objDb.disconnect();
    await posDb.disconnect();
  });

  /** Run `fn` against both clients and assert deep-equal results. */
  async function assertParity(name: string, fn: (db: TurbineClient) => Promise<unknown>): Promise<void> {
    const expected = await fn(objDb);
    const actual = await fn(posDb);
    assert.deepEqual(actual, expected, `positional output diverged from object for: ${name}`);
    // Guard against the trivially-equal empty case masking a broken query.
    assert.ok(Array.isArray(expected) ? expected.length > 0 : expected != null, `${name}: no rows to compare`);
  }

  it('hasMany → hasMany nested with (users → posts → comments)', async () => {
    await assertParity('users.posts.comments', (db) =>
      db.table('users').findMany({
        orderBy: { id: 'asc' },
        limit: 5,
        with: { posts: { orderBy: { id: 'asc' }, with: { comments: { orderBy: { id: 'asc' } } } } },
      }),
    );
  });

  it('belongsTo to-one relation (posts → user), incl. dates coerced identically', async () => {
    await assertParity('posts.user', (db) =>
      db.table('posts').findMany({ orderBy: { id: 'asc' }, limit: 10, with: { user: true } }),
    );
  });

  it('orderBy + limit window on the nested relation', async () => {
    await assertParity('users.posts[orderBy,limit]', (db) =>
      db.table('users').findMany({
        orderBy: { id: 'asc' },
        limit: 5,
        with: { posts: { orderBy: { id: 'desc' }, limit: 2 } },
      }),
    );
  });

  it('select / omit on the nested relation', async () => {
    await assertParity('users.posts[select]', (db) =>
      db.table('users').findMany({
        orderBy: { id: 'asc' },
        limit: 5,
        with: { posts: { select: { id: true, title: true }, orderBy: { id: 'asc' }, limit: 3 } },
      }),
    );
    await assertParity('posts.user[omit]', (db) =>
      db.table('posts').findMany({
        orderBy: { id: 'asc' },
        limit: 5,
        with: { user: { omit: { createdAt: true } } },
      }),
    );
  });

  it('findUnique with nested relations', async () => {
    await assertParity('findUnique users(1).posts', (db) =>
      db.table('users').findUnique({ where: { id: 1 }, with: { posts: { orderBy: { id: 'asc' }, limit: 3 } } }),
    );
  });

  it('deeply nested three-level tree (users → posts → comments → user)', async () => {
    await assertParity('three-level', (db) =>
      db.table('users').findMany({
        orderBy: { id: 'asc' },
        limit: 3,
        with: {
          posts: {
            orderBy: { id: 'asc' },
            limit: 2,
            with: { comments: { orderBy: { id: 'asc' }, limit: 2, with: { user: true } } },
          },
        },
      }),
    );
  });
});
