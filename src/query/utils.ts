/**
 * turbine-orm — Query builder utilities
 *
 * Standalone utility functions and classes used by the query builder.
 */

// ---------------------------------------------------------------------------
// Identifier quoting — prevents SQL injection via table/column names
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
 * `Object.prototype` — a truthy value that slips past validation and produces a
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
// LRU cache — bounded SQL template cache to prevent memory leaks
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
 * Format: `t_<16hex>` — always 18 chars, well under NAMEDATALEN (63).
 *
 * @internal Exported for testing only.
 */
export function sqlToPreparedName(sql: string): string {
  return `t_${fnv1a64Hex(sql)}`;
}

/** Known operator keys — used to detect operator objects vs plain values */
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
 * Matches an explicit timezone suffix on a date-time string: a trailing `Z`
 * or a `±HH`, `±HHMM`, `±HH:MM` offset.
 */
const TZ_SUFFIX_RE = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

/**
 * Parse a database date-time string deterministically.
 *
 * Postgres `timestamp` (without time zone) values arrive with no offset —
 * both from the driver and from `json_agg`/`json_build_object` subquery JSON
 * (`2026-07-07T17:15:41.896`). JavaScript's `new Date()` interprets such
 * strings in the SERVER'S LOCAL TIME ZONE, so the same row parses to a
 * different instant depending on where the code runs. The universal ORM
 * convention (Prisma, Rails, Django) is to treat offset-less timestamps as
 * UTC — that is also the only interpretation that round-trips: Postgres
 * stores exactly the wall-clock fields you sent.
 *
 * Strings that carry an explicit offset (`timestamptz` output) are parsed
 * as-is.
 */
export function parseDbDate(value: string): Date {
  // Date-only values (`2026-07-07`, from `date` columns in json_agg output)
  // have no time to zone-pin — and their `-07` tail must not be read as an
  // offset. JS parses bare ISO dates as UTC midnight already.
  if (!value.includes(':')) return new Date(value);
  if (TZ_SUFFIX_RE.test(value)) {
    // JS Date can't parse colon-less (`-0430`) or bare-hour (`+02`) offsets —
    // normalize both to `±HH:MM`. Postgres emits the bare-hour form for
    // whole-hour zones in some text outputs.
    return new Date(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2').replace(/([+-]\d{2})$/, '$1:00'));
  }
  // normalize `YYYY-MM-DD HH:MM:SS` (driver form) to ISO before pinning UTC
  return new Date(`${value.replace(' ', 'T')}Z`);
}
