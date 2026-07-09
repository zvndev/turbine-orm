/**
 * turbine-orm — Codegen for extended column types (WS-B / B2–B4)
 *
 * Verifies `generateTypes()` maps enum columns to their generated string-literal
 * union, array columns to `T[]`, enum arrays to `EnumType[]`, and vector columns
 * to `number[]`. Pure — no database.
 *
 * Run: npx tsx --test src/test/generate-column-types.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateTypes } from '../generate.js';
import type { ColumnMetadata, SchemaMetadata } from '../schema.js';

function col(overrides: Partial<ColumnMetadata> & Pick<ColumnMetadata, 'name'>): ColumnMetadata {
  return {
    field: overrides.name,
    pgType: 'text',
    tsType: 'string',
    nullable: false,
    hasDefault: false,
    isArray: false,
    pgArrayType: 'text[]',
    ...overrides,
  } as ColumnMetadata;
}

const SCHEMA: SchemaMetadata = {
  enums: { post_status: ['draft', 'published', 'archived'] },
  tables: {
    posts: {
      name: 'posts',
      columns: [
        col({ name: 'id', pgType: 'int8', dialectType: 'int8', tsType: 'number', hasDefault: true }),
        col({ name: 'status', pgType: 'post_status', dialectType: 'post_status', tsType: 'unknown' }),
        col({ name: 'tags', pgType: '_text', dialectType: '_text', tsType: 'string[]', isArray: true }),
        col({
          name: 'labels',
          pgType: '_post_status',
          dialectType: '_post_status',
          tsType: 'unknown[]',
          isArray: true,
        }),
        col({ name: 'embedding', pgType: 'vector', dialectType: 'vector', tsType: 'number[]' }),
      ],
      columnMap: { id: 'id', status: 'status', tags: 'tags', labels: 'labels', embedding: 'embedding' },
      reverseColumnMap: { id: 'id', status: 'status', tags: 'tags', labels: 'labels', embedding: 'embedding' },
      dateColumns: new Set(),
      pgTypes: { id: 'int8', status: 'post_status', tags: '_text', labels: '_post_status', embedding: 'vector' },
      allColumns: ['id', 'status', 'tags', 'labels', 'embedding'],
      primaryKey: ['id'],
      uniqueColumns: [],
      relations: {},
      indexes: [],
    },
  },
};

describe('B2–B4 — codegen for extended column types', () => {
  const out = generateTypes(SCHEMA);

  it('emits the enum string-literal union type', () => {
    assert.match(out, /export type PostStatus = 'draft' \| 'published' \| 'archived';/);
  });

  it('enum column uses the generated union type', () => {
    assert.match(out, /status: PostStatus;/);
  });

  it('array column maps to T[]', () => {
    assert.match(out, /tags: string\[\];/);
  });

  it('enum array column maps to EnumType[]', () => {
    assert.match(out, /labels: PostStatus\[\];/);
  });

  it('vector column maps to number[]', () => {
    assert.match(out, /embedding: number\[\];/);
  });
});
