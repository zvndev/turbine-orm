/**
 * turbine-orm, findUnique's fast path matches the row findFirst matches (live Postgres)
 *
 * `findUnique` compiles a plain all-equality where through its own param pusher
 * instead of the general where walker, so the temporal bind rewrite the walker
 * applies (`coerceWhereOperand`) did not reach it. The emitted SQL is identical
 * either way, so nothing errors: a `Date` keyed on a zone-less `timestamp` /
 * `date` / `time` column was serialized by the driver in the PROCESS's zone, the
 * predicate then addressed an instant hours away from the stored one, and the
 * call returned `null` for a row that plainly exists.
 *
 * Every assertion here compares against the cell read back AS TEXT through a raw
 * pg client, and against `findFirst` on the identical predicate, because those
 * are the two things the bug could not fool. Under a UTC process the two paths
 * agree trivially; run under a non-UTC zone for the discriminating version.
 *
 * Run: TZ=America/New_York DATABASE_URL=postgres://... \
 *        npx tsx --test src/test/find-unique-temporal.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { introspect } from '../introspect.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping findUnique temporal integration tests: DATABASE_URL not set');
}

const DDL = `
DROP TABLE IF EXISTS futz_event CASCADE;
CREATE TABLE futz_event (
  id       SERIAL PRIMARY KEY,
  at       TIMESTAMP UNIQUE,
  on_day   DATE UNIQUE,
  at_tz    TIMESTAMPTZ UNIQUE,
  label    TEXT
);
`;

/** Chosen so a negative UTC offset moves it onto the previous calendar day. */
const V = new Date('2026-03-15T00:30:00Z');
const TS_UTC = '2026-03-15 00:30:00';
const DAY_UTC = '2026-03-15';

const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

let raw: pg.Client;
let db: TurbineClient;

describe('findUnique fast path: temporal predicates address the stored value', () => {
  before(async () => {
    raw = new pg.Client({ connectionString: DATABASE_URL });
    await raw.connect();
    await raw.query(DDL);
    const schema = await introspect({ connectionString: DATABASE_URL as string });
    db = new TurbineClient({ connectionString: DATABASE_URL as string, poolSize: 3 }, schema);
    await db.connect();
    await db.table('futz_event').create({ data: { at: V, onDay: V, atTz: V, label: 'seed' } });
  });

  after(async () => {
    await db?.disconnect();
    await raw?.query('DROP TABLE IF EXISTS futz_event CASCADE');
    await raw?.end();
  });

  const t = () => db.table<Record<string, unknown>>('futz_event');

  it('the seeded row stores the UTC calendar fields (raw ::text)', async () => {
    const r = await raw.query('SELECT at::text AS ts, on_day::text AS day FROM futz_event');
    assert.equal(r.rows[0].ts, TS_UTC, `stored ${r.rows[0].ts} (process TZ=${process.env.TZ ?? 'system'})`);
    assert.equal(r.rows[0].day, DAY_UTC);
  });

  it('finds the row by a zone-less timestamp column', async () => {
    const row = await t().findUnique({ where: { at: V } });
    assert.ok(row, 'findUnique returned null for a row that exists');
    assert.equal(row?.label, 'seed');
  });

  it('finds the row by a date column', async () => {
    assert.ok(await t().findUnique({ where: { onDay: V } }), 'findUnique returned null for a row that exists');
  });

  it('agrees with findFirst on the identical predicate', async () => {
    for (const where of [{ at: V }, { onDay: V }, { atTz: V }]) {
      const viaUnique = await t().findUnique({ where });
      const viaFirst = await t().findFirst({ where });
      assert.equal(
        viaUnique === null,
        viaFirst === null,
        `findUnique and findFirst disagree on ${JSON.stringify(Object.keys(where))}`,
      );
      assert.ok(viaUnique, 'both paths missed the seeded row');
    }
  });

  it('REGRESSION: timestamptz is unaffected (it always worked)', async () => {
    assert.ok(await t().findUnique({ where: { atTz: V } }));
  });

  it('a warmed cache hit binds the same way as the first build', async () => {
    // Build and cache-hit collect are separate walks over the where keys.
    assert.ok(await t().findUnique({ where: { at: V } }));
    assert.ok(await t().findUnique({ where: { at: V } }), 'the cache-hit collect path lost the coercion');
  });

  it('a predicate that matches nothing still returns null', async () => {
    assert.equal(await t().findUnique({ where: { at: new Date('2020-01-01T00:00:00Z') } }), null);
  });
});
