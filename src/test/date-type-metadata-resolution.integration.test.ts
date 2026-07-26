/**
 * turbine-orm, stored-value proof for column type resolution (live Postgres)
 *
 * The build-only suite (date-type-metadata-resolution.test.ts) pins the bound
 * PARAM. This one pins what the DATABASE actually stores, which is the only
 * assertion the bug could not fool: a `Date` bound to a zone-less `timestamp` /
 * `date` column with an unresolved column type is serialized by the driver in
 * the process's time zone, and Turbine's own read path shifts it back by the
 * same offset, so a turbine-only round trip reports the value you wrote while
 * the column is off by hours to psql or any other reader. Every assertion here
 * therefore reads the column back AS TEXT through a raw pg client.
 *
 * The metadata shape under test is the reported one: table-level
 * `dialectTypes` / `pgTypes` intact, per-column `dialectType` / `pgType`
 * stripped. Under a UTC process every cell passes trivially; run it under a
 * non-UTC zone (`TZ=America/New_York`) for the discriminating version.
 *
 * Run: TZ=America/New_York DATABASE_URL=postgres://... \
 *        npx tsx --test src/test/date-type-metadata-resolution.integration.test.ts
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
  console.log('⚠ Skipping date-type resolution integration tests: DATABASE_URL not set');
}

const DDL = `
DROP TABLE IF EXISTS tzres_run CASCADE;
DROP TABLE IF EXISTS tzres_schedule CASCADE;
CREATE TABLE tzres_schedule (
  id          SERIAL PRIMARY KEY,
  last_run    TIMESTAMP,
  last_run_tz TIMESTAMPTZ,
  day         DATE
);
CREATE TABLE tzres_run (
  id          SERIAL PRIMARY KEY,
  schedule_id INTEGER NOT NULL REFERENCES tzres_schedule(id) ON DELETE CASCADE,
  ran_at      TIMESTAMP
);
`;

/** Chosen so a negative UTC offset moves it onto the previous calendar day. */
const V = new Date('2026-03-15T00:30:00Z');
const TS_UTC = '2026-03-15 00:30:00';
const DAY_UTC = '2026-03-15';

const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

let raw: pg.Client;
let db: TurbineClient;

/** Strip every per-column type, leaving only the table-level type maps. */
function mapsOnly(schema: SchemaMetadata): SchemaMetadata {
  const tables = Object.fromEntries(
    Object.entries(schema.tables).map(([k, t]) => [
      k,
      {
        ...t,
        columns: t.columns.map((c) => ({ ...c, pgType: undefined as unknown as string, dialectType: undefined })),
      },
    ]),
  );
  return { ...schema, tables };
}

/** Read the stored cells back as TEXT, never through Turbine's read path. */
async function stored(id: number): Promise<{ ts: string; day: string; tz: string }> {
  const r = await raw.query(
    `SELECT last_run::text AS ts, day::text AS day, (last_run_tz AT TIME ZONE 'UTC')::text AS tz
       FROM tzres_schedule WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}

function assertUtc(where: string, row: { ts: string; day: string; tz: string }): void {
  assert.equal(row.ts, TS_UTC, `${where}: timestamp stored ${row.ts} (process TZ=${process.env.TZ ?? 'system'})`);
  assert.equal(row.day, DAY_UTC, `${where}: date stored ${row.day}`);
  // timestamptz carries a real instant, so it is unaffected either way.
  assert.equal(row.tz, TS_UTC, `${where}: timestamptz stored ${row.tz}`);
}

describe('date-type resolution from table-level maps (stored values)', () => {
  before(async () => {
    raw = new pg.Client({ connectionString: DATABASE_URL });
    await raw.connect();
    await raw.query(DDL);
    const schema = await introspect({ connectionString: DATABASE_URL as string });
    db = new TurbineClient({ connectionString: DATABASE_URL as string, poolSize: 3 }, mapsOnly(schema));
    await db.connect();
  });

  after(async () => {
    await db?.disconnect();
    await raw?.query('DROP TABLE IF EXISTS tzres_run CASCADE; DROP TABLE IF EXISTS tzres_schedule CASCADE;');
    await raw?.end();
  });

  const t = () => db.table<Record<string, unknown>>('tzres_schedule');
  const DATA = { lastRun: V, day: V, lastRunTz: V };

  it('create stores the UTC calendar fields', async () => {
    const row = (await t().create({ data: { ...DATA } })) as { id: number };
    assertUtc('create', await stored(row.id));
  });

  it('createMany stores the UTC calendar fields', async () => {
    const rows = (await t().createMany({ data: [{ ...DATA }] })) as { id: number }[];
    assert.equal(rows.length, 1);
    assertUtc('createMany', await stored(rows[0]?.id as number));
  });

  it('update and updateMany store the UTC calendar fields', async () => {
    const a = (await t().create({ data: {} })) as { id: number };
    await t().update({ where: { id: a.id }, data: { ...DATA } });
    assertUtc('update', await stored(a.id));

    const b = (await t().create({ data: {} })) as { id: number };
    await t().updateMany({ where: { id: b.id }, data: { ...DATA } });
    assertUtc('updateMany', await stored(b.id));
  });

  it('upsert stores the UTC calendar fields', async () => {
    const row = (await t().create({ data: {} })) as { id: number };
    await t().upsert({ where: { id: row.id }, create: { id: row.id, ...DATA }, update: { ...DATA } });
    assertUtc('upsert', await stored(row.id));
  });

  it('a write inside $transaction stores the UTC calendar fields', async () => {
    const row = await db.$transaction(async (tx) => {
      return (await tx.table<Record<string, unknown>>('tzres_schedule').create({ data: { ...DATA } })) as {
        id: number;
      };
    });
    assertUtc('$transaction', await stored(row.id));
  });

  it('a nested write stores the UTC calendar fields on the child', async () => {
    const parent = (await t().create({ data: { ...DATA, tzresRun: { create: [{ ranAt: V }] } } })) as { id: number };
    const child = await raw.query('SELECT ran_at::text AS ts FROM tzres_run WHERE schedule_id = $1', [parent.id]);
    assert.equal(child.rows[0].ts, TS_UTC, 'nested write: child timestamp stored in local time');
  });

  it('the ORM round trip agrees with the stored text (it always did, that is the trap)', async () => {
    const row = (await t().create({ data: { ...DATA } })) as { id: number; lastRun: Date };
    assert.equal(row.lastRun.toISOString(), V.toISOString());
    assertUtc('round trip', await stored(row.id));
  });
});
