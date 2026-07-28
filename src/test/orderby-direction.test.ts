/**
 * orderBy direction validation.
 *
 * Every direction consumer was `String(v).toLowerCase() === 'desc' ? 'DESC' :
 * 'ASC'`, so ANY unrecognized direction sorted ASCENDING with no error:
 * `'descending'`, `''`, `null` and `1` all emitted `ORDER BY "id" ASC`. It is
 * not injectable and TypeScript rejects those values, but the shape that
 * reaches this code in production is `orderBy: { [field]: req.query.dir }`,
 * which is untyped at the boundary, and the failure mode is a correct-looking
 * page in exactly the wrong order.
 *
 * These tests assert the refusal across the WHOLE orderBy surface (plain, spec,
 * relation to-one, relation `_count`, nested `with`, JSON path, vector KNN,
 * pick-row, groupBy, groupBy distinctOn), and that a warm SQL cache cannot
 * serve a bad direction from a good one's entry.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

/** The four values verified to sort ASCENDING silently before this guard. */
const BAD_DIRECTIONS: unknown[] = ['descending', '', null, 1];

function schema(): SchemaMetadata {
  const users = mockTable(
    'users',
    [
      { name: 'id', field: 'id' },
      { name: 'name', field: 'name', pgType: 'text' },
      { name: 'profile', field: 'profile', pgType: 'jsonb' },
      { name: 'embedding', field: 'embedding', pgType: 'vector' },
    ],
    {
      posts: { type: 'hasMany', name: 'posts', from: 'users', to: 'posts', foreignKey: 'user_id', referenceKey: 'id' },
      profileRow: {
        type: 'hasOne',
        name: 'profileRow',
        from: 'users',
        to: 'profiles',
        foreignKey: 'user_id',
        referenceKey: 'id',
      },
    },
  );
  users.primaryKey = ['id'];

  const posts = mockTable('posts', [
    { name: 'id', field: 'id' },
    { name: 'user_id', field: 'userId' },
    { name: 'title', field: 'title', pgType: 'text' },
  ]);
  posts.primaryKey = ['id'];

  const profiles = mockTable('profiles', [
    { name: 'id', field: 'id' },
    { name: 'user_id', field: 'userId' },
    { name: 'bio', field: 'bio', pgType: 'text' },
  ]);
  profiles.primaryKey = ['id'];

  return { enums: {}, tables: { users, posts, profiles } };
}

const q = () => makeQuery('users', schema());

/** Assert the E003 refusal, and that it names the direction rather than the column. */
function assertRefused(run: () => unknown, label: string): void {
  assert.throws(
    run,
    (err: unknown) => {
      assert.ok(err instanceof ValidationError, `${label}: expected ValidationError, got ${String(err)}`);
      assert.match(err.message, /Invalid orderBy direction/, label);
      return true;
    },
    label,
  );
}

// ---------------------------------------------------------------------------

describe('orderBy direction: a plain unrecognized direction is refused, never sorted ascending', () => {
  it('asc / desc / DESC still compile (any casing, unchanged behaviour)', () => {
    assert.match(q().buildFindMany({ orderBy: { id: 'desc' } }).sql, /ORDER BY "id" DESC/);
    assert.match(q().buildFindMany({ orderBy: { id: 'asc' } }).sql, /ORDER BY "id" ASC/);
    assert.match(
      q().buildFindMany({ orderBy: { id: 'DESC' as unknown as 'desc' } }).sql,
      /ORDER BY "id" DESC/,
      'uppercase already worked and must keep working',
    );
  });

  for (const bad of BAD_DIRECTIONS) {
    it(`refuses ${JSON.stringify(bad)} (used to emit ORDER BY "id" ASC)`, () => {
      assertRefused(() => q().buildFindMany({ orderBy: { id: bad as 'asc' } }), `direction ${JSON.stringify(bad)}`);
    });
  }

  it('an untyped handler value is the real-world shape', () => {
    const dir = JSON.parse('{"dir":"descending"}').dir as 'asc' | 'desc';
    assertRefused(() => q().buildFindMany({ orderBy: { name: dir } }), 'req.query.dir');
  });

  it('the array (Prisma-style) orderBy form is covered too', () => {
    assertRefused(
      () => q().buildFindMany({ orderBy: [{ id: 'asc' }, { name: 'descending' as 'desc' }] }),
      'array form',
    );
  });

  it('an OrderBySpec with a bad `sort` is refused', () => {
    assertRefused(
      () => q().buildFindMany({ orderBy: { id: { sort: 'descending' as 'desc', nulls: 'last' } } }),
      'spec.sort',
    );
  });

  it('undefined stays "no ordering for this entry" (not an error)', () => {
    const { sql } = q().buildFindMany({ orderBy: { id: undefined as unknown as 'asc' } });
    assert.doesNotMatch(sql, /ORDER BY/);
  });
});

describe('orderBy direction: the guard covers the relation + nested surface', () => {
  it('to-one relation column ordering', () => {
    assertRefused(
      () => q().buildFindMany({ orderBy: { profileRow: { bio: 'descending' as 'desc' } } }),
      'to-one relation column',
    );
  });

  it('relation _count ordering', () => {
    assertRefused(
      () => q().buildFindMany({ orderBy: { posts: { _count: 'descending' as 'desc' } } }),
      'relation _count',
    );
  });

  it('pick-row relation ordering (the `direction` field)', () => {
    assertRefused(
      () =>
        q().buildFindMany({
          orderBy: {
            posts: { pick: { orderBy: { id: 'desc' } }, by: 'title', direction: 'descending' as 'desc' },
          },
        }),
      'pick-row direction',
    );
  });

  it('pick-row inner orderBy', () => {
    assertRefused(
      () =>
        q().buildFindMany({
          orderBy: {
            posts: { pick: { orderBy: { id: 'descending' as 'desc' } }, by: 'title', direction: 'desc' },
          },
        }),
      'pick.orderBy',
    );
  });

  it('a `with` clause relation orderBy', () => {
    assertRefused(
      () => q().buildFindMany({ with: { posts: { orderBy: { title: 'descending' as 'desc' } } } }),
      'with-clause orderBy',
    );
  });

  it('JSON-path ordering (`direction`)', () => {
    assertRefused(
      () =>
        q().buildFindMany({
          orderBy: { profile: { path: ['a'], direction: 'descending' as 'desc' } },
        }),
      'JSON-path direction',
    );
  });

  it('vector KNN ordering (`distance.direction`)', () => {
    assertRefused(
      () =>
        q().buildFindMany({
          orderBy: {
            embedding: { distance: { to: [1, 2, 3], metric: 'l2', direction: 'descending' as 'desc' } },
          },
        }),
      'vector distance direction',
    );
  });
});

describe('orderBy direction: the guard covers groupBy', () => {
  it('a groupBy `by`-key ordering', () => {
    assertRefused(
      () => q().buildGroupBy({ by: ['name'], orderBy: { name: 'descending' as 'desc' } }),
      'groupBy by-key',
    );
  });

  it('a groupBy _count ordering', () => {
    assertRefused(
      () => q().buildGroupBy({ by: ['name'], _count: true, orderBy: { _count: 'descending' as 'desc' } }),
      'groupBy _count',
    );
  });

  it('a groupBy per-aggregate ordering', () => {
    assertRefused(
      () => q().buildGroupBy({ by: ['name'], _max: { id: true }, orderBy: { _max: { id: 'descending' as 'desc' } } }),
      'groupBy _max.field',
    );
  });

  it('a groupBy distinctOn row-source ordering', () => {
    assertRefused(
      () =>
        q().buildGroupBy({
          by: ['name'],
          distinctOn: { columns: ['name'], orderBy: { id: 'descending' as 'desc' } },
        }),
      'distinctOn.orderBy',
    );
  });
});

describe('orderBy direction: a warm SQL cache cannot serve a bad direction', () => {
  it('the same interface, good direction first, still refuses the bad one', () => {
    // The direction is embedded byte-for-byte in the orderBy fingerprint, so a
    // bad direction can never collide with a validated cache entry. Compile the
    // good one twice first (warming, and proving the cache is live).
    const qi = q();
    const first = qi.buildFindMany({ orderBy: { id: 'asc' } });
    const second = qi.buildFindMany({ orderBy: { id: 'asc' } });
    assert.equal(first.sql, second.sql);
    assertRefused(() => qi.buildFindMany({ orderBy: { id: 'ascending' as 'asc' } }), 'warm-cache bad direction');
  });
});
