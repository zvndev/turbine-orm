/**
 * turbine-orm: the batched loader bounds a per-relation `limit` IN THE DATABASE
 *
 * The follow-up query is one flat statement covering every parent
 * (`WHERE fk = ANY($1)`), so a trailing `LIMIT n` would cap the TOTAL rather
 * than the per-parent count. That is true, and it is why the loader used to
 * fetch every matching child and slice each bucket client-side. What it does
 * NOT imply is that no bound can be pushed down: a window function says exactly
 * "at most n rows per key". Measured before the fix, 200 posts with ~505
 * comments each and `with: { comments: { limit: 3 } }`:
 *
 *   strategy   rows over the wire   kept   peak heap
 *   join                      200    600     +0.5 MB
 *   batched               101,000    600    +52.9 MB
 *
 * and this is reachable without opting in: `'auto'` (the default since 0.41)
 * routes a relation to the batched loader whenever its probe column is provably
 * unindexed.
 *
 * WHAT THE REWRITE IS NOT ALLOWED TO DO is change WHICH rows come back, and
 * that is what decides when it may be emitted at all. The join plan takes the
 * limit with one `ORDER BY … LIMIT n` per parent and this takes it with a rank
 * over one flat result; where the ordering leaves TIES, neither plan's choice
 * of tied rows is forced, and measured on real PostgreSQL the two picked
 * differently (5 parents, 32 children, ties and NULLs on the sort column). So
 * the wrapper is emitted only when the relation's `orderBy` covers a NOT NULL
 * unique key of the target, which makes "the n smallest keys per parent" one
 * set in one order; every other shape keeps the client-side slice it always
 * had. These tests pin both halves of that rule.
 *
 * These tests are build-shape tests over a fake pool: they assert the emitted
 * follow-up SQL, that it stays a bound `$n` parameter, that the window's rank
 * column never reaches the caller, that engines without the dialect hook keep
 * the client-side slice, and that the unlimited path (where batched BEATS join,
 * 83 ms to 631 ms on the same data) is untouched. The live join-vs-batched
 * comparison is in batched-partition-limit.integration.test.ts.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Dialect } from '../dialect.js';
import { QueryInterface } from '../query/index.js';
import type { RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';
import { sqliteDialect } from '../sqlite.js';
import { mockTable } from './helpers.js';

/**
 * The child table, carrying one column of every kind the eligibility rule has
 * to tell apart: the primary key, a plain non-unique sort column, a NOT NULL
 * unique column (a total order on its own), and a NULLABLE unique column (NOT a
 * total order: Postgres lets a UNIQUE constraint hold any number of NULLs, and
 * a sort ties them all with each other).
 */
function postsTable(): TableMetadata {
  const meta = mockTable('posts', [
    { name: 'id', field: 'id' },
    { name: 'user_id', field: 'userId' },
    { name: 'title', field: 'title', pgType: 'text' },
    { name: 'rank', field: 'rank', pgType: 'int4' },
    { name: 'slug', field: 'slug', pgType: 'text' },
    { name: 'nickname', field: 'nickname', pgType: 'text' },
  ]);
  meta.uniqueColumns = [['id'], ['slug'], ['nickname']];
  meta.columns.find((c) => c.name === 'nickname')!.nullable = true;
  return meta;
}

function schema(): SchemaMetadata {
  const rel = (r: RelationDef): RelationDef => r;
  return {
    enums: {},
    tables: {
      users: mockTable(
        'users',
        [
          { name: 'id', field: 'id' },
          { name: 'name', field: 'name', pgType: 'text' },
        ],
        {
          posts: rel({
            name: 'posts',
            type: 'hasMany',
            from: 'users',
            to: 'posts',
            foreignKey: 'user_id',
            referenceKey: 'id',
          }),
          profile: rel({
            name: 'profile',
            type: 'hasOne',
            from: 'users',
            to: 'profiles',
            foreignKey: 'user_id',
            referenceKey: 'id',
          }),
        },
      ),
      posts: postsTable(),
      profiles: mockTable('profiles', [
        { name: 'id', field: 'id' },
        { name: 'user_id', field: 'userId' },
        { name: 'bio', field: 'bio', pgType: 'text' },
      ]),
    },
  };
}

const CANNED: Record<string, Record<string, unknown>[]> = {
  users: [
    { id: 1, name: 'alice' },
    { id: 2, name: 'bob' },
  ],
  posts: [
    { id: 10, user_id: 1, title: 'p1', rank: 1, slug: 's1', nickname: 'n1' },
    { id: 11, user_id: 1, title: 'p2', rank: 2, slug: 's2', nickname: 'n2' },
    { id: 12, user_id: 2, title: 'p3', rank: 3, slug: 's3', nickname: 'n3' },
  ],
  profiles: [{ id: 20, user_id: 1, bio: 'hi' }],
};

function makeFakePool(rowsByTable: Record<string, Record<string, unknown>[]> = CANNED) {
  const calls: { sql: string; params: unknown[]; name?: string }[] = [];
  const pool = {
    // Both call shapes: `query(text, values)` unprepared, and the single
    // QueryConfig `{ name, text, values }` the prepared path uses. The NAME is
    // what decides whether a statement accumulates on the server, so a test
    // about naming has to see the object form rather than a stringified one.
    query: async (arg: string | { name?: string; text: string; values?: unknown[] }, values?: unknown[]) => {
      const sql = typeof arg === 'string' ? arg : arg.text;
      const params = (typeof arg === 'string' ? values : arg.values) ?? [];
      calls.push({ sql, params, name: typeof arg === 'string' ? undefined : arg.name });
      // Match the INNERMOST FROM so the window wrapper still resolves to the
      // child table (the wrapper's own FROM is a derived table).
      const matches = [...sql.matchAll(/FROM "(\w+)"/g)];
      const table = matches[matches.length - 1]?.[1];
      const rows = (table && rowsByTable[table]) || [];
      return { rows: rows.map((r) => ({ ...r })), rowCount: rows.length };
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: minimal pg pool shim for tests
  return { pool: pool as any, calls };
}

function usersQi(pool: unknown, dialect?: Dialect) {
  return new QueryInterface<Record<string, unknown>>(
    // biome-ignore lint/suspicious/noExplicitAny: fake pool
    pool as any,
    'users',
    schema(),
    [],
    { preparedStatements: false, warnOnUnlimited: false, relationLoadStrategy: 'batched', dialect },
  );
}

const postsFollowUp = (calls: { sql: string; params: unknown[]; name?: string }[]) =>
  calls.find((c) => /FROM "posts"/.test(c.sql) && !/^SELECT "users"/.test(c.sql))!;

describe('batched loader: per-parent limit pushdown (PostgreSQL)', () => {
  it('emits ROW_NUMBER partitioned by the correlation column, bounded by a $n param', async () => {
    const { pool, calls } = makeFakePool();
    await usersQi(pool).findMany({ with: { posts: { limit: 2, orderBy: { id: 'asc' } } } } as never);
    const followUp = postsFollowUp(calls);
    assert.match(followUp.sql, /ROW_NUMBER\(\) OVER \(PARTITION BY "turbine_pl_src"\."user_id" ORDER BY/);
    assert.match(followUp.sql, /"turbine_pl_rank"\."__turbine_rn" <= \$\d+/);
    // The bound is a BOUND VALUE, never interpolated into the text.
    assert.doesNotMatch(followUp.sql, /<= 2\b/);
    assert.equal(followUp.params[followUp.params.length - 1], 2);
  });

  it("mirrors the relation's orderBy into the window AND the outer result", async () => {
    const { pool, calls } = makeFakePool();
    await usersQi(pool).findMany({
      with: { posts: { limit: 2, orderBy: [{ rank: 'desc' }, { id: 'asc' }] } },
    } as never);
    const followUp = postsFollowUp(calls);
    assert.match(
      followUp.sql,
      /PARTITION BY "turbine_pl_src"\."user_id" ORDER BY "turbine_pl_src"\."rank" DESC, "turbine_pl_src"\."id" ASC\)/,
    );
    // Without the outer ORDER BY the relation array would come back in whatever
    // order the rank filter emitted, since the loader buckets in result order.
    assert.match(followUp.sql, /ORDER BY "turbine_pl_rank"\."rank" DESC, "turbine_pl_rank"\."id" ASC$/);
  });

  it('carries an explicit nulls placement into the window', async () => {
    const { pool, calls } = makeFakePool();
    await usersQi(pool).findMany({
      with: { posts: { limit: 1, orderBy: [{ rank: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }] } },
    } as never);
    assert.match(postsFollowUp(calls).sql, /ORDER BY "turbine_pl_src"\."rank" ASC NULLS FIRST, /);
  });

  it('never leaks the rank column into the returned entities', async () => {
    const { pool } = makeFakePool();
    const rows = (await usersQi(pool).findMany({
      with: { posts: { limit: 2, orderBy: { id: 'asc' } } },
    } as never)) as Record<string, unknown>[];
    const posts = rows[0]!.posts as Record<string, unknown>[];
    assert.ok(posts.length > 0);
    for (const post of posts) {
      assert.equal('__turbine_rn' in post, false);
      assert.equal('__turbineRn' in post, false);
    }
    // ...and the shape is otherwise the ordinary one.
    assert.deepEqual(Object.keys(posts[0]!), ['id', 'userId', 'title', 'rank', 'slug', 'nickname']);
  });

  it('projects an orderBy column the caller excluded, then strips it again', async () => {
    // The window reads the order column out of the derived table, so it has to
    // be projected; like the correlation keys, it must not survive into output.
    const { pool, calls } = makeFakePool();
    const rows = (await usersQi(pool).findMany({
      with: { posts: { limit: 1, orderBy: [{ rank: 'asc' }, { id: 'asc' }], select: { title: true } } },
    } as never)) as Record<string, unknown>[];
    assert.match(postsFollowUp(calls).sql, /"posts"\."rank"/);
    const post = (rows[0]!.posts as Record<string, unknown>[])[0]!;
    // The fake pool ignores `select`, so `id` is a fixture artifact (same
    // caveat as batched-loader.test.ts); the guarantee under test is that the
    // force-added order column and stitch key are gone.
    assert.equal('rank' in post, false);
    assert.equal('userId' in post, false);
    assert.equal(post.title, 'p1');
  });

  it('leaves the UNLIMITED path byte-identical (no wrapper, no extra param)', async () => {
    const { pool, calls } = makeFakePool();
    await usersQi(pool).findMany({ with: { posts: true } } as never);
    const followUp = postsFollowUp(calls);
    assert.doesNotMatch(followUp.sql, /ROW_NUMBER/);
    assert.equal(followUp.sql, 'SELECT "posts".* FROM "posts" WHERE "user_id" = ANY($1)');
  });

  it('does not wrap a to-one relation (limit is meaningless there)', async () => {
    const { pool, calls } = makeFakePool();
    await usersQi(pool).findMany({ with: { profile: { limit: 3 } } } as never);
    const followUp = calls.find((c) => /FROM "profiles"/.test(c.sql))!;
    assert.doesNotMatch(followUp.sql, /ROW_NUMBER/);
  });

  it('falls back to the client-side slice for an orderBy shape it cannot re-emit', async () => {
    // A JSON-path ordering compiles to an expression with its own bound param;
    // the loader will not reconstruct it, so the whole relation keeps the old
    // behaviour rather than emitting a window ordered differently.
    const { pool, calls } = makeFakePool();
    await usersQi(pool).findMany({
      with: { posts: { limit: 1, orderBy: { title: { path: ['a'], sort: 'asc' } } } },
    } as never);
    assert.doesNotMatch(postsFollowUp(calls).sql, /ROW_NUMBER/);
  });

  it('still applies the client-side slice, so the bound holds either way', async () => {
    // The fake pool ignores the window (it returns every canned row), which is
    // exactly the situation on an engine with no pushdown: the slice is what
    // enforces the limit there, and it must not have been removed.
    const { pool } = makeFakePool();
    const rows = (await usersQi(pool).findMany({
      with: { posts: { limit: 1, orderBy: { id: 'asc' } } },
    } as never)) as Record<string, unknown>[];
    assert.equal((rows[0]!.posts as unknown[]).length, 1);
  });
});

describe('batched loader: the pushdown is only taken on a TOTAL order', () => {
  /** True when this query's `posts` follow-up was rewritten by the window. */
  async function wrapped(args: Record<string, unknown>): Promise<boolean> {
    const { pool, calls } = makeFakePool();
    await usersQi(pool).findMany(args as never);
    return /ROW_NUMBER/.test(postsFollowUp(calls).sql);
  }

  it('declines a relation with no orderBy at all', async () => {
    // An unordered window numbers each partition arbitrarily and so does the
    // join plan's ORDER-BY-less per-parent LIMIT, but they are different plans
    // over different row sets: measured on PostgreSQL 16 they returned
    // different children for every one of 5 parents, while the client-side
    // slice returned the join plan's rows. The slice therefore stays.
    assert.equal(await wrapped({ with: { posts: { limit: 2 } } }), false);
  });

  it('declines an ordering that can leave ties', async () => {
    // `rank` is neither the primary key nor unique, so two posts of one user
    // can share a value and "the first 2" is not a defined set.
    assert.equal(await wrapped({ with: { posts: { limit: 2, orderBy: { rank: 'asc' } } } }), false);
  });

  it('accepts a NOT NULL unique column that is not the primary key', async () => {
    assert.equal(await wrapped({ with: { posts: { limit: 2, orderBy: { slug: 'asc' } } } }), true);
  });

  it('declines a NULLABLE unique column', async () => {
    // A UNIQUE constraint over a nullable column admits any number of NULL
    // rows in Postgres, and a sort ties every one of them with the others.
    assert.equal(await wrapped({ with: { posts: { limit: 2, orderBy: { nickname: 'asc' } } } }), false);
  });

  it('accepts a partial order once a NOT NULL unique key is appended', async () => {
    assert.equal(await wrapped({ with: { posts: { limit: 2, orderBy: [{ rank: 'asc' }, { id: 'asc' }] } } }), true);
    assert.equal(
      await wrapped({ with: { posts: { limit: 2, orderBy: [{ nickname: 'asc' }, { slug: 'desc' }] } } }),
      true,
    );
  });

  it('declines when a child column is spelled like the wrapper rank alias', async () => {
    // The wrapper projects its own `__turbine_rn` beside the child's, and the
    // outer `WHERE … <= $n` then references an ambiguous name: verified live,
    // Postgres 42702, with no Turbine framing on a query the join plan serves
    // fine. The relation keeps the client-side slice instead.
    const s = schema();
    const posts = s.tables.posts!;
    posts.allColumns.push('__turbine_rn');
    posts.columnMap.turbineRn = '__turbine_rn';
    posts.reverseColumnMap.__turbine_rn = 'turbineRn';
    const { pool, calls } = makeFakePool();
    const qi = new QueryInterface<Record<string, unknown>>(
      // biome-ignore lint/suspicious/noExplicitAny: fake pool
      pool as any,
      'users',
      s,
      [],
      { preparedStatements: false, warnOnUnlimited: false, relationLoadStrategy: 'batched' },
    );
    await qi.findMany({ with: { posts: { limit: 2, orderBy: { id: 'asc' } } } } as never);
    assert.doesNotMatch(postsFollowUp(calls).sql, /ROW_NUMBER/);
  });
});

describe('batched loader: the window ORDER BY is the statement it wraps', () => {
  it('dedupes repeated sort keys exactly as the inner statement does', async () => {
    // The follow-up is compiled as a top-level findMany on the child table, so
    // its own orderBy is deduped (filters.ts `dedupeOrderEntries`). Reading the
    // RAW args here made the wrapper rank by a DIFFERENT expression than the
    // statement it wraps, and, because a wrapper is named after its own text,
    // it minted one un-reclaimable server-side prepared statement per spelling:
    // measured on PostgreSQL 16, 25 requests that were semantically one sort
    // key left 26 named statements on one connection (25 of them wrappers).
    // With the dedupe they leave 2, and 1 wrapper.
    const { pool, calls } = makeFakePool();
    await usersQi(pool).findMany({
      with: { posts: { limit: 2, orderBy: [{ rank: 'asc' }, { rank: 'desc' }, { id: 'asc' }] } },
    } as never);
    const followUp = postsFollowUp(calls);
    assert.match(
      followUp.sql,
      /PARTITION BY "turbine_pl_src"\."user_id" ORDER BY "turbine_pl_src"\."rank" ASC, "turbine_pl_src"\."id" ASC\)/,
    );
    // The inner statement carries the same two terms; the wrapper must not add
    // a third the sort below it never applied.
    assert.doesNotMatch(followUp.sql, /"rank" DESC/);
  });

  it('inherits the unnamed verdict of a statement past the named-sort cap', async () => {
    // Four distinct sort keys is past MAX_NAMED_ORDER_KEYS, so the inner
    // statement is sent unnamed; the wrapper is named after its own text and
    // would otherwise re-name what the cap just refused to name. Verified live:
    // 16 four-key permutations left 0 named wrappers.
    const { pool, calls } = makeFakePool();
    const qi = new QueryInterface<Record<string, unknown>>(
      // biome-ignore lint/suspicious/noExplicitAny: fake pool
      pool as any,
      'users',
      schema(),
      [],
      { preparedStatements: true, warnOnUnlimited: false, relationLoadStrategy: 'batched' },
    );
    await qi.findMany({
      with: {
        posts: { limit: 2, orderBy: [{ rank: 'asc' }, { title: 'asc' }, { slug: 'asc' }, { id: 'asc' }] },
      },
    } as never);
    const followUp = postsFollowUp(calls);
    assert.match(followUp.sql, /ROW_NUMBER/);
    assert.equal(followUp.name, undefined, 'a wrapper over an unnamed statement must stay unnamed');
  });

  it('names the wrapper when the statement it wraps is named', async () => {
    // The counterpart, so the test above cannot pass by the pushdown being off.
    const { pool, calls } = makeFakePool();
    const qi = new QueryInterface<Record<string, unknown>>(
      // biome-ignore lint/suspicious/noExplicitAny: fake pool
      pool as any,
      'users',
      schema(),
      [],
      { preparedStatements: true, warnOnUnlimited: false, relationLoadStrategy: 'batched' },
    );
    await qi.findMany({ with: { posts: { limit: 2, orderBy: [{ rank: 'asc' }, { id: 'asc' }] } } } as never);
    const followUp = postsFollowUp(calls);
    assert.match(followUp.sql, /ROW_NUMBER/);
    assert.equal(typeof followUp.name, 'string');
  });
});

describe('batched loader: engines without the dialect hook', () => {
  it('sqlite emits no window wrapper and keeps the client-side slice', async () => {
    const { pool, calls } = makeFakePool();
    const rows = (await usersQi(pool, sqliteDialect).findMany({
      with: { posts: { limit: 1 } },
    } as never)) as Record<string, unknown>[];
    const followUp = calls.find((c) => /FROM "posts"/.test(c.sql) && !/^SELECT "users"/.test(c.sql))!;
    assert.doesNotMatch(followUp.sql, /ROW_NUMBER/);
    assert.equal((rows[0]!.posts as unknown[]).length, 1);
  });
});
