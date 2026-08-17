/**
 * Global filters (soft-delete / multi-tenancy) and optimistic locking on PowDB.
 *
 * Both were accepted and silently ignored before 0.74.0, and both are the kind
 * of "ignored" that does not look like a bug from the caller's side:
 *
 *   - A client configured with `globalFilters` applied its tenant predicate on
 *     every SQL engine and NONE on PowDB. The same application code returned
 *     one tenant's rows on Postgres and every tenant's rows on PowDB, with no
 *     error anywhere. `skipGlobalFilters` was equally inert, so the opt-OUT
 *     appeared to work too.
 *   - `optimisticLock` was dropped, so the version check never happened: the
 *     update applied unconditionally and a concurrent writer's change was
 *     overwritten by a caller who believed they had held the lock.
 *
 * The rule itself is shared with the SQL engines (`resolveGlobalFilterFrom`),
 * not restated here. What this file pins is PowDB's side of the contract, and
 * in particular the ORDERING property that a shared rule cannot express: the
 * empty-`where` guard must see the USER predicate alone, because a configured
 * global filter would otherwise satisfy it and quietly turn a refused mass
 * mutation into an accepted one.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OptimisticLockError, ValidationError } from '../errors.js';
import { capabilitiesFromVersion, type PowdbPool } from '../powdb.js';
import { PowqlInterface } from '../powql.js';
import { UNSAFE } from '../query/index.js';
import type { ColumnMetadata, SchemaMetadata, TableMetadata } from '../schema.js';

function col(name: string, field: string, tsType = 'string', pgType = 'text'): ColumnMetadata {
  return { name, field, pgType, tsType, nullable: false, hasDefault: name === 'id', isArray: false, pgArrayType: '' };
}

function table(name: string, columns: ColumnMetadata[]): TableMetadata {
  const columnMap: Record<string, string> = {};
  const reverseColumnMap: Record<string, string> = {};
  for (const c of columns) {
    columnMap[c.field] = c.name;
    reverseColumnMap[c.name] = c.field;
  }
  return {
    name,
    columns,
    columnMap,
    reverseColumnMap,
    dateColumns: new Set(),
    dialectTypes: Object.fromEntries(columns.map((c) => [c.name, c.pgType])),
    pgTypes: Object.fromEntries(columns.map((c) => [c.name, c.pgType])),
    allColumns: columns.map((c) => c.name),
    primaryKey: ['id'],
    uniqueColumns: [['id']],
    relations: {},
    indexes: [],
  };
}

const schema: SchemaMetadata = {
  enums: {},
  tables: {
    app_user: table('app_user', [
      col('id', 'id'),
      col('name', 'name'),
      col('tenant_id', 'tenantId'),
      col('deleted_at', 'deletedAt'),
      col('version', 'version', 'number', 'int4'),
    ]),
  },
};

function rec(rows: Record<string, unknown>[] = [{ id: '1', name: 'Ada', tenant_id: 't1', version: 1 }]) {
  const calls: { powql: string; params: unknown[] }[] = [];
  const pool = {
    capabilities: capabilitiesFromVersion('0.18.0'),
    retryStaleReads: false,
    readonly: false,
    query(powql: string, params: unknown[]) {
      calls.push({ powql, params });
      return Promise.resolve({ rows, rowCount: rows.length });
    },
  } as unknown as PowdbPool;
  return { pool, calls, first: () => calls[0]! };
}

// biome-ignore lint/suspicious/noExplicitAny: the matrix drives many arg shapes
type AnyArgs = any;

function qi(pool: PowdbPool, filters?: Record<string, unknown>) {
  return new PowqlInterface<Record<string, unknown>>(pool, 'app_user', schema, [], {
    warnOnUnlimited: false,
    ...(filters ? { globalFilters: filters as never } : {}),
  });
}

const TENANT = { app_user: { tenantId: 't1' } };

describe('powdb global filters', () => {
  it('a configured filter reaches the emitted PowQL on a plain read', async () => {
    const r = rec();
    await qi(r.pool, TENANT).findMany({});
    assert.match(r.first().powql, /filter .*tenant_id/);
    assert.deepEqual(r.first().params, ['t1']);
  });

  it('AND-merges with the user where rather than replacing it', async () => {
    const r = rec();
    await qi(r.pool, TENANT).findMany({ where: { name: 'Ada' } } as AnyArgs);
    const { powql, params } = r.first();
    assert.match(powql, /name/);
    assert.match(powql, /tenant_id/);
    assert.match(powql, / and /);
    assert.deepEqual(params, ['Ada', 't1']);
  });

  it('applies to every operation, not only findMany', async () => {
    // One per operation because each compiles its own filter at its own call
    // site; a filter wired into some of them is the bug in a smaller form.
    const ops: [string, AnyArgs][] = [
      ['findMany', {}],
      ['findFirst', {}],
      ['count', {}],
      ['aggregate', { _count: { id: true } }],
      ['groupBy', { by: ['name'], _count: { id: true } }],
      ['updateMany', { where: { name: 'a' }, data: { name: 'b' } }],
      ['deleteMany', { where: { name: 'a' } }],
      ['update', { where: { id: '1' }, data: { name: 'b' } }],
      ['delete', { where: { id: '1' } }],
    ];
    for (const [op, args] of ops) {
      const r = rec();
      const iface = qi(r.pool, TENANT) as unknown as Record<string, (a: AnyArgs) => Promise<unknown>>;
      await iface[op]!(args);
      assert.ok(
        r.calls.some((c) => /filter[^{]*tenant_id/.test(c.powql)),
        `${op} emitted no global filter: ${r.calls.map((c) => c.powql).join(' | ')}`,
      );
    }
  });

  it('skipGlobalFilters: UNSAFE opts out', async () => {
    const r = rec();
    await qi(r.pool, TENANT).findMany({ skipGlobalFilters: UNSAFE } as AnyArgs);
    // Assert on the FILTER clause, not on the string: `tenant_id` is also a
    // projected column, so a bare /tenant_id/ matches the column list and would
    // fail on a correct opt-out (it did, when this test was first written).
    assert.doesNotMatch(r.first().powql, /\bfilter\b/);
  });

  it('the per-table array form opts out of exactly that table', async () => {
    const r = rec();
    await qi(r.pool, TENANT).findMany({ skipGlobalFilters: [UNSAFE, 'app_user'] } as AnyArgs);
    assert.doesNotMatch(r.first().powql, /\bfilter\b/);
  });

  it('a function filter is evaluated per build, so per-request tenancy works', async () => {
    let current = 't1';
    const filters = { app_user: () => ({ tenantId: current }) };
    const a = rec();
    await qi(a.pool, filters).findMany({});
    assert.deepEqual(a.first().params, ['t1']);
    current = 't2';
    const b = rec();
    await qi(b.pool, filters).findMany({});
    assert.deepEqual(b.first().params, ['t2']);
  });

  it('an all-undefined filter contributes nothing', async () => {
    const r = rec();
    await qi(r.pool, { app_user: { tenantId: undefined } }).findMany({});
    assert.doesNotMatch(r.first().powql, /filter/);
  });

  it('a table with no configured filter is untouched', async () => {
    const r = rec();
    await qi(r.pool, { other_table: { tenantId: 't1' } }).findMany({});
    assert.doesNotMatch(r.first().powql, /filter/);
  });

  it('emits byte-identical PowQL to the unconfigured client when no filter applies', async () => {
    const a = rec();
    await qi(a.pool).findMany({ where: { name: 'Ada' } } as AnyArgs);
    const b = rec();
    await qi(b.pool, { other_table: { tenantId: 't1' } }).findMany({ where: { name: 'Ada' } } as AnyArgs);
    assert.equal(b.first().powql, a.first().powql);
    assert.deepEqual(b.first().params, a.first().params);
  });

  // THE ordering property. A global filter must never satisfy the guard.
  it('does NOT let a configured filter satisfy the empty-where guard', async () => {
    for (const op of ['updateMany', 'deleteMany']) {
      const r = rec();
      const iface = qi(r.pool, TENANT) as unknown as Record<string, (a: AnyArgs) => Promise<unknown>>;
      await assert.rejects(
        () => iface[op]!(op === 'updateMany' ? { where: {}, data: { name: 'x' } } : { where: {} }),
        ValidationError,
        `${op} with an empty user where must still be refused when a global filter is configured`,
      );
    }
  });

  it('still allows the explicit opt-in past the guard, with the filter applied', async () => {
    const r = rec();
    await qi(r.pool, TENANT).deleteMany({ where: {}, allowFullTableScan: UNSAFE } as AnyArgs);
    assert.match(r.first().powql, /filter[^{]*tenant_id/, 'the filter still scopes an opted-in mass delete');
  });
});

describe('powdb optimistic locking', () => {
  it('adds the version check to the filter and bumps the column', async () => {
    const r = rec();
    await qi(r.pool).update({
      where: { id: '1' },
      data: { name: 'b' },
      optimisticLock: { field: 'version', expected: 7 },
    } as AnyArgs);
    const { powql, params } = r.first();
    // Assert the two halves SEPARATELY, against the clause each belongs to.
    // Matching /version/ and /\+ 1/ against the whole statement passed while
    // the predicate was missing entirely, because the SET clause alone
    // (`version := .version + 1`) satisfies both, and the bound param is pushed
    // either way. A mutant that dropped the predicate escaped that version of
    // this test.
    const filterClause = powql.slice(powql.indexOf('filter'), powql.indexOf('update'));
    const setClause = powql.slice(powql.indexOf('update'));
    assert.match(filterClause, /version\s*=\s*\$\d/, `the version PREDICATE must be in the filter: ${powql}`);
    assert.match(setClause, /version.*\+ 1/, `the version must be bumped in the SET: ${powql}`);
    assert.ok(params.includes(7), `the expected version must be bound: ${JSON.stringify(params)}`);
  });

  it('throws OptimisticLockError, not NotFoundError, when the row moved on', async () => {
    // The distinction is the whole feature: "someone else got there first" is a
    // retry, "no such row" is not.
    const r = rec([]);
    await assert.rejects(
      () =>
        qi(r.pool).update({
          where: { id: '1' },
          data: { name: 'b' },
          optimisticLock: { field: 'version', expected: 7 },
        } as AnyArgs),
      (err: unknown) => {
        assert.ok(err instanceof OptimisticLockError, `expected OptimisticLockError, got ${String(err)}`);
        assert.equal((err as { code: string }).code, 'TURBINE_E015');
        return true;
      },
    );
  });

  it('an unknown lock field is refused by name', async () => {
    const r = rec();
    await assert.rejects(
      () =>
        qi(r.pool).update({
          where: { id: '1' },
          data: { name: 'b' },
          optimisticLock: { field: 'nope', expected: 1 },
        } as AnyArgs),
      ValidationError,
    );
  });

  it('an update without the option is unchanged', async () => {
    const a = rec();
    await qi(a.pool).update({ where: { id: '1' }, data: { name: 'b' } } as AnyArgs);
    assert.doesNotMatch(a.first().powql, /\+ 1/);
  });
});
