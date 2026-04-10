/**
 * turbine-orm — Type-level tests for deep `with` clause inference
 *
 * These tests verify that {@link WithResult} correctly threads relation types
 * through arbitrarily nested `with` clauses. They are pure compile-time checks
 * — the assertions are TypeScript type equalities, not runtime values. The
 * file is included in the `test:unit` script so any regression in inference
 * fails the test runner (the test file fails to typecheck and `tsx --test`
 * exits non-zero).
 *
 * The runtime portion just runs an empty `it()` so node:test recognises the
 * file. The real verification happens at compile time.
 */

import { describe, it } from 'node:test';
import type { QueryInterface, RelationDescriptor, WithResult } from '../query.js';

// ---------------------------------------------------------------------------
// Type-level assertion helpers
// ---------------------------------------------------------------------------

/** Compile-time exact-equality assertion. Resolves to `true` only when A and B are mutually assignable. */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Force a compile error if `T` is not the literal `true` type. */
function assertTrue<T extends true>(): T {
  return true as T;
}

// ---------------------------------------------------------------------------
// Mock entity + relation interfaces (mimicking what `generate.ts` will emit)
// ---------------------------------------------------------------------------

interface User {
  id: number;
  email: string;
}

interface Post {
  id: number;
  userId: number;
  title: string;
}

interface Comment {
  id: number;
  postId: number;
  authorId: number;
  body: string;
}

interface Author {
  id: number;
  displayName: string;
}

interface Profile {
  id: number;
  userId: number;
  bio: string;
}

/** Marker for "the target entity has no relations of its own". */
type NoRelations = Record<never, never>;

// Generated *Relations interfaces use the new RelationDescriptor brand so the
// recursive `WithResult` can walk through them at any depth.
interface UserRelations {
  posts: RelationDescriptor<Post, 'many', PostRelations>;
  profile: RelationDescriptor<Profile, 'one', NoRelations>;
}

interface PostRelations {
  comments: RelationDescriptor<Comment, 'many', CommentRelations>;
  author: RelationDescriptor<User, 'one', UserRelations>;
}

interface CommentRelations {
  author: RelationDescriptor<Author, 'one', NoRelations>;
}

// ---------------------------------------------------------------------------
// 1. Single-level inclusion: `findMany({ with: { posts: true } })`
// ---------------------------------------------------------------------------

type SingleLevel = WithResult<User, UserRelations, { posts: true }>;
assertTrue<Equals<SingleLevel['posts'], Post[]>>();
assertTrue<Equals<SingleLevel['email'], string>>();

// belongsTo / hasOne projects to `Target | null`, not an array
type SingleLevelOne = WithResult<User, UserRelations, { profile: true }>;
assertTrue<Equals<SingleLevelOne['profile'], Profile | null>>();

// ---------------------------------------------------------------------------
// 2. Two-level: `{ with: { posts: { with: { comments: true } } } }`
// ---------------------------------------------------------------------------

type TwoLevel = WithResult<User, UserRelations, { posts: { with: { comments: true } } }>;

// `posts` should be an array of Post & { comments: Comment[] }
type TwoLevelPost = TwoLevel['posts'][number];
assertTrue<Equals<TwoLevelPost['comments'], Comment[]>>();
assertTrue<Equals<TwoLevelPost['title'], string>>();

// ---------------------------------------------------------------------------
// 3. Three-level: comments → author
// ---------------------------------------------------------------------------

type ThreeLevel = WithResult<User, UserRelations, { posts: { with: { comments: { with: { author: true } } } } }>;
type ThreeLevelComment = ThreeLevel['posts'][number]['comments'][number];
assertTrue<Equals<ThreeLevelComment['author'], Author | null>>();
assertTrue<Equals<ThreeLevelComment['body'], string>>();

// ---------------------------------------------------------------------------
// 4. Four-level back-reference: posts → author → profile
// ---------------------------------------------------------------------------

type FourLevel = WithResult<User, UserRelations, { posts: { with: { author: { with: { profile: true } } } } }>;
type FourLevelAuthor = NonNullable<FourLevel['posts'][number]['author']>;
assertTrue<Equals<FourLevelAuthor['profile'], Profile | null>>();

// ---------------------------------------------------------------------------
// 5. Omitted relations are NOT added to the return type
// ---------------------------------------------------------------------------

type OmittedRelations = WithResult<User, UserRelations, { posts: true }>;
// `profile` was not included; it must not appear as a property on the result.
type ProfileKey = 'profile' extends keyof OmittedRelations ? true : false;
assertTrue<Equals<ProfileKey, false>>();

// ---------------------------------------------------------------------------
// 6. Empty/legacy R short-circuits to plain T
// ---------------------------------------------------------------------------

type LegacyEmpty = WithResult<User, NoRelations, { posts: true }>;
assertTrue<Equals<LegacyEmpty, User>>();

// ---------------------------------------------------------------------------
// 7. Backward compat: bare relation shapes still work for one level
// ---------------------------------------------------------------------------

interface LegacyUserRelations {
  posts: Post[];
  profile: Profile | null;
}

type LegacySingle = WithResult<User, LegacyUserRelations, { posts: true }>;
assertTrue<Equals<LegacySingle['posts'], Post[]>>();

// ---------------------------------------------------------------------------
// 8. End-to-end: calling findMany / findUnique / findFirst on a typed
//    QueryInterface returns the correctly-inferred nested shape.
//
//    These assertions are the real-world path — they exercise the exact
//    signature users see when they write `db.users.findMany({ with: ... })`.
//    If this block fails to typecheck, `with` inference is broken at the
//    *call site*, not in WithResult itself.
// ---------------------------------------------------------------------------

// Helper: extract the element type of an awaited array return value.
type AwaitedArrayOf<P> = P extends Promise<(infer Item)[]> ? Item : never;
type AwaitedOf<P> = P extends Promise<infer V> ? V : never;

// Mock a typed QueryInterface for User, mirroring what `generate.ts` emits
// for a table with relations.
declare const users: QueryInterface<User, UserRelations>;

// --- Plain call: no with ---
// Note: we pass `<{}>` explicitly here because `ReturnType<typeof fn>` on a
// generic function substitutes the constraint (`TypedWithClause<R>`), not the
// default (`{}`). In real user code, calling `users.findMany()` without type
// args does infer `W = {}` correctly — that path is exercised in section 9.
type PlainList = AwaitedArrayOf<ReturnType<typeof users.findMany<{}>>>;
assertTrue<Equals<PlainList, User>>();

// --- Single-level with: { posts: true } ---
type SingleFm = AwaitedArrayOf<ReturnType<typeof users.findMany<{ posts: true }>>>;
assertTrue<Equals<SingleFm['posts'], Post[]>>();
assertTrue<Equals<SingleFm['email'], string>>();

// --- Two-level with: posts → comments ---
type TwoFm = AwaitedArrayOf<ReturnType<typeof users.findMany<{ posts: { with: { comments: true } } }>>>;
type TwoFmPost = TwoFm['posts'][number];
assertTrue<Equals<TwoFmPost['comments'], Comment[]>>();

// --- Three-level with: posts → comments → author ---
type ThreeFm = AwaitedArrayOf<
  ReturnType<typeof users.findMany<{ posts: { with: { comments: { with: { author: true } } } } }>>
>;
type ThreeFmComment = ThreeFm['posts'][number]['comments'][number];
assertTrue<Equals<ThreeFmComment['author'], Author | null>>();

// --- findUnique (single nullable result) ---
type UniqRes = AwaitedOf<ReturnType<typeof users.findUnique<{ posts: true }>>>;
// findUnique returns `WithResult<...> | null` — narrow to the non-null branch.
type UniqResNonNull = NonNullable<UniqRes>;
assertTrue<Equals<UniqResNonNull['posts'], Post[]>>();

// --- findFirst (single nullable result) ---
type FirstRes = AwaitedOf<ReturnType<typeof users.findFirst<{ profile: true }>>>;
type FirstResNonNull = NonNullable<FirstRes>;
assertTrue<Equals<FirstResNonNull['profile'], Profile | null>>();

// --- findUniqueOrThrow (non-null result) ---
type UniqOrThrowRes = AwaitedOf<ReturnType<typeof users.findUniqueOrThrow<{ posts: true }>>>;
assertTrue<Equals<UniqOrThrowRes['posts'], Post[]>>();

// ---------------------------------------------------------------------------
// 9. Call-site literal inference: passing a `with` literal directly to
//    findMany (without explicit type arguments) should still produce a
//    correctly-inferred return type. This is the shape users actually
//    write — explicit generics would be a regression in ergonomics.
// ---------------------------------------------------------------------------

// We call the method and capture the inferred return type via `typeof`.
// TypeScript evaluates this at compile time even though it's in a type
// position — no runtime invocation happens because the expression is
// guarded by `false`.
async function callSiteInference() {
  // Using `0 as 1` guard so the body is unreachable at runtime but TS still
  // typechecks the calls for us.
  if (false as boolean) {
    // Plain call — no with. Should collapse to plain `User`.
    const plain = await users.findMany();
    type PlainItem = (typeof plain)[number];
    assertTrue<Equals<PlainItem, User>>();

    const singleLevel = await users.findMany({ with: { posts: true } });
    type SingleLevelItem = (typeof singleLevel)[number];
    assertTrue<Equals<SingleLevelItem['posts'], Post[]>>();

    const twoLevel = await users.findMany({
      with: { posts: { with: { comments: true } } },
    });
    type TwoLevelItem = (typeof twoLevel)[number];
    assertTrue<Equals<TwoLevelItem['posts'][number]['comments'], Comment[]>>();

    const threeLevel = await users.findMany({
      with: { posts: { with: { comments: { with: { author: true } } } } },
    });
    type ThreeLevelItem = (typeof threeLevel)[number];
    assertTrue<Equals<ThreeLevelItem['posts'][number]['comments'][number]['author'], Author | null>>();
  }
}
void callSiteInference;

// ---------------------------------------------------------------------------
// node:test stub so the runner picks up the file
// ---------------------------------------------------------------------------

describe('with-inference (type-level)', () => {
  it('compile-time assertions pass', () => {
    // All assertions above are evaluated at compile time. Nothing to do here.
  });
});
