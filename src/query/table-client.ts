/**
 * turbine-orm, the table accessor contract.
 *
 * `db.users` is a `QueryInterface` on the SQL engines and a `PowqlInterface` on
 * PowDB. The second is a parallel class, not a subclass, so without a shared
 * type the compiler cannot see a method one engine has and the other lacks, and
 * the user meets it as `TypeError: ... is not a function` at run time.
 *
 * {@link TableClient} is that shared type. It is DERIVED from QueryInterface
 * (a `Pick` of the classified methods), so the SQL builder stays the one source
 * of truth for every signature, and `PowqlInterface implements TableClient`
 * makes a missing or mismatched method a build error.
 *
 * Type-only imports: this module emits {@link TABLE_METHODS} and nothing else,
 * so it adds no edge to the import graph.
 */

import type { QueryInterface } from './builder.js';
import type { DefaultInputTypes, TableInputTypes } from './types.js';

/**
 * How a table method is routed.
 *
 * - `read`: may be served by a read replica (`READ_OPERATIONS` in client.ts is
 *   derived from these).
 * - `write`: always runs on the primary.
 * - `deferred`: returns a `DeferredQuery` for `db.pipeline()` /
 *   `$transaction([...])` without running anything.
 * - `primary`: anything else on the accessor; runs on the primary.
 */
export type TableMethodKind = 'read' | 'write' | 'deferred' | 'primary';

/**
 * Every public method of a table accessor, with its routing class.
 *
 * `satisfies` refuses a key QueryInterface does not have; the exhaustiveness
 * check below refuses a QueryInterface member missing from here.
 */
export const TABLE_METHODS = {
  findMany: 'read',
  findFirst: 'read',
  findFirstOrThrow: 'read',
  findUnique: 'read',
  findUniqueOrThrow: 'read',
  count: 'read',
  aggregate: 'read',
  groupBy: 'read',
  findManyStream: 'read',
  findManyStreamBatches: 'read',
  explain: 'primary',
  cacheStats: 'primary',
  create: 'write',
  createMany: 'write',
  update: 'write',
  updateMany: 'write',
  delete: 'write',
  deleteMany: 'write',
  upsert: 'write',
  buildFindMany: 'deferred',
  buildFindFirst: 'deferred',
  buildFindFirstOrThrow: 'deferred',
  buildFindUnique: 'deferred',
  buildFindUniqueOrThrow: 'deferred',
  buildCount: 'deferred',
  buildAggregate: 'deferred',
  buildGroupBy: 'deferred',
  buildCreate: 'deferred',
  buildCreateMany: 'deferred',
  buildUpdate: 'deferred',
  buildUpdateMany: 'deferred',
  buildDelete: 'deferred',
  buildDeleteMany: 'deferred',
  buildUpsert: 'deferred',
} as const satisfies Partial<Record<keyof QueryInterface<object>, TableMethodKind>>;

/** A method name in the table accessor contract. */
export type TableMethod = keyof typeof TABLE_METHODS;

/**
 * Public QueryInterface members that are SQL-engine internals (cache
 * fingerprinting, the upsert lookup decision, a test hook), deliberately
 * outside the accessor contract, so PowDB need not implement them.
 */
export type SqlInternalMember =
  | 'collectWhereParams'
  | 'fingerprintWhere'
  | 'withFingerprint'
  | 'upsertNeedsLookup'
  | 'resetUnlimitedWarnings';

/** Public QueryInterface members classified neither as a table method nor as internal. */
type Unclassified = Exclude<keyof QueryInterface<object>, TableMethod | SqlInternalMember>;

/**
 * Fails the build, naming the member, when QueryInterface gains a public
 * member nobody classified: add it to TABLE_METHODS (and to PowqlInterface) or
 * to SqlInternalMember.
 */
type AssertEveryMemberClassified<U extends never> = U;
export type EveryQueryInterfaceMemberClassified = AssertEveryMemberClassified<Unclassified>;

/** The table accessor contract every engine's accessor class implements. */
export type TableClient<
  T extends object,
  // biome-ignore lint/complexity/noBannedTypes: {} means "no relations known", matches QueryInterface's default
  R extends object = {},
  M extends TableInputTypes = DefaultInputTypes<T, R>,
> = Pick<QueryInterface<T, R, M>, TableMethod>;

/**
 * View a factory-built accessor as the `QueryInterface` the client's public
 * `table()` type names.
 *
 * Sound because the exhaustiveness check above guarantees `TableClient` holds
 * every public QueryInterface member except the SQL internals, which nothing
 * outside the SQL builder reaches through an accessor without first checking
 * the member exists. The cast hides only private members.
 */
export function asQueryInterface<T extends object>(client: TableClient<T>): QueryInterface<T> {
  return client as unknown as QueryInterface<T>;
}
