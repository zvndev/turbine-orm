/**
 * Write-path rules, build-only (no database):
 *
 * - Update expressions store one value on every engine: arithmetic is integer
 *   arithmetic when both operands are integers (integer division truncates,
 *   DIV on MySQL), decimal otherwise, and a non-integer result is refused on
 *   an integer column. The class of a bound value is part of the cache key.
 * - `optimisticLock` is refused on `delete` and `deleteMany`, which do not
 *   apply it.
 * - A plain object or array written to a scalar column is refused on every
 *   engine (MySQL text columns too; SQLite and SQL Server text columns are the
 *   engine's JSON carrier), and a Map or Set is refused everywhere.
 * - MySQL `create` with 0 in an AUTO_INCREMENT key returns the row it inserted.
 * - `createMany({ onConflict })` refuses a table row written twice in one call,
 *   across the statements of a chunked call too, and rolls the call back.
 *
 * The live counterparts are in fx-write-engines.integration.test.ts.
 */

// biome-ignore-all lint/suspicious/noThenProperty: expr.case arms are { when, then }, the SQL CASE spelling; never thenable
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Dialect } from '../dialect.js';
import { postgresDialect } from '../dialect.js';
import { UnsupportedFeatureError, ValidationError } from '../errors.js';
import { col, expr, jsonValue } from '../index.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import { QueryInterface } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { sqliteDialect } from '../sqlite.js';
import { makeQuery, mockTable } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: build-only harness drives untyped args
type Any = any;

const ENGINES: [string, Dialect][] = [
  ['postgresql', postgresDialect],
  ['mysql', mysqlDialect],
  ['sqlite', sqliteDialect],
  ['mssql', mssqlDialect],
];

/** Column types per engine: [integer, float, text, json]. */
const TYPES: Record<string, [string, string, string, string]> = {
  postgresql: ['int4', 'float8', 'text', 'jsonb'],
  mysql: ['int', 'double', 'varchar', 'json'],
  sqlite: ['INTEGER', 'REAL', 'TEXT', 'JSON'],
  mssql: ['int', 'float', 'nvarchar', 'nvarchar'],
};

function schema(engine = 'postgresql'): SchemaMetadata {
  const [int, float, text, json] = TYPES[engine]!;
  const ar = mockTable('ar', [
    { name: 'id', field: 'id', pgType: int },
    { name: 'n', field: 'n', pgType: int },
    { name: 'm', field: 'm', pgType: int },
    { name: 'f', field: 'f', pgType: float },
    { name: 'label', field: 'label', pgType: text },
    { name: 'meta', field: 'meta', pgType: json },
    { name: 'version', field: 'version', pgType: int },
  ]);
  const people = mockTable('people', [
    { name: 'id', field: 'id', pgType: int },
    { name: 'email', field: 'email', pgType: text, unique: true },
    { name: 'name', field: 'name', pgType: text },
  ]);
  const idCol = people.columns.find((c) => c.name === 'id')!;
  idCol.isGenerated = true;
  idCol.hasDefault = true;
  return { tables: { ar, people }, enums: {} } as unknown as SchemaMetadata;
}

function engineOf(dialect: Dialect): string {
  return dialect.name;
}

function q(dialect: Dialect, table = 'ar', options: Record<string, unknown> = {}): Any {
  return makeQuery(table, schema(engineOf(dialect)), { dialect, ...options });
}

const update = (dialect: Dialect, data: Record<string, unknown>) => q(dialect).buildUpdate({ where: { id: 1 }, data });

const e003 = (pattern: RegExp) => (err: unknown) => {
  assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
  assert.equal(err.code, 'TURBINE_E003');
  assert.match(err.message, pattern);
  return true;
};

// ---------------------------------------------------------------------------
// Update expressions: one stored value on every engine
// ---------------------------------------------------------------------------

describe('expression arithmetic is typed from its operands', () => {
  const RENDERED: [string, () => Record<string, unknown>, Record<string, string>][] = [
    [
      'integer / integer into an integer column truncates (DIV on MySQL)',
      () => ({ n: expr.div(col('n'), 2) }),
      {
        postgresql: 'UPDATE "ar" SET "n" = ("n" / $1::int4) WHERE "id" = $2 RETURNING *',
        mysql: 'UPDATE `ar` SET `n` = (`n` DIV :p1) WHERE `id` = :p2',
        sqlite: 'UPDATE "ar" SET "n" = ("n" / :p1) WHERE "id" = :p2 RETURNING *',
        mssql: 'UPDATE [ar] SET [n] = ([n] / @p1) OUTPUT INSERTED.* WHERE [id] = @p2',
      },
    ],
    [
      'integer / integer into a float column is still integer division',
      () => ({ f: expr.div(col('n'), 2) }),
      {
        postgresql: 'UPDATE "ar" SET "f" = ("n" / $1::int8) WHERE "id" = $2 RETURNING *',
        mysql: 'UPDATE `ar` SET `f` = (`n` DIV :p1) WHERE `id` = :p2',
        sqlite: 'UPDATE "ar" SET "f" = ("n" / :p1) WHERE "id" = :p2 RETURNING *',
        mssql: 'UPDATE [ar] SET [f] = ([n] / @p1) OUTPUT INSERTED.* WHERE [id] = @p2',
      },
    ],
    [
      'a non-integer operand makes it decimal arithmetic',
      () => ({ f: expr.mul(col('n'), 1.5) }),
      {
        postgresql: 'UPDATE "ar" SET "f" = ("n" * $1::numeric) WHERE "id" = $2 RETURNING *',
        mysql: 'UPDATE `ar` SET `f` = (`n` * :p1) WHERE `id` = :p2',
        sqlite: 'UPDATE "ar" SET "f" = ("n" * :p1) WHERE "id" = :p2 RETURNING *',
        mssql: 'UPDATE [ar] SET [f] = ([n] * @p1) OUTPUT INSERTED.* WHERE [id] = @p2',
      },
    ],
    [
      'a float column makes division decimal',
      () => ({ f: expr.div(col('f'), 2) }),
      {
        postgresql: 'UPDATE "ar" SET "f" = ("f" / $1::int8) WHERE "id" = $2 RETURNING *',
        mysql: 'UPDATE `ar` SET `f` = (`f` / :p1) WHERE `id` = :p2',
        sqlite: 'UPDATE "ar" SET "f" = ("f" / :p1) WHERE "id" = :p2 RETURNING *',
        mssql: 'UPDATE [ar] SET [f] = ([f] / @p1) OUTPUT INSERTED.* WHERE [id] = @p2',
      },
    ],
    [
      'integer arithmetic nests: (n * 3) DIV 2',
      () => ({ n: expr.div(expr.mul(col('n'), 3), 2) }),
      {
        postgresql: 'UPDATE "ar" SET "n" = (("n" * $1::int4) / $2::int4) WHERE "id" = $3 RETURNING *',
        mysql: 'UPDATE `ar` SET `n` = ((`n` * :p1) DIV :p2) WHERE `id` = :p3',
        sqlite: 'UPDATE "ar" SET "n" = (("n" * :p1) / :p2) WHERE "id" = :p3 RETURNING *',
        mssql: 'UPDATE [ar] SET [n] = (([n] * @p1) / @p2) OUTPUT INSERTED.* WHERE [id] = @p3',
      },
    ],
  ];
  for (const [name, data, expected] of RENDERED) {
    for (const [engine, dialect] of ENGINES) {
      it(`${name} (${engine})`, () => {
        assert.equal(update(dialect, data()).sql, expected[engine]);
      });
    }
  }

  for (const [engine, dialect] of ENGINES) {
    it(`a non-integer result is refused on an integer column (${engine})`, () => {
      const refused = e003(/computes a non-integer value .*"n" is an integer column/);
      assert.throws(() => update(dialect, { n: expr.mul(col('n'), 1.5) }), refused);
      assert.throws(() => update(dialect, { n: expr.div(col('f'), 2) }), refused);
      assert.throws(() => update(dialect, { n: col('f') }), e003(/col\("f"\) .*non-integer value/));
      assert.throws(() => update(dialect, { n: expr.coalesce(col('n'), 2.5) }), refused);
      assert.throws(() => update(dialect, { n: expr.case([{ when: { m: 1 }, then: 0.5 }], 0) }), refused);
      // Integer operands, NULL and a non-integer value into a float column are all fine.
      update(dialect, { n: expr.add(col('n'), null) });
      update(dialect, { n: expr.coalesce(col('m'), 2) });
      update(dialect, { f: expr.mul(col('f'), 1.5) });
    });
  }

  it("a bound value's class is part of the cache key", () => {
    for (const [engine, dialect] of ENGINES) {
      const cached = q(dialect, 'ar', { sqlCache: true });
      const asInteger = cached.buildUpdate({ where: { id: 1 }, data: { f: expr.div(col('n'), 2) } }).sql;
      const asDecimal = cached.buildUpdate({ where: { id: 1 }, data: { f: expr.div(col('n'), 2.5) } }).sql;
      if (engine === 'postgresql') {
        assert.match(asInteger, /::int8/);
        assert.match(asDecimal, /::numeric/);
      }
      if (engine === 'mysql') {
        assert.match(asInteger, /DIV/);
        assert.doesNotMatch(asDecimal, /DIV/);
      }
      if (engine === 'postgresql' || engine === 'mysql') assert.notEqual(asInteger, asDecimal, engine);
    }
  });
});

// ---------------------------------------------------------------------------
// optimisticLock on deletes
// ---------------------------------------------------------------------------

describe('optimisticLock is refused on delete and deleteMany', () => {
  for (const [engine, dialect] of ENGINES) {
    it(engine, () => {
      const lock = { field: 'version', expected: 3 };
      assert.throws(
        () => q(dialect).buildDelete({ where: { id: 1 }, optimisticLock: lock }),
        e003(
          /`optimisticLock` is an `update` option and delete on "ar" does not apply it.*where: \{ id, version: expected \}/,
        ),
      );
      assert.throws(
        () => q(dialect).buildDeleteMany({ where: { id: 1 }, optimisticLock: lock }),
        e003(/deleteMany on "ar" does not apply it\. Put the expected version in `where` \(`version: expected`\)/),
      );
      // The suggested equivalent builds.
      q(dialect).buildDelete({ where: { id: 1, version: 3 } });
    });
  }
});

// ---------------------------------------------------------------------------
// Objects, arrays and collections written to a scalar column
// ---------------------------------------------------------------------------

describe('a plain object or array is refused on a scalar column, on every engine', () => {
  const create = (dialect: Dialect, data: Record<string, unknown>) =>
    q(dialect).buildCreate({ data: { id: 1, ...data } });
  for (const [engine, dialect] of ENGINES) {
    it(`numbers (${engine})`, () => {
      assert.throws(() => create(dialect, { n: { a: 1 } }), e003(/Cannot write an object to "ar\.n"/));
      assert.throws(() => create(dialect, { n: [1, 2] }), e003(/Cannot write an array to "ar\.n"/));
      assert.throws(
        () => q(dialect).buildCreateMany({ data: [{ id: 1, n: [1] }] }),
        e003(/Cannot write an array to "ar\.n"/),
      );
      assert.throws(() => update(dialect, { n: { set: { a: 1 } } }), e003(/Cannot write an object to "ar\.n"/));
    });

    it(`text: refused where the engine has a JSON type (${engine})`, () => {
      const write = () => create(dialect, { label: { a: 1 } });
      if (engine === 'postgresql' || engine === 'mysql') {
        assert.throws(write, e003(/Cannot write an object to "ar\.label"/));
      } else {
        // SQLite and SQL Server store JSON in a text column, so it stays JSON text.
        assert.deepEqual(write().params, [1, { a: 1 }]);
      }
    });

    it(`a Map or Set is refused on every column, json included (${engine})`, () => {
      for (const field of ['n', 'label', 'meta']) {
        assert.throws(
          () => create(dialect, { [field]: new Map([['a', 1]]) }),
          e003(/Cannot write a Map .*Object\.fromEntries/),
        );
        assert.throws(() => update(dialect, { [field]: new Set([1]) }), e003(/Cannot write a Set .*\[\.\.\.set\]/));
      }
      assert.throws(() => create(dialect, { meta: jsonValue(new Map()) }), e003(/Cannot write a Map/));
      // A plain object on the json column is still a JSON value.
      create(dialect, { meta: { a: 1 } });
    });
  }
});

// ---------------------------------------------------------------------------
// A pool that records statements and answers writes with chosen rows
// ---------------------------------------------------------------------------

interface Sent {
  sql: string;
  params: unknown[];
}

function fakePool(answer: (sql: string, params: unknown[], index: number) => Record<string, unknown>) {
  const sent: Sent[] = [];
  let writes = 0;
  const query = async (text: unknown, values?: unknown[]) => {
    const sql = typeof text === 'string' ? text : (text as { text: string }).text;
    const params = typeof text === 'string' ? (values ?? []) : ((text as { values?: unknown[] }).values ?? []);
    sent.push({ sql, params });
    if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SET)/i.test(sql)) return { rows: [], rowCount: 0 };
    return answer(sql, params, writes++);
  };
  return { pool: { query, connect: async () => ({ query, release() {} }) } as Any, sent };
}

function qiOn(dialect: Dialect, pool: Any, table = 'people'): Any {
  return new QueryInterface(pool, table, schema(engineOf(dialect)), undefined, {
    dialect,
    sqlCache: false,
    preparedStatements: false,
    warnOnUnlimited: false,
  });
}

// ---------------------------------------------------------------------------
// MySQL: 0 in an AUTO_INCREMENT key
// ---------------------------------------------------------------------------

describe('MySQL create with 0 in an AUTO_INCREMENT key returns the row it inserted', () => {
  const run = async (insertId: number) => {
    const { pool, sent } = fakePool((sql, params) =>
      /^SELECT/.test(sql)
        ? { rows: [{ id: params[0], email: 'z@x', name: 'zero' }], rowCount: 1 }
        : { rows: [], rowCount: 1, insertId },
    );
    const row = await qiOn(mysqlDialect, pool).create({ data: { id: 0, email: 'z@x', name: 'zero' } });
    return { row, reread: sent.find((s) => s.sql.startsWith('SELECT'))! };
  };

  it('re-reads by the id the server assigned', async () => {
    const { row, reread } = await run(42);
    assert.equal(reread.sql, 'SELECT * FROM `people` WHERE `id` = :p1');
    assert.deepEqual(reread.params, [42]);
    assert.equal(row.id, 42);
  });

  it('re-reads by 0 when the server stored the 0 as written (NO_AUTO_VALUE_ON_ZERO)', async () => {
    const { reread } = await run(0);
    assert.deepEqual(reread.params, [0]);
  });

  it('createMany onConflict with 0 in that key is refused before any SQL', async () => {
    const { pool, sent } = fakePool(() => ({ rows: [], rowCount: 0 }));
    await assert.rejects(
      qiOn(mysqlDialect, pool).createMany({
        data: [{ id: 0, name: 'a' }],
        onConflict: { target: ['id'], update: ['name'] },
      }),
      (err: unknown) => {
        assert.ok(err instanceof UnsupportedFeatureError, String(err));
        assert.match((err as Error).message, /with 0 in the AUTO_INCREMENT target field "id"/);
        return true;
      },
    );
    assert.equal(sent.length, 0);
  });
});

// ---------------------------------------------------------------------------
// createMany({ onConflict }): a table row written twice in one call
// ---------------------------------------------------------------------------

describe('createMany onConflict refuses a table row written twice in one call', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ email: `u${i}@x`, name: `n${i}` }));
  const conflict = { target: ['email'], update: ['name'] };
  const isWrite = (sql: string) => /^(MERGE|INSERT)/.test(sql);

  /** SQL Server: each MERGE returns one row per input row, ids numbered across the call. */
  const mssqlRun = async (n: number, repeatIdInSecondStatement: boolean, extra: Record<string, unknown> = {}) => {
    let next = 1;
    const { pool, sent } = fakePool((sql, params, index) => {
      if (!isWrite(sql)) return { rows: [], rowCount: 0 };
      const count = params.length / 2;
      const out = Array.from({ length: count }, (_, i) => ({
        id: next++,
        email: params[i * 2],
        name: params[i * 2 + 1],
      }));
      // The server matched the last row of the second statement to the first row's key.
      if (repeatIdInSecondStatement && index === 1) out[out.length - 1]!.email = 'u0@x';
      // Only the columns the statement's OUTPUT list names, as the server would.
      const listed = [...sql.matchAll(/INSERTED\.\[(\w+)\]/g)].map((m) => m[1]!);
      const shaped =
        listed.length === 0 ? out : out.map((r) => Object.fromEntries(listed.map((c) => [c, r[c as 'id']])));
      return { rows: shaped, rowCount: shaped.length };
    });
    const qi = qiOn(mssqlDialect, pool);
    const result = await qi.createMany({ data: rows(n), onConflict: conflict, ...extra }).then(
      (r: unknown) => r,
      (e: unknown) => e,
    );
    return { result, sqls: sent.map((s) => s.sql) };
  };

  it('SQL Server: across statements, the call is refused and rolled back', async () => {
    const { result, sqls } = await mssqlRun(1500, true);
    const got = Array.isArray(result) ? `${result.length} rows` : String(result);
    assert.ok(result instanceof ValidationError, `expected ValidationError, got ${got}`);
    assert.match((result as Error).message, /two rows in this call share the conflict key \(email\)/);
    assert.equal(sqls.filter(isWrite).length, 2, 'two MERGE statements');
    assert.ok(sqls.includes('ROLLBACK TRANSACTION'), sqls.join('\n'));
    assert.ok(!sqls.includes('COMMIT TRANSACTION'));
  });

  it('SQL Server: distinct rows across statements commit', async () => {
    const { result, sqls } = await mssqlRun(1500, false);
    assert.ok(Array.isArray(result), String(result));
    assert.equal((result as unknown[]).length, 1500);
    assert.equal(sqls.at(-1), 'COMMIT TRANSACTION');
  });

  it('the key is returned for the check and removed from a projected result', async () => {
    const { result, sqls } = await mssqlRun(3, false, { select: { name: true } });
    assert.deepEqual(result, [{ name: 'n0' }, { name: 'n1' }, { name: 'n2' }]);
    assert.match(sqls.find(isWrite)!, /OUTPUT INSERTED\.\[email\], INSERTED\.\[name\]/);
  });

  it('a projection that already returns the key is sent unchanged', async () => {
    const { result, sqls } = await mssqlRun(2, false, { select: { email: true } });
    assert.deepEqual(result, [{ email: 'u0@x' }, { email: 'u1@x' }]);
    assert.match(sqls.find(isWrite)!, /OUTPUT INSERTED\.\[email\];$/);
  });

  it('one statement returning a row twice (SQLite under NOCASE) is refused', async () => {
    const { pool } = fakePool((sql) =>
      isWrite(sql)
        ? {
            rows: [
              { id: 1, email: 'Q@x', name: 'first' },
              { id: 1, email: 'Q@x', name: 'last' },
            ],
            rowCount: 2,
          }
        : { rows: [], rowCount: 0 },
    );
    await assert.rejects(
      qiOn(sqliteDialect, pool).createMany({
        data: [
          { email: 'Q@x', name: 'first' },
          { email: 'q@x', name: 'last' },
        ],
        onConflict: conflict,
      }),
      e003(/two rows in this call share the conflict key \(email\)/),
    );
  });

  it('running one built statement twice does not count the first run against the second', async () => {
    const { pool } = fakePool(() => ({ rows: [{ id: 1, email: 'a@x', name: 'a' }], rowCount: 1 }));
    const deferred = qiOn(postgresDialect, pool).buildCreateMany({
      data: [{ email: 'a@x', name: 'a' }],
      onConflict: conflict,
    });
    const result = { rows: [{ id: 1, email: 'a@x', name: 'a' }], rowCount: 1 } as Any;
    assert.deepEqual(deferred.transform(result), [{ id: 1, email: 'a@x', name: 'a' }]);
    assert.deepEqual(deferred.transform(result), [{ id: 1, email: 'a@x', name: 'a' }]);
  });

  it('a chunked call whose rows cannot be identified is refused before any SQL', async () => {
    const { pool, sent } = fakePool(() => ({ rows: [], rowCount: 0 }));
    // The update assigns the target and the primary key, so a written row can change key between statements.
    await assert.rejects(
      qiOn(mssqlDialect, pool).createMany({
        data: Array.from({ length: 1500 }, (_, i) => ({ id: i, email: `u${i}@x` })),
        onConflict: { target: ['email'], update: ['id', 'email'] },
      }),
      e003(/take more than one statement here \(at most \d+ per statement\).*Pass at most \d+ rows per call/),
    );
    assert.equal(sent.length, 0);
  });
});
