/**
 * turbine-orm, compile-time assertions for result and input typing
 *
 * Covers: nested `select` / `omit` inside `with`, required belongsTo
 * relations typed non-null, `with` clauses held in a variable typed with the
 * library's own args types, `_count: true` keys, `aggregate` results derived
 * from their args, typed global filters, and the core to-one nested write
 * operations.
 *
 * Like with-inference.test.ts, the assertions are types: `tsc` over
 * tsconfig.test.json (`npm run typecheck`) is what fails when one regresses.
 * The runtime part only registers the file with node:test.
 */

import { describe, it } from 'node:test';
import type {
  CreateArgs,
  FindManyArgs,
  FindUniqueArgs,
  QueryInterface,
  RelationDescriptor,
  UpdateArgs,
  UpdateDataInput,
  UpsertArgs,
} from '../query/index.js';
import type { AggregateResultOf, GlobalFilter } from '../query/types.js';

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function assertTrue<T extends true>(): T {
  return true as T;
}

interface Org {
  id: number;
  name: string;
}
interface User {
  id: number;
  orgId: number;
  managerId: number | null;
  email: string;
  name: string | null;
}
interface Post {
  id: number;
  authorId: number;
  title: string;
  views: number;
  body: string;
}
interface Profile {
  id: number;
  userId: number;
  bio: string;
}

type NoRelations = Record<never, never>;
interface OrgRelations {
  users: RelationDescriptor<User, 'many', UserRelations, 'hasMany'>;
}
interface UserRelations {
  // NOT NULL foreign key: never null when loaded.
  org: RelationDescriptor<Org, 'one', OrgRelations, 'belongsTo', false>;
  // Nullable foreign key: may be null.
  manager: RelationDescriptor<User, 'one', UserRelations, 'belongsTo'>;
  posts: RelationDescriptor<Post, 'many', PostRelations, 'hasMany'>;
  profile: RelationDescriptor<Profile, 'one', NoRelations, 'hasOne'>;
}
interface PostRelations {
  author: RelationDescriptor<User, 'one', UserRelations, 'belongsTo', false>;
}

declare const users: QueryInterface<User, UserRelations>;
declare const posts: QueryInterface<Post, PostRelations>;

type Row<P> = P extends Promise<(infer Item)[]> ? Item : P extends Promise<infer V> ? V : never;

// ---------------------------------------------------------------------------
// Nested select / omit narrow the related rows, at every depth
// ---------------------------------------------------------------------------

const nestedSelect = () => users.findMany({ with: { posts: { select: { title: true } } } });
type NestedSelectPost = Row<ReturnType<typeof nestedSelect>>['posts'][number];
assertTrue<Equals<keyof NestedSelectPost, 'title'>>();

const nestedOmit = () => posts.findMany({ with: { author: { omit: { email: true } } } });
type NestedOmitAuthor = Row<ReturnType<typeof nestedOmit>>['author'];
assertTrue<Equals<'email' extends keyof NestedOmitAuthor ? true : false, false>>();
assertTrue<Equals<NestedOmitAuthor['name'], string | null>>();

// select plus a nested with: the selected scalars plus the loaded relation.
const selectAndWith = () =>
  users.findMany({ with: { posts: { select: { id: true }, with: { author: { select: { email: true } } } } } });
type SelectAndWithPost = Row<ReturnType<typeof selectAndWith>>['posts'][number];
assertTrue<Equals<keyof SelectAndWithPost, 'id' | 'author'>>();
assertTrue<Equals<keyof SelectAndWithPost['author'], 'email'>>();

// Two levels down.
const deepSelect = () =>
  users.findMany({ with: { posts: { with: { author: { with: { org: { select: { name: true } } } } } } } });
type DeepOrg = Row<ReturnType<typeof deepSelect>>['posts'][number]['author']['org'];
assertTrue<Equals<keyof DeepOrg, 'name'>>();

// No select / omit: unchanged.
const plainNested = () => users.findMany({ with: { posts: true } });
assertTrue<Equals<Row<ReturnType<typeof plainNested>>['posts'], Post[]>>();

// ---------------------------------------------------------------------------
// Required belongsTo is not null; nullable FK, hasOne and a relation `where` are
// ---------------------------------------------------------------------------

const required = () => posts.findMany({ with: { author: true } });
assertTrue<Equals<Row<ReturnType<typeof required>>['author'], User>>();

const optionalFk = () => users.findMany({ with: { manager: true, profile: true, org: true } });
type OptionalFkRow = Row<ReturnType<typeof optionalFk>>;
assertTrue<Equals<OptionalFkRow['manager'], User | null>>();
assertTrue<Equals<OptionalFkRow['profile'], Profile | null>>();
assertTrue<Equals<OptionalFkRow['org'], Org>>();

// A `where` on a to-one relation can match nothing.
const filteredToOne = () => posts.findMany({ with: { author: { where: { email: 'a@b.c' } } } });
assertTrue<Equals<Row<ReturnType<typeof filteredToOne>>['author'], User | null>>();

// ---------------------------------------------------------------------------
// `with` typed as the library's args type: relations are optional, not loaded
// ---------------------------------------------------------------------------

declare const typedArgs: FindManyArgs<User, UserRelations>;
const viaTypedArgs = () => users.findMany(typedArgs);
type ViaTypedArgs = Row<ReturnType<typeof viaTypedArgs>>;
// Every relation key may be present, so each is optional on the row.
assertTrue<Equals<undefined extends ViaTypedArgs['posts'] ? true : false, true>>();
assertTrue<Equals<NonNullable<ViaTypedArgs['posts']>, Post[]>>();

// A literal `with` still marks its relations as present.
const literal = () => users.findMany({ with: { posts: true } });
assertTrue<Equals<undefined extends Row<ReturnType<typeof literal>>['posts'] ? true : false, false>>();

// ---------------------------------------------------------------------------
// `_count: true` names the to-many relations
// ---------------------------------------------------------------------------

const countAll = () => users.findMany({ with: { _count: true } });
assertTrue<Equals<Row<ReturnType<typeof countAll>>['_count'], { posts: number }>>();

// ---------------------------------------------------------------------------
// aggregate results derive from the args
// ---------------------------------------------------------------------------

type Agg = AggregateResultOf<Post, { _sum: { views: true }; _max: { title: true }; _count: true }>;
assertTrue<Equals<Agg['_sum'], { views: number | string | null }>>();
assertTrue<Equals<Agg['_max'], { title: string | null }>>();
assertTrue<Equals<Agg['_count'], number>>();
assertTrue<Equals<'_avg' extends keyof Agg ? true : false, false>>();

// ---------------------------------------------------------------------------
// Typed global filters
// ---------------------------------------------------------------------------

export const okFilter: GlobalFilter<User, UserRelations> = { orgId: 1 };
export const okFilterFn: GlobalFilter<User, UserRelations> = () => null;
// @ts-expect-error a misspelled column is a compile error
export const badFilter: GlobalFilter<User, UserRelations> = { orgID: 1 };

// ---------------------------------------------------------------------------
// Input types threaded through the arg interfaces
// ---------------------------------------------------------------------------

type UserCreateData = { orgId: number; email: string; name?: string | null };
export const createOk: CreateArgs<User, UserRelations, undefined, undefined, UserCreateData> = {
  data: { orgId: 1, email: 'a@b.c' },
};
export const createMissing: CreateArgs<User, UserRelations, undefined, undefined, UserCreateData> = {
  // @ts-expect-error a required column (orgId) is missing
  data: { email: 'a@b.c' },
};

type UserUnique = { id: number } | { email: string };
export const uniqueOk: FindUniqueArgs<User, UserRelations, NoRelations, undefined, undefined, UserUnique> = {
  where: { email: 'a@b.c', orgId: 1 },
};
export const uniqueBad: FindUniqueArgs<User, UserRelations, NoRelations, undefined, undefined, UserUnique> = {
  // @ts-expect-error the selector names no unique key
  where: { orgId: 1 },
};
export const upsertBad: UpsertArgs<User, UserRelations, undefined, undefined, UserUnique> = {
  // @ts-expect-error upsert names a unique key too
  where: { name: 'x' },
  create: { orgId: 1, email: 'a@b.c' },
  update: {},
};
// Default (no unique type known): any where, as before.
export const uniqueDefault: FindUniqueArgs<User, UserRelations> = { where: { orgId: 1 } };

// `undefined` is "absent" in write data, also under exactOptionalPropertyTypes.
export const undefinedData: UpdateArgs<User, UserRelations> = { where: { id: 1 }, data: { name: undefined } };

// ---------------------------------------------------------------------------
// belongsTo nested writes follow the to-one rules
// ---------------------------------------------------------------------------

type PostUpdate = UpdateDataInput<Post, PostRelations>;
export const disconnectTrue: PostUpdate = { author: { disconnect: true } };
export const deleteFalse: PostUpdate = { author: { delete: false } };
export const disconnectEmpty: PostUpdate = { author: { disconnect: {} } };
export const connectOne: PostUpdate = { author: { connect: { id: 1 } } };
export const updateConnected: PostUpdate = { author: { update: { data: { name: 'x' } } } };
// @ts-expect-error a belongsTo has no `set`
export const setOnToOne: PostUpdate = { author: { set: [{ id: 1 }] } };
// @ts-expect-error a belongsTo connects one row, not an array
export const connectArray: PostUpdate = { author: { connect: [{ id: 1 }] } };
// To-many relations keep the list operations.
type UserUpdate = UpdateDataInput<User, UserRelations>;
export const setOnMany: UserUpdate = { posts: { set: [{ id: 1 }], connect: [{ id: 2 }] } };

describe('types: result and input typing', () => {
  it('compile-time assertions (verified by tsc, not at runtime)', () => {});
});
