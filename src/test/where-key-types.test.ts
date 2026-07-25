/**
 * turbine-orm — Type-level tests for `where` key validation
 *
 * A misspelled column in `where` used to compile silently. `WhereClause<T>`
 * carried a `[relationName: string]: unknown` index signature — required so
 * relation filters (`where: { posts: { some: ... } }`) would typecheck, since
 * relation names are NOT keys of the entity — and an index signature
 * annihilates excess-property checking for the whole object.
 *
 * The fix keys the relation side explicitly instead: `WhereClause<T, R>` takes
 * the generated `*Relations` map (which every typed client already threads
 * through `QueryInterface<T, R>`), enumerates the relation keys as real
 * properties, and drops the index signature. Same for a relation `with`
 * block's own `where`, which is now keyed against the relation TARGET entity.
 *
 * IMPORTANT — what actually guards this file: `tsx`/esbuild strips types
 * WITHOUT typechecking, so `npm run test:unit` runs it fine even if the
 * validation regresses. The REAL guard is `npm run typecheck`
 * (`tsc --noEmit --project tsconfig.test.json`), which re-includes `src/test`.
 * An unused `@ts-expect-error` is itself an error, so a regression that lets a
 * typo through fails the typecheck job.
 *
 * `QueryInterface` now threads `R` into EVERY method that takes a `where`, so
 * `delete` / `upsert` / `count` / `updateMany` / `deleteMany` / `aggregate` /
 * `groupBy` are key-checked alongside the find family (section 5).
 *
 * Deliberately still permissive (documented, not accidental):
 *   - Legacy generated clients whose `*Relations` members are bare types
 *     (`posts: Post[]`) rather than `RelationDescriptor` brands: the relation
 *     KEY is checked, its VALUE is not.
 *   - `orderBy` (still open-keyed everywhere).
 */

import { describe, it } from 'node:test';
import type { QueryInterface, RelationDescriptor, WhereClause } from '../query/index.js';

interface Comment {
  id: number;
  postId: number;
  body: string;
}

interface Post {
  id: number;
  userId: number;
  title: string;
  views: number;
  data: unknown;
  tags: string[];
  embedding: number[];
}

interface User {
  id: number;
  email: string;
  createdAt: Date;
  deletedAt: Date | null;
}

interface CommentRelations {
  post: RelationDescriptor<Post, 'one', PostRelations>;
}

interface PostRelations {
  author: RelationDescriptor<User, 'one', UserRelations>;
  comments: RelationDescriptor<Comment, 'many', CommentRelations>;
}

interface UserRelations {
  posts: RelationDescriptor<Post, 'many', PostRelations>;
}

declare const users: QueryInterface<User, UserRelations>;
declare const posts: QueryInterface<Post, PostRelations>;

// ---------------------------------------------------------------------------
// 1. Negative cases: a typo in `where` is a compile error
// ---------------------------------------------------------------------------

async function topLevelTypos(): Promise<void> {
  // @ts-expect-error — 'emial' is not a column or relation of User
  await users.findMany({ where: { emial: 'x' } });

  // @ts-expect-error — unknown key inside AND
  await users.findMany({ where: { AND: [{ emial: 'x' }] } });

  // @ts-expect-error — unknown key inside OR
  await users.findMany({ where: { OR: [{ id: 1 }, { emial: 'x' }] } });

  // @ts-expect-error — unknown key inside NOT
  await users.findMany({ where: { NOT: { emial: 'x' } } });

  // @ts-expect-error — 'postz' is not a relation of User
  await users.findMany({ where: { postz: { some: { title: 'x' } } } });

  // @ts-expect-error — typo one level down, inside a relation filter
  await users.findMany({ where: { posts: { some: { titel: 'x' } } } });

  // @ts-expect-error — typo two levels down, inside a nested relation filter
  await users.findMany({ where: { posts: { some: { comments: { some: { bodyy: 'x' } } } } } });

  // @ts-expect-error — findUnique
  await users.findUnique({ where: { emial: 'x' } });

  // @ts-expect-error — findFirst
  await users.findFirst({ where: { emial: 'x' } });

  // @ts-expect-error — findUniqueOrThrow
  await users.findUniqueOrThrow({ where: { emial: 'x' } });

  // @ts-expect-error — findFirstOrThrow
  await users.findFirstOrThrow({ where: { emial: 'x' } });

  // @ts-expect-error — update
  await users.update({ where: { emial: 'x' }, data: { email: 'y' } });

  // A wrong VALUE type on a real column was already caught, and still is.
  // @ts-expect-error — email is a string column
  await users.findMany({ where: { email: 12345 } });
}

async function nestedWithTypos(): Promise<void> {
  // @ts-expect-error — 'titel' is not a column or relation of Post
  await users.findMany({ with: { posts: { where: { titel: 'x' } } } });

  // @ts-expect-error — typo in a DEEPLY nested relation `where`
  await users.findMany({ with: { posts: { with: { comments: { where: { bodyy: 'x' } } } } } });

  // @ts-expect-error — typo inside a to-one relation's `where`
  await users.findMany({ with: { posts: { with: { author: { where: { emial: 'x' } } } } } });

  // @ts-expect-error — typo inside a relation filter used in a nested `where`
  await users.findMany({ with: { posts: { where: { comments: { some: { bodyy: 'x' } } } } } });
}

// ---------------------------------------------------------------------------
// 2. Positive cases: every legitimate filter shape still compiles
// ---------------------------------------------------------------------------

async function legitimateShapes(): Promise<void> {
  // Scalar equality, null, and the full operator surface.
  await users.findMany({ where: { email: 'a', id: 1 } });
  await users.findMany({ where: { deletedAt: null } });
  await users.findMany({
    where: {
      id: { equals: 1, gt: 0, gte: 0, lt: 10, lte: 10, not: 5, in: [1, 2], notIn: [3] },
      email: { contains: 'a', startsWith: 'b', endsWith: 'c', mode: 'insensitive' },
    },
  });

  // Column references.
  await posts.findMany({ where: { userId: { equals: { col: 'id' } } } });

  // Combinators, nested arbitrarily.
  await users.findMany({
    where: { OR: [{ email: 'a' }, { AND: [{ id: 1 }, { NOT: { id: 2 } }] }], NOT: { email: 'z' } },
  });

  // Relation filters: to-many some/every/none, to-one is/isNot, bare implicit `is`.
  await users.findMany({ where: { posts: { some: { title: 'x' } } } });
  await users.findMany({ where: { posts: { every: { views: { gte: 1 } }, none: { title: 'x' } } } });
  await posts.findMany({ where: { author: { is: { email: 'a' } } } });
  await posts.findMany({ where: { author: { isNot: { email: 'a' } } } });
  await posts.findMany({ where: { author: { email: 'a' } } });
  // Relation filter nested through another relation.
  await users.findMany({ where: { posts: { some: { comments: { some: { body: 'x' } } } } } });
  await users.findMany({ where: { posts: { some: { author: { is: { id: 1 } } } } } });

  // JSON path, array, vector, and text-search filters.
  await posts.findMany({ where: { data: { path: ['a', 'b'], equals: 1 } } });
  await posts.findMany({ where: { data: { path: ['n'], gt: 3 } } });
  await posts.findMany({ where: { tags: { has: 'x', hasEvery: ['a'], hasSome: ['b'], isEmpty: false } } });
  await posts.findMany({ where: { embedding: { distance: { to: [0.1, 0.2], metric: 'cosine', lt: 0.3 } } } });
  await posts.findMany({ where: { title: { search: 'cat', config: 'english' } } });

  // Relation `with` blocks: where / orderBy / limit / select / omit, at depth.
  await users.findMany({ with: { posts: { where: { title: 'x' }, orderBy: { title: 'asc' }, limit: 3 } } });
  await users.findMany({ with: { posts: { with: { comments: { where: { body: 'x' } } } } } });
  await users.findMany({ with: { posts: { where: { author: { is: { email: 'a' } } } } } });
  await users.findMany({ with: { posts: { where: { comments: { some: { body: 'x' } } } } } });

  // Mutations and the other read args.
  await users.update({ where: { id: 1 }, data: { email: 'x' } });
  await users.delete({ where: { id: 1 } });
  await users.count({ where: { email: 'a' } });
  await users.updateMany({ where: { email: 'a' }, data: { email: 'b' } });
  await users.deleteMany({ where: { email: 'a' } });
  await users.upsert({ where: { id: 1 }, create: { email: 'a' }, update: { email: 'b' } });
  await users.aggregate({ where: { email: 'a' }, _count: true });
  await users.groupBy({ by: ['email'], where: { id: { gt: 1 } }, _count: true });
}

// ---------------------------------------------------------------------------
// 3. `with` result inference is untouched (the deep-inference guard also lives
//    in with-inference.test.ts; this pins that a keyed `where` in the same
//    literal does not disturb it).
// ---------------------------------------------------------------------------

async function inferenceStillWorks(): Promise<void> {
  const rows = await users.findMany({
    where: { email: 'a' },
    with: { posts: { where: { title: 'x' }, with: { comments: { with: { post: true } } } } },
  });
  const _title: string = rows[0]!.posts[0]!.comments[0]!.post!.title;
  const _email: string = rows[0]!.email;
}

// ---------------------------------------------------------------------------
// 4. Back-compat: the permissive form is preserved everywhere the relations
//    map is unknown.
// ---------------------------------------------------------------------------

/** An older generated client: no relations map threaded at all. */
declare const untypedUsers: QueryInterface<User>;

/** A pre-0.7.1 style relations map: bare types, no `RelationDescriptor` brand. */
interface LegacyUserRelations {
  posts: Post[];
  profile: Comment | null;
}
declare const legacyUsers: QueryInterface<User, LegacyUserRelations>;

async function backCompat(): Promise<void> {
  // No relations map → the historical open-keyed clause. Relation filters and
  // any other key still compile, exactly as before.
  await untypedUsers.findMany({ where: { posts: { some: { title: 'x' } } } });
  await untypedUsers.findMany({ where: { anythingAtAll: 'x' } });
  await untypedUsers.findMany({ with: { posts: { where: { anythingAtAll: 'x' } } } });

  // Legacy bare-shape relations: the relation KEY is recognised (so it is not
  // a false-positive typo) and its VALUE is unchecked.
  await legacyUsers.findMany({ where: { posts: { some: { title: 'x' } } } });
  await legacyUsers.findMany({ where: { profile: { is: { body: 'x' } } } });

  // Hand-written `WhereClause<T>` annotations (one type argument) still work.
  const w: WhereClause<User> = { email: 'a', posts: { some: { title: 'x' } } };
  void w;
}

// ---------------------------------------------------------------------------
// 5. The rest of the surface: every method that takes a `where` is key-checked
// ---------------------------------------------------------------------------

async function everyWhereBearingMethodTypos(): Promise<void> {
  // @ts-expect-error — 'emial' is not a column or relation of User
  await users.delete({ where: { emial: 'x' } });

  // @ts-expect-error — 'emial' is not a column or relation of User
  await users.upsert({ where: { emial: 'x' }, create: { email: 'a' }, update: {} });

  // @ts-expect-error — 'emial' is not a column or relation of User
  await users.updateMany({ where: { emial: 'x' }, data: { email: 'a' } });

  // @ts-expect-error — 'emial' is not a column or relation of User
  await users.deleteMany({ where: { emial: 'x' } });

  // @ts-expect-error — 'emial' is not a column or relation of User
  await users.count({ where: { emial: 'x' } });

  // @ts-expect-error — 'emial' is not a column or relation of User
  await users.aggregate({ where: { emial: 'x' }, _count: true });

  // @ts-expect-error — 'emial' is not a column or relation of User
  await users.groupBy({ by: ['email'], where: { emial: 'x' } });
}

async function everyWhereBearingMethodLegitimate(): Promise<void> {
  // Real columns, relation filters, and combinators all still compile.
  await users.delete({ where: { id: 1 } });
  await users.upsert({ where: { id: 1 }, create: { email: 'a' }, update: { email: 'b' } });
  await users.updateMany({ where: { posts: { some: { title: 'x' } } }, data: { email: 'a' } });
  await users.deleteMany({ where: { AND: [{ id: 1 }, { email: 'a' }] } });
  await users.count({ where: { OR: [{ id: 1 }, { posts: { none: {} } }] } });
  await users.aggregate({ where: { deletedAt: null }, _count: true });
  await users.groupBy({ by: ['email'], where: { NOT: { id: 1 } } });
  // count takes no args at all
  await users.count();
}

async function everyWhereBearingMethodBackCompat(): Promise<void> {
  // Without a relations map the historical open-keyed clause is preserved on
  // these methods too, so an older generated client keeps compiling.
  await untypedUsers.deleteMany({ where: { anythingAtAll: 'x' } });
  await untypedUsers.count({ where: { anythingAtAll: 'x' } });
  await untypedUsers.groupBy({ by: ['email'], where: { anythingAtAll: 'x' } });
}

void everyWhereBearingMethodTypos;
void everyWhereBearingMethodLegitimate;
void everyWhereBearingMethodBackCompat;

void topLevelTypos;
void nestedWithTypos;
void legitimateShapes;
void inferenceStillWorks;
void backCompat;

describe('where key validation', () => {
  it('is enforced at compile time (see npm run typecheck)', () => {
    // Intentionally empty: every assertion in this file is a type assertion.
  });
});
