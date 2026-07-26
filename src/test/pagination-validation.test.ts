/**
 * turbine-orm: LIMIT / OFFSET argument validation
 *
 * `Number(value)` on a non-numeric pagination argument yields NaN, which binds
 * as SQL NULL, and Postgres reads `LIMIT NULL` as "no limit at all". So
 * `findMany({ limit: '5; DROP TABLE users' })` used to compile to `LIMIT $1`
 * with `[null]`: a full-table read, silently. `skip` behaved the same way (the
 * OFFSET quietly disappeared). Both now throw ValidationError (E003).
 *
 * Numeric strings ('5') must keep coercing, and `0` must keep meaning zero.
 *
 * Run: npx tsx --test src/test/pagination-validation.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TurbineErrorCode, ValidationError } from '../errors.js';
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
        { name: 'title', field: 'title', pgType: 'text' },
        { name: 'user_id', field: 'userId' },
      ]),
    },
  };
}

function assertPaginationError(err: unknown, needle: string): true {
  assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
  assert.equal(err.code, TurbineErrorCode.VALIDATION);
  assert.match(err.message, /must be a non-negative integer/);
  // Message shape matches the rest of query/: `[turbine]` prefix + the table.
  assert.ok(err.message.includes('[turbine] '), `message should carry the [turbine] prefix: ${err.message}`);
  assert.ok(err.message.includes('on "users"'), `message should name the table: ${err.message}`);
  assert.ok(err.message.includes(needle), `message should name "${needle}": ${err.message}`);
  return true;
}

const BAD_VALUES: [label: string, value: unknown][] = [
  ['non-numeric string', '5; DROP TABLE users'],
  ['NaN', Number.NaN],
  ['negative', -1],
  ['fractional', 2.5],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['object', {}],
];

// Note: `null` is deliberately NOT rejected. It coerces to 0, which is a valid
// non-negative integer and has always compiled to `LIMIT 0` / `OFFSET 0`;
// tightening that would change behavior for currently-valid queries.

describe('pagination validation: limit', () => {
  for (const [label, value] of BAD_VALUES) {
    it(`rejects a ${label} limit`, () => {
      const q = makeQuery('users', schema());
      assert.throws(
        () => q.buildFindMany({ limit: value } as never),
        (err) => assertPaginationError(err, 'limit'),
      );
    });
  }

  it('accepts a numeric string', () => {
    const q = makeQuery('users', schema());
    const built = q.buildFindMany({ limit: '5' } as never);
    assert.match(built.sql, /LIMIT \$1/);
    assert.deepEqual(built.params, [5]);
  });

  it('accepts 0', () => {
    const q = makeQuery('users', schema());
    const built = q.buildFindMany({ limit: 0 } as never);
    assert.match(built.sql, /LIMIT \$1/);
    assert.deepEqual(built.params, [0]);
  });

  it('throws on a cache HIT too (a warmed template must not bind NaN)', () => {
    const q = makeQuery('users', schema());
    // Warm the template with a valid value: same fingerprint, same SQL.
    q.buildFindMany({ limit: 5 } as never);
    assert.throws(
      () => q.buildFindMany({ limit: 'nope' } as never),
      (err) => assertPaginationError(err, 'limit'),
    );
  });
});

describe('pagination validation: offset', () => {
  for (const [label, value] of BAD_VALUES) {
    it(`rejects a ${label} offset`, () => {
      const q = makeQuery('users', schema());
      assert.throws(
        () => q.buildFindMany({ offset: value } as never),
        (err) => assertPaginationError(err, 'skip/offset'),
      );
    });
  }

  it('accepts a numeric string offset', () => {
    const q = makeQuery('users', schema());
    const built = q.buildFindMany({ limit: 10, offset: '3' } as never);
    assert.deepEqual(built.params, [10, 3]);
  });
});

describe('pagination validation: relation limit and groupBy', () => {
  it('rejects a bad relation limit', () => {
    const q = makeQuery('users', schema());
    assert.throws(
      () => q.buildFindMany({ limit: 5, with: { posts: { limit: 'lots' } } } as never),
      (err) => assertPaginationError(err, 'relation limit'),
    );
  });

  it('accepts a numeric-string relation limit', () => {
    const q = makeQuery('users', schema());
    const built = q.buildFindMany({ limit: 5, with: { posts: { limit: '2' } } } as never);
    assert.ok(built.params.includes(2));
  });

  it('rejects a bad groupBy limit', () => {
    const q = makeQuery('users', schema());
    assert.throws(
      () => q.buildGroupBy({ by: ['name'], limit: Number.NaN } as never),
      (err) => assertPaginationError(err, 'limit'),
    );
  });
});
