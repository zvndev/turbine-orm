/**
 * turbine-orm — v0.19.1 regression suite
 *
 * Covers four query-builder fixes found by the v0.19.0 post-release audit:
 *
 * 1. CACHE BYPASS: the unknown-operator guard ran only in buildWhereClause
 *    (cache-miss path). After any equality query warmed the SQL cache for a
 *    field set, a misspelled operator object went through collectWhereParams
 *    unguarded and executed `col = $1` with the object as the value — the
 *    exact silent-wrong-rows bug v0.19.0 headlined as fixed. The guard now
 *    runs on BOTH paths, and unmatched objects fingerprint distinctly from
 *    equality so they can never share a cache entry.
 *
 * 2. NESTED RELATION WHERE: buildRelationSubquery / buildManyToManySubquery
 *    treated every `with: { rel: { where } }` entry as bare equality —
 *    operator objects bound as values (silent wrong rows), OR/AND/NOT threw
 *    "Unknown column". Nested where now supports the full scalar surface.
 *
 * 3. CLASS-INSTANCE EQUALITY: the guard threw for Buffer (bytea) and other
 *    class instances. Only plain object literals throw now.
 *
 * 4. limit: 0 / orderBy: {} on relations: `limit: 0` triggered the wrapped
 *    path via `!== undefined` but skipped the LIMIT clause via truthiness,
 *    silently dropping nested relations; `orderBy: {}` rendered a dangling
 *    `ORDER BY `. Both are now normalized.
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
          { name: 'name', field: 'name', pgType: 'text' },
          { name: 'avatar', field: 'avatar', pgType: 'bytea' },
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
          tags: {
            type: 'manyToMany',
            name: 'tags',
            from: 'users',
            to: 'tags',
            foreignKey: 'id',
            referenceKey: 'id',
            through: { table: 'users_tags', sourceKey: 'user_id', targetKey: 'tag_id' },
          },
        },
      ),
      posts: mockTable(
        'posts',
        [
          { name: 'id', field: 'id' },
          { name: 'user_id', field: 'userId' },
          { name: 'title', field: 'title', pgType: 'text' },
          { name: 'view_count', field: 'viewCount', pgType: 'int4' },
          { name: 'deleted_at', field: 'deletedAt', pgType: 'timestamptz' },
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
          comments: {
            type: 'hasMany',
            name: 'comments',
            from: 'posts',
            to: 'comments',
            foreignKey: 'post_id',
            referenceKey: 'id',
          },
        },
      ),
      comments: mockTable('comments', [
        { name: 'id', field: 'id' },
        { name: 'post_id', field: 'postId' },
        { name: 'body', field: 'body', pgType: 'text' },
      ]),
      tags: mockTable('tags', [
        { name: 'id', field: 'id' },
        { name: 'label', field: 'label', pgType: 'text' },
      ]),
    },
  };
}

describe('unknown-operator guard survives the SQL cache (H2)', () => {
  it('throws for a misspelled operator even after an equality query warmed the cache', () => {
    const q = makeQuery('users', buildSchema());
    // Warm the cache with genuine equality on the same field set.
    const warm = q.buildFindMany({ where: { name: 'alice' } } as never);
    assert.deepEqual(warm.params, ['alice']);
    // The misspelled operator must throw — not silently bind `{startWith: 'a'}`.
    assert.throws(
      () => q.buildFindMany({ where: { name: { startWith: 'a' } } as never }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match((err as Error).message, /"startWith"/);
        assert.match((err as Error).message, /startsWith/);
        return true;
      },
    );
  });

  it('throws for an empty filter object even after a cache warm', () => {
    const q = makeQuery('users', buildSchema());
    q.buildFindMany({ where: { name: 'alice' } } as never);
    assert.throws(
      () => q.buildFindMany({ where: { name: {} } as never }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match((err as Error).message, /Empty filter object/);
        return true;
      },
    );
  });

  it('fingerprints an unmatched object distinctly from equality', () => {
    const q = makeQuery('users', buildSchema());
    const eq = q.fingerprintWhere({ name: 'alice' });
    const bad = q.fingerprintWhere({ name: { startWith: 'a' } });
    assert.notEqual(eq, bad, 'bad-operator object must never share a cache entry with equality');
  });

  it('repeated identical operator queries produce identical SQL and params (cache-hit parity)', () => {
    const q = makeQuery('users', buildSchema());
    const a = q.buildFindMany({ where: { name: { contains: 'x' } } } as never);
    const b = q.buildFindMany({ where: { name: { contains: 'x' } } } as never);
    assert.equal(a.sql, b.sql);
    assert.deepEqual(a.params, b.params);
    assertParamsAligned(b.sql, b.params);
  });

  it('throws inside relation filters (some/every/none) on both cold and warmed paths', () => {
    const q = makeQuery('users', buildSchema());
    // cold
    assert.throws(
      () => q.buildFindMany({ where: { posts: { some: { title: { startWith: 'a' } } } } } as never),
      ValidationError,
    );
    // warm with equality sub-where, then misspell — must still throw
    q.buildFindMany({ where: { posts: { some: { title: 'hello' } } } } as never);
    assert.throws(
      () => q.buildFindMany({ where: { posts: { some: { title: { startWith: 'a' } } } } } as never),
      ValidationError,
    );
  });
});

describe('class-instance equality values pass the guard (Buffer/bytea)', () => {
  it('binds a Buffer as a plain equality param on a bytea column', () => {
    const q = makeQuery('users', buildSchema());
    const buf = Buffer.from([0xde, 0xad]);
    const { sql, params } = q.buildFindMany({ where: { avatar: buf } } as never);
    assertParamsAligned(sql, params);
    assert.equal(params[0], buf);
    assert.match(sql, /"avatar" = \$1/);
  });

  it('binds a Buffer identically cold and after a cache warm', () => {
    const q = makeQuery('users', buildSchema());
    const a = q.buildFindMany({ where: { avatar: Buffer.from('a') } } as never);
    const b = q.buildFindMany({ where: { avatar: Buffer.from('b') } } as never);
    assert.equal(a.sql, b.sql);
    assert.equal((b.params[0] as Buffer).toString(), 'b');
  });

  it('binds non-plain class instances (e.g. Decimal-style wrappers) as values', () => {
    class Decimal {
      constructor(private readonly v: string) {}
      toPostgres(): string {
        return this.v;
      }
    }
    const q = makeQuery('posts', buildSchema());
    const dec = new Decimal('42.5');
    const { sql, params } = q.buildFindMany({ where: { viewCount: dec } } as never);
    assertParamsAligned(sql, params);
    assert.equal(params[0], dec);
  });

  it('still throws for plain object literals on non-JSON columns', () => {
    const q = makeQuery('users', buildSchema());
    assert.throws(() => q.buildFindMany({ where: { name: { oops: 1 } } as never }), ValidationError);
  });

  it('still allows plain-object equality on jsonb columns', () => {
    const q = makeQuery('users', buildSchema());
    assert.doesNotThrow(() => q.buildFindMany({ where: { settings: { theme: 'dark' } } as never }));
  });
});

describe('nested relation where supports the full scalar surface (H3)', () => {
  it('applies operator objects inside a hasMany with-where', () => {
    const q = makeQuery('users', buildSchema());
    const { sql, params } = q.buildFindMany({
      with: { posts: { where: { title: { contains: 'sql' } } } },
    } as never);
    assertParamsAligned(sql, params);
    assert.match(sql, /t0\."title" LIKE \$1 ESCAPE/);
    assert.equal(params[0], '%sql%');
  });

  it('supports mode: insensitive inside a relation where', () => {
    const q = makeQuery('users', buildSchema());
    const { sql, params } = q.buildFindMany({
      with: { posts: { where: { title: { startsWith: 'a', mode: 'insensitive' } } } },
    } as never);
    assertParamsAligned(sql, params);
    assert.match(sql, /ILIKE/);
    assert.equal(params[0], 'a%');
  });

  it('supports gt/lt comparators inside a relation where', () => {
    const q = makeQuery('users', buildSchema());
    const { sql, params } = q.buildFindMany({
      with: { posts: { where: { viewCount: { gt: 10, lte: 100 } } } },
    } as never);
    assertParamsAligned(sql, params);
    assert.match(sql, /t0\."view_count" > \$1/);
    assert.match(sql, /t0\."view_count" <= \$2/);
    assert.deepEqual(params, [10, 100]);
  });

  it('supports OR / NOT combinators inside a relation where', () => {
    const q = makeQuery('users', buildSchema());
    const { sql, params } = q.buildFindMany({
      with: {
        posts: {
          where: {
            OR: [{ title: { startsWith: 'a' } }, { viewCount: { gt: 5 } }],
            NOT: { title: 'spam' },
          },
        },
      },
    } as never);
    assertParamsAligned(sql, params);
    assert.match(sql, /\(\(t0\."title" LIKE \$1 ESCAPE '\\'\) OR \(t0\."view_count" > \$2\)\)/);
    assert.match(sql, /NOT \(t0\."title" = \$3\)/);
    assert.deepEqual(params, ['a%', 5, 'spam']);
  });

  it('supports null (IS NULL) inside a relation where', () => {
    const q = makeQuery('users', buildSchema());
    const { sql, params } = q.buildFindMany({
      with: { posts: { where: { deletedAt: null } } },
    } as never);
    assertParamsAligned(sql, params);
    assert.match(sql, /t0\."deleted_at" IS NULL/);
    assert.deepEqual(params, []);
  });

  it('plain equality in a relation where still works', () => {
    const q = makeQuery('users', buildSchema());
    const { sql, params } = q.buildFindMany({
      with: { posts: { where: { title: 'hello' } } },
    } as never);
    assertParamsAligned(sql, params);
    assert.match(sql, /t0\."title" = \$1/);
    assert.deepEqual(params, ['hello']);
  });

  it('throws for a misspelled operator inside a relation where (no silent equality)', () => {
    const q = makeQuery('users', buildSchema());
    assert.throws(
      () => q.buildFindMany({ with: { posts: { where: { title: { startWith: 'a' } } } } } as never),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match((err as Error).message, /"startWith"/);
        return true;
      },
    );
  });

  it('still throws for an unknown column in a relation where', () => {
    const q = makeQuery('users', buildSchema());
    assert.throws(
      () => q.buildFindMany({ with: { posts: { where: { nope: 1 } } } } as never),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match((err as Error).message, /Unknown column "nope" in where for table "posts"/);
        return true;
      },
    );
  });

  it('applies operators inside a belongsTo with-where', () => {
    const q = makeQuery('posts', buildSchema());
    const { sql, params } = q.buildFindMany({
      with: { author: { where: { name: { endsWith: 'son' } } } },
    } as never);
    assertParamsAligned(sql, params);
    assert.match(sql, /t0\."name" LIKE \$1 ESCAPE/);
    assert.equal(params[0], '%son');
  });

  it('applies operators inside a manyToMany with-where', () => {
    const q = makeQuery('users', buildSchema());
    const { sql, params } = q.buildFindMany({
      with: { tags: { where: { label: { contains: 'db' } } } },
    } as never);
    assertParamsAligned(sql, params);
    assert.match(sql, /LIKE \$1 ESCAPE/);
    assert.equal(params[0], '%db%');
  });

  it('relation where operators combine with relation limit (param order preserved)', () => {
    const q = makeQuery('users', buildSchema());
    const { sql, params } = q.buildFindMany({
      with: { posts: { where: { viewCount: { gt: 1 } }, limit: 5 } },
      limit: 20,
    } as never);
    assertParamsAligned(sql, params);
    assert.deepEqual(params, [1, 5, 20]);
  });

  it('cache-hit produces identical SQL and params for nested operator wheres', () => {
    const q = makeQuery('users', buildSchema());
    const args = { with: { posts: { where: { title: { contains: 'x' } }, limit: 3 } } } as never;
    const a = q.buildFindMany(args);
    const b = q.buildFindMany(args);
    assert.equal(a.sql, b.sql);
    assert.deepEqual(a.params, b.params);
  });

  it('fingerprints nested equality and nested operator wheres distinctly', () => {
    const q = makeQuery('users', buildSchema());
    const eq = q.withFingerprint({ posts: { where: { title: 'x' } } } as never);
    const op = q.withFingerprint({ posts: { where: { title: { contains: 'x' } } } } as never);
    assert.notEqual(eq, op, 'different SQL shapes must not share a with-fingerprint');
  });
});

describe('relation limit: 0 and orderBy: {} edge cases', () => {
  it('honors limit: 0 on a hasMany relation (LIMIT $N with 0, no orphaned params)', () => {
    const q = makeQuery('users', buildSchema());
    const { sql, params } = q.buildFindMany({ with: { posts: { limit: 0 } } } as never);
    assertParamsAligned(sql, params);
    assert.match(sql, /LIMIT \$1/);
    assert.deepEqual(params, [0]);
  });

  it('limit: 0 does not drop nested relations', () => {
    const q = makeQuery('users', buildSchema());
    const { sql, params } = q.buildFindMany({
      with: { posts: { limit: 0, with: { comments: true } } },
    } as never);
    assertParamsAligned(sql, params);
    assert.match(sql, /'comments'/, 'nested comments relation must still be built');
  });

  it('treats orderBy: {} as absent (no dangling ORDER BY, nested relations kept)', () => {
    const q = makeQuery('users', buildSchema());
    const { sql, params } = q.buildFindMany({
      with: { posts: { orderBy: {}, with: { comments: true } } },
    } as never);
    assertParamsAligned(sql, params);
    assert.doesNotMatch(sql, /ORDER BY\s*(LIMIT|\)|$)/, 'must not render a dangling ORDER BY');
    assert.match(sql, /'comments'/);
  });

  it('honors limit: 0 on a manyToMany relation', () => {
    const q = makeQuery('users', buildSchema());
    const { sql, params } = q.buildFindMany({ with: { tags: { limit: 0 } } } as never);
    assertParamsAligned(sql, params);
    assert.deepEqual(params, [0]);
  });

  it('treats orderBy: {} as absent on a manyToMany relation', () => {
    const q = makeQuery('users', buildSchema());
    const { sql } = q.buildFindMany({ with: { tags: { orderBy: {} } } } as never);
    assert.doesNotMatch(sql, /ORDER BY\s*(LIMIT|\)|$)/);
  });
});
