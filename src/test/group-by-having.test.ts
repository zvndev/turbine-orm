/**
 * turbine-orm — groupBy `having` clause tests
 *
 * Build-only (no DB) tests verify the generated HAVING SQL is correct and that
 * every comparison value is parameterized ($N) — no user value is ever
 * interpolated into the SQL string. Security tests assert that a malicious
 * column or operator throws ValidationError instead of reaching the query.
 *
 * The integration suite (requires DATABASE_URL → turbine_having) verifies real
 * grouped + filtered results against the seed fixture.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { ValidationError } from '../errors.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { makeQuery, mockTable, skipGate } from './helpers.js';

// ---------------------------------------------------------------------------
// Build-only schema
// ---------------------------------------------------------------------------

interface Post {
  id: number;
  userId: number;
  published: boolean;
  viewCount: number;
}

function buildSchema(): SchemaMetadata {
  const tables: Record<string, TableMetadata> = {};
  tables.posts = mockTable('posts', [
    { name: 'id', field: 'id' },
    { name: 'user_id', field: 'userId' },
    { name: 'published', field: 'published', pgType: 'bool' },
    { name: 'view_count', field: 'viewCount', pgType: 'int4' },
  ]);
  return { tables, enums: {} };
}

// ---------------------------------------------------------------------------
// Build-only SQL tests
// ---------------------------------------------------------------------------

describe('groupBy having — SQL generation', () => {
  it('emits HAVING COUNT(*) > $1 with the value parameterized', () => {
    const q = makeQuery<Post>('posts', buildSchema());
    const { sql, params } = q.buildGroupBy({
      by: ['published'],
      _count: true,
      having: { _count: { gt: 5 } },
    });
    assert.match(sql, /HAVING COUNT\(\*\) > \$1/);
    // HAVING comes after GROUP BY
    assert.ok(sql.indexOf('GROUP BY') < sql.indexOf('HAVING'), 'HAVING must follow GROUP BY');
    assert.deepEqual(params, [5]);
  });

  it('emits HAVING on an aggregate of a grouped/aggregable column (SUM)', () => {
    const q = makeQuery<Post>('posts', buildSchema());
    const { sql, params } = q.buildGroupBy({
      by: ['published'],
      _sum: { viewCount: true },
      having: { viewCount: { _sum: { gte: 100 } } },
    });
    // Identifier is snake_cased and quoted via quoteIdent
    assert.match(sql, /HAVING SUM\("view_count"\) >= \$1/);
    assert.deepEqual(params, [100]);
  });

  it('a bare number is shorthand for equality', () => {
    const q = makeQuery<Post>('posts', buildSchema());
    const { sql, params } = q.buildGroupBy({
      by: ['published'],
      having: { _count: 3 },
    });
    assert.match(sql, /HAVING COUNT\(\*\) = \$1/);
    assert.deepEqual(params, [3]);
  });

  it('chains multiple having predicates with AND, all parameterized', () => {
    const q = makeQuery<Post>('posts', buildSchema());
    const { sql, params } = q.buildGroupBy({
      by: ['userId'],
      _count: true,
      _sum: { viewCount: true },
      having: { _count: { gt: 1 }, viewCount: { _sum: { lte: 500 } } },
    });
    assert.match(sql, /HAVING COUNT\(\*\) > \$1 AND SUM\("view_count"\) <= \$2/);
    assert.deepEqual(params, [1, 500]);
  });

  it('HAVING params continue numbering after WHERE params', () => {
    const q = makeQuery<Post>('posts', buildSchema());
    const { sql, params } = q.buildGroupBy({
      by: ['published'],
      where: { userId: 7 },
      having: { _count: { gt: 2 } },
    });
    // WHERE uses $1, HAVING must use $2 (continuation of the same param array)
    assert.match(sql, /WHERE "user_id" = \$1/);
    assert.match(sql, /HAVING COUNT\(\*\) > \$2/);
    assert.deepEqual(params, [7, 2]);
  });

  it('HAVING is emitted before ORDER BY', () => {
    const q = makeQuery<Post>('posts', buildSchema());
    const { sql } = q.buildGroupBy({
      by: ['published'],
      _count: true,
      having: { _count: { gt: 1 } },
      orderBy: { published: 'asc' },
    });
    assert.ok(sql.indexOf('HAVING') < sql.indexOf('ORDER BY'), 'HAVING must precede ORDER BY');
  });

  it('supports in / notIn aggregate filters, parameterized as arrays', () => {
    const q = makeQuery<Post>('posts', buildSchema());
    const { sql, params } = q.buildGroupBy({
      by: ['published'],
      having: { _count: { in: [1, 2, 3] } },
    });
    assert.match(sql, /HAVING COUNT\(\*\) = ANY\(\$1\)/);
    assert.deepEqual(params, [[1, 2, 3]]);
  });

  it('no values are interpolated — the SQL string contains no raw numbers from the filter', () => {
    const q = makeQuery<Post>('posts', buildSchema());
    const { sql } = q.buildGroupBy({
      by: ['published'],
      having: { viewCount: { _sum: { gt: 999999 } } },
    });
    assert.ok(!sql.includes('999999'), 'filter value must not appear literally in SQL');
  });
});

// ---------------------------------------------------------------------------
// Security tests — malicious input must throw, never interpolate
// ---------------------------------------------------------------------------

describe('groupBy having — security', () => {
  it('rejects an unknown column inside a having aggregate with ValidationError', () => {
    const q = makeQuery<Post>('posts', buildSchema());
    assert.throws(
      () =>
        q.buildGroupBy({
          by: ['published'],
          // biome-ignore lint/suspicious/noExplicitAny: deliberately malicious input
          having: { ['view_count"); DROP TABLE posts; --' as any]: { _sum: { gt: 1 } } } as any,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError, 'should be ValidationError');
        return true;
      },
    );
  });

  it('rejects an unknown having operator with ValidationError', () => {
    const q = makeQuery<Post>('posts', buildSchema());
    assert.throws(
      () =>
        q.buildGroupBy({
          by: ['published'],
          // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid operator
          having: { _count: { ['gt; DROP TABLE posts' as any]: 1 } as any },
        }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError, 'should be ValidationError');
        assert.match((err as Error).message, /having operator/);
        return true;
      },
    );
  });

  it('a malicious column name never reaches the SQL string (throws before build completes)', () => {
    const q = makeQuery<Post>('posts', buildSchema());
    let built = '';
    try {
      const res = q.buildGroupBy({
        by: ['published'],
        // biome-ignore lint/suspicious/noExplicitAny: deliberately malicious input
        having: { ['1=1) OR (1' as any]: { _max: { gt: 0 } } } as any,
      });
      built = res.sql;
    } catch (err) {
      assert.ok(err instanceof ValidationError);
    }
    assert.ok(!built.includes('1=1'), 'injection payload must never appear in SQL');
  });
});

// ---------------------------------------------------------------------------
// Integration tests (require DATABASE_URL → turbine_having)
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping groupBy having integration tests: DATABASE_URL not set');
}

const testFn = describe;

testFn('groupBy having — integration', () => {
  // Without DATABASE_URL these tests register as skipped (visible in the
  // reporter summary) and the before/after hooks become no-ops.
  const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');
  let db: TurbineClient;
  // Own isolated table so concurrent test files mutating the shared `posts`
  // fixture can't race the exact-count/sum assertions below. Mirrors the
  // fixture's 10 posts deterministically (user_id, published, view_count).
  const TABLE = '_having_posts';

  before(async () => {
    const setup = new pg.Client({ connectionString: DATABASE_URL! });
    await setup.connect();
    try {
      await setup.query(`DROP TABLE IF EXISTS ${TABLE}`);
      await setup.query(
        `CREATE TABLE ${TABLE} (
           id serial PRIMARY KEY,
           user_id int NOT NULL,
           published boolean NOT NULL,
           view_count int NOT NULL
         )`,
      );
      await setup.query(
        `INSERT INTO ${TABLE} (user_id, published, view_count) VALUES
           (1, TRUE, 100), (1, TRUE, 75), (1, FALSE, 0),
           (2, TRUE, 42),  (2, FALSE, 10),
           (3, TRUE, 30),  (5, TRUE, 60), (6, TRUE, 20),
           (7, TRUE, 55),  (7, FALSE, 5)`,
      );
    } finally {
      await setup.end();
    }
    const schema = await introspect({ connectionString: DATABASE_URL! });
    db = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 3 }, schema);
    await db.connect();
  });

  after(async () => {
    if (db) await db.disconnect();
    const teardown = new pg.Client({ connectionString: DATABASE_URL! });
    await teardown.connect();
    try {
      await teardown.query(`DROP TABLE IF EXISTS ${TABLE}`);
    } finally {
      await teardown.end();
    }
  });

  it('filters groups by COUNT(*) > N', async () => {
    // user 1 has 3 posts, user 2 has 2, user 7 has 2, users 3/5/6 have 1 each.
    // HAVING COUNT(*) > 1 → users 1,2,7.
    const results = (await db.table<Post>(TABLE).groupBy({
      by: ['userId'],
      _count: true,
      having: { _count: { gt: 1 } },
    })) as Record<string, unknown>[];
    assert.ok(results.length > 0, 'expected at least one group');
    for (const r of results) {
      assert.ok((r._count as number) > 1, `group ${JSON.stringify(r)} should have count > 1`);
    }
    const userIds = results.map((r) => Number(r.userId)).sort((a, b) => a - b);
    assert.deepEqual(userIds, [1, 2, 7]);
  });

  it('filters groups by SUM(viewCount) >= threshold', async () => {
    // published=true total views = 100+75+42+30+60+20+55 = 382
    // published=false total views = 0+10+5 = 15
    // HAVING SUM(view_count) >= 100 → only the published=true group survives.
    const results = (await db.table<Post>(TABLE).groupBy({
      by: ['published'],
      _sum: { viewCount: true },
      having: { viewCount: { _sum: { gte: 100 } } },
    })) as Record<string, unknown>[];
    assert.equal(results.length, 1, 'only the high-view group should remain');
    const row = results[0]!;
    assert.equal(row.published, true);
    const sum = row._sum as Record<string, unknown>;
    assert.ok((sum.viewCount as number) >= 100);
  });

  it('combines where + having', async () => {
    // Restrict to published posts, then keep user groups summing > 60 views.
    // Published per user: u1=175, u2=42, u3=30, u5=60, u6=20, u7=55.
    // HAVING SUM > 60 → only user 1.
    const results = (await db.table<Post>(TABLE).groupBy({
      by: ['userId'],
      where: { published: true },
      _sum: { viewCount: true },
      having: { viewCount: { _sum: { gt: 60 } } },
    })) as Record<string, unknown>[];
    assert.equal(results.length, 1);
    assert.equal(Number(results[0]!.userId), 1);
  });

  it('returns an empty array when no group satisfies HAVING', async () => {
    const results = (await db.table<Post>(TABLE).groupBy({
      by: ['published'],
      _count: true,
      having: { _count: { gt: 100000 } },
    })) as Record<string, unknown>[];
    assert.equal(results.length, 0);
  });
});
