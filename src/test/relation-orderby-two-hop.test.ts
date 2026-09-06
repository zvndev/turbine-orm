/**
 * turbine-orm: relation `orderBy` through more than one to-one hop
 *
 * The builder has compiled `orderBy: { post: { user: { name: 'asc' } } }` for a
 * long time (each further to-one hop becomes a JOIN inside the ONE correlated
 * scalar subquery, see `buildChainedToOneOrderBy` in query/relations.ts), and
 * the queries page documents it. The TYPE did not follow: `RelationOrderBy`
 * was one hop deep, so the documented call compiled only behind `as any`.
 *
 * `RelationOrderBy` is now recursive for to-one hops with a bounded depth that
 * matches the runtime's cap exactly: a head relation plus ten chained hops
 * (`MAX_ORDER_BY_RELATION_HOPS`), eleven relation keys in all. The type and
 * the builder are pinned to the same boundary below, so one cannot move
 * without the other.
 *
 * What the type deliberately still cannot express: that a hop is to-MANY.
 * `RelationOrderBy` is keyed by `string`, not by the target's relation map,
 * so `{ post: { comments: { body: 'asc' } } }` typechecks and is refused by the
 * builder with E003 (pinned here too). A direction that is not a direction, a
 * `nulls` outside the `{ sort, nulls }` spec form, and a twelfth hop are
 * compile errors.
 *
 * Also here (public-type companion): `UpsertArgs.update` accepts the same
 * atomic operators `update()` accepts; `create` does not.
 *
 * WHAT GUARDS THE TYPE HALF: `tsx` strips types without checking them, so the
 * compile-time assertions are enforced by `npm run typecheck`
 * (`tsc --noEmit --project tsconfig.test.json`), not by the test runner. Keep
 * this file in the typecheck lane. The SQL pins run under `tsx --test`.
 *
 * Run: npx tsx --test src/test/relation-orderby-two-hop.test.ts && npm run typecheck
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CircularRelationError, ValidationError } from '../errors.js';
import type { FindManyArgs, QueryInterface, RelationDescriptor, UpsertArgs } from '../query/index.js';
// Read from the declaring module deliberately, not from the barrel: these
// assertions are about the TYPE's shape, and importing it here from
// `../query/index.js` would make them pass or fail on whether the barrel
// re-exports it, which is a different question that `public-surface` covers.
// (It does re-export it, as of this release.)
import type { RelationOrderBy } from '../query/types.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

// ---------------------------------------------------------------------------
// Type-level assertion helpers (the with-inference.test.ts style)
// ---------------------------------------------------------------------------

/** Compile-time exact-equality assertion. */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** `true` when `A` is assignable to `B`, `false` otherwise (no distribution). */
type Extends<A, B> = [A] extends [B] ? true : false;

/** Force a compile error if `T` is not the literal `true` type. */
function assertTrue<T extends true>(): T {
  return true as T;
}

// ---------------------------------------------------------------------------
// Mock entities and branded relations (what generate.ts emits)
// ---------------------------------------------------------------------------

interface Organization {
  id: number;
  name: string;
}

interface User {
  id: number;
  orgId: number;
  name: string;
}

interface Post {
  id: number;
  userId: number;
  title: string;
}

interface Comment {
  id: number;
  postId: number;
  body: string;
}

interface OrganizationRelations {
  users: RelationDescriptor<User, 'many', UserRelations>;
}

interface UserRelations {
  organization: RelationDescriptor<Organization, 'one', OrganizationRelations>;
  posts: RelationDescriptor<Post, 'many', PostRelations>;
}

interface PostRelations {
  user: RelationDescriptor<User, 'one', UserRelations>;
  comments: RelationDescriptor<Comment, 'many', CommentRelations>;
}

interface CommentRelations {
  post: RelationDescriptor<Post, 'one', PostRelations>;
}

// ---------------------------------------------------------------------------
// 1. RelationOrderBy accepts a chain of to-one hops
// ---------------------------------------------------------------------------

// One hop, the historical shape, unchanged.
assertTrue<Extends<{ name: 'asc' }, RelationOrderBy>>();
assertTrue<Extends<{ name: { sort: 'desc'; nulls: 'last' } }, RelationOrderBy>>();
assertTrue<Extends<{ _count: 'desc' }, RelationOrderBy>>();

// Two and three hops: the documented `{ post: { user: { name: 'asc' } } }`
// form, seen from the value of the first relation key.
assertTrue<Extends<{ user: { name: 'asc' } }, RelationOrderBy>>();
assertTrue<Extends<{ user: { organization: { name: 'asc' } } }, RelationOrderBy>>();
// A `{ sort, nulls }` spec is accepted at the end of a chain too.
assertTrue<Extends<{ user: { organization: { name: { sort: 'desc'; nulls: 'first' } } } }, RelationOrderBy>>();

// Wrong shapes stay compile errors.
assertTrue<Equals<Extends<{ user: { name: 'sideways' } }, RelationOrderBy>, false>>();
assertTrue<Equals<Extends<{ user: { organization: { name: 42 } } }, RelationOrderBy>, false>>();
// `nulls` only exists inside the spec form; beside a bare direction it is a
// second key whose value is not a direction.
assertTrue<Equals<Extends<{ user: { organization: { name: 'asc'; nulls: 'last' } } }, RelationOrderBy>, false>>();
assertTrue<Equals<Extends<{ user: ['asc'] }, RelationOrderBy>, false>>();
assertTrue<Equals<Extends<{ user: null }, RelationOrderBy>, false>>();

// ---------------------------------------------------------------------------
// 2. The depth bound equals the builder's: eleven relation keys, not twelve
// ---------------------------------------------------------------------------

/** `{ parent: { parent: ... N times ... Inner } }`. */
type Nest<Inner, N extends number, Acc extends unknown[] = []> = Acc['length'] extends N
  ? Inner
  : Nest<{ parent: Inner }, N, [...Acc, 0]>;

// An orderBy object with N `parent` keys has N relation hops; the value of the
// FIRST key is the `RelationOrderBy` and carries N - 1 further hops.
type ElevenHops = Nest<{ name: 'asc' }, 11>;
type TwelveHops = Nest<{ name: 'asc' }, 12>;
assertTrue<Extends<ElevenHops['parent'], RelationOrderBy>>();
assertTrue<Equals<Extends<TwelveHops['parent'], RelationOrderBy>, false>>();

// ---------------------------------------------------------------------------
// 3. The call site: FindManyArgs on a typed QueryInterface
// ---------------------------------------------------------------------------

type CommentOrderBy = NonNullable<FindManyArgs<Comment, CommentRelations>['orderBy']>;
assertTrue<Extends<{ post: { user: { name: 'asc' } } }, CommentOrderBy>>();
assertTrue<Extends<{ post: { user: { organization: { name: 'desc' } } } }, CommentOrderBy>>();
assertTrue<Extends<[{ post: { user: { name: 'asc' } } }, { id: 'asc' }], CommentOrderBy>>();
assertTrue<Equals<Extends<{ post: { user: { name: 'sideways' } } }, CommentOrderBy>, false>>();

declare const comments: QueryInterface<Comment, CommentRelations>;

// Never executed (guarded by `false`); TypeScript still checks every call, so
// this is the exact signature a user writes against. An unused
// `@ts-expect-error` is itself an error, so the negative case cannot rot.
async function callSite() {
  if (false as boolean) {
    await comments.findMany({ orderBy: { post: { user: { name: 'asc' } } } });
    await comments.findMany({ orderBy: [{ post: { user: { organization: { name: 'desc' } } } }, { id: 'asc' }] });
    await comments.findMany({
      orderBy: { post: { user: { organization: { name: { sort: 'asc', nulls: 'last' } } } } },
    });
    // @ts-expect-error a direction is 'asc' | 'desc' (or a { sort, nulls } spec), at any depth
    await comments.findMany({ orderBy: { post: { user: { name: 'sideways' } } } });
    // @ts-expect-error the head key is still checked against the entity's relations
    await comments.findMany({ orderBy: { psot: { user: { name: 'asc' } } } });
  }
}
void callSite;

// ---------------------------------------------------------------------------
// 4. UpsertArgs.update takes the atomic operators update() takes; create does not
// ---------------------------------------------------------------------------

interface Counter {
  id: number;
  count: number;
  label: string;
}

type UpsertUpdate = UpsertArgs<Counter>['update'];
type UpsertCreate = UpsertArgs<Counter>['create'];

assertTrue<Extends<{ count: { increment: 1 } }, UpsertUpdate>>();
assertTrue<Extends<{ count: { set: 0 }; label: { set: 'x' } }, UpsertUpdate>>();
// Plain values keep working, as they do on update().
assertTrue<Extends<{ count: 5; label: 'x' }, UpsertUpdate>>();
// The arithmetic operators are for number fields only.
assertTrue<Equals<Extends<{ label: { increment: 1 } }, UpsertUpdate>, false>>();
// `create` inserts a row; there is nothing to increment.
assertTrue<Equals<Extends<{ count: { increment: 1 } }, UpsertCreate>, false>>();
assertTrue<Extends<{ count: 1; label: 'x' }, UpsertCreate>>();

// ---------------------------------------------------------------------------
// 5. Build-only SQL: the builder compiles what the type now admits
// ---------------------------------------------------------------------------

function belongsTo(from: string, name: string, to: string, foreignKey: string) {
  return { type: 'belongsTo' as const, name, from, to, foreignKey, referenceKey: 'id' };
}

function hasMany(from: string, name: string, to: string, foreignKey: string) {
  return { type: 'hasMany' as const, name, from, to, foreignKey, referenceKey: 'id' };
}

/** comments -> posts -> users -> organizations, plus a self-referencing tree. */
function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      comments: mockTable(
        'comments',
        [
          { name: 'id', field: 'id' },
          { name: 'post_id', field: 'postId' },
          { name: 'body', field: 'body', pgType: 'text' },
        ],
        { post: belongsTo('comments', 'post', 'posts', 'post_id') },
      ),
      posts: mockTable(
        'posts',
        [
          { name: 'id', field: 'id' },
          { name: 'user_id', field: 'userId' },
          { name: 'title', field: 'title', pgType: 'text' },
        ],
        {
          user: belongsTo('posts', 'user', 'users', 'user_id'),
          comments: hasMany('posts', 'comments', 'comments', 'post_id'),
        },
      ),
      users: mockTable(
        'users',
        [
          { name: 'id', field: 'id' },
          { name: 'org_id', field: 'orgId' },
          { name: 'name', field: 'name', pgType: 'text' },
        ],
        {
          organization: belongsTo('users', 'organization', 'organizations', 'org_id'),
          posts: hasMany('users', 'posts', 'posts', 'user_id'),
        },
      ),
      organizations: mockTable('organizations', [
        { name: 'id', field: 'id' },
        { name: 'name', field: 'name', pgType: 'text' },
      ]),
      categories: mockTable(
        'categories',
        [
          { name: 'id', field: 'id' },
          { name: 'parent_id', field: 'parentId' },
          { name: 'name', field: 'name', pgType: 'text' },
        ],
        { parent: belongsTo('categories', 'parent', 'categories', 'parent_id') },
      ),
    },
  };
}

const q = (table: string) => makeQuery(table, schema(), { warnOnUnlimited: false });

/** `{ parent: { parent: ... hops times ... { name: 'asc' } } }` built at runtime. */
function nestParent(hops: number): Record<string, unknown> {
  let value: Record<string, unknown> = { name: 'asc' };
  for (let i = 0; i < hops; i++) value = { parent: value };
  return value;
}

describe('two-hop relation orderBy compiles to one correlated subquery with a JOIN per extra hop', () => {
  it('two hops: comments by post.user.name', () => {
    const { sql, params } = q('comments').buildFindMany({ orderBy: { post: { user: { name: 'asc' } } } });
    assert.equal(
      sql,
      'SELECT "comments".* FROM "comments" ORDER BY (SELECT ord0c1."name" FROM "posts" ord0 ' +
        'JOIN "users" ord0c1 ON ord0c1."id" = ord0."user_id" ' +
        'WHERE ord0."id" = "comments"."post_id" LIMIT 1) ASC',
    );
    assert.deepEqual(params, []);
  });

  it('three hops: comments by post.user.organization.name, with a nulls spec at the end', () => {
    const { sql } = q('comments').buildFindMany({
      orderBy: { post: { user: { organization: { name: { sort: 'desc', nulls: 'last' } } } } },
    });
    assert.equal(
      sql,
      'SELECT "comments".* FROM "comments" ORDER BY (SELECT ord0c2."name" FROM "posts" ord0 ' +
        'JOIN "users" ord0c1 ON ord0c1."id" = ord0."user_id" ' +
        'JOIN "organizations" ord0c2 ON ord0c2."id" = ord0c1."org_id" ' +
        'WHERE ord0."id" = "comments"."post_id" LIMIT 1) DESC NULLS LAST',
    );
  });

  it('the array form mixes a chained relation term with a plain column', () => {
    const { sql } = q('comments').buildFindMany({
      orderBy: [{ post: { user: { name: 'asc' } } }, { id: 'desc' }],
    });
    assert.match(
      sql,
      /ORDER BY \(SELECT ord0c1\."name" FROM "posts" ord0 JOIN "users" ord0c1 .*LIMIT 1\) ASC, "id" DESC$/,
    );
  });
});

describe('what the type cannot refuse, the builder does', () => {
  it('a to-many hop in the chain is E003 naming the relation', () => {
    assert.throws(
      () => q('comments').buildFindMany({ orderBy: { post: { comments: { body: 'asc' } } } }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError, String(err));
        assert.match(err.message, /to-many relation "comments"/);
        return true;
      },
    );
  });

  it('an unknown column at the end of the chain is E003 naming the path', () => {
    assert.throws(
      () => q('comments').buildFindMany({ orderBy: { post: { user: { nmae: 'asc' } } } }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError, String(err));
        assert.match(err.message, /"nmae".*"post\.user"/);
        return true;
      },
    );
  });
});

describe('the depth bound is the same at compile time and at run time', () => {
  it('eleven relation hops compile (a head plus ten chained)', () => {
    const { sql } = q('categories').buildFindMany({ orderBy: nestParent(11) as never });
    assert.match(sql, /JOIN "categories" ord0c10 ON ord0c10\."id" = ord0c9\."parent_id" WHERE/);
    assert.doesNotMatch(sql, /ord0c11/);
  });

  it('a twelfth hop is E007, the nested-with depth cap', () => {
    assert.throws(
      () => q('categories').buildFindMany({ orderBy: nestParent(12) as never }),
      (err: unknown) => {
        assert.ok(err instanceof CircularRelationError, String(err));
        assert.equal(err.code, 'TURBINE_E007');
        return true;
      },
    );
  });
});
