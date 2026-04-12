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
