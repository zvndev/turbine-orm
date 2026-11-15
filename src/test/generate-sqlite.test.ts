import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  type GenerateFileOptions,
  type GenerateOptions,
  generate,
  generateIndex,
  generateMetadata,
  generateTypes,
} from '../generate.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';

const schema = schemaDefToMetadata(
  defineSchema({
    users: {
      id: { type: 'serial', primaryKey: true },
      email: { type: 'text', notNull: true, unique: true },
    },
    posts: {
      id: { type: 'serial', primaryKey: true },
      userId: { type: 'integer', notNull: true, references: 'users.id' },
      title: { type: 'text', notNull: true },
    },
  }),
);
const stable = { noTimestamp: true };

// Canonical intrinsic dictionary spelling. Default generation stays pinned and
// selecting PostgreSQL explicitly must not change the generated source.
const pgHashes = [
  [generateTypes, '25085e94a9ac6577847b06e16e077b6975f1dbf970b3838149da82af5b237992'],
  [generateMetadata, '1898dd7812c080d71fb8008e91a8645e4537e4f74bf6d25a9f0bfefa70e73de2'],
  [generateIndex, 'e5563a7f2f8ca7d82b0a145ae8e078642bc361854e70c66263fc8ff5eda92e96'],
] as const;

describe('SQLite generation target', () => {
  it('keeps default PostgreSQL files pinned and the legacy factory signature intact', () => {
    for (const [emitter, expected] of pgHashes) {
      const output = emitter(schema, stable);
      assert.ok(output.length > 100);
      assert.equal(createHash('sha256').update(output).digest('hex'), expected, emitter.name);
      assert.equal(emitter(schema, { ...stable, target: 'postgresql' }), output);
    }
    assert.match(generateIndex(schema, stable), /export function turbine\(config\?: TypedTurbineConfig\)/);
  });

  it('uses the existing input/metadata emitters and honors every sibling import extension', () => {
    for (const ext of ['.js', '.ts', '']) {
      const options: GenerateFileOptions = { ...stable, target: 'sqlite', importExt: ext };
      const output = generateIndex(schema, options);
      assert.match(output, /import \{ turbineSqlite \} from 'turbine-orm\/sqlite'/);
      assert.ok(output.includes(`from './metadata${ext}'`));
      assert.ok(output.includes(`from './types${ext}'`));
      assert.equal(generateIndex(schema, options), output);
      assert.equal(generateTypes(schema, options), generateTypes(schema, stable));
      assert.equal(generateMetadata(schema, options), generateMetadata(schema, stable));
      assert.doesNotMatch(output, /new BaseTurbineClient|connectionString|new TurbineClient/);
    }
    assert.doesNotThrow(() => generateIndex({ tables: {}, enums: {} }, { target: 'sqlite' }));
  });

  it('threads the target through generate() and writes deterministic files under the project root', () => {
    const dir = mkdtempSync(join(process.cwd(), '.sqlite-generated-'));
    try {
      const options: GenerateOptions = {
        schema,
        target: 'sqlite',
        outDir: dir,
        noTimestamp: true,
        importExtension: 'js',
      };
      assert.deepEqual(generate(options), { outDir: dir, files: ['types.ts', 'metadata.ts', 'index.ts'] });
      const before = ['types.ts', 'metadata.ts', 'index.ts'].map((name) => readFileSync(join(dir, name), 'utf8'));
      assert.ok(before.every((s) => s.length > 100));
      assert.match(before[2]!, /turbineSqlite\(target, SCHEMA/);
      generate(options);
      assert.deepEqual(
        ['types.ts', 'metadata.ts', 'index.ts'].map((name) => readFileSync(join(dir, name), 'utf8')),
        before,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects unknown targets before writing anything instead of silently generating PostgreSQL', () => {
    const parent = mkdtempSync(join(process.cwd(), '.sqlite-invalid-target-'));
    const outDir = join(parent, 'output');
    try {
      for (const target of ['sqltie', '', null, 7]) {
        const options = { schema, target, outDir } as unknown as GenerateOptions;
        assert.throws(
          () => generate(options),
          /Unknown generation target.*Expected "postgresql", "sqlite", "mysql" or "mssql"/,
        );
        assert.equal(existsSync(outDir), false);
        assert.throws(() => generateIndex(schema, options), /Unknown generation target/);
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('still refuses SQLite output outside the project root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-sqlite-output-'));
    try {
      assert.throws(
        () => generate({ schema, target: 'sqlite', outDir: join(dir, 'generated') }),
        /Output directory must be within the project root/,
      );
      assert.equal(existsSync(resolve(dir, 'generated')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
