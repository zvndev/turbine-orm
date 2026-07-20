/**
 * turbine-orm: prototype-safe metadata lookups
 *
 * `columnMap` / `relations` are plain objects, so a user-supplied field or
 * relation name that collides with an inherited `Object.prototype` member
 * ("constructor", "toString", "valueOf", "__proto__", "hasOwnProperty", …)
 * used to return a truthy inherited value from a bare `map[key]` lookup. That
 * bypassed the unknown-field validation and surfaced a cryptic `TypeError`
 * (a non-string used as a column name) instead of a clean `ValidationError`.
 *
 * Every user-supplied key lookup now goes through `Object.hasOwn` (via the
 * `ownLookup` helper), so these keys are rejected with the normal
 * unknown-column E003 message — in `where`, `orderBy`, and `select`, and in the
 * nested-write `data` classifier.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TurbineErrorCode, ValidationError } from '../errors.js';
import { extractRelationFields, hasRelationFields } from '../nested-write.js';
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
          { name: 'email', field: 'email', pgType: 'text' },
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

// The inherited-member names that a plain-object lookup would otherwise resolve
// to a truthy value. "__proto__" is exercised via JSON.parse so it becomes a
// real OWN enumerable property (an object literal would set the prototype).
const POLLUTED_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty'];

function assertValidation(err: unknown, needle: string): true {
  assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
  assert.equal((err as ValidationError).code, TurbineErrorCode.VALIDATION);
  assert.ok(
    (err as ValidationError).message.includes(needle),
    `message should mention "${needle}": ${(err as ValidationError).message}`,
  );
  return true;
}

describe('prototype-safe metadata: where', () => {
  for (const key of POLLUTED_KEYS) {
    it(`findMany where: { ${key}: 1 } throws ValidationError, not TypeError`, () => {
      const q = makeQuery('users', schema());
      assert.throws(
        () => q.buildFindMany({ where: { [key]: 1 } } as never),
        (err) => assertValidation(err, `Unknown field "${key}"`),
      );
    });
  }

  it('findMany where with a "__proto__" own key (parsed JSON) throws ValidationError', () => {
    const q = makeQuery('users', schema());
    const where = JSON.parse('{"__proto__": 1}');
    assert.throws(
      () => q.buildFindMany({ where } as never),
      (err) => assertValidation(err, 'Unknown field "__proto__"'),
    );
  });
});

describe('prototype-safe metadata: orderBy', () => {
  for (const key of POLLUTED_KEYS) {
    it(`findMany orderBy: { ${key}: 'asc' } throws ValidationError, not TypeError`, () => {
      const q = makeQuery('users', schema());
      assert.throws(
        () => q.buildFindMany({ orderBy: { [key]: 'asc' } } as never),
        (err) => assertValidation(err, `Unknown field "${key}"`),
      );
    });
  }
});

describe('prototype-safe metadata: select', () => {
  for (const key of POLLUTED_KEYS) {
    it(`findMany select: { ${key}: true } throws ValidationError, not TypeError`, () => {
      const q = makeQuery('users', schema());
      assert.throws(
        () => q.buildFindMany({ select: { [key]: true } } as never),
        (err) => assertValidation(err, `Unknown field "${key}"`),
      );
    });
  }
});

describe('prototype-safe metadata: nested-write data classifier', () => {
  for (const key of POLLUTED_KEYS) {
    it(`extractRelationFields does not treat "${key}" as a relation`, () => {
      const users = schema().tables.users!;
      const data = { email: 'x', [key]: { create: [{}] } };
      const result = extractRelationFields(data, users);
      // The polluted key is a plain scalar field, never a relation op.
      assert.deepStrictEqual(result.relations, {});
      assert.ok(Object.hasOwn(result.scalars, key));
    });

    it(`hasRelationFields returns false for a "${key}" object field`, () => {
      const users = schema().tables.users!;
      assert.ok(!hasRelationFields({ [key]: { create: [{}] } }, users));
    });
  }

  it('a real relation key is still classified as a relation', () => {
    const users = schema().tables.users!;
    const result = extractRelationFields({ email: 'x', posts: { create: [{ title: 'hi' }] } }, users);
    assert.deepStrictEqual(result.relations, { posts: { create: [{ title: 'hi' }] } });
    assert.ok(hasRelationFields({ posts: { create: [{}] } }, users));
  });
});
