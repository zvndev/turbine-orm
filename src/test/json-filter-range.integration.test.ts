/**
 * turbine-orm, JsonFilter numeric range operators against a live PostgreSQL
 *
 * A JSON column is schemaless: the value at one path can be a number in one
 * row and text, a boolean, an object or an array in the next. A numeric
 * comparison (`{ path, gt: n }`) used to cast the extraction with a plain
 * `::numeric`, so ONE such row failed the whole query with `invalid input
 * syntax for type numeric`. Values that do not read as numbers on the
 * connected server are skipped. PostgreSQL 16+ digit separators and base
 * prefixes retain the plain cast's behavior on those servers; PostgreSQL
 * 14/15 skip them safely.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/json-filter-range.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable, skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping JsonFilter numeric range integration tests: DATABASE_URL not set');
}

const gate = skipGate(SKIP, 'DATABASE_URL not set');
const MIXED = 'json_range_mixed';
const NUMERIC = 'json_range_numeric';
const VERSIONED = 'json_range_versioned';

// PostgreSQL 16 added these numeric input forms.
const VERSIONED_VALUES = ['1_000', '0x10', '0X_FF', '-0o10', '+0B_1_0', '1_2.3_4e+0_1', '.1_5', '1e1_0'];

/** One row per kind of value a JSON path can hold, plus a row without the key. */
const MIXED_ROWS: [number, string][] = [
  [1, '{"score": 5}'],
  [2, '{"score": 12}'],
  [3, '{"score": "7"}'],
  [4, '{"score": " 9 "}'],
  [5, '{"score": "1e2"}'],
  [6, '{"score": "abc"}'],
  [7, '{"score": true}'],
  [8, '{"score": {"x": 1}}'],
  [9, '{"score": [1, 2]}'],
  [10, '{"score": null}'],
  [11, '{"other": 1}'],
  [12, '{"score": -3.5}'],
  [13, '{"score": ""}'],
  [14, '{"score": "Infinity"}'],
  [15, '{"score": "NaN"}'],
  [16, '{"score": "-inf"}'],
  // A signed NaN is refused by the numeric parser.
  [17, '{"score": "-NaN"}'],
  // Unicode spaces: [[:space:]] matches them in a UTF-8 database, the parser does not.
  [18, '{"score": "\\u20037\\u2003"}'],
  [19, '{"score": "7\\u00a0"}'],
  // ASCII white space the parser does skip.
  [20, '{"score": "\\t8\\n"}'],
  // Malformed separators and prefixes must never reach the cast.
  [21, '{"score": "1_"}'],
  [22, '{"score": "1__0"}'],
  [23, '{"score": "1_.0"}'],
  [24, '{"score": "1._0"}'],
  [25, '{"score": "1e_2"}'],
  [26, '{"score": "1e+_2"}'],
  [27, '{"score": "0x"}'],
  [28, '{"score": "0x_"}'],
  [29, '{"score": "0x__f"}'],
  [30, '{"score": "0x1_"}'],
  [31, '{"score": "0b2"}'],
  [32, '{"score": "0o8"}'],
];

/** Only values the plain cast always accepted, to prove it matches the same rows. */
const NUMERIC_ROWS: [number, string][] = [
  [1, '{"score": 5}'],
  [2, '{"score": 12}'],
  [3, '{"score": "7"}'],
  [4, '{"score": -3.5}'],
  [5, '{"score": 6}'],
  [6, '{"other": 1}'],
  [7, '{"score": null}'],
  [8, '{"score": "Infinity"}'],
  [9, '{"score": "-inf"}'],
  [10, '{"score": "NaN"}'],
  [11, '{"score": "\\t8\\n"}'],
];

const DDL = `
DROP TABLE IF EXISTS ${MIXED};
DROP TABLE IF EXISTS ${NUMERIC};
DROP TABLE IF EXISTS ${VERSIONED};
CREATE TABLE ${MIXED} (id INTEGER PRIMARY KEY, data JSONB NOT NULL, doc JSON NOT NULL);
CREATE TABLE ${NUMERIC} (id INTEGER PRIMARY KEY, data JSONB NOT NULL);
CREATE TABLE ${VERSIONED} (id INTEGER PRIMARY KEY, data JSONB NOT NULL, doc JSON NOT NULL);
`;

function liveSchema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      [MIXED]: mockTable(MIXED, [
        { name: 'id', field: 'id', pgType: 'int4' },
        { name: 'data', field: 'data', pgType: 'jsonb' },
        { name: 'doc', field: 'doc', pgType: 'json' },
      ]),
      [VERSIONED]: mockTable(VERSIONED, [
        { name: 'id', field: 'id', pgType: 'int4' },
        { name: 'data', field: 'data', pgType: 'jsonb' },
        { name: 'doc', field: 'doc', pgType: 'json' },
      ]),
      [NUMERIC]: mockTable(NUMERIC, [
        { name: 'id', field: 'id', pgType: 'int4' },
        { name: 'data', field: 'data', pgType: 'jsonb' },
      ]),
    },
  };
}

describe('live: a numeric JSON range filter skips values that are not numbers', () => {
  let raw: pg.Client;
  let db: TurbineClient;

  gate.before(async () => {
    raw = new pg.Client({ connectionString: DATABASE_URL });
    await raw.connect();
    await raw.query(DDL);
    for (const [id, json] of MIXED_ROWS) {
      await raw.query(`INSERT INTO ${MIXED} (id, data, doc) VALUES ($1, $2::jsonb, $2::json)`, [id, json]);
    }
    for (const [id, json] of NUMERIC_ROWS) {
      await raw.query(`INSERT INTO ${NUMERIC} (id, data) VALUES ($1, $2::jsonb)`, [id, json]);
    }
    for (const [id, value] of VERSIONED_VALUES.entries()) {
      await raw.query(`INSERT INTO ${VERSIONED} (id, data, doc) VALUES ($1, $2::jsonb, $2::json)`, [
        id,
        JSON.stringify({ score: value }),
      ]);
    }
    db = new TurbineClient({ connectionString: DATABASE_URL as string, poolSize: 2 }, liveSchema());
    await db.connect();
  });

  gate.after(async () => {
    await db?.disconnect();
    await raw?.query(
      `DROP TABLE IF EXISTS ${MIXED}; DROP TABLE IF EXISTS ${NUMERIC}; DROP TABLE IF EXISTS ${VERSIONED};`,
    );
    await raw?.end();
  });

  const ids = (rows: Record<string, unknown>[]): number[] => rows.map((r) => r.id as number).sort((a, b) => a - b);
  const mixed = () => db.table<Record<string, unknown>>(MIXED);

  gate.it('gt matches numbers and numeric strings, and skips text, booleans, objects, arrays and nulls', async () => {
    const rows = await mixed().findMany({ where: { data: { path: ['score'], gt: 6 } } as never });
    // 12, "7", " 9 ", "1e2" (100), "Infinity", "NaN" (PostgreSQL sorts NaN above every
    // number), tab/newline around 8. Not 5, -3.5, "-inf", or any value the parser refuses.
    assert.deepEqual(ids(rows), [2, 3, 4, 5, 14, 15, 20]);
  });

  gate.it('Unicode spaces and malformed numeric strings are skipped, never a failed query', async () => {
    const t = mixed();
    for (const op of ['gt', 'gte', 'lt', 'lte'] as const) {
      const rows = await t.findMany({ where: { data: { path: ['score'], [op]: 7 } } as never });
      for (const id of [17, 18, 19, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32])
        assert.ok(!ids(rows).includes(id), `${op}: row ${id} matched`);
    }
  });

  gate.it('PostgreSQL 16+ numeric spellings preserve plain-cast results and are skipped on older servers', async () => {
    const version = await raw.query<{ server_version_num: string }>('SHOW server_version_num');
    const serverVersion = version.rows[0];
    assert.ok(serverVersion, 'SHOW server_version_num returned no row');
    const modern = Number(serverVersion.server_version_num) >= 160000;
    const t = db.table<Record<string, unknown>>(VERSIONED);
    for (const column of ['data', 'doc']) {
      for (const [op, sqlOp, bound] of [
        ['gt', '>', 6],
        ['gte', '>=', 16],
        ['lt', '<', 10],
        ['lte', '<=', -8],
      ] as const) {
        const got = ids(await t.findMany({ where: { [column]: { path: ['score'], [op]: bound } } as never }));
        const expected = modern
          ? (
              await raw.query<{ id: number }>(
                `SELECT id FROM ${VERSIONED} WHERE (${column} #>> '{score}')::numeric ${sqlOp} $1 ORDER BY id`,
                [bound],
              )
            ).rows.map((r) => r.id)
          : [];
        if (modern) assert.ok(expected.length > 0, `${column} ${op}: plain-cast control matched no rows`);
        assert.deepEqual(got, expected, `${column} ${op}`);
      }
    }
  });

  gate.it('gte / lt / lte answer the same way', async () => {
    const t = mixed();
    assert.deepEqual(
      ids(await t.findMany({ where: { data: { path: ['score'], gte: 7 } } as never })),
      [2, 3, 4, 5, 14, 15, 20],
    );
    assert.deepEqual(ids(await t.findMany({ where: { data: { path: ['score'], lt: 7 } } as never })), [1, 12, 16]);
    assert.deepEqual(ids(await t.findMany({ where: { data: { path: ['score'], lte: 7 } } as never })), [1, 3, 12, 16]);
  });

  gate.it('a bounded range with gt and lt together', async () => {
    const rows = await mixed().findMany({ where: { data: { path: ['score'], gt: 0, lt: 10 } } as never });
    assert.deepEqual(ids(rows), [1, 3, 4, 20]);
  });

  gate.it('count and a json (not jsonb) column take the same guard', async () => {
    assert.equal(await mixed().count({ where: { data: { path: ['score'], gt: 6 } } as never }), 7);
    const rows = await mixed().findMany({ where: { doc: { path: ['score'], gt: 6 } } as never });
    assert.deepEqual(ids(rows), [2, 3, 4, 5, 14, 15, 20]);
  });

  gate.it('where every value is numeric, the rows match the plain ::numeric cast exactly', async () => {
    const t = db.table<Record<string, unknown>>(NUMERIC);
    for (const [op, sqlOp, bound] of [
      ['gt', '>', 5],
      ['gte', '>=', 6],
      ['lt', '<', 6],
      ['lte', '<=', -3.5],
    ] as const) {
      const got = ids(await t.findMany({ where: { data: { path: ['score'], [op]: bound } } as never }));
      const plain = await raw.query<{ id: number }>(
        `SELECT id FROM ${NUMERIC} WHERE (data #>> '{score}')::numeric ${sqlOp} $1 ORDER BY id`,
        [bound],
      );
      assert.deepEqual(
        got,
        plain.rows.map((r) => r.id),
        op,
      );
    }
  });
});
