/**
 * turbine-orm — Where-filter type guards and shape helpers
 *
 * Pure detection / fingerprint utilities used by the query builder's WHERE
 * compiler. Kept out of builder.ts so the class file stays about SQL assembly
 * and execution rather than filter-shape bookkeeping.
 */

import { ValidationError } from '../errors.js';
import type {
  ArrayFilter,
  JsonFilter,
  OrderBySpec,
  OrderDirection,
  TextSearchFilter,
  VectorFilter,
  VectorOrderBy,
  WhereOperator,
} from './types.js';
import { OPERATOR_KEYS } from './utils.js';

// ---------------------------------------------------------------------------
// Where-operator detection
// ---------------------------------------------------------------------------

/** Check if a value is a where operator object (has at least one known operator key) */
export function isWhereOperator(value: unknown): value is WhereOperator {
  if (
    value === null ||
    value === undefined ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value instanceof Date
  ) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((k) => OPERATOR_KEYS.has(k));
}

/**
 * True for a *plain object literal* that reached an equality fallthrough
 * without matching any known filter shape — the misspelled-operator case.
 * Class instances (Buffer for bytea, Decimal wrappers, ...) are legitimate
 * bind values and return false, as do arrays and Dates.
 */
export function isUnmatchedPlainObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || value instanceof Date) return false;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Fingerprint the SHAPE of a where-operator object. Null-valued `equals` /
 * `not` compile to parameterless `IS NULL` / `IS NOT NULL` (different SQL, no
 * param pushed), so null-ness is part of the shape — without it a cache entry
 * warmed by `{ not: 5 }` would serve `{ not: null }` with a desynced param list.
 */
export function fingerprintOperatorShape(value: WhereOperator): string {
  const obj = value as Record<string, unknown>;
  const opKeys = Object.keys(obj)
    .filter((k) => k !== 'mode')
    .map((k) => ((k === 'equals' || k === 'not') && obj[k] === null ? `${k}:null` : k))
    .sort();
  const modeStr = value.mode === 'insensitive' ? ':i' : '';
  return `op(${opKeys.join(',')}${modeStr})`;
}

/**
 * Guard for the value of an `equals` operator reaching the plain-equality
 * operator path. A plain object literal can only legitimately be an equality
 * value on a json/jsonb column — and those route to the JSONB filter branch
 * BEFORE the operator branch, so any plain object that reaches here is a
 * mistake (e.g. `{ equals: { foo: 1 } }` on a text column). Shared by the
 * SQL-build path and the cache-hit param-collect path so a warmed cache can
 * never skip the check.
 */
export function assertBindableEqualsOperand(value: unknown, column: string): void {
  if (!isUnmatchedPlainObject(value)) return;
  throw new ValidationError(
    `[turbine] Plain-object value for operator 'equals' on ${column}: ` +
      `objects are only valid 'equals' values on JSON (json/jsonb) columns, ` +
      `where 'equals' is the JSONB containment filter.`,
  );
}

/**
 * Object keys in sorted order, mirroring the canonical order used by every
 * cache fingerprint. The SQL-build and cache-hit param-collect paths MUST
 * enumerate object keys in this exact order: fingerprints sort keys, so two
 * where clauses with the same fields in different insertion order share one
 * cache entry — if build/collect iterated insertion order, the cached SQL's
 * `$N` placeholders would bind the wrong values (cross-tenant-leak class).
 * Array order (OR/AND members) is positional and is never sorted.
 */
export function sortedKeys(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).sort();
}

/** {@link sortedKeys}, but yielding `[key, value]` pairs. */
export function sortedEntries<V>(obj: Record<string, V>): [string, V][] {
  return Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Atomic-update / JSONB / Array / text-search / vector key sets
// ---------------------------------------------------------------------------

/** Known atomic-update operator keys — used to detect operator objects vs plain JSON values */
export const UPDATE_OPERATOR_KEYS = new Set<string>(['set', 'increment', 'decrement', 'multiply', 'divide']);

/** Known JSONB operator keys */
export const JSONB_OPERATOR_KEYS = new Set<string>(['path', 'equals', 'contains', 'hasKey']);

/**
 * JSON range comparison operators → SQL comparison tokens, in the FIXED order
 * the build and collect paths iterate them. These keys are deliberately NOT in
 * {@link JSONB_OPERATOR_KEYS}: `gt`/`gte`/`lt`/`lte` overlap with
 * `WhereOperator`, so a bare `{ gt: 5 }` must keep its column-comparison
 * meaning. They only compile as JSON range ops when the object is already a
 * {@link JsonFilter} (detected via `path` / `equals` / `contains` / `hasKey`),
 * and they always require `path`.
 */
export const JSON_RANGE_OPERATORS: Record<'gt' | 'gte' | 'lt' | 'lte', string> = {
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

/**
 * Value-invariant shape fingerprint for a {@link JsonFilter}. Range operators
 * are annotated with the comparison value's kind (`#n` numeric / `#s` string)
 * because a numeric comparison compiles to a `::numeric` cast — a different
 * SQL text than the text comparison — so the two must never share a cached
 * SQL entry.
 */
export function fingerprintJsonFilterShape(filter: JsonFilter): string {
  const obj = filter as Record<string, unknown>;
  const parts = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => (k in JSON_RANGE_OPERATORS ? `${k}#${typeof obj[k] === 'number' ? 'n' : 's'}` : k));
  return `json(${parts.join(',')})`;
}

/**
 * JSONB operator keys that are *unique* to {@link JsonFilter} — they cannot
 * appear in any other where-filter shape, so the presence of one of these is
 * an unambiguous signal that the user meant a JSON filter. Used by the
 * strict-validation path so that `{ contains: 'foo' }` (which is also a valid
 * `WhereOperator` for LIKE) is not misclassified. Note `equals` is NOT in this
 * set: on non-JSON columns it is a plain equality operator (`WhereOperator`),
 * so it must fall through instead of throwing.
 */
export const JSONB_UNIQUE_KEYS = new Set<string>(['path', 'hasKey']);

/** Check if a value is a JSONB filter object */
export function isJsonFilter(value: unknown): value is JsonFilter {
  if (
    value === null ||
    value === undefined ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value instanceof Date
  ) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length > 0 && keys.some((k) => JSONB_OPERATOR_KEYS.has(k));
}

/**
 * Returns the first JSON-unique key found in `value`, or `null` if none.
 * Used to drive the strict-validation error message.
 */
export function findJsonUniqueKey(value: object): string | null {
  for (const k of Object.keys(value)) {
    if (JSONB_UNIQUE_KEYS.has(k)) return k;
  }
  return null;
}

/** Known Array operator keys */
export const ARRAY_OPERATOR_KEYS = new Set<string>(['has', 'hasEvery', 'hasSome', 'isEmpty']);

/**
 * Array operator keys that are *unique* to {@link ArrayFilter}. None of the
 * array operators currently overlap with `WhereOperator` or `JsonFilter`, so
 * this set equals {@link ARRAY_OPERATOR_KEYS}; it is kept as a separate
 * constant so a future overlap (e.g. a `contains` for arrays) is easy to
 * carve out.
 */
export const ARRAY_UNIQUE_KEYS = new Set<string>(['has', 'hasEvery', 'hasSome', 'isEmpty']);

/** Check if a value is an Array filter object */
export function isArrayFilter(value: unknown): value is ArrayFilter {
  if (
    value === null ||
    value === undefined ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value instanceof Date
  ) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length > 0 && keys.some((k) => ARRAY_OPERATOR_KEYS.has(k));
}

/**
 * Returns the first array-unique key found in `value`, or `null` if none.
 * Used to drive the strict-validation error message.
 */
export function findArrayUniqueKey(value: object): string | null {
  for (const k of Object.keys(value)) {
    if (ARRAY_UNIQUE_KEYS.has(k)) return k;
  }
  return null;
}

/** Known text search operator keys */
export const TEXT_SEARCH_KEYS = new Set<string>(['search', 'config']);

/** Check if a value is a TextSearchFilter object */
export function isTextSearchFilter(value: unknown): value is TextSearchFilter {
  if (
    value === null ||
    value === undefined ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value instanceof Date
  ) {
    return false;
  }
  const keys = Object.keys(value);
  // Must have 'search' key and only known text search keys
  return keys.includes('search') && keys.every((k) => TEXT_SEARCH_KEYS.has(k));
}

/**
 * Validate a text search config name. Only alphanumeric characters and
 * underscores are allowed to prevent SQL injection via the config parameter.
 */
export function validateTextSearchConfig(config: string): boolean {
  return /^[a-zA-Z0-9_]+$/.test(config);
}

/**
 * pgvector distance metric → operator allow-list. This is the ONLY mapping
 * from a user-supplied metric token to a SQL operator; any token not present
 * here is rejected, so a user value can never become an arbitrary operator.
 *
 *  - `l2`     → `<->` (Euclidean / L2 distance)
 *  - `cosine` → `<=>` (cosine distance)
 *  - `ip`     → `<#>` (negative inner product)
 */
export const VECTOR_METRIC_OPERATORS: Record<string, string> = {
  l2: '<->',
  cosine: '<=>',
  ip: '<#>',
};

/** Comparison keys allowed on a {@link VectorDistanceFilter}. */
export const VECTOR_DISTANCE_COMPARATORS: Record<string, string> = {
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
};

/** Check if a value is a vector distance WHERE filter: `{ distance: { to, metric } }` */
export function isVectorFilter(value: unknown): value is VectorFilter {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof Date) {
    return false;
  }
  const dist = (value as { distance?: unknown }).distance;
  return (
    typeof dist === 'object' &&
    dist !== null &&
    !Array.isArray(dist) &&
    'to' in (dist as object) &&
    'metric' in (dist as object)
  );
}

/** Check if an orderBy value is a vector KNN ordering: `{ distance: { to, metric } }` */
export function isVectorOrderBy(value: unknown): value is VectorOrderBy {
  return isVectorFilter(value);
}

/** Check if an orderBy value is an explicit `{ sort, nulls? }` spec. */
export function isOrderBySpec(value: unknown): value is OrderBySpec {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'sort' in value;
}

/**
 * Normalize an orderBy value into `{ direction, nulls }`. Accepts a plain
 * direction string or an {@link OrderBySpec}. Used by every ORDER BY compile
 * path (findMany, groupBy, relation inner subqueries).
 */
export function normalizeOrderBy(value: OrderDirection | OrderBySpec): {
  dir: 'ASC' | 'DESC';
  nulls?: 'first' | 'last';
} {
  if (isOrderBySpec(value)) {
    return { dir: value.sort.toLowerCase() === 'desc' ? 'DESC' : 'ASC', nulls: value.nulls };
  }
  return { dir: String(value).toLowerCase() === 'desc' ? 'DESC' : 'ASC' };
}
