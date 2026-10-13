/**
 * Operands are validated against their column, on the SQL build AND on the
 * cache-hit param collect, so a warmed template can never bind what a cold
 * build refuses.
 *
 * Three behaviours are pinned here, each with a live check where the old
 * behaviour returned wrong rows rather than failing:
 *   - a value that is not a scalar for the column (an object, an array, `{}`,
 *     a comparison with null) is E003 instead of being bound as JSON text;
 *   - `not: { <operator> }` compiles to `NOT (<inner>)` (it used to bind the
 *     operator object as a value, so `deleteMany` with it matched nearly every
 *     row);
 *   - JSON path `equals` compares the JSON value on PostgreSQL, so 5 and "5"
 *     differ and null, arrays and objects compare as JSON.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { UnsupportedFeatureError, ValidationError } from '../errors.js';
import { introspect } from '../introspect.js';
import { mysqlDialect } from '../mysql.js';
import { col } from '../query/column-ref.js';
import * as whereMod from '../query/where.js';
import type { SchemaMetadata } from '../schema.js';
import { sqliteDialect, turbineSqlite } from '../sqlite.js';
import { mockTable, skipGate } from './helpers.js';
import { accounts, compileWhere, ctxOf } from './where-core-fixture.js';

/** Both halves refuse: the cold build, and the collect a cache hit runs instead. */
function refusedBoth(where: Record<string, unknown>, message: RegExp): void {
  const ctx = ctxOf(accounts());
  for (const [half, run] of [
    ['build', () => whereMod.buildWhereClause(ctx, where, [])],
    ['collect', () => whereMod.collectWhereParams(ctx, where, [])],
  ] as const) {
    assert.throws(run, (err: unknown) => {
      assert.ok(err instanceof ValidationError, `${half}: expected ValidationError, got ${String(err)}`);
      assert.match(err.message, message, `${half}`);
      return true;
    });
  }
}

describe('operand validation: refused', () => {
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ['object at equals', { age: { equals: { a: 1 } } }, /'equals' on "age" for table "accounts": received an object/],
    ['empty object at equals', { age: { equals: {} } }, /received an empty object/],
    ['array at equals', { age: { equals: [1] } }, /'equals' on "age".*received an array/],
    ['null at gt', { age: { gt: null } }, /'gt' on "age".*use equals: null or not: null/],
    ['array at lte', { age: { lte: [3] } }, /'lte' on "age".*received an array/],
    ['in that is not an array', { age: { in: 5 } }, /'in' on "age".*takes an array of values/],
    ['object inside in', { age: { notIn: [1, { a: 1 }] } }, /Invalid element in 'notIn' on "age"/],
    ['non-string contains', { name: { contains: 5 } }, /'contains' on "name".*takes a string/],
    ['bare array on a scalar column', { age: [1, 2] }, /to match any of several values use \{ in: \[\.\.\.\] \}/],
    ['bare unknown operator', { age: { greaterThan: 1 } }, /Unknown operator "greaterThan" on "age"/],
    ['empty filter object', { age: {} }, /Empty filter object on "age" for table "accounts"/],
    ['invalid mode', { name: { contains: 'a', mode: 'INSENSITIVE' } }, /Invalid mode "INSENSITIVE" on "name"/],
    ['empty not', { age: { not: {} } }, /'not' on "age".*received an empty object/],
    ['not with an unknown operator', { age: { not: { greaterThan: 1 } } }, /'not' on "age".*operator object/],
    ['bad operand inside not', { age: { not: { gt: null } } }, /'gt' on "age".*use equals: null or not: null/],
    ['function value', { age: () => 1 }, /Invalid value on "age".*received a function/],
    ['a Map as a bare value', { name: new Map() }, /Invalid value on "name".*received a Map instance/],
    ['a Set at equals', { name: { equals: new Set(['a']) } }, /'equals' on "name".*received a Set instance/],
    ['a RegExp at contains', { name: { contains: /a/ } }, /'contains' on "name".*takes a string/],
    [
      'in a relation filter body',
      { posts: { some: { views: { equals: { a: 1 } } } } },
      /'equals' on "views" for table "posts"/,
    ],
  ];
  for (const [label, where, message] of cases) {
    it(label, () => refusedBoth(where, message));
  }
});

/** Stand-ins for driver wrappers: pg's custom-type protocol, and a decimal library's string form. */
class PgLiteral {
  constructor(private readonly text: string) {}
  toPostgres(): string {
    return this.text;
  }
}
class DecimalLike {
  constructor(private readonly text: string) {}
  toString(): string {
    return this.text;
  }
}

describe('operand validation: accepted', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['number', { age: 5 }],
    ['bigint', { age: 5n }],
    ['string', { name: 'x' }],
    ['Date', { name: new Date(0) }],
    ['Buffer', { name: Buffer.from('x') }],
    ['null equality', { age: null }],
    ['equals null / not null', { age: { equals: null }, score: { not: null } }],
    ['in with a null element', { age: { in: [1, null] } }],
    ['mode-only operator object (optional search)', { name: { mode: 'insensitive' } }],
    ['JSON value on a JSON column', { meta: { a: 1 } }],
    ['array on an array column', { tags: ['a', 'b'] }],
    ['column reference', { age: { lte: col('score') } }],
    ['a class instance that renders itself (toPostgres)', { name: new PgLiteral('x') }],
    ['a class instance that renders itself (toString)', { name: { gt: new DecimalLike('1.5') } }],
  ];
  for (const [label, where] of cases) {
    it(label, () => {
      const out = compileWhere(where);
      assert.deepEqual(out.collectParams, out.buildParams);
    });
  }
});

describe('not with an operator object', () => {
  it('compiles to NOT (<inner>) with the inner params in order', () => {
    const out = compileWhere({ age: { not: { gte: 2, lte: 3 } }, name: { not: { contains: 'x' } } });
    assert.equal(out.sql, 'NOT ("age" >= $1 AND "age" <= $2) AND NOT ("name" LIKE $3 ESCAPE \'\\\')');
    assert.deepEqual(out.buildParams, [2, 3, '%x%']);
    assert.deepEqual(out.collectParams, out.buildParams);
  });

  it('inherits the outer mode', () => {
    const out = compileWhere({ name: { not: { startsWith: 'Al' }, mode: 'insensitive' } });
    assert.match(out.sql ?? '', /^NOT \("name" ILIKE \$1/);
  });

  it('a value and an operator object never share a cache key', () => {
    assert.notEqual(
      compileWhere({ age: { not: 3 } }).fingerprint,
      compileWhere({ age: { not: { gt: 3 } } }).fingerprint,
    );
  });

  it('on a JSON column an object after not is still a JSON value', () => {
    // The negated whole-document equality, never a `>` comparison.
    const out = compileWhere({ meta: { not: { gt: 1 } } });
    assert.equal(out.sql, 'NOT ("meta"::jsonb = $1::jsonb)');
    assert.deepEqual(out.buildParams, ['{"gt":1}']);
    assert.deepEqual(out.collectParams, out.buildParams);
  });
});

describe('JSON path equals', () => {
  const pgQ = () => accounts();
  const sqliteQ = () => accounts({ dialect: sqliteDialect });
  const mysqlQ = () => accounts({ dialect: mysqlDialect });

  it('PostgreSQL compares the typed JSON value at the path', () => {
    const { sql, params } = pgQ().buildFindMany({ where: { meta: { path: ['v'], equals: 5 } } } as never);
    assert.match(sql, /\("meta" #> \$1::text\[\]\)::jsonb = \$2::jsonb/);
    assert.deepEqual(params.slice(0, 2), [['v'], '5']);
  });

  const encodings: [string, unknown, string][] = [
    ['string', '5', '"5"'],
    ['null', null, 'null'],
    ['array', [1, 2], '[1,2]'],
    ['object', { a: 1 }, '{"a":1}'],
    ['boolean', true, 'true'],
    ['bigint', 9007199254740993n, '9007199254740993'],
    ['Date', new Date('2026-01-02T03:04:05.000Z'), '"2026-01-02T03:04:05.000Z"'],
  ];
  for (const [label, value, json] of encodings) {
    it(`PostgreSQL binds a ${label} as JSON text`, () => {
      const { params } = pgQ().buildFindMany({ where: { meta: { path: ['v'], equals: value } } } as never);
      assert.equal(params[1], json);
    });
  }

  it('refuses a non-finite number and a column reference', () => {
    assert.throws(
      () => pgQ().buildFindMany({ where: { meta: { path: ['v'], equals: Number.NaN } } } as never),
      /takes a finite number/,
    );
    assert.throws(
      () => pgQ().buildFindMany({ where: { meta: { path: ['v'], equals: col('id') } } } as never),
      ValidationError,
    );
  });

  for (const [label, value] of [
    ['null', null],
    ['an array', [1]],
    ['an object', { a: 1 }],
  ] as const) {
    it(`SQLite refuses ${label} with E017 instead of matching nothing; MySQL compares it as JSON`, () => {
      assert.throws(
        () => sqliteQ().buildFindMany({ where: { meta: { path: ['v'], equals: value } } } as never),
        UnsupportedFeatureError,
      );
      const { sql, params } = mysqlQ().buildFindMany({ where: { meta: { path: ['v'], equals: value } } } as never);
      assert.match(sql, /JSON_EXTRACT\(`meta`, :p1\) = CAST\(:p2 AS JSON\)/);
      assert.deepEqual(params.slice(0, 2), ['$."v"', JSON.stringify(value)]);
    });
  }

  it('SQLite refuses a boolean (it extracts true as 1) and binds a number natively', () => {
    assert.throws(
      () => sqliteQ().buildFindMany({ where: { meta: { path: ['v'], equals: true } } } as never),
      /extracts JSON true and false as the integers 1 and 0/,
    );
    const { params } = sqliteQ().buildFindMany({ where: { meta: { path: ['v'], equals: 5 } } } as never);
    assert.equal(params[1], 5);
  });
});

// ---------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const live = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

async function runSql(statements: string[]): Promise<void> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  try {
    for (const sql of statements) await pool.query(sql);
  } finally {
    await pool.end();
  }
}

const DOCS: [number, string][] = [
  [1, '{"v": 5}'],
  [2, '{"v": "5"}'],
  [3, '{"v": null}'],
  [4, '{"v": [1, 2]}'],
  [5, '{"v": {"a": 1}}'],
  [6, '{"v": true}'],
  [7, '{"v": "true"}'],
  [8, '{}'],
];

const ids = (rows: { id: number }[]): number[] => rows.map((r) => Number(r.id));

describe('live postgres', () => {
  let db: TurbineClient;
  let schema: SchemaMetadata;

  live.before(async () => {
    await runSql([
      'DROP TABLE IF EXISTS wc_ops, wc_json',
      'CREATE TABLE wc_ops (id int PRIMARY KEY, name text, score int NOT NULL)',
      "INSERT INTO wc_ops VALUES (1, 'alpha', 1), (2, 'beta', 2), (3, NULL, 3), (4, 'alphabet', 4)",
      'CREATE TABLE wc_json (id int PRIMARY KEY, data jsonb NOT NULL)',
      `INSERT INTO wc_json VALUES ${DOCS.map(([id, doc]) => `(${id}, '${doc}')`).join(', ')}`,
    ]);
    schema = await introspect({ connectionString: DATABASE_URL!, include: ['wc_ops', 'wc_json'] });
    db = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 2, warnOnUnlimited: false }, schema);
  });

  live.after(async () => {
    await db?.disconnect();
    await runSql(['DROP TABLE IF EXISTS wc_ops, wc_json']);
  });

  const find = (where: Record<string, unknown>) =>
    db.table<{ id: number }>('wc_ops').findMany({ where, orderBy: { id: 'asc' } } as never);

  live.it('not: { contains } negates the match and, like SQL, excludes NULL', async () => {
    assert.deepEqual(ids(await find({ name: { not: { contains: 'alpha' } } })), [2]);
  });

  live.it('not: { in }, a negated range, and an inherited insensitive mode', async () => {
    assert.deepEqual(ids(await find({ name: { not: { in: ['beta'] } } })), [1, 4]);
    assert.deepEqual(ids(await find({ score: { not: { gte: 2, lte: 3 } } })), [1, 4]);
    assert.deepEqual(ids(await find({ name: { not: { startsWith: 'ALPHA' }, mode: 'insensitive' } })), [2]);
  });

  live.it('deleteMany with not: { lt } deletes only the rows it names', async () => {
    const result = await db.table('wc_ops').deleteMany({ where: { score: { not: { lt: 4 } } } } as never);
    assert.equal(result.count, 1);
    assert.deepEqual(ids(await find({})), [1, 2, 3]);
  });

  live.it('an object at equals is refused before anything runs', async () => {
    await assert.rejects(
      db.table('wc_ops').deleteMany({ where: { score: { equals: { gt: 0 } } } } as never),
      ValidationError,
    );
    assert.deepEqual(ids(await find({})), [1, 2, 3]);
  });

  const json = (where: Record<string, unknown>) =>
    db.table<{ id: number }>('wc_json').findMany({ where: { data: where }, orderBy: { id: 'asc' } } as never);

  const typed: [string, unknown, number[]][] = [
    ['the number 5', 5, [1]],
    ['the string "5"', '5', [2]],
    ['JSON null (a missing key is not null)', null, [3]],
    ['an array', [1, 2], [4]],
    ['an object', { a: 1 }, [5]],
    ['true', true, [6]],
    ['the string "true"', 'true', [7]],
  ];
  for (const [label, value, expected] of typed) {
    live.it(`JSON path equals ${label}`, async () => {
      assert.deepEqual(ids(await json({ path: ['v'], equals: value })), expected);
    });
  }

  live.it('JSON path equals at a nested path', async () => {
    assert.deepEqual(ids(await json({ path: ['v', 'a'], equals: 1 })), [5]);
  });
});

/** node:sqlite is a builtin only on Node >= 22.5; probe without a static import. */
const hasNodeSqlite = (() => {
  try {
    createRequire(process.cwd())('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();
const sqliteGate = skipGate(!hasNodeSqlite, 'turbine-orm/sqlite requires node:sqlite (Node >= 22.5)');

describe('live sqlite', () => {
  sqliteGate.it('JSON path equals compares number and string apart', async () => {
    const { DatabaseSync } = createRequire(process.cwd())('node:sqlite');
    const raw = new DatabaseSync(':memory:');
    raw.exec('CREATE TABLE docs (id INTEGER PRIMARY KEY, data TEXT NOT NULL)');
    for (const [id, doc] of DOCS) raw.prepare('INSERT INTO docs VALUES (?, ?)').run(id, doc);
    const schema: SchemaMetadata = {
      enums: {},
      tables: {
        docs: mockTable('docs', [
          { name: 'id', field: 'id' },
          { name: 'data', field: 'data', pgType: 'jsonb' },
        ]),
      },
    };
    const db = turbineSqlite(raw, schema);
    try {
      const run = async (equals: unknown) =>
        ids(
          (await db
            .table('docs')
            .findMany({ where: { data: { path: ['v'], equals } }, orderBy: { id: 'asc' } } as never)) as {
            id: number;
          }[],
        );
      assert.deepEqual(await run(5), [1]);
      assert.deepEqual(await run('5'), [2]);
      assert.deepEqual(await run('true'), [7]);
    } finally {
      await db.disconnect();
    }
  });
});
