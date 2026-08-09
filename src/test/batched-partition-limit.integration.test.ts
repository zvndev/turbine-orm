/**
 * turbine-orm: the batched per-parent limit pushdown, against a real PostgreSQL
 *
 * The window rewrite (`ROW_NUMBER() OVER (PARTITION BY fk …) <= $n`) changes
 * WHICH rows the follow-up brings back, so unlike every other batched-loader
 * optimization it cannot be signed off on emitted SQL alone. The build-shape
 * suite (batched-partition-limit.test.ts) pins the SQL; this one runs it.
 *
 * Two properties, and they are different in kind:
 *
 *   1. EQUALITY. For a relation whose `orderBy` totally orders the target, the
 *      batched plan returns exactly the join plan's rows, in the join plan's
 *      order, under `'batched'` AND under the default `'auto'`.
 *   2. ELIGIBILITY. For a relation whose `orderBy` does NOT (ties possible, or
 *      no `orderBy` at all), NO wrapper is emitted. That is the load-bearing
 *      half: the join plan takes the limit per parent and the window takes it
 *      over one flat result, so with ties present the two are each free to keep
 *      different rows, and measured on PostgreSQL 16 they did. The shape is
 *      asserted rather than the rows precisely because the rows are the thing
 *      that is not determined.
 *
 * Run against a Postgres seeded by src/test/fixtures/seed.sql:
 *   DATABASE_URL=postgres://... npx tsx --test src/test/batched-partition-limit.integration.test.ts
 *
 * Gated by DATABASE_URL; absent, every test reports as skipped (never failed).
 * READ-ONLY: this suite creates nothing and writes nothing.
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
  console.log('⚠ Skipping partition-limit integration tests: DATABASE_URL not set');
}

let db: TurbineClient;
let schema: SchemaMetadata;
/** Every statement this suite's client executed, in order. */
let statements: string[] = [];

const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

/** Statements carrying the window rewrite (the wrapper is the only ROW_NUMBER). */
const wrappers = (): string[] => statements.filter((s) => s.includes('ROW_NUMBER'));

describe('batched partition-limit pushdown (live PostgreSQL)', () => {
  before(async () => {
    schema = await introspect({ connectionString: DATABASE_URL! });
    db = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 5, warnOnUnlimited: false }, schema);
    db.$on('query', (e) => statements.push(e.sql));
    await db.connect();
  });

  after(async () => {
    await db.disconnect();
  });

  /**
   * Run `args` under join / batched / the default, assert all three agree, and
   * hand back the statements the batched arm emitted.
   */
  async function parity(
    table: string,
    args: Record<string, unknown>,
  ): Promise<{ rows: unknown[]; batchedSql: string[] }> {
    const join = await db.table(table).findMany({ ...args, relationLoadStrategy: 'join' } as never);
    statements = [];
    const batched = await db.table(table).findMany({ ...args, relationLoadStrategy: 'batched' } as never);
    // COPIED, not aliased: `statements` is appended to by the default-strategy
    // run below, which under `'auto'` may take the batched path too and would
    // otherwise be counted as this arm's statements.
    const batchedSql = [...statements];
    const auto = await db.table(table).findMany(args as never);
    const label = `${table} ${JSON.stringify(args)}`;
    assert.deepEqual(batched, join, `batched must equal join for ${label}`);
    assert.deepEqual(auto, join, `the default strategy must equal join for ${label}`);
    return { rows: batched as unknown[], batchedSql };
  }

  it('the fixture still has the tie structure these tests assume', async () => {
    // Precondition, in the style of the differential fuzz suite: without a
    // parent holding MORE children than the limit, and without ties on the
    // sort column, both properties below pass vacuously. Every comment in the
    // seed is inserted by one statement, so `created_at` is one value for the
    // whole table, which is the strongest tie a sort column can have.
    const posts = (await db.table('posts').findMany({
      orderBy: { id: 'asc' },
      with: { comments: { orderBy: { id: 'asc' } } },
    } as never)) as Array<{ comments: { createdAt: Date }[] }>;
    assert.ok(
      posts.some((p) => p.comments.length > 2),
      'no post has more than 2 comments; the per-parent limit is never binding',
    );
    const tied = posts.find((p) => p.comments.length > 2)!;
    const stamps = new Set(tied.comments.map((c) => String(c.createdAt)));
    assert.equal(stamps.size, 1, 'comments no longer share one created_at; the tie shapes below are not tied');
  });

  it('a totally-ordered limited relation is pushed down AND equals the join plan', async () => {
    const { rows, batchedSql } = await parity('posts', {
      orderBy: { id: 'asc' },
      with: { comments: { limit: 2, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
    });
    const wrapped = batchedSql.filter((s) => s.includes('ROW_NUMBER'));
    assert.equal(wrapped.length, 1, 'expected exactly one window-rewritten follow-up');
    assert.match(wrapped[0]!, /PARTITION BY "turbine_pl_src"\."post_id" ORDER BY/);
    assert.ok(
      (rows as Array<{ comments: unknown[] }>).some((p) => p.comments.length === 2),
      'no parent hit the limit; the pushdown was not exercised',
    );
  });

  it('a tied ordering is NOT pushed down (the row choice would not be forced)', async () => {
    statements = [];
    await db.table('posts').findMany({
      orderBy: { id: 'asc' },
      with: { comments: { limit: 2, orderBy: { createdAt: 'asc' } } },
      relationLoadStrategy: 'batched',
    } as never);
    assert.deepEqual(wrappers(), [], 'a sort column with ties must keep the client-side slice');
  });

  it('an unordered limited relation is NOT pushed down', async () => {
    statements = [];
    await db.table('posts').findMany({
      orderBy: { id: 'asc' },
      with: { comments: { limit: 2 } },
      relationLoadStrategy: 'batched',
    } as never);
    assert.deepEqual(wrappers(), [], 'a relation with no orderBy must keep the client-side slice');
  });

  it('stableRelationOrder makes an unordered relation eligible, on both plans', async () => {
    // The plan-symmetric way to ask for the bound: `stableRelationOrder` fills a
    // primary-key ascending order into every to-many relation that declares
    // none, on the join plan and the batched plan alike, which is what makes the
    // shape totally ordered rather than making one plan disagree with the other.
    const { batchedSql } = await parity('posts', {
      orderBy: { id: 'asc' },
      stableRelationOrder: true,
      with: { comments: { limit: 2 } },
    });
    assert.equal(batchedSql.filter((s) => s.includes('ROW_NUMBER')).length, 1);
  });

  it('carries an explicit nulls placement, and still equals the join plan', async () => {
    // NULLS FIRST moves rows across the limit boundary, so a window that
    // dropped the placement would return a different set from the join plan's
    // inner subquery, which does honour it.
    await parity('organizations', {
      orderBy: { id: 'asc' },
      with: { users: { limit: 2, orderBy: [{ lastLoginAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }] } },
    });
    await parity('organizations', {
      orderBy: { id: 'asc' },
      with: { users: { limit: 2, orderBy: [{ lastLoginAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }] } },
    });
  });

  it('a per-relation where narrows the same rows under the pushdown', async () => {
    await parity('users', {
      orderBy: { id: 'asc' },
      with: { posts: { where: { published: true }, limit: 2, orderBy: [{ viewCount: 'desc' }, { id: 'asc' }] } },
    });
  });

  it('a nested limited relation is pushed down at every level', async () => {
    const { batchedSql } = await parity('users', {
      orderBy: { id: 'asc' },
      with: {
        posts: {
          limit: 2,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          with: { comments: { limit: 1, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
        },
      },
    });
    assert.equal(batchedSql.filter((s) => s.includes('ROW_NUMBER')).length, 2);
  });

  it('findUnique takes the same path', async () => {
    const first = (await db.table('posts').findMany({ orderBy: { id: 'asc' }, limit: 1 })) as { id: number }[];
    if (first.length === 0) return;
    const withClause = { comments: { limit: 2, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } };
    const where = { id: first[0]!.id };
    const join = await db.table('posts').findUnique({ where, with: withClause, relationLoadStrategy: 'join' } as never);
    const batched = await db
      .table('posts')
      .findUnique({ where, with: withClause, relationLoadStrategy: 'batched' } as never);
    assert.deepEqual(batched, join);
  });

  it('25 spellings of one sort key leave ONE wrapper statement', async () => {
    // The wrapper is named after its own text, so a text derived from the RAW
    // args instead of the deduped list minted one un-reclaimable server-side
    // prepared statement per spelling: measured 26 statements (25 wrappers) on
    // one connection for these exact 25 requests.
    statements = [];
    for (let n = 1; n <= 25; n++) {
      await db.table('posts').findMany({
        orderBy: { id: 'asc' },
        with: {
          comments: {
            limit: 2,
            orderBy: [...Array.from({ length: n }, () => ({ createdAt: 'asc' })), { id: 'asc' }],
          },
        },
        relationLoadStrategy: 'batched',
      } as never);
    }
    assert.equal(new Set(wrappers()).size, 1, 'the wrapper text must not vary with a redundant sort term');
  });
});
