/**
 * turbine-orm — Generator output regression test
 *
 * Pins the shape that `generateTypes()` emits for `*Relations` interfaces.
 * The recursive `WithResult` type only delivers deep `with`-clause inference
 * when the generator emits each relation as a `RelationDescriptor<Target,
 * Cardinality, TargetRelations>`. If the generator regresses to bare shapes
 * (`posts: Post[]`, `profile: Profile | null`), users running `turbine
 * generate` lose every level of nesting beyond the first — even though the
 * type machinery in query.ts still works in isolation.
 *
 * This test stops that regression by parsing the literal output string.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateTypes } from '../generate.js';
import type { SchemaMetadata } from '../schema.js';

// Minimal mock schema: users → posts → comments, plus a one-to-one profile.
// The shapes below are the smallest valid SchemaMetadata that generateTypes
// will accept; they intentionally exercise hasMany, hasOne, and a target with
// no relations of its own (Profile / Comment) to verify the `{}` fallback.
const SCHEMA: SchemaMetadata = {
  enums: {},
  tables: {
    users: {
      name: 'users',
      columns: [
        {
          name: 'id',
          field: 'id',
          pgType: 'int8',
          tsType: 'number',
          nullable: false,
          hasDefault: true,
          isArray: false,
          pgArrayType: 'bigint[]',
        },
        {
          name: 'email',
          field: 'email',
          pgType: 'text',
          tsType: 'string',
          nullable: false,
          hasDefault: false,
          isArray: false,
          pgArrayType: 'text[]',
        },
      ],
      columnMap: { id: 'id', email: 'email' },
      reverseColumnMap: { id: 'id', email: 'email' },
      dateColumns: new Set(),
      pgTypes: { id: 'int8', email: 'text' },
      allColumns: ['id', 'email'],
      primaryKey: ['id'],
      uniqueColumns: [],
      relations: {
        posts: {
          type: 'hasMany',
          name: 'posts',
          from: 'users',
          to: 'posts',
          foreignKey: 'user_id',
          referenceKey: 'id',
        },
        profile: {
          type: 'hasOne',
          name: 'profile',
          from: 'users',
          to: 'profiles',
          foreignKey: 'user_id',
          referenceKey: 'id',
        },
      },
      indexes: [],
    },
    posts: {
      name: 'posts',
      columns: [
        {
          name: 'id',
          field: 'id',
          pgType: 'int8',
          tsType: 'number',
          nullable: false,
          hasDefault: true,
          isArray: false,
          pgArrayType: 'bigint[]',
        },
        {
          name: 'user_id',
          field: 'userId',
          pgType: 'int8',
          tsType: 'number',
          nullable: false,
          hasDefault: false,
          isArray: false,
          pgArrayType: 'bigint[]',
        },
        {
          name: 'title',
          field: 'title',
          pgType: 'text',
          tsType: 'string',
          nullable: false,
          hasDefault: false,
          isArray: false,
          pgArrayType: 'text[]',
        },
      ],
      columnMap: { id: 'id', userId: 'user_id', title: 'title' },
      reverseColumnMap: { id: 'id', user_id: 'userId', title: 'title' },
      dateColumns: new Set(),
      pgTypes: { id: 'int8', user_id: 'int8', title: 'text' },
      allColumns: ['id', 'user_id', 'title'],
      primaryKey: ['id'],
      uniqueColumns: [],
      relations: {
        author: {
          type: 'belongsTo',
          name: 'author',
          from: 'posts',
          to: 'users',
          foreignKey: 'user_id',
          referenceKey: 'id',
        },
        comments: {
          type: 'hasMany',
          name: 'comments',
          from: 'posts',
          to: 'comments',
          foreignKey: 'post_id',
          referenceKey: 'id',
        },
      },
      indexes: [],
    },
    comments: {
      name: 'comments',
      columns: [
        {
          name: 'id',
          field: 'id',
          pgType: 'int8',
          tsType: 'number',
          nullable: false,
          hasDefault: true,
          isArray: false,
          pgArrayType: 'bigint[]',
        },
        {
          name: 'post_id',
          field: 'postId',
          pgType: 'int8',
          tsType: 'number',
          nullable: false,
          hasDefault: false,
          isArray: false,
          pgArrayType: 'bigint[]',
        },
        {
          name: 'body',
          field: 'body',
          pgType: 'text',
          tsType: 'string',
          nullable: false,
          hasDefault: false,
          isArray: false,
          pgArrayType: 'text[]',
        },
      ],
      columnMap: { id: 'id', postId: 'post_id', body: 'body' },
      reverseColumnMap: { id: 'id', post_id: 'postId', body: 'body' },
      dateColumns: new Set(),
      pgTypes: { id: 'int8', post_id: 'int8', body: 'text' },
      allColumns: ['id', 'post_id', 'body'],
      primaryKey: ['id'],
      uniqueColumns: [],
      relations: {}, // leaf — exercises the `{}` fallback in RelationDescriptor
      indexes: [],
    },
    profiles: {
      name: 'profiles',
      columns: [
        {
          name: 'id',
          field: 'id',
          pgType: 'int8',
          tsType: 'number',
          nullable: false,
          hasDefault: true,
          isArray: false,
          pgArrayType: 'bigint[]',
        },
        {
          name: 'user_id',
          field: 'userId',
          pgType: 'int8',
          tsType: 'number',
          nullable: false,
          hasDefault: false,
          isArray: false,
          pgArrayType: 'bigint[]',
        },
        {
          name: 'bio',
          field: 'bio',
          pgType: 'text',
          tsType: 'string',
          nullable: true,
          hasDefault: false,
          isArray: false,
          pgArrayType: 'text[]',
        },
      ],
      columnMap: { id: 'id', userId: 'user_id', bio: 'bio' },
      reverseColumnMap: { id: 'id', user_id: 'userId', bio: 'bio' },
      dateColumns: new Set(),
      pgTypes: { id: 'int8', user_id: 'int8', bio: 'text' },
      allColumns: ['id', 'user_id', 'bio'],
      primaryKey: ['id'],
      uniqueColumns: [],
      relations: {},
      indexes: [],
    },
  },
};

/** Pull just the body of `export interface ${name} { ... }` out of the output. */
function extractInterfaceBody(source: string, name: string): string {
  const re = new RegExp(`export interface ${name}\\s*\\{([\\s\\S]*?)\\n\\}`);
  const match = source.match(re);
  if (!match) throw new Error(`interface ${name} not found in generator output`);
  return match[1]!;
}

describe('generator: *Relations interface output', () => {
  const out = generateTypes(SCHEMA);

  it('imports RelationDescriptor from turbine-orm', () => {
    assert.match(out, /import type \{ RelationDescriptor, UpdateOperatorInput \} from 'turbine-orm';/);
  });

  it('emits hasMany relations as RelationDescriptor<Target, "many", TargetRelations>', () => {
    const userRelations = extractInterfaceBody(out, 'UserRelations');
    // users.posts → Post[], target Post has its own relations
    assert.match(userRelations, /posts: RelationDescriptor<Post, 'many', PostRelations>;/);

    const postRelations = extractInterfaceBody(out, 'PostRelations');
    // posts.comments → Comment[], target Comment has NO relations → uses {}
    assert.match(postRelations, /comments: RelationDescriptor<Comment, 'many', \{\}>;/);
  });

  it('emits belongsTo / hasOne relations as RelationDescriptor<Target, "one", TargetRelations>', () => {
    const postRelations = extractInterfaceBody(out, 'PostRelations');
    // posts.author → User | null, target User has its own relations
    assert.match(postRelations, /author: RelationDescriptor<User, 'one', UserRelations>;/);

    const userRelations = extractInterfaceBody(out, 'UserRelations');
    // users.profile → Profile | null, target Profile has NO relations → uses {}
    assert.match(userRelations, /profile: RelationDescriptor<Profile, 'one', \{\}>;/);
  });

  it('does NOT emit the legacy bare-shape inside *Relations interfaces', () => {
    // The legacy emitter wrote `posts: Post[];` directly inside `UserRelations`.
    // The new emitter wraps every member in `RelationDescriptor<...>`. If this
    // regression check fails, the generator has reverted and deep `with`
    // inference is broken end-to-end. Note: the per-relation `*With<Rel>`
    // compat interfaces (e.g. `UserWithPosts`) DO still emit bare shapes —
    // we only check the Relations interface body here, not the whole file.
    const userRelations = extractInterfaceBody(out, 'UserRelations');
    assert.doesNotMatch(userRelations, /posts: Post\[\];/);
    assert.doesNotMatch(userRelations, /profile: Profile \| null;/);

    const postRelations = extractInterfaceBody(out, 'PostRelations');
    assert.doesNotMatch(postRelations, /author: User \| null;/);
  });

  it('still emits the legacy *With<Relation> compat interfaces (one level deep)', () => {
    // These are kept for back-compat with hand-written code that imported
    // them directly. They're not part of the deep-inference machinery, just
    // a courtesy alias.
    assert.match(out, /export interface UserWithPosts extends User \{/);
    assert.match(out, /export interface PostWithComments extends Post \{/);
  });
});
