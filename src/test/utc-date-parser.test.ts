/**
 * turbine-orm, zone-less `date` read parser (OID 1082) and the array forms.
 *
 * A Postgres `date` is a calendar day with no zone, but the pg driver's default
 * parser builds a JS Date at the PROCESS's local midnight, so the stored day
 * `2026-07-21` reads back as `2026-07-20T22:00:00Z` in Europe/Berlin and
 * `2026-07-20T15:00:00Z` in Asia/Tokyo: the wrong calendar day east of UTC, and
 * the wrong instant everywhere but UTC. The write side already renders a bound
 * Date from its UTC components, so before this parser existed a
 * read-modify-write cycle east of UTC walked the stored day backwards.
 *
 * Zone behaviour is asserted in CHILD PROCESSES, because `TZ` is read once at
 * process start and cannot be flipped from inside a test.
 *
 * The `infinity` / `-infinity` cases below assert that the DRIVER parsers keep
 * delegating those values to pg's own parser, which returns the JS numbers
 * `Infinity` / `-Infinity`. That is deliberate and must not be "fixed" here:
 * temporal infinity is normalized one level up, in the ORM row parser, so that
 * the JSON-wire string form (`"infinity"`, which no driver parser ever sees)
 * and this number form land on the same value under either `temporalInfinity`
 * reading. If one of these assertions starts failing, the mapping has been put
 * in the global pg parser, where it would rewrite what every other consumer of
 * the same `pg` module reads. See
 * src/test/temporal-infinity-reading.integration.test.ts for the
 * public-surface contract.
 *
 * Run: npx tsx --test src/test/utc-date-parser.test.ts
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { type PgCompatPool, TurbineClient } from '../client.js';
import { ValidationError } from '../errors.js';
import {
  createPgArrayParser,
  createUtcDateParser,
  createUtcTimestampParser,
  parseUtcTimestampText,
} from '../query/utils.js';
import type { SchemaMetadata } from '../schema.js';
import { mockColumn, mockTable } from './helpers.js';

/** pg-types declares getTypeParser over an OID enum that omits the array OIDs. */
const getParser = (oid: number): ((value: string) => unknown) =>
  (pg.types.getTypeParser as unknown as (id: number, format: 'text') => (value: string) => unknown)(oid, 'text');

const here = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(here, 'fixtures', 'utc-date-parser-probe.ts');

/** Zones chosen to cover west of UTC, east of UTC, and the extreme UTC+14. */
const ZONES = ['UTC', 'America/New_York', 'Europe/Berlin', 'Asia/Tokyo', 'Pacific/Kiritimati'];

interface Probe {
  tz: string;
  defaultDate: string;
  defaultDateArray: unknown[];
  defaultTimestampArray: unknown[];
  date: string;
  dateLow: string;
  dateBc: string;
  dateWideYear: string;
  infinity: string;
  negInfinity: string;
  dateArray: unknown[];
  dateArrayEmpty: unknown[];
  dateArrayInfinity: unknown[];
  timestamp: string;
  timestampMicros: string;
  timestampBc: string;
  timestampWideYear: string;
  timestampInfinity: string;
  timestampNegInfinity: string;
  timestampArray: unknown[];
  timestampArrayInfinity: unknown[];
}

function probe(tz: string): Probe {
  const out = execFileSync(
    process.execPath,
    [path.join(here, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'), PROBE],
    {
      env: { ...process.env, TZ: tz },
      encoding: 'utf8',
    },
  );
  return JSON.parse(out.trim().split('\n').at(-1) as string) as Probe;
}

describe('date (OID 1082) read parser', () => {
  it('reads a calendar day as UTC midnight in every zone', () => {
    for (const tz of ZONES) {
      const p = probe(tz);
      assert.equal(p.date, '2026-07-21T00:00:00.000Z', `date under TZ=${tz}`);
      assert.deepEqual(
        p.dateArray,
        ['2026-07-21T00:00:00.000Z', null, '2026-01-01T00:00:00.000Z'],
        `date[] under TZ=${tz}`,
      );
      assert.deepEqual(p.dateArrayEmpty, [], `empty date[] under TZ=${tz}`);
      assert.equal(p.timestamp, '2026-07-21T09:30:00.000Z', `timestamp under TZ=${tz}`);
      assert.deepEqual(p.timestampArray, ['2026-07-21T09:30:00.000Z', null], `timestamp[] under TZ=${tz}`);
    }
  });

  it('the pg default parser it replaces is zone-dependent (so the test above bites)', () => {
    const berlin = probe('Europe/Berlin');
    const tokyo = probe('Asia/Tokyo');
    // These are the values Turbine returned before the 1082/1182/1115 parsers
    // were registered. Recorded here so a regression that drops the parsers is
    // caught by the assertions above rather than passing on a UTC CI box.
    assert.equal(berlin.defaultDate, '2026-07-20T22:00:00.000Z');
    assert.equal(tokyo.defaultDate, '2026-07-20T15:00:00.000Z');
    assert.deepEqual(berlin.defaultDateArray, ['2026-07-20T22:00:00.000Z']);
    assert.deepEqual(berlin.defaultTimestampArray, ['2026-07-21T07:30:00.000Z']);
  });

  it('preserves the non-calendar date values the default parser handles', () => {
    for (const tz of ZONES) {
      const p = probe(tz);
      assert.equal(p.infinity, 'Infinity', `infinity under TZ=${tz}`);
      assert.equal(p.negInfinity, '-Infinity', `-infinity under TZ=${tz}`);
      assert.equal(p.dateBc, '-000043-03-15T00:00:00.000Z', `BC year under TZ=${tz}`);
      assert.equal(p.dateWideYear, '+012026-07-21T00:00:00.000Z', `5-digit year under TZ=${tz}`);
      // A two-digit-century year must not be mapped into the 1900s.
      assert.equal(p.dateLow, '0001-01-01T00:00:00.000Z', `year 1 under TZ=${tz}`);
    }
  });

  it('keeps infinity on the driver value for timestamp, scalar AND array', () => {
    // Registering OID 1115 without a fallback turned `infinity` inside a
    // timestamp[] into an Invalid Date that flowed on silently (and JSON-encoded
    // as null). Both forms must stay on the driver's Infinity / -Infinity.
    for (const tz of ZONES) {
      const p = probe(tz);
      assert.equal(p.timestampInfinity, 'Infinity', `timestamp infinity under TZ=${tz}`);
      assert.equal(p.timestampNegInfinity, '-Infinity', `timestamp -infinity under TZ=${tz}`);
      assert.deepEqual(p.timestampArrayInfinity, ['Infinity', '-Infinity'], `timestamp[] infinity under TZ=${tz}`);
      assert.deepEqual(p.dateArrayInfinity, ['Infinity'], `date[] infinity under TZ=${tz}`);
    }
  });

  it('reads the timestamp shapes that are not ISO-8601 parseable', () => {
    for (const tz of ZONES) {
      const p = probe(tz);
      assert.equal(p.timestampMicros, '2026-07-21T09:30:00.123Z', `micros truncated under TZ=${tz}`);
      assert.equal(p.timestampBc, '-000043-03-15T09:30:00.000Z', `BC timestamp under TZ=${tz}`);
      assert.equal(p.timestampWideYear, '+012026-07-21T09:30:00.000Z', `5-digit year under TZ=${tz}`);
    }
  });

  it('the timestamp parser delegates unrecognised wire text', () => {
    const seen: string[] = [];
    const parse = createUtcTimestampParser((text) => {
      seen.push(text);
      return 'fallback';
    });
    assert.equal(parse('infinity'), 'fallback');
    assert.equal(parse('-infinity'), 'fallback');
    assert.equal(parse('2026-07-21'), 'fallback', 'a date-only value is not a timestamp wire value');
    assert.deepEqual(seen, ['infinity', '-infinity', '2026-07-21']);
    assert.equal((parse('2026-07-21 09:30:00') as Date).toISOString(), '2026-07-21T09:30:00.000Z');
  });

  it('delegates unrecognised wire text to the parser it replaced', () => {
    const seen: string[] = [];
    const parse = createUtcDateParser((text) => {
      seen.push(text);
      return 'fallback';
    });
    assert.equal(parse('epoch'), 'fallback');
    assert.equal(parse('2026-7-1'), 'fallback');
    assert.equal(parse(''), 'fallback');
    assert.deepEqual(seen, ['epoch', '2026-7-1', '']);
  });

  it('array parser handles quoting and NULL without calling the element parser on NULL', () => {
    const parse = createPgArrayParser((text) => {
      assert.notEqual(text, null);
      return text.toUpperCase();
    });
    assert.deepEqual(parse('{a,NULL,"b,c"}'), ['A', null, 'B,C']);
    assert.deepEqual(parse('{}'), []);
  });

  it('the scalar and array timestamp parsers agree', () => {
    const arr = createPgArrayParser(parseUtcTimestampText)('{"2026-07-21 09:30:00"}');
    assert.equal((arr[0] as Date).toISOString(), parseUtcTimestampText('2026-07-21 09:30:00').toISOString());
  });
});

/** A pool object Turbine treats as external. Never connects. */
function inertPool(): PgCompatPool {
  return {
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => {
      throw new Error('not used');
    },
    end: async () => {},
    on: () => {},
  } as unknown as PgCompatPool;
}

describe('TurbineClient parser registration', () => {
  const schema: SchemaMetadata = {
    tables: { events: mockTable('events', [mockColumn('id', 'id', 'int4')]) },
    enums: {},
  };

  it('registers 1082 / 1182 / 1115 for a Turbine-owned pool', () => {
    // Constructing the client is enough, pg.Pool does not connect eagerly.
    new TurbineClient({ connectionString: 'postgres://unused/unused' }, schema);
    const parseDate = getParser(1082);
    const parseDateArray = getParser(1182);
    const parseTimestampArray = getParser(1115);
    assert.equal((parseDate('2026-07-21') as Date).toISOString(), '2026-07-21T00:00:00.000Z');
    assert.equal((parseDateArray('{2026-07-21}') as Date[])[0]?.toISOString(), '2026-07-21T00:00:00.000Z');
    assert.equal(
      (parseTimestampArray('{"2026-07-21 09:30:00"}') as Date[])[0]?.toISOString(),
      '2026-07-21T09:30:00.000Z',
    );
  });

  it('never registers a parser for an externally supplied pool', () => {
    // Same rule as the int8 parser: setTypeParser is process-global, so an
    // external pool's own parser configuration is left alone. Proven on a
    // scalar OID Turbine does not otherwise touch.
    const before = getParser(1083);
    new TurbineClient({ pool: inertPool() }, schema);
    assert.equal(getParser(1083), before);
  });

  it('holds an external-pool client to the process-wide utcTimestamps decision', () => {
    // An external-pool client registers nothing, but it READS through whatever
    // an owned client in the same process installed. Left out of the agreement
    // check it would write local `date` literals while reading UTC ones, which
    // walks the stored calendar day back one day per read-modify-write cycle.
    TurbineClient.resetUtcTimestampsForTests();
    new TurbineClient({ connectionString: 'postgres://unused/unused' }, schema);
    assert.throws(
      () => new TurbineClient({ pool: inertPool(), utcTimestamps: false }, schema),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match((err as Error).message, /utcTimestamps: false conflicts with utcTimestamps: true/);
        return true;
      },
    );
    // The same value is fine, and so is an external-pool client alone.
    assert.doesNotThrow(() => new TurbineClient({ pool: inertPool() }, schema));
    TurbineClient.resetUtcTimestampsForTests();
    assert.doesNotThrow(() => new TurbineClient({ pool: inertPool(), utcTimestamps: false }, schema));
  });
});
