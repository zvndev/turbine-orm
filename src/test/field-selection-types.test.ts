/**
 * turbine-orm, Type-level tests for `select` / `omit` key validation
 *
 * A misspelled column in `select` / `omit` used to compile silently: the flag
 * map's type is INFERRED from the object literal, so `{ emial: true }` just
 * became the inferred type and the query quietly narrowed the row to
 * `Pick<T, never>`. `FieldFlags` (query/types.ts) maps every key that is not a
 * field of the entity to `never`, which turns the typo into a compile error at
 * the offending key while leaving legitimate flag maps untouched.
 *
 * IMPORTANT, what actually guards this file: `tsx`/esbuild strips types
 * WITHOUT typechecking, so `npm run test:unit` runs it fine even if the
 * validation regresses. The REAL guard is `npm run typecheck`
 * (`tsc --noEmit --project tsconfig.test.json`), which re-includes `src/test`.
 * An unused `@ts-expect-error` is itself an error, so a regression that lets a
 * typo through fails the typecheck job.
 *
 * NOT covered here, deliberately: `where`, it has its own file now
 * (where-key-types.test.ts). `WhereClause<T>` used to carry a
 * `[relationName: string]: unknown` index signature (needed for relation
 * filters) which annihilated excess-property checking; it now takes the
 * generated relations map as a second type argument (`WhereClause<T, R>`) and
 * enumerates the relation keys explicitly instead.
 * `orderBy` is still open-keyed (see the note at the end of the file).
 */

import { describe, it } from 'node:test';
import type { QueryInterface, RelationDescriptor } from '../query/index.js';

/** Compile-time exact-equality assertion. Resolves to `true` only when A and B are mutually assignable. */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Force a compile error if `T` is not the literal `true` type. */
function assertTrue<T extends true>(): T {
  return true as T;
}

interface Post {
  id: number;
  userId: number;
  title: string;
}

interface User {
  id: number;
  email: string;
  createdAt: Date;
}

interface PostRelations {
  author: RelationDescriptor<User, 'one', Record<string, never>>;
}

interface UserRelations {
  posts: RelationDescriptor<Post, 'many', PostRelations>;
}

declare const users: QueryInterface<User, UserRelations>;

// ---------------------------------------------------------------------------
// 1. Negative cases: a typo in select / omit is a compile error
// ---------------------------------------------------------------------------

async function selectTypoIsRejected() {
  if (false as boolean) {
    // @ts-expect-error `emial` is not a field of User
    await users.findMany({ select: { emial: true } });
    // @ts-expect-error `emial` is not a field of User
    await users.findMany({ omit: { emial: true } });
    // @ts-expect-error a valid key does not license an invalid sibling
    await users.findMany({ select: { id: true, emial: true } });
    // @ts-expect-error `emial` is not a field of User (findUnique)
    await users.findUnique({ where: { id: 1 }, select: { emial: true } });
    // @ts-expect-error `emial` is not a field of User (findFirst)
    await users.findFirst({ omit: { emial: true } });
    // @ts-expect-error `false` does not exempt an unknown key either
    await users.findMany({ select: { emial: false } });
    // @ts-expect-error a relation name is not a scalar field: relations come from `with`
    await users.findMany({ select: { posts: true } });
  }
}
void selectTypoIsRejected;

// ---------------------------------------------------------------------------
// 2. Positive cases: every legitimate form still compiles AND still infers
// ---------------------------------------------------------------------------

async function selectStillInfers() {
  if (false as boolean) {
    const one = await users.findMany({ select: { id: true } });
    assertTrue<Equals<(typeof one)[number], Pick<User, 'id'>>>();

    const two = await users.findMany({ select: { id: true, email: true } });
    assertTrue<Equals<(typeof two)[number], Pick<User, 'id' | 'email'>>>();

    // A `false` flag is a legitimate way to spell "not selected".
    const mixed = await users.findMany({ select: { id: true, email: false } });
    assertTrue<Equals<(typeof mixed)[number], Pick<User, 'id'>>>();

    const omitted = await users.findMany({ omit: { email: true } });
    assertTrue<Equals<(typeof omitted)[number], Omit<User, 'email'>>>();

    // select + with: the relation survives the narrowing.
    const withRel = await users.findMany({ select: { id: true }, with: { posts: true } });
    assertTrue<Equals<(typeof withRel)[number]['id'], number>>();
    assertTrue<Equals<(typeof withRel)[number]['posts'], Post[]>>();

    // An empty flag map is still accepted (it selects nothing, as before).
    await users.findMany({ select: {} });
    await users.findMany({ omit: {} });

    // No flag map at all: the row type is untouched.
    const plain = await users.findMany({ where: { id: 1 } });
    assertTrue<Equals<(typeof plain)[number], User>>();

    const unique = await users.findUnique({ where: { id: 1 }, select: { id: true } });
    assertTrue<Equals<typeof unique, Pick<User, 'id'> | null>>();

    // A flag map held in a variable (not a literal) keeps working: it is still
    // checked, just without the excess-property diagnostic on the literal.
    const flags = { id: true } as const;
    const viaVar = await users.findMany({ select: flags });
    assertTrue<Equals<(typeof viaVar)[number], Pick<User, 'id'>>>();
  }
}
void selectStillInfers;

// ---------------------------------------------------------------------------
// 3. orderBy is deliberately NOT narrowed (documented, not forgotten)
//
//     Every legitimate orderBy form still compiles. Keying `OrderByObject` to
//     `keyof T` would make it a mapped type with optional members, whose
//     implicit index signature is `value | undefined`, no longer assignable to
//     the open `OrderByClause` that the internal compilers (buildOrderBy,
//     collectOrderByParams, orderByEntries) take. See the task note in the
//     report: closing this needs a matching signature change in query/.
// ---------------------------------------------------------------------------

async function orderByFormsStillCompile() {
  if (false as boolean) {
    await users.findMany({ orderBy: { createdAt: 'desc' } });
    await users.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] });
    await users.findMany({ orderBy: { createdAt: { sort: 'desc', nulls: 'last' } } });
    // Relation ordering: keyed by relation name, not by a column of User.
    await users.findMany({ orderBy: { posts: { _count: 'desc' } } });
    await users.findMany({
      orderBy: { posts: { pick: { orderBy: { id: 'desc' } }, by: 'title', direction: 'asc' } },
    });
  }
}
void orderByFormsStillCompile;

describe('field-selection-types (type-level)', () => {
  it('compile-time assertions pass', () => {
    // All assertions above are evaluated at compile time. Nothing to do here.
  });
});
