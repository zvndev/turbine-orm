import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateIndex, generateMetadata, generateTypes } from '../generate.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

function schema(name = 'records'): SchemaMetadata {
  const rows = mockTable(name, [{ name: 'id', field: 'id' }]);
  return { tables: { [name]: rows, empty_rows: mockTable('empty_rows', [], {}, []) }, enums: {} };
}

describe('generated dictionary types beside a Record entity', () => {
  for (const target of ['postgresql', 'sqlite', 'mysql', 'mssql'] as const) {
    it(`${target}: preserves public names and uses unshadowed intrinsic mapped types`, () => {
      const input = schema();
      const before = JSON.stringify(input);
      const options = { target, noTimestamp: true };
      const types = generateTypes(input, options);
      const index = generateIndex(input, options);
      assert.match(types, /export interface Record \{/);
      assert.match(types, /export interface RecordInputs \{/);
      assert.match(index, /readonly records: QueryInterface<Record, \{\}, RecordInputs>/);
      assert.match(types, /export type EmptyRowCreateInput = \{ \[key in string\]: never \};/);
      assert.match(types, /disconnect\?: boolean \| \{ \[key in string\]: never \} \| RecordWhereUnique/);
      assert.match(index, /context: \{ \[key in string\]: string \| number \| boolean \}/);
      assert.doesNotMatch(types + index, /Record<string,/);
      assert.equal(generateTypes(input, options), types);
      assert.equal(generateIndex(input, options), index);
      assert.equal(JSON.stringify(input), before);
      assert.equal(generateMetadata(input, options), generateMetadata(input, { noTimestamp: true }));
    });
  }

  it('uses the same intrinsic dictionary meaning for ordinary entity names', () => {
    const input = schema('documents');
    const types = generateTypes(input, { noTimestamp: true });
    assert.match(types, /export type EmptyRowCreateInput = \{ \[key in string\]: never \};/);
    assert.match(types, /disconnect\?: boolean \| \{ \[key in string\]: never \} \| DocumentWhereUnique/);
    assert.match(
      generateIndex(input, { noTimestamp: true }),
      /context: \{ \[key in string\]: string \| number \| boolean \}/,
    );
  });

  it('also protects a generated enum named Record without renaming it', () => {
    const input = schema('documents');
    input.enums.record = ['keep', 'Record<string, never>'];
    const types = generateTypes(input, { noTimestamp: true });
    assert.match(types, /export type Record = 'keep' \| 'Record<string, never>';/);
    assert.match(types, /export type EmptyRowCreateInput = \{ \[key in string\]: never \};/);
  });

  it('does not rewrite explicit column type declarations or overrides', () => {
    const input = schema();
    const column = input.tables.records!.columns[0]!;
    column.tsType = 'Record';
    column.declaredTsType = 'Record';
    const before = JSON.stringify(input);
    assert.match(generateTypes(input, { noTimestamp: true }), /id: Record;/);
    const types = generateTypes(input, {
      noTimestamp: true,
      columnTypes: { 'records.id': 'Record<string, never>' },
    });
    assert.match(types, /id: Record<string, never>;/);
    assert.match(types, /export type EmptyRowCreateInput = \{ \[key in string\]: never \};/);
    assert.equal(JSON.stringify(input), before);
  });
});
