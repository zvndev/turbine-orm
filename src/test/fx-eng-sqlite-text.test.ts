/**
 * Text in SQLite numeric and boolean columns.
 *
 * SQLite's type affinity stores a string it cannot convert as TEXT, even in an
 * INTEGER, REAL or NUMERIC column, where PostgreSQL refuses it at the server.
 * Two consequences, both covered here:
 *
 *   1. The write is refused before any SQL runs (E003), through the dialect's
 *      `checkTextWrite`. The accepted set is checked against SQLite itself, so
 *      the rule cannot drift from what the engine actually converts.
 *   2. A cell that already holds such text (written by raw SQL, or before this
 *      check existed) is decoded in linear time when it is read through a
 *      `with` join. The decoder's pattern used to be quadratic: 100,000 zeros
 *      and an `x` blocked the event loop for about four seconds.
 *
 * Run: npx tsx --test src/test/fx-eng-sqlite-text.test.ts
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe } from 'node:test';
import { ValidationError } from '../errors.js';
import type { SchemaMetadata } from '../schema.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { sqliteDialect } from '../sqlite.js';
import { HAVE_NODE_SQLITE } from './fix-where-engines.js';
import { skipGate } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: tables are driven by name, with no generated types
type Any = any;

const { it } = skipGate(!HAVE_NODE_SQLITE, 'requires node:sqlite (Node >= 22.5)');

/** Strings around every edge of SQLite's numeric literal grammar. */
const PROBES = [
  '12',
  ' 12 ',
  '\t7\n',
  '+5',
  '-5',
  '00012',
  '1e5',
  '1E+5',
  '2e-3',
  '.5',
  '5.',
  '12.5',
  '9007199254740993',
  '9223372036854775808',
  '12345678901234567890.123456789',
  '1.5e400',
  '',
  ' ',
  'abc',
  '12abc',
  'Infinity',
  '-Infinity',
  'NaN',
  'inf',
  '0x10',
  '1_000',
  ' 12',
  '1e',
  '-',
  '.',
  '+',
  '- 5',
  '5 5',
  '1d',
  '1.2.3',
  'e5',
  '١٢',
];

const def = defineSchema({
  fxe_parents: { id: { type: 'integer', primaryKey: true }, name: { type: 'text', notNull: true } },
  fxe_vals: {
    id: { type: 'integer', primaryKey: true },
    parentId: { type: 'integer', references: 'fxe_parents.id' },
    n: { type: 'integer' },
    big: { type: 'bigint' },
    price: { type: 'double' },
    amount: { type: 'numeric' },
    flag: { type: 'boolean' },
    label: { type: 'text' },
    code: { type: 'varchar', maxLength: 20 },
  },
} as never);
const SCHEMA: SchemaMetadata = schemaDefToMetadata(def);

async function open(): Promise<{ db: Any; raw: Any }> {
  const { DatabaseSync } = createRequire(process.cwd())('node:sqlite');
  const { turbineSqlite } = await import('../sqlite.js');
  const { schemaToSQL } = await import('../schema-sql.js');
  const raw = new DatabaseSync(':memory:');
  for (const sql of schemaToSQL(def, { dialect: sqliteDialect })) raw.exec(sql);
  const db = turbineSqlite(raw, SCHEMA, { warnOnUnlimited: false });
  await db.table('fxe_parents').create({ data: { id: 1, name: 'p' } });
  return { db, raw };
}

function assertRefused(err: unknown, column: string): true {
  assert.ok(err instanceof ValidationError, `expected E003, got ${String(err)}`);
  assert.equal(err.code, 'TURBINE_E003');
  assert.match(err.message, new RegExp(`"${column}" on "fxe_vals"`));
  assert.match(err.message, /not a number/);
  return true;
}

describe('SQLite refuses a string its numeric column would keep as text', () => {
  it('the accepted strings are exactly the ones SQLite converts to a number', () => {
    const { DatabaseSync } = createRequire(process.cwd())('node:sqlite');
    const raw = new DatabaseSync(':memory:');
    raw.exec('CREATE TABLE t (i INTEGER, r REAL, n NUMERIC)');
    const insert = raw.prepare('INSERT INTO t VALUES (?, ?, ?)');
    const kinds = raw.prepare(
      'SELECT typeof(i) AS i, typeof(r) AS r, typeof(n) AS n FROM t WHERE rowid = last_insert_rowid()',
    );
    let accepted = 0;
    let refused = 0;
    for (const value of PROBES) {
      insert.run(value, value, value);
      const stored = kinds.get() as Record<'i' | 'r' | 'n', string>;
      for (const [affinity, columnType] of [
        ['i', 'integer'],
        ['r', 'double precision'],
        ['n', 'numeric'],
      ] as const) {
        const keptAsText = stored[affinity] === 'text';
        const refusal = sqliteDialect.checkTextWrite?.('t', affinity, columnType, value);
        assert.equal(
          refusal !== undefined,
          keptAsText,
          `${JSON.stringify(value)} in a column of type ${columnType}: SQLite stores it as ${stored[affinity]}, ` +
            `but checkTextWrite ${refusal === undefined ? 'accepts' : 'refuses'} it`,
        );
        if (keptAsText) refused++;
        else accepted++;
      }
    }
    // Both halves must be populated, or the comparison above proves nothing.
    assert.ok(accepted >= 30 && refused >= 30, `accepted ${accepted}, refused ${refused}`);
  });

  it('text, varchar, json, date and binary columns take any string, and so does an enum whatever its name', () => {
    // An enum column's recorded type is the enum's name. `point_kind` and
    // `print_status` contain INT, which SQLite's affinity rule reads as INTEGER.
    for (const type of [
      'text',
      'varchar(20)',
      'uuid',
      'json',
      'jsonb',
      'date',
      'timestamptz',
      'bytea',
      'interval',
      'point_kind',
      'print_status',
      'boolean_choice',
      'money_bucket',
    ]) {
      assert.equal(sqliteDialect.checkTextWrite?.('t', 'c', type, 'abc'), undefined, type);
    }
  });

  it('every numeric and boolean spelling is checked', () => {
    for (const type of [
      'integer',
      'INTEGER',
      'int',
      'int2',
      'int4',
      'int8',
      'smallint',
      'bigint',
      'tinyint',
      'mediumint',
      'unsigned big int',
      'serial',
      'bigserial',
      'real',
      'float',
      'float4',
      'float8',
      'double',
      'double precision',
      'numeric',
      'numeric(10,2)',
      'DECIMAL(10, 2)',
      'money',
      'bool',
      'boolean',
    ]) {
      assert.notEqual(sqliteDialect.checkTextWrite?.('t', 'c', type, 'abc'), undefined, type);
      assert.equal(sqliteDialect.checkTextWrite?.('t', 'c', type, '12'), undefined, type);
    }
  });

  it('checking a long string is linear', () => {
    const value = `${'0'.repeat(2_000_000)}x`;
    const started = performance.now();
    assert.notEqual(sqliteDialect.checkTextWrite?.('t', 'c', 'integer', value), undefined);
    assert.ok(performance.now() - started < 500, 'the literal check is not linear');
  });

  it('create, createMany, update, updateMany, upsert and a nested create refuse it, and write nothing', async () => {
    const { db, raw } = await open();
    const vals = db.table('fxe_vals');
    const parents = db.table('fxe_parents');
    await vals.create({ data: { id: 1, n: 1 } });
    const attempts: [string, string, () => Promise<unknown>][] = [
      ['create', 'n', () => vals.create({ data: { id: 2, n: 'abc' } })],
      ['create bigint', 'big', () => vals.create({ data: { id: 2, big: '12abc' } })],
      ['create double', 'price', () => vals.create({ data: { id: 2, price: 'Infinity' } })],
      ['create numeric', 'amount', () => vals.create({ data: { id: 2, amount: '' } })],
      ['create boolean', 'flag', () => vals.create({ data: { id: 2, flag: 'true' } })],
      [
        'createMany',
        'n',
        () =>
          vals.createMany({
            data: [
              { id: 2, n: 3 },
              { id: 3, n: 'x' },
            ],
          }),
      ],
      ['update', 'n', () => vals.update({ where: { id: 1 }, data: { n: 'abc' } })],
      ['update set', 'price', () => vals.update({ where: { id: 1 }, data: { price: { set: 'abc' } } })],
      ['updateMany', 'amount', () => vals.updateMany({ where: { id: 1 }, data: { amount: '1,5' } })],
      ['upsert create', 'n', () => vals.upsert({ where: { id: 9 }, create: { id: 9, n: 'abc' }, update: { n: 2 } })],
      ['upsert update', 'n', () => vals.upsert({ where: { id: 1 }, create: { id: 1, n: 2 }, update: { n: 'abc' } })],
      [
        'nested create',
        'n',
        () => parents.create({ data: { id: 2, name: 'q', fxeVals: { create: [{ id: 4, n: 'abc' }] } } }),
      ],
    ];
    for (const [label, column, attempt] of attempts) {
      await assert.rejects(attempt, (err) => assertRefused(err, column), label);
    }
    assert.deepEqual(
      raw
        .prepare('SELECT id, n, typeof(n) AS t FROM fxe_vals ORDER BY id')
        .all()
        .map((r: Any) => ({ ...r })),
      [{ id: 1, n: 1, t: 'integer' }],
      'a refused write left a row behind',
    );
    assert.equal(await parents.count(), 1, 'the refused nested create left its parent behind');
  });

  it('a refusal also fires when the statement comes from the SQL cache', async () => {
    const { db } = await open();
    const vals = db.table('fxe_vals');
    await vals.create({ data: { id: 1, n: '7' } });
    await vals.update({ where: { id: 1 }, data: { n: '8' } });
    await assert.rejects(
      () => vals.update({ where: { id: 1 }, data: { n: 'eight' } }),
      (err) => assertRefused(err, 'n'),
    );
    assert.equal((await vals.findUnique({ where: { id: 1 } })).n, 8);
  });

  it('numeric strings, and any string in a text column, are still written as before', async () => {
    const { db } = await open();
    const vals = db.table('fxe_vals');
    const row = await vals.create({
      data: {
        id: 1,
        n: ' 42 ',
        big: '9007199254740993',
        price: '12.5',
        amount: '0.1',
        flag: '1',
        label: 'abc',
        code: '12abc',
      },
    });
    assert.deepEqual(
      { ...row },
      {
        id: 1,
        parentId: null,
        n: 42,
        big: '9007199254740993',
        price: 12.5,
        amount: 0.1,
        flag: true,
        label: 'abc',
        code: '12abc',
      },
    );
  });
});

describe('SQLite decodes a REAL cell holding text in linear time', () => {
  it('a 300,000-character non-numeric cell read through `with` returns in well under a second', async () => {
    const { db, raw } = await open();
    const junk = `${'0'.repeat(300_000)}x`;
    // Written past Turbine on purpose: this is the state a database can already be in.
    raw.prepare('INSERT INTO fxe_vals (id, parent_id, price) VALUES (1, 1, ?)').run(junk);
    const started = performance.now();
    const [parent] = await db.table('fxe_parents').findMany({ with: { fxeVals: true }, limit: 1 });
    const elapsed = performance.now() - started;
    assert.equal(parent.fxeVals[0].price, junk, 'the cell is returned as stored');
    // The quadratic pattern took about 0.8 s at 40,000 characters and grows
    // with the square, so 300,000 would take most of a minute.
    assert.ok(elapsed < 1_000, `reading one row took ${Math.round(elapsed)} ms`);
  });
});
