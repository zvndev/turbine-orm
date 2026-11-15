import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import {
  type GenerateFileOptions,
  generate,
  generateIndex,
  generateMetadata,
  generateTypes,
  generateZod,
} from '../generate.js';
import { nativeIntegerSchema } from './native-integer-fixture.js';

const emitters = [generateTypes, generateMetadata, generateIndex, generateZod];
const targets = ['postgresql', 'sqlite', 'mysql', 'mssql'] as const;
// Canonical intrinsic dictionary spelling; every emitter and target remains pinned.
const defaultHashes: Record<string, string[]> = {
  postgresql: [
    '6002b56700516af84b1ab3926ab6b81f155fcea7a4556f2e9812ee5703425acd',
    '4a54365a74f214bd8cdd24ff9f252413dc586bf44d027c53ab43120ecd75c714',
    'f3b7aa0d776948bfd26bc904e8c64113819056f1f0b02e2e3f465c7d22e532a7',
    '594a44d7e7f71a50dc06a2cf6012177e5e3079b57ec39553537b53f4ba043f78',
  ],
  sqlite: [
    'bfe60f0c06bdfdc646d9a0d0e15b271db7303ca62d4df594b7976cb1813008ae',
    'f9c7ff34337243e20af352e9da2f5477c2512f935460a90b9f16234fbdaa9d98',
    'f9500ca39064175d72945d6363ec25c027eb49444983e30341a044b3dc68516f',
    '0fcb1bc6866ad791a614d7b4dbefa6423422c8ce23fdf7ea89fd558bba996bf9',
  ],
  mysql: [
    'bfe60f0c06bdfdc646d9a0d0e15b271db7303ca62d4df594b7976cb1813008ae',
    '8d28c2996bf272dcde38aa60afd679b4d598418693934823d5649c47c08dfb9f',
    '89c4d78c40d0f90e23360b1967e7ddae3d73443e072955b1c66e6bf551407ccb',
    '0fcb1bc6866ad791a614d7b4dbefa6423422c8ce23fdf7ea89fd558bba996bf9',
  ],
  mssql: [
    'bfe60f0c06bdfdc646d9a0d0e15b271db7303ca62d4df594b7976cb1813008ae',
    '307ff62755a1cd172cd92d16bbaa809cc2b0085912413bfe333b5d6a1e711626',
    'ef8a28c8b4b8592f99f169d38f71b04174386c809ab9ebe9281f7d31e1d3ee19',
    '46b1a1364e74bf098ab35d276566d486c498899bc09965307ded33958ff2dcaa',
  ],
};

describe('opt-in native integer generation', () => {
  for (const target of targets) {
    it(`${target}: keeps default output pinned and the disabled option byte-identical`, () => {
      const schema = nativeIntegerSchema(target);
      const options = { target, noTimestamp: true };
      const actual = emitters.map((emit) => {
        const before = emit(schema, options);
        assert.ok(before.length > 100);
        assert.equal(emit(schema, { ...options, exactNativeIntegers: false }), before);
        return createHash('sha256').update(before).digest('hex');
      });
      assert.deepEqual(actual, defaultHashes[target]);
    });
  }

  for (const target of ['sqlite', 'mysql', 'mssql'] as const) {
    it(`${target}: separates read/write types without changing runtime metadata or factory`, () => {
      const schema = nativeIntegerSchema(target);
      const before = JSON.stringify(schema);
      const options = { target, noTimestamp: true, exactNativeIntegers: true };
      const types = generateTypes(schema, options);
      assert.match(types, /value: number \| string;/);
      assert.match(types, /optional: number \| string \| null;/);
      assert.match(types, /value: number \| string \| bigint;/);
      assert.match(types, /optional\?: number \| string \| bigint \| null \| undefined;/);
      assert.match(types, /UpdateOperatorInput<number \| string \| bigint>/);
      assert.match(types, /computed: number \| string;/);
      assert.equal((types.match(/computed[?:]/g) ?? []).length, 1, 'computed columns must only occur in row types');
      assert.match(types, /declared: bigint \| null;/);
      assert.match(types, /declared\?: bigint \| null \| undefined;/);
      assert.match(types, /amount: string;/);
      assert.match(types, /fraction: number;/);
      assert.match(types, /enabled: boolean;/);
      assert.match(types, target === 'sqlite' ? /narrow: number \| string;/ : /narrow: number;/);
      assert.match(types, /id: number \| string;/);
      assert.match(types, /export type AccountWhereUnique/);
      assert.match(types, /alternate: number \| string/);
      assert.equal(generateMetadata(schema, options), generateMetadata(schema, { target, noTimestamp: true }));
      assert.equal(generateIndex(schema, options), generateIndex(schema, { target, noTimestamp: true }));
      assert.equal(JSON.stringify(schema), before, 'generation must not mutate input metadata');
      const zod = generateZod(schema, options);
      assert.match(zod, /value: z.union\(\[z.number\(\), z.string\(\)\]\)/);
      assert.match(zod, /value: z.union\(\[z.number\(\), z.string\(\), z.bigint\(\)\]\)/);
      assert.match(zod, /optional: z.union\(\[z.number\(\), z.string\(\)\]\).nullable\(\)/);
    });

    it(`${target}: explicit overrides win, including nullable unique selectors`, () => {
      const schema = nativeIntegerSchema(target);
      const types = generateTypes(schema, {
        target,
        exactNativeIntegers: true,
        noTimestamp: true,
        columnTypes: { 'entries.value': 'string', 'accounts.alternate': 'bigint', 'entries.declared': 'string' },
      });
      assert.match(types, /value: string;/);
      assert.doesNotMatch(types, /value: number/);
      assert.match(types, /alternate: bigint \| null;/);
      assert.match(types, /alternate: bigint[ ;}]/);
      assert.match(types, /declared: string \| null;/);
      assert.throws(
        () =>
          generateTypes(schema, { target, exactNativeIntegers: true, columnTypes: { 'entries.missing': 'number' } }),
        ValidationError,
      );
    });
  }

  it('matches native affinity/type spelling, without widening enums or arrays', () => {
    const schema = nativeIntegerSchema('mysql');
    const col = schema.tables.entries!.columns.find((c) => c.name === 'value')!;
    for (const type of ['BIGINT', 'bigint unsigned', 'bigint(20) unsigned zerofill', 'int8', 'bigserial']) {
      col.dialectType = type;
      assert.match(generateTypes(schema, { target: 'mysql', exactNativeIntegers: true }), /value: number \| string;/);
    }
    for (const type of ['int', 'mediumint', 'decimal', 'double', 'tinyint(1)', 'paint']) {
      col.dialectType = type;
      assert.doesNotMatch(
        generateTypes(schema, { target: 'mysql', exactNativeIntegers: true }),
        /value: number \| string;/,
      );
    }
    for (const type of ['INTEGER', 'tinyint', 'INT2', 'unsigned big int', 'POINT', '_INT', '_int8', '_POINT']) {
      col.dialectType = type;
      assert.match(generateTypes(schema, { target: 'sqlite', exactNativeIntegers: true }), /value: number \| string;/);
    }
    col.dialectType = 'paint';
    schema.enums.paint = ['red', 'blue'];
    assert.match(generateTypes(schema, { target: 'sqlite', exactNativeIntegers: true }), /value: Paint;/);
    col.dialectType = '_int8';
    col.isArray = true;
    col.tsType = 'string[]';
    assert.match(generateTypes(schema, { target: 'sqlite', exactNativeIntegers: true }), /value: string\[\];/);
  });

  it('refuses unsupported targets and malformed options at every emitter before writing files', () => {
    const schema = nativeIntegerSchema('postgresql');
    for (const options of [
      { exactNativeIntegers: true },
      { target: 'postgresql', exactNativeIntegers: true },
      { target: 'powdb', exactNativeIntegers: true },
      { target: 'sqlite', exactNativeIntegers: 'true' },
      { target: 'mysql', exactNativeIntegers: null },
    ]) {
      for (const emit of emitters) assert.throws(() => emit(schema, options as GenerateFileOptions), ValidationError);
      const dir = mkdtempSync(join(process.cwd(), '.native-integer-refusal-'));
      const outDir = join(dir, 'generated');
      try {
        assert.throws(
          () => generate({ schema, outDir, ...options } as Parameters<typeof generate>[0]),
          ValidationError,
        );
        assert.equal(existsSync(outDir), false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('forwards the option through generate(), raw field names, overrides and optional validators', () => {
    const dir = mkdtempSync(join(process.cwd(), '.native-integer-generated-'));
    try {
      const result = generate({
        schema: nativeIntegerSchema('sqlite'),
        target: 'sqlite',
        exactNativeIntegers: true,
        noTimestamp: true,
        keepColumnNames: true,
        outDir: dir,
        zod: true,
      });
      assert.deepEqual(result.files, ['types.ts', 'metadata.ts', 'index.ts', 'zod.ts']);
      assert.match(readFileSync(join(dir, 'types.ts'), 'utf8'), /account_id: number \| string;/);
      assert.match(readFileSync(join(dir, 'types.ts'), 'utf8'), /account_id: number \| string \| bigint;/);
      assert.match(readFileSync(join(dir, 'zod.ts'), 'utf8'), /account_id: z.union/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
