/**
 * `createMany({ onConflict })`, the multi-row upsert, build-only: the
 * statement each engine is sent, every refusal, and the execution plumbing
 * that a recording pool can observe (no SQL before a refusal, chunking at the
 * bind limit inside one transaction, MySQL's re-read). No database; the live
 * behaviour is in wave-c-upsert.integration.test.ts.
 *
 * The refusals are the contract: a conflict target that is not exactly one
 * full unique key, two rows sharing a key in one call, and on MySQL every
 * shape ON DUPLICATE KEY UPDATE cannot express (a predicate, a global filter,
 * a second unique key in the data, `ignore`), each refused before any SQL.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Dialect } from '../dialect.js';
import { postgresDialect } from '../dialect.js';
import { UnsupportedFeatureError, ValidationError } from '../errors.js';
import { col, expr, UNSAFE } from '../index.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import { powdbDialect } from '../powdb.js';
import { QueryInterface } from '../query/index.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { sqliteDialect } from '../sqlite.js';
import { makeQuery, mockTable } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: build-only harness drives untyped args
type Any = any;

function schema(): SchemaMetadata {
  const counters = mockTable('counters', [
    { name: 'id', field: 'id' },
    { name: 'key', field: 'key', pgType: 'text', unique: true },
    { name: 'tenant_id', field: 'tenantId', pgType: 'text' },
    { name: 'hits', field: 'hits', pgType: 'int4' },
    { name: 'note', field: 'note', pgType: 'text' },
    { name: 'email', field: 'email', pgType: 'text', pii: true },
    { name: 'slug', field: 'slug', pgType: 'text' },
    { name: 'tags', field: 'tags', pgType: '_text' },
  ]);
  // A partial unique index: unique only over the rows its predicate matches.
  counters.indexes = [
    { name: 'counters_slug_live', columns: ['slug'], unique: true, partial: true, definition: '' },
  ] as TableMetadata['indexes'];
  // A composite unique key.
  counters.uniqueColumns.push(['tenant_id', 'note']);
  return { tables: { counters }, enums: {} } as unknown as SchemaMetadata;
}

function q(dialect?: Dialect, options: Record<string, unknown> = {}): Any {
  return makeQuery('counters', schema(), { ...(dialect ? { dialect } : {}), ...options });
}

/**
 * The fixture has a PII column (email), so every default projection is the
 * explicit non-PII list rather than `*`, on the conflict path as on create().
 */
const RETURNING = 'RETURNING "id", "key", "tenant_id", "hits", "note", "slug", "tags"';

const ROWS = [
  { key: 'a', hits: 1 },
  { key: 'b', hits: 2 },
];

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
// Statements
// ---------------------------------------------------------------------------

describe('the statement per engine', () => {
  const update = () => ({ hits: expr.add(col('hits'), expr.excluded('hits')), note: 'seen' });

  it('PostgreSQL: ON CONFLICT on the named key, the existing row qualified, EXCLUDED for the incoming one', () => {
    const built = q().buildCreateMany({ data: ROWS, onConflict: { target: ['key'], update: update() } });
    assert.equal(
      built.sql,
      'INSERT INTO "counters" ("key", "hits") SELECT * FROM UNNEST($1::text[], $2::integer[]) ON CONFLICT ("key") ' +
        `DO UPDATE SET "hits" = ("counters"."hits" + EXCLUDED."hits"), "note" = $3 ${RETURNING}`,
    );
    assert.deepEqual(built.params, [['a', 'b'], [1, 2], 'seen']);
  });

  it('PostgreSQL: an array column takes the VALUES form, conflict clause unchanged', () => {
    const built = q().buildCreateMany({
      data: [{ key: 'a', tags: ['x'] }],
      onConflict: { target: ['key'], update: ['tags'] },
    });
    assert.equal(
      built.sql,
      'INSERT INTO "counters" ("key", "tags") VALUES ($1, $2) ON CONFLICT ("key") DO UPDATE SET "tags" = ' +
        `EXCLUDED."tags" ${RETURNING}`,
    );
  });

  it('SQLite: VALUES with the lowercase excluded row', () => {
    const built = q(sqliteDialect).buildCreateMany({ data: ROWS, onConflict: { target: ['key'], update: update() } });
    assert.equal(
      built.sql,
      'INSERT INTO "counters" ("key", "hits") VALUES (:p1, :p2), (:p3, :p4) ON CONFLICT ("key") DO UPDATE SET ' +
        `"hits" = ("counters"."hits" + excluded."hits"), "note" = :p5 ${RETURNING}`,
    );
  });

  it('MySQL: a row alias for the incoming row, then a re-read by key', () => {
    const built = q(mysqlDialect).buildCreateMany({ data: ROWS, onConflict: { target: ['key'], update: update() } });
    assert.equal(
      built.sql,
      'INSERT INTO `counters` (`key`, `hits`) VALUES (:p1, :p2), (:p3, :p4) AS `turbine_excluded` ON DUPLICATE KEY ' +
        'UPDATE `hits` = (`counters`.`hits` + `turbine_excluded`.`hits`), `note` = :p5',
    );
    assert.equal(typeof built.reselect, 'function');
  });

  it('SQL Server: one MERGE, HOLDLOCK, the target as T and the incoming rows as S', () => {
    const built = q(mssqlDialect).buildCreateMany({ data: ROWS, onConflict: { target: ['key'], update: update() } });
    assert.equal(
      built.sql,
      'MERGE INTO [counters] WITH (HOLDLOCK) AS T USING (VALUES (@p1, @p2), (@p3, @p4)) AS S ([key], [hits]) ON ' +
        '(T.[key] = S.[key]) WHEN MATCHED THEN UPDATE SET [hits] = (T.[hits] + S.[hits]), [note] = @p5 WHEN NOT ' +
        'MATCHED THEN INSERT ([key], [hits]) VALUES (S.[key], S.[hits]) OUTPUT INSERTED.[id], INSERTED.[key], ' +
        'INSERTED.[tenant_id], INSERTED.[hits], INSERTED.[note], INSERTED.[slug], INSERTED.[tags];',
    );
  });

  it('ignore: DO NOTHING on the named key, and MERGE with no matched branch', () => {
    assert.match(
      q().buildCreateMany({ data: ROWS, onConflict: { target: ['key'], ignore: true } }).sql,
      /ON CONFLICT \("key"\) DO NOTHING RETURNING "id"/,
    );
    assert.match(
      q(sqliteDialect).buildCreateMany({ data: ROWS, onConflict: { target: ['key'], ignore: true } }).sql,
      /ON CONFLICT \("key"\) DO NOTHING RETURNING "id"/,
    );
    const merge = q(mssqlDialect).buildCreateMany({ data: ROWS, onConflict: { target: ['key'], ignore: true } }).sql;
    assert.doesNotMatch(merge, /WHEN MATCHED/);
    assert.match(merge, /WHEN NOT MATCHED THEN INSERT/);
  });

  it('the field-list shorthand is expr.excluded per field', () => {
    const list = q().buildCreateMany({ data: ROWS, onConflict: { target: ['key'], update: ['hits'] } });
    const explicit = q().buildCreateMany({
      data: ROWS,
      onConflict: { target: ['key'], update: { hits: expr.excluded('hits') } },
    });
    assert.equal(list.sql, explicit.sql);
    assert.match(list.sql, /DO UPDATE SET "hits" = EXCLUDED\."hits" RETURNING "id"/);
  });

  it('a composite target, in any order, is the key it names', () => {
    const built = q().buildCreateMany({
      data: [{ tenantId: 't', note: 'n', hits: 1 }],
      onConflict: { target: ['note', 'tenantId'], update: ['hits'] },
    });
    assert.match(built.sql, /ON CONFLICT \("note", "tenant_id"\) DO UPDATE/);
  });

  it('where limits the update to existing rows it matches, against the existing row', () => {
    const built = q().buildCreateMany({
      data: ROWS,
      onConflict: { target: ['key'], update: ['hits'], where: { hits: { lt: 10 }, note: undefined } },
    });
    assert.match(built.sql, /DO UPDATE SET "hits" = EXCLUDED\."hits" WHERE "counters"\."hits" < \$3 RETURNING "id"/);
    const merge = q(mssqlDialect).buildCreateMany({
      data: ROWS,
      onConflict: { target: ['key'], update: ['hits'], where: { hits: { lt: 10 } } },
    });
    assert.match(merge.sql, /WHEN MATCHED AND \(T\.\[hits\] < @p5\) THEN UPDATE/);
  });

  it('a global filter guards the conflict-UPDATE (and ANDs with where); skipGlobalFilters: UNSAFE lifts it', () => {
    const filtered = q(undefined, { globalFilters: { counters: { tenantId: 't1' } } });
    const plain = filtered.buildCreateMany({ data: ROWS, onConflict: { target: ['key'], update: ['hits'] } });
    assert.match(plain.sql, /DO UPDATE SET "hits" = EXCLUDED\."hits" WHERE "counters"\."tenant_id" = \$3 RETURNING/);
    const both = filtered.buildCreateMany({
      data: ROWS,
      onConflict: { target: ['key'], update: ['hits'], where: { hits: { lt: 10 } } },
    });
    assert.match(both.sql, /WHERE \("counters"\."hits" < \$3\) AND \("counters"\."tenant_id" = \$4\) RETURNING/);
    const skipped = filtered.buildCreateMany({
      data: ROWS,
      onConflict: { target: ['key'], update: ['hits'] },
      skipGlobalFilters: UNSAFE,
    });
    assert.doesNotMatch(skipped.sql, /WHERE "counters"\."tenant_id"/);
    assert.throws(
      () =>
        filtered.buildCreateMany({
          data: ROWS,
          onConflict: { target: ['key'], update: ['hits'] },
          skipGlobalFilters: true,
        }),
      e003(/must be the `UNSAFE` symbol/),
    );
  });

  it('select / omit narrow RETURNING, and a PII column is never returned by default', () => {
    const narrowed = q().buildCreateMany({
      data: ROWS,
      onConflict: { target: ['key'], update: ['hits'] },
      select: { id: true, hits: true },
    });
    assert.match(narrowed.sql, /RETURNING "id", "hits"$/);
    const byDefault = q().buildCreateMany({ data: ROWS, onConflict: { target: ['key'], update: ['hits'] } });
    assert.doesNotMatch(byDefault.sql, /RETURNING \*$/);
    assert.doesNotMatch(byDefault.sql, /"email"/);
    assert.throws(
      () =>
        q().buildCreateMany({ data: ROWS, onConflict: { target: ['key'], update: ['hits'] }, select: { email: true } }),
      ValidationError,
    );
  });

  it('updatedAt columns are stamped on the conflict-UPDATE unless the update names them', () => {
    const s = schema();
    const touched = s.tables.counters!.columns.find((c) => c.name === 'note')!;
    touched.updatedAt = true;
    const qi: Any = makeQuery('counters', s);
    const built = qi.buildCreateMany({ data: ROWS, onConflict: { target: ['key'], update: ['hits'] } });
    assert.match(built.sql, /DO UPDATE SET "hits" = EXCLUDED\."hits", "note" = \$3/);
  });
});

// ---------------------------------------------------------------------------
// Refusals (all before any SQL)
// ---------------------------------------------------------------------------

describe('refusals', () => {
  it('the target must be exactly the primary key or one full unique key', () => {
    assert.throws(
      () => q().buildCreateMany({ data: ROWS, onConflict: { target: ['hits'], update: ['hits'] } }),
      e003(
        /onConflict\.target \(hits\) is not the primary key or a unique key.*Valid targets: \['id'\], \['key'\], \['tenantId', 'note'\]/,
      ),
    );
    assert.throws(
      () =>
        q().buildCreateMany({
          data: [{ tenantId: 't', hits: 1 }],
          onConflict: { target: ['tenantId'], update: ['hits'] },
        }),
      e003(/is not the primary key or a unique key/),
    );
  });

  it('a partial unique index gets its own message', () => {
    assert.throws(
      () => q().buildCreateMany({ data: [{ slug: 's', hits: 1 }], onConflict: { target: ['slug'], update: ['hits'] } }),
      e003(/is a PARTIAL unique index/),
    );
  });

  it('target shape: a non-empty array of known, distinct field names', () => {
    assert.throws(
      () => q().buildCreateMany({ data: ROWS, onConflict: { target: [], update: ['hits'] } }),
      e003(/non-empty array/),
    );
    assert.throws(
      () => q().buildCreateMany({ data: ROWS, onConflict: { target: 'key', update: ['hits'] } }),
      e003(/non-empty array/),
    );
    assert.throws(
      () => q().buildCreateMany({ data: ROWS, onConflict: { target: ['nope'], update: ['hits'] } }),
      e003(/names "nope", which is not a column/),
    );
    assert.throws(
      () => q().buildCreateMany({ data: ROWS, onConflict: { target: ['key', 'key'], update: ['hits'] } }),
      e003(/names "key" twice/),
    );
  });

  it('option shape: no unknown keys, ignore xor update, ignore is true only', () => {
    assert.throws(
      () => q().buildCreateMany({ data: ROWS, onConflict: { target: ['key'], update: ['hits'], set: 1 } }),
      e003(/has no option "set"/),
    );
    assert.throws(
      () => q().buildCreateMany({ data: ROWS, onConflict: { target: ['key'], ignore: true, update: ['hits'] } }),
      e003(/either ignore: true or update/),
    );
    assert.throws(
      () => q().buildCreateMany({ data: ROWS, onConflict: { target: ['key'], ignore: false } }),
      e003(/takes `true` only/),
    );
    assert.throws(() => q().buildCreateMany({ data: ROWS, onConflict: ['key'] }), e003(/must be \{ target, update \}/));
  });

  it('skipDuplicates and onConflict cannot be combined', () => {
    assert.throws(
      () =>
        q().buildCreateMany({ data: ROWS, skipDuplicates: true, onConflict: { target: ['key'], update: ['hits'] } }),
      e003(/onConflict and skipDuplicates cannot be combined/),
    );
  });

  it('an empty update, or one whose every value is undefined, is refused with the ignore hint', () => {
    for (const update of [[], {}, { hits: undefined }]) {
      assert.throws(
        () => q().buildCreateMany({ data: ROWS, onConflict: { target: ['key'], update } }),
        e003(/onConflict\.update is empty; use onConflict: \{ target, ignore: true \}/),
      );
    }
    assert.throws(
      () => q().buildCreateMany({ data: ROWS, onConflict: { target: ['key'], update: ['hits', 'hits'] } }),
      e003(/names "hits" twice/),
    );
  });

  it('a where whose every key was undefined is refused, not dropped', () => {
    assert.throws(
      () =>
        q().buildCreateMany({
          data: ROWS,
          onConflict: { target: ['key'], update: ['hits'], where: { hits: undefined } },
        }),
      e003(/every key in onConflict\.where was undefined/),
    );
  });

  it('is validated even with no rows: a call is never valid empty and invalid full', () => {
    assert.throws(
      () => q().buildCreateMany({ data: [], onConflict: { target: ['hits'], update: ['hits'] } }),
      ValidationError,
    );
    assert.equal(
      q().buildCreateMany({ data: [], onConflict: { target: ['key'], update: ['hits'] } }).sql,
      'SELECT * FROM "counters" WHERE false',
    );
  });

  it('every row must supply every target field', () => {
    assert.throws(
      () => q().buildCreateMany({ data: [{ hits: 1 }], onConflict: { target: ['key'], update: ['hits'] } }),
      e003(/the target field "key" is missing from the rows/),
    );
    assert.throws(
      () => q().buildCreateMany({ data: ROWS, onConflict: { target: ['key'], update: ['note'] } }),
      e003(/expr\.excluded\("note"\) .* names a field the incoming rows do not supply/),
    );
  });

  it('two rows sharing a conflict key are refused, naming both rows', () => {
    const data = [
      { key: 'a', hits: 1 },
      { key: 'b', hits: 2 },
      { key: 'a', hits: 3 },
    ];
    for (const dialect of [undefined, sqliteDialect, mysqlDialect, mssqlDialect]) {
      assert.throws(
        () => q(dialect).buildCreateMany({ data, onConflict: { target: ['key'], update: ['hits'] } }),
        e003(/rows 0 and 2 share the conflict key \(key\)/),
      );
    }
    // Date keys compare by instant, not by object identity; NULL keys never conflict.
    const s = schema();
    s.tables.counters!.uniqueColumns.push(['note']);
    const qi: Any = makeQuery('counters', s);
    assert.doesNotThrow(() =>
      qi.buildCreateMany({
        data: [
          { note: null, hits: 1 },
          { note: null, hits: 2 },
        ],
        onConflict: { target: ['note'], update: ['hits'] },
      }),
    );
    // Ignore refuses duplicates too: whichever row won would be arbitrary.
    assert.throws(
      () => q().buildCreateMany({ data, onConflict: { target: ['key'], ignore: true } }),
      e003(/share the conflict key/),
    );
  });

  it('createMany() sends nothing when it refuses a duplicate key', async () => {
    const sent: string[] = [];
    const query = async (text: unknown) => {
      sent.push(typeof text === 'string' ? text : String((text as { text: string }).text));
      return { rows: [], rowCount: 0 };
    };
    const qi: Any = new QueryInterface(
      { query, connect: async () => ({ query, release() {} }) } as Any,
      'counters',
      schema(),
    );
    await assert.rejects(
      qi.createMany({ data: [{ key: 'a' }, { key: 'a' }], onConflict: { target: ['key'], ignore: true } }),
      e003(/share the conflict key/),
    );
    assert.deepEqual(sent, []);
  });
});

describe('MySQL refusals: ON DUPLICATE KEY UPDATE fires on any unique key and has no predicate slot', () => {
  const my = (options: Record<string, unknown> = {}) => q(mysqlDialect, options);

  it('ignore, where and a NULL key value are refused', () => {
    assert.throws(
      () => my().buildCreateMany({ data: ROWS, onConflict: { target: ['key'], ignore: true } }),
      e017(/with ignore: true/),
    );
    assert.throws(
      () => my().buildCreateMany({ data: ROWS, onConflict: { target: ['key'], update: ['hits'], where: { hits: 1 } } }),
      e017(/with a where.*no predicate slot/),
    );
    assert.throws(
      () => my().buildCreateMany({ data: [{ key: null, hits: 1 }], onConflict: { target: ['key'], update: ['hits'] } }),
      e017(/NULL in a target field/),
    );
  });

  it('another unique key whose columns are all in the data is refused', () => {
    assert.throws(
      () =>
        my().buildCreateMany({
          data: [{ id: 1, key: 'a', hits: 1 }],
          onConflict: { target: ['key'], update: ['hits'] },
        }),
      e017(/another unique key \(id\)/),
    );
  });

  it('a global filter is refused unless skipGlobalFilters: UNSAFE', () => {
    const filtered = my({ globalFilters: { counters: { tenantId: 't1' } } });
    assert.throws(
      () => filtered.buildCreateMany({ data: ROWS, onConflict: { target: ['key'], update: ['hits'] } }),
      e017(/global filter.*another tenant's row could be updated/),
    );
    assert.doesNotThrow(() =>
      filtered.buildCreateMany({
        data: ROWS,
        onConflict: { target: ['key'], update: ['hits'] },
        skipGlobalFilters: UNSAFE,
      }),
    );
  });

  it('the re-read selects the written keys, projected', async () => {
    const built = my().buildCreateMany({
      data: ROWS,
      onConflict: { target: ['key'], update: ['hits'] },
      select: { key: true, hits: true },
    });
    const statements: [string, unknown[]][] = [];
    await built.reselect(async (sql: string, params: unknown[]) => {
      statements.push([sql, params]);
      // One row per written key, as MySQL answers the re-read.
      return { rows: [{}, {}], rowCount: 2 };
    });
    assert.equal(statements.length, 2);
    assert.deepEqual(statements[1], ['SELECT `key`, `hits` FROM `counters` WHERE `key` IN (:p1, :p2)', ['a', 'b']]);
  });
});

describe('engines without a multi-row upsert', () => {
  it('PowDB has none: E017 naming upsert() per row', () => {
    assert.throws(
      () => q(powdbDialect).buildCreateMany({ data: ROWS, onConflict: { target: ['key'], update: ['hits'] } }),
      e017(/Call upsert\(\) per row inside \$transaction/),
    );
  });

  it('every engine that claims supportsBulkUpsert owns its statement builder (no inherited PostgreSQL grammar)', () => {
    for (const dialect of [sqliteDialect, mysqlDialect, mssqlDialect]) {
      assert.equal(dialect.supportsBulkUpsert, true, dialect.name);
      assert.ok(
        Object.hasOwn(dialect, 'buildBulkUpsertStatement'),
        `${dialect.name} inherits buildBulkUpsertStatement`,
      );
      assert.notEqual(dialect.buildBulkUpsertStatement, postgresDialect.buildBulkUpsertStatement, dialect.name);
    }
    assert.equal(powdbDialect.supportsBulkUpsert, false);
  });
});

// ---------------------------------------------------------------------------
// Execution plumbing
// ---------------------------------------------------------------------------

describe('createMany() past the bind-parameter limit', () => {
  function recording(dialect: Dialect, rows: Record<string, unknown>[] = [{ id: 1 }]) {
    const sent: { sql: string; params: number }[] = [];
    const query = async (text: unknown, values?: unknown[]) => {
      const sql = typeof text === 'string' ? text : (text as { text: string }).text;
      const params = typeof text === 'string' ? (values ?? []) : ((text as { values?: unknown[] }).values ?? []);
      sent.push({ sql, params: params.length });
      return { rows, rowCount: rows.length };
    };
    const qi: Any = new QueryInterface(
      { query, connect: async () => ({ query, release() {} }) } as Any,
      'counters',
      schema(),
      undefined,
      {
        dialect,
        sqlCache: false,
      },
    );
    return { qi, sent };
  }

  it('SQL Server: chunks fill to the 2098 parameters the driver can send, counting the once-per-statement ones, in one transaction', async () => {
    const { qi, sent } = recording(mssqlDialect);
    const data = Array.from({ length: 1500 }, (_, i) => ({ key: `k${i}`, hits: i, note: 'n' }));
    await qi.createMany({
      data,
      onConflict: {
        target: ['key'],
        // Six bound values once per statement: a per-row estimate taken from
        // the whole call's average would overflow the last chunk or two.
        update: {
          hits: expr.add(col('hits'), expr.excluded('hits')),
          note: expr.coalesce(col('note'), 'a', 'b', 'c', 'd', 'e', 'f'),
        },
      },
    });
    assert.deepEqual(
      sent.map((s) => [s.sql.split(' ')[0], s.params]),
      [
        // 697 rows x 3 + 6 = 2097; one more row would be 2100, which the driver
        // cannot send (sp_executesql takes two of SQL Server's 2100).
        ['BEGIN', 0],
        ['MERGE', 2097],
        ['MERGE', 2097],
        ['MERGE', 324],
        ['COMMIT', 0],
      ],
    );
  });

  it('a duplicate key across chunks is refused before the first chunk is sent', async () => {
    const { qi, sent } = recording(mssqlDialect);
    const data = Array.from({ length: 1500 }, (_, i) => ({ key: `k${i % 1400}`, hits: i, note: 'n' }));
    await assert.rejects(
      qi.createMany({ data, onConflict: { target: ['key'], update: ['hits'] } }),
      e003(/rows 0 and 1400 share/),
    );
    assert.deepEqual(sent, []);
  });

  it('MySQL: the write and its re-read run in one transaction', async () => {
    // The re-read answers one row per written key.
    const { qi, sent } = recording(mysqlDialect, [{ id: 1 }, { id: 2 }]);
    await qi.createMany({ data: ROWS, onConflict: { target: ['key'], update: ['hits'] } });
    assert.deepEqual(
      sent.map((s) => s.sql.split(' ')[0]),
      ['START', 'INSERT', 'SELECT', 'COMMIT'],
    );
  });
});
