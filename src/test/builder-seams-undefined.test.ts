/**
 * turbine-orm, `undefined` means absent, decided once at the args seam.
 *
 * Covers query/normalize-args.ts and its use at every operation's seam:
 *   - the prune pass itself (positions pruned, by-reference fast path, shapes
 *     written empty left alone, `data` never touched);
 *   - the SQL-template cache cannot be poisoned by an `undefined` operand, in
 *     PRODUCTION mode (where the dev cross-check is off): a warm client and a
 *     fresh client build identical SQL and params for the same call;
 *   - the mutation empty-where guard sees through a relation filter whose
 *     values are all `undefined`;
 *   - `findFirst` / `findFirstOrThrow` refuse a `where` whose every key was
 *     `undefined`, while `findMany` / `count` keep "undefined means absent".
 *
 * Build-only (no DB).
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type pg from 'pg';
import { ValidationError } from '../errors.js';
import { QueryInterface } from '../query/index.js';
import { pruneUndefinedArgs, whereEmptiedByPruning } from '../query/normalize-args.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  const tables: Record<string, TableMetadata> = {};
  tables.users = mockTable(
    'users',
    [
      { name: 'id', field: 'id' },
      { name: 'email', field: 'email', pgType: 'text', unique: true },
      { name: 'name', field: 'name', pgType: 'text' },
      { name: 'score', field: 'score', pgType: 'int4' },
      { name: 'org_id', field: 'orgId' },
      { name: 'tags', field: 'tags', pgType: '_text' },
      { name: 'data', field: 'data', pgType: 'jsonb' },
    ],
    {
      posts: { type: 'hasMany', name: 'posts', from: 'users', to: 'posts', foreignKey: 'user_id', referenceKey: 'id' },
      org: { type: 'belongsTo', name: 'org', from: 'users', to: 'orgs', foreignKey: 'org_id', referenceKey: 'id' },
    },
  );
  tables.posts = mockTable(
    'posts',
    [
      { name: 'id', field: 'id' },
      { name: 'user_id', field: 'userId' },
      { name: 'title', field: 'title', pgType: 'text' },
      { name: 'views', field: 'views', pgType: 'int4' },
    ],
    {
      user: { type: 'belongsTo', name: 'user', from: 'posts', to: 'users', foreignKey: 'user_id', referenceKey: 'id' },
    },
  );
  tables.orgs = mockTable('orgs', [
    { name: 'id', field: 'id' },
    { name: 'name', field: 'name', pgType: 'text' },
  ]);
  return { tables, enums: {} };
}

const S = schema();
const prune = (table: string, args: unknown) => pruneUndefinedArgs(S, table, args);

describe('pruneUndefinedArgs: the prune pass', () => {
  it('returns the args object itself when nothing is undefined', () => {
    const args = {
      where: { score: { gte: 1, lte: 2 }, posts: { some: { views: { gt: 3 } } }, OR: [{ name: 'a' }] },
      orderBy: [{ score: 'asc' }],
      cursor: { id: 3 },
      with: { posts: { where: { views: 1 }, orderBy: { id: 'desc' } } },
    };
    assert.equal(prune('users', args), args);
    assert.equal(prune('users', undefined), undefined);
  });

  it('strips an undefined operator key and keeps its sibling', () => {
    assert.deepEqual(prune('users', { where: { score: { gte: undefined, lte: 2 } } }), {
      where: { score: { lte: 2 } },
    });
  });

  it('removes an object emptied by stripping, recursively, through relation filters', () => {
    for (const where of [
      { user: { email: undefined } },
      { user: { is: { email: undefined } } },
      { user: { isNot: { email: undefined } } },
      { user: { is: undefined } },
    ]) {
      assert.deepEqual(prune('posts', { where }), { where: {} }, JSON.stringify(where));
    }
    for (const where of [
      { posts: { some: { title: undefined } } },
      { posts: { none: { views: { gt: undefined } } } },
      { posts: { every: { title: undefined } } },
      { NOT: { email: undefined } },
      { AND: [{ email: undefined }] },
      { OR: [{ email: undefined }, { name: { contains: undefined } }] },
    ]) {
      assert.deepEqual(prune('users', { where }), { where: {} }, JSON.stringify(where));
    }
  });

  it('leaves a shape that was already empty exactly as written', () => {
    for (const where of [{}, { user: {} }, { OR: [] }, { user: { is: {} } }]) {
      const args = { where };
      assert.equal(prune('posts', args), args, JSON.stringify(where));
    }
  });

  it('drops an emptied AND / OR element and keeps the others', () => {
    assert.deepEqual(prune('users', { where: { OR: [{ email: undefined }, { name: 'a' }] } }), {
      where: { OR: [{ name: 'a' }] },
    });
    assert.deepEqual(prune('users', { where: { AND: [{ name: 'a' }, { score: { gt: undefined } }] } }), {
      where: { AND: [{ name: 'a' }] },
    });
  });

  it('removes an operator object left holding only a modifier', () => {
    assert.deepEqual(prune('users', { where: { name: { contains: undefined, mode: 'insensitive' } } }), {
      where: {},
    });
    assert.deepEqual(prune('users', { where: { data: { path: ['a'], equals: undefined } } }), { where: {} });
    assert.deepEqual(prune('users', { where: { score: { not: { gt: undefined } } } }), { where: {} });
    assert.deepEqual(prune('users', { where: { score: { not: { gt: undefined, lt: 4 } } } }), {
      where: { score: { not: { lt: 4 } } },
    });
  });

  it('never walks an operand value', () => {
    const inList = [1, undefined];
    const json = { a: 1, b: undefined };
    const args = { where: { score: { in: inList }, data: { contains: json } } };
    const out = prune('users', args) as typeof args;
    assert.equal(out, args);
    assert.equal(out.where.score.in, inList);
    assert.equal(out.where.data.contains, json);
  });

  it('prunes `with` relation wheres at depth, and orderBy / cursor / having', () => {
    assert.deepEqual(
      prune('users', {
        with: {
          posts: { where: { views: { gt: undefined, lt: 3 } }, with: { user: { where: { email: undefined } } } },
        },
      }),
      { with: { posts: { where: { views: { lt: 3 } }, with: { user: {} } } } },
    );
    assert.deepEqual(prune('users', { cursor: { id: undefined } }), {});
    assert.deepEqual(prune('users', { cursor: { score: undefined, id: 3 } }), { cursor: { id: 3 } });
    assert.deepEqual(prune('users', { orderBy: { score: undefined } }), {});
    assert.deepEqual(prune('users', { orderBy: [{ score: undefined }, { id: 'asc' }] }), { orderBy: [{ id: 'asc' }] });
    assert.deepEqual(prune('users', { orderBy: { score: { sort: 'asc', nulls: undefined } } }), {
      orderBy: { score: { sort: 'asc' } },
    });
    assert.deepEqual(prune('users', { having: { score: { _sum: { gt: undefined } } } }), { having: {} });
  });

  it('never touches write data', () => {
    const data = { name: undefined, data: { a: undefined } };
    const args = { where: { id: 1 }, data };
    assert.equal(prune('users', args), args);
  });

  it('reports a where emptied by pruning, and only that', () => {
    const emptied = { where: { email: undefined } };
    assert.equal(whereEmptiedByPruning(emptied, prune('users', emptied)), true);
    const written = { where: {} };
    assert.equal(whereEmptiedByPruning(written, prune('users', written)), false);
    const partial = { where: { email: undefined, name: 'a' } };
    assert.equal(whereEmptiedByPruning(partial, prune('users', partial)), false);
  });
});

// ---------------------------------------------------------------------------
// The SQL-template cache, in production mode
// ---------------------------------------------------------------------------

type Pair = [label: string, table: string, a: Record<string, unknown>, b: Record<string, unknown>];

const PAIRS: Pair[] = [
  [
    'range gte/lte',
    'users',
    { where: { score: { gte: undefined, lte: 2 } } },
    { where: { score: { gte: 2, lte: undefined } } },
  ],
  [
    'not/equals',
    'users',
    { where: { score: { not: undefined, equals: 3 } } },
    { where: { score: { not: 3, equals: undefined } } },
  ],
  [
    'in/notIn',
    'users',
    { where: { score: { in: [1], notIn: undefined } } },
    { where: { score: { in: undefined, notIn: [1] } } },
  ],
  [
    'startsWith/gt',
    'users',
    { where: { name: { startsWith: undefined, gt: 'm' } } },
    { where: { name: { startsWith: 'm', gt: undefined } } },
  ],
  [
    'contains param count',
    'users',
    { where: { name: { contains: undefined } } },
    { where: { name: { contains: 'a' } } },
  ],
  [
    'json path range',
    'users',
    { where: { data: { path: ['a'], gt: undefined, lt: 3 } } },
    { where: { data: { path: ['a'], gt: 3, lt: undefined } } },
  ],
  [
    'array has/hasSome',
    'users',
    { where: { tags: { has: undefined, hasSome: ['x'] } } },
    { where: { tags: { has: 'x', hasSome: undefined } } },
  ],
  [
    'relation some/none',
    'users',
    { where: { posts: { some: undefined, none: { views: 1 } } } },
    { where: { posts: { some: { views: 1 }, none: undefined } } },
  ],
  [
    'relation is/isNot',
    'users',
    { where: { org: { is: undefined, isNot: { name: 'a' } } } },
    { where: { org: { is: { name: 'a' }, isNot: undefined } } },
  ],
  [
    'relation body range',
    'users',
    { where: { posts: { some: { views: { gt: undefined, lt: 3 } } } } },
    { where: { posts: { some: { views: { gt: 3, lt: undefined } } } } },
  ],
  [
    'NOT body',
    'users',
    { where: { NOT: { score: undefined, name: 'a' } } },
    { where: { NOT: { score: 1, name: undefined } } },
  ],
  [
    'with.where range',
    'users',
    { with: { posts: { where: { views: { gt: undefined, lt: 3 } } } } },
    { with: { posts: { where: { views: { gt: 3, lt: undefined } } } } },
  ],
  [
    'cursor field',
    'users',
    { orderBy: [{ score: 'asc' }, { id: 'asc' }], cursor: { score: undefined, id: 3 } },
    { orderBy: [{ score: 'asc' }, { id: 'asc' }], cursor: { score: 2, id: 3 } },
  ],
];

function inProduction(fn: () => void): void {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev;
  }
}

describe('SQL-template cache: an undefined operand cannot poison a warm template (production mode)', () => {
  for (const [label, table, a, b] of PAIRS) {
    it(`findMany: ${label}`, () => {
      inProduction(() => {
        const warm = makeQuery(table, S);
        const fresh = makeQuery(table, S);
        warm.buildFindMany(a as never);
        const w = warm.buildFindMany(b as never);
        const f = fresh.buildFindMany(b as never);
        assert.equal(w.sql, f.sql);
        assert.deepEqual(w.params, f.params);
      });
    });
    if (!('with' in a) && !('cursor' in a)) {
      it(`count: ${label}`, () => {
        inProduction(() => {
          const warm = makeQuery(table, S);
          const fresh = makeQuery(table, S);
          warm.buildCount(a as never);
          const w = warm.buildCount(b as never);
          const f = fresh.buildCount(b as never);
          assert.equal(w.sql, f.sql);
          assert.deepEqual(w.params, f.params);
        });
      });
    }
  }

  it('updateMany and deleteMany share the guarantee', () => {
    inProduction(() => {
      const warm = makeQuery('users', S);
      const fresh = makeQuery('users', S);
      const a = { where: { score: { gte: undefined, lte: 2 } }, data: { name: 'x' } };
      const b = { where: { score: { gte: 2, lte: undefined } }, data: { name: 'x' } };
      warm.buildUpdateMany(a as never);
      assert.equal(warm.buildUpdateMany(b as never).sql, fresh.buildUpdateMany(b as never).sql);
      warm.buildDeleteMany({ where: a.where } as never);
      assert.equal(
        warm.buildDeleteMany({ where: b.where } as never).sql,
        fresh.buildDeleteMany({ where: b.where } as never).sql,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

describe('the mutation empty-where guard sees through emptied relation filters', () => {
  const shapes: [string, Record<string, unknown>][] = [
    ['user: { email: undefined }', { user: { email: undefined } }],
    ['user: { is: { email: undefined } }', { user: { is: { email: undefined } } }],
    ['user: { isNot: { email: undefined } }', { user: { isNot: { email: undefined } } }],
    ['NOT: { user: { email: undefined } }', { NOT: { user: { email: undefined } } }],
    ['AND: [{ user: { email: undefined } }]', { AND: [{ user: { email: undefined } }] }],
  ];
  for (const [label, where] of shapes) {
    it(`deleteMany / updateMany refuse ${label}`, () => {
      const q = makeQuery('posts', S);
      assert.throws(
        () => q.buildDeleteMany({ where } as never),
        (e: unknown) => {
          assert.ok(e instanceof ValidationError);
          assert.match((e as Error).message, /deleteMany on "posts" refused: the `where` clause is empty/);
          return true;
        },
      );
      assert.throws(() => q.buildUpdateMany({ where, data: { title: 'x' } } as never), /updateMany on "posts" refused/);
    });
  }

  it('a to-many relation filter emptied by undefined is refused too', () => {
    const q = makeQuery('users', S);
    assert.throws(
      () => q.buildDeleteMany({ where: { posts: { some: { title: undefined } } } } as never),
      ValidationError,
    );
  });

  it('a relation filter with a defined value still compiles', () => {
    const q = makeQuery('posts', S);
    assert.match(q.buildDeleteMany({ where: { user: { email: 'a@b.c' } } } as never).sql, /EXISTS/);
  });
});

function stubPool(calls: string[]): pg.Pool {
  return {
    query: async (sql: string) => {
      calls.push(String(typeof sql === 'object' ? (sql as { text: string }).text : sql));
      return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
    },
  } as unknown as pg.Pool;
}

describe('findFirst refuses a where whose every key was undefined', () => {
  it('buildFindFirst and buildFindFirstOrThrow refuse, naming the method', () => {
    const q = makeQuery('users', S);
    assert.throws(
      () => q.buildFindFirst({ where: { email: undefined } }),
      /findFirst on "users" refused: every key in `where` was undefined/,
    );
    assert.throws(
      () => q.buildFindFirstOrThrow({ where: { email: undefined, posts: { some: { title: undefined } } } } as never),
      /findFirstOrThrow on "users" refused: every key in `where` was undefined/,
    );
  });

  it('refuses before any statement runs', async () => {
    const calls: string[] = [];
    const q = new QueryInterface(stubPool(calls), 'users', S, []);
    await assert.rejects(() => q.findFirst({ where: { email: undefined } }), ValidationError);
    await assert.rejects(() => q.findFirstOrThrow({ where: { email: undefined } }), ValidationError);
    assert.equal(calls.length, 0);
  });

  it('accepts an omitted or written-empty where, and a partly defined one', () => {
    const q = makeQuery('users', S);
    assert.doesNotMatch(q.buildFindFirst().sql, /WHERE/);
    assert.doesNotMatch(q.buildFindFirst({ where: {} }).sql, /WHERE/);
    assert.match(q.buildFindFirst({ where: { email: undefined, name: 'a' } }).sql, /WHERE "name" = \$1/);
  });

  it('findMany and count keep undefined-means-absent', () => {
    const q = makeQuery('users', S);
    assert.doesNotMatch(q.buildFindMany({ where: { email: undefined } }).sql, /WHERE/);
    assert.doesNotMatch(q.buildCount({ where: { email: undefined } }).sql, /WHERE/);
  });
});

describe('every operation prunes at its seam', () => {
  let prev: string | undefined;
  before(() => {
    prev = process.env.NODE_ENV;
  });
  after(() => {
    if (prev === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev;
  });

  it('aggregate and groupBy read the pruned where', () => {
    const q = makeQuery('users', S);
    const agg = q.buildAggregate({ where: { score: { gt: undefined, lt: 3 } }, _count: true } as never);
    assert.match(agg.sql, /"score" < \$1/);
    assert.deepEqual(agg.params, [3]);
    const gb = q.buildGroupBy({ by: ['orgId'], where: { score: { gt: undefined, lt: 3 } }, _count: true } as never);
    assert.match(gb.sql, /"score" < \$1/);
  });

  it('single-row writes read the pruned where', () => {
    const q = makeQuery('users', S);
    const u = q.buildUpdate({ where: { id: 1, email: undefined }, data: { name: 'x' } } as never);
    assert.doesNotMatch(u.sql, /"email"/);
    assert.throws(() => q.buildDelete({ where: { id: undefined } } as never), ValidationError);
  });
});
