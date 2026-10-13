/**
 * Engine-seam value fidelity, checked without a database. Each assertion pins
 * one place where SQL Server or MySQL used to return something other than what
 * PostgreSQL returns for the same query; the live proof is the cross-engine
 * battery (src/test/oracle-engines-*.test.ts).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { postgresDialect } from '../dialect.js';
import { MssqlPool, mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import { makeQuery } from './helpers.js';
import { SCHEMA } from './oracle/engines/fixture.js';

// --- SQL Server parameter types ---------------------------------------------

const BIGINT_TYPE = { type: 'BigInt' };
const dateTime2 = (scale?: number) => ({ type: 'DateTime2', scale });

/** A fake `mssql` namespace + pool that records every `request.input(...)` call. */
function recordingMssql() {
  const inputs: unknown[][] = [];
  const request = {
    input(...args: unknown[]) {
      inputs.push(args);
      return request;
    },
    query: async () => ({ recordset: [], rowsAffected: [0] }),
    batch: async () => ({ recordset: [], rowsAffected: [0] }),
  };
  const raw = { request: () => request, connect: async () => raw, close: async () => {} };
  const sqlNS = {
    BigInt: BIGINT_TYPE,
    DateTime2: dateTime2,
    ConnectionPool: function ConnectionPool() {},
    Request: function Request() {
      return request;
    },
    Transaction: function Transaction() {},
    ISOLATION_LEVEL: {},
    connect: async () => raw,
  };
  return { pool: new MssqlPool(raw as never, sqlNS as never), inputs };
}

describe('SQL Server binds bigint and Date with an explicit type', () => {
  const at = new Date('2025-12-31T23:59:59.999Z');
  const invalid = new Date(Number.NaN);
  const values = [9007199254740997n, 3n, at, 5, 'x', null, true, invalid];
  const expected = [
    ['p1', BIGINT_TYPE, 9007199254740997n],
    ['p2', BIGINT_TYPE, 3n],
    ['p3', { type: 'DateTime2', scale: 7 }, at],
    ['p4', 5],
    ['p5', 'x'],
    ['p6', null],
    ['p7', true],
    ['p8', invalid],
  ];

  it('on a pool query', async () => {
    const { pool, inputs } = recordingMssql();
    await pool.query('SELECT 1', values);
    assert.deepEqual(inputs, expected);
  });

  it('on a checked-out (transaction) client', async () => {
    const { pool, inputs } = recordingMssql();
    const client = await pool.connect();
    await client.query('SELECT 1', values);
    assert.deepEqual(inputs, expected);
  });
});

// --- nested bigint under a code-first schema ---------------------------------

describe('a code-first int8 column gets the bigint JSON-wire rule', () => {
  for (const [name, dialect] of [
    ['mysql', mysqlDialect],
    ['mssql', mssqlDialect],
  ] as const) {
    it(name, () => {
      const rule = dialect.jsonWireRule?.('int8');
      assert.ok(rule, `${name}: no rule for int8, so FOR JSON / JSON_OBJECT renders the bigint as a double`);
      assert.equal(rule.decode('9007199254740993'), '9007199254740993');
      assert.equal(rule.decode('7'), 7);
      assert.deepEqual(dialect.jsonWireRule?.('bigint')?.sql('x'), rule.sql('x'));
    });
  }
});

// --- AVG over an integer column ----------------------------------------------

describe('AVG over an integer column keeps its fraction', () => {
  const avgSql = (dialect: typeof postgresDialect) =>
    makeQuery('oe_comments', SCHEMA, { dialect, warnOnUnlimited: false }).buildAggregate({
      _avg: { likes: true },
    } as never).sql;
  const havingSql = (dialect: typeof postgresDialect) =>
    makeQuery('oe_posts', SCHEMA, { dialect, warnOnUnlimited: false }).buildGroupBy({
      by: ['published'],
      _avg: { views: true },
      having: { views: { _avg: { gt: 56.2 } } },
    } as never).sql;

  it('SQL Server averages the column as FLOAT, in SELECT and in HAVING', () => {
    assert.match(avgSql(mssqlDialect), /AVG\(CAST\(\[likes\] AS FLOAT\)\)/);
    const having = havingSql(mssqlDialect);
    assert.match(having, /SELECT .*AVG\(CAST\(\[views\] AS FLOAT\)\)/);
    assert.match(having, /HAVING AVG\(CAST\(\[views\] AS FLOAT\)\) >/);
  });

  it('SQL Server averages a BIGINT as DECIMAL, which stays exact', () => {
    const sql = makeQuery('oe_users', SCHEMA, { dialect: mssqlDialect, warnOnUnlimited: false }).buildAggregate({
      _avg: { big: true },
    } as never).sql;
    assert.match(sql, /AVG\(CAST\(\[big\] AS DECIMAL\(38, 0\)\)\)/);
  });

  it('MySQL averages the column in DOUBLE, in SELECT and in HAVING', () => {
    assert.match(avgSql(mysqlDialect), /AVG\(\(`likes` \+ 0E0\)\)/);
    assert.match(havingSql(mysqlDialect), /HAVING AVG\(\(`views` \+ 0E0\)\) >/);
  });

  it('PostgreSQL SQL is unchanged', () => {
    assert.equal(postgresDialect.averageArgument, undefined);
    assert.match(avgSql(postgresDialect), /AVG\("likes"\)::float AS "_avg_likes"/);
    assert.match(havingSql(postgresDialect), /HAVING AVG\("views"\) > \$1/);
  });
});

// --- SQL Server relation orderBy, array form ---------------------------------

describe('SQL Server accepts the array form of a relation orderBy on the join strategy', () => {
  it('compiles each entry into the FOR JSON subquery ORDER BY', () => {
    const q = makeQuery('oe_users', SCHEMA, { dialect: mssqlDialect, warnOnUnlimited: false });
    const { sql } = q.buildFindMany({
      relationLoadStrategy: 'join',
      with: { oePosts: { orderBy: [{ views: 'desc' }, { id: 'asc' }], limit: 1 } },
    } as never);
    assert.match(sql, /ORDER BY t0\.\[views\] DESC, t0\.\[id\] ASC OFFSET 0 ROWS FETCH NEXT @p\d+ ROWS ONLY/);
  });
});

// --- SQL Server json columns, decoded by the row parser -----------------------

describe('SQL Server json columns read back as the parsed value', () => {
  // A json column is NVARCHAR(MAX) on SQL Server, so the driver hands back the
  // document's text, and FOR JSON PATH embeds a nested row's json cell as a JSON
  // string. `decodeColumnValue` is what turns both into PostgreSQL's value.
  const parse = (dialect: typeof mssqlDialect | typeof postgresDialect, rows: Record<string, unknown>[]) =>
    makeQuery('oe_users', SCHEMA, { dialect, warnOnUnlimited: false })
      .buildFindMany({ relationLoadStrategy: 'join', with: { oePosts: true } } as never)
      .transform({ rows, rowCount: rows.length } as never) as Record<string, unknown>[];

  it('a top-level json cell and a nested one are parsed; NULL stays null', () => {
    const nested = JSON.stringify([
      { id: 7, meta: '{"pinned":true}' },
      { id: 8, meta: null },
    ]);
    const [first, second] = parse(mssqlDialect, [
      { id: 1, prefs: '{"theme":"dark","tags":["a","b"]}', oePosts: nested },
      { id: 2, prefs: '"123"', oePosts: '[]' },
    ]);
    assert.deepEqual(first?.prefs, { theme: 'dark', tags: ['a', 'b'] });
    const posts = first?.oePosts as Record<string, unknown>[];
    assert.deepEqual(posts[0]?.meta, { pinned: true });
    assert.equal(posts[1]?.meta, null);
    assert.equal(second?.prefs, '123', 'a JSON string document reads as the string, not its quoted text');
  });

  it('PostgreSQL defines no decode, so a json value the driver already parsed passes through', () => {
    assert.equal(postgresDialect.decodeColumnValue, undefined);
    const [row] = parse(postgresDialect, [{ id: 1, prefs: { theme: 'dark' }, oePosts: [] }]);
    assert.deepEqual(row?.prefs, { theme: 'dark' });
  });
});
