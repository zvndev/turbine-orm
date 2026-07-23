/**
 * turbine-orm: importExtension generator option (F3)
 *
 * Unit tests (no DB) for the sibling-import extension: the resolved extension
 * threaded into `generateIndex`, plus the tsconfig-aware `'auto'` resolution
 * (classifyTsconfig / stripJsonComments) and the fail-safe `.js` fallback.
 *
 * Run: npx tsx --test src/test/generate-import-ext.test.ts
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  classifyTsconfig,
  detectTsconfigExtension,
  generateIndex,
  resolveImportExtension,
  stripJsonComments,
} from '../generate.js';
import type { SchemaMetadata } from '../schema.js';

const SCHEMA: SchemaMetadata = {
  tables: {
    users: {
      name: 'users',
      columns: [
        {
          name: 'id',
          field: 'id',
          pgType: 'int8',
          tsType: 'number',
          nullable: false,
          hasDefault: true,
          isArray: false,
          pgArrayType: 'bigint[]',
        },
      ],
      columnMap: { id: 'id' },
      reverseColumnMap: { id: 'id' },
      dateColumns: new Set(),
      pgTypes: { id: 'int8' },
      allColumns: ['id'],
      primaryKey: ['id'],
      uniqueColumns: [],
      relations: {},
      indexes: [],
    },
  },
  enums: {},
};

describe('generateIndex: import extension', () => {
  it("defaults to '.js' for direct callers (byte-stable)", () => {
    const out = generateIndex(SCHEMA);
    assert.match(out, /from '\.\/metadata\.js'/);
    assert.match(out, /from '\.\/types\.js'/);
    assert.match(out, /export \* from '\.\/types\.js';/);
    assert.match(out, /export \{ SCHEMA \} from '\.\/metadata\.js';/);
    // No import-mode comment when generate() did not drive it.
    assert.doesNotMatch(out, /importExtension:/);
  });

  it("emits '.js' with importExt '.js'", () => {
    const out = generateIndex(SCHEMA, { importExt: '.js', importMode: 'js' });
    assert.match(out, /from '\.\/metadata\.js'/);
    assert.match(out, /\/\/ Sibling imports resolved with importExtension: js\./);
  });

  it("emits extensionless specifiers with importExt ''", () => {
    const out = generateIndex(SCHEMA, { importExt: '', importMode: 'none' });
    assert.match(out, /from '\.\/metadata'/);
    assert.match(out, /from '\.\/types'/);
    assert.match(out, /export \* from '\.\/types';/);
    assert.match(out, /export \{ SCHEMA \} from '\.\/metadata';/);
    assert.doesNotMatch(out, /from '\.\/metadata\.js'/);
  });
});

describe('resolveImportExtension', () => {
  it("'js' → .js, 'none' → ''", () => {
    assert.deepEqual(resolveImportExtension('/tmp/x', 'js'), { ext: '.js', mode: 'js' });
    assert.deepEqual(resolveImportExtension('/tmp/x', 'none'), { ext: '', mode: 'none' });
  });

  it("'auto' falls back to .js when no tsconfig is found", () => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-noconfig-'));
    try {
      const r = resolveImportExtension(dir, 'auto');
      assert.equal(r.ext, '.js');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("'auto' resolves nodenext → .js and bundler → '' by walking up to a tsconfig", () => {
    const nodenextDir = mkdtempSync(join(tmpdir(), 'turbine-nn-'));
    const bundlerDir = mkdtempSync(join(tmpdir(), 'turbine-bd-'));
    try {
      writeFileSync(
        join(nodenextDir, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' } }),
      );
      // outDir a level below the tsconfig, walk-up must find it.
      const nested = join(bundlerDir, 'generated', 'turbine');
      mkdirSync(nested, { recursive: true });
      writeFileSync(
        join(bundlerDir, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { module: 'ESNext', moduleResolution: 'bundler' } }),
      );
      assert.equal(resolveImportExtension(nodenextDir, 'auto').ext, '.js');
      assert.equal(resolveImportExtension(nested, 'auto').ext, '');
    } finally {
      rmSync(nodenextDir, { recursive: true, force: true });
      rmSync(bundlerDir, { recursive: true, force: true });
    }
  });
});

describe('detectTsconfigExtension', () => {
  it('returns null when the tsconfig is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-none-'));
    try {
      assert.equal(detectTsconfigExtension(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 'js' for an extends-only config (fields absent → fallback)", () => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-extends-'));
    try {
      writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ extends: './base.json', compilerOptions: {} }));
      // fields absent → null → resolveImportExtension falls back to .js.
      assert.equal(detectTsconfigExtension(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('classifyTsconfig', () => {
  it("maps node16/nodenext (module OR moduleResolution) to 'js'", () => {
    assert.equal(classifyTsconfig('{"compilerOptions":{"module":"nodenext","moduleResolution":"nodenext"}}'), 'js');
    assert.equal(classifyTsconfig('{"compilerOptions":{"module":"node16"}}'), 'js');
    assert.equal(classifyTsconfig('{"compilerOptions":{"moduleResolution":"NodeNext","module":"esnext"}}'), 'js');
  });

  it("maps bundler/node10/esnext (both fields present, neither nodenext) to 'none'", () => {
    assert.equal(classifyTsconfig('{"compilerOptions":{"module":"esnext","moduleResolution":"bundler"}}'), 'none');
    assert.equal(classifyTsconfig('{"compilerOptions":{"module":"commonjs","moduleResolution":"node10"}}'), 'none');
  });

  it('returns null when the module fields are absent (extends-only)', () => {
    assert.equal(classifyTsconfig('{"compilerOptions":{"strict":true}}'), null);
    assert.equal(classifyTsconfig('{"extends":"./base"}'), null);
  });

  it('tolerates comments and trailing commas (JSONC)', () => {
    const jsonc = `{
      // a line comment
      "compilerOptions": {
        /* block */ "module": "NodeNext",
        "moduleResolution": "NodeNext", // trailing
      },
    }`;
    assert.equal(classifyTsconfig(jsonc), 'js');
  });

  it('returns null on unparseable input', () => {
    assert.equal(classifyTsconfig('{ not json'), null);
  });
});

describe('stripJsonComments', () => {
  it('strips line + block comments but preserves string contents', () => {
    const input = '{ "url": "http://x//y", /* c */ "a": 1 // trailing\n }';
    const out = JSON.parse(stripJsonComments(input));
    assert.equal(out.url, 'http://x//y');
    assert.equal(out.a, 1);
  });

  it('removes trailing commas', () => {
    assert.deepEqual(JSON.parse(stripJsonComments('{ "a": [1, 2,], "b": 3, }')), { a: [1, 2], b: 3 });
  });
});
