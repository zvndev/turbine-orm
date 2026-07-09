/**
 * turbine-orm — WS-H / H1: `turbine generate --zod`
 *
 * `generateZod()` emits a `zod.ts` file (importing the user-side `zod` dep;
 * never imported by library runtime code) with per-table `XSchema`,
 * `XCreateSchema`, and `XUpdateSchema` derived from column metadata. Pure string
 * assertions — no zod install needed to verify the generated source.
 *
 * Run: npx tsx --test src/test/generate-zod.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateZod } from '../generate.js';
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
        col({ name: 'id', pgType: 'int8', dialectType: 'int8', tsType: 'number', hasDefault: true, isGenerated: true }),
        col({ name: 'title', pgType: 'text', tsType: 'string' }),
        col({ name: 'views', pgType: 'int4', dialectType: 'int4', tsType: 'number', hasDefault: true }),
        col({ name: 'published', pgType: 'bool', dialectType: 'bool', tsType: 'boolean' }),
        col({ name: 'bio', pgType: 'text', tsType: 'string', nullable: true }),
        col({
          name: 'created_at',
          field: 'createdAt',
          pgType: 'timestamptz',
          dialectType: 'timestamptz',
          tsType: 'Date',
          hasDefault: true,
        }),
        col({ name: 'metadata', pgType: 'jsonb', dialectType: 'jsonb', tsType: 'unknown', nullable: true }),
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
        // GENERATED ALWAYS AS (...) STORED — omitted from Create/Update.
        col({
          name: 'search',
          pgType: 'tsvector',
          dialectType: 'tsvector',
          tsType: 'string',
          isGeneratedStored: true,
          generationExpression: "to_tsvector('english', title)",
        }),
      ],
      columnMap: {
        id: 'id',
        title: 'title',
        views: 'views',
        published: 'published',
        bio: 'bio',
        createdAt: 'created_at',
        metadata: 'metadata',
        status: 'status',
        tags: 'tags',
        labels: 'labels',
        embedding: 'embedding',
        search: 'search',
      },
      reverseColumnMap: {},
      dateColumns: new Set(['created_at']),
      pgTypes: {},
      allColumns: [],
      primaryKey: ['id'],
      uniqueColumns: [],
      relations: {},
      indexes: [],
    },
  },
};

describe('H1 — generateZod()', () => {
  const out = generateZod(SCHEMA);

  it('imports zod (user-side dep)', () => {
    assert.match(out, /import \{ z \} from 'zod';/);
  });

  it('emits the three schemas per table', () => {
    assert.match(out, /export const PostSchema = z\.object\(\{/);
    assert.match(out, /export const PostCreateSchema = z\.object\(\{/);
    assert.match(out, /export const PostUpdateSchema = z\.object\(\{/);
  });

  it('maps scalar types', () => {
    assert.match(out, /title: z\.string\(\)/);
    assert.match(out, /views: z\.number\(\)/);
    assert.match(out, /published: z\.boolean\(\)/);
  });

  it('maps dates to z.coerce.date()', () => {
    assert.match(out, /createdAt: z\.coerce\.date\(\)/);
  });

  it('maps json to z.unknown()', () => {
    assert.match(out, /metadata: z\.unknown\(\)\.nullable\(\)/);
  });

  it('maps enums to z.enum([...])', () => {
    assert.match(out, /status: z\.enum\(\['draft', 'published', 'archived'\]\)/);
  });

  it('maps arrays with .array()', () => {
    assert.match(out, /tags: z\.string\(\)\.array\(\)/);
    assert.match(out, /labels: z\.enum\(\['draft', 'published', 'archived'\]\)\.array\(\)/);
  });

  it('maps vector to z.array(z.number())', () => {
    assert.match(out, /embedding: z\.array\(z\.number\(\)\)/);
  });

  it('marks nullable columns .nullable()', () => {
    assert.match(out, /bio: z\.string\(\)\.nullable\(\)/);
  });

  it('Create schema makes PK/defaulted/nullable optional', () => {
    const createBlock = out.slice(out.indexOf('PostCreateSchema'), out.indexOf('PostUpdateSchema'));
    // required column has no .optional()
    assert.match(createBlock, /title: z\.string\(\),/);
    // defaulted column optional
    assert.match(createBlock, /views: z\.number\(\)\.optional\(\)/);
    // nullable column optional
    assert.match(createBlock, /bio: z\.string\(\)\.nullable\(\)\.optional\(\)/);
  });

  it('omits STORED generated columns from Create and Update', () => {
    const createBlock = out.slice(out.indexOf('PostCreateSchema'), out.indexOf('PostUpdateSchema'));
    const updateBlock = out.slice(out.indexOf('PostUpdateSchema'));
    assert.doesNotMatch(createBlock, /search:/);
    assert.doesNotMatch(updateBlock, /search:/);
  });

  it('Create keeps the PK optional; Update omits the PK', () => {
    const createBlock = out.slice(out.indexOf('PostCreateSchema'), out.indexOf('PostUpdateSchema'));
    const updateBlock = out.slice(out.indexOf('PostUpdateSchema'));
    assert.match(createBlock, /id: z\.number\(\)\.optional\(\)/);
    assert.doesNotMatch(updateBlock, /\bid: z\./);
  });

  it('Update makes every non-PK column optional', () => {
    const updateBlock = out.slice(out.indexOf('PostUpdateSchema'));
    assert.match(updateBlock, /title: z\.string\(\)\.optional\(\)/);
    assert.match(updateBlock, /published: z\.boolean\(\)\.optional\(\)/);
  });
});
