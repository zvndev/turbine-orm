/**
 * turbine-orm — Empty-where mutation guard tests
 *
 * Every mutation (`update`, `updateMany`, `delete`, `deleteMany`) must refuse
 * an empty predicate by default, throwing `ValidationError`. The guard only
 * lets the mutation through when the caller explicitly opts in with
 * `allowFullTableScan: true`.
 *
 * Build-only tests (no DB).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

// ---------------------------------------------------------------------------
// Build-only test harness (no DB needed)
// ---------------------------------------------------------------------------

function buildSchema(): SchemaMetadata {
  const tables: Record<string, TableMetadata> = {};
  tables.users = mockTable('users', [
    { name: 'id', field: 'id' },
    { name: 'name', field: 'name', pgType: 'text' },
    { name: 'active', field: 'active', pgType: 'bool' },
  ]);
  return { tables, enums: {} };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mutation guard: empty where refused', () => {
  it('buildUpdate throws ValidationError on where: {}', () => {
    const q = makeQuery('users', buildSchema());
    assert.throws(
      () => q.buildUpdate({ where: {}, data: { name: 'x' } }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError, 'should be ValidationError');
        assert.match((err as Error).message, /update/);
        assert.match((err as Error).message, /empty/);
        assert.match((err as Error).message, /allowFullTableScan/);
        return true;
      },
    );
  });

  it('buildDelete throws ValidationError on where: {}', () => {
    const q = makeQuery('users', buildSchema());
    assert.throws(
      () => q.buildDelete({ where: {} }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match((err as Error).message, /delete/);
        return true;
      },
    );
  });

  it('buildUpdateMany throws ValidationError on where: {}', () => {
    const q = makeQuery('users', buildSchema());
    assert.throws(
      () => q.buildUpdateMany({ where: {}, data: { name: 'x' } }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match((err as Error).message, /updateMany/);
        return true;
      },
    );
  });

  it('buildDeleteMany throws ValidationError on where: {}', () => {
    const q = makeQuery('users', buildSchema());
    assert.throws(
      () => q.buildDeleteMany({ where: {} }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match((err as Error).message, /deleteMany/);
        return true;
      },
    );
  });

  it('buildUpdate throws when all where values are undefined', () => {
    const q = makeQuery('users', buildSchema());
    assert.throws(
      () => q.buildUpdate({ where: { id: undefined, name: undefined }, data: { name: 'x' } }),
      ValidationError,
    );
  });

  it('buildDelete throws when all where values are undefined', () => {
    const q = makeQuery('users', buildSchema());
    assert.throws(() => q.buildDelete({ where: { id: undefined } }), ValidationError);
  });

  it('error message mentions the table name', () => {
    const q = makeQuery('users', buildSchema());
    try {
      q.buildUpdate({ where: {}, data: { name: 'x' } });
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof ValidationError);
      assert.match(err.message, /"users"/);
    }
  });
});

describe('mutation guard: allowFullTableScan opt-in', () => {
  it('buildUpdate accepts where: {} when allowFullTableScan: true', () => {
    const q = makeQuery('users', buildSchema());
    const deferred = q.buildUpdate({
      where: {},
      data: { name: 'x' },
      allowFullTableScan: true,
    });
    // Should produce an UPDATE with no WHERE clause
    assert.match(deferred.sql, /^UPDATE "users" SET "name" = \$1 RETURNING \*$/);
    assert.deepEqual(deferred.params, ['x']);
  });

  it('buildDelete accepts where: {} when allowFullTableScan: true', () => {
    const q = makeQuery('users', buildSchema());
    const deferred = q.buildDelete({ where: {}, allowFullTableScan: true });
    assert.match(deferred.sql, /^DELETE FROM "users" RETURNING \*$/);
    assert.deepEqual(deferred.params, []);
  });

  it('buildUpdateMany accepts where: {} when allowFullTableScan: true', () => {
    const q = makeQuery('users', buildSchema());
    const deferred = q.buildUpdateMany({
      where: {},
      data: { active: false },
      allowFullTableScan: true,
    });
    assert.match(deferred.sql, /^UPDATE "users" SET "active" = \$1$/);
    assert.ok(!/WHERE/.test(deferred.sql));
    assert.ok(!/RETURNING/.test(deferred.sql));
  });

  it('buildDeleteMany accepts where: {} when allowFullTableScan: true', () => {
    const q = makeQuery('users', buildSchema());
    const deferred = q.buildDeleteMany({ where: {}, allowFullTableScan: true });
    assert.match(deferred.sql, /^DELETE FROM "users"$/);
    assert.deepEqual(deferred.params, []);
  });

  it('allowFullTableScan: false is the same as omitted (still throws)', () => {
    const q = makeQuery('users', buildSchema());
    assert.throws(() => q.buildUpdate({ where: {}, data: { name: 'x' }, allowFullTableScan: false }), ValidationError);
  });
});

describe('mutation guard: non-empty where still works', () => {
  it('buildUpdate with where: { id: 5 } produces WHERE clause', () => {
    const q = makeQuery('users', buildSchema());
    const deferred = q.buildUpdate({ where: { id: 5 }, data: { name: 'x' } });
    assert.match(deferred.sql, /UPDATE "users" SET "name" = \$1 WHERE "id" = \$2 RETURNING \*/);
    assert.deepEqual(deferred.params, ['x', 5]);
  });

  it('buildDelete with where: { id: 5 } produces WHERE clause', () => {
    const q = makeQuery('users', buildSchema());
    const deferred = q.buildDelete({ where: { id: 5 } });
    assert.match(deferred.sql, /DELETE FROM "users" WHERE "id" = \$1 RETURNING \*/);
    assert.deepEqual(deferred.params, [5]);
  });

  it('buildUpdate with one defined + one undefined filter still works', () => {
    const q = makeQuery('users', buildSchema());
    const deferred = q.buildUpdate({
      where: { id: 5, name: undefined },
      data: { active: true },
    });
    assert.match(deferred.sql, /WHERE "id" = \$2/);
    assert.deepEqual(deferred.params, [true, 5]);
  });
});

// ---------------------------------------------------------------------------
// Hardening: OR / AND combinators that contain ONLY undefined sub-conditions
// must trigger the same empty-where guard. Otherwise a caller doing
//   db.users.update({ where: { OR: [{ id: maybeNull }, { email: maybeNull }] }, data: {...} })
// could silently emit an unconditional UPDATE when both inputs are undefined.
// ---------------------------------------------------------------------------

describe('mutation guard: OR/AND all-undefined hardening', () => {
  it('buildUpdate refuses OR with all-undefined sub-conditions', () => {
    const q = makeQuery('users', buildSchema());
    assert.throws(
      () =>
        q.buildUpdate({
          where: { OR: [{ id: undefined }, { email: undefined }] },
          data: { name: 'x' },
        }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError, 'should be ValidationError');
        assert.match((err as Error).message, /update/);
        assert.match((err as Error).message, /empty/);
        return true;
      },
    );
  });

  it('buildDelete refuses OR with all-undefined sub-conditions', () => {
    const q = makeQuery('users', buildSchema());
    assert.throws(
      () =>
        q.buildDelete({
          where: { OR: [{ id: undefined }, { name: undefined }] },
        }),
      ValidationError,
    );
  });

  it('buildUpdate refuses AND with all-undefined sub-conditions', () => {
    const q = makeQuery('users', buildSchema());
    assert.throws(
      () =>
        q.buildUpdate({
          where: { AND: [{ id: undefined }, { email: undefined }] },
          data: { name: 'x' },
        }),
      ValidationError,
    );
  });

  it('buildDelete refuses AND with all-undefined sub-conditions', () => {
    const q = makeQuery('users', buildSchema());
    assert.throws(
      () =>
        q.buildDelete({
          where: { AND: [{ id: undefined }, { name: undefined }] },
        }),
      ValidationError,
    );
  });

  it('buildUpdateMany refuses OR with all-undefined sub-conditions', () => {
    const q = makeQuery('users', buildSchema());
    assert.throws(
      () =>
        q.buildUpdateMany({
          where: { OR: [{ id: undefined }, { name: undefined }] },
          data: { active: false },
        }),
      ValidationError,
    );
  });

  it('buildDeleteMany refuses AND with all-undefined sub-conditions', () => {
    const q = makeQuery('users', buildSchema());
    assert.throws(
      () =>
        q.buildDeleteMany({
          where: { AND: [{ id: undefined }, { name: undefined }] },
        }),
      ValidationError,
    );
  });

  it('OR with empty array (no sub-conditions at all) is also refused', () => {
    const q = makeQuery('users', buildSchema());
    assert.throws(() => q.buildUpdate({ where: { OR: [] }, data: { name: 'x' } }), ValidationError);
  });

  it('AND with empty array (no sub-conditions at all) is also refused', () => {
    const q = makeQuery('users', buildSchema());
    assert.throws(() => q.buildDelete({ where: { AND: [] } }), ValidationError);
  });

  it('mixed OR (all-undefined) + top-level undefined keys still refused', () => {
    const q = makeQuery('users', buildSchema());
    assert.throws(
      () =>
        q.buildUpdate({
          where: {
            id: undefined,
            OR: [{ name: undefined }, { email: undefined }],
          },
          data: { name: 'x' },
        }),
      ValidationError,
    );
  });

  it('OR with at least one defined sub-condition still works (regression guard)', () => {
    // Sanity check — make sure the hardening above didn't over-fire on the
    // legitimate case where one OR branch resolves to a real predicate.
    const q = makeQuery('users', buildSchema());
    const deferred = q.buildUpdate({
      where: { OR: [{ id: 5 }, { name: undefined }] },
      data: { name: 'x' },
    });
    assert.match(deferred.sql, /WHERE/);
    assert.match(deferred.sql, /"id" = \$2/);
  });

  it('allowFullTableScan: true bypasses the OR/AND hardening too', () => {
    // Belt-and-braces: a caller who explicitly opts in must still be able to
    // run an unconditional mutation even when the OR/AND happens to be empty.
    const q = makeQuery('users', buildSchema());
    const deferred = q.buildUpdate({
      where: { OR: [{ id: undefined }] },
      data: { name: 'x' },
      allowFullTableScan: true,
    });
    assert.match(deferred.sql, /^UPDATE "users" SET "name" = \$1 RETURNING \*$/);
    assert.deepEqual(deferred.params, ['x']);
  });
});
