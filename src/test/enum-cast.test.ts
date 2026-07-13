/**
 * turbine-orm — Postgres enum column write casts (T-3)
 *
 * Dogfood bug: inserting into a table with a PG enum column failed with
 * `column "type" is of type "FieldType" but expression is of type text`.
 * Mechanism: createMany's bulk-insert form is `UNNEST($1::text[], ...)` —
 * the generic text[] cast types the value as text, and Postgres refuses the
 * implicit text→enum coercion (plain `VALUES ($1)` lets PG infer, but any
 * form that materializes the param as text defeats inference).
 *
 * Fix: introspected metadata already knows the enum (`pgTypes` holds the
 * udt_name, `schema.enums` maps typname → labels), so every write bind on an
 * enum column now carries an explicit `$N::"EnumName"` cast (quoted). Gated
 * on the postgresql dialect + a matching `schema.enums` entry, so SQLite/
 * MySQL/MSSQL/PowDB and defineSchema-only metadata are untouched.
 *
 * Build-only tests (no DB). Run: npx tsx --test src/test/enum-cast.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Dialect, postgresDialect } from '../dialect.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

function buildSchema(enums: Record<string, string[]> = { FieldType: ['TEXT', 'NUMBER'] }): SchemaMetadata {
  const tables: Record<string, TableMetadata> = {};
  tables.fields = mockTable('fields', [
    { name: 'id', field: 'id' },
    { name: 'title', field: 'title', pgType: 'text' },
    { name: 'type', field: 'type', pgType: 'FieldType' },
  ]);
  return { tables, enums };
}

describe('Postgres enum write casts (T-3)', () => {
  it('create: enum column bind carries ::"FieldType", others unchanged', () => {
    const q = makeQuery('fields', buildSchema());
    const d = q.buildCreate({ data: { title: 'Name', type: 'TEXT' } as never });
    assert.match(d.sql, /"title", "type"\) VALUES \(\$1, \$2::"FieldType"\)/);
    assert.deepEqual(d.params, ['Name', 'TEXT']);
  });

  it('createMany: UNNEST casts the enum column to "FieldType"[] instead of text[]', () => {
    const q = makeQuery('fields', buildSchema());
    const d = q.buildCreateMany({
      data: [
        { title: 'a', type: 'TEXT' },
        { title: 'b', type: 'NUMBER' },
      ] as never,
    });
    assert.match(d.sql, /UNNEST\(/);
    assert.match(d.sql, /::"FieldType"\[\]/);
    assert.deepEqual(d.params, [
      ['a', 'b'],
      ['TEXT', 'NUMBER'],
    ]);
  });

  it('update: SET bind on the enum column carries the cast', () => {
    const q = makeQuery('fields', buildSchema());
    const d = q.buildUpdate({ where: { id: 1 } as never, data: { type: 'NUMBER' } as never });
    assert.match(d.sql, /SET "type" = \$1::"FieldType"/);
    assert.deepEqual(d.params, ['NUMBER', 1]);
  });

  it('update: atomic { set } operator on the enum column carries the cast', () => {
    const q = makeQuery('fields', buildSchema());
    const d = q.buildUpdate({ where: { id: 1 } as never, data: { type: { set: 'NUMBER' } } as never });
    assert.match(d.sql, /SET "type" = \$1::"FieldType"/);
    assert.deepEqual(d.params, ['NUMBER', 1]);
  });

  it('updateMany: SET bind on the enum column carries the cast', () => {
    const q = makeQuery('fields', buildSchema());
    const d = q.buildUpdateMany({ where: { title: 'a' } as never, data: { type: 'TEXT' } as never });
    assert.match(d.sql, /SET "type" = \$1::"FieldType"/);
    assert.deepEqual(d.params, ['TEXT', 'a']);
  });

  it('upsert: both the INSERT placeholders and the conflict-UPDATE SET carry the cast', () => {
    const q = makeQuery('fields', buildSchema());
    const d = q.buildUpsert({
      where: { id: 1 } as never,
      create: { id: 1, title: 'a', type: 'TEXT' } as never,
      update: { type: 'NUMBER' } as never,
    });
    assert.match(d.sql, /VALUES \(\$1, \$2, \$3::"FieldType"\)/);
    assert.match(d.sql, /DO UPDATE SET "type" = \$4::"FieldType"/);
    assert.deepEqual(d.params, [1, 'a', 'TEXT', 'NUMBER']);
  });

  it('non-enum columns never get a cast', () => {
    const q = makeQuery('fields', buildSchema());
    const d = q.buildUpdate({ where: { id: 1 } as never, data: { title: 'x' } as never });
    assert.match(d.sql, /SET "title" = \$1 WHERE/);
  });

  it('schema without enums metadata is byte-identical (defineSchema / mock path)', () => {
    const q = makeQuery('fields', buildSchema({}));
    const d = q.buildCreate({ data: { title: 'Name', type: 'TEXT' } as never });
    assert.match(d.sql, /VALUES \(\$1, \$2\)/);
    assert.doesNotMatch(d.sql, /::"FieldType"/);
  });

  it('missing enums map entirely is handled defensively', () => {
    const schema = buildSchema();
    (schema as { enums?: unknown }).enums = undefined;
    const q = makeQuery('fields', schema);
    const d = q.buildCreate({ data: { type: 'TEXT' } as never });
    assert.doesNotMatch(d.sql, /::"FieldType"/);
  });

  it('non-postgresql dialects never emit the cast even with enums metadata', () => {
    // Same SQL surface as Postgres but a different dialect name — the gate is
    // the name, so no enum cast may appear.
    const fakeDialect = { ...postgresDialect, name: 'sqlite' } as unknown as Dialect;
    const q = makeQuery('fields', buildSchema(), { dialect: fakeDialect });
    const d = q.buildCreate({ data: { title: 'Name', type: 'TEXT' } as never });
    assert.doesNotMatch(d.sql, /::"FieldType"/);
  });

  it('enum type names with quotes are safely quoted (quoteIdent doubling)', () => {
    const tables: Record<string, TableMetadata> = {};
    tables.fields = mockTable('fields', [
      { name: 'id', field: 'id' },
      { name: 'type', field: 'type', pgType: 'weird"enum' },
    ]);
    const q = makeQuery('fields', { tables, enums: { 'weird"enum': ['a'] } });
    const d = q.buildCreate({ data: { type: 'a' } as never });
    assert.match(d.sql, /\$1::"weird""enum"/);
  });
});

// ---------------------------------------------------------------------------
// N-5 — cross-schema enum false positive
//
// A column typed `other_schema.status` shares its NAME with an enum
// introspected from the target schema. Introspection records
// `pgTypeSchema: 'other_schema'` on such columns (and ONLY such columns);
// the builder must then SKIP the cast — `::"status"` would resolve through
// search_path to the WRONG type and break writes that worked before casts
// existed. Same-schema / defineSchema / legacy metadata (no pgTypeSchema)
// keep the cast.
// ---------------------------------------------------------------------------

describe('Postgres enum write casts — cross-schema guard (N-5)', () => {
  function crossSchemaSchema(): SchemaMetadata {
    const tables: Record<string, TableMetadata> = {};
    tables.fields = mockTable('fields', [
      { name: 'id', field: 'id' },
      { name: 'title', field: 'title', pgType: 'text' },
      { name: 'status', field: 'status', pgType: 'status' },
    ]);
    // Mark the column's type as living in ANOTHER schema — exactly what
    // introspection records for `other_schema.status`.
    const statusCol = tables.fields.columns.find((c) => c.name === 'status')!;
    statusCol.pgTypeSchema = 'other_schema';
    // The introspected (local) schema ALSO has an enum named `status`.
    return { tables, enums: { status: ['open', 'closed'] } };
  }

  it('create: NO cast when the column type lives in another schema (false-positive shape)', () => {
    const q = makeQuery('fields', crossSchemaSchema());
    const d = q.buildCreate({ data: { title: 'a', status: 'open' } as never });
    assert.match(d.sql, /VALUES \(\$1, \$2\)/);
    assert.doesNotMatch(d.sql, /::"status"/);
  });

  it('createMany: UNNEST stays text[] for the cross-schema column', () => {
    const q = makeQuery('fields', crossSchemaSchema());
    const d = q.buildCreateMany({ data: [{ status: 'open' }, { status: 'closed' }] as never });
    assert.doesNotMatch(d.sql, /::"status"\[\]/);
  });

  it('update: NO cast on the SET bind for the cross-schema column', () => {
    const q = makeQuery('fields', crossSchemaSchema());
    const d = q.buildUpdate({ where: { id: 1 } as never, data: { status: 'closed' } as never });
    assert.match(d.sql, /SET "status" = \$1 WHERE/);
    assert.doesNotMatch(d.sql, /::"status"/);
  });

  it('true positive: absent pgTypeSchema (same schema / legacy metadata) keeps the cast', () => {
    const tables: Record<string, TableMetadata> = {};
    tables.fields = mockTable('fields', [
      { name: 'id', field: 'id' },
      { name: 'status', field: 'status', pgType: 'status' },
    ]);
    const q = makeQuery('fields', { tables, enums: { status: ['open', 'closed'] } });
    const d = q.buildCreate({ data: { status: 'open' } as never });
    assert.match(d.sql, /\$1::"status"/);
  });

  it('generateMetadata serializes pgTypeSchema so the guard survives codegen', async () => {
    const { generateMetadata } = await import('../generate.js');
    const schema = crossSchemaSchema();
    const out = generateMetadata(schema, { noTimestamp: true });
    assert.match(out, /pgTypeSchema: 'other_schema'/);
    // Columns without the marker stay untouched (no `pgTypeSchema: undefined`).
    assert.equal(out.match(/pgTypeSchema/g)?.length, 1);
  });
});
