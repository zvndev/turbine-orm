/**
 * One conflict statement only for a `where` that is exactly one unique key.
 *
 * `upsert({ where: { id, note }, create: { id, note, ... } })` with `note` an
 * ordinary column took the single-statement path because every `where` key
 * was pinned to `create`, and so sent `ON CONFLICT ("id", "note")`: PostgreSQL
 * answers 42P10 and SQLite rejects it whatever the data, and MySQL's
 * `ON DUPLICATE KEY UPDATE`, which has no conflict target, updated the `id` row
 * whatever its `note`. The shared rule (`upsertWhereMatchesCreate`, which
 * `upsertLookupReason` and PowDB both read) now also requires `where`'s columns
 * to be exactly one unique key; anything else looks the row up by the whole
 * `where`, and the deferred form refuses rather than becoming two statements.
 * Native behaviour: upsert-where-lookup.integration (PostgreSQL) and the
 * cross-engine battery (SQLite, MySQL, SQL Server).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { postgresDialect } from '../dialect.js';
import { ValidationError } from '../errors.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import { upsertWhereIsOneKey, upsertWhereMatchesCreate } from '../query/compound-unique.js';
import type { SchemaMetadata } from '../schema.js';
import { sqliteDialect } from '../sqlite.js';
import { makeQuery, mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  const accounts = mockTable(
    'accounts',
    [
      { name: 'id', field: 'id', pgType: 'int4' },
      { name: 'email', field: 'email', pgType: 'text', unique: true },
      { name: 'tenant', field: 'tenant', pgType: 'text' },
      { name: 'handle', field: 'handle', pgType: 'text' },
      { name: 'note', field: 'note', pgType: 'text' },
    ],
    {},
  );
  accounts.uniqueColumns.push(['tenant', 'handle']);
  return { enums: {}, tables: { accounts } };
}

const meta = schema().tables.accounts!;
const row = { id: 1, email: 'a@x.test', tenant: 't', handle: 'h', note: 'n' };

describe('the shared rule', () => {
  const statement: [string, Record<string, unknown>][] = [
    ['the primary key', { id: 1 }],
    ['a unique column', { email: 'a@x.test' }],
    ['a compound unique key, flat', { tenant: 't', handle: 'h' }],
    ['a compound unique key, by selector', { tenant_handle: { tenant: 't', handle: 'h' } }],
    ['a key beside an undefined column', { id: 1, note: undefined }],
  ];
  for (const [label, where] of statement) {
    it(`one statement for ${label}`, () => {
      assert.equal(upsertWhereIsOneKey(meta, where), true);
      assert.equal(upsertWhereMatchesCreate(meta, where, row), true);
    });
  }

  const lookup: [string, Record<string, unknown>][] = [
    ['a key beside an ordinary column', { id: 1, note: 'n' }],
    ['two separate unique keys', { id: 1, email: 'a@x.test' }],
    ['a compound key beside an ordinary column', { tenant: 't', handle: 'h', note: 'n' }],
    ['a unique column beside part of a compound key', { email: 'a@x.test', tenant: 't' }],
  ];
  for (const [label, where] of lookup) {
    it(`a lookup for ${label}, every key pinned`, () => {
      assert.equal(upsertWhereIsOneKey(meta, where), false);
      assert.equal(upsertWhereMatchesCreate(meta, where, row), false);
    });
  }
});

describe('every SQL engine looks it up, and the deferred form refuses', () => {
  const args = { where: { id: 1, note: 'n' }, create: row, update: { tenant: 'u' } };
  for (const dialect of [postgresDialect, sqliteDialect, mysqlDialect, mssqlDialect]) {
    it(dialect.name, () => {
      const q = makeQuery('accounts', schema(), { dialect });
      assert.equal(q.upsertNeedsLookup(args as never), true);
      assert.throws(
        () => q.buildUpsert(args as never),
        (err: unknown) =>
          err instanceof ValidationError &&
          /`where` \(id, note\) is not exactly one unique key/.test(err.message) &&
          /Call `upsert\(\)` unbatched/.test(err.message),
      );
      // Exactly one key keeps its single statement.
      const one = { where: { id: 1 }, create: row, update: { tenant: 'u' } };
      assert.equal(q.upsertNeedsLookup(one as never), dialect === mysqlDialect);
    });
  }

  it('a where that differs from create keeps its own refusal sentence', () => {
    assert.throws(
      () =>
        makeQuery('accounts', schema()).buildUpsert({ where: { id: 2 }, create: row, update: { note: 'u' } } as never),
      (err: unknown) => err instanceof ValidationError && /does not carry `create`'s values/.test(err.message),
    );
  });
});
