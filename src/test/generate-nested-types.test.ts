import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateTypes } from '../generate.js';
import type { SchemaMetadata } from '../schema.js';

const schema: SchemaMetadata = {
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
      uniqueColumns: [['id'], ['email']],
      relations: {
        posts: {
          type: 'hasMany' as const,
          name: 'posts',
          from: 'users',
          to: 'posts',
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
          name: 'title',
          field: 'title',
          pgType: 'text',
          tsType: 'string',
          nullable: false,
          hasDefault: false,
          isArray: false,
          pgArrayType: 'text[]',
        },
        {
          name: 'slug',
          field: 'slug',
          pgType: 'text',
          tsType: 'string',
          nullable: true,
          hasDefault: false,
          isArray: false,
          pgArrayType: 'text[]',
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
      ],
      columnMap: { id: 'id', title: 'title', slug: 'slug', userId: 'user_id' },
      reverseColumnMap: { id: 'id', title: 'title', slug: 'slug', user_id: 'userId' },
      dateColumns: new Set(),
      pgTypes: { id: 'int8', title: 'text', slug: 'text', user_id: 'int8' },
      allColumns: ['id', 'title', 'slug', 'user_id'],
      primaryKey: ['id'],
      uniqueColumns: [['id'], ['slug']],
      relations: {
        author: {
          type: 'belongsTo' as const,
          name: 'author',
          from: 'posts',
          to: 'users',
          foreignKey: 'user_id',
          referenceKey: 'id',
        },
      },
      indexes: [],
    },
  },
  enums: {},
};

describe('generate nested input types', () => {
  it('emits WhereUnique type from PK and unique indexes', () => {
    const output = generateTypes(schema);
    assert.ok(output.includes('export type PostWhereUnique ='));
    // Should have id and slug branches
    assert.ok(output.includes('id: number'));
    assert.ok(output.includes('slug: string'));
  });

  it('deduplicates PK from uniqueColumns in WhereUnique', () => {
    const output = generateTypes(schema);
    // Users has PK [id] and uniqueColumns [[id], [email]].
    // The WhereUnique should have { id: number } | { email: string }, NOT
    // { id: number } | { id: number } | { email: string }.
    assert.ok(output.includes('export type UserWhereUnique ='));
    // Count occurrences of '{ id: number }' in the UserWhereUnique line
    const line = output.split('\n').find((l) => l.includes('export type UserWhereUnique'));
    assert.ok(line);
    const idCount = (line.match(/\{ id: number \}/g) || []).length;
    assert.equal(idCount, 1, 'Should not duplicate PK in WhereUnique');
  });

  it('emits CreateInput type with nested relation fields', () => {
    const output = generateTypes(schema);
    assert.ok(output.includes('export type UserCreateInput ='));
    assert.ok(output.includes('posts?:'));
    assert.ok(output.includes('PostNestedCreateInput'));
  });

  it('emits UpdateInput type with full nested operations', () => {
    const output = generateTypes(schema);
    assert.ok(output.includes('export type UserUpdateInput ='));
    assert.ok(output.includes('PostNestedUpdateInput'));
  });

  it('emits NestedCreateInput with create, connect, connectOrCreate', () => {
    const output = generateTypes(schema);
    assert.ok(output.includes('export interface PostNestedCreateInput'));
    assert.ok(output.includes('create?: PostCreateInput | PostCreateInput[]'));
    assert.ok(output.includes('connect?: PostWhereUnique | PostWhereUnique[]'));
    assert.ok(output.includes('connectOrCreate?: PostConnectOrCreate | PostConnectOrCreate[]'));
  });

  it('emits NestedUpdateInput with disconnect, set, delete', () => {
    const output = generateTypes(schema);
    assert.ok(output.includes('export interface PostNestedUpdateInput'));
    assert.ok(output.includes('disconnect?: PostWhereUnique | PostWhereUnique[]'));
    assert.ok(output.includes('set?: PostWhereUnique[]'));
    assert.ok(output.includes('delete?: PostWhereUnique | PostWhereUnique[]'));
  });

  it('emits ConnectOrCreate type', () => {
    const output = generateTypes(schema);
    assert.ok(output.includes('export interface PostConnectOrCreate'));
    assert.ok(output.includes('where: PostWhereUnique'));
    assert.ok(output.includes('create: PostCreateInput'));
  });

  it('emits hasMany relations with NestedUpdateInput in UpdateInput', () => {
    const output = generateTypes(schema);
    // User has hasMany posts, so UpdateInput should use PostNestedUpdateInput
    const lines = output.split('\n');
    const updateInputStart = lines.findIndex((l) => l.includes('export type UserUpdateInput'));
    assert.ok(updateInputStart >= 0);
    // Find the posts field within the next few lines
    const slice = lines.slice(updateInputStart, updateInputStart + 5).join('\n');
    assert.ok(slice.includes('PostNestedUpdateInput'));
  });

  it('emits belongsTo relations with NestedCreateInput in CreateInput', () => {
    const output = generateTypes(schema);
    // Post has belongsTo author, so CreateInput should use UserNestedCreateInput
    assert.ok(output.includes('export type PostCreateInput ='));
    const lines = output.split('\n');
    const createInputStart = lines.findIndex((l) => l.includes('export type PostCreateInput'));
    assert.ok(createInputStart >= 0);
    const slice = lines.slice(createInputStart, createInputStart + 5).join('\n');
    assert.ok(slice.includes('UserNestedCreateInput'));
  });

  it('emits types for tables without relations (leaf tables get WhereUnique only)', () => {
    // Both users and posts have relations in this schema. Create a minimal
    // schema with a leaf table to test that WhereUnique is still emitted.
    const leafSchema: SchemaMetadata = {
      tables: {
        tags: {
          name: 'tags',
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
              name: 'label',
              field: 'label',
              pgType: 'text',
              tsType: 'string',
              nullable: false,
              hasDefault: false,
              isArray: false,
              pgArrayType: 'text[]',
            },
          ],
          columnMap: { id: 'id', label: 'label' },
          reverseColumnMap: { id: 'id', label: 'label' },
          dateColumns: new Set(),
          pgTypes: { id: 'int8', label: 'text' },
          allColumns: ['id', 'label'],
          primaryKey: ['id'],
          uniqueColumns: [['id'], ['label']],
          relations: {},
          indexes: [],
        },
      },
      enums: {},
    };

    const output = generateTypes(leafSchema);
    assert.ok(output.includes('export type TagWhereUnique ='));
    // Leaf tables still get NestedCreateInput, NestedUpdateInput, ConnectOrCreate
    assert.ok(output.includes('export interface TagNestedCreateInput'));
    assert.ok(output.includes('export interface TagNestedUpdateInput'));
    assert.ok(output.includes('export interface TagConnectOrCreate'));
    // But should NOT emit CreateInput/UpdateInput (no relations to add)
    assert.ok(!output.includes('export type TagCreateInput ='));
    assert.ok(!output.includes('export type TagUpdateInput ='));
  });
});
