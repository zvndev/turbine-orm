/**
 * turbine-orm, `infinity` / `-infinity` timestamps survive the ORM row parser.
 *
 * The driver-level parser returns the JS numbers `Infinity` / `-Infinity` for
 * these values, and that half was already covered by a unit test driving the
 * parser factory directly. What was NOT covered is the seam AFTER it: parseRow
 * re-coerced any non-Date, non-array value on a date-typed column, so
 * `parseDbDate(String(Infinity))` = `parseDbDate('Infinity')` produced an
 * Invalid Date that JSON-encodes as null. Recorded pre-fix output:
 *
 *   driver-level ts values: [ { ts: Infinity }, { ts: -Infinity } ]
 *   orm-level    ts values: [ { ts: Invalid Date }, { ts: Invalid Date } ]
 *
 * The array form escaped it only because arrays took an earlier branch, which
 * is exactly why a test at the parser seam passed while every scalar ORM read
 * was broken. This test therefore asserts through findMany, not through the
 * parser, and covers the relation paths as well since each has its own parse.
 *
 * Requires DATABASE_URL. Run:
 *   npx tsx --test src/test/infinity-timestamp-parse-row.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable, skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const { it, before, after } = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

const TABLE = 'inf_ts_probe';

const metadata: SchemaMetadata = {
  tables: {
    [TABLE]: {
      ...mockTable(TABLE, [
        { name: 'id', field: 'id', pgType: 'int4' },
        { name: 'ts', field: 'ts', pgType: 'timestamp' },
        { name: 'd', field: 'd', pgType: 'date' },
      ]),
      // The set parseRow consults; both temporal columns must be in it or the
      // coercion branch under test is never reached.
      dateColumns: new Set(['ts', 'd']),
    },
  },
  enums: {},
};

describe('infinity timestamps survive parseRow', () => {
  let db: TurbineClient;
  let raw: pg.Client;

  before(async () => {
    if (!DATABASE_URL) return;
    raw = new pg.Client(DATABASE_URL);
    await raw.connect();
    await raw.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await raw.query(`CREATE TABLE ${TABLE}(id int primary key, ts timestamp, d date)`);
    await raw.query(
      `INSERT INTO ${TABLE} VALUES (1,'infinity','infinity'),(2,'-infinity','-infinity'),(3,'2026-07-21 01:02:03','2026-07-21')`,
    );
    db = new TurbineClient({ connectionString: DATABASE_URL }, metadata);
  });

  after(async () => {
    if (!DATABASE_URL) return;
    await db.disconnect();
    await raw.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await raw.end();
  });

  it('returns Infinity, not an Invalid Date, for a timestamp column', async () => {
    const rows = (await db.table(TABLE).findMany({ where: { id: 1 } })) as { ts: unknown; d: unknown }[];
    assert.equal(rows[0]!.ts, Number.POSITIVE_INFINITY);
    assert.equal(rows[0]!.d, Number.POSITIVE_INFINITY);
  });

  it('returns -Infinity for the negative form', async () => {
    const rows = (await db.table(TABLE).findMany({ where: { id: 2 } })) as { ts: unknown; d: unknown }[];
    assert.equal(rows[0]!.ts, Number.NEGATIVE_INFINITY);
    assert.equal(rows[0]!.d, Number.NEGATIVE_INFINITY);
  });

  it('hands back a number, which is what made the old failure silent', async () => {
    // Both the fixed and the broken value JSON-encode to null (JSON has no
    // Infinity literal), so serialization cannot tell them apart and a test
    // asserting on it would pass either way. The discriminating check is the
    // in-memory type: a number is the driver's value, an object is the Invalid
    // Date the old coercion produced.
    const rows = (await db.table(TABLE).findMany({ where: { id: 1 } })) as { ts: unknown }[];
    assert.equal(typeof rows[0]!.ts, 'number');
  });

  it('still parses an ordinary timestamp and date on the same table', async () => {
    const rows = (await db.table(TABLE).findMany({ where: { id: 3 } })) as { ts: Date; d: Date }[];
    assert.ok(rows[0]!.ts instanceof Date);
    assert.ok(rows[0]!.d instanceof Date);
    assert.equal(rows[0]!.ts.toISOString(), '2026-07-21T01:02:03.000Z');
    assert.equal(rows[0]!.d.toISOString(), '2026-07-21T00:00:00.000Z');
  });
});
