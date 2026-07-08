/**
 * Unit tests for the batched relation-loading strategy (relationLoadStrategy:
 * 'batched'). No database — a fake pg-compatible pool records every SQL string
 * and returns canned rows, so we can assert both the generated SQL shape (base
 * query has no json_agg; follow-ups use `= ANY($1)`) and the client-side
 * stitching, end to end through the real QueryInterface.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { QueryInterface } from '../query/index.js';
import type { RelationDef, SchemaMetadata } from '../schema.js';

// ---------------------------------------------------------------------------
// Fixtures: users -hasMany-> posts, -hasOne-> profile, orgs (m2m via user_orgs)
//           posts -belongsTo-> author (users)
// ---------------------------------------------------------------------------

function makeSchema(): SchemaMetadata {
  const rel = (r: RelationDef): RelationDef => r;
  const table = (name: string, cols: [string, string][], relations: Record<string, RelationDef> = {}) => {
    const columns = cols.map(([n, field]) => ({
      name: n,
      field,
      pgType: 'int8',
      tsType: 'number',
      nullable: false,
      hasDefault: n === 'id',
      isArray: false,
      pgArrayType: 'bigint[]',
    }));
    const columnMap: Record<string, string> = {};
    const reverseColumnMap: Record<string, string> = {};
    for (const c of columns) {
      columnMap[c.field] = c.name;
      reverseColumnMap[c.name] = c.field;
    }
    return {
      name,
      columns,
      columnMap,
      reverseColumnMap,
      dateColumns: new Set<string>(),
      pgTypes: Object.fromEntries(columns.map((c) => [c.name, c.pgType])),
      allColumns: columns.map((c) => c.name),
      primaryKey: ['id'],
      uniqueColumns: [['id']],
      relations,
      indexes: [],
    };
  };

  return {
    enums: {},
    tables: {
      users: table(
        'users',
        [
          ['id', 'id'],
          ['name', 'name'],
        ],
        {
          posts: rel({
            type: 'hasMany',
            name: 'posts',
            from: 'users',
            to: 'posts',
            foreignKey: 'user_id',
            referenceKey: 'id',
          }),
          profile: rel({
            type: 'hasOne',
            name: 'profile',
            from: 'users',
            to: 'profiles',
            foreignKey: 'user_id',
            referenceKey: 'id',
          }),
          orgs: rel({
            type: 'manyToMany',
            name: 'orgs',
            from: 'users',
            to: 'orgs',
            foreignKey: 'id',
            referenceKey: 'id',
            through: { table: 'user_orgs', sourceKey: 'user_id', targetKey: 'org_id' },
          }),
        },
      ),
      posts: table(
        'posts',
        [
          ['id', 'id'],
          ['user_id', 'userId'],
          ['title', 'title'],
        ],
        {
          author: rel({
            type: 'belongsTo',
            name: 'author',
            from: 'posts',
            to: 'users',
            foreignKey: 'user_id',
            referenceKey: 'id',
          }),
        },
      ),
      profiles: table('profiles', [
        ['id', 'id'],
        ['user_id', 'userId'],
        ['bio', 'bio'],
      ]),
      orgs: table('orgs', [
        ['id', 'id'],
        ['name', 'name'],
      ]),
      user_orgs: table('user_orgs', [
        ['user_id', 'userId'],
        ['org_id', 'orgId'],
      ]),
    },
  } as unknown as SchemaMetadata;
}

interface Call {
  sql: string;
  params: unknown[];
}

/**
 * A fake pg pool. Returns canned rows chosen by the FROM table in the SQL, so a
 * batched load's base + follow-up queries each get plausible rows. Records every
 * call for assertions.
 */
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
  // biome-ignore lint/suspicious/noExplicitAny: minimal pg pool shim for tests
  return { pool: pool as any, calls };
}

function usersQi(pool: unknown, rowsByTable: Record<string, Record<string, unknown>[]>) {
  void rowsByTable;
  return new QueryInterface(
    // biome-ignore lint/suspicious/noExplicitAny: fake pool
    pool as any,
    'users',
    makeSchema(),
    [],
    { preparedStatements: false, warnOnUnlimited: false, relationLoadStrategy: 'batched' },
  );
}

const CANNED = {
  users: [
    { id: 1, name: 'alice' },
    { id: 2, name: 'bob' },
  ],
  posts: [
    { id: 10, user_id: 1, title: 'p1' },
    { id: 11, user_id: 1, title: 'p2' },
    { id: 12, user_id: 2, title: 'p3' },
  ],
  profiles: [{ id: 20, user_id: 1, bio: 'hi' }],
  orgs: [
    { id: 100, name: 'acme' },
    { id: 101, name: 'globex' },
  ],
  user_orgs: [
    { s: 1, t: 100 },
    { s: 1, t: 101 },
    { s: 2, t: 100 },
  ],
};

describe('batched relation loading — SQL shape', () => {
  it('base query has no json_agg and no relation subquery', async () => {
    const { pool, calls } = makeFakePool(CANNED);
    await usersQi(pool, CANNED).findMany({ with: { posts: true } });
    const base = calls[0]!;
    assert.match(base.sql, /FROM "users"/);
    assert.doesNotMatch(base.sql, /json_agg/i);
    assert.doesNotMatch(base.sql, /AS "posts"/);
  });

  it('hasMany follow-up uses `= ANY($1)` on the child FK', async () => {
    const { pool, calls } = makeFakePool(CANNED);
    await usersQi(pool, CANNED).findMany({ with: { posts: true } });
    const followUp = calls.find((c) => /FROM "posts"/.test(c.sql))!;
    assert.ok(followUp, 'expected a follow-up query on posts');
    assert.match(followUp.sql, /"user_id" = ANY\(\$1\)/);
    // The parent-key array is bound as a single array param.
    assert.deepEqual(followUp.params, [[1, 2]]);
  });

  it('belongsTo follow-up correlates on the parent PK via `= ANY($1)`', async () => {
    const { pool, calls } = makeFakePool(CANNED);
    const postsQi = new QueryInterface(
      // biome-ignore lint/suspicious/noExplicitAny: fake pool
      pool as any,
      'posts',
      makeSchema(),
      [],
      { preparedStatements: false, warnOnUnlimited: false, relationLoadStrategy: 'batched' },
    );
    await postsQi.findMany({ with: { author: true } });
    const followUp = calls.find((c) => /FROM "users"/.test(c.sql))!;
    assert.match(followUp.sql, /"id" = ANY\(\$1\)/);
  });

  it('manyToMany reads the junction with `= ANY($1)` then the targets', async () => {
    const { pool, calls } = makeFakePool(CANNED);
    await usersQi(pool, CANNED).findMany({ with: { orgs: true } });
    const junction = calls.find((c) => /FROM "user_orgs"/.test(c.sql))!;
    assert.ok(junction, 'expected a junction query');
    assert.match(junction.sql, /"user_id" = ANY\(\$1\)/);
    assert.match(junction.sql, /AS "s"/);
    assert.match(junction.sql, /AS "t"/);
    const targets = calls.find((c) => /FROM "orgs"/.test(c.sql))!;
    assert.ok(targets, 'expected a target query on orgs');
    assert.match(targets.sql, /"id" = ANY\(\$1\)/);
  });

  it('per-relation where/select/orderBy appear in the follow-up SQL', async () => {
    const { pool, calls } = makeFakePool(CANNED);
    await usersQi(pool, CANNED).findMany({
      with: { posts: { where: { title: 'p1' }, select: { title: true }, orderBy: { title: 'desc' } } },
    });
    const followUp = calls.find((c) => /FROM "posts"/.test(c.sql))!;
    // where merged in
    assert.match(followUp.sql, /"title" = \$/);
    // orderBy pushed down so groups come back sorted
    assert.match(followUp.sql, /ORDER BY .*"title" DESC/);
    // select applied — and the stitch key (user_id) auto-added to the projection
    assert.match(followUp.sql, /"title"/);
    assert.match(followUp.sql, /"user_id"/);
  });

  it('per-relation limit is NOT pushed down (applied client-side)', async () => {
    const { pool, calls } = makeFakePool(CANNED);
    await usersQi(pool, CANNED).findMany({ with: { posts: { limit: 1 } } });
    const followUp = calls.find((c) => /FROM "posts"/.test(c.sql))!;
    assert.doesNotMatch(followUp.sql, /LIMIT/i);
  });
});

describe('batched relation loading — stitching', () => {
  it('groups hasMany children by FK and attaches arrays ([] when empty)', async () => {
    const { pool } = makeFakePool({ ...CANNED, posts: [{ id: 10, user_id: 1, title: 'p1' }] });
    const res = (await usersQi(pool, CANNED).findMany({ with: { posts: true } })) as Record<string, unknown>[];
    const u1 = res.find((u) => u.id === 1)!;
    const u2 = res.find((u) => u.id === 2)!;
    assert.deepEqual(
      (u1.posts as unknown[]).map((p) => (p as { title: string }).title),
      ['p1'],
    );
    assert.deepEqual(u2.posts, []); // no children → empty array, not null
  });

  it('attaches single-or-null for hasOne', async () => {
    const { pool } = makeFakePool(CANNED);
    const res = (await usersQi(pool, CANNED).findMany({ with: { profile: true } })) as Record<string, unknown>[];
    const u1 = res.find((u) => u.id === 1)!;
    const u2 = res.find((u) => u.id === 2)!;
    assert.equal((u1.profile as { bio: string }).bio, 'hi');
    assert.equal(u2.profile, null); // no profile → null, not []
  });

  it('applies per-relation limit client-side per parent group', async () => {
    const { pool } = makeFakePool(CANNED); // user 1 has two posts
    const res = (await usersQi(pool, CANNED).findMany({ with: { posts: { limit: 1 } } })) as Record<string, unknown>[];
    const u1 = res.find((u) => u.id === 1)!;
    assert.equal((u1.posts as unknown[]).length, 1);
  });

  it('strips the stitch key when select excluded it (shape matches join)', async () => {
    const { pool } = makeFakePool(CANNED);
    const res = (await usersQi(pool, CANNED).findMany({
      with: { posts: { select: { title: true } } },
    })) as Record<string, unknown>[];
    const u1 = res.find((u) => u.id === 1)!;
    const post = (u1.posts as Record<string, unknown>[])[0]!;
    // The stitch key auto-added to the projection must be stripped from output.
    // (The fake pool ignores `select`, so `id` is a fixture artifact; `userId`
    // being absent is the real guarantee under test.)
    assert.equal('userId' in post, false);
    assert.equal(post.title, 'p1');
  });

  it('stitches manyToMany targets per parent', async () => {
    const { pool } = makeFakePool(CANNED);
    const res = (await usersQi(pool, CANNED).findMany({ with: { orgs: true } })) as Record<string, unknown>[];
    const u1 = res.find((u) => u.id === 1)!;
    const u2 = res.find((u) => u.id === 2)!;
    assert.deepEqual((u1.orgs as { name: string }[]).map((o) => o.name).sort(), ['acme', 'globex']);
    assert.deepEqual(
      (u2.orgs as { name: string }[]).map((o) => o.name),
      ['acme'],
    );
  });
});

describe('batched relation loading — strategy precedence', () => {
  it('client config default is used when no per-query override', async () => {
    const { pool, calls } = makeFakePool(CANNED);
    await usersQi(pool, CANNED).findMany({ with: { posts: true } });
    assert.doesNotMatch(calls[0]!.sql, /json_agg/i); // batched (config)
  });

  it('per-query relationLoadStrategy overrides the client config', async () => {
    const { pool, calls } = makeFakePool({
      ...CANNED,
      users: [{ id: 1, name: 'alice', posts: '[]' }],
    });
    // client config is 'batched'; the per-query 'join' must win → one json_agg query.
    await usersQi(pool, CANNED).findMany({ with: { posts: true }, relationLoadStrategy: 'join' });
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.sql, /json_agg/i);
  });

  it("defaults to 'join' when nothing is configured", async () => {
    const { pool, calls } = makeFakePool({
      ...CANNED,
      users: [{ id: 1, name: 'alice', posts: '[]' }],
    });
    const qi = new QueryInterface(
      // biome-ignore lint/suspicious/noExplicitAny: fake pool
      pool as any,
      'users',
      makeSchema(),
      [],
      { preparedStatements: false, warnOnUnlimited: false }, // no relationLoadStrategy
    );
    await qi.findMany({ with: { posts: true } });
    assert.match(calls[0]!.sql, /json_agg/i);
  });
});
