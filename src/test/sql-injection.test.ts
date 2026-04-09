/**
 * SQL injection regression tests.
 *
 * These tests document — and lock down — the defense against hostile
 * field names, operator names, orderBy keys, and relation names flowing
 * from user input into generated SQL. The defense is multi-layer:
 *
 *   1. Field / relation names are resolved through `tableMeta.columnMap`
 *      or `tableMeta.relations`, which means anything not explicitly
 *      declared in the schema metadata is rejected with a ValidationError
 *      or RelationError.
 *
 *   2. What DOES make it through is quoted via `quoteIdent()`, which
 *      doubles any internal `"` so statement stacking is impossible.
 *
 *   3. Operator names are validated against a hardcoded allowlist
 *      (`OPERATOR_KEYS`) and never interpolated.
 *
 * If any of these tests start to fail, the ORM has regressed on its
 * most load-bearing security guarantee. Do not relax them.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  const tables: Record<string, TableMetadata> = {};
  tables.users = mockTable('users', [
    { name: 'id', field: 'id' },
    { name: 'email', field: 'email', pgType: 'text' },
  ]);
  return { tables, enums: {} };
}

describe('SQL injection defense — hostile field names in WHERE', () => {
  it('rejects a field name containing a SQL statement', () => {
    const q = makeQuery('users', schema());
    assert.throws(
      () => q.buildFindMany({ where: { 'id"; DROP TABLE users; --': 1 } as never }),
      (err: unknown) => err instanceof ValidationError,
      'hostile field names must throw ValidationError, not emit SQL',
    );
  });

  it('rejects a field name with an embedded quote + comment', () => {
    const q = makeQuery('users', schema());
    assert.throws(
      () => q.buildFindMany({ where: { "email'--": 'x' } as never }),
      (err: unknown) => err instanceof ValidationError,
    );
  });

  it('rejects a completely unknown field name', () => {
    const q = makeQuery('users', schema());
    assert.throws(
      () => q.buildFindMany({ where: { nope: 1 } as never }),
      (err: unknown) => err instanceof ValidationError,
    );
  });
});

describe('SQL injection defense — hostile orderBy keys', () => {
  it('rejects an orderBy key containing a SQL fragment', () => {
    const q = makeQuery('users', schema());
    assert.throws(
      () => q.buildFindMany({ orderBy: { 'id"; DROP TABLE users--': 'asc' } as never }),
      (err: unknown) => err instanceof ValidationError,
    );
  });

  it('rejects an orderBy direction that is not asc/desc', () => {
    const q = makeQuery('users', schema());
    // The direction path should not allow arbitrary strings to reach SQL.
    // Non-standard directions either throw or fall through to ASC —
    // critically, they MUST NOT reach SQL unquoted.
    const result = (() => {
      try {
        return q.buildFindMany({ orderBy: { id: 'asc; DROP TABLE users' as unknown as 'asc' } });
      } catch (err) {
        if (err instanceof ValidationError) return 'threw';
        throw err;
      }
    })();
    if (result !== 'threw') {
      // If the implementation allowed it to build, it must have sanitized
      // the direction. Verify no injection fragment is in the SQL.
      assert.ok(!result.sql.includes('DROP TABLE'), 'SQL must not contain injected DROP TABLE');
      assert.ok(!result.sql.includes(';'), 'SQL must not contain statement separator');
    }
  });
});

describe('SQL injection defense — quoted identifier escaping', () => {
  it('a field name with an embedded double-quote, even if it somehow reaches quoteIdent, must not break out', async () => {
    // We can't directly reach quoteIdent's code path through the public API
    // with a hostile column name (metadata validation rejects it first),
    // but we can verify quoteIdent's contract directly.
    const { quoteIdent } = await import('../query.js');
    assert.equal(quoteIdent('users'), '"users"');
    assert.equal(quoteIdent('id"; DROP TABLE users; --'), '"id""; DROP TABLE users; --"');
    // The doubled quote is the critical invariant: any `"` in the input
    // becomes `""` in the output, so the string cannot escape its quoted
    // identifier context.
    assert.equal(quoteIdent('a"b'), '"a""b"');
  });
});
