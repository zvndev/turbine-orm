/** Independent admission and legacy signature controls. Never executed. */
import type { PowqlInterface } from '../powql.js';
import type { QueryInterface as Query, WhereClause as Where } from '../query/index.js';
import type { CountArgs, FindManyArgs, RelationDescriptor as Relation } from '../query/types.js';

interface OrdinaryRow {
  id: number;
  name: string;
  createdAt: Date;
}
interface PrototypeFields extends OrdinaryRow {
  constructor: string | null;
  toString: string;
}
interface OrdinaryRelations {
  children: Relation<OrdinaryRow, 'many', OrdinaryRelations>;
}
interface PrototypeRelations {
  toString: Relation<OrdinaryRow, 'many'>;
}
declare const ordinary: Query<OrdinaryRow, OrdinaryRelations>;
declare const prototype: Query<PrototypeFields>;
declare const relationPrototype: Query<OrdinaryRow, PrototypeRelations>;
declare const powql: PowqlInterface<PrototypeFields>;
declare const annotated: Where<PrototypeFields>;
declare const typedArgs: FindManyArgs<PrototypeFields>;
declare const typedCount: CountArgs<PrototypeFields>;
declare const optionalName: { name?: string };
declare const constructorUnion: { id: number } | { constructor: string };
declare const invalidConstructorUnion: { id: number } | { constructor: number };
// biome-ignore lint/complexity/noBannedTypes: independent regression for the broad built-in interface
declare const predicateFunction: Function;
declare const annotatedUnion: Where<PrototypeFields> | { id: number };
declare const invalidAnnotatedUnion: Where<PrototypeFields> | { constructor: typeof predicateFunction };

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function exact<_T extends true>(): void {}

export async function independentAdmission(): Promise<void> {
  await prototype.findMany({});
  await prototype.findMany({ limit: 1 });
  await prototype.count({});
  await prototype.findMany({ where: optionalName });
  await prototype.findMany({ where: constructorUnion });
  await prototype.findMany({ where: annotated });
  await prototype.findMany({ where: annotatedUnion });
  await prototype.findMany(typedArgs);
  await prototype.count(typedCount);
  prototype.buildFindMany(typedArgs);
  await relationPrototype.findMany({ where: { id: 1 } });
  await relationPrototype.findMany({ where: { toString: { some: { name: 'x' } } } });
  await powql.findMany({ where: { id: 1 } });
  await powql.findMany(typedArgs);
  const mutation = {
    where: { id: 1 },
    create: { id: 1, name: 'x', createdAt: new Date(), constructor: 'c', toString: 't' },
    update: { name: 'y', constructor: 'c', toString: 't' },
  };
  await prototype.upsert(mutation);
  prototype.buildUpsert(mutation);
  await powql.upsert(mutation);
  const selected = await prototype.findFirst({ where: { id: 1 }, select: { name: true } });
  if (selected) exact<Equal<typeof selected, { name: string }>>();
  const deferred = prototype.buildFindFirst({
    where: { name: { mode: 'insensitive', equals: 'x' } },
    select: { name: true },
  });
  exact<Equal<ReturnType<typeof deferred.transform>, { name: string } | null>>();
  const rows = await ordinary.findMany({
    where: { name: { mode: 'insensitive', contains: 'x' }, children: { some: { id: { gt: 0 } } } },
    with: { children: { select: { name: true } } },
    select: { id: true },
  });
  exact<Equal<(typeof rows)[number], { id: number; children: { name: string }[] }>>();
  // @ts-expect-error wrong scalar must fail in the ordinary branch
  await ordinary.findMany({ where: { id: 'x' } });
  // @ts-expect-error ordinary relation excess fields retain contextual checks
  await ordinary.findMany({ where: { children: { some: { id: 1, typo: true } } } });
  // @ts-expect-error valid ordinary operator cannot conceal an invalid one
  await ordinary.findMany({ where: { id: { equals: 1, typo: true } } });
  // @ts-expect-error functions remain invalid when no unrelated field is supplied
  await prototype.findMany({ where: { constructor: predicateFunction } });
  // @ts-expect-error mixed unions cannot discard a string-invalid branch
  await prototype.findMany({ where: invalidConstructorUnion });
  // @ts-expect-error a structural branch cannot hide an explicit Function branch
  await prototype.findMany({ where: invalidAnnotatedUnion });
  // @ts-expect-error relation prototype names still require relation predicates
  await relationPrototype.findMany({ where: { toString: predicateFunction } });
  // @ts-expect-error PowQL must enforce the same string predicate boundary
  await powql.findMany({ where: { constructor: predicateFunction } });
  // @ts-expect-error PowQL invalid ordinary scalars must remain errors
  await powql.findFirst({ where: { id: 'x' } });
}

import type { DeferredQuery } from '../query/index.js';
import type {
  DefaultInputTypes,
  DeleteArgs,
  DeleteManyArgs,
  FieldResult,
  FindUniqueArgs,
  CountArgs as LegacyCountArgs,
  FindManyArgs as LegacyFindManyArgs,
  QueryResult,
  TableInputTypes,
  TypedWithClause,
  UpdateArgs,
  UpdateManyArgs,
  UpsertArgs,
} from '../query/types.js';

// Exact ordinary declarations from immutable 97623fe (also the original 601819 contract).
// biome-ignore lint/complexity/noBannedTypes: preserve the original default relations map
interface LegacyQuery<T, R extends object = {}, M extends TableInputTypes = DefaultInputTypes<T, R>> {
  buildUpdate<
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args: UpdateArgs<T, R, S, O, M['update']>): DeferredQuery<FieldResult<T, S, O>>;
  buildDelete<
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args: DeleteArgs<T, R, S, O>): DeferredQuery<FieldResult<T, S, O>>;
  buildUpsert<
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(
    args: UpsertArgs<T, R, S, O, M['whereUnique'], M['createMany'], M['updateMany']>,
  ): DeferredQuery<FieldResult<T, S, O>>;
  buildUpdateMany(args: UpdateManyArgs<T, R, M['updateMany']>): DeferredQuery<{ count: number }>;
  buildDeleteMany(args: DeleteManyArgs<T, R>): DeferredQuery<{ count: number }>;
  findUnique<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args: FindUniqueArgs<T, R, W, S, O, M['whereUnique']>): Promise<QueryResult<T, R, W, S, O> | null>;
  buildFindUnique<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args: FindUniqueArgs<T, R, W, S, O, M['whereUnique']>): DeferredQuery<QueryResult<T, R, W, S, O> | null>;
  findMany<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args?: LegacyFindManyArgs<T, R, W, S, O>): Promise<QueryResult<T, R, W, S, O>[]>;
  buildFindMany<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args?: LegacyFindManyArgs<T, R, W, S, O>): DeferredQuery<QueryResult<T, R, W, S, O>[]>;
  findFirst<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args?: LegacyFindManyArgs<T, R, W, S, O>): Promise<QueryResult<T, R, W, S, O> | null>;
  buildFindFirst<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args?: LegacyFindManyArgs<T, R, W, S, O>): DeferredQuery<QueryResult<T, R, W, S, O> | null>;
  findFirstOrThrow<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args?: LegacyFindManyArgs<T, R, W, S, O>): Promise<QueryResult<T, R, W, S, O>>;
  buildFindFirstOrThrow<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args?: LegacyFindManyArgs<T, R, W, S, O>): DeferredQuery<QueryResult<T, R, W, S, O>>;
  findUniqueOrThrow<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args: FindUniqueArgs<T, R, W, S, O, M['whereUnique']>): Promise<QueryResult<T, R, W, S, O>>;
  buildFindUniqueOrThrow<
    // biome-ignore lint/complexity/noBannedTypes: {} means "no with clause", matches TypedWithClause default
    W extends TypedWithClause<R> = {},
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args: FindUniqueArgs<T, R, W, S, O, M['whereUnique']>): DeferredQuery<QueryResult<T, R, W, S, O>>;
  update<
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args: UpdateArgs<T, R, S, O, M['update']>): Promise<FieldResult<T, S, O>>;
  delete<
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args: DeleteArgs<T, R, S, O>): Promise<FieldResult<T, S, O>>;
  upsert<
    S extends Record<string, boolean> | undefined = undefined,
    O extends Record<string, boolean> | undefined = undefined,
  >(args: UpsertArgs<T, R, S, O, M['whereUnique'], M['createMany'], M['updateMany']>): Promise<FieldResult<T, S, O>>;
  updateMany(args: UpdateManyArgs<T, R, M['updateMany']>): Promise<{ count: number }>;
  deleteMany(args: DeleteManyArgs<T, R>): Promise<{ count: number }>;
  count(args?: LegacyCountArgs<T, R>): Promise<number>;
  buildCount(args?: LegacyCountArgs<T, R>): DeferredQuery<number>;
}

type SameParametersAndReturn<A, B> = A extends (...args: never[]) => unknown
  ? B extends (...args: never[]) => unknown
    ? [Parameters<A>, ReturnType<A>, Parameters<B>, ReturnType<B>] extends [
        Parameters<B>,
        ReturnType<B>,
        Parameters<A>,
        ReturnType<A>,
      ]
      ? true
      : false
    : false
  : false;
type CompatibleMethods<Q, L> = {
  [K in keyof L]: K extends keyof Q ? SameParametersAndReturn<Q[K], L[K]> : false;
}[keyof L];

export function signatureCompatibility(): void {
  exact<
    Equal<CompatibleMethods<Query<OrdinaryRow, OrdinaryRelations>, LegacyQuery<OrdinaryRow, OrdinaryRelations>>, true>
  >();
  exact<Equal<CompatibleMethods<Query<PrototypeFields>, LegacyQuery<PrototypeFields>>, true>>();
  exact<
    Equal<CompatibleMethods<Query<OrdinaryRow, PrototypeRelations>, LegacyQuery<OrdinaryRow, PrototypeRelations>>, true>
  >();
  type PowqlMethods = Exclude<keyof LegacyQuery<PrototypeFields>, `build${string}`>;
  exact<
    Equal<CompatibleMethods<PowqlInterface<PrototypeFields>, Pick<LegacyQuery<PrototypeFields>, PowqlMethods>>, true>
  >();
}
