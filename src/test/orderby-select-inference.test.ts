/**
 * turbine-orm, Type-level tests for key-checked `orderBy`, nested
 * `select` / `omit`, and `with` inference on the DEFERRED builders.
 *
 * Before 0.51 these three surfaces were open-keyed while `where` was not, so
 * `orderBy: { nmae: 'asc' }` and `with: { posts: { select: { titel: true } } }`
 * compiled cleanly and failed at runtime with E003, and the `build*` family
 * returned the bare entity type, so a `pipeline()` result lost its relations.
 *
 * IMPORTANT, what actually guards this file: `tsx`/esbuild strips types WITHOUT
 * typechecking, so `tsx --test` runs it fine even if inference has regressed.
 * The REAL guard is `npm run typecheck`
 * (`tsc --noEmit --project tsconfig.test.json`), which re-includes `src/test`.
 * Every `@ts-expect-error` below is load-bearing in BOTH directions: if the
 * error stops happening, tsc reports the directive as unused and fails.
 *
 * The runtime portion runs one empty `it()` so node:test recognises the file.
 */

import { describe, it } from 'node:test';
import type { QueryInterface, RelationDescriptor } from '../query/index.js';

interface User {
  id: number;
  name: string;
  email: string;
}
interface Post {
  id: number;
  title: string;
  userId: number;
}
interface PostRelations {
  // biome-ignore lint/complexity/noBannedTypes: {} means "the target declares no relations"
  author: RelationDescriptor<User, 'one', {}>;
}
interface UserRelations {
  posts: RelationDescriptor<Post, 'many', PostRelations>;
}

declare const users: QueryInterface<User, UserRelations>;
declare const dynamicOrder: Record<string, 'asc' | 'desc'>;
declare const rawResult: never;
declare const untyped: QueryInterface<Record<string, unknown>>;

// Everything below lives inside a function that is NEVER CALLED. `declare`
// is erased at runtime, so these statements would throw if they executed;
// tsc still typechecks the body, which is the entire point of the file.
function _compileTimeChecks(): void {
  // ---------------------------------------------------------------------------
  // orderBy is key-checked against the entity AND its relations
  // ---------------------------------------------------------------------------

  void users.findMany({ orderBy: { name: 'asc' } });
  void users.findMany({ orderBy: [{ id: 'desc' }, { name: { sort: 'asc', nulls: 'last' } }] });
  void users.findMany({ orderBy: { posts: { _count: 'desc' } } });

  // @ts-expect-error - "nmae" is neither a column nor a relation on User
  void users.findMany({ orderBy: { nmae: 'asc' } });
  // @ts-expect-error - a misspelled key inside an orderBy ARRAY member is caught too
  void users.findMany({ orderBy: [{ id: 'asc' }, { titel: 'desc' }] });

  // A clause built dynamically still assigns: an index signature satisfies each
  // optional target key, so this is not a breaking change for computed orderBy.
  void users.findMany({ orderBy: dynamicOrder });

  // ---------------------------------------------------------------------------
  // Nested select / omit are checked against the RELATION TARGET, not the parent
  // ---------------------------------------------------------------------------

  void users.findMany({ with: { posts: { select: { title: true } } } });
  void users.findMany({ with: { posts: { omit: { userId: true } } } });

  // @ts-expect-error - "titel" is not a field on Post
  void users.findMany({ with: { posts: { select: { titel: true } } } });
  // @ts-expect-error - "name" is a User field; the nested block is scoped to Post
  void users.findMany({ with: { posts: { omit: { name: true } } } });

  // ---------------------------------------------------------------------------
  // Nested orderBy is likewise scoped to the target
  // ---------------------------------------------------------------------------

  void users.findMany({ with: { posts: { orderBy: { title: 'asc' } } } });
  // @ts-expect-error - "titel" is not a field on Post
  void users.findMany({ with: { posts: { orderBy: { titel: 'asc' } } } });

  // ---------------------------------------------------------------------------
  // The deferred build* family carries `with` inference into its result type
  // ---------------------------------------------------------------------------

  const deferredMany = users.buildFindMany({ with: { posts: true } });
  const manyRows = deferredMany.transform(rawResult);
  const nestedTitle: string = manyRows[0]!.posts[0]!.title;
  void nestedTitle;
  // @ts-expect-error - a Post row has no "nope"
  void manyRows[0]!.posts[0]!.nope;

  const deferredOne = users.buildFindUnique({ where: { id: 1 }, with: { posts: true } });
  const oneRow = deferredOne.transform(rawResult);
  const oneTitle: string | undefined = oneRow?.posts[0]?.title;
  void oneTitle;

  const deferredFirst = users.buildFindFirst({ with: { posts: { with: { author: true } } } });
  const firstRow = deferredFirst.transform(rawResult);
  // Two levels deep, through the relation brand.
  const authorName: string | undefined = firstRow?.posts[0]?.author?.name;
  void authorName;

  // An untyped table keeps the open escape hatch: no relations are declared, so
  // neither orderBy nor nested select can be key-checked, and both stay open.
  void untyped.findMany({ orderBy: { anything_at_all: 'asc' } });
}
void _compileTimeChecks;

describe('orderBy / select / omit / deferred-builder inference', () => {
  it('is verified by tsc, not at runtime (see the file header)', () => {});
});
