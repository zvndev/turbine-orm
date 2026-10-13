/**
 * `_percentile` on aggregate and groupBy, build side, no database.
 *
 * - The SQL: `percentile_cont` / `percentile_disc` with the fractions bound
 *   as `float8` / `float8[]`, so the text depends on neither the values nor
 *   how many there are.
 * - Every refusal: E017 on each engine without the aggregate (PowDB too), E003
 *   for a malformed spec, `cont` on a date/time column, a JSON-path target, a
 *   column named twice, ordering or filtering groups by it, and a PII column
 *   without `includePii: UNSAFE`.
 * - The reader: values come back the way the column reads, element by
 *   element in the array form.
 *
 * Run: npx tsx --test src/test/wave-c-percentile.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Dialect } from '../dialect.js';
import { UnsupportedFeatureError, ValidationError } from '../errors.js';
import { UNSAFE } from '../index.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import type { PowdbPool } from '../powdb.js';
import { PowqlInterface } from '../powql.js';
import type { QueryInterfaceOptions } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { sqliteDialect } from '../sqlite.js';
import { makeQuery, mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  const requests = mockTable('requests', [
    { name: 'id', field: 'id' },
    { name: 'route', field: 'route', pgType: 'text' },
    { name: 'latency_ms', field: 'latencyMs', pgType: 'float8' },
    { name: 'status_code', field: 'statusCode', pgType: 'int4' },
    { name: 'bytes', field: 'bytes', pgType: 'int8' },
    { name: 'cost', field: 'cost', pgType: 'numeric' },
    { name: 'created_at', field: 'createdAt', pgType: 'timestamptz' },
    { name: 'day', field: 'day', pgType: 'date' },
    { name: 'email', field: 'email', pgType: 'text', pii: true },
    { name: 'meta', field: 'meta', pgType: 'jsonb' },
    // A column whose name is another output's alias, for the collision check.
    { name: '_percentile_latency_ms', field: 'oddName', pgType: 'float8' },
  ]);
  requests.dateColumns = new Set(['created_at', 'day']);
  return { enums: {}, tables: { requests } };
}

type Built = { sql: string; params: unknown[]; transform(result: { rows: unknown[] }): unknown };
type Q = { buildAggregate(args: unknown): Built; buildGroupBy(args: unknown): Built };

function q(options: QueryInterfaceOptions = {}): Q {
  return makeQuery('requests', schema(), options) as unknown as Q;
}

describe('_percentile: SQL', () => {
  it('aggregate: cont and disc, scalar and array fractions, bound as float8 and float8[]', () => {
    const built = q().buildAggregate({
      where: { route: '/a' },
      _percentile: { latencyMs: { p: [0.5, 0.95, 0.99] }, statusCode: { p: 0.5, method: 'disc' } },
    });
    assert.equal(
      built.sql,
      'SELECT percentile_cont($2::float8[]) WITHIN GROUP (ORDER BY "latency_ms") AS "_percentile_latency_ms", ' +
        'percentile_disc($3::float8) WITHIN GROUP (ORDER BY "status_code") AS "_percentile_status_code" ' +
        'FROM "requests" WHERE "route" = $1',
    );
    assert.deepEqual(built.params, ['/a', [0.5, 0.95, 0.99], 0.5]);
  });

  it('the text does not depend on the fractions or their count', () => {
    const a = q().buildAggregate({ _percentile: { latencyMs: { p: [0.5] } } });
    const b = q().buildAggregate({ _percentile: { latencyMs: { p: [0.1, 0.2, 0.3, 0.4] } } });
    assert.equal(a.sql, b.sql);
  });

  it('the other aggregates are unchanged beside it, and it replaces the default count', () => {
    const built = q().buildAggregate({
      _count: true,
      _max: { latencyMs: true },
      _percentile: { latencyMs: { p: 0.5 } },
    });
    assert.match(
      built.sql,
      /^SELECT .*COUNT\(\*\).* AS _count, MAX\("latency_ms"\) AS "_max_latency_ms", percentile_cont/,
    );
    assert.doesNotMatch(q().buildAggregate({ _percentile: { latencyMs: { p: 0.5 } } }).sql, /COUNT/);
  });

  it('disc over numeric in the array form is read as text, so the values stay exact', () => {
    const sql = q().buildAggregate({ _percentile: { cost: { p: [0.5, 0.9], method: 'disc' } } }).sql;
    assert.match(
      sql,
      /\(percentile_disc\(\$1::float8\[\]\) WITHIN GROUP \(ORDER BY "cost"\)\)::text\[\] AS "_percentile_cost"/,
    );
    // The scalar form is already exact (numeric arrives as text).
    assert.doesNotMatch(q().buildAggregate({ _percentile: { cost: { p: 0.5, method: 'disc' } } }).sql, /::text/);
  });

  it('disc works on any sortable column, date/time included', () => {
    const sql = q().buildAggregate({
      _percentile: { createdAt: { p: [0, 1], method: 'disc' }, route: { p: 0.5, method: 'disc' } },
    }).sql;
    assert.match(sql, /percentile_disc\(\$1::float8\[\]\) WITHIN GROUP \(ORDER BY "created_at"\)/);
    assert.match(sql, /percentile_disc\(\$2::float8\) WITHIN GROUP \(ORDER BY "route"\)/);
  });

  it('a snake_case column key resolves like every other aggregate key', () => {
    const sql = q().buildAggregate({ _percentile: { latency_ms: { p: 0.5 } } }).sql;
    assert.match(sql, /ORDER BY "latency_ms"\) AS "_percentile_latency_ms"/);
  });

  it('groupBy: one expression per group, fractions after the where params', () => {
    const built = q().buildGroupBy({
      by: ['route'],
      where: { statusCode: 200 },
      _percentile: { latencyMs: { p: 0.95 } },
      orderBy: { route: 'asc' },
    });
    assert.match(
      built.sql,
      /percentile_cont\(\$2::float8\) WITHIN GROUP \(ORDER BY "latency_ms"\) AS "_percentile_latency_ms" FROM "requests" WHERE "status_code" = \$1 GROUP BY "route"/,
    );
    assert.deepEqual(built.params, [200, 0.95]);
  });

  it('groupBy over a distinctOn row source', () => {
    const sql = q().buildGroupBy({
      by: ['route'],
      distinctOn: { columns: ['route', 'statusCode'], orderBy: { id: 'desc' } },
      _percentile: { latencyMs: { p: 0.5 } },
    }).sql;
    assert.match(sql, /percentile_cont\(\$\d+::float8\) WITHIN GROUP \(ORDER BY "latency_ms"\)/);
    assert.match(sql, /DISTINCT ON/);
  });

  it('a global filter is merged into WHERE', () => {
    const sql = q({ globalFilters: { requests: { route: '/a' } } }).buildAggregate({
      _percentile: { latencyMs: { p: 0.5 } },
    }).sql;
    assert.match(sql, /FROM "requests" WHERE "route" = \$1$/);
  });

  it('an empty or all-undefined block asks for nothing, on any engine', () => {
    for (const dialect of [undefined, mysqlDialect]) {
      const opts = dialect ? { dialect } : {};
      assert.equal(q(opts).buildAggregate({ _percentile: {} }).sql, q(opts).buildAggregate({}).sql);
      assert.equal(
        q(opts).buildAggregate({ _percentile: { latencyMs: undefined } }).sql,
        q(opts).buildAggregate({}).sql,
      );
    }
  });
});

describe('_percentile: engines without it (E017)', () => {
  const engines: [string, Dialect, string][] = [
    ['mysql', mysqlDialect, 'MySQL has no percentile_cont/percentile_disc.'],
    ['sqlite', sqliteDialect, 'SQLITE_ENABLE_PERCENTILE'],
    ['mssql', mssqlDialect, 'PERCENTILE_CONT is a window function there'],
  ];
  for (const [name, dialect, hint] of engines) {
    it(name, () => {
      for (const build of [
        () => q({ dialect }).buildAggregate({ _percentile: { latencyMs: { p: 0.5 } } }),
        () => q({ dialect }).buildGroupBy({ by: ['route'], _percentile: { latencyMs: { p: [0.5], method: 'disc' } } }),
      ]) {
        assert.throws(
          build,
          (e: unknown) =>
            e instanceof UnsupportedFeatureError &&
            e.message.includes(`_percentile is unsupported on "${name}"`) &&
            e.message.includes(hint),
        );
      }
    });
  }

  for (const op of ['aggregate', 'groupBy'] as const) {
    it(`powdb ${op}, before any statement`, async () => {
      const sent: string[] = [];
      const pool = {
        async query(powql: string) {
          sent.push(powql);
          return { rows: [], rowCount: 0 };
        },
      } as unknown as PowdbPool;
      const qi = new PowqlInterface(pool, 'requests', schema()) as unknown as Record<
        typeof op,
        (args: unknown) => Promise<unknown>
      >;
      await assert.rejects(
        qi[op]({ by: ['route'], _percentile: { latencyMs: { p: 0.5 } } }),
        (e: unknown) =>
          e instanceof UnsupportedFeatureError && e.message.includes('PowQL has count, sum, avg, min and max only.'),
      );
      assert.deepEqual(sent, []);
    });
  }
});

describe('_percentile: malformed specs are E003', () => {
  const cases: [string, unknown, RegExp][] = [
    ['p above 1', { latencyMs: { p: 1.5 } }, /p must be a fraction from 0 to 1 .* received 1\.5\./],
    ['p below 0', { latencyMs: { p: -0.1 } }, /received -0\.1\./],
    ['NaN', { latencyMs: { p: Number.NaN } }, /received NaN\./],
    ['Infinity', { latencyMs: { p: Number.POSITIVE_INFINITY } }, /received Infinity\./],
    ['a string', { latencyMs: { p: '0.5' } }, /received '0\.5'\./],
    ['a string inside the array', { latencyMs: { p: [0.5, '0.9'] } }, /received '0\.9'\./],
    ['an empty array', { latencyMs: { p: [] } }, /p is an empty array/],
    ['no p', { latencyMs: { method: 'disc' } }, /received undefined\./],
    ['an unknown key', { latencyMs: { p: 0.5, mehtod: 'disc' } }, /unknown key "mehtod"\. Did you mean "method"\?/],
    [
      'an unknown method',
      { latencyMs: { p: 0.5, method: 'linear' } },
      /method must be 'cont' or 'disc', received 'linear'/,
    ],
    ['an entry that is not an object', { latencyMs: true }, /expected \{ p, method\? \}, received true\./],
    ['a JSON-path target', { meta: { field: 'meta', path: ['ms'], p: 0.5 } }, /JSON-path target is not supported/],
    ['the block is not an object', true, /must be an object of field -> \{ p, method\? \}/],
    ['an unknown column', { latncyMs: { p: 0.5 } }, /latncyMs/],
    [
      'cont on a timestamptz column',
      { createdAt: { p: 0.5 } },
      /method 'cont' interpolates .* "created_at" is a date\/time column\. Use method: 'disc'/,
    ],
    ['cont on a date column', { day: { p: [0.5], method: 'cont' } }, /Use method: 'disc'/],
    [
      'one column named twice',
      { latencyMs: { p: 0.5 }, latency_ms: { p: 0.9 } },
      /already named by another _percentile key/,
    ],
  ];
  for (const [label, spec, message] of cases) {
    it(label, () => {
      for (const build of [
        () => q().buildAggregate({ _percentile: spec }),
        () => q().buildGroupBy({ by: ['route'], _percentile: spec }),
      ]) {
        assert.throws(build, (e: unknown) => e instanceof ValidationError && message.test(e.message));
      }
    });
  }

  it('groupBy orderBy and having on _percentile', () => {
    const base = { by: ['route'], _percentile: { latencyMs: { p: 0.5 } } };
    assert.throws(
      () => q().buildGroupBy({ ...base, orderBy: { _percentile: { latencyMs: 'desc' } } }),
      (e: unknown) =>
        e instanceof ValidationError &&
        e.message.includes('ordering or filtering groups by _percentile is not supported yet'),
    );
    assert.throws(
      () => q().buildGroupBy({ ...base, having: { latencyMs: { _percentile: { gt: 100 } } } }),
      (e: unknown) =>
        e instanceof ValidationError &&
        e.message.includes('ordering or filtering groups by _percentile is not supported yet'),
    );
  });

  it('a groupBy output name collision is caught, not silently dropped by the driver', () => {
    assert.throws(
      () => q().buildGroupBy({ by: ['oddName'], _percentile: { latencyMs: { p: 0.5 } } }),
      (e: unknown) =>
        e instanceof ValidationError &&
        e.message.includes(
          'groupBy output name "_percentile_latency_ms" (_percentile of column "latency_ms") collides',
        ),
    );
    assert.doesNotThrow(() =>
      q().buildGroupBy({ by: ['route'], _max: { latencyMs: true }, _percentile: { latencyMs: { p: 0.5 } } }),
    );
  });
});

describe('_percentile: PII', () => {
  for (const method of ['cont', 'disc'] as const) {
    it(`${method} over a PII column needs includePii: UNSAFE`, () => {
      const spec = { email: { p: 0.5, method } };
      // `cont` over text is a server error, but the PII refusal comes first.
      for (const build of [
        () => q().buildAggregate({ _percentile: spec }),
        () => q().buildGroupBy({ by: ['route'], _percentile: spec }),
      ]) {
        assert.throws(
          build,
          (e: unknown) =>
            e instanceof ValidationError && /_percentile/.test(e.message) && /includePii: UNSAFE/.test(e.message),
        );
      }
      assert.doesNotThrow(() => q().buildAggregate({ _percentile: spec, includePii: UNSAFE }));
      assert.doesNotThrow(() => q().buildGroupBy({ by: ['route'], _percentile: spec, includePii: UNSAFE }));
    });
  }

  it('includePii: true is still refused (it is a privilege option)', () => {
    assert.throws(
      () => q().buildAggregate({ _percentile: { email: { p: 0.5, method: 'disc' } }, includePii: true }),
      ValidationError,
    );
  });
});

describe('_percentile: reading the result', () => {
  const read = (spec: unknown, row: Record<string, unknown>, options: QueryInterfaceOptions = {}) =>
    (
      q(options)
        .buildAggregate({ _percentile: spec })
        .transform({ rows: [row] }) as { _percentile: Record<string, unknown> }
    )._percentile;

  it('keys the block by field name and passes numbers through', () => {
    assert.deepEqual(read({ latencyMs: { p: [0.5, 0.9] } }, { _percentile_latency_ms: [12.5, 40] }), {
      latencyMs: [12.5, 40],
    });
    assert.deepEqual(read({ latencyMs: { p: 0.5 } }, { _percentile_latency_ms: 12.5 }), { latencyMs: 12.5 });
  });

  it('null over zero rows, in both forms', () => {
    assert.deepEqual(read({ latencyMs: { p: [0.5, 0.9] } }, { _percentile_latency_ms: null }), { latencyMs: null });
    assert.deepEqual(read({ latencyMs: { p: 0.5 } }, { _percentile_latency_ms: null }), { latencyMs: null });
  });

  it('date/time elements handed back as text are read as dates, element by element', () => {
    const out = read(
      { createdAt: { p: [0, 1], method: 'disc' } },
      { _percentile_created_at: ['2024-01-15 12:00:00+00', '2024-02-01 00:00:00+00'] },
    );
    const values = out.createdAt as unknown[];
    assert.ok(
      values.every((v) => v instanceof Date),
      String(values),
    );
    assert.equal((values[0] as Date).toISOString(), '2024-01-15T12:00:00.000Z');
    // The scalar form reads the same way.
    const scalar = read({ createdAt: { p: 0, method: 'disc' } }, { _percentile_created_at: '2024-01-15 12:00:00+00' });
    assert.ok(scalar.createdAt instanceof Date);
  });

  it("an infinity element follows temporalInfinity: 'null'", () => {
    const out = read(
      { createdAt: { p: [0, 1], method: 'disc' } },
      { _percentile_created_at: [new Date('2024-01-01T00:00:00Z'), Number.POSITIVE_INFINITY] },
      { temporalInfinity: 'null' },
    );
    assert.deepEqual(out.createdAt, [new Date('2024-01-01T00:00:00Z'), null]);
  });

  it('int8 elements the array form delivers as text read like the scalar int8 parser', () => {
    const out = read({ bytes: { p: [0, 1], method: 'disc' } }, { _percentile_bytes: ['2', '9007199254740993'] });
    assert.deepEqual(out.bytes, [2, '9007199254740993']);
  });

  it('numeric stays text', () => {
    assert.deepEqual(read({ cost: { p: [0.5], method: 'disc' } }, { _percentile_cost: ['1.250'] }), {
      cost: ['1.250'],
    });
  });

  it('groupBy puts the block on each group', () => {
    const built = q().buildGroupBy({ by: ['route'], _percentile: { latencyMs: { p: 0.5 } } });
    const rows = built.transform({
      rows: [
        { route: '/a', _count: 2, _percentile_latency_ms: 10 },
        { route: '/b', _count: 1, _percentile_latency_ms: null },
      ],
    }) as Record<string, unknown>[];
    assert.deepEqual(rows, [
      { route: '/a', _count: 2, _percentile: { latencyMs: 10 } },
      { route: '/b', _count: 1, _percentile: { latencyMs: null } },
    ]);
  });
});
