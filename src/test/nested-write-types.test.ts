/**
 * turbine-orm — Type-level tests for nested-write input typing
 *
 * Verifies that `CreateArgs.data` / `UpdateArgs.data` accept relation keys
 * carrying nested write ops (`create` / `connect` / `connectOrCreate` in
 * create context, plus `disconnect` / `set` / `delete` / `update` / `upsert`
 * in update context) — matching exactly what the runtime nested-write engine
 * (src/nested-write.ts) supports. The relation keys come from the same
 * `RelationDescriptor` phantom-branded `*Relations` map that powers deep
 * `with`-clause inference, so typed clients get full IDE discovery with no
 * generator changes.
 *
 * Pure compile-time checks, same style as with-inference.test.ts: if any
 * assertion regresses, the file fails to typecheck and `tsx --test` exits
 * non-zero. Negative cases use `@ts-expect-error`, which itself errors if
 * the expected type error disappears.
 */

import { describe, it } from 'node:test';
import type { CreateDataInput, QueryInterface, RelationDescriptor, UpdateDataInput } from '../query/index.js';

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
// Mock entities + relations (mirroring what `generate.ts` emits)
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
  body: string;
}

type NoRelations = Record<never, never>;

interface UserRelations {
  posts: RelationDescriptor<Post, 'many', PostRelations>;
}

interface PostRelations {
  comments: RelationDescriptor<Comment, 'many', NoRelations>;
  author: RelationDescriptor<User, 'one', UserRelations>;
}

declare const users: QueryInterface<User, UserRelations>;
declare const posts: QueryInterface<Post, PostRelations>;
declare const untypedUsers: QueryInterface<User>;

// ---------------------------------------------------------------------------
// 1. Untyped escape hatch: R = {} collapses to the legacy Partial<T> shape
// ---------------------------------------------------------------------------

assertTrue<Equals<CreateDataInput<User>, Partial<User>>>();

// ---------------------------------------------------------------------------
// 2. Typed create(): relation keys accept create / connect / connectOrCreate
// ---------------------------------------------------------------------------

async function createOps() {
  if (false as boolean) {
    // Scalar-only create still typechecks unchanged (back-compat).
    await users.create({ data: { email: 'a@b.com' } });

    // Nested create — single object and array forms.
    await users.create({
      data: {
        email: 'a@b.com',
        posts: { create: { title: 'one' } },
      },
    });
    await users.create({
      data: {
        email: 'a@b.com',
        posts: {
          create: [{ title: 'one' }, { title: 'two' }],
          connect: [{ id: 1 }, { id: 2 }],
          connectOrCreate: { where: { id: 3 }, create: { title: 'three' } },
        },
      },
    });

    // Recursion: nested create data accepts the TARGET's own relation ops.
    await users.create({
      data: {
        email: 'a@b.com',
        posts: {
          create: {
            title: 'deep',
            comments: { create: [{ body: 'first!' }] },
          },
        },
      },
    });

    // @ts-expect-error — disconnect is an update-only op; invalid in create()
    await users.create({ data: { email: 'x', posts: { disconnect: [{ id: 1 }] } } });

    // @ts-expect-error — unknown nested op key
    await users.create({ data: { email: 'x', posts: { konnect: [{ id: 1 }] } } });

    // @ts-expect-error — nested create data must match the target entity
    await users.create({ data: { email: 'x', posts: { create: { totallyBogus: true } } } });

    // @ts-expect-error — untyped client (R = {}) keeps plain Partial<T> data
    await untypedUsers.create({ data: { email: 'x', posts: { create: { title: 't' } } } });
  }
}
void createOps;

// ---------------------------------------------------------------------------
// 3. Typed update(): relation keys accept the full op surface that
//    nested-write.ts supports at runtime.
// ---------------------------------------------------------------------------

async function updateOps() {
  if (false as boolean) {
    // Scalar update still typechecks unchanged (incl. atomic operators).
    await users.update({ where: { id: 1 }, data: { email: 'new@b.com' } });
    await users.update({ where: { id: 1 }, data: { id: { increment: 1 } } });

    await users.update({
      where: { id: 1 },
      data: {
        email: 'new@b.com',
        posts: {
          create: [{ title: 'added' }],
          connect: { id: 9 },
          connectOrCreate: [{ where: { id: 4 }, create: { title: 'four' } }],
          disconnect: [{ id: 5 }],
          set: [{ id: 6 }],
          delete: { id: 7 },
          update: [{ where: { id: 8 }, data: { title: 'renamed' } }],
          upsert: { where: { id: 10 }, create: { title: 'made' }, update: { title: 'kept' } },
        },
      },
    });

    // belongsTo-style nested update: `where` is optional (derived from FK).
    await posts.update({
      where: { id: 1 },
      data: { author: { update: { data: { email: 'moved@b.com' } } } },
    });

    // @ts-expect-error — nested update op requires a `data` field
    await users.update({ where: { id: 1 }, data: { posts: { update: { where: { id: 8 } } } } });

    // @ts-expect-error — upsert requires where + create + update
    await users.update({ where: { id: 1 }, data: { posts: { upsert: { where: { id: 1 } } } } });
  }
}
void updateOps;

// ---------------------------------------------------------------------------
// 4. UpdateDataInput keeps scalar fields' atomic-operator surface intact
// ---------------------------------------------------------------------------

type UserUpdateData = UpdateDataInput<User, UserRelations>;
declare const updateData: UserUpdateData;
// Scalar field accepts plain value or atomic operator object:
const _email: UserUpdateData['email'] = 'plain';
const _id: UserUpdateData['id'] = { increment: 1 };
void _email;
void _id;
void updateData;

// ---------------------------------------------------------------------------
// node:test stub so the runner picks up the file
// ---------------------------------------------------------------------------

describe('nested-write input typing (type-level)', () => {
  it('compile-time assertions pass', () => {
    // All assertions above are evaluated at compile time. Nothing to do here.
  });
});
