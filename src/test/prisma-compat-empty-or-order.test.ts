/**
 * turbine-orm/prisma-compat: an empty `OR` beside another `where` key.
 *
 * THE RULE: the ORDER a caller writes the keys of a `where` object in never
 * changes which predicates survive. `{ OR: [], id: 5 }` and `{ id: 5, OR: [] }`
 * are the same query and must compile to the same statement.
 *
 * They did not. Prisma reads an empty `OR` as "no rows", core drops an empty
 * combinator entirely, so the adapter compiles a sentinel predicate that
 * matches nothing. The sentinel is keyed on a REAL column of the table (the
 * first primary-key column), and it was `Object.assign`ed into the same object
 * the translated keys were being written to, so the two collided on that key
 * and `Object.entries` order decided the winner:
 *
 *     { OR: [], id: 5 }  ->  WHERE "id" = $1        params [5]
 *                            the row comes back; Prisma returns none
 *     { id: 5, OR: [] }  ->  WHERE "id" = ANY($1)   params [[]]
 *                            the caller's `id = 5` is silently gone
 *
 * `{ id: someId, OR: userSelectedFilters }` over an empty selection is an
 * ordinary filter-UI shape, and both outcomes are wrong rows rather than
 * errors. The sentinel is now conjoined, `{ AND: [translated, sentinel] }`, so
 * neither half can overwrite the other.
 *
 * The wrapper is BRANDED (`markInternalCombinator`). A caller-written
 * combinator array is what makes a statement UNNAMED, because its branch count
 * is written into the SQL text and a request body can size it; Turbine's own
 * wrappers have a fixed arity of two and stay named. An unbranded wrapper here
 * would have taken every compat query carrying an empty `OR` off named
 * prepared statements, silently.
 *
 * DB-less: the sqlDb harness backs each model with a real QueryInterface, so
 * these assert on emitted SQL, params and the prepared-statement name.
 *
 * Run: npx tsx --test src/test/prisma-compat-empty-or-order.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TurbineClient } from '../client.js';
import { ValidationError } from '../errors.js';
import { type CompatTurbineClient, createPrismaCompatClient } from '../prisma-compat.js';
import type { PrismaCompatMap, SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: test harness plumbing
type Any = any;

type Models = {
  Post: { Row: { id: number; title: string; authorId: number | null } };
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
    { name: 'author_id', field: 'authorId' },
  ]);
  posts.primaryKey = ['id'];
  posts.uniqueColumns = [['id']];
  posts.relations = {
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
        fields: { id: 'id', title: 'title', authorId: 'authorId' },
        relations: { comments: { name: 'comments', cardinality: 'many' } },
        compoundUniques: {},
      },
    },
  };
  return { schema, map };
}

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
function build(promise: unknown): { sql: string; params: unknown[]; preparedName?: string } {
  const deferred = (promise as Any)[Object.getOwnPropertySymbols(promise as object)[0] as symbol];
  return deferred.build();
}

function findMany(where: Record<string, unknown>) {
  return build((compatClient() as Any).Post.findMany({ where } as Any));
}

// ---------------------------------------------------------------------------
// The rule: key order cannot change the predicate
// ---------------------------------------------------------------------------

describe('prisma-compat: an empty OR beside another where key', () => {
  it('compiles identically in BOTH key orders', () => {
    const orFirst = findMany({ OR: [], id: 5 });
    const orLast = findMany({ id: 5, OR: [] });
    assert.equal(orLast.sql, orFirst.sql, 'the same query written two ways is one statement');
    assert.deepEqual(orLast.params, orFirst.params);
  });

  it('keeps BOTH predicates: the caller key AND the match-nothing sentinel', () => {
    for (const where of [
      { OR: [], id: 5 },
      { id: 5, OR: [] },
    ] as Record<string, unknown>[]) {
      const { sql, params } = findMany(where);
      // The caller's own predicate survives...
      assert.match(sql, /"id" = \$\d/, `caller predicate dropped for ${JSON.stringify(where)}`);
      assert.ok(params.includes(5), `the caller's value was dropped for ${JSON.stringify(where)}`);
      // ...and so does the sentinel, which is what makes the query return
      // nothing, the way Prisma's empty OR does.
      assert.match(sql, /= ANY\(\$\d\)/, `sentinel dropped for ${JSON.stringify(where)}`);
      assert.ok(
        params.some((p) => Array.isArray(p) && p.length === 0),
        `the empty list was dropped for ${JSON.stringify(where)}`,
      );
    }
  });

  it('holds with the sentinel key SANDWICHED between two caller keys', () => {
    // Three-key orders exercise the collision from both sides at once: `id` is
    // the sentinel's column, `title` is not.
    const a = findMany({ title: 'x', OR: [], id: 5 });
    const b = findMany({ id: 5, title: 'x', OR: [] });
    const c = findMany({ OR: [], title: 'x', id: 5 });
    assert.equal(b.sql, a.sql);
    assert.equal(c.sql, a.sql);
    assert.match(a.sql, /"id" = \$\d/);
    assert.match(a.sql, /"title" = \$\d/);
    assert.match(a.sql, /= ANY\(\$\d\)/);
  });

  it('holds on a NON-primary-key caller predicate too', () => {
    // The collision only bites on the sentinel's own column, so a fix that
    // merely renamed the sentinel column would pass the `id` cases and fail
    // nothing. This pins that the other keys are untouched either way.
    const a = findMany({ OR: [], title: 'x' });
    const b = findMany({ title: 'x', OR: [] });
    assert.equal(b.sql, a.sql);
    assert.match(a.sql, /"title" = \$\d/);
    assert.match(a.sql, /= ANY\(\$\d\)/);
  });

  it('holds one level down, inside a caller AND and inside a relation filter', () => {
    const nested = findMany({ AND: [{ OR: [], id: 5 }] });
    assert.match(nested.sql, /"id" = \$\d/);
    assert.match(nested.sql, /= ANY\(\$\d\)/);
    const rel = findMany({ comments: { some: { OR: [], name: 'ann' } } });
    assert.match(rel.sql, /"name" = \$\d/);
    assert.match(rel.sql, /= ANY\(\$\d\)/);
  });

  it('an empty OR ALONE is unchanged: the sentinel is the whole where, no wrapper', () => {
    const { sql, params } = findMany({ OR: [] });
    assert.match(sql, /WHERE "id" = ANY\(\$1\)$/);
    assert.deepEqual(params, [[]]);
  });

  it('empty AND / NOT still match every row, and a non-empty OR is untouched', () => {
    assert.doesNotMatch(findMany({ AND: [] }).sql, /WHERE/);
    assert.doesNotMatch(findMany({ NOT: {} }).sql, /WHERE/);
    const or = findMany({ OR: [{ id: 1 }, { id: 2 }] });
    assert.deepEqual(or.params, [1, 2]);
    assert.doesNotMatch(or.sql, /= ANY\(/, 'a populated OR gets no sentinel');
  });
});

// ---------------------------------------------------------------------------
// The wrapper must not change prepared-statement naming
// ---------------------------------------------------------------------------

describe('prisma-compat: the empty-OR wrapper is Turbine-internal, so it stays named', () => {
  it('a where carrying an empty OR keeps a prepared statement name', () => {
    // The wrapper is an `AND` array, which is exactly the shape that unnames a
    // statement when a CALLER wrote it. This one is Turbine's, fixed at two
    // branches, so the brand must exempt it.
    for (const where of [
      { OR: [], id: 5 },
      { id: 5, OR: [] },
      { title: 'x', OR: [], id: 5 },
    ]) {
      const name = findMany(where).preparedName;
      assert.ok(name && name.length > 0, `unnamed for ${JSON.stringify(where)}: the brand is missing`);
    }
  });

  it('a CALLER-written combinator is still unnamed, brand or no brand', () => {
    // The exemption must not have widened: a caller-sized OR is still the
    // shape whose branch count reaches the SQL text.
    assert.equal(findMany({ OR: [{ id: 1 }, { id: 2 }] }).preparedName, '');
    assert.equal(findMany({ OR: [{ id: 1 }], title: 'x' }).preparedName, '');
    // ...and a caller combinator INSIDE the wrapper still counts, because the
    // brand is read per level and the caller's object is walked on its own.
    assert.equal(findMany({ OR: [], AND: [{ id: 1 }, { id: 2 }] }).preparedName, '');
  });

  it('a plain where is named, so the assertion above is not vacuous', () => {
    const name = findMany({ id: 7 }).preparedName;
    assert.ok(name && name.length > 0);
  });
});

// ---------------------------------------------------------------------------
// The sentinel builder must not report success when it cannot build one
// ---------------------------------------------------------------------------

describe('prisma-compat: a sentinel that cannot be built is an error, not an empty where', () => {
  it('throws E003 rather than returning a fragment that matches EVERY row', () => {
    // A model whose table carries no columns cannot name one for the sentinel.
    // The old fallback returned `{}`, which is not "no rows" but its exact
    // opposite, merged in silently beside the caller's predicates.
    const schema: SchemaMetadata = { enums: {}, tables: { posts: mockTable('posts', []) } };
    schema.tables.posts!.primaryKey = [];
    schema.tables.posts!.allColumns = [];
    const map: PrismaCompatMap = {
      enums: {},
      models: {
        Post: { table: 'posts', accessor: 'posts', fields: {}, relations: {}, compoundUniques: {} },
      },
    };
    const compat = createPrismaCompatClient<{ Post: { Row: Record<string, never> } }>(
      sqlDb(schema) as unknown as TurbineClient,
      map,
    );
    assert.throws(
      () => build((compat as Any).Post.findMany({ where: { OR: [] } } as Any)),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError, `expected E003, got ${String(err)}`);
        assert.match(err.message, /empty `OR`/);
        return true;
      },
    );
  });
});
