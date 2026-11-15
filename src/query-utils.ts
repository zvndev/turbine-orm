/**
 * turbine-orm, Query builder utilities
 *
 * Standalone utility functions and classes used by the query builder.
 */

import { ValidationError } from './errors.js';
import { logTo, type TurbineLogger } from './logger.js';
import { shouldWarnOnce, WARN_NS } from './query/warn-registry.js';
import { camelToSnake, localDateTimeKind, snakeToCamel, timeOfDayKind } from './schema.js';

export {
  createFastTimestamptzParser,
  createUtcDateParser,
  createUtcDateParserGeneral,
  createUtcTimestampParser,
  createUtcTimestampParserGeneral,
  parseUtcTimestampText,
} from './query/temporal-parsers.js';

/** @internal Query parser/cancel runtime, local to this module copy. */
interface QueryDriver {
  readonly Pool?: unknown;
  readonly Client?: unknown;
  readonly defaults?: { binary?: boolean };
  readonly Connection?: unknown;
  readonly types: {
    getTypeParser(oid: number, format: 'text'): (text: string) => unknown;
    arrayParser: { create(text: string, transform?: (text: string) => unknown): { parse(): unknown[] } };
  };
}
// No native lookup at evaluation. The PostgreSQL compatibility entry installs
// its own runtime. Optional transports provide their own dialect wire rules.
let pg = {} as QueryDriver;
export function registerQueryDriver(driver: QueryDriver): void {
  pg = driver;
}

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

/** Shared by every brand: a frozen descriptor saves an allocation per branded where. */
const INTERNAL_COMBINATOR_DESCRIPTOR: PropertyDescriptor = Object.freeze({
  value: true,
  enumerable: false,
  configurable: true,
});

/** Tag `where` as carrying a Turbine-synthesized combinator, and return it. */
export function markInternalCombinator<T extends object>(where: T): T {
  Object.defineProperty(where, INTERNAL_COMBINATOR, INTERNAL_COMBINATOR_DESCRIPTOR);
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

const LIKE_META = /[\\%_]/;
const LIKE_META_G = /[\\%_]/g;

/**
 * Escape LIKE pattern metacharacters: %, _, and \.
 * Must be used with `ESCAPE '\'` in the LIKE clause.
 */
export function escapeLike(value: string): string {
  // One pass, and none at all for the common operand with no metacharacter.
  // Identical output to escaping `\` then `%` then `_` in turn: the backslashes
  // the first step adds are never `%` or `_`, so the steps never interact.
  return LIKE_META.test(value) ? value.replace(LIKE_META_G, '\\$&') : value;
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
  /**
   * How many params the build pushed, i.e. the statement's placeholder count.
   * A cache hit whose collect path produces a different count is refused with
   * an InvariantError before anything is sent. Optional so an entry built
   * outside the cache (a test fixture) still type-checks; such an entry skips
   * the count check.
   */
  paramCount?: number;
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

/**
 * How many distinct statement names one process hands out. Every connection
 * keeps each named statement it has prepared, at 9 to 45 KB of server memory
 * apiece, until the connection closes, so the number of names is what bounds
 * that memory. A statement past the budget is sent unnamed: parsed on every
 * execution and never kept, which costs a few microseconds on a cheap query.
 */
export const PREPARED_STATEMENT_BUDGET = 200;

/** `Symbol.for` so the ESM and CJS copies of this module share one budget. */
const PREPARED_NAMES = Symbol.for('turbine.preparedStatementNames');

function preparedNames(): Set<string> {
  const holder = globalThis as { [PREPARED_NAMES]?: Set<string> };
  let names = holder[PREPARED_NAMES];
  if (!names) {
    names = new Set();
    holder[PREPARED_NAMES] = names;
  }
  return names;
}

/**
 * The prepared-statement name for `sql`, or `''` (send it unnamed) once the
 * process has named {@link PREPARED_STATEMENT_BUDGET} other statements.
 *
 * The first shapes a process runs keep their names for its lifetime, which in
 * practice are its hot shapes. A server-side `DEALLOCATE` cannot replace this:
 * a pooled query does not know which connection it will run on, and a
 * connection keeps every name it ever prepared.
 */
export function boundedPreparedName(sql: string): string {
  return claimPreparedName(sqlToPreparedName(sql));
}

/**
 * Claim an already derived statement name from the same budget as
 * {@link boundedPreparedName}: `name` itself, or `''` (send it unnamed) once
 * the budget is spent. `sqlComment`'s `c_` names (query/sql-comment.ts) are
 * claimed here, so a commented statement costs one slot like any other.
 */
export function claimPreparedName(name: string): string {
  const names = preparedNames();
  if (names.has(name)) return name;
  if (names.size >= PREPARED_STATEMENT_BUDGET) return '';
  names.add(name);
  return name;
}

/** @internal Tests only: forget every name handed out. */
export function resetPreparedNameBudget(): void {
  preparedNames().clear();
}

/** The `params` object a middleware receives. */
export interface MiddlewareParams {
  model: string;
  action: string;
  args: Record<string, unknown>;
}

function argsRewriteError(model: string, action: string, path: string): TypeError {
  return new TypeError(
    `[turbine] middleware cannot change \`params.${path}\` on ${model}.${action}: the query is compiled from the ` +
      'arguments the caller passed, so a change made in middleware would not reliably reach it. Put the ' +
      'condition in the query itself, or use `globalFilters` for a filter that applies to every query.',
  );
}

/** Plain objects and arrays are copied; a Date, Buffer, class instance or other value is shared as it is. */
function isPlainContainer(value: unknown): value is object {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Nesting past this is shared, not copied, so a cyclic object cannot recurse without end. */
const MIDDLEWARE_ARGS_MAX_DEPTH = 100;

/**
 * A copy of `value` that middleware may read, spread, serialize or
 * `structuredClone`: plain objects and arrays are copied at every depth, and
 * everything else (Date, Buffer, bigint, symbol, class instance) is shared.
 * Symbol-keyed properties are copied by descriptor, so the markers the
 * pipeline reads (the internal-combinator brand, the inclusive-cursor flag,
 * column and expression brands) are on the copy exactly as on the original,
 * non-enumerable ones included.
 */
function copyArgs(value: unknown, depth: number): unknown {
  if (depth > MIDDLEWARE_ARGS_MAX_DEPTH || !isPlainContainer(value)) return value;
  let out: Record<PropertyKey, unknown>;
  if (Array.isArray(value)) {
    const items: unknown[] = new Array(value.length);
    // A long list of ids is the common big argument; keep its scalars off the call path.
    for (let i = 0; i < value.length; i++) {
      const item: unknown = value[i];
      items[i] = item !== null && typeof item === 'object' ? copyArgs(item, depth + 1) : item;
    }
    out = items as unknown as Record<PropertyKey, unknown>;
  } else {
    out = Object.getPrototypeOf(value) === null ? Object.create(null) : {};
    for (const key of Object.keys(value)) {
      const item = (value as Record<string, unknown>)[key];
      const copied = item !== null && typeof item === 'object' ? copyArgs(item, depth + 1) : item;
      // `__proto__` from JSON.parse is an own key; assigning it would set the prototype.
      if (key === '__proto__')
        Object.defineProperty(out, key, { value: copied, enumerable: true, writable: true, configurable: true });
      else out[key] = copied;
    }
  }
  for (const sym of Object.getOwnPropertySymbols(value)) {
    Object.defineProperty(out, sym, Object.getOwnPropertyDescriptor(value, sym) as PropertyDescriptor);
  }
  return out;
}

/**
 * Where `b` first differs from `a`, as a path suffix (`.where.id`, or `''` for
 * the values themselves), or undefined when they are structurally equal. The
 * suffix is built on the way back out, so an equal pair costs no string work.
 */
function argsDifference(a: unknown, b: unknown, depth: number): string | undefined {
  if (Object.is(a, b)) return undefined;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return '';
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && Object.is(a.getTime(), b.getTime()) ? undefined : '';
  }
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!(ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) || a.byteLength !== b.byteLength) return '';
    const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return '';
    return undefined;
  }
  if (a instanceof RegExp || b instanceof RegExp) return String(a) === String(b) ? undefined : '';
  if (a instanceof Map || a instanceof Set || b instanceof Map || b instanceof Set) return '';
  if (Array.isArray(a) !== Array.isArray(b) || depth > MIDDLEWARE_ARGS_MAX_DEPTH) return '';
  if (Array.isArray(a)) {
    const other = b as unknown[];
    const shared = Math.min(a.length, other.length);
    for (let i = 0; i < shared; i++) {
      if (Object.is(a[i], other[i])) continue;
      const inner = argsDifference(a[i], other[i], depth + 1);
      if (inner !== undefined) return `.${i}${inner}`;
    }
    return a.length === other.length ? undefined : `.${shared}`;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  for (const key of Object.keys(left)) {
    if (!Object.hasOwn(right, key)) return `.${key}`;
    const inner = argsDifference(left[key], right[key], depth + 1);
    if (inner !== undefined) return `.${key}${inner}`;
  }
  for (const key of Object.keys(right)) if (!Object.hasOwn(left, key)) return `.${key}`;
  return undefined;
}

/** What {@link readOnlyMiddlewareParams} remembers about the `params` it handed out. */
interface MiddlewareArgsState {
  readonly model: string;
  readonly action: string;
  /** The caller's args: what the query is compiled from. */
  readonly original: Record<string, unknown>;
  /** The copy middleware reads, made on the first read of `params.args`. */
  copy: Record<string, unknown> | undefined;
}

const MIDDLEWARE_ARGS = new WeakMap<object, MiddlewareArgsState>();

/** The key Node's `util.inspect` looks for, from the global registry so no `node:` import is needed. */
const NODE_INSPECT = Symbol.for('nodejs.util.inspect.custom');

/** Makes `console.log(params)` show the values rather than an accessor. Not own, so a spread of `params` never carries it. */
const MIDDLEWARE_PARAMS_PROTOTYPE = Object.defineProperty({}, NODE_INSPECT, {
  value(
    this: MiddlewareParams,
    _depth: number,
    options: unknown,
    inspect: (value: unknown, options?: unknown) => string,
  ) {
    return inspect({ model: this.model, action: this.action, args: this.args }, options);
  },
});

/**
 * The `params` a middleware receives. `params.args` is a plain copy of the
 * caller's args, made when it is first read, so middleware can read it, spread
 * it, serialize it and `structuredClone` it, and one that never reads it pays
 * nothing.
 *
 * It is a copy because the query is compiled from the caller's args, not from
 * what middleware sees. A change to the copy would never reach the query, so
 * {@link assertMiddlewareArgsKept} refuses it, naming the path, when the
 * middleware calls `next`. That check compares contents, which is why the copy
 * is not frozen: a frozen object ignores a write silently in a script that is
 * not in strict mode, and a filter added there would be dropped without a word.
 * Assigning to `params.args` itself throws at once.
 */
export function readOnlyMiddlewareParams(
  model: string,
  action: string,
  args: Record<string, unknown>,
): MiddlewareParams {
  const state: MiddlewareArgsState = { model, action, original: args, copy: undefined };
  const params: MiddlewareParams = {
    __proto__: MIDDLEWARE_PARAMS_PROTOTYPE,
    model,
    action,
    get args(): Record<string, unknown> {
      if (state.copy === undefined) state.copy = copyArgs(args, 0) as Record<string, unknown>;
      return state.copy;
    },
    set args(_replacement: Record<string, unknown>) {
      throw argsRewriteError(model, action, 'args');
    },
  } as MiddlewareParams;
  MIDDLEWARE_ARGS.set(params, state);
  return params;
}

/**
 * Refuse a `next(p)` whose `p.args` is not the caller's args: one that
 * middleware changed in place, or replaced with an object that differs from
 * them. A copy that is structurally equal passes (`structuredClone(params.args)`,
 * `{ ...params.args }`), because nothing it would change is lost. Throws a
 * TypeError naming the first path that differs.
 */
export function assertMiddlewareArgsKept(handedOut: MiddlewareParams, passed: { args?: unknown } | undefined): void {
  const state = MIDDLEWARE_ARGS.get(handedOut) as MiddlewareArgsState;
  if (passed === handedOut) {
    if (handedOut.model !== state.model) throw argsRewriteError(state.model, state.action, 'model');
    if (handedOut.action !== state.action) throw argsRewriteError(state.model, state.action, 'action');
    // Nothing has read the args, so nothing could have changed them.
    if (state.copy === undefined) return;
  }
  const given = passed?.args;
  if (given === state.original) return;
  const changed = argsDifference(state.original, given, 0);
  if (changed !== undefined) throw argsRewriteError(state.model, state.action, `args${changed}`);
}

/** The fields of a connected node-postgres client a cancel request needs. */
interface CancelTarget {
  processID?: unknown;
  secretKey?: unknown;
  host?: unknown;
  port?: unknown;
  ssl?: unknown;
  sslNegotiation?: unknown;
}

/** The part of node-postgres' `Connection` a cancel request uses. */
interface CancelConnection {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  connect(portOrPath: number | string, host?: string): void;
  requestSsl(): void;
  cancel(processID: number, secretKey: number): void;
  stream?: { destroy?(): void };
}

/** Whether `pool` is a node-postgres `Pool`, whose checkouts are real backend connections. */
export function isNodePostgresPool(pool: unknown): boolean {
  const Pool = (pg as { Pool?: unknown }).Pool;
  return typeof Pool === 'function' && pool instanceof (Pool as new (...args: never[]) => object);
}

/** Standard native pg text rows, including typed proxies over caller-owned pools. */
export function canReadArrayRows(pool: unknown): boolean {
  if (!isNodePostgresPool(pool) || Object.getOwnPropertyDescriptor(pool, 'Client')?.value !== pg.Client) return false;
  const { options, _clients: clients } = pool as { options?: { binary?: boolean } | null; _clients?: unknown };
  // A pool that keeps its options or its connections somewhere else keeps
  // object rows, and so does one holding a slot that is not a connection.
  if (!options || !Array.isArray(clients)) return false;
  return (
    !pg.defaults?.binary &&
    !options.binary &&
    !clients.some((client: { binary?: boolean } | null) => !client || client.binary)
  );
}

/** Whether `client` is a node-postgres connection a cancel request can reach. */
export function canCancelBackend(client: unknown): boolean {
  const c = client as CancelTarget | null;
  return (
    typeof (pg as { Connection?: unknown }).Connection === 'function' &&
    !!c &&
    typeof c.processID === 'number' &&
    typeof c.secretKey === 'number' &&
    (typeof c.port === 'number' || typeof c.port === 'string')
  );
}

/**
 * Ask the server to cancel whatever `client`'s backend is running, with the
 * protocol's CancelRequest: a separate short connection carrying the backend's
 * process id and secret key. No login, no session state, and a pooler forwards
 * it to the right server backend, which `pg_cancel_backend(pid)` through a
 * pooler would not.
 *
 * Resolves `true` once the server has closed the cancel connection, i.e. has
 * signalled the backend; `false` when the request could not be delivered
 * within `waitMs`. A cancel that arrives after the statement finished is
 * ignored by the server.
 */
export function sendCancelRequest(client: unknown, waitMs: number): Promise<boolean> {
  if (!canCancelBackend(client)) return Promise.resolve(false);
  const target = client as CancelTarget;
  const Connection = (pg as unknown as { Connection: new (options: object) => CancelConnection }).Connection;
  return new Promise((resolve) => {
    let con: CancelConnection | undefined;
    let sent = false;
    let done = false;
    const finish = (delivered: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        con?.stream?.destroy?.();
      } catch {
        // already closed
      }
      resolve(delivered);
    };
    const timer = setTimeout(() => finish(false), waitMs);
    try {
      con = new Connection({ ssl: target.ssl, sslNegotiation: target.sslNegotiation });
      const send = (): void => {
        sent = true;
        con?.cancel(target.processID as number, target.secretKey as number);
      };
      con.on('error', () => finish(false));
      con.on('end', () => finish(sent));
      con.on('connect', () => {
        if (!target.ssl) send();
        else if (target.sslNegotiation !== 'direct') con?.requestSsl();
      });
      con.on('sslconnect', send);
      const host = typeof target.host === 'string' ? target.host : undefined;
      if (host?.startsWith('/')) con.connect(`${host}/.s.PGSQL.${String(target.port)}`);
      else con.connect(target.port as number, host);
    } catch {
      finish(false);
    }
  });
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

const COLON_CHAR = 58;
const PLUS_CHAR = 43;
const MINUS_CHAR = 45;

/** `0`-`9` as a char code. */
function isDigitCode(code: number): boolean {
  return code >= 48 && code <= 57;
}

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
  const date = parseDbDateCommon(value);
  // The shapes JS cannot parse (a BC year, an offset with seconds, a year past
  // 9999) come out invalid; only those pay for the general parse.
  return Number.isNaN(date.getTime()) ? (parseDbDateGeneral(value) ?? date) : date;
}

function parseDbDateCommon(value: string): Date {
  // Fast path for the shape `timestamptz` arrives in, a trailing `±HH:MM`
  // offset (`2026-07-07T17:15:41.896+00:00`). It is exactly the general path's
  // answer for that shape, not an approximation of it: the string contains a
  // ':' (at length-3), TZ_SUFFIX_RE matches, and neither normalizing replace
  // below can fire (the first needs four digits after the sign, the second two
  // digits at the very end after it), so that path also ends in
  // `new Date(value)`. All six offset characters are checked, so a near miss
  // (`+0a:00`, `05:30` without a sign) still takes the general path. It skips
  // one regex test and two regex replaces per value, which on a nested read is
  // the single largest cost in the decode. The invalid-date fallback in
  // parseDbDate still runs on the result, so a BC or five-digit year is
  // unchanged.
  const n = value.length;
  if (n >= 6 && value.charCodeAt(n - 3) === COLON_CHAR) {
    const sign = value.charCodeAt(n - 6);
    if (
      (sign === PLUS_CHAR || sign === MINUS_CHAR) &&
      isDigitCode(value.charCodeAt(n - 5)) &&
      isDigitCode(value.charCodeAt(n - 4)) &&
      isDigitCode(value.charCodeAt(n - 2)) &&
      isDigitCode(value.charCodeAt(n - 1))
    ) {
      return new Date(value);
    }
  }
  // Date-only values (`2026-07-07`, from `date` columns in json_agg output)
  // have no time to zone-pin, and their `-07` tail must not be read as an
  // offset. JS parses bare ISO dates as UTC midnight already. A terminal Z
  // also takes new Date unchanged: neither offset-normalizing replace below
  // can match it. Keep parseDbDate's invalid-date fallback on both paths.
  if (!value.includes(':') || value.endsWith('Z')) return new Date(value);
  if (TZ_SUFFIX_RE.test(value)) {
    // JS Date can't parse colon-less (`-0430`) or bare-hour (`+02`) offsets -
    // normalize both to `±HH:MM`. Postgres emits the bare-hour form for
    // whole-hour zones in some text outputs.
    return new Date(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2').replace(/([+-]\d{2})$/, '$1:00'));
  }
  // normalize `YYYY-MM-DD HH:MM:SS` (driver form) to ISO before pinning UTC
  return new Date(`${value.replace(' ', 'T')}Z`);
}

const DB_DATE_GENERAL_RE =
  /^(\d{4,})-(\d\d)-(\d\d)(?:[T ](\d\d):(\d\d):(\d\d)(\.\d+)?)?(?:(Z)|([+-])(\d\d)(?::?(\d\d))?(?::?(\d\d))?)?( BC)?$/;

/**
 * The Postgres renderings JS `Date` cannot parse: a ` BC` suffix, a
 * local-mean-time offset with seconds (`-04:56:02`, any zone before about
 * 1900), and years of five or more digits. Offset-less text is read as UTC,
 * as in {@link parseDbDate}. `undefined` when the text is none of these.
 */
function parseDbDateGeneral(value: string): Date | undefined {
  const m = DB_DATE_GENERAL_RE.exec(value);
  if (!m) return undefined;
  let year = Number(m[1]);
  if (m[13]) year = 1 - year;
  const month = Number(m[2]) - 1;
  const ms = m[7] ? Math.trunc(1000 * Number(`0${m[7]}`)) : 0;
  const date = new Date(
    Date.UTC(2000, month, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0), ms),
  );
  // setUTCFullYear, not Date.UTC: Date.UTC reads years 0-99 as 1900-1999.
  date.setUTCFullYear(year, month, Number(m[3]));
  if (m[9]) {
    const offset = Number(m[10]) * 3600 + Number(m[11] ?? 0) * 60 + Number(m[12] ?? 0);
    return new Date(date.getTime() - (m[9] === '-' ? -offset : offset) * 1000);
  }
  return date;
}

/**
 * Per-cell decode work in a row decode plan (`RowDecodePlan` in builder.ts).
 * Defined here rather than in builder.ts because the positional nested-row
 * plan in relations.ts reads the same codes, and relations.ts cannot import
 * builder.ts.
 */
export const CELL_PLAIN = 0;
export const CELL_TEMPORAL = 1;
export const CELL_FLOAT = 2;
export const CELL_FLOAT_ARRAY = 3;
export const CELL_TEXT_ARRAY = 4;
/** The dialect's own decode for a type whose storage differs (see `Dialect.decodeColumnValue`). */
export const CELL_DIALECT = 5;

/**
 * A float column's value as the driver reads it. JSON has no NaN or infinity,
 * so `json_build_object` renders them as the strings "NaN", "Infinity" and
 * "-Infinity"; every other value passes through.
 */
export function readJsonFloat(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value === 'NaN') return Number.NaN;
  if (value === 'Infinity') return Number.POSITIVE_INFINITY;
  if (value === '-Infinity') return Number.NEGATIVE_INFINITY;
  return value;
}

/** {@link readJsonFloat} over a float array (at any depth); the input when nothing changes. */
export function readJsonFloatArray(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  let out: unknown[] | undefined;
  for (let i = 0; i < value.length; i++) {
    const el = value[i];
    const read = Array.isArray(el) ? readJsonFloatArray(el) : readJsonFloat(el);
    if (read !== el) {
      out ??= value.slice();
      out[i] = read;
    }
  }
  return out ?? value;
}

let textArrayParser: QueryDriver['types']['arrayParser'] | undefined;

/**
 * An array column the driver has no parser for (an enum array) arrives as
 * Postgres array text, `{ok,sad}`; read it into an array of strings, as the
 * same column reads through a relation. The input when it cannot be parsed.
 */
export function readTextArray(value: unknown): unknown {
  if (typeof value !== 'string' || value.charCodeAt(0) !== 123) return value;
  try {
    textArrayParser ??= pg.types.arrayParser;
    return textArrayParser.create(value).parse() ?? value;
  } catch {
    return value;
  }
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
  // Containment only between names of 3+ characters: `id` sits inside almost
  // any name, so `tenentId` must reach `tenantId` by edit distance instead.
  if (Math.min(a.length, b.length) >= 3 && (a.includes(b) || b.includes(a))) {
    return 500 + Math.min(a.length, b.length);
  }
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
 * the other fourteen use the same function, so the next one cannot get it
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
 * Advice (`diagnostics.advice`) for a sort/grouping term Turbine dropped as redundant
 * (`filters.ts` `dedupeOrderEntries` / `dedupeColumnList`).
 *
 * Deliberately a WARNING and not an error, and deliberately not silent either.
 * The dropped term provably cannot change a result, so failing the query would
 * be a false alarm on a shape correct code produces (a caller-chosen sort key
 * plus an unconditional primary-key tiebreak, which collide exactly when the
 * caller sorts by the primary key). But a caller who wrote the duplicate by
 * hand, or who believes a second key is doing something, should hear about it
 * once. Advice for the usual reason: it describes the QUERY the application
 * sends, which does not vary with the environment, so a production process
 * learns nothing from repeating it. The caller passes its advice logger, or
 * `undefined` when advice is off.
 *
 * Keyed per dropped key, so a sort assembled per request from the same UI says
 * it once rather than once per request.
 */
export function warnRedundantSortTerm(
  advice: TurbineLogger | undefined,
  table: string,
  clause: string,
  dropped: readonly { key: string; first: string; resolved: string }[],
): void {
  if (!advice) return;
  for (const d of dropped) {
    if (!shouldWarnOnce(WARN_NS.redundantSortTerm, `${table}|${clause}|${d.key}`)) continue;
    const how =
      d.first === d.key
        ? `"${d.key}" is named twice`
        : `"${d.key}" and the earlier "${d.first}" both target ${d.resolved}`;
    logTo(
      advice,
      'warn',
      `${clause} on table "${table}": ${how}, so the later one was dropped. It could not have ` +
        'changed the result (the earlier term already orders those rows), and dropping it keeps the query on ' +
        'a shared prepared statement. Remove it to silence this.',
      { code: 'redundant-sort-term', table, clause, key: d.key },
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
