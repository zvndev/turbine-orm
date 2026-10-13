/**
 * Update expressions (`expr.*`, `col()`), build-only: the SQL each engine is
 * sent, the refusals, and the cache and prepared-statement rules. No database.
 *
 * What is pinned here and why:
 *   - Exact SQL per engine for every node kind, because the per-engine
 *     rendering (GREATEST that ignores NULLs on MySQL / SQLite / SQL Server,
 *     `now()` in Turbine's UTC convention) is the whole design and a silent
 *     change to it is a wrong VALUE, not an error. The live differential in
 *     wave-c-expr-differential.integration.test.ts checks the values.
 *   - A JSON look-alike (`JSON.parse(JSON.stringify(node))`) is a value and is
 *     refused on a scalar column, so request data can never become SQL.
 *   - A statement with no expression is byte-identical to the one 0.89 sent.
 *   - `expr.case` and variadics past two operands are UNNAMED prepared
 *     statements (their arity is written into the SQL text).
 *   - MySQL evaluates SET left to right, so assignments are reordered and a
 *     swap is refused (E017).
 *   - PowDB and prisma-compat refuse expressions with a typed error.
 */

// biome-ignore-all lint/suspicious/noThenProperty: expr.case arms are { when, then }, the SQL CASE spelling; never thenable
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TurbineClient } from '../client.js';
import type { Dialect } from '../dialect.js';
import { UnsupportedFeatureError, ValidationError } from '../errors.js';
import { col, expr } from '../index.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import { capabilitiesFromVersion, type PowdbPool, powdbDialect } from '../powdb.js';
import { PowqlInterface } from '../powql.js';
import { createPrismaCompatClient } from '../prisma-compat.js';
import type { ColumnMetadata, PrismaCompatMap, SchemaMetadata, TableMetadata } from '../schema.js';
import { sqliteDialect } from '../sqlite.js';
import { makeQuery, mockTable } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: build-only harness drives untyped args
type Any = any;

function schema(): SchemaMetadata {
  const stats = mockTable('stats', [
    { name: 'id', field: 'id' },
    { name: 'hits', field: 'hits', pgType: 'int4' },
    { name: 'best', field: 'best', pgType: 'int4' },
    { name: 'bonus', field: 'bonus', pgType: 'int4' },
    { name: 'label', field: 'label', pgType: 'text' },
    { name: 'seen_at', field: 'seenAt', pgType: 'timestamptz' },
    { name: 'local_at', field: 'localAt', pgType: 'timestamp' },
    { name: 'day', field: 'day', pgType: 'date' },
    { name: 'ratio', field: 'ratio', pgType: 'numeric' },
    { name: 'meta', field: 'meta', pgType: 'jsonb' },
    { name: 'tags', field: 'tags', pgType: '_text' },
    { name: 'mood', field: 'mood', pgType: 'mood' },
  ]);
  return { tables: { stats }, enums: { mood: ['ok', 'meh'] } } as unknown as SchemaMetadata;
}

const ENGINES: [string, Dialect | undefined][] = [
  ['postgresql', undefined],
  ['sqlite', sqliteDialect],
  ['mysql', mysqlDialect],
  ['mssql', mssqlDialect],
];

function q(dialect?: Dialect, options: Record<string, unknown> = {}): Any {
  return makeQuery('stats', schema(), { ...(dialect ? { dialect } : {}), ...options });
}

function update(dialect: Dialect | undefined, data: Record<string, unknown>) {
  return q(dialect).buildUpdate({ where: { id: 7 }, data });
}

const e003 = (pattern: RegExp) => (err: unknown) => {
  assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
  assert.equal(err.code, 'TURBINE_E003');
  assert.match(err.message, pattern);
  return true;
};

const e017 = (pattern: RegExp) => (err: unknown) => {
  assert.ok(err instanceof UnsupportedFeatureError, `expected UnsupportedFeatureError, got ${String(err)}`);
  assert.equal(err.code, 'TURBINE_E017');
  assert.match(err.message, pattern);
  return true;
};

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('expr builders validate their operands at construction', () => {
  it('arithmetic refuses a string, a boolean, a Date and expr.now()', () => {
    assert.throws(() => expr.add('1' as Any, 2), e003(/expr\.add\(\): operand 1 is a string/));
    assert.throws(() => expr.sub(1, true as Any), e003(/operand 2 is a boolean/));
    assert.throws(() => expr.mul(new Date() as Any, 2), e003(/is a Date\. .*Date arithmetic is not supported/));
    assert.throws(() => expr.div(expr.now() as Any, 2), e003(/is expr\.now\(\)/));
  });

  it('every builder refuses undefined, a non-finite number, an Invalid Date, a plain object and an array', () => {
    assert.throws(() => expr.coalesce(undefined, 1), e003(/operand 1 is undefined\. Pass null for SQL NULL/));
    assert.throws(() => expr.greatest(Number.NaN, 1), e003(/is NaN; a bound number must be finite/));
    assert.throws(() => expr.least(new Date('nope'), new Date()), e003(/is an Invalid Date/));
    assert.throws(() => expr.coalesce({ a: 1 } as Any, 1), e003(/is a plain object/));
    assert.throws(() => expr.coalesce([1] as Any, 1), e003(/is an array/));
  });

  it('a plain { col } object is refused with the col() hint', () => {
    assert.throws(
      () => expr.greatest({ col: 'hits' } as Any, 1),
      e003(/not a column reference\. Build one with col\("hits"\)/),
    );
  });

  it('variadics take 2 to 8 operands and case takes 1 to 16 arms of { when, then }', () => {
    // A one-operand call cannot typecheck; untyped, its missing second operand is the refusal.
    assert.throws(() => (expr.coalesce as Any)(1), e003(/operand 2 is undefined/));
    assert.throws(() => (expr.greatest as Any)(1, 2, 3, 4, 5, 6, 7, 8, 9), e003(/got 9/));
    assert.throws(() => expr.case([]), e003(/1 to 16 arms/));
    assert.throws(() => expr.case([{ when: { hits: 1 } } as Any]), e003(/arm 1 has no then/));
    assert.throws(() => expr.case([{ when: { hits: 1 }, then: 1, else: 2 } as Any]), e003(/unknown key "else"/));
    assert.throws(() => expr.case([{ when: 'hits > 1', then: 1 } as Any]), e003(/arm 1's when is string/));
    assert.throws(() => expr.excluded(''), e003(/non-empty string/));
  });

  it('nodes are frozen, and the brand is not an enumerable (JSON-visible) property', () => {
    const node = expr.add(col('hits'), 1);
    assert.ok(Object.isFrozen(node));
    assert.deepEqual(Object.keys(node), ['kind', 'args']);
    assert.ok(Object.isFrozen(expr.excluded('hits')));
    assert.ok(Object.isFrozen(expr));
  });
});

// ---------------------------------------------------------------------------
// SQL per engine
// ---------------------------------------------------------------------------

/** `[data, { engine: expected SQL }]`, WHERE id = <last param> on every row. */
const RENDERED: [string, () => Record<string, unknown>, Record<string, string>][] = [
  [
    'add',
    () => ({ hits: expr.add(col('hits'), 1) }),
    {
      postgresql: 'UPDATE "stats" SET "hits" = ("hits" + $1::int4) WHERE "id" = $2 RETURNING *',
      sqlite: 'UPDATE "stats" SET "hits" = ("hits" + :p1) WHERE "id" = :p2 RETURNING *',
      mysql: 'UPDATE `stats` SET `hits` = (`hits` + :p1) WHERE `id` = :p2',
      mssql: 'UPDATE [stats] SET [hits] = ([hits] + @p1) OUTPUT INSERTED.* WHERE [id] = @p2',
    },
  ],
  [
    'nested arithmetic',
    () => ({ hits: expr.sub(expr.mul(col('hits'), 2), expr.div(col('bonus'), 3)) }),
    {
      postgresql:
        'UPDATE "stats" SET "hits" = (("hits" * $1::int4) - ("bonus" / $2::int4)) WHERE "id" = $3 RETURNING *',
      sqlite: 'UPDATE "stats" SET "hits" = (("hits" * :p1) - ("bonus" / :p2)) WHERE "id" = :p3 RETURNING *',
      mysql: 'UPDATE `stats` SET `hits` = ((`hits` * :p1) - (`bonus` / :p2)) WHERE `id` = :p3',
      mssql: 'UPDATE [stats] SET [hits] = (([hits] * @p1) - ([bonus] / @p2)) OUTPUT INSERTED.* WHERE [id] = @p3',
    },
  ],
  [
    'coalesce',
    () => ({ label: expr.coalesce(col('label'), 'none') }),
    {
      postgresql: 'UPDATE "stats" SET "label" = COALESCE("label", $1::text) WHERE "id" = $2 RETURNING *',
      sqlite: 'UPDATE "stats" SET "label" = COALESCE("label", :p1) WHERE "id" = :p2 RETURNING *',
      mysql: 'UPDATE `stats` SET `label` = COALESCE(`label`, :p1) WHERE `id` = :p2',
      mssql: 'UPDATE [stats] SET [label] = COALESCE([label], @p1) OUTPUT INSERTED.* WHERE [id] = @p2',
    },
  ],
  [
    'greatest ignores NULLs on every engine',
    () => ({ best: expr.greatest(col('best'), col('hits')) }),
    {
      postgresql: 'UPDATE "stats" SET "best" = GREATEST("best", "hits") WHERE "id" = $1 RETURNING *',
      sqlite:
        'UPDATE "stats" SET "best" = max(COALESCE("best", "hits"), COALESCE("hits", "best")) WHERE "id" = :p1 RETURNING *',
      mysql:
        'UPDATE `stats` SET `best` = GREATEST(COALESCE(`best`, `hits`), COALESCE(`hits`, `best`)) WHERE `id` = :p1',
      mssql:
        'UPDATE [stats] SET [best] = (SELECT MAX(turbine_v) FROM (VALUES ([best]), ([hits])) AS turbine_ext(turbine_v)) ' +
        'OUTPUT INSERTED.* WHERE [id] = @p1',
    },
  ],
  [
    'least of three reuses one placeholder per bound value',
    () => ({ best: expr.least(col('best'), col('hits'), 10) }),
    {
      postgresql: 'UPDATE "stats" SET "best" = LEAST("best", "hits", $1::int4) WHERE "id" = $2 RETURNING *',
      sqlite:
        'UPDATE "stats" SET "best" = min(COALESCE("best", "hits", :p1), COALESCE("hits", "best", :p1), ' +
        'COALESCE(:p1, "best", "hits")) WHERE "id" = :p2 RETURNING *',
      mysql:
        'UPDATE `stats` SET `best` = LEAST(COALESCE(`best`, `hits`, :p1), COALESCE(`hits`, `best`, :p1), ' +
        'COALESCE(:p1, `best`, `hits`)) WHERE `id` = :p2',
      mssql:
        'UPDATE [stats] SET [best] = (SELECT MIN(turbine_v) FROM (VALUES ([best]), ([hits]), (@p1)) AS ' +
        'turbine_ext(turbine_v)) OUTPUT INSERTED.* WHERE [id] = @p2',
    },
  ],
  [
    'case',
    () => ({
      label: expr.case(
        [
          { when: { hits: { gt: 10 } }, then: 'hot' },
          { when: { hits: null }, then: 'new' },
        ],
        'cold',
      ),
    }),
    {
      postgresql:
        'UPDATE "stats" SET "label" = CASE WHEN "hits" > $1 THEN $2::text WHEN "hits" IS NULL THEN $3::text ' +
        'ELSE $4::text END WHERE "id" = $5 RETURNING *',
      sqlite:
        'UPDATE "stats" SET "label" = CASE WHEN "hits" > :p1 THEN :p2 WHEN "hits" IS NULL THEN :p3 ELSE :p4 END ' +
        'WHERE "id" = :p5 RETURNING *',
      mysql:
        'UPDATE `stats` SET `label` = CASE WHEN `hits` > :p1 THEN :p2 WHEN `hits` IS NULL THEN :p3 ELSE :p4 END ' +
        'WHERE `id` = :p5',
      mssql:
        'UPDATE [stats] SET [label] = CASE WHEN [hits] > @p1 THEN @p2 WHEN [hits] IS NULL THEN @p3 ELSE @p4 END ' +
        'OUTPUT INSERTED.* WHERE [id] = @p5',
    },
  ],
  [
    'now() on timestamptz is the instant',
    () => ({ seenAt: expr.now() }),
    {
      postgresql: 'UPDATE "stats" SET "seen_at" = now() WHERE "id" = $1 RETURNING *',
      sqlite: `UPDATE "stats" SET "seen_at" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "id" = :p1 RETURNING *`,
      mysql: 'UPDATE `stats` SET `seen_at` = UTC_TIMESTAMP(3) WHERE `id` = :p1',
      mssql: 'UPDATE [stats] SET [seen_at] = SYSDATETIMEOFFSET() OUTPUT INSERTED.* WHERE [id] = @p1',
    },
  ],
  [
    'now() on a zone-less timestamp is the UTC wall clock',
    () => ({ localAt: expr.now() }),
    {
      postgresql: `UPDATE "stats" SET "local_at" = (now() AT TIME ZONE 'UTC') WHERE "id" = $1 RETURNING *`,
      sqlite: `UPDATE "stats" SET "local_at" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "id" = :p1 RETURNING *`,
      mysql: 'UPDATE `stats` SET `local_at` = UTC_TIMESTAMP(3) WHERE `id` = :p1',
      mssql: 'UPDATE [stats] SET [local_at] = SYSUTCDATETIME() OUTPUT INSERTED.* WHERE [id] = @p1',
    },
  ],
  [
    'now() on a date is the UTC calendar day',
    () => ({ day: expr.now() }),
    {
      postgresql: `UPDATE "stats" SET "day" = (now() AT TIME ZONE 'UTC')::date WHERE "id" = $1 RETURNING *`,
      sqlite: `UPDATE "stats" SET "day" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "id" = :p1 RETURNING *`,
      mysql: 'UPDATE `stats` SET `day` = UTC_DATE() WHERE `id` = :p1',
      mssql: 'UPDATE [stats] SET [day] = CAST(SYSUTCDATETIME() AS date) OUTPUT INSERTED.* WHERE [id] = @p1',
    },
  ],
  [
    'col() alone copies a column',
    () => ({ best: col('hits') }),
    {
      postgresql: 'UPDATE "stats" SET "best" = "hits" WHERE "id" = $1 RETURNING *',
      sqlite: 'UPDATE "stats" SET "best" = "hits" WHERE "id" = :p1 RETURNING *',
      mysql: 'UPDATE `stats` SET `best` = `hits` WHERE `id` = :p1',
      mssql: 'UPDATE [stats] SET [best] = [hits] OUTPUT INSERTED.* WHERE [id] = @p1',
    },
  ],
];

describe('each node renders per engine', () => {
  for (const [name, data, expected] of RENDERED) {
    for (const [engine, dialect] of ENGINES) {
      it(`${name} (${engine})`, () => {
        assert.equal(update(dialect, data()).sql, expected[engine]);
      });
    }
  }

  it('bound values come out in emission order, the WHERE value last', () => {
    // Assignments are emitted in the table's column order (hits before best),
    // whatever order the caller wrote them in.
    const built = update(undefined, { best: expr.least(col('best'), col('hits'), 10), hits: expr.add(col('hits'), 2) });
    assert.equal(
      built.sql,
      'UPDATE "stats" SET "hits" = ("hits" + $1::int4), "best" = LEAST("best", "hits", $2::int4) WHERE "id" = $3 RETURNING *',
    );
    assert.deepEqual(built.params, [2, 10, 7]);
  });

  it('PostgreSQL casts every bound leaf to the target column type, so an all-literal call still types', () => {
    const numeric = update(undefined, { ratio: expr.coalesce(1.5, 2) });
    assert.equal(
      numeric.sql,
      'UPDATE "stats" SET "ratio" = COALESCE($1::numeric, $2::numeric) WHERE "id" = $3 RETURNING *',
    );
    const enumTarget = update(undefined, { mood: expr.coalesce(null, 'ok') });
    assert.match(enumTarget.sql, /COALESCE\(\$1::"mood", \$2::"mood"\)/);
    // The other engines bind untyped and infer from the column.
    for (const [engine, dialect] of ENGINES.slice(1)) {
      assert.doesNotMatch(update(dialect, { ratio: expr.coalesce(1.5, 2) }).sql, /::/, engine);
    }
  });

  it('updateMany and upsert take expressions too', () => {
    const many = q().buildUpdateMany({ where: { label: 'x' }, data: { hits: expr.add(col('hits'), 1) } });
    assert.equal(many.sql, 'UPDATE "stats" SET "hits" = ("hits" + $1::int4) WHERE "label" = $2');
    const upsert = q().buildUpsert({
      where: { id: 1 },
      create: { id: 1, hits: 5 },
      update: { hits: expr.add(col('hits'), expr.excluded('hits')) },
    });
    // The incoming row of a one-row upsert IS `create`, so excluded binds its value
    // and the existing row is qualified (EXCLUDED is in scope too).
    assert.equal(
      upsert.sql,
      'INSERT INTO "stats" ("id", "hits") VALUES ($1, $2) ON CONFLICT ("id") DO UPDATE SET "hits" = ' +
        '("stats"."hits" + $3::int4) RETURNING *',
    );
    assert.deepEqual(upsert.params, [1, 5, 5]);
  });

  it('SQL Server qualifies the target row inside MERGE, for an atomic operator too', () => {
    const upsert = q(mssqlDialect).buildUpsert({
      where: { id: 1 },
      create: { id: 1, hits: 5 },
      update: { hits: { increment: 1 } },
    });
    // `[hits]` alone is ambiguous when the source row S also carries hits (error 209).
    assert.match(upsert.sql, /UPDATE SET \[hits\] = T\.\[hits\] \+ @p3/);
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('refusals', () => {
  it('a JSON look-alike of a node is a value, refused on a scalar column with the expr hint', () => {
    const lookalike = JSON.parse(JSON.stringify(expr.add(col('hits'), 1)));
    assert.throws(
      () => update(undefined, { hits: lookalike }),
      e003(/plain \{ kind: "add", \.\.\. \} object written to "stats\.hits" is not an expression/),
    );
    assert.throws(() => update(undefined, { hits: { col: 'best' } }), e003(/Unknown update operator "col"/));
  });

  it('on a json column a look-alike is the document, stored as a bound value', () => {
    const built = update(undefined, { meta: { kind: 'add', args: [1, 2] } });
    assert.equal(built.sql, 'UPDATE "stats" SET "meta" = $1 WHERE "id" = $2 RETURNING *');
    assert.deepEqual(built.params[0], { kind: 'add', args: [1, 2] });
  });

  it('create and createMany data, and { set }, take values only', () => {
    const message = /cannot be written to "stats\.hits" here: .*not in create \/ createMany data/;
    assert.throws(() => q().buildCreate({ data: { hits: expr.add(1, 2) } }), e003(message));
    assert.throws(() => q().buildCreateMany({ data: [{ hits: col('best') }] }), e003(message));
    assert.throws(() => update(undefined, { hits: { set: expr.add(col('hits'), 1) } }), e003(message));
  });

  it('arithmetic needs numeric columns and numeric operands, wherever they come from', () => {
    assert.throws(
      () => update(undefined, { label: expr.add(col('hits'), 1) }),
      e003(/arithmetic needs a numeric column, and this one is text/),
    );
    assert.throws(
      () => update(undefined, { hits: expr.add(col('label'), 1) }),
      e003(/"label" is not a numeric column/),
    );
    assert.throws(
      () => update(undefined, { hits: expr.add(expr.coalesce('x' as Any, 1), 1) }),
      e003(/arithmetic operand .* is a string/),
    );
  });

  it('json and array columns are neither targets nor operands', () => {
    assert.throws(
      () => update(undefined, { meta: expr.coalesce(col('meta'), null) }),
      e003(/cannot target "stats\.meta": it is a json\/jsonb column/),
    );
    assert.throws(
      () => update(undefined, { label: expr.coalesce(col('meta'), 'x') }),
      e003(/reads a json\/jsonb column/),
    );
    assert.throws(() => update(undefined, { tags: col('tags') }), e003(/it is an array column/));
  });

  it('now() fits temporal columns only', () => {
    assert.throws(() => update(undefined, { label: expr.now() }), e003(/expr\.now\(\) .*"stats\.label" \(text\)/));
    assert.throws(
      () => update(undefined, { hits: expr.now() }),
      e003(/fits timestamp, timestamptz, datetime and date/),
    );
  });

  it('excluded() outside an upsert, an unknown column, and an emptied case arm are refused', () => {
    assert.throws(
      () => update(undefined, { hits: expr.excluded('hits') }),
      e003(/names the incoming row of an upsert/),
    );
    assert.throws(
      () => update(undefined, { hits: expr.add(col('nope'), 1) }),
      e003(/col\("nope"\) .* names no column/),
    );
    assert.throws(
      () => update(undefined, { hits: expr.case([{ when: { label: undefined }, then: 1 }]) }),
      e003(/arm 1's when on "stats" has no predicate \(every key was undefined\)/),
    );
  });

  it('a relation filter in a case arm is refused', () => {
    const s = schema();
    s.tables.stats!.relations = {
      notes: { type: 'hasMany', name: 'notes', from: 'stats', to: 'notes', foreignKey: 'stat_id', referenceKey: 'id' },
    } as TableMetadata['relations'];
    s.tables.notes = mockTable('notes', [
      { name: 'id', field: 'id' },
      { name: 'stat_id', field: 'statId' },
    ]);
    const qi: Any = makeQuery('stats', s);
    assert.throws(
      () =>
        qi.buildUpdate({
          where: { id: 1 },
          data: { hits: expr.case([{ when: { notes: { some: { id: 1 } } }, then: 1 }]) },
        }),
      e003(/"notes" is a relation filter/),
    );
  });
});

// ---------------------------------------------------------------------------
// MySQL assignment order
// ---------------------------------------------------------------------------

describe('MySQL evaluates SET left to right', () => {
  it('an expression reading a column assigned in the same update is emitted before that assignment', () => {
    const built = update(mysqlDialect, { hits: 5, best: expr.add(col('hits'), 1) });
    assert.equal(built.sql, 'UPDATE `stats` SET `best` = (`hits` + :p2), `hits` = :p1 WHERE `id` = :p3');
    assert.deepEqual(built.params, [5, 1, 7]);
    // PostgreSQL reads every right-hand side from the old row, so its order is the caller's.
    assert.equal(
      update(undefined, { hits: 5, best: expr.add(col('hits'), 1) }).sql,
      'UPDATE "stats" SET "hits" = $1, "best" = ("hits" + $2::int4) WHERE "id" = $3 RETURNING *',
    );
  });

  it('a column a case predicate reads counts as read', () => {
    const built = update(mysqlDialect, { label: 'z', hits: expr.case([{ when: { label: 'x' }, then: 1 }], 0) });
    assert.match(built.sql, /^UPDATE `stats` SET `hits` = CASE .* END, `label` = :p4 /);
  });

  it('a swap cannot be ordered and is refused', () => {
    assert.throws(
      () => update(mysqlDialect, { hits: col('best'), best: col('hits') }),
      e017(/MySQL evaluates SET left to right.*Split it into two updates/),
    );
    // The other engines read the old row, so the swap is a plain statement there.
    for (const [engine, dialect] of ENGINES.filter(([n]) => n !== 'mysql')) {
      assert.doesNotThrow(() => update(dialect, { hits: col('best'), best: col('hits') }), engine);
    }
  });
});

// ---------------------------------------------------------------------------
// Cache and prepared statements
// ---------------------------------------------------------------------------

describe('statement cache and prepared-statement names', () => {
  it('two expressions of one shape share a template; different shapes do not', () => {
    const cached: Any = makeQuery('stats', schema(), { sqlCache: true });
    const a = cached.buildUpdate({ where: { id: 1 }, data: { hits: expr.add(col('hits'), 1) } });
    const b = cached.buildUpdate({ where: { id: 2 }, data: { hits: expr.add(col('hits'), 9) } });
    assert.equal(a.sql, b.sql);
    assert.deepEqual(b.params, [9, 2]);
    const c = cached.buildUpdate({ where: { id: 3 }, data: { hits: expr.sub(col('hits'), 9) } });
    assert.match(c.sql, /"hits" - \$1/);
    const d = cached.buildUpdate({ where: { id: 4 }, data: { hits: expr.add(col('bonus'), 9) } });
    assert.match(d.sql, /"bonus" \+ \$1/);
    const plain = cached.buildUpdate({ where: { id: 5 }, data: { hits: 9 } });
    assert.equal(plain.sql, 'UPDATE "stats" SET "hits" = $1 WHERE "id" = $2 RETURNING *');
    const op = cached.buildUpdate({ where: { id: 6 }, data: { hits: { increment: 9 } } });
    assert.equal(op.sql, 'UPDATE "stats" SET "hits" = "hits" + $1 WHERE "id" = $2 RETURNING *');
  });

  it('a case expression on a cache hit binds its own values, in order', () => {
    const cached: Any = makeQuery('stats', schema(), { sqlCache: true });
    const arms = (n: number) => [{ when: { hits: { gt: n } }, then: `over ${n}` }];
    cached.buildUpdate({ where: { id: 1 }, data: { label: expr.case(arms(1), 'low') } });
    const hit = cached.buildUpdate({ where: { id: 2 }, data: { label: expr.case(arms(5), 'small') } });
    assert.deepEqual(hit.params, [5, 'over 5', 'small', 2]);
  });

  it('case and a variadic past two operands are unnamed; a fixed two-operand node keeps its name', () => {
    assert.equal(update(undefined, { label: expr.case([{ when: { hits: 1 }, then: 'a' }]) }).preparedName, '');
    assert.equal(update(undefined, { hits: expr.coalesce(col('hits'), col('bonus'), 0) }).preparedName, '');
    assert.ok(update(undefined, { hits: expr.coalesce(col('hits'), 0) }).preparedName);
    assert.ok(update(undefined, { hits: expr.add(col('hits'), 1) }).preparedName);
  });

  it('a write with no expression is byte-identical to the statement 0.89 sent', () => {
    // Captured by running these calls through the 0.89 source on this fixture.
    const u = update(undefined, { label: 'x', hits: { increment: 2 }, meta: { a: 1 } });
    assert.equal(
      u.sql,
      'UPDATE "stats" SET "hits" = "hits" + $1, "label" = $2, "meta" = $3 WHERE "id" = $4 RETURNING *',
    );
    const many = q(mysqlDialect).buildUpdateMany({ where: { label: 'a' }, data: { hits: { decrement: 1 } } });
    assert.equal(many.sql, 'UPDATE `stats` SET `hits` = `hits` - :p1 WHERE `label` = :p2');
    const upsert = q(sqliteDialect).buildUpsert({
      where: { id: 1 },
      create: { id: 1, label: 'n' },
      update: { label: 'm' },
    });
    assert.equal(
      upsert.sql,
      'INSERT INTO "stats" ("id", "label") VALUES (:p1, :p2) ON CONFLICT ("id") DO UPDATE SET "label" = :p3 RETURNING *',
    );
    const rows = [
      { label: 'a', hits: 1 },
      { label: 'b', hits: 2 },
    ];
    assert.equal(
      q().buildCreateMany({ data: rows }).sql,
      'INSERT INTO "stats" ("hits", "label") SELECT * FROM UNNEST($1::integer[], $2::text[]) RETURNING *',
    );
    assert.equal(
      q().buildCreateMany({ data: rows, skipDuplicates: true }).sql,
      'INSERT INTO "stats" ("hits", "label") SELECT * FROM UNNEST($1::integer[], $2::text[]) ON CONFLICT DO NOTHING RETURNING *',
    );
  });
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StatRow {
  id: number;
  hits: number;
  best: number | null;
  bonus: number;
  label: string | null;
  seenAt: Date;
}

describe('expression types', () => {
  it('nested and variadic expressions typecheck against the column types without type arguments', () => {
    const typed = makeQuery<StatRow>('stats', schema());
    const built = typed.buildUpdate({
      where: { id: 1 },
      data: {
        hits: expr.add(col('hits'), expr.mul(col('bonus'), 2)),
        best: expr.greatest(col('best'), col('hits'), 0),
        label: expr.case([{ when: { hits: { gt: 9 } }, then: 'hot' }], expr.coalesce(col('label'), 'cold')),
        seenAt: expr.now(),
      },
    });
    assert.match(built.sql, /^UPDATE "stats" SET /);
    // @ts-expect-error a Date expression is not storable in a number column
    assert.throws(() => typed.buildUpdate({ where: { id: 1 }, data: { hits: expr.now() } }));
    // @ts-expect-error arithmetic does not take expr.now()
    assert.throws(() => expr.add(expr.now(), 1));
    // A column reference is never inferred as the result type: greatest of two
    // columns nests inside arithmetic.
    assert.ok(expr.add(expr.coalesce(col('hits'), 0), expr.greatest(col('best'), col('bonus'))));
    // @ts-expect-error a string operand for a number column
    typed.buildUpdate({ where: { id: 1 }, data: { hits: expr.coalesce(col('hits'), 'none') } });
  });
});

// ---------------------------------------------------------------------------
// PowDB and prisma-compat
// ---------------------------------------------------------------------------

function powdbHarness() {
  const c = (name: string, field: string, tsType: string, pgType: string, o: Partial<ColumnMetadata> = {}) =>
    ({
      name,
      field,
      pgType,
      tsType,
      nullable: false,
      hasDefault: false,
      isArray: false,
      pgArrayType: '',
      ...o,
    }) as ColumnMetadata;
  const cols = [
    c('id', 'id', 'string', 'text', { hasDefault: true }),
    c('name', 'name', 'string', 'text'),
    c('hits', 'hits', 'number', 'int4'),
  ];
  const meta = {
    name: 'app_user',
    columns: cols,
    columnMap: Object.fromEntries(cols.map((x) => [x.field, x.name])),
    reverseColumnMap: Object.fromEntries(cols.map((x) => [x.name, x.field])),
    dateColumns: new Set<string>(),
    dialectTypes: Object.fromEntries(cols.map((x) => [x.name, x.pgType])),
    pgTypes: Object.fromEntries(cols.map((x) => [x.name, x.pgType])),
    allColumns: cols.map((x) => x.name),
    primaryKey: ['id'],
    uniqueColumns: [['id']],
    relations: {},
    indexes: [],
  } as unknown as TableMetadata;
  const sent: string[] = [];
  const query = (powql: string) => {
    sent.push(powql);
    return Promise.resolve({ rows: [{ id: '1', name: 'Ada', hits: 1 }], rowCount: 1 });
  };
  const pool = {
    capabilities: capabilitiesFromVersion('0.18.0'),
    retryStaleReads: false,
    readonly: false,
    query,
    connect: () => Promise.resolve({ query, release() {} }),
  } as unknown as PowdbPool;
  const qi: Any = new PowqlInterface(pool, 'app_user', { enums: {}, tables: { app_user: meta } }, [], {
    warnOnUnlimited: false,
    dialect: powdbDialect,
  });
  return { qi, sent };
}

describe('PowDB', () => {
  it('refuses an expression in update data (E017) before sending anything', async () => {
    const { qi, sent } = powdbHarness();
    await assert.rejects(
      qi.update({ where: { id: '1' }, data: { hits: expr.add(col('hits'), 1) } }),
      e017(/update expressions/),
    );
    await assert.rejects(
      qi.updateMany({ where: { name: 'a' }, data: { name: col('id') } }),
      e017(/update expressions/),
    );
    await assert.rejects(
      qi.upsert({ where: { id: '1' }, create: { id: '1', hits: 1 }, update: { hits: expr.excluded('hits') } }),
      e017(/update expressions/),
    );
    assert.deepEqual(sent, []);
  });

  it("refuses an expression in a value position with the SQL engines' E003", async () => {
    const { qi, sent } = powdbHarness();
    await assert.rejects(
      qi.create({ data: { name: 'a', hits: expr.add(1, 2) } }),
      e003(/not in create \/ createMany data/),
    );
    await assert.rejects(
      qi.createMany({ data: [{ name: 'a', hits: col('hits') }] }),
      e003(/not in create \/ createMany data/),
    );
    assert.deepEqual(sent, []);
  });
});

describe('prisma-compat', () => {
  it('refuses an expression in write data (E017): its field names are not translated', async () => {
    const calls: unknown[] = [];
    const table = () =>
      new Proxy(
        {},
        {
          get: (_t, method) => (args: unknown) => {
            calls.push([method, args]);
            return Promise.resolve({ id: 1 });
          },
        },
      );
    const db = {
      schema: { enums: {}, tables: { stats: schema().tables.stats } },
      table,
      $transaction: (fn: Any) => fn({ table }),
    } as unknown as TurbineClient;
    const map: PrismaCompatMap = {
      enums: {},
      models: {
        Stat: {
          table: 'stats',
          accessor: 'stats',
          fields: { id: 'id', hits: 'hits', label: 'label' },
          relations: {},
          compoundUniques: {},
        },
      },
    } as unknown as PrismaCompatMap;
    const compat: Any = createPrismaCompatClient(db, map);
    await assert.rejects(
      compat.Stat.update({ where: { id: 1 }, data: { hits: expr.add(col('hits'), 1) } }),
      e017(/an update expression .* in "hits" on model "Stat"/),
    );
    await assert.rejects(
      compat.Stat.updateMany({ where: { id: 1 }, data: { label: col('hits') } }),
      e017(/prisma-compat/),
    );
    assert.deepEqual(calls, []);
  });
});
