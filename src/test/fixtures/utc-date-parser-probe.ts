/**
 * Child-process probe for the zone-less temporal driver parsers.
 *
 * Run with a forced `TZ`, it prints one JSON line describing what the pg
 * DEFAULT parsers and Turbine's replacements make of the same wire text. The
 * parent test asserts Turbine's values are UTC-pinned in every zone, and that
 * the default values are not (which is what makes the assertion meaningful).
 *
 * A child process is required because `TZ` is read once when the process
 * initializes its zone data, so it cannot be flipped from inside a test.
 */
import pg from 'pg';
import { createPgArrayParser, createUtcDateParser, createUtcTimestampParser } from '../../query/utils.js';

/** pg-types declares getTypeParser over an OID enum that omits the array OIDs. */
const getParser = pg.types.getTypeParser as unknown as (oid: number, format: 'text') => (value: string) => unknown;

const defaultDate = getParser(1082, 'text');
const defaultTimestamp = getParser(1114, 'text');
const defaultDateArray = getParser(1182, 'text');
const defaultTimestampArray = getParser(1115, 'text');

// Exactly the composition client.ts registers, so the probe cannot drift from
// the shipped parsers.
const parseDate = createUtcDateParser(defaultDate);
const parseTimestamp = createUtcTimestampParser(defaultTimestamp);
const parseDateArray = createPgArrayParser(parseDate);
const parseTimestampArray = createPgArrayParser(parseTimestamp);

/** ISO string for a Date, the raw value for Infinity / -Infinity, else a tag. */
function show(value: unknown): unknown {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  if (typeof value === 'number') return value === Infinity ? 'Infinity' : value === -Infinity ? '-Infinity' : value;
  return value;
}

const showAll = (value: unknown): unknown => (Array.isArray(value) ? value.map(show) : show(value));

process.stdout.write(
  `${JSON.stringify({
    tz: process.env.TZ ?? null,
    defaultDate: show(defaultDate('2026-07-21')),
    defaultDateArray: showAll(defaultDateArray('{2026-07-21}')),
    defaultTimestampArray: showAll(defaultTimestampArray('{"2026-07-21 09:30:00"}')),
    date: show(parseDate('2026-07-21')),
    dateLow: show(parseDate('0001-01-01')),
    dateBc: show(parseDate('0044-03-15 BC')),
    dateWideYear: show(parseDate('12026-07-21')),
    infinity: show(parseDate('infinity')),
    negInfinity: show(parseDate('-infinity')),
    dateArray: showAll(parseDateArray('{2026-07-21,NULL,2026-01-01}')),
    dateArrayEmpty: showAll(parseDateArray('{}')),
    timestamp: show(parseTimestamp('2026-07-21 09:30:00')),
    timestampMicros: show(parseTimestamp('2026-07-21 09:30:00.123456')),
    timestampBc: show(parseTimestamp('0044-03-15 09:30:00 BC')),
    timestampWideYear: show(parseTimestamp('12026-07-21 09:30:00')),
    timestampInfinity: show(parseTimestamp('infinity')),
    timestampNegInfinity: show(parseTimestamp('-infinity')),
    timestampArray: showAll(parseTimestampArray('{"2026-07-21 09:30:00",NULL}')),
    // The regression this file exists to catch: `infinity` inside a
    // timestamp[] used to become an Invalid Date once OID 1115 was overridden.
    timestampArrayInfinity: showAll(parseTimestampArray('{infinity,-infinity}')),
    dateArrayInfinity: showAll(parseDateArray('{infinity}')),
  })}\n`,
);
