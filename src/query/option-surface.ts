/**
 * turbine-orm, the query-argument OPTION SURFACE as runtime data.
 *
 * ## Why this file exists
 *
 * TypeScript erases interfaces, so `FindManyArgs` does not exist at runtime and
 * any layer that has to decide, key by key, what to do with an args object has
 * to keep its own hand-written list. `turbine-orm/prisma-compat` is exactly
 * such a layer: it builds a FRESH turbine args object out of Prisma-shaped
 * input and copies over the keys it recognizes. Every time core gained a
 * query-level option, that ad-hoc allowlist silently failed to gain it, and the
 * option was accepted by the caller's type-checker and then dropped on the
 * floor. There was no feedback of any kind: no error, no warning, no test.
 *
 * These tables are the fix. Each one is a `Record<keyof SomeArgs<Row>,
 * OptionKind>`, the same mechanism `TURBINE_CONFIG_KEYS` (client.ts) uses for
 * the client-config surface, and it binds the compiler in BOTH directions:
 *
 *   - add an option to an arg interface and this file stops compiling until a
 *     human classifies it ("Property 'fooMode' is missing in type ..."), so an
 *     option can no longer be stranded BY OMISSION;
 *   - list a key here that is not on the interface and it fails as an excess
 *     property, so a table can never drift into describing an option that does
 *     not exist.
 *
 * It deliberately does NOT make "add the option in one place" sufficient: it
 * makes the second edit a BUILD FAILURE rather than a silent drop. That trade is
 * intentional. A passthrough-by-default translator would satisfy the shorter
 * wording and be actively wrong, because two of the options below carry FIELD
 * NAMES in their values (`optimisticLock.field`, `distinctOn.columns`), which a
 * compat layer must rename before core ever sees them. Copying those blind
 * works on a schema whose names happen to coincide and breaks on one that
 * renames a column, i.e. it makes the failure mode depend on the schema.
 *
 * ## THE ONE RULE for classifying a new option
 *
 * Classify a key `'native'` ONLY when its value contains no field, relation,
 * column, or model NAME. If the value names anything in the schema, it is
 * `'prisma'`: a name-translating consumer has to walk it by hand.
 *
 * @module
 */

import type {
  AggregateArgs,
  CountArgs,
  CreateArgs,
  CreateManyArgs,
  DeleteArgs,
  DeleteManyArgs,
  FindManyArgs,
  FindManyStreamArgs,
  FindUniqueArgs,
  GroupByArgs,
  UpdateArgs,
  UpdateManyArgs,
  UpsertArgs,
} from './types.js';

/**
 * How a name-translating consumer (today: `turbine-orm/prisma-compat`) must
 * handle one key of a turbine query-arg interface.
 *
 * - `'prisma'`, the key is a Prisma concept too, or its VALUE carries names
 *   that live in the caller's naming space. Translated by hand; NEVER copied
 *   verbatim.
 * - `'native'`, turbine-only and its value is opaque to naming (a boolean, a
 *   number, a list of table names). Copied through untouched.
 * - `'nativeAlias'`, the turbine SPELLING of a concept the caller's surface
 *   already has under another name (`with`/`limit`/`offset` vs
 *   `include`/`take`/`skip`). Refused, because forwarding it would collide with
 *   the translated key and would carry turbine relation names into a call
 *   written in the caller's names. The diagnostic names the right key instead.
 * - `'internal'`, not reachable through the compat surface at all
 *   (`batchSize` belongs to a streaming method compat does not expose), so it
 *   is not part of any known set and passing it is reported as unknown.
 */
export type OptionKind = 'prisma' | 'native' | 'nativeAlias' | 'internal';

/**
 * The generic parameter the tables are instantiated at. `keyof FindManyArgs<T>`
 * is the literal union of the DECLARED key names regardless of `T`, so a
 * neutral row type keeps the tables stable and free of entity coupling.
 */
type Row = Record<string, unknown>;

/** One option table: every declared key of one arg interface, classified. */
export type OptionTable<A> = Readonly<Record<keyof A, OptionKind>>;

export const FIND_UNIQUE_OPTIONS: OptionTable<FindUniqueArgs<Row>> = {
  where: 'prisma',
  select: 'prisma',
  omit: 'prisma',
  // Prisma spells this `include`; forwarding `with` would collide with the
  // translated projection and carry turbine relation names into a Prisma call.
  with: 'nativeAlias',
  // Same key on both surfaces, DIFFERENT value domains ('query' | 'join' vs
  // 'join' | 'batched' | 'auto' | 'flatten'), so the value needs mapping.
  relationLoadStrategy: 'prisma',
  timeout: 'native',
  stableRelationOrder: 'native',
  skipGlobalFilters: 'native',
  includePii: 'native',
  forceCustomPlan: 'native',
};

export const FIND_MANY_OPTIONS: OptionTable<FindManyArgs<Row>> = {
  where: 'prisma',
  select: 'prisma',
  omit: 'prisma',
  orderBy: 'prisma',
  cursor: 'prisma',
  take: 'prisma',
  distinct: 'prisma',
  relationLoadStrategy: 'prisma',
  with: 'nativeAlias',
  limit: 'nativeAlias',
  offset: 'nativeAlias',
  timeout: 'native',
  stableRelationOrder: 'native',
  skipGlobalFilters: 'native',
  warnOnUnlimited: 'native',
  includePii: 'native',
  forceCustomPlan: 'native',
};

export const FIND_MANY_STREAM_OPTIONS: OptionTable<FindManyStreamArgs<Row>> = {
  ...FIND_MANY_OPTIONS,
  // No streaming delegate exists on the compat surface, so this is not a known
  // key there and passing it is reported rather than quietly ignored.
  batchSize: 'internal',
};

export const CREATE_OPTIONS: OptionTable<CreateArgs<Row>> = {
  data: 'prisma',
  timeout: 'native',
};

export const CREATE_MANY_OPTIONS: OptionTable<CreateManyArgs<Row>> = {
  data: 'prisma',
  skipDuplicates: 'prisma',
  timeout: 'native',
};

export const UPDATE_OPTIONS: OptionTable<UpdateArgs<Row>> = {
  where: 'prisma',
  data: 'prisma',
  // `{ field, expected }`, and `field` is a FIELD NAME, so it has to be renamed
  // into turbine's naming space rather than copied. See THE ONE RULE above.
  optimisticLock: 'prisma',
  timeout: 'native',
  allowFullTableScan: 'native',
  skipGlobalFilters: 'native',
};

export const UPDATE_MANY_OPTIONS: OptionTable<UpdateManyArgs<Row>> = {
  where: 'prisma',
  data: 'prisma',
  timeout: 'native',
  allowFullTableScan: 'native',
  skipGlobalFilters: 'native',
};

export const DELETE_OPTIONS: OptionTable<DeleteArgs<Row>> = {
  where: 'prisma',
  timeout: 'native',
  allowFullTableScan: 'native',
  skipGlobalFilters: 'native',
};

export const DELETE_MANY_OPTIONS: OptionTable<DeleteManyArgs<Row>> = {
  where: 'prisma',
  timeout: 'native',
  allowFullTableScan: 'native',
  skipGlobalFilters: 'native',
};

export const UPSERT_OPTIONS: OptionTable<UpsertArgs<Row>> = {
  where: 'prisma',
  create: 'prisma',
  update: 'prisma',
  timeout: 'native',
  skipGlobalFilters: 'native',
};

export const COUNT_OPTIONS: OptionTable<CountArgs<Row>> = {
  where: 'prisma',
  timeout: 'native',
  skipGlobalFilters: 'native',
  forceCustomPlan: 'native',
};

export const AGGREGATE_OPTIONS: OptionTable<AggregateArgs<Row>> = {
  where: 'prisma',
  _count: 'prisma',
  _sum: 'prisma',
  _avg: 'prisma',
  _min: 'prisma',
  _max: 'prisma',
  timeout: 'native',
  skipGlobalFilters: 'native',
  includePii: 'native',
  forceCustomPlan: 'native',
};

export const GROUP_BY_OPTIONS: OptionTable<GroupByArgs<Row>> = {
  by: 'prisma',
  where: 'prisma',
  having: 'prisma',
  orderBy: 'prisma',
  _count: 'prisma',
  _sum: 'prisma',
  _avg: 'prisma',
  _min: 'prisma',
  _max: 'prisma',
  // `{ columns, orderBy }`, both in FIELD-NAME space. See THE ONE RULE.
  distinctOn: 'prisma',
  limit: 'nativeAlias',
  offset: 'nativeAlias',
  timeout: 'native',
  skipGlobalFilters: 'native',
  includePii: 'native',
  forceCustomPlan: 'native',
};

/**
 * Every table, so a test can assert the set is complete and well-formed without
 * naming each one (a table stubbed out during a refactor shows up here).
 */
export const ALL_OPTION_TABLES: Readonly<Record<string, Readonly<Record<string, OptionKind>>>> = {
  findUnique: FIND_UNIQUE_OPTIONS,
  findMany: FIND_MANY_OPTIONS,
  findManyStream: FIND_MANY_STREAM_OPTIONS,
  create: CREATE_OPTIONS,
  createMany: CREATE_MANY_OPTIONS,
  update: UPDATE_OPTIONS,
  updateMany: UPDATE_MANY_OPTIONS,
  delete: DELETE_OPTIONS,
  deleteMany: DELETE_MANY_OPTIONS,
  upsert: UPSERT_OPTIONS,
  count: COUNT_OPTIONS,
  aggregate: AGGREGATE_OPTIONS,
  groupBy: GROUP_BY_OPTIONS,
};

/**
 * Copy every `'native'` key present on `src` onto `dst`.
 *
 * Iterates `src` (a small caller-supplied object) rather than the table, so the
 * cost is proportional to what was actually passed. `undefined` values are
 * skipped: `{ ...maybeOpts }` routinely materializes keys with no value, and
 * writing `undefined` through would be indistinguishable from passing it.
 */
export function applyNativeOptions(
  table: Readonly<Record<string, OptionKind>>,
  src: Record<string, unknown>,
  dst: Record<string, unknown>,
): void {
  // Total on any input: a delegate whose args are optional can be called with
  // none, and a diagnostic-adjacent helper must not be the thing that throws.
  if (src === null || typeof src !== 'object') return;
  for (const key of Object.keys(src)) {
    if (table[key] !== 'native') continue;
    const value = src[key];
    if (value !== undefined) dst[key] = value;
  }
}

/** The keys of `table` with the given kind, as a set. */
export function optionKeysOfKind(table: Readonly<Record<string, OptionKind>>, ...kinds: OptionKind[]): string[] {
  return Object.keys(table).filter((k) => kinds.includes(table[k] as OptionKind));
}
