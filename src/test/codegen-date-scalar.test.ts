import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateIndex, generateMetadata, generateTypes } from '../generate.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

function schema(name = 'dates'): SchemaMetadata {
  const dates = mockTable(name, [{ name: 'id', field: 'id' }]);
  const columns = [
    { name: 'id', field: 'id' },
    { name: 'at', field: 'at', pgType: 'timestamp', tsType: 'Date' },
    { name: 'maybe', field: 'maybe', pgType: 'timestamptz', tsType: 'Date | null', nullable: true },
    { name: 'days', field: 'days', pgType: '_date', tsType: 'Date[] | null', isArray: true, nullable: true },
    { name: 'clock', field: 'clock', pgType: 'time', tsType: 'string' },
    { name: 'clocks', field: 'clocks', pgType: '_timetz', tsType: 'string[] | null', isArray: true, nullable: true },
  ];
  const events = mockTable('events', columns);
  for (const [i, col] of columns.entries()) Object.assign(events.columns[i]!, col);
  events.dateColumns = new Set(['at', 'maybe', 'days']);
  return { tables: { [name]: dates, events }, enums: {} };
}

describe('generated intrinsic temporal types beside public Date names', () => {
  for (const target of ['postgresql', 'sqlite', 'mysql', 'mssql'] as const) {
    it(`${target}: qualifies inferred scalar, nullable, array and time write types`, () => {
      const input = schema();
      const before = JSON.stringify(input);
      const options = { target, noTimestamp: true };
      const types = generateTypes(input, options);
      assert.match(types, /export interface Date \{/);
      assert.match(generateIndex(input, options), /readonly dates: QueryInterface<Date,/);
      assert.match(types, /at: globalThis.Date;/);
      assert.match(types, /maybe: globalThis.Date \| null;/);
      assert.match(types, /days: globalThis.Date\[\] \| null;/);
      assert.match(types, /clock: string \| globalThis.Date;/);
      assert.match(types, /clocks\?: \(string \| globalThis.Date\)\[\] \| null \| undefined;/);
      assert.equal(generateMetadata(input, options), generateMetadata(input, { noTimestamp: true }));
      assert.equal(JSON.stringify(input), before);
    });
  }

  it('uses the native catalog temporal marker without changing custom metadata', () => {
    for (const dt of ['TIMESTAMP', 'DATETIME', 'datetime2', 'datetimeoffset']) {
      const input = schema();
      const table = input.tables.events!;
      table.columns[1]!.dialectType = dt;
      table.dateColumns.add('at');
      assert.match(generateTypes(input, { noTimestamp: true }), /at: globalThis.Date;/);
      table.columns[1]!.tsType = 'Date & { readonly brand: "custom" }';
      assert.match(generateTypes(input, { noTimestamp: true }), /at: Date & \{ readonly brand: "custom" \};/);
    }
  });

  it('preserves declared types, exact overrides, and custom non-temporal Date references', () => {
    const input = schema();
    const table = input.tables.events!;
    table.columns[1]!.declaredTsType = 'Date';
    table.columns[2]!.tsType = 'Date';
    table.columns[2]!.nullable = false;
    table.columns[2]!.pgType = 'text';
    table.dateColumns.delete('maybe');
    const types = generateTypes(input, { noTimestamp: true, columnTypes: { 'events.days': 'Date[]' } });
    assert.match(types, /at: Date;/);
    assert.match(types, /maybe: Date;/);
    assert.match(types, /days: Date\[\] \| null;/);
    assert.match(types, /clock: string \| globalThis.Date;/);
  });

  it('preserves Date enum references while qualifying independent inferred temporal types', () => {
    const input = schema('documents');
    input.enums.date = ['today', 'Date'];
    input.tables.events!.columns.push({
      ...input.tables.events!.columns[1]!,
      name: 'kind',
      field: 'kind',
      pgType: '_date',
      isArray: true,
    });
    input.tables.events!.columns[1]!.pgType = 'timestamp';
    const types = generateTypes(input, { noTimestamp: true });
    assert.match(types, /export type Date = 'today' \| 'Date';/);
    assert.match(types, /kind: Date\[\];/);
    assert.match(types, /at: globalThis.Date;/);
  });

  it('qualifies ordinary temporal types and retains the intrinsic Record correction', () => {
    const input = schema('documents');
    const types = generateTypes(input, { noTimestamp: true });
    assert.match(types, /at: globalThis\.Date;/);
    assert.match(types, /clock: string \| globalThis\.Date;/);
    input.tables.records = mockTable('records', [], {}, []);
    assert.match(generateTypes(input, { noTimestamp: true }), /RecordCreateInput = \{ \[key in string\]: never \}/);
  });
});
