import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateTypes } from '../generate.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

function schema(name = 'dates'): SchemaMetadata {
  const columns = [
    { name: 'id', field: 'id' },
    { name: 'clock', field: 'clock', pgType: 'time', tsType: 'string', declaredTsType: 'string' },
    {
      name: 'clocks',
      field: 'clocks',
      pgType: '_timetz',
      tsType: 'string[] | null',
      declaredTsType: 'string[]',
      nullable: true,
      isArray: true,
    },
    { name: 'at', field: 'at', pgType: 'timestamp', tsType: 'Date', declaredTsType: 'Date' },
  ];
  const clocks = mockTable('clocks', columns);
  for (const [index, column] of columns.entries()) Object.assign(clocks.columns[index]!, column);
  clocks.dateColumns.add('at');
  return { tables: { [name]: mockTable(name, [{ name: 'id', field: 'id' }]), clocks }, enums: {} };
}

describe('declared time writes preserve intrinsic Date members', () => {
  for (const target of ['postgresql', 'sqlite', 'mysql', 'mssql'] as const) {
    it(`${target}: preserves declarations and qualifies only template-owned Date`, () => {
      const input = schema();
      const types = generateTypes(input, { target, noTimestamp: true });
      assert.match(types, /clock: string \| globalThis.Date;/);
      assert.match(types, /clocks\?: \(string \| globalThis.Date\)\[\] \| null \| undefined;/);
      assert.match(types, /at: Date;/);
      assert.doesNotMatch(types, /at: globalThis.Date;/);
      assert.equal(input.tables.clocks!.columns[1]!.declaredTsType, 'string');
    });
  }

  it('preserves explicit override precedence over the time-write template', () => {
    const types = generateTypes(schema(), {
      noTimestamp: true,
      columnTypes: { 'clocks.clock': 'Date', 'clocks.clocks': 'Date[]' },
    });
    assert.match(types, /clock: Date;/);
    assert.match(types, /clocks\?: Date\[\] \| null \| undefined;/);
    assert.doesNotMatch(types, /globalThis.Date/);
  });

  it('qualifies time templates independently of an emitted Date name', () => {
    const input = schema('documents');
    const ordinary = generateTypes(input, { noTimestamp: true });
    assert.match(ordinary, /clock: string \| globalThis\.Date;/);
    assert.match(ordinary, /at: Date;/);
    input.enums.date = ['today', 'tomorrow'];
    assert.match(generateTypes(input, { noTimestamp: true }), /clock: string \| globalThis.Date;/);
  });
});
