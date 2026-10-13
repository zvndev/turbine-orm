/**
 * turbine-orm: a groupBy `having` on `_min` / `_max` of a text column binds its
 * operand as the column's own type
 *
 * `_min` / `_max` return a stored cell, so `having: { token: { _min: { equals: 0 } } }`
 * compares MIN of a text column with 0. MySQL compares a number with text
 * numerically (`'0zz' = 0` is true), so the operand is sent as `'0'`, the same
 * rule the where compiler applies to `where: { token: 0 }`. `_count` / `_sum` /
 * `_avg` are numbers and keep their operands; every other engine is unchanged.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Dialect } from '../dialect.js';
import { mysqlDialect } from '../mysql.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  const tokens = mockTable('tokens', [
    { name: 'id', field: 'id' },
    { name: 'org_id', field: 'orgId', pgType: 'int4' },
    { name: 'token', field: 'token', pgType: 'varchar' },
    { name: 'views', field: 'views', pgType: 'int4' },
  ]);
  return { enums: {}, tables: { tokens } };
}

// biome-ignore lint/suspicious/noExplicitAny: having shapes are checked at runtime here
type AnyArgs = any;

function params(args: AnyArgs, dialect?: Dialect): unknown[] {
  const q = makeQuery('tokens', schema(), dialect ? { dialect } : undefined);
  return q.buildGroupBy(args).params;
}

/** `in` / `notIn` bind a list (on MySQL, a wrapper holding `values`); flatten for comparison. */
function flat(values: unknown[]): unknown[] {
  return values.flatMap((v) => {
    if (Array.isArray(v)) return v;
    const list = (v as { values?: unknown } | null)?.values;
    return Array.isArray(list) ? list : [v];
  });
}

describe('having _min / _max operands bind as the column type', () => {
  it('on MySQL, a number or boolean against MIN / MAX of a text column is sent as text', () => {
    const by = ['orgId'];
    assert.deepEqual(params({ by, having: { token: { _min: 0 } } }, mysqlDialect), ['0']);
    assert.deepEqual(params({ by, having: { token: { _max: { equals: 7, gt: 1n } } } }, mysqlDialect), ['7', '1']);
    assert.deepEqual(params({ by, having: { token: { _min: { not: true } } } }, mysqlDialect), ['1']);
    assert.deepEqual(flat(params({ by, having: { token: { _min: { in: [0, 1], notIn: [false] } } } }, mysqlDialect)), [
      '0',
      '1',
      '0',
    ]);
  });

  it('a string operand, a numeric column and the numeric aggregates keep their values', () => {
    const by = ['orgId'];
    assert.deepEqual(params({ by, having: { token: { _min: 'abc' } } }, mysqlDialect), ['abc']);
    assert.deepEqual(params({ by, having: { views: { _max: 3 } } }, mysqlDialect), [3]);
    assert.deepEqual(params({ by, having: { views: { _sum: { gt: 3 } }, _count: { gte: 2 } } }, mysqlDialect), [3, 2]);
  });

  it('every other engine keeps the operand as given', () => {
    assert.deepEqual(params({ by: ['orgId'], having: { token: { _min: 0 } } }), [0]);
  });
});
