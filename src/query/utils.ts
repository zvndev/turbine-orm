/**
 * turbine-orm, Query builder utilities
 *
 * Standalone utility functions and classes used by the query builder.
 */

import pg from 'pg';
import { camelToSnake, localDateTimeKind, timeOfDayKind } from '../schema.js';
import { shouldWarnOnce, WARN_NS } from './warn-registry.js';

// ---------------------------------------------------------------------------
// Identifier quoting, prevents SQL injection via table/column names
// ---------------------------------------------------------------------------

/**
 * Quote a SQL identifier (table name, column name) using Postgres double-quote
 * rules: wrap in double quotes, escape internal double quotes by doubling them.
 *
 * @example
 *   quoteIdent('users')       → '"users"'
 *   quoteIdent('my"table')    → '"my""table"'
 *   quoteIdent('user name')   → '"user name"'
 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Prototype-safe own-property read for the plain metadata maps (columnMap,
 * relations, reverseColumnMap). These are constructed as plain objects, so a
 * bare `map[key]` for a user-supplied field name like "constructor",
 * "toString", or "__proto__" returns an inherited member from
 * `Object.prototype`, a truthy value that slips past validation and produces a
 * cryptic `TypeError` instead of a clean `ValidationError`. Returns `undefined`
 * unless `key` is an OWN enumerable/non-enumerable property.
 */
export function ownLookup<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

/** The metadata a key needs to be resolved to a column. `TableMetadata` fits. */
export interface ColumnNameSource {
  columnMap: Record<string, string>;
  reverseColumnMap?: Record<string, string>;
  allColumns?: string[];
}

/**
 * Resolve a user-supplied key to its unquoted column name, or `undefined` when
 * the key names no column on the table.
 *
 * THE key-resolution rule, in one place. `QueryInterface.toColumn` is this
 * function plus the E003 throw, so every SQL builder resolves keys through it,
 * and the value-side passes (write coercion, the `updatedAt` injector, the
 * nested-write foreign-key merge) call it directly rather than re-deriving the
 * rule. They used to read `columnMap` alone, which knows only the FIELD
 * spelling, so a key spelled as the snake_case COLUMN, which the SQL builders
 * accept and which is the natural spelling on an introspected schema, produced
 * correct SQL with an unprocessed value: byte-identical statement, silently
 * different bound param.
 *
 * The rule: the field map first, else `camelToSnake(key)` accepted ONLY when
 * that name is a real column. `camelToSnake` is idempotent on an already-snake
 * string, which is what makes the column spelling legal; arbitrary strings
 * still fail to resolve, so identifier validation is unchanged.
 *
 * Prototype-safe: both maps are plain objects, so a key like "constructor" or
 * "__proto__" would otherwise return an inherited member and pass for a column
 * name (see {@link ownLookup}).
 */
export function resolveColumnName(meta: ColumnNameSource, key: string): string | undefined {
  const mapped = ownLookup(meta.columnMap, key);
  if (mapped) return mapped;
  const snake = camelToSnake(key);
  if (meta.reverseColumnMap && ownLookup(meta.reverseColumnMap, snake)) return snake;
  if (meta.allColumns?.includes(snake)) return snake;
  return undefined;
}

/**
 * Escape single quotes for use as string keys in json_build_object().
 * Doubles single quotes per SQL quoting rules.
 */
export function escSingleQuote(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * Escape LIKE pattern metacharacters: %, _, and \.
 * Must be used with `ESCAPE '\'` in the LIKE clause.
 */
export function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

// ---------------------------------------------------------------------------
// LRU cache, bounded SQL template cache to prevent memory leaks
// ---------------------------------------------------------------------------

/**
 * Simple LRU (Least Recently Used) cache with a fixed maximum size.
 * When the cache exceeds maxSize, the oldest (least recently used) entry is evicted.
 * Uses Map insertion order for O(1) eviction.
 */
export class LRUCache<K, V> {
  private cache = new Map<K, V>();
  constructor(private maxSize: number) {}

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Delete oldest (first) entry
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }

  get size() {
    return this.cache.size;
  }
}

// ---------------------------------------------------------------------------
// SQL cache entry + prepared statement name derivation
// ---------------------------------------------------------------------------

/** Cached SQL template paired with its prepared-statement name. */
export interface SqlCacheEntry {
  sql: string;
  name: string;
}

/**
 * FNV-1a 64-bit hash returning 16 lowercase hex chars.
 * Single-loop string iteration. Uses BigInt for 64-bit math.
 *
 * @internal Exported for testing only.
 */
export function fnv1a64Hex(s: string): string {
  // FNV-1a offset basis and prime for 64-bit
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn; // 64-bit mask

  for (let i = 0; i < s.length; i++) {
    hash ^= BigInt(s.charCodeAt(i));
    hash = (hash * prime) & mask;
  }

  return hash.toString(16).padStart(16, '0');
}

/**
 * Derive a prepared-statement name from a SQL string.
 * Format: `t_<16hex>`, always 18 chars, well under NAMEDATALEN (63).
 *
 * @internal Exported for testing only.
 */
export function sqlToPreparedName(sql: string): string {
  return `t_${fnv1a64Hex(sql)}`;
}

/** Known operator keys, used to detect operator objects vs plain values */
export const OPERATOR_KEYS = new Set<string>([
  'equals',
  'gt',
  'gte',
  'lt',
  'lte',
  'not',
  'in',
  'notIn',
  'contains',
  'startsWith',
  'endsWith',
  'mode',
]);

// ---------------------------------------------------------------------------
// Composite key correlation helper
// ---------------------------------------------------------------------------

/**
 * Build a correlation clause joining columns between two table references.
 * Handles both single-column (string) and multi-column (string[]) foreign keys.
 *
 * For single-column: `"alias"."col" = "parent"."col"`
 * For multi-column:  `"alias"."col_a" = "parent"."ref_a" AND "alias"."col_b" = "parent"."ref_b"`
 */
export function buildCorrelation(
  leftRef: string,
  leftColumns: string | string[],
  rightRef: string,
  rightColumns: string | string[],
): string {
  const leftCols = Array.isArray(leftColumns) ? leftColumns : [leftColumns];
  const rightCols = Array.isArray(rightColumns) ? rightColumns : [rightColumns];

  return leftCols
    .map((col, i) => `${leftRef}.${quoteIdent(col)} = ${rightRef}.${quoteIdent(rightCols[i]!)}`)
    .join(' AND ');
}

/**
 * Render a JS `Date` as a TIME-OF-DAY literal for a `time` / `timetz` column.
 *
 * Which time of day? The **UTC** components of the Date, never the process
 * local zone. That is what Prisma does (`new Date('1970-01-01T09:00:00Z')`
 * written to a `@db.Time(6)` column stores `09:00:00`), and the affected
 * consumers are porting from Prisma, so Prisma is the contract. It is also the
 * only choice that round-trips: the same Date produces the same literal no
 * matter where the process runs.
 *
 * `timetz` gets an explicit `+00:00`, because the value's zone IS UTC and
 * omitting it would let Postgres attach the session's `TimeZone` instead.
 * Fractional seconds are emitted only when non-zero, so an even-second Date
 * binds the plain `HH:MM:SS` form.
 */
export function toTimeOfDayLiteral(value: Date, kind: 'time' | 'timetz'): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const ms = value.getUTCMilliseconds();
  const literal =
    `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}` +
    (ms === 0 ? '' : `.${pad(ms, 3)}`);
  return kind === 'timetz' ? `${literal}+00:00` : literal;
}

/** The temporal column shapes that need a bound Date rewritten to a literal. */
export type TemporalBindKind = 'time' | 'timetz' | 'date' | 'timestamp';

/** Render the UTC calendar date of a `Date` as `YYYY-MM-DD`. */
function utcDatePart(value: Date): string {
  const year = value.getUTCFullYear();
  const y = year < 0 ? `-${String(-year).padStart(4, '0')}` : String(year).padStart(4, '0');
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${y}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
}

/**
 * Render a JS `Date` as a literal for a zone-less `date` / `timestamp` column,
 * using the value's **UTC** components.
 *
 * This is the write-side mirror of `parseDbDate`, which reads an offset-less
 * database value back as UTC. Without it the driver serializes the Date with
 * the PROCESS's offset (`prepareValue` → `dateToString`), so a `timestamp`
 * column is not round-trip stable outside a UTC process: writing
 * `2026-07-25T00:00Z` from `America/Los_Angeles` stores
 * `2026-07-24 17:00:00` and reads back as `2026-07-24T17:00Z`. It also matches
 * the choice {@link toTimeOfDayLiteral} already makes for `time` columns, and
 * Prisma, which writes UTC components to zone-less columns.
 *
 * `timestamptz` is NOT handled here (and must not be): it stores a real
 * instant, so the driver's local-offset string is already correct.
 */
export function toLocalDateTimeLiteral(value: Date, kind: 'date' | 'timestamp'): string {
  const datePart = utcDatePart(value);
  if (kind === 'date') return datePart;
  return `${datePart} ${toTimeOfDayLiteral(value, 'time')}`;
}

/**
 * Classify a column's database type for temporal bind rewriting.
 *
 * `utcDateTimes: false` restricts the classification to the time-of-day types,
 * whose rewrite is a hard-error fix (Postgres rejects an ISO timestamp for a
 * `time` column outright) rather than a value correction.
 */
export function temporalBindKind(dbType: string | undefined, utcDateTimes = true): TemporalBindKind | null {
  const timeKind = timeOfDayKind(dbType);
  if (timeKind) return timeKind;
  return utcDateTimes ? localDateTimeKind(dbType) : null;
}

/**
 * Rewrite one bound value for a temporal column: a JS `Date` on a `time` /
 * `timetz` / `date` / `timestamp` column becomes the corresponding UTC literal,
 * and an array of Dates on such a column is rewritten element-wise (the
 * per-element rewrite is what a `time[]` column needs, and matches the scalar
 * case rather than silently binding an ISO timestamp).
 *
 * Everything else, every non-Date, every non-temporal column, and every
 * `timestamptz` column, is returned by IDENTITY, so this is a byte-for-byte
 * no-op outside the shapes above.
 */
export function coerceTemporalValue(dbType: string | undefined, value: unknown, utcDateTimes = true): unknown {
  const isDate = value instanceof Date;
  if (!isDate && !Array.isArray(value)) return value;
  if (isDate && Number.isNaN(value.getTime())) return value;
  // An array value is either an `in`/`notIn` list on a scalar temporal column
  // (type already the element type) or the value of an array column, whose
  // introspected type is the `_time` / `_timestamp` array spelling.
  const kind = temporalBindKind(isDate ? dbType : arrayElementDbType(dbType), utcDateTimes);
  if (!kind) return value;
  if (isDate) return renderTemporal(value, kind);
  // Rewrite only if the list actually holds a Date, so a string list stays
  // byte-identical (and the same array instance is returned).
  if (!value.some((v) => v instanceof Date)) return value;
  return value.map((v) => (v instanceof Date && !Number.isNaN(v.getTime()) ? renderTemporal(v, kind) : v));
}

/** `_time` → `time`, `time[]` → `time`, anything else unchanged. */
function arrayElementDbType(dbType: string | undefined): string | undefined {
  if (!dbType) return dbType;
  if (dbType.startsWith('_')) return dbType.slice(1);
  return dbType.endsWith('[]') ? dbType.slice(0, -2) : dbType;
}

function renderTemporal(value: Date, kind: TemporalBindKind): string {
  return kind === 'date' || kind === 'timestamp'
    ? toLocalDateTimeLiteral(value, kind)
    : toTimeOfDayLiteral(value, kind);
}

/**
 * Matches an explicit timezone suffix on a date-time string: a trailing `Z`
 * or a `±HH`, `±HHMM`, `±HH:MM` offset.
 */
const TZ_SUFFIX_RE = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

/**
 * Parse a database date-time string deterministically.
 *
 * Postgres `timestamp` (without time zone) values arrive with no offset -
 * both from the driver and from `json_agg`/`json_build_object` subquery JSON
 * (`2026-07-07T17:15:41.896`). JavaScript's `new Date()` interprets such
 * strings in the SERVER'S LOCAL TIME ZONE, so the same row parses to a
 * different instant depending on where the code runs. The universal ORM
 * convention (Prisma, Rails, Django) is to treat offset-less timestamps as
 * UTC, that is also the only interpretation that round-trips: Postgres
 * stores exactly the wall-clock fields you sent.
 *
 * Strings that carry an explicit offset (`timestamptz` output) are parsed
 * as-is.
 */
export function parseDbDate(value: string): Date {
  // Date-only values (`2026-07-07`, from `date` columns in json_agg output)
  // have no time to zone-pin, and their `-07` tail must not be read as an
  // offset. JS parses bare ISO dates as UTC midnight already.
  if (!value.includes(':')) return new Date(value);
  if (TZ_SUFFIX_RE.test(value)) {
    // JS Date can't parse colon-less (`-0430`) or bare-hour (`+02`) offsets -
    // normalize both to `±HH:MM`. Postgres emits the bare-hour form for
    // whole-hour zones in some text outputs.
    return new Date(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2').replace(/([+-]\d{2})$/, '$1:00'));
  }
  // normalize `YYYY-MM-DD HH:MM:SS` (driver form) to ISO before pinning UTC
  return new Date(`${value.replace(' ', 'T')}Z`);
}

/**
 * Is `value` one of the two representations a Postgres temporal `infinity` /
 * `-infinity` reaches the ORM row parser in?
 *
 * TWO representations, because a temporal column is read two different ways
 * and they disagree on the wire:
 *
 *   driver          the pg text parser for `timestamp` / `date` does not
 *                   recognise the word, so it falls through to the driver's own
 *                   parser, which returns the JS NUMBERS `Infinity` /
 *                   `-Infinity`. This is what a top-level row, the batched and
 *                   flatten strategies, a write `RETURNING` projection and a
 *                   `groupBy` key all see.
 *   JSON wire       `json_build_object` renders the same value as the STRING
 *                   `"infinity"`, and scalar `timestamp` / `timestamptz` are
 *                   deliberately absent from {@link JSON_WIRE_COERCION_OIDS},
 *                   so no driver parser runs over it. This is what the `'join'`
 *                   strategy and the positional encoding see.
 *
 * Both are normalized in one place ({@link QueryInterface}'s row parser), to
 * whichever reading `temporalInfinity` selects (the JS number by default, or
 * `null`), so the same stored value cannot read differently depending on which
 * plan the query happened to take. The string form is only ever consulted for a column
 * the schema says is temporal, so a `text` column holding the word "infinity"
 * is untouched.
 *
 * Not dialect-gated. Postgres is the only engine with an infinite temporal
 * value, but the row parser is engine-shared and the alternative reading on the
 * other engines (a stray `'infinity'` string becoming an Invalid Date) is not
 * one worth preserving.
 */
export function isTemporalInfinity(value: unknown): boolean {
  if (typeof value === 'number') return value === Number.POSITIVE_INFINITY || value === Number.NEGATIVE_INFINITY;
  return value === 'infinity' || value === '-infinity';
}

// ---------------------------------------------------------------------------
// Driver type parsers for the zone-less temporal OIDs
// ---------------------------------------------------------------------------

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
 * The offset-less-timestamp-as-UTC reading, with no fallback: `text` must be a
 * plain `YYYY-MM-DD HH:MM:SS[.ffffff]`. Used where the input shape is already
 * known (tests, JSON-wire coercion); the DRIVER parser is
 * {@link createUtcTimestampParser}, which delegates everything else.
 */
export function parseUtcTimestampText(text: string): Date {
  return new Date(`${text.replace(' ', 'T')}Z`);
}

/**
 * The shape of `pg.types.arrayParser` at RUNTIME. The bundled `pg-types`
 * declaration file types it as a plain function, which it has not been for
 * years (it is the `postgres-array` module, `{ create(source, transform) }`),
 * so the cast below is a declaration fix, not a type escape.
 */
type PgArrayParserModule = {
  create(source: string, transform: (entry: string) => unknown): { parse(): unknown[] };
};

/**
 * Lift an element parser to the matching Postgres array OID.
 *
 * Array OIDs do NOT inherit their element type's parser: registering a parser
 * for `date` (1082) leaves `date[]` (1182) on the driver's default, so the same
 * value read from a scalar column and from an array column would disagree by
 * the process offset. Every scalar temporal parser Turbine registers is
 * therefore registered in its array form too.
 *
 * `pg.types.arrayParser` is a public member of the `pg` module (it is what the
 * driver's own `_text` / `_date` parsers are built from), so this adds no
 * dependency. NULL elements stay `null` and are never handed to `element`.
 */
export function createPgArrayParser(element: (text: string) => unknown): (text: string) => unknown[] {
  const arrayParser = pg.types.arrayParser as unknown as PgArrayParserModule;
  return (text: string): unknown[] =>
    arrayParser.create(text, (entry) => (entry === null || entry === undefined ? null : element(entry))).parse();
}

/**
 * A canonical wire value per OID, plus the JS value pg's OWN default text
 * parser produces from it, used to tell "still on the driver default" from
 * "somebody else already customized this OID" (see
 * {@link isDefaultTextParser}).
 *
 * The expected values are computed from LOCAL date components on purpose: pg's
 * default for the zone-less temporal OIDs builds its `Date` in the process's
 * zone (that is the reading `utcTimestamps` exists to replace), so the
 * expectation has to be computed the same way in whatever zone the process runs.
 */
const DEFAULT_PARSER_PROBES: Readonly<Record<number, { text: string; expected: () => unknown }>> = {
  20: { text: '9007199254740993', expected: () => '9007199254740993' },
  1082: { text: '2020-01-02', expected: () => new Date(2020, 0, 2) },
  1114: { text: '2020-01-02 03:04:05', expected: () => new Date(2020, 0, 2, 3, 4, 5) },
  1115: { text: '{"2020-01-02 03:04:05"}', expected: () => [new Date(2020, 0, 2, 3, 4, 5)] },
  1182: { text: '{2020-01-02}', expected: () => [new Date(2020, 0, 2)] },
};

/**
 * Marks a text parser as one TURBINE installed, so a later registration in the
 * same process (a client plus `turbine studio`, ESM plus CJS copies of this
 * module) does not report Turbine's own parser as "somebody else's". A
 * `Symbol.for` key, for the same cross-copy-identity reason the warn registry
 * uses one.
 */
const TURBINE_PARSER = Symbol.for('turbine.typeParser');

/** The OIDs the `utcTimestamps` flag governs, and so the ones it can opt out of. */
const TEMPORAL_PARSER_OIDS: ReadonlySet<number> = new Set([1114, 1082, 1115, 1182]);

/** Tag `parser` as Turbine's own and return it (see {@link TURBINE_PARSER}). */
export function markTurbineParser<F extends (text: string) => unknown>(parser: F): F {
  (parser as unknown as Record<symbol, unknown>)[TURBINE_PARSER] = true;
  return parser;
}

/** Comparable rendering of a parser result (Date by instant, array by element). */
function parserResultSignature(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (value instanceof Date) return `date:${value.getTime()}`;
  if (Array.isArray(value)) return `[${value.map(parserResultSignature).join(',')}]`;
  return `${typeof value}:${String(value)}`;
}

/**
 * Is the parser currently registered for `oid` still pg's own default?
 *
 * DETECTED BY BEHAVIOUR, NOT BY IDENTITY, and deliberately so. `pg-types` keeps
 * its default parser table private: `getTypeParser` hands back whatever is
 * registered NOW, and there is no exported way to ask what the default WAS, so
 * a function-identity comparison would need a deep import of a file the package
 * does not publish as an entry point. Instead this runs the registered parser
 * over a canonical wire value and compares the result with what pg's default
 * produces for it.
 *
 * What that buys and what it costs, stated honestly:
 *   - Every parser that behaves OBSERVABLY differently on the probe value is
 *     detected, which is the case worth warning about (someone else's reading
 *     is about to be replaced by Turbine's).
 *   - A replacement that is observably EQUIVALENT on the probe is reported as
 *     the default and draws no warning. That is a false negative, and an
 *     acceptable one: if it agrees with the default here it is not a reading
 *     anybody would notice Turbine overwriting.
 *   - A parser that THROWS on the probe is reported as non-default; pg's own
 *     never throws on a valid value of its type.
 *   - An OID with no probe entry is reported as default (never warn on a guess).
 *
 * The registered parser is invoked once, on a synthetic value, at client
 * construction. A decode parser with side effects would be surprising, and pg's
 * own have none.
 */
export function isDefaultTextParser(oid: number, parser: (text: string) => unknown): boolean {
  const probe = DEFAULT_PARSER_PROBES[oid];
  if (!probe) return true;
  try {
    return parserResultSignature(parser(probe.text)) === parserResultSignature(probe.expected());
  } catch {
    return false;
  }
}

/**
 * Warn ONCE per OID when Turbine is about to replace a text parser that is not
 * pg's default, i.e. when some other module in the process has already
 * customized it.
 *
 * `pg.types.setTypeParser` is process-global and retroactive: it changes how
 * every `pg.Pool` in the process decodes that OID, including pools that were
 * constructed and were already querying before the Turbine client existed. When
 * the OID was still on pg's default that is the documented, intended trade (the
 * whole point of `utcTimestamps`). When somebody else had already installed
 * their own reading, Turbine is silently rewriting an expectation it cannot see
 * the origin of, and the resulting bug is order-dependent: which reading wins
 * depends on module evaluation order, which lazy route imports make unstable
 * between requests. So say it out loud, once.
 *
 * NOT DEV-ONLY. It used to go quiet under `NODE_ENV=production`, along with
 * every other dev warning, and that was the wrong rule for THIS one, for the
 * same reason the temporal-infinity warning (builder.ts `warnTemporalInfinity`)
 * is not dev-only either. A parser overwrite is ORDER-DEPENDENT: which module
 * calls `setTypeParser` last decides the reading, and evaluation order is
 * exactly what differs between a dev process (eager imports, one route
 * exercised at a time) and a production one (bundled or lazily imported routes,
 * warmed in whatever order traffic arrives). So a process can be clean in dev
 * and wrong in production purely from import order, which makes production the
 * case that matters MOST, and it was the case that was silent. The cost is
 * bounded to the point of irrelevance: once per OID per process, at client
 * construction, and only when somebody else's non-default parser is actually
 * being replaced.
 */
export function warnParserOverwrite(oid: number, typeName: string): void {
  const getParser = pg.types.getTypeParser as unknown as (oid: number, format: 'text') => (value: string) => unknown;
  const current = getParser(oid, 'text');
  // Turbine's own earlier registration is not a third party's expectation.
  if ((current as unknown as Record<symbol, unknown>)[TURBINE_PARSER]) return;
  if (isDefaultTextParser(oid, current)) return;
  if (!shouldWarnOnce(WARN_NS.parserOverwrite, String(oid))) return;
  // The `utcTimestamps: false` opt-out only governs the four TEMPORAL OIDs.
  // Offering it as the remedy for int8 (20) would name a setting that does
  // nothing for the OID being warned about; that registration has no opt-out.
  const remedy = TEMPORAL_PARSER_OIDS.has(oid)
    ? ' `utcTimestamps: false` leaves the four temporal OIDs (1114, 1082, 1115, 1182) alone entirely.'
    : ' There is no opt-out for this OID: Turbine registers it so bigint values come back as numbers.';
  console.warn(
    `[turbine] pg type parser for OID ${oid} (${typeName}) was already customized by something else in this ` +
      'process, and Turbine is replacing it. `pg.types.setTypeParser` is process-global and takes effect ' +
      'immediately for EVERY pg.Pool in the process, including pools that already exist and are already ' +
      'querying, so whatever set that parser will now read this column differently. If yours should win, ' +
      `register it AFTER constructing the client.${remedy} This warning fires under \`NODE_ENV=production\` ` +
      'too: which parser wins depends on module evaluation order, so a process can be clean in dev and wrong ' +
      'in production from import order alone.',
  );
}

/**
 * Register the UTC readings of the four zone-less temporal OIDs on the pg
 * module: `timestamp` (1114), `date` (1082) and their array forms (1115, 1182).
 *
 * ONE place, because `pg.types.setTypeParser` is process-global and the pairing
 * matters: registering a scalar without its array form, or a `date` without the
 * `timestamp` beside it, produces two columns of the same row disagreeing about
 * what the same wire text means. Both callers are processes Turbine owns the
 * pg module in: `TurbineClient` on a pool it created (never on an external
 * pool, whose parser configuration belongs to the caller), and `turbine studio`,
 * which builds a raw pool of its own and must render what the application sees.
 *
 * Each fallback is read BEFORE its parser is installed, so an unrecognised wire
 * value (`infinity`, and whatever a future server adds) still reaches the
 * driver's own parser.
 *
 * Registration is RETROACTIVE for the whole process, pools included that were
 * created and are already querying (there is one parser table, and it is read
 * per row at decode time, not captured per pool). If any of the four OIDs is
 * already on a NON-default parser, {@link warnParserOverwrite} says so once.
 */
export function registerUtcTemporalParsers(): void {
  // pg-types declares get/setTypeParser over its own OID enum, which lists the
  // scalar types only. The array OIDs are just as real, so both calls are
  // retyped over a plain number rather than the incomplete enum.
  const getParser = pg.types.getTypeParser as unknown as (oid: number, format: 'text') => (value: string) => unknown;
  const setParser = pg.types.setTypeParser as unknown as (oid: number, parse: (value: string) => unknown) => void;
  warnParserOverwrite(1114, 'timestamp');
  warnParserOverwrite(1082, 'date');
  warnParserOverwrite(1115, 'timestamp[]');
  warnParserOverwrite(1182, 'date[]');
  const parseDate = createUtcDateParser(getParser(1082, 'text'));
  const parseTimestamp = createUtcTimestampParser(getParser(1114, 'text'));
  setParser(1114, markTurbineParser(parseTimestamp));
  setParser(1082, markTurbineParser(parseDate));
  // Array OIDs do not inherit their element parser, so `date[]` / `timestamp[]`
  // would otherwise keep returning local-zone Dates while the scalar columns
  // beside them returned UTC ones.
  setParser(1182, markTurbineParser(createPgArrayParser(parseDate)));
  setParser(1115, markTurbineParser(createPgArrayParser(parseTimestamp)));
}

// ---------------------------------------------------------------------------
// JSON-wire value coercion (relationLoadStrategy: 'join')
// ---------------------------------------------------------------------------

/**
 * Postgres type name → OID, for every type family whose `json_build_object`
 * rendering is NOT the value the pg driver produces for the same column.
 *
 * Why this table exists: the `'join'` strategy reads a relation through
 * `json_agg(json_build_object(...))`, so its values are whatever
 * `JSON.parse` makes of Postgres's JSON rendering. Every other read path in
 * the library, a top-level row, `'batched'`, `'flatten'`, reads the column
 * through the driver and gets the driver's representation. Measured against
 * PostgreSQL 17, those two disagree for exactly the families below, which
 * made the SAME query return a different JS type depending on which plan ran
 * (and `'auto'` picks the plan from a row-count heuristic, so it could differ
 * between two runs of one query). Three of these are lossy, not merely
 * different:
 *
 *   type         driver (target)              json_build_object
 *   ──────────── ──────────────────────────── ─────────────────────────────
 *   numeric      '1000.50'   (string)         1000.5    (number, LOSSY)
 *   int8         '9007199254740993'           9007199254740992 (LOSSY)
 *   bytea        Buffer                       '\xdeadbeef' (string)
 *   date         Date (UTC midnight)          Date (UTC midnight, by coincidence)
 *   interval     { days, hours, … }           '1 day 02:03:04' (string)
 *   point        { x, y }                     '(1,2)'   (string)
 *   circle       { x, y, radius }             '<(1,2),3>' (string)
 *
 * The array forms diverge the same way, plus `_timestamp`/`_timestamptz`
 * (driver: `Date[]`; JSON: `string[]`), the scalar `timestamp` /
 * `timestamptz` are deliberately ABSENT because the existing `dateColumns`
 * coercion in `parseRow` already lands them on the driver's value, and they
 * are the hottest column type in a typical schema (no reason to add a cast to
 * every `created_at`).
 *
 * The fix these OIDs drive: emit the column as `col::text` inside
 * `json_build_object` so the JSON carries the same wire text the driver would
 * receive, then run the DRIVER'S OWN parser for that OID over it. Parity is
 * then by construction rather than by coincidence, and it automatically
 * honours a caller's `pg.types.setTypeParser` (including the int8 parser
 * TurbineClient itself registers) instead of second-guessing it.
 *
 * Postgres-only: the JSON functions and the divergence set are both
 * engine-specific, so callers gate this on the postgres dialect.
 */
export const JSON_WIRE_COERCION_OIDS: Readonly<Record<string, number>> = {
  numeric: 1700,
  int8: 20,
  bytea: 17,
  date: 1082,
  interval: 1186,
  point: 600,
  circle: 718,
  _numeric: 1231,
  _int8: 1016,
  _bytea: 1001,
  _date: 1182,
  _interval: 1187,
  _point: 1017,
  _timestamp: 1115,
  _timestamptz: 1185,
};

/**
 * The OID whose driver parser reproduces `pgType`'s driver representation from
 * its text rendering, or `undefined` when the type's JSON rendering already
 * matches the driver (the common case: text, uuid, bool, int4, float8, json,
 * jsonb, arrays of those, …).
 */
export function jsonWireCoercionOid(pgType: string | undefined): number | undefined {
  if (!pgType) return undefined;
  return JSON_WIRE_COERCION_OIDS[pgType];
}

/**
 * Apply the driver's text parser for `oid` to a JSON-sourced wire string.
 *
 * Resolved through `pg.types.getTypeParser` on every call rather than
 * memoized: parser registration is process-global and happens in the
 * TurbineClient constructor (int8, and `timestamp` under `utcTimestamps`), and
 * a caller may register their own at any point. A stale memo would silently
 * reintroduce the very divergence this exists to remove. The lookup is a plain
 * object index in pg-types, so it is not worth caching.
 */
export function coerceJsonWireValue(oid: number, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return pg.types.getTypeParser(oid, 'text')(value);
}

// ---------------------------------------------------------------------------
// Unknown-field diagnostics
// ---------------------------------------------------------------------------

/**
 * Case-insensitive closeness of `candidate` to `input`, higher is better,
 * 0 meaning "not worth suggesting". Deliberately tiny: this runs only on the
 * error path, and its whole job is to turn a guessed name into the real one.
 *
 * Substring containment is scored ABOVE edit distance because the real-world
 * miss is a longer, more descriptive guess than the actual name (`modelVersions`
 * for a relation turbine derived as `versions`), where the edit distance is
 * large but the containment is exact.
 */
function nameCloseness(input: string, candidate: string): number {
  const a = input.toLowerCase();
  const b = candidate.toLowerCase();
  if (a === b) return 1000;
  if (a.includes(b) || b.includes(a)) return 500 + Math.min(a.length, b.length);
  // Levenshtein, bounded: only near-misses are worth suggesting.
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i < rows; i++) {
    const cur = [i];
    for (let j = 1; j < cols; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  const distance = prev[cols - 1]!;
  const limit = Math.max(2, Math.floor(Math.max(a.length, b.length) / 3));
  return distance <= limit ? 100 - distance : 0;
}

/** The closest name in `candidates` to `input`, or null when none is close. */
export function closestName(input: string, candidates: Iterable<string>): string | null {
  let best: string | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const score = nameCloseness(input, c);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

/** camelCase name → its lowercased words (`logQueryParams` → log, query, params). */
function camelWords(name: string): string[] {
  return name
    .split(/(?=[A-Z])/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

/**
 * The real option key `key` most likely meant, or null when nothing is close.
 *
 * Shared by every "unknown option" diagnostic (the client-config warner in
 * client.ts and the prisma-compat query-option warner), so a reader who has
 * seen one recognizes the ranking in the other.
 *
 * {@link closestName} decides first, which is bounded by edit distance and
 * covers typos. It does not cover the miss these warnings exist for: a guessed
 * name that omits a whole WORD. `logParams` is five edits from `logQueryParams`,
 * past the bound, yet it names the same words in the same order; likewise
 * `customPlan` for `forceCustomPlan`. So a second pass accepts a candidate whose
 * camelCase words CONTAIN the guess's words in order, preferring the one that
 * adds fewest words.
 */
export function suggestKey(key: string, candidates: Iterable<string>): string | null {
  const direct = closestName(key, candidates);
  if (direct) return direct;
  const wanted = camelWords(key);
  if (wanted.length < 2) return null;
  let best: string | null = null;
  let bestExtra = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const words = camelWords(candidate);
    if (words.length <= wanted.length) continue;
    let i = 0;
    for (const w of words) if (w === wanted[i]) i++;
    if (i !== wanted.length) continue;
    const extra = words.length - wanted.length;
    if (extra < bestExtra) {
      bestExtra = extra;
      best = candidate;
    }
  }
  return best;
}

/**
 * The "unknown field" error text, listing RELATIONS as well as columns.
 *
 * The message used to read `Known fields: id, name.` and nothing else. That is
 * actively misleading when the key was a relation name: relation filters ARE
 * valid in a `where`, so a user who guessed the wrong relation name concluded
 * from this message that turbine cannot filter by relations at all. Relation
 * names are frequently guessed wrong because introspection derives them, and
 * two foreign keys to one table produce names (`msgsBySender`) that no one
 * would predict.
 */
export function unknownFieldMessage(
  table: string,
  field: string,
  meta: { columnMap: Record<string, string>; relations?: Record<string, unknown> },
): string {
  const columns = Object.keys(meta.columnMap);
  const relations = Object.keys(meta.relations ?? {});
  const suggestion = closestName(field, [...columns, ...relations]);
  const didYouMean = suggestion
    ? ` Did you mean "${suggestion}"${relations.includes(suggestion) ? ' (a relation)' : ''}?`
    : '';
  return (
    `[turbine] Unknown field "${field}" on table "${table}".${didYouMean}` +
    ` Known columns: ${columns.join(', ') || '(none)'}.` +
    (relations.length ? ` Known relations (valid in \`where\` and \`with\`): ${relations.join(', ')}.` : '')
  );
}
