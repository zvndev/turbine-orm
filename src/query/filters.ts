/**
 * turbine-orm, Where-filter type guards and shape helpers
 *
 * Pure detection / fingerprint utilities used by the query builder's WHERE
 * compiler. Kept out of builder.ts so the class file stays about SQL assembly
 * and execution rather than filter-shape bookkeeping.
 */

import { ValidationError } from '../errors.js';
import type {
  ArrayFilter,
  ColumnRef,
  JsonFilter,
  JsonPathOrderBy,
  OrderBySpec,
  OrderDirection,
  RelationPickOrderBy,
  TextSearchFilter,
  VectorFilter,
  VectorOrderBy,
  WhereOperator,
} from './types.js';
import { assertDirectionToken, assertOrderDirection } from './types.js';
import { type ColumnNameSource, OPERATOR_KEYS, resolveColumnName } from './utils.js';

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
 * without matching any known filter shape, the misspelled-operator case.
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
 * Operator keys that accept a {@link ColumnRef} (`{ col: 'otherField' }`)
 * value for column-to-column comparison. `in`/`notIn` and the LIKE operators
 * take values only.
 */
export const COLUMN_REF_OPERATORS = new Set<string>(['equals', 'not', 'gt', 'gte', 'lt', 'lte']);

/**
 * THE relation-filter wrappers: the keys whose body is a clause against the
 * relation's TARGET table rather than against this one.
 *
 * One named list, here, because everything that walks a where clause has to
 * agree about them and the copies had already spread. It lived inlined in
 * `where-compile.ts` (`'some' in x || 'every' in x || …`, the SQL compiler's
 * own answer), again in `normalizeRelationFilter` (where.ts) as the negated
 * conjunction of the same five, again in `cli/pii-predicate-guard.ts`, and a
 * fourth time in `prisma-compat.ts` SPLIT across a
 * `RELATION_QUANTIFIERS` set (`some`/`every`/`none`) plus two inline
 * `k === 'is' || k === 'isNot'` tests, which is the copy most likely to drift
 * because half of it does not read as a list and a grep for the list does not
 * find it.
 *
 * The failure mode is not cosmetic: a wrapper the SQL compiler treats as a
 * relation filter but a WALKER does not is a wrapper whose body reaches the
 * builder unwalked. That is precisely the operand-position channel this
 * release closed elsewhere.
 *
 * `query/` is the right home rather than `cli/` because the direction of the
 * dependency is fixed: `cli/` and the prisma-compat shim may import from the
 * query path, and the query path may never import from `cli/`
 * (`scripts/check-import-cycles.mjs`).
 */
export const RELATION_FILTER_WRAPPERS = ['some', 'none', 'every', 'is', 'isNot'] as const;

/** {@link RELATION_FILTER_WRAPPERS} as a membership set, for the walkers. */
export const RELATION_FILTER_WRAPPER_SET: ReadonlySet<string> = new Set<string>(RELATION_FILTER_WRAPPERS);

/**
 * True when a normalized relation-filter body carries at least one cardinality
 * wrapper. THE predicate the SQL compiler branches on: a key that names a
 * relation but whose value is not one of these falls through to the scalar
 * path.
 */
export function hasRelationFilterWrapper(filterObj: Record<string, unknown>): boolean {
  for (const wrapper of RELATION_FILTER_WRAPPERS) {
    if (wrapper in filterObj) return true;
  }
  return false;
}

/**
 * Check if an operator value is a column reference: a plain object whose ONLY
 * key is `col` with a string value. Anything else (extra keys, non-string
 * `col`) is treated as a plain value so JSON payloads that merely contain a
 * `col` property keep their equality meaning.
 */
export function isColumnRef(value: unknown): value is ColumnRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || value instanceof Date) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === 'col' && typeof (value as { col?: unknown }).col === 'string';
}

/**
 * Fingerprint the SHAPE of a where-operator object. Null-valued `equals` /
 * `not` compile to parameterless `IS NULL` / `IS NOT NULL` (different SQL, no
 * param pushed), so null-ness is part of the shape, without it a cache entry
 * warmed by `{ not: 5 }` would serve `{ not: null }` with a desynced param list.
 *
 * Column references ({@link ColumnRef}) compile the referenced column into the
 * SQL TEXT (no param bound), so the referenced field name is part of the shape
 *: `{ equals: { col: 'a' } }` and `{ equals: { col: 'b' } }` must never share
 * a cache entry. The name is JSON-encoded so exotic field names cannot collide
 * with other fingerprint tokens.
 */
export function fingerprintOperatorShape(value: WhereOperator): string {
  const obj = value as Record<string, unknown>;
  const opKeys = Object.keys(obj)
    .filter((k) => k !== 'mode')
    .map((k) => {
      const v = obj[k];
      if ((k === 'equals' || k === 'not') && v === null) return `${k}:null`;
      if (COLUMN_REF_OPERATORS.has(k) && isColumnRef(v)) return `${k}:col(${JSON.stringify(v.col)})`;
      return k;
    })
    .sort();
  const modeStr = value.mode === 'insensitive' ? ':i' : '';
  return `op(${opKeys.join(',')}${modeStr})`;
}

/**
 * Guard for the value of an `equals` operator reaching the plain-equality
 * operator path. A plain object literal can only legitimately be an equality
 * value on a json/jsonb column, and those route to the JSONB filter branch
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
 * cache entry, if build/collect iterated insertion order, the cached SQL's
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

/** Known atomic-update operator keys, used to detect operator objects vs plain JSON values */
export const UPDATE_OPERATOR_KEYS = new Set<string>(['set', 'increment', 'decrement', 'multiply', 'divide']);

/**
 * Known JSONB operator keys. `stringContains` / `stringStartsWith` /
 * `stringEndsWith` are appended below, once {@link JSON_STRING_OPERATORS} is
 * declared: they have no `WhereOperator` counterpart, so their presence is an
 * unambiguous JSON-filter signal.
 */
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
 * JSON substring operators → the LIKE pattern each one builds around its
 * escaped operand, in the FIXED order the build and collect paths iterate
 * them. These compare the TEXT at `path` (which every one of them requires),
 * so they are the JSON counterpart of the scalar `contains` / `startsWith` /
 * `endsWith` operators rather than of jsonb containment.
 *
 * They are deliberately NOT named `contains` / `startsWith` / `endsWith`:
 * `contains` on a JSON column already means whole-document containment
 * (`@>`), and silently changing that would break every existing caller.
 */
export const JSON_STRING_OPERATORS: Record<
  'stringContains' | 'stringStartsWith' | 'stringEndsWith',
  (escaped: string) => string
> = {
  stringContains: (escaped) => `%${escaped}%`,
  stringStartsWith: (escaped) => `${escaped}%`,
  stringEndsWith: (escaped) => `%${escaped}`,
};

/**
 * Every key a {@link JsonFilter} may carry. Used by the strict-key check so an
 * unrecognized operator is REFUSED rather than dropped.
 *
 * This existed as tribal knowledge spread across `buildJsonFilterClauses` and
 * `collectJsonFilterParams`: each simply ignored what it did not recognize, so
 * `{ path: ['title'], string_contains: 'x' }` (the Prisma spelling) compiled to
 * no predicate at all and returned every row of the table. The scalar operator
 * path has always thrown on an unknown key; this set is what lets the JSON path
 * behave the same way.
 */
for (const k of Object.keys(JSON_STRING_OPERATORS)) JSONB_OPERATOR_KEYS.add(k);

export const JSON_FILTER_KEYS: ReadonlySet<string> = new Set<string>([
  'path',
  'equals',
  'contains',
  'hasKey',
  'mode',
  ...Object.keys(JSON_RANGE_OPERATORS),
  ...Object.keys(JSON_STRING_OPERATORS),
]);

/**
 * Value-invariant shape fingerprint for a {@link JsonFilter}. Range operators
 * are annotated with the comparison value's kind (`#n` numeric / `#s` string)
 * because a numeric comparison compiles to a `::numeric` cast, a different
 * SQL text than the text comparison, so the two must never share a cached
 * SQL entry. `mode` is part of the shape for the same reason: it selects
 * between `LIKE` and the dialect's case-insensitive form, which is different
 * SQL text.
 */
export function fingerprintJsonFilterShape(filter: JsonFilter): string {
  const obj = filter as Record<string, unknown>;
  const parts = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => {
      if (k in JSON_RANGE_OPERATORS) return `${k}#${typeof obj[k] === 'number' ? 'n' : 's'}`;
      // `mode` carries its VALUE, not just its presence: 'insensitive' and any
      // other spelling select different SQL, so they must not share an entry.
      if (k === 'mode') return `mode#${String(obj[k])}`;
      return k;
    });
  return `json(${parts.join(',')})`;
}

/**
 * JSONB operator keys that are *unique* to {@link JsonFilter}, they cannot
 * appear in any other where-filter shape, so the presence of one of these is
 * an unambiguous signal that the user meant a JSON filter. Used by the
 * strict-validation path so that `{ contains: 'foo' }` (which is also a valid
 * `WhereOperator` for LIKE) is not misclassified. Note `equals` is NOT in this
 * set: on non-JSON columns it is a plain equality operator (`WhereOperator`),
 * so it must fall through instead of throwing.
 */
export const JSONB_UNIQUE_KEYS = new Set<string>(['path', 'hasKey', ...Object.keys(JSON_STRING_OPERATORS)]);

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

/**
 * Value-invariant shape fingerprint for an {@link ArrayFilter} (the INNER part,
 * without the `arr(...)` wrapper the where fingerprint adds). The boolean
 * `isEmpty` operator changes the SQL shape (`= '{}'` vs `<> '{}'`), so its
 * concrete value is part of the shape; the other operators are value-invariant.
 */
export function fingerprintArrayFilterShape(filter: ArrayFilter): string {
  const keys = Object.keys(filter).sort();
  const suffix = filter.isEmpty === undefined ? '' : `:empty=${filter.isEmpty ? 'true' : 'false'}`;
  return `${keys.join(',')}${suffix}`;
}

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
 * Check if an orderBy value is a JSON-path ordering: `{ path: [...] }` with an
 * ARRAY path. The array requirement disambiguates from relation orderBy values
 * (whose entries are directions/specs keyed by target column: a target column
 * literally named `path` maps to a string direction, never an array), and the
 * `distance`/`sort` exclusions keep vector and spec shapes out.
 */
export function isJsonPathOrderBy(value: unknown): value is JsonPathOrderBy {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if ('distance' in value || 'sort' in value) return false;
  return Array.isArray((value as { path?: unknown }).path);
}

/**
 * Check if an orderBy value is a pick-row relation ordering:
 * `{ pick: { orderBy, ... }, by, direction?, nulls?, plan? }`. The full shape
 * is required (`pick` must be an object carrying `orderBy`, `by` must be
 * present, and no keys outside `{ pick, by, direction, nulls, plan }`), so a to-one
 * relation whose target has real columns literally named `pick` and `by`
 * (whose values are direction strings or `{ sort, nulls }` specs, never an
 * object with `orderBy`) still falls through to column ordering. `distance`
 * (vector), `sort` (OrderBySpec), and a top-level array `path` (JSON-path
 * ordering) are excluded up front.
 */
export function isRelationPickOrderBy(value: unknown): value is RelationPickOrderBy {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if ('distance' in value || 'sort' in value || Array.isArray((value as { path?: unknown }).path)) return false;
  const v = value as Record<string, unknown>;
  if (!('pick' in v) || !('by' in v)) return false;
  if (typeof v.pick !== 'object' || v.pick === null || Array.isArray(v.pick) || !('orderBy' in v.pick)) return false;
  for (const key of Object.keys(v)) {
    if (key !== 'pick' && key !== 'by' && key !== 'direction' && key !== 'nulls' && key !== 'plan') return false;
  }
  return true;
}

/**
 * Flatten an orderBy input into an ordered list of `[field, value]` entries.
 *
 * Accepts BOTH the classic single-object form (`{ a: 'asc', b: 'desc' }`,
 * whose insertion order is authoritative) and the Prisma-style array form
 * (`[{ a: 'asc' }, { b: 'desc' }]`, whose array order is authoritative). The
 * array form removes the reliance on JS object key iteration order for
 * multi-key sorts. Each array element may carry one or more keys; they expand
 * left-to-right. `undefined`/non-object elements are skipped.
 *
 * Undefined-VALUED entries are preserved (mirroring `Object.entries`) so each
 * consumer keeps its own `dir !== undefined` filtering exactly as before. This
 * is THE single flattening authority: every ORDER BY compile / collect /
 * fingerprint path routes through it so the array and object forms stay in
 * lockstep across build, param-collect, and cache-key fingerprint.
 */
export function orderByEntries(orderBy: unknown): [string, unknown][] {
  if (Array.isArray(orderBy)) {
    const entries: [string, unknown][] = [];
    for (const element of orderBy) {
      if (element !== null && typeof element === 'object' && !Array.isArray(element)) {
        for (const kv of Object.entries(element as Record<string, unknown>)) entries.push(kv);
      }
    }
    return entries;
  }
  if (orderBy !== null && typeof orderBy === 'object') {
    return Object.entries(orderBy as Record<string, unknown>);
  }
  return [];
}

// ---------------------------------------------------------------------------
// ORDER BY key identity and arity
// ---------------------------------------------------------------------------

/**
 * The longest `orderBy` whose statement keeps a NAMED prepared statement.
 * Past this, the compile paths call `markVariableArity` and the statement is
 * sent unnamed for the same reason a caller-written `OR` array is.
 *
 * WHY 3, and why a threshold at all. Refusing duplicate sort keys
 * ({@link dedupeOrderEntries}) bounds an `orderBy` to the table's column
 * count, which sounds like enough and is not: what is left is the PERMUTATION
 * space. A 20-column table admits 20 one-key sorts, 380 two-key sorts, 6,840
 * three-key sorts and 116,280 four-key sorts, and every one of those is a
 * distinct SQL text and therefore a distinct un-reclaimable server-side
 * prepared statement. The count is dominated by its longest term, so a cap on
 * LENGTH is what actually bounds the total.
 *
 * 3 because that is where real sorts stop and generated ones start. The two
 * shapes that show up in application code are a single sort key, and a sort key
 * plus a tiebreaker for stable pagination (`[{createdAt:'desc'},{id:'asc'}]`).
 * Three covers the widest genuinely hand-written form, a category or priority
 * followed by recency followed by a primary-key tiebreak. A fourth key is
 * effectively always a UI that lets the caller stack sort columns, which is
 * exactly the shape that should not be minting named statements. The asymmetry
 * of the two errors also points this way: naming a 4-key sort risks the 116,280
 * above, while NOT naming one costs a single extra server-side parse per
 * execution on a query that is already rare.
 */
export const MAX_NAMED_ORDER_KEYS = 3;

/**
 * Canonical identity of ONE order term's sort EXPRESSION, or `null` when this
 * rule declines to decide for that shape.
 *
 * DIRECTION IS DELIBERATELY EXCLUDED. `ORDER BY id ASC, id DESC` sorts exactly
 * like `ORDER BY id ASC`: the first term already totally orders the rows it
 * covers, so no later term on the same expression can move anything, whichever
 * way it points. Including the direction would have missed the very case that
 * motivated this, a pair of entries spelled differently AND pointing
 * differently.
 *
 * The column is RESOLVED rather than compared as spelled, via the same
 * `resolveColumnName` every SQL builder resolves keys through, so `userId` and
 * `user_id` on an introspected schema are recognised as the one column they
 * both compile to. Falls back to the raw key when the key resolves to nothing
 * (metadata-less test schemas): the compile path a few lines later is what
 * reports an unknown field, and this function must not pre-empt that error with
 * a worse one.
 *
 * `null` (not compared) for two shapes:
 *  - VECTOR KNN ordering. Two distance terms on one column with DIFFERENT
 *    target vectors are genuinely different expressions and the second is not a
 *    no-op, so deciding would mean hashing the operand, which is a 1,536-float
 *    array on a typical embedding column. Not worth the per-build cost for a
 *    shape that {@link MAX_NAMED_ORDER_KEYS} already bounds.
 *  - RELATION ordering (`{posts:{_count:'desc'}}`, `{author:{name:'asc'}}`,
 *    pick-row). Same reason in a different key: the expression is a correlated
 *    subquery whose identity is its whole nested shape.
 * Both are bounded by the length cap; neither can be refused wrongly here.
 */
export function orderKeyIdentity(meta: ColumnNameSource | undefined, key: string, value: unknown): string | null {
  if (isVectorOrderBy(value)) return null;
  if (isJsonPathOrderBy(value)) {
    // Same column AND same path AND same cast is one expression; a different
    // path or a numeric-vs-text cast is a different one, and both are ordinary
    // in a multi-key sort over a document column.
    const column = resolvedOrderColumn(meta, key);
    return `json:${column}:${value.type ?? ''}:${JSON.stringify(value.path)}`;
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && !isOrderBySpec(value)) {
    return null;
  }
  return `col:${resolvedOrderColumn(meta, key)}`;
}

/** {@link resolveColumnName} with the raw key as the unresolvable fallback. */
function resolvedOrderColumn(meta: ColumnNameSource | undefined, key: string): string {
  return (meta ? resolveColumnName(meta, key) : undefined) ?? key;
}

/** One term dropped as redundant: the key removed, and the key that outranked it. */
export interface DroppedTerm {
  key: string;
  first: string;
  /** What both keys resolved to: a column name, or a groupBy SELECT expression. */
  resolved: string;
}

/**
 * Remove `orderBy` entries that sort by an expression an earlier entry already
 * sorted by. Returns `null` when nothing is redundant, which is the common case
 * and the one that must stay allocation-light and byte-identical.
 *
 * WHY THIS DROPS RATHER THAN REFUSES, because the reverse was specified and the
 * premise turned out not to hold. A repeated sort key is a no-op in SQL, and it
 * is the only way to push an `orderBy` past the table's column count (measured:
 * `[{id:'asc'}] x n` produced a distinct named prepared statement for every n,
 * from ONE column, with no ceiling short of the request body size). Both of
 * those are true. What is NOT true is that it is always a caller bug. The
 * idiomatic stable-pagination shape is
 *
 *     orderBy: [{ [sortField]: sortDir }, { id: 'asc' }]
 *
 * appending a primary-key tiebreak unconditionally, which is correct defensive
 * code, and which produces a duplicate exactly when the caller sorts by the
 * primary key. That is a column header a user clicks, so refusing would turn a
 * working table into a 500 on one column and no others. This repo's own
 * differential fuzz generator writes that pattern, comment included ("a random
 * key first, the PK as final tiebreaker"), and picks the sort field from a pool
 * that contains `id`, so a refusal would have failed the suite on 10-35% of
 * generated cases depending on table width.
 *
 * Dropping has no such failure mode: the removed term provably cannot move a
 * row, so the result set and its order are unchanged, and the caller is told
 * about the redundancy through a dev-only warn-once instead of an exception.
 * The security outcome is identical, because what actually bounds the emitted
 * statement set is the length cap ({@link MAX_NAMED_ORDER_KEYS}), which is
 * shape-blind and applies to repeats and permutations alike. This function's
 * job is narrower: keep the ordinary two-key sort under that cap so it keeps
 * its named statement.
 *
 * A DROPPED TERM IS STILL VALIDATED, see {@link assertDroppedDirection}. The
 * drop is an optimization, and an optimization must not decide whether an input
 * is legal.
 *
 * @param table the table the sort is against, so a refused direction reads
 *   exactly as it does when the compile path raises it. Defaults to the
 *   metadata's own name, which is what a caller holding only a `TableMetadata`
 *   would have passed anyway.
 */
export function dedupeOrderEntries(
  meta: ColumnNameSource | undefined,
  entries: [string, unknown][],
  table: string | undefined = meta?.name,
): { entries: [string, unknown][]; dropped: DroppedTerm[] } | null {
  if (entries.length < 2) return null;
  const seen = new Map<string, string>();
  let dropped: DroppedTerm[] | undefined;
  const kept: [string, unknown][] = [];
  for (const entry of entries) {
    const identity = orderKeyIdentity(meta, entry[0], entry[1]);
    const first = identity === null ? undefined : seen.get(identity);
    if (first !== undefined) {
      assertDroppedDirection(entry[0], entry[1], table);
      // Resolved only on the dropping branch, so the advisory can name the one
      // column two different spellings landed on without costing the hot path.
      if (dropped === undefined) dropped = [];
      dropped.push({ key: entry[0], first, resolved: resolvedOrderColumn(meta, entry[0]) });
      continue;
    }
    if (identity !== null) seen.set(identity, entry[0]);
    kept.push(entry);
  }
  return dropped ? { entries: kept, dropped } : null;
}

/**
 * Validate the direction of a term this function is about to DROP.
 *
 * Without this the drop swallowed the check, because the direction guard lives
 * on the COMPILE path (`buildOrderBy`) and a dropped term never reaches it:
 * `orderBy: [{id:'asc'}, {id:'sideways'}]` was silently accepted while
 * `orderBy: [{id:'sideways'}]` alone raised E003, and `groupBy` (which
 * validates BEFORE its own dedupe) still refused the identical input, so the
 * two surfaces disagreed about whether a query was valid. Whether a bad
 * direction is reported must not depend on whether some earlier term happened
 * to name the same column.
 *
 * Only two shapes can reach here, which is what makes the branch exhaustive:
 * {@link orderKeyIdentity} returns `null` (never deduped, never dropped) for
 * the vector and relation shapes, leaving the JSON-path form and the plain
 * column / OrderBySpec form. Each is checked with exactly the guard
 * `buildOrderBy` (relations.ts) would have applied to it, message included, so
 * a dropped term is accepted or refused identically to a kept one.
 */
function assertDroppedDirection(key: string, value: unknown, table: string | undefined): void {
  if (isJsonPathOrderBy(value)) {
    assertDirectionToken(value.direction, `JSON-path orderBy on "${key}"`);
    return;
  }
  assertOrderDirection(value, table === undefined ? `orderBy "${key}"` : `orderBy "${key}" on table "${table}"`);
}

/**
 * The {@link dedupeOrderEntries} rule applied to a `DISTINCT ON` column list,
 * the other caller-supplied list written into the SQL one term per element.
 * `DISTINCT ON (a, a)` groups exactly as `DISTINCT ON (a)` does, so a repeat is
 * a no-op here too, and the same generated-code shape produces it (a grouping
 * column chosen by the caller, plus a fixed one appended by the code).
 *
 * No length cap to go with it, deliberately. Unlike `orderBy`, `DISTINCT ON`
 * has a meaning that degrades as the list grows (every added column makes the
 * result strictly less distinct, converging on the plain query), so a long list
 * is self-limiting in a way a long sort is not.
 */
export function dedupeColumnList(
  meta: ColumnNameSource | undefined,
  columns: readonly string[],
): { columns: string[]; dropped: DroppedTerm[] } | null {
  if (columns.length < 2) return null;
  const seen = new Map<string, string>();
  let dropped: DroppedTerm[] | undefined;
  const kept: string[] = [];
  for (const key of columns) {
    const column = typeof key === 'string' ? resolvedOrderColumn(meta, key) : null;
    const first = column === null ? undefined : seen.get(column);
    if (first !== undefined && column !== null) {
      if (dropped === undefined) dropped = [];
      dropped.push({ key, first, resolved: column });
      continue;
    }
    if (column !== null) seen.set(column, key);
    kept.push(key);
  }
  return dropped ? { columns: kept, dropped } : null;
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
