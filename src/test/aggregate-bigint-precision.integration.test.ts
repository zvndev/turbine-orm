/**
 * turbine-orm: `_sum` / `_avg` over int8 and numeric columns are exact
 *
 * PostgreSQL widens SUM and AVG past their input type: `SUM(int8)` and
 * `SUM(numeric)` are `numeric`, and `AVG` of ANY integer or numeric input is
 * `numeric`. The driver delivers `numeric` as its exact text, because Turbine
 * deliberately registers no parser for OID 1700 (the type is
 * arbitrary-precision, and a JS number is not). The aggregate transforms then
 * ran `Number()` over that text, so `sum(big)` of 461168601842738790350 came
 * back as 461168601842738800000 and a numeric(12,2) total of 1020.50 came back
 * as 1020.5. `_avg` was worse: it cast to `float` IN SQL, so the engine had
 * rounded before the value reached the wire, while `_min` / `_max` on the very
 * same columns were exact.
 *
 * The rule now lives in ONE predicate (`isExactNumericType` in
 * query/aggregates.ts): when the SOURCE column is int8 / bigint or numeric /
 * decimal, the aggregate value is returned as the driver delivered it (on
 * PostgreSQL the exact text, a string) and `_avg` is not cast; every other
 * column keeps `Number()` and the float cast, so `_sum` of an int4 column is
 * still a JS number. JSON-path `_sum` / `_avg` always cast numeric in SQL and
 * stay `Number()`.
 *
 * The first half is build-only (SQL text and the transforms, no database). The
 * second half runs against a live PostgreSQL on its own `qa78_` table and
 * compares every value with the `::text` the engine itself renders.
 *
 * Run: DATABASE_URL=postgres://... \
 *        npx tsx --test src/test/aggregate-bigint-precision.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import type { SchemaMetadata } from '../schema.js';
import { sqliteDialect } from '../sqlite.js';
import { makeQuery, mockTable, skipGate } from './helpers.js';

// ---------------------------------------------------------------------------
// Build-only: SQL text and transforms
// ---------------------------------------------------------------------------

/** One table carrying every column family the rule distinguishes. */
function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      ledger: mockTable('ledger', [
        { name: 'id', field: 'id', pgType: 'int4' },
        { name: 'bucket', field: 'bucket', pgType: 'text' },
        { name: 'big', field: 'big', pgType: 'int8' },
        { name: 'amount', field: 'amount', pgType: 'numeric' },
        { name: 'small', field: 'small', pgType: 'int4' },
        { name: 'ratio', field: 'ratio', pgType: 'float8' },
        { name: 'data', field: 'data', pgType: 'jsonb' },
      ]),
    },
  };
}

/** A pg.QueryResult carrying whatever the driver would have produced. */
function result(...rows: Record<string, unknown>[]): pg.QueryResult {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] } as unknown as pg.QueryResult;
}

/** The two blocks these tests read back from an aggregate() result. */
interface AggOut {
  _sum: Record<string, unknown>;
  _avg: Record<string, unknown>;
}

/** One groupBy result row as these tests read it: the group key plus the two blocks. */
type GroupOut = Record<string, unknown> & AggOut;

// The transforms are typed per-arg against a `Record<string, unknown>` entity,
// so the assertions read them through these two views instead of `any`.
function readAgg(value: unknown): AggOut {
  return value as AggOut;
}

function readGroups(value: unknown): GroupOut[] {
  return value as GroupOut[];
}

describe('aggregate SQL: _avg keeps the float cast only where the result is not exact', () => {
  it('int8 and numeric sources are left uncast; int4 and float8 keep ::float', () => {
    const { sql } = makeQuery('ledger', schema()).buildAggregate({
      _avg: { big: true, amount: true, small: true, ratio: true },
    });
    assert.equal(
      sql,
      'SELECT AVG("big") AS "_avg_big", AVG("amount") AS "_avg_amount", ' +
        'AVG("small")::float AS "_avg_small", AVG("ratio")::float AS "_avg_ratio" FROM "ledger"',
    );
  });

  it('_sum never carried a cast and still does not', () => {
    const { sql } = makeQuery('ledger', schema()).buildAggregate({ _sum: { big: true, amount: true, small: true } });
    assert.equal(
      sql,
      'SELECT SUM("big") AS "_sum_big", SUM("amount") AS "_sum_amount", SUM("small") AS "_sum_small" FROM "ledger"',
    );
  });

  it('groupBy applies the same rule, and an orderBy on that _avg reuses the uncast expression', () => {
    const { sql } = makeQuery('ledger', schema()).buildGroupBy({
      by: ['bucket'],
      _avg: { big: true, small: true },
      orderBy: { _avg: { big: 'desc' } },
    } as never);
    assert.equal(
      sql,
      'SELECT "bucket", COUNT(*)::int AS _count, AVG("big") AS "_avg_big", AVG("small")::float AS "_avg_small" ' +
        'FROM "ledger" GROUP BY "bucket" ORDER BY AVG("big") DESC',
    );
  });

  it('a JSON-path _avg is always numeric-cast and keeps the float cast (its source is text)', () => {
    const { sql } = makeQuery('ledger', schema()).buildGroupBy({
      by: ['bucket'],
      _avg: { price: { field: 'data', path: ['price'] } },
    } as never);
    assert.ok(sql.includes('AVG(("data" #>> $1::text[])::numeric)::float AS "_avg_price"'), sql);
  });

  it("recognises the other engines' spellings of the same types (BIGINT, DECIMAL(p,s))", () => {
    const tables = {
      ledger: mockTable('ledger', [
        { name: 'id', field: 'id', pgType: 'INTEGER' },
        { name: 'big', field: 'big', pgType: 'BIGINT' },
        { name: 'amount', field: 'amount', pgType: 'DECIMAL(10,2)' },
        { name: 'small', field: 'small', pgType: 'INTEGER' },
      ]),
    };
    const q = makeQuery('ledger', { enums: {}, tables }, { dialect: sqliteDialect, warnOnUnlimited: false });
    const { sql } = q.buildAggregate({ _avg: { big: true, amount: true, small: true } });
    assert.equal(
      sql,
      'SELECT AVG("big") AS "_avg_big", AVG("amount") AS "_avg_amount", ' +
        'CAST(AVG("small") AS REAL) AS "_avg_small" FROM "ledger"',
    );
  });
});

describe('aggregate transform: exact sources pass through verbatim, the rest are numbers', () => {
  it('int8 / numeric text is returned as the string the driver delivered', () => {
    const out = readAgg(
      makeQuery('ledger', schema())
        .buildAggregate({ _sum: { big: true, amount: true }, _avg: { big: true, amount: true } })
        .transform(
          result({
            _sum_big: '461168601842738790350',
            _avg_big: '3074457345618258602.3333333333333333',
            _sum_amount: '1020.50',
            _avg_amount: '6.8033333333333333',
          }),
        ),
    );
    assert.equal(out._sum.big, '461168601842738790350');
    assert.equal(out._avg.big, '3074457345618258602.3333333333333333');
    assert.equal(out._sum.amount, '1020.50');
    assert.equal(out._avg.amount, '6.8033333333333333');
  });

  it('int4 / float8 sources are still JS numbers, whether the driver sent a number or text', () => {
    const q = makeQuery('ledger', schema());
    const build = q.buildAggregate({ _sum: { small: true, ratio: true }, _avg: { small: true, ratio: true } });
    // SUM(int4) is int8 on PostgreSQL, so an owned pool's int8 parser hands
    // back a number, while a pool without that parser hands back text. Both
    // must land on the same JS number.
    const typed = readAgg(
      build.transform(result({ _sum_small: 7, _avg_small: 3.5, _sum_ratio: 1.5, _avg_ratio: 0.75 })),
    );
    const text = readAgg(
      build.transform(result({ _sum_small: '7', _avg_small: '3.5', _sum_ratio: '1.5', _avg_ratio: '0.75' })),
    );
    for (const out of [typed, text]) {
      assert.equal(out._sum.small, 7);
      assert.equal(out._avg.small, 3.5);
      assert.equal(out._sum.ratio, 1.5);
      assert.equal(out._avg.ratio, 0.75);
      assert.equal(typeof out._sum.small, 'number');
    }
  });

  it('NULL (an aggregate over zero rows) stays null on every column family', () => {
    const out = readAgg(
      makeQuery('ledger', schema())
        .buildAggregate({ _sum: { big: true, small: true }, _avg: { amount: true, ratio: true } })
        .transform(result({ _sum_big: null, _sum_small: null, _avg_amount: null, _avg_ratio: null })),
    );
    assert.equal(out._sum.big, null);
    assert.equal(out._sum.small, null);
    assert.equal(out._avg.amount, null);
    assert.equal(out._avg.ratio, null);
  });

  it('a driver that already hands back a number for an exact type is left alone (SQLite)', () => {
    const tables = {
      ledger: mockTable('ledger', [
        { name: 'id', field: 'id', pgType: 'INTEGER' },
        { name: 'big', field: 'big', pgType: 'BIGINT' },
      ]),
    };
    const q = makeQuery('ledger', { enums: {}, tables }, { dialect: sqliteDialect, warnOnUnlimited: false });
    const out = readAgg(q.buildAggregate({ _sum: { big: true } }).transform(result({ _sum_big: 42 })));
    // "Verbatim" means the driver's value, not a stringified copy of it.
    assert.equal(out._sum.big, 42);
  });
});

describe('groupBy transform: the same rule per group, JSON-path aggregates stay numeric', () => {
  it('int8 / numeric verbatim, int4 Number(), JSON-path _sum Number()', () => {
    const out = readGroups(
      makeQuery('ledger', schema())
        .buildGroupBy({
          by: ['bucket'],
          _sum: { big: true, amount: true, small: true, price: { field: 'data', path: ['price'] } },
          _avg: { big: true, small: true },
        } as never)
        .transform(
          result(
            {
              bucket: 'a',
              _count: 2,
              _sum_big: '9223372036854775807',
              _sum_amount: '40.60',
              _sum_small: '7',
              _sum_price: '30.5',
              _avg_big: '4611686018427387903.5000000000000000',
              _avg_small: 3.5,
            },
            {
              bucket: 'b',
              _count: 0,
              _sum_big: null,
              _sum_amount: null,
              _sum_small: null,
              _sum_price: null,
              _avg_big: null,
              _avg_small: null,
            },
          ),
        ),
    );
    const [a, b] = out;
    assert.equal(a?._sum.big, '9223372036854775807');
    assert.equal(a?._sum.amount, '40.60');
    assert.equal(a?._sum.small, 7);
    assert.equal(a?._sum.price, 30.5);
    assert.equal(a?._avg.big, '4611686018427387903.5000000000000000');
    assert.equal(a?._avg.small, 3.5);
    assert.equal(b?._sum.big, null);
    assert.equal(b?._avg.big, null);
  });
});

// ---------------------------------------------------------------------------
// Live PostgreSQL: every value equals the text the engine renders itself
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping aggregate precision integration tests: DATABASE_URL not set');
}

const gate = skipGate(SKIP, 'DATABASE_URL not set');
const TABLE = 'qa78_agg_precision';

/**
 * 100 rows just under 2^62 and 50 rows just over it: the total is far above
 * 2^53, so a `Number()` round trip cannot reproduce it, and the two buckets
 * give groupBy something to separate. The numeric(12,2) amounts sum to 1020.50,
 * whose trailing zero is exactly what `Number()` drops.
 */
const DDL = `
DROP TABLE IF EXISTS ${TABLE};
CREATE TABLE ${TABLE} (
  id      SERIAL PRIMARY KEY,
  bucket  TEXT NOT NULL,
  big     BIGINT NOT NULL,
  amount  NUMERIC(12,2) NOT NULL,
  small   INTEGER NOT NULL
);
INSERT INTO ${TABLE} (bucket, big, amount, small)
  SELECT 'a', 4611686018427387903, 10.20, 3 FROM generate_series(1, 100);
INSERT INTO ${TABLE} (bucket, big, amount, small)
  SELECT 'b', 4611686018427387904, 0.01, 4 FROM generate_series(1, 50);
`;

/** The metadata `introspect` would produce for the table above (udt_name spellings). */
function liveSchema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      [TABLE]: mockTable(TABLE, [
        { name: 'id', field: 'id', pgType: 'int4' },
        { name: 'bucket', field: 'bucket', pgType: 'text' },
        { name: 'big', field: 'big', pgType: 'int8' },
        { name: 'amount', field: 'amount', pgType: 'numeric' },
        { name: 'small', field: 'small', pgType: 'int4' },
      ]),
    },
  };
}

interface RawTotals {
  sum_big: string;
  avg_big: string;
  sum_amount: string;
  avg_amount: string;
  sum_small: string;
  avg_small: string;
  min_big: string;
  max_big: string;
}

const TOTALS_SQL =
  'SELECT sum(big)::text AS sum_big, avg(big)::text AS avg_big, sum(amount)::text AS sum_amount, ' +
  'avg(amount)::text AS avg_amount, sum(small)::text AS sum_small, avg(small)::text AS avg_small, ' +
  `min(big)::text AS min_big, max(big)::text AS max_big FROM ${TABLE}`;

describe('live: _sum / _avg over bigint and numeric equal the text PostgreSQL renders', () => {
  let raw: pg.Client;
  let db: TurbineClient;
  let totals: RawTotals;

  gate.before(async () => {
    raw = new pg.Client({ connectionString: DATABASE_URL });
    await raw.connect();
    await raw.query(DDL);
    totals = (await raw.query<RawTotals>(TOTALS_SQL)).rows[0]!;
    db = new TurbineClient({ connectionString: DATABASE_URL as string, poolSize: 3 }, liveSchema());
    await db.connect();
  });

  gate.after(async () => {
    await db?.disconnect();
    await raw?.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await raw?.end();
  });

  const t = () => db.table<Record<string, unknown>>(TABLE);

  gate.it('the fixture is above 2^53, so a rounded value cannot pass by accident', () => {
    assert.ok(!Number.isSafeInteger(Number(totals.sum_big)), totals.sum_big);
    assert.notEqual(String(Number(totals.sum_big)), totals.sum_big);
    assert.ok(totals.sum_amount.endsWith('.50'), totals.sum_amount);
  });

  gate.it('_sum of a bigint column is the exact text', async () => {
    const agg = await t().aggregate({ _sum: { big: true } });
    assert.equal(agg._sum?.big, totals.sum_big);
    assert.equal(typeof agg._sum?.big, 'string');
  });

  gate.it('_avg of a bigint column is the exact text (no float cast on the wire)', async () => {
    const agg = await t().aggregate({ _avg: { big: true } });
    assert.equal(agg._avg?.big, totals.avg_big);
  });

  gate.it('_sum / _avg of a numeric(12,2) column keep their scale', async () => {
    const agg = await t().aggregate({ _sum: { amount: true }, _avg: { amount: true } });
    assert.equal(agg._sum?.amount, totals.sum_amount);
    assert.equal(agg._avg?.amount, totals.avg_amount);
  });

  gate.it('_sum / _avg of an int4 column are still JS numbers', async () => {
    const agg = await t().aggregate({ _sum: { small: true }, _avg: { small: true } });
    assert.equal(typeof agg._sum?.small, 'number');
    assert.equal(agg._sum?.small, Number(totals.sum_small));
    assert.equal(typeof agg._avg?.small, 'number');
    assert.ok(Math.abs((agg._avg?.small as number) - Number(totals.avg_small)) < 1e-9);
  });

  gate.it('_min / _max on the same bigint column follow the existing int8 read policy (exact above 2^53)', async () => {
    const agg = await t().aggregate({ _min: { big: true }, _max: { big: true } });
    assert.equal(String(agg._min?.big), totals.min_big);
    assert.equal(String(agg._max?.big), totals.max_big);
  });

  gate.it('an aggregate over zero rows is null, not "0" or NaN', async () => {
    const agg = await t().aggregate({
      _sum: { big: true, amount: true },
      _avg: { big: true },
      where: { bucket: 'none' },
    });
    assert.equal(agg._sum?.big, null);
    assert.equal(agg._sum?.amount, null);
    assert.equal(agg._avg?.big, null);
  });

  gate.it('groupBy: every group equals its own raw text', async () => {
    const rawGroups = (
      await raw.query<RawTotals & { bucket: string }>(
        `${TOTALS_SQL.replace('SELECT ', 'SELECT bucket, ')} GROUP BY bucket ORDER BY bucket`,
      )
    ).rows;
    const groups = readGroups(
      await t().groupBy({
        by: ['bucket'],
        _sum: { big: true, amount: true, small: true },
        _avg: { big: true, amount: true, small: true },
        orderBy: { bucket: 'asc' },
      }),
    );
    assert.equal(groups.length, rawGroups.length);
    for (const [i, g] of groups.entries()) {
      const r = rawGroups[i]!;
      assert.equal(g.bucket, r.bucket);
      assert.equal(g._sum.big, r.sum_big);
      assert.equal(g._avg.big, r.avg_big);
      assert.equal(g._sum.amount, r.sum_amount);
      assert.equal(g._avg.amount, r.avg_amount);
      assert.equal(typeof g._sum.small, 'number');
      assert.equal(g._sum.small, Number(r.sum_small));
      assert.equal(typeof g._avg.small, 'number');
    }
  });

  gate.it('groupBy ordered by the uncast _avg sorts numerically, not textually', async () => {
    // Bucket b's single row value is larger than bucket a's, so a numeric sort
    // puts b first; a text sort of the two rendered averages would agree here
    // by coincidence, which is why the assertion is on the VALUES as well.
    const groups = readGroups(
      await t().groupBy({
        by: ['bucket'],
        _avg: { big: true },
        orderBy: { _avg: { big: 'desc' } },
      }),
    );
    assert.deepEqual(
      groups.map((g) => g.bucket),
      ['b', 'a'],
    );
    const intPart = (v: unknown): bigint => BigInt(String(v).split('.')[0] ?? '');
    assert.ok(intPart(groups[0]?._avg.big) > intPart(groups[1]?._avg.big));
  });
});
