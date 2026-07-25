/**
 * turbine-orm: prototype keys in SQL-generating map lookups
 *
 * Three lookup tables were still read with a bare `map[key]`: the HAVING
 * aggregate-function map, the pgvector metric-operator map, and the per-table
 * relation maps. A user-supplied key naming an inherited Object.prototype
 * member resolved to a truthy builtin, so the guard below it never fired and
 * the builtin's SOURCE TEXT was spliced into the statement:
 *
 *   groupBy({ by: ['role'], having: { id: { constructor: { gt: 1 } } } })
 *   → HAVING function Object() { [native code] }("id") > $1
 *
 * Not injection (the text is a fixed JS builtin, never attacker-controlled),
 * but it produced an opaque database syntax error where a clean E003 / E005
 * belongs. Every one of these lookups now goes through `ownLookup`.
 *
 * Run: npx tsx --test src/test/prototype-lookup-sql.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RelationError, TurbineErrorCode, ValidationError } from '../errors.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

/** Inherited members a bare `map[key]` would resolve to a truthy value. */
const POLLUTED_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty'];

function schema(): SchemaMetadata {
  const users = mockTable(
    'users',
    [
      { name: 'id', field: 'id' },
      { name: 'role', field: 'role', pgType: 'text' },
      { name: 'embedding', field: 'embedding', pgType: 'vector' },
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
  );
  return {
    enums: {},
    tables: {
      users,
      posts: mockTable('posts', [
        { name: 'id', field: 'id' },
        { name: 'title', field: 'title', pgType: 'text' },
        { name: 'user_id', field: 'userId' },
      ]),
    },
  };
}

function assertTyped(err: unknown, kind: 'validation' | 'relation', needle: string): true {
  if (kind === 'validation') {
    assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
    assert.equal(err.code, TurbineErrorCode.VALIDATION);
  } else {
    assert.ok(err instanceof RelationError, `expected RelationError, got ${String(err)}`);
    assert.equal(err.code, TurbineErrorCode.RELATION);
  }
  assert.ok((err as Error).message.includes(needle), `message should mention "${needle}": ${(err as Error).message}`);
  // The JS builtin's source text must never reach the message (or the SQL).
  assert.ok(!/native code/.test((err as Error).message), 'must not leak a builtin function body');
  return true;
}

describe('prototype keys: HAVING aggregate lookup', () => {
  for (const key of POLLUTED_KEYS) {
    it(`having: { id: { ${key}: … } } throws ValidationError`, () => {
      const q = makeQuery('users', schema());
      assert.throws(
        () => q.buildGroupBy({ by: ['role'], having: { id: { [key]: { gt: 1 } } } } as never),
        (err) => assertTyped(err, 'validation', 'Unknown aggregate'),
      );
    });
  }
});

describe('prototype keys: vector metric lookup', () => {
  for (const key of POLLUTED_KEYS) {
    it(`orderBy vector metric "${key}" throws ValidationError`, () => {
      const q = makeQuery('users', schema());
      assert.throws(
        () =>
          q.buildFindMany({
            limit: 5,
            orderBy: { embedding: { distance: { to: [0.1, 0.2], metric: key } } },
          } as never),
        (err) => assertTyped(err, 'validation', 'Unknown vector metric'),
      );
    });
  }
});

describe('prototype keys: relation lookups', () => {
  for (const key of POLLUTED_KEYS) {
    it(`with: { ${key}: true } throws RelationError`, () => {
      const q = makeQuery('users', schema());
      assert.throws(
        () => q.buildFindMany({ limit: 5, with: { [key]: true } } as never),
        (err) => assertTyped(err, 'relation', 'Unknown relation'),
      );
    });

    it(`nested with: { posts: { with: { ${key}: true } } } throws RelationError`, () => {
      const q = makeQuery('users', schema());
      assert.throws(
        () => q.buildFindMany({ limit: 5, with: { posts: { with: { [key]: true } } } } as never),
        (err) => assertTyped(err, 'relation', 'Unknown relation'),
      );
    });
  }
});

describe('prototype keys: real lookups still resolve', () => {
  it('a real relation, aggregate and metric still compile', () => {
    const q = makeQuery('users', schema());
    assert.match(q.buildFindMany({ limit: 5, with: { posts: true } } as never).sql, /json_agg/);
    assert.match(q.buildGroupBy({ by: ['role'], having: { id: { _count: { gt: 1 } } } } as never).sql, /HAVING/);
    const vec = q.buildFindMany({
      limit: 5,
      orderBy: { embedding: { distance: { to: [0.1, 0.2], metric: 'cosine' } } },
    } as never);
    assert.match(vec.sql, /<=>/);
  });
});
