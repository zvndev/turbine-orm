/**
 * Child-process probe for Turbine's readings on a caller-supplied pool.
 *
 * Run with a forced `TZ` and `DATABASE_URL`, it reads one row through every
 * path a client has on a supplied `pg.Pool` and prints one JSON line. A child
 * process because `TZ` is read once at process start, and because a client on
 * a Turbine-OWNED pool anywhere in the process registers the parsers globally,
 * which would hide the supplied-pool path this probe exists to observe.
 *
 * `PROBE_UTC=0` constructs the client with `utcTimestamps: false`.
 */
import pg from 'pg';
import { TurbineClient } from '../../client.js';
import type { SchemaMetadata } from '../../schema.js';
import { turbineHttp } from '../../serverless.js';
import { mockTable } from '../helpers.js';

const url = process.env.DATABASE_URL as string;
const utcTimestamps = process.env.PROBE_UTC !== '0';
const TABLE = 'client_v090_supplied_types';

const schema: SchemaMetadata = {
  tables: {
    [TABLE]: mockTable(TABLE, [
      { name: 'id', field: 'id', pgType: 'int4' },
      { name: 'ts', field: 'ts', pgType: 'timestamp' },
      { name: 'd', field: 'd', pgType: 'date' },
      { name: 'tss', field: 'tss', pgType: '_timestamp' },
      { name: 'ds', field: 'ds', pgType: '_date' },
      { name: 'big', field: 'big', pgType: 'int8' },
      { name: 'tstz', field: 'tstz', pgType: 'timestamptz' },
    ]),
  },
  enums: {},
};

const iso = (value: unknown): unknown =>
  value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.map(iso) : value;
const shape = (row: Record<string, unknown> | null | undefined): Record<string, unknown> => ({
  ts: iso(row?.ts),
  d: iso(row?.d),
  tss: iso(row?.tss),
  ds: iso(row?.ds),
  big: row?.big,
  tstz: iso(row?.tstz),
});
const isTurbineParser = (oid: number): boolean =>
  (
    (pg.types.getTypeParser as unknown as (o: number, f: string) => Record<symbol, unknown>)(oid, 'text') as Record<
      symbol,
      unknown
    >
  )[Symbol.for('turbine.typeParser')] === true;

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: url, max: 3 });
  const out: Record<string, unknown> = { tz: process.env.TZ };
  try {
    await pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await pool.query(
      `CREATE TABLE ${TABLE} (id int4 PRIMARY KEY, ts timestamp, d date, tss timestamp[], ds date[], big int8, tstz timestamptz)`,
    );
    await pool.query(
      `INSERT INTO ${TABLE} VALUES (1, '2026-07-01 12:00:00', '2026-07-21', '{"2026-07-01 12:00:00"}', '{2026-07-21}',
        9007199254740991, '2026-07-01 12:00:00+00'), (2, NULL, NULL, NULL, NULL, 9007199254740993, NULL)`,
    );

    const db = new TurbineClient({ pool, utcTimestamps }, schema);
    const users = db.table(TABLE);
    out.findUnique = shape(await users.findUnique({ where: { id: 1 } }));
    out.rawUnsafe = shape((await db.rawUnsafe(`SELECT * FROM ${TABLE} WHERE id = $1`, 1))[0]);
    out.sql = shape(await db.sql`SELECT * FROM client_v090_supplied_types WHERE id = ${1}`.one());
    out.raw = shape((await db.raw`SELECT * FROM client_v090_supplied_types WHERE id = ${1}`)[0]);
    out.transaction = await db.$transaction(async (tx) => ({
      findUnique: shape(await tx.table(TABLE).findUnique({ where: { id: 1 } })),
      raw: shape((await tx.raw`SELECT * FROM client_v090_supplied_types WHERE id = ${1}`)[0]),
      sql: shape(await tx.sql`SELECT * FROM client_v090_supplied_types WHERE id = ${1}`.one()),
      // The handle is the driver's connection, with the driver's readings.
      connection: shape((await tx.$connection().query(`SELECT * FROM ${TABLE} WHERE id = 1`)).rows[0]),
    }));
    const [piped] = await db.pipeline(users.buildFindUnique({ where: { id: 1 } }));
    out.pipeline = shape(piped as Record<string, unknown>);
    const streamed: Record<string, unknown>[] = [];
    for await (const row of users.findManyStream({ where: { id: 1 }, batchSize: 10 })) streamed.push(row);
    out.stream = shape(streamed[0]);
    out.unsafeBig = (await db.rawUnsafe<{ big: unknown }>(`SELECT big FROM ${TABLE} WHERE id = 2`))[0]?.big;

    out.http = shape(
      await turbineHttp(pool, schema, { utcTimestamps })
        .table(TABLE)
        .findUnique({ where: { id: 1 } }),
    );
    const withReplica = new TurbineClient({ pool, utcTimestamps, replicas: [url] }, schema);
    out.replica = shape(await withReplica.table(TABLE).findUnique({ where: { id: 1 } }));
    await withReplica.disconnect();

    // The caller's own queries on the same pool keep the driver's parsers.
    out.callerPool = shape((await pool.query(`SELECT * FROM ${TABLE} WHERE id = 1`)).rows[0]);
    out.dbPoolIsCallers = db.pool === pool;
    out.globalTimestampParserIsTurbines = isTurbineParser(1114);
    out.globalInt8ParserIsTurbines = isTurbineParser(20);

    // Bound Dates in raw SQL.
    const at = new Date('2026-07-02T08:30:00.000Z');
    const day = new Date('2026-07-22T00:00:00.000Z');
    await db.raw`UPDATE client_v090_supplied_types SET ts = ${at}, d = ${day}, tss = ${[at, null]}, tstz = ${at} WHERE id = 2`;
    const written = (
      await pool.query(
        `SELECT ts::text AS ts, d::text AS d, tss::text AS tss, tstz = $1::timestamptz AS tstz FROM ${TABLE}
        WHERE id = 2`,
        ['2026-07-02T08:30:00Z'],
      )
    ).rows[0];
    out.rawBind = written;
    await db.rawUnsafe(`UPDATE ${TABLE} SET ts = $1 WHERE id = 2`, new Date('2026-07-03T01:02:03.004Z'));
    out.rawUnsafeBind = (await pool.query(`SELECT ts::text AS ts FROM ${TABLE} WHERE id = 2`)).rows[0]?.ts;
    await db.$transaction(async (tx) => {
      await tx.rawUnsafe(`UPDATE ${TABLE} SET ts = $1 WHERE id = 2`, new Date('2026-07-04T05:06:07.000Z'));
    });
    out.txBind = (await pool.query(`SELECT ts::text AS ts FROM ${TABLE} WHERE id = 2`)).rows[0]?.ts;
    out.bcBind = (await db.sql<{ v: string }>`SELECT ${new Date(Date.UTC(-43, 2, 15))}::timestamp::text AS v`.one())?.v;
    try {
      await db.raw`SELECT ${new Date(Number.NaN)}::timestamp AS v`;
      out.invalidDate = 'accepted';
    } catch (err) {
      out.invalidDate = `${(err as Error).name}: ${(err as Error).message}`;
    }
  } finally {
    await pool.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => {});
    await pool.end();
  }
  console.log(JSON.stringify(out));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
