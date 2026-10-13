/**
 * The where rules fixed after review wave C, build-only (no database):
 *
 *   - an `OR` with a branch that applies no condition is TRUE (it dropped the
 *     branch, so its `NOT` deleted every row but one);
 *   - on MySQL a number or boolean compared with a text column binds as text
 *     (`'abc' = 0` is true there, so `{ resetToken: 0 }` matched);
 *   - global filters that reach each other through relation filters are
 *     refused when static, and applied once per chain when functions;
 *   - SQLite and SQL Server refuse a bare JSON document and `not: <document>`
 *     (compared as text, key order decided the match);
 *   - the mass-mutation guard reads NOT NULL columns and enforced foreign keys;
 *   - `is` / `isNot` on a to-many relation, `lock` and a filtered `_count` in
 *     `with`, an Invalid Date operand and an unknown array filter key are
 *     refused; an unknown `with` option is named in the advice log;
 *   - a JSON path key is written as a JSON string literal.
 *
 * Every new shape is also checked warm-then-sibling against a client without
 * the SQL cache, so a cached template never binds what a cold build would not.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Dialect } from '../dialect.js';
import { UnsupportedFeatureError, ValidationError } from '../errors.js';
import { normalizeGlobalFilters } from '../global-filters-config.js';
import type { TurbineLogEntry, TurbineLogger } from '../logger.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import { QueryInterface } from '../query/builder.js';
import { col } from '../query/column-ref.js';
import type { QueryInterfaceOptions } from '../query/deferred.js';
import type { GlobalFilters } from '../query/index.js';
import { assertCursorNotEmptied } from '../query/normalize-args.js';
import { foldWhere, foldWhereFor, metadataWhereHost, type WhereFoldOptions } from '../query/where-compile.js';
import type { SchemaMetadata } from '../schema.js';
import { sqliteDialect } from '../sqlite.js';
import { fxWhereSchema, POSTS_TABLE, USERS_TABLE } from './fx-where-engines.js';
import { makeQuery, mockTable } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: build methods are called with untyped args here
type Any = any;

function isE003(err: unknown): boolean {
  return err instanceof ValidationError;
}

function isE017(err: unknown): boolean {
  return err instanceof UnsupportedFeatureError;
}

function q(table: string, options: QueryInterfaceOptions = {}, schema?: SchemaMetadata): Any {
  const jsonType = options.dialect && options.dialect.name !== 'postgresql' ? 'json' : 'jsonb';
  return makeQuery(table, schema ?? fxWhereSchema(jsonType, true), { warnOnUnlimited: false, ...options });
}

const users = (options: QueryInterfaceOptions = {}, schema?: SchemaMetadata): Any => q(USERS_TABLE, options, schema);
const posts = (options: QueryInterfaceOptions = {}, schema?: SchemaMetadata): Any => q(POSTS_TABLE, options, schema);

type Build = (qi: Any, args: Any) => { sql: string; params: unknown[] };
const findMany: Build = (qi, args) => qi.buildFindMany(args);

/**
 * Build `first` on a cached client, then `second` (the same shape, other
 * values) on it, and compare the second with a cold build on a client
 * without the cache. Returns the cold build.
 */
function warmThenSibling(
  make: (options: QueryInterfaceOptions) => Any,
  first: Any,
  second: Any,
  build: Build = findMany,
): { sql: string; params: unknown[] } {
  const warm = make({});
  build(warm, first);
  const hit = build(warm, second);
  const cold = build(make({ sqlCache: false }), second);
  assert.equal(hit.sql, cold.sql, 'SQL of the cached sibling');
  assert.deepEqual(hit.params, cold.params, 'params of the cached sibling');
  return cold;
}

/** Every scalar a statement binds, with an `in` list (any engine's form) spread out. */
function boundScalars(params: readonly unknown[]): unknown[] {
  return params.flatMap((p) => {
    if (Array.isArray(p)) return p;
    if (typeof p === 'string' && p.startsWith('[')) {
      try {
        return JSON.parse(p) as unknown[];
      } catch {
        return [p];
      }
    }
    if (p !== null && typeof p === 'object' && Array.isArray((p as { values?: unknown }).values)) {
      return (p as { values: unknown[] }).values;
    }
    return [p];
  });
}

describe('OR with a branch that applies no condition', () => {
  it('is TRUE, written as a constant, and the other branches bind nothing', () => {
    const built = users().buildFindMany({ where: { OR: [{ id: 1 }, {}] } });
    assert.match(built.sql, /WHERE \(1 = 1\)$/);
    assert.deepEqual(built.params, []);
  });

  it('its NOT matches no row, and the condition beside it still applies', () => {
    const negated = users().buildFindMany({ where: { NOT: { OR: [{ id: 1 }, {}] } } });
    assert.match(negated.sql, /WHERE NOT \(\(1 = 1\)\)$/);
    assert.deepEqual(negated.params, []);
    const beside = users().buildFindMany({ where: { OR: [{ id: 1 }, { AND: [] }], name: 'x' } });
    assert.match(beside.sql, /\(1 = 1\)/);
    assert.deepEqual(beside.params, ['x']);
  });

  it('holds inside a relation filter too', () => {
    const built = users().buildFindMany({ where: { posts: { some: { OR: [{ title: 'a' }, {}] } } } });
    assert.match(built.sql, /EXISTS \(SELECT 1 FROM .* AND \(1 = 1\)\)/);
    assert.deepEqual(built.params, []);
  });

  it('the mass-mutation guard refuses it, and allows its NOT (which writes nothing)', () => {
    assert.throws(() => users().buildDeleteMany({ where: { OR: [{ id: 1 }, {}] } }), isE003);
    assert.throws(() => users().buildUpdateMany({ where: { OR: [{}, { id: 1 }] }, data: { name: 'z' } }), isE003);
    const none = users().buildDeleteMany({ where: { NOT: { OR: [{ id: 1 }, {}] } } });
    assert.match(none.sql, /WHERE NOT \(\(1 = 1\)\)/);
  });

  it('folds to TRUE, and its NOT to FALSE', () => {
    const host = metadataWhereHost(fxWhereSchema().tables[USERS_TABLE]!);
    const fold = (where: Record<string, unknown>) => foldWhere(host, where, () => host);
    assert.equal(fold({ OR: [{ id: 1 }, {}] }), 'true');
    assert.equal(fold({ OR: [{ id: 1 }, { AND: [] }] }), 'true');
    assert.equal(fold({ NOT: { OR: [{ id: 1 }, {}] } }), 'false');
    assert.equal(fold({ OR: [{ id: 1 }, { id: 2 }] }), 'row');
  });

  it('a cached template serves the sibling shape exactly as a cold build', () => {
    warmThenSibling(
      users,
      { where: { OR: [{ id: 1 }, {}], name: 'a' } },
      { where: { OR: [{ id: 2 }, {}], name: 'b' } },
    );
    warmThenSibling(
      users,
      { where: { NOT: { OR: [{ id: 1 }, {}] }, score: 1 } },
      { where: { NOT: { OR: [{ id: 9 }, {}] }, score: 2 } },
    );
    const cold = warmThenSibling(
      users,
      { where: { posts: { some: { OR: [{ title: 'a' }, {}], id: 1 } } } },
      { where: { posts: { some: { OR: [{ title: 'b' }, {}], id: 2 } } } },
    );
    assert.deepEqual(cold.params, [2]);
  });
});

describe('MySQL binds a number or boolean compared with a text column as text', () => {
  const my = (options: QueryInterfaceOptions = {}) => users({ dialect: mysqlDialect, ...options });

  it('bare equality, operators and lists', () => {
    assert.deepEqual(my().buildFindMany({ where: { resetToken: 0 } }).params, ['0']);
    assert.deepEqual(my().buildFindMany({ where: { resetToken: false } }).params, ['0']);
    assert.deepEqual(my().buildFindMany({ where: { resetToken: true } }).params, ['1']);
    assert.deepEqual(my().buildFindMany({ where: { email: 12n } }).params, ['12']);
    const ops = my().buildFindMany({ where: { resetToken: { gt: 5, lte: 7, not: 0, equals: 1 } } }).params;
    assert.deepEqual([...ops].sort(), ['0', '1', '5', '7']);
    assert.deepEqual(boundScalars(my().buildFindMany({ where: { resetToken: { in: [0, 1n, true] } } }).params), [
      '0',
      '1',
      '1',
    ]);
    assert.deepEqual(boundScalars(my().buildFindMany({ where: { resetToken: { notIn: [0, false] } } }).params), [
      '0',
      '0',
    ]);
  });

  it('a number column, and every other engine, keep the value as given', () => {
    assert.deepEqual(my().buildFindMany({ where: { score: 5 } }).params, [5]);
    assert.deepEqual(users().buildFindMany({ where: { resetToken: 0 } }).params, [0]);
    assert.deepEqual(users({ dialect: sqliteDialect }).buildFindMany({ where: { resetToken: 0 } }).params, [0]);
  });

  it('unique lookups, cursors, relation filters, global filters and group keys', () => {
    assert.deepEqual(my().buildFindUnique({ where: { email: 0 } }).params, ['0']);
    const page = my().buildFindMany({ where: { tenant: 1 }, cursor: { email: 0 }, orderBy: { email: 'asc' } });
    assert.ok(boundScalars(page.params).includes('0'), JSON.stringify(page.params));
    assert.ok(!boundScalars(page.params).includes(0), JSON.stringify(page.params));
    const rel = posts({ dialect: mysqlDialect }).buildFindMany({ where: { author: { is: { resetToken: 0 } } } });
    assert.deepEqual(rel.params, ['0']);
    const gf = my({ globalFilters: { [USERS_TABLE]: { resetToken: 0 } } }).buildFindMany({ where: { id: 1 } });
    assert.deepEqual(boundScalars(gf.params).sort(), [1, '0'].sort());
    const grouped = my().buildGroupBy({ by: ['resetToken'], having: { resetToken: 0 }, _count: true });
    assert.deepEqual(grouped.params, ['0']);
  });

  it('a cached template binds the sibling value as text too', () => {
    const cold = warmThenSibling(my, { where: { resetToken: 1 } }, { where: { resetToken: 2 } });
    assert.deepEqual(cold.params, ['2']);
    const list = warmThenSibling(
      my,
      { where: { resetToken: { in: [1, 2] } } },
      { where: { resetToken: { in: [3, 4] } } },
    );
    assert.deepEqual(boundScalars(list.params), ['3', '4']);
  });
});

/** A schema whose comments have a parent comment, for self-relation cycles. */
function commentsSchema(): SchemaMetadata {
  const comments = mockTable(
    'fxwh_comments',
    [
      { name: 'id', field: 'id', pgType: 'int4' },
      { name: 'parent_id', field: 'parentId', pgType: 'int4' },
      { name: 'hidden', field: 'hidden', pgType: 'bool' },
    ],
    {
      parent: {
        type: 'belongsTo',
        name: 'parent',
        from: 'fxwh_comments',
        to: 'fxwh_comments',
        foreignKey: 'parent_id',
        referenceKey: 'id',
      },
    },
  );
  const base = fxWhereSchema();
  return { ...base, tables: { ...base.tables, fxwh_comments: comments } };
}

describe('global filters that reach each other', () => {
  it('two static filters that reach each other are refused at construction, naming the chain', () => {
    assert.throws(
      () =>
        normalizeGlobalFilters(
          {
            fxwhUsers: { posts: { some: { title: 'x' } } },
            fxwh_posts: { author: { is: { tenant: 1 } } },
          },
          fxWhereSchema(),
        ),
      (err: unknown) => {
        assert.ok(isE003(err), String(err));
        const message = (err as Error).message;
        assert.match(message, /the filter for "fxwhUsers" reaches "fxwh_posts" through "fxwh_users\.posts"/);
        assert.match(message, /the filter for "fxwh_posts" reaches "fxwh_users" through "fxwh_posts\.author"/);
        assert.equal(message.match(/\[TURBINE_E003\]/g)?.length, 1);
        return true;
      },
    );
  });

  it('a static filter that reaches its own table is refused, at any depth', () => {
    for (const filter of [
      { parent: { is: { hidden: false } } },
      { OR: [{ hidden: false }, { parent: { is: { hidden: false } } }] },
      { NOT: { parent: { isNot: null } } },
    ]) {
      assert.throws(
        () => normalizeGlobalFilters({ fxwh_comments: filter }, commentsSchema()),
        /the filter for "fxwh_comments" reaches "fxwh_comments" through "fxwh_comments\.parent"/,
        JSON.stringify(filter),
      );
    }
  });

  it('filters that reach another table without coming back are accepted', () => {
    const filters = normalizeGlobalFilters(
      { fxwh_posts: { author: { is: { tenant: 1 } } }, fxwh_users: { tenant: 1 } },
      fxWhereSchema(),
    );
    assert.ok(filters);
  });

  it('function filters that reach each other apply once per chain, and the build terminates', () => {
    const globalFilters = {
      [USERS_TABLE]: () => ({ posts: { some: { title: 'u' } } }),
      [POSTS_TABLE]: () => ({ author: { is: { tenant: 7 } } }),
    };
    // The queried table's own filter, then each table's filter once along the
    // chain of relation filters: users ('u') reaches posts (7), whose author
    // is a users row ('u'), whose posts would apply 7 again, where it stops.
    const built = users({ globalFilters }).buildFindMany({ where: { id: 1 } });
    assert.deepEqual(
      boundScalars(built.params).filter((p) => p === 'u' || p === 7),
      ['u', 7, 'u'],
    );
    const viaPosts = posts({ globalFilters }).buildFindMany({ where: { id: 1 } });
    assert.deepEqual(
      boundScalars(viaPosts.params).filter((p) => p === 'u' || p === 7),
      [7, 'u', 7],
    );
    warmThenSibling((o) => users({ globalFilters, ...o }), { where: { id: 1 } }, { where: { id: 2 } });
    warmThenSibling(
      (o) => posts({ globalFilters, ...o }),
      { where: { author: { is: { name: 'a' } } } },
      { where: { author: { is: { name: 'b' } } } },
    );
  });

  it('a function filter on a self relation applies once per chain', () => {
    const globalFilters = { fxwh_comments: () => ({ parent: { is: { hidden: false } } }) };
    const built = q('fxwh_comments', { globalFilters }, commentsSchema()).buildFindMany({ where: { id: 1 } });
    // The row's own filter, and its parent's, and no further.
    assert.deepEqual(boundScalars(built.params), [1, false, false]);
  });
});

describe('SQLite and SQL Server refuse a whole JSON document (E017)', () => {
  for (const [name, dialect] of [
    ['sqlite', sqliteDialect],
    ['mssql', mssqlDialect],
  ] as const) {
    it(`${name}: a bare document and not: <document>, at every position`, () => {
      for (const where of [
        { data: { a: 1 } },
        { data: [1, 2] },
        { data: { not: { a: 1 } } },
        { data: { not: [1] } },
        { NOT: { data: { b: 2, a: 1 } } },
      ]) {
        assert.throws(() => users({ dialect }).buildFindMany({ where }), isE017, JSON.stringify(where));
      }
      assert.throws(() => posts({ dialect }).buildFindMany({ where: { author: { is: { data: { a: 1 } } } } }), isE017);
      assert.throws(
        () => users({ dialect, globalFilters: { [USERS_TABLE]: () => ({ data: { a: 1 } }) } }).buildFindMany({}),
        isE017,
      );
    });

    it(`${name}: a scalar keeps its comparison`, () => {
      const built = users({ dialect }).buildFindMany({ where: { data: { not: 5 } } });
      assert.deepEqual(built.params, [5]);
    });
  }

  it('MySQL compares the document as JSON', () => {
    const built = users({ dialect: mysqlDialect }).buildFindMany({ where: { data: { b: 2, a: 1 } } });
    assert.match(built.sql, /JSON/);
  });
});

describe('static global filters are compiled when the client is built', () => {
  const compile = (dialect?: Dialect) => ({ QueryInterface, dialect });
  const refused: [string, GlobalFilters][] = [
    ['an operand of the wrong shape', { fxwh_posts: { userId: { in: 5 } } }],
    ['a plain { col } object', { fxwh_posts: { userId: { equals: { col: 'editorId' } } } }],
    ['an operator object naming no operator', { fxwh_posts: { title: { mode: 'insensitive' } } }],
    ['an operator-only JSON not', { fxwh_users: { data: { not: { contains: { a: 1 } } } } }],
    ['an Invalid Date', { fxwh_users: { createdAt: { gt: new Date('nope') } } }],
    ['a bad value inside a relation filter', { fxwh_posts: { author: { is: { tenant: { in: 'x' } } } } }],
    ['a to-one key on a to-many relation', { fxwh_users: { posts: { is: { title: 'x' } } } }],
  ];
  for (const [label, filters] of refused) {
    it(`refuses ${label} (E003), naming the filter, with one code tag`, () => {
      assert.throws(
        () => normalizeGlobalFilters(filters, fxWhereSchema(), compile()),
        (err: unknown) => {
          assert.ok(isE003(err), String(err));
          const message = (err as Error).message;
          assert.match(message, new RegExp(`globalFilters\\["${Object.keys(filters)[0]}"\\]`));
          assert.equal(message.match(/\[TURBINE_E003\]/g)?.length, 1, message);
          assert.equal(message.match(/turbineorm\.dev\/errors/g)?.length, 1, message);
          return true;
        },
      );
    });
  }

  it('names the key as written (an accessor), and a misspelled column inside a relation filter', () => {
    assert.throws(
      () => normalizeGlobalFilters({ fxwhPosts: { author: { is: { tenat: 1 } } } }, fxWhereSchema()),
      /globalFilters\["fxwhPosts"\]: "author\.is\.tenat" is not a column or relation of "fxwh_users"\. Did you mean "tenant"\?/,
    );
    assert.throws(
      () => normalizeGlobalFilters({ fxwhPosts: { author: { tenat: 1 } } }, fxWhereSchema()),
      /"author\.tenat" is not a column or relation/,
    );
  });

  it('refuses an undefined value, naming its path and the fix', () => {
    assert.throws(
      () => normalizeGlobalFilters({ fxwh_posts: { OR: [{ userId: undefined }, { id: 1 }] } }, fxWhereSchema()),
      (err: unknown) => {
        assert.ok(isE003(err));
        assert.match(
          (err as Error).message,
          /globalFilters\["fxwh_posts"\] has an undefined value at "OR\[0\]\.userId"/,
        );
        assert.match((err as Error).message, /Pass a function, which is evaluated per query/);
        return true;
      },
    );
  });

  it('an engine gap keeps its class (E017) and names the filter', () => {
    assert.throws(
      () => normalizeGlobalFilters({ fxwh_users: { data: { a: 1 } } }, fxWhereSchema('json'), compile(sqliteDialect)),
      (err: unknown) => {
        assert.ok(isE017(err), String(err));
        assert.match((err as Error).message, /globalFilters\["fxwh_users"\]/);
        assert.equal((err as Error).message.match(/\[TURBINE_E017\]/g)?.length, 1);
        return true;
      },
    );
    // The same filter compiles on an engine that compares documents.
    assert.ok(normalizeGlobalFilters({ fxwh_users: { data: { a: 1 } } }, fxWhereSchema('json'), compile(mysqlDialect)));
  });

  it('never calls a function filter, and compiles the static filters a relation filter reaches', () => {
    const filters = normalizeGlobalFilters(
      {
        fxwh_posts: { author: { is: { tenant: 1 } } },
        fxwh_users: () => {
          throw new Error('a function filter was called at construction');
        },
      },
      fxWhereSchema(),
      compile(),
    );
    assert.ok(filters);
    assert.throws(
      () =>
        normalizeGlobalFilters(
          { fxwh_posts: { author: { is: { tenant: 1 } } }, fxwh_users: { tenant: { in: 3 } } },
          fxWhereSchema(),
          compile(),
        ),
      /globalFilters\["fxwh_users"\]: Invalid operand for 'in'/,
    );
  });

  it('accepts valid static filters on every SQL engine', () => {
    const filters = {
      fxwh_posts: { author: { is: { tenant: 1 } }, title: { not: '' } },
      fxwh_users: { tenant: { in: [1, 2] }, createdAt: { gt: new Date(0) } },
    };
    for (const dialect of [undefined, mysqlDialect, sqliteDialect, mssqlDialect]) {
      assert.ok(normalizeGlobalFilters(filters, fxWhereSchema('json'), compile(dialect)), dialect?.name);
    }
  });
});

describe('the mass-mutation guard reads NOT NULL columns', () => {
  const alwaysTrue: [string, string, Record<string, unknown>][] = [
    [USERS_TABLE, "contains ''", { email: { contains: '' } }],
    [USERS_TABLE, "startsWith '' (insensitive)", { name: { startsWith: '', mode: 'insensitive' } }],
    [USERS_TABLE, "endsWith ''", { name: { endsWith: '' } }],
    [USERS_TABLE, 'not: null', { id: { not: null } }],
    [USERS_TABLE, 'NOT of equality with null', { NOT: { email: null } }],
    [USERS_TABLE, 'NOT of equals: null', { NOT: { id: { equals: null } } }],
    [USERS_TABLE, 'equals the column itself', { id: { equals: col('id') } }],
    [USERS_TABLE, 'gte the column itself', { tenant: { gte: col('tenant') } }],
    [USERS_TABLE, 'NOT of gt the column itself', { NOT: { tenant: { gt: col('tenant') } } }],
    [USERS_TABLE, 'hasEvery: []', { tags: { hasEvery: [] } }],
    [USERS_TABLE, "an OR with a contains ''", { OR: [{ email: { contains: '' } }, { id: 1 }] }],
    [POSTS_TABLE, 'a bare {} on a NOT NULL foreign key', { author: {} }],
    [POSTS_TABLE, 'is: {}', { author: { is: {} } }],
    [POSTS_TABLE, 'isNot: null', { author: { isNot: null } }],
    [POSTS_TABLE, 'NOT of is: null', { NOT: { author: { is: null } } }],
    [POSTS_TABLE, "is with a contains ''", { author: { is: { email: { contains: '' } } } }],
  ];
  for (const [table, label, where] of alwaysTrue) {
    it(`refuses ${label}`, () => {
      assert.throws(() => q(table).buildDeleteMany({ where }), isE003, JSON.stringify(where));
      assert.throws(() => q(table).buildUpdateMany({ where, data: { id: 1 } }), isE003, JSON.stringify(where));
    });
  }

  const narrowing: [string, string, Record<string, unknown>][] = [
    [USERS_TABLE, "contains '' on a nullable column", { resetToken: { contains: '' } }],
    [USERS_TABLE, 'not: null on a nullable column', { score: { not: null } }],
    [USERS_TABLE, 'hasEvery: [] on a nullable column', { labels: { hasEvery: [] } }],
    [USERS_TABLE, "contains 'a'", { email: { contains: 'a' } }],
    [USERS_TABLE, 'gt the column itself (matches nothing)', { tenant: { gt: col('tenant') } }],
    [USERS_TABLE, 'equals another column', { id: { equals: col('tenant') } }],
    [POSTS_TABLE, 'a bare {} on a nullable foreign key', { editor: {} }],
    [POSTS_TABLE, 'is with a condition', { author: { is: { name: 'a' } } }],
  ];
  for (const [table, label, where] of narrowing) {
    it(`allows ${label}`, () => {
      assert.match(q(table).buildDeleteMany({ where }).sql, /WHERE/);
    });
  }

  it('a target with a global filter, and SQLite, do not trust the foreign key', () => {
    const filtered = posts({ globalFilters: { [USERS_TABLE]: { tenant: 1 } } });
    assert.match(filtered.buildDeleteMany({ where: { author: {} } }).sql, /EXISTS/);
    assert.match(posts({ dialect: sqliteDialect }).buildDeleteMany({ where: { author: {} } }).sql, /EXISTS/);
    assert.throws(
      () => posts({ dialect: sqliteDialect }).buildDeleteMany({ where: { title: { contains: '' } } }),
      isE003,
    );
  });

  it('findUnique, update and delete refuse an always-true where', () => {
    assert.throws(() => users().buildFindUnique({ where: { id: { not: null } } }), /has no predicate/);
    assert.throws(() => users().buildDelete({ where: { email: { contains: '' } } }), isE003);
  });

  it('a column whose nullability is unknown is not folded, and the plain fold is unchanged', () => {
    const schema = fxWhereSchema();
    for (const c of schema.tables[USERS_TABLE]!.columns) {
      if (c.name === 'email') (c as { nullable?: boolean }).nullable = undefined;
    }
    assert.match(users({}, schema).buildDeleteMany({ where: { email: { contains: '' } } }).sql, /LIKE/);
    assert.equal(foldWhereFor(fxWhereSchema().tables, USERS_TABLE, { id: { not: null } }), 'row');
    const host = metadataWhereHost(fxWhereSchema().tables[USERS_TABLE]!);
    const options: WhereFoldOptions = { notNull: { foreignKeys: true, hasGlobalFilter: () => false } };
    assert.equal(
      foldWhere(host, { id: { not: null } }, () => host, 0, options),
      'true',
    );
    assert.equal(
      foldWhere(host, { id: null }, () => host, 0, options),
      'false',
    );
    assert.equal(
      foldWhere(host, { id: { lt: col('id') } }, () => host, 0, options),
      'false',
    );
  });
});

describe('a relation filter takes the keys of its cardinality', () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ posts: { is: { title: 'x' } } }, /`is` applies to a to-one relation .* write `some`/],
    [{ posts: { isNot: { title: 'x' } } }, /`isNot` applies to a to-one relation .* write `none`/],
    [{ posts: { is: null } }, /write `none: \{\}` for rows with no related row/],
    [{ posts: { isNot: null } }, /write `some: \{\}` for rows with at least one/],
  ];
  for (const [where, message] of cases) {
    it(`refuses ${JSON.stringify(where)} on a to-many relation`, () => {
      assert.throws(() => users().buildFindMany({ where }), message);
      assert.throws(() => users().buildDeleteMany({ where }), message);
      assert.throws(() => posts().buildFindMany({ where: { author: { is: where } } }), message);
      assert.throws(() => posts().buildFindMany({ with: { author: { where } } }), message);
    });
  }

  it('the quantifiers on a to-one relation keep their one reading', () => {
    for (const where of [
      { author: { some: { name: 'a' } } },
      { author: { none: {} } },
      { author: { every: { tenant: 1 } } },
    ]) {
      assert.match(posts().buildFindMany({ where }).sql, /EXISTS/);
    }
  });
});

describe('a JSON path key is written as a JSON string literal', () => {
  const keys = ['a\\b', 'q"k', 'a\\', 'n\nl', 'plain'];
  for (const [name, dialect] of [
    ['mysql', mysqlDialect],
    ['sqlite', sqliteDialect],
    ['mssql', mssqlDialect],
  ] as const) {
    it(`${name}: every key escaped, digit segments as indexes`, () => {
      for (const key of keys) {
        const built = users({ dialect }).buildFindMany({ where: { data: { path: [key, 0], equals: 1 } } });
        assert.ok(
          built.params.includes(`$.${JSON.stringify(key)}[0]`),
          `${JSON.stringify(key)}: ${JSON.stringify(built.params)}`,
        );
      }
    });
  }

  it('PostgreSQL keeps its native path array', () => {
    const built = users().buildFindMany({ where: { data: { path: ['a\\b'], equals: 1 } } });
    assert.ok(built.params.some((p: unknown) => Array.isArray(p) && p[0] === 'a\\b'));
  });
});

describe('relation options in `with`', () => {
  it('refuses `lock`, at any depth and under every strategy', () => {
    for (const relationLoadStrategy of ['join', 'batched', 'auto'] as const) {
      assert.throws(
        () => users().buildFindMany({ with: { posts: { lock: 'update' } }, relationLoadStrategy }),
        /`lock` is not an option of a relation in `with` \(`posts` on "fxwh_users"\)/,
      );
    }
    assert.throws(
      () => posts().buildFindMany({ with: { author: { with: { posts: { lock: { mode: 'share' } } } } } }),
      /`lock` is not an option of a relation in `with`/,
    );
    assert.throws(() => users().buildFindUnique({ where: { id: 1 }, with: { posts: { lock: 'update' } } }), isE003);
  });

  it('refuses a `_count` that is not true for a relation', () => {
    assert.throws(
      () => users().buildFindMany({ with: { _count: { posts: { where: { title: 'x' } } } } }),
      /`_count\.posts` in `with` on "fxwh_users" takes true; received an object with keys "where"/,
    );
    assert.throws(
      () => users().buildFindMany({ with: { _count: 'yes' } }),
      /`_count` in `with` on "fxwh_users" takes true/,
    );
    assert.match(users().buildFindMany({ with: { _count: { posts: true } } }).sql, /COUNT/i);
    users().buildFindMany({ with: { _count: { posts: false } } });
  });

  it('names an unknown option once in the advice log, and nothing without advice', () => {
    const lines: [string, TurbineLogEntry][] = [];
    const logger: TurbineLogger = { warn: (message, entry) => lines.push([message, entry]) };
    const advised = users({ logger, diagnostics: { advice: true } });
    advised.buildFindMany({ with: { posts: { wehre: { id: 1 } } } });
    advised.buildFindMany({ with: { posts: { wehre: { id: 2 } } } });
    assert.equal(lines.length, 1);
    assert.match(
      lines[0]![0],
      /unknown option "wehre" on relation "posts" in `with` on fxwh_users, it is ignored\. Did you mean "where"\?/,
    );
    assert.equal(lines[0]![1].code, 'unknown-query-option');
    users({ logger, diagnostics: { advice: false } }).buildFindMany({ with: { posts: { distinct: ['id'] } } });
    assert.equal(lines.length, 1);
  });
});

describe('an Invalid Date has no SQL value and is refused (E003)', () => {
  const bad = new Date('not a date');
  const wheres: Record<string, unknown>[] = [
    { createdAt: bad },
    { createdAt: { gt: bad } },
    { createdAt: { not: bad } },
    { createdAt: { in: [new Date(0), bad] } },
    { createdAt: { notIn: [bad] } },
    { NOT: { createdAt: { lte: bad } } },
  ];
  for (const dialect of [undefined, mysqlDialect, sqliteDialect]) {
    it(`${dialect?.name ?? 'postgresql'}: at every operator`, () => {
      for (const where of wheres) {
        assert.throws(() => users({ dialect }).buildFindMany({ where }), /an Invalid Date/, JSON.stringify(where));
      }
    });
  }

  it('in a relation filter, a cursor and a unique lookup', () => {
    assert.throws(() => posts().buildFindMany({ where: { author: { is: { createdAt: bad } } } }), /an Invalid Date/);
    assert.throws(
      () => users().buildFindMany({ cursor: { id: 1, createdAt: bad }, orderBy: { createdAt: 'asc' } }),
      /Invalid Date/,
    );
    assert.throws(() => users().buildFindUnique({ where: { id: 1, createdAt: bad } }), /Invalid Date/);
  });
});

describe('array filters take the array filter keys', () => {
  it('refuses an unknown key beside a known one, and a non-boolean isEmpty', () => {
    assert.throws(
      () => users().buildFindMany({ where: { tags: { has: 'a', hsaSome: ['b'] } } }),
      /Unknown array filter operator "hsaSome" on "tags"/,
    );
    assert.throws(
      () => users().buildFindMany({ where: { tags: { isEmpty: 'yes' } } }),
      /`isEmpty` on "tags" takes true or false/,
    );
    assert.deepEqual(users().buildFindMany({ where: { tags: { has: 'a', isEmpty: false } } }).params, ['a']);
  });

  it('refuses them on the cache-hit collect too, with the cache self-check off', () => {
    // `isEmpty: 'yes'` fingerprints like `isEmpty: true`, so the warmed template
    // would be served: only the collect's own check can refuse it here.
    const qi = users({ diagnostics: 'production' });
    qi.buildFindMany({ where: { tags: { isEmpty: true } } });
    assert.throws(
      () => qi.buildFindMany({ where: { tags: { isEmpty: 'yes' } } }),
      /`isEmpty` on .* takes true or false/,
    );
  });
});

describe('a cursor emptied by undefined', () => {
  it('names the operation when given one, and no wrong one otherwise', () => {
    const original = { cursor: { id: undefined } };
    const pruned = {};
    assert.throws(() => assertCursorNotEmptied('t', original, pruned, 'count'), /^.*count on "t" refused/);
    assert.throws(
      () => assertCursorNotEmptied('t', original, pruned),
      (err: unknown) => {
        assert.match((err as Error).message, /Query on "t" refused: every field of `cursor` was undefined/);
        assert.doesNotMatch((err as Error).message, /findMany/);
        return true;
      },
    );
    assert.throws(
      () => users().buildCount({ cursor: { id: undefined } }),
      (err: unknown) => {
        assert.doesNotMatch((err as Error).message, /findMany on/);
        return true;
      },
    );
  });
});
