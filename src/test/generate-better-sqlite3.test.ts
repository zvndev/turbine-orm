import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { type GenerateOptions, generate, generateIndex, generateMetadata, generateTypes } from '../generate.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';

const schema = schemaDefToMetadata(defineSchema({ items: { id: { type: 'integer', primaryKey: true } } }));

describe('explicit optional SQLite generation', () => {
  it('preserves default native generation and emits an awaited optional factory only when selected', () => {
    const options = { target: 'sqlite', noTimestamp: true } as const;
    const native = generateIndex(schema, options);
    assert.equal(generateIndex(schema, { ...options, sqliteBinding: 'node:sqlite' }), native);
    assert.match(native, /export function turbine\(/);
    for (const importExt of ['.js', '.ts', '']) {
      const optional = { ...options, importExt, sqliteBinding: 'better-sqlite3' } as const;
      const output = generateIndex(schema, optional);
      assert.match(output, /import \{ turbineBetterSqlite3 \} from 'turbine-orm\/better-sqlite3'/);
      assert.match(output, /export async function turbine\(/);
      assert.match(output, /return await turbineBetterSqlite3\(target, SCHEMA/);
      assert.ok(output.includes(`from './metadata${importExt}'`));
      assert.equal(generateTypes(schema, optional), generateTypes(schema, options));
      assert.equal(generateMetadata(schema, optional), generateMetadata(schema, options));
    }
  });

  it('forwards the binding through the actual writer without changing generated metadata', () => {
    const parent = mkdtempSync(join(process.cwd(), '.optional-sqlite-generation-'));
    try {
      const outDir = join(parent, 'client');
      generate({ schema, outDir, target: 'sqlite', sqliteBinding: 'better-sqlite3', noTimestamp: true });
      assert.match(readFileSync(join(outDir, 'index.ts'), 'utf8'), /export async function turbine\(/);
      assert.equal(
        readFileSync(join(outDir, 'metadata.ts'), 'utf8'),
        generateMetadata(schema, { target: 'sqlite', noTimestamp: true }),
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('refuses wrong targets and bindings before any output is created', () => {
    const parent = mkdtempSync(join(process.cwd(), '.optional-sqlite-refusal-'));
    try {
      const outDir = join(parent, 'client');
      for (const target of [undefined, 'postgresql', 'mysql', 'mssql']) {
        const options = { target, sqliteBinding: 'better-sqlite3', schema, outDir } as GenerateOptions;
        for (const emitter of [generateIndex, generateTypes, generateMetadata]) {
          assert.throws(() => emitter(schema, options), /sqliteBinding requires target: sqlite/);
        }
        assert.throws(() => generate(options), /sqliteBinding requires target: sqlite/);
        assert.equal(existsSync(outDir), false);
      }
      for (const sqliteBinding of ['', null, 1, 'better-sqlite']) {
        assert.throws(
          () => generate({ schema, outDir, target: 'sqlite', sqliteBinding } as GenerateOptions),
          /sqliteBinding requires/,
        );
        assert.equal(existsSync(outDir), false);
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
