/**
 * turbine-orm: `_min` / `_max` on a temporal column return a Date on every engine
 *
 * Verified on one SQLite table with `at TIMESTAMP`, whose `dateColumns` already
 * contained `at`:
 *
 *   findMany   at    Date     "2024-01-15T12:00:00.000Z"
 *   groupBy    key   Date     "2024-01-15T12:00:00.000Z"
 *   aggregate  _min  string   "2024-01-15 12:00:00"
 *
 * so ONE column disagreed with itself across three read paths, and with the
 * `Date` the generated types promise. The cause is that `_min`/`_max` are
 * assembled from the RAW row (they cannot go through `parseRow`, whose
 * snake→camel mapping would collide with the `_min_` alias), so the coercion
 * `parseRow` applies had to be applied there as well.
 *
 * PostgreSQL was never affected: its driver's OID-keyed parsers hand back a
 * `Date` for `timestamp`/`date` already, which is why this only ever showed on
 * an engine whose driver returns untyped text.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type pg from 'pg';
import type { SchemaMetadata } from '../schema.js';
import { sqliteDialect } from '../sqlite.js';
import { makeQuery, mockColumn, mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  const events = mockTable('events', [
    { name: 'id', field: 'id' },
    { name: 'at', field: 'at', pgType: 'timestamp' },
    { name: 'amount', field: 'amount', pgType: 'int4' },
  ]);
  events.dateColumns = new Set(['at']);
  events.columns = events.columns.map((c) => (c.name === 'at' ? mockColumn('at', 'at', 'timestamp') : c));
  return { enums: {}, tables: { events } };
}

/** A one-row pg.QueryResult carrying whatever the driver would have produced. */
function result(row: Record<string, unknown>): pg.QueryResult {
  return { rows: [row], rowCount: 1, command: 'SELECT', oid: 0, fields: [] } as unknown as pg.QueryResult;
}

describe('aggregate _min / _max temporal coercion', () => {
  it('coerces an offset-less string from an untyped driver to a UTC Date', () => {
    const q = makeQuery('events', schema(), { dialect: sqliteDialect, warnOnUnlimited: false });
    const deferred = q.buildAggregate({ _min: { at: true }, _max: { at: true } } as never);
    const out = deferred.transform(
      result({ _min_at: '2024-01-15 12:00:00', _max_at: '2024-03-02 06:30:00' }),
      // biome-ignore lint/suspicious/noExplicitAny: the transform is typed per-arg
    ) as any;
    assert.ok(out._min.at instanceof Date, `_min should be a Date, got ${typeof out._min.at}`);
    assert.equal(out._min.at.toISOString(), '2024-01-15T12:00:00.000Z');
    assert.equal(out._max.at.toISOString(), '2024-03-02T06:30:00.000Z');
  });

  it('matches what findMany returns for the very same stored value', () => {
    const q = makeQuery('events', schema(), { dialect: sqliteDialect, warnOnUnlimited: false });
    const row = q
      .buildFindMany({} as never)
      // biome-ignore lint/suspicious/noExplicitAny: the transform is typed per-arg
      .transform(result({ id: 1, at: '2024-01-15 12:00:00', amount: 3 })) as any;
    const agg = q
      .buildAggregate({ _min: { at: true } } as never)
      // biome-ignore lint/suspicious/noExplicitAny: the transform is typed per-arg
      .transform(result({ _min_at: '2024-01-15 12:00:00' })) as any;
    assert.equal(agg._min.at.getTime(), row[0].at.getTime());
  });

  it('the groupBy aggregate path coerces identically', () => {
    const q = makeQuery('events', schema(), { dialect: sqliteDialect, warnOnUnlimited: false });
    const out = q
      .buildGroupBy({ by: ['amount'], _max: { at: true } } as never)
      // biome-ignore lint/suspicious/noExplicitAny: the transform is typed per-arg
      .transform(result({ amount: 3, _max_at: '2024-01-15 12:00:00' })) as any;
    assert.ok(out[0]._max.at instanceof Date);
    assert.equal(out[0]._max.at.toISOString(), '2024-01-15T12:00:00.000Z');
  });

  it('honours utcTimestamps: false (local-zone reading, same as parseRow)', () => {
    const q = makeQuery('events', schema(), {
      dialect: sqliteDialect,
      warnOnUnlimited: false,
      utcTimestamps: false,
    });
    const out = q
      .buildAggregate({ _min: { at: true } } as never)
      // biome-ignore lint/suspicious/noExplicitAny: the transform is typed per-arg
      .transform(result({ _min_at: '2024-01-15 12:00:00' })) as any;
    assert.ok(out._min.at instanceof Date);
    assert.equal(out._min.at.getTime(), new Date('2024-01-15 12:00:00').getTime());
  });

  it('leaves a NON-temporal column alone (a numeric _min is still a number)', () => {
    const q = makeQuery('events', schema(), { dialect: sqliteDialect, warnOnUnlimited: false });
    const out = q
      .buildAggregate({ _min: { amount: true } } as never)
      // biome-ignore lint/suspicious/noExplicitAny: the transform is typed per-arg
      .transform(result({ _min_amount: 7 })) as any;
    assert.equal(out._min.amount, 7);
  });

  it('leaves a Date alone (the PostgreSQL case: driver already parsed it)', () => {
    const q = makeQuery('events', schema(), { warnOnUnlimited: false });
    const already = new Date('2024-01-15T12:00:00.000Z');
    const out = q
      .buildAggregate({ _min: { at: true } } as never)
      // biome-ignore lint/suspicious/noExplicitAny: the transform is typed per-arg
      .transform(result({ _min_at: already })) as any;
    assert.equal(out._min.at, already, 'the Date instance must pass through by identity');
  });

  it('leaves NULL and the temporal infinities alone', () => {
    const q = makeQuery('events', schema(), { warnOnUnlimited: false });
    const build = q.buildAggregate({ _min: { at: true }, _max: { at: true } } as never);
    // biome-ignore lint/suspicious/noExplicitAny: the transform is typed per-arg
    const nulls = build.transform(result({ _min_at: null, _max_at: null })) as any;
    assert.equal(nulls._min.at, null);
    const infinities = build.transform(
      result({ _min_at: Number.NEGATIVE_INFINITY, _max_at: 'infinity' }),
      // biome-ignore lint/suspicious/noExplicitAny: the transform is typed per-arg
    ) as any;
    assert.equal(infinities._min.at, Number.NEGATIVE_INFINITY);
    assert.equal(infinities._max.at, Number.POSITIVE_INFINITY);
  });
});
