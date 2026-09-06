/**
 * turbine-orm, `*Create` optionality of primary-key columns
 *
 * A primary key is not the same thing as a server-assigned value. `serial`,
 * `bigserial` and IDENTITY columns are assigned by the database and may be
 * omitted on create; a `text` natural key, a client-supplied uuid with no
 * default, or a composite key of two plain integers must be supplied, and the
 * database rejects the row otherwise (E010). The generator used to mark EVERY
 * PK column optional with the reason `auto-generated`, so `create({ data: {} })`
 * on a junction table typechecked and failed at runtime.
 *
 * The rule, applied to the `*Create` type and the Zod create schema alike: a
 * column is optional when it is nullable, has a default, or is server-generated
 * (`isGenerated`). Being part of the primary key adds nothing. `*Update` keeps
 * omitting PK columns entirely, as before.
 *
 * Run: npx tsx --test src/test/generate-pk-optionality.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateTypes, generateZod } from '../generate.js';
import type { ColumnMetadata, SchemaMetadata, TableMetadata } from '../schema.js';

function col(name: string, pgType: string, tsType: string, opts?: Partial<ColumnMetadata>): ColumnMetadata {
  return {
    name,
    field: name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
    pgType,
    tsType,
    nullable: false,
    hasDefault: false,
    isArray: false,
    pgArrayType: `${pgType}[]`,
    ...opts,
  };
}

function table(name: string, columns: ColumnMetadata[], primaryKey: string[]): TableMetadata {
  const columnMap: Record<string, string> = {};
  const reverseColumnMap: Record<string, string> = {};
  const pgTypes: Record<string, string> = {};
  for (const c of columns) {
    columnMap[c.field] = c.name;
    reverseColumnMap[c.name] = c.field;
    pgTypes[c.name] = c.pgType;
  }
  return {
    name,
    columns,
    columnMap,
    reverseColumnMap,
    dateColumns: new Set<string>(),
    pgTypes,
    allColumns: columns.map((c) => c.name),
    primaryKey,
    uniqueColumns: [],
    indexes: [],
    isView: false,
    relations: {},
  };
}

const SCHEMA: SchemaMetadata = {
  enums: {},
  tables: {
    // serial PK: nextval() default AND server-generated.
    users: table(
      'users',
      [col('id', 'int4', 'number', { hasDefault: true, isGenerated: true }), col('email', 'text', 'string')],
      ['id'],
    ),
    // IDENTITY PK: server-generated, information_schema reports no default.
    events: table(
      'events',
      [col('id', 'int8', 'number', { isGenerated: true }), col('kind', 'text', 'string')],
      ['id'],
    ),
    // uuid PK with a client-side default expression (gen_random_uuid()): has a
    // default but is NOT server-generated in the serial/identity sense.
    posts: table('posts', [col('id', 'uuid', 'string', { hasDefault: true }), col('title', 'text', 'string')], ['id']),
    // Natural text key with no default: the caller must supply it.
    tags: table(
      'tags',
      [
        col('slug', 'text', 'string'),
        col('label', 'text', 'string'),
        col('note', 'text', 'string | null', { nullable: true }),
      ],
      ['slug'],
    ),
    // Pure junction: composite PK of two plain integers, no defaults.
    post_tags: table(
      'post_tags',
      [col('post_id', 'int4', 'number'), col('tag_id', 'int4', 'number')],
      ['post_id', 'tag_id'],
    ),
  },
};

/** Extract one emitted `export type X = { ... };` block (a pure junction's Update block is empty). */
function typeBlock(source: string, name: string): string {
  const match = source.match(new RegExp(`export type ${name} = \\{\\n?([\\s\\S]*?)\\n?\\};`));
  assert.ok(match, `expected an emitted ${name} block in:\n${source}`);
  return match[1]!;
}

/** Extract one emitted `export const XSchema = z.object({ ... });` block. */
function zodBlock(source: string, name: string): string {
  const match = source.match(new RegExp(`export const ${name} = z\\.object\\(\\{\\n([\\s\\S]*?)\\n\\}\\);`));
  assert.ok(match, `expected an emitted ${name} block in:\n${source}`);
  return match[1]!;
}

describe('generateTypes: *Create optionality follows defaults and generation, not PK membership', () => {
  const types = generateTypes(SCHEMA, { noTimestamp: true });

  it('a text PK with no default is required', () => {
    const block = typeBlock(types, 'TagCreate');
    assert.match(block, /^ {2}slug: string;$/m);
    assert.doesNotMatch(block, /slug\?:/);
    assert.doesNotMatch(block, /auto-generated/, 'a natural key is never described as auto-generated');
  });

  it('a serial PK stays optional as auto-generated', () => {
    const block = typeBlock(types, 'UserCreate');
    assert.match(block, /\/\*\* Optional: auto-generated \*\/\n {2}id\?: number;/);
  });

  it('an IDENTITY PK (generated, no reported default) stays optional as auto-generated', () => {
    const block = typeBlock(types, 'EventCreate');
    assert.match(block, /\/\*\* Optional: auto-generated \*\/\n {2}id\?: number;/);
  });

  it('a PK with a default expression is optional with the reason "has default"', () => {
    const block = typeBlock(types, 'PostCreate');
    assert.match(block, /\/\*\* Optional: has default \*\/\n {2}id\?: string;/);
  });

  it('a composite PK of two plain integers is required on both columns', () => {
    const block = typeBlock(types, 'PostTagCreate');
    assert.match(block, /^ {2}postId: number;$/m);
    assert.match(block, /^ {2}tagId: number;$/m);
    assert.doesNotMatch(block, /\?:/, 'nothing on a pure junction is optional');
  });

  it('nullable and defaulted non-PK columns are unchanged', () => {
    const block = typeBlock(types, 'TagCreate');
    assert.match(block, /\/\*\* Optional: nullable \*\/\n {2}note\?: string \| null;/);
    assert.match(block, /^ {2}label: string;$/m);
  });

  it('*Update still omits PK columns regardless of their optionality', () => {
    assert.doesNotMatch(typeBlock(types, 'TagUpdate'), /slug/);
    assert.doesNotMatch(typeBlock(types, 'PostTagUpdate'), /postId|tagId/);
  });
});

describe('generateZod: the create schema mirrors the same rule', () => {
  const zod = generateZod(SCHEMA, { noTimestamp: true });

  it('a text PK with no default has no .optional()', () => {
    const block = zodBlock(zod, 'TagCreateSchema');
    assert.match(block, /^ {2}slug: z\.string\(\),$/m);
  });

  it('a serial PK keeps .optional()', () => {
    assert.match(zodBlock(zod, 'UserCreateSchema'), /^ {2}id: z\.number\(\)\.optional\(\),$/m);
  });

  it('a composite PK of two plain integers has no .optional() on either column', () => {
    const block = zodBlock(zod, 'PostTagCreateSchema');
    assert.match(block, /^ {2}postId: z\.number\(\),$/m);
    assert.match(block, /^ {2}tagId: z\.number\(\),$/m);
  });
});
