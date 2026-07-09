/**
 * turbine-orm — WS-H / H3: STORED generated columns
 *
 * `GENERATED ALWAYS AS (expr) STORED` columns (`isGeneratedStored`) are
 * computed by Postgres and can never be written. Codegen omits them from
 * `*Create`/`*Update` input types, and the create/update/upsert builders reject
 * any `data` containing one with a `ValidationError` (E003). Pure — no DB.
 *
 * Run: npx tsx --test src/test/generated-columns.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import { generateTypes } from '../generate.js';
import type { ColumnMetadata, SchemaMetadata, TableMetadata } from '../schema.js';
import { makeQuery } from './helpers.js';

function col(overrides: Partial<ColumnMetadata> & Pick<ColumnMetadata, 'name' | 'field'>): ColumnMetadata {
  return {
    pgType: 'int8',
    tsType: 'number',
    nullable: false,
    hasDefault: false,
    isArray: false,
    pgArrayType: 'bigint[]',
    ...overrides,
  } as ColumnMetadata;
}

const columns: ColumnMetadata[] = [
  col({ name: 'id', field: 'id', hasDefault: true, isGenerated: true }),
  col({ name: 'qty', field: 'qty' }),
  col({ name: 'price', field: 'price' }),
  col({
    name: 'total',
    field: 'total',
    isGeneratedStored: true,
    generationExpression: 'qty * price',
  }),
];

const invoices: TableMetadata = {
  name: 'invoices',
  columns,
  columnMap: { id: 'id', qty: 'qty', price: 'price', total: 'total' },
  reverseColumnMap: { id: 'id', qty: 'qty', price: 'price', total: 'total' },
  dateColumns: new Set(),
  pgTypes: { id: 'int8', qty: 'int8', price: 'int8', total: 'int8' },
  allColumns: ['id', 'qty', 'price', 'total'],
  primaryKey: ['id'],
  uniqueColumns: [['id']],
  relations: {},
  indexes: [],
};

const SCHEMA: SchemaMetadata = { tables: { invoices }, enums: {} };

describe('H3 — codegen omits STORED generated columns', () => {
  const out = generateTypes(SCHEMA);

  it('keeps the generated column in the entity type', () => {
    assert.match(out, /export interface Invoice \{[\s\S]*total: number;[\s\S]*\}/);
  });

  it('omits it from the Create type', () => {
    const block = out.slice(out.indexOf('InvoiceCreate ='), out.indexOf('InvoiceUpdate ='));
    assert.doesNotMatch(block, /total[?]?:/);
    // sanity: writable columns are present
    assert.match(block, /qty:/);
  });

  it('omits it from the Update type', () => {
    const block = out.slice(out.indexOf('InvoiceUpdate ='), out.indexOf('InvoiceUpdate =') + 200);
    assert.doesNotMatch(block, /total[?]?:/);
    assert.match(block, /qty\?:/);
  });
});

describe('H3 — write builders reject STORED generated columns (E003)', () => {
  const qi = makeQuery('invoices', SCHEMA);

  it('create rejects data with a generated column', () => {
    // biome-ignore lint/suspicious/noExplicitAny: exercising a runtime guard
    assert.throws(
      () => qi.buildCreate({ data: { qty: 2, price: 3, total: 6 } as any }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.equal(err.code, 'TURBINE_E003');
        assert.match(err.message, /total/);
        assert.match(err.message, /generated/i);
        return true;
      },
    );
  });

  it('create allows data without generated columns', () => {
    // biome-ignore lint/suspicious/noExplicitAny: build-only
    assert.doesNotThrow(() => qi.buildCreate({ data: { qty: 2, price: 3 } as any }));
  });

  it('update rejects data with a generated column', () => {
    assert.throws(
      // biome-ignore lint/suspicious/noExplicitAny: exercising a runtime guard
      () => qi.buildUpdate({ where: { id: 1 } as any, data: { total: 9 } as any }),
      (err: unknown) => err instanceof ValidationError && err.code === 'TURBINE_E003',
    );
  });

  it('upsert rejects create/update data with a generated column', () => {
    assert.throws(
      () =>
        qi.buildUpsert({
          // biome-ignore lint/suspicious/noExplicitAny: exercising a runtime guard
          where: { id: 1 } as any,
          // biome-ignore lint/suspicious/noExplicitAny: exercising a runtime guard
          create: { qty: 1, price: 1, total: 1 } as any,
          // biome-ignore lint/suspicious/noExplicitAny: exercising a runtime guard
          update: { qty: 1 } as any,
        }),
      (err: unknown) => err instanceof ValidationError && err.code === 'TURBINE_E003',
    );
  });
});
