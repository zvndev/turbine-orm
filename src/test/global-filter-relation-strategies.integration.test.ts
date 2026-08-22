/**
 * turbine-orm: a relation TARGET's global filter, across every relation-load
 * strategy, against a real PostgreSQL.
 *
 * The regression this file exists for: the join plan emitted the target's
 * global filter into the correlated subquery unconditionally, but the
 * param-COLLECT mirror early-returned on the `with: { rel: true }` shorthand
 * and pushed nothing for it. A VALUE-BEARING filter therefore compiled a `$N`
 * no value backed:
 *
 *   TURBINE_E004 bind message supplies 1 parameters, but prepared statement
 *   requires 2                                    (first call)
 *   TURBINE_E003 SQL cache lockstep violation      (every call after it)
 *
 * Three things made it survive: a PARAMETERLESS filter (`deletedAt: null`)
 * binds nothing and is unaffected, writing the same relation as
 * `with: { rel: {} }` takes the same SQL and works, and `relationLoadStrategy:
 * 'auto'` falls back to the batched plan on an UNINDEXED correlation column,
 * which hides the join plan entirely. The fixture this runs against has the
 * covering FK indexes, so `auto` chooses the join plan, and one test asserts
 * that (a one-statement read) so this coverage cannot go quietly vacuous.
 *
 * Run against a Postgres seeded by src/test/fixtures/seed.sql:
 *   DATABASE_URL=postgres://... npx tsx --test src/test/global-filter-relation-strategies.integration.test.ts
 *
 * Gated by DATABASE_URL, absent, every test reports as skipped (never failed).
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { Pool } from 'pg';
import { type PgCompatPool, TurbineClient } from '../client.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping global-filter relation-strategy integration tests: DATABASE_URL not set');
}

/** Value-bearing filters. Each binds a `$N`, which is the whole point. */
const PUBLISHED_ONLY = { published: true };
const NON_EMPTY_BODY = { body: { not: '' } };
const REAL_USERS = { role: { not: 'ghost' } };

const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

let schema: SchemaMetadata;
let pool: Pool;
/** Statements as they reached the driver, so a test can count round-trips. */
let statements: { text: string; values: unknown[] }[] = [];

/**
 * A recording pass-through over a real pg pool. Real database, real bind, plus
 * the statement count each strategy actually issued (the only way to prove
 * `auto` chose the join plan rather than silently taking the batched one).
 */
function recordingPool(): PgCompatPool {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: forwarding the pg overloads verbatim
    query: ((textOrConfig: any, values?: any) => {
      const text = typeof textOrConfig === 'string' ? textOrConfig : textOrConfig.text;
      statements.push({ text, values: (typeof textOrConfig === 'string' ? values : textOrConfig.values) ?? [] });
      // biome-ignore lint/suspicious/noExplicitAny: same
      return (pool as any).query(textOrConfig, values);
    }) as PgCompatPool['query'],
    connect: () => pool.connect() as unknown as ReturnType<PgCompatPool['connect']>,
    end: async () => {},
  };
}

function client(globalFilters: Record<string, unknown>): TurbineClient {
  return new TurbineClient(
    {
      pool: recordingPool(),
      warnOnUnlimited: false,
      // biome-ignore lint/suspicious/noExplicitAny: filter shapes are per-test
      globalFilters: globalFilters as any,
    },
    schema,
  );
}

/** Sort relation arrays by `id` so two strategies' row ORDER cannot fail a value comparison. */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(normalize);
    return items.every((r) => typeof r === 'object' && r !== null && 'id' in (r as object))
      ? items.sort((a, b) => Number((a as { id: unknown }).id) - Number((b as { id: unknown }).id))
      : items;
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
  }
  return value;
}

const STRATEGIES = ['join', 'batched', 'auto'] as const;

describe('global filters on a relation target, every relation-load strategy (live)', () => {
  before(async () => {
    schema = await introspect({ connectionString: DATABASE_URL! });
    pool = new Pool({ connectionString: DATABASE_URL!, max: 4 });
  });

  after(async () => {
    await pool.end();
  });

  /**
   * Run one `findMany` under every strategy and assert they agree.
   *
   * A separate client per strategy is deliberate: the SQL-template cache is
   * per-QueryInterface, and reusing one would let a cache HIT (the second
   * failure mode) hide behind the first call's cache MISS.
   */
  async function assertStrategiesAgree(
    table: string,
    globalFilters: Record<string, unknown>,
    args: Record<string, unknown>,
  ): Promise<unknown[]> {
    const results: Record<string, unknown> = {};
    for (const strategy of STRATEGIES) {
      const db = client(globalFilters);
      // Twice: the first call is a cache MISS, the second a HIT that rebuilds
      // params through the collect path alone.
      // biome-ignore lint/suspicious/noExplicitAny: dynamic table accessor
      const first = await (db as any).table(table).findMany({ ...args, relationLoadStrategy: strategy });
      // biome-ignore lint/suspicious/noExplicitAny: dynamic table accessor
      const second = await (db as any).table(table).findMany({ ...args, relationLoadStrategy: strategy });
      assert.deepEqual(
        normalize(second),
        normalize(first),
        `${strategy}: a cache HIT returned something different from the MISS`,
      );
      results[strategy] = normalize(first);
      await db.disconnect();
    }
    for (const strategy of STRATEGIES.slice(1)) {
      assert.deepEqual(
        results[strategy],
        results.join,
        `${strategy} must equal join for ${table} ${JSON.stringify(args)}`,
      );
    }
    return results.join as unknown[];
  }

  for (const [label, spec] of [
    ['true (the shorthand)', true],
    ['{} (explicit empty options)', {}],
    ['{ where }', { where: { title: { not: '' } } }],
    ['{ limit }', { limit: 2 }],
    ['{ orderBy }', { orderBy: { id: 'desc' } }],
  ] as [string, unknown][]) {
    it(`hasMany with: { posts: ${label} } binds the target filter under every strategy`, async () => {
      const rows = await assertStrategiesAgree(
        'users',
        { posts: PUBLISHED_ONLY },
        {
          orderBy: { id: 'asc' },
          with: { posts: spec },
        },
      );
      // Non-vacuous: the filter must have actually removed something, and every
      // surviving child must satisfy it.
      const posts = rows.flatMap((u) => (u as { posts: { published: boolean }[] }).posts);
      assert.ok(posts.length > 0, 'expected at least one post to survive the filter');
      assert.ok(
        posts.every((p) => p.published === true),
        'the target filter must have been applied to the relation rows',
      );
    });
  }

  it('belongsTo with: { user: true } binds the target filter under every strategy', async () => {
    // `limit` keeps `auto` on the join plan for a to-one relation (unbounded, it
    // prefers one batched follow-up over a per-parent correlated subquery).
    const rows = await assertStrategiesAgree(
      'posts',
      { users: REAL_USERS },
      {
        orderBy: { id: 'asc' },
        limit: 5,
        with: { user: true },
      },
    );
    assert.ok(
      rows.some((p) => (p as { user: unknown }).user !== null),
      'expected at least one resolved author',
    );
  });

  it('nested one level deeper: users → posts → comments, both leaves written `true`', async () => {
    // Filters on BOTH relation targets, so a collect path that skips the
    // shorthand leaves an unbacked placeholder at depth 1 AND depth 2.
    const rows = await assertStrategiesAgree(
      'users',
      { posts: PUBLISHED_ONLY, comments: NON_EMPTY_BODY },
      { orderBy: { id: 'asc' }, with: { posts: { with: { comments: true } } } },
    );
    const posts = rows.flatMap((u) => (u as { posts: { published: boolean; comments: unknown[] }[] }).posts);
    assert.ok(posts.length > 0, 'expected surviving posts');
    assert.ok(
      posts.some((p) => p.comments.length > 0),
      'expected at least one post with comments, or the depth-2 arm proves nothing',
    );
  });

  it('nested under a WRAPPED parent (limit + orderBy moves the child into the inner subquery)', async () => {
    await assertStrategiesAgree(
      'users',
      { posts: PUBLISHED_ONLY, comments: NON_EMPTY_BODY },
      {
        orderBy: { id: 'asc' },
        with: { posts: { limit: 2, orderBy: { id: 'asc' }, with: { comments: true } } },
      },
    );
  });

  it('findUnique takes the same relation path', async () => {
    const db = client({ posts: PUBLISHED_ONLY });
    // biome-ignore lint/suspicious/noExplicitAny: dynamic table accessor
    const row = await (db as any).table('users').findUnique({ where: { id: 1 }, with: { posts: true } });
    assert.ok(row, 'expected user 1');
    assert.ok(
      (row as { posts: { published: boolean }[] }).posts.every((p) => p.published === true),
      'the filter must reach the findUnique relation subquery',
    );
    await db.disconnect();
  });

  it('`auto` really chooses the JOIN plan here, so the arms above are not vacuous', async () => {
    // The correlation column posts.user_id is indexed in the fixture, so `auto`
    // keeps the single-statement join plan. If a future fixture change dropped
    // that index, `auto` would fall back to `batched` and every `auto` arm
    // above would stop exercising the join path WITHOUT failing. This test is
    // what makes that visible.
    // Precondition, checked against the LIVE catalog rather than assumed: if
    // another suite has dropped the covering index and not restored it, `auto`
    // legitimately falls back to batched and the assertion below would read as
    // a product defect. Fail here instead, naming the cause.
    const idx = await pool.query(
      "SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'posts' AND indexname = 'idx_posts_user_id'",
    );
    assert.equal(
      idx.rowCount,
      1,
      'idx_posts_user_id is missing from the fixture, so `auto` cannot choose the join plan. ' +
        'Some suite dropped it and did not restore it (see auto-compound-integration.test.ts), ' +
        'or this database predates seed.sql:65. Re-seed with `npm run db:seed`.',
    );

    statements = [];
    const db = client({ posts: PUBLISHED_ONLY });
    // biome-ignore lint/suspicious/noExplicitAny: dynamic table accessor
    await (db as any).table('users').findMany({ limit: 2, with: { posts: true } });
    await db.disconnect();
    assert.equal(
      statements.length,
      1,
      `auto must issue ONE statement (the join plan); got ${statements.length}: ${statements
        .map((s) => s.text)
        .join(' | ')}`,
    );
    assert.deepEqual(statements[0]?.values, [true, 2], 'the target filter value must be bound alongside the limit');
  });

  it('a PARAMETERLESS target filter is unaffected (the shape that hid this for 48 releases)', async () => {
    // `NOT NULL` binds nothing, so the collect path pushing nothing for it was
    // correct by accident. Kept as its own case so the zero-param shape stays
    // covered rather than being replaced by the value-bearing one.
    statements = [];
    const db = client({ posts: { title: { not: null } } });
    // biome-ignore lint/suspicious/noExplicitAny: dynamic table accessor
    await (db as any).table('users').findMany({ limit: 2, with: { posts: true } });
    await db.disconnect();
    assert.ok(
      statements.some((s) => /IS NOT NULL/.test(s.text)),
      `expected the parameterless filter in the SQL: ${statements.map((s) => s.text).join(' | ')}`,
    );
  });
});
