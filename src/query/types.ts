/**
 * turbine-orm — Query builder types
 *
 * All exported type and interface definitions for the query builder module.
 */

// ---------------------------------------------------------------------------
// Public query argument types
// ---------------------------------------------------------------------------

export type OrderDirection = 'asc' | 'desc';

/**
 * How a query resolves its `with` relations.
 *
 *   - `'join'`: one SQL statement with correlated
 *     `json_agg(json_build_object(...))` subqueries. One round-trip, an index
 *     seek per parent row when the child FK is indexed. On PowDB, `'join'`
 *     instead opts into native PowQL server-side joins where eligible.
 *   - `'batched'`: run the base query, then ONE flat follow-up query per
 *     relation (`WHERE fk = ANY($1)`), stitching children client-side. D levels
 *     cost D extra round-trips, but each is a single key-set lookup and rows come
 *     back flat (a win when FK columns are unindexed or result sets are huge).
 *
 * Precedence: per-query arg > client `relationLoadStrategy` config > the engine
 * default. On SQL engines the default is `'join'`; on PowDB the default is the
 * batched loaders (an ineligible relation falls back to them per-relation and
 * silently even when `'join'` is requested).
 */
export type RelationLoadStrategy = 'join' | 'batched';

/**
 * Reference to ANOTHER COLUMN of the same table inside a where operator,
 * enabling column-to-column comparison:
 *
 * ```ts
 * where: { currentVersionId: { equals: { col: 'publishedVersionId' } } }
 * // → WHERE "current_version_id" = "published_version_id"
 * ```
 *
 * Accepted by `equals`, `not`, `gt`, `gte`, `lt`, and `lte`. The referenced
 * field resolves through the table's columnMap (camelCase accepted, same as a
 * where key) and compiles to a quoted identifier: NO parameter is bound.
 * An unknown referenced field throws {@link ValidationError} (E003).
 *
 * Notes:
 *  - `mode: 'insensitive'` cannot be combined with a column reference: it
 *    throws E003 (use `client.sql` for `lower(a) = lower(b)`).
 *  - On json/jsonb columns `equals` routes to the JSONB containment filter
 *    first, so `{ equals: { col } }` there is treated as a JSON value, not a
 *    column reference.
 *
 * `F` narrows the referenced name to the table's field names when the
 * surrounding {@link WhereClause} knows the entity type.
 */
export interface ColumnRef<F extends string = string> {
  col: F;
}

/** Operator object for advanced where filtering */
export interface WhereOperator<V = unknown, F extends string = string> {
  /**
   * Explicit equality: `{ equals: value }` → `column = $n`.
   * `{ equals: null }` → `column IS NULL`.
   * `{ equals: { col: 'otherField' } }` → `column = "other_field"` ({@link ColumnRef}).
   * On json/jsonb columns `equals` routes to the JSONB containment filter
   * ({@link JsonFilter}) instead.
   */
  equals?: V | ColumnRef<F> | null;
  gt?: V | ColumnRef<F>;
  gte?: V | ColumnRef<F>;
  lt?: V | ColumnRef<F>;
  lte?: V | ColumnRef<F>;
  not?: V | ColumnRef<F> | null;
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
 * - A text search filter object ({ search, config? })
 * - A vector distance filter object ({ distance: { to, metric, lt } }) for pgvector columns
 */
export type WhereValue<V = unknown, F extends string = string> =
  | (V extends Array<infer U>
      ? TypedRelationFilter<U> // to-many relation property → some/every/none
      : V extends Date
        ? V
        : V extends object
          ? V | TypedToOneFilter<V> | WhereClause<V> // to-one relation → is/isNot or bare where (implicit is)
          : V)
  | WhereOperator<V, F>
  | JsonFilter
  | ArrayFilter
  | TextSearchFilter
  | VectorFilter
  | null;

/** Relation filter on a to-many relation property. */
export interface TypedRelationFilter<U> {
  some?: WhereClause<U>;
  every?: WhereClause<U>;
  none?: WhereClause<U>;
}

/**
 * Relation filter on a to-one relation property. A bare object on a to-one
 * relation key is also accepted at runtime (implicit `is`, Prisma-compatible).
 */
export interface TypedToOneFilter<V> {
  is?: WhereClause<V>;
  isNot?: WhereClause<V>;
}

/**
 * Where clause type: each field can be a plain value, null, or operator object.
 * Special keys: OR for disjunctive conditions.
 * Relation names can be used with some/every/none sub-filters.
 */
export type WhereClause<T> = {
  [K in keyof T]?: WhereValue<T[K], Extract<keyof T, string>>;
} & {
  OR?: WhereClause<T>[];
  AND?: WhereClause<T>[];
  NOT?: WhereClause<T>;
  /** Relation filters — keyed by relation name, value is { some, every, none } */
  [relationName: string]: unknown;
};

/**
 * Client-level automatic WHERE filters, keyed by table accessor (the name used
 * in `db[name]` / `client.table(name)`). Each value is AND-merged into the
 * compiled WHERE of every read and mutation on that table, and into every
 * relation subquery that targets it — the mechanism behind soft-delete and
 * multi-tenancy. A function value is evaluated at query-build time (per query),
 * so a closure over per-request state (e.g. the current tenant id) enables
 * request-scoped filters. `create`/`createMany` are never filtered.
 */
export type GlobalFilters = {
  // biome-ignore lint/suspicious/noExplicitAny: filters are keyed by table name; per-table entity types are not known here
  [tableAccessor: string]: WhereClause<any> | (() => WhereClause<any>);
};

/**
 * Per-query opt-out of the configured {@link GlobalFilters}. `true` skips the
 * global filter on the query's own table AND on every relation target it
 * touches; an array skips only the named table accessors (own table and/or
 * relation targets). Global filters never satisfy the empty-`where` guard for
 * `update`/`delete` — that guard always checks the user-supplied `where`.
 */
export type SkipGlobalFilters = true | readonly string[];

/**
 * Reserved key in a `with` clause that requests correlated relation counts.
 * `_count: true` counts every to-many relation of the table; a record form
 * (`_count: { posts: true }`) counts only the named to-many relations. Each
 * selected relation resolves to a number on the result row's `_count` object.
 */
export type WithCount = true | Record<string, true>;

/**
 * Unparameterized with clause — accepts any relation name.
 * Used internally by the query builder at runtime.
 *
 * The reserved `_count` key (see {@link WithCount}) is also accepted at runtime;
 * the builder reads it via a cast so the narrow `true | WithOptions` element
 * type is preserved for the relation-subquery machinery. Typed callers get a
 * fully-typed `_count` through {@link TypedWithClause}.
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
// biome-ignore lint/complexity/noBannedTypes: {} means "no relations known" — intentional unconstrained default for generic inference
export type TypedWithClause<R extends object = {}> = [keyof R] extends [never]
  ? WithClause
  : {
      [K in keyof R]?: true | WithOptions<RelationRelations<R[K]> & object>;
    } & {
      /** Reserved: correlated relation counts. `true` counts all to-many relations. */
      _count?: true | { [K in keyof R]?: true };
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
/**
 * A single relation-`with` orderBy object: field → direction / sort spec /
 * JSON-path ordering / relation ordering. The Prisma-style array form on
 * {@link WithOptions.orderBy} is `WithOrderByObject[]`.
 */
export type WithOrderByObject = Record<string, OrderDirection | OrderBySpec | JsonPathOrderBy | RelationOrderBy>;

// biome-ignore lint/complexity/noBannedTypes: {} means "no nested relations" — using object would break WithResult inference
export interface WithOptions<NestedR extends object = {}> {
  with?: TypedWithClause<NestedR>;
  where?: Record<string, unknown>;
  /**
   * Order the related rows. Accepts a single object (`{ a: 'asc', b: 'desc' }`)
   * or a Prisma-style array of objects (`[{ a: 'asc' }, { b: 'desc' }]`, whose
   * element order is the authoritative multi-key sort precedence).
   */
  orderBy?: WithOrderByObject | WithOrderByObject[];
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
// biome-ignore lint/complexity/noBannedTypes: {} means target has no relations — intentional for code generator output
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
// biome-ignore lint/complexity/noBannedTypes: {} fallback for bare types without RelationDescriptor wrapping
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
    ? W extends { _count: infer C }
      ? // `_count` requested — add the typed count object alongside any relations.
        WithRelationAdditions<T, R, W> & { _count: CountResult<C> }
      : WithRelationAdditions<T, R, W>
    : T;

/**
 * The relation additions grafted onto `T` by a `with` clause (the `_count`
 * reserved key is handled separately by {@link WithResult}). Kept as its own
 * alias so the no-`_count` path stays byte-identical to the pre-`_count` type.
 */
type WithRelationAdditions<T, R extends object, W> = [keyof W & keyof R] extends [never]
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
    };

/**
 * Compute the shape of the `_count` object on a result row. `_count: true`
 * counts every to-many relation (keys unknown at the type level → an open
 * `Record<string, number>`); the record form (`_count: { posts: true }`) yields
 * `{ [K in selected]: number }`.
 */
type CountResult<C> = C extends true
  ? Record<string, number>
  : C extends object
    ? { [K in keyof C]: number }
    : Record<string, number>;

// ---------------------------------------------------------------------------
// Select / Omit compile-time type narrowing
// ---------------------------------------------------------------------------

/** Extract keys from a boolean record where the value is `true`. */
type TrueKeys<S extends Record<string, boolean>> = {
  [K in keyof S]: S[K] extends true ? K : never;
}[keyof S];

/** Pick only the fields from T that are selected (value = true) in S. */
export type SelectResult<T, S extends Record<string, boolean> | undefined> =
  S extends Record<string, boolean> ? Pick<T, Extract<keyof T, TrueKeys<S>>> : T;

/** Omit the fields from T that are marked (value = true) in O. */
export type OmitResult<T, O extends Record<string, boolean> | undefined> =
  O extends Record<string, boolean> ? Omit<T, Extract<keyof T, TrueKeys<O>>> : T;

/**
 * Apply select or omit field narrowing to a base type. Select takes priority —
 * when both are provided, only select is applied (matching runtime behavior).
 */
export type FieldResult<
  T,
  S extends Record<string, boolean> | undefined,
  O extends Record<string, boolean> | undefined,
> = S extends Record<string, boolean> ? SelectResult<T, S> : OmitResult<T, O>;

/**
 * Compute the full query result type: apply field narrowing to the base entity,
 * then add relation additions from the `with` clause. Relations are unaffected
 * by select/omit (they are separate JSON subqueries at the SQL level).
 *
 * Short-circuits to plain WithResult when neither select nor omit is provided,
 * preserving exact type equality with the pre-narrowing era.
 */
export type QueryResult<
  T,
  R extends object,
  W,
  S extends Record<string, boolean> | undefined,
  O extends Record<string, boolean> | undefined,
> = S extends undefined
  ? O extends undefined
    ? WithResult<T, R, W>
    : O extends Record<string, boolean>
      ? // `omit` narrows scalars only — a key the `with` clause populates stays in
        // the result (relations are separate JSON subqueries at the SQL level).
        Omit<WithResult<T, R, W>, Exclude<Extract<keyof T, TrueKeys<O>>, keyof W>>
      : WithResult<T, R, W>
  : S extends Record<string, boolean>
    ? Pick<
        WithResult<T, R, W>,
        // Selected scalars, plus every key the `with` clause adds. The with-keys
        // must be named explicitly (not just `Exclude<keyof WithResult, keyof T>`):
        // when the entity interface itself declares optional relation props, a
        // with-key is ALSO a `keyof T`, and excluding by `keyof T` would silently
        // drop the relation from the result type even though the row carries it.
        | Extract<keyof T, TrueKeys<S>>
        | Exclude<keyof WithResult<T, R, W>, keyof T>
        | Extract<keyof W, keyof WithResult<T, R, W>>
      >
    : WithResult<T, R, W>;

export interface FindUniqueArgs<
  T,
  // biome-ignore lint/complexity/noBannedTypes: {} means "no relations known" — matches TypedWithClause default
  R extends object = {},
  W extends TypedWithClause<R> = TypedWithClause<R>,
  S extends Record<string, boolean> | undefined = undefined,
  O extends Record<string, boolean> | undefined = undefined,
> {
  where: WhereClause<T>;
  select?: S;
  omit?: O;
  with?: W;
  /** Query timeout in milliseconds. Rejects with an error if exceeded. */
  timeout?: number;
  /** Override the client's relation-loading strategy for this query. See {@link RelationLoadStrategy}. */
  relationLoadStrategy?: RelationLoadStrategy;
  /** Opt out of configured {@link GlobalFilters}. See {@link SkipGlobalFilters}. */
  skipGlobalFilters?: SkipGlobalFilters;
  /** Include PII-tagged columns in the result. See {@link FindManyArgs.includePii}. */
  includePii?: boolean;
}

export interface FindManyArgs<
  T,
  // biome-ignore lint/complexity/noBannedTypes: {} means "no relations known" — matches TypedWithClause default
  R extends object = {},
  W extends TypedWithClause<R> = TypedWithClause<R>,
  S extends Record<string, boolean> | undefined = undefined,
  O extends Record<string, boolean> | undefined = undefined,
> {
  where?: WhereClause<T>;
  select?: S;
  omit?: O;
  orderBy?: OrderByClause;
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
  /** Override the client's relation-loading strategy for this query. See {@link RelationLoadStrategy}. */
  relationLoadStrategy?: RelationLoadStrategy;
  /** Opt out of configured {@link GlobalFilters}. See {@link SkipGlobalFilters}. */
  skipGlobalFilters?: SkipGlobalFilters;
  /**
   * Per-call override of the unbounded-findMany warning. Pass `false` when
   * this call intentionally reads the full table (the config-level
   * `warnOnUnlimited` stays in effect for every other call); pass `true` to
   * force the warning even when it is disabled in config.
   */
  warnOnUnlimited?: boolean;
  /**
   * Include PII-tagged columns (`defineSchema` `pii: true`) in the result.
   *
   * PII columns are EXCLUDED from default projections: they come back only when
   * explicitly named in `select`, or when this flag is `true`. Set it to `true`
   * to return every PII column at the top level AND at every nested `with`
   * level of this query. Default `false`. Schemas with no PII-tagged columns are
   * unaffected (the emitted SQL is byte-identical either way).
   *
   * Referencing a PII column in `where` / `orderBy` / `groupBy` / aggregates is
   * always allowed regardless of this flag (the reference is explicit).
   */
  includePii?: boolean;
}

export interface FindManyStreamArgs<
  T,
  // biome-ignore lint/complexity/noBannedTypes: {} means "no relations known" — matches TypedWithClause default
  R extends object = {},
  W extends TypedWithClause<R> = TypedWithClause<R>,
  S extends Record<string, boolean> | undefined = undefined,
  O extends Record<string, boolean> | undefined = undefined,
> extends FindManyArgs<T, R, W, S, O> {
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

export interface CreateArgs<
  T,
  // biome-ignore lint/complexity/noBannedTypes: {} means "no relations known" — matches QueryInterface default
  R extends object = {},
> {
  /**
   * Row data. On typed clients, relation names additionally accept nested
   * write ops ({@link NestedCreateOp}): `create` / `connect` / `connectOrCreate`.
   */
  data: CreateDataInput<T, R>;
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

export interface UpdateArgs<
  T,
  // biome-ignore lint/complexity/noBannedTypes: {} means "no relations known" — matches QueryInterface default
  R extends object = {},
> {
  where: WhereClause<T>;
  /**
   * Update data. On typed clients, relation names additionally accept nested
   * write ops ({@link NestedUpdateOp}): `create` / `connect` / `connectOrCreate`
   * / `disconnect` / `set` / `delete` / `update` / `upsert`.
   */
  data: UpdateDataInput<T, R>;
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
  /**
   * Optimistic locking — prevents lost updates in concurrent scenarios.
   * Specify the version field and its expected value. The update adds a
   * WHERE check on the version and auto-increments it. If the row was
   * modified by another transaction, throws `OptimisticLockError`.
   *
   * @example
   * ```ts
   * await db.posts.update({
   *   where: { id: 1 },
   *   data: { title: 'new title' },
   *   optimisticLock: { field: 'version', expected: 3 },
   * });
   * // Generates: UPDATE posts SET title=$1, version=version+1
   * //            WHERE id=$2 AND version=$3 RETURNING *
   * ```
   */
  optimisticLock?: { field: keyof T & string; expected: number };
  /** Opt out of configured {@link GlobalFilters}. See {@link SkipGlobalFilters}. */
  skipGlobalFilters?: SkipGlobalFilters;
}

export interface UpdateManyArgs<T> {
  where: WhereClause<T>;
  data: UpdateInput<T>;
  /** Query timeout in milliseconds. Rejects with an error if exceeded. */
  timeout?: number;
  /** See {@link UpdateArgs.allowFullTableScan}. */
  allowFullTableScan?: boolean;
  /** Opt out of configured {@link GlobalFilters}. See {@link SkipGlobalFilters}. */
  skipGlobalFilters?: SkipGlobalFilters;
}

export interface DeleteArgs<T> {
  where: WhereClause<T>;
  /** Query timeout in milliseconds. Rejects with an error if exceeded. */
  timeout?: number;
  /** See {@link UpdateArgs.allowFullTableScan}. */
  allowFullTableScan?: boolean;
  /** Opt out of configured {@link GlobalFilters}. See {@link SkipGlobalFilters}. */
  skipGlobalFilters?: SkipGlobalFilters;
}

export interface DeleteManyArgs<T> {
  where: WhereClause<T>;
  /** Query timeout in milliseconds. Rejects with an error if exceeded. */
  timeout?: number;
  /** See {@link UpdateArgs.allowFullTableScan}. */
  allowFullTableScan?: boolean;
  /** Opt out of configured {@link GlobalFilters}. See {@link SkipGlobalFilters}. */
  skipGlobalFilters?: SkipGlobalFilters;
}

export interface UpsertArgs<T> {
  where: WhereClause<T>;
  create: Partial<T>;
  update: Partial<T>;
  /** Query timeout in milliseconds. Rejects with an error if exceeded. */
  timeout?: number;
  /** Opt out of configured {@link GlobalFilters}. See {@link SkipGlobalFilters}. */
  skipGlobalFilters?: SkipGlobalFilters;
}

// ---------------------------------------------------------------------------
// Nested write operation types
//
// These mirror exactly what the runtime nested-write engine
// (src/nested-write.ts) supports: create / connect / connectOrCreate in a
// create() context, plus disconnect / set / delete / update / upsert in an
// update() context. They are wired into `CreateArgs.data` / `UpdateArgs.data`
// via {@link CreateDataInput} / {@link UpdateDataInput}, keyed by the
// generated `*Relations` map (the same `RelationDescriptor` phantom brand
// that powers deep `with`-clause inference), so typed clients get full IDE
// discovery of nested writes at arbitrary depth.
//
// `TR` is the relation target's own relations map, enabling recursion
// (`posts: { create: { comments: { create: ... } } }`). It defaults to `{}`
// so the legacy single-generic usage (`NestedCreateOp<Post>`) still works.
// ---------------------------------------------------------------------------

/** `connectOrCreate` op: connect to the row matching `where`, or create it. */
// biome-ignore lint/complexity/noBannedTypes: {} means "target has no relations" — matches RelationDescriptor default
export interface ConnectOrCreateOp<T, TR extends object = {}> {
  where: Partial<T>;
  create: CreateDataInput<T, TR>;
}

/** Nested write ops valid inside `create()` data for a relation field. */
// biome-ignore lint/complexity/noBannedTypes: {} means "target has no relations" — matches RelationDescriptor default
export interface NestedCreateOp<T, TR extends object = {}> {
  create?: CreateDataInput<T, TR> | CreateDataInput<T, TR>[];
  connect?: Partial<T> | Partial<T>[];
  connectOrCreate?: ConnectOrCreateOp<T, TR> | ConnectOrCreateOp<T, TR>[];
}

/** A nested `update` op item: update the related row(s) matching `where`. `where` is optional for belongsTo relations (derived from the parent's FK). */
// biome-ignore lint/complexity/noBannedTypes: {} means "target has no relations" — matches RelationDescriptor default
export interface NestedUpdateOpItem<T, TR extends object = {}> {
  where?: Partial<T>;
  data: UpdateDataInput<T, TR>;
}

/** A nested `upsert` op item: update the row matching `where` or create it. */
// biome-ignore lint/complexity/noBannedTypes: {} means "target has no relations" — matches RelationDescriptor default
export interface NestedUpsertOpItem<T, TR extends object = {}> {
  where: Partial<T>;
  create: CreateDataInput<T, TR>;
  update: UpdateDataInput<T, TR>;
}

/** Nested write ops valid inside `update()` data for a relation field. */
// biome-ignore lint/complexity/noBannedTypes: {} means "target has no relations" — matches RelationDescriptor default
export interface NestedUpdateOp<T, TR extends object = {}> {
  create?: CreateDataInput<T, TR> | CreateDataInput<T, TR>[];
  connect?: Partial<T> | Partial<T>[];
  connectOrCreate?: ConnectOrCreateOp<T, TR> | ConnectOrCreateOp<T, TR>[];
  disconnect?: Partial<T> | Partial<T>[];
  set?: Partial<T>[];
  delete?: Partial<T> | Partial<T>[];
  update?: NestedUpdateOpItem<T, TR> | NestedUpdateOpItem<T, TR>[];
  upsert?: NestedUpsertOpItem<T, TR> | NestedUpsertOpItem<T, TR>[];
}

/**
 * `create()` data input. When the relations map `R` is known (typed clients),
 * each relation name additionally accepts a {@link NestedCreateOp} for the
 * relation's target entity — recursively, via the target's own relations map.
 * When `R` is `{}` (untyped escape hatch) this collapses to plain `Partial<T>`.
 */
// biome-ignore lint/complexity/noBannedTypes: {} means "no relations known" — matches QueryInterface default
export type CreateDataInput<T, R extends object = {}> = [keyof R] extends [never]
  ? Partial<T>
  : Partial<T> & {
      [K in keyof R]?: NestedCreateOp<RelationTarget<R[K]> & object, RelationRelations<R[K]> & object>;
    };

/**
 * `update()` data input. Like {@link CreateDataInput} but relation fields
 * accept the full {@link NestedUpdateOp} surface (disconnect / set / delete /
 * update / upsert in addition to the create-context ops), and scalar fields
 * accept atomic {@link UpdateOperatorInput} objects.
 */
// biome-ignore lint/complexity/noBannedTypes: {} means "no relations known" — matches QueryInterface default
export type UpdateDataInput<T, R extends object = {}> = [keyof R] extends [never]
  ? UpdateInput<T>
  : UpdateInput<T> & {
      [K in keyof R]?: NestedUpdateOp<RelationTarget<R[K]> & object, RelationRelations<R[K]> & object>;
    };

export interface CountArgs<T> {
  where?: WhereClause<T>;
  /** Query timeout in milliseconds. Rejects with an error if exceeded. */
  timeout?: number;
  /** Opt out of configured {@link GlobalFilters}. See {@link SkipGlobalFilters}. */
  skipGlobalFilters?: SkipGlobalFilters;
}

/**
 * Numeric comparison operators usable inside a `having` filter. A bare number
 * is shorthand for equality (`COUNT(*) = $n`); the operator object supports
 * range and inequality comparisons. Mirrors the numeric subset of
 * {@link WhereOperator} so the same SQL machinery can be reused.
 */
export interface HavingNumericOperator {
  equals?: number;
  not?: number;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  in?: number[];
  notIn?: number[];
}

/** A single having predicate value: a bare number (equality) or an operator object. */
export type HavingFilter = number | HavingNumericOperator;

/**
 * Per-field aggregate filters inside a {@link HavingClause}. Each aggregate
 * function maps to a {@link HavingFilter} comparison on that field.
 *
 * @example
 *   viewCount: { _sum: { gt: 100 }, _avg: { lte: 50 } }
 */
export interface HavingAggregateFilter {
  _sum?: HavingFilter;
  _avg?: HavingFilter;
  _min?: HavingFilter;
  _max?: HavingFilter;
  _count?: HavingFilter;
}

/**
 * HAVING clause for `groupBy` — filters whole groups by their aggregate values
 * (the SQL `HAVING` clause). Follows Prisma's shape: each aggregable field maps
 * to a {@link HavingAggregateFilter} (`field → aggregate → operator → value`),
 * and the special top-level `_count` key (no field) filters on `COUNT(*)`.
 *
 * Implemented as a mapped type so the special `_count` key can carry a
 * {@link HavingFilter} while every entity field carries a
 * {@link HavingAggregateFilter} — without the index-signature conflict an
 * intersection type would produce when `T` is a broad `Record<string, unknown>`.
 *
 * @example
 *   // groups with more than 5 rows whose summed viewCount is at least 100
 *   having: { _count: { gt: 5 }, viewCount: { _sum: { gte: 100 } } }
 */
export type HavingClause<T> = {
  /** Filter on `COUNT(*)` for the whole group. */
  _count?: HavingFilter;
} & {
  [K in keyof T & string]?: HavingAggregateFilter;
};

/**
 * A JSON-path group key in {@link GroupByArgs.by}: groups by the value
 * extracted at `path` from a json/jsonb column. Emits
 * `(col #>> $n::text[]) AS "alias"` in SELECT and the same expression in
 * GROUP BY (the path is bound as one text[] param, never interpolated).
 * Result rows key by `alias` (default: the last path segment; a collision
 * with another result key throws {@link ValidationError} E003).
 */
export interface JsonPathGroupKey {
  /** json/jsonb column (camelCase field name, columnMap-resolved). */
  field: string;
  /** JSON path into the column (each element a key or array index). Bound as one text[] param. */
  path: (string | number)[];
  /** Result key for the group value. Defaults to the last path segment. */
  alias?: string;
}

/**
 * A JSON-path aggregate target inside `_sum` / `_avg` / `_min` / `_max` of
 * {@link GroupByArgs}: aggregates the value extracted at `path` from a
 * json/jsonb column, e.g. `SUM((col #>> $n::text[])::numeric)`. The arg key
 * is the result alias. `_sum`/`_avg` always cast numeric (a text sum is
 * meaningless); `_min`/`_max` compare as text unless `type: 'numeric'`.
 *
 * Engine note: when a group has NO value at the path, SQL engines return
 * `null` for `_sum` (SUM over zero rows), while PowDB returns `0` (engine
 * sum semantics). Treat `null` and `0` totals as equivalent when a group can
 * be empty at the path.
 */
export interface JsonPathAggregateTarget {
  /** json/jsonb column (camelCase field name, columnMap-resolved). */
  field: string;
  /** JSON path into the column (each element a key or array index). Bound as one text[] param. */
  path: (string | number)[];
  /** Comparison/aggregation kind. `_sum`/`_avg` are always numeric; `_min`/`_max` default to text. */
  type?: 'numeric' | 'text';
}

/**
 * Per-aggregate spec map for `_sum` / `_avg` / `_min` / `_max` in
 * {@link GroupByArgs}: `true` keeps the existing plain-column behavior (the
 * key is a column field name); a {@link JsonPathAggregateTarget} aggregates a
 * JSON path (the key doubles as the result alias).
 */
export type GroupByAggregateSpec<T> =
  | Partial<Record<keyof T & string, boolean>>
  | Record<string, boolean | JsonPathAggregateTarget>;

/**
 * DISTINCT ON row source for {@link GroupByArgs} (PostgreSQL only: other
 * engines throw {@link UnsupportedFeatureError} E017): the groupBy runs over
 * one representative row per `columns` combination instead of the raw table.
 *
 * ```sql
 * FROM (
 *   SELECT DISTINCT ON ("instance_id") * FROM "versions"
 *   WHERE <args.where> ORDER BY "instance_id", "created_at" DESC
 * ) AS "versions"
 * ```
 *
 * `orderBy` is REQUIRED (it decides which row survives per combination:
 * without it the picked row would be nondeterministic); the wrapper ORDER BY
 * is `columns` first, then this orderBy. `args.where` applies INSIDE the
 * wrapper (filter before picking).
 */
export interface GroupByDistinctOn<T> {
  /** DISTINCT ON columns: one surviving row per combination. */
  columns: (keyof T & string)[];
  /** Which row survives per combination (required for determinism). */
  orderBy: Record<string, OrderDirection | OrderBySpec | JsonPathOrderBy>;
}

/** A per-field aggregate ordering block: field/alias → direction or sort spec. */
export type GroupByAggregateOrderBy = Record<string, OrderDirection | OrderBySpec>;

/**
 * {@link GroupByArgs.orderBy}: order the result groups by any column the
 * groupBy result contains.
 *
 * - A plain **by-column** field name, or a **JSON group-key alias** (explicit
 *   `alias`, else the last path segment): `{ region: 'asc' }`.
 * - An **aggregate block**: `_count` takes a direction/spec directly
 *   (`{ _count: 'desc' }`); `_sum`/`_avg`/`_min`/`_max` take a field map keyed
 *   by a requested aggregate field/alias (`{ _sum: { amount: 'desc' } }`).
 *
 * An aggregate ordering that references an aggregate not requested in the same
 * call (or an unknown by-key) throws {@link ValidationError} (E003). Every
 * value accepts an {@link OrderBySpec} for `NULLS FIRST/LAST` placement
 * (PostgreSQL / SQLite only).
 */
export interface GroupByOrderBy {
  /** Order by the group's row count (requires `_count` to be selected). */
  _count?: OrderDirection | OrderBySpec;
  /** Order by a requested `_sum` aggregate, keyed by its field/alias. */
  _sum?: GroupByAggregateOrderBy;
  /** Order by a requested `_avg` aggregate, keyed by its field/alias. */
  _avg?: GroupByAggregateOrderBy;
  /** Order by a requested `_min` aggregate, keyed by its field/alias. */
  _min?: GroupByAggregateOrderBy;
  /** Order by a requested `_max` aggregate, keyed by its field/alias. */
  _max?: GroupByAggregateOrderBy;
  /** A by-column field name or JSON group-key alias → direction or sort spec. */
  [key: string]: OrderDirection | OrderBySpec | GroupByAggregateOrderBy | undefined;
}

export interface GroupByArgs<T> {
  /** Group keys: plain column field names and/or JSON-path keys ({@link JsonPathGroupKey}). */
  by: ((keyof T & string) | JsonPathGroupKey)[];
  where?: WhereClause<T>;
  /**
   * PostgreSQL only: group over one representative row per column combination
   * (`SELECT DISTINCT ON … ORDER BY …` row source). See {@link GroupByDistinctOn}.
   */
  distinctOn?: GroupByDistinctOn<T>;
  /** Include count of each group */
  _count?: true;
  /** Sum of numeric fields (or JSON paths: see {@link JsonPathAggregateTarget}) in each group */
  _sum?: GroupByAggregateSpec<T>;
  /** Average of numeric fields (or JSON paths) in each group */
  _avg?: GroupByAggregateSpec<T>;
  /** Minimum value of fields (or JSON paths) in each group */
  _min?: GroupByAggregateSpec<T>;
  /** Maximum value of fields (or JSON paths) in each group */
  _max?: GroupByAggregateSpec<T>;
  /** Filter whole groups by their aggregate values (SQL HAVING). JSON-path aggregates key by their alias. */
  having?: HavingClause<T>;
  /**
   * Order the result groups. Keys may be any column the groupBy result actually
   * contains: a plain by-column field name, a JSON group-key alias (explicit
   * `alias`, or the last path segment when unaliased), or an aggregate block
   * (`_count`, or `_sum`/`_avg`/`_min`/`_max` mapping a requested field/alias to
   * its direction). Every value supports {@link OrderBySpec} for NULLS
   * placement. See {@link GroupByOrderBy}.
   *
   * Accepts a single object or a Prisma-style array of objects
   * (`[{ region: 'asc' }, { _count: 'desc' }]`, array order authoritative).
   */
  orderBy?: GroupByOrderBy | GroupByOrderBy[];
  /**
   * Cap the number of result groups (`LIMIT`, applied after `ORDER BY`). Useful
   * for "top N groups" queries; pair with `orderBy` for a deterministic set.
   */
  limit?: number;
  /**
   * Skip this many result groups (`OFFSET`, applied after `ORDER BY`). Paginates
   * grouped results; combine with `limit` and a deterministic `orderBy`.
   */
  offset?: number;
  /** Query timeout in milliseconds. Rejects with an error if exceeded. */
  timeout?: number;
  /** Opt out of configured {@link GlobalFilters}. See {@link SkipGlobalFilters}. */
  skipGlobalFilters?: SkipGlobalFilters;
}

// ---------------------------------------------------------------------------
// GroupByResult: compute the typed result-row shape from the groupBy args
// ---------------------------------------------------------------------------

/** The by-key union of a groupBy args type (array element type of `by`). */
type GroupByKeys<A> = A extends { by: infer BY } ? (BY extends readonly unknown[] ? BY[number] : never) : never;

/** The subset of `by` keys that are plain string field names on the entity `T`. */
type GroupByFieldKeys<T, A> = Extract<GroupByKeys<A>, keyof T & string>;

/**
 * `_sum` / `_avg` result block: every requested key maps to `number | null`
 * (an aggregate over zero matching rows is null). Present only when the args
 * actually requested the block. A JSON-path aggregate target keys by its arg
 * key (the alias), so `keyof S` covers both plain columns and JSON aliases.
 */
type GroupBySumAvgPart<A, Key extends '_sum' | '_avg'> = A extends { [P in Key]: infer S }
  ? [S] extends [object]
    ? { [P in Key]: { [K in keyof S & string]: number | null } }
    : unknown
  : unknown;

/**
 * `_min` / `_max` result block: a requested key that is a real entity field
 * carries that field's own type; a JSON-path alias (or unknown key) carries
 * `unknown`.
 */
type GroupByMinMaxPart<T, A, Key extends '_min' | '_max'> = A extends { [P in Key]: infer S }
  ? [S] extends [object]
    ? { [P in Key]: { [K in keyof S & string]: K extends keyof T ? T[K] : unknown } }
    : unknown
  : unknown;

/**
 * The typed result-row shape of a `groupBy(args)` call, computed from the args
 * literal `A` (Prisma / Drizzle parity). Each `by` field carries the entity's
 * field type; `_count` is always present (a group always has a row count); and
 * each requested `_sum` / `_avg` / `_min` / `_max` block maps its selected
 * fields to properly typed values.
 *
 * JSON-path group keys (objects in `by`) resolve to a runtime alias that is not
 * knowable at the type level, so they are not projected onto the row type: cast
 * the result when grouping by a JSON path. Intersections with `unknown` (an
 * absent aggregate block) collapse away, so an args literal with no aggregates
 * yields exactly `{ [byField]: T[field] } & { _count: number }`.
 */
export type GroupByResult<T, A> = { [K in GroupByFieldKeys<T, A>]: T[K] } & { _count: number } & GroupBySumAvgPart<
    A,
    '_sum'
  > &
  GroupBySumAvgPart<A, '_avg'> &
  GroupByMinMaxPart<T, A, '_min'> &
  GroupByMinMaxPart<T, A, '_max'>;

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
  /** Opt out of configured {@link GlobalFilters}. See {@link SkipGlobalFilters}. */
  skipGlobalFilters?: SkipGlobalFilters;
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
  /** To-one relation match (bare objects on to-one keys are implicit `is`). */
  is?: Record<string, unknown>;
  isNot?: Record<string, unknown>;
}

/**
 * JSONB query operators for where clauses.
 *
 * PowDB (`turbine-orm/powdb`) semantic deltas. The PowDB engine evaluates
 * `->` path filters with full type knowledge, so a few behaviours differ from
 * the Postgres `#>>`-text driver (documented, never silently wrong):
 *   - `{ path, equals: null }` matches JSON null OR a MISSING key on PowDB
 *     (compiles to `is null`), whereas the PG driver compares extracted text
 *     against the string `'null'` and matches only a JSON string `"null"`.
 *   - equality is TYPE-STRICT on PowDB: `{ path, equals: 7 }` matches a stored
 *     JSON int `7` but not `7.0` or the JSON string `"7"` (PG text-extraction
 *     matches `equals: 7` against the string `"7"`). Range ops (`gt`/`lt`/…)
 *     still coerce int/float numerically.
 *   - a digit-only path segment (`path: ['tags', '0']`) is an ARRAY INDEX on
 *     both PowDB and the SQL engines (a json object key that is literally `"0"`
 *     is likewise addressed by index).
 *   - `contains`, and `equals` WITHOUT a `path` (whole-document containment),
 *     throw `UnsupportedFeatureError` (E017) on PowDB: PowQL has no containment
 *     operator.
 */
export interface JsonFilter {
  /**
   * Access nested path via `#>>` operator (Postgres) / `->` path (PowDB). A
   * digit-only segment (`'0'`) is treated as an array index on every engine.
   */
  path?: string[];
  /** Exact match: `column @> value::jsonb` (containment). On PowDB, requires `path` and compares the typed value (throws E017 without `path`). */
  equals?: unknown;
  /** Containment check: `column @> value::jsonb`. Unsupported on PowDB (E017: PowQL has no containment operator). */
  contains?: unknown;
  /** Key existence check: `column ? key`. */
  hasKey?: string;
  /**
   * Greater-than comparison of the value at `path` (required). Numbers cast
   * the extracted text to numeric — `(col #>> path)::numeric > $n` — while
   * strings compare as text.
   */
  gt?: number | string;
  /** Greater-than-or-equal comparison of the value at `path` (required). See {@link JsonFilter.gt}. */
  gte?: number | string;
  /** Less-than comparison of the value at `path` (required). See {@link JsonFilter.gt}. */
  lt?: number | string;
  /** Less-than-or-equal comparison of the value at `path` (required). See {@link JsonFilter.gt}. */
  lte?: number | string;
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

/** Full-text search filter using PostgreSQL to_tsvector / to_tsquery */
export interface TextSearchFilter {
  /** The search query string passed to to_tsquery */
  search: string;
  /** PostgreSQL text search configuration name (defaults to 'english') */
  config?: string;
}

// ---------------------------------------------------------------------------
// pgvector — similarity search
// ---------------------------------------------------------------------------

/**
 * Vector distance metric. Maps to a pgvector distance operator:
 *
 *  - `'l2'`     → `<->` (Euclidean / L2 distance)
 *  - `'cosine'` → `<=>` (cosine distance)
 *  - `'ip'`     → `<#>` (negative inner product)
 *
 * This is a fixed allow-list — a value outside it is rejected with a
 * `ValidationError` so a user-supplied string can never become a SQL operator.
 */
export type VectorMetric = 'l2' | 'cosine' | 'ip';

/**
 * Distance threshold filter for a pgvector column inside a `where` clause:
 *
 * ```ts
 * where: { embedding: { distance: { to: [0.1, 0.2, 0.3], metric: 'l2', lt: 0.3 } } }
 * // → WHERE "embedding" <-> $1::vector < $2
 * ```
 *
 * `to` is always bound as a single `$n::vector` param (never interpolated) and
 * each element must be a finite number. Exactly one comparison
 * (`lt` / `lte` / `gt` / `gte`) is applied; the threshold is also a bound param.
 */
export interface VectorDistanceFilter {
  /** The query vector to measure distance against. */
  to: number[];
  /** Distance metric → operator. */
  metric: VectorMetric;
  /** distance < threshold */
  lt?: number;
  /** distance <= threshold */
  lte?: number;
  /** distance > threshold */
  gt?: number;
  /** distance >= threshold */
  gte?: number;
}

/** Vector query operators for where clauses (pgvector). */
export interface VectorFilter {
  /** Filter rows by distance from a query vector. */
  distance: VectorDistanceFilter;
}

/**
 * KNN ordering spec for a pgvector column inside an `orderBy` clause:
 *
 * ```ts
 * orderBy: { embedding: { distance: { to: [...], metric: 'cosine' } } }
 * // → ORDER BY "embedding" <=> $1::vector ASC
 * ```
 *
 * `distance` ASC ranks nearest-first (the default). Pass `direction: 'desc'`
 * to invert. The query vector `to` is bound as a `$n::vector` param.
 */
export interface VectorOrderByDistance {
  to: number[];
  metric: VectorMetric;
  /** Sort direction for the computed distance. Defaults to `'asc'` (nearest first). */
  direction?: OrderDirection;
}

/** Per-column orderBy value: a plain direction or a vector-distance ordering. */
export interface VectorOrderBy {
  distance: VectorOrderByDistance;
}

/**
 * Explicit ordering spec for a column: a direction plus an optional NULLS
 * placement. `{ sort: 'desc', nulls: 'last' }` compiles to
 * `ORDER BY "col" DESC NULLS LAST`. The plain `'asc' | 'desc'` shorthand is
 * still accepted and unchanged. `nulls` is only emitted on engines that
 * support the `NULLS FIRST/LAST` grammar (PostgreSQL, SQLite); requesting it
 * elsewhere throws {@link UnsupportedFeatureError} (E017).
 */
export interface OrderBySpec {
  sort: OrderDirection;
  nulls?: 'first' | 'last';
}

/**
 * Ordering by a JSON path on a json/jsonb column of the SAME table:
 *
 * ```ts
 * orderBy: { data: { path: ['weight'], direction: 'asc', type: 'numeric' } }
 * // → ORDER BY ("data" #>> $n::text[])::numeric ASC
 * ```
 *
 * The path is bound as a single text[] parameter (never interpolated).
 * Comparison rule: values extracted from the path compare as TEXT by default;
 * pass `type: 'numeric'` to cast for numeric comparison (`::numeric` on
 * PostgreSQL). The column must be json/jsonb: anything else throws
 * {@link ValidationError} (E003). Non-Postgres engines route through the same
 * dialect JSON-extract hook the JSON where-filters use. Cross-relation
 * (lateral) JSON ordering is NOT supported: same-table columns only.
 */
export interface JsonPathOrderBy {
  /** JSON path into the column (each element a key or array index). Bound as one text[] param. */
  path: (string | number)[];
  /** Sort direction. Defaults to `'asc'`. */
  direction?: OrderDirection;
  /** Comparison kind for the extracted value. Defaults to `'text'`; `'numeric'` adds a numeric cast. */
  type?: 'numeric' | 'text';
  /**
   * NULLS placement (PostgreSQL / SQLite only: see {@link OrderBySpec}).
   * Rows whose document lacks the path extract to NULL and sort LAST in BOTH
   * directions by default (matching pick-row ordering and the PowDB engine
   * contract, so ordering is predictable across drivers); set `nulls` to
   * override on PostgreSQL / SQLite.
   */
  nulls?: 'first' | 'last';
}

/**
 * Ordering by a relation, keyed by the relation name in an {@link OrderByClause}:
 *
 *  - to-many (hasMany / manyToMany): `{ posts: { _count: 'desc' } }` — orders by
 *    a correlated `COUNT(*)` of the related rows.
 *  - to-one (belongsTo / hasOne): `{ author: { name: 'asc' } }` — orders by a
 *    correlated scalar subquery on the target column (an {@link OrderBySpec} with
 *    `nulls` is accepted too).
 */
export type RelationOrderBy = { _count: OrderDirection } | Record<string, OrderDirection | OrderBySpec>;

/**
 * The ordering value extracted from the picked row in a
 * {@link RelationPickOrderBy}: either a plain target column name (camelCase,
 * columnMap-resolved) or a JSON path into a json/jsonb target column.
 * Values extracted from a JSON path compare as TEXT by default; pass
 * `type: 'numeric'` to add a numeric cast.
 */
export type RelationPickBy =
  | string
  | {
      /** json/jsonb column on the relation target. */
      field: string;
      /**
       * JSON path into the column (each element a key or array index). Bound
       * as ONE param: a text[] on PostgreSQL, a `'$'`-rooted JSONPath string
       * on engines whose JSON functions take one (SQLite/MySQL/SQL Server).
       */
      path: (string | number)[];
      /** Comparison kind for the extracted value. Defaults to `'text'`. */
      type?: 'numeric' | 'text';
    };

/**
 * Pick-row relation ordering: order a parent query by a value read from ONE
 * related row of a hasMany relation, keyed by the relation name in an
 * {@link OrderByClause}. Compiles to a correlated scalar subquery in ORDER BY:
 *
 * ```ts
 * orderBy: {
 *   versions: {
 *     pick: { orderBy: { createdAt: 'desc' } }, // which related row
 *     by: { field: 'data', path: ['title'] },   // value to sort the parents by
 *     direction: 'asc',
 *     nulls: 'last',
 *   },
 * }
 * // → ORDER BY (SELECT ord0."data" #>> $n::text[] FROM "versions" ord0
 * //             WHERE ord0."instance_id" = "instances"."id"
 * //             ORDER BY ord0."created_at" DESC LIMIT 1) ASC NULLS LAST
 * ```
 *
 * `pick.orderBy` is REQUIRED (it makes the picked row deterministic) and
 * supports the same surface as a relation `with` orderBy on the target (plain
 * columns, {@link OrderBySpec} nulls, {@link JsonPathOrderBy}). `pick.where`
 * optionally filters the candidate rows before picking. hasMany relations
 * only; top-level findMany orderBy only (manyToMany, to-one relations, and
 * nested `with` orderBy throw {@link ValidationError} E003).
 */
export interface RelationPickOrderBy {
  /** Which related row supplies the value. */
  pick: {
    /** Inner ORDER BY choosing the row (required for determinism). */
    orderBy: Record<string, OrderDirection | OrderBySpec | JsonPathOrderBy>;
    /** Optional filter on the candidate rows before picking. */
    where?: Record<string, unknown>;
  };
  /** The value on the picked row to order the parents by. */
  by: RelationPickBy;
  /** Sort direction for the parents. Defaults to `'asc'`. */
  direction?: OrderDirection;
  /**
   * NULLS placement (PostgreSQL / SQLite only: see {@link OrderBySpec}).
   *
   * A parent with NO related rows sorts by NULL. When `nulls` is not set,
   * pick ordering defaults to `NULLS LAST` in BOTH directions, so parents
   * with zero related rows always come last (Postgres's own DESC default is
   * NULLS FIRST, which would put every childless parent at the top of a
   * "highest first" sort). Set `nulls` explicitly to override.
   */
  nulls?: 'first' | 'last';
  /**
   * Physical plan for the pick. `'subquery'` (default) compiles a correlated
   * scalar subquery in ORDER BY. `'lateral'` (PostgreSQL only, E017 elsewhere)
   * compiles a `LEFT JOIN LATERAL (... LIMIT 1) ON true` and orders by the
   * joined value. Identical results; the lateral form can be significantly
   * faster on large parent sets where the ordering subquery dominates the plan.
   * Never falls back silently: contexts that cannot take a lateral (non-Postgres
   * engines, `distinct`, nested `with` orderBy, a parent column literally named
   * `__turbine_pick`) throw.
   */
  plan?: 'subquery' | 'lateral';
}

/**
 * A single orderBy object: maps each key to one of:
 *  - a plain direction (`'asc'` / `'desc'`),
 *  - an {@link OrderBySpec} (`{ sort, nulls }`) for NULLS placement,
 *  - for json/jsonb columns, a JSON-path ordering ({@link JsonPathOrderBy}),
 *  - for pgvector columns, a KNN distance ordering ({@link VectorOrderBy}),
 *  - for a relation name, a {@link RelationOrderBy} (`_count` for to-many, a
 *    target column for to-one) or a pick-row ordering
 *    ({@link RelationPickOrderBy}, hasMany only).
 */
export type OrderByObject = Record<
  string,
  OrderDirection | OrderBySpec | JsonPathOrderBy | VectorOrderBy | RelationOrderBy | RelationPickOrderBy
>;

/**
 * An orderBy clause. Either a single {@link OrderByObject}
 * (`{ a: 'asc', b: 'desc' }`, insertion order authoritative) or a Prisma-style
 * array of them (`[{ a: 'asc' }, { b: 'desc' }]`, array order authoritative).
 * The array form makes multi-key ordering independent of JS object key
 * iteration order. Both forms flatten through `orderByEntries` so build,
 * param-collect, and cache-fingerprint paths stay in lockstep.
 */
export type OrderByClause = OrderByObject | OrderByObject[];
