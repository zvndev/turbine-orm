/**
 * turbine-orm, stored-value proof that a data key spelled as the COLUMN name
 * writes the same value as the same key spelled as the FIELD name (live Postgres)
 *
 * `toColumn` accepts both spellings, so `create({ data: { last_run: d } })` and
 * `create({ data: { lastRun: d } })` compile to byte-identical SQL. The write
 * value coercion used to resolve the key through `columnMap` ALONE, which knows
 * only the field spelling, so the column-spelled call bound the raw `Date` and
 * skipped every write coercion. The emitted statement is identical either way
 * and Turbine's own read path shifts the value back by the same offset, so the
 * damage is invisible from inside the ORM: every assertion here reads the cell
 * back AS TEXT through a raw pg client.
 *
 * Under a UTC process both spellings pass trivially; run it under a non-UTC zone
 * (`TZ=America/New_York`) for the discriminating version.
 *
 * Run: TZ=America/New_York DATABASE_URL=postgres://... \
 *        npx tsx --test src/test/column-key-write-parity.integration.test.ts
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
  console.log('⚠ Skipping column-key write parity integration tests: DATABASE_URL not set');
}

const DDL = `
DROP TABLE IF EXISTS ckp_run CASCADE;
DROP TABLE IF EXISTS ckp_schedule CASCADE;
CREATE TABLE ckp_schedule (
  id         SERIAL PRIMARY KEY,
  last_run   TIMESTAMP,
  day        DATE,
  tz         TIMESTAMPTZ,
  ran_stamps TIMESTAMP[],
  counter    INTEGER NOT NULL DEFAULT 0,
  touched_at TIMESTAMP
);
CREATE TABLE ckp_run (
  id          SERIAL PRIMARY KEY,
  schedule_id INTEGER NOT NULL REFERENCES ckp_schedule(id) ON DELETE CASCADE,
  ran_at      TIMESTAMP
);
`;

/** Chosen so a negative UTC offset moves it onto the previous calendar day. */
const V = new Date('2026-03-15T00:30:00Z');
const V2 = new Date('2026-03-16T00:30:00Z');
const TS_UTC = '2026-03-15 00:30:00';
const TS2_UTC = '2026-03-16 00:30:00';
const DAY_UTC = '2026-03-15';

/** The same write payload under both spellings of every key. */
const BY_FIELD = { lastRun: V, day: V, tz: V, ranStamps: [V, V2] };
const BY_COLUMN = { last_run: V, day: V, tz: V, ran_stamps: [V, V2] };

const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

let raw: pg.Client;
let db: TurbineClient;
let schema: SchemaMetadata;
/** Relation name introspection derived for ckp_schedule → ckp_run. */
let runsRelation: string;

interface Stored {
  ts: string | null;
  day: string | null;
  tz: string | null;
  stamps: string | null;
  counter: number;
  touched: string | null;
}

/** Read the stored cells back as TEXT, never through Turbine's read path. */
async function stored(id: number): Promise<Stored> {
  const r = await raw.query(
    `SELECT last_run::text AS ts, day::text AS day, (tz AT TIME ZONE 'UTC')::text AS tz,
            ran_stamps::text AS stamps, counter, touched_at::text AS touched
       FROM ckp_schedule WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}

function assertUtc(where: string, row: Stored): void {
  assert.equal(row.ts, TS_UTC, `${where}: timestamp stored ${row.ts} (process TZ=${process.env.TZ ?? 'system'})`);
  assert.equal(row.day, DAY_UTC, `${where}: date stored ${row.day}`);
  // timestamptz carries a real instant, so it is unaffected by the rewrite.
  assert.equal(row.tz, TS_UTC, `${where}: timestamptz stored ${row.tz}`);
  assert.equal(row.stamps, `{"${TS_UTC}","${TS2_UTC}"}`, `${where}: timestamp[] stored ${row.stamps}`);
}

describe('write value coercion under a column-spelled data key (stored values)', () => {
  before(async () => {
    raw = new pg.Client({ connectionString: DATABASE_URL });
    await raw.connect();
    await raw.query(DDL);
    schema = await introspect({ connectionString: DATABASE_URL as string });
    const relations = schema.tables.ckp_schedule?.relations ?? {};
    runsRelation = Object.keys(relations).find((n) => relations[n]?.to === 'ckp_run') as string;
    // `updatedAt` is a code-first tag introspection never infers; set it by hand
    // so the tagged-column path is exercised against a real database.
    const touched = schema.tables.ckp_schedule?.columns.find((c) => c.name === 'touched_at');
    if (touched) touched.updatedAt = true;
    db = new TurbineClient({ connectionString: DATABASE_URL as string, poolSize: 3 }, schema);
    await db.connect();
  });

  after(async () => {
    await db?.disconnect();
    await raw?.query('DROP TABLE IF EXISTS ckp_run CASCADE; DROP TABLE IF EXISTS ckp_schedule CASCADE;');
    await raw?.end();
  });

  const t = () => db.table<Record<string, unknown>>('ckp_schedule');

  it('create stores the UTC calendar fields under both spellings', async () => {
    const byField = (await t().create({ data: { ...BY_FIELD } })) as { id: number };
    assertUtc('create (field-spelled)', await stored(byField.id));

    const byColumn = (await t().create({ data: { ...BY_COLUMN } })) as { id: number };
    assertUtc('create (column-spelled)', await stored(byColumn.id));
  });

  it('createMany stores the UTC calendar fields under both spellings', async () => {
    const byField = (await t().createMany({ data: [{ ...BY_FIELD }] })) as { id: number }[];
    assertUtc('createMany (field-spelled)', await stored(byField[0]?.id as number));

    const byColumn = (await t().createMany({ data: [{ ...BY_COLUMN }] })) as { id: number }[];
    assertUtc('createMany (column-spelled)', await stored(byColumn[0]?.id as number));
  });

  it('update and updateMany store the UTC calendar fields under both spellings', async () => {
    const a = (await t().create({ data: {} })) as { id: number };
    await t().update({ where: { id: a.id }, data: { ...BY_FIELD } });
    assertUtc('update (field-spelled)', await stored(a.id));

    const b = (await t().create({ data: {} })) as { id: number };
    await t().update({ where: { id: b.id }, data: { ...BY_COLUMN } });
    assertUtc('update (column-spelled)', await stored(b.id));

    const c = (await t().create({ data: {} })) as { id: number };
    await t().updateMany({ where: { id: c.id }, data: { ...BY_COLUMN } });
    assertUtc('updateMany (column-spelled)', await stored(c.id));
  });

  it('upsert stores the UTC calendar fields under both spellings, on both branches', async () => {
    const insert = (await t().create({ data: {} })) as { id: number };
    await raw.query('DELETE FROM ckp_schedule WHERE id = $1', [insert.id]);
    await t().upsert({
      where: { id: insert.id },
      create: { id: insert.id, ...BY_COLUMN },
      update: { ...BY_COLUMN },
    });
    assertUtc('upsert insert branch (column-spelled)', await stored(insert.id));

    const conflict = (await t().create({ data: {} })) as { id: number };
    await t().upsert({
      where: { id: conflict.id },
      create: { id: conflict.id },
      update: { ...BY_COLUMN },
    });
    assertUtc('upsert update branch (column-spelled)', await stored(conflict.id));
  });

  it('the atomic `set` operator stores the UTC calendar fields under a column-spelled key', async () => {
    const row = (await t().create({ data: {} })) as { id: number };
    await t().update({
      where: { id: row.id },
      data: { last_run: { set: V }, day: { set: V }, tz: { set: V }, ran_stamps: { set: [V, V2] } },
    });
    assertUtc('update { set } (column-spelled)', await stored(row.id));
  });

  it('an arithmetic operator under a column-spelled key still applies', async () => {
    const row = (await t().create({ data: { counter: 5 } })) as { id: number };
    await t().update({ where: { id: row.id }, data: { counter: { increment: 3 } } });
    assert.equal((await stored(row.id)).counter, 8);
  });

  it('a write inside $transaction stores the UTC calendar fields under a column-spelled key', async () => {
    const row = await db.$transaction(async (tx) => {
      return (await tx.table<Record<string, unknown>>('ckp_schedule').create({ data: { ...BY_COLUMN } })) as {
        id: number;
      };
    });
    assertUtc('$transaction (column-spelled)', await stored(row.id));
  });

  it('a nested write stores the UTC calendar fields on parent and child', async () => {
    const parent = (await t().create({
      data: { ...BY_COLUMN, [runsRelation]: { create: [{ ran_at: V }] } },
    })) as { id: number };
    assertUtc('nested write parent (column-spelled)', await stored(parent.id));
    const child = await raw.query('SELECT ran_at::text AS ts FROM ckp_run WHERE schedule_id = $1', [parent.id]);
    assert.equal(child.rows[0].ts, TS_UTC, 'nested write child (column-spelled)');
  });

  it('a nested create whose data spells the foreign key as the column name writes one row', async () => {
    // The engine injects the parent key under the FIELD spelling; a caller-supplied
    // column-spelled key for the same column used to survive alongside it and
    // Postgres rejected the INSERT with 42701 ("specified more than once").
    const parent = (await t().create({ data: {} })) as { id: number };
    const other = (await t().create({ data: {} })) as { id: number };
    const created = (await t().update({
      where: { id: parent.id },
      data: { [runsRelation]: { create: [{ ran_at: V, schedule_id: other.id }] } },
    })) as { id: number };
    assert.equal(created.id, parent.id);
    const rows = await raw.query('SELECT schedule_id, ran_at::text AS ts FROM ckp_run WHERE ran_at IS NOT NULL');
    const mine = rows.rows.filter((r: { schedule_id: number }) => r.schedule_id === parent.id);
    assert.equal(mine.length, 1, 'the parent correlation wins over the caller-supplied foreign key');
    assert.equal(mine[0].ts, TS_UTC);
  });

  it('an updatedAt-tagged column spelled as the column name is assigned exactly once', async () => {
    // Pre-fix the injector looked for the FIELD spelling only, so a column-spelled
    // key produced `SET "touched_at" = $1, "touched_at" = $2` and Postgres raised
    // 42701. The caller's explicit value must win, as it does for `touchedAt`.
    const row = (await t().create({ data: {} })) as { id: number };
    await t().update({ where: { id: row.id }, data: { touched_at: V, last_run: V } });
    const after = await stored(row.id);
    assert.equal(after.touched, TS_UTC, 'the caller-supplied updatedAt value wins');
    assert.equal(after.ts, TS_UTC);

    // Untouched by the caller: the tag fills it in, in UTC.
    const auto = (await t().create({ data: {} })) as { id: number };
    await t().update({ where: { id: auto.id }, data: { last_run: V } });
    const filled = (await stored(auto.id)).touched;
    assert.ok(filled, 'the updatedAt tag filled the column in');
    // Same instant either side of the write, to the minute, when read back as UTC.
    const drift = Math.abs(new Date(`${filled?.replace(' ', 'T')}Z`).getTime() - Date.now());
    assert.ok(drift < 60_000, `updatedAt stored ${filled}, ${Math.round(drift / 1000)}s from now (zone shift?)`);
  });

  it('the ORM round trip agrees with the stored text (it always did, that is the trap)', async () => {
    const row = (await t().create({ data: { ...BY_COLUMN } })) as { id: number; lastRun: Date };
    assert.equal(row.lastRun.toISOString(), V.toISOString());
    assertUtc('round trip', await stored(row.id));
  });
});
