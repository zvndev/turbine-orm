/**
 * turbine-orm — `equals` operator tests (build-only, no DB)
 *
 * README and the site docs document `{ email: { equals: 'a@b.com' } }` as
 * explicit equality — the most common operator a migrating Prisma user types.
 * Before this fix, `equals` was only recognized as a JSONB filter key and
 * threw ValidationError on non-JSON columns. These tests pin the documented
 * contract:
 *
 *   - `{ equals: value }` on a non-JSON column → `"col" = $n` (parameterized)
 *   - `{ equals: null }`                       → `"col" IS NULL`
 *   - `equals` on a json/jsonb column still routes to the JSONB containment
 *     filter (no regression)
 *   - the cache-hit param-collection path stays in lockstep with the build
 *     path (the v0.19.1 bug class)
 *   - `equals` works inside relation filters (some/every/none) and relation
 *     `with ... where` clauses, consistently with `not` / `gt`
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

/** Every $N referenced in the SQL must have a params entry and vice versa. */
function assertParamsAligned(sql: string, params: unknown[]): void {
  const referenced = new Set<number>();
  for (const m of sql.matchAll(/\$(\d+)/g)) {
    referenced.add(Number(m[1]));
  }
  const max = referenced.size ? Math.max(...referenced) : 0;
  assert.equal(max, params.length, `SQL references up to $${max} but got ${params.length} params: ${sql}`);
  for (let i = 1; i <= params.length; i++) {
    assert.ok(referenced.has(i), `param $${i} is never referenced in SQL — orphaned param: ${sql}`);
  }
}

function buildSchema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      users: mockTable(
        'users',
        [
          { name: 'id', field: 'id' },
          { name: 'email', field: 'email', pgType: 'text' },
          { name: 'age', field: 'age', pgType: 'int4' },
          { name: 'settings', field: 'settings', pgType: 'jsonb' },
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
        },
      ),
      posts: mockTable('posts', [
        { name: 'id', field: 'id' },
        { name: 'user_id', field: 'userId' },
        { name: 'title', field: 'title', pgType: 'text' },
      ]),
    },
  };
}

describe('equals operator (plain equality)', () => {
  it('compiles { equals: value } on a text column to "col" = $n', () => {
    const q = makeQuery('users', buildSchema());
    const d = q.buildFindMany({ where: { email: { equals: 'a@b.com' } } });
    assert.match(d.sql, /"email" = \$1/);
    assert.deepEqual(d.params, ['a@b.com']);
    assert.ok(!d.sql.includes('a@b.com'), 'value must never appear in the SQL string');
    assertParamsAligned(d.sql, d.params);
  });

  it('compiles { equals: value } on an int column to "col" = $n', () => {
    const q = makeQuery('users', buildSchema());
    const d = q.buildFindMany({ where: { age: { equals: 42 } } });
    assert.match(d.sql, /"age" = \$1/);
    assert.deepEqual(d.params, [42]);
    assertParamsAligned(d.sql, d.params);
  });

  it('compiles { equals: null } to "col" IS NULL with no params', () => {
    const q = makeQuery('users', buildSchema());
    const d = q.buildFindMany({ where: { email: { equals: null } } });
    assert.match(d.sql, /"email" IS NULL/);
    assert.deepEqual(d.params, []);
    assertParamsAligned(d.sql, d.params);
  });

  it('combines equals with other operators on the same field (ANDed, equals first)', () => {
    const q = makeQuery('users', buildSchema());
    const d = q.buildFindMany({ where: { age: { equals: 30, gt: 10, not: 99 } } });
    assert.match(d.sql, /"age" = \$1/);
    assert.match(d.sql, /"age" > \$2/);
    assert.match(d.sql, /"age" != \$3/);
    assert.deepEqual(d.params, [30, 10, 99]);
    assertParamsAligned(d.sql, d.params);
  });

  it('matches the behavior of bare equality (same SQL shape, different fingerprint allowed)', () => {
    const q = makeQuery('users', buildSchema());
    const explicit = q.buildFindMany({ where: { email: { equals: 'x' } } });
    const bare = q.buildFindMany({ where: { email: 'x' } });
    assert.match(explicit.sql, /"email" = \$1/);
    assert.match(bare.sql, /"email" = \$1/);
    assert.deepEqual(explicit.params, bare.params);
  });

  it('still routes equals on a jsonb column to the JSONB containment filter', () => {
    const q = makeQuery('users', buildSchema());
    const d = q.buildFindMany({ where: { settings: { equals: { theme: 'dark' } } } as never });
    assert.match(d.sql, /"settings" @> \$1::jsonb/);
    assert.deepEqual(d.params, [JSON.stringify({ theme: 'dark' })]);
    assertParamsAligned(d.sql, d.params);
  });

  it('still routes path + equals on a jsonb column to path extraction', () => {
    const q = makeQuery('users', buildSchema());
    const d = q.buildFindMany({ where: { settings: { path: ['theme'], equals: 'dark' } } as never });
    assert.match(d.sql, /#>>/);
    assert.deepEqual(d.params, [['theme'], 'dark']);
    assertParamsAligned(d.sql, d.params);
  });

  it('throws ValidationError for a plain-object equals value on a non-JSON column', () => {
    const q = makeQuery('users', buildSchema());
    assert.throws(
      () => q.buildFindMany({ where: { email: { equals: { foo: 1 } } as never } }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match((err as Error).message, /'equals'/);
        return true;
      },
    );
  });

  it('works in update / delete WHERE clauses', () => {
    const q = makeQuery('users', buildSchema());
    const upd = q.buildUpdate({ where: { email: { equals: 'a@b.com' } }, data: { age: 1 } } as never);
    assert.match(upd.sql, /"email" = \$2/); // $1 is the SET value
    assert.deepEqual(upd.params, [1, 'a@b.com']);
    assertParamsAligned(upd.sql, upd.params);

    const del = q.buildDelete({ where: { id: { equals: 7 } } } as never);
    assert.match(del.sql, /"id" = \$1/);
    assert.deepEqual(del.params, [7]);
    assertParamsAligned(del.sql, del.params);
  });

  describe('relation paths (consistency with not/gt)', () => {
    it('works inside relation filters (some/none/every)', () => {
      const q = makeQuery('users', buildSchema());
      const d = q.buildFindMany({
        where: { posts: { some: { title: { equals: 'hello' } } } } as never,
      });
      assert.match(d.sql, /EXISTS \(SELECT 1 FROM "posts"/);
      assert.match(d.sql, /"posts"\."title" = \$1/);
      assert.deepEqual(d.params, ['hello']);
      assertParamsAligned(d.sql, d.params);
    });

    it('works in a relation `with ... where` clause', () => {
      const q = makeQuery('users', buildSchema());
      const d = q.buildFindMany({
        with: { posts: { where: { title: { equals: 'hello' } } } },
      } as never);
      assert.match(d.sql, /\."title" = \$1/);
      assert.deepEqual(d.params, ['hello']);
      assertParamsAligned(d.sql, d.params);
    });
  });

  describe('SQL cache-hit param collection (v0.19.1 bug class)', () => {
    it('cache hit re-collects equals params correctly (same SQL, new values)', () => {
      const q = makeQuery('users', buildSchema());
      const first = q.buildFindMany({ where: { email: { equals: 'first@x.com' } } });
      const second = q.buildFindMany({ where: { email: { equals: 'second@x.com' } } });
      assert.equal(first.sql, second.sql, 'identical shape must share the cached SQL template');
      assert.deepEqual(first.params, ['first@x.com']);
      assert.deepEqual(second.params, ['second@x.com']);
      assertParamsAligned(second.sql, second.params);
    });

    it('equals: null and equals: value never share a cache entry (different SQL shapes)', () => {
      const q = makeQuery('users', buildSchema());
      const withValue = q.buildFindMany({ where: { email: { equals: 'x' } } });
      const withNull = q.buildFindMany({ where: { email: { equals: null } } });
      assert.notEqual(withValue.sql, withNull.sql);
      assert.match(withNull.sql, /"email" IS NULL/);
      assert.deepEqual(withNull.params, []);
      assertParamsAligned(withValue.sql, withValue.params);
      assertParamsAligned(withNull.sql, withNull.params);
    });

    it('not: null and not: value never share a cache entry (same latent shape bug)', () => {
      const q = makeQuery('users', buildSchema());
      const withValue = q.buildFindMany({ where: { email: { not: 'x' } } });
      const withNull = q.buildFindMany({ where: { email: { not: null } } });
      assert.notEqual(withValue.sql, withNull.sql);
      assert.match(withNull.sql, /"email" IS NOT NULL/);
      assert.deepEqual(withNull.params, []);
      assertParamsAligned(withValue.sql, withValue.params);
      assertParamsAligned(withNull.sql, withNull.params);
    });

    it('cache warmed by a scalar equals still rejects a plain-object equals (guard on collect path)', () => {
      const q = makeQuery('users', buildSchema());
      // Warm the cache with a legitimate scalar equals.
      q.buildFindMany({ where: { email: { equals: 'warm@x.com' } } });
      // The same fingerprint shape with an object value must throw, not bind.
      assert.throws(
        () => q.buildFindMany({ where: { email: { equals: { sneaky: true } } as never } }),
        ValidationError,
      );
    });

    it('combined operators stay aligned across cache hits', () => {
      const q = makeQuery('users', buildSchema());
      const first = q.buildFindMany({ where: { age: { equals: 1, lt: 10 } } });
      const second = q.buildFindMany({ where: { age: { equals: 2, lt: 20 } } });
      assert.equal(first.sql, second.sql);
      assert.deepEqual(second.params, [2, 20]);
      assertParamsAligned(second.sql, second.params);
    });
  });
});
