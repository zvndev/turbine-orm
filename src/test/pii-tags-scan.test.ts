/**
 * `scanPiiTags`: the structural scan that replaced the line-anchored regexes.
 *
 * The regexes required exactly 8 leading spaces, single-quoted keys, and the
 * whole column object on ONE line. Real emitted column objects are longer than
 * this repo's own Biome `lineWidth`, so a formatter run over a user's generated
 * directory rewrapped them and every tag vanished, with the tools still
 * reporting `redactedColumns: []`. These tests pin BOTH halves of the fix: the
 * scan survives reformatting, and it reports failure when it truly cannot read
 * a file, so callers can fail closed instead of inferring "no PII here".
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scanPiiTags } from '../cli/pii-tags.js';
import { generateMetadata } from '../generate.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  const users = mockTable('users', [
    { name: 'id', field: 'id' },
    { name: 'email', field: 'email', pgType: 'text' },
    { name: 'phone', field: 'phone', pgType: 'text' },
  ]);
  for (const column of users.columns) {
    if (column.name === 'email' || column.name === 'phone') column.pii = true;
  }
  return { tables: { users }, enums: {} };
}

describe('scanPiiTags: survives formatting the old regex scan required', () => {
  it('reads the tags generateMetadata emits verbatim', () => {
    const scan = scanPiiTags(generateMetadata(schema(), { noTimestamp: true }));
    assert.equal(scan.ok, true);
    assert.deepEqual(scan.tags, { users: ['email', 'phone'] });
  });

  it('reads them after a formatter rewraps each column onto several lines', () => {
    // Exactly the shape Biome produces once a column object passes lineWidth.
    const source = `
      export const SCHEMA: SchemaMetadata = {
        tables: {
          users: {
            name: 'users',
            columns: [
              {
                name: 'email',
                field: 'email',
                pgType: 'text',
                pii: true,
              },
              { name: 'id', field: 'id', pgType: 'int4' },
            ],
          },
        },
      };`;
    const scan = scanPiiTags(source);
    assert.equal(scan.ok, true);
    assert.deepEqual(scan.tags, { users: ['email'] });
  });

  it('reads them with double-quoted keys and values, and when minified onto one line', () => {
    const source =
      'export const SCHEMA = { tables: { users: { columns: [{ "name": "email", "pii": true }, ' +
      '{ "name": "id" }] } } };';
    assert.deepEqual(scanPiiTags(source).tags, { users: ['email'] });
  });

  it('skips comments rather than reading structure out of them', () => {
    const source = `
      export const SCHEMA = {
        tables: {
          /* columns: [{ name: 'ssn', pii: true }] */
          users: {
            // { name: 'fake', pii: true }
            columns: [{ name: 'email', pii: true }],
          },
        },
      };`;
    assert.deepEqual(scanPiiTags(source).tags, { users: ['email'] });
  });

  it('is not desynchronized by braces or quotes inside a string value', () => {
    // Index definitions and generation expressions carry raw SQL. Treating that
    // text as structure would unbalance the brace depth and silently drop every
    // table after it.
    const source = `
      export const SCHEMA = {
        tables: {
          users: {
            columns: [
              { name: 'label', generationExpression: 'fmt(a, "{b}") || \\'}\\'' },
              { name: 'email', pii: true },
            ],
            indexes: [{ name: 'i', columns: ['email'], definition: "CREATE INDEX i ON u (lower(email))" }],
          },
          posts: {
            columns: [{ name: 'ip', pii: true }],
          },
        },
      };`;
    assert.deepEqual(scanPiiTags(source).tags, { users: ['email'], posts: ['ip'] });
  });

  it('does not mistake the columns list of an index entry for table columns', () => {
    const source = `
      export const SCHEMA = {
        tables: {
          users: {
            columns: [{ name: 'id' }],
            indexes: [{ name: 'i', columns: [{ name: 'email', pii: true }] }],
          },
        },
      };`;
    // The index list nests under `indexes`, not directly under a table, so the
    // tail check rejects it: only `tables -> <table> -> columns -> {}` counts.
    assert.deepEqual(scanPiiTags(source).tags, {});
  });
});

describe('scanPiiTags: an unreadable file is reported, not reported as clean', () => {
  it('flags a file that is not generated metadata at all', () => {
    const scan = scanPiiTags('export const SCHEMA = "definitely not metadata";');
    assert.equal(scan.ok, false);
    assert.match(scan.reason ?? '', /tables/);
    assert.deepEqual(scan.tags, {});
  });

  it('flags a tables map that yields no parsable column objects', () => {
    const scan = scanPiiTags('export const SCHEMA = { tables: { users: { name: "users" } } };');
    assert.equal(scan.ok, false);
    assert.equal(scan.columnsSeen, 0);
    assert.match(scan.reason ?? '', /no parsable column objects/);
  });

  it('reports a genuinely untagged schema as OK with no tags', () => {
    // The distinction the callers depend on: this is "checked, nothing tagged",
    // which must never look like the failures above.
    const untagged = schema();
    for (const column of untagged.tables.users!.columns) column.pii = undefined;
    const scan = scanPiiTags(generateMetadata(untagged, { noTimestamp: true }));
    assert.equal(scan.ok, true);
    assert.deepEqual(scan.tags, {});
    assert.equal(scan.tablesSeen, 1);
    assert.equal(scan.columnsSeen, 3);
  });
});
