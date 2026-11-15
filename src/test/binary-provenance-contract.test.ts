import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { it } from 'node:test';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import ts from 'typescript';
import { columnTsType, generate, generateIndex, generateMetadata, generateTypes, generateZod } from '../generate.js';
import { introspectPostgresCatalog } from '../introspect.js';
import { type ColumnMetadata, type SchemaMetadata, withDbFieldNames } from '../schema.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { introspectSqliteDatabase } from '../sqlite.js';
import { mockTable } from './helpers.js';

const repo = resolve(import.meta.dirname, '../..');
const options = { noTimestamp: true } as const;

function schema(tag?: 'Uint8Array' | 'Buffer'): SchemaMetadata {
  const assets = mockTable('assets', [
    { name: 'id', field: 'id' },
    { name: 'data', field: 'data', unique: true },
  ]);
  Object.assign(assets.columns[1]!, {
    pgType: tag === 'Buffer' ? 'bytea' : 'BLOB',
    tsType: tag ?? 'Uint8Array',
    ...(tag === undefined ? {} : { inferredBinaryType: tag }),
  });
  return {
    enums: {},
    tables: {
      assets,
      uint8_arrays: mockTable('uint8_arrays', [
        { name: 'id', field: 'id' },
        { name: 'title', field: 'title' },
      ]),
      buffers: mockTable('buffers', [
        { name: 'id', field: 'id' },
        { name: 'title', field: 'title' },
      ]),
    },
  };
}

function data(input: SchemaMetadata): ColumnMetadata {
  return input.tables.assets!.columns[1]!;
}

async function roundTrip(input: SchemaMetadata): Promise<SchemaMetadata> {
  const dir = mkdtempSync(join(tmpdir(), 'binary-provenance-metadata-'));
  try {
    const js = ts.transpileModule(generateMetadata(input, options), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
    }).outputText;
    const path = join(dir, 'metadata.mjs');
    writeFileSync(path, js);
    return (await import(pathToFileURL(path).href)).SCHEMA as SchemaMetadata;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Loaded at run time: a static value import of node:sqlite fails this whole
// file at link time on a runtime without the builtin (Node 20).
const DatabaseSync: (new (path: string) => DatabaseSyncType) | undefined = (() => {
  try {
    return createRequire(process.cwd())('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();

const sqliteIt: typeof it = DatabaseSync
  ? it
  : (((name: string) => it(name, { skip: 'requires node:sqlite (Node >= 22.5)' }, () => {})) as typeof it);

sqliteIt('marks only native SQLite mapper binary results, preserving mapper precedence and all input handles', () => {
  const db = new DatabaseSync!(':memory:');
  try {
    db.exec(`CREATE TABLE assets(id INTEGER PRIMARY KEY, data BLOB NOT NULL, optional BLOB,
      integer_blob INTBLOB, text_blob TEXTBLOB, date_blob DATEBLOB, untyped, any_value ANY);`);
    const input = introspectSqliteDatabase(db);
    assert.equal(input.tables.assets!.columns.length, 8);
    for (const col of input.tables.assets!.columns) {
      assert.equal(col.inferredBinaryType, ['data', 'optional'].includes(col.name) ? 'Uint8Array' : undefined);
    }
    assert.equal(data(input).tsType, 'Uint8Array');
    assert.equal(input.tables.assets!.columns[2]!.tsType, 'Uint8Array | null');
    assert.equal(input.tables.assets!.columns[3]!.tsType, 'number | null');
    assert.equal(input.tables.assets!.columns[4]!.tsType, 'string | null');
    assert.equal(input.tables.assets!.columns[5]!.tsType, 'Date | null');
    const bytes = Uint8Array.from([0, 1, 254, 255]);
    db.prepare('INSERT INTO assets(data) VALUES (?)').run(bytes);
    assert.deepEqual(db.prepare('SELECT data FROM assets').get()!.data, bytes);
  } finally {
    db.close();
  }
});

it('requires explicit null domain proof on information_schema rows and actual builtin identity on matviews', async (t) => {
  const rows = [
    { column_name: 'builtin', udt_name: 'bytea', domain_name: null },
    { column_name: 'array', udt_name: '_bytea', domain_name: null, data_type: 'ARRAY' },
    { column_name: 'domain', udt_name: 'bytea', domain_name: 'binary_domain' },
    { column_name: 'array_domain', udt_name: '_bytea', domain_name: 'binary_array_domain', data_type: 'ARRAY' },
    { column_name: 'missing', udt_name: 'bytea' },
    { column_name: 'undefined', udt_name: 'bytea', domain_name: undefined },
    { column_name: 'custom', udt_name: 'bytea', domain_name: null, udt_schema: 'public' },
  ].map((row) => ({ table_name: 'assets', udt_schema: 'pg_catalog', data_type: 'bytea', ...row }));
  const calls: string[] = [];
  const query = async (sql: string) => {
    calls.push(sql);
    if (sql.includes('FROM information_schema.tables')) return { rows: [{ table_name: 'assets' }] };
    if (sql.includes('FROM information_schema.columns')) return { rows };
    if (sql.includes('FROM information_schema.views')) return { rows: [{ table_name: 'ordinary' }] };
    if (sql.includes('FROM pg_matviews')) return { rows: [{ table_name: 'materialized' }] };
    if (sql.includes('FROM pg_catalog.pg_attribute a')) {
      return {
        rows: [
          { table_name: 'materialized', column_name: 'builtin', udt_schema: 'pg_catalog', udt_name: 'bytea' },
          { table_name: 'materialized', column_name: 'domain', udt_schema: 'public', udt_name: 'binary_domain' },
        ],
      };
    }
    return { rows: [] };
  };
  t.mock.method(pg.Pool.prototype, 'query', query as typeof pg.Pool.prototype.query);
  const input = await introspectPostgresCatalog({ connectionString: 'postgresql://unused/unused', includeViews: true });
  assert.equal(calls.length, 11);
  assert.match(
    calls.find((sql) => sql.includes('FROM information_schema.columns'))!,
    /udt_schema,\s+domain_name,\s+data_type,/,
  );
  assert.deepEqual(
    input.tables.assets!.columns.map((col) => col.inferredBinaryType),
    ['Buffer', 'Buffer', undefined, undefined, undefined, undefined, undefined],
  );
  assert.deepEqual(
    input.tables.materialized!.columns.map((col) => col.inferredBinaryType),
    ['Buffer', undefined],
  );
  for (const table of Object.values(input.tables)) {
    for (const col of table.columns) assert.equal(Object.hasOwn(col, 'domain_name'), false);
  }
});

it('marks the default code-first BYTEA bridge without substituting enums or caller declarations', () => {
  const input = schemaDefToMetadata(
    defineSchema(
      {
        assets: {
          id: { type: 'serial', primaryKey: true },
          data: { type: 'bytea', notNull: true },
          many: { type: 'bytea', array: true },
          declared: { type: 'bytea', tsType: 'Buffer' },
          custom: { type: 'bytea', tsType: 'Buffer & { brand: "custom" }' },
          kind: { type: 'enum', enumName: 'bytea' },
        },
      },
      { enums: { bytea: ['first', 'second'] } },
    ),
  );
  const columns = input.tables.assets!.columns;
  assert.deepEqual(
    columns.map((col) => col.inferredBinaryType),
    [undefined, 'Buffer', 'Buffer', undefined, undefined, undefined],
  );
  assert.equal(columns[3]!.tsType, 'Buffer | null');
  assert.equal(columns[3]!.declaredTsType, 'Buffer');
});

it('qualifies only explicit corresponding hints, retaining legacy, enum, declaration and override meanings', () => {
  for (const tag of ['Uint8Array', 'Buffer'] as const) {
    const input = schema(tag);
    const col = data(input);
    assert.equal(columnTsType(col, {}), `globalThis.${tag}`);
    assert.match(generateTypes(input, options), new RegExp(`data: globalThis\\.${tag};`));
    col.nullable = true;
    col.isArray = true;
    col.tsType = `${tag}[] | null`;
    assert.equal(columnTsType(col, {}), `globalThis.${tag}[] | null`);
    assert.match(generateTypes(input, options), new RegExp(`data: globalThis\\.${tag}\\[\\] \\| null;`));
    col.declaredTsType = tag;
    assert.match(generateTypes(input, options), new RegExp(`data: ${tag} \\| null;`));
    assert.match(
      generateTypes(input, { ...options, columnTypes: { 'assets.data': `${tag} & { brand: "owned" }` } }),
      /data: (?:Buffer|Uint8Array) & \{ brand: "owned" \} \| null;/,
    );
    delete col.declaredTsType;
    col.tsType = `${tag} & { brand: "custom" }`;
    assert.equal(columnTsType(col, {}), col.tsType);
    col.tsType = `${tag}[] | null`;
    input.enums[col.pgType] = ['enum-value'];
    assert.doesNotMatch(columnTsType(col, input.enums), /globalThis/);
    input.enums = {};
    delete col.inferredBinaryType;
    assert.equal(columnTsType(col, {}), col.tsType);
    col.inferredBinaryType = undefined;
    assert.equal(columnTsType(col, {}), col.tsType);
  }
  const caller = schema();
  assert.match(generateTypes(caller, options), /data: Uint8Array;/);
  data(caller).inferredBinaryType = 'Uint8Array'; // A valid caller hint deliberately opts in.
  assert.match(generateTypes(caller, options), /data: globalThis.Uint8Array;/);
});

it('preserves own hints through copying, JSON rehydration and serialized generated metadata', async () => {
  const input = schema('Buffer');
  const before = structuredClone(input);
  const col = data(input);
  const table = input.tables.assets!;
  const columns = table.columns;
  const proto = Object.getPrototypeOf(col);
  const types = generateTypes(input, options);
  assert.equal(generateTypes(withDbFieldNames(input), options), types);
  const rehydrated = JSON.parse(
    JSON.stringify(input, (_key, value) => (value instanceof Set ? { set: [...value] } : value)),
    (_key, value) => (value && typeof value === 'object' && Object.hasOwn(value, 'set') ? new Set(value.set) : value),
  ) as SchemaMetadata;
  assert.equal(generateTypes(rehydrated, options), types);
  const serialized = await roundTrip(input);
  assert.equal(data(serialized).inferredBinaryType, 'Buffer');
  assert.equal(generateTypes(serialized, options), types);
  assert.deepEqual(input, before);
  assert.equal(input.tables.assets, table);
  assert.equal(table.columns, columns);
  assert.equal(data(input), col);
  assert.equal(Object.getPrototypeOf(col), proto);
  col.declaredTsType = 'Buffer';
  const owned = await roundTrip(input);
  assert.equal(data(owned).declaredTsType, 'Buffer');
  assert.equal(data(owned).inferredBinaryType, 'Buffer');
  assert.equal(generateTypes(owned, options), generateTypes(input, options));
});

it('preserves frozen nonconfigurable and nonenumerable own hints without touching caller descriptors', () => {
  for (const enumerable of [true, false]) {
    const input = schema('Uint8Array');
    const col = data(input);
    Object.defineProperty(col, 'inferredBinaryType', {
      value: 'Uint8Array',
      enumerable,
      writable: false,
      configurable: false,
    });
    Object.freeze(col);
    const before = Object.getOwnPropertyDescriptors(col);
    const copied = withDbFieldNames(input);
    assert.equal(data(copied).inferredBinaryType, 'Uint8Array');
    assert.deepEqual(Object.getOwnPropertyDescriptor(data(copied), 'inferredBinaryType'), before.inferredBinaryType);
    assert.match(generateTypes(copied, options), /data: globalThis.Uint8Array;/);
    assert.deepEqual(Object.getOwnPropertyDescriptors(col), before);
  }
});

for (const tag of ['Uint8Array', 'Buffer'] as const) {
  for (const array of tag === 'Buffer' ? [false, true] : [false]) {
    for (const nullable of [false, true]) {
      it(`retains nonenumerable binary hints in unique selectors: ${tag}, array=${array}, nullable=${nullable}`, () => {
        const input = schema(tag);
        const col = data(input);
        Object.assign(col, {
          dialectType: tag === 'Buffer' ? (array ? '_bytea' : 'bytea') : 'BLOB',
          pgType: tag === 'Buffer' ? (array ? '_bytea' : 'bytea') : 'BLOB',
          isArray: array,
          nullable,
          tsType: `${tag}${array ? '[]' : ''}${nullable ? ' | null' : ''}`,
        });
        input.tables.assets!.uniqueColumns!.push(['id', 'data']);
        Object.defineProperty(col, 'inferredBinaryType', {
          value: tag,
          enumerable: false,
          configurable: false,
          writable: false,
        });
        Object.freeze(col);
        const before = Object.getOwnPropertyDescriptors(col);
        const expected = `globalThis.${tag}${array ? '[]' : ''}`;
        const check = (text: string) => {
          const unique = /export type AssetWhereUnique = ([^\n]+);/.exec(text)?.[1];
          assert.ok(unique);
          assert.ok(unique.includes(`{ data: ${expected} }`), unique);
          assert.ok(unique.includes(`{ id: number; data: ${expected} }`), unique);
        };
        check(generateTypes(input, options));
        check(generateTypes(withDbFieldNames(input), options));
        const dir = mkdtempSync(join(tmpdir(), 'binary-unique-copy-'));
        const cwd = process.cwd();
        try {
          process.chdir(dir);
          generate({ schema: input, ...options, keepColumnNames: true, outDir: dir });
          check(readFileSync(join(dir, 'types.ts'), 'utf8'));
        } finally {
          process.chdir(cwd);
          rmSync(dir, { recursive: true, force: true });
        }
        assert.deepEqual(Object.getOwnPropertyDescriptors(col), before);
      });
    }
  }
}

it('keeps unique projection caller precedence and unrelated spread getter semantics', () => {
  for (const tag of ['Uint8Array', 'Buffer'] as const) {
    const input = schema(tag);
    const col = data(input);
    Object.defineProperty(col, 'inferredBinaryType', { value: tag, enumerable: false });
    const unique = (extra = {}) =>
      /export type AssetWhereUnique = ([^\n]+);/.exec(generateTypes(input, { ...options, ...extra }))![1]!;
    assert.ok(unique({ columnTypes: { 'assets.data': `${tag} | null` } }).includes(`{ data: ${tag} | null }`));
    col.declaredTsType = tag;
    assert.ok(unique().includes(`{ data: ${tag} }`));
    delete col.declaredTsType;
    col.tsType = `${tag} & { readonly brand: 'owned' }`;
    assert.ok(unique().includes(`{ data: ${col.tsType} }`));
    col.tsType = tag;
    input.enums[col.dialectType ?? col.pgType] = ['owned'];
    assert.doesNotMatch(unique(), /globalThis/);
    input.enums = {};
    const effects: string[] = [];
    Object.defineProperty(col, 'extra', {
      enumerable: true,
      configurable: true,
      get() {
        assert.equal(this, col);
        effects.push('extra');
        return 7;
      },
    });
    unique();
    assert.deepEqual(effects, ['extra']);
    const reason = new Error('unique copy getter');
    Object.defineProperty(col, 'extra', {
      enumerable: true,
      get() {
        assert.equal(this, col);
        throw reason;
      },
    });
    assert.throws(
      () => unique(),
      (error) => error === reason,
    );
  }
});

it('preserves original spread getter receivers, symbol keys, effect order, counts and throws', () => {
  const input = schema('Uint8Array');
  const col = data(input);
  const events: string[] = [];
  const symbol = Symbol('enumerable');
  const hidden = Symbol('hidden');
  const define = (key: PropertyKey, value: unknown, enumerable = true) =>
    Object.defineProperty(col, key, {
      configurable: true,
      enumerable,
      get(this: ColumnMetadata) {
        assert.equal(this, col);
        events.push(String(key));
        return value;
      },
    });
  define('name', 'data');
  define('extra', 23);
  define(symbol, 24);
  define(hidden, 25, false);
  Object.defineProperty(col, 'hiddenText', { value: 26 });
  const legacy = { ...col, field: col.name };
  const expected = events.splice(0);
  assert.deepEqual(expected, ['name', 'extra', String(symbol), 'name']);
  const copied = data(withDbFieldNames(input));
  assert.deepEqual(events.splice(0), expected);
  assert.deepEqual(Object.getOwnPropertyDescriptors(copied), Object.getOwnPropertyDescriptors(legacy));
  const fault = new Error('getter-fault');
  define('later', 30);
  Object.defineProperty(col, 'extra', {
    enumerable: true,
    configurable: true,
    get() {
      assert.equal(this, col);
      events.push('extra');
      throw fault;
    },
  });
  assert.throws(
    () => ({ ...col, field: col.name }),
    (error) => error === fault,
  );
  const failedOrder = events.splice(0);
  assert.throws(
    () => withDbFieldNames(input),
    (error) => error === fault,
  );
  assert.deepEqual(events, failedOrder);
  assert.deepEqual(failedOrder, ['name', 'extra']);
});

it('ignores inherited hints without getter effects and refuses own accessors and malformed data before writes', () => {
  const input = schema();
  const col = data(input);
  let effects = 0;
  const prototype = Object.create(Object.getPrototypeOf(col), {
    inferredBinaryType: {
      get() {
        effects++;
        return 'Uint8Array';
      },
    },
  });
  Object.setPrototypeOf(col, prototype);
  for (const emit of [generateTypes, generateIndex, generateMetadata, generateZod]) emit(input, options);
  assert.equal(columnTsType(col, {}), 'Uint8Array');
  assert.equal(effects, 0);
  const dir = mkdtempSync(join(tmpdir(), 'binary-provenance-refusal-'));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    for (const name of ['types.ts', 'metadata.ts', 'index.ts', 'zod.ts']) writeFileSync(name, `sentinel:${name}`);
    const before = readdirSync(dir).map((name) => [name, readFileSync(name, 'utf8')]);
    for (const descriptor of [
      {
        get() {
          effects++;
          return 'Uint8Array';
        },
        enumerable: true,
      },
      ...[null, false, 23, {}, ['Buffer'], 'Buffer; throw 1', 'globalThis.Buffer'].map((value) => ({
        value,
        enumerable: true,
      })),
    ]) {
      Object.defineProperty(col, 'inferredBinaryType', { ...descriptor, configurable: true });
      for (const emit of [generateTypes, generateIndex, generateMetadata, generateZod])
        assert.throws(() => emit(input, options), /inferredBinaryType/);
      assert.throws(() => columnTsType(col, {}, 'Uint8Array'), /inferredBinaryType/);
      assert.throws(
        () =>
          generate({
            schema: input,
            outDir: dir,
            keepColumnNames: true,
            zod: true,
            columnTypes: { 'assets.data': 'Uint8Array' },
          }),
        /inferredBinaryType/,
      );
      assert.equal(effects, 0);
      assert.deepEqual(
        readdirSync(dir).map((name) => [name, readFileSync(name, 'utf8')]),
        before,
      );
    }
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

it('strictly accepts native bytes, rejects plain entity values, and preserves unmarked canonical caller text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'binary-provenance-consumer-'));
  try {
    mkdirSync(join(dir, 'node_modules'));
    symlinkSync(repo, join(dir, 'node_modules/turbine-orm'), 'dir');
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          skipLibCheck: false,
          noEmit: true,
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          target: 'ES2023',
          types: ['node'],
          typeRoots: [join(repo, 'node_modules/@types')],
          paths: { 'turbine-orm': [join(repo, 'dist/index.d.ts')] },
        },
        files: ['usage.ts', 'types.ts'],
      }),
    );
    for (const tag of ['Uint8Array', 'Buffer'] as const) {
      const input = schema(tag);
      const native = tag === 'Buffer' ? 'Buffer.from([0,1,254,255])' : 'new Uint8Array([0,1,254,255])';
      const consumer = (
        value: string,
      ) => `import type { Asset, AssetCreateInput, AssetUpdateInput, AssetWhereUnique } from './types.js';
const value = ${value};
const row: Asset = { id: 1, data: value };
const create: AssetCreateInput = { data: value };
const update: AssetUpdateInput = { data: value };
const unique: AssetWhereUnique = { data: value };
void [row, create, update, unique];\n`;
      const compile = (value: string) => {
        writeFileSync(join(dir, 'types.ts'), generateTypes(input, options));
        writeFileSync(join(dir, 'usage.ts'), consumer(value));
        return spawnSync(process.execPath, [join(repo, 'node_modules/typescript/bin/tsc'), '-p', dir], {
          encoding: 'utf8',
          timeout: 60_000,
        });
      };
      const valid = compile(native);
      assert.equal(valid.status, 0, valid.stdout + valid.stderr);
      const invalid = compile('{ id: 42, title: 7 }');
      assert.equal(invalid.status, 2, invalid.stdout + invalid.stderr);
      for (const line of [3, 4, 5, 6]) assert.match(invalid.stdout, new RegExp(`usage.ts\\(${line},`));
      delete data(input).inferredBinaryType;
      const legacy = compile('{ id: 42, title: 7 }');
      assert.equal(legacy.status, 0, legacy.stdout + legacy.stderr);
      const legacyBytes = compile(native);
      assert.equal(legacyBytes.status, 2, legacyBytes.stdout + legacyBytes.stderr);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
