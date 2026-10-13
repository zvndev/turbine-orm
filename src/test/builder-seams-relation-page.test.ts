/**
 * turbine-orm, `take` / `skip` / `offset` inside `with`.
 *
 * A relation's `skip` used to be dropped (only `take` was folded, into
 * `limit`), so `with: { posts: { take: 2, skip: 2 } }` returned page one of
 * every parent's posts. `offset` is now applied per parent on both relation
 * strategies, and refused where it cannot mean anything (a to-one relation) or
 * cannot be expressed (an engine whose relation subquery is its own).
 *
 * Build-only for SQL shape, params, cache keys and refusals; live (PostgreSQL
 * when DATABASE_URL is set, SQLite in memory on Node >= 22.5) for rows, against
 * a reference computed by slicing each parent's full ordered list.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { TurbineClient } from '../client.js';
import { UnsupportedFeatureError, ValidationError } from '../errors.js';
import { introspect } from '../introspect.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import { resetCacheCrossCheckEnv } from '../query/builder.js';
import type { SchemaMetadata } from '../schema.js';
import { introspectSqliteDatabase, sqliteDialect, turbineSqlite } from '../sqlite.js';
import { makeQuery, mockTable, skipGate } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: the suites drive untyped accessors and args
type Any = any;

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
          tags: {
            type: 'manyToMany',
            name: 'tags',
            from: 'users',
            to: 'tags',
            foreignKey: 'id',
            referenceKey: 'id',
            through: { table: 'user_tags', sourceKey: 'user_id', targetKey: 'tag_id' },
          },
        },
      ),
      posts: mockTable(
        'posts',
        [
          { name: 'id', field: 'id' },
          { name: 'user_id', field: 'userId' },
          { name: 'title', field: 'title', pgType: 'text' },
        ],
        {
          author: {
            type: 'belongsTo',
            name: 'author',
            from: 'posts',
            to: 'users',
            foreignKey: 'user_id',
            referenceKey: 'id',
          },
        },
      ),
      profiles: mockTable('profiles', [
        { name: 'id', field: 'id' },
        { name: 'user_id', field: 'userId' },
      ]),
      tags: mockTable('tags', [
        { name: 'id', field: 'id' },
        { name: 'label', field: 'label', pgType: 'text' },
      ]),
      user_tags: mockTable(
        'user_tags',
        [
          { name: 'user_id', field: 'userId' },
          { name: 'tag_id', field: 'tagId' },
        ],
        {},
        ['user_id', 'tag_id'],
      ),
    },
  };
}

function highestPlaceholder(sql: string): number {
  return Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
}

let prevEnv: string | undefined;
function production(): void {
  prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  resetCacheCrossCheckEnv();
}
function restoreEnv(): void {
  if (prevEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = prevEnv;
  resetCacheCrossCheckEnv();
}

describe('relation offset: join plan SQL (PostgreSQL)', () => {
  beforeEach(production);
  afterEach(restoreEnv);

  it('take + skip fold into a per-parent LIMIT / OFFSET inside the wrapped row query', () => {
    const q = makeQuery('users', schema(), { warnOnUnlimited: false });
    const built = q.buildFindMany({ with: { posts: { orderBy: { id: 'asc' }, take: 2, skip: 3 } } } as Any);
    assert.match(built.sql, /ORDER BY "?t0"?\."id" ASC LIMIT \$1 OFFSET \$2\) t0i/);
    assert.deepEqual(built.params, [2, 3]);
  });

  it('skip alone emits OFFSET with no LIMIT and still wraps', () => {
    const q = makeQuery('users', schema(), { warnOnUnlimited: false });
    const built = q.buildFindMany({ with: { posts: { skip: 1 } } } as Any);
    assert.match(built.sql, /OFFSET \$1\) t0i/);
    assert.doesNotMatch(built.sql, /LIMIT/);
    assert.deepEqual(built.params, [1]);
  });

  it('a relation without offset emits the SQL it always has', () => {
    const q = makeQuery('users', schema(), { warnOnUnlimited: false });
    const built = q.buildFindMany({ with: { posts: { limit: 2 } } } as Any);
    assert.match(built.sql, / LIMIT \$1\) t0i/);
    assert.doesNotMatch(built.sql, /OFFSET/);
  });

  it('limit-only and limit+offset never share a cached statement, and warm params match cold', () => {
    const q = makeQuery('users', schema(), { warnOnUnlimited: false });
    const a = q.buildFindMany({ with: { posts: { limit: 2 } } } as Any);
    const b = q.buildFindMany({ with: { posts: { limit: 2, offset: 4 } } } as Any);
    const bWarm = q.buildFindMany({ with: { posts: { limit: 5, offset: 6 } } } as Any);
    assert.notEqual(a.sql, b.sql);
    assert.equal(bWarm.sql, b.sql);
    assert.deepEqual(bWarm.params, [5, 6]);
    for (const built of [a, b, bWarm]) assert.equal(built.params.length, highestPlaceholder(built.sql));
  });

  it('manyToMany pages per parent the same way', () => {
    const q = makeQuery('users', schema(), { warnOnUnlimited: false });
    const cold = q.buildFindMany({ with: { tags: { orderBy: { id: 'asc' }, take: 1, skip: 1 } } } as Any);
    const warm = q.buildFindMany({ with: { tags: { orderBy: { id: 'asc' }, take: 3, skip: 2 } } } as Any);
    assert.match(cold.sql, /LIMIT \$1 OFFSET \$2\) t0i/);
    assert.deepEqual(cold.params, [1, 1]);
    assert.deepEqual(warm.params, [3, 2]);
  });

  it('a nested relation inside a paged relation keeps its params in build order', () => {
    const q = makeQuery('users', schema(), { warnOnUnlimited: false });
    const args = { with: { posts: { skip: 1, take: 2, with: { author: { with: { posts: { skip: 4 } } } } } } };
    const cold = q.buildFindMany(args as Any);
    const warm = q.buildFindMany(args as Any);
    assert.deepEqual(cold.params, [2, 1, 4]);
    assert.deepEqual(warm.params, cold.params);
  });
});

describe('relation offset: other dialects', () => {
  it('SQLite writes an offset with no limit through its own pagination grammar', () => {
    const q = makeQuery('users', schema(), { dialect: sqliteDialect, warnOnUnlimited: false });
    const built = q.buildFindMany({ with: { posts: { orderBy: { id: 'asc' }, skip: 2 } } } as Any);
    assert.match(built.sql, /LIMIT -1 OFFSET :p1\) t0i/);
    assert.deepEqual(built.params, [2]);
  });

  it('MySQL inlines both values, and two offsets never share a cached statement', () => {
    const q = makeQuery('users', schema(), { dialect: mysqlDialect, warnOnUnlimited: false });
    const a = q.buildFindMany({ with: { posts: { orderBy: { id: 'asc' }, take: 2, skip: 1 } } } as Any);
    const b = q.buildFindMany({ with: { posts: { orderBy: { id: 'asc' }, take: 2, skip: 3 } } } as Any);
    assert.match(a.sql, /LIMIT 2 OFFSET 1\)/);
    assert.match(b.sql, /LIMIT 2 OFFSET 3\)/);
  });

  it('SQL Server refuses a relation offset on the join plan and names the batched alternative', () => {
    const q = makeQuery('users', schema(), { dialect: mssqlDialect, warnOnUnlimited: false });
    assert.throws(
      () => q.buildFindMany({ with: { posts: { orderBy: { id: 'asc' }, skip: 1 } } } as Any),
      (err: unknown) =>
        err instanceof UnsupportedFeatureError &&
        /relation offset/.test(err.message) &&
        /relationLoadStrategy: 'batched'/.test(err.message),
    );
  });
});

describe('relation offset: refusals', () => {
  for (const [label, spec] of [
    ['hasOne skip', { profile: { skip: 1 } }],
    ['hasOne offset', { profile: { offset: 1 } }],
    ['belongsTo skip, nested', { posts: { with: { author: { skip: 1 } } } }],
  ] as const) {
    it(`${label}: a to-one relation has nothing to skip (E003, both strategies)`, () => {
      const q = makeQuery('users', schema(), { warnOnUnlimited: false });
      for (const strategy of ['join', 'batched'] as const) {
        assert.throws(
          () => q.buildFindMany({ with: spec, relationLoadStrategy: strategy } as Any),
          (err: unknown) => err instanceof ValidationError && /to-one relation/.test(err.message),
        );
      }
    });
  }

  it('take and limit with different values in one relation is refused, not resolved by picking one', () => {
    const q = makeQuery('users', schema(), { warnOnUnlimited: false });
    assert.throws(() => q.buildFindMany({ with: { posts: { take: 2, limit: 3 } } } as Any), ValidationError);
  });

  it('a negative relation offset is refused on the join plan', () => {
    const q = makeQuery('users', schema(), { warnOnUnlimited: false });
    assert.throws(
      () => q.buildFindMany({ with: { posts: { skip: -1 } } } as Any),
      (err: unknown) => err instanceof ValidationError && /relation offset/.test(err.message),
    );
  });
});

// ---------------------------------------------------------------------------
// Live: rows, against a per-parent reference
// ---------------------------------------------------------------------------

type Page = { take?: number; skip?: number };
const PAGES: Page[] = [{ take: 1 }, { skip: 1 }, { take: 2, skip: 1 }, { take: 1, skip: 2 }, { skip: 10 }, { take: 0 }];

function slice<T>(rows: T[], page: Page): T[] {
  const start = page.skip ?? 0;
  return rows.slice(start, page.take === undefined ? undefined : start + page.take);
}

const DATABASE_URL = process.env.DATABASE_URL;
const pg = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

describe('relation offset: rows per parent (live PostgreSQL)', () => {
  let db: TurbineClient;
  pg.before(async () => {
    db = new TurbineClient(
      { connectionString: DATABASE_URL!, warnOnUnlimited: false },
      await introspect({ connectionString: DATABASE_URL! }),
    );
    await db.connect();
  });
  pg.after(async () => {
    if (db) await db.disconnect();
  });

  pg.it('join and batched both return each parent its own page', async () => {
    const users = (db as Any).users;
    const full = await users.findMany({ orderBy: { id: 'asc' }, with: { posts: { orderBy: { id: 'desc' } } } });
    assert.ok(
      full.some((u: Any) => u.posts.length >= 3),
      'the fixture must have a parent with several children',
    );
    for (const page of PAGES) {
      const expected = full.map((u: Any) => ({ id: u.id, posts: slice(u.posts, page).map((p: Any) => p.id) }));
      for (const strategy of ['join', 'batched'] as const) {
        const got = await users.findMany({
          orderBy: { id: 'asc' },
          relationLoadStrategy: strategy,
          with: { posts: { orderBy: { id: 'desc' }, ...page } },
        });
        const shape = got.map((u: Any) => ({ id: u.id, posts: u.posts.map((p: Any) => p.id) }));
        assert.deepEqual(shape, expected, `${strategy} ${JSON.stringify(page)}`);
      }
    }
  });
});

const DatabaseSync: (new (path: string) => DatabaseSyncType) | undefined = (() => {
  try {
    return createRequire(process.cwd())('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();
const lite = skipGate(!DatabaseSync, 'node:sqlite requires Node >= 22.5');

const SQLITE_DDL = `
CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE books (id INTEGER PRIMARY KEY, author_id INTEGER NOT NULL REFERENCES authors(id), title TEXT NOT NULL);
CREATE TABLE tags (id INTEGER PRIMARY KEY, label TEXT NOT NULL);
CREATE TABLE author_tags (
  author_id INTEGER NOT NULL REFERENCES authors(id),
  tag_id INTEGER NOT NULL REFERENCES tags(id),
  PRIMARY KEY (author_id, tag_id)
);
INSERT INTO authors VALUES (1, 'a'), (2, 'b'), (3, 'c');
INSERT INTO books VALUES (1, 1, 'x'), (2, 1, 'y'), (3, 2, 'z'), (4, 1, 'w'), (5, 2, 'v'), (6, 1, 'u');
INSERT INTO tags VALUES (1, 't1'), (2, 't2'), (3, 't3'), (4, 't4');
INSERT INTO author_tags VALUES (1, 1), (1, 2), (1, 3), (2, 2), (2, 4), (3, 1);
`;

describe('relation offset: rows per parent (live SQLite)', () => {
  let db: TurbineClient;
  let s: SchemaMetadata;
  lite.before(() => {
    const raw = new DatabaseSync!(':memory:');
    raw.exec(SQLITE_DDL);
    s = introspectSqliteDatabase(raw);
    db = turbineSqlite(raw, s, { warnOnUnlimited: false });
  });
  lite.after(async () => {
    if (db) await db.disconnect();
  });

  lite.it('hasMany and manyToMany, join and batched, every page shape', async () => {
    const authors = (db as Any).authors;
    const rels = Object.entries(s.tables.authors!.relations);
    const m2m = rels.find(([, r]) => r.type === 'manyToMany' && r.to === 'tags')?.[0];
    const many = rels.find(([, r]) => r.type === 'hasMany' && r.to === 'books')?.[0];
    assert.ok(m2m && many, `introspection found the relations: ${Object.keys(s.tables.authors!.relations)}`);
    for (const rel of [many, m2m]) {
      const full = await authors.findMany({ orderBy: { id: 'asc' }, with: { [rel]: { orderBy: { id: 'desc' } } } });
      for (const page of PAGES) {
        const expected = full.map((a: Any) => slice(a[rel], page).map((r: Any) => r.id));
        for (const strategy of ['join', 'batched'] as const) {
          const got = await authors.findMany({
            orderBy: { id: 'asc' },
            relationLoadStrategy: strategy,
            with: { [rel]: { orderBy: { id: 'desc' }, ...page } },
          });
          assert.deepEqual(
            got.map((a: Any) => a[rel].map((r: Any) => r.id)),
            expected,
            `${rel} ${strategy} ${JSON.stringify(page)}`,
          );
        }
      }
    }
  });
});
