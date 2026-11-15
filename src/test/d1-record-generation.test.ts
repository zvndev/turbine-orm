import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateD1Files } from '../d1/generate.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';

test('D1 utility dictionaries do not bind to a public Record entity', () => {
  const schema = schemaDefToMetadata(
    defineSchema({
      records: {
        id: { type: 'integer', primaryKey: true },
        title: { type: 'text', notNull: true },
      },
    }),
  );
  const before = JSON.stringify(schema);
  const files = generateD1Files(schema, { noTimestamp: true });
  assert.match(files['types.ts'], /export interface Record \{/);
  assert.match(files['index.ts'], /readonly records: QueryInterface<Record,/);
  assert.equal((files['index.ts'].match(/extends \{ \[key in string\]: boolean \}/g) ?? []).length, 4);
  assert.match(files['index.ts'], /table<T extends object = \{ \[key in string\]: unknown \}>/);
  assert.doesNotMatch(files['index.ts'], /Record<string,/);
  assert.equal(JSON.stringify(schema), before);
  assert.deepEqual(generateD1Files(schema, { noTimestamp: true }), files);
});

test('D1 preserves caller Record types instead of rewriting override text', () => {
  const schema = schemaDefToMetadata(
    defineSchema({
      notes: {
        id: { type: 'integer', primaryKey: true },
        declared: { type: 'jsonb', tsType: "import('../custom.js').Record", notNull: true },
        overridden: { type: 'jsonb', notNull: true },
      },
    }),
  );
  const files = generateD1Files(schema, {
    noTimestamp: true,
    columnTypes: { 'notes.overridden': "import('../custom.js').Record<'kept'>" },
  });
  assert.match(files['types.ts'], /declared: import\('\.\.\/custom.js'\)\.Record;/);
  assert.match(files['types.ts'], /overridden: import\('\.\.\/custom.js'\)\.Record<'kept'>;/);
  assert.doesNotMatch(files['index.ts'], /Record<string,/);
});
