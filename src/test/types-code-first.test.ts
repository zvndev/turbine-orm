/**
 * turbine-orm, code-first column types and defaults reach generated code
 *
 * `defineSchema` is the path that has no database: what a column declares
 * there (a `tsType` for a json column, a `defaultValue`) must come out of
 * `schemaDefToMetadata` and the generators exactly as it would from a live
 * catalog plus `columnTypes`. Covers the object form and the fluent
 * `.tsType()`, the one-line refusal on both sides of the pipeline, the
 * `defaultValue` emitted into metadata.ts, and the CLI's precedence rule when
 * a code-first `tsType` and a config `columnTypes` entry name one column.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generatorColumnTypes } from '../cli/index.js';
import { ValidationError } from '../errors.js';
import { generateMetadata, generateTypes } from '../generate.js';
import { column, defineSchema, table } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';

const SETTINGS_TYPE = '{ theme: string; beta?: boolean }';

function objectFormSchema() {
  return defineSchema({
    accounts: {
      id: { type: 'serial', primaryKey: true },
      settings: { type: 'jsonb', tsType: SETTINGS_TYPE },
      profile: { type: 'jsonb', notNull: true, tsType: '{ bio: string }' },
      role: { type: 'text', notNull: true, default: "'member'" },
      createdAt: { type: 'timestamptz', notNull: true, default: 'now()' },
    },
  });
}

describe('types: a code-first tsType reaches generated types', () => {
  it('the object form types the row, create and update inputs', () => {
    const out = generateTypes(schemaDefToMetadata(objectFormSchema()), { noTimestamp: true });
    // Row: nullable column keeps `| null`, a NOT NULL one does not.
    assert.match(out, /\n {2}settings: \{ theme: string; beta\?: boolean \} \| null;/);
    assert.match(out, /\n {2}profile: \{ bio: string \};/);
    // Create: optional for the nullable column, required for the NOT NULL one.
    assert.match(out, /settings\?: \{ theme: string; beta\?: boolean \} \| null/);
    assert.match(out, /\n {2}profile: \{ bio: string \};[\s\S]*\n {2}profile\?: \{ bio: string \}/);
    // Nothing fell back to the unannotated json type.
    assert.doesNotMatch(out, /settings\??: unknown/);
  });

  it('the fluent .tsType() matches the object form', () => {
    const def = defineSchema({
      accounts: table({
        id: column.serial().primaryKey(),
        settings: column.jsonb().tsType(SETTINGS_TYPE),
      }),
    });
    const out = generateTypes(schemaDefToMetadata(def), { noTimestamp: true });
    assert.match(out, /\n {2}settings: \{ theme: string; beta\?: boolean \} \| null;/);
  });

  it('a column without tsType keeps the mapped type', () => {
    const def = defineSchema({ accounts: { id: { type: 'serial', primaryKey: true }, data: { type: 'jsonb' } } });
    const out = generateTypes(schemaDefToMetadata(def), { noTimestamp: true });
    assert.match(out, /\n {2}data: unknown \| null;/);
  });

  it('refuses a tsType that is not one line, in both declaration forms', () => {
    assert.throws(
      () =>
        defineSchema({
          a: { id: { type: 'serial', primaryKey: true }, x: { type: 'jsonb', tsType: 'A\nexport const y = 1' } },
        }),
      /Invalid column "tsType"/,
    );
    assert.throws(() => column.jsonb().tsType('A B'), /Invalid column "tsType"/);
    assert.throws(() => column.jsonb().tsType('   '), /Invalid column "tsType"/);
  });

  it('the generator refuses hand-built metadata whose tsType breaks the line', () => {
    const meta = schemaDefToMetadata(objectFormSchema());
    const accounts = meta.tables.accounts;
    assert.ok(accounts, 'fixture table missing');
    const col = accounts.columns.find((c) => c.name === 'settings');
    assert.ok(col, 'fixture column missing');
    col.tsType = '{ a: 1 }\nexport const pwned = 1;';
    assert.throws(
      () => generateTypes(meta, { noTimestamp: true }),
      (err: unknown) => err instanceof ValidationError && /column "settings"/.test(err.message),
    );
  });
});

describe('types: a PII column documents the one way to read it', () => {
  it('the row field is optional and its note names includePii: UNSAFE, not select', () => {
    const def = defineSchema({
      accounts: { id: { type: 'serial', primaryKey: true }, email: { type: 'text', notNull: true, pii: true } },
    });
    const out = generateTypes(schemaDefToMetadata(def), { noTimestamp: true });
    // `select` alone never returns a PII column, and a write never does, so the
    // generated doc must not suggest selecting it.
    assert.match(out, /\(PII: absent unless the read passes includePii: UNSAFE\) \*\/\n {2}email\?: string;/);
    assert.doesNotMatch(out, /unless selected/);
  });
});

describe('types: code-first defaults reach generated metadata', () => {
  it('schemaDefToMetadata records defaultValue and metadata.ts emits it', () => {
    const meta = schemaDefToMetadata(objectFormSchema());
    const cols = meta.tables.accounts?.columns ?? [];
    assert.equal(cols.find((c) => c.name === 'role')?.defaultValue, "'member'");
    assert.equal(cols.find((c) => c.name === 'created_at')?.defaultValue, 'now()');
    assert.equal(cols.find((c) => c.name === 'settings')?.defaultValue, undefined);

    const out = generateMetadata(meta, { noTimestamp: true });
    assert.match(out, /defaultValue: "'member'"/);
    assert.match(out, /defaultValue: "now\(\)"/);
  });
});

describe('types: generatorColumnTypes merges code-first and config types', () => {
  const schema = { tables: { accounts: {}, posts: {} } } as never;
  const noFilters = { include: [] as string[], exclude: [] as string[] };

  it('config columnTypes wins over a code-first tsType on the same column', () => {
    const merged = generatorColumnTypes(
      { columnTypes: { 'accounts.settings': '{ a: 1 }', 'posts.meta': '{ m: 1 }' } },
      { ...noFilters, columnTypes: { 'accounts.settings': '{ b: 2 }' } },
      schema,
    );
    assert.deepEqual(merged, { 'accounts.settings': '{ b: 2 }', 'posts.meta': '{ m: 1 }' });
  });

  it('drops a config key whose table the include/exclude filters left out, keeps an unknown one', () => {
    const merged = generatorColumnTypes(
      null,
      { include: [], exclude: ['audit_log'], columnTypes: { 'audit_log.data': 'X', 'missing.data': 'Y' } },
      schema,
    );
    // `missing` is not filtered out, so it reaches the generator, which names it.
    assert.deepEqual(merged, { 'missing.data': 'Y' });
  });

  it('returns undefined when there is nothing to pass', () => {
    assert.equal(generatorColumnTypes(null, noFilters, schema), undefined);
  });
});
