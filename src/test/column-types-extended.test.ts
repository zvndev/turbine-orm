/**
 * turbine-orm — Extended column types (WS-B / B2–B5)
 *
 * Code-first enums, array columns, pgvector columns, and CHECK constraints:
 * DDL emission, schema-level enum declarations, and the vector extension
 * handling. Pure unit tests — no database required.
 *
 * Run: npx tsx --test src/test/column-types-extended.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UnsupportedFeatureError } from '../errors.js';
import { defineSchema } from '../schema-builder.js';
import { schemaToSQL, schemaToSQLString } from '../schema-sql.js';

// ---------------------------------------------------------------------------
// B2 — enums code-first
// ---------------------------------------------------------------------------

describe('B2 — enum column types + schema-level enum declarations', () => {
  const schema = defineSchema(
    {
      posts: {
        id: { type: 'serial', primaryKey: true },
        status: { type: 'enum', enumName: 'post_status', notNull: true, default: "'draft'" },
      },
    },
    { enums: { post_status: ['draft', 'published', 'archived'] } },
  );

  it('emits CREATE TYPE ... AS ENUM before the tables that use it', () => {
    const statements = schemaToSQL(schema);
    const createType = statements.find((s) => s.includes('CREATE TYPE'));
    const createTable = statements.findIndex((s) => s.includes('CREATE TABLE "posts"'));
    const createTypeIdx = statements.findIndex((s) => s.includes('CREATE TYPE'));
    assert.ok(createType, 'should emit CREATE TYPE');
    assert.ok(createType.includes(`CREATE TYPE "post_status" AS ENUM ('draft', 'published', 'archived')`), createType);
    assert.ok(createTypeIdx < createTable, 'CREATE TYPE must come before CREATE TABLE');
  });

  it('enum column DDL uses the quoted enum type name', () => {
    const create = schemaToSQL(schema).find((s) => s.includes('CREATE TABLE "posts"'))!;
    assert.ok(create.includes(`"status" "post_status" NOT NULL DEFAULT 'draft'`), create);
  });

  it('escapes single quotes in enum labels', () => {
    const s = defineSchema(
      { t: { id: { type: 'serial', primaryKey: true }, m: { type: 'enum', enumName: 'mood' } } },
      { enums: { mood: ["o'brien", 'ok'] } },
    );
    const createType = schemaToSQL(s).find((x) => x.includes('CREATE TYPE'))!;
    assert.ok(createType.includes(`'o''brien'`), createType);
  });
});

// ---------------------------------------------------------------------------
// B3 — array columns
// ---------------------------------------------------------------------------

describe('B3 — array columns', () => {
  it('array: true emits type[] DDL', () => {
    const schema = defineSchema({
      posts: {
        id: { type: 'serial', primaryKey: true },
        tags: { type: 'text', array: true, notNull: true },
      },
    });
    const create = schemaToSQL(schema).find((s) => s.includes('CREATE TABLE "posts"'))!;
    assert.ok(create.includes('"tags" TEXT[] NOT NULL'), create);
  });

  it('array works with varchar length', () => {
    const schema = defineSchema({
      t: { id: { type: 'serial', primaryKey: true }, codes: { type: 'varchar', maxLength: 8, array: true } },
    });
    const create = schemaToSQL(schema).find((s) => s.includes('CREATE TABLE "t"'))!;
    assert.ok(create.includes('"codes" VARCHAR(8)[]'), create);
  });
});

// ---------------------------------------------------------------------------
// B4 — vector columns
// ---------------------------------------------------------------------------

describe('B4 — vector columns', () => {
  it('vector column emits vector(n) DDL', () => {
    const schema = defineSchema({
      docs: {
        id: { type: 'serial', primaryKey: true },
        embedding: { type: 'vector', dimensions: 1536, notNull: true },
      },
    });
    const create = schemaToSQL(schema).find((s) => s.includes('CREATE TABLE "docs"'))!;
    assert.ok(create.includes('"embedding" vector(1536) NOT NULL'), create);
  });

  it('prepends CREATE EXTENSION IF NOT EXISTS vector by default (auto)', () => {
    const schema = defineSchema({
      docs: { id: { type: 'serial', primaryKey: true }, embedding: { type: 'vector', dimensions: 3 } },
    });
    const statements = schemaToSQL(schema);
    assert.equal(statements[0], 'CREATE EXTENSION IF NOT EXISTS vector;');
  });

  it('extensions: manual emits a comment instead of the CREATE EXTENSION', () => {
    const schema = defineSchema({
      docs: { id: { type: 'serial', primaryKey: true }, embedding: { type: 'vector', dimensions: 3 } },
    });
    const statements = schemaToSQL(schema, { extensions: 'manual' });
    assert.ok(statements[0]!.startsWith('-- Requires the pgvector extension'), statements[0] ?? '(empty)');
    assert.ok(!statements.some((s) => s.startsWith('CREATE EXTENSION')), 'no CREATE EXTENSION in manual mode');
  });

  it('no vector columns → no extension line', () => {
    const schema = defineSchema({ t: { id: { type: 'serial', primaryKey: true } } });
    const statements = schemaToSQL(schema);
    assert.ok(!statements.some((s) => s.includes('EXTENSION')), 'no extension line without vector columns');
  });

  it('throws UnsupportedFeatureError on a dialect without vector support', () => {
    const schema = defineSchema({
      docs: { id: { type: 'serial', primaryKey: true }, embedding: { type: 'vector', dimensions: 3 } },
    });
    const fakeDialect = { supportsVector: false, name: 'sqlite' } as never;
    assert.throws(() => schemaToSQL(schema, { dialect: fakeDialect }), UnsupportedFeatureError);
  });
});

// ---------------------------------------------------------------------------
// B5 — check constraints
// ---------------------------------------------------------------------------

describe('B5 — check constraints', () => {
  it('column-level check emits inline CHECK (expr)', () => {
    const schema = defineSchema({
      products: {
        id: { type: 'serial', primaryKey: true },
        price: { type: 'integer', notNull: true, check: 'price >= 0' },
      },
    });
    const create = schemaToSQL(schema).find((s) => s.includes('CREATE TABLE "products"'))!;
    assert.ok(create.includes('CHECK (price >= 0)'), create);
  });

  it('table-level named checks emit CONSTRAINT "name" CHECK (expr)', () => {
    const schema = defineSchema({
      products: {
        id: { type: 'serial', primaryKey: true },
        price: { type: 'integer', notNull: true },
        cost: { type: 'integer', notNull: true },
        checks: [{ name: 'price_gt_cost', expression: 'price > cost' }],
      },
    });
    const create = schemaToSQL(schema).find((s) => s.includes('CREATE TABLE "products"'))!;
    assert.ok(create.includes('CONSTRAINT "price_gt_cost" CHECK (price > cost)'), create);
  });

  it('table-level unnamed check emits a bare CHECK (expr)', () => {
    const schema = defineSchema({
      products: {
        id: { type: 'serial', primaryKey: true },
        qty: { type: 'integer', notNull: true },
        checks: [{ expression: 'qty <> 0' }],
      },
    });
    const create = schemaToSQL(schema).find((s) => s.includes('CREATE TABLE "products"'))!;
    assert.ok(create.includes('CHECK (qty <> 0)'), create);
    assert.ok(!create.includes('CONSTRAINT'), 'unnamed check has no CONSTRAINT keyword');
  });

  it('schemaToSQLString round-trips all constraint kinds', () => {
    const schema = defineSchema({
      products: {
        id: { type: 'serial', primaryKey: true },
        price: { type: 'integer', notNull: true, check: 'price >= 0' },
        checks: [{ name: 'nonzero', expression: 'price <> 100' }],
      },
    });
    const sql = schemaToSQLString(schema);
    assert.ok(sql.includes('CHECK (price >= 0)'));
    assert.ok(sql.includes('CONSTRAINT "nonzero" CHECK (price <> 100)'));
  });
});
