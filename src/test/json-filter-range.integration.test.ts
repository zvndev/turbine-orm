/**
 * turbine-orm, JsonFilter numeric range operators against a live PostgreSQL
 *
 * A JSON column is schemaless: the value at one path can be a number in one
 * row and text, a boolean, an object or an array in the next. A numeric
 * comparison (`{ path, gt: n }`) used to cast the extraction with a plain
 * `::numeric`, so ONE such row failed the whole query with `invalid input
 * syntax for type numeric`. Now a value that does not read as a number is
 * NULL and simply does not match, and every value the plain cast compared
 * (a JSON number, or a JSON string holding one) compares exactly as before.
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
];

const DDL = `
DROP TABLE IF EXISTS ${MIXED};
DROP TABLE IF EXISTS ${NUMERIC};
CREATE TABLE ${MIXED} (id INTEGER PRIMARY KEY, data JSONB NOT NULL, doc JSON NOT NULL);
CREATE TABLE ${NUMERIC} (id INTEGER PRIMARY KEY, data JSONB NOT NULL);
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
    db = new TurbineClient({ connectionString: DATABASE_URL as string, poolSize: 2 }, liveSchema());
    await db.connect();
  });

  gate.after(async () => {
    await db?.disconnect();
    await raw?.query(`DROP TABLE IF EXISTS ${MIXED}; DROP TABLE IF EXISTS ${NUMERIC};`);
    await raw?.end();
  });

  const ids = (rows: Record<string, unknown>[]): number[] => rows.map((r) => r.id as number).sort((a, b) => a - b);
  const mixed = () => db.table<Record<string, unknown>>(MIXED);

  gate.it('gt matches numbers and numeric strings, and skips text, booleans, objects, arrays and nulls', async () => {
    const rows = await mixed().findMany({ where: { data: { path: ['score'], gt: 6 } } as never });
    // 12, "7", " 9 ", "1e2" (100). Not 5, -3.5, "abc", true, {}, [], null, missing, "".
    assert.deepEqual(ids(rows), [2, 3, 4, 5]);
  });

  gate.it('gte / lt / lte answer the same way', async () => {
    const t = mixed();
    assert.deepEqual(ids(await t.findMany({ where: { data: { path: ['score'], gte: 7 } } as never })), [2, 3, 4, 5]);
    assert.deepEqual(ids(await t.findMany({ where: { data: { path: ['score'], lt: 7 } } as never })), [1, 12]);
    assert.deepEqual(ids(await t.findMany({ where: { data: { path: ['score'], lte: 7 } } as never })), [1, 3, 12]);
  });

  gate.it('a bounded range with gt and lt together', async () => {
    const rows = await mixed().findMany({ where: { data: { path: ['score'], gt: 0, lt: 10 } } as never });
    assert.deepEqual(ids(rows), [1, 3, 4]);
  });

  gate.it('count and a json (not jsonb) column take the same guard', async () => {
    assert.equal(await mixed().count({ where: { data: { path: ['score'], gt: 6 } } as never }), 4);
    const rows = await mixed().findMany({ where: { doc: { path: ['score'], gt: 6 } } as never });
    assert.deepEqual(ids(rows), [2, 3, 4, 5]);
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
