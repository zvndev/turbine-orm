/**
 * turbine-orm — relation `_count` in `with` (WS-A / A2)
 *
 * Build-only SQL + transform assertions for the join strategy, plus a fake-pool
 * run of the batched strategy asserting byte-identical `_count` output. `_count`
 * subqueries push NO bound params, so param alignment must be unaffected.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RelationError, ValidationError } from '../errors.js';
import { QueryInterface } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

function assertParamsAligned(sql: string, params: unknown[]): void {
  const referenced = new Set<number>();
  for (const m of sql.matchAll(/\$(\d+)/g)) referenced.add(Number(m[1]));
  const max = referenced.size ? Math.max(...referenced) : 0;
  assert.equal(max, params.length, `SQL references up to $${max} but got ${params.length} params: ${sql}`);
  for (let i = 1; i <= params.length; i++) {
    assert.ok(referenced.has(i), `param $${i} never referenced: ${sql}`);
  }
}

function schema(): SchemaMetadata {
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
          posts: {
            type: 'hasMany',
            name: 'posts',
            from: 'users',
            to: 'posts',
            foreignKey: 'user_id',
            referenceKey: 'id',
          },
          profile: {
            type: 'hasOne',
            name: 'profile',
            from: 'users',
            to: 'profiles',
            foreignKey: 'user_id',
            referenceKey: 'id',
          },
          orgs: {
            type: 'manyToMany',
            name: 'orgs',
            from: 'users',
            to: 'orgs',
            foreignKey: 'id',
            referenceKey: 'id',
            through: { table: 'user_orgs', sourceKey: 'user_id', targetKey: 'org_id' },
          },
        },
      ),
      posts: mockTable('posts', [
        { name: 'id', field: 'id' },
        { name: 'user_id', field: 'userId' },
        { name: 'title', field: 'title', pgType: 'text' },
      ]),
      profiles: mockTable('profiles', [
        { name: 'id', field: 'id' },
        { name: 'user_id', field: 'userId' },
        { name: 'bio', field: 'bio', pgType: 'text' },
      ]),
      orgs: mockTable('orgs', [
        { name: 'id', field: 'id' },
        { name: 'name', field: 'name', pgType: 'text' },
      ]),
      user_orgs: mockTable('user_orgs', [
        { name: 'user_id', field: 'userId' },
        { name: 'org_id', field: 'orgId' },
      ]),
    },
  };
}

describe('relation _count — join strategy SQL', () => {
  it('_count: true counts every to-many relation (hasMany + m2m), never to-one', () => {
    const q = makeQuery('users', schema());
    const { sql, params } = q.buildFindMany({ with: { _count: true } } as never);
    // hasMany posts → correlated COUNT(*) on the child FK
    assert.match(
      sql,
      /\(SELECT COUNT\(\*\)::int FROM "posts" t\d+ WHERE t\d+\."user_id" = "users"\."id"\) AS "_count__posts"/,
    );
    // m2m orgs → COUNT(*) on the junction correlated to the parent ref key
    assert.match(
      sql,
      /\(SELECT COUNT\(\*\)::int FROM "user_orgs" t\d+j WHERE t\d+j\."user_id" = "users"\."id"\) AS "_count__orgs"/,
    );
    // hasOne profile is to-one → excluded
    assert.doesNotMatch(sql, /_count__profile/);
    assertParamsAligned(sql, params);
  });

  it('_count: { posts: true } counts only the named relation', () => {
    const q = makeQuery('users', schema());
    const { sql } = q.buildFindMany({ with: { _count: { posts: true } } } as never);
    assert.match(sql, /AS "_count__posts"/);
    assert.doesNotMatch(sql, /_count__orgs/);
  });

  it('coexists with a real relation subquery', () => {
    const q = makeQuery('users', schema());
    const { sql, params } = q.buildFindMany({ with: { posts: true, _count: { posts: true } } } as never);
    assert.match(sql, /json_agg/i); // the posts relation subquery
    assert.match(sql, /AS "_count__posts"/); // and the count
    assertParamsAligned(sql, params);
  });

  it('throws RelationError (E005) for an unknown relation', () => {
    const q = makeQuery('users', schema());
    assert.throws(() => q.buildFindMany({ with: { _count: { bogus: true } } } as never), RelationError);
  });

  it('throws ValidationError (E003) for a to-one relation', () => {
    const q = makeQuery('users', schema());
    assert.throws(() => q.buildFindMany({ with: { _count: { profile: true } } } as never), ValidationError);
  });

  it('transform assembles a _count object on each row', () => {
    const q = makeQuery('users', schema());
    const deferred = q.buildFindMany({ with: { _count: { posts: true, orgs: true } } } as never);
    const out = deferred.transform({
      rows: [{ id: 1, name: 'a', _count__posts: 3, _count__orgs: 2 }],
      // biome-ignore lint/suspicious/noExplicitAny: minimal pg.QueryResult shim
    } as any) as Record<string, unknown>[];
    assert.deepEqual(out[0]!._count, { posts: 3, orgs: 2 });
    assert.equal('_count__posts' in out[0]!, false, 'raw count column must be stripped');
  });
});

// ---------------------------------------------------------------------------
// Batched strategy — byte-identical _count output (fake pool)
// ---------------------------------------------------------------------------

interface Call {
  sql: string;
  params: unknown[];
}

function makeFakePool(rowsByTable: Record<string, Record<string, unknown>[]>) {
  const calls: Call[] = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      const m = /FROM "(\w+)"/.exec(sql);
      const rows = (m && rowsByTable[m[1]!]) || [];
      return { rows, rowCount: rows.length };
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: minimal pg pool shim
  return { pool: pool as any, calls };
}

function usersQi(pool: unknown, strategy: 'join' | 'batched') {
  return new QueryInterface(
    // biome-ignore lint/suspicious/noExplicitAny: fake pool
    pool as any,
    'users',
    schema(),
    [],
    { preparedStatements: false, warnOnUnlimited: false, relationLoadStrategy: strategy },
  );
}

describe('relation _count — batched strategy', () => {
  it('base query has no count subquery; count comes from a grouped follow-up', async () => {
    const { pool, calls } = makeFakePool({
      users: [
        { id: 1, name: 'alice' },
        { id: 2, name: 'bob' },
      ],
      posts: [{ k: 1, c: 2 }],
    });
    await usersQi(pool, 'batched').findMany({ with: { _count: { posts: true } } } as never);
    assert.doesNotMatch(calls[0]!.sql, /_count__posts/);
    const follow = calls.find((c) => /FROM "posts"/.test(c.sql))!;
    assert.ok(follow, 'expected a grouped count follow-up on posts');
    assert.match(follow.sql, /COUNT\(\*\) AS "c"/);
    assert.match(follow.sql, /"user_id" = ANY\(\$1\) GROUP BY "posts"\."user_id"/);
    assert.deepEqual(follow.params, [[1, 2]]);
  });

  it('produces _count output byte-identical to the join strategy', async () => {
    // Join issues exactly ONE statement whose first FROM is the count subquery,
    // so use a fixed-return pool: the count arrives as a scalar column per row.
    const joinPool = {
      query: async () => ({
        rows: [
          { id: 1, name: 'alice', _count__posts: 2 },
          { id: 2, name: 'bob', _count__posts: 0 },
        ],
        rowCount: 2,
      }),
    };
    const joinRes = (await usersQi(joinPool, 'join').findMany({
      with: { _count: { posts: true } },
    } as never)) as Record<string, unknown>[];

    // Batched: base rows + a grouped count follow-up (user 2 absent → 0).
    const batchedPool = makeFakePool({
      users: [
        { id: 1, name: 'alice' },
        { id: 2, name: 'bob' },
      ],
      posts: [{ k: 1, c: 2 }],
    });
    const batchedRes = (await usersQi(batchedPool.pool, 'batched').findMany({
      with: { _count: { posts: true } },
    } as never)) as Record<string, unknown>[];

    const pick = (rows: Record<string, unknown>[]) =>
      rows.map((r) => ({ id: r.id, _count: r._count })).sort((a, b) => Number(a.id) - Number(b.id));
    assert.deepEqual(pick(batchedRes), pick(joinRes));
    assert.deepEqual(pick(joinRes), [
      { id: 1, _count: { posts: 2 } },
      { id: 2, _count: { posts: 0 } },
    ]);
  });

  it('m2m _count counts junction rows in the batched follow-up', async () => {
    const { pool, calls } = makeFakePool({
      users: [{ id: 1, name: 'alice' }],
      user_orgs: [{ k: 1, c: 3 }],
    });
    const res = (await usersQi(pool, 'batched').findMany({ with: { _count: { orgs: true } } } as never)) as Record<
      string,
      unknown
    >[];
    const follow = calls.find((c) => /FROM "user_orgs"/.test(c.sql))!;
    assert.match(follow.sql, /"user_id" = ANY\(\$1\) GROUP BY "user_orgs"\."user_id"/);
    assert.deepEqual(res[0]!._count, { orgs: 3 });
  });
});

// ---------------------------------------------------------------------------
// Global-filter interaction (review fixes: batched skip capture, m2m EXISTS,
// cache-segment guard)
// ---------------------------------------------------------------------------

function usersQiFiltered(pool: unknown, strategy: 'join' | 'batched', globalFilters: Record<string, unknown>) {
  return new QueryInterface(
    // biome-ignore lint/suspicious/noExplicitAny: fake pool
    pool as any,
    'users',
    schema(),
    [],
    {
      preparedStatements: false,
      warnOnUnlimited: false,
      relationLoadStrategy: strategy,
      // biome-ignore lint/suspicious/noExplicitAny: test shape
      globalFilters: globalFilters as any,
    },
  );
}

describe('relation _count — global filters', () => {
  it('batched hasMany _count ANDs the target filter into the grouped follow-up', async () => {
    const { pool, calls } = makeFakePool({
      users: [{ id: 1, name: 'alice' }],
      posts: [{ k: 1, c: 1 }],
    });
    await usersQiFiltered(pool, 'batched', { posts: { title: { not: 'spam' } } }).findMany({
      with: { _count: { posts: true } },
    } as never);
    const follow = calls.find((c) => /FROM "posts"/.test(c.sql))!;
    assert.match(follow.sql, /"user_id" = ANY\(\$1\) AND .*"title".*\$2.* GROUP BY/);
    assert.deepEqual(follow.params, [[1], 'spam']);
    assertParamsAligned(follow.sql, follow.params);
  });

  it('batched m2m _count restricts junction rows to surviving targets via EXISTS', async () => {
    const { pool, calls } = makeFakePool({
      users: [{ id: 1, name: 'alice' }],
      user_orgs: [{ k: 1, c: 2 }],
    });
    await usersQiFiltered(pool, 'batched', { orgs: { name: { not: 'closed' } } }).findMany({
      with: { _count: { orgs: true } },
    } as never);
    const follow = calls.find((c) => /FROM "user_orgs"/.test(c.sql))!;
    assert.match(follow.sql, /EXISTS \(SELECT 1 FROM "orgs" t WHERE t\."id" = "user_orgs"\."org_id" AND /);
    assert.deepEqual(follow.params, [[1], 'closed']);
    assertParamsAligned(follow.sql, follow.params);
  });

  it('batched m2m _count matches the join strategy under a target filter', () => {
    // Join: EXISTS-on-target inside the junction count subquery — same semantics.
    const q = usersQiFiltered(makeFakePool({}).pool, 'join', { orgs: { name: { not: 'closed' } } });
    const { sql, params } = q.buildFindMany({ with: { _count: { orgs: true } } } as never);
    assert.match(
      sql,
      /FROM "user_orgs" t\d+j WHERE t\d+j\."user_id" = "users"\."id" AND EXISTS \(SELECT 1 FROM "orgs"/,
    );
    assert.equal(params[0], 'closed');
    assertParamsAligned(sql, params);
  });

  it('skipGlobalFilters reaches the batched count follow-up (captured pre-await)', async () => {
    const { pool, calls } = makeFakePool({
      users: [{ id: 1, name: 'alice' }],
      posts: [{ k: 1, c: 5 }],
    });
    await usersQiFiltered(pool, 'batched', { posts: { title: { not: 'spam' } } }).findMany({
      skipGlobalFilters: true,
      with: { _count: { posts: true } },
    } as never);
    const follow = calls.find((c) => /FROM "posts"/.test(c.sql))!;
    assert.doesNotMatch(follow.sql, /"title"/);
    assert.deepEqual(follow.params, [[1]]);
  });

  it('a throwing function filter on an UNRELATED table does not break the build', () => {
    const q = usersQiFiltered(makeFakePool({}).pool, 'join', {
      profiles: () => {
        throw new Error('request-scoped: no tenant in context');
      },
    });
    // users query touches posts (_count) but never profiles — must still build.
    const { sql } = q.buildFindMany({ with: { _count: { posts: true } } } as never);
    assert.match(sql, /_count__posts/);
  });
});
