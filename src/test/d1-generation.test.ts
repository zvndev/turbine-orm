import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { generateD1Files } from '../d1/generate.js';
import { generateIndex, generateMetadata, generateTypes } from '../generate.js';
import { withDbFieldNames } from '../schema.js';
import { generationSchema } from './fixtures/d1-generation/schema.js';

const options = { noTimestamp: true };

test('D1 generation emits an actual supplied-binding factory and portable runtime imports', () => {
  const files = generateD1Files(generationSchema(), options);
  assert.deepEqual(Object.keys(files), ['index.ts', 'types.ts', 'metadata.ts']);
  assert.match(files['index.ts'], /return turbineD1\(binding, SCHEMA/);
  assert.match(files['index.ts'], /binding: D1DatabaseBinding/);
  assert.doesNotMatch(
    files['index.ts'],
    /turbineSqlite|node:sqlite|export async function|TypedTransactionClient|extends BaseTurbineClient/,
  );
  assert.match(files['index.ts'], /'findManyStream' \| 'findManyStreamBatches'/);
  assert.match(files['index.ts'], /onConflict\?: never/);
  assert.deepEqual(files, generateD1Files(generationSchema(), options));
});

test('D1 metadata stays byte-identical to the established SQLite target; integer and BLOB reads follow D1', () => {
  const schema = generationSchema();
  const files = generateD1Files(schema, options);
  assert.equal(
    files['metadata.ts'],
    generateMetadata(schema, { ...options, target: 'sqlite', exactNativeIntegers: false }),
  );
  assert.match(files['types.ts'], /largeId: number;/);
  assert.match(files['types.ts'], /payload: Uint8Array \| null;/);
  assert.match(files['types.ts'], /createdAt: globalThis\.Date;/);
  assert.match(files['types.ts'], /profile: \{ tags: string\[\] \} \| null;/);
  assert.doesNotMatch(files['types.ts'], /largeId: (?:string|bigint|number \| string)/);
  const create = files['types.ts'].split('export type PairCreate = {')[1]!.split('};')[0]!;
  assert.doesNotMatch(create, /computed/);
  assert.equal(JSON.stringify(schema), JSON.stringify(generationSchema()), 'generation must not mutate metadata');
});

test('D1 keeps overrides, import extensions, raw names, composite selectors and legacy relation declarations', () => {
  const schema = generationSchema();
  const files = generateD1Files(schema, {
    ...options,
    keepColumnNames: true,
    importExt: '.ts',
    columnTypes: { 'users.large_id': '42', 'users.payload': 'Uint8Array' },
  });
  assert.match(files['index.ts'], /from '\.\/metadata.ts'/);
  assert.match(files['types.ts'], /large_id: 42;/);
  assert.match(files['types.ts'], /left_id_right_id/);
  assert.match(files['types.ts'], /UserWithPosts/);
  assert.equal(files['metadata.ts'], generateMetadata(withDbFieldNames(schema), { ...options, target: 'sqlite' }));
  assert.throws(() => generateD1Files(schema, { columnTypes: { 'missing.x': 'string' } }), /names no table/);
  assert.throws(() => generateD1Files(schema, { target: 'sqlite' } as never), /fixes its target/);
  assert.throws(() => generateD1Files(schema, { exactNativeIntegers: true } as never), /number-valued/);
});

test('D1 preserves dotted column names and empty schemas without synthetic override keys', () => {
  const schema = generationSchema();
  const table = schema.tables.users!;
  const column = table.columns.find((column) => column.name === 'large_id')!;
  column.name = 'large.id';
  column.field = 'large.id';
  delete table.columnMap.largeId;
  table.columnMap['large.id'] = 'large.id';
  delete table.reverseColumnMap.large_id;
  table.reverseColumnMap['large.id'] = 'large.id';
  table.allColumns = table.allColumns.map((name) => (name === 'large_id' ? 'large.id' : name));
  const files = generateD1Files(schema, options);
  assert.match(files['types.ts'], /'large.id': number;/);
  assert.equal(files['metadata.ts'], generateMetadata(schema, { ...options, target: 'sqlite' }));
  const empty = generateD1Files({ ...schema, tables: {} }, options);
  assert.match(empty['index.ts'], /return turbineD1/);
});

test('D1 refuses drift in the existing SQLite factory contract', async () => {
  const root = mkdtempSync(join(tmpdir(), 'd1-generator-drift-'));
  try {
    const schema = generationSchema();
    const original = generateIndex(schema, { ...options, target: 'sqlite', exactNativeIntegers: false });
    for (const [label, from, to] of [
      ['import', 'turbineSqlite }', 'newSqlite }'],
      ['factory', 'return turbineSqlite(target, SCHEMA', 'return turbineSqlite(target, OTHER'],
      ['transaction', 'extends BaseTransactionClient', 'extends OtherTransactionClient'],
      [
        'session-value',
        'context: { [key in string]: string | number | boolean }',
        'context: { [key in string]: string }',
      ],
      [
        'session-callback',
        'context: { [key in string]: string | number | boolean },\n    fn: (tx: TypedTransactionClient)',
        'context: { [key in string]: string | number | boolean },\n    fn: (tx: BaseTransactionClient)',
      ],
    ]) {
      assert(original.includes(from!));
      // The drifted text travels in a file named by an environment variable,
      // never embedded in generated source.
      const driftFile = join(root, `${label}.txt`);
      writeFileSync(driftFile, original.replace(from!, to!));
      const previousDrift = process.env.TURBINE_D1_DRIFT_FILE;
      process.env.TURBINE_D1_DRIFT_FILE = driftFile;
      try {
        const result = await build({
          entryPoints: [resolve('src/d1/generate.ts')],
          bundle: true,
          platform: 'node',
          format: 'esm',
          write: false,
          plugins: [
            {
              name: 'drift-control',
              setup(builder) {
                builder.onResolve({ filter: /\.\.\/generate\.js$/ }, () => ({ path: 'generator', namespace: 'drift' }));
                builder.onLoad({ filter: /.*/, namespace: 'drift' }, () => ({
                  contents:
                    "import { readFileSync } from 'node:fs';\nexport const generateIndex=()=>readFileSync(process.env.TURBINE_D1_DRIFT_FILE,'utf8'); export const generateTypes=()=>''; export const generateMetadata=()=>'';",
                }));
              },
            },
          ],
        });
        const file = join(root, `${label}.mjs`);
        writeFileSync(file, result.outputFiles[0]!.text);
        const module = await import(pathToFileURL(file).href);
        assert.throws(() => module.generateD1Files(schema, options), /SQLite generation contract changed/);
      } finally {
        if (previousDrift === undefined) delete process.env.TURBINE_D1_DRIFT_FILE;
        else process.env.TURBINE_D1_DRIFT_FILE = previousDrift;
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D1 raw names preserve own prototype-named column and table maps without changing input', async () => {
  const schema = generationSchema();
  const table = schema.tables.users!;
  table.columns[1] = { ...table.columns[1]!, name: '__proto__', field: 'prototypeValue' };
  table.name = '__proto__';
  schema.tables = Object.fromEntries([['__proto__', table]]);
  const before = JSON.stringify(schema);
  const root = mkdtempSync(join(tmpdir(), 'd1-raw-name-metadata-'));
  try {
    const files = generateD1Files(schema, { noTimestamp: true, keepColumnNames: true });
    const file = join(root, 'metadata.ts');
    writeFileSync(file, files['metadata.ts']);
    const { SCHEMA } = await import(pathToFileURL(file).href);
    assert(Object.hasOwn(SCHEMA.tables, '__proto__'));
    const mapped = Object.getOwnPropertyDescriptor(SCHEMA.tables, '__proto__')!.value;
    for (const map of [mapped.columnMap, mapped.reverseColumnMap]) {
      assert(Object.hasOwn(map, '__proto__'));
      assert.equal(Object.getOwnPropertyDescriptor(map, '__proto__')!.value, '__proto__');
    }
    assert.equal(mapped.columns[1].field, '__proto__');
    assert.equal(JSON.stringify(schema), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D1 leaves default PostgreSQL declarations and runtime metadata policy in the shared emitter', () => {
  const schema = generationSchema();
  const before = [generateIndex(schema, options), generateTypes(schema, options), generateMetadata(schema, options)];
  generateD1Files(schema, options);
  assert.deepEqual(
    [generateIndex(schema, options), generateTypes(schema, options), generateMetadata(schema, options)],
    before,
  );
});
