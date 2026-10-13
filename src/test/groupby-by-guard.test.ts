/**
 * turbine-orm: groupBy refuses a `by` it cannot group by, before reading it
 *
 * Before the guard, each of these reached the builder and failed somewhere
 * else:
 *
 *   by missing / {}     TypeError "args.by is not iterable"
 *   by: 'name'          E003 "Unknown field \"n\"" (the string was iterated)
 *   by: []              `GROUP BY ` with nothing after it, sent to the server
 *   by: [null]          TypeError "Cannot read properties of null"
 *
 * Each is now a ValidationError (E003) naming `by`, raised before any SQL is
 * built.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import type { SchemaMetadata } from '../schema.js';
import { sqliteDialect } from '../sqlite.js';
import { makeQuery, mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  const users = mockTable('users', [
    { name: 'id', field: 'id' },
    { name: 'name', field: 'name', pgType: 'text' },
    { name: 'created_at', field: 'createdAt', pgType: 'timestamptz' },
  ]);
  return { enums: {}, tables: { users } };
}

// biome-ignore lint/suspicious/noExplicitAny: the point is to pass shapes the types forbid
type AnyArgs = any;

function buildGroupBy(args: AnyArgs, dialect?: typeof sqliteDialect) {
  const q = makeQuery('users', schema(), dialect ? { dialect } : undefined);
  return q.buildGroupBy(args);
}

function refused(args: AnyArgs, pattern: RegExp): void {
  assert.throws(
    () => buildGroupBy(args),
    (err: unknown) => {
      assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
      assert.match(err.message, pattern);
      return true;
    },
  );
}

describe('groupBy `by` guard', () => {
  it('refuses a missing `by`', () => {
    refused({ _count: true }, /requires `by`, an array of field names; got undefined/);
  });

  it('refuses a string `by` and shows it wrapped in an array', () => {
    refused({ by: 'name', _count: true }, /for example `by: \["name"\]`; got a string/);
  });

  it('refuses an object `by`', () => {
    refused({ by: { field: 'name' }, _count: true }, /requires `by`, an array of field names; got an object/);
  });

  it('refuses an empty `by` and points at aggregate()', () => {
    refused({ by: [], _count: true }, /at least one `by` key\. To aggregate every row as one group, use aggregate\(\)/);
  });

  it('refuses a null, number or nested-array entry', () => {
    refused({ by: [null], _count: true }, /takes field names and \{ field, path \} JSON keys; got null/);
    refused({ by: ['name', 123], _count: true }, /got a number/);
    refused({ by: [['name']], _count: true }, /got an array/);
  });

  it('still builds a valid `by`, in both spellings and with a JSON key shape left to its own check', () => {
    assert.match(buildGroupBy({ by: ['name'], _count: true }).sql, /GROUP BY "name"$/);
    assert.match(buildGroupBy({ by: ['created_at'], _count: true }).sql, /GROUP BY "created_at"$/);
    // An object entry passes this guard and is validated as a JSON key by the builder.
    assert.throws(() => buildGroupBy({ by: [{ field: 'name' }], _count: true }), ValidationError);
  });

  it('applies on a non-Postgres dialect too', () => {
    assert.throws(() => buildGroupBy({ by: [], _count: true }, sqliteDialect), ValidationError);
  });
});
