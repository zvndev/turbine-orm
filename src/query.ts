/**
 * turbine-orm — Query builder
 *
 * Each table accessor (db.users, db.posts, etc.) returns a QueryInterface<T>
 * that builds parameterized SQL and executes it through the connection pool.
 *
 * Nested relations use json_build_object + json_agg subqueries for single-query
 * resolution — a PostgreSQL-native approach that eliminates N+1 query patterns.
 *
 * Schema-driven: all column names, types, and relations come from introspected
 * metadata — nothing is hardcoded.
 */

import type pg from 'pg';
import {
  CircularRelationError,
  NotFoundError,
  RelationError,
  TimeoutError,
  ValidationError,
  wrapPgError,
} from './errors.js';
import type { RelationDef, SchemaMetadata, TableMetadata } from './schema.js';
import { camelToSnake, snakeToCamel } from './schema.js';

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
function escSingleQuote(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * Escape LIKE pattern metacharacters: %, _, and \.
 * Must be used with `ESCAPE '\'` in the LIKE clause.
 */
function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

// ---------------------------------------------------------------------------
// Public query argument types
// ---------------------------------------------------------------------------

export type OrderDirection = 'asc' | 'desc';

/** Operator object for advanced where filtering */
export interface WhereOperator<V = unknown> {
  gt?: V;
  gte?: V;
  lt?: V;
  lte?: V;
  not?: V | null;
  in?: V[];
  notIn?: V[];
  contains?: string;
  startsWith?: string;
  endsWith?: string;
  /** Set to 'insensitive' to use ILIKE instead of LIKE for string comparisons */
  mode?: 'default' | 'insensitive';
}

/** Known operator keys — used to detect operator objects vs plain values */
const OPERATOR_KEYS = new Set<string>([
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

/** Check if a value is a where operator object (has at least one known operator key) */
function isWhereOperator(value: unknown): value is WhereOperator {
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
 * A where value can be:
 * - A plain value (equality: column = $N)
 * - null (column IS NULL)
 * - An operator object ({ gt: 5, lte: 10 })
 * - A JSONB filter object ({ contains, equals, path, hasKey })
 * - An array filter object ({ has, hasEvery, hasSome, isEmpty })
 */
export type WhereValue<V = unknown> = V | WhereOperator<V> | JsonFilter | ArrayFilter | null;

/**
 * Where clause type: each field can be a plain value, null, or operator object.
 * Special keys: OR for disjunctive conditions.
 * Relation names can be used with some/every/none sub-filters.
 */
export type WhereClause<T> = {
  [K in keyof T]?: WhereValue<T[K]>;
} & {
  OR?: WhereClause<T>[];
  AND?: WhereClause<T>[];
  NOT?: WhereClause<T>;
  /** Relation filters — keyed by relation name, value is { some, every, none } */
  [relationName: string]: unknown;
};

/**
 * Unparameterized with clause — accepts any relation name.
 * Used internally by the query builder at runtime.
 */
export interface WithClause {
  [relation: string]: true | WithOptions;
}

/**
 * Relation-aware with clause. When R (the relations map) is provided,
 * only keys from R are autocompleted. Used in public method signatures
 * so the compiler can narrow the return type.
 *
 * For typed maps, each relation accepts either `true` (default include) or a
 * {@link WithOptions} object whose nested `with` is keyed against the relation
 * target's own relations interface — this is what enables deep
 * `WithResult` inference.
 */
export type TypedWithClause<R extends object = {}> = [keyof R] extends [never]
  ? WithClause
  : {
      [K in keyof R]?: true | WithOptions<RelationRelations<R[K]> & object>;
    };

/**
 * Options for an included relation.
 *
 * Generic over `NestedR` — the relations interface of the *target* entity —
 * so the nested `with` clause is autocompleted with the correct relation keys
 * and so {@link WithResult} can recursively infer the return type. Defaults to
 * `{}` (no relation suggestions) for callers that use the unparameterized
 * {@link WithClause}.
 */
export interface WithOptions<NestedR extends object = {}> {
  with?: TypedWithClause<NestedR>;
  where?: Record<string, unknown>;
  orderBy?: Record<string, OrderDirection>;
  limit?: number;
  /** Only include these fields from the relation */
  select?: Record<string, boolean>;
  /** Exclude these fields from the relation */
  omit?: Record<string, boolean>;
}

// ---------------------------------------------------------------------------
// WithResult — compute return type based on included relations (recursive)
// ---------------------------------------------------------------------------

/**
 * A relation descriptor used by generated `*Relations` interfaces to make deep
 * `with` clause inference work. It bundles three pieces of information that
 * `WithResult` needs to recurse through nested relations:
 *
 *  - `__target`     — the target entity type (e.g. `Post`)
 *  - `__cardinality`— `'many'` for hasMany, `'one'` for belongsTo / hasOne
 *  - `__relations`  — the target entity's relations interface (for further recursion)
 *
 * **Generator contract (Track 3):** the code generator emits `*Relations`
 * interfaces in the following shape so that `WithResult` can walk arbitrary
 * nesting depth:
 *
 * ```ts
 * export interface UserRelations {
 *   posts:   RelationDescriptor<Post,    'many', PostRelations>;
 *   profile: RelationDescriptor<Profile, 'one',  ProfileRelations>;
 * }
 * ```
 *
 * The brand fields are phantom — they exist only for type inference and have
 * no runtime representation. The runtime always sees the parsed entity values
 * (arrays for hasMany, single object or null for belongsTo / hasOne) — see the
 * cardinality projection inside {@link WithResult}.
 *
 * **Backward compatibility:** legacy generated code emitted bare types
 * (`posts: Post[]`, `profile: Profile | null`). `WithResult` still accepts that
 * shape via a fallback branch — it just cannot recurse into nested `with` for
 * those relations until the generator is updated.
 *
 * @typeParam Target      - The entity type the relation points at.
 * @typeParam Cardinality - `'many'` (array) or `'one'` (single object | null).
 * @typeParam Relations   - The target entity's own `*Relations` interface, or
 *                          `{}` if the target has no relations of its own.
 */
export interface RelationDescriptor<Target, Cardinality extends 'one' | 'many', Relations extends object = {}> {
  readonly __target?: Target;
  readonly __cardinality?: Cardinality;
  readonly __relations?: Relations;
}

/** Extract the target entity from a relation descriptor or bare relation type. */
type RelationTarget<Rel> =
  Rel extends RelationDescriptor<infer Target, infer _C, infer _R>
    ? Target
    : Rel extends Array<infer Item>
      ? Item
      : Rel extends infer One | null
        ? One
        : Rel;

/** Extract the target's relations map from a relation descriptor (or `{}` for bare types). */
type RelationRelations<Rel> = Rel extends RelationDescriptor<infer _T, infer _C, infer R> ? R : {};

/** Project the target type into its runtime shape (array for many, single for one). */
type ApplyCardinality<Rel, Resolved> =
  Rel extends RelationDescriptor<infer _T, infer Cardinality, infer _R>
    ? Cardinality extends 'many'
      ? Resolved[]
      : Resolved | null
    : Rel extends Array<infer _Item>
      ? Resolved[]
      : Resolved | null;

/**
 * Compute the result type when relations are included via `with`.
 *
 * Recursively walks the `with` clause, looking up each relation in `R` and:
 *
 *  1. If the relation is included with `true` (or no nested `with`), the
 *     relation's bare resolved type is grafted onto `T` (e.g. `posts: Post[]`).
 *  2. If the relation is included with a nested `with: {...}`, the recursion
 *     looks up the target entity's relations interface (via the
 *     {@link RelationDescriptor} brand fields the generator emits) and
 *     recursively applies `WithResult` to the nested target. Cardinality is
 *     re-applied at each level so a hasMany relation stays an array even after
 *     deep nesting.
 *
 * **When `R` is `{}` (the default):** the recursion short-circuits and the
 * function returns plain `T` — preserving the existing untyped escape hatch
 * for callers that have not generated typed clients.
 *
 * **When `R` does not contain the requested relations:** the unknown keys are
 * ignored (the runtime will throw a `RelationError`, but the type system stays
 * permissive so the legacy `WithClause` index signature still typechecks).
 *
 * @typeParam T - Base entity type (e.g. `User`).
 * @typeParam R - Relations map for `T` (e.g.
 *                `{ posts: RelationDescriptor<Post, 'many', PostRelations>; ... }`).
 *                Legacy bare shapes (`{ posts: Post[]; profile: Profile | null }`)
 *                are also accepted, but cannot recurse beyond one level.
 * @typeParam W - The `with` clause the user passed (e.g. `{ posts: true }` or
 *                `{ posts: { with: { comments: true } } }`).
 */
export type WithResult<T, R extends object, W> = [keyof R] extends [never]
  ? T
  : W extends object
    ? [keyof W & keyof R] extends [never]
      ? T
      : T & {
          [K in keyof W & keyof R]: W[K] extends true
            ? // Leaf inclusion — no further `with`. Project the relation's runtime shape.
              ApplyCardinality<R[K], RelationTarget<R[K]>>
            : W[K] extends { with?: infer NestedW }
              ? NestedW extends object
                ? // Recursive case — drill into the target's relations map.
                  ApplyCardinality<R[K], WithResult<RelationTarget<R[K]>, RelationRelations<R[K]> & object, NestedW>>
                : // `with` was passed but is not an object literal — treat as leaf.
                  ApplyCardinality<R[K], RelationTarget<R[K]>>
              : // `WithOptions` was passed without a nested `with` — treat as leaf.
                ApplyCardinality<R[K], RelationTarget<R[K]>>;
        }
    : T;

export interface FindUniqueArgs<T, R extends object = {}, W extends TypedWithClause<R> = TypedWithClause<R>> {
  where: WhereClause<T>;
  select?: Record<string, boolean>;
  omit?: Record<string, boolean>;
  with?: W;
  /** Query timeout in milliseconds. Rejects with an error if exceeded. */
  timeout?: number;
}

export interface FindManyArgs<T, R extends object = {}, W extends TypedWithClause<R> = TypedWithClause<R>> {
  where?: WhereClause<T>;
  select?: Record<string, boolean>;
  omit?: Record<string, boolean>;
  orderBy?: Record<string, OrderDirection>;
  limit?: number;
  offset?: number;
  with?: W;
  /** Cursor-based pagination: start after this row */
  cursor?: Partial<T>;
  /** Number of records to take (used with cursor) */
  take?: number;
  /** De-duplicate results by specified fields */
  distinct?: (keyof T & string)[];
  /** Query timeout in milliseconds. Rejects with an error if exceeded. */
  timeout?: number;
}

export interface FindManyStreamArgs<T, R extends object = {}, W extends TypedWithClause<R> = TypedWithClause<R>>
  extends FindManyArgs<T, R, W> {
  /** Number of rows to fetch per internal FETCH batch (default: 100) */
  batchSize?: number;
}

export interface CreateArgs<T> {
  data: Partial<T>;
  /** Query timeout in milliseconds. Rejects with an error if exceeded. */
  timeout?: number;
}

export interface CreateManyArgs<T> {
  data: Partial<T>[];
  /** When true, adds ON CONFLICT DO NOTHING to skip duplicate rows */
  skipDuplicates?: boolean;
  /** Query timeout in milliseconds. Rejects with an error if exceeded. */
  timeout?: number;
}

/**
 * Atomic update operators for a field.
 *
 * `set` works on any type; `increment`, `decrement`, `multiply`, and `divide`
 * are only valid on numeric fields. They generate SQL like
 * `col = col + $n` (and the corresponding `-`, `*`, `/` variants) instead of
 * plain absolute assignments, so they are safe against concurrent writers —
 * the database performs the math atomically.
 *
 * @example
 *   db.posts.update({ where: { id: 5 }, data: { viewCount: { increment: 1 } } });
 */
export type UpdateOperatorInput<V> =
  | { set: V }
  | (V extends number ? { increment: number } : never)
  | (V extends number ? { decrement: number } : never)
  | (V extends number ? { multiply: number } : never)
  | (V extends number ? { divide: number } : never);

/**
 * Update data — each field can be a plain value or an atomic operator object.
 * Back-compatible with `Partial<T>`: plain values still typecheck unchanged.
 */
export type UpdateInput<T> = {
  [K in keyof T]?: T[K] | UpdateOperatorInput<T[K]>;
};

/** Known atomic-update operator keys — used to detect operator objects vs plain JSON values */
const UPDATE_OPERATOR_KEYS = new Set<string>(['set', 'increment', 'decrement', 'multiply', 'divide']);

export interface UpdateArgs<T> {
  where: WhereClause<T>;
  data: UpdateInput<T>;
  /** Query timeout in milliseconds. Rejects with an error if exceeded. */
  timeout?: number;
  /**
   * Opt in to running this mutation when `where` resolves to an empty
   * predicate (e.g. `{}` or `{ id: undefined }`). Default `false` — an
   * empty predicate throws `ValidationError` to catch the common case of
   * a filter value accidentally being `undefined`. Set this to `true` only
   * when an unconditional mutation is the intended behaviour.
   */
  allowFullTableScan?: boolean;
}

export interface UpdateManyArgs<T> {
  where: WhereClause<T>;
  data: UpdateInput<T>;
  /** Query timeout in milliseconds. Rejects with an error if exceeded. */
  timeout?: number;
  /** See {@link UpdateArgs.allowFullTableScan}. */
  allowFullTableScan?: boolean;
}

export interface DeleteArgs<T> {
  where: WhereClause<T>;
  /** Query timeout in milliseconds. Rejects with an error if exceeded. */
  timeout?: number;
  /** See {@link UpdateArgs.allowFullTableScan}. */
  allowFullTableScan?: boolean;
}

export interface DeleteManyArgs<T> {
  where: WhereClause<T>;
  /** Query timeout in milliseconds. Rejects with an error if exceeded. */
  timeout?: number;
  /** See {@link UpdateArgs.allowFullTableScan}. */
  allowFullTableScan?: boolean;
}

export interface UpsertArgs<T> {
  where: WhereClause<T>;
  create: Partial<T>;
  update: Partial<T>;
  /** Query timeout in milliseconds. Rejects with an error if exceeded. */
  timeout?: number;
}

export interface CountArgs<T> {
  where?: WhereClause<T>;
  /** Query timeout in milliseconds. Rejects with an error if exceeded. */
  timeout?: number;
}

export interface GroupByArgs<T> {
  by: (keyof T & string)[];
  where?: WhereClause<T>;
  /** Include count of each group */
  _count?: true;
  /** Sum of numeric fields in each group */
  _sum?: Partial<Record<keyof T & string, boolean>>;
  /** Average of numeric fields in each group */
  _avg?: Partial<Record<keyof T & string, boolean>>;
  /** Minimum value of fields in each group */
  _min?: Partial<Record<keyof T & string, boolean>>;
  /** Maximum value of fields in each group */
  _max?: Partial<Record<keyof T & string, boolean>>;
  /** Order groups */
  orderBy?: Record<string, OrderDirection>;
  /** Query timeout in milliseconds. Rejects with an error if exceeded. */
  timeout?: number;
}

/** Arguments for the standalone aggregate method */
export interface AggregateArgs<T> {
  where?: WhereClause<T>;
  /** Count all rows matching the filter */
  _count?: true | Partial<Record<keyof T & string, boolean>>;
  /** Sum of numeric fields */
  _sum?: Partial<Record<keyof T & string, boolean>>;
  /** Average of numeric fields */
  _avg?: Partial<Record<keyof T & string, boolean>>;
  /** Minimum value of fields */
  _min?: Partial<Record<keyof T & string, boolean>>;
  /** Maximum value of fields */
  _max?: Partial<Record<keyof T & string, boolean>>;
  /** Query timeout in milliseconds. Rejects with an error if exceeded. */
  timeout?: number;
}

/** Result type for aggregate queries */
export interface AggregateResult<T> {
  _count?: number | Record<string, number>;
  _sum?: Partial<Record<keyof T & string, number | null>>;
  _avg?: Partial<Record<keyof T & string, number | null>>;
  _min?: Partial<Record<keyof T & string, unknown>>;
  _max?: Partial<Record<keyof T & string, unknown>>;
}

/** Relation filter operators for where clauses */
export interface RelationFilter {
  some?: Record<string, unknown>;
  every?: Record<string, unknown>;
  none?: Record<string, unknown>;
}

/** JSONB query operators for where clauses */
export interface JsonFilter {
  /** Access nested path via #>> operator */
  path?: string[];
  /** Exact match: column @> value::jsonb (containment) */
  equals?: unknown;
  /** Containment check: column @> value::jsonb */
  contains?: unknown;
  /** Key existence check: column ? key */
  hasKey?: string;
}

/** Known JSONB operator keys */
const JSONB_OPERATOR_KEYS = new Set<string>(['path', 'equals', 'contains', 'hasKey']);

/**
 * JSONB operator keys that are *unique* to {@link JsonFilter} — they cannot
 * appear in any other where-filter shape, so the presence of one of these is
 * an unambiguous signal that the user meant a JSON filter. Used by the
 * strict-validation path so that `{ contains: 'foo' }` (which is also a valid
 * `WhereOperator` for LIKE) is not misclassified.
 */
const JSONB_UNIQUE_KEYS = new Set<string>(['path', 'equals', 'hasKey']);

/** Check if a value is a JSONB filter object */
function isJsonFilter(value: unknown): value is JsonFilter {
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
function findJsonUniqueKey(value: object): string | null {
  for (const k of Object.keys(value)) {
    if (JSONB_UNIQUE_KEYS.has(k)) return k;
  }
  return null;
}

/** Array query operators for where clauses */
export interface ArrayFilter {
  /** Check if array contains a single value: value = ANY(column) */
  has?: unknown;
  /** Check if array contains ALL values: column @> ARRAY[...] */
  hasEvery?: unknown[];
  /** Check if array has ANY of the values: column && ARRAY[...] */
  hasSome?: unknown[];
  /** Check if array is empty: array_length(column, 1) IS NULL */
  isEmpty?: boolean;
}

/** Known Array operator keys */
const ARRAY_OPERATOR_KEYS = new Set<string>(['has', 'hasEvery', 'hasSome', 'isEmpty']);

/**
 * Array operator keys that are *unique* to {@link ArrayFilter}. None of the
 * array operators currently overlap with `WhereOperator` or `JsonFilter`, so
 * this set equals {@link ARRAY_OPERATOR_KEYS}; it is kept as a separate
 * constant so a future overlap (e.g. a `contains` for arrays) is easy to
 * carve out.
 */
const ARRAY_UNIQUE_KEYS = new Set<string>(['has', 'hasEvery', 'hasSome', 'isEmpty']);

/** Check if a value is an Array filter object */
function isArrayFilter(value: unknown): value is ArrayFilter {
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
function findArrayUniqueKey(value: object): string | null {
  for (const k of Object.keys(value)) {
    if (ARRAY_UNIQUE_KEYS.has(k)) return k;
  }
  return null;
}

// ---------------------------------------------------------------------------
// LRU cache — bounded SQL template cache to prevent memory leaks
// ---------------------------------------------------------------------------

/**
 * Simple LRU (Least Recently Used) cache with a fixed maximum size.
 * When the cache exceeds maxSize, the oldest (least recently used) entry is evicted.
 * Uses Map insertion order for O(1) eviction.
 */
class LRUCache<K, V> {
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
// Deferred query descriptor (for pipeline batching)
// ---------------------------------------------------------------------------

export interface DeferredQuery<T> {
  /** SQL text with $1, $2 placeholders */
  sql: string;
  /** Bound parameter values */
  params: unknown[];
  /** How to transform the raw pg.QueryResult into the final value */
  transform: (result: pg.QueryResult) => T;
  /** Tag for debugging / logging */
  tag: string;
}

// ---------------------------------------------------------------------------
// QueryInterface — the object returned by db.users, db.posts, etc.
// ---------------------------------------------------------------------------

/** Middleware function type — imported from client to avoid circular deps */
type MiddlewareFn = (
  params: { model: string; action: string; args: Record<string, unknown> },
  next: (params: { model: string; action: string; args: Record<string, unknown> }) => Promise<unknown>,
) => Promise<unknown>;

/** Options passed from TurbineClient to QueryInterface */
export interface QueryInterfaceOptions {
  /** Default LIMIT applied to findMany() when no limit is specified */
  defaultLimit?: number;
  /**
   * Log a one-time warning when {@link QueryInterface.findMany} is called
   * without a `limit`. Defaults to `true` so that accidental unbounded
   * queries are surfaced loudly during development. Pass `false` to silence
   * the warning entirely (e.g. for CLI tooling that intentionally streams
   * full tables).
   */
  warnOnUnlimited?: boolean;
}

export class QueryInterface<T extends object, R extends object = {}> {
  private readonly tableMeta: TableMetadata;
  /** SQL template cache: cacheKey → sql string (params are always positional $1,$2,...) */
  private readonly sqlCache = new LRUCache<string, string>(1000);
  private readonly middlewares: MiddlewareFn[];
  private readonly defaultLimit?: number;
  private readonly warnOnUnlimited: boolean;
  /**
   * Tracks tables that have already triggered an unlimited-query warning so
   * the user is not spammed once per row. Per-instance state — each
   * QueryInterface is bound to a single table, so this set will only ever
   * contain at most one entry, but using a Set keeps the API consistent with
   * the audit's "Set<string>" guidance and leaves room for future
   * cross-table sharing.
   */
  private readonly warnedTables = new Set<string>();

  /** Pre-computed column type lookups (avoids linear scans per query) */
  private readonly columnPgTypeMap: Map<string, string>;
  private readonly columnArrayTypeMap: Map<string, string>;

  constructor(
    private readonly pool: pg.Pool,
    private readonly table: string,
    private readonly schema: SchemaMetadata,
    middlewares?: MiddlewareFn[],
    options?: QueryInterfaceOptions,
  ) {
    const meta = schema.tables[table];
    if (!meta) {
      throw new ValidationError(
        `[turbine] Unknown table "${table}". Available: ${Object.keys(schema.tables).join(', ')}`,
      );
    }
    this.tableMeta = meta;
    this.middlewares = middlewares ?? [];
    this.defaultLimit = options?.defaultLimit;
    // Default to ON: surfacing accidental full-table scans is more valuable
    // than the (small) risk of noisy logs. Callers explicitly opt out with
    // `warnOnUnlimited: false`.
    this.warnOnUnlimited = options?.warnOnUnlimited !== false;

    // Pre-compute column type lookup maps (TASK-26)
    this.columnPgTypeMap = new Map();
    this.columnArrayTypeMap = new Map();
    for (const col of this.tableMeta.columns) {
      this.columnPgTypeMap.set(col.name, col.pgType);
      this.columnArrayTypeMap.set(col.name, col.pgArrayType);
    }
  }

  /**
   * Reset the per-instance unlimited-query warning dedupe set.
   * Exposed for tests so a single test process can verify the warning fires
   * exactly once per table without bleeding state between assertions.
   */
  resetUnlimitedWarnings(): void {
    this.warnedTables.clear();
  }

  /**
   * Execute a pool.query with an optional timeout.
   * If timeout is set, races the query against a timer and rejects on expiry.
   * pg driver errors are translated to typed Turbine errors via wrapPgError.
   */
  private async queryWithTimeout(sql: string, params: unknown[], timeout?: number): Promise<pg.QueryResult> {
    if (!timeout) {
      try {
        return await this.pool.query(sql, params);
      } catch (err) {
        throw wrapPgError(err);
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(timeout)), timeout);
    });
    try {
      return await Promise.race([this.pool.query(sql, params), timeoutPromise]);
    } catch (err) {
      throw wrapPgError(err);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Execute a query through the middleware chain.
   * If no middlewares are registered, executes directly.
   *
   * Middleware can inspect and log query parameters, modify results after execution,
   * and measure timing. Note: query SQL is generated before middleware runs, so
   * modifying params.args in middleware will NOT affect the executed SQL.
   * To intercept queries before SQL generation, use the raw() method instead.
   */
  private async executeWithMiddleware<R>(
    action: string,
    args: Record<string, unknown>,
    executor: () => Promise<R>,
  ): Promise<R> {
    if (this.middlewares.length === 0) {
      return executor();
    }

    const params = { model: this.table, action, args: { ...args } };

    // Build middleware chain
    let index = 0;
    const next = async (p: { model: string; action: string; args: Record<string, unknown> }): Promise<unknown> => {
      if (index < this.middlewares.length) {
        const mw = this.middlewares[index++]!;
        return mw(p, next);
      }
      // End of chain — execute the actual query
      return executor();
    };

    return next(params) as Promise<R>;
  }

  // -------------------------------------------------------------------------
  // findUnique
  // -------------------------------------------------------------------------

  async findUnique<W extends TypedWithClause<R> = {}>(
    args: FindUniqueArgs<T, R, W>,
  ): Promise<WithResult<T, R, W> | null> {
    return this.executeWithMiddleware('findUnique', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildFindUnique(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args.timeout);
      return deferred.transform(result);
    }) as Promise<WithResult<T, R, W> | null>;
  }

  buildFindUnique<W extends TypedWithClause<R> = {}>(args: FindUniqueArgs<T, R, W>): DeferredQuery<T | null> {
    const columnsList = this.resolveColumns(args.select, args.omit);
    const whereObj = args.where as Record<string, unknown>;

    // Check if all where values are simple (plain equality, no operators/null/OR)
    const whereKeys = Object.keys(whereObj).filter((k) => whereObj[k] !== undefined);
    const isSimpleWhere =
      !whereObj.OR &&
      whereKeys.every((k) => {
        const v = whereObj[k];
        return v !== null && !isWhereOperator(v);
      });

    // For simple queries (no nested with, no operators), use cached SQL template
    if (!args.with && isSimpleWhere) {
      const colKey = columnsList ? columnsList.join(',') : '*';
      const ck = `fu:${whereKeys.sort().join(',')}:c=${colKey}`;
      let sql = this.sqlCache.get(ck);
      const params: unknown[] = whereKeys.map((k) => whereObj[k]);

      if (!sql) {
        const qt = quoteIdent(this.table);
        const whereClauses = whereKeys.map((k, i) => `${this.toSqlColumn(k)} = $${i + 1}`);
        const whereSql = whereClauses.length > 0 ? ` WHERE ${whereClauses.join(' AND ')}` : '';
        const selectExpr = columnsList ? columnsList.map((c) => `${qt}.${quoteIdent(c)}`).join(', ') : `${qt}.*`;
        sql = `SELECT ${selectExpr} FROM ${qt}${whereSql} LIMIT 1`;
        this.sqlCache.set(ck, sql);
      }

      return {
        sql,
        params,
        transform: (result) => {
          const row = result.rows[0];
          return row ? (this.parseRow(row, this.table) as T) : null;
        },
        tag: `${this.table}.findUnique`,
      };
    }

    // General path: supports operators, null, OR, nested with
    const { sql: whereSql, params } = this.buildWhere(args.where);

    if (!args.with) {
      const qt = quoteIdent(this.table);
      const selectExpr = columnsList ? columnsList.map((c) => `${qt}.${quoteIdent(c)}`).join(', ') : `${qt}.*`;
      const sql = `SELECT ${selectExpr} FROM ${qt}${whereSql} LIMIT 1`;
      return {
        sql,
        params,
        transform: (result) => {
          const row = result.rows[0];
          return row ? (this.parseRow(row, this.table) as T) : null;
        },
        tag: `${this.table}.findUnique`,
      };
    }

    // Nested queries: build fresh each time (with clause affects params)
    const selectClause = this.buildSelectWithRelations(this.table, args.with as WithClause, params, columnsList);
    const sql = `SELECT ${selectClause} FROM ${quoteIdent(this.table)}${whereSql} LIMIT 1`;

    return {
      sql,
      params,
      transform: (result) => {
        const row = result.rows[0];
        return row ? (this.parseNestedRow(row, this.table) as T) : null;
      },
      tag: `${this.table}.findUnique`,
    };
  }

  // -------------------------------------------------------------------------
  // findMany
  // -------------------------------------------------------------------------

  async findMany<W extends TypedWithClause<R> = {}>(args?: FindManyArgs<T, R, W>): Promise<WithResult<T, R, W>[]> {
    this.maybeWarnUnlimited(args);

    return this.executeWithMiddleware('findMany', (args ?? {}) as Record<string, unknown>, async () => {
      const deferred = this.buildFindMany(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args?.timeout);
      return deferred.transform(result);
    }) as Promise<WithResult<T, R, W>[]>;
  }

  /**
   * Emit a one-time `console.warn` when {@link findMany} is called without an
   * explicit `limit`/`take` and `warnOnUnlimited` has not been disabled.
   *
   * Deduped per QueryInterface instance via {@link warnedTables} so a busy
   * loop calling `db.users.findMany()` thousands of times only logs once.
   * Suppressed when `defaultLimit` is configured (the caller has already
   * opted in to a bounded query) and when the user passed an explicit
   * `limit`, `take`, or `cursor`.
   */
  private maybeWarnUnlimited(args?: { limit?: number; take?: number; cursor?: unknown }): void {
    if (!this.warnOnUnlimited) return;
    if (this.defaultLimit !== undefined) return;
    const hasExplicitLimit = args?.limit !== undefined || args?.take !== undefined || args?.cursor !== undefined;
    if (hasExplicitLimit) return;
    if (this.warnedTables.has(this.table)) return;
    this.warnedTables.add(this.table);
    console.warn(
      `[turbine] warning: findMany on "${this.table}" has no limit — this will fetch every row. ` +
        'Pass `limit` or set `warnOnUnlimited: false` in config to silence.',
    );
  }

  buildFindMany<W extends TypedWithClause<R> = {}>(args?: FindManyArgs<T, R, W>): DeferredQuery<T[]> {
    const { sql: whereSql, params } = args?.where ? this.buildWhere(args.where) : { sql: '', params: [] as unknown[] };

    const columnsList = this.resolveColumns(args?.select, args?.omit);

    const qt = quoteIdent(this.table);

    // Distinct support
    let distinctPrefix = '';
    if (args?.distinct && args.distinct.length > 0) {
      const distinctCols = args.distinct.map((k) => this.toSqlColumn(k as string));
      distinctPrefix = `DISTINCT ON (${distinctCols.join(', ')}) `;
    }

    let selectClause: string;
    if (args?.with) {
      selectClause = this.buildSelectWithRelations(this.table, args.with as WithClause, params, columnsList);
    } else if (columnsList) {
      selectClause = columnsList.map((c) => `${qt}.${quoteIdent(c)}`).join(', ');
    } else {
      selectClause = `${qt}.*`;
    }

    let sql = `SELECT ${distinctPrefix}${selectClause} FROM ${qt}${whereSql}`;

    // Cursor-based pagination: add WHERE condition for cursor
    if (args?.cursor) {
      const cursorEntries = Object.entries(args.cursor as Record<string, unknown>).filter(([, v]) => v !== undefined);
      if (cursorEntries.length > 0) {
        // Determine direction from orderBy (default 'asc')
        const cursorConditions = cursorEntries.map(([k, v]) => {
          const col = this.toSqlColumn(k);
          const dir = args.orderBy?.[k] ?? 'asc';
          const op = dir === 'desc' ? '<' : '>';
          params.push(v);
          return `${qt}.${col} ${op} $${params.length}`;
        });
        // Append to existing WHERE or create new one
        if (whereSql) {
          sql += ` AND ${cursorConditions.join(' AND ')}`;
        } else {
          sql += ` WHERE ${cursorConditions.join(' AND ')}`;
        }
      }
    }

    if (args?.orderBy) {
      sql += ` ORDER BY ${this.buildOrderBy(args.orderBy)}`;
    }

    // take overrides limit when cursor pagination is used; fall back to defaultLimit
    const effectiveLimit = args?.take ?? args?.limit ?? this.defaultLimit;
    if (effectiveLimit !== undefined) {
      params.push(Number(effectiveLimit));
      sql += ` LIMIT $${params.length}`;
    }
    if (args?.offset !== undefined) {
      params.push(Number(args.offset));
      sql += ` OFFSET $${params.length}`;
    }

    return {
      sql,
      params,
      transform: (result) =>
        result.rows.map((row) =>
          args?.with ? (this.parseNestedRow(row, this.table) as T) : (this.parseRow(row, this.table) as T),
        ),
      tag: `${this.table}.findMany`,
    };
  }

  // -------------------------------------------------------------------------
  // findManyStream — async iterable using PostgreSQL cursors
  // -------------------------------------------------------------------------

  /**
   * Stream rows from a findMany query using PostgreSQL cursors.
   * Returns an AsyncIterable that yields individual rows, fetching in batches internally.
   *
   * Uses DECLARE CURSOR within a dedicated transaction on a single pooled connection.
   * The cursor is automatically closed and the connection released when iteration
   * completes or is terminated early (e.g. `break` from `for await`).
   *
   * @example
   * ```ts
   * for await (const user of db.users.findManyStream({ where: { orgId: 1 }, batchSize: 500 })) {
   *   process.stdout.write(`${user.email}\n`);
   * }
   * ```
   */
  async *findManyStream<W extends TypedWithClause<R> = {}>(
    args?: FindManyStreamArgs<T, R, W>,
  ): AsyncGenerator<WithResult<T, R, W>, void, undefined> {
    const batchSize = Math.max(1, Math.floor(Number(args?.batchSize ?? 100)));
    const deferred = this.buildFindMany(args);
    const hasRelations = !!args?.with;

    // Acquire a dedicated connection — cursors require a single connection in a transaction
    const client = await this.pool.connect();
    const cursorName = `turbine_cursor_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const quotedCursor = quoteIdent(cursorName);

    try {
      await client.query('BEGIN');
      await client.query(`DECLARE ${quotedCursor} NO SCROLL CURSOR FOR ${deferred.sql}`, deferred.params);

      while (true) {
        const batch = await client.query(`FETCH ${batchSize} FROM ${quotedCursor}`);
        if (batch.rows.length === 0) break;

        for (const row of batch.rows) {
          yield (hasRelations ? this.parseNestedRow(row, this.table) : this.parseRow(row, this.table)) as WithResult<
            T,
            R,
            W
          >;
        }

        if (batch.rows.length < batchSize) break;
      }

      await client.query(`CLOSE ${quotedCursor}`);
      await client.query('COMMIT');
    } catch (err) {
      // Rollback on error (also closes cursor implicitly)
      try {
        await client.query('ROLLBACK');
      } catch {
        // Connection may already be broken — ignore rollback error
      }
      // Wrap pg constraint errors so streaming surfaces typed errors like the rest of the API
      throw wrapPgError(err);
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // findFirst — like findMany but returns a single row or null
  // -------------------------------------------------------------------------

  async findFirst<W extends TypedWithClause<R> = {}>(
    args?: FindManyArgs<T, R, W>,
  ): Promise<WithResult<T, R, W> | null> {
    return this.executeWithMiddleware('findFirst', (args ?? {}) as Record<string, unknown>, async () => {
      const deferred = this.buildFindFirst(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args?.timeout);
      return deferred.transform(result);
    }) as Promise<WithResult<T, R, W> | null>;
  }

  buildFindFirst<W extends TypedWithClause<R> = {}>(args?: FindManyArgs<T, R, W>): DeferredQuery<T | null> {
    // Reuse findMany's SQL builder but force LIMIT 1
    const findManyArgs: FindManyArgs<T, R, W> = { ...args, limit: 1 };
    const deferred = this.buildFindMany(findManyArgs);

    return {
      sql: deferred.sql,
      params: deferred.params,
      transform: (result) => {
        const rows = deferred.transform(result);
        return rows.length > 0 ? rows[0]! : null;
      },
      tag: `${this.table}.findFirst`,
    };
  }

  // -------------------------------------------------------------------------
  // findFirstOrThrow — like findFirst but throws if no record found
  // -------------------------------------------------------------------------

  async findFirstOrThrow<W extends TypedWithClause<R> = {}>(
    args?: FindManyArgs<T, R, W>,
  ): Promise<WithResult<T, R, W>> {
    return this.executeWithMiddleware('findFirstOrThrow', (args ?? {}) as Record<string, unknown>, async () => {
      const deferred = this.buildFindFirstOrThrow(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args?.timeout);
      return deferred.transform(result);
    }) as Promise<WithResult<T, R, W>>;
  }

  buildFindFirstOrThrow<W extends TypedWithClause<R> = {}>(args?: FindManyArgs<T, R, W>): DeferredQuery<T> {
    const inner = this.buildFindFirst(args);

    return {
      sql: inner.sql,
      params: inner.params,
      transform: (result) => {
        const row = inner.transform(result);
        if (row === null) {
          throw new NotFoundError({
            table: this.table,
            where: args?.where,
            operation: 'findFirstOrThrow',
          });
        }
        return row;
      },
      tag: `${this.table}.findFirstOrThrow`,
    };
  }

  // -------------------------------------------------------------------------
  // findUniqueOrThrow — like findUnique but throws if no record found
  // -------------------------------------------------------------------------

  async findUniqueOrThrow<W extends TypedWithClause<R> = {}>(
    args: FindUniqueArgs<T, R, W>,
  ): Promise<WithResult<T, R, W>> {
    return this.executeWithMiddleware('findUniqueOrThrow', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildFindUniqueOrThrow(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args.timeout);
      return deferred.transform(result);
    }) as Promise<WithResult<T, R, W>>;
  }

  buildFindUniqueOrThrow<W extends TypedWithClause<R> = {}>(args: FindUniqueArgs<T, R, W>): DeferredQuery<T> {
    const inner = this.buildFindUnique(args);

    return {
      sql: inner.sql,
      params: inner.params,
      transform: (result) => {
        const row = inner.transform(result);
        if (row === null) {
          throw new NotFoundError({
            table: this.table,
            where: args.where,
            operation: 'findUniqueOrThrow',
          });
        }
        return row;
      },
      tag: `${this.table}.findUniqueOrThrow`,
    };
  }

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  async create(args: CreateArgs<T>): Promise<T> {
    return this.executeWithMiddleware('create', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildCreate(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args.timeout);
      return deferred.transform(result);
    });
  }

  buildCreate(args: CreateArgs<T>): DeferredQuery<T> {
    const entries = Object.entries(args.data as Record<string, unknown>).filter(([, v]) => v !== undefined);
    const columns = entries.map(([k]) => this.toSqlColumn(k));
    const params = entries.map(([, v]) => v);
    const placeholders = entries.map((_, i) => `$${i + 1}`);

    const sql = `INSERT INTO ${quoteIdent(this.table)} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`;

    return {
      sql,
      params,
      transform: (result) => {
        const row = result.rows[0];
        if (!row) {
          throw new NotFoundError({
            table: this.table,
            operation: 'create',
            message: `[turbine] create on "${this.table}" returned no row from RETURNING * — this should never happen.`,
          });
        }
        return this.parseRow(row, this.table) as T;
      },
      tag: `${this.table}.create`,
    };
  }

  // -------------------------------------------------------------------------
  // createMany — uses UNNEST for performance
  // -------------------------------------------------------------------------

  async createMany(args: CreateManyArgs<T>): Promise<T[]> {
    return this.executeWithMiddleware('createMany', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildCreateMany(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args.timeout);
      return deferred.transform(result);
    });
  }

  buildCreateMany(args: CreateManyArgs<T>): DeferredQuery<T[]> {
    const qt = quoteIdent(this.table);
    if (args.data.length === 0) {
      return {
        sql: `SELECT * FROM ${qt} WHERE false`,
        params: [],
        transform: () => [],
        tag: `${this.table}.createMany`,
      };
    }

    const keys = Object.keys(args.data[0]!).filter((k) => (args.data[0] as Record<string, unknown>)[k] !== undefined);
    const columns = keys.map((k) => this.toColumn(k));

    // Build column arrays for UNNEST
    const columnArrays: unknown[][] = keys.map(() => []);
    for (const row of args.data) {
      const record = row as Record<string, unknown>;
      keys.forEach((key, i) => {
        columnArrays[i]!.push(record[key]);
      });
    }

    // Use actual Postgres types for array casts
    const typeCasts = columns.map((col) => this.getColumnArrayType(col));
    const unnestArgs = columnArrays.map((_, i) => `$${i + 1}::${typeCasts[i]}`);
    const quotedColumns = columns.map((c) => quoteIdent(c));

    let sql = `INSERT INTO ${qt} (${quotedColumns.join(', ')}) SELECT * FROM UNNEST(${unnestArgs.join(', ')})`;

    // skipDuplicates: add ON CONFLICT DO NOTHING
    if (args.skipDuplicates) {
      sql += ` ON CONFLICT DO NOTHING`;
    }

    sql += ` RETURNING *`;

    return {
      sql,
      params: columnArrays,
      transform: (result) => result.rows.map((row) => this.parseRow(row, this.table) as T),
      tag: `${this.table}.createMany`,
    };
  }

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------

  async update(args: UpdateArgs<T>): Promise<T> {
    return this.executeWithMiddleware('update', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildUpdate(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args.timeout);
      return deferred.transform(result);
    });
  }

  buildUpdate(args: UpdateArgs<T>): DeferredQuery<T> {
    const setEntries = Object.entries(args.data as Record<string, unknown>).filter(([, v]) => v !== undefined);

    // Build SET params first (supports atomic operators: set/increment/decrement/multiply/divide)
    const params: unknown[] = [];
    const setClauses = setEntries.map(([k, v]) => this.buildSetClause(k, v, params));

    // Build WHERE using the shared params array (continues numbering after SET params)
    const whereClause = this.buildWhereClause(args.where as Record<string, unknown>, params);

    const whereSql = whereClause ? ` WHERE ${whereClause}` : '';
    this.assertMutationHasPredicate('update', whereSql, args.allowFullTableScan);
    const sql = `UPDATE ${quoteIdent(this.table)} SET ${setClauses.join(', ')}${whereSql} RETURNING *`;

    return {
      sql,
      params,
      transform: (result) => {
        const row = result.rows[0];
        if (!row) {
          throw new NotFoundError({
            table: this.table,
            where: args.where,
            operation: 'update',
          });
        }
        return this.parseRow(row, this.table) as T;
      },
      tag: `${this.table}.update`,
    };
  }

  // -------------------------------------------------------------------------
  // delete
  // -------------------------------------------------------------------------

  async delete(args: DeleteArgs<T>): Promise<T> {
    return this.executeWithMiddleware('delete', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildDelete(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args.timeout);
      return deferred.transform(result);
    });
  }

  buildDelete(args: DeleteArgs<T>): DeferredQuery<T> {
    const { sql: whereSql, params } = this.buildWhere(args.where);
    this.assertMutationHasPredicate('delete', whereSql, args.allowFullTableScan);
    const sql = `DELETE FROM ${quoteIdent(this.table)}${whereSql} RETURNING *`;

    return {
      sql,
      params,
      transform: (result) => {
        const row = result.rows[0];
        if (!row) {
          throw new NotFoundError({
            table: this.table,
            where: args.where,
            operation: 'delete',
          });
        }
        return this.parseRow(row, this.table) as T;
      },
      tag: `${this.table}.delete`,
    };
  }

  // -------------------------------------------------------------------------
  // upsert — INSERT ... ON CONFLICT ... DO UPDATE
  // -------------------------------------------------------------------------

  async upsert(args: UpsertArgs<T>): Promise<T> {
    return this.executeWithMiddleware('upsert', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildUpsert(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args.timeout);
      return deferred.transform(result);
    });
  }

  buildUpsert(args: UpsertArgs<T>): DeferredQuery<T> {
    // Build the INSERT part from create data
    const createEntries = Object.entries(args.create as Record<string, unknown>).filter(([, v]) => v !== undefined);
    const columns = createEntries.map(([k]) => this.toSqlColumn(k));
    const createParams = createEntries.map(([, v]) => v);
    const placeholders = createEntries.map((_, i) => `$${i + 1}`);

    // The conflict target comes from `where` keys — must be unique/PK columns
    const conflictKeys = Object.keys(args.where as Record<string, unknown>).filter(
      (k) => (args.where as Record<string, unknown>)[k] !== undefined,
    );
    const conflictColumns = conflictKeys.map((k) => this.toSqlColumn(k));

    // Build the UPDATE SET part
    const updateEntries = Object.entries(args.update as Record<string, unknown>).filter(([, v]) => v !== undefined);
    let paramIdx = createParams.length + 1;
    const setClauses = updateEntries.map(([k]) => {
      const clause = `${this.toSqlColumn(k)} = $${paramIdx}`;
      paramIdx++;
      return clause;
    });
    const updateParams = updateEntries.map(([, v]) => v);

    const params = [...createParams, ...updateParams];

    const sql =
      `INSERT INTO ${quoteIdent(this.table)} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})` +
      ` ON CONFLICT (${conflictColumns.join(', ')}) DO UPDATE SET ${setClauses.join(', ')}` +
      ` RETURNING *`;

    return {
      sql,
      params,
      transform: (result) => {
        const row = result.rows[0];
        if (!row) {
          throw new NotFoundError({
            table: this.table,
            where: args.where,
            operation: 'upsert',
            message: `[turbine] upsert on "${this.table}" returned no row from RETURNING * — this should never happen.`,
          });
        }
        return this.parseRow(row, this.table) as T;
      },
      tag: `${this.table}.upsert`,
    };
  }

  // -------------------------------------------------------------------------
  // updateMany — UPDATE ... WHERE ... returning count
  // -------------------------------------------------------------------------

  async updateMany(args: UpdateManyArgs<T>): Promise<{ count: number }> {
    return this.executeWithMiddleware('updateMany', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildUpdateMany(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args.timeout);
      return deferred.transform(result);
    });
  }

  buildUpdateMany(args: UpdateManyArgs<T>): DeferredQuery<{ count: number }> {
    const setEntries = Object.entries(args.data as Record<string, unknown>).filter(([, v]) => v !== undefined);

    // Build SET params first (supports atomic operators: set/increment/decrement/multiply/divide)
    const params: unknown[] = [];
    const setClauses = setEntries.map(([k, v]) => this.buildSetClause(k, v, params));

    // Build WHERE using the shared params array (continues numbering after SET params)
    const whereClause = this.buildWhereClause(args.where as Record<string, unknown>, params);

    const whereSql = whereClause ? ` WHERE ${whereClause}` : '';
    this.assertMutationHasPredicate('updateMany', whereSql, args.allowFullTableScan);
    const sql = `UPDATE ${quoteIdent(this.table)} SET ${setClauses.join(', ')}${whereSql}`;

    return {
      sql,
      params,
      transform: (result) => ({ count: result.rowCount ?? 0 }),
      tag: `${this.table}.updateMany`,
    };
  }

  // -------------------------------------------------------------------------
  // deleteMany — DELETE ... WHERE ... returning count
  // -------------------------------------------------------------------------

  async deleteMany(args: DeleteManyArgs<T>): Promise<{ count: number }> {
    return this.executeWithMiddleware('deleteMany', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildDeleteMany(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args.timeout);
      return deferred.transform(result);
    });
  }

  buildDeleteMany(args: DeleteManyArgs<T>): DeferredQuery<{ count: number }> {
    const { sql: whereSql, params } = this.buildWhere(args.where);
    this.assertMutationHasPredicate('deleteMany', whereSql, args.allowFullTableScan);
    const sql = `DELETE FROM ${quoteIdent(this.table)}${whereSql}`;

    return {
      sql,
      params,
      transform: (result) => ({ count: result.rowCount ?? 0 }),
      tag: `${this.table}.deleteMany`,
    };
  }

  // -------------------------------------------------------------------------
  // count
  // -------------------------------------------------------------------------

  async count(args?: CountArgs<T>): Promise<number> {
    return this.executeWithMiddleware('count', (args ?? {}) as Record<string, unknown>, async () => {
      const deferred = this.buildCount(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args?.timeout);
      return deferred.transform(result);
    });
  }

  buildCount(args?: CountArgs<T>): DeferredQuery<number> {
    const { sql: whereSql, params } = args?.where ? this.buildWhere(args.where) : { sql: '', params: [] as unknown[] };

    const sql = `SELECT COUNT(*)::int AS count FROM ${quoteIdent(this.table)}${whereSql}`;

    return {
      sql,
      params,
      transform: (result) => (result.rows[0] as { count: number }).count,
      tag: `${this.table}.count`,
    };
  }

  // -------------------------------------------------------------------------
  // groupBy (with aggregate functions)
  // -------------------------------------------------------------------------

  async groupBy(args: GroupByArgs<T>): Promise<Record<string, unknown>[]> {
    return this.executeWithMiddleware('groupBy', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildGroupBy(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args.timeout);
      return deferred.transform(result);
    });
  }

  buildGroupBy(args: GroupByArgs<T>): DeferredQuery<Record<string, unknown>[]> {
    const meta = this.schema.tables[this.table];
    if (meta) {
      for (const key of args.by) {
        if (!((key as string) in meta.columnMap)) {
          throw new ValidationError(`Unknown column "${key as string}" in groupBy for table "${this.table}"`);
        }
      }
    }
    const groupColsRaw = args.by.map((k) => this.toColumn(k as string));
    const groupCols = groupColsRaw.map((c) => quoteIdent(c));
    const { sql: whereSql, params } = args.where ? this.buildWhere(args.where) : { sql: '', params: [] as unknown[] };

    // Build SELECT expressions: group-by columns + aggregate functions
    const selectExprs = [...groupCols];

    // _count
    if (args._count === true || args._count === undefined) {
      // default: always include count
      selectExprs.push('COUNT(*)::int AS _count');
    }

    // _sum
    if (args._sum) {
      for (const [field, enabled] of Object.entries(args._sum)) {
        if (enabled) {
          const col = this.toColumn(field);
          selectExprs.push(`SUM(${quoteIdent(col)}) AS ${quoteIdent('_sum_' + col)}`);
        }
      }
    }

    // _avg
    if (args._avg) {
      for (const [field, enabled] of Object.entries(args._avg)) {
        if (enabled) {
          const col = this.toColumn(field);
          selectExprs.push(`AVG(${quoteIdent(col)})::float AS ${quoteIdent('_avg_' + col)}`);
        }
      }
    }

    // _min
    if (args._min) {
      for (const [field, enabled] of Object.entries(args._min)) {
        if (enabled) {
          const col = this.toColumn(field);
          selectExprs.push(`MIN(${quoteIdent(col)}) AS ${quoteIdent('_min_' + col)}`);
        }
      }
    }

    // _max
    if (args._max) {
      for (const [field, enabled] of Object.entries(args._max)) {
        if (enabled) {
          const col = this.toColumn(field);
          selectExprs.push(`MAX(${quoteIdent(col)}) AS ${quoteIdent('_max_' + col)}`);
        }
      }
    }

    let sql = `SELECT ${selectExprs.join(', ')} FROM ${quoteIdent(this.table)}${whereSql} GROUP BY ${groupCols.join(', ')}`;

    // ORDER BY
    if (args.orderBy) {
      sql += ` ORDER BY ${this.buildOrderBy(args.orderBy)}`;
    }

    return {
      sql,
      params,
      transform: (result) =>
        result.rows.map((row) => {
          const parsed = this.parseRow(row, this.table);
          // Restructure aggregate results into nested objects (Prisma-style)
          const restructured: Record<string, unknown> = {};

          // Copy group-by fields
          for (const field of args.by) {
            restructured[field] = parsed[field];
          }

          // _count
          if ('_count' in row) {
            restructured._count = row._count;
          } else if ('count' in row) {
            restructured._count = row.count;
          }

          // Collect aggregates into nested objects
          const sumObj: Record<string, unknown> = {};
          const avgObj: Record<string, unknown> = {};
          const minObj: Record<string, unknown> = {};
          const maxObj: Record<string, unknown> = {};
          let hasSums = false,
            hasAvgs = false,
            hasMins = false,
            hasMaxs = false;

          for (const [rawKey, rawValue] of Object.entries(row)) {
            if (rawKey.startsWith('_sum_')) {
              const col = rawKey.slice(5);
              const field = this.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
              sumObj[field] = rawValue !== null ? Number(rawValue) : null;
              hasSums = true;
            } else if (rawKey.startsWith('_avg_')) {
              const col = rawKey.slice(5);
              const field = this.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
              avgObj[field] = rawValue !== null ? Number(rawValue) : null;
              hasAvgs = true;
            } else if (rawKey.startsWith('_min_')) {
              const col = rawKey.slice(5);
              const field = this.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
              minObj[field] = rawValue;
              hasMins = true;
            } else if (rawKey.startsWith('_max_')) {
              const col = rawKey.slice(5);
              const field = this.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
              maxObj[field] = rawValue;
              hasMaxs = true;
            }
          }

          if (hasSums) restructured._sum = sumObj;
          if (hasAvgs) restructured._avg = avgObj;
          if (hasMins) restructured._min = minObj;
          if (hasMaxs) restructured._max = maxObj;

          return restructured;
        }),
      tag: `${this.table}.groupBy`,
    };
  }

  // -------------------------------------------------------------------------
  // aggregate — standalone aggregation without groupBy
  // -------------------------------------------------------------------------

  async aggregate(args: AggregateArgs<T>): Promise<AggregateResult<T>> {
    return this.executeWithMiddleware('aggregate', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildAggregate(args);
      const result = await this.queryWithTimeout(deferred.sql, deferred.params, args.timeout);
      return deferred.transform(result);
    });
  }

  buildAggregate(args: AggregateArgs<T>): DeferredQuery<AggregateResult<T>> {
    const { sql: whereSql, params } = args.where ? this.buildWhere(args.where) : { sql: '', params: [] as unknown[] };

    const meta = this.schema.tables[this.table];
    if (meta) {
      for (const group of [args._sum, args._avg, args._min, args._max]) {
        if (group && typeof group === 'object') {
          for (const key of Object.keys(group)) {
            if (!(key in meta.columnMap)) {
              throw new ValidationError(`Unknown column "${key}" in aggregate for table "${this.table}"`);
            }
          }
        }
      }
      if (args._count && typeof args._count === 'object') {
        for (const key of Object.keys(args._count)) {
          if (!(key in meta.columnMap)) {
            throw new ValidationError(`Unknown column "${key}" in aggregate for table "${this.table}"`);
          }
        }
      }
    }

    const selectExprs: string[] = [];

    // _count
    if (args._count === true) {
      selectExprs.push('COUNT(*)::int AS _count');
    } else if (args._count && typeof args._count === 'object') {
      for (const [field, enabled] of Object.entries(args._count)) {
        if (enabled) {
          const col = this.toColumn(field);
          selectExprs.push(`COUNT(${quoteIdent(col)})::int AS ${quoteIdent('_count_' + col)}`);
        }
      }
    }

    // _sum
    if (args._sum) {
      for (const [field, enabled] of Object.entries(args._sum)) {
        if (enabled) {
          const col = this.toColumn(field);
          selectExprs.push(`SUM(${quoteIdent(col)}) AS ${quoteIdent('_sum_' + col)}`);
        }
      }
    }

    // _avg
    if (args._avg) {
      for (const [field, enabled] of Object.entries(args._avg)) {
        if (enabled) {
          const col = this.toColumn(field);
          selectExprs.push(`AVG(${quoteIdent(col)})::float AS ${quoteIdent('_avg_' + col)}`);
        }
      }
    }

    // _min
    if (args._min) {
      for (const [field, enabled] of Object.entries(args._min)) {
        if (enabled) {
          const col = this.toColumn(field);
          selectExprs.push(`MIN(${quoteIdent(col)}) AS ${quoteIdent('_min_' + col)}`);
        }
      }
    }

    // _max
    if (args._max) {
      for (const [field, enabled] of Object.entries(args._max)) {
        if (enabled) {
          const col = this.toColumn(field);
          selectExprs.push(`MAX(${quoteIdent(col)}) AS ${quoteIdent('_max_' + col)}`);
        }
      }
    }

    if (selectExprs.length === 0) {
      selectExprs.push('COUNT(*)::int AS _count');
    }

    const sql = `SELECT ${selectExprs.join(', ')} FROM ${quoteIdent(this.table)}${whereSql}`;

    return {
      sql,
      params,
      transform: (result) => {
        const row = result.rows[0] as Record<string, unknown>;
        const aggResult: AggregateResult<T> = {};

        // _count
        if (row._count !== undefined) {
          aggResult._count = row._count as number;
        } else {
          // Check for per-column counts
          const countObj: Record<string, number> = {};
          let hasCountFields = false;
          for (const [key, val] of Object.entries(row)) {
            if (key.startsWith('_count_')) {
              const col = key.slice(7);
              const field = this.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
              countObj[field] = val as number;
              hasCountFields = true;
            }
          }
          if (hasCountFields) aggResult._count = countObj;
        }

        // Build nested aggregate objects
        const sumObj: Record<string, number | null> = {};
        const avgObj: Record<string, number | null> = {};
        const minObj: Record<string, unknown> = {};
        const maxObj: Record<string, unknown> = {};
        let hasSums = false,
          hasAvgs = false,
          hasMins = false,
          hasMaxs = false;

        for (const [key, val] of Object.entries(row)) {
          if (key.startsWith('_sum_')) {
            const col = key.slice(5);
            const field = this.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
            sumObj[field] = val !== null ? Number(val) : null;
            hasSums = true;
          } else if (key.startsWith('_avg_')) {
            const col = key.slice(5);
            const field = this.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
            avgObj[field] = val !== null ? Number(val) : null;
            hasAvgs = true;
          } else if (key.startsWith('_min_')) {
            const col = key.slice(5);
            const field = this.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
            minObj[field] = val;
            hasMins = true;
          } else if (key.startsWith('_max_')) {
            const col = key.slice(5);
            const field = this.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
            maxObj[field] = val;
            hasMaxs = true;
          }
        }

        if (hasSums) aggResult._sum = sumObj as Partial<Record<keyof T & string, number | null>>;
        if (hasAvgs) aggResult._avg = avgObj as Partial<Record<keyof T & string, number | null>>;
        if (hasMins) aggResult._min = minObj as Partial<Record<keyof T & string, unknown>>;
        if (hasMaxs) aggResult._max = maxObj as Partial<Record<keyof T & string, unknown>>;

        return aggResult;
      },
      tag: `${this.table}.aggregate`,
    };
  }

  // =========================================================================
  // Internal helpers
  // =========================================================================

  /**
   * Resolve select/omit options into a list of snake_case column names.
   * Returns null if neither is provided (meaning all columns).
   */
  private resolveColumns(select?: Record<string, boolean>, omit?: Record<string, boolean>): string[] | null {
    if (select) {
      // Only include columns where value is true
      return Object.entries(select)
        .filter(([, v]) => v)
        .map(([k]) => this.toColumn(k));
    }
    if (omit) {
      // Include all columns except those where value is true
      const omitCols = new Set(
        Object.entries(omit)
          .filter(([, v]) => v)
          .map(([k]) => this.toColumn(k)),
      );
      return this.tableMeta.allColumns.filter((col) => !omitCols.has(col));
    }
    return null;
  }

  /** Convert camelCase field name to snake_case column name (unquoted, for non-SQL uses) */
  private toColumn(field: string): string {
    const mapped = this.tableMeta.columnMap[field];
    if (mapped) return mapped;
    return camelToSnake(field);
  }

  /** Convert camelCase field name to a double-quoted SQL identifier */
  private toSqlColumn(field: string): string {
    return quoteIdent(this.toColumn(field));
  }

  /**
   * Build a single SET clause entry for update/updateMany.
   *
   * Supports plain values and atomic operator objects ({ set, increment,
   * decrement, multiply, divide }). An operator object is detected ONLY when
   * it has EXACTLY one key that is one of the 5 operator keys — this avoids
   * misinterpreting JSON column values like `{ set: 'x' }` as operators
   * (real operator objects always have exactly one key, and a plain JSON
   * payload that happens to have a single `set` key is extremely unusual).
   * Multi-key objects are always treated as plain (JSON) values.
   *
   * Returns the SQL fragment (e.g., `"view_count" = "view_count" + $3`) and
   * pushes any required params onto the shared params array so that WHERE
   * clause numbering continues correctly afterward.
   */
  private buildSetClause(key: string, value: unknown, params: unknown[]): string {
    const col = this.toSqlColumn(key);

    // Detect atomic-operator object: plain object (not null, not array, not
    // Date, not Buffer) with EXACTLY one key matching an operator name.
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !(value instanceof Date) &&
      !Buffer.isBuffer(value)
    ) {
      const v = value as Record<string, unknown>;
      const keys = Object.keys(v);
      if (keys.length === 1 && UPDATE_OPERATOR_KEYS.has(keys[0]!)) {
        const op = keys[0]!;
        const opValue = v[op];

        if (op === 'set') {
          params.push(opValue);
          return `${col} = $${params.length}`;
        }

        // Arithmetic operators: must be finite numbers
        if (typeof opValue !== 'number' || !Number.isFinite(opValue)) {
          throw new ValidationError(
            `[turbine] update operator "${op}" on "${this.table}.${key}" requires a finite number, got ${typeof opValue}`,
          );
        }

        if (op === 'increment') {
          params.push(opValue);
          return `${col} = ${col} + $${params.length}`;
        }
        if (op === 'decrement') {
          params.push(opValue);
          return `${col} = ${col} - $${params.length}`;
        }
        if (op === 'multiply') {
          params.push(opValue);
          return `${col} = ${col} * $${params.length}`;
        }
        if (op === 'divide') {
          params.push(opValue);
          return `${col} = ${col} / $${params.length}`;
        }
      }
      // Fall through: multi-key objects or non-operator single-key objects
      // are treated as plain values (e.g., JSONB column payloads).
    }

    // Plain value (including null, Date, Buffer, arrays, JSON objects)
    params.push(value);
    return `${col} = $${params.length}`;
  }

  /** Build WHERE clause from a where object (supports operators, NULL, OR) */
  private buildWhere(where: WhereClause<T>): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    const clause = this.buildWhereClause(where as Record<string, unknown>, params);
    if (!clause) return { sql: '', params: [] };
    return { sql: ` WHERE ${clause}`, params };
  }

  /**
   * Refuse mutations with an empty predicate unless explicitly opted in.
   *
   * An empty `where` (e.g. `{}` or `{ id: undefined }`) resolves to a
   * mutation with no filter — a common footgun when a caller's filter
   * value accidentally resolves to `undefined`. This guard throws
   * `ValidationError` in that case unless `allowFullTableScan: true`.
   */
  private assertMutationHasPredicate(
    operation: 'update' | 'updateMany' | 'delete' | 'deleteMany',
    whereSql: string,
    allowFullTableScan: boolean | undefined,
  ): void {
    if (whereSql.length > 0) return;
    if (allowFullTableScan === true) return;
    throw new ValidationError(
      `[turbine] ${operation} on "${this.table}" refused: the \`where\` clause is empty. ` +
        `Pass \`allowFullTableScan: true\` to opt in, or check that your filter values are defined.`,
    );
  }

  /**
   * Build the inner WHERE expression (without the WHERE keyword).
   * Returns null if no conditions exist.
   * Supports: equality, operators, NULL, OR, AND, NOT, relation filters (some/every/none).
   */
  private buildWhereClause(where: Record<string, unknown>, params: unknown[]): string | null {
    const keys = Object.keys(where);
    if (keys.length === 0) return null;

    const andClauses: string[] = [];

    for (const key of keys) {
      const value = where[key];
      if (value === undefined) continue;

      // Handle OR special key
      if (key === 'OR') {
        const orConditions = value as Record<string, unknown>[];
        if (!Array.isArray(orConditions) || orConditions.length === 0) continue;
        const orClauses: string[] = [];
        for (const orCond of orConditions) {
          const sub = this.buildWhereClause(orCond, params);
          if (sub) orClauses.push(sub);
        }
        if (orClauses.length > 0) {
          andClauses.push(`(${orClauses.join(' OR ')})`);
        }
        continue;
      }

      // Handle AND special key
      if (key === 'AND') {
        const andConditions = value as Record<string, unknown>[];
        if (!Array.isArray(andConditions) || andConditions.length === 0) continue;
        for (const andCond of andConditions) {
          const sub = this.buildWhereClause(andCond, params);
          if (sub) andClauses.push(sub);
        }
        continue;
      }

      // Handle NOT special key
      if (key === 'NOT') {
        const notCond = value as Record<string, unknown>;
        const sub = this.buildWhereClause(notCond, params);
        if (sub) andClauses.push(`NOT (${sub})`);
        continue;
      }

      // Handle relation filters: { posts: { some: { published: true } } }
      const relationDef = this.tableMeta.relations[key];
      if (relationDef && typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const filterObj = value as Record<string, unknown>;
        // Check if this is a relation filter (has some/every/none keys)
        if ('some' in filterObj || 'every' in filterObj || 'none' in filterObj) {
          const relClause = this.buildRelationFilter(key, relationDef, filterObj, params);
          if (relClause) andClauses.push(relClause);
          continue;
        }
      }

      const rawColumn = this.toColumn(key);
      const column = quoteIdent(rawColumn);

      // Handle null → IS NULL
      if (value === null) {
        andClauses.push(`${column} IS NULL`);
        continue;
      }

      // Handle JSONB filter operators (for json/jsonb columns)
      if (typeof value === 'object' && !Array.isArray(value) && isJsonFilter(value)) {
        const colType = this.getColumnPgType(rawColumn);
        if (colType === 'json' || colType === 'jsonb') {
          const jsonClauses = this.buildJsonFilterClauses(column, value, params);
          andClauses.push(...jsonClauses);
          continue;
        }
        // Strict validation: a JSON-only operator on a non-JSON column was almost
        // certainly a typo or schema mismatch. Silently falling through to plain
        // equality (the previous behaviour) wasted hours of debugging time. Only
        // throw when the operator is unambiguously JSON-specific — `contains` is
        // shared with WhereOperator's LIKE so it must continue to fall through.
        const jsonKey = findJsonUniqueKey(value);
        if (jsonKey) {
          throw new ValidationError(
            `[turbine] Column "${rawColumn}" on table "${this.table}" is not a JSON column ` +
              `(actual type: ${colType}); cannot apply JSON operator '${jsonKey}'.`,
          );
        }
      }

      // Handle Array filter operators (for array columns)
      if (typeof value === 'object' && !Array.isArray(value) && isArrayFilter(value)) {
        const colType = this.getColumnPgType(rawColumn);
        if (colType.startsWith('_')) {
          const arrayClauses = this.buildArrayFilterClauses(column, value, params, colType);
          andClauses.push(...arrayClauses);
          continue;
        }
        // Strict validation: array operators (`has`, `hasEvery`, ...) on a
        // non-array column always indicate a mistake. None of these keys
        // overlap with other filter shapes so we can throw unconditionally.
        const arrayKey = findArrayUniqueKey(value);
        if (arrayKey) {
          throw new ValidationError(
            `[turbine] Column "${rawColumn}" on table "${this.table}" is not an array column ` +
              `(actual type: ${colType}); cannot apply array operator '${arrayKey}'.`,
          );
        }
      }

      // Handle operator objects
      if (isWhereOperator(value)) {
        const opClauses = this.buildOperatorClauses(column, value, params);
        andClauses.push(...opClauses);
        continue;
      }

      // Plain equality
      params.push(value);
      andClauses.push(`${column} = $${params.length}`);
    }

    if (andClauses.length === 0) return null;
    return andClauses.join(' AND ');
  }

  /**
   * Build relation filter SQL: WHERE EXISTS / NOT EXISTS subquery
   * Supports: some (EXISTS), every (NOT EXISTS ... NOT), none (NOT EXISTS)
   */
  private buildRelationFilter(
    _relName: string,
    relDef: RelationDef,
    filterObj: Record<string, unknown>,
    params: unknown[],
  ): string | null {
    const targetTable = relDef.to;
    const targetMeta = this.schema.tables[targetTable];
    if (!targetMeta) return null;

    const qt = quoteIdent(targetTable);
    const qSelf = quoteIdent(this.table);
    const clauses: string[] = [];

    // Correlation: link child table to parent table
    let correlation: string;
    if (relDef.type === 'hasMany' || relDef.type === 'hasOne') {
      // parent.pk = child.fk
      correlation = `${qt}.${quoteIdent(relDef.foreignKey)} = ${qSelf}.${quoteIdent(relDef.referenceKey)}`;
    } else {
      // belongsTo: parent.fk = child.pk
      correlation = `${qt}.${quoteIdent(relDef.referenceKey)} = ${qSelf}.${quoteIdent(relDef.foreignKey)}`;
    }

    // "some": EXISTS (SELECT 1 FROM target WHERE correlation AND filter)
    if (filterObj.some !== undefined) {
      const subWhere = filterObj.some as Record<string, unknown>;
      const filterClause = this.buildSubWhereForRelation(targetTable, subWhere, params);
      const fullWhere = filterClause ? `${correlation} AND ${filterClause}` : correlation;
      clauses.push(`EXISTS (SELECT 1 FROM ${qt} WHERE ${fullWhere})`);
    }

    // "none": NOT EXISTS (SELECT 1 FROM target WHERE correlation AND filter)
    if (filterObj.none !== undefined) {
      const subWhere = filterObj.none as Record<string, unknown>;
      const filterClause = this.buildSubWhereForRelation(targetTable, subWhere, params);
      const fullWhere = filterClause ? `${correlation} AND ${filterClause}` : correlation;
      clauses.push(`NOT EXISTS (SELECT 1 FROM ${qt} WHERE ${fullWhere})`);
    }

    // "every": NOT EXISTS (SELECT 1 FROM target WHERE correlation AND NOT (filter))
    if (filterObj.every !== undefined) {
      const subWhere = filterObj.every as Record<string, unknown>;
      const filterClause = this.buildSubWhereForRelation(targetTable, subWhere, params);
      if (filterClause) {
        clauses.push(`NOT EXISTS (SELECT 1 FROM ${qt} WHERE ${correlation} AND NOT (${filterClause}))`);
      } else {
        // "every" with empty filter = true (all match trivially)
      }
    }

    return clauses.length > 0 ? clauses.join(' AND ') : null;
  }

  /**
   * Build WHERE clause conditions for a relation filter subquery.
   * Uses the target table's column mapping to resolve field names.
   */
  private buildSubWhereForRelation(
    targetTable: string,
    subWhere: Record<string, unknown>,
    params: unknown[],
  ): string | null {
    const meta = this.schema.tables[targetTable];
    if (!meta) return null;

    const qt = quoteIdent(targetTable);
    const conditions: string[] = [];

    for (const [field, value] of Object.entries(subWhere)) {
      if (value === undefined) continue;

      const col = meta.columnMap[field] ?? camelToSnake(field);
      const qCol = `${qt}.${quoteIdent(col)}`;

      if (value === null) {
        conditions.push(`${qCol} IS NULL`);
        continue;
      }

      if (isWhereOperator(value)) {
        const opClauses = this.buildOperatorClauses(qCol, value, params);
        conditions.push(...opClauses);
        continue;
      }

      params.push(value);
      conditions.push(`${qCol} = $${params.length}`);
    }

    return conditions.length > 0 ? conditions.join(' AND ') : null;
  }

  /**
   * Build SQL clauses for a single operator object on a column.
   * Each operator key becomes its own clause, all ANDed together.
   */
  private buildOperatorClauses(column: string, op: WhereOperator, params: unknown[]): string[] {
    const clauses: string[] = [];

    if (op.gt !== undefined) {
      params.push(op.gt);
      clauses.push(`${column} > $${params.length}`);
    }
    if (op.gte !== undefined) {
      params.push(op.gte);
      clauses.push(`${column} >= $${params.length}`);
    }
    if (op.lt !== undefined) {
      params.push(op.lt);
      clauses.push(`${column} < $${params.length}`);
    }
    if (op.lte !== undefined) {
      params.push(op.lte);
      clauses.push(`${column} <= $${params.length}`);
    }
    if (op.not !== undefined) {
      if (op.not === null) {
        clauses.push(`${column} IS NOT NULL`);
      } else {
        params.push(op.not);
        clauses.push(`${column} != $${params.length}`);
      }
    }
    if (op.in !== undefined) {
      params.push(op.in);
      clauses.push(`${column} = ANY($${params.length})`);
    }
    if (op.notIn !== undefined) {
      params.push(op.notIn);
      clauses.push(`${column} != ALL($${params.length})`);
    }
    // Use ILIKE for case-insensitive mode, LIKE otherwise
    const likeOp = op.mode === 'insensitive' ? 'ILIKE' : 'LIKE';

    if (op.contains !== undefined) {
      params.push(`%${escapeLike(op.contains)}%`);
      clauses.push(`${column} ${likeOp} $${params.length} ESCAPE '\\'`);
    }
    if (op.startsWith !== undefined) {
      params.push(`${escapeLike(op.startsWith)}%`);
      clauses.push(`${column} ${likeOp} $${params.length} ESCAPE '\\'`);
    }
    if (op.endsWith !== undefined) {
      params.push(`%${escapeLike(op.endsWith)}`);
      clauses.push(`${column} ${likeOp} $${params.length} ESCAPE '\\'`);
    }

    return clauses;
  }

  /** Build ORDER BY clause from an object */
  private buildOrderBy(orderBy: Record<string, OrderDirection>): string {
    const meta = this.schema.tables[this.table];
    return Object.entries(orderBy)
      .map(([key, dir]) => {
        if (meta && !(key in meta.columnMap)) {
          throw new ValidationError(`Unknown column "${key}" in orderBy for table "${this.table}"`);
        }
        const safeDir = dir.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
        return `${this.toSqlColumn(key)} ${safeDir}`;
      })
      .join(', ');
  }

  /** Parse a flat row: convert snake_case to camelCase + Date coercion */
  private parseRow(row: Record<string, unknown>, table: string): Record<string, unknown> {
    const parsed: Record<string, unknown> = {};
    const meta = this.schema.tables[table];

    if (meta) {
      // Fast path: use pre-computed maps (avoids regex per column per row)
      const reverseMap = meta.reverseColumnMap;
      const dateCols = meta.dateColumns;

      const keys = Object.keys(row);
      for (let i = 0; i < keys.length; i++) {
        const col = keys[i]!;
        const value = row[col];
        const field = reverseMap[col] ?? col; // fall back to raw col name, not regex
        if (dateCols.has(col) && value !== null && !(value instanceof Date)) {
          parsed[field] = new Date(value as string);
        } else {
          parsed[field] = value;
        }
      }
    } else {
      // Fallback: no metadata, use regex conversion
      for (const [col, value] of Object.entries(row)) {
        parsed[snakeToCamel(col)] = value;
      }
    }
    return parsed;
  }

  /** Parse a row that may contain JSON nested relation columns */
  private parseNestedRow(row: Record<string, unknown>, table: string): Record<string, unknown> {
    const parsed = this.parseRow(row, table);
    const meta = this.schema.tables[table];
    if (!meta) return parsed;

    for (const [relName, relDef] of Object.entries(meta.relations)) {
      const rawValue = row[relName];
      if (rawValue !== undefined) {
        if (typeof rawValue === 'string') {
          try {
            parsed[relName] = JSON.parse(rawValue);
          } catch {
            console.warn(
              `[turbine] Warning: Failed to parse JSON for relation "${relName}" on table "${this.table}". Using raw value.`,
            );
            parsed[relName] = rawValue;
          }
        } else if (Array.isArray(rawValue)) {
          parsed[relName] = rawValue.map((item) =>
            typeof item === 'object' && item !== null
              ? this.parseRow(item as Record<string, unknown>, relDef.to)
              : item,
          );
        } else if (typeof rawValue === 'object' && rawValue !== null) {
          parsed[relName] = this.parseRow(rawValue as Record<string, unknown>, relDef.to);
        } else {
          parsed[relName] = rawValue;
        }
      }
    }

    return parsed;
  }

  /**
   * Build a SELECT clause that includes both base columns and nested relation subqueries.
   *
   * For each relation specified in the `with` clause, this method generates a correlated
   * subquery using PostgreSQL's `json_agg(json_build_object(...))` pattern. The result
   * is a single SQL SELECT clause that resolves the full object tree in one query --
   * no N+1 problem.
   *
   * **How it works:**
   * 1. Resolves the base columns for the root table (all columns, or a subset via `columnsList`).
   * 2. Iterates over each key in the `with` clause, looking up the relation definition.
   * 3. For each relation, delegates to {@link buildRelationSubquery} to generate a
   *    correlated subquery that returns JSON (array for hasMany, object for belongsTo/hasOne).
   * 4. Each subquery is aliased as the relation name in the final SELECT.
   *
   * **aliasCounter:** A shared `{ n: number }` object is passed through all nesting levels.
   * Each call to `buildRelationSubquery` increments it to produce unique table aliases
   * (`t0`, `t1`, `t2`, ...) across arbitrarily deep relation trees, preventing alias
   * collisions in the generated SQL.
   *
   * **Example output:**
   * ```sql
   * "users"."id", "users"."name", "users"."email",
   * (SELECT COALESCE(json_agg(json_build_object('id', t0."id", 'title', t0."title")), '[]'::json)
   *   FROM "posts" t0 WHERE t0."user_id" = "users"."id") AS "posts"
   * ```
   *
   * @param table - The root table name (e.g. `"users"`).
   * @param withClause - An object mapping relation names to their include specs
   *                     (`true` for default inclusion, or `WithOptions` for select/omit/where/orderBy/limit).
   * @param params - Shared parameter array for parameterized values (`$1`, `$2`, ...).
   *                 Nested where/limit values are pushed here to prevent SQL injection.
   * @param columnsList - Optional subset of columns to include in the SELECT. When `null`
   *                      or omitted, all columns from the table's schema metadata are used.
   * @param depth - Current nesting depth, passed through to {@link buildRelationSubquery}
   *                for circular-relation detection. Defaults to `0` at the top level.
   * @param path - Breadcrumb trail of relation names traversed so far, used in error
   *               messages when circular or too-deep nesting is detected.
   * @returns A complete SELECT clause string (without the `SELECT` keyword) containing
   *          base columns and relation subqueries.
   */
  private buildSelectWithRelations(
    table: string,
    withClause: WithClause,
    params: unknown[],
    columnsList?: string[] | null,
    depth?: number,
    path?: string[],
  ): string {
    const meta = this.schema.tables[table];
    if (!meta) throw new ValidationError(`[turbine] Unknown table "${table}"`);

    const cols = columnsList ?? meta.allColumns;
    const qtbl = quoteIdent(table);
    const baseCols = cols.map((col) => `${qtbl}.${quoteIdent(col)}`).join(', ');

    const relationSelects: string[] = [];
    const aliasCounter = { n: 0 };

    for (const [relName, relSpec] of Object.entries(withClause)) {
      const relDef = meta.relations[relName];
      if (!relDef) {
        throw new RelationError(
          `[turbine] Unknown relation "${relName}" on table "${table}". ` +
            `Available: ${Object.keys(meta.relations).join(', ')}`,
        );
      }

      // The main table is not aliased, so pass table name as parentRef
      const subquery = this.buildRelationSubquery(relDef, relSpec, params, table, aliasCounter, depth, path);
      relationSelects.push(`(${subquery}) AS ${quoteIdent(relName)}`);
    }

    return [baseCols, ...relationSelects].join(', ');
  }

  /**
   * Generate a correlated subquery that returns JSON for a single relation.
   *
   * This is the core of Turbine's single-query nested relation strategy. For a given
   * relation (e.g. `posts` on a `users` query), it produces a self-contained SQL subquery
   * that PostgreSQL evaluates per parent row, returning either a JSON array (hasMany) or
   * a single JSON object (belongsTo / hasOne).
   *
   * ### Algorithm overview
   *
   * 1. **Alias generation:** Allocates a unique alias (`t0`, `t1`, ...) from the shared
   *    `aliasCounter` so that deeply nested subqueries never collide.
   *
   * 2. **Column resolution:** Honors `select` / `omit` options to control which columns
   *    appear in the output JSON.
   *
   * 3. **`json_build_object`:** Builds a JSON object for each row by mapping camelCase
   *    field names to their column values:
   *    ```sql
   *    json_build_object('id', t0."id", 'title', t0."title", 'createdAt', t0."created_at")
   *    ```
   *
   * 4. **`json_agg` wrapping (hasMany):** For one-to-many relations, wraps the
   *    `json_build_object` call in `json_agg(...)` to aggregate all matching child rows
   *    into a JSON array. Uses `COALESCE(..., '[]'::json)` so the result is never NULL.
   *    For belongsTo / hasOne, no aggregation is used -- just the single JSON object
   *    with `LIMIT 1`.
   *
   * 5. **Correlation (WHERE clause):** Links the subquery to the parent row:
   *    - **hasMany:** `alias.foreignKey = parentRef.referenceKey`
   *      (e.g. `t0."user_id" = "users"."id"` -- child FK points to parent PK)
   *    - **belongsTo / hasOne:** `alias.referenceKey = parentRef.foreignKey`
   *      (e.g. `t0."id" = "posts"."author_id"` -- parent FK points to child PK)
   *
   * 6. **Recursion:** If the spec includes a nested `with` clause, this method calls
   *    itself recursively for each nested relation, passing the current alias as
   *    `parentRef`. The nested subquery appears as an additional key in the
   *    `json_build_object` call, wrapped in `COALESCE(..., '[]'::json)`.
   *    Depth is incremented and capped at 10 to guard against circular relations.
   *
   * 7. **LIMIT / ORDER BY wrapping:** For hasMany relations with `limit` or `orderBy`,
   *    the query is restructured into a two-level form:
   *    ```sql
   *    SELECT COALESCE(json_agg(json_build_object(...)), '[]'::json)
   *    FROM (
   *      SELECT t0.* FROM "posts" t0
   *      WHERE t0."user_id" = "users"."id"
   *      ORDER BY t0."created_at" DESC
   *      LIMIT $1
   *    ) t0i
   *    ```
   *    This ensures LIMIT and ORDER BY apply to the raw rows *before* `json_agg`
   *    aggregation. Without the inner subquery, LIMIT would be meaningless because
   *    `json_agg` produces a single aggregated row.
   *
   * 8. **Parameter threading:** All user-supplied values (where filters, limit) are
   *    pushed to the shared `params` array with `$N` placeholders. No string
   *    interpolation of user data ever occurs -- all identifiers go through
   *    `quoteIdent()` and all values are parameterized.
   *
   * ### Example output (hasMany with nested relation)
   * ```sql
   * SELECT COALESCE(json_agg(json_build_object(
   *   'id', t0."id",
   *   'title', t0."title",
   *   'comments', COALESCE((
   *     SELECT COALESCE(json_agg(json_build_object('id', t1."id", 'body', t1."body")), '[]'::json)
   *     FROM "comments" t1 WHERE t1."post_id" = t0."id"
   *   ), '[]'::json)
   * )), '[]'::json) FROM "posts" t0 WHERE t0."user_id" = "users"."id"
   * ```
   *
   * @param relDef - The relation definition from schema metadata (contains `to`, `type`,
   *                 `foreignKey`, `referenceKey`).
   * @param spec - Either `true` (include with defaults) or a `WithOptions` object that
   *               can specify `select`, `omit`, `where`, `orderBy`, `limit`, and nested `with`.
   * @param params - Shared parameter array. User-supplied values are pushed here and
   *                 referenced as `$1`, `$2`, etc. in the generated SQL.
   * @param parentRef - The alias (e.g. `"t0"`) or table name (e.g. `"users"`) of the
   *                    parent query. Used to build the correlated WHERE clause that ties
   *                    child rows to their parent row.
   * @param aliasCounter - Shared mutable counter (`{ n: number }`) for generating unique
   *                       table aliases (`t0`, `t1`, `t2`, ...) across all nesting levels.
   *                       Each call increments `n` by 1.
   * @param depth - Current nesting depth (starts at `0`). Incremented on each recursive
   *                call. If it reaches 10, a {@link CircularRelationError} is thrown.
   * @param path - Breadcrumb trail of relation/table names traversed so far
   *               (e.g. `["users", "posts", "comments"]`). Used in the error message
   *               when circular or too-deep nesting is detected.
   * @returns A complete SQL subquery string (without surrounding parentheses) that
   *          evaluates to a JSON array (hasMany) or a JSON object (belongsTo/hasOne).
   */
  private buildRelationSubquery(
    relDef: RelationDef,
    spec: true | WithOptions,
    params: unknown[],
    parentRef: string,
    aliasCounter: { n: number },
    depth?: number,
    path?: string[],
  ): string {
    const currentDepth = depth ?? 0;
    const currentPath = path ?? [this.table];

    const targetTable = relDef.to;

    // Hard depth cap — the `with` clause is a finite JSON structure so users can't
    // create true infinite recursion, but extremely deep nesting (10+ levels) produces
    // unmanageably large SQL. Back-references (e.g. posts → user → posts) are allowed
    // since they are legitimate queries (Prisma supports the same pattern).
    if (currentDepth >= 10) {
      throw new CircularRelationError([...currentPath, targetTable]);
    }
    const targetMeta = this.schema.tables[targetTable];
    if (!targetMeta) throw new RelationError(`[turbine] Unknown relation target "${targetTable}"`);

    // Generate a unique alias: t0, t1, t2, ...
    const alias = `t${aliasCounter.n++}`;

    // Resolve which columns to include based on select/omit
    let targetColumns = targetMeta.allColumns;
    if (spec !== true && spec.select) {
      const selectedFields = Object.entries(spec.select)
        .filter(([, v]) => v)
        .map(([k]) => targetMeta.columnMap[k] ?? camelToSnake(k));
      targetColumns = selectedFields.filter((col) => targetMeta.allColumns.includes(col));
    } else if (spec !== true && spec.omit) {
      const omittedFields = new Set(
        Object.entries(spec.omit)
          .filter(([, v]) => v)
          .map(([k]) => targetMeta.columnMap[k] ?? camelToSnake(k)),
      );
      targetColumns = targetMeta.allColumns.filter((col) => !omittedFields.has(col));
    }

    // Build json_build_object pairs for resolved columns
    const jsonPairs = targetColumns.map(
      (col) =>
        `'${escSingleQuote(targetMeta.reverseColumnMap[col] ?? snakeToCamel(col))}', ${alias}.${quoteIdent(col)}`,
    );

    // Determine if this hasMany will take the wrapped subquery path (LIMIT or ORDER BY).
    // When wrapping, nested relations are built in the wrapped path referencing innerAlias,
    // so we must NOT build them here (they would push orphaned params).
    const willWrap =
      relDef.type === 'hasMany' && spec !== true && (spec.limit !== undefined || spec.orderBy !== undefined);

    // Nested relations — only in the non-wrapped path (wrapped path builds them separately)
    if (!willWrap && spec !== true && spec.with) {
      for (const [nestedRelName, nestedSpec] of Object.entries(spec.with)) {
        const nestedRelDef = targetMeta.relations[nestedRelName];
        if (!nestedRelDef) {
          throw new RelationError(
            `[turbine] Unknown relation "${nestedRelName}" on table "${targetTable}". ` +
              `Available: ${Object.keys(targetMeta.relations).join(', ')}`,
          );
        }
        // Recursively build nested subquery, passing THIS alias as the parent reference
        const nestedSubquery = this.buildRelationSubquery(
          nestedRelDef,
          nestedSpec,
          params,
          alias,
          aliasCounter,
          currentDepth + 1,
          [...currentPath, relDef.name],
        );
        // Use '[]'::json for hasMany (empty array), NULL for belongsTo/hasOne (no object)
        const fallback = nestedRelDef.type === 'hasMany' ? "'[]'::json" : 'NULL';
        jsonPairs.push(`'${escSingleQuote(nestedRelName)}', COALESCE((${nestedSubquery}), ${fallback})`);
      }
    }

    const jsonObj = `json_build_object(${jsonPairs.join(', ')})`;

    // Quote parent ref — can be a table name or auto-generated alias
    const qParent = quoteIdent(parentRef);
    const qTarget = quoteIdent(targetTable);

    // Build ORDER BY for json_agg
    let orderClause = '';
    if (spec !== true && spec.orderBy) {
      const orders = Object.entries(spec.orderBy)
        .map(([k, dir]) => {
          const col = camelToSnake(k);
          if (!targetMeta.allColumns.includes(col)) {
            throw new ValidationError(`[turbine] Unknown column "${k}" in orderBy for table "${targetTable}"`);
          }
          const safeDir = dir.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
          return `${alias}.${quoteIdent(col)} ${safeDir}`;
        })
        .join(', ');
      orderClause = ` ORDER BY ${orders}`;
    }

    // Build WHERE — correlate to parent via parentRef (alias or table name).
    // For hasMany: target has FK, so alias.fk = parentRef.pk
    // For belongsTo: source has FK, so alias.pk = parentRef.fk (reversed)
    let whereClause: string;
    if (relDef.type === 'belongsTo' || relDef.type === 'hasOne') {
      whereClause = `${alias}.${quoteIdent(relDef.referenceKey)} = ${qParent}.${quoteIdent(relDef.foreignKey)}`;
    } else {
      whereClause = `${alias}.${quoteIdent(relDef.foreignKey)} = ${qParent}.${quoteIdent(relDef.referenceKey)}`;
    }

    // Additional filters — properly parameterized
    if (spec !== true && spec.where) {
      for (const [k, v] of Object.entries(spec.where)) {
        const col = camelToSnake(k);
        if (!targetMeta.allColumns.includes(col)) {
          throw new ValidationError(`[turbine] Unknown column "${k}" in where for table "${targetTable}"`);
        }
        params.push(v);
        whereClause += ` AND ${alias}.${quoteIdent(col)} = $${params.length}`;
      }
    }

    // LIMIT
    let limitClause = '';
    if (spec !== true && spec.limit) {
      params.push(Number(spec.limit));
      limitClause = ` LIMIT $${params.length}`;
    }

    if (relDef.type === 'hasMany') {
      // When LIMIT or ORDER BY is used, wrap in a subquery so LIMIT applies to rows
      // BEFORE json_agg aggregation (otherwise LIMIT on aggregated result is meaningless)
      if (limitClause || orderClause) {
        const innerAlias = `${alias}i`;
        // Rewrite: SELECT json_agg(json_build_object(...)) FROM (SELECT * FROM table WHERE ... ORDER BY ... LIMIT N) AS alias
        // Inner SELECT always needs all columns for WHERE/ORDER to work; json_build_object filters later
        const innerSql = `SELECT ${targetMeta.allColumns.map((c) => `${alias}.${quoteIdent(c)}`).join(', ')} FROM ${qTarget} ${alias} WHERE ${whereClause}${orderClause}${limitClause}`;
        // For the json_build_object, reference the inner alias — only include resolved columns
        const innerJsonPairs = targetColumns.map(
          (col) =>
            `'${escSingleQuote(targetMeta.reverseColumnMap[col] ?? snakeToCamel(col))}', ${innerAlias}.${quoteIdent(col)}`,
        );
        // Build nested relation subqueries referencing innerAlias
        if (spec !== true && spec.with) {
          for (const [nestedRelName, nestedSpec] of Object.entries(spec.with)) {
            const nestedRelDef = targetMeta.relations[nestedRelName];
            if (!nestedRelDef) {
              throw new RelationError(
                `[turbine] Unknown relation "${nestedRelName}" on table "${targetTable}". ` +
                  `Available: ${Object.keys(targetMeta.relations).join(', ')}`,
              );
            }
            const nestedSub = this.buildRelationSubquery(
              nestedRelDef,
              nestedSpec,
              params,
              innerAlias,
              aliasCounter,
              currentDepth + 1,
              [...currentPath, relDef.name],
            );
            const fallback = nestedRelDef.type === 'hasMany' ? "'[]'::json" : 'NULL';
            innerJsonPairs.push(`'${escSingleQuote(nestedRelName)}', COALESCE((${nestedSub}), ${fallback})`);
          }
        }
        const innerJsonObj = `json_build_object(${innerJsonPairs.join(', ')})`;
        return `SELECT COALESCE(json_agg(${innerJsonObj}), '[]'::json) FROM (${innerSql}) ${innerAlias}`;
      }
      return `SELECT COALESCE(json_agg(${jsonObj}${orderClause}), '[]'::json) FROM ${qTarget} ${alias} WHERE ${whereClause}`;
    }

    // belongsTo / hasOne — return single object
    return `SELECT ${jsonObj} FROM ${qTarget} ${alias} WHERE ${whereClause} LIMIT 1`;
  }

  /**
   * Get the Postgres type for a column (e.g. 'jsonb', 'text', '_int4').
   * Used to detect JSONB/array columns for specialized operators.
   * Uses pre-computed Map for O(1) lookup instead of linear scan.
   */
  private getColumnPgType(column: string): string {
    return this.columnPgTypeMap.get(column) ?? 'text';
  }

  /**
   * Get the Postgres base element type for an array column.
   * E.g. '_text' → 'text', '_int4' → 'integer'
   */
  private getArrayElementType(pgType: string): string {
    const baseType = pgType.startsWith('_') ? pgType.slice(1) : pgType;
    const typeMap: Record<string, string> = {
      int2: 'smallint',
      int4: 'integer',
      int8: 'bigint',
      float4: 'real',
      float8: 'double precision',
      bool: 'boolean',
      text: 'text',
      varchar: 'text',
      uuid: 'uuid',
      timestamptz: 'timestamptz',
      timestamp: 'timestamp',
      jsonb: 'jsonb',
      json: 'json',
    };
    return typeMap[baseType] ?? 'text';
  }

  /**
   * Build SQL clauses for JSONB filter operators on a column.
   * Supports: path, equals, contains, hasKey.
   */
  private buildJsonFilterClauses(column: string, filter: JsonFilter, params: unknown[]): string[] {
    const clauses: string[] = [];

    if (filter.path !== undefined && filter.equals !== undefined) {
      // Path access + equals: column #>> $N::text[] = $M
      params.push(filter.path);
      const pathParam = params.length;
      params.push(String(filter.equals));
      clauses.push(`${column} #>> $${pathParam}::text[] = $${params.length}`);
    } else if (filter.equals !== undefined) {
      // Containment equality: column @> $N::jsonb
      params.push(JSON.stringify(filter.equals));
      clauses.push(`${column} @> $${params.length}::jsonb`);
    }

    if (filter.contains !== undefined) {
      // Containment: column @> $N::jsonb
      params.push(JSON.stringify(filter.contains));
      clauses.push(`${column} @> $${params.length}::jsonb`);
    }

    if (filter.hasKey !== undefined) {
      // Key existence: column ? $N
      params.push(filter.hasKey);
      clauses.push(`${column} ? $${params.length}`);
    }

    return clauses;
  }

  /**
   * Build SQL clauses for Array filter operators on a column.
   * Supports: has, hasEvery, hasSome, isEmpty.
   */
  private buildArrayFilterClauses(column: string, filter: ArrayFilter, params: unknown[], pgType: string): string[] {
    const clauses: string[] = [];
    const elementType = this.getArrayElementType(pgType);

    if (filter.has !== undefined) {
      // value = ANY(column)
      params.push(filter.has);
      clauses.push(`$${params.length} = ANY(${column})`);
    }

    if (filter.hasEvery !== undefined) {
      // column @> ARRAY[...]::type[]
      params.push(filter.hasEvery);
      clauses.push(`${column} @> $${params.length}::${elementType}[]`);
    }

    if (filter.hasSome !== undefined) {
      // column && ARRAY[...]::type[]
      params.push(filter.hasSome);
      clauses.push(`${column} && $${params.length}::${elementType}[]`);
    }

    if (filter.isEmpty === true) {
      // array_length(column, 1) IS NULL
      clauses.push(`array_length(${column}, 1) IS NULL`);
    } else if (filter.isEmpty === false) {
      // array_length(column, 1) IS NOT NULL
      clauses.push(`array_length(${column}, 1) IS NOT NULL`);
    }

    return clauses;
  }

  /**
   * Get the Postgres array type for a column (used by UNNEST in createMany).
   * Uses pre-computed Map for O(1) lookup instead of linear scan.
   */
  private getColumnArrayType(column: string): string {
    const arrayType = this.columnArrayTypeMap.get(column);
    if (arrayType) return arrayType;

    // Fallback heuristic for unknown columns
    if (column === 'id' || column.endsWith('_id')) return 'bigint[]';
    if (column.endsWith('_at')) return 'timestamptz[]';
    return 'text[]';
  }
}
