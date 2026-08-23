/**
 * turbine-orm, Query builder utilities
 *
 * Standalone utility functions and classes used by the query builder.
 */

import pg from 'pg';
import { ValidationError } from '../errors.js';
import { camelToSnake, localDateTimeKind, snakeToCamel, timeOfDayKind } from '../schema.js';
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
  /**
   * The table's own name, present whenever the source is a real
   * `TableMetadata`. Used for ERROR TEXT only, never for key resolution, so a
   * hand-built source that omits it still resolves identically.
   */
  name?: string;
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
 * Resolve a user-supplied key to a relation's CANONICAL name and definition, or
 * `undefined` when the key names no relation on the table.
 *
 * The relation-name half of the rule {@link resolveColumnName} states for
 * columns, and deliberately the same shape: the declared name first, else
 * `snakeToCamel(key)` accepted ONLY when that names a real relation.
 * `snakeToCamel` is idempotent on an already-camel string, so a canonical key
 * takes the first branch and this is a no-op for every existing caller.
 *
 * WHY IT EXISTS. A relation has one declared name, `ripeningChecks`, while the
 * DDL anyone reads has only the TABLE name, `ripening_checks`. Writing back
 * what the schema shows therefore failed with E005 in `with`, E003 in a
 * relation filter, and E005 in `orderBy`, on names the error text was already
 * computing correctly ("Did you mean ...?"). A system that can name the
 * intended relation can accept it.
 *
 * NOT A GUESS, for the same reason the column rule is not: the transformed name
 * is accepted only when it is a real declared relation, so an unknown key still
 * fails and a typo is still a typo. Exact match wins first, so a schema that
 * literally declares `ripening_checks` keeps it, even alongside a
 * `ripeningChecks`.
 *
 * The RESULT KEY is the canonical name, not the caller's spelling, matching the
 * column side (`select: { ledger_handle: true }` already returns
 * `{ ledgerHandle }`). Resolving here rather than normalizing the args up front
 * also means both spellings share one SQL-cache entry instead of minting two
 * templates for one query.
 *
 * Prototype-safe via {@link ownLookup}, so `__proto__` cannot name a relation.
 */
export function resolveRelation<R>(relations: Record<string, R>, key: string): { name: string; def: R } | undefined {
  const direct = ownLookup(relations, key);
  if (direct !== undefined) return { name: key, def: direct };
  const camel = snakeToCamel(key);
  if (camel === key) return undefined;
  const mapped = ownLookup(relations, camel);
  return mapped === undefined ? undefined : { name: camel, def: mapped };
}

/**
 * {@link resolveRelation} when only the definition is wanted: a drop-in for the
 * `ownLookup(meta.relations, key)` it replaces, with the same signature and the
 * same `undefined` on a miss.
 */
export function resolveRelationDef<R>(relations: Record<string, R>, key: string): R | undefined {
  return resolveRelation(relations, key)?.def;
}

// ---------------------------------------------------------------------------
// Caller-controlled key ORDER, canonicalized
// ---------------------------------------------------------------------------

/**
 * THE canonical order for a caller-supplied set of columns: the table's own
 * `allColumns` order, which is the order `omit` and the default projection
 * already produce.
 *
 * ## The failure mode this exists to close, and it is NOT arity
 *
 * Every distinct SQL text Turbine emits is parsed on the server as a NAMED
 * prepared statement and is never DEALLOCATEd. The arity rule
 * (`markVariableArity`) bounds the shapes whose LENGTH the caller picks. It
 * does nothing about the shapes whose length is fixed and whose ORDER the
 * caller picks, and those grow the SQL text just as freely: `select: { a, b }`
 * and `select: { b, a }` are the same query and two different statements.
 *
 * Measured against PostgreSQL 16 on a SEVEN-column table, one connection, with
 * the arity fix already landed:
 *
 *   baseline                              prepared=    0   CachedPlanSource= 0.0 MB
 *   after 5040 `select` permutations      prepared= 5040   CachedPlanSource=39.4 MB
 *   after 300 varying-arity ORs           prepared= 5040   CachedPlanSource=39.4 MB
 *   after 5040 `distinct` permutations    prepared=10080   CachedPlanSource=59.1 MB
 *   720 reordered PATCH bodies (update)   prepared=  720   CachedPlanSource= 2.8 MB
 *
 * The write row is the realistic one: `JSON.parse` preserves insertion order,
 * so `update({ where, data: JSON.parse(reqBody) })` hands a request body the
 * SET-clause column order for free. No arrays, no unusual input, no opt-in.
 *
 * The reachable space is ORDERED subsets, sum over k of k! * C(n,k): 9.9e6 for
 * 10 columns, 6.6e18 for 20. Canonicalizing collapses each permutation class to
 * one statement, leaving the UNORDERED subsets (2^n) that `omit` has always
 * had.
 *
 * ## Why ordering is the right remedy here rather than withholding the name
 *
 * A projection's SELECT-list order is not semantically meaningful to Turbine:
 * rows are assembled by NAME (`parseRow`, `jsonScalarPairs` and
 * `buildRelationShape` all key off the same resolved list), so reordering it
 * changes no value. Where an order IS meaningful (`orderBy`, and `DISTINCT ON`,
 * whose list is re-emitted as an ORDER BY prefix), the statement is sent
 * unnamed instead. See `MAX_NAMED_ORDER_KEYS` in filters.ts and the `distinct`
 * mark in builder.ts.
 *
 * Duplicates collapse, which is the other half of "canonical": two spellings of
 * one column (`userId` and `user_id`, both legal on an introspected schema)
 * used to emit that column twice in the SELECT list.
 *
 * Cost is one Set of the projected columns plus one pass over `allColumns`, on
 * a path that already walks the caller's keys.
 *
 * @param meta the table the columns belong to; without `allColumns` there is no
 *   canonical order to appeal to and the input is returned untouched.
 * @param columns already-resolved snake_case column names.
 */
export function canonicalColumnOrder(meta: ColumnNameSource, columns: string[]): string[] {
  const all = meta.allColumns;
  if (all === undefined || columns.length < 2) return columns;
  const wanted = new Set(columns);
  const ordered: string[] = [];
  for (const col of all) {
    if (wanted.delete(col)) ordered.push(col);
  }
  // A resolved column absent from `allColumns` is only reachable from
  // hand-built metadata whose maps disagree with each other. Keep it (in the
  // caller's relative order) rather than silently dropping it from the
  // projection: this function reorders, it never decides what is projected.
  if (wanted.size > 0) {
    for (const col of columns) {
      if (wanted.delete(col)) ordered.push(col);
    }
  }
  return ordered;
}

/**
 * {@link canonicalColumnOrder} for a write's `data` entries: same order, same
 * reason, two deliberate differences.
 *
 * DUPLICATES ARE KEPT. Two keys resolving to one column (`{ userId, user_id }`)
 * is a caller error that PostgreSQL reports precisely ("multiple assignments to
 * same column", 42701, and the INSERT equivalent). Collapsing them here would
 * turn that error into a silent write of whichever value survived, so the entry
 * list is REORDERED and never shortened. A stable sort keeps such a pair
 * adjacent and in the caller's relative order, so the engine still sees, and
 * still rejects, both assignments.
 *
 * THE KEY SPELLING IS PRESERVED. Everything downstream (`coerceWriteValue`,
 * `buildSetClause`, `toSqlColumn`) re-resolves the caller's key itself, so only
 * the ORDER of the entries changes here, never their content.
 *
 * A key that resolves to no column sorts LAST, in the caller's relative order.
 * It is about to raise E003 from the SQL builder either way, and the builder is
 * where that error belongs; ordering must not pre-empt it with a worse one.
 */
export function canonicalWriteEntries(meta: ColumnNameSource, entries: [string, unknown][]): [string, unknown][] {
  const all = meta.allColumns;
  if (all === undefined || entries.length < 2) return entries;
  const index = new Map<string, number>();
  for (let i = 0; i < all.length; i++) index.set(all[i]!, i);
  const rank = (key: string): number => {
    const column = resolveColumnName(meta, key);
    const at = column === undefined ? undefined : index.get(column);
    return at ?? Number.MAX_SAFE_INTEGER;
  };
  // Ranks are computed once per entry rather than inside the comparator, which
  // would re-resolve every key O(k log k) times.
  const ranked = entries.map((entry, at) => ({ entry, rank: rank(entry[0]), at }));
  // `at` breaks ties explicitly rather than relying on sort stability, so two
  // spellings of one column, and every unresolvable key, keep the order the
  // caller wrote them in.
  ranked.sort((a, b) => a.rank - b.rank || a.at - b.at);
  return ranked.map((r) => r.entry);
}

// ---------------------------------------------------------------------------
// Internally-synthesized combinator brand
// ---------------------------------------------------------------------------

/**
 * Brands a WHERE object whose `AND` / `OR` array Turbine ITSELF synthesized,
 * rather than one the caller wrote.
 *
 * The distinction matters for exactly one rule: a caller-written combinator
 * array is treated as a VARIABLE-ARITY shape and its statement is sent unnamed
 * (see `markVariableArity` in where.ts, and `acquireSql` in builder.ts).
 * Turbine's own wrappers, the `{ AND: [userWhere, globalFilter] }` the
 * global-filter merge produces and the `{ AND: [where, correlation] }` the
 * batched loader produces, have a FIXED arity of two, decided by Turbine, not
 * reachable from a request body. Counting them would have taken every query on
 * a table with a configured global filter off named prepared statements, i.e.
 * penalised precisely the multi-tenant setups the rule exists to protect.
 *
 * A `Symbol.for` key for the same cross-copy-identity reason the warn registry
 * uses one (an ESM and a CJS copy of this module in one process must agree),
 * and a SYMBOL rather than a string key so `Object.keys` (which is what every
 * where walker enumerates) never sees it and no emitted SQL can change.
 */
export const INTERNAL_COMBINATOR = Symbol.for('turbine.internalCombinator');

/** Tag `where` as carrying a Turbine-synthesized combinator, and return it. */
export function markInternalCombinator<T extends object>(where: T): T {
  Object.defineProperty(where, INTERNAL_COMBINATOR, { value: true, enumerable: false, configurable: true });
  return where;
}

/** Was this WHERE object's combinator synthesized by Turbine? */
export function isInternalCombinator(where: unknown): boolean {
  return (
    typeof where === 'object' && where !== null && (where as Record<symbol, unknown>)[INTERNAL_COMBINATOR] === true
  );
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
 * When the cache exceeds maxSize, the oldest (least recently used) entry is
 * evicted. Uses Map insertion order, so EVICTION is O(1).
 *
 * The access-order reorder in {@link get} is not: `Map.delete` + `Map.set`
 * leaves a tombstone, and V8 rehashes the whole table once live plus deleted
 * entries reach capacity, so the reorder amortizes to O(capacity) per hit.
 * At the 1,000-entry default that measured 1,356 ns against 2.6 ns for a plain
 * `Map.get`, on the hottest lookup in the SQL build. See {@link get} for why
 * skipping it below capacity is not merely an optimization but exact.
 */
export class LRUCache<K, V> {
  private cache = new Map<K, V>();
  constructor(private maxSize: number) {}

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    // Access order is only ever CONSUMED by eviction (`set` drops the first
    // key once the cache is full), so while it is still filling, maintaining
    // that order cannot change WHICH entries are present: nothing is evicted,
    // and the reorder is pure cost. So it starts the moment the cache is full,
    // and from then on every hit reorders exactly as before.
    //
    // What is traded, stated plainly: reads that happened while the cache was
    // filling are not reflected in the order, so the first evictions after it
    // fills can drop an entry that was hot early rather than the true
    // least-recently-used one. Reads after that point are ordered normally, so
    // the effect does not accumulate, and the worst case is one extra SQL
    // rebuild on the next miss. This cache decides speed, never results.
    if (value !== undefined && this.cache.size >= this.maxSize) {
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
  /**
   * The name this statement executes under, or `''` for "send it UNNAMED".
   *
   * The empty string is a real value here, not a missing one: a shape whose SQL
   * text is a function of a caller-chosen ARITY (an `OR`/`AND` array) must never
   * take a server-side prepared statement, because those are never DEALLOCATEd
   * and the client's LRU bounds only the client. Storing the verdict on the
   * ENTRY is what makes it survive the cache: a later HIT reuses this name, so
   * a warmed template cannot regain one. See `buildCacheEntry` in builder.ts.
   */
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
 *
 * The empty-string guard mirrors pg's own `parseDateArray`, which opens
 * `if (!value) return null`. Turbine's copy did not, and answered `[]` where
 * the driver answers `null` for the same input. No column produces it (a SQL
 * NULL never reaches a parser, and an empty array is `{}`), so this is parity
 * for its own sake rather than a bug report; it matters because these parsers
 * are registered process-globally over pg's, and a shape where Turbine's
 * answer differs from the driver's is a difference somebody eventually finds
 * the hard way.
 */
export function createPgArrayParser(element: (text: string) => unknown): (text: string) => unknown[] | null {
  const arrayParser = pg.types.arrayParser as unknown as PgArrayParserModule;
  return (text: string): unknown[] | null =>
    text
      ? arrayParser.create(text, (entry) => (entry === null || entry === undefined ? null : element(entry))).parse()
      : null;
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
  // The `timestamptz` pair carries an explicit offset, so unlike the four
  // above its expectation is NOT computed from local components: pg's default
  // and Turbine's fast scan produce the same instant in every zone. These two
  // probes are consulted by {@link registerFastTemporalParserIfDefault}, which
  // DECLINES to install rather than warning-and-overwriting.
  1184: { text: '2020-01-02 03:04:05+00', expected: () => new Date(Date.UTC(2020, 0, 2, 3, 4, 5)) },
  1185: { text: '{"2020-01-02 03:04:05+00"}', expected: () => [new Date(Date.UTC(2020, 0, 2, 3, 4, 5))] },
};

/**
 * Marks a text parser as one TURBINE installed, so a later registration in the
 * same process (a client plus `turbine studio`, ESM plus CJS copies of this
 * module) does not report Turbine's own parser as "somebody else's". A
 * `Symbol.for` key, for the same cross-copy-identity reason the warn registry
 * uses one.
 */
const TURBINE_PARSER = Symbol.for('turbine.typeParser');

/**
 * The OIDs the `utcTimestamps` flag governs, and so the ones it can opt out of.
 *
 * 1184 / 1185 are in the set because the flag gates their registration too,
 * but they are there for a different reason from the other four: those four
 * change a READING (local zone to UTC), while the `timestamptz` pair changes
 * only decode SPEED. See {@link registerUtcTemporalParsers}.
 */
const TEMPORAL_PARSER_OIDS: ReadonlySet<number> = new Set([1114, 1082, 1115, 1182, 1184, 1185]);

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
  // The `utcTimestamps: false` opt-out only governs the six TEMPORAL OIDs.
  // Offering it as the remedy for int8 (20) would name a setting that does
  // nothing for the OID being warned about; that registration has no opt-out.
  // (1184 / 1185 never reach this warning at all: they DECLINE over a
  // non-default parser instead of overwriting it. They are named in the
  // sentence because it describes what the flag leaves alone.)
  const remedy = TEMPORAL_PARSER_OIDS.has(oid)
    ? ' `utcTimestamps: false` leaves the six temporal OIDs (1114, 1082, 1115, 1182, 1184, 1185) alone entirely.'
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
 * Register Turbine's temporal text parsers on the pg module. SIX OIDs, doing
 * two different jobs:
 *
 *   1114 / 1082 / 1115 / 1182   the UTC READING of the zone-less types,
 *                               `timestamp`, `date` and their array forms.
 *                               This changes what a column means and is what
 *                               `utcTimestamps` is named for.
 *   1184 / 1185                 the fast decode path for `timestamptz` and
 *                               `timestamptz[]`. This changes NOTHING about
 *                               what a column means: an offset-carrying value
 *                               has one instant and this reads the same one.
 *                               It is here for speed, `timestamptz` being ~88%
 *                               of the client-side decode cost of a wide row
 *                               drain, and it DECLINES rather than overwrites
 *                               (see the comment at the call site).
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
  // `timestamptz` (1184) and `timestamptz[]` (1185). SPEED ONLY: an offset-
  // carrying value has exactly one instant, and this reads it as the same
  // instant `postgres-date` does, so nothing here changes what a column means.
  //
  // Two things about it are deliberate and neither is obvious.
  //
  // It is gated behind `utcTimestamps` along with the other four, even though
  // that flag is about a READING and this is not. The alternative was a second
  // registration site outside this function, and one process-global parser
  // table with two places that write to it is the exact shape the "ONE place"
  // rule above exists to prevent. So the flag reads as "leave pg's temporal
  // parser table alone", and `utcTimestamps: false` costs the optimisation as
  // well as the UTC reading. That is a documented cost, not an oversight.
  //
  // And it DECLINES rather than overwrites (see
  // {@link registerFastTemporalParserIfDefault}), which is the opposite of what
  // the four above do. They MUST overwrite: they exist to replace a reading,
  // and a process where half the temporal columns read local and half read UTC
  // is broken. This one exists only to be faster, so a caller who installed
  // their own `timestamptz` parser (to get strings, or Luxon objects, or a
  // Temporal instant) keeps it. Overwriting them would trade their correctness
  // for our speed, which is never the right trade, and Turbine has never
  // touched 1184 before now, so declining is also what preserves that.
  const parseTimestamptz = registerFastTemporalParserIfDefault(1184, createFastTimestamptzParser);
  if (parseTimestamptz) {
    registerFastTemporalParserIfDefault(1185, () => createPgArrayParser(parseTimestamptz));
  }
}

/**
 * Install a SPEED-ONLY parser for `oid`, but only over pg's own default (or
 * over a parser Turbine itself installed earlier in this process).
 *
 * Returns the installed parser, or `undefined` when it declined, so a caller
 * can hold a scalar and its array form to the same decision: registering the
 * array half over a caller's customized scalar half would make the two
 * disagree, which is worse than leaving both slow.
 *
 * `build` receives the parser being replaced, which becomes the fast path's
 * fallback. That is only sound because the parser being replaced is known to
 * be pg's default (or Turbine's own wrapper around it); the check below is
 * what makes it so, and is not an optimisation of it.
 */
function registerFastTemporalParserIfDefault(
  oid: number,
  build: (fallback: (text: string) => unknown) => (text: string) => unknown,
): ((text: string) => unknown) | undefined {
  const getParser = pg.types.getTypeParser as unknown as (oid: number, format: 'text') => (value: string) => unknown;
  const setParser = pg.types.setTypeParser as unknown as (oid: number, parse: (value: string) => unknown) => void;
  const current = getParser(oid, 'text');
  const isTurbines = (current as unknown as Record<symbol, unknown>)[TURBINE_PARSER] === true;
  if (!isTurbines && !isDefaultTextParser(oid, current)) return undefined;
  const parser = markTurbineParser(build(current));
  setParser(oid, parser);
  return parser;
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
    `Unknown field "${field}" on table "${table}".${didYouMean}` +
    ` Known columns: ${columns.join(', ') || '(none)'}.` +
    (relations.length ? ` Known relations (valid in \`where\` and \`with\`): ${relations.join(', ')}.` : '')
  );
}

/**
 * The trailing "Available: a, b, c" clause of a name-not-found error, or
 * `emptySentence` when there is nothing to list.
 *
 * The empty branch is the whole reason this exists. Fifteen error sites
 * interpolated `Object.keys(...).join(', ')` directly, and on a table with no
 * relations (or a schema with no tables) that renders a dangling
 * `Available: ` with nothing after the colon, which reads as a broken error
 * message rather than as an answer. One site already got this right by hand;
 * the other fourteen are now the same function, so the next one cannot get it
 * wrong by omission.
 */
export function availableClause(names: readonly string[], emptySentence: string): string {
  return names.length > 0 ? `Available: ${names.join(', ')}` : emptySentence;
}

/**
 * The error text for a RELATION named inside `select` / `omit`.
 *
 * Separate from {@link unknownFieldMessage} because the generic text degrades
 * into nonsense here: `closestName` matches an exactly-spelled relation name at
 * distance zero, so the message would read `Unknown field "comments". Did you
 * mean "comments" (a relation)?`, which answers a question nobody asked and
 * hides the actual fix.
 *
 * It is worth its own message for a second reason: this is not really a typo,
 * it is a habit. Prisma nests a relation inside `select`, so writing
 * `select: { comments: true }` is the natural first guess, and in Turbine a
 * relation is loaded by `with`, which sits BESIDE `select` rather than inside
 * it. Naming the fix costs one sentence and saves a search.
 */
export function relationInProjectionMessage(table: string, field: string, clause: 'select' | 'omit'): string {
  const head = `"${field}" is a relation on table "${table}", not a column, so it cannot be named in \`${clause}\`.`;
  return clause === 'select'
    ? `${head} Load it with \`with: { ${field}: true }\`, which is a sibling of \`select\`, not a member of it.` +
        " To narrow the relation's own columns, put a `select` inside that relation's options:" +
        ` \`with: { ${field}: { select: { … } } }\`.`
    : `${head} A relation is only present when you ask for it in \`with\`, so leave it out of \`with\` to leave it` +
        ' out of the result.';
}

/**
 * Dev-only advisory for a sort/grouping term Turbine dropped as redundant
 * (`filters.ts` `dedupeOrderEntries` / `dedupeColumnList`).
 *
 * Deliberately a WARNING and not an error, and deliberately not silent either.
 * The dropped term provably cannot change a result, so failing the query would
 * be a false alarm on a shape correct code produces (a caller-chosen sort key
 * plus an unconditional primary-key tiebreak, which collide exactly when the
 * caller sorts by the primary key). But a caller who wrote the duplicate by
 * hand, or who believes a second key is doing something, should hear about it
 * once. Dev-only for the usual reason: it describes the QUERY the application
 * sends, which does not vary with the environment, so a production process
 * learns nothing from repeating it.
 *
 * Keyed per dropped key, so a sort assembled per request from the same UI says
 * it once rather than once per request.
 */
export function warnRedundantSortTerm(
  table: string,
  clause: string,
  dropped: readonly { key: string; first: string; resolved: string }[],
): void {
  if (process.env.NODE_ENV === 'production') return;
  for (const d of dropped) {
    if (!shouldWarnOnce(WARN_NS.redundantSortTerm, `${table}|${clause}|${d.key}`)) continue;
    const how =
      d.first === d.key
        ? `"${d.key}" is named twice`
        : `"${d.key}" and the earlier "${d.first}" both target ${d.resolved}`;
    console.warn(
      `[turbine] ${clause} on table "${table}": ${how}, so the later one was dropped. It could not have ` +
        'changed the result (the earlier term already orders those rows), and dropping it keeps the query on ' +
        'a shared prepared statement. Remove it to silence this.',
    );
  }
}

/**
 * The two projection SHAPE refusals (0.65), shared by the SQL engines' single
 * resolver, the batched loader's raw-arg check, and PowDB, so every path that
 * refuses these shapes does so with one message.
 *
 * Both checks look at TRUTHY keys, and the raw-arg check in the batched
 * loader exists because the loader force-adds correlation keys to a `select`
 * before the resolver sees it: evaluated after that adjustment, an all-falsy
 * user `select` looks populated and the verdict flips between strategies,
 * which is exactly the class 0.64/0.65 exist to kill.
 */
export function selectNamesNothingMessage(table: string): string {
  return (
    `"select" names no fields (on table "${table}"): every value is false or it is empty. ` +
    `Pass at least one field as true, or drop "select" to get the default projection.`
  );
}

export function selectOmitExclusiveMessage(table: string): string {
  return (
    `"select" and "omit" are mutually exclusive (on table "${table}"). ` +
    `A select already lists exactly the fields you want.`
  );
}

/**
 * The Prisma pagination aliases, folded into Turbine's own spelling ONCE,
 * before anything reads them.
 *
 * Turbine's names are `limit` / `offset`; Prisma's are `take` / `skip`. `take`
 * was accepted and `skip` was not, which is the worst of the three possible
 * states: `{ take: 20, skip: 40 }` is what a Prisma habit writes, it looks
 * accepted because half of it is, and the query silently returns page one
 * forever. An unknown key is at least inert on its own; a HALF-recognized pair
 * changes the answer.
 *
 * Folded here rather than read at each site deliberately. `take` used to be
 * handled by six separate `args?.take ?? args?.limit` reads, one of which is
 * the SQL-cache FINGERPRINT, so adding `skip` the same way would have meant
 * teaching six places about it and a miss in the fingerprint is not a missing
 * feature, it is two different pages sharing one cached statement. Normalizing
 * up front leaves `limit` / `offset` as the single authority and the aliases
 * cease to exist below this line.
 *
 * Returns the SAME object when neither alias is present, so the common path
 * allocates nothing.
 */
export function normalizePagination<A extends object | undefined>(args: A): A {
  if (!args) return args;
  const a = args as { limit?: unknown; offset?: unknown; take?: unknown; skip?: unknown };
  if (a.take === undefined && a.skip === undefined) return args;

  const out = { ...(args as Record<string, unknown>) };
  if (a.take !== undefined) {
    assertAliasAgrees('take', a.take, 'limit', a.limit);
    out.limit = a.take;
    delete out.take;
  }
  if (a.skip !== undefined) {
    assertAliasAgrees('skip', a.skip, 'offset', a.offset);
    out.offset = a.skip;
    delete out.skip;
  }
  return out as A;
}

/**
 * Both spellings of one bound, disagreeing. Refused rather than resolved: the
 * old `take ?? limit` silently preferred one of the two numbers the caller
 * wrote, and there is no reading of `{ limit: 10, take: 5 }` that makes one of
 * them the intended answer. Equal values are accepted, since there is nothing
 * to choose between.
 */
function assertAliasAgrees(alias: string, aliasValue: unknown, native: string, nativeValue: unknown): void {
  if (nativeValue === undefined || nativeValue === aliasValue) return;
  throw new ValidationError(
    `"${alias}" and "${native}" are the same option and were given different values ` +
      `(${alias}: ${String(aliasValue)}, ${native}: ${String(nativeValue)}). ` +
      `"${alias}" is Prisma's spelling of "${native}"; pass one of them.`,
  );
}
