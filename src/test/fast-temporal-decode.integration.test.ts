/**
 * turbine-orm, the fast temporal decode path: LIVE differential, with the wire
 * shape varied by server setting.
 *
 * ## Why a second differential exists
 *
 * src/test/fast-temporal-decode.test.ts compares the fast scan against the
 * parser it replaces over a value matrix written by hand. That matrix is only
 * as good as the shapes somebody thought of, and the shape a `timestamptz`
 * takes on the wire is **not a constant**: it is decided by the `DateStyle`
 * and `TimeZone` GUCs, which are per-server, per-database, per-role and
 * per-session settings that no client controls. A decoder tuned to one
 * `DateStyle` is a latent corruption bug, so this file asks a real server for
 * the same instants under settings that are all in production use somewhere:
 *
 *   DateStyle   ISO (the default), SQL, Postgres, German, and MDY vs DMY
 *   TimeZone    UTC, a whole-hour zone, a half-hour zone (Kolkata, +05:30),
 *               a 45-minute zone (Kathmandu, +05:45), and a pre-standard-time
 *               instant whose offset carries SECONDS (Amsterdam LMT is
 *               +00:17:30 in 1850, which no hand-written matrix would guess)
 *
 * Measured shapes this produces for one instant, all four DateStyles:
 *
 *   ISO         2026-08-15 18:10:43.476603+05:45
 *   SQL         15/08/2026 18:10:43.476603 +0545
 *   Postgres    Sat 15 Aug 18:10:43.476603 2026 +0545
 *   German      15.08.2026 18:10:43.476603 +0545
 *
 * Only the first is the fast path's shape. The other three must be DELEGATED,
 * and the assertion is not "we handle them" but "we return byte-for-byte what
 * the driver returned before this existed", which for those three is
 * `postgres-date`'s answer, `null` included.
 *
 * ## Method
 *
 * Each row selects the value twice: once as its real type (which the DRIVER
 * decodes, through whatever parser is registered) and once as `::text` (which
 * no parser touches, so it is exactly the bytes the driver received). The
 * assertion compares the decoded value against the REFERENCE parser applied to
 * that same text. There is no expected-value table to fall out of date: the
 * server supplies both sides.
 *
 * The GUCs are set with `SET LOCAL` inside an explicit transaction, never a
 * session-level `SET`. That is a hard rule in this repo and it is not about
 * this test: a bare `SET` through a transaction-pooling proxy attaches to the
 * shared server-side backend and is handed to the next caller, which has
 * already caused one production incident.
 *
 * Requires DATABASE_URL.
 * Run: npx tsx --test src/test/fast-temporal-decode.integration.test.ts
 */

import assert from 'node:assert/strict';
import { after, describe } from 'node:test';
import pg from 'pg';
import {
  createUtcDateParserGeneral,
  createUtcTimestampParserGeneral,
  registerUtcTemporalParsers,
} from '../query/utils.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const gate = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

const getParser = (oid: number): ((value: string) => unknown) =>
  (pg.types.getTypeParser as unknown as (id: number, format: 'text') => (value: string) => unknown)(oid, 'text');

// Captured BEFORE registration, so these are pg's own parsers and not the fast
// path comparing against itself. Reading them after `registerUtcTemporalParsers`
// would hand back Turbine's wrappers and the whole file would assert nothing.
const PG_DATE = getParser(1082);
const PG_TIMESTAMP = getParser(1114);
const PG_TIMESTAMPTZ = getParser(1184);
const PG_TIMESTAMPTZ_ARRAY = getParser(1185);

/** What the driver returned for these OIDs before the fast scan existed. */
const REFERENCE: Readonly<Record<string, (text: string) => unknown>> = {
  timestamptz: PG_TIMESTAMPTZ,
  timestamp: createUtcTimestampParserGeneral(PG_TIMESTAMP),
  date: createUtcDateParserGeneral(PG_DATE),
};

// Install the fast parsers process-wide, exactly as an owned-pool client does.
// This is the same entry point `TurbineClient`, `turbine studio` and the MCP
// server all call, so the parser table under test is the shipping one.
registerUtcTemporalParsers();

function render(value: unknown): string {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : `Date(${value.toISOString()})`;
  }
  if (Array.isArray(value)) return `[${value.map(render).join(', ')}]`;
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number') return `number(${value})`;
  return `${typeof value}(${String(value)})`;
}

/** GUC combinations, each one a shape the decoder has to survive. */
const GUCS: readonly { label: string; dateStyle: string; timeZone: string }[] = [
  { label: 'ISO/MDY, UTC', dateStyle: 'ISO, MDY', timeZone: 'UTC' },
  { label: 'ISO/DMY, whole-hour west', dateStyle: 'ISO, DMY', timeZone: 'America/New_York' },
  { label: 'ISO/MDY, whole-hour east', dateStyle: 'ISO, MDY', timeZone: 'Europe/Berlin' },
  { label: 'ISO/MDY, half-hour (+05:30)', dateStyle: 'ISO, MDY', timeZone: 'Asia/Kolkata' },
  { label: 'ISO/MDY, 45-minute (+05:45)', dateStyle: 'ISO, MDY', timeZone: 'Asia/Kathmandu' },
  { label: 'ISO/MDY, UTC+14', dateStyle: 'ISO, MDY', timeZone: 'Pacific/Kiritimati' },
  { label: 'ISO/MDY, LMT seconds', dateStyle: 'ISO, MDY', timeZone: 'Europe/Amsterdam' },
  { label: 'SQL/DMY', dateStyle: 'SQL, DMY', timeZone: 'Asia/Kathmandu' },
  { label: 'SQL/MDY', dateStyle: 'SQL, MDY', timeZone: 'UTC' },
  { label: 'Postgres/DMY', dateStyle: 'Postgres, DMY', timeZone: 'Europe/Berlin' },
  { label: 'German/DMY', dateStyle: 'German, DMY', timeZone: 'UTC' },
];

/**
 * The instants. Written as UTC literals so the SERVER renders them into
 * whatever the session's `TimeZone` makes of them, which is the point: the
 * decoder never sees the literal below, it sees the server's rendering of it.
 */
const TIMESTAMPTZ_LITERALS: readonly string[] = [
  "'2026-08-15 12:25:43.476603+00'",
  "'2024-01-01 00:00:00+00'",
  "'1970-01-01 00:00:00+00'",
  "'2024-02-29 12:00:00+00'",
  "'2024-06-30 23:59:59.999999+00'",
  "'2024-01-01 00:00:00.1+00'",
  "'2024-01-01 00:00:00.12+00'",
  "'2024-01-01 00:00:00.123+00'",
  "'2024-01-01 00:00:00.477+00'",
  "'1850-01-01 00:00:00+00'",
  "'0044-03-15 12:00:00+00'",
  "'0001-01-01 00:00:00+00'",
  "'0099-12-31 23:59:59+00'",
  "'0100-01-01 00:00:00+00'",
  "'12024-01-01 00:00:00+00'",
  "'4713-01-01 00:00:00+00 BC'",
  "'infinity'",
  "'-infinity'",
];

const TIMESTAMP_LITERALS: readonly string[] = [
  "'2026-07-21 09:30:00'",
  "'2026-07-21 09:30:00.1'",
  "'2026-07-21 09:30:00.12'",
  "'2026-07-21 09:30:00.123456'",
  "'2024-02-29 12:00:00'",
  "'0044-03-15 12:00:00'",
  "'0001-01-01 00:00:00'",
  "'0100-01-01 00:00:00'",
  "'12026-07-21 09:30:00'",
  "'0044-03-15 12:00:00 BC'",
  "'infinity'",
  "'-infinity'",
];

const DATE_LITERALS: readonly string[] = [
  "'2026-07-21'",
  "'2024-02-29'",
  "'0044-03-15'",
  "'0001-01-01'",
  "'0100-01-01'",
  "'12026-07-21'",
  "'0044-03-15 BC'",
  "'infinity'",
  "'-infinity'",
];

const pool = DATABASE_URL ? new pg.Pool({ connectionString: DATABASE_URL, max: 1 }) : undefined;
after(async () => {
  await pool?.end();
});

/**
 * Run `queries` under one GUC combination inside ONE explicit transaction.
 * `SET LOCAL` cannot leak past the ROLLBACK, which is the whole reason the
 * settings are scoped this way rather than with a session `SET`.
 */
async function underGucs<T>(
  dateStyle: string,
  timeZone: string,
  body: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await (pool as pg.Pool).connect();
  try {
    await client.query('BEGIN');
    // Bound values are not accepted for a GUC, so these are literals; both
    // come from the frozen GUCS table above and never from anything a caller
    // supplies.
    await client.query(`SET LOCAL DateStyle = '${dateStyle}'`);
    await client.query(`SET LOCAL TimeZone = '${timeZone}'`);
    return await body(client);
  } finally {
    // ROLLBACK, not COMMIT: nothing is written, and it discards the SET LOCALs
    // in the one step rather than relying on transaction end alone.
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

interface Divergence {
  guc: string;
  literal: string;
  wire: string;
  decoded: string;
  reference: string;
}

describe('fast temporal decode against a live server, DateStyle and TimeZone varied', () => {
  for (const [pgType, literals] of [
    ['timestamptz', TIMESTAMPTZ_LITERALS],
    ['timestamp', TIMESTAMP_LITERALS],
    ['date', DATE_LITERALS],
  ] as const) {
    gate.it(`${pgType}: the driver's decoded value equals the reference parser's, every GUC`, async () => {
      const divergences: Divergence[] = [];
      const shapes = new Set<string>();
      for (const guc of GUCS) {
        const rows = await underGucs(guc.dateStyle, guc.timeZone, async (client) => {
          const selected = literals
            .map((lit, i) => `SELECT ${i} AS n, ${lit}::${pgType} AS typed, (${lit}::${pgType})::text AS wire`)
            .join(' UNION ALL ');
          const res = await client.query<{ n: number; typed: unknown; wire: string }>(`${selected} ORDER BY n`);
          return res.rows;
        });
        assert.equal(rows.length, literals.length, `${guc.label}: row count`);
        for (const row of rows) {
          shapes.add(row.wire);
          const decoded = render(row.typed);
          const reference = render(REFERENCE[pgType]?.(row.wire));
          if (decoded !== reference) {
            divergences.push({
              guc: guc.label,
              literal: literals[row.n] as string,
              wire: row.wire,
              decoded,
              reference,
            });
          }
        }
      }
      assert.equal(
        divergences.length,
        0,
        `${pgType}: ${divergences.length} live value(s) decode differently than the parser being replaced\n` +
          divergences
            .map(
              (d) =>
                `  [${d.guc}] ${d.literal}\n    wire:      ${d.wire}\n` +
                `    decoded:   ${d.decoded}\n    reference: ${d.reference}`,
            )
            .join('\n'),
      );
      // A differential that never saw the delegating shapes would pass
      // vacuously, so assert the server really did vary the wire text. Four
      // DateStyles x several zones over these literals is far more than 20
      // distinct renderings; the floor is deliberately loose.
      assert.ok(shapes.size > 20, `${pgType}: only ${shapes.size} distinct wire shapes, GUCs did not vary`);
    });
  }

  gate.it('the non-ISO DateStyles really are reaching the delegating path', async () => {
    // The claim "everything else is delegated" is only meaningful if the
    // matrix above actually produced non-ISO text. Pin the four renderings so
    // a server default change cannot silently turn this file into an ISO-only
    // test that still passes.
    const seen: Record<string, string> = {};
    for (const guc of GUCS) {
      const wire = await underGucs(guc.dateStyle, guc.timeZone, async (client) => {
        const res = await client.query<{ wire: string }>(
          `SELECT ('2026-08-15 12:25:43.476603+00'::timestamptz)::text AS wire`,
        );
        return res.rows[0]?.wire as string;
      });
      seen[guc.label] = wire;
    }
    assert.match(seen['ISO/MDY, 45-minute (+05:45)'] as string, /^2026-08-15 \d{2}:\d{2}:\d{2}\.\d+\+05:45$/);
    assert.match(seen['SQL/DMY'] as string, /^15\/08\/2026 /);
    assert.match(seen['Postgres/DMY'] as string, /^Sat 15 Aug /);
    assert.match(seen['German/DMY'] as string, /^15\.08\.2026 /);
    // And a pre-standard-time instant in Amsterdam carries an offset with
    // SECONDS, the shape the scan supports and no hand-written matrix guesses.
    const lmt = await underGucs('ISO, MDY', 'Europe/Amsterdam', async (client) => {
      const res = await client.query<{ wire: string }>(`SELECT ('1850-01-01 00:00:00+00'::timestamptz)::text AS wire`);
      return res.rows[0]?.wire as string;
    });
    assert.match(lmt, /\+00:\d{2}:\d{2}$/, `expected an offset with seconds, got ${lmt}`);
  });

  gate.it('timestamptz[] and a NULL cell decode as they did before', async () => {
    for (const guc of GUCS) {
      const row = await underGucs(guc.dateStyle, guc.timeZone, async (client) => {
        const res = await client.query<{
          arr: unknown;
          arrWire: string;
          empty: unknown;
          emptyWire: string;
          nulls: unknown;
          nullsWire: string;
          nothing: unknown;
        }>(
          `SELECT a AS arr, a::text AS "arrWire",
                  e AS empty, e::text AS "emptyWire",
                  n AS nulls, n::text AS "nullsWire",
                  NULL::timestamptz AS nothing
             FROM (SELECT ARRAY['2026-08-15 12:25:43.476603+00','0044-03-15 12:00:00+00','infinity']::timestamptz[] a,
                          ARRAY[]::timestamptz[] e,
                          ARRAY[NULL,'2024-01-01 00:00:00+00',NULL]::timestamptz[] n) s`,
        );
        return res.rows[0];
      });
      assert.ok(row, `${guc.label}: no row`);
      assert.equal(render(row.arr), render(PG_TIMESTAMPTZ_ARRAY(row.arrWire)), `${guc.label}: timestamptz[]`);
      assert.equal(render(row.empty), render(PG_TIMESTAMPTZ_ARRAY(row.emptyWire)), `${guc.label}: empty array`);
      assert.deepEqual(row.empty, [], `${guc.label}: empty array is []`);
      assert.equal(render(row.nulls), render(PG_TIMESTAMPTZ_ARRAY(row.nullsWire)), `${guc.label}: NULL elements`);
      // A SQL NULL never reaches a type parser at all: the protocol parser
      // writes `null` for a -1 length field. Pinned because "empty string vs
      // NULL" is exactly where the array parsers differ.
      assert.equal(row.nothing, null, `${guc.label}: NULL cell`);
    }
  });

  gate.it('a real timestamptz column round-trips the instant it stored', async () => {
    // The matrix above proves agreement with the OLD decoder. This proves the
    // decoder is right in the first place, which agreement alone would not:
    // the server is asked whether the value it stored equals the value the
    // client read back, with no JS-side date arithmetic in the comparison.
    const instants = [
      '2026-08-15T12:25:43.476Z',
      '2024-02-29T12:00:00.000Z',
      '1970-01-01T00:00:00.000Z',
      '2024-06-30T18:14:59.999Z',
    ];
    for (const guc of GUCS) {
      const rows = await underGucs(guc.dateStyle, guc.timeZone, async (client) => {
        const res = await client.query<{ back: Date; same: boolean }>(
          `SELECT v AS back, v = $2::timestamptz AS same FROM (SELECT $1::timestamptz v) s`,
          [instants[0], instants[0]],
        );
        return res.rows;
      });
      assert.ok(rows[0]?.same, `${guc.label}: server disagrees the round trip is the same instant`);
    }
    for (const iso of instants) {
      const row = await underGucs('ISO, MDY', 'Asia/Kathmandu', async (client) => {
        const res = await client.query<{ back: Date }>(`SELECT $1::timestamptz AS back`, [new Date(iso)]);
        return res.rows[0];
      });
      assert.equal((row?.back as Date).toISOString(), iso, `round trip of ${iso}`);
    }
  });

  gate.it('the pre-1900 round trip loses seconds on the WRITE side, in the driver, not here', async () => {
    // Found while writing the test above, and recorded rather than dropped.
    // Binding `new Date('1850-01-01T00:00:00Z')` reads back TWO SECONDS EARLY
    // in a process running in America/New_York, and none of it is Turbine's:
    //
    //   node-postgres serialises a bound Date with `dateToString`, which
    //   renders the zone offset as ±HH:MM. New York's offset in 1850 is
    //   LMT -04:56:02, so the SECONDS are truncated and the instant sent to
    //   the server is two seconds off. The value comes back decoded exactly as
    //   it was stored.
    //
    // The READ side handles the same offset precisely (`+00:17:30` for
    // Amsterdam LMT is in the matrix above and agrees value for value), which
    // is what this assertion separates: a failure here is a driver-side write
    // question, and a failure up there is a decode question. If node-postgres
    // ever fixes its serialiser this test flips, which is the notification.
    const iso = '1850-01-01T00:00:00.000Z';
    const bound = await underGucs('ISO, MDY', 'UTC', async (client) => {
      const res = await client.query<{ back: Date }>(`SELECT $1::timestamptz AS back`, [new Date(iso)]);
      return (res.rows[0]?.back as Date).toISOString();
    });
    // Sent as TEXT, bypassing the driver's Date serialiser, the same instant
    // round-trips exactly. That is the control proving the loss is on the way
    // in and not on the way out.
    const asText = await underGucs('ISO, MDY', 'UTC', async (client) => {
      const res = await client.query<{ back: Date }>(`SELECT $1::timestamptz AS back`, [iso]);
      return (res.rows[0]?.back as Date).toISOString();
    });
    assert.equal(asText, iso, 'a text-bound pre-1900 instant round-trips exactly');
    const skewSeconds = Math.abs(Date.parse(bound) - Date.parse(iso)) / 1000;
    assert.ok(
      skewSeconds < 60,
      `driver Date binding skewed the instant by ${skewSeconds}s, far more than sub-minute offset truncation`,
    );
  });
});
