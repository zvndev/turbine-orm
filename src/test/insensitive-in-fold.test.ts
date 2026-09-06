/**
 * turbine-orm: `mode: 'insensitive'` folds the column and the list operands
 * with the SAME function, or refuses.
 *
 * THE RULE, and it is the only thing these tests assert: for one operand on one
 * engine, `equals` and `in` must not return DIFFERENT rows. Either they agree,
 * or the operator is refused. A refusal is a visible outcome the caller can act
 * on; a different row is not.
 *
 * The rule was broken by folding the two sides with two different functions.
 * The column went through the ENGINE's `LOWER` and the list elements went
 * through JavaScript's `toLowerCase()`, which is not the same alphabet:
 * SQLite's `LOWER` is ASCII-only, so over the rows `CAFÉ` and `café` the
 * operand `'CAFÉ'` selected
 *
 *     equals  ->  CAFÉ      (both sides folded by SQLite's ASCII LOWER)
 *     in      ->  café      (elements folded by JavaScript)
 *
 * with no error, on every non-ASCII letter rather than on an exotic codepoint.
 *
 * PostgreSQL folds both sides inside the statement (`LOWER(col) IN (SELECT
 * LOWER(v) FROM unnest($n::text[]) ...)`), keeping the list ONE bound array so
 * the statement text stays independent of its length. No other dialect can
 * express that from here: each unpacks a bound IN list in a subquery of its own
 * shape whose projection the where builder cannot reach, and one placeholder
 * per element would make the SQL text a function of the list length, which the
 * template cache keys on. So they refuse with E017.
 *
 * Three layers:
 *  1. The engine-differential rule, run live on in-process SQLite (always) and
 *     on PostgreSQL (when DATABASE_URL is set).
 *  2. Build-only refusals per dialect, on the SQL-build path AND on the
 *     cache-hit param-collect path.
 *  3. Anti-regression: nothing else about `in` changed on any engine.
 *
 * Run: npx tsx --test src/test/insensitive-in-fold.test.ts
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { describe, it, it as nodeIt } from 'node:test';
import { TurbineErrorCode, UnsupportedFeatureError } from '../errors.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { introspectSqliteDatabase, sqliteDialect, turbineSqlite } from '../sqlite.js';
import { makeQuery, mockTable } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: test harness plumbing
type Any = any;

// `node:sqlite` is a builtin only on Node >= 22.5. Probed WITHOUT a static
// import so this file LOADS on Node 20 (the unit matrix's lowest leg) and skips
// only its SQLite arm, rather than crashing the lane with
// ERR_UNKNOWN_BUILTIN_MODULE and taking the dialect refusals down with it.
// createRequire is anchored on cwd so it resolves the builtin identically in
// any module system.
const DatabaseSync: (new (path: string) => DatabaseSyncType) | undefined = (() => {
  try {
    return createRequire(process.cwd())('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();

/**
 * The SQLite arm's `it`. Only the LIVE differential needs the engine; the
 * per-dialect refusals below read `sqliteDialect`, a plain object, and run
 * everywhere. Registered as skipped rather than omitted, so the reporter shows
 * the gap instead of a smaller green total.
 */
const sqliteIt: typeof nodeIt = DatabaseSync
  ? nodeIt
  : (((name: string) =>
      nodeIt(name, { skip: 'turbine-orm/sqlite requires node:sqlite (Node >= 22.5)' }, () => {})) as typeof nodeIt);

/**
 * Rows whose case variants differ OUTSIDE ASCII, which is exactly where two
 * fold functions come apart. `Ada` / `ADA` is the ASCII control: it agrees
 * under either fold, so a suite made only of ASCII names would have passed
 * against the defect.
 */
const NAMES = ['CAFÉ', 'café', 'STRASSE', 'straße', 'İstanbul', 'istanbul', 'ıstanbul', 'Ada', 'ADA'];

/** Every stored spelling doubles as an operand: the fold has to survive both. */
const OPERANDS = NAMES;

interface Engine {
  readonly name: string;
  /** Row ids matching `where`, ascending, or the thrown error. */
  ids(where: Record<string, unknown>): Promise<number[]>;
  close(): Promise<void>;
}

async function sqliteEngine(): Promise<Engine> {
  // Unreachable when the probe found nothing: every caller is a `sqliteIt`.
  if (!DatabaseSync) throw new Error('node:sqlite is absent; this arm should have been skipped');
  const handle = new DatabaseSync(':memory:');
  handle.exec('CREATE TABLE folk (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  const insert = handle.prepare('INSERT INTO folk (id, name) VALUES (?, ?)');
  for (const [i, n] of NAMES.entries()) insert.run(i + 1, n);
  const client = turbineSqlite(handle, introspectSqliteDatabase(handle), { warnOnUnlimited: false });
  return {
    name: 'sqlite',
    async ids(where) {
      const rows = (await (client.table('folk') as Any).findMany({ where, orderBy: { id: 'asc' } })) as {
        id: number;
      }[];
      return rows.map((r) => r.id);
    },
    close: () => client.disconnect(),
  };
}

/**
 * ONE assertion, applied to every engine: for this operand, `equals` and `in`
 * agree, or `in` is refused. Returns whether the engine served the operator, so
 * the caller can pin that the refusal is not universal.
 */
async function assertEqualsAndInAgree(engine: Engine, operand: string): Promise<boolean> {
  const expected = await engine.ids({ name: { equals: operand, mode: 'insensitive' } });
  try {
    const actual = await engine.ids({ name: { in: [operand], mode: 'insensitive' } });
    assert.deepEqual(
      actual,
      expected,
      `${engine.name}: equals and in returned different rows for ${JSON.stringify(operand)}`,
    );
    return true;
  } catch (err) {
    if (!(err instanceof UnsupportedFeatureError)) throw err;
    assert.equal(err.code, TurbineErrorCode.UNSUPPORTED_FEATURE);
    assert.equal(err.dialect, engine.name, 'the refusal names the engine that cannot fold the list');
    return false;
  }
}

/** The same rule for the negated pair: `not` and `notIn`. */
async function assertNotAndNotInAgree(engine: Engine, operand: string): Promise<void> {
  const expected = await engine.ids({ name: { not: operand, mode: 'insensitive' } });
  try {
    const actual = await engine.ids({ name: { notIn: [operand], mode: 'insensitive' } });
    assert.deepEqual(
      actual,
      expected,
      `${engine.name}: not and notIn returned different rows for ${JSON.stringify(operand)}`,
    );
  } catch (err) {
    if (!(err instanceof UnsupportedFeatureError)) throw err;
    assert.equal(err.code, TurbineErrorCode.UNSUPPORTED_FEATURE);
  }
}

// ---------------------------------------------------------------------------
// 1. The rule, live, per engine
// ---------------------------------------------------------------------------

describe('mode: insensitive, equals and in never disagree (sqlite, in-process)', () => {
  sqliteIt('every operand: same rows, or a typed refusal', async () => {
    const engine = await sqliteEngine();
    try {
      let served = 0;
      for (const operand of OPERANDS) {
        if (await assertEqualsAndInAgree(engine, operand)) served++;
        await assertNotAndNotInAgree(engine, operand);
      }
      // Whichever way this engine answers, it must answer the SAME way for
      // every operand: an engine that folds ASCII in SQL and non-ASCII in
      // JavaScript would serve some and disagree on the rest, and "served on
      // some operands" is precisely the shape the defect had.
      assert.ok(served === 0 || served === OPERANDS.length, `served ${served} of ${OPERANDS.length} operands`);
    } finally {
      await engine.close();
    }
  });

  sqliteIt('a case-SENSITIVE in is untouched and still returns the exact spelling', async () => {
    const engine = await sqliteEngine();
    try {
      assert.deepEqual(await engine.ids({ name: { in: ['CAFÉ'] } }), [1]);
      assert.deepEqual(await engine.ids({ name: { in: ['café'] } }), [2]);
      assert.deepEqual(await engine.ids({ name: { in: ['CAFÉ', 'café'] } }), [1, 2]);
    } finally {
      await engine.close();
    }
  });

  sqliteIt('the operators that fold a SINGLE operand still work on this engine', async () => {
    const engine = await sqliteEngine();
    try {
      // `equals` / `not` / the LIKE family bind one operand the engine can
      // reach, so the refusal must not have widened to them.
      assert.deepEqual(await engine.ids({ name: { equals: 'ada', mode: 'insensitive' } }), [8, 9]);
      assert.deepEqual(await engine.ids({ name: { contains: 'ad', mode: 'insensitive' } }), [8, 9]);
      assert.deepEqual(await engine.ids({ name: { startsWith: 'AD', mode: 'insensitive' } }), [8, 9]);
    } finally {
      await engine.close();
    }
  });
});

const DATABASE_URL = process.env.DATABASE_URL;

describe('mode: insensitive, equals and in never disagree (postgresql, live)', () => {
  it('every operand: same rows, and PostgreSQL actually SERVES the operator', {
    skip: DATABASE_URL ? false : 'DATABASE_URL not set',
  }, async () => {
    const { TurbineClient: Client } = await import('../client.js');
    // A TEMPORARY table inside ONE transaction, deliberately: the fixture
    // needs its own rows, and a real CREATE / DROP in the shared schema races
    // every other suite's `introspect()` (a catalog read that then opens a
    // relation another suite has just dropped). A temp table lives in
    // `pg_temp_*`, which introspection never lists, and the transaction pins
    // it to one connection, so nothing outside this test can see it and there
    // is nothing to clean up.
    const client = new Client(
      { connectionString: DATABASE_URL!, poolSize: 1, warnOnUnlimited: false },
      {
        enums: {},
        tables: {
          folk: mockTable('folk', [
            { name: 'id', field: 'id', pgType: 'int4' },
            { name: 'name', field: 'name', pgType: 'text' },
          ]),
        },
      },
    );
    await client.connect();
    try {
      await client.$transaction(async (tx) => {
        await tx.raw`CREATE TEMP TABLE folk (id int PRIMARY KEY, name text NOT NULL) ON COMMIT DROP`;
        for (const [i, n] of NAMES.entries()) {
          await tx.raw`INSERT INTO folk (id, name) VALUES (${i + 1}, ${n})`;
        }
        const engine: Engine = {
          name: 'postgresql',
          async ids(where) {
            const rows = (await (tx.table('folk') as Any).findMany({ where, orderBy: { id: 'asc' } })) as {
              id: number;
            }[];
            return rows.map((r) => r.id);
          },
          close: async () => {},
        };
        for (const operand of OPERANDS) {
          assert.ok(
            await assertEqualsAndInAgree(engine, operand),
            'PostgreSQL folds the list in SQL, so it must serve the operator, not refuse it',
          );
          await assertNotAndNotInAgree(engine, operand);
        }
        // A multi-element list is the same one bound array, so the agreement
        // must not depend on the list length: a list is the UNION of its
        // elements' `equals`. Derived, never hardcoded, because `lower()` is
        // collation-dependent on PostgreSQL and the rule under test is the
        // AGREEMENT, not which rows a given collation folds together.
        const a = await engine.ids({ name: { equals: 'CAFÉ', mode: 'insensitive' } });
        const b = await engine.ids({ name: { equals: 'STRASSE', mode: 'insensitive' } });
        assert.deepEqual(
          await engine.ids({ name: { in: ['CAFÉ', 'STRASSE'], mode: 'insensitive' } }),
          [...new Set([...a, ...b])].sort((x, y) => x - y),
          'a two-element list is the union of the two single-operand equalities',
        );
      });
    } finally {
      await client.disconnect();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Build-only refusals, per dialect, on BOTH paths
// ---------------------------------------------------------------------------

function schema(): SchemaMetadata {
  const tables: Record<string, TableMetadata> = {};
  tables.folk = mockTable('folk', [
    { name: 'id', field: 'id' },
    { name: 'name', field: 'name', pgType: 'text' },
  ]);
  return { tables, enums: {} };
}

const NON_PG = [
  { name: 'sqlite', dialect: sqliteDialect },
  { name: 'mysql', dialect: mysqlDialect },
  { name: 'mssql', dialect: mssqlDialect },
];

describe('mode: insensitive on in / notIn is refused where the list cannot be folded in SQL', () => {
  for (const engine of NON_PG) {
    it(`${engine.name}: in and notIn throw E017 naming the engine`, () => {
      for (const op of ['in', 'notIn'] as const) {
        const q = makeQuery('folk', schema(), { dialect: engine.dialect });
        assert.throws(
          () => q.buildFindMany({ where: { name: { [op]: ['a'], mode: 'insensitive' } } } as never),
          (err: unknown) => {
            assert.ok(err instanceof UnsupportedFeatureError, `expected E017, got ${String(err)}`);
            assert.equal(err.code, TurbineErrorCode.UNSUPPORTED_FEATURE);
            assert.equal(err.dialect, engine.name);
            assert.match(err.message, new RegExp(`\`${op}\``), 'the message names the operator');
            assert.match(err.message, /OR/, 'and points at the shape that does work');
            return true;
          },
        );
      }
    });

    it(`${engine.name}: the cache-hit param path refuses too, not only the build path`, () => {
      // The two paths are the drift hazard: a warmed template that binds
      // differently from how it was compiled is a silent wrong answer, so the
      // gate lives on both walks, not only the one that emits SQL.
      const q = makeQuery('folk', schema(), { dialect: engine.dialect });
      for (const op of ['in', 'notIn'] as const) {
        assert.throws(
          () => q.collectWhereParams({ name: { [op]: ['a'], mode: 'insensitive' } }, []),
          UnsupportedFeatureError,
        );
      }
    });

    it(`${engine.name}: the refusal is scoped to the list operators`, () => {
      const q = makeQuery('folk', schema(), { dialect: engine.dialect });
      assert.doesNotThrow(() =>
        q.buildFindMany({ where: { name: { equals: 'a', not: 'b', contains: 'c', mode: 'insensitive' } } } as never),
      );
      // And a list WITHOUT the mode is untouched: same SQL as before, and the
      // dialect's own IN form, not the folded one.
      const plain = q.buildFindMany({ where: { name: { in: ['a', 'b'] } } } as never);
      assert.doesNotMatch(plain.sql, /LOWER/i);
      assert.equal(plain.params.length, 1, 'still ONE bound list, not one param per element');
    });
  }

  it('postgresql folds both sides in SQL and is not refused', () => {
    const q = makeQuery('folk', schema());
    const built = q.buildFindMany({ where: { name: { in: ['a', 'b'], mode: 'insensitive' } } } as never);
    assert.match(built.sql, /LOWER\("name"\) IN \(SELECT LOWER\(v\) FROM unnest\(\$1::text\[\]\) AS v\(v\)\)/);
    assert.deepEqual(built.params, [['a', 'b']]);
    // Length-independent: a longer list is the SAME statement text, which is
    // what lets the template cache key ignore the list length.
    const longer = q.buildFindMany({ where: { name: { in: ['a', 'b', 'c', 'd'], mode: 'insensitive' } } } as never);
    assert.equal(longer.sql, built.sql);
    assert.deepEqual(longer.params, [['a', 'b', 'c', 'd']]);
  });

  it('postgresql binds the list VERBATIM: no client-side fold survives anywhere', () => {
    // The elements must reach the engine unchanged, because the engine is what
    // folds them. A lowercased param here would mean the fold happened twice,
    // by two different functions, which is the defect in another costume.
    const q = makeQuery('folk', schema());
    const built = q.buildFindMany({ where: { name: { in: ['CAFÉ', 'İstanbul'], mode: 'insensitive' } } } as never);
    assert.deepEqual(built.params, [['CAFÉ', 'İstanbul']]);
    const warm = q.buildFindMany({ where: { name: { in: ['STRASSE'], mode: 'insensitive' } } } as never);
    assert.equal(warm.sql, built.sql, 'same template');
    assert.deepEqual(warm.params, [['STRASSE']], 'and the warm path binds verbatim too');
  });
});
