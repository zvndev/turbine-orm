/**
 * Where-clause shapes that must never compile to no predicate at all.
 *
 *   - A combinator whose value the compiler cannot read (`OR: { ... }`,
 *     `AND: 'x'`, `NOT: 1`, `OR: null`, `OR: [1]`) would apply no condition, so
 *     a relation filter holding one would match every row and a global filter
 *     built that way would leak every tenant. One rule (`combinatorBranches`)
 *     accepts Prisma's shapes and refuses the rest with E003.
 *   - `OR: []` matches no row, as in Prisma.
 *   - An operator object naming no operator (`{ mode: 'insensitive' }`)
 *     compares nothing, so it is refused. The args seam removes one that
 *     `undefined` emptied, so the optional-search idiom reads as "no filter".
 *   - A relation filter takes the relation-filter keys only; anything beside
 *     them is refused rather than dropped.
 *   - `undefined` is decided at the args seam alone: a combinator member holding
 *     it is removed there, and the walk never looks inside a JSON operand.
 *
 * Build-only, plus a live half against PostgreSQL when DATABASE_URL is set.
 *
 * Run: DATABASE_URL=... npx tsx --test src/test/where-hardening-combinators.test.ts
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { ValidationError } from '../errors.js';
import { introspect } from '../introspect.js';
import { resetCacheCrossCheckEnv } from '../query/builder.js';
import type { GlobalFilters } from '../query/index.js';
import { pruneUndefinedArgs } from '../query/normalize-args.js';
import * as whereMod from '../query/where.js';
import { combinatorBranches } from '../query/where-compile.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, skipGate } from './helpers.js';
import { accounts, compileWhere, ctxOf, whereCoreSchema } from './where-core-fixture.js';

// biome-ignore lint/suspicious/noExplicitAny: malformed shapes are the point of these tests
type Any = any;

const posts = (options?: Any) => makeQuery('posts', whereCoreSchema(), options);

/** E003 whose message matches `pattern`. */
function e003(pattern: RegExp) {
  return (err: unknown): boolean => {
    assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
    assert.equal(err.code, 'TURBINE_E003');
    assert.match(err.message, pattern, err.message);
    return true;
  };
}

/** Every walker over `where`: the SQL build, the cache-hit collect and the cache key. */
function eachWalker(where: Record<string, unknown>, q: object = accounts()): (() => unknown)[] {
  const ctx = ctxOf(q);
  return [
    () => whereMod.buildWhereClause(ctx, where, []),
    () => whereMod.collectWhereParams(ctx, where, []),
    () => whereMod.fingerprintWhere(ctx, where),
  ];
}

// ---------------------------------------------------------------------------
// one combinator-shape rule
// ---------------------------------------------------------------------------

const MALFORMED: [string, Record<string, unknown>, RegExp][] = [
  ['OR written as an object', { OR: { email: 'a' } }, /`OR` .* takes an array .*received an object.*Wrap the object/s],
  ['AND as a string', { AND: 'x' }, /`AND` .* takes a where object or an array of them; received a string/],
  ['NOT as a number', { NOT: 1 }, /`NOT` .* received a number/],
  ['OR as null', { OR: null }, /`OR` .* received null/],
  ['NOT as null', { NOT: null }, /`NOT` .* received null/],
  ['an OR element that is a number', { OR: [1] }, /`OR` .* element 0 is a number/],
  ['an AND element that is null', { AND: [{ email: 'a' }, null] }, /`AND` .* element 1 is null/],
  ['a NOT element that is an array', { NOT: [[{ email: 'a' }]] }, /`NOT` .* element 0 is an array/],
  ['AND as a Date', { AND: new Date(0) }, /`AND` .* received a Date instance/],
];

describe('a combinator the compiler cannot read is refused, never dropped', () => {
  for (const [label, where, pattern] of MALFORMED) {
    it(`${label}: E003 from the build, the collect and the fingerprint`, () => {
      for (const walk of eachWalker(where)) assert.throws(walk, e003(pattern));
    });
  }

  it('inside a relation filter body, on the public mutation that deleted every row', () => {
    for (const body of [{ OR: { email: 'a' } }, { AND: 'x' }, { NOT: 1 }, { OR: null }, { OR: [1] }]) {
      assert.throws(() => posts().buildDeleteMany({ where: { author: { is: body } } } as Any), e003(/takes/));
      assert.throws(() => posts().buildDeleteMany({ where: { author: body } } as Any), e003(/takes/));
      assert.throws(() => accounts().buildFindMany({ where: { posts: { some: body } } } as Any), e003(/takes/));
    }
  });

  it('inside a static global filter, at query time', () => {
    for (const filter of [{ OR: { tenantId: 1 } }, { AND: 'x' }, { NOT: null }]) {
      const q = posts({ globalFilters: { posts: filter } as unknown as GlobalFilters });
      assert.throws(() => q.buildFindMany(), e003(/takes/));
      assert.throws(() => q.buildCount(), e003(/takes/));
    }
  });

  it('inside a function global filter, at query time', () => {
    const q = posts({ globalFilters: { posts: () => ({ OR: { tenantId: 7 } }) } as unknown as GlobalFilters });
    assert.throws(() => q.buildFindMany(), e003(/`OR` .* received an object/));
    assert.throws(() => q.buildUpdateMany({ where: { id: 1 }, data: { title: 'x' } } as Any), e003(/`OR`/));
  });

  it('AND written as one object means that object, the same SQL as the array form', () => {
    const object = compileWhere({ AND: { email: 'a', age: 3 } });
    const array = compileWhere({ AND: [{ email: 'a', age: 3 }] });
    assert.equal(object.sql, array.sql);
    assert.deepEqual(object.buildParams, [3, 'a']);
    assert.deepEqual(object.buildParams, array.buildParams);
    assert.deepEqual(object.collectParams, object.buildParams);
    assert.match(object.sql ?? '', /"age" = \$1 AND "email" = \$2/);
  });

  it('a static AND object in a global filter applies', () => {
    const q = posts({ globalFilters: { posts: { AND: { tenantId: 4 } } } as unknown as GlobalFilters });
    const { sql, params } = q.buildFindMany();
    assert.match(sql, /"tenant_id" = \$1/, sql);
    assert.deepEqual(params, [4]);
  });

  it('NOT written as an array negates each branch (NOT a AND NOT b), as in Prisma', () => {
    const { sql, buildParams, collectParams } = compileWhere({ NOT: [{ email: 'a' }, { age: 3 }] });
    assert.equal(sql, 'NOT ("email" = $1) AND NOT ("age" = $2)');
    assert.deepEqual(buildParams, ['a', 3]);
    assert.deepEqual(collectParams, buildParams);
    // The object form still negates the object as a whole.
    assert.equal(compileWhere({ NOT: { email: 'a', age: 3 } }).sql, 'NOT ("age" = $1 AND "email" = $2)');
    // One branch reads the same as the object form.
    assert.equal(compileWhere({ NOT: [{ email: 'a' }] }).sql, compileWhere({ NOT: { email: 'a' } }).sql);
  });

  it('AND: [] and NOT: [] apply no condition', () => {
    assert.equal(compileWhere({ AND: [] }).sql, null);
    assert.equal(compileWhere({ NOT: [] }).sql, null);
    assert.equal(compileWhere({ AND: [], email: 'a' }).sql, '"email" = $1');
  });

  it('combinatorBranches is the exported rule: branches, by reference, or null when absent', () => {
    const arr = [{ a: 1 }];
    assert.equal(combinatorBranches('OR', arr, 't'), arr);
    assert.deepEqual(combinatorBranches('AND', { a: 1 }, 't'), [{ a: 1 }]);
    assert.deepEqual(combinatorBranches('NOT', [undefined, { a: 1 }], 't'), [{ a: 1 }]);
    assert.equal(combinatorBranches('OR', [undefined, undefined], 't'), null);
    assert.equal(combinatorBranches('AND', undefined, 't'), null);
    assert.deepEqual(combinatorBranches('OR', [], 't'), []);
    assert.throws(() => combinatorBranches('OR', { a: 1 }, 'posts'), e003(/on table "posts"/));
    assert.throws(() => combinatorBranches('AND', [null], 'posts', 'having'), e003(/in the having clause/));
  });
});

// ---------------------------------------------------------------------------
// OR: [] matches nothing
// ---------------------------------------------------------------------------

describe('OR: [] matches no row', () => {
  it('compiles to a predicate no row satisfies, with the collect in step', () => {
    const c = compileWhere({ OR: [] });
    assert.equal(c.sql, '"id" = ANY($1)');
    assert.deepEqual(c.buildParams, [[]]);
    assert.deepEqual(c.collectParams, c.buildParams);
    assert.notEqual(c.fingerprint, compileWhere({}).fingerprint);
  });

  it('beside other keys, inside a relation filter and under NOT', () => {
    const beside = compileWhere({ OR: [], age: 1 });
    assert.equal(beside.sql, '"id" = ANY($1) AND "age" = $2');
    assert.deepEqual(beside.collectParams, beside.buildParams);
    assert.notEqual(beside.fingerprint, compileWhere({ age: 1 }).fingerprint);
    const rel = accounts().buildFindMany({ where: { posts: { some: { OR: [] } } } } as Any);
    assert.match(rel.sql, /EXISTS \(SELECT 1 FROM "posts".* = ANY\(\$1\)/s, rel.sql);
    assert.equal(compileWhere({ NOT: { OR: [] } }).sql, 'NOT ("id" = ANY($1))');
  });

  it('the mutation guard reads it as a predicate, so deleteMany({ where: { OR: [] } }) deletes nothing', () => {
    const { sql, params } = accounts().buildDeleteMany({ where: { OR: [] } } as Any);
    assert.match(sql, /WHERE "id" = ANY\(\$1\)/, sql);
    assert.deepEqual(params, [[]]);
  });

  it('a global filter built from an empty list matches nothing', () => {
    const tenants: number[] = [];
    const q = posts({
      globalFilters: { posts: () => ({ OR: tenants.map((t) => ({ tenantId: t })) }) } as unknown as GlobalFilters,
    });
    const { sql, params } = q.buildFindMany();
    assert.match(sql, /WHERE .*"id" = ANY\(\$1\)/, sql);
    assert.deepEqual(params, [[]]);
  });

  it('an OR whose members were all undefined is absent, below the seam too', () => {
    assert.equal(compileWhere({ OR: [undefined, undefined] }).sql, null);
    assert.equal(compileWhere({ OR: [undefined, undefined] }).fingerprint, compileWhere({}).fingerprint);
  });

  it('keeps a named prepared statement: its SQL has one fixed shape', () => {
    const name = (where: Record<string, unknown>) => accounts().buildFindMany({ where } as Any).preparedName;
    assert.ok((name({ OR: [], age: 1 }) ?? '').length > 0);
    assert.ok((name({ age: 1 }) ?? '').length > 0, 'control: a plain where is named');
  });

  it('a warmed template never serves the other shape (production cache)', () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    resetCacheCrossCheckEnv();
    try {
      for (const [first, second] of [
        [{ OR: [], age: 1 }, { age: 2 }],
        [{ age: 2 }, { OR: [], age: 1 }],
      ] as Record<string, unknown>[][]) {
        const q = accounts();
        q.buildFindMany({ where: first } as Any);
        const warm = q.buildFindMany({ where: second } as Any);
        const cold = accounts({ sqlCache: false } as Any).buildFindMany({ where: second } as Any);
        assert.equal(warm.sql, cold.sql);
        assert.deepEqual(warm.params, cold.params);
      }
    } finally {
      process.env.NODE_ENV = saved;
      resetCacheCrossCheckEnv();
    }
  });
});

// ---------------------------------------------------------------------------
// an operator object naming no operator
// ---------------------------------------------------------------------------

describe('an operator object written with no operator is refused', () => {
  const SHAPES: [string, Record<string, unknown>][] = [
    ['mode alone', { email: { mode: 'insensitive' } }],
    ['mode default alone', { email: { mode: 'default' } }],
    ['mode alone on a JSON column', { meta: { mode: 'insensitive' } }],
    ['not holding mode alone', { email: { not: { mode: 'insensitive' } } }],
  ];
  for (const [label, where] of SHAPES) {
    it(`${label}: E003 from the build and the collect`, () => {
      const [build, collect] = eachWalker(where);
      assert.throws(build!, e003(/names no operator/));
      assert.throws(collect!, e003(/names no operator/));
    });
  }

  it('inside a relation filter on deleteMany, the shape that deleted every row', () => {
    assert.throws(
      () => posts().buildDeleteMany({ where: { author: { is: { email: { mode: 'insensitive' } } } } } as Any),
      e003(/names no operator.*"email"/s),
    );
    assert.throws(
      () => posts().buildDeleteMany({ where: { author: { meta: { mode: 'insensitive' } } } } as Any),
      e003(/names no operator/),
    );
  });

  it("Prisma's optional search still reads as no filter: the seam removes the emptied object", () => {
    const search: string | undefined = undefined;
    const { sql } = accounts().buildFindMany({ where: { email: { contains: search, mode: 'insensitive' } } } as Any);
    assert.doesNotMatch(sql, /WHERE/);
    const relation = posts().buildFindMany({
      where: { author: { is: { email: { contains: search, mode: 'insensitive' } } } },
    } as Any);
    assert.doesNotMatch(relation.sql, /WHERE/);
    const having = accounts().buildGroupBy({
      by: ['email'],
      having: { email: { contains: search, mode: 'insensitive' } },
    } as Any);
    assert.doesNotMatch(having.sql, /HAVING/);
  });

  it('an operator beside the modifier still compiles', () => {
    assert.match(compileWhere({ email: { contains: 'a', mode: 'insensitive' } }).sql ?? '', /ILIKE/);
  });
});

// ---------------------------------------------------------------------------
// one undefined rule, decided at the seam
// ---------------------------------------------------------------------------

describe('undefined is decided at the args seam, and JSON operands are data', () => {
  for (const where of [
    { AND: [undefined] },
    { OR: [undefined] },
    { NOT: [undefined] },
    { AND: [undefined, { email: undefined }] },
    { OR: [{ email: undefined }, undefined] },
  ] as Record<string, unknown>[]) {
    it(`findFirst refuses ${JSON.stringify(where, (_k, v) => (v === undefined ? '<undefined>' : v))}`, () => {
      assert.throws(
        () => accounts().buildFindFirst({ where } as Any),
        e003(/findFirst on "accounts" refused: every key in `where` was undefined/),
      );
    });
  }

  it('the seam removes undefined combinator members and keeps the rest', () => {
    const S = whereCoreSchema();
    assert.deepEqual(pruneUndefinedArgs(S, 'accounts', { where: { AND: [undefined, { email: 'a' }] } }), {
      where: { AND: [{ email: 'a' }] },
    });
    assert.deepEqual(pruneUndefinedArgs(S, 'accounts', { where: { OR: [undefined], age: 1 } }), {
      where: { age: 1 },
    });
    // A null member is not absent: it reaches the walk, which refuses it.
    const withNull = { where: { AND: [null] } };
    assert.equal(pruneUndefinedArgs(S, 'accounts', withNull), withNull);
    assert.throws(() => accounts().buildFindMany(withNull as Any), e003(/element 0 is null/));
  });

  it('an undefined inside a JSON operand is data: the filter is kept', () => {
    for (const filter of [{ equals: { a: undefined } }, { contains: { x: undefined } }]) {
      const { sql, params } = accounts().buildFindMany({ where: { meta: filter } } as Any);
      assert.match(sql, /WHERE .*"meta"/, `${JSON.stringify(Object.keys(filter))}: ${sql}`);
      assert.ok(params.length >= 1);
      // findFirst does not read it as an emptied where either.
      assert.match(accounts().buildFindFirst({ where: { meta: filter } } as Any).sql, /WHERE .*"meta"/);
    }
  });

  it('a call holding no undefined comes back from the seam by reference, long in-lists included', () => {
    const S = whereCoreSchema();
    const ids = Array.from({ length: 5000 }, (_, i) => i);
    for (const args of [
      { where: { age: 1, email: { contains: 'a', mode: 'insensitive' } }, limit: 10 },
      { where: { id: { in: ids } } },
      { where: { OR: [{ age: 1 }, { posts: { some: { title: 'x' } } }] }, orderBy: [{ age: 'asc' }] },
      { where: { meta: { equals: { a: undefined } } } },
      { with: { posts: { where: { title: 'x' }, orderBy: { id: 'asc' } } } },
    ]) {
      assert.equal(pruneUndefinedArgs(S, 'accounts', args), args, JSON.stringify(Object.keys(args)));
    }
  });
});

// ---------------------------------------------------------------------------
// typed refusals instead of TypeErrors
// ---------------------------------------------------------------------------

describe('malformed lists are E003, not a TypeError', () => {
  it('distinct with an undefined or non-string element', () => {
    for (const distinct of [[undefined], ['email', undefined], [3], ['']]) {
      assert.throws(() => accounts().buildFindMany({ distinct } as Any), e003(/`distinct` on table "accounts"/));
    }
    assert.throws(
      () =>
        accounts().buildGroupBy({ by: ['email'], distinctOn: { columns: [undefined], orderBy: { id: 'asc' } } } as Any),
      e003(/`distinctOn.columns`/),
    );
  });

  it('NOT: null and AND: [null] at the top level and below a relation', () => {
    for (const where of [{ NOT: null }, { AND: [null] }, { posts: { none: { NOT: null } } }]) {
      assert.throws(() => accounts().buildFindMany({ where } as Any), e003(/takes/));
    }
  });
});

// ---------------------------------------------------------------------------
// HAVING: the same combinator rule
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// A relation filter takes the relation-filter keys only
// ---------------------------------------------------------------------------

const BAD_RELATION_FILTERS: [string, () => object, Record<string, unknown>, RegExp][] = [
  [
    'a typo beside `some`',
    accounts,
    { posts: { some: { title: 'a' }, sum: { title: 'x' } } },
    /"posts" on "accounts": unrecognized key "sum"\. A to-many relation takes `\{ some/,
  ],
  ['a typo alone on a to-many', accounts, { posts: { sum: { title: 'x' } } }, /unrecognized key "sum"/],
  ['a bare where object on a to-many', accounts, { posts: { title: 'x' } }, /unrecognized key "title"\. A to-many/],
  ['an empty object on a to-many', accounts, { posts: {} }, /"posts" on "accounts": the filter object is empty/],
  [
    'a typo beside `is`',
    posts,
    { author: { is: { email: 'a' }, iz: { email: 'x' } } },
    /"author" on "posts": unrecognized key "iz"\. A to-one relation takes `\{ is/,
  ],
  ['a typo beside `isNot: null`', posts, { author: { isNot: null, isnt: { email: 'x' } } }, /unrecognized key "isnt"/],
  [
    'two typos, both named',
    accounts,
    { posts: { every: { title: 'a' }, sum: 1, nay: 2 } },
    /unrecognized key "sum", "nay"/,
  ],
  [
    'one level down, inside the relation body',
    posts,
    { author: { is: { posts: { some: {}, sum: {} } } } },
    /"posts" on "accounts": unrecognized key "sum"/,
  ],
];

describe('a relation filter takes the relation-filter keys only', () => {
  for (const [label, table, where, pattern] of BAD_RELATION_FILTERS) {
    it(`${label}: E003 from the build, the collect and the fingerprint`, () => {
      for (const walk of eachWalker(where, table())) assert.throws(walk, e003(pattern));
    });
  }

  it('the accepted shapes still compile, a bare to-one object as `is`', () => {
    for (const where of [
      { posts: { some: { title: 'a' } } },
      { posts: { none: {}, every: { views: 1 } } },
      { posts: { some: { title: 'a' }, none: undefined } },
    ]) {
      assert.match(accounts().buildFindMany({ where } as Any).sql, /EXISTS/);
    }
    for (const where of [
      { author: { email: 'a' } },
      { author: {} },
      { author: { is: null } },
      { author: { isNot: { email: 'a' } } },
    ]) {
      assert.match(posts().buildFindMany({ where } as Any).sql, /EXISTS/);
    }
  });

  it('on the public mutations, and inside static and function global filters', () => {
    const typo = { author: { is: { tenantId: 1 }, iz: { tenantId: 2 } } };
    assert.throws(() => posts().buildDeleteMany({ where: typo } as Any), e003(/unrecognized key "iz"/));
    assert.throws(() => posts().buildUpdateMany({ where: typo, data: { title: 'x' } } as Any), e003(/"iz"/));
    for (const filter of [typo, () => typo]) {
      const q = posts({ globalFilters: { posts: filter } as unknown as GlobalFilters });
      assert.throws(() => q.buildFindMany(), e003(/unrecognized key "iz"/));
      assert.throws(() => q.buildCount(), e003(/unrecognized key "iz"/));
    }
  });

  it('a warmed template for the valid shape never serves the typo (production cache)', () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    resetCacheCrossCheckEnv();
    try {
      const q = accounts();
      q.buildFindMany({ where: { posts: { some: { title: 'a' } } } } as Any);
      assert.throws(
        () => q.buildFindMany({ where: { posts: { some: { title: 'a' }, sum: { title: 'x' } } } } as Any),
        e003(/unrecognized key "sum"/),
      );
    } finally {
      process.env.NODE_ENV = saved;
      resetCacheCrossCheckEnv();
    }
  });

  it('a key that names both a column and a relation keeps its column filter', () => {
    const s = whereCoreSchema();
    const table = s.tables.accounts!;
    // A to-many relation that shares its name with a jsonb column.
    table.relations = { ...table.relations, meta: { ...table.relations.posts!, name: 'meta' } };
    const q = makeQuery('accounts', s);
    const { sql, params } = q.buildFindMany({ where: { meta: { equals: { a: 1 } } } } as Any);
    assert.match(sql, /WHERE "meta"::jsonb = \$1::jsonb$/, sql);
    assert.doesNotMatch(sql, /EXISTS/, sql);
    assert.deepEqual(params, [JSON.stringify({ a: 1 })]);
    assert.match(q.buildFindMany({ where: { meta: { some: {} } } } as Any).sql, /EXISTS/);
  });
});

describe('having follows the same combinator rule', () => {
  const groupBy = (having: Record<string, unknown>) =>
    accounts().buildGroupBy({ by: ['email'], _count: true, having } as Any);

  it('refuses an OR object and a null branch, as where does', () => {
    assert.throws(() => groupBy({ OR: { email: 'a' } }), e003(/`OR` in the having clause .*received an object/s));
    assert.throws(() => groupBy({ AND: [null] }), e003(/in the having clause .*element 0 is null/s));
    assert.throws(() => groupBy({ NOT: 'x' }), e003(/received a string/));
  });

  it('OR: [] matches no group, AND: [] and NOT: [] apply no condition', () => {
    assert.match(groupBy({ OR: [] }).sql, /HAVING 1 = 0/);
    assert.doesNotMatch(groupBy({ AND: [] }).sql, /HAVING/);
    assert.doesNotMatch(groupBy({ NOT: [] }).sql, /HAVING/);
  });

  it('a NOT array negates each branch; a NOT object negates the object', () => {
    const arr = groupBy({ NOT: [{ email: 'a' }, { email: 'b' }] });
    assert.match(arr.sql, /HAVING NOT \("email" = \$1\) AND NOT \("email" = \$2\)/, arr.sql);
    const obj = groupBy({ NOT: { email: 'a', _count: { gt: 1 } } });
    assert.match(obj.sql, /HAVING NOT \(\(.* AND .*\)\)/, obj.sql);
  });

  it('an AND object is one branch', () => {
    assert.equal(groupBy({ AND: { email: 'a' } }).sql, groupBy({ AND: [{ email: 'a' }] }).sql);
  });
});

// ---------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const live = skipGate(!DATABASE_URL, 'requires DATABASE_URL');

async function runSql(statements: string[]): Promise<void> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  try {
    for (const sql of statements) await pool.query(sql);
  } finally {
    await pool.end();
  }
}

const TABLES = ['wh_comments', 'wh_posts', 'wh_users'];
const DDL = [
  `DROP TABLE IF EXISTS ${TABLES.join(', ')}`,
  `CREATE TABLE wh_users (id int PRIMARY KEY, org_id int NOT NULL, email text NOT NULL UNIQUE, doc jsonb NOT NULL)`,
  `CREATE TABLE wh_comments (id int PRIMARY KEY, user_id int NOT NULL REFERENCES wh_users(id), body text NOT NULL)`,
  `CREATE TABLE wh_posts (id int PRIMARY KEY, org_id int NOT NULL, title text NOT NULL)`,
  `INSERT INTO wh_users VALUES
     (1, 1, 'user1@example.com', '{}'),
     (2, 1, 'user2@example.com', '{"a": 1}'),
     (3, 2, 'User3@Example.com', '[1, 2]'),
     (4, 2, 'user4@example.com', '"text"')`,
  `INSERT INTO wh_comments SELECT g, 1 + (g % 4), 'c' || g FROM generate_series(1, 20) g`,
  `INSERT INTO wh_posts SELECT g, CASE WHEN g <= 6 THEN 1 ELSE 2 END, 'p' || g FROM generate_series(1, 10) g`,
];

const ids = (rows: { id: number }[]) => rows.map((r) => Number(r.id)).sort((a, b) => a - b);

describe('live postgres', () => {
  let schema: SchemaMetadata;
  const clients: TurbineClient[] = [];
  const client = (globalFilters?: unknown) => {
    const db = new TurbineClient(
      { connectionString: DATABASE_URL!, poolSize: 1, warnOnUnlimited: false, globalFilters: globalFilters as never },
      schema,
    );
    clients.push(db);
    return db;
  };

  live.before(async () => {
    await runSql(DDL);
    schema = await introspect({ connectionString: DATABASE_URL!, include: TABLES });
  });

  after(async () => {
    for (const db of clients) await db.disconnect();
    if (DATABASE_URL) await runSql([`DROP TABLE IF EXISTS ${TABLES.join(', ')}`]);
  });

  live.it('deleteMany through a malformed relation body deletes nothing', async () => {
    const db = client();
    for (const body of [{ OR: { email: 'user1@example.com' } }, { AND: 'x' }, { NOT: 1 }, { OR: null }, { OR: [1] }]) {
      await assert.rejects(
        () => db.table('wh_comments').deleteMany({ where: { whUser: { is: body } } } as Any),
        e003(/takes/),
      );
    }
    assert.equal(await db.table('wh_comments').count(), 20);
  });

  live.it('a global filter written as an OR object is refused, an AND object applies', async () => {
    await assert.rejects(
      async () =>
        client({ wh_posts: { OR: { orgId: 1 } } })
          .table('wh_posts')
          .count(),
      e003(/OR/),
    );
    await assert.rejects(
      async () =>
        client({ wh_posts: () => ({ OR: { orgId: 1 } }) })
          .table('wh_posts')
          .count(),
      e003(/`OR`/),
    );
    assert.equal(
      await client({ wh_posts: () => ({ AND: { orgId: 1 } }) })
        .table('wh_posts')
        .count(),
      6,
    );
  });

  live.it('an OR built from an empty list matches nothing, a non-empty one its rows', async () => {
    let tenants: number[] = [];
    const db = client({ wh_posts: () => ({ OR: tenants.map((t) => ({ orgId: t })) }) });
    assert.deepEqual(await db.table('wh_posts').findMany(), []);
    assert.equal(await db.table('wh_posts').count(), 0);
    tenants = [2];
    assert.deepEqual(ids(await db.table<{ id: number }>('wh_posts').findMany()), [7, 8, 9, 10]);

    const plain = client();
    assert.deepEqual(await plain.table('wh_posts').findMany({ where: { OR: [] } } as Any), []);
    assert.equal((await plain.table('wh_posts').findMany({ where: { NOT: { OR: [] } } } as Any)).length, 10);
    assert.deepEqual(await plain.table('wh_posts').deleteMany({ where: { OR: [] } } as Any), { count: 0 });
    assert.equal(await plain.table('wh_posts').count(), 10);
    assert.equal(await plain.table('wh_users').count({ where: { whComments: { some: { OR: [] } } } } as Any), 0);
  });

  live.it('a modifier-only filter is refused, and the optional search is no filter', async () => {
    const db = client();
    await assert.rejects(
      () =>
        db.table('wh_comments').deleteMany({ where: { whUser: { is: { email: { mode: 'insensitive' } } } } } as Any),
      e003(/names no operator/),
    );
    await assert.rejects(
      () => db.table('wh_comments').deleteMany({ where: { whUser: { is: { doc: { mode: 'insensitive' } } } } } as Any),
      e003(/names no operator/),
    );
    assert.equal(await db.table('wh_comments').count(), 20);
    const search: string | undefined = undefined;
    const all = await db
      .table('wh_users')
      .findMany({ where: { email: { contains: search, mode: 'insensitive' } } } as Any);
    assert.equal(all.length, 4);
    const some = await db.table<{ id: number }>('wh_users').findMany({
      where: { email: { contains: 'user3', mode: 'insensitive' } },
    } as Any);
    assert.deepEqual(ids(some), [3]);
  });

  live.it('findFirst refuses an undefined-only combinator; a JSON operand stays a filter', async () => {
    const db = client();
    for (const where of [{ AND: [undefined] }, { OR: [undefined] }, { NOT: [undefined] }]) {
      await assert.rejects(
        () => db.table('wh_users').findFirst({ where } as Any),
        e003(/every key in `where` was undefined/),
      );
    }
    // `{ a: undefined }` serializes as `{}`. Whatever the document comparison,
    // the filter must not vanish: the array and string documents never match.
    const rows = await db
      .table<{ id: number }>('wh_users')
      .findMany({ where: { doc: { equals: { a: undefined } } } } as Any);
    assert.ok(ids(rows).includes(1), JSON.stringify(rows));
    assert.ok(!ids(rows).includes(3) && !ids(rows).includes(4), JSON.stringify(rows));
  });
  live.it('a typo in a relation filter deletes nothing, and a global filter carrying one is refused', async () => {
    const db = client();
    await assert.rejects(
      () => db.table('wh_comments').deleteMany({ where: { whUser: { is: { id: 1 }, iz: { id: 2 } } } } as Any),
      e003(/unrecognized key "iz"/),
    );
    assert.equal(await db.table('wh_comments').count(), 20);
    await assert.rejects(
      async () =>
        client({ wh_comments: { whUser: { is: { id: 1 }, iz: { id: 2 } } } })
          .table('wh_comments')
          .count(),
      e003(/unrecognized key "iz"/),
    );
  });
});
