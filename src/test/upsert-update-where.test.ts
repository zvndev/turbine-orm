/**
 * turbine-orm: upsert conflict-UPDATE predicate, SQL and params must agree.
 *
 * `buildUpsert` only compiles a conflict-UPDATE predicate (the global filter,
 * i.e. soft-delete / tenancy) when `dialect.supportsUpsertUpdateWhere` is true,
 * and pushes that predicate's parameters at the same time. Every dialect that
 * reports `true` must therefore actually EMIT the predicate: `mysqlDialect`,
 * `sqliteDialect` and `mssqlDialect` all spread `postgresDialect` (which sets
 * the flag), and MySQL's `ON DUPLICATE KEY UPDATE` dropped the clause while its
 * parameters stayed bound. That either errors at the driver or, worse, shifts
 * every later placeholder by one.
 *
 * The load-bearing assertion here is `assertParamsAligned`: every placeholder in
 * the emitted SQL has exactly one param and every param is referenced. It is
 * written per engine (placeholder syntax comes from the dialect itself), so any
 * future dialect that lies about the flag fails here rather than in production.
 *
 * Run: npx tsx --test src/test/upsert-update-where.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Dialect } from '../dialect.js';
import { postgresDialect } from '../dialect.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import type { SchemaMetadata } from '../schema.js';
import { sqliteDialect } from '../sqlite.js';
import { makeQuery, mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      users: mockTable('users', [
        { name: 'id', field: 'id' },
        { name: 'name', field: 'name', pgType: 'text' },
        { name: 'tenant_id', field: 'tenantId', pgType: 'text' },
      ]),
    },
  };
}

/**
 * Every placeholder the dialect can emit, indexed. Built from the dialect's own
 * `paramPlaceholder`, so `$1` / `:p1` / `@p1` are all covered without
 * hard-coding an engine's syntax here.
 */
function placeholderIndexes(dialect: Dialect, sql: string, upTo: number): Set<number> {
  const found = new Set<number>();
  for (let i = 1; i <= upTo; i++) {
    const ph = dialect.paramPlaceholder(i);
    // A word boundary stops `:p1` from matching inside `:p10`.
    if (new RegExp(`${ph.replace(/[$@]/g, '\\$&')}(?![0-9])`).test(sql)) found.add(i);
  }
  return found;
}

/** Every placeholder in `sql` has exactly one param, and every param is used. */
function assertParamsAligned(dialect: Dialect, sql: string, params: unknown[]): void {
  // Probe one past the params array: an emitted-but-unbound placeholder is just
  // as broken as an orphaned param.
  const referenced = placeholderIndexes(dialect, sql, params.length + 1);
  assert.ok(
    !referenced.has(params.length + 1),
    `${dialect.name}: SQL references ${dialect.paramPlaceholder(params.length + 1)} but only ${params.length} params were bound: ${sql}`,
  );
  for (let i = 1; i <= params.length; i++) {
    assert.ok(
      referenced.has(i),
      `${dialect.name}: param ${dialect.paramPlaceholder(i)} is never referenced in SQL, orphaned param: ${sql}`,
    );
  }
}

function buildTenantUpsert(dialect: Dialect) {
  return makeQuery('users', schema(), {
    dialect,
    globalFilters: { users: { tenantId: 'acme' } },
  }).buildUpsert({
    where: { id: 1 },
    create: { id: 1, name: 'x', tenantId: 'acme' } as never,
    update: { name: 'y' } as never,
  });
}

const ENGINES: [name: string, dialect: Dialect][] = [
  ['postgres', postgresDialect],
  ['sqlite', sqliteDialect],
  ['mysql', mysqlDialect],
  ['mssql', mssqlDialect],
];

describe('upsert conflict-UPDATE predicate: SQL and params agree', () => {
  for (const [name, dialect] of ENGINES) {
    it(`${name}: no orphaned or unbound placeholders with a global filter`, () => {
      const { sql, params } = buildTenantUpsert(dialect);
      assertParamsAligned(dialect, sql, params);
    });

    it(`${name}: emits a conflict-UPDATE predicate exactly when the flag claims it can`, () => {
      const { sql, params } = buildTenantUpsert(dialect);
      // The filter value is the LAST param when (and only when) the predicate
      // was compiled: create params, then update params, then the filter's.
      const filterBound = params.length === 5;
      assert.equal(
        filterBound,
        dialect.supportsUpsertUpdateWhere === true,
        `${name}: the filter param is bound iff supportsUpsertUpdateWhere is true (params: ${params.length})`,
      );
      if (dialect.supportsUpsertUpdateWhere) {
        assert.ok(
          sql.includes(`tenant_id`) && sql.includes(dialect.paramPlaceholder(5)),
          `${name}: flag is true so the predicate must reach the SQL: ${sql}`,
        );
      }
    });
  }

  it('mysql drops the predicate and therefore reports the flag false', () => {
    // ON DUPLICATE KEY UPDATE has no predicate slot.
    assert.equal(mysqlDialect.supportsUpsertUpdateWhere, false);
    assert.doesNotMatch(buildTenantUpsert(mysqlDialect).sql, /WHERE/);
  });

  it('mssql drops the predicate and therefore reports the flag false', () => {
    // MERGE's `WHEN MATCHED AND <pred>` cannot take the unqualified column
    // references the builder produces (ambiguous between the T and S aliases).
    assert.equal(mssqlDialect.supportsUpsertUpdateWhere, false);
    assert.doesNotMatch(buildTenantUpsert(mssqlDialect).sql, /WHEN MATCHED AND/);
  });

  it('sqlite really emits the predicate it claims to support', () => {
    assert.equal(sqliteDialect.supportsUpsertUpdateWhere, true);
    const { sql } = buildTenantUpsert(sqliteDialect);
    assert.match(sql, /DO UPDATE SET .* WHERE "tenant_id" = :p5/);
  });

  it('postgres really emits the predicate it claims to support', () => {
    assert.equal(postgresDialect.supportsUpsertUpdateWhere, true);
    const { sql } = buildTenantUpsert(postgresDialect);
    assert.match(sql, /DO UPDATE SET .* WHERE "tenant_id" = \$5/);
  });
});
