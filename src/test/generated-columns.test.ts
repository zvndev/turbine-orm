/**
 * turbine-orm, WS-H / H3: STORED generated columns
 *
 * `GENERATED ALWAYS AS (expr) STORED` columns (`isGeneratedStored`) are
 * computed by Postgres and can never be written. Codegen omits them from
 * `*Create`/`*Update` input types, and the create/update/upsert builders reject
 * any `data` containing one with a `ValidationError` (E003). Pure, no DB.
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

describe('H3, codegen omits STORED generated columns', () => {
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

describe('H3, write builders reject STORED generated columns (E003)', () => {
  const qi = makeQuery('invoices', SCHEMA);

  it('create rejects data with a generated column', () => {
    assert.throws(
      () => qi.buildCreate({ data: { qty: 2, price: 3, total: 6 } as never }),
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
    assert.doesNotThrow(() => qi.buildCreate({ data: { qty: 2, price: 3 } as never }));
  });

  it('update rejects data with a generated column', () => {
    assert.throws(
      () => qi.buildUpdate({ where: { id: 1 } as never, data: { total: 9 } as never }),
      (err: unknown) => err instanceof ValidationError && err.code === 'TURBINE_E003',
    );
  });

  it('upsert rejects create/update data with a generated column', () => {
    assert.throws(
      () =>
        qi.buildUpsert({
          where: { id: 1 } as never,
          create: { qty: 1, price: 1, total: 1 } as never,
          update: { qty: 1 } as never,
        }),
      (err: unknown) => err instanceof ValidationError && err.code === 'TURBINE_E003',
    );
  });
});

describe('H3, the generated-column check on every write path (0.90.2)', () => {
  // A table whose field and column names differ, so a key can name the
  // generated column either way.
  const lineColumns: ColumnMetadata[] = [
    col({ name: 'id', field: 'id', hasDefault: true, isGenerated: true }),
    col({ name: 'unit_price', field: 'unitPrice' }),
    col({ name: 'qty', field: 'qty' }),
    col({ name: 'line_total', field: 'lineTotal', isGeneratedStored: true, generationExpression: 'qty * unit_price' }),
    // `totalX` maps to a column whose name is NOT camelToSnake('totalX'), and a
    // generated column has that snake spelling. The key names the first one.
    col({ name: 'total_x_raw', field: 'totalX' }),
    col({ name: 'total_x', field: 'totalXGen', isGeneratedStored: true, generationExpression: 'qty' }),
  ];
  const lines: TableMetadata = {
    name: 'lines',
    columns: lineColumns,
    columnMap: Object.fromEntries(lineColumns.map((c) => [c.field, c.name])),
    reverseColumnMap: Object.fromEntries(lineColumns.map((c) => [c.name, c.field])),
    dateColumns: new Set(),
    pgTypes: Object.fromEntries(lineColumns.map((c) => [c.name, c.pgType])),
    allColumns: lineColumns.map((c) => c.name),
    primaryKey: ['id'],
    uniqueColumns: [['id']],
    relations: {},
    indexes: [],
  };
  const LINES: SchemaMetadata = { tables: { lines }, enums: {} };
  const isGeneratedRefusal = (err: unknown): boolean =>
    err instanceof ValidationError && err.code === 'TURBINE_E003' && /GENERATED ALWAYS/.test(err.message);

  it('refuses the generated column by field name and by column name', () => {
    const q = makeQuery('lines', LINES);
    assert.throws(() => q.buildCreate({ data: { qty: 1, unitPrice: 2, lineTotal: 2 } as never }), isGeneratedRefusal);
    assert.throws(() => q.buildCreate({ data: { qty: 1, unitPrice: 2, line_total: 2 } as never }), isGeneratedRefusal);
  });

  it('decides by the column the key resolves to, as the write itself does', () => {
    const q = makeQuery('lines', LINES);
    // `totalX` writes `total_x_raw`, an ordinary column, even though its snake
    // spelling is the generated `total_x`.
    const { sql } = q.buildCreate({ data: { qty: 1, unitPrice: 2, totalX: 5 } as never });
    assert.match(sql, /"total_x_raw"/);
    assert.throws(() => q.buildCreate({ data: { qty: 1, totalXGen: 5 } as never }), isGeneratedRefusal);
  });

  it('createMany refuses it in any row, before the row-shape check', () => {
    const q = makeQuery('lines', LINES);
    const rows = [{ qty: 1 }, { qty: 2 }, { qty: 3, lineTotal: 9 }, { qty: 4 }];
    assert.throws(() => q.buildCreateMany({ data: rows as never }), isGeneratedRefusal);
    assert.throws(
      () => q.buildCreateMany({ data: rows.map((r) => ({ ...r, lineTotal: 1 })) as never }),
      isGeneratedRefusal,
    );
    // An `undefined` value is omitted, as everywhere else.
    assert.doesNotThrow(() => q.buildCreateMany({ data: [{ qty: 1, lineTotal: undefined }] as never }));
  });

  it('updateMany and onConflict.update refuse it', () => {
    const q = makeQuery('lines', LINES);
    assert.throws(() => q.buildUpdateMany({ where: { qty: 1 }, data: { lineTotal: 1 } } as never), isGeneratedRefusal);
    assert.throws(
      () =>
        q.buildCreateMany({
          data: [{ id: 1, qty: 1 }],
          onConflict: { target: ['id'], update: { lineTotal: 3 } },
        } as never),
      isGeneratedRefusal,
    );
  });

  it('createMany reads the column list a fixed number of times, whatever the row count', () => {
    // The check used to search the column list for every field of every row
    // (most of a 150-row upsert's build time). Counted through a proxy, so a
    // per-row scan coming back fails here rather than in a benchmark.
    function scans(rowCount: number): number {
      let reads = 0;
      const counted = new Proxy(lineColumns, {
        get(target, key, receiver) {
          if (key === Symbol.iterator || key === 'find' || key === 'filter' || key === 'some' || key === 'map') reads++;
          return Reflect.get(target, key, receiver);
        },
      });
      const q = makeQuery('lines', { tables: { lines: { ...lines, columns: counted } }, enums: {} });
      const data = Array.from({ length: rowCount }, (_, i) => ({ qty: i, unitPrice: i * 2 }));
      q.buildCreateMany({ data } as never);
      return reads;
    }
    const few = scans(2);
    assert.ok(few > 0, 'the proxy must see the column list being read, or this proves nothing');
    assert.equal(scans(500), few);
  });
});
