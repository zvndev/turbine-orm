/**
 * turbine-orm, the fast temporal decode path: DIFFERENTIAL test.
 *
 * ## What this file is for
 *
 * The temporal driver parsers (`date` 1082, `timestamp` 1114,
 * `timestamptz` 1184, and their array forms 1182 / 1115 / 1185) now try a
 * hand-written character scan before the general parser. The scan exists for
 * ONE reason, speed: `timestamptz` alone is ~88% of the client-side decode cost
 * of a wide row drain, and decode is roughly a third of that drain.
 *
 * A faster decoder is worth nothing if it is not the SAME decoder. So the
 * contract this file enforces is not "the fast path returns a sensible Date",
 * it is **"the fast path returns exactly what the parser it replaces
 * returned"**, value for value, or does not claim the value at all.
 *
 * That makes the reference side load-bearing, and it is captured, not
 * described:
 *
 *   - for 1184 the reference is `postgres-date`, read out of `pg.types` at
 *     module load BEFORE anything in this process can have registered over it;
 *   - for 1082 / 1114 the reference is the exact regex implementation that
 *     shipped, still present and still exported as
 *     `createUtcDateParserGeneral` / `createUtcTimestampParserGeneral`. The
 *     fast path delegates to it, so "the previous behaviour" is not a
 *     transcription in a test, it is the running code.
 *
 * ## The two failures this file exists to prevent
 *
 * A throwaway fast decoder written during the ceiling measurement got 3 of 15
 * edge values wrong while deliberately delegating the traps it knew about.
 * Both of its bugs are asserted here:
 *
 *   1. `Date.UTC` maps years 0-99 onto 1900-1999, so `0044-03-15` decoded as
 *      1944 and `0001-01-01` as 1901. The scan refuses a year below 100
 *      outright rather than trying to correct it, because the correction
 *      (`setUTCFullYear` on an already-built Date) is itself wrong for the
 *      year-0 leap day.
 *   2. An offset parse that ran to end-of-string silently ATE a trailing
 *      ` BC`, giving AD 4713 instead of BC 4713: off by 9,424 years, no error.
 *      The scan requires end-of-string after the offset.
 *
 * For scale, the same 15 values through `new Date(v)` (which is Drizzle's
 * whole timestamptz decoder) are wrong on 5. That comparison is asserted too,
 * so the claim "faster AND more correct than the alternative" has a test
 * behind it rather than a sentence.
 *
 * The GUC half of the differential (DateStyle and TimeZone are server
 * settings, so the wire shape is not a constant) lives in
 * src/test/fast-temporal-decode.integration.test.ts, which needs a database.
 *
 * Run: npx tsx --test src/test/fast-temporal-decode.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pg from 'pg';
import {
  createFastTimestamptzParser,
  createPgArrayParser,
  createUtcDateParser,
  createUtcDateParserGeneral,
  createUtcTimestampParser,
  createUtcTimestampParserGeneral,
} from '../query/utils.js';

/**
 * pg's parser table AS IT SHIPS, captured before any Turbine registration can
 * have run in this process. `node --test` gives each file its own process, and
 * this module has no import that constructs a client, so these really are the
 * driver defaults. Reading them later would hand back Turbine's own parser and
 * the differential would compare the fast path against itself.
 */
const getParser = (oid: number): ((value: string) => unknown) =>
  (pg.types.getTypeParser as unknown as (id: number, format: 'text') => (value: string) => unknown)(oid, 'text');

const PG_DATE = getParser(1082);
const PG_TIMESTAMP = getParser(1114);
const PG_TIMESTAMPTZ = getParser(1184);
const PG_DATE_ARRAY = getParser(1182);
const PG_TIMESTAMP_ARRAY = getParser(1115);
const PG_TIMESTAMPTZ_ARRAY = getParser(1185);

/**
 * A comparable rendering of a parser result. Dates compare by INSTANT and not
 * by identity; `Invalid Date` is named rather than rendered (`toISOString`
 * throws on it), because an Invalid Date silently flowing on is one of the
 * failure modes being tested for.
 */
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

/** Run a parser, turning a throw into a comparable token rather than a failure. */
function run(parse: (text: string) => unknown, text: string): string {
  try {
    return render(parse(text));
  } catch (err) {
    return `THREW ${(err as Error).message}`;
  }
}

/**
 * The differential itself: for every value, the parser under test and the
 * parser it replaces must render identically. The failure message carries the
 * value and both renderings, because "expected X to equal Y" with two ISO
 * strings is unreadable when the difference is one millisecond or 9,424 years.
 */
function assertAgrees(
  label: string,
  values: readonly string[],
  fast: (text: string) => unknown,
  reference: (text: string) => unknown,
): void {
  const disagreements: string[] = [];
  for (const value of values) {
    const a = run(fast, value);
    const b = run(reference, value);
    if (a !== b) disagreements.push(`  ${JSON.stringify(value)}\n    fast:      ${a}\n    reference: ${b}`);
  }
  assert.equal(
    disagreements.length,
    0,
    `${label}: ${disagreements.length} of ${values.length} values decode differently\n${disagreements.join('\n')}`,
  );
}

// ---------------------------------------------------------------------------
// The value matrix. Every entry is a shape PostgreSQL can actually put on the
// wire for the type in question, plus the malformed neighbours a decoder must
// not accidentally claim.
// ---------------------------------------------------------------------------

/** `timestamptz` (OID 1184), ISO DateStyle. */
const TIMESTAMPTZ_VALUES: readonly string[] = [
  // the ordinary case, which is the only one the fast path is FOR
  '2026-08-15 12:25:43.476603-04',
  '2024-01-01 00:00:00+00',
  '1970-01-01 00:00:00+00',
  '2026-08-15 12:25:43+00',
  // Z versus +00: two spellings of the same offset
  '2024-01-01 00:00:00Z',
  '2024-01-01 00:00:00+00',
  '2024-01-01 00:00:00.5Z',
  // fractional seconds at 1, 2, 3 and 6 digits (PostgreSQL emits up to 6)
  '2024-01-01 00:00:00.1+00',
  '2024-01-01 00:00:00.12+00',
  '2024-01-01 00:00:00.123+00',
  '2024-01-01 00:00:00.123456+00',
  '2024-01-01 00:00:00.000001+00',
  '2024-01-01 00:00:00.999999+00',
  '2024-01-01 00:00:00.477+00',
  '2024-01-01 00:00:00.0+00',
  // half-hour and 45-minute offsets: Kolkata is +05:30, Kathmandu is +05:45
  '2024-06-30 23:59:59.999999+05:30',
  '2024-06-30 23:59:59.999999+05:45',
  '2024-06-30 23:59:59-09:30',
  // an offset with SECONDS, which PostgreSQL emits for pre-standard-time
  // instants in zones whose LMT offset was not a whole minute
  '1850-01-01 00:00:00+00:19:32',
  '1850-01-01 00:00:00-00:19:32',
  // whole-hour offsets, both signs, both spellings
  '2024-01-01 00:00:00-08',
  '2024-01-01 00:00:00+14',
  '2024-01-01 00:00:00-08:00',
  '2024-01-01 00:00:00+05:00',
  // leap day, and the day either side of it
  '2024-02-29 12:00:00+00',
  '2024-02-28 23:59:59+00',
  '2024-03-01 00:00:00+00',
  '2023-02-28 12:00:00+00',
  // years below 100: the Date.UTC(1900) trap, both of the ceiling decoder's
  // failures
  '0001-01-01 00:00:00+00',
  '0044-03-15 12:00:00+00',
  '0099-12-31 23:59:59+00',
  '0100-01-01 00:00:00+00',
  // 5-digit years, above the ISO-8601 four-digit form entirely
  '12024-01-01 00:00:00+00',
  '99999-12-31 23:59:59+00',
  // BC, the second ceiling failure: the offset is not the end of the string
  '4713-01-01 00:00:00+00 BC',
  '0044-03-15 12:00:00+00 BC',
  '0001-12-31 23:59:59.123456-05 BC',
  // the two infinities
  'infinity',
  '-infinity',
  // empty string (the array parsers treat it specially, so the scalar side is
  // pinned too) and shapes no fast path may claim
  '',
  '2024-01-01',
  '2024-01-01T00:00:00+00',
  '2024-01-01 00:00:00',
  '2024-1-1 00:00:00+00',
  '2024-01-01 00:00:00+0530',
  '2024-01-01 00:00:00 UTC',
  '2024-01-01 00:00:00.+00',
  'not a timestamp at all',
  'epoch',
];

/** `timestamp` without time zone (OID 1114). Never carries an offset. */
const TIMESTAMP_VALUES: readonly string[] = [
  '2026-07-21 09:30:00',
  '2026-07-21 09:30:00.1',
  '2026-07-21 09:30:00.12',
  '2026-07-21 09:30:00.123',
  '2026-07-21 09:30:00.123456',
  '2026-07-21 09:30:00.999999',
  '2026-07-21T09:30:00',
  '2026-07-21T09:30:00.123456',
  '2024-02-29 12:00:00',
  '0001-01-01 00:00:00',
  '0044-03-15 12:00:00',
  '0099-12-31 23:59:59',
  '0100-01-01 00:00:00',
  '12026-07-21 09:30:00',
  '0044-03-15 12:00:00 BC',
  '4713-01-01 00:00:00 BC',
  'infinity',
  '-infinity',
  '',
  '2026-07-21',
  '2026-07-21 09:30:00+00',
  '2026-7-21 09:30:00',
  '2026-07-21 09:30:00.',
  'epoch',
];

/** `date` (OID 1082). A calendar day, no time, no offset. */
const DATE_VALUES: readonly string[] = [
  '2026-07-21',
  '2024-02-29',
  '2024-12-31',
  '0001-01-01',
  '0044-03-15',
  '0099-12-31',
  '0100-01-01',
  '12026-07-21',
  '0044-03-15 BC',
  '4713-01-01 BC',
  'infinity',
  '-infinity',
  '',
  '2026-7-1',
  '2026-07-21 00:00:00',
  'epoch',
];

/** Wrap scalar wire values into the array wire form PostgreSQL emits. */
function arrayLiteral(values: readonly string[]): string {
  return `{${values.map((v) => `"${v}"`).join(',')}}`;
}

const ARRAY_CASES: readonly { label: string; text: string }[] = [
  { label: 'empty array', text: '{}' },
  { label: 'single element', text: '{"2024-01-01 00:00:00+00"}' },
  { label: 'NULL element only', text: '{NULL}' },
  { label: 'NULL between values', text: '{"2024-01-01 00:00:00+00",NULL,"2026-08-15 12:25:43.476603-04"}' },
  { label: 'leading and trailing NULL', text: '{NULL,"2024-01-01 00:00:00+00",NULL}' },
  { label: 'infinities', text: '{infinity,-infinity}' },
  { label: 'BC element', text: '{"4713-01-01 00:00:00+00 BC"}' },
  { label: 'low year element', text: '{"0044-03-15 12:00:00+00"}' },
  { label: 'wide year element', text: '{"12024-01-01 00:00:00+00"}' },
  { label: 'offsets', text: arrayLiteral(['2024-01-01 00:00:00+05:45', '2024-01-01 00:00:00-08']) },
  // Not a wire shape (a NULL column never reaches the parser at all), pinned
  // because pg's own array parser special-cases it and Turbine's must not
  // silently answer differently.
  { label: 'empty string', text: '' },
];

// ---------------------------------------------------------------------------
describe('fast temporal decode: differential against the parser it replaces', () => {
  it('timestamptz (1184) agrees with postgres-date on every value', () => {
    assertAgrees('timestamptz 1184', TIMESTAMPTZ_VALUES, createFastTimestamptzParser(PG_TIMESTAMPTZ), PG_TIMESTAMPTZ);
  });

  it('timestamp (1114) agrees with the general parser on every value', () => {
    assertAgrees(
      'timestamp 1114',
      TIMESTAMP_VALUES,
      createUtcTimestampParser(PG_TIMESTAMP),
      createUtcTimestampParserGeneral(PG_TIMESTAMP),
    );
  });

  it('date (1082) agrees with the general parser on every value', () => {
    assertAgrees('date 1082', DATE_VALUES, createUtcDateParser(PG_DATE), createUtcDateParserGeneral(PG_DATE));
  });

  it('timestamptz[] (1185) agrees with pg on every array shape', () => {
    const fast = createPgArrayParser(createFastTimestamptzParser(PG_TIMESTAMPTZ));
    for (const c of ARRAY_CASES) {
      assert.equal(run(fast, c.text), run(PG_TIMESTAMPTZ_ARRAY, c.text), `timestamptz[]: ${c.label} (${c.text})`);
    }
  });

  it('timestamp[] (1115) and date[] (1182) agree with their own element parsers', () => {
    // The array forms exist to stop a scalar column and an array column of the
    // same type disagreeing, so the assertion is against the SCALAR parser
    // lifted element by element, not against pg (which reads 1115 / 1182 in the
    // process's local zone, the reading `utcTimestamps` exists to replace).
    const scalarTs = createUtcTimestampParser(PG_TIMESTAMP);
    const arrayTs = createPgArrayParser(scalarTs);
    assert.equal(
      render(arrayTs('{"2026-07-21 09:30:00","0044-03-15 12:00:00",NULL,infinity}')),
      render([scalarTs('2026-07-21 09:30:00'), scalarTs('0044-03-15 12:00:00'), null, scalarTs('infinity')]),
    );
    const scalarDate = createUtcDateParser(PG_DATE);
    const arrayDate = createPgArrayParser(scalarDate);
    assert.equal(
      render(arrayDate('{2026-07-21,0044-03-15,NULL,infinity}')),
      render([scalarDate('2026-07-21'), scalarDate('0044-03-15'), null, scalarDate('infinity')]),
    );
    // pg's own array parser returns null (not []) for an empty string. Turbine's
    // must match it, or 1115 / 1182 answer a shape pg never would.
    assert.equal(arrayTs(''), null);
    assert.equal(arrayDate(''), null);
    assert.equal(PG_TIMESTAMP_ARRAY(''), null);
    assert.equal(PG_DATE_ARRAY(''), null);
    assert.deepEqual(arrayTs('{}'), []);
    assert.deepEqual(arrayDate('{}'), []);
  });

  it('never hands a NULL array element to the element parser', () => {
    const parse = createPgArrayParser((text) => {
      assert.notEqual(text, null, 'element parser was called with NULL');
      return text.toUpperCase();
    });
    assert.deepEqual(parse('{a,NULL,"b,c"}'), ['A', null, 'B,C']);
  });
});

describe('fast temporal decode: the two ceiling-decoder bugs, asserted directly', () => {
  it('does not map a year below 100 into the 1900s', () => {
    const parse = createFastTimestamptzParser(PG_TIMESTAMPTZ);
    // 0044-03-15 must not become 1944, and 0001-01-01 must not become 1901.
    assert.equal((parse('0044-03-15 12:00:00+00') as Date).toISOString(), '0044-03-15T12:00:00.000Z');
    assert.equal((parse('0001-01-01 00:00:00+00') as Date).toISOString(), '0001-01-01T00:00:00.000Z');
    assert.equal((parse('0099-12-31 23:59:59+00') as Date).toISOString(), '0099-12-31T23:59:59.000Z');
    // and the first year the fast path may claim is still right
    assert.equal((parse('0100-01-01 00:00:00+00') as Date).toISOString(), '0100-01-01T00:00:00.000Z');
    const ts = createUtcTimestampParser(PG_TIMESTAMP);
    assert.equal((ts('0044-03-15 12:00:00') as Date).toISOString(), '0044-03-15T12:00:00.000Z');
    const d = createUtcDateParser(PG_DATE);
    assert.equal((d('0044-03-15') as Date).toISOString(), '0044-03-15T00:00:00.000Z');
  });

  it('does not swallow a trailing BC after the offset', () => {
    const parse = createFastTimestamptzParser(PG_TIMESTAMPTZ);
    const bc = parse('4713-01-01 00:00:00+00 BC') as Date;
    // BC 4713 in astronomical years is -4712, not AD 4713.
    assert.equal(bc.getUTCFullYear(), -4712);
    assert.equal(bc.toISOString(), '-004712-01-01T00:00:00.000Z');
    assert.notEqual(bc.getUTCFullYear(), 4713);
  });

  it('keeps infinity on the driver reading rather than turning it into a Date', () => {
    // Normalization of temporal infinity happens one level up, in the ORM row
    // parser. A driver parser that decided it here would rewrite the reading
    // for every other consumer of the same pg module.
    for (const parse of [
      createFastTimestamptzParser(PG_TIMESTAMPTZ),
      createUtcTimestampParser(PG_TIMESTAMP),
      createUtcDateParser(PG_DATE),
    ]) {
      assert.equal(parse('infinity'), Number.POSITIVE_INFINITY);
      assert.equal(parse('-infinity'), Number.NEGATIVE_INFINITY);
    }
  });

  it('delegates, rather than guesses, every shape it does not recognise', () => {
    const seen: string[] = [];
    const parse = createFastTimestamptzParser((text) => {
      seen.push(text);
      return 'delegated';
    });
    const delegated = [
      'infinity',
      '-infinity',
      '',
      '2024-01-01',
      '2024-01-01 00:00:00',
      '2024-01-01T00:00:00+00',
      '0044-03-15 12:00:00+00',
      '12024-01-01 00:00:00+00',
      '4713-01-01 00:00:00+00 BC',
      '2024-01-01 00:00:00+0530',
      '2024-01-01 00:00:00 UTC',
      'Wed Jan 01 00:00:00 2024 UTC',
      '01/02/2024 03:04:05+00',
    ];
    for (const v of delegated) assert.equal(parse(v), 'delegated', `should delegate ${JSON.stringify(v)}`);
    assert.deepEqual(seen, delegated);
    // and the shape it DOES claim never reaches the fallback
    assert.equal(run(parse, '2024-01-01 00:00:00+00'), 'Date(2024-01-01T00:00:00.000Z)');
    assert.equal(seen.length, delegated.length);
  });
});

describe('fast temporal decode: what the naive alternative costs in fidelity', () => {
  it('is right where a bare new Date(v) is wrong', () => {
    // Drizzle's timestamptz decoder is `(v) => new Date(v)` (pg-core/codecs).
    // This is not a swipe, it is the reason correctness is not negotiable for
    // speed here: the fast path is only worth having if it is BOTH.
    const fast = createFastTimestamptzParser(PG_TIMESTAMPTZ);
    const naive = (v: string) => new Date(v);
    const wrongForNaive: string[] = [];
    for (const v of TIMESTAMPTZ_VALUES) {
      if (run(naive, v) !== run(PG_TIMESTAMPTZ, v)) wrongForNaive.push(v);
    }
    // Named individually so a change in the matrix cannot quietly empty this.
    for (const v of ['infinity', '-infinity', '0044-03-15 12:00:00+00', '0001-01-01 00:00:00+00']) {
      assert.ok(wrongForNaive.includes(v), `new Date(${JSON.stringify(v)}) should disagree with pg`);
    }
    assert.ok(
      wrongForNaive.length >= 5,
      `expected the naive decoder to be wrong on 5+ values, got ${wrongForNaive.length}`,
    );
    // The fast path is wrong on none of them: that assertion is the whole file,
    // repeated here so this comparison cannot be read as the only evidence.
    for (const v of TIMESTAMPTZ_VALUES) assert.equal(run(fast, v), run(PG_TIMESTAMPTZ, v), v);
  });
});
