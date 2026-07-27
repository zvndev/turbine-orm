/**
 * Live-database probe for the zone-less `date` round trip, run in a child
 * process with a forced `TZ`.
 *
 * Creates its own tables, drives them through a real TurbineClient (driver
 * path, `with` join path, `with` batched path), performs three
 * read-modify-write cycles, and reports both what the ORM returned and what is
 * actually STORED (read back as `::text` through a raw pg client, so no parser
 * can flatter the result). Tables are dropped before it exits.
 *
 * Usage: TZ=Europe/Berlin DATABASE_URL=... tsx utc-date-roundtrip-probe.ts
 * Output: one JSON line on stdout.
 */
import pg from 'pg';
import { TurbineClient } from '../../client.js';
import { introspect } from '../../introspect.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL required');
const connectionString: string = url;

const PARENT = 'turbine_utc_date_probe';
const CHILD = 'turbine_utc_date_probe_child';

const raw = new pg.Client({ connectionString: process.env.DATABASE_URL });

interface ProbeRow {
  d?: unknown;
  ds?: unknown;
  ts?: unknown;
  tss?: unknown;
}

const iso = (v: unknown): unknown => (v instanceof Date ? v.toISOString() : v);
const isoAll = (v: unknown): unknown => (Array.isArray(v) ? v.map(iso) : iso(v));

async function main(): Promise<void> {
  await raw.connect();
  await raw.query(`DROP TABLE IF EXISTS ${CHILD}, ${PARENT} CASCADE`);
  await raw.query(`
    CREATE TABLE ${PARENT} (
      id int PRIMARY KEY,
      d date,
      ds date[],
      ts timestamp,
      tss timestamp[]
    )`);
  await raw.query(`
    CREATE TABLE ${CHILD} (
      id int PRIMARY KEY,
      parent_id int NOT NULL REFERENCES ${PARENT}(id),
      d date
    )`);
  await raw.query(
    `INSERT INTO ${PARENT} (id, d, ds, ts, tss) VALUES
       (1, date '2026-07-21', array[date '2026-07-21'], timestamp '2026-07-21 09:30:00', array[timestamp '2026-07-21 09:30:00'])`,
  );
  await raw.query(`CREATE INDEX ${CHILD}_parent_idx ON ${CHILD} (parent_id)`);
  await raw.query(`INSERT INTO ${CHILD} (id, parent_id, d) VALUES (1, 1, date '2026-07-21')`);

  const schema = await introspect({ connectionString, include: [PARENT, CHILD] });
  const db = new TurbineClient({ connectionString }, schema);
  const parent = db.table<ProbeRow>(PARENT);

  const driver = (await parent.findMany({ where: { id: 1 } }))[0] as ProbeRow;
  const childKey = Object.keys(schema.tables[PARENT]?.relations ?? {})[0] as string;
  const joined = (
    await parent.findMany({
      where: { id: 1 },
      with: { [childKey]: true } as never,
      relationLoadStrategy: 'join',
    })
  )[0] as unknown as Record<string, unknown>;
  const batched = (
    await parent.findMany({
      where: { id: 1 },
      with: { [childKey]: true } as never,
      relationLoadStrategy: 'batched',
    })
  )[0] as unknown as Record<string, unknown>;

  // Does the row find itself? Filter by the Date the ORM just handed back.
  const selfMatch = await parent.count({ where: { d: driver.d as Date } });

  // Three read-modify-write cycles: write back exactly what was read.
  const cycles: { read: unknown; stored: unknown }[] = [];
  for (let i = 0; i < 3; i++) {
    const row = (await parent.findMany({ where: { id: 1 } }))[0] as ProbeRow;
    await parent.update({ where: { id: 1 }, data: { d: row.d as Date } as never });
    const stored = await raw.query(`SELECT d::text AS d FROM ${PARENT} WHERE id = 1`);
    cycles.push({ read: iso(row.d), stored: stored.rows[0].d });
  }

  const storedFinal = await raw.query(
    `SELECT d::text AS d, ds::text AS ds, ts::text AS ts FROM ${PARENT} WHERE id = 1`,
  );

  process.stdout.write(
    `${JSON.stringify({
      tz: process.env.TZ ?? null,
      driver: { d: iso(driver.d), ds: isoAll(driver.ds), ts: iso(driver.ts), tss: isoAll(driver.tss) },
      join: { d: iso(joined.d), childD: iso((joined[childKey] as ProbeRow[])[0]?.d) },
      batched: { d: iso(batched.d), childD: iso((batched[childKey] as ProbeRow[])[0]?.d) },
      selfMatch,
      cycles,
      storedFinal: storedFinal.rows[0],
    })}\n`,
  );

  await db.disconnect();
}

main()
  .catch((err) => {
    process.stderr.write(`${(err as Error).stack}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await raw.query(`DROP TABLE IF EXISTS ${CHILD}, ${PARENT} CASCADE`).catch(() => {});
    await raw.end().catch(() => {});
  });
