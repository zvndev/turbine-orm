/**
 * turbine-orm: groupBy extensions: JSON-path group keys, JSON-path aggregate
 * targets, and the DISTINCT ON row source.
 *
 *  - B1 group keys: `by: [{ field: 'data', path: ['category'] }]` emits
 *    `("data" #>> $n::text[]) AS "category"` in SELECT and the same expression
 *    in GROUP BY (path bound as one text[] param). Result rows key by alias
 *    (default: last path segment; collisions throw E003).
 *  - B2 aggregate targets: `_sum: { price: { field: 'data', path: ['price'] } }`
 *    emits `SUM(("data" #>> $n::text[])::numeric) AS "_sum_price"`. `_sum`/`_avg`
 *    are always numeric; `_min`/`_max` compare as text unless `type: 'numeric'`.
 *    HAVING keys on the alias and reuses the exact SELECT expression.
 *  - B3 distinctOn (PostgreSQL only): wraps the row source in
 *    `(SELECT DISTINCT ON (cols) * FROM t WHERE … ORDER BY cols, <orderBy>) AS t`
 *    so the groupBy aggregates one representative row per combination.
 *    args.where applies INSIDE the wrapper; other engines throw E017.
 *
 * groupBy builds fresh SQL per call (no SQL cache), so identical args must
 * still produce identical SQL + params on every call.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { describe, it } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { UnsupportedFeatureError, ValidationError } from '../errors.js';
import { introspect } from '../introspect.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import type { PowdbPool } from '../powdb.js';
import { PowqlInterface } from '../powql.js';
import type { SchemaMetadata } from '../schema.js';
import { introspectSqliteDatabase, sqliteDialect, turbineSqlite } from '../sqlite.js';
import { makeQuery, mockTable, skipGate } from './helpers.js';

function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      versions: mockTable('versions', [
        { name: 'id', field: 'id' },
        { name: 'instance_id', field: 'instanceId' },
        { name: 'status', field: 'status', pgType: 'text' },
        { name: 'data', field: 'data', pgType: 'jsonb' },
        { name: 'view_count', field: 'viewCount', pgType: 'int4' },
        { name: 'created_at', field: 'createdAt', pgType: 'timestamptz' },
      ]),
    },
  };
}

// ---------------------------------------------------------------------------
// B1: JSON-path group keys
// ---------------------------------------------------------------------------

describe('groupBy JSON-path group keys', () => {
  it('emits the extraction in SELECT (aliased) and GROUP BY (same $n placeholder)', () => {
    const q = makeQuery('versions', schema());
    const { sql, params } = q.buildGroupBy({
      by: [{ field: 'data', path: ['category'] }],
    } as never);
    assert.ok(sql.includes('SELECT ("data" #>> $1::text[]) AS "category"'), sql);
    assert.ok(sql.includes('GROUP BY "data" #>> $1::text[]'), sql);
    assert.deepEqual(params, [['category']]);
  });

  it('defaults the alias to the last path segment (indexes stringified); explicit alias wins', () => {
    const q = makeQuery('versions', schema());
    const deep = q.buildGroupBy({ by: [{ field: 'data', path: ['meta', 0, 'kind'] }] } as never);
    assert.ok(deep.sql.includes('AS "kind"'), deep.sql);
    assert.deepEqual(deep.params, [['meta', '0', 'kind']]);
    const aliased = q.buildGroupBy({ by: [{ field: 'data', path: ['meta', 'kind'], alias: 'metaKind' }] } as never);
    assert.ok(aliased.sql.includes('AS "metaKind"'), aliased.sql);
  });

  it('mixes plain columns and JSON keys; where params bind before the path', () => {
    const q = makeQuery('versions', schema());
    const { sql, params } = q.buildGroupBy({
      by: ['status', { field: 'data', path: ['category'] }],
      where: { viewCount: { gt: 10 } },
    } as never);
    assert.ok(sql.includes('SELECT "status", ("data" #>> $2::text[]) AS "category"'), sql);
    assert.ok(sql.includes('GROUP BY "status", "data" #>> $2::text[]'), sql);
    assert.deepEqual(params, [10, ['category']]);
  });

  it('identical args build identical SQL + params on every call (groupBy is uncached)', () => {
    const q = makeQuery('versions', schema());
    const args = {
      by: [{ field: 'data', path: ['category'] }],
      where: { status: 'live' },
      _sum: { price: { field: 'data', path: ['price'] } },
    } as never;
    const first = q.buildGroupBy(args);
    const second = q.buildGroupBy(args);
    assert.equal(second.sql, first.sql);
    assert.deepEqual(second.params, first.params);
    assert.deepEqual(first.params, ['live', ['category'], ['price']]);
  });

  it('transform keys group rows by the alias verbatim (no snake→camel mangling)', () => {
    const q = makeQuery('versions', schema());
    const deferred = q.buildGroupBy({ by: [{ field: 'data', path: ['category'] }] } as never);
    const rows = deferred.transform({
      rows: [{ category: 'books', _count: 3 }],
      rowCount: 1,
    } as never);
    assert.deepEqual(rows, [{ category: 'books', _count: 3 }]);
  });

  it('rejects a result-key collision with a clear E003', () => {
    const q = makeQuery('versions', schema());
    assert.throws(
      () =>
        q.buildGroupBy({
          by: [
            { field: 'data', path: ['category'] },
            { field: 'data', path: ['nested', 'category'] },
          ],
        } as never),
      /output name "category" .* collides .* set an explicit `alias`/,
    );
    assert.throws(
      () => q.buildGroupBy({ by: ['status', { field: 'data', path: ['x'], alias: 'status' }] } as never),
      /collides/,
    );
    assert.throws(() => q.buildGroupBy({ by: [{ field: 'data', path: ['x'], alias: '_count' }] } as never), /"_count"/);
  });

  it('collision check runs over EMITTED output column names, not just given keys', () => {
    const q = makeQuery('versions', schema());
    // A JSON alias equal to another group key's snake_case OUTPUT column: both
    // land on "created_at" on the wire; the driver keeps only the last one.
    assert.throws(
      () => q.buildGroupBy({ by: ['createdAt', { field: 'data', path: ['created_at'] }] } as never),
      /output name "created_at" .* collides/,
    );
    // Same with an explicit alias.
    assert.throws(
      () => q.buildGroupBy({ by: ['createdAt', { field: 'data', path: ['x'], alias: 'created_at' }] } as never),
      /output name "created_at" .* collides/,
    );
    // Aggregate output aliases share the namespace: a plain-column _sum emits
    // `_sum_<snake_col>` while a JSON-path _sum emits `_sum_<argKey>` — a
    // camel/snake sibling pair lands on ONE output column and drops a value.
    assert.throws(
      () =>
        q.buildGroupBy({
          by: [{ field: 'data', path: ['category'] }],
          _sum: { instanceId: true, instance_id: { field: 'data', path: ['price'] } },
        } as never),
      /output name "_sum_instance_id" .* collides/,
    );
    // A group-key alias equal to an aggregate output alias collides too.
    assert.throws(
      () =>
        q.buildGroupBy({
          by: [{ field: 'data', path: ['category'], alias: '_sum_price' }],
          _sum: { price: { field: 'data', path: ['price'] } },
        } as never),
      /output name "_sum_price" .* collides/,
    );
    // Non-colliding shapes still build.
    const ok = q.buildGroupBy({
      by: ['createdAt', { field: 'data', path: ['created_at'], alias: 'dataCreatedAt' }],
      _sum: { instanceId: true },
    } as never);
    assert.ok(ok.sql.includes('"created_at"'), ok.sql);
    assert.ok(ok.sql.includes('"_sum_instance_id"'), ok.sql);
  });

  it('rejects a non-JSON column, an unknown field, and an empty path (E003)', () => {
    const q = makeQuery('versions', schema());
    assert.throws(
      () => q.buildGroupBy({ by: [{ field: 'status', path: ['x'] }] } as never),
      /column "status" on table "versions" is not a JSON column/,
    );
    assert.throws(() => q.buildGroupBy({ by: [{ field: 'bogus', path: ['x'] }] } as never), /Unknown field "bogus"/);
    assert.throws(() => q.buildGroupBy({ by: [{ field: 'data', path: [] }] } as never), /non-empty `path`/);
  });
});

// ---------------------------------------------------------------------------
// B2: JSON-path aggregate targets
// ---------------------------------------------------------------------------

describe('groupBy JSON-path aggregate targets', () => {
  it('_sum casts numeric and aliases by the arg key', () => {
    const q = makeQuery('versions', schema());
    const { sql, params } = q.buildGroupBy({
      by: ['status'],
      _sum: { price: { field: 'data', path: ['price'] } },
    } as never);
    assert.ok(sql.includes('SUM(("data" #>> $1::text[])::numeric) AS "_sum_price"'), sql);
    assert.deepEqual(params, [['price']]);
  });

  it('_avg wraps the float result cast like plain-column _avg', () => {
    const q = makeQuery('versions', schema());
    const { sql } = q.buildGroupBy({
      by: ['status'],
      _avg: { price: { field: 'data', path: ['price'] } },
    } as never);
    assert.ok(sql.includes('AVG(("data" #>> $1::text[])::numeric)::float AS "_avg_price"'), sql);
  });

  it('_min/_max default to text comparison; type numeric adds the cast', () => {
    const q = makeQuery('versions', schema());
    const text = q.buildGroupBy({
      by: ['status'],
      _min: { title: { field: 'data', path: ['title'] } },
    } as never);
    assert.ok(text.sql.includes('MIN("data" #>> $1::text[]) AS "_min_title"'), text.sql);
    const numeric = q.buildGroupBy({
      by: ['status'],
      _max: { price: { field: 'data', path: ['price'], type: 'numeric' } },
    } as never);
    assert.ok(numeric.sql.includes('MAX(("data" #>> $1::text[])::numeric) AS "_max_price"'), numeric.sql);
  });

  it("rejects type: 'text' on _sum/_avg (E003)", () => {
    const q = makeQuery('versions', schema());
    assert.throws(
      () =>
        q.buildGroupBy({
          by: ['status'],
          _sum: { price: { field: 'data', path: ['price'], type: 'text' } },
        } as never),
      /_sum over a JSON path is always numeric/,
    );
  });

  it('mixes plain-column true entries with JSON targets', () => {
    const q = makeQuery('versions', schema());
    const { sql, params } = q.buildGroupBy({
      by: ['status'],
      _sum: { viewCount: true, price: { field: 'data', path: ['price'] } },
    } as never);
    assert.ok(sql.includes('SUM("view_count") AS "_sum_view_count"'), sql);
    assert.ok(sql.includes('SUM(("data" #>> $1::text[])::numeric) AS "_sum_price"'), sql);
    assert.deepEqual(params, [['price']]);
  });

  it('transform restructures JSON aggregates under their alias verbatim', () => {
    const q = makeQuery('versions', schema());
    const deferred = q.buildGroupBy({
      by: ['status'],
      _sum: { price: { field: 'data', path: ['price'] } },
      _min: { title: { field: 'data', path: ['title'] } },
      _max: { price: { field: 'data', path: ['price'], type: 'numeric' } },
    } as never);
    const rows = deferred.transform({
      rows: [{ status: 'live', _count: 2, _sum_price: '30.5', _min_title: 'apple', _max_price: '20' }],
      rowCount: 1,
    } as never);
    assert.deepEqual(rows, [
      {
        status: 'live',
        _count: 2,
        _sum: { price: 30.5 },
        _min: { title: 'apple' },
        _max: { price: 20 },
      },
    ]);
  });

  it('having on a JSON aggregate alias reuses the exact SELECT expression (same placeholder)', () => {
    const q = makeQuery('versions', schema());
    const { sql, params } = q.buildGroupBy({
      by: ['status'],
      _sum: { price: { field: 'data', path: ['price'] } },
      having: { price: { _sum: { gt: 100 } } },
    } as never);
    assert.ok(sql.includes('HAVING SUM(("data" #>> $1::text[])::numeric) > $2'), sql);
    assert.deepEqual(params, [['price'], 100]);
  });

  it('having on a plain column is unchanged; an alias that is neither still throws E003', () => {
    const q = makeQuery('versions', schema());
    const plain = q.buildGroupBy({
      by: ['status'],
      _sum: { viewCount: true },
      having: { viewCount: { _sum: { gte: 5 } } },
    } as never);
    assert.match(plain.sql, /HAVING SUM\("view_count"\) >= \$1/);
    assert.throws(
      () =>
        q.buildGroupBy({
          by: ['status'],
          _sum: { price: { field: 'data', path: ['price'] } },
          having: { bogus: { _sum: { gt: 1 } } },
        } as never),
      ValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// B3: DISTINCT ON row source
// ---------------------------------------------------------------------------

describe('groupBy distinctOn row source', () => {
  it('wraps the row source with args.where INSIDE the wrapper', () => {
    const q = makeQuery('versions', schema());
    const { sql, params } = q.buildGroupBy({
      distinctOn: { columns: ['instanceId'], orderBy: { createdAt: 'desc' } },
      by: ['status'],
      where: { viewCount: { gt: 3 } },
    } as never);
    assert.ok(
      sql.includes(
        'FROM (SELECT DISTINCT ON ("instance_id") * FROM "versions" WHERE "view_count" > $1 ' +
          'ORDER BY "instance_id", "created_at" DESC) AS "versions" GROUP BY "status"',
      ),
      sql,
    );
    assert.deepEqual(params, [3]);
  });

  it('multiple distinct columns all lead the wrapper ORDER BY', () => {
    const q = makeQuery('versions', schema());
    const { sql } = q.buildGroupBy({
      distinctOn: { columns: ['instanceId', 'status'], orderBy: { createdAt: 'desc' } },
      by: ['status'],
    } as never);
    assert.ok(sql.includes('DISTINCT ON ("instance_id", "status") *'), sql);
    assert.ok(sql.includes('ORDER BY "instance_id", "status", "created_at" DESC)'), sql);
  });

  it('distinctOn.orderBy supports OrderBySpec nulls and JSON-path entries (path parameterized)', () => {
    const q = makeQuery('versions', schema());
    const { sql, params } = q.buildGroupBy({
      distinctOn: {
        columns: ['instanceId'],
        orderBy: { createdAt: { sort: 'desc', nulls: 'last' }, data: { path: ['rev'], type: 'numeric' } },
      },
      by: ['status'],
    } as never);
    assert.ok(sql.includes('"created_at" DESC NULLS LAST, ("data" #>> $1::text[])::numeric ASC NULLS LAST)'), sql);
    assert.deepEqual(params, [['rev']]);
  });

  it('expresses the full pick-latest-then-aggregate shape (B1+B2+B3)', () => {
    const q = makeQuery('versions', schema());
    const { sql, params } = q.buildGroupBy({
      distinctOn: { columns: ['instanceId'], orderBy: { createdAt: 'desc' } },
      by: [{ field: 'data', path: ['category'] }],
      _sum: { price: { field: 'data', path: ['price'] } },
    } as never);
    assert.ok(sql.startsWith('SELECT ("data" #>> $1::text[]) AS "category"'), sql);
    assert.ok(sql.includes('SUM(("data" #>> $2::text[])::numeric) AS "_sum_price"'), sql);
    assert.ok(
      sql.includes(
        'FROM (SELECT DISTINCT ON ("instance_id") * FROM "versions" ORDER BY "instance_id", "created_at" DESC) AS "versions"',
      ),
      sql,
    );
    assert.ok(sql.includes('GROUP BY "data" #>> $1::text[]'), sql);
    assert.deepEqual(params, [['category'], ['price']]);
  });

  it('requires a deterministic orderBy and non-empty columns (E003)', () => {
    const q = makeQuery('versions', schema());
    assert.throws(
      () => q.buildGroupBy({ distinctOn: { columns: ['instanceId'], orderBy: {} }, by: ['status'] } as never),
      /requires `orderBy` to pick ONE row per column combination deterministically/,
    );
    assert.throws(
      () => q.buildGroupBy({ distinctOn: { columns: [], orderBy: { createdAt: 'desc' } }, by: ['status'] } as never),
      /non-empty `columns`/,
    );
  });

  it('rejects relation/vector values inside distinctOn.orderBy (E003)', () => {
    const q = makeQuery('versions', schema());
    assert.throws(
      () =>
        q.buildGroupBy({
          distinctOn: { columns: ['instanceId'], orderBy: { rel: { _count: 'desc' } } },
          by: ['status'],
        } as never),
      /supports plain columns, sort specs, and JSON-path orderings only/,
    );
  });

  it('throws E017 on non-PostgreSQL engines', () => {
    const q = makeQuery('versions', schema(), { dialect: sqliteDialect, sqlCache: false });
    assert.throws(
      () =>
        q.buildGroupBy({
          distinctOn: { columns: ['instanceId'], orderBy: { createdAt: 'desc' } },
          by: ['status'],
        } as never),
      (err: unknown) => {
        assert.ok(err instanceof UnsupportedFeatureError);
        assert.match(err.message, /DISTINCT ON row source/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Non-Postgres dialects: JSON paths bind as '$'-rooted JSONPath STRING params
// (the pool shims JSON.stringify non-primitive params, so a raw array would
// reach json_extract/JSON_EXTRACT/JSON_VALUE as '["x"]' — an invalid path
// that fails at the driver).
// ---------------------------------------------------------------------------

describe('groupBy JSON paths on non-Postgres dialects', () => {
  it('SQLite: group key + aggregate target bind JSONPath strings', () => {
    const q = makeQuery('versions', schema(), { dialect: sqliteDialect, sqlCache: false });
    const { sql, params } = q.buildGroupBy({
      by: [{ field: 'data', path: ['category'] }],
      _sum: { price: { field: 'data', path: ['meta', 0, 'price'] } },
    } as never);
    assert.ok(sql.includes('json_extract('), sql);
    assert.deepEqual(params, ['$."category"', '$."meta"[0]."price"']);
  });

  it('MySQL: group key binds a JSONPath string', () => {
    const q = makeQuery('versions', schema(), { dialect: mysqlDialect, sqlCache: false });
    const { sql, params } = q.buildGroupBy({
      by: [{ field: 'data', path: ['category'] }],
    } as never);
    assert.ok(sql.includes('JSON_EXTRACT('), sql);
    assert.deepEqual(params, ['$."category"']);
  });
});

// ---------------------------------------------------------------------------
// B4: ordering the result GROUPS. orderBy resolves against the columns the
// groupBy result actually contains (by-fields, JSON group-key aliases, and
// requested aggregates), NOT the table's physical columns. Each key re-emits
// the exact SELECT expression (mirroring HAVING), so it works on every dialect
// without relying on SELECT-alias references in ORDER BY.
// ---------------------------------------------------------------------------

describe('groupBy orderBy over result columns', () => {
  it('orders by a JSON group-key alias, reusing the extract expression + $n', () => {
    const q = makeQuery('versions', schema());
    const { sql, params } = q.buildGroupBy({
      by: [{ field: 'data', path: ['region'], alias: 'region' }],
      _sum: { viewCount: true },
      orderBy: { region: 'asc' },
    } as never);
    // Re-emits the same extract expression (same $1) in ORDER BY, not "region".
    assert.match(sql, /ORDER BY "data" #>> \$1::text\[\] ASC$/);
    assert.doesNotMatch(sql, /ORDER BY "region"/);
    // No extra param bound for ORDER BY: the group-key path param is reused.
    assert.deepEqual(params, [['region']]);
  });

  it('orders by the DEFAULT (unaliased) JSON group-key name', () => {
    const q = makeQuery('versions', schema());
    const { sql } = q.buildGroupBy({
      by: [{ field: 'data', path: ['region'] }],
      orderBy: { region: 'asc' },
    } as never);
    assert.match(sql, /ORDER BY "data" #>> \$1::text\[\] ASC$/);
  });

  it('orders by a JSON alias with an OrderBySpec (NULLS placement)', () => {
    const q = makeQuery('versions', schema());
    const { sql } = q.buildGroupBy({
      by: [{ field: 'data', path: ['region'], alias: 'region' }],
      orderBy: { region: { sort: 'desc', nulls: 'last' } },
    } as never);
    assert.match(sql, /ORDER BY "data" #>> \$1::text\[\] DESC NULLS LAST$/);
  });

  it('orders by _count', () => {
    const q = makeQuery('versions', schema());
    const { sql } = q.buildGroupBy({ by: ['status'], orderBy: { _count: 'desc' } } as never);
    assert.match(sql, /ORDER BY COUNT\(\*\) DESC$/);
  });

  it('orders by a plain-column _sum aggregate', () => {
    const q = makeQuery('versions', schema());
    const { sql } = q.buildGroupBy({
      by: ['status'],
      _sum: { viewCount: true },
      orderBy: { _sum: { viewCount: 'desc' } },
    } as never);
    assert.match(sql, /ORDER BY SUM\("view_count"\) DESC$/);
  });

  it('orders by a JSON-path aggregate alias, reusing its aggregate expression', () => {
    const q = makeQuery('versions', schema());
    const { sql } = q.buildGroupBy({
      by: ['status'],
      _sum: { revenue: { field: 'data', path: ['rev'], type: 'numeric' } },
      orderBy: { _sum: { revenue: 'desc' } },
    } as never);
    assert.match(sql, /ORDER BY SUM\(\("data" #>> \$1::text\[\]\)::numeric\) DESC$/);
  });

  it('orders by a plain by-column (unchanged behavior)', () => {
    const q = makeQuery('versions', schema());
    const { sql } = q.buildGroupBy({ by: ['status'], orderBy: { status: 'asc' } } as never);
    assert.match(sql, /ORDER BY "status" ASC$/);
  });

  it('combines a by-key and an aggregate ordering in order', () => {
    const q = makeQuery('versions', schema());
    const { sql } = q.buildGroupBy({
      by: ['status'],
      _sum: { viewCount: true },
      orderBy: { status: 'asc', _sum: { viewCount: 'desc' } },
    } as never);
    assert.match(sql, /ORDER BY "status" ASC, SUM\("view_count"\) DESC$/);
  });

  it('supports _avg / _min / _max ordering', () => {
    const q = makeQuery('versions', schema());
    for (const [agg, expr] of [
      ['_avg', 'AVG\\("view_count"\\)::float'],
      ['_min', 'MIN\\("view_count"\\)'],
      ['_max', 'MAX\\("view_count"\\)'],
    ] as const) {
      const { sql } = q.buildGroupBy({
        by: ['status'],
        [agg]: { viewCount: true },
        orderBy: { [agg]: { viewCount: 'desc' } },
      } as never);
      assert.match(sql, new RegExp(`ORDER BY ${expr} DESC$`));
    }
  });

  it('throws E003 ordering by an aggregate that was NOT requested', () => {
    const q = makeQuery('versions', schema());
    assert.throws(
      () =>
        q.buildGroupBy({
          by: ['status'],
          _sum: { viewCount: true },
          orderBy: { _avg: { viewCount: 'desc' } },
        } as never),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /aggregate is not requested/);
        assert.match(err.message, /Orderable keys: status, _count, _sum\.viewCount/);
        return true;
      },
    );
  });

  it('throws E003 ordering by _count when _count is not selected', () => {
    const q = makeQuery('versions', schema());
    assert.throws(
      () => q.buildGroupBy({ by: ['status'], _count: false as never, orderBy: { _count: 'desc' } } as never),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /_count is not selected/);
        return true;
      },
    );
  });

  it('throws E003 on an unknown orderBy key, listing the valid keys', () => {
    const q = makeQuery('versions', schema());
    assert.throws(
      () => q.buildGroupBy({ by: ['status'], orderBy: { nope: 'asc' } } as never),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /Unknown field "nope" in groupBy orderBy/);
        assert.match(err.message, /Orderable keys: status, _count/);
        return true;
      },
    );
  });

  it('compiles alias + aggregate ordering on MySQL / SQLite / MSSQL', () => {
    const cases = [
      {
        dialect: mysqlDialect,
        alias: /ORDER BY JSON_UNQUOTE\(JSON_EXTRACT\(`data`, :p1\)\) ASC, SUM\(`view_count`\) DESC$/,
      },
      { dialect: sqliteDialect, alias: /ORDER BY json_extract\("data", :p1\) ASC, SUM\("view_count"\) DESC$/ },
      { dialect: mssqlDialect, alias: /ORDER BY JSON_VALUE\(\[data\], @p1\) ASC, SUM\(\[view_count\]\) DESC$/ },
    ];
    for (const { dialect, alias } of cases) {
      const q = makeQuery('versions', schema(), { dialect, sqlCache: false });
      const { sql } = q.buildGroupBy({
        by: [{ field: 'data', path: ['region'], alias: 'region' }],
        _sum: { viewCount: true },
        orderBy: { region: 'asc', _sum: { viewCount: 'desc' } },
      } as never);
      assert.match(sql, alias);
    }
  });
});

// ---------------------------------------------------------------------------
// Live SQLite (node:sqlite, in-process — runs in the unit lane): the JSON-path
// groupBy keys/aggregates, JSON-path orderBy, and JSON range filters must
// actually EXECUTE on a non-Postgres engine, not just compile.
// ---------------------------------------------------------------------------

const DatabaseSync: (new (path: string) => DatabaseSyncType) | undefined = (() => {
  try {
    return createRequire(process.cwd())('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();

describe('groupBy JSON paths live on SQLite', () => {
  const skip = DatabaseSync ? false : 'turbine-orm/sqlite requires node:sqlite (Node >= 22.5)';

  it('JSON group keys, aggregate targets, orderBy, and range filters execute end-to-end', { skip }, async () => {
    const handle = new DatabaseSync!(':memory:');
    handle.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, data JSON)');
    handle.exec(`INSERT INTO items (name, data) VALUES
      ('a', '{"weight": 3, "cat": "x"}'),
      ('b', '{"weight": 1, "cat": "y"}'),
      ('c', '{"weight": 2, "cat": "x"}')`);
    const liveSchema = introspectSqliteDatabase(handle);
    // biome-ignore lint/suspicious/noExplicitAny: dynamic table accessor
    const db = turbineSqlite(handle, liveSchema, { warnOnUnlimited: false }) as any;
    try {
      const grouped = await db.items.groupBy({
        by: [{ field: 'data', path: ['cat'] }],
        _sum: { weight: { field: 'data', path: ['weight'] } },
      });
      grouped.sort((a: { cat: string }, b: { cat: string }) => a.cat.localeCompare(b.cat));
      assert.deepEqual(grouped, [
        { cat: 'x', _count: 2, _sum: { weight: 5 } },
        { cat: 'y', _count: 1, _sum: { weight: 1 } },
      ]);

      const ordered = await db.items.findMany({ orderBy: { data: { path: ['weight'], type: 'numeric' } } });
      assert.deepEqual(
        ordered.map((r: { name: string }) => r.name),
        ['b', 'c', 'a'],
      );

      const filtered = await db.items.findMany({ where: { data: { path: ['weight'], gt: 1 } } });
      assert.deepEqual(filtered.map((r: { name: string }) => r.name).sort(), ['a', 'c']);
    } finally {
      await db.disconnect();
    }
  });
});

// ---------------------------------------------------------------------------
// PowDB: the SQL-only groupBy extensions refuse with E017
// ---------------------------------------------------------------------------

describe('groupBy / orderBy extensions on PowDB (JSON supported since 0.12; others E017)', () => {
  // A trusted-caller pool (no explicit capabilities → all feature gates on),
  // so the JSON path features compile; refusals below are structural, not gated.
  const pool = { query: () => Promise.resolve({ rows: [], rowCount: 0 }) } as unknown as PowdbPool;
  const powqlQuery = () => new PowqlInterface(pool, 'versions', schema(), [], { warnOnUnlimited: false });

  it('distinctOn throws E017 (no DISTINCT ON row source)', async () => {
    await assert.rejects(
      powqlQuery().groupBy({
        distinctOn: { columns: ['instanceId'], orderBy: { createdAt: 'desc' } },
        by: ['status'],
      } as never),
      UnsupportedFeatureError,
    );
  });

  it('JSON-path group keys compile (F2, jsonDocs on)', async () => {
    await assert.doesNotReject(
      powqlQuery().groupBy({ by: [{ field: 'data', path: ['category'] }], _count: true } as never),
    );
  });

  it('JSON-path aggregate targets compile (F2)', async () => {
    await assert.doesNotReject(
      powqlQuery().groupBy({ by: ['status'], _sum: { price: { field: 'data', path: ['price'] } } } as never),
    );
  });

  it('aggregate orderBy over a REQUESTED aggregate compiles via its projection alias (F2 R3-1 parity)', async () => {
    await assert.doesNotReject(
      powqlQuery().groupBy({
        by: ['status'],
        _count: true,
        _sum: { viewCount: true },
        orderBy: { _count: 'desc' },
      } as never),
    );
    await assert.doesNotReject(
      powqlQuery().groupBy({
        by: ['status'],
        _count: true,
        _sum: { viewCount: true },
        orderBy: { _sum: { viewCount: 'desc' } },
      } as never),
    );
  });

  it('aggregate orderBy over an UNREQUESTED aggregate throws E003 listing valid keys', async () => {
    await assert.rejects(
      powqlQuery().groupBy({ by: ['status'], _count: true, orderBy: { _sum: { viewCount: 'desc' } } } as never),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match((err as Error).message, /not requested/);
        return true;
      },
    );
  });

  it('plain by-field orderBy still compiles on PowDB', async () => {
    await assert.doesNotReject(powqlQuery().groupBy({ by: ['status'], orderBy: { status: 'asc' } } as never));
  });

  it('pick-row orderBy throws E017 NAMING the feature (not "vector / distance ordering")', async () => {
    await assert.rejects(
      powqlQuery().findMany({
        orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title' } },
      } as never),
      (err: unknown) => {
        assert.ok(err instanceof UnsupportedFeatureError);
        assert.match((err as Error).message, /relation pick-row ordering/);
        assert.doesNotMatch((err as Error).message, /vector \/ distance/);
        return true;
      },
    );
  });

  it('object orderBy: JSON path + nulls:last now compile; relation / vector / nulls:first stay E017', async () => {
    // F2 supports JSON-path ordering on a json column and OrderBySpec nulls:last.
    await assert.doesNotReject(powqlQuery().findMany({ orderBy: { data: { path: ['x'] } } } as never));
    await assert.doesNotReject(powqlQuery().findMany({ orderBy: { status: { sort: 'asc', nulls: 'last' } } } as never));
    // Still refused, each with its own feature name.
    const stillE017: [Record<string, unknown>, RegExp][] = [
      [{ rel: { _count: 'desc' } }, /relation _count ordering/],
      [{ vec: { distance: { to: [1], metric: 'l2' } } }, /vector \/ distance ordering/],
      [{ status: { sort: 'asc', nulls: 'first' } }, /NULLS FIRST/],
    ];
    for (const [orderBy, expected] of stillE017) {
      await assert.rejects(powqlQuery().findMany({ orderBy } as never), expected);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration tests (require DATABASE_URL)
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping groupBy JSON/distinctOn integration tests: DATABASE_URL not set');
}

describe('groupBy JSON keys + distinctOn: integration', () => {
  const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');
  let db: TurbineClient;
  const TABLE = '_gbjson_versions';

  before(async () => {
    const setup = new pg.Client({ connectionString: DATABASE_URL! });
    await setup.connect();
    try {
      await setup.query(`DROP TABLE IF EXISTS ${TABLE}`);
      await setup.query(
        `CREATE TABLE ${TABLE} (
           id serial PRIMARY KEY,
           instance_id int NOT NULL,
           status text NOT NULL,
           data jsonb NOT NULL,
           created_at timestamptz NOT NULL
         )`,
      );
      // Three instances, several versions each. The LATEST version per
      // instance (by created_at) is marked below; groupBy(distinctOn latest)
      // must aggregate only those rows.
      await setup.query(
        `INSERT INTO ${TABLE} (instance_id, status, data, created_at) VALUES
           (1, 'live',  '{"category": "books", "price": 10}', '2024-01-01'),
           (1, 'live',  '{"category": "books", "price": 12}', '2024-03-01'),
           (2, 'live',  '{"category": "books", "price": 7}',  '2024-02-01'),
           (2, 'draft', '{"category": "toys",  "price": 99}', '2024-01-15'),
           (3, 'live',  '{"category": "toys",  "price": 5}',  '2024-04-01')`,
      );
      // Latest per instance: #2 (books/12), #3 (books/7), #5 (toys/5).
    } finally {
      await setup.end();
    }
    const schemaMeta = await introspect({ connectionString: DATABASE_URL! });
    db = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 3 }, schemaMeta);
    await db.connect();
  });

  after(async () => {
    if (db) await db.disconnect();
    const teardown = new pg.Client({ connectionString: DATABASE_URL! });
    await teardown.connect();
    try {
      await teardown.query(`DROP TABLE IF EXISTS ${TABLE}`);
    } finally {
      await teardown.end();
    }
  });

  it('groups by a JSON path over all rows', async () => {
    const rows = (await db.table(TABLE).groupBy({
      by: [{ field: 'data', path: ['category'] }],
      _sum: { price: { field: 'data', path: ['price'] } },
    } as never)) as Record<string, unknown>[];
    const byCategory = Object.fromEntries(rows.map((r) => [r.category, r]));
    assert.equal(byCategory.books!._count, 3);
    assert.deepEqual(byCategory.books!._sum, { price: 29 });
    assert.equal(byCategory.toys!._count, 2);
    assert.deepEqual(byCategory.toys!._sum, { price: 104 });
  });

  it('distinctOn latest-rows: aggregates one representative row per instance', async () => {
    const rows = (await db.table(TABLE).groupBy({
      distinctOn: { columns: ['instanceId'], orderBy: { createdAt: 'desc' } },
      by: [{ field: 'data', path: ['category'] }],
      _sum: { price: { field: 'data', path: ['price'] } },
    } as never)) as Record<string, unknown>[];
    // Latest rows: (books,12), (books,7), (toys,5).
    const byCategory = Object.fromEntries(rows.map((r) => [r.category, r]));
    assert.equal(byCategory.books!._count, 2);
    assert.deepEqual(byCategory.books!._sum, { price: 19 });
    assert.equal(byCategory.toys!._count, 1);
    assert.deepEqual(byCategory.toys!._sum, { price: 5 });
  });

  it('where filters BEFORE picking the latest row', async () => {
    // Restricted to status=live, instance 2's latest LIVE row is (books,7)
    // even though its overall latest is the draft (toys,99).
    const rows = (await db.table(TABLE).groupBy({
      distinctOn: { columns: ['instanceId'], orderBy: { createdAt: 'desc' } },
      where: { status: 'live' },
      by: [{ field: 'data', path: ['category'] }],
      _sum: { price: { field: 'data', path: ['price'] } },
      having: { price: { _sum: { gt: 0 } } },
    } as never)) as Record<string, unknown>[];
    const byCategory = Object.fromEntries(rows.map((r) => [r.category, r]));
    assert.deepEqual(byCategory.books!._sum, { price: 19 });
    assert.deepEqual(byCategory.toys!._sum, { price: 5 });
  });
});
