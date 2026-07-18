/**
 * turbine-orm - CHECK constraint codegen round-trip tests (B3)
 *
 * introspect.ts already reads named CHECK constraints into
 * `TableMetadata.checks`; this verifies `generateMetadata` emits them into
 * metadata.ts (so they survive codegen), sorted by name for `--no-timestamp`
 * determinism, and omits the block entirely for check-less tables (byte-stable).
 *
 * Run: npx tsx --test src/test/generate-checks.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateMetadata } from '../generate.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

function withChecks(table: TableMetadata, checks: { name: string; expression: string }[]): TableMetadata {
  return { ...table, checks };
}

describe('generateMetadata - CHECK constraints', () => {
  it('emits a checks block, sorted by constraint name', () => {
    const products = withChecks(
      mockTable('products', [
        { name: 'id', field: 'id' },
        { name: 'price', field: 'price' },
      ]),
      // Deliberately unsorted to prove deterministic ordering.
      [
        { name: 'positive_stock', expression: 'stock >= 0' },
        { name: 'positive_price', expression: 'price > 0' },
      ],
    );
    const schema: SchemaMetadata = { tables: { products }, enums: {} };
    const out = generateMetadata(schema, { noTimestamp: true });

    assert.match(out, /checks: \[/);
    assert.match(out, /name: 'positive_price', expression: "price > 0"/);
    assert.match(out, /name: 'positive_stock', expression: "stock >= 0"/);
    // Sorted: positive_price appears before positive_stock.
    assert.ok(out.indexOf('positive_price') < out.indexOf('positive_stock'));
  });

  it('re-emits byte-identically across runs (determinism)', () => {
    const table = withChecks(mockTable('t', [{ name: 'id', field: 'id' }]), [
      { name: 'b_check', expression: 'x > 1' },
      { name: 'a_check', expression: 'y < 2' },
    ]);
    const schema: SchemaMetadata = { tables: { t: table }, enums: {} };
    const a = generateMetadata(schema, { noTimestamp: true });
    const b = generateMetadata(schema, { noTimestamp: true });
    assert.equal(a, b);
    assert.ok(a.indexOf('a_check') < a.indexOf('b_check'));
  });

  it('omits the checks block for check-less tables (byte-stable)', () => {
    const schema: SchemaMetadata = {
      tables: { plain: mockTable('plain', [{ name: 'id', field: 'id' }]) },
      enums: {},
    };
    const out = generateMetadata(schema, { noTimestamp: true });
    assert.ok(!/checks: \[/.test(out));
  });
});
