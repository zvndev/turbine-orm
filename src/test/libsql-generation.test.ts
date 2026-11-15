import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateLibsqlFiles } from '../libsql/generate.js';
import { schema } from './fixtures/libsql-schema.js';

test('code-first libSQL generation preserves native type emitters and selects only the local async factory', () => {
  const files = generateLibsqlFiles(schema, { noTimestamp: true });
  assert.deepEqual(Object.keys(files), ['index.ts', 'types.ts', 'metadata.ts']);
  assert.match(files['index.ts'], /export async function turbine/);
  assert.match(files['index.ts'], /await turbineLibsql\(target, SCHEMA/);
  assert.match(files['index.ts'], /from 'turbine-orm\/libsql'/);
  assert.match(files['index.ts'], /TypedTurbineLibsqlOptions/);
  assert.doesNotMatch(files['index.ts'], /node:sqlite|turbineSqlite|turbine-orm\/sqlite/);
  assert.match(files['types.ts'], /number \| string/);
  assert.match(files['metadata.ts'], /export const SCHEMA/);
  assert.match(files['types.ts'], /UserRelations/);
  assert.match(files['types.ts'], /Post/);
  assert.match(files['types.ts'], /bytes: Uint8Array/);
  assert.match(files['types.ts'], /optionalBytes: Uint8Array \| null/);
  assert.deepEqual(generateLibsqlFiles(schema, { noTimestamp: true }), files);
});
