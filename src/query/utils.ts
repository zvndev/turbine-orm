/**
 * turbine-orm, Query builder utilities
 *
 * Standalone utility functions and classes used by the query builder.
 */

import pg from 'pg';
import { localDateTimeKind, timeOfDayKind } from '../schema.js';

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
 *   date         Date (local midnight)        Date (UTC midnight, off by tz)
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
