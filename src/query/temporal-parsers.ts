/**
 * Temporal text parser factories with no driver or runtime imports.
 *
 * The caller supplies the parser for unrecognized input. Driver bindings own
 * fallback snapshots, array parsing and registration; constructing a factory
 * here never reads or changes a process-global parser table.
 */

// ---------------------------------------------------------------------------
// The fast temporal scan
//
// Every temporal parser below is a two-stage function: a hand-written
// character scan that claims the ONE wire shape a busy application actually
// produces, and behind it the general parser, which is where every other shape
// (and every shape a future server adds) still goes.
//
// WHY IT EXISTS, stated as a measurement rather than an intuition. Draining
// 50,000 rows of the benchmark `comments` fixture spends ~23.5 ms in
// client-side type decoding, and `timestamptz` alone is 20.7 ms of it (88%).
// The remaining types are not worth touching: `text`, `numeric`, `uuid` and
// `bool` cost nothing at all, because pg registers no parser for them. Two
// hard bounds were verified in node-postgres' source before any of this was
// written, and they say what a decoder rewrite can and cannot reach: every
// cell is materialised as a JS string by `reader.string(len)` before any
// parser is consulted, so the `utf8Slice` half is unreachable; and the binary
// protocol is not an escape hatch, the parser constructor throws
// `Binary mode not supported yet`. The type-PARSING half is the whole budget,
// and this is a claim on it.
//
// THE RULE, and it is the only thing that makes a fast path acceptable here:
// **the scan must return exactly what the parser it replaces returned, or
// return `null` and not claim the value at all.** It never guesses, never
// "handles" a shape approximately, and never widens what it accepts to cover
// one more case. Every refusal costs a few charCode compares and is repaid by
// the general parser being correct.
//
// Two traps are baked into the refusals rather than into corrections, because
// a throwaway version of this decoder wrote during the ceiling measurement got
// 3 of 15 edge values wrong while believing it had delegated the hard ones:
//
//   1. `Date.UTC` maps years 0-99 onto 1900-1999, so `0044-03-15` decodes as
//      1944 and `0001-01-01` as 1901. The obvious repair, build the Date then
//      `setUTCFullYear`, is ALSO wrong: year 0 is a leap year in the proleptic
//      Gregorian calendar and 1900 is not, so `0000-02-29` built that way
//      lands on March 1st. The scan refuses `year < 100` and lets the general
//      parser's `new Date(0)` + `setUTCFullYear(y, m, d)` assembly (which sets
//      all three fields against the right year's calendar) answer it.
//   2. An offset parse that runs to end-of-string silently EATS a trailing
//      ` BC`: `4713-01-01 00:00:00+00 BC` decodes as AD 4713, off by 9,424
//      years with no error. The scan requires end-of-string after the offset.
//
// Differential coverage: src/test/fast-temporal-decode.test.ts compares the
// scan against the parser it replaces value for value, and
// src/test/fast-temporal-decode.integration.test.ts does the same against a
// live server with `DateStyle` and `TimeZone` varied, because the wire shape
// is a server setting and a decoder tuned to one `DateStyle` is a latent
// corruption bug.
// ---------------------------------------------------------------------------

// Wire shape the scan is reading. Plain module constants rather than an enum:
// this repo's lint config rejects `const enum` (it does not survive
// `isolatedModules`), and a plain `enum` emits a runtime object, so every
// `Shape.Date` in the scan below would become a property load in the hottest
// loop in the library. These are values, never serialized, never persisted.
/** `YYYY-MM-DD` (OID 1082). */
const SHAPE_DATE = 0;
/** `YYYY-MM-DD[ T]HH:MM:SS[.f…]` (OID 1114), never an offset. */
const SHAPE_TIMESTAMP = 1;
/** `YYYY-MM-DD HH:MM:SS[.f…](Z|±HH[:MM[:SS]])` (OID 1184), offset REQUIRED. */
const SHAPE_TIMESTAMPTZ = 2;

const CH_HYPHEN = 45;
const CH_COLON = 58;
const CH_DOT = 46;
const CH_SPACE = 32;
const CH_T = 84;
const CH_Z = 90;
const CH_PLUS = 43;
/** Same code point as {@link CH_HYPHEN}; named separately because the two read
 * as different things (a date separator, an offset sign) at their use sites. */
const CH_MINUS = 45;

/**
 * Two ASCII digits at `i` as a number, or `-1` if either character is not a
 * digit. `charCodeAt` past the end returns `NaN`, and `NaN - 48` is `NaN`,
 * which fails both range tests, so this needs no separate length check.
 */
function twoDigitsAt(text: string, i: number): number {
  const hi = text.charCodeAt(i) - 48;
  const lo = text.charCodeAt(i + 1) - 48;
  return hi >= 0 && hi <= 9 && lo >= 0 && lo <= 9 ? hi * 10 + lo : -1;
}

/**
 * Decode `text` if it is exactly the canonical ISO wire shape for `shape`, or
 * return `null` to say "not mine" (see the rule in the block comment above).
 *
 * Deliberately NOT accepted, each because the parser it replaces would answer
 * differently:
 *
 *   - a year that is not exactly four digits. A 5-digit year is a real
 *     PostgreSQL output and the general parser handles it; a fast path that
 *     matched a variable-width year would have to re-find every later field.
 *   - a year below 100 (trap 1 above).
 *   - a `T` separator for `SHAPE_TIMESTAMPTZ`. `postgres-date`'s
 *     own date-time regex requires a literal SPACE, so it returns `null` for
 *     `2024-01-01T00:00:00+00`; a scan that accepted `T` there would invent a
 *     Date where the driver hands back null. `timestamp` (1114) does accept it
 *     because the general parser it replaces does.
 *   - a missing offset for `SHAPE_TIMESTAMPTZ`. `postgres-date` reads an
 *     offset-less value in the process's LOCAL zone, which is not what this
 *     scan computes.
 *   - a colon-less offset (`+0530`), an alphabetic zone (` UTC`), or anything
 *     at all after the offset, including ` BC` (trap 2 above).
 *   - a bare `.` with no fractional digits.
 *
 * Field-value overflow (`2024-13-45`, `25:70:99`) IS accepted, because
 * `Date.UTC` rolls those over exactly as the general parser's `setUTCFullYear`
 * / `setUTCHours` do. PostgreSQL never emits them; agreeing on them is free.
 */
function scanIsoTemporal(text: string, shape: number): Date | null {
  const len = text.length;
  if (len < 10) return null;
  if (text.charCodeAt(4) !== CH_HYPHEN || text.charCodeAt(7) !== CH_HYPHEN) return null;
  const yearHi = twoDigitsAt(text, 0);
  const yearLo = twoDigitsAt(text, 2);
  if (yearHi < 0 || yearLo < 0) return null;
  const year = yearHi * 100 + yearLo;
  if (year < 100) return null;
  const month = twoDigitsAt(text, 5);
  const day = twoDigitsAt(text, 8);
  if (month < 0 || day < 0) return null;

  if (shape === SHAPE_DATE) {
    return len === 10 ? new Date(Date.UTC(year, month - 1, day)) : null;
  }

  if (len < 19) return null;
  const sep = text.charCodeAt(10);
  if (shape === SHAPE_TIMESTAMP ? sep !== CH_SPACE && sep !== CH_T : sep !== CH_SPACE) return null;
  if (text.charCodeAt(13) !== CH_COLON || text.charCodeAt(16) !== CH_COLON) return null;
  const hour = twoDigitsAt(text, 11);
  const minute = twoDigitsAt(text, 14);
  const second = twoDigitsAt(text, 17);
  if (hour < 0 || minute < 0 || second < 0) return null;

  let i = 19;
  let ms = 0;
  if (text.charCodeAt(i) === CH_DOT) {
    i++;
    let digits = 0;
    for (;;) {
      const d = text.charCodeAt(i) - 48;
      if (!(d >= 0 && d <= 9)) break;
      // Only the first three digits survive: PostgreSQL emits up to six and a
      // JS Date holds milliseconds. `postgres-date` gets the same answer by a
      // different route (`1000 * parseFloat('.476603')`, truncated by
      // `Date.UTC`), and the two agree on every 1-to-6-digit fraction.
      if (digits < 3) ms = ms * 10 + d;
      digits++;
      i++;
    }
    if (digits === 0) return null;
    if (digits === 1) ms *= 100;
    else if (digits === 2) ms *= 10;
  }

  if (shape === SHAPE_TIMESTAMP) {
    return i === len ? new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms)) : null;
  }

  let offsetMs = 0;
  const signCode = text.charCodeAt(i);
  if (signCode === CH_Z) {
    i++;
  } else if (signCode === CH_PLUS || signCode === CH_MINUS) {
    i++;
    const offsetHours = twoDigitsAt(text, i);
    if (offsetHours < 0) return null;
    i += 2;
    let offsetMinutes = 0;
    let offsetSeconds = 0;
    if (text.charCodeAt(i) === CH_COLON) {
      offsetMinutes = twoDigitsAt(text, i + 1);
      if (offsetMinutes < 0) return null;
      i += 3;
      // A zone whose historical LMT offset was not a whole minute emits
      // seconds too (`1850-01-01 00:00:00+00:19:32`).
      if (text.charCodeAt(i) === CH_COLON) {
        offsetSeconds = twoDigitsAt(text, i + 1);
        if (offsetSeconds < 0) return null;
        i += 3;
      }
    }
    offsetMs =
      (offsetHours * 3_600_000 + offsetMinutes * 60_000 + offsetSeconds * 1000) * (signCode === CH_MINUS ? -1 : 1);
  } else {
    return null;
  }
  if (i !== len) return null;
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms) - offsetMs);
}

/**
 * A Postgres `date` wire value: `YYYY-MM-DD`, optionally with more than four
 * year digits, optionally suffixed ` BC`. Anything else (`infinity`,
 * `-infinity`, and any shape a future server adds) is deliberately NOT matched
 * so it falls through to the driver's own parser untouched.
 */
const PG_DATE_TEXT_RE = /^(\d{4,})-(\d{2})-(\d{2})( BC)?$/;

/**
 * Build the driver parser for Postgres `date` (OID 1082) that reads a
 * zone-less calendar day as **UTC midnight**.
 *
 * The pg default builds the Date from the process's LOCAL zone, so the stored
 * calendar day `2026-07-21` comes back as `2026-07-20T22:00:00Z` in
 * `Europe/Berlin` and `2026-07-20T15:00:00Z` in `Asia/Tokyo`: the wrong
 * calendar day everywhere east of UTC, and the wrong instant everywhere except
 * UTC itself. It is also the exact mirror-image of the WRITE side, which
 * already renders a bound `Date` from its UTC components
 * ({@link toLocalDateTimeLiteral}), so today a read-modify-write cycle on a
 * `date` column east of UTC walks the stored day one day earlier per cycle.
 * This is the missing read half of `utcTimestamps`, matching what
 * {@link parseDbDate} already does for the JSON path and what the OID 1114
 * parser already does for `timestamp`.
 *
 * `fallback` is the parser this one REPLACES, and it must be captured with
 * `pg.types.getTypeParser(1082, 'text')` BEFORE registration (reading it after
 * would hand back this function and recurse forever). It keeps `infinity` /
 * `-infinity` on the driver's `Infinity` / `-Infinity`.
 *
 * `setUTCFullYear` rather than the `Date` constructor, so a two-or-three-digit
 * year is not silently mapped into the 1900s, and ` BC` maps to the
 * astronomical year (`0044 BC` → -43) the way the driver's own parser does.
 */
export function createUtcDateParser(fallback: (text: string) => unknown): (text: string) => unknown {
  const general = createUtcDateParserGeneral(fallback);
  return (text: string): unknown => scanIsoTemporal(text, SHAPE_DATE) ?? general(text);
}

/**
 * The `date` (OID 1082) parser WITHOUT the fast scan in front of it: the regex
 * implementation described by {@link createUtcDateParser}, and the reference
 * side of the differential test.
 *
 * Exported so "what the fast path must agree with" is the running code rather
 * than a transcription of it in a test file. Two hand-synced copies of a
 * parser is the drift class this repo has been bitten by before; there is one
 * copy, and the fast path delegates to it.
 *
 * @internal
 */
export function createUtcDateParserGeneral(fallback: (text: string) => unknown): (text: string) => unknown {
  return (text: string): unknown => {
    const m = PG_DATE_TEXT_RE.exec(text);
    if (!m) return fallback(text);
    const year = m[4] ? -(Number(m[1]) - 1) : Number(m[1]);
    const date = new Date(0);
    date.setUTCFullYear(year, Number(m[2]) - 1, Number(m[3]));
    date.setUTCHours(0, 0, 0, 0);
    return date;
  };
}

/**
 * A Postgres `timestamp` (without time zone) wire value:
 * `YYYY-MM-DD HH:MM:SS`, optionally with more than four year digits, optional
 * fractional seconds, optional ` BC`. As with {@link PG_DATE_TEXT_RE},
 * `infinity` / `-infinity` and any shape a future server adds deliberately do
 * NOT match, so they fall through to the driver's own parser untouched.
 */
const PG_TIMESTAMP_TEXT_RE = /^(\d{4,})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?( BC)?$/;

/**
 * Build the driver parser for Postgres `timestamp` (OID 1114) that reads an
 * offset-less date-time as UTC. Also lifted to the `_timestamp` array OID
 * (1115), so the scalar and the array can never settle on different
 * interpretations.
 *
 * `fallback` is the parser this one REPLACES and must be captured with
 * `pg.types.getTypeParser(1114, 'text')` BEFORE registration (see
 * {@link createUtcDateParser}). It is what keeps `infinity` / `-infinity` on
 * the driver's `Infinity` / `-Infinity`: the earlier
 * `new Date(text.replace(' ', 'T') + 'Z')` form turned `'infinity'` into
 * `'infinityZ'` and so into an `Invalid Date` that flowed on silently.
 *
 * Component assembly rather than `Date` string parsing, for the same reason as
 * the `date` parser: a year outside four digits and a ` BC` suffix are not
 * parseable as ISO-8601 and would otherwise also become `Invalid Date`.
 * Fractional seconds are truncated to milliseconds, which is what
 * `Date`-string parsing did too.
 */
export function createUtcTimestampParser(fallback: (text: string) => unknown): (text: string) => unknown {
  const general = createUtcTimestampParserGeneral(fallback);
  return (text: string): unknown => scanIsoTemporal(text, SHAPE_TIMESTAMP) ?? general(text);
}

/**
 * The `timestamp` (OID 1114) parser WITHOUT the fast scan in front of it: the
 * regex implementation described by {@link createUtcTimestampParser}, and the
 * reference side of the differential test. Same reasoning as
 * {@link createUtcDateParserGeneral}.
 *
 * @internal
 */
export function createUtcTimestampParserGeneral(fallback: (text: string) => unknown): (text: string) => unknown {
  return (text: string): unknown => {
    const m = PG_TIMESTAMP_TEXT_RE.exec(text);
    if (!m) return fallback(text);
    const year = m[8] ? -(Number(m[1]) - 1) : Number(m[1]);
    const ms = m[7] ? Number(m[7].slice(0, 3).padEnd(3, '0')) : 0;
    const date = new Date(0);
    date.setUTCFullYear(year, Number(m[2]) - 1, Number(m[3]));
    date.setUTCHours(Number(m[4]), Number(m[5]), Number(m[6]), ms);
    return date;
  };
}

/**
 * Build the driver parser for Postgres `timestamptz` (OID 1184): the ISO wire
 * shape decoded by {@link scanIsoTemporal}, everything else handed straight to
 * `fallback`.
 *
 * UNLIKE the `date` and `timestamp` parsers beside it, this one changes NO
 * READING. A `timestamptz` arrives with an explicit offset, so its instant is
 * unambiguous and both this and `postgres-date` produce the same `Date`; the
 * only difference is how long it takes. That is also why it is not governed by
 * a semantic decision the way `utcTimestamps` governs the zone-less types: there
 * is no second interpretation to choose between.
 *
 * `fallback` must be captured with `pg.types.getTypeParser(1184, 'text')`
 * BEFORE registration, for the same reason as the parsers above: reading it
 * afterwards hands back this function and recurses forever. It is what keeps
 * `infinity` / `-infinity`, ` BC`, wide and low years, and every non-ISO
 * `DateStyle` on `postgres-date`, which already handles them.
 */
export function createFastTimestamptzParser(fallback: (text: string) => unknown): (text: string) => unknown {
  return (text: string): unknown => scanIsoTemporal(text, SHAPE_TIMESTAMPTZ) ?? fallback(text);
}

/**
 * The offset-less-timestamp-as-UTC reading, with no fallback: `text` must be a
 * plain `YYYY-MM-DD HH:MM:SS[.ffffff]`. Used where the input shape is already
 * known (tests, JSON-wire coercion); the DRIVER parser is
 * {@link createUtcTimestampParser}, which delegates everything else.
 */
export function parseUtcTimestampText(text: string): Date {
  return new Date(`${text.replace(' ', 'T')}Z`);
}
