/**
 * turbine-orm/prisma-compat: three `where` / `orderBy` shapes Prisma callers
 * write that the adapter answered differently from Prisma.
 *
 * 1. A BARE INCLUSIVE CURSOR beside a MULTI-ELEMENT `orderBy` array. A Prisma
 *    cursor is inclusive and names one row; the page starts AT that row in the
 *    query's order. `orderByPairs` once read only an array of length one, took
 *    the no-orderBy branch for a longer one and wrote `orderBy = { id: 'asc' }`
 *    OVER the caller's array. The adapter now hands core an inclusive cursor,
 *    and core reads the cursor row's ordered values, so every array shape keeps
 *    its ordering and starts at the right row.
 *
 * 2. An EMPTY `OR`. Prisma treats `OR: []` as false (no rows) and empty
 *    `AND` / `NOT` as true; core drops an empty combinator, so the adapter
 *    compiles the empty `OR` to a predicate that matches nothing.
 *
 * 3. A BARE `null` on a to-one relation key. Prisma's `{ author: null }` means
 *    "no related row"; core spells that `{ author: { is: null } }` and answers
 *    a bare null with E003.
 *
 * DB-less: the sqlDb harness backs each model with a real QueryInterface, so
 * these assert on emitted SQL and on the typed refusal.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TurbineClient } from '../client.js';
import { TurbineError } from '../errors.js';
import { type CompatTurbineClient, createPrismaCompatClient } from '../prisma-compat.js';
import type { PrismaCompatMap, SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: test harness plumbing
type Any = any;

type Models = {
  Post: { Row: { id: number; title: string; viewCount: number; authorId: number | null } };
  User: { Row: { id: number; name: string } };
};

function fixture(): { schema: SchemaMetadata; map: PrismaCompatMap } {
  const users = mockTable('users', [
    { name: 'id', field: 'id' },
    { name: 'name', field: 'name', pgType: 'text' },
  ]);
  users.primaryKey = ['id'];
  users.uniqueColumns = [['id']];

  const posts = mockTable('posts', [
    { name: 'id', field: 'id' },
    { name: 'title', field: 'title', pgType: 'text' },
    { name: 'view_count', field: 'viewCount', pgType: 'int4' },
    { name: 'author_id', field: 'authorId' },
  ]);
  posts.primaryKey = ['id'];
  posts.uniqueColumns = [['id']];
  posts.relations = {
    // The Prisma name (`author`) and the Turbine name (`user`) DIVERGE, which is
    // the case a bare-null mapping has to survive: the adapter renames the key
    // before core ever sees it.
    user: { type: 'belongsTo', name: 'user', from: 'posts', to: 'users', foreignKey: 'author_id', referenceKey: 'id' },
    comments: {
      type: 'hasMany',
      name: 'comments',
      from: 'posts',
      to: 'users',
      foreignKey: 'author_id',
      referenceKey: 'id',
    },
  };

  const schema: SchemaMetadata = { enums: {}, tables: { users, posts } };
  const map: PrismaCompatMap = {
    enums: {},
    models: {
      User: {
        table: 'users',
        accessor: 'users',
        fields: { id: 'id', name: 'name' },
        relations: {},
        compoundUniques: {},
      },
      Post: {
        table: 'posts',
        accessor: 'posts',
        fields: { id: 'id', title: 'title', viewCount: 'viewCount', authorId: 'authorId' },
        relations: {
          author: { name: 'user', cardinality: 'one' },
          comments: { name: 'comments', cardinality: 'many' },
        },
        compoundUniques: {},
      },
    },
  };
  return { schema, map };
}

/** A client whose model ops build real SQL via `makeQuery` (null pool). */
function sqlDb(schema: SchemaMetadata): CompatTurbineClient {
  return {
    schema,
    table: (name: string) => makeQuery(name, schema) as Any,
    $transaction: (() => {
      throw new Error('sqlDb has no execution path');
    }) as Any,
  } as unknown as CompatTurbineClient;
}

function compatClient() {
  const { schema, map } = fixture();
  return createPrismaCompatClient<Models>(sqlDb(schema) as unknown as TurbineClient, map);
}

/** Build the SQL a lazy delegate call would run, without executing it. */
function sqlOf(promise: unknown): { sql: string; params: unknown[] } {
  const deferred = (promise as Any)[Object.getOwnPropertySymbols(promise as object)[0] as symbol];
  return deferred.build();
}

// ---------------------------------------------------------------------------
// 1. Bare inclusive cursor + a multi-element orderBy array
// ---------------------------------------------------------------------------

describe('prisma-compat: a bare cursor beside an array orderBy', () => {
  it('a two-element array keeps its ordering and starts AT the cursor row', () => {
    const compat = compatClient();
    const { sql, params } = sqlOf(
      compat.Post.findMany({
        orderBy: [{ viewCount: 'asc' }, { id: 'asc' }],
        cursor: { id: 239 },
        take: 3,
      } as Any),
    );
    assert.match(sql, /ORDER BY "view_count" ASC, "id" ASC LIMIT/, 'the caller ordering survives verbatim');
    // The cursor names a row, so the seek reads that row's ordered values.
    assert.match(sql, /"posts"\."view_count" > \(SELECT cursor_row\."view_count" FROM "posts" cursor_row WHERE/);
    assert.match(sql, /"posts"\."id" >= \(SELECT cursor_row\."id"/, 'inclusive: the cursor row itself is on the page');
    assert.deepEqual(params, [239, 3]);
  });

  it('a single-element array whose field is not the cursor field reads the cursor row the same way', () => {
    const compat = compatClient();
    const { sql } = sqlOf(compat.Post.findMany({ orderBy: [{ viewCount: 'asc' }], cursor: { id: 5 } } as Any));
    assert.match(sql, /ORDER BY "view_count" ASC, "id" ASC/, 'the primary key breaks view_count ties');
    assert.match(sql, /EXISTS \(SELECT 1 FROM "posts" cursor_row WHERE cursor_row\."id" = \$1\)/);
  });

  it('a single-element array naming the cursor field is still the inclusive keyset', () => {
    const compat = compatClient();
    const { sql, params } = sqlOf(
      compat.Post.findMany({ orderBy: [{ id: 'asc' }], cursor: { id: 239 }, take: 3 } as Any),
    );
    assert.match(sql, /"id" >= \$1/, 'inclusive: gte, not a plain equality');
    assert.match(sql, /ORDER BY "id" ASC/);
    assert.deepEqual(params, [239, 3]);
  });

  it('the same array with skip: 1 keeps the caller ordering and skips the cursor row', () => {
    const compat = compatClient();
    const { sql, params } = sqlOf(
      compat.Post.findMany({
        orderBy: [{ viewCount: 'asc' }, { id: 'asc' }],
        cursor: { id: 239 },
        skip: 1,
        take: 3,
      } as Any),
    );
    // The caller's two-key ordering survives verbatim, which is the property
    // the overwrite destroyed.
    assert.match(sql, /ORDER BY "view_count" ASC, "id" ASC LIMIT \$2 OFFSET \$3/);
    assert.match(sql, /"posts"\."id" >= \(SELECT/, 'the page starts at the cursor row');
    assert.deepEqual(params, [239, 3, 1], 'skip: 1 is an offset of one: the cursor row');
  });

  it('a descending array orderBy with skip: 1 keeps its direction', () => {
    const compat = compatClient();
    const { sql } = sqlOf(
      compat.Post.findMany({
        orderBy: [{ viewCount: 'desc' }, { id: 'desc' }],
        cursor: { id: 239 },
        skip: 1,
        take: 2,
      } as Any),
    );
    assert.match(sql, /ORDER BY "view_count" DESC, "id" DESC/);
    assert.match(sql, /"posts"\."view_count" < \(SELECT/);
  });
});

// ---------------------------------------------------------------------------
// 2. Empty combinators
// ---------------------------------------------------------------------------

describe('prisma-compat: empty AND / OR / NOT follow Prisma semantics', () => {
  it('OR: [] compiles to a predicate that matches nothing', () => {
    const compat = compatClient();
    const { sql, params } = sqlOf(compat.Post.findMany({ where: { OR: [] } } as Any));
    // An empty `IN` list: `= ANY('{}')` is false for every row, including rows
    // whose value is NULL, and binds one ordinary param.
    assert.match(sql, /WHERE/, 'an empty OR must not compile to "no predicate at all"');
    assert.match(sql, /"id" = ANY\(\$1\)/);
    assert.deepEqual(params, [[]]);
  });

  it('AND: [] and NOT: {} still match every row (Prisma treats them as true)', () => {
    const compat = compatClient();
    assert.doesNotMatch(sqlOf(compat.Post.findMany({ where: { AND: [] } } as Any)).sql, /WHERE/);
    assert.doesNotMatch(sqlOf(compat.Post.findMany({ where: { NOT: {} } } as Any)).sql, /WHERE/);
  });

  it('a NON-empty OR is untouched', () => {
    const compat = compatClient();
    const { sql, params } = sqlOf(compat.Post.findMany({ where: { OR: [{ id: 1 }, { id: 2 }] } } as Any));
    assert.match(sql, /"id" = \$1/);
    assert.match(sql, /"id" = \$2/);
    assert.deepEqual(params, [1, 2]);
  });

  it('an empty OR nested inside AND still matches nothing', () => {
    const compat = compatClient();
    const { sql } = sqlOf(compat.Post.findMany({ where: { AND: [{ title: 'x' }, { OR: [] }] } } as Any));
    assert.match(sql, /"id" = ANY\(\$2\)/);
  });

  it('an empty OR on a model reached through a relation filter is compiled too', () => {
    const compat = compatClient();
    const { sql } = sqlOf(compat.Post.findMany({ where: { comments: { some: { OR: [] } } } } as Any));
    assert.match(sql, /= ANY\(/);
  });
});

// ---------------------------------------------------------------------------
// 3. A bare null on a to-one relation
// ---------------------------------------------------------------------------

describe('prisma-compat: a bare null on a to-one relation key', () => {
  it('{ author: null } becomes { is: null } and compiles to a NOT EXISTS on the renamed relation', () => {
    const compat = compatClient();
    const { sql } = sqlOf(compat.Post.findMany({ where: { author: null } } as Any));
    assert.match(sql, /NOT EXISTS/, 'a to-one `is: null` is "no related row"');
    assert.match(sql, /"users"/, 'the Prisma name `author` resolved to the turbine relation `user`');
  });

  it('{ author: { isNot: null } } is unchanged', () => {
    const compat = compatClient();
    const { sql } = sqlOf(compat.Post.findMany({ where: { author: { isNot: null } } } as Any));
    assert.match(sql, /EXISTS/);
    assert.doesNotMatch(sql, /NOT EXISTS/);
  });

  it('{ author: { is: null } } (already core-shaped) still works', () => {
    const compat = compatClient();
    assert.match(sqlOf(compat.Post.findMany({ where: { author: { is: null } } } as Any)).sql, /NOT EXISTS/);
  });

  it('a bare null on a TO-MANY relation key is left alone (Prisma has no such shape)', () => {
    const compat = compatClient();
    // Not silently reinterpreted: core decides, and core refuses it by name.
    assert.throws(() => sqlOf(compat.Post.findMany({ where: { comments: null } } as Any)), TurbineError);
  });

  it('a bare null on a SCALAR field is still an IS NULL, not a relation filter', () => {
    const compat = compatClient();
    const { sql } = sqlOf(compat.Post.findMany({ where: { authorId: null } } as Any));
    assert.match(sql, /"author_id" IS NULL/);
  });
});
