/**
 * PII tags for introspection-driven tools (Studio, MCP).
 *
 * `introspect.ts` never sets `ColumnMetadata.pii` (the tag is a code-first
 * declaration), so both tools used to run their redaction against a schema that
 * carried no tags at all: the whole apparatus was inert outside `--demo`. These
 * tests pin the loader that closes that gap, against real `generateMetadata`
 * output rather than a hand-written approximation of it.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { applyPiiTags, loadPiiTags, parsePiiTags } from '../cli/pii-tags.js';
import { generateMetadata } from '../generate.js';
import type { SchemaMetadata } from '../schema.js';
import { mockColumn, mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  const users = mockTable('users', [
    { name: 'id', field: 'id' },
    { name: 'name', field: 'name', pgType: 'text' },
    { name: 'email', field: 'email', pgType: 'text' },
    { name: 'phone', field: 'phone', pgType: 'text' },
  ]);
  for (const col of users.columns) {
    if (col.name === 'email' || col.name === 'phone') col.pii = true;
  }
  const posts = mockTable('posts', [
    { name: 'id', field: 'id' },
    { name: 'title', field: 'title', pgType: 'text' },
  ]);
  return { tables: { users, posts }, enums: {} };
}

describe('pii-tags: reading code-first tags out of generated metadata', () => {
  it('parses the tags generateMetadata actually emits', () => {
    const tags = parsePiiTags(generateMetadata(schema(), { noTimestamp: true }));
    assert.deepEqual(tags, { users: ['email', 'phone'] });
  });

  it('an untagged schema yields no tags at all', () => {
    const untagged = schema();
    for (const col of untagged.tables.users!.columns) col.pii = undefined;
    assert.deepEqual(parsePiiTags(generateMetadata(untagged, { noTimestamp: true })), {});
  });

  it('loadPiiTags reads metadata.ts from an out directory, and returns null when there is none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-pii-tags-'));
    try {
      assert.equal(loadPiiTags(dir), null);
      writeFileSync(join(dir, 'metadata.ts'), generateMetadata(schema(), { noTimestamp: true }));
      const source = loadPiiTags(dir);
      assert.ok(source);
      assert.equal(source.count, 2);
      assert.deepEqual(source.tags, { users: ['email', 'phone'] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies tags onto introspected metadata, and only for columns that really exist', () => {
    const live = schema();
    // Introspection never sets pii: start from a clean slate, as it would.
    for (const table of Object.values(live.tables)) {
      for (const col of table.columns) col.pii = undefined;
    }
    const applied = applyPiiTags(live, { users: ['email', 'phone', 'ssn_gone_from_db'], no_such_table: ['x'] });
    assert.equal(applied, 2);
    assert.deepEqual(
      live.tables.users!.columns.filter((c) => c.pii).map((c) => c.name),
      ['email', 'phone'],
    );
    assert.equal(
      live.tables.posts!.columns.some((c) => c.pii),
      false,
    );
  });

  it('a prototype-named table in the tag map cannot reach Object.prototype', () => {
    const live = schema();
    // Object.hasOwn guards the lookup; `constructor` is truthy on a plain object.
    assert.equal(applyPiiTags(live, { constructor: ['id'], __proto__: ['id'] }), 0);
  });

  it('ignores a column line outside a columns: [ ... ] block', () => {
    // Defense against a metadata file whose shape drifts: only real column
    // entries inside the block count, never an incidental match elsewhere.
    const source = [
      'export const SCHEMA: SchemaMetadata = {',
      '  tables: {',
      '    users: {',
      "      name: 'users',",
      '      columns: [',
      "        { name: 'email', field: 'email', pgType: 'text', pii: true },",
      '      ],',
      "      note: { name: 'phone', field: 'phone', pii: true },",
      '    },',
      '  },',
      '};',
    ].join('\n');
    assert.deepEqual(parsePiiTags(source), { users: ['email'] });
  });
});

// Keep the import used: mockColumn documents the column shape the parser reads.
void mockColumn;
