/**
 * turbine-orm, Query builder types
 *
 * All exported type and interface definitions for the query builder module,
 * plus the small runtime guards that police the values those types describe
 * (the {@link UNSAFE} sentinel and the orderBy-direction check). Those guards
 * live here, next to the declarations they enforce, so a new privilege option
 * or direction-bearing shape has one obvious place to be wired in.
 */

import { ValidationError } from '../errors.js';
import type { ColumnRef } from './column-ref.js';
import type { EXCLUDED_REF, SQL_EXPR } from './expr.js';

// ---------------------------------------------------------------------------
// The privilege sentinel
// ---------------------------------------------------------------------------

/**
 * The value that unlocks a PRIVILEGE option: `skipGlobalFilters`,
 * `includePii`, `allowFullTableScan`.
 *
 * ## The bug this closes
 *
 * All three of those options are ordinary siblings of `where` on the query-args
 * object, so a handler written the idiomatic way,
 *
 * ```ts
 * app.get('/users', (req, res) => db.users.findMany({ ...req.body }));
 * ```
 *
 * used to let the REQUEST BODY turn them on. `{"where":{"name":"x"},
 * "skipGlobalFilters":true}` compiled to the same statement minus the tenant
 * predicate: the documented multi-tenancy mechanism, removed by an attacker
 * over the wire. `includePii: true` unlocked the PII projection the same way,
 * and `allowFullTableScan: true` disarmed the empty-`where` guard that stops a
 * mass update or delete.
 *
 * Typing the options `boolean` and writing "be careful" in the docs is not a
 * fix: the escalation is a mass-assignment shape, and mass assignment happens
 * because nobody enumerated the keys.
 *
 * ## Why a symbol
 *
 * `JSON.parse` cannot produce a symbol. There is no JSON document, no query
 * string, no form body and no `structuredClone` of untrusted input that yields
 * this value, so an attacker cannot put it on an args object at all. The
 * escalation stops being "discouraged" and becomes STRUCTURALLY impossible,
 * which is the only property that survives a refactor.
 *
 * Registered via `Symbol.for` rather than `Symbol()` on purpose: this package
 * ships dual ESM + CJS builds, and a consumer can easily import `UNSAFE` from
 * one copy while the query interface it calls came from the other. A plain
 * `Symbol()` would be a different value in each copy and every privileged call
 * would throw. The global registry makes the two copies agree. (Reachability of
 * `Symbol.for` from application code is irrelevant to the threat model here:
 * the attacker's channel is parsed data, which cannot carry a symbol either
 * way.)
 *
 * @example
 * ```ts
 * import { UNSAFE } from 'turbine-orm';
 *
 * // Deliberate, in a background job that legitimately crosses tenants:
 * await db.users.findMany({ where: { active: true }, skipGlobalFilters: UNSAFE });
 *
 * // Skip the global filter on named tables only (the head element is the opt-in):
 * await db.users.findMany({ with: { posts: true }, skipGlobalFilters: [UNSAFE, 'posts'] });
 * ```
 */
export const UNSAFE: unique symbol = Symbol.for('turbine-orm.UNSAFE');

/** The type of the {@link UNSAFE} sentinel. */
export type Unsafe = typeof UNSAFE;

/** Every privilege option, for the diagnostic below and for tests to enumerate. */
export type PrivilegeOption = 'skipGlobalFilters' | 'includePii' | 'allowFullTableScan';

/** The one message shape every privilege refusal uses. */
function privilegeRefusal(option: string, received: unknown, extra = ''): ValidationError {
  return new ValidationError(
    `\`${option}\` must be the \`UNSAFE\` symbol, received ${describeValue(received)}. ` +
      `${option} is a privilege option: it removes a safety boundary (a tenant filter, the PII ` +
      'projection, or the empty-`where` guard), so it cannot be enabled by a plain value that ' +
      'JSON.parse can produce. Import the sentinel and pass it explicitly: ' +
      `import { UNSAFE } from 'turbine-orm';  →  { ${option}: UNSAFE }.${extra ? ` ${extra}` : ''} ` +
      'If you did not write this option, an untrusted object was spread into these query args.',
  );
}

/** Short, non-leaking rendering of a rejected value for the diagnostic. */
function describeValue(value: unknown): string {
  if (typeof value === 'symbol') return 'a different symbol';
  if (Array.isArray(value)) return 'an array';
  if (value === null) return 'null';
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`;
  return String(value);
}

/**
 * Resolve a boolean-shaped privilege option (`includePii`,
 * `allowFullTableScan`) into the boolean the builders use.
 *
 * - absent / `undefined` / `null` / `false` → `false`. These are unambiguously
 *   NOT a request for the privilege, and throwing on them would break the
 *   ordinary `allowFullTableScan: someFlag` call whose flag is off (prisma-compat
 *   relies on `allowFullTableScan: false` staying a no-op, see its updateMany).
 * - {@link UNSAFE} → `true`.
 * - ANYTHING else, `true` included → throws {@link ValidationError} (E003).
 *
 * The literal `true` throws rather than being ignored ON PURPOSE. Ignoring it
 * would swap an escalation bug for a silent-failure bug: a legitimate caller
 * who has not migrated would keep reading rows with the PII columns quietly
 * missing, or keep expecting a cross-tenant read that no longer happens, with
 * no signal anywhere. Throwing turns the attacker's spread into a 500 and the
 * legitimate caller's stale code into an immediate, self-describing error.
 */
export function resolveUnsafeFlag(value: unknown, option: PrivilegeOption): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (value === UNSAFE) return true;
  throw privilegeRefusal(option, value);
}

/**
 * The internal form of {@link SkipGlobalFilters}: `true` (skip every table) or
 * the list of table accessors to skip. This is what the global-filter resolver
 * consumes, and it is produced ONLY by {@link resolveSkipGlobalFilters}.
 */
export type ResolvedSkipGlobalFilters = true | readonly string[];

/**
 * Validate and normalize {@link SkipGlobalFilters}.
 *
 * The array form is policed exactly as hard as the bare form: an attacker who
 * can post `{"skipGlobalFilters":["users"]}` drops the tenant predicate on the
 * table they care about, which is the same breach with an extra step. So the
 * array must LEAD with the sentinel (`[UNSAFE, 'posts']`) and the rest must be
 * table-name strings.
 */
export function resolveSkipGlobalFilters(value: unknown): ResolvedSkipGlobalFilters | undefined {
  if (value === undefined || value === null || value === false) return undefined;
  if (value === UNSAFE) return true;
  if (Array.isArray(value)) {
    if (value[0] !== UNSAFE) {
      throw privilegeRefusal(
        'skipGlobalFilters',
        value,
        'The array form skips the named tables and must lead with the sentinel: [UNSAFE, "posts"].',
      );
    }
    const tables = value.slice(1);
    // `[UNSAFE]` names no table. It used to resolve to `[]`, which every
    // consumer reads as "skip nothing", so the one shape that is an explicit,
    // correctly-imported privilege request was ALSO the one shape that was
    // silently a no-op. It is not read as "skip all" on purpose: that would let
    // `[UNSAFE, ...tables]` ESCALATE to a global skip whenever `tables` happens
    // to come back empty, which is the same accident with a much worse outcome.
    if (tables.length === 0) {
      throw new ValidationError(
        '`skipGlobalFilters: [UNSAFE]` names no table, so it would skip nothing. ' +
          'Pass the tables to skip (`[UNSAFE, "posts"]`), or the bare sentinel (`UNSAFE`) to skip every table.',
      );
    }
    for (const t of tables) {
      if (typeof t !== 'string') {
        throw new ValidationError(
          '`skipGlobalFilters: [UNSAFE, ...]` takes table accessor NAMES after the sentinel, ' +
            `received ${describeValue(t)}.`,
        );
      }
    }
    return tables as readonly string[];
  }
  throw privilegeRefusal('skipGlobalFilters', value);
}

// ---------------------------------------------------------------------------
// orderBy direction validation
// ---------------------------------------------------------------------------

/**
 * Refuse an orderBy direction that is neither `asc` nor `desc`.
 *
 * Every direction consumer used to be spelled `String(v).toLowerCase() ===
 * 'desc' ? 'DESC' : 'ASC'`, so `'descending'`, `''`, `null`, `1` and every
 * other typo all emitted `ASC`. TypeScript rejects them, but the value that
 * reaches this code in practice is `orderBy: { [field]: req.query.dir }`, which
 * is `any` at the boundary, and the failure is SILENT: the caller gets a
 * correct-looking page sorted the exact opposite way, which is worse than an
 * error and identical to a successful response.
 *
 * Accepts any casing (`'DESC'` already worked) and leaves `undefined` alone
 * (every consumer treats an undefined entry as absent). Recursive/compound
 * orderBy shapes are validated one node at a time by their own consumers.
 */
export function assertOrderDirection(value: unknown, context: string): void {
  // `undefined` alone means "this entry carries no ordering" (every consumer
  // skips it). `null` is a VALUE, and a measured silent-ASC case, so it is
  // refused like any other bad token.
  if (value === undefined) return;
  if (typeof value === 'string') {
    assertDirectionToken(value, context);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    const v = value as Record<string, unknown>;
    // `{ sort, nulls }` (OrderBySpec), `{ direction }` (JSON-path / pick-row),
    // `{ distance: { metric, direction } }` (vector KNN).
    if ('sort' in v) assertDirectionToken(v.sort, context);
    if ('direction' in v) assertDirectionToken(v.direction, context);
    const distance = v.distance;
    if (distance !== null && typeof distance === 'object' && 'direction' in (distance as object)) {
      assertDirectionToken((distance as Record<string, unknown>).direction, context);
    }
    return;
  }
  // A number or boolean is never a direction.
  assertDirectionToken(value, context);
}

/** One direction token. `undefined` means "not specified", which defaults to asc. */
export function assertDirectionToken(value: unknown, context: string): void {
  if (value === undefined) return;
  if (typeof value === 'string') {
    const lowered = value.toLowerCase();
    if (lowered === 'asc' || lowered === 'desc') return;
  }
  throw new ValidationError(
    `Invalid orderBy direction ${describeValue(value)} for ${context}. ` +
      "Use 'asc' or 'desc'. An unrecognized direction used to sort ASCENDING silently, " +
      'which returns a correct-looking page in the wrong order.',
  );
}

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
 *   - `'auto'` (the implicit default on SQL engines since 0.41): per relation,
 *     use `'join'` unless the introspected metadata PROVES the probe columns are
 *     unindexed, in which case that relation falls back to the batched loader
 *     (where a correlated per-parent scan would be pathological). Requires
 *     DB-backed index metadata (a generated / introspected client); a code-first
 *     `defineSchema`-only client has no index info to prove anything, so `'auto'`
 *     behaves exactly like `'join'` there. An EXPLICIT `'join'` or `'batched'` at
 *     the client or query level always wins and disables the per-relation
 *     fallback. Output is byte-for-byte identical to `'join'` (the batched loader
 *     guarantees the same result SHAPE); child-array order for a to-many relation
 *     WITHOUT an `orderBy` may differ from the join plan (order was never
 *     guaranteed without `orderBy`, see `stableRelationOrder` to pin it).
 *     Composite-key relations stay on the join plan (the batched loader does not
 *     support them). Engagement emits a once-per-relation dev note and a
 *     `strategy` tag on the query event.
 *
 * Precedence: per-query arg > client `relationLoadStrategy` config > the engine
 * default. On SQL engines the default is `'auto'`; on PowDB the default is the
 * batched loaders (an ineligible relation falls back to them per-relation and
 * silently even when `'join'` is requested). On PowDB, `'auto'` resolves to
 * PowDB's own existing default (loaders / nested projections); it never selects
 * a distinct PowQL code path.
 */
export type RelationLoadStrategy = 'join' | 'batched' | 'auto' | 'flatten';

// Column references (`col()`): the branded operand type lives with its
// constructor in column-ref.ts and is re-exported here with the other where
// types.
export type { ColumnRef } from './column-ref.js';

/**
 * Operator object for advanced where filtering.
 *
 * Every value operand is checked against the column before any SQL is built:
 * on a non-JSON column it must be a string, number, bigint, boolean, Date or
 * Buffer (or `null` for `equals` / `not`), `in` / `notIn` take an array of
 * those, and the LIKE operators take a string. An object at a value position
 * throws `ValidationError` (E003) instead of being bound, so a request body
 * cannot turn a value into an operator.
 */
export interface WhereOperator<V = unknown, F extends string = string> {
  /**
   * Explicit equality: `{ equals: value }` → `column = $n`.
   * `{ equals: null }` → `column IS NULL`.
   * `{ equals: col('otherField') }` → `column = "other_field"` ({@link ColumnRef}).
   * On json/jsonb columns `equals` routes to the JSONB containment filter
   * ({@link JsonFilter}) instead.
   */
  equals?: V | ColumnRef<F> | null | undefined;
  gt?: V | ColumnRef<F> | undefined;
  gte?: V | ColumnRef<F> | undefined;
  lt?: V | ColumnRef<F> | undefined;
  lte?: V | ColumnRef<F> | undefined;
  /**
   * `{ not: value }` → `column != $n`, `{ not: null }` → `column IS NOT NULL`,
   * `{ not: col('other') }` → `column != "other"`.
   *
   * An operator object negates the whole inner filter, as in Prisma:
   * `{ not: { contains: 'x' } }` → `NOT (column LIKE '%x%')`. The inner object
   * inherits this object's `mode` unless it sets its own. SQL three-valued
   * logic applies: a row whose column is NULL matches neither the inner filter
   * nor its negation. Add `{ OR: [{ col: { not: ... } }, { col: null }] }` to
   * keep NULL rows.
   */
  not?: V | ColumnRef<F> | WhereOperator<V, F> | null | undefined;
  in?: V[] | undefined;
  notIn?: V[] | undefined;
  contains?: string | undefined;
  startsWith?: string | undefined;
  endsWith?: string | undefined;
  /**
   * `'insensitive'` makes the comparison case-insensitive on a string column:
   * `contains` / `startsWith` / `endsWith` use ILIKE (or the dialect's
   * equivalent), and `equals` (or a bare value), `not`, `in` and `notIn` fold
   * case on both sides (`LOWER(...)`). A `mode` beside a non-string operand
   * throws `ValidationError` (E003).
   */
  mode?: 'default' | 'insensitive' | undefined;
}

/**
 * A where value can be:
 * - A plain value (equality: column = $N)
 * - null (column IS NULL)
 * - An operator object ({ gt: 5, lte: 10 })
 * - A JSONB filter object ({ contains, equals, path, hasKey }), on a column
 *   whose type is not a plain scalar (json columns are typed `unknown`)
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
  // Not offered on a scalar-typed column: `JsonFilter.equals` is `unknown`, so
  // it would accept any object there, including an unbranded `{ col }`.
  | ([V] extends [ScalarWhereType] ? never : JsonFilter)
  | ArrayFilter
  | TextSearchFilter
  | VectorFilter
  | null;

/** Column value types that are never JSON documents. */
type ScalarWhereType = string | number | bigint | boolean | Date | null | undefined;

/**
 * Relation filter on a to-many relation property.
 *
 * `UR` is the target entity's own relations map, so a nested relation filter
 * (`posts: { some: { comments: { some: ... } } }`) stays key-checked at depth.
 * It defaults to `{}` so the legacy single-generic spelling still works.
 */
// biome-ignore lint/complexity/noBannedTypes: {} means "target relations unknown", matches RelationDescriptor default
export interface TypedRelationFilter<U, UR extends object = {}> {
  some?: WhereClause<U, UR> | undefined;
  every?: WhereClause<U, UR> | undefined;
  none?: WhereClause<U, UR> | undefined;
}

/**
 * Relation filter on a to-one relation property. A bare object on a to-one
 * relation key is also accepted at runtime (implicit `is`, Prisma-compatible).
 *
 * `VR` is the target entity's own relations map (see {@link TypedRelationFilter}).
 */
// biome-ignore lint/complexity/noBannedTypes: {} means "target relations unknown", matches RelationDescriptor default
export interface TypedToOneFilter<V, VR extends object = {}> {
  is?: WhereClause<V, VR> | undefined;
  isNot?: WhereClause<V, VR> | undefined;
}

/**
 * The where-value accepted on a RELATION key, derived from the generated
 * {@link RelationDescriptor} brand: to-many relations take `some`/`every`/`none`,
 * to-one relations take `is`/`isNot` or a bare sub-where (implicit `is`).
 *
 * Legacy generated shapes (`posts: Post[]`, `profile: Profile | null`) carry no
 * brand, so they degrade to `unknown`, the key is still recognised (no typo
 * false-positive) but its value is not checked.
 */
type RelationWhereValue<Rel> =
  Rel extends RelationDescriptor<infer Target, infer Cardinality, infer TR>
    ? Cardinality extends 'many'
      ? TypedRelationFilter<Target, TR & object>
      : TypedToOneFilter<Target, TR & object> | WhereClause<Target, TR & object>
    : unknown;

/**
 * Where clause type: each field can be a plain value, null, or operator object.
 * Special keys: OR / AND / NOT.
 *
 * **Key checking.** Historically this type carried a
 * `[relationName: string]: unknown` index signature so relation filters
 * (`where: { posts: { some: ... } }`) would typecheck, the relation names are
 * NOT keys of the entity `T`. That index signature also annihilated
 * excess-property checking, so `where: { emial: 'x' }` compiled silently.
 *
 * Passing `R` (the generated `*Relations` map, which every typed client
 * already threads through `QueryInterface<T, R>`) removes the need for the
 * index signature: the relation keys become real, explicitly enumerated
 * properties, so a misspelled column OR relation is a compile error at the
 * offending key while every legitimate filter shape still typechecks.
 *
 * When `R` is omitted / `{}` (the untyped escape hatch, `defineSchema`-only
 * clients, and any call site that does not thread the relations map) the type
 * degrades to exactly its historical permissive form.
 */
// biome-ignore lint/complexity/noBannedTypes: {} means "no relations known", matches QueryInterface default
export type WhereClause<T, R extends object = {}> = [keyof R] extends [never]
  ? LooseWhereClause<T>
  : StrictWhereClause<T, R>;

/** The historical, index-signature-carrying where clause. See {@link WhereClause}. */
export type LooseWhereClause<T> = {
  [K in keyof T]?: WhereValue<T[K], Extract<keyof T, string>> | undefined;
} & {
  OR?: LooseWhereClause<T>[] | undefined;
  AND?: LooseWhereClause<T>[] | undefined;
  NOT?: LooseWhereClause<T> | undefined;
  /** Relation filters, keyed by relation name, value is { some, every, none } */
  [relationName: string]: unknown;
};

/** Key-checked where clause: column keys from `T`, relation keys from `R`, no index signature. */
type StrictWhereClause<T, R extends object> = {
  [K in keyof T]?: WhereValue<T[K], Extract<keyof T, string>> | undefined;
} & {
  [K in keyof R]?: RelationWhereValue<R[K]> | undefined;
} & {
  OR?: WhereClause<T, R>[] | undefined;
  AND?: WhereClause<T, R>[] | undefined;
  NOT?: WhereClause<T, R> | undefined;
};

/**
 * Client-level automatic WHERE filters, keyed by table accessor (the name used
 * in `db[name]` / `client.table(name)`). Each value is AND-merged into the
 * compiled WHERE of every read and mutation on that table, and into every
 * relation subquery that targets it, the mechanism behind soft-delete and
 * multi-tenancy. A function value is evaluated at query-build time (per query),
 * so a closure over per-request state (e.g. the current tenant id) enables
 * request-scoped filters. `create`/`createMany` are never filtered.
 *
 * Fail closed: a filter that resolves to `undefined`, or holds `undefined` at
 * any depth (`{ tenantId: undefined }` when the tenant context is missing),
 * throws `ValidationError` (E003) instead of being dropped. Return `null` or
 * `{}` to apply no filter on purpose, or pass `skipGlobalFilters: UNSAFE`.
 */
export type GlobalFilters = {
  // biome-ignore lint/suspicious/noExplicitAny: filters are keyed by table name; per-table entity types are not known here
  [tableAccessor: string]: GlobalFilter<any>;
};

/**
 * One table's global filter: a where clause over that table, or a function
 * returning one per query. `null` applies no filter on purpose. A generated
 * client types its `globalFilters` config with this per table, so a
 * misspelled table or column is a compile error.
 */
// biome-ignore lint/complexity/noBannedTypes: {} means "no relations known", matches WhereClause default
export type GlobalFilter<T, R extends object = {}> = WhereClause<T, R> | null | (() => WhereClause<T, R> | null);

/**
 * Per-query opt-out of the configured {@link GlobalFilters}. {@link UNSAFE}
 * skips the global filter on the query's own table AND on every relation target
 * it touches; `[UNSAFE, ...names]` skips only the named table accessors (own
 * table and/or relation targets). Global filters never satisfy the empty-`where`
 * guard for `update`/`delete`, that guard always checks the user-supplied
 * `where`.
 *
 * PRIVILEGE OPTION: it removes the documented multi-tenancy boundary, so it is
 * unlocked by the {@link UNSAFE} sentinel only. `true` / `['users']` throw
 * (E003). See {@link UNSAFE} for why.
 */
export type SkipGlobalFilters = Unsafe | readonly [Unsafe, ...string[]];

/**
 * Reserved key in a `with` clause that requests correlated relation counts.
 * `_count: true` counts every to-many relation of the table; a record form
 * (`_count: { posts: true }`) counts only the named to-many relations. Each
 * selected relation resolves to a number on the result row's `_count` object.
 */
export type WithCount = true | Record<string, true>;

/**
 * Unparameterized with clause, accepts any relation name.
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
 * target's own relations interface, this is what enables deep
 * `WithResult` inference.
 */
// biome-ignore lint/complexity/noBannedTypes: {} means "no relations known", intentional unconstrained default for generic inference
export type TypedWithClause<R extends object = {}> = [keyof R] extends [never]
  ? WithClause
  : {
      [K in keyof R]?: true | WithOptions<RelationRelations<R[K]> & object, RelationTarget<R[K]>> | undefined;
    } & {
      /** Reserved: correlated relation counts. `true` counts all to-many relations. */
      _count?: true | { [K in keyof R]?: true } | undefined;
    };

/**
 * Options for an included relation.
 *
 * Generic over `NestedR`, the relations interface of the *target* entity -
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

/**
 * The `where` accepted inside a relation `with` block. When the relation
 * target entity is known (a typed client, via the {@link RelationDescriptor}
 * brand the generator emits) this is a key-checked {@link WhereClause} over the
 * TARGET entity and its own relations, so `with: { posts: { where: { titel } } }`
 * is a compile error. When the target is unknown (the untyped
 * {@link WithClause} escape hatch) it degrades to the historical open record.
 */
export type WithWhere<NestedT, NestedR extends object> = [unknown] extends [NestedT]
  ? Record<string, unknown>
  : WhereClause<NestedT & object, NestedR>;

/**
 * A key-checked orderBy object over an entity and its relations.
 *
 * A column key takes a direction, an {@link OrderBySpec}, a JSON-path ordering
 * or a vector KNN ordering; a RELATION key takes a {@link RelationOrderBy}
 * (`_count`, or a target column) or a pick-row ordering. Written as an
 * intersection of two mapped types so an object literal with a key in neither
 * set is an excess property, which is what turns `orderBy: { titel: 'asc' }`
 * into a compile error instead of a runtime E003.
 *
 * Degrades to the open {@link OrderByObject} when the entity is untyped, so
 * `db.table(name)` and dynamically built clauses keep working. A value typed
 * `Record<string, OrderDirection>` still assigns, because an index signature
 * satisfies each optional target key.
 */
export type TypedOrderByObject<T, R extends object> = [unknown] extends [T]
  ? OrderByObject
  : // No relation information (the untyped escape hatch, or a client generated
    // before the brand existed): relation ordering cannot be key-checked, so the
    // whole clause stays open rather than rejecting valid relation keys. Same
    // degrade rule as {@link TypedWithClause}.
    [keyof R] extends [never]
    ? OrderByObject
    : {
        [K in keyof T]?: OrderDirection | OrderBySpec | JsonPathOrderBy | VectorOrderBy | undefined;
      } & {
        [K in keyof R]?: RelationOrderBy | RelationPickOrderBy | undefined;
      };

/** {@link TypedOrderByObject}, single or Prisma-style array. */
export type TypedOrderByClause<T, R extends object> = TypedOrderByObject<T, R> | TypedOrderByObject<T, R>[];

/**
 * `select` / `omit` inside a relation `with` block, key-checked against the
 * relation TARGET when it is known, and the historical open record when it is
 * not (the untyped {@link WithClause} escape hatch).
 */
export type WithFieldFlags<NestedT> = [unknown] extends [NestedT]
  ? Record<string, boolean>
  : { [K in keyof NestedT]?: boolean };

/**
 * `Record<never, never>` rather than `{}` for the "no nested relations known"
 * default, and the difference is load-bearing rather than cosmetic: the degrade
 * branches in {@link TypedWithClause} and {@link TypedOrderByObject} test
 * `[keyof R] extends [never]`, so the default has to be a type whose `keyof` IS
 * `never`. `object` (biome's first suggestion) has `keyof object = never` too
 * but admits any object, and `Record<string, never>` has `keyof = string`,
 * which would silently flip every untyped `with` clause off the open escape
 * hatch and onto key checking against no keys at all, i.e. reject everything. A
 * mapped type over `never` resolves to exactly the empty object type, so this
 * is the same type `{}` was, spelled in a way that says which property of it
 * matters.
 */
export interface WithOptions<NestedR extends object = Record<never, never>, NestedT = unknown> {
  with?: TypedWithClause<NestedR> | undefined;
  /** Filter the related rows. Keys are checked against the relation target when it is known (see {@link WithWhere}). */
  where?: WithWhere<NestedT, NestedR> | undefined;
  /**
   * Order the related rows. Accepts a single object (`{ a: 'asc', b: 'desc' }`)
   * or a Prisma-style array of objects (`[{ a: 'asc' }, { b: 'desc' }]`, whose
   * element order is the authoritative multi-key sort precedence).
   */
  orderBy?: TypedOrderByClause<NestedT, NestedR> | undefined;
  /** Keep at most this many of each parent's related rows. */
  limit?: number | undefined;
  /** Skip this many of each parent's related rows. To-many relations only; refused on a to-one relation. */
  offset?: number | undefined;
  /** Prisma's spelling of `limit`, folded into it at the args seam. */
  take?: number | undefined;
  /** Prisma's spelling of `offset`, folded into it at the args seam. */
  skip?: number | undefined;
  /** Only include these fields from the relation. Key-checked against the target when it is known. */
  select?: WithFieldFlags<NestedT> | undefined;
  /** Exclude these fields from the relation. Key-checked against the target when it is known. */
  omit?: WithFieldFlags<NestedT> | undefined;
}

// ---------------------------------------------------------------------------
// WithResult, compute return type based on included relations (recursive)
// ---------------------------------------------------------------------------

/**
 * A relation descriptor used by generated `*Relations` interfaces to make deep
 * `with` clause inference work. It bundles three pieces of information that
 * `WithResult` needs to recurse through nested relations:
 *
 *  - `__target`    , the target entity type (e.g. `Post`)
 *  - `__cardinality`, `'many'` for hasMany, `'one'` for belongsTo / hasOne
 *  - `__relations` , the target entity's relations interface (for further recursion)
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
 * The brand fields are phantom, they exist only for type inference and have
 * no runtime representation. The runtime always sees the parsed entity values
 * (arrays for hasMany, single object or null for belongsTo / hasOne), see the
 * cardinality projection inside {@link WithResult}.
 *
 * **Backward compatibility:** legacy generated code emitted bare types
 * (`posts: Post[]`, `profile: Profile | null`). `WithResult` still accepts that
 * shape via a fallback branch, it just cannot recurse into nested `with` for
 * those relations until the generator is updated.
 *
 * @typeParam Target      - The entity type the relation points at.
 * @typeParam Cardinality - `'many'` (array) or `'one'` (single object | null).
 * @typeParam Relations   - The target entity's own `*Relations` interface, or
 *                          `{}` if the target has no relations of its own.
 * @typeParam Kind        - The relation kind (`'belongsTo'`, `'hasOne'`, ...).
 *                          The write input types use it: a belongsTo takes the
 *                          to-one nested write operations. Optional:
 *                          the default (any kind) keeps the to-many write
 *                          shape, and a descriptor written with three
 *                          arguments still accepts a generated one.
 * @typeParam Nullable    - `false` for a belongsTo whose foreign key is NOT
 *                          NULL: the row always points at a target, so a loaded
 *                          relation is never null. A `where` on the relation
 *                          (`with: { author: { where } }`) brings `| null` back.
 *                          A global filter on the target table can also hide
 *                          the row it points at; the type does not see global
 *                          filters, so a client that filters a parent table
 *                          should treat that relation as nullable. Defaults to
 *                          `boolean`, which reads as nullable.
 */
export interface RelationDescriptor<
  Target,
  Cardinality extends 'one' | 'many',
  // biome-ignore lint/complexity/noBannedTypes: {} means target has no relations, intentional for code generator output
  Relations extends object = {},
  Kind extends RelationKind | undefined = RelationKind | undefined,
  Nullable extends boolean = boolean,
> {
  readonly __target?: Target;
  readonly __cardinality?: Cardinality;
  readonly __relations?: Relations;
  readonly __kind?: Kind;
  readonly __nullable?: Nullable;
}

/** The relation kinds a {@link RelationDescriptor} can carry. */
export type RelationKind = 'hasMany' | 'hasOne' | 'belongsTo' | 'manyToMany';

/** Extract the target entity from a relation descriptor or bare relation type. */
type RelationTarget<Rel> =
  Rel extends RelationDescriptor<infer Target, infer _C, infer _R, infer _K, infer _N>
    ? Target
    : Rel extends Array<infer Item>
      ? Item
      : Rel extends infer One | null
        ? One
        : Rel;

/** Extract the target's relations map from a relation descriptor (or `{}` for bare types). */
// biome-ignore lint/complexity/noBannedTypes: {} fallback for bare types without RelationDescriptor wrapping
type RelationRelations<Rel> = Rel extends RelationDescriptor<infer _T, infer _C, infer R, infer _K, infer _N> ? R : {};

/** Whether a relation descriptor is a belongsTo (the to-one nested write operations apply). */
type IsBelongsTo<Rel> =
  Rel extends RelationDescriptor<infer _T, infer _C, infer _R, infer K, infer _N>
    ? [K] extends ['belongsTo']
      ? true
      : false
    : false;

/**
 * Project the target type into its runtime shape: an array for a to-many
 * relation, the row for a to-one relation that cannot be null (see
 * {@link RelationDescriptor} `Nullable`), and `row | null` otherwise. `Opt` is
 * the relation's `with` value: a `where` on a to-one relation can match
 * nothing, so it keeps `| null`.
 */
type ApplyCardinality<Rel, Resolved, Opt = true> =
  Rel extends RelationDescriptor<infer _T, infer Cardinality, infer _R, infer _K, infer Nullable>
    ? Cardinality extends 'many'
      ? Resolved[]
      : [Nullable] extends [false]
        ? [Opt] extends [{ where: object }]
          ? Resolved | null
          : Resolved
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
 * function returns plain `T`, preserving the existing untyped escape hatch
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
      ? // `_count` requested, add the typed count object alongside any relations.
        WithRelationAdditions<T, R, W> & { _count: CountResult<C, R> }
      : WithRelationAdditions<T, R, W>
    : T;

/**
 * The relation additions grafted onto `T` by a `with` clause (the `_count`
 * reserved key is handled separately by {@link WithResult}). A relation
 * named by an optional key is grafted as an optional property: the type
 * cannot know whether the value at runtime includes it.
 */
type WithRelationAdditions<T, R extends object, W> = [keyof W & keyof R] extends [never]
  ? T
  : T & {
      // Remapping over `keyof W` keeps each key's optionality: a `with` typed
      // as TypedWithClause (args built in a variable or a helper) has every
      // relation as an optional key, and those may or may not be loaded.
      [K in keyof W as K extends keyof R ? K : never]: K extends keyof R
        ? W[K] extends true
          ? ApplyCardinality<R[K], RelationTarget<R[K]>>
          : ApplyCardinality<
              R[K],
              ShapeRelated<
                RelationTarget<R[K]>,
                W[K] extends { with: infer NestedW extends object }
                  ? WithResult<RelationTarget<R[K]>, RelationRelations<R[K]> & object, NestedW>
                  : RelationTarget<R[K]>,
                W[K]
              >,
              W[K]
            >
        : never;
    };

/**
 * Apply a relation's `select` / `omit` to its loaded row: the selected (or not
 * omitted) target columns, plus every relation its nested `with` added.
 */
type ShapeRelated<Target, Loaded, Opt> = [Opt] extends [{ select: infer S extends Record<string, boolean> }]
  ? Pick<Loaded, Extract<keyof Loaded, Extract<keyof Target, TrueKeys<S>> | Exclude<keyof Loaded, keyof Target>>>
  : [Opt] extends [{ omit: infer O extends Record<string, boolean> }]
    ? Omit<Loaded, Extract<keyof Target, TrueKeys<O>>>
    : Loaded;

/**
 * Compute the shape of the `_count` object on a result row. `_count: true`
 * counts every to-many relation of the table; the record form
 * (`_count: { posts: true }`) yields `{ [K in selected]: number }`.
 */
// biome-ignore lint/complexity/noBannedTypes: {} is the empty relations map, as on RelationDescriptor
type CountResult<C, R = {}> = C extends true
  ? [ToManyKeys<R>] extends [never]
    ? Record<string, number>
    : { [K in ToManyKeys<R>]: number }
  : C extends object
    ? { [K in keyof C]: number }
    : Record<string, number>;

/** The to-many relation names of a relations map. */
type ToManyKeys<R> = {
  [K in keyof R]: R[K] extends RelationDescriptor<infer _T, infer C, infer _R, infer _K, infer _N>
    ? C extends 'many'
      ? K
      : never
    : never;
}[keyof R];

// ---------------------------------------------------------------------------
// Select / Omit compile-time type narrowing
// ---------------------------------------------------------------------------

/**
 * Key-validating companion for an inferred `select` / `omit` flag map.
 *
 * `select?: S` alone can never reject a typo: `S` is inferred FROM the object
 * literal, so `{ emial: true }` simply becomes the inferred type and a
 * misspelled column silently narrows the result to `Pick<T, never>`. Writing
 * the property as `S & FieldFlags<T, S>` keeps `S` inferred exactly as before
 * (the naked `S` member is still the inference site, so literal `true` values
 * and the `TrueKeys` result narrowing are unchanged) while the mapped member
 * maps every key that is NOT a field of `T` to `never`, which makes the
 * supplied `true` unassignable and reports the typo at the offending key.
 *
 * A key that IS a field of `T` maps to plain `boolean`, so every legitimate
 * flag map (`{ id: true }`, `{ id: true, email: false }`, `{}`) is unaffected.
 *
 * An OPEN flag map (`Record<string, boolean>`, which is what the internal
 * pass-through signatures instantiate `S` with) has nothing to validate: it is
 * returned unchanged so those instantiations stay assignable to each other.
 */
export type FieldFlags<T, S> = S extends object
  ? string extends keyof S
    ? S
    : {
        [K in keyof S]: K extends keyof T ? boolean : never;
      }
  : S;

/**
 * The `select` / `omit` parameter type. `S` is the inference site and
 * {@link FieldFlags} rejects an unknown key. While an editor completes an
 * empty `{}`, `S` is still its default `undefined`; that branch is the
 * entity's fields, so they are what the editor offers. (The index signature
 * keeps the branch assignable to the open flag map the builder reads.)
 */
export type FlagsArg<T, S> =
  | ([S] extends [undefined] ? { [K in keyof T]?: boolean } & Record<string, boolean> : S & FieldFlags<T, S>)
  | undefined;

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
 * Apply select or omit field narrowing to a base type. Select takes priority -
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
      ? // `omit` narrows scalars only, a key the `with` clause populates stays in
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

/**
 * Row-lock strength for a locking read, PostgreSQL's four (`FOR UPDATE`,
 * `FOR NO KEY UPDATE`, `FOR SHARE`, `FOR KEY SHARE`). MySQL has `'update'` and
 * `'share'` only; SQLite, SQL Server and PowDB have none and refuse `lock`
 * with `UnsupportedFeatureError` (E017).
 */
export type RowLockMode = 'update' | 'noKeyUpdate' | 'share' | 'keyShare';

/**
 * The `lock` read option: a {@link RowLockMode}, or the mode plus ONE wait
 * policy. `noWait` fails at once with `LockNotAvailableError` when a row is
 * locked by another transaction; `skipLocked` leaves such rows out of the
 * result, so a page can come back short (the queue-claim pattern).
 */
export type RowLock =
  | RowLockMode
  | { mode: RowLockMode; noWait?: true | undefined; skipLocked?: undefined }
  | { mode: RowLockMode; skipLocked?: true | undefined; noWait?: undefined };

export interface FindUniqueArgs<
  T,
  // biome-ignore lint/complexity/noBannedTypes: {} means "no relations known", matches TypedWithClause default
  R extends object = {},
  W extends TypedWithClause<R> = TypedWithClause<R>,
  S extends Record<string, boolean> | undefined = undefined,
  O extends Record<string, boolean> | undefined = undefined,
  U = unknown,
> {
  /**
   * Row selector. Keys are checked against `T` and `R` (see {@link WhereClause}).
   * `U` is the table's unique-key type (the generated `XWhereUnique`): when it
   * is known, the selector must name one unique key or compound selector, and
   * may add further filters beside it.
   */
  where: U & WhereClause<T, R>;
  /** Only return these fields. Keys are checked against `T` (see {@link FieldFlags}). */
  select?: FlagsArg<T, S>;
  /** Exclude these fields. Keys are checked against `T` (see {@link FieldFlags}). */
  omit?: FlagsArg<T, O>;
  with?: (W & TypedWithClause<R>) | undefined;
  /** Query timeout in milliseconds. Rejects with an error if exceeded. */
  timeout?: number | undefined;
  /** Override the client's relation-loading strategy for this query. See {@link RelationLoadStrategy}. */
  relationLoadStrategy?: RelationLoadStrategy | undefined;
  /** Override the client's {@link TurbineConfig.stableRelationOrder} for this query. */
  stableRelationOrder?: boolean | undefined;
  /** Opt out of configured {@link GlobalFilters}. See {@link SkipGlobalFilters}. */
  skipGlobalFilters?: SkipGlobalFilters | undefined;
  /** Include PII-tagged columns (`includePii: UNSAFE`). See {@link FindManyArgs.includePii}. */
  includePii?: Unsafe | undefined;
  /** Plan this query with its real parameter values. See {@link FindManyArgs.forceCustomPlan}. */
  forceCustomPlan?: boolean | undefined;
  /** Override the relation JSON wire encoding for this query. See {@link FindManyArgs.jsonEncoding}. */
  jsonEncoding?: JsonEncoding | undefined;
  /** Lock the returned row until the transaction ends. See {@link FindManyArgs.lock}. */
  lock?: RowLock | undefined;
}

/**
 * How a nested relation's rows are encoded on the wire.
 *
 * - `'object'`, `json_build_object('id', …, 'title', …)`: every key name is
 *   repeated on every row. Readable in a query log, and the only shape the
 *   non-PostgreSQL engines emit.
 * - `'positional'`, `json_build_array(…)`: the keys are dropped and each row is
 *   a bare array whose positions are mapped back client-side. Fewer bytes and
 *   materially less server CPU, and the parsed rows are identical.
 *
 * PostgreSQL defaults to `'positional'`; every other engine is `'object'` and
 * refuses `'positional'` with {@link UnsupportedFeatureError} (E017).
 */
export type JsonEncoding = 'object' | 'positional';

export interface FindManyArgs<
  T,
  // biome-ignore lint/complexity/noBannedTypes: {} means "no relations known", matches TypedWithClause default
  R extends object = {},
  W extends TypedWithClause<R> = TypedWithClause<R>,
  S extends Record<string, boolean> | undefined = undefined,
  O extends Record<string, boolean> | undefined = undefined,
> {
  /** Row filter. Keys are checked against `T` and `R` (see {@link WhereClause}). */
  where?: WhereClause<T, R> | undefined;
  /** Only return these fields. Keys are checked against `T` (see {@link FieldFlags}). */
  select?: FlagsArg<T, S>;
  /** Exclude these fields. Keys are checked against `T` (see {@link FieldFlags}). */
  omit?: FlagsArg<T, O>;
  orderBy?: TypedOrderByClause<T, R> | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  with?: (W & TypedWithClause<R>) | undefined;
  /** Cursor-based pagination: start after this row */
  cursor?: Partial<T> | undefined;
  /**
   * Prisma's spelling of {@link FindManyArgs.limit}. Folded into `limit` before
   * anything reads it; passing both with different values is a
   * `ValidationError`.
   */
  take?: number | undefined;
  /**
   * Prisma's spelling of {@link FindManyArgs.offset}. Folded into `offset`
   * before anything reads it; passing both with different values is a
   * `ValidationError`.
   *
   * Accepted since 0.73.0. Before that `take` was recognized and `skip` was
   * not, so the Prisma pair `{ take, skip }` silently returned the first page
   * however far the caller thought they had paged.
   */
  skip?: number | undefined;
  /** De-duplicate results by specified fields */
  distinct?: (keyof T & string)[] | undefined;
  /** Query timeout in milliseconds. Rejects with an error if exceeded. */
  timeout?: number | undefined;
  /** Override the client's relation-loading strategy for this query. See {@link RelationLoadStrategy}. */
  relationLoadStrategy?: RelationLoadStrategy | undefined;
  /**
   * Override the client's {@link TurbineConfig.stableRelationOrder} for this
   * query. When `true`, every to-many `with` relation that has no explicit
   * `orderBy` is loaded ordered by the target table's primary key ascending, so
   * unordered child arrays come back in a deterministic order. An explicit
   * per-relation `orderBy` always wins. Off by default; when off the emitted SQL
   * is byte-identical to before.
   */
  stableRelationOrder?: boolean | undefined;
  /** Opt out of configured {@link GlobalFilters}. See {@link SkipGlobalFilters}. */
  skipGlobalFilters?: SkipGlobalFilters | undefined;
  /**
   * Per-call override of the unbounded-findMany warning. Pass `false` when
   * this call intentionally reads the full table (the config-level
   * `warnOnUnlimited` stays in effect for every other call); pass `true` to
   * force the warning even when it is disabled in config.
   */
  warnOnUnlimited?: boolean | undefined;
  /**
   * Include PII-tagged columns (`defineSchema` `pii: true`) in the result.
   *
   * PII columns are EXCLUDED from default projections, and this flag is the
   * only way to read one. With it, every PII column comes back at the top
   * level AND at every nested `with` level of this query, and a `select` may
   * name one. Without it, a `select` naming a PII column throws (E003): `select`
   * can arrive in request data, so naming a column is not an opt-in. Schemas
   * with no PII-tagged columns are unaffected (the emitted SQL is
   * byte-identical either way).
   *
   * Filtering or sorting on a PII column (`where`, `orderBy`) is always
   * allowed, since it returns no PII value. Grouping by one, or `_min` / `_max`
   * over one, needs the same flag on {@link GroupByArgs} / {@link AggregateArgs}.
   *
   * PRIVILEGE OPTION: unlocked by the {@link UNSAFE} sentinel only
   * (`includePii: UNSAFE`). A literal `true` throws (E003), because a request
   * body spread into these args must not be able to unlock the PII projection.
   */
  includePii?: Unsafe | undefined;
  /**
   * Plan THIS query with its actual parameter values, every execution.
   * PostgreSQL only (see the refusal below).
   *
   * WHY IT EXISTS. Turbine executes through a NAMED prepared statement, which
   * enters the backend's plan cache, and from the sixth execution onward
   * PostgreSQL may replace the per-execution plan with a single GENERIC plan
   * (whenever the generic plan's estimated cost is not worse than the average
   * custom cost). A generic plan substitutes a default for every value it
   * cannot see: an unknown equality gets `rows / n_distinct`, an unknown range
   * gets a third of the table, an unknown LIKE gets 0.5%, and an unknown LIMIT
   * gets 10% of its child node's estimate. When one of those defaults lands on
   * the other side of a plan boundary from the real value, the plan SHAPE
   * flips, and the flip can be catastrophic. It fails in both directions: a
   * default above the truth and a default below it are both capable of it, so
   * "the tenant with few rows" is not the predictor.
   *
   * WHAT IT DOES, stated as the mechanism really is rather than as the tempting
   * one-liner. `true` sends this one statement UNNAMED. It is NOT true that
   * PostgreSQL treats an unnamed statement as a one-shot plan that never enters
   * the plan cache: `exec_parse_message` builds a `CachedPlanSource` and calls
   * `SaveCachedPlan` on it for the unnamed statement too (it is kept in
   * `unnamed_stmt_psrc`). The reason the option works is one level up, in the
   * DRIVER: node-postgres only skips Parse for a statement it has already
   * parsed BY NAME (`Query.hasBeenParsed` is `this.name && ...`), so an unnamed
   * statement is re-Parsed on every execution. Each Parse replaces the unnamed
   * entry with a fresh `CachedPlanSource` whose custom-plan counter starts at
   * zero, so the five-execution threshold that precedes promotion is never
   * reached and every execution is planned with the real parameter values.
   *
   * That distinction matters in practice: the guarantee is a property of the
   * driver's behaviour plus the backend's promotion rule, not a special
   * one-shot plan class, which is exactly why a connection pinned to
   * `force_generic_plan` still overrides it (see PRECEDENCE below).
   *
   * Nothing is set on the session, no `SET` is emitted, no transaction is
   * opened, and no extra round trip is added.
   *
   * WHAT IT CANNOT DO, and why this is a boolean rather than the client-level
   * three-value {@link TurbineConfig.planCacheMode}: the generic direction is
   * NOT expressible per query. `force_generic_plan` is a property of a CACHED
   * plan, and the only per-query lever here is keeping the statement out of the
   * cache, which can only ever mean "custom". A per-query
   * `planCacheMode: 'force_generic_plan'` would be a promise this mechanism
   * cannot keep, so the option is named for the one thing it does.
   *
   * PRECEDENCE over the client-level `planCacheMode`, which is a connection
   * parameter and cannot be unset for one query. Stated exactly, because one of
   * these four is the opposite of what the mechanism suggests:
   *   - Client on the default (`planCacheMode` unset) or `'auto'`: this is what
   *     the option is FOR. `auto` is the only mode in which promotion to a
   *     generic plan happens, and the re-Parse described above resets the
   *     counter that promotion depends on before it can ever be reached.
   *   - Client on `'force_custom_plan'`: redundant and harmless, both routes
   *     plan with the real values.
   *   - Client on `'force_generic_plan'`: REFUSED, with `ValidationError`
   *     (E003). It does NOT win. That setting governs the unnamed statement's
   *     cached plan source as well as a named one (measured on PostgreSQL 16.14: five executions
   *     of the same unnamed statement read 19,107 buffers under the setting and
   *     55 with the connection back on `auto`), so withholding the name buys
   *     nothing against it and the query would be planned generically anyway.
   *     Rather than report a guarantee it cannot keep, Turbine refuses the
   *     combination and says which of the two settings to change. Only the
   *     setting TURBINE applied is visible: a `plan_cache_mode` installed by a
   *     caller's `SET`, `ALTER ROLE`, or a pooler cannot be seen or refused.
   *   - `false` / omitted changes nothing. It does not opt back out of a
   *     client-level setting, it simply leaves that setting in charge.
   *   - With the client-level `preparedStatements: false`, every statement is
   *     already unnamed, so this option is a no-op for plan choice.
   *
   * COST, and it has two halves.
   *
   * The first is planning. The statement is parsed and planned on every
   * execution instead of once. On a flat read that is in the noise (an unnamed
   * statement also skips the extra Parse/Describe round trip a named one needs
   * on its first execution, so it can even come out ahead). It grows with the
   * size of the statement: a deep `with` tree is a much larger plan, and
   * re-planning it per execution is a measurable share of a fast query's
   * latency. Turn it on where a plan flip is the risk, not everywhere.
   *
   * The second is the one nobody expects: A CUSTOM PLAN IS NOT ALWAYS THE
   * BETTER PLAN. There are real shapes where the generic plan's ignorance is
   * what saves it, and forcing a custom plan forecloses that. Reproduced on
   * PostgreSQL 16.14, `synchronize_seqscans` off, parallel workers off:
   *
   * ```sql
   * CREATE TABLE ev (id bigserial PRIMARY KEY, tenant_id int NOT NULL, pad text);
   * -- 320,000 rows over 800 tenants, inserted in RANDOM physical order
   * INSERT INTO ev (tenant_id, pad)
   *   SELECT t, repeat('x', 60)
   *   FROM (SELECT ((g % 800) + 1) AS t FROM generate_series(1, 320000) g
   *         ORDER BY random()) s
   *   WHERE t <> 400;
   * -- then tenant 400's 80,000 rows LAST, so they all sit past everything above
   * INSERT INTO ev (tenant_id, pad)
   *   SELECT 400, repeat('x', 60) FROM generate_series(1, 80000) g;
   * CREATE INDEX ev_tenant_idx ON ev (tenant_id);
   * ANALYZE ev;   -- relpages 5334, n_distinct 800, correlation 0.004
   *
   * PREPARE q(int, int) AS SELECT * FROM ev WHERE tenant_id = $1 LIMIT $2;
   * -- force_custom_plan : Seq Scan,          Buffers: shared hit=4262
   * -- force_generic_plan: Bitmap Heap Scan,  Buffers: shared hit=71
   * ```
   *
   * 60x, with no `ORDER BY` anywhere. The custom planner knows tenant 400 is
   * 20% of the table, so with `LIMIT 20` it prices a sequential scan as
   * essentially free on the assumption it will stop almost immediately. It is
   * right about how MANY rows match and wrong about WHERE they are: they are
   * all at the end of the heap, so it reads 319,600 non-matching rows first.
   * The generic plan, unable to see the value, estimates 500 rows, takes the
   * bitmap path, and touches one heap block. Re-insert the identical rows in
   * random physical order and the effect vanishes and reverses (custom 2
   * buffers, generic 66): physical CLUSTERING is the variable, not selectivity.
   *
   * Read that carefully before treating it as an argument against this option.
   * On that shape `plan_cache_mode = auto` never promotes (the generic plan's
   * ESTIMATED cost is far higher than the average custom cost, which is exactly
   * the condition under which `auto` refuses), so the default already produces
   * the 4,262-buffer plan and `forceCustomPlan` costs nothing against it. The
   * honest statement is that a generic plan is 60x better there than either the
   * default or this option, and only an explicit client-level
   * `planCacheMode: 'force_generic_plan'` can reach it. The reason to scope
   * this option per query is still real: it is a targeted remedy for a measured
   * flip, not a setting to turn on globally.
   *
   * NON-POSTGRESQL ENGINES. `true` throws {@link UnsupportedFeatureError}
   * (E017), the same refusal the client-level option gives: an engine with no
   * PostgreSQL plan cache has no cached generic plan to keep this query out of,
   * so silently accepting the flag would report a guarantee that was never
   * made. Omitting it (or `false`) is accepted everywhere.
   */
  forceCustomPlan?: boolean | undefined;
  /**
   * Override {@link TurbineConfig.jsonEncoding} for this query: how a `with`
   * clause's relation rows are encoded on the wire.
   *
   * No effect on a query without a `with` clause, which emits no relation JSON
   * at all, and none on `relationLoadStrategy: 'batched'`, whose follow-up
   * queries are flat.
   *
   * PostgreSQL defaults to `'positional'`, which drops the repeated key names
   * from every relation row. Measured on a 50-parent, ~10-child-per-parent read
   * against local PostgreSQL 17: server time 0.685 ms → 0.350 ms and 152 KB →
   * 100 KB on the wire, for byte-identical parsed rows. Every other engine
   * defaults to `'object'` and refuses `'positional'` with
   * {@link UnsupportedFeatureError} (E017).
   *
   * Two reasons to ask for `'object'` on PostgreSQL:
   *
   *   1. READABILITY. A logged positional statement carries no key names, so a
   *      query log or a Studio SQL pane shows `json_build_array(t0."id", …)`
   *      where the object form names each field.
   *   2. `relationLoadStrategy: 'flatten'`. A flattened relation emits no JSON
   *      to encode, so the two are not composed: with `'positional'` active the
   *      flatten plan is refused for the whole query and every relation falls
   *      back to the correlated subquery (same rows, different plan). Setting
   *      `jsonEncoding: 'object'` alongside `'flatten'` is what makes the
   *      flatten plan run.
   *
   * A value that is neither `'object'` nor `'positional'` throws
   * {@link ValidationError} (E003) rather than being ignored.
   */
  jsonEncoding?: JsonEncoding | undefined;
  /**
   * Lock the returned rows of THIS table until the transaction ends
   * (`SELECT ... FOR UPDATE OF "t"` and friends, see {@link RowLock}).
   *
   * Only inside a transaction: outside one the lock is released before the
   * call returns, so the read is refused (E003). Rows loaded through `with`
   * are read, not locked, on every relation strategy; to lock them, run a
   * second locking read on that table. Cannot be combined with `distinct`.
   */
  lock?: RowLock | undefined;
}

/**
 * Streaming reads take the {@link FindManyArgs} surface minus `lock`: a cursor
 * holds its rows across many fetches, so page with `findMany` inside the
 * transaction instead.
 */
export interface FindManyStreamArgs<
  T,
  // biome-ignore lint/complexity/noBannedTypes: {} means "no relations known", matches TypedWithClause default
  R extends object = {},
  W extends TypedWithClause<R> = TypedWithClause<R>,
  S extends Record<string, boolean> | undefined = undefined,
  O extends Record<string, boolean> | undefined = undefined,
> extends Omit<FindManyArgs<T, R, W, S, O>, 'lock'> {
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
  batchSize?: number | undefined;
  /**
   * Close this stream's cursor and release its connection once the consumer
   * has asked for nothing for this many milliseconds (no row from
   * `findManyStream`, no batch from `findManyStreamBatches`). Overrides the
   * client's `streamIdleTimeoutMs` (default 300000, five minutes). `0`
   * disables it for this call.
   *
   * Only a stream that holds a connection between pulls is watched: one that
   * fit in a single batch holds nothing, and one inside `$transaction` rides
   * the caller's connection, which the transaction's own timeout bounds. On
   * expiry Turbine logs `stream-idle-timeout` and the next pull, if one comes,
   * throws `TimeoutError` (E002). Time Turbine spends fetching does not count.
   * A whole number of milliseconds (E003 otherwise).
   */
  idleTimeoutMs?: number | undefined;
}

export interface CreateArgs<
  T,
  // biome-ignore lint/complexity/noBannedTypes: {} means "no relations known", matches QueryInterface default
  R extends object = {},
  S extends Record<string, boolean> | undefined = undefined,
  O extends Record<string, boolean> | undefined = undefined,
  D = never,
> {
  /**
   * Row data. On typed clients, relation names additionally accept nested
   * write ops ({@link NestedCreateOp}): `create` / `connect` / `connectOrCreate`.
   * A generated client passes its `XCreateInput` as `D`, which requires the
   * columns the table requires. `never` (the default) means
   * `CreateDataInput<T, R>`; a defaulted `D = CreateDataInput<T, R>` makes the
   * builder's own `CreateArgs` conversions fail to typecheck.
   */
  data: [D] extends [never] ? CreateDataInput<T, R> : D;
  /**
   * Return only these fields of the written row, instead of the whole row.
   * Keys are checked against `T` (see {@link FieldFlags}) and follow the read
   * rules: an unknown name throws E003, a `select` must name at least one field,
   * and it cannot be combined with `omit`. Narrows the `RETURNING` list itself,
   * so the unselected columns never cross the wire, which is the point on a
   * table with a large JSON or text column. A write never returns a PII-tagged
   * column: naming one here throws (E003), so read the row back with
   * `includePii: UNSAFE` instead.
   */
  select?: FlagsArg<T, S>;
  /**
   * Return the written row without these fields. Same rules as `select`;
   * PII-tagged columns stay excluded, as they are from every default write
   * return.
   */
  omit?: FlagsArg<T, O>;
  /** Query timeout in milliseconds. Rejects with an error if exceeded. */
  timeout?: number | undefined;
}

export interface CreateManyArgs<
  T,
  D = OptionalInput<T>,
  S extends Record<string, boolean> | undefined = undefined,
  O extends Record<string, boolean> | undefined = undefined,
  C extends boolean | undefined = true | undefined,
> {
  /** The rows. A generated client passes its `XCreate` as `D`. */
  data: D[];
  /** Skip rows that conflict on ANY unique constraint (ON CONFLICT DO NOTHING). */
  skipDuplicates?: boolean | undefined;
  /**
   * Conflict handling on ONE named unique key: skip the conflicting rows, or
   * update them. Cannot be combined with `skipDuplicates`. See
   * {@link CreateManyOnConflict}.
   */
  onConflict?: CreateManyOnConflict<T> | undefined;
  /**
   * Return only these fields of the written rows. Same rules as `create()`:
   * a PII-tagged column is never returned, and naming one throws (E003).
   */
  select?: FlagsArg<T, S>;
  /** Return the written rows without these fields. Same rules as `select`. */
  omit?: FlagsArg<T, O>;
  /**
   * `false` resolves to `{ count }`, the number of rows written, instead of the
   * rows. A plain insert then sends no `RETURNING` / `OUTPUT` at all; an
   * `onConflict` call returns only the key columns it needs to refuse two input
   * rows that write one table row. The count is the number of rows the call
   * would otherwise have returned: inserted plus updated, never a row
   * `skipDuplicates` or `ignore` skipped. Cannot be combined with `select` or
   * `omit` (E003). On MySQL, `skipDuplicates` with `false` is E017: a skipped
   * row there counts as written.
   *
   * Typed by `C`, which defaults to the rows form, so args typed ahead of the
   * call (`const args: CreateManyArgs<User> = ...`) still resolve to rows.
   * Pass `false` as `C` to type count-only args ahead of the call, or
   * `boolean` for a flag known only at run time (the result is then either).
   */
  returning?: C;
  /**
   * Opt out of configured {@link GlobalFilters} on the conflict-UPDATE of
   * `onConflict` (inserts are never filtered). See {@link SkipGlobalFilters}.
   */
  skipGlobalFilters?: SkipGlobalFilters | undefined;
  /** Query timeout in milliseconds. Rejects with an error if exceeded. */
  timeout?: number | undefined;
}

/** What `createMany({ returning: false })` resolves to. */
export interface CreateManyCount {
  /** Rows written: inserted plus updated. */
  count: number;
}

/**
 * `createMany`'s result for a `returning` flag `C`: the rows for `true` or no
 * flag, `{ count }` for `false`, either for a `boolean` known only at run time.
 */
export type CreateManyResult<Row, C> = [C] extends [false]
  ? CreateManyCount
  : [C] extends [true | undefined]
    ? Row[]
    : Row[] | CreateManyCount;

/**
 * The columns of the primary key, or of one non-partial unique constraint or
 * index, in any order. A `createMany` conflict target.
 */
export type ConflictTarget<T> = readonly [keyof T & string, ...(keyof T & string)[]];

/**
 * `createMany({ onConflict })`: what to do with a row whose `target` key
 * already exists.
 *
 * - `{ target, ignore: true }` skips it (it is not returned). A conflict on a
 *   DIFFERENT unique key still raises `UniqueConstraintError`.
 * - `{ target, update }` updates the existing row. `update` is a field list
 *   (each listed column takes the incoming row's value) or a per-column
 *   {@link ConflictUpdateData} object. `where` limits the update to existing
 *   rows that match it; a row it excludes is left alone and not returned.
 *
 * The result holds the rows inserted or updated, in no guaranteed order.
 */
export type CreateManyOnConflict<T> =
  | { target: ConflictTarget<T>; ignore: true; update?: undefined; where?: undefined }
  | {
      target: ConflictTarget<T>;
      update: readonly (keyof T & string)[] | ConflictUpdateData<T>;
      where?: WhereClause<T> | undefined;
      ignore?: undefined;
    };

/**
 * The per-column update of a `createMany` conflict. A plain value is the same
 * for every row; an atomic operator, a {@link SqlExpr}, `col(...)` (the
 * existing row) and `expr.excluded(...)` (the incoming row) are per row.
 */
export type ConflictUpdateData<T> = {
  [K in keyof T]?: T[K] | UpdateOperatorInput<T[K]> | SqlExpr<T[K]> | ColumnRef | ExcludedRef | undefined;
};

/** The node kinds an update expression is built from (see {@link SqlExpr}). */
export type SqlExprKind =
  | 'add'
  | 'sub'
  | 'mul'
  | 'div'
  | 'coalesce'
  | 'greatest'
  | 'least'
  | 'case'
  | 'now'
  | 'excluded'
  | 'secondsBetween';

/** Carries the phantom result type of a {@link SqlExpr}. Type-level only. */
declare const SQL_EXPR_RESULT: unique symbol;

/**
 * A SQL expression in update data, built only by the `expr` constructors
 * (`expr.add`, `expr.greatest`, `expr.now`, ...). `V` is the expression's
 * result type, so an expression typechecks only against a column it can be
 * stored in. The node is frozen and branded: a look-alike plain object (what
 * `JSON.parse` produces) is a value, never SQL.
 */
export interface SqlExpr<V = unknown> {
  readonly [SQL_EXPR]: true;
  readonly kind: SqlExprKind;
  readonly args: readonly unknown[];
  /** Phantom: the result type. Never present at run time. */
  readonly [SQL_EXPR_RESULT]?: V;
}

/**
 * `expr.excluded(field)`: the incoming row's value for `field` inside an
 * upsert's update or a `createMany` `onConflict.update` (PostgreSQL's
 * `EXCLUDED."c"`). Refused (E003) anywhere else.
 */
export interface ExcludedRef<F extends string = string> extends SqlExpr<never> {
  readonly [EXCLUDED_REF]: true;
  readonly kind: 'excluded';
  readonly field: F;
}

/**
 * Atomic update operators for a field.
 *
 * `set` works on any type; `increment`, `decrement`, `multiply`, and `divide`
 * are only valid on numeric fields. They generate SQL like
 * `col = col + $n` (and the corresponding `-`, `*`, `/` variants) instead of
 * plain absolute assignments, so they are safe against concurrent writers -
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
 * Update data: each field takes a plain value, an atomic operator object, a
 * {@link SqlExpr} whose result fits the column, or `col(...)` to copy another
 * column of the same row. Back-compatible with `Partial<T>`: plain values
 * still typecheck unchanged.
 */
export type UpdateInput<T> = {
  [K in keyof T]?: T[K] | UpdateOperatorInput<T[K]> | SqlExpr<T[K]> | ColumnRef | undefined;
};

/**
 * `Partial<T>` that also admits an explicit `undefined` per key, which every
 * write path treats as "leave this column out". Spelled out so a consumer
 * compiling with `exactOptionalPropertyTypes` can pass `{ name: maybeName }`.
 */
export type OptionalInput<T> = {
  [K in keyof T]?: T[K] | undefined;
};

/**
 * The write and lookup input types one table's accessor uses. A generated
 * client passes its per-table `XInputs` interface as the third type argument
 * of `QueryInterface`; untyped clients get {@link DefaultInputTypes}.
 */
export interface TableInputTypes {
  /** `create()` data, nested relation writes included. */
  create: object;
  /** One row of `createMany()` data, and `upsert()`'s `create`. */
  createMany: object;
  /** `update()` data, nested relation writes included. */
  update: object;
  /** `updateMany()` data, and `upsert()`'s `update`. */
  updateMany: object;
  /** The unique-key selector for `findUnique` / `upsert` (`unknown` when unknown). */
  whereUnique: unknown;
}

/** The {@link TableInputTypes} an accessor uses when no generated input types are supplied. */
// biome-ignore lint/complexity/noBannedTypes: {} means "no relations known", matches QueryInterface default
export interface DefaultInputTypes<T, R extends object = {}> extends TableInputTypes {
  /** `never` selects {@link CreateArgs}' own default, `CreateDataInput<T, R>`. */
  create: never;
  createMany: OptionalInput<T>;
  update: UpdateDataInput<T, R>;
  updateMany: UpdateInput<T>;
  whereUnique: unknown;
}

export interface UpdateArgs<
  T,
  // biome-ignore lint/complexity/noBannedTypes: {} means "no relations known", matches QueryInterface default
  R extends object = {},
  S extends Record<string, boolean> | undefined = undefined,
  O extends Record<string, boolean> | undefined = undefined,
  D = UpdateDataInput<T, R>,
> {
  /** Row selector. Keys are checked against `T` and `R` (see {@link WhereClause}). */
  where: WhereClause<T, R>;
  /**
   * Update data. On typed clients, relation names additionally accept nested
   * write ops ({@link NestedUpdateOp}): `create` / `connect` / `connectOrCreate`
   * / `disconnect` / `set` / `delete` / `update` / `upsert`.
   */
  data: D;
  /**
   * Return only these fields of the updated row, instead of the whole row.
   * Keys are checked against `T` (see {@link FieldFlags}) and follow the read
   * rules: an unknown name throws E003, a `select` must name at least one field,
   * and it cannot be combined with `omit`. Narrows the `RETURNING` list itself,
   * so the unselected columns never cross the wire, which is the point on a
   * table with a large JSON or text column. A write never returns a PII-tagged
   * column: naming one here throws (E003), so read the row back with
   * `includePii: UNSAFE` instead.
   */
  select?: FlagsArg<T, S>;
  /**
   * Return the updated row without these fields. Same rules as `select`;
   * PII-tagged columns stay excluded, as they are from every default write
   * return.
   */
  omit?: FlagsArg<T, O>;
  /** Query timeout in milliseconds. Rejects with an error if exceeded. */
  timeout?: number | undefined;
  /**
   * Opt in to running this mutation when `where` resolves to an empty
   * predicate (e.g. `{}` or `{ id: undefined }`). Default `false`, an
   * empty predicate throws `ValidationError` to catch the common case of
   * a filter value accidentally being `undefined`.
   *
   * PRIVILEGE OPTION: unlocked by the {@link UNSAFE} sentinel only
   * (`allowFullTableScan: UNSAFE`), and only when an unconditional mutation is
   * genuinely the intent. A literal `true` throws (E003): this guard is the
   * last thing standing between a spread request body and an unconditional
   * `UPDATE` / `DELETE` over the whole table.
   */
  allowFullTableScan?: Unsafe | undefined;
  /**
   * Optimistic locking, prevents lost updates in concurrent scenarios.
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
  optimisticLock?: { field: keyof T & string; expected: number } | undefined;
  /** Opt out of configured {@link GlobalFilters}. See {@link SkipGlobalFilters}. */
  skipGlobalFilters?: SkipGlobalFilters | undefined;
}

// biome-ignore lint/complexity/noBannedTypes: {} means "no relations known", matches QueryInterface default
export interface UpdateManyArgs<T, R extends object = {}, D = UpdateInput<T>> {
  where: WhereClause<T, R>;
  data: D;
  /** Query timeout in milliseconds. Rejects with an error if exceeded. */
  timeout?: number | undefined;
  /** See {@link UpdateArgs.allowFullTableScan}. */
  allowFullTableScan?: Unsafe | undefined;
  /** Opt out of configured {@link GlobalFilters}. See {@link SkipGlobalFilters}. */
  skipGlobalFilters?: SkipGlobalFilters | undefined;
}

export interface DeleteArgs<
  T,
  // biome-ignore lint/complexity/noBannedTypes: {} means "no relations known", matches QueryInterface default
  R extends object = {},
  S extends Record<string, boolean> | undefined = undefined,
  O extends Record<string, boolean> | undefined = undefined,
> {
  where: WhereClause<T, R>;
  /**
   * Return only these fields of the deleted row, instead of the whole row.
   * Keys are checked against `T` (see {@link FieldFlags}) and follow the read
   * rules: an unknown name throws E003, a `select` must name at least one field,
   * and it cannot be combined with `omit`. Narrows the `RETURNING` list itself,
   * so the unselected columns never cross the wire, which is the point on a
   * table with a large JSON or text column. A write never returns a PII-tagged
   * column: naming one here throws (E003), so read the row back with
   * `includePii: UNSAFE` instead.
   */
  select?: FlagsArg<T, S>;
  /**
   * Return the deleted row without these fields. Same rules as `select`;
   * PII-tagged columns stay excluded, as they are from every default write
   * return.
   */
  omit?: FlagsArg<T, O>;
  /** Query timeout in milliseconds. Rejects with an error if exceeded. */
  timeout?: number | undefined;
  /** See {@link UpdateArgs.allowFullTableScan}. */
  allowFullTableScan?: Unsafe | undefined;
  /** Opt out of configured {@link GlobalFilters}. See {@link SkipGlobalFilters}. */
  skipGlobalFilters?: SkipGlobalFilters | undefined;
}

// biome-ignore lint/complexity/noBannedTypes: {} means "no relations known", matches QueryInterface default
export interface DeleteManyArgs<T, R extends object = {}> {
  where: WhereClause<T, R>;
  /** Query timeout in milliseconds. Rejects with an error if exceeded. */
  timeout?: number | undefined;
  /** See {@link UpdateArgs.allowFullTableScan}. */
  allowFullTableScan?: Unsafe | undefined;
  /** Opt out of configured {@link GlobalFilters}. See {@link SkipGlobalFilters}. */
  skipGlobalFilters?: SkipGlobalFilters | undefined;
}

export interface UpsertArgs<
  T,
  // biome-ignore lint/complexity/noBannedTypes: {} means "no relations known", matches QueryInterface default
  R extends object = {},
  S extends Record<string, boolean> | undefined = undefined,
  O extends Record<string, boolean> | undefined = undefined,
  U = unknown,
  C = OptionalInput<T>,
  D = UpdateInput<T>,
> {
  /** The row to update. A generated client passes its `XWhereUnique` as `U`, so this names a unique key. */
  where: U & WhereClause<T, R>;
  /**
   * Return only these fields of the inserted or updated row, instead of the whole row.
   * Keys are checked against `T` (see {@link FieldFlags}) and follow the read
   * rules: an unknown name throws E003, a `select` must name at least one field,
   * and it cannot be combined with `omit`. Narrows the `RETURNING` list itself,
   * so the unselected columns never cross the wire, which is the point on a
   * table with a large JSON or text column. A write never returns a PII-tagged
   * column: naming one here throws (E003), so read the row back with
   * `includePii: UNSAFE` instead.
   */
  select?: FlagsArg<T, S>;
  /**
   * Return the inserted or updated row without these fields. Same rules as `select`;
   * PII-tagged columns stay excluded, as they are from every default write
   * return.
   */
  omit?: FlagsArg<T, O>;
  /** The row to insert when `where` matches nothing. Plain values only: there is no stored value to operate on yet. */
  create: C;
  /**
   * Applied to the existing row on conflict. Each field takes a plain value or
   * the same atomic {@link UpdateOperatorInput} `update()` takes, so
   * `count: { increment: 1 }` adds to the stored value instead of overwriting
   * it. Scalar fields only: nested relation writes are not part of an upsert.
   */
  update: D;
  /** Query timeout in milliseconds. Rejects with an error if exceeded. */
  timeout?: number | undefined;
  /** Opt out of configured {@link GlobalFilters}. See {@link SkipGlobalFilters}. */
  skipGlobalFilters?: SkipGlobalFilters | undefined;
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
// biome-ignore lint/complexity/noBannedTypes: {} means "target has no relations", matches RelationDescriptor default
export interface ConnectOrCreateOp<T, TR extends object = {}> {
  where: Partial<T>;
  create: CreateDataInput<T, TR>;
}

/** Nested write ops valid inside `create()` data for a relation field. */
// biome-ignore lint/complexity/noBannedTypes: {} means "target has no relations", matches RelationDescriptor default
export interface NestedCreateOp<T, TR extends object = {}> {
  create?: CreateDataInput<T, TR> | CreateDataInput<T, TR>[] | undefined;
  connect?: Partial<T> | Partial<T>[] | undefined;
  connectOrCreate?: ConnectOrCreateOp<T, TR> | ConnectOrCreateOp<T, TR>[] | undefined;
}

/** A nested `update` op item: update the related row(s) matching `where`. `where` is optional for belongsTo relations (derived from the parent's FK). */
// biome-ignore lint/complexity/noBannedTypes: {} means "target has no relations", matches RelationDescriptor default
export interface NestedUpdateOpItem<T, TR extends object = {}> {
  where?: Partial<T> | undefined;
  data: UpdateDataInput<T, TR>;
}

/** A nested `upsert` op item: update the row matching `where` or create it. */
// biome-ignore lint/complexity/noBannedTypes: {} means "target has no relations", matches RelationDescriptor default
export interface NestedUpsertOpItem<T, TR extends object = {}> {
  where: Partial<T>;
  create: CreateDataInput<T, TR>;
  update: UpdateDataInput<T, TR>;
}

/**
 * Nested write ops for a belongsTo relation inside `create()` data. The row
 * points at ONE target, so each op takes a single object.
 */
// biome-ignore lint/complexity/noBannedTypes: {} means "target has no relations", matches RelationDescriptor default
export interface NestedToOneCreateOp<T, TR extends object = {}> {
  create?: CreateDataInput<T, TR> | undefined;
  connect?: Partial<T> | undefined;
  connectOrCreate?: ConnectOrCreateOp<T, TR> | undefined;
}

/**
 * Nested write ops for a belongsTo relation inside `update()` data, with
 * Prisma's to-one rules: single objects, no `set`, and `disconnect` /
 * `delete` take `true` (or `{}`) for the connected row, `false` for a no-op,
 * or a filter the connected row must match. At most one of create, connect,
 * connectOrCreate, disconnect and delete per write (refused at runtime).
 */
// biome-ignore lint/complexity/noBannedTypes: {} means "target has no relations", matches RelationDescriptor default
export interface NestedToOneUpdateOp<T, TR extends object = {}> extends NestedToOneCreateOp<T, TR> {
  disconnect?: boolean | Partial<T> | undefined;
  delete?: boolean | Partial<T> | undefined;
  /** Update the row this record points at. */
  update?: { data: UpdateDataInput<T, TR> } | undefined;
  upsert?: NestedUpsertOpItem<T, TR> | undefined;
}

/** Nested write ops valid inside `update()` data for a relation field. */
// biome-ignore lint/complexity/noBannedTypes: {} means "target has no relations", matches RelationDescriptor default
export interface NestedUpdateOp<T, TR extends object = {}> {
  create?: CreateDataInput<T, TR> | CreateDataInput<T, TR>[] | undefined;
  connect?: Partial<T> | Partial<T>[] | undefined;
  connectOrCreate?: ConnectOrCreateOp<T, TR> | ConnectOrCreateOp<T, TR>[] | undefined;
  disconnect?: Partial<T> | Partial<T>[] | undefined;
  set?: Partial<T>[] | undefined;
  delete?: Partial<T> | Partial<T>[] | undefined;
  update?: NestedUpdateOpItem<T, TR> | NestedUpdateOpItem<T, TR>[] | undefined;
  upsert?: NestedUpsertOpItem<T, TR> | NestedUpsertOpItem<T, TR>[] | undefined;
}

/**
 * `create()` data input. When the relations map `R` is known (typed clients),
 * each relation name additionally accepts a {@link NestedCreateOp} for the
 * relation's target entity, recursively, via the target's own relations map.
 * When `R` is `{}` (untyped escape hatch) this collapses to plain `Partial<T>`.
 */
// biome-ignore lint/complexity/noBannedTypes: {} means "no relations known", matches QueryInterface default
export type CreateDataInput<T, R extends object = {}> = [keyof R] extends [never]
  ? OptionalInput<T>
  : OptionalInput<T> & {
      [K in keyof R]?: IsBelongsTo<R[K]> extends true
        ? NestedToOneCreateOp<RelationTarget<R[K]> & object, RelationRelations<R[K]> & object>
        : NestedCreateOp<RelationTarget<R[K]> & object, RelationRelations<R[K]> & object>;
    };

/**
 * `update()` data input. Like {@link CreateDataInput} but relation fields
 * accept the full {@link NestedUpdateOp} surface (disconnect / set / delete /
 * update / upsert in addition to the create-context ops), and scalar fields
 * accept atomic {@link UpdateOperatorInput} objects.
 */
// biome-ignore lint/complexity/noBannedTypes: {} means "no relations known", matches QueryInterface default
export type UpdateDataInput<T, R extends object = {}> = [keyof R] extends [never]
  ? UpdateInput<T>
  : UpdateInput<T> & {
      [K in keyof R]?: IsBelongsTo<R[K]> extends true
        ? NestedToOneUpdateOp<RelationTarget<R[K]> & object, RelationRelations<R[K]> & object>
        : NestedUpdateOp<RelationTarget<R[K]> & object, RelationRelations<R[K]> & object>;
    };

// biome-ignore lint/complexity/noBannedTypes: {} means "no relations known", matches QueryInterface default
export interface CountArgs<T, R extends object = {}> {
  where?: WhereClause<T, R> | undefined;
  /** Query timeout in milliseconds. Rejects with an error if exceeded. */
  timeout?: number | undefined;
  /** Opt out of configured {@link GlobalFilters}. See {@link SkipGlobalFilters}. */
  skipGlobalFilters?: SkipGlobalFilters | undefined;
  /** Plan this query with its real parameter values. See {@link FindManyArgs.forceCustomPlan}. */
  forceCustomPlan?: boolean | undefined;
}

/**
 * Comparison operators usable inside a `having` aggregate filter. A bare value
 * is shorthand for equality (`COUNT(*) = $n`); the operator object supports
 * range and inequality comparisons. Mirrors the comparison subset of
 * {@link WhereOperator} so the same SQL machinery can be reused.
 *
 * `V` is the operand type: `number` for `_sum` / `_avg` / `_count`, the
 * column's own type for `_min` / `_max` (those return a stored cell, so
 * `MIN("title") > 'm'` is as valid as `MIN("views") > 10`).
 */
export interface HavingComparisonOperator<V = number> {
  equals?: V | undefined;
  not?: V | undefined;
  gt?: V | undefined;
  gte?: V | undefined;
  lt?: V | undefined;
  lte?: V | undefined;
  in?: V[] | undefined;
  notIn?: V[] | undefined;
}

/** The number-operand spelling, kept as the historical public name. */
export type HavingNumericOperator = HavingComparisonOperator<number>;

/** A single having predicate value: a bare value (equality) or an operator object. */
export type HavingFilter<V = number> = V | HavingComparisonOperator<V>;

/**
 * Per-field aggregate filters inside a {@link HavingClause}. Each aggregate
 * function maps to a {@link HavingFilter} comparison on that field.
 *
 * @example
 *   viewCount: { _sum: { gt: 100 }, _avg: { lte: 50 } }
 */
export interface HavingAggregateFilter<V = unknown> {
  _sum?: HavingFilter | undefined;
  _avg?: HavingFilter | undefined;
  _min?: HavingFilter<V> | undefined;
  _max?: HavingFilter<V> | undefined;
  _count?: HavingFilter | undefined;
}

/**
 * One field entry of a {@link HavingClause}. Following Prisma, a field accepts
 * BOTH an aggregate filter (`{ _sum: { gt: 100 } }`) and a scalar filter on the
 * grouped value itself (`{ not: null }`, `{ in: ['a', 'b'] }`, or a bare value
 * as equality shorthand), including both in the same object, which are ANDed.
 *
 * A scalar filter is only legal on a column listed in `by`: the group's value
 * is constant within the group, so it compiles into HAVING against the bare
 * group key. On any other column it throws {@link ValidationError} E003, since
 * a non-grouped column cannot be referenced in HAVING at all.
 */
export type HavingFieldFilter<V = unknown> = (HavingAggregateFilter<V> & WhereOperator<V>) | WhereValue<V>;

/**
 * HAVING clause for `groupBy`, filters whole groups by their aggregate values
 * and by the grouped values themselves (the SQL `HAVING` clause). Follows
 * Prisma's shape: each field maps to a {@link HavingFieldFilter}, the special
 * top-level `_count` key (no field) filters on `COUNT(*)`, and `AND` / `OR` /
 * `NOT` combine predicates at any depth.
 *
 * Implemented as a mapped type so the special keys can carry their own value
 * types while every entity field carries a {@link HavingFieldFilter}, without
 * the index-signature conflict an intersection type would produce when `T` is
 * a broad `Record<string, unknown>`.
 *
 * @example
 *   // groups with more than 5 rows whose summed viewCount is at least 100
 *   having: { _count: { gt: 5 }, viewCount: { _sum: { gte: 100 } } }
 * @example
 *   // by: ['typeId'] , drop the NULL group, keep busy groups
 *   having: { typeId: { not: null }, _count: { gt: 1 } }
 */
export type HavingClause<T> = {
  /** Filter on `COUNT(*)` for the whole group. */
  _count?: HavingFilter | undefined;
  AND?: HavingClause<T> | HavingClause<T>[] | undefined;
  OR?: HavingClause<T>[] | undefined;
  NOT?: HavingClause<T> | HavingClause<T>[] | undefined;
} & {
  [K in keyof T & string]?: HavingFieldFilter<T[K]> | undefined;
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
  alias?: string | undefined;
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
  type?: 'numeric' | 'text' | undefined;
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
  _count?: OrderDirection | OrderBySpec | undefined;
  /** Order by a requested `_sum` aggregate, keyed by its field/alias. */
  _sum?: GroupByAggregateOrderBy | undefined;
  /** Order by a requested `_avg` aggregate, keyed by its field/alias. */
  _avg?: GroupByAggregateOrderBy | undefined;
  /** Order by a requested `_min` aggregate, keyed by its field/alias. */
  _min?: GroupByAggregateOrderBy | undefined;
  /** Order by a requested `_max` aggregate, keyed by its field/alias. */
  _max?: GroupByAggregateOrderBy | undefined;
  /** A by-column field name or JSON group-key alias → direction or sort spec. */
  [key: string]: OrderDirection | OrderBySpec | GroupByAggregateOrderBy | undefined;
}

// biome-ignore lint/complexity/noBannedTypes: {} means "no relations known", matches QueryInterface default
export interface GroupByArgs<T, R extends object = {}> {
  /** Group keys: plain column field names and/or JSON-path keys ({@link JsonPathGroupKey}). */
  by: ((keyof T & string) | JsonPathGroupKey)[];
  where?: WhereClause<T, R> | undefined;
  /**
   * PostgreSQL only: group over one representative row per column combination
   * (`SELECT DISTINCT ON … ORDER BY …` row source). See {@link GroupByDistinctOn}.
   */
  distinctOn?: GroupByDistinctOn<T> | undefined;
  /**
   * Count each group. `true` (or omitted) → `_count: number` (COUNT(*)). The
   * record form counts per selection: the reserved `_all: true` key → COUNT(*),
   * and each entity field key → COUNT(that column), yielding
   * `_count: { _all: n, field: n }` (Prisma parity). Ordering/HAVING on `_count`
   * stays available whenever COUNT(*) is selected (`true`, omitted, or `_all`).
   */
  _count?: true | ({ _all?: true } & Partial<Record<keyof T & string, boolean>>) | undefined;
  /** Sum of numeric fields (or JSON paths: see {@link JsonPathAggregateTarget}) in each group */
  _sum?: GroupByAggregateSpec<T> | undefined;
  /** Average of numeric fields (or JSON paths) in each group */
  _avg?: GroupByAggregateSpec<T> | undefined;
  /** Minimum value of fields (or JSON paths) in each group */
  _min?: GroupByAggregateSpec<T> | undefined;
  /** Maximum value of fields (or JSON paths) in each group */
  _max?: GroupByAggregateSpec<T> | undefined;
  /**
   * Percentiles of fields, or of expressions, in each group (PostgreSQL only).
   * See {@link PercentileSpec} and {@link PercentileExprSpec}.
   */
  _percentile?: PercentileArgs<T> | undefined;
  /** Filter whole groups by their aggregate values (SQL HAVING). JSON-path aggregates key by their alias. */
  having?: HavingClause<T> | undefined;
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
  orderBy?: GroupByOrderBy | GroupByOrderBy[] | undefined;
  /**
   * Cap the number of result groups (`LIMIT`, applied after `ORDER BY`). Useful
   * for "top N groups" queries; pair with `orderBy` for a deterministic set.
   */
  limit?: number | undefined;
  /**
   * Skip this many result groups (`OFFSET`, applied after `ORDER BY`). Paginates
   * grouped results; combine with `limit` and a deterministic `orderBy`.
   */
  offset?: number | undefined;
  /**
   * Opt in to grouping on / aggregating PII-tagged (`defineSchema` `pii: true`)
   * columns. A PII column in `by`, and `_min` / `_max` / `_percentile` over a
   * PII column, return STORED VALUES, so without this they throw
   * `ValidationError` (E003). `_count` (a count, not a value), `_sum` / `_avg`,
   * and `where` / `orderBy` / `having` on PII columns stay allowed.
   *
   * PRIVILEGE OPTION: unlocked by the {@link UNSAFE} sentinel only. See
   * {@link FindManyArgs.includePii}.
   */
  includePii?: Unsafe | undefined;
  /** Query timeout in milliseconds. Rejects with an error if exceeded. */
  timeout?: number | undefined;
  /** Opt out of configured {@link GlobalFilters}. See {@link SkipGlobalFilters}. */
  skipGlobalFilters?: SkipGlobalFilters | undefined;
  /** Plan this query with its real parameter values. See {@link FindManyArgs.forceCustomPlan}. */
  forceCustomPlan?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// GroupByResult: compute the typed result-row shape from the groupBy args
// ---------------------------------------------------------------------------

/** The by-key union of a groupBy args type (array element type of `by`). */
type GroupByKeys<A> = A extends { by: infer BY } ? (BY extends readonly unknown[] ? BY[number] : never) : never;

/** The subset of `by` keys that are plain string field names on the entity `T`. */
type GroupByFieldKeys<T, A> = Extract<GroupByKeys<A>, keyof T & string>;

/**
 * `_sum` / `_avg` result block: every requested key maps to
 * `number | string | null`. A `string` comes back for an int8 / bigint or
 * numeric / decimal source column, whose SUM and AVG PostgreSQL widens to
 * arbitrary-precision `numeric` and whose exact text is returned to avoid
 * precision loss (see {@link AggregateResult}); every other column, and every
 * JSON-path aggregate, is a `number`; `null` is an aggregate over zero
 * matching rows. Present only when the args actually requested the block. A
 * JSON-path aggregate target keys by its arg key (the alias), so `keyof S`
 * covers both plain columns and JSON aliases.
 */
type GroupBySumAvgPart<A, Key extends '_sum' | '_avg'> = A extends { [P in Key]: infer S }
  ? [S] extends [object]
    ? { [P in Key]: { [K in keyof S & string]: number | string | null } }
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
export type GroupByResult<T, A> = { [K in GroupByFieldKeys<T, A>]: T[K] } & GroupByCountPart<A> &
  GroupBySumAvgPart<A, '_sum'> &
  GroupBySumAvgPart<A, '_avg'> &
  GroupByMinMaxPart<T, A, '_min'> &
  GroupByMinMaxPart<T, A, '_max'> &
  PercentilePart<T, A>;

/**
 * The `_count` block on a groupBy result row. Scalar `_count: true` (or an
 * omitted `_count`, which still selects COUNT(*) by default) yields a plain
 * `number`; the record form (`_count: { _all: true, field: true }`) yields a
 * per-selection object `{ _all: number, field: number }` (Prisma parity). Kept
 * additive: existing `_count: true` / no-`_count` calls still infer `number`.
 */
type GroupByCountPart<A> = A extends { _count: infer C }
  ? C extends true
    ? { _count: number }
    : [C] extends [object]
      ? { _count: { [K in keyof C & string]: number } }
      : { _count: number }
  : { _count: number };

/** Arguments for the standalone aggregate method */
// biome-ignore lint/complexity/noBannedTypes: {} means "no relations known", matches QueryInterface default
export interface AggregateArgs<T, R extends object = {}> {
  where?: WhereClause<T, R> | undefined;
  /**
   * Count rows. `true` → `_count: number` (COUNT(*)). The record form counts per
   * selection: the reserved `_all: true` key → COUNT(*), and each entity field
   * key → COUNT(that column) (non-null count), yielding
   * `_count: { _all: n, field: n }` (Prisma parity).
   */
  _count?: true | ({ _all?: true } & Partial<Record<keyof T & string, boolean>>) | undefined;
  /** Sum of numeric fields */
  _sum?: Partial<Record<keyof T & string, boolean>> | undefined;
  /** Average of numeric fields */
  _avg?: Partial<Record<keyof T & string, boolean>> | undefined;
  /** Minimum value of fields */
  _min?: Partial<Record<keyof T & string, boolean>> | undefined;
  /** Maximum value of fields */
  _max?: Partial<Record<keyof T & string, boolean>> | undefined;
  /**
   * Percentiles of fields (PostgreSQL only; other engines throw E017).
   *
   * ```ts
   * const s = await db.requests.aggregate({
   *   _percentile: { latencyMs: { p: [0.5, 0.95, 0.99] }, statusCode: { p: 0.5, method: 'disc' } },
   * });
   * s._percentile.latencyMs;  // number[] | null
   * s._percentile.statusCode; // number | null
   * ```
   *
   * A key that names no field computes the percentile of an expression,
   * given as `of`:
   *
   * ```ts
   * const s = await db.jobs.aggregate({
   *   _percentile: { wait: { of: expr.secondsBetween(col('requestedAt'), col('readyAt')), p: 0.95 } },
   * });
   * s._percentile.wait; // number | null, in seconds
   * ```
   *
   * See {@link PercentileSpec} and {@link PercentileExprSpec}.
   */
  _percentile?: PercentileArgs<T> | undefined;
  /**
   * Opt in to aggregating PII-tagged (`defineSchema` `pii: true`) columns.
   * `_min` / `_max` / `_percentile` return a STORED VALUE (or one that equals a
   * stored value), so without this they throw `ValidationError` (E003) on a PII
   * column. `_count` (a count, not a value) and `_sum` / `_avg` (a computed
   * total over many rows) stay allowed, as do `where` filters on PII columns.
   *
   * PRIVILEGE OPTION: unlocked by the {@link UNSAFE} sentinel only. See
   * {@link FindManyArgs.includePii}.
   */
  includePii?: Unsafe | undefined;
  /** Query timeout in milliseconds. Rejects with an error if exceeded. */
  timeout?: number | undefined;
  /** Opt out of configured {@link GlobalFilters}. See {@link SkipGlobalFilters}. */
  skipGlobalFilters?: SkipGlobalFilters | undefined;
  /** Plan this query with its real parameter values. See {@link FindManyArgs.forceCustomPlan}. */
  forceCustomPlan?: boolean | undefined;
}

/**
 * Result type for aggregate queries.
 *
 * `_sum` / `_avg` are a `number` for int2 / int4 / float columns and a
 * `string` for int8 / bigint and numeric / decimal columns: PostgreSQL widens
 * SUM and AVG over those to arbitrary-precision `numeric`, and the exact text
 * is returned to avoid precision loss, the same policy under which a `numeric`
 * column value and an int8 value above 2^53 - 1 read back as strings. `null`
 * is an aggregate over zero rows.
 */
export interface AggregateResult<T> {
  _count?: number | Record<string, number>;
  _sum?: Partial<Record<keyof T & string, number | string | null>>;
  _avg?: Partial<Record<keyof T & string, number | string | null>>;
  _min?: Partial<Record<keyof T & string, unknown>>;
  _max?: Partial<Record<keyof T & string, unknown>>;
  _percentile?: Partial<Record<keyof T & string, unknown>>;
}

/**
 * The result of `aggregate(args)`, derived from the args: only the blocks the
 * call requested are present, each keyed by exactly the requested fields.
 * `_sum` / `_avg` follow {@link AggregateResult}'s number-or-string rule;
 * `_min` / `_max` carry the column's own type, or `null` over zero rows;
 * `_percentile` follows {@link PercentileSpec}.
 */
export type AggregateResultOf<T, A> = AggregateCountPart<A> &
  GroupBySumAvgPart<A, '_sum'> &
  GroupBySumAvgPart<A, '_avg'> &
  AggregateMinMaxPart<T, A, '_min'> &
  AggregateMinMaxPart<T, A, '_max'> &
  PercentilePart<T, A>;

/**
 * One `_percentile` entry: which fractions of a column to compute.
 *
 * - `p`: a fraction in [0, 1], or a non-empty array of them. The result
 *   mirrors the shape: a scalar for a number, an array (in the same order)
 *   for an array. A fraction outside [0, 1], `NaN` or `[]` throws E003.
 * - `method`: `'cont'` (the default, `percentile_cont`) interpolates between
 *   the two nearest values, so it needs a numeric or interval column. It
 *   returns a `number` (a numeric or int8 column included), or an interval
 *   read the way the column reads. `'cont'` on a date/time column throws E003.
 *   `'disc'` (`percentile_disc`) returns an actual stored value of the
 *   column, so it works on any sortable column and carries the column's own
 *   type.
 *
 * Over zero rows the result is `null` (the whole array in the array form).
 * Both methods need `includePii: UNSAFE` on a PII-tagged column.
 */
export interface PercentileSpec {
  p: number | readonly number[];
  method?: PercentileMethod | undefined;
  /** Only on a key that names no field: see {@link PercentileExprSpec}. */
  of?: undefined;
}

/**
 * One `_percentile` entry over an expression, under a key that names no field
 * (the key is only the result's name and never reaches the SQL).
 *
 * - `of`: a numeric expression over the row's own columns, built with
 *   {@link expr}: arithmetic (`expr.add` / `sub` / `mul` / `div`),
 *   `expr.coalesce` / `greatest` / `least` / `case`, and
 *   `expr.secondsBetween(col('a'), col('b'))` for the seconds from one
 *   timestamp column to another. Bound values must be numbers or bigints.
 *   `col('x')` alone is refused: use the field key `x` instead.
 * - `p` and `method` as in {@link PercentileSpec}. The expression is ordered as
 *   double precision, so the result is a `number` for both methods (an integer
 *   beyond 2^53 loses exactness).
 *
 * Every column the expression reads as a value needs `includePii: UNSAFE`
 * when it is PII-tagged; columns read only by an `expr.case` arm's `when` do
 * not. Over zero rows the result is `null`.
 */
export interface PercentileExprSpec {
  of: SqlExpr<number | bigint | string>;
  p: number | readonly number[];
  method?: PercentileMethod | undefined;
}

/**
 * The `_percentile` argument: field keys take a {@link PercentileSpec}; any
 * other key names an expression's result and takes a {@link PercentileExprSpec}.
 * On an untyped table (`keyof T` is `string`) any key takes either: the
 * `string` key is dropped from the field half, which would otherwise narrow
 * every key to a field spec.
 */
export type PercentileArgs<T> = {
  [K in keyof T & string as string extends K ? never : K]?: PercentileSpec | undefined;
} & {
  [name: string]: PercentileSpec | PercentileExprSpec | undefined;
};

/**
 * `_percentile` naming fields only. `aggregate` / `groupBy` take args of this
 * shape when their type is generic, where {@link PercentileKeysChecked} cannot
 * read the keys, so a wrapper generic over its args still compiles.
 */
export type FieldPercentiles<T> = {
  _percentile?: { [K in keyof T & string]?: PercentileSpec | undefined } | undefined;
};

/**
 * Applied to `aggregate` / `groupBy` arguments: every `_percentile` key that
 * names no field must carry `of`, so a misspelled field name is a compile
 * error rather than an expression percentile with no expression.
 */
export type PercentileKeysChecked<T, A> = A extends { _percentile: infer S }
  ? [S] extends [object]
    ? { _percentile: { [K in keyof S]: K extends keyof T ? S[K] : PercentileExprSpec | undefined } }
    : unknown
  : unknown;

/** `'cont'` interpolates (`percentile_cont`); `'disc'` returns a stored value (`percentile_disc`). */
export type PercentileMethod = 'cont' | 'disc';

/** One percentile value: the column's own type for `disc`; for `cont` a number, or an interval as the column reads. */
type PercentileScalar<T, K, Spec> = Spec extends { of: object }
  ? number
  : K extends keyof T
    ? Spec extends { method: 'disc' }
      ? NonNullable<T[K]>
      : [NonNullable<T[K]>] extends [number]
        ? number
        : number | NonNullable<T[K]>
    : unknown;

/** A scalar `p` yields one value, an array `p` yields an array, `null` over zero rows. */
type PercentileValue<T, K, Spec> = Spec extends { p: infer P }
  ? P extends readonly number[]
    ? PercentileScalar<T, K, Spec>[] | null
    : PercentileScalar<T, K, Spec> | null
  : unknown;

/** The `_percentile` block of an aggregate or groupBy result, present only when requested. */
type PercentilePart<T, A> = A extends { _percentile: infer S }
  ? [S] extends [object]
    ? { _percentile: { [K in keyof S & string]: PercentileValue<T, K, S[K]> } }
    : unknown
  : unknown;

type AggregateCountPart<A> = A extends { _count: infer C }
  ? C extends true
    ? { _count: number }
    : [C] extends [object]
      ? { _count: { [K in keyof C & string]: number } }
      : unknown
  : unknown;

type AggregateMinMaxPart<T, A, Key extends '_min' | '_max'> = A extends { [P in Key]: infer S }
  ? [S] extends [object]
    ? { [P in Key]: { [K in keyof S & string]: (K extends keyof T ? T[K] : unknown) | null } }
    : unknown
  : unknown;

/** Relation filter operators for where clauses */
export interface RelationFilter {
  some?: Record<string, unknown> | undefined;
  every?: Record<string, unknown> | undefined;
  none?: Record<string, unknown> | undefined;
  /** To-one relation match (bare objects on to-one keys are implicit `is`). */
  is?: Record<string, unknown> | undefined;
  isNot?: Record<string, unknown> | undefined;
}

/**
 * JSONB query operators for where clauses.
 *
 * `{ path, equals }` compares the JSON VALUE at `path`, typed:
 *   - PostgreSQL: `(col #> path)::jsonb = $v::jsonb`, so `equals: 7` matches a
 *     JSON number 7 and not the string `"7"`, `equals: null` matches a JSON
 *     null (not a missing key), and arrays and objects compare as JSON.
 *   - SQLite: `json_extract` keeps numbers and strings apart; `equals` with a
 *     boolean, null, array or object throws `UnsupportedFeatureError` (E017),
 *     because SQLite extracts JSON booleans as 1 / 0 and null, arrays and
 *     objects have no comparable form there.
 *   - MySQL and SQL Server compare the extracted TEXT, so `equals: 7` also
 *     matches `"7"`; null, arrays and objects throw E017.
 *
 * PowDB (`turbine-orm/powdb`) evaluates `->` path filters with full type
 * knowledge:
 *   - `{ path, equals: null }` matches JSON null OR a MISSING key on PowDB
 *     (compiles to `is null`); PostgreSQL matches JSON null only.
 *   - equality is TYPE-STRICT: `{ path, equals: 7 }` matches a stored JSON int
 *     `7` but not `7.0` or the JSON string `"7"`. Range ops (`gt`/`lt`/…) still
 *     coerce int/float numerically.
 *   - a digit-only path segment (`path: ['tags', '0']`) is an ARRAY INDEX on
 *     both PowDB and the SQL engines (a json object key that is literally `"0"`
 *     is likewise addressed by index).
 *   - `contains`, and `equals` WITHOUT a `path` (whole-document containment),
 *     throw `UnsupportedFeatureError` (E017) on PowDB: PowQL has no containment
 *     operator.
 */
export interface JsonFilter {
  /**
   * Access a nested path (`#>` / `#>>` on Postgres, `->` on PowDB). A
   * digit-only segment (`'0'`) is treated as an array index on every engine.
   */
  path?: string[] | undefined;
  /**
   * With `path`: the JSON value at the path equals this value (typed on
   * PostgreSQL, see {@link JsonFilter}). Without `path`: containment,
   * `column @> value::jsonb` (E017 on PowDB).
   */
  equals?: unknown | undefined;
  /** Containment check: `column @> value::jsonb`. Unsupported on PowDB (E017: PowQL has no containment operator). */
  contains?: unknown | undefined;
  /** Key existence check: `column ? key`. */
  hasKey?: string | undefined;
  /**
   * Greater-than comparison of the value at `path` (required). Numbers cast
   * the extracted text to numeric, `(col #>> path)::numeric > $n`, while
   * strings compare as text.
   */
  gt?: number | string | undefined;
  /** Greater-than-or-equal comparison of the value at `path` (required). See {@link JsonFilter.gt}. */
  gte?: number | string | undefined;
  /** Less-than comparison of the value at `path` (required). See {@link JsonFilter.gt}. */
  lt?: number | string | undefined;
  /** Less-than-or-equal comparison of the value at `path` (required). See {@link JsonFilter.gt}. */
  lte?: number | string | undefined;
  /**
   * Substring match against the TEXT at `path` (required): `col #>> path LIKE
   * '%value%'`. This is Prisma's `string_contains`.
   *
   * Deliberately not spelled `contains`, which on a JSON column already means
   * whole-document containment (`@>`) and means something entirely different.
   * The operand is LIKE-escaped, so `%` and `_` match literally.
   */
  stringContains?: string | undefined;
  /** Prefix match against the text at `path` (required). Prisma's `string_starts_with`. See {@link JsonFilter.stringContains}. */
  stringStartsWith?: string | undefined;
  /** Suffix match against the text at `path` (required). Prisma's `string_ends_with`. See {@link JsonFilter.stringContains}. */
  stringEndsWith?: string | undefined;
  /**
   * Case-insensitive matching for the substring operators above (ILIKE on
   * PostgreSQL, the dialect's equivalent elsewhere). Has no effect on
   * `equals` / `contains` / `hasKey` / the range operators.
   */
  mode?: 'default' | 'insensitive' | undefined;
}

/** Array query operators for where clauses */
export interface ArrayFilter {
  /** Check if array contains a single value: value = ANY(column) */
  has?: unknown | undefined;
  /** Check if array contains ALL values: column @> ARRAY[...] */
  hasEvery?: unknown[] | undefined;
  /** Check if array has ANY of the values: column && ARRAY[...] */
  hasSome?: unknown[] | undefined;
  /** Check if array is empty: array_length(column, 1) IS NULL */
  isEmpty?: boolean | undefined;
}

/** Full-text search filter using PostgreSQL to_tsvector / to_tsquery */
export interface TextSearchFilter {
  /** The search query string passed to to_tsquery */
  search: string;
  /** PostgreSQL text search configuration name (defaults to 'english') */
  config?: string | undefined;
}

// ---------------------------------------------------------------------------
// pgvector, similarity search
// ---------------------------------------------------------------------------

/**
 * Vector distance metric. Maps to a pgvector distance operator:
 *
 *  - `'l2'`     → `<->` (Euclidean / L2 distance)
 *  - `'cosine'` → `<=>` (cosine distance)
 *  - `'ip'`     → `<#>` (negative inner product)
 *
 * This is a fixed allow-list, a value outside it is rejected with a
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
  lt?: number | undefined;
  /** distance <= threshold */
  lte?: number | undefined;
  /** distance > threshold */
  gt?: number | undefined;
  /** distance >= threshold */
  gte?: number | undefined;
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
  direction?: OrderDirection | undefined;
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
  nulls?: 'first' | 'last' | undefined;
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
  direction?: OrderDirection | undefined;
  /** Comparison kind for the extracted value. Defaults to `'text'`; `'numeric'` adds a numeric cast. */
  type?: 'numeric' | 'text' | undefined;
  /**
   * NULLS placement (PostgreSQL / SQLite only: see {@link OrderBySpec}).
   * Rows whose document lacks the path extract to NULL and sort LAST in BOTH
   * directions by default (matching pick-row ordering and the PowDB engine
   * contract, so ordering is predictable across drivers); set `nulls` to
   * override on PostgreSQL / SQLite.
   */
  nulls?: 'first' | 'last' | undefined;
}

/**
 * Ordering by a relation, keyed by the relation name in an {@link OrderByClause}:
 *
 *  - to-many (hasMany / manyToMany): `{ posts: { _count: 'desc' } }`, orders by
 *    a correlated `COUNT(*)` of the related rows.
 *  - to-one (belongsTo / hasOne): `{ author: { name: 'asc' } }`, orders by a
 *    correlated scalar subquery on the target column (an {@link OrderBySpec} with
 *    `nulls` is accepted too).
 *  - a CHAIN of to-one hops: `{ author: { organization: { name: 'asc' } } }`.
 *    Each further hop is a JOIN inside that same subquery, so the chain costs
 *    one subquery whatever its length. The type admits a head relation plus
 *    ten chained hops, eleven relation keys in all, which is exactly where the
 *    builder stops (`MAX_ORDER_BY_RELATION_HOPS` in query/relations.ts, the
 *    nested-`with` cap; a twelfth hop is E007). The bound is a countdown
 *    through a fixed table rather than an unbounded self reference, so `tsc`
 *    never has to report an excessively deep instantiation.
 *
 * The chain is keyed by `string`, not by the target's relation map, so it
 * cannot tell a to-many hop from a to-one one: `{ author: { posts: { title } } }`
 * typechecks and is refused by the builder with E003 (a to-many relation has
 * no single value to order by; {@link RelationPickOrderBy} exists for that).
 * Everything else about the shape is checked: a value at any depth is a
 * direction, a `{ sort, nulls }` spec, or the next hop.
 */
export type RelationOrderBy = { _count: OrderDirection } | RelationOrderByChain<10>;

/**
 * The to-one branch of {@link RelationOrderBy}: a map from a target column to
 * a direction or an {@link OrderBySpec}, or from a further to-one relation to
 * the next link, with `Hops` links still allowed beneath this one. At `0` the
 * next link is `never`, so only columns remain.
 */
export type RelationOrderByChain<Hops extends number> = Record<
  string,
  OrderDirection | OrderBySpec | ([Hops] extends [0] ? never : RelationOrderByChain<RelationOrderByHopsLeft[Hops]>)
>;

/**
 * `RelationOrderByHopsLeft[n]` is `n - 1`. Index 0 holds `never` and is never
 * read: {@link RelationOrderByChain} stops before indexing it.
 */
type RelationOrderByHopsLeft = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

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
      type?: 'numeric' | 'text' | undefined;
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
    where?: Record<string, unknown> | undefined;
  };
  /** The value on the picked row to order the parents by. */
  by: RelationPickBy;
  /** Sort direction for the parents. Defaults to `'asc'`. */
  direction?: OrderDirection | undefined;
  /**
   * NULLS placement (PostgreSQL / SQLite only: see {@link OrderBySpec}).
   *
   * A parent with NO related rows sorts by NULL. When `nulls` is not set,
   * pick ordering defaults to `NULLS LAST` in BOTH directions, so parents
   * with zero related rows always come last (Postgres's own DESC default is
   * NULLS FIRST, which would put every childless parent at the top of a
   * "highest first" sort). Set `nulls` explicitly to override.
   */
  nulls?: 'first' | 'last' | undefined;
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
  plan?: 'subquery' | 'lateral' | undefined;
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
