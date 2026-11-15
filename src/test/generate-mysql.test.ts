import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { generate, generateIndex, generateMetadata, generateTypes } from '../generate.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';

const mysqlSchema = schemaDefToMetadata(
  defineSchema({
    users: {
      id: { type: 'serial', primaryKey: true },
      email: { type: 'text', notNull: true, unique: true },
      settings: { type: 'jsonb' },
    },
    posts: {
      id: { type: 'serial', primaryKey: true },
      userId: { type: 'integer', notNull: true, references: 'users.id' },
      title: { type: 'text', notNull: true },
    },
  }),
);
const options = { noTimestamp: true, target: 'mysql' } as const;

describe('MySQL generated factory', () => {
  it('binds the existing async factory, typed native options and original target union', () => {
    const output = generateIndex(mysqlSchema, options);
    assert.match(output, /import \{ turbineMysql \} from 'turbine-orm\/mysql'/);
    assert.match(output, /export async function turbine\(/);
    assert.match(output, /target: Parameters<typeof turbineMysql>\[0\]/);
    assert.match(output, /Promise<TurbineClient>/);
    assert.match(output, /await turbineMysql\(target, SCHEMA, options/);
    assert.doesNotMatch(output, /new BaseTurbineClient|new TurbineClient|turbineSqlite/);
    assert.match(output, /TypedTurbineMysqlOptions/);
    for (const ext of ['', '.ts', '.js']) {
      const emitted = generateIndex(mysqlSchema, { ...options, importExt: ext });
      assert.ok(emitted.includes(`from './metadata${ext}'`));
      assert.ok(emitted.includes(`from './types${ext}'`));
    }
    assert.equal(generateTypes(mysqlSchema, options), generateTypes(mysqlSchema, { noTimestamp: true }));
    assert.equal(generateMetadata(mysqlSchema, options), generateMetadata(mysqlSchema, { noTimestamp: true }));
    assert.doesNotThrow(() => generateIndex({ tables: {}, enums: {} }, options));
  });

  it('writes deterministic files and honors raw column names, overrides and zod', () => {
    const dir = mkdtempSync(join(process.cwd(), '.mysql-generated-'));
    try {
      const args = {
        ...options,
        schema: mysqlSchema,
        outDir: dir,
        keepColumnNames: true,
        columnTypes: { 'users.settings': '{ theme: string }' },
        importExtension: 'none',
        zod: true,
      } as const;
      const result = generate(args);
      assert.deepEqual(result.files, ['types.ts', 'metadata.ts', 'index.ts', 'zod.ts']);
      const before = result.files.map((file) => readFileSync(join(dir, file), 'utf8'));
      assert.ok(before.every((file) => file.length > 100));
      assert.match(before[0]!, /settings: \{ theme: string \}/);
      assert.match(before[0]!, /user_id: number/);
      assert.match(before[2]!, /from '\.\/metadata'/);
      generate(args);
      assert.deepEqual(
        result.files.map((file) => readFileSync(join(dir, file), 'utf8')),
        before,
      );
      assert.throws(() => generate({ ...args, columnTypes: { 'users.missing': 'string' } }), /columnTypes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the SQLite factory emitter pinned', () => {
    // Canonical intrinsic dictionary spelling for the same cross-target fixture.
    const fixture = schemaDefToMetadata(
      defineSchema({
        users: { id: { type: 'serial', primaryKey: true }, email: { type: 'text', notNull: true, unique: true } },
        posts: {
          id: { type: 'serial', primaryKey: true },
          userId: { type: 'integer', notNull: true, references: 'users.id' },
          title: { type: 'text', notNull: true },
        },
      }),
    );
    const output = generateIndex(fixture, { target: 'sqlite', noTimestamp: true });
    assert.equal(
      createHash('sha256').update(output).digest('hex'),
      '6df730ab3feb9967c671de0ebeb153d33e432f27948994381c848dd997c91bd8',
    );
  });
});
