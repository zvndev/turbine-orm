/**
 * turbine-orm — JsonFilter range operators gt/gte/lt/lte (T-2)
 *
 * Numbers cast the `#>>` path extraction to numeric —
 * `("col" #>> $1::text[])::numeric > $2` — while strings compare as text.
 * The `path` param is bound once and its placeholder shared by every clause
 * that extracts it. All range ops require `path`.
 *
 * Also verifies the SQL-cache lockstep: numeric and string comparisons are
 * different SQL shapes (cast vs no cast) so they must not share a cache
 * entry, and a repeated identical query (cache-hit param-collect path) must
 * produce identical SQL + params.
 *
 * Build-only tests (no DB). Run: npx tsx --test src/test/json-filter-range.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

function buildSchema(): SchemaMetadata {
  const tables: Record<string, TableMetadata> = {};
  tables.events = mockTable(
    'events',
    [
      { name: 'id', field: 'id' },
      { name: 'name', field: 'name', pgType: 'text' },
      { name: 'payload', field: 'payload', pgType: 'jsonb' },
    ],
    {
      metrics: {
        type: 'hasMany',
        name: 'metrics',
        from: 'events',
        to: 'metrics',
        foreignKey: 'event_id',
        referenceKey: 'id',
      },
    },
  );
  tables.metrics = mockTable('metrics', [
    { name: 'id', field: 'id' },
    { name: 'event_id', field: 'eventId' },
    { name: 'data', field: 'data', pgType: 'jsonb' },
  ]);
  return { tables, enums: {} };
}

describe('JsonFilter range operators (T-2)', () => {
  it('gt with a number casts the extraction to numeric', () => {
    const q = makeQuery('events', buildSchema());
    const d = q.buildFindMany({ where: { payload: { path: ['score'], gt: 10 } } as never });
    assert.match(d.sql, /\("payload" #>> \$1::text\[\]\)::numeric > \$2/);
    assert.deepEqual(d.params, [['score'], 10]);
  });

  it('gte / lt / lte with numbers compile their comparison operators', () => {
    const q = makeQuery('events', buildSchema());
    for (const [op, sqlOp] of [
      ['gte', '>='],
      ['lt', '<'],
      ['lte', '<='],
    ] as const) {
      const d = q.buildFindMany({ where: { payload: { path: ['score'], [op]: 7 } } as never });
      assert.ok(
        d.sql.includes(`("payload" #>> $1::text[])::numeric ${sqlOp} $2`),
        `${op} → expected "::numeric ${sqlOp} $2" in: ${d.sql}`,
      );
      assert.deepEqual(d.params, [['score'], 7]);
    }
  });

  it('gt with a string compares as text (no cast)', () => {
    const q = makeQuery('events', buildSchema());
    const d = q.buildFindMany({ where: { payload: { path: ['tier'], gt: 'bronze' } } as never });
    assert.match(d.sql, /"payload" #>> \$1::text\[\] > \$2/);
    assert.doesNotMatch(d.sql, /::numeric/);
    assert.deepEqual(d.params, [['tier'], 'bronze']);
  });

  it('multiple range ops share ONE bound path param', () => {
    const q = makeQuery('events', buildSchema());
    const d = q.buildFindMany({ where: { payload: { path: ['score'], gte: 1, lte: 5 } } as never });
    assert.match(d.sql, /\("payload" #>> \$1::text\[\]\)::numeric >= \$2/);
    assert.match(d.sql, /\("payload" #>> \$1::text\[\]\)::numeric <= \$3/);
    assert.deepEqual(d.params, [['score'], 1, 5]);
  });

  it('range op combines with path+equals, still one path param', () => {
    const q = makeQuery('events', buildSchema());
    const d = q.buildFindMany({
      where: { payload: { path: ['score'], equals: '3', gt: 1 } } as never,
    });
    assert.match(d.sql, /"payload" #>> \$1::text\[\] = \$2/);
    assert.match(d.sql, /\("payload" #>> \$1::text\[\]\)::numeric > \$3/);
    assert.deepEqual(d.params, [['score'], '3', 1]);
  });

  it('range op without path throws a clear ValidationError', () => {
    const q = makeQuery('events', buildSchema());
    assert.throws(
      () => q.buildFindMany({ where: { payload: { hasKey: 'score', gt: 5 } } as never }),
      (err: unknown) => err instanceof ValidationError && /requires a `path`/.test((err as Error).message),
    );
  });

  it('range op with a non number/string value throws', () => {
    const q = makeQuery('events', buildSchema());
    assert.throws(
      () => q.buildFindMany({ where: { payload: { path: ['flag'], gt: true } } as never }),
      (err: unknown) => err instanceof ValidationError && /requires a number or string/.test((err as Error).message),
    );
  });

  it('range op with a non-finite number throws', () => {
    const q = makeQuery('events', buildSchema());
    assert.throws(
      () => q.buildFindMany({ where: { payload: { path: ['score'], gt: Number.NaN } } as never }),
      (err: unknown) => err instanceof ValidationError && /finite number/.test((err as Error).message),
    );
  });

  it('top-level AND combinator with a range op compiles', () => {
    const q = makeQuery('events', buildSchema());
    const d = q.buildFindMany({
      where: { AND: [{ payload: { path: ['score'], gt: 10 } }, { name: 'launch' }] } as never,
    });
    assert.match(d.sql, /\("payload" #>> \$1::text\[\]\)::numeric > \$2/);
    assert.match(d.sql, /"name" = \$3/);
    assert.deepEqual(d.params, [['score'], 10, 'launch']);
  });

  it('range op inside a relation some filter compiles (T-1 + T-2)', () => {
    const q = makeQuery('events', buildSchema());
    const d = q.buildFindMany({
      where: { metrics: { some: { data: { path: ['p95'], lt: 250 } } } } as never,
    });
    assert.match(d.sql, /EXISTS \(SELECT 1 FROM "metrics"/);
    assert.match(d.sql, /\("metrics"\."data" #>> \$1::text\[\]\)::numeric < \$2/);
    assert.deepEqual(d.params, [['p95'], 250]);
  });

  describe('SQL-cache lockstep', () => {
    it('identical range query run twice → identical SQL + params (cache-hit collect)', () => {
      const args = { where: { payload: { path: ['score'], gte: 1, lte: 5 } } } as never;
      const q = makeQuery('events', buildSchema());
      const first = q.buildFindMany(args);
      const second = q.buildFindMany(args);
      assert.equal(second.sql, first.sql);
      assert.deepEqual(second.params, first.params);
    });

    it('numeric vs string comparison values never share a cache entry', () => {
      const q = makeQuery('events', buildSchema());
      const num = q.buildFindMany({ where: { payload: { path: ['v'], gt: 5 } } as never });
      const str = q.buildFindMany({ where: { payload: { path: ['v'], gt: 'a' } } as never });
      assert.notEqual(num.sql, str.sql, 'cast vs no-cast must be distinct SQL');
      assert.match(num.sql, /::numeric/);
      assert.doesNotMatch(str.sql, /::numeric/);
      // And re-running each shape binds correctly off the warmed cache.
      const num2 = q.buildFindMany({ where: { payload: { path: ['v'], gt: 99 } } as never });
      assert.equal(num2.sql, num.sql);
      assert.deepEqual(num2.params, [['v'], 99]);
      const str2 = q.buildFindMany({ where: { payload: { path: ['v'], gt: 'z' } } as never });
      assert.equal(str2.sql, str.sql);
      assert.deepEqual(str2.params, [['v'], 'z']);
    });

    it('relation range filter run twice → identical SQL + params', () => {
      const args = { where: { metrics: { some: { data: { path: ['p95'], lt: 250 } } } } } as never;
      const q = makeQuery('events', buildSchema());
      const first = q.buildFindMany(args);
      const second = q.buildFindMany(args);
      assert.equal(second.sql, first.sql);
      assert.deepEqual(second.params, first.params);
    });
  });
});
