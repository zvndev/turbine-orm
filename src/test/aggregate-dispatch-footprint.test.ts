import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { postgresDialect } from '../dialect.js';
import { buildGroupBy } from '../query/aggregates.js';
import type { GroupByArgs } from '../query/types.js';
import type { BuilderCtx } from '../query/where.js';
import { makeQuery, mockTable } from './helpers.js';

function fixture(events: string[]) {
  const schema = {
    enums: {},
    tables: {
      readings: mockTable('readings', [
        { name: 'category', field: 'category', pgType: 'text' },
        { name: 'amount', field: 'amount', pgType: 'int4' },
        { name: 'payload', field: 'payload', pgType: 'jsonb' },
      ]),
    },
  };
  const query = makeQuery('readings', schema, {
    dialect: {
      ...postgresDialect,
      averageArgument(ref) {
        events.push(`average ${ref}`);
        return ref;
      },
    },
  });
  return (query as unknown as { ctx: BuilderCtx }).ctx;
}

describe('groupBy aggregate dispatch contracts', () => {
  it('finishes each selection before reading the next and keeps mixed SQL targets in order', () => {
    const events: string[] = [];
    const ctx = fixture(events);
    const args: Record<string, unknown> = { by: ['category'] };
    for (const key of ['_sum', '_avg', '_min', '_max']) {
      Object.defineProperty(args, key, {
        get() {
          events.push(key);
          return {
            get amount() {
              events.push(`${key}.amount`);
              return true;
            },
            metric: { field: 'payload', path: [key] },
          };
        },
      });
    }
    const deferred = buildGroupBy(ctx, args as unknown as GroupByArgs<Record<string, unknown>>);
    assert.deepEqual(events, [
      '_sum',
      '_sum.amount',
      '_avg',
      '_avg.amount',
      'average "amount"',
      '_min',
      '_min.amount',
      '_max',
      '_max.amount',
    ]);
    assert.deepEqual(deferred.params, [['_sum'], ['_avg'], ['_min'], ['_max']]);
    assert.equal(
      deferred.sql,
      'SELECT "category", COUNT(*)::int AS _count, SUM("amount") AS "_sum_amount", ' +
        'SUM(("payload" #>> $1::text[])::numeric) AS "_sum_metric", ' +
        'AVG("amount")::float AS "_avg_amount", ' +
        'AVG(("payload" #>> $2::text[])::numeric)::float AS "_avg_metric", ' +
        'MIN("amount") AS "_min_amount", MIN("payload" #>> $3::text[]) AS "_min_metric", ' +
        'MAX("amount") AS "_max_amount", MAX("payload" #>> $4::text[]) AS "_max_metric" ' +
        'FROM "readings" GROUP BY "category"',
    );
  });

  it('retains the exact selection error and stops before later argument getters', () => {
    const events: string[] = [];
    const sentinel = new Error('selection getter');
    const args = {
      by: ['category'],
      get _sum() {
        events.push('_sum');
        return {
          get amount(): boolean {
            events.push('amount');
            throw sentinel;
          },
        };
      },
      get _avg() {
        return assert.fail('later selection must not be read');
      },
    };
    assert.throws(
      () => buildGroupBy(fixture(events), args as unknown as GroupByArgs<Record<string, unknown>>),
      (error) => error === sentinel,
    );
    assert.deepEqual(events, ['_sum', 'amount']);
  });
});
