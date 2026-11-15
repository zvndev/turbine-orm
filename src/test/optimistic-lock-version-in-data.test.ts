/**
 * `optimisticLock` writes its own version bump (`"version" = "version" + 1`).
 * When the caller's `data` also writes that column, which is a natural thing to
 * do when porting code that bumped the version by hand, the UPDATE assigns the
 * column twice:
 *
 *   UPDATE "posts" SET "title" = $1, "version" = "version" + $2,
 *     "version" = "version" + 1 WHERE ... AND "version" = $4
 *
 * PostgreSQL rejects that with SQLSTATE 42601 ("multiple assignments to same
 * column"), so the write fails with a raw DatabaseError instead of a typed
 * Turbine error. Either outcome below is acceptable: the column is assigned
 * once, or the call is refused with E003 before any SQL is sent.
 *
 * Fails until fixed (0.93.1 and 0.94.0 both emit the double assignment).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

const schema: SchemaMetadata = {
  enums: {},
  tables: {
    posts: mockTable('posts', [
      { name: 'id', field: 'id', pgType: 'int4' },
      { name: 'title', field: 'title', pgType: 'text' },
      { name: 'version', field: 'version', pgType: 'int4' },
    ]),
  },
};

/** How many times the SET list of an UPDATE assigns `column`. */
function setAssignments(sql: string, column: string): number {
  const set = sql.slice(sql.indexOf(' SET '), sql.indexOf(' WHERE '));
  return set.split(`"${column}" =`).length - 1;
}

describe('optimisticLock with its version column also in data', () => {
  it('control: without the column in data the lock assigns it exactly once', () => {
    const { sql } = makeQuery('posts', schema).buildUpdate({
      where: { id: 21 },
      data: { title: 'edit' },
      optimisticLock: { field: 'version', expected: 2 },
    } as never);
    assert.equal(setAssignments(sql, 'version'), 1, sql);
  });

  const cases: Array<[string, unknown]> = [
    ['an increment', { increment: 1 }],
    ['a plain value', 5],
  ];
  for (const [label, version] of cases) {
    it(`${label}: assigns the version column once, or refuses with E003`, () => {
      const qi = makeQuery('posts', schema);
      let sql: string;
      try {
        sql = qi.buildUpdate({
          where: { id: 21 },
          data: { title: 'edit', version },
          optimisticLock: { field: 'version', expected: 2 },
        } as never).sql;
      } catch (e) {
        assert.ok(e instanceof ValidationError, `expected a ValidationError (E003), got ${String(e)}`);
        return;
      }
      assert.equal(
        setAssignments(sql, 'version'),
        1,
        `the UPDATE assigns "version" more than once, which PostgreSQL rejects with 42601: ${sql}`,
      );
    });
  }
});
