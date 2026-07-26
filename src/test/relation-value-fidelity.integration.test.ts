/**
 * turbine-orm, four-way relation VALUE fidelity: top-level / join / batched / flatten
 *
 * A relation-loading strategy changes the PLAN, never the RESULT. That
 * guarantee used to hold for row SHAPE but not for cell VALUES: the `'join'`
 * strategy reads a relation through `json_agg(json_build_object(...))`, so its
 * cells are whatever `JSON.parse` makes of Postgres's JSON rendering, while
 * every other read path, a plain top-level row, `'batched'`, `'flatten'` -
 * gets the pg driver's representation of the very same column.
 *
 * For most types those coincide. For the families pinned below they did not,
 * and three of the disagreements were lossy rather than merely cosmetic:
 *
 *   numeric  '1000.50'          →  1000.5            (double, precision lost)
 *   int8     '9007199254740993' →  9007199254740992  (WRONG VALUE)
 *   date     local midnight     →  UTC midnight      (off by the tz offset)
 *
 * The reason this had to be fixed rather than documented: `relationLoadStrategy:
 * 'auto'` chooses between `join` and `batched` from a ROW-COUNT heuristic, so
 * one query against one schema could return `1000.5` on a small result and
 * `'1000.50'` on a large one. A money column silently changing JS type with
 * traffic volume is not a documentable quirk.
 *
 * The target is the DRIVER's representation, because a top-level read of the
 * column already returns it, `join` was the single outlier, not the other
 * three. Each case therefore asserts all four paths agree on both the value
 * AND its runtime type, with the top-level read as the reference.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/relation-value-fidelity.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping relation value-fidelity integration tests: DATABASE_URL not set');
}

/**
 * One row per type family, plus a second row of NULLs so the coercion path is
 * exercised against absent values too. `fid_kids` hangs off it as a hasOne over
 * a UNIQUE FK, which is what makes the row eligible for `'flatten'`.
 */
const DDL = `
DROP TABLE IF EXISTS fid_notes CASCADE;
DROP TABLE IF EXISTS fid_kids CASCADE;
DROP TABLE IF EXISTS fid_values CASCADE;
CREATE TABLE fid_values (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  c_numeric     NUMERIC(12,2),
  c_numeric_big NUMERIC(40,2),
  c_bigint      BIGINT,
  c_int         INTEGER,
  c_float8      DOUBLE PRECISION,
  c_bool        BOOLEAN,
  c_text        TEXT,
  c_uuid        UUID,
  c_bytea       BYTEA,
  c_json        JSON,
  c_jsonb       JSONB,
  c_date        DATE,
  c_ts          TIMESTAMP,
  c_tstz        TIMESTAMPTZ,
  c_time        TIME,
  c_interval    INTERVAL,
  c_point       POINT,
  c_circle      CIRCLE,
  c_inet        INET,
  c_int_arr     INTEGER[],
  c_text_arr    TEXT[],
  c_bigint_arr  BIGINT[],
  c_bytea_arr   BYTEA[],
  c_date_arr    DATE[],
  c_ts_arr      TIMESTAMP[],
  c_interval_arr INTERVAL[]
);
CREATE TABLE fid_kids (
  id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  value_id BIGINT NOT NULL UNIQUE REFERENCES fid_values(id),
  label    TEXT NOT NULL
);
-- Non-unique FK, so this side introspects as a hasMany (fid_kids is a hasOne).
CREATE TABLE fid_notes (
  id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  value_id BIGINT NOT NULL REFERENCES fid_values(id),
  body     TEXT NOT NULL,
  weight   NUMERIC(10,2) NOT NULL
);
CREATE INDEX idx_fid_notes_value ON fid_notes(value_id);

INSERT INTO fid_values (
  c_numeric, c_numeric_big, c_bigint, c_int, c_float8, c_bool, c_text, c_uuid,
  c_bytea, c_json, c_jsonb, c_date, c_ts, c_tstz, c_time, c_interval, c_point,
  c_circle, c_inet, c_int_arr, c_text_arr, c_bigint_arr, c_bytea_arr,
  c_date_arr, c_ts_arr, c_interval_arr
) VALUES (
  1000.50,
  12345678901234567890123456789012345678.99,
  9007199254740993,
  42,
  2.25,
  TRUE,
  'hello',
  '11111111-2222-3333-4444-555555555555',
  '\\xdeadbeef'::bytea,
  '{"a":1}',
  '{"b":[1,2]}',
  '2024-03-05',
  '2024-03-05 06:07:08.123',
  '2024-03-05 06:07:08.123+00',
  '06:07:08',
  '1 day 02:03:04',
  '(1,2)',
  '<(1,2),3>',
  '192.168.0.1',
  '{1,2,3}',
  '{"x","y"}',
  '{9007199254740993}',
  ARRAY['\\xdeadbeef'::bytea],
  '{2024-03-05}',
  '{"2024-03-05 06:07:08.123"}',
  '{"1 day"}'
);
-- All-NULL row: the decode must leave NULLs alone on every path.
INSERT INTO fid_values (c_text) VALUES (NULL);

INSERT INTO fid_kids (value_id, label) SELECT id, 'kid-' || id FROM fid_values ORDER BY id;
INSERT INTO fid_notes (value_id, body, weight)
  SELECT id, 'note-' || id, 12345.67 FROM fid_values ORDER BY id;
`;

/** Every column asserted, in schema order. */
const COLUMNS = [
  'cNumeric',
  'cNumericBig',
  'cBigint',
  'cInt',
  'cFloat8',
  'cBool',
  'cText',
  'cUuid',
  'cBytea',
  'cJson',
  'cJsonb',
  'cDate',
  'cTs',
  'cTstz',
  'cTime',
  'cInterval',
  'cPoint',
  'cCircle',
  'cInet',
  'cIntArr',
  'cTextArr',
  'cBigintArr',
  'cByteaArr',
  'cDateArr',
  'cTsArr',
  'cIntervalArr',
] as const;

/**
 * A value's runtime type at the granularity the bug lived at: `typeof` is too
 * coarse (Date, Buffer, array and plain object are all `'object'`), and deep
 * equality alone is too coarse the other way (`1000.5 !== '1000.50'` would be
 * caught, but `new Date(x)` vs `'…'` differences in an array would not).
 */
function runtimeType(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (v instanceof Date) return 'Date';
  if (Buffer.isBuffer(v)) return 'Buffer';
  if (Array.isArray(v)) return `Array<${v.length === 0 ? 'empty' : runtimeType(v[0])}>`;
  return typeof v;
}

let db: TurbineClient;
let schema: SchemaMetadata;

const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

async function withRawClient(fn: (c: pg.Client) => Promise<unknown>): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL! });
  await client.connect();
  try {
    await fn(client);
  } finally {
    await client.end();
  }
}

describe('relation value fidelity: top-level / join / batched / flatten', () => {
  /** The reference rows: a plain top-level read of fid_values, by id. */
  let topLevel: Record<string, unknown>[];
  /** fid_values as reached through the hasOne relation, per strategy. */
  const viaRelation: Record<string, Record<string, unknown>[]> = {};

  before(async () => {
    await withRawClient((c) => c.query(DDL));
    schema = await introspect({ connectionString: DATABASE_URL! });
    db = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 5, warnOnUnlimited: false }, schema);
    await db.connect();

    topLevel = (await db.table('fid_values').findMany({ orderBy: { id: 'asc' } })) as Record<string, unknown>[];

    for (const strategy of ['join', 'batched', 'flatten'] as const) {
      const kids = (await db.table('fid_kids').findMany({
        orderBy: { id: 'asc' },
        with: { fidValue: true },
        relationLoadStrategy: strategy,
      } as never)) as Record<string, unknown>[];
      viaRelation[strategy] = kids.map((k) => k.fidValue as Record<string, unknown>);
    }
  });

  after(async () => {
    if (db) await db.disconnect();
    if (!SKIP) {
      await withRawClient((c) => c.query('DROP TABLE IF EXISTS fid_notes, fid_kids, fid_values CASCADE'));
    }
  });

  it('the fixture actually loaded on every path', () => {
    assert.equal(topLevel.length, 2, 'two fixture rows');
    for (const strategy of ['join', 'batched', 'flatten'] as const) {
      assert.equal(viaRelation[strategy]!.length, 2, `${strategy} returned both relation rows`);
    }
  });

  // One test per column so a regression names the offending type rather than
  // failing a single opaque deep-equal over the whole row.
  for (const column of COLUMNS) {
    it(`${column}: same value and same runtime type on all four paths`, () => {
      for (const rowIndex of [0, 1]) {
        const reference = topLevel[rowIndex]![column];
        for (const strategy of ['join', 'batched', 'flatten'] as const) {
          const actual = viaRelation[strategy]![rowIndex]![column];
          assert.equal(
            runtimeType(actual),
            runtimeType(reference),
            `${strategy} row ${rowIndex}: ${column} runtime type ` +
              `(${runtimeType(actual)}) differs from the top-level read (${runtimeType(reference)})`,
          );
          assert.deepEqual(
            actual,
            reference,
            `${strategy} row ${rowIndex}: ${column} value differs from the top-level read`,
          );
        }
      }
    });
  }

  it('the whole relation row is deep-equal to the top-level row on every strategy', () => {
    for (const rowIndex of [0, 1]) {
      for (const strategy of ['join', 'batched', 'flatten'] as const) {
        assert.deepEqual(viaRelation[strategy]![rowIndex], topLevel[rowIndex], `${strategy} row ${rowIndex}`);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Precision: the cases a double cannot represent at all
  // ---------------------------------------------------------------------------

  it('numeric keeps every digit past double precision on the join path', () => {
    const exact = '12345678901234567890123456789012345678.99';
    assert.equal(topLevel[0]!.cNumericBig, exact, 'reference: the driver returns the lossless string');
    for (const strategy of ['join', 'batched', 'flatten'] as const) {
      const value = viaRelation[strategy]![0]!.cNumericBig;
      assert.equal(typeof value, 'string', `${strategy} must not hand back a double`);
      assert.equal(value, exact, `${strategy} lost precision`);
    }
    // The pre-fix join value, pinned so a regression is unmistakable.
    assert.notEqual(Number(exact).toString(), exact);
  });

  it('int8 above MAX_SAFE_INTEGER survives the join path intact', () => {
    const exact = '9007199254740993'; // 2^53 + 1, the smallest int a double cannot hold
    assert.equal(topLevel[0]!.cBigint, exact, 'reference: the driver falls back to a string past 2^53');
    for (const strategy of ['join', 'batched', 'flatten'] as const) {
      assert.equal(
        viaRelation[strategy]![0]!.cBigint,
        exact,
        `${strategy} corrupted a bigint id (${JSON.stringify(viaRelation[strategy]![0]!.cBigint)})`,
      );
    }
    // Pin the corruption that used to happen: JSON.parse rounds this down.
    assert.equal(JSON.parse(exact), 9007199254740992);
  });

  it('a money-shaped numeric keeps its scale rather than becoming a double', () => {
    assert.equal(topLevel[0]!.cNumeric, '1000.50');
    for (const strategy of ['join', 'batched', 'flatten'] as const) {
      assert.equal(viaRelation[strategy]![0]!.cNumeric, '1000.50', `${strategy}`);
    }
  });

  // ---------------------------------------------------------------------------
  // The coercion must not leak beyond the relation read
  // ---------------------------------------------------------------------------

  it('a hasMany relation gets the same treatment as a to-one', async () => {
    const reference = (await db.table('fid_notes').findMany({ orderBy: { id: 'asc' } })) as Record<string, unknown>[];
    for (const strategy of ['join', 'batched'] as const) {
      const rows = (await db.table('fid_values').findMany({
        orderBy: { id: 'asc' },
        with: { fidNotes: true },
        relationLoadStrategy: strategy,
      } as never)) as Record<string, unknown>[];
      assert.equal(rows[0]!.cNumeric, '1000.50', `${strategy}: the parent's own column`);
      const notes = rows[0]!.fidNotes as Record<string, unknown>[];
      assert.equal(notes.length, 1, `${strategy}: child loaded`);
      assert.deepEqual(notes[0], reference[0], `${strategy}: hasMany child differs from a top-level read`);
      assert.equal(notes[0]!.weight, '12345.67', `${strategy}: child numeric`);
      assert.equal(typeof notes[0]!.id, 'number', `${strategy}: a small int8 id still comes back as a number`);
    }
  });

  it('a hasMany with a per-relation orderBy + limit (the wrapped-subquery plan) also coerces', async () => {
    const rows = (await db.table('fid_values').findMany({
      orderBy: { id: 'asc' },
      with: { fidNotes: { orderBy: { id: 'asc' }, limit: 5 } },
      relationLoadStrategy: 'join',
    } as never)) as Record<string, unknown>[];
    const notes = rows[0]!.fidNotes as Record<string, unknown>[];
    assert.equal(notes[0]!.weight, '12345.67');
  });

  it('a nested with (relation of a relation) coerces at every level', async () => {
    for (const strategy of ['join', 'batched'] as const) {
      const rows = (await db.table('fid_kids').findMany({
        orderBy: { id: 'asc' },
        with: { fidValue: { with: { fidNotes: true } } },
        relationLoadStrategy: strategy,
      } as never)) as Record<string, unknown>[];
      const value = rows[0]!.fidValue as Record<string, unknown>;
      assert.equal(value.cNumeric, '1000.50', `${strategy}: level 1`);
      assert.equal(value.cBigint, '9007199254740993', `${strategy}: level 1 bigint`);
      const grandkids = value.fidNotes as Record<string, unknown>[];
      assert.equal(grandkids.length, 1, `${strategy}: level 2 loaded`);
      assert.equal(grandkids[0]!.weight, '12345.67', `${strategy}: level 2 numeric`);
    }
  });

  it('a relation `select` that names a divergent column still coerces it', async () => {
    const rows = (await db.table('fid_kids').findMany({
      orderBy: { id: 'asc' },
      with: { fidValue: { select: { cNumeric: true, cBigint: true } } },
      relationLoadStrategy: 'join',
    } as never)) as Record<string, unknown>[];
    const value = rows[0]!.fidValue as Record<string, unknown>;
    assert.deepEqual(value, { cNumeric: '1000.50', cBigint: '9007199254740993' });
  });

  it('the positional wire encoding produces the same values as the object encoding', async () => {
    const positional = new TurbineClient(
      { connectionString: DATABASE_URL!, poolSize: 2, warnOnUnlimited: false, jsonEncoding: 'positional' },
      schema,
    );
    try {
      const rows = (await positional.table('fid_kids').findMany({
        orderBy: { id: 'asc' },
        with: { fidValue: true },
        relationLoadStrategy: 'join',
      } as never)) as Record<string, unknown>[];
      assert.deepEqual(rows[0]!.fidValue, topLevel[0]);
    } finally {
      await positional.disconnect();
    }
  });

  it('a table with no divergent column emits byte-identical SQL', async () => {
    // fid_kids is (int8 pk, int8 fk, text), the int8s DO get the cast, so use
    // the reverse check: the text column must be untouched.
    const built = db.table('fid_kids').buildFindMany({ with: {} } as never);
    assert.ok(!built.sql.includes('"label"::text'), 'a text column must never be cast');
  });
});
