/**
 * turbine-orm — Batched relation-loading integration tests
 *
 * The core guarantee of `relationLoadStrategy: 'batched'` is that it returns a
 * result deeply-equal to the default `'join'` strategy — same keys, same order,
 * same Date coercion — only the number of SQL round-trips differs. These tests
 * run the SAME query under both strategies against a real Postgres and assert
 * `deepEqual`, across hasMany, belongsTo, nested `with`, and per-relation
 * where/orderBy/limit.
 *
 * Run against a Postgres seeded by src/test/fixtures/seed.sql:
 *   DATABASE_URL=postgres://... npx tsx --test src/test/batched-loader-integration.test.ts
 *
 * Gated by DATABASE_URL — absent, every test reports as skipped (never failed).
 *
 * NOTE: manyToMany and belongsTo-null / hasOne cases are covered by the no-DB
 * unit suite (batched-loader.test.ts) because the shared fixture has no junction
 * table and no nullable foreign keys, and its column counts are asserted by
 * other suites (so it must not be modified here).
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { TurbineClient } from '../client.js';
import { introspect } from '../introspect.js';
import type { RelationDef, SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping batched-loader integration tests: DATABASE_URL not set');
}

let db: TurbineClient;
let schema: SchemaMetadata;

const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

describe('batched-loader integration (join vs batched parity)', () => {
  before(async () => {
    schema = await introspect({ connectionString: DATABASE_URL! });
    db = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 5, warnOnUnlimited: false }, schema);
    await db.connect();
  });

  after(async () => {
    await db.disconnect();
  });

  /** Run `args` under both strategies and assert the results are deeply equal. */
  async function assertParity(table: string, args: Record<string, unknown>): Promise<unknown[]> {
    const join = await db.table(table).findMany({ ...args, relationLoadStrategy: 'join' } as never);
    const batched = await db.table(table).findMany({ ...args, relationLoadStrategy: 'batched' } as never);
    assert.deepEqual(batched, join, `batched must equal join for ${table} ${JSON.stringify(args)}`);
    return batched as unknown[];
  }

  it('hasMany: users → posts', async () => {
    const rows = await assertParity('users', {
      orderBy: { id: 'asc' },
      with: { posts: { orderBy: { id: 'asc' } } },
    });
    // Sanity: the parity was non-trivial (at least one user actually has posts).
    assert.ok(
      rows.some(
        (u) => Array.isArray((u as { posts: unknown[] }).posts) && (u as { posts: unknown[] }).posts.length > 0,
      ),
      'expected at least one user with posts',
    );
  });

  it('nested with: users → posts → comments (two levels)', async () => {
    await assertParity('users', {
      orderBy: { id: 'asc' },
      with: {
        posts: {
          orderBy: { id: 'asc' },
          with: { comments: { orderBy: { id: 'asc' } } },
        },
      },
    });
  });

  it('per-relation where + orderBy', async () => {
    await assertParity('users', {
      orderBy: { id: 'asc' },
      with: { posts: { where: { published: true }, orderBy: { id: 'desc' } } },
    });
  });

  it('per-relation limit (top-N per parent matches join)', async () => {
    await assertParity('users', {
      orderBy: { id: 'asc' },
      with: { posts: { orderBy: { id: 'asc' }, limit: 1 } },
    });
  });

  it('per-relation select narrows the same columns under both strategies', async () => {
    await assertParity('users', {
      orderBy: { id: 'asc' },
      with: { posts: { orderBy: { id: 'asc' }, select: { title: true } } },
    });
  });

  it('belongsTo: posts → parent (non-null FK)', async () => {
    // Find a belongsTo relation on posts (e.g. its user/org) from the schema.
    const postRels = schema.tables.posts?.relations ?? {};
    const belongsTo = Object.values(postRels).find((r: RelationDef) => r.type === 'belongsTo');
    if (!belongsTo) return; // fixture without a belongsTo — nothing to assert
    await assertParity('posts', {
      orderBy: { id: 'asc' },
      limit: 20,
      with: { [belongsTo.name]: true },
    });
  });

  it('findUnique parity for a single row with relations', async () => {
    const first = (await db.table('users').findMany({ orderBy: { id: 'asc' }, limit: 1 })) as { id: number }[];
    if (first.length === 0) return;
    const id = first[0]!.id;
    const withClause = { posts: { orderBy: { id: 'asc' }, with: { comments: { orderBy: { id: 'asc' } } } } };
    const join = await db
      .table('users')
      .findUnique({ where: { id }, with: withClause, relationLoadStrategy: 'join' } as never);
    const batched = await db
      .table('users')
      .findUnique({ where: { id }, with: withClause, relationLoadStrategy: 'batched' } as never);
    assert.deepEqual(batched, join);
  });

  it('batched load participates in a transaction (same connection path)', async () => {
    await db.$transaction(async (tx) => {
      const join = await tx.table('users').findMany({
        orderBy: { id: 'asc' },
        with: { posts: { orderBy: { id: 'asc' } } },
        relationLoadStrategy: 'join',
      } as never);
      const batched = await tx.table('users').findMany({
        orderBy: { id: 'asc' },
        with: { posts: { orderBy: { id: 'asc' } } },
        relationLoadStrategy: 'batched',
      } as never);
      assert.deepEqual(batched, join);
    });
  });
});
