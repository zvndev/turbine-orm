/**
 * turbine-orm: misspelled atomic update operators
 *
 * `update({ data: { name: { bogus: 'x' } } })` used to fall through to the
 * plain-value path and emit `SET "name" = $1` with the param `{"bogus":"x"}`,
 * writing JSON text into a scalar column. A single-key object on a non-JSON
 * column can only be a typo'd operator, so it now throws E003.
 *
 * A json/jsonb column keeps taking arbitrary objects unchanged.
 *
 * Run: npx tsx --test src/test/update-operator-unknown.test.ts
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
      users: mockTable('users', [
        { name: 'id', field: 'id' },
        { name: 'name', field: 'name', pgType: 'text' },
        { name: 'views', field: 'views', pgType: 'int8' },
        { name: 'meta', field: 'meta', pgType: 'jsonb' },
        { name: 'settings', field: 'settings', pgType: 'json' },
      ]),
    },
  };
}

function assertUnknownOperator(err: unknown, needle: string): true {
  assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
  assert.equal(err.code, TurbineErrorCode.VALIDATION);
  assert.match(err.message, /Unknown update operator/);
  assert.ok(err.message.includes(needle), `message should mention "${needle}": ${err.message}`);
  return true;
}

describe('update: unknown atomic operator on a scalar column', () => {
  it('throws instead of writing the object as JSON', () => {
    const q = makeQuery('users', schema());
    assert.throws(
      () => q.buildUpdate({ where: { id: 1 }, data: { name: { bogus: 'x' } } } as never),
      (err) => assertUnknownOperator(err, 'users.name'),
    );
  });

  it('names the offending key', () => {
    const q = makeQuery('users', schema());
    assert.throws(
      () => q.buildUpdate({ where: { id: 1 }, data: { views: { incremnt: 1 } } } as never),
      (err) => assertUnknownOperator(err, '"incremnt"'),
    );
  });

  it('applies to updateMany too', () => {
    const q = makeQuery('users', schema());
    assert.throws(
      () => q.buildUpdateMany({ where: { id: 1 }, data: { name: { bogus: 'x' } } } as never),
      (err) => assertUnknownOperator(err, 'users.name'),
    );
  });

  it('throws on a cache HIT too (the SET fingerprint cannot tell the shapes apart)', () => {
    const q = makeQuery('users', schema());
    q.buildUpdate({ where: { id: 1 }, data: { name: 'Alice' } } as never);
    assert.throws(
      () => q.buildUpdate({ where: { id: 1 }, data: { name: { bogus: 'x' } } } as never),
      (err) => assertUnknownOperator(err, 'users.name'),
    );
  });
});

describe('update: shapes that must keep working', () => {
  it('an arbitrary object on a jsonb column is still written as JSON', () => {
    const q = makeQuery('users', schema());
    const payload = { bogus: 'x' };
    const built = q.buildUpdate({ where: { id: 1 }, data: { meta: payload } } as never);
    assert.match(built.sql, /SET "meta" = \$1/);
    assert.deepEqual(built.params[0], payload);
  });

  it('an arbitrary object on a json column is still written as JSON', () => {
    const q = makeQuery('users', schema());
    const built = q.buildUpdate({ where: { id: 1 }, data: { settings: { theme: 'dark' } } } as never);
    assert.deepEqual(built.params[0], { theme: 'dark' });
  });

  it('a multi-key object on a scalar column is untouched (never operator-shaped)', () => {
    const q = makeQuery('users', schema());
    const built = q.buildUpdate({ where: { id: 1 }, data: { name: { a: 1, b: 2 } } } as never);
    assert.deepEqual(built.params[0], { a: 1, b: 2 });
  });

  it('the real operators still compile', () => {
    const q = makeQuery('users', schema());
    const inc = q.buildUpdate({ where: { id: 1 }, data: { views: { increment: 2 } } } as never);
    assert.match(inc.sql, /SET "views" = "views" \+ \$1/);
    const set = q.buildUpdate({ where: { id: 1 }, data: { name: { set: 'Bob' } } } as never);
    assert.match(set.sql, /SET "name" = \$1/);
    assert.equal(set.params[0], 'Bob');
  });

  it('Date, Buffer and array values still bind plainly', () => {
    const q = makeQuery('users', schema());
    const d = new Date('2020-01-01T00:00:00Z');
    assert.equal(q.buildUpdate({ where: { id: 1 }, data: { name: d } } as never).params[0], d);
    const buf = Buffer.from('x');
    assert.equal(q.buildUpdate({ where: { id: 1 }, data: { name: buf } } as never).params[0], buf);
    assert.deepEqual(q.buildUpdate({ where: { id: 1 }, data: { name: [1] } } as never).params[0], [1]);
  });
});
