/**
 * turbine-orm: `_percentile` over an expression (`of`), build-only.
 *
 * A `_percentile` key that names no field takes `of`, an expression built with
 * `expr`, and the result is read back under that key. The key never reaches
 * the SQL (the alias is `_percentile_of_<n>`), bound values are numbers cast
 * by their own class, and every refusal happens before any SQL runs. The live
 * parity check against hand-written SQL is
 * percentile-expression-pg.integration.test.ts.
 *
 * Run: npx tsx --test src/test/percentile-expression.test.ts
 */

// biome-ignore-all lint/suspicious/noThenProperty: expr.case arms are { when, then }, the SQL CASE spelling; never thenable

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Dialect } from '../dialect.js';
import { UnsupportedFeatureError, ValidationError } from '../errors.js';
import { col, expr, UNSAFE } from '../index.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import type { AggregateArgs, GroupByArgs, QueryInterface } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { sqliteDialect } from '../sqlite.js';
import { makeQuery, mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  const table = mockTable(
    'jobs',
    [
      { name: 'id', field: 'id', pgType: 'int4' },
      { name: 'kind', field: 'kind', pgType: 'text' },
      { name: 'requested_at', field: 'requestedAt', pgType: 'timestamptz' },
      { name: 'ready_at', field: 'readyAt', pgType: 'timestamptz' },
      { name: 'queued_at', field: 'queuedAt', pgType: 'timestamp' },
      { name: 'started_at', field: 'startedAt', pgType: 'timestamp' },
      { name: 'due_on', field: 'dueOn', pgType: 'date' },
      { name: 'cost', field: 'cost', pgType: 'numeric' },
      { name: 'tries', field: 'tries', pgType: 'int4' },
      { name: 'of_0', field: 'of_0', pgType: 'int4' },
      { name: 'salary', field: 'salary', pgType: 'int4' },
    ],
    {},
    ['id'],
  );
  const salary = table.columns.find((c) => c.name === 'salary');
  if (salary) (salary as { pii?: boolean }).pii = true;
  return { enums: {}, tables: { jobs: table } };
}

const q = (dialect?: Dialect) => makeQuery('jobs', schema(), dialect ? { dialect } : undefined);

const WAIT = expr.secondsBetween(col('requestedAt'), col('readyAt'));

/** The build of one aggregate, untyped, so refusals can be written as data. */
function aggregate(args: Record<string, unknown>, dialect?: Dialect) {
  return q(dialect).buildAggregate(args as never);
}

function refused(pattern: RegExp) {
  return (e: Error) => e instanceof ValidationError && pattern.test(e.message);
}

describe('_percentile over an expression: the statement', () => {
  it('orders by the expression as float8, under an alias the caller does not write', () => {
    const { sql, params } = aggregate({ _percentile: { 'wa"it': { of: WAIT, p: [0.5, 0.95] } } });
    assert.equal(
      sql,
      'SELECT percentile_cont($1::float8[]) WITHIN GROUP (ORDER BY (EXTRACT(EPOCH FROM ("ready_at" - ' +
        '"requested_at")))::float8) AS "_percentile_of_0" FROM "jobs"',
    );
    assert.deepEqual(params, [[0.5, 0.95]]);
    assert.doesNotMatch(sql, /wa"?"?it/, 'the result name never reaches the SQL');
  });

  it('casts a bound integer as int8 and a fraction as numeric, and disc uses percentile_disc', () => {
    const { sql, params } = aggregate({
      _percentile: { ms: { of: expr.add(expr.mul(WAIT, 1000), 0.5), p: 0.9, method: 'disc' } },
    });
    assert.match(sql, /percentile_disc\(\$3::float8\)/);
    assert.match(
      sql,
      /\(\(\(EXTRACT\(EPOCH FROM \("ready_at" - "requested_at"\)\) \* \$1::int8\) \+ \$2::numeric\)\)::float8/,
    );
    assert.deepEqual(params, [1000, 0.5, 0.9]);
  });

  it('keeps a column percentile beside an expression one, and a column named of_0 keeps its alias', () => {
    const { sql } = aggregate({
      _percentile: { x: { of: expr.sub(col('tries'), 1), p: 0.5 }, of_0: { p: 0.5 } },
    });
    assert.match(sql, /AS "_percentile_of_1"/);
    assert.match(sql, /ORDER BY "of_0"\) AS "_percentile_of_0"/);
  });

  it('compiles a case arm through the where compiler, and the statement is unnamed', () => {
    const casePct = aggregate({
      _percentile: { c: { of: expr.case([{ when: { tries: { gt: 2 } }, then: col('cost') }], 0), p: 0.5 } },
    });
    assert.match(casePct.sql, /CASE WHEN "tries" > \$1 THEN "cost" ELSE \$2::int8 END/);
    assert.deepEqual(casePct.params, [2, 0, 0.5]);
    assert.ok(!casePct.preparedName, 'the arm count is written into the text, so no name');
    const plain = aggregate({ _percentile: { w: { of: WAIT, p: 0.5 } } });
    assert.ok(plain.preparedName, 'a fixed shape keeps its name');
  });

  it('works in groupBy, keyed by the caller name in each group', () => {
    const built = q().buildGroupBy({ by: ['kind'], _percentile: { wait: { of: WAIT, p: 0.5 } } } as never);
    assert.match(built.sql, /^SELECT "kind", COUNT\(\*\)::int AS _count, percentile_cont/);
    const [row] = built.transform({ rows: [{ kind: 'a', _count: 3, _percentile_of_0: 1.25 }] } as never) as Array<
      Record<string, unknown>
    >;
    assert.deepEqual(row?._percentile, { wait: 1.25 });
  });

  it('skips a groupBy key that holds the alias it would have taken', () => {
    const table = mockTable(
      'jobs',
      [
        { name: 'id', field: 'id', pgType: 'int4' },
        { name: 'requested_at', field: 'requestedAt', pgType: 'timestamptz' },
        { name: 'ready_at', field: 'readyAt', pgType: 'timestamptz' },
        { name: '_percentile_of_0', field: '_percentile_of_0', pgType: 'text' },
      ],
      {},
      ['id'],
    );
    const built = makeQuery('jobs', { enums: {}, tables: { jobs: table } }).buildGroupBy({
      by: ['_percentile_of_0'],
      _percentile: { wait: { of: WAIT, p: 0.5 } },
    } as never);
    assert.match(built.sql, /AS "_percentile_of_1"/);
    const [row] = built.transform({
      rows: [{ _percentile_of_0: 'g', _count: 2, _percentile_of_1: 3.5 }],
    } as never) as Array<Record<string, unknown>>;
    assert.equal(row?._percentile_of_0, 'g');
    assert.deepEqual(row?._percentile, { wait: 3.5 });
  });

  it('reads float8 text as a number, an array element by element, and null over zero rows', () => {
    const built = aggregate({ _percentile: { a: { of: WAIT, p: 0.5 }, b: { of: WAIT, p: [0.1, 0.9] } } });
    const out = built.transform({ rows: [{ _percentile_of_0: '2.5', _percentile_of_1: ['1', 3] }] } as never) as {
      _percentile: Record<string, unknown>;
    };
    assert.deepEqual(out._percentile, { a: 2.5, b: [1, 3] });
    const none = built.transform({ rows: [{ _percentile_of_0: null, _percentile_of_1: null }] } as never) as {
      _percentile: Record<string, unknown>;
    };
    assert.deepEqual(none._percentile, { a: null, b: null });
  });

  it('accepts two zone-less timestamp columns', () => {
    const { sql } = aggregate({
      _percentile: { q: { of: expr.secondsBetween(col('queuedAt'), col('startedAt')), p: 0.5 } },
    });
    assert.match(sql, /EXTRACT\(EPOCH FROM \("started_at" - "queued_at"\)\)/);
  });
});

describe('_percentile over an expression: refusals', () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['a field key with of', { tries: { of: WAIT, p: 0.5 } }, /"tries" is a field of the table/],
    ['col() alone', { t: { of: col('tries'), p: 0.5 } }, /`of` is col\("tries"\) alone/],
    ['a plain look-alike', { t: { of: { kind: 'sub', args: [1, 2] }, p: 0.5 } }, /plain \{ kind, args \} object/],
    [
      'a string operand',
      { t: { of: expr.coalesce(col('tries'), 'x' as never), p: 0.5 } },
      /binds numbers and bigints only/,
    ],
    ['a text column', { t: { of: expr.coalesce(col('kind'), col('kind')), p: 0.5 } }, /not numeric/],
    ['a NULL expression', { t: { of: expr.coalesce(null, null), p: 0.5 } }, /NULL for every row/],
    [
      'an unknown column',
      { t: { of: expr.sub(col('trys'), 1), p: 0.5 } },
      /col\("trys"\) in aggregate _percentile "t" on "jobs" names no column/,
    ],
    [
      'a date column',
      { t: { of: expr.secondsBetween(col('dueOn'), col('readyAt')), p: 0.5 } },
      /col\("dueOn"\) is a date column/,
    ],
    [
      'mixed zones',
      { t: { of: expr.secondsBetween(col('queuedAt'), col('readyAt')), p: 0.5 } },
      /mixes a timestamptz column/,
    ],
    [
      'now()',
      { t: { of: expr.coalesce(expr.now() as never, 1), p: 0.5 } },
      /expr\.now\(\) in aggregate _percentile "t"/,
    ],
    [
      'excluded()',
      { t: { of: expr.add(expr.excluded('tries') as never, 1), p: 0.5 } },
      /names the incoming row of an upsert/,
    ],
    ['an unknown spec key', { t: { of: WAIT, p: 0.5, off: 1 } }, /unknown key "off"/],
    ['a bad fraction', { t: { of: WAIT, p: 2 } }, /p must be a fraction/],
    ['a misspelled field without of', { trys: { p: 0.5 } }, /trys/],
  ];
  for (const [name, spec, pattern] of cases) {
    it(`refuses ${name}`, () => {
      assert.throws(() => aggregate({ _percentile: spec }), refused(pattern));
    });
  }

  it('refuses secondsBetween with operands that are not col()', () => {
    assert.throws(
      () => expr.secondsBetween({ col: 'requestedAt' } as never, col('readyAt')),
      refused(/plain \{ col: "requestedAt" \} object/),
    );
    assert.throws(() => expr.secondsBetween(col('a'), 5 as never), refused(/operand 2 is 5/));
  });

  it('refuses secondsBetween in update data', () => {
    assert.throws(
      () => q().buildUpdate({ where: { id: 1 }, data: { cost: WAIT } } as never),
      refused(/expr\.secondsBetween\(\) in update data on "jobs\.cost": it is accepted in _percentile's `of`/),
    );
  });

  it('needs includePii for a PII column read as a value, and not for one a case arm only tests', () => {
    const onSalary = { t: { of: expr.mul(col('salary'), 2), p: 0.5 } };
    assert.throws(() => aggregate({ _percentile: onSalary }), refused(/_percentile "t" on column "salary"/));
    assert.doesNotThrow(() => aggregate({ _percentile: onSalary, includePii: UNSAFE }));
    assert.doesNotThrow(() =>
      aggregate({ _percentile: { t: { of: expr.case([{ when: { salary: { gt: 5 } }, then: 1 }], 0), p: 0.5 } } }),
    );
  });

  it('is E017 off PostgreSQL, as a column percentile is', () => {
    for (const dialect of [sqliteDialect, mysqlDialect, mssqlDialect]) {
      assert.throws(
        () => aggregate({ _percentile: { t: { of: WAIT, p: 0.5 } } }, dialect),
        (e: Error) => e instanceof UnsupportedFeatureError,
        dialect.name,
      );
    }
  });
});

/** Compile-time only: result types, and a misspelled field is a type error. Never called. */
export async function typeChecks(
  t: QueryInterface<{ id: number; tries: number; requestedAt: Date; readyAt: Date }>,
): Promise<void> {
  const s = await t.aggregate({
    _percentile: { tries: { p: [0.5, 0.9] }, wait: { of: WAIT, p: 0.95 }, waits: { of: WAIT, p: [0.5, 0.9] } },
  });
  const a: number[] | null = s._percentile.tries;
  const b: number | null = s._percentile.wait;
  const c: number[] | null = s._percentile.waits;
  const g = await t.groupBy({ by: ['tries'], _percentile: { wait: { of: WAIT, p: 0.5, method: 'disc' } } });
  const d: number | null = g[0]!._percentile.wait;
  // @ts-expect-error a key that names no field needs `of`
  await t.aggregate({ _percentile: { trys: { p: 0.5 } } });
  // @ts-expect-error a field key takes no `of`
  await t.aggregate({ _percentile: { tries: { of: WAIT, p: 0.5 } } });
  // @ts-expect-error `of` is an expression, not a column reference
  await t.aggregate({ _percentile: { x: { of: col('tries'), p: 0.5 } } });
  // @ts-expect-error the misspelling is refused by groupBy and both build methods too
  t.buildAggregate({ _percentile: { trys: { p: 0.5 } } });
  // Wrappers generic over their args compile, as they did before `of` existed.
  type Job = { id: number; tries: number; requestedAt: Date; readyAt: Date };
  const agg = <A extends AggregateArgs<Job>>(q: QueryInterface<Job>, args: A) => q.aggregate(args);
  const grp = <A extends GroupByArgs<Job>>(q: QueryInterface<Job>, args: A) => q.groupBy(args);
  const bagg = <A extends AggregateArgs<Job>>(q: QueryInterface<Job>, args: A) => q.buildAggregate(args);
  const bgrp = <A extends GroupByArgs<Job>>(q: QueryInterface<Job>, args: A) => q.buildGroupBy(args);
  const wrapped: number | null = (await agg(t, { _percentile: { tries: { p: 0.5 } } }))._percentile.tries;
  // Args declared ahead of the call take an expression key.
  const declared: AggregateArgs<Job> = { _percentile: { wait: { of: WAIT, p: 0.5 } } };
  await t.aggregate(declared);
  // An untyped table takes `of` under any key.
  const untyped = await (null as unknown as QueryInterface<Record<string, unknown>>).aggregate({
    _percentile: { wait: { of: WAIT, p: 0.5 } },
  });
  // And wrappers generic over the row type.
  const anyRow = <R extends object>(q: QueryInterface<R>, args: AggregateArgs<R>) => q.aggregate(args);
  const anyRowGroup = <R extends object>(q: QueryInterface<R>, args: GroupByArgs<R>) => q.groupBy(args);
  void [a, b, c, d, grp, bagg, bgrp, wrapped, untyped, anyRow, anyRowGroup];
}
