/**
 * turbine-orm — Query builder types
 *
 * All exported type and interface definitions for the query builder module.
 */

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
  /**
   * Number of rows to fetch per internal FETCH batch (default: 1000).
   *
   * Trade-off: larger batches reduce network round-trips (important for
   * high-latency connections like Neon) but increase per-batch memory.
   * At 1000 rows x ~500 bytes/row the default is ~500 KB per batch.
   *
   * When the total result set fits within one batch, the stream avoids
   * cursor overhead entirely (no BEGIN / DECLARE / CLOSE / COMMIT) by
   * using a speculative `SELECT ... LIMIT batchSize+1` first.
   */
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
