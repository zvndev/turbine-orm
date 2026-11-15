import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { describe, it } from 'node:test';
import { skipGate } from './helpers.js';

const DatabaseSync: typeof DatabaseSyncType | undefined = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();
const sqlite = skipGate(!DatabaseSync, 'SQLite benchmark oracle requires node:sqlite (Node >= 22.5)');

// Load benchmark-owned helpers without pulling them into the library's rootDir.
const exact = await import(new URL('../../benchmarks/equivalence.ts', import.meta.url).href);
const dashboard = await import(new URL('../../benchmarks/dashboard.ts', import.meta.url).href);

describe('benchmark exact value and order oracles', () => {
  const expected = [
    {
      id: '1',
      name: 'Ada',
      created_at: new Date('2026-01-01Z'),
      posts: [
        { id: '11', user_id: '1', title: 'First' },
        { id: '12', user_id: '1', title: 'Second' },
      ],
    },
    { id: '2', name: 'Grace', created_at: new Date('2026-01-02Z'), posts: [] },
  ];
  const arm = () => [
    {
      id: 1n,
      name: 'Ada',
      createdAt: new Date('2026-01-01Z'),
      posts: [
        { id: 11, userId: 1, title: 'First' },
        { id: 12, userId: 1, title: 'Second' },
      ],
    },
    { id: 2, name: 'Grace', createdAt: new Date('2026-01-02Z'), posts: [] },
  ];

  it('accepts exact driver representations while preserving null and Date semantics', () => {
    exact.assertExact('valid', arm(), expected);
    exact.assertExact('integer', { id: 9007199254740993n }, { id: '9007199254740993' });
    assert.throws(() => exact.assertExact('missing', { avatarUrl: null }, {}), /missing.*keys/);
    assert.throws(() => exact.assertExact('null', { avatarUrl: undefined }, { avatarUrl: null }), /null.*avatarUrl/);
    assert.throws(() => exact.assertExact('date', new Date('invalid'), new Date()), /Invalid Date/);
    assert.throws(
      () => exact.assertExact('date type', '2026-01-01T00:00:00.000Z', new Date('2026-01-01Z')),
      /date type/,
    );
  });

  it('rejects a wrong nested column with identical row and child counts', () => {
    const corrupt = arm();
    corrupt[0]!.posts[1]!.title = 'Incorrect column value';
    assert.throws(() => exact.assertExact('wrong-column', corrupt, expected), /wrong-column.*0.posts.1.title/);
  });

  it('rejects reversed parents and reversed children without sorting the defect away', () => {
    assert.throws(() => exact.assertExact('wrong-order', arm().reverse(), expected), /wrong-order.*0/);
    const corrupt = arm();
    corrupt[0]!.posts.reverse();
    assert.throws(() => exact.assertExact('wrong-child-order', corrupt, expected), /wrong-child-order.*posts.0/);
  });

  it('rejects missing, extra and same-width wrong columns', () => {
    assert.throws(() => exact.assertExact('omitted', [{ id: '1' }], [{ id: '1', body: 'payload' }]), /omitted.*keys/);
    assert.throws(
      () => exact.assertExact('wrong key', [{ id: '1', title: 'payload' }], [{ id: '1', body: 'payload' }]),
      /wrong key.*keys/,
    );
    assert.throws(
      () => exact.assertExact('extra', [{ id: 1, body: 'x', hidden: true }], [{ id: 1, body: 'x' }]),
      /extra.*keys/,
    );
    assert.throws(() => exact.assertExact('empty', [], expected), /empty/);
    assert.throws(
      () =>
        exact.assertExact(
          'prototype column',
          JSON.parse('{"__proto__":"wrong"}'),
          JSON.parse('{"__proto__":"expected"}'),
        ),
      /prototype column/,
    );
  });

  it('never rounds arbitrary precision integers or decimals into equivalence', () => {
    assert.throws(() => exact.assertExact('bigint', { id: '9007199254740993' }, { id: '9007199254740992' }), /bigint/);
    assert.throws(
      () => exact.assertExact('unsafe', { id: Number('9007199254740993') }, { id: 9007199254740993n }),
      /Unsafe integer/,
    );
    assert.throws(
      () => exact.assertExact('decimal', { amount: '123456789.1234567891' }, { amount: '123456789.1234567892' }),
      /decimal.*amount/,
    );
    assert.throws(
      () =>
        exact.assertExact(
          'rounded decimal',
          { amount: Number('123456789.1234567891') },
          { amount: '123456789.1234567891' },
        ),
      /rounded decimal/,
    );
    assert.throws(() => exact.assertExact('text', { name: '001' }, { name: '1' }), /text/);
    assert.throws(() => exact.assertExact('alias collision', { userId: 1, user_id: 2 }, { userId: 1 }), /Duplicate/);
    assert.equal(exact.countValue([{ count: '9007199254740993' }]), '9007199254740993');
  });
});

describe('benchmark write effects against an independent SQL store', () => {
  for (const [name, statement, accepted] of [
    ['one increment of the intended row', 'UPDATE posts SET view_count = view_count + 1 WHERE id = 1', true],
    ['no write despite a plausible return', 'SELECT * FROM posts WHERE id = 1', false],
    ['wrong row', 'UPDATE posts SET view_count = view_count + 1 WHERE id = 2', false],
    ['wrong column', "UPDATE posts SET title = 'changed' WHERE id = 1", false],
    ['wrong increment', 'UPDATE posts SET view_count = view_count + 2 WHERE id = 1', false],
    ['collateral write', 'UPDATE posts SET view_count = view_count + 1', false],
  ] as const) {
    sqlite.it(`${accepted ? 'accepts' : 'rejects'} ${name}`, () => {
      const db = new DatabaseSync!(':memory:');
      try {
        db.exec(
          "CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT, view_count INTEGER); INSERT INTO posts VALUES (1, 'first', 7), (2, 'second', 41)",
        );
        const before = db.prepare('SELECT * FROM posts ORDER BY id').all();
        assert.equal(before.length, 2);
        db.exec(statement);
        const after = db.prepare('SELECT * FROM posts ORDER BY id').all();
        if (accepted) exact.assertIncrementEffect(name, before, after);
        else assert.throws(() => exact.assertIncrementEffect(name, before, after), /write effect.*mismatch/);
      } finally {
        db.close();
      }
    });
  }
});

describe('benchmark dashboard semantics', () => {
  sqlite.it('orders tied timestamps by descending id before applying the per-user limit', () => {
    const db = new DatabaseSync!(':memory:');
    try {
      db.exec(
        "CREATE TABLE posts(id INTEGER PRIMARY KEY, user_id INTEGER, created_at TEXT); INSERT INTO posts VALUES (1, 1, '2026-01-01'), (2, 1, '2026-01-02'), (3, 1, '2026-01-02'), (4, 1, '2026-01-02'), (5, 1, '2026-01-02'), (6, 1, '2026-01-02'), (7, 2, '2026-01-03')",
      );
      const recent = db.prepare(dashboard.dashboardSql[3]).all({ $1: 1 });
      assert.deepEqual(
        recent.map((row) => row.id),
        [6, 5, 4, 3, 2],
      );
      assert.deepEqual(dashboard.dashboardOrder, [{ createdAt: 'desc' }, { id: 'desc' }]);
      assert.throws(
        () => exact.assertExact('dashboard wrong-order', [...recent].reverse(), recent),
        /dashboard wrong-order/,
      );
    } finally {
      db.close();
    }
  });

  it('keeps independent reads out of a transaction and transaction reads pinned through commit', async () => {
    for (const mode of ['independent', 'transaction'] as const) {
      const calls: string[] = [];
      const makeQuery = (scope: string) => async (sql: string) => {
        calls.push(`${scope}:${sql}`);
        return { rows: [{ marker: sql }] };
      };
      const pool = {
        query: makeQuery('pool'),
        connect: async () => {
          calls.push('connect');
          return { query: makeQuery('client'), release: () => calls.push('release') };
        },
      };
      const result = await dashboard.rawDashboard(pool, mode);
      assert.equal(result.length, 5);
      assert.deepEqual(
        result.map((r: { rows: { marker: string }[] }) => r.rows[0]!.marker),
        [...dashboard.dashboardSql],
      );
      const expected =
        mode === 'independent'
          ? dashboard.dashboardSql.map((s: string) => `pool:${s}`)
          : [
              'connect',
              'client:BEGIN ISOLATION LEVEL READ COMMITTED',
              ...dashboard.dashboardSql.map((s: string) => `client:${s}`),
              'client:COMMIT',
              'release',
            ];
      assert.deepEqual(calls, expected);
    }
  });

  it('rolls back a failed transaction and releases its connection', async () => {
    const calls: string[] = [];
    const error = new Error('injected dashboard failure');
    await assert.rejects(
      () =>
        dashboard.rawDashboard(
          {
            query: async () => {
              throw new Error('unexpected pool query');
            },
            connect: async () => ({
              query: async (sql: string) => {
                calls.push(sql);
                if (sql === dashboard.dashboardSql[2]) throw error;
                return { rows: [] };
              },
              release: () => calls.push('release'),
            }),
          },
          'transaction',
        ),
      (e: unknown) => e === error,
    );
    assert.deepEqual(calls, [
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      ...dashboard.dashboardSql.slice(0, 3),
      'ROLLBACK',
      'release',
    ]);
  });

  it('starts independent reads together and sequences transaction reads', async () => {
    for (const mode of ['independent', 'transaction'] as const) {
      const pending: (() => void)[] = [];
      const started: string[] = [];
      const make = (key: string) => () =>
        new Promise<string>((resolve) => {
          started.push(key);
          pending.push(() => resolve(key));
        });
      const result = dashboard.dashboardReads(
        {
          user: make('user'),
          postCount: make('posts'),
          commentCount: make('comments'),
          recentPosts: make('recent'),
          userCount: make('users'),
        },
        mode,
      );
      assert.equal(started.length, mode === 'independent' ? 5 : 1);
      for (let i = 0; i < 5; i++) {
        pending[i]!();
        await Promise.resolve();
      }
      assert.deepEqual(await result, ['user', 'posts', 'comments', 'recent', 'users']);
    }
  });
});
