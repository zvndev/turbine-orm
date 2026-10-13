/**
 * `AND` written as one object keeps its prepared-statement name.
 *
 * A caller-written combinator ARRAY puts one branch per element into the SQL
 * text, so its statement goes unnamed (see `markVariableArity`). `AND: { ... }`
 * has no length: it is one branch whatever the caller sends, so it is a fixed
 * shape and keeps its name, at the top level, inside a relation filter and
 * inside a relation `with` where.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { QueryInterface } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      users: mockTable(
        'users',
        [
          { name: 'id', field: 'id' },
          { name: 'age', field: 'age', pgType: 'int4' },
          { name: 'name', field: 'name', pgType: 'text' },
        ],
        {
          posts: {
            name: 'posts',
            type: 'hasMany',
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

function build(q: QueryInterface<Record<string, unknown>>, args: Record<string, unknown>) {
  return q.buildFindMany(args as never);
}

const named = (name: string | undefined) => typeof name === 'string' && /^t_[0-9a-f]{16}$/.test(name);

describe('prepared statements: AND written as an object is a fixed shape', () => {
  it('a top-level AND object keeps a named statement', () => {
    const q = makeQuery('users', schema());
    const d = build(q, { where: { AND: { age: 1, name: 'a' } } });
    assert.match(d.sql, /"age" = \$1/, 'the AND object is compiled');
    assert.ok(named(d.preparedName), `expected a prepared name, got ${JSON.stringify(d.preparedName)}`);
  });

  it('an AND object inside a relation filter keeps its name', () => {
    const q = makeQuery('users', schema());
    const d = build(q, { where: { posts: { some: { AND: { title: 'a' } } } } });
    assert.match(d.sql, /EXISTS/);
    assert.ok(named(d.preparedName), `got ${JSON.stringify(d.preparedName)}`);
  });

  it('an AND object inside a relation `with` where keeps its name', () => {
    const q = makeQuery('users', schema());
    const d = build(q, { with: { posts: { where: { AND: { title: 'a' } } } } });
    assert.ok(named(d.preparedName), `got ${JSON.stringify(d.preparedName)}`);
  });

  it('the name survives the SQL cache', () => {
    const q = makeQuery('users', schema());
    const cold = build(q, { where: { AND: { age: 1 } } });
    const warm = build(q, { where: { AND: { age: 2 } } });
    assert.equal(cold.sql, warm.sql);
    assert.equal(q.cacheStats().hits, 1, 'expected the second build to hit the cache');
    assert.ok(named(warm.preparedName), `got ${JSON.stringify(warm.preparedName)}`);
  });

  it('arrays stay unnamed: AND array, NOT array, and an OR nested in an AND object', () => {
    const q = makeQuery('users', schema());
    assert.equal(build(q, { where: { AND: [{ age: 1 }, { name: 'a' }] } }).preparedName, '');
    assert.equal(build(q, { where: { NOT: [{ age: 1 }, { name: 'a' }] } }).preparedName, '');
    assert.equal(build(q, { where: { AND: { OR: [{ age: 1 }, { age: 2 }] } } }).preparedName, '');
    assert.equal(build(q, { where: { posts: { some: { AND: [{ title: 'a' }, { title: 'b' }] } } } }).preparedName, '');
  });
});
