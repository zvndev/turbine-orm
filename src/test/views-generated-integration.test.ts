/**
 * turbine-orm — WS-H / H3 + H4 integration (real Postgres catalog)
 *
 * Creates a table with a STORED generated column, a view, and a materialized
 * view, then asserts introspection flags them correctly and that writes to the
 * view / generated column are rejected. Gated by DATABASE_URL — absent, every
 * test reports as skipped (never failed).
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/views-generated-integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { ValidationError } from '../errors.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping views/generated-columns integration tests: DATABASE_URL not set');
}

const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

const DDL = `
  DROP MATERIALIZED VIEW IF EXISTS ws_h_line_totals;
  DROP VIEW IF EXISTS ws_h_expensive_lines;
  DROP TABLE IF EXISTS ws_h_lines;
  CREATE TABLE ws_h_lines (
    id bigserial PRIMARY KEY,
    qty integer NOT NULL,
    price numeric NOT NULL,
    total numeric GENERATED ALWAYS AS (qty * price) STORED
  );
  INSERT INTO ws_h_lines (qty, price) VALUES (2, 5), (3, 10);
  CREATE VIEW ws_h_expensive_lines AS SELECT id, qty, total FROM ws_h_lines WHERE total > 10;
  CREATE MATERIALIZED VIEW ws_h_line_totals AS SELECT id, total FROM ws_h_lines;
`;

const CLEANUP = `
  DROP MATERIALIZED VIEW IF EXISTS ws_h_line_totals;
  DROP VIEW IF EXISTS ws_h_expensive_lines;
  DROP TABLE IF EXISTS ws_h_lines;
`;

describe('WS-H H3+H4 integration: generated columns + views', () => {
  let pool: pg.Pool;
  let schema: SchemaMetadata;
  let db: TurbineClient;

  before(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL! });
    await pool.query(DDL);
    schema = await introspect({ connectionString: DATABASE_URL!, includeViews: true });
    db = new TurbineClient({ connectionString: DATABASE_URL!, warnOnUnlimited: false }, schema);
    await db.connect();
  });

  after(async () => {
    if (db) await db.disconnect();
    if (pool) {
      await pool.query(CLEANUP);
      await pool.end();
    }
  });

  it('flags the STORED generated column', () => {
    const total = schema.tables.ws_h_lines!.columns.find((c) => c.name === 'total');
    assert.ok(total, 'total column introspected');
    assert.equal(total!.isGeneratedStored, true);
    assert.ok(total!.generationExpression && total!.generationExpression.length > 0);
  });

  it('flags the view and materialized view as isView', () => {
    assert.equal(schema.tables.ws_h_expensive_lines?.isView, true);
    assert.equal(schema.tables.ws_h_line_totals?.isView, true);
    assert.equal(schema.tables.ws_h_lines?.isView, undefined);
    // matview columns were read from pg_catalog
    assert.deepEqual(schema.tables.ws_h_line_totals!.columns.map((c) => c.name).sort(), ['id', 'total']);
  });

  it('rejects writing the generated column', async () => {
    await assert.rejects(
      () => db.table('ws_h_lines').create({ data: { qty: 1, price: 1, total: 1 } } as never),
      (err: unknown) => err instanceof ValidationError && err.code === 'TURBINE_E003',
    );
  });

  it('allows reads on a view', async () => {
    const rows = await db.table('ws_h_expensive_lines').findMany({});
    assert.ok(Array.isArray(rows));
  });

  it('rejects writes to a view', async () => {
    await assert.rejects(
      () => db.table('ws_h_expensive_lines').create({ data: { qty: 9 } } as never),
      (err: unknown) => err instanceof ValidationError && err.code === 'TURBINE_E003' && /view/i.test(err.message),
    );
  });
});
